use clap::{Args, Parser, Subcommand};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
    process::Command as ProcessCommand,
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use ultrafuzz_agent::{
    backend_for_config, BackendAvailability, BackendDoctorCheckStatus, BackendDoctorResult,
};
use ultrafuzz_artifacts::{ArtifactManifest, ArtifactStore, RunLayout, ARTIFACT_MANIFEST_FILE};
use ultrafuzz_config::{
    CampaignConfig, CliOverrides, EnvOverrides, InvariantPropertyPriorityThreshold,
};
use ultrafuzz_core::{
    BackendKind, NodeId, NodeStatus, ReferenceId, RestartMode, RunId, RunStatus,
    STATEFUL_INVARIANT_COVERAGE_ID, STATEFUL_INVARIANT_RECON_CAMPAIGN_ID,
};
use ultrafuzz_events::{
    emit_event, CompositeEventSink, EventSink, JsonlEventSink, RunEvent, SqliteEventSink,
};
use ultrafuzz_executor::{CampaignNodeRunner, DagExecutor, ExecutionRequest, ExecutorConfig};
use ultrafuzz_prompts::{topology_prompt_markdown, PromptRegistry};
use ultrafuzz_references::{
    load_catalog, status_project_references, sync_project_references,
    update_project_references_latest, verify_references_cached,
};
use ultrafuzz_state::{
    config_fingerprint, summarize_run_health, write_text_file, RestartPlan, RunState,
    RunStateStore, GRAPH_FILE_NAME, RESOLVED_CONFIG_FILE_NAME,
};
use ultrafuzz_topology::{
    build_campaign_graph_from_project, load_project_topology, prompts_root, CampaignGraph, Node,
    NodeKind,
};

const AGGREGATION_REPORT: &str = "artifacts/aggregate-test-files/aggregation.json";
const RUN_METADATA_FILE_NAME: &str = "run.json";

#[derive(Debug, Parser)]
#[command(
    name = "ultrafuzz",
    version,
    about = "Rust-native Solidity fuzzing campaign orchestrator"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    Init(InitArgs),
    Run(RunArgs),
    Restart(RestartArgs),
    Continue(ContinueArgs),
    List(ListArgs),
    Status(StatusArgs),
    Doctor(DoctorArgs),
    Config(ConfigArgs),
    Dashboard(DashboardArgs),
    Report(ReportArgs),
    Clean(CleanArgs),
    Triage(TriageArgs),
    Merge(MergeArgs),
    Materialize(MaterializeArgs),
    References(ReferencesArgs),
}

#[derive(Debug, Args)]
pub struct InitArgs {
    #[arg(long)]
    pub force: bool,
    #[arg(long, conflicts_with = "full")]
    pub minimal: bool,
    #[arg(long, conflicts_with = "minimal")]
    pub full: bool,
    #[arg(long, value_name = "N", value_parser = parse_strategy_loops)]
    pub strategy_loops: Option<usize>,
}

#[derive(Debug, Args)]
pub struct RunArgs {
    #[command(flatten)]
    pub output: RunOutputArgs,
    #[arg(long)]
    pub backend: Option<String>,
    #[arg(long)]
    pub max_parallel_agents: Option<usize>,
    #[arg(long)]
    pub max_parallel_nodes: Option<usize>,
    #[arg(long, value_name = "N", value_parser = parse_strategy_loops)]
    pub strategy_loops: Option<usize>,
    #[arg(long, value_name = "N", value_parser = parse_positive_count)]
    pub dynamic_strategies_enumerator: Option<usize>,
    #[arg(long, value_name = "N", value_parser = parse_positive_count)]
    pub triage_quorum: Option<usize>,
    #[arg(long, value_name = "N", value_parser = parse_positive_count)]
    pub triage_panel_size: Option<usize>,
    #[arg(long, value_name = "high|medium|low", value_parser = parse_invariant_property_priority_threshold)]
    pub invariant_property_priority_threshold: Option<InvariantPropertyPriorityThreshold>,
    #[arg(long, value_name = "DURATION", value_parser = parse_invariant_testing_fuzzer_timeout)]
    pub invariant_testing_fuzzer_timeout: Option<u64>,
    #[arg(long)]
    pub sync_references: bool,
}

#[derive(Debug, Args)]
pub struct RestartArgs {
    pub run_id: String,
    #[command(flatten)]
    pub output: RunOutputArgs,
    #[arg(long)]
    pub backend: Option<String>,
    #[arg(long)]
    pub max_parallel_agents: Option<usize>,
    #[arg(long)]
    pub max_parallel_nodes: Option<usize>,
    #[arg(long, value_name = "N", value_parser = parse_positive_count)]
    pub dynamic_strategies_enumerator: Option<usize>,
    #[arg(long, value_name = "N", value_parser = parse_positive_count)]
    pub triage_quorum: Option<usize>,
    #[arg(long, value_name = "N", value_parser = parse_positive_count)]
    pub triage_panel_size: Option<usize>,
    #[arg(long, value_name = "high|medium|low", value_parser = parse_invariant_property_priority_threshold)]
    pub invariant_property_priority_threshold: Option<InvariantPropertyPriorityThreshold>,
    #[arg(long, value_name = "DURATION", value_parser = parse_invariant_testing_fuzzer_timeout)]
    pub invariant_testing_fuzzer_timeout: Option<u64>,
}

#[derive(Debug, Args)]
pub struct ContinueArgs {
    pub run_id: String,
    #[command(flatten)]
    pub output: RunOutputArgs,
    #[arg(long)]
    pub max_parallel_agents: Option<usize>,
    #[arg(long)]
    pub max_parallel_nodes: Option<usize>,
}

#[derive(Debug, Args)]
pub struct ListArgs {}

#[derive(Debug, Args)]
pub struct StatusArgs {
    pub run_id: Option<String>,
    #[arg(long)]
    pub json: bool,
    #[arg(long)]
    pub plain: bool,
    #[arg(long)]
    pub no_color: bool,
}

#[derive(Debug, Args)]
pub struct DoctorArgs {
    #[arg(long)]
    pub backend: Option<String>,
    #[arg(long)]
    pub json: bool,
    #[arg(long)]
    pub plain: bool,
    #[arg(long)]
    pub no_color: bool,
}

#[derive(Clone, Copy, Debug, Default, Args)]
pub struct RunOutputArgs {
    #[arg(long)]
    pub plain: bool,
    #[arg(long)]
    pub no_color: bool,
    #[arg(long)]
    pub quiet: bool,
    #[arg(long)]
    pub verbose: bool,
}

#[derive(Debug, Args)]
pub struct ConfigArgs {
    #[command(subcommand)]
    pub command: Option<ConfigCommand>,
}

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    Defaults,
    Inspect,
}

#[derive(Debug, Args)]
pub struct DashboardArgs {
    pub run_id: Option<String>,
    #[arg(long)]
    pub host: Option<String>,
    #[arg(long)]
    pub port: Option<u16>,
}

#[derive(Debug, Args)]
pub struct ReportArgs {
    pub run_id: String,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct CleanArgs {
    pub run_id: String,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct TriageArgs {
    pub run_id: String,
}

#[derive(Debug, Args)]
pub struct MergeArgs {
    pub run_id: String,
}

#[derive(Debug, Args)]
pub struct MaterializeArgs {
    pub run_id: String,
    #[arg(long = "patch", value_name = "RUN_RELATIVE_PATCH")]
    pub patches: Vec<PathBuf>,
    #[arg(long = "copy", value_name = "RUN_RELATIVE_PATH=REPO_RELATIVE_PATH")]
    pub copies: Vec<CopySelection>,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct ReferencesArgs {
    #[command(subcommand)]
    pub command: ReferencesCommand,
}

#[derive(Debug, Subcommand)]
pub enum ReferencesCommand {
    Update(ReferencesUpdateArgs),
    Sync,
    Status,
}

#[derive(Debug, Args)]
pub struct ReferencesUpdateArgs {
    #[arg(long)]
    pub latest: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CopySelection {
    source: PathBuf,
    destination: PathBuf,
}

impl FromStr for CopySelection {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let Some((source, destination)) = value.split_once('=') else {
            return Err("expected RUN_RELATIVE_PATH=REPO_RELATIVE_PATH".to_owned());
        };
        if source.trim().is_empty() || destination.trim().is_empty() {
            return Err("copy source and destination must both be non-empty".to_owned());
        }
        Ok(Self {
            source: PathBuf::from(source.trim()),
            destination: PathBuf::from(destination.trim()),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PatchMaterializationPlan {
    requested: PathBuf,
    source: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CopyMaterializationPlan {
    requested_source: PathBuf,
    requested_destination: PathBuf,
    source: PathBuf,
    destination: PathBuf,
}

fn parse_strategy_loops(value: &str) -> Result<usize, String> {
    let loops = value.parse::<usize>().map_err(|_| {
        format!(
            "expected an integer from 1 to {}",
            ultrafuzz_topology::MAX_LOOPS
        )
    })?;
    ultrafuzz_topology::validate_strategy_loop_default(loops).map_err(|error| error.to_string())?;
    Ok(loops)
}

fn parse_positive_count(value: &str) -> Result<usize, String> {
    let count = value
        .parse::<usize>()
        .map_err(|_| "expected a positive integer".to_owned())?;
    if count == 0 {
        return Err("expected a positive integer".to_owned());
    }
    Ok(count)
}

fn parse_invariant_property_priority_threshold(
    value: &str,
) -> Result<InvariantPropertyPriorityThreshold, String> {
    value.parse()
}

fn parse_invariant_testing_fuzzer_timeout(value: &str) -> Result<u64, String> {
    ultrafuzz_config::parse_invariant_testing_fuzzer_timeout_seconds(value)
}

pub fn execute(cli: Cli) -> anyhow::Result<String> {
    execute_in(cli, std::env::current_dir()?)
}

#[cfg(not(test))]
pub fn execute_in(cli: Cli, cwd: impl AsRef<Path>) -> anyhow::Result<String> {
    execute_in_inner(cli, cwd)
}

#[cfg(test)]
pub fn execute_in(cli: Cli, cwd: impl AsRef<Path>) -> anyhow::Result<String> {
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _env = ClearedUltrafuzzEnv::new();
    execute_in_inner(cli, cwd)
}

#[cfg(test)]
struct ClearedUltrafuzzEnv {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

#[cfg(test)]
impl ClearedUltrafuzzEnv {
    const KEYS: [&'static str; 4] = [
        "ULTRAFUZZ_BACKEND",
        "ULTRAFUZZ_MAX_PARALLEL_AGENTS",
        "ULTRAFUZZ_OUTPUT_DIR",
        "ULTRAFUZZ_KEEP_WORKSPACES",
    ];

    fn new() -> Self {
        let saved = Self::KEYS
            .into_iter()
            .map(|key| {
                let value = std::env::var_os(key);
                std::env::remove_var(key);
                (key, value)
            })
            .collect();
        Self { saved }
    }
}

#[cfg(test)]
impl Drop for ClearedUltrafuzzEnv {
    fn drop(&mut self) {
        for (key, value) in self.saved.drain(..) {
            if let Some(value) = value {
                std::env::set_var(key, value);
            } else {
                std::env::remove_var(key);
            }
        }
    }
}

fn execute_in_inner(cli: Cli, cwd: impl AsRef<Path>) -> anyhow::Result<String> {
    let cwd = cwd.as_ref();
    let output = match cli.command {
        Command::Init(args) => {
            let profile = if args.minimal {
                "minimal"
            } else if args.full {
                "full"
            } else {
                "default"
            };

            let config_report = ultrafuzz_config::write_default_config(cwd, args.force)?;
            let prompt_report = ultrafuzz_prompts::scaffold_project_prompts(cwd, args.force)?;
            let reference_report =
                ultrafuzz_references::write_default_reference_catalog(cwd, args.force)?;
            let _topology_report =
                ultrafuzz_topology::write_default_project_topology_with_strategy_loops(
                    cwd,
                    args.force,
                    args.strategy_loops
                        .unwrap_or(ultrafuzz_topology::DEFAULT_STRATEGY_LOOPS),
                )?;
            let runs_dir = default_runs_dir(cwd)?;
            fs::create_dir_all(&runs_dir)?;

            let config_status = if config_report.written.is_some() {
                "written"
            } else {
                "skipped"
            };
            let references_status = if reference_report.written.is_some() {
                "written"
            } else {
                "skipped"
            };
            format!(
                "ultrafuzz init complete (profile: {profile}, force: {}, config: {config_status}, references: {references_status}, prompts_written: {}, prompts_skipped: {}, runs_dir: {}).\n\nNext commands:\n  ultrafuzz doctor\n  ultrafuzz references sync\n  ultrafuzz run\n  ultrafuzz dashboard\n\nArtifacts:\n  {}",
                args.force,
                prompt_report.written.len(),
                prompt_report.skipped.len(),
                runs_dir.display(),
                runs_dir.display()
            )
        }
        Command::Run(args) => {
            if let Some(strategy_loops) = args.strategy_loops {
                ultrafuzz_topology::set_project_strategy_loops(cwd, strategy_loops)?;
            }
            let overrides = cli_overrides(CliOverrideArgs {
                backend: args.backend,
                max_parallel_agents: args.max_parallel_agents,
                max_parallel_nodes: args.max_parallel_nodes,
                dynamic_strategies_enumerator: args.dynamic_strategies_enumerator,
                triage_quorum: args.triage_quorum,
                triage_panel_size: args.triage_panel_size,
                invariant_property_priority_threshold: args.invariant_property_priority_threshold,
                invariant_testing_fuzzer_timeout_seconds: args.invariant_testing_fuzzer_timeout,
            })?;
            let summary = run_campaign(cwd, overrides, None, args.sync_references)?;
            format_completed_run_summary(RunSummaryKind::Run, &summary, args.output)?
        }
        Command::Restart(args) => {
            let overrides = cli_overrides(CliOverrideArgs {
                backend: args.backend,
                max_parallel_agents: args.max_parallel_agents,
                max_parallel_nodes: args.max_parallel_nodes,
                dynamic_strategies_enumerator: args.dynamic_strategies_enumerator,
                triage_quorum: args.triage_quorum,
                triage_panel_size: args.triage_panel_size,
                invariant_property_priority_threshold: args.invariant_property_priority_threshold,
                invariant_testing_fuzzer_timeout_seconds: args.invariant_testing_fuzzer_timeout,
            })?;
            let (source_root, _) = existing_run_root(cwd, &args.run_id)?;
            let new_run_id = new_run_id();
            let plan = RestartPlan::derive_clean(&source_root, new_run_id)?;
            let summary = run_campaign(cwd, overrides, Some(plan), false)?;
            format_completed_run_summary(RunSummaryKind::Restart, &summary, args.output)?
        }
        Command::Continue(args) => {
            let overrides = CliOverrides {
                max_parallel_agents: args.max_parallel_agents,
                max_parallel_nodes: args.max_parallel_nodes,
                ..CliOverrides::default()
            };
            let (source_root, _) = existing_run_root(cwd, &args.run_id)?;
            let new_run_id = new_run_id();
            let plan = RestartPlan::derive_continuation(&source_root, new_run_id)?;
            let summary = run_campaign(cwd, overrides, Some(plan), false)?;
            format_completed_run_summary(RunSummaryKind::Continue, &summary, args.output)?
        }
        Command::List(_) => format_list(cwd)?,
        Command::Status(args) => format_status(cwd, args)?,
        Command::Doctor(args) => format_doctor(cwd, args)?,
        Command::Config(args) => match args.command.unwrap_or(ConfigCommand::Inspect) {
            ConfigCommand::Defaults => ultrafuzz_config::default_config_toml().to_owned(),
            ConfigCommand::Inspect => {
                let registry = ultrafuzz_prompts::PromptRegistry::load_for_project(cwd)?;
                let config = ultrafuzz_config::load_resolved_config(
                    cwd,
                    registry.strategy_definitions(),
                    EnvOverrides::from_env()?,
                    CliOverrides::default(),
                )?;
                let mut output = config.dump_redacted_toml()?;
                output.push('\n');
                output.push_str(&topology_inspection(cwd, &config).to_line());
                output
            }
        },
        Command::Dashboard(args) => {
            let config = dashboard_server_config(cwd, args)?;
            ultrafuzz_dashboard::serve_blocking(config)?;
            String::new()
        }
        Command::Report(args) => format_report(cwd, args)?,
        Command::Clean(args) => format_clean(cwd, args)?,
        Command::Triage(args) => format_triage(cwd, args)?,
        Command::Merge(args) => format_merge(cwd, args)?,
        Command::Materialize(args) => format_materialize(cwd, args)?,
        Command::References(args) => format_references(cwd, args)?,
    };

    Ok(output)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RunSummary {
    run_id: RunId,
    status: RunStatus,
    run_dir: PathBuf,
    graph_nodes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RunSummaryKind {
    Run,
    Restart,
    Continue,
}

impl RunSummaryKind {
    fn heading(self, status: RunStatus) -> &'static str {
        match (self, status) {
            (Self::Run, RunStatus::Succeeded) => "Run complete.",
            (Self::Run, RunStatus::Failed) => "Run failed.",
            (Self::Run, RunStatus::Cancelled) => "Run cancelled.",
            (Self::Run, RunStatus::Running) => "Run still running.",
            (Self::Run, RunStatus::Pending) => "Run pending.",
            (Self::Restart, RunStatus::Succeeded) => "Restart complete.",
            (Self::Restart, RunStatus::Failed) => "Restart failed.",
            (Self::Restart, RunStatus::Cancelled) => "Restart cancelled.",
            (Self::Restart, RunStatus::Running) => "Restart still running.",
            (Self::Restart, RunStatus::Pending) => "Restart pending.",
            (Self::Continue, RunStatus::Succeeded) => "Continuation complete.",
            (Self::Continue, RunStatus::Failed) => "Continuation failed.",
            (Self::Continue, RunStatus::Cancelled) => "Continuation cancelled.",
            (Self::Continue, RunStatus::Running) => "Continuation still running.",
            (Self::Continue, RunStatus::Pending) => "Continuation pending.",
        }
    }
}

fn format_references(cwd: &Path, args: ReferencesArgs) -> anyhow::Result<String> {
    match args.command {
        ReferencesCommand::Sync => {
            let report = sync_project_references(cwd)?;
            let fetched = report
                .synced
                .iter()
                .filter(|reference| reference.fetched)
                .count();
            Ok(format!(
                "references synced: {} tracked, {} fetched, cache: {}",
                report.synced.len(),
                fetched,
                report.cache_root.display()
            ))
        }
        ReferencesCommand::Status => {
            let report = status_project_references(cwd)?;
            let mut lines = vec![format!(
                "references status: {} tracked, cache: {}",
                report.references.len(),
                report.cache_root.display()
            )];
            for reference in &report.references {
                let status = if reference.ok { "ok" } else { "missing" };
                lines.push(format!(
                    "- {}: {} ({}/{})",
                    reference.id, status, reference.repo, reference.commit
                ));
                for message in &reference.messages {
                    lines.push(format!("  {message}"));
                }
            }
            let output = lines.join("\n");
            if report.ok() {
                Ok(output)
            } else {
                anyhow::bail!("{output}");
            }
        }
        ReferencesCommand::Update(args) => {
            if !args.latest {
                anyhow::bail!(
                    "`ultrafuzz references update` requires `--latest` to intentionally rewrite .ultrafuzz/references.yml"
                );
            }
            let report = update_project_references_latest(cwd)?;
            let changed = report
                .updated
                .iter()
                .filter(|reference| reference.old_commit != reference.new_commit)
                .count();
            Ok(format!(
                "references updated: {} tracked, {} changed, catalog: {}",
                report.updated.len(),
                changed,
                report.catalog_path.display()
            ))
        }
    }
}

fn run_campaign(
    cwd: &Path,
    cli_overrides: CliOverrides,
    restart_plan: Option<RestartPlan>,
    sync_references: bool,
) -> anyhow::Result<RunSummary> {
    let registry = PromptRegistry::load_for_project(cwd)?;
    let source_run_id = restart_plan.as_ref().map(|plan| plan.source_run_id.clone());
    let run_id = restart_plan
        .as_ref()
        .map(|plan| plan.new_run_id.clone())
        .unwrap_or_else(new_run_id);
    let (mut config, restart_source_config, restart_compat_config_fingerprint) =
        resolve_run_config(cwd, &registry, cli_overrides, restart_plan.as_ref())?;
    let resolved_config_toml = config.dump_redacted_toml()?;
    config.project.repo = resolve_project_config_path(cwd, "project.repo", &config.project.repo)?;

    let restart_mode = restart_plan.as_ref().map(|plan| plan.mode);
    let output_dir = resolve_project_config_path(cwd, "run.output_dir", &config.run.output_dir)?;
    let layout = RunLayout::new(output_dir, run_id.clone());
    let graph = graph_for_run(
        run_id.clone(),
        cwd,
        &config,
        restart_plan.as_ref(),
        restart_source_config.as_ref(),
    )?;
    let reusable_nodes = restart_plan
        .as_ref()
        .map(|plan| plan.reusable_nodes.as_slice())
        .unwrap_or_default();
    prepare_graph_references(cwd, &graph, sync_references, reusable_nodes)?;
    preflight_campaign_toolchain(cwd, &graph, reusable_nodes)?;
    let graph_fingerprint = graph.fingerprint()?;
    let graph_json = graph.to_json_pretty()?;
    let effective_strategy_loops = effective_strategy_loop_counts(&graph);
    let effective_strategy_timeouts = effective_strategy_timeouts(&graph);
    let run_config_fingerprint = config_fingerprint(&config.dump_toml()?);
    let compatibility_config_fingerprint = continuation_compatibility_config_fingerprint(
        &config,
        restart_source_config.as_ref(),
        restart_plan.as_ref(),
        &run_config_fingerprint,
    )?;
    let prompt_fingerprint = prompt_fingerprint(cwd, &graph)?;
    if let Some(plan) = &restart_plan {
        validate_restart_compatibility(
            plan,
            &graph_fingerprint,
            &compatibility_config_fingerprint,
            &prompt_fingerprint,
            restart_compat_config_fingerprint.as_deref(),
        )?;
    }

    layout.create_dirs()?;
    write_text_file(layout.resolved_config_path(), &resolved_config_toml)?;
    write_text_file(layout.graph_path(), &graph_json)?;
    write_text_file(layout.graph_fingerprint_path(), &graph_fingerprint)?;
    write_text_file(
        layout.run_metadata_path(),
        &serde_json::to_string_pretty(&json!({
            "run_id": run_id.clone(),
            "source_run_id": source_run_id.clone(),
            "restart_mode": restart_mode.map(restart_mode_label),
            "reused_nodes": restart_plan
                .as_ref()
                .map(|plan| plan.reusable_nodes.iter().map(ToString::to_string).collect::<Vec<_>>())
                .unwrap_or_default(),
            "graph_fingerprint": graph_fingerprint,
            "config_fingerprint": run_config_fingerprint,
            "prompt_fingerprint": prompt_fingerprint,
            "graph_nodes": graph.nodes.len(),
            "synthetic_execution": false,
            "default_timeout_seconds": config.run.default_timeout_seconds,
            "node_timeouts": node_timeout_metadata(&graph),
            "dynamic_strategies_enumerator": config.dynamic_strategies_enumerator,
            "default_model": config.models.default.to_string(),
            "models": config
                .models
                .profiles
                .iter()
                .map(|profile| json!({
                    "id": profile.id.to_string(),
                    "backend": profile.backend,
                    "model": profile.model.clone(),
                }))
                .collect::<Vec<_>>(),
            "strategies": config
                .strategies
                .definitions
                .iter()
                .filter(|strategy| strategy.enabled)
                .map(|strategy| {
                    let loops = effective_strategy_loops
                        .get(strategy.id.as_str())
                        .copied()
                        .unwrap_or(strategy.loops);
                    let timeout_seconds = effective_strategy_timeouts
                        .get(strategy.id.as_str())
                        .copied()
                        .unwrap_or(strategy.timeout.as_secs());
                    strategy_run_metadata(&config, strategy, loops, timeout_seconds)
                })
                .collect::<Vec<_>>()
        }))?,
    )?;
    if let Some(plan) = &restart_plan {
        seed_restart_state(
            &layout,
            &graph,
            &graph_fingerprint,
            &run_config_fingerprint,
            plan,
        )?;
    }

    let event_sink = event_sinks_for_layout(&layout);
    let executor = DagExecutor::new(
        ExecutorConfig::from_campaign_config(&config),
        Arc::new(CampaignNodeRunner::default()),
    );
    let graph_nodes = graph.nodes.len();
    let result = executor.execute(ExecutionRequest {
        graph,
        project_root: cwd.to_path_buf(),
        resolved_config: config,
        prompt_registry: registry,
        artifact_store: ArtifactStore::new(layout.clone()),
        state_store: RunStateStore::for_run_root(&layout.root),
        event_sink,
        source_run_id,
    })?;

    Ok(RunSummary {
        run_id: result.run_id,
        status: result.status,
        run_dir: layout.root,
        graph_nodes,
    })
}

fn resolve_run_config(
    cwd: &Path,
    registry: &PromptRegistry,
    cli_overrides: CliOverrides,
    restart_plan: Option<&RestartPlan>,
) -> anyhow::Result<(CampaignConfig, Option<CampaignConfig>, Option<String>)> {
    if let Some(plan) = restart_plan {
        let normalized_restart_config =
            normalize_legacy_restart_resolved_config_toml(cwd, &plan.resolved_config_toml)?;
        let restart_config_toml = normalized_restart_config.toml;
        let mut source_config = ultrafuzz_config::resolve_config_from_toml(
            Some(&restart_config_toml),
            registry.strategy_definitions(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )?;
        let config_path = cwd.join(ultrafuzz_config::CONFIG_FILE_NAME);
        let env_overrides = EnvOverrides::from_env()?;
        let config = if config_path.exists() {
            ultrafuzz_config::load_resolved_config(
                cwd,
                registry.strategy_definitions(),
                env_overrides.clone(),
                cli_overrides.clone(),
            )?
        } else {
            ultrafuzz_config::resolve_config_from_toml(
                Some(&restart_config_toml),
                registry.strategy_definitions(),
                env_overrides,
                cli_overrides,
            )?
        };
        let mut config = config;
        let current_config = config.clone();
        restore_redacted_restart_env_values(&mut config, &current_config)?;
        restore_redacted_restart_env_values(&mut source_config, &current_config)?;
        let restart_compat_config_fingerprint = if normalized_restart_config.changed {
            Some(restart_compatibility_config_fingerprint(
                cwd,
                &source_config,
            )?)
        } else {
            None
        };
        return Ok((
            config,
            Some(source_config),
            restart_compat_config_fingerprint,
        ));
    }

    let config_path = cwd.join(ultrafuzz_config::CONFIG_FILE_NAME);
    if config_path.exists() {
        let config = ultrafuzz_config::load_resolved_config(
            cwd,
            registry.strategy_definitions(),
            EnvOverrides::from_env()?,
            cli_overrides,
        )?;
        return Ok((config, None, None));
    }

    anyhow::bail!(
        "no ultrafuzz.toml found in {}; run `ultrafuzz init` first",
        cwd.display()
    );
}

fn prepare_graph_references(
    cwd: &Path,
    graph: &CampaignGraph,
    sync_references: bool,
    reusable_nodes: &[NodeId],
) -> anyhow::Result<()> {
    let reference_ids = graph_reference_ids(graph, reusable_nodes);
    if reference_ids.is_empty() {
        return Ok(());
    }
    if sync_references {
        sync_project_references(cwd)?;
    }
    let catalog = load_catalog(cwd)?;
    verify_references_cached(&catalog, reference_ids.iter())?;
    Ok(())
}

fn graph_reference_ids(graph: &CampaignGraph, reusable_nodes: &[NodeId]) -> Vec<ReferenceId> {
    let reusable_nodes = reusable_nodes
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let mut ids = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for node in &graph.nodes {
        if reusable_nodes.contains(&node.id) {
            continue;
        }
        if let NodeKind::Reference { reference, .. } = &node.kind {
            if seen.insert(reference.clone()) {
                ids.push(reference.clone());
            }
        }
    }
    ids
}

fn effective_strategy_loop_counts(graph: &CampaignGraph) -> BTreeMap<String, usize> {
    let mut loops = BTreeMap::new();
    for node in &graph.nodes {
        if let ultrafuzz_topology::NodeKind::Agentic {
            logical_id,
            loop_count,
            ..
        } = &node.kind
        {
            loops.insert(logical_id.to_string(), *loop_count);
        }
    }
    loops
}

fn effective_strategy_timeouts(graph: &CampaignGraph) -> BTreeMap<String, u64> {
    let mut timeouts = BTreeMap::new();
    for node in &graph.nodes {
        if let ultrafuzz_topology::NodeKind::Agentic { logical_id, .. } = &node.kind {
            if let Some(timeout) = node.timeout {
                timeouts
                    .entry(logical_id.to_string())
                    .or_insert_with(|| timeout.as_secs());
            }
        }
    }
    timeouts
}

fn continuation_compatibility_config_fingerprint(
    config: &CampaignConfig,
    source_config: Option<&CampaignConfig>,
    restart_plan: Option<&RestartPlan>,
    run_config_fingerprint: &str,
) -> anyhow::Result<String> {
    let Some(plan) = restart_plan else {
        return Ok(run_config_fingerprint.to_owned());
    };
    if plan.mode != RestartMode::ReuseCompletedArtifacts {
        return Ok(run_config_fingerprint.to_owned());
    }
    let Some(source_config) = source_config else {
        return Ok(run_config_fingerprint.to_owned());
    };

    let mut compatibility_config = config.clone();
    compatibility_config.run.max_parallel_agents = source_config.run.max_parallel_agents;
    compatibility_config.run.max_parallel_nodes = source_config.run.max_parallel_nodes;
    Ok(config_fingerprint(&compatibility_config.dump_toml()?))
}

fn strategy_run_metadata(
    config: &CampaignConfig,
    strategy: &ultrafuzz_core::StrategyDefinition,
    loops: usize,
    timeout_seconds: u64,
) -> serde_json::Value {
    let models = config.effective_strategy_models(strategy);
    let mut value = json!({
        "id": strategy.id.to_string(),
        "display_name": strategy.display_name.clone(),
        "category": strategy.category,
        "source": strategy.source,
        "models": models
            .iter()
            .map(|model_id| model_id.to_string())
            .collect::<Vec<_>>(),
        "loops": loops,
        "attempts": loops * models.len(),
        "timeout_seconds": timeout_seconds,
    });
    if strategy.id.as_str() == "dynamic-strategy-generator" {
        value["expected_cost"] = json!("high");
        value["cost_note"] = json!(dynamic_strategy_cost_note(
            config.dynamic_strategies_enumerator
        ));
    }
    value
}

fn dynamic_strategy_cost_note(enumerator_count: usize) -> String {
    format!(
        "High-timeout dynamic discovery; enumerates up to {enumerator_count} max-reasoning candidate strategy agents and may run one max-reasoning sub-agent per selected strategy."
    )
}

const REDACTED_CONFIG_VALUE: &str = "<redacted>";

struct NormalizedRestartConfigToml {
    toml: String,
    changed: bool,
}

fn normalize_legacy_restart_resolved_config_toml(
    cwd: &Path,
    toml: &str,
) -> anyhow::Result<NormalizedRestartConfigToml> {
    let mut value = toml::from_str::<toml::Value>(toml)?;
    let mut changed = false;
    changed |= relativize_legacy_restart_path(cwd, &mut value, &["project", "repo"])?;
    changed |= relativize_legacy_restart_path(cwd, &mut value, &["run", "output_dir"])?;
    let toml = if changed {
        toml::to_string_pretty(&value)?
    } else {
        toml.to_owned()
    };
    Ok(NormalizedRestartConfigToml { toml, changed })
}

fn relativize_legacy_restart_path(
    cwd: &Path,
    config: &mut toml::Value,
    path: &[&str],
) -> anyhow::Result<bool> {
    let Some(path_value) = toml_string_mut(config, path) else {
        return Ok(false);
    };
    let raw_path = Path::new(path_value);
    if !raw_path.is_absolute() {
        return Ok(false);
    }

    let canonical_cwd = cwd.canonicalize()?;
    let Ok(canonical_path) = raw_path.canonicalize() else {
        return Ok(false);
    };
    if !canonical_path.starts_with(&canonical_cwd) {
        return Ok(false);
    }

    let relative_path = canonical_path
        .strip_prefix(&canonical_cwd)
        .expect("prefix checked above");
    if relative_path.as_os_str().is_empty() {
        *path_value = ".".to_owned();
    } else {
        *path_value = relative_path.display().to_string();
    }
    Ok(true)
}

fn toml_string_mut<'a>(value: &'a mut toml::Value, path: &[&str]) -> Option<&'a mut String> {
    let mut current = value;
    for segment in path {
        current = current.get_mut(*segment)?;
    }
    match current {
        toml::Value::String(value) => Some(value),
        _ => None,
    }
}

fn restore_redacted_restart_env_values(
    config: &mut CampaignConfig,
    current_config: &CampaignConfig,
) -> anyhow::Result<()> {
    restore_redacted_env_values(
        "backend.codex_cli.env",
        &mut config.backend.codex_cli.env,
        &current_config.backend.codex_cli.env,
    )?;
    restore_redacted_env_values(
        "backend.claude_code_cli.env",
        &mut config.backend.claude_code_cli.env,
        &current_config.backend.claude_code_cli.env,
    )?;

    for profile in &mut config.models.profiles {
        if !profile
            .env
            .values()
            .any(|value| value == REDACTED_CONFIG_VALUE)
        {
            continue;
        }
        let current_profile = current_config.model_profile(&profile.id).ok_or_else(|| {
            anyhow::anyhow!(
                "restart source config contains redacted env values for model profile `{}`, but current project config has no matching profile to restore them",
                profile.id
            )
        })?;
        restore_redacted_env_values(
            &format!("models.{}.env", profile.id),
            &mut profile.env,
            &current_profile.env,
        )?;
    }

    Ok(())
}

fn restart_compatibility_config_fingerprint(
    cwd: &Path,
    config: &CampaignConfig,
) -> anyhow::Result<String> {
    let mut config = config.clone();
    config.project.repo = resolve_project_config_path(cwd, "project.repo", &config.project.repo)?;
    Ok(config_fingerprint(&config.dump_toml()?))
}

fn restore_redacted_env_values(
    path: &str,
    redacted_env: &mut BTreeMap<String, String>,
    current_env: &BTreeMap<String, String>,
) -> anyhow::Result<()> {
    for (key, value) in redacted_env {
        if value != REDACTED_CONFIG_VALUE {
            continue;
        }
        let current_value = current_env
            .get(key)
            .filter(|current| current.as_str() != REDACTED_CONFIG_VALUE)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "restart source config contains redacted env value `{path}.{key}`, but current project config has no unredacted value for that key; restore it in ultrafuzz.toml before using restart or continue"
                )
            })?;
        *value = current_value.clone();
    }
    Ok(())
}

fn validate_restart_compatibility(
    plan: &RestartPlan,
    graph_fingerprint: &str,
    config_fingerprint: &str,
    prompt_fingerprint: &str,
    normalized_config_fingerprint: Option<&str>,
) -> anyhow::Result<()> {
    if plan.mode != RestartMode::ReuseCompletedArtifacts {
        return Ok(());
    }
    if graph_fingerprint != plan.graph_fingerprint {
        anyhow::bail!(
            "continuation graph fingerprint mismatch: source {}, current {}",
            plan.graph_fingerprint,
            graph_fingerprint
        );
    }
    let expected_config_fingerprint =
        normalized_config_fingerprint.unwrap_or(&plan.config_fingerprint);
    if config_fingerprint != expected_config_fingerprint {
        anyhow::bail!(
            "continuation config fingerprint mismatch: source {}, current {}",
            expected_config_fingerprint,
            config_fingerprint
        );
    }
    let source_prompt_fingerprint = source_prompt_fingerprint(&plan.source_run_root)?;
    if prompt_fingerprint != source_prompt_fingerprint {
        anyhow::bail!(
            "continuation prompt fingerprint mismatch: source {}, current {}",
            source_prompt_fingerprint,
            prompt_fingerprint
        );
    }
    Ok(())
}

fn source_prompt_fingerprint(source_run_root: &Path) -> anyhow::Result<String> {
    let metadata_path = source_run_root.join(RUN_METADATA_FILE_NAME);
    let metadata = fs::read_to_string(&metadata_path).map_err(|error| {
        anyhow::anyhow!(
            "continuation source metadata `{}` is unavailable: {error}",
            metadata_path.display()
        )
    })?;
    let value = serde_json::from_str::<serde_json::Value>(&metadata).map_err(|error| {
        anyhow::anyhow!(
            "continuation source metadata `{}` is invalid JSON: {error}",
            metadata_path.display()
        )
    })?;
    value
        .get("prompt_fingerprint")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "continuation source metadata `{}` has no `prompt_fingerprint`; rerun the source campaign with a version that records prompt compatibility metadata before using `ultrafuzz continue`",
                metadata_path.display()
            )
        })
}

fn prompt_fingerprint(cwd: &Path, graph: &CampaignGraph) -> anyhow::Result<String> {
    let mut entries = graph
        .nodes
        .iter()
        .filter_map(|node| {
            let NodeKind::Agentic {
                logical_id,
                prompt_path,
                ..
            } = &node.kind
            else {
                return None;
            };
            Some((node.id.clone(), logical_id.clone(), prompt_path.clone()))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));

    let mut payload = String::new();
    for (node_id, logical_id, prompt_path) in entries {
        let markdown = prompt_markdown(cwd, &prompt_path)?;
        payload.push_str(node_id.as_str());
        payload.push('\0');
        payload.push_str(logical_id.as_str());
        payload.push('\0');
        payload.push_str(&prompt_path.to_string_lossy());
        payload.push('\0');
        payload.push_str(&config_fingerprint(&markdown));
        payload.push('\n');
    }
    Ok(config_fingerprint(&payload))
}

fn prompt_markdown(cwd: &Path, prompt_path: &Path) -> anyhow::Result<String> {
    let project_prompt_path = prompts_root(cwd).join(prompt_path);
    if project_prompt_path.exists() {
        return fs::read_to_string(&project_prompt_path).map_err(|error| {
            anyhow::anyhow!(
                "failed to read project prompt `{}` for compatibility fingerprint: {error}",
                project_prompt_path.display()
            )
        });
    }
    topology_prompt_markdown(prompt_path)
        .map(str::to_owned)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "prompt `{}` is unavailable for compatibility fingerprint",
                prompt_path.display()
            )
        })
}

fn node_timeout_metadata(graph: &CampaignGraph) -> Vec<serde_json::Value> {
    graph
        .nodes
        .iter()
        .filter_map(|node| {
            node.timeout.map(|timeout| {
                json!({
                    "id": node.id.to_string(),
                    "label": node.label.clone(),
                    "logical_id": logical_node_id(node),
                    "timeout_seconds": timeout.as_secs(),
                })
            })
        })
        .collect()
}

fn logical_node_id(node: &Node) -> Option<String> {
    match &node.kind {
        NodeKind::Agentic { logical_id, .. } => Some(logical_id.to_string()),
        NodeKind::AgentAttempt { strategy, .. } => Some(strategy.to_string()),
        NodeKind::ConsolidateStrategy { strategy } => Some(strategy.to_string()),
        _ => None,
    }
}

fn graph_for_run(
    run_id: RunId,
    cwd: &Path,
    config: &CampaignConfig,
    restart_plan: Option<&RestartPlan>,
    restart_source_config: Option<&CampaignConfig>,
) -> anyhow::Result<CampaignGraph> {
    let Some(plan) = restart_plan else {
        return Ok(build_campaign_graph_from_project(run_id, cwd, config)?);
    };

    let source_graph_path = plan.source_run_root.join(GRAPH_FILE_NAME);
    let source_graph_json = fs::read_to_string(&source_graph_path).map_err(|error| {
        anyhow::anyhow!(
            "restart source graph `{}` is unavailable: {error}",
            source_graph_path.display()
        )
    })?;
    let mut graph = serde_json::from_str::<CampaignGraph>(&source_graph_json).map_err(|error| {
        anyhow::anyhow!(
            "restart source graph `{}` is invalid: {error}",
            source_graph_path.display()
        )
    })?;
    let source_fingerprint = graph.fingerprint()?;
    if source_fingerprint != plan.graph_fingerprint {
        anyhow::bail!(
            "restart source graph fingerprint mismatch: expected {}, got {}",
            plan.graph_fingerprint,
            source_fingerprint
        );
    }
    if plan.mode == RestartMode::ReuseCompletedArtifacts {
        let current_graph = build_campaign_graph_from_project(run_id.clone(), cwd, config)?;
        let current_fingerprint = current_graph.fingerprint()?;
        if current_fingerprint != plan.graph_fingerprint {
            anyhow::bail!(
                "continuation graph/topology compatibility check failed: source graph fingerprint {}, current graph fingerprint {}",
                plan.graph_fingerprint,
                current_fingerprint
            );
        }
    }
    graph.run_id = run_id;
    let Some(source_config) = restart_source_config else {
        anyhow::bail!("restart source config was not available");
    };
    apply_restart_config_to_graph(&mut graph, config, source_config);
    Ok(graph)
}

fn apply_restart_config_to_graph(
    graph: &mut CampaignGraph,
    config: &CampaignConfig,
    source_config: &CampaignConfig,
) {
    let source_timeout = std::time::Duration::from_secs(
        source_config
            .invariants
            .invariant_testing_fuzzer_timeout_seconds,
    );
    let timeout =
        std::time::Duration::from_secs(config.invariants.invariant_testing_fuzzer_timeout_seconds);
    for node in &mut graph.nodes {
        if node.id.as_str() == STATEFUL_INVARIANT_RECON_CAMPAIGN_ID
            && node.timeout == Some(source_timeout)
        {
            node.timeout = Some(timeout);
        }
    }
}

fn seed_restart_state(
    layout: &RunLayout,
    graph: &CampaignGraph,
    graph_fingerprint: &str,
    config_fingerprint: &str,
    plan: &RestartPlan,
) -> anyhow::Result<()> {
    let source_state = RunStateStore::for_run_root(&plan.source_run_root).load()?;
    let mut state = RunState::from_graph(
        layout.run_id.clone(),
        graph,
        graph_fingerprint.to_owned(),
        config_fingerprint.to_owned(),
        Some(plan.source_run_id.clone()),
    );
    let graph_by_id = graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();

    for node_id in &plan.reusable_nodes {
        let source_node_state = source_state.nodes.get(node_id).ok_or_else(|| {
            anyhow::anyhow!(
                "{} source state has no reusable node `{node_id}`",
                restart_action_label(plan.mode)
            )
        })?;
        if !matches!(
            source_node_state.status,
            NodeStatus::Succeeded | NodeStatus::ReusedFromPriorRun
        ) {
            anyhow::bail!(
                "{} reusable node `{node_id}` has source status `{}`",
                restart_action_label(plan.mode),
                node_status_label(source_node_state.status)
            );
        }
        let node = graph_by_id.get(node_id).ok_or_else(|| {
            anyhow::anyhow!(
                "{} source graph has no reusable node `{node_id}`",
                restart_action_label(plan.mode)
            )
        })?;
        validate_restart_artifacts(&plan.source_run_root, node, plan.mode)?;
        copy_restart_artifacts(&plan.source_run_root, layout, node_id, plan.mode)?;
        let mut reused_state = source_node_state.clone();
        reused_state.status = NodeStatus::ReusedFromPriorRun;
        reused_state.last_error = None;
        reused_state.timed_out = false;
        state.nodes.insert(node_id.clone(), reused_state);
    }

    for node in &graph.nodes {
        if plan.reusable_nodes.contains(&node.id) || is_restart_meta_node(&node.id) {
            continue;
        }
        let Some(source_node_state) = source_state.nodes.get(&node.id) else {
            continue;
        };
        if !matches!(
            source_node_state.status,
            NodeStatus::Running | NodeStatus::TimedOut
        ) {
            continue;
        }
        if !restart_interrupted_node_has_complete_artifacts(&plan.source_run_root, node)? {
            continue;
        }
        copy_restart_artifacts(&plan.source_run_root, layout, &node.id, plan.mode)?;
        write_restart_artifact_manifest(layout, &node.id)?;
        let mut reused_state = source_node_state.clone();
        reused_state.status = NodeStatus::ReusedFromPriorRun;
        reused_state.last_error = None;
        reused_state.timed_out = false;
        reused_state.retry_after_epoch_ms = None;
        state.nodes.insert(node.id.clone(), reused_state);
    }

    state.refresh_usage_summary();
    RunStateStore::for_run_root(&layout.root).save(&state)?;
    Ok(())
}

fn write_restart_artifact_manifest(layout: &RunLayout, node_id: &NodeId) -> anyhow::Result<()> {
    ArtifactStore::new(layout.clone())
        .write_manifest(node_id)
        .map(|_| ())
        .map_err(Into::into)
}

fn validate_restart_artifacts(
    source_run_root: &Path,
    node: &Node,
    mode: RestartMode,
) -> anyhow::Result<()> {
    let source = source_run_root.join("artifacts").join(node.id.as_str());
    let label = restart_action_label(mode);
    if !source.exists() {
        anyhow::bail!(
            "{label} reusable node `{}` has no artifact directory at {}",
            node.id,
            source.display()
        );
    }
    let manifest_path = source.join(ARTIFACT_MANIFEST_FILE);
    if !manifest_path.is_file() {
        anyhow::bail!(
            "{label} reusable node `{}` has no artifact manifest at {}",
            node.id,
            manifest_path.display()
        );
    }

    for required in restart_required_artifacts(node) {
        let required_path = source.join(&required);
        let metadata = fs::symlink_metadata(&required_path).map_err(|error| {
            anyhow::anyhow!(
                "{label} reusable node `{}` is missing required artifact `{}` at {}: {error}",
                node.id,
                required.display(),
                required_path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            anyhow::bail!(
                "{label} reusable node `{}` required artifact `{}` may not be a symlink",
                node.id,
                required.display()
            );
        }
        if !metadata.file_type().is_file() {
            anyhow::bail!(
                "{label} reusable node `{}` required artifact `{}` must be a regular file",
                node.id,
                required.display()
            );
        }
    }

    let manifest = ArtifactManifest::read_from(&manifest_path).map_err(|error| {
        anyhow::anyhow!(
            "{label} reusable node `{}` has invalid artifact manifest at {}: {error}",
            node.id,
            manifest_path.display()
        )
    })?;
    if manifest.node_id != node.id {
        anyhow::bail!(
            "{label} reusable node `{}` artifact manifest at {} belongs to node `{}`",
            node.id,
            manifest_path.display(),
            manifest.node_id
        );
    }
    manifest.validate_dir(&source).map_err(|error| {
        anyhow::anyhow!(
            "{label} reusable node `{}` artifacts do not match manifest at {}: {error}",
            node.id,
            manifest_path.display()
        )
    })?;
    Ok(())
}

fn restart_required_artifacts(node: &Node) -> Vec<PathBuf> {
    match &node.kind {
        NodeKind::Agentic {
            required_artifacts, ..
        }
        | NodeKind::Reference {
            required_artifacts, ..
        } => required_artifacts.clone(),
        NodeKind::AggregateTestFiles => vec![PathBuf::from("aggregation.json")],
        _ => Vec::new(),
    }
}

fn restart_interrupted_node_has_complete_artifacts(
    source_run_root: &Path,
    node: &Node,
) -> anyhow::Result<bool> {
    let required_artifacts = restart_required_artifacts(node);
    if required_artifacts.is_empty() {
        return Ok(false);
    }

    let artifact_dir = source_run_root.join("artifacts").join(node.id.as_str());
    if !optional_restart_findings_artifact_is_valid(&artifact_dir.join("findings.json"))? {
        return Ok(false);
    }

    for required in &required_artifacts {
        if !is_safe_restart_artifact_path(required) {
            return Ok(false);
        }
        let artifact_path = artifact_dir.join(required);
        if !restart_required_artifact_is_valid(&artifact_path)? {
            return Ok(false);
        }
    }

    Ok(true)
}

fn optional_restart_findings_artifact_is_valid(path: &Path) -> anyhow::Result<bool> {
    let Some(metadata) = regular_restart_artifact_metadata(path)? else {
        return Ok(true);
    };
    if metadata.len() == 0 {
        return Ok(false);
    }
    Ok(read_restart_json_artifact(path)?.is_array())
}

fn is_restart_meta_node(node_id: &NodeId) -> bool {
    matches!(
        node_id.as_str(),
        ultrafuzz_topology::START_NODE_ID | ultrafuzz_topology::FINISH_NODE_ID
    )
}

fn restart_required_artifact_is_valid(path: &Path) -> anyhow::Result<bool> {
    let Some(metadata) = regular_restart_artifact_metadata(path)? else {
        return Ok(false);
    };
    if metadata.len() == 0 {
        return Ok(false);
    }
    if path.extension().and_then(OsStr::to_str) == Some("json") {
        let value = read_restart_json_artifact(path)?;
        return Ok(value.is_array() || value.is_object());
    }
    Ok(true)
}

fn regular_restart_artifact_metadata(path: &Path) -> anyhow::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(Some(metadata)),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_restart_json_artifact(path: &Path) -> anyhow::Result<Value> {
    let contents = fs::read(path)?;
    Ok(serde_json::from_slice(&contents)?)
}

fn is_safe_restart_artifact_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn copy_restart_artifacts(
    source_run_root: &Path,
    layout: &RunLayout,
    node_id: &NodeId,
    mode: RestartMode,
) -> anyhow::Result<()> {
    let source = source_run_root.join("artifacts").join(node_id.as_str());
    let label = restart_action_label(mode);
    if !source.exists() {
        anyhow::bail!(
            "{label} reusable node `{node_id}` has no artifact directory at {}",
            source.display()
        );
    }
    let destination = layout.artifact_dir(node_id);
    copy_restart_tree(&source, &destination).map_err(|error| {
        anyhow::anyhow!(
            "failed to copy {label} artifacts for node `{node_id}` from {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn copy_restart_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        anyhow::bail!("restart artifact source may not be a symlink");
    }
    if file_type.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let file_name = entry.file_name();
            copy_restart_tree(&entry.path(), &destination.join(Path::new(&file_name)))?;
        }
        return Ok(());
    }
    if file_type.is_file() {
        if let Ok(destination_metadata) = fs::symlink_metadata(destination) {
            if destination_metadata.file_type().is_symlink() {
                anyhow::bail!("restart artifact destination may not be a symlink");
            }
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
        return Ok(());
    }
    anyhow::bail!("restart artifact source must be a regular file or directory")
}

fn event_sinks_for_layout(layout: &RunLayout) -> Arc<dyn EventSink> {
    let jsonl: Arc<dyn EventSink> = Arc::new(JsonlEventSink::new(layout.events_jsonl_path()));
    let sqlite: Arc<dyn EventSink> = Arc::new(SqliteEventSink::new(layout.events_sqlite_path()));
    Arc::new(CompositeEventSink::new(vec![jsonl, sqlite]))
}

fn format_run_summary(kind: RunSummaryKind, summary: &RunSummary, output: RunOutputArgs) -> String {
    let _plain_output = output.plain;
    let _color_enabled = !output.no_color && std::env::var_os("NO_COLOR").is_none();
    if output.quiet {
        return format!(
            "run_id: {}\nstatus: {}\nrun_dir: {}",
            summary.run_id,
            run_status_label(summary.status),
            summary.run_dir.display()
        );
    }

    let mut lines = vec![
        kind.heading(summary.status).to_owned(),
        format!("Run ID: {}", summary.run_id),
        format!("Status: {}", run_status_label(summary.status)),
        format!("Graph nodes: {}", summary.graph_nodes),
        format!("Run directory: {}", summary.run_dir.display()),
        String::new(),
        "Next commands:".to_owned(),
    ];
    lines.extend(
        next_run_commands(
            &summary.run_id,
            report_command_available(summary.status, &summary.run_dir),
        )
        .into_iter()
        .map(command_line),
    );
    lines.extend([
        String::new(),
        "Artifacts:".to_owned(),
        format!("  {}", summary.run_dir.display()),
    ]);
    if output.verbose {
        lines.extend([
            String::new(),
            "Event stores:".to_owned(),
            format!("  {}", summary.run_dir.join("events.jsonl").display()),
            format!("  {}", summary.run_dir.join("events.sqlite").display()),
        ]);
    }
    lines.join("\n")
}

fn format_completed_run_summary(
    kind: RunSummaryKind,
    summary: &RunSummary,
    output: RunOutputArgs,
) -> anyhow::Result<String> {
    let output = format_run_summary(kind, summary, output);
    if summary.status == RunStatus::Succeeded {
        Ok(output)
    } else {
        anyhow::bail!("{output}")
    }
}

fn format_list(cwd: &Path) -> anyhow::Result<String> {
    let runs_dir = runs_dir_for_cwd(cwd)?;
    if !runs_dir.is_dir() {
        return Ok(format!("no ultrafuzz runs found in {}", runs_dir.display()));
    }

    let mut rows = Vec::new();
    for entry in fs::read_dir(&runs_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let run_id = entry.file_name().to_string_lossy().into_owned();
        if validate_run_id_component(&run_id).is_err() {
            continue;
        }
        let run_root = entry.path();
        let state = RunStateStore::for_run_root(&run_root).load().ok();
        let status = state
            .as_ref()
            .map(|state| run_status_label(state.status))
            .unwrap_or("unknown");
        let updated_at = state
            .as_ref()
            .and_then(|state| {
                state
                    .finished_at
                    .as_deref()
                    .or(state.started_at.as_deref())
                    .or(state.created_at.as_deref())
            })
            .unwrap_or("-");
        rows.push(format!(
            "{run_id}\t{status}\t{updated_at}\t{}",
            run_root.display()
        ));
    }
    rows.sort();
    if rows.is_empty() {
        Ok(format!("no ultrafuzz runs found in {}", runs_dir.display()))
    } else {
        let mut output = format!(
            "runs_dir: {}\nrun_id\tstatus\tupdated_at\trun_dir",
            runs_dir.display()
        );
        for row in rows {
            output.push('\n');
            output.push_str(&row);
        }
        Ok(output)
    }
}

#[derive(Clone, Debug)]
struct StatusRenderContext {
    run_id: RunId,
    run_root: PathBuf,
    state: RunState,
    health: ultrafuzz_state::RunHealthSummary,
    node_counts: BTreeMap<String, usize>,
}

fn format_status(cwd: &Path, args: StatusArgs) -> anyhow::Result<String> {
    let context = status_render_context(cwd, args.run_id.as_deref())?;
    if args.json {
        return format_status_json(&context);
    }
    Ok(format_status_human(&context, args))
}

fn status_render_context(
    cwd: &Path,
    requested_run_id: Option<&str>,
) -> anyhow::Result<StatusRenderContext> {
    let runs_dir = runs_dir_for_cwd(cwd)?;
    let (run_root, run_id) = resolve_existing_run_root(&runs_dir, requested_run_id)?;
    let state = RunStateStore::for_run_root(&run_root).load()?;
    let graph_path = run_root.join("graph.json");
    let graph: CampaignGraph =
        serde_json::from_str(&fs::read_to_string(&graph_path).map_err(|error| {
            anyhow::anyhow!(
                "failed to read graph for run `{}` at {}: {error}",
                run_id,
                graph_path.display()
            )
        })?)
        .map_err(|error| {
            anyhow::anyhow!(
                "failed to parse graph for run `{}` at {}: {error}",
                run_id,
                graph_path.display()
            )
        })?;
    let health = summarize_run_health(&run_root, &runs_dir, &graph, &state);
    let mut counts = BTreeMap::<&'static str, usize>::new();
    for node in state.nodes.values() {
        *counts.entry(node_status_label(node.status)).or_default() += 1;
    }
    let node_counts = counts
        .into_iter()
        .map(|(status, count)| (status.to_owned(), count))
        .collect();

    Ok(StatusRenderContext {
        run_id,
        run_root,
        state,
        health,
        node_counts,
    })
}

fn format_status_json(context: &StatusRenderContext) -> anyhow::Result<String> {
    Ok(serde_json::to_string_pretty(&json!({
        "run_id": context.run_id.to_string(),
        "run_dir": context.run_root.display().to_string(),
        "status": run_status_label(context.state.status),
        "graph_fingerprint": &context.state.graph_fingerprint,
        "config": context.run_root.join(RESOLVED_CONFIG_FILE_NAME).display().to_string(),
        "node_counts": &context.node_counts,
        "backend_model_profiles": backend_model_profiles(&context.state),
        "health": &context.health,
        "next_commands": next_run_commands(
            &context.run_id,
            report_command_available(context.state.status, &context.run_root),
        ),
        "artifacts": run_artifact_paths(&context.run_root),
    }))?)
}

fn format_status_human(context: &StatusRenderContext, args: StatusArgs) -> String {
    let _color_enabled = !args.plain && !args.no_color && std::env::var_os("NO_COLOR").is_none();
    let health = &context.health;
    let active_nodes = health
        .active_nodes
        .iter()
        .map(|node| format!("{} ({})", node.label, node.status))
        .collect::<Vec<_>>();
    let backend_models = backend_model_profiles(&context.state);
    let counts = node_count_pairs(&context.node_counts).join(", ");
    let compact_counts = format!(
        "completed={}, failed={}, skipped={}, reused={}",
        node_count(context, "succeeded"),
        node_count(context, "failed") + node_count(context, "timed-out"),
        node_count(context, "skipped"),
        node_count(context, "reused-from-prior-run")
    );
    let mut lines = vec![
        "Run status".to_owned(),
        format!("Run ID: {}", context.run_id),
        format!("Run directory: {}", context.run_root.display()),
        format!("Status: {}", run_status_label(context.state.status)),
        format!("Node counts: {compact_counts}"),
        format!(
            "All node statuses: {}",
            if counts.is_empty() {
                "-".to_owned()
            } else {
                counts
            }
        ),
        format!(
            "Active nodes: {}",
            if active_nodes.is_empty() {
                "-".to_owned()
            } else {
                active_nodes.join(", ")
            }
        ),
        format!(
            "Backend/model profiles: {}",
            format_list_or_dash(&backend_models)
        ),
        String::new(),
        "Health:".to_owned(),
        format!(
            "  process: {} ({})",
            health.process_liveness.status, health.process_liveness.detail
        ),
        format!(
            "  stdout: {}",
            format_log_freshness(&health.stdout_freshness)
        ),
        format!(
            "  stderr: {}",
            format_log_freshness(&health.stderr_freshness)
        ),
        format!("  timeout: {}", format_timeout_status(health)),
        format!(
            "  required artifacts: {}/{} present ({})",
            health.artifacts.present_required,
            health.artifacts.total_required,
            health.artifacts.status
        ),
        format!(
            "  stale: {} ({})",
            health.stale.status, health.stale.guidance
        ),
        String::new(),
        "Restart and lineage:".to_owned(),
        format!(
            "  restart reuse: {} ({} reusable) - {}",
            if health.restart.available {
                "available"
            } else {
                "unavailable"
            },
            health.restart.reusable_count,
            health.restart.guidance
        ),
        format!(
            "  source runs: {}",
            format_list_or_dash(&health.lineage.source_runs)
        ),
        format!(
            "  reused nodes: {}",
            format_list_or_dash(&health.lineage.reused_nodes)
        ),
        format!(
            "  newly executed nodes: {}",
            format_list_or_dash(&health.lineage.newly_executed_nodes)
        ),
        format!(
            "  cumulative elapsed: {}",
            health
                .lineage
                .cumulative_elapsed_seconds
                .map(format_seconds_compact)
                .unwrap_or_else(|| "unknown".to_owned())
        ),
        format!(
            "  final restart elapsed: {}",
            health
                .lineage
                .final_restart_elapsed_seconds
                .map(format_seconds_compact)
                .unwrap_or_else(|| "not a restart".to_owned())
        ),
        format!(
            "  tokens: {}",
            health
                .lineage
                .cumulative_tokens_used
                .as_deref()
                .unwrap_or("unavailable")
        ),
        format!(
            "  spend: {}",
            health
                .lineage
                .cumulative_estimated_spend
                .as_deref()
                .unwrap_or("unavailable")
        ),
        String::new(),
        "Next action:".to_owned(),
        format!("  {}", status_next_action(context)),
        String::new(),
        "Next commands:".to_owned(),
    ];
    lines.extend(
        next_run_commands(
            &context.run_id,
            report_command_available(context.state.status, &context.run_root),
        )
        .into_iter()
        .map(command_line),
    );
    lines.extend([
        String::new(),
        "Artifacts:".to_owned(),
        format!("  {}", context.run_root.display()),
        format!(
            "  config: {}",
            context.run_root.join(RESOLVED_CONFIG_FILE_NAME).display()
        ),
        format!(
            "  graph: {}",
            context.run_root.join(GRAPH_FILE_NAME).display()
        ),
        format!(
            "  events: {}",
            context.run_root.join("events.jsonl").display()
        ),
    ]);
    lines.join("\n")
}

fn next_run_commands(run_id: &RunId, include_report: bool) -> Vec<String> {
    let mut commands = vec![
        format!("ultrafuzz status {run_id}"),
        format!("ultrafuzz continue {run_id}"),
        format!("ultrafuzz restart {run_id}"),
        format!("ultrafuzz dashboard {run_id}"),
    ];
    if include_report {
        commands.push(format!("ultrafuzz report {run_id}"));
    }
    commands
}

fn report_command_available(status: RunStatus, run_root: &Path) -> bool {
    status == RunStatus::Succeeded
        || run_root.join("artifacts/final-report/report.md").is_file()
        || run_root
            .join("artifacts/final-report/report.json")
            .is_file()
}

fn command_line(command: String) -> String {
    format!("  {command}")
}

fn run_artifact_paths(run_root: &Path) -> serde_json::Value {
    json!({
        "run_dir": run_root.display().to_string(),
        "run_json": run_root.join(RUN_METADATA_FILE_NAME).display().to_string(),
        "config": run_root.join(RESOLVED_CONFIG_FILE_NAME).display().to_string(),
        "graph": run_root.join(GRAPH_FILE_NAME).display().to_string(),
        "state": run_root.join(ultrafuzz_state::STATE_FILE_NAME).display().to_string(),
        "events_jsonl": run_root.join("events.jsonl").display().to_string(),
        "events_sqlite": run_root.join("events.sqlite").display().to_string(),
        "artifacts_dir": run_root.join("artifacts").display().to_string(),
    })
}

fn node_count_pairs(counts: &BTreeMap<String, usize>) -> Vec<String> {
    counts
        .iter()
        .map(|(status, count)| format!("{status}={count}"))
        .collect()
}

fn node_count(context: &StatusRenderContext, status: &str) -> usize {
    context.node_counts.get(status).copied().unwrap_or_default()
}

fn backend_model_profiles(state: &RunState) -> Vec<String> {
    let mut profiles = state
        .nodes
        .values()
        .filter_map(|node| {
            let backend = node.backend.map(|backend| backend.to_string());
            let model = node
                .model
                .clone()
                .or_else(|| node.model_id.as_ref().map(ToString::to_string));
            match (backend, model) {
                (Some(backend), Some(model)) => Some(format!("{backend}/{model}")),
                (Some(backend), None) => Some(backend),
                (None, Some(model)) => Some(model),
                (None, None) => None,
            }
        })
        .collect::<Vec<_>>();
    profiles.sort();
    profiles.dedup();
    profiles
}

fn status_next_action(context: &StatusRenderContext) -> String {
    match context.state.status {
        RunStatus::Running if context.health.stale.stale => format!(
            "Run activity looks stale; inspect logs, then use `ultrafuzz continue {}` to reuse completed work or `ultrafuzz restart {}` for a clean rerun.",
            context.run_id, context.run_id
        ),
        RunStatus::Running => format!(
            "Monitor with `ultrafuzz status {}` or open `ultrafuzz dashboard {}`.",
            context.run_id, context.run_id
        ),
        RunStatus::Failed => format!(
            "Inspect artifacts, then use `ultrafuzz continue {}` to reuse completed work or `ultrafuzz restart {}` for a clean rerun.",
            context.run_id, context.run_id
        ),
        RunStatus::Succeeded => format!(
            "Review results with `ultrafuzz dashboard {}` or `ultrafuzz report {}`.",
            context.run_id, context.run_id
        ),
        RunStatus::Cancelled => format!(
            "Use `ultrafuzz continue {}` to pick up reusable work or `ultrafuzz restart {}` for a clean rerun.",
            context.run_id, context.run_id
        ),
        RunStatus::Pending => format!(
            "Check setup with `ultrafuzz doctor`, then inspect `ultrafuzz status {}` again.",
            context.run_id
        ),
    }
}

fn format_list_or_dash(values: &[String]) -> String {
    if values.is_empty() {
        "-".to_owned()
    } else {
        values.join(", ")
    }
}

fn format_log_freshness(freshness: &ultrafuzz_state::LogFreshnessSummary) -> String {
    match (
        freshness.newest_age_seconds,
        freshness.newest_path.as_deref(),
    ) {
        (Some(age), Some(path)) => format!(
            "{} (latest {}, {} ago)",
            freshness.status,
            path,
            format_seconds_compact(age)
        ),
        _ => freshness.status.clone(),
    }
}

fn format_timeout_status(health: &ultrafuzz_state::RunHealthSummary) -> String {
    match health.timeout.minimum_remaining_seconds {
        Some(remaining) => format!(
            "{} ({} remaining)",
            health.timeout.status,
            format_seconds_compact(remaining)
        ),
        None => health.timeout.status.clone(),
    }
}

fn format_seconds_compact(seconds: f64) -> String {
    if seconds < 60.0 {
        format!("{seconds:.1}s")
    } else if seconds < 3_600.0 {
        let minutes = (seconds / 60.0).floor();
        let remainder = seconds - minutes * 60.0;
        format!("{minutes:.0}m {remainder:.0}s")
    } else {
        let hours = (seconds / 3_600.0).floor();
        let minutes = ((seconds - hours * 3_600.0) / 60.0).round();
        format!("{hours:.0}h {minutes:.0}m")
    }
}

fn format_report(cwd: &Path, args: ReportArgs) -> anyhow::Result<String> {
    let runs_dir = runs_dir_for_cwd(cwd)?;
    let (run_root, run_id) = resolve_existing_run_root(&runs_dir, Some(&args.run_id))?;
    let report_path = run_root.join(if args.json {
        "artifacts/final-report/report.json"
    } else {
        "artifacts/final-report/report.md"
    });
    fs::read_to_string(&report_path).map_err(|error| {
        anyhow::anyhow!(
            "failed to read report for run `{}` at {}: {error}",
            run_id,
            report_path.display()
        )
    })
}

fn format_clean(cwd: &Path, args: CleanArgs) -> anyhow::Result<String> {
    let (run_root, run_id) = existing_run_root(cwd, &args.run_id)?;
    if !args.force {
        if let Ok(state) = RunStateStore::for_run_root(&run_root).load() {
            if state.status == RunStatus::Running {
                anyhow::bail!(
                    "run `{}` is still marked running; pass --force to clean it anyway",
                    run_id
                );
            }
        }
    }
    if !args.dry_run {
        fs::remove_dir_all(&run_root)?;
    }
    Ok(format!(
        "ultrafuzz clean complete (run_id: {}, mode: {}, run_dir: {}).",
        run_id,
        if args.dry_run { "dry-run" } else { "removed" },
        run_root.display()
    ))
}

fn format_triage(cwd: &Path, args: TriageArgs) -> anyhow::Result<String> {
    let (run_root, run_id) = existing_run_root(cwd, &args.run_id)?;
    let triage_dir = run_root.join("artifacts/triage");
    let summary_path = triage_dir.join("triage-summary.json");
    let findings_path = triage_dir.join("triaged-findings.json");
    let (findings, status_counts) = if findings_path.exists() {
        triage_counts_from_findings(&findings_path)?
    } else {
        triage_counts_from_summary(&summary_path)?
    };
    Ok(format!(
        "ultrafuzz triage summary (run_id: {}, findings: {}, statuses: {}, artifact: {}).",
        run_id,
        findings,
        status_counts,
        findings_path.display()
    ))
}

fn triage_counts_from_findings(findings_path: &Path) -> anyhow::Result<(usize, String)> {
    let findings = read_json_file(findings_path)?;
    let findings = findings.as_array().ok_or_else(|| {
        anyhow::anyhow!(
            "triage findings artifact at {} must be a JSON array",
            findings_path.display()
        )
    })?;
    let mut counts = BTreeMap::new();
    for finding in findings {
        let status = finding
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        *counts.entry(status.to_owned()).or_insert(0usize) += 1;
    }
    Ok((findings.len(), format_count_map(counts)))
}

fn triage_counts_from_summary(summary_path: &Path) -> anyhow::Result<(usize, String)> {
    let summary = read_json_file(summary_path)?;
    let findings = summary
        .get("findings")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as usize;
    let counts = summary
        .get("status_counts")
        .and_then(serde_json::Value::as_object)
        .map(|counts| {
            counts
                .iter()
                .map(|(status, count)| {
                    (status.clone(), count.as_u64().unwrap_or_default() as usize)
                })
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    Ok((findings, format_count_map(counts)))
}

fn format_count_map(counts: BTreeMap<String, usize>) -> String {
    let counts = counts
        .into_iter()
        .map(|(status, count)| format!("{status}={count}"))
        .collect::<Vec<_>>()
        .join(", ");
    if counts.is_empty() {
        "none".to_owned()
    } else {
        counts
    }
}

fn format_merge(cwd: &Path, args: MergeArgs) -> anyhow::Result<String> {
    let (run_root, run_id) = existing_run_root(cwd, &args.run_id)?;
    let aggregation_report_path = run_root.join(AGGREGATION_REPORT);
    let report = read_json_file(&aggregation_report_path)?;
    let source_test_files = json_u64(&report, "source_test_files");
    let copied_test_files = json_u64(&report, "copied_test_files");
    let generated_test_dir =
        json_optional_str(&report, "generated_test_dir").unwrap_or("test/foundry");
    Ok(format!(
        "ultrafuzz test aggregation summary (run_id: {}, source_test_files: {}, copied_test_files: {}, generated_test_dir: {}, artifact: {}).",
        run_id,
        source_test_files,
        copied_test_files,
        generated_test_dir,
        aggregation_report_path.display()
    ))
}

#[derive(Clone, Debug)]
struct DoctorRenderContext {
    config_source: String,
    project_root: PathBuf,
    git_available: bool,
    prompt_count: usize,
    topology: TopologyInspection,
    tool_command_policy: ToolCommandPolicyReport,
    toolchain: ToolchainDoctorResult,
    output_dir: PathBuf,
    output_dir_parent_exists: bool,
    workspace_mode: String,
    backend_result: BackendDoctorResult,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ToolchainToolSpec {
    display_command: &'static str,
    commands: &'static [&'static str],
    hint: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ToolchainBlockedCapability {
    node: String,
    capability: String,
}

#[derive(Clone, Debug)]
struct ToolchainRequirement {
    spec: ToolchainToolSpec,
    blocks: Vec<ToolchainBlockedCapability>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolchainDoctorCheckStatus {
    Pass,
    Fail,
}

#[derive(Clone, Debug)]
struct ToolchainDoctorCheck {
    display_command: String,
    commands: Vec<String>,
    status: ToolchainDoctorCheckStatus,
    resolved_command: Option<String>,
    resolved_path: Option<PathBuf>,
    blocks: Vec<ToolchainBlockedCapability>,
    hint: String,
}

#[derive(Clone, Debug)]
struct ToolchainDoctorResult {
    skipped_reason: Option<String>,
    checks: Vec<ToolchainDoctorCheck>,
}

const RECON_TOOL: ToolchainToolSpec = ToolchainToolSpec {
    display_command: "recon",
    commands: &["recon"],
    hint: "Install recon-fuzzer and ensure `recon` is on PATH for Ultrafuzz campaign workers.",
};
const ECHIDNA_TOOL: ToolchainToolSpec = ToolchainToolSpec {
    display_command: "echidna",
    commands: &["echidna"],
    hint: "Install Echidna and ensure `echidna` is on PATH when edited prompts invoke the Echidna binary directly.",
};
const COVG_EVAL_TOOL: ToolchainToolSpec = ToolchainToolSpec {
    display_command: "covg-eval/covg_eval",
    commands: &["covg-eval", "covg_eval"],
    hint: "Install the Recon Magic coverage evaluator and expose either `covg-eval` or `covg_eval` on PATH.",
};
const FORGE_TOOL: ToolchainToolSpec = ToolchainToolSpec {
    display_command: "forge",
    commands: &["forge"],
    hint: "Install Foundry and ensure `forge` is on PATH for build and invariant harness checks.",
};
const NODE_TOOL: ToolchainToolSpec = ToolchainToolSpec {
    display_command: "node",
    commands: &["node"],
    hint: "Install Node.js and ensure `node` is on PATH for Recon coverage generation tooling.",
};
const NPM_TOOL: ToolchainToolSpec = ToolchainToolSpec {
    display_command: "npm",
    commands: &["npm"],
    hint: "Install npm and ensure `npm` is on PATH with the Node.js toolchain used by campaign workers.",
};
const NPX_TOOL: ToolchainToolSpec = ToolchainToolSpec {
    display_command: "npx",
    commands: &["npx"],
    hint:
        "Install npm/npx and ensure `npx` is on PATH so `recon-generate` coverage commands can run.",
};
const TIMEOUT_TOOL: ToolchainToolSpec = ToolchainToolSpec {
    display_command: "timeout",
    commands: &["timeout"],
    hint: "Install GNU coreutils or provide a compatible `timeout` command on PATH for bounded fuzzing runs.",
};

fn format_doctor(cwd: &Path, args: DoctorArgs) -> anyhow::Result<String> {
    let context = doctor_render_context(cwd, args.backend.as_deref())?;
    if args.json {
        return format_doctor_json(&context);
    }
    Ok(format_doctor_human(&context, args))
}

fn doctor_render_context(cwd: &Path, backend: Option<&str>) -> anyhow::Result<DoctorRenderContext> {
    let registry = PromptRegistry::load_for_project(cwd)?;
    let backend_override = backend
        .map(BackendKind::from_str)
        .transpose()
        .map_err(|err| anyhow::anyhow!(err))?;
    let config = load_doctor_config(cwd, backend_override)?;
    let selected_backend = backend_override.unwrap_or(config.backend.default);
    let project_root = resolve_project_config_path(cwd, "project.repo", &config.project.repo)?;
    let backend = backend_for_config(&config, &project_root, selected_backend);
    let backend_result = backend.doctor()?;

    let config_source = if cwd.join(ultrafuzz_config::CONFIG_FILE_NAME).exists() {
        "ultrafuzz.toml"
    } else {
        "built-in defaults"
    };
    let git_status = command_available("git");
    let output_dir = resolve_project_config_path(cwd, "run.output_dir", &config.run.output_dir)?;
    let output_dir_status = output_dir
        .parent()
        .is_some_and(|parent| parent.exists() && parent.is_dir());
    let prompt_count = registry.strategy_definitions().len();
    let topology = topology_inspection(cwd, &config);
    let toolchain = ToolchainDoctorResult::from_topology(cwd, &topology)?;

    Ok(DoctorRenderContext {
        config_source: config_source.to_owned(),
        project_root,
        git_available: git_status,
        prompt_count,
        topology,
        tool_command_policy: tool_command_policy_report(&config),
        toolchain,
        output_dir,
        output_dir_parent_exists: output_dir_status,
        workspace_mode: config.run.workspace_mode.to_string(),
        backend_result,
    })
}

fn format_doctor_human(context: &DoctorRenderContext, args: DoctorArgs) -> String {
    let _color_enabled = !args.plain && !args.no_color && std::env::var_os("NO_COLOR").is_none();
    let mut lines = Vec::new();
    lines.push("ultrafuzz doctor".to_owned());
    lines.push(format!("config: ok ({})", context.config_source));
    lines.push(format!("repo: {}", context.project_root.display()));
    lines.push(format!(
        "git: {}",
        if context.git_available {
            "available"
        } else {
            "command-not-found"
        }
    ));
    lines.push(format!(
        "prompts: ok (strategy_definitions={})",
        context.prompt_count
    ));
    lines.push(context.topology.to_line());
    lines.push(context.tool_command_policy.summary_line());
    lines.push(context.tool_command_policy.check_line());
    lines.push(context.toolchain.to_line());
    for check in &context.toolchain.checks {
        lines.push(format!(
            "toolchain {}: {} - {}",
            check.display_command,
            toolchain_check_status_label(check.status),
            check.human_message()
        ));
    }
    lines.push(format!(
        "output_dir: {} ({})",
        context.output_dir.display(),
        if context.output_dir_parent_exists {
            "parent-exists"
        } else {
            "parent-missing"
        }
    ));
    lines.push(format!("workspace_mode: {}", context.workspace_mode));
    lines.push(format!(
        "backend {}: {} (command: {}, path: {}, sandbox: {}, sandbox_required: {}, permission_policy: {})",
        context.backend_result.kind,
        availability_label(context.backend_result.availability),
        context.backend_result.command,
        context.backend_result
            .command_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "not found".to_owned()),
        context.backend_result.sandbox_mode,
        context.backend_result.sandbox_required,
        if context.backend_result.permission_policy_supported {
            "ok"
        } else {
            "rejected"
        }
    ));
    lines.push(format!(
        "project_permission_files: {}",
        if context.backend_result.project_permission_files.is_empty() {
            "none".to_owned()
        } else {
            context
                .backend_result
                .project_permission_files
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        }
    ));
    for check in &context.backend_result.checks {
        lines.push(format!(
            "check {}: {} - {}",
            check.name,
            doctor_check_status_label(check.status),
            check.message
        ));
    }
    lines.push(String::new());
    if doctor_has_failures(context) {
        lines.extend([
            "Next:".to_owned(),
            "  Fix the failing checks above, then run:".to_owned(),
            "  ultrafuzz doctor".to_owned(),
        ]);
    } else {
        lines.push("Next commands:".to_owned());
        lines.extend([
            "  ultrafuzz run".to_owned(),
            "  ultrafuzz dashboard".to_owned(),
        ]);
    }
    lines.join("\n")
}

fn format_doctor_json(context: &DoctorRenderContext) -> anyhow::Result<String> {
    Ok(serde_json::to_string_pretty(&json!({
        "status": doctor_status(context),
        "config": {
            "status": "ok",
            "source": &context.config_source,
        },
        "repo": context.project_root.display().to_string(),
        "git": {
            "available": context.git_available,
            "status": if context.git_available { "available" } else { "command-not-found" },
        },
        "prompts": {
            "status": "ok",
            "strategy_definitions": context.prompt_count,
        },
        "topology": context.topology.to_json(),
        "tool_commands": context.tool_command_policy.to_json(),
        "toolchain": context.toolchain.to_json(),
        "output_dir": {
            "path": context.output_dir.display().to_string(),
            "parent_exists": context.output_dir_parent_exists,
        },
        "workspace_mode": &context.workspace_mode,
        "backend": &context.backend_result,
        "next_commands": doctor_next_commands(context),
    }))?)
}

fn doctor_has_failures(context: &DoctorRenderContext) -> bool {
    context.backend_result.availability != BackendAvailability::Available
        || !context.topology.is_ok()
        || context.toolchain.has_failures()
        || !context.output_dir_parent_exists
        || context
            .backend_result
            .checks
            .iter()
            .any(|check| check.status == BackendDoctorCheckStatus::Fail)
}

fn doctor_status(context: &DoctorRenderContext) -> &'static str {
    if doctor_has_failures(context) {
        "failed"
    } else if context
        .backend_result
        .checks
        .iter()
        .any(|check| check.status == BackendDoctorCheckStatus::Warn)
        || !context.tool_command_policy.missing.is_empty()
        || context.toolchain.is_skipped()
    {
        "warning"
    } else {
        "ok"
    }
}

fn doctor_next_commands(context: &DoctorRenderContext) -> Vec<String> {
    if doctor_has_failures(context) {
        vec!["ultrafuzz doctor".to_owned()]
    } else {
        vec!["ultrafuzz run".to_owned(), "ultrafuzz dashboard".to_owned()]
    }
}

impl ToolchainDoctorResult {
    fn from_topology(project_root: &Path, topology: &TopologyInspection) -> anyhow::Result<Self> {
        match topology.graph.as_ref() {
            Some(graph) => Self::from_graph(project_root, graph),
            None => Ok(Self {
                skipped_reason: Some(
                    "topology is invalid; fix topology before toolchain checks".to_owned(),
                ),
                checks: Vec::new(),
            }),
        }
    }

    fn from_graph(project_root: &Path, graph: &CampaignGraph) -> anyhow::Result<Self> {
        Self::from_graph_skipping(project_root, graph, &BTreeSet::new())
    }

    fn from_graph_skipping(
        project_root: &Path,
        graph: &CampaignGraph,
        skipped_nodes: &BTreeSet<NodeId>,
    ) -> anyhow::Result<Self> {
        let checks = toolchain_requirements_for_graph(project_root, graph, skipped_nodes)?
            .into_iter()
            .map(ToolchainDoctorCheck::from_requirement)
            .collect();
        Ok(Self {
            skipped_reason: None,
            checks,
        })
    }

    fn has_failures(&self) -> bool {
        self.checks
            .iter()
            .any(|check| check.status == ToolchainDoctorCheckStatus::Fail)
    }

    fn is_skipped(&self) -> bool {
        self.skipped_reason.is_some()
    }

    fn status_label(&self) -> &'static str {
        if self.has_failures() {
            "failed"
        } else if self.is_skipped() {
            "skipped"
        } else {
            "ok"
        }
    }

    fn to_line(&self) -> String {
        if let Some(reason) = &self.skipped_reason {
            return format!("toolchain: skipped ({reason})");
        }
        if self.checks.is_empty() {
            return "toolchain: ok (no topology-specific tools required)".to_owned();
        }
        format!(
            "toolchain: {} (checks={})",
            self.status_label(),
            self.checks.len()
        )
    }

    fn to_json(&self) -> serde_json::Value {
        json!({
            "status": self.status_label(),
            "skipped_reason": &self.skipped_reason,
            "checks": self
                .checks
                .iter()
                .map(ToolchainDoctorCheck::to_json)
                .collect::<Vec<_>>(),
        })
    }
}

impl ToolchainDoctorCheck {
    fn from_requirement(requirement: ToolchainRequirement) -> Self {
        let resolved = resolve_tool_command(requirement.spec.commands);
        Self {
            display_command: requirement.spec.display_command.to_owned(),
            commands: requirement
                .spec
                .commands
                .iter()
                .map(|command| (*command).to_owned())
                .collect(),
            status: if resolved.is_some() {
                ToolchainDoctorCheckStatus::Pass
            } else {
                ToolchainDoctorCheckStatus::Fail
            },
            resolved_command: resolved.as_ref().map(|(command, _)| command.to_owned()),
            resolved_path: resolved.map(|(_, path)| path),
            blocks: requirement.blocks,
            hint: requirement.spec.hint.to_owned(),
        }
    }

    fn human_message(&self) -> String {
        let blocks = blocked_capabilities_label(&self.blocks);
        match self.status {
            ToolchainDoctorCheckStatus::Pass => {
                let resolved = self
                    .resolved_path
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "unknown path".to_owned());
                let resolved_command = self
                    .resolved_command
                    .as_deref()
                    .unwrap_or(self.display_command.as_str());
                format!("found `{resolved_command}` at {resolved}; required by {blocks}")
            }
            ToolchainDoctorCheckStatus::Fail => {
                format!("blocks {blocks}; {}", self.hint)
            }
        }
    }

    fn to_json(&self) -> serde_json::Value {
        json!({
            "command": &self.display_command,
            "commands": &self.commands,
            "status": toolchain_check_status_label(self.status),
            "resolved_command": &self.resolved_command,
            "resolved_path": self
                .resolved_path
                .as_ref()
                .map(|path| path.display().to_string()),
            "blocking": self
                .blocks
                .iter()
                .map(|block| json!({
                    "node": &block.node,
                    "capability": &block.capability,
                }))
                .collect::<Vec<_>>(),
            "hint": &self.hint,
        })
    }
}

fn preflight_campaign_toolchain(
    project_root: &Path,
    graph: &CampaignGraph,
    skipped_nodes: &[NodeId],
) -> anyhow::Result<()> {
    let skipped_nodes = skipped_nodes.iter().cloned().collect::<BTreeSet<_>>();
    let toolchain =
        ToolchainDoctorResult::from_graph_skipping(project_root, graph, &skipped_nodes)?;
    if !toolchain.has_failures() {
        return Ok(());
    }
    anyhow::bail!("{}", toolchain_failure_message(&toolchain));
}

fn toolchain_failure_message(toolchain: &ToolchainDoctorResult) -> String {
    let mut lines = vec![
        "required campaign toolchain is unavailable; run `ultrafuzz doctor` after fixing these missing commands:"
            .to_owned(),
    ];
    for check in toolchain
        .checks
        .iter()
        .filter(|check| check.status == ToolchainDoctorCheckStatus::Fail)
    {
        lines.push(format!(
            "- {}: blocks {}; {}",
            check.display_command,
            blocked_capabilities_label(&check.blocks),
            check.hint
        ));
    }
    lines.join("\n")
}

fn toolchain_requirements_for_graph(
    project_root: &Path,
    graph: &CampaignGraph,
    skipped_nodes: &BTreeSet<NodeId>,
) -> anyhow::Result<Vec<ToolchainRequirement>> {
    let mut requirements = Vec::new();
    let mut seen_logical_nodes = BTreeSet::new();
    for node in &graph.nodes {
        if skipped_nodes.contains(&node.id) {
            continue;
        }
        let NodeKind::Agentic {
            logical_id,
            prompt_path,
            ..
        } = &node.kind
        else {
            continue;
        };
        if !seen_logical_nodes.insert(logical_id.clone()) {
            continue;
        }
        let prompt_markdown = prompt_markdown(project_root, prompt_path)?;
        match logical_id.as_str() {
            STATEFUL_INVARIANT_COVERAGE_ID => {
                let block = ToolchainBlockedCapability {
                    node: logical_id.to_string(),
                    capability: "stateful invariant coverage".to_owned(),
                };
                add_prompt_toolchain_requirements(
                    &mut requirements,
                    &prompt_markdown,
                    block,
                    &[
                        RECON_TOOL,
                        ECHIDNA_TOOL,
                        COVG_EVAL_TOOL,
                        FORGE_TOOL,
                        TIMEOUT_TOOL,
                    ],
                );
            }
            STATEFUL_INVARIANT_RECON_CAMPAIGN_ID => {
                let block = ToolchainBlockedCapability {
                    node: logical_id.to_string(),
                    capability: "stateful invariant Recon campaign".to_owned(),
                };
                add_prompt_toolchain_requirements(
                    &mut requirements,
                    &prompt_markdown,
                    block,
                    &[RECON_TOOL, ECHIDNA_TOOL, FORGE_TOOL, TIMEOUT_TOOL],
                );
            }
            _ => {}
        }
    }
    Ok(requirements)
}

fn add_prompt_toolchain_requirements(
    requirements: &mut Vec<ToolchainRequirement>,
    prompt_markdown: &str,
    block: ToolchainBlockedCapability,
    direct_specs: &[ToolchainToolSpec],
) {
    for spec in direct_specs {
        if prompt_mentions_command(prompt_markdown, spec.commands) {
            add_toolchain_requirement(requirements, *spec, block.clone());
        }
    }
    if prompt_mentions_command(prompt_markdown, NPX_TOOL.commands) {
        for spec in [NODE_TOOL, NPM_TOOL, NPX_TOOL] {
            add_toolchain_requirement(requirements, spec, block.clone());
        }
    } else if prompt_mentions_command(prompt_markdown, NPM_TOOL.commands) {
        for spec in [NODE_TOOL, NPM_TOOL] {
            add_toolchain_requirement(requirements, spec, block.clone());
        }
    } else if prompt_mentions_command(prompt_markdown, NODE_TOOL.commands) {
        add_toolchain_requirement(requirements, NODE_TOOL, block.clone());
    }
}

fn prompt_mentions_command(markdown: &str, commands: &[&str]) -> bool {
    let mut in_fenced_code = false;
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fenced_code = !in_fenced_code;
            continue;
        }
        let mentions_command = if in_fenced_code {
            fenced_code_line_mentions_command(line, commands)
        } else {
            line_mentions_command(line, commands)
        };
        if mentions_command {
            return true;
        }
    }
    false
}

fn fenced_code_line_mentions_command(line: &str, commands: &[&str]) -> bool {
    let normalized = line.to_ascii_lowercase();
    commands.iter().any(|command| {
        let command = command.to_ascii_lowercase();
        contains_executable_command_token(&normalized, &command)
            && !line_negates_or_documents_missing_command(&normalized, &command)
    })
}

fn line_mentions_command(line: &str, commands: &[&str]) -> bool {
    let normalized = line.to_ascii_lowercase();
    let code_ranges = inline_code_ranges(line);
    let plain = line_without_inline_code(line, &code_ranges).to_ascii_lowercase();
    commands.iter().any(|command| {
        let command = command.to_ascii_lowercase();
        code_ranges.iter().any(|range| {
            contains_executable_command_token(&normalized[range.clone()], &command)
                && !line_negates_or_documents_missing_command(&normalized, &command)
        }) || contains_plain_command_instruction(&plain, &command)
    })
}

fn inline_code_ranges(line: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut offset = 0;
    while let Some(open_relative) = line[offset..].find('`') {
        let open = offset + open_relative;
        let content_start = open + 1;
        let Some(close_relative) = line[content_start..].find('`') else {
            break;
        };
        let close = content_start + close_relative;
        if content_start < close {
            ranges.push(content_start..close);
        }
        offset = close + 1;
    }
    ranges
}

fn line_without_inline_code(line: &str, ranges: &[std::ops::Range<usize>]) -> String {
    if ranges.is_empty() {
        return line.to_owned();
    }
    let mut plain = String::with_capacity(line.len());
    let mut range_index = 0;
    for (index, character) in line.char_indices() {
        while ranges
            .get(range_index)
            .is_some_and(|range| index >= range.end)
        {
            range_index += 1;
        }
        if ranges
            .get(range_index)
            .is_some_and(|range| range.contains(&index))
        {
            plain.push(' ');
        } else {
            plain.push(character);
        }
    }
    plain
}

fn contains_executable_command_token(haystack: &str, command: &str) -> bool {
    command_token_ranges(haystack, command)
        .into_iter()
        .any(|range| {
            is_shell_command_position(haystack, &range)
                && !token_documents_missing_command(haystack, range)
        })
}

fn is_shell_command_position(haystack: &str, range: &std::ops::Range<usize>) -> bool {
    let prefix = &haystack[..range.start];
    let segment = prefix
        .rsplit_once([';', '|', '&'])
        .map(|(_, suffix)| suffix)
        .unwrap_or(prefix)
        .trim();
    if segment.is_empty() {
        return true;
    }
    segment.split_whitespace().all(is_shell_command_prefix_word)
}

fn is_shell_command_prefix_word(word: &str) -> bool {
    let word = word.trim_matches(|character: char| {
        matches!(character, '(' | ')' | '{' | '}' | '[' | ']' | '"' | '\'')
    });
    if word.is_empty() || word.starts_with('-') {
        return true;
    }
    if word.chars().all(|character| character.is_ascii_digit()) {
        return true;
    }
    if word.contains('=') && !word.starts_with('=') {
        return true;
    }
    matches!(word, "command" | "env" | "sudo" | "time" | "timeout")
}

fn contains_plain_command_instruction(line: &str, command: &str) -> bool {
    command_token_ranges(line, command)
        .into_iter()
        .any(|range| {
            has_execution_verb_before(line, range.start)
                && !line_negates_or_documents_missing_command(line, command)
                && !token_documents_missing_command(line, range)
        })
}

fn command_token_ranges(haystack: &str, command: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut offset = 0;
    while let Some(index) = haystack[offset..].find(command) {
        let start = offset + index;
        let end = start + command.len();
        if is_command_boundary_before(haystack[..start].chars().next_back())
            && is_command_boundary_after(haystack[end..].chars().next(), &haystack[end..])
        {
            ranges.push(start..end);
        }
        offset = end;
    }
    ranges
}

fn is_command_boundary_before(character: Option<char>) -> bool {
    character.is_none_or(|character| {
        !character.is_ascii_alphanumeric() && !matches!(character, '-' | '_' | '.')
    })
}

fn is_command_boundary_after(character: Option<char>, suffix: &str) -> bool {
    match character {
        Some(character) if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') => {
            false
        }
        Some('.') => suffix
            .chars()
            .nth(1)
            .is_none_or(|next| !next.is_ascii_alphanumeric()),
        _ => true,
    }
}

fn has_execution_verb_before(line: &str, command_start: usize) -> bool {
    let prefix = line[..command_start]
        .rsplit_once(['.', ';', ':', '!', '?'])
        .map(|(_, suffix)| suffix)
        .unwrap_or(&line[..command_start]);
    let words = prefix
        .split(|character: char| !character.is_ascii_alphabetic() && character != '\'')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    words
        .iter()
        .rev()
        .filter(|word| !matches!(**word, "the" | "a" | "an"))
        .take(2)
        .any(|word| {
            matches!(
                *word,
                "run"
                    | "running"
                    | "execute"
                    | "executing"
                    | "invoke"
                    | "invoking"
                    | "call"
                    | "calling"
                    | "launch"
                    | "launching"
                    | "start"
                    | "starting"
                    | "use"
                    | "using"
                    | "install"
                    | "installing"
                    | "evaluate"
                    | "evaluating"
                    | "generate"
                    | "generating"
                    | "prefer"
                    | "preferring"
            )
        })
}

fn line_negates_or_documents_missing_command(line: &str, command: &str) -> bool {
    command_token_ranges(line, command)
        .into_iter()
        .any(|range| token_documents_missing_command(line, range))
}

fn token_documents_missing_command(line: &str, range: std::ops::Range<usize>) -> bool {
    let prefix_start = line[..range.start]
        .rfind(['.', ';', '\n'])
        .map(|index| index + 1)
        .unwrap_or(0);
    let prefix = &line[prefix_start..range.start];
    let suffix_end = line[range.end..]
        .find(['.', ';', '\n'])
        .map(|index| range.end + index)
        .unwrap_or(line.len());
    let suffix = &line[range.end..suffix_end];
    let prefix_words = prefix
        .split(|character: char| !character.is_ascii_alphabetic() && character != '\'')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let negated_before = prefix_words.iter().any(|word| {
        matches!(
            *word,
            "not"
                | "don't"
                | "dont"
                | "never"
                | "without"
                | "avoid"
                | "avoids"
                | "avoiding"
                | "skip"
                | "skips"
                | "skipping"
        )
    }) || prefix_words
        .iter()
        .rev()
        .take(5)
        .any(|word| matches!(*word, "missing" | "absent" | "unavailable" | "blocked"));
    let missing_after = contains_missing_tool_phrase(suffix);
    negated_before || missing_after
}

fn contains_missing_tool_phrase(suffix: &str) -> bool {
    let suffix = suffix.trim_start_matches(|character: char| !character.is_ascii_alphabetic());
    [
        "is absent",
        "are absent",
        "absent",
        "is missing",
        "are missing",
        "missing",
        "is unavailable",
        "are unavailable",
        "unavailable",
        "is blocked",
        "are blocked",
        "blocked",
        "cannot be installed",
        "can't be installed",
    ]
    .iter()
    .any(|phrase| suffix.starts_with(phrase))
}

fn add_toolchain_requirement(
    requirements: &mut Vec<ToolchainRequirement>,
    spec: ToolchainToolSpec,
    block: ToolchainBlockedCapability,
) {
    if let Some(requirement) = requirements
        .iter_mut()
        .find(|requirement| requirement.spec.display_command == spec.display_command)
    {
        if !requirement.blocks.contains(&block) {
            requirement.blocks.push(block);
        }
        return;
    }
    requirements.push(ToolchainRequirement {
        spec,
        blocks: vec![block],
    });
}

fn blocked_capabilities_label(blocks: &[ToolchainBlockedCapability]) -> String {
    blocks
        .iter()
        .map(|block| format!("{} ({})", block.capability, block.node))
        .collect::<Vec<_>>()
        .join(", ")
}

fn resolve_tool_command(commands: &[&str]) -> Option<(String, PathBuf)> {
    commands.iter().find_map(|command| {
        resolve_executable_on_path(command).map(|path| ((*command).to_owned(), path))
    })
}

fn resolve_executable_on_path(command: &str) -> Option<PathBuf> {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return executable_file(command_path).then(|| command_path.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(command))
        .find(|candidate| executable_file(candidate))
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[derive(Clone, Debug)]
struct TopologyInspection {
    logical_nodes: Option<usize>,
    graph_nodes: Option<usize>,
    error: Option<String>,
    graph: Option<CampaignGraph>,
}

impl TopologyInspection {
    fn is_ok(&self) -> bool {
        self.error.is_none()
    }

    fn to_line(&self) -> String {
        match (self.logical_nodes, self.graph_nodes, self.error.as_deref()) {
            (Some(logical_nodes), Some(graph_nodes), None) => {
                format!("topology: ok (logical_nodes={logical_nodes}, graph_nodes={graph_nodes})")
            }
            (_, _, Some(error)) => format!("topology: invalid ({error})"),
            _ => "topology: invalid (unknown topology state)".to_owned(),
        }
    }

    fn to_json(&self) -> serde_json::Value {
        json!({
            "status": if self.is_ok() { "ok" } else { "invalid" },
            "logical_nodes": self.logical_nodes,
            "graph_nodes": self.graph_nodes,
            "error": &self.error,
        })
    }
}

fn topology_inspection(cwd: &Path, config: &CampaignConfig) -> TopologyInspection {
    match load_project_topology(cwd).and_then(|topology| {
        build_campaign_graph_from_project(RunId::from("inspect"), cwd, config)
            .map(|graph| (topology, graph))
    }) {
        Ok((topology, graph)) => TopologyInspection {
            logical_nodes: Some(topology.nodes.len()),
            graph_nodes: Some(graph.nodes.len()),
            error: None,
            graph: Some(graph),
        },
        Err(error) => TopologyInspection {
            logical_nodes: None,
            graph_nodes: None,
            error: Some(error.to_string()),
            graph: None,
        },
    }
}

#[derive(Clone, Debug)]
struct ToolCommandPolicyReport {
    available: Vec<String>,
    missing: Vec<String>,
}

impl ToolCommandPolicyReport {
    fn summary_line(&self) -> String {
        format!(
            "tool_commands: available={} missing={}",
            format_command_list(&self.available),
            format_command_list(&self.missing)
        )
    }

    fn check_line(&self) -> String {
        if self.missing.is_empty() {
            "check tool-commands: pass - all allowlisted tool command executables were found on PATH"
                .to_owned()
        } else {
            format!(
                "check tool-commands: warn - missing allowlisted tool command executable(s) on PATH: {}",
                self.missing.join(",")
            )
        }
    }

    fn to_json(&self) -> serde_json::Value {
        json!({
            "status": if self.missing.is_empty() { "ok" } else { "warning" },
            "available": &self.available,
            "missing": &self.missing,
        })
    }
}

fn tool_command_policy_report(config: &CampaignConfig) -> ToolCommandPolicyReport {
    let commands = config
        .tools
        .commands
        .allow
        .iter()
        .filter_map(|rule| command_rule_executable(rule))
        .fold(BTreeMap::<String, bool>::new(), |mut commands, command| {
            let available = resolve_command_on_path(&command).is_some();
            commands.entry(command).or_insert(available);
            commands
        });
    let available = commands
        .iter()
        .filter_map(|(command, available)| available.then_some(command.clone()))
        .collect::<Vec<_>>();
    let missing = commands
        .iter()
        .filter_map(|(command, available)| (!available).then_some(command.clone()))
        .collect::<Vec<_>>();
    ToolCommandPolicyReport { available, missing }
}

fn format_command_list(commands: &[String]) -> String {
    if commands.is_empty() {
        "none".to_owned()
    } else {
        commands.join(",")
    }
}

fn command_rule_executable(rule: &str) -> Option<String> {
    rule.split_whitespace().next().map(str::to_owned)
}

fn load_doctor_config(
    cwd: &Path,
    backend_override: Option<BackendKind>,
) -> anyhow::Result<CampaignConfig> {
    let registry = PromptRegistry::load_for_project(cwd)?;
    let cli_overrides = CliOverrides {
        backend: backend_override,
        ..CliOverrides::default()
    };
    if cwd.join(ultrafuzz_config::CONFIG_FILE_NAME).exists() {
        ultrafuzz_config::load_resolved_config(
            cwd,
            registry.strategy_definitions(),
            EnvOverrides::from_env()?,
            cli_overrides,
        )
        .map_err(Into::into)
    } else {
        ultrafuzz_config::resolve_config_from_toml(
            None,
            registry.strategy_definitions(),
            EnvOverrides::from_env()?,
            cli_overrides,
        )
        .map_err(Into::into)
    }
}

fn dashboard_server_config(
    cwd: &Path,
    args: DashboardArgs,
) -> anyhow::Result<ultrafuzz_dashboard::DashboardServerConfig> {
    let config_path = cwd.join(ultrafuzz_config::CONFIG_FILE_NAME);
    if !config_path.exists() {
        ultrafuzz_config::write_default_config(cwd, false)?;
        ultrafuzz_prompts::scaffold_project_prompts(cwd, false)?;
        fs::create_dir_all(default_runs_dir(cwd)?)?;
    }

    let requested_run_id = args.run_id;
    let mut config = ultrafuzz_dashboard::DashboardServerConfig {
        project_root: cwd.to_path_buf(),
        runs_dir: runs_dir_for_cwd(cwd)?,
        run_id: None,
        ..ultrafuzz_dashboard::DashboardServerConfig::default()
    };

    if config_path.exists() {
        let registry = PromptRegistry::load_for_project(cwd)?;
        let resolved = ultrafuzz_config::load_resolved_config(
            cwd,
            registry.strategy_definitions(),
            EnvOverrides::from_env()?,
            CliOverrides::default(),
        )?;
        config.host = resolved.dashboard.host;
        config.port = resolved.dashboard.port;
        config.live_updates = resolved.dashboard.live_updates;
        config.runs_dir =
            resolve_project_config_path(cwd, "run.output_dir", &resolved.run.output_dir)?;
    }

    if let Some(host) = args.host {
        config.host = host;
    }
    if let Some(port) = args.port {
        config.port = port;
    }
    config.run_id = match requested_run_id.as_deref() {
        Some("latest") => Some(latest_run_id(&config.runs_dir)?),
        Some(run_id) => Some(parse_run_id_component(run_id)?),
        None => None,
    };

    Ok(config)
}

fn format_materialize(cwd: &Path, args: MaterializeArgs) -> anyhow::Result<String> {
    let runs_dir = runs_dir_for_cwd(cwd)?;
    let (run_root, run_id) = existing_run_root(cwd, &args.run_id)?;

    let config_value = read_resolved_config_value(&run_root)?;
    if !toml_bool(
        &config_value,
        &["permissions", "materialize_outputs_as_unstaged"],
    )
    .unwrap_or(true)
    {
        anyhow::bail!("permissions.materialize_outputs_as_unstaged is false for run `{run_id}`");
    }

    let target_repo = materialization_target_repo(cwd, &config_value)?;
    let target_repo = target_repo.canonicalize().map_err(|error| {
        anyhow::anyhow!(
            "target repo `{}` is not accessible: {error}",
            target_repo.display()
        )
    })?;
    ensure_git_worktree(&target_repo)?;

    let using_default_patch = args.patches.is_empty() && args.copies.is_empty();
    let patches = if using_default_patch {
        anyhow::bail!(
            "no default materialization output is available; generated tests are aggregated during `ultrafuzz run`, or pass --patch/--copy explicitly"
        );
    } else {
        args.patches.clone()
    };
    if patches.is_empty() && args.copies.is_empty() {
        anyhow::bail!("no materialization outputs selected");
    }

    let staged_before = git_stdout(&target_repo, &["diff", "--cached", "--name-only"])?;
    let head_before = git_stdout(&target_repo, &["rev-parse", "HEAD"])?;
    let mut patch_records = Vec::new();
    let mut copy_records = Vec::new();
    let mut patch_plans = Vec::new();
    let mut copy_plans = Vec::new();

    for patch in patches {
        let source = resolve_run_artifact_path(&run_root, &patch)?;
        if fs::metadata(&source)?.len() == 0 {
            anyhow::bail!("selected patch artifact `{}` is empty", patch.display());
        }
        patch_plans.push(PatchMaterializationPlan {
            requested: patch,
            source,
        });
    }

    for copy in &args.copies {
        let source = resolve_run_artifact_path(&run_root, &copy.source)?;
        let destination = resolve_repo_destination(&target_repo, &copy.destination, args.force)?;
        copy_plans.push(CopyMaterializationPlan {
            requested_source: copy.source.clone(),
            requested_destination: copy.destination.clone(),
            source,
            destination,
        });
    }

    preflight_patch_sequence(&target_repo, &patch_plans)?;

    let mut applied_patch_sources = Vec::new();
    for plan in &patch_plans {
        if !args.dry_run {
            let apply = git_apply(&target_repo, &plan.source)?;
            if !apply.success {
                let rollback_errors =
                    rollback_applied_patches(&target_repo, &applied_patch_sources);
                let rollback_note = if rollback_errors.is_empty() {
                    "already-applied selected patches were rolled back".to_owned()
                } else {
                    format!(
                        "rollback of already-applied selected patches had errors: {}",
                        rollback_errors.join("; ")
                    )
                };
                anyhow::bail!(
                    "failed to apply selected patch `{}` to {}: {}; {}",
                    plan.requested.display(),
                    target_repo.display(),
                    apply.stderr.trim(),
                    rollback_note
                );
            }
            applied_patch_sources.push(plan.source.clone());
        }
        patch_records.push(json!({
            "source": plan.requested.display().to_string(),
            "applied": !args.dry_run,
        }));
    }

    for plan in &copy_plans {
        if !args.dry_run {
            if let Some(parent) = plan.destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&plan.source, &plan.destination)?;
        }
        copy_records.push(json!({
            "source": plan.requested_source.display().to_string(),
            "destination": plan.requested_destination.display().to_string(),
            "copied": !args.dry_run,
        }));
    }

    let staged_after = git_stdout(&target_repo, &["diff", "--cached", "--name-only"])?;
    if staged_after != staged_before {
        anyhow::bail!("materialization unexpectedly changed the staged index");
    }
    let head_after = git_stdout(&target_repo, &["rev-parse", "HEAD"])?;
    if head_after != head_before {
        anyhow::bail!("materialization unexpectedly changed repository HEAD");
    }

    let status_short = git_stdout(&target_repo, &["status", "--short"])?;
    let materialization_node = NodeId::from("materialization");
    let materialization_dir = run_root
        .join("artifacts")
        .join(materialization_node.as_str());
    fs::create_dir_all(&materialization_dir)?;
    let materialization_path = materialization_dir.join("materialization.json");
    fs::write(
        &materialization_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "schema_version": "1.0",
                "run_id": run_id.to_string(),
                "target_repo": target_repo.display().to_string(),
                "mode": if args.dry_run { "dry-run" } else { "unstaged-working-tree" },
                "dry_run": args.dry_run,
                "patches": patch_records,
                "copies": copy_records,
                "staged_index_changed": false,
                "head_changed": false,
                "git_status_short": status_short,
            }))?
        ),
    )?;

    let layout = RunLayout::new(&runs_dir, run_id.clone());
    let store = ArtifactStore::new(layout.clone());
    store.write_manifest(&materialization_node)?;
    let sink = event_sinks_for_layout(&layout);
    emit_event(
        sink.as_ref(),
        &run_id,
        RunEvent::ArtifactCreated {
            node_id: materialization_node.clone(),
            path: materialization_path.clone(),
        },
    )?;

    Ok(format!(
        "ultrafuzz materialize complete (run_id: {}, mode: {}, patches: {}, copies: {}, target_repo: {}, artifact: {}).",
        run_id,
        if args.dry_run { "dry-run" } else { "unstaged-working-tree" },
        patch_records.len(),
        copy_records.len(),
        target_repo.display(),
        materialization_path.display()
    ))
}

fn command_available(command: &str) -> bool {
    resolve_command_on_path(command).is_some()
}

fn resolve_command_on_path(command: &str) -> Option<PathBuf> {
    let path = Path::new(command);
    if path.is_absolute() || command.contains(std::path::MAIN_SEPARATOR) {
        return path.is_file().then(|| path.to_path_buf());
    }
    let path_env = env::var_os("PATH")?;
    env::split_paths(&path_env)
        .map(|dir| dir.join(command))
        .find(|candidate| candidate.is_file())
}

struct CliOverrideArgs {
    backend: Option<String>,
    max_parallel_agents: Option<usize>,
    max_parallel_nodes: Option<usize>,
    dynamic_strategies_enumerator: Option<usize>,
    triage_quorum: Option<usize>,
    triage_panel_size: Option<usize>,
    invariant_property_priority_threshold: Option<InvariantPropertyPriorityThreshold>,
    invariant_testing_fuzzer_timeout_seconds: Option<u64>,
}

fn cli_overrides(args: CliOverrideArgs) -> anyhow::Result<CliOverrides> {
    Ok(CliOverrides {
        backend: args
            .backend
            .as_deref()
            .map(BackendKind::from_str)
            .transpose()
            .map_err(|err| anyhow::anyhow!(err))?,
        max_parallel_agents: args.max_parallel_agents,
        max_parallel_nodes: args.max_parallel_nodes,
        dynamic_strategies_enumerator: args.dynamic_strategies_enumerator,
        triage_quorum: args.triage_quorum,
        triage_panel_size: args.triage_panel_size,
        invariant_property_priority_threshold: args.invariant_property_priority_threshold,
        invariant_testing_fuzzer_timeout_seconds: args.invariant_testing_fuzzer_timeout_seconds,
    })
}

fn resolve_project_config_path(
    cwd: &Path,
    field_name: &'static str,
    path: &Path,
) -> anyhow::Result<PathBuf> {
    Ok(ultrafuzz_config::resolve_project_path(
        cwd, field_name, path,
    )?)
}

fn availability_label(availability: BackendAvailability) -> &'static str {
    match availability {
        BackendAvailability::Available => "available",
        BackendAvailability::CommandNotFound => "command-not-found",
        BackendAvailability::Unsupported => "unsupported",
    }
}

fn doctor_check_status_label(status: BackendDoctorCheckStatus) -> &'static str {
    match status {
        BackendDoctorCheckStatus::Pass => "pass",
        BackendDoctorCheckStatus::Warn => "warn",
        BackendDoctorCheckStatus::Fail => "fail",
    }
}

fn toolchain_check_status_label(status: ToolchainDoctorCheckStatus) -> &'static str {
    match status {
        ToolchainDoctorCheckStatus::Pass => "pass",
        ToolchainDoctorCheckStatus::Fail => "fail",
    }
}

fn default_runs_dir(cwd: &Path) -> anyhow::Result<PathBuf> {
    resolve_project_config_path(cwd, "run.output_dir", Path::new(".ultrafuzz/runs"))
}

fn runs_dir_for_cwd(cwd: &Path) -> anyhow::Result<PathBuf> {
    if let Some(output_dir) = std::env::var_os("ULTRAFUZZ_OUTPUT_DIR") {
        return resolve_project_config_path(cwd, "run.output_dir", &PathBuf::from(output_dir));
    }

    let config_path = cwd.join(ultrafuzz_config::CONFIG_FILE_NAME);
    let Ok(config_toml) = fs::read_to_string(config_path) else {
        return default_runs_dir(cwd);
    };
    let Ok(value) = toml::from_str::<toml::Value>(&config_toml) else {
        return default_runs_dir(cwd);
    };
    if let Some(path) = toml_str(&value, &["run", "output_dir"]).map(PathBuf::from) {
        resolve_project_config_path(cwd, "run.output_dir", &path)
    } else {
        default_runs_dir(cwd)
    }
}

fn existing_run_root(cwd: &Path, run_id: &str) -> anyhow::Result<(PathBuf, RunId)> {
    validate_run_id_component(run_id)?;
    let runs_dir = runs_dir_for_cwd(cwd)?;
    existing_run_root_in(&runs_dir, run_id)
}

fn resolve_existing_run_root(
    runs_dir: &Path,
    requested_run_id: Option<&str>,
) -> anyhow::Result<(PathBuf, RunId)> {
    match requested_run_id {
        None | Some("latest") => {
            let run_id = latest_run_id(runs_dir)?;
            existing_run_root_in(runs_dir, run_id.as_str())
        }
        Some(run_id) => existing_run_root_in(runs_dir, run_id),
    }
}

fn existing_run_root_in(runs_dir: &Path, run_id: &str) -> anyhow::Result<(PathBuf, RunId)> {
    let run_id = parse_run_id_component(run_id)?;
    let run_root = runs_dir.join(run_id.as_str());
    if !run_root.is_dir() {
        anyhow::bail!(
            "run `{}` was not found under {}\n\nNext:\n  ultrafuzz list\n  ultrafuzz run",
            run_id,
            runs_dir.display()
        );
    }

    let canonical_runs = runs_dir.canonicalize()?;
    let canonical_run = run_root.canonicalize()?;
    if !canonical_run.starts_with(&canonical_runs) {
        anyhow::bail!(
            "run `{}` resolves outside runs directory {}",
            run_id,
            runs_dir.display()
        );
    }
    Ok((run_root, run_id))
}

fn validate_run_id_component(run_id: &str) -> anyhow::Result<()> {
    parse_run_id_component(run_id).map(|_| ())
}

fn parse_run_id_component(run_id: &str) -> anyhow::Result<RunId> {
    let path = Path::new(run_id);
    if run_id.is_empty() || path.is_absolute() {
        anyhow::bail!("run id `{run_id}` must be a non-empty path component");
    }
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(_)), None) => {}
        _ => anyhow::bail!("run id `{run_id}` may not contain path separators or traversal"),
    }
    RunId::try_new(run_id.to_owned()).map_err(|_| {
        anyhow::anyhow!("run id `{run_id}` may not contain path separators or traversal")
    })
}

fn read_resolved_config_value(run_root: &Path) -> anyhow::Result<toml::Value> {
    let path = run_root.join(RESOLVED_CONFIG_FILE_NAME);
    let config_toml = fs::read_to_string(&path)
        .map_err(|error| anyhow::anyhow!("failed to read {}: {error}", path.display()))?;
    toml::from_str(&config_toml)
        .map_err(|error| anyhow::anyhow!("failed to parse {}: {error}", path.display()))
}

fn read_json_file(path: &Path) -> anyhow::Result<serde_json::Value> {
    let contents = fs::read_to_string(path)
        .map_err(|error| anyhow::anyhow!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| anyhow::anyhow!("failed to parse {}: {error}", path.display()))
}

fn json_optional_str<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(serde_json::Value::as_str)
}

fn json_u64(value: &serde_json::Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default()
}

fn materialization_target_repo(cwd: &Path, config: &toml::Value) -> anyhow::Result<PathBuf> {
    let repo = toml_str(config, &["project", "repo"])
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    resolve_project_config_path(cwd, "project.repo", &repo)
}

fn toml_lookup<'a>(value: &'a toml::Value, path: &[&str]) -> Option<&'a toml::Value> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    Some(current)
}

fn toml_str(value: &toml::Value, path: &[&str]) -> Option<String> {
    toml_lookup(value, path)
        .and_then(toml::Value::as_str)
        .map(ToOwned::to_owned)
}

fn toml_bool(value: &toml::Value, path: &[&str]) -> Option<bool> {
    toml_lookup(value, path).and_then(toml::Value::as_bool)
}

fn resolve_run_artifact_path(run_root: &Path, relative_path: &Path) -> anyhow::Result<PathBuf> {
    validate_relative_path("run artifact path", relative_path)?;
    let mut components = relative_path.components();
    let Some(std::path::Component::Normal(first)) = components.next() else {
        anyhow::bail!("run artifact path `{}` is empty", relative_path.display());
    };
    if first != "artifacts" {
        anyhow::bail!(
            "run artifact path `{}` must be under artifacts/",
            relative_path.display()
        );
    }

    let path = run_root.join(relative_path);
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        anyhow::anyhow!(
            "selected artifact `{}` is not readable: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        anyhow::bail!(
            "selected artifact `{}` may not be a symlink",
            path.display()
        );
    }
    if !metadata.is_file() {
        anyhow::bail!("selected artifact `{}` is not a file", path.display());
    }

    let canonical_run = run_root.canonicalize()?;
    let canonical_path = path.canonicalize()?;
    if !canonical_path.starts_with(&canonical_run) {
        anyhow::bail!(
            "selected artifact `{}` resolves outside run directory {}",
            relative_path.display(),
            run_root.display()
        );
    }
    Ok(canonical_path)
}

fn resolve_repo_destination(
    repo: &Path,
    relative_path: &Path,
    force: bool,
) -> anyhow::Result<PathBuf> {
    validate_relative_path("repo destination path", relative_path)?;
    let mut components = relative_path.components();
    let Some(std::path::Component::Normal(first)) = components.next() else {
        anyhow::bail!(
            "repo destination path `{}` is empty",
            relative_path.display()
        );
    };
    if first == ".git" || first == ".ultrafuzz" {
        anyhow::bail!(
            "repo destination path `{}` may not target {}",
            relative_path.display(),
            first.to_string_lossy()
        );
    }

    let destination = repo.join(relative_path);
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() {
            anyhow::bail!(
                "repo destination `{}` may not be a symlink",
                destination.display()
            );
        }
        if metadata.is_dir() {
            anyhow::bail!(
                "repo destination `{}` is a directory",
                destination.display()
            );
        }
        if !force {
            anyhow::bail!(
                "repo destination `{}` already exists; pass --force to overwrite",
                destination.display()
            );
        }
    }

    let repo = repo.canonicalize()?;
    let existing_parent = deepest_existing_parent(&destination)?;
    let canonical_parent = existing_parent.canonicalize()?;
    if !canonical_parent.starts_with(&repo) {
        anyhow::bail!(
            "repo destination `{}` resolves outside {}",
            destination.display(),
            repo.display()
        );
    }
    Ok(destination)
}

fn validate_relative_path(label: &str, path: &Path) -> anyhow::Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        anyhow::bail!(
            "{label} `{}` must be non-empty and relative",
            path.display()
        );
    }
    for component in path.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            anyhow::bail!(
                "{label} `{}` may not contain traversal or root components",
                path.display()
            );
        }
    }
    Ok(())
}

fn deepest_existing_parent(path: &Path) -> anyhow::Result<PathBuf> {
    let mut parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("path `{}` has no parent", path.display()))?
        .to_path_buf();
    while !parent.exists() {
        if !parent.pop() {
            anyhow::bail!("path `{}` has no existing parent", path.display());
        }
    }
    Ok(parent)
}

#[derive(Debug)]
struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn ensure_git_worktree(repo: &Path) -> anyhow::Result<()> {
    let output = git_command(repo, &["rev-parse", "--is-inside-work-tree"])?;
    if output.success && output.stdout.trim() == "true" {
        Ok(())
    } else {
        anyhow::bail!(
            "materialization requires `{}` to be a git work tree",
            repo.display()
        )
    }
}

fn git_stdout(repo: &Path, args: &[&str]) -> anyhow::Result<String> {
    let output = git_command(repo, args)?;
    if output.success {
        Ok(output.stdout)
    } else {
        anyhow::bail!(
            "git {} failed in {}: {}",
            args.join(" "),
            repo.display(),
            output.stderr.trim()
        )
    }
}

fn git_command(repo: &Path, args: &[&str]) -> anyhow::Result<GitOutput> {
    let output = ProcessCommand::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()?;
    Ok(GitOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn git_apply(repo: &Path, patch: &Path) -> anyhow::Result<GitOutput> {
    let output = ProcessCommand::new("git")
        .arg("-C")
        .arg(repo)
        .arg("apply")
        .arg(patch)
        .output()?;
    Ok(GitOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn git_apply_reverse(repo: &Path, patch: &Path) -> anyhow::Result<GitOutput> {
    let output = ProcessCommand::new("git")
        .arg("-C")
        .arg(repo)
        .arg("apply")
        .arg("-R")
        .arg(patch)
        .output()?;
    Ok(GitOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn preflight_patch_sequence(
    target_repo: &Path,
    patch_plans: &[PatchMaterializationPlan],
) -> anyhow::Result<()> {
    if patch_plans.is_empty() {
        return Ok(());
    }

    let temp = tempfile::tempdir()?;
    let sandbox = temp.path().join("repo");
    copy_preflight_tree(target_repo, &sandbox)?;
    for plan in patch_plans {
        let apply = git_apply(&sandbox, &plan.source)?;
        if !apply.success {
            anyhow::bail!(
                "selected patches do not apply cleanly as a sequence; failed at `{}`: {}",
                plan.requested.display(),
                apply.stderr.trim()
            );
        }
    }
    Ok(())
}

fn rollback_applied_patches(repo: &Path, patches: &[PathBuf]) -> Vec<String> {
    let mut errors = Vec::new();
    for patch in patches.iter().rev() {
        match git_apply_reverse(repo, patch) {
            Ok(output) if output.success => {}
            Ok(output) => errors.push(format!("{}: {}", patch.display(), output.stderr.trim())),
            Err(error) => errors.push(format!("{}: {error}", patch.display())),
        }
    }
    errors
}

fn copy_preflight_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_name = entry.file_name();
        if file_name == OsStr::new(".git") || file_name == OsStr::new(".ultrafuzz") {
            continue;
        }

        let source_path = entry.path();
        let destination_path = destination.join(&file_name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_preflight_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source_path, &destination_path)?;
        } else if file_type.is_symlink() {
            copy_preflight_symlink(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_preflight_symlink(source_path: &Path, destination_path: &Path) -> anyhow::Result<()> {
    let target = fs::read_link(source_path)?;
    std::os::unix::fs::symlink(target, destination_path)?;
    Ok(())
}

#[cfg(not(unix))]
fn copy_preflight_symlink(source_path: &Path, destination_path: &Path) -> anyhow::Result<()> {
    let target = fs::read_link(source_path)?;
    let target_path = if target.is_absolute() {
        target
    } else {
        source_path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("symlink `{}` has no parent", source_path.display()))?
            .join(target)
    };
    if target_path.is_file() {
        fs::copy(target_path, destination_path)?;
        Ok(())
    } else {
        anyhow::bail!(
            "cannot copy symlink `{}` for materialization preflight on this platform",
            source_path.display()
        )
    }
}

fn latest_run_id(runs_dir: &Path) -> anyhow::Result<RunId> {
    let mut run_ids = fs::read_dir(runs_dir)
        .map_err(|error| {
            anyhow::anyhow!(
                "no ultrafuzz runs found in {}: {error}\n\nNext:\n  ultrafuzz run",
                runs_dir.display()
            )
        })?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            RunId::try_new(entry.file_name().to_string_lossy().into_owned()).ok()
        })
        .collect::<Vec<_>>();
    run_ids.sort();
    run_ids.pop().ok_or_else(|| {
        anyhow::anyhow!(
            "no ultrafuzz runs found in {}\n\nNext:\n  ultrafuzz run",
            runs_dir.display()
        )
    })
}

fn new_run_id() -> RunId {
    static RUN_ID_COUNTER: AtomicU64 = AtomicU64::new(0);
    let now = chrono::Utc::now();
    RunId::from(format!(
        "{}-{:03}-{}-{}",
        now.format("%Y-%m-%dT%H-%M-%SZ"),
        now.timestamp_subsec_millis(),
        std::process::id(),
        RUN_ID_COUNTER.fetch_add(1, Ordering::SeqCst)
    ))
}

fn run_status_label(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Pending => "pending",
        RunStatus::Running => "running",
        RunStatus::Succeeded => "succeeded",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
    }
}

fn restart_mode_label(mode: RestartMode) -> &'static str {
    match mode {
        RestartMode::Clean => "clean",
        RestartMode::ReuseCompletedArtifacts => "reuse-completed-artifacts",
    }
}

fn restart_action_label(mode: RestartMode) -> &'static str {
    match mode {
        RestartMode::Clean => "restart",
        RestartMode::ReuseCompletedArtifacts => "continuation",
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

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        ffi::OsString,
        sync::{Mutex, MutexGuard},
    };
    use ultrafuzz_references::{
        ReferenceCacheManifest, ReferenceManifestFile, CACHE_MANIFEST_FILE,
    };
    use ultrafuzz_topology::{
        default_project_topology, LoopMode, ProjectTopology, TopologyNode, TopologyNodeKind,
        TOPOLOGY_VERSION,
    };

    static CLI_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct CliTestGuard {
        _env: ClearedUltrafuzzEnv,
        _xdg_cache_home: SavedEnvVar,
        _path: PathEnvGuard,
        _toolchain_dir: tempfile::TempDir,
        _lock: MutexGuard<'static, ()>,
    }

    struct ScopedEnvVar {
        key: &'static str,
        saved: Option<OsString>,
    }

    struct SavedEnvVar {
        key: &'static str,
        saved: Option<OsString>,
    }

    struct PathEnvGuard {
        saved: Option<OsString>,
    }

    const FAKE_TOOLCHAIN_COMMANDS: &[&str] = &[
        "recon",
        "echidna",
        "covg-eval",
        "forge",
        "node",
        "npm",
        "npx",
        "timeout",
    ];

    fn cli_test_guard() -> CliTestGuard {
        let lock = CLI_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let toolchain_dir = tempfile::tempdir().unwrap();
        install_fake_toolchain_commands(toolchain_dir.path(), &[]);
        let path = PathEnvGuard::prepend(toolchain_dir.path());
        CliTestGuard {
            _env: ClearedUltrafuzzEnv::new(),
            _xdg_cache_home: SavedEnvVar::new("XDG_CACHE_HOME"),
            _path: path,
            _toolchain_dir: toolchain_dir,
            _lock: lock,
        }
    }

    fn scoped_env_var(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> ScopedEnvVar {
        let saved = std::env::var_os(key);
        std::env::set_var(key, value);
        ScopedEnvVar { key, saved }
    }

    impl Drop for ScopedEnvVar {
        fn drop(&mut self) {
            if let Some(value) = self.saved.take() {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    impl SavedEnvVar {
        fn new(key: &'static str) -> Self {
            Self {
                key,
                saved: std::env::var_os(key),
            }
        }
    }

    impl Drop for SavedEnvVar {
        fn drop(&mut self) {
            if let Some(value) = self.saved.take() {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    impl PathEnvGuard {
        fn set(path: &Path) -> Self {
            let saved = std::env::var_os("PATH");
            std::env::set_var("PATH", path);
            Self { saved }
        }

        fn prepend(path: &Path) -> Self {
            let saved = std::env::var_os("PATH");
            let mut paths = vec![path.to_path_buf()];
            if let Some(saved_path) = &saved {
                paths.extend(std::env::split_paths(saved_path));
            }
            let joined = std::env::join_paths(paths).unwrap();
            std::env::set_var("PATH", joined);
            Self { saved }
        }
    }

    impl Drop for PathEnvGuard {
        fn drop(&mut self) {
            if let Some(saved) = self.saved.take() {
                std::env::set_var("PATH", saved);
            } else {
                std::env::remove_var("PATH");
            }
        }
    }

    fn fake_toolchain_path(repo: &Path, omitted_commands: &[&str]) -> PathEnvGuard {
        let bin = repo.join("fake-toolchain-bin");
        install_fake_toolchain_commands(&bin, omitted_commands);
        PathEnvGuard::set(&bin)
    }

    fn install_fake_toolchain_commands(bin: &Path, omitted_commands: &[&str]) {
        fs::create_dir_all(bin).unwrap();
        for command in FAKE_TOOLCHAIN_COMMANDS {
            if omitted_commands.contains(command) {
                continue;
            }
            let path = bin.join(command);
            fs::write(&path, "").unwrap();
            make_executable(&path);
        }
    }

    fn write_single_invariant_coverage_prompt(repo: &Path, markdown: &str) {
        fs::write(
            repo.join(".ultrafuzz/topology.yml"),
            r#"version: 1
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: stateful-invariant-coverage
    prompt: strategies/invariants/coverage.md
    depends_on:
      - __start__
    required_artifacts:
      - coverage-report.md
      - findings.json
    primary_artifact: coverage-report.md
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - stateful-invariant-coverage
"#,
        )
        .unwrap();
        fs::write(
            repo.join(".ultrafuzz/prompts/strategies/invariants/coverage.md"),
            markdown,
        )
        .unwrap();
    }

    #[test]
    fn path_safety_runs_dir_for_cwd_rejects_env_escape() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        std::env::set_var("ULTRAFUZZ_OUTPUT_DIR", "../runs");

        let error = runs_dir_for_cwd(temp.path()).unwrap_err().to_string();

        assert!(error.contains("run.output_dir"));
        assert!(error.contains("may not contain `..`"));
    }

    #[test]
    fn path_safety_runs_dir_for_cwd_rejects_config_escape_and_accepts_relative() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join(ultrafuzz_config::CONFIG_FILE_NAME),
            "[run]\noutput_dir = \"../runs\"\n",
        )
        .unwrap();

        let error = runs_dir_for_cwd(temp.path()).unwrap_err().to_string();
        assert!(error.contains("run.output_dir"));
        assert!(error.contains("may not contain `..`"));

        fs::write(
            temp.path().join(ultrafuzz_config::CONFIG_FILE_NAME),
            "[run]\noutput_dir = \".ultrafuzz/runs\"\n",
        )
        .unwrap();
        let runs_dir = runs_dir_for_cwd(temp.path()).unwrap();
        assert_eq!(
            runs_dir,
            temp.path().canonicalize().unwrap().join(".ultrafuzz/runs")
        );
    }

    #[test]
    fn parses_required_phase_commands() {
        let _guard = cli_test_guard();
        for args in [
            vec!["ultrafuzz", "init"],
            vec!["ultrafuzz", "init", "--strategy-loops", "5"],
            vec![
                "ultrafuzz",
                "run",
                "--plain",
                "--no-color",
                "--quiet",
                "--verbose",
                "--backend",
                "codex-cli",
                "--max-parallel-agents",
                "4",
                "--strategy-loops",
                "1",
                "--dynamic-strategies-enumerator",
                "6",
                "--triage-quorum",
                "2",
                "--triage-panel-size",
                "4",
                "--invariant-property-priority-threshold",
                "medium",
                "--invariant-testing-fuzzer-timeout",
                "45min",
            ],
            vec![
                "ultrafuzz",
                "restart",
                "run-123",
                "--plain",
                "--no-color",
                "--quiet",
                "--verbose",
                "--dynamic-strategies-enumerator",
                "6",
                "--triage-quorum",
                "2",
                "--triage-panel-size",
                "4",
                "--invariant-property-priority-threshold",
                "low",
                "--invariant-testing-fuzzer-timeout",
                "1800s",
            ],
            vec![
                "ultrafuzz",
                "continue",
                "run-123",
                "--plain",
                "--no-color",
                "--quiet",
                "--verbose",
            ],
            vec!["ultrafuzz", "list"],
            vec!["ultrafuzz", "status", "run-123"],
            vec![
                "ultrafuzz",
                "status",
                "latest",
                "--json",
                "--plain",
                "--no-color",
            ],
            vec!["ultrafuzz", "doctor"],
            vec!["ultrafuzz", "doctor", "--json", "--plain", "--no-color"],
            vec!["ultrafuzz", "config"],
            vec!["ultrafuzz", "config", "defaults"],
            vec!["ultrafuzz", "dashboard", "run-123"],
            vec!["ultrafuzz", "dashboard", "latest"],
            vec!["ultrafuzz", "report", "run-123"],
            vec!["ultrafuzz", "report", "latest"],
            vec!["ultrafuzz", "report", "run-123", "--json"],
            vec!["ultrafuzz", "clean", "run-123", "--dry-run"],
            vec!["ultrafuzz", "triage", "run-123"],
            vec!["ultrafuzz", "merge", "run-123"],
            vec!["ultrafuzz", "materialize", "run-123"],
            vec![
                "ultrafuzz",
                "materialize",
                "run-123",
                "--patch",
                "artifacts/some-node/patch.diff",
                "--copy",
                "artifacts/final-report/generated.t.sol=test/Generated.t.sol",
                "--dry-run",
            ],
        ] {
            assert!(Cli::try_parse_from(args).is_ok());
        }
        assert!(Cli::try_parse_from(["ultrafuzz", "init", "--strategy-loops", "0"]).is_err());
        assert!(Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "0"]).is_err());
        assert!(
            Cli::try_parse_from(["ultrafuzz", "run", "--dynamic-strategies-enumerator", "0"])
                .is_err()
        );
        assert!(Cli::try_parse_from(["ultrafuzz", "run", "--triage-quorum", "0"]).is_err());
        assert!(Cli::try_parse_from(["ultrafuzz", "run", "--triage-panel-size", "0"]).is_err());
        assert!(Cli::try_parse_from([
            "ultrafuzz",
            "run",
            "--invariant-property-priority-threshold",
            "urgent"
        ])
        .is_err());
        assert!(Cli::try_parse_from([
            "ultrafuzz",
            "run",
            "--invariant-testing-fuzzer-timeout",
            "soon"
        ])
        .is_err());
    }

    #[test]
    fn rejects_removed_command_aliases() {
        let _guard = cli_test_guard();
        assert!(Cli::try_parse_from(["ultrafuzz", "ui", "run-123"]).is_err());
        assert!(Cli::try_parse_from(["ultrafuzz", "setup"]).is_err());
    }

    #[test]
    fn run_summary_surfaces_next_commands_and_artifacts() {
        let _guard = cli_test_guard();
        let summary = RunSummary {
            run_id: RunId::from("run-123"),
            status: RunStatus::Succeeded,
            run_dir: PathBuf::from(".ultrafuzz/runs/run-123"),
            graph_nodes: 7,
        };

        let verbose = format_run_summary(
            RunSummaryKind::Run,
            &summary,
            RunOutputArgs {
                plain: true,
                no_color: true,
                quiet: false,
                verbose: true,
            },
        );

        assert!(verbose.contains("Run complete."));
        assert!(verbose.contains("Run ID: run-123"));
        assert!(verbose.contains("Run directory: .ultrafuzz/runs/run-123"));
        assert!(verbose.contains("Next commands:"));
        assert!(verbose.contains("ultrafuzz status run-123"));
        assert!(verbose.contains("ultrafuzz continue run-123"));
        assert!(verbose.contains("ultrafuzz restart run-123"));
        assert!(verbose.contains("ultrafuzz dashboard run-123"));
        assert!(verbose.contains("ultrafuzz report run-123"));
        assert!(verbose.contains("Artifacts:"));
        assert!(verbose.contains("Event stores:"));
        assert!(!verbose.contains("ultrafuzz ui"));
        assert!(!verbose.contains("\u{1b}["));

        let quiet = format_run_summary(
            RunSummaryKind::Run,
            &summary,
            RunOutputArgs {
                quiet: true,
                ..RunOutputArgs::default()
            },
        );
        assert!(quiet.contains("run_id: run-123"));
        assert!(quiet.contains("status: succeeded"));
        assert!(!quiet.contains("Next commands:"));

        let failed = format_run_summary(
            RunSummaryKind::Run,
            &RunSummary {
                status: RunStatus::Failed,
                ..summary
            },
            RunOutputArgs::default(),
        );
        assert!(failed.contains("Run failed."));
        assert!(failed.contains("ultrafuzz dashboard run-123"));
        assert!(!failed.contains("ultrafuzz report run-123"));
    }

    #[test]
    fn init_scaffolds_config_prompts_topology_and_runs_dir() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(output.contains("ultrafuzz init complete"));
        assert!(output.contains("Next commands:"));
        assert!(output.contains("ultrafuzz doctor"));
        assert!(output.contains("ultrafuzz references sync"));
        assert!(output.contains("ultrafuzz run"));
        assert!(output.contains("ultrafuzz dashboard"));
        assert!(!output.contains("ultrafuzz dashboard latest"));
        assert!(output.contains("Artifacts:"));
        assert!(!output.contains("ultrafuzz ui"));
        assert!(temp.path().join("ultrafuzz.toml").exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/setup/prepare-foundry-harness.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/properties/property-specification-fanin.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/properties/josselin-feist-lens.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/properties/recon-lens.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/encode-decode.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/differential-library-tests.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/differential/differential-oracle-planner.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/expand-coverage.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/time-warp-sequences.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/boundary-tests.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/admin-config-boundaries.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/external-dependency-boundaries.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/amm-boundary-liquidity.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/payable-fallback-accounting.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/externalized-state-accounting.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/packed-action-parity.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/batch-atomicity-unsupported-actions.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/router-exact-accounting.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/rounding-direction-audit.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/market-exhaustion-boundaries.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/order-replacement-collateral.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/state-machine-boundaries.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/lifecycle-view-boundaries.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/invariants/setup.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/invariants/handlers.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/invariants/coverage.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/invariants/implement-properties.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/invariants/invariant-testing-campaign.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/review/triage.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/review/severity-classification.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/review/final-report.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/review/triage-findings.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/strategies/decode_encode.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/strategies/invariants.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/strategies/stateful-invariant-setup.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/strategies/stateful/setup.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/nodes/final-report.md")
            .exists());
        assert!(temp.path().join(".ultrafuzz/topology.yml").exists());
        assert!(temp.path().join(".ultrafuzz/references.yml").exists());
        assert!(temp.path().join(".ultrafuzz/runs").is_dir());
    }

    #[test]
    fn init_writes_graph_loadable_topology_with_existing_prompts() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let topology = load_project_topology(temp.path()).unwrap();
        assert_eq!(topology.version, TOPOLOGY_VERSION);
        assert_eq!(topology.nodes.len(), default_project_topology().nodes.len());
        for node in &topology.nodes {
            if node.kind == TopologyNodeKind::Meta {
                continue;
            }
            if node.kind == TopologyNodeKind::Reference {
                assert!(node.prompt.is_none());
                assert!(node.reference.is_some());
                continue;
            }
            let prompt_path = node
                .prompt
                .clone()
                .unwrap_or_else(|| ultrafuzz_topology::default_prompt_path_for_node(node));
            assert!(temp
                .path()
                .join(ultrafuzz_topology::PROJECT_PROMPT_DIR)
                .join(prompt_path)
                .is_file());
        }

        let registry = PromptRegistry::load_for_project(temp.path()).unwrap();
        let config = ultrafuzz_config::load_resolved_config(
            temp.path(),
            registry.strategy_definitions(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        let graph =
            build_campaign_graph_from_project(RunId::from("test-run"), temp.path(), &config)
                .unwrap();
        assert!(graph.node(&NodeId::from("project-discovery")).is_some());
        assert!(matches!(
            &graph
                .node(&NodeId::from("reference-properties-montyly-rounding"))
                .unwrap()
                .kind,
            NodeKind::Reference {
                reference,
                primary_artifact: Some(primary_artifact),
                ..
            } if reference == &ReferenceId::from("properties.montyly-rounding")
                && primary_artifact == Path::new("references/rounding.md")
        ));
        assert!(graph.node(&NodeId::from("encode-decode-0")).is_some());
        assert!(graph.node(&NodeId::from("encode-decode-1")).is_some());
        assert!(graph.node(&NodeId::from("encode-decode-2")).is_some());
        assert!(graph.node(&NodeId::from("encode-decode-3")).is_none());
        assert!(graph.node(&NodeId::from("expand-coverage-0")).is_some());
        assert!(graph.node(&NodeId::from("expand-coverage-1")).is_some());
        assert!(graph.node(&NodeId::from("expand-coverage-2")).is_some());
        assert!(graph.node(&NodeId::from("time-warp-sequences-0")).is_some());
        assert!(graph.node(&NodeId::from("time-warp-sequences-2")).is_some());
        assert!(graph.node(&NodeId::from("boundary-tests-0")).is_some());
        assert!(graph.node(&NodeId::from("boundary-tests-1")).is_some());
        assert!(graph.node(&NodeId::from("boundary-tests-2")).is_some());
        assert!(graph
            .node(&NodeId::from("admin-config-boundaries-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("admin-config-boundaries-1"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("admin-config-boundaries-2"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("external-dependency-boundaries-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("external-dependency-boundaries-1"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("external-dependency-boundaries-2"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("amm-boundary-liquidity-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("payable-fallback-accounting-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("externalized-state-accounting-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("packed-action-parity-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("batch-atomicity-unsupported-actions-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("router-exact-accounting-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("rounding-direction-audit-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("rounding-direction-audit-1"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("market-exhaustion-boundaries-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("order-replacement-collateral-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("state-machine-boundaries-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("lifecycle-view-boundaries-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-library-tests-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-library-tests-2"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-repair-and-report-review"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("stateful-invariant-coverage-2"))
            .is_some());
    }

    #[test]
    fn references_update_requires_latest_flag() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "references", "update"]).unwrap(),
            temp.path(),
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("requires `--latest`"));
        assert!(error.contains(".ultrafuzz/references.yml"));
    }

    #[test]
    fn references_status_reports_cache_miss() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        let _cache_env = scoped_env_var("XDG_CACHE_HOME", temp.path().join("cache"));
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "references", "status"]).unwrap(),
            temp.path(),
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("references status:"));
        assert!(error.contains("cached reference"));
        assert!(error.contains("run `ultrafuzz references sync`"));
    }

    #[test]
    fn run_fails_before_agents_when_reference_cache_is_missing() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        let _cache_env = scoped_env_var("XDG_CACHE_HOME", temp.path().join("cache"));
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend_without_reference_cache(temp.path(), false);

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run"]).unwrap(),
            temp.path(),
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("cached reference"));
        assert!(error.contains("run `ultrafuzz references sync`"));
        assert!(!temp
            .path()
            .join(".ultrafuzz/runs")
            .read_dir()
            .unwrap()
            .any(|entry| {
                entry
                    .map(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                    .unwrap_or(false)
            }));
    }

    #[test]
    fn init_accepts_strategy_loop_override() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();

        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init", "--strategy-loops", "5"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let topology_path = temp.path().join(".ultrafuzz/topology.yml");
        let topology = load_project_topology(temp.path()).unwrap();
        assert_eq!(topology.defaults.strategy_loops, 5);
        let topology_yaml = fs::read_to_string(topology_path).unwrap();
        assert!(topology_yaml.contains("defaults:\n  strategy_loops: 5"));
        let normal_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/encode-decode.md"),
        )
        .unwrap();
        assert!(!normal_prompt.contains("\nloops: 3\n"));
    }

    #[test]
    fn run_strategy_loop_override_persists_topology_default() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);

        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let topology = load_project_topology(temp.path()).unwrap();
        assert_eq!(topology.defaults.strategy_loops, 1);
        let run_id = parse_run_id(&output);
        let graph_json = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/runs")
                .join(&run_id)
                .join("graph.json"),
        )
        .unwrap();
        assert!(graph_json.contains("\"id\": \"encode-decode\""));
        assert!(!graph_json.contains("\"id\": \"encode-decode-0\""));
    }

    #[test]
    fn run_renders_resolved_triage_tunables_from_toml_and_cli() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);

        let config_path = temp.path().join("ultrafuzz.toml");
        let config = fs::read_to_string(&config_path)
            .unwrap()
            .replace("quorum = 3\npanel_size = 5", "quorum = 2\npanel_size = 4");
        fs::write(&config_path, config).unwrap();

        let toml_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let toml_run_id = parse_run_id(&toml_output);
        let toml_run_dir = temp.path().join(".ultrafuzz/runs").join(&toml_run_id);
        let toml_prompt =
            fs::read_to_string(toml_run_dir.join("artifacts/triage/prompt.rendered.md")).unwrap();
        assert!(toml_prompt.contains("Perform 4 independent investigation passes"));
        assert!(toml_prompt.contains("If at least 2 of 4 passes agree"));
        assert!(!toml_prompt.contains("{{triage_"));
        let toml_resolved =
            fs::read_to_string(toml_run_dir.join(RESOLVED_CONFIG_FILE_NAME)).unwrap();
        assert!(toml_resolved.contains("[triage]"));
        assert!(toml_resolved.contains("quorum = 2"));
        assert!(toml_resolved.contains("panel_size = 4"));

        let cli_output = execute_in(
            Cli::try_parse_from([
                "ultrafuzz",
                "run",
                "--strategy-loops",
                "1",
                "--triage-quorum",
                "6",
                "--triage-panel-size",
                "8",
            ])
            .unwrap(),
            temp.path(),
        )
        .unwrap();
        let cli_run_id = parse_run_id(&cli_output);
        let cli_run_dir = temp.path().join(".ultrafuzz/runs").join(&cli_run_id);
        let cli_prompt =
            fs::read_to_string(cli_run_dir.join("artifacts/triage/prompt.rendered.md")).unwrap();
        assert!(cli_prompt.contains("Perform 8 independent investigation passes"));
        assert!(cli_prompt.contains("If at least 6 of 8 passes agree"));
        assert!(!cli_prompt.contains("If at least 2 of 4 passes agree"));
        let cli_resolved = fs::read_to_string(cli_run_dir.join(RESOLVED_CONFIG_FILE_NAME)).unwrap();
        assert!(cli_resolved.contains("quorum = 6"));
        assert!(cli_resolved.contains("panel_size = 8"));
    }

    #[test]
    fn run_renders_dynamic_strategy_enumerator_from_toml_and_cli() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);

        let config_path = temp.path().join("ultrafuzz.toml");
        let config = fs::read_to_string(&config_path).unwrap().replace(
            "dynamic_strategies_enumerator = 3",
            "dynamic_strategies_enumerator = 2",
        );
        fs::write(&config_path, config).unwrap();

        let toml_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let toml_run_id = parse_run_id(&toml_output);
        let toml_run_dir = temp.path().join(".ultrafuzz/runs").join(&toml_run_id);
        let toml_prompt = fs::read_to_string(
            toml_run_dir.join("artifacts/dynamic-strategy-generator/prompt.rendered.md"),
        )
        .unwrap();
        assert!(toml_prompt.contains("Start up to 2 independent max-reasoning"));
        let toml_metadata: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(toml_run_dir.join("run.json")).unwrap())
                .unwrap();
        assert_eq!(toml_metadata["dynamic_strategies_enumerator"], 2);
        let dynamic = toml_metadata["strategies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|strategy| strategy["id"] == "dynamic-strategy-generator")
            .unwrap();
        assert_eq!(dynamic["display_name"], "Dynamic strategy generator");
        assert_eq!(dynamic["loops"], 1);
        assert_eq!(dynamic["timeout_seconds"], 14_400);
        assert_eq!(dynamic["expected_cost"], "high");
        assert!(dynamic["cost_note"]
            .as_str()
            .unwrap()
            .contains("enumerates up to 2 max-reasoning"));

        let cli_output = execute_in(
            Cli::try_parse_from([
                "ultrafuzz",
                "run",
                "--strategy-loops",
                "1",
                "--dynamic-strategies-enumerator",
                "4",
            ])
            .unwrap(),
            temp.path(),
        )
        .unwrap();
        let cli_run_id = parse_run_id(&cli_output);
        let cli_run_dir = temp.path().join(".ultrafuzz/runs").join(&cli_run_id);
        let cli_prompt = fs::read_to_string(
            cli_run_dir.join("artifacts/dynamic-strategy-generator/prompt.rendered.md"),
        )
        .unwrap();
        assert!(cli_prompt.contains("Start up to 4 independent max-reasoning"));
        let cli_metadata: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(cli_run_dir.join("run.json")).unwrap())
                .unwrap();
        assert_eq!(cli_metadata["dynamic_strategies_enumerator"], 4);
        let dynamic = cli_metadata["strategies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|strategy| strategy["id"] == "dynamic-strategy-generator")
            .unwrap();
        assert!(dynamic["cost_note"]
            .as_str()
            .unwrap()
            .contains("enumerates up to 4 max-reasoning"));
    }

    #[test]
    fn run_rejects_missing_dynamic_strategy_required_artifacts() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend_with_options(temp.path(), false, true);

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap_err();
        let output = error.to_string();
        assert!(output.contains("Status: failed"));
        assert!(!output.contains("ultrafuzz report"));
        let run_id = parse_run_id(&output);
        let state: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(
                temp.path()
                    .join(".ultrafuzz/runs")
                    .join(run_id)
                    .join("state.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let message = state["nodes"]["dynamic-strategy-generator"]["last_error"]
            .as_str()
            .unwrap();
        assert!(message.contains("dynamic-strategy-generator"));
        assert!(message.contains("did not produce required artifact"));
        assert!(message.contains("strategy-plan.json"));
    }

    #[test]
    fn run_requires_project_topology_before_creating_run_artifacts() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        fs::remove_file(temp.path().join(".ultrafuzz/topology.yml")).unwrap();
        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run"]).unwrap(),
            temp.path(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("missing topology file"));
        assert_eq!(
            fs::read_dir(temp.path().join(".ultrafuzz/runs"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn init_does_not_overwrite_without_force() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let config_path = temp.path().join("ultrafuzz.toml");
        let topology_path = temp.path().join(".ultrafuzz/topology.yml");
        std::fs::write(&config_path, "custom = true\n").unwrap();
        std::fs::write(&topology_path, "custom topology\n").unwrap();

        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(output.contains("config: skipped"));
        assert_eq!(
            std::fs::read_to_string(config_path).unwrap(),
            "custom = true\n"
        );
        assert_eq!(
            std::fs::read_to_string(topology_path).unwrap(),
            "custom topology\n"
        );
    }

    #[test]
    fn init_force_overwrites_scaffolded_topology() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let topology_path = temp.path().join(".ultrafuzz/topology.yml");
        std::fs::write(&topology_path, "custom topology\n").unwrap();

        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init", "--force"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let topology = load_project_topology(temp.path()).unwrap();
        assert_eq!(topology.version, TOPOLOGY_VERSION);
        assert_ne!(
            std::fs::read_to_string(topology_path).unwrap(),
            "custom topology\n"
        );
    }

    #[test]
    fn dashboard_config_auto_writes_default_config_when_missing() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();

        let config = dashboard_server_config(
            temp.path(),
            DashboardArgs {
                run_id: None,
                host: None,
                port: None,
            },
        )
        .unwrap();

        assert!(temp.path().join("ultrafuzz.toml").exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/encode-decode.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/strategies/decode_encode.md")
            .exists());
        assert!(temp.path().join(".ultrafuzz/runs").is_dir());
        assert_eq!(config.project_root, temp.path());
        assert_eq!(config.runs_dir, temp.path().join(".ultrafuzz/runs"));
    }

    #[test]
    fn config_inspect_loads_scaffolded_prompt_metadata() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let strategy_path = temp
            .path()
            .join(".ultrafuzz/prompts/strategies/storage-layout.md");
        std::fs::write(
            strategy_path,
            "---\nid: storage-layout\nloops: 3\n---\n# Storage Layout\n",
        )
        .unwrap();

        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "config", "inspect"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(output.contains("[strategies.storage-layout]"));
        assert!(output.contains("[strategies.boundary-tests]"));
        assert!(output.contains("[strategies.admin-config-boundaries]"));
        assert!(output.contains("[strategies.dynamic-strategy-generator]"));
        assert!(output.contains("[strategies.external-dependency-boundaries]"));
        assert!(output.contains("[strategies.externalized-state-accounting]"));
        assert!(output.contains("[strategies.amm-boundary-liquidity]"));
        assert!(output.contains("[strategies.packed-action-parity]"));
        assert!(output.contains("[strategies.time-warp-sequences]"));
        assert!(output.contains("[strategies.stateful-invariant-setup]"));
        assert!(output.contains("[strategies.stateful-invariant-handlers]"));
        assert!(output.contains("[strategies.stateful-invariant-coverage]"));
        assert!(output.contains("[strategies.stateful-invariant-implement-properties]"));
        assert!(output.contains("[strategies.stateful-invariant-recon-campaign]"));
        assert!(output.contains("[invariants]"));
        assert!(output.contains("dynamic_strategies_enumerator = 3"));
        assert!(output.contains("property_priority_threshold = \"high\""));
        assert!(output.contains("invariant_testing_fuzzer_timeout = \"1h\""));
        assert!(!output.contains("[strategies.stateful-invariants]"));
        assert!(output.contains("loops = 3"));
    }

    #[test]
    fn run_writes_graph_state_and_event_stores() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);

        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--max-parallel-agents", "2"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(output.contains("Run complete."));
        assert!(output.contains("Status: succeeded"));
        assert!(output.contains("Next commands:"));
        assert!(output.contains("Artifacts:"));
        let run_id = parse_run_id(&output);
        assert!(output.contains(&format!("ultrafuzz status {run_id}")));
        assert!(output.contains(&format!("ultrafuzz dashboard {run_id}")));
        assert!(output.contains(&format!("ultrafuzz report {run_id}")));
        let run_dir = temp.path().join(".ultrafuzz/runs").join(&run_id);
        assert!(run_dir.join("graph.json").exists());
        assert!(run_dir.join("graph.fingerprint").exists());
        assert!(run_dir.join("state.json").exists());
        assert!(run_dir.join("events.jsonl").exists());
        assert!(run_dir.join("events.sqlite").exists());
        assert!(run_dir
            .join("artifacts/encode-decode-0/artifact-manifest.json")
            .exists());
        assert!(run_dir
            .join("artifacts/final-report/artifact-index.json")
            .exists());
        let run_metadata: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(run_dir.join("run.json")).unwrap()).unwrap();
        assert_eq!(run_metadata["default_timeout_seconds"], 1800);
        let time_warp_strategy = run_metadata["strategies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|strategy| strategy["id"] == "time-warp-sequences")
            .unwrap();
        assert_eq!(time_warp_strategy["timeout_seconds"], 3600);
        let boundary_timeout = run_metadata["node_timeouts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "boundary-tests-0")
            .unwrap();
        assert_eq!(boundary_timeout["timeout_seconds"], 1800);
        let final_report_timeout = run_metadata["node_timeouts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "final-report")
            .unwrap();
        assert_eq!(final_report_timeout["timeout_seconds"], 3600);
        let report_json: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(run_dir.join("artifacts/final-report/report.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(report_json["materialization"]["performed"], false);
        assert_eq!(report_json["materialization"]["mode"], "none");
    }

    #[test]
    fn run_returns_error_when_campaign_finishes_failed() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_missing_artifact_backend(temp.path());

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--max-parallel-agents", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap_err();
        let message = error.to_string();

        assert!(message.contains("Run failed."));
        assert!(message.contains("Status: failed"));
    }

    #[test]
    fn status_reports_run_health_and_restart_reuse() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let _path_guard = fake_toolchain_path(temp.path(), &[]);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let run_id = parse_run_id(&run_output);

        let status = execute_in(
            Cli::try_parse_from(["ultrafuzz", "status", &run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(status.contains(&format!("Run ID: {run_id}")));
        assert!(status.contains("Status: succeeded"));
        assert!(status.contains("succeeded="));
        assert!(status.contains("Backend/model profiles:"));
        assert!(status.contains("Health:"));
        assert!(status.contains("process: not-running"));
        assert!(status.contains("required artifacts:"));
        assert!(status.contains("Restart and lineage:"));
        assert!(status.contains("restart reuse:"));
        assert!(status.contains("tokens:"));
        assert!(status.contains("spend:"));
        assert!(status.contains("Next action:"));
        assert!(status.contains(&format!("ultrafuzz dashboard {run_id}")));
        assert!(!status.contains("ultrafuzz ui"));

        let latest = execute_in(
            Cli::try_parse_from(["ultrafuzz", "status", "latest"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        assert!(latest.contains(&format!("Run ID: {run_id}")));

        let json_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "status", "latest", "--json"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(&json_output).unwrap();
        assert_eq!(json["run_id"], json!(run_id.clone()));
        assert_eq!(json["status"], "succeeded");
        assert!(json["node_counts"].is_object());
        assert!(json["backend_model_profiles"].is_array());
        assert_eq!(json["health"]["status"], "succeeded");
        assert!(json["next_commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|command| command == &json!(format!("ultrafuzz dashboard {run_id}"))));
    }

    #[test]
    fn result_review_commands_read_existing_run_artifacts() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let run_id = parse_run_id(&run_output);

        let list = execute_in(
            Cli::try_parse_from(["ultrafuzz", "list"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        assert!(list.contains(&run_id));
        assert!(list.contains("succeeded"));

        let report = execute_in(
            Cli::try_parse_from(["ultrafuzz", "report", &run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        assert!(report.contains("# Ultrafuzz report"));

        let report_json = execute_in(
            Cli::try_parse_from(["ultrafuzz", "report", &run_id, "--json"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        assert!(report_json.contains("\"schema_version\""));

        let latest_report = execute_in(
            Cli::try_parse_from(["ultrafuzz", "report", "latest"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        assert!(latest_report.contains("# Ultrafuzz report"));

        let dashboard_config = dashboard_server_config(
            temp.path(),
            DashboardArgs {
                run_id: Some("latest".to_owned()),
                host: None,
                port: None,
            },
        )
        .unwrap();
        assert_eq!(dashboard_config.run_id, Some(RunId::from(run_id.clone())));

        let triage = execute_in(
            Cli::try_parse_from(["ultrafuzz", "triage", &run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        assert!(triage.contains("ultrafuzz triage summary"));

        let merge = execute_in(
            Cli::try_parse_from(["ultrafuzz", "merge", &run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        assert!(merge.contains("ultrafuzz test aggregation summary"));

        let dry_run = execute_in(
            Cli::try_parse_from(["ultrafuzz", "clean", &run_id, "--dry-run"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        assert!(dry_run.contains("mode: dry-run"));

        let clean = execute_in(
            Cli::try_parse_from(["ultrafuzz", "clean", &run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        assert!(clean.contains("mode: removed"));
        assert!(!temp.path().join(".ultrafuzz/runs").join(&run_id).exists());
    }

    #[test]
    fn triage_command_summarizes_triaged_findings_without_summary_artifact() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        let run_id = "run-123";
        let triage_dir = temp
            .path()
            .join(".ultrafuzz/runs")
            .join(run_id)
            .join("artifacts/triage");
        fs::create_dir_all(&triage_dir).unwrap();
        fs::write(
            triage_dir.join("triaged-findings.json"),
            serde_json::to_string_pretty(&json!([
                {
                    "id": "UF-0001",
                    "status": "needs-review",
                    "triage_classification": "true-positive"
                },
                {
                    "id": "UF-0002",
                    "status": "false-positive",
                    "triage_classification": "false-positive"
                },
                {
                    "id": "UF-0003",
                    "status": "needs-review",
                    "triage_classification": "undetermined"
                }
            ]))
            .unwrap(),
        )
        .unwrap();

        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "triage", run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(output.contains("findings: 3"));
        assert!(output.contains("statuses: false-positive=1, needs-review=2"));
        assert!(output.contains("artifacts/triage/triaged-findings.json"));
    }

    #[test]
    fn run_id_arguments_reject_path_traversal() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "status", "../outside"]).unwrap(),
            temp.path(),
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("may not contain path separators or traversal"));

        let error = parse_run_id_component("bad..run").unwrap_err();
        assert!(error
            .to_string()
            .contains("may not contain path separators or traversal"));
    }

    #[test]
    fn latest_run_id_ignores_unsafe_run_directories() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("run-1")).unwrap();
        fs::create_dir_all(temp.path().join("zz..escape")).unwrap();

        let run_id = latest_run_id(temp.path()).unwrap();

        assert_eq!(run_id, RunId::from("run-1"));
    }

    #[test]
    fn restart_creates_clean_replay_from_prior_state() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        fs::remove_file(temp.path().join(".ultrafuzz/topology.yml")).unwrap();

        let restart_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "restart", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let new_run_id = parse_run_id(&restart_output);

        assert_ne!(old_run_id, new_run_id);
        assert!(temp
            .path()
            .join(".ultrafuzz/runs")
            .join(&old_run_id)
            .join("state.json")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/runs")
            .join(&new_run_id)
            .join("state.json")
            .exists());
        let old_fingerprint = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/runs")
                .join(&old_run_id)
                .join("graph.fingerprint"),
        )
        .unwrap();
        let new_fingerprint = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/runs")
                .join(&new_run_id)
                .join("graph.fingerprint"),
        )
        .unwrap();
        assert_eq!(old_fingerprint, new_fingerprint);
        let new_run_root = temp.path().join(".ultrafuzz/runs").join(&new_run_id);
        let new_state = RunStateStore::for_run_root(&new_run_root).load().unwrap();
        assert_eq!(
            new_state.source_run_id,
            Some(RunId::from(old_run_id.as_str()))
        );
        assert_eq!(
            new_state.nodes[&NodeId::from(ultrafuzz_topology::START_NODE_ID)].status,
            NodeStatus::Succeeded
        );
        assert_eq!(
            new_state.nodes[&NodeId::from("project-discovery")].status,
            NodeStatus::Succeeded
        );
        assert!(new_state
            .nodes
            .values()
            .all(|node| node.status != NodeStatus::ReusedFromPriorRun));
        let metadata = read_json_file(&new_run_root.join(RUN_METADATA_FILE_NAME)).unwrap();
        assert_eq!(metadata["restart_mode"], "clean");
        assert_eq!(metadata["reused_nodes"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn restart_accepts_legacy_absolute_project_repo_in_resolved_config() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let old_run_root = temp.path().join(".ultrafuzz/runs").join(&old_run_id);
        let source_config_path = old_run_root.join(RESOLVED_CONFIG_FILE_NAME);
        let mut source_config =
            toml::from_str::<toml::Value>(&fs::read_to_string(&source_config_path).unwrap())
                .unwrap();
        source_config
            .get_mut("project")
            .unwrap()
            .as_table_mut()
            .unwrap()
            .insert(
                "repo".to_owned(),
                toml::Value::String(temp.path().join(".").display().to_string()),
            );
        fs::write(
            &source_config_path,
            toml::to_string_pretty(&source_config).unwrap(),
        )
        .unwrap();

        let restart_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "restart", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let new_run_id = parse_run_id(&restart_output);
        let new_config = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/runs")
                .join(new_run_id.as_str())
                .join(RESOLVED_CONFIG_FILE_NAME),
        )
        .unwrap();

        assert!(new_config.contains("repo = \".\""));
    }

    #[test]
    fn continue_accepts_legacy_absolute_output_dir_fingerprint_after_normalization() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let old_run_root = temp.path().join(".ultrafuzz/runs").join(&old_run_id);
        let source_config_path = old_run_root.join(RESOLVED_CONFIG_FILE_NAME);
        let mut source_config =
            toml::from_str::<toml::Value>(&fs::read_to_string(&source_config_path).unwrap())
                .unwrap();
        source_config
            .get_mut("run")
            .unwrap()
            .as_table_mut()
            .unwrap()
            .insert(
                "output_dir".to_owned(),
                toml::Value::String(temp.path().join(".ultrafuzz/runs").display().to_string()),
            );
        let legacy_config_toml = toml::to_string_pretty(&source_config).unwrap();
        fs::write(&source_config_path, &legacy_config_toml).unwrap();
        let store = RunStateStore::for_run_root(&old_run_root);
        let mut state = store.load().unwrap();
        state.config_fingerprint = "legacy-absolute-output-dir-fingerprint".to_owned();
        store.save(&state).unwrap();

        let continue_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "continue", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let new_run_id = parse_run_id(&continue_output);
        let new_run_root = temp.path().join(".ultrafuzz/runs").join(&new_run_id);
        let new_state = RunStateStore::for_run_root(&new_run_root).load().unwrap();

        assert_eq!(
            new_state.source_run_id,
            Some(RunId::from(old_run_id.as_str()))
        );
        assert!(new_state
            .nodes
            .values()
            .any(|node| node.status == NodeStatus::ReusedFromPriorRun));
    }

    #[test]
    fn continue_restores_redacted_env_values_from_project_config() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        add_restart_env_fixture(temp.path());

        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let old_run_root = temp.path().join(".ultrafuzz/runs").join(&old_run_id);
        let resolved_config =
            fs::read_to_string(old_run_root.join(RESOLVED_CONFIG_FILE_NAME)).unwrap();
        assert!(resolved_config.contains("CUSTOM_AUTH = \"<redacted>\""));
        assert!(resolved_config.contains("OPENAI_BASE_URL = \"<redacted>\""));
        assert!(resolved_config.contains("MODEL_SESSION = \"<redacted>\""));
        assert!(!resolved_config.contains("runtime-secret"));
        assert!(!resolved_config.contains("https://provider.example/v1"));
        assert!(!resolved_config.contains("model-runtime-secret"));

        let continue_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "continue", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let new_run_id = parse_run_id(&continue_output);
        let new_run_root = temp.path().join(".ultrafuzz/runs").join(&new_run_id);
        let new_state = RunStateStore::for_run_root(&new_run_root).load().unwrap();

        assert_eq!(
            new_state.source_run_id,
            Some(RunId::from(old_run_id.as_str()))
        );
        assert!(new_state
            .nodes
            .values()
            .any(|node| node.status == NodeStatus::ReusedFromPriorRun));
    }

    #[test]
    fn restart_rejects_redacted_env_values_missing_from_project_config() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        add_restart_env_fixture(temp.path());

        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        remove_restart_env_fixture(temp.path());

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "restart", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap_err();

        assert!(error.to_string().contains(
            "restart source config contains redacted env value `backend.codex_cli.env.CUSTOM_AUTH`"
        ));
    }

    #[test]
    fn continue_reuses_unaffected_successes_and_reruns_failed_descendants() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let old_run_root = temp.path().join(".ultrafuzz/runs").join(&old_run_id);
        mark_source_node_failed(&old_run_root, "boundary-tests");

        let continue_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "continue", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let new_run_id = parse_run_id(&continue_output);
        let new_run_root = temp.path().join(".ultrafuzz/runs").join(&new_run_id);
        let new_state = RunStateStore::for_run_root(&new_run_root).load().unwrap();
        assert_eq!(
            new_state.nodes[&NodeId::from("project-discovery")].status,
            NodeStatus::ReusedFromPriorRun
        );
        assert_eq!(
            new_state.nodes[&NodeId::from("boundary-tests")].status,
            NodeStatus::Succeeded
        );
        assert_eq!(
            new_state.nodes[&NodeId::from("dedupe-findings")].status,
            NodeStatus::Succeeded
        );
        let old_project_discovery =
            old_run_root.join("artifacts/project-discovery/setup/project-discovery.md");
        let new_project_discovery =
            new_run_root.join("artifacts/project-discovery/setup/project-discovery.md");
        assert_eq!(
            fs::read_to_string(old_project_discovery).unwrap(),
            fs::read_to_string(&new_project_discovery).unwrap()
        );
        let metadata = read_json_file(&new_run_root.join(RUN_METADATA_FILE_NAME)).unwrap();
        assert_eq!(metadata["restart_mode"], "reuse-completed-artifacts");
        assert!(metadata["reused_nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node == "project-discovery"));
        let events = fs::read_to_string(new_run_root.join("events.jsonl")).unwrap();
        assert!(events.contains("\"event_type\":\"node-reused\""));
    }

    #[test]
    fn continue_allows_parallelism_override_before_reuse() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let old_run_root = temp.path().join(".ultrafuzz/runs").join(&old_run_id);
        mark_source_node_failed(&old_run_root, "boundary-tests");

        let continue_output = execute_in(
            Cli::try_parse_from([
                "ultrafuzz",
                "continue",
                &old_run_id,
                "--max-parallel-agents",
                "2",
                "--max-parallel-nodes",
                "2",
            ])
            .unwrap(),
            temp.path(),
        )
        .unwrap();
        let new_run_id = parse_run_id(&continue_output);
        let new_run_root = temp.path().join(".ultrafuzz/runs").join(&new_run_id);
        let new_state = RunStateStore::for_run_root(&new_run_root).load().unwrap();
        assert_eq!(
            new_state.nodes[&NodeId::from("project-discovery")].status,
            NodeStatus::ReusedFromPriorRun
        );
        let resolved_config =
            fs::read_to_string(new_run_root.join(RESOLVED_CONFIG_FILE_NAME)).unwrap();
        assert!(resolved_config.contains("max_parallel_agents = 2"));
        assert!(resolved_config.contains("max_parallel_nodes = 2"));
    }

    #[test]
    fn continue_reuses_reference_artifacts_after_cache_eviction() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let old_run_root = temp.path().join(".ultrafuzz/runs").join(&old_run_id);
        mark_source_node_failed(&old_run_root, "boundary-tests");
        fs::remove_dir_all(temp.path().join(".ultrafuzz/test-cache")).unwrap();

        let continue_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "continue", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let new_run_id = parse_run_id(&continue_output);
        let new_run_root = temp.path().join(".ultrafuzz/runs").join(&new_run_id);
        let new_state = RunStateStore::for_run_root(&new_run_root).load().unwrap();
        assert_eq!(
            new_state.nodes[&NodeId::from("reference-properties-montyly-rounding")].status,
            NodeStatus::ReusedFromPriorRun
        );
        assert!(new_run_root
            .join("artifacts/reference-properties-montyly-rounding/references/rounding.md")
            .is_file());
        assert!(new_run_root
            .join("artifacts/reference-properties-montyly-rounding/references/manifest.json")
            .is_file());
    }

    #[test]
    fn continue_rejects_config_mismatch_before_reuse() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let old_run_root = temp.path().join(".ultrafuzz/runs").join(&old_run_id);
        let store = RunStateStore::for_run_root(&old_run_root);
        let mut state = store.load().unwrap();
        state.config_fingerprint = "stale-config".to_owned();
        store.save(&state).unwrap();

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "continue", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("continuation config fingerprint mismatch"));
    }

    #[test]
    fn continue_rejects_topology_mismatch_before_reuse() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        ultrafuzz_topology::set_project_strategy_loops(temp.path(), 2).unwrap();

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "continue", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("continuation graph/topology compatibility check failed"));
    }

    #[test]
    fn continue_rejects_prompt_mismatch_before_reuse() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let prompt_path = temp
            .path()
            .join(".ultrafuzz/prompts/setup/project-discovery.md");
        fs::write(
            &prompt_path,
            format!(
                "{}\n\nprompt changed\n",
                fs::read_to_string(&prompt_path).unwrap()
            ),
        )
        .unwrap();

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "continue", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("continuation prompt fingerprint mismatch"));
    }

    #[test]
    fn continue_rejects_missing_required_reusable_artifact() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let old_run_root = temp.path().join(".ultrafuzz/runs").join(&old_run_id);
        fs::remove_file(
            old_run_root.join("artifacts/project-discovery/setup/project-discovery.md"),
        )
        .unwrap();

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "continue", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("continuation reusable node `project-discovery` is missing required artifact `setup/project-discovery.md`"));
    }

    #[test]
    fn restart_reuses_timed_out_node_with_complete_required_artifacts() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let old_run_root = temp.path().join(".ultrafuzz/runs").join(&old_run_id);
        let old_store = RunStateStore::for_run_root(&old_run_root);
        let mut old_state = old_store.load().unwrap();
        let dedupe_id = NodeId::from("dedupe-findings");
        let dedupe_state = old_state.nodes.get_mut(&dedupe_id).unwrap();
        dedupe_state.status = NodeStatus::TimedOut;
        dedupe_state.timed_out = true;
        dedupe_state.last_error = Some("node `dedupe-findings` exceeded timeout".to_owned());
        old_state.status = RunStatus::Failed;
        old_store.save(&old_state).unwrap();

        let restart_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "restart", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let new_run_id = parse_run_id(&restart_output);
        let new_run_root = temp.path().join(".ultrafuzz/runs").join(&new_run_id);
        let new_state = RunStateStore::for_run_root(&new_run_root).load().unwrap();

        assert_eq!(
            new_state.nodes[&dedupe_id].status,
            NodeStatus::ReusedFromPriorRun
        );
        assert!(!new_state.nodes[&dedupe_id].timed_out);
        assert!(new_run_root
            .join("artifacts/dedupe-findings/deduped-findings.json")
            .exists());
        assert!(new_run_root
            .join("artifacts/dedupe-findings/strategy-detections.json")
            .exists());
        assert!(new_run_root
            .join("artifacts/dedupe-findings/findings.json")
            .exists());
        assert!(new_run_root
            .join("artifacts/dedupe-findings/artifact-manifest.json")
            .exists());
    }

    #[test]
    fn restart_reuses_running_node_with_complete_required_artifacts() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);
        let old_run_root = temp.path().join(".ultrafuzz/runs").join(&old_run_id);
        let old_store = RunStateStore::for_run_root(&old_run_root);
        let mut old_state = old_store.load().unwrap();
        let dedupe_id = NodeId::from("dedupe-findings");
        let dedupe_state = old_state.nodes.get_mut(&dedupe_id).unwrap();
        dedupe_state.status = NodeStatus::Running;
        dedupe_state.timed_out = false;
        dedupe_state.last_error = None;
        old_state.status = RunStatus::Running;
        old_state.finished_at = None;
        old_store.save(&old_state).unwrap();

        let restart_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "restart", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let new_run_id = parse_run_id(&restart_output);
        let new_run_root = temp.path().join(".ultrafuzz/runs").join(&new_run_id);
        let new_state = RunStateStore::for_run_root(&new_run_root).load().unwrap();

        assert_eq!(
            new_state.nodes[&dedupe_id].status,
            NodeStatus::ReusedFromPriorRun
        );
        assert!(!new_state.nodes[&dedupe_id].timed_out);
        assert!(new_run_root
            .join("artifacts/dedupe-findings/deduped-findings.json")
            .exists());
        assert!(new_run_root
            .join("artifacts/dedupe-findings/strategy-detections.json")
            .exists());
        assert!(new_run_root
            .join("artifacts/dedupe-findings/findings.json")
            .exists());
        assert!(new_run_root
            .join("artifacts/dedupe-findings/artifact-manifest.json")
            .exists());
    }

    #[test]
    fn restart_accepts_complete_required_artifact_without_findings_file() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_dir = temp.path().join("artifacts/aggregate-test-files");
        fs::create_dir_all(&artifact_dir).unwrap();
        fs::write(
            artifact_dir.join("aggregation.json"),
            serde_json::to_vec_pretty(&json!({
                "schema_version": "1.0",
                "files": []
            }))
            .unwrap(),
        )
        .unwrap();
        let node = ultrafuzz_topology::Node {
            id: NodeId::from("aggregate-test-files"),
            label: "Aggregate test files".to_owned(),
            kind: ultrafuzz_topology::NodeKind::Agentic {
                logical_id: NodeId::from("aggregate-test-files"),
                prompt_path: PathBuf::from("review/aggregate-test-files.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: Some("review".to_owned()),
                required_artifacts: vec![PathBuf::from("aggregation.json")],
                primary_artifact: Some(PathBuf::from("aggregation.json")),
            },
            depends_on: vec![NodeId::from("severity-classification")],
            timeout: None,
            retry: ultrafuzz_topology::RetryPolicy::default(),
            artifact_dir: PathBuf::from("aggregate-test-files"),
        };

        assert!(restart_interrupted_node_has_complete_artifacts(temp.path(), &node).unwrap());
    }

    #[test]
    fn restart_uses_current_project_execution_config() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let old_run_id = parse_run_id(&run_output);

        let config_path = temp.path().join(ultrafuzz_config::CONFIG_FILE_NAME);
        let config = fs::read_to_string(&config_path).unwrap();
        assert!(!config.contains("\"restart-only-tool\""));
        fs::write(
            &config_path,
            config.replace("  \"rm\",\n]", "  \"rm\",\n  \"restart-only-tool\",\n]"),
        )
        .unwrap();

        let restart_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "restart", &old_run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let new_run_id = parse_run_id(&restart_output);
        let restarted_config = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/runs")
                .join(&new_run_id)
                .join("config.resolved.toml"),
        )
        .unwrap();

        assert!(restarted_config.contains("\"restart-only-tool\""));
    }

    #[test]
    fn restart_rebinds_invariant_testing_fuzzer_timeout_in_reused_graph() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let registry = PromptRegistry::load_for_project(temp.path()).unwrap();
        let default_config = ultrafuzz_config::load_resolved_config(
            temp.path(),
            registry.strategy_definitions(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        let source_graph = build_campaign_graph_from_project(
            RunId::from("source-run"),
            temp.path(),
            &default_config,
        )
        .unwrap();
        assert_eq!(
            source_graph
                .node(&NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID))
                .unwrap()
                .timeout,
            Some(std::time::Duration::from_secs(60 * 60))
        );

        let source_run_root = temp.path().join("source-run");
        fs::create_dir_all(&source_run_root).unwrap();
        fs::write(
            source_run_root.join("graph.json"),
            source_graph.to_json_pretty().unwrap(),
        )
        .unwrap();
        let source_config = default_config.clone();
        let mut restart_config = default_config.clone();
        restart_config
            .invariants
            .invariant_testing_fuzzer_timeout_seconds = 45 * 60;
        let plan = RestartPlan {
            mode: RestartMode::Clean,
            source_run_id: RunId::from("source-run"),
            new_run_id: RunId::from("new-run"),
            source_run_root,
            resolved_config_toml: String::new(),
            graph_fingerprint: source_graph.fingerprint().unwrap(),
            config_fingerprint: String::new(),
            reusable_nodes: Vec::new(),
        };

        let restarted = graph_for_run(
            RunId::from("new-run"),
            temp.path(),
            &restart_config,
            Some(&plan),
            Some(&source_config),
        )
        .unwrap();

        assert_eq!(restarted.run_id, RunId::from("new-run"));
        assert_eq!(
            restarted
                .node(&NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID))
                .unwrap()
                .timeout,
            Some(std::time::Duration::from_secs(45 * 60))
        );

        let explicit_source_run_root = temp.path().join("explicit-source-run");
        fs::create_dir_all(&explicit_source_run_root).unwrap();
        let mut explicit_source_graph = source_graph.clone();
        explicit_source_graph
            .nodes
            .iter_mut()
            .find(|node| node.id.as_str() == STATEFUL_INVARIANT_RECON_CAMPAIGN_ID)
            .unwrap()
            .timeout = Some(std::time::Duration::from_secs(120));
        fs::write(
            explicit_source_run_root.join("graph.json"),
            explicit_source_graph.to_json_pretty().unwrap(),
        )
        .unwrap();
        let explicit_plan = RestartPlan {
            mode: RestartMode::Clean,
            source_run_id: RunId::from("explicit-source-run"),
            new_run_id: RunId::from("explicit-new-run"),
            source_run_root: explicit_source_run_root,
            resolved_config_toml: String::new(),
            graph_fingerprint: explicit_source_graph.fingerprint().unwrap(),
            config_fingerprint: String::new(),
            reusable_nodes: Vec::new(),
        };

        let explicit_restarted = graph_for_run(
            RunId::from("explicit-new-run"),
            temp.path(),
            &restart_config,
            Some(&explicit_plan),
            Some(&source_config),
        )
        .unwrap();
        assert_eq!(
            explicit_restarted
                .node(&NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID))
                .unwrap()
                .timeout,
            Some(std::time::Duration::from_secs(120))
        );
    }

    #[test]
    fn doctor_reports_missing_selected_backend() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let config_path = temp.path().join("ultrafuzz.toml");
        let toml = fs::read_to_string(&config_path)
            .unwrap()
            .replace(
                "command = \"claude\"",
                "command = \"definitely-not-ultrafuzz\"",
            )
            .replace(
                "allow_dangerous_bypass = false",
                "allow_dangerous_bypass = true",
            );
        fs::write(config_path, toml).unwrap();

        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--backend", "claude-code-cli"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(output.contains("backend claude-code-cli: command-not-found"));
        assert!(output.contains("definitely-not-ultrafuzz"));
        assert!(output.contains("check backend-command: fail"));
        assert!(output.contains("Next:"));
        assert!(output.contains("ultrafuzz doctor"));
        assert!(!output.contains("ultrafuzz ui"));
    }

    #[test]
    fn doctor_reports_next_commands_and_json() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let _path_guard = fake_toolchain_path(temp.path(), &[]);

        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--no-color"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(output.contains("ultrafuzz doctor"));
        assert!(output.contains("topology: ok"));
        assert!(output.contains("Next commands:"));
        assert!(output.contains("ultrafuzz run"));
        assert!(output.contains("ultrafuzz dashboard"));
        assert!(!output.contains("ultrafuzz dashboard latest"));
        assert!(!output.contains("ultrafuzz ui"));
        assert!(!output.contains("\u{1b}["));

        let json_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--json"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(&json_output).unwrap();
        assert_ne!(json["status"], "failed");
        assert_eq!(json["topology"]["status"], "ok");
        assert_eq!(json["toolchain"]["status"], "ok");
        assert_eq!(json["config"]["source"], "ultrafuzz.toml");
        assert!(json["next_commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|command| command.as_str() == Some("ultrafuzz dashboard")));
    }

    #[test]
    fn doctor_tool_command_report_warns_for_missing_allowlisted_tools() {
        let mut config = CampaignConfig::default();
        config.tools.commands.allow = vec![
            "git".to_owned(),
            "definitely-not-ultrafuzz-required-tool".to_owned(),
        ];

        let report = tool_command_policy_report(&config);
        let summary = report.summary_line();
        let check = report.check_line();

        assert!(summary.contains("tool_commands:"));
        assert!(summary.contains("definitely-not-ultrafuzz-required-tool"));
        assert!(check.contains("check tool-commands: warn"));
        assert!(check.contains("missing allowlisted tool command executable(s)"));
        assert!(check.contains("definitely-not-ultrafuzz-required-tool"));
    }

    #[test]
    fn doctor_fails_when_stateful_invariant_recon_tool_is_missing() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let _path_guard = fake_toolchain_path(temp.path(), &["recon"]);

        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--no-color"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(output.contains("toolchain: failed"));
        assert!(output.contains("toolchain recon: fail"));
        assert!(output.contains("stateful invariant Recon campaign"));
        assert!(output.contains("stateful-invariant-recon-campaign"));
        assert!(output.contains("stateful invariant coverage"));
        assert!(output.contains("Install recon-fuzzer"));
        assert!(output.contains("ultrafuzz doctor"));
        assert!(!output.contains("ultrafuzz run\n  ultrafuzz dashboard"));

        let json_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--json"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(&json_output).unwrap();
        assert_eq!(json["status"], "failed");
        assert_eq!(json["toolchain"]["status"], "failed");
        let recon = json["toolchain"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["command"].as_str() == Some("recon"))
            .expect("recon check should be present");
        assert_eq!(recon["status"], "fail");
        assert_eq!(recon["resolved_path"], serde_json::Value::Null);
        assert!(recon["blocking"]
            .as_array()
            .unwrap()
            .iter()
            .any(|block| block["node"].as_str() == Some("stateful-invariant-recon-campaign")));
    }

    #[test]
    fn doctor_fails_when_stateful_invariant_coverage_evaluator_is_missing() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let _path_guard = fake_toolchain_path(temp.path(), &["covg-eval"]);

        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--no-color"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(output.contains("toolchain: failed"));
        assert!(output.contains("toolchain covg-eval/covg_eval: fail"));
        assert!(output.contains("stateful invariant coverage"));
        assert!(output.contains("stateful-invariant-coverage"));
        assert!(output.contains("either `covg-eval` or `covg_eval`"));

        let json_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--json"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(&json_output).unwrap();
        assert_eq!(json["status"], "failed");
        let evaluator = json["toolchain"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["command"].as_str() == Some("covg-eval/covg_eval"))
            .expect("coverage evaluator check should be present");
        assert_eq!(evaluator["status"], "fail");
        assert_eq!(evaluator["commands"], json!(["covg-eval", "covg_eval"]));
        assert!(evaluator["blocking"]
            .as_array()
            .unwrap()
            .iter()
            .any(|block| block["node"].as_str() == Some("stateful-invariant-coverage")));
    }

    #[test]
    fn doctor_does_not_require_echidna_binary_for_recon_prompts() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let _path_guard = fake_toolchain_path(temp.path(), &["echidna"]);

        let json_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--json"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let json: serde_json::Value = serde_json::from_str(&json_output).unwrap();
        assert_eq!(json["toolchain"]["status"], "ok");
        assert!(!json["toolchain"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["command"].as_str() == Some("echidna")));
    }

    #[test]
    fn doctor_uses_edited_invariant_prompt_commands_for_toolchain_requirements() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        write_single_invariant_coverage_prompt(
            temp.path(),
            r#"---
id: stateful-invariant-coverage
display_name: CI Stateful Invariant Coverage
---

# CI Stateful Invariant Coverage

This lane reads target fixtures through a bounded helper and writes the required
coverage and findings artifacts. Do not run fuzzers or coverage tooling.
Do not run `recon`, `covg-eval`, `forge`, `node`, `npm`, `npx`, `timeout`, or `echidna`; document missing tooling as a blocker if an artifact needs it.
"#,
        );
        let _path_guard = fake_toolchain_path(
            temp.path(),
            &[
                "recon",
                "echidna",
                "covg-eval",
                "forge",
                "node",
                "npm",
                "npx",
                "timeout",
            ],
        );

        let json_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--json"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let json: serde_json::Value = serde_json::from_str(&json_output).unwrap();
        assert_ne!(json["status"], "failed");
        assert_eq!(json["toolchain"]["status"], "ok");
        assert!(json["toolchain"]["checks"].as_array().unwrap().is_empty());
    }

    #[test]
    fn doctor_detects_direct_npm_and_node_commands_in_edited_prompt() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        write_single_invariant_coverage_prompt(
            temp.path(),
            r#"---
id: stateful-invariant-coverage
display_name: Direct Node Tooling
---

# Direct Node Tooling

Run npm exec recon-generate@latest coverage.
Run node scripts/summarize-coverage.js.
"#,
        );
        let _path_guard = fake_toolchain_path(temp.path(), &["node", "npm"]);

        let json_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--json"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let json: serde_json::Value = serde_json::from_str(&json_output).unwrap();
        assert_eq!(json["toolchain"]["status"], "failed");
        let checks = json["toolchain"]["checks"].as_array().unwrap();
        for command in ["node", "npm"] {
            let check = checks
                .iter()
                .find(|check| check["command"].as_str() == Some(command))
                .unwrap_or_else(|| panic!("{command} check should be present"));
            assert_eq!(check["status"], "fail");
        }
        assert!(!checks
            .iter()
            .any(|check| check["command"].as_str() == Some("npx")));
    }

    #[test]
    fn doctor_detects_edited_prompt_echidna_binary_command() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        write_single_invariant_coverage_prompt(
            temp.path(),
            r#"---
id: stateful-invariant-coverage
display_name: Explicit Echidna Tooling
---

# Explicit Echidna Tooling

Run `echidna test/invariants/Invariant.t.sol --config echidna.yaml`.
Document that `recon` is absent and do not invoke it.
"#,
        );
        let _path_guard = fake_toolchain_path(temp.path(), &["echidna"]);

        let json_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--json"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let json: serde_json::Value = serde_json::from_str(&json_output).unwrap();
        assert_eq!(json["toolchain"]["status"], "failed");
        let checks = json["toolchain"]["checks"].as_array().unwrap();
        let echidna = checks
            .iter()
            .find(|check| check["command"].as_str() == Some("echidna"))
            .expect("echidna check should be present");
        assert_eq!(echidna["status"], "fail");
        assert!(!checks
            .iter()
            .any(|check| check["command"].as_str() == Some("recon")));
    }

    #[test]
    fn doctor_treats_sentence_punctuation_as_command_boundary() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        write_single_invariant_coverage_prompt(
            temp.path(),
            r#"---
id: stateful-invariant-coverage
display_name: Punctuated Commands
---

# Punctuated Commands

Run forge.
Use covg_eval.
"#,
        );
        let _path_guard = fake_toolchain_path(temp.path(), &["forge", "covg-eval"]);

        let json_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "doctor", "--json"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let json: serde_json::Value = serde_json::from_str(&json_output).unwrap();
        assert_eq!(json["toolchain"]["status"], "failed");
        let checks = json["toolchain"]["checks"].as_array().unwrap();
        for command in ["forge", "covg-eval/covg_eval"] {
            let check = checks
                .iter()
                .find(|check| check["command"].as_str() == Some(command))
                .unwrap_or_else(|| panic!("{command} check should be present"));
            assert_eq!(check["status"], "fail");
        }
    }

    #[test]
    fn run_preflight_rejects_missing_stateful_invariant_toolchain() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        let _path_guard = fake_toolchain_path(temp.path(), &["recon"]);

        let error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--strategy-loops", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("required campaign toolchain is unavailable"));
        assert!(error.contains("recon"));
        assert!(error.contains("stateful-invariant-recon-campaign"));
        assert!(!error.contains("Run complete."));
    }

    #[test]
    fn run_preflight_skips_reused_stateful_invariant_nodes() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let config = load_doctor_config(temp.path(), None).unwrap();
        let graph =
            build_campaign_graph_from_project(RunId::from("run"), temp.path(), &config).unwrap();
        let reused_invariant_nodes = graph
            .nodes
            .iter()
            .filter_map(|node| match &node.kind {
                NodeKind::Agentic { logical_id, .. }
                    if logical_id.as_str() == STATEFUL_INVARIANT_COVERAGE_ID
                        || logical_id.as_str() == STATEFUL_INVARIANT_RECON_CAMPAIGN_ID =>
                {
                    Some(node.id.clone())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(!reused_invariant_nodes.is_empty());
        let _path_guard = fake_toolchain_path(
            temp.path(),
            &[
                "recon",
                "covg-eval",
                "forge",
                "node",
                "npm",
                "npx",
                "timeout",
            ],
        );

        let missing_error = preflight_campaign_toolchain(temp.path(), &graph, &[])
            .unwrap_err()
            .to_string();
        assert!(missing_error.contains("recon"));
        preflight_campaign_toolchain(temp.path(), &graph, &reused_invariant_nodes).unwrap();
    }

    #[test]
    fn custom_strategy_prompt_appears_in_graph_and_artifacts() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);
        fs::write(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/storage-layout.md"),
            "---\nid: storage-layout\ndisplay_name: Storage Layout\nloops: 2\n---\n# Storage Layout\nRepo {{repo_path}}\nWorkspace {{workspace_path}}\nArtifact {{artifact_path}}\nRun artifacts {{run_artifacts_path}}\nFindings {{output_findings_path}}\n",
        )
        .unwrap();
        let topology_path = temp.path().join(".ultrafuzz/topology.yml");
        let mut topology: ProjectTopology =
            serde_yaml::from_str(&fs::read_to_string(&topology_path).unwrap()).unwrap();
        topology.defaults.strategy_loops = 2;
        topology.nodes.push(TopologyNode {
            id: NodeId::from("storage-layout"),
            kind: TopologyNodeKind::Agentic,
            role: None,
            prompt: Some(PathBuf::from("strategies/storage-layout.md")),
            reference: None,
            group: Some("strategies".to_owned()),
            depends_on: vec![NodeId::from("property-specification-fanin")],
            loops: 2,
            loop_mode: LoopMode::Parallel,
            timeout_seconds: None,
            required_artifacts: Vec::new(),
            primary_artifact: None,
        });
        topology
            .nodes
            .iter_mut()
            .find(|node| node.id == NodeId::from(ultrafuzz_topology::FINISH_NODE_ID))
            .unwrap()
            .depends_on
            .push(NodeId::from("storage-layout"));
        fs::write(&topology_path, serde_yaml::to_string(&topology).unwrap()).unwrap();

        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let run_id = parse_run_id(&run_output);
        let run_dir = temp.path().join(".ultrafuzz/runs").join(&run_id);

        let graph_json = fs::read_to_string(run_dir.join("graph.json")).unwrap();
        assert!(graph_json.contains("storage-layout-0"));
        assert!(graph_json.contains("storage-layout-1"));
        let rendered =
            fs::read_to_string(run_dir.join("artifacts/storage-layout-0/prompt.rendered.md"))
                .unwrap();
        assert!(rendered.contains("Storage Layout"));
        assert!(rendered.contains(&temp.path().display().to_string()));
        assert!(rendered.contains(&run_dir.join("artifacts").display().to_string()));
        assert!(rendered.contains(
            &run_dir
                .join("artifacts/storage-layout-0/findings.json")
                .display()
                .to_string()
        ));
    }

    #[test]
    fn run_collects_and_aggregates_generated_tests_without_staging_target_changes() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("README.md"), "repo\n").unwrap();
        init_git_repo(temp.path());
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), true);
        configure_single_patch_strategy(temp.path());

        let before = fs::read_to_string(temp.path().join("README.md")).unwrap();
        let output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--max-parallel-agents", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let after = fs::read_to_string(temp.path().join("README.md")).unwrap();

        assert_eq!(before, after);
        let run_id = parse_run_id(&output);
        let run_dir = temp.path().join(".ultrafuzz/runs").join(&run_id);
        let generated_test = run_dir.join(
            "artifacts/encode-decode-0/generated-tests/test/foundry/encode-decode/Generated.t.sol",
        );
        assert_eq!(
            fs::read_to_string(&generated_test).unwrap(),
            "// generated encode-decode test\n"
        );
        assert!(run_dir
            .join("artifacts/encode-decode-0/generated-tests.json")
            .exists());
        let report_md =
            fs::read_to_string(run_dir.join("artifacts/final-report/report.md")).unwrap();
        assert!(report_md.contains("Synthetic execution completed."));
        let report_json: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(run_dir.join("artifacts/final-report/report.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(report_json["materialization"]["performed"], false);
        assert_eq!(report_json["materialization"]["mode"], "none");
        let merge_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "merge", &run_id]).unwrap(),
            temp.path(),
        )
        .unwrap();
        assert!(merge_output.contains("ultrafuzz test aggregation summary"));
        let aggregation =
            read_json_file(&run_dir.join("artifacts/aggregate-test-files/aggregation.json"))
                .unwrap();
        assert!(aggregation["copied_test_files"].as_u64().unwrap() > 0);
        let generated_record = aggregation["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|record| {
                record["source_artifact"].as_str()
                    == Some("generated-tests/test/foundry/encode-decode/Generated.t.sol")
                    || record["source_relative_path"].as_str()
                        == Some("test/foundry/encode-decode/Generated.t.sol")
            })
            .expect("encode-decode generated test is aggregated");
        let destination = generated_record["destination"]
            .as_str()
            .expect("aggregated test destination is recorded");
        assert_eq!(
            fs::read_to_string(
                run_dir
                    .join("artifacts/aggregate-test-files/workspace-changes")
                    .join(destination)
            )
            .unwrap(),
            "// generated encode-decode test\n"
        );
        assert!(!temp.path().join(destination).exists());
        let status = git_stdout_for_test(temp.path(), ["status", "--short"]);
        assert!(!status.contains("?? test/"));
        assert!(ProcessCommand::new("git")
            .arg("-C")
            .arg(temp.path())
            .args(["diff", "--cached", "--quiet"])
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn materialize_copies_selected_generated_file_as_untracked_change() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("README.md"), "repo\n").unwrap();
        init_git_repo(temp.path());
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        configure_fake_backend(temp.path(), false);

        let run_output = execute_in(
            Cli::try_parse_from(["ultrafuzz", "run", "--max-parallel-agents", "1"]).unwrap(),
            temp.path(),
        )
        .unwrap();
        let run_id = parse_run_id(&run_output);
        let generated = temp
            .path()
            .join(".ultrafuzz/runs")
            .join(&run_id)
            .join("artifacts/final-report/generated.t.sol");
        fs::write(&generated, "// generated test\n").unwrap();

        let default_error = execute_in(
            Cli::try_parse_from(["ultrafuzz", "materialize", &run_id]).unwrap(),
            temp.path(),
        )
        .unwrap_err();
        assert!(default_error
            .to_string()
            .contains("no default materialization output is available"));

        let output = execute_in(
            Cli::try_parse_from([
                "ultrafuzz",
                "materialize",
                &run_id,
                "--copy",
                "artifacts/final-report/generated.t.sol=test/Generated.t.sol",
            ])
            .unwrap(),
            temp.path(),
        )
        .unwrap();

        assert!(output.contains("copies: 1"));
        assert_eq!(
            fs::read_to_string(temp.path().join("test/Generated.t.sol")).unwrap(),
            "// generated test\n"
        );
        let status = git_stdout_for_test(temp.path(), ["status", "--short"]);
        assert!(status.contains("?? test/"));
        assert!(ProcessCommand::new("git")
            .arg("-C")
            .arg(temp.path())
            .args(["diff", "--cached", "--quiet"])
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn materialize_rejects_conflicting_patch_sequence_without_partial_changes() {
        let _guard = cli_test_guard();
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("README.md"), "repo\n").unwrap();
        init_git_repo(temp.path());
        execute_in(
            Cli::try_parse_from(["ultrafuzz", "init"]).unwrap(),
            temp.path(),
        )
        .unwrap();

        let run_id = "run-conflicting-patches";
        let run_root = temp.path().join(".ultrafuzz/runs").join(run_id);
        let patch_a_dir = run_root.join("artifacts/patch-a");
        let patch_b_dir = run_root.join("artifacts/patch-b");
        fs::create_dir_all(&patch_a_dir).unwrap();
        fs::create_dir_all(&patch_b_dir).unwrap();
        fs::copy(
            temp.path().join("ultrafuzz.toml"),
            run_root.join(RESOLVED_CONFIG_FILE_NAME),
        )
        .unwrap();

        fs::write(temp.path().join("README.md"), "patch a\n").unwrap();
        fs::write(
            patch_a_dir.join("patch.diff"),
            git_stdout_for_test(temp.path(), ["diff", "--binary"]),
        )
        .unwrap();
        fs::write(temp.path().join("README.md"), "patch b\n").unwrap();
        fs::write(
            patch_b_dir.join("patch.diff"),
            git_stdout_for_test(temp.path(), ["diff", "--binary"]),
        )
        .unwrap();
        fs::write(temp.path().join("README.md"), "repo\n").unwrap();

        let error = execute_in(
            Cli::try_parse_from([
                "ultrafuzz",
                "materialize",
                run_id,
                "--patch",
                "artifacts/patch-a/patch.diff",
                "--patch",
                "artifacts/patch-b/patch.diff",
            ])
            .unwrap(),
            temp.path(),
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("do not apply cleanly as a sequence"));
        assert_eq!(
            fs::read_to_string(temp.path().join("README.md")).unwrap(),
            "repo\n"
        );
        assert_eq!(
            git_stdout_for_test(temp.path(), ["diff", "--", "README.md"]),
            ""
        );
    }

    fn parse_run_id(output: &str) -> String {
        if let Some(run_id) = output
            .lines()
            .find_map(|line| line.strip_prefix("Run ID: "))
        {
            return run_id.to_owned();
        }
        output
            .split("run_id: ")
            .nth(1)
            .and_then(|rest| rest.split([',', '\n']).next())
            .expect("run output must contain run_id")
            .to_owned()
    }

    fn mark_source_node_failed(run_root: &Path, node_id: &str) {
        let store = RunStateStore::for_run_root(run_root);
        let mut state = store.load().unwrap();
        let node = state
            .nodes
            .get_mut(&NodeId::from(node_id))
            .expect("test source run should contain node");
        node.status = NodeStatus::Failed;
        node.last_error = Some("synthetic source failure".to_owned());
        state.status = RunStatus::Failed;
        store.save(&state).unwrap();
    }

    fn configure_fake_backend(repo: &Path, write_generated_test: bool) {
        configure_fake_backend_with_options(repo, write_generated_test, false);
    }

    fn configure_fake_backend_without_reference_cache(repo: &Path, write_generated_test: bool) {
        write_fake_backend(repo, write_generated_test, false);
    }

    const RESTART_BACKEND_ENV_FIXTURE: &str = r#"CUSTOM_AUTH = "runtime-secret"
OPENAI_BASE_URL = "https://provider.example/v1"
"#;

    const RESTART_MODEL_ENV_FIXTURE: &str = r#"
[models.default]
backend = "codex-cli"

[models.default.env]
MODEL_SESSION = "model-runtime-secret"
"#;

    fn add_restart_env_fixture(repo: &Path) {
        let config_path = repo.join("ultrafuzz.toml");
        let config = fs::read_to_string(&config_path).unwrap();
        let config = config.replace(
            "[backend.codex_cli.env]\n",
            &format!("[backend.codex_cli.env]\n{RESTART_BACKEND_ENV_FIXTURE}"),
        );
        fs::write(config_path, format!("{config}{RESTART_MODEL_ENV_FIXTURE}")).unwrap();
    }

    fn remove_restart_env_fixture(repo: &Path) {
        let config_path = repo.join("ultrafuzz.toml");
        let config = fs::read_to_string(&config_path)
            .unwrap()
            .replace(RESTART_BACKEND_ENV_FIXTURE, "")
            .replace(RESTART_MODEL_ENV_FIXTURE, "");
        fs::write(config_path, config).unwrap();
    }

    fn configure_fake_backend_with_options(
        repo: &Path,
        write_generated_test: bool,
        skip_dynamic_artifacts: bool,
    ) {
        seed_reference_cache(repo);
        write_fake_backend(repo, write_generated_test, skip_dynamic_artifacts);
    }

    fn write_fake_backend(repo: &Path, write_generated_test: bool, skip_dynamic_artifacts: bool) {
        let script = repo.join("fake-ultrafuzz-backend.sh");
        let test_block = if write_generated_test {
            "mkdir -p \"$ULTRAFUZZ_WORKSPACE_PATH/test/foundry/$ULTRAFUZZ_STRATEGY\"\nprintf '// generated %s test\\n' \"$ULTRAFUZZ_STRATEGY\" > \"$ULTRAFUZZ_WORKSPACE_PATH/test/foundry/$ULTRAFUZZ_STRATEGY/Generated.t.sol\"\n"
        } else {
            ""
        };
        fs::write(
            &script,
            r#"#!/bin/sh
set -eu
echo fake backend
printf '[]\n' > "$ULTRAFUZZ_OUTPUT_FINDINGS_PATH"
logical_node="${ULTRAFUZZ_STRATEGY:-${ULTRAFUZZ_NODE_ID:-}}"
case "$logical_node" in
  project-discovery)
    mkdir -p "$ULTRAFUZZ_ARTIFACT_DIR/setup"
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/setup/project-discovery.md" <<'MD'
# Project discovery

Fake backend project discovery.
MD
    ;;
  actors-flows)
    mkdir -p "$ULTRAFUZZ_ARTIFACT_DIR/setup"
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/setup/actors-flows.md" <<'MD'
# Actors & Flows

Fake backend actor and flow analysis.
MD
    ;;
  setup-foundry)
    mkdir -p "$ULTRAFUZZ_ARTIFACT_DIR/setup"
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/setup/setup-foundry.md" <<'MD'
# Setup Foundry

Fake backend harness preparation.
MD
    ;;
  base-test-setup)
    mkdir -p "$ULTRAFUZZ_ARTIFACT_DIR/setup"
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/setup/base-test-setup.md" <<'MD'
# BaseTest / Setup

Fake backend base test discovery.
MD
    ;;
  property-specification-0kn0t|property-specification-certora|property-specification-aviggiano|property-specification-josselin-feist|property-specification-crytic|property-specification-runtime-verification|property-specification-a16z|property-specification-recon)
    mkdir -p "$ULTRAFUZZ_ARTIFACT_DIR/properties"
    case "$logical_node" in
      property-specification-0kn0t)
        lens="0kn0t"
        lens_file="0kn0t.md"
        ;;
      property-specification-certora)
        lens="certora-thinking"
        lens_file="certora.md"
        ;;
      property-specification-aviggiano)
        lens="aviggiano"
        lens_file="aviggiano.md"
        ;;
      property-specification-josselin-feist)
        lens="josselin-feist"
        lens_file="josselin-feist.md"
        ;;
      property-specification-crytic)
        lens="crytic"
        lens_file="crytic.md"
        ;;
      property-specification-runtime-verification)
        lens="runtime-verification"
        lens_file="runtime-verification.md"
        ;;
      property-specification-recon)
        lens="recon"
        lens_file="recon.md"
        ;;
      *)
        lens="a16z"
        lens_file="a16z.md"
        ;;
    esac
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/properties/$lens_file" <<MD
# $lens properties

| property id | description | category | priority |
| --- | --- | --- | --- |
| fake-$lens-property | Fake $lens property | high-level | medium |
MD
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/candidate-properties.json" <<JSON
{
  "schema_version": "1.0",
  "lens_id": "$lens",
  "lens_display_name": "$lens",
  "status": "succeeded",
  "candidate_properties": [
    {
      "id": "fake-$lens-property",
      "title": "Fake $lens property",
      "source_lens_id": "$lens",
      "source_evidence": ["test fixture"],
      "property_type": "high-level",
      "workflow": "fake workflow",
      "oracle": "fake oracle must hold",
      "required_setup": "fake setup",
      "preconditions": [],
      "suggested_fuzzing_framework_or_strategy_fit": "Foundry",
      "suggested_priority_signal": "medium",
      "confidence": "medium",
      "false_positive_or_setup_bias_risks": [],
      "notes": []
    }
  ],
  "errors": []
}
JSON
    ;;
  stateful-invariant-setup)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/setup-inventory.md" <<'MD'
# Setup Inventory

No setup inventory was produced by the fake backend.
MD
    ;;
  stateful-invariant-handlers)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/handler-coverage-inventory.md" <<'MD'
# Handler Coverage Inventory

No handler coverage inventory was produced by the fake backend.
MD
    ;;
    stateful-invariant-coverage)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/coverage-goal.json" <<'JSON'
{
  "coverage_target_percent": 90,
  "status": "fake-backend"
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/coverage-report.md" <<'MD'
# Coverage Report

No coverage report was produced by the fake backend.
MD
    printf '[]\n' > "$ULTRAFUZZ_ARTIFACT_DIR/harness-repairs.json"
    ;;
  stateful-invariant-implement-properties)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/implemented-properties.md" <<'MD'
# Implemented Properties

No properties were implemented by the fake backend.
MD
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/implemented-properties.json" <<'JSON'
{
  "schema_version": "1.0",
  "selected_priorities": [],
  "implemented_properties": [],
  "deferred_properties": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/generated-tests.json" <<'JSON'
{
  "schema_version": "1.0",
  "node_id": "stateful-invariant-implement-properties",
  "test_files": []
}
JSON
    ;;
  stateful-invariant-recon-campaign)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/campaign-plan.json" <<'JSON'
{
  "schema_version": "1.0",
  "status": "fake-backend"
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/campaign-report.md" <<'MD'
# Recon-fuzzer Campaign

No campaign was run by the fake backend.
MD
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/recon-fuzzer-results.json" <<'JSON'
{
  "schema_version": "1.0",
  "status": "fake-backend",
  "failures": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/generated-tests.json" <<'JSON'
{
  "schema_version": "1.0",
  "node_id": "stateful-invariant-recon-campaign",
  "test_files": []
}
JSON
    ;;
  boundary-tests)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/boundary-recipes.md" <<'MD'
# Boundary Recipes

No boundary recipes were produced by the fake backend.
MD
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/boundary-recipes.json" <<'JSON'
{
  "schema_version": "1.0",
  "recipes": [],
  "deferred_or_spec_gated": [],
  "coverage_priorities": []
}
JSON
    ;;
  admin-config-boundaries)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/admin-config-boundary-matrix.md" <<'MD'
# Admin / Config Boundary Matrix

No admin/config boundary rows were produced by the fake backend.
MD
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/admin-config-boundary-matrix.json" <<'JSON'
{
  "schema_version": "1.0",
  "surfaces": [],
  "selector_mismatches": [],
  "ambiguous_or_incomplete_specs": [],
  "generated_tests": [],
  "coverage_notes": []
}
JSON
    ;;
  external-dependency-boundaries)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/dependency-scope-matrix.md" <<'MD'
# Dependency Scope Matrix

No external dependency scope rows were produced by the fake backend.
MD
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/dependency-scope-matrix.json" <<'JSON'
{
  "schema_version": "1.0",
  "dependencies": [],
  "in_scope_test_targets": [],
  "non_finding_rows": [],
  "generated_tests": [],
  "source_backed_in_scope_rationales": [],
  "coverage_notes": []
}
JSON
    ;;
  differential-oracle-planner)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/differential-plan.json" <<'JSON'
{
  "schema_version": "1.0",
  "candidate_surfaces": [],
  "public_oracle_basis": [],
  "out_of_scope_behavior": [],
  "reference_model_rules": [],
  "deployment_assumptions": [],
  "phase_priorities": [],
  "preliminary_lane_assignments": []
}
JSON
    ;;
  reference-harness-author)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/reference-harness.json" <<'JSON'
{
  "schema_version": "1.0",
  "reference_files": [],
  "harness_files": [],
  "validation_commands": [],
  "validation_status": "not-run",
  "notes": []
}
JSON
    ;;
  reference-and-lane-auditor)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/audited-differential-lanes.json" <<'JSON'
{
  "schema_version": "1.0",
  "lanes": [
    {
      "lane_id": "synthetic-lane",
      "status": "ready",
      "public_evidence_paths": [],
      "observable_equality_assertions": []
    }
  ],
  "rejected_or_narrowed_lanes": []
}
JSON
    ;;
  differential-lane-author)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/lane-result.json" <<JSON
{
  "schema_version": "1.0",
  "lane_id": "synthetic-lane-${ULTRAFUZZ_ATTEMPT_INDEX:-0}",
  "status": "green",
  "focused_command": "synthetic",
  "semantic_reds": [],
  "compile_or_harness_defects": []
}
JSON
    ;;
  differential-red-triage)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/semantic-red-registry.json" <<'JSON'
{
  "schema_version": "1.0",
  "semantic_reds": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/triage-a.json" <<'JSON'
{
  "schema_version": "1.0",
  "pass": "a",
  "classifications": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/triage-b.json" <<'JSON'
{
  "schema_version": "1.0",
  "pass": "b",
  "classifications": []
}
JSON
    ;;
  differential-repair-and-report-review)
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/repair-summary.json" <<'JSON'
{
  "schema_version": "1.0",
  "repaired_harness_or_reference_defects": [],
  "preserved_production_bug_reds": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/gap-review.json" <<'JSON'
{
  "schema_version": "1.0",
  "green_suites": [],
  "missing_lane_work_orders": [],
  "incomplete_campaign_work_orders": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/differential-report-review.json" <<'JSON'
{
  "schema_version": "1.0",
  "status": "complete",
  "report_findings": []
}
JSON
    ;;
  dynamic-strategy-generator)
    if [ "__SKIP_DYNAMIC_ARTIFACTS__" = "1" ]; then
      :
    else
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/strategy-plan.json" <<'JSON'
{
  "schema_version": "1.0",
  "dynamic_strategies_enumerator": 3,
  "status": "no-actionable-strategies",
  "selected_strategy_count": 0,
  "selected_strategies": [],
  "rejected_strategies": [],
  "prior_run_artifacts_considered": [],
  "current_run_artifacts_considered": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/enumerator-outputs.json" <<'JSON'
{
  "schema_version": "1.0",
  "enumerators": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/aggregate-recommendations.json" <<'JSON'
{
  "schema_version": "1.0",
  "recommendations": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/selected-strategies.json" <<'JSON'
{
  "schema_version": "1.0",
  "selected_strategies": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/generated-tests.json" <<'JSON'
{
  "schema_version": "1.0",
  "node_id": "dynamic-strategy-generator",
  "test_files": []
}
JSON
    cat > "$ULTRAFUZZ_ARTIFACT_DIR/provenance.json" <<'JSON'
{
  "schema_version": "1.0",
  "prior_run_artifacts": [],
  "current_run_artifacts": [],
  "validation": []
}
JSON
    fi
    ;;
esac
if [ "$logical_node" = "property-specification" ] || [ "$logical_node" = "property-specification-fanin" ]; then
  catalog_dir="$ULTRAFUZZ_ARTIFACT_DIR"
  if [ "$logical_node" = "property-specification-fanin" ]; then
    catalog_dir="$(dirname "$ULTRAFUZZ_ARTIFACT_DIR")/property-specification"
    mkdir -p "$catalog_dir"
  fi
  cat > "$catalog_dir/property-specification.json" <<'JSON'
{
  "schema_version": "1.0",
  "documentation_sources": [],
  "guidance_applied": ["test fake backend"],
  "lens_inputs": [],
  "candidate_properties": [
    {
      "id": "fake-property",
      "title": "Fake property",
      "property_type": "high-level",
      "priority": "medium",
      "source": "test fixture",
      "source_lenses": ["certora-thinking", "crytic", "runtime-verification", "a16z", "recon", "aviggiano", "0kn0t", "josselin-feist"],
      "source_evidence": ["test fixture"],
      "workflow": "fake workflow",
      "oracle": "fake oracle must hold",
      "setup": "fake setup",
      "preconditions": [],
      "frameworks": ["Foundry"],
      "confidence": "medium",
      "failure_classification": "inconclusive",
      "false_positive_or_setup_bias_risks": [],
      "notes": []
    }
  ],
  "deferred_or_rejected_properties": [],
  "findings": []
}
JSON
  cp "$catalog_dir/property-specification.json" "$ULTRAFUZZ_ARTIFACT_DIR/property-specification.json"
  cat > "$ULTRAFUZZ_ARTIFACT_DIR/properties.md" <<'MD'
# Consolidated properties

| property id | property description | category | priority |
| --- | --- | --- | --- |
| fake-property | Fake property | high-level | medium |
MD
fi
if [ "$logical_node" = "dedupe-findings" ]; then
  printf '[]\n' > "$ULTRAFUZZ_ARTIFACT_DIR/deduped-findings.json"
  printf '[]\n' > "$ULTRAFUZZ_ARTIFACT_DIR/strategy-detections.json"
  printf '{\n  "schema_version": "1.0",\n  "records": []\n}\n' > "$ULTRAFUZZ_ARTIFACT_DIR/finding-lifecycle-ledger.json"
fi
if [ "$logical_node" = "triage" ]; then
  printf '[]\n' > "$ULTRAFUZZ_ARTIFACT_DIR/triaged-findings.json"
  printf '[]\n' > "$ULTRAFUZZ_ARTIFACT_DIR/strategy-detections.json"
  printf '{\n  "schema_version": "1.0",\n  "records": []\n}\n' > "$ULTRAFUZZ_ARTIFACT_DIR/finding-lifecycle-ledger.json"
  cat > "$ULTRAFUZZ_ARTIFACT_DIR/triage-summary.json" <<'JSON'
{
  "schema_version": "1.0",
  "findings": 0,
  "status_counts": {}
}
JSON
fi
if [ "$logical_node" = "severity-classification" ]; then
  printf '[]\n' > "$ULTRAFUZZ_ARTIFACT_DIR/severity-classified-findings.json"
  printf '[]\n' > "$ULTRAFUZZ_ARTIFACT_DIR/strategy-detections.json"
  printf '{\n  "schema_version": "1.0",\n  "records": []\n}\n' > "$ULTRAFUZZ_ARTIFACT_DIR/finding-lifecycle-ledger.json"
fi
if [ "$logical_node" = "aggregate-test-files" ] && [ ! -f "$ULTRAFUZZ_ARTIFACT_DIR/aggregation.json" ]; then
  cat > "$ULTRAFUZZ_ARTIFACT_DIR/aggregation.json" <<'JSON'
{
  "schema_version": "1.0",
  "source_test_files": 0,
  "copied_test_files": 0,
  "source_support_files": 0,
  "copied_support_files": 0,
  "files": [],
  "support_files": [],
  "skipped_files": []
}
JSON
fi
if [ "$logical_node" = "final-report" ]; then
  cat > "$ULTRAFUZZ_ARTIFACT_DIR/report.md" <<'MD'
# Ultrafuzz report

Synthetic execution completed.
MD
  cat > "$ULTRAFUZZ_ARTIFACT_DIR/report.json" <<'JSON'
{
  "schema_version": "1.0",
  "materialization": {
    "performed": false,
    "mode": "none"
  }
}
JSON
  cat > "$ULTRAFUZZ_ARTIFACT_DIR/artifact-index.json" <<'JSON'
{
  "schema_version": "1.0",
  "artifacts": []
}
JSON
fi
__TEST_BLOCK__"#
                .replace("__TEST_BLOCK__", test_block)
                .replace(
                    "__SKIP_DYNAMIC_ARTIFACTS__",
                    if skip_dynamic_artifacts { "1" } else { "0" },
                ),
        )
        .unwrap();
        make_executable(&script);
        let config_path = repo.join("ultrafuzz.toml");
        let toml = fake_backend_config_toml(fs::read_to_string(&config_path).unwrap(), &script);
        fs::write(config_path, toml).unwrap();
    }

    fn configure_missing_artifact_backend(repo: &Path) {
        seed_reference_cache(repo);
        let script = repo.join("missing-artifact-backend.sh");
        fs::write(
            &script,
            r#"#!/bin/sh
set -eu
echo backend intentionally omitted required artifacts
"#,
        )
        .unwrap();
        make_executable(&script);
        let config_path = repo.join("ultrafuzz.toml");
        let toml = fake_backend_config_toml(fs::read_to_string(&config_path).unwrap(), &script);
        fs::write(config_path, toml).unwrap();
    }

    fn fake_backend_config_toml(toml: String, script: &Path) -> String {
        toml.replace("max_parallel_agents = 4", "max_parallel_agents = 1")
            .replace("max_parallel_nodes = 8", "max_parallel_nodes = 1")
            .replace(
                "allow_dangerous_bypass = false",
                "allow_dangerous_bypass = true",
            )
            .replace(
                "  \"artifacts\",\n  \"final-materialization\",",
                "  \"artifacts\",\n  \"extra-context\",\n  \"final-materialization\",",
            )
            .replace(
                "command = \"codex\"",
                &format!("command = \"{}\"", script.display()),
            )
    }

    fn seed_reference_cache(repo: &Path) {
        let cache_home = repo.join(".ultrafuzz/test-cache");
        std::env::set_var("XDG_CACHE_HOME", &cache_home);
        let catalog = ultrafuzz_references::load_catalog(repo).unwrap();
        for (id, reference) in &catalog.references {
            let cache_dir = ultrafuzz_references::cache_dir_for(reference).unwrap();
            fs::create_dir_all(&cache_dir).unwrap();
            let mut files = Vec::new();
            for path in &reference.paths {
                let content = format!(
                    "# Test reference: {id}\n\nPinned test fixture for `{}` at `{}`.\n",
                    path.display(),
                    reference.commit
                );
                let source_path = cache_dir.join(path);
                if let Some(parent) = source_path.parent() {
                    fs::create_dir_all(parent).unwrap();
                }
                fs::write(&source_path, content.as_bytes()).unwrap();
                files.push(ReferenceManifestFile {
                    path: path.clone(),
                    size_bytes: content.len() as u64,
                    sha256: test_sha256_hex(content.as_bytes()),
                });
            }
            let manifest = ReferenceCacheManifest {
                schema_version: "1.0".to_owned(),
                provider: reference.provider,
                repo: reference.repo.clone(),
                commit: reference.commit.clone(),
                fetched_at: "2026-06-23T00:00:00Z".to_owned(),
                files,
            };
            fs::write(
                cache_dir.join(CACHE_MANIFEST_FILE),
                format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
            )
            .unwrap();
        }
    }

    fn test_sha256_hex(bytes: &[u8]) -> String {
        let digest = Sha256::digest(bytes);
        let mut output = String::with_capacity(digest.len() * 2);
        for byte in digest {
            use std::fmt::Write as _;
            let _ = write!(output, "{byte:02x}");
        }
        output
    }

    fn configure_single_patch_strategy(repo: &Path) {
        let config_path = repo.join("ultrafuzz.toml");
        let mut toml = fs::read_to_string(&config_path).unwrap();
        toml.push_str(
            r#"
[strategies.differential-library-tests]
enabled = false

[strategies.round-trip]
enabled = false

[strategies.workflow-property-based-tests]
enabled = false

[strategies.stateful-invariant-setup]
enabled = false

[strategies.stateful-invariant-handlers]
enabled = false

[strategies.stateful-invariant-coverage]
enabled = false

[strategies.stateful-invariant-implement-properties]
enabled = false

[strategies.stateful-invariant-recon-campaign]
enabled = false
"#,
        );
        fs::write(config_path, toml).unwrap();
    }

    fn init_git_repo(repo: &Path) {
        run_git(repo, ["init"]);
        run_git(repo, ["add", "README.md"]);
        let output = ProcessCommand::new("git")
            .arg("-C")
            .arg(repo)
            .args([
                "-c",
                "user.email=ultrafuzz@example.invalid",
                "-c",
                "user.name=Ultrafuzz",
                "commit",
                "-m",
                "initial",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git commit failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn run_git<const N: usize>(repo: &Path, args: [&str; N]) {
        let output = ProcessCommand::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_stdout_for_test<const N: usize>(repo: &Path, args: [&str; N]) -> String {
        let output = ProcessCommand::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}
}
