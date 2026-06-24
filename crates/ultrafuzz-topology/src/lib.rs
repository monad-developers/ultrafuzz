use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use thiserror::Error;
use ultrafuzz_config::{CampaignConfig, CliOverrides, EnvOverrides};
use ultrafuzz_core::{
    ModelProfileId, NodeId, PromptId, ReferenceId, RunId, StrategyId,
    STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID, STATEFUL_INVARIANT_RECON_CAMPAIGN_ID,
};
use ultrafuzz_prompts::{
    extract_prompt_ancestor_artifact_references, extract_prompt_artifact_path_references,
    parse_prompt_document, topology_prompt_markdown, PromptAncestorArtifactsSelector,
    PromptArtifactPathProducer, PromptRegistry,
};

pub const GRAPH_VERSION: &str = "1";
pub const PROJECT_TOPOLOGY_FILE: &str = ".ultrafuzz/topology.yml";
pub const PROJECT_PROMPT_DIR: &str = ".ultrafuzz/prompts";
pub const TOPOLOGY_VERSION: u32 = 1;
pub const START_NODE_ID: &str = "__start__";
pub const FINISH_NODE_ID: &str = "__finish__";
pub const DEFAULT_STRATEGY_LOOPS: usize = 3;
const LONG_RUNNING_NODE_TIMEOUT_SECONDS: u64 = 3_600;
pub const MAX_LOOPS: usize = 256;
pub const MAX_TOPOLOGY_NODES: usize = 4096;
pub const MAX_EXPANDED_TOPOLOGY_NODES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProjectTopology {
    pub version: u32,
    pub defaults: TopologyDefaults,
    #[serde(default)]
    pub groups: BTreeMap<String, TopologyGroup>,
    pub nodes: Vec<TopologyNode>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TopologyDefaults {
    pub strategy_loops: usize,
}

impl Default for TopologyDefaults {
    fn default() -> Self {
        Self {
            strategy_loops: DEFAULT_STRATEGY_LOOPS,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct TopologyGroup {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TopologyNode {
    pub id: NodeId,
    #[serde(default, skip_serializing_if = "TopologyNodeKind::is_agentic")]
    pub kind: TopologyNodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<MetaNodeRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<ReferenceId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<NodeId>,
    #[serde(
        default = "default_loop_count",
        skip_serializing_if = "is_default_loop_count"
    )]
    pub loops: usize,
    #[serde(default)]
    pub loop_mode: LoopMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub required_artifacts: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_artifact: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TopologyNodeKind {
    #[default]
    Agentic,
    Meta,
    Reference,
}

impl TopologyNodeKind {
    fn is_agentic(&self) -> bool {
        matches!(self, Self::Agentic)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MetaNodeRole {
    Start,
    Finish,
}

impl MetaNodeRole {
    pub fn label(self) -> &'static str {
        match self {
            Self::Start => "START",
            Self::Finish => "FINISH",
        }
    }

    pub fn canonical_id(self) -> &'static str {
        match self {
            Self::Start => START_NODE_ID,
            Self::Finish => FINISH_NODE_ID,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoopMode {
    #[default]
    Parallel,
    Series,
}

impl LoopMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Parallel => "parallel",
            Self::Series => "series",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TopologyValidationOptions {
    pub require_prompt_files: bool,
}

impl Default for TopologyValidationOptions {
    fn default() -> Self {
        Self {
            require_prompt_files: true,
        }
    }
}

fn default_loop_count() -> usize {
    1
}

fn is_default_loop_count(value: &usize) -> bool {
    *value == default_loop_count()
}

pub fn topology_path(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join(PROJECT_TOPOLOGY_FILE)
}

pub fn prompts_root(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join(PROJECT_PROMPT_DIR)
}

pub fn default_prompt_path(node_id: &NodeId) -> PathBuf {
    PathBuf::from(format!("{node_id}.md"))
}

pub fn default_prompt_path_for_node(node: &TopologyNode) -> PathBuf {
    node.group
        .as_deref()
        .map(Path::new)
        .unwrap_or_else(|| Path::new(""))
        .join(default_prompt_path(&node.id))
}

pub fn default_project_topology() -> ProjectTopology {
    let mut groups = BTreeMap::new();
    groups.insert(
        "setup".to_owned(),
        TopologyGroup {
            label: Some("Setup".to_owned()),
            color: Some("#2563eb".to_owned()),
        },
    );
    groups.insert(
        "properties".to_owned(),
        TopologyGroup {
            label: Some("Properties".to_owned()),
            color: Some("#a16207".to_owned()),
        },
    );
    groups.insert(
        "strategies".to_owned(),
        TopologyGroup {
            label: Some("Strategies".to_owned()),
            color: Some("#7c3aed".to_owned()),
        },
    );
    groups.insert(
        "references".to_owned(),
        TopologyGroup {
            label: Some("References".to_owned()),
            color: Some("#4b5563".to_owned()),
        },
    );
    groups.insert(
        "review".to_owned(),
        TopologyGroup {
            label: Some("Review".to_owned()),
            color: Some("#0f766e".to_owned()),
        },
    );

    ProjectTopology {
        version: TOPOLOGY_VERSION,
        defaults: TopologyDefaults::default(),
        groups,
        nodes: vec![
            default_meta_node(MetaNodeRole::Start, &[]),
            {
                let mut node = default_topology_node(
                    "project-discovery",
                    "setup/project-discovery.md",
                    "setup",
                    &[START_NODE_ID],
                    1,
                    &["setup/project-discovery.md"],
                );
                node.prompt = None;
                node
            },
            default_topology_node(
                "actors-flows",
                "setup/actors-flows.md",
                "setup",
                &["project-discovery"],
                1,
                &["setup/actors-flows.md"],
            ),
            default_topology_node(
                "setup-foundry",
                "setup/prepare-foundry-harness.md",
                "setup",
                &["actors-flows"],
                1,
                &["setup/setup-foundry.md"],
            ),
            default_topology_node(
                "base-test-setup",
                "setup/discover-base-test.md",
                "setup",
                &["setup-foundry"],
                1,
                &["setup/base-test-setup.md"],
            ),
            default_reference_node(
                "reference-properties-0kn0t",
                "properties.0kn0t",
                &[START_NODE_ID],
                "references/0kn0t.md",
            ),
            default_reference_node(
                "reference-properties-certora-thinking",
                "properties.certora-thinking",
                &[START_NODE_ID],
                "references/certora-thinking.md",
            ),
            default_reference_node(
                "reference-properties-certora-sanity",
                "properties.certora-sanity",
                &[START_NODE_ID],
                "references/certora-sanity.md",
            ),
            default_reference_node(
                "reference-properties-aviggiano",
                "properties.aviggiano",
                &[START_NODE_ID],
                "references/aviggiano.md",
            ),
            default_reference_node(
                "reference-properties-montyly-rounding",
                "properties.montyly-rounding",
                &[START_NODE_ID],
                "references/rounding.md",
            ),
            default_reference_node(
                "reference-properties-crytic",
                "properties.crytic",
                &[START_NODE_ID],
                "references/crytic.md",
            ),
            default_reference_node(
                "reference-properties-runtime-verification",
                "properties.runtime-verification",
                &[START_NODE_ID],
                "references/runtime-verification.md",
            ),
            default_reference_node(
                "reference-properties-a16z-erc4626",
                "properties.a16z-erc4626",
                &[START_NODE_ID],
                "references/a16z-erc4626.md",
            ),
            default_reference_node(
                "reference-properties-recon",
                "properties.recon",
                &[START_NODE_ID],
                "references/recon.md",
            ),
            default_topology_node(
                "property-specification-certora",
                "properties/certora-thinking-lens.md",
                "properties",
                &[
                    "base-test-setup",
                    "reference-properties-certora-thinking",
                    "reference-properties-certora-sanity",
                ],
                1,
                &["properties/certora.md"],
            ),
            default_topology_node(
                "property-specification-crytic",
                "properties/property-specification-crytic.md",
                "properties",
                &["base-test-setup", "reference-properties-crytic"],
                1,
                &["properties/crytic.md"],
            ),
            default_topology_node(
                "property-specification-runtime-verification",
                "properties/property-specification-runtime-verification.md",
                "properties",
                &[
                    "base-test-setup",
                    "reference-properties-runtime-verification",
                ],
                1,
                &["properties/runtime-verification.md"],
            ),
            default_topology_node(
                "property-specification-a16z",
                "properties/property-specification-a16z.md",
                "properties",
                &["base-test-setup", "reference-properties-a16z-erc4626"],
                1,
                &["properties/a16z.md"],
            ),
            default_topology_node(
                "property-specification-recon",
                "properties/recon-lens.md",
                "properties",
                &["base-test-setup", "reference-properties-recon"],
                1,
                &["properties/recon.md"],
            ),
            default_topology_node(
                "property-specification-aviggiano",
                "properties/aviggiano-lens.md",
                "properties",
                &["base-test-setup", "reference-properties-aviggiano"],
                1,
                &["properties/aviggiano.md"],
            ),
            default_topology_node(
                "property-specification-0kn0t",
                "properties/0kn0t-lens.md",
                "properties",
                &["base-test-setup", "reference-properties-0kn0t"],
                1,
                &["properties/0kn0t.md"],
            ),
            default_topology_node(
                "property-specification-josselin-feist",
                "properties/josselin-feist-lens.md",
                "properties",
                &["base-test-setup", "reference-properties-montyly-rounding"],
                1,
                &["properties/josselin-feist.md"],
            ),
            default_topology_node(
                "property-specification-fanin",
                "properties/property-specification-fanin.md",
                "properties",
                &[
                    "property-specification-certora",
                    "property-specification-crytic",
                    "property-specification-runtime-verification",
                    "property-specification-a16z",
                    "property-specification-recon",
                    "property-specification-aviggiano",
                    "property-specification-0kn0t",
                    "property-specification-josselin-feist",
                ],
                1,
                &["properties.md"],
            ),
            default_topology_node(
                "boundary-tests",
                "strategies/boundary-tests.md",
                "strategies",
                &["property-specification-fanin"],
                1,
                &["boundary-recipes.md", "boundary-recipes.json"],
            ),
            default_topology_node(
                "encode-decode",
                "strategies/encode-decode.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "differential-library-tests",
                "strategies/differential-library-tests.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "round-trip",
                "strategies/round-trip.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "workflow-property-based-tests",
                "strategies/workflow-property-based-tests.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "time-warp-sequences",
                "strategies/time-warp-sequences.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "expand-coverage",
                "strategies/expand-coverage.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "admin-config-boundaries",
                "strategies/admin-config-boundaries.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[
                    "admin-config-boundary-matrix.md",
                    "admin-config-boundary-matrix.json",
                ],
            ),
            default_topology_node(
                "external-dependency-boundaries",
                "strategies/external-dependency-boundaries.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &["dependency-scope-matrix.md", "dependency-scope-matrix.json"],
            ),
            default_topology_node(
                "amm-boundary-liquidity",
                "strategies/amm-boundary-liquidity.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "payable-fallback-accounting",
                "strategies/payable-fallback-accounting.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "externalized-state-accounting",
                "strategies/externalized-state-accounting.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "packed-action-parity",
                "strategies/packed-action-parity.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "batch-atomicity-unsupported-actions",
                "strategies/batch-atomicity-unsupported-actions.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "router-exact-accounting",
                "strategies/router-exact-accounting.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "rounding-direction-audit",
                "strategies/rounding-direction-audit.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "market-exhaustion-boundaries",
                "strategies/market-exhaustion-boundaries.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "order-replacement-collateral",
                "strategies/order-replacement-collateral.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "state-machine-boundaries",
                "strategies/state-machine-boundaries.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "lifecycle-view-boundaries",
                "strategies/lifecycle-view-boundaries.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &[],
            ),
            default_topology_node(
                "stateful-invariant-setup",
                "strategies/invariants/setup.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &["setup-inventory.md"],
            ),
            default_topology_node(
                "stateful-invariant-handlers",
                "strategies/invariants/handlers.md",
                "strategies",
                &["stateful-invariant-setup"],
                1,
                &["handler-coverage-inventory.md"],
            ),
            {
                let mut node = default_topology_node(
                    "stateful-invariant-coverage",
                    "strategies/invariants/coverage.md",
                    "strategies",
                    &[
                        "stateful-invariant-handlers",
                        "property-specification-fanin",
                    ],
                    3,
                    &[
                        "coverage-goal.json",
                        "coverage-report.md",
                        "findings.json",
                        "harness-repairs.json",
                    ],
                );
                node.loop_mode = LoopMode::Series;
                node
            },
            default_topology_node(
                STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID,
                "strategies/invariants/implement-properties.md",
                "strategies",
                &["stateful-invariant-coverage"],
                1,
                &[
                    "implemented-properties.md",
                    "implemented-properties.json",
                    "generated-tests.json",
                    "findings.json",
                ],
            ),
            default_topology_node(
                STATEFUL_INVARIANT_RECON_CAMPAIGN_ID,
                "strategies/invariants/invariant-testing-campaign.md",
                "strategies",
                &[STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID],
                1,
                &[
                    "campaign-plan.json",
                    "campaign-report.md",
                    "recon-fuzzer-results.json",
                    "generated-tests.json",
                    "findings.json",
                ],
            ),
            default_topology_node(
                "differential-oracle-planner",
                "strategies/differential/differential-oracle-planner.md",
                "strategies",
                &["base-test-setup", "property-specification-fanin"],
                1,
                &["differential-plan.json"],
            ),
            default_topology_node(
                "reference-harness-author",
                "strategies/differential/reference-harness-author.md",
                "strategies",
                &["base-test-setup", "differential-oracle-planner"],
                1,
                &["reference-harness.json"],
            ),
            default_topology_node(
                "reference-and-lane-auditor",
                "strategies/differential/reference-and-lane-auditor.md",
                "strategies",
                &["base-test-setup", "reference-harness-author"],
                1,
                &["audited-differential-lanes.json"],
            ),
            default_topology_node(
                "differential-lane-author",
                "strategies/differential/differential-lane-author.md",
                "strategies",
                &["base-test-setup", "reference-and-lane-auditor"],
                3,
                &["lane-result.json"],
            ),
            default_topology_node(
                "differential-red-triage",
                "strategies/differential/differential-red-triage.md",
                "strategies",
                &["differential-lane-author"],
                2,
                &[
                    "semantic-red-registry.json",
                    "triage-a.json",
                    "triage-b.json",
                ],
            ),
            default_topology_node(
                "differential-repair-and-report-review",
                "strategies/differential/differential-repair-and-report-review.md",
                "strategies",
                &[
                    "base-test-setup",
                    "differential-lane-author",
                    "differential-red-triage",
                ],
                1,
                &[
                    "repair-summary.json",
                    "gap-review.json",
                    "differential-report-review.json",
                ],
            ),
            {
                let mut node = default_topology_node(
                    "dynamic-strategy-generator",
                    "strategies/dynamic-strategy-generator.md",
                    "strategies",
                    &[
                        "encode-decode",
                        "differential-library-tests",
                        "round-trip",
                        "workflow-property-based-tests",
                        "time-warp-sequences",
                        "amm-boundary-liquidity",
                        "payable-fallback-accounting",
                        "externalized-state-accounting",
                        "packed-action-parity",
                        "batch-atomicity-unsupported-actions",
                        "router-exact-accounting",
                        "rounding-direction-audit",
                        "admin-config-boundaries",
                        "external-dependency-boundaries",
                        "market-exhaustion-boundaries",
                        "order-replacement-collateral",
                        "state-machine-boundaries",
                        "lifecycle-view-boundaries",
                        "stateful-invariant-coverage",
                        STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID,
                        STATEFUL_INVARIANT_RECON_CAMPAIGN_ID,
                        "expand-coverage",
                        "boundary-tests",
                        "differential-repair-and-report-review",
                    ],
                    1,
                    &[
                        "strategy-plan.json",
                        "enumerator-outputs.json",
                        "aggregate-recommendations.json",
                        "selected-strategies.json",
                        "generated-tests.json",
                        "findings.json",
                        "provenance.json",
                    ],
                );
                node.timeout_seconds = Some(14_400);
                node
            },
            default_topology_node(
                "dedupe-findings",
                "review/dedupe-findings.md",
                "review",
                &[
                    "encode-decode",
                    "differential-library-tests",
                    "round-trip",
                    "workflow-property-based-tests",
                    "time-warp-sequences",
                    "amm-boundary-liquidity",
                    "payable-fallback-accounting",
                    "externalized-state-accounting",
                    "packed-action-parity",
                    "batch-atomicity-unsupported-actions",
                    "router-exact-accounting",
                    "rounding-direction-audit",
                    "admin-config-boundaries",
                    "external-dependency-boundaries",
                    "market-exhaustion-boundaries",
                    "order-replacement-collateral",
                    "state-machine-boundaries",
                    "lifecycle-view-boundaries",
                    "stateful-invariant-coverage",
                    STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID,
                    STATEFUL_INVARIANT_RECON_CAMPAIGN_ID,
                    "expand-coverage",
                    "boundary-tests",
                    "differential-repair-and-report-review",
                    "dynamic-strategy-generator",
                ],
                1,
                &[
                    "deduped-findings.json",
                    "strategy-detections.json",
                    "finding-lifecycle-ledger.json",
                ],
            ),
            with_timeout(
                default_topology_node(
                    "triage",
                    "review/triage.md",
                    "review",
                    &["dedupe-findings"],
                    1,
                    &["triaged-findings.json", "finding-lifecycle-ledger.json"],
                ),
                LONG_RUNNING_NODE_TIMEOUT_SECONDS,
            ),
            with_timeout(
                default_topology_node(
                    "severity-classification",
                    "review/severity-classification.md",
                    "review",
                    &["triage"],
                    1,
                    &[
                        "severity-classified-findings.json",
                        "strategy-detections.json",
                        "finding-lifecycle-ledger.json",
                    ],
                ),
                LONG_RUNNING_NODE_TIMEOUT_SECONDS,
            ),
            with_timeout(
                default_topology_node(
                    "aggregate-test-files",
                    "review/aggregate-test-files.md",
                    "review",
                    &["severity-classification"],
                    1,
                    &["aggregation.json"],
                ),
                LONG_RUNNING_NODE_TIMEOUT_SECONDS,
            ),
            {
                let mut node = default_topology_node(
                    "final-report",
                    "review/final-report.md",
                    "review",
                    &["aggregate-test-files"],
                    1,
                    &["report.md", "report.json"],
                );
                node.loop_mode = LoopMode::Series;
                node.timeout_seconds = Some(LONG_RUNNING_NODE_TIMEOUT_SECONDS);
                node
            },
            default_meta_node(MetaNodeRole::Finish, &["final-report"]),
        ],
    }
}

fn default_meta_node(role: MetaNodeRole, depends_on: &[&str]) -> TopologyNode {
    TopologyNode {
        id: NodeId::from(role.canonical_id()),
        kind: TopologyNodeKind::Meta,
        role: Some(role),
        prompt: None,
        reference: None,
        group: None,
        depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
        loops: 1,
        loop_mode: LoopMode::Parallel,
        timeout_seconds: None,
        required_artifacts: Vec::new(),
        primary_artifact: None,
    }
}

fn default_topology_node(
    id: &str,
    prompt: &str,
    group: &str,
    depends_on: &[&str],
    loops: usize,
    required_artifacts: &[&str],
) -> TopologyNode {
    let required_artifacts = required_artifacts
        .iter()
        .map(|path| PathBuf::from(*path))
        .collect::<Vec<_>>();
    let primary_artifact = required_artifacts.first().cloned();

    TopologyNode {
        id: NodeId::from(id),
        kind: TopologyNodeKind::Agentic,
        role: None,
        prompt: Some(PathBuf::from(prompt)),
        reference: None,
        group: Some(group.to_owned()),
        depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
        loops,
        loop_mode: LoopMode::Parallel,
        timeout_seconds: None,
        required_artifacts,
        primary_artifact,
    }
}

fn default_reference_node(
    id: &str,
    reference: &str,
    depends_on: &[&str],
    primary_artifact: &str,
) -> TopologyNode {
    TopologyNode {
        id: NodeId::from(id),
        kind: TopologyNodeKind::Reference,
        role: None,
        prompt: None,
        reference: Some(ReferenceId::from(reference)),
        group: Some("references".to_owned()),
        depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
        loops: 1,
        loop_mode: LoopMode::Parallel,
        timeout_seconds: Some(300),
        required_artifacts: vec![
            PathBuf::from(primary_artifact),
            PathBuf::from(ultrafuzz_references::RUN_REFERENCE_MANIFEST_FILE),
        ],
        primary_artifact: Some(PathBuf::from(primary_artifact)),
    }
}

fn with_timeout(mut node: TopologyNode, timeout_seconds: u64) -> TopologyNode {
    node.timeout_seconds = Some(timeout_seconds);
    node
}

pub fn write_default_project_topology(
    project_root: impl AsRef<Path>,
    force: bool,
) -> Result<TopologyScaffoldReport, GraphError> {
    write_default_project_topology_with_strategy_loops(project_root, force, DEFAULT_STRATEGY_LOOPS)
}

pub fn write_default_project_topology_with_strategy_loops(
    project_root: impl AsRef<Path>,
    force: bool,
    strategy_loops: usize,
) -> Result<TopologyScaffoldReport, GraphError> {
    validate_strategy_loop_default(strategy_loops)?;
    let project_root = project_root.as_ref();
    let path = topology_path(project_root);
    ensure_no_symlink_components(&path)?;
    if path.exists() && !force {
        return Ok(TopologyScaffoldReport {
            written: None,
            skipped: Some(path),
        });
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| GraphError::TopologyIo(parent.to_path_buf(), error.to_string()))?;
    }
    let mut topology = default_project_topology();
    topology.defaults.strategy_loops = strategy_loops;
    add_missing_project_strategy_nodes(project_root, &mut topology)?;
    validate_project_topology(
        project_root,
        &topology,
        TopologyValidationOptions {
            require_prompt_files: false,
        },
    )?;
    let contents = serde_yaml::to_string(&topology)
        .map_err(|error| GraphError::TopologySerialization(error.to_string()))?;
    fs::write(&path, contents)
        .map_err(|error| GraphError::TopologyIo(path.clone(), error.to_string()))?;
    Ok(TopologyScaffoldReport {
        written: Some(path),
        skipped: None,
    })
}

fn add_missing_project_strategy_nodes(
    project_root: &Path,
    topology: &mut ProjectTopology,
) -> Result<(), GraphError> {
    let registry = PromptRegistry::load_for_project(project_root)
        .map_err(|error| GraphError::PromptDiscovery(error.to_string()))?;
    let strategies = effective_prompt_strategy_definitions(project_root, &registry)?;
    let prompt_root = prompts_root(project_root);
    let mut existing = topology
        .nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    let mut added = Vec::<NodeId>::new();
    let mut nodes = Vec::<TopologyNode>::new();

    for strategy in strategies {
        let id = NodeId::from(strategy.id.as_str());
        if !strategy.enabled || existing.contains(&id) {
            continue;
        }
        let prompt = strategy
            .prompt_path
            .strip_prefix(&prompt_root)
            .map_err(|_| GraphError::InvalidRelativePath {
                kind: "prompt",
                path: strategy.prompt_path.clone(),
            })?
            .to_path_buf();
        validate_prompt_path(&prompt_root, &prompt, true)?;
        let markdown = fs::read_to_string(&strategy.prompt_path).map_err(|error| {
            GraphError::TopologyIo(strategy.prompt_path.clone(), error.to_string())
        })?;
        let depends_on = project_strategy_dependencies(&id, &markdown)?;

        existing.insert(id.clone());
        added.push(id.clone());
        nodes.push(TopologyNode {
            id,
            kind: TopologyNodeKind::Agentic,
            role: None,
            prompt: Some(prompt),
            reference: None,
            group: Some("strategies".to_owned()),
            depends_on,
            loops: 1,
            loop_mode: LoopMode::Parallel,
            timeout_seconds: None,
            required_artifacts: Vec::new(),
            primary_artifact: None,
        });
    }

    if nodes.is_empty() {
        return Ok(());
    }

    let insert_at = topology
        .nodes
        .iter()
        .position(|node| node.id.as_str() == "dedupe-findings")
        .unwrap_or(topology.nodes.len());
    topology.nodes.splice(insert_at..insert_at, nodes);

    if let Some(dedupe) = topology
        .nodes
        .iter_mut()
        .find(|node| node.id.as_str() == "dedupe-findings")
    {
        for id in added {
            if !dedupe.depends_on.contains(&id) {
                dedupe.depends_on.push(id);
            }
        }
    }

    Ok(())
}

fn effective_prompt_strategy_definitions(
    project_root: &Path,
    registry: &PromptRegistry,
) -> Result<Vec<ultrafuzz_core::StrategyDefinition>, GraphError> {
    let config_path = project_root.join(ultrafuzz_config::CONFIG_FILE_NAME);
    let toml = if config_path.exists() {
        Some(
            fs::read_to_string(&config_path)
                .map_err(|error| GraphError::TopologyIo(config_path.clone(), error.to_string()))?,
        )
    } else {
        None
    };
    let config = ultrafuzz_config::resolve_config_from_toml(
        toml.as_deref(),
        registry.strategy_definitions(),
        EnvOverrides::default(),
        CliOverrides::default(),
    )
    .map_err(|error| GraphError::ConfigResolution(error.to_string()))?;
    Ok(config.strategies.definitions)
}

fn project_strategy_dependencies(
    node_id: &NodeId,
    markdown: &str,
) -> Result<Vec<NodeId>, GraphError> {
    let document =
        parse_prompt_document(markdown).map_err(|error| GraphError::InvalidPromptFrontmatter {
            node: node_id.clone(),
            reason: error.to_string(),
        })?;
    let mut dependencies = BTreeSet::from([NodeId::from("property-specification-fanin")]);

    let artifact_references =
        extract_prompt_artifact_path_references(&document.body).map_err(|error| {
            GraphError::InvalidPromptArtifactReference {
                node: node_id.clone(),
                reason: error.to_string(),
            }
        })?;
    for reference in artifact_references {
        match reference.producer {
            PromptArtifactPathProducer::Current => {}
            PromptArtifactPathProducer::LogicalNode(producer)
            | PromptArtifactPathProducer::Handoff(producer) => {
                if producer != node_id.as_str() {
                    dependencies.insert(NodeId::from(producer));
                }
            }
        }
    }

    let ancestor_references =
        extract_prompt_ancestor_artifact_references(&document.body).map_err(|error| {
            GraphError::InvalidPromptArtifactReference {
                node: node_id.clone(),
                reason: error.to_string(),
            }
        })?;
    for reference in ancestor_references {
        if let PromptAncestorArtifactsSelector::Producers(producers) = reference.selector {
            for producer in producers {
                if producer != node_id.as_str() {
                    dependencies.insert(NodeId::from(producer));
                }
            }
        }
    }

    Ok(dependencies.into_iter().collect())
}

pub fn set_project_strategy_loops(
    project_root: impl AsRef<Path>,
    strategy_loops: usize,
) -> Result<ProjectTopology, GraphError> {
    validate_strategy_loop_default(strategy_loops)?;
    let project_root = project_root.as_ref();
    let path = topology_path(project_root);
    ensure_no_symlink_components(&path)?;
    let mut topology = load_project_topology(project_root)?;
    topology.defaults.strategy_loops = strategy_loops;
    validate_project_topology(
        project_root,
        &topology,
        TopologyValidationOptions {
            require_prompt_files: false,
        },
    )?;
    let contents = serde_yaml::to_string(&topology)
        .map_err(|error| GraphError::TopologySerialization(error.to_string()))?;
    fs::write(&path, contents)
        .map_err(|error| GraphError::TopologyIo(path.clone(), error.to_string()))?;
    Ok(topology)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TopologyScaffoldReport {
    pub written: Option<PathBuf>,
    pub skipped: Option<PathBuf>,
}

pub fn load_project_topology(
    project_root: impl AsRef<Path>,
) -> Result<ProjectTopology, GraphError> {
    let project_root = project_root.as_ref();
    let path = topology_path(project_root);
    if !path.exists() {
        return Err(GraphError::MissingTopology(path));
    }
    ensure_no_symlink_components(&path)?;
    let contents = fs::read_to_string(&path)
        .map_err(|err| GraphError::TopologyIo(path.clone(), err.to_string()))?;
    let topology = serde_yaml::from_str::<ProjectTopology>(&contents)
        .map_err(|err| GraphError::TopologyParse(err.to_string()))?;
    validate_project_topology(
        project_root,
        &topology,
        TopologyValidationOptions {
            require_prompt_files: false,
        },
    )?;
    Ok(topology)
}

/// Repair reserved START/FINISH node ids and ensure the meta anchors exist.
pub fn repair_topology_meta_contract(topology: &mut ProjectTopology) {
    repair_reserved_meta_node_ids(topology);
    ensure_required_meta_nodes(topology);
}

fn repair_reserved_meta_node_ids(topology: &mut ProjectTopology) {
    for node in &mut topology.nodes {
        let role = match node.id.as_str() {
            START_NODE_ID => Some(MetaNodeRole::Start),
            FINISH_NODE_ID => Some(MetaNodeRole::Finish),
            _ => None,
        };
        let Some(role) = role else {
            continue;
        };
        node.kind = TopologyNodeKind::Meta;
        node.role = Some(role);
        node.prompt = None;
        node.reference = None;
        node.group = None;
        node.loops = 1;
        node.loop_mode = LoopMode::Parallel;
        node.timeout_seconds = None;
        node.required_artifacts.clear();
        node.primary_artifact = None;
    }
}

fn ensure_required_meta_nodes(topology: &mut ProjectTopology) {
    let has_start = topology
        .nodes
        .iter()
        .any(|node| node.id.as_str() == START_NODE_ID);
    let has_finish = topology
        .nodes
        .iter()
        .any(|node| node.id.as_str() == FINISH_NODE_ID);
    if !has_start {
        topology
            .nodes
            .insert(0, default_meta_node(MetaNodeRole::Start, &[]));
    }
    if !has_finish {
        let terminals = terminal_runnable_task_node_ids(topology);
        let depends_on = terminals.iter().map(String::as_str).collect::<Vec<_>>();
        topology
            .nodes
            .push(default_meta_node(MetaNodeRole::Finish, &depends_on));
    }
}

fn terminal_runnable_task_node_ids(topology: &ProjectTopology) -> Vec<String> {
    let mut depended_on = BTreeSet::<&str>::new();
    for node in &topology.nodes {
        if node.id.as_str() == FINISH_NODE_ID {
            continue;
        }
        depended_on.extend(node.depends_on.iter().map(|id| id.as_str()));
    }
    topology
        .nodes
        .iter()
        .filter(|node| node.kind == TopologyNodeKind::Agentic)
        .filter(|node| !depended_on.contains(node.id.as_str()))
        .map(|node| node.id.to_string())
        .collect()
}

pub fn validate_project_topology(
    project_root: impl AsRef<Path>,
    topology: &ProjectTopology,
    options: TopologyValidationOptions,
) -> Result<(), GraphError> {
    let project_root = project_root.as_ref();
    if topology.version != TOPOLOGY_VERSION {
        return Err(GraphError::UnsupportedTopologyVersion(topology.version));
    }
    if topology.nodes.is_empty() {
        return Err(GraphError::NoTopologyNodes);
    }
    validate_topology_node_count(topology.nodes.len())?;
    validate_strategy_loop_default(topology.defaults.strategy_loops)?;

    for (group_id, group) in &topology.groups {
        if !is_valid_group_id(group_id) {
            return Err(GraphError::InvalidGroupId(group_id.clone()));
        }
        if let Some(color) = &group.color {
            if !is_valid_hex_color(color) {
                return Err(GraphError::InvalidGroupColor {
                    group: group_id.clone(),
                    color: color.clone(),
                });
            }
        }
    }

    let prompt_root = prompts_root(project_root);
    let mut ids = BTreeSet::<NodeId>::new();
    let mut node_by_id = BTreeMap::<NodeId, &TopologyNode>::new();
    for node in &topology.nodes {
        validate_node_id_token(node.id.as_str())?;
        if !ids.insert(node.id.clone()) {
            return Err(GraphError::DuplicateNode(node.id.clone()));
        }
        if node.loops == 0 {
            return Err(GraphError::InvalidLoopCount(node.id.clone()));
        }
        validate_loop_count(&node.id, node.loops)?;
        if let Some(timeout) = node.timeout_seconds {
            if timeout == 0 {
                return Err(GraphError::InvalidTimeout(node.id.clone()));
            }
        }
        match node.kind {
            TopologyNodeKind::Agentic => {
                if node.role.is_some() {
                    return Err(GraphError::InvalidMetaNode {
                        node: node.id.clone(),
                        reason: "agentic nodes must not set meta role".to_owned(),
                    });
                }
                if node.id.as_str() == START_NODE_ID || node.id.as_str() == FINISH_NODE_ID {
                    return Err(GraphError::InvalidMetaNode {
                        node: node.id.clone(),
                        reason: "reserved START/FINISH ids must use kind `meta`".to_owned(),
                    });
                }
                if node.reference.is_some() {
                    return Err(GraphError::InvalidReferenceNode {
                        node: node.id.clone(),
                        reason: "agentic nodes must not set reference".to_owned(),
                    });
                }
                if let Some(group_id) = &node.group {
                    if !is_valid_group_id(group_id) {
                        return Err(GraphError::InvalidGroupId(group_id.clone()));
                    }
                }
                validate_prompt_path(
                    &prompt_root,
                    &node
                        .prompt
                        .clone()
                        .unwrap_or_else(|| default_prompt_path_for_node(node)),
                    options.require_prompt_files,
                )?;
                for artifact in &node.required_artifacts {
                    validate_required_artifact_path(&node.id, artifact)?;
                }
                if let Some(primary_artifact) = &node.primary_artifact {
                    validate_primary_artifact_path(
                        &node.id,
                        primary_artifact,
                        &node.required_artifacts,
                    )?;
                }
            }
            TopologyNodeKind::Reference => validate_reference_topology_node(node)?,
            TopologyNodeKind::Meta => validate_meta_topology_node(node)?,
        }
        node_by_id.insert(node.id.clone(), node);
    }

    validate_required_meta_nodes_present(&node_by_id)?;

    for node in &topology.nodes {
        let mut seen_dependencies = BTreeSet::new();
        for dependency in &node.depends_on {
            if dependency == &node.id {
                return Err(GraphError::CycleDetected(vec![node.id.clone()]));
            }
            if !seen_dependencies.insert(dependency.clone()) {
                return Err(GraphError::DuplicateDependency {
                    node: node.id.clone(),
                    dependency: dependency.clone(),
                });
            }
            if !ids.contains(dependency) {
                return Err(GraphError::UnknownDependency {
                    node: node.id.clone(),
                    dependency: dependency.clone(),
                });
            }
        }
    }

    validate_logical_no_cycles(&node_by_id)?;
    validate_topology_entry_exit_contract(&topology.nodes)?;
    let effective_nodes = effective_loop_nodes(project_root, topology)?;
    validate_total_expanded_nodes(&effective_nodes)?;
    validate_concrete_id_collisions(&effective_nodes)?;
    validate_prompt_artifact_references(project_root, topology, &node_by_id)?;
    Ok(())
}

fn validate_required_meta_nodes_present(
    node_by_id: &BTreeMap<NodeId, &TopologyNode>,
) -> Result<(), GraphError> {
    if !node_by_id.contains_key(&NodeId::from(START_NODE_ID)) {
        return Err(GraphError::MissingMetaNode(START_NODE_ID));
    }
    if !node_by_id.contains_key(&NodeId::from(FINISH_NODE_ID)) {
        return Err(GraphError::MissingMetaNode(FINISH_NODE_ID));
    }
    Ok(())
}

fn validate_meta_topology_node(node: &TopologyNode) -> Result<(), GraphError> {
    let Some(role) = node.role else {
        return Err(GraphError::InvalidMetaNode {
            node: node.id.clone(),
            reason: "meta nodes must set `role` to `start` or `finish`".to_owned(),
        });
    };
    if node.id.as_str() != role.canonical_id() {
        return Err(GraphError::InvalidMetaNode {
            node: node.id.clone(),
            reason: format!("{role:?} meta-node id must be `{}`", role.canonical_id()),
        });
    }
    if node.prompt.is_some() {
        return Err(GraphError::InvalidMetaNode {
            node: node.id.clone(),
            reason: "meta nodes must not define a prompt".to_owned(),
        });
    }
    if node.group.is_some() {
        return Err(GraphError::InvalidMetaNode {
            node: node.id.clone(),
            reason: "meta nodes must not be assigned to a phase group".to_owned(),
        });
    }
    if node.loops != 1 {
        return Err(GraphError::InvalidMetaNode {
            node: node.id.clone(),
            reason: "meta nodes must use loops = 1".to_owned(),
        });
    }
    if node.loop_mode != LoopMode::Parallel {
        return Err(GraphError::InvalidMetaNode {
            node: node.id.clone(),
            reason: "meta nodes must use loop_mode = parallel".to_owned(),
        });
    }
    if node.timeout_seconds.is_some() {
        return Err(GraphError::InvalidMetaNode {
            node: node.id.clone(),
            reason: "meta nodes must not define timeout_seconds".to_owned(),
        });
    }
    if !node.required_artifacts.is_empty() {
        return Err(GraphError::InvalidMetaNode {
            node: node.id.clone(),
            reason: "meta nodes must not require artifacts".to_owned(),
        });
    }
    if node.primary_artifact.is_some() {
        return Err(GraphError::InvalidMetaNode {
            node: node.id.clone(),
            reason: "meta nodes must not define primary_artifact".to_owned(),
        });
    }
    Ok(())
}

fn validate_reference_topology_node(node: &TopologyNode) -> Result<(), GraphError> {
    if node.role.is_some() {
        return Err(GraphError::InvalidReferenceNode {
            node: node.id.clone(),
            reason: "reference nodes must not set meta role".to_owned(),
        });
    }
    if node.prompt.is_some() {
        return Err(GraphError::InvalidReferenceNode {
            node: node.id.clone(),
            reason: "reference nodes must not set prompt".to_owned(),
        });
    }
    if node.reference.is_none() {
        return Err(GraphError::InvalidReferenceNode {
            node: node.id.clone(),
            reason: "reference nodes must define reference".to_owned(),
        });
    }
    if node.id.as_str() == START_NODE_ID || node.id.as_str() == FINISH_NODE_ID {
        return Err(GraphError::InvalidReferenceNode {
            node: node.id.clone(),
            reason: "reserved START/FINISH ids must use kind `meta`".to_owned(),
        });
    }
    if let Some(group_id) = &node.group {
        if !is_valid_group_id(group_id) {
            return Err(GraphError::InvalidGroupId(group_id.clone()));
        }
    }
    if node.loops != 1 {
        return Err(GraphError::InvalidReferenceNode {
            node: node.id.clone(),
            reason: "reference nodes must use loops = 1".to_owned(),
        });
    }
    if node.loop_mode != LoopMode::Parallel {
        return Err(GraphError::InvalidReferenceNode {
            node: node.id.clone(),
            reason: "reference nodes must use loop_mode: parallel".to_owned(),
        });
    }
    if node.required_artifacts.is_empty() {
        return Err(GraphError::InvalidReferenceNode {
            node: node.id.clone(),
            reason: "reference nodes must define required_artifacts".to_owned(),
        });
    }
    for artifact in &node.required_artifacts {
        validate_required_artifact_path(&node.id, artifact)?;
    }
    let Some(primary_artifact) = &node.primary_artifact else {
        return Err(GraphError::InvalidReferenceNode {
            node: node.id.clone(),
            reason: "reference nodes must define primary_artifact".to_owned(),
        });
    };
    validate_primary_artifact_path(&node.id, primary_artifact, &node.required_artifacts)?;
    if primary_artifact.as_path() == Path::new(ultrafuzz_references::RUN_REFERENCE_MANIFEST_FILE) {
        return Err(GraphError::InvalidReferenceNode {
            node: node.id.clone(),
            reason: format!(
                "reference nodes must not use `{}` as primary_artifact",
                ultrafuzz_references::RUN_REFERENCE_MANIFEST_FILE
            ),
        });
    }
    if !node
        .required_artifacts
        .iter()
        .any(|path| path.as_path() == Path::new(ultrafuzz_references::RUN_REFERENCE_MANIFEST_FILE))
    {
        return Err(GraphError::InvalidReferenceNode {
            node: node.id.clone(),
            reason: format!(
                "reference nodes must include `{}` in required_artifacts",
                ultrafuzz_references::RUN_REFERENCE_MANIFEST_FILE
            ),
        });
    }
    Ok(())
}

fn validate_topology_entry_exit_contract(nodes: &[TopologyNode]) -> Result<(), GraphError> {
    let start_id = NodeId::from(START_NODE_ID);
    let finish_id = NodeId::from(FINISH_NODE_ID);
    let start = nodes
        .iter()
        .find(|node| node.id == start_id)
        .ok_or(GraphError::MissingMetaNode(START_NODE_ID))?;
    if start.kind != TopologyNodeKind::Meta || start.role != Some(MetaNodeRole::Start) {
        return Err(GraphError::InvalidMetaNode {
            node: start.id.clone(),
            reason: format!("`{START_NODE_ID}` must be `kind: meta` with `role: start`"),
        });
    }
    if !start.depends_on.is_empty() {
        return Err(GraphError::InvalidEntryExit {
            node: start.id.clone(),
            reason: "START must not depend on any node".to_owned(),
        });
    }

    let finish = nodes
        .iter()
        .find(|node| node.id == finish_id)
        .ok_or(GraphError::MissingMetaNode(FINISH_NODE_ID))?;
    if finish.kind != TopologyNodeKind::Meta || finish.role != Some(MetaNodeRole::Finish) {
        return Err(GraphError::InvalidMetaNode {
            node: finish.id.clone(),
            reason: format!("`{FINISH_NODE_ID}` must be `kind: meta` with `role: finish`"),
        });
    }
    if finish.depends_on.is_empty() {
        return Err(GraphError::InvalidEntryExit {
            node: finish.id.clone(),
            reason: "FINISH must depend on at least one terminal task".to_owned(),
        });
    }

    if nodes
        .iter()
        .all(|node| node.kind != TopologyNodeKind::Agentic)
    {
        return Err(GraphError::InvalidEntryExit {
            node: start_id,
            reason: "topology must include at least one runnable task node".to_owned(),
        });
    }

    let mut dependents = BTreeMap::<NodeId, usize>::new();
    for node in nodes {
        for dependency in &node.depends_on {
            *dependents.entry(dependency.clone()).or_default() += 1;
        }
    }

    for node in nodes {
        if node.id != start_id && node.depends_on.is_empty() {
            return Err(GraphError::InvalidEntryExit {
                node: node.id.clone(),
                reason: format!("only `{START_NODE_ID}` may have an empty depends_on list"),
            });
        }
    }

    for node in nodes {
        let dependent_count = dependents.get(&node.id).copied().unwrap_or_default();
        if node.id == finish_id {
            if dependent_count > 0 {
                return Err(GraphError::InvalidEntryExit {
                    node: node.id.clone(),
                    reason: "FINISH must not have dependents".to_owned(),
                });
            }
        } else if dependent_count == 0 {
            return Err(GraphError::InvalidEntryExit {
                node: node.id.clone(),
                reason: format!("only `{FINISH_NODE_ID}` may be terminal"),
            });
        }
    }

    Ok(())
}

pub fn build_campaign_graph_from_project(
    run_id: RunId,
    project_root: impl AsRef<Path>,
    config: &CampaignConfig,
) -> Result<CampaignGraph, GraphError> {
    let project_root = project_root.as_ref();
    let topology = load_project_topology(project_root)?;
    build_campaign_graph_from_topology(run_id, project_root, config, topology)
}

pub fn build_campaign_graph_from_topology(
    run_id: RunId,
    project_root: impl AsRef<Path>,
    config: &CampaignConfig,
    topology: ProjectTopology,
) -> Result<CampaignGraph, GraphError> {
    let project_root = project_root.as_ref();
    validate_project_topology(
        project_root,
        &topology,
        TopologyValidationOptions {
            require_prompt_files: false,
        },
    )?;

    let ProjectTopology {
        version: _,
        defaults,
        groups,
        nodes: mut logical_nodes,
    } = topology;
    let reference_catalog = if logical_nodes
        .iter()
        .any(|node| node.kind == TopologyNodeKind::Reference)
    {
        Some(
            ultrafuzz_references::load_catalog(project_root).map_err(|error| {
                GraphError::ReferenceCatalog {
                    reason: error.to_string(),
                }
            })?,
        )
    } else {
        None
    };
    for node in &mut logical_nodes {
        node.loops = resolved_loop_count(project_root, &defaults, node)?;
        validate_loop_count(&node.id, node.loops)?;
    }

    validate_total_expanded_nodes(&logical_nodes)?;
    let expansion = topology_expansion(&logical_nodes)?;
    let mut nodes = Vec::new();
    for logical in &logical_nodes {
        match logical.kind {
            TopologyNodeKind::Meta => {
                let role = logical
                    .role
                    .expect("validated meta topology node must define a role");
                nodes.push(Node {
                    artifact_dir: deterministic_artifact_dir(&logical.id),
                    id: logical.id.clone(),
                    label: role.label().to_owned(),
                    kind: NodeKind::Meta { role },
                    depends_on: lower_logical_dependencies(logical, &expansion),
                    timeout: None,
                    retry: RetryPolicy::default(),
                });
            }
            TopologyNodeKind::Reference => {
                let reference = logical
                    .reference
                    .clone()
                    .expect("validated reference topology node must define reference id");
                let revision = reference_catalog
                    .as_ref()
                    .and_then(|catalog| catalog.references.get(&reference))
                    .map(reference_revision)
                    .ok_or_else(|| GraphError::InvalidReferenceNode {
                        node: logical.id.clone(),
                        reason: format!(
                            "reference `{reference}` is not defined in .ultrafuzz/references.yml"
                        ),
                    })?;
                nodes.push(Node {
                    artifact_dir: deterministic_artifact_dir(&logical.id),
                    id: logical.id.clone(),
                    label: title_from_node_id(logical.id.as_str()),
                    kind: NodeKind::Reference {
                        reference,
                        revision: Some(revision),
                        group: logical.group.clone(),
                        required_artifacts: logical.required_artifacts.clone(),
                        primary_artifact: logical.primary_artifact.clone(),
                    },
                    depends_on: lower_logical_dependencies(logical, &expansion),
                    timeout: logical.timeout_seconds.map(Duration::from_secs),
                    retry: RetryPolicy::default(),
                });
            }
            TopologyNodeKind::Agentic => {
                let prompt_path = logical
                    .prompt
                    .clone()
                    .unwrap_or_else(|| default_prompt_path_for_node(logical));
                let timeout = Some(resolved_timeout(config, logical));
                let concrete_ids = expansion
                    .get(&logical.id)
                    .expect("validated topology expansion must contain logical id");
                for (attempt_index, concrete_id) in concrete_ids.iter().enumerate() {
                    let depends_on = if logical.loops > 1
                        && logical.loop_mode == LoopMode::Series
                        && attempt_index > 0
                    {
                        vec![concrete_ids[attempt_index - 1].clone()]
                    } else {
                        lower_logical_dependencies(logical, &expansion)
                    };
                    nodes.push(Node {
                        artifact_dir: deterministic_artifact_dir(concrete_id),
                        id: concrete_id.clone(),
                        label: if logical.loops > 1 {
                            format!(
                                "{} attempt {}",
                                title_from_node_id(logical.id.as_str()),
                                attempt_index + 1
                            )
                        } else {
                            title_from_node_id(logical.id.as_str())
                        },
                        kind: NodeKind::Agentic {
                            logical_id: logical.id.clone(),
                            prompt_path: prompt_path.clone(),
                            attempt_index,
                            loop_count: logical.loops,
                            loop_mode: logical.loop_mode,
                            group: logical.group.clone(),
                            required_artifacts: logical.required_artifacts.clone(),
                            primary_artifact: logical.primary_artifact.clone(),
                        },
                        depends_on,
                        timeout,
                        retry: RetryPolicy::default(),
                    });
                }
            }
        }
    }

    let graph = CampaignGraph {
        run_id,
        graph_version: GRAPH_VERSION.to_owned(),
        groups,
        nodes,
    };
    graph.validate()?;
    Ok(graph)
}

fn reference_revision(reference: &ultrafuzz_references::ReferenceEntry) -> ReferenceRevision {
    ReferenceRevision {
        provider: reference.provider,
        repo: reference.repo.clone(),
        commit: reference.commit.clone(),
        paths: reference.paths.clone(),
    }
}

fn effective_loop_nodes(
    project_root: &Path,
    topology: &ProjectTopology,
) -> Result<Vec<TopologyNode>, GraphError> {
    topology
        .nodes
        .iter()
        .cloned()
        .map(|mut node| {
            node.loops = resolved_loop_count(project_root, &topology.defaults, &node)?;
            validate_loop_count(&node.id, node.loops)?;
            Ok(node)
        })
        .collect()
}

fn resolved_loop_count(
    project_root: &Path,
    defaults: &TopologyDefaults,
    node: &TopologyNode,
) -> Result<usize, GraphError> {
    if node.kind != TopologyNodeKind::Agentic {
        return Ok(node.loops);
    }
    if normal_strategy_topology_node(node) {
        return Ok(defaults.strategy_loops);
    }
    if excluded_prompt_loop_metadata_path(node) {
        return Ok(node.loops);
    }
    let Some(markdown) = prompt_markdown_for_topology_node(project_root, node)? else {
        return Ok(node.loops);
    };
    let document =
        parse_prompt_document(&markdown).map_err(|error| GraphError::InvalidPromptFrontmatter {
            node: node.id.clone(),
            reason: error.to_string(),
        })?;
    if let Some(loops) = document.frontmatter.loops {
        if loops == 0 {
            return Err(GraphError::InvalidLoopCount(node.id.clone()));
        }
        validate_loop_count(&node.id, loops)?;
        return Ok(loops);
    }
    Ok(node.loops)
}

fn normal_strategy_topology_node(node: &TopologyNode) -> bool {
    if node.kind != TopologyNodeKind::Agentic {
        return false;
    }
    if node.id.as_str() == "dynamic-strategy-generator" {
        return false;
    }
    if node.group.as_deref() != Some("strategies") {
        return false;
    }
    let prompt_path = node
        .prompt
        .clone()
        .unwrap_or_else(|| default_prompt_path_for_node(node));
    let is_plan_prompt = prompt_path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .is_some_and(|file_name| file_name.ends_with("-plan.md"));
    prompt_path.starts_with("strategies/")
        && !prompt_path.starts_with("strategies/invariants")
        && !prompt_path.starts_with("strategies/differential")
        && !is_plan_prompt
}

fn resolved_timeout(config: &CampaignConfig, node: &TopologyNode) -> Duration {
    if let Some(timeout_seconds) = node.timeout_seconds {
        return Duration::from_secs(timeout_seconds);
    }
    if node.id.as_str() == STATEFUL_INVARIANT_RECON_CAMPAIGN_ID {
        return Duration::from_secs(config.invariants.invariant_testing_fuzzer_timeout_seconds);
    }
    config
        .strategies
        .definitions
        .iter()
        .find(|strategy| strategy.id.as_str() == node.id.as_str())
        .map(|strategy| strategy.timeout)
        .unwrap_or_else(|| Duration::from_secs(config.run.default_timeout_seconds))
}

fn excluded_prompt_loop_metadata_path(node: &TopologyNode) -> bool {
    let prompt_path = node
        .prompt
        .clone()
        .unwrap_or_else(|| default_prompt_path_for_node(node));
    prompt_path.starts_with("strategies/invariants")
        || prompt_path.starts_with("strategies/differential")
}

fn topology_expansion(nodes: &[TopologyNode]) -> Result<BTreeMap<NodeId, Vec<NodeId>>, GraphError> {
    validate_total_expanded_nodes(nodes)?;
    validate_concrete_id_collisions(nodes)?;
    Ok(nodes
        .iter()
        .map(|node| (node.id.clone(), concrete_ids_for(node)))
        .collect())
}

fn validate_topology_node_count(count: usize) -> Result<(), GraphError> {
    if count > MAX_TOPOLOGY_NODES {
        return Err(GraphError::TooManyTopologyNodes {
            count,
            max: MAX_TOPOLOGY_NODES,
        });
    }
    Ok(())
}

fn validate_loop_count(node: &NodeId, loops: usize) -> Result<(), GraphError> {
    if loops > MAX_LOOPS {
        return Err(GraphError::TooManyLoops {
            node: node.clone(),
            loops,
            max: MAX_LOOPS,
        });
    }
    Ok(())
}

pub fn validate_strategy_loop_default(loops: usize) -> Result<(), GraphError> {
    if loops == 0 {
        return Err(GraphError::InvalidStrategyLoopDefault);
    }
    if loops > MAX_LOOPS {
        return Err(GraphError::TooManyStrategyLoops {
            loops,
            max: MAX_LOOPS,
        });
    }
    Ok(())
}

fn validate_total_expanded_nodes(nodes: &[TopologyNode]) -> Result<(), GraphError> {
    let mut count = 0usize;
    for node in nodes {
        count = count
            .checked_add(node.loops)
            .ok_or(GraphError::TooManyExpandedNodes {
                count: usize::MAX,
                max: MAX_EXPANDED_TOPOLOGY_NODES,
            })?;
        if count > MAX_EXPANDED_TOPOLOGY_NODES {
            return Err(GraphError::TooManyExpandedNodes {
                count,
                max: MAX_EXPANDED_TOPOLOGY_NODES,
            });
        }
    }
    Ok(())
}

fn concrete_ids_for(node: &TopologyNode) -> Vec<NodeId> {
    if node.loops == 1 {
        return vec![node.id.clone()];
    }
    (0..node.loops)
        .map(|attempt_index| NodeId::from(format!("{}-{attempt_index}", node.id)))
        .collect()
}

fn lower_logical_dependencies(
    node: &TopologyNode,
    expansion: &BTreeMap<NodeId, Vec<NodeId>>,
) -> Vec<NodeId> {
    let mut depends_on = Vec::new();
    for dependency in &node.depends_on {
        if let Some(concrete) = expansion.get(dependency) {
            depends_on.extend(concrete.iter().cloned());
        }
    }
    depends_on
}

fn validate_concrete_id_collisions(nodes: &[TopologyNode]) -> Result<(), GraphError> {
    let logical_ids = nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    let mut concrete_ids = BTreeSet::new();
    for node in nodes {
        for concrete_id in concrete_ids_for(node) {
            if node.loops > 1 && logical_ids.contains(&concrete_id) {
                return Err(GraphError::ConcreteNodeIdCollision {
                    logical: node.id.clone(),
                    concrete: concrete_id,
                });
            }
            if !concrete_ids.insert(concrete_id.clone()) {
                return Err(GraphError::ConcreteNodeIdCollision {
                    logical: node.id.clone(),
                    concrete: concrete_id,
                });
            }
        }
    }
    Ok(())
}

fn validate_logical_no_cycles(
    node_by_id: &BTreeMap<NodeId, &TopologyNode>,
) -> Result<(), GraphError> {
    let mut marks: BTreeMap<NodeId, VisitMark> = BTreeMap::new();
    let mut stack = Vec::new();
    for id in node_by_id.keys() {
        visit_topology_node(id, node_by_id, &mut marks, &mut stack)?;
    }
    Ok(())
}

fn validate_prompt_artifact_references(
    project_root: &Path,
    topology: &ProjectTopology,
    node_by_id: &BTreeMap<NodeId, &TopologyNode>,
) -> Result<(), GraphError> {
    for node in &topology.nodes {
        if node.kind != TopologyNodeKind::Agentic {
            continue;
        }
        let Some(markdown) = prompt_markdown_for_topology_node(project_root, node)? else {
            continue;
        };
        let document = parse_prompt_document(&markdown).map_err(|error| {
            GraphError::InvalidPromptArtifactReference {
                node: node.id.clone(),
                reason: error.to_string(),
            }
        })?;
        let references =
            extract_prompt_artifact_path_references(&document.body).map_err(|error| {
                GraphError::InvalidPromptArtifactReference {
                    node: node.id.clone(),
                    reason: error.to_string(),
                }
            })?;
        for reference in references {
            let is_handoff = matches!(reference.producer, PromptArtifactPathProducer::Handoff(_));
            let referenced = match &reference.producer {
                PromptArtifactPathProducer::Current => continue,
                PromptArtifactPathProducer::LogicalNode(referenced)
                | PromptArtifactPathProducer::Handoff(referenced) => {
                    NodeId::from(referenced.clone())
                }
            };
            validate_prompt_artifact_reference_target(node, &referenced, node_by_id)?;
            if is_handoff {
                let producer_node = node_by_id
                    .get(&referenced)
                    .expect("validated prompt artifact reference target must exist");
                if producer_node.primary_artifact.is_none() {
                    return Err(GraphError::MissingPromptArtifactHandoff {
                        node: node.id.clone(),
                        referenced,
                    });
                }
            }
        }

        let references =
            extract_prompt_ancestor_artifact_references(&document.body).map_err(|error| {
                GraphError::InvalidPromptArtifactReference {
                    node: node.id.clone(),
                    reason: error.to_string(),
                }
            })?;
        for reference in references {
            let producers = match reference.selector {
                PromptAncestorArtifactsSelector::DirectDependencies => node.depends_on.clone(),
                PromptAncestorArtifactsSelector::Producers(producers) => {
                    producers.into_iter().map(NodeId::from).collect()
                }
            };
            if producers.is_empty() {
                return Err(GraphError::InvalidPromptArtifactReference {
                    node: node.id.clone(),
                    reason: "ancestor_artifacts found no direct dependencies to render".to_owned(),
                });
            }
            for referenced in producers {
                validate_prompt_artifact_reference_target(node, &referenced, node_by_id)?;
                let producer = node_by_id
                    .get(&referenced)
                    .expect("validated prompt artifact reference target must exist");
                if producer.required_artifacts.is_empty() {
                    return Err(GraphError::InvalidPromptArtifactReference {
                        node: node.id.clone(),
                        reason: format!(
                            "ancestor_artifacts producer `{referenced}` has no required_artifacts"
                        ),
                    });
                }
            }
        }
    }
    Ok(())
}

fn validate_prompt_artifact_reference_target(
    node: &TopologyNode,
    referenced: &NodeId,
    node_by_id: &BTreeMap<NodeId, &TopologyNode>,
) -> Result<(), GraphError> {
    if !node_by_id.contains_key(referenced) {
        return Err(GraphError::UnknownPromptArtifactReference {
            node: node.id.clone(),
            referenced: referenced.clone(),
        });
    }
    if referenced == &node.id || !logical_dependency_path_contains(node, referenced, node_by_id) {
        return Err(GraphError::NonAncestorPromptArtifactReference {
            node: node.id.clone(),
            referenced: referenced.clone(),
        });
    }
    Ok(())
}

fn prompt_markdown_for_topology_node(
    project_root: &Path,
    node: &TopologyNode,
) -> Result<Option<String>, GraphError> {
    let relative_path = node
        .prompt
        .clone()
        .unwrap_or_else(|| default_prompt_path_for_node(node));
    let full_path = prompts_root(project_root).join(&relative_path);
    if full_path.exists() {
        ensure_no_symlink_components(&full_path)?;
        return fs::read_to_string(&full_path)
            .map(Some)
            .map_err(|error| GraphError::TopologyIo(full_path, error.to_string()));
    }
    Ok(topology_prompt_markdown(&relative_path).map(str::to_owned))
}

fn logical_dependency_path_contains(
    node: &TopologyNode,
    target: &NodeId,
    node_by_id: &BTreeMap<NodeId, &TopologyNode>,
) -> bool {
    node.depends_on.iter().any(|dependency| {
        logical_dependency_or_ancestor_contains(
            dependency,
            target,
            node_by_id,
            &mut BTreeSet::new(),
        )
    })
}

fn logical_dependency_or_ancestor_contains(
    id: &NodeId,
    target: &NodeId,
    node_by_id: &BTreeMap<NodeId, &TopologyNode>,
    visited: &mut BTreeSet<NodeId>,
) -> bool {
    if id == target {
        return true;
    }
    if !visited.insert(id.clone()) {
        return false;
    }
    let Some(node) = node_by_id.get(id) else {
        return false;
    };
    node.depends_on.iter().any(|dependency| {
        logical_dependency_or_ancestor_contains(dependency, target, node_by_id, visited)
    })
}

fn visit_topology_node(
    id: &NodeId,
    node_by_id: &BTreeMap<NodeId, &TopologyNode>,
    marks: &mut BTreeMap<NodeId, VisitMark>,
    stack: &mut Vec<NodeId>,
) -> Result<(), GraphError> {
    match marks.get(id) {
        Some(VisitMark::Done) => return Ok(()),
        Some(VisitMark::Visiting) => {
            let cycle_start = stack
                .iter()
                .position(|stack_id| stack_id == id)
                .unwrap_or(0);
            return Err(GraphError::CycleDetected(stack[cycle_start..].to_vec()));
        }
        None => {}
    }

    marks.insert(id.clone(), VisitMark::Visiting);
    stack.push(id.clone());
    let node = node_by_id
        .get(id)
        .expect("validated topology node must exist");
    for dependency in &node.depends_on {
        visit_topology_node(dependency, node_by_id, marks, stack)?;
    }
    stack.pop();
    marks.insert(id.clone(), VisitMark::Done);
    Ok(())
}

fn validate_node_id_token(value: &str) -> Result<(), GraphError> {
    let valid = !value.is_empty()
        && value
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(GraphError::InvalidNodeId(value.to_owned()))
    }
}

fn is_valid_group_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'))
}

fn is_valid_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.as_bytes()[0] == b'#'
        && value.as_bytes()[1..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit())
}

fn validate_prompt_path(
    prompt_root: &Path,
    relative_path: &Path,
    require_file: bool,
) -> Result<(), GraphError> {
    validate_relative_path("prompt", relative_path)?;
    ensure_no_symlink_components(prompt_root)?;
    let full_path = prompt_root.join(relative_path);
    ensure_path_inside(prompt_root, &full_path)?;
    if require_file {
        if !full_path.is_file() {
            return Err(GraphError::MissingPromptFile(relative_path.to_path_buf()));
        }
        ensure_no_symlink_components(&full_path)?;
    } else if let Some(parent) = full_path.parent() {
        ensure_no_symlink_components(parent)?;
    }
    Ok(())
}

fn validate_required_artifact_path(node_id: &NodeId, path: &Path) -> Result<(), GraphError> {
    if path.as_os_str().is_empty() {
        return Err(GraphError::InvalidRequiredArtifact {
            node: node_id.clone(),
            path: path.to_path_buf(),
        });
    }
    validate_relative_path("required artifact", path).map_err(|_| {
        GraphError::InvalidRequiredArtifact {
            node: node_id.clone(),
            path: path.to_path_buf(),
        }
    })
}

fn validate_primary_artifact_path(
    node_id: &NodeId,
    path: &Path,
    required_artifacts: &[PathBuf],
) -> Result<(), GraphError> {
    if path.as_os_str().is_empty() {
        return Err(GraphError::InvalidPrimaryArtifact {
            node: node_id.clone(),
            path: path.to_path_buf(),
        });
    }
    validate_relative_path("primary artifact", path).map_err(|_| {
        GraphError::InvalidPrimaryArtifact {
            node: node_id.clone(),
            path: path.to_path_buf(),
        }
    })?;
    if !required_artifacts.iter().any(|required| required == path) {
        return Err(GraphError::PrimaryArtifactNotRequired {
            node: node_id.clone(),
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

fn validate_relative_path(kind: &'static str, path: &Path) -> Result<(), GraphError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(GraphError::InvalidRelativePath {
            kind,
            path: path.to_path_buf(),
        });
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(GraphError::InvalidRelativePath {
                    kind,
                    path: path.to_path_buf(),
                })
            }
        }
    }
    Ok(())
}

fn ensure_no_symlink_components(path: &Path) -> Result<(), GraphError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(GraphError::SymlinkPath(current));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(GraphError::TopologyIo(current, error.to_string())),
        }
    }
    Ok(())
}

fn ensure_path_inside(root: &Path, path: &Path) -> Result<(), GraphError> {
    let root = normalize_existing_or_parent(root)?;
    let candidate = normalize_existing_or_parent(path)?;
    if candidate == root || candidate.starts_with(&root) {
        Ok(())
    } else {
        Err(GraphError::InvalidRelativePath {
            kind: "path",
            path: path.to_path_buf(),
        })
    }
}

fn normalize_existing_or_parent(path: &Path) -> Result<PathBuf, GraphError> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| GraphError::TopologyIo(path.to_path_buf(), error.to_string()))?
            .join(path)
    };
    if path.exists() {
        return path
            .canonicalize()
            .map_err(|error| GraphError::TopologyIo(path.clone(), error.to_string()));
    }

    let mut missing = Vec::new();
    let mut current = path.as_path();
    while !current.exists() {
        let Some(file_name) = current.file_name() else {
            return Err(GraphError::InvalidRelativePath {
                kind: "path",
                path: path.clone(),
            });
        };
        missing.push(file_name.to_owned());
        current = current
            .parent()
            .ok_or_else(|| GraphError::InvalidRelativePath {
                kind: "path",
                path: path.clone(),
            })?;
    }

    let mut normalized = current
        .canonicalize()
        .map_err(|error| GraphError::TopologyIo(current.to_path_buf(), error.to_string()))?;
    for component in missing.iter().rev() {
        normalized.push(component);
    }
    Ok(normalized)
}

fn title_from_node_id(value: &str) -> String {
    let mut title = String::new();
    let mut next_upper = true;
    for ch in value.replace(['-', '_'], " ").chars() {
        if ch.is_whitespace() {
            next_upper = true;
            title.push(ch);
        } else if next_upper {
            title.extend(ch.to_uppercase());
            next_upper = false;
        } else {
            title.push(ch);
        }
    }
    title
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CampaignGraph {
    pub run_id: RunId,
    pub graph_version: String,
    #[serde(default)]
    pub groups: BTreeMap<String, TopologyGroup>,
    pub nodes: Vec<Node>,
}

impl CampaignGraph {
    pub fn validate(&self) -> Result<(), GraphError> {
        if self.nodes.is_empty() {
            return Err(GraphError::NoRootNodes);
        }

        let mut ids = BTreeSet::new();
        let mut node_by_id = BTreeMap::new();
        for node in &self.nodes {
            if !ids.insert(node.id.clone()) {
                return Err(GraphError::DuplicateNode(node.id.clone()));
            }
            if node.artifact_dir != deterministic_artifact_dir(&node.id) {
                return Err(GraphError::NonDeterministicArtifactDir {
                    node: node.id.clone(),
                    artifact_dir: node.artifact_dir.clone(),
                });
            }
            node_by_id.insert(node.id.clone(), node);
        }

        for node in &self.nodes {
            let mut seen_dependencies = BTreeSet::new();
            for dependency in &node.depends_on {
                if dependency == &node.id {
                    return Err(GraphError::CycleDetected(vec![node.id.clone()]));
                }
                if !seen_dependencies.insert(dependency.clone()) {
                    return Err(GraphError::DuplicateDependency {
                        node: node.id.clone(),
                        dependency: dependency.clone(),
                    });
                }
                if !ids.contains(dependency) {
                    return Err(GraphError::UnknownDependency {
                        node: node.id.clone(),
                        dependency: dependency.clone(),
                    });
                }
            }
        }

        self.validate_node_contracts(&node_by_id)?;
        self.validate_no_cycles(&node_by_id)?;
        let roots = self
            .nodes
            .iter()
            .filter(|node| node.depends_on.is_empty())
            .count();
        if roots == 0 {
            return Err(GraphError::NoRootNodes);
        }
        Ok(())
    }

    pub fn topological_order(&self) -> Result<Vec<NodeId>, GraphError> {
        self.validate()?;
        let mut indegree: BTreeMap<NodeId, usize> = self
            .nodes
            .iter()
            .map(|node| (node.id.clone(), node.depends_on.len()))
            .collect();
        let mut dependents: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
        for node in &self.nodes {
            for dependency in &node.depends_on {
                dependents
                    .entry(dependency.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }

        let mut ready: BTreeSet<NodeId> = indegree
            .iter()
            .filter_map(|(id, degree)| (*degree == 0).then_some(id.clone()))
            .collect();
        let mut order = Vec::with_capacity(self.nodes.len());

        while let Some(id) = ready.pop_first() {
            order.push(id.clone());
            for dependent in dependents.get(&id).into_iter().flatten() {
                let degree = indegree
                    .get_mut(dependent)
                    .expect("validated graph dependents must exist");
                *degree -= 1;
                if *degree == 0 {
                    ready.insert(dependent.clone());
                }
            }
        }

        if order.len() == self.nodes.len() {
            Ok(order)
        } else {
            Err(GraphError::CycleDetected(Vec::new()))
        }
    }

    pub fn to_json_pretty(&self) -> Result<String, GraphError> {
        serde_json::to_string_pretty(self).map_err(|err| GraphError::Serialization(err.to_string()))
    }

    pub fn fingerprint(&self) -> Result<String, GraphError> {
        self.validate()?;
        let mut nodes = self
            .nodes
            .iter()
            .map(|node| {
                let mut depends_on = node
                    .depends_on
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>();
                depends_on.sort();
                FingerprintNode {
                    id: node.id.to_string(),
                    label: node.label.clone(),
                    kind: node.kind.clone(),
                    depends_on,
                    timeout_seconds: node.timeout.map(|timeout| timeout.as_secs()),
                    retry: node.retry.clone(),
                    artifact_dir: node.artifact_dir.to_string_lossy().into_owned(),
                }
            })
            .collect::<Vec<_>>();
        nodes.sort_by(|left, right| left.id.cmp(&right.id));

        let payload = FingerprintGraph {
            graph_version: self.graph_version.clone(),
            groups: self.groups.clone(),
            nodes,
        };
        let bytes = serde_json::to_vec(&payload)
            .map_err(|err| GraphError::Serialization(err.to_string()))?;
        Ok(hex_sha256(&bytes))
    }

    pub fn node(&self, id: &NodeId) -> Option<&Node> {
        self.nodes.iter().find(|node| &node.id == id)
    }

    fn validate_node_contracts(
        &self,
        node_by_id: &BTreeMap<NodeId, &Node>,
    ) -> Result<(), GraphError> {
        let mut attempts = BTreeSet::new();

        for node in &self.nodes {
            match &node.kind {
                NodeKind::Meta { .. } => {}
                NodeKind::AgentAttempt {
                    strategy,
                    attempt_index,
                    ..
                } => {
                    if !attempts.insert((strategy.clone(), *attempt_index)) {
                        return Err(GraphError::DuplicateAttempt {
                            strategy: strategy.clone(),
                            attempt_index: *attempt_index,
                        });
                    }
                    if !dependency_path_contains_kind(node, node_by_id, |kind| {
                        matches!(kind, NodeKind::DiscoverBaseTest)
                    }) {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason: "agent attempts must be reachable from base test discovery"
                                .to_owned(),
                        });
                    }
                    if !dependency_path_contains_kind(node, node_by_id, |kind| {
                        matches!(
                            kind,
                            NodeKind::PropertySpecification | NodeKind::PropertySpecificationFanIn
                        )
                    }) {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason:
                                "agent attempts must be reachable from property specification fan-in"
                                    .to_owned(),
                        });
                    }
                }
                NodeKind::Agentic {
                    required_artifacts,
                    primary_artifact,
                    ..
                } => {
                    if let Some(primary_artifact) = primary_artifact {
                        validate_primary_artifact_path(
                            &node.id,
                            primary_artifact,
                            required_artifacts,
                        )?;
                    }
                }
                NodeKind::Reference {
                    required_artifacts,
                    primary_artifact,
                    ..
                } => {
                    if let Some(primary_artifact) = primary_artifact {
                        validate_primary_artifact_path(
                            &node.id,
                            primary_artifact,
                            required_artifacts,
                        )?;
                        if primary_artifact.as_path()
                            == Path::new(ultrafuzz_references::RUN_REFERENCE_MANIFEST_FILE)
                        {
                            return Err(GraphError::InvalidReferenceNode {
                                node: node.id.clone(),
                                reason: format!(
                                    "reference nodes must not use `{}` as primary_artifact",
                                    ultrafuzz_references::RUN_REFERENCE_MANIFEST_FILE
                                ),
                            });
                        }
                    }
                }
                NodeKind::ConsolidateStrategy { strategy } => {
                    if node.depends_on.is_empty() {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason: "strategy consolidation has no attempt dependencies".to_owned(),
                        });
                    }
                    for dependency in &node.depends_on {
                        match &node_by_id
                            .get(dependency)
                            .expect("dependency existence validated")
                            .kind
                        {
                            NodeKind::AgentAttempt {
                                strategy: dependency_strategy,
                                ..
                            } if dependency_strategy == strategy => {}
                            _ => {
                                return Err(GraphError::InvalidFanIn {
                                    node: node.id.clone(),
                                    reason: format!(
                                        "dependency `{dependency}` is not an attempt for strategy `{strategy}`"
                                    ),
                                });
                            }
                        }
                    }
                }
                NodeKind::DedupeFindings => {
                    if node.depends_on.is_empty()
                        || !node.depends_on.iter().all(|dependency| {
                            matches!(
                                node_by_id
                                    .get(dependency)
                                    .expect("dependency existence validated")
                                    .kind,
                                NodeKind::ConsolidateStrategy { .. }
                            )
                        })
                    {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason: "dedupe must depend on strategy consolidation nodes".to_owned(),
                        });
                    }
                }
                NodeKind::TriageFindings => {
                    if !node.depends_on.iter().any(|dependency| {
                        matches!(
                            node_by_id
                                .get(dependency)
                                .expect("dependency existence validated")
                                .kind,
                            NodeKind::DedupeFindings
                        )
                    }) {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason: "triage must depend on dedupe output".to_owned(),
                        });
                    }
                }
                NodeKind::AggregateTestFiles => {
                    if !node.depends_on.iter().any(|dependency| {
                        aggregate_review_dependency_is_ready(
                            &node_by_id
                                .get(dependency)
                                .expect("dependency existence validated")
                                .kind,
                        )
                    }) {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason:
                                "test aggregation must depend on severity classification or dedupe output"
                                .to_owned(),
                        });
                    }
                }
                NodeKind::PrepareFoundryHarness => {
                    if !node.depends_on.iter().any(|dependency| {
                        matches!(
                            node_by_id
                                .get(dependency)
                                .expect("dependency existence validated")
                                .kind,
                            NodeKind::ProjectDiscovery
                        )
                    }) {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason: "Foundry harness preparation must depend on project discovery"
                                .to_owned(),
                        });
                    }
                }
                NodeKind::DiscoverBaseTest => {
                    if !node.depends_on.iter().any(|dependency| {
                        matches!(
                            node_by_id
                                .get(dependency)
                                .expect("dependency existence validated")
                                .kind,
                            NodeKind::PrepareFoundryHarness
                        )
                    }) {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason:
                                "base test discovery must depend on Foundry harness preparation"
                                    .to_owned(),
                        });
                    }
                }
                NodeKind::PropertySpecification => {
                    if !node.depends_on.iter().any(|dependency| {
                        matches!(
                            node_by_id
                                .get(dependency)
                                .expect("dependency existence validated")
                                .kind,
                            NodeKind::DiscoverBaseTest
                        )
                    }) {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason: "property specification must depend on base test discovery"
                                .to_owned(),
                        });
                    }
                }
                NodeKind::PropertySpecificationLens { .. } => {
                    if !node.depends_on.iter().any(|dependency| {
                        matches!(
                            node_by_id
                                .get(dependency)
                                .expect("dependency existence validated")
                                .kind,
                            NodeKind::DiscoverBaseTest
                        )
                    }) {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason:
                                "property specification lenses must depend on base test discovery"
                                    .to_owned(),
                        });
                    }
                }
                NodeKind::PropertySpecificationFanIn => {
                    let mut lenses = BTreeSet::new();
                    for dependency in &node.depends_on {
                        match &node_by_id
                            .get(dependency)
                            .expect("dependency existence validated")
                            .kind
                        {
                            NodeKind::PropertySpecificationLens { lens } => {
                                lenses.insert(*lens);
                            }
                            _ => {
                                return Err(GraphError::InvalidFanIn {
                                    node: node.id.clone(),
                                    reason: format!(
                                        "dependency `{dependency}` is not a property specification lens"
                                    ),
                                });
                            }
                        }
                    }
                    let expected = PropertyLens::ALL.into_iter().collect::<BTreeSet<_>>();
                    if lenses != expected {
                        return Err(GraphError::InvalidFanIn {
                            node: node.id.clone(),
                            reason:
                                "property specification fan-in must depend on all built-in lenses"
                                    .to_owned(),
                        });
                    }
                }
                NodeKind::ProjectDiscovery => {}
            }
        }

        Ok(())
    }

    fn validate_no_cycles(&self, node_by_id: &BTreeMap<NodeId, &Node>) -> Result<(), GraphError> {
        let mut marks: BTreeMap<NodeId, VisitMark> = BTreeMap::new();
        let mut stack = Vec::new();

        for node in &self.nodes {
            visit_node(&node.id, node_by_id, &mut marks, &mut stack)?;
        }

        Ok(())
    }
}

fn aggregate_review_dependency_is_ready(kind: &NodeKind) -> bool {
    match kind {
        NodeKind::TriageFindings | NodeKind::DedupeFindings => true,
        NodeKind::Agentic { logical_id, .. } => matches!(
            logical_id.as_str(),
            "severity-classification" | "triage" | "dedupe-findings"
        ),
        _ => false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub label: String,
    pub kind: NodeKind,
    pub depends_on: Vec<NodeId>,
    pub timeout: Option<Duration>,
    pub retry: RetryPolicy,
    pub artifact_dir: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum NodeKind {
    Meta {
        role: MetaNodeRole,
    },
    Agentic {
        logical_id: NodeId,
        prompt_path: PathBuf,
        attempt_index: usize,
        loop_count: usize,
        loop_mode: LoopMode,
        #[serde(default)]
        group: Option<String>,
        #[serde(default)]
        required_artifacts: Vec<PathBuf>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        primary_artifact: Option<PathBuf>,
    },
    Reference {
        reference: ReferenceId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revision: Option<ReferenceRevision>,
        #[serde(default)]
        group: Option<String>,
        #[serde(default)]
        required_artifacts: Vec<PathBuf>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        primary_artifact: Option<PathBuf>,
    },
    ProjectDiscovery,
    PrepareFoundryHarness,
    DiscoverBaseTest,
    PropertySpecificationLens {
        lens: PropertyLens,
    },
    PropertySpecificationFanIn,
    PropertySpecification,
    AgentAttempt {
        strategy: StrategyId,
        attempt_index: usize,
        model_id: ModelProfileId,
        model_index: usize,
        loop_index: usize,
        prompt_id: PromptId,
    },
    ConsolidateStrategy {
        strategy: StrategyId,
    },
    DedupeFindings,
    TriageFindings,
    AggregateTestFiles,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReferenceRevision {
    pub provider: ultrafuzz_references::ReferenceProvider,
    pub repo: String,
    pub commit: String,
    pub paths: Vec<PathBuf>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PropertyLens {
    #[serde(rename = "0kn0t")]
    ZeroKnot,
    CertoraThinking,
    Aviggiano,
    JosselinFeist,
}

impl PropertyLens {
    pub const ALL: [Self; 4] = [
        Self::ZeroKnot,
        Self::CertoraThinking,
        Self::Aviggiano,
        Self::JosselinFeist,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::ZeroKnot => "0kn0t",
            Self::CertoraThinking => "certora-thinking",
            Self::Aviggiano => "aviggiano",
            Self::JosselinFeist => "josselin-feist",
        }
    }

    pub fn node_id(self) -> &'static str {
        match self {
            Self::ZeroKnot => "property-specification-0kn0t",
            Self::CertoraThinking => "property-specification-certora",
            Self::Aviggiano => "property-specification-aviggiano",
            Self::JosselinFeist => "property-specification-josselin-feist",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::ZeroKnot => "0kn0t lens",
            Self::CertoraThinking => "Certora Thinking lens",
            Self::Aviggiano => "aviggiano lens",
            Self::JosselinFeist => "Josselin Feist lens",
        }
    }

    pub fn prompt_file_name(self) -> &'static str {
        match self {
            Self::ZeroKnot => "0kn0t-lens.md",
            Self::CertoraThinking => "certora-thinking-lens.md",
            Self::Aviggiano => "aviggiano-lens.md",
            Self::JosselinFeist => "josselin-feist-lens.md",
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct RetryPolicy {
    pub max_retries: usize,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum GraphError {
    #[error("missing topology file: {0}")]
    MissingTopology(PathBuf),
    #[error("failed to access topology path {0}: {1}")]
    TopologyIo(PathBuf, String),
    #[error("failed to parse topology YAML: {0}")]
    TopologyParse(String),
    #[error("failed to discover project prompts for topology scaffolding: {0}")]
    PromptDiscovery(String),
    #[error("failed to resolve config for topology scaffolding: {0}")]
    ConfigResolution(String),
    #[error("failed to serialize topology YAML: {0}")]
    TopologySerialization(String),
    #[error("unsupported topology version: {0}")]
    UnsupportedTopologyVersion(u32),
    #[error("topology nodes must be non-empty")]
    NoTopologyNodes,
    #[error("invalid topology node id `{0}`")]
    InvalidNodeId(String),
    #[error("invalid topology group id `{0}`")]
    InvalidGroupId(String),
    #[error("invalid topology group color for `{group}`: {color}")]
    InvalidGroupColor { group: String, color: String },
    #[error("invalid {kind} path `{path}`; paths must be relative and traversal-free")]
    InvalidRelativePath { kind: &'static str, path: PathBuf },
    #[error("topology path traverses symlink: {0}")]
    SymlinkPath(PathBuf),
    #[error("missing topology prompt file: {0}")]
    MissingPromptFile(PathBuf),
    #[error("node {0} has loops = 0")]
    InvalidLoopCount(NodeId),
    #[error("node {node} has loops = {loops}, above the maximum {max}")]
    TooManyLoops {
        node: NodeId,
        loops: usize,
        max: usize,
    },
    #[error("topology defaults.strategy_loops must be greater than zero")]
    InvalidStrategyLoopDefault,
    #[error("topology defaults.strategy_loops = {loops}, above the maximum {max}")]
    TooManyStrategyLoops { loops: usize, max: usize },
    #[error("topology has {count} logical nodes, above the maximum {max}")]
    TooManyTopologyNodes { count: usize, max: usize },
    #[error("topology expands to {count} nodes, above the maximum {max}")]
    TooManyExpandedNodes { count: usize, max: usize },
    #[error("node {0} has timeout_seconds = 0")]
    InvalidTimeout(NodeId),
    #[error("node {node} has invalid required artifact path `{path}`")]
    InvalidRequiredArtifact { node: NodeId, path: PathBuf },
    #[error("node {node} has invalid primary_artifact path `{path}`")]
    InvalidPrimaryArtifact { node: NodeId, path: PathBuf },
    #[error("node {node} has primary_artifact `{path}` that is not listed in required_artifacts")]
    PrimaryArtifactNotRequired { node: NodeId, path: PathBuf },
    #[error("missing required topology meta-node `{0}`")]
    MissingMetaNode(&'static str),
    #[error("invalid topology node {node}: {reason}")]
    InvalidTopologyNode { node: NodeId, reason: String },
    #[error("invalid topology meta-node {node}: {reason}")]
    InvalidMetaNode { node: NodeId, reason: String },
    #[error("invalid topology reference node {node}: {reason}")]
    InvalidReferenceNode { node: NodeId, reason: String },
    #[error("reference catalog error: {reason}")]
    ReferenceCatalog { reason: String },
    #[error("invalid topology entry/exit contract for node {node}: {reason}")]
    InvalidEntryExit { node: NodeId, reason: String },
    #[error("node {node} has invalid prompt frontmatter: {reason}")]
    InvalidPromptFrontmatter { node: NodeId, reason: String },
    #[error("node {node} has invalid prompt artifact reference: {reason}")]
    InvalidPromptArtifactReference { node: NodeId, reason: String },
    #[error("node {node} references unknown artifact producer `{referenced}`")]
    UnknownPromptArtifactReference { node: NodeId, referenced: NodeId },
    #[error("node {node} references artifact producer `{referenced}`, but it is not an ancestor")]
    NonAncestorPromptArtifactReference { node: NodeId, referenced: NodeId },
    #[error("node {node} references artifact handoff for `{referenced}`, but that node has no primary_artifact")]
    MissingPromptArtifactHandoff { node: NodeId, referenced: NodeId },
    #[error("expanded node id {concrete} for logical node {logical} collides with another node")]
    ConcreteNodeIdCollision { logical: NodeId, concrete: NodeId },
    #[error("duplicate node id: {0}")]
    DuplicateNode(NodeId),
    #[error("node {node} depends on missing node {dependency}")]
    UnknownDependency { node: NodeId, dependency: NodeId },
    #[error("node {node} repeats dependency {dependency}")]
    DuplicateDependency { node: NodeId, dependency: NodeId },
    #[error("graph must have at least one root node")]
    NoRootNodes,
    #[error("duplicate attempt for strategy `{strategy}` index {attempt_index}")]
    DuplicateAttempt {
        strategy: StrategyId,
        attempt_index: usize,
    },
    #[error("invalid fan-in for node {node}: {reason}")]
    InvalidFanIn { node: NodeId, reason: String },
    #[error("cycle detected in graph: {0:?}")]
    CycleDetected(Vec<NodeId>),
    #[error("node {node} has non-deterministic artifact dir {artifact_dir}")]
    NonDeterministicArtifactDir { node: NodeId, artifact_dir: PathBuf },
    #[error("failed to serialize graph: {0}")]
    Serialization(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VisitMark {
    Visiting,
    Done,
}

fn visit_node(
    id: &NodeId,
    node_by_id: &BTreeMap<NodeId, &Node>,
    marks: &mut BTreeMap<NodeId, VisitMark>,
    stack: &mut Vec<NodeId>,
) -> Result<(), GraphError> {
    match marks.get(id) {
        Some(VisitMark::Done) => return Ok(()),
        Some(VisitMark::Visiting) => {
            let cycle_start = stack
                .iter()
                .position(|stack_id| stack_id == id)
                .unwrap_or(0);
            return Err(GraphError::CycleDetected(stack[cycle_start..].to_vec()));
        }
        None => {}
    }

    marks.insert(id.clone(), VisitMark::Visiting);
    stack.push(id.clone());
    let node = node_by_id.get(id).expect("validated graph node must exist");
    for dependency in &node.depends_on {
        visit_node(dependency, node_by_id, marks, stack)?;
    }
    stack.pop();
    marks.insert(id.clone(), VisitMark::Done);
    Ok(())
}

fn dependency_path_contains_kind(
    node: &Node,
    node_by_id: &BTreeMap<NodeId, &Node>,
    matches_kind: impl Fn(&NodeKind) -> bool + Copy,
) -> bool {
    node.depends_on.iter().any(|dependency| {
        dependency_or_ancestor_contains_kind(
            dependency,
            node_by_id,
            matches_kind,
            &mut BTreeSet::new(),
        )
    })
}

fn dependency_or_ancestor_contains_kind(
    id: &NodeId,
    node_by_id: &BTreeMap<NodeId, &Node>,
    matches_kind: impl Fn(&NodeKind) -> bool + Copy,
    visited: &mut BTreeSet<NodeId>,
) -> bool {
    if !visited.insert(id.clone()) {
        return false;
    }

    let dependency = node_by_id
        .get(id)
        .expect("dependency existence is validated before fan-in checks");
    matches_kind(&dependency.kind)
        || dependency.depends_on.iter().any(|ancestor| {
            dependency_or_ancestor_contains_kind(ancestor, node_by_id, matches_kind, visited)
        })
}

pub fn deterministic_artifact_dir(node_id: &NodeId) -> PathBuf {
    Path::new("artifacts").join(node_id.as_str())
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

#[derive(Serialize)]
struct FingerprintGraph {
    graph_version: String,
    groups: BTreeMap<String, TopologyGroup>,
    nodes: Vec<FingerprintNode>,
}

#[derive(Serialize)]
struct FingerprintNode {
    id: String,
    label: String,
    kind: NodeKind,
    depends_on: Vec<String>,
    timeout_seconds: Option<u64>,
    retry: RetryPolicy,
    artifact_dir: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ultrafuzz_config::{resolve_config_from_toml, CliOverrides, EnvOverrides};

    #[test]
    fn ensure_path_inside_rejects_parent_traversal_after_normalization() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("prompts");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("prompt.md"), "# outside\n").unwrap();

        let error = ensure_path_inside(&root, &root.join("../outside/prompt.md")).unwrap_err();

        assert!(matches!(error, GraphError::InvalidRelativePath { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_path_inside_rejects_symlink_adjacent_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("prompts");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked-outside")).unwrap();

        let error = ensure_path_inside(&root, &root.join("linked-outside/new.md")).unwrap_err();

        assert!(matches!(error, GraphError::InvalidRelativePath { .. }));
    }

    fn test_config(toml: &str) -> CampaignConfig {
        resolve_config_from_toml(
            Some(toml),
            Vec::new(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap()
    }

    fn topology_node(id: &str, depends_on: &[&str]) -> TopologyNode {
        TopologyNode {
            id: NodeId::from(id),
            kind: TopologyNodeKind::Agentic,
            role: None,
            prompt: None,
            reference: None,
            group: None,
            depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
            loops: 1,
            loop_mode: LoopMode::Parallel,
            timeout_seconds: None,
            required_artifacts: Vec::new(),
            primary_artifact: None,
        }
    }

    fn meta_node(role: MetaNodeRole, depends_on: &[&str]) -> TopologyNode {
        TopologyNode {
            id: NodeId::from(role.canonical_id()),
            kind: TopologyNodeKind::Meta,
            role: Some(role),
            prompt: None,
            reference: None,
            group: None,
            depends_on: depends_on.iter().map(|id| NodeId::from(*id)).collect(),
            loops: 1,
            loop_mode: LoopMode::Parallel,
            timeout_seconds: None,
            required_artifacts: Vec::new(),
            primary_artifact: None,
        }
    }

    fn topology_with_start_finish(mut nodes: Vec<TopologyNode>) -> Vec<TopologyNode> {
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
                node.depends_on.push(NodeId::from(START_NODE_ID));
            }
        }
        let mut wrapped = vec![meta_node(MetaNodeRole::Start, &[])];
        wrapped.extend(nodes);
        wrapped.push(meta_node(
            MetaNodeRole::Finish,
            &terminals.iter().map(String::as_str).collect::<Vec<_>>(),
        ));
        wrapped
    }

    trait TopologyNodeTestExt {
        fn with_prompt(self, prompt: &str) -> Self;
        fn with_required_artifacts(self, required_artifacts: &[&str]) -> Self;
        fn with_primary_artifact(self, primary_artifact: &str) -> Self;
    }

    impl TopologyNodeTestExt for TopologyNode {
        fn with_prompt(mut self, prompt: &str) -> Self {
            self.prompt = Some(PathBuf::from(prompt));
            self
        }

        fn with_required_artifacts(mut self, required_artifacts: &[&str]) -> Self {
            self.required_artifacts = required_artifacts
                .iter()
                .map(|path| PathBuf::from(*path))
                .collect();
            self
        }

        fn with_primary_artifact(mut self, primary_artifact: &str) -> Self {
            self.primary_artifact = Some(PathBuf::from(primary_artifact));
            self
        }
    }

    fn validate_without_prompt_files(topology: &ProjectTopology) -> Result<(), GraphError> {
        validate_project_topology(
            Path::new("."),
            topology,
            TopologyValidationOptions {
                require_prompt_files: false,
            },
        )
    }

    fn validate_with_prompt_files(
        project_root: &Path,
        topology: &ProjectTopology,
    ) -> Result<(), GraphError> {
        validate_project_topology(
            project_root,
            topology,
            TopologyValidationOptions {
                require_prompt_files: true,
            },
        )
    }

    fn write_prompt(project_root: &Path, relative_path: &str, markdown: &str) {
        let path = project_root.join(PROJECT_PROMPT_DIR).join(relative_path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, markdown).unwrap();
    }

    fn test_topology_graph(run_id: &str, nodes: Vec<TopologyNode>) -> CampaignGraph {
        build_campaign_graph_from_topology(
            RunId::from(run_id),
            Path::new("."),
            &test_config(""),
            ProjectTopology {
                version: TOPOLOGY_VERSION,
                defaults: TopologyDefaults::default(),
                groups: BTreeMap::new(),
                nodes: topology_with_start_finish(nodes),
            },
        )
        .unwrap()
    }

    #[test]
    fn expanded_agentic_nodes_do_not_retry_by_default() {
        let graph = test_topology_graph("run-retry", vec![topology_node("strategy", &[])]);

        assert_eq!(
            graph
                .node(&NodeId::from(START_NODE_ID))
                .unwrap()
                .retry
                .max_retries,
            0
        );
        assert_eq!(
            graph
                .node(&NodeId::from("strategy"))
                .unwrap()
                .retry
                .max_retries,
            0
        );
        assert_eq!(
            graph
                .node(&NodeId::from(FINISH_NODE_ID))
                .unwrap()
                .retry
                .max_retries,
            0
        );
    }

    #[test]
    fn default_project_topology_is_graph_loadable() {
        let topology = default_project_topology();
        validate_without_prompt_files(&topology).unwrap();
        assert_eq!(topology.defaults.strategy_loops, DEFAULT_STRATEGY_LOOPS);
        let reference_count = topology
            .nodes
            .iter()
            .filter(|node| node.kind == TopologyNodeKind::Reference)
            .count();
        assert_eq!(topology.nodes.len(), 52 + reference_count);
        assert_eq!(reference_count, 9);
        let topology_timeout = |id: &str| {
            topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from(id))
                .unwrap_or_else(|| panic!("expected default topology node `{id}`"))
                .timeout_seconds
        };
        assert_eq!(topology_timeout("boundary-tests"), None);
        assert_eq!(topology_timeout("time-warp-sequences"), None);
        assert_eq!(topology_timeout("dynamic-strategy-generator"), Some(14_400));
        assert_eq!(
            topology_timeout("triage"),
            Some(LONG_RUNNING_NODE_TIMEOUT_SECONDS)
        );
        assert_eq!(
            topology_timeout("severity-classification"),
            Some(LONG_RUNNING_NODE_TIMEOUT_SECONDS)
        );
        assert_eq!(
            topology_timeout("aggregate-test-files"),
            Some(LONG_RUNNING_NODE_TIMEOUT_SECONDS)
        );
        assert_eq!(
            topology_timeout("final-report"),
            Some(LONG_RUNNING_NODE_TIMEOUT_SECONDS)
        );
        assert!(!topology.groups.contains_key("differential-tests"));
        assert_eq!(
            topology
                .groups
                .get("strategies")
                .and_then(|group| group.label.as_deref()),
            Some("Strategies")
        );
        assert_eq!(
            topology
                .groups
                .get("references")
                .and_then(|group| group.label.as_deref()),
            Some("References")
        );
        let rounding_reference = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("reference-properties-montyly-rounding"))
            .expect("default topology should include the Montyly rounding reference");
        assert_eq!(rounding_reference.kind, TopologyNodeKind::Reference);
        assert_eq!(
            rounding_reference.reference,
            Some(ReferenceId::from("properties.montyly-rounding"))
        );
        assert_eq!(rounding_reference.group.as_deref(), Some("references"));
        assert_eq!(
            required_artifacts_for(&topology, "reference-properties-montyly-rounding"),
            vec![
                PathBuf::from("references/rounding.md"),
                PathBuf::from("references/manifest.json")
            ]
        );
        assert_eq!(
            primary_artifact_for(&topology, "reference-properties-montyly-rounding"),
            Some(PathBuf::from("references/rounding.md"))
        );
        assert_eq!(topology.nodes[0], meta_node(MetaNodeRole::Start, &[]));
        assert_eq!(
            topology.nodes.last().unwrap(),
            &meta_node(MetaNodeRole::Finish, &["final-report"])
        );
        let invariant_nodes = topology
            .nodes
            .iter()
            .filter(|node| {
                node.prompt
                    .as_ref()
                    .is_some_and(|prompt| prompt.starts_with("strategies/invariants"))
            })
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            invariant_nodes,
            vec![
                "stateful-invariant-setup",
                "stateful-invariant-handlers",
                "stateful-invariant-coverage",
                STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID,
                STATEFUL_INVARIANT_RECON_CAMPAIGN_ID
            ]
        );
        assert_eq!(
            topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from("project-discovery"))
                .unwrap()
                .depends_on,
            vec![NodeId::from(START_NODE_ID)]
        );
        assert_eq!(
            required_artifacts_for(&topology, "project-discovery"),
            vec![PathBuf::from("setup/project-discovery.md")]
        );
        assert_eq!(
            primary_artifact_for(&topology, "project-discovery"),
            Some(PathBuf::from("setup/project-discovery.md"))
        );
        assert_eq!(
            required_artifacts_for(&topology, "actors-flows"),
            vec![PathBuf::from("setup/actors-flows.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "setup-foundry"),
            vec![PathBuf::from("setup/setup-foundry.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "base-test-setup"),
            vec![PathBuf::from("setup/base-test-setup.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "property-specification-0kn0t"),
            vec![PathBuf::from("properties/0kn0t.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "property-specification-certora"),
            vec![PathBuf::from("properties/certora.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "property-specification-aviggiano"),
            vec![PathBuf::from("properties/aviggiano.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "property-specification-josselin-feist"),
            vec![PathBuf::from("properties/josselin-feist.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "property-specification-crytic"),
            vec![PathBuf::from("properties/crytic.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "property-specification-runtime-verification"),
            vec![PathBuf::from("properties/runtime-verification.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "property-specification-a16z"),
            vec![PathBuf::from("properties/a16z.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "property-specification-recon"),
            vec![PathBuf::from("properties/recon.md")]
        );
        let property_lane_order = topology
            .nodes
            .iter()
            .filter(|node| node.group.as_deref() == Some("properties"))
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            property_lane_order,
            vec![
                "property-specification-certora",
                "property-specification-crytic",
                "property-specification-runtime-verification",
                "property-specification-a16z",
                "property-specification-recon",
                "property-specification-aviggiano",
                "property-specification-0kn0t",
                "property-specification-josselin-feist",
                "property-specification-fanin"
            ]
        );
        assert_eq!(loop_count_for(&topology, "encode-decode"), 1);
        assert_eq!(loop_count_for(&topology, "admin-config-boundaries"), 1);
        assert_eq!(
            loop_count_for(&topology, "external-dependency-boundaries"),
            1
        );
        assert_eq!(
            loop_count_for(&topology, "externalized-state-accounting"),
            1
        );
        assert_eq!(loop_count_for(&topology, "stateful-invariant-coverage"), 3);
        assert_eq!(loop_count_for(&topology, "differential-lane-author"), 3);
        assert_eq!(loop_count_for(&topology, "differential-red-triage"), 2);
        assert_eq!(loop_count_for(&topology, "dynamic-strategy-generator"), 1);
        assert_eq!(
            required_artifacts_for(&topology, "property-specification-fanin"),
            vec![PathBuf::from("properties.md")]
        );
        let fanin = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("property-specification-fanin"))
            .expect("default property fan-in node exists");
        assert!(fanin
            .depends_on
            .contains(&NodeId::from("property-specification-josselin-feist")));
        assert!(fanin
            .depends_on
            .contains(&NodeId::from("property-specification-recon")));
        let boundary = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("boundary-tests"))
            .expect("default boundary-tests node exists");
        assert_eq!(
            boundary.depends_on,
            vec![NodeId::from("property-specification-fanin")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "boundary-tests"),
            vec![
                PathBuf::from("boundary-recipes.md"),
                PathBuf::from("boundary-recipes.json")
            ]
        );
        assert_eq!(
            primary_artifact_for(&topology, "boundary-tests"),
            Some(PathBuf::from("boundary-recipes.md"))
        );
        assert_eq!(
            required_artifacts_for(&topology, "external-dependency-boundaries"),
            vec![
                PathBuf::from("dependency-scope-matrix.md"),
                PathBuf::from("dependency-scope-matrix.json")
            ]
        );
        assert_eq!(
            primary_artifact_for(&topology, "external-dependency-boundaries"),
            Some(PathBuf::from("dependency-scope-matrix.md"))
        );
        for strategy in [
            "encode-decode",
            "differential-library-tests",
            "round-trip",
            "workflow-property-based-tests",
            "time-warp-sequences",
            "expand-coverage",
            "admin-config-boundaries",
            "external-dependency-boundaries",
            "amm-boundary-liquidity",
            "payable-fallback-accounting",
            "externalized-state-accounting",
            "packed-action-parity",
            "batch-atomicity-unsupported-actions",
            "router-exact-accounting",
            "rounding-direction-audit",
            "market-exhaustion-boundaries",
            "order-replacement-collateral",
            "state-machine-boundaries",
            "lifecycle-view-boundaries",
            "stateful-invariant-setup",
            "differential-oracle-planner",
        ] {
            assert_eq!(
                topology
                    .nodes
                    .iter()
                    .find(|node| node.id == NodeId::from(strategy))
                    .unwrap_or_else(|| panic!("default topology node `{strategy}` exists"))
                    .depends_on,
                vec![
                    NodeId::from("base-test-setup"),
                    NodeId::from("property-specification-fanin")
                ],
                "default topology node `{strategy}` should receive base workspace changes and run in parallel with boundary-tests"
            );
        }
        assert_eq!(
            topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from("reference-harness-author"))
                .expect("default topology node `reference-harness-author` exists")
                .depends_on,
            vec![
                NodeId::from("base-test-setup"),
                NodeId::from("differential-oracle-planner")
            ],
            "default topology node `reference-harness-author` should receive base workspace changes directly"
        );
        assert_eq!(
            topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from("reference-and-lane-auditor"))
                .expect("default topology node `reference-and-lane-auditor` exists")
                .depends_on,
            vec![
                NodeId::from("base-test-setup"),
                NodeId::from("reference-harness-author")
            ],
            "default topology node `reference-and-lane-auditor` should receive base workspace changes directly"
        );
        assert_eq!(
            topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from("differential-lane-author"))
                .expect("default topology node `differential-lane-author` exists")
                .depends_on,
            vec![
                NodeId::from("base-test-setup"),
                NodeId::from("reference-and-lane-auditor")
            ],
            "default topology node `differential-lane-author` should receive base workspace changes directly"
        );
        assert_eq!(
            topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from("differential-repair-and-report-review"))
                .expect("default topology node `differential-repair-and-report-review` exists")
                .depends_on,
            vec![
                NodeId::from("base-test-setup"),
                NodeId::from("differential-lane-author"),
                NodeId::from("differential-red-triage")
            ],
            "default topology node `differential-repair-and-report-review` should receive base and lane workspace changes before reviewing triage artifacts"
        );
        for (node_id, prompt) in [
            (
                "differential-oracle-planner",
                "strategies/differential/differential-oracle-planner.md",
            ),
            (
                "reference-harness-author",
                "strategies/differential/reference-harness-author.md",
            ),
            (
                "reference-and-lane-auditor",
                "strategies/differential/reference-and-lane-auditor.md",
            ),
            (
                "differential-lane-author",
                "strategies/differential/differential-lane-author.md",
            ),
            (
                "differential-red-triage",
                "strategies/differential/differential-red-triage.md",
            ),
            (
                "differential-repair-and-report-review",
                "strategies/differential/differential-repair-and-report-review.md",
            ),
        ] {
            let node = topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from(node_id))
                .unwrap_or_else(|| panic!("default topology node `{node_id}` exists"));
            assert_eq!(node.group.as_deref(), Some("strategies"));
            assert_eq!(node.prompt.as_deref(), Some(Path::new(prompt)));
        }
        assert_eq!(
            required_artifacts_for(&topology, "admin-config-boundaries"),
            vec![
                PathBuf::from("admin-config-boundary-matrix.md"),
                PathBuf::from("admin-config-boundary-matrix.json")
            ]
        );
        assert_eq!(
            primary_artifact_for(&topology, "admin-config-boundaries"),
            Some(PathBuf::from("admin-config-boundary-matrix.md"))
        );
        assert_eq!(
            required_artifacts_for(&topology, "stateful-invariant-setup"),
            vec![PathBuf::from("setup-inventory.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "stateful-invariant-handlers"),
            vec![PathBuf::from("handler-coverage-inventory.md")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "stateful-invariant-coverage"),
            vec![
                PathBuf::from("coverage-goal.json"),
                PathBuf::from("coverage-report.md"),
                PathBuf::from("findings.json"),
                PathBuf::from("harness-repairs.json")
            ]
        );
        assert_eq!(
            required_artifacts_for(&topology, STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID),
            vec![
                PathBuf::from("implemented-properties.md"),
                PathBuf::from("implemented-properties.json"),
                PathBuf::from("generated-tests.json"),
                PathBuf::from("findings.json")
            ]
        );
        assert_eq!(
            required_artifacts_for(&topology, STATEFUL_INVARIANT_RECON_CAMPAIGN_ID),
            vec![
                PathBuf::from("campaign-plan.json"),
                PathBuf::from("campaign-report.md"),
                PathBuf::from("recon-fuzzer-results.json"),
                PathBuf::from("generated-tests.json"),
                PathBuf::from("findings.json")
            ]
        );
        assert_eq!(
            topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from(STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID))
                .unwrap()
                .depends_on,
            vec![NodeId::from("stateful-invariant-coverage")]
        );
        assert_eq!(
            topology
                .nodes
                .iter()
                .find(|node| node.id == NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID))
                .unwrap()
                .depends_on,
            vec![NodeId::from(STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID)]
        );
        assert_eq!(
            required_artifacts_for(&topology, "differential-oracle-planner"),
            vec![PathBuf::from("differential-plan.json")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "reference-harness-author"),
            vec![PathBuf::from("reference-harness.json")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "reference-and-lane-auditor"),
            vec![PathBuf::from("audited-differential-lanes.json")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "differential-lane-author"),
            vec![PathBuf::from("lane-result.json")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "differential-red-triage"),
            vec![
                PathBuf::from("semantic-red-registry.json"),
                PathBuf::from("triage-a.json"),
                PathBuf::from("triage-b.json")
            ]
        );
        assert_eq!(
            required_artifacts_for(&topology, "differential-repair-and-report-review"),
            vec![
                PathBuf::from("repair-summary.json"),
                PathBuf::from("gap-review.json"),
                PathBuf::from("differential-report-review.json")
            ]
        );
        let dynamic = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("dynamic-strategy-generator"))
            .expect("default topology includes dynamic strategy generator");
        assert_eq!(dynamic.group.as_deref(), Some("strategies"));
        assert_eq!(
            dynamic.prompt.as_deref(),
            Some(Path::new("strategies/dynamic-strategy-generator.md"))
        );
        assert!(dynamic
            .depends_on
            .contains(&NodeId::from("differential-repair-and-report-review")));
        assert!(dynamic
            .depends_on
            .contains(&NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID)));
        assert!(dynamic.depends_on.contains(&NodeId::from("boundary-tests")));
        assert!(dynamic
            .depends_on
            .contains(&NodeId::from("externalized-state-accounting")));
        assert_eq!(
            required_artifacts_for(&topology, "dynamic-strategy-generator"),
            vec![
                PathBuf::from("strategy-plan.json"),
                PathBuf::from("enumerator-outputs.json"),
                PathBuf::from("aggregate-recommendations.json"),
                PathBuf::from("selected-strategies.json"),
                PathBuf::from("generated-tests.json"),
                PathBuf::from("findings.json"),
                PathBuf::from("provenance.json")
            ]
        );
        assert_eq!(
            primary_artifact_for(&topology, "dynamic-strategy-generator"),
            Some(PathBuf::from("strategy-plan.json"))
        );
        let dedupe = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("dedupe-findings"))
            .expect("default topology includes dedupe");
        assert!(dedupe
            .depends_on
            .contains(&NodeId::from("dynamic-strategy-generator")));
        assert_eq!(
            required_artifacts_for(&topology, "dedupe-findings"),
            vec![
                PathBuf::from("deduped-findings.json"),
                PathBuf::from("strategy-detections.json"),
                PathBuf::from("finding-lifecycle-ledger.json")
            ]
        );
        let triage_node = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("triage"))
            .expect("default topology includes triage");
        assert_eq!(triage_node.group.as_deref(), Some("review"));
        assert_eq!(
            triage_node.prompt.as_deref(),
            Some(Path::new("review/triage.md"))
        );
        assert_eq!(
            triage_node.depends_on,
            vec![NodeId::from("dedupe-findings")]
        );
        assert_eq!(
            required_artifacts_for(&topology, "triage"),
            vec![
                PathBuf::from("triaged-findings.json"),
                PathBuf::from("finding-lifecycle-ledger.json")
            ]
        );
        let severity_node = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("severity-classification"))
            .expect("default topology includes severity classification");
        assert_eq!(severity_node.group.as_deref(), Some("review"));
        assert_eq!(
            severity_node.prompt.as_deref(),
            Some(Path::new("review/severity-classification.md"))
        );
        assert_eq!(severity_node.depends_on, vec![NodeId::from("triage")]);
        assert_eq!(
            required_artifacts_for(&topology, "severity-classification"),
            vec![
                PathBuf::from("severity-classified-findings.json"),
                PathBuf::from("strategy-detections.json"),
                PathBuf::from("finding-lifecycle-ledger.json")
            ]
        );
        assert_eq!(
            required_artifacts_for(&topology, "aggregate-test-files"),
            vec![PathBuf::from("aggregation.json")]
        );
        let aggregate_node = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("aggregate-test-files"))
            .expect("default topology includes aggregate-test-files");
        assert_eq!(aggregate_node.kind, TopologyNodeKind::Agentic);
        assert_eq!(aggregate_node.group.as_deref(), Some("review"));
        assert_eq!(
            aggregate_node.prompt.as_deref(),
            Some(Path::new("review/aggregate-test-files.md"))
        );
        assert_eq!(
            aggregate_node.primary_artifact.as_deref(),
            Some(Path::new("aggregation.json"))
        );
        assert_eq!(
            required_artifacts_for(&topology, "final-report"),
            vec![PathBuf::from("report.md"), PathBuf::from("report.json")]
        );

        let expected_graph_nodes = topology
            .nodes
            .iter()
            .map(|node| {
                if node.kind == TopologyNodeKind::Agentic && normal_strategy_topology_node(node) {
                    DEFAULT_STRATEGY_LOOPS
                } else {
                    node.loops
                }
            })
            .sum::<usize>();
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_references::write_default_reference_catalog(temp.path(), false).unwrap();
        let graph = build_campaign_graph_from_topology(
            RunId::from("run-default"),
            temp.path(),
            &test_config(""),
            topology,
        )
        .unwrap();

        assert_eq!(graph.nodes.len(), expected_graph_nodes);
        assert!(matches!(
            graph.node(&NodeId::from(START_NODE_ID)).unwrap().kind,
            NodeKind::Meta {
                role: MetaNodeRole::Start
            }
        ));
        assert!(matches!(
            graph.node(&NodeId::from(FINISH_NODE_ID)).unwrap().kind,
            NodeKind::Meta {
                role: MetaNodeRole::Finish
            }
        ));
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
        assert_eq!(
            graph
                .node(&NodeId::from("project-discovery"))
                .unwrap()
                .depends_on,
            vec![NodeId::from(START_NODE_ID)]
        );
        assert!(graph.node(&NodeId::from("project-discovery")).is_some());
        assert!(graph.node(&NodeId::from("encode-decode-0")).is_some());
        assert!(graph.node(&NodeId::from("encode-decode-1")).is_some());
        assert!(graph.node(&NodeId::from("encode-decode-2")).is_some());
        assert!(graph.node(&NodeId::from("encode-decode-3")).is_none());
        assert!(graph.node(&NodeId::from("expand-coverage-0")).is_some());
        assert!(graph.node(&NodeId::from("expand-coverage-1")).is_some());
        assert!(graph.node(&NodeId::from("expand-coverage-2")).is_some());
        assert!(graph
            .node(&NodeId::from("admin-config-boundaries-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("admin-config-boundaries-1"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("admin-config-boundaries-2"))
            .is_some());
        assert!(graph.node(&NodeId::from("time-warp-sequences-0")).is_some());
        assert!(graph.node(&NodeId::from("time-warp-sequences-1")).is_some());
        assert!(graph.node(&NodeId::from("time-warp-sequences-2")).is_some());
        assert!(graph.node(&NodeId::from("boundary-tests-0")).is_some());
        assert!(graph.node(&NodeId::from("boundary-tests-1")).is_some());
        assert!(graph.node(&NodeId::from("boundary-tests-2")).is_some());
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
        assert_eq!(
            graph
                .node(&NodeId::from("encode-decode-0"))
                .unwrap()
                .depends_on,
            vec![
                NodeId::from("base-test-setup"),
                NodeId::from("property-specification-fanin")
            ]
        );
        assert!(graph
            .node(&NodeId::from("differential-library-tests-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-library-tests-2"))
            .is_some());
        assert_eq!(
            graph
                .node(&NodeId::from("differential-library-tests-0"))
                .unwrap()
                .depends_on,
            vec![
                NodeId::from("base-test-setup"),
                NodeId::from("property-specification-fanin")
            ]
        );
        assert!(graph
            .node(&NodeId::from("differential-oracle-planner"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("reference-harness-author"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("reference-and-lane-auditor"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-lane-author-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-lane-author-1"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-lane-author-2"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-red-triage-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-red-triage-1"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-repair-and-report-review"))
            .is_some());
        assert_eq!(
            graph
                .node(&NodeId::from("differential-repair-and-report-review"))
                .unwrap()
                .depends_on,
            vec![
                NodeId::from("base-test-setup"),
                NodeId::from("differential-lane-author-0"),
                NodeId::from("differential-lane-author-1"),
                NodeId::from("differential-lane-author-2"),
                NodeId::from("differential-red-triage-0"),
                NodeId::from("differential-red-triage-1"),
            ]
        );
        assert_eq!(
            graph
                .node(&NodeId::from("dedupe-findings"))
                .unwrap()
                .depends_on,
            vec![
                NodeId::from("encode-decode-0"),
                NodeId::from("encode-decode-1"),
                NodeId::from("encode-decode-2"),
                NodeId::from("differential-library-tests-0"),
                NodeId::from("differential-library-tests-1"),
                NodeId::from("differential-library-tests-2"),
                NodeId::from("round-trip-0"),
                NodeId::from("round-trip-1"),
                NodeId::from("round-trip-2"),
                NodeId::from("workflow-property-based-tests-0"),
                NodeId::from("workflow-property-based-tests-1"),
                NodeId::from("workflow-property-based-tests-2"),
                NodeId::from("time-warp-sequences-0"),
                NodeId::from("time-warp-sequences-1"),
                NodeId::from("time-warp-sequences-2"),
                NodeId::from("amm-boundary-liquidity-0"),
                NodeId::from("amm-boundary-liquidity-1"),
                NodeId::from("amm-boundary-liquidity-2"),
                NodeId::from("payable-fallback-accounting-0"),
                NodeId::from("payable-fallback-accounting-1"),
                NodeId::from("payable-fallback-accounting-2"),
                NodeId::from("externalized-state-accounting-0"),
                NodeId::from("externalized-state-accounting-1"),
                NodeId::from("externalized-state-accounting-2"),
                NodeId::from("packed-action-parity-0"),
                NodeId::from("packed-action-parity-1"),
                NodeId::from("packed-action-parity-2"),
                NodeId::from("batch-atomicity-unsupported-actions-0"),
                NodeId::from("batch-atomicity-unsupported-actions-1"),
                NodeId::from("batch-atomicity-unsupported-actions-2"),
                NodeId::from("router-exact-accounting-0"),
                NodeId::from("router-exact-accounting-1"),
                NodeId::from("router-exact-accounting-2"),
                NodeId::from("rounding-direction-audit-0"),
                NodeId::from("rounding-direction-audit-1"),
                NodeId::from("rounding-direction-audit-2"),
                NodeId::from("admin-config-boundaries-0"),
                NodeId::from("admin-config-boundaries-1"),
                NodeId::from("admin-config-boundaries-2"),
                NodeId::from("external-dependency-boundaries-0"),
                NodeId::from("external-dependency-boundaries-1"),
                NodeId::from("external-dependency-boundaries-2"),
                NodeId::from("market-exhaustion-boundaries-0"),
                NodeId::from("market-exhaustion-boundaries-1"),
                NodeId::from("market-exhaustion-boundaries-2"),
                NodeId::from("order-replacement-collateral-0"),
                NodeId::from("order-replacement-collateral-1"),
                NodeId::from("order-replacement-collateral-2"),
                NodeId::from("state-machine-boundaries-0"),
                NodeId::from("state-machine-boundaries-1"),
                NodeId::from("state-machine-boundaries-2"),
                NodeId::from("lifecycle-view-boundaries-0"),
                NodeId::from("lifecycle-view-boundaries-1"),
                NodeId::from("lifecycle-view-boundaries-2"),
                NodeId::from("stateful-invariant-coverage-0"),
                NodeId::from("stateful-invariant-coverage-1"),
                NodeId::from("stateful-invariant-coverage-2"),
                NodeId::from(STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID),
                NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID),
                NodeId::from("expand-coverage-0"),
                NodeId::from("expand-coverage-1"),
                NodeId::from("expand-coverage-2"),
                NodeId::from("boundary-tests-0"),
                NodeId::from("boundary-tests-1"),
                NodeId::from("boundary-tests-2"),
                NodeId::from("differential-repair-and-report-review"),
                NodeId::from("dynamic-strategy-generator"),
            ]
        );
        let dynamic = graph
            .node(&NodeId::from("dynamic-strategy-generator"))
            .expect("dynamic strategy generator should be in the graph");
        assert!(dynamic
            .depends_on
            .contains(&NodeId::from("differential-repair-and-report-review")));
        assert!(dynamic
            .depends_on
            .contains(&NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID)));
        assert!(dynamic
            .depends_on
            .contains(&NodeId::from("boundary-tests-0")));
        assert!(graph
            .node(&NodeId::from("dynamic-strategy-generator-0"))
            .is_none());
        assert_eq!(dynamic.timeout, Some(Duration::from_secs(14_400)));
        assert_eq!(
            graph.node(&NodeId::from("triage")).unwrap().depends_on,
            vec![NodeId::from("dedupe-findings")]
        );
        assert_eq!(
            graph
                .node(&NodeId::from("severity-classification"))
                .unwrap()
                .depends_on,
            vec![NodeId::from("triage")]
        );
        assert_eq!(
            graph
                .node(&NodeId::from("aggregate-test-files"))
                .unwrap()
                .depends_on,
            vec![NodeId::from("severity-classification")]
        );
        assert!(matches!(
            graph
                .node(&NodeId::from("aggregate-test-files"))
                .unwrap()
                .kind,
            NodeKind::Agentic { .. }
        ));
        assert_eq!(
            graph
                .node(&NodeId::from("boundary-tests-0"))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(1800))
        );
        for id in [
            "triage",
            "severity-classification",
            "aggregate-test-files",
            "final-report",
        ] {
            assert_eq!(
                graph.node(&NodeId::from(id)).unwrap().timeout,
                Some(Duration::from_secs(LONG_RUNNING_NODE_TIMEOUT_SECONDS)),
                "{id} should have a long-running topology timeout"
            );
        }
        assert!(graph
            .node(&NodeId::from("stateful-invariant-coverage-2"))
            .is_some());
        assert_eq!(
            graph
                .node(&NodeId::from(STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID))
                .unwrap()
                .depends_on,
            vec![
                NodeId::from("stateful-invariant-coverage-0"),
                NodeId::from("stateful-invariant-coverage-1"),
                NodeId::from("stateful-invariant-coverage-2")
            ]
        );
        assert_eq!(
            graph
                .node(&NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID))
                .unwrap()
                .depends_on,
            vec![NodeId::from(STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID)]
        );
        assert_eq!(
            graph
                .node(&NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(LONG_RUNNING_NODE_TIMEOUT_SECONDS))
        );
        let order = graph.topological_order().unwrap();
        assert_eq!(order.first(), Some(&NodeId::from(START_NODE_ID)));
        assert_eq!(order.last(), Some(&NodeId::from(FINISH_NODE_ID)));
    }

    #[test]
    fn stateful_invariant_coverage_requires_failure_preservation_artifacts() {
        let topology = default_project_topology();
        let required = required_artifacts_for(&topology, "stateful-invariant-coverage");

        assert!(
            required.contains(&PathBuf::from("findings.json")),
            "stateful invariant coverage must fail if failure findings are omitted"
        );
        assert!(
            required.contains(&PathBuf::from("harness-repairs.json")),
            "stateful invariant coverage must require explicit harness repair records"
        );
    }

    #[test]
    fn topology_strategy_loop_default_drives_project_graph_loops() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_prompts::scaffold_project_prompts(temp.path(), false).unwrap();
        ultrafuzz_references::write_default_reference_catalog(temp.path(), false).unwrap();
        write_default_project_topology(temp.path(), false).unwrap();
        let topology = load_project_topology(temp.path()).unwrap();
        assert_eq!(topology.defaults.strategy_loops, 3);
        let registry = ultrafuzz_prompts::PromptRegistry::load_for_project(temp.path()).unwrap();
        let config = resolve_config_from_toml(
            Some(""),
            registry.strategy_definitions(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();

        let graph =
            build_campaign_graph_from_project(RunId::from("run-prompts"), temp.path(), &config)
                .unwrap();

        assert!(graph.node(&NodeId::from("boundary-tests-0")).is_some());
        assert!(graph.node(&NodeId::from("boundary-tests-1")).is_some());
        assert!(graph.node(&NodeId::from("boundary-tests-2")).is_some());
        assert!(graph.node(&NodeId::from("encode-decode-0")).is_some());
        assert!(graph.node(&NodeId::from("encode-decode-1")).is_some());
        assert!(graph.node(&NodeId::from("encode-decode-2")).is_some());
        assert_eq!(
            graph
                .node(&NodeId::from("encode-decode-1"))
                .and_then(|node| node.timeout),
            Some(Duration::from_secs(3_600))
        );
        assert!(graph
            .node(&NodeId::from("differential-library-tests-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-library-tests-1"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-library-tests-2"))
            .is_some());
        assert_eq!(
            graph
                .node(&NodeId::from("differential-library-tests-0"))
                .and_then(|node| node.timeout),
            Some(Duration::from_secs(1_800))
        );
        assert!(graph.node(&NodeId::from("round-trip-0")).is_some());
        assert!(graph.node(&NodeId::from("round-trip-1")).is_some());
        assert!(graph.node(&NodeId::from("round-trip-2")).is_some());
        assert_eq!(
            graph
                .node(&NodeId::from("round-trip-2"))
                .and_then(|node| node.timeout),
            Some(Duration::from_secs(3_600))
        );
        assert!(graph
            .node(&NodeId::from("workflow-property-based-tests-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("workflow-property-based-tests-1"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("workflow-property-based-tests-2"))
            .is_some());
        assert_eq!(
            graph
                .node(&NodeId::from("workflow-property-based-tests-0"))
                .and_then(|node| node.timeout),
            Some(Duration::from_secs(3_600))
        );
        assert!(graph.node(&NodeId::from("time-warp-sequences-0")).is_some());
        assert!(graph.node(&NodeId::from("time-warp-sequences-1")).is_some());
        assert!(graph.node(&NodeId::from("time-warp-sequences-2")).is_some());
        assert_eq!(
            graph
                .node(&NodeId::from("time-warp-sequences-0"))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(LONG_RUNNING_NODE_TIMEOUT_SECONDS))
        );
        assert!(graph.node(&NodeId::from("expand-coverage-0")).is_some());
        assert!(graph.node(&NodeId::from("expand-coverage-1")).is_some());
        assert!(graph.node(&NodeId::from("expand-coverage-2")).is_some());
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
            .node(&NodeId::from("externalized-state-accounting-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("rounding-direction-audit-0"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("rounding-direction-audit-1"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("rounding-direction-audit-2"))
            .is_some());
        assert_eq!(
            graph
                .node(&NodeId::from("state-machine-boundaries-0"))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(LONG_RUNNING_NODE_TIMEOUT_SECONDS))
        );
        assert!(graph.node(&NodeId::from("encode-decode-3")).is_none());
        assert!(graph
            .node(&NodeId::from("dynamic-strategy-generator"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("dynamic-strategy-generator-0"))
            .is_none());
        assert_eq!(
            graph
                .node(&NodeId::from("dynamic-strategy-generator"))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(14_400))
        );

        assert!(graph
            .node(&NodeId::from("stateful-invariant-setup"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("stateful-invariant-coverage-2"))
            .is_some());
        assert_eq!(
            graph
                .node(&NodeId::from("stateful-invariant-coverage-0"))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(3600))
        );
        assert_eq!(
            graph
                .node(&NodeId::from(STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(LONG_RUNNING_NODE_TIMEOUT_SECONDS))
        );
        assert_eq!(
            graph
                .node(&NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(60 * 60))
        );
        assert!(graph
            .node(&NodeId::from("differential-oracle-planner"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-lane-author-2"))
            .is_some());
        assert!(graph
            .node(&NodeId::from("differential-red-triage-1"))
            .is_some());

        let config = test_config("[invariants]\ninvariant_testing_fuzzer_timeout = \"45min\"\n");
        let graph = build_campaign_graph_from_topology(
            RunId::from("custom-recon-timeout"),
            temp.path(),
            &config,
            load_project_topology(temp.path()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            graph
                .node(&NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(45 * 60))
        );
    }

    #[test]
    fn topology_timeout_overrides_invariant_recon_config_timeout() {
        let config = test_config("[invariants]\ninvariant_testing_fuzzer_timeout = \"45min\"\n");
        let mut topology = default_project_topology();
        topology
            .nodes
            .iter_mut()
            .find(|node| node.id == NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID))
            .unwrap()
            .timeout_seconds = Some(120);

        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_references::write_default_reference_catalog(temp.path(), false).unwrap();
        let graph = build_campaign_graph_from_topology(
            RunId::from("run-recon-topology-timeout"),
            temp.path(),
            &config,
            topology,
        )
        .unwrap();

        assert_eq!(
            graph
                .node(&NodeId::from(STATEFUL_INVARIANT_RECON_CAMPAIGN_ID))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(120))
        );
    }

    #[test]
    fn topology_strategy_loop_default_overrides_normal_strategy_prompt_and_node_loops() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "strategies/storage-layout.md",
            "---\nid: storage-layout\nloops: 1\n---\n# Storage Layout\n",
        );
        let mut node =
            topology_node("storage-layout", &[]).with_prompt("strategies/storage-layout.md");
        node.group = Some("strategies".to_owned());
        node.loops = 2;
        let graph = build_campaign_graph_from_topology(
            RunId::from("run-strategy-default"),
            temp.path(),
            &test_config(""),
            ProjectTopology {
                version: TOPOLOGY_VERSION,
                defaults: TopologyDefaults { strategy_loops: 5 },
                groups: BTreeMap::new(),
                nodes: topology_with_start_finish(vec![node]),
            },
        )
        .unwrap();

        for index in 0..5 {
            let node = graph
                .node(&NodeId::from(format!("storage-layout-{index}")))
                .unwrap_or_else(|| panic!("storage-layout attempt {index} exists"));
            assert_eq!(agentic_loop_count(node), 5);
        }
        assert!(graph.node(&NodeId::from("storage-layout-5")).is_none());
        assert!(graph.node(&NodeId::from("storage-layout")).is_none());
    }

    #[test]
    fn custom_group_prompt_under_strategies_keeps_explicit_loops() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "strategies/custom-workflow.md",
            "---\nid: custom-workflow\nloops: 2\n---\n# Custom Workflow\n",
        );
        let mut node =
            topology_node("custom-workflow", &[]).with_prompt("strategies/custom-workflow.md");
        node.group = Some("custom".to_owned());
        node.loops = 4;
        let graph = build_campaign_graph_from_topology(
            RunId::from("run-custom-group"),
            temp.path(),
            &test_config(""),
            ProjectTopology {
                version: TOPOLOGY_VERSION,
                defaults: TopologyDefaults { strategy_loops: 5 },
                groups: BTreeMap::new(),
                nodes: topology_with_start_finish(vec![node]),
            },
        )
        .unwrap();

        for index in 0..2 {
            let node = graph
                .node(&NodeId::from(format!("custom-workflow-{index}")))
                .unwrap_or_else(|| panic!("custom-workflow attempt {index} exists"));
            assert_eq!(agentic_loop_count(node), 2);
        }
        assert!(graph.node(&NodeId::from("custom-workflow-2")).is_none());
    }

    #[test]
    fn topology_timeout_overrides_strategy_timeout() {
        let config =
            test_config("[strategies.stateful-invariant-coverage]\ntimeout_seconds = 3600\n");
        let mut topology = default_project_topology();
        topology
            .nodes
            .iter_mut()
            .find(|node| node.id == NodeId::from("stateful-invariant-coverage"))
            .unwrap()
            .timeout_seconds = Some(120);

        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_references::write_default_reference_catalog(temp.path(), false).unwrap();
        let graph = build_campaign_graph_from_topology(
            RunId::from("run-topology-timeout"),
            temp.path(),
            &config,
            topology,
        )
        .unwrap();

        assert_eq!(
            graph
                .node(&NodeId::from("stateful-invariant-coverage-0"))
                .unwrap()
                .timeout,
            Some(Duration::from_secs(120))
        );
    }

    #[test]
    fn explicit_prompt_loops_apply_outside_strategy_folders() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/storage-layout.md",
            "---\nid: storage-layout\nloops: 2\n---\n# Storage Layout\n",
        );
        let graph = build_campaign_graph_from_topology(
            RunId::from("run-custom"),
            temp.path(),
            &test_config(""),
            ProjectTopology {
                version: TOPOLOGY_VERSION,
                defaults: TopologyDefaults::default(),
                groups: BTreeMap::new(),
                nodes: topology_with_start_finish(vec![
                    topology_node("storage-layout", &[]).with_prompt("custom/storage-layout.md")
                ]),
            },
        )
        .unwrap();

        assert!(graph.node(&NodeId::from("storage-layout-0")).is_some());
        assert!(graph.node(&NodeId::from("storage-layout-1")).is_some());
        assert!(graph.node(&NodeId::from("storage-layout")).is_none());
    }

    #[test]
    fn topology_loops_are_preserved_when_prompt_loops_are_absent() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/storage-layout.md",
            "---\nid: storage-layout\n---\n# Storage Layout\n",
        );
        let mut node = topology_node("storage-layout", &[]).with_prompt("custom/storage-layout.md");
        node.loops = 3;
        let graph = build_campaign_graph_from_topology(
            RunId::from("run-preserve"),
            temp.path(),
            &test_config(""),
            ProjectTopology {
                version: TOPOLOGY_VERSION,
                defaults: TopologyDefaults::default(),
                groups: BTreeMap::new(),
                nodes: topology_with_start_finish(vec![node]),
            },
        )
        .unwrap();

        assert!(graph.node(&NodeId::from("storage-layout-0")).is_some());
        assert!(graph.node(&NodeId::from("storage-layout-1")).is_some());
        assert!(graph.node(&NodeId::from("storage-layout-2")).is_some());
    }

    #[test]
    fn prompt_loop_zero_is_rejected_before_expansion() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/storage-layout.md",
            "---\nid: storage-layout\nloops: 0\n---\n# Storage Layout\n",
        );
        let error = build_campaign_graph_from_topology(
            RunId::from("run-zero"),
            temp.path(),
            &test_config(""),
            ProjectTopology {
                version: TOPOLOGY_VERSION,
                defaults: TopologyDefaults::default(),
                groups: BTreeMap::new(),
                nodes: topology_with_start_finish(vec![
                    topology_node("storage-layout", &[]).with_prompt("custom/storage-layout.md")
                ]),
            },
        )
        .unwrap_err();

        assert!(matches!(
            error,
            GraphError::InvalidLoopCount(node) if node == NodeId::from("storage-layout")
        ));
    }

    #[test]
    fn topology_loop_count_above_max_is_rejected_before_expansion() {
        let temp = tempfile::tempdir().unwrap();
        let mut node = topology_node("storage-layout", &[]);
        node.loops = MAX_LOOPS + 1;
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![node]),
        };

        let error = validate_project_topology(
            temp.path(),
            &topology,
            TopologyValidationOptions {
                require_prompt_files: false,
            },
        )
        .unwrap_err();

        assert!(matches!(
            error,
            GraphError::TooManyLoops { node, loops, max }
                if node == NodeId::from("storage-layout")
                    && loops == MAX_LOOPS + 1
                    && max == MAX_LOOPS
        ));
    }

    #[test]
    fn prompt_loop_count_above_max_is_rejected_before_expansion() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/storage-layout.md",
            &format!(
                "---\nid: storage-layout\nloops: {}\n---\n# Storage Layout\n",
                MAX_LOOPS + 1
            ),
        );
        let error = build_campaign_graph_from_topology(
            RunId::from("run-too-many"),
            temp.path(),
            &test_config(""),
            ProjectTopology {
                version: TOPOLOGY_VERSION,
                defaults: TopologyDefaults::default(),
                groups: BTreeMap::new(),
                nodes: topology_with_start_finish(vec![
                    topology_node("storage-layout", &[]).with_prompt("custom/storage-layout.md")
                ]),
            },
        )
        .unwrap_err();

        assert!(matches!(
            error,
            GraphError::TooManyLoops { node, loops, max }
                if node == NodeId::from("storage-layout")
                    && loops == MAX_LOOPS + 1
                    && max == MAX_LOOPS
        ));
    }

    #[test]
    fn strategy_loop_default_zero_and_above_max_are_rejected_before_expansion() {
        let temp = tempfile::tempdir().unwrap();
        let mut zero = default_project_topology();
        zero.defaults.strategy_loops = 0;

        assert!(matches!(
            validate_project_topology(
                temp.path(),
                &zero,
                TopologyValidationOptions {
                    require_prompt_files: false,
                },
            ),
            Err(GraphError::InvalidStrategyLoopDefault)
        ));

        let mut too_many = default_project_topology();
        too_many.defaults.strategy_loops = MAX_LOOPS + 1;

        assert!(matches!(
            validate_project_topology(
                temp.path(),
                &too_many,
                TopologyValidationOptions {
                    require_prompt_files: false,
                },
            ),
            Err(GraphError::TooManyStrategyLoops { loops, max })
                if loops == MAX_LOOPS + 1 && max == MAX_LOOPS
        ));
    }

    #[test]
    fn total_expanded_node_count_above_max_is_rejected_before_expansion() {
        let temp = tempfile::tempdir().unwrap();
        let mut nodes = Vec::new();
        for index in 0..17 {
            let mut node = topology_node(&format!("node-{index}"), &[]);
            node.loops = MAX_LOOPS;
            nodes.push(node);
        }
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(nodes),
        };

        let error = validate_project_topology(
            temp.path(),
            &topology,
            TopologyValidationOptions {
                require_prompt_files: false,
            },
        )
        .unwrap_err();

        assert!(
            matches!(
                error,
                GraphError::TooManyExpandedNodes { count, max }
                    if count > MAX_EXPANDED_TOPOLOGY_NODES && max == MAX_EXPANDED_TOPOLOGY_NODES
            ),
            "{error:?}"
        );
    }

    #[test]
    fn topology_logical_node_count_above_max_is_rejected_before_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let nodes = (0..=MAX_TOPOLOGY_NODES)
            .map(|index| topology_node(&format!("node-{index}"), &[]))
            .collect();
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes,
        };

        let error =
            validate_project_topology(temp.path(), &topology, TopologyValidationOptions::default())
                .unwrap_err();

        assert!(
            matches!(
                error,
                GraphError::TooManyTopologyNodes { count, max }
                    if count > MAX_TOPOLOGY_NODES && max == MAX_TOPOLOGY_NODES
            ),
            "{error:?}"
        );
    }

    #[test]
    fn prompt_artifact_references_may_target_transitive_ancestors() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/source.md",
            "---\nid: source\n---\nWrite {{artifact_path}}/source.md\n",
        );
        write_prompt(
            temp.path(),
            "custom/middle.md",
            "---\nid: middle\n---\n# Middle\n",
        );
        write_prompt(
            temp.path(),
            "custom/consumer.md",
            "---\nid: consumer\n---\nRead {{artifact_path:source}}/source.md. Write {{artifact_path}}/summary.md.\n",
        );
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![
                topology_node("source", &[]).with_prompt("custom/source.md"),
                topology_node("middle", &["source"]).with_prompt("custom/middle.md"),
                topology_node("consumer", &["middle"]).with_prompt("custom/consumer.md"),
            ]),
        };

        validate_with_prompt_files(temp.path(), &topology).unwrap();
    }

    #[test]
    fn prompt_artifact_handoff_references_require_primary_artifact() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/source.md",
            "---\nid: source\n---\nWrite {{artifact_path}}/source.md\n",
        );
        write_prompt(
            temp.path(),
            "custom/consumer.md",
            "---\nid: consumer\n---\nRead {{artifact_handoff:source}}.\n",
        );
        let without_primary = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![
                topology_node("source", &[])
                    .with_prompt("custom/source.md")
                    .with_required_artifacts(&["source.md"]),
                topology_node("consumer", &["source"]).with_prompt("custom/consumer.md"),
            ]),
        };

        assert!(matches!(
            validate_with_prompt_files(temp.path(), &without_primary),
            Err(GraphError::MissingPromptArtifactHandoff { .. })
        ));

        let with_primary = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![
                topology_node("source", &[])
                    .with_prompt("custom/source.md")
                    .with_required_artifacts(&["source.md"])
                    .with_primary_artifact("source.md"),
                topology_node("consumer", &["source"]).with_prompt("custom/consumer.md"),
            ]),
        };

        validate_with_prompt_files(temp.path(), &with_primary).unwrap();
    }

    #[test]
    fn prompt_artifact_references_reject_unknown_producers() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/consumer.md",
            "---\nid: consumer\n---\nRead {{artifact_path:missing-node}}/source.md.\n",
        );
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![
                topology_node("consumer", &[]).with_prompt("custom/consumer.md")
            ]),
        };

        assert!(matches!(
            validate_with_prompt_files(temp.path(), &topology),
            Err(GraphError::UnknownPromptArtifactReference { .. })
        ));
    }

    #[test]
    fn prompt_artifact_references_reject_non_ancestors() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/source.md",
            "---\nid: source\n---\n# Source\n",
        );
        write_prompt(
            temp.path(),
            "custom/consumer.md",
            "---\nid: consumer\n---\nRead {{artifact_path:source}}/source.md.\n",
        );
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![
                topology_node("source", &[]).with_prompt("custom/source.md"),
                topology_node("consumer", &[]).with_prompt("custom/consumer.md"),
            ]),
        };

        assert!(matches!(
            validate_with_prompt_files(temp.path(), &topology),
            Err(GraphError::NonAncestorPromptArtifactReference { .. })
        ));
    }

    #[test]
    fn prompt_artifact_references_accept_looped_ancestors() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/source.md",
            "---\nid: source\n---\n# Source\n",
        );
        write_prompt(
            temp.path(),
            "custom/consumer.md",
            "---\nid: consumer\n---\nRead {{artifact_path:source}}/source.md.\n",
        );
        let mut source = topology_node("source", &[]).with_prompt("custom/source.md");
        source.loops = 2;
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![
                source,
                topology_node("consumer", &["source"]).with_prompt("custom/consumer.md"),
            ]),
        };

        validate_with_prompt_files(temp.path(), &topology).unwrap();
    }

    #[test]
    fn prompt_ancestor_artifacts_helper_uses_direct_dependencies() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/source-a.md",
            "---\nid: source-a\n---\nWrite {{artifact_path}}/a.md.\n",
        );
        write_prompt(
            temp.path(),
            "custom/source-b.md",
            "---\nid: source-b\n---\nWrite {{artifact_path}}/b.md.\n",
        );
        write_prompt(
            temp.path(),
            "custom/consumer.md",
            "---\nid: consumer\n---\nRead:\n{{ancestor_artifacts}}\n",
        );
        let mut source_a = topology_node("source-a", &[]).with_prompt("custom/source-a.md");
        source_a.required_artifacts = vec![PathBuf::from("a.md")];
        let mut source_b = topology_node("source-b", &[]).with_prompt("custom/source-b.md");
        source_b.required_artifacts = vec![PathBuf::from("b.md")];
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![
                source_a,
                source_b,
                topology_node("consumer", &["source-a", "source-b"])
                    .with_prompt("custom/consumer.md"),
            ]),
        };

        validate_with_prompt_files(temp.path(), &topology).unwrap();
    }

    #[test]
    fn prompt_ancestor_artifacts_helper_rejects_unknown_producers() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/consumer.md",
            "---\nid: consumer\n---\nRead:\n{{ancestor_artifacts:missing-node}}\n",
        );
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![
                topology_node("consumer", &[]).with_prompt("custom/consumer.md")
            ]),
        };

        assert!(matches!(
            validate_with_prompt_files(temp.path(), &topology),
            Err(GraphError::UnknownPromptArtifactReference { .. })
        ));
    }

    #[test]
    fn prompt_ancestor_artifacts_helper_rejects_producers_without_required_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        write_prompt(
            temp.path(),
            "custom/source.md",
            "---\nid: source\n---\n# Source\n",
        );
        write_prompt(
            temp.path(),
            "custom/consumer.md",
            "---\nid: consumer\n---\nRead:\n{{ancestor_artifacts}}\n",
        );
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![
                topology_node("source", &[]).with_prompt("custom/source.md"),
                topology_node("consumer", &["source"]).with_prompt("custom/consumer.md"),
            ]),
        };

        let error = validate_with_prompt_files(temp.path(), &topology).unwrap_err();
        assert!(matches!(
            error,
            GraphError::InvalidPromptArtifactReference { .. }
        ));
        assert!(error
            .to_string()
            .contains("ancestor_artifacts producer `source` has no required_artifacts"));
    }

    #[test]
    fn primary_artifact_must_be_required_artifact() {
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![topology_node("source", &[])
                .with_required_artifacts(&["source.md"])
                .with_primary_artifact("other.md")]),
        };

        assert!(matches!(
            validate_without_prompt_files(&topology),
            Err(GraphError::PrimaryArtifactNotRequired { .. })
        ));
    }

    #[test]
    fn reference_primary_artifact_must_not_be_manifest() {
        let mut reference = topology_node("reference-source", &[]);
        reference.kind = TopologyNodeKind::Reference;
        reference.prompt = None;
        reference.reference = Some(ReferenceId::from("properties.example"));
        reference.required_artifacts = vec![PathBuf::from(
            ultrafuzz_references::RUN_REFERENCE_MANIFEST_FILE,
        )];
        reference.primary_artifact = Some(PathBuf::from(
            ultrafuzz_references::RUN_REFERENCE_MANIFEST_FILE,
        ));
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![reference]),
        };

        let error = validate_without_prompt_files(&topology).unwrap_err();

        assert!(matches!(error, GraphError::InvalidReferenceNode { .. }));
        assert!(error.to_string().contains("must not use"));
        assert!(error
            .to_string()
            .contains(ultrafuzz_references::RUN_REFERENCE_MANIFEST_FILE));
    }

    fn required_artifacts_for(topology: &ProjectTopology, id: &str) -> Vec<PathBuf> {
        topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from(id))
            .expect("default topology node exists")
            .required_artifacts
            .clone()
    }

    fn primary_artifact_for(topology: &ProjectTopology, id: &str) -> Option<PathBuf> {
        topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from(id))
            .expect("node exists")
            .primary_artifact
            .clone()
    }

    fn loop_count_for(topology: &ProjectTopology, id: &str) -> usize {
        topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from(id))
            .expect("node exists")
            .loops
    }

    fn agentic_loop_count(node: &Node) -> usize {
        match &node.kind {
            NodeKind::Agentic { loop_count, .. } => *loop_count,
            other => panic!("expected agentic node, got {other:?}"),
        }
    }

    #[test]
    fn write_default_project_topology_respects_force() {
        let temp = tempfile::tempdir().unwrap();
        let topology_path = temp.path().join(PROJECT_TOPOLOGY_FILE);
        let first = write_default_project_topology(temp.path(), false).unwrap();
        assert_eq!(first.written, Some(topology_path.clone()));
        assert!(first.skipped.is_none());
        let first_contents = fs::read_to_string(&topology_path).unwrap();
        assert!(first_contents.contains("defaults:\n  strategy_loops: 3"));
        assert!(first_contents.contains(
            "id: aggregate-test-files\n  prompt: review/aggregate-test-files.md\n  group: review"
        ));
        assert!(!first_contents.contains("kind: aggregate-test-files"));
        assert!(first_contents.contains("id: dynamic-strategy-generator"));
        assert!(first_contents.contains("timeout_seconds: 14400"));
        assert!(first_contents.contains("timeout_seconds: 3600"));
        assert!(!first_contents.contains("id: encode-decode\n  prompt: strategies/encode-decode.md\n  group: strategies\n  depends_on:\n  - property-specification-fanin\n  loops: 1"));

        fs::write(&topology_path, "custom topology\n").unwrap();
        let second = write_default_project_topology(temp.path(), false).unwrap();
        assert_eq!(second.skipped, Some(topology_path.clone()));
        assert_eq!(
            fs::read_to_string(&topology_path).unwrap(),
            "custom topology\n"
        );

        let forced = write_default_project_topology(temp.path(), true).unwrap();
        assert_eq!(forced.written, Some(topology_path.clone()));
        let topology: ProjectTopology =
            serde_yaml::from_str(&fs::read_to_string(topology_path).unwrap()).unwrap();
        validate_without_prompt_files(&topology).unwrap();
    }

    #[test]
    fn write_default_project_topology_accepts_strategy_loop_override() {
        let temp = tempfile::tempdir().unwrap();

        ultrafuzz_references::write_default_reference_catalog(temp.path(), false).unwrap();
        write_default_project_topology_with_strategy_loops(temp.path(), false, 5).unwrap();

        let topology = load_project_topology(temp.path()).unwrap();
        assert_eq!(topology.defaults.strategy_loops, 5);
        let contents = fs::read_to_string(temp.path().join(PROJECT_TOPOLOGY_FILE)).unwrap();
        assert!(contents.contains("defaults:\n  strategy_loops: 5"));
    }

    #[test]
    fn write_default_project_topology_includes_project_strategy_prompts() {
        let temp = tempfile::tempdir().unwrap();
        let strategy_path = temp
            .path()
            .join(PROJECT_PROMPT_DIR)
            .join("strategies/project-special.md");
        fs::create_dir_all(strategy_path.parent().unwrap()).unwrap();
        fs::write(
            &strategy_path,
            "---\nid: project-special\ndisplay_name: Project Special\ntimeout_seconds: 1800\n---\n# Project Special\nRepo {{repo_path}}\nSetup {{artifact_handoff:stateful-invariant-setup}}\n",
        )
        .unwrap();

        ultrafuzz_references::write_default_reference_catalog(temp.path(), false).unwrap();
        write_default_project_topology_with_strategy_loops(temp.path(), false, 5).unwrap();

        let topology = load_project_topology(temp.path()).unwrap();
        let node = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("project-special"))
            .expect("project strategy prompt should be scaffolded into topology");
        assert_eq!(
            node.prompt.as_deref(),
            Some(Path::new("strategies/project-special.md"))
        );
        assert_eq!(node.group.as_deref(), Some("strategies"));
        assert!(node
            .depends_on
            .contains(&NodeId::from("property-specification-fanin")));
        assert!(node
            .depends_on
            .contains(&NodeId::from("stateful-invariant-setup")));

        let dedupe = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("dedupe-findings"))
            .expect("default topology should include dedupe");
        assert!(dedupe.depends_on.contains(&NodeId::from("project-special")));

        let registry = ultrafuzz_prompts::PromptRegistry::load_for_project(temp.path()).unwrap();
        let config = resolve_config_from_toml(
            Some(""),
            registry.strategy_definitions(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        let graph =
            build_campaign_graph_from_project(RunId::from("run-project"), temp.path(), &config)
                .unwrap();

        assert!(graph.node(&NodeId::from("project-special-0")).is_some());
        assert!(graph.node(&NodeId::from("project-special-4")).is_some());
        assert!(graph.node(&NodeId::from("project-special-5")).is_none());
        assert!(graph
            .node(&NodeId::from("project-special-0"))
            .unwrap()
            .depends_on
            .contains(&NodeId::from("stateful-invariant-setup")));
        assert!(graph
            .node(&NodeId::from("dedupe-findings"))
            .unwrap()
            .depends_on
            .contains(&NodeId::from("project-special-4")));
    }

    #[test]
    fn write_default_project_topology_skips_toml_disabled_project_strategy_prompts() {
        let temp = tempfile::tempdir().unwrap();
        let strategy_path = temp
            .path()
            .join(PROJECT_PROMPT_DIR)
            .join("strategies/project-disabled.md");
        fs::create_dir_all(strategy_path.parent().unwrap()).unwrap();
        fs::write(
            &strategy_path,
            "---\nid: project-disabled\ndisplay_name: Project Disabled\nenabled: true\n---\n# Project Disabled\nRepo {{repo_path}}\n",
        )
        .unwrap();
        fs::write(
            temp.path().join(ultrafuzz_config::CONFIG_FILE_NAME),
            "[strategies.project-disabled]\nenabled = false\n",
        )
        .unwrap();

        write_default_project_topology_with_strategy_loops(temp.path(), false, 5).unwrap();

        let topology = load_project_topology(temp.path()).unwrap();
        assert!(topology
            .nodes
            .iter()
            .all(|node| node.id != NodeId::from("project-disabled")));
        let dedupe = topology
            .nodes
            .iter()
            .find(|node| node.id == NodeId::from("dedupe-findings"))
            .expect("default topology should include dedupe");
        assert!(!dedupe
            .depends_on
            .contains(&NodeId::from("project-disabled")));
    }

    #[test]
    fn write_default_project_topology_rejects_project_strategy_concrete_id_collision() {
        let temp = tempfile::tempdir().unwrap();
        let strategy_path = temp
            .path()
            .join(PROJECT_PROMPT_DIR)
            .join("strategies/encode-decode-0.md");
        fs::create_dir_all(strategy_path.parent().unwrap()).unwrap();
        fs::write(
            &strategy_path,
            "---\nid: encode-decode-0\ndisplay_name: Encode Decode Collision\ntimeout_seconds: 1800\n---\n# Encode Decode Collision\nRepo {{repo_path}}\n",
        )
        .unwrap();

        let error =
            write_default_project_topology_with_strategy_loops(temp.path(), false, 5).unwrap_err();

        assert!(matches!(
            error,
            GraphError::ConcreteNodeIdCollision {
                logical,
                concrete
            } if logical == NodeId::from("encode-decode")
                && concrete == NodeId::from("encode-decode-0")
        ));
        assert!(!temp.path().join(PROJECT_TOPOLOGY_FILE).exists());
    }

    #[test]
    fn json_topology_without_meta_kind_is_rejected_by_strict_validation() {
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![
                TopologyNode {
                    id: NodeId::from(START_NODE_ID),
                    kind: TopologyNodeKind::Agentic,
                    role: None,
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
                topology_node("task", &[START_NODE_ID]),
                TopologyNode {
                    id: NodeId::from(FINISH_NODE_ID),
                    kind: TopologyNodeKind::Agentic,
                    role: None,
                    prompt: None,
                    reference: None,
                    group: None,
                    depends_on: vec![NodeId::from("task")],
                    loops: 1,
                    loop_mode: LoopMode::Parallel,
                    timeout_seconds: None,
                    required_artifacts: Vec::new(),
                    primary_artifact: None,
                },
            ],
        };

        let error = validate_without_prompt_files(&topology).unwrap_err();

        assert!(matches!(
            error,
            GraphError::InvalidMetaNode { node, reason }
                if node == NodeId::from(START_NODE_ID)
                    && reason.contains("reserved START/FINISH ids must use kind `meta`")
        ));
    }

    #[test]
    fn yaml_meta_nodes_deserialize_with_kind_and_role() {
        let yaml = r#"
version: 1
defaults:
  strategy_loops: 3
nodes:
- id: __start__
  kind: meta
  role: start
  depends_on: []
- id: __finish__
  kind: meta
  role: finish
  depends_on:
  - task
- id: task
  depends_on:
  - __start__
  loops: 1
"#;
        let topology: ProjectTopology = serde_yaml::from_str(yaml).unwrap();
        let start = topology
            .nodes
            .iter()
            .find(|node| node.id.as_str() == START_NODE_ID)
            .unwrap();
        assert_eq!(start.kind, TopologyNodeKind::Meta);
        assert_eq!(start.role, Some(MetaNodeRole::Start));
        let json = serde_json::to_value(&topology).unwrap();
        assert_eq!(json["nodes"][0]["kind"], "meta");
        assert_eq!(json["nodes"][0]["role"], "start");
    }

    #[test]
    fn topology_yaml_missing_defaults_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(PROJECT_TOPOLOGY_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"
version: 1
nodes:
- id: __start__
  kind: meta
  role: start
  depends_on: []
- id: task
  depends_on:
  - __start__
- id: __finish__
  kind: meta
  role: finish
  depends_on:
  - task
"#,
        )
        .unwrap();

        let error = load_project_topology(temp.path()).unwrap_err();

        assert!(matches!(error, GraphError::TopologyParse(_)));
        assert!(error.to_string().contains("missing field `defaults`"));
    }

    #[test]
    fn load_project_topology_rejects_missing_start_meta_node() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(PROJECT_TOPOLOGY_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"
version: 1
defaults:
  strategy_loops: 3
nodes:
- id: task
  depends_on:
  - __start__
- id: __finish__
  kind: meta
  role: finish
  depends_on:
  - task
"#,
        )
        .unwrap();

        let error = load_project_topology(temp.path()).unwrap_err();

        assert!(matches!(error, GraphError::MissingMetaNode(START_NODE_ID)));
    }

    #[test]
    fn load_project_topology_rejects_missing_finish_meta_node() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(PROJECT_TOPOLOGY_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"
version: 1
defaults:
  strategy_loops: 3
nodes:
- id: __start__
  kind: meta
  role: start
  depends_on: []
- id: task
  depends_on:
  - __start__
"#,
        )
        .unwrap();

        let error = load_project_topology(temp.path()).unwrap_err();

        assert!(matches!(error, GraphError::MissingMetaNode(FINISH_NODE_ID)));
    }

    #[test]
    fn repair_topology_meta_contract_inserts_missing_meta_nodes() {
        let mut topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![topology_node("task", &[START_NODE_ID])],
        };
        repair_topology_meta_contract(&mut topology);
        assert!(topology
            .nodes
            .iter()
            .any(|node| node.id.as_str() == START_NODE_ID && node.kind == TopologyNodeKind::Meta));
        assert!(topology
            .nodes
            .iter()
            .any(|node| node.id.as_str() == FINISH_NODE_ID && node.kind == TopologyNodeKind::Meta));
        validate_without_prompt_files(&topology).unwrap();
    }

    #[test]
    fn strict_validation_rejects_missing_start_meta_node() {
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![
                topology_node("task", &[]),
                meta_node(MetaNodeRole::Finish, &["task"]),
            ],
        };

        let error = validate_without_prompt_files(&topology).unwrap_err();

        assert!(matches!(error, GraphError::MissingMetaNode(START_NODE_ID)));
    }

    #[test]
    fn strict_validation_reports_missing_start_before_unknown_reserved_dependency() {
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![
                topology_node("task", &[START_NODE_ID]),
                meta_node(MetaNodeRole::Finish, &["task"]),
            ],
        };

        let error = validate_without_prompt_files(&topology).unwrap_err();

        assert!(matches!(error, GraphError::MissingMetaNode(START_NODE_ID)));
    }

    #[test]
    fn strict_validation_rejects_missing_finish_meta_node() {
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![
                meta_node(MetaNodeRole::Start, &[]),
                topology_node("task", &[START_NODE_ID]),
            ],
        };

        let error = validate_without_prompt_files(&topology).unwrap_err();

        assert!(matches!(error, GraphError::MissingMetaNode(FINISH_NODE_ID)));
    }

    #[test]
    fn strict_validation_rejects_reserved_meta_nodes_with_wrong_kind_or_role() {
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![
                topology_node(START_NODE_ID, &[]),
                topology_node("task", &[START_NODE_ID]),
                meta_node(MetaNodeRole::Finish, &["task"]),
            ],
        };

        let error = validate_without_prompt_files(&topology).unwrap_err();

        assert!(matches!(
            error,
            GraphError::InvalidMetaNode { node, reason }
                if node == NodeId::from(START_NODE_ID)
                    && reason.contains("reserved START/FINISH ids must use kind `meta`")
        ));

        let mut start = meta_node(MetaNodeRole::Start, &[]);
        start.role = Some(MetaNodeRole::Finish);
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![
                start,
                topology_node("task", &[START_NODE_ID]),
                meta_node(MetaNodeRole::Finish, &["task"]),
            ],
        };

        let error = validate_without_prompt_files(&topology).unwrap_err();

        assert!(matches!(
            error,
            GraphError::InvalidMetaNode { node, reason }
                if node == NodeId::from(START_NODE_ID)
                    && reason.contains("Finish meta-node id must be `__finish__`")
        ));
    }

    #[test]
    fn strict_validation_rejects_malformed_reserved_meta_node_fields() {
        fn malformed_start_error<F: FnOnce(&mut TopologyNode)>(mutate: F) -> GraphError {
            let mut start = meta_node(MetaNodeRole::Start, &[]);
            mutate(&mut start);
            let topology = ProjectTopology {
                version: TOPOLOGY_VERSION,
                defaults: TopologyDefaults::default(),
                groups: BTreeMap::new(),
                nodes: vec![
                    start,
                    topology_node("task", &[START_NODE_ID]),
                    meta_node(MetaNodeRole::Finish, &["task"]),
                ],
            };
            validate_without_prompt_files(&topology).unwrap_err()
        }

        let error = malformed_start_error(|node| node.prompt = Some(PathBuf::from("start.md")));
        assert!(matches!(
            error,
            GraphError::InvalidMetaNode { node, reason }
                if node == NodeId::from(START_NODE_ID)
                    && reason.contains("must not define a prompt")
        ));

        let error = malformed_start_error(|node| node.group = Some("setup".to_owned()));
        assert!(matches!(
            error,
            GraphError::InvalidMetaNode { node, reason }
                if node == NodeId::from(START_NODE_ID)
                    && reason.contains("must not be assigned to a phase group")
        ));

        let error = malformed_start_error(|node| node.loops = 2);
        assert!(matches!(
            error,
            GraphError::InvalidMetaNode { node, reason }
                if node == NodeId::from(START_NODE_ID)
                    && reason.contains("must use loops = 1")
        ));

        let error = malformed_start_error(|node| node.loop_mode = LoopMode::Series);
        assert!(matches!(
            error,
            GraphError::InvalidMetaNode { node, reason }
                if node == NodeId::from(START_NODE_ID)
                    && reason.contains("must use loop_mode = parallel")
        ));

        let error = malformed_start_error(|node| node.timeout_seconds = Some(60));
        assert!(matches!(
            error,
            GraphError::InvalidMetaNode { node, reason }
                if node == NodeId::from(START_NODE_ID)
                    && reason.contains("must not define timeout_seconds")
        ));

        let error =
            malformed_start_error(|node| node.required_artifacts = vec![PathBuf::from("start.md")]);
        assert!(matches!(
            error,
            GraphError::InvalidMetaNode { node, reason }
                if node == NodeId::from(START_NODE_ID)
                    && reason.contains("must not require artifacts")
        ));

        let error =
            malformed_start_error(|node| node.primary_artifact = Some(PathBuf::from("start.md")));
        assert!(matches!(
            error,
            GraphError::InvalidMetaNode { node, reason }
                if node == NodeId::from(START_NODE_ID)
                    && reason.contains("must not define primary_artifact")
        ));
    }

    #[test]
    fn start_finish_meta_nodes_validate_entry_and_exit_contracts() {
        let mut root_task = topology_node("task", &[]);
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![
                meta_node(MetaNodeRole::Start, &[]),
                root_task.clone(),
                meta_node(MetaNodeRole::Finish, &["task"]),
            ],
        };
        assert!(matches!(
            validate_without_prompt_files(&topology),
            Err(GraphError::InvalidEntryExit { node, .. }) if node == NodeId::from("task")
        ));

        root_task.depends_on = vec![NodeId::from(START_NODE_ID)];
        let mut bad_finish = meta_node(MetaNodeRole::Finish, &["task"]);
        bad_finish.prompt = Some(PathBuf::from("finish.md"));
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![meta_node(MetaNodeRole::Start, &[]), root_task, bad_finish],
        };
        assert!(matches!(
            validate_without_prompt_files(&topology),
            Err(GraphError::InvalidMetaNode { node, reason })
                if node == NodeId::from(FINISH_NODE_ID)
                    && reason.contains("must not define a prompt")
        ));
    }

    #[test]
    fn start_finish_meta_nodes_lower_without_loop_expansion() {
        let mut task = topology_node("task", &[START_NODE_ID]);
        task.loops = 2;
        let graph = build_campaign_graph_from_topology(
            RunId::from("run-meta"),
            Path::new("."),
            &test_config(""),
            ProjectTopology {
                version: TOPOLOGY_VERSION,
                defaults: TopologyDefaults::default(),
                groups: BTreeMap::new(),
                nodes: vec![
                    meta_node(MetaNodeRole::Start, &[]),
                    task,
                    meta_node(MetaNodeRole::Finish, &["task"]),
                ],
            },
        )
        .unwrap();

        assert_eq!(graph.nodes.len(), 4);
        assert!(graph.node(&NodeId::from("task-0")).is_some());
        assert!(graph.node(&NodeId::from("task-1")).is_some());
        assert!(graph.node(&NodeId::from("start-0")).is_none());
        assert!(matches!(
            graph.node(&NodeId::from(START_NODE_ID)).unwrap().kind,
            NodeKind::Meta {
                role: MetaNodeRole::Start
            }
        ));
        assert_eq!(
            graph
                .node(&NodeId::from(FINISH_NODE_ID))
                .unwrap()
                .depends_on,
            vec![NodeId::from("task-0"), NodeId::from("task-1")]
        );
    }

    #[test]
    #[cfg(unix)]
    fn write_default_project_topology_rejects_symlinked_topology_parent() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join(".ultrafuzz")).unwrap();

        let error = write_default_project_topology(temp.path(), true).unwrap_err();

        assert!(matches!(
            error,
            GraphError::SymlinkPath(path) if path.ends_with(".ultrafuzz")
        ));
        assert!(!outside.path().join("topology.yml").exists());
    }

    #[test]
    #[cfg(unix)]
    fn write_default_project_topology_rejects_symlinked_topology_file() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let topology_path = temp.path().join(PROJECT_TOPOLOGY_FILE);
        let outside_topology = outside.path().join("topology.yml");
        fs::create_dir_all(topology_path.parent().unwrap()).unwrap();
        fs::write(&outside_topology, "outside topology\n").unwrap();
        std::os::unix::fs::symlink(&outside_topology, &topology_path).unwrap();

        let error = write_default_project_topology(temp.path(), true).unwrap_err();

        assert!(matches!(
            error,
            GraphError::SymlinkPath(path) if path.ends_with(PROJECT_TOPOLOGY_FILE)
        ));
        assert_eq!(
            fs::read_to_string(outside_topology).unwrap(),
            "outside topology\n"
        );
    }

    fn test_graph_node(id: &str, depends_on: &[&str]) -> Node {
        let node_id = NodeId::from(id);
        Node {
            id: node_id.clone(),
            label: title_from_node_id(id),
            kind: NodeKind::Agentic {
                logical_id: node_id.clone(),
                prompt_path: default_prompt_path(&node_id),
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
            artifact_dir: deterministic_artifact_dir(&node_id),
        }
    }

    #[test]
    fn project_topology_validation_rejects_cycles_missing_deps_and_unsafe_paths() {
        let missing = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![topology_node("a", &["missing"])]),
        };
        assert!(matches!(
            validate_without_prompt_files(&missing),
            Err(GraphError::UnknownDependency { .. })
        ));

        let cycle = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: topology_with_start_finish(vec![
                topology_node("a", &["b"]),
                topology_node("b", &["a"]),
            ]),
        };
        assert!(matches!(
            validate_without_prompt_files(&cycle),
            Err(GraphError::CycleDetected(_))
        ));

        let mut unsafe_artifact = topology_node("a", &[]);
        unsafe_artifact.required_artifacts = vec![PathBuf::from("../outside.json")];
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![unsafe_artifact],
        };
        assert!(matches!(
            validate_without_prompt_files(&topology),
            Err(GraphError::InvalidRequiredArtifact { .. })
        ));

        let mut invalid_group = topology_node("a", &[]);
        invalid_group.group = Some("Review Nodes".to_owned());
        let topology = ProjectTopology {
            version: TOPOLOGY_VERSION,
            defaults: TopologyDefaults::default(),
            groups: BTreeMap::new(),
            nodes: vec![invalid_group],
        };
        assert!(matches!(
            validate_without_prompt_files(&topology),
            Err(GraphError::InvalidGroupId(group)) if group == "Review Nodes"
        ));
    }

    #[test]
    fn project_topology_expands_parallel_and_series_loops() {
        let config = test_config("[run]\ndefault_timeout_seconds = 60\n");
        let mut parallel = topology_node("parallel-node", &[]);
        parallel.loops = 3;
        parallel.loop_mode = LoopMode::Parallel;
        let mut series = topology_node("series-node", &["parallel-node"]);
        series.loops = 3;
        series.loop_mode = LoopMode::Series;
        let downstream = topology_node("downstream", &["series-node"]);
        let graph = build_campaign_graph_from_topology(
            RunId::from("run"),
            Path::new("."),
            &config,
            ProjectTopology {
                version: TOPOLOGY_VERSION,
                defaults: TopologyDefaults::default(),
                groups: BTreeMap::new(),
                nodes: topology_with_start_finish(vec![parallel, series, downstream]),
            },
        )
        .unwrap();

        assert_eq!(
            graph
                .node(&NodeId::from("parallel-node-0"))
                .unwrap()
                .depends_on,
            vec![NodeId::from(START_NODE_ID)]
        );
        assert_eq!(
            graph
                .node(&NodeId::from("series-node-0"))
                .unwrap()
                .depends_on,
            vec![
                NodeId::from("parallel-node-0"),
                NodeId::from("parallel-node-1"),
                NodeId::from("parallel-node-2")
            ]
        );
        assert_eq!(
            graph
                .node(&NodeId::from("series-node-1"))
                .unwrap()
                .depends_on,
            vec![NodeId::from("series-node-0")]
        );
        assert_eq!(
            graph.node(&NodeId::from("downstream")).unwrap().depends_on,
            vec![
                NodeId::from("series-node-0"),
                NodeId::from("series-node-1"),
                NodeId::from("series-node-2")
            ]
        );
    }

    #[test]
    fn rejects_cycles_and_missing_dependencies() {
        let cycle = CampaignGraph {
            run_id: RunId::from("run"),
            graph_version: GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![test_graph_node("a", &["b"]), test_graph_node("b", &["a"])],
        };
        assert!(matches!(
            cycle.validate(),
            Err(GraphError::CycleDetected(_))
        ));

        let missing = CampaignGraph {
            run_id: RunId::from("run"),
            graph_version: GRAPH_VERSION.to_owned(),
            groups: BTreeMap::new(),
            nodes: vec![test_graph_node("a", &["missing"])],
        };
        assert!(matches!(
            missing.validate(),
            Err(GraphError::UnknownDependency { .. })
        ));
    }

    #[test]
    fn fingerprint_is_stable_across_run_ids() {
        let left = test_topology_graph(
            "run-a",
            vec![
                topology_node("setup", &[]),
                topology_node("review", &["setup"]),
            ],
        );
        let right = test_topology_graph(
            "run-b",
            vec![
                topology_node("setup", &[]),
                topology_node("review", &["setup"]),
            ],
        );

        assert_eq!(left.fingerprint().unwrap(), right.fingerprint().unwrap());

        let mut changed_review = topology_node("review", &["setup"]);
        changed_review.loops = 2;
        let changed_graph =
            test_topology_graph("run-c", vec![topology_node("setup", &[]), changed_review]);
        assert_ne!(
            left.fingerprint().unwrap(),
            changed_graph.fingerprint().unwrap()
        );
    }

    #[test]
    fn fingerprint_changes_when_reference_commit_changes() {
        let temp = tempfile::tempdir().unwrap();
        ultrafuzz_prompts::scaffold_project_prompts(temp.path(), false).unwrap();
        ultrafuzz_references::write_default_reference_catalog(temp.path(), false).unwrap();
        write_default_project_topology(temp.path(), false).unwrap();
        let registry = ultrafuzz_prompts::PromptRegistry::load_for_project(temp.path()).unwrap();
        let config = resolve_config_from_toml(
            Some(""),
            registry.strategy_definitions(),
            EnvOverrides::default(),
            CliOverrides::default(),
        )
        .unwrap();
        let first =
            build_campaign_graph_from_project(RunId::from("run-a"), temp.path(), &config).unwrap();
        let first_fingerprint = first.fingerprint().unwrap();
        let reference = first
            .node(&NodeId::from("reference-properties-montyly-rounding"))
            .unwrap();
        assert!(matches!(
            &reference.kind,
            NodeKind::Reference {
                revision: Some(revision),
                ..
            } if revision.commit == "a3dbfa1fbacd05fb2e5e7c66acb2243dafd1483d"
        ));

        let catalog_path = ultrafuzz_references::references_path(temp.path());
        let catalog = fs::read_to_string(&catalog_path).unwrap().replace(
            "a3dbfa1fbacd05fb2e5e7c66acb2243dafd1483d",
            "b3dbfa1fbacd05fb2e5e7c66acb2243dafd1483d",
        );
        fs::write(&catalog_path, catalog).unwrap();
        let second =
            build_campaign_graph_from_project(RunId::from("run-b"), temp.path(), &config).unwrap();

        assert_ne!(first_fingerprint, second.fingerprint().unwrap());
        let reference = second
            .node(&NodeId::from("reference-properties-montyly-rounding"))
            .unwrap();
        assert!(matches!(
            &reference.kind,
            NodeKind::Reference {
                revision: Some(revision),
                ..
            } if revision.commit == "b3dbfa1fbacd05fb2e5e7c66acb2243dafd1483d"
        ));
    }

    #[test]
    fn serializes_graph_json_with_artifact_dirs() {
        let mut strategy = topology_node("encode-decode", &[]);
        strategy.loops = 2;
        let graph = test_topology_graph(
            "run",
            vec![strategy, topology_node("final-report", &["encode-decode"])],
        );
        let json = graph.to_json_pretty().unwrap();

        assert!(json.contains("\"graph_version\""));
        assert!(json.contains("\"artifact_dir\""));
        assert!(json.contains("artifacts/encode-decode-0"));
        assert!(json.contains("artifacts/final-report"));
        assert!(!json.contains("merge-patches"));
    }
}
