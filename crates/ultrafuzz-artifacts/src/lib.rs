use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
    str::FromStr,
};
use thiserror::Error;
use ultrafuzz_core::{
    Confidence, Finding, FindingEvidence, FindingFamilyVariant, FindingReproduction, FindingStatus,
    ModelProfileId, NodeId, PatchRef, PatchStatus, RelatedFindingRef, RunId, Severity, StrategyId,
    TriageClassification,
};

pub const FINDINGS_FILE: &str = "findings.json";
pub const COMPAT_FINDING_FILE: &str = "finding.json";
pub const PATCH_FILE: &str = "patch.diff";
pub const ARTIFACT_MANIFEST_FILE: &str = "artifact-manifest.json";
pub const ARTIFACT_INDEX_FILE: &str = "artifact-index.json";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunLayout {
    pub run_id: RunId,
    pub root: PathBuf,
    pub artifacts: PathBuf,
    pub workspaces: PathBuf,
}

impl RunLayout {
    pub fn new(output_dir: impl AsRef<Path>, run_id: RunId) -> Self {
        let root = output_dir.as_ref().join(run_id.as_str());
        Self {
            run_id,
            artifacts: root.join("artifacts"),
            workspaces: root.join("workspaces"),
            root,
        }
    }

    pub fn artifact_dir(&self, node_id: &NodeId) -> PathBuf {
        self.artifacts.join(node_id.as_str())
    }

    pub fn workspace_dir(&self, node_id: &NodeId) -> PathBuf {
        self.workspaces.join(node_id.as_str())
    }

    pub fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    pub fn run_metadata_path(&self) -> PathBuf {
        self.root.join("run.json")
    }

    pub fn resolved_config_path(&self) -> PathBuf {
        self.root.join("config.resolved.toml")
    }

    pub fn graph_path(&self) -> PathBuf {
        self.root.join("graph.json")
    }

    pub fn graph_fingerprint_path(&self) -> PathBuf {
        self.root.join("graph.fingerprint")
    }

    pub fn events_jsonl_path(&self) -> PathBuf {
        self.root.join("events.jsonl")
    }

    pub fn events_sqlite_path(&self) -> PathBuf {
        self.root.join("events.sqlite")
    }

    pub fn create_dirs(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.root)?;
        fs::create_dir_all(&self.artifacts)?;
        fs::create_dir_all(&self.workspaces)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactStore {
    layout: RunLayout,
}

impl ArtifactStore {
    pub fn new(layout: RunLayout) -> Self {
        Self { layout }
    }

    pub fn layout(&self) -> &RunLayout {
        &self.layout
    }

    pub fn write_manifest(&self, node_id: &NodeId) -> Result<ArtifactManifest, ArtifactError> {
        let artifact_dir = self.layout.artifact_dir(node_id);
        let manifest = ArtifactManifest::for_dir(node_id.clone(), &artifact_dir)?;
        manifest.write_to(artifact_dir.join(ARTIFACT_MANIFEST_FILE))?;
        Ok(manifest)
    }

    pub fn read_manifest(&self, node_id: &NodeId) -> Result<ArtifactManifest, ArtifactError> {
        ArtifactManifest::read_from(
            self.layout
                .artifact_dir(node_id)
                .join(ARTIFACT_MANIFEST_FILE),
        )
    }

    pub fn build_index(&self) -> Result<ArtifactIndex, ArtifactError> {
        ArtifactIndex::for_layout(&self.layout)
    }

    pub fn write_index(&self, artifact_dir: impl AsRef<Path>) -> Result<PathBuf, ArtifactError> {
        let index = self.build_index()?;
        let path = artifact_dir.as_ref().join(ARTIFACT_INDEX_FILE);
        write_pretty_json(&path, &index)?;
        Ok(path)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactManifest {
    pub schema_version: String,
    pub node_id: NodeId,
    pub files: Vec<ArtifactManifestEntry>,
}

impl ArtifactManifest {
    pub fn for_dir(node_id: NodeId, artifact_dir: impl AsRef<Path>) -> Result<Self, ArtifactError> {
        let artifact_dir = artifact_dir.as_ref();
        let mut files = Vec::new();
        if artifact_dir.exists() {
            collect_manifest_entries(artifact_dir, artifact_dir, &mut files)?;
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(Self {
            schema_version: "1.0".to_owned(),
            node_id,
            files,
        })
    }

    pub fn write_to(&self, path: impl AsRef<Path>) -> Result<(), ArtifactError> {
        write_pretty_json(path, self)
    }

    pub fn read_from(path: impl AsRef<Path>) -> Result<Self, ArtifactError> {
        let path = path.as_ref();
        let bytes = fs::read(path)?;
        serde_json::from_slice(&bytes).map_err(|source| ArtifactError::InvalidJson {
            path: path.to_path_buf(),
            source,
        })
    }

    pub fn validate_dir(&self, artifact_dir: impl AsRef<Path>) -> Result<(), ArtifactError> {
        let current = Self::for_dir(self.node_id.clone(), artifact_dir)?;
        if &current == self {
            Ok(())
        } else {
            Err(ArtifactError::ManifestMismatch {
                node_id: self.node_id.clone(),
            })
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactManifestEntry {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactIndex {
    pub schema_version: String,
    pub run_id: RunId,
    pub artifacts: Vec<ArtifactIndexEntry>,
}

impl ArtifactIndex {
    pub fn for_layout(layout: &RunLayout) -> Result<Self, ArtifactError> {
        let mut artifacts = Vec::new();
        if layout.artifacts.exists() {
            for entry in fs::read_dir(&layout.artifacts)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let node_id_value = entry.file_name().to_string_lossy().into_owned();
                let node_id = NodeId::try_new(node_id_value.clone()).map_err(|error| {
                    ArtifactError::InvalidNodeId {
                        value: node_id_value,
                        reason: error.reason(),
                    }
                })?;
                let manifest_path = entry.path().join(ARTIFACT_MANIFEST_FILE);
                let manifest = if manifest_path.exists() {
                    ArtifactManifest::read_from(&manifest_path)?
                } else {
                    ArtifactManifest::for_dir(node_id.clone(), entry.path())?
                };
                for file in manifest.files {
                    artifacts.push(ArtifactIndexEntry {
                        node_id: node_id.clone(),
                        path: Path::new("artifacts")
                            .join(node_id.as_str())
                            .join(&file.path),
                        kind: artifact_kind(&file.path).to_owned(),
                        size_bytes: file.size_bytes,
                        sha256: file.sha256,
                    });
                }
            }
        }
        artifacts.sort_by(|left, right| {
            left.node_id
                .cmp(&right.node_id)
                .then_with(|| left.path.cmp(&right.path))
        });
        Ok(Self {
            schema_version: "1.0".to_owned(),
            run_id: layout.run_id.clone(),
            artifacts,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactIndexEntry {
    pub node_id: NodeId,
    pub path: PathBuf,
    pub kind: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FindingsParseReport {
    pub source_path: PathBuf,
    pub normalized_path: PathBuf,
    pub findings: Vec<Finding>,
    pub invalid: Vec<InvalidFinding>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InvalidFinding {
    pub index: usize,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

pub fn parse_and_normalize_findings_dir(
    artifact_dir: impl AsRef<Path>,
    node_id: &NodeId,
    strategy: Option<&StrategyId>,
    attempt_index: Option<usize>,
) -> Result<FindingsParseReport, ArtifactError> {
    parse_and_normalize_findings_dir_with_model(
        artifact_dir,
        node_id,
        strategy,
        attempt_index,
        None,
        None,
        None,
        None,
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "finding normalization receives optional provenance hints from graph attempts"
)]
pub fn parse_and_normalize_findings_dir_with_model(
    artifact_dir: impl AsRef<Path>,
    node_id: &NodeId,
    strategy: Option<&StrategyId>,
    attempt_index: Option<usize>,
    model_id: Option<&ModelProfileId>,
    model: Option<&str>,
    model_index: Option<usize>,
    loop_index: Option<usize>,
) -> Result<FindingsParseReport, ArtifactError> {
    let artifact_dir = artifact_dir.as_ref();
    let findings_path = artifact_dir.join(FINDINGS_FILE);
    let compat_path = artifact_dir.join(COMPAT_FINDING_FILE);
    let source_path = if findings_path.exists() {
        findings_path.clone()
    } else if compat_path.exists() {
        compat_path
    } else {
        return Err(ArtifactError::MissingFindings {
            artifact_dir: artifact_dir.to_path_buf(),
        });
    };

    let bytes = fs::read(&source_path)?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|source| ArtifactError::InvalidJson {
            path: source_path.clone(),
            source,
        })?;
    let values = normalize_findings_value(value, &source_path)?;
    let hints = FindingProvenanceHints {
        strategy,
        attempt_index,
        model_id,
        model,
        model_index,
        loop_index,
    };
    let mut findings = Vec::new();
    let mut invalid = Vec::new();
    for (index, value) in values.into_iter().enumerate() {
        match normalize_finding(value.clone(), node_id, &hints, index) {
            Ok(finding) => findings.push(finding),
            Err(error) => invalid.push(InvalidFinding {
                index,
                error,
                raw: Some(value),
            }),
        }
    }

    write_pretty_json(&findings_path, &findings)?;
    Ok(FindingsParseReport {
        source_path,
        normalized_path: findings_path,
        findings,
        invalid,
    })
}

pub fn parse_patch_ref(
    artifact_dir: impl AsRef<Path>,
    relative_path: impl AsRef<Path>,
    status: PatchStatus,
) -> Result<PatchRef, ArtifactError> {
    let relative_path = relative_path.as_ref();
    validate_relative_artifact_path(relative_path)?;
    let path = artifact_dir.as_ref().join(relative_path);
    if !path.exists() {
        return Err(ArtifactError::MissingPatch { path });
    }
    Ok(PatchRef {
        path: relative_path.to_path_buf(),
        status,
    })
}

pub fn collect_candidate_patch(
    artifact_dir: impl AsRef<Path>,
) -> Result<Option<PatchRef>, ArtifactError> {
    let artifact_dir = artifact_dir.as_ref();
    let path = artifact_dir.join(PATCH_FILE);
    if !path.exists() || fs::metadata(&path)?.len() == 0 {
        return Ok(None);
    }
    parse_patch_ref(artifact_dir, PATCH_FILE, PatchStatus::Candidate).map(Some)
}

pub fn hash_file(path: impl AsRef<Path>) -> Result<String, ArtifactError> {
    let bytes = fs::read(path)?;
    Ok(hex_sha256(&bytes))
}

fn collect_manifest_entries(
    root: &Path,
    dir: &Path,
    files: &mut Vec<ArtifactManifestEntry>,
) -> Result<(), ArtifactError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            if is_backend_internal_artifact_dir(&path) {
                continue;
            }
            collect_manifest_entries(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("walked file must be inside root");
            if relative == Path::new(ARTIFACT_MANIFEST_FILE) {
                continue;
            }
            let metadata = entry.metadata()?;
            files.push(ArtifactManifestEntry {
                path: relative.to_string_lossy().replace('\\', "/"),
                size_bytes: metadata.len(),
                sha256: hash_file(&path)?,
            });
        }
    }
    Ok(())
}

/// Returns true for backend-owned state directories that should stay out of
/// user-facing artifact manifests and indexes.
pub fn is_backend_internal_artifact_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, "backend-attempts" | "claude-config"))
}

fn normalize_findings_value(value: Value, source_path: &Path) -> Result<Vec<Value>, ArtifactError> {
    match value {
        Value::Array(values) => Ok(values),
        Value::Object(_) if source_path.file_name() == Some(OsStr::new(COMPAT_FINDING_FILE)) => {
            Ok(vec![value])
        }
        other => Err(ArtifactError::InvalidFindingsShape {
            path: source_path.to_path_buf(),
            expected: "JSON array",
            actual: value_kind(&other),
        }),
    }
}

#[derive(Clone, Copy, Debug)]
struct FindingProvenanceHints<'a> {
    strategy: Option<&'a StrategyId>,
    attempt_index: Option<usize>,
    model_id: Option<&'a ModelProfileId>,
    model: Option<&'a str>,
    model_index: Option<usize>,
    loop_index: Option<usize>,
}

fn normalize_finding(
    value: Value,
    node_id: &NodeId,
    hints: &FindingProvenanceHints<'_>,
    index: usize,
) -> Result<Finding, String> {
    let Value::Object(object) = value else {
        return Err("finding entry must be an object".to_owned());
    };

    let schema_version = required_string(&object, "schema_version")?;
    if schema_version != "1.0" {
        return Err(format!("unsupported schema_version `{schema_version}`"));
    }

    let status = FindingStatus::from_str(&required_string(&object, "status")?)
        .map_err(|err| err.to_string())?;
    let severity_guess = Severity::from_str(&required_string(&object, "severity_guess")?)
        .map_err(|err| err.to_string())?;
    let confidence = Confidence::from_str(&required_string(&object, "confidence")?)
        .map_err(|err| err.to_string())?;

    let id = optional_string(&object, "id")?.or_else(|| Some(format!("{node_id}-{index}")));
    let strategy = optional_string(&object, "strategy")?
        .map(StrategyId::from)
        .or_else(|| hints.strategy.cloned());
    let attempt_index = optional_usize(&object, "attempt_index")?.or(hints.attempt_index);
    let model_id = optional_string(&object, "model_id")?
        .map(ModelProfileId::from)
        .or_else(|| hints.model_id.cloned());
    let model = optional_string(&object, "model")?.or_else(|| hints.model.map(str::to_owned));
    let model_index = optional_usize(&object, "model_index")?.or(hints.model_index);
    let loop_index = optional_usize(&object, "loop_index")?.or(hints.loop_index);
    let reproduction = parse_reproduction(object.get("reproduction"))?;
    let evidence = parse_evidence_array(object.get("evidence"))?;

    Ok(Finding {
        schema_version,
        id,
        family_id: optional_string(&object, "family_id")?,
        strategy,
        attempt_index,
        model_id,
        model,
        model_index,
        loop_index,
        title: required_string(&object, "title")?,
        status,
        severity_guess,
        confidence,
        summary: required_string(&object, "summary")?,
        affected_files: optional_path_array(&object, "affected_files")?,
        affected_functions: optional_string_array(&object, "affected_functions")?,
        reproduction,
        evidence,
        dedupe_key: optional_string(&object, "dedupe_key")?,
        family_variants: parse_family_variants(object.get("family_variants"))?,
        related_findings: parse_related_findings(object.get("related_findings"))?,
        triage_classification: optional_string(&object, "triage_classification")?
            .map(|value| TriageClassification::from_str(&value))
            .transpose()
            .map_err(|err| err.to_string())?,
        patch_refs: optional_string_array(&object, "patch_refs")?,
        notes: optional_string_array(&object, "notes")?,
    })
}

fn required_string(
    object: &serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<String, String> {
    match object.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(value.trim().to_owned()),
        Some(Value::Null) | None => Err(format!("missing required field `{key}`")),
        Some(_) => Err(format!("field `{key}` must be a string")),
    }
}

fn optional_string(
    object: &serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<Option<String>, String> {
    match object.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.trim().to_owned())),
        Some(Value::String(_)) | Some(Value::Null) | None => Ok(None),
        Some(_) => Err(format!("field `{key}` must be a string or null")),
    }
}

fn optional_usize(
    object: &serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<Option<usize>, String> {
    match object.get(key) {
        Some(Value::Number(value)) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .map(Some)
            .ok_or_else(|| format!("field `{key}` must be a non-negative integer")),
        Some(Value::Null) | None => Ok(None),
        Some(_) => Err(format!("field `{key}` must be a non-negative integer")),
    }
}

fn optional_string_array(
    object: &serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<Vec<String>, String> {
    match object.get(key) {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(value) => Ok(value.clone()),
                _ => Err(format!("field `{key}` must contain only strings")),
            })
            .collect(),
        Some(Value::Null) | None => Ok(Vec::new()),
        Some(_) => Err(format!("field `{key}` must be an array")),
    }
}

fn optional_path_array(
    object: &serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<Vec<PathBuf>, String> {
    optional_string_array(object, key).map(|values| values.into_iter().map(PathBuf::from).collect())
}

fn parse_reproduction(value: Option<&Value>) -> Result<Option<FindingReproduction>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Value::Object(object) = value else {
        return Err("field `reproduction` must be an object".to_owned());
    };
    Ok(Some(FindingReproduction {
        kind: required_string(object, "type")?,
        command: required_string(object, "command")?,
    }))
}

fn parse_evidence_array(value: Option<&Value>) -> Result<Vec<FindingEvidence>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Value::Array(values) = value else {
        return Err("field `evidence` must be an array".to_owned());
    };
    values
        .iter()
        .map(|value| {
            let Value::Object(object) = value else {
                return Err("evidence entries must be objects".to_owned());
            };
            Ok(FindingEvidence {
                kind: required_string(object, "kind")?,
                path: PathBuf::from(required_string(object, "path")?),
            })
        })
        .collect()
}

fn parse_family_variants(value: Option<&Value>) -> Result<Vec<FindingFamilyVariant>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Value::Array(values) = value else {
        return Err("field `family_variants` must be an array".to_owned());
    };
    values
        .iter()
        .map(|value| {
            let Value::Object(object) = value else {
                return Err("family_variants entries must be objects".to_owned());
            };
            Ok(FindingFamilyVariant {
                id: optional_string(object, "id")?,
                family_id: optional_string(object, "family_id")?,
                title: required_string(object, "title")?,
                summary: required_string(object, "summary")?,
                strategy: optional_string(object, "strategy")?.map(StrategyId::from),
                attempt_index: optional_usize(object, "attempt_index")?,
                model_id: optional_string(object, "model_id")?.map(ModelProfileId::from),
                model: optional_string(object, "model")?,
                model_index: optional_usize(object, "model_index")?,
                loop_index: optional_usize(object, "loop_index")?,
                reproduction: parse_reproduction(object.get("reproduction"))?,
                evidence: parse_evidence_array(object.get("evidence"))?,
                dedupe_key: optional_string(object, "dedupe_key")?,
            })
        })
        .collect()
}

fn parse_related_findings(value: Option<&Value>) -> Result<Vec<RelatedFindingRef>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Value::Array(values) = value else {
        return Err("field `related_findings` must be an array".to_owned());
    };
    values
        .iter()
        .map(|value| {
            let Value::Object(object) = value else {
                return Err("related_findings entries must be objects".to_owned());
            };
            Ok(RelatedFindingRef {
                id: optional_string(object, "id")?,
                title: required_string(object, "title")?,
                relationship: required_string(object, "relationship")?,
                summary: required_string(object, "summary")?,
                dedupe_key: optional_string(object, "dedupe_key")?,
                evidence: parse_evidence_array(object.get("evidence"))?,
            })
        })
        .collect()
}

fn validate_relative_artifact_path(path: &Path) -> Result<(), ArtifactError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(ArtifactError::UnsafeArtifactPath {
            path: path.to_path_buf(),
        });
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(ArtifactError::UnsafeArtifactPath {
                path: path.to_path_buf(),
            });
        }
    }
    Ok(())
}

fn artifact_kind(path: &str) -> &'static str {
    match path {
        FINDINGS_FILE
        | COMPAT_FINDING_FILE
        | "deduped-findings.json"
        | "triaged-findings.json"
        | "severity-classified-findings.json"
        | "finding-lifecycle-ledger.json" => "findings",
        PATCH_FILE => "patch",
        "stdout.log" | "stderr.log" => "log",
        "metadata.json" => "metadata",
        "prompt.rendered.md" => "prompt",
        "transcript.json" => "transcript",
        ARTIFACT_INDEX_FILE => "artifact-index",
        _ => "artifact",
    }
}

fn value_kind(value: &Value) -> String {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
    .to_owned()
}

fn write_pretty_json(path: impl AsRef<Path>, value: &impl Serialize) -> Result<(), ArtifactError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(value)?;
    fs::write(path, format!("{json}\n"))?;
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
pub enum ArtifactError {
    #[error("artifact I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid artifact JSON at {path}: {source}")]
    InvalidJson {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("failed to serialize artifact JSON: {0}")]
    JsonSerialize(#[from] serde_json::Error),
    #[error("missing findings.json or compatibility finding.json in {artifact_dir}")]
    MissingFindings { artifact_dir: PathBuf },
    #[error("invalid findings shape at {path}: expected {expected}, got {actual}")]
    InvalidFindingsShape {
        path: PathBuf,
        expected: &'static str,
        actual: String,
    },
    #[error("unsafe artifact-relative path: {path}")]
    UnsafeArtifactPath { path: PathBuf },
    #[error("invalid artifact node id `{value}`: {reason}")]
    InvalidNodeId { value: String, reason: &'static str },
    #[error("missing patch file: {path}")]
    MissingPatch { path: PathBuf },
    #[error("artifact manifest changed for node {node_id}")]
    ManifestMismatch { node_id: NodeId },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn manifest_hashes_files_deterministically() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_dir = temp.path().join("artifacts/encode-decode-0");
        fs::create_dir_all(&artifact_dir).unwrap();
        fs::write(artifact_dir.join("stdout.log"), "hello\n").unwrap();
        fs::write(artifact_dir.join("metadata.json"), "{}\n").unwrap();

        let manifest =
            ArtifactManifest::for_dir(NodeId::from("encode-decode-0"), &artifact_dir).unwrap();

        assert_eq!(manifest.files.len(), 2);
        assert_eq!(manifest.files[0].path, "metadata.json");
        assert_eq!(manifest.files[1].path, "stdout.log");
        assert_eq!(
            manifest.files[1].sha256,
            "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
        );
    }

    #[test]
    fn manifest_skips_backend_internal_state_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_dir = temp.path().join("artifacts/project-discovery");
        fs::create_dir_all(artifact_dir.join("claude-config/projects")).unwrap();
        fs::create_dir_all(artifact_dir.join("backend-attempts/attempt-1")).unwrap();
        fs::write(artifact_dir.join("stdout.log"), "hello\n").unwrap();
        fs::write(
            artifact_dir.join("claude-config/projects/session.jsonl"),
            "internal\n",
        )
        .unwrap();
        fs::write(
            artifact_dir.join("backend-attempts/attempt-1/stdout.log"),
            "old stdout\n",
        )
        .unwrap();

        let manifest =
            ArtifactManifest::for_dir(NodeId::from("project-discovery"), &artifact_dir).unwrap();

        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].path, "stdout.log");
    }

    #[test]
    fn compatibility_finding_json_normalizes_to_findings_array() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_dir = temp.path();
        fs::write(
            artifact_dir.join(COMPAT_FINDING_FILE),
            r#"{
  "schema_version": "1.0",
  "id": null,
  "strategy": "encode-decode",
  "attempt_index": 0,
  "title": "Round trip issue",
  "status": "Candidate",
  "severity_guess": "MED",
  "confidence": "Low",
  "summary": "summary"
}"#,
        )
        .unwrap();

        let report = parse_and_normalize_findings_dir(
            artifact_dir,
            &NodeId::from("encode-decode-0"),
            None,
            None,
        )
        .unwrap();

        assert_eq!(report.findings.len(), 1);
        assert_eq!(report.findings[0].id.as_deref(), Some("encode-decode-0-0"));
        assert_eq!(report.findings[0].severity_guess, Severity::Medium);
        let normalized = fs::read_to_string(artifact_dir.join(FINDINGS_FILE)).unwrap();
        assert!(normalized.trim_start().starts_with('['));
    }

    #[test]
    fn malformed_findings_json_fails_clearly() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(FINDINGS_FILE), "{not-json").unwrap();

        let error = parse_and_normalize_findings_dir(
            temp.path(),
            &NodeId::from("encode-decode-0"),
            None,
            None,
        )
        .unwrap_err();

        assert!(matches!(error, ArtifactError::InvalidJson { .. }));
    }

    #[test]
    fn malformed_finding_entries_are_recorded_and_valid_entries_continue() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join(FINDINGS_FILE),
            r#"[
  {
    "schema_version": "1.0",
    "title": "Valid",
    "status": "candidate",
    "triage_classification": "harness-defect",
    "severity_guess": "medium",
    "confidence": "low",
    "summary": "summary"
  },
  {"schema_version": "2.0", "title": "Bad"}
]"#,
        )
        .unwrap();

        let report = parse_and_normalize_findings_dir(
            temp.path(),
            &NodeId::from("encode-decode-0"),
            Some(&StrategyId::from("encode-decode")),
            Some(0),
        )
        .unwrap();

        assert_eq!(report.findings.len(), 1);
        assert_eq!(report.invalid.len(), 1);
        assert_eq!(
            report.findings[0].triage_classification,
            Some(TriageClassification::HarnessDefect)
        );
        assert_eq!(
            report.findings[0]
                .strategy
                .as_ref()
                .map(ToString::to_string),
            Some("encode-decode".to_owned())
        );
    }

    #[test]
    fn finding_family_metadata_survives_normalization() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join(FINDINGS_FILE),
            r#"[
  {
    "schema_version": "1.0",
    "id": "root-accounting-drift",
    "family_id": "accounting-drift-family",
    "title": "Accounting drift root",
    "status": "candidate",
    "severity_guess": "medium",
    "confidence": "high",
    "summary": "User/Attacker can repeat a boundary operation which leads to bounded accounting drift.",
    "dedupe_key": "root-accounting-drift",
    "family_variants": [
      {
        "id": "small-input-variant",
        "family_id": "accounting-drift-family",
        "title": "Small input variant",
        "summary": "Same rounding root with a smaller input range.",
        "strategy": "rounding-direction-audit",
        "attempt_index": 1,
        "model_id": "default",
        "model_index": 0,
        "loop_index": 1,
        "dedupe_key": "small-input-variant",
        "evidence": [{ "kind": "test", "path": "artifacts/variant.md" }]
      }
    ],
    "related_findings": [
      {
        "id": "adjacent-surface",
        "title": "Adjacent surface needs proof",
        "relationship": "adjacent-unproven",
        "summary": "Similar-looking workflow without shared-root proof.",
        "dedupe_key": "adjacent-surface"
      }
    ]
  }
]"#,
        )
        .unwrap();

        let report = parse_and_normalize_findings_dir(
            temp.path(),
            &NodeId::from("rounding-direction-audit-1"),
            Some(&StrategyId::from("rounding-direction-audit")),
            Some(1),
        )
        .unwrap();

        let finding = &report.findings[0];
        assert_eq!(
            finding.family_id.as_deref(),
            Some("accounting-drift-family")
        );
        assert_eq!(finding.family_variants.len(), 1);
        assert_eq!(
            finding.family_variants[0].id.as_deref(),
            Some("small-input-variant")
        );
        assert_eq!(finding.family_variants[0].loop_index, Some(1));
        assert_eq!(finding.related_findings.len(), 1);
        assert_eq!(
            finding.related_findings[0].relationship,
            "adjacent-unproven"
        );

        let normalized = fs::read_to_string(temp.path().join(FINDINGS_FILE)).unwrap();
        assert!(normalized.contains("\"family_variants\""));
        assert!(normalized.contains("\"related_findings\""));
    }

    #[test]
    fn loop_metadata_hints_are_applied_to_normalized_findings() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join(FINDINGS_FILE),
            r#"[
  {
    "schema_version": "1.0",
    "title": "Looped finding",
    "status": "candidate",
    "severity_guess": "medium",
    "confidence": "high",
    "summary": "summary"
  }
]"#,
        )
        .unwrap();

        let report = parse_and_normalize_findings_dir_with_model(
            temp.path(),
            &NodeId::from("encode-decode-1"),
            Some(&StrategyId::from("encode-decode")),
            Some(3),
            Some(&ModelProfileId::from("default")),
            Some("gpt-5"),
            Some(0),
            Some(1),
        )
        .unwrap();

        let finding = &report.findings[0];
        assert_eq!(
            finding.strategy.as_ref().map(ToString::to_string),
            Some("encode-decode".to_owned())
        );
        assert_eq!(finding.attempt_index, Some(3));
        assert_eq!(
            finding.model_id.as_ref().map(ToString::to_string),
            Some("default".to_owned())
        );
        assert_eq!(finding.model.as_deref(), Some("gpt-5"));
        assert_eq!(finding.model_index, Some(0));
        assert_eq!(finding.loop_index, Some(1));

        let normalized = fs::read_to_string(temp.path().join(FINDINGS_FILE)).unwrap();
        assert!(normalized.contains("\"loop_index\": 1"));
    }

    #[test]
    fn patch_parser_rejects_unsafe_paths() {
        let temp = tempfile::tempdir().unwrap();
        let error =
            parse_patch_ref(temp.path(), "../patch.diff", PatchStatus::Candidate).unwrap_err();

        assert!(matches!(error, ArtifactError::UnsafeArtifactPath { .. }));
    }

    #[test]
    fn artifact_index_uses_manifests_when_present() {
        let temp = tempfile::tempdir().unwrap();
        let layout = RunLayout::new(temp.path(), RunId::from("run"));
        layout.create_dirs().unwrap();
        let node_id = NodeId::from("encode-decode-0");
        let artifact_dir = layout.artifact_dir(&node_id);
        fs::create_dir_all(&artifact_dir).unwrap();
        fs::write(artifact_dir.join(FINDINGS_FILE), "[]\n").unwrap();
        let store = ArtifactStore::new(layout);
        store.write_manifest(&node_id).unwrap();

        let index = store.build_index().unwrap();

        assert_eq!(index.artifacts.len(), 1);
        assert_eq!(index.artifacts[0].node_id, node_id);
        assert_eq!(index.artifacts[0].kind, "findings");
    }

    #[test]
    fn artifact_index_rejects_unsafe_node_directory_ids() {
        let temp = tempfile::tempdir().unwrap();
        let layout = RunLayout::new(temp.path(), RunId::from("run"));
        layout.create_dirs().unwrap();
        let artifact_dir = layout.artifacts.join("bad..node");
        fs::create_dir_all(&artifact_dir).unwrap();
        fs::write(artifact_dir.join("stdout.log"), "hello\n").unwrap();

        let error = ArtifactIndex::for_layout(&layout).unwrap_err();

        assert!(matches!(error, ArtifactError::InvalidNodeId { .. }));
    }
}
