use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use thiserror::Error;
use ultrafuzz_core::{
    is_stateful_invariant_subbox_id, BuiltInStrategy, ModelProfileId, PromptId, StrategyCategory,
    StrategyDefinition, StrategyId, StrategySource,
};

pub const PROJECT_PROMPT_DIR: &str = ".ultrafuzz/prompts";
pub const RENDERED_PROMPT_FILE: &str = "prompt.rendered.md";
pub const SUPPORTED_TEMPLATE_VARIABLES: [&str; 30] = [
    "repo_path",
    "workspace_path",
    "artifact_path",
    "artifact_dir",
    "ancestor_artifacts",
    "run_artifacts_path",
    "run_artifacts_dir",
    "run_metadata_path",
    "run_metadata_dir",
    "output_findings_path",
    "output_patch_path",
    "output_metadata_path",
    "run_id",
    "node_id",
    "strategy",
    "strategy_display_name",
    "strategy_source",
    "attempt_index",
    "strategy_loop_index",
    "strategy_loop_count",
    "triage_quorum",
    "triage_panel_size",
    "dynamic_strategies_enumerator",
    "invariant_property_priority_threshold",
    "invariant_property_priority_filter",
    "invariant_property_priorities",
    "invariant_testing_fuzzer_timeout",
    "strategy_attempt_test_dir",
    "aggregation_destination_dir",
    "backend_kind",
];

const DEFAULT_TIMEOUT_SECONDS: u64 = 1_800;
const PROPERTY_BASED_TOPOLOGY_STRATEGY_IDS: [&str; 16] = [
    "admin-config-boundaries",
    "amm-boundary-liquidity",
    "batch-atomicity-unsupported-actions",
    "boundary-tests",
    "dynamic-strategy-generator",
    "externalized-state-accounting",
    "external-dependency-boundaries",
    "lifecycle-view-boundaries",
    "market-exhaustion-boundaries",
    "order-replacement-collateral",
    "packed-action-parity",
    "payable-fallback-accounting",
    "router-exact-accounting",
    "rounding-direction-audit",
    "state-machine-boundaries",
    "time-warp-sequences",
];

struct BuiltInPromptAsset {
    strategy: BuiltInStrategy,
    markdown: &'static str,
}

#[derive(Clone, Copy)]
struct ScaffoldPromptAsset {
    relative_path: &'static str,
    markdown: &'static str,
}

const PROJECT_TOPOLOGY_PROMPTS: &[ScaffoldPromptAsset] = &[
    ScaffoldPromptAsset {
        relative_path: "setup/project-discovery.md",
        markdown: include_str!("../../../prompts/setup/project-discovery.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "setup/actors-flows.md",
        markdown: include_str!("../../../prompts/setup/actors-flows.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "setup/prepare-foundry-harness.md",
        markdown: include_str!("../../../prompts/setup/prepare-foundry-harness.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "setup/discover-base-test.md",
        markdown: include_str!("../../../prompts/setup/discover-base-test.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "properties/0kn0t-lens.md",
        markdown: include_str!("../../../prompts/properties/0kn0t-lens.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "properties/certora-thinking-lens.md",
        markdown: include_str!("../../../prompts/properties/certora-thinking-lens.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "properties/aviggiano-lens.md",
        markdown: include_str!("../../../prompts/properties/aviggiano-lens.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "properties/josselin-feist-lens.md",
        markdown: include_str!("../../../prompts/properties/josselin-feist-lens.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "properties/property-specification-crytic.md",
        markdown: include_str!("../../../prompts/properties/property-specification-crytic.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "properties/property-specification-runtime-verification.md",
        markdown: include_str!(
            "../../../prompts/properties/property-specification-runtime-verification.md"
        ),
    },
    ScaffoldPromptAsset {
        relative_path: "properties/property-specification-a16z.md",
        markdown: include_str!("../../../prompts/properties/property-specification-a16z.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "properties/recon-lens.md",
        markdown: include_str!("../../../prompts/properties/recon-lens.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "properties/property-specification-fanin.md",
        markdown: include_str!("../../../prompts/properties/property-specification-fanin.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/boundary-tests.md",
        markdown: include_str!("../../../prompts/strategies/boundary-tests.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/encode-decode.md",
        markdown: include_str!("../../../prompts/strategies/encode-decode.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/differential-library-tests.md",
        markdown: include_str!("../../../prompts/strategies/differential-library-tests.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/round-trip.md",
        markdown: include_str!("../../../prompts/strategies/round-trip.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/workflow-property-based-tests.md",
        markdown: include_str!("../../../prompts/strategies/workflow-property-based-tests.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/time-warp-sequences.md",
        markdown: include_str!("../../../prompts/strategies/time-warp-sequences.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/expand-coverage.md",
        markdown: include_str!("../../../prompts/strategies/expand-coverage.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/admin-config-boundaries.md",
        markdown: include_str!("../../../prompts/strategies/admin-config-boundaries.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/external-dependency-boundaries.md",
        markdown: include_str!("../../../prompts/strategies/external-dependency-boundaries.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/amm-boundary-liquidity.md",
        markdown: include_str!("../../../prompts/strategies/amm-boundary-liquidity.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/payable-fallback-accounting.md",
        markdown: include_str!("../../../prompts/strategies/payable-fallback-accounting.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/externalized-state-accounting.md",
        markdown: include_str!("../../../prompts/strategies/externalized-state-accounting.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/packed-action-parity.md",
        markdown: include_str!("../../../prompts/strategies/packed-action-parity.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/batch-atomicity-unsupported-actions.md",
        markdown: include_str!(
            "../../../prompts/strategies/batch-atomicity-unsupported-actions.md"
        ),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/router-exact-accounting.md",
        markdown: include_str!("../../../prompts/strategies/router-exact-accounting.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/rounding-direction-audit.md",
        markdown: include_str!("../../../prompts/strategies/rounding-direction-audit.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/market-exhaustion-boundaries.md",
        markdown: include_str!("../../../prompts/strategies/market-exhaustion-boundaries.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/order-replacement-collateral.md",
        markdown: include_str!("../../../prompts/strategies/order-replacement-collateral.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/state-machine-boundaries.md",
        markdown: include_str!("../../../prompts/strategies/state-machine-boundaries.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/lifecycle-view-boundaries.md",
        markdown: include_str!("../../../prompts/strategies/lifecycle-view-boundaries.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/dynamic-strategy-generator.md",
        markdown: include_str!("../../../prompts/strategies/dynamic-strategy-generator.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/invariants/setup.md",
        markdown: include_str!("../../../prompts/strategies/invariants/setup.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/invariants/handlers.md",
        markdown: include_str!("../../../prompts/strategies/invariants/handlers.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/invariants/coverage.md",
        markdown: include_str!("../../../prompts/strategies/invariants/coverage.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/invariants/implement-properties.md",
        markdown: include_str!("../../../prompts/strategies/invariants/implement-properties.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/invariants/invariant-testing-campaign.md",
        markdown: include_str!(
            "../../../prompts/strategies/invariants/invariant-testing-campaign.md"
        ),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/differential/differential-oracle-planner.md",
        markdown: include_str!(
            "../../../prompts/strategies/differential/differential-oracle-planner.md"
        ),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/differential/reference-harness-author.md",
        markdown: include_str!(
            "../../../prompts/strategies/differential/reference-harness-author.md"
        ),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/differential/reference-and-lane-auditor.md",
        markdown: include_str!(
            "../../../prompts/strategies/differential/reference-and-lane-auditor.md"
        ),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/differential/differential-lane-author.md",
        markdown: include_str!(
            "../../../prompts/strategies/differential/differential-lane-author.md"
        ),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/differential/differential-red-triage.md",
        markdown: include_str!(
            "../../../prompts/strategies/differential/differential-red-triage.md"
        ),
    },
    ScaffoldPromptAsset {
        relative_path: "strategies/differential/differential-repair-and-report-review.md",
        markdown: include_str!(
            "../../../prompts/strategies/differential/differential-repair-and-report-review.md"
        ),
    },
    ScaffoldPromptAsset {
        relative_path: "review/dedupe-findings.md",
        markdown: include_str!("../../../prompts/review/dedupe-findings.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "review/triage.md",
        markdown: include_str!("../../../prompts/review/triage.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "review/severity-classification.md",
        markdown: include_str!("../../../prompts/review/severity-classification.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "review/aggregate-test-files.md",
        markdown: include_str!("../../../prompts/review/aggregate-test-files.md"),
    },
    ScaffoldPromptAsset {
        relative_path: "review/final-report.md",
        markdown: include_str!("../../../prompts/review/final-report.md"),
    },
];

const BUILT_IN_STRATEGY_PROMPTS: [BuiltInPromptAsset; 8] = [
    BuiltInPromptAsset {
        strategy: BuiltInStrategy::DifferentialLibraryTests,
        markdown: include_str!("../../../prompts/strategies/differential-library-tests.md"),
    },
    BuiltInPromptAsset {
        strategy: BuiltInStrategy::RoundTrip,
        markdown: include_str!("../../../prompts/strategies/round-trip.md"),
    },
    BuiltInPromptAsset {
        strategy: BuiltInStrategy::WorkflowPropertyBasedTests,
        markdown: include_str!("../../../prompts/strategies/workflow-property-based-tests.md"),
    },
    BuiltInPromptAsset {
        strategy: BuiltInStrategy::EncodeDecode,
        markdown: include_str!("../../../prompts/strategies/encode-decode.md"),
    },
    BuiltInPromptAsset {
        strategy: BuiltInStrategy::ExpandCoverage,
        markdown: include_str!("../../../prompts/strategies/expand-coverage.md"),
    },
    BuiltInPromptAsset {
        strategy: BuiltInStrategy::StatefulInvariantSetup,
        markdown: include_str!("../../../prompts/strategies/invariants/setup.md"),
    },
    BuiltInPromptAsset {
        strategy: BuiltInStrategy::StatefulInvariantHandlers,
        markdown: include_str!("../../../prompts/strategies/invariants/handlers.md"),
    },
    BuiltInPromptAsset {
        strategy: BuiltInStrategy::StatefulInvariantCoverage,
        markdown: include_str!("../../../prompts/strategies/invariants/coverage.md"),
    },
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PromptSource {
    BuiltIn,
    Project(PathBuf),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptTemplate {
    pub id: PromptId,
    pub strategy_id: StrategyId,
    pub source: PromptSource,
    pub source_path: PathBuf,
    pub display_name: String,
    pub category: StrategyCategory,
    pub models: Vec<ModelProfileId>,
    pub loops: usize,
    pub enabled: bool,
    pub timeout: Duration,
    pub body: String,
}

impl PromptTemplate {
    pub fn strategy_definition(&self) -> StrategyDefinition {
        StrategyDefinition {
            id: self.strategy_id.clone(),
            display_name: self.display_name.clone(),
            prompt_id: self.id.clone(),
            prompt_path: self.source_path.clone(),
            models: self.models.clone(),
            loops: self.loops,
            timeout: self.timeout,
            enabled: self.enabled,
            category: self.category,
            source: match self.source {
                PromptSource::BuiltIn => StrategySource::BuiltIn,
                PromptSource::Project(_) => StrategySource::ProjectPrompt,
            },
        }
    }

    pub fn render(&self, context: &PromptRenderContext) -> Result<String, PromptError> {
        render_template(&self.body, context)
    }
}

#[derive(Clone, Debug, Default)]
pub struct PromptRegistry {
    prompts: BTreeMap<PromptId, PromptTemplate>,
}

impl PromptRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn built_in() -> Result<Self, PromptError> {
        let mut registry = Self::new();
        for asset in BUILT_IN_STRATEGY_PROMPTS {
            registry.insert_or_replace(parse_strategy_prompt(
                asset.markdown,
                ParseDefaults {
                    id: asset.strategy.id().to_owned(),
                    display_name: asset.strategy.display_name().to_owned(),
                    category: Some(asset.strategy.category()),
                    source: PromptSource::BuiltIn,
                    source_path: PathBuf::from("prompts")
                        .join("strategies")
                        .join(asset.strategy.prompt_file_name()),
                    default_loops: 1,
                    default_enabled: true,
                    default_timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
                },
            )?);
        }
        Ok(registry)
    }

    pub fn load_for_project(repo_root: impl AsRef<Path>) -> Result<Self, PromptError> {
        let repo_root = repo_root.as_ref();
        let mut registry = Self::built_in()?;
        registry.overlay_project_prompt_dir(repo_root.join(PROJECT_PROMPT_DIR))?;
        Ok(registry)
    }

    pub fn register(&mut self, prompt: PromptTemplate) -> Option<PromptTemplate> {
        self.prompts.insert(prompt.id.clone(), prompt)
    }

    pub fn try_register(&mut self, prompt: PromptTemplate) -> Result<(), PromptError> {
        if self.prompts.contains_key(&prompt.id) {
            return Err(PromptError::DuplicateStrategyId {
                id: prompt.strategy_id.to_string(),
                path: prompt.source_path,
            });
        }
        self.prompts.insert(prompt.id.clone(), prompt);
        Ok(())
    }

    pub fn insert_or_replace(&mut self, prompt: PromptTemplate) {
        self.prompts.insert(prompt.id.clone(), prompt);
    }

    pub fn overlay_project_prompt_dir(&mut self, dir: impl AsRef<Path>) -> Result<(), PromptError> {
        let dir = dir.as_ref();
        if !dir.exists() {
            return Ok(());
        }
        if !dir.is_dir() {
            return Err(PromptError::NotDirectory(dir.to_path_buf()));
        }

        let entries = discover_markdown_files(dir)?;

        let mut seen_project_prompts = BTreeMap::<StrategyId, PromptTemplate>::new();
        for path in entries {
            let markdown = fs::read_to_string(&path)?;
            let fallback_id = strategy_id_from_path(&path)?;
            if !is_strategy_definition_prompt(&markdown, &fallback_id)? {
                continue;
            }
            let built_in = BuiltInStrategy::from_id(&fallback_id);
            let prompt = parse_strategy_prompt(
                &markdown,
                ParseDefaults {
                    id: fallback_id.clone(),
                    display_name: built_in
                        .map(BuiltInStrategy::display_name)
                        .map(str::to_owned)
                        .unwrap_or_else(|| title_from_slug(&fallback_id)),
                    category: None,
                    source: PromptSource::Project(path.clone()),
                    source_path: path,
                    default_loops: 1,
                    default_enabled: true,
                    default_timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
                },
            )?;

            if let Some(previous) = seen_project_prompts.get(&prompt.strategy_id) {
                if previous.body == prompt.body
                    && previous.display_name == prompt.display_name
                    && previous.category == prompt.category
                    && previous.loops == prompt.loops
                    && previous.enabled == prompt.enabled
                    && previous.timeout == prompt.timeout
                {
                    continue;
                }
                return Err(PromptError::DuplicateStrategyId {
                    id: prompt.strategy_id.to_string(),
                    path: prompt.source_path,
                });
            }
            seen_project_prompts.insert(prompt.strategy_id.clone(), prompt.clone());
            self.insert_or_replace(prompt);
        }

        Ok(())
    }

    pub fn get(&self, id: &PromptId) -> Option<&PromptTemplate> {
        self.prompts.get(id)
    }

    pub fn templates(&self) -> impl Iterator<Item = &PromptTemplate> {
        self.prompts.values()
    }

    pub fn strategy_definitions(&self) -> Vec<StrategyDefinition> {
        self.prompts
            .values()
            .map(PromptTemplate::strategy_definition)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.prompts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.prompts.is_empty()
    }
}

fn is_strategy_definition_prompt(markdown: &str, fallback_id: &str) -> Result<bool, PromptError> {
    let document = parse_prompt_document(markdown)?;
    let id = document.frontmatter.id.as_deref().unwrap_or(fallback_id);
    Ok(BuiltInStrategy::from_id(id).is_some()
        || document.frontmatter.models.is_some()
        || document.frontmatter.loops.is_some()
        || document.frontmatter.enabled.is_some()
        || document.frontmatter.timeout_seconds.is_some())
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PromptRenderContext {
    variables: BTreeMap<String, String>,
}

impl PromptRenderContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.variables.insert(key.into(), value.into());
    }

    pub fn with(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.insert(key, value);
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactPathRenderContext {
    current: PathBuf,
    logical_nodes: BTreeMap<String, Vec<PathBuf>>,
    logical_handoffs: BTreeMap<String, Vec<PathBuf>>,
    direct_dependencies: Vec<String>,
    ancestor_required_artifacts: BTreeMap<String, Vec<PathBuf>>,
}

impl ArtifactPathRenderContext {
    pub fn new(current: impl Into<PathBuf>) -> Self {
        Self {
            current: current.into(),
            logical_nodes: BTreeMap::new(),
            logical_handoffs: BTreeMap::new(),
            direct_dependencies: Vec::new(),
            ancestor_required_artifacts: BTreeMap::new(),
        }
    }

    pub fn insert_logical_node(
        &mut self,
        logical_id: impl Into<String>,
        artifact_dirs: Vec<PathBuf>,
    ) {
        self.logical_nodes.insert(logical_id.into(), artifact_dirs);
    }

    pub fn insert_logical_handoff(
        &mut self,
        logical_id: impl Into<String>,
        artifact_paths: Vec<PathBuf>,
    ) {
        self.logical_handoffs
            .insert(logical_id.into(), artifact_paths);
    }

    pub fn set_direct_dependencies(&mut self, logical_ids: Vec<String>) {
        self.direct_dependencies = logical_ids;
    }

    pub fn insert_ancestor_required_artifacts(
        &mut self,
        logical_id: impl Into<String>,
        required_artifacts: Vec<PathBuf>,
    ) {
        self.ancestor_required_artifacts
            .insert(logical_id.into(), required_artifacts);
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum PromptArtifactPathProducer {
    Current,
    LogicalNode(String),
    Handoff(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptArtifactPathReference {
    pub variable: String,
    pub producer: PromptArtifactPathProducer,
    pub path: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PromptAncestorArtifactsSelector {
    DirectDependencies,
    Producers(Vec<String>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptAncestorArtifactsReference {
    pub variable: String,
    pub selector: PromptAncestorArtifactsSelector,
}

pub fn supported_template_render_context() -> PromptRenderContext {
    SUPPORTED_TEMPLATE_VARIABLES.into_iter().fold(
        PromptRenderContext::new(),
        |mut context, variable| {
            context.insert(variable, format!("<{variable}>"));
            context
        },
    )
}

pub fn validate_supported_template_variables(template: &str) -> Result<(), PromptError> {
    for occurrence in template_variable_occurrences(template)? {
        validate_supported_template_variable_name(&occurrence.name)?;
        if let Some(producer) = prompt_artifact_path_producer(&occurrence.name)? {
            artifact_reference_suffix(&producer, &template[occurrence.end..])?;
        }
        if prompt_ancestor_artifacts_selector(&occurrence.name)?.is_some() {
            validate_no_ancestor_artifacts_suffix(&template[occurrence.end..])?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct StrategyPromptFrontmatter {
    pub id: Option<String>,
    pub display_name: Option<String>,
    pub models: Option<Vec<ModelProfileId>>,
    pub loops: Option<usize>,
    pub enabled: Option<bool>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedPromptDocument {
    pub frontmatter: StrategyPromptFrontmatter,
    pub body: String,
}

pub fn parse_prompt_document(markdown: &str) -> Result<ParsedPromptDocument, PromptError> {
    let Some(rest) = markdown.strip_prefix("---") else {
        return Ok(ParsedPromptDocument {
            frontmatter: StrategyPromptFrontmatter::default(),
            body: markdown.to_owned(),
        });
    };

    let Some(rest) = rest
        .strip_prefix('\n')
        .or_else(|| rest.strip_prefix("\r\n"))
    else {
        return Ok(ParsedPromptDocument {
            frontmatter: StrategyPromptFrontmatter::default(),
            body: markdown.to_owned(),
        });
    };

    let mut yaml = Vec::new();
    let mut body = Vec::new();
    let mut in_frontmatter = true;
    let mut closed = false;

    for line in rest.split_inclusive('\n') {
        if in_frontmatter && line.trim_end_matches(['\r', '\n']) == "---" {
            in_frontmatter = false;
            closed = true;
            continue;
        }

        if in_frontmatter {
            yaml.push(line);
        } else {
            body.push(line);
        }
    }

    if !closed {
        return Err(PromptError::UnclosedFrontmatter);
    }

    let frontmatter = if yaml.is_empty() {
        StrategyPromptFrontmatter::default()
    } else {
        let value = serde_yaml::from_str::<serde_yaml::Value>(&yaml.concat())?;
        reject_removed_category_frontmatter(&value)?;
        serde_yaml::from_value::<StrategyPromptFrontmatter>(value)?
    };

    Ok(ParsedPromptDocument {
        frontmatter,
        body: body.concat(),
    })
}

pub fn built_in_strategy_prompt_ids() -> Vec<PromptId> {
    BuiltInStrategy::ALL
        .into_iter()
        .map(|strategy| PromptId::from(strategy.id()))
        .collect()
}

pub fn project_prompt_dir(repo_root: impl AsRef<Path>) -> PathBuf {
    repo_root.as_ref().join(PROJECT_PROMPT_DIR)
}

pub fn topology_prompt_markdown(relative_path: impl AsRef<Path>) -> Option<&'static str> {
    let relative_path = relative_path.as_ref();
    PROJECT_TOPOLOGY_PROMPTS
        .iter()
        .find(|asset| Path::new(asset.relative_path) == relative_path)
        .map(|asset| asset.markdown)
}

pub fn scaffold_project_prompts(
    repo_root: impl AsRef<Path>,
    force: bool,
) -> Result<PromptScaffoldReport, PromptError> {
    let repo_root = repo_root.as_ref();
    let prompt_dir = repo_root.join(PROJECT_PROMPT_DIR);
    let prompt_dir_relative = Path::new(PROJECT_PROMPT_DIR);
    ensure_no_prompt_symlink_components(repo_root, prompt_dir_relative)?;
    fs::create_dir_all(&prompt_dir)?;
    ensure_no_prompt_symlink_components(repo_root, prompt_dir_relative)?;
    preflight_scaffold_prompt_assets(repo_root)?;

    let mut written = Vec::new();
    let mut skipped = Vec::new();
    for asset in PROJECT_TOPOLOGY_PROMPTS.iter().copied() {
        scaffold_prompt_asset(
            repo_root,
            &prompt_dir,
            asset,
            force,
            &mut written,
            &mut skipped,
        )?;
    }

    Ok(PromptScaffoldReport { written, skipped })
}

fn preflight_scaffold_prompt_assets(repo_root: &Path) -> Result<(), PromptError> {
    for asset in PROJECT_TOPOLOGY_PROMPTS.iter().copied() {
        let relative_path = scaffold_prompt_asset_relative_path(asset)?;
        let scaffold_relative_path = Path::new(PROJECT_PROMPT_DIR).join(relative_path);
        ensure_no_prompt_symlink_components(repo_root, &scaffold_relative_path)?;
    }
    Ok(())
}

fn scaffold_prompt_asset(
    repo_root: &Path,
    prompt_dir: &Path,
    asset: ScaffoldPromptAsset,
    force: bool,
    written: &mut Vec<PathBuf>,
    skipped: &mut Vec<PathBuf>,
) -> Result<(), PromptError> {
    let relative_path = scaffold_prompt_asset_relative_path(asset)?;
    let scaffold_relative_path = Path::new(PROJECT_PROMPT_DIR).join(relative_path);
    let path = prompt_dir.join(relative_path);
    ensure_no_prompt_symlink_components(repo_root, &scaffold_relative_path)?;
    if path.exists() && !force {
        skipped.push(path);
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        let parent_relative_path = scaffold_relative_path
            .parent()
            .expect("scaffolded prompt path has a parent under the prompt dir");
        ensure_no_prompt_symlink_components(repo_root, parent_relative_path)?;
    }
    ensure_no_prompt_symlink_components(repo_root, &scaffold_relative_path)?;
    fs::write(&path, asset.markdown)?;
    written.push(path);
    Ok(())
}

fn scaffold_prompt_asset_relative_path(
    asset: ScaffoldPromptAsset,
) -> Result<&'static Path, PromptError> {
    let relative_path = Path::new(asset.relative_path);
    if relative_path.as_os_str().is_empty() || relative_path.is_absolute() {
        return Err(PromptError::InvalidPromptPath(relative_path.to_path_buf()));
    }
    for component in relative_path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(PromptError::InvalidPromptPath(relative_path.to_path_buf()));
        }
    }
    Ok(relative_path)
}

fn ensure_no_prompt_symlink_components(
    repo_root: &Path,
    relative_path: &Path,
) -> Result<(), PromptError> {
    if relative_path.as_os_str().is_empty() || relative_path.is_absolute() {
        return Err(PromptError::InvalidPromptPath(relative_path.to_path_buf()));
    }

    let mut current = repo_root.to_path_buf();
    for component in relative_path.components() {
        match component {
            Component::Normal(_) => current.push(component.as_os_str()),
            _ => return Err(PromptError::InvalidPromptPath(relative_path.to_path_buf())),
        }

        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(PromptError::SymlinkPromptPath(current));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(PromptError::Io(error)),
        }
    }

    Ok(())
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PromptScaffoldReport {
    pub written: Vec<PathBuf>,
    pub skipped: Vec<PathBuf>,
}

pub fn render_template(
    template: &str,
    context: &PromptRenderContext,
) -> Result<String, PromptError> {
    let mut rendered = String::with_capacity(template.len());
    let mut remaining = template;

    while let Some(start) = remaining.find("{{") {
        rendered.push_str(&remaining[..start]);
        let after_start = &remaining[start + 2..];
        let Some(end) = after_start.find("}}") else {
            return Err(PromptError::UnclosedTemplateVariable);
        };
        let name = after_start[..end].trim();
        if name.is_empty() {
            return Err(PromptError::EmptyTemplateVariable);
        }
        let Some(value) = context.variables.get(name) else {
            return Err(PromptError::MissingTemplateVariable(name.to_owned()));
        };
        rendered.push_str(value);
        remaining = &after_start[end + 2..];
    }

    rendered.push_str(remaining);
    Ok(rendered)
}

pub fn render_template_with_artifact_paths(
    template: &str,
    context: &PromptRenderContext,
    artifact_context: &ArtifactPathRenderContext,
) -> Result<String, PromptError> {
    let mut rendered = String::with_capacity(template.len());
    let mut remaining = template;
    let mut consumed = 0;

    while let Some(start) = remaining.find("{{") {
        rendered.push_str(&remaining[..start]);
        let after_start = &remaining[start + 2..];
        let Some(end) = after_start.find("}}") else {
            return Err(PromptError::UnclosedTemplateVariable);
        };
        let name = after_start[..end].trim();
        if name.is_empty() {
            return Err(PromptError::EmptyTemplateVariable);
        }

        let after_variable_offset = consumed + start + 2 + end + 2;
        let after_variable = &template[after_variable_offset..];
        if let Some(producer) = prompt_artifact_path_producer(name)? {
            let (suffix, suffix_bytes) = artifact_reference_suffix(&producer, after_variable)?;
            render_artifact_path_reference(
                &mut rendered,
                &producer,
                suffix.as_deref(),
                artifact_context,
            )?;
            consumed = after_variable_offset + suffix_bytes;
            remaining = &template[consumed..];
            continue;
        }
        if let Some(selector) = prompt_ancestor_artifacts_selector(name)? {
            validate_no_ancestor_artifacts_suffix(after_variable)?;
            render_ancestor_artifacts_reference(&mut rendered, &selector, artifact_context)?;
            consumed = after_variable_offset;
            remaining = &template[consumed..];
            continue;
        }

        let Some(value) = context.variables.get(name) else {
            return Err(PromptError::MissingTemplateVariable(name.to_owned()));
        };
        rendered.push_str(value);
        consumed = after_variable_offset;
        remaining = &template[consumed..];
    }

    rendered.push_str(remaining);
    Ok(rendered)
}

pub fn extract_prompt_artifact_path_references(
    template: &str,
) -> Result<Vec<PromptArtifactPathReference>, PromptError> {
    let mut references = Vec::new();
    for occurrence in template_variable_occurrences(template)? {
        let Some(producer) = prompt_artifact_path_producer(&occurrence.name)? else {
            continue;
        };
        let (path, _) = artifact_reference_suffix(&producer, &template[occurrence.end..])?;
        references.push(PromptArtifactPathReference {
            variable: occurrence.name,
            producer,
            path,
        });
    }
    Ok(references)
}

pub fn extract_prompt_ancestor_artifact_references(
    template: &str,
) -> Result<Vec<PromptAncestorArtifactsReference>, PromptError> {
    let mut references = Vec::new();
    for occurrence in template_variable_occurrences(template)? {
        let Some(selector) = prompt_ancestor_artifacts_selector(&occurrence.name)? else {
            continue;
        };
        validate_no_ancestor_artifacts_suffix(&template[occurrence.end..])?;
        references.push(PromptAncestorArtifactsReference {
            variable: occurrence.name,
            selector,
        });
    }
    Ok(references)
}

pub fn prompt_artifact_output_paths(template: &str) -> Result<Vec<PathBuf>, PromptError> {
    let mut outputs = Vec::new();
    for reference in extract_prompt_artifact_path_references(template)? {
        if reference.producer == PromptArtifactPathProducer::Current {
            if let Some(path) = reference.path {
                if !outputs.contains(&path) {
                    outputs.push(path);
                }
            }
        }
    }
    Ok(outputs)
}

fn rewrite_artifact_path_segment(
    segment: &str,
    old_logical_id: &str,
    new_logical_id: &str,
) -> String {
    if segment == old_logical_id {
        return new_logical_id.to_owned();
    }
    if let Some((stem, extension)) = segment.rsplit_once('.') {
        if !extension.is_empty() && stem == old_logical_id {
            return format!("{new_logical_id}.{extension}");
        }
    }
    segment.to_owned()
}

fn rewrite_artifact_path_suffix(
    suffix: &str,
    old_logical_id: &str,
    new_logical_id: &str,
) -> (String, usize) {
    if !suffix.starts_with('/') {
        return (String::new(), 0);
    }
    let end = suffix
        .find(|ch: char| artifact_path_suffix_terminator(ch))
        .unwrap_or(suffix.len());
    let path = &suffix[..end];
    let rewritten = path
        .split('/')
        .map(|segment| rewrite_artifact_path_segment(segment, old_logical_id, new_logical_id))
        .collect::<Vec<_>>()
        .join("/");
    (rewritten, end)
}

pub fn rename_prompt_artifact_path_references(
    template: &str,
    old_logical_id: &str,
    new_logical_id: &str,
) -> Result<String, PromptError> {
    validate_artifact_reference_node_id(old_logical_id)?;
    validate_artifact_reference_node_id(new_logical_id)?;

    let old_variable = format!("artifact_path:{old_logical_id}");
    let new_variable = format!("artifact_path:{new_logical_id}");
    let old_handoff_variable = format!("artifact_handoff:{old_logical_id}");
    let new_handoff_variable = format!("artifact_handoff:{new_logical_id}");
    let mut rewritten = String::with_capacity(template.len());
    let mut remaining = template;

    while let Some(start) = remaining.find("{{") {
        rewritten.push_str(&remaining[..start]);
        let after_start = &remaining[start + 2..];
        let Some(end) = after_start.find("}}") else {
            return Err(PromptError::UnclosedTemplateVariable);
        };
        let raw_name = &after_start[..end];
        let name = raw_name.trim();
        if name.is_empty() {
            return Err(PromptError::EmptyTemplateVariable);
        }
        let replacement = if name == old_variable {
            Some(new_variable.as_str())
        } else if name == old_handoff_variable {
            Some(new_handoff_variable.as_str())
        } else {
            None
        };
        if let Some(replacement) = replacement {
            let leading_whitespace = raw_name.len() - raw_name.trim_start().len();
            let trailing_whitespace = raw_name.len() - raw_name.trim_end().len();
            rewritten.push_str("{{");
            rewritten.push_str(&raw_name[..leading_whitespace]);
            rewritten.push_str(replacement);
            rewritten.push_str(&raw_name[raw_name.len() - trailing_whitespace..]);
            rewritten.push_str("}}");
        } else if let Some(selector) = prompt_ancestor_artifacts_selector(name)? {
            let PromptAncestorArtifactsSelector::Producers(producers) = selector else {
                rewritten.push_str("{{");
                rewritten.push_str(raw_name);
                rewritten.push_str("}}");
                remaining = &after_start[end + 2..];
                continue;
            };
            let leading_whitespace = raw_name.len() - raw_name.trim_start().len();
            let trailing_whitespace = raw_name.len() - raw_name.trim_end().len();
            let rewritten_producers = producers
                .into_iter()
                .map(|producer| {
                    if producer == old_logical_id {
                        new_logical_id.to_owned()
                    } else {
                        producer
                    }
                })
                .collect::<Vec<_>>()
                .join(",");
            rewritten.push_str("{{");
            rewritten.push_str(&raw_name[..leading_whitespace]);
            rewritten.push_str("ancestor_artifacts:");
            rewritten.push_str(&rewritten_producers);
            rewritten.push_str(&raw_name[raw_name.len() - trailing_whitespace..]);
            rewritten.push_str("}}");
        } else {
            rewritten.push_str("{{");
            rewritten.push_str(raw_name);
            rewritten.push_str("}}");
        }
        remaining = &after_start[end + 2..];
        if name == "artifact_path" || name == old_variable {
            let (path_rewrite, consumed) =
                rewrite_artifact_path_suffix(remaining, old_logical_id, new_logical_id);
            if consumed > 0 {
                rewritten.push_str(&path_rewrite);
                remaining = &remaining[consumed..];
            }
        }
    }

    rewritten.push_str(remaining);
    Ok(rewritten)
}

pub fn validate_prompt_artifact_relative_path(path: &Path) -> Result<(), PromptError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(PromptError::InvalidArtifactReferencePath(
            path.to_path_buf(),
        ));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(PromptError::InvalidArtifactReferencePath(
                    path.to_path_buf(),
                ))
            }
        }
    }
    Ok(())
}

pub fn render_and_write_prompt(
    template: &PromptTemplate,
    context: &PromptRenderContext,
    artifact_dir: impl AsRef<Path>,
) -> Result<PathBuf, PromptError> {
    let artifact_dir = artifact_dir.as_ref();
    fs::create_dir_all(artifact_dir)?;
    let path = artifact_dir.join(RENDERED_PROMPT_FILE);
    let rendered = template.render(context)?;
    fs::write(&path, rendered)?;
    Ok(path)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TemplateVariableOccurrence {
    name: String,
    end: usize,
}

fn template_variable_occurrences(
    template: &str,
) -> Result<Vec<TemplateVariableOccurrence>, PromptError> {
    let mut occurrences = Vec::new();
    let mut offset = 0;

    while let Some(start) = template[offset..].find("{{") {
        let start = offset + start;
        let after_start = start + 2;
        let Some(end) = template[after_start..].find("}}") else {
            return Err(PromptError::UnclosedTemplateVariable);
        };
        let end = after_start + end;
        let name = template[after_start..end].trim();
        if name.is_empty() {
            return Err(PromptError::EmptyTemplateVariable);
        }
        occurrences.push(TemplateVariableOccurrence {
            name: name.to_owned(),
            end: end + 2,
        });
        offset = end + 2;
    }

    Ok(occurrences)
}

fn validate_supported_template_variable_name(name: &str) -> Result<(), PromptError> {
    if SUPPORTED_TEMPLATE_VARIABLES.contains(&name) {
        return Ok(());
    }
    if prompt_artifact_path_producer(name)?.is_some() {
        return Ok(());
    }
    if prompt_ancestor_artifacts_selector(name)?.is_some() {
        return Ok(());
    }
    Err(PromptError::MissingTemplateVariable(name.to_owned()))
}

fn prompt_artifact_path_producer(
    variable: &str,
) -> Result<Option<PromptArtifactPathProducer>, PromptError> {
    if variable == "artifact_path" || variable == "artifact_dir" {
        return Ok(Some(PromptArtifactPathProducer::Current));
    }
    if let Some(logical_id) = variable.strip_prefix("artifact_handoff:") {
        validate_artifact_reference_node_id(logical_id)?;
        return Ok(Some(PromptArtifactPathProducer::Handoff(
            logical_id.to_owned(),
        )));
    }
    let Some(logical_id) = variable.strip_prefix("artifact_path:") else {
        return Ok(None);
    };
    validate_artifact_reference_node_id(logical_id)?;
    Ok(Some(PromptArtifactPathProducer::LogicalNode(
        logical_id.to_owned(),
    )))
}

fn prompt_ancestor_artifacts_selector(
    variable: &str,
) -> Result<Option<PromptAncestorArtifactsSelector>, PromptError> {
    if variable == "ancestor_artifacts" {
        return Ok(Some(PromptAncestorArtifactsSelector::DirectDependencies));
    }
    let Some(raw_producers) = variable.strip_prefix("ancestor_artifacts:") else {
        return Ok(None);
    };

    let mut producers = Vec::new();
    let mut seen = BTreeSet::new();
    for raw_producer in raw_producers.split(',') {
        let producer = raw_producer.trim();
        if producer.is_empty() || !is_valid_artifact_reference_node_id(producer) {
            return Err(PromptError::InvalidAncestorArtifactsTarget(
                producer.to_owned(),
            ));
        }
        if !seen.insert(producer.to_owned()) {
            return Err(PromptError::DuplicateAncestorArtifactsTarget(
                producer.to_owned(),
            ));
        }
        producers.push(producer.to_owned());
    }
    if producers.is_empty() {
        return Err(PromptError::InvalidAncestorArtifactsTarget(
            raw_producers.to_owned(),
        ));
    }
    Ok(Some(PromptAncestorArtifactsSelector::Producers(producers)))
}

fn validate_artifact_reference_node_id(value: &str) -> Result<(), PromptError> {
    if is_valid_artifact_reference_node_id(value) {
        Ok(())
    } else {
        Err(PromptError::InvalidArtifactReferenceTarget(
            value.to_owned(),
        ))
    }
}

fn is_valid_artifact_reference_node_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'))
}

fn artifact_reference_suffix(
    producer: &PromptArtifactPathProducer,
    after_variable: &str,
) -> Result<(Option<PathBuf>, usize), PromptError> {
    match producer {
        PromptArtifactPathProducer::Current | PromptArtifactPathProducer::LogicalNode(_) => {
            artifact_path_suffix(after_variable)
        }
        PromptArtifactPathProducer::Handoff(_) => {
            validate_no_artifact_handoff_suffix(after_variable)?;
            Ok((None, 0))
        }
    }
}

fn artifact_path_suffix(after_variable: &str) -> Result<(Option<PathBuf>, usize), PromptError> {
    if !after_variable.starts_with('/') {
        return Ok((None, 0));
    }

    let raw = &after_variable[1..];
    let mut token_end = raw.len();
    for (index, ch) in raw.char_indices() {
        if artifact_path_suffix_terminator(ch) {
            token_end = index;
            break;
        }
    }

    let token = &raw[..token_end];
    let trimmed = token.trim_end_matches(['.', ',', ';', ':', '!', '?']);
    if trimmed.is_empty() {
        return Ok((None, 1));
    }

    let path = PathBuf::from(trimmed);
    validate_prompt_artifact_relative_path(&path)?;
    Ok((Some(path), 1 + trimmed.len()))
}

fn validate_no_ancestor_artifacts_suffix(after_variable: &str) -> Result<(), PromptError> {
    if after_variable.starts_with('/') {
        return Err(PromptError::InvalidAncestorArtifactsSuffix);
    }
    Ok(())
}

fn artifact_path_suffix_terminator(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
        )
}

fn validate_no_artifact_handoff_suffix(after_variable: &str) -> Result<(), PromptError> {
    if !after_variable.starts_with('/') {
        return Ok(());
    }
    let raw = &after_variable[1..];
    let suffix_end = raw
        .char_indices()
        .find_map(|(index, ch)| artifact_path_suffix_terminator(ch).then_some(index))
        .unwrap_or(raw.len());
    Err(PromptError::InvalidArtifactHandoffSuffix(
        after_variable[..1 + suffix_end].to_owned(),
    ))
}

fn render_artifact_path_reference(
    rendered: &mut String,
    producer: &PromptArtifactPathProducer,
    suffix: Option<&Path>,
    artifact_context: &ArtifactPathRenderContext,
) -> Result<(), PromptError> {
    let paths = match producer {
        PromptArtifactPathProducer::Current => vec![artifact_context.current.clone()],
        PromptArtifactPathProducer::LogicalNode(logical_id) => artifact_context
            .logical_nodes
            .get(logical_id)
            .cloned()
            .ok_or(PromptError::MissingTemplateVariable(format!(
                "artifact_path:{logical_id}"
            )))?,
        PromptArtifactPathProducer::Handoff(logical_id) => artifact_context
            .logical_handoffs
            .get(logical_id)
            .cloned()
            .ok_or(PromptError::MissingTemplateVariable(format!(
                "artifact_handoff:{logical_id}"
            )))?,
    };
    if paths.is_empty() {
        let variable = match producer {
            PromptArtifactPathProducer::Current => "artifact_path".to_owned(),
            PromptArtifactPathProducer::LogicalNode(logical_id) => {
                format!("artifact_path:{logical_id}")
            }
            PromptArtifactPathProducer::Handoff(logical_id) => {
                format!("artifact_handoff:{logical_id}")
            }
        };
        return Err(PromptError::MissingTemplateVariable(variable));
    }
    if paths.len() == 1 {
        rendered.push_str(&join_artifact_path(&paths[0], suffix).display().to_string());
        return Ok(());
    }
    rendered.push_str(
        &paths
            .iter()
            .map(|path| format!("- {}", join_artifact_path(path, suffix).display()))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    Ok(())
}

fn render_ancestor_artifacts_reference(
    rendered: &mut String,
    selector: &PromptAncestorArtifactsSelector,
    artifact_context: &ArtifactPathRenderContext,
) -> Result<(), PromptError> {
    let producers = match selector {
        PromptAncestorArtifactsSelector::DirectDependencies => {
            artifact_context.direct_dependencies.clone()
        }
        PromptAncestorArtifactsSelector::Producers(producers) => producers.clone(),
    };
    if producers.is_empty() {
        return Err(PromptError::MissingTemplateVariable(
            "ancestor_artifacts".to_owned(),
        ));
    }

    let mut entries = Vec::new();
    for producer in producers {
        let dirs = artifact_context
            .logical_nodes
            .get(&producer)
            .ok_or_else(|| {
                PromptError::MissingTemplateVariable(format!("ancestor_artifacts:{producer}"))
            })?;
        if dirs.is_empty() {
            return Err(PromptError::MissingTemplateVariable(format!(
                "ancestor_artifacts:{producer}"
            )));
        }
        let required_artifacts = artifact_context
            .ancestor_required_artifacts
            .get(&producer)
            .filter(|paths| !paths.is_empty())
            .ok_or_else(|| {
                PromptError::MissingTemplateVariable(format!("ancestor_artifacts:{producer}"))
            })?;
        for artifact in required_artifacts {
            validate_prompt_artifact_relative_path(artifact)?;
        }
        for dir in dirs {
            for artifact in required_artifacts {
                entries.push(format!("- {}", dir.join(artifact).display()));
            }
        }
    }

    if entries.is_empty() {
        return Err(PromptError::MissingTemplateVariable(
            "ancestor_artifacts".to_owned(),
        ));
    }
    rendered.push_str(&entries.join("\n"));
    Ok(())
}

fn join_artifact_path(base: &Path, suffix: Option<&Path>) -> PathBuf {
    match suffix {
        Some(suffix) => base.join(suffix),
        None => base.to_path_buf(),
    }
}

struct ParseDefaults {
    id: String,
    display_name: String,
    category: Option<StrategyCategory>,
    source: PromptSource,
    source_path: PathBuf,
    default_loops: usize,
    default_enabled: bool,
    default_timeout_seconds: u64,
}

fn parse_strategy_prompt(
    markdown: &str,
    defaults: ParseDefaults,
) -> Result<PromptTemplate, PromptError> {
    let document = parse_prompt_document(markdown)?;
    let id = document
        .frontmatter
        .id
        .as_deref()
        .map(slugify_strategy_id)
        .unwrap_or(defaults.id);
    if id.is_empty() {
        return Err(PromptError::InvalidFrontmatter(
            "strategy id cannot be empty".to_owned(),
        ));
    }

    let loops = document.frontmatter.loops.unwrap_or(defaults.default_loops);
    if loops == 0 {
        return Err(PromptError::InvalidFrontmatter(
            "strategy loops must be greater than zero".to_owned(),
        ));
    }
    if document
        .frontmatter
        .models
        .as_ref()
        .is_some_and(Vec::is_empty)
    {
        return Err(PromptError::InvalidFrontmatter(
            "strategy models list cannot be empty".to_owned(),
        ));
    }
    let models = document.frontmatter.models.unwrap_or_default();

    let timeout_seconds = document
        .frontmatter
        .timeout_seconds
        .unwrap_or(defaults.default_timeout_seconds);
    if timeout_seconds == 0 {
        return Err(PromptError::InvalidFrontmatter(
            "timeout_seconds must be greater than zero".to_owned(),
        ));
    }

    let category = defaults
        .category
        .unwrap_or_else(|| default_category_for_strategy_id(&id));

    Ok(PromptTemplate {
        id: PromptId::from(id.clone()),
        strategy_id: StrategyId::from(id),
        source: defaults.source,
        source_path: defaults.source_path,
        display_name: document
            .frontmatter
            .display_name
            .unwrap_or(defaults.display_name),
        category,
        models,
        loops,
        enabled: document
            .frontmatter
            .enabled
            .unwrap_or(defaults.default_enabled),
        timeout: Duration::from_secs(timeout_seconds),
        body: document.body,
    })
}

fn strategy_id_from_path(path: &Path) -> Result<String, PromptError> {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| PromptError::InvalidPromptPath(path.to_path_buf()))?;
    Ok(slugify_strategy_id(stem))
}

fn reject_removed_category_frontmatter(value: &serde_yaml::Value) -> Result<(), PromptError> {
    let serde_yaml::Value::Mapping(mapping) = value else {
        return Ok(());
    };
    if mapping.contains_key(serde_yaml::Value::String("category".to_owned())) {
        return Err(PromptError::InvalidFrontmatter(
            "`category` is no longer supported in prompt frontmatter".to_owned(),
        ));
    }
    Ok(())
}

fn default_category_for_strategy_id(id: &str) -> StrategyCategory {
    BuiltInStrategy::from_id(id)
        .map(BuiltInStrategy::category)
        .or_else(|| is_stateful_invariant_subbox_id(id).then_some(StrategyCategory::Invariant))
        .or_else(|| {
            PROPERTY_BASED_TOPOLOGY_STRATEGY_IDS
                .contains(&id)
                .then_some(StrategyCategory::PropertyBased)
        })
        .unwrap_or(StrategyCategory::Custom)
}

fn discover_markdown_files(dir: &Path) -> Result<Vec<PathBuf>, PromptError> {
    let mut paths = Vec::new();
    collect_markdown_files(dir, &mut paths)?;
    paths.sort();
    Ok(paths)
}

fn collect_markdown_files(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<(), PromptError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_markdown_files(&path, paths)?;
        } else if file_type.is_file() && path.extension().is_some_and(|ext| ext == "md") {
            paths.push(path);
        }
    }
    Ok(())
}

fn slugify_strategy_id(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if (ch == '-' || ch == '_' || ch.is_whitespace()) && !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    slug.trim_matches('-').to_owned()
}

fn title_from_slug(slug: &str) -> String {
    slug.split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Error)]
pub enum PromptError {
    #[error("prompt I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid prompt YAML frontmatter: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("frontmatter block is missing a closing delimiter")]
    UnclosedFrontmatter,
    #[error("template variable is missing a closing delimiter")]
    UnclosedTemplateVariable,
    #[error("template variable name cannot be empty")]
    EmptyTemplateVariable,
    #[error("missing template variable: {0}")]
    MissingTemplateVariable(String),
    #[error("invalid artifact_path target `{0}`")]
    InvalidArtifactReferenceTarget(String),
    #[error("invalid artifact_path suffix `{0}`; paths must be relative and traversal-free")]
    InvalidArtifactReferencePath(PathBuf),
    #[error("invalid ancestor_artifacts target `{0}`")]
    InvalidAncestorArtifactsTarget(String),
    #[error("duplicate ancestor_artifacts target `{0}`")]
    DuplicateAncestorArtifactsTarget(String),
    #[error("ancestor_artifacts does not accept a path suffix; producer required_artifacts define the paths")]
    InvalidAncestorArtifactsSuffix,
    #[error("artifact_handoff references resolve to a file path and must not append suffix `{0}`")]
    InvalidArtifactHandoffSuffix(String),
    #[error("duplicate strategy id `{id}` discovered at {path}")]
    DuplicateStrategyId { id: String, path: PathBuf },
    #[error("prompt path is not a valid markdown path: {0}")]
    InvalidPromptPath(PathBuf),
    #[error(
        "refusing to scaffold prompts through symlink `{0}`; remove or replace the symlink and retry"
    )]
    SymlinkPromptPath(PathBuf),
    #[error("prompt discovery path is not a directory: {0}")]
    NotDirectory(PathBuf),
    #[error("invalid prompt frontmatter: {0}")]
    InvalidFrontmatter(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_registry_has_required_strategy_prompts() {
        let registry = PromptRegistry::built_in().unwrap();
        assert_eq!(registry.len(), BuiltInStrategy::ALL.len());
        for prompt_id in built_in_strategy_prompt_ids() {
            assert!(registry.get(&prompt_id).is_some());
        }
    }

    #[test]
    fn built_in_strategy_prompts_use_supported_template_variables() {
        let registry = PromptRegistry::built_in().unwrap();
        for prompt in registry.templates() {
            validate_supported_template_variables(&prompt.body).unwrap_or_else(|error| {
                panic!(
                    "built-in strategy prompt `{}` has invalid template variable: {error}",
                    prompt.source_path.display()
                )
            });
        }
    }

    #[test]
    fn bundled_topology_prompts_do_not_use_category_frontmatter() {
        for asset in PROJECT_TOPOLOGY_PROMPTS {
            assert!(
                !asset
                    .markdown
                    .lines()
                    .any(|line| line.trim_start().starts_with("category:")),
                "bundled prompt `{}` should not declare category frontmatter",
                asset.relative_path
            );
            let document = parse_prompt_document(asset.markdown).unwrap_or_else(|error| {
                panic!(
                    "bundled prompt `{}` should parse without category frontmatter: {error}",
                    asset.relative_path
                )
            });
            validate_supported_template_variables(&document.body).unwrap_or_else(|error| {
                panic!(
                    "bundled prompt `{}` has invalid template variable: {error}",
                    asset.relative_path
                )
            });
        }
    }

    #[test]
    fn boundary_prompt_uses_direct_validation_guidance() {
        let markdown = topology_prompt_markdown("strategies/boundary-tests.md")
            .expect("boundary prompt should be bundled");

        assert!(markdown.contains("The JSON should include `schema_version`"));
        assert!(markdown.contains("preferred downstream lane"));
        assert!(markdown.contains("one\n   direct workspace-relative command at a time"));
        assert!(markdown.contains("Do not pipe `grep` into"));
        assert!(markdown.contains("Validate JSON with one direct Bash call"));
        assert!(markdown.contains("Do not use command\nsubstitution"));
    }

    #[test]
    fn actors_flows_prompt_keeps_context_out_of_findings() {
        let markdown =
            topology_prompt_markdown("setup/actors-flows.md").expect("actors prompt is bundled");

        assert!(markdown.contains("Write `[]` to {{artifact_path}}/findings.json"));
        assert!(markdown.contains("Trust assumptions"));
        assert!(markdown.contains("privileged-role powers"));
        assert!(markdown.contains("design footguns"));
        assert!(markdown.contains("not in `findings.json`"));
    }

    #[test]
    fn differential_lane_prompts_resolve_foundry_binary() {
        let planner =
            topology_prompt_markdown("strategies/differential/differential-oracle-planner.md")
                .expect("differential planner prompt should be bundled");
        assert!(planner.contains("FOUNDRY_BIN"));
        assert!(planner.contains("Do not emit a bare `forge test"));
        assert!(planner.contains("Do not add"));
        assert!(planner.contains("`FOUNDRY_TEST=test` to project-native"));

        let auditor =
            topology_prompt_markdown("strategies/differential/reference-and-lane-auditor.md")
                .expect("differential lane auditor prompt should be bundled");
        assert!(auditor.contains("FOUNDRY_BIN"));
        assert!(auditor.contains("rewrite only"));
        assert!(auditor.contains("same test through the resolved binary"));
        assert!(auditor.contains("Do not add it to project-native test reruns"));

        let author =
            topology_prompt_markdown("strategies/differential/differential-lane-author.md")
                .expect("differential lane author prompt should be bundled");
        assert!(author.contains("FOUNDRY_BIN"));
        assert!(author.contains("payload's `focused_command` uses a bare `forge test"));
        assert!(author.contains("Keep the payload's existing environment variables"));
        assert!(author.contains("Do not record `forge: command not found`"));
    }

    #[test]
    fn dedupe_prompt_resolves_foundry_binary_before_counting_failures() {
        let markdown =
            topology_prompt_markdown("review/dedupe-findings.md").expect("dedupe prompt");

        assert!(markdown.contains("FOUNDRY_BIN"));
        assert!(markdown.contains("Do not run a bare `forge test"));
        assert!(markdown.contains("preserve the original command's environment\nvariables"));
        assert!(markdown.contains("Do not add\n`FOUNDRY_TEST=test` to project-native"));
        assert!(markdown.contains("Do not classify `forge: command not found`"));
        assert!(markdown.contains("count failing tests"));
    }

    #[test]
    fn triage_prompt_resolves_foundry_binary_before_rerunning_proofs() {
        let markdown = topology_prompt_markdown("review/triage.md").expect("triage prompt");

        assert!(markdown.contains("FOUNDRY_BIN"));
        assert!(markdown.contains("Do not run a bare `forge test"));
        assert!(markdown.contains("preserve the original command's environment variables"));
        assert!(markdown.contains("Do not add `FOUNDRY_TEST=test` to project-native"));
        assert!(markdown.contains("treat `forge: command not found` as a reproducer result"));
        assert!(markdown.contains("temporary public wrappers"));
    }

    #[test]
    fn setup_prompts_do_not_redirect_generated_strategy_tests() {
        let setup = topology_prompt_markdown("setup/prepare-foundry-harness.md")
            .expect("setup prompt should be bundled");
        assert!(setup.contains("canonical\n`test/foundry/<strategy>` tree"));
        assert!(setup.contains("Do not choose or document a different path"));
        assert!(setup.contains("shared fixture or import paths"));
        assert!(setup.contains(
            "generated strategy tests\nmust use the exact runtime strategy test directory"
        ));

        let base = topology_prompt_markdown("setup/discover-base-test.md")
            .expect("base-test prompt should be bundled");
        assert!(base.contains("record the import\npath downstream tests should use"));
        assert!(base.contains(
            "Do not describe that shared fixture location\nas the directory where later strategy agents should write generated tests"
        ));
        assert!(base.contains(
            "Ultrafuzz collects generated strategy tests from that runtime path under\n`test/foundry/<strategy>`"
        ));
    }

    #[test]
    fn review_prompts_include_helper_reachability_fixtures() {
        let triage =
            topology_prompt_markdown("review/triage.md").expect("triage prompt should be bundled");
        assert!(triage.contains("## Helper reachability audit"));
        assert!(triage.contains("Reachability fixture examples"));
        assert!(triage.contains("\"title\": \"Helper-only arithmetic mismatch\""));
        assert!(triage.contains("\"triage_classification\": \"harness-defect\""));
        assert!(triage.contains("\"status\": \"false-positive\""));
        assert!(triage.contains("reachability=helper-only"));
        assert!(triage.contains("\"title\": \"Public entrypoint reaches helper mismatch\""));
        assert!(triage.contains("reachability=public-entrypoint-trace"));
        assert!(triage.contains("helper_proof=direct helper mismatch reproduced"));
        assert!(triage.contains("public_exploitability=public entrypoint trace reproduces"));

        let severity = topology_prompt_markdown("review/severity-classification.md")
            .expect("severity classification prompt should be bundled");
        assert!(severity.contains("## Public reachability gate for helper-level findings"));
        assert!(severity.contains("reachability=helper-only"));
        assert!(severity.contains("reachability=public-entrypoint-trace"));
        assert!(severity.contains("reachability=generated-public-wrapper-poc"));
        assert!(severity.contains("reachability=public-wrapper-required"));
        assert!(severity.contains("helper_proof=<summary>"));
        assert!(severity.contains("public_exploitability=<summary>"));

        for prompt in [triage, severity] {
            assert!(!prompt.contains("legacy-target-specific"));
            assert!(!prompt.contains("~/legacy-target-contracts"));
        }
    }

    #[test]
    fn severity_prompt_uses_self_contained_rubric_examples() {
        let severity = topology_prompt_markdown("review/severity-classification.md")
            .expect("severity classification prompt should be bundled");

        assert!(!severity.contains("Code4rena"));
        assert!(severity.contains("sub agents with maximum reasoning capacity"));
        assert!(severity.contains("## Severity classification"));
        assert!(severity.contains("High: assets can be stolen, lost, locked, or compromised"));
        assert!(severity.contains("Medium: assets are not directly at risk"));
        assert!(severity.contains("Low: low-risk, QA, or informational cases"));
        assert!(severity.contains("Treat all QA, Low, and informational outcomes"));
        assert!(severity.contains("Treat Invalid and out-of-scope outcomes"));
        assert!(
            severity.contains("Non-standard ERC20 approve or transfer behavior is out of scope")
        );
        assert!(severity.contains("Non-standard and non-malicious approve or"));
        assert!(severity.contains("transfer ERC20 behavior is in scope"));
        assert!(!severity.contains("USDT"));
        assert!(!severity.contains("may be invalid"));
        assert!(severity.contains("Approve or safeApprove front-run races are not valid"));
        assert!(severity.contains("Set top-level `severity` to the final classified severity"));
        assert!(severity.contains("Also set `severity_guess` to the same value"));
        assert!(severity.contains("Do not carry an upstream"));

        assert!(severity.contains("\"title\": \"Public withdrawal path drains vault assets\""));
        assert!(severity.contains("\"severity\": \"high\""));
        assert!(severity.contains("\"severity_guess\": \"high\""));
        assert!(severity
            .contains("\"title\": \"Integration-specific accounting drift blocks redemptions\""));
        assert!(severity.contains("\"severity\": \"medium\""));
        assert!(severity.contains("\"severity_guess\": \"medium\""));
        assert!(severity.contains("\"title\": \"Rounding dust can be stranded\""));
        assert!(severity.contains("\"severity\": \"low\""));
        assert!(severity.contains("\"severity_guess\": \"low\""));
        assert!(
            severity.contains("\"title\": \"Unsupported fee-on-transfer token breaks accounting\"")
        );
        assert!(severity.contains("\"triage_classification\": \"false-positive\""));
        assert!(severity.contains("Do not include invalid or out-of-scope records"));
    }

    #[test]
    fn differential_library_prompt_hands_off_reachability_requirements() {
        let markdown = topology_prompt_markdown("strategies/differential-library-tests.md")
            .expect("differential library prompt should be bundled");

        assert!(markdown.contains("reachability=public-wrapper-required"));
        assert!(
            markdown.contains("lifecycle/read\nrequirements toward `lifecycle-view-boundaries`")
        );
        assert!(markdown
            .contains("market/exhaustion requirements\ntoward `market-exhaustion-boundaries`"));
        assert!(markdown
            .contains("broader user-flow requirements\ntoward `workflow-property-based-tests`"));
        assert!(markdown.contains("When narrowing a failing Forge test"));
        assert!(markdown.contains("Do not append `2>&1`, `| head`, `| tail`"));
        assert!(!markdown.contains("legacy-target-specific"));
    }

    #[test]
    fn coverage_prompt_uses_artifact_goal_not_backend_goal() {
        let markdown = topology_prompt_markdown("strategies/invariants/coverage.md")
            .expect("coverage prompt should be bundled");

        assert!(markdown.contains("{{artifact_dir}}/coverage-goal.json"));
        assert!(markdown.contains("Do not start a backend goal"));
        assert!(!markdown.contains("/goal"));
        assert!(!markdown.contains("backend supports"));
    }

    #[test]
    fn coverage_prompt_bounds_memory_heavy_recon_work() {
        let markdown = topology_prompt_markdown("strategies/invariants/coverage.md")
            .expect("coverage prompt should be bundled");

        assert!(markdown.contains("build-info or storage-layout"));
        assert!(markdown.contains("{{artifact_dir}}/coverage-report.md"));
        assert!(markdown.contains("{{artifact_dir}}/harness-repairs.json"));
        assert!(markdown.contains("Topology Runtime Context timeout"));
        assert!(markdown.contains("allowlisted\n  commands from the current workspace"));
        assert!(markdown.contains("shorter `timeout <duration>` wrapper"));
        assert!(markdown.contains("coverage-tooling-blocked"));
        assert!(markdown.contains("valid arrays"));
        assert!(markdown.contains("memory pressure"));
    }

    #[test]
    fn coverage_prompt_forbids_host_install_inspection() {
        let markdown = topology_prompt_markdown("strategies/invariants/coverage.md")
            .expect("coverage prompt should be bundled");

        assert!(markdown.contains("not a host\n  installation to inspect or repair"));
        assert!(markdown.contains("Do not inspect `$PATH`, wrapper scripts"));
        assert!(markdown.contains("/home/.../.local/bin"));
        assert!(markdown.contains("record `coverage-tooling-blocked` from the command"));
        assert!(markdown.contains("do not inspect or repair\n  the global install"));
    }

    #[test]
    fn coverage_prompt_avoids_unallowlisted_tool_wrappers() {
        let markdown = topology_prompt_markdown("strategies/invariants/coverage.md")
            .expect("coverage prompt should be bundled");

        assert!(markdown.contains("commands that start with an allowlisted executable"));
        assert!(markdown.contains("Do not\n  probe `lcov` as a standalone CLI"));
        assert!(markdown.contains("`timeout <duration>` wrapper is acceptable"));
        assert!(markdown.contains("Topology Runtime Context finalization\n  reserve"));
        assert!(markdown.contains("Do not use `bash -lc`, `sh -c`, `ulimit`"));
        assert!(!markdown.contains("host-safe memory guard"));
        assert!(!markdown.contains("(`timeout`, and a subshell"));
    }

    #[test]
    fn invariant_coverage_prompt_preserves_stateful_failures() {
        let markdown = topology_prompt_markdown("strategies/invariants/coverage.md")
            .expect("coverage prompt should be bundled");

        assert!(markdown.contains("Coverage reaching the target is not a"));
        assert!(markdown.contains("valid success condition"));
        assert!(markdown.contains("every observed failure and every reproducer"));
        assert!(markdown.contains("{{output_findings_path}}"));
        assert!(markdown.contains("{{artifact_dir}}/findings.json"));
        assert!(markdown.contains("{{artifact_dir}}/harness-repairs.json"));
        let output_paths = prompt_artifact_output_paths(markdown).unwrap();
        assert!(
            output_paths.contains(&PathBuf::from("findings.json")),
            "dashboard prompt saves must retain findings.json as a required artifact"
        );
        assert!(
            output_paths.contains(&PathBuf::from("harness-repairs.json")),
            "dashboard prompt saves must retain harness-repairs.json as a required artifact"
        );
        assert!(
            markdown.contains("stateful_failure_classification=<classification>"),
            "stateful failures must carry a durable classification token"
        );
        for classification in [
            "production-bug",
            "harness-defect",
            "incomplete-spec",
            "false-positive",
            "blocked-unreproduced",
        ] {
            assert!(
                markdown.contains(classification),
                "missing stateful failure classification `{classification}`"
            );
        }
    }

    #[test]
    fn final_report_prompt_preserves_blocked_stateful_records_outside_poc_list() {
        let markdown =
            topology_prompt_markdown("review/final-report.md").expect("final report prompt");

        assert!(markdown.contains("`non_production_outcomes`"));
        assert!(markdown.contains("structured\n`report.json` findings"));
        assert!(markdown.contains("Do\nnot force `harness-defect`, `incomplete-spec`"));
        assert!(
            markdown.contains("`blocked-unreproduced` records without replayable generated tests")
        );
        assert!(markdown.contains("do not fabricate PoCs"));
    }

    #[test]
    fn final_report_prompt_documents_aggregation_schema_and_fixture_paths() {
        let markdown =
            topology_prompt_markdown("review/final-report.md").expect("final report prompt");

        assert!(markdown.contains("`aggregation.json` is a JSON object, not a top-level array"));
        assert!(markdown.contains("a `files` array of copied `.t.sol` test records"));
        assert!(markdown.contains("a `support_files` array for copied helper `.sol` records"));
        assert!(markdown.contains("do not run `.[] | .strategy` over the\nwhole object"));
        assert!(markdown.contains("The base test setup handoff is the source of truth"));
        assert!(markdown.contains("commonly `test/foundry/shared/BaseTest.t.sol`"));
        assert!(
            markdown.contains("Do not assume legacy\npaths such as `test/shared/BaseTest.t.sol`")
        );
    }

    #[test]
    fn review_prompts_preserve_stateful_failure_classification() {
        for relative_path in [
            "review/dedupe-findings.md",
            "review/triage.md",
            "review/severity-classification.md",
            "review/final-report.md",
        ] {
            let markdown =
                topology_prompt_markdown(relative_path).expect("review prompt should be bundled");
            assert!(
                markdown.contains("stateful_failure_classification=<classification>"),
                "review prompt `{relative_path}` must preserve stateful failure records"
            );
            assert!(
                markdown.contains("blocked-unreproduced"),
                "review prompt `{relative_path}` must preserve blocked/unreproduced records"
            );
        }
    }

    #[test]
    fn admin_config_boundaries_prompt_declares_selector_parity_contract() {
        let markdown = topology_prompt_markdown("strategies/admin-config-boundaries.md")
            .expect("admin/config prompt should be bundled");

        for required in [
            "core protocol modules",
            "market, exchange, or order-book modules",
            "issuance, sale, minting, redemption, or distribution modules",
            "vault, strategy, registry, deployer, or factory modules",
            "Positive authorized call",
            "Unauthorized rejection",
            "Getter reflection",
            "Selector/name mismatch",
            "abi.encodeWithSelector",
            "implementation-drift",
            "incomplete-spec",
            "admin-config-boundary-matrix.md",
            "admin-config-boundary-matrix.json",
            "selector_mismatches",
            "ambiguous_or_incomplete_specs",
            "{{artifact_handoff:project-discovery}}",
            "{{artifact_handoff:actors-flows}}",
            "{{artifact_handoff:base-test-setup}}",
            "{{artifact_handoff:property-specification-fanin}}",
            "{{strategy_attempt_test_dir}}",
            "{{output_findings_path}}",
        ] {
            assert!(
                markdown.contains(required),
                "admin/config prompt should contain `{required}`"
            );
        }
        assert!(
            !markdown
                .to_ascii_lowercase()
                .contains("legacy-target-specific"),
            "admin/config prompt must stay protocol-generic"
        );
    }

    #[test]
    fn external_dependency_prompt_requires_scope_matrix_and_source_backing() {
        let markdown = topology_prompt_markdown("strategies/external-dependency-boundaries.md")
            .expect("external dependency prompt should be bundled");

        for required in [
            "Threat Model Discovery Gate",
            "Dependency-Scope Matrix",
            "protocol-owned/in-scope",
            "explicitly-trusted/assumed-correct",
            "documented-out-of-scope-or-known-risk",
            "unknown/ambiguous",
            "Do not invent an adversarial dependency\nmodel because a dependency is external",
            "Only generate production-bug tests",
            "Ambiguity can produce a scope note, harness note",
            "source-backed\nin-scope rationale",
            "simply making a trusted oracle lie",
            "trusted third-party protocol malfunction",
            "explicitly unsupported token break ERC-20 semantics",
            "out-of-scope callback act maliciously",
            "dependency-scope-matrix.md",
            "dependency-scope-matrix.json",
            "source_backed_in_scope_rationales",
            "non_finding_rows",
            "{{artifact_handoff:project-discovery}}",
            "{{artifact_handoff:actors-flows}}",
            "{{artifact_handoff:base-test-setup}}",
            "{{artifact_handoff:property-specification-fanin}}",
            "{{strategy_attempt_test_dir}}",
            "{{output_findings_path}}",
        ] {
            assert!(
                markdown.contains(required),
                "external dependency prompt should contain `{required}`"
            );
        }
        assert!(
            !markdown
                .to_ascii_lowercase()
                .contains("legacy-target-specific"),
            "external dependency prompt must stay protocol-generic"
        );
    }

    #[test]
    fn triage_prompt_rejects_trusted_boundary_external_dependency_findings() {
        let triage =
            topology_prompt_markdown("review/triage.md").expect("triage prompt should be bundled");

        for required in [
            "## External dependency scope audit",
            "trusted-boundary-failure",
            "undocumented-external-misbehavior",
            "dependency_scope=source-backed-in-scope",
            "dependency_scope=ambiguous-or-out-of-scope",
            "source-backed in-scope rationale",
            "making a trusted oracle lie",
            "false-positive",
            "incomplete-spec",
            "spec-gated",
        ] {
            assert!(
                triage.contains(required),
                "triage prompt should contain `{required}`"
            );
        }
    }

    #[test]
    fn state_machine_prompt_covers_exact_input_fundability_matrix() {
        let markdown = topology_prompt_markdown("strategies/state-machine-boundaries.md")
            .expect("state machine prompt should be bundled");
        let normalized = markdown.split_whitespace().collect::<Vec<_>>().join(" ");

        for expected in [
            "Phase-transition exact-input fundability matrix",
            "sale, auction, order, swap, vault, and state-machine transitions",
            "phase-transition threshold - 1, threshold, and threshold + 1",
            "fee remainders",
            "ceil/floor boundary disagreements",
            "plus-one and minus-one inputs",
            "reported consumed or required input/value is less than or equal to the supplied input/value",
            "reportedInput <= suppliedInput",
            "same exact input/value and quoted approval/allowance",
            "Quote-only inconsistency",
            "Execution fundability failure",
        ] {
            assert!(
                normalized.contains(expected),
                "state-machine prompt should include `{expected}`"
            );
        }
        assert!(!markdown.contains("legacy-target-specific"));
    }

    #[test]
    fn input_domain_parity_prompts_cover_read_lattices() {
        let boundary = topology_prompt_markdown("strategies/boundary-tests.md")
            .expect("boundary prompt should be bundled");
        let market = topology_prompt_markdown("strategies/market-exhaustion-boundaries.md")
            .expect("market prompt should be bundled");
        let lifecycle = topology_prompt_markdown("strategies/lifecycle-view-boundaries.md")
            .expect("lifecycle prompt should be bundled");
        let normalize = |markdown: &str| markdown.split_whitespace().collect::<Vec<_>>().join(" ");
        let normalized_boundary = normalize(boundary);
        let normalized_market = normalize(market);
        let normalized_lifecycle = normalize(lifecycle);

        for expected in [
            "input-domain parity between public reads/traversals and mutating actions",
            "prices, buckets, ticks, ids, intervals, sizes",
            "off-lattice inputs consistently across read and write surfaces",
        ] {
            assert!(
                normalized_boundary.contains(expected),
                "boundary prompt should include `{expected}`"
            );
        }

        for expected in [
            "Public read/traversal input-domain parity",
            "price-to-tick conversion",
            "order-placement validation",
            "different market, book, or pool types",
            "different tick sizes or bucket widths",
            "non-unit step sizes",
            "do not fall exactly on the required lattice",
        ] {
            assert!(
                normalized_market.contains(expected),
                "market prompt should include `{expected}`"
            );
        }

        for expected in [
            "public read APIs that accept domain values",
            "same input-domain rules as the canonical mutating APIs",
            "prices, buckets, ticks, ids, intervals, sizes",
            "off-grid/non-unit cases",
            "mismatched revert, rounding, clamping, or sentinel behavior",
        ] {
            assert!(
                normalized_lifecycle.contains(expected),
                "lifecycle prompt should include `{expected}`"
            );
        }

        for markdown in [boundary, market, lifecycle] {
            assert!(!markdown
                .to_ascii_lowercase()
                .contains("legacy-target-specific"));
        }
    }

    #[test]
    fn market_exhaustion_prompt_covers_terminal_liquidity_matrix() {
        let markdown = topology_prompt_markdown("strategies/market-exhaustion-boundaries.md")
            .expect("market exhaustion prompt should be bundled");
        let normalized = markdown.split_whitespace().collect::<Vec<_>>().join(" ");

        for expected in [
            "Terminal-Liquidity Quote/Execution Matrix",
            "final fill and the no-next-level case",
            "order books, buckets, bitmap layers, AMM bands",
            "queue-like liquidity structures",
            "Side: bid-side depletion and ask-side depletion",
            "Quote mode: exact-input and exact-output requests",
            "Completion state: complete final fill, partial terminal fill",
            "market-to-limit or equivalent residual conversion",
            "Funding: exact required funding, one-unit underfunded",
            "one-unit overfunded or excess-input funding",
            "execute the matching action under bounded gas",
            "execution terminates within that bound",
            "observed fill and payment/refund match the quote",
            "final top of book resolves to the documented empty/sentinel state",
        ] {
            assert!(
                normalized.contains(expected),
                "market-exhaustion prompt should include `{expected}`"
            );
        }
        assert!(!markdown.contains("legacy-target-specific"));
    }

    #[test]
    fn amm_boundary_prompt_requires_public_read_matrix_after_mutations() {
        let markdown = topology_prompt_markdown("strategies/amm-boundary-liquidity.md")
            .expect("AMM boundary prompt should be bundled");
        let normalized = markdown.split_whitespace().collect::<Vec<_>>().join(" ");

        for expected in [
            "Public Read Matrix After Boundary Mutations",
            "After each successful boundary mutation",
            "boundary add, boundary remove, liquidity add, liquidity remove",
            "documented public market, orderbook, quote, price-ladder, level, reserve, liquidity, and derived-price view/read functions",
            "Empty orderbook or empty order-book states",
            "Derived prices outside the normal tick domain",
            "Treat any revert, panic, out-of-gas, array bounds failure, arithmetic overflow, or undocumented error from a documented public read as a finding before checking value bounds",
            "documented market and price-ladder reads are total and bounded for all reachable states created by AMM boundary mutations",
        ] {
            assert!(
                normalized.contains(expected),
                "AMM boundary prompt should include `{expected}`"
            );
        }
        assert!(!markdown.contains("legacy-target-specific"));
    }

    #[test]
    fn state_machine_prompt_covers_pause_lock_capability_matrix() {
        let markdown = topology_prompt_markdown("strategies/state-machine-boundaries.md")
            .expect("state machine prompt should be bundled");
        let normalized = markdown.split_whitespace().collect::<Vec<_>>().join(" ");

        for expected in [
            "Lifecycle Capability Matrix",
            "paused, locked, closed, frozen, stopped, disabled",
            "enumerate every ABI-exposed mutating entrypoint",
            "direct, batch, packed, delegated, router, keeper, or execute-style paths",
            "user-facing NatSpec on an external state such as locked as valid product evidence",
            "ABI exposure and sibling enforcement signals",
            "non-empty required strategy/action payload",
            "call the matching execution entrypoint, including generic `execute`",
            "assert the call reverts for the lifecycle guard",
            "snapshot orderbook, order queue, balance, collateral, share, native value",
            "assert none of those values changed",
            "locked/open vault-style states",
            "no orderbook or balance mutation",
        ] {
            assert!(
                normalized.contains(expected),
                "state-machine prompt should include `{expected}`"
            );
        }
        assert!(!markdown.contains("legacy-target-specific"));
    }

    #[test]
    fn strategy_prompts_do_not_use_legacy_target_terms() {
        let audited_strategy_prompts = [
            "strategies/amm-boundary-liquidity.md",
            "strategies/admin-config-boundaries.md",
            "strategies/batch-atomicity-unsupported-actions.md",
            "strategies/boundary-tests.md",
            "strategies/differential-library-tests.md",
            "strategies/encode-decode.md",
            "strategies/expand-coverage.md",
            "strategies/externalized-state-accounting.md",
            "strategies/lifecycle-view-boundaries.md",
            "strategies/market-exhaustion-boundaries.md",
            "strategies/order-replacement-collateral.md",
            "strategies/packed-action-parity.md",
            "strategies/payable-fallback-accounting.md",
            "strategies/round-trip.md",
            "strategies/rounding-direction-audit.md",
            "strategies/router-exact-accounting.md",
            "strategies/state-machine-boundaries.md",
            "strategies/time-warp-sequences.md",
            "strategies/workflow-property-based-tests.md",
        ];
        let banned_terms = [
            "legacy-target-specific",
            "legacy-target-contracts",
            "legacy-target-math",
            "legacy-target-storage",
            "cloid",
            "native-id",
            "fallback bid",
            "amountin",
            "amountout",
            "launchpad",
            "max-price",
            "exhausted-book",
        ];

        for relative_path in audited_strategy_prompts {
            let markdown = topology_prompt_markdown(relative_path)
                .unwrap_or_else(|| panic!("strategy prompt `{relative_path}` should be bundled"));
            let lowercase = markdown.to_ascii_lowercase();
            for term in banned_terms {
                assert!(
                    !lowercase.contains(term),
                    "strategy prompt `{relative_path}` should not contain legacy target term `{term}`"
                );
            }
        }
    }

    #[test]
    fn generated_foundry_test_prompts_request_t_sol_files() {
        for asset in PROJECT_TOPOLOGY_PROMPTS {
            if !asset.markdown.contains("Write generated Foundry tests") {
                continue;
            }
            assert!(
                asset.markdown.contains("`.t.sol`"),
                "prompt `{}` should request collectable Foundry `.t.sol` files",
                asset.relative_path
            );
        }
    }

    #[test]
    fn focused_strategy_prompts_use_protocol_class_language() {
        let batch = topology_prompt_markdown("strategies/batch-atomicity-unsupported-actions.md")
            .expect("batch prompt should be bundled");
        assert!(batch.contains("Structured batch carrier fields"));
        assert!(batch.contains("external reference id"));
        assert!(batch.contains("pending-action state"));
        assert!(batch.contains("Do not combine probes with `;`, `&&`, `||`, pipes"));
        assert!(batch.contains("stdout/stderr\nredirection"));

        let payable = topology_prompt_markdown("strategies/payable-fallback-accounting.md")
            .expect("payable prompt should be bundled");
        assert!(payable.contains("Fallback-dispatched protocol actions"));
        assert!(payable.contains("when the target exposes that public action class"));
        assert!(payable.contains("Run build and focused test validation as separate Bash calls"));
        assert!(payable.contains("Do not combine `forge build` and `forge test`"));
        assert!(payable.contains("Let Ultrafuzz capture stdout and stderr"));

        let packed = topology_prompt_markdown("strategies/packed-action-parity.md")
            .expect("packed action prompt should be bundled");
        assert!(packed.contains("run one direct Forge command at a time"));
        assert!(packed.contains("Do not use shell redirection"));
        assert!(packed.contains("output-shortening wrappers"));

        let externalized = topology_prompt_markdown("strategies/externalized-state-accounting.md")
            .expect("externalized-state accounting prompt should be bundled");
        let normalized_externalized = externalized
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        for expected in [
            "active commitments, pending settlements, queued operations",
            "late-entry, exit, reward/fee, pending-settlement, partial-settlement",
            "total economic value conservation or bounded change",
            "active-state decrease caps",
            "public view liveness",
            "incomplete-spec",
        ] {
            assert!(
                normalized_externalized.contains(expected),
                "externalized-state accounting prompt should include `{expected}`"
            );
        }

        let router = topology_prompt_markdown("strategies/router-exact-accounting.md")
            .expect("router prompt should be bundled");
        assert!(router.contains("Input amount and output amount plus-one normalization cases"));
        assert!(router.contains("most direct public quote path"));
        assert!(router.contains("run one direct Forge command at a\ntime"));
        assert!(router.contains("Do not use shell redirection"));
        assert!(router.contains("output-shortening wrappers"));

        let state_machine = topology_prompt_markdown("strategies/state-machine-boundaries.md")
            .expect("state-machine prompt should be bundled");
        let normalized_state_machine = state_machine
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(normalized_state_machine.contains("graduation, activation, finalization"));
        assert!(normalized_state_machine.contains("sale, auction, market, vault"));

        let lifecycle = topology_prompt_markdown("strategies/lifecycle-view-boundaries.md")
            .expect("lifecycle prompt should be bundled");
        assert!(lifecycle.contains("market/book/pool exhaustion"));
        assert!(lifecycle.contains("exhausted-liquidity"));

        let market = topology_prompt_markdown("strategies/market-exhaustion-boundaries.md")
            .expect("market prompt should be bundled");
        assert!(market.contains("pool liquidity, or sale/auction capacity"));
        assert!(market.contains("bucket, order id, quote"));
    }

    #[test]
    fn packed_action_prompt_requires_semantic_field_width_matrix() {
        let packed = topology_prompt_markdown("strategies/packed-action-parity.md")
            .expect("packed action prompt should be bundled");
        let normalized_packed = packed.split_whitespace().collect::<Vec<_>>().join(" ");

        for required in [
            "## Semantic Field-Width Carrier Matrix",
            "documented ID-like, nonce, salt, action-code, index",
            "semantic width narrower than its public ABI carrier",
            "direct structured public call",
            "structured batch/multicall carrier",
            "compact/fallback/raw calldata carrier",
            "`0`, semantic max, semantic max + 1, and the actual ABI carrier max",
            "Use `type(uint256).max` when the carrier is `uint256`",
            "instead of only testing Solidity ABI decoder strictness",
            "manual raw calldata",
            "mask or truncate before the external call",
        ] {
            assert!(
                normalized_packed.contains(required),
                "packed-action prompt should contain `{required}`"
            );
        }

        let batch = topology_prompt_markdown("strategies/batch-atomicity-unsupported-actions.md")
            .expect("batch prompt should be bundled");
        let normalized_batch = batch.split_whitespace().collect::<Vec<_>>().join(" ");
        for required in [
            "Structured batch carrier fields",
            "`0`, semantic max, semantic max plus one, and the ABI carrier max",
            "`type(uint256).max` when the carrier is `uint256`",
            "helper encoders",
            "mask/truncate before the external call",
            "direct public calls and compact/fallback paths",
        ] {
            assert!(
                normalized_batch.contains(required),
                "batch prompt should contain `{required}`"
            );
        }

        let boundary = topology_prompt_markdown("strategies/boundary-tests.md")
            .expect("boundary prompt should be bundled");
        let normalized_boundary = boundary.split_whitespace().collect::<Vec<_>>().join(" ");
        for required in [
            "semantic field-width carriers",
            "direct public calls, structured batch/multicall carriers",
            "fallback/raw packed carriers",
            "semantic max plus one",
            "ABI carrier max",
            "`type(uint256).max` when the carrier is `uint256`",
            "helper encoders/casts that truncate",
        ] {
            assert!(
                normalized_boundary.contains(required),
                "boundary prompt should contain `{required}`"
            );
        }
    }

    #[test]
    fn batch_atomicity_prompt_promotes_finite_required_action_rollback() {
        let batch = topology_prompt_markdown("strategies/batch-atomicity-unsupported-actions.md")
            .expect("batch prompt should be bundled");
        let triage =
            topology_prompt_markdown("review/triage.md").expect("triage prompt should be bundled");
        let normalized_batch = batch.split_whitespace().collect::<Vec<_>>().join(" ");
        let normalized_triage = triage.split_whitespace().collect::<Vec<_>>().join(" ");

        for expected in [
            "finite documented opcode/action set",
            "no-op or skip behavior for unknown required actions",
            "negative batch matrix",
            "valid required mutation",
            "unsupported required opcode/action",
            "no live order",
            "externally visible state delta",
            "source-backed production evidence",
            "Classify assumptions as incomplete-spec",
        ] {
            assert!(
                normalized_batch.contains(expected),
                "batch prompt should include `{expected}`"
            );
        }

        for expected in [
            "Required batch rollback audit",
            "finite opcode/action set",
            "unknown required opcodes/actions should fail",
            "the oracle is production-backed",
            "finite opcode/action set plus required rollback semantics",
            "no live order or externally visible state delta",
            "`incomplete-spec`, `spec-gated`, or `undetermined`",
        ] {
            assert!(
                normalized_triage.contains(expected),
                "triage prompt should include `{expected}`"
            );
        }
    }

    #[test]
    fn parses_yaml_frontmatter() {
        let parsed = parse_prompt_document(
            r#"---
id: storage-layout
display_name: Storage Layout
loops: 3
enabled: false
timeout_seconds: 42
---

# Role
"#,
        )
        .unwrap();

        assert_eq!(parsed.frontmatter.id.as_deref(), Some("storage-layout"));
        assert_eq!(parsed.frontmatter.loops, Some(3));
        assert_eq!(parsed.frontmatter.enabled, Some(false));
        assert_eq!(parsed.frontmatter.timeout_seconds, Some(42));
        assert!(parsed.body.contains("# Role"));
    }

    #[test]
    fn rejects_removed_category_frontmatter() {
        let error = parse_prompt_document(
            r#"---
id: storage-layout
category: custom
---

# Role
"#,
        )
        .unwrap_err();

        assert!(matches!(error, PromptError::InvalidFrontmatter(_)));
        assert!(error.to_string().contains("no longer supported"));
    }

    #[test]
    fn parses_unrelated_frontmatter_metadata_without_treating_it_as_prompt_metadata() {
        let parsed = parse_prompt_document(
            r#"---
id: storage-layout
owner: security
source: fixture
---

# Role
"#,
        )
        .unwrap();

        assert_eq!(parsed.frontmatter.id.as_deref(), Some("storage-layout"));
        assert!(parsed.body.contains("# Role"));
    }

    #[test]
    fn parses_strategy_frontmatter_models() {
        let temp = tempfile::tempdir().unwrap();
        let dir = project_prompt_dir(temp.path()).join("strategies");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("encode-decode.md"),
            "---\nid: encode-decode\nmodels: [gpt-5-5, claude-4-6]\n---\n# Decode\n",
        )
        .unwrap();

        let registry = PromptRegistry::load_for_project(temp.path()).unwrap();
        let prompt = registry.get(&PromptId::from("encode-decode")).unwrap();

        assert_eq!(
            prompt.models,
            vec![
                ModelProfileId::from("gpt-5-5"),
                ModelProfileId::from("claude-4-6")
            ]
        );
        assert_eq!(prompt.strategy_definition().models, prompt.models);
    }

    #[test]
    fn discovers_project_prompts_and_rejects_duplicate_ids() {
        let temp = tempfile::tempdir().unwrap();
        let dir = project_prompt_dir(temp.path()).join("properties");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("storage_layout.md"),
            "---\nid: duplicate\nloops: 1\n---\n# Storage\n",
        )
        .unwrap();
        fs::write(
            dir.join("oracle_drift.md"),
            "---\nid: duplicate\nloops: 1\n---\n# Oracle\n",
        )
        .unwrap();

        let error = PromptRegistry::load_for_project(temp.path()).unwrap_err();
        assert!(matches!(error, PromptError::DuplicateStrategyId { .. }));
    }

    #[test]
    fn project_prompt_overrides_built_in_prompt_body() {
        let temp = tempfile::tempdir().unwrap();
        let dir = project_prompt_dir(temp.path()).join("strategies");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("encode-decode.md"),
            "---\nid: encode-decode\nloops: 2\n---\n# Edited Decode Prompt\n",
        )
        .unwrap();

        let registry = PromptRegistry::load_for_project(temp.path()).unwrap();
        let prompt = registry.get(&PromptId::from("encode-decode")).unwrap();

        assert_eq!(prompt.loops, 2);
        assert!(prompt.body.contains("Edited Decode Prompt"));
        assert!(matches!(prompt.source, PromptSource::Project(_)));
    }

    #[test]
    fn discovers_nested_project_strategy_prompts() {
        let temp = tempfile::tempdir().unwrap();
        let dir = project_prompt_dir(temp.path()).join("properties/stateful");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("setup.md"),
            "---\nid: stateful-invariant-setup\nloops: 2\n---\n# Edited setup\n",
        )
        .unwrap();

        let registry = PromptRegistry::load_for_project(temp.path()).unwrap();
        let prompt = registry
            .get(&PromptId::from("stateful-invariant-setup"))
            .unwrap();

        assert_eq!(prompt.loops, 2);
        assert!(prompt.body.contains("Edited setup"));
        assert!(matches!(prompt.source, PromptSource::Project(_)));
        assert!(prompt.source_path.ends_with("properties/stateful/setup.md"));
    }

    #[test]
    fn renders_prompt_variables_and_errors_on_missing_variables() {
        let mut context = PromptRenderContext::new();
        context.insert("repo_path", "/tmp/repo");
        context.insert("workspace_path", "/tmp/work");
        context.insert("triage_quorum", "4");
        context.insert("triage_panel_size", "7");
        context.insert("dynamic_strategies_enumerator", "5");

        assert_eq!(
            render_template("repo={{ repo_path }} work={{workspace_path}}", &context).unwrap(),
            "repo=/tmp/repo work=/tmp/work"
        );
        assert_eq!(
            render_template(
                "quorum={{triage_quorum}} panel={{ triage_panel_size }}",
                &context
            )
            .unwrap(),
            "quorum=4 panel=7"
        );
        assert_eq!(
            render_template("dynamic={{dynamic_strategies_enumerator}}", &context).unwrap(),
            "dynamic=5"
        );
        assert_eq!(
            render_template("{{missing}}", &context)
                .unwrap_err()
                .to_string(),
            "missing template variable: missing"
        );
    }

    #[test]
    fn validates_canonical_tunable_variables_without_aliases() {
        validate_supported_template_variables(
            "{{strategy_loop_count}} {{triage_quorum}} {{triage_panel_size}} {{dynamic_strategies_enumerator}} {{invariant_property_priority_threshold}} {{invariant_property_priority_filter}} {{invariant_property_priorities}} {{invariant_testing_fuzzer_timeout}}",
        )
        .unwrap();

        for alias in [
            "{{vars:strategy-loops}}",
            "{{vars:triager-quorum}}",
            "{{vars:triager-panel}}",
            "{{triager_quorum}}",
            "{{triager_panel}}",
        ] {
            let error = validate_supported_template_variables(alias).unwrap_err();
            assert_eq!(
                error.to_string(),
                format!(
                    "missing template variable: {}",
                    alias.trim_start_matches("{{").trim_end_matches("}}")
                )
            );
        }
    }

    #[test]
    fn validates_artifact_path_template_references() {
        validate_supported_template_variables(
            "Read {{artifact_path:base-test-setup}}/setup/base-test-setup.md and write {{artifact_path}}/out.md.",
        )
        .unwrap();
        validate_supported_template_variables("Read {{artifact_handoff:base-test-setup}}.")
            .unwrap();
        validate_supported_template_variables("Read:\n{{ancestor_artifacts}}").unwrap();
        validate_supported_template_variables(
            "Read:\n{{ancestor_artifacts:property-specification-0kn0t, property-specification-certora}}",
        )
        .unwrap();

        assert!(matches!(
            validate_supported_template_variables("{{artifact_path:}}"),
            Err(PromptError::InvalidArtifactReferenceTarget(_))
        ));
        assert!(matches!(
            validate_supported_template_variables("{{artifact_handoff:}}"),
            Err(PromptError::InvalidArtifactReferenceTarget(_))
        ));
        assert!(matches!(
            validate_supported_template_variables("{{artifact_handoff:base-test-setup}}/out.md"),
            Err(PromptError::InvalidArtifactHandoffSuffix(_))
        ));
        assert!(matches!(
            validate_supported_template_variables("{{ancestor_artifacts:}}"),
            Err(PromptError::InvalidAncestorArtifactsTarget(_))
        ));
        assert!(matches!(
            validate_supported_template_variables("{{ancestor_artifacts:source,source}}"),
            Err(PromptError::DuplicateAncestorArtifactsTarget(_))
        ));
        assert!(matches!(
            validate_supported_template_variables("{{ancestor_artifacts:source}}/out.md"),
            Err(PromptError::InvalidAncestorArtifactsSuffix)
        ));
        assert!(matches!(
            extract_prompt_artifact_path_references("{{artifact_path}}/../outside.md"),
            Err(PromptError::InvalidArtifactReferencePath(_))
        ));
        assert!(matches!(
            validate_supported_template_variables("{{artifact_path}}/../outside.md"),
            Err(PromptError::InvalidArtifactReferencePath(_))
        ));
        assert_eq!(
            validate_supported_template_variables("{{artifacts_path}}")
                .unwrap_err()
                .to_string(),
            "missing template variable: artifacts_path"
        );
    }

    #[test]
    fn extracts_prompt_artifact_references_and_outputs() {
        let references = extract_prompt_artifact_path_references(
            "Read {{artifact_path:base-test-setup}}/setup/base-test-setup.md and {{artifact_handoff:project-discovery}}. Write {{ artifact_path }}/summary/final.md and {{ artifact_dir }}/setup-inventory.json.",
        )
        .unwrap();

        assert_eq!(references.len(), 4);
        assert_eq!(
            references[0],
            PromptArtifactPathReference {
                variable: "artifact_path:base-test-setup".to_owned(),
                producer: PromptArtifactPathProducer::LogicalNode("base-test-setup".to_owned()),
                path: Some(PathBuf::from("setup/base-test-setup.md")),
            }
        );
        assert_eq!(
            references[1],
            PromptArtifactPathReference {
                variable: "artifact_handoff:project-discovery".to_owned(),
                producer: PromptArtifactPathProducer::Handoff("project-discovery".to_owned()),
                path: None,
            }
        );
        assert_eq!(
            references[3],
            PromptArtifactPathReference {
                variable: "artifact_dir".to_owned(),
                producer: PromptArtifactPathProducer::Current,
                path: Some(PathBuf::from("setup-inventory.json")),
            }
        );
        assert_eq!(
            prompt_artifact_output_paths(
                "Write {{ artifact_path }}/summary/final.md and {{ artifact_dir }}/setup-inventory.json.",
            )
            .unwrap(),
            vec![
                PathBuf::from("summary/final.md"),
                PathBuf::from("setup-inventory.json"),
            ]
        );
    }

    #[test]
    fn extracts_prompt_ancestor_artifact_references() {
        let references = extract_prompt_ancestor_artifact_references(
            "Read direct deps:\n{{ancestor_artifacts}}\nRead selected:\n{{ ancestor_artifacts:source-a, source_b }}",
        )
        .unwrap();

        assert_eq!(
            references,
            vec![
                PromptAncestorArtifactsReference {
                    variable: "ancestor_artifacts".to_owned(),
                    selector: PromptAncestorArtifactsSelector::DirectDependencies,
                },
                PromptAncestorArtifactsReference {
                    variable: "ancestor_artifacts:source-a, source_b".to_owned(),
                    selector: PromptAncestorArtifactsSelector::Producers(vec![
                        "source-a".to_owned(),
                        "source_b".to_owned(),
                    ]),
                },
            ]
        );
    }

    #[test]
    fn renames_prompt_artifact_path_reference_targets() {
        assert_eq!(
            rename_prompt_artifact_path_references(
                "Read {{ artifact_path:project-discovery }}/setup.md and {{artifact_path}}/out.md.",
                "project-discovery",
                "repository-scan",
            )
            .unwrap(),
            "Read {{ artifact_path:repository-scan }}/setup.md and {{artifact_path}}/out.md."
        );
        assert_eq!(
            rename_prompt_artifact_path_references(
                "Review {{artifact_path}}/setup/project-discovery.md for context.",
                "project-discovery",
                "repository-scan",
            )
            .unwrap(),
            "Review {{artifact_path}}/setup/repository-scan.md for context."
        );
        assert_eq!(
            rename_prompt_artifact_path_references(
                "Review {{artifact_path:project-discovery}}/setup/project-discovery.md for context.",
                "project-discovery",
                "repository-scan",
            )
            .unwrap(),
            "Review {{artifact_path:repository-scan}}/setup/repository-scan.md for context."
        );
        assert_eq!(
            rename_prompt_artifact_path_references(
                "Review {{ artifact_handoff:project-discovery }} for context.",
                "project-discovery",
                "repository-scan",
            )
            .unwrap(),
            "Review {{ artifact_handoff:repository-scan }} for context."
        );
        assert_eq!(
            rename_prompt_artifact_path_references(
                "Read:\n{{ ancestor_artifacts:project-discovery,base-test-setup }}",
                "project-discovery",
                "repository-scan",
            )
            .unwrap(),
            "Read:\n{{ ancestor_artifacts:repository-scan,base-test-setup }}"
        );
    }

    #[test]
    fn renders_looped_artifact_references_as_full_path_bullets() {
        let context = PromptRenderContext::new().with("repo_path", "/repo");
        let mut artifacts = ArtifactPathRenderContext::new("/run/artifacts/current");
        artifacts.insert_logical_node(
            "encode-decode",
            vec![
                PathBuf::from("/run/artifacts/encode-decode-0"),
                PathBuf::from("/run/artifacts/encode-decode-1"),
            ],
        );

        let rendered = render_template_with_artifact_paths(
            "Repo {{repo_path}}\nRead:\n{{artifact_path:encode-decode}}/candidate.json.",
            &context,
            &artifacts,
        )
        .unwrap();

        assert_eq!(
            rendered,
            "Repo /repo\nRead:\n- /run/artifacts/encode-decode-0/candidate.json\n- /run/artifacts/encode-decode-1/candidate.json."
        );

        artifacts.insert_logical_handoff(
            "producer-tests",
            vec![
                PathBuf::from("/run/artifacts/producer-tests-0/recipes.md"),
                PathBuf::from("/run/artifacts/producer-tests-1/recipes.md"),
            ],
        );
        let rendered = render_template_with_artifact_paths(
            "Read primary handoffs:\n{{artifact_handoff:producer-tests}}.",
            &context,
            &artifacts,
        )
        .unwrap();

        assert_eq!(
            rendered,
            "Read primary handoffs:\n- /run/artifacts/producer-tests-0/recipes.md\n- /run/artifacts/producer-tests-1/recipes.md."
        );

        let rendered = render_template_with_artifact_paths(
            "Read dirs:\n{{artifact_path:encode-decode}}/",
            &context,
            &artifacts,
        )
        .unwrap();

        assert_eq!(
            rendered,
            "Read dirs:\n- /run/artifacts/encode-decode-0\n- /run/artifacts/encode-decode-1"
        );
    }

    #[test]
    fn renders_ancestor_required_artifacts_as_full_path_bullets() {
        let context = PromptRenderContext::new().with("repo_path", "/repo");
        let mut artifacts = ArtifactPathRenderContext::new("/run/artifacts/current");
        artifacts.set_direct_dependencies(vec![
            "property-specification-0kn0t".to_owned(),
            "property-specification-certora".to_owned(),
        ]);
        artifacts.insert_logical_node(
            "property-specification-0kn0t",
            vec![PathBuf::from("/run/artifacts/property-specification-0kn0t")],
        );
        artifacts.insert_logical_node(
            "property-specification-certora",
            vec![
                PathBuf::from("/run/artifacts/property-specification-certora-0"),
                PathBuf::from("/run/artifacts/property-specification-certora-1"),
            ],
        );
        artifacts.insert_ancestor_required_artifacts(
            "property-specification-0kn0t",
            vec![PathBuf::from("properties/0kn0t.md")],
        );
        artifacts.insert_ancestor_required_artifacts(
            "property-specification-certora",
            vec![PathBuf::from("properties/certora.md")],
        );

        let rendered = render_template_with_artifact_paths(
            "Repo {{repo_path}}\nRead:\n{{ancestor_artifacts}}",
            &context,
            &artifacts,
        )
        .unwrap();

        assert_eq!(
            rendered,
            "Repo /repo\nRead:\n- /run/artifacts/property-specification-0kn0t/properties/0kn0t.md\n- /run/artifacts/property-specification-certora-0/properties/certora.md\n- /run/artifacts/property-specification-certora-1/properties/certora.md"
        );

        let rendered = render_template_with_artifact_paths(
            "Selected:\n{{ancestor_artifacts:property-specification-certora}}",
            &context,
            &artifacts,
        )
        .unwrap();

        assert_eq!(
            rendered,
            "Selected:\n- /run/artifacts/property-specification-certora-0/properties/certora.md\n- /run/artifacts/property-specification-certora-1/properties/certora.md"
        );
    }

    #[test]
    fn bundled_list_artifact_references_start_their_lines() {
        for asset in PROJECT_TOPOLOGY_PROMPTS {
            for (index, line) in asset.markdown.lines().enumerate() {
                let trimmed = line.trim_start();
                let contains_list_reference = line.contains("{{artifact_handoff:")
                    || line.contains("{{ artifact_handoff:")
                    || line.contains("{{artifact_path:")
                    || line.contains("{{ artifact_path:");
                let starts_with_list_reference = trimmed.starts_with("{{artifact_handoff:")
                    || trimmed.starts_with("{{ artifact_handoff:")
                    || trimmed.starts_with("{{artifact_path:")
                    || trimmed.starts_with("{{ artifact_path:");
                assert!(
                    !contains_list_reference || starts_with_list_reference,
                    "list-valued artifact reference must start its line in {}:{}: {}",
                    asset.relative_path,
                    index + 1,
                    line
                );
            }
        }
    }

    #[test]
    fn review_prompts_describe_family_dedupe_without_protocol_specific_terms() {
        let dedupe_prompt = topology_prompt_markdown("review/dedupe-findings.md").unwrap();
        assert!(dedupe_prompt.contains("`family_id`"));
        assert!(dedupe_prompt.contains("`family_variants`"));
        assert!(dedupe_prompt.contains("`related_findings`"));
        assert!(dedupe_prompt.contains("Restart handling"));
        assert!(dedupe_prompt.contains("treat them as the materialized dedupe result"));
        assert!(dedupe_prompt.contains("run only a small number of direct JSON"));
        assert!(dedupe_prompt.contains("Do not merge a related finding"));
        assert!(dedupe_prompt.contains("concrete terminal-state failure"));
        assert!(dedupe_prompt
            .contains("including candidates that may later\ntriage as non-production outcomes"));
        assert!(dedupe_prompt.contains("{{artifact_path}}/deduped-findings.json"));
        assert!(dedupe_prompt.contains("{{artifact_path}}/duplicates.json"));
        assert!(
            dedupe_prompt.contains("do not replace\n`deduped-findings.json` with an audit object")
        );
        assert!(dedupe_prompt.contains("deduped root or family key"));
        assert!(dedupe_prompt.contains("strategy-detections.json"));

        let final_report_prompt = topology_prompt_markdown("review/final-report.md").unwrap();
        assert!(final_report_prompt.contains("`family_variants`"));
        assert!(final_report_prompt.contains("`related_findings`"));
        assert!(final_report_prompt.contains("same-root family variant"));
        assert!(final_report_prompt.contains("strategy detections by stable `dedupe_key` first"));
        assert!(final_report_prompt
            .contains("Only fall back to\n`finding_id` when the finding has no dedupe key"));
        assert!(final_report_prompt.contains("do not promote related-only adjacent surfaces"));
    }

    #[test]
    fn scaffolds_topology_prompt_files_without_overwriting_by_default() {
        let temp = tempfile::tempdir().unwrap();
        let first = scaffold_project_prompts(temp.path(), false).unwrap();
        assert_eq!(first.written.len(), PROJECT_TOPOLOGY_PROMPTS.len());
        assert_eq!(first.skipped.len(), 0);
        for path in &first.written {
            let content = fs::read_to_string(path).unwrap();
            assert!(
                !content
                    .lines()
                    .any(|line| line.trim_start().starts_with("category:")),
                "scaffolded prompt `{}` should not declare category frontmatter",
                path.display()
            );
        }

        let prompt_path = temp
            .path()
            .join(".ultrafuzz/prompts/strategies/encode-decode.md");
        assert_eq!(
            topology_prompt_markdown("strategies/encode-decode.md"),
            Some(include_str!("../../../prompts/strategies/encode-decode.md"))
        );
        assert_eq!(
            topology_prompt_markdown("strategies/boundary-tests.md"),
            Some(include_str!(
                "../../../prompts/strategies/boundary-tests.md"
            ))
        );
        assert_eq!(
            topology_prompt_markdown("strategies/external-dependency-boundaries.md"),
            Some(include_str!(
                "../../../prompts/strategies/external-dependency-boundaries.md"
            ))
        );
        assert_eq!(
            topology_prompt_markdown("strategies/time-warp-sequences.md"),
            Some(include_str!(
                "../../../prompts/strategies/time-warp-sequences.md"
            ))
        );
        assert_eq!(
            topology_prompt_markdown("strategies/rounding-direction-audit.md"),
            Some(include_str!(
                "../../../prompts/strategies/rounding-direction-audit.md"
            ))
        );
        assert_eq!(
            topology_prompt_markdown("properties/josselin-feist-lens.md"),
            Some(include_str!(
                "../../../prompts/properties/josselin-feist-lens.md"
            ))
        );
        assert_eq!(
            topology_prompt_markdown("properties/recon-lens.md"),
            Some(include_str!("../../../prompts/properties/recon-lens.md"))
        );
        assert_eq!(
            topology_prompt_markdown("strategies/packed-action-parity.md"),
            Some(include_str!(
                "../../../prompts/strategies/packed-action-parity.md"
            ))
        );
        assert_eq!(
            topology_prompt_markdown("strategies/externalized-state-accounting.md"),
            Some(include_str!(
                "../../../prompts/strategies/externalized-state-accounting.md"
            ))
        );
        assert_eq!(
            topology_prompt_markdown("strategies/dynamic-strategy-generator.md"),
            Some(include_str!(
                "../../../prompts/strategies/dynamic-strategy-generator.md"
            ))
        );
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/setup/project-discovery.md")
            .exists());
        let project_discovery_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/setup/project-discovery.md"),
        )
        .unwrap();
        assert!(project_discovery_prompt.contains("Prefer\n`rg --files contracts`"));
        assert!(project_discovery_prompt.contains("Wrong:\n`find contracts -type f | sort`"));
        assert!(project_discovery_prompt.contains("leave ordering unsorted"));
        assert!(project_discovery_prompt.contains("`node --version`"));
        assert!(project_discovery_prompt.contains("not available in PATH"));
        assert!(project_discovery_prompt.contains("/home/ubuntu/.foundry/bin"));
        assert!(project_discovery_prompt
            .contains("Do not combine optional probes with `;`, `echo` separators, `2>/dev/null`"));
        assert!(project_discovery_prompt.contains("use `rg --files` by itself"));
        let boundary_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/boundary-tests.md"),
        )
        .unwrap();
        assert!(boundary_prompt.contains("direct workspace-relative command at a time"));
        assert!(boundary_prompt.contains("Do not pipe `grep` into"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/setup/actors-flows.md")
            .exists());
        let foundry_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/setup/prepare-foundry-harness.md"),
        )
        .unwrap();
        assert!(foundry_prompt.contains("{{artifact_handoff:project-discovery}}"));
        assert!(!foundry_prompt.contains("Review {{artifact_path}}/setup/project-discovery.md"));
        assert!(foundry_prompt.contains("Check Foundry availability only with `forge --version`"));
        assert!(foundry_prompt.contains("Wrong: `echo \"$PATH\"`"));
        assert!(foundry_prompt.contains("Wrong: `ls -la ~/.foundry/bin`"));
        assert!(foundry_prompt.contains("Keep dependencies patch-visible"));
        assert!(foundry_prompt.contains("Do not use\n`git clone`, `forge install`"));
        assert!(foundry_prompt.contains("minimal local test support file under `test/foundry/`"));
        let base_test_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/setup/discover-base-test.md"),
        )
        .unwrap();
        assert!(base_test_prompt.contains("preserve its current file names and imports"));
        assert!(base_test_prompt.contains("Do not rename working fixtures"));
        assert!(base_test_prompt.contains("not a required naming migration"));
        assert!(base_test_prompt.contains("Verify concrete workspace-relative\nfiles"));
        assert!(
            base_test_prompt.contains("Wrong: `find / -type d -name \"forge-std\" 2>/dev/null`")
        );
        assert!(base_test_prompt.contains(
            "Wrong:\n`ls -la node_modules/forge-std node_modules/.bin/forge 2>&1; echo \"---\"; ls node_modules 2>&1 | head -5`"
        ));
        let fanin_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/properties/property-specification-fanin.md"),
        )
        .unwrap();
        assert!(fanin_prompt.contains("{{ancestor_artifacts}}"));
        assert!(!fanin_prompt.contains("{{artifact_path:property-specification-0kn0t}}"));
        assert!(
            !fanin_prompt.contains("Consolidate properties from {{artifact_path}}/properties/*")
        );
        assert!(!fanin_prompt.contains("Do not fetch remote reference material"));
        let generic_property_prompt =
            include_str!("../../../prompts/properties/property-specification.md");
        assert!(generic_property_prompt.contains("pinned reference artifacts"));
        assert!(!generic_property_prompt.contains("Do not fetch remote reference material"));
        let external_reference_prompts = [
            (
                "properties/0kn0t-lens.md",
                "{{artifact_handoff:reference-properties-0kn0t}}",
            ),
            (
                "properties/certora-thinking-lens.md",
                "{{artifact_handoff:reference-properties-certora-thinking}}",
            ),
            (
                "properties/aviggiano-lens.md",
                "{{artifact_handoff:reference-properties-aviggiano}}",
            ),
            (
                "properties/josselin-feist-lens.md",
                "{{artifact_handoff:reference-properties-montyly-rounding}}",
            ),
            (
                "properties/property-specification-crytic.md",
                "{{artifact_handoff:reference-properties-crytic}}",
            ),
            (
                "properties/property-specification-runtime-verification.md",
                "{{artifact_handoff:reference-properties-runtime-verification}}",
            ),
            (
                "properties/property-specification-a16z.md",
                "{{artifact_handoff:reference-properties-a16z-erc4626}}",
            ),
            (
                "properties/recon-lens.md",
                "{{artifact_handoff:reference-properties-recon}}",
            ),
        ];
        for relative_path in [
            "properties/0kn0t-lens.md",
            "properties/certora-thinking-lens.md",
            "properties/aviggiano-lens.md",
            "properties/josselin-feist-lens.md",
            "properties/property-specification-crytic.md",
            "properties/property-specification-runtime-verification.md",
            "properties/property-specification-a16z.md",
            "properties/recon-lens.md",
        ] {
            let property_prompt =
                fs::read_to_string(temp.path().join(".ultrafuzz/prompts").join(relative_path))
                    .unwrap();
            assert!(
                property_prompt.contains("{{artifact_handoff:project-discovery}}"),
                "{relative_path} should read the project discovery handoff"
            );
            assert!(
                property_prompt.contains("{{artifact_handoff:actors-flows}}"),
                "{relative_path} should read the actor and flow handoff"
            );
            assert!(
                property_prompt.contains("{{artifact_handoff:base-test-setup}}"),
                "{relative_path} should read the base test setup handoff"
            );
            let (_, expected_reference) = external_reference_prompts
                .iter()
                .find(|(external_path, _)| *external_path == relative_path)
                .unwrap_or_else(|| {
                    panic!("missing expected reference assertion for {relative_path}")
                });
            assert!(
                property_prompt.contains(expected_reference),
                "{relative_path} should keep its pinned reference handoff"
            );
            assert!(
                !property_prompt.contains("Do not fetch remote reference material"),
                "{relative_path} should not replace URL references with no-fetch guidance"
            );
            assert!(
                !property_prompt.contains("offline"),
                "{relative_path} should not replace URL references with offline summaries"
            );
            assert!(
                property_prompt.contains("property candidates are planning material"),
                "{relative_path} should keep property candidates out of findings.json"
            );
            assert!(
                property_prompt.contains("Do not use Bash to validate the property catalog"),
                "{relative_path} should avoid shell-based property artifact validation"
            );
        }
        let josselin_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/properties/josselin-feist-lens.md"),
        )
        .unwrap();
        assert!(
            josselin_prompt.contains("{{artifact_handoff:reference-properties-montyly-rounding}}")
        );
        assert!(!josselin_prompt.contains("https://"));
        assert!(josselin_prompt.contains("{{artifact_path}}/properties/josselin-feist.md"));
        let recon_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/properties/recon-lens.md"),
        )
        .unwrap();
        assert!(recon_prompt.contains("{{artifact_handoff:reference-properties-recon}}"));
        assert!(!recon_prompt.contains("https://"));
        assert!(recon_prompt.contains("{{artifact_path}}/properties/recon.md"));
        let workflow_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/workflow-property-based-tests.md"),
        )
        .unwrap();
        assert!(workflow_prompt.contains("{{artifact_handoff:actors-flows}}"));
        assert!(workflow_prompt.contains("{{artifact_handoff:base-test-setup}}"));
        assert!(workflow_prompt.contains("{{artifact_handoff:property-specification-fanin}}"));
        assert!(workflow_prompt.contains("timeout_seconds: 3600"));
        assert!(workflow_prompt.contains("Topology Runtime Context"));
        assert!(workflow_prompt.contains("configured reserve"));
        assert!(workflow_prompt.contains("{{output_findings_path}}"));
        assert!(workflow_prompt.contains("broad `forge build`"));
        assert!(!workflow_prompt.contains("{{artifact_handoff:boundary-tests}}"));
        let round_trip_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/round-trip.md"),
        )
        .unwrap();
        assert!(round_trip_prompt.contains("timeout_seconds: 3600"));
        assert!(round_trip_prompt.contains("Topology Runtime Context"));
        assert!(round_trip_prompt.contains("configured reserve"));
        assert!(round_trip_prompt.contains("{{output_findings_path}}"));
        assert!(round_trip_prompt.contains("broad `forge build`"));
        assert!(round_trip_prompt.contains("Do not hide missing directories with redirection"));
        assert!(round_trip_prompt.contains("let missing-path stderr be captured by"));
        let encode_decode_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/encode-decode.md"),
        )
        .unwrap();
        assert!(encode_decode_prompt.contains("timeout_seconds: 3600"));
        assert!(encode_decode_prompt.contains("Topology Runtime Context"));
        assert!(encode_decode_prompt.contains("configured reserve"));
        assert!(encode_decode_prompt.contains("{{output_findings_path}}"));
        assert!(encode_decode_prompt.contains("broad `forge build`"));
        let expand_coverage_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/expand-coverage.md"),
        )
        .unwrap();
        assert!(expand_coverage_prompt.contains("timeout_seconds: 3600"));
        assert!(expand_coverage_prompt.contains("Topology Runtime Context"));
        assert!(expand_coverage_prompt.contains("configured reserve"));
        assert!(expand_coverage_prompt.contains("{{output_findings_path}}"));
        assert!(expand_coverage_prompt.contains("focused generated-test commands"));
        assert!(expand_coverage_prompt.contains("broad `forge build`"));
        let time_warp_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/time-warp-sequences.md"),
        )
        .unwrap();
        assert!(time_warp_prompt.contains("timeout_seconds: 3600"));
        assert!(time_warp_prompt.contains("id: time-warp-sequences"));
        assert!(time_warp_prompt.contains("display_name: Time-Warp Sequences"));
        assert!(time_warp_prompt.contains("{{artifact_handoff:base-test-setup}}"));
        assert!(time_warp_prompt.contains("{{artifact_handoff:property-specification-fanin}}"));
        assert!(time_warp_prompt.contains("generated Foundry tests as `.t.sol` files"));
        assert!(time_warp_prompt.contains("vm.warp(block.timestamp + boundedDelta)"));
        assert!(time_warp_prompt.contains("Foundry/Chimera-style stateful sequence handler"));
        assert!(time_warp_prompt
            .contains("`surface_index % {{strategy_loop_count}} == {{strategy_loop_index}}`"));
        assert!(time_warp_prompt.contains("Do not prepend `cd`, `cd\n... || exit 1`"));
        assert!(time_warp_prompt.contains("Use `forge --version` by itself"));
        assert!(time_warp_prompt.contains("`strategy` as"));
        assert!(time_warp_prompt.contains("\"{{strategy}}\""));
        let expand_coverage_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/expand-coverage.md"),
        )
        .unwrap();
        assert!(expand_coverage_prompt.contains("keep each probe\nseparate"));
        assert!(expand_coverage_prompt.contains("Run one Bash call for each inspected path"));
        for relative_path in [
            "strategies/differential-library-tests.md",
            "strategies/encode-decode.md",
            "strategies/expand-coverage.md",
            "strategies/round-trip.md",
            "strategies/time-warp-sequences.md",
            "strategies/workflow-property-based-tests.md",
        ] {
            let markdown =
                fs::read_to_string(temp.path().join(".ultrafuzz/prompts").join(relative_path))
                    .unwrap();
            assert!(
                markdown.contains("Passing test coverage is not a finding"),
                "{relative_path} should keep passing generated-test summaries out of findings.json"
            );
            assert!(
                markdown.contains("Write `[]` to `findings.json`"),
                "{relative_path} should require empty findings for no-defect passing tests"
            );
            assert!(
                markdown.contains("Run build, list, and test validation as separate Bash calls"),
                "{relative_path} should steer Claude away from chained validation commands"
            );
        }
        let state_machine_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/state-machine-boundaries.md"),
        )
        .unwrap();
        assert!(state_machine_prompt.contains("timeout_seconds: 3600"));
        assert!(state_machine_prompt.contains("id: state-machine-boundaries"));
        assert!(state_machine_prompt.contains("display_name: State Machine Boundaries"));
        for relative_path in [
            "strategies/amm-boundary-liquidity.md",
            "strategies/admin-config-boundaries.md",
            "strategies/batch-atomicity-unsupported-actions.md",
            "strategies/boundary-tests.md",
            "strategies/differential-library-tests.md",
            "strategies/encode-decode.md",
            "strategies/expand-coverage.md",
            "strategies/externalized-state-accounting.md",
            "strategies/lifecycle-view-boundaries.md",
            "strategies/market-exhaustion-boundaries.md",
            "strategies/order-replacement-collateral.md",
            "strategies/packed-action-parity.md",
            "strategies/payable-fallback-accounting.md",
            "strategies/round-trip.md",
            "strategies/rounding-direction-audit.md",
            "strategies/router-exact-accounting.md",
            "strategies/state-machine-boundaries.md",
            "strategies/time-warp-sequences.md",
            "strategies/workflow-property-based-tests.md",
        ] {
            let markdown =
                fs::read_to_string(temp.path().join(".ultrafuzz/prompts").join(relative_path))
                    .unwrap();
            let parsed = parse_prompt_document(&markdown).unwrap();
            assert_eq!(
                parsed.frontmatter.loops, None,
                "normal strategy prompt `{relative_path}` should inherit topology strategy loops"
            );
        }
        for (relative_path, expected_loops) in [
            ("strategies/dynamic-strategy-generator.md", None),
            ("strategies/invariants/setup.md", Some(1)),
            ("strategies/invariants/handlers.md", Some(1)),
            ("strategies/invariants/coverage.md", Some(1)),
            ("strategies/invariants/implement-properties.md", Some(1)),
            (
                "strategies/invariants/invariant-testing-campaign.md",
                Some(1),
            ),
            (
                "strategies/differential/differential-oracle-planner.md",
                None,
            ),
            ("strategies/differential/reference-harness-author.md", None),
            (
                "strategies/differential/reference-and-lane-auditor.md",
                None,
            ),
            ("strategies/differential/differential-lane-author.md", None),
            ("strategies/differential/differential-red-triage.md", None),
            (
                "strategies/differential/differential-repair-and-report-review.md",
                None,
            ),
        ] {
            let markdown =
                fs::read_to_string(temp.path().join(".ultrafuzz/prompts").join(relative_path))
                    .unwrap();
            let parsed = parse_prompt_document(&markdown).unwrap();
            assert_eq!(
                parsed.frontmatter.loops,
                expected_loops,
                "excluded strategy prompt `{relative_path}` must retain its configured loop semantics"
            );
        }
        let invariant_setup_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/invariants/setup.md"),
        )
        .unwrap();
        assert!(invariant_setup_prompt
            .contains("{{artifact_path:base-test-setup}}/setup/base-test-setup.md"));
        assert!(invariant_setup_prompt.contains("project-pinned restoration path"));
        assert!(invariant_setup_prompt.contains("Do not run dependency install commands"));
        let invariant_handlers_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/invariants/handlers.md"),
        )
        .unwrap();
        assert!(invariant_handlers_prompt.contains("project-pinned restoration path"));
        assert!(invariant_handlers_prompt.contains("Do not run dependency install commands"));
        let invariant_coverage_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/invariants/coverage.md"),
        )
        .unwrap();
        assert!(invariant_coverage_prompt
            .contains("{{artifact_path:property-specification-fanin}}/properties.md"));
        assert!(invariant_coverage_prompt
            .contains("Treat coverage tooling as a workspace command surface"));
        assert!(invariant_coverage_prompt.contains("Topology Runtime"));
        assert!(invariant_coverage_prompt.contains("configured finalization reserve"));
        assert!(invariant_coverage_prompt.contains("shorter `timeout <duration>` wrapper"));
        assert!(invariant_coverage_prompt
            .contains("Do not run remote package availability probes such as `npm view`"));
        assert!(invariant_coverage_prompt.contains("checkpoint versions"));
        assert!(invariant_coverage_prompt.contains("Never leave all required"));
        assert!(invariant_coverage_prompt.contains("a timed-out node with no report is not"));
        let invariant_implementation_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/invariants/implement-properties.md"),
        )
        .unwrap();
        assert!(invariant_implementation_prompt.contains("timeout_seconds: 3600"));
        assert!(invariant_implementation_prompt
            .contains("{{artifact_path:property-specification-fanin}}/properties.md"));
        assert!(
            invariant_implementation_prompt.contains("{{invariant_property_priority_threshold}}")
        );
        assert!(invariant_implementation_prompt.contains("{{invariant_property_priorities}}"));
        assert!(invariant_implementation_prompt
            .contains("{{artifact_dir}}/implemented-properties.json"));
        let recon_campaign_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/invariants/invariant-testing-campaign.md"),
        )
        .unwrap();
        assert!(recon_campaign_prompt.contains("timeout_seconds: 3600"));
        assert!(recon_campaign_prompt.contains("display_name: Invariant testing campaign"));
        assert!(recon_campaign_prompt.contains(
            "{{artifact_path:stateful-invariant-implement-properties}}/implemented-properties.json"
        ));
        assert!(recon_campaign_prompt.contains("{{invariant_testing_fuzzer_timeout}}"));
        assert!(recon_campaign_prompt.contains("{{artifact_dir}}/recon-fuzzer-results.json"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/properties/property-specification-crytic.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/properties/property-specification-runtime-verification.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/properties/property-specification-a16z.md")
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
        let differential_planner_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/differential/differential-oracle-planner.md"),
        )
        .unwrap();
        assert!(differential_planner_prompt.contains("{{artifact_handoff:base-test-setup}}"));
        assert!(differential_planner_prompt
            .contains("{{artifact_handoff:property-specification-fanin}}"));
        assert!(differential_planner_prompt
            .contains("Do not edit repository source files; write only the required artifacts."));
        assert!(!differential_planner_prompt.contains("Do not edit files."));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/differential/reference-harness-author.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/differential/reference-and-lane-auditor.md")
            .exists());
        let lane_auditor_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/differential/reference-and-lane-auditor.md"),
        )
        .unwrap();
        assert!(lane_auditor_prompt
            .contains("Do not edit repository source files; write only the required artifacts."));
        assert!(!lane_auditor_prompt.contains("Do not edit files."));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/differential/differential-lane-author.md")
            .exists());
        let lane_author_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/differential/differential-lane-author.md"),
        )
        .unwrap();
        assert!(lane_author_prompt.contains("\"attempt_index\": {{attempt_index}},"));
        assert!(!lane_author_prompt.contains("\"attempt_index\": 0,"));
        assert!(lane_author_prompt.contains("Do not search from filesystem root"));
        assert!(lane_author_prompt.contains("explicit artifact paths"));
        assert!(lane_author_prompt.contains("unredirected `find test/foundry"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/differential/differential-red-triage.md")
            .exists());
        assert!(temp
            .path()
            .join(
                ".ultrafuzz/prompts/strategies/differential/differential-repair-and-report-review.md"
            )
            .exists());
        let repair_review_prompt = fs::read_to_string(temp.path().join(
            ".ultrafuzz/prompts/strategies/differential/differential-repair-and-report-review.md",
        ))
        .unwrap();
        assert!(repair_review_prompt
            .contains("Semantic red registries:\n{{artifact_handoff:differential-red-triage}}"));
        assert!(repair_review_prompt.contains(
            "Triage A artifacts:\n{{artifact_path:differential-red-triage}}/triage-a.json"
        ));
        assert!(repair_review_prompt
            .contains("Lane results:\n{{artifact_handoff:differential-lane-author}}"));
        assert!(repair_review_prompt
            .contains("This workspace should include direct replay of `base-test-setup` fixtures"));
        assert!(!repair_review_prompt
            .contains("- Registry: {{artifact_handoff:differential-red-triage}}"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/round-trip.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/workflow-property-based-tests.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/time-warp-sequences.md")
            .exists());
        let time_warp_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/time-warp-sequences.md"),
        )
        .unwrap();
        assert!(time_warp_prompt.contains("timeout_seconds: 3600"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/expand-coverage.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/boundary-tests.md")
            .exists());
        let admin_config_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/admin-config-boundaries.md"),
        )
        .unwrap();
        assert!(admin_config_prompt.contains("id: admin-config-boundaries"));
        assert!(admin_config_prompt.contains("display_name: Admin / Config Boundaries"));
        assert!(admin_config_prompt.contains("timeout_seconds: 3600"));
        assert!(admin_config_prompt.contains("Positive authorized call"));
        assert!(admin_config_prompt.contains("Unauthorized rejection"));
        assert!(admin_config_prompt.contains("Getter reflection"));
        assert!(admin_config_prompt.contains("Selector/name mismatch"));
        assert!(admin_config_prompt.contains("implementation-drift"));
        assert!(admin_config_prompt.contains("incomplete-spec"));
        assert!(admin_config_prompt.contains("{{artifact_handoff:project-discovery}}"));
        assert!(admin_config_prompt.contains("{{artifact_handoff:property-specification-fanin}}"));
        assert!(admin_config_prompt.contains("{{artifact_dir}}/admin-config-boundary-matrix.md"));
        assert!(admin_config_prompt.contains("{{artifact_dir}}/admin-config-boundary-matrix.json"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/amm-boundary-liquidity.md")
            .exists());
        let amm_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/amm-boundary-liquidity.md"),
        )
        .unwrap();
        assert!(amm_prompt.contains("id: amm-boundary-liquidity"));
        assert!(amm_prompt.contains("display_name: AMM Boundary Liquidity"));
        assert!(amm_prompt.contains("timeout_seconds: 3600"));
        assert!(amm_prompt.contains("When validating AMM boundary-liquidity tests"));
        assert!(amm_prompt.contains("run one direct Forge command at a\ntime"));
        assert!(amm_prompt.contains("Do not use shell redirection"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/payable-fallback-accounting.md")
            .exists());
        let externalized_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/externalized-state-accounting.md"),
        )
        .unwrap();
        assert!(externalized_prompt.contains("id: externalized-state-accounting"));
        assert!(externalized_prompt.contains("display_name: Externalized-State Accounting"));
        assert!(externalized_prompt.contains("pending, durable, or externally represented state"));
        assert!(externalized_prompt.contains("late-entry, exit, reward/fee"));
        assert!(externalized_prompt.contains("active-state decrease caps"));
        assert!(externalized_prompt.contains("public view liveness"));
        let dynamic_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/dynamic-strategy-generator.md"),
        )
        .unwrap();
        assert!(dynamic_prompt.contains("id: dynamic-strategy-generator"));
        assert!(dynamic_prompt.contains("display_name: Dynamic strategy generator"));
        assert!(dynamic_prompt.contains("timeout_seconds: 14400"));
        assert!(dynamic_prompt.contains("{{dynamic_strategies_enumerator}}"));
        assert!(dynamic_prompt.contains("max-reasoning"));
        assert!(dynamic_prompt.contains("{{artifact_dir}}/strategy-plan.json"));
        assert!(dynamic_prompt.contains("{{artifact_dir}}/enumerator-outputs.json"));
        assert!(dynamic_prompt.contains("{{artifact_dir}}/aggregate-recommendations.json"));
        assert!(dynamic_prompt.contains("{{artifact_dir}}/selected-strategies.json"));
        assert!(dynamic_prompt.contains("{{artifact_dir}}/generated-tests.json"));
        assert!(dynamic_prompt.contains("{{artifact_dir}}/provenance.json"));
        assert!(dynamic_prompt.contains("{{output_findings_path}}"));
        let packed_action_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/packed-action-parity.md"),
        )
        .unwrap();
        assert!(packed_action_prompt.contains("id: packed-action-parity"));
        assert!(packed_action_prompt.contains("display_name: Packed Action Parity"));
        assert!(packed_action_prompt.contains("alternate encoded action entrypoints"));
        assert!(packed_action_prompt.contains("timeout_seconds: 3600"));
        assert!(packed_action_prompt.contains("Placement, cancellation, decrease, replacement"));
        assert!(packed_action_prompt.contains("native protocol identifiers"));
        assert!(packed_action_prompt.contains("externally supplied client/order"));
        assert!(packed_action_prompt.contains("Semantic Field-Width Carrier Matrix"));
        assert!(packed_action_prompt.contains("structured batch/multicall carrier"));
        assert!(packed_action_prompt.contains("mask or truncate"));
        assert!(packed_action_prompt.contains("side or direction such as bid/ask"));
        assert!(packed_action_prompt.contains("identifier kind such as native protocol ids"));
        assert!(packed_action_prompt.contains("settlement mode such as external transfer/approval"));
        assert!(packed_action_prompt.contains("canonical/default market"));
        assert!(packed_action_prompt.contains("non-default token decimals, price scale"));
        assert!(packed_action_prompt.contains("Empty-level cleanup"));
        assert!(packed_action_prompt.contains("Best-price, top-of-book"));
        assert!(packed_action_prompt.contains("run one direct Forge command at a time"));
        assert!(packed_action_prompt.contains("Do not use shell redirection"));
        assert!(packed_action_prompt.contains("payable-accounting finding"));
        assert!(packed_action_prompt.contains("stale-value or view-refresh finding"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/batch-atomicity-unsupported-actions.md")
            .exists());
        let batch_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/batch-atomicity-unsupported-actions.md"),
        )
        .unwrap();
        assert!(batch_prompt.contains("run one simple command at a\ntime"));
        assert!(batch_prompt.contains("stdout/stderr\nredirection"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/router-exact-accounting.md")
            .exists());
        let router_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/router-exact-accounting.md"),
        )
        .unwrap();
        assert!(router_prompt.contains("timeout_seconds: 3600"));
        assert!(router_prompt.contains("run one direct Forge command at a\ntime"));
        assert!(router_prompt.contains("Do not use shell redirection"));
        assert!(router_prompt.contains("output-shortening wrappers"));
        let rounding_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/rounding-direction-audit.md"),
        )
        .unwrap();
        assert!(rounding_prompt.contains("id: rounding-direction-audit"));
        assert!(rounding_prompt.contains("timeout_seconds: 3600"));
        assert!(rounding_prompt.contains("fee, share, exchange-rate"));
        assert!(rounding_prompt.contains("When validating rounding-direction tests"));
        assert!(rounding_prompt.contains("run one direct Forge command at a time"));
        assert!(rounding_prompt.contains("Do not use shell redirection"));
        assert!(rounding_prompt.contains("Repeated-operation sequences"));
        assert!(rounding_prompt.contains("expected"));
        assert!(rounding_prompt.contains("rounding direction"));
        assert!(rounding_prompt.contains("observed violation"));
        let market_exhaustion_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/market-exhaustion-boundaries.md"),
        )
        .unwrap();
        assert!(market_exhaustion_prompt.contains("timeout_seconds: 3600"));
        assert!(market_exhaustion_prompt.contains("When validating market-exhaustion tests"));
        assert!(market_exhaustion_prompt.contains("run one direct Forge command at a time"));
        assert!(market_exhaustion_prompt.contains("Do not use shell redirection"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/order-replacement-collateral.md")
            .exists());
        let order_replacement_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/order-replacement-collateral.md"),
        )
        .unwrap();
        assert!(order_replacement_prompt.contains("timeout_seconds: 3600"));
        assert!(order_replacement_prompt.contains("one direct workspace-relative command"));
        assert!(order_replacement_prompt.contains("Do\nnot pipe `grep` into"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/state-machine-boundaries.md")
            .exists());
        let state_machine_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/strategies/state-machine-boundaries.md"),
        )
        .unwrap();
        assert!(state_machine_prompt.contains("timeout_seconds: 3600"));
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/lifecycle-view-boundaries.md")
            .exists());
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/review/final-report.md")
            .exists());
        let triage_prompt =
            fs::read_to_string(temp.path().join(".ultrafuzz/prompts/review/triage.md")).unwrap();
        assert!(triage_prompt.contains("id: triage"));
        assert!(triage_prompt.contains("display_name: Triage"));
        assert!(triage_prompt
            .contains("Perform {{triage_panel_size}} independent investigation passes"));
        assert!(triage_prompt
            .contains("If at least {{triage_quorum}} of {{triage_panel_size}} passes agree"));
        assert!(triage_prompt
            .contains("If no classification reaches {{triage_quorum}}-of-{{triage_panel_size}}"));
        assert!(triage_prompt.contains("agreement, classify the finding as `undetermined`"));
        assert!(triage_prompt.contains("`true-positive`: credible production issue"));
        assert!(triage_prompt.contains("`incomplete-spec`: public specification or policy"));
        assert!(triage_prompt.contains("`harness-defect`: the generated test or harness"));
        assert!(triage_prompt.contains("`repair-candidate`: a local generated test"));
        assert!(triage_prompt.contains("`spec-gated`: behavior may be valid or invalid"));
        assert!(triage_prompt.contains("`defensive-hardening`: not a production bug"));
        assert!(triage_prompt.contains("{{artifact_path:dedupe-findings}}/deduped-findings.json"));
        assert!(triage_prompt.contains("{{artifact_path}}/triaged-findings.json"));
        let severity_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/review/severity-classification.md"),
        )
        .unwrap();
        assert!(severity_prompt.contains("id: severity-classification"));
        assert!(severity_prompt.contains("display_name: Severity classification"));
        assert!(severity_prompt.contains("Severity is `Likelihood x Impact`"));
        assert!(severity_prompt.contains("sub agents with maximum reasoning capacity"));
        assert!(severity_prompt.contains("## Severity classification"));
        assert!(severity_prompt.contains("Treat Invalid and out-of-scope outcomes"));
        assert!(!severity_prompt.contains("Code4rena"));
        assert!(
            severity_prompt.contains("Set top-level `severity` to the final classified severity")
        );
        assert!(severity_prompt.contains("Also set `severity_guess` to the same value"));
        assert!(severity_prompt.contains("Do not carry an upstream"));
        assert!(severity_prompt.contains("`likelihood=<low|medium|high>`"));
        assert!(severity_prompt.contains("`impact=<low|medium|high>`"));
        assert!(!severity_prompt.contains("http://"));
        assert!(!severity_prompt.contains("https://"));
        assert!(severity_prompt.contains("{{artifact_path:triage}}/triaged-findings.json"));
        assert!(severity_prompt.contains("Preserve each finding's `triage_classification`"));
        assert!(severity_prompt.contains("`repair-candidate`"));
        assert!(severity_prompt.contains("`spec-gated`"));
        assert!(severity_prompt.contains("`defensive-hardening`"));
        assert!(
            severity_prompt.contains("{{artifact_path:dedupe-findings}}/strategy-detections.json")
        );
        assert!(severity_prompt.contains("{{artifact_path}}/severity-classified-findings.json"));
        assert!(severity_prompt.contains("{{artifact_path}}/strategy-detections.json"));
        let aggregate_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/review/aggregate-test-files.md"),
        )
        .unwrap();
        assert!(
            !aggregate_prompt.contains("{{artifact_path:dedupe-findings}}/generated-tests.json")
        );
        assert!(aggregate_prompt.contains("Prefer the Read tool for the exact manifest files"));
        assert!(aggregate_prompt.contains("Do not use shell pipelines or chained\ncommands"));
        assert!(aggregate_prompt.contains("Wrong: `ls {{artifact_path}} | sort`"));
        assert!(aggregate_prompt.contains("use standalone `wc -c <path>` commands"));
        assert!(aggregate_prompt.contains("Do not use `stat`"));
        assert!(aggregate_prompt.contains("with no pipes or command chaining"));
        assert!(aggregate_prompt.contains("{{artifact_path:encode-decode}}/generated-tests.json"));
        assert!(aggregate_prompt.contains("{{artifact_path:boundary-tests}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:differential-library-tests}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:reference-harness-author}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:differential-lane-author}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:stateful-invariant-coverage}}/generated-tests.json"));
        assert!(aggregate_prompt.contains(
            "{{artifact_path:stateful-invariant-implement-properties}}/generated-tests.json"
        ));
        assert!(aggregate_prompt
            .contains("{{artifact_path:stateful-invariant-recon-campaign}}/generated-tests.json"));
        assert!(
            aggregate_prompt.contains("{{artifact_path:time-warp-sequences}}/generated-tests.json")
        );
        assert!(aggregate_prompt
            .contains("{{artifact_path:admin-config-boundaries}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:external-dependency-boundaries}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:amm-boundary-liquidity}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:payable-fallback-accounting}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:externalized-state-accounting}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:packed-action-parity}}/generated-tests.json"));
        assert!(aggregate_prompt.contains(
            "{{artifact_path:batch-atomicity-unsupported-actions}}/generated-tests.json"
        ));
        assert!(aggregate_prompt
            .contains("{{artifact_path:router-exact-accounting}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:rounding-direction-audit}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:market-exhaustion-boundaries}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:order-replacement-collateral}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:state-machine-boundaries}}/generated-tests.json"));
        assert!(aggregate_prompt
            .contains("{{artifact_path:lifecycle-view-boundaries}}/generated-tests.json"));
        assert!(aggregate_prompt.contains("Read every\nmanifest listed above"));
        assert!(aggregate_prompt
            .contains("Do not rely on the current\nworking tree or a strategy workspace scan"));
        assert!(aggregate_prompt.contains(
            "{{artifact_path:severity-classification}}/severity-classified-findings.json"
        ));
        assert!(aggregate_prompt.contains("The original target repository root is:"));
        assert!(aggregate_prompt.contains("{{repo_path}}"));
        assert!(aggregate_prompt.contains("Do not run commands against `{{repo_path}}`"));
        assert!(aggregate_prompt.contains("Use `{{workspace_path}}` as the destination root"));
        assert!(aggregate_prompt
            .contains("absolute path under `{{workspace_path}}`, not under\n`{{repo_path}}`"));
        assert!(aggregate_prompt.contains("`source_test_files`"));
        assert!(aggregate_prompt.contains("`copied_test_files`"));
        assert!(aggregate_prompt.contains("`source_support_files`"));
        assert!(aggregate_prompt.contains("`copied_support_files`"));
        assert!(aggregate_prompt.contains("`files`: array of copied `.t.sol` test records"));
        assert!(aggregate_prompt.contains("`support_files`: array of copied helper `.sol` records"));
        assert!(aggregate_prompt.contains("`skipped_files`: array of skipped file records"));
        let final_report_prompt = fs::read_to_string(
            temp.path()
                .join(".ultrafuzz/prompts/review/final-report.md"),
        )
        .unwrap();
        assert!(
            final_report_prompt.contains("{{artifact_path:aggregate-test-files}}/aggregation.json")
        );
        assert!(final_report_prompt.contains("`support_files` array"));
        assert!(final_report_prompt.contains("`skipped_files`"));
        assert!(final_report_prompt.contains(
            "{{artifact_path:severity-classification}}/severity-classified-findings.json"
        ));
        assert!(final_report_prompt
            .contains("{{artifact_path:severity-classification}}/strategy-detections.json"));
        assert!(
            final_report_prompt.contains("{{artifact_path:dedupe-findings}}/deduped-findings.json")
        );
        assert!(final_report_prompt
            .contains("{{artifact_path:project-discovery}}/setup/project-discovery.md"));
        assert!(
            final_report_prompt.contains("{{artifact_path:setup-foundry}}/setup/setup-foundry.md")
        );
        assert!(final_report_prompt
            .contains("{{artifact_path:base-test-setup}}/setup/base-test-setup.md"));
        assert!(final_report_prompt
            .contains("Emit concise production issue entries for production-bug findings"));
        assert!(
            final_report_prompt.contains("`incomplete-spec`, `harness-defect`, `repair-candidate`")
        );
        assert!(final_report_prompt.contains("## Non-production actionable outcomes"));
        assert!(final_report_prompt.contains("conditional Public Reachability section"));
        assert!(final_report_prompt.contains("non-production"));
        assert!(final_report_prompt.contains("actionable outcomes appendix"));
        assert!(final_report_prompt.contains("`non_production_outcomes` array"));
        assert!(final_report_prompt.contains("`recommended_next_action`"));
        assert!(final_report_prompt.contains("# Ultrafuzz report"));
        assert!(final_report_prompt.contains("Sort production issue entries by severity"));
        assert!(final_report_prompt.contains("Markdown\nissue index table"));
        assert!(final_report_prompt.contains("| Issue id | Title |"));
        assert!(final_report_prompt
            .contains("| H-01 | [[H-01] - <issue title>](#h-01---issue-title-anchor) |"));
        assert!(!final_report_prompt.contains("table of contents"));
        assert!(final_report_prompt.contains("automated Solidity fuzzing campaign assistant"));
        assert!(final_report_prompt.contains("must be manually validated"));
        assert!(final_report_prompt.contains("does not guarantee the protocol is secure"));
        assert!(final_report_prompt.contains("assign issue title IDs independently per severity"));
        assert!(final_report_prompt.contains("Use `H` for High, `M` for Medium, and `L` for Low"));
        assert!(final_report_prompt
            .contains("severity classification node's top-level\n`severity` field"));
        assert!(final_report_prompt.contains("legacy `severity_guess`, it must match `severity`"));
        assert!(
            final_report_prompt.contains("stop and report the invalid\nupstream classification")
        );
        assert!(final_report_prompt
            .contains("## [<H|M|L>-<two digit severity-local id>] - <concise issue title"));
        assert!(final_report_prompt.contains("## Run summary"));
        assert!(final_report_prompt.contains("- Source run ID:"));
        assert!(final_report_prompt.contains("- Continuation mode:"));
        assert!(final_report_prompt.contains("- Reused nodes:"));
        assert!(final_report_prompt.contains("run.json#reused_nodes"));
        assert!(final_report_prompt.contains("write `unavailable` instead of guessing"));
        assert!(!final_report_prompt.contains(concat!("unavailable", " note")));
        assert!(final_report_prompt.contains("{{run_metadata_path}}/state.json"));
        assert!(final_report_prompt.contains("persisted `usage` object in `state.json`"));
        assert!(final_report_prompt.contains("embedded `Run\nAccounting` runtime context"));
        assert!(final_report_prompt.contains("embedded `Run Summary Context` runtime context"));
        assert!(final_report_prompt.contains("{{run_metadata_path}}/graph.json"));
        assert!(final_report_prompt
            .contains("<Actor or role> can do X/Y/Z which leads to A/B/C/loss of funds"));
        assert!(final_report_prompt.contains("Do not use the combined wording `User/Attacker`"));
        assert!(final_report_prompt.contains("\n### Severity\n"));
        assert!(final_report_prompt.contains("- **Impact**: <Impact>:"));
        assert!(final_report_prompt.contains("- **Likelihood**: <Likelihood>:"));
        assert!(!final_report_prompt.contains("### Severity (Likelihood x Impact)"));
        assert!(!final_report_prompt.contains("<Severity> (<Likelihood> x <Impact>)"));
        assert!(!final_report_prompt.contains("#### Likelihood"));
        assert!(!final_report_prompt.contains("#### Impact"));
        assert!(final_report_prompt.contains("### Proof of Concept"));
        assert!(!final_report_prompt.contains(concat!("Local generated-file", " permalink")));
        assert!(!final_report_prompt.contains(concat!("local generated-file", " permalink")));
        assert!(final_report_prompt.contains("minimized self-contained Foundry\nreproducer"));
        assert!(final_report_prompt.contains("Do not write\nlocal file paths"));
        assert!(final_report_prompt.contains("severity finding's explicit generated test path"));
        assert!(final_report_prompt.contains("same-path generated tests differ across\nattempts"));
        assert!(!final_report_prompt
            .contains(concat!("Use the local generated-file", " permalink below")));
        assert!(final_report_prompt.contains("#### Family variants"));
        assert!(
            final_report_prompt.contains("not include local paths, links, or artifact provenance")
        );
        assert!(final_report_prompt.contains("1. <Actor> performs the relevant action."));
        assert!(final_report_prompt.contains("```solidity"));
        assert!(final_report_prompt.contains("### Strategy"));
        assert!(final_report_prompt.contains("| Strategy | Detection rate |"));
        assert!(final_report_prompt
            .contains("The production issue `title` value must include the same"));
        assert!(!final_report_prompt.contains("Found in attempts:"));
        assert!(
            final_report_prompt.contains("Match\nstrategy detections by stable `dedupe_key` first")
        );
        assert!(final_report_prompt
            .contains("never merge\ndistinct records merely because they reuse a display id"));
        assert!(final_report_prompt.contains("loop-attempt provenance"));
        assert!(final_report_prompt.contains("`report.json`"));
        assert!(final_report_prompt.contains("human-readable"));
        assert!(final_report_prompt.contains("Strategy section"));
        assert!(final_report_prompt.contains("metric Temperature"));
        assert!(final_report_prompt
            .contains("Do not add executive summaries, methodology, environment notes"));
        assert!(!final_report_prompt.contains("Summarize the project discovery decisions"));
        assert!(
            !final_report_prompt.contains("{{artifact_path:dedupe-findings}}/generated-tests.json")
        );
        assert!(temp
            .path()
            .join(".ultrafuzz/prompts/strategies/invariants/setup.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/strategies/differential.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/strategies/decode_encode.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/strategies/round_trip.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/strategies/property_based_strict_equality.md")
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
            .join(".ultrafuzz/prompts/nodes/project-discovery.md")
            .exists());
        assert!(!temp
            .path()
            .join(".ultrafuzz/prompts/nodes/final-report.md")
            .exists());

        fs::write(&prompt_path, "custom").unwrap();
        let second = scaffold_project_prompts(temp.path(), false).unwrap();
        assert_eq!(second.written.len(), 0);
        assert_eq!(second.skipped.len(), PROJECT_TOPOLOGY_PROMPTS.len());
        assert_eq!(fs::read_to_string(&prompt_path).unwrap(), "custom");

        let forced = scaffold_project_prompts(temp.path(), true).unwrap();
        assert_eq!(forced.written.len(), PROJECT_TOPOLOGY_PROMPTS.len());
        assert_eq!(
            fs::read_to_string(prompt_path).unwrap(),
            topology_prompt_markdown("strategies/encode-decode.md").unwrap()
        );
    }

    #[cfg(unix)]
    fn assert_scaffold_symlink_error(error: &PromptError) {
        let message = error.to_string();
        assert!(message.contains("symlink"), "{message}");
        assert!(message.contains("remove or replace"), "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn scaffold_project_prompts_rejects_symlinked_ultrafuzz_dir() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join(".ultrafuzz")).unwrap();

        let error = scaffold_project_prompts(temp.path(), false).unwrap_err();

        assert_scaffold_symlink_error(&error);
        assert!(!outside
            .path()
            .join("prompts/setup/project-discovery.md")
            .exists());
    }

    #[cfg(unix)]
    #[test]
    fn scaffold_project_prompts_rejects_symlinked_prompt_dir() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let ultrafuzz_dir = temp.path().join(".ultrafuzz");
        fs::create_dir_all(&ultrafuzz_dir).unwrap();
        std::os::unix::fs::symlink(outside.path(), ultrafuzz_dir.join("prompts")).unwrap();

        let error = scaffold_project_prompts(temp.path(), false).unwrap_err();

        assert_scaffold_symlink_error(&error);
        assert!(!outside.path().join("setup/project-discovery.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn scaffold_project_prompts_rejects_nested_prompt_dir_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let prompt_dir = temp.path().join(".ultrafuzz/prompts");
        fs::create_dir_all(&prompt_dir).unwrap();
        std::os::unix::fs::symlink(outside.path(), prompt_dir.join("setup")).unwrap();

        let error = scaffold_project_prompts(temp.path(), false).unwrap_err();

        assert_scaffold_symlink_error(&error);
        assert!(!outside.path().join("project-discovery.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn scaffold_project_prompts_rejects_forced_destination_prompt_file_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        scaffold_project_prompts(temp.path(), false).unwrap();
        let outside_file = outside.path().join("outside.md");
        fs::write(&outside_file, "outside").unwrap();
        let prompt_path = temp
            .path()
            .join(".ultrafuzz/prompts/strategies/encode-decode.md");
        fs::remove_file(&prompt_path).unwrap();
        std::os::unix::fs::symlink(&outside_file, &prompt_path).unwrap();

        let error = scaffold_project_prompts(temp.path(), true).unwrap_err();

        assert_scaffold_symlink_error(&error);
        assert_eq!(fs::read_to_string(outside_file).unwrap(), "outside");
    }

    #[test]
    fn scaffolded_topology_strategy_categories_use_canonical_ids() {
        let temp = tempfile::tempdir().unwrap();
        scaffold_project_prompts(temp.path(), false).unwrap();

        let registry = PromptRegistry::load_for_project(temp.path()).unwrap();
        let assert_category = |id: &str, category: StrategyCategory| {
            let prompt = registry
                .get(&PromptId::from(id))
                .unwrap_or_else(|| panic!("expected scaffolded strategy prompt `{id}` to load"));
            assert_eq!(prompt.category, category, "category for `{id}`");
        };

        assert_category("boundary-tests", StrategyCategory::PropertyBased);
        assert_category("admin-config-boundaries", StrategyCategory::PropertyBased);
        assert_category(
            "external-dependency-boundaries",
            StrategyCategory::PropertyBased,
        );
        assert_category("amm-boundary-liquidity", StrategyCategory::PropertyBased);
        assert_category(
            "externalized-state-accounting",
            StrategyCategory::PropertyBased,
        );
        assert_category("packed-action-parity", StrategyCategory::PropertyBased);
        assert_category(
            "dynamic-strategy-generator",
            StrategyCategory::PropertyBased,
        );
        assert_category("time-warp-sequences", StrategyCategory::PropertyBased);
        assert_category("rounding-direction-audit", StrategyCategory::PropertyBased);
        assert_category("stateful-invariant-setup", StrategyCategory::Invariant);
        assert_category("stateful-invariant-handlers", StrategyCategory::Invariant);
        assert_category("stateful-invariant-coverage", StrategyCategory::Invariant);
        assert_category(
            "stateful-invariant-implement-properties",
            StrategyCategory::Invariant,
        );
        assert_category(
            "stateful-invariant-recon-campaign",
            StrategyCategory::Invariant,
        );
        assert_category("encode-decode", StrategyCategory::EncodeDecode);
    }

    #[test]
    fn custom_project_prompt_loads_as_project_strategy_with_default_category() {
        let temp = tempfile::tempdir().unwrap();
        let dir = project_prompt_dir(temp.path()).join("review");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("custom_invariants.md"),
            "---\nid: custom-invariants\nloops: 1\n---\n# Custom prompt\n",
        )
        .unwrap();

        let registry = PromptRegistry::load_for_project(temp.path()).unwrap();
        let prompt = registry.get(&PromptId::from("custom-invariants")).unwrap();

        assert!(matches!(prompt.source, PromptSource::Project(_)));
        assert_eq!(prompt.category, StrategyCategory::Custom);
        assert!(prompt.body.contains("Custom prompt"));
    }
}
