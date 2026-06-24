use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    str::FromStr,
    time::Duration,
};
use thiserror::Error;
use ultrafuzz_core::{
    BackendKind, BuiltInStrategy, ModelProfile, ModelProfileId, StrategyCategory,
    StrategyDefinition, WorkspaceMode,
};

pub const DEFAULT_MODEL_PROFILE_ID: &str = "default";

pub const CONFIG_FILE_NAME: &str = "ultrafuzz.toml";
pub const DEFAULT_DYNAMIC_STRATEGIES_ENUMERATOR: usize = 3;
pub const DEFAULT_TRIAGE_QUORUM: usize = 3;
pub const DEFAULT_TRIAGE_PANEL_SIZE: usize = 5;
pub const DEFAULT_INVARIANT_TESTING_FUZZER_TIMEOUT_SECONDS: u64 = 60 * 60;
const HIGH_INVARIANT_PRIORITIES: &[&str] = &["high"];
const MEDIUM_INVARIANT_PRIORITIES: &[&str] = &["high", "medium"];
const LOW_INVARIANT_PRIORITIES: &[&str] = &["high", "medium", "low"];
pub const DEFAULT_SENSITIVE_READ_DENY: &[&str] = &[
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    "secrets/**",
    ".secrets/**",
    ".ssh/**",
    ".aws/**",
    ".gcloud/**",
    ".azure/**",
    "*.pem",
    "*.key",
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CampaignConfig {
    pub schema_version: String,
    pub dynamic_strategies_enumerator: usize,
    pub project: ProjectConfig,
    pub run: RunConfig,
    pub backend: BackendConfig,
    pub models: ModelProfileConfigs,
    pub permissions: PermissionConfig,
    pub tools: ToolPolicyConfig,
    pub strategies: StrategyConfigs,
    pub invariants: InvariantConfig,
    pub triage: TriageConfig,
    pub dashboard: DashboardConfig,
}

impl CampaignConfig {
    pub fn enabled_strategies(&self) -> Vec<&StrategyDefinition> {
        self.strategies
            .definitions
            .iter()
            .filter(|strategy| strategy.enabled)
            .collect()
    }

    pub fn model_profile(&self, id: &ModelProfileId) -> Option<&ModelProfile> {
        self.models
            .profiles
            .iter()
            .find(|profile| &profile.id == id)
    }

    pub fn default_model_profile(&self) -> Option<&ModelProfile> {
        self.model_profile(&self.models.default)
    }

    pub fn effective_strategy_models(&self, strategy: &StrategyDefinition) -> Vec<ModelProfileId> {
        if strategy.models.is_empty() {
            vec![self.models.default.clone()]
        } else {
            strategy.models.clone()
        }
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        let mut errors = Vec::new();

        if self.run.max_parallel_agents == 0 {
            errors.push("run.max_parallel_agents must be greater than zero".to_owned());
        }
        if self.dynamic_strategies_enumerator == 0 {
            errors.push("dynamic_strategies_enumerator must be greater than zero".to_owned());
        }
        if self.run.max_parallel_nodes == 0 {
            errors.push("run.max_parallel_nodes must be greater than zero".to_owned());
        }
        if self.run.default_timeout_seconds == 0 {
            errors.push("run.default_timeout_seconds must be greater than zero".to_owned());
        }
        if self.run.output_dir.as_os_str().is_empty() {
            errors.push("run.output_dir cannot be empty".to_owned());
        } else {
            validate_project_local_path("run.output_dir", &self.run.output_dir, &mut errors);
        }
        validate_project_local_path("project.repo", &self.project.repo, &mut errors);
        if !self.run.output_dir.as_os_str().is_empty()
            && self.run.output_dir.exists()
            && !self.run.output_dir.is_dir()
        {
            errors.push(format!(
                "run.output_dir `{}` exists but is not a directory",
                self.run.output_dir.display()
            ));
        }
        if self.strategies.definitions.is_empty() {
            errors.push("at least one strategy must be configured".to_owned());
        }
        if self.invariants.invariant_testing_fuzzer_timeout_seconds == 0 {
            errors.push(
                "invariants.invariant_testing_fuzzer_timeout must be greater than zero".to_owned(),
            );
        }
        if self.triage.quorum == 0 {
            errors.push("triage.quorum must be greater than zero".to_owned());
        }
        if self.triage.panel_size == 0 {
            errors.push("triage.panel_size must be greater than zero".to_owned());
        }
        if self.triage.quorum > self.triage.panel_size {
            errors.push(format!(
                "triage.quorum ({}) cannot be greater than triage.panel_size ({})",
                self.triage.quorum, self.triage.panel_size
            ));
        }

        let mut model_ids = BTreeSet::new();
        for profile in &self.models.profiles {
            if !model_ids.insert(profile.id.clone()) {
                errors.push(format!("duplicate model profile id `{}`", profile.id));
            }
            if !valid_profile_id(profile.id.as_str()) {
                errors.push(format!(
                    "model profile id `{}` must use ASCII letters, digits, hyphen, underscore, or dot",
                    profile.id
                ));
            }
            if profile
                .model
                .as_deref()
                .is_some_and(|model| model.trim().is_empty())
            {
                errors.push(format!(
                    "model profile `{}` model cannot be an empty string",
                    profile.id
                ));
            }
            if !self.permissions.allow_dangerous_bypass {
                if let Some(reason) = backend_args_policy_error(profile.backend, &profile.args) {
                    errors.push(format!("model profile `{}` {reason}", profile.id));
                }
                collect_dangerous_env_errors(
                    &format!("model profile `{}` env", profile.id),
                    &profile.env,
                    &mut errors,
                );
            }
        }
        if !model_ids.contains(&self.models.default) {
            errors.push(format!(
                "models.default references unknown model profile `{}`",
                self.models.default
            ));
        }

        let mut strategy_ids = BTreeSet::new();
        for strategy in &self.strategies.definitions {
            if !strategy_ids.insert(strategy.id.clone()) {
                errors.push(format!("duplicate strategy id `{}`", strategy.id));
            }
            if strategy.enabled && strategy.loops == 0 {
                errors.push(format!(
                    "enabled strategy `{}` must have loops greater than zero",
                    strategy.id
                ));
            }
            if strategy.enabled && strategy.timeout.is_zero() {
                errors.push(format!(
                    "enabled strategy `{}` must have a positive timeout",
                    strategy.id
                ));
            }
            let mut seen_strategy_models = BTreeSet::new();
            for model_id in &strategy.models {
                if !seen_strategy_models.insert(model_id.clone()) {
                    errors.push(format!(
                        "strategy `{}` lists model profile `{}` more than once",
                        strategy.id, model_id
                    ));
                }
                if !model_ids.contains(model_id) {
                    errors.push(format!(
                        "strategy `{}` references unknown model profile `{}`",
                        strategy.id, model_id
                    ));
                }
            }
        }

        for required in DEFAULT_SENSITIVE_READ_DENY {
            if !self
                .permissions
                .read_deny
                .iter()
                .any(|pattern| pattern.as_str() == *required)
            {
                errors.push(format!(
                    "permissions.read_deny must include sensitive pattern `{required}`"
                ));
            }
        }

        if !self.permissions.allow_dangerous_bypass {
            if is_dangerous_sandbox_mode(&self.permissions.sandbox) {
                errors.push(format!(
                    "permissions.sandbox `{}` requests a dangerous bypass mode; set permissions.allow_dangerous_bypass = true to allow it",
                    self.permissions.sandbox
                ));
            }
            for (label, kind, cli) in [
                (
                    "backend.codex_cli",
                    BackendKind::CodexCli,
                    &self.backend.codex_cli,
                ),
                (
                    "backend.claude_code_cli",
                    BackendKind::ClaudeCodeCli,
                    &self.backend.claude_code_cli,
                ),
            ] {
                if let Some(reason) = backend_command_validation_error(kind, &cli.command, false) {
                    errors.push(format!("{label}.command {reason}"));
                }
                if let Some(reason) = backend_args_policy_error(kind, &cli.args) {
                    errors.push(format!("{label}.args {reason}"));
                }
                collect_dangerous_env_errors(&format!("{label}.env"), &cli.env, &mut errors);
            }
        } else {
            for (label, kind, command) in [
                (
                    "backend.codex_cli",
                    BackendKind::CodexCli,
                    &self.backend.codex_cli.command,
                ),
                (
                    "backend.claude_code_cli",
                    BackendKind::ClaudeCodeCli,
                    &self.backend.claude_code_cli.command,
                ),
            ] {
                if let Some(reason) = backend_command_validation_error(kind, command, true) {
                    errors.push(format!("{label}.command {reason}"));
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(ConfigError::Validation(errors))
        }
    }

    pub fn redacted(&self) -> Self {
        let mut redacted = self.clone();
        redact_sensitive_value(&mut redacted.backend.codex_cli.command);
        redact_sensitive_value(&mut redacted.backend.claude_code_cli.command);
        redact_args(&mut redacted.backend.codex_cli.args);
        redact_args(&mut redacted.backend.claude_code_cli.args);
        redact_env_map(&mut redacted.backend.codex_cli.env);
        redact_env_map(&mut redacted.backend.claude_code_cli.env);
        for profile in &mut redacted.models.profiles {
            redact_args(&mut profile.args);
            redact_env_map(&mut profile.env);
        }
        redacted
    }

    pub fn dump_redacted_toml(&self) -> Result<String, ConfigError> {
        dump_config_toml(&self.redacted())
    }

    pub fn dump_toml(&self) -> Result<String, ConfigError> {
        dump_config_toml(self)
    }

    pub fn validate_project_paths(
        &self,
        project_root: impl AsRef<Path>,
    ) -> Result<(), ConfigError> {
        let project_root = project_root.as_ref();
        resolve_project_path(project_root, "project.repo", &self.project.repo)?;
        resolve_project_path(project_root, "run.output_dir", &self.run.output_dir)?;
        Ok(())
    }
}

impl Default for CampaignConfig {
    fn default() -> Self {
        Self {
            schema_version: "1.0".to_owned(),
            dynamic_strategies_enumerator: DEFAULT_DYNAMIC_STRATEGIES_ENUMERATOR,
            project: ProjectConfig::default(),
            run: RunConfig::default(),
            backend: BackendConfig::default(),
            models: ModelProfileConfigs::from_backend(&BackendConfig::default()),
            permissions: PermissionConfig::default(),
            tools: ToolPolicyConfig::default(),
            strategies: StrategyConfigs::default(),
            invariants: InvariantConfig::default(),
            triage: TriageConfig::default(),
            dashboard: DashboardConfig::default(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub repo: PathBuf,
    pub name: Option<String>,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            repo: PathBuf::from("."),
            name: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RunConfig {
    pub output_dir: PathBuf,
    pub max_parallel_agents: usize,
    pub max_parallel_nodes: usize,
    pub keep_workspaces: bool,
    pub workspace_mode: WorkspaceMode,
    pub default_timeout_seconds: u64,
    pub enable_dashboard: bool,
}

impl Default for RunConfig {
    fn default() -> Self {
        Self {
            output_dir: PathBuf::from(".ultrafuzz/runs"),
            max_parallel_agents: 4,
            max_parallel_nodes: 8,
            keep_workspaces: false,
            workspace_mode: WorkspaceMode::GitWorktree,
            default_timeout_seconds: 1_800,
            enable_dashboard: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendConfig {
    pub default: BackendKind,
    pub codex_cli: BackendCliConfig,
    pub claude_code_cli: BackendCliConfig,
}

impl Default for BackendConfig {
    fn default() -> Self {
        Self {
            default: BackendKind::CodexCli,
            codex_cli: BackendCliConfig {
                command: "codex".to_owned(),
                auth_mode: "cli-session".to_owned(),
                use_project_config: true,
                args: vec!["exec".to_owned()],
                env: BTreeMap::new(),
            },
            claude_code_cli: BackendCliConfig {
                command: "claude".to_owned(),
                auth_mode: "cli-session".to_owned(),
                use_project_config: true,
                args: Vec::new(),
                env: BTreeMap::new(),
            },
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendCliConfig {
    pub command: String,
    pub auth_mode: String,
    pub use_project_config: bool,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelProfileConfigs {
    pub default: ModelProfileId,
    pub profiles: Vec<ModelProfile>,
    #[serde(skip)]
    synthesized_default: bool,
}

impl ModelProfileConfigs {
    fn from_backend(backend: &BackendConfig) -> Self {
        Self {
            default: ModelProfileId::from(DEFAULT_MODEL_PROFILE_ID),
            profiles: vec![ModelProfile {
                id: ModelProfileId::from(DEFAULT_MODEL_PROFILE_ID),
                backend: backend.default,
                model: None,
                args: Vec::new(),
                env: BTreeMap::new(),
            }],
            synthesized_default: true,
        }
    }

    fn insert_or_replace(&mut self, profile: ModelProfile) {
        if let Some(existing) = self
            .profiles
            .iter_mut()
            .find(|existing| existing.id == profile.id)
        {
            *existing = profile;
        } else {
            self.profiles.push(profile);
        }
        self.profiles.sort_by(|left, right| left.id.cmp(&right.id));
    }

    fn ensure_synthesized_default(&mut self, backend: &BackendConfig) {
        let default_id = ModelProfileId::from(DEFAULT_MODEL_PROFILE_ID);
        if !self.profiles.iter().any(|profile| profile.id == default_id) {
            self.profiles.push(ModelProfile {
                id: default_id,
                backend: backend.default,
                model: None,
                args: Vec::new(),
                env: BTreeMap::new(),
            });
            self.profiles.sort_by(|left, right| left.id.cmp(&right.id));
            self.synthesized_default = true;
        }
    }

    fn sync_default_profile_from_backend(&mut self, backend: &BackendConfig) {
        let default_id = ModelProfileId::from(DEFAULT_MODEL_PROFILE_ID);
        if self.default == default_id {
            self.ensure_synthesized_default(backend);
        }
        if self.synthesized_default {
            if let Some(profile) = self
                .profiles
                .iter_mut()
                .find(|profile| profile.id == default_id)
            {
                profile.backend = backend.default;
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PermissionConfig {
    pub profile: String,
    pub backend_policy: String,
    pub sandbox: String,
    pub sandbox_required: bool,
    pub approval_mode: String,
    pub network: String,
    pub allow_dangerous_bypass: bool,
    pub allow_target_repo_writes_during_attempts: bool,
    pub materialize_outputs_as_unstaged: bool,
    pub write_allow: Vec<String>,
    pub read_deny: Vec<String>,
}

impl Default for PermissionConfig {
    fn default() -> Self {
        Self {
            profile: "ultrafuzz-default".to_owned(),
            backend_policy: "reuse-project-config".to_owned(),
            sandbox: "workspace-write".to_owned(),
            sandbox_required: true,
            approval_mode: "preapproved-only".to_owned(),
            network: "disabled".to_owned(),
            allow_dangerous_bypass: false,
            allow_target_repo_writes_during_attempts: false,
            materialize_outputs_as_unstaged: true,
            write_allow: vec![
                "workspace".to_owned(),
                "artifacts".to_owned(),
                "extra-context".to_owned(),
                "final-materialization".to_owned(),
            ],
            read_deny: DEFAULT_SENSITIVE_READ_DENY
                .iter()
                .map(|pattern| (*pattern).to_owned())
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ToolPolicyConfig {
    pub commands: CommandPolicyCommands,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CommandPolicyCommands {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

impl CommandPolicyCommands {
    pub fn is_command_allowed(&self, command: &str) -> bool {
        self.evaluate(command).allowed
    }

    pub fn evaluate(&self, command: &str) -> CommandPolicyDecision {
        let command = command.trim();
        if command.is_empty() {
            return CommandPolicyDecision::rejected(
                command,
                CommandPolicyReason::EmptyCommand,
                None,
            );
        }

        let segments = match split_command_segments(command) {
            Ok(segments) => segments,
            Err(reason) => {
                return CommandPolicyDecision::rejected(
                    command,
                    CommandPolicyReason::UnsafeShellSyntax(reason),
                    None,
                );
            }
        };

        let mut allow_match = None;
        for segment in segments {
            if let Some(rule) = self
                .deny
                .iter()
                .find(|rule| command_matches_rule(&segment, rule))
            {
                return CommandPolicyDecision::rejected(
                    command,
                    CommandPolicyReason::DeniedByRule,
                    Some(rule.clone()),
                );
            }

            match self
                .allow
                .iter()
                .find(|rule| command_matches_rule(&segment, rule))
            {
                Some(rule) => {
                    allow_match.get_or_insert_with(|| rule.clone());
                }
                None => {
                    return CommandPolicyDecision::rejected(
                        command,
                        CommandPolicyReason::NotAllowlisted,
                        None,
                    );
                }
            }
        }

        CommandPolicyDecision {
            command: command.to_owned(),
            allowed: true,
            reason: CommandPolicyReason::Allowed,
            matched_rule: allow_match,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandPolicyDecision {
    pub command: String,
    pub allowed: bool,
    pub reason: CommandPolicyReason,
    pub matched_rule: Option<String>,
}

impl CommandPolicyDecision {
    fn rejected(command: &str, reason: CommandPolicyReason, matched_rule: Option<String>) -> Self {
        Self {
            command: command.to_owned(),
            allowed: false,
            reason,
            matched_rule,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandPolicyReason {
    Allowed,
    EmptyCommand,
    DeniedByRule,
    NotAllowlisted,
    UnsafeShellSyntax(String),
}

impl Default for CommandPolicyCommands {
    fn default() -> Self {
        Self {
            allow: vec![
                "forge".to_owned(),
                "cast".to_owned(),
                "anvil".to_owned(),
                "solc".to_owned(),
                "recon".to_owned(),
                "recon-generate".to_owned(),
                "recon-fuzz".to_owned(),
                "covg-eval".to_owned(),
                "covg_eval".to_owned(),
                "medusa".to_owned(),
                "echidna".to_owned(),
                "halmos".to_owned(),
                "npx".to_owned(),
                "node".to_owned(),
                "npm".to_owned(),
                "pip show".to_owned(),
                "git".to_owned(),
                "jq".to_owned(),
                "rg".to_owned(),
                "grep".to_owned(),
                "wc".to_owned(),
                "head".to_owned(),
                "tail".to_owned(),
                "sort".to_owned(),
                "uniq".to_owned(),
                "cat".to_owned(),
                "ls".to_owned(),
                "sed".to_owned(),
                "awk".to_owned(),
                "find".to_owned(),
                "pwd".to_owned(),
                "sha256sum".to_owned(),
                "timeout".to_owned(),
                "mkdir".to_owned(),
                "cp".to_owned(),
                "mv".to_owned(),
                "rm".to_owned(),
            ],
            deny: vec![
                "curl".to_owned(),
                "wget".to_owned(),
                "ssh".to_owned(),
                "scp".to_owned(),
                "nc".to_owned(),
                "netcat".to_owned(),
                "python -m http.server".to_owned(),
            ],
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StrategyConfigs {
    pub definitions: Vec<StrategyDefinition>,
}

impl Default for StrategyConfigs {
    fn default() -> Self {
        Self {
            definitions: BuiltInStrategy::ALL
                .into_iter()
                .map(StrategyDefinition::built_in)
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StrategyOverride {
    pub display_name: Option<String>,
    pub models: Option<Vec<ModelProfileId>>,
    pub loops: Option<usize>,
    pub enabled: Option<bool>,
    pub category: Option<StrategyCategory>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InvariantPropertyPriorityThreshold {
    #[default]
    High,
    Medium,
    Low,
}

impl InvariantPropertyPriorityThreshold {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }

    pub const fn included_priorities(self) -> &'static [&'static str] {
        match self {
            Self::High => HIGH_INVARIANT_PRIORITIES,
            Self::Medium => MEDIUM_INVARIANT_PRIORITIES,
            Self::Low => LOW_INVARIANT_PRIORITIES,
        }
    }

    pub fn included_priorities_csv(self) -> String {
        self.included_priorities().join(", ")
    }

    pub fn filter_description(self) -> &'static str {
        match self {
            Self::High => "high-priority properties only",
            Self::Medium => "high- and medium-priority properties",
            Self::Low => "all high-, medium-, and low-priority properties",
        }
    }
}

impl FromStr for InvariantPropertyPriorityThreshold {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "high" => Ok(Self::High),
            "medium" => Ok(Self::Medium),
            "low" => Ok(Self::Low),
            other => Err(format!(
                "invalid invariant property priority threshold `{other}`: expected one of `high`, `medium`, or `low`"
            )),
        }
    }
}

impl std::fmt::Display for InvariantPropertyPriorityThreshold {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct InvariantConfig {
    pub property_priority_threshold: InvariantPropertyPriorityThreshold,
    pub invariant_testing_fuzzer_timeout_seconds: u64,
}

impl Default for InvariantConfig {
    fn default() -> Self {
        Self {
            property_priority_threshold: InvariantPropertyPriorityThreshold::default(),
            invariant_testing_fuzzer_timeout_seconds:
                DEFAULT_INVARIANT_TESTING_FUZZER_TIMEOUT_SECONDS,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TriageConfig {
    pub quorum: usize,
    pub panel_size: usize,
}

impl Default for TriageConfig {
    fn default() -> Self {
        Self {
            quorum: DEFAULT_TRIAGE_QUORUM,
            panel_size: DEFAULT_TRIAGE_PANEL_SIZE,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashboardConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub open_browser: bool,
    pub live_updates: bool,
    pub event_store: String,
}

impl Default for DashboardConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            host: "127.0.0.1".to_owned(),
            port: 3_875,
            open_browser: false,
            live_updates: true,
            event_store: "sqlite".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EnvOverrides {
    pub backend: Option<BackendKind>,
    pub max_parallel_agents: Option<usize>,
    pub max_parallel_nodes: Option<usize>,
    pub output_dir: Option<PathBuf>,
    pub keep_workspaces: Option<bool>,
    pub codex_cli_env: BTreeMap<String, String>,
    pub claude_code_cli_env: BTreeMap<String, String>,
}

impl EnvOverrides {
    pub fn from_env() -> Result<Self, ConfigError> {
        let backend = parse_optional_env("ULTRAFUZZ_BACKEND", |value| {
            BackendKind::from_str(value).map_err(|err| err.to_string())
        })?;
        let max_parallel_agents =
            parse_optional_env("ULTRAFUZZ_MAX_PARALLEL_AGENTS", parse_usize_env)?;
        let max_parallel_nodes =
            parse_optional_env("ULTRAFUZZ_MAX_PARALLEL_NODES", parse_usize_env)?;
        let output_dir = std::env::var_os("ULTRAFUZZ_OUTPUT_DIR").map(PathBuf::from);
        let keep_workspaces = parse_optional_env("ULTRAFUZZ_KEEP_WORKSPACES", parse_bool_env)?;
        let codex_cli_env = backend_env_passthrough("ULTRAFUZZ_CODEX_ENV_PASSTHROUGH")?;
        let claude_code_cli_env = backend_env_passthrough("ULTRAFUZZ_CLAUDE_ENV_PASSTHROUGH")?;

        Ok(Self {
            backend,
            max_parallel_agents,
            max_parallel_nodes,
            output_dir,
            keep_workspaces,
            codex_cli_env,
            claude_code_cli_env,
        })
    }

    pub fn apply_to(self, config: &mut CampaignConfig) {
        if let Some(backend) = self.backend {
            config.backend.default = backend;
        }
        if let Some(max_parallel_agents) = self.max_parallel_agents {
            config.run.max_parallel_agents = max_parallel_agents;
        }
        if let Some(max_parallel_nodes) = self.max_parallel_nodes {
            config.run.max_parallel_nodes = max_parallel_nodes;
        }
        if let Some(output_dir) = self.output_dir {
            config.run.output_dir = output_dir;
        }
        if let Some(keep_workspaces) = self.keep_workspaces {
            config.run.keep_workspaces = keep_workspaces;
        }
        let codex_cli_env = self.codex_cli_env;
        let claude_code_cli_env = self.claude_code_cli_env;
        config.backend.codex_cli.env.extend(codex_cli_env.clone());
        config
            .backend
            .claude_code_cli
            .env
            .extend(claude_code_cli_env.clone());
        for profile in &mut config.models.profiles {
            match profile.backend {
                BackendKind::CodexCli => profile.env.extend(codex_cli_env.clone()),
                BackendKind::ClaudeCodeCli => profile.env.extend(claude_code_cli_env.clone()),
            }
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CliOverrides {
    pub backend: Option<BackendKind>,
    pub max_parallel_agents: Option<usize>,
    pub max_parallel_nodes: Option<usize>,
    pub dynamic_strategies_enumerator: Option<usize>,
    pub triage_quorum: Option<usize>,
    pub triage_panel_size: Option<usize>,
    pub invariant_property_priority_threshold: Option<InvariantPropertyPriorityThreshold>,
    pub invariant_testing_fuzzer_timeout_seconds: Option<u64>,
}

impl CliOverrides {
    pub fn apply_to(self, config: &mut CampaignConfig) {
        if let Some(backend) = self.backend {
            config.backend.default = backend;
        }
        if let Some(max_parallel_agents) = self.max_parallel_agents {
            config.run.max_parallel_agents = max_parallel_agents;
        }
        if let Some(max_parallel_nodes) = self.max_parallel_nodes {
            config.run.max_parallel_nodes = max_parallel_nodes;
        }
        if let Some(dynamic_strategies_enumerator) = self.dynamic_strategies_enumerator {
            config.dynamic_strategies_enumerator = dynamic_strategies_enumerator;
        }
        if let Some(triage_quorum) = self.triage_quorum {
            config.triage.quorum = triage_quorum;
        }
        if let Some(triage_panel_size) = self.triage_panel_size {
            config.triage.panel_size = triage_panel_size;
        }
        if let Some(threshold) = self.invariant_property_priority_threshold {
            config.invariants.property_priority_threshold = threshold;
        }
        if let Some(timeout_seconds) = self.invariant_testing_fuzzer_timeout_seconds {
            config.invariants.invariant_testing_fuzzer_timeout_seconds = timeout_seconds;
        }
    }
}

pub fn default_config_toml() -> &'static str {
    include_str!("default-ultrafuzz.toml")
}

pub fn parse_invariant_testing_fuzzer_timeout_seconds(value: &str) -> Result<u64, String> {
    let duration = humantime::parse_duration(value.trim())
        .map_err(|_| invalid_invariant_timeout_message(value))?;
    if duration.is_zero() || duration.subsec_nanos() != 0 {
        return Err(invalid_invariant_timeout_message(value));
    }
    Ok(duration.as_secs())
}

pub fn format_invariant_testing_fuzzer_timeout(seconds: u64) -> String {
    if seconds.is_multiple_of(60 * 60) {
        format!("{}h", seconds / (60 * 60))
    } else if seconds.is_multiple_of(60) {
        format!("{}min", seconds / 60)
    } else {
        format!("{seconds}s")
    }
}

fn invalid_invariant_timeout_message(value: &str) -> String {
    format!(
        "invalid invariant testing fuzzer timeout `{}`: expected a positive duration like `30min`, `1800s`, or `1h`",
        value.trim()
    )
}

pub fn load_resolved_config(
    repo_root: impl AsRef<Path>,
    strategy_definitions: Vec<StrategyDefinition>,
    env_overrides: EnvOverrides,
    cli_overrides: CliOverrides,
) -> Result<CampaignConfig, ConfigError> {
    let repo_root = repo_root.as_ref();
    let config_path = repo_root.join(CONFIG_FILE_NAME);
    let toml = if config_path.exists() {
        Some(fs::read_to_string(&config_path)?)
    } else {
        None
    };

    let config = resolve_config_from_toml(
        toml.as_deref(),
        strategy_definitions,
        env_overrides,
        cli_overrides,
    )?;
    config.validate_project_paths(repo_root)?;
    Ok(config)
}

pub fn resolve_config_from_toml(
    toml: Option<&str>,
    strategy_definitions: Vec<StrategyDefinition>,
    env_overrides: EnvOverrides,
    cli_overrides: CliOverrides,
) -> Result<CampaignConfig, ConfigError> {
    let mut config = CampaignConfig::default();
    if !strategy_definitions.is_empty() {
        config.strategies.definitions = strategy_definitions;
    }
    if let Some(toml) = toml {
        let file_config: FileCampaignConfig = toml::from_str(toml)?;
        apply_file_config(&mut config, file_config)?;
    }
    env_overrides.apply_to(&mut config);
    cli_overrides.apply_to(&mut config);
    config
        .models
        .sync_default_profile_from_backend(&config.backend);
    config.validate()?;
    Ok(config)
}

pub fn write_default_config(
    repo_root: impl AsRef<Path>,
    force: bool,
) -> Result<ConfigScaffoldReport, ConfigError> {
    let path = repo_root.as_ref().join(CONFIG_FILE_NAME);
    if path.exists() && !force {
        return Ok(ConfigScaffoldReport {
            written: None,
            skipped: Some(path),
        });
    }

    fs::write(&path, default_config_toml())?;
    Ok(ConfigScaffoldReport {
        written: Some(path),
        skipped: None,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigScaffoldReport {
    pub written: Option<PathBuf>,
    pub skipped: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileCampaignConfig {
    schema_version: Option<String>,
    dynamic_strategies_enumerator: Option<usize>,
    project: Option<FileProjectConfig>,
    run: Option<FileRunConfig>,
    backend: Option<FileBackendConfig>,
    models: Option<toml::Value>,
    permissions: Option<FilePermissionConfig>,
    tools: Option<FileToolPolicyConfig>,
    #[serde(default)]
    strategies: BTreeMap<String, StrategyOverride>,
    invariants: Option<FileInvariantConfig>,
    triage: Option<FileTriageConfig>,
    dashboard: Option<FileDashboardConfig>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileProjectConfig {
    repo: Option<PathBuf>,
    name: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileRunConfig {
    output_dir: Option<PathBuf>,
    max_parallel_agents: Option<usize>,
    max_parallel_nodes: Option<usize>,
    keep_workspaces: Option<bool>,
    workspace_mode: Option<WorkspaceMode>,
    default_timeout_seconds: Option<u64>,
    enable_dashboard: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileBackendConfig {
    default: Option<BackendKind>,
    codex_cli: Option<FileBackendCliConfig>,
    claude_code_cli: Option<FileBackendCliConfig>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileBackendCliConfig {
    command: Option<String>,
    auth_mode: Option<String>,
    use_project_config: Option<bool>,
    args: Option<Vec<String>>,
    env: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileModelProfileConfig {
    backend: BackendKind,
    model: Option<String>,
    args: Option<Vec<String>>,
    env: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FilePermissionConfig {
    profile: Option<String>,
    backend_policy: Option<String>,
    sandbox: Option<String>,
    sandbox_required: Option<bool>,
    approval_mode: Option<String>,
    network: Option<String>,
    allow_dangerous_bypass: Option<bool>,
    allow_target_repo_writes_during_attempts: Option<bool>,
    materialize_outputs_as_unstaged: Option<bool>,
    write_allow: Option<Vec<String>>,
    read_deny: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileToolPolicyConfig {
    commands: Option<FileCommandPolicyCommands>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileTriageConfig {
    quorum: Option<usize>,
    panel_size: Option<usize>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileInvariantConfig {
    property_priority_threshold: Option<String>,
    invariant_testing_fuzzer_timeout: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileCommandPolicyCommands {
    allow: Option<Vec<String>>,
    deny: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileDashboardConfig {
    enabled: Option<bool>,
    host: Option<String>,
    port: Option<u16>,
    open_browser: Option<bool>,
    live_updates: Option<bool>,
    event_store: Option<String>,
}

fn apply_file_config(
    config: &mut CampaignConfig,
    file_config: FileCampaignConfig,
) -> Result<(), ConfigError> {
    if let Some(schema_version) = file_config.schema_version {
        config.schema_version = schema_version;
    }
    if let Some(dynamic_strategies_enumerator) = file_config.dynamic_strategies_enumerator {
        config.dynamic_strategies_enumerator = dynamic_strategies_enumerator;
    }

    if let Some(project) = file_config.project {
        if let Some(repo) = project.repo {
            config.project.repo = repo;
        }
        if project.name.is_some() {
            config.project.name = project.name;
        }
    }

    if let Some(run) = file_config.run {
        if let Some(output_dir) = run.output_dir {
            config.run.output_dir = output_dir;
        }
        if let Some(max_parallel_agents) = run.max_parallel_agents {
            config.run.max_parallel_agents = max_parallel_agents;
        }
        if let Some(max_parallel_nodes) = run.max_parallel_nodes {
            config.run.max_parallel_nodes = max_parallel_nodes;
        }
        if let Some(keep_workspaces) = run.keep_workspaces {
            config.run.keep_workspaces = keep_workspaces;
        }
        if let Some(workspace_mode) = run.workspace_mode {
            config.run.workspace_mode = workspace_mode;
        }
        if let Some(default_timeout_seconds) = run.default_timeout_seconds {
            config.run.default_timeout_seconds = default_timeout_seconds;
        }
        if let Some(enable_dashboard) = run.enable_dashboard {
            config.run.enable_dashboard = enable_dashboard;
        }
    }

    if let Some(backend) = file_config.backend {
        if let Some(default) = backend.default {
            config.backend.default = default;
        }
        if let Some(codex_cli) = backend.codex_cli {
            apply_backend_cli_config(&mut config.backend.codex_cli, codex_cli);
        }
        if let Some(claude_code_cli) = backend.claude_code_cli {
            apply_backend_cli_config(&mut config.backend.claude_code_cli, claude_code_cli);
        }
    }
    config
        .models
        .sync_default_profile_from_backend(&config.backend);

    if let Some(models) = file_config.models {
        apply_model_profiles(config, models)?;
    }

    if let Some(permissions) = file_config.permissions {
        if let Some(profile) = permissions.profile {
            config.permissions.profile = profile;
        }
        if let Some(backend_policy) = permissions.backend_policy {
            config.permissions.backend_policy = backend_policy;
        }
        if let Some(sandbox) = permissions.sandbox {
            config.permissions.sandbox_required = sandbox != "none";
            config.permissions.sandbox = sandbox;
        }
        if let Some(sandbox_required) = permissions.sandbox_required {
            config.permissions.sandbox_required = sandbox_required;
        }
        if let Some(approval_mode) = permissions.approval_mode {
            config.permissions.approval_mode = approval_mode;
        }
        if let Some(network) = permissions.network {
            config.permissions.network = network;
        }
        if let Some(allow_dangerous_bypass) = permissions.allow_dangerous_bypass {
            config.permissions.allow_dangerous_bypass = allow_dangerous_bypass;
        }
        if let Some(allow_target_repo_writes_during_attempts) =
            permissions.allow_target_repo_writes_during_attempts
        {
            config.permissions.allow_target_repo_writes_during_attempts =
                allow_target_repo_writes_during_attempts;
        }
        if let Some(materialize_outputs_as_unstaged) = permissions.materialize_outputs_as_unstaged {
            config.permissions.materialize_outputs_as_unstaged = materialize_outputs_as_unstaged;
        }
        if let Some(write_allow) = permissions.write_allow {
            config.permissions.write_allow = write_allow;
        }
        if let Some(read_deny) = permissions.read_deny {
            config.permissions.read_deny = read_deny;
        }
    }

    if let Some(tools) = file_config.tools {
        if let Some(commands) = tools.commands {
            if let Some(allow) = commands.allow {
                config.tools.commands.allow = allow;
            }
            if let Some(deny) = commands.deny {
                config.tools.commands.deny = deny;
            }
        }
    }

    apply_strategy_overrides(config, file_config.strategies)?;

    if let Some(invariants) = file_config.invariants {
        if let Some(threshold) = invariants.property_priority_threshold {
            config.invariants.property_priority_threshold = threshold
                .parse()
                .map_err(ConfigError::InvalidInvariantConfig)?;
        }
        if let Some(timeout) = invariants.invariant_testing_fuzzer_timeout {
            config.invariants.invariant_testing_fuzzer_timeout_seconds =
                parse_invariant_testing_fuzzer_timeout_seconds(&timeout)
                    .map_err(ConfigError::InvalidInvariantConfig)?;
        }
    }

    if let Some(triage) = file_config.triage {
        if let Some(quorum) = triage.quorum {
            config.triage.quorum = quorum;
        }
        if let Some(panel_size) = triage.panel_size {
            config.triage.panel_size = panel_size;
        }
    }

    if let Some(dashboard) = file_config.dashboard {
        if let Some(enabled) = dashboard.enabled {
            config.dashboard.enabled = enabled;
        }
        if let Some(host) = dashboard.host {
            config.dashboard.host = host;
        }
        if let Some(port) = dashboard.port {
            config.dashboard.port = port;
        }
        if let Some(open_browser) = dashboard.open_browser {
            config.dashboard.open_browser = open_browser;
        }
        if let Some(live_updates) = dashboard.live_updates {
            config.dashboard.live_updates = live_updates;
        }
        if let Some(event_store) = dashboard.event_store {
            config.dashboard.event_store = event_store;
        }
    }

    Ok(())
}

fn apply_backend_cli_config(target: &mut BackendCliConfig, source: FileBackendCliConfig) {
    if let Some(command) = source.command {
        target.command = command;
    }
    if let Some(auth_mode) = source.auth_mode {
        target.auth_mode = auth_mode;
    }
    if let Some(use_project_config) = source.use_project_config {
        target.use_project_config = use_project_config;
    }
    if let Some(args) = source.args {
        target.args = args;
    }
    if let Some(env) = source.env {
        target.env = env;
    }
}

fn apply_model_profiles(
    config: &mut CampaignConfig,
    source: toml::Value,
) -> Result<(), ConfigError> {
    let toml::Value::Table(table) = source else {
        return Err(ConfigError::InvalidModels(
            "models must be a TOML table".to_owned(),
        ));
    };

    let mut models = ModelProfileConfigs {
        default: config.models.default.clone(),
        profiles: Vec::new(),
        synthesized_default: false,
    };
    for (key, value) in table {
        if key == "default" && !value.is_table() {
            let Some(default) = value.as_str() else {
                return Err(ConfigError::InvalidModels(
                    "models.default must be a model profile id string".to_owned(),
                ));
            };
            if default.trim().is_empty() {
                return Err(ConfigError::InvalidModels(
                    "models.default cannot be empty".to_owned(),
                ));
            }
            if !valid_profile_id(default.trim()) {
                return Err(ConfigError::InvalidModels(format!(
                    "models.default `{}` must use ASCII letters, digits, hyphen, underscore, or dot",
                    default.trim()
                )));
            }
            models.default = ModelProfileId::from(default.trim().to_owned());
            continue;
        }

        if !valid_profile_id(&key) {
            return Err(ConfigError::InvalidModels(format!(
                "model profile id `{key}` must use ASCII letters, digits, hyphen, underscore, or dot"
            )));
        }
        let profile: FileModelProfileConfig = value.try_into()?;
        models.insert_or_replace(ModelProfile {
            id: ModelProfileId::from(key),
            backend: profile.backend,
            model: profile
                .model
                .map(|model| model.trim().to_owned())
                .filter(|model| !model.is_empty()),
            args: profile.args.unwrap_or_default(),
            env: profile.env.unwrap_or_default(),
        });
    }
    if models.default == ModelProfileId::from(DEFAULT_MODEL_PROFILE_ID) {
        models.ensure_synthesized_default(&config.backend);
    }
    config.models = models;
    Ok(())
}

fn apply_strategy_overrides(
    config: &mut CampaignConfig,
    overrides: BTreeMap<String, StrategyOverride>,
) -> Result<(), ConfigError> {
    for (strategy_id, override_config) in overrides {
        if let Some(strategy) = config
            .strategies
            .definitions
            .iter_mut()
            .find(|strategy| strategy.id.as_str() == strategy_id)
        {
            apply_strategy_override(strategy, override_config).map_err(|reason| {
                ConfigError::InvalidStrategyOverride {
                    strategy_id: strategy_id.clone(),
                    reason,
                }
            })?;
            continue;
        }

        return Err(ConfigError::UnknownStrategyOverride(strategy_id));
    }
    Ok(())
}

fn apply_strategy_override(
    strategy: &mut StrategyDefinition,
    override_config: StrategyOverride,
) -> Result<(), String> {
    if let Some(display_name) = override_config.display_name {
        strategy.display_name = display_name;
    }
    if let Some(models) = override_config.models {
        if models.is_empty() {
            return Err("models list cannot be empty".to_owned());
        }
        strategy.models = models;
    }
    if let Some(loops) = override_config.loops {
        strategy.loops = loops;
    }
    if let Some(enabled) = override_config.enabled {
        strategy.enabled = enabled;
    }
    if let Some(category) = override_config.category {
        strategy.category = category;
    }
    if let Some(timeout_seconds) = override_config.timeout_seconds {
        strategy.timeout = Duration::from_secs(timeout_seconds);
    }
    Ok(())
}

#[derive(Serialize)]
struct ConfigDump {
    schema_version: String,
    dynamic_strategies_enumerator: usize,
    project: ProjectConfig,
    run: RunConfig,
    backend: BackendConfig,
    models: ModelsDump,
    permissions: PermissionConfig,
    tools: ToolPolicyConfig,
    strategies: BTreeMap<String, StrategyDump>,
    invariants: InvariantDump,
    triage: TriageConfig,
    dashboard: DashboardConfig,
}

#[derive(Serialize)]
struct StrategyDump {
    display_name: String,
    prompt_id: String,
    prompt_path: PathBuf,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    models: Vec<ModelProfileId>,
    loops: usize,
    timeout_seconds: u64,
    enabled: bool,
    category: StrategyCategory,
    source: ultrafuzz_core::StrategySource,
}

#[derive(Serialize)]
struct InvariantDump {
    property_priority_threshold: String,
    invariant_testing_fuzzer_timeout: String,
}

#[derive(Serialize)]
struct ModelsDump {
    #[serde(skip_serializing_if = "is_default_model_profile_id")]
    default: ModelProfileId,
    #[serde(flatten)]
    profiles: BTreeMap<String, ModelProfileDump>,
}

#[derive(Serialize)]
struct ModelProfileDump {
    backend: BackendKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    args: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    env: BTreeMap<String, String>,
}

fn is_default_model_profile_id(id: &ModelProfileId) -> bool {
    id.as_str() == DEFAULT_MODEL_PROFILE_ID
}

fn dump_config_toml(config: &CampaignConfig) -> Result<String, ConfigError> {
    let strategies = config
        .strategies
        .definitions
        .iter()
        .map(|strategy| {
            (
                strategy.id.to_string(),
                StrategyDump {
                    display_name: strategy.display_name.clone(),
                    prompt_id: strategy.prompt_id.to_string(),
                    prompt_path: strategy.prompt_path.clone(),
                    models: strategy.models.clone(),
                    loops: strategy.loops,
                    timeout_seconds: strategy.timeout.as_secs(),
                    enabled: strategy.enabled,
                    category: strategy.category,
                    source: strategy.source,
                },
            )
        })
        .collect();

    let models = ModelsDump {
        default: config.models.default.clone(),
        profiles: config
            .models
            .profiles
            .iter()
            .filter(|profile| {
                !(config.models.synthesized_default
                    && profile.id.as_str() == DEFAULT_MODEL_PROFILE_ID)
            })
            .map(|profile| {
                (
                    profile.id.to_string(),
                    ModelProfileDump {
                        backend: profile.backend,
                        model: profile.model.clone(),
                        args: profile.args.clone(),
                        env: profile.env.clone(),
                    },
                )
            })
            .collect(),
    };

    Ok(toml::to_string_pretty(&ConfigDump {
        schema_version: config.schema_version.clone(),
        dynamic_strategies_enumerator: config.dynamic_strategies_enumerator,
        project: config.project.clone(),
        run: config.run.clone(),
        backend: config.backend.clone(),
        models,
        permissions: config.permissions.clone(),
        tools: config.tools.clone(),
        strategies,
        invariants: InvariantDump {
            property_priority_threshold: config.invariants.property_priority_threshold.to_string(),
            invariant_testing_fuzzer_timeout: format_invariant_testing_fuzzer_timeout(
                config.invariants.invariant_testing_fuzzer_timeout_seconds,
            ),
        },
        triage: config.triage.clone(),
        dashboard: config.dashboard.clone(),
    })?)
}

fn command_matches_rule(command: &str, rule: &str) -> bool {
    let command_tokens = command.split_whitespace().collect::<Vec<_>>();
    let rule_tokens = rule.split_whitespace().collect::<Vec<_>>();
    !rule_tokens.is_empty()
        && command_tokens.len() >= rule_tokens.len()
        && command_tokens
            .iter()
            .zip(rule_tokens.iter())
            .all(|(command, rule)| command == rule)
}

fn split_command_segments(command: &str) -> Result<Vec<String>, String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut quote = None::<char>;
    let mut needs_next_segment = false;

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
            if quote == Some('"') {
                match ch {
                    '`' => return Err("command substitution is not allowed".to_owned()),
                    '$' if chars.peek() == Some(&'(') || chars.peek() == Some(&'{') => {
                        return Err("command substitution is not allowed".to_owned());
                    }
                    _ => {}
                }
            }
            current.push(ch);
            continue;
        }

        match ch {
            ';' | '\n' => return Err("command chaining is not allowed".to_owned()),
            '2' if current.chars().last().is_none_or(char::is_whitespace) => {
                if upcoming_chars_match(&chars, ">&1") {
                    consume_chars(&mut chars, 3);
                } else if !consume_stderr_null_redirection(&mut chars) {
                    current.push(ch);
                    needs_next_segment = false;
                }
            }
            '|' => {
                if chars.peek() == Some(&'|') {
                    chars.next();
                    return Err("conditional OR chaining is not allowed".to_owned());
                }
                push_required_command_segment(&mut segments, &mut current)?;
                needs_next_segment = true;
            }
            '&' => {
                if chars.peek() == Some(&'&') {
                    chars.next();
                    push_required_command_segment(&mut segments, &mut current)?;
                    needs_next_segment = true;
                } else {
                    return Err("background commands are not allowed".to_owned());
                }
            }
            '`' => return Err("command substitution is not allowed".to_owned()),
            '$' if chars.peek() == Some(&'(') || chars.peek() == Some(&'{') => {
                return Err("command substitution is not allowed".to_owned());
            }
            '>' | '<' => return Err("shell redirection is not allowed".to_owned()),
            _ => {
                if !ch.is_whitespace() {
                    needs_next_segment = false;
                }
                current.push(ch);
            }
        }
    }

    if quote.is_some() {
        return Err("unterminated quoted string".to_owned());
    }
    if needs_next_segment && current.trim().is_empty() {
        return Err("missing command after shell operator".to_owned());
    }
    push_required_command_segment(&mut segments, &mut current)?;
    if segments.is_empty() {
        Err("no executable command segment found".to_owned())
    } else {
        segments
            .into_iter()
            .map(|segment| normalize_command_segment(&segment))
            .collect()
    }
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

fn upcoming_chars_match(chars: &std::iter::Peekable<std::str::Chars<'_>>, expected: &str) -> bool {
    chars.clone().take(expected.len()).eq(expected.chars())
}

fn consume_chars(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, count: usize) {
    for _ in 0..count {
        let _ = chars.next();
    }
}

fn consume_stderr_null_redirection(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> bool {
    for expected in [">/dev/null", "> /dev/null"] {
        if upcoming_chars_match(chars, expected) {
            consume_chars(chars, expected.chars().count());
            return true;
        }
    }
    false
}

fn normalize_command_segment(segment: &str) -> Result<String, String> {
    let tokens = segment.split_whitespace().collect::<Vec<_>>();
    let mut index = skip_inline_env_assignments(&tokens, 0)?;
    if tokens.get(index) == Some(&"timeout") {
        index += 1;
        index = skip_timeout_options(&tokens, index)?;
        let Some(duration) = tokens.get(index) else {
            return Err("timeout wrapper must include a duration and command".to_owned());
        };
        if !is_timeout_duration(duration) {
            return Err("timeout wrapper must include a duration before the command".to_owned());
        }
        index += 1;
        index = skip_inline_env_assignments(&tokens, index)?;
    }
    let Some(command) = tokens.get(index) else {
        return Err("no executable command segment found".to_owned());
    };
    if *command == "find" && tokens[index + 1..].contains(&"-exec") {
        return Err("find -exec is not allowed".to_owned());
    }
    Ok(tokens[index..].join(" "))
}

fn skip_inline_env_assignments(tokens: &[&str], mut index: usize) -> Result<usize, String> {
    while let Some(token) = tokens.get(index) {
        if !is_inline_env_assignment(token) {
            break;
        }
        if token.contains("`") || token.contains("$(") || token.contains("${") {
            return Err("inline environment assignment expansion is not allowed".to_owned());
        }
        index += 1;
    }
    Ok(index)
}

fn is_inline_env_assignment(token: &str) -> bool {
    let Some((name, value)) = token.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && !value.is_empty()
        && name.chars().enumerate().all(|(index, ch)| {
            ch == '_' || ch.is_ascii_uppercase() || (index > 0 && ch.is_ascii_digit())
        })
}

fn skip_timeout_options(tokens: &[&str], mut index: usize) -> Result<usize, String> {
    while let Some(token) = tokens.get(index) {
        if !token.starts_with('-') || *token == "-" {
            break;
        }
        index += 1;
        if matches!(
            *token,
            "-k" | "--kill-after" | "--signal" | "-s" | "--foreground" | "--preserve-status"
        ) && matches!(*token, "-k" | "--kill-after" | "--signal" | "-s")
        {
            if tokens.get(index).is_none() {
                return Err("timeout option is missing a value".to_owned());
            }
            index += 1;
        }
    }
    Ok(index)
}

fn is_timeout_duration(token: &str) -> bool {
    let duration = token.trim_end_matches(['s', 'm', 'h', 'd']);
    !duration.is_empty() && duration.chars().all(|ch| ch.is_ascii_digit() || ch == '.')
}

pub fn expected_backend_command(kind: BackendKind) -> &'static str {
    match kind {
        BackendKind::CodexCli => "codex",
        BackendKind::ClaudeCodeCli => "claude",
    }
}

pub fn backend_command_validation_error(
    kind: BackendKind,
    command: &str,
    allow_dangerous_bypass: bool,
) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Some("cannot be empty".to_owned());
    }
    if command != trimmed || contains_shell_syntax(trimmed) {
        return Some(format!("`{command}` is not a safe executable path/name"));
    }
    if !allow_dangerous_bypass && trimmed != expected_backend_command(kind) {
        return Some(format!(
            "`{command}` must be `{}` for {kind}; set permissions.allow_dangerous_bypass = true to use a custom backend command",
            expected_backend_command(kind)
        ));
    }
    None
}

pub fn backend_args_policy_error(kind: BackendKind, args: &[String]) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        let normalized = normalize_arg(arg);
        if is_dangerous_backend_arg_token(&normalized) {
            return Some(format!(
                "contains dangerous bypass argument `{arg}`; set permissions.allow_dangerous_bypass = true to allow it"
            ));
        }
        if kind == BackendKind::CodexCli && is_codex_profile_arg(&normalized) {
            return Some(format!(
                "contains restricted Codex profile argument `{arg}`; set permissions.allow_dangerous_bypass = true to allow it"
            ));
        }
        if let Some(flag) = dangerous_backend_value_flag(kind, &normalized) {
            if let Some(next) = args.get(index + 1) {
                let next_normalized = normalize_arg(next);
                if is_dangerous_backend_arg_value(flag, &next_normalized) {
                    return Some(format!(
                        "contains dangerous bypass argument `{arg} {next}`; set permissions.allow_dangerous_bypass = true to allow it"
                    ));
                }
            }
        }
        if let Some((flag, value)) = normalized.split_once('=') {
            if dangerous_backend_value_flag(kind, flag)
                .is_some_and(|flag| is_dangerous_backend_arg_value(flag, value))
            {
                return Some(format!(
                    "contains dangerous bypass argument `{arg}`; set permissions.allow_dangerous_bypass = true to allow it"
                ));
            }
        }
        if kind == BackendKind::CodexCli {
            if let Some(config_key) = codex_config_key_at(args, index) {
                if is_restricted_codex_config_key(&config_key) {
                    return Some(format!(
                        "contains restricted Codex config override `{config_key}`; set permissions.allow_dangerous_bypass = true to allow it"
                    ));
                }
            }
        }
    }
    None
}

pub fn dangerous_backend_env_key_reason(key: &str) -> Option<&'static str> {
    let normalized = key.trim().to_ascii_uppercase();
    if normalized.is_empty() || normalized.contains('=') || normalized.contains('\0') {
        return Some("invalid env key");
    }
    if matches!(normalized.as_str(), "PATH" | "CDPATH") {
        return Some("path search override");
    }
    if normalized.starts_with("LD_")
        || normalized.starts_with("DYLD_")
        || matches!(
            normalized.as_str(),
            "NODE_OPTIONS"
                | "PYTHONPATH"
                | "PYTHONHOME"
                | "RUBYOPT"
                | "RUBYLIB"
                | "PERL5LIB"
                | "PERL5OPT"
                | "JAVA_TOOL_OPTIONS"
                | "GEM_HOME"
                | "GEM_PATH"
        )
    {
        return Some("process loader/startup override");
    }
    if matches!(
        normalized.as_str(),
        "BASH_ENV" | "ENV" | "ZDOTDIR" | "SHELLOPTS" | "PROMPT_COMMAND"
    ) {
        return Some("shell startup override");
    }
    if normalized == "GIT_SSH_COMMAND"
        || normalized == "GIT_ASKPASS"
        || normalized == "SSH_ASKPASS"
        || normalized == "GIT_CONFIG"
        || normalized.starts_with("GIT_CONFIG_")
        || matches!(
            normalized.as_str(),
            "GIT_DIR"
                | "GIT_WORK_TREE"
                | "GIT_EXEC_PATH"
                | "GIT_TEMPLATE_DIR"
                | "GIT_INDEX_FILE"
                | "GIT_OBJECT_DIRECTORY"
                | "GIT_ALTERNATE_OBJECT_DIRECTORIES"
                | "GIT_CEILING_DIRECTORIES"
                | "GIT_SSL_CAINFO"
        )
    {
        return Some("git behavior override");
    }
    if matches!(
        normalized.as_str(),
        "HOME"
            | "USERPROFILE"
            | "XDG_CONFIG_HOME"
            | "XDG_DATA_HOME"
            | "XDG_CACHE_HOME"
            | "CODEX_HOME"
            | "CODEX_CONFIG"
            | "CODEX_CONFIG_DIR"
            | "CLAUDE_HOME"
            | "CLAUDE_CONFIG_DIR"
            | "CLAUDE_CODE_CONFIG_DIR"
            | "ANTHROPIC_CONFIG_DIR"
    ) {
        return Some("backend config-directory override");
    }
    None
}

fn collect_dangerous_env_errors(
    label: &str,
    env: &BTreeMap<String, String>,
    errors: &mut Vec<String>,
) {
    for key in env.keys() {
        if let Some(reason) = dangerous_backend_env_key_reason(key) {
            errors.push(format!(
                "{label} contains dangerous env key `{key}` ({reason}); set permissions.allow_dangerous_bypass = true to allow it"
            ));
        }
    }
}

fn contains_shell_syntax(value: &str) -> bool {
    [";", "&&", "||", "|", ">", "<", "`", "$(", "\n"]
        .iter()
        .any(|token| value.contains(token))
}

fn normalize_arg(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn is_dangerous_backend_arg_token(arg: &str) -> bool {
    matches!(
        arg,
        "--dangerously-bypass-approvals-and-sandbox"
            | "--dangerously-bypass-hook-trust"
            | "--dangerously-skip-permissions"
            | "--bypass-permissions"
            | "--yolo"
            | "--search"
            | "--no-sandbox"
            | "--ignore-rules"
            | "--ignore-user-config"
    ) || arg.contains("dangerously")
        || arg.contains("bypass-permission")
}

fn is_codex_profile_arg(arg: &str) -> bool {
    matches!(arg, "--profile" | "-p") || arg.starts_with("--profile=") || arg.starts_with("-p=")
}

fn dangerous_backend_value_flag(kind: BackendKind, flag: &str) -> Option<&'static str> {
    match flag {
        "--permission-mode" => Some("--permission-mode"),
        "--approval-policy" => Some("--approval-policy"),
        "--sandbox" => Some("--sandbox"),
        "-s" if kind == BackendKind::CodexCli => Some("--sandbox"),
        _ => None,
    }
}

fn is_dangerous_backend_arg_value(flag: &str, value: &str) -> bool {
    match flag {
        "--sandbox" => is_dangerous_sandbox_mode(value),
        "--permission-mode" => matches!(
            value,
            "bypasspermissions" | "bypass-permissions" | "dangerously-skip-permissions"
        ),
        "--approval-policy" => value.contains("bypass"),
        _ => false,
    }
}

fn codex_config_key_at(args: &[String], index: usize) -> Option<String> {
    let arg = args.get(index)?;
    if matches!(arg.as_str(), "-c" | "--config") {
        return args
            .get(index + 1)
            .and_then(|value| codex_config_key(value));
    }
    arg.strip_prefix("-c=")
        .or_else(|| arg.strip_prefix("--config="))
        .and_then(codex_config_key)
}

fn codex_config_key(value: &str) -> Option<String> {
    let (key, _) = value.split_once('=')?;
    let key = key.trim().trim_matches('"').trim_matches('\'');
    (!key.is_empty()).then(|| key.to_owned())
}

fn is_restricted_codex_config_key(key: &str) -> bool {
    let normalized = key
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_ascii_lowercase()
        .replace('-', "_");
    normalized == "approval_policy"
        || normalized == "sandbox"
        || normalized == "sandbox_mode"
        || normalized == "permission_mode"
        || normalized == "network_access"
        || normalized == "web_search"
        || normalized == "profile"
        || normalized.starts_with("sandbox_")
        || normalized.contains(".sandbox")
        || normalized.contains("sandbox.")
        || normalized.ends_with(".network_access")
        || normalized.ends_with(".web_search")
        || normalized.ends_with(".profile")
        || normalized.contains("network")
        || normalized.contains("permission")
}

fn is_dangerous_sandbox_mode(value: &str) -> bool {
    matches!(
        normalize_arg(value).as_str(),
        "danger-full-access" | "none" | "disabled"
    )
}

fn valid_profile_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains("..")
        && !id.starts_with('.')
        && !id.ends_with('.')
        && id.bytes().all(|byte| {
            matches!(
                byte,
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.'
            )
        })
}

pub fn resolve_project_path(
    project_root: impl AsRef<Path>,
    field_name: &'static str,
    path: &Path,
) -> Result<PathBuf, ConfigError> {
    let mut errors = Vec::new();
    validate_project_local_path(field_name, path, &mut errors);
    if !errors.is_empty() {
        return Err(ConfigError::Validation(errors));
    }

    let project_root = project_root.as_ref();
    let canonical_root = project_root.canonicalize()?;
    let resolved = canonicalize_existing_prefix(&canonical_root.join(path))?;
    if !resolved.starts_with(&canonical_root) {
        return Err(ConfigError::Validation(vec![format!(
            "{field_name} `{}` resolves outside project root `{}`; choose a relative path inside the project root",
            path.display(),
            project_root.display()
        )]));
    }
    Ok(resolved)
}

fn validate_project_local_path(field_name: &'static str, path: &Path, errors: &mut Vec<String>) {
    if path.as_os_str().is_empty() {
        errors.push(format!(
            "{field_name} cannot be empty; choose a relative path inside the project root"
        ));
        return;
    }
    if path.is_absolute() {
        errors.push(format!(
            "{field_name} `{}` must be a relative path inside the project root; remove the leading root or choose a project-local path",
            path.display()
        ));
        return;
    }
    if path == Path::new(".") {
        return;
    }
    let path_text = path.as_os_str().to_string_lossy();
    for component in path_text.split(['/', '\\']) {
        if component.is_empty() {
            errors.push(format!(
                "{field_name} `{}` may not contain empty path components; use a normalized relative path inside the project root",
                path.display()
            ));
            return;
        }
        if component == ".." {
            errors.push(format!(
                "{field_name} `{}` may not contain `..`; choose a relative path inside the project root",
                path.display()
            ));
            return;
        }
        if component == "." {
            errors.push(format!(
                "{field_name} `{}` may not contain `.` path components; use a normalized relative path inside the project root",
                path.display()
            ));
            return;
        }
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::ParentDir => errors.push(format!(
                "{field_name} `{}` may not contain `..`; choose a relative path inside the project root",
                path.display()
            )),
            Component::CurDir => errors.push(format!(
                "{field_name} `{}` may not contain `.` path components; use a normalized relative path inside the project root",
                path.display()
            )),
            Component::RootDir | Component::Prefix(_) => errors.push(format!(
                "{field_name} `{}` must stay inside the project root; choose a normalized relative path",
                path.display()
            )),
        }
    }
}

fn canonicalize_existing_prefix(path: &Path) -> std::io::Result<PathBuf> {
    if path.exists() {
        return path.canonicalize();
    }

    let mut missing = Vec::new();
    let mut current = path;
    loop {
        if current.exists() {
            let mut resolved = current.canonicalize()?;
            for component in missing.iter().rev() {
                resolved.push(component);
            }
            return Ok(resolved);
        }
        let Some(file_name) = current.file_name() else {
            return current.canonicalize();
        };
        missing.push(file_name.to_owned());
        let Some(parent) = current.parent() else {
            return current.canonicalize();
        };
        current = parent;
    }
}

fn redact_env_map(env: &mut BTreeMap<String, String>) {
    for (key, value) in env {
        if should_redact_env_value(key, value) {
            *value = "<redacted>".to_owned();
        }
    }
}

fn should_redact_env_value(key: &str, value: &str) -> bool {
    if is_sensitive_key_name(key) || is_sensitive_value(value) {
        return true;
    }
    !is_non_secret_env_allowlisted(key)
}

fn is_non_secret_env_allowlisted(key: &str) -> bool {
    matches!(key, "CI" | "NO_COLOR" | "RUST_BACKTRACE" | "RUST_LOG")
}

fn redact_args(args: &mut [String]) {
    let mut redact_next = false;
    for arg in args {
        if redact_next {
            *arg = "<redacted>".to_owned();
            redact_next = false;
            continue;
        }

        if let Some((flag, value)) = arg.split_once('=') {
            if is_sensitive_key_name(flag) || is_sensitive_value(value) {
                *arg = format!("{flag}=<redacted>");
            }
            continue;
        }

        if is_sensitive_value(arg) {
            *arg = "<redacted>".to_owned();
        } else if arg.starts_with('-') && is_sensitive_key_name(arg) {
            redact_next = true;
        }
    }
}

fn redact_sensitive_value(value: &mut String) {
    if is_sensitive_value(value) {
        *value = "<redacted>".to_owned();
    }
}

pub fn is_sensitive_key_name(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace('-', "_");
    key.contains("token")
        || key.contains("secret")
        || key.contains("password")
        || key.contains("api_key")
        || key.contains("apikey")
        || key.contains("credential")
        || key.contains("private_key")
        || key.contains("access_key")
        || key.contains("secret_key")
        || key.contains("client_secret")
}

fn is_sensitive_value(value: &str) -> bool {
    let value = value.trim();
    if let Some(token) = value.strip_prefix("Bearer ") {
        return is_sensitive_value(token);
    }
    value.starts_with("sk-")
        || value.starts_with("ghp_")
        || value.starts_with("gho_")
        || value.starts_with("ghu_")
        || value.starts_with("ghs_")
        || value.starts_with("ghr_")
        || value.starts_with("github_pat_")
        || value.starts_with("AKIA")
        || value.starts_with("ASIA")
        || value.starts_with("xoxa-")
        || value.starts_with("xoxb-")
        || value.starts_with("xoxp-")
        || value.starts_with("xoxs-")
        || value.contains("BEGIN PRIVATE KEY")
        || looks_like_jwt(value)
}

fn looks_like_jwt(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts[0].starts_with("eyJ")
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
}

fn parse_optional_env<T, F>(name: &'static str, parse: F) -> Result<Option<T>, ConfigError>
where
    F: FnOnce(&str) -> Result<T, String>,
{
    match std::env::var(name) {
        Ok(value) => parse(&value)
            .map(Some)
            .map_err(|reason| ConfigError::EnvVar {
                name,
                value: reason,
            }),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(err) => Err(ConfigError::EnvVar {
            name,
            value: err.to_string(),
        }),
    }
}

fn backend_env_passthrough(
    override_name: &'static str,
) -> Result<BTreeMap<String, String>, ConfigError> {
    let Some(names) = parse_optional_env(override_name, parse_env_passthrough_names)? else {
        return Ok(BTreeMap::new());
    };

    let mut envs = BTreeMap::new();
    for name in names {
        match std::env::var(&name) {
            Ok(value) => {
                envs.insert(name, value);
            }
            Err(std::env::VarError::NotPresent) => {
                return Err(ConfigError::EnvVar {
                    name: override_name,
                    value: format!("environment variable `{name}` is not set"),
                });
            }
            Err(err) => {
                return Err(ConfigError::EnvVar {
                    name: override_name,
                    value: format!("environment variable `{name}` could not be read: {err}"),
                });
            }
        }
    }
    Ok(envs)
}

fn parse_env_passthrough_names(value: &str) -> Result<Vec<String>, String> {
    let names = value
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| {
            if valid_env_name(name) {
                Ok(name.to_owned())
            } else {
                Err(format!(
                    "environment variable name `{name}` must match [A-Za-z_][A-Za-z0-9_]*"
                ))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn parse_usize_env(value: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .map_err(|_| format!("expected positive integer, got `{value}`"))
}

fn parse_bool_env(value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!("expected boolean, got `{value}`")),
    }
}

impl From<ultrafuzz_core::ParseEnumError> for ConfigError {
    fn from(value: ultrafuzz_core::ParseEnumError) -> Self {
        Self::InvalidEnum(value.to_string())
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("config I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid config TOML: {0}")]
    TomlDeserialize(#[from] toml::de::Error),
    #[error("failed to serialize config TOML: {0}")]
    TomlSerialize(#[from] toml::ser::Error),
    #[error("invalid enum value: {0}")]
    InvalidEnum(String),
    #[error("invalid environment override {name}: {value}")]
    EnvVar { name: &'static str, value: String },
    #[error("invalid models config: {0}")]
    InvalidModels(String),
    #[error("config references unknown strategy `{0}`")]
    UnknownStrategyOverride(String),
    #[error("invalid override for strategy `{strategy_id}`: {reason}")]
    InvalidStrategyOverride { strategy_id: String, reason: String },
    #[error("invalid invariant config: {0}")]
    InvalidInvariantConfig(String),
    #[error("config validation failed: {0:?}")]
    Validation(Vec<String>),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use ultrafuzz_core::{PromptId, StrategyId, StrategySource};

    fn config_error(toml: &str) -> String {
        resolve_config_from_toml(
            Some(toml),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err()
        .to_string()
    }

    #[test]
    fn path_safety_rejects_project_repo_absolute_parent_and_non_normal() {
        let absolute = config_error(
            r#"
[project]
repo = "/tmp/outside"
"#,
        );
        assert!(absolute.contains("project.repo"));
        assert!(absolute.contains("must be a relative path inside the project root"));

        let traversal = config_error(
            r#"
[project]
repo = "../outside"
"#,
        );
        assert!(traversal.contains("project.repo"));
        assert!(traversal.contains("may not contain `..`"));

        let non_normal = config_error(
            r#"
[project]
repo = "contracts/./target"
"#,
        );
        assert!(non_normal.contains("project.repo"));
        assert!(non_normal.contains("may not contain `.` path components"));
    }

    #[test]
    fn path_safety_rejects_run_output_dir_absolute_parent_and_non_normal() {
        let absolute = config_error(
            r#"
[run]
output_dir = "/tmp/ultrafuzz-runs"
"#,
        );
        assert!(absolute.contains("run.output_dir"));
        assert!(absolute.contains("must be a relative path inside the project root"));

        let traversal = config_error(
            r#"
[run]
output_dir = "../ultrafuzz-runs"
"#,
        );
        assert!(traversal.contains("run.output_dir"));
        assert!(traversal.contains("may not contain `..`"));

        let non_normal = config_error(
            r#"
[run]
output_dir = ".ultrafuzz/./runs"
"#,
        );
        assert!(non_normal.contains("run.output_dir"));
        assert!(non_normal.contains("may not contain `.` path components"));
    }

    #[test]
    fn path_safety_accepts_valid_relative_repo_and_output_dir() {
        let config = resolve_config_from_toml(
            Some(
                r#"
[project]
repo = "contracts"

[run]
output_dir = ".ultrafuzz/runs"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        assert_eq!(config.project.repo, PathBuf::from("contracts"));
        assert_eq!(config.run.output_dir, PathBuf::from(".ultrafuzz/runs"));
    }

    #[test]
    fn path_safety_rejects_environment_output_dir_escape() {
        let error = resolve_config_from_toml(
            None,
            Vec::new(),
            EnvOverrides {
                output_dir: Some(PathBuf::from("../runs")),
                ..EnvOverrides::default()
            },
            CliOverrides::default(),
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("run.output_dir"));
        assert!(error.contains("may not contain `..`"));
    }

    #[test]
    fn path_safety_resolves_paths_under_project_root() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("contracts")).unwrap();
        let canonical_root = root.path().canonicalize().unwrap();

        let repo =
            resolve_project_path(root.path(), "project.repo", Path::new("contracts")).unwrap();
        assert_eq!(repo, canonical_root.join("contracts"));

        let output =
            resolve_project_path(root.path(), "run.output_dir", Path::new(".ultrafuzz/runs"))
                .unwrap();
        assert_eq!(output, canonical_root.join(".ultrafuzz/runs"));
    }

    #[cfg(unix)]
    #[test]
    fn path_safety_rejects_paths_that_canonicalize_outside_project_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("outside-link")).unwrap();

        let error = resolve_project_path(root.path(), "project.repo", Path::new("outside-link"))
            .unwrap_err()
            .to_string();

        assert!(error.contains("project.repo"));
        assert!(error.contains("resolves outside project root"));
    }

    #[test]
    fn default_config_has_required_strategies() {
        let config = CampaignConfig::default();
        let ids: Vec<_> = config
            .enabled_strategies()
            .into_iter()
            .map(|strategy| strategy.id.as_str())
            .collect();

        assert_eq!(
            ids,
            [
                "differential-library-tests",
                "round-trip",
                "workflow-property-based-tests",
                "encode-decode",
                "expand-coverage",
                "stateful-invariant-setup",
                "stateful-invariant-handlers",
                "stateful-invariant-coverage"
            ]
        );
    }

    #[test]
    fn default_permissions_allow_extra_context_artifact_roots() {
        let config = CampaignConfig::default();
        assert!(config
            .permissions
            .write_allow
            .iter()
            .any(|entry| entry == "extra-context"));

        let resolved = resolve_config_from_toml(
            Some(default_config_toml()),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        assert!(resolved
            .permissions
            .write_allow
            .iter()
            .any(|entry| entry == "extra-context"));
    }

    #[test]
    fn applies_config_env_and_cli_precedence() {
        let mut decode = StrategyDefinition::built_in(BuiltInStrategy::EncodeDecode);
        decode.loops = 3;

        let config = resolve_config_from_toml(
            Some(
                r#"
[run]
max_parallel_agents = 2
max_parallel_nodes = 3

[backend]
default = "claude-code-cli"

[strategies.encode-decode]
loops = 5
timeout_seconds = 77
"#,
            ),
            vec![decode],
            EnvOverrides {
                backend: Some(BackendKind::CodexCli),
                max_parallel_agents: Some(6),
                max_parallel_nodes: Some(12),
                output_dir: None,
                keep_workspaces: None,
                ..EnvOverrides::default()
            },
            CliOverrides {
                backend: Some(BackendKind::ClaudeCodeCli),
                max_parallel_agents: Some(9),
                max_parallel_nodes: Some(18),
                triage_quorum: Some(4),
                triage_panel_size: Some(7),
                ..CliOverrides::default()
            },
        )
        .unwrap();

        assert_eq!(config.backend.default, BackendKind::ClaudeCodeCli);
        assert_eq!(config.run.max_parallel_agents, 9);
        assert_eq!(config.run.max_parallel_nodes, 18);
        assert_eq!(config.triage.quorum, 4);
        assert_eq!(config.triage.panel_size, 7);
        let strategy = &config.strategies.definitions[0];
        assert_eq!(strategy.loops, 5);
        assert_eq!(strategy.timeout, Duration::from_secs(77));
    }

    #[test]
    fn dynamic_strategies_enumerator_defaults_toml_and_cli_override() {
        let defaults = resolve_config_from_toml(
            None,
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        assert_eq!(
            defaults.dynamic_strategies_enumerator,
            DEFAULT_DYNAMIC_STRATEGIES_ENUMERATOR
        );

        let from_toml = resolve_config_from_toml(
            Some("dynamic_strategies_enumerator = 5\n"),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        assert_eq!(from_toml.dynamic_strategies_enumerator, 5);

        let from_cli = resolve_config_from_toml(
            Some("dynamic_strategies_enumerator = 2\n"),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides {
                dynamic_strategies_enumerator: Some(7),
                ..CliOverrides::default()
            },
        )
        .unwrap();
        assert_eq!(from_cli.dynamic_strategies_enumerator, 7);

        let dump = from_cli.dump_redacted_toml().unwrap();
        assert!(dump.contains("dynamic_strategies_enumerator = 7"));

        let invalid = resolve_config_from_toml(
            Some("dynamic_strategies_enumerator = 0\n"),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();
        let ConfigError::Validation(errors) = invalid else {
            panic!("expected validation error");
        };
        assert!(errors.iter().any(|error| {
            error.contains("dynamic_strategies_enumerator must be greater than zero")
        }));
    }

    #[test]
    fn triage_defaults_toml_and_cli_overrides_resolve_with_validation() {
        let defaults = resolve_config_from_toml(
            None,
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        assert_eq!(defaults.triage.quorum, DEFAULT_TRIAGE_QUORUM);
        assert_eq!(defaults.triage.panel_size, DEFAULT_TRIAGE_PANEL_SIZE);

        let toml = resolve_config_from_toml(
            Some(
                r#"
[triage]
quorum = 2
panel_size = 4
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        assert_eq!(toml.triage.quorum, 2);
        assert_eq!(toml.triage.panel_size, 4);

        let cli = resolve_config_from_toml(
            Some(
                r#"
[triage]
quorum = 2
panel_size = 4
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides {
                triage_quorum: Some(5),
                triage_panel_size: Some(9),
                ..CliOverrides::default()
            },
        )
        .unwrap();
        assert_eq!(cli.triage.quorum, 5);
        assert_eq!(cli.triage.panel_size, 9);

        let invalid = resolve_config_from_toml(
            Some(
                r#"
[triage]
quorum = 6
panel_size = 5
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();
        let ConfigError::Validation(errors) = invalid else {
            panic!("expected validation error");
        };
        assert!(errors
            .iter()
            .any(|error| error.contains("triage.quorum (6) cannot be greater")));
    }

    #[test]
    fn invariant_defaults_and_priority_thresholds_are_inclusive() {
        let defaults = resolve_config_from_toml(
            None,
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        assert_eq!(
            defaults.invariants.property_priority_threshold,
            InvariantPropertyPriorityThreshold::High
        );
        assert_eq!(
            defaults
                .invariants
                .property_priority_threshold
                .included_priorities(),
            ["high"]
        );
        assert_eq!(
            defaults.invariants.invariant_testing_fuzzer_timeout_seconds,
            DEFAULT_INVARIANT_TESTING_FUZZER_TIMEOUT_SECONDS
        );
        assert_eq!(
            format_invariant_testing_fuzzer_timeout(
                defaults.invariants.invariant_testing_fuzzer_timeout_seconds
            ),
            "1h"
        );

        let medium = resolve_config_from_toml(
            Some(
                r#"
[invariants]
property_priority_threshold = "medium"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        assert_eq!(
            medium
                .invariants
                .property_priority_threshold
                .included_priorities(),
            ["high", "medium"]
        );

        let low = resolve_config_from_toml(
            Some(
                r#"
[invariants]
property_priority_threshold = "low"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        assert_eq!(
            low.invariants
                .property_priority_threshold
                .included_priorities(),
            ["high", "medium", "low"]
        );
    }

    #[test]
    fn invariant_toml_and_cli_overrides_resolve_with_validation() {
        let config = resolve_config_from_toml(
            Some(
                r#"
[invariants]
property_priority_threshold = "high"
invariant_testing_fuzzer_timeout = "30min"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides {
                invariant_property_priority_threshold: Some(
                    InvariantPropertyPriorityThreshold::Medium,
                ),
                invariant_testing_fuzzer_timeout_seconds: Some(45 * 60),
                ..CliOverrides::default()
            },
        )
        .unwrap();
        assert_eq!(
            config.invariants.property_priority_threshold,
            InvariantPropertyPriorityThreshold::Medium
        );
        assert_eq!(
            config.invariants.invariant_testing_fuzzer_timeout_seconds,
            45 * 60
        );

        let invalid_priority = resolve_config_from_toml(
            Some(
                r#"
[invariants]
property_priority_threshold = "urgent"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();
        assert!(invalid_priority
            .to_string()
            .contains("expected one of `high`, `medium`, or `low`"));

        let invalid_timeout = resolve_config_from_toml(
            Some(
                r#"
[invariants]
invariant_testing_fuzzer_timeout = "eventually"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();
        assert!(invalid_timeout
            .to_string()
            .contains("expected a positive duration like `30min`, `1800s`, or `1h`"));
    }

    #[test]
    fn parses_model_profiles_and_strategy_model_selection() {
        let config = resolve_config_from_toml(
            Some(
                r#"
[models.gpt-5-5]
backend = "codex-cli"
model = "gpt-5.5"

[models.claude-4-6]
backend = "claude-code-cli"
model = "claude-4.6"
args = ["--permission-mode", "default"]

[models.claude-4-6.env]
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"

[strategies.encode-decode]
models = ["gpt-5-5", "claude-4-6"]
loops = 3
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        assert_eq!(config.models.default, ModelProfileId::from("default"));
        assert_eq!(
            config
                .model_profile(&ModelProfileId::from("gpt-5-5"))
                .unwrap()
                .model
                .as_deref(),
            Some("gpt-5.5")
        );
        let claude = config
            .model_profile(&ModelProfileId::from("claude-4-6"))
            .unwrap();
        assert_eq!(claude.backend, BackendKind::ClaudeCodeCli);
        assert_eq!(
            claude
                .env
                .get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")
                .map(String::as_str),
            Some("1")
        );

        let strategy = config
            .strategies
            .definitions
            .iter()
            .find(|strategy| strategy.id.as_str() == "encode-decode")
            .unwrap();
        assert_eq!(
            strategy.models,
            vec![
                ModelProfileId::from("gpt-5-5"),
                ModelProfileId::from("claude-4-6")
            ]
        );
        assert_eq!(
            config.effective_strategy_models(strategy),
            strategy.models.clone()
        );
    }

    #[test]
    fn rejects_unsafe_default_model_profile_id() {
        let error = resolve_config_from_toml(
            Some(
                r#"
[models]
default = "../escape"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("models.default"));
        assert!(error.to_string().contains("ASCII letters"));
    }

    #[test]
    fn rejects_dot_wrapped_model_profile_ids() {
        for toml in [
            r#"
[models]
default = ".hidden"
"#,
            r#"
[models."trailing."]
backend = "codex-cli"
model = "gpt-5.5"
"#,
        ] {
            let error = resolve_config_from_toml(
                Some(toml),
                Vec::new(),
                EnvOverrides::default(),
                CliOverrides::default(),
            )
            .unwrap_err();

            assert!(error.to_string().contains("model"));
            assert!(error.to_string().contains("ASCII letters"));
        }
    }

    #[test]
    fn validates_strategy_model_ids_and_empty_model_lists() {
        let unknown = resolve_config_from_toml(
            Some(
                r#"
[strategies.encode-decode]
models = ["missing-model"]
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();
        let ConfigError::Validation(errors) = unknown else {
            panic!("expected validation error");
        };
        assert!(errors
            .iter()
            .any(|error| error.contains("unknown model profile `missing-model`")));

        let empty = resolve_config_from_toml(
            Some("[strategies.encode-decode]\nmodels = []\n"),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();
        assert!(empty.to_string().contains("models list cannot be empty"));
    }

    #[test]
    fn dumps_non_default_model_profile_selection_as_reloadable_toml() {
        let config = resolve_config_from_toml(
            Some(
                r#"
[models]
default = "gpt-5-5"

[models.gpt-5-5]
backend = "codex-cli"
model = "gpt-5.5"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        let dump = config.dump_redacted_toml().unwrap();
        assert!(dump.contains("default = \"gpt-5-5\""));
        assert!(dump.contains("[models.gpt-5-5]"));
        assert!(!dump.contains("[models.default]"));

        let reloaded = resolve_config_from_toml(
            Some(&dump),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        assert_eq!(reloaded.models.default, ModelProfileId::from("gpt-5-5"));
        assert!(reloaded
            .model_profile(&ModelProfileId::from("gpt-5-5"))
            .is_some());
    }

    #[test]
    fn dump_keeps_synthesized_default_model_profile_implicit_and_reloadable() {
        let config = resolve_config_from_toml(
            None,
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        let dump = config.dump_redacted_toml().unwrap();
        assert!(!dump.contains("default = \"default\""));
        assert!(!dump.contains("[models.default]"));

        let reloaded = resolve_config_from_toml(
            Some(&dump),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides {
                backend: Some(BackendKind::ClaudeCodeCli),
                ..CliOverrides::default()
            },
        )
        .unwrap();

        assert_eq!(reloaded.models.default, ModelProfileId::from("default"));
        assert_eq!(
            reloaded.default_model_profile().unwrap().backend,
            BackendKind::ClaudeCodeCli
        );
    }

    #[test]
    fn explicit_default_model_profile_survives_backend_override() {
        let config = resolve_config_from_toml(
            Some(
                r#"
[models.default]
backend = "claude-code-cli"
model = "claude-opus-4.1"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides {
                backend: Some(BackendKind::CodexCli),
                ..CliOverrides::default()
            },
        )
        .unwrap();

        assert_eq!(config.backend.default, BackendKind::CodexCli);
        let profile = config.default_model_profile().unwrap();
        assert_eq!(profile.backend, BackendKind::ClaudeCodeCli);
        assert_eq!(profile.model.as_deref(), Some("claude-opus-4.1"));

        let dump = config.dump_redacted_toml().unwrap();
        assert!(!dump.contains("default = \"default\""));
        assert!(dump.contains("[models.default]"));

        let reloaded = resolve_config_from_toml(
            Some(&dump),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides {
                backend: Some(BackendKind::CodexCli),
                ..CliOverrides::default()
            },
        )
        .unwrap();

        let profile = reloaded.default_model_profile().unwrap();
        assert_eq!(profile.backend, BackendKind::ClaudeCodeCli);
        assert_eq!(profile.model.as_deref(), Some("claude-opus-4.1"));
    }

    #[test]
    fn dump_redacted_toml_redacts_backend_and_model_env_by_default() {
        let config = resolve_config_from_toml(
            Some(
                r#"
[backend.codex_cli.env]
OPENAI_API_KEY = "sk-secret"
KNOWN_PROVIDER_TOKEN = "github_pat_custom"
NORMAL_VALUE = "visible"
RUST_LOG = "ultrafuzz=debug"

[models.mystery-provider]
backend = "claude-code-cli"
model = "mystery-large"

[models.mystery-provider.env]
CUSTOM_AUTH = "provider-v1-custom-secret"
GENERIC_SESSION = "nT8q4Yx2Pa7Lm0Qw6Rs9Uv3Za5Bc1DfE"
NO_COLOR = "1"
RUST_BACKTRACE = "1"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        let dump = config.dump_redacted_toml().unwrap();
        assert!(dump.contains("OPENAI_API_KEY = \"<redacted>\""));
        assert!(dump.contains("KNOWN_PROVIDER_TOKEN = \"<redacted>\""));
        assert!(dump.contains("NORMAL_VALUE = \"<redacted>\""));
        assert!(dump.contains("CUSTOM_AUTH = \"<redacted>\""));
        assert!(dump.contains("GENERIC_SESSION = \"<redacted>\""));
        assert!(dump.contains("RUST_LOG = \"ultrafuzz=debug\""));
        assert!(dump.contains("NO_COLOR = \"1\""));
        assert!(dump.contains("RUST_BACKTRACE = \"1\""));
        assert!(!dump.contains("sk-secret"));
        assert!(!dump.contains("github_pat_custom"));
        assert!(!dump.contains("visible"));
        assert!(!dump.contains("provider-v1-custom-secret"));
        assert!(!dump.contains("nT8q4Yx2Pa7Lm0Qw6Rs9Uv3Za5Bc1DfE"));
    }

    #[test]
    fn redacted_config_keeps_original_env_values_for_runtime() {
        let config = resolve_config_from_toml(
            Some(
                r#"
[backend.codex_cli.env]
CUSTOM_AUTH = "runtime-secret"

[models.default]
backend = "codex-cli"

[models.default.env]
MODEL_SESSION = "runtime-model-secret"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        let redacted = config.redacted();
        assert_eq!(
            redacted.backend.codex_cli.env.get("CUSTOM_AUTH").unwrap(),
            "<redacted>"
        );
        assert_eq!(
            redacted
                .default_model_profile()
                .unwrap()
                .env
                .get("MODEL_SESSION")
                .unwrap(),
            "<redacted>"
        );
        assert_eq!(
            config.backend.codex_cli.env.get("CUSTOM_AUTH").unwrap(),
            "runtime-secret"
        );
        assert_eq!(
            config
                .default_model_profile()
                .unwrap()
                .env
                .get("MODEL_SESSION")
                .unwrap(),
            "runtime-model-secret"
        );
    }

    #[test]
    fn env_passthrough_overrides_backend_env_and_redacts_dump() {
        let mut codex_cli_env = BTreeMap::new();
        codex_cli_env.insert("OPENAI_API_KEY".to_owned(), "sk-secret".to_owned());

        let config = resolve_config_from_toml(
            Some(
                r#"
[backend.codex_cli.env]
OPENAI_API_KEY = "old-secret"
NORMAL_VALUE = "visible"
"#,
            ),
            Vec::new(),
            EnvOverrides {
                codex_cli_env,
                ..EnvOverrides::default()
            },
            CliOverrides::default(),
        )
        .unwrap();

        assert_eq!(
            config.backend.codex_cli.env.get("OPENAI_API_KEY"),
            Some(&"sk-secret".to_owned())
        );
        let dump = config.dump_redacted_toml().unwrap();
        assert!(dump.contains("OPENAI_API_KEY = \"<redacted>\""));
        assert!(dump.contains("NORMAL_VALUE = \"<redacted>\""));
        assert!(!dump.contains("sk-secret"));
        assert!(!dump.contains("old-secret"));
        assert!(!dump.contains("visible"));
    }

    #[test]
    fn env_passthrough_overrides_matching_model_profile_env_and_redacts_dump() {
        let mut claude_code_cli_env = BTreeMap::new();
        claude_code_cli_env.insert("ANTHROPIC_API_KEY".to_owned(), "fresh-secret".to_owned());

        let config = resolve_config_from_toml(
            Some(
                r#"
[models]
default = "claude-opus"

[models.claude-opus]
backend = "claude-code-cli"
model = "claude-opus-4-8"

[models.claude-opus.env]
ANTHROPIC_API_KEY = "stale-secret"
NORMAL_VALUE = "profile-visible"
"#,
            ),
            Vec::new(),
            EnvOverrides {
                claude_code_cli_env,
                ..EnvOverrides::default()
            },
            CliOverrides::default(),
        )
        .unwrap();

        let profile = config
            .model_profile(&ModelProfileId::from("claude-opus"))
            .unwrap();
        assert_eq!(
            profile.env.get("ANTHROPIC_API_KEY"),
            Some(&"fresh-secret".to_owned())
        );
        assert_eq!(
            profile.env.get("NORMAL_VALUE"),
            Some(&"profile-visible".to_owned())
        );
        let dump = config.dump_redacted_toml().unwrap();
        assert!(dump.contains("ANTHROPIC_API_KEY = \"<redacted>\""));
        assert!(dump.contains("NORMAL_VALUE = \"<redacted>\""));
        assert!(!dump.contains("fresh-secret"));
        assert!(!dump.contains("stale-secret"));
        assert!(!dump.contains("profile-visible"));
    }

    #[test]
    fn env_passthrough_names_must_be_shell_env_names() {
        assert_eq!(
            parse_env_passthrough_names("OPENAI_API_KEY, CODEX_HOME").unwrap(),
            vec!["OPENAI_API_KEY".to_owned(), "CODEX_HOME".to_owned()]
        );
        assert!(parse_env_passthrough_names("OPENAI-API-KEY").is_err());
        assert!(parse_env_passthrough_names("1OPENAI_API_KEY").is_err());
    }

    #[test]
    fn dump_redacts_sensitive_backend_and_model_args() {
        let config = resolve_config_from_toml(
            Some(
                r#"
[backend.codex_cli]
args = ["exec", "--api-key", "sk-secret", "--token=ghp_secret", "--plain", "visible"]

[backend.claude_code_cli]
args = ["--aws-access-key", "AKIAEXAMPLESECRET"]

[models.default]
backend = "codex-cli"
args = ["--slack-token", "xoxb-secret", "--jwt", "eyJhbGciOiJIUzI1NiJ9.payload.signature"]
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        let redacted = config.redacted();
        assert_eq!(
            redacted.backend.codex_cli.args,
            vec![
                "exec",
                "--api-key",
                "<redacted>",
                "--token=<redacted>",
                "--plain",
                "visible",
            ]
        );
        assert_eq!(
            redacted.backend.claude_code_cli.args,
            vec!["--aws-access-key", "<redacted>"]
        );
        assert_eq!(
            redacted.default_model_profile().unwrap().args,
            vec!["--slack-token", "<redacted>", "--jwt", "<redacted>",]
        );
        let dump = config.dump_redacted_toml().unwrap();
        assert!(!dump.contains("sk-secret"));
        assert!(!dump.contains("ghp_secret"));
        assert!(!dump.contains("AKIAEXAMPLESECRET"));
        assert!(!dump.contains("xoxb-secret"));
        assert!(!dump.contains("eyJhbGciOiJIUzI1NiJ9.payload.signature"));
    }

    #[test]
    fn dashboard_table_is_primary_config_shape() {
        let config = resolve_config_from_toml(
            Some(
                r#"
[run]
enable_dashboard = false

[dashboard]
host = "localhost"
port = 4888
live_updates = false
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        assert!(!config.run.enable_dashboard);
        assert_eq!(config.dashboard.host, "localhost");
        assert_eq!(config.dashboard.port, 4888);
        assert!(!config.dashboard.live_updates);

        let dump = config.dump_redacted_toml().unwrap();
        assert!(dump.contains("[dashboard]"));
        assert!(dump.contains("enable_dashboard = false"));
        assert!(!dump.contains("[ui]"));
        assert!(!dump.contains("enable_ui"));
    }

    #[test]
    fn legacy_ui_config_names_are_rejected() {
        let top_level_error = resolve_config_from_toml(
            Some(
                r#"
[ui]
port = 4888
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err()
        .to_string();
        assert!(top_level_error.contains("unknown field `ui`"));

        let run_field_error = resolve_config_from_toml(
            Some(
                r#"
[run]
enable_ui = false
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err()
        .to_string();
        assert!(run_field_error.contains("unknown field `enable_ui`"));
    }

    #[test]
    fn rejects_invalid_strategy_and_command_policy() {
        let error = resolve_config_from_toml(
            Some(
                r#"
[strategies.encode-decode]
loops = 0
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();

        let ConfigError::Validation(errors) = error else {
            panic!("expected validation error");
        };
        assert!(errors
            .iter()
            .any(|error| error.contains("loops greater than zero")));
    }

    #[test]
    fn command_policy_denies_before_allowing() {
        let commands = CommandPolicyCommands::default();
        assert!(commands.is_command_allowed("forge test"));
        assert!(commands.is_command_allowed("solc --version"));
        assert!(commands.is_command_allowed("halmos --version"));
        assert!(commands.is_command_allowed("recon fuzz . --test-mode exploration --lcov"));
        assert!(commands.is_command_allowed("recon-generate --help"));
        assert!(commands.is_command_allowed("npx -y recon-generate@latest coverage"));
        assert!(commands.is_command_allowed("node --version"));
        assert!(commands.is_command_allowed("npm --version"));
        assert!(commands.is_command_allowed("pip show covg-eval"));
        assert!(!commands.is_command_allowed("pip install covg-eval"));
        assert!(commands.is_command_allowed("jq length findings.json"));
        assert!(commands.is_command_allowed("wc -l contracts/core/ExampleVault.sol"));
        assert!(commands.is_command_allowed("grep foo file | grep bar"));
        assert!(commands.is_command_allowed("rg --files contracts | sort | uniq"));
        assert!(commands.is_command_allowed("forge build && forge test"));
        assert!(commands.is_command_allowed("forge build 2>&1 | tail -25"));
        assert!(commands.is_command_allowed(
            "forge test --match-path test/foundry/router-exact-accounting/RouterExactInput.t.sol -vv --no-match-test zzzn 2>/dev/null"
        ));
        assert!(commands.is_command_allowed("grep -rln marketOrder test 2>/dev/null"));
        assert!(commands.is_command_allowed("forge test 2> /dev/null"));
        assert!(commands.is_command_allowed(
            "FOUNDRY_FUZZ_RUNS=4000 forge test --match-path test/foundry/round-trip/*"
        ));
        assert!(commands.is_command_allowed("timeout 120 recon --version"));
        assert!(commands
            .is_command_allowed("sha256sum test/foundry/differential/BitmapScanReference.t.sol"));
        assert!(commands.is_command_allowed("covg-eval magic/ echidna/ --return-json"));
        assert!(commands.is_command_allowed("covg_eval magic/ echidna/ --return-json"));
        assert!(!commands.is_command_allowed("curl https://example.com"));
        assert!(!commands.is_command_allowed("python -m http.server 8000"));
        assert!(!commands.is_command_allowed("forge build; forge test"));
        assert!(!commands.is_command_allowed("forge test && curl https://example.com"));
        assert!(!commands.is_command_allowed("grep foo file | python scripts/filter.py"));
        assert!(!commands.is_command_allowed("timeout 120 curl https://example.com"));
        assert!(!commands.is_command_allowed("find . -name '*.sol' -exec cat {} \\;"));
        assert!(!commands.is_command_allowed("forge test > /tmp/out"));
        assert!(!commands.is_command_allowed("forge test >/dev/null"));
        assert!(!commands.is_command_allowed("forge test 1>/dev/null"));
        assert!(!commands.is_command_allowed("forge test 2>out.log"));
        assert!(!commands.is_command_allowed("forge test 2>/tmp/out"));
        assert!(!commands.is_command_allowed("forge test 2>>/dev/null"));
        assert!(!commands.is_command_allowed(
            "cat lib/forge-std/src/Test.sol; echo \"---VERSION---\"; forge --version 2>&1 | head -5"
        ));
        assert!(commands.is_command_allowed("ls -la out coverage 2>&1"));
        assert!(!commands.is_command_allowed(
            "ls -la coverage coverage.json .coverage_artifacts out 2>/dev/null; ls -la"
        ));
        assert!(!commands.is_command_allowed(
            "grep -c \"| `core/ExampleVault.sol`\\|| `core/ExampleMarket.sol`\" artifacts/setup.md"
        ));
        assert!(commands.is_command_allowed(
            "grep -c '| `core/ExampleVault.sol`\\|| `core/ExampleMarket.sol`' artifacts/setup.md"
        ));
        assert!(commands.is_command_allowed(
            r#"grep -n "graduat\|Migrated\|5000\|6000\|parseEther(\"5\|parseEther(\"6" test/ExampleVault.test.js"#
        ));
        assert!(commands.is_command_allowed("grep -n graduat\\|Migrated test/ExampleVault.test.js"));

        let decision = commands.evaluate("git status");
        assert!(decision.allowed);
        assert_eq!(decision.matched_rule.as_deref(), Some("git"));

        let decision = commands.evaluate("python -m http.server 8000");
        assert_eq!(decision.reason, CommandPolicyReason::DeniedByRule);
        assert_eq!(
            decision.matched_rule.as_deref(),
            Some("python -m http.server")
        );

        let decision = commands.evaluate("forge build; forge test");
        assert!(matches!(
            decision.reason,
            CommandPolicyReason::UnsafeShellSyntax(_)
        ));
    }

    #[test]
    fn command_policy_rejects_commands_outside_allowlist() {
        let commands = CommandPolicyCommands::default();
        let decision = commands.evaluate("python scripts/build.py");

        assert!(!decision.allowed);
        assert_eq!(decision.reason, CommandPolicyReason::NotAllowlisted);
    }

    #[test]
    fn bundled_default_command_policy_includes_inspection_tools() {
        let config = resolve_config_from_toml(
            Some(default_config_toml()),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        let commands = &config.tools.commands;

        assert!(commands.is_command_allowed("solc --version"));
        assert!(commands.is_command_allowed("node --version"));
        assert!(commands.is_command_allowed("npm --version"));
        assert!(commands.is_command_allowed("recon-generate --help"));
        assert!(commands.is_command_allowed("pip show covg-eval"));
        assert!(commands
            .is_command_allowed("sha256sum test/foundry/differential/BitmapScanReference.t.sol"));
        assert!(commands.is_command_allowed("head -5 stdout.log"));
        assert!(commands.is_command_allowed("tail -25 stderr.log"));
        assert!(commands.is_command_allowed("rg --files contracts | sort | uniq"));
        assert!(commands.is_command_allowed("timeout 120 recon --version"));
    }

    #[test]
    fn default_sensitive_read_deny_patterns_are_required() {
        let config = CampaignConfig::default();
        for required in DEFAULT_SENSITIVE_READ_DENY {
            assert!(config
                .permissions
                .read_deny
                .iter()
                .any(|pattern| pattern.as_str() == *required));
        }

        let error = resolve_config_from_toml(
            Some(
                r#"
[permissions]
read_deny = [".env"]
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();

        let ConfigError::Validation(errors) = error else {
            panic!("expected validation error");
        };
        assert!(errors.iter().any(|error| error.contains("**/.env")));
    }

    #[test]
    fn backend_command_override_is_rejected_by_default() {
        let error = resolve_config_from_toml(
            Some(
                r#"
[backend.codex_cli]
command = "./payload"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();

        let ConfigError::Validation(errors) = error else {
            panic!("expected validation error");
        };
        assert!(errors
            .iter()
            .any(|error| error.contains("backend.codex_cli.command")));
        assert!(errors.iter().any(|error| error.contains("codex")));
    }

    #[test]
    fn dangerous_env_keys_are_rejected_by_default() {
        let error = resolve_config_from_toml(
            Some(
                r#"
[backend.codex_cli.env]
LD_PRELOAD = "/tmp/libshim.so"
PATH = "/tmp/bin"
GIT_SSH_COMMAND = "ssh -o ProxyCommand=payload"
CODEX_HOME = "/tmp/codex"

[models.default]
backend = "codex-cli"

[models.default.env]
BASH_ENV = "/tmp/startup"
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();

        let ConfigError::Validation(errors) = error else {
            panic!("expected validation error");
        };
        for key in [
            "LD_PRELOAD",
            "PATH",
            "GIT_SSH_COMMAND",
            "CODEX_HOME",
            "BASH_ENV",
        ] {
            assert!(
                errors.iter().any(|error| error.contains(key)),
                "missing validation error for {key}: {errors:?}"
            );
        }
    }

    #[test]
    fn codex_config_policy_overrides_are_rejected_by_default() {
        let error = resolve_config_from_toml(
            Some(
                r#"
[backend.codex_cli]
args = ["exec", "-c", "sandbox_workspace_write.network_access=true"]

[models.default]
backend = "codex-cli"
args = ["--config=approval_policy=on-request"]
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();

        let ConfigError::Validation(errors) = error else {
            panic!("expected validation error");
        };
        assert!(errors
            .iter()
            .any(|error| error.contains("sandbox_workspace_write.network_access")));
        assert!(errors.iter().any(|error| error.contains("approval_policy")));
    }

    #[test]
    fn codex_network_and_yolo_overrides_are_rejected_by_default() {
        let error = resolve_config_from_toml(
            Some(
                r#"
[backend.codex_cli]
args = ["exec", "--search"]

[models.default]
backend = "codex-cli"
args = ["--yolo"]

[models.web]
backend = "codex-cli"
args = ["-c", "web_search=\"live\""]

[models.profile]
backend = "codex-cli"
args = ["--profile", "danger"]
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();

        let ConfigError::Validation(errors) = error else {
            panic!("expected validation error");
        };
        for expected in ["--search", "--yolo", "web_search", "--profile"] {
            assert!(
                errors.iter().any(|error| error.contains(expected)),
                "missing validation error for {expected}: {errors:?}"
            );
        }
    }

    #[test]
    fn dangerous_permission_sandbox_requires_explicit_bypass() {
        let error = resolve_config_from_toml(
            Some(
                r#"
[permissions]
sandbox = "danger-full-access"
sandbox_required = false
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();

        let ConfigError::Validation(errors) = error else {
            panic!("expected validation error");
        };
        assert!(errors.iter().any(|error| {
            error.contains("permissions.sandbox `danger-full-access`")
                && error.contains("allow_dangerous_bypass")
        }));

        let config = resolve_config_from_toml(
            Some(
                r#"
[permissions]
sandbox = "danger-full-access"
sandbox_required = false
allow_dangerous_bypass = true
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        assert_eq!(config.permissions.sandbox, "danger-full-access");
        assert!(!config.permissions.sandbox_required);
        assert!(config.permissions.allow_dangerous_bypass);
    }

    #[test]
    fn unknown_strategy_override_is_rejected() {
        let error = resolve_config_from_toml(
            Some("[strategies.storage-layout]\nloops = 3\n"),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();

        assert!(
            matches!(error, ConfigError::UnknownStrategyOverride(id) if id == "storage-layout")
        );
    }

    #[test]
    fn old_stateful_invariants_override_is_rejected() {
        let error = resolve_config_from_toml(
            Some(
                r#"
[strategies.stateful-invariants]
enabled = false
loops = 2
timeout_seconds = 777
"#,
            ),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap_err();

        assert!(
            matches!(error, ConfigError::UnknownStrategyOverride(id) if id == "stateful-invariants")
        );
    }

    #[test]
    fn dump_uses_strategy_table_shape() {
        let strategy = StrategyDefinition {
            id: StrategyId::from("storage-layout"),
            display_name: "Storage Layout".to_owned(),
            prompt_id: PromptId::from("storage-layout"),
            prompt_path: PathBuf::from(".ultrafuzz/prompts/strategies/storage_layout.md"),
            models: Vec::new(),
            loops: 2,
            timeout: Duration::from_secs(900),
            enabled: true,
            category: StrategyCategory::Custom,
            source: StrategySource::ProjectPrompt,
        };

        let config = resolve_config_from_toml(
            None,
            vec![strategy],
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        let dump = config.dump_redacted_toml().unwrap();
        assert!(dump.contains("[strategies.storage-layout]"));
        assert!(dump.contains("timeout_seconds = 900"));
    }
}
