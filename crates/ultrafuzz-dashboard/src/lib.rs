use axum::{
    extract::{Path as RoutePath, Request as AxumRequest, State},
    http::{header, uri::Authority, HeaderMap, StatusCode, Uri},
    middleware::{from_fn, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse, Redirect, Response,
    },
    routing::{get, post, MethodRouter},
    Json, Router,
};
use chrono::DateTime;
use futures_util::Stream;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    convert::Infallible,
    fs::{self, OpenOptions},
    io::Write,
    net::IpAddr,
    path::{Path, PathBuf},
    pin::Pin,
    process::Command as ProcessCommand,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use tokio::net::TcpListener;
use ultrafuzz_artifacts::{ArtifactManifest, ARTIFACT_MANIFEST_FILE};
use ultrafuzz_config::{CampaignConfig, CliOverrides, EnvOverrides};
use ultrafuzz_core::{BackendKind, BuiltInStrategy, NodeId, RunId};
use ultrafuzz_events::{replay_jsonl_report, replay_sqlite_report, EventRecord};
use ultrafuzz_prompts::{
    extract_prompt_ancestor_artifact_references, extract_prompt_artifact_path_references,
    parse_prompt_document, project_prompt_dir, prompt_artifact_output_paths,
    rename_prompt_artifact_path_references, scaffold_project_prompts, topology_prompt_markdown,
    validate_supported_template_variables, ParsedPromptDocument, PromptAncestorArtifactsSelector,
    PromptArtifactPathProducer, PromptRegistry, PromptSource, SUPPORTED_TEMPLATE_VARIABLES,
};
use ultrafuzz_state::{summarize_run_health, NodeState, RunHealthSummary, RunState, RunStateStore};
use ultrafuzz_topology::{
    build_campaign_graph_from_project, default_prompt_path, default_prompt_path_for_node,
    repair_topology_meta_contract, validate_project_topology, CampaignGraph, LoopMode,
    MetaNodeRole, Node, NodeKind, ProjectTopology, PropertyLens, TopologyNode, TopologyNodeKind,
    TopologyValidationOptions,
};

mod dashboard_assets {
    include!(concat!(env!("OUT_DIR"), "/dashboard_assets.rs"));
}

use dashboard_assets::{DASHBOARD_CSS, DASHBOARD_INDEX, DASHBOARD_JS};

const STDOUT_LOG: &str = "stdout.log";
const STDERR_LOG: &str = "stderr.log";
const RENDERED_PROMPT: &str = "prompt.rendered.md";
const FINDINGS_FILE: &str = "findings.json";
const DEDUPED_FINDINGS_FILE: &str = "deduped-findings.json";
const TRIAGED_FINDINGS_FILE: &str = "triaged-findings.json";
const SEVERITY_CLASSIFIED_FINDINGS_FILE: &str = "severity-classified-findings.json";
const FINDING_LIFECYCLE_LEDGER_FILE: &str = "finding-lifecycle-ledger.json";
const REPORT_MD_FILE: &str = "report.md";
const REPORT_JSON_FILE: &str = "report.json";
const PROPERTY_LENS_CANDIDATE_FILE: &str = "candidate-properties.json";
const PROPERTY_SPECIFICATION_FILE: &str = "property-specification.json";
const PROPERTY_FANIN_MARKDOWN_FILE: &str = "properties.md";
const DASHBOARD_SESSION_HEADER: &str = "x-ultrafuzz-session";
const SESSION_TOKEN_BYTES: usize = 32;
const SESSION_TOKEN_HEX_LEN: usize = SESSION_TOKEN_BYTES * 2;
const MAX_COMMAND_JOBS: usize = 20;
const MAX_COMMAND_JOB_OUTPUT_BYTES: usize = 16 * 1024;
const COMMAND_JOB_OUTPUT_TRUNCATED_PREFIX: &str = "[output truncated to latest bytes]\n";
const PREVIEW_RUN_ID: &str = "preview";
const THEME_BOOTSTRAP_SCRIPT: &str = r#"<script>
(() => {
  const key = "mds-theme";
  let preference = "system";
  try {
    const stored = localStorage.getItem(key);
    if (stored === "system" || stored === "light" || stored === "dark") {
      preference = stored;
    }
  } catch {
    preference = "system";
  }
  const resolved =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
})();
</script>"#;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DashboardServerConfig {
    pub project_root: PathBuf,
    pub host: String,
    pub port: u16,
    pub run_id: Option<RunId>,
    pub runs_dir: PathBuf,
    pub live_updates: bool,
}

impl Default for DashboardServerConfig {
    fn default() -> Self {
        Self {
            project_root: PathBuf::from("."),
            host: "127.0.0.1".to_owned(),
            port: 3_875,
            run_id: None,
            runs_dir: PathBuf::from(".ultrafuzz/runs"),
            live_updates: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DashboardHandle {
    pub bind_addr: String,
    pub run_id: RunId,
    pub run_url: String,
    pub run_root: PathBuf,
}

type CommandJobs = Arc<Mutex<BTreeMap<String, CommandJob>>>;

#[derive(Clone, Debug)]
struct DashboardAppState {
    project_root: PathBuf,
    runs_dir: PathBuf,
    run_id: RunId,
    run_root: PathBuf,
    source: DashboardRunSource,
    live_updates: bool,
    session_token: Arc<SessionToken>,
    command_jobs: CommandJobs,
}

#[derive(Clone, Eq, PartialEq)]
struct SessionToken {
    bytes: [u8; SESSION_TOKEN_BYTES],
}

impl SessionToken {
    fn generate() -> Result<Self, DashboardError> {
        let mut bytes = [0_u8; SESSION_TOKEN_BYTES];
        getrandom::fill(&mut bytes).map_err(|error| DashboardError::Entropy(error.to_string()))?;
        Ok(Self { bytes })
    }

    fn expose(&self) -> String {
        encode_session_token(&self.bytes)
    }

    fn matches(&self, value: &str) -> bool {
        decode_session_token(value)
            .map(|candidate| fixed_time_eq(&self.bytes, &candidate))
            .unwrap_or(false)
    }
}

impl std::fmt::Debug for SessionToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SessionToken(<redacted>)")
    }
}

#[derive(Clone, Debug)]
enum DashboardRunSource {
    Persisted,
    Preview,
}

#[derive(Clone, Debug)]
struct DashboardPreview {
    graph: CampaignGraph,
    state: RunState,
    metadata: Value,
}

impl DashboardAppState {
    fn new(config: DashboardServerConfig) -> Result<Self, DashboardError> {
        validate_loopback_host(&config.host)?;
        let project_root = absolute_path(&config.project_root);
        let runs_dir = absolute_path_from(&project_root, &config.runs_dir);
        let (run_id, use_preview) = match config.run_id {
            Some(run_id) => (run_id, false),
            None => match latest_run_id_optional(&runs_dir)? {
                Some(run_id) => (run_id, false),
                None => (RunId::from(PREVIEW_RUN_ID), true),
            },
        };
        validate_run_id(run_id.as_str())?;
        let run_root = runs_dir.join(run_id.as_str());
        let source = if use_preview {
            build_preview(&project_root, run_id.clone())?;
            DashboardRunSource::Preview
        } else {
            if !run_root.is_dir() {
                return Err(DashboardError::NotFound(format!(
                    "run `{run_id}` under {}",
                    runs_dir.display()
                )));
            }
            ensure_run_root_inside(&runs_dir, &run_root)?;
            DashboardRunSource::Persisted
        };

        let state = Self {
            project_root: project_root.clone(),
            runs_dir,
            session_token: Arc::new(SessionToken::generate()?),
            run_id,
            run_root,
            source,
            live_updates: config.live_updates,
            command_jobs: Arc::new(Mutex::new(BTreeMap::new())),
        };

        if state.prompts_editable() {
            scaffold_project_prompts(&project_root, false)
                .map_err(|error| DashboardError::Prompt(error.to_string()))?;
            match state.graph() {
                Ok(graph) => scaffold_project_node_prompts(&state.project_root, &graph)?,
                Err(error) if matches!(state.source, DashboardRunSource::Preview) => {
                    return Err(error);
                }
                Err(_) => {}
            }
        }

        Ok(state)
    }

    fn graph(&self) -> Result<CampaignGraph, DashboardError> {
        match &self.source {
            DashboardRunSource::Persisted => {
                let graph: CampaignGraph = read_json_required(self.run_root.join("graph.json"))?;
                for node in &graph.nodes {
                    validate_artifact_dir(&node.artifact_dir)?;
                }
                Ok(graph)
            }
            DashboardRunSource::Preview => Ok(self.current_preview()?.graph),
        }
    }

    fn display_graph(&self) -> Result<CampaignGraph, DashboardError> {
        let mut graph = self.graph()?;
        apply_node_prompt_display_names(&self.project_root, &mut graph)?;
        Ok(graph)
    }

    fn state(&self) -> Result<RunState, DashboardError> {
        match &self.source {
            DashboardRunSource::Persisted => RunStateStore::for_run_root(&self.run_root)
                .load()
                .map_err(|error| DashboardError::State(error.to_string())),
            DashboardRunSource::Preview => Ok(self.current_preview()?.state),
        }
    }

    fn optional_state(&self) -> Result<Option<RunState>, DashboardError> {
        match &self.source {
            DashboardRunSource::Persisted => {
                let path = self.run_root.join("state.json");
                if path.exists() {
                    self.state().map(Some)
                } else {
                    Ok(None)
                }
            }
            DashboardRunSource::Preview => Ok(Some(self.current_preview()?.state)),
        }
    }

    fn run_metadata(&self) -> Result<Value, DashboardError> {
        match &self.source {
            DashboardRunSource::Persisted => read_json_optional(self.run_root.join("run.json"))
                .map(|value| value.unwrap_or(Value::Null)),
            DashboardRunSource::Preview => Ok(self.current_preview()?.metadata),
        }
    }

    fn strategy_map(&self) -> Result<BTreeMap<String, StrategySummary>, DashboardError> {
        let metadata = self.run_metadata()?;
        let mut strategies = BTreeMap::new();
        for strategy in metadata
            .get("strategies")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = strategy.get("id").and_then(Value::as_str) else {
                continue;
            };
            strategies.insert(
                id.to_owned(),
                StrategySummary {
                    id: id.to_owned(),
                    display_name: strategy
                        .get("display_name")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_owned(),
                    category: strategy
                        .get("category")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_owned(),
                    source: strategy
                        .get("source")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_owned(),
                    models: strategy
                        .get("models")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                    loops: strategy
                        .get("loops")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        .unwrap_or(1),
                    attempts: strategy
                        .get("attempts")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        .unwrap_or_else(|| {
                            strategy
                                .get("loops")
                                .and_then(Value::as_u64)
                                .and_then(|value| usize::try_from(value).ok())
                                .unwrap_or(1)
                        }),
                    timeout_seconds: strategy.get("timeout_seconds").and_then(Value::as_u64),
                    expected_cost: strategy
                        .get("expected_cost")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    cost_note: strategy
                        .get("cost_note")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                },
            );
        }
        Ok(strategies)
    }

    fn model_map(&self) -> Result<BTreeMap<String, ModelSummary>, DashboardError> {
        let metadata = self.run_metadata()?;
        let mut models = BTreeMap::new();
        for model in metadata
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = model.get("id").and_then(Value::as_str) else {
                continue;
            };
            models.insert(
                id.to_owned(),
                ModelSummary {
                    id: id.to_owned(),
                    backend: model
                        .get("backend")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_owned(),
                    model: model
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                },
            );
        }
        Ok(models)
    }

    fn node_summaries(&self) -> Result<Vec<NodeSummary>, DashboardError> {
        let graph = self.display_graph()?;
        let state = self.optional_state()?;
        let strategies = self.strategy_map()?;
        let models = self.model_map()?;
        Ok(summarize_nodes(
            &graph,
            state.as_ref(),
            &strategies,
            &models,
        ))
    }

    fn node_detail(&self, node_id: &str) -> Result<NodeDetail, DashboardError> {
        let graph = self.graph()?;
        let state = self.optional_state()?;
        let strategies = self.strategy_map()?;
        let models = self.model_map()?;
        let mut node = graph
            .nodes
            .iter()
            .find(|node| graph_node_matches_prompt_id(node, node_id))
            .cloned()
            .ok_or_else(|| DashboardError::NotFound(format!("node `{node_id}`")))?;
        apply_node_prompt_display_name(&self.project_root, &mut node)?;
        let artifact_dir = self.artifact_dir(&node)?;
        let artifacts = artifact_entries(&artifact_dir, &node.id)?;
        let artifact_references = self.prompt_artifact_references(&graph, &node, &artifact_dir)?;
        let findings = node_findings(&artifact_dir)?;
        Ok(NodeDetail {
            run_id: self.run_id.to_string(),
            node: summarize_node(&node, state.as_ref(), &strategies, &models),
            state: state.and_then(|state| state.nodes.get(&node.id).cloned()),
            artifacts,
            artifact_references,
            stdout: read_text_optional(artifact_dir.join(STDOUT_LOG))?,
            stderr: read_text_optional(artifact_dir.join(STDERR_LOG))?,
            rendered_prompt: read_text_optional(artifact_dir.join(RENDERED_PROMPT))?,
            findings,
            metadata: read_json_optional(artifact_dir.join("metadata.json"))?,
            transcript: read_json_optional(artifact_dir.join("transcript.json"))?,
        })
    }

    fn prompt_markdown_for_graph_node(&self, node: &Node) -> Result<String, DashboardError> {
        if let Some(strategy_id) = strategy_id_for_node(node) {
            let registry = load_prompt_registry(&self.project_root)?;
            let prompt = registry
                .templates()
                .find(|prompt| prompt.strategy_id.as_str() == strategy_id)
                .ok_or_else(|| {
                    DashboardError::NotFound(format!("strategy prompt `{strategy_id}`"))
                })?;
            return prompt_markdown(&self.project_root, prompt);
        }

        let path = self.project_prompt_path_for_graph_node(node)?;
        if path.exists() {
            fs::read_to_string(path).map_err(Into::into)
        } else {
            Ok(default_node_prompt_markdown(node))
        }
    }

    fn prompt_artifact_references(
        &self,
        graph: &CampaignGraph,
        node: &Node,
        artifact_dir: &Path,
    ) -> Result<PromptArtifactReferences, DashboardError> {
        let markdown = match self.prompt_markdown_for_graph_node(node) {
            Ok(markdown) => markdown,
            Err(DashboardError::NotFound(_)) => return Ok(PromptArtifactReferences::default()),
            Err(error) => return Err(error),
        };
        let document = parse_prompt_document(&markdown)
            .map_err(|error| DashboardError::Prompt(error.to_string()))?;
        let references = extract_prompt_artifact_path_references(&document.body)
            .map_err(|error| DashboardError::Prompt(error.to_string()))?;
        let ancestor_artifact_references =
            extract_prompt_ancestor_artifact_references(&document.body)
                .map_err(|error| DashboardError::Prompt(error.to_string()))?;
        let ancestor_ids = concrete_ancestor_ids(graph, &node.id);
        let ancestor_required_artifacts =
            ancestor_required_artifacts_by_logical_id_for_dashboard(graph, &node.id);
        let mut output_refs = Vec::new();
        let mut previous_refs = Vec::new();

        for reference in references {
            match reference.producer {
                PromptArtifactPathProducer::Current => {
                    let Some(relative_path) = reference.path else {
                        continue;
                    };
                    output_refs.push(self.artifact_preview(
                        &logical_node_id_for_dashboard(node),
                        &node.id,
                        Some(&relative_path),
                        artifact_dir.join(&relative_path),
                    )?);
                }
                PromptArtifactPathProducer::LogicalNode(logical_id) => {
                    let logical_id = NodeId::from(logical_id);
                    for ancestor in graph.nodes.iter().filter(|candidate| {
                        ancestor_ids.contains(&candidate.id)
                            && logical_node_id_for_dashboard(candidate) == logical_id
                    }) {
                        let ancestor_dir = self.artifact_dir(ancestor)?;
                        let path = reference
                            .path
                            .as_ref()
                            .map(|relative| ancestor_dir.join(relative))
                            .unwrap_or_else(|| ancestor_dir.clone());
                        previous_refs.push(self.artifact_preview(
                            &logical_id,
                            &ancestor.id,
                            reference.path.as_deref(),
                            path,
                        )?);
                    }
                }
                PromptArtifactPathProducer::Handoff(logical_id) => {
                    let logical_id = NodeId::from(logical_id);
                    for ancestor in graph.nodes.iter().filter(|candidate| {
                        ancestor_ids.contains(&candidate.id)
                            && logical_node_id_for_dashboard(candidate) == logical_id
                    }) {
                        let NodeKind::Agentic {
                            primary_artifact: Some(primary_artifact),
                            ..
                        } = &ancestor.kind
                        else {
                            continue;
                        };
                        let ancestor_dir = self.artifact_dir(ancestor)?;
                        previous_refs.push(self.artifact_preview(
                            &logical_id,
                            &ancestor.id,
                            Some(primary_artifact),
                            ancestor_dir.join(primary_artifact),
                        )?);
                    }
                }
            }
        }

        for reference in ancestor_artifact_references {
            let producers = match reference.selector {
                PromptAncestorArtifactsSelector::DirectDependencies => {
                    direct_dependency_logical_ids_for_dashboard(graph, node)
                }
                PromptAncestorArtifactsSelector::Producers(producers) => {
                    producers.into_iter().map(NodeId::from).collect()
                }
            };
            for logical_id in producers {
                let required_artifacts = ancestor_required_artifacts
                    .get(&logical_id)
                    .cloned()
                    .unwrap_or_default();
                for ancestor in graph.nodes.iter().filter(|candidate| {
                    ancestor_ids.contains(&candidate.id)
                        && logical_node_id_for_dashboard(candidate) == logical_id
                }) {
                    let ancestor_dir = self.artifact_dir(ancestor)?;
                    for relative_path in &required_artifacts {
                        previous_refs.push(self.artifact_preview(
                            &logical_id,
                            &ancestor.id,
                            Some(relative_path),
                            ancestor_dir.join(relative_path),
                        )?);
                    }
                }
            }
        }

        Ok(PromptArtifactReferences {
            outputs: output_refs,
            referenced_previous: previous_refs,
        })
    }

    fn artifact_preview(
        &self,
        logical_node_id: &NodeId,
        concrete_node_id: &NodeId,
        relative_path: Option<&Path>,
        path: PathBuf,
    ) -> Result<PromptArtifactPreview, DashboardError> {
        let relative_artifact_path = relative_path.map(|path| path.display().to_string());
        let display_path = relative_to_run(&self.run_root, &path);
        if !path.exists() {
            return Ok(PromptArtifactPreview {
                logical_node_id: logical_node_id.to_string(),
                concrete_node_id: concrete_node_id.to_string(),
                relative_path: relative_artifact_path,
                path: display_path,
                state: "missing".to_owned(),
                content: None,
            });
        }
        ensure_no_symlink_components(&path)?;
        if path.is_dir() {
            return Ok(PromptArtifactPreview {
                logical_node_id: logical_node_id.to_string(),
                concrete_node_id: concrete_node_id.to_string(),
                relative_path: relative_artifact_path,
                path: display_path,
                state: "directory".to_owned(),
                content: None,
            });
        }

        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let content = match extension {
            "md" | "markdown" => Some(ArtifactPreviewContent {
                kind: "markdown".to_owned(),
                text: Some(fs::read_to_string(&path)?),
                json: None,
            }),
            "json" => Some(ArtifactPreviewContent {
                kind: "json".to_owned(),
                text: None,
                json: Some(read_json_required(&path)?),
            }),
            "txt" | "log" | "diff" | "toml" | "yaml" | "yml" | "sol" => {
                Some(ArtifactPreviewContent {
                    kind: "text".to_owned(),
                    text: Some(fs::read_to_string(&path)?),
                    json: None,
                })
            }
            _ => None,
        };

        Ok(PromptArtifactPreview {
            logical_node_id: logical_node_id.to_string(),
            concrete_node_id: concrete_node_id.to_string(),
            relative_path: relative_artifact_path,
            path: display_path,
            state: if content.is_some() {
                "available".to_owned()
            } else {
                "unsupported".to_owned()
            },
            content,
        })
    }

    fn run_overview(&self) -> Result<RunOverview, DashboardError> {
        let metadata = self.run_metadata()?;
        let graph = self.graph()?;
        let state = self.optional_state()?;
        let events = self.events()?;
        let findings = self.findings()?;
        let nodes = self.node_summaries()?;
        let mut node_counts = BTreeMap::new();
        let mut active_nodes = Vec::new();
        for node in &nodes {
            *node_counts.entry(node.status.clone()).or_insert(0) += 1;
            if node.status == "running" || node.status == "ready" {
                active_nodes.push(node.id.clone());
            }
        }
        let (status, source_run_id, started_at, finished_at, elapsed_seconds) =
            if let Some(state) = &state {
                (
                    serde_label(&state.status),
                    state.source_run_id.as_ref().map(ToString::to_string),
                    state.started_at.clone(),
                    state.finished_at.clone(),
                    elapsed_seconds(state),
                )
            } else {
                ("unknown".to_owned(), None, None, None, None)
            };

        Ok(RunOverview {
            schema_version: "1.0".to_owned(),
            run_id: self.run_id.to_string(),
            run_root: self.run_root.display().to_string(),
            runs_dir: self.runs_dir.display().to_string(),
            status,
            source_run_id,
            started_at,
            finished_at,
            elapsed_seconds,
            graph_nodes: graph.nodes.len(),
            node_counts,
            active_nodes,
            findings_count: findings.findings.len(),
            event_count: events.events.len(),
            live_updates: self.live_updates,
            mode: self.run_mode().to_owned(),
            restart_eligible: state
                .as_ref()
                .map(|state| state.finished_at.is_some())
                .unwrap_or(false),
            report_path: report_md_path(&self.run_root)
                .exists()
                .then(|| report_md_path(&self.run_root).display().to_string()),
            health: state
                .as_ref()
                .map(|state| summarize_run_health(&self.run_root, &self.runs_dir, &graph, state)),
            run_metadata: metadata,
        })
    }

    fn findings(&self) -> Result<FindingsData, DashboardError> {
        let candidates = [
            self.run_root
                .join("artifacts/severity-classification")
                .join(SEVERITY_CLASSIFIED_FINDINGS_FILE),
            self.run_root
                .join("artifacts/triage")
                .join(TRIAGED_FINDINGS_FILE),
            self.run_root
                .join("artifacts/dedupe-findings")
                .join(DEDUPED_FINDINGS_FILE),
        ];

        for path in candidates {
            if path.exists() {
                let findings = read_json_array(&path)?;
                return Ok(FindingsData {
                    source: relative_to_run(&self.run_root, &path),
                    findings,
                });
            }
        }

        let report_json = report_json_path(&self.run_root);
        if report_json.exists() {
            let value: Value = read_json_required(&report_json)?;
            let findings = value
                .get("findings")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            return Ok(FindingsData {
                source: relative_to_run(&self.run_root, &report_json),
                findings,
            });
        }

        Ok(FindingsData {
            source: "none".to_owned(),
            findings: Vec::new(),
        })
    }

    fn report(&self) -> Result<ReportData, DashboardError> {
        let markdown_path = report_md_path(&self.run_root);
        let json_path = report_json_path(&self.run_root);
        Ok(ReportData {
            markdown_path: markdown_path
                .exists()
                .then(|| relative_to_run(&self.run_root, &markdown_path)),
            markdown: read_text_optional(markdown_path)?,
            json_path: json_path
                .exists()
                .then(|| relative_to_run(&self.run_root, &json_path)),
            json: read_json_optional(json_path)?,
        })
    }

    fn events(&self) -> Result<EventsData, DashboardError> {
        let sqlite_path = self.run_root.join("events.sqlite");
        let jsonl_path = self.run_root.join("events.jsonl");

        if sqlite_path.exists() {
            ensure_no_symlink_components(&sqlite_path)?;
            match replay_sqlite_report(&sqlite_path) {
                Ok(replay) if !replay.is_empty() || !jsonl_path.exists() => {
                    return Ok(EventsData {
                        source: relative_to_run(&self.run_root, &sqlite_path),
                        events: replay.records,
                        malformed_records: replay.malformed_records,
                        truncated_records: replay.truncated_records,
                    });
                }
                Ok(_) => {}
                Err(error) if !jsonl_path.exists() => {
                    return Err(DashboardError::Events(error.to_string()));
                }
                Err(_) => {}
            }
        }

        if jsonl_path.exists() {
            ensure_no_symlink_components(&jsonl_path)?;
            return replay_jsonl_report(&jsonl_path)
                .map(|replay| EventsData {
                    source: relative_to_run(&self.run_root, &jsonl_path),
                    events: replay.records,
                    malformed_records: replay.malformed_records,
                    truncated_records: replay.truncated_records,
                })
                .map_err(|error| DashboardError::Events(error.to_string()));
        }

        Ok(EventsData {
            source: "none".to_owned(),
            events: Vec::new(),
            malformed_records: 0,
            truncated_records: 0,
        })
    }

    fn flow(&self) -> Result<FlowData, DashboardError> {
        let graph = self.display_graph()?;
        let state = self.optional_state()?;
        let strategies = self.strategy_map()?;
        let models = self.model_map()?;
        let run = self.run_overview()?;
        let layers = graph_layers(&graph);
        let mut layer_offsets: BTreeMap<usize, usize> = BTreeMap::new();
        let mut nodes = Vec::with_capacity(graph.nodes.len());
        for node in &graph.nodes {
            let layer = *layers.get(&node.id).unwrap_or(&0);
            let offset = layer_offsets.entry(layer).or_default();
            let position = FlowPosition {
                x: (layer as f64) * 310.0,
                y: (*offset as f64) * 136.0,
            };
            *offset += 1;

            let summary = summarize_node(node, state.as_ref(), &strategies, &models);
            let metadata = topology_node_metadata(node);
            let visual_group = visual_group_for_node(node, &graph.groups);
            let node_state = state.as_ref().and_then(|state| state.nodes.get(&node.id));
            let artifact_dir = self.artifact_dir(node)?;
            let findings = node_findings(&artifact_dir)?;
            let property_summary = node_property_summary(&node.kind, &artifact_dir)?;
            let artifacts = artifact_availability(&artifact_dir);
            let prompt_available = node_prompt_available(node);
            let prompt_editable = prompt_available && self.prompts_editable();
            nodes.push(FlowNode {
                id: summary.id.clone(),
                node_type: flow_node_type(&node.kind),
                position,
                data: FlowNodeData {
                    label: summary.label,
                    kind: summary.kind,
                    status: summary.status,
                    strategy: summary.strategy,
                    model: summary.model,
                    model_index: summary.model_index,
                    loop_index: summary.loop_index,
                    dependencies: summary.depends_on,
                    artifact_dir: summary.artifact_dir,
                    artifacts,
                    prompt_available,
                    prompt_editable,
                    topology_connectable: topology_connectable_node(node),
                    finding_count: findings.len(),
                    property_summary,
                    latest_error: node_state.and_then(|state| state.last_error.clone()),
                    logical_node_id: metadata.logical_node_id,
                    attempt_index: metadata.attempt_index,
                    loop_count: metadata.loop_count,
                    loop_badge_count: metadata.loop_count,
                    loop_mode: metadata.loop_mode,
                    prompt_path: metadata.prompt_path,
                    group: visual_group.id,
                    group_label: visual_group.label,
                    group_color: visual_group.color,
                    required_artifacts: metadata.required_artifacts,
                    timeout_seconds: timeout_seconds_for_node(node),
                },
            });
        }

        let mut edges = Vec::new();
        for node in &graph.nodes {
            let target_status = state
                .as_ref()
                .and_then(|state| state.nodes.get(&node.id))
                .map(|node| serde_label(&node.status))
                .unwrap_or_else(|| "unknown".to_owned());
            for dependency in &node.depends_on {
                let source = dependency.to_string();
                let target = node.id.to_string();
                edges.push(FlowEdge {
                    id: format!("{source}->{target}"),
                    source,
                    target,
                    animated: target_status == "running" || target_status == "ready",
                    data: FlowEdgeData {
                        status: target_status.clone(),
                    },
                    style: edge_style(&target_status),
                });
            }
        }

        Ok(FlowData {
            run,
            nodes,
            edges,
            strategies: strategies.into_values().collect(),
            capabilities: self.command_capabilities(),
        })
    }

    fn prompt_summaries(&self) -> Result<Vec<StrategyPromptSummary>, DashboardError> {
        let registry = load_prompt_registry(&self.project_root)?;
        let editable = self.prompts_editable();
        let mut prompts = registry
            .templates()
            .map(|prompt| {
                let content = prompt_markdown(&self.project_root, prompt)?;
                Ok(StrategyPromptSummary {
                    strategy_id: prompt.strategy_id.to_string(),
                    prompt_id: prompt.id.to_string(),
                    display_name: prompt.display_name.clone(),
                    category: prompt.category.to_string(),
                    source: prompt_source_label(&prompt.source),
                    path: prompt_path_label(&self.project_root, prompt),
                    editable,
                    content_hash: hex_sha256(content.as_bytes()),
                })
            })
            .collect::<Result<Vec<_>, DashboardError>>()?;
        prompts.sort_by(|left, right| left.strategy_id.cmp(&right.strategy_id));
        Ok(prompts)
    }

    fn prompt_detail(&self, strategy_id: &str) -> Result<StrategyPromptDetail, DashboardError> {
        validate_strategy_id(strategy_id)?;
        let registry = load_prompt_registry(&self.project_root)?;
        let prompt = registry
            .templates()
            .find(|prompt| prompt.strategy_id.as_str() == strategy_id)
            .ok_or_else(|| DashboardError::NotFound(format!("strategy prompt `{strategy_id}`")))?;
        let content = prompt_markdown(&self.project_root, prompt)?;
        Ok(StrategyPromptDetail {
            summary: StrategyPromptSummary {
                strategy_id: prompt.strategy_id.to_string(),
                prompt_id: prompt.id.to_string(),
                display_name: prompt.display_name.clone(),
                category: prompt.category.to_string(),
                source: prompt_source_label(&prompt.source),
                path: prompt_path_label(&self.project_root, prompt),
                editable: self.prompts_editable(),
                content_hash: hex_sha256(content.as_bytes()),
            },
            content,
        })
    }

    fn save_prompt(
        &self,
        strategy_id: &str,
        content: String,
    ) -> Result<SavePromptResponse, DashboardError> {
        validate_strategy_id(strategy_id)?;
        if !self.prompts_editable() {
            return Err(DashboardError::Prompt(
                "prompt editing is unavailable in preview mode until a project config exists"
                    .to_owned(),
            ));
        }
        let path = self.project_prompt_path(strategy_id)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let document = parse_prompt_document(&content)
            .map_err(|error| DashboardError::Prompt(error.to_string()))?;
        validate_supported_template_variables(&document.body)
            .map_err(|error| DashboardError::Prompt(error.to_string()))?;

        let old_content = read_text_optional(&path)?;
        atomic_write(&path, &content)?;
        let validation = match load_prompt_registry(&self.project_root) {
            Ok(registry) => {
                let found = registry
                    .templates()
                    .find(|prompt| prompt.strategy_id.as_str() == strategy_id);
                if let Some(prompt) = found {
                    match &prompt.source {
                        PromptSource::Project(source_path) => {
                            let source_path =
                                ensure_prompt_source_path(&self.project_root, source_path)?;
                            if source_path == path {
                                Ok(StrategyPromptValidation {
                                    valid: true,
                                    message: format!("loaded strategy `{}`", prompt.strategy_id),
                                })
                            } else {
                                Err(DashboardError::Prompt(format!(
                                    "saved prompt for strategy `{strategy_id}` resolved to `{}` instead of `{}`",
                                    path_label(&self.project_root, &source_path),
                                    path_label(&self.project_root, &path)
                                )))
                            }
                        }
                        PromptSource::BuiltIn => Err(DashboardError::Prompt(format!(
                            "saved prompt did not define strategy `{strategy_id}`"
                        ))),
                    }
                } else {
                    Err(DashboardError::Prompt(format!(
                        "saved prompt did not define strategy `{strategy_id}`"
                    )))
                }
            }
            Err(error) => Err(DashboardError::Prompt(error.to_string())),
        };

        let validation = match validation {
            Ok(validation) => validation,
            Err(error) => {
                restore_prompt_file(&path, old_content)?;
                return Err(error);
            }
        };

        append_audit(
            &self.project_root,
            json!({
                "kind": "prompt-edit",
                "strategy_id": strategy_id,
                "path": path_label(&self.project_root, &path),
                "content_hash": hex_sha256(content.as_bytes()),
                "timestamp_unix_seconds": unix_seconds(),
            }),
        )?;

        Ok(SavePromptResponse {
            strategy_id: strategy_id.to_owned(),
            path: path_label(&self.project_root, &path),
            content_hash: hex_sha256(content.as_bytes()),
            validation,
        })
    }

    fn node_prompt_detail(&self, node_id: &str) -> Result<NodePromptDetail, DashboardError> {
        validate_node_id(node_id)?;
        let node = self
            .graph()?
            .nodes
            .into_iter()
            .find(|node| graph_node_matches_prompt_id(node, node_id))
            .ok_or_else(|| DashboardError::NotFound(format!("node prompt `{node_id}`")))?;
        if !node_prompt_available(&node) {
            return Err(DashboardError::NotFound(format!("node prompt `{node_id}`")));
        }
        if let Some(strategy_id) = strategy_id_for_node(&node) {
            let strategy_prompt = self.prompt_detail(&strategy_id)?;
            return Ok(NodePromptDetail {
                summary: NodePromptSummary {
                    node_id: node_id.to_owned(),
                    prompt_id: strategy_prompt.summary.prompt_id,
                    display_name: strategy_prompt.summary.display_name,
                    source: strategy_prompt.summary.source,
                    path: strategy_prompt.summary.path,
                    editable: strategy_prompt.summary.editable,
                    content_hash: strategy_prompt.summary.content_hash,
                    strategy_id: Some(strategy_id),
                },
                content: strategy_prompt.content,
            });
        }

        let prompt_identity = prompt_identity_for_node(&node);
        let path = self.project_prompt_path_for_graph_node(&node)?;
        let content = if path.exists() {
            fs::read_to_string(&path)?
        } else {
            default_node_prompt_markdown(&node)
        };
        let display_name = node_prompt_content_display_name(&prompt_identity, &content)
            .unwrap_or_else(|| node.label.clone());
        Ok(NodePromptDetail {
            summary: NodePromptSummary {
                node_id: node_id.to_owned(),
                prompt_id: prompt_identity,
                display_name,
                source: if path.exists() {
                    "project-node-prompt".to_owned()
                } else {
                    "default-node-prompt".to_owned()
                },
                path: path_label(&self.project_root, &path),
                editable: self.prompts_editable(),
                content_hash: hex_sha256(content.as_bytes()),
                strategy_id: None,
            },
            content,
        })
    }

    fn save_node_prompt(
        &self,
        node_id: &str,
        content: String,
    ) -> Result<SaveNodePromptResponse, DashboardError> {
        validate_node_id(node_id)?;
        let node = self
            .graph()?
            .nodes
            .into_iter()
            .find(|node| graph_node_matches_prompt_id(node, node_id))
            .ok_or_else(|| DashboardError::NotFound(format!("node prompt `{node_id}`")))?;
        if !node_prompt_available(&node) {
            return Err(DashboardError::NotFound(format!("node prompt `{node_id}`")));
        }
        if let Some(strategy_id) = strategy_id_for_node(&node) {
            let saved = self.save_prompt(&strategy_id, content)?;
            return Ok(SaveNodePromptResponse {
                node_id: node_id.to_owned(),
                strategy_id: Some(strategy_id),
                path: saved.path,
                content_hash: saved.content_hash,
                renamed_from: None,
                validation: saved.validation,
            });
        }
        if !self.prompts_editable() {
            return Err(DashboardError::Prompt(
                "prompt editing is unavailable in preview mode until a project config exists"
                    .to_owned(),
            ));
        }

        let prompt_identity = prompt_identity_for_node(&node);
        let document = parse_node_prompt_document(&content)?;
        let next_prompt_identity = document
            .frontmatter
            .id
            .as_deref()
            .unwrap_or(&prompt_identity);
        if next_prompt_identity != prompt_identity {
            return self.rename_node_prompt(
                node_id,
                &prompt_identity,
                next_prompt_identity,
                content,
            );
        }

        let path = self.project_prompt_path_for_graph_node(&node)?;
        if let Some(prompt_dir) = path.parent() {
            fs::create_dir_all(prompt_dir)?;
        }
        let (topology_path, old_topology_content, mut topology) =
            read_project_topology_for_edit(&self.project_root)?;
        sync_topology_required_artifacts_from_prompt(
            &mut topology,
            &NodeId::from(prompt_identity.as_str()),
            &document.body,
        )?;
        let next_topology_content = serde_yaml::to_string(&topology).map_err(|error| {
            DashboardError::BadRequest(format!("failed to serialize topology: {error}"))
        })?;
        let old_content = read_text_optional(&path)?;
        let write_result = (|| {
            atomic_write(&path, &content)?;
            atomic_write(&topology_path, &next_topology_content)?;
            create_missing_topology_prompts(&self.project_root, &topology)?;
            validate_project_topology(
                &self.project_root,
                &topology,
                TopologyValidationOptions {
                    require_prompt_files: true,
                },
            )
            .map_err(|error| DashboardError::BadRequest(error.to_string()))?;
            self.current_preview()?;
            append_audit(
                &self.project_root,
                json!({
                    "kind": "node-prompt-edit",
                    "node_id": node_id,
                    "path": path_label(&self.project_root, &path),
                    "topology_path": path_label(&self.project_root, &topology_path),
                    "required_artifacts": topology
                        .nodes
                        .iter()
                        .find(|node| node.id == NodeId::from(prompt_identity.as_str()))
                        .map(|node| node.required_artifacts.iter().map(|path| path.display().to_string()).collect::<Vec<_>>())
                        .unwrap_or_default(),
                    "content_hash": hex_sha256(content.as_bytes()),
                    "timestamp_unix_seconds": unix_seconds(),
                }),
            )?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = restore_prompt_file(&path, old_content);
            let _ = atomic_write(&topology_path, &old_topology_content);
            return Err(error);
        }

        Ok(SaveNodePromptResponse {
            node_id: node_id.to_owned(),
            strategy_id: None,
            path: path_label(&self.project_root, &path),
            content_hash: hex_sha256(content.as_bytes()),
            renamed_from: None,
            validation: StrategyPromptValidation {
                valid: true,
                message: "saved node prompt".to_owned(),
            },
        })
    }

    fn rename_node_prompt(
        &self,
        requested_node_id: &str,
        old_id: &str,
        new_id: &str,
        content: String,
    ) -> Result<SaveNodePromptResponse, DashboardError> {
        validate_node_id(new_id)?;
        let old_node_id = NodeId::from(old_id);
        let new_node_id = NodeId::from(new_id);
        let (topology_path, old_topology_content, mut topology) =
            read_project_topology_for_edit(&self.project_root)?;
        let topology_node_index = topology
            .nodes
            .iter()
            .position(|node| node.id == old_node_id)
            .ok_or_else(|| DashboardError::NotFound(format!("topology node `{old_id}`")))?;
        if topology
            .nodes
            .iter()
            .any(|node| node.id == new_node_id && node.id != old_node_id)
        {
            return Err(DashboardError::BadRequest(format!(
                "topology node `{new_id}` already exists"
            )));
        }

        let old_relative_prompt_path = topology.nodes[topology_node_index]
            .prompt
            .clone()
            .unwrap_or_else(|| default_prompt_path_for_node(&topology.nodes[topology_node_index]));
        let old_default_prompt_path =
            default_prompt_path_for_node(&topology.nodes[topology_node_index]);
        let mut new_default_node = topology.nodes[topology_node_index].clone();
        new_default_node.id = new_node_id.clone();
        let new_default_prompt_path = default_prompt_path_for_node(&new_default_node);
        let uses_default_prompt_path = old_relative_prompt_path == old_default_prompt_path;
        if uses_default_prompt_path {
            topology.nodes[topology_node_index].prompt = topology.nodes[topology_node_index]
                .prompt
                .as_ref()
                .map(|_| new_default_prompt_path.clone());
        }
        topology.nodes[topology_node_index].id = new_node_id.clone();
        for node in &mut topology.nodes {
            for dependency in &mut node.depends_on {
                if dependency == &old_node_id {
                    *dependency = new_node_id.clone();
                }
            }
        }
        let document = parse_node_prompt_document(&content)?;
        sync_topology_required_artifacts_from_prompt(&mut topology, &new_node_id, &document.body)?;

        let prompt_root = absolute_path(
            &self
                .project_root
                .join(ultrafuzz_topology::PROJECT_PROMPT_DIR),
        );
        ensure_no_symlink_components(&prompt_root)?;
        fs::create_dir_all(&prompt_root)?;
        ensure_no_symlink_components(&prompt_root)?;
        let old_prompt_path =
            project_topology_prompt_path(&self.project_root, &old_relative_prompt_path)?;
        let new_relative_prompt_path = if uses_default_prompt_path {
            new_default_prompt_path
        } else {
            old_relative_prompt_path.clone()
        };
        let new_prompt_path =
            project_topology_prompt_path(&self.project_root, &new_relative_prompt_path)?;
        let moving_prompt_file = old_prompt_path != new_prompt_path;
        if moving_prompt_file && new_prompt_path.exists() {
            return Err(DashboardError::BadRequest(format!(
                "prompt path `{}` already exists",
                path_label(&self.project_root, &new_prompt_path)
            )));
        }

        let old_prompt_content = read_text_optional(&old_prompt_path)?;
        let prompt_reference_rewrites = rewrite_project_prompt_artifact_references_for_rename(
            &self.project_root,
            &topology,
            old_id,
            new_id,
            &[old_prompt_path.as_path(), new_prompt_path.as_path()],
        )?;
        if let Err(error) = validate_project_topology(
            &self.project_root,
            &topology,
            TopologyValidationOptions {
                require_prompt_files: false,
            },
        )
        .map_err(|error| DashboardError::BadRequest(error.to_string()))
        {
            restore_prompt_file_rewrites(&prompt_reference_rewrites);
            return Err(error);
        }

        let prompt_write_result = (|| {
            atomic_write(&old_prompt_path, &content)?;
            if moving_prompt_file {
                if let Some(parent) = new_prompt_path.parent() {
                    fs::create_dir_all(parent)?;
                    ensure_no_symlink_components(parent)?;
                }
                fs::rename(&old_prompt_path, &new_prompt_path)?;
            }
            Ok(())
        })();
        if let Err(error) = prompt_write_result {
            restore_prompt_file_rewrites(&prompt_reference_rewrites);
            let _ = restore_prompt_file(&old_prompt_path, old_prompt_content.clone());
            return Err(error);
        }

        let next_topology_content = serde_yaml::to_string(&topology).map_err(|error| {
            DashboardError::BadRequest(format!("failed to serialize topology: {error}"))
        })?;
        let write_result = (|| {
            atomic_write(&topology_path, &next_topology_content)?;
            create_missing_topology_prompts(&self.project_root, &topology)?;
            validate_project_topology(
                &self.project_root,
                &topology,
                TopologyValidationOptions {
                    require_prompt_files: true,
                },
            )
            .map_err(|error| DashboardError::BadRequest(error.to_string()))?;
            self.current_preview()?;
            append_audit(
                &self.project_root,
                json!({
                    "kind": "node-prompt-rename",
                    "old_id": old_id,
                    "new_id": new_id,
                    "topology_path": path_label(&self.project_root, &topology_path),
                    "prompt_path": path_label(&self.project_root, &new_prompt_path),
                    "content_hash": hex_sha256(content.as_bytes()),
                    "timestamp_unix_seconds": unix_seconds(),
                }),
            )?;
            Ok(())
        })();
        if let Err(error) = write_result {
            restore_prompt_file_rewrites(&prompt_reference_rewrites);
            rollback_node_prompt_rename(
                &topology_path,
                old_topology_content,
                &old_prompt_path,
                old_prompt_content,
                &new_prompt_path,
                moving_prompt_file,
            );
            return Err(error);
        }

        Ok(SaveNodePromptResponse {
            node_id: remapped_node_id(requested_node_id, old_id, new_id),
            strategy_id: None,
            path: path_label(&self.project_root, &new_prompt_path),
            content_hash: hex_sha256(content.as_bytes()),
            renamed_from: Some(old_id.to_owned()),
            validation: StrategyPromptValidation {
                valid: true,
                message: "saved and renamed prompt".to_owned(),
            },
        })
    }

    fn create_node_prompt(
        &self,
        request: CreateNodePromptRequest,
    ) -> Result<SaveNodePromptResponse, DashboardError> {
        if !self.prompts_editable() {
            return Err(DashboardError::Prompt(
                "prompt editing is unavailable in preview mode until a project config exists"
                    .to_owned(),
            ));
        }
        let document = parse_node_prompt_document(&request.content)?;
        let node_id = document.frontmatter.id.as_deref().ok_or_else(|| {
            DashboardError::Prompt("new prompt Markdown frontmatter must define `id`".to_owned())
        })?;
        validate_node_id(node_id)?;
        let node_id = NodeId::from(node_id);
        let group = request.group.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        });
        if let Some(group_id) = &group {
            validate_node_id(group_id)?;
        }
        let mut depends_on = request
            .depends_on
            .into_iter()
            .map(|dependency| {
                validate_node_id(&dependency)?;
                Ok(NodeId::from(dependency))
            })
            .collect::<Result<Vec<_>, DashboardError>>()?;
        if depends_on.is_empty() {
            depends_on.push(NodeId::from(ultrafuzz_topology::START_NODE_ID));
        }

        let (topology_path, old_topology_content, mut topology) =
            read_project_topology_for_edit(&self.project_root)?;
        if topology.nodes.iter().any(|node| node.id == node_id) {
            return Err(DashboardError::BadRequest(format!(
                "topology node `{node_id}` already exists"
            )));
        }
        let required_artifacts = prompt_artifact_output_paths(&document.body)
            .map_err(|error| DashboardError::Prompt(error.to_string()))?;
        topology.nodes.push(TopologyNode {
            id: node_id.clone(),
            kind: TopologyNodeKind::Agentic,
            role: None,
            prompt: None,
            reference: None,
            group,
            depends_on,
            loops: 1,
            loop_mode: ultrafuzz_topology::LoopMode::Parallel,
            timeout_seconds: None,
            primary_artifact: required_artifacts.first().cloned(),
            required_artifacts,
        });
        normalize_dashboard_meta_wiring(&mut topology);
        validate_project_topology(
            &self.project_root,
            &topology,
            TopologyValidationOptions {
                require_prompt_files: false,
            },
        )
        .map_err(|error| DashboardError::BadRequest(error.to_string()))?;

        let relative_prompt_path = topology
            .nodes
            .last()
            .map(default_prompt_path_for_node)
            .expect("new topology node was just pushed");
        let prompt_path = project_topology_prompt_path(&self.project_root, &relative_prompt_path)?;
        if prompt_path.exists() {
            return Err(DashboardError::BadRequest(format!(
                "prompt path `{}` already exists",
                path_label(&self.project_root, &prompt_path)
            )));
        }
        atomic_write(&prompt_path, &request.content)?;

        let next_topology_content = serde_yaml::to_string(&topology).map_err(|error| {
            DashboardError::BadRequest(format!("failed to serialize topology: {error}"))
        })?;
        let write_result = (|| {
            atomic_write(&topology_path, &next_topology_content)?;
            create_missing_topology_prompts(&self.project_root, &topology)?;
            validate_project_topology(
                &self.project_root,
                &topology,
                TopologyValidationOptions {
                    require_prompt_files: true,
                },
            )
            .map_err(|error| DashboardError::BadRequest(error.to_string()))?;
            self.current_preview()?;
            append_audit(
                &self.project_root,
                json!({
                    "kind": "node-prompt-create",
                    "node_id": node_id.to_string(),
                    "topology_path": path_label(&self.project_root, &topology_path),
                    "prompt_path": path_label(&self.project_root, &prompt_path),
                    "content_hash": hex_sha256(request.content.as_bytes()),
                    "timestamp_unix_seconds": unix_seconds(),
                }),
            )?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = atomic_write(&topology_path, &old_topology_content);
            let _ = restore_prompt_file(&prompt_path, None);
            return Err(error);
        }

        Ok(SaveNodePromptResponse {
            node_id: node_id.to_string(),
            strategy_id: None,
            path: path_label(&self.project_root, &prompt_path),
            content_hash: hex_sha256(request.content.as_bytes()),
            renamed_from: None,
            validation: StrategyPromptValidation {
                valid: true,
                message: "created prompt".to_owned(),
            },
        })
    }

    fn project_prompt_path(&self, strategy_id: &str) -> Result<PathBuf, DashboardError> {
        let prompt_root = absolute_path(&project_prompt_dir(&self.project_root));
        let registry = load_prompt_registry(&self.project_root)?;
        if let Some(prompt) = registry
            .templates()
            .find(|prompt| prompt.strategy_id.as_str() == strategy_id)
        {
            if let PromptSource::Project(path) = &prompt.source {
                let path = ensure_prompt_source_path(&self.project_root, path)?;
                return Ok(path);
            }
        }

        ensure_no_symlink_components(&prompt_root)?;
        let file_name = BuiltInStrategy::from_id(strategy_id)
            .map(|strategy| strategy.prompt_file_name().to_owned())
            .unwrap_or_else(|| format!("{strategy_id}.md"));
        let path = prompt_root.join("strategies").join(file_name);
        ensure_path_inside(&prompt_root, &path)?;
        Ok(path)
    }

    fn project_node_prompt_path(&self, node_id: &str) -> Result<PathBuf, DashboardError> {
        project_node_prompt_path_for(&self.project_root, node_id)
    }

    fn project_prompt_path_for_graph_node(&self, node: &Node) -> Result<PathBuf, DashboardError> {
        match &node.kind {
            NodeKind::Agentic { prompt_path, .. } => {
                let prompt_root = absolute_path(
                    &self
                        .project_root
                        .join(ultrafuzz_topology::PROJECT_PROMPT_DIR),
                );
                ensure_no_symlink_components(&prompt_root)?;
                let path = prompt_root.join(prompt_path);
                ensure_path_inside(&prompt_root, &absolute_path(&path))?;
                Ok(path)
            }
            _ => self.project_node_prompt_path(node.id.as_str()),
        }
    }

    fn artifact_dir(&self, node: &Node) -> Result<PathBuf, DashboardError> {
        validate_artifact_dir(&node.artifact_dir)?;
        let path = self.run_root.join(&node.artifact_dir);
        ensure_no_symlink_components(&path)?;
        Ok(path)
    }

    fn start_command_job(
        &self,
        command: &'static str,
        request: CommandRequest,
    ) -> Result<CommandJob, DashboardError> {
        if !self.command_capabilities().allows(command) {
            return Err(DashboardError::Command(format!(
                "command `{command}` is unavailable for {} dashboard data",
                self.run_mode()
            )));
        }
        let args = build_command_args(command, &self.run_id, request)?;
        let job_id = new_job_id(command);
        let now = unix_seconds();
        let job = CommandJob {
            job_id: job_id.clone(),
            command: command.to_owned(),
            status: "queued".to_owned(),
            started_at_unix_seconds: now,
            finished_at_unix_seconds: None,
            argv: display_argv(&args),
            output: String::new(),
            error: None,
            exit_code: None,
        };
        let mut jobs = self
            .command_jobs
            .lock()
            .map_err(|_| DashboardError::Command("command job registry is poisoned".to_owned()))?;
        jobs.insert(job_id.clone(), job.clone());
        prune_command_jobs(&mut jobs);
        drop(jobs);

        append_audit(
            &self.project_root,
            json!({
                "kind": "command-job",
                "job_id": job_id,
                "command": command,
                "argv": display_argv(&args),
                "timestamp_unix_seconds": now,
            }),
        )?;

        let jobs = Arc::clone(&self.command_jobs);
        let project_root = self.project_root.clone();
        thread::spawn(move || {
            update_job(&jobs, &job_id, |job| {
                job.status = "running".to_owned();
            });
            let executable = std::env::current_exe();
            let output = executable.and_then(|executable| {
                ProcessCommand::new(executable)
                    .args(&args)
                    .current_dir(project_root)
                    .output()
            });
            match output {
                Ok(output) => {
                    let mut text = String::new();
                    text.push_str(&String::from_utf8_lossy(&output.stdout));
                    text.push_str(&String::from_utf8_lossy(&output.stderr));
                    update_job(&jobs, &job_id, |job| {
                        job.status = if output.status.success() {
                            "succeeded".to_owned()
                        } else {
                            "failed".to_owned()
                        };
                        job.finished_at_unix_seconds = Some(unix_seconds());
                        job.exit_code = output.status.code();
                        job.output = truncate_command_output(text);
                    });
                }
                Err(error) => update_job(&jobs, &job_id, |job| {
                    job.status = "failed".to_owned();
                    job.finished_at_unix_seconds = Some(unix_seconds());
                    job.error = Some(error.to_string());
                }),
            }
        });

        Ok(job)
    }

    fn command_job(&self, job_id: &str) -> Result<CommandJob, DashboardError> {
        self.command_jobs
            .lock()
            .map_err(|_| DashboardError::Command("command job registry is poisoned".to_owned()))?
            .get(job_id)
            .cloned()
            .ok_or_else(|| DashboardError::NotFound(format!("command job `{job_id}`")))
    }

    fn command_jobs(&self) -> Result<Vec<CommandJob>, DashboardError> {
        let mut jobs: Vec<_> = self
            .command_jobs
            .lock()
            .map_err(|_| DashboardError::Command("command job registry is poisoned".to_owned()))?
            .values()
            .cloned()
            .collect();
        jobs.sort_by(|left, right| {
            right
                .started_at_unix_seconds
                .cmp(&left.started_at_unix_seconds)
                .then_with(|| right.job_id.cmp(&left.job_id))
        });
        Ok(jobs)
    }

    fn config_detail(&self) -> Result<ConfigDetail, DashboardError> {
        let path = self.project_root.join(ultrafuzz_config::CONFIG_FILE_NAME);
        let content = if path.exists() {
            fs::read_to_string(&path)?
        } else {
            ultrafuzz_config::default_config_toml().to_owned()
        };
        Ok(ConfigDetail {
            source: if path.exists() {
                "project-config".to_owned()
            } else {
                "default-config".to_owned()
            },
            path: path_label(&self.project_root, &path),
            editable: true,
            content_hash: hex_sha256(content.as_bytes()),
            content,
        })
    }

    fn save_config(&self, content: String) -> Result<SaveConfigResponse, DashboardError> {
        validate_config_toml(&self.project_root, &content)?;
        let path = self.project_root.join(ultrafuzz_config::CONFIG_FILE_NAME);
        ensure_no_symlink_components(&path)?;
        ensure_path_inside(&self.project_root, &absolute_path(&path))?;

        let old_content = read_text_optional(&path)?;
        atomic_write(&path, &content)?;
        let validation = validate_config_toml(&self.project_root, &content);
        let validation = match validation {
            Ok(()) => StrategyPromptValidation {
                valid: true,
                message: "loaded project config".to_owned(),
            },
            Err(error) => {
                restore_prompt_file(&path, old_content)?;
                return Err(error);
            }
        };

        if self.prompts_editable() {
            match self.graph() {
                Ok(graph) => scaffold_project_node_prompts(&self.project_root, &graph)?,
                Err(error) => {
                    restore_prompt_file(&path, old_content)?;
                    return Err(error);
                }
            }
        }

        append_audit(
            &self.project_root,
            json!({
                "kind": "config-edit",
                "path": path_label(&self.project_root, &path),
                "content_hash": hex_sha256(content.as_bytes()),
                "timestamp_unix_seconds": unix_seconds(),
            }),
        )?;

        Ok(SaveConfigResponse {
            path: path_label(&self.project_root, &path),
            content_hash: hex_sha256(content.as_bytes()),
            validation,
        })
    }

    fn topology_detail(&self) -> Result<TopologyDetail, DashboardError> {
        let path = self
            .project_root
            .join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE);
        if !path.exists() && self.prompts_editable() {
            return Err(DashboardError::BadRequest(format!(
                "missing topology file: {}",
                path.display()
            )));
        }
        ensure_no_symlink_components(&path)?;
        let content = fs::read_to_string(&path).map_err(|error| {
            DashboardError::BadRequest(format!(
                "failed to read topology `{}`: {error}",
                path.display()
            ))
        })?;
        let topology = serde_yaml::from_str::<ProjectTopology>(&content).map_err(|error| {
            DashboardError::BadRequest(format!("invalid topology YAML: {error}"))
        })?;
        let validation = topology_validation(&self.project_root, &topology, true);
        Ok(TopologyDetail {
            path: path_label(&self.project_root, &path),
            editable: self.prompts_editable(),
            content_hash: hex_sha256(content.as_bytes()),
            content,
            topology,
            validation,
        })
    }

    fn save_topology(
        &self,
        request: SaveTopologyRequest,
    ) -> Result<SaveTopologyResponse, DashboardError> {
        if !self.prompts_editable() {
            return Err(DashboardError::BadRequest(
                "topology editing is unavailable in preview mode until a project config exists"
                    .to_owned(),
            ));
        }

        let (mut topology, normalize_meta_wiring) = match (request.topology, request.content) {
            (Some(topology), _) => (topology, true),
            (None, Some(content)) => {
                let topology =
                    serde_yaml::from_str::<ProjectTopology>(&content).map_err(|error| {
                        DashboardError::BadRequest(format!("invalid topology YAML: {error}"))
                    })?;
                (topology, false)
            }
            (None, None) => {
                return Err(DashboardError::BadRequest(
                    "topology save request must include `topology` or `content`".to_owned(),
                ))
            }
        };
        if normalize_meta_wiring {
            normalize_dashboard_meta_wiring(&mut topology);
        }
        validate_project_topology(
            &self.project_root,
            &topology,
            TopologyValidationOptions {
                require_prompt_files: false,
            },
        )
        .map_err(|error| DashboardError::BadRequest(error.to_string()))?;
        create_missing_topology_prompts(&self.project_root, &topology)?;
        validate_project_topology(
            &self.project_root,
            &topology,
            TopologyValidationOptions {
                require_prompt_files: true,
            },
        )
        .map_err(|error| DashboardError::BadRequest(error.to_string()))?;

        let content = serde_yaml::to_string(&topology).map_err(|error| {
            DashboardError::BadRequest(format!("failed to serialize topology: {error}"))
        })?;
        let path = self
            .project_root
            .join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
            ensure_no_symlink_components(parent)?;
        }
        ensure_no_symlink_components(&path)?;
        let old_content = read_text_optional(&path)?;
        atomic_write(&path, &content)?;
        if let Err(error) = self.current_preview() {
            restore_prompt_file(&path, old_content)?;
            return Err(error);
        }

        Ok(SaveTopologyResponse {
            path: path_label(&self.project_root, &path),
            content_hash: hex_sha256(content.as_bytes()),
            validation: StrategyPromptValidation {
                valid: true,
                message: format!("saved topology with {} logical nodes", topology.nodes.len()),
            },
        })
    }

    fn run_mode(&self) -> &'static str {
        match &self.source {
            DashboardRunSource::Persisted => "persisted",
            DashboardRunSource::Preview => "preview",
        }
    }

    fn prompts_editable(&self) -> bool {
        match &self.source {
            DashboardRunSource::Persisted => true,
            DashboardRunSource::Preview => self.project_config_exists(),
        }
    }

    fn command_capabilities(&self) -> CommandCapabilities {
        match &self.source {
            DashboardRunSource::Persisted => CommandCapabilities::default(),
            DashboardRunSource::Preview => {
                CommandCapabilities::preview(self.project_config_exists())
            }
        }
    }

    fn current_preview(&self) -> Result<DashboardPreview, DashboardError> {
        build_preview(&self.project_root, self.run_id.clone())
    }

    fn project_config_exists(&self) -> bool {
        self.project_root
            .join(ultrafuzz_config::CONFIG_FILE_NAME)
            .exists()
    }
}

fn build_preview(project_root: &Path, run_id: RunId) -> Result<DashboardPreview, DashboardError> {
    let project_config_exists = project_root
        .join(ultrafuzz_config::CONFIG_FILE_NAME)
        .exists();
    let config = load_preview_config(project_root, project_config_exists)?;
    let graph = build_campaign_graph_from_project(run_id.clone(), project_root, &config).map_err(
        |error| {
            DashboardError::BadRequest(format!("failed to build dashboard preview graph: {error}"))
        },
    )?;
    let state = RunState::from_graph(
        run_id.clone(),
        &graph,
        "preview".to_owned(),
        "preview".to_owned(),
        None,
    );
    let metadata = run_metadata_from_config(&run_id, &graph, &config, true);

    Ok(DashboardPreview {
        graph,
        state,
        metadata,
    })
}

fn load_preview_config(
    project_root: &Path,
    project_config_exists: bool,
) -> Result<CampaignConfig, DashboardError> {
    let registry = load_prompt_registry(project_root)?;
    let env_overrides = EnvOverrides::from_env().map_err(preview_config_error)?;
    let cli_overrides = CliOverrides::default();
    let result = if project_config_exists {
        ultrafuzz_config::load_resolved_config(
            project_root,
            registry.strategy_definitions(),
            env_overrides,
            cli_overrides,
        )
    } else {
        ultrafuzz_config::resolve_config_from_toml(
            None,
            registry.strategy_definitions(),
            env_overrides,
            cli_overrides,
        )
    };
    let config = result.map_err(preview_config_error)?;
    config
        .validate_project_paths(project_root)
        .map_err(preview_config_error)?;
    Ok(config)
}

fn preview_config_error(error: impl std::fmt::Display) -> DashboardError {
    DashboardError::BadRequest(format!("invalid dashboard preview config: {error}"))
}

fn run_metadata_from_config(
    run_id: &RunId,
    graph: &CampaignGraph,
    config: &CampaignConfig,
    preview: bool,
) -> Value {
    let effective_strategy_loops = effective_strategy_loop_counts(graph);
    let effective_strategy_timeouts = effective_strategy_timeouts(graph);
    json!({
        "run_id": run_id,
        "graph_nodes": graph.nodes.len(),
        "synthetic_execution": preview,
        "preview": preview,
        "default_timeout_seconds": config.run.default_timeout_seconds,
        "node_timeouts": node_timeout_metadata(graph),
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
                strategy_run_metadata(config, strategy, loops, timeout_seconds)
            })
            .collect::<Vec<_>>()
    })
}

fn node_timeout_metadata(graph: &CampaignGraph) -> Vec<Value> {
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

fn effective_strategy_loop_counts(graph: &CampaignGraph) -> BTreeMap<String, usize> {
    let mut loops = BTreeMap::new();
    for node in &graph.nodes {
        if let NodeKind::Agentic {
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
        if let NodeKind::Agentic { logical_id, .. } = &node.kind {
            if let Some(timeout) = node.timeout {
                timeouts
                    .entry(logical_id.to_string())
                    .or_insert_with(|| timeout.as_secs());
            }
        }
    }
    timeouts
}

fn strategy_run_metadata(
    config: &CampaignConfig,
    strategy: &ultrafuzz_core::StrategyDefinition,
    loops: usize,
    timeout_seconds: u64,
) -> Value {
    let models = config.effective_strategy_models(strategy);
    let mut value = json!({
        "models": models
            .iter()
            .map(|model_id| model_id.to_string())
            .collect::<Vec<_>>(),
        "attempts": loops * models.len(),
        "id": strategy.id.to_string(),
        "display_name": strategy.display_name.clone(),
        "category": strategy.category,
        "source": strategy.source,
        "loops": loops,
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

pub fn app(config: DashboardServerConfig) -> Result<Router, DashboardError> {
    let state = DashboardAppState::new(config)?;
    Ok(router_for_state(state))
}

pub async fn serve(config: DashboardServerConfig) -> anyhow::Result<DashboardHandle> {
    let host = config.host.clone();
    let port = config.port;
    let state = DashboardAppState::new(config)?;
    let listener = TcpListener::bind(format!("{host}:{port}")).await?;
    let bind_addr = listener.local_addr()?.to_string();
    let run_url = format!("http://{bind_addr}/dashboard");
    let handle = DashboardHandle {
        bind_addr,
        run_id: state.run_id.clone(),
        run_url,
        run_root: state.run_root.clone(),
    };
    println!(
        "Ultrafuzz Dashboard listening at {} (run_id: {}, run_dir: {}).",
        handle.run_url,
        handle.run_id,
        handle.run_root.display()
    );
    axum::serve(listener, router_for_state(state)).await?;
    Ok(handle)
}

pub fn serve_blocking(config: DashboardServerConfig) -> anyhow::Result<DashboardHandle> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(serve(config))
}

fn router_for_state(state: DashboardAppState) -> Router {
    let api_routes = Router::new()
        .route("/api/session", get(api_session))
        .route("/api/flow", get(api_flow))
        .route("/api/config", get(api_config).put(api_save_config))
        .route("/api/topology", get(api_topology).put(api_save_topology))
        .route("/api/run", get(api_run))
        .route("/api/graph", get(api_graph))
        .route("/api/nodes", get(api_nodes))
        .route("/api/nodes/{node_id}", get(api_node))
        .route("/api/findings", get(api_findings))
        .route("/api/report", get(api_report))
        .route("/api/events", get(api_events))
        .route("/api/events/stream", get(api_event_stream))
        .route("/api/prompts/strategies", get(api_prompts))
        .route(
            "/api/prompts/strategies/{strategy_id}",
            get(api_prompt).put(api_save_prompt),
        )
        .route("/api/prompts/nodes", post(api_create_node_prompt))
        .route(
            "/api/prompts/nodes/{node_id}",
            get(api_node_prompt).put(api_save_node_prompt),
        )
        .route("/api/commands/list", command_route("list"))
        .route("/api/commands/run", command_route("run"))
        .route("/api/commands/restart", command_route("restart"))
        .route("/api/commands/continue", command_route("continue"))
        .route("/api/commands/status", command_route("status"))
        .route("/api/commands/doctor", command_route("doctor"))
        .route("/api/commands/config", command_route("config"))
        .route("/api/commands/report", command_route("report"))
        .route("/api/commands/triage", command_route("triage"))
        .route("/api/commands/merge", command_route("merge"))
        .route("/api/commands/materialize", command_route("materialize"))
        .route("/api/commands/clean", command_route("clean"))
        .route("/api/commands/{job_id}", get(api_command_job))
        .route("/api/commands/stream", get(api_command_stream))
        .route_layer(from_fn(require_local_dashboard_request_middleware));

    Router::new()
        .route("/", get(|| async { Redirect::to("/dashboard") }))
        .route("/dashboard", get(dashboard_index))
        .route("/dashboard/{*path}", get(dashboard_asset))
        .route("/run", get(run_page))
        .route("/graph", get(graph_page))
        .route("/nodes", get(nodes_page))
        .route("/nodes/{node_id}", get(node_page))
        .route("/findings", get(findings_page))
        .route("/report", get(report_page))
        .route("/events", get(events_page))
        .merge(api_routes)
        .with_state(state)
}

async fn require_local_dashboard_request_middleware(
    headers: HeaderMap,
    request: AxumRequest,
    next: Next,
) -> Result<Response, DashboardError> {
    require_local_dashboard_request(&headers)?;
    Ok(next.run(request).await)
}

async fn dashboard_index() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        DASHBOARD_INDEX,
    )
        .into_response()
}

async fn dashboard_asset(RoutePath(path): RoutePath<String>) -> Response {
    match path.as_str() {
        "" | "index.html" => dashboard_index().await,
        "assets/dashboard.js" => (
            [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
            DASHBOARD_JS,
        )
            .into_response(),
        "assets/index.css" => (
            [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
            DASHBOARD_CSS,
        )
            .into_response(),
        _ => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("dashboard asset `{path}` not found") })),
        )
            .into_response(),
    }
}

async fn api_session(
    headers: HeaderMap,
    State(state): State<DashboardAppState>,
) -> Result<Json<DashboardSession>, DashboardError> {
    require_local_dashboard_request(&headers)?;
    Ok(Json(DashboardSession {
        run_id: state.run_id.to_string(),
        live_updates: state.live_updates,
        session_token: state.session_token.expose(),
        template_variables: SUPPORTED_TEMPLATE_VARIABLES
            .into_iter()
            .map(str::to_owned)
            .collect(),
    }))
}

async fn api_flow(
    State(state): State<DashboardAppState>,
) -> Result<Json<FlowData>, DashboardError> {
    state.flow().map(Json)
}

async fn api_config(
    State(state): State<DashboardAppState>,
) -> Result<Json<ConfigDetail>, DashboardError> {
    state.config_detail().map(Json)
}

async fn api_save_config(
    headers: HeaderMap,
    State(state): State<DashboardAppState>,
    Json(request): Json<SavePromptRequest>,
) -> Result<Json<SaveConfigResponse>, DashboardError> {
    require_session_token(&headers, &state)?;
    state.save_config(request.content).map(Json)
}

async fn api_topology(
    State(state): State<DashboardAppState>,
) -> Result<Json<TopologyDetail>, DashboardError> {
    state.topology_detail().map(Json)
}

async fn api_save_topology(
    headers: HeaderMap,
    State(state): State<DashboardAppState>,
    Json(request): Json<SaveTopologyRequest>,
) -> Result<Json<SaveTopologyResponse>, DashboardError> {
    require_session_token(&headers, &state)?;
    state.save_topology(request).map(Json)
}

async fn api_run(
    State(state): State<DashboardAppState>,
) -> Result<Json<RunOverview>, DashboardError> {
    state.run_overview().map(Json)
}

async fn api_graph(
    State(state): State<DashboardAppState>,
) -> Result<Json<GraphData>, DashboardError> {
    let graph = state.display_graph()?;
    let run_state = state.optional_state()?;
    let strategies = state.strategy_map()?;
    let models = state.model_map()?;
    let nodes = summarize_nodes(&graph, run_state.as_ref(), &strategies, &models);
    Ok(Json(GraphData {
        run_id: state.run_id.to_string(),
        graph,
        nodes,
    }))
}

async fn api_nodes(
    State(state): State<DashboardAppState>,
) -> Result<Json<Vec<NodeSummary>>, DashboardError> {
    state.node_summaries().map(Json)
}

async fn api_node(
    State(state): State<DashboardAppState>,
    RoutePath(node_id): RoutePath<String>,
) -> Result<Json<NodeDetail>, DashboardError> {
    state.node_detail(&node_id).map(Json)
}

async fn api_findings(
    State(state): State<DashboardAppState>,
) -> Result<Json<FindingsData>, DashboardError> {
    state.findings().map(Json)
}

async fn api_report(
    State(state): State<DashboardAppState>,
) -> Result<Json<ReportData>, DashboardError> {
    state.report().map(Json)
}

async fn api_events(
    State(state): State<DashboardAppState>,
) -> Result<Json<EventsData>, DashboardError> {
    state.events().map(Json)
}

type EventStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

async fn api_event_stream(
    headers: HeaderMap,
    State(state): State<DashboardAppState>,
) -> Result<Response, DashboardError> {
    require_local_dashboard_request(&headers)?;
    if !state.live_updates {
        return Err(DashboardError::LiveUpdatesDisabled);
    }

    let (initial_seen, initial_pending) = initial_event_stream_state(&state);
    let stream = futures_util::stream::unfold(
        (state, initial_seen, initial_pending),
        |(state, mut seen, mut pending)| async move {
            loop {
                if let Some(event) = pending.pop_front() {
                    let payload = serde_json::to_string(&event)
                        .unwrap_or_else(|_| "{\"error\":\"failed to serialize event\"}".to_owned());
                    return Some((
                        Ok(Event::default().event("ultrafuzz-event").data(payload)),
                        (state, seen, pending),
                    ));
                }

                match state.events() {
                    Ok(data) if seen < data.events.len() => {
                        let next_seen = data.events.len();
                        pending.extend(data.events.into_iter().skip(seen));
                        seen = next_seen;
                    }
                    Ok(_) => {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    Err(error) => {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        return Some((
                            Ok(Event::default()
                                .event("ultrafuzz-error")
                                .data(error.to_string())),
                            (state, seen, pending),
                        ));
                    }
                }
            }
        },
    );

    Ok(Sse::new(Box::pin(stream) as EventStream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

fn initial_event_stream_state(state: &DashboardAppState) -> (usize, VecDeque<EventRecord>) {
    state
        .events()
        .map(|data| {
            let seen = data.events.len();
            let pending = data.events.last().cloned().into_iter().collect();
            (seen, pending)
        })
        .unwrap_or_else(|_| (0, VecDeque::new()))
}

async fn api_prompts(
    State(state): State<DashboardAppState>,
) -> Result<Json<Vec<StrategyPromptSummary>>, DashboardError> {
    state.prompt_summaries().map(Json)
}

async fn api_prompt(
    State(state): State<DashboardAppState>,
    RoutePath(strategy_id): RoutePath<String>,
) -> Result<Json<StrategyPromptDetail>, DashboardError> {
    state.prompt_detail(&strategy_id).map(Json)
}

async fn api_save_prompt(
    headers: HeaderMap,
    State(state): State<DashboardAppState>,
    RoutePath(strategy_id): RoutePath<String>,
    Json(request): Json<SavePromptRequest>,
) -> Result<Json<SavePromptResponse>, DashboardError> {
    require_session_token(&headers, &state)?;
    state.save_prompt(&strategy_id, request.content).map(Json)
}

async fn api_node_prompt(
    State(state): State<DashboardAppState>,
    RoutePath(node_id): RoutePath<String>,
) -> Result<Json<NodePromptDetail>, DashboardError> {
    state.node_prompt_detail(&node_id).map(Json)
}

async fn api_save_node_prompt(
    headers: HeaderMap,
    State(state): State<DashboardAppState>,
    RoutePath(node_id): RoutePath<String>,
    Json(request): Json<SavePromptRequest>,
) -> Result<Json<SaveNodePromptResponse>, DashboardError> {
    require_session_token(&headers, &state)?;
    state.save_node_prompt(&node_id, request.content).map(Json)
}

async fn api_create_node_prompt(
    headers: HeaderMap,
    State(state): State<DashboardAppState>,
    Json(request): Json<CreateNodePromptRequest>,
) -> Result<Json<SaveNodePromptResponse>, DashboardError> {
    require_session_token(&headers, &state)?;
    state.create_node_prompt(request).map(Json)
}

fn command_route(command: &'static str) -> MethodRouter<DashboardAppState> {
    post(
        move |headers: HeaderMap,
              State(state): State<DashboardAppState>,
              Json(request): Json<CommandRequest>| {
            api_command_start(command, headers, state, request)
        },
    )
}

async fn api_command_start(
    command: &'static str,
    headers: HeaderMap,
    state: DashboardAppState,
    request: CommandRequest,
) -> Result<Json<CommandJob>, DashboardError> {
    require_session_token(&headers, &state)?;
    state.start_command_job(command, request).map(Json)
}

async fn api_command_job(
    State(state): State<DashboardAppState>,
    RoutePath(job_id): RoutePath<String>,
) -> Result<Json<CommandJob>, DashboardError> {
    state.command_job(&job_id).map(Json)
}

async fn api_command_stream(
    headers: HeaderMap,
    State(state): State<DashboardAppState>,
) -> Result<Response, DashboardError> {
    require_local_dashboard_request(&headers)?;
    let stream = futures_util::stream::unfold(state, |state| async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let payload = match state.command_jobs() {
            Ok(jobs) => serde_json::to_string(&jobs)
                .unwrap_or_else(|_| "{\"error\":\"failed to serialize command jobs\"}".to_owned()),
            Err(error) => error.to_string(),
        };
        Some((
            Ok(Event::default()
                .event("ultrafuzz-command-jobs")
                .data(payload)),
            state,
        ))
    });

    Ok(Sse::new(Box::pin(stream) as EventStream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

async fn run_page(State(state): State<DashboardAppState>) -> Result<Html<String>, DashboardError> {
    let overview = state.run_overview()?;
    let strategies = strategy_rows(
        overview
            .run_metadata
            .get("strategies")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    );
    let mut body = String::new();
    body.push_str("<section><h2>Run Status</h2>");
    body.push_str("<table><tbody>");
    row(&mut body, "Run ID", &overview.run_id);
    row(&mut body, "Status", &overview.status);
    row(&mut body, "Run directory", &overview.run_root);
    row(
        &mut body,
        "Elapsed",
        &overview
            .elapsed_seconds
            .map(format_seconds)
            .unwrap_or_else(|| "unknown".to_owned()),
    );
    row(&mut body, "Findings", &overview.findings_count.to_string());
    row_raw(
        &mut body,
        "Events",
        &format!("<span data-live-events>{}</span>", overview.event_count),
    );
    row(
        &mut body,
        "Restart eligible",
        if overview.restart_eligible {
            "yes"
        } else {
            "not yet"
        },
    );
    if let Some(health) = &overview.health {
        row(&mut body, "Health", &health.stale.status);
        row(
            &mut body,
            "Process liveness",
            &health.process_liveness.status,
        );
        row(
            &mut body,
            "stdout freshness",
            &health.stdout_freshness.status,
        );
        row(
            &mut body,
            "stderr freshness",
            &health.stderr_freshness.status,
        );
        row(&mut body, "Timeout", &health.timeout.status);
        row(
            &mut body,
            "Required artifacts",
            &format!(
                "{}/{} present ({})",
                health.artifacts.present_required,
                health.artifacts.total_required,
                health.artifacts.status
            ),
        );
        row(
            &mut body,
            "Restart reuse",
            if health.restart.available {
                "available"
            } else {
                "unavailable"
            },
        );
    }
    body.push_str("</tbody></table></section>");
    if let Some(health) = &overview.health {
        body.push_str("<section><h2>Restart Guidance</h2>");
        body.push_str(&format!("<p>{}</p>", escape_html(&health.restart.guidance)));
        body.push_str("</section>");
        body.push_str("<section><h2>Lineage</h2><table><tbody>");
        row(
            &mut body,
            "Source runs",
            &empty_dash(health.lineage.source_runs.join(", ")),
        );
        row(
            &mut body,
            "Reused work",
            &empty_dash(health.lineage.reused_nodes.join(", ")),
        );
        row(
            &mut body,
            "New work",
            &empty_dash(health.lineage.newly_executed_nodes.join(", ")),
        );
        row(
            &mut body,
            "Cumulative elapsed",
            &health
                .lineage
                .cumulative_elapsed_seconds
                .map(format_seconds)
                .unwrap_or_else(|| "unknown".to_owned()),
        );
        row(
            &mut body,
            "Final restart elapsed",
            &health
                .lineage
                .final_restart_elapsed_seconds
                .map(format_seconds)
                .unwrap_or_else(|| "not a restart".to_owned()),
        );
        row(
            &mut body,
            "Cumulative tokens",
            health
                .lineage
                .cumulative_tokens_used
                .as_deref()
                .unwrap_or("unavailable"),
        );
        row(
            &mut body,
            "Cumulative spend",
            health
                .lineage
                .cumulative_estimated_spend
                .as_deref()
                .unwrap_or("unavailable"),
        );
        body.push_str("</tbody></table></section>");
    }
    body.push_str("<section><h2>Node Counts</h2>");
    body.push_str(&count_table(&overview.node_counts));
    body.push_str("</section>");
    body.push_str("<section><h2>Active Nodes</h2>");
    if overview.active_nodes.is_empty() {
        body.push_str("<p>No active nodes.</p>");
    } else {
        body.push_str("<ul>");
        for node in overview.active_nodes {
            body.push_str(&format!(
                "<li><a href=\"/nodes/{}\">{}</a></li>",
                url_escape(&node),
                escape_html(&node)
            ));
        }
        body.push_str("</ul>");
    }
    body.push_str("</section>");
    body.push_str("<section><h2>Strategies</h2>");
    body.push_str(&strategies);
    body.push_str("</section>");
    Ok(Html(render_layout(&state, "Run", "run", &body)))
}

async fn graph_page(
    State(state): State<DashboardAppState>,
) -> Result<Html<String>, DashboardError> {
    let nodes = state.node_summaries()?;
    let mut edges = String::new();
    for node in &nodes {
        if node.depends_on.is_empty() {
            edges.push_str(&format!("{}\n", node.id));
        } else {
            for dependency in &node.depends_on {
                edges.push_str(&format!("{dependency} -> {}\n", node.id));
            }
        }
    }

    let mut body = String::new();
    body.push_str("<section><h2>Topology</h2><pre>");
    body.push_str(&escape_html(&edges));
    body.push_str("</pre></section>");
    body.push_str("<section><h2>Graph Nodes</h2>");
    body.push_str(&nodes_table(&nodes));
    body.push_str("</section>");
    Ok(Html(render_layout(&state, "Graph", "graph", &body)))
}

async fn nodes_page(
    State(state): State<DashboardAppState>,
) -> Result<Html<String>, DashboardError> {
    let nodes = state.node_summaries()?;
    let body = format!("<section><h2>Nodes</h2>{}</section>", nodes_table(&nodes));
    Ok(Html(render_layout(&state, "Nodes", "nodes", &body)))
}

async fn node_page(
    State(state): State<DashboardAppState>,
    RoutePath(node_id): RoutePath<String>,
) -> Result<Html<String>, DashboardError> {
    let detail = state.node_detail(&node_id)?;
    let mut body = String::new();
    body.push_str("<section><h2>Node</h2><table><tbody>");
    row(&mut body, "ID", &detail.node.id);
    row(&mut body, "Label", &detail.node.label);
    row(&mut body, "Kind", &detail.node.kind);
    row(&mut body, "Status", &detail.node.status);
    if let Some(strategy) = &detail.node.strategy {
        row(&mut body, "Strategy", &strategy.display_name);
        row(&mut body, "Category", &strategy.category);
        row(&mut body, "Source", &strategy.source);
    }
    row(
        &mut body,
        "Dependencies",
        &detail.node.depends_on.join(", "),
    );
    body.push_str("</tbody></table></section>");
    body.push_str("<section><h2>Artifacts</h2>");
    body.push_str(&artifacts_table(&detail.artifacts));
    body.push_str("</section>");
    body.push_str("<section><h2>Rendered Prompt</h2>");
    body.push_str(&pre_optional(&detail.rendered_prompt));
    body.push_str("</section>");
    body.push_str("<section><h2>Logs</h2><h3>stdout</h3>");
    body.push_str(&pre_optional(&detail.stdout));
    body.push_str("<h3>stderr</h3>");
    body.push_str(&pre_optional(&detail.stderr));
    body.push_str("</section>");
    body.push_str("<section><h2>Findings</h2><pre>");
    body.push_str(&escape_html(&serde_json::to_string_pretty(
        &detail.findings,
    )?));
    body.push_str("</pre></section>");
    if let Some(metadata) = &detail.metadata {
        body.push_str("<section><h2>Metadata</h2><pre>");
        body.push_str(&escape_html(&serde_json::to_string_pretty(metadata)?));
        body.push_str("</pre></section>");
    }
    Ok(Html(render_layout(&state, &detail.node.id, "nodes", &body)))
}

async fn findings_page(
    State(state): State<DashboardAppState>,
) -> Result<Html<String>, DashboardError> {
    let data = state.findings()?;
    let mut body = String::new();
    body.push_str("<section><h2>Findings</h2>");
    body.push_str(&format!(
        "<p>Source: <code>{}</code></p>",
        escape_html(&data.source)
    ));
    body.push_str(&findings_table(&data.findings));
    body.push_str("</section>");
    Ok(Html(render_layout(&state, "Findings", "findings", &body)))
}

async fn report_page(
    State(state): State<DashboardAppState>,
) -> Result<Html<String>, DashboardError> {
    let report = state.report()?;
    let mut body = String::new();
    body.push_str("<section><h2>Report</h2>");
    if let Some(path) = &report.markdown_path {
        body.push_str(&format!(
            "<p>Markdown: <code>{}</code></p>",
            escape_html(path)
        ));
    }
    body.push_str(&pre_optional(&report.markdown));
    if let Some(json) = &report.json {
        body.push_str("<h2>Structured Report</h2><pre>");
        body.push_str(&escape_html(&serde_json::to_string_pretty(json)?));
        body.push_str("</pre>");
    }
    body.push_str("</section>");
    Ok(Html(render_layout(&state, "Report", "report", &body)))
}

async fn events_page(
    State(state): State<DashboardAppState>,
) -> Result<Html<String>, DashboardError> {
    let data = state.events()?;
    let mut body = String::new();
    body.push_str("<section><h2>Events</h2>");
    body.push_str(&format!(
        "<p>Source: <code>{}</code></p>",
        escape_html(&data.source)
    ));
    body.push_str(&events_table(&data.events));
    body.push_str("</section>");
    Ok(Html(render_layout(&state, "Events", "events", &body)))
}

#[derive(Clone, Debug, Serialize)]
pub struct RunOverview {
    pub schema_version: String,
    pub run_id: String,
    pub run_root: String,
    pub runs_dir: String,
    pub status: String,
    pub source_run_id: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub elapsed_seconds: Option<f64>,
    pub graph_nodes: usize,
    pub node_counts: BTreeMap<String, usize>,
    pub active_nodes: Vec<String>,
    pub findings_count: usize,
    pub event_count: usize,
    pub live_updates: bool,
    pub mode: String,
    pub restart_eligible: bool,
    pub report_path: Option<String>,
    pub health: Option<RunHealthSummary>,
    pub run_metadata: Value,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDetail {
    pub source: String,
    pub path: String,
    pub editable: bool,
    pub content_hash: String,
    pub content: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConfigResponse {
    pub path: String,
    pub content_hash: String,
    pub validation: StrategyPromptValidation,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyDetail {
    pub path: String,
    pub editable: bool,
    pub content_hash: String,
    pub content: String,
    pub topology: ProjectTopology,
    pub validation: StrategyPromptValidation,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTopologyRequest {
    pub content: Option<String>,
    pub topology: Option<ProjectTopology>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTopologyResponse {
    pub path: String,
    pub content_hash: String,
    pub validation: StrategyPromptValidation,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphData {
    pub run_id: String,
    pub graph: CampaignGraph,
    pub nodes: Vec<NodeSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct StrategySummary {
    pub id: String,
    pub display_name: String,
    pub category: String,
    pub source: String,
    pub models: Vec<String>,
    pub loops: usize,
    pub attempts: usize,
    pub timeout_seconds: Option<u64>,
    pub expected_cost: Option<String>,
    pub cost_note: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ModelSummary {
    pub id: String,
    pub backend: String,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NodeSummary {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub kind_detail: Value,
    pub status: String,
    pub depends_on: Vec<String>,
    pub artifact_dir: String,
    pub strategy: Option<StrategySummary>,
    pub model: Option<ModelSummary>,
    pub attempt_index: Option<usize>,
    pub model_index: Option<usize>,
    pub loop_index: Option<usize>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NodeDetail {
    pub run_id: String,
    pub node: NodeSummary,
    pub state: Option<NodeState>,
    pub artifacts: Vec<ArtifactEntry>,
    #[serde(rename = "artifactReferences")]
    pub artifact_references: PromptArtifactReferences,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub rendered_prompt: Option<String>,
    pub findings: Vec<Value>,
    pub metadata: Option<Value>,
    pub transcript: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptArtifactReferences {
    pub outputs: Vec<PromptArtifactPreview>,
    pub referenced_previous: Vec<PromptArtifactPreview>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptArtifactPreview {
    pub logical_node_id: String,
    pub concrete_node_id: String,
    pub relative_path: Option<String>,
    pub path: String,
    pub state: String,
    pub content: Option<ArtifactPreviewContent>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPreviewContent {
    pub kind: String,
    pub text: Option<String>,
    pub json: Option<Value>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ArtifactEntry {
    pub path: String,
    pub kind: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FindingsData {
    pub source: String,
    pub findings: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReportData {
    pub markdown_path: Option<String>,
    pub markdown: Option<String>,
    pub json_path: Option<String>,
    pub json: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct EventsData {
    pub source: String,
    pub events: Vec<EventRecord>,
    pub malformed_records: usize,
    pub truncated_records: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSession {
    pub run_id: String,
    pub live_updates: bool,
    pub session_token: String,
    pub template_variables: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowData {
    pub run: RunOverview,
    pub nodes: Vec<FlowNode>,
    pub edges: Vec<FlowEdge>,
    pub strategies: Vec<StrategySummary>,
    pub capabilities: CommandCapabilities,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub position: FlowPosition,
    pub data: FlowNodeData,
}

#[derive(Clone, Debug, Serialize)]
pub struct FlowPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNodeData {
    pub label: String,
    pub kind: String,
    pub status: String,
    pub strategy: Option<StrategySummary>,
    pub model: Option<ModelSummary>,
    pub model_index: Option<usize>,
    pub loop_index: Option<usize>,
    pub dependencies: Vec<String>,
    pub artifact_dir: String,
    pub artifacts: ArtifactAvailability,
    pub prompt_available: bool,
    pub prompt_editable: bool,
    pub topology_connectable: bool,
    pub finding_count: usize,
    pub property_summary: Option<PropertySummary>,
    pub latest_error: Option<String>,
    pub logical_node_id: String,
    pub attempt_index: usize,
    pub loop_count: usize,
    pub loop_badge_count: usize,
    pub loop_mode: String,
    pub prompt_path: String,
    pub group: Option<String>,
    pub group_label: Option<String>,
    pub group_color: Option<String>,
    pub required_artifacts: Vec<String>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertySummary {
    pub count: usize,
    pub kind: PropertySummaryKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PropertySummaryKind {
    Candidates,
    Properties,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactAvailability {
    pub logs: bool,
    pub rendered_prompt: bool,
    pub findings: bool,
    pub patch: bool,
    pub report: bool,
    pub metadata: bool,
    pub transcript: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub animated: bool,
    pub data: FlowEdgeData,
    pub style: FlowEdgeStyle,
}

#[derive(Clone, Debug, Serialize)]
pub struct FlowEdgeData {
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowEdgeStyle {
    pub stroke: String,
    pub stroke_width: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCapabilities {
    pub list_runs: bool,
    pub run_new_campaign: bool,
    pub restart_whole_run: bool,
    pub continue_run: bool,
    pub status: bool,
    pub doctor: bool,
    pub config: bool,
    pub report: bool,
    pub triage: bool,
    pub merge: bool,
    pub materialize: bool,
    pub clean: bool,
    pub restart_from_node: bool,
    pub rerun_selected_node: bool,
    pub arbitrary_shell: bool,
}

impl Default for CommandCapabilities {
    fn default() -> Self {
        Self {
            list_runs: true,
            run_new_campaign: true,
            restart_whole_run: true,
            continue_run: true,
            status: true,
            doctor: true,
            config: true,
            report: true,
            triage: true,
            merge: true,
            materialize: true,
            clean: true,
            restart_from_node: false,
            rerun_selected_node: false,
            arbitrary_shell: false,
        }
    }
}

impl CommandCapabilities {
    fn preview(project_config_exists: bool) -> Self {
        Self {
            list_runs: true,
            run_new_campaign: project_config_exists,
            restart_whole_run: false,
            continue_run: false,
            status: false,
            doctor: true,
            config: true,
            report: false,
            triage: false,
            merge: false,
            materialize: false,
            clean: false,
            restart_from_node: false,
            rerun_selected_node: false,
            arbitrary_shell: false,
        }
    }

    fn allows(&self, command: &str) -> bool {
        match command {
            "list" => self.list_runs,
            "run" => self.run_new_campaign,
            "restart" => self.restart_whole_run,
            "continue" => self.continue_run,
            "status" => self.status,
            "doctor" => self.doctor,
            "config" => self.config,
            "report" => self.report,
            "triage" => self.triage,
            "merge" => self.merge,
            "materialize" => self.materialize,
            "clean" => self.clean,
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyPromptSummary {
    pub strategy_id: String,
    pub prompt_id: String,
    pub display_name: String,
    pub category: String,
    pub source: String,
    pub path: String,
    pub editable: bool,
    pub content_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct StrategyPromptDetail {
    pub summary: StrategyPromptSummary,
    pub content: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePromptSummary {
    pub node_id: String,
    pub prompt_id: String,
    pub display_name: String,
    pub source: String,
    pub path: String,
    pub editable: bool,
    pub content_hash: String,
    pub strategy_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct NodePromptDetail {
    pub summary: NodePromptSummary,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SavePromptRequest {
    pub content: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNodePromptRequest {
    pub content: String,
    pub group: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePromptResponse {
    pub strategy_id: String,
    pub path: String,
    pub content_hash: String,
    pub validation: StrategyPromptValidation,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNodePromptResponse {
    pub node_id: String,
    pub strategy_id: Option<String>,
    pub path: String,
    pub content_hash: String,
    pub renamed_from: Option<String>,
    pub validation: StrategyPromptValidation,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct StrategyPromptValidation {
    pub valid: bool,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRequest {
    pub run_id: Option<String>,
    pub backend: Option<String>,
    pub max_parallel_agents: Option<usize>,
    pub config: Option<String>,
    pub json: Option<bool>,
    pub dry_run: Option<bool>,
    pub force: Option<bool>,
    pub confirmed: Option<bool>,
    #[serde(default)]
    pub patches: Vec<String>,
    #[serde(default)]
    pub copies: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandJob {
    pub job_id: String,
    pub command: String,
    pub status: String,
    pub started_at_unix_seconds: u64,
    pub finished_at_unix_seconds: Option<u64>,
    pub argv: Vec<String>,
    pub output: String,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Error)]
pub enum DashboardError {
    #[error("{0} not found")]
    NotFound(String),
    #[error("Dashboard live updates are disabled")]
    LiveUpdatesDisabled,
    #[error("dashboard host `{0}` is not loopback; use 127.0.0.1, ::1, or localhost")]
    NonLoopbackHost(String),
    #[error("missing or invalid dashboard session token")]
    Unauthorized,
    #[error("bad dashboard request: {0}")]
    BadRequest(String),
    #[error("invalid dashboard prompt operation: {0}")]
    Prompt(String),
    #[error("invalid dashboard command operation: {0}")]
    Command(String),
    #[error("failed to generate dashboard session token: {0}")]
    Entropy(String),
    #[error("Dashboard I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid Dashboard JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid run state: {0}")]
    State(String),
    #[error("invalid event store: {0}")]
    Events(String),
    #[error("invalid artifact data: {0}")]
    Artifact(String),
}

impl IntoResponse for DashboardError {
    fn into_response(self) -> Response {
        let status = match self {
            DashboardError::NotFound(_) => StatusCode::NOT_FOUND,
            DashboardError::LiveUpdatesDisabled => StatusCode::NOT_FOUND,
            DashboardError::Unauthorized => StatusCode::UNAUTHORIZED,
            DashboardError::NonLoopbackHost(_)
            | DashboardError::BadRequest(_)
            | DashboardError::Prompt(_)
            | DashboardError::Command(_) => StatusCode::BAD_REQUEST,
            DashboardError::Io(ref error) if error.kind() == std::io::ErrorKind::NotFound => {
                StatusCode::NOT_FOUND
            }
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({ "error": self.to_string() }))).into_response()
    }
}

fn summarize_nodes(
    graph: &CampaignGraph,
    state: Option<&RunState>,
    strategies: &BTreeMap<String, StrategySummary>,
    models: &BTreeMap<String, ModelSummary>,
) -> Vec<NodeSummary> {
    graph
        .nodes
        .iter()
        .map(|node| summarize_node(node, state, strategies, models))
        .collect()
}

fn summarize_node(
    node: &Node,
    state: Option<&RunState>,
    strategies: &BTreeMap<String, StrategySummary>,
    models: &BTreeMap<String, ModelSummary>,
) -> NodeSummary {
    let strategy_id = strategy_id_for_node(node);
    let strategy = strategy_id.as_ref().map(|id| {
        strategies
            .get(id)
            .cloned()
            .unwrap_or_else(|| StrategySummary {
                id: id.clone(),
                display_name: id.clone(),
                category: "unknown".to_owned(),
                source: "unknown".to_owned(),
                models: Vec::new(),
                loops: 1,
                attempts: 1,
                timeout_seconds: None,
                expected_cost: None,
                cost_note: None,
            })
    });
    let (model, attempt_index, model_index, loop_index) = match &node.kind {
        NodeKind::AgentAttempt {
            attempt_index,
            model_id,
            model_index,
            loop_index,
            ..
        } => (
            Some(
                models
                    .get(model_id.as_str())
                    .cloned()
                    .unwrap_or_else(|| ModelSummary {
                        id: model_id.to_string(),
                        backend: "unknown".to_owned(),
                        model: None,
                    }),
            ),
            Some(*attempt_index),
            Some(*model_index),
            Some(*loop_index),
        ),
        _ => (None, None, None, None),
    };
    NodeSummary {
        id: node.id.to_string(),
        label: node.label.clone(),
        kind: node_kind_label(&node.kind),
        kind_detail: serde_json::to_value(&node.kind).unwrap_or(Value::Null),
        status: state
            .and_then(|state| state.nodes.get(&node.id))
            .map(|node| serde_label(&node.status))
            .unwrap_or_else(|| "unknown".to_owned()),
        depends_on: node.depends_on.iter().map(ToString::to_string).collect(),
        artifact_dir: node.artifact_dir.display().to_string(),
        strategy,
        model,
        attempt_index,
        model_index,
        loop_index,
        timeout_seconds: timeout_seconds_for_node(node),
    }
}

fn timeout_seconds_for_node(node: &Node) -> Option<u64> {
    node.timeout.map(|timeout| timeout.as_secs())
}

struct TopologyNodeMetadata {
    logical_node_id: String,
    attempt_index: usize,
    loop_count: usize,
    loop_mode: String,
    prompt_path: String,
    required_artifacts: Vec<String>,
}

fn topology_node_metadata(node: &Node) -> TopologyNodeMetadata {
    match &node.kind {
        NodeKind::Meta { .. } => TopologyNodeMetadata {
            logical_node_id: node.id.to_string(),
            attempt_index: 0,
            loop_count: 1,
            loop_mode: "parallel".to_owned(),
            prompt_path: String::new(),
            required_artifacts: Vec::new(),
        },
        NodeKind::Agentic {
            logical_id,
            prompt_path,
            attempt_index,
            loop_count,
            loop_mode,
            group: _,
            required_artifacts,
            ..
        } => TopologyNodeMetadata {
            logical_node_id: logical_id.to_string(),
            attempt_index: *attempt_index,
            loop_count: *loop_count,
            loop_mode: loop_mode.as_str().to_owned(),
            prompt_path: prompt_path.display().to_string(),
            required_artifacts: required_artifacts
                .iter()
                .map(|path| path.display().to_string())
                .collect(),
        },
        NodeKind::Reference {
            required_artifacts, ..
        } => TopologyNodeMetadata {
            logical_node_id: node.id.to_string(),
            attempt_index: 0,
            loop_count: 1,
            loop_mode: "parallel".to_owned(),
            prompt_path: String::new(),
            required_artifacts: required_artifacts
                .iter()
                .map(|path| path.display().to_string())
                .collect(),
        },
        _ => TopologyNodeMetadata {
            logical_node_id: node.id.to_string(),
            attempt_index: 0,
            loop_count: 1,
            loop_mode: "parallel".to_owned(),
            prompt_path: default_prompt_path(&node.id).display().to_string(),
            required_artifacts: Vec::new(),
        },
    }
}

struct VisualGroup {
    id: Option<String>,
    label: Option<String>,
    color: Option<String>,
}

fn visual_group_for_node(
    node: &Node,
    groups: &BTreeMap<String, ultrafuzz_topology::TopologyGroup>,
) -> VisualGroup {
    let (group_id, prompt_path) = match &node.kind {
        NodeKind::Agentic {
            group, prompt_path, ..
        } => (group.clone(), Some(prompt_path.as_path())),
        NodeKind::Reference { group, .. } => (group.clone(), None),
        _ => (None, None),
    };
    let inferred = group_id.or_else(|| {
        prompt_path
            .and_then(|path| path.components().next())
            .and_then(|component| match component {
                std::path::Component::Normal(value) => value.to_str().map(str::to_owned),
                _ => None,
            })
    });
    let Some(id) = inferred else {
        return VisualGroup {
            id: None,
            label: None,
            color: None,
        };
    };
    let metadata = groups.get(&id);
    VisualGroup {
        label: metadata
            .and_then(|group| group.label.clone())
            .or_else(|| Some(title_case_label(&id))),
        color: metadata.and_then(|group| group.color.clone()),
        id: Some(id),
    }
}

fn title_case_label(value: &str) -> String {
    value
        .replace(['-', '_'], " ")
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn prompt_identity_for_node(node: &Node) -> String {
    match &node.kind {
        NodeKind::Agentic { logical_id, .. } => logical_id.to_string(),
        _ => node.id.to_string(),
    }
}

fn node_prompt_available(node: &Node) -> bool {
    !matches!(
        node.kind,
        NodeKind::Meta { .. } | NodeKind::AggregateTestFiles | NodeKind::Reference { .. }
    )
}

fn topology_connectable_node(node: &Node) -> bool {
    matches!(
        node.kind,
        NodeKind::Agentic { .. }
            | NodeKind::AggregateTestFiles
            | NodeKind::Reference { .. }
            | NodeKind::Meta { .. }
    )
}

fn logical_node_id_for_dashboard(node: &Node) -> NodeId {
    match &node.kind {
        NodeKind::Agentic { logical_id, .. } => logical_id.clone(),
        _ => node.id.clone(),
    }
}

fn concrete_ancestor_ids(graph: &CampaignGraph, node_id: &NodeId) -> BTreeSet<NodeId> {
    let node_by_id = graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let mut ancestors = BTreeSet::new();
    collect_concrete_ancestor_ids(node_id, &node_by_id, &mut ancestors);
    ancestors
}

fn direct_dependency_logical_ids_for_dashboard(graph: &CampaignGraph, node: &Node) -> Vec<NodeId> {
    let node_by_id = graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let node = direct_dependency_source_node_for_dashboard(graph, node);
    direct_dependency_logical_ids_for_dashboard_node(node, &node_by_id)
}

fn direct_dependency_source_node_for_dashboard<'a>(
    graph: &'a CampaignGraph,
    node: &'a Node,
) -> &'a Node {
    let NodeKind::Agentic {
        logical_id,
        attempt_index,
        loop_mode: LoopMode::Series,
        ..
    } = &node.kind
    else {
        return node;
    };
    if *attempt_index == 0 {
        return node;
    }
    graph
        .nodes
        .iter()
        .find(|candidate| {
            matches!(
                &candidate.kind,
                NodeKind::Agentic {
                    logical_id: candidate_logical_id,
                    attempt_index: 0,
                    ..
                } if candidate_logical_id == logical_id
            )
        })
        .unwrap_or(node)
}

fn direct_dependency_logical_ids_for_dashboard_node(
    node: &Node,
    node_by_id: &BTreeMap<NodeId, &Node>,
) -> Vec<NodeId> {
    let mut direct = Vec::new();
    let mut seen = BTreeSet::new();
    for dependency in &node.depends_on {
        let Some(dependency_node) = node_by_id.get(dependency) else {
            continue;
        };
        let logical_id = logical_node_id_for_dashboard(dependency_node);
        if seen.insert(logical_id.clone()) {
            direct.push(logical_id);
        }
    }
    direct
}

fn ancestor_required_artifacts_by_logical_id_for_dashboard(
    graph: &CampaignGraph,
    node_id: &NodeId,
) -> BTreeMap<NodeId, Vec<PathBuf>> {
    let ancestor_ids = concrete_ancestor_ids(graph, node_id);
    let mut artifacts = BTreeMap::<NodeId, Vec<PathBuf>>::new();
    for node in &graph.nodes {
        if ancestor_ids.contains(&node.id) {
            let required = required_artifacts_for_dashboard_node(node);
            let entry = artifacts
                .entry(logical_node_id_for_dashboard(node))
                .or_default();
            if entry.is_empty() && !required.is_empty() {
                *entry = required;
            }
        }
    }
    artifacts
}

fn required_artifacts_for_dashboard_node(node: &Node) -> Vec<PathBuf> {
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

fn collect_concrete_ancestor_ids(
    node_id: &NodeId,
    node_by_id: &BTreeMap<NodeId, &Node>,
    ancestors: &mut BTreeSet<NodeId>,
) {
    let Some(node) = node_by_id.get(node_id) else {
        return;
    };
    for dependency in &node.depends_on {
        if ancestors.insert(dependency.clone()) {
            collect_concrete_ancestor_ids(dependency, node_by_id, ancestors);
        }
    }
}

fn graph_node_matches_prompt_id(node: &Node, requested_id: &str) -> bool {
    node.id.as_str() == requested_id || prompt_identity_for_node(node) == requested_id
}

fn strategy_id_for_node(node: &Node) -> Option<String> {
    match &node.kind {
        NodeKind::AgentAttempt { strategy, .. } | NodeKind::ConsolidateStrategy { strategy } => {
            Some(strategy.to_string())
        }
        _ => None,
    }
}

fn node_kind_label(kind: &NodeKind) -> String {
    match kind {
        NodeKind::Meta { role } => match role {
            MetaNodeRole::Start => "start".to_owned(),
            MetaNodeRole::Finish => "finish".to_owned(),
        },
        NodeKind::Agentic { logical_id, .. } => logical_id.to_string(),
        NodeKind::Reference { .. } => "reference".to_owned(),
        NodeKind::ProjectDiscovery => "project-discovery".to_owned(),
        NodeKind::PrepareFoundryHarness => "prepare-foundry-harness".to_owned(),
        NodeKind::DiscoverBaseTest => "discover-base-test".to_owned(),
        NodeKind::PropertySpecificationLens { lens } => {
            format!("property-specification lens {}", lens.id())
        }
        NodeKind::PropertySpecificationFanIn => "property-specification-fanin".to_owned(),
        NodeKind::PropertySpecification => "property-specification".to_owned(),
        NodeKind::AgentAttempt {
            strategy,
            model_id,
            loop_index,
            ..
        } => format!("agent-attempt {strategy} {model_id} #{}", loop_index + 1),
        NodeKind::ConsolidateStrategy { strategy } => format!("consolidate {strategy}"),
        NodeKind::DedupeFindings => "dedupe-findings".to_owned(),
        NodeKind::TriageFindings => "triage".to_owned(),
        NodeKind::AggregateTestFiles => "aggregate-test-files".to_owned(),
    }
}

fn artifact_entries(
    artifact_dir: &Path,
    node_id: &NodeId,
) -> Result<Vec<ArtifactEntry>, DashboardError> {
    if !artifact_dir.exists() {
        return Ok(Vec::new());
    }
    ensure_no_symlink_components(artifact_dir)?;

    let manifest_path = artifact_dir.join(ARTIFACT_MANIFEST_FILE);
    let manifest = if manifest_path.exists() {
        ensure_no_symlink_components(&manifest_path)?;
        ArtifactManifest::read_from(&manifest_path)
    } else {
        ArtifactManifest::for_dir(node_id.clone(), artifact_dir)
    }
    .map_err(|error| DashboardError::Artifact(error.to_string()))?;

    Ok(manifest
        .files
        .into_iter()
        .map(|entry| ArtifactEntry {
            kind: artifact_kind(&entry.path).to_owned(),
            path: entry.path,
            size_bytes: entry.size_bytes,
            sha256: Some(entry.sha256),
        })
        .collect())
}

fn artifact_kind(path: &str) -> &'static str {
    match path {
        STDOUT_LOG | STDERR_LOG => "log",
        RENDERED_PROMPT => "prompt",
        FINDINGS_FILE
        | DEDUPED_FINDINGS_FILE
        | TRIAGED_FINDINGS_FILE
        | SEVERITY_CLASSIFIED_FINDINGS_FILE
        | FINDING_LIFECYCLE_LEDGER_FILE => "findings",
        "patch.diff" => "patch",
        "metadata.json" => "metadata",
        "transcript.json" => "transcript",
        REPORT_MD_FILE | REPORT_JSON_FILE => "report",
        _ => "artifact",
    }
}

fn node_findings(artifact_dir: &Path) -> Result<Vec<Value>, DashboardError> {
    for file_name in [
        SEVERITY_CLASSIFIED_FINDINGS_FILE,
        TRIAGED_FINDINGS_FILE,
        DEDUPED_FINDINGS_FILE,
        FINDINGS_FILE,
        "finding.json",
    ] {
        let path = artifact_dir.join(file_name);
        if path.exists() {
            let value: Value = read_json_required(&path)?;
            return Ok(match value {
                Value::Array(values) => values,
                Value::Object(_) => vec![value],
                _ => Vec::new(),
            });
        }
    }
    Ok(Vec::new())
}

fn node_property_summary(
    kind: &NodeKind,
    artifact_dir: &Path,
) -> Result<Option<PropertySummary>, DashboardError> {
    let (file_name, summary_kind) = match kind {
        NodeKind::PropertySpecificationLens { .. } => (
            PROPERTY_LENS_CANDIDATE_FILE,
            PropertySummaryKind::Candidates,
        ),
        NodeKind::PropertySpecificationFanIn | NodeKind::PropertySpecification => {
            (PROPERTY_SPECIFICATION_FILE, PropertySummaryKind::Properties)
        }
        NodeKind::Agentic { logical_id, .. } => {
            let Some((file_name, summary_kind)) = agentic_property_summary_file(logical_id) else {
                return Ok(None);
            };
            (file_name, summary_kind)
        }
        _ => return Ok(None),
    };

    Ok(Some(PropertySummary {
        count: candidate_properties_count(&artifact_dir.join(file_name))?,
        kind: summary_kind,
    }))
}

fn agentic_property_summary_file(
    logical_id: &NodeId,
) -> Option<(&'static str, PropertySummaryKind)> {
    match logical_id.as_str() {
        "property-specification" => {
            Some((PROPERTY_SPECIFICATION_FILE, PropertySummaryKind::Properties))
        }
        "property-specification-fanin" => Some((
            PROPERTY_FANIN_MARKDOWN_FILE,
            PropertySummaryKind::Properties,
        )),
        "property-specification-0kn0t" => {
            Some(("properties/0kn0t.md", PropertySummaryKind::Candidates))
        }
        "property-specification-certora" => {
            Some(("properties/certora.md", PropertySummaryKind::Candidates))
        }
        "property-specification-aviggiano" => {
            Some(("properties/aviggiano.md", PropertySummaryKind::Candidates))
        }
        "property-specification-josselin-feist" => Some((
            "properties/josselin-feist.md",
            PropertySummaryKind::Candidates,
        )),
        "property-specification-crytic" => {
            Some(("properties/crytic.md", PropertySummaryKind::Candidates))
        }
        "property-specification-runtime-verification" => Some((
            "properties/runtime-verification.md",
            PropertySummaryKind::Candidates,
        )),
        "property-specification-a16z" => {
            Some(("properties/a16z.md", PropertySummaryKind::Candidates))
        }
        "property-specification-recon" => {
            Some(("properties/recon.md", PropertySummaryKind::Candidates))
        }
        _ => None,
    }
}

fn candidate_properties_count(path: &Path) -> Result<usize, DashboardError> {
    if !path.exists() {
        return Ok(0);
    }
    if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
        let markdown = fs::read_to_string(path)?;
        return Ok(markdown_table_data_row_count(&markdown));
    }
    let value: Value = read_json_required(path)?;
    value
        .get("candidate_properties")
        .and_then(Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| {
            DashboardError::BadRequest(format!(
                "property artifact `{}` must contain candidate_properties array",
                path.display()
            ))
        })
}

fn markdown_table_data_row_count(markdown: &str) -> usize {
    let rows = markdown
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('|') && line.ends_with('|'))
        .filter(|line| !line.chars().all(|ch| matches!(ch, '|' | '-' | ':' | ' ')))
        .count();
    rows.saturating_sub(1)
}

fn artifact_availability(artifact_dir: &Path) -> ArtifactAvailability {
    ArtifactAvailability {
        logs: safe_path_exists(&artifact_dir.join(STDOUT_LOG))
            || safe_path_exists(&artifact_dir.join(STDERR_LOG)),
        rendered_prompt: safe_path_exists(&artifact_dir.join(RENDERED_PROMPT)),
        findings: safe_path_exists(&artifact_dir.join(FINDINGS_FILE))
            || safe_path_exists(&artifact_dir.join(DEDUPED_FINDINGS_FILE))
            || safe_path_exists(&artifact_dir.join(TRIAGED_FINDINGS_FILE))
            || safe_path_exists(&artifact_dir.join(SEVERITY_CLASSIFIED_FINDINGS_FILE))
            || safe_path_exists(&artifact_dir.join("finding.json")),
        patch: safe_path_exists(&artifact_dir.join("patch.diff")),
        report: safe_path_exists(&artifact_dir.join(REPORT_MD_FILE))
            || safe_path_exists(&artifact_dir.join(REPORT_JSON_FILE)),
        metadata: safe_path_exists(&artifact_dir.join("metadata.json")),
        transcript: safe_path_exists(&artifact_dir.join("transcript.json")),
    }
}

fn flow_node_type(kind: &NodeKind) -> String {
    match kind {
        NodeKind::Meta {
            role: MetaNodeRole::Start,
        } => "metaStart".to_owned(),
        NodeKind::Meta {
            role: MetaNodeRole::Finish,
        } => "metaFinish".to_owned(),
        NodeKind::Agentic { .. } => "agentAttempt".to_owned(),
        NodeKind::Reference { .. } => "reference".to_owned(),
        NodeKind::ProjectDiscovery => "projectDiscovery".to_owned(),
        NodeKind::PrepareFoundryHarness => "foundryHarness".to_owned(),
        NodeKind::DiscoverBaseTest => "baseTestDiscovery".to_owned(),
        NodeKind::PropertySpecificationLens { .. } => "propertySpecificationLens".to_owned(),
        NodeKind::PropertySpecificationFanIn => "propertySpecificationFanIn".to_owned(),
        NodeKind::PropertySpecification => "propertySpecification".to_owned(),
        NodeKind::AgentAttempt { .. } => "agentAttempt".to_owned(),
        NodeKind::ConsolidateStrategy { .. } => "strategyConsolidation".to_owned(),
        NodeKind::DedupeFindings => "dedupe".to_owned(),
        NodeKind::TriageFindings => "triage".to_owned(),
        NodeKind::AggregateTestFiles => "testAggregation".to_owned(),
    }
}

fn edge_style(status: &str) -> FlowEdgeStyle {
    let stroke = match status {
        "succeeded" | "reused-from-prior-run" => "#0f766e",
        "failed" | "timed-out" | "invalidated" => "#b91c1c",
        "running" | "ready" => "#b45309",
        "skipped" => "#64748b",
        _ => "#94a3b8",
    };
    FlowEdgeStyle {
        stroke: stroke.to_owned(),
        stroke_width: 2.0,
    }
}

fn graph_layers(graph: &CampaignGraph) -> BTreeMap<NodeId, usize> {
    let nodes = graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let mut layers = BTreeMap::new();
    for node in &graph.nodes {
        graph_layer_for(&node.id, &nodes, &mut layers, &mut BTreeSet::new());
    }
    layers
}

fn graph_layer_for(
    node_id: &NodeId,
    nodes: &BTreeMap<NodeId, &Node>,
    layers: &mut BTreeMap<NodeId, usize>,
    visiting: &mut BTreeSet<NodeId>,
) -> usize {
    if let Some(layer) = layers.get(node_id) {
        return *layer;
    }
    if !visiting.insert(node_id.clone()) {
        return 0;
    }
    let layer = nodes
        .get(node_id)
        .map(|node| {
            node.depends_on
                .iter()
                .map(|dependency| graph_layer_for(dependency, nodes, layers, visiting) + 1)
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    visiting.remove(node_id);
    layers.insert(node_id.clone(), layer);
    layer
}

fn prompt_markdown(
    project_root: &Path,
    prompt: &ultrafuzz_prompts::PromptTemplate,
) -> Result<String, DashboardError> {
    match &prompt.source {
        PromptSource::Project(path) => {
            let path = ensure_prompt_source_path(project_root, path)?;
            fs::read_to_string(path).map_err(Into::into)
        }
        PromptSource::BuiltIn => Ok(format!(
            "---\nid: {}\ndisplay_name: {}\nloops: {}\nenabled: {}\ntimeout_seconds: {}\n---\n{}",
            prompt.strategy_id,
            prompt.display_name,
            prompt.loops,
            prompt.enabled,
            prompt.timeout.as_secs(),
            prompt.body
        )),
    }
}

fn prompt_source_label(source: &PromptSource) -> String {
    match source {
        PromptSource::BuiltIn => "built-in".to_owned(),
        PromptSource::Project(_) => "project-prompt".to_owned(),
    }
}

fn prompt_path_label(project_root: &Path, prompt: &ultrafuzz_prompts::PromptTemplate) -> String {
    match &prompt.source {
        PromptSource::BuiltIn => prompt.source_path.display().to_string(),
        PromptSource::Project(path) => path_label(project_root, path),
    }
}

fn apply_node_prompt_display_names(
    project_root: &Path,
    graph: &mut CampaignGraph,
) -> Result<(), DashboardError> {
    for node in &mut graph.nodes {
        apply_node_prompt_display_name(project_root, node)?;
    }
    Ok(())
}

fn apply_node_prompt_display_name(
    project_root: &Path,
    node: &mut Node,
) -> Result<(), DashboardError> {
    if let Some(display_name) = node_prompt_display_name(project_root, node)? {
        node.label = display_name;
    }
    Ok(())
}

fn node_prompt_display_name(
    project_root: &Path,
    node: &Node,
) -> Result<Option<String>, DashboardError> {
    if !node_prompt_available(node) {
        return Ok(None);
    }
    if strategy_id_for_node(node).is_some() {
        return Ok(None);
    }

    let prompt_identity = prompt_identity_for_node(node);
    validate_node_id(&prompt_identity)?;
    let path = match &node.kind {
        NodeKind::Agentic { prompt_path, .. } => {
            absolute_path(&project_root.join(ultrafuzz_topology::PROJECT_PROMPT_DIR))
                .join(prompt_path)
        }
        _ => project_node_prompt_path_for(project_root, node.id.as_str())?,
    };
    let markdown = if path.exists() {
        fs::read_to_string(&path)?
    } else if let NodeKind::Agentic { prompt_path, .. } = &node.kind {
        topology_prompt_markdown(prompt_path)
            .map(str::to_owned)
            .unwrap_or_else(|| generic_node_prompt_markdown(&prompt_identity, &node.label))
    } else {
        generic_node_prompt_markdown(&prompt_identity, &node.label)
    };
    Ok(node_prompt_content_display_name(
        &prompt_identity,
        &markdown,
    ))
}

fn node_prompt_content_display_name(node_id: &str, content: &str) -> Option<String> {
    let document = parse_prompt_document(content).ok()?;
    if !node_prompt_frontmatter_id_matches(node_id, &document) {
        return None;
    }
    document
        .frontmatter
        .display_name
        .filter(|display_name| !display_name.trim().is_empty())
}

fn parse_node_prompt_document(content: &str) -> Result<ParsedPromptDocument, DashboardError> {
    let document = parse_prompt_document(content)
        .map_err(|error| DashboardError::Prompt(error.to_string()))?;
    validate_supported_template_variables(&document.body)
        .map_err(|error| DashboardError::Prompt(error.to_string()))?;
    Ok(document)
}

fn node_prompt_frontmatter_id_matches(node_id: &str, document: &ParsedPromptDocument) -> bool {
    document
        .frontmatter
        .id
        .as_deref()
        .is_none_or(|frontmatter_id| frontmatter_id == node_id)
}

fn project_node_prompt_dir(project_root: &Path) -> PathBuf {
    project_prompt_dir(project_root)
}

fn project_node_prompt_path_for(
    project_root: &Path,
    node_id: &str,
) -> Result<PathBuf, DashboardError> {
    let prompt_dir = project_node_prompt_dir(project_root);
    let prompt_dir_abs = absolute_path(&prompt_dir);
    ensure_no_symlink_components(&prompt_dir_abs)?;
    if prompt_dir_abs.exists() && !prompt_dir_abs.is_dir() {
        return Err(DashboardError::Prompt(format!(
            "node prompt path `{}` is not a directory",
            prompt_dir_abs.display()
        )));
    }
    let path = prompt_dir_abs.join(default_prompt_path(&NodeId::from(node_id)));
    ensure_no_symlink_components(&path)?;
    ensure_path_inside(&prompt_dir_abs, &path)?;
    Ok(path)
}

fn default_node_prompt_markdown(node: &Node) -> String {
    if let NodeKind::Agentic {
        logical_id,
        prompt_path,
        ..
    } = &node.kind
    {
        if let Some(markdown) = topology_prompt_markdown(prompt_path) {
            return markdown.to_owned();
        }
        return generic_node_prompt_markdown(logical_id.as_str(), &node.label);
    }
    generic_node_prompt_markdown(node.id.as_str(), &node.label)
}

fn generic_node_prompt_markdown(node_id: &str, label: &str) -> String {
    format!(
        "---\nid: {node_id}\ndisplay_name: {label}\n---\n\n# {label}\n\nUse the runtime variables in this prompt to inspect the repository, workspace, artifact directory, and dependency artifacts. Write any required artifacts listed for this topology node before finishing.\n",
    )
}

fn scaffold_project_node_prompts(
    project_root: &Path,
    graph: &CampaignGraph,
) -> Result<(), DashboardError> {
    let prompt_dir = absolute_path(&project_node_prompt_dir(project_root));
    ensure_no_symlink_components(&prompt_dir)?;
    if prompt_dir.exists() && !prompt_dir.is_dir() {
        return Err(DashboardError::Prompt(format!(
            "node prompt path `{}` is not a directory",
            prompt_dir.display()
        )));
    }
    fs::create_dir_all(&prompt_dir)?;

    for node in &graph.nodes {
        if !node_prompt_available(node) {
            continue;
        }
        if matches!(node.kind, NodeKind::Agentic { .. }) {
            continue;
        }
        if strategy_id_for_node(node).is_some() {
            continue;
        }
        let node_id = node.id.as_str();
        validate_node_id(node_id)?;
        let path = prompt_dir.join(format!("{node_id}.md"));
        ensure_no_symlink_components(&path)?;
        ensure_path_inside(&prompt_dir, &path)?;
        if path.exists() {
            continue;
        }
        atomic_write(&path, &default_node_prompt_markdown(node))?;
    }

    Ok(())
}

fn path_label(project_root: &Path, path: &Path) -> String {
    path.strip_prefix(project_root)
        .unwrap_or(path)
        .display()
        .to_string()
}

fn validate_node_id(node_id: &str) -> Result<(), DashboardError> {
    let valid = !node_id.is_empty()
        && node_id
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'))
        && !node_id.contains("..");
    if valid {
        Ok(())
    } else {
        Err(DashboardError::BadRequest(format!(
            "node id `{node_id}` must use lowercase ASCII letters, digits, hyphen, or underscore"
        )))
    }
}

fn read_project_topology_for_edit(
    project_root: &Path,
) -> Result<(PathBuf, String, ProjectTopology), DashboardError> {
    let path = project_root.join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE);
    ensure_no_symlink_components(&path)?;
    let content = fs::read_to_string(&path).map_err(|error| {
        DashboardError::BadRequest(format!(
            "failed to read topology `{}`: {error}",
            path.display()
        ))
    })?;
    let topology = serde_yaml::from_str::<ProjectTopology>(&content)
        .map_err(|error| DashboardError::BadRequest(format!("invalid topology YAML: {error}")))?;
    validate_project_topology(
        project_root,
        &topology,
        TopologyValidationOptions {
            require_prompt_files: false,
        },
    )
    .map_err(|error| DashboardError::BadRequest(error.to_string()))?;
    Ok((path, content, topology))
}

fn sync_topology_required_artifacts_from_prompt(
    topology: &mut ProjectTopology,
    node_id: &NodeId,
    prompt_body: &str,
) -> Result<(), DashboardError> {
    let required_artifacts = prompt_artifact_output_paths(prompt_body)
        .map_err(|error| DashboardError::Prompt(error.to_string()))?;
    let node = topology
        .nodes
        .iter_mut()
        .find(|node| &node.id == node_id)
        .ok_or_else(|| DashboardError::NotFound(format!("topology node `{node_id}`")))?;
    node.primary_artifact = node
        .primary_artifact
        .take()
        .filter(|primary| {
            required_artifacts
                .iter()
                .any(|required| required == primary)
        })
        .or_else(|| required_artifacts.first().cloned());
    node.required_artifacts = required_artifacts;
    Ok(())
}

#[derive(Debug)]
struct PromptFileRewrite {
    path: PathBuf,
    old_content: String,
}

fn rewrite_project_prompt_artifact_references_for_rename(
    project_root: &Path,
    topology: &ProjectTopology,
    old_id: &str,
    new_id: &str,
    excluded_paths: &[&Path],
) -> Result<Vec<PromptFileRewrite>, DashboardError> {
    let mut rewrites = Vec::new();
    let result = (|| {
        for node in &topology.nodes {
            let relative_path = node
                .prompt
                .clone()
                .unwrap_or_else(|| default_prompt_path_for_node(node));
            let path = project_topology_prompt_path(project_root, &relative_path)?;
            if excluded_paths.iter().any(|excluded| *excluded == path) || !path.exists() {
                continue;
            }
            let old_content = fs::read_to_string(&path)?;
            let new_content = rename_prompt_artifact_path_references(&old_content, old_id, new_id)
                .map_err(|error| DashboardError::Prompt(error.to_string()))?;
            if new_content == old_content {
                continue;
            }
            atomic_write(&path, &new_content)?;
            rewrites.push(PromptFileRewrite { path, old_content });
        }
        Ok::<_, DashboardError>(())
    })();

    if let Err(error) = result {
        restore_prompt_file_rewrites(&rewrites);
        return Err(error);
    }
    Ok(rewrites)
}

fn restore_prompt_file_rewrites(rewrites: &[PromptFileRewrite]) {
    for rewrite in rewrites.iter().rev() {
        let _ = atomic_write(&rewrite.path, &rewrite.old_content);
    }
}

fn project_topology_prompt_path(
    project_root: &Path,
    relative_path: &Path,
) -> Result<PathBuf, DashboardError> {
    validate_safe_relative_path("prompt path", relative_path)?;
    let prompt_root = absolute_path(&project_root.join(ultrafuzz_topology::PROJECT_PROMPT_DIR));
    ensure_no_symlink_components(&prompt_root)?;
    let path = absolute_path(&prompt_root.join(relative_path));
    ensure_path_inside(&prompt_root, &path)?;
    if path.exists() {
        ensure_no_symlink_components(&path)?;
    } else if let Some(parent) = path.parent() {
        ensure_no_symlink_components(parent)?;
    }
    Ok(path)
}

fn rollback_node_prompt_rename(
    topology_path: &Path,
    old_topology_content: String,
    old_prompt_path: &Path,
    old_prompt_content: Option<String>,
    new_prompt_path: &Path,
    moved_prompt_file: bool,
) {
    if moved_prompt_file && new_prompt_path.exists() {
        if let Some(parent) = old_prompt_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::rename(new_prompt_path, old_prompt_path);
    }
    let _ = restore_prompt_file(old_prompt_path, old_prompt_content);
    let _ = atomic_write(topology_path, &old_topology_content);
}

fn remapped_node_id(requested_node_id: &str, old_id: &str, new_id: &str) -> String {
    if requested_node_id == old_id {
        return new_id.to_owned();
    }
    requested_node_id
        .strip_prefix(old_id)
        .and_then(|suffix| suffix.strip_prefix('-'))
        .filter(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()))
        .map(|suffix| format!("{new_id}-{suffix}"))
        .unwrap_or_else(|| new_id.to_owned())
}

fn topology_validation(
    project_root: &Path,
    topology: &ProjectTopology,
    require_prompt_files: bool,
) -> StrategyPromptValidation {
    match validate_project_topology(
        project_root,
        topology,
        TopologyValidationOptions {
            require_prompt_files,
        },
    ) {
        Ok(()) => StrategyPromptValidation {
            valid: true,
            message: format!("topology is valid ({} logical nodes)", topology.nodes.len()),
        },
        Err(error) => StrategyPromptValidation {
            valid: false,
            message: error.to_string(),
        },
    }
}

fn normalize_dashboard_meta_wiring(topology: &mut ProjectTopology) {
    repair_topology_meta_contract(topology);
    wire_runnable_roots_to_start(topology);
    rewire_finish_to_terminal_runnable_nodes(topology);
}

fn wire_runnable_roots_to_start(topology: &mut ProjectTopology) {
    let start_id = NodeId::from(ultrafuzz_topology::START_NODE_ID);
    for node in &mut topology.nodes {
        if dashboard_topology_node_is_runnable(node) && node.depends_on.is_empty() {
            node.depends_on.push(start_id.clone());
        }
    }
}

fn rewire_finish_to_terminal_runnable_nodes(topology: &mut ProjectTopology) {
    let finish_id = NodeId::from(ultrafuzz_topology::FINISH_NODE_ID);
    let mut depended_on_by_non_finish = BTreeSet::<NodeId>::new();
    for node in &topology.nodes {
        if node.id == finish_id {
            continue;
        }
        depended_on_by_non_finish.extend(node.depends_on.iter().cloned());
    }
    let terminal_agentic_nodes = topology
        .nodes
        .iter()
        .filter(|node| dashboard_topology_node_is_runnable(node))
        .filter(|node| !depended_on_by_non_finish.contains(&node.id))
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    if let Some(finish) = topology.nodes.iter_mut().find(|node| node.id == finish_id) {
        finish.depends_on = terminal_agentic_nodes;
    }
}

fn dashboard_topology_node_is_runnable(node: &TopologyNode) -> bool {
    matches!(node.kind, TopologyNodeKind::Agentic)
}

fn create_missing_topology_prompts(
    project_root: &Path,
    topology: &ProjectTopology,
) -> Result<(), DashboardError> {
    let prompt_root = project_root.join(ultrafuzz_topology::PROJECT_PROMPT_DIR);
    ensure_no_symlink_components(&prompt_root)?;
    fs::create_dir_all(&prompt_root)?;
    for node in &topology.nodes {
        if node.kind != TopologyNodeKind::Agentic {
            continue;
        }
        let relative_path = node
            .prompt
            .clone()
            .unwrap_or_else(|| default_prompt_path_for_node(node));
        let path = prompt_root.join(&relative_path);
        ensure_path_inside(&prompt_root, &absolute_path(&path))?;
        if let Some(parent) = path.parent() {
            ensure_no_symlink_components(parent)?;
            fs::create_dir_all(parent)?;
        }
        if path.exists() {
            ensure_no_symlink_components(&path)?;
            continue;
        }
        atomic_write(&path, &default_topology_prompt_markdown(node))?;
    }
    Ok(())
}

fn default_topology_prompt_markdown(node: &TopologyNode) -> String {
    format!(
        "---\nid: {id}\ndisplay_name: {display_name}\n---\n\n# {display_name}\n\nUse the runtime variables in this prompt to inspect the repository, dependency artifacts, workspace, and artifact directory. Write any required artifacts listed for this topology node before finishing.\n",
        id = node.id,
        display_name = node
            .id
            .as_str()
            .replace(['-', '_'], " ")
            .split_whitespace()
            .map(|word| {
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    )
}

fn validate_strategy_id(strategy_id: &str) -> Result<(), DashboardError> {
    let valid = !strategy_id.is_empty()
        && strategy_id
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'))
        && !strategy_id.contains("..");
    if valid {
        Ok(())
    } else {
        Err(DashboardError::BadRequest(format!(
            "strategy id `{strategy_id}` must use lowercase ASCII letters, digits, hyphen, or underscore"
        )))
    }
}

fn require_session_token(
    headers: &HeaderMap,
    state: &DashboardAppState,
) -> Result<(), DashboardError> {
    require_local_dashboard_mutation(headers)?;
    let token = headers
        .get(DASHBOARD_SESSION_HEADER)
        .and_then(|value| value.to_str().ok());
    if token
        .map(|value| state.session_token.matches(value))
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err(DashboardError::Unauthorized)
    }
}

fn require_local_dashboard_request(headers: &HeaderMap) -> Result<(), DashboardError> {
    if let Some(host) = header_str(headers, &header::HOST)? {
        validate_local_host_header(host)?;
    }
    if let Some(origin) = header_str(headers, &header::ORIGIN)? {
        validate_local_origin_header(origin)?;
    }
    Ok(())
}

fn require_local_dashboard_mutation(headers: &HeaderMap) -> Result<(), DashboardError> {
    let host = required_header_str(headers, &header::HOST, "Host")?;
    validate_local_host_header(host)?;
    let origin = required_header_str(headers, &header::ORIGIN, "Origin")?;
    validate_local_origin_header(origin)?;
    Ok(())
}

fn required_header_str<'a>(
    headers: &'a HeaderMap,
    name: &header::HeaderName,
    label: &str,
) -> Result<&'a str, DashboardError> {
    header_str(headers, name)?
        .ok_or_else(|| DashboardError::BadRequest(format!("missing {label} header")))
}

fn header_str<'a>(
    headers: &'a HeaderMap,
    name: &header::HeaderName,
) -> Result<Option<&'a str>, DashboardError> {
    headers
        .get(name)
        .map(|value| {
            value.to_str().map_err(|_| {
                DashboardError::BadRequest(format!("header `{}` is not valid UTF-8", name.as_str()))
            })
        })
        .transpose()
}

fn validate_local_host_header(value: &str) -> Result<(), DashboardError> {
    let authority = value
        .parse::<Authority>()
        .map_err(|_| DashboardError::BadRequest(format!("invalid Host header `{value}`")))?;
    validate_local_authority(&authority, "Host")
}

fn validate_local_origin_header(value: &str) -> Result<(), DashboardError> {
    let uri = value
        .parse::<Uri>()
        .map_err(|_| DashboardError::BadRequest(format!("invalid Origin header `{value}`")))?;
    match uri.scheme_str() {
        Some("http") | Some("https") => {}
        _ => {
            return Err(DashboardError::BadRequest(format!(
                "invalid Origin header `{value}`"
            )))
        }
    }
    let authority = uri
        .authority()
        .ok_or_else(|| DashboardError::BadRequest(format!("invalid Origin header `{value}`")))?;
    validate_local_authority(authority, "Origin")
}

fn validate_local_authority(authority: &Authority, label: &str) -> Result<(), DashboardError> {
    if authority.as_str().contains('@') {
        return Err(DashboardError::BadRequest(format!(
            "invalid {label} header `{authority}`"
        )));
    }
    validate_loopback_host(authority_host(authority.host()))
}

fn authority_host(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
}

fn validate_loopback_host(host: &str) -> Result<(), DashboardError> {
    if host.eq_ignore_ascii_case("localhost") {
        return Ok(());
    }
    match host.parse::<IpAddr>() {
        Ok(address) if address.is_loopback() => Ok(()),
        _ => Err(DashboardError::NonLoopbackHost(host.to_owned())),
    }
}

fn encode_session_token(bytes: &[u8; SESSION_TOKEN_BYTES]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(SESSION_TOKEN_HEX_LEN);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn decode_session_token(value: &str) -> Option<[u8; SESSION_TOKEN_BYTES]> {
    if value.len() != SESSION_TOKEN_HEX_LEN {
        return None;
    }
    let mut decoded = [0_u8; SESSION_TOKEN_BYTES];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_nibble(chunk[0])?;
        let low = hex_nibble(chunk[1])?;
        decoded[index] = (high << 4) | low;
    }
    Some(decoded)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn fixed_time_eq(left: &[u8; SESSION_TOKEN_BYTES], right: &[u8; SESSION_TOKEN_BYTES]) -> bool {
    let mut difference = 0_u8;
    for index in 0..SESSION_TOKEN_BYTES {
        difference |= left[index] ^ right[index];
    }
    difference == 0
}

fn ensure_prompt_source_path(project_root: &Path, path: &Path) -> Result<PathBuf, DashboardError> {
    let prompt_root = absolute_path(&project_prompt_dir(project_root));
    let path = absolute_path(path);
    ensure_no_symlink_components(&path)?;
    ensure_path_inside(&prompt_root, &path)?;
    Ok(path)
}

fn load_prompt_registry(project_root: &Path) -> Result<PromptRegistry, DashboardError> {
    ensure_project_prompt_paths_safe(project_root)?;
    PromptRegistry::load_for_project(project_root)
        .map_err(|error| DashboardError::Prompt(error.to_string()))
}

fn validate_config_toml(project_root: &Path, content: &str) -> Result<(), DashboardError> {
    let registry = load_prompt_registry(project_root)?;
    let config = ultrafuzz_config::resolve_config_from_toml(
        Some(content),
        registry.strategy_definitions(),
        EnvOverrides::from_env().map_err(|error| DashboardError::BadRequest(error.to_string()))?,
        CliOverrides::default(),
    )
    .map_err(|error| DashboardError::BadRequest(format!("invalid config: {error}")))?;
    config
        .validate_project_paths(project_root)
        .map_err(|error| DashboardError::BadRequest(format!("invalid config: {error}")))
}

fn ensure_project_prompt_paths_safe(project_root: &Path) -> Result<(), DashboardError> {
    let prompt_root = absolute_path(&project_prompt_dir(project_root));
    if !prompt_root.exists() {
        return Ok(());
    }
    ensure_no_symlink_components(&prompt_root)?;
    if !prompt_root.is_dir() {
        return Err(DashboardError::Prompt(format!(
            "prompt path `{}` is not a directory",
            prompt_root.display()
        )));
    }

    ensure_prompt_paths_safe_recursive(&prompt_root)
}

fn ensure_prompt_paths_safe_recursive(dir: &Path) -> Result<(), DashboardError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        ensure_no_symlink_components(&path)?;
        if entry.file_type()?.is_dir() {
            ensure_prompt_paths_safe_recursive(&path)?;
        }
    }
    Ok(())
}

fn ensure_no_symlink_components(path: &Path) -> Result<(), DashboardError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() {
                return Err(DashboardError::BadRequest(format!(
                    "prompt path `{}` may not contain symlinks",
                    path.display()
                )));
            }
        }
    }
    Ok(())
}

fn ensure_path_inside(root: &Path, path: &Path) -> Result<(), DashboardError> {
    let root = normalize_existing_or_parent(root)?;
    let candidate = normalize_existing_or_parent(path)?;
    if candidate == root || candidate.starts_with(&root) {
        Ok(())
    } else {
        Err(DashboardError::BadRequest(format!(
            "path `{}` is outside `{}`",
            path.display(),
            root.display()
        )))
    }
}

fn normalize_existing_or_parent(path: &Path) -> Result<PathBuf, DashboardError> {
    let path = absolute_path(path);
    if path.exists() {
        return path.canonicalize().map_err(DashboardError::Io);
    }

    let mut missing = Vec::new();
    let mut current = path.as_path();
    while !current.exists() {
        let Some(file_name) = current.file_name() else {
            return Err(DashboardError::BadRequest(format!(
                "path `{}` has no existing parent",
                path.display()
            )));
        };
        missing.push(file_name.to_owned());
        current = current.parent().ok_or_else(|| {
            DashboardError::BadRequest(format!("path `{}` has no parent", path.display()))
        })?;
    }

    let mut normalized = current.canonicalize()?;
    for component in missing.iter().rev() {
        normalized.push(component);
    }
    Ok(normalized)
}

fn ensure_run_root_inside(runs_dir: &Path, run_root: &Path) -> Result<(), DashboardError> {
    let canonical_runs = runs_dir.canonicalize()?;
    let canonical_run = run_root.canonicalize()?;
    if canonical_run.starts_with(&canonical_runs) {
        Ok(())
    } else {
        Err(DashboardError::BadRequest(format!(
            "run `{}` resolves outside runs directory `{}`",
            run_root.display(),
            runs_dir.display()
        )))
    }
}

fn validate_artifact_dir(path: &Path) -> Result<(), DashboardError> {
    validate_safe_relative_path("artifact directory", path)?;
    match path.components().next() {
        Some(std::path::Component::Normal(first)) if first == "artifacts" => Ok(()),
        _ => Err(DashboardError::BadRequest(format!(
            "artifact directory `{}` must be under artifacts/",
            path.display()
        ))),
    }
}

fn validate_safe_relative_path(label: &str, path: &Path) -> Result<(), DashboardError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(DashboardError::BadRequest(format!(
            "{label} `{}` must be non-empty and relative",
            path.display()
        )));
    }
    if path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(DashboardError::BadRequest(format!(
            "{label} `{}` may not contain traversal or root components",
            path.display()
        )));
    }
    Ok(())
}

fn atomic_write(path: &Path, content: &str) -> Result<(), DashboardError> {
    let parent = path.parent().ok_or_else(|| {
        DashboardError::BadRequest(format!("path `{}` has no parent", path.display()))
    })?;
    ensure_no_symlink_components(parent)?;
    fs::create_dir_all(parent)?;
    ensure_no_symlink_components(parent)?;
    if path.exists() {
        ensure_no_symlink_components(path)?;
    }
    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("prompt"),
        unix_nanos()
    ));
    fs::write(&temp_path, content)?;
    fs::rename(temp_path, path)?;
    Ok(())
}

fn restore_prompt_file(path: &Path, old_content: Option<String>) -> Result<(), DashboardError> {
    match old_content {
        Some(content) => atomic_write(path, &content),
        None if path.exists() => fs::remove_file(path).map_err(Into::into),
        None => Ok(()),
    }
}

fn append_audit(project_root: &Path, value: Value) -> Result<(), DashboardError> {
    let audit_dir = project_root.join(".ultrafuzz");
    fs::create_dir_all(&audit_dir)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_dir.join("dashboard-audit.jsonl"))?;
    writeln!(file, "{}", serde_json::to_string(&value)?)?;
    Ok(())
}

fn build_command_args(
    command: &'static str,
    current_run_id: &RunId,
    request: CommandRequest,
) -> Result<Vec<String>, DashboardError> {
    let run_id = request
        .run_id
        .clone()
        .unwrap_or_else(|| current_run_id.to_string());
    validate_run_id(&run_id)?;
    let mut args = Vec::new();
    match command {
        "list" => args.push("list".to_owned()),
        "run" => {
            args.push("run".to_owned());
            push_backend_and_parallel(&mut args, &request)?;
        }
        "restart" => {
            args.extend(["restart".to_owned(), run_id]);
            push_backend_and_parallel(&mut args, &request)?;
        }
        "continue" => {
            args.extend(["continue".to_owned(), run_id]);
        }
        "status" => args.extend(["status".to_owned(), run_id]),
        "doctor" => {
            args.push("doctor".to_owned());
            if let Some(backend) = request.backend.as_deref() {
                args.extend(["--backend".to_owned(), validate_backend(backend)?]);
            }
        }
        "config" => {
            args.push("config".to_owned());
            match request.config.as_deref().unwrap_or("inspect") {
                "inspect" => {}
                "defaults" => args.push("defaults".to_owned()),
                other => {
                    return Err(DashboardError::BadRequest(format!(
                        "unsupported config command `{other}`"
                    )))
                }
            }
        }
        "report" => {
            args.extend(["report".to_owned(), run_id]);
            if request.json.unwrap_or(false) {
                args.push("--json".to_owned());
            }
        }
        "triage" => args.extend(["triage".to_owned(), run_id]),
        "merge" => args.extend(["merge".to_owned(), run_id]),
        "materialize" => {
            require_confirmation("materialize", request.confirmed)?;
            args.extend(["materialize".to_owned(), run_id]);
            for patch in request.patches {
                validate_relative_arg("patch", &patch)?;
                args.extend(["--patch".to_owned(), patch]);
            }
            for copy in request.copies {
                validate_copy_arg(&copy)?;
                args.extend(["--copy".to_owned(), copy]);
            }
            if request.dry_run.unwrap_or(false) {
                args.push("--dry-run".to_owned());
            }
            if request.force.unwrap_or(false) {
                args.push("--force".to_owned());
            }
        }
        "clean" => {
            require_confirmation("clean", request.confirmed)?;
            args.extend(["clean".to_owned(), run_id]);
            if request.dry_run.unwrap_or(false) {
                args.push("--dry-run".to_owned());
            }
            if request.force.unwrap_or(false) {
                args.push("--force".to_owned());
            }
        }
        other => {
            return Err(DashboardError::BadRequest(format!(
                "unsupported command `{other}`"
            )))
        }
    }
    Ok(args)
}

fn push_backend_and_parallel(
    args: &mut Vec<String>,
    request: &CommandRequest,
) -> Result<(), DashboardError> {
    if let Some(backend) = &request.backend {
        args.extend(["--backend".to_owned(), validate_backend(backend)?]);
    }
    if let Some(max_parallel_agents) = request.max_parallel_agents {
        args.extend([
            "--max-parallel-agents".to_owned(),
            max_parallel_agents.to_string(),
        ]);
    }
    Ok(())
}

fn validate_backend(backend: &str) -> Result<String, DashboardError> {
    backend
        .parse::<BackendKind>()
        .map(|backend| backend.to_string())
        .map_err(|_| {
            DashboardError::BadRequest(format!(
                "unsupported backend `{backend}`; expected codex-cli or claude-code-cli"
            ))
        })
}

fn validate_run_id(run_id: &str) -> Result<(), DashboardError> {
    let valid = !run_id.is_empty()
        && !run_id.contains("..")
        && !run_id.contains('/')
        && !run_id.contains('\\');
    if valid {
        Ok(())
    } else {
        Err(DashboardError::BadRequest(format!(
            "run id `{run_id}` may not contain path separators or traversal"
        )))
    }
}

fn validate_relative_arg(label: &str, value: &str) -> Result<(), DashboardError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        Err(DashboardError::BadRequest(format!(
            "{label} `{value}` must be a safe relative path"
        )))
    } else {
        Ok(())
    }
}

fn validate_copy_arg(value: &str) -> Result<(), DashboardError> {
    let Some((source, destination)) = value.split_once('=') else {
        return Err(DashboardError::BadRequest(
            "copy selection must be RUN_RELATIVE_PATH=REPO_RELATIVE_PATH".to_owned(),
        ));
    };
    validate_relative_arg("copy source", source)?;
    validate_relative_arg("copy destination", destination)
}

fn require_confirmation(command: &str, confirmed: Option<bool>) -> Result<(), DashboardError> {
    if confirmed.unwrap_or(false) {
        Ok(())
    } else {
        Err(DashboardError::BadRequest(format!(
            "`{command}` requires confirmed: true"
        )))
    }
}

fn new_job_id(command: &str) -> String {
    format!("{command}-{}-{}", std::process::id(), unix_nanos())
}

fn display_argv(args: &[String]) -> Vec<String> {
    std::iter::once("ultrafuzz".to_owned())
        .chain(args.iter().cloned())
        .collect()
}

fn update_job(jobs: &CommandJobs, job_id: &str, update: impl FnOnce(&mut CommandJob)) {
    if let Ok(mut jobs) = jobs.lock() {
        if let Some(job) = jobs.get_mut(job_id) {
            update(job);
        }
        prune_command_jobs(&mut jobs);
    }
}

fn truncate_command_output(output: String) -> String {
    if output.len() <= MAX_COMMAND_JOB_OUTPUT_BYTES {
        return output;
    }

    let tail_bytes =
        MAX_COMMAND_JOB_OUTPUT_BYTES.saturating_sub(COMMAND_JOB_OUTPUT_TRUNCATED_PREFIX.len());
    let mut start = output.len().saturating_sub(tail_bytes);
    while !output.is_char_boundary(start) {
        start += 1;
    }
    let mut truncated = String::with_capacity(MAX_COMMAND_JOB_OUTPUT_BYTES);
    truncated.push_str(COMMAND_JOB_OUTPUT_TRUNCATED_PREFIX);
    truncated.push_str(&output[start..]);
    truncated
}

fn prune_command_jobs(jobs: &mut BTreeMap<String, CommandJob>) {
    while jobs.len() > MAX_COMMAND_JOBS {
        let Some(job_id) = jobs
            .iter()
            .filter(|(_, job)| !command_job_is_active(job))
            .min_by(|left, right| {
                left.1
                    .started_at_unix_seconds
                    .cmp(&right.1.started_at_unix_seconds)
                    .then_with(|| left.0.cmp(right.0))
            })
            .map(|(job_id, _)| job_id.clone())
        else {
            break;
        };
        jobs.remove(&job_id);
    }
}

fn command_job_is_active(job: &CommandJob) -> bool {
    matches!(job.status.as_str(), "queued" | "running")
}

fn safe_path_exists(path: &Path) -> bool {
    path.exists() && ensure_no_symlink_components(path).is_ok()
}

fn read_json_required<T: DeserializeOwned>(path: impl AsRef<Path>) -> Result<T, DashboardError> {
    let path = path.as_ref();
    ensure_no_symlink_components(path)?;
    let contents = fs::read_to_string(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DashboardError::NotFound(path.display().to_string())
        } else {
            DashboardError::Io(error)
        }
    })?;
    serde_json::from_str(&contents).map_err(Into::into)
}

fn read_json_optional(path: impl AsRef<Path>) -> Result<Option<Value>, DashboardError> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(None);
    }
    read_json_required(path).map(Some)
}

fn read_json_array(path: &Path) -> Result<Vec<Value>, DashboardError> {
    let value: Value = read_json_required(path)?;
    Ok(match value {
        Value::Array(values) => values,
        Value::Object(_) => vec![value],
        _ => Vec::new(),
    })
}

fn read_text_optional(path: impl AsRef<Path>) -> Result<Option<String>, DashboardError> {
    let path = path.as_ref();
    if path.exists() {
        ensure_no_symlink_components(path)?;
        fs::read_to_string(path).map(Some).map_err(Into::into)
    } else {
        Ok(None)
    }
}

fn latest_run_id_optional(runs_dir: &Path) -> Result<Option<RunId>, DashboardError> {
    if !runs_dir.exists() {
        return Ok(None);
    }
    if !runs_dir.is_dir() {
        return Err(DashboardError::BadRequest(format!(
            "runs path `{}` is not a directory",
            runs_dir.display()
        )));
    }

    let mut run_ids = fs::read_dir(runs_dir)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            RunId::try_new(entry.file_name().to_string_lossy().into_owned()).ok()
        })
        .collect::<Vec<_>>();
    run_ids.sort();
    Ok(run_ids.pop())
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn absolute_path_from(root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    }
}

fn report_md_path(run_root: &Path) -> PathBuf {
    run_root
        .join("artifacts")
        .join("final-report")
        .join(REPORT_MD_FILE)
}

fn report_json_path(run_root: &Path) -> PathBuf {
    run_root
        .join("artifacts")
        .join("final-report")
        .join(REPORT_JSON_FILE)
}

fn relative_to_run(run_root: &Path, path: &Path) -> String {
    path.strip_prefix(run_root)
        .unwrap_or(path)
        .display()
        .to_string()
}

fn serde_label<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned())
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

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn format_seconds(value: f64) -> String {
    if value < 60.0 {
        format!("{value:.1}s")
    } else {
        let minutes = (value / 60.0).floor();
        let seconds = value - minutes * 60.0;
        format!("{minutes:.0}m {seconds:.0}s")
    }
}

fn empty_dash(value: String) -> String {
    if value.trim().is_empty() {
        "-".to_owned()
    } else {
        value
    }
}

fn render_layout(state: &DashboardAppState, title: &str, active: &str, body: &str) -> String {
    let script = if state.live_updates {
        r#"<script>
const liveEvents = document.querySelector("[data-live-events]");
const source = new EventSource("/api/events/stream");
source.addEventListener("ultrafuzz-event", () => {
  if (liveEvents) {
    liveEvents.textContent = String(Number(liveEvents.textContent || "0") + 1);
  }
});
</script>"#
    } else {
        ""
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{} - Ultrafuzz</title>
{}
<style>
:root {{
  color-scheme: light;
  --bg: #fbfaf9;
  --ink: #26262b;
  --muted: #727285;
  --line: #e9e9f5;
  --accent: #6e54ff;
  --surface: #ffffff;
  --surface-muted: #f4f4f8;
  --warn: #ca8a04;
  --success: #16a34a;
}}
html.dark {{
  color-scheme: dark;
  --bg: #000000;
  --ink: #fbfaf9;
  --muted: #c7c7d6;
  --line: #26262b;
  --accent: #8270ff;
  --surface: #16161a;
  --surface-muted: #0f0f12;
  --warn: #eab308;
  --success: #22c55e;
}}
* {{ box-sizing: border-box; }}
body {{
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}}
header {{
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  padding: 14px 24px;
}}
main {{ padding: 20px 24px 40px; max-width: 1320px; }}
h1 {{ font-size: 22px; margin: 0 0 10px; letter-spacing: 0; }}
h2 {{ font-size: 16px; margin: 24px 0 10px; letter-spacing: 0; }}
h3 {{ font-size: 14px; margin: 16px 0 8px; letter-spacing: 0; color: var(--muted); }}
nav {{ display: flex; gap: 8px; flex-wrap: wrap; }}
nav a {{
  color: var(--muted);
  text-decoration: none;
  padding: 5px 8px;
  border-radius: 6px;
}}
nav a.active {{ color: #ffffff; background: var(--accent); }}
section {{ border-top: 1px solid var(--line); margin-top: 18px; padding-top: 2px; }}
table {{ border-collapse: collapse; width: 100%; background: var(--surface); }}
th, td {{ border: 1px solid var(--line); padding: 7px 9px; text-align: left; vertical-align: top; }}
th {{ background: var(--surface-muted); font-weight: 600; color: var(--ink); }}
code, pre {{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }}
pre {{
  background: #101828;
  color: #edf2f7;
  padding: 12px;
  overflow: auto;
  border-radius: 6px;
  max-height: 560px;
}}
a {{ color: var(--accent); }}
.muted {{ color: var(--muted); }}
.status-running, .status-ready {{ color: var(--warn); font-weight: 600; }}
.status-succeeded {{ color: var(--success); font-weight: 600; }}
@media (max-width: 720px) {{
  header, main {{ padding-left: 12px; padding-right: 12px; }}
  table {{ font-size: 12px; }}
  th, td {{ padding: 6px; }}
}}
</style>
</head>
<body>
<header>
<h1>Ultrafuzz <span class="muted">{}</span></h1>
<nav>{}</nav>
</header>
<main>{}</main>
{}
</body>
</html>"#,
        escape_html(title),
        THEME_BOOTSTRAP_SCRIPT,
        escape_html(state.run_id.as_str()),
        nav(active),
        body,
        script
    )
}

fn nav(active: &str) -> String {
    [
        ("run", "/run", "Run"),
        ("graph", "/graph", "Graph"),
        ("nodes", "/nodes", "Nodes"),
        ("findings", "/findings", "Findings"),
        ("report", "/report", "Report"),
        ("events", "/events", "Events"),
    ]
    .into_iter()
    .map(|(id, href, label)| {
        format!(
            "<a href=\"{href}\" class=\"{}\">{label}</a>",
            if id == active { "active" } else { "" }
        )
    })
    .collect::<Vec<_>>()
    .join("")
}

fn row(out: &mut String, label: &str, value: &str) {
    row_raw(out, label, &escape_html(value));
}

fn row_raw(out: &mut String, label: &str, value: &str) {
    out.push_str(&format!(
        "<tr><th>{}</th><td>{}</td></tr>",
        escape_html(label),
        value
    ));
}

fn count_table(counts: &BTreeMap<String, usize>) -> String {
    if counts.is_empty() {
        return "<p>No node state is available.</p>".to_owned();
    }
    let mut out =
        String::from("<table><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>");
    for (status, count) in counts {
        out.push_str(&format!(
            "<tr><td>{}</td><td>{}</td></tr>",
            status_cell(status),
            count
        ));
    }
    out.push_str("</tbody></table>");
    out
}

fn nodes_table(nodes: &[NodeSummary]) -> String {
    let mut out = String::from("<table><thead><tr><th>Node</th><th>Status</th><th>Kind</th><th>Strategy</th><th>Source</th><th>Category</th><th>Depends On</th></tr></thead><tbody>");
    for node in nodes {
        let (strategy, source, category) = node
            .strategy
            .as_ref()
            .map(|strategy| {
                (
                    strategy.display_name.as_str(),
                    strategy.source.as_str(),
                    strategy.category.as_str(),
                )
            })
            .unwrap_or(("", "", ""));
        out.push_str(&format!(
            "<tr><td><a href=\"/nodes/{}\">{}</a><br><span class=\"muted\">{}</span></td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            url_escape(&node.id),
            escape_html(&node.id),
            escape_html(&node.label),
            status_cell(&node.status),
            escape_html(&node.kind),
            escape_html(strategy),
            escape_html(source),
            escape_html(category),
            escape_html(&node.depends_on.join(", "))
        ));
    }
    out.push_str("</tbody></table>");
    out
}

fn artifacts_table(artifacts: &[ArtifactEntry]) -> String {
    if artifacts.is_empty() {
        return "<p>No artifacts were found for this node.</p>".to_owned();
    }
    let mut out = String::from("<table><thead><tr><th>Path</th><th>Kind</th><th>Size</th><th>SHA-256</th></tr></thead><tbody>");
    for artifact in artifacts {
        out.push_str(&format!(
            "<tr><td><code>{}</code></td><td>{}</td><td>{}</td><td><code>{}</code></td></tr>",
            escape_html(&artifact.path),
            escape_html(&artifact.kind),
            artifact.size_bytes,
            escape_html(artifact.sha256.as_deref().unwrap_or(""))
        ));
    }
    out.push_str("</tbody></table>");
    out
}

fn findings_table(findings: &[Value]) -> String {
    if findings.is_empty() {
        return "<p>No findings were reported.</p>".to_owned();
    }
    let mut out = String::from("<table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Severity</th><th>Strategy</th><th>Summary</th></tr></thead><tbody>");
    for finding in findings {
        out.push_str(&format!(
            "<tr><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            escape_html(value_string(finding, "id").unwrap_or_default().as_str()),
            escape_html(value_string(finding, "title").unwrap_or_default().as_str()),
            escape_html(value_string(finding, "status").unwrap_or_default().as_str()),
            escape_html(value_string(finding, "severity_guess").unwrap_or_default().as_str()),
            escape_html(value_string(finding, "strategy").unwrap_or_default().as_str()),
            escape_html(value_string(finding, "summary").unwrap_or_default().as_str()),
        ));
    }
    out.push_str("</tbody></table>");
    out
}

fn events_table(events: &[EventRecord]) -> String {
    if events.is_empty() {
        return "<p>No events were found.</p>".to_owned();
    }
    let mut out = String::from("<table><thead><tr><th>Timestamp</th><th>Type</th><th>Node</th><th>Payload</th></tr></thead><tbody>");
    for event in events.iter().rev().take(500) {
        out.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td>{}</td><td><pre>{}</pre></td></tr>",
            escape_html(&event.timestamp),
            escape_html(&event.event_type),
            escape_html(
                event
                    .node_id
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_default()
                    .as_str()
            ),
            escape_html(&serde_json::to_string_pretty(&event.payload).unwrap_or_default())
        ));
    }
    out.push_str("</tbody></table>");
    out
}

fn strategy_rows(values: Vec<Value>) -> String {
    if values.is_empty() {
        return "<p>No strategy metadata was recorded.</p>".to_owned();
    }
    let mut out = String::from("<table><thead><tr><th>Strategy</th><th>Category</th><th>Source</th><th>Loops</th><th>Timeout</th><th>Cost</th></tr></thead><tbody>");
    for value in values {
        let id = value_string(&value, "id").unwrap_or_default();
        let name = value_string(&value, "display_name").unwrap_or_else(|| id.clone());
        let category = value_string(&value, "category").unwrap_or_default();
        let source = value_string(&value, "source").unwrap_or_default();
        let loops = value
            .get("loops")
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
            .unwrap_or_default();
        let timeout = value
            .get("timeout_seconds")
            .and_then(Value::as_u64)
            .map(|value| format_seconds(value as f64))
            .unwrap_or_default();
        let expected_cost = value_string(&value, "expected_cost").unwrap_or_default();
        let cost_note = value_string(&value, "cost_note").unwrap_or_default();
        let cost = if cost_note.is_empty() {
            escape_html(&expected_cost)
        } else if expected_cost.is_empty() {
            escape_html(&cost_note)
        } else {
            format!(
                "{}<br><span class=\"muted\">{}</span>",
                escape_html(&expected_cost),
                escape_html(&cost_note)
            )
        };
        out.push_str(&format!(
            "<tr><td>{}<br><span class=\"muted\">{}</span></td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            escape_html(&name),
            escape_html(&id),
            escape_html(&category),
            escape_html(&source),
            escape_html(&loops),
            escape_html(&timeout),
            cost
        ));
    }
    out.push_str("</tbody></table>");
    out
}

fn pre_optional(value: &Option<String>) -> String {
    match value {
        Some(value) if !value.is_empty() => format!("<pre>{}</pre>", escape_html(value)),
        _ => "<p>No content was recorded.</p>".to_owned(),
    }
}

fn status_cell(status: &str) -> String {
    format!(
        "<span class=\"status-{}\">{}</span>",
        escape_html(status),
        escape_html(status)
    )
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    })
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn url_escape(input: &str) -> String {
    input
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{request::Builder as RequestBuilder, Request},
    };
    use tower::ServiceExt;
    use ultrafuzz_core::{NodeStatus, PromptId, RunStatus, StrategyId};
    use ultrafuzz_events::{emit_event, JsonlEventSink, RunEvent, SqliteEventSink};
    use ultrafuzz_state::RunState;
    use ultrafuzz_topology::{PropertyLens, RetryPolicy};

    const LOCAL_DASHBOARD_HOST: &str = "127.0.0.1:3875";
    const LOCAL_DASHBOARD_ORIGIN: &str = "http://127.0.0.1:3875";

    fn local_provenance(builder: RequestBuilder) -> RequestBuilder {
        builder
            .header(header::HOST, LOCAL_DASHBOARD_HOST)
            .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
    }

    #[test]
    fn auth_session_tokens_use_csprng_entropy_and_fixed_length() {
        let mut tokens = BTreeSet::new();

        for _ in 0..8 {
            let token = SessionToken::generate().unwrap().expose();
            assert_eq!(token.len(), SESSION_TOKEN_HEX_LEN);
            assert!(token
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')));
            assert!(tokens.insert(token));
        }
    }

    #[test]
    fn auth_session_token_matching_rejects_invalid_values() {
        let token = SessionToken::generate().unwrap();
        let exposed = token.expose();
        assert!(token.matches(&exposed));
        assert!(token.matches(&exposed.to_ascii_uppercase()));
        assert!(!token.matches(""));
        assert!(!token.matches(&format!("{exposed}00")));

        let mut non_hex = exposed.clone();
        non_hex.replace_range(0..1, "g");
        assert!(!token.matches(&non_hex));

        let other = SessionToken::generate().unwrap();
        assert!(!token.matches(&other.expose()));
    }

    #[test]
    fn default_topology_prompts_use_supported_template_variables() {
        let topology = ultrafuzz_topology::default_project_topology();
        for node in topology.nodes {
            if matches!(
                node.kind,
                TopologyNodeKind::Meta | TopologyNodeKind::Reference
            ) {
                continue;
            }
            let prompt_path = node
                .prompt
                .clone()
                .unwrap_or_else(|| ultrafuzz_topology::default_prompt_path_for_node(&node));
            let markdown = topology_prompt_markdown(&prompt_path).unwrap_or_else(|| {
                panic!(
                    "default topology prompt `{}` is not bundled",
                    prompt_path.display()
                )
            });
            let document = parse_prompt_document(markdown).unwrap();
            validate_supported_template_variables(&document.body).unwrap_or_else(|error| {
                panic!(
                    "default topology prompt `{}` has invalid template variable: {error}",
                    prompt_path.display()
                )
            });
        }

        let fallback = generic_node_prompt_markdown("custom-node", "Custom Node");
        let document = parse_prompt_document(&fallback).unwrap();
        validate_supported_template_variables(&document.body).unwrap();
    }

    #[tokio::test]
    async fn api_run_projects_status_and_strategy_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/run")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["run_id"], "run-1");
        assert_eq!(value["status"], "succeeded");
        assert_eq!(value["findings_count"], 1);
        assert_eq!(
            value["run_metadata"]["strategies"][0]["source"],
            "project-prompt"
        );
        assert_eq!(
            value["run_metadata"]["strategies"][0]["timeout_seconds"],
            1800
        );
        assert_eq!(value["run_metadata"]["default_timeout_seconds"], 1800);
        assert_eq!(
            value["run_metadata"]["node_timeouts"][1]["timeout_seconds"],
            3600
        );
    }

    #[tokio::test]
    async fn api_run_projects_health_and_lineage() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/run")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["health"]["status"], "succeeded");
        assert_eq!(value["health"]["stale"]["status"], "inactive");
        assert_eq!(value["health"]["process_liveness"]["status"], "not-running");
        assert_eq!(value["health"]["artifacts"]["status"], "complete");
        assert_eq!(value["health"]["artifacts"]["present_required"], 2);
        assert_eq!(value["health"]["lineage"]["current_elapsed_seconds"], 3.5);
        assert!(value["health"]["lineage"]["source_runs"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn serves_embedded_dashboard_assets() {
        let require_assets = matches!(
            std::env::var("ULTRAFUZZ_DASHBOARD_REQUIRE_ASSETS").as_deref(),
            Ok("1")
        );
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .header("host", "[::1]:3875")
                    .header("origin", "http://[::1]:3875")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/dashboard")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/html"));
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("/dashboard/assets/dashboard.js"));
        if require_assets {
            assert!(!html.contains("assets have not been built"));
        }

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/dashboard/assets/dashboard.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/javascript"));
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        if require_assets {
            assert!(body.len() > 1024);
        }

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/dashboard/assets/index.css")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/css"));
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        if require_assets {
            assert!(body.len() > 1024);
        }
    }

    #[tokio::test]
    async fn node_page_serves_logs_prompt_and_strategy_source() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/nodes/storage-layout-0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("rendered storage prompt"));
        assert!(html.contains("backend stdout"));
        assert!(html.contains("project-prompt"));
        assert!(html.contains("custom"));
    }

    #[tokio::test]
    async fn events_api_prefers_sqlite_and_sse_endpoint_is_available() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            live_updates: true,
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/events")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert!(value["source"].as_str().unwrap().ends_with("events.sqlite"));
        assert_eq!(value["events"].as_array().unwrap().len(), 2);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/events/stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/event-stream"));
    }

    #[test]
    fn event_stream_sends_initial_refresh_without_replaying_all_events() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let state = DashboardAppState::new(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            live_updates: true,
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let (seen, pending) = initial_event_stream_state(&state);
        assert_eq!(seen, 2);
        assert_eq!(pending.len(), 1);
    }

    #[tokio::test]
    async fn api_flow_projects_react_flow_nodes_edges_and_capabilities() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/flow")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["run"]["run_id"], "run-1");
        assert_eq!(value["nodes"].as_array().unwrap().len(), 6);
        assert_eq!(value["edges"].as_array().unwrap().len(), 5);
        assert_eq!(value["capabilities"]["continueRun"], true);
        assert_eq!(value["capabilities"]["restartFromNode"], false);
        assert_eq!(value["capabilities"]["arbitraryShell"], false);
        let node_types = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|node| node["type"].as_str())
            .collect::<Vec<_>>();
        for expected in [
            "projectDiscovery",
            "foundryHarness",
            "baseTestDiscovery",
            "testAggregation",
        ] {
            assert!(node_types.contains(&expected), "{expected}");
        }
        for stale in ["setup", "analyze", "merge"] {
            assert!(!node_types.contains(&stale), "{stale}");
        }
        let storage_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "storage-layout-0")
            .unwrap();
        assert_eq!(storage_node["data"]["findingCount"], 1);
        assert_eq!(storage_node["data"]["promptAvailable"], true);
        assert_eq!(storage_node["data"]["promptEditable"], true);
        assert_eq!(storage_node["data"]["timeoutSeconds"], 1800);
        let final_report_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "final-report")
            .unwrap();
        assert_eq!(final_report_node["data"]["timeoutSeconds"], 3600);
    }

    #[tokio::test]
    async fn api_flow_counts_property_artifacts_from_catalogs() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_property_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/flow")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        let node_data = |id: &str| {
            value["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["id"] == id)
                .unwrap()["data"]
                .clone()
        };

        let zero_knot_data = node_data("property-specification-0kn0t");
        assert_eq!(
            zero_knot_data["propertySummary"],
            json!({ "count": 2, "kind": "candidates" })
        );
        let certora_data = node_data("property-specification-certora");
        assert_eq!(
            certora_data["propertySummary"],
            json!({ "count": 1, "kind": "candidates" })
        );
        let josselin_data = node_data("property-specification-josselin-feist");
        assert_eq!(
            josselin_data["propertySummary"],
            json!({ "count": 3, "kind": "candidates" })
        );
        let fanin_data = node_data("property-specification-fanin");
        assert_eq!(
            fanin_data["propertySummary"],
            json!({ "count": 3, "kind": "properties" })
        );
        let direct_data = node_data("property-specification");
        assert_eq!(
            direct_data["propertySummary"],
            json!({ "count": 2, "kind": "properties" })
        );
        assert_eq!(fanin_data["findingCount"], 1);
    }

    #[test]
    fn markdown_property_summary_counts_table_rows() {
        let markdown = "\
| property id | property description | category | priority |
| --- | --- | --- | --- |
| p-1 | first property | accounting | high |
| p-2 | second property | access | medium |
";
        assert_eq!(markdown_table_data_row_count(markdown), 2);
    }

    #[tokio::test]
    async fn api_flow_serves_preview_without_project_config_or_runs() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = temp.path().join(".ultrafuzz/runs");
        write_full_preview_topology(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: runs_dir.clone(),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/flow")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["run"]["run_id"], PREVIEW_RUN_ID);
        assert_eq!(value["run"]["mode"], "preview");
        assert_eq!(value["run"]["status"], "pending");
        assert!(value["nodes"].as_array().unwrap().len() > 10);
        assert!(value["edges"].as_array().unwrap().len() > 10);
        assert_eq!(value["capabilities"]["doctor"], true);
        assert_eq!(value["capabilities"]["config"], true);
        assert_eq!(value["capabilities"]["runNewCampaign"], false);
        assert_eq!(value["capabilities"]["continueRun"], false);
        assert_eq!(value["capabilities"]["status"], false);
        let start_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == ultrafuzz_topology::START_NODE_ID)
            .unwrap();
        assert_eq!(start_node["type"], "metaStart");
        assert_eq!(start_node["data"]["label"], "START");
        assert_eq!(start_node["data"]["promptAvailable"], false);
        assert_eq!(start_node["data"]["promptEditable"], false);
        assert_eq!(start_node["data"]["topologyConnectable"], true);
        let finish_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == ultrafuzz_topology::FINISH_NODE_ID)
            .unwrap();
        assert_eq!(finish_node["type"], "metaFinish");
        assert_eq!(finish_node["data"]["label"], "FINISH");
        assert_eq!(finish_node["data"]["promptAvailable"], false);
        assert_eq!(finish_node["data"]["promptEditable"], false);
        assert_eq!(finish_node["data"]["topologyConnectable"], true);
        let decode_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "encode-decode-0")
            .unwrap();
        assert_eq!(decode_node["data"]["promptAvailable"], true);
        assert_eq!(decode_node["data"]["promptEditable"], false);
        assert_eq!(decode_node["data"]["group"], "strategies");
        assert_eq!(decode_node["data"]["groupLabel"], "Strategies");
        assert_eq!(
            decode_node["data"]["promptPath"],
            "strategies/encode-decode.md"
        );
        let zero_knot_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "property-specification-0kn0t")
            .unwrap();
        assert_eq!(zero_knot_node["data"]["promptAvailable"], true);
        assert_eq!(zero_knot_node["data"]["group"], "properties");
        assert_eq!(zero_knot_node["data"]["groupLabel"], "Properties");
        assert_eq!(
            zero_knot_node["data"]["propertySummary"],
            json!({ "count": 0, "kind": "candidates" })
        );
        let fanin_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "property-specification-fanin")
            .unwrap();
        assert_eq!(
            fanin_node["data"]["propertySummary"],
            json!({ "count": 0, "kind": "properties" })
        );
        let triage_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "triage")
            .unwrap();
        assert_eq!(triage_node["data"]["label"], "Triage");
        assert_eq!(triage_node["data"]["kind"], "triage");
        let severity_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "severity-classification")
            .unwrap();
        assert_eq!(severity_node["data"]["label"], "Severity classification");
        assert_eq!(severity_node["data"]["kind"], "severity-classification");
        assert!(value["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| { edge["source"] == "dedupe-findings" && edge["target"] == "triage" }));
        assert!(value["edges"].as_array().unwrap().iter().any(|edge| {
            edge["source"] == "triage" && edge["target"] == "severity-classification"
        }));
        assert!(value["edges"].as_array().unwrap().iter().any(|edge| {
            edge["source"] == "severity-classification" && edge["target"] == "aggregate-test-files"
        }));
        assert!(!runs_dir.exists());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/prompts/strategies/encode-decode")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let prompt: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(prompt["summary"]["editable"], false);
        assert_eq!(prompt["summary"]["category"], "encode-decode");
        assert!(!prompt["content"].as_str().unwrap().contains("\ncategory:"));

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/prompts/strategies")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let prompts: Value = serde_json::from_slice(&body).unwrap();
        let decode_prompt = prompts
            .as_array()
            .unwrap()
            .iter()
            .find(|prompt| prompt["strategyId"] == "encode-decode")
            .unwrap();
        assert_eq!(decode_prompt["category"], "encode-decode");
        assert_eq!(
            decode_prompt["path"],
            ".ultrafuzz/prompts/strategies/encode-decode.md"
        );
        assert_eq!(decode_prompt["editable"], false);
        let boundary_prompt = prompts
            .as_array()
            .unwrap()
            .iter()
            .find(|prompt| prompt["strategyId"] == "boundary-tests")
            .unwrap();
        assert_eq!(boundary_prompt["category"], "property-based");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/prompts/nodes/project-discovery")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let node_prompt: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(node_prompt["summary"]["nodeId"], "project-discovery");
        assert_eq!(node_prompt["summary"]["editable"], false);
        assert!(!node_prompt["content"].as_str().unwrap().is_empty());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/setup/project-discovery.md")
            .exists());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/prompts/nodes/property-specification-0kn0t")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let node_prompt: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            node_prompt["summary"]["nodeId"],
            "property-specification-0kn0t"
        );
        assert!(!node_prompt["summary"]["displayName"]
            .as_str()
            .unwrap()
            .is_empty());

        let session = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(session.into_body(), usize::MAX)
            .await
            .unwrap();
        let session: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            session["templateVariables"],
            json!(SUPPORTED_TEMPLATE_VARIABLES)
        );
        let token = session["sessionToken"].as_str().unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/strategies/encode-decode")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": "# no project yet\n" })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!temp
            .path()
            .join(ultrafuzz_config::CONFIG_FILE_NAME)
            .exists());
        assert!(temp.path().join(".ultrafuzz/prompts").exists());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/config")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "content": ultrafuzz_config::default_config_toml()
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(temp
            .path()
            .join(ultrafuzz_config::CONFIG_FILE_NAME)
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/setup/project-discovery.md")
            .exists());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/flow")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let refreshed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(refreshed["capabilities"]["runNewCampaign"], true);
        let decode_node = refreshed["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "encode-decode-0")
            .unwrap();
        assert_eq!(decode_node["data"]["promptEditable"], true);
    }

    #[tokio::test]
    async fn api_flow_surfaces_topology_default_loop_badge_counts() {
        let temp = tempfile::tempdir().unwrap();
        write_full_preview_topology(temp.path());
        let topology_path = temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE);
        let mut topology: ProjectTopology =
            serde_yaml::from_str(&fs::read_to_string(&topology_path).unwrap()).unwrap();
        topology.defaults.strategy_loops = 5;
        fs::write(&topology_path, serde_yaml::to_string(&topology).unwrap()).unwrap();

        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/flow")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        let invariant_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "stateful-invariant-coverage-0")
            .unwrap();
        assert_eq!(invariant_node["data"]["loopCount"], 3);
        assert_eq!(invariant_node["data"]["loopBadgeCount"], 3);

        let decode_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "encode-decode-0")
            .unwrap();
        assert_eq!(decode_node["data"]["loopCount"], 5);
        assert_eq!(decode_node["data"]["loopBadgeCount"], 5);
        let decode_strategy = value["strategies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|strategy| strategy["id"] == "encode-decode")
            .unwrap();
        assert_eq!(decode_strategy["loops"], 5);
        let dynamic_node = value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "dynamic-strategy-generator")
            .unwrap();
        assert_eq!(dynamic_node["data"]["loopCount"], 1);
        assert!(value["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|node| node["id"] != "dynamic-strategy-generator-0"));
        let dynamic_strategy = value["strategies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|strategy| strategy["id"] == "dynamic-strategy-generator")
            .unwrap();
        assert_eq!(
            dynamic_strategy["display_name"],
            "Dynamic strategy generator"
        );
        assert_eq!(dynamic_strategy["loops"], 1);
        assert_eq!(dynamic_strategy["timeout_seconds"], 14_400);
        assert_eq!(dynamic_strategy["expected_cost"], "high");
        assert!(dynamic_strategy["cost_note"]
            .as_str()
            .unwrap()
            .contains("enumerates up to 3 max-reasoning"));
    }

    #[tokio::test]
    async fn node_prompt_frontmatter_display_name_drives_dashboard_labels() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_full_preview_topology(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let default_node_id = |prompt_path: &str| {
            ultrafuzz_topology::default_project_topology()
                .nodes
                .into_iter()
                .find(|node| {
                    let node_prompt = node
                        .prompt
                        .clone()
                        .unwrap_or_else(|| ultrafuzz_topology::default_prompt_path_for_node(node));
                    node_prompt == Path::new(prompt_path)
                })
                .expect("default topology node exists for prompt")
                .id
                .to_string()
        };
        let discovery_id = default_node_id("setup/project-discovery.md");
        let zero_knot_id = default_node_id("properties/0kn0t-lens.md");
        let aviggiano_id = default_node_id("properties/aviggiano-lens.md");
        let prompt_root = temp.path().join(".ultrafuzz/prompts");
        fs::write(
            prompt_root.join("setup/project-discovery.md"),
            format!(
                "---\nid: {discovery_id}\ndisplay_name: Repository reconnaissance\n---\n# Edited\n"
            ),
        )
        .unwrap();
        fs::write(
            prompt_root.join("properties/0kn0t-lens.md"),
            format!("---\nid: {zero_knot_id}\n---\n# Titleless frontmatter\n"),
        )
        .unwrap();
        fs::write(
            prompt_root.join("properties/aviggiano-lens.md"),
            "---\nid: copied-node\ndisplay_name: Copied node\n---\n# Mismatched frontmatter\n",
        )
        .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/flow")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let flow: Value = serde_json::from_slice(&body).unwrap();
        let flow_label = |id: &str| {
            flow["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["id"] == id)
                .unwrap()["data"]["label"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(flow_label(&discovery_id), "Repository reconnaissance");
        let zero_knot_label = flow_label(&zero_knot_id);
        assert!(!zero_knot_label.is_empty());
        let aviggiano_label = flow_label(&aviggiano_id);
        assert!(!aviggiano_label.is_empty());
        assert_ne!(aviggiano_label, "Copied node");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/nodes/{discovery_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let detail: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(detail["node"]["label"], "Repository reconnaissance");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/graph")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let graph: Value = serde_json::from_slice(&body).unwrap();
        let graph_node = graph["graph"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == discovery_id)
            .unwrap();
        assert_eq!(graph_node["label"], "Repository reconnaissance");
        let final_report_summary = graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "final-report")
            .unwrap();
        assert_eq!(final_report_summary["timeout_seconds"], 3600);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/prompts/nodes/{aviggiano_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let prompt: Value = serde_json::from_slice(&body).unwrap();
        assert!(!prompt["summary"]["displayName"]
            .as_str()
            .unwrap()
            .is_empty());
        assert_ne!(prompt["summary"]["displayName"], "Copied node");

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/prompts/nodes/{discovery_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let prompt: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            prompt["summary"]["displayName"],
            "Repository reconnaissance"
        );
    }

    #[tokio::test]
    async fn api_run_serves_preview_with_empty_runs_directory() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = temp.path().join(".ultrafuzz/runs");
        fs::create_dir_all(&runs_dir).unwrap();
        write_full_preview_topology(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/run")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["run_id"], PREVIEW_RUN_ID);
        assert_eq!(value["mode"], "preview");
        assert_eq!(value["event_count"], 0);
        assert!(value["graph_nodes"].as_u64().unwrap() > 10);
    }

    #[tokio::test]
    async fn preview_with_project_config_allows_run_command_and_prompt_save() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_full_preview_topology(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();
        let topology_prompt_root = temp.path().join(".ultrafuzz/prompts");
        let project_discovery_prompt = topology_prompt_root.join("setup/project-discovery.md");
        let final_report_prompt = topology_prompt_root.join("review/final-report.md");
        assert!(project_discovery_prompt.exists());
        assert!(final_report_prompt.exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/strategies/encode-decode-0.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/nodes/final-report.md")
            .exists());
        for node in ultrafuzz_topology::default_project_topology().nodes {
            if matches!(
                node.kind,
                TopologyNodeKind::Meta | TopologyNodeKind::Reference
            ) {
                continue;
            }
            let relative_path = node
                .prompt
                .clone()
                .unwrap_or_else(|| ultrafuzz_topology::default_prompt_path_for_node(&node));
            let content = fs::read_to_string(topology_prompt_root.join(&relative_path)).unwrap();
            let bundled = topology_prompt_markdown(&relative_path).unwrap_or_else(|| {
                panic!(
                    "default topology prompt `{}` is not bundled",
                    relative_path.display()
                )
            });
            assert_eq!(content, bundled);
        }

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/flow")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let flow: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(flow["run"]["mode"], "preview");
        assert_eq!(flow["capabilities"]["runNewCampaign"], true);
        assert_eq!(flow["capabilities"]["continueRun"], false);
        let decode_node = flow["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "encode-decode-0")
            .unwrap();
        assert_eq!(decode_node["data"]["promptAvailable"], true);
        assert_eq!(decode_node["data"]["promptEditable"], true);

        let session = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(session.into_body(), usize::MAX)
            .await
            .unwrap();
        let session: Value = serde_json::from_slice(&body).unwrap();
        let token = session["sessionToken"].as_str().unwrap();

        let replacement = "---\nid: encode-decode\ndisplay_name: Encode / Decode\n---\n# Edited\n";
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/strategies/encode-decode")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": replacement })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            fs::read_to_string(
                temp.path()
                    .join(".ultrafuzz/prompts/strategies/encode-decode.md")
            )
            .unwrap(),
            replacement
        );

        let node_replacement = "---\nid: project-discovery\ndisplay_name: Project discovery\n---\n# Edited node\n\nWrite {{artifact_path}}/setup/project-discovery.md\n";
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/nodes/project-discovery")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": node_replacement })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            fs::read_to_string(
                temp.path()
                    .join(".ultrafuzz/prompts/setup/project-discovery.md")
            )
            .unwrap(),
            node_replacement
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let config: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(config["path"], "ultrafuzz.toml");
        assert_eq!(config["editable"], true);
        assert!(config["content"]
            .as_str()
            .unwrap()
            .contains("schema_version"));

        let config_replacement = ultrafuzz_config::default_config_toml()
            .replace("max_parallel_agents = 4", "max_parallel_agents = 2");
        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/config")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": config_replacement })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            fs::read_to_string(temp.path().join(ultrafuzz_config::CONFIG_FILE_NAME)).unwrap(),
            config_replacement
        );
    }

    #[tokio::test]
    async fn node_prompt_save_syncs_prompt_outputs_to_required_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_full_preview_topology(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let session = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(session.into_body(), usize::MAX)
            .await
            .unwrap();
        let session: Value = serde_json::from_slice(&body).unwrap();
        let token = session["sessionToken"].as_str().unwrap();

        let replacement = "---\nid: final-report\ndisplay_name: Final Report\n---\nWrite {{artifact_path}}/custom/report.md\n";
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/nodes/final-report")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": replacement })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let topology: ProjectTopology = serde_yaml::from_str(
            &fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from("final-report"))
                .unwrap()
                .required_artifacts,
            vec![PathBuf::from("custom/report.md")]
        );

        let artifact_dir_replacement =
            "---\nid: final-report\ndisplay_name: Final Report\n---\nWrite {{artifact_dir}}/custom/report.json\n";
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/nodes/final-report")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": artifact_dir_replacement }))
                            .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let topology: ProjectTopology = serde_yaml::from_str(
            &fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from("final-report"))
                .unwrap()
                .required_artifacts,
            vec![PathBuf::from("custom/report.json")]
        );

        let removal = "---\nid: final-report\ndisplay_name: Final Report\n---\n# No outputs\n";
        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/nodes/final-report")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": removal })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let topology: ProjectTopology = serde_yaml::from_str(
            &fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap(),
        )
        .unwrap();
        assert!(topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("final-report"))
            .unwrap()
            .required_artifacts
            .is_empty());
    }

    #[tokio::test]
    async fn node_prompt_save_creates_missing_topology_prompt_files() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_full_preview_topology(temp.path());
        for node_id in ["round-trip", "workflow-property-based-tests"] {
            let prompt_path = temp
                .path()
                .join(format!(".ultrafuzz/prompts/strategies/{node_id}.md"));
            fs::remove_file(&prompt_path).unwrap();
            let state = DashboardAppState::new(DashboardServerConfig {
                project_root: temp.path().to_path_buf(),
                runs_dir: temp.path().join(".ultrafuzz/runs"),
                ..DashboardServerConfig::default()
            })
            .unwrap();
            assert!(
                prompt_path.is_file(),
                "dashboard startup should scaffold {node_id}"
            );

            let detail = state.node_prompt_detail(node_id).unwrap();
            let expected = detail.content.clone();
            let saved = state.save_node_prompt(node_id, detail.content).unwrap();

            assert_eq!(
                saved.path,
                format!(".ultrafuzz/prompts/strategies/{node_id}.md")
            );
            assert!(prompt_path.is_file());
            assert_eq!(fs::read_to_string(&prompt_path).unwrap(), expected);
        }
    }

    #[tokio::test]
    async fn node_detail_includes_prompt_discovered_artifact_previews() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_full_preview_topology(temp.path());
        let runs_dir = temp.path().join(".ultrafuzz/runs");
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: runs_dir.clone(),
            ..DashboardServerConfig::default()
        })
        .unwrap();
        let discovery_artifact = runs_dir
            .join(PREVIEW_RUN_ID)
            .join("artifacts/project-discovery/setup/project-discovery.md");
        fs::create_dir_all(discovery_artifact.parent().unwrap()).unwrap();
        fs::write(&discovery_artifact, "# Discovery\n\nContext\n").unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/nodes/setup-foundry")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let detail: Value = serde_json::from_slice(&body).unwrap();
        let outputs = detail["artifactReferences"]["outputs"].as_array().unwrap();
        assert_eq!(outputs[0]["relativePath"], "setup/setup-foundry.md");
        assert_eq!(outputs[0]["state"], "missing");
        let referenced = detail["artifactReferences"]["referencedPrevious"]
            .as_array()
            .unwrap();
        assert_eq!(referenced[0]["relativePath"], "setup/project-discovery.md");
        assert_eq!(referenced[0]["state"], "available");
        assert_eq!(referenced[0]["content"]["kind"], "markdown");
        assert!(referenced[0]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("# Discovery"));
    }

    #[tokio::test]
    async fn node_detail_renders_property_fanin_lens_candidate_artifact_previews() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_property_run(temp.path());
        let prompt_path = temp
            .path()
            .join(".ultrafuzz/prompts/property-specification-fanin.md");
        fs::create_dir_all(prompt_path.parent().unwrap()).unwrap();
        fs::write(
            &prompt_path,
            "---\nid: property-specification-fanin\n---\nRead:\n{{ancestor_artifacts}}\n",
        )
        .unwrap();
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/nodes/property-specification-fanin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let detail: Value = serde_json::from_slice(&body).unwrap();
        let referenced = detail["artifactReferences"]["referencedPrevious"]
            .as_array()
            .unwrap();
        assert_eq!(referenced.len(), 3);
        assert!(referenced.iter().all(|entry| {
            entry["relativePath"].as_str() == Some(PROPERTY_LENS_CANDIDATE_FILE)
                && entry["state"].as_str() == Some("available")
        }));
        assert!(referenced.iter().any(|entry| entry["path"]
            .as_str()
            .unwrap()
            .ends_with("artifacts/property-specification-0kn0t/candidate-properties.json")));
        assert!(referenced.iter().any(|entry| entry["path"]
            .as_str()
            .unwrap()
            .ends_with("artifacts/property-specification-certora/candidate-properties.json")));
        assert!(referenced
            .iter()
            .any(|entry| entry["path"].as_str().unwrap().ends_with(
                "artifacts/property-specification-josselin-feist/candidate-properties.json"
            )));
    }

    #[tokio::test]
    async fn latest_preview_named_run_is_treated_as_persisted() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        fs::rename(runs_dir.join("run-1"), runs_dir.join(PREVIEW_RUN_ID)).unwrap();
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/run")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["run_id"], PREVIEW_RUN_ID);
        assert_eq!(value["mode"], "persisted");
        assert_eq!(value["status"], "succeeded");
    }

    #[test]
    fn dashboard_uses_logical_dependencies_for_series_ancestor_artifacts() {
        let source = fixture_node(
            "source",
            "Source",
            NodeKind::Agentic {
                logical_id: NodeId::from("source"),
                prompt_path: PathBuf::from("source.md"),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: vec![PathBuf::from("source.md")],
                primary_artifact: Some(PathBuf::from("source.md")),
            },
            &[],
        );
        let consumer_0 = fixture_node(
            "consumer-0",
            "Consumer attempt 1",
            NodeKind::Agentic {
                logical_id: NodeId::from("consumer"),
                prompt_path: PathBuf::from("consumer.md"),
                attempt_index: 0,
                loop_count: 2,
                loop_mode: LoopMode::Series,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            &["source"],
        );
        let consumer_1 = fixture_node(
            "consumer-1",
            "Consumer attempt 2",
            NodeKind::Agentic {
                logical_id: NodeId::from("consumer"),
                prompt_path: PathBuf::from("consumer.md"),
                attempt_index: 1,
                loop_count: 2,
                loop_mode: LoopMode::Series,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            &["consumer-0"],
        );
        let graph = CampaignGraph {
            run_id: RunId::from("run-1"),
            graph_version: ultrafuzz_topology::GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![source, consumer_0, consumer_1.clone()],
        };

        assert_eq!(
            direct_dependency_logical_ids_for_dashboard(&graph, &consumer_1),
            vec![NodeId::from("source")]
        );
    }

    #[test]
    fn explicit_missing_run_id_still_errors_instead_of_previewing() {
        let temp = tempfile::tempdir().unwrap();
        let error = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            run_id: Some(RunId::from("missing-run")),
            ..DashboardServerConfig::default()
        })
        .unwrap_err();

        assert!(matches!(error, DashboardError::NotFound(_)));
    }

    #[test]
    fn graph_layers_follow_dependencies_when_nodes_are_reordered() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let graph_path = runs_dir.join("run-1/graph.json");
        let mut graph: CampaignGraph =
            serde_json::from_str(&fs::read_to_string(graph_path).unwrap()).unwrap();
        graph.nodes.reverse();

        let layers = graph_layers(&graph);

        assert_eq!(layers[&NodeId::from("project-discovery")], 0);
        assert_eq!(layers[&NodeId::from("discover-base-test")], 2);
        assert_eq!(layers[&NodeId::from("storage-layout-0")], 3);
        assert_eq!(layers[&NodeId::from("aggregate-test-files")], 4);
        assert_eq!(layers[&NodeId::from("final-report")], 5);
    }

    #[tokio::test]
    async fn api_rejects_unsafe_graph_artifact_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let graph_path = runs_dir.join("run-1/graph.json");
        let mut graph: Value =
            serde_json::from_str(&fs::read_to_string(&graph_path).unwrap()).unwrap();
        graph["nodes"][1]["artifact_dir"] = json!("artifacts/../outside");
        fs::write(&graph_path, serde_json::to_string_pretty(&graph).unwrap()).unwrap();
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/flow")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn api_rejects_symlinked_artifact_files() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let outside = temp.path().join("outside-findings.json");
        fs::write(&outside, "[]\n").unwrap();
        let findings = runs_dir.join("run-1/artifacts/storage-layout-0/findings.json");
        fs::remove_file(&findings).unwrap();
        std::os::unix::fs::symlink(&outside, &findings).unwrap();
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/flow")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn prompt_save_requires_session_token_and_validates_registry_reload() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let strategy_dir = temp.path().join(".ultrafuzz/prompts/strategies");
        fs::create_dir_all(&strategy_dir).unwrap();
        fs::write(
            strategy_dir.join("storage-layout.md"),
            "---\nid: storage-layout\ndisplay_name: Storage Layout\nloops: 1\n---\n# Old\n",
        )
        .unwrap();
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/strategies/storage-layout")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": "# missing token\n" })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let session = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(session.into_body(), usize::MAX)
            .await
            .unwrap();
        let session: Value = serde_json::from_slice(&body).unwrap();
        let token = session["sessionToken"].as_str().unwrap();

        let replacement =
            "---\nid: storage-layout\ndisplay_name: Storage Layout\nloops: 1\n---\n# New prompt\n";
        let invalid =
            "---\nid: storage-layout\ndisplay_name: Storage Layout\nloops: 1\n---\n# Bad\n{{artifacts_path}}\n";
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/strategies/storage-layout")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": invalid })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(body.contains("artifacts_path"));
        assert_eq!(
            fs::read_to_string(strategy_dir.join("storage-layout.md")).unwrap(),
            "---\nid: storage-layout\ndisplay_name: Storage Layout\nloops: 1\n---\n# Old\n"
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/strategies/storage-layout")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": replacement })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            fs::read_to_string(strategy_dir.join("storage-layout.md")).unwrap(),
            replacement
        );
        assert!(temp
            .path()
            .join(".ultrafuzz/dashboard-audit.jsonl")
            .exists());
    }

    #[test]
    fn topology_save_validates_groups_and_creates_missing_prompts() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_minimal_preview_topology(temp.path());
        let state = DashboardAppState::new(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let topology = ProjectTopology {
            version: ultrafuzz_topology::TOPOLOGY_VERSION,
            defaults: ultrafuzz_topology::TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![
                dashboard_meta_node(MetaNodeRole::Start, &[]),
                TopologyNode {
                    id: NodeId::from("custom-node"),
                    kind: TopologyNodeKind::Agentic,
                    role: None,
                    prompt: Some(PathBuf::from("custom/custom-node.md")),
                    reference: None,
                    group: Some("custom".to_owned()),
                    depends_on: vec![NodeId::from(ultrafuzz_topology::START_NODE_ID)],
                    loops: 1,
                    loop_mode: ultrafuzz_topology::LoopMode::Parallel,
                    timeout_seconds: None,
                    required_artifacts: Vec::new(),
                    primary_artifact: None,
                },
                dashboard_meta_node(MetaNodeRole::Finish, &["custom-node"]),
            ],
        };

        state
            .save_topology(SaveTopologyRequest {
                content: None,
                topology: Some(topology),
            })
            .unwrap();

        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/custom/custom-node.md")
            .exists());

        let stale_finish_topology = ProjectTopology {
            version: ultrafuzz_topology::TOPOLOGY_VERSION,
            defaults: ultrafuzz_topology::TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![
                dashboard_meta_node(MetaNodeRole::Start, &[]),
                dashboard_topology_node(
                    "custom-node",
                    "custom/custom-node.md",
                    &[ultrafuzz_topology::START_NODE_ID],
                    1,
                ),
                dashboard_topology_node("follow-up", "custom/follow-up.md", &["custom-node"], 1),
                dashboard_meta_node(MetaNodeRole::Finish, &["custom-node"]),
            ],
        };

        state
            .save_topology(SaveTopologyRequest {
                content: None,
                topology: Some(stale_finish_topology),
            })
            .unwrap();
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/custom/follow-up.md")
            .exists());
        let saved_topology: ProjectTopology = serde_yaml::from_str(
            &fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap(),
        )
        .unwrap();
        let finish = saved_topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from(ultrafuzz_topology::FINISH_NODE_ID))
            .unwrap();
        assert_eq!(finish.depends_on, vec![NodeId::from("follow-up")]);

        let missing_meta_topology = ProjectTopology {
            version: ultrafuzz_topology::TOPOLOGY_VERSION,
            defaults: ultrafuzz_topology::TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![dashboard_topology_node(
                "missing-meta-node",
                "custom/missing-meta-node.md",
                &[],
                1,
            )],
        };
        state
            .save_topology(SaveTopologyRequest {
                content: None,
                topology: Some(missing_meta_topology),
            })
            .unwrap();
        let saved_topology: ProjectTopology = serde_yaml::from_str(
            &fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap(),
        )
        .unwrap();
        assert!(saved_topology.nodes.iter().any(|node| node.id
            == NodeId::from(ultrafuzz_topology::START_NODE_ID)
            && node.kind == TopologyNodeKind::Meta
            && node.role == Some(MetaNodeRole::Start)));
        let repaired_node = saved_topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("missing-meta-node"))
            .unwrap();
        assert_eq!(
            repaired_node.depends_on,
            vec![NodeId::from(ultrafuzz_topology::START_NODE_ID)]
        );
        let finish = saved_topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from(ultrafuzz_topology::FINISH_NODE_ID))
            .unwrap();
        assert_eq!(finish.depends_on, vec![NodeId::from("missing-meta-node")]);

        let raw_missing_meta = r#"
version: 1
defaults:
  strategy_loops: 3
nodes:
- id: raw-node
  prompt: custom/raw-node.md
  depends_on: []
"#;
        let error = state
            .save_topology(SaveTopologyRequest {
                content: Some(raw_missing_meta.to_owned()),
                topology: None,
            })
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("missing required topology meta-node `__start__`"));

        let invalid = ProjectTopology {
            version: ultrafuzz_topology::TOPOLOGY_VERSION,
            defaults: ultrafuzz_topology::TopologyDefaults::default(),
            groups: BTreeMap::from([(
                "custom".to_owned(),
                ultrafuzz_topology::TopologyGroup {
                    label: Some("Custom".to_owned()),
                    color: Some("blue".to_owned()),
                },
            )]),
            nodes: vec![TopologyNode {
                id: NodeId::from("custom-node"),
                kind: TopologyNodeKind::Agentic,
                role: None,
                prompt: Some(PathBuf::from("custom/custom-node.md")),
                reference: None,
                group: Some("custom".to_owned()),
                depends_on: Vec::new(),
                loops: 1,
                loop_mode: ultrafuzz_topology::LoopMode::Parallel,
                timeout_seconds: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            }],
        };

        let error = state
            .save_topology(SaveTopologyRequest {
                content: None,
                topology: Some(invalid),
            })
            .unwrap_err();
        assert!(error.to_string().contains("invalid topology group color"));
    }

    #[cfg(unix)]
    #[test]
    fn topology_detail_rejects_symlinked_topology_file() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        fs::create_dir_all(temp.path().join(".ultrafuzz")).unwrap();
        let outside = temp.path().join("outside-topology.yml");
        fs::write(&outside, "version: 1\nnodes: []\n").unwrap();
        std::os::unix::fs::symlink(
            &outside,
            temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE),
        )
        .unwrap();
        let run_id = RunId::from("run-1");
        let project_root = temp.path().to_path_buf();
        let runs_dir = project_root.join(".ultrafuzz/runs");
        let state = DashboardAppState {
            project_root: project_root.clone(),
            run_root: runs_dir.join(run_id.as_str()),
            runs_dir,
            run_id: run_id.clone(),
            source: DashboardRunSource::Persisted,
            live_updates: false,
            session_token: Arc::new(SessionToken::generate().unwrap()),
            command_jobs: Arc::new(Mutex::new(BTreeMap::new())),
        };

        let error = state.topology_detail().unwrap_err();
        assert!(error.to_string().contains("may not contain symlinks"));
    }

    #[tokio::test]
    async fn node_prompt_save_accepts_normal_edits_and_frontmatter_renames() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_full_preview_topology(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let old_prompt_path = temp
            .path()
            .join(".ultrafuzz/prompts/setup/project-discovery.md");
        let normal_edit = "---\nid: project-discovery\ndisplay_name: Project discovery\n---\n# Edited node\n\nWrite {{artifact_path}}/setup/project-discovery.md\n";

        let session = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(session.into_body(), usize::MAX)
            .await
            .unwrap();
        let session: Value = serde_json::from_slice(&body).unwrap();
        let token = session["sessionToken"].as_str().unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/nodes/project-discovery")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": normal_edit })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(fs::read_to_string(&old_prompt_path).unwrap(), normal_edit);

        let renamed = "---\nid: repository-scan\ndisplay_name: Project discovery\n---\n# Renamed node\n\nWrite {{artifact_path}}/setup/repository-scan.md\n";
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/nodes/project-discovery")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": renamed })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let saved: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(saved["nodeId"], "repository-scan");
        assert_eq!(saved["renamedFrom"], "project-discovery");
        assert!(!old_prompt_path.exists());
        let new_prompt_path = temp
            .path()
            .join(".ultrafuzz/prompts/setup/repository-scan.md");
        assert_eq!(fs::read_to_string(&new_prompt_path).unwrap(), renamed);
        let dependent_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/setup/prepare-foundry-harness.md"),
        )
        .unwrap();
        assert!(dependent_prompt.contains("{{artifact_handoff:repository-scan}}"));
        assert!(!dependent_prompt.contains("project-discovery"));

        let topology: ProjectTopology = serde_yaml::from_str(
            &fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap(),
        )
        .unwrap();
        assert!(topology
            .nodes
            .iter()
            .any(|node| node.id == NodeId::from("repository-scan")));
        assert!(!topology
            .nodes
            .iter()
            .any(|node| node.id == NodeId::from("project-discovery")));
        let actors_flows = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("actors-flows"))
            .unwrap();
        assert_eq!(
            actors_flows.depends_on,
            vec![NodeId::from("repository-scan")]
        );
        let prepare = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("setup-foundry"))
            .unwrap();
        assert_eq!(prepare.depends_on, vec![NodeId::from("actors-flows")]);
        let audit =
            fs::read_to_string(temp.path().join(".ultrafuzz/dashboard-audit.jsonl")).unwrap();
        assert!(audit.contains("\"kind\":\"node-prompt-rename\""));
        assert!(audit.contains("\"old_id\":\"project-discovery\""));
        assert!(audit.contains("\"new_id\":\"repository-scan\""));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/prompts/nodes/repository-scan")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let prompt: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(prompt["summary"]["nodeId"], "repository-scan");
        assert_eq!(prompt["content"], renamed);
    }

    #[test]
    fn node_prompt_rename_preserves_custom_prompt_path() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        let custom_prompt = temp.path().join(".ultrafuzz/prompts/custom/manual.md");
        fs::create_dir_all(custom_prompt.parent().unwrap()).unwrap();
        fs::write(
            &custom_prompt,
            "---\nid: custom-node\ndisplay_name: Custom Node\n---\n# Custom\n",
        )
        .unwrap();
        write_project_topology(
            temp.path(),
            dashboard_topology_with_start_finish(vec![dashboard_topology_node(
                "custom-node",
                "custom/manual.md",
                &[],
                1,
            )]),
        );
        let state = DashboardAppState::new(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let renamed = "---\nid: renamed-custom\ndisplay_name: Custom Node\n---\n# Custom renamed\n";
        let saved = state
            .save_node_prompt("custom-node", renamed.to_owned())
            .unwrap();

        assert_eq!(saved.node_id, "renamed-custom");
        assert_eq!(fs::read_to_string(&custom_prompt).unwrap(), renamed);
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/custom/renamed-custom.md")
            .exists());
        let topology: ProjectTopology = serde_yaml::from_str(
            &fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap(),
        )
        .unwrap();
        let node = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("renamed-custom"))
            .unwrap();
        assert_eq!(node.prompt, Some(PathBuf::from("custom/manual.md")));
    }

    #[test]
    fn node_prompt_rename_rejects_invalid_duplicate_and_concrete_collisions() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_full_preview_topology(temp.path());
        let state = DashboardAppState::new(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();
        let old_prompt_path = temp
            .path()
            .join(".ultrafuzz/prompts/setup/project-discovery.md");
        let old_prompt = fs::read_to_string(&old_prompt_path).unwrap();
        let old_topology =
            fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap();

        let invalid = "---\nid: Invalid Node\ndisplay_name: Project discovery\n---\n# Invalid\n";
        let error = state
            .save_node_prompt("project-discovery", invalid.to_owned())
            .unwrap_err();
        assert!(error.to_string().contains("lowercase ASCII"));
        assert_eq!(fs::read_to_string(&old_prompt_path).unwrap(), old_prompt);
        assert_eq!(
            fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap(),
            old_topology
        );

        let duplicate =
            "---\nid: final-report\ndisplay_name: Project discovery\n---\n# Duplicate\n";
        let error = state
            .save_node_prompt("project-discovery", duplicate.to_owned())
            .unwrap_err();
        assert!(error.to_string().contains("already exists"));
        assert_eq!(fs::read_to_string(&old_prompt_path).unwrap(), old_prompt);

        let loop_prompt = temp.path().join(".ultrafuzz/prompts/review/loop-source.md");
        fs::write(
            &loop_prompt,
            "---\nid: loop-source\ndisplay_name: Loop Source\n---\n# Loop\n",
        )
        .unwrap();
        let collision_prompt = temp.path().join(".ultrafuzz/prompts/review/renamed-0.md");
        fs::write(
            &collision_prompt,
            "---\nid: renamed-0\ndisplay_name: Collision\n---\n# Collision\n",
        )
        .unwrap();
        write_project_topology(
            temp.path(),
            dashboard_topology_with_start_finish(vec![
                dashboard_topology_node("loop-source", "review/loop-source.md", &[], 2),
                dashboard_topology_node("renamed-0", "review/renamed-0.md", &[], 1),
            ]),
        );
        let collision_state = DashboardAppState::new(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();
        let error = collision_state
            .save_node_prompt(
                "loop-source-0",
                "---\nid: renamed\ndisplay_name: Loop Source\n---\n# Collision\n".to_owned(),
            )
            .unwrap_err();
        assert!(error.to_string().contains("collides"));
        assert!(loop_prompt.exists());
        assert_eq!(
            fs::read_to_string(&loop_prompt).unwrap(),
            "---\nid: loop-source\ndisplay_name: Loop Source\n---\n# Loop\n"
        );
    }

    #[test]
    fn node_prompt_rename_rolls_back_when_preview_refresh_fails() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_minimal_preview_topology(temp.path());
        let runs_dir = fixture_run(temp.path());
        let state = DashboardAppState::new(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();
        fs::write(
            temp.path().join(ultrafuzz_config::CONFIG_FILE_NAME),
            "not = [valid",
        )
        .unwrap();
        let old_prompt_path = temp
            .path()
            .join(".ultrafuzz/prompts/setup/project-discovery.md");
        let old_prompt = fs::read_to_string(&old_prompt_path).unwrap();
        let old_topology =
            fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap();

        let error = state
            .save_node_prompt(
                "project-discovery",
                "---\nid: rollback-scan\ndisplay_name: Project discovery\n---\n# Rename\n"
                    .to_owned(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("preview config"));
        assert_eq!(fs::read_to_string(&old_prompt_path).unwrap(), old_prompt);
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/setup/rollback-scan.md")
            .exists());
        assert_eq!(
            fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap(),
            old_topology
        );
    }

    #[test]
    fn looped_concrete_node_prompt_rename_returns_remapped_attempt() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        let prompt_path = temp.path().join(".ultrafuzz/prompts/review/loop-source.md");
        fs::create_dir_all(prompt_path.parent().unwrap()).unwrap();
        fs::write(
            &prompt_path,
            "---\nid: loop-source\ndisplay_name: Loop Source\n---\n# Loop\n",
        )
        .unwrap();
        write_project_topology(
            temp.path(),
            dashboard_topology_with_start_finish(vec![dashboard_topology_node(
                "loop-source",
                "review/loop-source.md",
                &[],
                2,
            )]),
        );
        let state = DashboardAppState::new(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let saved = state
            .save_node_prompt(
                "loop-source-1",
                "---\nid: loop-renamed\ndisplay_name: Loop Source\n---\n# Loop renamed\n"
                    .to_owned(),
            )
            .unwrap();

        assert_eq!(saved.node_id, "loop-renamed-1");
        assert!(!prompt_path.exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/review/loop-renamed.md")
            .exists());
        let graph = state.current_preview().unwrap().graph;
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.id == NodeId::from("loop-renamed-0")));
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.id == NodeId::from("loop-renamed-1")));
    }

    #[test]
    fn create_node_prompt_uses_markdown_frontmatter_identity() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_minimal_preview_topology(temp.path());
        let state = DashboardAppState::new(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();
        let content = "---\nid: new-review\ndisplay_name: New Review\n---\n# New Review\n";

        let saved = state
            .create_node_prompt(CreateNodePromptRequest {
                content: content.to_owned(),
                group: Some("review".to_owned()),
                depends_on: Vec::new(),
            })
            .unwrap();

        assert_eq!(saved.node_id, "new-review");
        assert_eq!(
            fs::read_to_string(temp.path().join(".ultrafuzz/prompts/review/new-review.md"))
                .unwrap(),
            content
        );
        let topology: ProjectTopology = serde_yaml::from_str(
            &fs::read_to_string(temp.path().join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE))
                .unwrap(),
        )
        .unwrap();
        let node = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("new-review"))
            .unwrap();
        assert_eq!(node.prompt, None);
        assert_eq!(node.group, Some("review".to_owned()));
        assert_eq!(
            node.depends_on,
            vec![NodeId::from(ultrafuzz_topology::START_NODE_ID)]
        );
        let finish = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from(ultrafuzz_topology::FINISH_NODE_ID))
            .unwrap();
        assert_eq!(
            finish.depends_on,
            vec![
                NodeId::from("project-discovery"),
                NodeId::from("new-review")
            ]
        );
    }

    #[tokio::test]
    async fn built_in_prompt_save_rejects_mismatched_frontmatter() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_config::write_default_config(temp.path(), false).unwrap();
        write_minimal_preview_topology(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir: temp.path().join(".ultrafuzz/runs"),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let session = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(session.into_body(), usize::MAX)
            .await
            .unwrap();
        let session: Value = serde_json::from_slice(&body).unwrap();
        let token = session["sessionToken"].as_str().unwrap();

        let mismatched =
            "---\nid: other-strategy\ndisplay_name: Other Strategy\n---\n# Wrong strategy\n";
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/prompts/strategies/encode-decode")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "content": mismatched })).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let decode_prompt = temp
            .path()
            .join(".ultrafuzz/prompts/strategies/encode-decode.md");
        let restored_prompt = fs::read_to_string(&decode_prompt).unwrap();
        assert!(restored_prompt.contains("id: encode-decode"));
        assert!(!restored_prompt.contains("other-strategy"));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/prompts/strategies/encode-decode")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let prompt: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(prompt["summary"]["source"], "project-prompt");
    }

    #[tokio::test]
    async fn auth_mutating_routes_require_local_provenance_and_valid_token() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let session = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(session.into_body(), usize::MAX)
            .await
            .unwrap();
        let session: Value = serde_json::from_slice(&body).unwrap();
        let token = session["sessionToken"].as_str().unwrap();
        assert_eq!(token.len(), SESSION_TOKEN_HEX_LEN);

        let config_body = || {
            Body::from(
                serde_json::to_vec(&json!({
                    "content": ultrafuzz_config::default_config_toml()
                }))
                .unwrap(),
            )
        };

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/config")
                    .header("content-type", "application/json")
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(config_body())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/config")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(config_body())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/config")
                    .header("content-type", "application/json")
                    .header(header::HOST, "evil.test:3875")
                    .header(header::ORIGIN, LOCAL_DASHBOARD_ORIGIN)
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(config_body())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/config")
                    .header("content-type", "application/json")
                    .header(header::HOST, LOCAL_DASHBOARD_HOST)
                    .header(header::ORIGIN, "http://evil.test")
                    .header(DASHBOARD_SESSION_HEADER, token)
                    .body(config_body())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .clone()
            .oneshot(
                local_provenance(
                    Request::builder()
                        .method("PUT")
                        .uri("/api/config")
                        .header("content-type", "application/json")
                        .header(DASHBOARD_SESSION_HEADER, "0".repeat(SESSION_TOKEN_HEX_LEN)),
                )
                .body(config_body())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = app
            .oneshot(
                local_provenance(
                    Request::builder()
                        .method("PUT")
                        .uri("/api/config")
                        .header("content-type", "application/json")
                        .header(DASHBOARD_SESSION_HEADER, token),
                )
                .body(config_body())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn session_endpoint_rejects_non_loopback_host_and_origin() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .header("host", "evil.test:3875")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .header("host", "127.0.0.1:3875")
                    .header("origin", "http://evil.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn api_read_endpoints_reject_non_loopback_host_and_origin() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/run")
                    .header("host", "evil.test:3875")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header("host", "127.0.0.1:3875")
                    .header("origin", "http://evil.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn stream_endpoints_reject_non_loopback_host_and_origin() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let app = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            live_updates: true,
            ..DashboardServerConfig::default()
        })
        .unwrap();

        for uri in ["/api/events/stream", "/api/commands/stream"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header("host", "evil.test:3875")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");

            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header("host", "127.0.0.1:3875")
                        .header("origin", "http://evil.test")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
        }
    }

    #[test]
    fn rejects_non_loopback_hosts() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let error = app(DashboardServerConfig {
            host: "0.0.0.0".to_owned(),
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap_err();

        assert!(matches!(error, DashboardError::NonLoopbackHost(_)));
    }

    #[test]
    fn rejects_dashboard_run_id_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = fixture_run(temp.path());
        let error = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::new_unchecked("../run-1")),
            ..DashboardServerConfig::default()
        })
        .unwrap_err();

        assert!(matches!(error, DashboardError::BadRequest(_)));
        assert!(error.to_string().contains("path separators"));
    }

    #[test]
    fn ensure_path_inside_rejects_parent_traversal_after_normalization() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();

        let candidate = root.join("../outside/secret.txt");
        let error = ensure_path_inside(&root, &candidate).unwrap_err();

        assert!(matches!(error, DashboardError::BadRequest(_)));
        assert!(error.to_string().contains("outside"));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_path_inside_rejects_symlink_adjacent_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked-outside")).unwrap();

        let candidate = root.join("linked-outside/missing.txt");
        let error = ensure_path_inside(&root, &candidate).unwrap_err();

        assert!(matches!(error, DashboardError::BadRequest(_)));
        assert!(error.to_string().contains("outside"));
    }

    #[test]
    fn artifact_directories_must_stay_under_artifacts() {
        let error = validate_artifact_dir(Path::new("artifacts/../outside")).unwrap_err();
        assert!(error.to_string().contains("traversal"));

        let error = validate_artifact_dir(Path::new("logs/node")).unwrap_err();
        assert!(error.to_string().contains("under artifacts"));
    }

    #[test]
    fn severity_classified_findings_are_dashboard_findings_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_dir = temp.path().join("severity-classification");
        fs::create_dir_all(&artifact_dir).unwrap();
        fs::write(
            artifact_dir.join(SEVERITY_CLASSIFIED_FINDINGS_FILE),
            r#"[{"id":"UF-0001","severity":"high"}]"#,
        )
        .unwrap();

        assert_eq!(artifact_kind(SEVERITY_CLASSIFIED_FINDINGS_FILE), "findings");
        assert_eq!(artifact_kind(FINDING_LIFECYCLE_LEDGER_FILE), "findings");
        assert!(artifact_availability(&artifact_dir).findings);

        let findings = node_findings(&artifact_dir).unwrap();
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0]["id"], "UF-0001");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_run_roots_outside_runs_dir() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = temp.path().join("runs");
        let outside = temp.path().join("outside-run");
        fs::create_dir_all(&runs_dir).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, runs_dir.join("linked-run")).unwrap();

        let error = app(DashboardServerConfig {
            project_root: temp.path().to_path_buf(),
            runs_dir,
            run_id: Some(RunId::from("linked-run")),
            ..DashboardServerConfig::default()
        })
        .unwrap_err();

        assert!(matches!(error, DashboardError::BadRequest(_)));
        assert!(error
            .to_string()
            .contains("resolves outside runs directory"));
    }

    #[cfg(unix)]
    #[test]
    fn prompt_paths_reject_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let strategy_dir = temp.path().join(".ultrafuzz/prompts/strategies");
        fs::create_dir_all(&strategy_dir).unwrap();
        let outside = temp.path().join("outside.md");
        fs::write(&outside, "# outside\n").unwrap();
        let link = strategy_dir.join("linked.md");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let error = ensure_prompt_source_path(temp.path(), &link).unwrap_err();
        assert!(error.to_string().contains("may not contain symlinks"));

        let error = load_prompt_registry(temp.path()).unwrap_err();
        assert!(error.to_string().contains("may not contain symlinks"));
    }

    #[test]
    fn command_args_are_typed_and_confirm_dangerous_actions() {
        let args =
            build_command_args("status", &RunId::from("run-1"), CommandRequest::default()).unwrap();
        assert_eq!(args, vec!["status", "run-1"]);

        let args = build_command_args(
            "run",
            &RunId::from("run-1"),
            CommandRequest {
                backend: Some("claude".to_owned()),
                ..CommandRequest::default()
            },
        )
        .unwrap();
        assert_eq!(args, vec!["run", "--backend", "claude-code-cli"]);

        let error = build_command_args(
            "doctor",
            &RunId::from("run-1"),
            CommandRequest {
                backend: Some("unsupported".to_owned()),
                ..CommandRequest::default()
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("unsupported backend"));

        let error = build_command_args(
            "materialize",
            &RunId::from("run-1"),
            CommandRequest {
                patches: vec!["../outside.patch".to_owned()],
                confirmed: Some(true),
                ..CommandRequest::default()
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("must be a safe relative path"));

        let error = build_command_args("clean", &RunId::from("run-1"), CommandRequest::default())
            .unwrap_err();
        assert!(error.to_string().contains("requires confirmed"));
    }

    #[test]
    fn state_timestamp_seconds_accepts_epoch_and_rfc3339_timestamps() {
        assert_eq!(state_timestamp_seconds("1.250Z"), Some(1.25));
        assert_eq!(
            state_timestamp_seconds("1970-01-01T00:00:01.250Z"),
            Some(1.25)
        );
    }

    #[test]
    fn command_jobs_are_pruned_and_output_is_bounded() {
        let mut jobs = BTreeMap::new();
        jobs.insert(
            "active".to_owned(),
            test_command_job("active", "running", 0, String::new()),
        );
        for index in 1..=(MAX_COMMAND_JOBS + 5) {
            jobs.insert(
                format!("job-{index:03}"),
                test_command_job(
                    &format!("job-{index:03}"),
                    "succeeded",
                    index as u64,
                    "ok".to_owned(),
                ),
            );
        }

        prune_command_jobs(&mut jobs);

        assert_eq!(jobs.len(), MAX_COMMAND_JOBS);
        assert!(jobs.contains_key("active"));
        assert!(!jobs.contains_key("job-001"));
        assert!(jobs.contains_key(&format!("job-{:03}", MAX_COMMAND_JOBS + 5)));

        let output = truncate_command_output("a".repeat(MAX_COMMAND_JOB_OUTPUT_BYTES + 1024));
        assert!(output.len() <= MAX_COMMAND_JOB_OUTPUT_BYTES);
        assert!(output.starts_with(COMMAND_JOB_OUTPUT_TRUNCATED_PREFIX));
    }

    fn test_command_job(job_id: &str, status: &str, started_at: u64, output: String) -> CommandJob {
        CommandJob {
            job_id: job_id.to_owned(),
            command: "status".to_owned(),
            status: status.to_owned(),
            started_at_unix_seconds: started_at,
            finished_at_unix_seconds: Some(started_at + 1),
            argv: vec!["ultrafuzz".to_owned(), "status".to_owned()],
            output,
            error: None,
            exit_code: Some(0),
        }
    }

    fn fixture_run(root: &Path) -> PathBuf {
        let runs_dir = root.join("runs");
        let run_root = runs_dir.join("run-1");
        fs::create_dir_all(run_root.join("artifacts/storage-layout-0")).unwrap();
        fs::create_dir_all(run_root.join("artifacts/final-report")).unwrap();

        let run_id = RunId::from("run-1");
        let graph = CampaignGraph {
            run_id: run_id.clone(),
            graph_version: ultrafuzz_topology::GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![
                fixture_node(
                    "project-discovery",
                    "Project discovery",
                    NodeKind::ProjectDiscovery,
                    &[],
                ),
                fixture_node(
                    "prepare-foundry-harness",
                    "Prepare Foundry harness",
                    NodeKind::PrepareFoundryHarness,
                    &["project-discovery"],
                ),
                fixture_node(
                    "discover-base-test",
                    "Discover base test",
                    NodeKind::DiscoverBaseTest,
                    &["prepare-foundry-harness"],
                ),
                fixture_node_with_timeout(
                    "storage-layout-0",
                    "Storage Layout attempt 1",
                    NodeKind::AgentAttempt {
                        strategy: StrategyId::from("storage-layout"),
                        attempt_index: 0,
                        model_id: ultrafuzz_core::ModelProfileId::from("default"),
                        model_index: 0,
                        loop_index: 0,
                        prompt_id: PromptId::from("storage-layout"),
                    },
                    &["discover-base-test"],
                    1800,
                ),
                fixture_node(
                    "aggregate-test-files",
                    "Aggregate test files",
                    NodeKind::AggregateTestFiles,
                    &["storage-layout-0"],
                ),
                fixture_node_with_timeout(
                    "final-report",
                    "Generate report",
                    NodeKind::Agentic {
                        logical_id: NodeId::from("final-report"),
                        prompt_path: PathBuf::from("review/final-report.md"),
                        attempt_index: 0,
                        loop_count: 1,
                        loop_mode: LoopMode::Series,
                        group: Some("review".to_owned()),
                        required_artifacts: vec![
                            PathBuf::from(REPORT_MD_FILE),
                            PathBuf::from(REPORT_JSON_FILE),
                        ],
                        primary_artifact: Some(PathBuf::from(REPORT_MD_FILE)),
                    },
                    &["aggregate-test-files"],
                    3600,
                ),
            ],
        };
        fs::write(
            run_root.join("graph.json"),
            serde_json::to_string_pretty(&graph).unwrap(),
        )
        .unwrap();

        let mut state = RunState::from_graph(
            run_id.clone(),
            &graph,
            "graph".to_owned(),
            "config".to_owned(),
            None,
        );
        state.status = RunStatus::Succeeded;
        state.started_at = Some("1.000Z".to_owned());
        state.finished_at = Some("4.500Z".to_owned());
        for node in state.nodes.values_mut() {
            node.status = NodeStatus::Succeeded;
        }
        RunStateStore::for_run_root(&run_root).save(&state).unwrap();

        fs::write(
            run_root.join("run.json"),
            serde_json::to_string_pretty(&json!({
                "run_id": "run-1",
                "strategies": [{
                    "id": "storage-layout",
                    "display_name": "Storage Layout",
                    "category": "custom",
                    "source": "project-prompt",
                    "loops": 1,
                    "timeout_seconds": 1800
                }],
                "default_timeout_seconds": 1800,
                "node_timeouts": [
                    {
                        "id": "storage-layout-0",
                        "label": "Storage Layout attempt 1",
                        "logical_id": "storage-layout",
                        "timeout_seconds": 1800
                    },
                    {
                        "id": "final-report",
                        "label": "Generate report",
                        "logical_id": "final-report",
                        "timeout_seconds": 3600
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let attempt_dir = run_root.join("artifacts/storage-layout-0");
        fs::write(attempt_dir.join(STDOUT_LOG), "backend stdout\n").unwrap();
        fs::write(attempt_dir.join(STDERR_LOG), "").unwrap();
        fs::write(
            attempt_dir.join(RENDERED_PROMPT),
            "# rendered storage prompt\n",
        )
        .unwrap();
        fs::write(
            attempt_dir.join(FINDINGS_FILE),
            serde_json::to_string_pretty(&json!([{
                "id": "UF-0001",
                "title": "Storage collision",
                "status": "needs-review",
                "severity_guess": "high",
                "strategy": "storage-layout",
                "summary": "summary"
            }]))
            .unwrap(),
        )
        .unwrap();
        fs::write(attempt_dir.join("metadata.json"), "{}").unwrap();

        let final_dir = run_root.join("artifacts/final-report");
        fs::write(final_dir.join(REPORT_MD_FILE), "# Report\n").unwrap();
        fs::write(
            final_dir.join(REPORT_JSON_FILE),
            serde_json::to_string_pretty(&json!({
                "findings": [{
                    "id": "UF-0001",
                    "title": "Storage collision",
                    "status": "needs-review",
                    "severity_guess": "high",
                    "strategy": "storage-layout",
                    "summary": "summary"
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        let jsonl = JsonlEventSink::new(run_root.join("events.jsonl"));
        let sqlite = SqliteEventSink::new(run_root.join("events.sqlite"));
        emit_event(&jsonl, &run_id, RunEvent::RunStarted).unwrap();
        emit_event(
            &jsonl,
            &run_id,
            RunEvent::NodeStarted {
                node_id: NodeId::from("storage-layout-0"),
            },
        )
        .unwrap();
        emit_event(&sqlite, &run_id, RunEvent::RunStarted).unwrap();
        emit_event(
            &sqlite,
            &run_id,
            RunEvent::NodeStarted {
                node_id: NodeId::from("storage-layout-0"),
            },
        )
        .unwrap();

        runs_dir
    }

    fn fixture_property_run(root: &Path) -> PathBuf {
        let runs_dir = root.join("runs");
        let run_root = runs_dir.join("run-1");
        for artifact_dir in [
            "project-discovery",
            "property-specification-0kn0t",
            "property-specification-certora",
            "property-specification-josselin-feist",
            "property-specification-fanin",
            "property-specification",
        ] {
            fs::create_dir_all(run_root.join("artifacts").join(artifact_dir)).unwrap();
        }

        let run_id = RunId::from("run-1");
        let graph = CampaignGraph {
            run_id: run_id.clone(),
            graph_version: ultrafuzz_topology::GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![
                fixture_node(
                    "project-discovery",
                    "Project discovery",
                    NodeKind::ProjectDiscovery,
                    &[],
                ),
                fixture_node(
                    "property-specification-0kn0t",
                    "0kN0t lens",
                    NodeKind::PropertySpecificationLens {
                        lens: PropertyLens::ZeroKnot,
                    },
                    &["project-discovery"],
                ),
                fixture_node(
                    "property-specification-certora",
                    "Certora Thinking lens",
                    NodeKind::PropertySpecificationLens {
                        lens: PropertyLens::CertoraThinking,
                    },
                    &["project-discovery"],
                ),
                fixture_node(
                    "property-specification-josselin-feist",
                    "Josselin Feist lens",
                    NodeKind::PropertySpecificationLens {
                        lens: PropertyLens::JosselinFeist,
                    },
                    &["project-discovery"],
                ),
                fixture_node(
                    "property-specification-fanin",
                    "Property specification",
                    NodeKind::PropertySpecificationFanIn,
                    &[
                        "property-specification-0kn0t",
                        "property-specification-certora",
                        "property-specification-josselin-feist",
                    ],
                ),
                fixture_node(
                    "property-specification",
                    "Direct property specification",
                    NodeKind::PropertySpecification,
                    &["project-discovery"],
                ),
            ],
        };
        fs::write(
            run_root.join("graph.json"),
            serde_json::to_string_pretty(&graph).unwrap(),
        )
        .unwrap();

        let mut state = RunState::from_graph(
            run_id.clone(),
            &graph,
            "graph".to_owned(),
            "config".to_owned(),
            None,
        );
        state.status = RunStatus::Succeeded;
        for node in state.nodes.values_mut() {
            node.status = NodeStatus::Succeeded;
        }
        RunStateStore::for_run_root(&run_root).save(&state).unwrap();

        fs::write(
            run_root.join("run.json"),
            serde_json::to_string_pretty(&json!({ "run_id": "run-1" })).unwrap(),
        )
        .unwrap();

        let zero_knot_dir = run_root.join("artifacts/property-specification-0kn0t");
        fs::write(
            zero_knot_dir.join(PROPERTY_LENS_CANDIDATE_FILE),
            serde_json::to_string_pretty(&json!({
                "candidate_properties": [
                    { "id": "zero-1" },
                    { "id": "zero-2" }
                ],
                "deferred_or_rejected_properties": [
                    { "id": "zero-deferred" }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let certora_dir = run_root.join("artifacts/property-specification-certora");
        fs::write(
            certora_dir.join(PROPERTY_LENS_CANDIDATE_FILE),
            serde_json::to_string_pretty(&json!({
                "candidate_properties": [
                    { "id": "certora-1" }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let josselin_dir = run_root.join("artifacts/property-specification-josselin-feist");
        fs::write(
            josselin_dir.join(PROPERTY_LENS_CANDIDATE_FILE),
            serde_json::to_string_pretty(&json!({
                "candidate_properties": [
                    { "id": "josselin-1" },
                    { "id": "josselin-2" },
                    { "id": "josselin-3" }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let fanin_dir = run_root.join("artifacts/property-specification-fanin");
        fs::write(
            fanin_dir.join(PROPERTY_SPECIFICATION_FILE),
            serde_json::to_string_pretty(&json!({
                "candidate_properties": [
                    { "id": "final-1" },
                    { "id": "final-2" },
                    { "id": "final-3" }
                ],
                "deferred_or_rejected_properties": [
                    { "id": "rejected-1" },
                    { "id": "rejected-2" },
                    { "id": "rejected-3" },
                    { "id": "rejected-4" }
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            fanin_dir.join(FINDINGS_FILE),
            serde_json::to_string_pretty(&json!([{
                "id": "UF-PROP-001",
                "title": "Specification workflow finding"
            }]))
            .unwrap(),
        )
        .unwrap();

        let direct_dir = run_root.join("artifacts/property-specification");
        fs::write(
            direct_dir.join(PROPERTY_SPECIFICATION_FILE),
            serde_json::to_string_pretty(&json!({
                "candidate_properties": [
                    { "id": "direct-1" },
                    { "id": "direct-2" }
                ],
                "deferred_or_rejected_properties": [
                    { "id": "direct-deferred" }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        runs_dir
    }

    fn fixture_node(id: &str, label: &str, kind: NodeKind, depends_on: &[&str]) -> Node {
        Node {
            id: NodeId::from(id),
            label: label.to_owned(),
            kind,
            depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts").join(id),
        }
    }

    fn fixture_node_with_timeout(
        id: &str,
        label: &str,
        kind: NodeKind,
        depends_on: &[&str],
        timeout_seconds: u64,
    ) -> Node {
        let mut node = fixture_node(id, label, kind, depends_on);
        node.timeout = Some(std::time::Duration::from_secs(timeout_seconds));
        node
    }

    fn write_full_preview_topology(root: &Path) {
        ultrafuzz_prompts::scaffold_project_prompts(root, false).unwrap();
        ultrafuzz_references::write_default_reference_catalog(root, false).unwrap();
        ultrafuzz_topology::write_default_project_topology(root, true).unwrap();
    }

    fn write_minimal_preview_topology(root: &Path) {
        let prompt_path = root.join(".ultrafuzz/prompts/setup/project-discovery.md");
        fs::create_dir_all(prompt_path.parent().unwrap()).unwrap();
        fs::write(
            &prompt_path,
            topology_prompt_markdown("setup/project-discovery.md").unwrap(),
        )
        .unwrap();
        write_project_topology(
            root,
            vec![
                dashboard_meta_node(MetaNodeRole::Start, &[]),
                dashboard_topology_node(
                    "project-discovery",
                    "setup/project-discovery.md",
                    &[ultrafuzz_topology::START_NODE_ID],
                    1,
                ),
                dashboard_meta_node(MetaNodeRole::Finish, &["project-discovery"]),
            ],
        );
    }

    fn write_project_topology(root: &Path, nodes: Vec<TopologyNode>) {
        let topology = ProjectTopology {
            version: ultrafuzz_topology::TOPOLOGY_VERSION,
            defaults: ultrafuzz_topology::TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes,
        };
        let topology_path = root.join(ultrafuzz_topology::PROJECT_TOPOLOGY_FILE);
        fs::create_dir_all(topology_path.parent().unwrap()).unwrap();
        fs::write(topology_path, serde_yaml::to_string(&topology).unwrap()).unwrap();
    }

    fn dashboard_topology_with_start_finish(mut nodes: Vec<TopologyNode>) -> Vec<TopologyNode> {
        let mut dependents = BTreeSet::<NodeId>::new();
        for node in &nodes {
            for dependency in &node.depends_on {
                dependents.insert(dependency.clone());
            }
        }
        let roots = nodes
            .iter()
            .filter(|node| node.depends_on.is_empty())
            .map(|node| node.id.clone())
            .collect::<BTreeSet<_>>();
        let terminals = nodes
            .iter()
            .filter(|node| !dependents.contains(&node.id))
            .map(|node| node.id.to_string())
            .collect::<Vec<_>>();
        for node in &mut nodes {
            if roots.contains(&node.id) {
                node.depends_on
                    .push(NodeId::from(ultrafuzz_topology::START_NODE_ID));
            }
        }
        let mut wrapped = vec![dashboard_meta_node(MetaNodeRole::Start, &[])];
        wrapped.extend(nodes);
        wrapped.push(dashboard_meta_node(
            MetaNodeRole::Finish,
            &terminals.iter().map(String::as_str).collect::<Vec<_>>(),
        ));
        wrapped
    }

    fn dashboard_topology_node(
        id: &str,
        prompt: &str,
        depends_on: &[&str],
        loops: usize,
    ) -> TopologyNode {
        TopologyNode {
            id: NodeId::from(id),
            kind: TopologyNodeKind::Agentic,
            role: None,
            prompt: Some(PathBuf::from(prompt)),
            reference: None,
            group: prompt.split('/').next().map(str::to_owned),
            depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
            loops,
            loop_mode: ultrafuzz_topology::LoopMode::Parallel,
            timeout_seconds: None,
            required_artifacts: Vec::new(),
            primary_artifact: None,
        }
    }

    fn dashboard_meta_node(role: MetaNodeRole, depends_on: &[&str]) -> TopologyNode {
        TopologyNode {
            id: NodeId::from(role.canonical_id()),
            kind: TopologyNodeKind::Meta,
            role: Some(role),
            prompt: None,
            reference: None,
            group: None,
            depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
            loops: 1,
            loop_mode: ultrafuzz_topology::LoopMode::Parallel,
            timeout_seconds: None,
            required_artifacts: Vec::new(),
            primary_artifact: None,
        }
    }
}
