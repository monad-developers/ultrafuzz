use chrono::DateTime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use ultrafuzz_core::{
    BackendKind, ModelProfileId, NodeId, NodeStatus, RestartMode, RunId, RunStatus,
};
use ultrafuzz_topology::{CampaignGraph, Node, NodeKind, FINISH_NODE_ID, START_NODE_ID};

pub const STATE_FILE_NAME: &str = "state.json";
pub const RESOLVED_CONFIG_FILE_NAME: &str = "config.resolved.toml";
pub const GRAPH_FINGERPRINT_FILE_NAME: &str = "graph.fingerprint";
pub const GRAPH_FILE_NAME: &str = "graph.json";
pub const ACCOUNTING_SCHEMA_VERSION: &str = "1.0";
pub const RUN_HEALTH_SCHEMA_VERSION: &str = "1.0";
pub const DEFAULT_STALE_AFTER_SECONDS: u64 = 10 * 60;
pub const STDOUT_LOG_FILE_NAME: &str = "stdout.log";
pub const STDERR_LOG_FILE_NAME: &str = "stderr.log";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RunState {
    pub run_id: RunId,
    #[serde(default)]
    pub source_run_id: Option<RunId>,
    pub status: RunStatus,
    pub graph_fingerprint: String,
    pub config_fingerprint: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<RunUsageSummary>,
    pub nodes: BTreeMap<NodeId, NodeState>,
}

impl RunState {
    pub fn new(run_id: RunId) -> Self {
        Self {
            run_id,
            source_run_id: None,
            status: RunStatus::Pending,
            graph_fingerprint: String::new(),
            config_fingerprint: String::new(),
            created_at: None,
            started_at: None,
            finished_at: None,
            usage: None,
            nodes: BTreeMap::new(),
        }
    }

    pub fn from_graph(
        run_id: RunId,
        graph: &CampaignGraph,
        graph_fingerprint: String,
        config_fingerprint: String,
        source_run_id: Option<RunId>,
    ) -> Self {
        Self {
            run_id,
            source_run_id,
            status: RunStatus::Pending,
            graph_fingerprint,
            config_fingerprint,
            created_at: None,
            started_at: None,
            finished_at: None,
            usage: None,
            nodes: graph
                .nodes
                .iter()
                .map(|node| (node.id.clone(), NodeState::pending(node)))
                .collect(),
        }
    }

    pub fn set_node_status(&mut self, node_id: &NodeId, status: NodeStatus) {
        self.nodes
            .entry(node_id.clone())
            .or_insert_with(|| NodeState::new(node_id.clone()))
            .status = status;
    }

    pub fn refresh_usage_summary(&mut self) {
        self.usage = RunUsageSummary::from_node_usages(
            self.nodes.values().filter_map(|node| node.usage.as_ref()),
        );
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeState {
    pub node_id: NodeId,
    pub status: NodeStatus,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub retry_count: usize,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_epoch_ms: Option<u64>,
    #[serde(default)]
    pub artifact_dir: Option<PathBuf>,
    #[serde(default)]
    pub backend: Option<BackendKind>,
    #[serde(default)]
    pub model_id: Option<ModelProfileId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub model_index: Option<usize>,
    #[serde(default)]
    pub loop_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<NodeUsage>,
}

impl NodeState {
    pub fn new(node_id: NodeId) -> Self {
        Self {
            node_id,
            status: NodeStatus::Pending,
            started_at: None,
            finished_at: None,
            retry_count: 0,
            timed_out: false,
            last_error: None,
            retry_after_epoch_ms: None,
            artifact_dir: None,
            backend: None,
            model_id: None,
            model: None,
            model_index: None,
            loop_index: None,
            usage: None,
        }
    }

    pub fn pending(node: &Node) -> Self {
        let (model_id, model_index, loop_index) = match &node.kind {
            NodeKind::AgentAttempt {
                model_id,
                model_index,
                loop_index,
                ..
            } => (
                Some(model_id.clone()),
                Some(*model_index),
                Some(*loop_index),
            ),
            _ => (None, None, None),
        };
        Self {
            node_id: node.id.clone(),
            status: NodeStatus::Pending,
            started_at: None,
            finished_at: None,
            retry_count: 0,
            timed_out: false,
            last_error: None,
            retry_after_epoch_ms: None,
            artifact_dir: Some(node.artifact_dir.clone()),
            backend: None,
            model_id,
            model: None,
            model_index,
            loop_index,
            usage: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CostEstimateStatus {
    Complete,
    Partial,
    Unknown,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_creation_5m_input_tokens: u64,
    pub cache_creation_1h_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub server_web_search_requests: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub server_web_fetch_requests: u64,
}

impl TokenUsage {
    pub fn has_tokens(&self) -> bool {
        self.total_tokens > 0
            || self.input_tokens > 0
            || self.cached_input_tokens > 0
            || self.cache_creation_input_tokens > 0
            || self.cache_creation_5m_input_tokens > 0
            || self.cache_creation_1h_input_tokens > 0
            || self.cache_read_input_tokens > 0
            || self.output_tokens > 0
            || self.reasoning_output_tokens > 0
    }

    pub fn add(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.cached_input_tokens = self
            .cached_input_tokens
            .saturating_add(other.cached_input_tokens);
        self.cache_creation_input_tokens = self
            .cache_creation_input_tokens
            .saturating_add(other.cache_creation_input_tokens);
        self.cache_creation_5m_input_tokens = self
            .cache_creation_5m_input_tokens
            .saturating_add(other.cache_creation_5m_input_tokens);
        self.cache_creation_1h_input_tokens = self
            .cache_creation_1h_input_tokens
            .saturating_add(other.cache_creation_1h_input_tokens);
        self.cache_read_input_tokens = self
            .cache_read_input_tokens
            .saturating_add(other.cache_read_input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.reasoning_output_tokens = self
            .reasoning_output_tokens
            .saturating_add(other.reasoning_output_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
        self.server_web_search_requests = self
            .server_web_search_requests
            .saturating_add(other.server_web_search_requests);
        self.server_web_fetch_requests = self
            .server_web_fetch_requests
            .saturating_add(other.server_web_fetch_requests);
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeUsage {
    pub schema_version: String,
    pub pricing_as_of: String,
    pub source_path: PathBuf,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<BackendKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<ModelProfileId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub tokens: TokenUsage,
    pub tokens_used: String,
    pub cost_status: CostEstimateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_cost_microusd: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_spend: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unresolved_pricing: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RunUsageSummary {
    pub schema_version: String,
    pub pricing_as_of: String,
    pub tokens: TokenUsage,
    pub tokens_used: String,
    pub cost_status: CostEstimateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_cost_microusd: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_spend: Option<String>,
    pub models: Vec<ModelUsageSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unresolved_pricing: Vec<String>,
}

impl RunUsageSummary {
    pub fn from_node_usages<'a>(
        node_usages: impl IntoIterator<Item = &'a NodeUsage>,
    ) -> Option<Self> {
        let mut summary = Self {
            schema_version: ACCOUNTING_SCHEMA_VERSION.to_owned(),
            pricing_as_of: String::new(),
            tokens: TokenUsage::default(),
            tokens_used: "0".to_owned(),
            cost_status: CostEstimateStatus::Unknown,
            estimated_cost_microusd: None,
            estimated_spend: None,
            models: Vec::new(),
            unresolved_pricing: Vec::new(),
        };
        let mut model_summaries = BTreeMap::<ModelUsageKey, ModelUsageSummary>::new();
        let mut unresolved = BTreeSet::<String>::new();
        let mut total_cost_microusd = 0u64;
        let mut has_usage = false;
        let mut has_cost = false;

        for node_usage in node_usages {
            if !node_usage.tokens.has_tokens() {
                continue;
            }
            has_usage = true;
            if summary.pricing_as_of.is_empty() {
                summary.pricing_as_of = node_usage.pricing_as_of.clone();
            }
            summary.tokens.add(&node_usage.tokens);
            if let Some(cost) = node_usage.estimated_cost_microusd {
                total_cost_microusd = total_cost_microusd.saturating_add(cost);
                has_cost = true;
            }
            unresolved.extend(node_usage.unresolved_pricing.iter().cloned());

            let key = ModelUsageKey {
                provider: node_usage.provider.clone(),
                backend: node_usage.backend.map(|backend| backend.to_string()),
                model_id: node_usage.model_id.as_ref().map(ToString::to_string),
                model: node_usage.model.clone(),
            };
            let model_summary = model_summaries
                .entry(key)
                .or_insert_with(|| ModelUsageSummary {
                    provider: node_usage.provider.clone(),
                    backend: node_usage.backend,
                    model_id: node_usage.model_id.clone(),
                    model: node_usage.model.clone(),
                    tokens: TokenUsage::default(),
                    tokens_used: "0".to_owned(),
                    cost_status: CostEstimateStatus::Unknown,
                    estimated_cost_microusd: None,
                    estimated_spend: None,
                    unresolved_pricing: Vec::new(),
                });
            model_summary.tokens.add(&node_usage.tokens);
            model_summary.tokens_used = format_token_count(model_summary.tokens.total_tokens);
            model_summary.cost_status = merge_cost_status(
                model_summary.cost_status.clone(),
                node_usage.cost_status.clone(),
                model_summary.estimated_cost_microusd.is_some(),
            );
            if let Some(cost) = node_usage.estimated_cost_microusd {
                model_summary.estimated_cost_microusd =
                    Some(model_summary.estimated_cost_microusd.unwrap_or(0) + cost);
                model_summary.estimated_spend = spend_display(
                    model_summary.cost_status.clone(),
                    model_summary.estimated_cost_microusd,
                    &model_summary.unresolved_pricing,
                );
            }
            for reason in &node_usage.unresolved_pricing {
                if !model_summary.unresolved_pricing.contains(reason) {
                    model_summary.unresolved_pricing.push(reason.clone());
                }
            }
            model_summary.estimated_spend = spend_display(
                model_summary.cost_status.clone(),
                model_summary.estimated_cost_microusd,
                &model_summary.unresolved_pricing,
            );
        }

        if !has_usage {
            return None;
        }
        if summary.pricing_as_of.is_empty() {
            summary.pricing_as_of = "unknown".to_owned();
        }
        summary.tokens_used = format_token_count(summary.tokens.total_tokens);
        summary.unresolved_pricing = unresolved.into_iter().collect();
        if has_cost {
            summary.estimated_cost_microusd = Some(total_cost_microusd);
        }
        summary.cost_status = if summary.unresolved_pricing.is_empty() && has_cost {
            CostEstimateStatus::Complete
        } else if has_cost {
            CostEstimateStatus::Partial
        } else {
            CostEstimateStatus::Unknown
        };
        summary.estimated_spend = spend_display(
            summary.cost_status.clone(),
            summary.estimated_cost_microusd,
            &summary.unresolved_pricing,
        );
        summary.models = model_summaries.into_values().collect();
        Some(summary)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelUsageSummary {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<BackendKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<ModelProfileId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub tokens: TokenUsage,
    pub tokens_used: String,
    pub cost_status: CostEstimateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_cost_microusd: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_spend: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unresolved_pricing: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct ModelUsageKey {
    provider: String,
    backend: Option<String>,
    model_id: Option<String>,
    model: Option<String>,
}

pub fn format_token_count(tokens: u64) -> String {
    format_compact_number(tokens, "K", "M", "B")
}

pub fn format_microusd(cost: u64) -> String {
    if cost > 0 && cost < 1_000_000 {
        "<$1".to_owned()
    } else {
        format!("${}", (cost + 500_000) / 1_000_000)
    }
}

pub fn spend_display(
    status: CostEstimateStatus,
    estimated_cost_microusd: Option<u64>,
    unresolved_pricing: &[String],
) -> Option<String> {
    match (status, estimated_cost_microusd) {
        (CostEstimateStatus::Complete, Some(cost)) => Some(format_microusd(cost)),
        (CostEstimateStatus::Partial, Some(cost)) => {
            let reason = compact_unresolved_pricing(unresolved_pricing);
            if reason.is_empty() {
                Some(format!("{}+ (partial)", format_microusd(cost)))
            } else {
                Some(format!("{}+ (partial; {reason})", format_microusd(cost)))
            }
        }
        _ => None,
    }
}

fn merge_cost_status(
    current: CostEstimateStatus,
    next: CostEstimateStatus,
    has_cost: bool,
) -> CostEstimateStatus {
    match (current, next, has_cost) {
        (CostEstimateStatus::Partial, _, _) | (_, CostEstimateStatus::Partial, _) => {
            CostEstimateStatus::Partial
        }
        (_, CostEstimateStatus::Unknown, true) => CostEstimateStatus::Partial,
        (CostEstimateStatus::Unknown, CostEstimateStatus::Complete, _) => {
            CostEstimateStatus::Complete
        }
        (left, _, _) => left,
    }
}

fn compact_unresolved_pricing(reasons: &[String]) -> String {
    match reasons {
        [] => String::new(),
        [only] => only.clone(),
        [first, second] => format!("{first}; {second}"),
        [first, second, rest @ ..] => format!("{first}; {second}; {} more", rest.len()),
    }
}

fn format_compact_number(value: u64, thousands: &str, millions: &str, billions: &str) -> String {
    if value < 1_000 {
        return value.to_string();
    }
    let (unit, suffix) = if value < 1_000_000 {
        (1_000u64, thousands)
    } else if value < 1_000_000_000 {
        (1_000_000u64, millions)
    } else {
        (1_000_000_000u64, billions)
    };
    if value.is_multiple_of(unit) {
        format!("{}{}", value / unit, suffix)
    } else {
        let scaled = value as f64 / unit as f64;
        if scaled >= 10.0 {
            format!("{scaled:.0}{suffix}")
        } else {
            format!("{scaled:.1}{suffix}")
        }
    }
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunStateStore {
    pub path: PathBuf,
}

impl RunStateStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn for_run_root(run_root: impl AsRef<Path>) -> Self {
        Self::new(run_root.as_ref().join(STATE_FILE_NAME))
    }

    pub fn load(&self) -> Result<RunState, StateError> {
        let contents = fs::read_to_string(&self.path)?;
        Ok(serde_json::from_str(&contents)?)
    }

    pub fn save(&self, state: &RunState) -> Result<(), StateError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let temp_path = self.path.with_extension("json.tmp");
        let contents = serde_json::to_string_pretty(state)?;
        fs::write(&temp_path, contents)?;
        fs::rename(temp_path, &self.path)?;
        Ok(())
    }

    pub fn load_or_initialize(&self, state: RunState) -> Result<RunState, StateError> {
        if self.path.exists() {
            let existing = self.load()?;
            if !existing.graph_fingerprint.is_empty()
                && !state.graph_fingerprint.is_empty()
                && existing.graph_fingerprint != state.graph_fingerprint
            {
                return Err(StateError::FingerprintMismatch {
                    kind: "graph",
                    expected: existing.graph_fingerprint,
                    actual: state.graph_fingerprint,
                });
            }
            if !existing.config_fingerprint.is_empty()
                && !state.config_fingerprint.is_empty()
                && existing.config_fingerprint != state.config_fingerprint
            {
                return Err(StateError::FingerprintMismatch {
                    kind: "config",
                    expected: existing.config_fingerprint,
                    actual: state.config_fingerprint,
                });
            }
            Ok(existing)
        } else {
            self.save(&state)?;
            Ok(state)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestartPlan {
    pub mode: RestartMode,
    pub source_run_id: RunId,
    pub new_run_id: RunId,
    pub source_run_root: PathBuf,
    pub resolved_config_toml: String,
    pub graph_fingerprint: String,
    pub config_fingerprint: String,
    pub reusable_nodes: Vec<NodeId>,
}

impl RestartPlan {
    pub fn derive_clean(
        source_run_root: impl AsRef<Path>,
        new_run_id: RunId,
    ) -> Result<Self, StateError> {
        Self::derive(source_run_root, new_run_id, RestartMode::Clean)
    }

    pub fn derive_continuation(
        source_run_root: impl AsRef<Path>,
        new_run_id: RunId,
    ) -> Result<Self, StateError> {
        Self::derive(
            source_run_root,
            new_run_id,
            RestartMode::ReuseCompletedArtifacts,
        )
    }

    fn derive(
        source_run_root: impl AsRef<Path>,
        new_run_id: RunId,
        mode: RestartMode,
    ) -> Result<Self, StateError> {
        let source_run_root = source_run_root.as_ref();
        let state = RunStateStore::for_run_root(source_run_root).load()?;
        let config_path = source_run_root.join(RESOLVED_CONFIG_FILE_NAME);
        let resolved_config_toml =
            fs::read_to_string(&config_path).map_err(|err| StateError::MissingRestartInput {
                path: config_path.clone(),
                reason: err.to_string(),
            })?;

        let reusable_nodes = match mode {
            RestartMode::Clean => Vec::new(),
            RestartMode::ReuseCompletedArtifacts => {
                let graph = load_restart_graph(source_run_root, &state.graph_fingerprint)?;
                continuation_reusable_nodes(&state, &graph)
            }
        };

        Ok(Self {
            mode,
            source_run_id: state.run_id,
            new_run_id,
            source_run_root: source_run_root.to_path_buf(),
            resolved_config_toml,
            graph_fingerprint: state.graph_fingerprint,
            config_fingerprint: state.config_fingerprint,
            reusable_nodes,
        })
    }
}

fn load_restart_graph(
    source_run_root: &Path,
    expected_fingerprint: &str,
) -> Result<CampaignGraph, StateError> {
    let graph_path = source_run_root.join(GRAPH_FILE_NAME);
    let graph_json =
        fs::read_to_string(&graph_path).map_err(|err| StateError::MissingRestartInput {
            path: graph_path.clone(),
            reason: err.to_string(),
        })?;
    let graph = serde_json::from_str::<CampaignGraph>(&graph_json).map_err(|err| {
        StateError::InvalidRestartGraph {
            path: graph_path.clone(),
            reason: err.to_string(),
        }
    })?;
    let actual_fingerprint =
        graph
            .fingerprint()
            .map_err(|err| StateError::InvalidRestartGraph {
                path: graph_path,
                reason: err.to_string(),
            })?;
    if actual_fingerprint != expected_fingerprint {
        return Err(StateError::FingerprintMismatch {
            kind: "graph",
            expected: expected_fingerprint.to_owned(),
            actual: actual_fingerprint,
        });
    }
    Ok(graph)
}

fn continuation_reusable_nodes(state: &RunState, graph: &CampaignGraph) -> Vec<NodeId> {
    let affected = continuation_affected_nodes(state, graph);
    graph
        .nodes
        .iter()
        .filter_map(|node| {
            let node_state = state.nodes.get(&node.id)?;
            (is_restart_reusable_status(node_state.status)
                && !is_restart_meta_node(&node.id)
                && !affected.contains(&node.id))
            .then(|| node.id.clone())
        })
        .collect()
}

fn continuation_affected_nodes(state: &RunState, graph: &CampaignGraph) -> BTreeSet<NodeId> {
    let mut dependents = BTreeMap::<NodeId, Vec<NodeId>>::new();
    for node in &graph.nodes {
        for dependency in &node.depends_on {
            dependents
                .entry(dependency.clone())
                .or_default()
                .push(node.id.clone());
        }
    }

    let mut affected = BTreeSet::<NodeId>::new();
    let mut stack = graph
        .nodes
        .iter()
        .filter_map(|node| {
            if is_restart_meta_node(&node.id) {
                return None;
            }
            let reusable = state
                .nodes
                .get(&node.id)
                .is_some_and(|node_state| is_restart_reusable_status(node_state.status));
            (!reusable).then(|| node.id.clone())
        })
        .collect::<Vec<_>>();

    while let Some(node_id) = stack.pop() {
        if !affected.insert(node_id.clone()) {
            continue;
        }
        if let Some(children) = dependents.get(&node_id) {
            stack.extend(children.iter().cloned());
        }
    }

    affected
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunHealthSummary {
    pub schema_version: String,
    pub generated_at_unix_seconds: f64,
    pub status: String,
    pub phase: String,
    pub start_status: Option<String>,
    pub finish_status: Option<String>,
    pub active_nodes: Vec<ActiveNodeHealth>,
    pub process_liveness: ProcessLivenessSummary,
    pub stdout_freshness: LogFreshnessSummary,
    pub stderr_freshness: LogFreshnessSummary,
    pub timeout: TimeoutHealthSummary,
    pub artifacts: ArtifactCompletenessSummary,
    pub stale: StaleRunSummary,
    pub restart: RestartReuseSummary,
    pub lineage: RunLineageSummary,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActiveNodeHealth {
    pub node_id: String,
    pub label: String,
    pub status: String,
    pub artifact_dir: String,
    pub started_at: Option<String>,
    pub timeout_seconds: Option<f64>,
    pub timeout_remaining_seconds: Option<f64>,
    pub stdout_updated_seconds_ago: Option<f64>,
    pub stderr_updated_seconds_ago: Option<f64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProcessLivenessSummary {
    pub status: String,
    pub observed: bool,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LogFreshnessSummary {
    pub stream: String,
    pub status: String,
    pub newest_path: Option<String>,
    pub newest_updated_at_unix_seconds: Option<f64>,
    pub newest_age_seconds: Option<f64>,
    pub missing_active_nodes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimeoutHealthSummary {
    pub status: String,
    pub minimum_remaining_seconds: Option<f64>,
    pub nodes: Vec<NodeTimeoutSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NodeTimeoutSummary {
    pub node_id: String,
    pub label: String,
    pub status: String,
    pub started_at: Option<String>,
    pub timeout_seconds: Option<f64>,
    pub elapsed_seconds: Option<f64>,
    pub remaining_seconds: Option<f64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactCompletenessSummary {
    pub status: String,
    pub total_required: usize,
    pub present_required: usize,
    pub missing_required: usize,
    pub missing: Vec<RequiredArtifactStatus>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RequiredArtifactStatus {
    pub node_id: String,
    pub label: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StaleRunSummary {
    pub stale: bool,
    pub status: String,
    pub threshold_seconds: f64,
    pub newest_activity_age_seconds: Option<f64>,
    pub newest_activity_path: Option<String>,
    pub guidance: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RestartReuseSummary {
    pub available: bool,
    pub clean_restart_available: bool,
    pub config_available: bool,
    pub reusable_count: usize,
    pub reusable_nodes: Vec<RestartReusableNode>,
    pub guidance: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RestartReusableNode {
    pub node_id: String,
    pub label: String,
    pub status: String,
    pub artifacts_available: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunLineageSummary {
    pub source_run_id: Option<String>,
    pub source_runs: Vec<String>,
    pub missing_source_runs: Vec<String>,
    pub reused_nodes: Vec<String>,
    pub newly_executed_nodes: Vec<String>,
    pub current_elapsed_seconds: Option<f64>,
    pub cumulative_elapsed_seconds: Option<f64>,
    pub final_restart_elapsed_seconds: Option<f64>,
    pub current_tokens_used: Option<String>,
    pub cumulative_tokens_used: Option<String>,
    pub current_estimated_spend: Option<String>,
    pub cumulative_estimated_spend: Option<String>,
}

pub fn summarize_run_health(
    run_root: &Path,
    runs_dir: &Path,
    graph: &CampaignGraph,
    state: &RunState,
) -> RunHealthSummary {
    summarize_run_health_at(
        run_root,
        runs_dir,
        graph,
        state,
        current_unix_seconds(),
        Duration::from_secs(DEFAULT_STALE_AFTER_SECONDS),
    )
}

pub fn summarize_run_health_at(
    run_root: &Path,
    runs_dir: &Path,
    graph: &CampaignGraph,
    state: &RunState,
    now_unix_seconds: f64,
    stale_after: Duration,
) -> RunHealthSummary {
    let active_nodes = active_node_health(run_root, graph, state, now_unix_seconds);
    let stdout_freshness = log_freshness(
        run_root,
        &active_nodes,
        STDOUT_LOG_FILE_NAME,
        "stdout",
        now_unix_seconds,
        stale_after,
        state.status,
    );
    let stderr_freshness = log_freshness(
        run_root,
        &active_nodes,
        STDERR_LOG_FILE_NAME,
        "stderr",
        now_unix_seconds,
        stale_after,
        state.status,
    );
    let timeout = timeout_health(graph, state, now_unix_seconds);
    let artifacts = artifact_completeness(run_root, graph);
    let stale = stale_summary(
        state,
        &active_nodes,
        &stdout_freshness,
        &stderr_freshness,
        now_unix_seconds,
        stale_after,
    );
    let restart = restart_reuse(run_root, graph, state, &stale);
    let lineage = lineage_summary(runs_dir, graph, state);

    RunHealthSummary {
        schema_version: RUN_HEALTH_SCHEMA_VERSION.to_owned(),
        generated_at_unix_seconds: now_unix_seconds,
        status: run_status_label(state.status).to_owned(),
        phase: run_phase(state, graph),
        start_status: state
            .nodes
            .get(&NodeId::from(START_NODE_ID))
            .map(|node| node_status_label(node.status).to_owned()),
        finish_status: state
            .nodes
            .get(&NodeId::from(FINISH_NODE_ID))
            .map(|node| node_status_label(node.status).to_owned()),
        active_nodes,
        process_liveness: process_liveness(state.status),
        stdout_freshness,
        stderr_freshness,
        timeout,
        artifacts,
        stale,
        restart,
        lineage,
    }
}

fn is_restart_meta_node(node_id: &NodeId) -> bool {
    matches!(node_id.as_str(), START_NODE_ID | FINISH_NODE_ID)
}

fn is_restart_reusable_status(status: NodeStatus) -> bool {
    matches!(
        status,
        NodeStatus::Succeeded | NodeStatus::ReusedFromPriorRun
    )
}

fn active_node_health(
    run_root: &Path,
    graph: &CampaignGraph,
    state: &RunState,
    now_unix_seconds: f64,
) -> Vec<ActiveNodeHealth> {
    graph
        .nodes
        .iter()
        .filter_map(|node| {
            let node_state = state.nodes.get(&node.id)?;
            if !matches!(node_state.status, NodeStatus::Running | NodeStatus::Ready) {
                return None;
            }
            let started_seconds = node_state
                .started_at
                .as_deref()
                .and_then(state_timestamp_seconds);
            let elapsed_seconds =
                started_seconds.map(|started| (now_unix_seconds - started).max(0.0));
            let timeout_seconds = node.timeout.map(|timeout| timeout.as_secs_f64());
            let timeout_remaining_seconds = timeout_seconds
                .zip(elapsed_seconds)
                .map(|(timeout, elapsed)| (timeout - elapsed).max(0.0));
            Some(ActiveNodeHealth {
                node_id: node.id.to_string(),
                label: node.label.clone(),
                status: node_status_label(node_state.status).to_owned(),
                artifact_dir: node.artifact_dir.display().to_string(),
                started_at: node_state.started_at.clone(),
                timeout_seconds,
                timeout_remaining_seconds,
                stdout_updated_seconds_ago: file_modified_seconds(
                    run_root,
                    node,
                    STDOUT_LOG_FILE_NAME,
                )
                .map(|modified| (now_unix_seconds - modified).max(0.0)),
                stderr_updated_seconds_ago: file_modified_seconds(
                    run_root,
                    node,
                    STDERR_LOG_FILE_NAME,
                )
                .map(|modified| (now_unix_seconds - modified).max(0.0)),
            })
        })
        .collect()
}

fn log_freshness(
    run_root: &Path,
    active_nodes: &[ActiveNodeHealth],
    file_name: &str,
    stream: &str,
    now_unix_seconds: f64,
    stale_after: Duration,
    run_status: RunStatus,
) -> LogFreshnessSummary {
    if active_nodes.is_empty() {
        return LogFreshnessSummary {
            stream: stream.to_owned(),
            status: if run_status == RunStatus::Pending {
                "not-started".to_owned()
            } else {
                "inactive".to_owned()
            },
            newest_path: None,
            newest_updated_at_unix_seconds: None,
            newest_age_seconds: None,
            missing_active_nodes: Vec::new(),
        };
    }

    let mut newest = None::<(String, f64)>;
    let mut missing_active_nodes = Vec::new();
    for active in active_nodes {
        let path = run_root.join(&active.artifact_dir).join(file_name);
        match file_modified_unix_seconds(&path) {
            Some(modified) => {
                if newest
                    .as_ref()
                    .is_none_or(|(_, newest_modified)| modified > *newest_modified)
                {
                    newest = Some((relative_to_run(run_root, &path), modified));
                }
            }
            None => missing_active_nodes.push(active.node_id.clone()),
        }
    }

    let (newest_path, newest_updated_at_unix_seconds, newest_age_seconds, status) = match newest {
        Some((path, modified)) => {
            let age = (now_unix_seconds - modified).max(0.0);
            (
                Some(path),
                Some(modified),
                Some(age),
                if age > stale_after.as_secs_f64() {
                    "stale"
                } else {
                    "fresh"
                }
                .to_owned(),
            )
        }
        None => (None, None, None, "missing".to_owned()),
    };

    LogFreshnessSummary {
        stream: stream.to_owned(),
        status,
        newest_path,
        newest_updated_at_unix_seconds,
        newest_age_seconds,
        missing_active_nodes,
    }
}

fn timeout_health(
    graph: &CampaignGraph,
    state: &RunState,
    now_unix_seconds: f64,
) -> TimeoutHealthSummary {
    let nodes = graph
        .nodes
        .iter()
        .filter_map(|node| {
            let node_state = state.nodes.get(&node.id)?;
            if !matches!(node_state.status, NodeStatus::Running | NodeStatus::Ready) {
                return None;
            }
            let started_seconds = node_state
                .started_at
                .as_deref()
                .and_then(state_timestamp_seconds);
            let elapsed_seconds =
                started_seconds.map(|started| (now_unix_seconds - started).max(0.0));
            let timeout_seconds = node.timeout.map(|timeout| timeout.as_secs_f64());
            let remaining_seconds = timeout_seconds
                .zip(elapsed_seconds)
                .map(|(timeout, elapsed)| (timeout - elapsed).max(0.0));
            Some(NodeTimeoutSummary {
                node_id: node.id.to_string(),
                label: node.label.clone(),
                status: node_status_label(node_state.status).to_owned(),
                started_at: node_state.started_at.clone(),
                timeout_seconds,
                elapsed_seconds,
                remaining_seconds,
            })
        })
        .collect::<Vec<_>>();

    if nodes.is_empty() {
        return TimeoutHealthSummary {
            status: if state.status == RunStatus::Pending {
                "not-started".to_owned()
            } else {
                "inactive".to_owned()
            },
            minimum_remaining_seconds: None,
            nodes,
        };
    }

    let remaining = nodes
        .iter()
        .filter_map(|node| node.remaining_seconds)
        .min_by(|left, right| left.total_cmp(right));
    let status = if remaining.is_some_and(|value| value <= 0.0) {
        "expired"
    } else if remaining.is_some() {
        "within-timeout"
    } else {
        "unbounded"
    };

    TimeoutHealthSummary {
        status: status.to_owned(),
        minimum_remaining_seconds: remaining,
        nodes,
    }
}

fn artifact_completeness(run_root: &Path, graph: &CampaignGraph) -> ArtifactCompletenessSummary {
    let mut total_required = 0usize;
    let mut present_required = 0usize;
    let mut missing = Vec::new();

    for node in &graph.nodes {
        let required_artifacts = required_artifacts_for_node(node);
        total_required += required_artifacts.len();
        for required in required_artifacts {
            let path = artifact_dir(run_root, node).join(required);
            if artifact_present(&path) {
                present_required += 1;
            } else {
                missing.push(RequiredArtifactStatus {
                    node_id: node.id.to_string(),
                    label: node.label.clone(),
                    path: relative_to_run(run_root, &path),
                });
            }
        }
    }

    let missing_required = total_required.saturating_sub(present_required);
    let status = if total_required == 0 {
        "not-configured"
    } else if missing_required == 0 {
        "complete"
    } else {
        "incomplete"
    };

    ArtifactCompletenessSummary {
        status: status.to_owned(),
        total_required,
        present_required,
        missing_required,
        missing,
    }
}

fn stale_summary(
    state: &RunState,
    active_nodes: &[ActiveNodeHealth],
    stdout_freshness: &LogFreshnessSummary,
    stderr_freshness: &LogFreshnessSummary,
    now_unix_seconds: f64,
    stale_after: Duration,
) -> StaleRunSummary {
    if state.status != RunStatus::Running {
        return StaleRunSummary {
            stale: false,
            status: "inactive".to_owned(),
            threshold_seconds: stale_after.as_secs_f64(),
            newest_activity_age_seconds: None,
            newest_activity_path: None,
            guidance: "Run is not currently marked running.".to_owned(),
        };
    }

    let mut newest = [stdout_freshness, stderr_freshness]
        .into_iter()
        .filter_map(|freshness| {
            freshness
                .newest_age_seconds
                .zip(freshness.newest_path.clone())
        })
        .min_by(|(left, _), (right, _)| left.total_cmp(right));
    for active in active_nodes {
        let Some(started) = active
            .started_at
            .as_deref()
            .and_then(state_timestamp_seconds)
        else {
            continue;
        };
        let age = (now_unix_seconds - started).max(0.0);
        if newest
            .as_ref()
            .is_none_or(|(newest_age, _)| age < *newest_age)
        {
            newest = Some((
                age,
                format!("state.json#/nodes/{}/started_at", active.node_id),
            ));
        }
    }
    let stale = active_nodes.is_empty()
        || newest
            .as_ref()
            .is_none_or(|(age, _)| *age > stale_after.as_secs_f64());
    let status = if stale { "stale" } else { "healthy" };
    let guidance = if stale {
        "Run is marked running but recent node output or start activity is not fresh; inspect active nodes or restart if reusable work exists."
    } else {
        "Run has recent node output or start activity."
    };

    StaleRunSummary {
        stale,
        status: status.to_owned(),
        threshold_seconds: stale_after.as_secs_f64(),
        newest_activity_age_seconds: newest.as_ref().map(|(age, _)| *age),
        newest_activity_path: newest.map(|(_, path)| path),
        guidance: guidance.to_owned(),
    }
}

fn restart_reuse(
    run_root: &Path,
    graph: &CampaignGraph,
    state: &RunState,
    stale: &StaleRunSummary,
) -> RestartReuseSummary {
    let config_available = run_root.join(RESOLVED_CONFIG_FILE_NAME).is_file();
    let reusable_nodes = graph
        .nodes
        .iter()
        .filter_map(|node| {
            let node_state = state.nodes.get(&node.id)?;
            if !is_restart_reusable_status(node_state.status) || is_restart_meta_node(&node.id) {
                return None;
            }
            Some(RestartReusableNode {
                node_id: node.id.to_string(),
                label: node.label.clone(),
                status: node_status_label(node_state.status).to_owned(),
                artifacts_available: artifact_dir(run_root, node).is_dir(),
            })
        })
        .collect::<Vec<_>>();
    let reusable_count = reusable_nodes.len();
    let all_reusable_artifacts_available =
        reusable_nodes.iter().all(|node| node.artifacts_available);
    let clean_restart_available =
        config_available && reusable_count > 0 && all_reusable_artifacts_available;
    let available = clean_restart_available;
    let guidance = if !config_available {
        "Restart reuse is unavailable because the resolved config snapshot is missing.".to_owned()
    } else if reusable_count == 0 {
        "No completed non-meta nodes are reusable yet.".to_owned()
    } else if !all_reusable_artifacts_available {
        "Reusable node state exists, but one or more reusable artifact directories are missing."
            .to_owned()
    } else if stale.stale {
        format!(
            "Run appears stale; restart can reuse {reusable_count} completed non-meta node{}.",
            plural_suffix(reusable_count)
        )
    } else if state.status == RunStatus::Failed {
        format!(
            "Run failed; restart can reuse {reusable_count} completed non-meta node{}.",
            plural_suffix(reusable_count)
        )
    } else if state.status == RunStatus::Running {
        format!(
            "Run is still marked running; restart would reuse {reusable_count} completed non-meta node{}.",
            plural_suffix(reusable_count)
        )
    } else {
        format!(
            "Restart can reuse {reusable_count} completed non-meta node{}.",
            plural_suffix(reusable_count)
        )
    };

    RestartReuseSummary {
        available,
        clean_restart_available,
        config_available,
        reusable_count,
        reusable_nodes,
        guidance,
    }
}

fn lineage_summary(runs_dir: &Path, graph: &CampaignGraph, state: &RunState) -> RunLineageSummary {
    let mut source_runs = Vec::new();
    let mut missing_source_runs = Vec::new();
    let mut seen = BTreeSet::new();
    let mut source_states = Vec::new();
    let mut next = state.source_run_id.clone();
    while let Some(source_run_id) = next {
        if !seen.insert(source_run_id.clone()) {
            break;
        }
        let source_root = runs_dir.join(source_run_id.as_str());
        match RunStateStore::for_run_root(&source_root).load() {
            Ok(source_state) => {
                next = source_state.source_run_id.clone();
                source_runs.push(source_run_id.to_string());
                source_states.push(source_state);
            }
            Err(_) => {
                missing_source_runs.push(source_run_id.to_string());
                break;
            }
        }
    }

    let reused_nodes = graph
        .nodes
        .iter()
        .filter(|node| !is_restart_meta_node(&node.id))
        .filter_map(|node| {
            state
                .nodes
                .get(&node.id)
                .filter(|node_state| node_state.status == NodeStatus::ReusedFromPriorRun)
                .map(|_| node.label.clone())
        })
        .collect::<Vec<_>>();
    let newly_executed_nodes = graph
        .nodes
        .iter()
        .filter(|node| !is_restart_meta_node(&node.id))
        .filter_map(|node| {
            state.nodes.get(&node.id).and_then(|node_state| {
                (node_state.started_at.is_some()
                    && node_state.status != NodeStatus::ReusedFromPriorRun)
                    .then(|| node.label.clone())
            })
        })
        .collect::<Vec<_>>();
    let current_elapsed_seconds = elapsed_seconds(state);
    let cumulative_elapsed_seconds =
        cumulative_elapsed_seconds(current_elapsed_seconds, &source_states);
    let cumulative_usage = cumulative_usage(state, &source_states);

    RunLineageSummary {
        source_run_id: state.source_run_id.as_ref().map(ToString::to_string),
        source_runs,
        missing_source_runs,
        reused_nodes,
        newly_executed_nodes,
        current_elapsed_seconds,
        cumulative_elapsed_seconds,
        final_restart_elapsed_seconds: state.source_run_id.as_ref().and(current_elapsed_seconds),
        current_tokens_used: state.usage.as_ref().map(|usage| usage.tokens_used.clone()),
        cumulative_tokens_used: cumulative_usage
            .as_ref()
            .map(|usage| format_token_count(usage.tokens.total_tokens)),
        current_estimated_spend: state
            .usage
            .as_ref()
            .and_then(|usage| usage.estimated_spend.clone()),
        cumulative_estimated_spend: cumulative_usage.and_then(|usage| usage.estimated_spend),
    }
}

fn cumulative_elapsed_seconds(
    current_elapsed_seconds: Option<f64>,
    source_states: &[RunState],
) -> Option<f64> {
    let mut total = current_elapsed_seconds.unwrap_or(0.0);
    let mut available = current_elapsed_seconds.is_some();
    for state in source_states {
        if let Some(elapsed) = elapsed_seconds(state) {
            total += elapsed;
            available = true;
        }
    }
    available.then_some(total)
}

#[derive(Clone, Debug)]
struct CumulativeUsage {
    tokens: TokenUsage,
    estimated_spend: Option<String>,
}

fn cumulative_usage(state: &RunState, source_states: &[RunState]) -> Option<CumulativeUsage> {
    let mut tokens = TokenUsage::default();
    let mut has_tokens = false;
    let mut total_cost = 0u64;
    let mut has_cost = false;
    let mut partial = false;

    for state in std::iter::once(state).chain(source_states.iter()) {
        for usage in usage_contributions_for_lineage(state) {
            if usage.tokens.has_tokens() {
                has_tokens = true;
                tokens.add(usage.tokens);
            }
            if let Some(cost) = usage.estimated_cost_microusd {
                has_cost = true;
                total_cost = total_cost.saturating_add(cost);
            }
            if *usage.cost_status != CostEstimateStatus::Complete
                || !usage.unresolved_pricing.is_empty()
            {
                partial = true;
            }
        }
    }

    has_tokens.then(|| CumulativeUsage {
        tokens,
        estimated_spend: has_cost.then(|| {
            if partial {
                format!("{}+ (partial)", format_microusd(total_cost))
            } else {
                format_microusd(total_cost)
            }
        }),
    })
}

struct UsageContribution<'a> {
    tokens: &'a TokenUsage,
    estimated_cost_microusd: Option<u64>,
    cost_status: &'a CostEstimateStatus,
    unresolved_pricing: &'a [String],
}

fn usage_contributions_for_lineage(state: &RunState) -> Vec<UsageContribution<'_>> {
    if state.source_run_id.is_some() {
        state
            .nodes
            .values()
            .filter(|node| node.status != NodeStatus::ReusedFromPriorRun)
            .filter_map(|node| {
                node.usage.as_ref().map(|usage| UsageContribution {
                    tokens: &usage.tokens,
                    estimated_cost_microusd: usage.estimated_cost_microusd,
                    cost_status: &usage.cost_status,
                    unresolved_pricing: &usage.unresolved_pricing,
                })
            })
            .collect()
    } else {
        state
            .usage
            .iter()
            .map(|usage| UsageContribution {
                tokens: &usage.tokens,
                estimated_cost_microusd: usage.estimated_cost_microusd,
                cost_status: &usage.cost_status,
                unresolved_pricing: &usage.unresolved_pricing,
            })
            .collect()
    }
}

fn process_liveness(status: RunStatus) -> ProcessLivenessSummary {
    match status {
        RunStatus::Running => ProcessLivenessSummary {
            status: "unavailable".to_owned(),
            observed: false,
            detail: "Executor process IDs are not persisted for this run, so liveness cannot be verified from state.".to_owned(),
        },
        RunStatus::Pending => ProcessLivenessSummary {
            status: "not-started".to_owned(),
            observed: false,
            detail: "Run has not started.".to_owned(),
        },
        RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled => ProcessLivenessSummary {
            status: "not-running".to_owned(),
            observed: true,
            detail: "Run is terminal in persisted state.".to_owned(),
        },
    }
}

fn run_phase(state: &RunState, graph: &CampaignGraph) -> String {
    if state.status == RunStatus::Pending {
        return "not-started".to_owned();
    }
    let start_status = state
        .nodes
        .get(&NodeId::from(START_NODE_ID))
        .map(|node| node.status);
    let finish_status = state
        .nodes
        .get(&NodeId::from(FINISH_NODE_ID))
        .map(|node| node.status);
    if matches!(finish_status, Some(NodeStatus::Succeeded)) {
        return "finished".to_owned();
    }
    if matches!(start_status, Some(NodeStatus::Running | NodeStatus::Ready))
        || graph
            .nodes
            .iter()
            .any(|node| node.id.as_str() == START_NODE_ID)
            && start_status.is_some_and(|status| status != NodeStatus::Succeeded)
    {
        return "starting".to_owned();
    }
    if state.finished_at.is_some() {
        "finished".to_owned()
    } else {
        "active".to_owned()
    }
}

fn file_modified_seconds(run_root: &Path, node: &Node, file_name: &str) -> Option<f64> {
    file_modified_unix_seconds(&artifact_dir(run_root, node).join(file_name))
}

fn file_modified_unix_seconds(path: &Path) -> Option<f64> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() {
        return None;
    }
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs_f64())
}

fn artifact_dir(run_root: &Path, node: &Node) -> PathBuf {
    run_root.join(&node.artifact_dir)
}

fn required_artifacts_for_node(node: &Node) -> &[PathBuf] {
    match &node.kind {
        NodeKind::Agentic {
            required_artifacts, ..
        } => required_artifacts,
        _ => &[],
    }
}

fn artifact_present(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn relative_to_run(run_root: &Path, path: &Path) -> String {
    path.strip_prefix(run_root)
        .unwrap_or(path)
        .display()
        .to_string()
}

pub fn elapsed_seconds(state: &RunState) -> Option<f64> {
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

pub fn state_timestamp_seconds(value: &str) -> Option<f64> {
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

fn plural_suffix(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
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

pub fn config_fingerprint(toml: &str) -> String {
    hex_sha256(toml.as_bytes())
}

pub fn write_text_file(path: impl AsRef<Path>, contents: &str) -> Result<(), StateError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

#[derive(Debug, Error)]
pub enum StateError {
    #[error("state I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid state JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("restart input {path} is unavailable: {reason}")]
    MissingRestartInput { path: PathBuf, reason: String },
    #[error("restart source graph {path} is invalid: {reason}")]
    InvalidRestartGraph { path: PathBuf, reason: String },
    #[error("{kind} fingerprint mismatch: expected {expected}, got {actual}")]
    FingerprintMismatch {
        kind: &'static str,
        expected: String,
        actual: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use ultrafuzz_topology::{LoopMode, RetryPolicy, GRAPH_VERSION};

    fn test_graph() -> CampaignGraph {
        let node_id = NodeId::from("setup");
        CampaignGraph {
            run_id: RunId::from("run"),
            graph_version: GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![Node {
                id: node_id.clone(),
                label: "Setup".to_owned(),
                kind: NodeKind::Agentic {
                    logical_id: node_id.clone(),
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
            }],
        }
    }

    fn test_node(id: &str, depends_on: &[&str]) -> Node {
        let node_id = NodeId::from(id);
        Node {
            id: node_id.clone(),
            label: id.to_owned(),
            kind: NodeKind::Agentic {
                logical_id: node_id.clone(),
                prompt_path: PathBuf::from(format!("{id}.md")),
                attempt_index: 0,
                loop_count: 1,
                loop_mode: LoopMode::Parallel,
                group: None,
                required_artifacts: Vec::new(),
                primary_artifact: None,
            },
            depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
            timeout: None,
            retry: RetryPolicy::default(),
            artifact_dir: PathBuf::from("artifacts").join(id),
        }
    }

    fn continuation_graph() -> CampaignGraph {
        CampaignGraph {
            run_id: RunId::from("old-run"),
            graph_version: GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![
                test_node("setup", &[]),
                test_node("failed", &["setup"]),
                test_node("downstream", &["failed"]),
                test_node("independent", &["setup"]),
            ],
        }
    }

    fn health_graph(run_id: RunId) -> CampaignGraph {
        CampaignGraph {
            run_id,
            graph_version: GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![
                Node {
                    id: NodeId::from("setup"),
                    label: "Setup".to_owned(),
                    kind: NodeKind::Agentic {
                        logical_id: NodeId::from("setup"),
                        prompt_path: PathBuf::from("setup/setup.md"),
                        attempt_index: 0,
                        loop_count: 1,
                        loop_mode: LoopMode::Parallel,
                        group: None,
                        required_artifacts: vec![PathBuf::from("setup.md")],
                        primary_artifact: Some(PathBuf::from("setup.md")),
                    },
                    depends_on: Vec::new(),
                    timeout: None,
                    retry: RetryPolicy::default(),
                    artifact_dir: PathBuf::from("artifacts/setup"),
                },
                Node {
                    id: NodeId::from("fuzz"),
                    label: "Fuzz".to_owned(),
                    kind: NodeKind::Agentic {
                        logical_id: NodeId::from("fuzz"),
                        prompt_path: PathBuf::from("fuzz/fuzz.md"),
                        attempt_index: 0,
                        loop_count: 1,
                        loop_mode: LoopMode::Parallel,
                        group: None,
                        required_artifacts: vec![PathBuf::from("result.md")],
                        primary_artifact: Some(PathBuf::from("result.md")),
                    },
                    depends_on: vec![NodeId::from("setup")],
                    timeout: Some(Duration::from_secs(300)),
                    retry: RetryPolicy::default(),
                    artifact_dir: PathBuf::from("artifacts/fuzz"),
                },
            ],
        }
    }

    fn usage(total_tokens: u64, cost: u64) -> NodeUsage {
        NodeUsage {
            schema_version: ACCOUNTING_SCHEMA_VERSION.to_owned(),
            pricing_as_of: "2026-06-11".to_owned(),
            source_path: PathBuf::from("stdout.log"),
            provider: "openai".to_owned(),
            backend: Some(BackendKind::CodexCli),
            model_id: Some(ModelProfileId::from("gpt")),
            model: Some("gpt-5.4".to_owned()),
            tokens: TokenUsage {
                input_tokens: total_tokens,
                total_tokens,
                ..TokenUsage::default()
            },
            tokens_used: format_token_count(total_tokens),
            cost_status: CostEstimateStatus::Complete,
            estimated_cost_microusd: Some(cost),
            estimated_spend: Some(format_microusd(cost)),
            unresolved_pricing: Vec::new(),
        }
    }

    #[test]
    fn writes_and_reads_state_json() {
        let temp = tempfile::tempdir().unwrap();
        let store = RunStateStore::for_run_root(temp.path());
        let mut state = RunState::new(RunId::from("run"));
        state.graph_fingerprint = "graph".to_owned();
        state.config_fingerprint = "config".to_owned();
        state.set_node_status(&NodeId::from("setup"), NodeStatus::Succeeded);

        store.save(&state).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded, state);
        assert_eq!(
            loaded.nodes[&NodeId::from("setup")].status,
            NodeStatus::Succeeded
        );
    }

    #[test]
    fn run_usage_summary_aggregates_tokens_and_spend() {
        let node_usage = NodeUsage {
            schema_version: ACCOUNTING_SCHEMA_VERSION.to_owned(),
            pricing_as_of: "2026-06-11".to_owned(),
            source_path: PathBuf::from("artifacts/setup/stdout.log"),
            provider: "openai".to_owned(),
            backend: Some(BackendKind::CodexCli),
            model_id: Some(ModelProfileId::from("gpt")),
            model: Some("gpt-5.4".to_owned()),
            tokens: TokenUsage {
                input_tokens: 1_500,
                cached_input_tokens: 300,
                output_tokens: 100,
                reasoning_output_tokens: 20,
                total_tokens: 1_600,
                ..TokenUsage::default()
            },
            tokens_used: format_token_count(1_600),
            cost_status: CostEstimateStatus::Complete,
            estimated_cost_microusd: Some(4_575),
            estimated_spend: Some("<$1".to_owned()),
            unresolved_pricing: Vec::new(),
        };

        let summary = RunUsageSummary::from_node_usages([&node_usage]).unwrap();

        assert_eq!(summary.tokens.total_tokens, 1_600);
        assert_eq!(summary.tokens_used, "1.6K");
        assert_eq!(summary.estimated_cost_microusd, Some(4_575));
        assert_eq!(summary.estimated_spend.as_deref(), Some("<$1"));
        assert_eq!(summary.models.len(), 1);
        assert_eq!(summary.models[0].tokens_used, "1.6K");
    }

    #[test]
    fn run_health_detects_stale_running_run_and_restart_reuse() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = temp.path().join("runs");
        let run_root = runs_dir.join("run-1");
        let mut graph = health_graph(RunId::from("run-1"));
        graph.nodes[1].timeout = Some(Duration::from_secs(1_800));
        fs::create_dir_all(run_root.join("artifacts/setup")).unwrap();
        fs::create_dir_all(run_root.join("artifacts/fuzz")).unwrap();
        fs::write(run_root.join("artifacts/setup/setup.md"), "setup").unwrap();
        fs::write(run_root.join("artifacts/fuzz/stdout.log"), "old output").unwrap();
        fs::write(run_root.join(RESOLVED_CONFIG_FILE_NAME), "config").unwrap();
        let stdout_modified =
            file_modified_unix_seconds(&run_root.join("artifacts/fuzz/stdout.log")).unwrap();
        let now = stdout_modified + 700.0;

        let mut state = RunState::from_graph(
            RunId::from("run-1"),
            &graph,
            "graph".to_owned(),
            "config".to_owned(),
            None,
        );
        state.status = RunStatus::Running;
        state.started_at = Some(format!("{:.3}Z", now - 720.0));
        state.nodes.get_mut(&NodeId::from("setup")).unwrap().status = NodeStatus::Succeeded;
        let fuzz = state.nodes.get_mut(&NodeId::from("fuzz")).unwrap();
        fuzz.status = NodeStatus::Running;
        fuzz.started_at = Some(format!("{:.3}Z", now - 720.0));

        let health = summarize_run_health_at(
            &run_root,
            &runs_dir,
            &graph,
            &state,
            now,
            Duration::from_secs(600),
        );

        assert!(health.stale.stale);
        assert_eq!(health.stdout_freshness.status, "stale");
        assert_eq!(health.active_nodes[0].node_id, "fuzz");
        assert_eq!(health.timeout.status, "within-timeout");
        assert_eq!(health.artifacts.total_required, 2);
        assert_eq!(health.artifacts.present_required, 1);
        assert_eq!(health.artifacts.missing_required, 1);
        assert!(health.restart.available);
        assert_eq!(health.restart.reusable_count, 1);
        assert!(health
            .restart
            .guidance
            .contains("Run appears stale; restart can reuse 1 completed non-meta node."));
        assert_eq!(health.process_liveness.status, "unavailable");
    }

    #[test]
    fn run_health_treats_recently_started_silent_node_as_fresh_activity() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = temp.path().join("runs");
        let run_root = runs_dir.join("run-1");
        let graph = health_graph(RunId::from("run-1"));
        fs::create_dir_all(run_root.join("artifacts/setup")).unwrap();
        fs::create_dir_all(run_root.join("artifacts/fuzz")).unwrap();
        fs::write(run_root.join("artifacts/setup/setup.md"), "setup").unwrap();
        fs::write(run_root.join(RESOLVED_CONFIG_FILE_NAME), "config").unwrap();
        let now = 700.0;

        let mut state = RunState::from_graph(
            RunId::from("run-1"),
            &graph,
            "graph".to_owned(),
            "config".to_owned(),
            None,
        );
        state.status = RunStatus::Running;
        state.started_at = Some("100.000Z".to_owned());
        state.nodes.get_mut(&NodeId::from("setup")).unwrap().status = NodeStatus::Succeeded;
        let fuzz = state.nodes.get_mut(&NodeId::from("fuzz")).unwrap();
        fuzz.status = NodeStatus::Running;
        fuzz.started_at = Some("650.000Z".to_owned());

        let health = summarize_run_health_at(
            &run_root,
            &runs_dir,
            &graph,
            &state,
            now,
            Duration::from_secs(600),
        );

        assert!(!health.stale.stale);
        assert_eq!(health.stale.status, "healthy");
        assert_eq!(health.stdout_freshness.status, "missing");
        assert_eq!(
            health.stale.newest_activity_path.as_deref(),
            Some("state.json#/nodes/fuzz/started_at")
        );
        assert_eq!(health.stale.newest_activity_age_seconds, Some(50.0));
        assert!(health.restart.guidance.contains(
            "Run is still marked running; restart would reuse 1 completed non-meta node."
        ));
    }

    #[test]
    fn run_health_accumulates_restart_lineage() {
        let temp = tempfile::tempdir().unwrap();
        let runs_dir = temp.path().join("runs");
        let source_root = runs_dir.join("source-run");
        let run_root = runs_dir.join("run-2");
        let source_graph = health_graph(RunId::from("source-run"));
        let graph = health_graph(RunId::from("run-2"));
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&run_root).unwrap();

        let mut source_state = RunState::from_graph(
            RunId::from("source-run"),
            &source_graph,
            "graph".to_owned(),
            "config".to_owned(),
            None,
        );
        source_state.status = RunStatus::Failed;
        source_state.started_at = Some("1000Z".to_owned());
        source_state.finished_at = Some("1060Z".to_owned());
        let source_setup = source_state.nodes.get_mut(&NodeId::from("setup")).unwrap();
        source_setup.status = NodeStatus::Succeeded;
        source_setup.usage = Some(usage(1_000, 1_000_000));
        source_state.refresh_usage_summary();
        RunStateStore::for_run_root(&source_root)
            .save(&source_state)
            .unwrap();

        let mut state = RunState::from_graph(
            RunId::from("run-2"),
            &graph,
            "graph".to_owned(),
            "config".to_owned(),
            Some(RunId::from("source-run")),
        );
        state.status = RunStatus::Succeeded;
        state.started_at = Some("2000Z".to_owned());
        state.finished_at = Some("2120Z".to_owned());
        let setup = state.nodes.get_mut(&NodeId::from("setup")).unwrap();
        setup.status = NodeStatus::ReusedFromPriorRun;
        setup.usage = Some(usage(1_000, 1_000_000));
        let fuzz = state.nodes.get_mut(&NodeId::from("fuzz")).unwrap();
        fuzz.status = NodeStatus::Succeeded;
        fuzz.started_at = Some("2010Z".to_owned());
        fuzz.usage = Some(usage(2_000, 2_000_000));
        state.refresh_usage_summary();

        let health = summarize_run_health_at(
            &run_root,
            &runs_dir,
            &graph,
            &state,
            2120.0,
            Duration::from_secs(600),
        );

        assert_eq!(health.lineage.source_run_id.as_deref(), Some("source-run"));
        assert_eq!(health.lineage.source_runs, vec!["source-run"]);
        assert_eq!(health.lineage.reused_nodes, vec!["Setup"]);
        assert_eq!(health.lineage.newly_executed_nodes, vec!["Fuzz"]);
        assert_eq!(health.lineage.current_elapsed_seconds, Some(120.0));
        assert_eq!(health.lineage.final_restart_elapsed_seconds, Some(120.0));
        assert_eq!(health.lineage.cumulative_elapsed_seconds, Some(180.0));
        assert_eq!(health.lineage.current_tokens_used.as_deref(), Some("3K"));
        assert_eq!(health.lineage.cumulative_tokens_used.as_deref(), Some("3K"));
        assert_eq!(
            health.lineage.cumulative_estimated_spend.as_deref(),
            Some("$3")
        );
    }

    #[test]
    fn initializes_state_from_graph() {
        let graph = test_graph();
        let graph_fingerprint = graph.fingerprint().unwrap();
        let state = RunState::from_graph(
            RunId::from("run"),
            &graph,
            graph_fingerprint.clone(),
            "config".to_owned(),
            None,
        );

        assert_eq!(state.graph_fingerprint, graph_fingerprint);
        assert_eq!(state.nodes.len(), graph.nodes.len());
        assert!(state
            .nodes
            .values()
            .all(|node| node.status == NodeStatus::Pending));
    }

    #[test]
    fn derives_clean_restart_without_reusable_nodes() {
        let temp = tempfile::tempdir().unwrap();
        let source_root = temp.path().join("old-run");
        fs::create_dir_all(&source_root).unwrap();
        let mut state = RunState::new(RunId::from("old-run"));
        state.graph_fingerprint = "graph".to_owned();
        state.config_fingerprint = config_fingerprint("config");
        let mut start = NodeState::new(NodeId::from(START_NODE_ID));
        start.status = NodeStatus::Succeeded;
        state.nodes.insert(start.node_id.clone(), start);
        let mut setup = NodeState::new(NodeId::from("setup"));
        setup.status = NodeStatus::Succeeded;
        state.nodes.insert(setup.node_id.clone(), setup);
        let mut already_reused = NodeState::new(NodeId::from("already-reused"));
        already_reused.status = NodeStatus::ReusedFromPriorRun;
        state
            .nodes
            .insert(already_reused.node_id.clone(), already_reused);
        let mut failed = NodeState::new(NodeId::from("failed"));
        failed.status = NodeStatus::Failed;
        state.nodes.insert(failed.node_id.clone(), failed);
        RunStateStore::for_run_root(&source_root)
            .save(&state)
            .unwrap();
        fs::write(source_root.join(RESOLVED_CONFIG_FILE_NAME), "config").unwrap();

        let plan = RestartPlan::derive_clean(&source_root, RunId::from("new-run")).unwrap();

        assert_eq!(plan.mode, RestartMode::Clean);
        assert_eq!(plan.source_run_id, RunId::from("old-run"));
        assert_eq!(plan.new_run_id, RunId::from("new-run"));
        assert!(plan.reusable_nodes.is_empty());
        assert_eq!(plan.resolved_config_toml, "config");
    }

    #[test]
    fn derives_continuation_with_unaffected_reusable_frontier() {
        let temp = tempfile::tempdir().unwrap();
        let source_root = temp.path().join("old-run");
        fs::create_dir_all(&source_root).unwrap();
        let graph = continuation_graph();
        fs::write(
            source_root.join(GRAPH_FILE_NAME),
            graph.to_json_pretty().unwrap(),
        )
        .unwrap();
        let mut state = RunState::new(RunId::from("old-run"));
        state.graph_fingerprint = graph.fingerprint().unwrap();
        state.config_fingerprint = config_fingerprint("config");
        for (node_id, status) in [
            ("setup", NodeStatus::Succeeded),
            ("failed", NodeStatus::Failed),
            ("downstream", NodeStatus::Succeeded),
            ("independent", NodeStatus::ReusedFromPriorRun),
        ] {
            let mut node = NodeState::new(NodeId::from(node_id));
            node.status = status;
            state.nodes.insert(node.node_id.clone(), node);
        }
        RunStateStore::for_run_root(&source_root)
            .save(&state)
            .unwrap();
        fs::write(source_root.join(RESOLVED_CONFIG_FILE_NAME), "config").unwrap();

        let plan = RestartPlan::derive_continuation(&source_root, RunId::from("new-run")).unwrap();

        assert_eq!(plan.mode, RestartMode::ReuseCompletedArtifacts);
        assert_eq!(
            plan.reusable_nodes,
            vec![NodeId::from("setup"), NodeId::from("independent")]
        );
    }

    #[test]
    fn rejects_continuation_with_graph_fingerprint_mismatch() {
        let temp = tempfile::tempdir().unwrap();
        let source_root = temp.path().join("old-run");
        fs::create_dir_all(&source_root).unwrap();
        let graph = continuation_graph();
        fs::write(
            source_root.join(GRAPH_FILE_NAME),
            graph.to_json_pretty().unwrap(),
        )
        .unwrap();
        let mut state = RunState::new(RunId::from("old-run"));
        state.graph_fingerprint = "stale-graph".to_owned();
        state.config_fingerprint = config_fingerprint("config");
        RunStateStore::for_run_root(&source_root)
            .save(&state)
            .unwrap();
        fs::write(source_root.join(RESOLVED_CONFIG_FILE_NAME), "config").unwrap();

        let error =
            RestartPlan::derive_continuation(&source_root, RunId::from("new-run")).unwrap_err();

        assert!(matches!(
            error,
            StateError::FingerprintMismatch { kind: "graph", .. }
        ));
    }

    #[test]
    fn rejects_existing_state_with_mismatched_fingerprints() {
        let temp = tempfile::tempdir().unwrap();
        let store = RunStateStore::for_run_root(temp.path());
        let mut existing = RunState::new(RunId::from("run"));
        existing.graph_fingerprint = "old-graph".to_owned();
        existing.config_fingerprint = "same-config".to_owned();
        store.save(&existing).unwrap();

        let mut requested = RunState::new(RunId::from("run"));
        requested.graph_fingerprint = "new-graph".to_owned();
        requested.config_fingerprint = "same-config".to_owned();

        let error = store.load_or_initialize(requested).unwrap_err();
        assert!(matches!(
            error,
            StateError::FingerprintMismatch { kind: "graph", .. }
        ));
    }
}
