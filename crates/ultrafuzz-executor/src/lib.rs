use chrono::{DateTime, NaiveDateTime, NaiveTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    str::FromStr,
    sync::{atomic::AtomicBool, mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use ultrafuzz_agent::{backend_for_model_profile, AgentInput};
use ultrafuzz_artifacts::{
    is_backend_internal_artifact_dir, parse_and_normalize_findings_dir_with_model, ArtifactStore,
    ARTIFACT_MANIFEST_FILE, FINDINGS_FILE, PATCH_FILE,
};
use ultrafuzz_config::CampaignConfig;
use ultrafuzz_core::{
    finding_dedupe_key, ArtifactRef, AttemptId, BackendKind, Finding, FindingFamilyVariant,
    FindingFinalDisposition, FindingLifecycleLedger, FindingLifecycleRecord,
    FindingLifecycleSourceArtifact, FindingLifecycleStage, FindingLifecycleStageRecord,
    FindingSourceRelationship, FindingStatus, FindingStrategyDetection, FindingStrategyHit,
    ModelProfile, ModelProfileId, NodeId, NodeStatus, PromptId, RunId, RunStatus, Severity,
    StrategyId, TriageClassification, STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID,
    STATEFUL_INVARIANT_RECON_CAMPAIGN_ID,
};
use ultrafuzz_events::{emit_event, EventSink, LogStream, RunEvent};
use ultrafuzz_prompts::{
    extract_prompt_ancestor_artifact_references, extract_prompt_artifact_path_references,
    parse_prompt_document, render_template_with_artifact_paths, topology_prompt_markdown,
    validate_prompt_artifact_relative_path, validate_supported_template_variables,
    ArtifactPathRenderContext, PromptAncestorArtifactsSelector, PromptArtifactPathProducer,
    PromptRegistry, PromptRenderContext, PromptSource, RENDERED_PROMPT_FILE,
};
use ultrafuzz_references::{
    load_catalog, materialize_reference_artifacts, RUN_REFERENCE_MANIFEST_FILE,
};
use ultrafuzz_state::{
    config_fingerprint, format_token_count, spend_display, summarize_run_health,
    CostEstimateStatus, NodeState, NodeUsage, RunState, RunStateStore, TokenUsage,
    ACCOUNTING_SCHEMA_VERSION,
};
use ultrafuzz_topology::{
    prompts_root, CampaignGraph, LoopMode, Node, NodeKind, PropertyLens, RetryPolicy,
};
use ultrafuzz_workspace::{
    FilesystemWorkspaceManager, Workspace, WorkspaceManager, WorkspaceRequest,
    WORKSPACE_MANIFEST_FILE,
};

const TRIAGED_FINDINGS_FILE: &str = "triaged-findings.json";
const RUNTIME_CONTEXT_FILE: &str = "runtime-context.json";
const RUN_METADATA_DIR: &str = "run-metadata";
const FINDING_LIFECYCLE_LEDGER_FILE: &str = "finding-lifecycle-ledger.json";
const PROPERTY_SPECIFICATION_FILE: &str = "property-specification.json";
const PROPERTY_SPECIFICATION_COMPAT_DIR: &str = "property-specification";
const PROPERTY_LENS_CANDIDATE_FILE: &str = "candidate-properties.json";
const STRATEGY_DETECTIONS_FILE: &str = "strategy-detections.json";
const PROPERTY_LENS_INPUTS_FILE: &str = "lens-inputs.json";
const WORKSPACE_CHANGES_DIR: &str = "workspace-changes";
const WORKSPACE_CHANGES_MANIFEST: &str = "workspace-changes.json";
const BACKEND_ATTEMPTS_DIR: &str = "backend-attempts";
const DEPENDENCY_WORKSPACE_CHANGE_CONFLICTS_FILE: &str =
    "dependency-workspace-change-conflicts.json";
const MAX_AGENT_JSON_BYTES: u64 = 16 * 1024 * 1024;
const MAX_USAGE_LOG_BYTES: u64 = 32 * 1024 * 1024;
const MAX_BACKEND_ERROR_LOG_BYTES: u64 = 1024 * 1024;
const DEFAULT_BACKEND_CAPACITY_BACKOFF_MS: u64 = 15 * 60 * 1000;
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const COMMAND_OUTPUT_POLL_INTERVAL: Duration = Duration::from_millis(20);
const WORKSPACE_RUNTIME_GUIDANCE: &str = concat!(
    "Use the Workspace path for all repository inspection, builds, tests, and edits. The original target repository is not a command target for agent nodes; do not run commands there or derive it from artifact paths. The Workspace may be an isolated copy without `.git`; do not use `git status` to decide whether changes exist. Ultrafuzz records workspace changes after the node finishes.\n",
    "\n",
    "Do not synthesize patches by comparing files to `/dev/null` or any other outside absolute path. Wrong: `git diff --no-index /dev/null test/foundry/SetupInvariantSanity.t.sol`. If you create or edit files in the Workspace, finish after writing the required artifacts and let Ultrafuzz record workspace changes.\n",
    "\n",
    "For Read, Edit, and Write tool file paths, repository source files must also be inside the Workspace. Use the absolute Workspace path or a workspace-relative path. When expanding a workspace-relative source path to an absolute path, prefix it with the exact Workspace path shown above, including the `/workspaces/<node>` segment; never prefix it with the run root or artifact root. Never use the original target repository path for source files; if a source path is mentioned under the target repository, rewrite it to the same relative path under the Workspace before calling a file tool.\n",
    "\n",
);
const AGGREGATE_WORKSPACE_DESTINATION_GUIDANCE: &str = concat!(
    "For this aggregate-test-files node only, the Workspace is the only destination root for copied tests and support files, even if earlier prompt text says to copy into or inspect the original target repository. Do not use Bash, Read, Edit, Write, copy, or verification steps against the original target repository path. Use `materialization.aggregation_destination_dir` from the Structured context as the configured aggregation destination; it is under the Workspace.\n",
    "\n",
    "If earlier prompt text describes a destination under the original target repository, rewrite it to the same relative path under the Workspace before using any tool. In `aggregation.json`, each `destination_path` must be an absolute path under the Workspace, and each `destination_relative_path` must remain the repository-relative path such as `test/foundry/<strategy>/attempt-<n>/<file>.t.sol`. The target repository working tree and git index must not be changed by this node.\n",
    "\n",
    "Ultrafuzz pre-populates this aggregate node's Workspace from upstream `generated-tests.json` manifests and writes the required `aggregation.json` before the backend starts. Treat that manifest as the source of truth. Do not manually recreate its `files` or `support_files` arrays, and do not recopy already-present destinations. First validate the existing manifest with one standalone `jq empty` command and spot-check only a few listed destinations if needed. If a listed destination is missing, copy only that record's `source_artifact_path` to its `destination_path`, then leave the existing manifest shape intact.\n",
    "\n",
);
const AGGREGATION_ARTIFACT_CONTEXT_GUIDANCE: &str = concat!(
    "For review and aggregation nodes, dependency artifact directories and the run artifact directory are read-only campaign evidence sources. Use the Dependency Artifacts JSON, Structured context, and artifact files for prior-node evidence; do not list, read, or copy from sibling workspaces under the run root.\n",
    "\n",
    "Do not use `find` over the run artifact directory and do not write Bash loops to pre-count artifacts. For many findings files, use the explicit `standard_outputs[*].findings_json` paths from the Dependency Artifacts JSON, inspect targeted files with Read, or run one simple `jq` command for one explicit file at a time. It is acceptable to aggregate directly from the listed paths without first printing a complete count table.\n",
    "\n",
    "If a dependency appears missing in the current Workspace, first consult setup or discovery artifacts in the run artifact directory. Do not assume an absent optional package directory is a compile blocker when prior setup evidence says Foundry can run without it. If verification cannot run because a non-pinned dependency is unavailable, record that limitation and still write the required aggregation artifacts from available findings.\n",
    "\n",
);
const BASH_TOOL_GUIDANCE: &str = concat!(
    "Bash commands already run from the Workspace path. Keep every command workspace-relative; do not use `cd`, because the tool working directory may persist into later calls. Wrong: `cd /path/to/workspace || exit 1; forge --version`. Use `forge --version` by itself. Use simple single-command Bash calls for inspection, builds, tests, and JSON checks; use `jq` instead of Python for JSON validation.\n",
    "\n",
    "Claude Code permission matching runs before Ultrafuzz command-policy checks, so use one allowlisted executable per Bash call. Do not use pipes (`|`), command chains such as `&&` or `||`, semicolons, shell loops (`for`, `while`, `until`), shell conditionals (`if`, `case`, `test` brackets), background jobs, shell command substitution, `find -exec`, heredocs, stdout/stderr redirection, or file output redirection. Wrong: `rg --files contracts | sort | uniq`. Use `rg --files contracts` by itself and inspect the output as-is. Wrong: `forge build && forge test --match-path test/foundry/round-trip/*`. Run `forge build`, wait for the result, then run `forge test --match-path test/foundry/round-trip/*`. Wrong: `for f in artifacts/*/findings.json; do jq length \"$f\"; done`. Run one `jq` command against one explicit file, or inspect listed artifact paths with Read. Stderr is captured automatically; do not append `2>&1` or pipe output into `head` or `tail`. Prefer narrower command flags when they exist.\n",
    "\n",
    "Foundry validation must also use one direct Bash call per command. Wrong: `forge build 2>/dev/null; echo \"exit: $?\"`. Wrong: `forge build --skip test --no-cache 2>/dev/null; forge test --match-path 'test/foundry/workflow-property-based-tests/RegisterDepositWorkflow.t.sol' --list`. Wrong: `forge build --json 2>/dev/null | jq empty`. Run `forge build`, `forge build --skip test --no-cache`, `forge test --match-path 'test/foundry/workflow-property-based-tests/RegisterDepositWorkflow.t.sol' --list`, or `forge build --json` as separate Bash calls and inspect the tool result directly. Never add `2>/dev/null`, `2>&1`, `; echo`, or a second command to discover exit status; the Bash tool result already reports command failure and Ultrafuzz captures stderr.\n",
    "\n",
    "Invoke allowlisted tools by their command names, not absolute executable paths. Wrong: `/home/ubuntu/.foundry/bin/forge --version`. Use `forge --version`. Wrong: `/usr/bin/jq empty findings.json`. Use `jq empty findings.json`.\n",
    "\n",
    "Use direct version commands to test tool availability; do not inspect shell environment variables or host install directories. For Solidity toolchain probes, use direct commands such as `forge --version`, `solc --version`, `recon --version`, or `node --version`. If a direct version command reports command not found, record that tool as unavailable in PATH and continue from workspace/project evidence instead of searching global install paths.\n",
    "\n",
    "Prefer command flags over inline environment assignments when a tool supports them. Simple `KEY=value` prefixes on allowlisted commands are accepted for project-required toggles such as Foundry profiles or fuzz-run settings, but never put secrets in Bash commands.\n",
    "\n",
    "Run one Bash command at a time and wait for its tool result before relying on its output. Do not intentionally start commands in the background or read Claude task-output spill files such as `/tmp/claude-*`; those files are backend runtime state, not campaign evidence. Claude may report `<persisted-output>` with `Full output saved to: .../claude-config/.../tool-results/*.txt` when a command output is large. Never read, grep, cat, sed, summarize, count, or otherwise inspect that `claude-config/.../tool-results` path. If command output is missing or truncated, rerun a narrower workspace-relative command or continue from the captured stdout/stderr.\n",
    "\n",
    "For source and artifact inspection, use Read/Edit tools for precise file ranges and Bash for compact single-command checks. Safe read-only filters such as `grep`, `sed`, `jq`, `head`, `tail`, `sort`, `uniq`, and `wc` are available as standalone commands against explicit files when they make the check simpler. Markdown backticks are shell command substitution inside double quotes, so quote Markdown grep patterns with single quotes or use the Read tool.\n",
    "\n",
);
const FILE_WRITE_TOOL_GUIDANCE: &str = concat!(
    "When creating or updating campaign files, use the Edit tool. This includes generated Foundry tests under strategy attempt test directories, scratch/debug Solidity files in the Workspace, and files under the Artifact path. Use `old_string: \"\"` when creating a new file with Edit. If a backend exposes a Write tool it is also acceptable, but Claude may not expose Write in every mode, so prefer Edit.\n",
    "\n",
    "Bash may create directories with `mkdir -p` when a parent directory is missing, but Bash must not create or update file contents. Do not use Bash `cat >`, heredocs, `tee`, `touch`, `printf` redirection, `sed -i`, or any other shell file-creation or in-place-edit command. Wrong: `cat > test/foundry/round-trip/_Debug.t.sol <<'EOF'`. Bash is for one inspection, build, or test command at a time.\n",
    "\n",
    "The Artifact path and required parent directories already exist. Dependency artifact directories are read-only context: inspect them when useful, but do not create, edit, move, or remove files there. Backend-internal directories such as `claude-config/` are not campaign evidence; do not inspect, grep, summarize, edit, move, or remove them.\n\n",
);
const PRICING_AS_OF: &str = "2026-06-11";
const PROVIDER_OPENAI: &str = "openai";
const PROVIDER_ANTHROPIC: &str = "anthropic";
const OPENAI_LONG_CONTEXT_THRESHOLD: u64 = 270_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutorConfig {
    pub max_parallel_agents: usize,
    pub max_parallel_nodes: usize,
    pub default_timeout: Duration,
    pub default_retry: RetryPolicy,
}

impl ExecutorConfig {
    pub fn from_campaign_config(config: &CampaignConfig) -> Self {
        Self {
            max_parallel_agents: config.run.max_parallel_agents,
            max_parallel_nodes: config.run.max_parallel_nodes,
            default_timeout: Duration::from_secs(config.run.default_timeout_seconds),
            default_retry: RetryPolicy::default(),
        }
    }
}

impl Default for ExecutorConfig {
    fn default() -> Self {
        Self {
            max_parallel_agents: 4,
            max_parallel_nodes: 8,
            default_timeout: Duration::from_secs(1_800),
            default_retry: RetryPolicy::default(),
        }
    }
}

#[derive(Clone)]
pub struct NodeContext {
    pub run_id: RunId,
    pub node: Node,
    pub graph: CampaignGraph,
    pub project_root: PathBuf,
    pub resolved_config: CampaignConfig,
    pub artifact_store: Arc<ArtifactStore>,
    pub artifact_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub run_state: RunStateStore,
    pub event_sink: Arc<dyn EventSink>,
    pub prompt_registry: PromptRegistry,
}

#[derive(Clone, Copy, Debug)]
struct AttemptNodeRef<'a> {
    strategy: &'a StrategyId,
    attempt_index: usize,
    model_id: &'a ModelProfileId,
    model_index: usize,
    loop_index: usize,
    prompt_id: &'a PromptId,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NodeOutput {
    pub artifacts: Vec<ArtifactRef>,
}

pub trait NodeRunner: Send + Sync {
    fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunResult {
    pub run_id: RunId,
    pub status: RunStatus,
}

pub struct ExecutionRequest {
    pub graph: CampaignGraph,
    pub project_root: PathBuf,
    pub resolved_config: CampaignConfig,
    pub prompt_registry: PromptRegistry,
    pub artifact_store: ArtifactStore,
    pub state_store: RunStateStore,
    pub event_sink: Arc<dyn EventSink>,
    pub source_run_id: Option<RunId>,
}

pub struct DagExecutor {
    config: ExecutorConfig,
    runner: Arc<dyn NodeRunner>,
}

impl DagExecutor {
    pub fn new(config: ExecutorConfig, runner: Arc<dyn NodeRunner>) -> Self {
        Self { config, runner }
    }

    pub fn execute(&self, request: ExecutionRequest) -> anyhow::Result<RunResult> {
        request.graph.validate()?;
        request.artifact_store.layout().create_dirs()?;

        let graph_fingerprint = request.graph.fingerprint()?;
        let resolved_config_toml = request.resolved_config.dump_toml()?;
        let config_fingerprint = config_fingerprint(&resolved_config_toml);
        let initial_state = RunState::from_graph(
            request.graph.run_id.clone(),
            &request.graph,
            graph_fingerprint,
            config_fingerprint,
            request.source_run_id.clone(),
        );
        let mut state = request.state_store.load_or_initialize(initial_state)?;
        ensure_state_nodes(&mut state, &request.graph);
        state.status = RunStatus::Running;
        state.started_at.get_or_insert_with(now_string);
        request.state_store.save(&state)?;

        match &request.source_run_id {
            Some(source_run_id) => emit_event(
                request.event_sink.as_ref(),
                &request.graph.run_id,
                RunEvent::RunRestarted {
                    source_run_id: source_run_id.clone(),
                },
            )?,
            None => emit_event(
                request.event_sink.as_ref(),
                &request.graph.run_id,
                RunEvent::RunStarted,
            )?,
        }
        emit_reused_node_events(&state, &request)?;

        let graph_by_id = request
            .graph
            .nodes
            .iter()
            .map(|node| (node.id.clone(), node.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut running = BTreeMap::<NodeId, RunningNode>::new();
        let (completion_tx, completion_rx) = mpsc::channel::<NodeCompletion>();
        let shared_artifacts = Arc::new(request.artifact_store.clone());
        let mut backend_deferrals = BackendDeferrals::from_state(&state);
        let mut fatal_failure = false;
        let mut fatal_error = None::<String>;

        loop {
            let mut made_progress = false;
            if !fatal_failure {
                made_progress |= self.mark_ready_nodes(&request.graph, &mut state, &request)?;
                made_progress |= self.start_ready_nodes(
                    &request.graph,
                    &mut state,
                    &request,
                    &mut running,
                    NodeLaunchResources {
                        completion_tx: &completion_tx,
                        artifact_store: shared_artifacts.clone(),
                        backend_deferrals: &backend_deferrals,
                    },
                )?;
            }

            if running.is_empty() {
                if fatal_failure {
                    skip_unfinished_nodes(&request.graph, &mut state, &request)?;
                    state.status = RunStatus::Failed;
                    state.finished_at = Some(now_string());
                    request.state_store.save(&state)?;
                    emit_event(
                        request.event_sink.as_ref(),
                        &request.graph.run_id,
                        RunEvent::RunFailed {
                            error: fatal_error.unwrap_or_else(|| "node failed".to_owned()),
                        },
                    )?;
                    return Ok(RunResult {
                        run_id: request.graph.run_id,
                        status: RunStatus::Failed,
                    });
                }

                if all_nodes_finished(&state) {
                    state.status = RunStatus::Succeeded;
                    state.finished_at = Some(now_string());
                    request.state_store.save(&state)?;
                    emit_event(
                        request.event_sink.as_ref(),
                        &request.graph.run_id,
                        RunEvent::RunFinished,
                    )?;
                    return Ok(RunResult {
                        run_id: request.graph.run_id,
                        status: RunStatus::Succeeded,
                    });
                }
            }

            if let Some((node_id, error)) = self.detect_timeout(&mut running) {
                let node = graph_by_id.get(&node_id).ok_or_else(|| {
                    anyhow::anyhow!(
                        "detected timeout for node `{node_id}` that is not in the campaign graph"
                    )
                })?;
                if let Some(output) = completed_agentic_timeout_output(node, &request)? {
                    mark_node_succeeded(node, output, &mut state, &request)?;
                    continue;
                }
                mark_node_timed_out(node, &error, &mut state, &request)?;
                if retry_node(&node_id, &graph_by_id, &mut state, &request)? {
                    continue;
                }
                fatal_failure = true;
                fatal_error = Some(error);
                continue;
            }

            match completion_rx.recv_timeout(Duration::from_millis(20)) {
                Ok(completion) => {
                    if running
                        .get(&completion.node_id)
                        .is_none_or(|node| node.generation != completion.generation)
                    {
                        continue;
                    }
                    let Some(mut running_node) = running.remove(&completion.node_id) else {
                        continue;
                    };
                    if let Some(handle) = running_node.handle.take() {
                        let _ = handle.join();
                    }
                    publish_attempt_outputs(&running_node)?;
                    let result = completion.result.map(|output| {
                        canonicalize_node_output(
                            output,
                            &running_node.attempt_artifacts_root,
                            &running_node.canonical_artifacts_root,
                        )
                    });
                    let node = graph_by_id.get(&completion.node_id).ok_or_else(|| {
                        anyhow::anyhow!(
                            "received completion for node `{}` that is not in the campaign graph",
                            completion.node_id
                        )
                    })?;
                    let timed_out_after_completion =
                        completion.elapsed > self.effective_timeout(node);
                    match (result, timed_out_after_completion) {
                        (Ok(output), false) => {
                            mark_node_succeeded(node, output, &mut state, &request)?;
                        }
                        (Ok(_), true) => {
                            let error = format!("node `{}` exceeded timeout", node.id);
                            if let Some(output) = completed_agentic_timeout_output(node, &request)?
                            {
                                mark_node_succeeded(node, output, &mut state, &request)?;
                                continue;
                            }
                            mark_node_timed_out(node, &error, &mut state, &request)?;
                            if retry_node(&node.id, &graph_by_id, &mut state, &request)? {
                                continue;
                            }
                            fatal_failure = true;
                            fatal_error = Some(error);
                        }
                        (Err(error), _) => {
                            if let Some(deferral) =
                                backend_capacity_deferral(node, &error, &request)?
                            {
                                backend_deferrals
                                    .defer(deferral.backend, deferral.retry_after_epoch_ms);
                                mark_node_backend_deferred(node, &deferral, &mut state, &request)?;
                                continue;
                            }
                            mark_node_failed(node, &error, &mut state, &request)?;
                            if retry_node(&node.id, &graph_by_id, &mut state, &request)? {
                                continue;
                            }
                            fatal_failure = true;
                            fatal_error = Some(error);
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if running.is_empty()
                        && !all_nodes_finished(&state)
                        && !fatal_failure
                        && !made_progress
                    {
                        if let Some(delay) =
                            deferred_work_sleep_duration(&state, &backend_deferrals)
                        {
                            thread::sleep(delay);
                            continue;
                        }
                        return Err(anyhow::anyhow!(
                            "executor made no progress; graph may have unsatisfied dependencies"
                        ));
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(anyhow::anyhow!("node completion channel disconnected"));
                }
            }
        }
    }

    fn mark_ready_nodes(
        &self,
        graph: &CampaignGraph,
        state: &mut RunState,
        request: &ExecutionRequest,
    ) -> anyhow::Result<bool> {
        let mut changed = false;
        let now_ms = current_epoch_ms();
        for node in &graph.nodes {
            let status = state.nodes[&node.id].status;
            if status != NodeStatus::Pending {
                continue;
            }
            if let Some(retry_after_epoch_ms) = state.nodes[&node.id].retry_after_epoch_ms {
                if retry_after_epoch_ms > now_ms {
                    continue;
                }
                node_state_mut(state, &node.id)?.retry_after_epoch_ms = None;
                changed = true;
            }
            if node.depends_on.iter().all(|dependency| {
                state
                    .nodes
                    .get(dependency)
                    .is_some_and(|state| is_dependency_satisfied(state.status))
            }) {
                let node_state = node_state_mut(state, &node.id)?;
                node_state.status = NodeStatus::Ready;
                changed = true;
                emit_event(
                    request.event_sink.as_ref(),
                    &graph.run_id,
                    RunEvent::NodeReady {
                        node_id: node.id.clone(),
                    },
                )?;
            }
        }
        if changed {
            request.state_store.save(state)?;
        }
        Ok(changed)
    }

    fn start_ready_nodes(
        &self,
        graph: &CampaignGraph,
        state: &mut RunState,
        request: &ExecutionRequest,
        running: &mut BTreeMap<NodeId, RunningNode>,
        resources: NodeLaunchResources<'_>,
    ) -> anyhow::Result<bool> {
        let mut changed = false;
        for node in &graph.nodes {
            if state.nodes[&node.id].status != NodeStatus::Ready {
                continue;
            }
            if is_agent_node(node) {
                let backend = backend_for_node(node, &request.resolved_config)?;
                if resources
                    .backend_deferrals
                    .is_deferred(backend, current_epoch_ms())
                {
                    continue;
                }
            }
            if is_meta_node(node) {
                complete_meta_node(node, graph, state, request)?;
                changed = true;
                continue;
            }
            if running.len() >= self.config.max_parallel_nodes {
                break;
            }
            if is_agent_node(node)
                && running.values().filter(|node| node.is_agent).count()
                    >= self.config.max_parallel_agents
            {
                continue;
            }

            let node_state = node_state_mut(state, &node.id)?;
            let generation = node_state.retry_count;
            let canonical_artifacts_root = resources.artifact_store.layout().artifacts.clone();
            let attempt_artifacts_root =
                attempt_artifacts_root(resources.artifact_store.layout(), &node.id, generation);
            let canonical_artifact_dir = resources.artifact_store.layout().artifact_dir(&node.id);
            let canonical_workspace_dir = resources.artifact_store.layout().workspace_dir(&node.id);
            let attempt_artifact_dir =
                attempt_artifact_dir(resources.artifact_store.layout(), &node.id, generation);
            let attempt_workspace_dir =
                attempt_workspace_dir(resources.artifact_store.layout(), &node.id, generation);
            reset_dir(&attempt_artifacts_root)?;
            reset_dir(&attempt_workspace_dir)?;
            remove_path_if_exists(&canonical_artifact_dir)?;
            remove_path_if_exists(&canonical_workspace_dir)?;
            for artifact_dir in
                extra_canonical_artifact_dirs_for_attempt(resources.artifact_store.layout(), node)
            {
                remove_path_if_exists(&artifact_dir)?;
            }
            fs::create_dir_all(&attempt_artifact_dir)?;
            fs::create_dir_all(&attempt_workspace_dir)?;
            node_state.status = NodeStatus::Running;
            node_state.started_at = Some(now_string());
            if generation == 0 {
                node_state.usage = None;
            }
            node_state.retry_after_epoch_ms = None;
            if uses_default_backend_metadata(node) {
                apply_default_backend_metadata(node_state, &request.resolved_config)?;
            }
            changed = true;

            emit_event(
                request.event_sink.as_ref(),
                &graph.run_id,
                RunEvent::NodeStarted {
                    node_id: node.id.clone(),
                },
            )?;
            if let NodeKind::AgentAttempt {
                strategy,
                attempt_index,
                model_id,
                model_index,
                loop_index,
                ..
            } = &node.kind
            {
                let profile = request
                    .resolved_config
                    .model_profile(model_id)
                    .ok_or_else(|| anyhow::anyhow!("missing model profile `{model_id}`"))?;
                node_state.backend = Some(profile.backend);
                node_state.model_id = Some(model_id.clone());
                node_state.model = profile.model.clone();
                node_state.model_index = Some(*model_index);
                node_state.loop_index = Some(*loop_index);
                emit_event(
                    request.event_sink.as_ref(),
                    &graph.run_id,
                    RunEvent::AttemptStarted {
                        attempt_id: attempt_id_for_node(node),
                        node_id: node.id.clone(),
                        strategy: strategy.clone(),
                        attempt_index: *attempt_index,
                        model_id: model_id.clone(),
                        model_index: *model_index,
                        loop_index: *loop_index,
                    },
                )?;
                emit_event(
                    request.event_sink.as_ref(),
                    &graph.run_id,
                    RunEvent::BackendStarted {
                        node_id: node.id.clone(),
                        backend: profile.backend,
                        model_id: model_id.clone(),
                        model: profile.model.clone(),
                    },
                )?;
            }
            if let NodeKind::Agentic {
                logical_id,
                attempt_index,
                ..
            } = &node.kind
            {
                let (model_id, model_profile) =
                    default_model_profile_for_agentic(&request.resolved_config)?;
                node_state.backend = Some(model_profile.backend);
                node_state.model_id = Some(model_id.clone());
                node_state.model = model_profile.model.clone();
                node_state.model_index = Some(0);
                node_state.loop_index = Some(*attempt_index);
                emit_event(
                    request.event_sink.as_ref(),
                    &graph.run_id,
                    RunEvent::AttemptStarted {
                        attempt_id: AttemptId::from(format!("{logical_id}-{attempt_index}")),
                        node_id: node.id.clone(),
                        strategy: StrategyId::from(logical_id.to_string()),
                        attempt_index: *attempt_index,
                        model_id: model_id.clone(),
                        model_index: 0,
                        loop_index: *attempt_index,
                    },
                )?;
                emit_event(
                    request.event_sink.as_ref(),
                    &graph.run_id,
                    RunEvent::BackendStarted {
                        node_id: node.id.clone(),
                        backend: model_profile.backend,
                        model_id,
                        model: model_profile.model.clone(),
                    },
                )?;
            }

            let retirement = Arc::new(AttemptRetirement::default());
            let ctx = NodeContext {
                run_id: graph.run_id.clone(),
                node: node.clone(),
                graph: graph.clone(),
                project_root: request.project_root.clone(),
                resolved_config: request.resolved_config.clone(),
                artifact_store: resources.artifact_store.clone(),
                artifact_dir: attempt_artifact_dir.clone(),
                workspace_dir: attempt_workspace_dir.clone(),
                run_state: request.state_store.clone(),
                event_sink: Arc::new(RetiringEventSink {
                    inner: request.event_sink.clone(),
                    retirement: retirement.clone(),
                    path_rewrites: vec![
                        PathRewrite {
                            from: attempt_artifacts_root.clone(),
                            to: canonical_artifacts_root.clone(),
                        },
                        PathRewrite {
                            from: attempt_workspace_dir.clone(),
                            to: canonical_workspace_dir.clone(),
                        },
                    ],
                }),
                prompt_registry: request.prompt_registry.clone(),
            };
            let runner = self.runner.clone();
            let tx = resources.completion_tx.clone();
            let node_id = node.id.clone();
            let started = Instant::now();
            let handle = thread::spawn(move || {
                let result = runner.run(ctx).map_err(|err| err.to_string());
                let elapsed = started.elapsed();
                let _ = tx.send(NodeCompletion {
                    node_id,
                    generation,
                    result,
                    elapsed,
                });
            });
            running.insert(
                node.id.clone(),
                RunningNode {
                    is_agent: is_agent_node(node),
                    generation,
                    started,
                    timeout: self.effective_timeout(node),
                    handle: Some(handle),
                    retirement,
                    attempt_artifacts_root,
                    canonical_artifacts_root,
                    attempt_workspace_dir,
                    canonical_workspace_dir,
                },
            );
        }
        if changed {
            request.state_store.save(state)?;
        }
        Ok(changed)
    }

    fn detect_timeout(
        &self,
        running: &mut BTreeMap<NodeId, RunningNode>,
    ) -> Option<(NodeId, String)> {
        let timed_out = running
            .iter()
            .find(|(_, node)| node.started.elapsed() > node.timeout)
            .map(|(node_id, node)| {
                (
                    node_id.clone(),
                    format!("node `{node_id}` exceeded timeout of {:?}", node.timeout),
                )
            });
        if let Some((node_id, error)) = &timed_out {
            // A timed-out worker may be stuck inside the runner. Dropping the
            // join handle retires the scheduler entry without blocking timeout
            // state transitions, retries, or fail-fast handling.
            if let Some(running_node) = running.remove(node_id) {
                running_node.retirement.retire();
            }
            return Some((node_id.clone(), error.clone()));
        }
        None
    }

    fn effective_timeout(&self, node: &Node) -> Duration {
        node.timeout.unwrap_or(self.config.default_timeout)
    }
}

fn attempt_artifact_dir(
    layout: &ultrafuzz_artifacts::RunLayout,
    node_id: &NodeId,
    generation: usize,
) -> PathBuf {
    attempt_artifacts_root(layout, node_id, generation).join(node_id.as_str())
}

fn attempt_workspace_dir(
    layout: &ultrafuzz_artifacts::RunLayout,
    node_id: &NodeId,
    generation: usize,
) -> PathBuf {
    attempt_root(layout, node_id, generation)
        .join("workspaces")
        .join(node_id.as_str())
}

fn attempt_artifacts_root(
    layout: &ultrafuzz_artifacts::RunLayout,
    node_id: &NodeId,
    generation: usize,
) -> PathBuf {
    attempt_root(layout, node_id, generation).join("artifacts")
}

fn attempt_root(
    layout: &ultrafuzz_artifacts::RunLayout,
    node_id: &NodeId,
    generation: usize,
) -> PathBuf {
    layout
        .root
        .join(".attempts")
        .join(node_id.as_str())
        .join(generation.to_string())
}

fn reset_dir(path: &Path) -> io::Result<()> {
    remove_path_if_exists(path)?;
    fs::create_dir_all(path)
}

fn remove_path_if_exists(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)
        }
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn extra_canonical_artifact_dirs_for_attempt(
    layout: &ultrafuzz_artifacts::RunLayout,
    node: &Node,
) -> Vec<PathBuf> {
    if writes_property_specification_compatibility_artifacts(node) {
        vec![layout.artifact_dir(&NodeId::from(PROPERTY_SPECIFICATION_COMPAT_DIR))]
    } else {
        Vec::new()
    }
}

fn writes_property_specification_compatibility_artifacts(node: &Node) -> bool {
    match &node.kind {
        NodeKind::PropertySpecificationFanIn => true,
        NodeKind::Agentic {
            logical_id,
            required_artifacts,
            ..
        } => {
            logical_id.as_str() == "property-specification-fanin"
                && required_artifacts
                    .iter()
                    .any(|path| path.as_path() == Path::new(PROPERTY_SPECIFICATION_FILE))
        }
        _ => false,
    }
}

fn publish_attempt_outputs(running_node: &RunningNode) -> anyhow::Result<()> {
    publish_attempt_artifacts_root(
        &running_node.attempt_artifacts_root,
        &running_node.canonical_artifacts_root,
    )?;
    publish_attempt_dir(
        &running_node.attempt_workspace_dir,
        &running_node.canonical_workspace_dir,
    )?;
    Ok(())
}

fn publish_attempt_artifacts_root(attempt_root: &Path, canonical_root: &Path) -> io::Result<()> {
    if !attempt_root.exists() {
        return Ok(());
    }
    fs::create_dir_all(canonical_root)?;
    for entry in fs::read_dir(attempt_root)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let source_path = entry.path();
        let destination_path = canonical_root.join(entry.file_name());
        if file_type.is_dir() {
            publish_attempt_dir(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            remove_path_if_exists(&destination_path)?;
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn publish_attempt_dir(attempt_dir: &Path, canonical_dir: &Path) -> io::Result<()> {
    remove_path_if_exists(canonical_dir)?;
    fs::create_dir_all(canonical_dir)?;
    if !attempt_dir.exists() {
        return Ok(());
    }
    copy_regular_dir_contents(attempt_dir, canonical_dir)
}

fn copy_regular_dir_contents(source: &Path, destination: &Path) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if file_type.is_dir() {
            fs::create_dir_all(&destination_path)?;
            copy_regular_dir_contents(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn canonicalize_node_output(
    mut output: NodeOutput,
    attempt_artifacts_root: &Path,
    canonical_artifacts_root: &Path,
) -> NodeOutput {
    for artifact in &mut output.artifacts {
        if let Ok(relative) = artifact.path.strip_prefix(attempt_artifacts_root) {
            artifact.path = canonical_artifacts_root.join(relative);
        }
    }
    output
}

impl Default for DagExecutor {
    fn default() -> Self {
        Self::new(ExecutorConfig::default(), Arc::new(SyntheticNodeRunner))
    }
}

#[derive(Debug)]
struct RunningNode {
    is_agent: bool,
    generation: usize,
    started: Instant,
    timeout: Duration,
    handle: Option<thread::JoinHandle<()>>,
    retirement: Arc<AttemptRetirement>,
    attempt_artifacts_root: PathBuf,
    canonical_artifacts_root: PathBuf,
    attempt_workspace_dir: PathBuf,
    canonical_workspace_dir: PathBuf,
}

struct NodeCompletion {
    node_id: NodeId,
    generation: usize,
    result: Result<NodeOutput, String>,
    elapsed: Duration,
}

struct NodeLaunchResources<'a> {
    completion_tx: &'a mpsc::Sender<NodeCompletion>,
    artifact_store: Arc<ArtifactStore>,
    backend_deferrals: &'a BackendDeferrals,
}

#[derive(Debug, Default)]
struct AttemptRetirement {
    retired: AtomicBool,
}

impl AttemptRetirement {
    fn retire(&self) {
        self.retired
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn is_retired(&self) -> bool {
        self.retired.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[derive(Clone, Debug)]
struct PathRewrite {
    from: PathBuf,
    to: PathBuf,
}

struct RetiringEventSink {
    inner: Arc<dyn EventSink>,
    retirement: Arc<AttemptRetirement>,
    path_rewrites: Vec<PathRewrite>,
}

impl EventSink for RetiringEventSink {
    fn emit(&self, mut record: ultrafuzz_events::EventRecord) -> anyhow::Result<()> {
        if self.retirement.is_retired() {
            return Ok(());
        }
        rewrite_event_paths(&mut record.payload, &self.path_rewrites);
        self.inner.emit(record)
    }
}

fn rewrite_event_paths(value: &mut Value, rewrites: &[PathRewrite]) {
    match value {
        Value::String(text) => {
            let path = Path::new(text);
            for rewrite in rewrites {
                if let Ok(relative) = path.strip_prefix(&rewrite.from) {
                    *text = rewrite.to.join(relative).display().to_string();
                    break;
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                rewrite_event_paths(value, rewrites);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                rewrite_event_paths(value, rewrites);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[derive(Clone, Debug, Default)]
struct BackendDeferrals {
    retry_after_by_backend: BTreeMap<String, u64>,
}

impl BackendDeferrals {
    fn from_state(state: &RunState) -> Self {
        let mut deferrals = Self::default();
        for node_state in state.nodes.values() {
            if let (Some(backend), Some(retry_after_epoch_ms)) =
                (node_state.backend, node_state.retry_after_epoch_ms)
            {
                deferrals.defer(backend, retry_after_epoch_ms);
            }
        }
        deferrals
    }

    fn defer(&mut self, backend: BackendKind, retry_after_epoch_ms: u64) {
        let entry = self
            .retry_after_by_backend
            .entry(backend.to_string())
            .or_insert(0);
        *entry = (*entry).max(retry_after_epoch_ms);
    }

    fn is_deferred(&self, backend: BackendKind, now_epoch_ms: u64) -> bool {
        self.retry_after_by_backend
            .get(&backend.to_string())
            .is_some_and(|retry_after_epoch_ms| *retry_after_epoch_ms > now_epoch_ms)
    }

    fn next_retry_after_epoch_ms(&self, now_epoch_ms: u64) -> Option<u64> {
        self.retry_after_by_backend
            .values()
            .copied()
            .filter(|retry_after_epoch_ms| *retry_after_epoch_ms > now_epoch_ms)
            .min()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct BackendCapacityDeferral {
    backend: BackendKind,
    retry_after_epoch_ms: u64,
    message: String,
}

#[derive(Clone, Debug)]
struct ParsedUsageRecord {
    provider: &'static str,
    model: Option<String>,
    tokens: TokenUsage,
    raw_usage: Value,
}

#[derive(Clone, Debug)]
struct UsageCandidate {
    key: String,
    tokens: TokenUsage,
    raw_usage: Value,
    model: Option<String>,
    kind: AnthropicUsageKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AnthropicUsageKind {
    Message,
    Result,
}

#[derive(Clone, Copy, Debug)]
struct OpenAiRates {
    input_per_million: f64,
    cached_input_per_million: Option<f64>,
    output_per_million: f64,
}

#[derive(Clone, Copy, Debug)]
struct AnthropicRates {
    input_per_million: f64,
    cache_write_5m_per_million: f64,
    cache_write_1h_per_million: f64,
    cache_read_per_million: f64,
    output_per_million: f64,
}

#[derive(Clone)]
pub struct CampaignNodeRunner {
    workspace_manager: Arc<dyn WorkspaceManager>,
    workspace_lock: Arc<Mutex<()>>,
}

impl CampaignNodeRunner {
    pub fn new(workspace_manager: Arc<dyn WorkspaceManager>) -> Self {
        Self {
            workspace_manager,
            workspace_lock: Arc::new(Mutex::new(())),
        }
    }

    fn cleanup_workspace_after_failure(
        &self,
        workspace: Workspace,
        keep_workspaces: bool,
        artifact_dir: &Path,
    ) {
        if keep_workspaces {
            return;
        }
        if let Err(error) = self.cleanup_workspace(workspace) {
            let _ = write_artifact(artifact_dir, "cleanup-error.log", format!("{error}\n"));
        }
    }

    fn cleanup_workspace(&self, workspace: Workspace) -> anyhow::Result<()> {
        let _guard = self
            .workspace_lock
            .lock()
            // The mutex serializes git worktree add/remove operations and
            // guards no data, so a poisoned lock is safe to recover.
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.workspace_manager.cleanup(workspace)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "agentic node execution keeps topology metadata explicit at the call site"
    )]
    fn run_agentic(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
        logical_id: &NodeId,
        prompt_path: &Path,
        attempt_index: usize,
        loop_count: usize,
        loop_mode: LoopMode,
        required_artifacts: &[PathBuf],
    ) -> anyhow::Result<NodeOutput> {
        fs::create_dir_all(artifact_dir)?;
        prepare_required_artifact_parent_dirs(artifact_dir, required_artifacts)?;
        let repo = target_repo(&ctx.resolved_config)?;
        let workspace_path = ctx.workspace_dir.clone();
        let workspace = {
            let _guard = self
                .workspace_lock
                .lock()
                // The mutex serializes git worktree add/remove operations and
                // guards no data, so a poisoned lock is safe to recover.
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.workspace_manager.create(WorkspaceRequest::attempt(
                ctx.run_id.clone(),
                ctx.node.id.clone(),
                &repo,
                &workspace_path,
                artifact_dir,
                ctx.resolved_config.run.workspace_mode,
                ctx.resolved_config.run.keep_workspaces,
            ))?
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCreated {
                node_id: ctx.node.id.clone(),
                path: workspace.path.clone(),
            },
        )?;

        if !ctx
            .resolved_config
            .permissions
            .allow_target_repo_writes_during_attempts
            && same_canonical_path(&workspace.path, &repo)
        {
            let _ = self.cleanup_workspace(workspace);
            anyhow::bail!(
                "agentic node workspace `{}` resolves to target repo `{}`; writable target repo agent nodes are disabled",
                workspace_path.display(),
                repo.display()
            );
        }

        if let Err(error) = apply_dependency_workspace_changes(ctx, &workspace.path) {
            self.cleanup_workspace_after_failure(
                workspace,
                ctx.resolved_config.run.keep_workspaces,
                artifact_dir,
            );
            return Err(error);
        }
        let workspace_change_baseline =
            match workspace_change_baseline_after_dependencies(&workspace.path, &repo) {
                Ok(baseline) => baseline,
                Err(error) => {
                    self.cleanup_workspace_after_failure(
                        workspace,
                        ctx.resolved_config.run.keep_workspaces,
                        artifact_dir,
                    );
                    return Err(error);
                }
            };

        let output_findings_path = artifact_dir.join(FINDINGS_FILE);
        let output_patch_path = artifact_dir.join(PATCH_FILE);
        let output_metadata_path = artifact_dir.join("metadata.json");
        if logical_id.as_str() == "aggregate-test-files" {
            if let Err(error) =
                prepare_agentic_aggregate_workspace(ctx, artifact_dir, &workspace.path)
            {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
            if let Err(error) = write_artifact(artifact_dir, FINDINGS_FILE, "[]\n") {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        }
        let prompt_path = match render_agentic_prompt(
            ctx,
            artifact_dir,
            &repo,
            &workspace.path,
            logical_id,
            prompt_path,
            attempt_index,
            loop_count,
            loop_mode,
            &output_findings_path,
            &output_patch_path,
            &output_metadata_path,
            required_artifacts,
        ) {
            Ok(path) => path,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::PromptRendered {
                node_id: ctx.node.id.clone(),
                path: prompt_path.clone(),
            },
        )?;

        if logical_id.as_str() == "final-report" {
            if let Err(error) = validate_final_report_lifecycle_inputs(ctx) {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        }

        let prompt = fs::read_to_string(&prompt_path)?;
        let (model_id, model_profile) = default_model_profile_for_agentic(&ctx.resolved_config)?;
        let backend = backend_for_model_profile(&ctx.resolved_config, &repo, model_profile);
        let extra_context_dirs = agentic_extra_context_dirs(ctx);
        let agent_result = backend.run(AgentInput {
            run_id: ctx.run_id.clone(),
            node_id: ctx.node.id.clone(),
            strategy: StrategyId::from(logical_id.to_string()),
            attempt_index,
            model_id: Some(model_id),
            model: model_profile.model.clone(),
            model_index: Some(0),
            loop_index: Some(attempt_index),
            prompt,
            workspace_path: workspace.path.clone(),
            artifact_dir: artifact_dir.to_path_buf(),
            extra_context_dirs,
            output_findings_path: output_findings_path.clone(),
            output_patch_path: output_patch_path.clone(),
            output_metadata_path: output_metadata_path.clone(),
            timeout: ctx.node.timeout.unwrap_or_else(|| {
                Duration::from_secs(ctx.resolved_config.run.default_timeout_seconds)
            }),
        });

        let agent_output = match agent_result {
            Ok(output) => output,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error.into());
            }
        };

        for required in required_artifacts {
            let path = artifact_dir.join(required);
            if !path.exists() {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                anyhow::bail!(
                    "node `{}` did not produce required artifact `{}`",
                    ctx.node.id,
                    required.display()
                );
            }
        }
        if logical_id.as_str() == "aggregate-test-files" {
            if let Err(error) =
                validate_agentic_aggregate_workspace_outputs(artifact_dir, &workspace.path)
            {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        }
        let compatibility_artifacts = match mirror_agentic_compatibility_artifacts(
            ctx,
            artifact_dir,
            logical_id,
            required_artifacts,
            &output_findings_path,
        ) {
            Ok(artifacts) => artifacts,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        };

        let workspace_changes = match persist_workspace_changes(
            &workspace.path,
            &repo,
            artifact_dir,
            &workspace_change_baseline,
        ) {
            Ok(workspace_changes) => workspace_changes,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        };

        let strategy_id = StrategyId::from(logical_id.to_string());
        let model_id = ctx.resolved_config.models.default.clone();
        let prompt_id = PromptId::from(logical_id.to_string());
        let attempt_ref = AttemptNodeRef {
            strategy: &strategy_id,
            attempt_index,
            model_id: &model_id,
            model_index: 0,
            loop_index: attempt_index,
            prompt_id: &prompt_id,
        };
        let model = ctx
            .resolved_config
            .model_profile(&model_id)
            .and_then(|profile| profile.model.as_deref());
        let generated_tests = match collect_generated_tests_from_workspace(
            &workspace.path,
            &repo,
            artifact_dir,
            &ctx.node.id,
            attempt_ref,
            model,
        ) {
            Ok(generated_tests) => generated_tests,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        };

        let cleanup_error = if ctx.resolved_config.run.keep_workspaces {
            None
        } else {
            self.cleanup_workspace(workspace)
                .err()
                .map(|err| err.to_string())
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCleaned {
                node_id: ctx.node.id.clone(),
            },
        )?;

        let mut artifacts = Vec::new();
        artifacts.push(ArtifactRef::new(prompt_path));
        push_if_exists(&mut artifacts, artifact_dir.join("stdout.log"));
        push_if_exists(&mut artifacts, artifact_dir.join("stderr.log"));
        push_if_exists(&mut artifacts, artifact_dir.join("transcript.json"));
        push_if_exists(&mut artifacts, output_findings_path);
        if let Some(path) = agent_output.patch_path {
            emit_event(
                ctx.event_sink.as_ref(),
                &ctx.run_id,
                RunEvent::PatchCreated {
                    node_id: ctx.node.id.clone(),
                    path: path.clone(),
                },
            )?;
            artifacts.push(ArtifactRef::new(path));
        } else {
            push_if_exists(&mut artifacts, output_patch_path);
        }
        if let Some(path) = agent_output.metadata_path {
            artifacts.push(ArtifactRef::new(path));
        } else {
            push_if_exists(&mut artifacts, output_metadata_path);
        }
        for path in compatibility_artifacts {
            artifacts.push(ArtifactRef::new(path));
        }
        artifacts.push(ArtifactRef::new(generated_tests.manifest_path));
        for path in generated_tests.artifact_paths {
            artifacts.push(ArtifactRef::new(path));
        }
        artifacts.push(ArtifactRef::new(workspace_changes.manifest_path));
        for path in workspace_changes.artifact_paths {
            artifacts.push(ArtifactRef::new(path));
        }
        for path in collect_artifact_files(artifact_dir)? {
            if !artifacts.iter().any(|artifact| artifact.path == path) {
                artifacts.push(ArtifactRef::new(path));
            }
        }
        if let Some(cleanup_error) = cleanup_error {
            artifacts.push(ArtifactRef::new(write_artifact(
                artifact_dir,
                "cleanup-error.log",
                format!("{cleanup_error}\n"),
            )?));
        }
        emit_finding_created_if_nonempty(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            &ctx.node.id,
            artifact_dir.join(FINDINGS_FILE),
        )?;
        Ok(NodeOutput { artifacts })
    }

    fn run_reference(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
        reference: &ultrafuzz_core::ReferenceId,
        required_artifacts: &[PathBuf],
        primary_artifact: Option<&Path>,
    ) -> anyhow::Result<NodeOutput> {
        let catalog = load_catalog(&ctx.project_root)?;
        let materialized = materialize_reference_artifacts(
            &catalog,
            reference,
            artifact_dir,
            required_artifacts,
            primary_artifact,
        )?;
        Ok(NodeOutput {
            artifacts: vec![
                ArtifactRef::new(materialized.reference_artifact),
                ArtifactRef::new(materialized.manifest_artifact),
            ],
        })
    }

    fn run_project_discovery(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
    ) -> anyhow::Result<NodeOutput> {
        let repo = target_repo(&ctx.resolved_config)?;
        let discovery = discover_project(&repo);
        let mut artifacts = basic_logs(artifact_dir, "project discovery completed\n")?;
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            "discovery.json",
            &json!({
                "schema_version": "1.0",
                "repo": ctx.resolved_config.project.repo,
                "project_name": ctx.resolved_config.project.name,
                "framework": discovery.framework,
                "is_hardhat": discovery.is_hardhat,
                "is_foundry": discovery.is_foundry,
                "has_foundry_toml": discovery.has_foundry_toml,
                "hardhat_configs": discovery.hardhat_configs,
                "source_dirs": discovery.source_dirs,
                "production_source_dir": discovery.production_source_dir,
                "generated_test_dir": "test/foundry",
                "decisions": discovery.decisions,
            }),
        )?));
        artifacts.push(ArtifactRef::new(write_runner_metadata(
            ctx,
            artifact_dir,
            "project-discovery",
            json!({
                "framework": discovery.framework,
                "is_hardhat": discovery.is_hardhat,
                "is_foundry": discovery.is_foundry,
            }),
        )?));
        Ok(NodeOutput { artifacts })
    }

    fn run_prepare_foundry_harness(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
    ) -> anyhow::Result<NodeOutput> {
        let repo = target_repo(&ctx.resolved_config)?;
        let discovery = discover_project(&repo);
        let staged_before = git_status_index(&repo).unwrap_or_default();
        let mut changed_files = Vec::new();
        let mut notes = Vec::new();
        let hardhat_setup_applied = discovery.is_hardhat && !discovery.is_foundry;

        if hardhat_setup_applied {
            let foundry_toml = repo.join("foundry.toml");
            let before = fs::read_to_string(&foundry_toml).ok();
            ensure_hardhat_foundry_toml(&foundry_toml)?;
            if before.as_deref() != fs::read_to_string(&foundry_toml).ok().as_deref() {
                changed_files.push(PathBuf::from("foundry.toml"));
            }
            fs::create_dir_all(repo.join("test/foundry"))?;
            notes.push(
                "Hardhat project detected; Foundry fuzzing config uses contracts/ sources and test/foundry tests.",
            );
        } else if discovery.is_foundry {
            if discovery.is_hardhat {
                notes.push(
                    "Foundry and Hardhat markers detected; existing Foundry setup was retained without migration changes.",
                );
            } else {
                notes.push("Foundry project detected; no migration setup was applied.");
            }
        } else {
            notes.push(
                "No Hardhat or Foundry marker was detected; generated tests will still aggregate under test/foundry.",
            );
        }

        let staged_after = git_status_index(&repo).unwrap_or_default();
        let mut artifacts = basic_logs(artifact_dir, "Foundry harness preparation completed\n")?;
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            "harness-preparation.json",
            &json!({
                "schema_version": "1.0",
                "framework": discovery.framework,
                "target_repo": repo,
                "hardhat_setup_applied": hardhat_setup_applied,
                "foundry_toml": "foundry.toml",
                "production_source_dir": if hardhat_setup_applied { "contracts" } else { discovery.production_source_dir.as_str() },
                "generated_test_dir": "test/foundry",
                "changed_files": changed_files,
                "staged_index_changed": staged_before != staged_after,
                "notes": notes,
            }),
        )?));
        artifacts.push(ArtifactRef::new(write_runner_metadata(
            ctx,
            artifact_dir,
            "prepare-foundry-harness",
            json!({
                "framework": discovery.framework,
                "hardhat_setup_applied": hardhat_setup_applied,
                "staged_index_changed": staged_before != staged_after,
            }),
        )?));
        Ok(NodeOutput { artifacts })
    }

    fn run_discover_base_test(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
    ) -> anyhow::Result<NodeOutput> {
        let repo = target_repo(&ctx.resolved_config)?;
        let discovery = discover_base_tests(&repo)?;
        let base_test_path = discovery.base_test_path.clone();
        let analogous_paths = discovery.analogous_paths.clone();
        let mut artifacts = basic_logs(artifact_dir, "base test discovery completed\n")?;
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            "base-test-discovery.json",
            &json!({
                "schema_version": "1.0",
                "target_repo": repo,
                "base_test_path": base_test_path.clone(),
                "analogous_shared_test_paths": analogous_paths.clone(),
                "missing": base_test_path.is_none() && analogous_paths.is_empty(),
                "preferred_generated_path": "test/foundry/BaseTest.t.sol",
            }),
        )?));
        artifacts.push(ArtifactRef::new(write_runner_metadata(
            ctx,
            artifact_dir,
            "discover-base-test",
            json!({
                "base_test_path": base_test_path.clone(),
                "analogous_count": analogous_paths.len(),
            }),
        )?));
        Ok(NodeOutput { artifacts })
    }

    fn run_property_specification_lens(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
        lens: PropertyLens,
    ) -> anyhow::Result<NodeOutput> {
        fs::create_dir_all(artifact_dir)?;
        let repo = target_repo(&ctx.resolved_config)?;
        let documentation_sources = discover_property_specification_sources(&repo);
        let workspace_path = ctx.workspace_dir.clone();
        let workspace = {
            let _guard = self
                .workspace_lock
                .lock()
                // The mutex serializes git worktree add/remove operations and
                // guards no data, so a poisoned lock is safe to recover.
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.workspace_manager.create(WorkspaceRequest::attempt(
                ctx.run_id.clone(),
                ctx.node.id.clone(),
                &repo,
                &workspace_path,
                artifact_dir,
                ctx.resolved_config.run.workspace_mode,
                ctx.resolved_config.run.keep_workspaces,
            ))?
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCreated {
                node_id: ctx.node.id.clone(),
                path: workspace.path.clone(),
            },
        )?;

        if !ctx
            .resolved_config
            .permissions
            .allow_target_repo_writes_during_attempts
            && same_canonical_path(&workspace.path, &repo)
        {
            let _ = self.cleanup_workspace(workspace);
            anyhow::bail!(
                "property specification lens workspace `{}` resolves to target repo `{}`; writable target repo agent nodes are disabled",
                workspace_path.display(),
                repo.display()
            );
        }

        let candidate_path = artifact_dir.join(PROPERTY_LENS_CANDIDATE_FILE);
        let output_findings_path = artifact_dir.join(FINDINGS_FILE);
        let output_patch_path = artifact_dir.join(PATCH_FILE);
        let output_metadata_path = artifact_dir.join("metadata.json");
        let prompt_path = match render_property_lens_prompt(
            ctx,
            artifact_dir,
            lens,
            &repo,
            &workspace.path,
            &candidate_path,
            &output_findings_path,
            &output_patch_path,
            &output_metadata_path,
            &documentation_sources,
        ) {
            Ok(path) => path,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::PromptRendered {
                node_id: ctx.node.id.clone(),
                path: prompt_path.clone(),
            },
        )?;

        let prompt = fs::read_to_string(&prompt_path)?;
        let (model_id, model_profile) = default_model_profile_for_agentic(&ctx.resolved_config)?;
        let backend = backend_for_model_profile(&ctx.resolved_config, &repo, model_profile);
        let agent_result = backend.run(AgentInput {
            run_id: ctx.run_id.clone(),
            node_id: ctx.node.id.clone(),
            strategy: StrategyId::from(format!("{}-lens", lens.id())),
            attempt_index: 0,
            model_id: Some(model_id),
            model: model_profile.model.clone(),
            model_index: Some(0),
            loop_index: Some(0),
            prompt,
            workspace_path: workspace.path.clone(),
            artifact_dir: artifact_dir.to_path_buf(),
            extra_context_dirs: Vec::new(),
            output_findings_path: output_findings_path.clone(),
            output_patch_path: output_patch_path.clone(),
            output_metadata_path: output_metadata_path.clone(),
            timeout: ctx.node.timeout.unwrap_or_else(|| {
                Duration::from_secs(ctx.resolved_config.run.default_timeout_seconds)
            }),
        });

        let agent_output = match agent_result {
            Ok(output) => {
                if let Err(error) = validate_property_lens_candidates(&candidate_path, lens) {
                    write_failed_property_lens_artifact(
                        artifact_dir,
                        lens,
                        &repo,
                        &documentation_sources,
                        &format!("lens candidate artifact was missing or invalid: {error}"),
                    )?;
                }
                Some(output)
            }
            Err(error) => {
                write_failed_property_lens_artifact(
                    artifact_dir,
                    lens,
                    &repo,
                    &documentation_sources,
                    &error.to_string(),
                )?;
                None
            }
        };

        if !output_findings_path.exists() {
            write_json_artifact(artifact_dir, FINDINGS_FILE, &Vec::<Value>::new())?;
        }

        let cleanup_error = if ctx.resolved_config.run.keep_workspaces {
            None
        } else {
            self.cleanup_workspace(workspace)
                .err()
                .map(|err| err.to_string())
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCleaned {
                node_id: ctx.node.id.clone(),
            },
        )?;

        let mut artifacts = Vec::new();
        artifacts.push(ArtifactRef::new(prompt_path));
        push_if_exists(&mut artifacts, candidate_path);
        push_if_exists(&mut artifacts, artifact_dir.join("stdout.log"));
        push_if_exists(&mut artifacts, artifact_dir.join("stderr.log"));
        push_if_exists(&mut artifacts, artifact_dir.join("transcript.json"));
        push_if_exists(&mut artifacts, output_findings_path);
        if let Some(output) = agent_output {
            if let Some(path) = output.patch_path {
                artifacts.push(ArtifactRef::new(path));
            }
            if let Some(path) = output.metadata_path {
                artifacts.push(ArtifactRef::new(path));
            }
        } else {
            push_if_exists(&mut artifacts, output_metadata_path);
        }
        artifacts.push(ArtifactRef::new(write_runner_metadata_file(
            ctx,
            artifact_dir,
            "property-lens-metadata.json",
            "property-specification-lens",
            json!({
                "lens_id": lens.id(),
                "candidate_artifact": PROPERTY_LENS_CANDIDATE_FILE,
            }),
        )?));
        if let Some(cleanup_error) = cleanup_error {
            artifacts.push(ArtifactRef::new(write_artifact(
                artifact_dir,
                "cleanup-error.log",
                format!("{cleanup_error}\n"),
            )?));
        }
        Ok(NodeOutput { artifacts })
    }

    fn run_property_specification_fanin(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
    ) -> anyhow::Result<NodeOutput> {
        fs::create_dir_all(artifact_dir)?;
        let repo = target_repo(&ctx.resolved_config)?;
        let compatibility_dir =
            attempt_artifact_sibling_dir(ctx, &NodeId::from(PROPERTY_SPECIFICATION_COMPAT_DIR));
        fs::create_dir_all(&compatibility_dir)?;
        let lens_inputs = collect_property_lens_inputs(ctx)?;
        let lens_inputs_path =
            write_json_artifact(artifact_dir, PROPERTY_LENS_INPUTS_FILE, &lens_inputs)?;

        let workspace_path = ctx.workspace_dir.clone();
        let workspace = {
            let _guard = self
                .workspace_lock
                .lock()
                // The mutex serializes git worktree add/remove operations and
                // guards no data, so a poisoned lock is safe to recover.
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.workspace_manager.create(WorkspaceRequest::attempt(
                ctx.run_id.clone(),
                ctx.node.id.clone(),
                &repo,
                &workspace_path,
                artifact_dir,
                ctx.resolved_config.run.workspace_mode,
                ctx.resolved_config.run.keep_workspaces,
            ))?
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCreated {
                node_id: ctx.node.id.clone(),
                path: workspace.path.clone(),
            },
        )?;

        if !ctx
            .resolved_config
            .permissions
            .allow_target_repo_writes_during_attempts
            && same_canonical_path(&workspace.path, &repo)
        {
            let _ = self.cleanup_workspace(workspace);
            anyhow::bail!(
                "property specification fan-in workspace `{}` resolves to target repo `{}`; writable target repo agent nodes are disabled",
                workspace_path.display(),
                repo.display()
            );
        }

        let catalog_path = compatibility_dir.join(PROPERTY_SPECIFICATION_FILE);
        let output_findings_path = artifact_dir.join(FINDINGS_FILE);
        let compatibility_findings_path = compatibility_dir.join(FINDINGS_FILE);
        let output_patch_path = artifact_dir.join(PATCH_FILE);
        let output_metadata_path = artifact_dir.join("metadata.json");
        let prompt_path = match render_property_fanin_prompt(
            ctx,
            artifact_dir,
            &repo,
            &workspace.path,
            &catalog_path,
            &output_findings_path,
            &output_patch_path,
            &output_metadata_path,
            &lens_inputs_path,
            &lens_inputs,
        ) {
            Ok(path) => path,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::PromptRendered {
                node_id: ctx.node.id.clone(),
                path: prompt_path.clone(),
            },
        )?;

        let prompt = fs::read_to_string(&prompt_path)?;
        let (model_id, model_profile) = default_model_profile_for_agentic(&ctx.resolved_config)?;
        let backend = backend_for_model_profile(&ctx.resolved_config, &repo, model_profile);
        let mut extra_context_dirs = vec![compatibility_dir.clone()];
        extra_context_dirs.extend(lens_inputs.iter().filter_map(|input| {
            input
                .path
                .as_ref()
                .and_then(|path| path.parent().map(Path::to_path_buf))
                .filter(|path| path.is_dir())
        }));
        extra_context_dirs.sort();
        extra_context_dirs.dedup();
        let agent_result = backend.run(AgentInput {
            run_id: ctx.run_id.clone(),
            node_id: ctx.node.id.clone(),
            strategy: StrategyId::from("property-specification-fanin"),
            attempt_index: 0,
            model_id: Some(model_id),
            model: model_profile.model.clone(),
            model_index: Some(0),
            loop_index: Some(0),
            prompt,
            workspace_path: workspace.path.clone(),
            artifact_dir: artifact_dir.to_path_buf(),
            extra_context_dirs,
            output_findings_path: output_findings_path.clone(),
            output_patch_path: output_patch_path.clone(),
            output_metadata_path: output_metadata_path.clone(),
            timeout: ctx.node.timeout.unwrap_or_else(|| {
                Duration::from_secs(ctx.resolved_config.run.default_timeout_seconds)
            }),
        });

        let mut used_deterministic_fallback = false;
        let agent_output = match agent_result {
            Ok(output) => {
                if validate_property_specification_catalog(&catalog_path).is_err() {
                    if let Err(error) = write_deterministic_property_catalog(
                        &catalog_path,
                        &output_findings_path,
                        &lens_inputs,
                    ) {
                        self.cleanup_workspace_after_failure(
                            workspace,
                            ctx.resolved_config.run.keep_workspaces,
                            artifact_dir,
                        );
                        return Err(error);
                    }
                    used_deterministic_fallback = true;
                }
                Some(output)
            }
            Err(_) => {
                if let Err(error) = write_deterministic_property_catalog(
                    &catalog_path,
                    &output_findings_path,
                    &lens_inputs,
                ) {
                    self.cleanup_workspace_after_failure(
                        workspace,
                        ctx.resolved_config.run.keep_workspaces,
                        artifact_dir,
                    );
                    return Err(error);
                }
                used_deterministic_fallback = true;
                None
            }
        };
        let catalog = match validate_property_specification_catalog(&catalog_path) {
            Ok(catalog) => catalog,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        };
        if output_findings_path.exists() {
            fs::copy(&output_findings_path, &compatibility_findings_path)?;
        } else {
            write_json_artifact(&compatibility_dir, FINDINGS_FILE, &Vec::<Value>::new())?;
        }

        let cleanup_error = if ctx.resolved_config.run.keep_workspaces {
            None
        } else {
            self.cleanup_workspace(workspace)
                .err()
                .map(|err| err.to_string())
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCleaned {
                node_id: ctx.node.id.clone(),
            },
        )?;

        let mut artifacts = Vec::new();
        artifacts.push(ArtifactRef::new(prompt_path));
        artifacts.push(ArtifactRef::new(lens_inputs_path));
        artifacts.push(ArtifactRef::new(catalog_path.clone()));
        push_if_exists(&mut artifacts, compatibility_findings_path.clone());
        push_if_exists(&mut artifacts, output_findings_path);
        push_if_exists(&mut artifacts, artifact_dir.join("stdout.log"));
        push_if_exists(&mut artifacts, artifact_dir.join("stderr.log"));
        push_if_exists(&mut artifacts, artifact_dir.join("transcript.json"));
        if let Some(output) = agent_output {
            if let Some(path) = output.patch_path {
                artifacts.push(ArtifactRef::new(path));
            }
            if let Some(path) = output.metadata_path {
                artifacts.push(ArtifactRef::new(path));
            }
        } else {
            push_if_exists(&mut artifacts, output_metadata_path);
        }
        artifacts.push(ArtifactRef::new(write_json_artifact(
            &compatibility_dir,
            "property-specification-metadata.json",
            &json!({
                "schema_version": "1.0",
                "runner": "campaign",
                "node_runner": "property-specification-fanin",
                "node_id": ctx.node.id,
                "kind": ctx.node.kind,
                "extra": {
                    "lens_inputs": lens_inputs.len(),
                    "property_catalog": PROPERTY_SPECIFICATION_FILE,
                    "candidate_properties": catalog["candidate_properties"].as_array().map(Vec::len),
                    "deterministic_fallback": used_deterministic_fallback,
                }
            }),
        )?));
        artifacts.push(ArtifactRef::new(write_runner_metadata_file(
            ctx,
            artifact_dir,
            "property-specification-fanin-metadata.json",
            "property-specification-fanin",
            json!({
                "lens_inputs": lens_inputs.len(),
                "property_catalog": catalog_path,
                "candidate_properties": catalog["candidate_properties"].as_array().map(Vec::len),
                "deterministic_fallback": used_deterministic_fallback,
            }),
        )?));
        if let Some(cleanup_error) = cleanup_error {
            artifacts.push(ArtifactRef::new(write_artifact(
                artifact_dir,
                "cleanup-error.log",
                format!("{cleanup_error}\n"),
            )?));
        }
        emit_finding_created_if_nonempty(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            &ctx.node.id,
            compatibility_findings_path,
        )?;
        Ok(NodeOutput { artifacts })
    }

    fn run_property_specification(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
    ) -> anyhow::Result<NodeOutput> {
        fs::create_dir_all(artifact_dir)?;
        let repo = target_repo(&ctx.resolved_config)?;
        let documentation_sources = discover_property_specification_sources(&repo);
        let documentation_source_count = documentation_sources.len();
        let workspace_path = ctx.workspace_dir.clone();
        let workspace = {
            let _guard = self
                .workspace_lock
                .lock()
                // The mutex serializes git worktree add/remove operations and
                // guards no data, so a poisoned lock is safe to recover.
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.workspace_manager.create(WorkspaceRequest::attempt(
                ctx.run_id.clone(),
                ctx.node.id.clone(),
                &repo,
                &workspace_path,
                artifact_dir,
                ctx.resolved_config.run.workspace_mode,
                ctx.resolved_config.run.keep_workspaces,
            ))?
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCreated {
                node_id: ctx.node.id.clone(),
                path: workspace.path.clone(),
            },
        )?;

        if !ctx
            .resolved_config
            .permissions
            .allow_target_repo_writes_during_attempts
            && same_canonical_path(&workspace.path, &repo)
        {
            let _ = self.cleanup_workspace(workspace);
            anyhow::bail!(
                "property specification workspace `{}` resolves to target repo `{}`; writable target repo agent nodes are disabled",
                workspace_path.display(),
                repo.display()
            );
        }

        let catalog_path = artifact_dir.join(PROPERTY_SPECIFICATION_FILE);
        let output_findings_path = artifact_dir.join(FINDINGS_FILE);
        let output_patch_path = artifact_dir.join(PATCH_FILE);
        let output_metadata_path = artifact_dir.join("metadata.json");
        let prompt_path = match render_property_specification_prompt(
            ctx,
            artifact_dir,
            &repo,
            &workspace.path,
            &catalog_path,
            &output_findings_path,
            &output_patch_path,
            &output_metadata_path,
            &documentation_sources,
        ) {
            Ok(path) => path,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::PromptRendered {
                node_id: ctx.node.id.clone(),
                path: prompt_path.clone(),
            },
        )?;

        let prompt = fs::read_to_string(&prompt_path)?;
        let (model_id, model_profile) = default_model_profile_for_agentic(&ctx.resolved_config)?;
        let backend = backend_for_model_profile(&ctx.resolved_config, &repo, model_profile);
        let agent_result = backend.run(AgentInput {
            run_id: ctx.run_id.clone(),
            node_id: ctx.node.id.clone(),
            strategy: StrategyId::from("property-specification"),
            attempt_index: 0,
            model_id: Some(model_id),
            model: model_profile.model.clone(),
            model_index: Some(0),
            loop_index: Some(0),
            prompt,
            workspace_path: workspace.path.clone(),
            artifact_dir: artifact_dir.to_path_buf(),
            extra_context_dirs: Vec::new(),
            output_findings_path: output_findings_path.clone(),
            output_patch_path: output_patch_path.clone(),
            output_metadata_path: output_metadata_path.clone(),
            timeout: ctx.node.timeout.unwrap_or_else(|| {
                Duration::from_secs(ctx.resolved_config.run.default_timeout_seconds)
            }),
        });

        let agent_output = match agent_result {
            Ok(output) => output,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error.into());
            }
        };
        let catalog = match validate_property_specification_catalog(&catalog_path) {
            Ok(catalog) => catalog,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        };

        let mut artifacts = Vec::new();
        artifacts.push(ArtifactRef::new(prompt_path));
        push_if_exists(&mut artifacts, catalog_path.clone());
        if let Some(path) = agent_output.stdout_path {
            artifacts.push(ArtifactRef::new(path));
        }
        if let Some(path) = agent_output.stderr_path {
            artifacts.push(ArtifactRef::new(path));
        }
        if let Some(path) = agent_output.transcript_path {
            artifacts.push(ArtifactRef::new(path));
        }
        if let Some(path) = agent_output.findings_path {
            artifacts.push(ArtifactRef::new(path));
        }
        if let Some(path) = agent_output.patch_path {
            artifacts.push(ArtifactRef::new(path));
        }
        if let Some(path) = agent_output.metadata_path {
            artifacts.push(ArtifactRef::new(path));
        }
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            "property-specification-metadata.json",
            &json!({
                "schema_version": "1.0",
                "runner": "campaign",
                "node_runner": "property-specification",
                "node_id": ctx.node.id,
                "kind": ctx.node.kind,
                "extra": {
                    "documentation_sources": documentation_source_count,
                    "property_catalog": PROPERTY_SPECIFICATION_FILE,
                    "candidate_properties": catalog["candidate_properties"].as_array().map(Vec::len),
                    "changed_files": agent_output.changed_files
                }
            }),
        )?));
        if !ctx.resolved_config.run.keep_workspaces {
            self.cleanup_workspace(workspace)?;
        }
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCleaned {
                node_id: ctx.node.id.clone(),
            },
        )?;
        Ok(NodeOutput { artifacts })
    }

    fn run_agent_attempt(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
        attempt: AttemptNodeRef<'_>,
    ) -> anyhow::Result<NodeOutput> {
        fs::create_dir_all(artifact_dir)?;
        let repo = target_repo(&ctx.resolved_config)?;
        let model_profile = model_profile_for_attempt(&ctx.resolved_config, attempt.model_id)?;
        let workspace_path = ctx.workspace_dir.clone();
        let workspace = {
            let _guard = self
                .workspace_lock
                .lock()
                // The mutex serializes git worktree add/remove operations and
                // guards no data, so a poisoned lock is safe to recover.
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.workspace_manager.create(WorkspaceRequest::attempt(
                ctx.run_id.clone(),
                ctx.node.id.clone(),
                &repo,
                &workspace_path,
                artifact_dir,
                ctx.resolved_config.run.workspace_mode,
                ctx.resolved_config.run.keep_workspaces,
            ))?
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCreated {
                node_id: ctx.node.id.clone(),
                path: workspace.path.clone(),
            },
        )?;

        if !ctx
            .resolved_config
            .permissions
            .allow_target_repo_writes_during_attempts
            && same_canonical_path(&workspace.path, &repo)
        {
            let _ = self.cleanup_workspace(workspace);
            anyhow::bail!(
                "attempt workspace `{}` resolves to target repo `{}`; writable target repo attempts are disabled",
                workspace_path.display(),
                repo.display()
            );
        }
        if let Err(error) = sync_prepared_harness_into_workspace(&repo, &workspace.path) {
            self.cleanup_workspace_after_failure(
                workspace,
                ctx.resolved_config.run.keep_workspaces,
                artifact_dir,
            );
            return Err(error);
        }

        let output_findings_path = artifact_dir.join(FINDINGS_FILE);
        let output_patch_path = artifact_dir.join(PATCH_FILE);
        let output_metadata_path = artifact_dir.join("metadata.json");
        let prompt_path = render_strategy_prompt(
            ctx,
            artifact_dir,
            attempt.prompt_id,
            &workspace.path,
            &output_findings_path,
            &output_patch_path,
            &output_metadata_path,
        )?;
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::PromptRendered {
                node_id: ctx.node.id.clone(),
                path: prompt_path.clone(),
            },
        )?;

        let prompt = fs::read_to_string(&prompt_path)?;
        let backend = backend_for_model_profile(&ctx.resolved_config, &repo, model_profile);
        let agent_result = backend.run(AgentInput {
            run_id: ctx.run_id.clone(),
            node_id: ctx.node.id.clone(),
            strategy: attempt.strategy.clone(),
            attempt_index: attempt.attempt_index,
            model_id: Some(attempt.model_id.clone()),
            model: model_profile.model.clone(),
            model_index: Some(attempt.model_index),
            loop_index: Some(attempt.loop_index),
            prompt,
            workspace_path: workspace.path.clone(),
            artifact_dir: artifact_dir.to_path_buf(),
            extra_context_dirs: Vec::new(),
            output_findings_path: output_findings_path.clone(),
            output_patch_path: output_patch_path.clone(),
            output_metadata_path: output_metadata_path.clone(),
            timeout: ctx.node.timeout.unwrap_or_else(|| {
                Duration::from_secs(ctx.resolved_config.run.default_timeout_seconds)
            }),
        });

        let agent_output = match agent_result {
            Ok(output) => output,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error.into());
            }
        };

        let parse_report = match parse_and_normalize_findings_dir_with_model(
            artifact_dir,
            &ctx.node.id,
            Some(attempt.strategy),
            Some(attempt.attempt_index),
            Some(attempt.model_id),
            model_profile.model.as_deref(),
            Some(attempt.model_index),
            Some(attempt.loop_index),
        ) {
            Ok(report) => report,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error.into());
            }
        };
        let normalization_path = write_json_artifact(
            artifact_dir,
            "findings-normalization.json",
            &json!({
                "schema_version": "1.0",
                "source_path": parse_report.source_path,
                "normalized_path": parse_report.normalized_path,
                "valid_findings": parse_report.findings.len(),
                "invalid_findings": parse_report.invalid,
            }),
        )?;
        if !parse_report.findings.is_empty() {
            emit_event(
                ctx.event_sink.as_ref(),
                &ctx.run_id,
                RunEvent::FindingCreated {
                    node_id: ctx.node.id.clone(),
                    path: output_findings_path.clone(),
                },
            )?;
        }

        let generated_tests = match collect_generated_tests_from_workspace(
            &workspace.path,
            &repo,
            artifact_dir,
            &ctx.node.id,
            attempt,
            model_profile.model.as_deref(),
        ) {
            Ok(generated_tests) => generated_tests,
            Err(error) => {
                self.cleanup_workspace_after_failure(
                    workspace,
                    ctx.resolved_config.run.keep_workspaces,
                    artifact_dir,
                );
                return Err(error);
            }
        };

        let cleanup_error = if ctx.resolved_config.run.keep_workspaces {
            None
        } else {
            self.cleanup_workspace(workspace)
                .err()
                .map(|err| err.to_string())
        };
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCleaned {
                node_id: ctx.node.id.clone(),
            },
        )?;

        let mut artifacts = Vec::new();
        artifacts.push(ArtifactRef::new(prompt_path));
        push_if_exists(&mut artifacts, artifact_dir.join("stdout.log"));
        push_if_exists(&mut artifacts, artifact_dir.join("stderr.log"));
        push_if_exists(&mut artifacts, artifact_dir.join("transcript.json"));
        push_if_exists(&mut artifacts, output_findings_path.clone());
        push_if_exists(&mut artifacts, output_metadata_path.clone());
        artifacts.push(ArtifactRef::new(normalization_path));
        push_if_exists(&mut artifacts, artifact_dir.join(WORKSPACE_MANIFEST_FILE));
        artifacts.push(ArtifactRef::new(generated_tests.manifest_path));
        for path in generated_tests.artifact_paths {
            artifacts.push(ArtifactRef::new(path));
        }
        if let Some(path) = agent_output.patch_path {
            emit_event(
                ctx.event_sink.as_ref(),
                &ctx.run_id,
                RunEvent::PatchCreated {
                    node_id: ctx.node.id.clone(),
                    path: path.clone(),
                },
            )?;
            artifacts.push(ArtifactRef::new(path));
        }
        if let Some(cleanup_error) = cleanup_error {
            artifacts.push(ArtifactRef::new(write_artifact(
                artifact_dir,
                "cleanup-error.log",
                format!("{cleanup_error}\n"),
            )?));
        }
        Ok(NodeOutput { artifacts })
    }

    fn run_consolidate(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
        strategy: &StrategyId,
    ) -> anyhow::Result<NodeOutput> {
        let mut findings = Vec::new();
        let mut invalid = Vec::new();
        for node in strategy_attempt_nodes(&ctx.graph, strategy) {
            let attempt_dir = ctx.artifact_store.layout().artifact_dir(&node.id);
            let NodeKind::AgentAttempt {
                attempt_index,
                model_id,
                model_index,
                loop_index,
                ..
            } = node.kind
            else {
                continue;
            };
            let model_profile = ctx.resolved_config.model_profile(&model_id);
            match parse_and_normalize_findings_dir_with_model(
                &attempt_dir,
                &node.id,
                Some(strategy),
                Some(attempt_index),
                Some(&model_id),
                model_profile.and_then(|profile| profile.model.as_deref()),
                Some(model_index),
                Some(loop_index),
            ) {
                Ok(report) => {
                    findings.extend(report.findings);
                    invalid.extend(report.invalid.into_iter().map(|invalid| {
                        json!({
                            "node_id": node.id,
                            "index": invalid.index,
                            "error": invalid.error,
                            "raw": invalid.raw,
                        })
                    }));
                }
                Err(error) => invalid.push(json!({
                    "node_id": node.id,
                    "error": error.to_string(),
                })),
            }
        }
        let mut artifacts = basic_logs(artifact_dir, "strategy consolidation completed\n")?;
        let findings_path = write_json_artifact(artifact_dir, FINDINGS_FILE, &findings)?;
        artifacts.push(ArtifactRef::new(findings_path.clone()));
        artifacts.push(ArtifactRef::new(write_artifact(
            artifact_dir,
            "summary.md",
            render_consolidation_summary(strategy, &findings, invalid.len()),
        )?));
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            "invalid-findings.json",
            &invalid,
        )?));
        artifacts.push(ArtifactRef::new(write_runner_metadata(
            ctx,
            artifact_dir,
            "consolidate",
            json!({
                "strategy": strategy,
                "findings": findings.len(),
                "invalid_findings": invalid.len(),
            }),
        )?));
        if !findings.is_empty() {
            emit_event(
                ctx.event_sink.as_ref(),
                &ctx.run_id,
                RunEvent::FindingCreated {
                    node_id: ctx.node.id.clone(),
                    path: findings_path,
                },
            )?;
        }
        Ok(NodeOutput { artifacts })
    }

    fn run_dedupe(&self, ctx: &NodeContext, artifact_dir: &Path) -> anyhow::Result<NodeOutput> {
        let mut all_findings = Vec::new();
        for dependency in &ctx.node.depends_on {
            let path = ctx
                .artifact_store
                .layout()
                .artifact_dir(dependency)
                .join(FINDINGS_FILE);
            let source_artifact = run_relative_path(ctx, &path);
            for finding in read_findings_array(&path)? {
                all_findings.push(FindingWithSource {
                    finding,
                    source_node_id: dependency.clone(),
                    source_artifact: source_artifact.clone(),
                });
            }
        }

        let mut unique = BTreeMap::<String, FindingWithSource>::new();
        let mut strategy_detections = BTreeMap::<String, FindingStrategyDetection>::new();
        let mut duplicates = Vec::<Value>::new();
        let mut duplicate_sources = BTreeMap::<String, Vec<FindingLifecycleSourceArtifact>>::new();
        let mut duplicate_stages = BTreeMap::<String, Vec<FindingLifecycleStageRecord>>::new();
        let mut duplicate_finding_ids = BTreeMap::<String, Vec<String>>::new();
        for finding in all_findings {
            let key = finding_dedupe_key(&finding.finding);
            if let Some(existing) = unique.get(&key) {
                merge_strategy_detection_hit(&mut strategy_detections, &key, &finding.finding);
                let duplicate_source =
                    lifecycle_source_artifact(&finding, FindingSourceRelationship::Duplicate);
                duplicate_sources
                    .entry(key.clone())
                    .or_default()
                    .push(duplicate_source);
                duplicate_stages
                    .entry(key.clone())
                    .or_default()
                    .push(raw_lifecycle_stage(
                        &finding,
                        Some("duplicate collapsed by dedupe"),
                    ));
                if let Some(id) = &finding.finding.id {
                    duplicate_finding_ids
                        .entry(key.clone())
                        .or_default()
                        .push(id.clone());
                }
                duplicates.push(json!({
                    "dedupe_key": key,
                    "kept_id": existing.finding.id,
                    "duplicate_id": finding.finding.id,
                    "duplicate_title": finding.finding.title,
                    "duplicate_strategy": finding.finding.strategy,
                    "duplicate_attempt_index": finding.finding.attempt_index,
                    "duplicate_loop_index": finding.finding.loop_index,
                    "duplicate_source_artifact": finding.source_artifact,
                }));
            } else {
                strategy_detections.insert(
                    key.clone(),
                    strategy_detection_from_finding(&key, &finding.finding),
                );
                unique.insert(key, finding);
            }
        }
        let deduped_inputs = unique.into_values().collect::<Vec<_>>();
        let deduped = deduped_inputs
            .iter()
            .map(|input| input.finding.clone())
            .collect::<Vec<_>>();
        let strategy_detections = strategy_detections.into_values().collect::<Vec<_>>();
        let mut artifacts = basic_logs(artifact_dir, "finding dedupe completed\n")?;
        let deduped_path = write_json_artifact(artifact_dir, "deduped-findings.json", &deduped)?;
        artifacts.push(ArtifactRef::new(deduped_path.clone()));
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            STRATEGY_DETECTIONS_FILE,
            &strategy_detections,
        )?));
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            "duplicates.json",
            &duplicates,
        )?));
        let ledger = dedupe_lifecycle_ledger(
            ctx,
            &deduped_path,
            &deduped_inputs,
            &strategy_detections,
            duplicate_sources,
            duplicate_stages,
            duplicate_finding_ids,
        );
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            FINDING_LIFECYCLE_LEDGER_FILE,
            &ledger,
        )?));
        artifacts.push(ArtifactRef::new(write_runner_metadata(
            ctx,
            artifact_dir,
            "dedupe",
            json!({
                "input_findings": deduped.len() + duplicates.len(),
                "deduped_findings": deduped.len(),
                "duplicates": duplicates.len(),
                "strategy_detections": strategy_detections.len(),
            }),
        )?));
        Ok(NodeOutput { artifacts })
    }

    fn run_triage(&self, ctx: &NodeContext, artifact_dir: &Path) -> anyhow::Result<NodeOutput> {
        let dedupe_artifact_dir = ctx
            .node
            .depends_on
            .first()
            .map(|dependency| ctx.artifact_store.layout().artifact_dir(dependency))
            .ok_or_else(|| anyhow::anyhow!("triage node has no dedupe dependency"))?;
        let input_path = dedupe_artifact_dir.join("deduped-findings.json");
        let strategy_detections =
            read_strategy_detections_array(dedupe_artifact_dir.join(STRATEGY_DETECTIONS_FILE))?;
        let lifecycle_ledger =
            read_lifecycle_ledger(dedupe_artifact_dir.join(FINDING_LIFECYCLE_LEDGER_FILE))?;
        let mut findings = read_findings_array(&input_path)?;
        findings.sort_by_key(finding_dedupe_key);
        for (index, finding) in findings.iter_mut().enumerate() {
            if finding.id.as_deref().is_none_or(str::is_empty) {
                finding.id = Some(format!("UF-{:04}", index + 1));
            }
            if finding.status == FindingStatus::Candidate {
                finding.status = FindingStatus::NeedsReview;
            }
            if finding.triage_classification.is_none() {
                finding.triage_classification = Some(TriageClassification::Undetermined);
            }
            if let Some(id) = &finding.id {
                emit_event(
                    ctx.event_sink.as_ref(),
                    &ctx.run_id,
                    RunEvent::TriageUpdated {
                        finding_id: id.clone(),
                    },
                )?;
            }
        }
        let mut artifacts = basic_logs(artifact_dir, "triage completed\n")?;
        let triaged_path = write_json_artifact(artifact_dir, TRIAGED_FINDINGS_FILE, &findings)?;
        let lifecycle_ledger =
            triage_lifecycle_ledger(ctx, &triaged_path, lifecycle_ledger, &findings)?;
        artifacts.push(ArtifactRef::new(triaged_path.clone()));
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            FINDINGS_FILE,
            &findings,
        )?));
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            STRATEGY_DETECTIONS_FILE,
            &strategy_detections,
        )?));
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            FINDING_LIFECYCLE_LEDGER_FILE,
            &lifecycle_ledger,
        )?));
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            "triage-summary.json",
            &json!({
                "schema_version": "1.0",
                "findings": findings.len(),
                "status_counts": finding_status_counts(&findings),
            }),
        )?));
        artifacts.push(ArtifactRef::new(write_runner_metadata(
            ctx,
            artifact_dir,
            "triage",
            json!({ "findings": findings.len() }),
        )?));
        if !findings.is_empty() {
            emit_event(
                ctx.event_sink.as_ref(),
                &ctx.run_id,
                RunEvent::FindingCreated {
                    node_id: ctx.node.id.clone(),
                    path: triaged_path,
                },
            )?;
        }
        Ok(NodeOutput { artifacts })
    }

    fn run_aggregate_test_files(
        &self,
        ctx: &NodeContext,
        artifact_dir: &Path,
    ) -> anyhow::Result<NodeOutput> {
        let repo = target_repo(&ctx.resolved_config)?;
        let staged_before = git_status_index(&repo).ok();
        let permalink_base = git_permalink_base(&repo).ok();
        let mut records = Vec::new();
        let mut support_records = Vec::new();
        let mut source_count = 0usize;
        let mut copied_count = 0usize;
        let mut source_support_count = 0usize;
        let mut copied_support_count = 0usize;
        let mut used_destinations = BTreeSet::new();

        for node in &ctx.graph.nodes {
            let Some(generated_context) = generated_test_aggregation_context(ctx, node) else {
                continue;
            };
            let attempt_dir = ctx.artifact_store.layout().artifact_dir(&node.id);
            for generated in read_generated_tests_manifest(&attempt_dir)? {
                let records_for_role = match generated.role {
                    GeneratedTestManifestEntryRole::Test => {
                        source_count += 1;
                        &mut records
                    }
                    GeneratedTestManifestEntryRole::Support => {
                        source_support_count += 1;
                        &mut support_records
                    }
                };
                let source = attempt_dir.join(&generated.artifact_path);
                if !is_regular_file_no_symlink(&source)? {
                    records_for_role.push(json!({
                        "node_id": node.id,
                        "strategy": generated_context.strategy.clone(),
                        "attempt_index": generated_context.attempt_index,
                        "model_id": generated_context.model_id.clone(),
                        "model": generated_context.model.clone(),
                        "model_index": generated_context.model_index,
                        "loop_index": generated_context.loop_index,
                        "source_artifact": generated.artifact_path,
                        "source_relative_path": generated.source_relative_path,
                        "status": "missing-source-artifact",
                    }));
                    continue;
                }
                let destination_relative = unique_aggregated_test_path(
                    &repo,
                    &generated_context.strategy,
                    generated_context.attempt_index,
                    &generated.source_relative_path,
                    &mut used_destinations,
                );
                let destination = repo.join(&destination_relative);
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                ensure_copy_destination_not_symlink(&destination)?;
                fs::copy(&source, &destination)?;
                match generated.role {
                    GeneratedTestManifestEntryRole::Test => copied_count += 1,
                    GeneratedTestManifestEntryRole::Support => copied_support_count += 1,
                }
                records_for_role.push(json!({
                    "node_id": node.id,
                    "strategy": generated_context.strategy.clone(),
                    "attempt_index": generated_context.attempt_index,
                    "model_id": generated_context.model_id.clone(),
                    "model": generated_context.model.clone(),
                    "model_index": generated_context.model_index,
                    "loop_index": generated_context.loop_index,
                    "source_artifact": generated.artifact_path,
                    "source_relative_path": generated.source_relative_path,
                    "destination": destination_relative,
                    "permalink": permalink_base.as_ref().map(|base| format!("{base}/{}", url_path(&destination_relative))),
                    "status": "copied",
                    "bytes": fs::metadata(&destination).map(|metadata| metadata.len()).unwrap_or_default(),
                }));
            }
        }

        let staged_after = git_status_index(&repo).ok();
        if staged_before.is_some() && staged_after.is_some() && staged_before != staged_after {
            anyhow::bail!("test aggregation unexpectedly changed the staged index");
        }
        let git_status = git_status_short(&repo).unwrap_or_default();
        let mut artifacts = basic_logs(artifact_dir, "test aggregation completed\n")?;
        artifacts.push(ArtifactRef::new(write_json_artifact(
            artifact_dir,
            "aggregation.json",
            &json!({
                "schema_version": "1.0",
                "target_repo": repo,
                "source_test_files": source_count,
                "copied_test_files": copied_count,
                "source_support_files": source_support_count,
                "copied_support_files": copied_support_count,
                "generated_test_dir": "test/foundry",
                "staged_index_changed": false,
                "git_status_short": git_status,
                "files": records,
                "support_files": support_records,
                "skipped_files": [],
            }),
        )?));
        artifacts.push(ArtifactRef::new(write_runner_metadata(
            ctx,
            artifact_dir,
            "aggregate-test-files",
            json!({
                "source_test_files": source_count,
                "copied_test_files": copied_count,
                "source_support_files": source_support_count,
                "copied_support_files": copied_support_count,
                "target_repo_modified": copied_count > 0 || copied_support_count > 0,
            }),
        )?));
        Ok(NodeOutput { artifacts })
    }
}

fn prepare_agentic_aggregate_workspace(
    ctx: &NodeContext,
    artifact_dir: &Path,
    workspace_path: &Path,
) -> anyhow::Result<PathBuf> {
    let mut records = Vec::new();
    let mut support_records = Vec::new();
    let mut skipped_records = Vec::new();
    let mut source_count = 0usize;
    let mut copied_count = 0usize;
    let mut source_support_count = 0usize;
    let mut copied_support_count = 0usize;
    let mut used_destinations = BTreeSet::new();

    for node in &ctx.graph.nodes {
        if node.id == ctx.node.id {
            continue;
        }
        let Some(generated_context) = generated_test_aggregation_context(ctx, node) else {
            continue;
        };
        let attempt_dir = ctx.artifact_store.layout().artifact_dir(&node.id);
        let source_manifest = attempt_dir.join("generated-tests.json");
        for generated in read_generated_tests_manifest(&attempt_dir)? {
            let role = match generated.role {
                GeneratedTestManifestEntryRole::Test => {
                    source_count += 1;
                    "test"
                }
                GeneratedTestManifestEntryRole::Support => {
                    source_support_count += 1;
                    "support"
                }
            };
            let source = attempt_dir.join(&generated.artifact_path);
            if !is_regular_file_no_symlink(&source)? {
                skipped_records.push(json!({
                    "node_id": node.id,
                    "strategy": generated_context.strategy.clone(),
                    "attempt_index": generated_context.attempt_index,
                    "role": role,
                    "source_manifest_path": source_manifest,
                    "source_artifact": generated.artifact_path,
                    "source_artifact_path": source,
                    "source_relative_path": generated.source_relative_path,
                    "reason": "missing-source-artifact",
                }));
                continue;
            }

            let destination_relative = unique_aggregated_test_path(
                workspace_path,
                &generated_context.strategy,
                generated_context.attempt_index,
                &generated.source_relative_path,
                &mut used_destinations,
            );
            let destination = workspace_path.join(&destination_relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            ensure_copy_destination_not_symlink(&destination)?;
            fs::copy(&source, &destination)?;
            let bytes = fs::metadata(&destination)
                .map(|metadata| metadata.len())
                .unwrap_or_default();
            let record = json!({
                "node_id": node.id,
                "strategy": generated_context.strategy.clone(),
                "attempt_index": generated_context.attempt_index,
                "model_id": generated_context.model_id.clone(),
                "model": generated_context.model.clone(),
                "model_index": generated_context.model_index,
                "loop_index": generated_context.loop_index,
                "source_manifest_path": source_manifest,
                "source_artifact": generated.artifact_path,
                "source_artifact_path": source,
                "source_relative_path": generated.source_relative_path,
                "destination": destination_relative,
                "destination_path": destination,
                "destination_relative_path": destination_relative,
                "status": "copied",
                "bytes": bytes,
            });
            match generated.role {
                GeneratedTestManifestEntryRole::Test => {
                    copied_count += 1;
                    records.push(record);
                }
                GeneratedTestManifestEntryRole::Support => {
                    copied_support_count += 1;
                    support_records.push(record);
                }
            }
        }
    }

    write_json_artifact(
        artifact_dir,
        "aggregation.json",
        &json!({
            "schema_version": "1.0",
            "prepared_by": "ultrafuzz",
            "target_repo": ctx.resolved_config.project.repo,
            "workspace": workspace_path,
            "source_test_files": source_count,
            "copied_test_files": copied_count,
            "source_support_files": source_support_count,
            "copied_support_files": copied_support_count,
            "generated_test_dir": "test/foundry",
            "staged_index_changed": false,
            "files": records,
            "support_files": support_records,
            "skipped_files": skipped_records,
        }),
    )
}

fn validate_agentic_aggregate_workspace_outputs(
    artifact_dir: &Path,
    workspace_path: &Path,
) -> anyhow::Result<()> {
    let manifest_path = artifact_dir.join("aggregation.json");
    let manifest = read_json_value(&manifest_path)?;
    validate_agentic_aggregate_record_array(&manifest, "files", workspace_path)?;
    validate_agentic_aggregate_record_array(&manifest, "support_files", workspace_path)?;
    Ok(())
}

fn validate_agentic_aggregate_record_array(
    manifest: &Value,
    field: &str,
    workspace_path: &Path,
) -> anyhow::Result<()> {
    let records = manifest
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("aggregation.json field `{field}` must be an array"))?;
    for (index, record) in records.iter().enumerate() {
        if record.get("status").and_then(Value::as_str) != Some("copied") {
            continue;
        }
        let destination_path = record
            .get("destination_path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!("aggregation.json {field}[{index}] is missing destination_path")
            })?;
        let destination_relative = record
            .get("destination_relative_path")
            .and_then(Value::as_str)
            .or_else(|| record.get("destination").and_then(Value::as_str))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "aggregation.json {field}[{index}] is missing destination_relative_path"
                )
            })?;
        let destination_relative = Path::new(destination_relative);
        validate_artifact_relative_path(destination_relative)?;
        let expected_destination = workspace_path.join(destination_relative);
        let destination_path = Path::new(destination_path);
        if !destination_path.starts_with(workspace_path) {
            anyhow::bail!(
                "aggregation.json {field}[{index}] destination_path `{}` is outside aggregate workspace `{}`",
                destination_path.display(),
                workspace_path.display()
            );
        }
        if destination_path != expected_destination {
            anyhow::bail!(
                "aggregation.json {field}[{index}] destination_path `{}` does not match destination_relative_path `{}` under workspace `{}`",
                destination_path.display(),
                destination_relative.display(),
                workspace_path.display()
            );
        }
        if !is_regular_file_no_symlink(destination_path)? {
            anyhow::bail!(
                "aggregation.json {field}[{index}] destination_path `{}` does not exist as a regular workspace file",
                destination_path.display()
            );
        }
        if let Some(expected_bytes) = record.get("bytes").and_then(Value::as_u64) {
            let actual_bytes = fs::metadata(destination_path)?.len();
            if actual_bytes != expected_bytes {
                anyhow::bail!(
                    "aggregation.json {field}[{index}] destination_path `{}` has {} bytes, expected {}",
                    destination_path.display(),
                    actual_bytes,
                    expected_bytes
                );
            }
        }
    }
    Ok(())
}

impl Default for CampaignNodeRunner {
    fn default() -> Self {
        Self::new(Arc::new(FilesystemWorkspaceManager::new()))
    }
}

impl NodeRunner for CampaignNodeRunner {
    fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput> {
        if is_meta_node(&ctx.node) {
            return Ok(NodeOutput::default());
        }
        let artifact_dir = ctx.artifact_dir.clone();
        fs::create_dir_all(&artifact_dir)?;
        match &ctx.node.kind {
            NodeKind::Meta { .. } => Ok(NodeOutput::default()),
            NodeKind::Agentic {
                logical_id,
                prompt_path,
                attempt_index,
                loop_count,
                loop_mode,
                required_artifacts,
                ..
            } => self.run_agentic(
                &ctx,
                &artifact_dir,
                logical_id,
                prompt_path,
                *attempt_index,
                *loop_count,
                *loop_mode,
                required_artifacts,
            ),
            NodeKind::Reference {
                reference,
                required_artifacts,
                primary_artifact,
                ..
            } => self.run_reference(
                &ctx,
                &artifact_dir,
                reference,
                required_artifacts,
                primary_artifact.as_deref(),
            ),
            NodeKind::ProjectDiscovery => self.run_project_discovery(&ctx, &artifact_dir),
            NodeKind::PrepareFoundryHarness => {
                self.run_prepare_foundry_harness(&ctx, &artifact_dir)
            }
            NodeKind::DiscoverBaseTest => self.run_discover_base_test(&ctx, &artifact_dir),
            NodeKind::PropertySpecificationLens { lens } => {
                self.run_property_specification_lens(&ctx, &artifact_dir, *lens)
            }
            NodeKind::PropertySpecificationFanIn => {
                self.run_property_specification_fanin(&ctx, &artifact_dir)
            }
            NodeKind::PropertySpecification => self.run_property_specification(&ctx, &artifact_dir),
            NodeKind::AgentAttempt {
                strategy,
                attempt_index,
                model_id,
                model_index,
                loop_index,
                prompt_id,
            } => self.run_agent_attempt(
                &ctx,
                &artifact_dir,
                AttemptNodeRef {
                    strategy,
                    attempt_index: *attempt_index,
                    model_id,
                    model_index: *model_index,
                    loop_index: *loop_index,
                    prompt_id,
                },
            ),
            NodeKind::ConsolidateStrategy { strategy } => {
                self.run_consolidate(&ctx, &artifact_dir, strategy)
            }
            NodeKind::DedupeFindings => self.run_dedupe(&ctx, &artifact_dir),
            NodeKind::TriageFindings => self.run_triage(&ctx, &artifact_dir),
            NodeKind::AggregateTestFiles => self.run_aggregate_test_files(&ctx, &artifact_dir),
        }
    }
}

/// Deterministic in-process runner for scheduler tests and library smoke checks.
///
/// The CLI uses `CampaignNodeRunner`; this runner never invokes agent backends.
#[derive(Clone, Debug, Default)]
pub struct SyntheticNodeRunner;

impl NodeRunner for SyntheticNodeRunner {
    fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput> {
        if is_meta_node(&ctx.node) {
            return Ok(NodeOutput::default());
        }
        let artifact_dir = ctx.artifact_dir.clone();
        let workspace_dir = ctx.workspace_dir.clone();
        fs::create_dir_all(&artifact_dir)?;
        fs::create_dir_all(&workspace_dir)?;
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCreated {
                node_id: ctx.node.id.clone(),
                path: workspace_dir.clone(),
            },
        )?;

        let mut artifacts = Vec::new();
        let stdout_path = write_artifact(
            &artifact_dir,
            "stdout.log",
            format!("synthetic runner completed {}\n", ctx.node.id),
        )?;
        artifacts.push(ArtifactRef::new(stdout_path.clone()));
        let stderr_path = write_artifact(&artifact_dir, "stderr.log", "")?;
        artifacts.push(ArtifactRef::new(stderr_path));

        match &ctx.node.kind {
            NodeKind::Meta { .. } => {}
            NodeKind::Agentic {
                logical_id,
                prompt_path,
                attempt_index,
                loop_count,
                loop_mode,
                required_artifacts,
                ..
            } => {
                let output_findings_path = artifact_dir.join("findings.json");
                let output_patch_path = artifact_dir.join("patch.diff");
                let output_metadata_path = artifact_dir.join("metadata.json");
                let repo = target_repo(&ctx.resolved_config)?;
                let rendered = render_agentic_prompt(
                    &ctx,
                    &artifact_dir,
                    &repo,
                    &workspace_dir,
                    logical_id,
                    prompt_path,
                    *attempt_index,
                    *loop_count,
                    *loop_mode,
                    &output_findings_path,
                    &output_patch_path,
                    &output_metadata_path,
                    required_artifacts,
                )?;
                emit_event(
                    ctx.event_sink.as_ref(),
                    &ctx.run_id,
                    RunEvent::PromptRendered {
                        node_id: ctx.node.id.clone(),
                        path: rendered.clone(),
                    },
                )?;
                artifacts.push(ArtifactRef::new(rendered));
                let findings_path = write_artifact(&artifact_dir, "findings.json", "[]\n")?;
                artifacts.push(ArtifactRef::new(findings_path));
                let transcript_path =
                    write_artifact(&artifact_dir, "transcript.json", "{\n  \"events\": []\n}\n")?;
                artifacts.push(ArtifactRef::new(transcript_path));
                let metadata_path = write_artifact(
                    &artifact_dir,
                    "metadata.json",
                    serde_json::to_string_pretty(&json!({
                        "runner": "synthetic",
                        "node_id": ctx.node.id,
                        "logical_node_id": logical_id,
                        "attempt_index": attempt_index,
                    }))?,
                )?;
                artifacts.push(ArtifactRef::new(metadata_path));
                for required in required_artifacts {
                    let path = artifact_dir.join(required);
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    if !path.exists() {
                        fs::write(&path, "{}\n")?;
                    }
                    artifacts.push(ArtifactRef::new(path));
                }
            }
            NodeKind::Reference {
                reference,
                required_artifacts,
                primary_artifact,
                ..
            } => {
                let Some(primary_artifact) = primary_artifact else {
                    anyhow::bail!("reference node `{}` has no primary_artifact", ctx.node.id);
                };
                let primary_path = write_relative_artifact(
                    &artifact_dir,
                    primary_artifact,
                    format!(
                        "# Synthetic Reference: {reference}\n\nSynthetic runner placeholder for pinned reference `{reference}`.\n"
                    ),
                )?;
                artifacts.push(ArtifactRef::new(primary_path));
                let manifest_path = write_json_relative_artifact(
                    &artifact_dir,
                    Path::new(RUN_REFERENCE_MANIFEST_FILE),
                    &json!({
                        "schema_version": "1.0",
                        "reference": reference.to_string(),
                        "synthetic": true,
                    }),
                )?;
                artifacts.push(ArtifactRef::new(manifest_path));
                for required in required_artifacts {
                    let path = artifact_dir.join(required);
                    if !path.exists() {
                        let _ = write_relative_artifact(
                            &artifact_dir,
                            required,
                            format!("synthetic reference artifact `{}`\n", required.display()),
                        )?;
                    }
                    if !artifacts.iter().any(|artifact| artifact.path == path) {
                        artifacts.push(ArtifactRef::new(path));
                    }
                }
            }
            NodeKind::AgentAttempt {
                strategy,
                attempt_index,
                model_id,
                model_index,
                loop_index,
                prompt_id,
            } => {
                let output_findings_path = artifact_dir.join("findings.json");
                let output_patch_path = artifact_dir.join(PATCH_FILE);
                let output_metadata_path = artifact_dir.join("metadata.json");
                let template = ctx
                    .prompt_registry
                    .get(prompt_id)
                    .ok_or_else(|| anyhow::anyhow!("missing prompt template `{prompt_id}`"))?;
                let model_profile = model_profile_for_attempt(&ctx.resolved_config, model_id)?;
                let strategy_source = match &template.source {
                    PromptSource::BuiltIn => "built-in".to_owned(),
                    PromptSource::Project(path) => format!("project:{}", path.display()),
                };
                let strategy_loop_count =
                    configured_strategy_loop_count(&ctx.resolved_config, strategy);
                let mut render_context = PromptRenderContext::new();
                render_context.insert(
                    "repo_path",
                    ctx.resolved_config.project.repo.display().to_string(),
                );
                render_context.insert("workspace_path", workspace_dir.display().to_string());
                render_context.insert("artifact_path", artifact_dir.display().to_string());
                render_context.insert("artifact_dir", artifact_dir.display().to_string());
                render_context.insert(
                    "run_artifacts_path",
                    ctx.artifact_store.layout().artifacts.display().to_string(),
                );
                render_context.insert(
                    "run_artifacts_dir",
                    ctx.artifact_store.layout().artifacts.display().to_string(),
                );
                insert_run_metadata_context(&mut render_context, &ctx, &artifact_dir)?;
                render_context.insert(
                    "output_findings_path",
                    output_findings_path.display().to_string(),
                );
                render_context.insert("output_patch_path", output_patch_path.display().to_string());
                render_context.insert(
                    "output_metadata_path",
                    output_metadata_path.display().to_string(),
                );
                render_context.insert("run_id", ctx.run_id.to_string());
                render_context.insert("node_id", ctx.node.id.to_string());
                render_context.insert("strategy", strategy.to_string());
                render_context.insert("strategy_display_name", template.display_name.clone());
                render_context.insert("strategy_source", strategy_source);
                render_context.insert("attempt_index", attempt_index.to_string());
                render_context.insert("strategy_loop_index", loop_index.to_string());
                render_context.insert("strategy_loop_count", strategy_loop_count.to_string());
                insert_campaign_tunable_context(&mut render_context, &ctx.resolved_config);
                render_context.insert(
                    "strategy_attempt_test_dir",
                    workspace_dir
                        .join("test/foundry")
                        .join(strategy.as_str())
                        .display()
                        .to_string(),
                );
                render_context.insert(
                    "aggregation_destination_dir",
                    ctx.resolved_config
                        .project
                        .repo
                        .join("test/foundry")
                        .join(strategy.as_str())
                        .join(format!("attempt-{attempt_index}"))
                        .display()
                        .to_string(),
                );
                render_context.insert("backend_kind", model_profile.backend.to_string());
                let prompt_path = render_and_write_prompt_with_artifact_paths(
                    &ctx,
                    &template.body,
                    &render_context,
                    &artifact_dir,
                )?;
                emit_event(
                    ctx.event_sink.as_ref(),
                    &ctx.run_id,
                    RunEvent::PromptRendered {
                        node_id: ctx.node.id.clone(),
                        path: prompt_path.clone(),
                    },
                )?;
                artifacts.push(ArtifactRef::new(prompt_path));

                let findings_path = write_artifact(&artifact_dir, "findings.json", "[]\n")?;
                artifacts.push(ArtifactRef::new(findings_path));
                let transcript_path =
                    write_artifact(&artifact_dir, "transcript.json", "{\n  \"events\": []\n}\n")?;
                artifacts.push(ArtifactRef::new(transcript_path));
                let metadata = json!({
                    "runner": "synthetic",
                    "node_id": ctx.node.id,
                    "strategy": strategy,
                    "attempt_index": attempt_index,
                    "model_id": model_id,
                    "model": model_profile.model.clone(),
                    "model_index": model_index,
                    "loop_index": loop_index,
                    "backend": model_profile.backend,
                    "prompt_rendered": artifact_dir.join(RENDERED_PROMPT_FILE),
                    "stdout": stdout_path,
                });
                let metadata_path = write_artifact(
                    &artifact_dir,
                    "metadata.json",
                    serde_json::to_string_pretty(&metadata)?,
                )?;
                artifacts.push(ArtifactRef::new(metadata_path));
                artifacts.push(ArtifactRef::new(write_json_artifact(
                    &artifact_dir,
                    "generated-tests.json",
                    &json!({
                        "schema_version": "1.0",
                        "node_id": ctx.node.id,
                        "strategy": strategy,
                        "attempt_index": attempt_index,
                        "model_id": model_id,
                        "model": model_profile.model.clone(),
                        "model_index": model_index,
                        "loop_index": loop_index,
                        "test_files": [],
                    }),
                )?));
            }
            NodeKind::PropertySpecificationLens { lens } => {
                artifacts.push(ArtifactRef::new(write_json_artifact(
                    &artifact_dir,
                    PROPERTY_LENS_CANDIDATE_FILE,
                    &json!({
                        "schema_version": "1.0",
                        "lens_id": lens.id(),
                        "lens_display_name": lens.label(),
                        "status": "succeeded",
                        "candidate_properties": [
                            {
                                "id": format!("synthetic-{}-property", lens.id()),
                                "title": format!("Synthetic {} property", lens.id()),
                                "source_lens_id": lens.id(),
                                "source_evidence": ["synthetic runner"],
                                "property_type": "high-level",
                                "workflow": "synthetic workflow",
                                "oracle": "synthetic oracle must hold",
                                "required_setup": "synthetic setup",
                                "preconditions": [],
                                "suggested_fuzzing_framework_or_strategy_fit": "Foundry",
                                "suggested_priority_signal": "medium",
                                "confidence": "low",
                                "false_positive_or_setup_bias_risks": [],
                                "notes": []
                            }
                        ],
                        "errors": []
                    }),
                )?));
                artifacts.push(ArtifactRef::new(write_artifact(
                    &artifact_dir,
                    "findings.json",
                    "[]\n",
                )?));
                artifacts.push(ArtifactRef::new(write_metadata(&ctx, &artifact_dir)?));
            }
            NodeKind::PropertySpecificationFanIn => {
                let compatibility_dir = ctx
                    .artifact_store
                    .layout()
                    .artifact_dir(&NodeId::from(PROPERTY_SPECIFICATION_COMPAT_DIR));
                fs::create_dir_all(&compatibility_dir)?;
                artifacts.push(ArtifactRef::new(write_json_artifact(
                    &compatibility_dir,
                    PROPERTY_SPECIFICATION_FILE,
                    &json!({
                        "schema_version": "1.0",
                        "documentation_sources": [],
                        "guidance_applied": ["synthetic runner"],
                        "lens_inputs": [],
                        "candidate_properties": [
                            {
                                "id": "synthetic-property",
                                "title": "Synthetic property",
                                "property_type": "high-level",
                                "priority": "medium",
                                "source": "synthetic runner",
                                "source_lenses": [],
                                "source_evidence": ["synthetic runner"],
                                "workflow": "synthetic workflow",
                                "oracle": "synthetic oracle must hold",
                                "setup": "synthetic setup",
                                "preconditions": [],
                                "frameworks": ["Foundry"],
                                "confidence": "low",
                                "failure_classification": "inconclusive",
                                "false_positive_or_setup_bias_risks": [],
                                "notes": []
                            }
                        ],
                        "deferred_or_rejected_properties": [],
                        "findings": []
                    }),
                )?));
                artifacts.push(ArtifactRef::new(write_artifact(
                    &compatibility_dir,
                    "findings.json",
                    "[]\n",
                )?));
                artifacts.push(ArtifactRef::new(write_metadata(&ctx, &artifact_dir)?));
            }
            NodeKind::ConsolidateStrategy { strategy } => {
                let findings_path = write_artifact(&artifact_dir, "findings.json", "[]\n")?;
                artifacts.push(ArtifactRef::new(findings_path));
                let summary_path = write_artifact(
                    &artifact_dir,
                    "summary.md",
                    format!("# Consolidated {strategy}\n\nNo findings in synthetic run.\n"),
                )?;
                artifacts.push(ArtifactRef::new(summary_path));
                artifacts.push(ArtifactRef::new(write_metadata(&ctx, &artifact_dir)?));
            }
            NodeKind::DedupeFindings => {
                artifacts.push(ArtifactRef::new(write_artifact(
                    &artifact_dir,
                    "deduped-findings.json",
                    "[]\n",
                )?));
                artifacts.push(ArtifactRef::new(write_metadata(&ctx, &artifact_dir)?));
            }
            NodeKind::TriageFindings => {
                artifacts.push(ArtifactRef::new(write_artifact(
                    &artifact_dir,
                    TRIAGED_FINDINGS_FILE,
                    "[]\n",
                )?));
                artifacts.push(ArtifactRef::new(write_metadata(&ctx, &artifact_dir)?));
            }
            NodeKind::AggregateTestFiles => {
                artifacts.push(ArtifactRef::new(write_artifact(
                    &artifact_dir,
                    "aggregation.json",
                    "{\n  \"schema_version\": \"1.0\",\n  \"source_test_files\": 0,\n  \"copied_test_files\": 0,\n  \"files\": []\n}\n",
                )?));
                artifacts.push(ArtifactRef::new(write_metadata(&ctx, &artifact_dir)?));
            }
            NodeKind::ProjectDiscovery
            | NodeKind::PrepareFoundryHarness
            | NodeKind::DiscoverBaseTest
            | NodeKind::PropertySpecification => {
                artifacts.push(ArtifactRef::new(write_metadata(&ctx, &artifact_dir)?));
            }
        }

        for artifact in &artifacts {
            emit_event(
                ctx.event_sink.as_ref(),
                &ctx.run_id,
                RunEvent::ArtifactCreated {
                    node_id: ctx.node.id.clone(),
                    path: artifact.path.clone(),
                },
            )?;
        }
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::WorkspaceCleaned {
                node_id: ctx.node.id.clone(),
            },
        )?;
        emit_event(
            ctx.event_sink.as_ref(),
            &ctx.run_id,
            RunEvent::LogLine {
                node_id: ctx.node.id.clone(),
                stream: LogStream::System,
                line: "synthetic node completed".to_owned(),
            },
        )?;

        Ok(NodeOutput { artifacts })
    }
}

pub fn validate_only(graph: &CampaignGraph) -> anyhow::Result<RunResult> {
    graph.validate()?;
    Ok(RunResult {
        run_id: graph.run_id.clone(),
        status: RunStatus::Succeeded,
    })
}

fn node_state_mut<'a>(
    state: &'a mut RunState,
    node_id: &NodeId,
) -> anyhow::Result<&'a mut NodeState> {
    state.nodes.get_mut(node_id).ok_or_else(|| {
        anyhow::anyhow!(
            "run state has no entry for node `{node_id}`; the state file may be stale or corrupted"
        )
    })
}

fn complete_meta_node(
    node: &Node,
    graph: &CampaignGraph,
    state: &mut RunState,
    request: &ExecutionRequest,
) -> anyhow::Result<()> {
    let node_state = node_state_mut(state, &node.id)?;
    node_state.status = NodeStatus::Succeeded;
    node_state.finished_at = Some(now_string());
    node_state.last_error = None;
    node_state.retry_after_epoch_ms = None;
    emit_event(
        request.event_sink.as_ref(),
        &graph.run_id,
        RunEvent::NodeFinished {
            node_id: node.id.clone(),
        },
    )?;
    Ok(())
}

fn mark_node_succeeded(
    node: &Node,
    output: NodeOutput,
    state: &mut RunState,
    request: &ExecutionRequest,
) -> anyhow::Result<()> {
    let usage = collect_node_usage(node, state, request)?;
    {
        let node_state = node_state_mut(state, &node.id)?;
        node_state.status = NodeStatus::Succeeded;
        node_state.finished_at = Some(now_string());
        node_state.last_error = None;
        node_state.retry_after_epoch_ms = None;
        node_state.usage = merge_node_usage(node_state.usage.take(), usage);
    }
    state.refresh_usage_summary();
    request.state_store.save(state)?;
    emit_event(
        request.event_sink.as_ref(),
        &request.graph.run_id,
        RunEvent::NodeFinished {
            node_id: node.id.clone(),
        },
    )?;
    if let NodeKind::AgentAttempt { model_id, .. } = &node.kind {
        let profile = request.resolved_config.model_profile(model_id);
        emit_event(
            request.event_sink.as_ref(),
            &request.graph.run_id,
            RunEvent::AttemptFinished {
                attempt_id: attempt_id_for_node(node),
                node_id: node.id.clone(),
                model_id: model_id.clone(),
            },
        )?;
        emit_event(
            request.event_sink.as_ref(),
            &request.graph.run_id,
            RunEvent::BackendFinished {
                node_id: node.id.clone(),
                backend: profile
                    .map(|profile| profile.backend)
                    .unwrap_or(request.resolved_config.backend.default),
                model_id: model_id.clone(),
                model: profile.and_then(|profile| profile.model.clone()),
            },
        )?;
    }
    if let NodeKind::Agentic {
        logical_id,
        attempt_index,
        ..
    } = &node.kind
    {
        let (model_id, model_profile) =
            default_model_profile_for_agentic(&request.resolved_config)?;
        emit_event(
            request.event_sink.as_ref(),
            &request.graph.run_id,
            RunEvent::AttemptFinished {
                attempt_id: AttemptId::from(format!("{logical_id}-{attempt_index}")),
                node_id: node.id.clone(),
                model_id: model_id.clone(),
            },
        )?;
        emit_event(
            request.event_sink.as_ref(),
            &request.graph.run_id,
            RunEvent::BackendFinished {
                node_id: node.id.clone(),
                backend: model_profile.backend,
                model_id,
                model: model_profile.model.clone(),
            },
        )?;
    }
    for artifact in output.artifacts {
        emit_event(
            request.event_sink.as_ref(),
            &request.graph.run_id,
            RunEvent::ArtifactCreated {
                node_id: node.id.clone(),
                path: artifact.path,
            },
        )?;
    }
    request.artifact_store.write_manifest(&node.id)?;
    emit_event(
        request.event_sink.as_ref(),
        &request.graph.run_id,
        RunEvent::ArtifactCreated {
            node_id: node.id.clone(),
            path: request
                .artifact_store
                .layout()
                .artifact_dir(&node.id)
                .join(ARTIFACT_MANIFEST_FILE),
        },
    )?;
    Ok(())
}

fn collect_node_usage(
    node: &Node,
    state: &RunState,
    request: &ExecutionRequest,
) -> anyhow::Result<Option<NodeUsage>> {
    let node_state = state.nodes.get(&node.id).ok_or_else(|| {
        anyhow::anyhow!(
            "run state has no entry for node `{}`; the state file may be stale or corrupted",
            node.id
        )
    })?;
    let stdout_path = request
        .artifact_store
        .layout()
        .artifact_dir(&node.id)
        .join("stdout.log");
    let Some(contents) = read_usage_log(&stdout_path)? else {
        return Ok(None);
    };
    let mut records = parse_usage_log(&contents, node_state);
    if let Some(backend_provider) = node_state.backend.map(provider_for_backend) {
        records.retain(|record| record.provider == backend_provider);
    }
    if records.is_empty() {
        return Ok(None);
    }

    let mut tokens = TokenUsage::default();
    let mut estimated_cost_microusd = 0u64;
    let mut has_cost = false;
    let mut unresolved_pricing = Vec::<String>::new();
    let provider = node_state
        .backend
        .map(provider_for_backend)
        .or_else(|| records.first().map(|record| record.provider))
        .unwrap_or("unknown");
    let model = node_state
        .model
        .clone()
        .or_else(|| records.iter().find_map(|record| record.model.clone()));
    for record in &mut records {
        tokens.add(&record.tokens);
        if record.model.is_none() {
            record.model = model.clone();
        }
        let (cost, mut unresolved) = estimate_usage_cost(
            record.provider,
            record.model.as_deref(),
            &record.tokens,
            &record.raw_usage,
        );
        if let Some(cost) = cost {
            estimated_cost_microusd = estimated_cost_microusd.saturating_add(cost);
            has_cost = true;
        }
        for reason in unresolved.drain(..) {
            if !unresolved_pricing.contains(&reason) {
                unresolved_pricing.push(reason);
            }
        }
    }

    if !tokens.has_tokens() {
        return Ok(None);
    }
    let cost_status = if unresolved_pricing.is_empty() && has_cost {
        CostEstimateStatus::Complete
    } else if has_cost {
        CostEstimateStatus::Partial
    } else {
        CostEstimateStatus::Unknown
    };
    let estimated_cost_microusd = has_cost.then_some(estimated_cost_microusd);
    let source_path = stdout_path
        .strip_prefix(&request.artifact_store.layout().root)
        .unwrap_or(&stdout_path)
        .to_path_buf();
    Ok(Some(NodeUsage {
        schema_version: ACCOUNTING_SCHEMA_VERSION.to_owned(),
        pricing_as_of: PRICING_AS_OF.to_owned(),
        source_path,
        provider: provider.to_owned(),
        backend: node_state.backend,
        model_id: node_state.model_id.clone(),
        model,
        tokens_used: format_token_count(tokens.total_tokens),
        tokens,
        cost_status: cost_status.clone(),
        estimated_cost_microusd,
        estimated_spend: spend_display(cost_status, estimated_cost_microusd, &unresolved_pricing),
        unresolved_pricing,
    }))
}

fn read_usage_log(stdout_path: &Path) -> anyhow::Result<Option<String>> {
    read_limited_regular_text_file(stdout_path, MAX_USAGE_LOG_BYTES)
}

fn read_backend_error_log(path: &Path, max_bytes: u64) -> anyhow::Result<Option<String>> {
    read_limited_regular_text_file(path, max_bytes)
}

fn read_limited_regular_text_file(path: &Path, max_bytes: u64) -> anyhow::Result<Option<String>> {
    let Some(file) = open_usage_log_file(path)? else {
        return Ok(None);
    };
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.len() > max_bytes {
        return Ok(None);
    }
    let mut contents = String::new();
    let mut limited = file.take(max_bytes + 1);
    limited.read_to_string(&mut contents)?;
    if contents.len() as u64 > max_bytes {
        return Ok(None);
    }
    Ok(Some(contents))
}

#[cfg(unix)]
fn open_usage_log_file(stdout_path: &Path) -> anyhow::Result<Option<fs::File>> {
    use std::os::unix::fs::OpenOptionsExt;

    match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(stdout_path)
    {
        Ok(file) => Ok(Some(file)),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ELOOP) =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(not(unix))]
fn open_usage_log_file(stdout_path: &Path) -> anyhow::Result<Option<fs::File>> {
    match fs::File::open(stdout_path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn merge_node_usage(existing: Option<NodeUsage>, current: Option<NodeUsage>) -> Option<NodeUsage> {
    match (existing, current) {
        (None, None) => None,
        (Some(usage), None) | (None, Some(usage)) => Some(usage),
        (Some(mut existing), Some(current)) => {
            existing.tokens.add(&current.tokens);
            existing.tokens_used = format_token_count(existing.tokens.total_tokens);
            existing.source_path = current.source_path;
            existing.backend = current.backend.or(existing.backend);
            existing.model_id = current.model_id.or(existing.model_id);
            existing.model = current.model.or(existing.model);
            existing.provider = current.provider;
            let mut unresolved = BTreeSet::<String>::new();
            unresolved.extend(existing.unresolved_pricing);
            unresolved.extend(current.unresolved_pricing);
            existing.unresolved_pricing = unresolved.into_iter().collect();
            let total_cost = existing
                .estimated_cost_microusd
                .unwrap_or(0)
                .saturating_add(current.estimated_cost_microusd.unwrap_or(0));
            let has_cost = existing.estimated_cost_microusd.is_some()
                || current.estimated_cost_microusd.is_some();
            existing.estimated_cost_microusd = has_cost.then_some(total_cost);
            existing.cost_status = if existing.unresolved_pricing.is_empty() && has_cost {
                CostEstimateStatus::Complete
            } else if has_cost {
                CostEstimateStatus::Partial
            } else {
                CostEstimateStatus::Unknown
            };
            existing.estimated_spend = spend_display(
                existing.cost_status.clone(),
                existing.estimated_cost_microusd,
                &existing.unresolved_pricing,
            );
            Some(existing)
        }
    }
}

fn parse_usage_log(contents: &str, node_state: &NodeState) -> Vec<ParsedUsageRecord> {
    let mut codex_total: Option<(TokenUsage, Value)> = None;
    let mut codex_last_sum = TokenUsage::default();
    let mut claude_message_candidates = BTreeMap::<String, UsageCandidate>::new();
    let mut claude_result_candidates = BTreeMap::<String, UsageCandidate>::new();

    for (line_index, line) in contents.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        if let Some((usage, raw, cumulative)) = codex_usage_from_event(&value) {
            if cumulative {
                codex_total = Some((usage, raw));
            } else {
                codex_last_sum.add(&usage);
            }
            continue;
        }

        for candidate in anthropic_usage_candidates(&value, line_index) {
            match candidate.kind {
                AnthropicUsageKind::Message => {
                    claude_message_candidates.insert(candidate.key.clone(), candidate);
                }
                AnthropicUsageKind::Result => {
                    claude_result_candidates.insert(candidate.key.clone(), candidate);
                }
            }
        }
    }

    let mut records = Vec::new();
    if let Some((tokens, raw_usage)) = codex_total {
        if tokens.has_tokens() {
            records.push(ParsedUsageRecord {
                provider: PROVIDER_OPENAI,
                model: node_state.model.clone(),
                tokens,
                raw_usage,
            });
        }
    } else if codex_last_sum.has_tokens() {
        let raw_usage = serde_json::to_value(&codex_last_sum).unwrap_or(Value::Null);
        records.push(ParsedUsageRecord {
            provider: PROVIDER_OPENAI,
            model: node_state.model.clone(),
            tokens: codex_last_sum,
            raw_usage,
        });
    }

    let claude_candidates = if claude_result_candidates.is_empty() {
        claude_message_candidates
    } else {
        claude_result_candidates
    };

    for candidate in claude_candidates.into_values() {
        if candidate.tokens.has_tokens() {
            records.push(ParsedUsageRecord {
                provider: PROVIDER_ANTHROPIC,
                model: candidate.model.or_else(|| node_state.model.clone()),
                tokens: candidate.tokens,
                raw_usage: candidate.raw_usage,
            });
        }
    }

    records
}

fn codex_usage_from_event(value: &Value) -> Option<(TokenUsage, Value, bool)> {
    if value.get("type").and_then(Value::as_str) == Some("turn.completed") {
        let raw = value.get("usage")?;
        return Some((openai_usage_from_value(raw), raw.clone(), false));
    }

    let info = if value.pointer("/payload/type").and_then(Value::as_str) == Some("token_count") {
        value.pointer("/payload/info")?
    } else if value.get("type").and_then(Value::as_str) == Some("token_count") {
        value.get("info")?
    } else {
        return None;
    };

    if let Some(raw) = info.get("total_token_usage") {
        return Some((openai_usage_from_value(raw), raw.clone(), true));
    }
    let raw = info.get("last_token_usage")?;
    Some((openai_usage_from_value(raw), raw.clone(), false))
}

fn anthropic_usage_candidates(value: &Value, line_index: usize) -> Vec<UsageCandidate> {
    let message = value.get("message").filter(|message| message.is_object());
    let (usage, kind) = if let Some(usage) = message.and_then(|message| message.get("usage")) {
        (usage, AnthropicUsageKind::Message)
    } else if let Some(usage) = value.get("usage") {
        (usage, AnthropicUsageKind::Result)
    } else {
        return Vec::new();
    };
    if !usage.is_object() {
        return Vec::new();
    }

    let request_id = optional_string_value(value.get("requestId"))
        .or_else(|| optional_string_value(value.get("request_id")));
    let message_id = message
        .and_then(|message| optional_string_value(message.get("id")))
        .or_else(|| optional_string_value(value.get("id")));
    let base_key = request_id
        .or(message_id)
        .unwrap_or_else(|| format!("line-{line_index}"));
    let base_model = message
        .and_then(|message| optional_string_value(message.get("model")))
        .or_else(|| optional_string_value(value.get("model")));

    if let Some(iterations) = usage.get("iterations").and_then(Value::as_array) {
        if !iterations.is_empty() {
            return iterations
                .iter()
                .enumerate()
                .filter_map(|(index, iteration)| {
                    if !iteration.is_object() {
                        return None;
                    }
                    let tokens = anthropic_usage_from_value(iteration);
                    tokens.has_tokens().then(|| UsageCandidate {
                        key: format!("{base_key}:iteration-{index}"),
                        tokens,
                        raw_usage: iteration.clone(),
                        model: optional_string_value(iteration.get("model"))
                            .or_else(|| base_model.clone()),
                        kind,
                    })
                })
                .collect();
        }
    }

    let tokens = anthropic_usage_from_value(usage);
    if tokens.has_tokens() {
        vec![UsageCandidate {
            key: base_key,
            tokens,
            raw_usage: usage.clone(),
            model: base_model,
            kind,
        }]
    } else {
        Vec::new()
    }
}

fn openai_usage_from_value(value: &Value) -> TokenUsage {
    let input_tokens = u64_field(value, "input_tokens");
    let cached_input_tokens = u64_field(value, "cached_input_tokens").max(
        value
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    );
    let output_tokens = u64_field(value, "output_tokens");
    let reasoning_output_tokens = u64_field(value, "reasoning_output_tokens").max(
        value
            .pointer("/output_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    );
    let total_tokens =
        u64_field(value, "total_tokens").max(input_tokens.saturating_add(output_tokens));

    TokenUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
        ..TokenUsage::default()
    }
}

fn anthropic_usage_from_value(value: &Value) -> TokenUsage {
    let input_tokens = u64_field(value, "input_tokens");
    let output_tokens = u64_field(value, "output_tokens");
    let cache_creation_input_tokens = u64_field(value, "cache_creation_input_tokens");
    let cache_read_input_tokens = u64_field(value, "cache_read_input_tokens");
    let explicit_5m = value
        .pointer("/cache_creation/ephemeral_5m_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let explicit_1h = value
        .pointer("/cache_creation/ephemeral_1h_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let explicit_total = explicit_5m.saturating_add(explicit_1h);
    let implicit_5m = cache_creation_input_tokens.saturating_sub(explicit_total);
    let server_web_search_requests = value
        .pointer("/server_tool_use/web_search_requests")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let server_web_fetch_requests = value
        .pointer("/server_tool_use/web_fetch_requests")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total_tokens = u64_field(value, "total_tokens").max(
        input_tokens
            .saturating_add(cache_creation_input_tokens)
            .saturating_add(cache_read_input_tokens)
            .saturating_add(output_tokens),
    );

    TokenUsage {
        input_tokens,
        cache_creation_input_tokens,
        cache_creation_5m_input_tokens: explicit_5m.saturating_add(implicit_5m),
        cache_creation_1h_input_tokens: explicit_1h,
        cache_read_input_tokens,
        output_tokens,
        total_tokens,
        server_web_search_requests,
        server_web_fetch_requests,
        ..TokenUsage::default()
    }
}

fn estimate_usage_cost(
    provider: &str,
    model: Option<&str>,
    tokens: &TokenUsage,
    raw_usage: &Value,
) -> (Option<u64>, Vec<String>) {
    let mut unresolved = Vec::new();
    let cost = match provider {
        PROVIDER_OPENAI => estimate_openai_cost(model, tokens, &mut unresolved),
        PROVIDER_ANTHROPIC => estimate_anthropic_cost(model, tokens, raw_usage, &mut unresolved),
        provider => {
            unresolved.push(format!("unknown provider `{provider}`"));
            None
        }
    };
    (cost, unresolved)
}

fn estimate_openai_cost(
    model: Option<&str>,
    tokens: &TokenUsage,
    unresolved: &mut Vec<String>,
) -> Option<u64> {
    let Some(model) = model else {
        unresolved.push("missing OpenAI model name".to_owned());
        return None;
    };
    let Some(rates) = openai_rates(model, tokens.input_tokens) else {
        unresolved.push(format!("unknown OpenAI model `{model}`"));
        return None;
    };
    let uncached_input = tokens
        .input_tokens
        .saturating_sub(tokens.cached_input_tokens);
    let mut cost = priced_tokens_microusd(uncached_input, rates.input_per_million).saturating_add(
        priced_tokens_microusd(tokens.output_tokens, rates.output_per_million),
    );
    if tokens.cached_input_tokens > 0 {
        if let Some(cached_rate) = rates.cached_input_per_million {
            cost = cost.saturating_add(priced_tokens_microusd(
                tokens.cached_input_tokens,
                cached_rate,
            ));
        } else {
            unresolved.push(format!(
                "OpenAI cached-input pricing unavailable for `{model}`"
            ));
        }
    }
    Some(cost)
}

fn estimate_anthropic_cost(
    model: Option<&str>,
    tokens: &TokenUsage,
    raw_usage: &Value,
    unresolved: &mut Vec<String>,
) -> Option<u64> {
    let Some(model) = model else {
        unresolved.push("missing Anthropic model name".to_owned());
        return None;
    };
    let Some(rates) = anthropic_rates(model) else {
        unresolved.push(format!("unknown Anthropic model `{model}`"));
        return None;
    };
    if optional_string_value(raw_usage.get("service_tier")).is_some_and(|tier| tier != "standard") {
        unresolved.push(format!("Anthropic non-standard service tier for `{model}`"));
    }
    if optional_string_value(raw_usage.get("speed")).is_some_and(|speed| speed != "standard") {
        unresolved.push(format!("Anthropic non-standard speed tier for `{model}`"));
    }
    if tokens.server_web_fetch_requests > 0 {
        unresolved.push(format!(
            "Anthropic web fetch pricing not estimated for `{model}`"
        ));
    }

    let mut cost = priced_tokens_microusd(tokens.input_tokens, rates.input_per_million)
        .saturating_add(priced_tokens_microusd(
            tokens.cache_creation_5m_input_tokens,
            rates.cache_write_5m_per_million,
        ))
        .saturating_add(priced_tokens_microusd(
            tokens.cache_creation_1h_input_tokens,
            rates.cache_write_1h_per_million,
        ))
        .saturating_add(priced_tokens_microusd(
            tokens.cache_read_input_tokens,
            rates.cache_read_per_million,
        ))
        .saturating_add(priced_tokens_microusd(
            tokens.output_tokens,
            rates.output_per_million,
        ));
    if tokens.server_web_search_requests > 0 {
        cost = cost.saturating_add(tokens.server_web_search_requests.saturating_mul(10_000));
    }
    Some(cost)
}

fn openai_rates(model: &str, input_tokens: u64) -> Option<OpenAiRates> {
    let model = canonical_openai_model(model);
    let long_context = input_tokens > OPENAI_LONG_CONTEXT_THRESHOLD;
    let rates = if model.starts_with("gpt-5.3-codex") {
        OpenAiRates {
            input_per_million: 1.75,
            cached_input_per_million: Some(0.175),
            output_per_million: 14.0,
        }
    } else if model == "chat-latest" {
        OpenAiRates {
            input_per_million: 5.0,
            cached_input_per_million: Some(0.5),
            output_per_million: 30.0,
        }
    } else if model.starts_with("gpt-5.5-pro") {
        if long_context {
            OpenAiRates {
                input_per_million: 60.0,
                cached_input_per_million: None,
                output_per_million: 270.0,
            }
        } else {
            OpenAiRates {
                input_per_million: 30.0,
                cached_input_per_million: None,
                output_per_million: 180.0,
            }
        }
    } else if model.starts_with("gpt-5.5") {
        if long_context {
            OpenAiRates {
                input_per_million: 10.0,
                cached_input_per_million: Some(1.0),
                output_per_million: 45.0,
            }
        } else {
            OpenAiRates {
                input_per_million: 5.0,
                cached_input_per_million: Some(0.5),
                output_per_million: 30.0,
            }
        }
    } else if model.starts_with("gpt-5.4-pro") {
        if long_context {
            OpenAiRates {
                input_per_million: 60.0,
                cached_input_per_million: None,
                output_per_million: 270.0,
            }
        } else {
            OpenAiRates {
                input_per_million: 30.0,
                cached_input_per_million: None,
                output_per_million: 180.0,
            }
        }
    } else if model.starts_with("gpt-5.4-mini") {
        OpenAiRates {
            input_per_million: 0.75,
            cached_input_per_million: Some(0.075),
            output_per_million: 4.5,
        }
    } else if model.starts_with("gpt-5.4-nano") {
        OpenAiRates {
            input_per_million: 0.20,
            cached_input_per_million: Some(0.02),
            output_per_million: 1.25,
        }
    } else if model.starts_with("gpt-5.4") {
        if long_context {
            OpenAiRates {
                input_per_million: 5.0,
                cached_input_per_million: Some(0.5),
                output_per_million: 22.5,
            }
        } else {
            OpenAiRates {
                input_per_million: 2.5,
                cached_input_per_million: Some(0.25),
                output_per_million: 15.0,
            }
        }
    } else {
        return None;
    };
    Some(rates)
}

fn anthropic_rates(model: &str) -> Option<AnthropicRates> {
    let model = canonical_anthropic_model(model);
    let rates = if model == "opus"
        || model.starts_with("claude-opus-4-8")
        || model.starts_with("claude-opus-4-7")
        || model.starts_with("claude-opus-4-6")
        || model.starts_with("claude-opus-4-5")
    {
        anthropic_rate_set(5.0, 6.25, 10.0, 0.50, 25.0)
    } else if model.starts_with("claude-opus-4-1") || model == "claude-opus-4" {
        anthropic_rate_set(15.0, 18.75, 30.0, 1.50, 75.0)
    } else if model == "sonnet"
        || model.starts_with("claude-sonnet-4-6")
        || model.starts_with("claude-sonnet-4-5")
        || model == "claude-sonnet-4"
    {
        anthropic_rate_set(3.0, 3.75, 6.0, 0.30, 15.0)
    } else if model == "haiku" || model.starts_with("claude-haiku-4-5") {
        anthropic_rate_set(1.0, 1.25, 2.0, 0.10, 5.0)
    } else if model.starts_with("claude-haiku-3-5") {
        anthropic_rate_set(0.80, 1.0, 1.60, 0.08, 4.0)
    } else if model == "fable"
        || model.starts_with("claude-fable-5")
        || model == "mythos"
        || model.starts_with("claude-mythos-5")
    {
        anthropic_rate_set(10.0, 12.50, 20.0, 1.0, 50.0)
    } else {
        return None;
    };
    Some(rates)
}

fn anthropic_rate_set(
    input_per_million: f64,
    cache_write_5m_per_million: f64,
    cache_write_1h_per_million: f64,
    cache_read_per_million: f64,
    output_per_million: f64,
) -> AnthropicRates {
    AnthropicRates {
        input_per_million,
        cache_write_5m_per_million,
        cache_write_1h_per_million,
        cache_read_per_million,
        output_per_million,
    }
}

fn provider_for_backend(backend: BackendKind) -> &'static str {
    match backend {
        BackendKind::CodexCli => PROVIDER_OPENAI,
        BackendKind::ClaudeCodeCli => PROVIDER_ANTHROPIC,
    }
}

fn priced_tokens_microusd(tokens: u64, dollars_per_million: f64) -> u64 {
    let rounded = ((tokens as f64) * dollars_per_million).round() as u64;
    if tokens > 0 && dollars_per_million > 0.0 {
        rounded.max(1)
    } else {
        rounded
    }
}

fn canonical_openai_model(model: &str) -> String {
    model
        .trim()
        .to_ascii_lowercase()
        .replace('_', "-")
        .replace("gpt-5-3", "gpt-5.3")
        .replace("gpt-5-5", "gpt-5.5")
        .replace("gpt-5-4", "gpt-5.4")
}

fn canonical_anthropic_model(model: &str) -> String {
    model
        .trim()
        .to_ascii_lowercase()
        .replace('_', "-")
        .replace("4.8", "4-8")
        .replace("4.7", "4-7")
        .replace("4.6", "4-6")
        .replace("4.5", "4-5")
        .replace("4.1", "4-1")
        .replace("3.5", "3-5")
}

fn optional_string_value(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn u64_field(value: &Value, field: &str) -> u64 {
    value.get(field).and_then(Value::as_u64).unwrap_or(0)
}

fn mark_node_failed(
    node: &Node,
    error: &str,
    state: &mut RunState,
    request: &ExecutionRequest,
) -> anyhow::Result<()> {
    let usage = collect_node_usage(node, state, request)?;
    let node_state = node_state_mut(state, &node.id)?;
    node_state.status = NodeStatus::Failed;
    node_state.finished_at = Some(now_string());
    node_state.last_error = Some(error.to_owned());
    node_state.usage = merge_node_usage(node_state.usage.take(), usage);
    state.refresh_usage_summary();
    request.state_store.save(state)?;
    emit_event(
        request.event_sink.as_ref(),
        &request.graph.run_id,
        RunEvent::NodeFailed {
            node_id: node.id.clone(),
            error: error.to_owned(),
        },
    )?;
    if let NodeKind::AgentAttempt { model_id, .. } = &node.kind {
        let profile = request.resolved_config.model_profile(model_id);
        let attempt_id = attempt_id_for_node(node);
        emit_event(
            request.event_sink.as_ref(),
            &request.graph.run_id,
            RunEvent::AttemptFailed {
                attempt_id,
                node_id: node.id.clone(),
                model_id: model_id.clone(),
                error: error.to_owned(),
            },
        )?;
        emit_event(
            request.event_sink.as_ref(),
            &request.graph.run_id,
            RunEvent::BackendFailed {
                node_id: node.id.clone(),
                backend: profile
                    .map(|profile| profile.backend)
                    .unwrap_or(request.resolved_config.backend.default),
                model_id: model_id.clone(),
                model: profile.and_then(|profile| profile.model.clone()),
                error: error.to_owned(),
            },
        )?;
    }
    if let NodeKind::Agentic {
        logical_id,
        attempt_index,
        ..
    } = &node.kind
    {
        let (model_id, model_profile) =
            default_model_profile_for_agentic(&request.resolved_config)?;
        let attempt_id = AttemptId::from(format!("{logical_id}-{attempt_index}"));
        emit_event(
            request.event_sink.as_ref(),
            &request.graph.run_id,
            RunEvent::AttemptFailed {
                attempt_id,
                node_id: node.id.clone(),
                model_id: model_id.clone(),
                error: error.to_owned(),
            },
        )?;
        emit_event(
            request.event_sink.as_ref(),
            &request.graph.run_id,
            RunEvent::BackendFailed {
                node_id: node.id.clone(),
                backend: model_profile.backend,
                model_id,
                model: model_profile.model.clone(),
                error: error.to_owned(),
            },
        )?;
    }
    Ok(())
}

fn mark_node_backend_deferred(
    node: &Node,
    deferral: &BackendCapacityDeferral,
    state: &mut RunState,
    request: &ExecutionRequest,
) -> anyhow::Result<()> {
    let usage = collect_node_usage(node, state, request)?;
    let node_state = node_state_mut(state, &node.id)?;
    node_state.status = NodeStatus::Pending;
    node_state.started_at = None;
    node_state.finished_at = None;
    node_state.timed_out = false;
    node_state.last_error = Some(deferral.message.clone());
    node_state.retry_after_epoch_ms = Some(deferral.retry_after_epoch_ms);
    node_state.usage = merge_node_usage(node_state.usage.take(), usage);
    state.refresh_usage_summary();
    request.state_store.save(state)?;
    emit_event(
        request.event_sink.as_ref(),
        &request.graph.run_id,
        RunEvent::LogLine {
            node_id: node.id.clone(),
            stream: LogStream::System,
            line: deferral.message.clone(),
        },
    )?;
    Ok(())
}

fn mark_node_timed_out(
    node: &Node,
    error: &str,
    state: &mut RunState,
    request: &ExecutionRequest,
) -> anyhow::Result<()> {
    let usage = collect_node_usage(node, state, request)?;
    let node_state = node_state_mut(state, &node.id)?;
    node_state.status = NodeStatus::TimedOut;
    node_state.finished_at = Some(now_string());
    node_state.timed_out = true;
    node_state.last_error = Some(error.to_owned());
    node_state.usage = merge_node_usage(node_state.usage.take(), usage);
    state.refresh_usage_summary();
    request.state_store.save(state)?;
    emit_event(
        request.event_sink.as_ref(),
        &request.graph.run_id,
        RunEvent::NodeTimedOut {
            node_id: node.id.clone(),
        },
    )?;
    Ok(())
}

fn completed_agentic_timeout_output(
    node: &Node,
    request: &ExecutionRequest,
) -> anyhow::Result<Option<NodeOutput>> {
    let NodeKind::Agentic {
        required_artifacts, ..
    } = &node.kind
    else {
        return Ok(None);
    };
    if required_artifacts.is_empty() {
        return Ok(None);
    }
    let artifact_dir = request.artifact_store.layout().artifact_dir(&node.id);
    if !completed_agentic_artifacts_exist(&artifact_dir, required_artifacts)? {
        return Ok(None);
    }
    emit_finding_created_if_nonempty(
        request.event_sink.as_ref(),
        &request.graph.run_id,
        &node.id,
        artifact_dir.join(FINDINGS_FILE),
    )?;
    let artifacts = collect_artifact_files(&artifact_dir)?
        .into_iter()
        .map(ArtifactRef::new)
        .collect();
    Ok(Some(NodeOutput { artifacts }))
}

fn completed_agentic_artifacts_exist(
    artifact_dir: &Path,
    required_artifacts: &[PathBuf],
) -> anyhow::Result<bool> {
    if !json_file_is_array(&artifact_dir.join(FINDINGS_FILE))? {
        return Ok(false);
    }
    for required in required_artifacts {
        validate_artifact_relative_path(required)?;
        let path = artifact_dir.join(required);
        if !regular_nonempty_file_exists(&path)? {
            return Ok(false);
        }
        if required
            .extension()
            .and_then(|extension| extension.to_str())
            == Some("json")
        {
            let value = read_json_value(&path)?;
            if !matches!(value, Value::Array(_) | Value::Object(_)) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn json_file_is_array(path: &Path) -> anyhow::Result<bool> {
    if !is_regular_file_no_symlink(path)? {
        return Ok(false);
    }
    Ok(matches!(read_json_value(path)?, Value::Array(_)))
}

fn regular_nonempty_file_exists(path: &Path) -> anyhow::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_file() && metadata.len() > 0),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn retry_node(
    node_id: &NodeId,
    graph_by_id: &BTreeMap<NodeId, Node>,
    state: &mut RunState,
    request: &ExecutionRequest,
) -> anyhow::Result<bool> {
    let node = graph_by_id
        .get(node_id)
        .ok_or_else(|| anyhow::anyhow!("campaign graph has no node `{node_id}`"))?;
    let max_retries = node.retry.max_retries;
    if state.nodes[node_id].retry_count < max_retries {
        archive_node_artifacts_for_retry(node, request)?;
        let node_state = node_state_mut(state, node_id)?;
        node_state.retry_count += 1;
        node_state.status = NodeStatus::Pending;
        node_state.finished_at = None;
        node_state.timed_out = false;
        node_state.retry_after_epoch_ms = None;
        state.refresh_usage_summary();
        request.state_store.save(state)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn archive_node_artifacts_for_retry(node: &Node, request: &ExecutionRequest) -> anyhow::Result<()> {
    let artifact_dir = request.artifact_store.layout().artifact_dir(&node.id);
    archive_artifact_dir_for_retry(&artifact_dir)
}

fn archive_artifact_dir_for_retry(artifact_dir: &Path) -> anyhow::Result<()> {
    if !artifact_dir.exists() {
        return Ok(());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(artifact_dir)? {
        let entry = entry?;
        if entry.file_name().as_os_str() == OsStr::new(BACKEND_ATTEMPTS_DIR) {
            continue;
        }
        entries.push(entry);
    }
    if entries.is_empty() {
        return Ok(());
    }

    let archive_dir = next_topology_retry_archive_dir(artifact_dir);
    fs::create_dir_all(&archive_dir)?;
    for entry in entries {
        fs::rename(entry.path(), archive_dir.join(entry.file_name()))?;
    }
    Ok(())
}

fn next_topology_retry_archive_dir(artifact_dir: &Path) -> PathBuf {
    let root = artifact_dir.join(BACKEND_ATTEMPTS_DIR);
    for index in 1.. {
        let candidate = root.join(format!("topology-retry-{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("unbounded topology retry archive index exhausted")
}

fn skip_unfinished_nodes(
    graph: &CampaignGraph,
    state: &mut RunState,
    request: &ExecutionRequest,
) -> anyhow::Result<()> {
    let mut changed = false;
    for node in &graph.nodes {
        let node_state = node_state_mut(state, &node.id)?;
        if matches!(
            node_state.status,
            NodeStatus::Pending | NodeStatus::Ready | NodeStatus::Running
        ) {
            node_state.status = NodeStatus::Skipped;
            node_state.finished_at = Some(now_string());
            changed = true;
            emit_event(
                request.event_sink.as_ref(),
                &graph.run_id,
                RunEvent::NodeSkipped {
                    node_id: node.id.clone(),
                    reason: "upstream failure".to_owned(),
                },
            )?;
        }
    }
    if changed {
        request.state_store.save(state)?;
    }
    Ok(())
}

fn ensure_state_nodes(state: &mut RunState, graph: &CampaignGraph) {
    for node in &graph.nodes {
        state
            .nodes
            .entry(node.id.clone())
            .or_insert_with(|| ultrafuzz_state::NodeState::pending(node));
    }
}

fn emit_reused_node_events(state: &RunState, request: &ExecutionRequest) -> anyhow::Result<()> {
    for node in state.nodes.values() {
        if node.status == NodeStatus::ReusedFromPriorRun {
            emit_event(
                request.event_sink.as_ref(),
                &request.graph.run_id,
                RunEvent::NodeReused {
                    node_id: node.node_id.clone(),
                },
            )?;
        }
    }
    Ok(())
}

fn all_nodes_finished(state: &RunState) -> bool {
    state
        .nodes
        .values()
        .all(|node| is_terminal_status(node.status))
}

fn is_dependency_satisfied(status: NodeStatus) -> bool {
    matches!(
        status,
        NodeStatus::Succeeded | NodeStatus::ReusedFromPriorRun
    )
}

fn is_terminal_status(status: NodeStatus) -> bool {
    matches!(
        status,
        NodeStatus::Succeeded
            | NodeStatus::Failed
            | NodeStatus::Skipped
            | NodeStatus::TimedOut
            | NodeStatus::ReusedFromPriorRun
            | NodeStatus::Invalidated
    )
}

fn is_agent_node(node: &Node) -> bool {
    matches!(
        node.kind,
        NodeKind::Agentic { .. }
            | NodeKind::AgentAttempt { .. }
            | NodeKind::PropertySpecification
            | NodeKind::PropertySpecificationLens { .. }
            | NodeKind::PropertySpecificationFanIn
    )
}

fn is_meta_node(node: &Node) -> bool {
    matches!(node.kind, NodeKind::Meta { .. })
}

fn model_profile_for_attempt<'a>(
    config: &'a CampaignConfig,
    model_id: &ModelProfileId,
) -> anyhow::Result<&'a ModelProfile> {
    config
        .model_profile(model_id)
        .ok_or_else(|| anyhow::anyhow!("agent node references unknown model profile `{model_id}`"))
}

fn default_model_profile_for_agentic(
    config: &CampaignConfig,
) -> anyhow::Result<(ModelProfileId, &ModelProfile)> {
    let model_id = config.models.default.clone();
    let profile = model_profile_for_attempt(config, &model_id)?;
    Ok((model_id, profile))
}

fn uses_default_backend_metadata(node: &Node) -> bool {
    matches!(
        node.kind,
        NodeKind::Agentic { .. }
            | NodeKind::PropertySpecification
            | NodeKind::PropertySpecificationLens { .. }
            | NodeKind::PropertySpecificationFanIn
    )
}

fn apply_default_backend_metadata(
    node_state: &mut NodeState,
    config: &CampaignConfig,
) -> anyhow::Result<()> {
    let (model_id, model_profile) = default_model_profile_for_agentic(config)?;
    node_state.backend = Some(model_profile.backend);
    node_state.model_id = Some(model_id);
    node_state.model = model_profile.model.clone();
    Ok(())
}

fn backend_for_node(node: &Node, config: &CampaignConfig) -> anyhow::Result<BackendKind> {
    if let NodeKind::AgentAttempt { model_id, .. } = &node.kind {
        return Ok(model_profile_for_attempt(config, model_id)?.backend);
    }
    Ok(default_model_profile_for_agentic(config)?.1.backend)
}

fn backend_capacity_deferral(
    node: &Node,
    error: &str,
    request: &ExecutionRequest,
) -> anyhow::Result<Option<BackendCapacityDeferral>> {
    if !is_agent_node(node) {
        return Ok(None);
    }
    let backend = backend_for_node(node, &request.resolved_config)?;
    if backend != BackendKind::CodexCli {
        return Ok(None);
    }
    let mut contents = String::from(error);
    contents.push('\n');
    contents.push_str(&read_backend_error_logs(node, request)?);
    let Some(retry_after_epoch_ms) =
        codex_usage_limit_retry_after_epoch_ms(&contents, current_epoch_ms())
    else {
        return Ok(None);
    };
    Ok(Some(BackendCapacityDeferral {
        backend,
        retry_after_epoch_ms,
        message: format!(
            "backend-capacity-deferred: {backend} usage limit; retry after epoch_ms {retry_after_epoch_ms}"
        ),
    }))
}

fn read_backend_error_logs(node: &Node, request: &ExecutionRequest) -> anyhow::Result<String> {
    let artifact_dir = request.artifact_store.layout().artifact_dir(&node.id);
    let mut contents = String::new();
    for file_name in ["stdout.log", "stderr.log"] {
        if let Some(log) =
            read_backend_error_log(&artifact_dir.join(file_name), MAX_BACKEND_ERROR_LOG_BYTES)?
        {
            contents.push_str(&log);
            contents.push('\n');
        }
    }
    Ok(contents)
}

fn codex_usage_limit_retry_after_epoch_ms(contents: &str, now_epoch_ms: u64) -> Option<u64> {
    let lower = contents.to_ascii_lowercase();
    if !(lower.contains("usage limit") && lower.contains("try again")) {
        return None;
    }
    let retry_after = extract_codex_retry_after_text(contents)
        .and_then(|text| parse_codex_retry_after_text(&text, now_epoch_ms))
        .unwrap_or_else(|| now_epoch_ms.saturating_add(DEFAULT_BACKEND_CAPACITY_BACKOFF_MS));
    Some(retry_after)
}

fn extract_codex_retry_after_text(contents: &str) -> Option<String> {
    let lower = contents.to_ascii_lowercase();
    let marker = "try again at ";
    let start = lower.find(marker)? + marker.len();
    let after_marker = contents.get(start..)?;
    let end = after_marker
        .find(['"', '\n', '\r'])
        .unwrap_or(after_marker.len());
    Some(
        after_marker[..end]
            .trim()
            .trim_end_matches('.')
            .trim()
            .to_owned(),
    )
    .filter(|value| !value.is_empty())
}

fn parse_codex_retry_after_text(text: &str, now_epoch_ms: u64) -> Option<u64> {
    let cleaned = strip_ordinal_day_suffixes(text);
    for format in ["%b %e, %Y %l:%M %p", "%B %e, %Y %l:%M %p"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(&cleaned, format) {
            let epoch_ms =
                DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc).timestamp_millis();
            return u64::try_from(epoch_ms).ok();
        }
    }
    for format in ["%l:%M %p", "%I:%M %p", "%-I:%M %p"] {
        if let Ok(time) = NaiveTime::parse_from_str(&cleaned, format) {
            return next_utc_time_epoch_ms(time, now_epoch_ms);
        }
    }
    None
}

fn next_utc_time_epoch_ms(time: NaiveTime, now_epoch_ms: u64) -> Option<u64> {
    let now_i64 = i64::try_from(now_epoch_ms).ok()?;
    let now = DateTime::<Utc>::from_timestamp_millis(now_i64)?;
    let candidate = now.date_naive().and_time(time);
    let mut candidate_epoch_ms =
        DateTime::<Utc>::from_naive_utc_and_offset(candidate, Utc).timestamp_millis();
    if candidate_epoch_ms <= now_i64 {
        candidate_epoch_ms = candidate_epoch_ms.saturating_add(86_400_000);
    }
    u64::try_from(candidate_epoch_ms).ok()
}

fn strip_ordinal_day_suffixes(text: &str) -> String {
    let mut cleaned = text.to_owned();
    for suffix in ["st", "nd", "rd", "th"] {
        cleaned = cleaned.replace(&format!("{suffix},"), ",");
        cleaned = cleaned.replace(&format!("{suffix} "), " ");
    }
    cleaned
}

fn deferred_work_sleep_duration(
    state: &RunState,
    backend_deferrals: &BackendDeferrals,
) -> Option<Duration> {
    let now_epoch_ms = current_epoch_ms();
    let state_retry_after = state
        .nodes
        .values()
        .filter_map(|node| node.retry_after_epoch_ms)
        .filter(|retry_after_epoch_ms| *retry_after_epoch_ms > now_epoch_ms)
        .min();
    let backend_retry_after = backend_deferrals.next_retry_after_epoch_ms(now_epoch_ms);
    let retry_after_epoch_ms = state_retry_after
        .into_iter()
        .chain(backend_retry_after)
        .min()?;
    let delay_ms = retry_after_epoch_ms
        .saturating_sub(now_epoch_ms)
        .clamp(1, 1_000);
    Some(Duration::from_millis(delay_ms))
}

fn configured_strategy_loop_count(config: &CampaignConfig, strategy: &StrategyId) -> usize {
    config
        .strategies
        .definitions
        .iter()
        .find(|definition| &definition.id == strategy)
        .map(|definition| definition.loops)
        .filter(|loops| *loops > 0)
        .unwrap_or(1)
}

fn insert_campaign_tunable_context(context: &mut PromptRenderContext, config: &CampaignConfig) {
    context.insert("triage_quorum", config.triage.quorum.to_string());
    context.insert("triage_panel_size", config.triage.panel_size.to_string());
    context.insert(
        "dynamic_strategies_enumerator",
        config.dynamic_strategies_enumerator.to_string(),
    );
    context.insert(
        "invariant_property_priority_threshold",
        config.invariants.property_priority_threshold.to_string(),
    );
    context.insert(
        "invariant_property_priority_filter",
        config
            .invariants
            .property_priority_threshold
            .filter_description(),
    );
    context.insert(
        "invariant_property_priorities",
        config
            .invariants
            .property_priority_threshold
            .included_priorities_csv(),
    );
    context.insert(
        "invariant_testing_fuzzer_timeout",
        ultrafuzz_config::format_invariant_testing_fuzzer_timeout(
            config.invariants.invariant_testing_fuzzer_timeout_seconds,
        ),
    );
}

fn attempt_id_for_node(node: &Node) -> AttemptId {
    AttemptId::from(node.id.to_string())
}

fn write_artifact(
    artifact_dir: &Path,
    file_name: &str,
    contents: impl AsRef<str>,
) -> anyhow::Result<PathBuf> {
    fs::create_dir_all(artifact_dir)?;
    let path = artifact_dir.join(file_name);
    fs::write(&path, contents.as_ref())?;
    Ok(path)
}

fn write_relative_artifact(
    artifact_dir: &Path,
    relative_path: &Path,
    contents: impl AsRef<str>,
) -> anyhow::Result<PathBuf> {
    validate_artifact_relative_path(relative_path)?;
    let path = artifact_dir.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, contents.as_ref())?;
    Ok(path)
}

fn write_json_relative_artifact<T: Serialize>(
    artifact_dir: &Path,
    relative_path: &Path,
    value: &T,
) -> anyhow::Result<PathBuf> {
    write_relative_artifact(
        artifact_dir,
        relative_path,
        format!("{}\n", serde_json::to_string_pretty(value)?),
    )
}

fn write_metadata(ctx: &NodeContext, artifact_dir: &Path) -> anyhow::Result<PathBuf> {
    let metadata = json!({
        "runner": "synthetic",
        "node_id": ctx.node.id,
        "kind": ctx.node.kind,
    });
    write_artifact(
        artifact_dir,
        "metadata.json",
        serde_json::to_string_pretty(&metadata)?,
    )
}

fn target_repo(config: &CampaignConfig) -> anyhow::Result<PathBuf> {
    let path = if config.project.repo.is_absolute() {
        config.project.repo.clone()
    } else {
        std::env::current_dir()?.join(&config.project.repo)
    };
    Ok(path.canonicalize().unwrap_or(path))
}

fn repo_string(path: &Path) -> String {
    path.display().to_string()
}

fn basic_logs(artifact_dir: &Path, stdout: &str) -> anyhow::Result<Vec<ArtifactRef>> {
    Ok(vec![
        ArtifactRef::new(write_artifact(artifact_dir, "stdout.log", stdout)?),
        ArtifactRef::new(write_artifact(artifact_dir, "stderr.log", "")?),
    ])
}

fn write_json_artifact<T: Serialize>(
    artifact_dir: &Path,
    file_name: &str,
    value: &T,
) -> anyhow::Result<PathBuf> {
    write_artifact(
        artifact_dir,
        file_name,
        format!("{}\n", serde_json::to_string_pretty(value)?),
    )
}

fn write_runner_metadata(
    ctx: &NodeContext,
    artifact_dir: &Path,
    runner: &str,
    extra: Value,
) -> anyhow::Result<PathBuf> {
    write_runner_metadata_file(ctx, artifact_dir, "metadata.json", runner, extra)
}

fn write_runner_metadata_file(
    ctx: &NodeContext,
    artifact_dir: &Path,
    file_name: &str,
    runner: &str,
    extra: Value,
) -> anyhow::Result<PathBuf> {
    write_json_artifact(
        artifact_dir,
        file_name,
        &json!({
            "schema_version": "1.0",
            "runner": "campaign",
            "node_runner": runner,
            "node_id": ctx.node.id,
            "kind": ctx.node.kind,
            "extra": extra,
        }),
    )
}

fn same_canonical_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn is_regular_file_no_symlink(path: &Path) -> anyhow::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_file()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn is_directory_no_symlink(path: &Path) -> anyhow::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_dir()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn ensure_copy_destination_not_symlink(path: &Path) -> anyhow::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            anyhow::bail!(
                "refusing to copy through symlink destination `{}`",
                path.display()
            )
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn sync_prepared_harness_into_workspace(repo: &Path, workspace_path: &Path) -> anyhow::Result<()> {
    if same_canonical_path(repo, workspace_path) {
        return Ok(());
    }

    let mut relative_paths = Vec::new();
    if repo.join("foundry.toml").is_file() {
        relative_paths.push(PathBuf::from("foundry.toml"));
    }
    if let Some(path) = discover_base_tests(repo)?.preferred_shared_test_path() {
        relative_paths.push(path);
    }

    relative_paths.sort();
    relative_paths.dedup();
    for relative_path in relative_paths {
        validate_artifact_relative_path(&relative_path)?;
        let source = repo.join(&relative_path);
        if !is_regular_file_no_symlink(&source)? {
            continue;
        }
        let destination = workspace_path.join(&relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        ensure_copy_destination_not_symlink(&destination)?;
        fs::copy(source, destination)?;
    }
    Ok(())
}

fn render_and_write_prompt_with_artifact_paths(
    ctx: &NodeContext,
    template_body: &str,
    context: &PromptRenderContext,
    artifact_dir: &Path,
) -> anyhow::Result<PathBuf> {
    validate_supported_template_variables(template_body)?;
    validate_runtime_prompt_artifact_references(ctx, template_body)?;
    preflight_referenced_prompt_artifacts(ctx, template_body)?;
    fs::create_dir_all(artifact_dir)?;
    let artifact_context = artifact_path_render_context(ctx, artifact_dir);
    let rendered = render_template_with_artifact_paths(template_body, context, &artifact_context)?;
    let path = artifact_dir.join(RENDERED_PROMPT_FILE);
    fs::write(&path, rendered)?;
    Ok(path)
}

fn insert_run_metadata_context(
    render_context: &mut PromptRenderContext,
    ctx: &NodeContext,
    artifact_dir: &Path,
) -> anyhow::Result<()> {
    let run_metadata_dir = write_run_metadata_bundle(ctx, artifact_dir)?;
    render_context.insert("run_metadata_path", run_metadata_dir.display().to_string());
    render_context.insert("run_metadata_dir", run_metadata_dir.display().to_string());
    Ok(())
}

fn write_run_metadata_bundle(ctx: &NodeContext, artifact_dir: &Path) -> anyhow::Result<PathBuf> {
    let metadata_dir = artifact_dir.join(RUN_METADATA_DIR);
    fs::create_dir_all(&metadata_dir)?;
    let layout = ctx.artifact_store.layout();
    for source in [
        layout.run_metadata_path(),
        layout.state_path(),
        layout.graph_path(),
        layout.resolved_config_path(),
    ] {
        copy_optional_run_metadata_file(&source, &metadata_dir)?;
    }
    Ok(metadata_dir)
}

fn copy_optional_run_metadata_file(source: &Path, metadata_dir: &Path) -> anyhow::Result<()> {
    if !is_regular_file_no_symlink(source)? {
        return Ok(());
    }
    let Some(file_name) = source.file_name() else {
        return Ok(());
    };
    fs::copy(source, metadata_dir.join(file_name))?;
    Ok(())
}

fn validate_runtime_prompt_artifact_references(
    ctx: &NodeContext,
    template_body: &str,
) -> anyhow::Result<()> {
    let references = extract_prompt_artifact_path_references(template_body)?;
    let current_logical_id = logical_node_id_for_runtime(&ctx.node);
    let ancestor_dirs = ancestor_artifact_dirs_by_logical_id(ctx);
    let ancestor_logical_ids = ancestor_dirs.keys().cloned().collect::<BTreeSet<_>>();
    let all_logical_ids = ctx
        .graph
        .nodes
        .iter()
        .map(logical_node_id_for_runtime)
        .collect::<BTreeSet<_>>();

    let handoff_paths = ancestor_primary_handoff_paths_by_logical_id(ctx);

    for reference in references {
        let is_handoff = matches!(reference.producer, PromptArtifactPathProducer::Handoff(_));
        let referenced = match &reference.producer {
            PromptArtifactPathProducer::Current => continue,
            PromptArtifactPathProducer::LogicalNode(logical_id)
            | PromptArtifactPathProducer::Handoff(logical_id) => NodeId::from(logical_id.clone()),
        };
        if !all_logical_ids.contains(&referenced) {
            anyhow::bail!(
                "prompt for node `{}` references unknown artifact producer `{}`",
                ctx.node.id,
                referenced
            );
        }
        if referenced == current_logical_id || !ancestor_logical_ids.contains(&referenced) {
            anyhow::bail!(
                "prompt for node `{}` references artifact producer `{}`, but it is not an ancestor of `{}`",
                ctx.node.id,
                referenced,
                current_logical_id
            );
        }
        if is_handoff && !handoff_paths.contains_key(&referenced) {
            anyhow::bail!(
                "prompt for node `{}` references artifact handoff for `{}`, but that ancestor has no primary_artifact",
                ctx.node.id,
                referenced
            );
        }
    }

    let ancestor_required_artifacts = ancestor_required_artifacts_by_logical_id(ctx);
    for reference in extract_prompt_ancestor_artifact_references(template_body)? {
        let producers = match reference.selector {
            PromptAncestorArtifactsSelector::DirectDependencies => {
                direct_dependency_logical_ids(ctx)
            }
            PromptAncestorArtifactsSelector::Producers(producers) => {
                producers.into_iter().map(NodeId::from).collect()
            }
        };
        if producers.is_empty() {
            anyhow::bail!(
                "prompt for node `{}` references ancestor_artifacts, but `{}` has no direct dependencies",
                ctx.node.id,
                current_logical_id
            );
        }
        for referenced in producers {
            if !all_logical_ids.contains(&referenced) {
                anyhow::bail!(
                    "prompt for node `{}` references unknown ancestor_artifacts producer `{}`",
                    ctx.node.id,
                    referenced
                );
            }
            if referenced == current_logical_id || !ancestor_logical_ids.contains(&referenced) {
                anyhow::bail!(
                    "prompt for node `{}` references ancestor_artifacts producer `{}`, but it is not an ancestor of `{}`",
                    ctx.node.id,
                    referenced,
                    current_logical_id
                );
            }
            let Some(required_artifacts) = ancestor_required_artifacts
                .get(&referenced)
                .filter(|paths| !paths.is_empty())
            else {
                anyhow::bail!(
                    "prompt for node `{}` references ancestor_artifacts producer `{}`, but that producer has no required artifacts",
                    ctx.node.id,
                    referenced
                );
            };
            for required in required_artifacts {
                validate_prompt_artifact_relative_path(required).map_err(|error| {
                    anyhow::anyhow!(
                        "prompt for node `{}` references invalid ancestor_artifacts required artifact `{}` from producer `{}`: {error}",
                        ctx.node.id,
                        required.display(),
                        referenced
                    )
                })?;
            }
        }
    }
    Ok(())
}

fn preflight_referenced_prompt_artifacts(
    ctx: &NodeContext,
    template_body: &str,
) -> anyhow::Result<()> {
    let references = extract_prompt_artifact_path_references(template_body)?;
    let ancestor_dirs = ancestor_artifact_dirs_by_logical_id(ctx);
    let handoff_paths = ancestor_primary_handoff_paths_by_logical_id(ctx);
    for reference in references {
        match reference.producer {
            PromptArtifactPathProducer::Current => {}
            PromptArtifactPathProducer::LogicalNode(logical_id) => {
                let Some(relative_path) = reference.path else {
                    continue;
                };
                let referenced = NodeId::from(logical_id);
                let Some(dirs) = ancestor_dirs.get(&referenced) else {
                    continue;
                };
                for dir in dirs {
                    preflight_referenced_prompt_artifact_path(
                        ctx,
                        &referenced,
                        &relative_path,
                        dir.join(&relative_path),
                    )?;
                }
            }
            PromptArtifactPathProducer::Handoff(logical_id) => {
                let referenced = NodeId::from(logical_id);
                let Some(paths) = handoff_paths.get(&referenced) else {
                    anyhow::bail!(
                        "node `{}` references artifact handoff for `{}`, but that ancestor has no primary_artifact",
                        ctx.node.id,
                        referenced
                    );
                };
                for path in paths {
                    let Some(relative_path) = path.file_name().map(PathBuf::from) else {
                        continue;
                    };
                    preflight_referenced_prompt_artifact_path(
                        ctx,
                        &referenced,
                        &relative_path,
                        path.clone(),
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn preflight_referenced_prompt_artifact_path(
    ctx: &NodeContext,
    referenced: &NodeId,
    relative_path: &Path,
    path: PathBuf,
) -> anyhow::Result<()> {
    if !path.exists() {
        anyhow::bail!(
            "node `{}` references missing artifact `{}` from ancestor `{}` at `{}`; ensure the producer wrote this file before this node starts",
            ctx.node.id,
            relative_path.display(),
            referenced,
            path.display()
        );
    }
    if !path.is_file() {
        anyhow::bail!(
            "node `{}` references artifact `{}` from ancestor `{}` at `{}`, but that path is not a file",
            ctx.node.id,
            relative_path.display(),
            referenced,
            path.display()
        );
    }
    Ok(())
}

fn artifact_path_render_context(
    ctx: &NodeContext,
    current_artifact_dir: &Path,
) -> ArtifactPathRenderContext {
    let mut context = ArtifactPathRenderContext::new(current_artifact_dir.to_path_buf());
    for (logical_id, dirs) in ancestor_artifact_dirs_by_logical_id(ctx) {
        context.insert_logical_node(logical_id.to_string(), dirs);
    }
    for (logical_id, paths) in ancestor_primary_handoff_paths_by_logical_id(ctx) {
        context.insert_logical_handoff(logical_id.to_string(), paths);
    }
    context.set_direct_dependencies(
        direct_dependency_logical_ids(ctx)
            .into_iter()
            .map(|id| id.to_string())
            .collect(),
    );
    for (logical_id, required_artifacts) in ancestor_required_artifacts_by_logical_id(ctx) {
        context.insert_ancestor_required_artifacts(logical_id.to_string(), required_artifacts);
    }
    context
}

fn direct_dependency_logical_ids(ctx: &NodeContext) -> Vec<NodeId> {
    let graph_by_id = ctx
        .graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let node = direct_dependency_source_node(ctx);
    direct_dependency_logical_ids_for_node(node, &graph_by_id)
}

fn direct_dependency_source_node(ctx: &NodeContext) -> &Node {
    let NodeKind::Agentic {
        logical_id,
        attempt_index,
        loop_mode: LoopMode::Series,
        ..
    } = &ctx.node.kind
    else {
        return &ctx.node;
    };
    if *attempt_index == 0 {
        return &ctx.node;
    }
    if let Some(first_attempt) = ctx.graph.nodes.iter().find(|candidate| {
        matches!(
            &candidate.kind,
            NodeKind::Agentic {
                logical_id: candidate_logical_id,
                attempt_index: 0,
                ..
            } if candidate_logical_id == logical_id
        )
    }) {
        return first_attempt;
    }
    &ctx.node
}

fn direct_dependency_logical_ids_for_node(
    node: &Node,
    graph_by_id: &BTreeMap<NodeId, &Node>,
) -> Vec<NodeId> {
    let mut direct = Vec::new();
    let mut seen = BTreeSet::new();
    for dependency in &node.depends_on {
        let Some(node) = graph_by_id.get(dependency) else {
            continue;
        };
        let logical_id = logical_node_id_for_runtime(node);
        if seen.insert(logical_id.clone()) {
            direct.push(logical_id);
        }
    }
    direct
}

fn ancestor_primary_handoff_paths_by_logical_id(
    ctx: &NodeContext,
) -> BTreeMap<NodeId, Vec<PathBuf>> {
    let graph_by_id = ctx
        .graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let mut ancestor_ids = BTreeSet::new();
    collect_concrete_ancestors(&ctx.node.id, &graph_by_id, &mut ancestor_ids);

    let mut paths = BTreeMap::<NodeId, Vec<PathBuf>>::new();
    for node in &ctx.graph.nodes {
        if !ancestor_ids.contains(&node.id) {
            continue;
        }
        let primary_artifact = match &node.kind {
            NodeKind::Agentic {
                primary_artifact: Some(primary_artifact),
                ..
            }
            | NodeKind::Reference {
                primary_artifact: Some(primary_artifact),
                ..
            } => primary_artifact,
            _ => continue,
        };
        paths
            .entry(logical_node_id_for_runtime(node))
            .or_default()
            .push(
                ctx.artifact_store
                    .layout()
                    .artifact_dir(&node.id)
                    .join(primary_artifact),
            );
    }
    paths
}

fn ancestor_artifact_dirs_by_logical_id(ctx: &NodeContext) -> BTreeMap<NodeId, Vec<PathBuf>> {
    let graph_by_id = ctx
        .graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let mut ancestor_ids = BTreeSet::new();
    collect_concrete_ancestors(&ctx.node.id, &graph_by_id, &mut ancestor_ids);

    let mut dirs = BTreeMap::<NodeId, Vec<PathBuf>>::new();
    for node in &ctx.graph.nodes {
        if ancestor_ids.contains(&node.id) {
            dirs.entry(logical_node_id_for_runtime(node))
                .or_default()
                .push(ctx.artifact_store.layout().artifact_dir(&node.id));
        }
    }
    dirs
}

fn agentic_extra_context_dirs(ctx: &NodeContext) -> Vec<PathBuf> {
    let mut dirs = agentic_dependency_context_dirs(ctx);
    if agentic_uses_run_artifact_parent_context(ctx) {
        dirs.push(ctx.artifact_store.layout().artifacts.clone());
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

fn append_agentic_workspace_runtime_guidance(rendered: &mut String, logical_id: &NodeId) {
    rendered.push_str(WORKSPACE_RUNTIME_GUIDANCE);
    if logical_id.as_str() == "aggregate-test-files" {
        rendered.push_str(AGGREGATE_WORKSPACE_DESTINATION_GUIDANCE);
    }
}

fn agentic_artifact_context_runtime_guidance(ctx: &NodeContext) -> Option<&'static str> {
    agentic_uses_run_artifact_parent_context(ctx).then_some(AGGREGATION_ARTIFACT_CONTEXT_GUIDANCE)
}

fn agentic_uses_run_artifact_parent_context(ctx: &NodeContext) -> bool {
    matches!(
        logical_node_id_for_runtime(&ctx.node).as_str(),
        "dedupe-findings"
            | "triage"
            | "severity-classification"
            | "aggregate-test-files"
            | "final-report"
    )
}

fn agentic_dependency_context_dirs(ctx: &NodeContext) -> Vec<PathBuf> {
    let graph_by_id = ctx
        .graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let mut ancestor_ids = BTreeSet::new();
    collect_concrete_ancestors(&ctx.node.id, &graph_by_id, &mut ancestor_ids);

    let mut dirs = ctx
        .graph
        .nodes
        .iter()
        .filter(|node| ancestor_ids.contains(&node.id) && !is_meta_node(node))
        .map(|node| ctx.artifact_store.layout().artifact_dir(&node.id))
        .collect::<Vec<_>>();
    dirs.sort();
    dirs.dedup();
    dirs
}

fn ancestor_required_artifacts_by_logical_id(ctx: &NodeContext) -> BTreeMap<NodeId, Vec<PathBuf>> {
    let graph_by_id = ctx
        .graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let mut ancestor_ids = BTreeSet::new();
    collect_concrete_ancestors(&ctx.node.id, &graph_by_id, &mut ancestor_ids);

    let mut artifacts = BTreeMap::<NodeId, Vec<PathBuf>>::new();
    for node in &ctx.graph.nodes {
        if ancestor_ids.contains(&node.id) {
            let required = runtime_required_artifacts(node);
            let entry = artifacts
                .entry(logical_node_id_for_runtime(node))
                .or_default();
            if entry.is_empty() && !required.is_empty() {
                *entry = required;
            }
        }
    }
    artifacts
}

fn runtime_required_artifacts(node: &Node) -> Vec<PathBuf> {
    match &node.kind {
        NodeKind::Agentic {
            required_artifacts, ..
        } => required_artifacts.clone(),
        NodeKind::Reference {
            required_artifacts, ..
        } => required_artifacts.clone(),
        NodeKind::PropertySpecificationLens { lens } => property_lens_required_artifacts(*lens),
        _ => Vec::new(),
    }
}

fn property_lens_required_artifacts(_lens: PropertyLens) -> Vec<PathBuf> {
    vec![PathBuf::from(PROPERTY_LENS_CANDIDATE_FILE)]
}

fn collect_concrete_ancestors(
    node_id: &NodeId,
    graph_by_id: &BTreeMap<NodeId, &Node>,
    ancestor_ids: &mut BTreeSet<NodeId>,
) {
    let Some(node) = graph_by_id.get(node_id) else {
        return;
    };
    for dependency in &node.depends_on {
        if ancestor_ids.insert(dependency.clone()) {
            collect_concrete_ancestors(dependency, graph_by_id, ancestor_ids);
        }
    }
}

fn logical_node_id_for_runtime(node: &Node) -> NodeId {
    match &node.kind {
        NodeKind::Meta { .. } => node.id.clone(),
        NodeKind::Agentic { logical_id, .. } => logical_id.clone(),
        NodeKind::Reference { .. } => node.id.clone(),
        NodeKind::AgentAttempt { strategy, .. } | NodeKind::ConsolidateStrategy { strategy } => {
            NodeId::from(strategy.to_string())
        }
        NodeKind::ProjectDiscovery => NodeId::from("project-discovery"),
        NodeKind::PrepareFoundryHarness => NodeId::from("prepare-foundry-harness"),
        NodeKind::DiscoverBaseTest => NodeId::from("discover-base-test"),
        NodeKind::PropertySpecificationLens { lens } => NodeId::from(lens.node_id()),
        NodeKind::PropertySpecificationFanIn => NodeId::from("property-specification-fanin"),
        NodeKind::PropertySpecification => NodeId::from("property-specification"),
        NodeKind::DedupeFindings => NodeId::from("dedupe-findings"),
        NodeKind::TriageFindings => NodeId::from("triage"),
        NodeKind::AggregateTestFiles => NodeId::from("aggregate-test-files"),
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "agentic prompt rendering exposes explicit runtime artifact paths"
)]
fn render_agentic_prompt(
    ctx: &NodeContext,
    artifact_dir: &Path,
    repo: &Path,
    workspace_path: &Path,
    logical_id: &NodeId,
    prompt_path: &Path,
    attempt_index: usize,
    loop_count: usize,
    loop_mode: LoopMode,
    output_findings_path: &Path,
    output_patch_path: &Path,
    output_metadata_path: &Path,
    required_artifacts: &[PathBuf],
) -> anyhow::Result<PathBuf> {
    let prompt_root = prompts_root(&ctx.project_root);
    let full_prompt_path = prompt_root.join(prompt_path);
    let markdown = fs::read_to_string(&full_prompt_path).map_err(|error| {
        anyhow::anyhow!(
            "failed to read prompt `{}` for node `{}`: {error}",
            prompt_path.display(),
            ctx.node.id
        )
    })?;
    let document = parse_prompt_document(&markdown)?;
    validate_supported_template_variables(&document.body)?;
    validate_runtime_prompt_artifact_references(ctx, &document.body)?;
    preflight_referenced_prompt_artifacts(ctx, &document.body)?;
    let mut render_context = PromptRenderContext::new();
    render_context.insert("repo_path", repo.display().to_string());
    render_context.insert("workspace_path", workspace_path.display().to_string());
    render_context.insert("artifact_path", artifact_dir.display().to_string());
    render_context.insert("artifact_dir", artifact_dir.display().to_string());
    render_context.insert(
        "run_artifacts_path",
        ctx.artifact_store.layout().artifacts.display().to_string(),
    );
    render_context.insert(
        "run_artifacts_dir",
        ctx.artifact_store.layout().artifacts.display().to_string(),
    );
    insert_run_metadata_context(&mut render_context, ctx, artifact_dir)?;
    render_context.insert(
        "output_findings_path",
        output_findings_path.display().to_string(),
    );
    render_context.insert("output_patch_path", output_patch_path.display().to_string());
    render_context.insert(
        "output_metadata_path",
        output_metadata_path.display().to_string(),
    );
    render_context.insert("run_id", ctx.run_id.to_string());
    render_context.insert("node_id", ctx.node.id.to_string());
    render_context.insert("strategy", logical_id.to_string());
    render_context.insert("strategy_display_name", logical_id.to_string());
    render_context.insert("strategy_source", "topology");
    render_context.insert("attempt_index", attempt_index.to_string());
    render_context.insert("strategy_loop_index", attempt_index.to_string());
    render_context.insert("strategy_loop_count", loop_count.to_string());
    insert_campaign_tunable_context(&mut render_context, &ctx.resolved_config);
    render_context.insert(
        "strategy_attempt_test_dir",
        workspace_path
            .join("test/foundry")
            .join(logical_id.as_str())
            .display()
            .to_string(),
    );
    render_context.insert(
        "aggregation_destination_dir",
        workspace_path
            .join("test/foundry")
            .join(logical_id.as_str())
            .join(format!("attempt-{attempt_index}"))
            .display()
            .to_string(),
    );
    render_context.insert(
        "backend_kind",
        ctx.resolved_config.backend.default.to_string(),
    );

    let artifact_context = artifact_path_render_context(ctx, artifact_dir);
    let rendered =
        render_template_with_artifact_paths(&document.body, &render_context, &artifact_context)?;
    let runtime_context_path = write_agentic_runtime_context(
        ctx,
        artifact_dir,
        repo,
        workspace_path,
        logical_id,
        attempt_index,
        loop_count,
        loop_mode,
        output_findings_path,
        output_patch_path,
        output_metadata_path,
        required_artifacts,
    )?;
    write_artifact(
        artifact_dir,
        RENDERED_PROMPT_FILE,
        append_agentic_runtime_context(
            rendered,
            ctx,
            artifact_dir,
            workspace_path,
            logical_id,
            attempt_index,
            loop_count,
            loop_mode,
            output_findings_path,
            output_patch_path,
            output_metadata_path,
            required_artifacts,
            &runtime_context_path,
        )?,
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "runtime context artifact mirrors agentic prompt path contracts"
)]
fn write_agentic_runtime_context(
    ctx: &NodeContext,
    artifact_dir: &Path,
    _repo: &Path,
    workspace_path: &Path,
    logical_id: &NodeId,
    attempt_index: usize,
    loop_count: usize,
    loop_mode: LoopMode,
    output_findings_path: &Path,
    output_patch_path: &Path,
    output_metadata_path: &Path,
    required_artifacts: &[PathBuf],
) -> anyhow::Result<PathBuf> {
    let effective_timeout = ctx
        .node
        .timeout
        .unwrap_or_else(|| Duration::from_secs(ctx.resolved_config.run.default_timeout_seconds));
    let reserve_seconds = finalization_reserve_seconds(effective_timeout);
    let (_, default_model_profile) = default_model_profile_for_agentic(&ctx.resolved_config)?;
    let strategy_attempt_test_dir = workspace_path
        .join("test/foundry")
        .join(logical_id.as_str());
    let aggregation_destination_dir = workspace_path
        .join("test/foundry")
        .join(logical_id.as_str())
        .join(format!("attempt-{attempt_index}"));
    let value = json!({
        "schema_version": "ultrafuzz.agent-runtime-context.v1",
        "run_id": ctx.run_id.to_string(),
        "node_id": ctx.node.id.to_string(),
        "logical_node_id": logical_id.to_string(),
        "attempt_index": attempt_index,
        "strategy_loop_index": attempt_index,
        "strategy_loop_count": loop_count,
        "loop_mode": loop_mode.as_str(),
        "workspace": {
            "path": workspace_path.display().to_string(),
            "strategy_attempt_test_dir": strategy_attempt_test_dir.display().to_string(),
        },
        "artifacts": {
            "current_dir": artifact_dir.display().to_string(),
            "run_artifacts_dir": ctx.artifact_store.layout().artifacts.display().to_string(),
            "run_metadata_dir": artifact_dir.join(RUN_METADATA_DIR).display().to_string(),
        },
        "outputs": {
            "findings_json": output_findings_path.display().to_string(),
            "patch_file": output_patch_path.display().to_string(),
            "metadata": output_metadata_path.display().to_string(),
        },
        "required_artifacts": required_artifacts_json(artifact_dir, required_artifacts),
        "dependency_artifacts": dependency_artifacts_json(ctx),
        "topology": {
            "timeout_seconds": effective_timeout.as_secs(),
            "finalization_reserve_seconds": reserve_seconds,
        },
        "backend": {
            "kind": default_model_profile.backend.to_string(),
            "network_policy": ctx.resolved_config.permissions.network.clone(),
        },
        "materialization": {
            "aggregation_destination_dir": aggregation_destination_dir.display().to_string(),
        }
    });
    fs::create_dir_all(artifact_dir)?;
    let path = artifact_dir.join(RUNTIME_CONTEXT_FILE);
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(&value)?),
    )?;
    Ok(path)
}

#[expect(
    clippy::too_many_arguments,
    reason = "rendered runtime context deliberately mirrors backend handoff paths"
)]
fn append_agentic_runtime_context(
    mut rendered: String,
    ctx: &NodeContext,
    artifact_dir: &Path,
    workspace_path: &Path,
    logical_id: &NodeId,
    attempt_index: usize,
    loop_count: usize,
    loop_mode: LoopMode,
    output_findings_path: &Path,
    output_patch_path: &Path,
    output_metadata_path: &Path,
    required_artifacts: &[PathBuf],
    runtime_context_path: &Path,
) -> anyhow::Result<String> {
    let dependency_artifacts = serde_json::to_string_pretty(&dependency_artifacts_json(ctx))?;
    let required_artifacts_json =
        serde_json::to_string_pretty(&required_artifacts_json(artifact_dir, required_artifacts))?;
    let strategy_attempt_test_dir = workspace_path
        .join("test/foundry")
        .join(logical_id.as_str());
    let rendered_mentions_generated_test_dir =
        rendered.contains(&strategy_attempt_test_dir.display().to_string());
    let effective_timeout = ctx
        .node
        .timeout
        .unwrap_or_else(|| Duration::from_secs(ctx.resolved_config.run.default_timeout_seconds));
    let reserve_seconds = finalization_reserve_seconds(effective_timeout);
    let (_, default_model_profile) = default_model_profile_for_agentic(&ctx.resolved_config)?;
    let published_artifact_dir = ctx.artifact_store.layout().artifact_dir(&ctx.node.id);
    let published_workspace_dir = ctx.artifact_store.layout().workspace_dir(&ctx.node.id);
    let published_findings_path = published_artifact_dir.join(FINDINGS_FILE);
    let published_patch_path = published_artifact_dir.join(PATCH_FILE);
    let published_metadata_path = published_artifact_dir.join("metadata.json");
    rendered.push_str("\n\n# Topology Runtime Context\n\n");
    rendered.push_str(&format!(
        "- Run: {}\n- Node: {}\n- Logical node: {}\n- Attempt index: {}\n- Strategy loop index: {}\n- Strategy loop count: {}\n- Loop mode: {}\n- Repository: {}\n- Workspace: {}\n- Artifact path: {}\n- Published workspace: {}\n- Published artifact path: {}\n- Published findings path: {}\n- Published patch path: {}\n- Published metadata path: {}\n- Structured context: {}\n- Backend: {}\n- Timeout: {} seconds\n- Finalization reserve: stop optional exploration or verification with at least {} seconds left to write or refresh required artifacts and findings before timeout.\n\n",
        ctx.run_id,
        ctx.node.id,
        logical_id,
        attempt_index,
        attempt_index,
        loop_count,
        loop_mode.as_str(),
        ctx.project_root.display(),
        workspace_path.display(),
        artifact_dir.display(),
        published_workspace_dir.display(),
        published_artifact_dir.display(),
        published_findings_path.display(),
        published_patch_path.display(),
        published_metadata_path.display(),
        runtime_context_path.display(),
        default_model_profile.backend,
        effective_timeout.as_secs(),
        reserve_seconds
    ));
    append_agentic_workspace_runtime_guidance(&mut rendered, logical_id);
    if let Some(guidance) = agentic_artifact_context_runtime_guidance(ctx) {
        rendered.push_str(guidance);
    }
    rendered.push_str(BASH_TOOL_GUIDANCE);
    rendered.push_str(FILE_WRITE_TOOL_GUIDANCE);
    let network_policy = ctx.resolved_config.permissions.network.trim();
    rendered.push_str(&format!("- Network policy: {network_policy}\n"));
    if network_policy.eq_ignore_ascii_case("disabled") {
        rendered.push_str(
            "- Network restriction: use only repository files and provided artifacts. Do not use native web_search, live browsing, external websites, package downloads, or network commands. If external context would help, record that it was unavailable instead of browsing.\n",
        );
    }
    rendered.push('\n');
    if rendered_mentions_generated_test_dir {
        let relative_strategy_test_dir = Path::new("test")
            .join("foundry")
            .join(logical_id.as_str())
            .display()
            .to_string();
        rendered.push_str("# Generated Test Verification\n\n");
        rendered.push_str(
            "If you write generated Foundry tests under the strategy test directory, compile them with the guarded `FOUNDRY_BIN` template below. If the project configuration still reports zero tests because its configured test root excludes Ultrafuzz's `test/foundry` tree, do not treat a skipped run as passing; record the root mismatch in your artifact. Prefer Forge flags over inline environment assignments when flags can express the same setting.\n\n",
        );
        rendered.push_str(
            "Resolve the Foundry binary before running verification: use `forge` from `PATH` when available, or substitute the absolute Foundry binary path recorded by setup artifacts such as `setup-foundry` or `base-test-setup`. Do not treat `forge: command not found` as verification; rerun the focused command with the resolved binary.\n\n",
        );
        rendered.push_str(
            "Use the template below only for Ultrafuzz generated tests under this strategy directory. For project-native tests or reproducer commands outside this generated tree, preserve their existing environment variables, flags, match selectors, and test-root semantics while substituting the resolved binary.\n\n",
        );
        rendered.push_str("Focused command template:\n\n");
        rendered.push_str("```bash\n");
        rendered.push_str("FOUNDRY_BIN=\"${FOUNDRY_BIN:-$(command -v forge || true)}\"\n");
        rendered.push_str("test -n \"$FOUNDRY_BIN\" || { echo \"Set FOUNDRY_BIN to the absolute forge binary path recorded by setup artifacts\" >&2; exit 1; }\n");
        rendered.push_str(&format!(
            "FOUNDRY_TEST=test \"$FOUNDRY_BIN\" test --match-path '{}/*.sol'\n",
            relative_strategy_test_dir
        ));
        rendered.push_str("```\n\n");
    }
    if logical_id.as_str() == "final-report" {
        let run_summary = serde_json::to_string_pretty(&run_summary_context_json(ctx))?;
        rendered.push_str("# Run Summary Context\n\n");
        rendered.push_str(
            "Use this computed run summary snapshot for Run summary fields when the corresponding values are non-null. In particular, use `elapsed_time` directly instead of inferring duration from raw timestamps.\n\n",
        );
        rendered.push_str("```json\n");
        rendered.push_str(&run_summary);
        rendered.push_str("\n```\n\n");

        let run_accounting = serde_json::to_string_pretty(&run_accounting_context_json(ctx))?;
        rendered.push_str("# Run Accounting\n\n");
        rendered.push_str(
            "Use this persisted accounting snapshot for Run summary `Tokens used` and `Estimated spend`. If `available` is false, write `unavailable` for those fields instead of guessing.\n\n",
        );
        rendered.push_str("```json\n");
        rendered.push_str(&run_accounting);
        rendered.push_str("\n```\n\n");

        let run_health = serde_json::to_string_pretty(&run_health_context_json(ctx))?;
        rendered.push_str("# Run Health And Lineage\n\n");
        rendered.push_str(
            "Use this persisted health and lineage snapshot to explain restarted campaigns. Read `reporting_guidance` before rendering status or restart details. Include source runs, reused work, newly executed work, cumulative elapsed time, final restart elapsed time, tokens, estimated spend, and restart guidance when `reporting_guidance.restart_guidance_for_report` is non-null. When that value is null, omit restart guidance and do not describe the campaign as stale based on the final-report node's own in-flight status.\n\n",
        );
        rendered.push_str("```json\n");
        rendered.push_str(&run_health);
        rendered.push_str("\n```\n\n");

        let lifecycle_ledger_path = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("severity-classification"))
            .join(FINDING_LIFECYCLE_LEDGER_FILE);
        rendered.push_str("# Finding Lifecycle Ledger\n\n");
        rendered.push_str(
            "Use this exact ledger file as the source of truth for source artifacts, strategy hits, lifecycle stages, triage reason, demotion reason, final disposition, canonical severity, and prior-run comparison disposition. Do not promote a production issue or non-production outcome when its matching ledger record is missing required lifecycle metadata. Include a `lifecycle` object copied from the matching ledger record in each `report.json` production issue and non-production outcome.\n\n",
        );
        rendered.push_str("```text\n");
        rendered.push_str(&lifecycle_ledger_path.display().to_string());
        rendered.push_str("\n```\n\n");
    }
    rendered.push_str("# Dependency Artifacts\n\n");
    rendered.push_str("```json\n");
    rendered.push_str(&dependency_artifacts);
    rendered.push_str("\n```\n\n");
    rendered.push_str("# Required Artifacts\n\n");
    if required_artifacts.is_empty() {
        rendered.push_str("No topology-required artifact files are configured for this node.\n\n");
    } else {
        rendered
            .push_str("Write each required artifact to the exact path below before finishing:\n\n");
        rendered.push_str(&required_artifacts_text(artifact_dir, required_artifacts));
        rendered.push_str("\n\n```json\n");
        rendered.push_str(&required_artifacts_json);
        rendered.push_str("\n```\n\n");
    }
    rendered.push_str("# Standard Outputs\n\n");
    rendered.push_str(
        "Write the findings JSON before finishing. It must be a JSON array; write `[]` if there are no findings. Write a patch file only when producing a real unified diff; if no patch is produced, leave the patch file absent and do not create placeholders. Backend metadata is written by Ultrafuzz.\n\n",
    );
    rendered.push_str(&format!(
        "- Required findings JSON: {}\n- Patch file (only for a real unified diff): {}\n- Backend metadata: {}\n",
        output_findings_path.display(),
        output_patch_path.display(),
        output_metadata_path.display()
    ));
    Ok(rendered)
}

fn finalization_reserve_seconds(timeout: Duration) -> u64 {
    let seconds = timeout.as_secs();
    if seconds >= 3_600 {
        600
    } else if seconds >= 1_800 {
        300
    } else if seconds == 0 {
        0
    } else {
        (seconds / 10).max(1)
    }
}

fn run_summary_context_json(ctx: &NodeContext) -> Value {
    let generated_at = now_string();
    match ctx.run_state.load() {
        Ok(state) => {
            let mut node_status_counts = BTreeMap::<String, usize>::new();
            let mut reused_nodes = Vec::new();
            for node in state.nodes.values() {
                *node_status_counts
                    .entry(node_status_label(node.status).to_owned())
                    .or_default() += 1;
                if node.status == NodeStatus::ReusedFromPriorRun {
                    reused_nodes.push(node.node_id.to_string());
                }
            }
            reused_nodes.sort();
            let reused_node_count = reused_nodes.len();
            let elapsed_seconds = elapsed_seconds(&state).or_else(|| {
                state
                    .started_at
                    .as_deref()
                    .and_then(state_timestamp_seconds)
                    .map(|started| (current_unix_seconds() - started).max(0.0))
            });
            json!({
                "available": true,
                "source": "state.json#/started_at,finished_at,source_run_id,nodes",
                "run_id": state.run_id.to_string(),
                "source_run_id": state.source_run_id.as_ref().map(ToString::to_string),
                "status": state.status,
                "node_status_counts": node_status_counts,
                "reused_nodes": reused_nodes,
                "reused_node_count": reused_node_count,
                "started_at": state.started_at,
                "finished_at": state.finished_at,
                "generated_at": generated_at,
                "elapsed_seconds": elapsed_seconds,
                "elapsed_time": elapsed_seconds.map(format_elapsed_time),
            })
        }
        Err(error) => json!({
            "available": false,
            "run_id": ctx.run_id.to_string(),
            "generated_at": generated_at,
            "elapsed_seconds": null,
            "elapsed_time": null,
            "error": error.to_string(),
        }),
    }
}

fn node_status_label(status: NodeStatus) -> &'static str {
    match status {
        NodeStatus::Pending => "pending",
        NodeStatus::Ready => "ready",
        NodeStatus::Running => "running",
        NodeStatus::Succeeded => "succeeded",
        NodeStatus::Failed => "failed",
        NodeStatus::Skipped => "skipped",
        NodeStatus::TimedOut => "timed-out",
        NodeStatus::ReusedFromPriorRun => "reused-from-prior-run",
        NodeStatus::Invalidated => "invalidated",
    }
}

fn run_accounting_context_json(ctx: &NodeContext) -> Value {
    match ctx.run_state.load().ok().and_then(|state| state.usage) {
        Some(usage) => json!({
            "available": true,
            "source": "state.json#/usage",
            "tokens_used": usage.tokens_used,
            "estimated_spend": usage.estimated_spend,
            "cost_status": usage.cost_status,
            "pricing_as_of": usage.pricing_as_of,
            "totals": usage.tokens,
            "models": usage.models,
            "unresolved_pricing": usage.unresolved_pricing,
        }),
        None => json!({
            "available": false,
            "source": "state.json#/usage",
            "tokens_used": null,
            "estimated_spend": null,
            "note": "No persisted usage accounting is available for this run yet.",
        }),
    }
}

fn run_health_context_json(ctx: &NodeContext) -> Value {
    let layout = ctx.artifact_store.layout();
    let runs_dir = layout.root.parent().unwrap_or(&layout.root);
    match ctx.run_state.load() {
        Ok(state) => {
            let reporting_guidance = final_report_health_reporting_guidance(ctx, &state);
            json!({
                "available": true,
                "source": "state.json, graph.json, run artifacts",
                "summary": summarize_run_health(&layout.root, runs_dir, &ctx.graph, &state),
                "reporting_guidance": reporting_guidance,
            })
        }
        Err(error) => json!({
            "available": false,
            "source": "state.json, graph.json, run artifacts",
            "run_id": ctx.run_id.to_string(),
            "error": error.to_string(),
        }),
    }
}

fn final_report_health_reporting_guidance(ctx: &NodeContext, state: &RunState) -> Value {
    let final_report_in_progress = ctx.node.id.as_str() == "final-report"
        && state.status == RunStatus::Running
        && state
            .nodes
            .get(&ctx.node.id)
            .is_some_and(|node| matches!(node.status, NodeStatus::Ready | NodeStatus::Running));

    if final_report_in_progress {
        json!({
            "snapshot_phase": "final-report-in-progress",
            "current_node": ctx.node.id.to_string(),
            "restart_guidance_for_report": null,
            "instructions": [
                "This health snapshot is captured before the final-report node writes its own required outputs and before __finish__ can run.",
                "Do not state that the completed campaign is stale or needs restart solely because final-report is the active node, its stdout/stderr logs are missing, its required report artifacts are missing, or __finish__ is pending in this snapshot.",
                "For newly executed work, describe upstream completed nodes plus this final report generation; do not render `final-report running` as the final campaign state."
            ],
        })
    } else {
        json!({
            "snapshot_phase": "normal",
            "current_node": ctx.node.id.to_string(),
            "restart_guidance_for_report": "Use summary.restart.guidance when it describes the final run state."
        })
    }
}

fn elapsed_seconds(state: &RunState) -> Option<f64> {
    let started = state
        .started_at
        .as_deref()
        .and_then(state_timestamp_seconds)?;
    let finished = state
        .finished_at
        .as_deref()
        .and_then(state_timestamp_seconds)
        .unwrap_or_else(current_unix_seconds);
    Some((finished - started).max(0.0))
}

fn state_timestamp_seconds(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if let Ok(seconds) = trimmed.trim_end_matches('Z').parse::<f64>() {
        return Some(seconds);
    }
    DateTime::parse_from_rfc3339(trimmed).ok().map(|timestamp| {
        timestamp.timestamp() as f64
            + f64::from(timestamp.timestamp_subsec_nanos()) / 1_000_000_000.0
    })
}

fn current_unix_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

fn format_elapsed_time(seconds: f64) -> String {
    let total_minutes = (seconds / 60.0).round().max(0.0) as u64;
    if total_minutes == 0 {
        return "<1m".to_owned();
    }
    let hours = total_minutes / 60;
    let minutes = total_minutes % 60;
    match (hours, minutes) {
        (0, minutes) => format!("{minutes}m"),
        (hours, 0) => format!("{hours}h"),
        (hours, minutes) => format!("{hours}h {minutes}m"),
    }
}

fn required_artifacts_json(artifact_dir: &Path, required_artifacts: &[PathBuf]) -> Value {
    Value::Array(
        required_artifacts
            .iter()
            .map(|relative| {
                json!({
                    "relative_path": relative,
                    "path": artifact_dir.join(relative),
                })
            })
            .collect(),
    )
}

fn required_artifacts_text(artifact_dir: &Path, required_artifacts: &[PathBuf]) -> String {
    if required_artifacts.is_empty() {
        return "none".to_owned();
    }
    required_artifacts
        .iter()
        .map(|relative| {
            format!(
                "- {} (relative: {})",
                artifact_dir.join(relative).display(),
                relative.display()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn mirror_agentic_compatibility_artifacts(
    ctx: &NodeContext,
    artifact_dir: &Path,
    logical_id: &NodeId,
    required_artifacts: &[PathBuf],
    output_findings_path: &Path,
) -> anyhow::Result<Vec<PathBuf>> {
    if logical_id.as_str() != "property-specification-fanin"
        || !required_artifacts
            .iter()
            .any(|path| path.as_path() == Path::new(PROPERTY_SPECIFICATION_FILE))
    {
        return Ok(Vec::new());
    }

    let compatibility_dir =
        attempt_artifact_sibling_dir(ctx, &NodeId::from(PROPERTY_SPECIFICATION_COMPAT_DIR));
    fs::create_dir_all(&compatibility_dir)?;
    let mut artifacts = Vec::new();

    let catalog_destination = compatibility_dir.join(PROPERTY_SPECIFICATION_FILE);
    fs::copy(
        artifact_dir.join(PROPERTY_SPECIFICATION_FILE),
        &catalog_destination,
    )?;
    artifacts.push(catalog_destination);

    if output_findings_path.exists() {
        let findings_destination = compatibility_dir.join(FINDINGS_FILE);
        fs::copy(output_findings_path, &findings_destination)?;
        artifacts.push(findings_destination);
    }

    Ok(artifacts)
}

fn prepare_required_artifact_parent_dirs(
    artifact_dir: &Path,
    required_artifacts: &[PathBuf],
) -> anyhow::Result<()> {
    for required in required_artifacts {
        validate_artifact_relative_path(required)?;
        if let Some(parent) = required
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(artifact_dir.join(parent))?;
        }
    }
    Ok(())
}

fn attempt_artifact_sibling_dir(ctx: &NodeContext, node_id: &NodeId) -> PathBuf {
    ctx.artifact_dir
        .parent()
        .map(|parent| parent.join(node_id.as_str()))
        .unwrap_or_else(|| ctx.artifact_store.layout().artifact_dir(node_id))
}

fn dependency_artifacts_json(ctx: &NodeContext) -> Value {
    let nodes = ctx
        .graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let mut dependencies = BTreeMap::<String, Value>::new();
    for dependency in &ctx.node.depends_on {
        let Some(node) = nodes.get(dependency) else {
            continue;
        };
        if is_meta_node(node) {
            continue;
        }
        let logical_id = match &node.kind {
            NodeKind::Agentic { logical_id, .. } => logical_id.to_string(),
            _ => node.id.to_string(),
        };
        let artifact_dir = ctx.artifact_store.layout().artifact_dir(&node.id);
        let required_artifacts = runtime_required_artifacts(node)
            .into_iter()
            .map(|relative_path| {
                json!({
                    "path": artifact_dir.join(&relative_path).display().to_string(),
                    "relative_path": relative_path.display().to_string(),
                })
            })
            .collect::<Vec<_>>();
        let entry = dependencies.entry(logical_id).or_insert_with(|| {
            json!({
                "artifact_dirs": [],
                "concrete_node_ids": [],
                "required_artifacts": [],
                "standard_outputs": [],
            })
        });
        if let Some(artifact_dirs) = entry.get_mut("artifact_dirs").and_then(Value::as_array_mut) {
            artifact_dirs.push(Value::String(artifact_dir.display().to_string()));
        }
        if let Some(concrete_node_ids) = entry
            .get_mut("concrete_node_ids")
            .and_then(Value::as_array_mut)
        {
            concrete_node_ids.push(Value::String(node.id.to_string()));
        }
        if let Some(paths) = entry
            .get_mut("required_artifacts")
            .and_then(Value::as_array_mut)
        {
            paths.extend(required_artifacts);
        }
        if let Some(outputs) = entry
            .get_mut("standard_outputs")
            .and_then(Value::as_array_mut)
        {
            let patch_path = artifact_dir.join(PATCH_FILE);
            let mut output = json!({
                "node_id": node.id.to_string(),
                "findings_json": artifact_dir.join(FINDINGS_FILE).display().to_string(),
                "metadata": artifact_dir.join("metadata.json").display().to_string(),
            });
            if is_regular_file_no_symlink(&patch_path).unwrap_or(false) {
                output["patch_file"] = Value::String(patch_path.display().to_string());
            }
            outputs.push(output);
        }
    }
    Value::Object(dependencies.into_iter().collect())
}

fn collect_artifact_files(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_artifact_files_inner(root, root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_artifact_files_inner(
    root: &Path,
    dir: &Path,
    files: &mut Vec<PathBuf>,
) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if is_backend_internal_artifact_dir(&path) {
                continue;
            }
            collect_artifact_files_inner(root, &path, files)?;
        } else if file_type.is_file() {
            let _ = path.strip_prefix(root)?;
            files.push(path);
        }
    }
    Ok(())
}

fn render_strategy_prompt(
    ctx: &NodeContext,
    artifact_dir: &Path,
    prompt_id: &ultrafuzz_core::PromptId,
    workspace_path: &Path,
    output_findings_path: &Path,
    output_patch_path: &Path,
    output_metadata_path: &Path,
) -> anyhow::Result<PathBuf> {
    let template = ctx
        .prompt_registry
        .get(prompt_id)
        .ok_or_else(|| anyhow::anyhow!("missing prompt template `{prompt_id}`"))?;
    let (strategy, attempt_index, strategy_loop_index, strategy_loop_count, backend_kind) =
        match &ctx.node.kind {
            NodeKind::AgentAttempt {
                strategy,
                attempt_index,
                model_id,
                loop_index,
                ..
            } => {
                let backend_kind = ctx
                    .resolved_config
                    .model_profile(model_id)
                    .map(|profile| profile.backend)
                    .unwrap_or(ctx.resolved_config.backend.default);
                (
                    strategy.clone(),
                    *attempt_index,
                    *loop_index,
                    configured_strategy_loop_count(&ctx.resolved_config, strategy),
                    backend_kind,
                )
            }
            _ => (
                template.strategy_id.clone(),
                0,
                0,
                1,
                ctx.resolved_config.backend.default,
            ),
        };
    let strategy_source = match &template.source {
        PromptSource::BuiltIn => "built-in".to_owned(),
        PromptSource::Project(path) => format!("project:{}", path.display()),
    };
    let mut render_context = PromptRenderContext::new();
    render_context.insert(
        "repo_path",
        ctx.resolved_config.project.repo.display().to_string(),
    );
    render_context.insert("workspace_path", workspace_path.display().to_string());
    render_context.insert("artifact_path", artifact_dir.display().to_string());
    render_context.insert("artifact_dir", artifact_dir.display().to_string());
    render_context.insert(
        "run_artifacts_path",
        ctx.artifact_store.layout().artifacts.display().to_string(),
    );
    render_context.insert(
        "run_artifacts_dir",
        ctx.artifact_store.layout().artifacts.display().to_string(),
    );
    insert_run_metadata_context(&mut render_context, ctx, artifact_dir)?;
    render_context.insert(
        "output_findings_path",
        output_findings_path.display().to_string(),
    );
    render_context.insert("output_patch_path", output_patch_path.display().to_string());
    render_context.insert(
        "output_metadata_path",
        output_metadata_path.display().to_string(),
    );
    render_context.insert("run_id", ctx.run_id.to_string());
    render_context.insert("node_id", ctx.node.id.to_string());
    render_context.insert("strategy", strategy.to_string());
    render_context.insert("strategy_display_name", template.display_name.clone());
    render_context.insert("strategy_source", strategy_source);
    render_context.insert("attempt_index", attempt_index.to_string());
    render_context.insert("strategy_loop_index", strategy_loop_index.to_string());
    render_context.insert("strategy_loop_count", strategy_loop_count.to_string());
    insert_campaign_tunable_context(&mut render_context, &ctx.resolved_config);
    render_context.insert(
        "strategy_attempt_test_dir",
        workspace_path
            .join("test/foundry")
            .join(strategy.as_str())
            .display()
            .to_string(),
    );
    render_context.insert(
        "aggregation_destination_dir",
        workspace_path
            .join("test/foundry")
            .join(strategy.as_str())
            .join(format!("attempt-{attempt_index}"))
            .display()
            .to_string(),
    );
    render_context.insert("backend_kind", backend_kind.to_string());
    render_and_write_prompt_with_artifact_paths(ctx, &template.body, &render_context, artifact_dir)
}

#[derive(Clone, Debug, Serialize)]
struct PropertyLensInput {
    lens_id: String,
    node_id: String,
    status: String,
    path: Option<PathBuf>,
    candidate_count: usize,
    error: Option<String>,
    artifact: Option<Value>,
}

#[expect(
    clippy::too_many_arguments,
    reason = "property lens prompt rendering keeps artifact paths explicit for backend handoff"
)]
fn render_property_lens_prompt(
    ctx: &NodeContext,
    artifact_dir: &Path,
    lens: PropertyLens,
    repo: &Path,
    workspace_path: &Path,
    candidate_path: &Path,
    output_findings_path: &Path,
    output_patch_path: &Path,
    output_metadata_path: &Path,
    documentation_sources: &[PathBuf],
) -> anyhow::Result<PathBuf> {
    let prompt = load_node_prompt(repo, lens.prompt_file_name())?;
    let documentation_sources = render_documentation_sources(documentation_sources);
    let rendered = format!(
        "{prompt}\n\n# Runtime Context\n\n- Run: {run_id}\n- Node: {node_id}\n- Workspace: {workspace}\n- Artifact path: {artifact_dir}\n- Backend: {backend}\n\n{workspace_guidance}{bash_guidance}{artifact_write_guidance}# Discovered Target Documentation Sources\n\n{documentation_sources}\n# Required Outputs\n\nWrite this lens candidate artifact to:\n\n{candidate_path}\n\nUse the hardcoded JSON shape, `lens_id`, and `source_lens_id` from the lens prompt above.\n\nWrite structured findings to:\n\n{findings_path}\n\nThe findings file must be a JSON array. Use an empty array unless this lens finds a concrete issue in the property specification work itself.\n\nThe patch path is reserved at:\n\n{patch_path}\n\nBackend metadata will be recorded at:\n\n{metadata_path}\n\nDo not edit production contracts.\n",
        run_id = ctx.run_id,
        node_id = ctx.node.id,
        workspace = workspace_path.display(),
        artifact_dir = artifact_dir.display(),
        backend = ctx.resolved_config.backend.default,
        workspace_guidance = WORKSPACE_RUNTIME_GUIDANCE,
        bash_guidance = BASH_TOOL_GUIDANCE,
        artifact_write_guidance = FILE_WRITE_TOOL_GUIDANCE,
        candidate_path = candidate_path.display(),
        findings_path = output_findings_path.display(),
        patch_path = output_patch_path.display(),
        metadata_path = output_metadata_path.display(),
    );
    write_artifact(artifact_dir, RENDERED_PROMPT_FILE, rendered)
}

#[expect(
    clippy::too_many_arguments,
    reason = "property fan-in prompt rendering keeps artifact paths explicit for backend handoff"
)]
fn render_property_fanin_prompt(
    ctx: &NodeContext,
    artifact_dir: &Path,
    repo: &Path,
    workspace_path: &Path,
    catalog_path: &Path,
    output_findings_path: &Path,
    output_patch_path: &Path,
    output_metadata_path: &Path,
    lens_inputs_path: &Path,
    lens_inputs: &[PropertyLensInput],
) -> anyhow::Result<PathBuf> {
    let prompt = load_node_prompt(repo, "property-specification-fanin.md")?;
    let document = parse_prompt_document(&prompt)?;
    validate_supported_template_variables(&document.body)?;
    validate_runtime_prompt_artifact_references(ctx, &document.body)?;
    preflight_referenced_prompt_artifacts(ctx, &document.body)?;
    let logical_id = logical_node_id_for_runtime(&ctx.node);
    let mut render_context = PromptRenderContext::new();
    render_context.insert("repo_path", repo.display().to_string());
    render_context.insert("workspace_path", workspace_path.display().to_string());
    render_context.insert("artifact_path", artifact_dir.display().to_string());
    render_context.insert("artifact_dir", artifact_dir.display().to_string());
    render_context.insert(
        "run_artifacts_path",
        ctx.artifact_store.layout().artifacts.display().to_string(),
    );
    render_context.insert(
        "run_artifacts_dir",
        ctx.artifact_store.layout().artifacts.display().to_string(),
    );
    insert_run_metadata_context(&mut render_context, ctx, artifact_dir)?;
    render_context.insert(
        "output_findings_path",
        output_findings_path.display().to_string(),
    );
    render_context.insert("output_patch_path", output_patch_path.display().to_string());
    render_context.insert(
        "output_metadata_path",
        output_metadata_path.display().to_string(),
    );
    render_context.insert("run_id", ctx.run_id.to_string());
    render_context.insert("node_id", ctx.node.id.to_string());
    render_context.insert("strategy", logical_id.to_string());
    render_context.insert("strategy_display_name", logical_id.to_string());
    render_context.insert("strategy_source", "topology");
    render_context.insert("attempt_index", "0");
    insert_campaign_tunable_context(&mut render_context, &ctx.resolved_config);
    render_context.insert(
        "strategy_attempt_test_dir",
        workspace_path
            .join("test/foundry")
            .join(logical_id.as_str())
            .display()
            .to_string(),
    );
    render_context.insert(
        "aggregation_destination_dir",
        workspace_path
            .join("test/foundry")
            .join(logical_id.as_str())
            .join("attempt-0")
            .display()
            .to_string(),
    );
    render_context.insert(
        "backend_kind",
        ctx.resolved_config.backend.default.to_string(),
    );
    let artifact_context = artifact_path_render_context(ctx, artifact_dir);
    let prompt =
        render_template_with_artifact_paths(&document.body, &render_context, &artifact_context)?;
    let lens_inputs_json = serde_json::to_string_pretty(lens_inputs)?;
    let rendered = format!(
        "{prompt}\n\n# Runtime Context\n\n- Run: {run_id}\n- Node: {node_id}\n- Workspace: {workspace}\n- Artifact path: {artifact_dir}\n- Backend: {backend}\n\n{workspace_guidance}{bash_guidance}{artifact_write_guidance}# Lens Inputs\n\nThe normalized lens input manifest is written at:\n\n{lens_inputs_path}\n\nThe same manifest is embedded here for convenience:\n\n```json\n{lens_inputs_json}\n```\n\n# Required Consolidated Catalog\n\nWrite the consolidated property catalog to the compatibility handoff path:\n\n{catalog_path}\n\nThis fan-in node is the only current workflow node that may write `{catalog_file}`. The file must be JSON with `candidate_properties` entries that use `priority` exactly `high`, `medium`, or `low`, merge `source_lenses` and `source_evidence`, and preserve workflow, oracle, setup, preconditions, confidence, and false-positive/setup-bias risks.\n\nAlso include top-level `lens_inputs`, `deferred_or_rejected_properties`, and `findings`; use an empty `findings` array unless this property-specification work found a concrete issue.\n\nWrite structured findings to:\n\n{findings_path}\n\nThe findings file must be a JSON array. Use an empty array unless this fan-in work finds a concrete issue in the property specification workflow itself.\n\nThe patch path is reserved at:\n\n{patch_path}\n\nBackend metadata will be recorded at:\n\n{metadata_path}\n\nDo not edit production contracts.\n",
        run_id = ctx.run_id,
        node_id = ctx.node.id,
        workspace = workspace_path.display(),
        artifact_dir = artifact_dir.display(),
        backend = ctx.resolved_config.backend.default,
        workspace_guidance = WORKSPACE_RUNTIME_GUIDANCE,
        bash_guidance = BASH_TOOL_GUIDANCE,
        artifact_write_guidance = FILE_WRITE_TOOL_GUIDANCE,
        lens_inputs_path = lens_inputs_path.display(),
        catalog_path = catalog_path.display(),
        catalog_file = PROPERTY_SPECIFICATION_FILE,
        findings_path = output_findings_path.display(),
        patch_path = output_patch_path.display(),
        metadata_path = output_metadata_path.display(),
    );
    write_artifact(artifact_dir, RENDERED_PROMPT_FILE, rendered)
}

#[expect(
    clippy::too_many_arguments,
    reason = "property prompt rendering keeps artifact paths explicit for backend handoff"
)]
fn render_property_specification_prompt(
    ctx: &NodeContext,
    artifact_dir: &Path,
    repo: &Path,
    workspace_path: &Path,
    catalog_path: &Path,
    output_findings_path: &Path,
    output_patch_path: &Path,
    output_metadata_path: &Path,
    documentation_sources: &[PathBuf],
) -> anyhow::Result<PathBuf> {
    let prompt = load_node_prompt(repo, "property-specification.md")?;
    let documentation_sources = render_documentation_sources(documentation_sources);
    let rendered = format!(
        "{prompt}\n\n# Runtime Context\n\n- Run: {run_id}\n- Node: {node_id}\n- Workspace: {workspace}\n- Artifact path: {artifact_dir}\n- Backend: {backend}\n\n{workspace_guidance}{bash_guidance}{artifact_write_guidance}# Discovered Documentation Sources\n\n{documentation_sources}\n# Required Outputs\n\nWrite the property catalog to:\n\n{catalog_path}\n\nThe file must be JSON with this shape:\n\n```json\n{{\n  \"schema_version\": \"1.0\",\n  \"documentation_sources\": [],\n  \"guidance_applied\": [],\n  \"candidate_properties\": [\n    {{\n      \"id\": \"stable-kebab-case-id\",\n      \"title\": \"Human-readable property name\",\n      \"property_type\": \"valid-state | state-transition | variable-transition | high-level | scenario | round-trip | access-control | strict-equality | differential | encode-decode\",\n      \"priority\": \"high | medium | low\",\n      \"source\": \"README, whitepaper, docs, code, or test evidence\",\n      \"workflow\": \"contract or protocol workflow under test\",\n      \"oracle\": \"observable assertion or invariant\",\n      \"setup\": \"deployment, actors, assets, ghosts, mocks, or handlers needed\",\n      \"preconditions\": [],\n      \"frameworks\": [],\n      \"failure_classification\": \"target-bug | spec-or-model-bug | harness-bug | inconclusive\",\n      \"notes\": []\n    }}\n  ],\n  \"deferred_or_rejected_properties\": []\n}}\n```\n\n`candidate_properties` must be non-empty. If documentation is sparse, derive candidates from production contracts, public interfaces, existing tests, and deployment scripts, and mark confidence or assumptions in `notes`.\n\nWrite structured findings to:\n\n{findings_path}\n\nThe findings file must be a JSON array. Use an empty array if no findings are found.\n\nThe patch path is reserved at:\n\n{patch_path}\n\nBackend metadata will be recorded at:\n\n{metadata_path}\n\nDo not write a patch unless the property specification work uncovers a necessary harness or prompt fix. Do not edit production contracts.\n",
        run_id = ctx.run_id,
        node_id = ctx.node.id,
        workspace = workspace_path.display(),
        artifact_dir = artifact_dir.display(),
        backend = ctx.resolved_config.backend.default,
        workspace_guidance = WORKSPACE_RUNTIME_GUIDANCE,
        bash_guidance = BASH_TOOL_GUIDANCE,
        artifact_write_guidance = FILE_WRITE_TOOL_GUIDANCE,
        catalog_path = catalog_path.display(),
        findings_path = output_findings_path.display(),
        patch_path = output_patch_path.display(),
        metadata_path = output_metadata_path.display(),
    );
    write_artifact(artifact_dir, RENDERED_PROMPT_FILE, rendered)
}

fn render_documentation_sources(documentation_sources: &[PathBuf]) -> String {
    if documentation_sources.is_empty() {
        "- No README, whitepaper, spec, or docs files were discovered automatically. Inspect contracts, tests, scripts, and comments directly.\n".to_owned()
    } else {
        documentation_sources
            .iter()
            .map(|path| format!("- {}\n", path.display()))
            .collect::<String>()
    }
}

fn load_node_prompt(repo: &Path, file_name: &str) -> anyhow::Result<String> {
    {
        let relative_path = PathBuf::from("properties").join(file_name);
        let project_prompt = repo
            .join(ultrafuzz_prompts::PROJECT_PROMPT_DIR)
            .join(&relative_path);
        if project_prompt.is_file() {
            return Ok(fs::read_to_string(project_prompt)?);
        }
        if let Some(prompt) = topology_prompt_markdown(&relative_path) {
            return Ok(prompt.to_owned());
        }
    }

    match file_name {
        "property-specification.md" => {
            Ok(include_str!("../../../prompts/properties/property-specification.md").to_owned())
        }
        _ => anyhow::bail!("unknown built-in node prompt `{file_name}`"),
    }
}

fn property_lens_reference_sources(lens: PropertyLens) -> Vec<String> {
    match lens {
        PropertyLens::ZeroKnot => vec!["pinned reference `properties.0kn0t`".to_owned()],
        PropertyLens::CertoraThinking => vec![
            "pinned reference `properties.certora-thinking`".to_owned(),
            "pinned reference `properties.certora-sanity`".to_owned(),
        ],
        PropertyLens::Aviggiano => vec!["pinned reference `properties.aviggiano`".to_owned()],
        PropertyLens::JosselinFeist => {
            vec!["pinned reference `properties.montyly-rounding`".to_owned()]
        }
    }
}

fn validate_property_lens_candidates(path: &Path, lens: PropertyLens) -> anyhow::Result<Value> {
    let value = read_json_value(path).map_err(|error| {
        anyhow::anyhow!(
            "property lens candidate artifact `{}` is missing or invalid JSON: {error}",
            path.display()
        )
    })?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("property lens candidate artifact must be a JSON object"))?;
    let lens_id = object
        .get("lens_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if lens_id != lens.id() {
        anyhow::bail!(
            "property lens candidate artifact lens_id must be `{}`",
            lens.id()
        );
    }
    if object
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "failed")
    {
        return Ok(value);
    }

    let candidates = object
        .get("candidate_properties")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("property lens candidate_properties must be an array"))?;
    if candidates.is_empty() {
        anyhow::bail!("property lens candidate_properties must contain at least one candidate");
    }
    for (index, candidate) in candidates.iter().enumerate() {
        let object = candidate.as_object().ok_or_else(|| {
            anyhow::anyhow!("candidate_properties[{index}] must be a JSON object")
        })?;
        for field in [
            "id",
            "title",
            "source_lens_id",
            "property_type",
            "workflow",
            "oracle",
            "required_setup",
            "suggested_fuzzing_framework_or_strategy_fit",
            "confidence",
        ] {
            let valid = object
                .get(field)
                .and_then(Value::as_str)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
            if !valid {
                anyhow::bail!("candidate_properties[{index}].{field} must be a non-empty string");
            }
        }
        if object
            .get("source_lens_id")
            .and_then(Value::as_str)
            .is_some_and(|source_lens_id| source_lens_id != lens.id())
        {
            anyhow::bail!(
                "candidate_properties[{index}].source_lens_id must be `{}`",
                lens.id()
            );
        }
        for field in [
            "source_evidence",
            "preconditions",
            "false_positive_or_setup_bias_risks",
            "notes",
        ] {
            if !object.get(field).is_some_and(Value::is_array) {
                anyhow::bail!("candidate_properties[{index}].{field} must be an array");
            }
        }
    }
    Ok(value)
}

fn write_failed_property_lens_artifact(
    artifact_dir: &Path,
    lens: PropertyLens,
    repo: &Path,
    documentation_sources: &[PathBuf],
    error: &str,
) -> anyhow::Result<()> {
    let documentation_sources = documentation_sources
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    write_json_artifact(
        artifact_dir,
        PROPERTY_LENS_CANDIDATE_FILE,
        &json!({
            "schema_version": "1.0",
            "lens_id": lens.id(),
            "lens_display_name": lens.label(),
            "status": "failed",
            "target_repo": repo.display().to_string(),
            "documentation_sources": documentation_sources,
            "reference_sources": property_lens_reference_sources(lens),
            "candidate_properties": [],
            "errors": [error],
        }),
    )?;
    if !artifact_dir.join(FINDINGS_FILE).exists() {
        write_json_artifact(artifact_dir, FINDINGS_FILE, &Vec::<Value>::new())?;
    }
    Ok(())
}

fn collect_property_lens_inputs(ctx: &NodeContext) -> anyhow::Result<Vec<PropertyLensInput>> {
    let mut inputs = Vec::new();
    for lens in PropertyLens::ALL {
        let Some(node) = ctx.graph.nodes.iter().find(|node| {
            matches!(
                node.kind,
                NodeKind::PropertySpecificationLens { lens: node_lens } if node_lens == lens
            )
        }) else {
            inputs.push(PropertyLensInput {
                lens_id: lens.id().to_owned(),
                node_id: lens.node_id().to_owned(),
                status: "missing-node".to_owned(),
                path: None,
                candidate_count: 0,
                error: Some("lens node is not present in graph".to_owned()),
                artifact: None,
            });
            continue;
        };
        let path = ctx
            .artifact_store
            .layout()
            .artifact_dir(&node.id)
            .join(PROPERTY_LENS_CANDIDATE_FILE);
        if !path.exists() {
            inputs.push(PropertyLensInput {
                lens_id: lens.id().to_owned(),
                node_id: node.id.to_string(),
                status: "missing-artifact".to_owned(),
                path: Some(path),
                candidate_count: 0,
                error: Some(format!("{PROPERTY_LENS_CANDIDATE_FILE} is missing")),
                artifact: None,
            });
            continue;
        }
        match read_json_value(&path) {
            Ok(artifact) => {
                let candidate_count = artifact
                    .get("candidate_properties")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or_default();
                let status = artifact
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("succeeded")
                    .to_owned();
                let error = artifact
                    .get("errors")
                    .and_then(Value::as_array)
                    .and_then(|errors| errors.first())
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                inputs.push(PropertyLensInput {
                    lens_id: lens.id().to_owned(),
                    node_id: node.id.to_string(),
                    status,
                    path: Some(path),
                    candidate_count,
                    error,
                    artifact: Some(artifact),
                });
            }
            Err(error) => inputs.push(PropertyLensInput {
                lens_id: lens.id().to_owned(),
                node_id: node.id.to_string(),
                status: "invalid-json".to_owned(),
                path: Some(path),
                candidate_count: 0,
                error: Some(error.to_string()),
                artifact: None,
            }),
        }
    }
    Ok(inputs)
}

fn write_deterministic_property_catalog(
    catalog_path: &Path,
    findings_path: &Path,
    lens_inputs: &[PropertyLensInput],
) -> anyhow::Result<()> {
    let mut unique = BTreeMap::<String, Value>::new();
    for input in lens_inputs {
        if input.status == "failed" {
            continue;
        }
        let Some(candidates) = input
            .artifact
            .as_ref()
            .and_then(|artifact| artifact.get("candidate_properties"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for candidate in candidates {
            let Some(candidate_object) = candidate.as_object() else {
                continue;
            };
            let key = property_candidate_key(candidate_object);
            if let Some(existing) = unique.get_mut(&key) {
                merge_property_candidate(existing, candidate_object, &input.lens_id);
            } else {
                unique.insert(
                    key,
                    final_property_from_candidate(candidate_object, &input.lens_id),
                );
            }
        }
    }

    let candidate_properties = unique.into_values().collect::<Vec<_>>();
    if candidate_properties.is_empty() {
        anyhow::bail!(
            "property specification fan-in could not build a catalog because no useful lens candidates were available"
        );
    }
    write_json_file(
        catalog_path,
        &json!({
            "schema_version": "1.0",
            "documentation_sources": [],
            "guidance_applied": ["deterministic property-specification fan-in fallback"],
            "lens_inputs": lens_inputs,
            "candidate_properties": candidate_properties,
            "deferred_or_rejected_properties": [],
            "findings": [],
        }),
    )?;
    write_json_file(findings_path, &Vec::<Value>::new())?;
    Ok(())
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<PathBuf> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(path.to_path_buf())
}

fn property_candidate_key(candidate: &serde_json::Map<String, Value>) -> String {
    [
        string_field(candidate, "title"),
        string_field(candidate, "workflow"),
        string_field(candidate, "oracle"),
    ]
    .into_iter()
    .map(|value| value.trim().to_ascii_lowercase())
    .collect::<Vec<_>>()
    .join("|")
}

fn final_property_from_candidate(
    candidate: &serde_json::Map<String, Value>,
    lens_id: &str,
) -> Value {
    let evidence = string_array_field(candidate, "source_evidence");
    let frameworks = string_array_field(candidate, "frameworks");
    let strategy_fit = string_field(candidate, "suggested_fuzzing_framework_or_strategy_fit");
    let frameworks = if frameworks.is_empty() && !strategy_fit.is_empty() {
        vec![strategy_fit]
    } else {
        frameworks
    };
    let candidate_id = string_field(candidate, "id");
    json!({
        "id": candidate_id,
        "title": string_field(candidate, "title"),
        "property_type": normalize_property_type(&string_field(candidate, "property_type")),
        "priority": normalize_priority(
            candidate
                .get("suggested_priority_signal")
                .or_else(|| candidate.get("priority"))
                .and_then(Value::as_str)
        ),
        "source": if evidence.is_empty() { lens_id.to_owned() } else { evidence.join("; ") },
        "source_lenses": [lens_id],
        "source_evidence": evidence,
        "workflow": string_field(candidate, "workflow"),
        "oracle": string_field(candidate, "oracle"),
        "setup": string_field(candidate, "required_setup"),
        "preconditions": string_array_field(candidate, "preconditions"),
        "frameworks": frameworks,
        "confidence": normalize_confidence(candidate.get("confidence").and_then(Value::as_str)),
        "failure_classification": candidate
            .get("failure_classification")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("inconclusive"),
        "false_positive_or_setup_bias_risks": string_array_field(candidate, "false_positive_or_setup_bias_risks"),
        "notes": string_array_field(candidate, "notes"),
        "provenance": [{
            "lens_id": lens_id,
            "candidate_id": candidate_id,
        }],
    })
}

fn merge_property_candidate(
    existing: &mut Value,
    candidate: &serde_json::Map<String, Value>,
    lens_id: &str,
) {
    append_unique_string(existing, "source_lenses", lens_id.to_owned());
    for value in string_array_field(candidate, "source_evidence") {
        append_unique_string(existing, "source_evidence", value);
    }
    for value in string_array_field(candidate, "preconditions") {
        append_unique_string(existing, "preconditions", value);
    }
    for value in string_array_field(candidate, "false_positive_or_setup_bias_risks") {
        append_unique_string(existing, "false_positive_or_setup_bias_risks", value);
    }
    for value in string_array_field(candidate, "notes") {
        append_unique_string(existing, "notes", value);
    }
    let strategy_fit = string_field(candidate, "suggested_fuzzing_framework_or_strategy_fit");
    if !strategy_fit.is_empty() {
        append_unique_string(existing, "frameworks", strategy_fit);
    }
    let candidate_priority = normalize_priority(
        candidate
            .get("suggested_priority_signal")
            .or_else(|| candidate.get("priority"))
            .and_then(Value::as_str),
    );
    if priority_rank(&candidate_priority)
        > existing
            .get("priority")
            .and_then(Value::as_str)
            .map(priority_rank)
            .unwrap_or(0)
    {
        existing["priority"] = Value::String(candidate_priority);
    }
    let candidate_confidence =
        normalize_confidence(candidate.get("confidence").and_then(Value::as_str));
    if confidence_rank(&candidate_confidence)
        > existing
            .get("confidence")
            .and_then(Value::as_str)
            .map(confidence_rank)
            .unwrap_or(0)
    {
        existing["confidence"] = Value::String(candidate_confidence);
    }
    if let Some(provenance) = existing.get_mut("provenance").and_then(Value::as_array_mut) {
        provenance.push(json!({
            "lens_id": lens_id,
            "candidate_id": string_field(candidate, "id"),
        }));
    }
}

fn append_unique_string(target: &mut Value, field: &str, value: String) {
    if value.trim().is_empty() {
        return;
    }
    let Some(values) = target.get_mut(field).and_then(Value::as_array_mut) else {
        return;
    };
    if !values
        .iter()
        .any(|existing| existing.as_str() == Some(value.as_str()))
    {
        values.push(Value::String(value));
    }
}

fn string_field(candidate: &serde_json::Map<String, Value>, field: &str) -> String {
    candidate
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn string_array_field(candidate: &serde_json::Map<String, Value>, field: &str) -> Vec<String> {
    match candidate.get(field) {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        Some(Value::String(value)) if !value.trim().is_empty() => vec![value.trim().to_owned()],
        _ => Vec::new(),
    }
}

fn normalize_property_type(value: &str) -> String {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch == '_' || ch == ' ' { '-' } else { ch })
        .collect::<String>();
    match normalized.as_str() {
        "state" | "valid-states" => "valid-state".to_owned(),
        "transition" | "state-transitions" => "state-transition".to_owned(),
        "variable-transitions" => "variable-transition".to_owned(),
        "high-level-property" | "system" | "system-wide" => "high-level".to_owned(),
        "unit-test" | "scenario-property" => "scenario".to_owned(),
        "roundtrip" => "round-trip".to_owned(),
        "access" | "authorization" => "access-control".to_owned(),
        "strict-equality" | "equality" => "strict-equality".to_owned(),
        "decode/encode" | "encode-decode" => "encode-decode".to_owned(),
        "" => "high-level".to_owned(),
        _ => normalized,
    }
}

fn normalize_priority(value: Option<&str>) -> String {
    let value = value.unwrap_or_default().to_ascii_lowercase();
    if value.contains("high") || value.contains("critical") {
        "high".to_owned()
    } else if value.contains("low") {
        "low".to_owned()
    } else {
        "medium".to_owned()
    }
}

fn normalize_confidence(value: Option<&str>) -> String {
    let value = value.unwrap_or_default().to_ascii_lowercase();
    if value.contains("high") {
        "high".to_owned()
    } else if value.contains("low") {
        "low".to_owned()
    } else {
        "medium".to_owned()
    }
}

fn priority_rank(value: &str) -> u8 {
    match value {
        "high" => 3,
        "medium" => 2,
        "low" => 1,
        _ => 0,
    }
}

fn confidence_rank(value: &str) -> u8 {
    priority_rank(value)
}

fn validate_property_specification_catalog(path: &Path) -> anyhow::Result<Value> {
    let value = read_json_value(path).map_err(|error| {
        anyhow::anyhow!(
            "property specification catalog `{}` is missing or invalid JSON: {error}",
            path.display()
        )
    })?;
    let candidates = value
        .get("candidate_properties")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "property specification catalog `{}` must contain candidate_properties array",
                path.display()
            )
        })?;
    if candidates.is_empty() {
        anyhow::bail!(
            "property specification catalog `{}` must contain at least one candidate property",
            path.display()
        );
    }
    for (index, candidate) in candidates.iter().enumerate() {
        let object = candidate.as_object().ok_or_else(|| {
            anyhow::anyhow!("candidate_properties[{index}] must be a JSON object")
        })?;
        for field in ["id", "title", "property_type", "priority", "oracle"] {
            let valid = object
                .get(field)
                .and_then(Value::as_str)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
            if !valid {
                anyhow::bail!("candidate_properties[{index}].{field} must be a non-empty string");
            }
        }
        let priority = object
            .get("priority")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(priority, "high" | "medium" | "low") {
            anyhow::bail!(
                "candidate_properties[{index}].priority must be exactly high, medium, or low"
            );
        }
    }
    Ok(value)
}

fn push_if_exists(artifacts: &mut Vec<ArtifactRef>, path: PathBuf) {
    if path.exists() {
        artifacts.push(ArtifactRef::new(path));
    }
}

fn strategy_attempt_nodes(graph: &CampaignGraph, strategy: &StrategyId) -> Vec<Node> {
    graph
        .nodes
        .iter()
        .filter(|node| {
            matches!(
                &node.kind,
                NodeKind::AgentAttempt {
                    strategy: node_strategy,
                    ..
                } if node_strategy == strategy
            )
        })
        .cloned()
        .collect()
}

fn render_consolidation_summary(
    strategy: &StrategyId,
    findings: &[Finding],
    invalid: usize,
) -> String {
    let mut summary = format!(
        "# Consolidated {strategy}\n\nFindings: `{}`\n\nInvalid entries: `{}`\n\n",
        findings.len(),
        invalid
    );
    for finding in findings {
        summary.push_str(&format!(
            "- {} (`{}`, `{}`)\n",
            finding.title, finding.status, finding.severity_guess
        ));
    }
    summary
}

fn read_findings_array(path: impl AsRef<Path>) -> anyhow::Result<Vec<Finding>> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_slice(&read_bounded_json_bytes(path)?)?)
}

fn findings_json_has_entries(path: impl AsRef<Path>) -> anyhow::Result<bool> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(false);
    }
    match read_json_value(path)? {
        Value::Array(findings) => Ok(!findings.is_empty()),
        _ => anyhow::bail!(
            "findings artifact `{}` must be a JSON array",
            path.display()
        ),
    }
}

fn emit_finding_created_if_nonempty(
    sink: &dyn EventSink,
    run_id: &RunId,
    node_id: &NodeId,
    path: impl AsRef<Path>,
) -> anyhow::Result<()> {
    let path = path.as_ref();
    if findings_json_has_entries(path)? {
        emit_event(
            sink,
            run_id,
            RunEvent::FindingCreated {
                node_id: node_id.clone(),
                path: path.to_path_buf(),
            },
        )?;
    }
    Ok(())
}

fn read_strategy_detections_array(
    path: impl AsRef<Path>,
) -> anyhow::Result<Vec<FindingStrategyDetection>> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_slice(&read_bounded_json_bytes(path)?)?)
}

fn strategy_detection_from_finding(
    dedupe_key: &str,
    finding: &Finding,
) -> FindingStrategyDetection {
    FindingStrategyDetection {
        dedupe_key: dedupe_key.to_owned(),
        finding_id: finding.id.clone(),
        family_id: finding.family_id.clone(),
        title: finding.title.clone(),
        hits: finding_strategy_hits(finding),
    }
}

fn merge_strategy_detection_hit(
    detections: &mut BTreeMap<String, FindingStrategyDetection>,
    dedupe_key: &str,
    finding: &Finding,
) {
    let detection = detections
        .entry(dedupe_key.to_owned())
        .or_insert_with(|| strategy_detection_from_finding(dedupe_key, finding));
    if detection.family_id.is_none() {
        detection.family_id.clone_from(&finding.family_id);
    }
    for hit in finding_strategy_hits(finding) {
        if !detection.hits.contains(&hit) {
            detection.hits.push(hit);
            detection.hits.sort();
        }
    }
}

fn finding_strategy_hits(finding: &Finding) -> Vec<FindingStrategyHit> {
    let mut hits = finding_strategy_hit(finding)
        .into_iter()
        .collect::<Vec<_>>();
    for variant in &finding.family_variants {
        if let Some(hit) = variant_strategy_hit(variant) {
            hits.push(hit);
        }
    }
    hits.sort();
    hits.dedup();
    hits
}

fn finding_strategy_hit(finding: &Finding) -> Option<FindingStrategyHit> {
    Some(FindingStrategyHit {
        strategy: finding.strategy.clone()?,
        attempt_index: finding.attempt_index,
        model_id: finding.model_id.clone(),
        model: finding.model.clone(),
        model_index: finding.model_index,
        loop_index: finding.loop_index,
    })
}

fn variant_strategy_hit(variant: &FindingFamilyVariant) -> Option<FindingStrategyHit> {
    Some(FindingStrategyHit {
        strategy: variant.strategy.clone()?,
        attempt_index: variant.attempt_index,
        model_id: variant.model_id.clone(),
        model: variant.model.clone(),
        model_index: variant.model_index,
        loop_index: variant.loop_index,
    })
}

#[derive(Clone, Debug)]
struct FindingWithSource {
    finding: Finding,
    source_node_id: NodeId,
    source_artifact: PathBuf,
}

fn run_relative_path(ctx: &NodeContext, path: &Path) -> PathBuf {
    path.strip_prefix(&ctx.artifact_store.layout().root)
        .unwrap_or(path)
        .to_path_buf()
}

fn lifecycle_source_artifact(
    input: &FindingWithSource,
    relationship: FindingSourceRelationship,
) -> FindingLifecycleSourceArtifact {
    FindingLifecycleSourceArtifact {
        path: input.source_artifact.clone(),
        node_id: input.source_node_id.clone(),
        finding_id: input.finding.id.clone(),
        dedupe_key: Some(finding_dedupe_key(&input.finding)),
        title: input.finding.title.clone(),
        relationship,
    }
}

fn lifecycle_variant_source_artifact(
    input: &FindingWithSource,
    variant: &FindingFamilyVariant,
) -> FindingLifecycleSourceArtifact {
    FindingLifecycleSourceArtifact {
        path: input.source_artifact.clone(),
        node_id: input.source_node_id.clone(),
        finding_id: variant.id.clone(),
        dedupe_key: variant.dedupe_key.clone(),
        title: variant.title.clone(),
        relationship: FindingSourceRelationship::FamilyVariant,
    }
}

fn raw_lifecycle_stage(
    input: &FindingWithSource,
    note: Option<&str>,
) -> FindingLifecycleStageRecord {
    FindingLifecycleStageRecord {
        stage: FindingLifecycleStage::Raw,
        node_id: input.source_node_id.clone(),
        artifact_path: input.source_artifact.clone(),
        finding_id: input.finding.id.clone(),
        status: input.finding.status,
        severity: Some(input.finding.severity_guess),
        triage_classification: input.finding.triage_classification,
        note: note.map(str::to_owned),
    }
}

fn finding_lifecycle_stage(
    stage: FindingLifecycleStage,
    ctx: &NodeContext,
    artifact_path: &Path,
    finding: &Finding,
    note: Option<&str>,
) -> FindingLifecycleStageRecord {
    FindingLifecycleStageRecord {
        stage,
        node_id: ctx.node.id.clone(),
        artifact_path: run_relative_path(ctx, artifact_path),
        finding_id: finding.id.clone(),
        status: finding.status,
        severity: Some(finding.severity_guess),
        triage_classification: finding.triage_classification,
        note: note.map(str::to_owned),
    }
}

fn dedupe_lifecycle_ledger(
    ctx: &NodeContext,
    deduped_path: &Path,
    deduped_inputs: &[FindingWithSource],
    strategy_detections: &[FindingStrategyDetection],
    mut duplicate_sources: BTreeMap<String, Vec<FindingLifecycleSourceArtifact>>,
    mut duplicate_stages: BTreeMap<String, Vec<FindingLifecycleStageRecord>>,
    mut duplicate_finding_ids: BTreeMap<String, Vec<String>>,
) -> FindingLifecycleLedger {
    let detections_by_key = strategy_detections
        .iter()
        .map(|detection| (detection.dedupe_key.as_str(), detection))
        .collect::<BTreeMap<_, _>>();
    let mut records = Vec::new();
    for input in deduped_inputs {
        let key = finding_dedupe_key(&input.finding);
        let mut source_artifacts = vec![lifecycle_source_artifact(
            input,
            FindingSourceRelationship::Primary,
        )];
        for variant in &input.finding.family_variants {
            source_artifacts.push(lifecycle_variant_source_artifact(input, variant));
        }
        source_artifacts.extend(duplicate_sources.remove(&key).unwrap_or_default());

        let mut stages = vec![raw_lifecycle_stage(input, None)];
        stages.extend(duplicate_stages.remove(&key).unwrap_or_default());
        stages.push(finding_lifecycle_stage(
            FindingLifecycleStage::Deduped,
            ctx,
            deduped_path,
            &input.finding,
            None,
        ));

        let strategy_hits = detections_by_key
            .get(key.as_str())
            .map(|detection| detection.hits.clone())
            .unwrap_or_else(|| finding_strategy_hits(&input.finding));
        let family_variant_keys = input
            .finding
            .family_variants
            .iter()
            .filter_map(|variant| variant.dedupe_key.clone())
            .collect::<Vec<_>>();

        records.push(FindingLifecycleRecord {
            dedupe_key: key.clone(),
            finding_id: input.finding.id.clone(),
            family_id: input.finding.family_id.clone(),
            title: input.finding.title.clone(),
            source_artifacts,
            strategy_hits,
            duplicate_finding_ids: duplicate_finding_ids.remove(&key).unwrap_or_default(),
            family_variant_keys,
            canonical_severity: None,
            triage_classification: input.finding.triage_classification,
            triage_reason: triage_reason_from_notes(&input.finding.notes),
            demotion_reason: demotion_reason_from_notes(&input.finding.notes),
            final_disposition: None,
            comparison_disposition: None,
            stages,
        });
    }
    FindingLifecycleLedger {
        schema_version: "1.0".to_owned(),
        records,
    }
}

fn read_lifecycle_ledger(path: impl AsRef<Path>) -> anyhow::Result<FindingLifecycleLedger> {
    let path = path.as_ref();
    if !path.exists() {
        anyhow::bail!("finding lifecycle ledger `{}` is missing", path.display());
    }
    let ledger: FindingLifecycleLedger = serde_json::from_slice(&read_bounded_json_bytes(path)?)?;
    if ledger.schema_version != "1.0" {
        anyhow::bail!(
            "finding lifecycle ledger `{}` has unsupported schema_version `{}`",
            path.display(),
            ledger.schema_version
        );
    }
    Ok(ledger)
}

fn triage_lifecycle_ledger(
    ctx: &NodeContext,
    triaged_path: &Path,
    ledger: FindingLifecycleLedger,
    findings: &[Finding],
) -> anyhow::Result<FindingLifecycleLedger> {
    let mut records_by_key = BTreeMap::<String, FindingLifecycleRecord>::new();
    for record in ledger.records {
        if records_by_key
            .insert(record.dedupe_key.clone(), record)
            .is_some()
        {
            anyhow::bail!("finding lifecycle ledger contains duplicate dedupe_key entries");
        }
    }

    let mut updated_keys = BTreeSet::new();
    for finding in findings {
        let key = finding_dedupe_key(finding);
        let record = records_by_key.get_mut(&key).ok_or_else(|| {
            anyhow::anyhow!(
                "triage finding `{}` has no lifecycle ledger record for dedupe_key `{key}`",
                finding.id.as_deref().unwrap_or("<missing-id>")
            )
        })?;
        record.finding_id = finding.id.clone();
        record.title = finding.title.clone();
        record.triage_classification = finding.triage_classification;
        if record.triage_reason.is_none() {
            record.triage_reason = triage_reason_from_notes(&finding.notes);
        }
        if record.demotion_reason.is_none() {
            record.demotion_reason = demotion_reason_from_notes(&finding.notes);
        }
        record.stages.push(finding_lifecycle_stage(
            FindingLifecycleStage::Triaged,
            ctx,
            triaged_path,
            finding,
            None,
        ));
        updated_keys.insert(key);
    }

    if let Some(missing) = records_by_key
        .keys()
        .find(|key| !updated_keys.contains(*key))
        .cloned()
    {
        anyhow::bail!(
            "finding lifecycle ledger record `{missing}` was not present in triaged findings"
        );
    }

    Ok(FindingLifecycleLedger {
        schema_version: "1.0".to_owned(),
        records: records_by_key.into_values().collect(),
    })
}

fn recover_missing_final_report_lifecycle_inputs(ctx: &NodeContext) -> anyhow::Result<()> {
    let layout = ctx.artifact_store.layout();
    let dedupe_node = NodeId::from("dedupe-findings");
    let triage_node = NodeId::from("triage");
    let severity_node = NodeId::from("severity-classification");
    let dedupe_dir = layout.artifact_dir(&dedupe_node);
    let triage_dir = layout.artifact_dir(&triage_node);
    let severity_dir = layout.artifact_dir(&severity_node);
    let severity_ledger_path = severity_dir.join(FINDING_LIFECYCLE_LEDGER_FILE);
    if severity_ledger_path.exists() {
        return Ok(());
    }

    let deduped_path = dedupe_dir.join("deduped-findings.json");
    let triaged_path = triage_dir.join(TRIAGED_FINDINGS_FILE);
    let severity_path = severity_dir.join("severity-classified-findings.json");
    let mut ledger = lifecycle_ledger_from_deduped_values(ctx, &deduped_path, &dedupe_dir)?;
    write_json_artifact(&dedupe_dir, FINDING_LIFECYCLE_LEDGER_FILE, &ledger)?;
    ctx.artifact_store
        .write_manifest(&dedupe_node)
        .map(|_| ())
        .map_err(anyhow::Error::from)?;

    let triaged = read_json_array_required(&triaged_path, "triaged findings")?;
    ledger = triage_lifecycle_ledger_from_values(ctx, &triaged_path, ledger, &triaged)?;
    write_json_artifact(&triage_dir, FINDING_LIFECYCLE_LEDGER_FILE, &ledger)?;
    ctx.artifact_store
        .write_manifest(&triage_node)
        .map(|_| ())
        .map_err(anyhow::Error::from)?;

    let severity = read_json_array_required(&severity_path, "severity-classified findings")?;
    ledger = severity_lifecycle_ledger_from_values(ctx, &severity_path, ledger, &severity)?;
    write_json_artifact(&severity_dir, FINDING_LIFECYCLE_LEDGER_FILE, &ledger)?;
    ctx.artifact_store
        .write_manifest(&severity_node)
        .map(|_| ())
        .map_err(anyhow::Error::from)?;

    Ok(())
}

fn lifecycle_ledger_from_deduped_values(
    ctx: &NodeContext,
    deduped_path: &Path,
    dedupe_dir: &Path,
) -> anyhow::Result<FindingLifecycleLedger> {
    let deduped = read_json_array_required(deduped_path, "deduped findings")?;
    let detections = read_strategy_detections_array(dedupe_dir.join(STRATEGY_DETECTIONS_FILE))?;
    let detections_by_key = detections
        .iter()
        .map(|detection| (detection.dedupe_key.as_str(), detection))
        .collect::<BTreeMap<_, _>>();
    let mut seen = BTreeSet::new();
    let mut records = Vec::new();
    for (index, value) in deduped.iter().enumerate() {
        let object = review_finding_object(value, "deduped findings", index)?;
        let key = review_finding_dedupe_key(object, "deduped findings", index)?;
        if !seen.insert(key.clone()) {
            anyhow::bail!("deduped findings contain duplicate dedupe_key `{key}`");
        }
        let title = review_finding_title(object, &key);
        let strategy_hits = detections_by_key
            .get(key.as_str())
            .map(|detection| detection.hits.clone())
            .unwrap_or_else(|| review_strategy_hit(object).into_iter().collect());
        if strategy_hits.is_empty() {
            anyhow::bail!(
                "deduped finding `{key}` has no strategy detection provenance for lifecycle recovery"
            );
        }
        let source_artifacts =
            review_source_artifacts(&key, &title, review_finding_id(object), &strategy_hits);
        let mut stages = source_artifacts
            .iter()
            .map(|source| FindingLifecycleStageRecord {
                stage: FindingLifecycleStage::Raw,
                node_id: source.node_id.clone(),
                artifact_path: source.path.clone(),
                finding_id: source.finding_id.clone(),
                status: review_finding_status(object),
                severity: Some(review_finding_severity(object)),
                triage_classification: review_triage_classification(object),
                note: Some("recovered from strategy detection provenance".to_owned()),
            })
            .collect::<Vec<_>>();
        stages.push(review_lifecycle_stage(
            FindingLifecycleStage::Deduped,
            NodeId::from("dedupe-findings"),
            ctx,
            deduped_path,
            object,
            None,
        ));
        records.push(FindingLifecycleRecord {
            dedupe_key: key,
            finding_id: review_finding_id(object),
            family_id: review_optional_string_field(object, "family_id"),
            title,
            source_artifacts,
            strategy_hits,
            duplicate_finding_ids: review_duplicate_finding_ids(object),
            family_variant_keys: review_family_variant_keys(object),
            canonical_severity: None,
            triage_classification: review_triage_classification(object),
            triage_reason: review_triage_reason(object),
            demotion_reason: review_demotion_reason(object),
            final_disposition: None,
            comparison_disposition: None,
            stages,
        });
    }
    Ok(FindingLifecycleLedger {
        schema_version: "1.0".to_owned(),
        records,
    })
}

fn triage_lifecycle_ledger_from_values(
    ctx: &NodeContext,
    triaged_path: &Path,
    ledger: FindingLifecycleLedger,
    values: &[Value],
) -> anyhow::Result<FindingLifecycleLedger> {
    let mut records_by_key = ledger
        .records
        .into_iter()
        .map(|record| (record.dedupe_key.clone(), record))
        .collect::<BTreeMap<_, _>>();
    let mut updated = BTreeSet::new();
    for (index, value) in values.iter().enumerate() {
        let object = review_finding_object(value, "triaged findings", index)?;
        let key = review_finding_dedupe_key(object, "triaged findings", index)?;
        let record = records_by_key.get_mut(&key).ok_or_else(|| {
            anyhow::anyhow!("triaged finding `{key}` has no lifecycle ledger record")
        })?;
        record.finding_id = review_finding_id(object).or_else(|| record.finding_id.clone());
        record.title = review_finding_title(object, &key);
        record.triage_classification =
            review_triage_classification(object).or(record.triage_classification);
        if record.triage_reason.is_none() {
            record.triage_reason = review_triage_reason(object);
        }
        if record.demotion_reason.is_none() {
            record.demotion_reason = review_demotion_reason(object);
        }
        record.stages.push(review_lifecycle_stage(
            FindingLifecycleStage::Triaged,
            NodeId::from("triage"),
            ctx,
            triaged_path,
            object,
            None,
        ));
        updated.insert(key);
    }
    if let Some(missing) = records_by_key
        .keys()
        .find(|key| !updated.contains(*key))
        .cloned()
    {
        anyhow::bail!("lifecycle ledger record `{missing}` was not present in triaged findings");
    }
    Ok(FindingLifecycleLedger {
        schema_version: "1.0".to_owned(),
        records: records_by_key.into_values().collect(),
    })
}

fn severity_lifecycle_ledger_from_values(
    ctx: &NodeContext,
    severity_path: &Path,
    ledger: FindingLifecycleLedger,
    values: &[Value],
) -> anyhow::Result<FindingLifecycleLedger> {
    let mut records_by_key = ledger
        .records
        .into_iter()
        .map(|record| (record.dedupe_key.clone(), record))
        .collect::<BTreeMap<_, _>>();
    let mut updated = BTreeSet::new();
    for (index, value) in values.iter().enumerate() {
        let object = review_finding_object(value, "severity-classified findings", index)?;
        let key = review_finding_dedupe_key(object, "severity-classified findings", index)?;
        let record = records_by_key.get_mut(&key).ok_or_else(|| {
            anyhow::anyhow!("severity-classified finding `{key}` has no lifecycle ledger record")
        })?;
        let triage_classification =
            review_triage_classification(object).or(record.triage_classification);
        let final_disposition =
            review_final_disposition(review_finding_status(object), triage_classification);
        record.finding_id = review_finding_id(object).or_else(|| record.finding_id.clone());
        record.title = review_finding_title(object, &key);
        record.family_id =
            review_optional_string_field(object, "family_id").or_else(|| record.family_id.clone());
        record.triage_classification = triage_classification;
        if record.triage_reason.is_none() {
            record.triage_reason = review_triage_reason(object);
        }
        record.canonical_severity = Some(review_finding_severity(object));
        record.final_disposition = Some(final_disposition);
        if matches!(
            final_disposition,
            FindingFinalDisposition::NonProduction | FindingFinalDisposition::Dropped
        ) && record.demotion_reason.is_none()
        {
            record.demotion_reason =
                review_demotion_reason(object).or_else(|| review_default_demotion_reason(object));
        }
        record.stages.push(review_lifecycle_stage(
            FindingLifecycleStage::SeverityClassified,
            NodeId::from("severity-classification"),
            ctx,
            severity_path,
            object,
            None,
        ));
        updated.insert(key);
    }
    if let Some(missing) = records_by_key
        .keys()
        .find(|key| !updated.contains(*key))
        .cloned()
    {
        anyhow::bail!(
            "lifecycle ledger record `{missing}` was not present in severity-classified findings"
        );
    }
    Ok(FindingLifecycleLedger {
        schema_version: "1.0".to_owned(),
        records: records_by_key.into_values().collect(),
    })
}

fn review_finding_object<'a>(
    value: &'a Value,
    label: &str,
    index: usize,
) -> anyhow::Result<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("{label}[{index}] must be a JSON object"))
}

fn review_finding_dedupe_key(
    object: &serde_json::Map<String, Value>,
    label: &str,
    index: usize,
) -> anyhow::Result<String> {
    review_optional_string_field(object, "dedupe_key").ok_or_else(|| {
        anyhow::anyhow!("{label}[{index}] is missing required `dedupe_key` for lifecycle recovery")
    })
}

fn review_optional_string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Option<String> {
    optional_json_string_field(object, key).map(str::to_owned)
}

fn review_finding_id(object: &serde_json::Map<String, Value>) -> Option<String> {
    review_optional_string_field(object, "id")
}

fn review_finding_title(object: &serde_json::Map<String, Value>, fallback: &str) -> String {
    review_optional_string_field(object, "title").unwrap_or_else(|| fallback.to_owned())
}

fn review_finding_status(object: &serde_json::Map<String, Value>) -> FindingStatus {
    let Some(status) = optional_json_string_field(object, "status") else {
        return FindingStatus::NeedsReview;
    };
    if let Ok(parsed) = FindingStatus::from_str(status) {
        return parsed;
    }
    let normalized = status.to_ascii_lowercase();
    if normalized.contains("false-positive") {
        FindingStatus::FalsePositive
    } else if normalized.contains("duplicate") {
        FindingStatus::Duplicate
    } else if normalized.contains("confirmed") || normalized.contains("reproduced") {
        FindingStatus::Confirmed
    } else {
        FindingStatus::NeedsReview
    }
}

fn review_finding_severity(object: &serde_json::Map<String, Value>) -> Severity {
    optional_json_string_field(object, "severity")
        .or_else(|| optional_json_string_field(object, "severity_guess"))
        .and_then(|severity| Severity::from_str(severity).ok())
        .unwrap_or(Severity::Unknown)
}

fn review_triage_classification(
    object: &serde_json::Map<String, Value>,
) -> Option<TriageClassification> {
    optional_json_string_field(object, "triage_classification")
        .and_then(|classification| TriageClassification::from_str(classification).ok())
}

fn review_notes(object: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut notes = Vec::new();
    for key in [
        "notes",
        "triage_notes",
        "dedupe_notes",
        "severity_notes",
        "classification_notes",
    ] {
        match object.get(key) {
            Some(Value::String(note)) if !note.trim().is_empty() => {
                notes.push(note.trim().to_owned());
            }
            Some(Value::Array(values)) => {
                notes.extend(values.iter().filter_map(|value| {
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|note| !note.is_empty())
                        .map(str::to_owned)
                }));
            }
            _ => {}
        }
    }
    notes
}

fn review_triage_reason(object: &serde_json::Map<String, Value>) -> Option<String> {
    let notes = review_notes(object);
    note_value(&notes, "triage_reason")
        .or_else(|| note_value(&notes, "classification_reason"))
        .or_else(|| review_optional_string_field(object, "triage_consensus"))
        .or_else(|| {
            review_triage_classification(object)
                .map(|classification| format!("triage_classification={classification}"))
        })
}

fn review_demotion_reason(object: &serde_json::Map<String, Value>) -> Option<String> {
    let notes = review_notes(object);
    note_value(&notes, "demotion_reason")
        .or_else(|| note_value(&notes, "non_production_reason"))
        .or_else(|| note_value(&notes, "classification_reason"))
}

fn review_default_demotion_reason(object: &serde_json::Map<String, Value>) -> Option<String> {
    review_triage_classification(object)
        .map(|classification| format!("triage_classification={classification}"))
        .or_else(|| Some(format!("status={}", review_finding_status(object).as_str())))
}

fn review_final_disposition(
    status: FindingStatus,
    triage_classification: Option<TriageClassification>,
) -> FindingFinalDisposition {
    if matches!(
        status,
        FindingStatus::FalsePositive | FindingStatus::Duplicate
    ) {
        return FindingFinalDisposition::Dropped;
    }
    match triage_classification {
        Some(TriageClassification::TruePositive) => FindingFinalDisposition::Promoted,
        Some(TriageClassification::FalsePositive) => FindingFinalDisposition::Dropped,
        Some(
            TriageClassification::Undetermined
            | TriageClassification::IncompleteSpec
            | TriageClassification::HarnessDefect
            | TriageClassification::RepairCandidate
            | TriageClassification::SpecGated
            | TriageClassification::DefensiveHardening,
        ) => FindingFinalDisposition::NonProduction,
        None => FindingFinalDisposition::NonProduction,
    }
}

fn review_strategy_hit(object: &serde_json::Map<String, Value>) -> Option<FindingStrategyHit> {
    let provenance = object
        .get("provenance")
        .and_then(Value::as_object)
        .unwrap_or(object);
    let strategy = review_optional_string_field(provenance, "strategy")?;
    Some(FindingStrategyHit {
        strategy: StrategyId::from(strategy),
        attempt_index: optional_json_usize_field(provenance, "attempt_index"),
        model_id: review_optional_string_field(provenance, "model_id").map(ModelProfileId::from),
        model: review_optional_string_field(provenance, "model"),
        model_index: optional_json_usize_field(provenance, "model_index"),
        loop_index: optional_json_usize_field(provenance, "loop_index"),
    })
}

fn optional_json_usize_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<usize> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn review_source_artifacts(
    key: &str,
    title: &str,
    finding_id: Option<String>,
    strategy_hits: &[FindingStrategyHit],
) -> Vec<FindingLifecycleSourceArtifact> {
    strategy_hits
        .iter()
        .enumerate()
        .map(|(index, hit)| {
            let node_id = strategy_hit_node_id(hit);
            FindingLifecycleSourceArtifact {
                path: Path::new("artifacts")
                    .join(node_id.as_str())
                    .join(FINDINGS_FILE),
                node_id,
                finding_id: finding_id.clone(),
                dedupe_key: Some(key.to_owned()),
                title: title.to_owned(),
                relationship: if index == 0 {
                    FindingSourceRelationship::Primary
                } else {
                    FindingSourceRelationship::Duplicate
                },
            }
        })
        .collect()
}

fn strategy_hit_node_id(hit: &FindingStrategyHit) -> NodeId {
    hit.attempt_index
        .or(hit.loop_index)
        .map(|index| NodeId::from(format!("{}-{index}", hit.strategy)))
        .unwrap_or_else(|| NodeId::from(hit.strategy.to_string()))
}

fn review_lifecycle_stage(
    stage: FindingLifecycleStage,
    node_id: NodeId,
    ctx: &NodeContext,
    artifact_path: &Path,
    object: &serde_json::Map<String, Value>,
    note: Option<&str>,
) -> FindingLifecycleStageRecord {
    FindingLifecycleStageRecord {
        stage,
        node_id,
        artifact_path: run_relative_path(ctx, artifact_path),
        finding_id: review_finding_id(object),
        status: review_finding_status(object),
        severity: Some(review_finding_severity(object)),
        triage_classification: review_triage_classification(object),
        note: note.map(str::to_owned),
    }
}

fn review_duplicate_finding_ids(object: &serde_json::Map<String, Value>) -> Vec<String> {
    object
        .get("duplicates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|duplicate| {
            review_optional_string_field(duplicate, "id")
                .or_else(|| review_optional_string_field(duplicate, "original_id"))
                .or_else(|| review_optional_string_field(duplicate, "duplicate_id"))
        })
        .collect()
}

fn review_family_variant_keys(object: &serde_json::Map<String, Value>) -> Vec<String> {
    object
        .get("family_variants")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|variant| review_optional_string_field(variant, "dedupe_key"))
        .collect()
}

fn triage_reason_from_notes(notes: &[String]) -> Option<String> {
    note_value(notes, "triage_reason").or_else(|| note_value(notes, "classification_reason"))
}

fn demotion_reason_from_notes(notes: &[String]) -> Option<String> {
    note_value(notes, "demotion_reason").or_else(|| note_value(notes, "non_production_reason"))
}

fn note_value(notes: &[String], key: &str) -> Option<String> {
    let equals_prefix = format!("{key}=");
    let colon_prefix = format!("{key}:");
    notes.iter().find_map(|note| {
        note.strip_prefix(&equals_prefix)
            .or_else(|| note.strip_prefix(&colon_prefix))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn validate_final_report_lifecycle_inputs(ctx: &NodeContext) -> anyhow::Result<()> {
    let severity_node = NodeId::from("severity-classification");
    let severity_dir = ctx.artifact_store.layout().artifact_dir(&severity_node);
    let findings_path = severity_dir.join("severity-classified-findings.json");
    let ledger_path = severity_dir.join(FINDING_LIFECYCLE_LEDGER_FILE);
    let findings = read_json_array_required(&findings_path, "severity-classified findings")?;
    if !ledger_path.exists() {
        recover_missing_final_report_lifecycle_inputs(ctx).map_err(|error| {
            anyhow::anyhow!(
                "failed to recover missing finding lifecycle ledger before final-report validation: {error}"
            )
        })?;
    }
    let ledger = read_lifecycle_ledger(&ledger_path)?;
    let mut records_by_key = BTreeMap::new();
    for record in &ledger.records {
        if records_by_key
            .insert(record.dedupe_key.as_str(), record)
            .is_some()
        {
            anyhow::bail!(
                "finding lifecycle ledger contains duplicate dedupe_key `{}`",
                record.dedupe_key
            );
        }
    }

    for (index, value) in findings.iter().enumerate() {
        let object = value.as_object().ok_or_else(|| {
            anyhow::anyhow!("severity-classified findings[{index}] must be a JSON object")
        })?;
        let dedupe_key = optional_json_string_field(object, "dedupe_key").ok_or_else(|| {
            anyhow::anyhow!(
                "severity-classified findings[{index}] is missing required `dedupe_key` for lifecycle matching"
            )
        })?;
        let record = records_by_key.get(dedupe_key).ok_or_else(|| {
            anyhow::anyhow!(
                "severity-classified finding `{dedupe_key}` has no lifecycle ledger record"
            )
        })?;
        validate_lifecycle_report_record(record)?;
        if let Some(severity) = severity_field(object)? {
            let canonical = record.canonical_severity.ok_or_else(|| {
                anyhow::anyhow!("lifecycle record `{dedupe_key}` is missing canonical severity")
            })?;
            if canonical != severity {
                anyhow::bail!(
                    "lifecycle record `{dedupe_key}` canonical severity `{canonical}` does not match severity-classified finding severity `{severity}`"
                );
            }
        }
    }

    for record in &ledger.records {
        validate_lifecycle_report_record(record)?;
    }
    Ok(())
}

fn validate_lifecycle_report_record(record: &FindingLifecycleRecord) -> anyhow::Result<()> {
    let mut missing = Vec::new();
    if record.source_artifacts.is_empty() {
        missing.push("source_artifacts");
    }
    if record.strategy_hits.is_empty() {
        missing.push("strategy_hits");
    }
    if record.triage_classification.is_none() {
        missing.push("triage_classification");
    }
    if record.triage_reason.is_none() {
        missing.push("triage_reason");
    }
    if record.final_disposition.is_none() {
        missing.push("final_disposition");
    }
    if record.final_disposition == Some(FindingFinalDisposition::Promoted)
        && record.canonical_severity.is_none()
    {
        missing.push("canonical_severity");
    }
    if matches!(
        record.final_disposition,
        Some(FindingFinalDisposition::NonProduction | FindingFinalDisposition::Dropped)
    ) && record.demotion_reason.is_none()
    {
        missing.push("demotion_reason");
    }
    for stage in [
        FindingLifecycleStage::Raw,
        FindingLifecycleStage::Deduped,
        FindingLifecycleStage::Triaged,
        FindingLifecycleStage::SeverityClassified,
    ] {
        if !record.stages.iter().any(|record| record.stage == stage) {
            missing.push(stage.as_str());
        }
    }
    if !missing.is_empty() {
        anyhow::bail!(
            "lifecycle record `{}` is missing required metadata: {}",
            record.dedupe_key,
            missing.join(", ")
        );
    }
    Ok(())
}

fn read_json_array_required(path: &Path, label: &str) -> anyhow::Result<Vec<Value>> {
    let value = read_json_value(path)?;
    value.as_array().cloned().ok_or_else(|| {
        anyhow::anyhow!("{label} artifact `{}` must be a JSON array", path.display())
    })
}

fn optional_json_string_field<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn severity_field(object: &serde_json::Map<String, Value>) -> anyhow::Result<Option<Severity>> {
    let Some(value) = optional_json_string_field(object, "severity")
        .or_else(|| optional_json_string_field(object, "severity_guess"))
    else {
        return Ok(None);
    };
    Severity::from_str(value).map(Some).map_err(|error| {
        anyhow::anyhow!("invalid severity in severity-classified finding: {error}")
    })
}

fn finding_status_counts(findings: &[Finding]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for finding in findings {
        *counts.entry(finding.status.to_string()).or_default() += 1;
    }
    counts
}

#[derive(Clone, Debug)]
struct ProjectDiscovery {
    framework: String,
    is_hardhat: bool,
    is_foundry: bool,
    has_foundry_toml: bool,
    hardhat_configs: Vec<PathBuf>,
    source_dirs: Vec<String>,
    production_source_dir: String,
    decisions: Vec<String>,
}

fn discover_project(repo: &Path) -> ProjectDiscovery {
    let hardhat_configs = [
        "hardhat.config.ts",
        "hardhat.config.js",
        "hardhat.config.cjs",
        "hardhat.config.mjs",
    ]
    .into_iter()
    .filter_map(|name| repo.join(name).exists().then_some(PathBuf::from(name)))
    .collect::<Vec<_>>();
    let has_hardhat_package = fs::read_to_string(repo.join("package.json"))
        .map(|contents| contents.contains("\"hardhat\""))
        .unwrap_or(false);
    let has_foundry_toml = repo.join("foundry.toml").exists();
    let is_hardhat = !hardhat_configs.is_empty() || has_hardhat_package;
    let is_foundry = has_foundry_toml || repo.join("lib/forge-std").exists();
    let framework = match (is_foundry, is_hardhat) {
        (true, true) => "mixed-foundry-hardhat",
        (true, false) => "foundry",
        (false, true) => "hardhat",
        (false, false) => "unknown",
    }
    .to_owned();
    let source_dirs = ["src", "contracts", "test", "tests", "script"]
        .into_iter()
        .filter(|name| repo.join(name).is_dir())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let production_source_dir = if repo.join("contracts").is_dir() {
        "contracts"
    } else if repo.join("src").is_dir() {
        "src"
    } else {
        ""
    }
    .to_owned();
    let decisions = match (is_foundry, is_hardhat) {
        (true, true) => vec![
            "Foundry and Hardhat markers found; treat the project as already Foundry-capable and retain the existing Foundry setup."
                .to_owned(),
            "Generated strategy tests still aggregate under test/foundry/.".to_owned(),
        ],
        (true, false) => {
            vec!["Foundry marker found; no migration work is required.".to_owned()]
        }
        (false, true) => vec![
            "Hardhat marker found; Foundry fuzzing setup should read production sources from contracts/ and write generated tests under test/foundry/."
                .to_owned(),
        ],
        (false, false) => vec![
            "No Hardhat or Foundry marker found; keep generated tests under test/foundry/."
                .to_owned(),
        ],
    };

    ProjectDiscovery {
        framework,
        is_hardhat,
        is_foundry,
        has_foundry_toml,
        hardhat_configs,
        source_dirs,
        production_source_dir,
        decisions,
    }
}

fn discover_property_specification_sources(repo: &Path) -> Vec<PathBuf> {
    let mut sources = BTreeSet::new();
    for name in [
        "README.md",
        "README",
        "WHITEPAPER.md",
        "Whitepaper.md",
        "whitepaper.md",
        "SPEC.md",
        "spec.md",
    ] {
        let path = repo.join(name);
        if path.is_file() {
            sources.insert(PathBuf::from(name));
        }
    }

    for dir in ["docs", "doc", "spec", "specs", "whitepaper", "whitepapers"] {
        collect_property_source_files(repo, Path::new(dir), 0, &mut sources);
    }

    sources.into_iter().collect()
}

fn collect_property_source_files(
    repo: &Path,
    relative_dir: &Path,
    depth: usize,
    sources: &mut BTreeSet<PathBuf>,
) {
    if depth > 3 || sources.len() >= 100 {
        return;
    }
    let dir = repo.join(relative_dir);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        if sources.len() >= 100 {
            return;
        }
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.starts_with('.') || matches!(name.as_ref(), "node_modules" | "target" | "dist") {
            continue;
        }

        let relative_path = relative_dir.join(file_name);
        let path = entry.path();
        if path.is_dir() {
            collect_property_source_files(repo, &relative_path, depth + 1, sources);
        } else if is_property_source_file(&relative_path) {
            sources.insert(relative_path);
        }
    }
}

fn is_property_source_file(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase());
    if matches!(
        extension.as_deref(),
        Some("md" | "markdown" | "txt" | "rst" | "adoc" | "pdf")
    ) {
        return true;
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    file_name.contains("whitepaper")
        || file_name.contains("spec")
        || file_name.contains("property")
        || file_name.contains("architecture")
}

fn ensure_hardhat_foundry_toml(path: &Path) -> anyhow::Result<()> {
    if !path.exists() {
        fs::write(path, default_hardhat_foundry_toml())?;
        return Ok(());
    }
    let updated = upsert_foundry_profile_defaults(&fs::read_to_string(path)?);
    fs::write(path, updated)?;
    Ok(())
}

fn default_hardhat_foundry_toml() -> &'static str {
    r#"[profile.default]
src = "contracts"
test = "test/foundry"
out = "out"
libs = ["node_modules", "lib"]
"#
}

fn upsert_foundry_profile_defaults(contents: &str) -> String {
    let mut out = Vec::new();
    let mut in_default = false;
    let mut saw_default = false;
    let mut saw_src = false;
    let mut saw_test = false;

    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            if in_default {
                flush_foundry_profile_defaults(&mut out, saw_src, saw_test);
                saw_src = false;
                saw_test = false;
            }
            in_default = trimmed == "[profile.default]";
            saw_default |= in_default;
        }

        if in_default && toml_key_is(trimmed, "src") {
            out.push("src = \"contracts\"".to_owned());
            saw_src = true;
            continue;
        }
        if in_default && toml_key_is(trimmed, "test") {
            out.push("test = \"test/foundry\"".to_owned());
            saw_test = true;
            continue;
        }
        out.push(line.to_owned());
    }

    if in_default {
        flush_foundry_profile_defaults(&mut out, saw_src, saw_test);
    }
    if !saw_default {
        if !out.is_empty() && !out.last().is_some_and(|line| line.is_empty()) {
            out.push(String::new());
        }
        out.push("[profile.default]".to_owned());
        out.push("src = \"contracts\"".to_owned());
        out.push("test = \"test/foundry\"".to_owned());
    }

    let mut updated = out.join("\n");
    updated.push('\n');
    updated
}

fn flush_foundry_profile_defaults(out: &mut Vec<String>, saw_src: bool, saw_test: bool) {
    if !saw_src {
        out.push("src = \"contracts\"".to_owned());
    }
    if !saw_test {
        out.push("test = \"test/foundry\"".to_owned());
    }
}

fn toml_key_is(trimmed_line: &str, expected: &str) -> bool {
    trimmed_line
        .split_once('=')
        .map(|(key, _)| key.trim() == expected)
        .unwrap_or(false)
}

#[derive(Clone, Debug)]
struct BaseTestDiscovery {
    base_test_path: Option<PathBuf>,
    analogous_paths: Vec<PathBuf>,
}

impl BaseTestDiscovery {
    fn preferred_shared_test_path(&self) -> Option<PathBuf> {
        self.base_test_path
            .clone()
            .or_else(|| self.analogous_paths.first().cloned())
    }
}

fn discover_base_tests(repo: &Path) -> anyhow::Result<BaseTestDiscovery> {
    let mut base_test_path = None;
    let mut analogous_paths = Vec::new();
    for root in ["test", "tests"] {
        let path = repo.join(root);
        if is_directory_no_symlink(&path)? {
            for file in solidity_files(&path)? {
                let relative = relative_path(repo, &file);
                let file_name = file
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default();
                let contents = fs::read_to_string(&file).unwrap_or_default();
                let is_base_test =
                    file_name == "BaseTest.t.sol" || contents.contains("contract BaseTest");
                let is_analogous = file_name == "Setup.t.sol"
                    || contents.contains("abstract contract Setup")
                    || contents.contains("abstract contract Deploy");
                if base_test_path.is_none() && is_base_test {
                    base_test_path = Some(relative.clone());
                }
                if is_analogous && !is_base_test {
                    analogous_paths.push(relative);
                }
            }
        }
    }
    analogous_paths.sort();
    analogous_paths.dedup();
    Ok(BaseTestDiscovery {
        base_test_path,
        analogous_paths,
    })
}

#[derive(Clone, Debug)]
struct GeneratedTestCollection {
    manifest_path: PathBuf,
    artifact_paths: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
struct WorkspaceChangeArtifacts {
    manifest_path: PathBuf,
    artifact_paths: Vec<PathBuf>,
}

#[derive(Clone, Debug, Default)]
struct WorkspaceChangeBaseline {
    files: BTreeMap<PathBuf, Vec<u8>>,
}

#[derive(Clone, Debug)]
struct GeneratedTestManifestEntry {
    artifact_path: PathBuf,
    source_relative_path: PathBuf,
    role: GeneratedTestManifestEntryRole,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GeneratedTestManifestEntryRole {
    Test,
    Support,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct FoundryGeneratedFiles {
    test_files: Vec<PathBuf>,
    support_files: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
struct GeneratedTestAggregationNode {
    strategy: StrategyId,
    attempt_index: usize,
    model_id: Option<ModelProfileId>,
    model: Option<String>,
    model_index: Option<usize>,
    loop_index: Option<usize>,
}

fn apply_dependency_workspace_changes(
    ctx: &NodeContext,
    workspace_path: &Path,
) -> anyhow::Result<()> {
    let dependencies = graph_dependency_map(&ctx.graph);
    let mut applied_paths = BTreeMap::new();
    let mut applied_manifests = BTreeSet::new();
    let mut conflicts = Vec::new();
    for dependency in &ctx.node.depends_on {
        for replay_dependency in dependency_workspace_replay_order(dependency, &dependencies)? {
            if !applied_manifests.insert(replay_dependency.clone()) {
                continue;
            }
            let dependency_artifact_dir =
                ctx.artifact_store.layout().artifact_dir(&replay_dependency);
            apply_workspace_change_manifest(
                &replay_dependency,
                &dependency_artifact_dir,
                workspace_path,
                &dependencies,
                &mut applied_paths,
                &mut conflicts,
            )?;
        }
    }
    if !conflicts.is_empty() {
        let artifact_dir = ctx.artifact_dir.clone();
        write_json_artifact(
            &artifact_dir,
            DEPENDENCY_WORKSPACE_CHANGE_CONFLICTS_FILE,
            &json!({
                "schema_version": "1.0",
                "node_id": ctx.node.id.to_string(),
                "conflicts": conflicts,
            }),
        )?;
    }
    Ok(())
}

fn apply_workspace_change_manifest(
    dependency: &NodeId,
    dependency_artifact_dir: &Path,
    workspace_path: &Path,
    graph_dependencies: &BTreeMap<NodeId, Vec<NodeId>>,
    applied_paths: &mut BTreeMap<PathBuf, NodeId>,
    conflicts: &mut Vec<Value>,
) -> anyhow::Result<usize> {
    let manifest_path = dependency_artifact_dir.join(WORKSPACE_CHANGES_MANIFEST);
    if !manifest_path.exists() {
        return Ok(0);
    }
    let manifest = read_json_value(&manifest_path)?;
    let mut applied = 0usize;
    for item in manifest
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(path) = item.get("path").and_then(Value::as_str) else {
            continue;
        };
        let Some(artifact_path) = item.get("artifact_path").and_then(Value::as_str) else {
            continue;
        };
        let relative = PathBuf::from(path);
        let artifact_relative = PathBuf::from(artifact_path);
        validate_artifact_relative_path(&relative)?;
        validate_artifact_relative_path(&artifact_relative)?;
        if !artifact_relative.starts_with(Path::new(WORKSPACE_CHANGES_DIR)) {
            anyhow::bail!(
                "workspace change artifact `{}` is outside `{}`",
                artifact_relative.display(),
                WORKSPACE_CHANGES_DIR
            );
        }
        let source = dependency_artifact_dir.join(&artifact_relative);
        if !is_regular_file_no_symlink(&source)? {
            continue;
        }
        if let Some(applied_dependency) = applied_paths.get(&relative) {
            if applied_dependency == dependency {
                continue;
            }
            if graph_node_depends_on(dependency, applied_dependency, graph_dependencies) {
                let destination = workspace_path.join(&relative);
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                ensure_copy_destination_not_symlink(&destination)?;
                fs::copy(source, destination)?;
                applied_paths.insert(relative, dependency.clone());
                applied += 1;
                continue;
            }
            if graph_node_depends_on(applied_dependency, dependency, graph_dependencies) {
                continue;
            }
            let destination = workspace_path.join(&relative);
            if files_have_identical_contents(&source, &destination)? {
                continue;
            }
            conflicts.push(json!({
                "path": relative.to_string_lossy(),
                "applied_dependency": applied_dependency.to_string(),
                "skipped_dependency": dependency.to_string(),
                "skipped_artifact_path": artifact_relative.to_string_lossy(),
            }));
            continue;
        }
        let destination = workspace_path.join(&relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        ensure_copy_destination_not_symlink(&destination)?;
        fs::copy(source, destination)?;
        applied_paths.insert(relative, dependency.clone());
        applied += 1;
    }
    Ok(applied)
}

fn files_have_identical_contents(left: &Path, right: &Path) -> anyhow::Result<bool> {
    if !is_regular_file_no_symlink(left)? || !is_regular_file_no_symlink(right)? {
        return Ok(false);
    }
    if fs::metadata(left)?.len() != fs::metadata(right)?.len() {
        return Ok(false);
    }
    Ok(fs::read(left)? == fs::read(right)?)
}

fn graph_dependency_map(graph: &CampaignGraph) -> BTreeMap<NodeId, Vec<NodeId>> {
    graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node.depends_on.clone()))
        .collect()
}

fn dependency_workspace_replay_order(
    dependency: &NodeId,
    graph_dependencies: &BTreeMap<NodeId, Vec<NodeId>>,
) -> anyhow::Result<Vec<NodeId>> {
    let mut order = Vec::new();
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    collect_dependency_workspace_replay_order(
        dependency,
        graph_dependencies,
        &mut visiting,
        &mut visited,
        &mut order,
    )?;
    Ok(order)
}

fn collect_dependency_workspace_replay_order(
    dependency: &NodeId,
    graph_dependencies: &BTreeMap<NodeId, Vec<NodeId>>,
    visiting: &mut BTreeSet<NodeId>,
    visited: &mut BTreeSet<NodeId>,
    order: &mut Vec<NodeId>,
) -> anyhow::Result<()> {
    if visited.contains(dependency) {
        return Ok(());
    }
    if !visiting.insert(dependency.clone()) {
        anyhow::bail!("dependency graph contains a cycle at `{dependency}`");
    }
    for parent in graph_dependencies.get(dependency).into_iter().flatten() {
        collect_dependency_workspace_replay_order(
            parent,
            graph_dependencies,
            visiting,
            visited,
            order,
        )?;
    }
    visiting.remove(dependency);
    visited.insert(dependency.clone());
    order.push(dependency.clone());
    Ok(())
}

fn graph_node_depends_on(
    node: &NodeId,
    candidate_dependency: &NodeId,
    graph_dependencies: &BTreeMap<NodeId, Vec<NodeId>>,
) -> bool {
    let mut visiting = BTreeSet::new();
    graph_node_depends_on_inner(
        node,
        candidate_dependency,
        graph_dependencies,
        &mut visiting,
    )
}

fn graph_node_depends_on_inner(
    node: &NodeId,
    candidate_dependency: &NodeId,
    graph_dependencies: &BTreeMap<NodeId, Vec<NodeId>>,
    visiting: &mut BTreeSet<NodeId>,
) -> bool {
    if !visiting.insert(node.clone()) {
        return false;
    }
    graph_dependencies
        .get(node)
        .into_iter()
        .flatten()
        .any(|dependency| {
            dependency == candidate_dependency
                || graph_node_depends_on_inner(
                    dependency,
                    candidate_dependency,
                    graph_dependencies,
                    visiting,
                )
        })
}

fn persist_workspace_changes(
    workspace_path: &Path,
    target_repo: &Path,
    artifact_dir: &Path,
    baseline: &WorkspaceChangeBaseline,
) -> anyhow::Result<WorkspaceChangeArtifacts> {
    let mut records = Vec::new();
    let mut artifact_paths = Vec::new();
    let relative_paths = if same_canonical_path(workspace_path, target_repo) {
        Vec::new()
    } else {
        changed_workspace_files(workspace_path, target_repo)?
    };

    for relative in relative_paths {
        let source = workspace_path.join(&relative);
        if !is_regular_file_no_symlink(&source)? {
            continue;
        }
        if baseline.matches_current_file(&relative, &source)? {
            continue;
        }
        let artifact_relative = Path::new(WORKSPACE_CHANGES_DIR).join(&relative);
        let destination = artifact_dir.join(&artifact_relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        ensure_copy_destination_not_symlink(&destination)?;
        fs::copy(&source, &destination)?;
        let bytes = fs::metadata(&destination)?.len();
        records.push(json!({
            "path": relative.to_string_lossy(),
            "artifact_path": artifact_relative.to_string_lossy(),
            "bytes": bytes,
        }));
        artifact_paths.push(destination);
    }

    let manifest_path = write_json_artifact(
        artifact_dir,
        WORKSPACE_CHANGES_MANIFEST,
        &json!({
            "schema_version": "1.0",
            "files": records,
        }),
    )?;
    Ok(WorkspaceChangeArtifacts {
        manifest_path,
        artifact_paths,
    })
}

impl WorkspaceChangeBaseline {
    fn matches_current_file(&self, relative: &Path, source: &Path) -> anyhow::Result<bool> {
        let Some(baseline_bytes) = self.files.get(relative) else {
            return Ok(false);
        };
        Ok(fs::read(source)? == *baseline_bytes)
    }
}

fn workspace_change_baseline_after_dependencies(
    workspace_path: &Path,
    target_repo: &Path,
) -> anyhow::Result<WorkspaceChangeBaseline> {
    let mut files = BTreeMap::new();
    if same_canonical_path(workspace_path, target_repo) {
        return Ok(WorkspaceChangeBaseline { files });
    }
    for relative in changed_workspace_files(workspace_path, target_repo)? {
        let source = workspace_path.join(&relative);
        if is_regular_file_no_symlink(&source)? {
            files.insert(relative, fs::read(source)?);
        }
    }
    Ok(WorkspaceChangeBaseline { files })
}

fn changed_workspace_files(
    workspace_path: &Path,
    target_repo: &Path,
) -> anyhow::Result<Vec<PathBuf>> {
    let output = command_output(
        "git",
        vec![
            "-C".to_owned(),
            repo_string(workspace_path),
            "status".to_owned(),
            "--porcelain=v1".to_owned(),
            "-z".to_owned(),
            "--untracked-files=all".to_owned(),
        ],
    );
    if let Ok(output) = output {
        if output.status_success {
            let mut paths =
                expand_git_status_paths(workspace_path, parse_git_status_paths(&output.stdout))?;
            paths.retain(|path| {
                validate_artifact_relative_path(path).is_ok()
                    && !should_skip_workspace_snapshot_path(path)
            });
            paths.sort();
            paths.dedup();
            return Ok(paths);
        }
    }
    fallback_workspace_changed_files(workspace_path, target_repo)
}

fn parse_git_status_paths(output: &str) -> Vec<PathBuf> {
    let parts = output
        .split('\0')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let mut paths = Vec::new();
    let mut index = 0usize;
    while index < parts.len() {
        let record = parts[index];
        index += 1;
        if record.len() < 4 {
            continue;
        }
        let status = &record[..2];
        let mut path = &record[3..];
        if status.starts_with('R') || status.starts_with('C') {
            if let Some(new_path) = parts.get(index) {
                path = new_path;
                index += 1;
            }
        }
        if status.contains('D') {
            continue;
        }
        paths.push(PathBuf::from(path));
    }
    paths
}

fn expand_git_status_paths(
    workspace_path: &Path,
    paths: Vec<PathBuf>,
) -> anyhow::Result<Vec<PathBuf>> {
    let mut expanded = Vec::new();
    for path in paths {
        let source = workspace_path.join(&path);
        if is_directory_no_symlink(&source)? {
            let submodule_paths = changed_submodule_files(workspace_path, &path)?;
            if !submodule_paths.is_empty() {
                expanded.extend(submodule_paths);
                continue;
            }
        }
        expanded.push(path);
    }
    Ok(expanded)
}

fn changed_submodule_files(
    workspace_path: &Path,
    submodule_path: &Path,
) -> anyhow::Result<Vec<PathBuf>> {
    let submodule_root = workspace_path.join(submodule_path);
    let output = command_output(
        "git",
        vec![
            "-C".to_owned(),
            repo_string(&submodule_root),
            "status".to_owned(),
            "--porcelain=v1".to_owned(),
            "-z".to_owned(),
            "--untracked-files=all".to_owned(),
        ],
    );
    let Ok(output) = output else {
        return Ok(Vec::new());
    };
    if !output.status_success {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for relative in parse_git_status_paths(&output.stdout) {
        if validate_artifact_relative_path(&relative).is_err()
            || should_skip_workspace_snapshot_path(&relative)
        {
            continue;
        }
        let combined = submodule_path.join(relative);
        validate_artifact_relative_path(&combined)?;
        paths.push(combined);
    }
    Ok(paths)
}

fn fallback_workspace_changed_files(
    workspace_path: &Path,
    target_repo: &Path,
) -> anyhow::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    collect_workspace_changed_files(workspace_path, target_repo, workspace_path, &mut paths)?;
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn collect_workspace_changed_files(
    workspace_root: &Path,
    target_repo: &Path,
    path: &Path,
    paths: &mut Vec<PathBuf>,
) -> anyhow::Result<()> {
    if should_skip_walk_path(path) {
        return Ok(());
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    if file_type.is_dir() {
        for entry in fs::read_dir(path)? {
            collect_workspace_changed_files(workspace_root, target_repo, &entry?.path(), paths)?;
        }
    } else if file_type.is_file() {
        let relative = relative_path(workspace_root, path);
        validate_artifact_relative_path(&relative)?;
        if !should_skip_workspace_snapshot_path(&relative)
            && workspace_file_differs_from_target(workspace_root, target_repo, &relative)?
        {
            paths.push(relative);
        }
    }
    Ok(())
}

fn should_skip_workspace_snapshot_path(path: &Path) -> bool {
    if should_skip_generated_coverage_snapshot_path(path) {
        return true;
    }

    path.components().any(|component| {
        component.as_os_str().to_str().is_some_and(|name| {
            matches!(
                name,
                ".git"
                    | ".ultrafuzz"
                    | "node_modules"
                    | "out"
                    | "cache"
                    | "cache_forge"
                    | "broadcast"
            )
        })
    })
}

fn should_skip_generated_coverage_snapshot_path(path: &Path) -> bool {
    let Some(components) = path
        .iter()
        .map(|component| component.to_str())
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };

    match components.as_slice() {
        [".recon", ..] => true,
        ["recon-coverage.json"] => true,
        ["magic", "recon-coverage.json"] => true,
        ["echidna", "coverage", ..]
        | ["echidna", "build-snapshot", ..]
        | ["echidna", "corpus", ..]
        | ["echidna", "reproducers", ..] => true,
        ["echidna", file_name]
            if file_name.starts_with("covered.")
                && (file_name.ends_with(".lcov") || file_name.ends_with(".html")) =>
        {
            true
        }
        _ => false,
    }
}

fn collect_generated_tests_from_workspace(
    workspace_path: &Path,
    target_repo: &Path,
    artifact_dir: &Path,
    node_id: &NodeId,
    attempt: AttemptNodeRef<'_>,
    model: Option<&str>,
) -> anyhow::Result<GeneratedTestCollection> {
    let changed_files =
        changed_foundry_test_artifacts(workspace_path, target_repo, attempt.strategy)?;
    let generated_root = artifact_dir.join("generated-tests");
    let mut artifact_paths = Vec::new();
    let mut records = Vec::new();
    let mut support_records = Vec::new();

    for relative in changed_files.test_files {
        if let Some(record) = copy_generated_workspace_file(
            workspace_path,
            artifact_dir,
            relative,
            &mut artifact_paths,
        )? {
            records.push(record);
        }
    }

    for relative in changed_files.support_files {
        if let Some(record) = copy_generated_workspace_file(
            workspace_path,
            artifact_dir,
            relative,
            &mut artifact_paths,
        )? {
            support_records.push(record);
        }
    }

    if !generated_root.exists() {
        fs::create_dir_all(&generated_root)?;
    }
    let manifest_path = write_json_artifact(
        artifact_dir,
        "generated-tests.json",
        &json!({
            "schema_version": "1.0",
            "node_id": node_id,
            "strategy": attempt.strategy,
            "attempt_index": attempt.attempt_index,
            "model_id": attempt.model_id,
            "model": model,
            "model_index": attempt.model_index,
            "loop_index": attempt.loop_index,
            "test_files": records,
            "support_files": support_records,
        }),
    )?;
    Ok(GeneratedTestCollection {
        manifest_path,
        artifact_paths,
    })
}

fn copy_generated_workspace_file(
    workspace_path: &Path,
    artifact_dir: &Path,
    relative: PathBuf,
    artifact_paths: &mut Vec<PathBuf>,
) -> anyhow::Result<Option<Value>> {
    let source = workspace_path.join(&relative);
    if !is_regular_file_no_symlink(&source)? {
        return Ok(None);
    }
    let artifact_relative = Path::new("generated-tests").join(&relative);
    let destination = artifact_dir.join(&artifact_relative);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    ensure_copy_destination_not_symlink(&destination)?;
    fs::copy(&source, &destination)?;
    let bytes = fs::metadata(&destination)?.len();
    artifact_paths.push(destination);
    Ok(Some(json!({
        "source_relative_path": relative,
        "artifact_path": artifact_relative,
        "bytes": bytes,
    })))
}

fn generated_test_aggregation_context(
    ctx: &NodeContext,
    node: &Node,
) -> Option<GeneratedTestAggregationNode> {
    match &node.kind {
        NodeKind::AgentAttempt {
            strategy,
            attempt_index,
            model_id,
            model_index,
            loop_index,
            ..
        } => Some(GeneratedTestAggregationNode {
            strategy: strategy.clone(),
            attempt_index: *attempt_index,
            model_id: Some(model_id.clone()),
            model: ctx
                .resolved_config
                .model_profile(model_id)
                .and_then(|profile| profile.model.clone()),
            model_index: Some(*model_index),
            loop_index: Some(*loop_index),
        }),
        NodeKind::Agentic {
            logical_id,
            attempt_index,
            ..
        } => {
            let model_id = ctx.resolved_config.models.default.clone();
            Some(GeneratedTestAggregationNode {
                strategy: StrategyId::from(logical_id.to_string()),
                attempt_index: *attempt_index,
                model: ctx
                    .resolved_config
                    .model_profile(&model_id)
                    .and_then(|profile| profile.model.clone()),
                model_id: Some(model_id),
                model_index: Some(0),
                loop_index: Some(*attempt_index),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
fn changed_foundry_tests(
    workspace_path: &Path,
    target_repo: &Path,
    strategy: &StrategyId,
) -> anyhow::Result<Vec<PathBuf>> {
    Ok(changed_foundry_test_artifacts(workspace_path, target_repo, strategy)?.test_files)
}

fn changed_foundry_test_artifacts(
    workspace_path: &Path,
    target_repo: &Path,
    strategy: &StrategyId,
) -> anyhow::Result<FoundryGeneratedFiles> {
    let test_dirs = foundry_test_dirs_for_strategy(strategy);
    let mut args = vec![
        "-C".to_owned(),
        repo_string(workspace_path),
        "status".to_owned(),
        "--porcelain=v1".to_owned(),
        "-z".to_owned(),
        "--untracked-files=all".to_owned(),
        "--".to_owned(),
    ];
    args.extend(
        test_dirs
            .iter()
            .map(|path| path.to_string_lossy().into_owned()),
    );
    let output = match command_output("git", args) {
        Ok(output) if output.status_success => output,
        Ok(_) | Err(_) => {
            return fallback_foundry_test_artifacts(workspace_path, target_repo, strategy);
        }
    };

    let parts = output
        .stdout
        .split('\0')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let mut paths = FoundryGeneratedFiles::default();
    let mut index = 0usize;
    while index < parts.len() {
        let record = parts[index];
        index += 1;
        if record.len() < 4 {
            continue;
        }
        let status = &record[..2];
        let mut path = &record[3..];
        if status.starts_with('R') || status.starts_with('C') {
            if let Some(new_path) = parts.get(index) {
                path = new_path;
                index += 1;
            }
        }
        if status.contains('D') {
            continue;
        }
        let relative = PathBuf::from(path);
        push_foundry_generated_path(&mut paths, relative);
    }
    sort_foundry_generated_files(&mut paths);
    Ok(paths)
}

fn foundry_test_dirs_for_strategy(strategy: &StrategyId) -> Vec<PathBuf> {
    let mut dirs = vec![Path::new("test").join("foundry").join(strategy.as_str())];
    if uses_differential_test_tree(strategy) {
        dirs.push(Path::new("test").join("foundry").join("differential"));
    }
    if matches!(
        strategy.as_str(),
        STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID | STATEFUL_INVARIANT_RECON_CAMPAIGN_ID
    ) {
        dirs.extend([
            Path::new("test").join("foundry").join("invariants"),
            Path::new("test")
                .join("foundry")
                .join("stateful-invariants"),
            Path::new("test").join("invariants"),
            Path::new("test").join("recon"),
            Path::new("test").join("chimera"),
        ]);
    }
    dirs
}

fn uses_differential_test_tree(strategy: &StrategyId) -> bool {
    matches!(
        strategy.as_str(),
        "differential-lane-author" | "reference-harness-author"
    )
}

fn fallback_foundry_test_artifacts(
    workspace_path: &Path,
    target_repo: &Path,
    strategy: &StrategyId,
) -> anyhow::Result<FoundryGeneratedFiles> {
    let mut paths = FoundryGeneratedFiles::default();
    for relative_root in foundry_test_dirs_for_strategy(strategy) {
        let root = workspace_path.join(relative_root);
        if !is_directory_no_symlink(&root)? {
            continue;
        }
        for path in solidity_files(&root)? {
            let relative = relative_path(workspace_path, &path);
            if workspace_file_differs_from_target(workspace_path, target_repo, &relative)? {
                push_foundry_generated_path(&mut paths, relative);
            }
        }
    }
    sort_foundry_generated_files(&mut paths);
    Ok(paths)
}

fn push_foundry_generated_path(paths: &mut FoundryGeneratedFiles, relative: PathBuf) {
    if validate_artifact_relative_path(&relative).is_err() {
        return;
    }
    if is_foundry_test_file(&relative) {
        paths.test_files.push(relative);
    } else if is_foundry_support_file(&relative) {
        paths.support_files.push(relative);
    }
}

fn sort_foundry_generated_files(paths: &mut FoundryGeneratedFiles) {
    paths.test_files.sort();
    paths.test_files.dedup();
    paths.support_files.sort();
    paths.support_files.dedup();
}

fn workspace_file_differs_from_target(
    workspace_path: &Path,
    target_repo: &Path,
    relative_path: &Path,
) -> anyhow::Result<bool> {
    let workspace_file = workspace_path.join(relative_path);
    let target_file = target_repo.join(relative_path);
    if !is_regular_file_no_symlink(&workspace_file)? {
        return Ok(false);
    }
    if same_canonical_path(&workspace_file, &target_file)
        || !is_regular_file_no_symlink(&target_file)?
    {
        return Ok(true);
    }
    Ok(fs::read(workspace_file)? != fs::read(target_file)?)
}

fn read_generated_tests_manifest(
    attempt_artifact_dir: &Path,
) -> anyhow::Result<Vec<GeneratedTestManifestEntry>> {
    let path = attempt_artifact_dir.join("generated-tests.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let value = read_json_value(path)?;
    let mut entries = Vec::new();
    read_generated_tests_manifest_entries(
        &value,
        "test_files",
        GeneratedTestManifestEntryRole::Test,
        &mut entries,
    )?;
    read_generated_tests_manifest_entries(
        &value,
        "support_files",
        GeneratedTestManifestEntryRole::Support,
        &mut entries,
    )?;
    Ok(entries)
}

fn read_generated_tests_manifest_entries(
    value: &Value,
    field: &str,
    role: GeneratedTestManifestEntryRole,
    entries: &mut Vec<GeneratedTestManifestEntry>,
) -> anyhow::Result<()> {
    for item in value
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(artifact_path) = item.get("artifact_path").and_then(Value::as_str) else {
            continue;
        };
        let Some(source_relative_path) = item.get("source_relative_path").and_then(Value::as_str)
        else {
            continue;
        };
        let artifact_path = PathBuf::from(artifact_path);
        let source_relative_path = PathBuf::from(source_relative_path);
        validate_artifact_relative_path(&artifact_path)?;
        validate_artifact_relative_path(&source_relative_path)?;
        entries.push(GeneratedTestManifestEntry {
            artifact_path,
            source_relative_path,
            role,
        });
    }
    Ok(())
}

fn aggregated_test_path(
    strategy: &StrategyId,
    attempt_index: usize,
    source_relative_path: &Path,
) -> PathBuf {
    let aggregation_root = aggregation_test_root(strategy, source_relative_path);
    let strategy_root = Path::new("test").join("foundry").join(&aggregation_root);
    let attempt_segment = format!("attempt-{attempt_index}");
    let attempt_root = strategy_root.join(&attempt_segment);
    let inner_path = source_relative_path
        .strip_prefix(&attempt_root)
        .or_else(|_| source_relative_path.strip_prefix(&strategy_root))
        .unwrap_or(source_relative_path);
    let inner_path = if inner_path.as_os_str().is_empty() {
        PathBuf::from(
            source_relative_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Generated.t.sol"),
        )
    } else {
        inner_path.to_path_buf()
    };
    Path::new("test")
        .join("foundry")
        .join(aggregation_root)
        .join(attempt_segment)
        .join(sanitize_relative_path(&inner_path))
}

fn aggregation_test_root(strategy: &StrategyId, source_relative_path: &Path) -> String {
    if uses_differential_test_tree(strategy)
        && source_relative_path.starts_with(Path::new("test").join("foundry").join("differential"))
    {
        "differential".to_owned()
    } else {
        strategy.as_str().to_owned()
    }
}

fn unique_aggregated_test_path(
    target_repo: &Path,
    strategy: &StrategyId,
    attempt_index: usize,
    source_relative_path: &Path,
    used_destinations: &mut BTreeSet<PathBuf>,
) -> PathBuf {
    let base_path = aggregated_test_path(strategy, attempt_index, source_relative_path);
    if reserve_aggregation_destination(target_repo, &base_path, used_destinations) {
        return base_path;
    }

    for collision_index in 2.. {
        let candidate = append_collision_suffix(&base_path, collision_index);
        if reserve_aggregation_destination(target_repo, &candidate, used_destinations) {
            return candidate;
        }
    }
    unreachable!("unbounded collision suffix loop must return")
}

fn reserve_aggregation_destination(
    target_repo: &Path,
    relative_path: &Path,
    used_destinations: &mut BTreeSet<PathBuf>,
) -> bool {
    if target_repo.join(relative_path).exists() {
        used_destinations.insert(relative_path.to_path_buf());
        return false;
    }
    used_destinations.insert(relative_path.to_path_buf())
}

fn append_collision_suffix(path: &Path, collision_index: usize) -> PathBuf {
    let mut candidate = path.to_path_buf();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Generated.t.sol");
    let suffixed = if let Some(stem) = file_name.strip_suffix(".t.sol") {
        format!("{stem}-{collision_index}.t.sol")
    } else if let Some((stem, extension)) = file_name.rsplit_once('.') {
        format!("{stem}-{collision_index}.{extension}")
    } else {
        format!("{file_name}-{collision_index}")
    };
    candidate.set_file_name(suffixed);
    candidate
}

fn sanitize_relative_path(path: &Path) -> PathBuf {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => part.to_str().map(sanitize_file_name),
            _ => None,
        })
        .collect()
}

fn is_foundry_test_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".t.sol"))
}

fn is_foundry_support_file(path: &Path) -> bool {
    !is_foundry_test_file(path)
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension == "sol")
}

fn sanitize_file_name(file_name: &str) -> String {
    let sanitized = file_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "Generated.t.sol".to_owned()
    } else {
        sanitized
    }
}

fn solidity_files(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_solidity_files(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_solidity_files(path: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    if should_skip_walk_path(path) {
        return Ok(());
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    if file_type.is_dir() {
        for entry in fs::read_dir(path)? {
            collect_solidity_files(&entry?.path(), files)?;
        }
    } else if file_type.is_file()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".sol"))
    {
        files.push(path.to_path_buf());
    }
    Ok(())
}

fn should_skip_walk_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                ".git"
                    | ".ultrafuzz"
                    | "node_modules"
                    | "out"
                    | "cache"
                    | "cache_forge"
                    | "broadcast"
            )
        })
}

fn relative_path(root: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(root).unwrap_or(path).to_path_buf()
}

fn validate_artifact_relative_path(path: &Path) -> anyhow::Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        anyhow::bail!("path `{}` must be non-empty and relative", path.display());
    }
    for component in path.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            anyhow::bail!(
                "path `{}` may not contain root or traversal components",
                path.display()
            );
        }
    }
    Ok(())
}

fn git_status_short(repo: &Path) -> anyhow::Result<String> {
    command_output(
        "git",
        vec![
            "-C".to_owned(),
            repo_string(repo),
            "status".to_owned(),
            "--short".to_owned(),
        ],
    )
    .and_then(|output| {
        if output.status_success {
            Ok(output.stdout)
        } else {
            anyhow::bail!("git status failed: {}", output.stderr.trim())
        }
    })
}

fn git_status_index(repo: &Path) -> anyhow::Result<String> {
    command_output(
        "git",
        vec![
            "-C".to_owned(),
            repo_string(repo),
            "diff".to_owned(),
            "--cached".to_owned(),
            "--name-only".to_owned(),
        ],
    )
    .and_then(|output| {
        if output.status_success {
            Ok(output.stdout)
        } else {
            anyhow::bail!("git diff --cached failed: {}", output.stderr.trim())
        }
    })
}

fn git_permalink_base(repo: &Path) -> anyhow::Result<String> {
    let remote = command_output(
        "git",
        vec![
            "-C".to_owned(),
            repo_string(repo),
            "config".to_owned(),
            "--get".to_owned(),
            "remote.origin.url".to_owned(),
        ],
    )
    .and_then(|output| {
        if output.status_success {
            Ok(output.stdout.trim().to_owned())
        } else {
            anyhow::bail!("git remote lookup failed: {}", output.stderr.trim())
        }
    })?;
    let remote = normalize_git_remote_url(&remote)
        .ok_or_else(|| anyhow::anyhow!("unsupported git remote URL `{remote}`"))?;
    let head = command_output(
        "git",
        vec![
            "-C".to_owned(),
            repo_string(repo),
            "rev-parse".to_owned(),
            "HEAD".to_owned(),
        ],
    )
    .and_then(|output| {
        if output.status_success {
            Ok(output.stdout.trim().to_owned())
        } else {
            anyhow::bail!("git rev-parse HEAD failed: {}", output.stderr.trim())
        }
    })?;

    Ok(format!("{remote}/blob/{head}"))
}

fn normalize_git_remote_url(remote: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches(".git");
    if remote.starts_with("https://") || remote.starts_with("http://") {
        return Some(remote.to_owned());
    }
    if let Some(rest) = remote.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return Some(format!("https://{host}/{}", path.trim_start_matches('/')));
    }
    if let Some(rest) = remote.strip_prefix("ssh://git@") {
        let (host, path) = rest.split_once('/')?;
        return Some(format!("https://{host}/{}", path.trim_start_matches('/')));
    }
    None
}

fn url_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => {
                Some(percent_encode_path_segment(&part.to_string_lossy()))
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn percent_encode_path_segment(segment: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::new();
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

fn read_json_value(path: impl AsRef<Path>) -> anyhow::Result<Value> {
    Ok(serde_json::from_slice(&read_bounded_json_bytes(
        path.as_ref(),
    )?)?)
}

fn read_bounded_json_bytes(path: &Path) -> anyhow::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        anyhow::bail!("JSON artifact `{}` is not a regular file", path.display());
    }
    let bytes = metadata.len();
    if bytes > MAX_AGENT_JSON_BYTES {
        anyhow::bail!(
            "JSON artifact `{}` is {bytes} bytes, above the maximum {MAX_AGENT_JSON_BYTES}",
            path.display()
        );
    }
    Ok(fs::read(path)?)
}

#[derive(Clone, Debug)]
struct ProcessOutput {
    status_success: bool,
    stdout: String,
    stderr: String,
}

fn command_output(command: &str, args: Vec<String>) -> anyhow::Result<ProcessOutput> {
    let mut process = Command::new(command);
    let args = if command == "git" {
        hardened_git_args(args)
    } else {
        args
    };
    process
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if command == "git" {
        configure_hardened_git_env(&mut process);
    }
    let mut child = process.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("failed to capture command stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("failed to capture command stderr"))?;
    let stdout_handle = drain_child_pipe(stdout);
    let stderr_handle = drain_child_pipe(stderr);
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let stdout = read_drained_child_pipe(stdout_handle, "stdout")?;
            let stderr = read_drained_child_pipe(stderr_handle, "stderr")?;
            return Ok(ProcessOutput {
                status_success: status.success(),
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            });
        }
        if started.elapsed() >= GIT_COMMAND_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let stdout = read_drained_child_pipe(stdout_handle, "stdout")?;
            let stderr = read_drained_child_pipe(stderr_handle, "stderr")?;
            let timeout_detail = if stderr.is_empty() { &stdout } else { &stderr };
            anyhow::bail!(
                "command `{command}` timed out after {:?}: {}",
                GIT_COMMAND_TIMEOUT,
                String::from_utf8_lossy(timeout_detail).trim()
            );
        }
        thread::sleep(COMMAND_OUTPUT_POLL_INTERVAL);
    }
}

fn drain_child_pipe<R>(mut reader: R) -> thread::JoinHandle<io::Result<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        Ok(bytes)
    })
}

fn read_drained_child_pipe(
    handle: thread::JoinHandle<io::Result<Vec<u8>>>,
    stream: &str,
) -> anyhow::Result<Vec<u8>> {
    handle
        .join()
        .map_err(|_| anyhow::anyhow!("failed to join command {stream} reader"))?
        .map_err(|error| anyhow::anyhow!("failed to read command {stream}: {error}"))
}

fn hardened_git_args(args: Vec<String>) -> Vec<String> {
    let mut hardened = vec![
        "-c".to_owned(),
        "core.fsmonitor=false".to_owned(),
        "-c".to_owned(),
        "core.pager=cat".to_owned(),
        "-c".to_owned(),
        "pager.status=false".to_owned(),
        "-c".to_owned(),
        "pager.diff=false".to_owned(),
        "-c".to_owned(),
        "diff.external=".to_owned(),
    ];
    hardened.extend(args);
    hardened
}

fn configure_hardened_git_env(command: &mut Command) {
    command.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    command
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .env("LC_ALL", "C");
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn current_epoch_ms() -> u64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    duration
        .as_secs()
        .saturating_mul(1_000)
        .saturating_add(u64::from(duration.subsec_millis()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };
    use ultrafuzz_config::{resolve_config_from_toml, CliOverrides, EnvOverrides};
    use ultrafuzz_events::{JsonlEventSink, NullEventSink};
    use ultrafuzz_topology::{
        build_campaign_graph_from_topology, LoopMode, MetaNodeRole, ProjectTopology, TopologyNode,
        TopologyNodeKind, FINISH_NODE_ID, START_NODE_ID, TOPOLOGY_VERSION,
    };

    fn config(toml: &str) -> CampaignConfig {
        resolve_config_from_toml(
            Some(toml),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap()
    }

    fn write_executable_script(path: &Path, contents: &str) {
        fs::write(path, contents).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    fn run_git_for_test<const N: usize>(repo: &Path, args: [&str; N]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert_git_success(output);
    }

    fn assert_git_success(output: std::process::Output) {
        assert!(
            output.status.success(),
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn agentic_node(id: &str, logical_id: &str, depends_on: &[&str], retry: RetryPolicy) -> Node {
        let node_id = NodeId::from(id);
        Node {
            id: node_id.clone(),
            label: id.replace('-', " "),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from(logical_id),
                prompt_path: PathBuf::from(format!("{logical_id}.md")),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
            timeout: None,
            retry,
            artifact_dir: PathBuf::from("artifacts").join(id),
        }
    }

    fn agentic_node_with_required_artifact(
        id: &str,
        logical_id: &str,
        required_artifact: &str,
        retry: RetryPolicy,
    ) -> Node {
        let mut node = agentic_node(id, logical_id, &[], retry);
        if let NodeKind::Agentic {
            required_artifacts,
            primary_artifact,
            ..
        } = &mut node.kind
        {
            let artifact = PathBuf::from(required_artifact);
            required_artifacts.push(artifact.clone());
            *primary_artifact = Some(artifact);
        }
        node
    }

    fn meta_node(role: MetaNodeRole, depends_on: &[&str]) -> Node {
        let node_id = NodeId::from(role.canonical_id());
        Node {
            id: node_id.clone(),
            label: role.label().to_owned(),
            kind: NodeKind::Meta { role },
            depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts").join(node_id.as_str()),
        }
    }

    fn test_graph(run_id: &str, nodes: Vec<Node>) -> CampaignGraph {
        CampaignGraph {
            run_id: RunId::from(run_id),
            graph_version: ultrafuzz_topology::GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes,
        }
    }

    fn assert_run_succeeded(result: &RunResult, layout: &ultrafuzz_artifacts::RunLayout) {
        if result.status == RunStatus::Succeeded {
            return;
        }
        let details = RunStateStore::for_run_root(&layout.root)
            .load()
            .map(|state| {
                state
                    .nodes
                    .values()
                    .filter(|node| {
                        matches!(
                            node.status,
                            NodeStatus::Failed | NodeStatus::TimedOut | NodeStatus::Skipped
                        )
                    })
                    .map(|node| {
                        format!(
                            "{}={:?}:{}",
                            node.node_id,
                            node.status,
                            node.last_error.as_deref().unwrap_or("no error")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_else(|error| format!("failed to load state: {error}"));
        panic!(
            "expected run to succeed, got {:?}; node details: {}",
            result.status, details
        );
    }

    #[test]
    fn persist_workspace_changes_skips_symlink_sources() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let target = temp.path().join("target");
        let artifacts = temp.path().join("artifacts");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&artifacts).unwrap();
        fs::write(workspace.join("Real.t.sol"), "contract Real {}\n").unwrap();
        fs::write(temp.path().join("secret.txt"), "do not copy\n").unwrap();
        symlink(temp.path().join("secret.txt"), workspace.join("Leak.t.sol")).unwrap();

        let changes = persist_workspace_changes(
            &workspace,
            &target,
            &artifacts,
            &WorkspaceChangeBaseline::default(),
        )
        .unwrap();
        let manifest = read_json_value(&changes.manifest_path).unwrap();
        let files = manifest["files"].as_array().unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "Real.t.sol");
        assert!(artifacts
            .join(WORKSPACE_CHANGES_DIR)
            .join("Real.t.sol")
            .is_file());
        assert!(!artifacts
            .join(WORKSPACE_CHANGES_DIR)
            .join("Leak.t.sol")
            .exists());
    }

    #[test]
    fn workspace_snapshot_skips_generated_fuzzer_outputs() {
        for path in [
            ".recon/session.json",
            "recon-coverage.json",
            "magic/recon-coverage.json",
            "echidna/coverage/123.txt",
            "echidna/build-snapshot/compiled.json",
            "echidna/corpus/seed.json",
            "echidna/reproducers/failure.json",
            "echidna/covered.123.lcov",
            "echidna/covered.123.html",
            "cache_forge/solidity-files-cache.json",
            "nested/cache_forge/solidity-files-cache.json",
        ] {
            assert!(
                should_skip_workspace_snapshot_path(Path::new(path)),
                "`{path}` should be treated as generated coverage output"
            );
        }

        assert!(
            should_skip_walk_path(Path::new("cache_forge")),
            "`cache_forge` should be pruned during generated test collection"
        );

        for path in [
            "echidna.yaml",
            "echidna/custom-config.yaml",
            "magic/ManualHarness.sol",
            "src/magic/recon-coverage.json",
            "test/recon/CryticTester.sol",
        ] {
            assert!(
                !should_skip_workspace_snapshot_path(Path::new(path)),
                "`{path}` should remain eligible as an intentional workspace change"
            );
        }
    }

    #[test]
    fn artifact_file_collection_skips_backend_internal_state_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_dir = temp.path().join("artifacts/node");
        fs::create_dir_all(artifact_dir.join("claude-config/projects")).unwrap();
        fs::write(artifact_dir.join("stdout.log"), "visible\n").unwrap();
        fs::write(
            artifact_dir.join("claude-config/projects/session.jsonl"),
            "backend session\n",
        )
        .unwrap();

        let files = collect_artifact_files(&artifact_dir).unwrap();
        let relative_paths = files
            .iter()
            .map(|path| path.strip_prefix(&artifact_dir).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(relative_paths, vec![Path::new("stdout.log")]);
    }

    #[test]
    fn persist_workspace_changes_captures_modified_submodule_files() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let dependency = temp.path().join("dependency");
        fs::create_dir_all(&dependency).unwrap();
        run_git_for_test(&dependency, ["init"]);
        fs::write(dependency.join("dep.txt"), "dependency\n").unwrap();
        run_git_for_test(&dependency, ["add", "dep.txt"]);
        run_git_for_test(
            &dependency,
            [
                "-c",
                "user.email=ultrafuzz@example.invalid",
                "-c",
                "user.name=Ultrafuzz",
                "commit",
                "-m",
                "dependency",
            ],
        );

        let target = temp.path().join("target");
        fs::create_dir_all(&target).unwrap();
        run_git_for_test(&target, ["init"]);
        fs::write(target.join("README.md"), "# target\n").unwrap();
        run_git_for_test(&target, ["add", "README.md"]);
        run_git_for_test(
            &target,
            [
                "-c",
                "user.email=ultrafuzz@example.invalid",
                "-c",
                "user.name=Ultrafuzz",
                "commit",
                "-m",
                "initial",
            ],
        );
        let add_output = Command::new("git")
            .arg("-C")
            .arg(&target)
            .arg("-c")
            .arg("protocol.file.allow=always")
            .arg("submodule")
            .arg("add")
            .arg(&dependency)
            .arg("lib/dependency")
            .output()
            .unwrap();
        assert_git_success(add_output);
        run_git_for_test(&target, ["add", ".gitmodules", "lib/dependency"]);
        run_git_for_test(
            &target,
            [
                "-c",
                "user.email=ultrafuzz@example.invalid",
                "-c",
                "user.name=Ultrafuzz",
                "commit",
                "-m",
                "add submodule",
            ],
        );

        let workspace = temp.path().join("workspace");
        run_git_for_test(
            &target,
            [
                "worktree",
                "add",
                "-B",
                "ultrafuzz/test/submodule-snapshot",
                workspace.to_str().unwrap(),
                "HEAD",
            ],
        );
        let update_output = Command::new("git")
            .arg("-C")
            .arg(&workspace)
            .arg("-c")
            .arg("protocol.file.allow=always")
            .arg("submodule")
            .arg("update")
            .arg("--init")
            .arg("--no-fetch")
            .arg("--")
            .arg("lib/dependency")
            .output()
            .unwrap();
        assert_git_success(update_output);
        fs::write(workspace.join("lib/dependency/dep.txt"), "changed\n").unwrap();

        let artifacts = temp.path().join("artifacts");
        fs::create_dir_all(&artifacts).unwrap();
        let changes = persist_workspace_changes(
            &workspace,
            &target,
            &artifacts,
            &WorkspaceChangeBaseline::default(),
        )
        .unwrap();
        let manifest = read_json_value(&changes.manifest_path).unwrap();
        let files = manifest["files"].as_array().unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "lib/dependency/dep.txt");
        assert_eq!(
            fs::read_to_string(
                artifacts
                    .join(WORKSPACE_CHANGES_DIR)
                    .join("lib/dependency/dep.txt")
            )
            .unwrap(),
            "changed\n"
        );
    }

    #[test]
    fn collect_generated_tests_from_workspace_skips_symlink_sources() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let target = temp.path().join("target");
        let artifacts = temp.path().join("artifacts");
        let test_dir = workspace.join("test/foundry/encode-decode");
        fs::create_dir_all(&test_dir).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&artifacts).unwrap();
        fs::write(test_dir.join("Real.t.sol"), "contract Real {}\n").unwrap();
        fs::write(temp.path().join("secret.txt"), "do not copy\n").unwrap();
        symlink(temp.path().join("secret.txt"), test_dir.join("Leak.t.sol")).unwrap();
        let strategy = StrategyId::from("encode-decode");
        let model_id = ModelProfileId::from("default");
        let prompt_id = PromptId::from("encode-decode");

        let collection = collect_generated_tests_from_workspace(
            &workspace,
            &target,
            &artifacts,
            &NodeId::from("encode-decode-0"),
            AttemptNodeRef {
                strategy: &strategy,
                attempt_index: 0,
                model_id: &model_id,
                model_index: 0,
                loop_index: 0,
                prompt_id: &prompt_id,
            },
            None,
        )
        .unwrap();
        let manifest = read_json_value(&collection.manifest_path).unwrap();
        let tests = manifest["test_files"].as_array().unwrap();
        let support_files = manifest["support_files"].as_array().unwrap();

        assert_eq!(tests.len(), 1);
        assert!(support_files.is_empty());
        assert_eq!(
            tests[0]["source_relative_path"],
            "test/foundry/encode-decode/Real.t.sol"
        );
        assert!(!artifacts
            .join("generated-tests/test/foundry/encode-decode/Leak.t.sol")
            .exists());
    }

    #[test]
    fn collect_generated_tests_from_workspace_copies_support_sol_files() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let target = temp.path().join("target");
        let artifacts = temp.path().join("artifacts");
        let test_dir = workspace.join("test/foundry/differential");
        fs::create_dir_all(&test_dir).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&artifacts).unwrap();
        fs::write(
            test_dir.join("ReferenceHarness.t.sol"),
            "import {ReferenceModel} from \"./ReferenceModel.sol\";\ncontract ReferenceHarness {}\n",
        )
        .unwrap();
        fs::write(
            test_dir.join("ReferenceModel.sol"),
            "contract ReferenceModel {}\n",
        )
        .unwrap();
        let strategy = StrategyId::from("reference-harness-author");
        let model_id = ModelProfileId::from("default");
        let prompt_id = PromptId::from("reference-harness-author");

        let collection = collect_generated_tests_from_workspace(
            &workspace,
            &target,
            &artifacts,
            &NodeId::from("reference-harness-author-0"),
            AttemptNodeRef {
                strategy: &strategy,
                attempt_index: 0,
                model_id: &model_id,
                model_index: 0,
                loop_index: 0,
                prompt_id: &prompt_id,
            },
            None,
        )
        .unwrap();

        assert!(artifacts
            .join("generated-tests/test/foundry/differential/ReferenceHarness.t.sol")
            .exists());
        assert!(artifacts
            .join("generated-tests/test/foundry/differential/ReferenceModel.sol")
            .exists());
        let manifest = read_json_value(&collection.manifest_path).unwrap();
        assert_eq!(manifest["test_files"].as_array().unwrap().len(), 1);
        let support_files = manifest["support_files"].as_array().unwrap();
        assert_eq!(support_files.len(), 1);
        assert_eq!(
            support_files[0]["source_relative_path"],
            "test/foundry/differential/ReferenceModel.sol"
        );
    }

    #[test]
    fn read_json_value_rejects_oversized_agent_json() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("findings.json");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_AGENT_JSON_BYTES + 1).unwrap();

        let error = read_json_value(&path).unwrap_err();

        assert!(error.to_string().contains("above the maximum"));
    }

    #[test]
    fn read_json_value_rejects_symlink_agent_json() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target.json");
        let link = temp.path().join("findings.json");
        fs::write(&target, "{}").unwrap();
        symlink(&target, &link).unwrap();

        let error = read_json_value(&link).unwrap_err();

        assert!(error.to_string().contains("not a regular file"));
    }

    #[test]
    fn findings_json_has_entries_ignores_empty_arrays() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("findings.json");
        fs::write(&path, "[]\n").unwrap();

        assert!(!findings_json_has_entries(&path).unwrap());
    }

    #[test]
    fn findings_json_has_entries_detects_nonempty_arrays() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("findings.json");
        fs::write(&path, "[{\"title\":\"real finding\"}]\n").unwrap();

        assert!(findings_json_has_entries(&path).unwrap());
    }

    #[test]
    fn findings_json_has_entries_rejects_non_arrays() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("findings.json");
        fs::write(&path, "{}\n").unwrap();

        let error = findings_json_has_entries(&path).unwrap_err();

        assert!(error.to_string().contains("must be a JSON array"));
    }

    #[test]
    fn required_artifact_parent_dirs_are_prepared_before_agent_run() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_dir = temp.path().join("artifacts/node");
        fs::create_dir_all(&artifact_dir).unwrap();

        prepare_required_artifact_parent_dirs(
            &artifact_dir,
            &[
                PathBuf::from("setup/project-discovery.md"),
                PathBuf::from("flat.json"),
            ],
        )
        .unwrap();

        assert!(artifact_dir.join("setup").is_dir());

        let error = prepare_required_artifact_parent_dirs(
            &artifact_dir,
            &[PathBuf::from("../escape.json")],
        )
        .unwrap_err();
        assert!(error.to_string().contains("traversal"));
    }

    #[test]
    fn git_command_hardening_adds_config_and_env_guards() {
        let args = hardened_git_args(vec!["status".to_owned()]);
        assert!(args
            .windows(2)
            .any(|window| window == ["-c".to_owned(), "core.fsmonitor=false".to_owned()]));
        assert!(args
            .windows(2)
            .any(|window| window == ["-c".to_owned(), "diff.external=".to_owned()]));
        assert_eq!(args.last().map(String::as_str), Some("status"));

        let mut command = Command::new("git");
        command.env("SECRET_ENV", "leak");
        configure_hardened_git_env(&mut command);
        let envs = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<BTreeMap<_, _>>();

        assert!(!envs.contains_key("SECRET_ENV"));
        assert_eq!(
            envs.get("GIT_CONFIG_GLOBAL").and_then(Option::as_deref),
            Some("/dev/null")
        );
        assert_eq!(
            envs.get("GIT_CONFIG_SYSTEM").and_then(Option::as_deref),
            Some("/dev/null")
        );
        assert_eq!(
            envs.get("GIT_TERMINAL_PROMPT").and_then(Option::as_deref),
            Some("0")
        );
    }

    #[test]
    fn command_output_drains_stdout_while_waiting_for_exit() {
        let output = command_output(
            "sh",
            vec![
                "-c".to_owned(),
                "i=0; while [ \"$i\" -lt 4096 ]; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; i=$((i + 1)); done".to_owned(),
            ],
        )
        .unwrap();

        assert!(output.status_success);
        assert_eq!(output.stdout.len(), 4096 * 32);
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn schedules_independent_attempts_with_agent_bound() {
        let config = config("[run]\nmax_parallel_agents = 2\n");
        let graph = test_graph(
            "run",
            vec![
                agentic_node(
                    "discover-base-test",
                    "discover-base-test",
                    &[],
                    RetryPolicy::default(),
                ),
                agentic_node(
                    "encode-decode-0",
                    "encode-decode",
                    &["discover-base-test"],
                    RetryPolicy::default(),
                ),
                agentic_node(
                    "encode-decode-1",
                    "encode-decode",
                    &["discover-base-test"],
                    RetryPolicy::default(),
                ),
                agentic_node(
                    "encode-decode-2",
                    "encode-decode",
                    &["discover-base-test"],
                    RetryPolicy::default(),
                ),
                agentic_node(
                    "encode-decode-3",
                    "encode-decode",
                    &["discover-base-test"],
                    RetryPolicy::default(),
                ),
            ],
        );
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let runner = Arc::new(RecordingRunner::new(Duration::from_millis(30)));
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&config),
            runner.clone(),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        assert!(runner.peak_agents.load(Ordering::SeqCst) > 1);
        assert!(runner.peak_agents.load(Ordering::SeqCst) <= 2);
        let order = runner.order.lock().unwrap();
        let prep_pos = order
            .iter()
            .position(|id| id.as_str() == "discover-base-test")
            .unwrap();
        let attempt_pos = order
            .iter()
            .position(|id| id.as_str() == "encode-decode-0")
            .unwrap();
        assert!(prep_pos < attempt_pos);
    }

    #[test]
    fn meta_nodes_complete_without_runner_dispatch() {
        let config = CampaignConfig::default();
        let graph = test_graph(
            "run",
            vec![
                meta_node(MetaNodeRole::Start, &[]),
                agentic_node(
                    "project-discovery",
                    "project-discovery",
                    &[START_NODE_ID],
                    RetryPolicy::default(),
                ),
                meta_node(MetaNodeRole::Finish, &["project-discovery"]),
            ],
        );
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let runner = Arc::new(RecordingRunner::new(Duration::from_millis(0)));
        let executor = DagExecutor::new(ExecutorConfig::default(), runner.clone());

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        assert_eq!(
            *runner.order.lock().unwrap(),
            vec![NodeId::from("project-discovery")]
        );
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        assert_eq!(
            state.nodes[&NodeId::from(START_NODE_ID)].status,
            NodeStatus::Succeeded
        );
        assert_eq!(
            state.nodes[&NodeId::from(FINISH_NODE_ID)].status,
            NodeStatus::Succeeded
        );
        assert!(!layout.artifact_dir(&NodeId::from(START_NODE_ID)).exists());
        assert!(!layout.artifact_dir(&NodeId::from(FINISH_NODE_ID)).exists());
    }

    #[test]
    fn retries_failed_node_before_fail_fast() {
        let config = CampaignConfig::default();
        let graph = test_graph(
            "run",
            vec![agentic_node(
                "project-discovery",
                "project-discovery",
                &[],
                RetryPolicy { max_retries: 1 },
            )],
        );
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let runner = Arc::new(FailOnceRunner::default());
        let executor = DagExecutor::new(ExecutorConfig::default(), runner.clone());

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        assert_eq!(runner.calls.load(Ordering::SeqCst), 2);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        assert_eq!(
            state.nodes[&NodeId::from("project-discovery")].retry_count,
            1
        );
    }

    #[test]
    fn retry_archives_stale_node_artifacts_before_rerun() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_dir = temp.path().join("artifacts/encode-decode-0");
        fs::create_dir_all(artifact_dir.join("nested")).unwrap();
        fs::create_dir_all(artifact_dir.join("backend-attempts/attempt-1")).unwrap();
        fs::write(artifact_dir.join("findings.json"), "[{\"old\":true}]\n").unwrap();
        fs::write(
            artifact_dir.join("nested/required.json"),
            "{\"old\":true}\n",
        )
        .unwrap();
        fs::write(artifact_dir.join("stdout.log"), "old stdout\n").unwrap();
        fs::write(
            artifact_dir.join("backend-attempts/attempt-1/stdout.log"),
            "prior backend archive\n",
        )
        .unwrap();

        archive_artifact_dir_for_retry(&artifact_dir).unwrap();

        let archive_dir = artifact_dir.join("backend-attempts/topology-retry-1");
        assert!(archive_dir.join("findings.json").is_file());
        assert!(archive_dir.join("nested/required.json").is_file());
        assert!(archive_dir.join("stdout.log").is_file());
        assert!(!artifact_dir.join("findings.json").exists());
        assert!(!artifact_dir.join("nested").exists());
        assert!(artifact_dir
            .join("backend-attempts/attempt-1/stdout.log")
            .is_file());
    }

    #[test]
    fn timeout_with_complete_agentic_artifacts_succeeds_without_retry() {
        let config = CampaignConfig::default();
        let mut node = agentic_node_with_required_artifact(
            "triage",
            "triage",
            TRIAGED_FINDINGS_FILE,
            RetryPolicy { max_retries: 1 },
        );
        node.timeout = Some(Duration::from_millis(1));
        let graph = test_graph("run", vec![node]);
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let runner = Arc::new(SlowCompleteArtifactRunner::default());
        let executor = DagExecutor::new(ExecutorConfig::default(), runner.clone());

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        assert_eq!(runner.calls.load(Ordering::SeqCst), 1);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        let node_state = &state.nodes[&NodeId::from("triage")];
        assert_eq!(node_state.status, NodeStatus::Succeeded);
        assert_eq!(node_state.retry_count, 0);
        assert!(!node_state.timed_out);
        assert!(layout
            .artifact_dir(&NodeId::from("triage"))
            .join(ARTIFACT_MANIFEST_FILE)
            .exists());
    }

    #[test]
    fn timeout_returns_without_joining_blocked_runner() {
        struct BlockingRunner {
            entered_tx: Mutex<Option<std::sync::mpsc::Sender<()>>>,
            release_rx: Mutex<std::sync::mpsc::Receiver<()>>,
            finished_tx: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        }

        impl NodeRunner for BlockingRunner {
            fn run(&self, _ctx: NodeContext) -> anyhow::Result<NodeOutput> {
                if let Some(tx) = self.entered_tx.lock().unwrap().take() {
                    tx.send(()).unwrap();
                }
                self.release_rx.lock().unwrap().recv().unwrap();
                if let Some(tx) = self.finished_tx.lock().unwrap().take() {
                    tx.send(()).unwrap();
                }
                Ok(NodeOutput::default())
            }
        }

        let config = CampaignConfig::default();
        let mut node = agentic_node(
            "project-discovery",
            "project-discovery",
            &[],
            RetryPolicy::default(),
        );
        node.timeout = Some(Duration::from_millis(50));
        let graph = test_graph("run", vec![node]);
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let project_root = temp.path().to_path_buf();
        let run_root = layout.root.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let runner = Arc::new(BlockingRunner {
            entered_tx: Mutex::new(Some(entered_tx)),
            release_rx: Mutex::new(release_rx),
            finished_tx: Mutex::new(Some(finished_tx)),
        });
        let executor = DagExecutor::new(ExecutorConfig::default(), runner);
        let (result_tx, result_rx) = std::sync::mpsc::channel();

        let handle = thread::spawn(move || {
            let result = executor
                .execute(ExecutionRequest {
                    graph,
                    project_root,
                    resolved_config: config,
                    prompt_registry: PromptRegistry::built_in().unwrap(),
                    artifact_store: ArtifactStore::new(layout.clone()),
                    state_store: RunStateStore::for_run_root(&layout.root),
                    event_sink: Arc::new(NullEventSink),
                    source_run_id: None,
                })
                .unwrap();
            result_tx.send(result.status).unwrap();
        });

        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(
            result_rx.recv_timeout(Duration::from_millis(500)).unwrap(),
            RunStatus::Failed
        );
        handle.join().unwrap();
        let state = RunStateStore::for_run_root(&run_root).load().unwrap();
        let node_state = &state.nodes[&NodeId::from("project-discovery")];
        assert_eq!(node_state.status, NodeStatus::TimedOut);
        assert!(node_state.timed_out);

        release_tx.send(()).unwrap();
        finished_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn timeout_retry_ignores_late_completion_from_retired_attempt() {
        struct RetryAfterTimeoutRunner {
            calls: AtomicUsize,
            release_first_rx: Mutex<std::sync::mpsc::Receiver<()>>,
            first_finished_tx: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        }

        impl NodeRunner for RetryAfterTimeoutRunner {
            fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput> {
                let findings_path = ctx.artifact_dir.join(FINDINGS_FILE);
                let compatibility_dir = attempt_artifact_sibling_dir(
                    &ctx,
                    &NodeId::from(PROPERTY_SPECIFICATION_COMPAT_DIR),
                );
                let compatibility_path = compatibility_dir.join(PROPERTY_SPECIFICATION_FILE);
                if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    self.release_first_rx.lock().unwrap().recv().unwrap();
                    write_artifact(&ctx.artifact_dir, FINDINGS_FILE, "\"retired\"\n")?;
                    write_artifact(
                        &compatibility_dir,
                        PROPERTY_SPECIFICATION_FILE,
                        "\"retired-compat\"\n",
                    )?;
                    if let Some(tx) = self.first_finished_tx.lock().unwrap().take() {
                        tx.send(()).unwrap();
                    }
                    Ok(NodeOutput {
                        artifacts: vec![
                            ArtifactRef::new(findings_path),
                            ArtifactRef::new(compatibility_path),
                        ],
                    })
                } else {
                    write_artifact(&ctx.artifact_dir, FINDINGS_FILE, "\"retry\"\n")?;
                    write_artifact(
                        &compatibility_dir,
                        PROPERTY_SPECIFICATION_FILE,
                        "\"retry-compat\"\n",
                    )?;
                    Ok(NodeOutput {
                        artifacts: vec![
                            ArtifactRef::new(findings_path),
                            ArtifactRef::new(compatibility_path),
                        ],
                    })
                }
            }
        }

        let config = CampaignConfig::default();
        let mut node = agentic_node(
            "project-discovery",
            "project-discovery",
            &[],
            RetryPolicy { max_retries: 1 },
        );
        node.timeout = Some(Duration::from_millis(50));
        let graph = test_graph("run", vec![node]);
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let (release_first_tx, release_first_rx) = std::sync::mpsc::channel();
        let (first_finished_tx, first_finished_rx) = std::sync::mpsc::channel();
        let runner = Arc::new(RetryAfterTimeoutRunner {
            calls: AtomicUsize::new(0),
            release_first_rx: Mutex::new(release_first_rx),
            first_finished_tx: Mutex::new(Some(first_finished_tx)),
        });
        let executor = DagExecutor::new(ExecutorConfig::default(), runner.clone());
        let started = Instant::now();

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "executor waited for retired attempt for {:?}",
            started.elapsed()
        );
        assert_eq!(runner.calls.load(Ordering::SeqCst), 2);

        release_first_tx.send(()).unwrap();
        first_finished_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        thread::sleep(Duration::from_millis(50));

        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        let node_state = &state.nodes[&NodeId::from("project-discovery")];
        assert_eq!(node_state.status, NodeStatus::Succeeded);
        assert_eq!(node_state.retry_count, 1);
        assert!(!node_state.timed_out);
        assert_eq!(node_state.last_error, None);
        assert_eq!(
            fs::read_to_string(
                layout
                    .artifact_dir(&NodeId::from("project-discovery"))
                    .join(FINDINGS_FILE)
            )
            .unwrap(),
            "\"retry\"\n"
        );
        assert_eq!(
            fs::read_to_string(
                layout
                    .artifact_dir(&NodeId::from(PROPERTY_SPECIFICATION_COMPAT_DIR))
                    .join(PROPERTY_SPECIFICATION_FILE)
            )
            .unwrap(),
            "\"retry-compat\"\n"
        );
    }

    #[test]
    fn synthetic_runner_persists_state_events_and_prompt_artifacts() {
        let config = config("[run]\nmax_parallel_agents = 4\n");
        let graph = test_graph(
            "run",
            vec![agentic_node(
                "encode-decode-0",
                "encode-decode",
                &[],
                RetryPolicy::default(),
            )],
        );
        let temp = tempfile::tempdir().unwrap();
        let prompt_dir = temp.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_dir).unwrap();
        fs::write(
            prompt_dir.join("encode-decode.md"),
            "---\nid: encode-decode\n---\n# Decode encode\n",
        )
        .unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let event_sink = Arc::new(JsonlEventSink::new(layout.events_jsonl_path()));
        let executor = DagExecutor::default();

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink,
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        assert!(layout.state_path().exists());
        assert!(layout
            .artifact_dir(&NodeId::from("encode-decode-0"))
            .join("prompt.rendered.md")
            .exists());
        assert!(layout
            .artifact_dir(&NodeId::from("encode-decode-0"))
            .join("findings.json")
            .exists());
        assert!(layout.events_jsonl_path().exists());
    }

    #[test]
    fn executor_persists_codex_token_usage_and_api_estimated_spend() {
        let config = config(
            r#"
[models]
default = "gpt-5-4"

[models.gpt-5-4]
backend = "codex-cli"
model = "gpt-5.4"
"#,
        );
        let graph = test_graph(
            "run",
            vec![agentic_node(
                "encode-decode-0",
                "encode-decode",
                &[],
                RetryPolicy::default(),
            )],
        );
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&config),
            Arc::new(UsageLogRunner),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        let usage = state.usage.as_ref().expect("run usage");
        assert_eq!(usage.tokens.total_tokens, 1_600);
        assert_eq!(usage.tokens_used, "1.6K");
        assert_eq!(usage.cost_status, CostEstimateStatus::Complete);
        assert_eq!(usage.estimated_cost_microusd, Some(4_575));
        assert_eq!(usage.estimated_spend.as_deref(), Some("<$1"));
        assert!(usage.unresolved_pricing.is_empty());
        let node_usage = state.nodes[&NodeId::from("encode-decode-0")]
            .usage
            .as_ref()
            .expect("node usage");
        assert_eq!(
            node_usage.source_path,
            PathBuf::from("artifacts/encode-decode-0/stdout.log")
        );
        assert_eq!(node_usage.tokens_used, "1.6K");
        assert_eq!(node_usage.cost_status, CostEstimateStatus::Complete);
        assert_eq!(node_usage.estimated_spend.as_deref(), Some("<$1"));
    }

    #[test]
    fn codex_usage_ignores_anthropic_shaped_json_when_backend_is_codex() {
        let mut node_state = NodeState::new(NodeId::from("encode-decode-0"));
        node_state.backend = Some(BackendKind::CodexCli);
        node_state.model = Some("gpt-5.5".to_owned());
        let records = parse_usage_log(
            r#"{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":100,"reasoning_output_tokens":20}}
{"usage":{"input_tokens":999999,"output_tokens":1},"model":"claude-sonnet-4-6"}"#,
            &node_state,
        );
        let records = records
            .into_iter()
            .filter(|record| {
                node_state
                    .backend
                    .map(provider_for_backend)
                    .is_none_or(|provider| record.provider == provider)
            })
            .collect::<Vec<_>>();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].provider, PROVIDER_OPENAI);
        assert_eq!(records[0].tokens.cached_input_tokens, 800);
        assert_eq!(records[0].tokens.total_tokens, 1_100);
        let (cost, unresolved) = estimate_usage_cost(
            records[0].provider,
            records[0].model.as_deref(),
            &records[0].tokens,
            &records[0].raw_usage,
        );
        assert_eq!(cost, Some(4_400));
        assert!(unresolved.is_empty());
    }

    #[test]
    fn executor_accumulates_failed_retry_token_usage() {
        let config = config(
            r#"
[models]
default = "gpt-5-4"

[models.gpt-5-4]
backend = "codex-cli"
model = "gpt-5.4"
"#,
        );
        let graph = test_graph(
            "run",
            vec![agentic_node(
                "encode-decode-0",
                "encode-decode",
                &[],
                RetryPolicy { max_retries: 1 },
            )],
        );
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&config),
            Arc::new(FailOnceUsageRunner::default()),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        let node_state = &state.nodes[&NodeId::from("encode-decode-0")];
        assert_eq!(node_state.retry_count, 1);
        let node_usage = node_state.usage.as_ref().expect("node usage");
        assert_eq!(node_usage.tokens.total_tokens, 3_000);
        assert_eq!(
            state.usage.as_ref().expect("run usage").tokens.total_tokens,
            3_000
        );
    }

    #[test]
    fn codex_usage_limit_requeues_without_topology_retry_budget() {
        let config = config(
            r#"
[models]
default = "gpt-5-5"

[models.gpt-5-5]
backend = "codex-cli"
model = "gpt-5.5"
"#,
        );
        let graph = test_graph(
            "run",
            vec![agentic_node(
                "encode-decode-0",
                "encode-decode",
                &[],
                RetryPolicy::default(),
            )],
        );
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let runner = Arc::new(CodexUsageLimitOnceRunner::default());
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&config),
            runner.clone(),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        assert_eq!(runner.calls.load(Ordering::SeqCst), 2);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        let node_state = &state.nodes[&NodeId::from("encode-decode-0")];
        assert_eq!(node_state.status, NodeStatus::Succeeded);
        assert_eq!(node_state.retry_count, 0);
        assert_eq!(node_state.retry_after_epoch_ms, None);
        assert_eq!(node_state.last_error, None);
    }

    #[test]
    fn parses_codex_usage_limit_retry_after_timestamp() {
        let retry_after = codex_usage_limit_retry_after_epoch_ms(
            "You've hit your usage limit. Visit settings or try again at Jun 18th, 2026 2:18 AM.",
            0,
        )
        .unwrap();

        assert_eq!(retry_after, 1_781_749_080_000);
    }

    #[test]
    fn parses_codex_usage_limit_retry_after_time_only() {
        let retry_after = codex_usage_limit_retry_after_epoch_ms(
            "You've hit your usage limit. Visit settings or try again at 7:19 AM.",
            1_781_757_211_000,
        )
        .unwrap();

        assert_eq!(retry_after, 1_781_767_140_000);
    }

    #[test]
    fn parses_codex_usage_limit_retry_after_time_only_next_day() {
        let retry_after = codex_usage_limit_retry_after_epoch_ms(
            "You've hit your usage limit. Visit settings or try again at 12:05 AM.",
            1_781_825_400_000,
        )
        .unwrap();

        assert_eq!(retry_after, 1_781_827_500_000);
    }

    #[test]
    fn default_backend_nodes_use_configured_model_for_usage_pricing() {
        let config = config(
            r#"
[models]
default = "gpt-5-4"

[models.gpt-5-4]
backend = "codex-cli"
model = "gpt-5.4"
"#,
        );
        let graph = test_graph(
            "run",
            vec![
                Node {
                    id: NodeId::from("project-discovery"),
                    label: "Project Discovery".to_owned(),
                    kind: NodeKind::ProjectDiscovery,
                    depends_on: Vec::new(),
                    timeout: None,
                    retry: RetryPolicy::default(),
                    artifact_dir: PathBuf::from("artifacts/project-discovery"),
                },
                Node {
                    id: NodeId::from("setup-foundry"),
                    label: "Setup Foundry".to_owned(),
                    kind: NodeKind::PrepareFoundryHarness,
                    depends_on: vec![NodeId::from("project-discovery")],
                    timeout: None,
                    retry: RetryPolicy::default(),
                    artifact_dir: PathBuf::from("artifacts/setup-foundry"),
                },
                Node {
                    id: NodeId::from("base-test-discovery"),
                    label: "Base Test Discovery".to_owned(),
                    kind: NodeKind::DiscoverBaseTest,
                    depends_on: vec![NodeId::from("setup-foundry")],
                    timeout: None,
                    retry: RetryPolicy::default(),
                    artifact_dir: PathBuf::from("artifacts/base-test-discovery"),
                },
                Node {
                    id: NodeId::from("property-specification-0kn0t"),
                    label: "0kn0t property lens".to_owned(),
                    kind: NodeKind::PropertySpecificationLens {
                        lens: PropertyLens::ZeroKnot,
                    },
                    depends_on: vec![NodeId::from("base-test-discovery")],
                    timeout: None,
                    retry: RetryPolicy::default(),
                    artifact_dir: PathBuf::from("artifacts/property-specification-0kn0t"),
                },
            ],
        );
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&config),
            Arc::new(UsageLogRunner),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        let node_usage = state.nodes[&NodeId::from("property-specification-0kn0t")]
            .usage
            .as_ref()
            .expect("node usage");
        assert_eq!(node_usage.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(node_usage.cost_status, CostEstimateStatus::Complete);
        assert_eq!(node_usage.estimated_cost_microusd, Some(4_575));
    }

    #[cfg(unix)]
    #[test]
    fn usage_parser_ignores_symlinked_stdout_log() {
        let config = config(
            r#"
[models]
default = "gpt-5-4"

[models.gpt-5-4]
backend = "codex-cli"
model = "gpt-5.4"
"#,
        );
        let graph = test_graph(
            "run",
            vec![agentic_node(
                "encode-decode-0",
                "encode-decode",
                &[],
                RetryPolicy::default(),
            )],
        );
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&config),
            Arc::new(SymlinkUsageLogRunner),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        assert!(state.usage.is_none());
        assert!(state.nodes[&NodeId::from("encode-decode-0")]
            .usage
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn usage_parser_ignores_fifo_stdout_log() {
        let config = config(
            r#"
[models]
default = "gpt-5-4"

[models.gpt-5-4]
backend = "codex-cli"
model = "gpt-5.4"
"#,
        );
        let graph = test_graph(
            "run",
            vec![agentic_node(
                "encode-decode-0",
                "encode-decode",
                &[],
                RetryPolicy::default(),
            )],
        );
        let temp = tempfile::tempdir().unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(temp.path(), RunId::from("run"));
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&config),
            Arc::new(FifoUsageLogRunner),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: temp.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        assert!(state.usage.is_none());
        assert!(state.nodes[&NodeId::from("encode-decode-0")]
            .usage
            .is_none());
    }

    #[test]
    fn final_report_prompt_embeds_run_lineage_context() {
        let project = tempfile::tempdir().unwrap();
        let prompt_dir = project.path().join(".ultrafuzz/prompts/review");
        fs::create_dir_all(&prompt_dir).unwrap();
        fs::write(
            prompt_dir.join("final-report.md"),
            "---\nid: final-report\n---\n# Final\n{{run_metadata_path}}/state.json\n",
        )
        .unwrap();
        let run_id = RunId::from("run");
        let node = Node {
            id: NodeId::from("final-report"),
            label: "Generate report".to_owned(),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from("final-report"),
                prompt_path: PathBuf::from("review/final-report.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: Vec::new(),
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/final-report"),
        };
        let graph = CampaignGraph {
            run_id: run_id.clone(),
            graph_version: ultrafuzz_topology::GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![node.clone()],
        };
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let mut state = RunState::from_graph(
            layout.run_id.clone(),
            &graph,
            "graph".to_owned(),
            "config".to_owned(),
            None,
        );
        let node_usage = NodeUsage {
            schema_version: ACCOUNTING_SCHEMA_VERSION.to_owned(),
            pricing_as_of: PRICING_AS_OF.to_owned(),
            source_path: PathBuf::from("artifacts/encode-decode-0/stdout.log"),
            provider: PROVIDER_OPENAI.to_owned(),
            backend: Some(BackendKind::CodexCli),
            model_id: Some(ModelProfileId::from("gpt-5-4")),
            model: Some("gpt-5.4".to_owned()),
            tokens: TokenUsage {
                input_tokens: 1_500,
                cached_input_tokens: 300,
                output_tokens: 100,
                reasoning_output_tokens: 20,
                total_tokens: 1_600,
                ..TokenUsage::default()
            },
            tokens_used: "1.6K".to_owned(),
            cost_status: CostEstimateStatus::Complete,
            estimated_cost_microusd: Some(4_575),
            estimated_spend: Some("<$1".to_owned()),
            unresolved_pricing: Vec::new(),
        };
        state.usage = ultrafuzz_state::RunUsageSummary::from_node_usages([&node_usage]);
        state.source_run_id = Some(RunId::from("source-run"));
        let mut reused_node = NodeState::new(NodeId::from("project-discovery"));
        reused_node.status = NodeStatus::ReusedFromPriorRun;
        state.nodes.insert(reused_node.node_id.clone(), reused_node);
        state.started_at = Some("1.000Z".to_owned());
        state.finished_at = Some("3661.000Z".to_owned());
        let state_store = RunStateStore::for_run_root(&layout.root);
        state_store.save(&state).unwrap();
        fs::write(layout.run_metadata_path(), "{}\n").unwrap();
        fs::write(layout.graph_path(), "{}\n").unwrap();
        fs::write(layout.resolved_config_path(), "schema_version = \"1.0\"\n").unwrap();
        let artifact_dir = layout.artifact_dir(&NodeId::from("final-report"));
        let workspace_dir = layout.workspace_dir(&NodeId::from("final-report"));
        let ctx = NodeContext {
            run_id: layout.run_id.clone(),
            node,
            graph,
            project_root: project.path().to_path_buf(),
            resolved_config: CampaignConfig::default(),
            artifact_store: Arc::new(ArtifactStore::new(layout)),
            artifact_dir: artifact_dir.clone(),
            workspace_dir: workspace_dir.clone(),
            run_state: state_store,
            event_sink: Arc::new(NullEventSink),
            prompt_registry: PromptRegistry::built_in().unwrap(),
        };

        let rendered_path = render_agentic_prompt(
            &ctx,
            &artifact_dir,
            project.path(),
            &workspace_dir,
            &NodeId::from("final-report"),
            Path::new("review/final-report.md"),
            0,
            1,
            LoopMode::Parallel,
            &artifact_dir.join("findings.json"),
            &artifact_dir.join("patch.diff"),
            &artifact_dir.join("metadata.json"),
            &[],
        )
        .unwrap();
        let rendered = fs::read_to_string(rendered_path).unwrap();

        assert!(rendered.contains("# Run Summary Context"));
        assert!(rendered.contains(
            &artifact_dir
                .join(RUN_METADATA_DIR)
                .join("state.json")
                .display()
                .to_string()
        ));
        assert!(artifact_dir
            .join(RUN_METADATA_DIR)
            .join("run.json")
            .exists());
        assert!(artifact_dir
            .join(RUN_METADATA_DIR)
            .join("state.json")
            .exists());
        assert!(artifact_dir
            .join(RUN_METADATA_DIR)
            .join("graph.json")
            .exists());
        assert!(artifact_dir
            .join(RUN_METADATA_DIR)
            .join("config.resolved.toml")
            .exists());
        assert!(rendered.contains("\"elapsed_time\": \"1h 1m\""));
        assert!(rendered.contains("\"source_run_id\": \"source-run\""));
        assert!(rendered.contains("\"reused_node_count\": 1"));
        assert!(rendered.contains("\"project-discovery\""));
        assert!(rendered.contains("# Run Accounting"));
        assert!(rendered.contains("\"available\": true"));
        assert!(rendered.contains("\"tokens_used\": \"1.6K\""));
        assert!(rendered.contains("\"estimated_spend\": \"<$1\""));
        assert!(rendered.contains("# Run Health And Lineage"));
        assert!(rendered.contains("\"source\": \"state.json, graph.json, run artifacts\""));
        assert!(rendered.contains("\"lineage\""));
        assert!(rendered.contains("\"current_elapsed_seconds\": 3660.0"));
        assert!(rendered.contains("\"current_tokens_used\": \"1.6K\""));
        assert!(rendered.contains("# Finding Lifecycle Ledger"));
        assert!(rendered.contains(
            &ctx.artifact_store
                .layout()
                .artifact_dir(&NodeId::from("severity-classification"))
                .join(FINDING_LIFECYCLE_LEDGER_FILE)
                .display()
                .to_string()
        ));
        assert!(rendered.contains("Include a `lifecycle` object"));
    }

    #[test]
    fn final_report_prompt_marks_own_active_health_as_in_progress() {
        let project = tempfile::tempdir().unwrap();
        let prompt_dir = project.path().join(".ultrafuzz/prompts/review");
        fs::create_dir_all(&prompt_dir).unwrap();
        fs::write(
            prompt_dir.join("final-report.md"),
            "---\nid: final-report\n---\n# Final\n",
        )
        .unwrap();
        let (ctx, _root) = test_context(
            project.path(),
            "final-report",
            NodeKind::Agentic {
                logical_id: NodeId::from("final-report"),
                prompt_path: PathBuf::from("review/final-report.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
        );
        let mut state = RunState::from_graph(
            ctx.run_id.clone(),
            &ctx.graph,
            "graph".to_owned(),
            "config".to_owned(),
            None,
        );
        state.status = RunStatus::Running;
        state.started_at = Some("1.000Z".to_owned());
        let final_report = state.nodes.get_mut(&NodeId::from("final-report")).unwrap();
        final_report.status = NodeStatus::Ready;
        ctx.run_state.save(&state).unwrap();

        let layout = ctx.artifact_store.layout();
        let artifact_dir = layout.artifact_dir(&NodeId::from("final-report"));
        let workspace_dir = layout.workspace_dir(&NodeId::from("final-report"));
        let rendered_path = render_agentic_prompt(
            &ctx,
            &artifact_dir,
            project.path(),
            &workspace_dir,
            &NodeId::from("final-report"),
            Path::new("review/final-report.md"),
            0,
            1,
            LoopMode::Parallel,
            &artifact_dir.join("findings.json"),
            &artifact_dir.join("patch.diff"),
            &artifact_dir.join("metadata.json"),
            &[],
        )
        .unwrap();
        let rendered = fs::read_to_string(rendered_path).unwrap();

        assert!(rendered.contains("Read `reporting_guidance` before rendering status"));
        assert!(rendered.contains("\"snapshot_phase\": \"final-report-in-progress\""));
        assert!(rendered.contains("\"restart_guidance_for_report\": null"));
        assert!(rendered.contains("Do not state that the completed campaign is stale"));
        assert!(rendered.contains("do not render `final-report running`"));
    }

    #[test]
    fn topology_prompts_are_loaded_from_project_root_not_target_repo() {
        let project = tempfile::tempdir().unwrap();
        let target_repo = tempfile::tempdir().unwrap();
        let prompt_dir = project.path().join(".ultrafuzz/prompts/setup");
        fs::create_dir_all(&prompt_dir).unwrap();
        fs::write(
            prompt_dir.join("custom-node.md"),
            "---\nid: custom-node\n---\n# Project-owned prompt\nRepo {{ repo_path }}\nTests {{strategy_attempt_test_dir}}\n",
        )
        .unwrap();

        let run_id = RunId::from("run");
        let node = Node {
            id: NodeId::from("custom-node"),
            label: "Custom node".to_owned(),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from("custom-node"),
                prompt_path: PathBuf::from("setup/custom-node.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: vec![PathBuf::from("custom-output.json")],
                primary_artifact: Some(PathBuf::from("custom-output.json")),
            },
            depends_on: vec![NodeId::from(START_NODE_ID)],
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/custom-node"),
        };
        let graph = CampaignGraph {
            run_id: run_id.clone(),
            graph_version: ultrafuzz_topology::GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![meta_node(MetaNodeRole::Start, &[]), node],
        };
        let mut resolved_config = CampaignConfig::default();
        resolved_config.project.repo = target_repo.path().to_path_buf();
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let result = DagExecutor::default()
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let rendered = fs::read_to_string(
            layout
                .artifact_dir(&NodeId::from("custom-node"))
                .join(RENDERED_PROMPT_FILE),
        )
        .unwrap();
        assert!(rendered.contains("# Project-owned prompt"));
        assert!(rendered.contains(&target_repo.path().display().to_string()));
        assert!(rendered.contains(
            "Use the Workspace path for all repository inspection, builds, tests, and edits"
        ));
        assert!(rendered.contains("original target repository is not a command target"));
        assert!(rendered.contains("Do not synthesize patches by comparing files to `/dev/null`"));
        assert!(rendered.contains(
            "Wrong: `git diff --no-index /dev/null test/foundry/SetupInvariantSanity.t.sol`"
        ));
        assert!(rendered.contains("let Ultrafuzz record workspace changes"));
        assert!(rendered.contains("For Read, Edit, and Write tool file paths"));
        assert!(rendered.contains("including the `/workspaces/<node>` segment"));
        assert!(rendered.contains("rewrite it to the same relative path under the Workspace"));
        assert!(rendered.contains(&format!("- Repository: {}", project.path().display())));
        assert!(rendered.contains("Bash commands already run from the Workspace path"));
        assert!(rendered.contains("Wrong: `cd /path/to/workspace || exit 1; forge --version`"));
        assert!(rendered.contains(
            "Claude Code permission matching runs before Ultrafuzz command-policy checks"
        ));
        assert!(rendered.contains("Do not use pipes (`|`), command chains such as `&&`"));
        assert!(rendered.contains("shell loops (`for`, `while`, `until`)"));
        assert!(rendered.contains("shell conditionals (`if`, `case`, `test` brackets)"));
        assert!(rendered.contains("Wrong: `rg --files contracts | sort | uniq`"));
        assert!(rendered.contains("Use `rg --files contracts` by itself"));
        assert!(rendered.contains("Wrong: `forge build && forge test --match-path"));
        assert!(rendered.contains("Run `forge build`, wait for the result"));
        assert!(rendered.contains("Wrong: `for f in artifacts/*/findings.json"));
        assert!(rendered.contains("Run one `jq` command against one explicit file"));
        assert!(rendered.contains("do not append `2>&1` or pipe output into `head` or `tail`"));
        assert!(rendered.contains("Wrong: `forge build 2>/dev/null; echo \"exit: $?\"`"));
        assert!(rendered.contains(
            "Wrong: `forge build --skip test --no-cache 2>/dev/null; forge test --match-path"
        ));
        assert!(rendered.contains("Wrong: `forge build --json 2>/dev/null | jq empty`"));
        assert!(rendered.contains(
            "the Bash tool result already reports command failure and Ultrafuzz captures stderr"
        ));
        assert!(rendered.contains("find -exec"));
        assert!(rendered.contains("Wrong: `/home/ubuntu/.foundry/bin/forge --version`"));
        assert!(rendered.contains("Use `forge --version`"));
        assert!(rendered.contains("`forge --version`, `solc --version`, `recon --version`"));
        assert!(rendered.contains("record that tool as unavailable in PATH"));
        assert!(rendered.contains("Prefer command flags over inline environment assignments"));
        assert!(
            rendered.contains("Simple `KEY=value` prefixes on allowlisted commands are accepted")
        );
        assert!(rendered.contains("Do not intentionally start commands in the background"));
        assert!(rendered.contains("read Claude task-output spill files such as `/tmp/claude-*`"));
        assert!(
            rendered.contains("Claude may report `<persisted-output>` with `Full output saved to:")
        );
        assert!(rendered.contains("Never read, grep, cat, sed, summarize, count"));
        assert!(rendered.contains("claude-config/.../tool-results"));
        assert!(rendered.contains("Safe read-only filters such as `grep`, `sed`, `jq`, `head`"));
        assert!(rendered.contains("available as standalone commands against explicit files"));
        assert!(rendered.contains("Markdown backticks are shell command substitution"));
        assert!(rendered.contains("use the Edit tool"));
        assert!(
            rendered.contains("generated Foundry tests under strategy attempt test directories")
        );
        assert!(rendered.contains("scratch/debug Solidity files in the Workspace"));
        assert!(rendered.contains("Use `old_string: \"\"` when creating a new file with Edit"));
        assert!(rendered.contains("Bash may create directories with `mkdir -p`"));
        assert!(rendered.contains("Bash must not create or update file contents"));
        assert!(rendered.contains("Wrong: `cat > test/foundry/round-trip/_Debug.t.sol <<'EOF'`"));
        assert!(rendered.contains("Dependency artifact directories are read-only context"));
        assert!(rendered.contains("Backend-internal directories such as `claude-config/`"));
        assert!(rendered.contains("Required Artifacts"));
        assert!(rendered.contains("custom-output.json"));
        assert!(rendered.contains("Timeout: 1800 seconds"));
        assert!(rendered.contains("Finalization reserve"));
        assert!(rendered.contains("at least 300 seconds left"));
        assert!(rendered.contains("Network policy: disabled"));
        assert!(rendered.contains("Do not use native web_search"));
        assert!(rendered.contains("# Generated Test Verification"));
        assert!(rendered.contains(
            "FOUNDRY_TEST=test \"$FOUNDRY_BIN\" test --match-path 'test/foundry/custom-node/*.sol'"
        ));
        assert!(rendered.contains("setup artifacts such as `setup-foundry` or `base-test-setup`"));
        assert!(rendered.contains("Do not treat `forge: command not found` as verification"));
        assert!(rendered.contains("Use the template below only for Ultrafuzz generated tests"));
        assert!(rendered.contains("preserve their existing environment variables"));
        assert!(rendered.contains("Set FOUNDRY_BIN to the absolute forge binary path"));
        assert!(rendered.contains("do not treat a skipped run as passing"));
        assert!(rendered.contains("Write the findings JSON before finishing"));
        assert!(rendered.contains("write `[]` if there are no findings"));
        assert!(rendered.contains("leave the patch file absent"));
        assert!(rendered.contains("Required findings JSON"));
        assert!(rendered.contains("Patch file (only for a real unified diff)"));
        assert!(rendered.contains("artifacts/custom-node/findings.json"));
        assert!(!rendered.contains("\"__start__\""));
        assert!(!rendered.contains("artifacts/__start__/findings.json"));
        assert!(rendered.contains("Structured context:"));
        assert!(rendered.contains("runtime-context.json"));
        let runtime_context_path = layout
            .artifact_dir(&NodeId::from("custom-node"))
            .join(RUNTIME_CONTEXT_FILE);
        assert!(runtime_context_path.is_file());
        let runtime_context: Value =
            serde_json::from_str(&fs::read_to_string(runtime_context_path).unwrap()).unwrap();
        assert_eq!(
            runtime_context["schema_version"],
            "ultrafuzz.agent-runtime-context.v1"
        );
        assert_eq!(runtime_context["node_id"], "custom-node");
        assert_eq!(runtime_context["logical_node_id"], "custom-node");
        assert_eq!(
            runtime_context["workspace"]["path"],
            attempt_workspace_dir(&layout, &NodeId::from("custom-node"), 0)
                .display()
                .to_string()
        );
        assert_eq!(
            runtime_context["required_artifacts"][0]["relative_path"],
            "custom-output.json"
        );
        assert!(layout
            .artifact_dir(&NodeId::from("custom-node"))
            .join("custom-output.json")
            .is_file());
    }

    #[test]
    fn synthetic_runner_renders_looped_ancestor_artifact_references() {
        let project = tempfile::tempdir().unwrap();
        let prompt_root = project.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_root).unwrap();
        fs::write(
            prompt_root.join("source.md"),
            "---\nid: source\n---\nWrite {{artifact_path}}/source.md\n",
        )
        .unwrap();
        fs::write(
            prompt_root.join("consumer.md"),
            "---\nid: consumer\n---\nRead {{artifact_path:source}}/source.md and {{artifact_handoff:source}}.\n",
        )
        .unwrap();

        let mut source_0 = agentic_node("source-0", "source", &[], RetryPolicy::default());
        let mut source_1 = agentic_node("source-1", "source", &[], RetryPolicy::default());
        for node in [&mut source_0, &mut source_1] {
            if let NodeKind::Agentic {
                required_artifacts,
                primary_artifact,
                loop_count,
                ..
            } = &mut node.kind
            {
                *loop_count = 2;
                *required_artifacts = vec![PathBuf::from("source.md")];
                *primary_artifact = Some(PathBuf::from("source.md"));
            }
        }
        let consumer = agentic_node(
            "consumer",
            "consumer",
            &["source-0", "source-1"],
            RetryPolicy::default(),
        );
        let run_id = RunId::from("run");
        let graph = test_graph("run", vec![source_0, source_1, consumer]);
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);

        let result = DagExecutor::default()
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config: CampaignConfig::default(),
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let rendered = fs::read_to_string(
            layout
                .artifact_dir(&NodeId::from("consumer"))
                .join(RENDERED_PROMPT_FILE),
        )
        .unwrap();
        assert!(rendered.contains("- "));
        assert!(rendered.contains("artifacts/source-0/source.md"));
        assert!(rendered.contains("artifacts/source-1/source.md"));
        assert!(!rendered.contains("artifact_handoff:source"));
    }

    #[test]
    fn synthetic_runner_rejects_handoff_without_primary_artifact() {
        let project = tempfile::tempdir().unwrap();
        let prompt_root = project.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_root).unwrap();
        fs::write(
            prompt_root.join("source.md"),
            "---\nid: source\n---\nWrite {{artifact_path}}/source.md\n",
        )
        .unwrap();
        fs::write(
            prompt_root.join("consumer.md"),
            "---\nid: consumer\n---\nRead {{artifact_handoff:source}}.\n",
        )
        .unwrap();

        let mut source = agentic_node("source", "source", &[], RetryPolicy::default());
        if let NodeKind::Agentic {
            required_artifacts, ..
        } = &mut source.kind
        {
            *required_artifacts = vec![PathBuf::from("source.md")];
        }
        let consumer = agentic_node("consumer", "consumer", &["source"], RetryPolicy::default());
        let run_id = RunId::from("run");
        let graph = test_graph("run", vec![source, consumer]);
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);

        let result = DagExecutor::default()
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config: CampaignConfig::default(),
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Failed);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        assert!(state.nodes[&NodeId::from("consumer")]
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("has no primary_artifact")));
    }

    #[test]
    fn synthetic_runner_renders_ancestor_required_artifact_handoff_list() {
        let project = tempfile::tempdir().unwrap();
        let prompt_root = project.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_root).unwrap();
        fs::write(
            prompt_root.join("source.md"),
            "---\nid: source\n---\nWrite {{artifact_path}}/source.md\n",
        )
        .unwrap();
        fs::write(
            prompt_root.join("consumer.md"),
            "---\nid: consumer\n---\nRead:\n{{ancestor_artifacts}}\n",
        )
        .unwrap();

        let mut source_0 = agentic_node("source-0", "source", &[], RetryPolicy::default());
        let mut source_1 = agentic_node("source-1", "source", &[], RetryPolicy::default());
        for node in [&mut source_0, &mut source_1] {
            if let NodeKind::Agentic {
                required_artifacts, ..
            } = &mut node.kind
            {
                *required_artifacts = vec![PathBuf::from("source.md")];
            }
        }
        let consumer = agentic_node(
            "consumer",
            "consumer",
            &["source-0", "source-1"],
            RetryPolicy::default(),
        );
        let run_id = RunId::from("run");
        let graph = test_graph("run", vec![source_0, source_1, consumer]);
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);

        let result = DagExecutor::default()
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config: CampaignConfig::default(),
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let rendered = fs::read_to_string(
            layout
                .artifact_dir(&NodeId::from("consumer"))
                .join(RENDERED_PROMPT_FILE),
        )
        .unwrap();
        assert!(rendered.contains("Read:\n- "));
        assert!(rendered.contains("artifacts/source-0/source.md"));
        assert!(rendered.contains("artifacts/source-1/source.md"));
        assert!(!rendered.contains("{{ancestor_artifacts}}"));
    }

    #[test]
    fn synthetic_runner_uses_logical_dependencies_for_series_ancestor_artifacts() {
        let project = tempfile::tempdir().unwrap();
        let prompt_root = project.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_root).unwrap();
        fs::write(
            prompt_root.join("source.md"),
            "---\nid: source\n---\nWrite {{artifact_path}}/source.md\n",
        )
        .unwrap();
        fs::write(
            prompt_root.join("consumer.md"),
            "---\nid: consumer\n---\nRead:\n{{ancestor_artifacts}}\n",
        )
        .unwrap();

        let mut source = agentic_node("source", "source", &[], RetryPolicy::default());
        if let NodeKind::Agentic {
            required_artifacts, ..
        } = &mut source.kind
        {
            *required_artifacts = vec![PathBuf::from("source.md")];
        }

        let mut consumer_0 = agentic_node(
            "consumer-0",
            "consumer",
            &["source"],
            RetryPolicy::default(),
        );
        let mut consumer_1 = agentic_node(
            "consumer-1",
            "consumer",
            &["consumer-0"],
            RetryPolicy::default(),
        );
        for (node, attempt_index) in [(&mut consumer_0, 0), (&mut consumer_1, 1)] {
            if let NodeKind::Agentic {
                attempt_index: node_attempt_index,
                loop_count,
                loop_mode,
                ..
            } = &mut node.kind
            {
                *node_attempt_index = attempt_index;
                *loop_count = 2;
                *loop_mode = LoopMode::Series;
            }
        }

        let run_id = RunId::from("run");
        let graph = test_graph("run", vec![source, consumer_0, consumer_1]);
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);

        let result = DagExecutor::default()
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config: CampaignConfig::default(),
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let rendered = fs::read_to_string(
            layout
                .artifact_dir(&NodeId::from("consumer-1"))
                .join(RENDERED_PROMPT_FILE),
        )
        .unwrap();
        assert!(rendered.contains("Read:\n- "));
        assert!(rendered.contains("artifacts/source/source.md"));
        assert!(!rendered.contains("artifacts/consumer-0/source.md"));
        assert!(!rendered.contains("{{ancestor_artifacts}}"));
    }

    #[test]
    fn synthetic_runner_renders_exact_dependency_artifact_paths_for_series_predecessor() {
        let project = tempfile::tempdir().unwrap();
        let prompt_root = project.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_root).unwrap();
        fs::write(
            prompt_root.join("coverage.md"),
            "---\nid: coverage\n---\nContinue coverage iteration.\n",
        )
        .unwrap();

        let mut coverage_0 = agentic_node("coverage-0", "coverage", &[], RetryPolicy::default());
        let mut coverage_1 = agentic_node(
            "coverage-1",
            "coverage",
            &["coverage-0"],
            RetryPolicy::default(),
        );
        for (node, attempt_index) in [(&mut coverage_0, 0), (&mut coverage_1, 1)] {
            if let NodeKind::Agentic {
                attempt_index: node_attempt_index,
                loop_count,
                loop_mode,
                required_artifacts,
                ..
            } = &mut node.kind
            {
                *node_attempt_index = attempt_index;
                *loop_count = 2;
                *loop_mode = LoopMode::Series;
                *required_artifacts = vec![
                    PathBuf::from("coverage-goal.json"),
                    PathBuf::from("coverage-report.md"),
                ];
            }
        }

        let run_id = RunId::from("run");
        let graph = test_graph("run", vec![coverage_0, coverage_1]);
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);

        let result = DagExecutor::default()
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config: CampaignConfig::default(),
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let rendered = fs::read_to_string(
            layout
                .artifact_dir(&NodeId::from("coverage-1"))
                .join(RENDERED_PROMPT_FILE),
        )
        .unwrap();
        assert!(rendered.contains("\"required_artifacts\""));
        assert!(rendered.contains("artifacts/coverage-0/coverage-goal.json"));
        assert!(rendered.contains("artifacts/coverage-0/coverage-report.md"));
        assert!(rendered.contains("\"standard_outputs\""));
        assert!(rendered.contains("artifacts/coverage-0/findings.json"));
        assert!(!rendered.contains("artifacts/coverage-0/patch.diff"));
    }

    #[test]
    fn synthetic_runner_preflights_referenced_prompt_artifacts() {
        let project = tempfile::tempdir().unwrap();
        let prompt_root = project.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_root).unwrap();
        fs::write(
            prompt_root.join("source.md"),
            "---\nid: source\n---\n# Source\n",
        )
        .unwrap();
        fs::write(
            prompt_root.join("consumer.md"),
            "---\nid: consumer\n---\nRead {{artifact_path:source}}/missing.md.\n",
        )
        .unwrap();

        let source = agentic_node("source", "source", &[], RetryPolicy::default());
        let consumer = agentic_node("consumer", "consumer", &["source"], RetryPolicy::default());
        let run_id = RunId::from("run");
        let graph = test_graph("run", vec![source, consumer]);
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);

        let result = DagExecutor::default()
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config: CampaignConfig::default(),
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Failed);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        let error = state.nodes[&NodeId::from("consumer")]
            .last_error
            .as_ref()
            .unwrap();
        assert!(error.contains("references missing artifact `missing.md`"));
        assert!(error.contains("ancestor `source`"));
    }

    #[test]
    fn synthetic_agentic_prompt_renders_campaign_tunables() {
        let project = tempfile::tempdir().unwrap();
        let target_repo = tempfile::tempdir().unwrap();
        fs::write(target_repo.path().join("README.md"), "# target\n").unwrap();
        let prompt_root = project.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_root).unwrap();
        fs::write(
            prompt_root.join("priority-node.md"),
            "---\nid: priority-node\n---\ndynamic={{dynamic_strategies_enumerator}}\nthreshold={{invariant_property_priority_threshold}}\nfilter={{invariant_property_priority_filter}}\npriorities={{invariant_property_priorities}}\ntimeout={{invariant_testing_fuzzer_timeout}}\n",
        )
        .unwrap();
        let run_id = RunId::from("run");
        let graph = test_graph(
            "run",
            vec![agentic_node(
                "priority-node",
                "priority-node",
                &[],
                RetryPolicy::default(),
            )],
        );
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let mut config = config(
            r#"
[invariants]
property_priority_threshold = "medium"
invariant_testing_fuzzer_timeout = "45min"
"#,
        );
        config.dynamic_strategies_enumerator = 6;
        config.project.repo = target_repo.path().to_path_buf();

        let result = DagExecutor::default()
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config: config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let rendered = fs::read_to_string(
            layout
                .artifact_dir(&NodeId::from("priority-node"))
                .join(RENDERED_PROMPT_FILE),
        )
        .unwrap();
        assert!(rendered.contains("dynamic=6"));
        assert!(rendered.contains("threshold=medium"));
        assert!(rendered.contains("filter=high- and medium-priority properties"));
        assert!(rendered.contains("priorities=high, medium"));
        assert!(rendered.contains("timeout=45min"));
    }

    #[test]
    fn looped_agentic_attempts_render_deterministic_assignments_without_sub_agent_directives() {
        let project = tempfile::tempdir().unwrap();
        let target_repo = tempfile::tempdir().unwrap();
        fs::write(target_repo.path().join("README.md"), "# target\n").unwrap();
        let prompt_dir = project.path().join(".ultrafuzz/prompts/strategies");
        fs::create_dir_all(&prompt_dir).unwrap();
        fs::write(
            prompt_dir.join("split-strategy.md"),
            "---\nid: split-strategy\n---\n# Split Strategy\n\nBuild a stable zero-based item list. This attempt owns items where `item_index % {{strategy_loop_count}} == {{strategy_loop_index}}`. Write {{artifact_path}}/assignment.json.\n",
        )
        .unwrap();

        let backend = project.path().join("fake-loop-backend.sh");
        write_executable_script(
            &backend,
            r#"#!/bin/sh
set -eu
prompt="$(cat)"
case "$prompt" in
  *sub-agent*|*subagents*|*"maximum reasoning"*|*"tool-router"*)
    echo "unsupported directive reached backend" >&2
    exit 17
    ;;
esac
case "$prompt" in
  *"item_index % 3 == ${ULTRAFUZZ_ATTEMPT_INDEX}"*) ;;
  *)
    echo "missing deterministic assignment for attempt ${ULTRAFUZZ_ATTEMPT_INDEX}" >&2
    exit 18
    ;;
esac
mkdir -p "$ULTRAFUZZ_ARTIFACT_DIR"
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
printf '{"schema_version":"1.0","node_id":"%s","attempt_index":%s}\n' "$ULTRAFUZZ_NODE_ID" "$ULTRAFUZZ_ATTEMPT_INDEX" > "$ULTRAFUZZ_ARTIFACT_DIR/assignment.json"
printf '{"ok":true}\n' > "$ULTRAFUZZ_OUTPUT_METADATA_PATH"
"#,
        );

        let run_id = RunId::from("run");
        let mut resolved_config = CampaignConfig::default();
        resolved_config.project.repo = target_repo.path().to_path_buf();
        resolved_config.run.workspace_mode = ultrafuzz_core::WorkspaceMode::TempdirCopy;
        resolved_config.backend.codex_cli.command = backend.display().to_string();
        resolved_config.permissions.allow_dangerous_bypass = true;
        resolved_config.run.default_timeout_seconds = 5;
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: ultrafuzz_topology::TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![
                TopologyNode {
                    id: NodeId::from(START_NODE_ID),
                    kind: TopologyNodeKind::Meta,
                    role: Some(MetaNodeRole::Start),
                    prompt: None,
                    reference: None,
                    group: None,
                    depends_on: Vec::new(),
                    loops: 1,
                    loop_mode: LoopMode::Parallel,
                    timeout_seconds: None,
                    required_artifacts: Vec::new(),
                    primary_artifact: None,
                },
                TopologyNode {
                    id: NodeId::from("split-strategy"),
                    kind: TopologyNodeKind::Agentic,
                    role: None,
                    prompt: Some(PathBuf::from("strategies/split-strategy.md")),
                    reference: None,
                    group: None,
                    depends_on: vec![NodeId::from(START_NODE_ID)],
                    loops: 3,
                    loop_mode: LoopMode::Parallel,
                    timeout_seconds: Some(5),
                    required_artifacts: vec![PathBuf::from("assignment.json")],
                    primary_artifact: None,
                },
                TopologyNode {
                    id: NodeId::from(FINISH_NODE_ID),
                    kind: TopologyNodeKind::Meta,
                    role: Some(MetaNodeRole::Finish),
                    prompt: None,
                    reference: None,
                    group: None,
                    depends_on: vec![NodeId::from("split-strategy")],
                    loops: 1,
                    loop_mode: LoopMode::Parallel,
                    timeout_seconds: None,
                    required_artifacts: Vec::new(),
                    primary_artifact: None,
                },
            ],
        };
        let graph = build_campaign_graph_from_topology(
            run_id.clone(),
            project.path(),
            &resolved_config,
            topology,
        )
        .unwrap();
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&resolved_config),
            Arc::new(CampaignNodeRunner::default()),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        for index in 0..3 {
            let node_id = NodeId::from(format!("split-strategy-{index}"));
            let artifact_dir = layout.artifact_dir(&node_id);
            let rendered = fs::read_to_string(artifact_dir.join(RENDERED_PROMPT_FILE)).unwrap();
            assert!(rendered.contains(&format!("item_index % 3 == {index}")));
            assert!(!rendered.contains("sub-agent"));
            assert!(!rendered.contains("subagents"));
            assert!(artifact_dir.join("assignment.json").is_file());
            assert!(artifact_dir.join(ARTIFACT_MANIFEST_FILE).is_file());
        }
    }

    #[test]
    fn agentic_prompt_with_sub_agent_directive_reaches_backend() {
        let project = tempfile::tempdir().unwrap();
        let target_repo = tempfile::tempdir().unwrap();
        fs::write(target_repo.path().join("README.md"), "# target\n").unwrap();
        let prompt_dir = project.path().join(".ultrafuzz/prompts/strategies");
        fs::create_dir_all(&prompt_dir).unwrap();
        fs::write(
            prompt_dir.join("bad.md"),
            "---\nid: bad\n---\nUsing sub-agents with maximum reasoning, create one file for each target.\n",
        )
        .unwrap();

        let backend = project.path().join("fake-should-not-run.sh");
        write_executable_script(
            &backend,
            r#"#!/bin/sh
set -eu
touch "$ULTRAFUZZ_ARTIFACT_DIR/backend-ran"
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
"#,
        );

        let run_id = RunId::from("run");
        let node = Node {
            id: NodeId::from("bad"),
            label: "Bad".to_owned(),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from("bad"),
                prompt_path: PathBuf::from("strategies/bad.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: Vec::new(),
            timeout: Some(Duration::from_secs(5)),
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/bad"),
        };
        let graph = test_graph("run", vec![node]);
        let mut resolved_config = CampaignConfig::default();
        resolved_config.project.repo = target_repo.path().to_path_buf();
        resolved_config.run.workspace_mode = ultrafuzz_core::WorkspaceMode::TempdirCopy;
        resolved_config.backend.codex_cli.command = backend.display().to_string();
        resolved_config.permissions.allow_dangerous_bypass = true;
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&resolved_config),
            Arc::new(CampaignNodeRunner::default()),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_eq!(result.status, RunStatus::Succeeded);
        let artifact_dir = layout.artifact_dir(&NodeId::from("bad"));
        assert!(artifact_dir.join("backend-ran").exists());
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        assert!(state.nodes[&NodeId::from("bad")].last_error.is_none());
    }

    #[test]
    fn agentic_nodes_use_default_model_profile_for_backend_command() {
        let project = tempfile::tempdir().unwrap();
        let target_repo = tempfile::tempdir().unwrap();
        fs::write(target_repo.path().join("README.md"), "# target\n").unwrap();
        let prompt_dir = project.path().join(".ultrafuzz/prompts/setup");
        fs::create_dir_all(&prompt_dir).unwrap();
        fs::write(
            prompt_dir.join("discover.md"),
            "---\nid: discover\n---\n# Discover\n",
        )
        .unwrap();

        let backend = project.path().join("fake-model-backend.sh");
        write_executable_script(
            &backend,
            r#"#!/bin/sh
set -eu
case " $* " in
  *" --model gpt-default "*) ;;
  *)
    echo "missing default model flag: $*" >&2
    exit 19
    ;;
esac
test "${ULTRAFUZZ_MODEL_ID:-}" = "default"
test "${ULTRAFUZZ_MODEL:-}" = "gpt-default"
test "${ULTRAFUZZ_MODEL_INDEX:-}" = "0"
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
printf '{"ok":true}\n' > "$ULTRAFUZZ_OUTPUT_METADATA_PATH"
"#,
        );

        let run_id = RunId::from("run");
        let node = Node {
            id: NodeId::from("discover"),
            label: "Discover".to_owned(),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from("discover"),
                prompt_path: PathBuf::from("setup/discover.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: Vec::new(),
            timeout: Some(Duration::from_secs(5)),
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/discover"),
        };
        let graph = test_graph("run", vec![node]);
        let mut resolved_config = CampaignConfig::default();
        resolved_config.project.repo = target_repo.path().to_path_buf();
        resolved_config.run.workspace_mode = ultrafuzz_core::WorkspaceMode::TempdirCopy;
        resolved_config.backend.codex_cli.command = backend.display().to_string();
        resolved_config.permissions.allow_dangerous_bypass = true;
        let default_profile = resolved_config
            .models
            .profiles
            .iter_mut()
            .find(|profile| profile.id == resolved_config.models.default)
            .unwrap();
        default_profile.model = Some("gpt-default".to_owned());
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&resolved_config),
            Arc::new(CampaignNodeRunner::default()),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_run_succeeded(&result, &layout);
        let state = RunStateStore::for_run_root(&layout.root).load().unwrap();
        let node_state = &state.nodes[&NodeId::from("discover")];
        assert_eq!(node_state.model_id, Some(ModelProfileId::from("default")));
        assert_eq!(node_state.model.as_deref(), Some("gpt-default"));
        assert_eq!(node_state.model_index, Some(0));
    }

    #[test]
    fn agentic_nodes_pass_ancestor_artifacts_as_backend_context_dirs() {
        let project = tempfile::tempdir().unwrap();
        let target_repo = tempfile::tempdir().unwrap();
        fs::write(target_repo.path().join("README.md"), "# target\n").unwrap();
        let prompt_root = project.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_root).unwrap();
        fs::write(
            prompt_root.join("source.md"),
            "---\nid: source\n---\n# Source\n",
        )
        .unwrap();
        fs::write(
            prompt_root.join("consumer.md"),
            "---\nid: consumer\n---\n# Consumer\n",
        )
        .unwrap();

        let backend = project.path().join("fake-context-backend.sh");
        write_executable_script(
            &backend,
            r#"#!/bin/sh
set -eu
cat >/dev/null
printf '%s\n' "$*" > "$ULTRAFUZZ_ARTIFACT_DIR/backend-args.txt"
if [ "$ULTRAFUZZ_NODE_ID" = "source" ]; then
  mkdir -p test/foundry/source
  printf '// generated source test\n' > test/foundry/source/Generated.t.sol
  printf 'source handoff\n' > "$ULTRAFUZZ_ARTIFACT_DIR/source.md"
fi
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
printf '{"ok":true}\n' > "$ULTRAFUZZ_OUTPUT_METADATA_PATH"
"#,
        );

        let mut source = agentic_node("source", "source", &[], RetryPolicy::default());
        if let NodeKind::Agentic {
            required_artifacts,
            primary_artifact,
            ..
        } = &mut source.kind
        {
            *required_artifacts = vec![PathBuf::from("source.md")];
            *primary_artifact = Some(PathBuf::from("source.md"));
        }
        let consumer = agentic_node("consumer", "consumer", &["source"], RetryPolicy::default());
        let run_id = RunId::from("run");
        let graph = test_graph("run", vec![source, consumer]);
        let mut resolved_config = CampaignConfig::default();
        resolved_config.project.repo = target_repo.path().to_path_buf();
        resolved_config.run.workspace_mode = ultrafuzz_core::WorkspaceMode::TempdirCopy;
        resolved_config.run.default_timeout_seconds = 5;
        resolved_config.backend.codex_cli.command = backend.display().to_string();
        resolved_config.permissions.allow_dangerous_bypass = true;
        resolved_config
            .permissions
            .write_allow
            .push("extra-context".to_owned());
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&resolved_config),
            Arc::new(CampaignNodeRunner::default()),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_run_succeeded(&result, &layout);
        let consumer_args = fs::read_to_string(
            layout
                .artifact_dir(&NodeId::from("consumer"))
                .join("backend-args.txt"),
        )
        .unwrap();
        let source_artifact_dir = layout.artifact_dir(&NodeId::from("source"));
        assert!(consumer_args.contains(&format!("--add-dir {}", source_artifact_dir.display())));
        assert!(!consumer_args.contains("artifacts/__start__"));
    }

    #[test]
    fn agentic_aggregate_does_not_get_target_repo_context_dir() {
        let project = tempfile::tempdir().unwrap();
        let target_repo = tempfile::tempdir().unwrap();
        fs::create_dir_all(target_repo.path().join("test")).unwrap();
        let prompt_root = project.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_root).unwrap();
        fs::write(
            prompt_root.join("source.md"),
            "---\nid: source\n---\n# Source\n",
        )
        .unwrap();
        fs::write(
            prompt_root.join("aggregate-test-files.md"),
            "---\nid: aggregate-test-files\n---\n# Aggregate\n",
        )
        .unwrap();

        let backend = project.path().join("fake-aggregate-context-backend.sh");
        write_executable_script(
            &backend,
            r#"#!/bin/sh
set -eu
cat >/dev/null
printf '%s\n' "$*" > "$ULTRAFUZZ_ARTIFACT_DIR/backend-args.txt"
if [ "$ULTRAFUZZ_NODE_ID" = "source" ]; then
  printf 'source handoff\n' > "$ULTRAFUZZ_ARTIFACT_DIR/source.md"
fi
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
printf '{"ok":true}\n' > "$ULTRAFUZZ_OUTPUT_METADATA_PATH"
"#,
        );

        let mut source = agentic_node("source", "source", &[], RetryPolicy::default());
        if let NodeKind::Agentic {
            required_artifacts,
            primary_artifact,
            ..
        } = &mut source.kind
        {
            *required_artifacts = vec![PathBuf::from("source.md")];
            *primary_artifact = Some(PathBuf::from("source.md"));
        }
        let aggregate = agentic_node(
            "aggregate-test-files",
            "aggregate-test-files",
            &["source"],
            RetryPolicy::default(),
        );
        let run_id = RunId::from("run");
        let graph = test_graph("run", vec![source, aggregate]);
        let mut resolved_config = CampaignConfig::default();
        resolved_config.project.repo = target_repo.path().to_path_buf();
        resolved_config.run.workspace_mode = ultrafuzz_core::WorkspaceMode::TempdirCopy;
        resolved_config.run.default_timeout_seconds = 5;
        resolved_config.backend.codex_cli.command = backend.display().to_string();
        resolved_config.permissions.allow_dangerous_bypass = true;
        resolved_config
            .permissions
            .write_allow
            .push("extra-context".to_owned());
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&resolved_config),
            Arc::new(CampaignNodeRunner::default()),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_run_succeeded(&result, &layout);
        let aggregate_args = fs::read_to_string(
            layout
                .artifact_dir(&NodeId::from("aggregate-test-files"))
                .join("backend-args.txt"),
        )
        .unwrap();
        let source_artifact_dir = layout.artifact_dir(&NodeId::from("source"));
        let run_artifacts_dir = layout.artifacts.clone();
        let aggregate_words = aggregate_args.split_whitespace().collect::<Vec<_>>();
        assert!(aggregate_words
            .windows(2)
            .any(|window| window[0] == "--add-dir"
                && window[1] == source_artifact_dir.to_str().unwrap()));
        assert!(aggregate_words
            .windows(2)
            .any(|window| window[0] == "--add-dir"
                && window[1] == run_artifacts_dir.to_str().unwrap()));
        assert!(!aggregate_args.contains(&format!("--add-dir {}", target_repo.path().display())));
        let rendered = fs::read_to_string(
            layout
                .artifact_dir(&NodeId::from("aggregate-test-files"))
                .join(RENDERED_PROMPT_FILE),
        )
        .unwrap();
        assert!(rendered.contains("original target repository is not a command target"));
        assert!(
            rendered.contains("the run artifact directory are read-only campaign evidence sources")
        );
        assert!(rendered.contains("do not list, read, or copy from sibling workspaces"));
        assert!(rendered.contains("do not write Bash loops to pre-count artifacts"));
        assert!(rendered.contains("standard_outputs[*].findings_json"));
        assert!(rendered.contains("consult setup or discovery artifacts"));
        assert!(rendered.contains("For this aggregate-test-files node only"));
        assert!(rendered.contains("the Workspace is the only destination root"));
        assert!(rendered.contains("destination_path` must be an absolute path under the Workspace"));
        assert!(rendered.contains("Ultrafuzz pre-populates this aggregate node's Workspace"));
        assert!(layout
            .artifact_dir(&NodeId::from("aggregate-test-files"))
            .join("aggregation.json")
            .exists());
        let runtime_context: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(
                layout
                    .artifact_dir(&NodeId::from("aggregate-test-files"))
                    .join(RUNTIME_CONTEXT_FILE),
            )
            .unwrap(),
        )
        .unwrap();
        let aggregation_destination = runtime_context["materialization"]
            ["aggregation_destination_dir"]
            .as_str()
            .unwrap();
        let workspace_path = runtime_context["workspace"]["path"].as_str().unwrap();
        assert!(aggregation_destination.starts_with(workspace_path));
        assert!(!aggregation_destination.starts_with(target_repo.path().to_str().unwrap()));
        let source_args = fs::read_to_string(
            layout
                .artifact_dir(&NodeId::from("source"))
                .join("backend-args.txt"),
        )
        .unwrap();
        assert!(!source_args.contains(&target_repo.path().display().to_string()));
        let source_words = source_args.split_whitespace().collect::<Vec<_>>();
        assert!(!source_words
            .windows(2)
            .any(|window| window[0] == "--add-dir"
                && window[1] == run_artifacts_dir.to_str().unwrap()));
    }

    #[test]
    fn agentic_aggregate_preparation_copies_manifest_declared_files() {
        let project = tempfile::tempdir().unwrap();
        let target_repo = tempfile::tempdir().unwrap();
        let run_id = RunId::from("run");
        let source = agentic_node("source-0", "source", &[], RetryPolicy::default());
        let aggregate = agentic_node(
            "aggregate-test-files",
            "aggregate-test-files",
            &["source-0"],
            RetryPolicy::default(),
        );
        let graph = test_graph("run", vec![source.clone(), aggregate.clone()]);
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let artifact_store = Arc::new(ArtifactStore::new(layout.clone()));
        let source_artifact_dir = layout.artifact_dir(&source.id);
        let source_test_artifact =
            source_artifact_dir.join("generated-tests/test/foundry/source/Generated.t.sol");
        fs::create_dir_all(source_test_artifact.parent().unwrap()).unwrap();
        fs::write(&source_test_artifact, "// generated source test\n").unwrap();
        fs::write(
            source_artifact_dir.join("generated-tests.json"),
            serde_json::to_string_pretty(&json!({
                "schema_version": "1.0",
                "node_id": "source-0",
                "strategy": "source",
                "attempt_index": 0,
                "test_files": [{
                    "artifact_path": "generated-tests/test/foundry/source/Generated.t.sol",
                    "source_relative_path": "test/foundry/source/Generated.t.sol",
                    "bytes": 25
                }],
                "support_files": []
            }))
            .unwrap(),
        )
        .unwrap();

        let mut resolved_config = CampaignConfig::default();
        resolved_config.project.repo = target_repo.path().to_path_buf();
        let aggregate_artifact_dir = layout.artifact_dir(&aggregate.id);
        let aggregate_workspace = layout.workspace_dir(&aggregate.id);
        let ctx = NodeContext {
            run_id: layout.run_id.clone(),
            node: aggregate.clone(),
            graph,
            project_root: project.path().to_path_buf(),
            resolved_config,
            artifact_store,
            artifact_dir: aggregate_artifact_dir.clone(),
            workspace_dir: aggregate_workspace.clone(),
            run_state: RunStateStore::for_run_root(&layout.root),
            event_sink: Arc::new(NullEventSink),
            prompt_registry: PromptRegistry::built_in().unwrap(),
        };
        fs::create_dir_all(&aggregate_workspace).unwrap();

        let aggregation_path = prepare_agentic_aggregate_workspace(
            &ctx,
            &aggregate_artifact_dir,
            &aggregate_workspace,
        )
        .unwrap();
        validate_agentic_aggregate_workspace_outputs(&aggregate_artifact_dir, &aggregate_workspace)
            .unwrap();

        let aggregation: Value =
            serde_json::from_str(&fs::read_to_string(aggregation_path).unwrap()).unwrap();
        assert_eq!(aggregation["source_test_files"], 1);
        assert_eq!(aggregation["copied_test_files"], 1);
        let files = aggregation["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0]["destination_relative_path"],
            "test/foundry/source/attempt-0/Generated.t.sol"
        );
        assert_eq!(
            fs::read_to_string(
                aggregate_workspace.join("test/foundry/source/attempt-0/Generated.t.sol")
            )
            .unwrap(),
            "// generated source test\n"
        );
    }

    #[test]
    fn agentic_property_specification_fanin_mirrors_catalog_to_compatibility_dir() {
        let repo = tempfile::tempdir().unwrap();
        let (ctx, root) = test_context(
            repo.path(),
            "property-specification-fanin",
            NodeKind::Agentic {
                logical_id: NodeId::from("property-specification-fanin"),
                prompt_path: PathBuf::from("properties/property-specification-fanin.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: vec![PathBuf::from(PROPERTY_SPECIFICATION_FILE)],
                primary_artifact: Some(PathBuf::from(PROPERTY_SPECIFICATION_FILE)),
            },
        );
        let artifact_dir = ctx.artifact_dir.clone();
        fs::create_dir_all(&artifact_dir).unwrap();
        fs::write(
            artifact_dir.join(PROPERTY_SPECIFICATION_FILE),
            "{\"candidate_properties\":[]}\n",
        )
        .unwrap();
        let findings_path = artifact_dir.join(FINDINGS_FILE);
        fs::write(&findings_path, "[]\n").unwrap();

        let mirrored = mirror_agentic_compatibility_artifacts(
            &ctx,
            &artifact_dir,
            &NodeId::from("property-specification-fanin"),
            &[PathBuf::from(PROPERTY_SPECIFICATION_FILE)],
            &findings_path,
        )
        .unwrap();

        let compatibility_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from(PROPERTY_SPECIFICATION_COMPAT_DIR));
        assert_eq!(mirrored.len(), 2);
        assert_eq!(
            fs::read_to_string(compatibility_dir.join(PROPERTY_SPECIFICATION_FILE)).unwrap(),
            "{\"candidate_properties\":[]}\n"
        );
        assert_eq!(
            fs::read_to_string(compatibility_dir.join(FINDINGS_FILE)).unwrap(),
            "[]\n"
        );
        drop(root);
    }

    #[test]
    fn agentic_nodes_replay_dependency_workspace_changes() {
        let project = tempfile::tempdir().unwrap();
        let target_repo = tempfile::tempdir().unwrap();
        fs::write(target_repo.path().join("README.md"), "# target\n").unwrap();
        let prompt_dir = project.path().join(".ultrafuzz/prompts/setup");
        fs::create_dir_all(&prompt_dir).unwrap();
        fs::write(
            prompt_dir.join("setup.md"),
            "---\nid: setup\n---\n# Setup\n",
        )
        .unwrap();
        fs::write(
            prompt_dir.join("verify.md"),
            "---\nid: verify\n---\n# Verify\n",
        )
        .unwrap();
        fs::write(
            prompt_dir.join("audit.md"),
            "---\nid: audit\n---\n# Audit\n",
        )
        .unwrap();

        let backend = project.path().join("fake-agentic-backend.sh");
        fs::write(
            &backend,
            r#"#!/bin/sh
set -eu
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
case "${ULTRAFUZZ_NODE_ID:-}" in
  setup)
    mkdir -p "$ULTRAFUZZ_WORKSPACE_PATH/test/foundry"
    printf '[profile.default]\nsrc = "contracts"\n' > "$ULTRAFUZZ_WORKSPACE_PATH/foundry.toml"
    printf 'contract BaseTest {}\n' > "$ULTRAFUZZ_WORKSPACE_PATH/test/foundry/BaseTest.t.sol"
    ;;
  audit)
    test -f "$ULTRAFUZZ_WORKSPACE_PATH/foundry.toml"
    test -f "$ULTRAFUZZ_WORKSPACE_PATH/test/foundry/BaseTest.t.sol"
    ;;
  verify)
    test -f "$ULTRAFUZZ_WORKSPACE_PATH/foundry.toml"
    test -f "$ULTRAFUZZ_WORKSPACE_PATH/test/foundry/BaseTest.t.sol"
    ;;
esac
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&backend).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&backend, permissions).unwrap();

        let run_id = RunId::from("run");
        let setup = Node {
            id: NodeId::from("setup"),
            label: "Setup".to_owned(),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from("setup"),
                prompt_path: PathBuf::from("setup/setup.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: Vec::new(),
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/setup"),
        };
        let audit = Node {
            id: NodeId::from("audit"),
            label: "Audit".to_owned(),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from("audit"),
                prompt_path: PathBuf::from("setup/audit.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: vec![NodeId::from("setup")],
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/audit"),
        };
        let verify = Node {
            id: NodeId::from("verify"),
            label: "Verify".to_owned(),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from("verify"),
                prompt_path: PathBuf::from("setup/verify.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: vec![NodeId::from("audit")],
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/verify"),
        };
        let graph = CampaignGraph {
            run_id: run_id.clone(),
            graph_version: ultrafuzz_topology::GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![setup, audit, verify],
        };
        let mut resolved_config = CampaignConfig::default();
        resolved_config.project.repo = target_repo.path().to_path_buf();
        resolved_config.run.workspace_mode = ultrafuzz_core::WorkspaceMode::TempdirCopy;
        resolved_config.backend.codex_cli.command = backend.display().to_string();
        resolved_config.permissions.allow_dangerous_bypass = true;
        resolved_config
            .permissions
            .write_allow
            .push("extra-context".to_owned());
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&resolved_config),
            Arc::new(CampaignNodeRunner::default()),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_run_succeeded(&result, &layout);
        assert!(layout
            .artifact_dir(&NodeId::from("setup"))
            .join("workspace-changes/foundry.toml")
            .is_file());
        assert!(layout
            .artifact_dir(&NodeId::from("setup"))
            .join("workspace-changes/test/foundry/BaseTest.t.sol")
            .is_file());
        let audit_changes = read_json_value(
            layout
                .artifact_dir(&NodeId::from("audit"))
                .join(WORKSPACE_CHANGES_MANIFEST),
        )
        .unwrap();
        assert_eq!(
            audit_changes["files"].as_array().unwrap().len(),
            0,
            "read-only intermediate nodes should not re-export unchanged dependency workspace files"
        );
        let verify_changes = read_json_value(
            layout
                .artifact_dir(&NodeId::from("verify"))
                .join(WORKSPACE_CHANGES_MANIFEST),
        )
        .unwrap();
        assert_eq!(
            verify_changes["files"].as_array().unwrap().len(),
            0,
            "dependent nodes should not re-export unchanged dependency workspace files"
        );
        assert!(!layout
            .artifact_dir(&NodeId::from("verify"))
            .join("workspace-changes/foundry.toml")
            .exists());
        assert!(!layout
            .artifact_dir(&NodeId::from("verify"))
            .join("workspace-changes/test/foundry/BaseTest.t.sol")
            .exists());
        assert!(!target_repo.path().join("foundry.toml").exists());
    }

    #[test]
    fn dependency_workspace_change_conflicts_preserve_first_dependency() {
        let project = tempfile::tempdir().unwrap();
        let target_repo = tempfile::tempdir().unwrap();
        fs::write(target_repo.path().join("README.md"), "# target\n").unwrap();
        let prompt_dir = project.path().join(".ultrafuzz/prompts/setup");
        fs::create_dir_all(&prompt_dir).unwrap();
        for prompt in ["newer.md", "stale.md", "verify.md"] {
            fs::write(
                prompt_dir.join(prompt),
                format!(
                    "---\nid: {}\n---\n# Prompt\n",
                    prompt.trim_end_matches(".md")
                ),
            )
            .unwrap();
        }

        let backend = project.path().join("fake-conflict-backend.sh");
        fs::write(
            &backend,
            r#"#!/bin/sh
set -eu
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
case "${ULTRAFUZZ_NODE_ID:-}" in
  newer)
    printf '[profile.default]\ntest = "test"\n' > "$ULTRAFUZZ_WORKSPACE_PATH/foundry.toml"
    ;;
  stale)
    printf '[profile.default]\ntest = "test/foundry"\n' > "$ULTRAFUZZ_WORKSPACE_PATH/foundry.toml"
    ;;
  verify)
    grep 'test = "test"' "$ULTRAFUZZ_WORKSPACE_PATH/foundry.toml"
    if grep 'test = "test/foundry"' "$ULTRAFUZZ_WORKSPACE_PATH/foundry.toml"; then
      exit 2
    fi
    ;;
esac
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&backend).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&backend, permissions).unwrap();

        let run_id = RunId::from("run");
        let newer = Node {
            id: NodeId::from("newer"),
            label: "Newer".to_owned(),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from("newer"),
                prompt_path: PathBuf::from("setup/newer.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: Vec::new(),
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/newer"),
        };
        let stale = Node {
            id: NodeId::from("stale"),
            label: "Stale".to_owned(),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from("stale"),
                prompt_path: PathBuf::from("setup/stale.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: Vec::new(),
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/stale"),
        };
        let verify = Node {
            id: NodeId::from("verify"),
            label: "Verify".to_owned(),
            kind: NodeKind::Agentic {
                logical_id: NodeId::from("verify"),
                prompt_path: PathBuf::from("setup/verify.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: vec![NodeId::from("newer"), NodeId::from("stale")],
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/verify"),
        };
        let graph = CampaignGraph {
            run_id: run_id.clone(),
            graph_version: ultrafuzz_topology::GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![newer, stale, verify],
        };
        let mut resolved_config = CampaignConfig::default();
        resolved_config.project.repo = target_repo.path().to_path_buf();
        resolved_config.run.workspace_mode = ultrafuzz_core::WorkspaceMode::TempdirCopy;
        resolved_config.backend.codex_cli.command = backend.display().to_string();
        resolved_config.permissions.allow_dangerous_bypass = true;
        resolved_config
            .permissions
            .write_allow
            .push("extra-context".to_owned());
        let layout = ultrafuzz_artifacts::RunLayout::new(project.path().join("runs"), run_id);
        let executor = DagExecutor::new(
            ExecutorConfig::from_campaign_config(&resolved_config),
            Arc::new(CampaignNodeRunner::default()),
        );

        let result = executor
            .execute(ExecutionRequest {
                graph,
                project_root: project.path().to_path_buf(),
                resolved_config,
                prompt_registry: PromptRegistry::built_in().unwrap(),
                artifact_store: ArtifactStore::new(layout.clone()),
                state_store: RunStateStore::for_run_root(&layout.root),
                event_sink: Arc::new(NullEventSink),
                source_run_id: None,
            })
            .unwrap();

        assert_run_succeeded(&result, &layout);
        let conflict_report_path = layout
            .artifact_dir(&NodeId::from("verify"))
            .join(DEPENDENCY_WORKSPACE_CHANGE_CONFLICTS_FILE);
        let conflict_report: Value =
            serde_json::from_str(&fs::read_to_string(conflict_report_path).unwrap()).unwrap();
        let conflicts = conflict_report["conflicts"].as_array().unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0]["path"], "foundry.toml");
        assert_eq!(conflicts[0]["applied_dependency"], "newer");
        assert_eq!(conflicts[0]["skipped_dependency"], "stale");
        assert_eq!(
            conflicts[0]["skipped_artifact_path"],
            "workspace-changes/foundry.toml"
        );
    }

    #[test]
    fn identical_dependency_workspace_changes_do_not_report_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let first_artifacts = temp.path().join("artifacts/first");
        let second_artifacts = temp.path().join("artifacts/second");
        fs::create_dir_all(&workspace).unwrap();

        for artifact_dir in [&first_artifacts, &second_artifacts] {
            let change_dir = artifact_dir.join(WORKSPACE_CHANGES_DIR);
            fs::create_dir_all(&change_dir).unwrap();
            fs::write(
                change_dir.join("foundry.toml"),
                "[profile.default]\ntest = \"test\"\n",
            )
            .unwrap();
            fs::write(
                artifact_dir.join(WORKSPACE_CHANGES_MANIFEST),
                serde_json::to_vec_pretty(&json!({
                    "schema_version": "1.0",
                    "files": [{
                        "path": "foundry.toml",
                        "artifact_path": "workspace-changes/foundry.toml",
                        "bytes": 32,
                    }],
                }))
                .unwrap(),
            )
            .unwrap();
        }

        let mut applied_paths = BTreeMap::new();
        let mut conflicts = Vec::new();
        let graph_dependencies = BTreeMap::new();
        let first_applied = apply_workspace_change_manifest(
            &NodeId::from("first"),
            &first_artifacts,
            &workspace,
            &graph_dependencies,
            &mut applied_paths,
            &mut conflicts,
        )
        .unwrap();
        let second_applied = apply_workspace_change_manifest(
            &NodeId::from("second"),
            &second_artifacts,
            &workspace,
            &graph_dependencies,
            &mut applied_paths,
            &mut conflicts,
        )
        .unwrap();

        assert_eq!(first_applied, 1);
        assert_eq!(second_applied, 0);
        assert!(conflicts.is_empty());
        assert_eq!(
            fs::read_to_string(workspace.join("foundry.toml")).unwrap(),
            "[profile.default]\ntest = \"test\"\n"
        );
    }

    #[test]
    fn property_specification_writes_handoff_artifact() {
        let repo = tempfile::tempdir().unwrap();
        fs::write(repo.path().join("README.md"), "# Protocol\n").unwrap();
        fs::create_dir_all(repo.path().join("docs")).unwrap();
        fs::write(repo.path().join("docs/whitepaper.md"), "# Whitepaper\n").unwrap();
        let node_prompt_dir = repo.path().join(".ultrafuzz/prompts/properties");
        fs::create_dir_all(&node_prompt_dir).unwrap();
        fs::write(
            node_prompt_dir.join("property-specification.md"),
            "---\nid: property-specification\n---\n# Custom property specification\n",
        )
        .unwrap();
        let backend = repo.path().join("fake-property-backend.sh");
        fs::write(
            &backend,
            r#"#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"
catalog="$(printf '%s\n' "$prompt" | awk '/^Write the property catalog to:/{getline; getline; print; exit}')"
findings="$(printf '%s\n' "$prompt" | awk '/^Write structured findings to:/{getline; getline; print; exit}')"
if [[ -z "$catalog" || -z "$findings" ]]; then
  exit 2
fi
mkdir -p "$(dirname "$catalog")"
cat > "$catalog" <<'JSON'
{
  "schema_version": "1.0",
  "documentation_sources": ["README.md", "docs/whitepaper.md"],
  "guidance_applied": ["valid-states", "state-transitions", "high-level-properties"],
  "candidate_properties": [
    {
      "id": "assets-equal-liabilities",
      "title": "Assets equal liabilities",
      "property_type": "high-level",
      "priority": "high",
      "source": "README.md",
      "workflow": "protocol accounting",
      "oracle": "total assets must equal user liabilities plus reserved fees",
      "setup": "deploy protocol, create actors, mint test assets",
      "preconditions": ["protocol initialized"],
      "frameworks": ["Foundry", "Chimera"],
      "failure_classification": "target-bug",
      "notes": []
    }
  ],
  "deferred_or_rejected_properties": []
}
JSON
printf '[]\n' > "$findings"
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&backend).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&backend, permissions).unwrap();

        let runner = CampaignNodeRunner::default();
        let (mut ctx, root) = test_context(
            repo.path(),
            "property-specification",
            NodeKind::PropertySpecification,
        );
        ctx.resolved_config.backend.codex_cli.command = backend.display().to_string();
        ctx.resolved_config.permissions.allow_dangerous_bypass = true;
        let artifact_dir = root.path().join("artifacts").join("property-specification");
        fs::create_dir_all(&artifact_dir).unwrap();
        runner
            .run_property_specification(&ctx, &artifact_dir)
            .unwrap();

        assert!(artifact_dir.join(RENDERED_PROMPT_FILE).is_file());
        let rendered_prompt = fs::read_to_string(artifact_dir.join(RENDERED_PROMPT_FILE)).unwrap();
        assert!(rendered_prompt.contains("# Custom property specification"));
        assert!(rendered_prompt.contains("Write the property catalog to:"));
        let specification: Value =
            read_json_value(artifact_dir.join(PROPERTY_SPECIFICATION_FILE)).unwrap();
        assert_eq!(specification["schema_version"], "1.0");
        assert!(specification["documentation_sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|source| source.as_str() == Some("README.md")));
        assert!(specification["documentation_sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|source| source.as_str() == Some("docs/whitepaper.md")));
        assert_eq!(
            specification["candidate_properties"][0]["id"],
            "assets-equal-liabilities"
        );
        assert!(artifact_dir.join(FINDINGS_FILE).is_file());
        assert!(artifact_dir
            .join("property-specification-metadata.json")
            .is_file());
    }

    #[test]
    fn property_specification_fanin_tolerates_missing_and_failed_lens_inputs() {
        let repo = tempfile::tempdir().unwrap();
        fs::write(repo.path().join("README.md"), "# Protocol\n").unwrap();
        let runner = CampaignNodeRunner::default();
        let (mut ctx, root) = test_context(
            repo.path(),
            "property-specification-fanin",
            NodeKind::PropertySpecificationFanIn,
        );
        ctx.resolved_config.backend.codex_cli.command = "/bin/false".to_owned();
        ctx.graph.nodes.clear();
        ctx.node.depends_on = PropertyLens::ALL
            .into_iter()
            .map(|lens| NodeId::from(lens.node_id()))
            .collect();
        for lens in PropertyLens::ALL {
            ctx.graph.nodes.push(Node {
                id: NodeId::from(lens.node_id()),
                label: lens.label().to_owned(),
                kind: NodeKind::PropertySpecificationLens { lens },
                depends_on: Vec::new(),
                timeout: None,
                retry: RetryPolicy::default(),
                artifact_dir: PathBuf::from("artifacts").join(lens.node_id()),
            });
        }
        ctx.graph.nodes.push(ctx.node.clone());

        let zero_knot_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from(PropertyLens::ZeroKnot.node_id()));
        fs::create_dir_all(&zero_knot_dir).unwrap();
        fs::write(
            zero_knot_dir.join(PROPERTY_LENS_CANDIDATE_FILE),
            serde_json::to_string_pretty(&json!({
                "schema_version": "1.0",
                "lens_id": "0kn0t",
                "lens_display_name": "0kn0t lens",
                "status": "succeeded",
                "candidate_properties": [
                    {
                        "id": "assets-equal-liabilities",
                        "title": "Assets equal liabilities",
                        "source_lens_id": "0kn0t",
                        "source_evidence": ["README.md", "Vault.totalAssets"],
                        "property_type": "high-level",
                        "workflow": "protocol accounting",
                        "oracle": "total assets must equal user liabilities plus reserved fees",
                        "required_setup": "deploy protocol, create actors, mint test assets",
                        "preconditions": ["protocol initialized"],
                        "suggested_fuzzing_framework_or_strategy_fit": "Foundry strict equality",
                        "suggested_priority_signal": "high: accounting invariant",
                        "confidence": "high",
                        "false_positive_or_setup_bias_risks": ["mocked asset balances can hide drift"],
                        "notes": ["candidate from fallback test"]
                    }
                ],
                "errors": []
            }))
            .unwrap(),
        )
        .unwrap();

        let certora_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from(PropertyLens::CertoraThinking.node_id()));
        fs::create_dir_all(&certora_dir).unwrap();
        fs::write(
            certora_dir.join(PROPERTY_LENS_CANDIDATE_FILE),
            serde_json::to_string_pretty(&json!({
                "schema_version": "1.0",
                "lens_id": "certora-thinking",
                "lens_display_name": "Certora Thinking lens",
                "status": "failed",
                "candidate_properties": [],
                "errors": ["backend unavailable"]
            }))
            .unwrap(),
        )
        .unwrap();

        let artifact_dir = ctx.artifact_dir.clone();
        fs::create_dir_all(&artifact_dir).unwrap();
        runner
            .run_property_specification_fanin(&ctx, &artifact_dir)
            .unwrap();

        let catalog_path = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from(PROPERTY_SPECIFICATION_COMPAT_DIR))
            .join(PROPERTY_SPECIFICATION_FILE);
        let catalog = read_json_value(&catalog_path).unwrap();
        assert_eq!(catalog["candidate_properties"][0]["priority"], "high");
        assert_eq!(
            catalog["candidate_properties"][0]["source_lenses"][0],
            "0kn0t"
        );
        assert!(catalog["lens_inputs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|input| input["lens_id"] == "certora-thinking" && input["status"] == "failed"));
        assert!(catalog["lens_inputs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|input| input["lens_id"] == "aviggiano" && input["status"] == "missing-artifact"));
        assert!(catalog["lens_inputs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|input| {
                input["lens_id"] == "josselin-feist" && input["status"] == "missing-artifact"
            }));
        assert!(ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from(PROPERTY_SPECIFICATION_COMPAT_DIR))
            .join(FINDINGS_FILE)
            .is_file());
        let rendered_prompt = fs::read_to_string(artifact_dir.join(RENDERED_PROMPT_FILE)).unwrap();
        assert!(rendered_prompt.contains("topology-required lens artifacts"));
        assert!(rendered_prompt
            .contains("artifacts/property-specification-0kn0t/candidate-properties.json"));
        assert!(rendered_prompt
            .contains("artifacts/property-specification-certora/candidate-properties.json"));
        assert!(rendered_prompt
            .contains("artifacts/property-specification-aviggiano/candidate-properties.json"));
        assert!(rendered_prompt
            .contains("artifacts/property-specification-josselin-feist/candidate-properties.json"));
        assert!(!rendered_prompt.contains("artifacts/property-specification-0kn0t/properties"));
        assert!(!rendered_prompt.contains("{{ancestor_artifacts}}"));
        assert!(!rendered_prompt.contains("{{artifact_path}}/properties/*"));
        drop(root);
    }

    #[test]
    fn property_lens_prompt_loads_project_override() {
        let repo = tempfile::tempdir().unwrap();
        let node_prompt_dir = repo.path().join(".ultrafuzz/prompts/properties");
        fs::create_dir_all(&node_prompt_dir).unwrap();
        fs::write(
            node_prompt_dir.join("0kn0t-lens.md"),
            "---\nid: 0kn0t-lens\n---\n# Custom lens prompt\n",
        )
        .unwrap();

        let prompt = load_node_prompt(repo.path(), "0kn0t-lens.md").unwrap();

        assert!(prompt.contains("Custom lens prompt"));
    }

    #[test]
    fn property_lens_prompt_renders_bundled_reference_source() {
        let repo = tempfile::tempdir().unwrap();
        fs::write(repo.path().join("README.md"), "# Protocol\n").unwrap();
        let (ctx, root) = test_context(
            repo.path(),
            PropertyLens::ZeroKnot.node_id(),
            NodeKind::PropertySpecificationLens {
                lens: PropertyLens::ZeroKnot,
            },
        );
        let artifact_dir = root
            .path()
            .join("artifacts")
            .join(PropertyLens::ZeroKnot.node_id());
        fs::create_dir_all(&artifact_dir).unwrap();

        let rendered_path = render_property_lens_prompt(
            &ctx,
            &artifact_dir,
            PropertyLens::ZeroKnot,
            repo.path(),
            repo.path(),
            &artifact_dir.join(PROPERTY_LENS_CANDIDATE_FILE),
            &artifact_dir.join(FINDINGS_FILE),
            &artifact_dir.join(PATCH_FILE),
            &artifact_dir.join("metadata.json"),
            &[PathBuf::from("README.md")],
        )
        .unwrap();

        let rendered = fs::read_to_string(rendered_path).unwrap();
        assert!(rendered.contains("candidate-properties.json"));
        assert!(rendered.contains("Write this lens candidate artifact to:"));
        assert!(rendered.contains(
            "Use the Workspace path for all repository inspection, builds, tests, and edits"
        ));
        assert!(rendered.contains("original target repository is not a command target"));
        assert!(!rendered.contains("- Repository:"));
        assert!(rendered.contains("Bash commands already run from the Workspace path"));
        assert!(rendered.contains("use the Edit tool"));
        assert!(rendered.contains("Backend-internal directories such as `claude-config/`"));
        assert!(!rendered.contains("- Lens id:"));
        assert!(!rendered.contains("- Lens display name:"));
        assert!(!rendered.contains("# Assigned Reference Sources"));
    }

    #[test]
    fn property_lens_reference_sources_are_offline_labels() {
        for lens in PropertyLens::ALL {
            for source in property_lens_reference_sources(lens) {
                assert!(
                    !source.contains("http://") && !source.contains("https://"),
                    "{lens:?} reference source should not include a remote URL: {source}"
                );
                assert!(
                    !source.contains("github.com"),
                    "{lens:?} reference source should not include a GitHub URL: {source}"
                );
            }
        }
    }

    #[test]
    fn property_specification_catalog_rejects_non_standard_priority() {
        let temp = tempfile::tempdir().unwrap();
        let catalog_path = temp.path().join(PROPERTY_SPECIFICATION_FILE);
        fs::write(
            &catalog_path,
            serde_json::to_string_pretty(&json!({
                "schema_version": "1.0",
                "candidate_properties": [
                    {
                        "id": "critical-priority",
                        "title": "Critical priority",
                        "property_type": "high-level",
                        "priority": "critical",
                        "oracle": "must hold"
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let error = validate_property_specification_catalog(&catalog_path).unwrap_err();

        assert!(error
            .to_string()
            .contains("priority must be exactly high, medium, or low"));
    }

    #[test]
    fn hardhat_harness_is_synced_to_attempt_workspaces() {
        let repo = tempfile::tempdir().unwrap();
        fs::write(
            repo.path().join("hardhat.config.js"),
            "module.exports = {};\n",
        )
        .unwrap();
        fs::create_dir_all(repo.path().join("contracts")).unwrap();
        fs::write(
            repo.path().join("contracts/Token.sol"),
            "contract Token {}\n",
        )
        .unwrap();

        let runner = CampaignNodeRunner::default();
        let (prepare_ctx, prepare_root) = test_context(
            repo.path(),
            "prepare-foundry-harness",
            NodeKind::PrepareFoundryHarness,
        );
        let prepare_artifact_dir = prepare_root
            .path()
            .join("artifacts")
            .join("prepare-foundry-harness");
        fs::create_dir_all(&prepare_artifact_dir).unwrap();
        runner
            .run_prepare_foundry_harness(&prepare_ctx, &prepare_artifact_dir)
            .unwrap();

        let foundry_toml = fs::read_to_string(repo.path().join("foundry.toml")).unwrap();
        assert!(foundry_toml.contains("src = \"contracts\""));
        assert!(foundry_toml.contains("test = \"test/foundry\""));

        let workspace = tempfile::tempdir().unwrap();
        sync_prepared_harness_into_workspace(repo.path(), workspace.path()).unwrap();
        assert!(workspace.path().join("foundry.toml").is_file());
        assert!(!workspace
            .path()
            .join("test/foundry/BaseTest.t.sol")
            .exists());
    }

    #[test]
    fn foundry_project_harness_preparation_keeps_existing_layout() {
        let repo = tempfile::tempdir().unwrap();
        let foundry_toml = "[profile.default]\nsrc = \"src\"\ntest = \"test\"\n";
        fs::write(repo.path().join("foundry.toml"), foundry_toml).unwrap();
        fs::create_dir_all(repo.path().join("src")).unwrap();

        let runner = CampaignNodeRunner::default();
        let (ctx, root) = test_context(
            repo.path(),
            "prepare-foundry-harness",
            NodeKind::PrepareFoundryHarness,
        );
        let artifact_dir = root
            .path()
            .join("artifacts")
            .join("prepare-foundry-harness");
        fs::create_dir_all(&artifact_dir).unwrap();
        runner
            .run_prepare_foundry_harness(&ctx, &artifact_dir)
            .unwrap();

        assert_eq!(
            fs::read_to_string(repo.path().join("foundry.toml")).unwrap(),
            foundry_toml
        );
        let preparation: Value =
            read_json_value(artifact_dir.join("harness-preparation.json")).unwrap();
        assert_eq!(preparation["framework"], "foundry");
        assert_eq!(preparation["hardhat_setup_applied"], false);
        assert!(preparation["changed_files"].as_array().unwrap().is_empty());
    }

    #[test]
    fn mixed_foundry_hardhat_project_retains_existing_foundry_setup() {
        let repo = tempfile::tempdir().unwrap();
        let foundry_toml = "[profile.default]\nsrc = \"src\"\ntest = \"test\"\n";
        fs::write(repo.path().join("foundry.toml"), foundry_toml).unwrap();
        fs::write(
            repo.path().join("hardhat.config.js"),
            "module.exports = {};\n",
        )
        .unwrap();
        fs::create_dir_all(repo.path().join("contracts")).unwrap();
        fs::create_dir_all(repo.path().join("src")).unwrap();

        let discovery = discover_project(repo.path());
        assert_eq!(discovery.framework, "mixed-foundry-hardhat");
        assert!(discovery.is_foundry);
        assert!(discovery.is_hardhat);
        assert!(discovery
            .decisions
            .iter()
            .any(|decision| decision.contains("already Foundry-capable")));

        let runner = CampaignNodeRunner::default();
        let (ctx, root) = test_context(
            repo.path(),
            "prepare-foundry-harness",
            NodeKind::PrepareFoundryHarness,
        );
        let artifact_dir = root
            .path()
            .join("artifacts")
            .join("prepare-foundry-harness");
        fs::create_dir_all(&artifact_dir).unwrap();
        runner
            .run_prepare_foundry_harness(&ctx, &artifact_dir)
            .unwrap();

        assert_eq!(
            fs::read_to_string(repo.path().join("foundry.toml")).unwrap(),
            foundry_toml
        );
        let preparation: Value =
            read_json_value(artifact_dir.join("harness-preparation.json")).unwrap();
        assert_eq!(preparation["framework"], "mixed-foundry-hardhat");
        assert_eq!(preparation["hardhat_setup_applied"], false);
        assert!(preparation["changed_files"].as_array().unwrap().is_empty());
        assert!(preparation["notes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note
                .as_str()
                .unwrap_or_default()
                .contains("existing Foundry setup was retained")));
    }

    #[test]
    fn hardhat_foundry_toml_update_only_rewrites_src_and_test_keys() {
        let existing =
            "[profile.default]\nsrc = \"src\"\ntest_pattern = \"*Invariant.t.sol\"\noptimizer = true\n";
        let updated = upsert_foundry_profile_defaults(existing);

        assert!(updated.contains("src = \"contracts\""));
        assert!(updated.contains("test = \"test/foundry\""));
        assert!(updated.contains("test_pattern = \"*Invariant.t.sol\""));
        assert!(updated.contains("optimizer = true"));
    }

    #[test]
    fn analogous_base_test_is_discovered_without_creating_base_test() {
        let repo = tempfile::tempdir().unwrap();
        fs::create_dir_all(repo.path().join("test")).unwrap();
        fs::write(
            repo.path().join("test/Setup.t.sol"),
            r#"pragma solidity ^0.8.13;
import "forge-std/Test.sol";
abstract contract Setup is Test {
    function setUp() public virtual {}
}
"#,
        )
        .unwrap();

        let runner = CampaignNodeRunner::default();
        let (discover_ctx, discover_root) = test_context(
            repo.path(),
            "discover-base-test",
            NodeKind::DiscoverBaseTest,
        );
        let discover_artifact_dir = discover_root
            .path()
            .join("artifacts")
            .join("discover-base-test");
        fs::create_dir_all(&discover_artifact_dir).unwrap();
        runner
            .run_discover_base_test(&discover_ctx, &discover_artifact_dir)
            .unwrap();
        let discovery: Value =
            read_json_value(discover_artifact_dir.join("base-test-discovery.json")).unwrap();
        assert_eq!(discovery["missing"], false);
        assert_eq!(
            discovery["analogous_shared_test_paths"][0],
            "test/Setup.t.sol"
        );
        assert!(!repo.path().join("test/foundry/BaseTest.t.sol").exists());
    }

    #[test]
    fn generated_test_collection_is_limited_to_strategy_directory() {
        let workspace = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("test/foundry/encode-decode")).unwrap();
        fs::create_dir_all(workspace.path().join("test/foundry/differential")).unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/encode-decode/Generated.t.sol"),
            "contract EncodeDecodeGenerated {}\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("test/foundry/BaseTest.t.sol"),
            "contract BaseTest {}\n",
        )
        .unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/differential/Generated.t.sol"),
            "contract DifferentialGenerated {}\n",
        )
        .unwrap();

        let paths = changed_foundry_tests(
            workspace.path(),
            target.path(),
            &StrategyId::from("encode-decode"),
        )
        .unwrap();
        assert_eq!(
            paths,
            vec![PathBuf::from("test/foundry/encode-decode/Generated.t.sol")]
        );
    }

    #[test]
    fn differential_lane_author_collects_differential_test_dir() {
        let workspace = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("test/foundry/differential")).unwrap();
        fs::create_dir_all(
            workspace
                .path()
                .join("test/foundry/differential-lane-author"),
        )
        .unwrap();
        fs::create_dir_all(workspace.path().join("test/foundry/encode-decode")).unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/differential/Lane.t.sol"),
            "contract Lane {}\n",
        )
        .unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/differential-lane-author/Helper.t.sol"),
            "contract Helper {}\n",
        )
        .unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/encode-decode/Unrelated.t.sol"),
            "contract Unrelated {}\n",
        )
        .unwrap();

        let paths = changed_foundry_tests(
            workspace.path(),
            target.path(),
            &StrategyId::from("differential-lane-author"),
        )
        .unwrap();

        assert_eq!(
            paths,
            vec![
                PathBuf::from("test/foundry/differential/Lane.t.sol"),
                PathBuf::from("test/foundry/differential-lane-author/Helper.t.sol")
            ]
        );
    }

    #[test]
    fn reference_harness_author_collects_differential_test_dir() {
        let workspace = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("test/foundry/differential")).unwrap();
        fs::create_dir_all(
            workspace
                .path()
                .join("test/foundry/reference-harness-author"),
        )
        .unwrap();
        fs::create_dir_all(workspace.path().join("test/foundry/encode-decode")).unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/differential/Reference.t.sol"),
            "contract Reference {}\n",
        )
        .unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/reference-harness-author/Helper.t.sol"),
            "contract Helper {}\n",
        )
        .unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/encode-decode/Unrelated.t.sol"),
            "contract Unrelated {}\n",
        )
        .unwrap();

        let paths = changed_foundry_tests(
            workspace.path(),
            target.path(),
            &StrategyId::from("reference-harness-author"),
        )
        .unwrap();

        assert_eq!(
            paths,
            vec![
                PathBuf::from("test/foundry/differential/Reference.t.sol"),
                PathBuf::from("test/foundry/reference-harness-author/Helper.t.sol")
            ]
        );
    }

    #[test]
    fn invariant_nodes_collect_invariant_suite_test_dirs() {
        let workspace = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(
            workspace
                .path()
                .join("test/foundry/stateful-invariant-implement-properties"),
        )
        .unwrap();
        fs::create_dir_all(workspace.path().join("test/foundry/invariants")).unwrap();
        fs::create_dir_all(workspace.path().join("test/recon")).unwrap();
        fs::create_dir_all(workspace.path().join("test/chimera")).unwrap();
        fs::create_dir_all(workspace.path().join("test/foundry/encode-decode")).unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/stateful-invariant-implement-properties/Direct.t.sol"),
            "contract Direct {}\n",
        )
        .unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/invariants/FoundryInvariant.t.sol"),
            "contract FoundryInvariant {}\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("test/recon/ReconInvariant.t.sol"),
            "contract ReconInvariant {}\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("test/chimera/ChimeraInvariant.t.sol"),
            "contract ChimeraInvariant {}\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("test/recon/Properties.sol"),
            "contract Properties {}\n",
        )
        .unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/encode-decode/Unrelated.t.sol"),
            "contract Unrelated {}\n",
        )
        .unwrap();

        let paths = changed_foundry_tests(
            workspace.path(),
            target.path(),
            &StrategyId::from(STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID),
        )
        .unwrap();

        assert_eq!(
            paths,
            vec![
                PathBuf::from("test/chimera/ChimeraInvariant.t.sol"),
                PathBuf::from("test/foundry/invariants/FoundryInvariant.t.sol"),
                PathBuf::from("test/foundry/stateful-invariant-implement-properties/Direct.t.sol"),
                PathBuf::from("test/recon/ReconInvariant.t.sol")
            ]
        );

        let recon_paths = changed_foundry_tests(
            workspace.path(),
            target.path(),
            &StrategyId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID),
        )
        .unwrap();
        assert_eq!(
            recon_paths,
            vec![
                PathBuf::from("test/chimera/ChimeraInvariant.t.sol"),
                PathBuf::from("test/foundry/invariants/FoundryInvariant.t.sol"),
                PathBuf::from("test/recon/ReconInvariant.t.sol")
            ]
        );
    }

    #[test]
    fn tempdir_fallback_ignores_unchanged_baseline_strategy_tests() {
        let target = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        for root in [target.path(), workspace.path()] {
            fs::create_dir_all(root.join("test/foundry/encode-decode")).unwrap();
        }
        fs::write(
            target
                .path()
                .join("test/foundry/encode-decode/Existing.t.sol"),
            "contract Existing {}\n",
        )
        .unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/encode-decode/Existing.t.sol"),
            "contract Existing {}\n",
        )
        .unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/encode-decode/Generated.t.sol"),
            "contract Generated {}\n",
        )
        .unwrap();
        fs::write(
            target
                .path()
                .join("test/foundry/encode-decode/Changed.t.sol"),
            "contract ChangedBefore {}\n",
        )
        .unwrap();
        fs::write(
            workspace
                .path()
                .join("test/foundry/encode-decode/Changed.t.sol"),
            "contract ChangedAfter {}\n",
        )
        .unwrap();

        let paths = changed_foundry_tests(
            workspace.path(),
            target.path(),
            &StrategyId::from("encode-decode"),
        )
        .unwrap();

        assert_eq!(
            paths,
            vec![
                PathBuf::from("test/foundry/encode-decode/Changed.t.sol"),
                PathBuf::from("test/foundry/encode-decode/Generated.t.sol")
            ]
        );
    }

    #[test]
    fn aggregation_paths_preserve_nested_tests_and_avoid_collisions() {
        let target = tempfile::tempdir().unwrap();
        let strategy = StrategyId::from("encode-decode");
        let mut used = BTreeSet::new();

        let nested_left = unique_aggregated_test_path(
            target.path(),
            &strategy,
            0,
            Path::new("test/foundry/encode-decode/branch-a/Generated.t.sol"),
            &mut used,
        );
        let nested_right = unique_aggregated_test_path(
            target.path(),
            &strategy,
            0,
            Path::new("test/foundry/encode-decode/branch-b/Generated.t.sol"),
            &mut used,
        );

        assert_eq!(
            nested_left,
            PathBuf::from("test/foundry/encode-decode/attempt-0/branch-a/Generated.t.sol")
        );
        assert_eq!(
            nested_right,
            PathBuf::from("test/foundry/encode-decode/attempt-0/branch-b/Generated.t.sol")
        );

        let mut used = BTreeSet::new();
        let top_level = unique_aggregated_test_path(
            target.path(),
            &strategy,
            0,
            Path::new("test/foundry/encode-decode/Generated.t.sol"),
            &mut used,
        );
        let attempt_level = unique_aggregated_test_path(
            target.path(),
            &strategy,
            0,
            Path::new("test/foundry/encode-decode/attempt-0/Generated.t.sol"),
            &mut used,
        );

        assert_eq!(
            top_level,
            PathBuf::from("test/foundry/encode-decode/attempt-0/Generated.t.sol")
        );
        assert_eq!(
            attempt_level,
            PathBuf::from("test/foundry/encode-decode/attempt-0/Generated-2.t.sol")
        );

        fs::create_dir_all(target.path().join("test/foundry/encode-decode/attempt-1")).unwrap();
        fs::write(
            target
                .path()
                .join("test/foundry/encode-decode/attempt-1/Generated.t.sol"),
            "contract Existing {}\n",
        )
        .unwrap();
        let mut used = BTreeSet::new();
        let existing_target = unique_aggregated_test_path(
            target.path(),
            &strategy,
            1,
            Path::new("test/foundry/encode-decode/Generated.t.sol"),
            &mut used,
        );
        assert_eq!(
            existing_target,
            PathBuf::from("test/foundry/encode-decode/attempt-1/Generated-2.t.sol")
        );

        let lane_author = StrategyId::from("differential-lane-author");
        let mut used = BTreeSet::new();
        let differential_lane = unique_aggregated_test_path(
            target.path(),
            &lane_author,
            2,
            Path::new("test/foundry/differential/Lane.t.sol"),
            &mut used,
        );
        assert_eq!(
            differential_lane,
            PathBuf::from("test/foundry/differential/attempt-2/Lane.t.sol")
        );

        let reference_harness = StrategyId::from("reference-harness-author");
        let mut used = BTreeSet::new();
        let reference_harness_path = unique_aggregated_test_path(
            target.path(),
            &reference_harness,
            0,
            Path::new("test/foundry/differential/Reference.t.sol"),
            &mut used,
        );
        assert_eq!(
            reference_harness_path,
            PathBuf::from("test/foundry/differential/attempt-0/Reference.t.sol")
        );
    }

    #[test]
    fn aggregation_reads_agentic_generated_test_manifests() {
        let repo = tempfile::tempdir().unwrap();
        let runner = CampaignNodeRunner::default();
        let (mut ctx, root) = test_context(
            repo.path(),
            "aggregate-test-files",
            NodeKind::AggregateTestFiles,
        );
        let lane_node = agentic_node(
            "differential-lane-author-0",
            "differential-lane-author",
            &[],
            RetryPolicy::default(),
        );
        ctx.graph.nodes = vec![lane_node.clone(), ctx.node.clone()];
        let lane_artifact_dir = ctx.artifact_store.layout().artifact_dir(&lane_node.id);
        let generated_source =
            lane_artifact_dir.join("generated-tests/test/foundry/differential/Lane.t.sol");
        let generated_support =
            lane_artifact_dir.join("generated-tests/test/foundry/differential/LaneHelper.sol");
        fs::create_dir_all(generated_source.parent().unwrap()).unwrap();
        fs::write(&generated_source, "contract Lane {}\n").unwrap();
        fs::write(&generated_support, "contract LaneHelper {}\n").unwrap();
        fs::write(
            lane_artifact_dir.join("generated-tests.json"),
            serde_json::to_string_pretty(&json!({
                "schema_version": "1.0",
                "node_id": lane_node.id,
                "strategy": "differential-lane-author",
                "attempt_index": 0,
                "model_id": "default",
                "model": null,
                "model_index": 0,
                "loop_index": 0,
                "test_files": [
                    {
                        "source_relative_path": "test/foundry/differential/Lane.t.sol",
                        "artifact_path": "generated-tests/test/foundry/differential/Lane.t.sol",
                        "bytes": 17
                    }
                ],
                "support_files": [
                    {
                        "source_relative_path": "test/foundry/differential/LaneHelper.sol",
                        "artifact_path": "generated-tests/test/foundry/differential/LaneHelper.sol",
                        "bytes": 23
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let artifact_dir = root.path().join("artifacts/aggregate-test-files");
        fs::create_dir_all(&artifact_dir).unwrap();

        runner
            .run_aggregate_test_files(&ctx, &artifact_dir)
            .unwrap();

        assert_eq!(
            fs::read_to_string(
                repo.path()
                    .join("test/foundry/differential/attempt-0/Lane.t.sol")
            )
            .unwrap(),
            "contract Lane {}\n"
        );
        assert_eq!(
            fs::read_to_string(
                repo.path()
                    .join("test/foundry/differential/attempt-0/LaneHelper.sol")
            )
            .unwrap(),
            "contract LaneHelper {}\n"
        );
        let aggregation = read_json_value(artifact_dir.join("aggregation.json")).unwrap();
        assert_eq!(aggregation["source_test_files"], 1);
        assert_eq!(aggregation["copied_test_files"], 1);
        assert_eq!(aggregation["source_support_files"], 1);
        assert_eq!(aggregation["copied_support_files"], 1);
        assert_eq!(
            aggregation["files"][0]["destination"],
            "test/foundry/differential/attempt-0/Lane.t.sol"
        );
        assert_eq!(
            aggregation["support_files"][0]["destination"],
            "test/foundry/differential/attempt-0/LaneHelper.sol"
        );
        assert_eq!(aggregation["skipped_files"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn dedupe_writes_strategy_detection_hits_for_collapsed_findings() {
        let repo = tempfile::tempdir().unwrap();
        let runner = CampaignNodeRunner::default();
        let (mut ctx, _root) =
            test_context(repo.path(), "dedupe-findings", NodeKind::DedupeFindings);
        ctx.node.depends_on = vec![
            NodeId::from("encode-decode"),
            NodeId::from("roundtrip-properties"),
        ];
        ctx.artifact_store.layout().create_dirs().unwrap();

        let encode_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("encode-decode"));
        fs::create_dir_all(&encode_dir).unwrap();
        fs::write(
            encode_dir.join(FINDINGS_FILE),
            serde_json::to_string_pretty(&json!([
                family_finding_json("enc-1", "encode-decode", 0),
                finding_json("enc-3", "encode-decode", 2)
            ]))
            .unwrap(),
        )
        .unwrap();

        let roundtrip_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("roundtrip-properties"));
        fs::create_dir_all(&roundtrip_dir).unwrap();
        fs::write(
            roundtrip_dir.join(FINDINGS_FILE),
            serde_json::to_string_pretty(&json!([
                finding_json("rt-1", "roundtrip-properties", 0),
                finding_json("rt-2", "roundtrip-properties", 1),
                finding_json("rt-3", "roundtrip-properties", 2),
                finding_json("rt-4", "roundtrip-properties", 3),
                finding_json("rt-5", "roundtrip-properties", 4)
            ]))
            .unwrap(),
        )
        .unwrap();

        let artifact_dir = ctx.artifact_dir.clone();
        fs::create_dir_all(&artifact_dir).unwrap();
        runner.run_dedupe(&ctx, &artifact_dir).unwrap();

        let deduped = read_json_value(artifact_dir.join("deduped-findings.json")).unwrap();
        assert_eq!(deduped.as_array().unwrap().len(), 1);
        let detections = read_json_value(artifact_dir.join("strategy-detections.json")).unwrap();
        let hits = detections[0]["hits"].as_array().unwrap();
        assert_eq!(detections[0]["family_id"], "shared-bug-family");
        assert_eq!(hits.len(), 8);
        assert_eq!(hits[0]["strategy"], "encode-decode");
        assert_eq!(hits[0]["loop_index"], 0);
        assert_eq!(hits[1]["strategy"], "encode-decode");
        assert_eq!(hits[1]["loop_index"], 2);
        assert_eq!(hits[2]["strategy"], "roundtrip-properties");
        assert_eq!(hits[6]["loop_index"], 4);
        assert_eq!(hits[7]["strategy"], "state-machine-boundaries");
        assert_eq!(hits[7]["loop_index"], 1);

        let ledger = read_json_value(artifact_dir.join(FINDING_LIFECYCLE_LEDGER_FILE)).unwrap();
        let record = &ledger["records"][0];
        assert_eq!(record["dedupe_key"], "shared-bug");
        assert_eq!(record["source_artifacts"].as_array().unwrap().len(), 8);
        assert_eq!(
            record["source_artifacts"][0]["path"],
            "artifacts/encode-decode/findings.json"
        );
        assert_eq!(record["strategy_hits"].as_array().unwrap().len(), 8);
        assert_eq!(record["duplicate_finding_ids"].as_array().unwrap().len(), 6);
        assert_eq!(record["family_variant_keys"][0], "shared-bug-state-variant");
        assert!(record["stages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|stage| stage["stage"] == "raw"));
        assert!(record["stages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|stage| stage["stage"] == "deduped"));
    }

    #[test]
    fn lifecycle_ledger_is_updated_by_triage() {
        let repo = tempfile::tempdir().unwrap();
        let runner = CampaignNodeRunner::default();
        let (mut ctx, _root) =
            test_context(repo.path(), "dedupe-findings", NodeKind::DedupeFindings);
        ctx.node.depends_on = vec![NodeId::from("encode-decode")];
        ctx.artifact_store.layout().create_dirs().unwrap();

        let encode_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("encode-decode"));
        fs::create_dir_all(&encode_dir).unwrap();
        let mut finding = finding_json("enc-1", "encode-decode", 0);
        finding.as_object_mut().unwrap().insert(
            "notes".to_owned(),
            json!(["classification_reason=public entrypoint evidence"]),
        );
        fs::write(
            encode_dir.join(FINDINGS_FILE),
            serde_json::to_string_pretty(&json!([finding])).unwrap(),
        )
        .unwrap();

        let dedupe_dir = ctx.artifact_dir.clone();
        fs::create_dir_all(&dedupe_dir).unwrap();
        runner.run_dedupe(&ctx, &dedupe_dir).unwrap();

        ctx.node = Node {
            id: NodeId::from("triage"),
            label: "triage".to_owned(),
            kind: NodeKind::TriageFindings,
            depends_on: vec![NodeId::from("dedupe-findings")],
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts/triage"),
        };
        let triage_dir = ctx.artifact_dir.clone();
        fs::create_dir_all(&triage_dir).unwrap();
        runner.run_triage(&ctx, &triage_dir).unwrap();

        let ledger = read_lifecycle_ledger(triage_dir.join(FINDING_LIFECYCLE_LEDGER_FILE)).unwrap();
        let record = &ledger.records[0];
        assert_eq!(
            record.triage_classification,
            Some(TriageClassification::Undetermined)
        );
        assert_eq!(
            record.triage_reason.as_deref(),
            Some("public entrypoint evidence")
        );
        assert!(record
            .stages
            .iter()
            .any(|stage| stage.stage == FindingLifecycleStage::Triaged));
    }

    #[test]
    fn final_report_rejects_missing_lifecycle_metadata() {
        let repo = tempfile::tempdir().unwrap();
        let (ctx, _root) = test_context(
            repo.path(),
            "final-report",
            NodeKind::Agentic {
                logical_id: NodeId::from("final-report"),
                prompt_path: PathBuf::from("review/final-report.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
        );
        let severity_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("severity-classification"));
        fs::create_dir_all(&severity_dir).unwrap();
        fs::write(
            severity_dir.join("severity-classified-findings.json"),
            serde_json::to_string_pretty(&json!([
                {
                    "schema_version": "1.0",
                    "id": "UF-0001",
                    "dedupe_key": "shared-bug",
                    "severity": "high"
                }
            ]))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            severity_dir.join(FINDING_LIFECYCLE_LEDGER_FILE),
            serde_json::to_string_pretty(&FindingLifecycleLedger::empty()).unwrap(),
        )
        .unwrap();

        let error = validate_final_report_lifecycle_inputs(&ctx).unwrap_err();

        assert!(error.to_string().contains("has no lifecycle ledger record"));
    }

    #[test]
    fn final_report_accepts_complete_promoted_lifecycle_metadata() {
        let repo = tempfile::tempdir().unwrap();
        let (ctx, _root) = test_context(
            repo.path(),
            "final-report",
            NodeKind::Agentic {
                logical_id: NodeId::from("final-report"),
                prompt_path: PathBuf::from("review/final-report.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
        );
        let severity_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("severity-classification"));
        fs::create_dir_all(&severity_dir).unwrap();
        fs::write(
            severity_dir.join("severity-classified-findings.json"),
            serde_json::to_string_pretty(&json!([
                {
                    "schema_version": "1.0",
                    "id": "UF-0001",
                    "dedupe_key": "shared-bug",
                    "severity": "high"
                }
            ]))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            severity_dir.join(FINDING_LIFECYCLE_LEDGER_FILE),
            serde_json::to_string_pretty(&complete_lifecycle_ledger()).unwrap(),
        )
        .unwrap();

        validate_final_report_lifecycle_inputs(&ctx).unwrap();
    }

    #[test]
    fn final_report_recovers_missing_lifecycle_ledger_from_review_artifacts() {
        let repo = tempfile::tempdir().unwrap();
        let (ctx, _root) = test_context(
            repo.path(),
            "final-report",
            NodeKind::Agentic {
                logical_id: NodeId::from("final-report"),
                prompt_path: PathBuf::from("review/final-report.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
        );
        let dedupe_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("dedupe-findings"));
        let triage_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("triage"));
        let severity_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("severity-classification"));
        fs::create_dir_all(&dedupe_dir).unwrap();
        fs::create_dir_all(&triage_dir).unwrap();
        fs::create_dir_all(&severity_dir).unwrap();
        fs::write(
            dedupe_dir.join("deduped-findings.json"),
            serde_json::to_string_pretty(&json!([
                {
                    "id": "raw-1",
                    "title": "Shared bug",
                    "dedupe_key": "shared-bug",
                    "status": "confirmed-behavior",
                    "severity": "medium",
                    "provenance": {
                        "strategy": "encode-decode",
                        "attempt_index": 0,
                        "model_id": "default",
                        "model": "claude-opus-4-8",
                        "model_index": 0,
                        "loop_index": 0
                    }
                }
            ]))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dedupe_dir.join(STRATEGY_DETECTIONS_FILE),
            serde_json::to_string_pretty(&json!([
                {
                    "dedupe_key": "shared-bug",
                    "finding_id": "raw-1",
                    "family_id": null,
                    "title": "Shared bug",
                    "hits": [
                        {
                            "strategy": "encode-decode",
                            "attempt_index": 0,
                            "model_id": "default",
                            "model": "claude-opus-4-8",
                            "model_index": 0,
                            "loop_index": 0
                        }
                    ]
                }
            ]))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            triage_dir.join(TRIAGED_FINDINGS_FILE),
            serde_json::to_string_pretty(&json!([
                {
                    "id": "UF-0001",
                    "title": "Shared bug",
                    "dedupe_key": "shared-bug",
                    "status": "confirmed-reproducible",
                    "severity": "medium",
                    "triage_classification": "true-positive",
                    "triage_notes": ["classification_reason=public entrypoint evidence"]
                }
            ]))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            severity_dir.join("severity-classified-findings.json"),
            serde_json::to_string_pretty(&json!([
                {
                    "id": "UF-0001",
                    "title": "Shared bug",
                    "dedupe_key": "shared-bug",
                    "status": "needs-review",
                    "severity": "high",
                    "triage_classification": "true-positive",
                    "notes": [
                        "likelihood=high",
                        "impact=high",
                        "classification_reason=production issue"
                    ]
                }
            ]))
            .unwrap(),
        )
        .unwrap();

        validate_final_report_lifecycle_inputs(&ctx).unwrap();

        assert!(dedupe_dir.join(FINDING_LIFECYCLE_LEDGER_FILE).is_file());
        assert!(triage_dir.join(FINDING_LIFECYCLE_LEDGER_FILE).is_file());
        let ledger =
            read_lifecycle_ledger(severity_dir.join(FINDING_LIFECYCLE_LEDGER_FILE)).unwrap();
        let record = &ledger.records[0];
        assert_eq!(record.dedupe_key, "shared-bug");
        assert_eq!(record.canonical_severity, Some(Severity::High));
        assert_eq!(
            record.triage_classification,
            Some(TriageClassification::TruePositive)
        );
        assert_eq!(
            record.triage_reason.as_deref(),
            Some("public entrypoint evidence")
        );
        assert_eq!(
            record.final_disposition,
            Some(FindingFinalDisposition::Promoted)
        );
        assert_eq!(
            record.source_artifacts[0].node_id,
            NodeId::from("encode-decode-0")
        );
        assert!(record
            .stages
            .iter()
            .any(|stage| stage.stage == FindingLifecycleStage::SeverityClassified));
        let manifest = fs::read_to_string(severity_dir.join(ARTIFACT_MANIFEST_FILE)).unwrap();
        assert!(manifest.contains(FINDING_LIFECYCLE_LEDGER_FILE));
    }

    #[test]
    fn final_report_accepts_legacy_lifecycle_stage_path_aliases() {
        let repo = tempfile::tempdir().unwrap();
        let (ctx, _root) = test_context(
            repo.path(),
            "final-report",
            NodeKind::Agentic {
                logical_id: NodeId::from("final-report"),
                prompt_path: PathBuf::from("review/final-report.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
        );
        let severity_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("severity-classification"));
        fs::create_dir_all(&severity_dir).unwrap();
        fs::write(
            severity_dir.join("severity-classified-findings.json"),
            serde_json::to_string_pretty(&json!([
                {
                    "schema_version": "1.0",
                    "id": "UF-0001",
                    "dedupe_key": "shared-bug",
                    "severity": "high"
                }
            ]))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            severity_dir.join(FINDING_LIFECYCLE_LEDGER_FILE),
            serde_json::to_string_pretty(&json!({
                "schema_version": "1.0",
                "records": [
                    {
                        "dedupe_key": "shared-bug",
                        "finding_id": "UF-0001",
                        "title": "Shared bug",
                        "source_artifacts": [
                            {
                                "path": "artifacts/encode-decode/findings.json",
                                "node_id": "encode-decode",
                                "finding_id": "enc-1",
                                "dedupe_key": "shared-bug",
                                "title": "Shared bug",
                                "relationship": "primary"
                            }
                        ],
                        "strategy_hits": [
                            {
                                "strategy": "encode-decode",
                                "attempt_index": 0,
                                "model_index": 0,
                                "loop_index": 0
                            }
                        ],
                        "canonical_severity": "high",
                        "triage_classification": "true-positive",
                        "triage_reason": "public entrypoint evidence",
                        "final_disposition": "promoted",
                        "stages": [
                            {
                                "stage": "raw",
                                "artifact_path": "artifacts/encode-decode/findings.json",
                                "path": "artifacts/encode-decode/findings.json",
                                "node_id": "encode-decode",
                                "finding_id": "enc-1",
                                "title": "Shared bug",
                                "relationship": "primary"
                            },
                            {
                                "stage": "deduped",
                                "path": "artifacts/dedupe-findings/deduped-findings.json",
                                "finding_id": "UF-0001"
                            },
                            {
                                "stage": "triaged",
                                "output_path": "artifacts/triage/triaged-findings.json",
                                "finding_id": "UF-0001"
                            },
                            {
                                "stage": "severity-classified",
                                "output_path": "artifacts/severity-classification/severity-classified-findings.json",
                                "finding_id": "UF-0001"
                            }
                        ]
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        validate_final_report_lifecycle_inputs(&ctx).unwrap();
    }

    #[test]
    fn final_report_rejects_unfinalized_lifecycle_record_outside_findings() {
        let repo = tempfile::tempdir().unwrap();
        let (ctx, _root) = test_context(
            repo.path(),
            "final-report",
            NodeKind::Agentic {
                logical_id: NodeId::from("final-report"),
                prompt_path: PathBuf::from("review/final-report.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
        );
        let severity_dir = ctx
            .artifact_store
            .layout()
            .artifact_dir(&NodeId::from("severity-classification"));
        fs::create_dir_all(&severity_dir).unwrap();
        fs::write(
            severity_dir.join("severity-classified-findings.json"),
            serde_json::to_string_pretty(&json!([])).unwrap(),
        )
        .unwrap();
        let mut ledger = complete_lifecycle_ledger();
        ledger.records[0].final_disposition = None;
        fs::write(
            severity_dir.join(FINDING_LIFECYCLE_LEDGER_FILE),
            serde_json::to_string_pretty(&ledger).unwrap(),
        )
        .unwrap();

        let error = validate_final_report_lifecycle_inputs(&ctx).unwrap_err();

        assert!(error
            .to_string()
            .contains("missing required metadata: final_disposition"));
    }

    fn complete_lifecycle_ledger() -> FindingLifecycleLedger {
        FindingLifecycleLedger {
            schema_version: "1.0".to_owned(),
            records: vec![FindingLifecycleRecord {
                dedupe_key: "shared-bug".to_owned(),
                finding_id: Some("UF-0001".to_owned()),
                family_id: None,
                title: "Shared bug".to_owned(),
                source_artifacts: vec![FindingLifecycleSourceArtifact {
                    path: PathBuf::from("artifacts/encode-decode/findings.json"),
                    node_id: NodeId::from("encode-decode"),
                    finding_id: Some("enc-1".to_owned()),
                    dedupe_key: Some("shared-bug".to_owned()),
                    title: "Shared bug".to_owned(),
                    relationship: FindingSourceRelationship::Primary,
                }],
                strategy_hits: vec![FindingStrategyHit {
                    strategy: StrategyId::from("encode-decode"),
                    attempt_index: Some(0),
                    model_id: Some(ModelProfileId::from("default")),
                    model: None,
                    model_index: Some(0),
                    loop_index: Some(0),
                }],
                duplicate_finding_ids: Vec::new(),
                family_variant_keys: Vec::new(),
                canonical_severity: Some(Severity::High),
                triage_classification: Some(TriageClassification::TruePositive),
                triage_reason: Some("public entrypoint evidence".to_owned()),
                demotion_reason: None,
                final_disposition: Some(FindingFinalDisposition::Promoted),
                comparison_disposition: None,
                stages: vec![
                    lifecycle_stage_for_test(FindingLifecycleStage::Raw, "encode-decode"),
                    lifecycle_stage_for_test(FindingLifecycleStage::Deduped, "dedupe-findings"),
                    lifecycle_stage_for_test(FindingLifecycleStage::Triaged, "triage"),
                    lifecycle_stage_for_test(
                        FindingLifecycleStage::SeverityClassified,
                        "severity-classification",
                    ),
                ],
            }],
        }
    }

    fn lifecycle_stage_for_test(
        stage: FindingLifecycleStage,
        node_id: &str,
    ) -> FindingLifecycleStageRecord {
        FindingLifecycleStageRecord {
            stage,
            node_id: NodeId::from(node_id),
            artifact_path: PathBuf::from(format!("artifacts/{node_id}/findings.json")),
            finding_id: Some("UF-0001".to_owned()),
            status: FindingStatus::NeedsReview,
            severity: Some(Severity::High),
            triage_classification: Some(TriageClassification::TruePositive),
            note: None,
        }
    }

    fn finding_json(id: &str, strategy: &str, loop_index: usize) -> Value {
        json!({
            "schema_version": "1.0",
            "id": id,
            "strategy": strategy,
            "attempt_index": loop_index,
            "model_id": "default",
            "model_index": 0,
            "loop_index": loop_index,
            "title": "Shared bug",
            "status": "candidate",
            "severity_guess": "medium",
            "confidence": "high",
            "summary": "same root cause",
            "dedupe_key": "shared-bug"
        })
    }

    fn family_finding_json(id: &str, strategy: &str, loop_index: usize) -> Value {
        let mut finding = finding_json(id, strategy, loop_index);
        let object = finding.as_object_mut().unwrap();
        object.insert(
            "family_id".to_owned(),
            Value::String("shared-bug-family".to_owned()),
        );
        object.insert(
            "family_variants".to_owned(),
            json!([
                {
                    "id": "state-variant",
                    "family_id": "shared-bug-family",
                    "title": "State boundary variant",
                    "summary": "same root cause through a state boundary",
                    "strategy": "state-machine-boundaries",
                    "attempt_index": 1,
                    "model_id": "default",
                    "model_index": 0,
                    "loop_index": 1,
                    "dedupe_key": "shared-bug-state-variant"
                }
            ]),
        );
        finding
    }

    fn test_context(
        repo: &Path,
        node_id: &str,
        kind: NodeKind,
    ) -> (NodeContext, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let run_id = RunId::from("run");
        let node = Node {
            id: NodeId::from(node_id),
            label: node_id.to_owned(),
            kind,
            depends_on: Vec::new(),
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts").join(node_id),
        };
        let mut resolved_config = CampaignConfig::default();
        resolved_config.project.repo = repo.to_path_buf();
        let graph = CampaignGraph {
            run_id: run_id.clone(),
            graph_version: ultrafuzz_topology::GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![node.clone()],
        };
        let layout = ultrafuzz_artifacts::RunLayout::new(root.path(), run_id.clone());
        let artifact_dir = layout.artifact_dir(&node.id);
        let workspace_dir = layout.workspace_dir(&node.id);
        let ctx = NodeContext {
            run_id,
            node,
            graph,
            project_root: repo.to_path_buf(),
            resolved_config,
            artifact_store: Arc::new(ArtifactStore::new(layout.clone())),
            artifact_dir,
            workspace_dir,
            run_state: RunStateStore::for_run_root(&layout.root),
            event_sink: Arc::new(NullEventSink),
            prompt_registry: PromptRegistry::built_in().unwrap(),
        };
        (ctx, root)
    }

    #[derive(Default)]
    struct FailOnceRunner {
        calls: AtomicUsize,
    }

    impl NodeRunner for FailOnceRunner {
        fn run(&self, _ctx: NodeContext) -> anyhow::Result<NodeOutput> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                anyhow::bail!("first failure")
            }
            Ok(NodeOutput::default())
        }
    }

    #[derive(Default)]
    struct SlowCompleteArtifactRunner {
        calls: AtomicUsize,
    }

    impl NodeRunner for SlowCompleteArtifactRunner {
        fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let artifact_dir = ctx.artifact_store.layout().artifact_dir(&ctx.node.id);
            fs::create_dir_all(&artifact_dir)?;
            write_artifact(&artifact_dir, "stdout.log", "slow complete runner\n")?;
            write_artifact(&artifact_dir, "stderr.log", "")?;
            write_artifact(&artifact_dir, FINDINGS_FILE, "[{\"id\":\"finding-1\"}]\n")?;
            write_artifact(
                &artifact_dir,
                TRIAGED_FINDINGS_FILE,
                "[{\"id\":\"finding-1\"}]\n",
            )?;
            thread::sleep(Duration::from_millis(25));
            Ok(NodeOutput::default())
        }
    }

    struct RecordingRunner {
        active_agents: AtomicUsize,
        peak_agents: AtomicUsize,
        order: Mutex<Vec<NodeId>>,
        delay: Duration,
    }

    impl RecordingRunner {
        fn new(delay: Duration) -> Self {
            Self {
                active_agents: AtomicUsize::new(0),
                peak_agents: AtomicUsize::new(0),
                order: Mutex::new(Vec::new()),
                delay,
            }
        }
    }

    impl NodeRunner for RecordingRunner {
        fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput> {
            self.order.lock().unwrap().push(ctx.node.id.clone());
            if matches!(
                ctx.node.kind,
                NodeKind::Agentic { .. } | NodeKind::AgentAttempt { .. }
            ) {
                let active = self.active_agents.fetch_add(1, Ordering::SeqCst) + 1;
                self.peak_agents.fetch_max(active, Ordering::SeqCst);
                thread::sleep(self.delay);
                self.active_agents.fetch_sub(1, Ordering::SeqCst);
            }
            Ok(NodeOutput::default())
        }
    }

    struct UsageLogRunner;

    impl NodeRunner for UsageLogRunner {
        fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput> {
            let artifact_dir = ctx.artifact_dir.clone();
            fs::create_dir_all(&artifact_dir)?;
            let stdout_path = write_artifact(
                &artifact_dir,
                "stdout.log",
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":50,"reasoning_output_tokens":10,"total_tokens":1050}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1500,"cached_input_tokens":300,"output_tokens":100,"reasoning_output_tokens":20,"total_tokens":1600}}}}
"#,
            )?;
            let stderr_path = write_artifact(&artifact_dir, "stderr.log", "")?;
            Ok(NodeOutput {
                artifacts: vec![ArtifactRef::new(stdout_path), ArtifactRef::new(stderr_path)],
            })
        }
    }

    #[derive(Default)]
    struct FailOnceUsageRunner {
        calls: AtomicUsize,
    }

    impl NodeRunner for FailOnceUsageRunner {
        fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let artifact_dir = ctx.artifact_dir.clone();
            fs::create_dir_all(&artifact_dir)?;
            let usage = if call == 0 {
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"output_tokens":100,"total_tokens":1200}}}}
"#
            } else {
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1500,"output_tokens":200,"total_tokens":1800}}}}
"#
            };
            write_artifact(&artifact_dir, "stdout.log", usage)?;
            write_artifact(&artifact_dir, "stderr.log", "")?;
            if call == 0 {
                anyhow::bail!("first failure after token usage")
            }
            Ok(NodeOutput::default())
        }
    }

    #[derive(Default)]
    struct CodexUsageLimitOnceRunner {
        calls: AtomicUsize,
    }

    impl NodeRunner for CodexUsageLimitOnceRunner {
        fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let artifact_dir = ctx.artifact_dir.clone();
            fs::create_dir_all(&artifact_dir)?;
            if call == 0 {
                write_artifact(
                    &artifact_dir,
                    "stdout.log",
                    r#"{"type":"error","message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jan 1st, 1970 12:00 AM."}
{"type":"turn.failed","error":{"message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jan 1st, 1970 12:00 AM."}}
"#,
                )?;
                write_artifact(&artifact_dir, "stderr.log", "")?;
                anyhow::bail!("backend-nonzero-exit: backend subprocess exited with status 1");
            }
            write_artifact(&artifact_dir, "stdout.log", "")?;
            write_artifact(&artifact_dir, "stderr.log", "")?;
            Ok(NodeOutput::default())
        }
    }

    #[cfg(unix)]
    struct SymlinkUsageLogRunner;

    #[cfg(unix)]
    impl NodeRunner for SymlinkUsageLogRunner {
        fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput> {
            let artifact_dir = ctx.artifact_dir.clone();
            fs::create_dir_all(&artifact_dir)?;
            let outside = ctx.artifact_store.layout().root.join("outside-stdout.log");
            fs::write(
                &outside,
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"output_tokens":100,"total_tokens":1200}}}}
"#,
            )?;
            std::os::unix::fs::symlink(outside, artifact_dir.join("stdout.log"))?;
            write_artifact(&artifact_dir, "stderr.log", "")?;
            Ok(NodeOutput::default())
        }
    }

    #[cfg(unix)]
    struct FifoUsageLogRunner;

    #[cfg(unix)]
    impl NodeRunner for FifoUsageLogRunner {
        fn run(&self, ctx: NodeContext) -> anyhow::Result<NodeOutput> {
            let artifact_dir = ctx.artifact_dir.clone();
            fs::create_dir_all(&artifact_dir)?;
            let fifo = artifact_dir.join("stdout.log");
            let status = Command::new("mkfifo").arg(&fifo).status()?;
            if !status.success() {
                anyhow::bail!("mkfifo failed for `{}` with {status}", fifo.display());
            }
            write_artifact(&artifact_dir, "stderr.log", "")?;
            Ok(NodeOutput::default())
        }
    }
}
