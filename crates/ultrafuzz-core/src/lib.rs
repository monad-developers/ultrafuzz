use serde::{de, Deserialize, Deserializer, Serialize};
use std::{collections::BTreeMap, fmt, path::PathBuf, str::FromStr, time::Duration};

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                let value = value.into();
                Self::try_new(value).unwrap_or_else(|error| panic!("{error}"))
            }

            pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidIdError> {
                let value = value.into();
                validate_id(stringify!($name), &value)?;
                Ok(Self(value))
            }

            pub fn new_unchecked(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self::new(value)
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self::new(value)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::try_new(value).map_err(de::Error::custom)
            }
        }
    };
}

id_type!(RunId);
id_type!(NodeId);
id_type!(AttemptId);
id_type!(StrategyId);
id_type!(PromptId);
id_type!(ModelProfileId);
id_type!(ReferenceId);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidIdError {
    kind: &'static str,
    value: String,
    reason: &'static str,
}

impl InvalidIdError {
    pub fn kind(&self) -> &'static str {
        self.kind
    }

    pub fn value(&self) -> &str {
        &self.value
    }

    pub fn reason(&self) -> &'static str {
        self.reason
    }
}

impl fmt::Display for InvalidIdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid {} `{}`: {}", self.kind, self.value, self.reason)
    }
}

impl std::error::Error for InvalidIdError {}

fn validate_id(kind: &'static str, value: &str) -> Result<(), InvalidIdError> {
    let reason = if value.is_empty() {
        Some("ID must not be empty")
    } else if value.contains("..") {
        Some("ID must not contain traversal segments")
    } else if value.starts_with('.') || value.ends_with('.') {
        Some("ID must not start or end with a dot")
    } else if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        Some("ID must use only ASCII letters, digits, hyphen, underscore, or dot")
    } else {
        None
    };

    match reason {
        Some(reason) => Err(InvalidIdError {
            kind,
            value: value.to_owned(),
            reason,
        }),
        None => Ok(()),
    }
}

pub const STATEFUL_INVARIANT_SETUP_ID: &str = "stateful-invariant-setup";
pub const STATEFUL_INVARIANT_HANDLERS_ID: &str = "stateful-invariant-handlers";
pub const STATEFUL_INVARIANT_COVERAGE_ID: &str = "stateful-invariant-coverage";
pub const STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID: &str =
    "stateful-invariant-implement-properties";
pub const STATEFUL_INVARIANT_RECON_CAMPAIGN_ID: &str = "stateful-invariant-recon-campaign";
pub const STATEFUL_INVARIANT_SUBBOX_IDS: [&str; 5] = [
    STATEFUL_INVARIANT_SETUP_ID,
    STATEFUL_INVARIANT_HANDLERS_ID,
    STATEFUL_INVARIANT_COVERAGE_ID,
    STATEFUL_INVARIANT_IMPLEMENT_PROPERTIES_ID,
    STATEFUL_INVARIANT_RECON_CAMPAIGN_ID,
];

pub fn is_stateful_invariant_subbox_id(id: &str) -> bool {
    STATEFUL_INVARIANT_SUBBOX_IDS.contains(&id)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuiltInStrategy {
    DifferentialLibraryTests,
    RoundTrip,
    WorkflowPropertyBasedTests,
    EncodeDecode,
    ExpandCoverage,
    StatefulInvariantSetup,
    StatefulInvariantHandlers,
    StatefulInvariantCoverage,
}

impl BuiltInStrategy {
    pub const ALL: [Self; 8] = [
        Self::DifferentialLibraryTests,
        Self::RoundTrip,
        Self::WorkflowPropertyBasedTests,
        Self::EncodeDecode,
        Self::ExpandCoverage,
        Self::StatefulInvariantSetup,
        Self::StatefulInvariantHandlers,
        Self::StatefulInvariantCoverage,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::DifferentialLibraryTests => "differential-library-tests",
            Self::RoundTrip => "round-trip",
            Self::WorkflowPropertyBasedTests => "workflow-property-based-tests",
            Self::EncodeDecode => "encode-decode",
            Self::ExpandCoverage => "expand-coverage",
            Self::StatefulInvariantSetup => STATEFUL_INVARIANT_SETUP_ID,
            Self::StatefulInvariantHandlers => STATEFUL_INVARIANT_HANDLERS_ID,
            Self::StatefulInvariantCoverage => STATEFUL_INVARIANT_COVERAGE_ID,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::DifferentialLibraryTests => "Differential Library Tests",
            Self::RoundTrip => "Round Trip",
            Self::WorkflowPropertyBasedTests => "Workflow Property-Based",
            Self::EncodeDecode => "Encode / Decode",
            Self::ExpandCoverage => "Expand Coverage",
            Self::StatefulInvariantSetup => "Stateful Invariant Setup",
            Self::StatefulInvariantHandlers => "Stateful Invariant Handlers",
            Self::StatefulInvariantCoverage => "Stateful Invariant Coverage",
        }
    }

    pub fn prompt_file_name(self) -> &'static str {
        match self {
            Self::DifferentialLibraryTests => "differential-library-tests.md",
            Self::RoundTrip => "round-trip.md",
            Self::WorkflowPropertyBasedTests => "workflow-property-based-tests.md",
            Self::EncodeDecode => "encode-decode.md",
            Self::ExpandCoverage => "expand-coverage.md",
            Self::StatefulInvariantSetup => "invariants/setup.md",
            Self::StatefulInvariantHandlers => "invariants/handlers.md",
            Self::StatefulInvariantCoverage => "invariants/coverage.md",
        }
    }

    pub fn category(self) -> StrategyCategory {
        match self {
            Self::DifferentialLibraryTests => StrategyCategory::Differential,
            Self::RoundTrip => StrategyCategory::RoundTrip,
            Self::WorkflowPropertyBasedTests => StrategyCategory::PropertyBased,
            Self::EncodeDecode => StrategyCategory::EncodeDecode,
            Self::ExpandCoverage => StrategyCategory::PropertyBased,
            Self::StatefulInvariantSetup
            | Self::StatefulInvariantHandlers
            | Self::StatefulInvariantCoverage => StrategyCategory::Invariant,
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|strategy| strategy.id() == id)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StrategyCategory {
    Differential,
    RoundTrip,
    PropertyBased,
    EncodeDecode,
    Invariant,
    Custom,
}

impl fmt::Display for StrategyCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Differential => "differential",
            Self::RoundTrip => "round-trip",
            Self::PropertyBased => "property-based",
            Self::EncodeDecode => "encode-decode",
            Self::Invariant => "invariant",
            Self::Custom => "custom",
        })
    }
}

impl FromStr for StrategyCategory {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match normalize_enum_token(value).as_str() {
            "differential" => Ok(Self::Differential),
            "round-trip" => Ok(Self::RoundTrip),
            "property-based" => Ok(Self::PropertyBased),
            "encode-decode" => Ok(Self::EncodeDecode),
            "invariant" => Ok(Self::Invariant),
            "custom" => Ok(Self::Custom),
            _ => Err(ParseEnumError::new("strategy category", value)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StrategySource {
    BuiltIn,
    ProjectPrompt,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StrategyDefinition {
    pub id: StrategyId,
    pub display_name: String,
    pub prompt_id: PromptId,
    pub prompt_path: PathBuf,
    #[serde(default)]
    pub models: Vec<ModelProfileId>,
    pub loops: usize,
    pub timeout: Duration,
    pub enabled: bool,
    pub category: StrategyCategory,
    pub source: StrategySource,
}

impl StrategyDefinition {
    pub fn built_in(strategy: BuiltInStrategy) -> Self {
        Self {
            id: StrategyId::from(strategy.id()),
            display_name: strategy.display_name().to_owned(),
            prompt_id: PromptId::from(strategy.id()),
            prompt_path: PathBuf::from("prompts")
                .join("strategies")
                .join(strategy.prompt_file_name()),
            models: Vec::new(),
            loops: 1,
            timeout: Duration::from_secs(1_800),
            enabled: true,
            category: strategy.category(),
            source: StrategySource::BuiltIn,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CampaignPreset {
    Full,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NodeStatus {
    Pending,
    Ready,
    Running,
    Succeeded,
    Failed,
    Skipped,
    TimedOut,
    ReusedFromPriorRun,
    Invalidated,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttemptStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    TimedOut,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindingStatus {
    Candidate,
    NeedsReview,
    Duplicate,
    FalsePositive,
    Confirmed,
    Fixed,
    WontFix,
}

impl FindingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Candidate => "candidate",
            Self::NeedsReview => "needs-review",
            Self::Duplicate => "duplicate",
            Self::FalsePositive => "false-positive",
            Self::Confirmed => "confirmed",
            Self::Fixed => "fixed",
            Self::WontFix => "wont-fix",
        }
    }
}

impl fmt::Display for FindingStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for FindingStatus {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match normalize_enum_token(value).as_str() {
            "candidate" => Ok(Self::Candidate),
            "needs-review" | "needsreview" => Ok(Self::NeedsReview),
            "duplicate" => Ok(Self::Duplicate),
            "false-positive" | "falsepositive" => Ok(Self::FalsePositive),
            "confirmed" => Ok(Self::Confirmed),
            "fixed" => Ok(Self::Fixed),
            "wont-fix" | "wontfix" | "won't-fix" => Ok(Self::WontFix),
            _ => Err(ParseEnumError::new("finding status", value)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TriageClassification {
    TruePositive,
    FalsePositive,
    Undetermined,
    IncompleteSpec,
    HarnessDefect,
    RepairCandidate,
    SpecGated,
    DefensiveHardening,
}

impl TriageClassification {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TruePositive => "true-positive",
            Self::FalsePositive => "false-positive",
            Self::Undetermined => "undetermined",
            Self::IncompleteSpec => "incomplete-spec",
            Self::HarnessDefect => "harness-defect",
            Self::RepairCandidate => "repair-candidate",
            Self::SpecGated => "spec-gated",
            Self::DefensiveHardening => "defensive-hardening",
        }
    }
}

impl fmt::Display for TriageClassification {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for TriageClassification {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match normalize_enum_token(value).as_str() {
            "true-positive" | "truepositive" => Ok(Self::TruePositive),
            "false-positive" | "falsepositive" => Ok(Self::FalsePositive),
            "undetermined" => Ok(Self::Undetermined),
            "incomplete-spec" | "incompletespec" => Ok(Self::IncompleteSpec),
            "harness-defect" | "harnessdefect" => Ok(Self::HarnessDefect),
            "repair-candidate" | "repaircandidate" => Ok(Self::RepairCandidate),
            "spec-gated" | "specgated" => Ok(Self::SpecGated),
            "defensive-hardening" | "defensivehardening" => Ok(Self::DefensiveHardening),
            _ => Err(ParseEnumError::new("triage classification", value)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Info,
    Low,
    Medium,
    High,
    Critical,
    Unknown,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
            Self::Unknown => "unknown",
        }
    }
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Severity {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match normalize_enum_token(value).as_str() {
            "info" | "informational" => Ok(Self::Info),
            "low" => Ok(Self::Low),
            "medium" | "med" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "critical" | "crit" => Ok(Self::Critical),
            "unknown" | "" => Ok(Self::Unknown),
            _ => Err(ParseEnumError::new("severity", value)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

impl Confidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

impl fmt::Display for Confidence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Confidence {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match normalize_enum_token(value).as_str() {
            "low" => Ok(Self::Low),
            "medium" | "med" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            _ => Err(ParseEnumError::new("confidence", value)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendKind {
    CodexCli,
    ClaudeCodeCli,
}

impl fmt::Display for BackendKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::CodexCli => "codex-cli",
            Self::ClaudeCodeCli => "claude-code-cli",
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelProfile {
    pub id: ModelProfileId,
    pub backend: BackendKind,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

impl FromStr for BackendKind {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match normalize_enum_token(value).as_str() {
            "codex" | "codex-cli" => Ok(Self::CodexCli),
            "claude" | "claude-code" | "claude-code-cli" => Ok(Self::ClaudeCodeCli),
            _ => Err(ParseEnumError::new("backend kind", value)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceMode {
    GitWorktree,
    TempdirCopy,
    InPlaceReadonly,
    PersistentDebug,
}

impl fmt::Display for WorkspaceMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::GitWorktree => "git-worktree",
            Self::TempdirCopy => "tempdir-copy",
            Self::InPlaceReadonly => "in-place-readonly",
            Self::PersistentDebug => "persistent-debug",
        })
    }
}

impl FromStr for WorkspaceMode {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match normalize_enum_token(value).as_str() {
            "git-worktree" => Ok(Self::GitWorktree),
            "tempdir-copy" => Ok(Self::TempdirCopy),
            "in-place-readonly" => Ok(Self::InPlaceReadonly),
            "persistent-debug" => Ok(Self::PersistentDebug),
            _ => Err(ParseEnumError::new("workspace mode", value)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RestartMode {
    Clean,
    ReuseCompletedArtifacts,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PatchStatus {
    Candidate,
}

impl PatchStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Candidate => "candidate",
        }
    }
}

impl fmt::Display for PatchStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for PatchStatus {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match normalize_enum_token(value).as_str() {
            "candidate" => Ok(Self::Candidate),
            _ => Err(ParseEnumError::new("patch status", value)),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub path: PathBuf,
}

impl ArtifactRef {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PatchRef {
    pub path: PathBuf,
    pub status: PatchStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceRef {
    pub path: PathBuf,
    pub mode: WorkspaceMode,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    pub schema_version: String,
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family_id: Option<String>,
    pub strategy: Option<StrategyId>,
    pub attempt_index: Option<usize>,
    #[serde(default)]
    pub model_id: Option<ModelProfileId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub model_index: Option<usize>,
    #[serde(default)]
    pub loop_index: Option<usize>,
    pub title: String,
    pub status: FindingStatus,
    pub severity_guess: Severity,
    pub confidence: Confidence,
    pub summary: String,
    #[serde(default)]
    pub affected_files: Vec<PathBuf>,
    #[serde(default)]
    pub affected_functions: Vec<String>,
    #[serde(default)]
    pub reproduction: Option<FindingReproduction>,
    #[serde(default)]
    pub evidence: Vec<FindingEvidence>,
    #[serde(default)]
    pub dedupe_key: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub family_variants: Vec<FindingFamilyVariant>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related_findings: Vec<RelatedFindingRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triage_classification: Option<TriageClassification>,
    #[serde(default)]
    pub patch_refs: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FindingFamilyVariant {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family_id: Option<String>,
    pub title: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<StrategyId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<ModelProfileId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reproduction: Option<FindingReproduction>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<FindingEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RelatedFindingRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub title: String,
    pub relationship: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<FindingEvidence>,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct FindingStrategyHit {
    pub strategy: StrategyId,
    #[serde(default)]
    pub attempt_index: Option<usize>,
    #[serde(default)]
    pub model_id: Option<ModelProfileId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub model_index: Option<usize>,
    #[serde(default)]
    pub loop_index: Option<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FindingStrategyDetection {
    pub dedupe_key: String,
    #[serde(default)]
    pub finding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub hits: Vec<FindingStrategyHit>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindingLifecycleStage {
    Raw,
    Deduped,
    Triaged,
    SeverityClassified,
    FinalReport,
}

impl FindingLifecycleStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Deduped => "deduped",
            Self::Triaged => "triaged",
            Self::SeverityClassified => "severity-classified",
            Self::FinalReport => "final-report",
        }
    }
}

impl fmt::Display for FindingLifecycleStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindingSourceRelationship {
    Primary,
    Duplicate,
    FamilyVariant,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindingFinalDisposition {
    Promoted,
    NonProduction,
    Dropped,
}

impl FindingFinalDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Promoted => "promoted",
            Self::NonProduction => "non-production",
            Self::Dropped => "dropped",
        }
    }
}

impl fmt::Display for FindingFinalDisposition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindingComparisonDisposition {
    PromotedAgain,
    RediscoveredButDemoted,
    NotReproduced,
    NotSearched,
}

impl FindingComparisonDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PromotedAgain => "promoted-again",
            Self::RediscoveredButDemoted => "rediscovered-but-demoted",
            Self::NotReproduced => "not-reproduced",
            Self::NotSearched => "not-searched",
        }
    }
}

impl fmt::Display for FindingComparisonDisposition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FindingLifecycleLedger {
    pub schema_version: String,
    #[serde(default)]
    pub records: Vec<FindingLifecycleRecord>,
}

impl FindingLifecycleLedger {
    pub fn empty() -> Self {
        Self {
            schema_version: "1.0".to_owned(),
            records: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FindingLifecycleRecord {
    pub dedupe_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub source_artifacts: Vec<FindingLifecycleSourceArtifact>,
    #[serde(default)]
    pub strategy_hits: Vec<FindingStrategyHit>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub duplicate_finding_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub family_variant_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_severity: Option<Severity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triage_classification: Option<TriageClassification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triage_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demotion_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_disposition: Option<FindingFinalDisposition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comparison_disposition: Option<FindingComparisonDisposition>,
    #[serde(default)]
    pub stages: Vec<FindingLifecycleStageRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FindingLifecycleSourceArtifact {
    pub path: PathBuf,
    pub node_id: NodeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
    pub title: String,
    pub relationship: FindingSourceRelationship,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct FindingLifecycleStageRecord {
    pub stage: FindingLifecycleStage,
    pub node_id: NodeId,
    pub artifact_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finding_id: Option<String>,
    #[serde(default = "default_lifecycle_stage_status")]
    pub status: FindingStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<Severity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triage_classification: Option<TriageClassification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl<'de> Deserialize<'de> for FindingLifecycleStageRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawFindingLifecycleStageRecord {
            stage: FindingLifecycleStage,
            #[serde(default)]
            node_id: Option<NodeId>,
            #[serde(default)]
            artifact_path: Option<PathBuf>,
            #[serde(default)]
            path: Option<PathBuf>,
            #[serde(default)]
            output_path: Option<PathBuf>,
            #[serde(default)]
            finding_id: Option<String>,
            #[serde(default = "default_lifecycle_stage_status")]
            status: FindingStatus,
            #[serde(default)]
            severity: Option<Severity>,
            #[serde(default)]
            triage_classification: Option<TriageClassification>,
            #[serde(default)]
            note: Option<String>,
        }

        let raw = RawFindingLifecycleStageRecord::deserialize(deserializer)?;
        let node_id = raw
            .node_id
            .or_else(|| default_lifecycle_stage_node_id(raw.stage))
            .ok_or_else(|| serde::de::Error::missing_field("node_id"))?;
        let artifact_path = raw
            .artifact_path
            .or(raw.path)
            .or(raw.output_path)
            .ok_or_else(|| serde::de::Error::missing_field("artifact_path"))?;

        Ok(Self {
            stage: raw.stage,
            node_id,
            artifact_path,
            finding_id: raw.finding_id,
            status: raw.status,
            severity: raw.severity,
            triage_classification: raw.triage_classification,
            note: raw.note,
        })
    }
}

fn default_lifecycle_stage_node_id(stage: FindingLifecycleStage) -> Option<NodeId> {
    match stage {
        FindingLifecycleStage::Raw => None,
        FindingLifecycleStage::Deduped => Some(NodeId::from("dedupe-findings")),
        FindingLifecycleStage::Triaged => Some(NodeId::from("triage")),
        FindingLifecycleStage::SeverityClassified => Some(NodeId::from("severity-classification")),
        FindingLifecycleStage::FinalReport => Some(NodeId::from("final-report")),
    }
}

fn default_lifecycle_stage_status() -> FindingStatus {
    FindingStatus::NeedsReview
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FindingLifecycleComparisonRecord {
    pub dedupe_key: String,
    pub prior_title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_final_disposition: Option<FindingFinalDisposition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_final_disposition: Option<FindingFinalDisposition>,
    pub comparison_disposition: FindingComparisonDisposition,
}

pub fn compare_finding_lifecycle_ledgers(
    prior: &FindingLifecycleLedger,
    current: &FindingLifecycleLedger,
    current_search_completed: bool,
) -> Vec<FindingLifecycleComparisonRecord> {
    let current_by_key = current
        .records
        .iter()
        .map(|record| (record.dedupe_key.as_str(), record))
        .collect::<BTreeMap<_, _>>();
    prior
        .records
        .iter()
        .map(|prior_record| {
            let current_record = current_by_key
                .get(prior_record.dedupe_key.as_str())
                .copied();
            let comparison_disposition = match current_record {
                Some(record)
                    if record.final_disposition == Some(FindingFinalDisposition::Promoted) =>
                {
                    FindingComparisonDisposition::PromotedAgain
                }
                Some(_) => FindingComparisonDisposition::RediscoveredButDemoted,
                None if current_search_completed => FindingComparisonDisposition::NotReproduced,
                None => FindingComparisonDisposition::NotSearched,
            };
            FindingLifecycleComparisonRecord {
                dedupe_key: prior_record.dedupe_key.clone(),
                prior_title: prior_record.title.clone(),
                current_title: current_record.map(|record| record.title.clone()),
                prior_final_disposition: prior_record.final_disposition,
                current_final_disposition: current_record
                    .and_then(|record| record.final_disposition),
                comparison_disposition,
            }
        })
        .collect()
}

pub fn finding_dedupe_key(finding: &Finding) -> String {
    finding.dedupe_key.clone().unwrap_or_else(|| {
        let mut files = finding
            .affected_files
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        files.sort();
        let mut functions = finding.affected_functions.clone();
        functions.sort();
        format!(
            "{}|{}|{}|{}",
            finding.title.trim().to_ascii_lowercase(),
            finding.summary.trim().to_ascii_lowercase(),
            files.join(","),
            functions.join(",")
        )
    })
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FindingReproduction {
    #[serde(rename = "type")]
    pub kind: String,
    pub command: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FindingEvidence {
    pub kind: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParseEnumError {
    kind: &'static str,
    value: String,
}

impl ParseEnumError {
    pub fn new(kind: &'static str, value: impl Into<String>) -> Self {
        Self {
            kind,
            value: value.into(),
        }
    }
}

impl fmt::Display for ParseEnumError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown {}: {}", self.kind, self.value)
    }
}

impl std::error::Error for ParseEnumError {}

fn normalize_enum_token(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace(['_', ' '], "-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_newtypes_reject_path_unsafe_values() {
        assert!(NodeId::try_new("encode-decode_1.2").is_ok());

        for value in [
            "",
            ".hidden",
            "trailing.",
            "../escape",
            "bad/node",
            r"bad\node",
            "bad..node",
            "with space",
        ] {
            assert!(NodeId::try_new(value).is_err(), "{value:?}");
        }
    }

    #[test]
    fn id_deserialization_rejects_path_unsafe_values() {
        let id: NodeId = serde_json::from_str("\"encode-decode\"").unwrap();
        assert_eq!(id, NodeId::from("encode-decode"));

        let error = serde_json::from_str::<NodeId>("\"../escape\"").unwrap_err();
        assert!(error.to_string().contains("traversal"));

        let error = serde_json::from_str::<RunId>("\"bad/run\"").unwrap_err();
        assert!(error.to_string().contains("ASCII letters"));
    }

    #[test]
    fn built_in_strategy_ids_match_prd() {
        let ids: Vec<_> = BuiltInStrategy::ALL
            .into_iter()
            .map(BuiltInStrategy::id)
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
    fn parses_normalized_finding_and_patch_enums() {
        assert_eq!(
            StrategyCategory::from_str("Invariant").unwrap(),
            StrategyCategory::Invariant
        );
        assert!(StrategyCategory::from_str("stateful-invariant").is_err());
        assert_eq!(
            FindingStatus::from_str("Needs Review").unwrap(),
            FindingStatus::NeedsReview
        );
        assert_eq!(
            TriageClassification::from_str("true positive").unwrap(),
            TriageClassification::TruePositive
        );
        assert_eq!(
            TriageClassification::from_str("false_positive").unwrap(),
            TriageClassification::FalsePositive
        );
        assert_eq!(
            TriageClassification::from_str("incomplete spec").unwrap(),
            TriageClassification::IncompleteSpec
        );
        assert_eq!(
            TriageClassification::from_str("harness_defect").unwrap(),
            TriageClassification::HarnessDefect
        );
        assert_eq!(
            TriageClassification::from_str("repair-candidate").unwrap(),
            TriageClassification::RepairCandidate
        );
        assert_eq!(
            TriageClassification::from_str("spec gated").unwrap(),
            TriageClassification::SpecGated
        );
        assert_eq!(
            TriageClassification::from_str("defensive_hardening").unwrap(),
            TriageClassification::DefensiveHardening
        );
        assert_eq!(Severity::from_str("MED").unwrap(), Severity::Medium);
        assert_eq!(Confidence::from_str("High").unwrap(), Confidence::High);
        assert_eq!(
            PatchStatus::from_str("Candidate").unwrap(),
            PatchStatus::Candidate
        );
        assert!(PatchStatus::from_str("agent_resolved_conflict").is_err());
    }

    #[test]
    fn lifecycle_comparison_matches_by_dedupe_key_not_title() {
        let prior = FindingLifecycleLedger {
            schema_version: "1.0".to_owned(),
            records: vec![FindingLifecycleRecord {
                dedupe_key: "stable-key".to_owned(),
                finding_id: Some("prior-1".to_owned()),
                family_id: None,
                title: "Old title".to_owned(),
                source_artifacts: Vec::new(),
                strategy_hits: Vec::new(),
                duplicate_finding_ids: Vec::new(),
                family_variant_keys: Vec::new(),
                canonical_severity: Some(Severity::High),
                triage_classification: Some(TriageClassification::TruePositive),
                triage_reason: Some("production evidence".to_owned()),
                demotion_reason: None,
                final_disposition: Some(FindingFinalDisposition::Promoted),
                comparison_disposition: None,
                stages: Vec::new(),
            }],
        };
        let current = FindingLifecycleLedger {
            schema_version: "1.0".to_owned(),
            records: vec![FindingLifecycleRecord {
                dedupe_key: "stable-key".to_owned(),
                finding_id: Some("current-1".to_owned()),
                family_id: None,
                title: "Renamed title".to_owned(),
                source_artifacts: Vec::new(),
                strategy_hits: Vec::new(),
                duplicate_finding_ids: Vec::new(),
                family_variant_keys: Vec::new(),
                canonical_severity: Some(Severity::Medium),
                triage_classification: Some(TriageClassification::TruePositive),
                triage_reason: Some("production evidence".to_owned()),
                demotion_reason: None,
                final_disposition: Some(FindingFinalDisposition::Promoted),
                comparison_disposition: None,
                stages: Vec::new(),
            }],
        };

        let comparison = compare_finding_lifecycle_ledgers(&prior, &current, true);

        assert_eq!(comparison.len(), 1);
        assert_eq!(
            comparison[0].comparison_disposition,
            FindingComparisonDisposition::PromotedAgain
        );
        assert_eq!(
            comparison[0].current_title.as_deref(),
            Some("Renamed title")
        );
    }
}
