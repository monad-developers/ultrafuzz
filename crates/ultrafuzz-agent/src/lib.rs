// Process-group management for agent subprocesses requires raw libc calls.
#![allow(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use ultrafuzz_config::{
    backend_args_policy_error, backend_command_validation_error, dangerous_backend_env_key_reason,
    is_sensitive_key_name, BackendCliConfig, CampaignConfig, CommandPolicyReason, PermissionConfig,
    ToolPolicyConfig,
};
use ultrafuzz_core::{BackendKind, ModelProfile, ModelProfileId, NodeId, RunId, StrategyId};

const STDOUT_LOG: &str = "stdout.log";
const STDERR_LOG: &str = "stderr.log";
const TRANSCRIPT_FILE: &str = "transcript.json";
const BACKEND_ATTEMPTS_DIR: &str = "backend-attempts";
const RENDERED_PROMPT_FILE: &str = "prompt.rendered.md";
const RUNTIME_CONTEXT_FILE: &str = "runtime-context.json";
const RUN_METADATA_DIR: &str = "run-metadata";
const PROPERTY_LENS_INPUTS_FILE: &str = "lens-inputs.json";
const AGGREGATION_MANIFEST_FILE: &str = "aggregation.json";
const DEPENDENCY_WORKSPACE_CHANGE_CONFLICTS_FILE: &str =
    "dependency-workspace-change-conflicts.json";
const CODEX_LAST_MESSAGE_FILE: &str = "codex-last-message.txt";
const MAX_PROMPT_BYTES: usize = 2 * 1024 * 1024;
const MAX_AGENT_STREAM_BYTES: u64 = 16 * 1024 * 1024;
const AGENT_STREAM_TRUNCATED_MARKER: &str = "\n[ultrafuzz: output truncated]\n";
const CLAUDE_TRANSIENT_API_MAX_ATTEMPTS: usize = 12;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentInput {
    pub run_id: RunId,
    pub node_id: NodeId,
    pub strategy: StrategyId,
    pub attempt_index: usize,
    pub model_id: Option<ModelProfileId>,
    pub model: Option<String>,
    pub model_index: Option<usize>,
    pub loop_index: Option<usize>,
    pub prompt: String,
    pub workspace_path: PathBuf,
    pub artifact_dir: PathBuf,
    pub extra_context_dirs: Vec<PathBuf>,
    pub output_findings_path: PathBuf,
    pub output_patch_path: PathBuf,
    pub output_metadata_path: PathBuf,
    pub timeout: Duration,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentOutput {
    pub status: AgentStatus,
    pub stdout_path: Option<PathBuf>,
    pub stderr_path: Option<PathBuf>,
    pub transcript_path: Option<PathBuf>,
    pub findings_path: Option<PathBuf>,
    pub patch_path: Option<PathBuf>,
    pub metadata_path: Option<PathBuf>,
    pub changed_files: Vec<PathBuf>,
    pub duration: Duration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentStatus {
    Succeeded,
    Failed,
    TimedOut,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendAvailability {
    Available,
    CommandNotFound,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendDoctorCheckStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendDoctorCheck {
    pub name: String,
    pub status: BackendDoctorCheckStatus,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendDoctorResult {
    pub kind: BackendKind,
    pub availability: BackendAvailability,
    pub message: Option<String>,
    pub command: String,
    pub command_path: Option<PathBuf>,
    pub sandbox_required: bool,
    pub sandbox_mode: String,
    pub sandbox_supported: bool,
    pub permission_policy_supported: bool,
    pub project_permission_files: Vec<PathBuf>,
    pub checks: Vec<BackendDoctorCheck>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentErrorKind {
    BackendCommandNotFound,
    BackendTimeout,
    BackendNonzeroExit,
    BackendInvalidOutput,
    BackendContextTooLarge,
    BackendSandboxUnavailable,
    BackendPermissionPolicyRejected,
    BackendIo,
}

impl AgentErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::BackendCommandNotFound => "backend-command-not-found",
            Self::BackendTimeout => "backend-timeout",
            Self::BackendNonzeroExit => "backend-nonzero-exit",
            Self::BackendInvalidOutput => "backend-invalid-output",
            Self::BackendContextTooLarge => "backend-context-too-large",
            Self::BackendSandboxUnavailable => "backend-sandbox-unavailable",
            Self::BackendPermissionPolicyRejected => "backend-permission-policy-rejected",
            Self::BackendIo => "backend-io",
        }
    }
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("{code}: backend command `{command}` was not found")]
    CommandNotFound {
        code: &'static str,
        command: String,
        metadata_path: Option<PathBuf>,
    },
    #[error("{code}: backend subprocess timed out after {timeout:?}")]
    Timeout {
        code: &'static str,
        timeout: Duration,
        metadata_path: PathBuf,
    },
    #[error("{code}: backend subprocess exited with status {status}")]
    NonzeroExit {
        code: &'static str,
        status: String,
        metadata_path: PathBuf,
    },
    #[error("{code}: {reason}")]
    InvalidOutput {
        code: &'static str,
        reason: String,
        metadata_path: PathBuf,
    },
    #[error("{code}: prompt is {bytes} bytes, exceeding the {limit} byte limit")]
    ContextTooLarge {
        code: &'static str,
        bytes: usize,
        limit: usize,
    },
    #[error("{code}: {reason}")]
    SandboxUnavailable { code: &'static str, reason: String },
    #[error("{code}: {reason}")]
    PermissionPolicyRejected { code: &'static str, reason: String },
    #[error("{code}: {source}")]
    Io {
        code: &'static str,
        source: io::Error,
    },
    #[error("{code}: failed to serialize backend metadata: {source}")]
    Json {
        code: &'static str,
        source: serde_json::Error,
    },
}

impl AgentError {
    pub fn kind(&self) -> AgentErrorKind {
        match self {
            Self::CommandNotFound { .. } => AgentErrorKind::BackendCommandNotFound,
            Self::Timeout { .. } => AgentErrorKind::BackendTimeout,
            Self::NonzeroExit { .. } => AgentErrorKind::BackendNonzeroExit,
            Self::InvalidOutput { .. } => AgentErrorKind::BackendInvalidOutput,
            Self::ContextTooLarge { .. } => AgentErrorKind::BackendContextTooLarge,
            Self::SandboxUnavailable { .. } => AgentErrorKind::BackendSandboxUnavailable,
            Self::PermissionPolicyRejected { .. } => {
                AgentErrorKind::BackendPermissionPolicyRejected
            }
            Self::Io { code, .. } | Self::Json { code, .. } => error_kind_from_code(code),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::CommandNotFound { code, .. }
            | Self::Timeout { code, .. }
            | Self::NonzeroExit { code, .. }
            | Self::InvalidOutput { code, .. }
            | Self::ContextTooLarge { code, .. }
            | Self::SandboxUnavailable { code, .. }
            | Self::PermissionPolicyRejected { code, .. }
            | Self::Io { code, .. }
            | Self::Json { code, .. } => code,
        }
    }
}

pub trait AgentBackend: Send + Sync {
    fn kind(&self) -> BackendKind;
    fn run(&self, input: AgentInput) -> Result<AgentOutput, AgentError>;
    fn doctor(&self) -> Result<BackendDoctorResult, AgentError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentBackendConfig {
    pub kind: BackendKind,
    pub cli: BackendCliConfig,
    pub model_profile: Option<ModelProfile>,
    pub permissions: PermissionConfig,
    pub tools: ToolPolicyConfig,
    pub project_root: PathBuf,
}

impl AgentBackendConfig {
    pub fn from_campaign_config(
        config: &CampaignConfig,
        project_root: impl Into<PathBuf>,
        kind: BackendKind,
    ) -> Self {
        let mut cli = match kind {
            BackendKind::CodexCli => config.backend.codex_cli.clone(),
            BackendKind::ClaudeCodeCli => config.backend.claude_code_cli.clone(),
        };
        let model_profile = config
            .default_model_profile()
            .filter(|profile| profile.backend == kind)
            .cloned();
        if let Some(profile) = &model_profile {
            cli.args.extend(profile.args.clone());
            for (key, value) in &profile.env {
                cli.env.insert(key.clone(), value.clone());
            }
        }
        Self {
            kind,
            cli,
            model_profile,
            permissions: config.permissions.clone(),
            tools: config.tools.clone(),
            project_root: project_root.into(),
        }
    }

    pub fn from_model_profile(
        config: &CampaignConfig,
        project_root: impl Into<PathBuf>,
        profile: &ModelProfile,
    ) -> Self {
        let mut cli = match profile.backend {
            BackendKind::CodexCli => config.backend.codex_cli.clone(),
            BackendKind::ClaudeCodeCli => config.backend.claude_code_cli.clone(),
        };
        cli.args.extend(profile.args.clone());
        for (key, value) in &profile.env {
            cli.env.insert(key.clone(), value.clone());
        }
        Self {
            kind: profile.backend,
            cli,
            model_profile: Some(profile.clone()),
            permissions: config.permissions.clone(),
            tools: config.tools.clone(),
            project_root: project_root.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendCommand {
    pub kind: BackendKind,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub stdin: String,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub transcript_path: PathBuf,
    pub metadata_path: PathBuf,
}

impl BackendCommand {
    pub fn display_command(&self) -> Vec<String> {
        let mut display = Vec::with_capacity(self.args.len() + 1);
        display.push(self.command.clone());
        display.extend(self.args.clone());
        display
    }

    pub fn env_keys(&self) -> Vec<String> {
        self.env.keys().cloned().collect()
    }
}

#[derive(Clone, Debug)]
pub struct CodexCliBackend {
    inner: CliSubprocessBackend,
}

impl CodexCliBackend {
    pub fn new(config: AgentBackendConfig) -> Self {
        debug_assert_eq!(config.kind, BackendKind::CodexCli);
        Self {
            inner: CliSubprocessBackend::new(config),
        }
    }

    pub fn from_campaign_config(config: &CampaignConfig, project_root: impl Into<PathBuf>) -> Self {
        Self::new(AgentBackendConfig::from_campaign_config(
            config,
            project_root,
            BackendKind::CodexCli,
        ))
    }

    pub fn command_for(&self, input: &AgentInput) -> Result<BackendCommand, AgentError> {
        self.inner.command_for(input)
    }
}

impl AgentBackend for CodexCliBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::CodexCli
    }

    fn run(&self, input: AgentInput) -> Result<AgentOutput, AgentError> {
        self.inner.run(input)
    }

    fn doctor(&self) -> Result<BackendDoctorResult, AgentError> {
        self.inner.doctor()
    }
}

#[derive(Clone, Debug)]
pub struct ClaudeCodeCliBackend {
    inner: CliSubprocessBackend,
}

impl ClaudeCodeCliBackend {
    pub fn new(config: AgentBackendConfig) -> Self {
        debug_assert_eq!(config.kind, BackendKind::ClaudeCodeCli);
        Self {
            inner: CliSubprocessBackend::new(config),
        }
    }

    pub fn from_campaign_config(config: &CampaignConfig, project_root: impl Into<PathBuf>) -> Self {
        Self::new(AgentBackendConfig::from_campaign_config(
            config,
            project_root,
            BackendKind::ClaudeCodeCli,
        ))
    }

    pub fn command_for(&self, input: &AgentInput) -> Result<BackendCommand, AgentError> {
        self.inner.command_for(input)
    }
}

impl AgentBackend for ClaudeCodeCliBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::ClaudeCodeCli
    }

    fn run(&self, input: AgentInput) -> Result<AgentOutput, AgentError> {
        self.inner.run(input)
    }

    fn doctor(&self) -> Result<BackendDoctorResult, AgentError> {
        self.inner.doctor()
    }
}

pub fn backend_for_config(
    config: &CampaignConfig,
    project_root: impl Into<PathBuf>,
    kind: BackendKind,
) -> Box<dyn AgentBackend> {
    let project_root = project_root.into();
    match kind {
        BackendKind::CodexCli => {
            Box::new(CodexCliBackend::from_campaign_config(config, project_root))
        }
        BackendKind::ClaudeCodeCli => Box::new(ClaudeCodeCliBackend::from_campaign_config(
            config,
            project_root,
        )),
    }
}

pub fn backend_for_model_profile(
    config: &CampaignConfig,
    project_root: impl Into<PathBuf>,
    profile: &ModelProfile,
) -> Box<dyn AgentBackend> {
    let backend_config = AgentBackendConfig::from_model_profile(config, project_root, profile);
    match profile.backend {
        BackendKind::CodexCli => Box::new(CodexCliBackend::new(backend_config)),
        BackendKind::ClaudeCodeCli => Box::new(ClaudeCodeCliBackend::new(backend_config)),
    }
}

#[derive(Clone, Debug)]
struct CliSubprocessBackend {
    config: AgentBackendConfig,
}

impl CliSubprocessBackend {
    fn new(config: AgentBackendConfig) -> Self {
        Self { config }
    }

    fn command_for(&self, input: &AgentInput) -> Result<BackendCommand, AgentError> {
        validate_input_paths(input)?;
        validate_prompt_size(&input.prompt)?;
        validate_backend_command(&self.config)?;
        validate_permission_policy(&self.config, Some(input))?;

        fs::create_dir_all(&input.artifact_dir).map_err(io_error)?;
        archive_existing_backend_outputs(&input.artifact_dir, input).map_err(io_error)?;
        let stdout_path = input.artifact_dir.join(STDOUT_LOG);
        let stderr_path = input.artifact_dir.join(STDERR_LOG);
        let transcript_path = input.artifact_dir.join(TRANSCRIPT_FILE);
        let args = match self.config.kind {
            BackendKind::CodexCli => codex_args(&self.config, input)?,
            BackendKind::ClaudeCodeCli => claude_args(&self.config, input)?,
        };
        Ok(BackendCommand {
            kind: self.config.kind,
            command: self.config.cli.command.clone(),
            args,
            cwd: input.workspace_path.clone(),
            env: scrubbed_environment(&self.config, input),
            stdin: input.prompt.clone(),
            stdout_path,
            stderr_path,
            transcript_path,
            metadata_path: input.output_metadata_path.clone(),
        })
    }

    fn run(&self, input: AgentInput) -> Result<AgentOutput, AgentError> {
        let max_attempts = if self.config.kind == BackendKind::ClaudeCodeCli {
            CLAUDE_TRANSIENT_API_MAX_ATTEMPTS
        } else {
            1
        };
        for attempt in 1..=max_attempts {
            let result = self.run_once(input.clone());
            if attempt < max_attempts
                && self.config.kind == BackendKind::ClaudeCodeCli
                && matches!(result, Err(AgentError::NonzeroExit { .. }))
                && claude_stdout_has_transient_api_error(&input.artifact_dir.join(STDOUT_LOG))
            {
                thread::sleep(claude_transient_api_retry_delay(attempt));
                continue;
            }
            return result;
        }
        unreachable!("backend retry loop always returns from a finite attempt")
    }

    fn run_once(&self, input: AgentInput) -> Result<AgentOutput, AgentError> {
        let started = Instant::now();
        let command = self.command_for(&input)?;
        let resolved = resolve_command(&command.command).ok_or_else(|| {
            let metadata_path = command.metadata_path.clone();
            let _ = write_subprocess_metadata(
                &self.config,
                &input,
                &command,
                SubprocessMetadata {
                    exit_status: None,
                    resolved_command: None,
                    timed_out: false,
                    duration: started.elapsed(),
                    error_kind: Some(AgentErrorKind::BackendCommandNotFound),
                    error_message: Some("backend command was not found"),
                },
            );
            AgentError::CommandNotFound {
                code: AgentErrorKind::BackendCommandNotFound.code(),
                command: command.command.clone(),
                metadata_path: Some(metadata_path),
            }
        })?;

        let mut process = Command::new(&resolved);
        process
            .args(&command.args)
            .current_dir(&command.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear()
            .envs(&command.env);
        configure_process_group(&mut process);

        let mut child = process.spawn().map_err(|source| {
            let _ = write_subprocess_metadata(
                &self.config,
                &input,
                &command,
                SubprocessMetadata {
                    exit_status: None,
                    resolved_command: None,
                    timed_out: false,
                    duration: started.elapsed(),
                    error_kind: Some(AgentErrorKind::BackendCommandNotFound),
                    error_message: Some("backend command could not be spawned"),
                },
            );
            if source.kind() == io::ErrorKind::NotFound {
                AgentError::CommandNotFound {
                    code: AgentErrorKind::BackendCommandNotFound.code(),
                    command: command.command.clone(),
                    metadata_path: Some(command.metadata_path.clone()),
                }
            } else {
                AgentError::Io {
                    code: AgentErrorKind::BackendIo.code(),
                    source,
                }
            }
        })?;

        let live_tool_policy = live_streamed_tool_policy(&self.config, &input, &command);
        let stdout_handle = copy_child_stream(
            child.stdout.take().expect("stdout is piped"),
            command.stdout_path.clone(),
            live_tool_policy.as_ref().map(|state| {
                LiveToolPolicyMonitor::new(self.config.clone(), input.clone(), state.clone())
            }),
        );
        let stderr_handle = copy_child_stream(
            child.stderr.take().expect("stderr is piped"),
            command.stderr_path.clone(),
            None,
        );
        let stdin_handle = child
            .stdin
            .take()
            .map(|stdin| write_prompt_stdin_async(stdin, command.stdin.clone()));

        let mut wait_result =
            wait_with_timeout(&mut child, input.timeout, live_tool_policy.clone())?;
        let duration = started.elapsed();
        let join_result = join_subprocess_threads(stdin_handle, stdout_handle, stderr_handle);
        if !wait_result.timed_out {
            if let Err(error) = join_result {
                if live_tool_policy_error(&live_tool_policy).is_none()
                    && wait_result_permission_policy_error(&wait_result).is_none()
                {
                    return Err(error);
                }
            }
        }
        if !wait_result.timed_out {
            if let Some(reason) = live_tool_policy_violation_reason(&live_tool_policy) {
                wait_result.error_kind = Some(AgentErrorKind::BackendPermissionPolicyRejected);
                wait_result.error_message = Some(permission_policy_rejected(reason).to_string());
            }
        }

        write_transcript(&self.config, &input, &command, &wait_result, duration)?;
        write_subprocess_metadata(
            &self.config,
            &input,
            &command,
            SubprocessMetadata {
                exit_status: wait_result.exit_status.as_ref(),
                resolved_command: Some(&resolved),
                timed_out: wait_result.timed_out,
                duration,
                error_kind: wait_result.error_kind,
                error_message: wait_result.error_message.as_deref(),
            },
        )?;

        if let Some(error) = live_tool_policy_error(&live_tool_policy) {
            return Err(error);
        }
        if let Some(error) = wait_result_permission_policy_error(&wait_result) {
            return Err(error);
        }

        if wait_result.timed_out {
            return Err(AgentError::Timeout {
                code: AgentErrorKind::BackendTimeout.code(),
                timeout: input.timeout,
                metadata_path: command.metadata_path.clone(),
            });
        }

        if let Some(status) = &wait_result.exit_status {
            if !status.success() {
                return Err(AgentError::NonzeroExit {
                    code: AgentErrorKind::BackendNonzeroExit.code(),
                    status: exit_status_label(status),
                    metadata_path: command.metadata_path.clone(),
                });
            }
        }

        if let Err(error) = validate_streamed_tool_policy(&self.config, &input, &command) {
            let _ = write_subprocess_metadata(
                &self.config,
                &input,
                &command,
                SubprocessMetadata {
                    exit_status: wait_result.exit_status.as_ref(),
                    resolved_command: Some(&resolved),
                    timed_out: false,
                    duration,
                    error_kind: Some(error.kind()),
                    error_message: Some(&error.to_string()),
                },
            );
            return Err(error);
        }

        if let Err(error) =
            validate_findings_output(&input.output_findings_path, &command.metadata_path)
        {
            let _ = write_subprocess_metadata(
                &self.config,
                &input,
                &command,
                SubprocessMetadata {
                    exit_status: wait_result.exit_status.as_ref(),
                    resolved_command: Some(&resolved),
                    timed_out: false,
                    duration,
                    error_kind: Some(error.kind()),
                    error_message: Some(&error.to_string()),
                },
            );
            return Err(error);
        }
        let patch_path = if input.output_patch_path.exists()
            && fs::metadata(&input.output_patch_path)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
        {
            Some(input.output_patch_path.clone())
        } else {
            None
        };

        Ok(AgentOutput {
            status: AgentStatus::Succeeded,
            stdout_path: Some(command.stdout_path),
            stderr_path: Some(command.stderr_path),
            transcript_path: Some(command.transcript_path),
            findings_path: Some(input.output_findings_path),
            patch_path,
            metadata_path: Some(command.metadata_path),
            changed_files: changed_files(&input.workspace_path),
            duration,
        })
    }

    fn doctor(&self) -> Result<BackendDoctorResult, AgentError> {
        validate_backend_command(&self.config)?;
        let command_path = resolve_command(&self.config.cli.command);
        let mut checks = Vec::new();
        let availability = if let Some(path) = &command_path {
            checks.push(BackendDoctorCheck {
                name: "backend-command".to_owned(),
                status: BackendDoctorCheckStatus::Pass,
                message: format!("found {}", path.display()),
            });
            BackendAvailability::Available
        } else {
            checks.push(BackendDoctorCheck {
                name: "backend-command".to_owned(),
                status: BackendDoctorCheckStatus::Fail,
                message: format!("{} was not found on PATH", self.config.cli.command),
            });
            BackendAvailability::CommandNotFound
        };

        let policy_check = match validate_permission_policy(&self.config, None) {
            Ok(()) => {
                checks.push(BackendDoctorCheck {
                    name: "permission-policy".to_owned(),
                    status: BackendDoctorCheckStatus::Pass,
                    message: "backend args do not request known bypass modes".to_owned(),
                });
                true
            }
            Err(error) => {
                checks.push(BackendDoctorCheck {
                    name: "permission-policy".to_owned(),
                    status: BackendDoctorCheckStatus::Fail,
                    message: error.to_string(),
                });
                false
            }
        };

        let sandbox_supported = sandbox_supported(&self.config.permissions);
        checks.push(BackendDoctorCheck {
            name: "sandbox".to_owned(),
            status: if sandbox_supported {
                BackendDoctorCheckStatus::Pass
            } else {
                BackendDoctorCheckStatus::Fail
            },
            message: if sandbox_supported {
                format!(
                    "sandbox `{}` is accepted for {}",
                    self.config.permissions.sandbox, self.config.kind
                )
            } else {
                format!(
                    "sandbox `{}` cannot satisfy required backend policy",
                    self.config.permissions.sandbox
                )
            },
        });

        let project_permission_files =
            detect_project_permission_files(&self.config.project_root, self.config.kind);
        checks.push(BackendDoctorCheck {
            name: "project-permission-files".to_owned(),
            status: BackendDoctorCheckStatus::Warn,
            message: if project_permission_files.is_empty() {
                "no known project-native backend permission files found".to_owned()
            } else {
                format!(
                    "found {} project-native permission/instruction file(s)",
                    project_permission_files.len()
                )
            },
        });

        Ok(BackendDoctorResult {
            kind: self.config.kind,
            availability,
            message: match availability {
                BackendAvailability::Available => Some("backend command is available".to_owned()),
                BackendAvailability::CommandNotFound => Some(format!(
                    "backend command `{}` was not found",
                    self.config.cli.command
                )),
                BackendAvailability::Unsupported => Some("backend is unsupported".to_owned()),
            },
            command: self.config.cli.command.clone(),
            command_path,
            sandbox_required: self.config.permissions.sandbox_required,
            sandbox_mode: self.config.permissions.sandbox.clone(),
            sandbox_supported,
            permission_policy_supported: policy_check,
            project_permission_files,
            checks,
        })
    }
}

#[cfg(test)]
fn claude_transient_api_retry_delay(_attempt: usize) -> Duration {
    Duration::ZERO
}

#[cfg(not(test))]
fn claude_transient_api_retry_delay(attempt: usize) -> Duration {
    match attempt {
        1 => Duration::from_secs(5),
        2 => Duration::from_secs(15),
        3 | 4 => Duration::from_secs(30),
        _ => Duration::from_secs(60),
    }
}

fn codex_args(config: &AgentBackendConfig, input: &AgentInput) -> Result<Vec<String>, AgentError> {
    let mut args = if config.cli.args.is_empty() {
        vec!["exec".to_owned()]
    } else {
        config.cli.args.clone()
    };
    if !matches!(args.first().map(String::as_str), Some("exec" | "e")) {
        args.insert(0, "exec".to_owned());
    }
    if let Some(model) = config
        .model_profile
        .as_ref()
        .and_then(|profile| profile.model.as_ref())
        .filter(|model| !model.trim().is_empty())
    {
        if !has_flag(&args, &["--model", "-m"]) {
            args.extend(["--model".to_owned(), model.clone()]);
        }
    }

    if !has_flag(&args, &["--sandbox", "-s"]) {
        args.extend(["--sandbox".to_owned(), config.permissions.sandbox.clone()]);
    }
    if let Some(value) = codex_approval_policy_value(&args) {
        reject_non_never_codex_approval_policy(&value)?;
    } else {
        args.extend(["-c".to_owned(), "approval_policy=never".to_owned()]);
    }
    if !has_flag(&args, &["--cd", "-C"]) {
        args.extend([
            "--cd".to_owned(),
            input.workspace_path.display().to_string(),
        ]);
    }
    if !has_flag(&args, &["--add-dir"]) {
        args.extend([
            "--add-dir".to_owned(),
            input.artifact_dir.display().to_string(),
        ]);
        for dir in &input.extra_context_dirs {
            args.extend(["--add-dir".to_owned(), dir.display().to_string()]);
        }
    }
    if !has_flag(&args, &["--output-last-message", "-o"]) {
        args.extend([
            "--output-last-message".to_owned(),
            input
                .artifact_dir
                .join(CODEX_LAST_MESSAGE_FILE)
                .display()
                .to_string(),
        ]);
    }
    if !args.iter().any(|arg| arg == "--json") {
        args.push("--json".to_owned());
    }
    if !args.iter().any(|arg| arg == "-") {
        args.push("-".to_owned());
    }
    Ok(args)
}

fn claude_args(config: &AgentBackendConfig, input: &AgentInput) -> Result<Vec<String>, AgentError> {
    let mut args = config.cli.args.clone();
    if let Some(model) = config
        .model_profile
        .as_ref()
        .and_then(|profile| profile.model.as_ref())
        .filter(|model| !model.trim().is_empty())
    {
        if !has_flag(&args, &["--model"]) {
            args.extend(["--model".to_owned(), model.clone()]);
        }
    }
    if claude_api_key_auth_available(config) && !has_flag(&args, &["--bare"]) {
        args.push("--bare".to_owned());
    }
    if claude_api_key_auth_available(config) && !has_flag(&args, &["--no-session-persistence"]) {
        args.push("--no-session-persistence".to_owned());
    }
    if !has_flag(&args, &["--print", "-p"]) {
        args.push("--print".to_owned());
    }
    if !has_flag(&args, &["--add-dir"]) {
        args.extend([
            "--add-dir".to_owned(),
            input.artifact_dir.display().to_string(),
        ]);
        for dir in &input.extra_context_dirs {
            args.extend(["--add-dir".to_owned(), dir.display().to_string()]);
        }
    }
    if !has_flag(&args, &["--tools"]) {
        args.extend(["--tools".to_owned(), claude_tool_names(config)]);
    }
    if !has_flag(&args, &["--allowedTools", "--allowed-tools"]) {
        let allowed_tools = claude_allowed_tools(config);
        if !allowed_tools.is_empty() {
            args.extend(["--allowedTools".to_owned(), allowed_tools.join(",")]);
        }
    }
    if !has_flag(&args, &["--disallowedTools", "--disallowed-tools"]) {
        let disallowed_tools = claude_disallowed_tools(&config.tools);
        if !disallowed_tools.is_empty() {
            args.extend(["--disallowedTools".to_owned(), disallowed_tools.join(",")]);
        }
    }
    if config.permissions.approval_mode == "preapproved-only"
        && !has_flag(&args, &["--permission-mode"])
    {
        args.extend(["--permission-mode".to_owned(), "dontAsk".to_owned()]);
    }
    if !has_flag(&args, &["--output-format"]) {
        args.extend(["--output-format".to_owned(), "stream-json".to_owned()]);
    }
    if claude_output_format(&args) == Some("stream-json") && !has_flag(&args, &["--verbose"]) {
        args.push("--verbose".to_owned());
    }
    Ok(args)
}

fn claude_api_key_auth_available(config: &AgentBackendConfig) -> bool {
    match config.cli.env.get("ANTHROPIC_API_KEY") {
        Some(value) => !value.trim().is_empty(),
        None => env::var("ANTHROPIC_API_KEY")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
    }
}

fn claude_tool_names(config: &AgentBackendConfig) -> String {
    let mut tools = vec!["Read", "Write", "Edit", "Bash"];
    if network_policy_allows_external_access(&config.permissions) {
        tools.push("WebFetch");
    }
    tools.join(",")
}

fn claude_allowed_tools(config: &AgentBackendConfig) -> Vec<String> {
    let mut rules = vec!["Read".to_owned(), "Write".to_owned(), "Edit".to_owned()];
    if network_policy_allows_external_access(&config.permissions) {
        rules.push("WebFetch".to_owned());
    }
    rules.extend(
        config
            .tools
            .commands
            .allow
            .iter()
            .flat_map(|rule| claude_bash_tool_rules(rule)),
    );
    rules
}

fn network_policy_allows_external_access(permissions: &PermissionConfig) -> bool {
    !permissions.network.trim().eq_ignore_ascii_case("disabled")
}

fn claude_disallowed_tools(tools: &ToolPolicyConfig) -> Vec<String> {
    tools
        .commands
        .deny
        .iter()
        .flat_map(|rule| claude_bash_tool_rules(rule))
        .collect()
}

fn claude_bash_tool_rules(rule: &str) -> Vec<String> {
    let trimmed = rule.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    vec![format!("Bash({trimmed})"), format!("Bash({trimmed} *)")]
}

fn claude_output_format(args: &[String]) -> Option<&str> {
    for (index, arg) in args.iter().enumerate() {
        if arg == "--output-format" {
            return args.get(index + 1).map(String::as_str);
        }
        if let Some(value) = arg.strip_prefix("--output-format=") {
            return Some(value);
        }
    }
    None
}

fn claude_stdout_has_transient_api_error(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .any(|event| claude_event_is_transient_api_error(&event))
}

fn claude_event_is_transient_api_error(event: &Value) -> bool {
    if event
        .get("api_error_status")
        .and_then(Value::as_u64)
        .is_some_and(|status| status >= 500 || status == 429)
    {
        return true;
    }
    if event
        .get("error")
        .and_then(Value::as_str)
        .is_some_and(is_transient_claude_error_text)
    {
        return true;
    }
    if event
        .get("result")
        .and_then(Value::as_str)
        .is_some_and(is_transient_claude_error_text)
    {
        return true;
    }
    event
        .pointer("/message/content")
        .and_then(Value::as_array)
        .is_some_and(|content| {
            content.iter().any(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(is_transient_claude_error_text)
            })
        })
}

fn is_transient_claude_error_text(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    text.contains("server_error")
        || text.contains("overloaded_error")
        || text.contains("overloaded")
        || text.contains("rate_limit_error")
        || text.contains("rate limit")
        || text.contains("internal server error")
        || text.contains("server-side issue")
        || text.contains("api error: 5")
        || text.contains("api error: 429")
}

fn validate_streamed_tool_policy(
    config: &AgentBackendConfig,
    input: &AgentInput,
    command: &BackendCommand,
) -> Result<(), AgentError> {
    if config.kind != BackendKind::ClaudeCodeCli
        || claude_output_format(&command.args) != Some("stream-json")
    {
        return Ok(());
    }

    let file = File::open(&command.stdout_path).map_err(io_error)?;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(io_error)?;
        if let Err(reason) =
            validate_streamed_tool_policy_line(config, input, index + 1, line.trim())
        {
            return Err(permission_policy_rejected(reason));
        }
    }
    Ok(())
}

fn validate_streamed_tool_policy_line(
    config: &AgentBackendConfig,
    input: &AgentInput,
    line_number: usize,
    line: &str,
) -> Result<(), String> {
    if line.is_empty() {
        return Ok(());
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Ok(());
    };
    let Some(contents) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return Ok(());
    };
    for content in contents {
        if content.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(tool_name) = content.get("name").and_then(Value::as_str) else {
            continue;
        };

        if tool_name == "Bash" {
            let Some(command_text) = content
                .get("input")
                .and_then(|tool_input| tool_input.get("command"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let bash_segments = match validate_bash_command_policy(&config.tools, command_text) {
                Ok(segments) => segments,
                Err(reason) => {
                    return Err(format!(
                        "Claude used denied Bash command on stdout line {line_number}: `{command_text}` ({reason})"
                    ));
                }
            };
            for segment in bash_segments {
                if let Err(reason) = validate_bash_absolute_paths(&segment, input) {
                    return Err(format!(
                        "Claude used denied Bash command on stdout line {line_number}: `{command_text}` ({reason})"
                    ));
                }
            }
            continue;
        }

        if tool_name == "WebFetch" && !network_policy_allows_external_access(&config.permissions) {
            return Err(format!(
                "Claude used denied WebFetch tool on stdout line {line_number}: network policy is disabled"
            ));
        }

        if matches!(tool_name, "Read" | "Edit" | "Write") {
            let Some(file_path) = content
                .get("input")
                .and_then(|tool_input| tool_input.get("file_path"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if let Err(reason) = validate_tool_file_path(tool_name, file_path, input) {
                return Err(format!(
                    "Claude used denied {tool_name} file path on stdout line {line_number}: `{file_path}` ({reason})"
                ));
            }
        }
    }
    Ok(())
}

fn validate_bash_command_policy(
    tools: &ToolPolicyConfig,
    command: &str,
) -> Result<Vec<String>, String> {
    let decision = tools.commands.evaluate(command);
    if decision.allowed {
        return Ok(vec![command.to_owned()]);
    }
    if matches!(
        decision.reason,
        CommandPolicyReason::UnsafeShellSyntax(ref reason)
            if reason == "command chaining is not allowed"
    ) {
        if let Some(segments) = read_only_semicolon_chain_segments(command) {
            let segments = segments.map_err(|reason| format!("unsafe shell syntax: {reason}"))?;
            for segment in &segments {
                let program = bash_segment_program(segment).unwrap_or_default();
                if !bash_segment_is_read_only_inspection(segment) {
                    return Err(
                        "unsafe shell syntax: command chaining is only allowed for read-only inspection commands"
                            .to_owned(),
                    );
                }
                if program == "echo" {
                    continue;
                }
                let segment_decision = tools.commands.evaluate(segment);
                if !segment_decision.allowed {
                    return Err(command_policy_reason_message(&segment_decision.reason));
                }
            }
            return Ok(segments);
        }
    }
    Err(command_policy_reason_message(&decision.reason))
}

fn read_only_semicolon_chain_segments(command: &str) -> Option<Result<Vec<String>, String>> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut quote = None::<char>;
    let mut saw_semicolon = false;

    while let Some(ch) = chars.next() {
        if ch == '\\' && quote != Some('\'') {
            current.push(ch);
            if let Some(escaped) = chars.next() {
                current.push(escaped);
            }
            continue;
        }

        if matches!(ch, '"' | '\'') {
            if quote == Some(ch) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(ch);
            }
            current.push(ch);
            continue;
        }

        if quote.is_some() {
            if quote == Some('"') && matches!(ch, '`' | '$') {
                return Some(Err(
                    "shell expansion is not allowed in read-only command chains".to_owned(),
                ));
            }
            current.push(ch);
            continue;
        }

        match ch {
            ';' => {
                saw_semicolon = true;
                if let Err(reason) = push_required_command_segment(&mut segments, &mut current) {
                    return Some(Err(reason));
                }
            }
            '\n' => {
                return Some(Err(
                    "newlines are not allowed in read-only command chains".to_owned()
                ));
            }
            '|' => {
                return Some(Err(
                    "pipes are not allowed in read-only command chains".to_owned()
                ));
            }
            '&' => {
                return Some(Err(
                    "background or conditional chaining is not allowed in read-only command chains"
                        .to_owned(),
                ));
            }
            '>' | '<' => {
                return Some(Err(
                    "shell redirection is not allowed in read-only command chains".to_owned(),
                ));
            }
            '`' | '$' => {
                return Some(Err(
                    "shell expansion is not allowed in read-only command chains".to_owned(),
                ));
            }
            _ => current.push(ch),
        }
    }

    if !saw_semicolon {
        return None;
    }
    if quote.is_some() {
        return Some(Err("unterminated quoted string".to_owned()));
    }
    if let Err(reason) = push_required_command_segment(&mut segments, &mut current) {
        return Some(Err(reason));
    }
    Some(Ok(segments))
}

fn push_required_command_segment(
    segments: &mut Vec<String>,
    current: &mut String,
) -> Result<(), String> {
    let segment = current.trim();
    if segment.is_empty() {
        return Err("missing command around shell operator".to_owned());
    }
    segments.push(segment.to_owned());
    current.clear();
    Ok(())
}

fn bash_segment_is_read_only_inspection(segment: &str) -> bool {
    let words = shell_words(segment);
    let Some(program) = words.first().and_then(|word| {
        Path::new(word)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
    }) else {
        return false;
    };
    match program {
        "echo" => words
            .iter()
            .skip(1)
            .all(|word| !word.contains('$') && !word.contains('`')),
        "sed" => !words.iter().skip(1).any(|word| sed_in_place_arg(word)),
        "cat" | "grep" | "head" | "jq" | "ls" | "pwd" | "rg" | "sort" | "tail" | "uniq" | "wc"
        | "sha256sum" => true,
        _ => false,
    }
}

fn bash_segment_program(segment: &str) -> Option<String> {
    let words = shell_words(segment);
    words.first().and_then(|word| {
        Path::new(word)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
    })
}

fn command_policy_reason_message(reason: &CommandPolicyReason) -> String {
    match reason {
        CommandPolicyReason::Allowed => "allowed".to_owned(),
        CommandPolicyReason::EmptyCommand => "empty command".to_owned(),
        CommandPolicyReason::DeniedByRule => "matched a deny rule".to_owned(),
        CommandPolicyReason::NotAllowlisted => "not allowlisted".to_owned(),
        CommandPolicyReason::UnsafeShellSyntax(reason) => {
            format!("unsafe shell syntax: {reason}")
        }
    }
}

fn permission_policy_rejected(reason: String) -> AgentError {
    AgentError::PermissionPolicyRejected {
        code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
        reason,
    }
}

type LiveToolPolicyState = Arc<Mutex<Option<String>>>;

#[derive(Debug)]
struct LiveToolPolicyMonitor {
    config: AgentBackendConfig,
    input: AgentInput,
    state: LiveToolPolicyState,
    buffer: Vec<u8>,
    next_line_number: usize,
}

impl LiveToolPolicyMonitor {
    fn new(config: AgentBackendConfig, input: AgentInput, state: LiveToolPolicyState) -> Self {
        Self {
            config,
            input,
            state,
            buffer: Vec::new(),
            next_line_number: 1,
        }
    }

    fn ingest(&mut self, bytes: &[u8]) {
        if self.has_violation() {
            return;
        }
        self.buffer.extend_from_slice(bytes);
        while let Some(newline_index) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line = self.buffer.drain(..=newline_index).collect::<Vec<_>>();
            self.validate_line(&line);
            self.next_line_number += 1;
            if self.has_violation() {
                return;
            }
        }
    }

    fn finish(&mut self) {
        if self.buffer.is_empty() || self.has_violation() {
            return;
        }
        let line = std::mem::take(&mut self.buffer);
        self.validate_line(&line);
    }

    fn validate_line(&mut self, line: &[u8]) {
        let line = String::from_utf8_lossy(line);
        let line = line.trim_end_matches(['\r', '\n']).trim();
        if let Err(reason) = validate_streamed_tool_policy_line(
            &self.config,
            &self.input,
            self.next_line_number,
            line,
        ) {
            self.record_violation(reason);
        }
    }

    fn has_violation(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.is_some())
            .unwrap_or(true)
    }

    fn record_violation(&self, reason: String) {
        if let Ok(mut state) = self.state.lock() {
            if state.is_none() {
                *state = Some(reason);
            }
        }
    }
}

fn live_streamed_tool_policy(
    config: &AgentBackendConfig,
    _input: &AgentInput,
    command: &BackendCommand,
) -> Option<LiveToolPolicyState> {
    (config.kind == BackendKind::ClaudeCodeCli
        && claude_output_format(&command.args) == Some("stream-json"))
    .then(|| Arc::new(Mutex::new(None)))
}

fn live_tool_policy_violation_reason(state: &Option<LiveToolPolicyState>) -> Option<String> {
    state
        .as_ref()
        .and_then(|state| state.lock().ok().and_then(|reason| reason.clone()))
}

fn live_tool_policy_error(state: &Option<LiveToolPolicyState>) -> Option<AgentError> {
    live_tool_policy_violation_reason(state).map(permission_policy_rejected)
}

fn validate_tool_file_path(
    tool_name: &str,
    file_path: &str,
    input: &AgentInput,
) -> Result<(), String> {
    let path = Path::new(file_path);
    let has_parent_dir = path_has_parent_dir(path);
    let scoped_path = if has_parent_dir && path.is_absolute() && tool_name == "Read" {
        canonicalize_parent_path(path, file_path, &format!("{tool_name} path"))?
    } else if has_parent_dir {
        return Err(format!("{tool_name} path `{file_path}` contains `..`"));
    } else {
        path.to_path_buf()
    };
    if is_backend_internal_artifact_path(path, input)
        || is_backend_internal_artifact_path(&scoped_path, input)
    {
        return Err(format!(
            "{tool_name} path `{file_path}` points to backend-internal artifact state"
        ));
    }
    if path.is_absolute() {
        let allowed_roots = allowed_root_variants(&tool_file_allowed_roots(tool_name, input));
        if !allowed_roots
            .iter()
            .any(|root| scoped_path.starts_with(root))
        {
            let roots = allowed_roots
                .iter()
                .map(|root| root.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "{tool_name} path `{file_path}` is outside allowed roots: {roots}"
            ));
        }
    }
    Ok(())
}

fn path_has_parent_dir(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
}

fn canonicalize_parent_path(
    path: &Path,
    display_path: &str,
    label: &str,
) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|source| {
        format!("{label} `{display_path}` contains `..` and could not be resolved: {source}")
    })
}

fn allowed_root_variants(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut variants = Vec::new();
    for root in roots {
        variants.push(root.clone());
        if let Ok(canonical) = fs::canonicalize(root) {
            variants.push(canonical);
        }
    }
    variants.sort();
    variants.dedup();
    variants
}

fn validate_bash_absolute_paths(command: &str, input: &AgentInput) -> Result<(), String> {
    if let Some(token) = relative_parent_path_tokens(command).into_iter().next() {
        return Err(format!("relative path `{token}` contains `..`"));
    }
    let writable_roots = bash_writable_absolute_roots(input);
    let readable_context_tokens = bash_extra_context_source_tokens(command);
    for token in absolute_path_tokens(command) {
        let path = Path::new(&token);
        let scoped_path = if path_has_parent_dir(path) {
            canonicalize_parent_path(path, &token, "absolute path")?
        } else {
            path.to_path_buf()
        };
        if is_backend_internal_artifact_path(path, input)
            || is_backend_internal_artifact_path(&scoped_path, input)
        {
            return Err(format!(
                "absolute path `{token}` points to backend-internal artifact state"
            ));
        }
        let mut allowed_roots = writable_roots.clone();
        if bash_command_allows_extra_context_dirs(command)
            || readable_context_tokens
                .iter()
                .any(|readable| readable == &token)
        {
            allowed_roots.extend(input.extra_context_dirs.iter().cloned());
            allowed_roots.sort();
            allowed_roots.dedup();
        }
        let allowed_roots = allowed_root_variants(&allowed_roots);
        if !allowed_roots
            .iter()
            .any(|root| scoped_path.starts_with(root))
        {
            let roots = allowed_roots
                .iter()
                .map(|root| root.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "absolute path `{token}` is outside allowed roots: {roots}"
            ));
        }
    }
    Ok(())
}

fn tool_file_allowed_roots(tool_name: &str, input: &AgentInput) -> Vec<PathBuf> {
    let mut roots = vec![input.workspace_path.clone(), input.artifact_dir.clone()];
    if tool_name == "Read" {
        roots.extend(input.extra_context_dirs.iter().cloned());
    }
    roots.sort();
    roots.dedup();
    roots
}

fn relative_parent_path_tokens(command: &str) -> Vec<String> {
    shell_words(command)
        .into_iter()
        .flat_map(|word| relative_parent_path_tokens_in_shell_word(&word))
        .collect()
}

fn relative_parent_path_tokens_in_shell_word(word: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    push_relative_parent_path_token(word, &mut tokens);
    if let Some((_, value)) = word.split_once('=') {
        push_relative_parent_path_token(value, &mut tokens);
    }
    tokens
}

fn push_relative_parent_path_token(candidate: &str, tokens: &mut Vec<String>) {
    for segment in candidate.split(':') {
        if looks_like_relative_parent_path(segment) {
            tokens.push(segment.to_owned());
        }
    }
}

fn looks_like_relative_parent_path(candidate: &str) -> bool {
    if candidate.is_empty() || candidate.starts_with('-') || candidate.starts_with('/') {
        return false;
    }
    if !(candidate == ".."
        || candidate.starts_with("../")
        || candidate.starts_with("./../")
        || candidate.contains("/../")
        || candidate.ends_with("/.."))
    {
        return false;
    }
    Path::new(candidate)
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
}

fn is_backend_internal_artifact_path(path: &Path, input: &AgentInput) -> bool {
    if !path
        .components()
        .any(|component| component.as_os_str() == "claude-config")
    {
        return false;
    }
    if path.is_relative() {
        return true;
    }
    let artifact_root = input
        .artifact_dir
        .parent()
        .unwrap_or(input.artifact_dir.as_path());
    path.starts_with(artifact_root)
        || input
            .extra_context_dirs
            .iter()
            .any(|context_dir| path.starts_with(context_dir))
}

fn bash_writable_absolute_roots(input: &AgentInput) -> Vec<PathBuf> {
    let mut roots = vec![input.workspace_path.clone(), input.artifact_dir.clone()];
    roots.sort();
    roots.dedup();
    roots
}

fn bash_command_allows_extra_context_dirs(command: &str) -> bool {
    let words = shell_words(command);
    let Some(program) = words.first().and_then(|word| {
        Path::new(word)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
    }) else {
        return false;
    };
    if program == "sed" && words.iter().skip(1).any(|word| sed_in_place_arg(word)) {
        return false;
    }
    matches!(
        program,
        "cat" | "grep" | "head" | "jq" | "ls" | "rg" | "sed" | "sort" | "tail" | "uniq" | "wc"
    )
}

fn bash_extra_context_source_tokens(command: &str) -> Vec<String> {
    let words = shell_words(command);
    let Some(program) = words.first().and_then(|word| {
        Path::new(word)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
    }) else {
        return Vec::new();
    };
    match program {
        "cp" => cp_source_operands(&words),
        _ => Vec::new(),
    }
    .into_iter()
    .flat_map(|word| absolute_path_tokens_in_shell_word(&word))
    .collect()
}

fn cp_source_operands(words: &[String]) -> Vec<String> {
    let mut operands = Vec::new();
    let mut after_options = false;
    let mut skip_next = false;
    for word in words.iter().skip(1) {
        if skip_next {
            skip_next = false;
            continue;
        }
        if !after_options {
            if word == "--" {
                after_options = true;
                continue;
            }
            if word == "-t" || word == "--target-directory" {
                skip_next = true;
                continue;
            }
            if word.starts_with("--target-directory=") {
                continue;
            }
            if word.starts_with('-') && word != "-" {
                continue;
            }
        }
        operands.push(word.clone());
    }
    if operands.len() < 2 {
        return Vec::new();
    }
    operands.pop();
    operands
}

fn sed_in_place_arg(word: &str) -> bool {
    word == "-i"
        || word.strip_prefix("-i").is_some_and(|suffix| {
            suffix.is_empty()
                || suffix.starts_with('.')
                || suffix.starts_with('"')
                || suffix.starts_with('\'')
        })
        || word == "--in-place"
        || word.starts_with("--in-place=")
}

fn absolute_path_tokens(command: &str) -> Vec<String> {
    shell_words(command)
        .into_iter()
        .flat_map(|word| absolute_path_tokens_in_shell_word(&word))
        .collect()
}

fn absolute_path_tokens_in_shell_word(word: &str) -> Vec<String> {
    let bytes = word.as_bytes();
    let mut paths = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'/' && is_absolute_path_start_in_shell_word(bytes, index) {
            let start = index;
            index += 1;
            while index < bytes.len() && !is_path_token_terminator(bytes[index] as char) {
                index += 1;
            }
            paths.push(word[start..index].to_owned());
        } else {
            index += 1;
        }
    }
    paths
}

fn is_absolute_path_start_in_shell_word(bytes: &[u8], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    if bytes[index - 1] == b':' {
        return is_path_list_entry_start_in_shell_word(bytes, index);
    }
    bytes[index - 1] == b'='
}

fn is_path_list_entry_start_in_shell_word(bytes: &[u8], index: usize) -> bool {
    if bytes.get(index + 1) == Some(&b'/')
        || bytes
            .get(index + 1)
            .is_none_or(|byte| is_path_token_terminator(*byte as char))
    {
        return false;
    }
    bytes[..index - 1].contains(&b'=')
}

fn is_path_token_terminator(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '\'' | '"' | ')' | ']' | '}' | ';' | '|' | '<' | '>' | '`' | ','
        )
}

fn shell_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut quote = None::<char>;
    let mut in_word = false;

    while let Some(ch) = chars.next() {
        if quote.is_none() && ch.is_whitespace() {
            if in_word {
                words.push(std::mem::take(&mut current));
                in_word = false;
            }
            continue;
        }

        in_word = true;
        match ch {
            '\'' if quote != Some('"') => {
                quote = if quote == Some('\'') {
                    None
                } else {
                    Some('\'')
                };
            }
            '"' if quote != Some('\'') => {
                quote = if quote == Some('"') { None } else { Some('"') };
            }
            '\\' if quote != Some('\'') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                } else {
                    current.push(ch);
                }
            }
            _ => current.push(ch),
        }
    }

    if in_word {
        words.push(current);
    }
    words
}

fn codex_approval_policy_value(args: &[String]) -> Option<String> {
    if let Some(value) = codex_config_value(args, "approval_policy") {
        return Some(value);
    }
    for (index, arg) in args.iter().enumerate() {
        if matches!(
            arg.as_str(),
            "--ask-for-approval" | "-a" | "--approval-policy"
        ) {
            return args.get(index + 1).cloned();
        }
        for flag in ["--ask-for-approval=", "-a=", "--approval-policy="] {
            if let Some(value) = arg.strip_prefix(flag) {
                return Some(value.to_owned());
            }
        }
    }
    None
}

fn codex_config_value(args: &[String], key: &str) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if matches!(arg.as_str(), "-c" | "--config") {
            if let Some(value) = args.get(index + 1) {
                if let Some((name, value)) = value.split_once('=') {
                    if name == key {
                        return Some(value.to_owned());
                    }
                }
            }
        }
        if let Some(value) = arg.strip_prefix("-c=") {
            if let Some((name, value)) = value.split_once('=') {
                if name == key {
                    return Some(value.to_owned());
                }
            }
        }
        if let Some(value) = arg.strip_prefix("--config=") {
            if let Some((name, value)) = value.split_once('=') {
                if name == key {
                    return Some(value.to_owned());
                }
            }
        }
    }
    None
}

fn validate_input_paths(input: &AgentInput) -> Result<(), AgentError> {
    if !input.workspace_path.is_dir() {
        return Err(AgentError::PermissionPolicyRejected {
            code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
            reason: format!(
                "workspace path `{}` does not exist or is not a directory",
                input.workspace_path.display()
            ),
        });
    }
    fs::create_dir_all(&input.artifact_dir).map_err(io_error)?;
    ensure_inside_existing_root(&input.workspace_path, &input.workspace_path)?;
    ensure_inside_existing_root(&input.artifact_dir, &input.output_findings_path)?;
    ensure_inside_existing_root(&input.artifact_dir, &input.output_patch_path)?;
    ensure_inside_existing_root(&input.artifact_dir, &input.output_metadata_path)?;
    for dir in &input.extra_context_dirs {
        if !dir.is_dir() {
            return Err(AgentError::PermissionPolicyRejected {
                code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
                reason: format!(
                    "extra context directory `{}` does not exist or is not a directory",
                    dir.display()
                ),
            });
        }
    }
    Ok(())
}

fn validate_prompt_size(prompt: &str) -> Result<(), AgentError> {
    let bytes = prompt.len();
    if bytes > MAX_PROMPT_BYTES {
        Err(AgentError::ContextTooLarge {
            code: AgentErrorKind::BackendContextTooLarge.code(),
            bytes,
            limit: MAX_PROMPT_BYTES,
        })
    } else {
        Ok(())
    }
}

fn validate_backend_command(config: &AgentBackendConfig) -> Result<(), AgentError> {
    if let Some(reason) = backend_command_validation_error(
        config.kind,
        &config.cli.command,
        config.permissions.allow_dangerous_bypass,
    ) {
        return Err(AgentError::PermissionPolicyRejected {
            code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
            reason: format!("backend command {reason}"),
        });
    }
    Ok(())
}

fn validate_permission_policy(
    config: &AgentBackendConfig,
    input: Option<&AgentInput>,
) -> Result<(), AgentError> {
    if !config.permissions.allow_dangerous_bypass
        && is_dangerous_sandbox_mode(&config.permissions.sandbox)
    {
        return Err(AgentError::PermissionPolicyRejected {
            code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
            reason: format!(
                "permissions.sandbox `{}` requests a dangerous bypass mode; set permissions.allow_dangerous_bypass = true to allow it",
                config.permissions.sandbox
            ),
        });
    }
    if config.permissions.sandbox_required && !sandbox_supported(&config.permissions) {
        return Err(AgentError::SandboxUnavailable {
            code: AgentErrorKind::BackendSandboxUnavailable.code(),
            reason: format!(
                "sandbox `{}` cannot satisfy required backend policy",
                config.permissions.sandbox
            ),
        });
    }
    validate_write_allow_policy(config.kind, &config.permissions, input)?;
    if !config.permissions.allow_dangerous_bypass {
        if let Some(reason) = backend_args_policy_error(config.kind, &config.cli.args) {
            return Err(AgentError::PermissionPolicyRejected {
                code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
                reason: format!("{kind} arguments {reason}", kind = config.kind),
            });
        }
        reject_dangerous_backend_env(&config.cli.env)?;
        if config.kind == BackendKind::CodexCli {
            if let Some(value) = codex_approval_policy_value(&config.cli.args) {
                reject_non_never_codex_approval_policy(&value)?;
            }
        }
    }
    if let Some(input) = input {
        validate_read_deny_policy(&config.permissions, input)?;
        reject_scope_escape_args(&config.cli.args, input)?;
    }
    Ok(())
}

fn reject_dangerous_backend_env(envs: &BTreeMap<String, String>) -> Result<(), AgentError> {
    for key in envs.keys() {
        if let Some(reason) = dangerous_backend_env_key_reason(key) {
            return Err(AgentError::PermissionPolicyRejected {
                code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
                reason: format!("backend env key `{key}` is not allowed ({reason})"),
            });
        }
    }
    Ok(())
}

fn validate_write_allow_policy(
    kind: BackendKind,
    permissions: &PermissionConfig,
    input: Option<&AgentInput>,
) -> Result<(), AgentError> {
    const SUPPORTED_WRITE_ALLOW: &[&str] = &[
        "workspace",
        "artifacts",
        "extra-context",
        "final-materialization",
    ];
    for entry in &permissions.write_allow {
        if !SUPPORTED_WRITE_ALLOW.contains(&entry.as_str()) {
            return Err(AgentError::PermissionPolicyRejected {
                code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
                reason: format!(
                    "permissions.write_allow entry `{entry}` cannot be enforced by backend policy"
                ),
            });
        }
    }
    for required in ["workspace", "artifacts"] {
        if !permissions
            .write_allow
            .iter()
            .any(|entry| entry.as_str() == required)
        {
            return Err(AgentError::PermissionPolicyRejected {
                code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
                reason: format!(
                    "permissions.write_allow must include `{required}` because backend attempts expose that writable root"
                ),
            });
        }
    }
    if kind == BackendKind::CodexCli
        && input.is_some_and(|input| !input.extra_context_dirs.is_empty())
        && !permissions
            .write_allow
            .iter()
            .any(|entry| entry.as_str() == "extra-context")
    {
        return Err(AgentError::PermissionPolicyRejected {
            code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
            reason: "permissions.write_allow must include `extra-context` because Codex exposes extra context roots with write access".to_owned(),
        });
    }
    Ok(())
}

fn validate_read_deny_policy(
    permissions: &PermissionConfig,
    input: &AgentInput,
) -> Result<(), AgentError> {
    for pattern in &permissions.read_deny {
        if !read_deny_pattern_supported(pattern) {
            return Err(AgentError::PermissionPolicyRejected {
                code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
                reason: format!(
                    "permissions.read_deny pattern `{pattern}` cannot be enforced by backend policy"
                ),
            });
        }
    }

    scan_read_deny_root("workspace", &input.workspace_path, &permissions.read_deny)?;
    scan_read_deny_root("artifacts", &input.artifact_dir, &permissions.read_deny)?;
    for dir in &input.extra_context_dirs {
        scan_read_deny_root("extra context", dir, &permissions.read_deny)?;
    }
    Ok(())
}

fn scan_read_deny_root(label: &str, root: &Path, patterns: &[String]) -> Result<(), AgentError> {
    let root = root.canonicalize().map_err(io_error)?;
    let mut visited_dirs = BTreeSet::new();
    scan_read_deny_path(label, &root, &root, patterns, &mut visited_dirs)
}

fn scan_read_deny_path(
    label: &str,
    root: &Path,
    path: &Path,
    patterns: &[String],
    visited_dirs: &mut BTreeSet<PathBuf>,
) -> Result<(), AgentError> {
    if path != root {
        let relative = path
            .strip_prefix(root)
            .map(relative_path_string)
            .unwrap_or_else(|_| path.display().to_string());
        reject_read_deny_match(label, &relative, patterns)?;
    }

    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_symlink() {
        let target = path.canonicalize().map_err(io_error)?;
        if !target.starts_with(root) {
            let relative = path
                .strip_prefix(root)
                .map(relative_path_string)
                .unwrap_or_else(|_| path.display().to_string());
            return Err(AgentError::PermissionPolicyRejected {
                code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
                reason: format!(
                    "permissions.read_deny cannot be enforced for exposed {label} symlink `{relative}` because target `{}` is outside the exposed root",
                    target.display()
                ),
            });
        }
        if target != root {
            let relative = target
                .strip_prefix(root)
                .map(relative_path_string)
                .unwrap_or_else(|_| target.display().to_string());
            reject_read_deny_match(label, &relative, patterns)?;
        }
        if fs::metadata(&target).map_err(io_error)?.is_dir() {
            scan_read_deny_dir(label, root, &target, patterns, visited_dirs)?;
        }
        return Ok(());
    }
    if metadata.is_dir() {
        scan_read_deny_dir(label, root, path, patterns, visited_dirs)?;
    }
    Ok(())
}

fn scan_read_deny_dir(
    label: &str,
    root: &Path,
    path: &Path,
    patterns: &[String],
    visited_dirs: &mut BTreeSet<PathBuf>,
) -> Result<(), AgentError> {
    let canonical = path.canonicalize().map_err(io_error)?;
    if !visited_dirs.insert(canonical) {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        scan_read_deny_path(label, root, &entry.path(), patterns, visited_dirs)?;
    }
    Ok(())
}

fn reject_read_deny_match(
    label: &str,
    relative: &str,
    patterns: &[String],
) -> Result<(), AgentError> {
    for pattern in patterns {
        if read_deny_pattern_matches(pattern, relative) {
            return Err(AgentError::PermissionPolicyRejected {
                code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
                reason: format!(
                    "permissions.read_deny pattern `{pattern}` matches exposed {label} path `{relative}`"
                ),
            });
        }
    }
    Ok(())
}

fn read_deny_pattern_supported(pattern: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty()
        || pattern.starts_with('/')
        || pattern.contains('\\')
        || pattern.contains('\0')
        || pattern
            .chars()
            .any(|ch| matches!(ch, '?' | '[' | ']' | '{' | '}' | '!'))
    {
        return false;
    }
    !pattern
        .split('/')
        .any(|component| component.is_empty() || component == "." || component == "..")
}

fn read_deny_pattern_matches(pattern: &str, relative: &str) -> bool {
    let pattern = pattern.trim();
    if matches!(pattern, ".env.*" | "**/.env.*") && is_env_example_path(relative) {
        return false;
    }
    if let Some(prefix) = pattern.strip_suffix("/**") {
        return relative == prefix || relative.starts_with(&format!("{prefix}/"));
    }
    if let Some(suffix) = pattern.strip_prefix("**/") {
        return relative
            .split('/')
            .any(|component| wildcard_match(suffix, component))
            || wildcard_match(suffix, relative);
    }
    if !pattern.contains('/') {
        return relative
            .split('/')
            .any(|component| wildcard_match(pattern, component));
    }
    wildcard_match(pattern, relative)
}

fn is_env_example_path(relative: &str) -> bool {
    relative
        .rsplit('/')
        .next()
        .is_some_and(|component| component == ".env.example")
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let mut pattern_index = 0;
    let mut value_index = 0;
    let mut star_index = None;
    let mut star_value_index = 0;

    while value_index < value.len() {
        if pattern_index < pattern.len() && pattern[pattern_index] == value[value_index] {
            pattern_index += 1;
            value_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star_index = Some(pattern_index);
            star_value_index = value_index;
            pattern_index += 1;
        } else if let Some(star) = star_index {
            pattern_index = star + 1;
            star_value_index += 1;
            value_index = star_value_index;
        } else {
            return false;
        }
    }

    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn relative_path_string(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn reject_non_never_codex_approval_policy(value: &str) -> Result<(), AgentError> {
    if normalize_arg(value) == "never" {
        return Ok(());
    }
    Err(AgentError::PermissionPolicyRejected {
        code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
        reason: format!("codex approval_policy `{value}` is not allowed; expected `never`"),
    })
}

fn reject_scope_escape_args(args: &[String], input: &AgentInput) -> Result<(), AgentError> {
    for (index, arg) in args.iter().enumerate() {
        if matches!(arg.as_str(), "--add-dir" | "--cd" | "-C" | "--cwd") {
            if let Some(value) = args.get(index + 1) {
                validate_scope_arg(arg, value, input)?;
            }
        }
        let normalized = normalize_arg(arg);
        if let Some((flag, value)) = normalized.split_once('=') {
            if matches!(flag, "--add-dir" | "--cd" | "--cwd") {
                validate_scope_arg(flag, value, input)?;
            }
        }
    }
    Ok(())
}

fn validate_scope_arg(flag: &str, value: &str, input: &AgentInput) -> Result<(), AgentError> {
    let path = PathBuf::from(value);
    let root = match flag {
        "--add-dir" => {
            if path_equivalent_or_inside(&input.artifact_dir, &path)
                || input
                    .extra_context_dirs
                    .iter()
                    .any(|root| path_equivalent_or_inside(root, &path))
            {
                return Ok(());
            }
            return Err(AgentError::PermissionPolicyRejected {
                code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
                reason: format!(
                    "backend argument `{flag} {value}` escapes the attempt workspace/artifact scope"
                ),
            });
        }
        "--cd" | "-C" | "--cwd" => &input.workspace_path,
        _ => return Ok(()),
    };
    if !path_equivalent_or_inside(root, &path) {
        return Err(AgentError::PermissionPolicyRejected {
            code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
            reason: format!(
                "backend argument `{flag} {value}` escapes the attempt workspace/artifact scope"
            ),
        });
    }
    Ok(())
}

fn sandbox_supported(permissions: &PermissionConfig) -> bool {
    !permissions.sandbox_required
        || matches!(
            normalize_arg(&permissions.sandbox).as_str(),
            "workspace-write"
        )
}

fn is_dangerous_sandbox_mode(value: &str) -> bool {
    matches!(
        normalize_arg(value).as_str(),
        "danger-full-access" | "none" | "disabled"
    )
}

fn scrubbed_environment(
    config: &AgentBackendConfig,
    input: &AgentInput,
) -> BTreeMap<String, String> {
    let mut envs = BTreeMap::new();
    for key in [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LC_ALL",
        "TERM",
        "TMPDIR",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
    ] {
        if let Ok(value) = env::var(key) {
            if !is_sensitive_key_name(key) {
                envs.insert(key.to_owned(), value);
            }
        }
    }
    forward_backend_auth_env(&mut envs, config.kind);
    for (key, value) in &config.cli.env {
        envs.insert(key.clone(), value.clone());
    }
    if config.kind == BackendKind::ClaudeCodeCli
        && claude_api_key_auth_available(config)
        && !config.cli.env.contains_key("CLAUDE_CONFIG_DIR")
    {
        envs.insert(
            "CLAUDE_CONFIG_DIR".to_owned(),
            input
                .artifact_dir
                .join("claude-config")
                .display()
                .to_string(),
        );
    }
    envs.insert("ULTRAFUZZ_RUN_ID".to_owned(), input.run_id.to_string());
    envs.insert("ULTRAFUZZ_NODE_ID".to_owned(), input.node_id.to_string());
    envs.insert("ULTRAFUZZ_STRATEGY".to_owned(), input.strategy.to_string());
    envs.insert(
        "ULTRAFUZZ_ATTEMPT_INDEX".to_owned(),
        input.attempt_index.to_string(),
    );
    if let Some(model_id) = &input.model_id {
        envs.insert("ULTRAFUZZ_MODEL_ID".to_owned(), model_id.to_string());
    }
    if let Some(model) = &input.model {
        envs.insert("ULTRAFUZZ_MODEL".to_owned(), model.clone());
    }
    if let Some(model_index) = input.model_index {
        envs.insert("ULTRAFUZZ_MODEL_INDEX".to_owned(), model_index.to_string());
    }
    if let Some(loop_index) = input.loop_index {
        envs.insert("ULTRAFUZZ_LOOP_INDEX".to_owned(), loop_index.to_string());
    }
    envs.insert(
        "ULTRAFUZZ_ARTIFACT_DIR".to_owned(),
        input.artifact_dir.display().to_string(),
    );
    envs.insert(
        "ULTRAFUZZ_WORKSPACE_PATH".to_owned(),
        input.workspace_path.display().to_string(),
    );
    envs.insert(
        "ULTRAFUZZ_OUTPUT_FINDINGS_PATH".to_owned(),
        input.output_findings_path.display().to_string(),
    );
    envs.insert(
        "ULTRAFUZZ_OUTPUT_PATCH_PATH".to_owned(),
        input.output_patch_path.display().to_string(),
    );
    envs.insert(
        "ULTRAFUZZ_OUTPUT_METADATA_PATH".to_owned(),
        input.output_metadata_path.display().to_string(),
    );
    envs
}

fn forward_backend_auth_env(envs: &mut BTreeMap<String, String>, backend: BackendKind) {
    let keys = match backend {
        BackendKind::CodexCli => &["CODEX_API_KEY", "OPENAI_API_KEY"][..],
        BackendKind::ClaudeCodeCli => &["ANTHROPIC_API_KEY"][..],
    };
    forward_env_keys(envs, keys);
}

fn forward_env_keys(envs: &mut BTreeMap<String, String>, keys: &[&str]) {
    for key in keys {
        if let Some(value) = nonempty_env(key) {
            envs.insert((*key).to_owned(), value);
        }
    }
}

fn nonempty_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .and_then(|value| if value.is_empty() { None } else { Some(value) })
}

fn resolve_command(command: &str) -> Option<PathBuf> {
    let path = Path::new(command);
    if path.is_absolute() || command.contains(std::path::MAIN_SEPARATOR) {
        return path.is_file().then(|| path.to_path_buf());
    }
    let path_env = env::var_os("PATH")?;
    env::split_paths(&path_env)
        .map(|dir| dir.join(command))
        .find(|candidate| candidate.is_file())
}

fn copy_child_stream<R: Read + Send + 'static>(
    mut reader: R,
    path: PathBuf,
    mut monitor: Option<LiveToolPolicyMonitor>,
) -> thread::JoinHandle<io::Result<u64>> {
    thread::spawn(move || {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(path)?;
        copy_child_stream_bounded(
            &mut reader,
            &mut file,
            MAX_AGENT_STREAM_BYTES,
            monitor.as_mut(),
        )
    })
}

fn archive_existing_backend_outputs(artifact_dir: &Path, input: &AgentInput) -> io::Result<()> {
    if !artifact_dir.exists() {
        return Ok(());
    }
    let mut existing = Vec::new();
    for entry in fs::read_dir(artifact_dir)? {
        let entry = entry?;
        if should_preserve_backend_artifact(entry.file_name().to_str(), input) {
            continue;
        }
        existing.push(entry);
    }
    if existing.is_empty() {
        return Ok(());
    }

    let archive_dir = next_backend_attempt_archive_dir(artifact_dir);
    fs::create_dir_all(&archive_dir)?;
    for source in existing {
        fs::rename(source.path(), archive_dir.join(source.file_name()))?;
    }
    Ok(())
}

fn should_preserve_backend_artifact(file_name: Option<&str>, input: &AgentInput) -> bool {
    if input.strategy.as_str() == "aggregate-test-files"
        && file_name == Some(AGGREGATION_MANIFEST_FILE)
    {
        return true;
    }
    matches!(
        file_name,
        Some(
            BACKEND_ATTEMPTS_DIR
                | RENDERED_PROMPT_FILE
                | RUNTIME_CONTEXT_FILE
                | RUN_METADATA_DIR
                | PROPERTY_LENS_INPUTS_FILE
                | DEPENDENCY_WORKSPACE_CHANGE_CONFLICTS_FILE
        )
    )
}

fn next_backend_attempt_archive_dir(artifact_dir: &Path) -> PathBuf {
    let root = artifact_dir.join(BACKEND_ATTEMPTS_DIR);
    for index in 1.. {
        let candidate = root.join(format!("attempt-{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("unbounded attempt archive index exhausted")
}

fn copy_child_stream_bounded<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    max_bytes: u64,
    mut monitor: Option<&mut LiveToolPolicyMonitor>,
) -> io::Result<u64> {
    let mut buffer = [0u8; 8192];
    let mut written = 0u64;
    let mut marker_written = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            if let Some(monitor) = monitor.as_deref_mut() {
                monitor.finish();
            }
            return Ok(written);
        }
        if let Some(monitor) = monitor.as_deref_mut() {
            monitor.ingest(&buffer[..read]);
        }
        if written < max_bytes {
            let remaining = (max_bytes - written) as usize;
            let to_write = remaining.min(read);
            writer.write_all(&buffer[..to_write])?;
            written += to_write as u64;
            if to_write == read {
                continue;
            }
        }
        if !marker_written {
            writer.write_all(AGENT_STREAM_TRUNCATED_MARKER.as_bytes())?;
            written += AGENT_STREAM_TRUNCATED_MARKER.len() as u64;
            marker_written = true;
        }
    }
}

fn write_prompt_stdin_async<W: Write + Send + 'static>(
    mut stdin: W,
    prompt: String,
) -> thread::JoinHandle<io::Result<()>> {
    thread::spawn(move || write_prompt_stdin(&mut stdin, &prompt))
}

fn join_stdin_writer(handle: thread::JoinHandle<io::Result<()>>) -> Result<(), AgentError> {
    handle
        .join()
        .map_err(|_| io_error(io::Error::other("stdin writer thread panicked")))?
        .map_err(io_error)
}

fn join_stream_reader(
    handle: thread::JoinHandle<io::Result<u64>>,
    stream: &'static str,
) -> Result<u64, AgentError> {
    handle
        .join()
        .map_err(|_| io_error(io::Error::other(format!("{stream} reader thread panicked"))))?
        .map_err(io_error)
}

fn join_subprocess_threads(
    stdin_handle: Option<thread::JoinHandle<io::Result<()>>>,
    stdout_handle: thread::JoinHandle<io::Result<u64>>,
    stderr_handle: thread::JoinHandle<io::Result<u64>>,
) -> Result<(), AgentError> {
    if let Some(stdin_handle) = stdin_handle {
        join_stdin_writer(stdin_handle)?;
    }
    join_stream_reader(stdout_handle, "stdout")?;
    join_stream_reader(stderr_handle, "stderr")?;
    Ok(())
}

fn write_prompt_stdin(stdin: &mut impl Write, prompt: &str) -> io::Result<()> {
    match stdin.write_all(prompt.as_bytes()) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
        Err(error) => return Err(error),
    }
    match stdin.write_all(b"\n") {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(error) => Err(error),
    }
}

#[derive(Debug)]
struct WaitResult {
    exit_status: Option<ExitStatus>,
    timed_out: bool,
    error_kind: Option<AgentErrorKind>,
    error_message: Option<String>,
}

fn wait_with_timeout(
    child: &mut Child,
    timeout: Duration,
    live_tool_policy: Option<LiveToolPolicyState>,
) -> Result<WaitResult, AgentError> {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(io_error)? {
            let failed = !status.success();
            return Ok(WaitResult {
                exit_status: Some(status),
                timed_out: false,
                error_kind: failed.then_some(AgentErrorKind::BackendNonzeroExit),
                error_message: failed
                    .then(|| format!("exit status {}", exit_status_label(&status))),
            });
        }
        if let Some(reason) = live_tool_policy_violation_reason(&live_tool_policy) {
            terminate_process_group(child)?;
            let status = child.wait().map_err(io_error).ok();
            return Ok(WaitResult {
                exit_status: status,
                timed_out: false,
                error_kind: Some(AgentErrorKind::BackendPermissionPolicyRejected),
                error_message: Some(permission_policy_rejected(reason).to_string()),
            });
        }
        if started.elapsed() > timeout {
            terminate_process_group(child)?;
            let status = child.wait().map_err(io_error).ok();
            return Ok(WaitResult {
                exit_status: status,
                timed_out: true,
                error_kind: Some(AgentErrorKind::BackendTimeout),
                error_message: Some(format!("timed out after {timeout:?}")),
            });
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_result_permission_policy_error(wait_result: &WaitResult) -> Option<AgentError> {
    (wait_result.error_kind == Some(AgentErrorKind::BackendPermissionPolicyRejected))
        .then(|| permission_policy_rejected(wait_result_permission_policy_reason(wait_result)))
}

fn wait_result_permission_policy_reason(wait_result: &WaitResult) -> String {
    wait_result
        .error_message
        .as_deref()
        .and_then(permission_policy_reason_from_message)
        .unwrap_or("backend streamed tool use violated permission policy")
        .to_owned()
}

fn permission_policy_reason_from_message(message: &str) -> Option<&str> {
    let reason = message
        .strip_prefix(AgentErrorKind::BackendPermissionPolicyRejected.code())
        .and_then(|message| message.strip_prefix(": "))
        .unwrap_or(message);
    (!reason.is_empty()).then_some(reason)
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            configure_parent_death_signal()?;
            if libc::setsid() == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(all(unix, target_os = "linux"))]
fn configure_parent_death_signal() -> io::Result<()> {
    unsafe {
        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
            return Err(io::Error::last_os_error());
        }
        if libc::getppid() == 1 {
            libc::_exit(1);
        }
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "linux")))]
fn configure_parent_death_signal() -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn terminate_process_group(child: &mut Child) -> Result<(), AgentError> {
    let pid = child.id() as i32;
    signal_process_family(pid, libc::SIGTERM);
    thread::sleep(Duration::from_millis(100));
    if child.try_wait().map_err(io_error)?.is_none() || session_has_processes(pid) {
        signal_process_family(pid, libc::SIGKILL);
        let _ = child.kill();
        thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

#[cfg(unix)]
fn signal_process_family(root_pid: i32, signal: i32) {
    unsafe {
        libc::kill(-root_pid, signal);
    }
    signal_session_processes(root_pid, signal);
}

#[cfg(all(unix, target_os = "linux"))]
fn signal_session_processes(session_id: i32, signal: i32) {
    let current_pid = unsafe { libc::getpid() };
    for pid in process_ids_in_session(session_id) {
        if pid != current_pid {
            unsafe {
                libc::kill(pid, signal);
            }
        }
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn signal_session_processes(_session_id: i32, _signal: i32) {}

#[cfg(all(unix, target_os = "linux"))]
fn session_has_processes(session_id: i32) -> bool {
    let current_pid = unsafe { libc::getpid() };
    process_ids_in_session(session_id)
        .into_iter()
        .any(|pid| pid != current_pid)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn session_has_processes(_session_id: i32) -> bool {
    false
}

#[cfg(all(unix, target_os = "linux"))]
fn process_ids_in_session(session_id: i32) -> Vec<i32> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_string_lossy().parse::<i32>().ok()?;
            let stat = fs::read_to_string(entry.path().join("stat")).ok()?;
            (proc_stat_session_id(&stat)? == session_id).then_some(pid)
        })
        .collect()
}

#[cfg(all(unix, target_os = "linux"))]
fn proc_stat_session_id(stat: &str) -> Option<i32> {
    let end = stat.rfind(") ")?;
    let mut fields = stat[end + 2..].split_whitespace();
    let _state = fields.next()?;
    let _ppid = fields.next()?;
    let _pgrp = fields.next()?;
    fields.next()?.parse().ok()
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut Child) -> Result<(), AgentError> {
    child.kill().map_err(io_error)
}

fn write_transcript(
    config: &AgentBackendConfig,
    input: &AgentInput,
    command: &BackendCommand,
    wait_result: &WaitResult,
    duration: Duration,
) -> Result<(), AgentError> {
    let transcript = json!({
        "schema_version": "1.0",
        "backend": config.kind,
        "run_id": input.run_id,
        "node_id": input.node_id,
        "strategy": input.strategy,
        "attempt_index": input.attempt_index,
        "model_id": input.model_id,
        "model": input.model,
        "model_index": input.model_index,
        "loop_index": input.loop_index,
        "events": [
            {
                "type": "subprocess",
                "command": command.display_command(),
                "cwd": command.cwd,
                "stdout_path": command.stdout_path,
                "stderr_path": command.stderr_path,
                "exit_code": wait_result.exit_status.as_ref().and_then(ExitStatus::code),
                "timed_out": wait_result.timed_out,
                "duration_ms": duration.as_millis()
            }
        ]
    });
    write_pretty_json(&command.transcript_path, &transcript)
}

#[derive(Clone, Copy)]
struct SubprocessMetadata<'a> {
    exit_status: Option<&'a ExitStatus>,
    resolved_command: Option<&'a Path>,
    timed_out: bool,
    duration: Duration,
    error_kind: Option<AgentErrorKind>,
    error_message: Option<&'a str>,
}

fn write_subprocess_metadata(
    config: &AgentBackendConfig,
    input: &AgentInput,
    command: &BackendCommand,
    subprocess: SubprocessMetadata<'_>,
) -> Result<(), AgentError> {
    let permission_files = detect_project_permission_files(&config.project_root, config.kind);
    let metadata = json!({
        "schema_version": "1.0",
        "backend": config.kind,
        "runner": "cli-subprocess",
        "run_id": input.run_id,
        "node_id": input.node_id,
        "strategy": input.strategy,
        "attempt_index": input.attempt_index,
        "model_id": input.model_id,
        "model": input.model,
        "model_index": input.model_index,
        "loop_index": input.loop_index,
        "model_profile": config.model_profile.as_ref().map(|profile| json!({
            "id": profile.id.to_string(),
            "backend": profile.backend,
            "model": profile.model.clone(),
            "args": profile.args.clone(),
            "env_keys": public_env_keys(profile.env.keys()),
        })),
        "command": command.display_command(),
        "command_path": subprocess.resolved_command,
        "cwd": command.cwd,
        "artifact_dir": input.artifact_dir,
        "workspace_path": input.workspace_path,
        "stdout_path": command.stdout_path,
        "stderr_path": command.stderr_path,
        "transcript_path": command.transcript_path,
        "findings_path": input.output_findings_path,
        "patch_path": input.output_patch_path,
        "exit_code": subprocess.exit_status.and_then(ExitStatus::code),
        "exit_status": subprocess.exit_status.map(exit_status_label),
        "duration_ms": subprocess.duration.as_millis(),
        "timed_out": subprocess.timed_out,
        "error_class": subprocess.error_kind.map(AgentErrorKind::code),
        "error": subprocess.error_message,
        "env_keys": public_env_keys(command.env.keys()),
        "command_policy_decision": {
            "allowed": subprocess.error_kind != Some(AgentErrorKind::BackendPermissionPolicyRejected),
            "reason": subprocess.error_kind.map(AgentErrorKind::code).unwrap_or("allowed")
        },
        "permissions": {
            "profile": config.permissions.profile,
            "backend_policy": config.permissions.backend_policy,
            "sandbox": config.permissions.sandbox,
            "sandbox_required": config.permissions.sandbox_required,
            "approval_mode": config.permissions.approval_mode,
            "network": config.permissions.network,
            "read_deny": config.permissions.read_deny,
            "write_allow": config.permissions.write_allow,
            "allow_dangerous_bypass": config.permissions.allow_dangerous_bypass,
            "allow_target_repo_writes_during_attempts": config.permissions.allow_target_repo_writes_during_attempts
        },
        "project_permission_files": permission_files,
        "created_at": now_string()
    });
    write_pretty_json(&command.metadata_path, &metadata)
}

fn public_env_keys<'a>(keys: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    keys.into_iter()
        .filter(|key| !is_sensitive_key_name(key))
        .cloned()
        .collect()
}

fn validate_findings_output(path: &Path, metadata_path: &Path) -> Result<(), AgentError> {
    let source_path = if path.exists() {
        path.to_path_buf()
    } else {
        let compat_path = path
            .parent()
            .map(|parent| parent.join("finding.json"))
            .unwrap_or_else(|| PathBuf::from("finding.json"));
        if compat_path.exists() {
            compat_path
        } else {
            return Err(AgentError::InvalidOutput {
                code: AgentErrorKind::BackendInvalidOutput.code(),
                reason: format!("backend did not write {}", path.display()),
                metadata_path: metadata_path.to_path_buf(),
            });
        }
    };
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(&source_path).map_err(io_error)?).map_err(|source| {
            AgentError::Json {
                code: AgentErrorKind::BackendInvalidOutput.code(),
                source,
            }
        })?;
    if source_path.file_name().and_then(|name| name.to_str()) == Some("finding.json") {
        if value.is_object() || value.is_array() {
            return Ok(());
        }
        return Err(AgentError::InvalidOutput {
            code: AgentErrorKind::BackendInvalidOutput.code(),
            reason: "finding.json must be a JSON object or array".to_owned(),
            metadata_path: metadata_path.to_path_buf(),
        });
    }
    if !value.is_array() {
        return Err(AgentError::InvalidOutput {
            code: AgentErrorKind::BackendInvalidOutput.code(),
            reason: "findings.json must be a JSON array".to_owned(),
            metadata_path: metadata_path.to_path_buf(),
        });
    }
    Ok(())
}

fn changed_files(workspace_path: &Path) -> Vec<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_path)
        .arg("diff")
        .arg("--name-only")
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

fn detect_project_permission_files(project_root: &Path, kind: BackendKind) -> Vec<PathBuf> {
    let candidates: &[&str] = match kind {
        BackendKind::CodexCli => &[
            "AGENTS.md",
            ".codex/config.toml",
            ".codex/instructions.md",
            ".codex/execpolicy.rules",
        ],
        BackendKind::ClaudeCodeCli => &[
            "CLAUDE.md",
            ".claude/settings.json",
            ".claude/settings.local.json",
            ".claude/permissions.json",
        ],
    };
    candidates
        .iter()
        .map(|candidate| project_root.join(candidate))
        .filter(|candidate| candidate.exists())
        .collect()
}

fn write_pretty_json(path: &Path, value: &serde_json::Value) -> Result<(), AgentError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let mut file = File::create(path).map_err(io_error)?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|source| AgentError::Json {
        code: AgentErrorKind::BackendIo.code(),
        source,
    })?;
    file.write_all(b"\n").map_err(io_error)
}

fn has_flag(args: &[String], names: &[&str]) -> bool {
    args.iter().any(|arg| {
        names
            .iter()
            .any(|name| arg == name || arg.starts_with(&format!("{name}=")))
    })
}

fn ensure_inside_existing_root(root: &Path, path: &Path) -> Result<(), AgentError> {
    let root = root.canonicalize().map_err(io_error)?;
    let candidate = canonical_existing_or_parent(path)?;
    if candidate.starts_with(&root) {
        Ok(())
    } else {
        Err(AgentError::PermissionPolicyRejected {
            code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
            reason: format!(
                "path `{}` is outside scoped root `{}`",
                path.display(),
                root.display()
            ),
        })
    }
}

fn canonical_existing_or_parent(path: &Path) -> Result<PathBuf, AgentError> {
    if path.exists() {
        return path.canonicalize().map_err(io_error);
    }
    let parent = path
        .parent()
        .ok_or_else(|| AgentError::PermissionPolicyRejected {
            code: AgentErrorKind::BackendPermissionPolicyRejected.code(),
            reason: format!("path `{}` has no parent", path.display()),
        })?;
    parent.canonicalize().map_err(io_error)
}

fn path_equivalent_or_inside(root: &Path, path: &Path) -> bool {
    let root = match root.canonicalize() {
        Ok(root) => root,
        Err(_) => return false,
    };
    let candidate_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let candidate = if candidate_path.exists() {
        candidate_path.canonicalize()
    } else if let Some(parent) = candidate_path.parent() {
        parent.canonicalize()
    } else {
        Ok(candidate_path)
    };
    candidate.is_ok_and(|candidate| candidate == root || candidate.starts_with(root))
}

fn normalize_arg(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn exit_status_label(status: &ExitStatus) -> String {
    status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "signal".to_owned())
}

fn io_error(source: io::Error) -> AgentError {
    AgentError::Io {
        code: AgentErrorKind::BackendIo.code(),
        source,
    }
}

fn error_kind_from_code(code: &str) -> AgentErrorKind {
    match code {
        "backend-command-not-found" => AgentErrorKind::BackendCommandNotFound,
        "backend-timeout" => AgentErrorKind::BackendTimeout,
        "backend-nonzero-exit" => AgentErrorKind::BackendNonzeroExit,
        "backend-invalid-output" => AgentErrorKind::BackendInvalidOutput,
        "backend-context-too-large" => AgentErrorKind::BackendContextTooLarge,
        "backend-sandbox-unavailable" => AgentErrorKind::BackendSandboxUnavailable,
        "backend-permission-policy-rejected" => AgentErrorKind::BackendPermissionPolicyRejected,
        _ => AgentErrorKind::BackendIo,
    }
}

fn now_string() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", duration.as_secs(), duration.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;
    use ultrafuzz_config::{resolve_config_from_toml, CliOverrides, EnvOverrides};

    static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn restore_env_var(key: &str, value: Option<String>) {
        if let Some(value) = value {
            env::set_var(key, value);
        } else {
            env::remove_var(key);
        }
    }

    fn input(temp: &tempfile::TempDir) -> AgentInput {
        input_at(temp.path())
    }

    fn input_at(root: &Path) -> AgentInput {
        let workspace = root.join("workspace");
        let artifacts = root.join("artifacts/encode-decode-0");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&artifacts).unwrap();
        AgentInput {
            run_id: RunId::from("run"),
            node_id: NodeId::from("encode-decode-0"),
            strategy: StrategyId::from("encode-decode"),
            attempt_index: 0,
            model_id: None,
            model: None,
            model_index: None,
            loop_index: None,
            prompt: "write findings".to_owned(),
            workspace_path: workspace,
            artifact_dir: artifacts.clone(),
            extra_context_dirs: Vec::new(),
            output_findings_path: artifacts.join("findings.json"),
            output_patch_path: artifacts.join("patch.diff"),
            output_metadata_path: artifacts.join("metadata.json"),
            timeout: Duration::from_secs(5),
        }
    }

    fn backend_config(kind: BackendKind, command: impl Into<String>) -> AgentBackendConfig {
        let mut cli = match kind {
            BackendKind::CodexCli => CampaignConfig::default().backend.codex_cli,
            BackendKind::ClaudeCodeCli => CampaignConfig::default().backend.claude_code_cli,
        };
        cli.command = command.into();
        AgentBackendConfig {
            kind,
            cli,
            model_profile: None,
            permissions: PermissionConfig::default(),
            tools: ToolPolicyConfig::default(),
            project_root: PathBuf::from("."),
        }
    }

    fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.windows(2).find_map(|window| {
            if window[0] == flag {
                Some(window[1].as_str())
            } else {
                None
            }
        })
    }

    fn bypass_backend_config(kind: BackendKind, command: impl Into<String>) -> AgentBackendConfig {
        let mut config = backend_config(kind, command);
        config.permissions.allow_dangerous_bypass = true;
        config
    }

    #[test]
    fn campaign_backend_uses_matching_default_model_profile() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let config = resolve_config_from_toml(
            Some(
                r#"
[models]
default = "gpt-5-5"

[models.gpt-5-5]
backend = "codex-cli"
model = "gpt-5.5"
args = ["-c", "model_reasoning_effort=\"xhigh\""]

[models.gpt-5-5.env]
ULTRAFUZZ_TEST_DEFAULT_PROFILE = "1"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        let backend = CodexCliBackend::from_campaign_config(&config, temp.path());

        let command = backend.command_for(&input).unwrap();

        assert!(command
            .args
            .windows(2)
            .any(|window| window == ["--model".to_owned(), "gpt-5.5".to_owned()]));
        assert!(command.args.windows(2).any(|window| {
            window
                == [
                    "-c".to_owned(),
                    "model_reasoning_effort=\"xhigh\"".to_owned(),
                ]
        }));
        assert_eq!(
            command
                .env
                .get("ULTRAFUZZ_TEST_DEFAULT_PROFILE")
                .map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn campaign_backend_ignores_default_profile_for_other_backend() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let config = resolve_config_from_toml(
            Some(
                r#"
[models]
default = "gpt-5-5"

[models.gpt-5-5]
backend = "codex-cli"
model = "gpt-5.5"
args = ["-c", "model_reasoning_effort=\"xhigh\""]
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        let backend = ClaudeCodeCliBackend::from_campaign_config(&config, temp.path());

        let command = backend.command_for(&input).unwrap();

        assert!(!command.args.iter().any(|arg| arg == "gpt-5.5"));
        assert!(!command
            .args
            .iter()
            .any(|arg| arg.contains("model_reasoning_effort")));
    }

    #[test]
    fn copy_child_stream_bounded_truncates_and_drains() {
        let mut input = io::Cursor::new(b"abcdef".to_vec());
        let mut output = Vec::new();

        let written = copy_child_stream_bounded(&mut input, &mut output, 3, None).unwrap();

        assert_eq!(input.position(), 6);
        assert_eq!(
            String::from_utf8(output).unwrap(),
            format!("abc{AGENT_STREAM_TRUNCATED_MARKER}")
        );
        assert_eq!(written, 3 + AGENT_STREAM_TRUNCATED_MARKER.len() as u64);
    }

    #[test]
    fn codex_command_construction_scopes_workspace_and_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let mut input = input(&temp);
        let extra_context = temp.path().join("extra-artifacts");
        fs::create_dir_all(&extra_context).unwrap();
        input.extra_context_dirs.push(extra_context.clone());
        let mut config = backend_config(BackendKind::CodexCli, "codex");
        config
            .permissions
            .write_allow
            .push("extra-context".to_owned());
        let backend = CodexCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        assert_eq!(command.cwd, input.workspace_path);
        assert!(command.args.contains(&"exec".to_owned()));
        assert!(command
            .args
            .windows(2)
            .any(|window| { window == ["--sandbox".to_owned(), "workspace-write".to_owned()] }));
        assert!(!command.args.contains(&"--ask-for-approval".to_owned()));
        assert!(command
            .args
            .windows(2)
            .any(|window| { window == ["-c".to_owned(), "approval_policy=never".to_owned()] }));
        assert!(command.args.windows(2).any(|window| {
            window
                == [
                    "--cd".to_owned(),
                    input.workspace_path.display().to_string(),
                ]
        }));
        assert!(command.args.windows(2).any(|window| {
            window
                == [
                    "--add-dir".to_owned(),
                    input.artifact_dir.display().to_string(),
                ]
        }));
        assert!(command.args.windows(2).any(|window| {
            window == ["--add-dir".to_owned(), extra_context.display().to_string()]
        }));
        assert_eq!(command.args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn codex_model_profile_adds_model_flag_when_missing() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::CodexCli, "codex");
        config.model_profile = Some(ModelProfile {
            id: ModelProfileId::from("gpt-5-5"),
            backend: BackendKind::CodexCli,
            model: Some("gpt-5.5".to_owned()),
            args: Vec::new(),
            env: BTreeMap::new(),
        });
        let backend = CodexCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        assert!(command
            .args
            .windows(2)
            .any(|window| window == ["--model".to_owned(), "gpt-5.5".to_owned()]));
    }

    #[test]
    fn model_profile_does_not_override_configured_model_flag() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::CodexCli, "codex");
        config.cli.args = vec![
            "exec".to_owned(),
            "--model".to_owned(),
            "configured-model".to_owned(),
        ];
        config.model_profile = Some(ModelProfile {
            id: ModelProfileId::from("gpt-5-5"),
            backend: BackendKind::CodexCli,
            model: Some("gpt-5.5".to_owned()),
            args: Vec::new(),
            env: BTreeMap::new(),
        });
        let backend = CodexCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        assert!(command
            .args
            .windows(2)
            .any(|window| window == ["--model".to_owned(), "configured-model".to_owned()]));
        assert!(!command.args.iter().any(|arg| arg == "gpt-5.5"));
    }

    #[test]
    fn claude_model_profile_adds_model_flag_when_missing() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        config.model_profile = Some(ModelProfile {
            id: ModelProfileId::from("claude-4-6"),
            backend: BackendKind::ClaudeCodeCli,
            model: Some("claude-4.6".to_owned()),
            args: Vec::new(),
            env: BTreeMap::new(),
        });
        let backend = ClaudeCodeCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        assert!(command
            .args
            .windows(2)
            .any(|window| window == ["--model".to_owned(), "claude-4.6".to_owned()]));
    }

    #[test]
    fn claude_stream_json_output_enables_verbose() {
        let temp = tempfile::tempdir().unwrap();
        let mut input = input(&temp);
        let extra_context = temp.path().join("ancestor-artifacts");
        fs::create_dir_all(&extra_context).unwrap();
        input.extra_context_dirs.push(extra_context.clone());
        let backend =
            ClaudeCodeCliBackend::new(backend_config(BackendKind::ClaudeCodeCli, "claude"));

        let command = backend.command_for(&input).unwrap();

        assert!(command.args.windows(2).any(|window| {
            window
                == [
                    "--add-dir".to_owned(),
                    input.artifact_dir.display().to_string(),
                ]
        }));
        assert!(command.args.windows(2).any(|window| {
            window == ["--add-dir".to_owned(), extra_context.display().to_string()]
        }));
        assert!(command
            .args
            .windows(2)
            .any(|window| { window == ["--output-format".to_owned(), "stream-json".to_owned()] }));
        assert_eq!(
            flag_value(&command.args, "--tools"),
            Some("Read,Write,Edit,Bash")
        );
        assert_eq!(
            flag_value(&command.args, "--permission-mode"),
            Some("dontAsk")
        );
        let allowed_tools = flag_value(&command.args, "--allowedTools").unwrap();
        assert!(allowed_tools.contains("Read"));
        assert!(allowed_tools.contains("Write"));
        assert!(allowed_tools.contains("Edit"));
        assert!(!allowed_tools.contains("WebFetch"));
        assert!(allowed_tools.contains("Bash(forge *)"));
        assert!(allowed_tools.contains("Bash(solc *)"));
        assert!(allowed_tools.contains("Bash(recon-generate *)"));
        assert!(allowed_tools.contains("Bash(node *)"));
        assert!(allowed_tools.contains("Bash(npm *)"));
        assert!(allowed_tools.contains("Bash(pip show *)"));
        assert!(allowed_tools.contains("Bash(jq *)"));
        assert!(allowed_tools.contains("Bash(wc *)"));
        assert!(allowed_tools.contains("Bash(head *)"));
        assert!(allowed_tools.contains("Bash(tail *)"));
        assert!(allowed_tools.contains("Bash(sort *)"));
        assert!(allowed_tools.contains("Bash(uniq *)"));
        assert!(allowed_tools.contains("Bash(sha256sum *)"));
        assert!(allowed_tools.contains("Bash(timeout *)"));
        assert!(allowed_tools.contains("Bash(mkdir *)"));
        let disallowed_tools = flag_value(&command.args, "--disallowedTools").unwrap();
        assert!(disallowed_tools.contains("Bash(curl *)"));
        assert!(command.args.iter().any(|arg| arg == "--verbose"));
    }

    #[test]
    fn claude_network_enabled_allows_webfetch_tool() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        config.permissions.network = "enabled".to_owned();
        let backend = ClaudeCodeCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        assert_eq!(
            flag_value(&command.args, "--tools"),
            Some("Read,Write,Edit,Bash,WebFetch")
        );
        let allowed_tools = flag_value(&command.args, "--allowedTools").unwrap();
        assert!(allowed_tools.contains("WebFetch"));
    }

    #[test]
    fn claude_stream_policy_rejects_webfetch_when_network_disabled() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        let line = json!({
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "WebFetch",
                    "input": {"url": "https://example.com"}
                }]
            }
        })
        .to_string();

        let error = validate_streamed_tool_policy_line(&config, &input, 42, &line).unwrap_err();

        assert!(error.contains("denied WebFetch"));
        assert!(error.contains("network policy is disabled"));
    }

    #[test]
    fn claude_stream_policy_allows_webfetch_when_network_enabled() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        config.permissions.network = "enabled".to_owned();
        let line = json!({
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "WebFetch",
                    "input": {"url": "https://example.com"}
                }]
            }
        })
        .to_string();

        validate_streamed_tool_policy_line(&config, &input, 42, &line).unwrap();
    }

    #[test]
    fn claude_non_stream_json_output_does_not_force_verbose() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        config.cli.args = vec!["--output-format".to_owned(), "json".to_owned()];
        let backend = ClaudeCodeCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        assert!(!command.args.iter().any(|arg| arg == "--verbose"));
    }

    #[test]
    fn claude_api_key_env_enables_bare_mode() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        config
            .cli
            .env
            .insert("ANTHROPIC_API_KEY".to_owned(), "sk-ant-test".to_owned());
        let backend = ClaudeCodeCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        let expected_config_dir = input
            .artifact_dir
            .join("claude-config")
            .display()
            .to_string();
        assert!(command.args.iter().any(|arg| arg == "--bare"));
        assert!(command
            .args
            .iter()
            .any(|arg| arg == "--no-session-persistence"));
        assert_eq!(
            command.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some(expected_config_dir.as_str())
        );
    }

    #[test]
    fn claude_ambient_api_key_env_enables_bare_mode() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let old_anthropic = env::var("ANTHROPIC_API_KEY").ok();
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        env::set_var("ANTHROPIC_API_KEY", "ambient-anthropic-secret");
        let backend =
            ClaudeCodeCliBackend::new(backend_config(BackendKind::ClaudeCodeCli, "claude"));

        let command = backend.command_for(&input).unwrap();

        restore_env_var("ANTHROPIC_API_KEY", old_anthropic);

        let expected_config_dir = input
            .artifact_dir
            .join("claude-config")
            .display()
            .to_string();
        assert!(command.args.iter().any(|arg| arg == "--bare"));
        assert!(command
            .args
            .iter()
            .any(|arg| arg == "--no-session-persistence"));
        assert_eq!(
            command.env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("ambient-anthropic-secret")
        );
        assert_eq!(
            command.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some(expected_config_dir.as_str())
        );
    }

    #[test]
    fn claude_cli_session_auth_does_not_force_bare_mode() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let old_anthropic = env::var("ANTHROPIC_API_KEY").ok();
        env::remove_var("ANTHROPIC_API_KEY");
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let backend =
            ClaudeCodeCliBackend::new(backend_config(BackendKind::ClaudeCodeCli, "claude"));

        let command = backend.command_for(&input).unwrap();

        restore_env_var("ANTHROPIC_API_KEY", old_anthropic);

        assert!(!command.args.iter().any(|arg| arg == "--bare"));
        assert!(!command
            .args
            .iter()
            .any(|arg| arg == "--no-session-persistence"));
    }

    #[test]
    fn claude_rejects_configured_config_dir() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let configured_config_dir = temp.path().join("custom-claude-config");
        let mut config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        config
            .cli
            .env
            .insert("ANTHROPIC_API_KEY".to_owned(), "sk-ant-test".to_owned());
        config.cli.env.insert(
            "CLAUDE_CONFIG_DIR".to_owned(),
            configured_config_dir.display().to_string(),
        );
        let backend = ClaudeCodeCliBackend::new(config);

        let error = backend.command_for(&input).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("CLAUDE_CONFIG_DIR"));
        assert!(error
            .to_string()
            .contains("backend config-directory override"));
    }

    #[test]
    fn claude_preserves_configured_tool_permission_flags() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        config.cli.args = vec![
            "--tools".to_owned(),
            "Read".to_owned(),
            "--allowedTools".to_owned(),
            "Read".to_owned(),
            "--disallowedTools".to_owned(),
            "Bash(rm *)".to_owned(),
            "--permission-mode".to_owned(),
            "default".to_owned(),
        ];
        let backend = ClaudeCodeCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        assert_eq!(flag_value(&command.args, "--tools"), Some("Read"));
        assert_eq!(flag_value(&command.args, "--allowedTools"), Some("Read"));
        assert_eq!(
            flag_value(&command.args, "--disallowedTools"),
            Some("Bash(rm *)")
        );
        assert_eq!(
            flag_value(&command.args, "--permission-mode"),
            Some("default")
        );
    }

    #[test]
    fn codex_rejects_non_never_approval_policy_config() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::CodexCli, "codex");
        config.cli.args = vec![
            "exec".to_owned(),
            "-c".to_owned(),
            "approval_policy=on-request".to_owned(),
        ];
        let backend = CodexCliBackend::new(config);

        let error = backend.command_for(&input).unwrap_err();

        assert!(error.to_string().contains("approval_policy"));
        assert!(error
            .to_string()
            .contains("restricted Codex config override"));
    }

    #[test]
    fn env_scrubbing_forwards_codex_auth_env_and_keeps_explicit_env() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let old_openai = env::var("OPENAI_API_KEY").ok();
        let old_codex = env::var("CODEX_API_KEY").ok();
        let old_test_secret = env::var("ULTRAFUZZ_TEST_SECRET_TOKEN").ok();
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        env::set_var("OPENAI_API_KEY", "secret");
        env::set_var("CODEX_API_KEY", "codex-secret");
        env::set_var("ULTRAFUZZ_TEST_SECRET_TOKEN", "drop-me");
        let mut config = backend_config(BackendKind::CodexCli, "codex");
        config
            .cli
            .env
            .insert("ULTRAFUZZ_TEST_ALLOWED".to_owned(), "1".to_owned());
        let backend = CodexCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        restore_env_var("OPENAI_API_KEY", old_openai);
        restore_env_var("CODEX_API_KEY", old_codex);
        restore_env_var("ULTRAFUZZ_TEST_SECRET_TOKEN", old_test_secret);

        assert_eq!(
            command.env.get("CODEX_API_KEY").map(String::as_str),
            Some("codex-secret")
        );
        assert_eq!(
            command.env.get("OPENAI_API_KEY").map(String::as_str),
            Some("secret")
        );
        assert!(!command.env.contains_key("ULTRAFUZZ_TEST_SECRET_TOKEN"));
        assert_eq!(
            command
                .env
                .get("ULTRAFUZZ_TEST_ALLOWED")
                .map(String::as_str),
            Some("1")
        );
        assert_eq!(
            command
                .env
                .get("ULTRAFUZZ_ARTIFACT_DIR")
                .map(String::as_str),
            Some(input.artifact_dir.to_str().unwrap())
        );
    }

    #[test]
    fn env_scrubbing_forwards_claude_auth_env() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let old_anthropic = env::var("ANTHROPIC_API_KEY").ok();
        let old_openai = env::var("OPENAI_API_KEY").ok();
        let old_codex = env::var("CODEX_API_KEY").ok();
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        env::set_var("ANTHROPIC_API_KEY", "anthropic-secret");
        env::set_var("OPENAI_API_KEY", "openai-secret");
        env::set_var("CODEX_API_KEY", "codex-secret");
        let config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        let backend = ClaudeCodeCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        restore_env_var("ANTHROPIC_API_KEY", old_anthropic);
        restore_env_var("OPENAI_API_KEY", old_openai);
        restore_env_var("CODEX_API_KEY", old_codex);

        assert_eq!(
            command.env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("anthropic-secret")
        );
        assert!(!command.env.contains_key("OPENAI_API_KEY"));
        assert!(!command.env.contains_key("CODEX_API_KEY"));
    }

    #[test]
    fn metadata_env_keys_omit_sensitive_names() {
        let keys = [
            "PATH".to_owned(),
            "OPENAI_API_KEY".to_owned(),
            "ANTHROPIC_API_KEY".to_owned(),
            "ULTRAFUZZ_TEST_SECRET_TOKEN".to_owned(),
            "WALLET_PRIVATE_KEY".to_owned(),
            "AWS_ACCESS_KEY_ID".to_owned(),
            "CLIENT-SECRET".to_owned(),
        ];

        let public = public_env_keys(keys.iter());

        assert_eq!(public, vec!["PATH".to_owned()]);
    }

    #[test]
    fn dangerous_backend_flags_are_rejected_by_default() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        config.cli.args = vec!["--dangerously-skip-permissions".to_owned()];
        let backend = ClaudeCodeCliBackend::new(config);

        let error = backend.command_for(&input).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("dangerous bypass"));
    }

    #[test]
    fn dangerous_permission_sandbox_is_rejected_by_default() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::CodexCli, "codex");
        config.permissions.sandbox = "danger-full-access".to_owned();
        config.permissions.sandbox_required = false;
        let backend = CodexCliBackend::new(config);

        let error = backend.command_for(&input).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("permissions.sandbox"));
        assert!(error.to_string().contains("allow_dangerous_bypass"));
    }

    #[test]
    fn dangerous_permission_sandbox_is_allowed_with_explicit_bypass() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::CodexCli, "codex");
        config.permissions.sandbox = "danger-full-access".to_owned();
        config.permissions.sandbox_required = false;
        config.permissions.allow_dangerous_bypass = true;
        let backend = CodexCliBackend::new(config);

        let command = backend.command_for(&input).unwrap();

        assert!(command
            .args
            .windows(2)
            .any(|window| { window == ["--sandbox".to_owned(), "danger-full-access".to_owned()] }));
    }

    #[test]
    fn backend_command_path_is_rejected_by_default() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let script = write_script(temp.path(), "fake-codex", "#!/bin/sh\nexit 0\n");
        let backend = CodexCliBackend::new(backend_config(BackendKind::CodexCli, script));

        let error = backend.command_for(&input).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("backend command"));
        assert!(error.to_string().contains("codex"));
    }

    #[test]
    fn codex_config_policy_overrides_are_rejected_by_default() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let cases = [
            (
                vec![
                    "exec".to_owned(),
                    "-c".to_owned(),
                    "sandbox_workspace_write.network_access=true".to_owned(),
                ],
                "config",
            ),
            (
                vec![
                    "exec".to_owned(),
                    "--config".to_owned(),
                    "sandbox_mode=\"danger-full-access\"".to_owned(),
                ],
                "config",
            ),
            (
                vec![
                    "exec".to_owned(),
                    "--config=approval_policy=on-request".to_owned(),
                ],
                "config",
            ),
            (
                vec!["exec".to_owned(), "-c=permissions.write=true".to_owned()],
                "config",
            ),
            (
                vec!["exec".to_owned(), "-c=web_search=\"live\"".to_owned()],
                "config",
            ),
            (
                vec![
                    "exec".to_owned(),
                    "--config".to_owned(),
                    "web_search=\"live\"".to_owned(),
                ],
                "config",
            ),
            (
                vec!["exec".to_owned(), "--search".to_owned()],
                "dangerous bypass",
            ),
            (
                vec!["exec".to_owned(), "--yolo".to_owned()],
                "dangerous bypass",
            ),
            (
                vec![
                    "exec".to_owned(),
                    "--profile".to_owned(),
                    "danger".to_owned(),
                ],
                "profile",
            ),
            (vec!["exec".to_owned(), "-p=danger".to_owned()], "profile"),
        ];

        for (args, expected) in cases {
            let mut config = backend_config(BackendKind::CodexCli, "codex");
            config.cli.args = args;
            let backend = CodexCliBackend::new(config);

            let error = backend.command_for(&input).unwrap_err();

            assert_eq!(error.code(), "backend-permission-policy-rejected");
            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    #[test]
    fn read_deny_rejects_exposed_sensitive_workspace_paths() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        fs::write(input.workspace_path.join(".env"), "PRIVATE_KEY=secret\n").unwrap();
        let backend = CodexCliBackend::new(backend_config(BackendKind::CodexCli, "codex"));

        let error = backend.command_for(&input).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("read_deny"));
        assert!(error.to_string().contains(".env"));
    }

    #[test]
    fn read_deny_allows_exposed_env_example_workspace_paths() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        fs::write(input.workspace_path.join(".env.example"), "PRIVATE_KEY=\n").unwrap();
        let backend = CodexCliBackend::new(backend_config(BackendKind::CodexCli, "codex"));

        let command = backend.command_for(&input).unwrap();

        assert_eq!(command.command, "codex");
    }

    #[test]
    fn read_deny_still_rejects_exposed_env_local_workspace_paths() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        fs::write(
            input.workspace_path.join(".env.local"),
            "PRIVATE_KEY=secret\n",
        )
        .unwrap();
        let backend = CodexCliBackend::new(backend_config(BackendKind::CodexCli, "codex"));

        let error = backend.command_for(&input).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("read_deny"));
        assert!(error.to_string().contains(".env.local"));
    }

    #[test]
    fn read_deny_rejects_env_example_directory_contents() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let env_example_dir = input.workspace_path.join(".env.example");
        fs::create_dir_all(&env_example_dir).unwrap();
        fs::write(env_example_dir.join("secret"), "PRIVATE_KEY=secret\n").unwrap();
        let backend = CodexCliBackend::new(backend_config(BackendKind::CodexCli, "codex"));

        let error = backend.command_for(&input).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("read_deny"));
        assert!(error.to_string().contains(".env.example/secret"));
    }

    #[cfg(unix)]
    #[test]
    fn read_deny_rejects_symlink_to_external_sensitive_path() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let external_env = temp.path().join(".env");
        fs::write(&external_env, "PRIVATE_KEY=secret\n").unwrap();
        std::os::unix::fs::symlink(&external_env, input.workspace_path.join("config")).unwrap();
        let backend = CodexCliBackend::new(backend_config(BackendKind::CodexCli, "codex"));

        let error = backend.command_for(&input).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("read_deny"));
        assert!(error.to_string().contains("symlink"));
    }

    #[test]
    fn unsupported_write_allow_policy_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let mut config = backend_config(BackendKind::CodexCli, "codex");
        config.permissions.write_allow = vec!["artifacts".to_owned()];
        let backend = CodexCliBackend::new(config);

        let error = backend.command_for(&input).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("write_allow"));
        assert!(error.to_string().contains("workspace"));
    }

    #[test]
    fn extra_context_write_policy_fails_closed_without_explicit_allow() {
        let temp = tempfile::tempdir().unwrap();
        let mut input = input(&temp);
        let extra_context = temp.path().join("extra-artifacts");
        fs::create_dir_all(&extra_context).unwrap();
        input.extra_context_dirs.push(extra_context);
        let mut config = backend_config(BackendKind::CodexCli, "codex");
        config
            .permissions
            .write_allow
            .retain(|entry| entry != "extra-context");
        let backend = CodexCliBackend::new(config);

        let error = backend.command_for(&input).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("write_allow"));
        assert!(error.to_string().contains("extra-context"));
    }

    #[test]
    fn codex_rejects_dangerous_sandbox_values_by_default() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let cases = [
            (
                "short two-token danger-full-access",
                vec![
                    "exec".to_owned(),
                    "-s".to_owned(),
                    "danger-full-access".to_owned(),
                ],
            ),
            (
                "short two-token none",
                vec!["exec".to_owned(), "-s".to_owned(), "none".to_owned()],
            ),
            (
                "short two-token disabled",
                vec!["exec".to_owned(), "-s".to_owned(), "disabled".to_owned()],
            ),
            (
                "short assignment danger-full-access",
                vec!["exec".to_owned(), "-s=danger-full-access".to_owned()],
            ),
            (
                "short assignment none",
                vec!["exec".to_owned(), "-s=none".to_owned()],
            ),
            (
                "short assignment disabled",
                vec!["exec".to_owned(), "-s=disabled".to_owned()],
            ),
            (
                "long two-token remains rejected",
                vec![
                    "exec".to_owned(),
                    "--sandbox".to_owned(),
                    "danger-full-access".to_owned(),
                ],
            ),
            (
                "long assignment remains rejected",
                vec!["exec".to_owned(), "--sandbox=none".to_owned()],
            ),
        ];

        for (case, args) in cases {
            let mut config = backend_config(BackendKind::CodexCli, "codex");
            config.cli.args = args;
            let backend = CodexCliBackend::new(config);

            let error = backend.command_for(&input).unwrap_err();

            assert_eq!(error.code(), "backend-permission-policy-rejected", "{case}");
            assert!(
                error.to_string().contains("dangerous bypass"),
                "{case}: {error}"
            );
        }
    }

    #[test]
    fn codex_allows_safe_short_sandbox_values_by_default() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let cases = [
            (
                "short two-token workspace-write",
                vec![
                    "exec".to_owned(),
                    "-s".to_owned(),
                    "workspace-write".to_owned(),
                ],
            ),
            (
                "short assignment workspace-write",
                vec!["exec".to_owned(), "-s=workspace-write".to_owned()],
            ),
        ];

        for (case, args) in cases {
            let mut config = backend_config(BackendKind::CodexCli, "codex");
            config.cli.args = args;
            let backend = CodexCliBackend::new(config);

            let command = backend.command_for(&input).unwrap();

            assert!(
                !command.args.iter().any(|arg| arg == "--sandbox"),
                "{case}: {command:?}"
            );
        }
    }

    #[test]
    fn codex_allows_dangerous_short_sandbox_when_bypass_enabled() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let cases = [
            vec![
                "exec".to_owned(),
                "-s".to_owned(),
                "danger-full-access".to_owned(),
            ],
            vec!["exec".to_owned(), "-s=none".to_owned()],
            vec!["exec".to_owned(), "-s=disabled".to_owned()],
        ];

        for args in cases {
            let mut config = backend_config(BackendKind::CodexCli, "codex");
            config.permissions.allow_dangerous_bypass = true;
            config.cli.args = args;
            let backend = CodexCliBackend::new(config);

            backend.command_for(&input).unwrap();
        }
    }

    #[test]
    fn backend_scope_args_reject_relative_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        for args in [
            vec!["exec".to_owned(), "--cd".to_owned(), "..".to_owned()],
            vec!["exec".to_owned(), "--add-dir=../workspace".to_owned()],
        ] {
            let mut config = backend_config(BackendKind::CodexCli, "codex");
            config.cli.args = args;
            let backend = CodexCliBackend::new(config);

            let error = backend.command_for(&input).unwrap_err();

            assert_eq!(error.code(), "backend-permission-policy-rejected");
            assert!(error.to_string().contains("escapes"));
        }
    }

    #[test]
    fn missing_backend_command_has_explicit_error_class() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let backend = CodexCliBackend::new(bypass_backend_config(
            BackendKind::CodexCli,
            "definitely-not-an-ultrafuzz-backend",
        ));

        let error = backend.run(input).unwrap_err();

        assert_eq!(error.code(), "backend-command-not-found");
    }

    #[test]
    fn timeout_writes_metadata_and_kills_subprocess() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(
            temp.path(),
            "fake-codex",
            "#!/bin/sh\nsleep 5\nprintf '[]\\n' > \"$ULTRAFUZZ_OUTPUT_FINDINGS_PATH\"\n",
        );
        let mut input = input(&temp);
        input.timeout = Duration::from_millis(100);
        let backend = CodexCliBackend::new(bypass_backend_config(BackendKind::CodexCli, script));

        let error = backend.run(input.clone()).unwrap_err();

        assert_eq!(error.code(), "backend-timeout");
        let metadata: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(input.output_metadata_path).unwrap()).unwrap();
        assert_eq!(metadata["timed_out"], true);
        assert_eq!(metadata["error_class"], "backend-timeout");
    }

    #[test]
    fn timeout_still_applies_when_backend_does_not_read_prompt_stdin() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(temp.path(), "fake-codex", "#!/bin/sh\nsleep 5\n");
        let mut input = input(&temp);
        input.prompt = "x".repeat(512 * 1024);
        input.timeout = Duration::from_millis(100);
        let backend = CodexCliBackend::new(bypass_backend_config(BackendKind::CodexCli, script));

        let error = backend.run(input.clone()).unwrap_err();

        assert_eq!(error.code(), "backend-timeout");
        let metadata: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(input.output_metadata_path).unwrap()).unwrap();
        assert_eq!(metadata["timed_out"], true);
        assert_eq!(metadata["error_class"], "backend-timeout");
    }

    #[cfg(all(unix, target_os = "linux"))]
    #[test]
    fn timeout_kills_subprocess_session_grandchildren() {
        if resolve_command("bash").is_none() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(
            temp.path(),
            "fake-codex",
            r#"#!/usr/bin/env bash
set -m
bash -c 'trap "" TERM HUP; echo "$$" > "$1"; while true; do sleep 1; done' child "$ULTRAFUZZ_ARTIFACT_DIR/grandchild.pid" &
while [ ! -s "$ULTRAFUZZ_ARTIFACT_DIR/grandchild.pid" ]; do sleep 0.01; done
wait
"#,
        );
        let mut input = input(&temp);
        input.timeout = Duration::from_millis(100);
        let grandchild_pid_path = input.artifact_dir.join("grandchild.pid");
        let backend = CodexCliBackend::new(bypass_backend_config(BackendKind::CodexCli, script));

        let error = backend.run(input).unwrap_err();

        assert_eq!(error.code(), "backend-timeout");
        let grandchild_pid: i32 = fs::read_to_string(grandchild_pid_path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_process_exits(grandchild_pid);
    }

    #[cfg(all(unix, target_os = "linux"))]
    #[test]
    fn backend_child_exits_when_parent_process_dies() {
        if resolve_command("bash").is_none() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let mut helper = Command::new(env::current_exe().unwrap());
        helper
            .args([
                "--exact",
                "tests::pdeathsig_helper_launches_backend",
                "--nocapture",
            ])
            .env("ULTRAFUZZ_PDEATHSIG_HELPER_ROOT", temp.path())
            .env("RUST_TEST_THREADS", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let mut helper = helper.spawn().unwrap();
        let backend_pid = read_pid_file_within(
            &temp.path().join("artifacts/encode-decode-0/backend.pid"),
            Duration::from_secs(2),
        );
        unsafe {
            libc::kill(helper.id() as i32, libc::SIGKILL);
        }
        let _ = helper.wait();

        assert_process_exits(backend_pid);
    }

    #[cfg(all(unix, target_os = "linux"))]
    #[test]
    fn pdeathsig_helper_launches_backend() {
        let Some(root) = env::var_os("ULTRAFUZZ_PDEATHSIG_HELPER_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        fs::create_dir_all(&root).unwrap();
        let script = write_script(
            &root,
            "fake-codex-pdeath",
            r#"#!/usr/bin/env bash
printf '%s\n' "$$" > "$ULTRAFUZZ_ARTIFACT_DIR/backend.pid"
while true; do sleep 1; done
"#,
        );
        let mut input = input_at(&root);
        input.timeout = Duration::from_secs(60);
        let backend = CodexCliBackend::new(bypass_backend_config(BackendKind::CodexCli, script));

        let _ = backend.run(input);
    }

    #[test]
    fn successful_subprocess_captures_logs_transcript_and_validates_findings() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(
            temp.path(),
            "fake-codex",
            "#!/bin/sh\necho stdout-line\necho stderr-line >&2\nprintf '[]\\n' > \"$ULTRAFUZZ_OUTPUT_FINDINGS_PATH\"\n",
        );
        let input = input(&temp);
        let backend = CodexCliBackend::new(bypass_backend_config(BackendKind::CodexCli, script));

        let output = backend.run(input.clone()).unwrap();

        assert_eq!(output.status, AgentStatus::Succeeded);
        assert_eq!(
            fs::read_to_string(input.artifact_dir.join(STDOUT_LOG)).unwrap(),
            "stdout-line\n"
        );
        assert_eq!(
            fs::read_to_string(input.artifact_dir.join(STDERR_LOG)).unwrap(),
            "stderr-line\n"
        );
        assert!(input.artifact_dir.join(TRANSCRIPT_FILE).exists());
        assert!(input.output_metadata_path.exists());
    }

    #[test]
    fn command_archives_existing_backend_outputs_before_retry() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        fs::write(input.artifact_dir.join(STDOUT_LOG), "old stdout\n").unwrap();
        fs::write(input.artifact_dir.join(STDERR_LOG), "old stderr\n").unwrap();
        fs::write(input.artifact_dir.join(TRANSCRIPT_FILE), "{}\n").unwrap();
        fs::write(&input.output_metadata_path, "{\"old\":true}\n").unwrap();
        fs::write(&input.output_findings_path, "[{\"stale\":true}]\n").unwrap();
        fs::write(input.artifact_dir.join(RENDERED_PROMPT_FILE), "prompt\n").unwrap();
        fs::write(input.artifact_dir.join(RUNTIME_CONTEXT_FILE), "{}\n").unwrap();
        fs::write(input.artifact_dir.join(PROPERTY_LENS_INPUTS_FILE), "[]\n").unwrap();
        fs::create_dir_all(input.artifact_dir.join(RUN_METADATA_DIR)).unwrap();
        fs::write(
            input.artifact_dir.join(RUN_METADATA_DIR).join("state.json"),
            "{}\n",
        )
        .unwrap();
        fs::create_dir_all(input.artifact_dir.join("nested")).unwrap();
        fs::write(
            input.artifact_dir.join("nested/required.json"),
            "{\"stale\":true}\n",
        )
        .unwrap();

        let backend = CodexCliBackend::new(backend_config(BackendKind::CodexCli, "codex"));

        backend.command_for(&input).unwrap();

        let first_archive = input
            .artifact_dir
            .join(BACKEND_ATTEMPTS_DIR)
            .join("attempt-1");
        assert_eq!(
            fs::read_to_string(first_archive.join(STDOUT_LOG)).unwrap(),
            "old stdout\n"
        );
        assert_eq!(
            fs::read_to_string(first_archive.join(STDERR_LOG)).unwrap(),
            "old stderr\n"
        );
        assert!(first_archive.join(TRANSCRIPT_FILE).is_file());
        assert!(first_archive.join("metadata.json").is_file());
        assert!(first_archive.join("findings.json").is_file());
        assert!(first_archive.join("nested/required.json").is_file());
        assert!(!input.output_findings_path.exists());
        assert!(!input.artifact_dir.join("nested/required.json").exists());
        assert!(input.artifact_dir.join(RENDERED_PROMPT_FILE).is_file());
        assert!(input.artifact_dir.join(RUNTIME_CONTEXT_FILE).is_file());
        assert!(input.artifact_dir.join(PROPERTY_LENS_INPUTS_FILE).is_file());
        assert!(input
            .artifact_dir
            .join(RUN_METADATA_DIR)
            .join("state.json")
            .is_file());

        fs::write(input.artifact_dir.join(STDOUT_LOG), "new stdout\n").unwrap();
        backend.command_for(&input).unwrap();

        let second_archive = input
            .artifact_dir
            .join(BACKEND_ATTEMPTS_DIR)
            .join("attempt-2");
        assert_eq!(
            fs::read_to_string(second_archive.join(STDOUT_LOG)).unwrap(),
            "new stdout\n"
        );
    }

    #[test]
    fn command_preserves_prepared_aggregate_manifest_for_aggregate_node() {
        let temp = tempfile::tempdir().unwrap();
        let mut input = input(&temp);
        let artifact_dir = temp.path().join("artifacts/aggregate-test-files");
        fs::create_dir_all(&artifact_dir).unwrap();
        input.node_id = NodeId::from("aggregate-test-files");
        input.strategy = StrategyId::from("aggregate-test-files");
        input.artifact_dir = artifact_dir.clone();
        input.output_findings_path = artifact_dir.join("findings.json");
        input.output_patch_path = artifact_dir.join("patch.diff");
        input.output_metadata_path = artifact_dir.join("metadata.json");
        fs::write(
            artifact_dir.join(AGGREGATION_MANIFEST_FILE),
            "{\"prepared_by\":\"ultrafuzz\"}\n",
        )
        .unwrap();
        fs::write(artifact_dir.join(STDOUT_LOG), "old stdout\n").unwrap();

        let backend = CodexCliBackend::new(backend_config(BackendKind::CodexCli, "codex"));

        backend.command_for(&input).unwrap();

        assert_eq!(
            fs::read_to_string(artifact_dir.join(AGGREGATION_MANIFEST_FILE)).unwrap(),
            "{\"prepared_by\":\"ultrafuzz\"}\n"
        );
        let first_archive = artifact_dir.join(BACKEND_ATTEMPTS_DIR).join("attempt-1");
        assert!(first_archive.join(STDOUT_LOG).is_file());
        assert!(!first_archive.join(AGGREGATION_MANIFEST_FILE).exists());
    }

    #[test]
    fn claude_transient_api_errors_are_retried_inside_backend() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(
            temp.path(),
            "fake-claude-transient",
            r#"#!/bin/sh
count_file="$ULTRAFUZZ_ARTIFACT_DIR/../transient-count"
count=0
if [ -f "$count_file" ]; then
  count="$(cat "$count_file")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
if [ "$count" -eq 1 ]; then
  mkdir -p "$ULTRAFUZZ_ARTIFACT_DIR/nested"
  printf '%s\n' '{"stale":true}' > "$ULTRAFUZZ_ARTIFACT_DIR/nested/required.json"
  printf '%s\n' '[{"stale":true}]' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
  printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"api_error_status":500,"result":"API Error: Internal server error"}'
  exit 1
fi
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
"#,
        );
        let input = input(&temp);
        let backend =
            ClaudeCodeCliBackend::new(bypass_backend_config(BackendKind::ClaudeCodeCli, script));

        let output = backend.run(input.clone()).unwrap();

        assert_eq!(output.status, AgentStatus::Succeeded);
        assert_eq!(
            fs::read_to_string(input.artifact_dir.join("../transient-count")).unwrap(),
            "2\n"
        );
        let first_archive = input
            .artifact_dir
            .join(BACKEND_ATTEMPTS_DIR)
            .join("attempt-1");
        assert!(fs::read_to_string(first_archive.join(STDOUT_LOG))
            .unwrap()
            .contains("Internal server error"));
        assert_eq!(
            fs::read_to_string(first_archive.join("nested/required.json")).unwrap(),
            "{\"stale\":true}\n"
        );
        assert_eq!(
            fs::read_to_string(first_archive.join("findings.json")).unwrap(),
            "[{\"stale\":true}]\n"
        );
        assert!(!input.artifact_dir.join("nested/required.json").exists());
        assert!(fs::read_to_string(input.artifact_dir.join(STDOUT_LOG))
            .unwrap()
            .contains("\"ok\""));
    }

    #[test]
    fn claude_overloaded_api_errors_retry_beyond_short_outages() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(
            temp.path(),
            "fake-claude-overloaded",
            r#"#!/bin/sh
count_file="$ULTRAFUZZ_ARTIFACT_DIR/../overloaded-count"
count=0
if [ -f "$count_file" ]; then
  count="$(cat "$count_file")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
if [ "$count" -le 6 ]; then
  printf '%s\n' '{"type":"system","subtype":"api_retry","api_error_status":529,"error":"overloaded"}'
  printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"result":"API Error: Repeated 529 Overloaded errors. The API is at capacity."}'
  exit 1
fi
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"recovered"}]}}'
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
"#,
        );
        let input = input(&temp);
        let backend =
            ClaudeCodeCliBackend::new(bypass_backend_config(BackendKind::ClaudeCodeCli, script));

        let output = backend.run(input.clone()).unwrap();

        assert_eq!(output.status, AgentStatus::Succeeded);
        assert_eq!(
            fs::read_to_string(input.artifact_dir.join("../overloaded-count")).unwrap(),
            "7\n"
        );
        assert!(fs::read_to_string(
            input
                .artifact_dir
                .join(BACKEND_ATTEMPTS_DIR)
                .join("attempt-6")
                .join(STDOUT_LOG)
        )
        .unwrap()
        .contains("Repeated 529 Overloaded errors"));
        assert!(fs::read_to_string(input.artifact_dir.join(STDOUT_LOG))
            .unwrap()
            .contains("recovered"));
    }

    #[test]
    fn claude_non_transient_nonzero_errors_are_not_retried_inside_backend() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(
            temp.path(),
            "fake-claude-non-transient",
            r#"#!/bin/sh
count_file="$ULTRAFUZZ_ARTIFACT_DIR/count"
count=0
if [ -f "$count_file" ]; then
  count="$(cat "$count_file")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"result":"ordinary tool failure"}'
exit 1
"#,
        );
        let input = input(&temp);
        let backend =
            ClaudeCodeCliBackend::new(bypass_backend_config(BackendKind::ClaudeCodeCli, script));

        let error = backend.run(input.clone()).unwrap_err();

        assert_eq!(error.code(), "backend-nonzero-exit");
        assert_eq!(
            fs::read_to_string(input.artifact_dir.join("count")).unwrap(),
            "1\n"
        );
        assert!(!input.artifact_dir.join(BACKEND_ATTEMPTS_DIR).exists());
    }

    #[test]
    fn claude_streamed_bash_tool_uses_are_checked_against_command_policy() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(
            temp.path(),
            "fake-claude",
            r#"#!/bin/sh
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"forge build; echo BAD"}}]}}'
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
"#,
        );
        let input = input(&temp);
        let backend =
            ClaudeCodeCliBackend::new(bypass_backend_config(BackendKind::ClaudeCodeCli, script));

        let error = backend.run(input.clone()).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("forge build; echo BAD"));
        assert!(error.to_string().contains("unsafe shell syntax"));
        assert!(input.output_metadata_path.exists());
    }

    #[test]
    fn claude_streamed_bash_policy_allows_read_only_label_chain() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        let line = json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "Bash",
                    "input": {
                        "command": "echo \"WORKSPACE:\"; pwd; echo \"---LS WORKSPACE---\"; ls -la"
                    }
                }]
            }
        })
        .to_string();

        validate_streamed_tool_policy_line(&config, &input, 1, &line).unwrap();
    }

    #[test]
    fn claude_streamed_bash_policy_rejects_mutating_chain() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let config = backend_config(BackendKind::ClaudeCodeCli, "claude");
        let line = json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "Bash",
                    "input": {
                        "command": "echo ok; rm test/foundry/Generated.t.sol"
                    }
                }]
            }
        })
        .to_string();

        let error = validate_streamed_tool_policy_line(&config, &input, 1, &line).unwrap_err();

        assert!(error.contains("read-only inspection commands"));
    }

    #[test]
    fn claude_streamed_bash_tool_policy_kills_denied_commands_live() {
        let temp = tempfile::tempdir().unwrap();
        let event = json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "Bash",
                    "input": { "command": "curl -s https://raw.githubusercontent.com/example/spec.md" }
                }]
            }
        })
        .to_string();
        let script = write_script(
            temp.path(),
            "fake-claude",
            &format!(
                "#!/bin/sh\nprintf '%s\\n' '{}'\nsleep 5\nprintf '[]\\n' > \"$ULTRAFUZZ_OUTPUT_FINDINGS_PATH\"\n",
                event
            ),
        );
        let mut input = input(&temp);
        input.timeout = Duration::from_millis(500);
        let backend =
            ClaudeCodeCliBackend::new(bypass_backend_config(BackendKind::ClaudeCodeCli, script));

        let error = backend.run(input.clone()).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("curl -s https://"));
        assert!(error.to_string().contains("matched a deny rule"));
        let metadata: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(input.output_metadata_path).unwrap()).unwrap();
        assert_eq!(metadata["timed_out"], false);
        assert_eq!(
            metadata["error_class"],
            "backend-permission-policy-rejected"
        );
    }

    #[test]
    fn claude_streamed_bash_tool_uses_reject_outside_absolute_paths() {
        let temp = tempfile::tempdir().unwrap();
        let event = json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "Bash",
                    "input": { "command": "mkdir -p /tmp/ultrafuzz-agent-scratch" }
                }]
            }
        })
        .to_string();
        let script = write_script(
            temp.path(),
            "fake-claude",
            &format!(
                "#!/bin/sh\nprintf '%s\\n' '{}'\nprintf '[]\\n' > \"$ULTRAFUZZ_OUTPUT_FINDINGS_PATH\"\n",
                event
            ),
        );
        let input = input(&temp);
        let backend =
            ClaudeCodeCliBackend::new(bypass_backend_config(BackendKind::ClaudeCodeCli, script));

        let error = backend.run(input.clone()).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("/tmp/ultrafuzz-agent-scratch"));
        assert!(error.to_string().contains("outside allowed roots"));
        assert!(input.output_metadata_path.exists());
    }

    #[test]
    fn claude_streamed_file_tool_uses_reject_backend_internal_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let backend_state_path = input
            .artifact_dir
            .join("claude-config/projects/session.jsonl");
        let event = json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "Read",
                    "input": { "file_path": backend_state_path }
                }]
            }
        })
        .to_string();
        let script = write_script(
            temp.path(),
            "fake-claude",
            &format!(
                "#!/bin/sh\nprintf '%s\\n' '{}'\nprintf '[]\\n' > \"$ULTRAFUZZ_OUTPUT_FINDINGS_PATH\"\n",
                event
            ),
        );
        let backend =
            ClaudeCodeCliBackend::new(bypass_backend_config(BackendKind::ClaudeCodeCli, script));

        let error = backend.run(input.clone()).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error.to_string().contains("Read"));
        assert!(error
            .to_string()
            .contains("backend-internal artifact state"));
        assert!(input.output_metadata_path.exists());
    }

    #[test]
    fn wait_result_permission_policy_error_preserves_formatted_metadata_message() {
        let message =
            "backend-permission-policy-rejected: Read path `/tmp/task.out` is outside allowed roots"
                .to_owned();
        let wait_result = WaitResult {
            exit_status: None,
            timed_out: false,
            error_kind: Some(AgentErrorKind::BackendPermissionPolicyRejected),
            error_message: Some(message.clone()),
        };

        let error = wait_result_permission_policy_error(&wait_result).unwrap();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert_eq!(error.to_string(), message);
    }

    #[test]
    fn claude_streamed_file_tool_uses_reject_outside_absolute_paths_live() {
        let temp = tempfile::tempdir().unwrap();
        let event = json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "Read",
                    "input": {
                        "file_path": "/tmp/claude-1000/tasks/build.output"
                    }
                }]
            }
        })
        .to_string();
        let script = write_script(
            temp.path(),
            "fake-claude",
            &format!(
                "#!/bin/sh\nprintf '%s\\n' '{}'\nsleep 5\nprintf '[]\\n' > \"$ULTRAFUZZ_OUTPUT_FINDINGS_PATH\"\n",
                event
            ),
        );
        let mut input = input(&temp);
        input.timeout = Duration::from_millis(500);
        let backend =
            ClaudeCodeCliBackend::new(bypass_backend_config(BackendKind::ClaudeCodeCli, script));

        let error = backend.run(input.clone()).unwrap_err();

        assert_eq!(error.code(), "backend-permission-policy-rejected");
        assert!(error
            .to_string()
            .contains("/tmp/claude-1000/tasks/build.output"));
        assert!(error.to_string().contains("outside allowed roots"));
        let metadata: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(input.output_metadata_path).unwrap()).unwrap();
        assert_eq!(metadata["timed_out"], false);
        assert_eq!(
            metadata["error_class"],
            "backend-permission-policy-rejected"
        );
        let error_message = error.to_string();
        assert_eq!(metadata["error"].as_str(), Some(error_message.as_str()));
    }

    #[test]
    fn file_tools_keep_dependency_artifacts_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let mut input = input(&temp);
        let dependency_dir = temp.path().join("artifacts/property-specification-fanin");
        fs::create_dir_all(&dependency_dir).unwrap();
        let dependency_artifact = dependency_dir.join("properties.md");
        fs::write(&dependency_artifact, "# properties\n").unwrap();
        input.extra_context_dirs.push(dependency_dir);

        validate_tool_file_path("Read", dependency_artifact.to_str().unwrap(), &input).unwrap();
        let error = validate_tool_file_path("Edit", dependency_artifact.to_str().unwrap(), &input)
            .unwrap_err();

        assert!(error.contains("outside allowed roots"));
        validate_tool_file_path(
            "Edit",
            input.artifact_dir.join("findings.json").to_str().unwrap(),
            &input,
        )
        .unwrap();
    }

    #[test]
    fn file_tools_keep_run_artifact_parent_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let mut input = input(&temp);
        let run_artifacts_dir = temp.path().join("artifacts");
        let dependency_dir = run_artifacts_dir.join("property-specification-fanin");
        fs::create_dir_all(&dependency_dir).unwrap();
        let dependency_artifact = dependency_dir.join("properties.md");
        fs::write(&dependency_artifact, "# properties\n").unwrap();
        input.extra_context_dirs.push(run_artifacts_dir);

        validate_tool_file_path("Read", dependency_artifact.to_str().unwrap(), &input).unwrap();
        let error = validate_tool_file_path("Edit", dependency_artifact.to_str().unwrap(), &input)
            .unwrap_err();

        assert!(error.contains("outside allowed roots"));
    }

    #[test]
    fn bash_read_only_commands_may_inspect_dependency_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let mut input = input(&temp);
        let dependency_dir = temp.path().join("artifacts/property-specification-fanin");
        fs::create_dir_all(&dependency_dir).unwrap();
        let dependency_artifact = dependency_dir.join("properties.md");
        fs::write(&dependency_artifact, "# properties\n").unwrap();
        input.extra_context_dirs.push(dependency_dir);

        validate_bash_absolute_paths(&format!("cat {}", dependency_artifact.display()), &input)
            .unwrap();
        validate_bash_absolute_paths(
            &format!("jq empty {}", dependency_artifact.display()),
            &input,
        )
        .unwrap();

        let error = validate_bash_absolute_paths(
            &format!("forge test {}", dependency_artifact.display()),
            &input,
        )
        .unwrap_err();
        assert!(error.contains("outside allowed roots"));

        let error = validate_bash_absolute_paths(
            &format!("sed -i {}", dependency_artifact.display()),
            &input,
        )
        .unwrap_err();
        assert!(error.contains("outside allowed roots"));
    }

    #[test]
    fn bash_cp_may_copy_from_dependency_artifacts_to_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let mut input = input(&temp);
        let dependency_dir = temp.path().join("artifacts/reference-harness-author");
        fs::create_dir_all(&dependency_dir).unwrap();
        let dependency_artifact = dependency_dir.join("BitmapSearchDifferential.t.sol");
        let workspace_destination = input
            .workspace_path
            .join("test/foundry/reference-harness-author/attempt-0/BitmapSearchDifferential.t.sol");
        fs::write(
            &dependency_artifact,
            "contract BitmapSearchDifferential {}\n",
        )
        .unwrap();
        input.extra_context_dirs.push(dependency_dir);

        validate_bash_absolute_paths(
            &format!(
                "cp {} {}",
                dependency_artifact.display(),
                workspace_destination.display()
            ),
            &input,
        )
        .unwrap();

        let error = validate_bash_absolute_paths(
            &format!(
                "cp {} {}",
                workspace_destination.display(),
                dependency_artifact.display()
            ),
            &input,
        )
        .unwrap_err();
        assert!(error.contains("outside allowed roots"));
    }

    #[test]
    fn bash_read_only_commands_may_inspect_run_artifact_parent() {
        let temp = tempfile::tempdir().unwrap();
        let mut input = input(&temp);
        let run_artifacts_dir = temp.path().join("artifacts");
        let dependency_dir = run_artifacts_dir.join("property-specification-fanin");
        fs::create_dir_all(&dependency_dir).unwrap();
        let dependency_artifact = dependency_dir.join("properties.md");
        fs::write(&dependency_artifact, "# properties\n").unwrap();
        input.extra_context_dirs.push(run_artifacts_dir.clone());

        validate_bash_absolute_paths(&format!("ls {}", run_artifacts_dir.display()), &input)
            .unwrap();
        validate_bash_absolute_paths(&format!("cat {}", dependency_artifact.display()), &input)
            .unwrap();

        let error = validate_bash_absolute_paths(
            &format!("forge test {}", dependency_artifact.display()),
            &input,
        )
        .unwrap_err();
        assert!(error.contains("outside allowed roots"));
    }

    #[test]
    fn bash_absolute_path_scope_allows_workspace_and_run_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let command = format!(
            "ls -la {} && jq empty {}",
            input.workspace_path.join("contracts").display(),
            input.artifact_dir.join("findings.json").display()
        );

        validate_bash_absolute_paths(&command, &input).unwrap();
    }

    #[test]
    fn bash_absolute_path_scope_rejects_parent_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let command = format!("ls -la {}/../outside", input.workspace_path.display());

        let error = validate_bash_absolute_paths(&command, &input).unwrap_err();

        assert!(error.contains("contains `..`"));
    }

    #[test]
    fn bash_absolute_path_scope_allows_resolved_parent_path_under_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let workspace_test = input
            .workspace_path
            .join("test/foundry/final-report/attempt-0/PoC.t.sol");
        fs::create_dir_all(workspace_test.parent().unwrap()).unwrap();
        fs::write(&workspace_test, "contract PoC {}\n").unwrap();
        let artifact_relative_workspace_path = input
            .artifact_dir
            .join("../../workspace/test/foundry/final-report/attempt-0/PoC.t.sol");

        validate_bash_absolute_paths(
            &format!("ls -la {}", artifact_relative_workspace_path.display()),
            &input,
        )
        .unwrap();
    }

    #[test]
    fn bash_absolute_path_scope_rejects_resolved_parent_path_outside_roots() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, "outside\n").unwrap();
        let escaping_path = input.workspace_path.join("../outside.txt");

        let error =
            validate_bash_absolute_paths(&format!("ls -la {}", escaping_path.display()), &input)
                .unwrap_err();

        assert!(error.contains("outside allowed roots"));
    }

    #[test]
    fn bash_path_scope_rejects_relative_parent_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);

        let error =
            validate_bash_absolute_paths("cat ../other-node/findings.json", &input).unwrap_err();

        assert!(error.contains("relative path `../other-node/findings.json` contains `..`"));
    }

    #[test]
    fn bash_path_scope_rejects_relative_parent_path_lists() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);

        let error = validate_bash_absolute_paths(
            "NODE_PATH=node_modules:../other-node node --version",
            &input,
        )
        .unwrap_err();

        assert!(error.contains("relative path `../other-node` contains `..`"));
    }

    #[test]
    fn read_tool_allows_resolved_parent_path_under_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let workspace_test = input
            .workspace_path
            .join("test/foundry/final-report/attempt-0/PoC.t.sol");
        fs::create_dir_all(workspace_test.parent().unwrap()).unwrap();
        fs::write(&workspace_test, "contract PoC {}\n").unwrap();
        let artifact_relative_workspace_path = input
            .artifact_dir
            .join("../../workspace/test/foundry/final-report/attempt-0/PoC.t.sol");
        let path = artifact_relative_workspace_path.to_str().unwrap();

        validate_tool_file_path("Read", path, &input).unwrap();
        let error = validate_tool_file_path("Edit", path, &input).unwrap_err();

        assert!(error.contains("contains `..`"));
    }

    #[test]
    fn bash_path_scope_allows_non_path_parent_like_patterns() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);

        validate_bash_absolute_paths(r#"grep -rn "a..b" README.md"#, &input).unwrap();
    }

    #[test]
    fn bash_absolute_path_scope_rejects_backend_internal_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let command = format!(
            "rm -f {}",
            input
                .artifact_dir
                .join("claude-config/projects/session.jsonl")
                .display()
        );

        let error = validate_bash_absolute_paths(&command, &input).unwrap_err();

        assert!(error.contains("backend-internal artifact state"));
    }

    #[test]
    fn bash_absolute_path_scope_rejects_backend_tool_results() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let command = format!(
            "grep -c \"Error\" {}",
            input
                .artifact_dir
                .join("claude-config/projects/session/tool-results/result.txt")
                .display()
        );

        let error = validate_bash_absolute_paths(&command, &input).unwrap_err();

        assert!(error.contains("backend-internal artifact state"));
    }

    #[test]
    fn bash_absolute_path_scope_rejects_non_tool_result_backend_internal_paths() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let command = format!(
            "grep -rn Error {}",
            input
                .artifact_dir
                .join("claude-config/projects/session.jsonl")
                .display()
        );

        let error = validate_bash_absolute_paths(&command, &input).unwrap_err();

        assert!(error.contains("backend-internal artifact state"));
    }

    #[test]
    fn bash_absolute_path_scope_ignores_quoted_jq_filter_slashes() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);
        let command = format!(
            "jq -r '([.recipes[].id] | unique) as $ids | ([.coverage_priorities[] | (.recipes // []), ((.categories // {{}}) | to_entries[].value)] | add | unique) as $refs | ($refs - $ids)' {}",
            input.artifact_dir.join("boundary-recipes.json").display()
        );

        validate_bash_absolute_paths(&command, &input).unwrap();
    }

    #[test]
    fn bash_absolute_path_scope_ignores_sed_substitution_delimiters() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);

        validate_bash_absolute_paths(
            "grep -rn \"describe(\" test/*.js test/integration/*.js | sed 's/describe(/DESC:/' | head -80",
            &input,
        )
        .unwrap();
    }

    #[test]
    fn bash_absolute_path_scope_rejects_quoted_outside_absolute_paths() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);

        let error =
            validate_bash_absolute_paths("cat '/tmp/ultrafuzz-agent-scratch'", &input).unwrap_err();

        assert!(error.contains("outside allowed roots"));
    }

    #[test]
    fn bash_absolute_path_scope_rejects_assignment_path_list_outside_roots() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);

        let error = validate_bash_absolute_paths(
            "NODE_PATH=node_modules:/tmp/ultrafuzz-agent-scratch node --version",
            &input,
        )
        .unwrap_err();

        assert!(error.contains("/tmp/ultrafuzz-agent-scratch"));
        assert!(error.contains("outside allowed roots"));
    }

    #[test]
    fn bash_absolute_path_scope_ignores_url_patterns() {
        let temp = tempfile::tempdir().unwrap();
        let input = input(&temp);

        validate_bash_absolute_paths(r#"grep -rn "https://" README.md"#, &input).unwrap();
    }

    #[test]
    fn doctor_reports_missing_backend_clearly() {
        let config = bypass_backend_config(
            BackendKind::ClaudeCodeCli,
            "definitely-not-an-ultrafuzz-backend",
        );
        let doctor = ClaudeCodeCliBackend::new(config).doctor().unwrap();

        assert_eq!(doctor.availability, BackendAvailability::CommandNotFound);
        assert!(doctor.message.as_deref().unwrap().contains("was not found"));
        assert!(doctor
            .checks
            .iter()
            .any(|check| check.status == BackendDoctorCheckStatus::Fail));
    }

    #[test]
    fn doctor_detects_project_permission_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("AGENTS.md"), "rules\n").unwrap();
        let mut config = backend_config(BackendKind::CodexCli, "codex");
        config.project_root = temp.path().to_path_buf();

        let doctor = CodexCliBackend::new(config).doctor().unwrap();

        assert_eq!(doctor.project_permission_files.len(), 1);
        assert!(doctor.project_permission_files[0].ends_with("AGENTS.md"));
    }

    fn write_script(dir: &Path, name: &str, contents: &str) -> String {
        let path = dir.join(name);
        let mut file = File::create(&path).unwrap();
        file.write_all(contents.as_bytes()).unwrap();
        file.flush().unwrap();
        file.sync_all().unwrap();
        drop(file);
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
        path.display().to_string()
    }

    #[cfg(all(unix, target_os = "linux"))]
    fn assert_process_exits(pid: i32) {
        let proc_path = PathBuf::from("/proc").join(pid.to_string());
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            if !proc_path.exists() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        panic!("process {pid} survived backend timeout cleanup");
    }

    #[cfg(all(unix, target_os = "linux"))]
    fn read_pid_file_within(path: &Path, timeout: Duration) -> i32 {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if let Ok(contents) = fs::read_to_string(path) {
                if let Ok(pid) = contents.trim().parse::<i32>() {
                    return pid;
                }
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("pid file `{}` was not written", path.display());
    }
}
