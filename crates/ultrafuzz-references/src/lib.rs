use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs, io,
    path::{Component, Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;
use thiserror::Error;
use ultrafuzz_core::ReferenceId;

pub const PROJECT_REFERENCES_FILE: &str = ".ultrafuzz/references.yml";
pub const REFERENCES_VERSION: u32 = 1;
pub const CACHE_MANIFEST_FILE: &str = ".ultrafuzz-reference-manifest.json";
pub const RUN_REFERENCE_MANIFEST_FILE: &str = "references/manifest.json";
pub const DEFAULT_REFERENCE_CATALOG: &str = include_str!("../../../.ultrafuzz/references.yml");

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReferenceCatalog {
    pub version: u32,
    pub references: BTreeMap<ReferenceId, ReferenceEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReferenceEntry {
    pub provider: ReferenceProvider,
    pub repo: String,
    pub commit: String,
    pub paths: Vec<PathBuf>,
    pub resolved_at: String,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReferenceProvider {
    Github,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReferenceScaffoldReport {
    pub written: Option<PathBuf>,
    pub skipped: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReferenceStatusReport {
    pub catalog_path: PathBuf,
    pub cache_root: PathBuf,
    pub references: Vec<ReferenceStatus>,
}

impl ReferenceStatusReport {
    pub fn ok(&self) -> bool {
        self.references.iter().all(|reference| reference.ok)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReferenceStatus {
    pub id: ReferenceId,
    pub repo: String,
    pub commit: String,
    pub cache_dir: PathBuf,
    pub ok: bool,
    pub messages: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyncReport {
    pub cache_root: PathBuf,
    pub synced: Vec<SyncedReference>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyncedReference {
    pub id: ReferenceId,
    pub repo: String,
    pub commit: String,
    pub cache_dir: PathBuf,
    pub fetched: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateReport {
    pub catalog_path: PathBuf,
    pub updated: Vec<UpdatedReference>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdatedReference {
    pub id: ReferenceId,
    pub repo: String,
    pub old_commit: String,
    pub new_commit: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializedReference {
    pub reference_artifact: PathBuf,
    pub manifest_artifact: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReferenceCacheManifest {
    pub schema_version: String,
    pub provider: ReferenceProvider,
    pub repo: String,
    pub commit: String,
    pub fetched_at: String,
    pub files: Vec<ReferenceManifestFile>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReferenceManifestFile {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RunReferenceManifest {
    pub schema_version: String,
    pub reference: ReferenceId,
    pub provider: ReferenceProvider,
    pub repo: String,
    pub commit: String,
    pub resolved_at: String,
    pub source_files: Vec<ReferenceManifestFile>,
    pub artifacts: Vec<ReferenceManifestFile>,
}

#[derive(Debug, Error)]
pub enum ReferenceError {
    #[error("missing references file: {0}")]
    MissingCatalog(PathBuf),
    #[error("reference I/O error at {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("refusing to write references file through symlink `{0}`")]
    SymlinkReferencePath(PathBuf),
    #[error("failed to parse references YAML: {0}")]
    Parse(String),
    #[error("failed to serialize references data: {0}")]
    Serialize(String),
    #[error("unsupported references version: {0}")]
    UnsupportedVersion(u32),
    #[error("references catalog must contain at least one reference")]
    EmptyCatalog,
    #[error("reference `{id}` must use provider `github`")]
    UnsupportedProvider { id: ReferenceId },
    #[error("reference `{id}` has invalid GitHub repo `{repo}`")]
    InvalidRepo { id: ReferenceId, repo: String },
    #[error("reference `{id}` has invalid commit `{commit}`; expected full 40-character SHA")]
    InvalidCommit { id: ReferenceId, commit: String },
    #[error("reference `{id}` has no paths")]
    MissingPaths { id: ReferenceId },
    #[error(
        "reference `{id}` has invalid path `{path}`; paths must be relative and traversal-free"
    )]
    InvalidPath { id: ReferenceId, path: PathBuf },
    #[error("reference `{id}` repeats path `{path}`")]
    DuplicatePath { id: ReferenceId, path: PathBuf },
    #[error("unknown reference `{0}`")]
    UnknownReference(ReferenceId),
    #[error("cached reference `{id}` is missing at {cache_dir}; run `ultrafuzz references sync` before running offline")]
    MissingCache { id: ReferenceId, cache_dir: PathBuf },
    #[error("cached reference `{id}` is missing source path `{path}` at {cache_path}; run `ultrafuzz references sync`")]
    MissingCachedPath {
        id: ReferenceId,
        path: PathBuf,
        cache_path: PathBuf,
    },
    #[error("cached reference `{id}` has invalid manifest at {path}: {reason}")]
    InvalidCacheManifest {
        id: ReferenceId,
        path: PathBuf,
        reason: String,
    },
    #[error("cached reference `{id}` digest mismatch for `{path}`")]
    DigestMismatch { id: ReferenceId, path: PathBuf },
    #[error(
        "reference `{id}` path `{path}` at commit {commit} resolved to `{object_type}`, expected a blob"
    )]
    NonBlobPath {
        id: ReferenceId,
        path: PathBuf,
        commit: String,
        object_type: String,
    },
    #[error("reference `{id}` cannot materialize without a primary artifact")]
    MissingPrimaryArtifact { id: ReferenceId },
    #[error("reference `{id}` expected required artifact `{path}` to be generated")]
    MissingRequiredArtifact { id: ReferenceId, path: PathBuf },
    #[error("git command failed: {command}: {stderr}")]
    Git { command: String, stderr: String },
    #[error("git output for `{repo}` did not contain a full HEAD SHA")]
    MissingHeadSha { repo: String },
}

pub fn references_path(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join(PROJECT_REFERENCES_FILE)
}

pub fn write_default_reference_catalog(
    project_root: impl AsRef<Path>,
    force: bool,
) -> Result<ReferenceScaffoldReport, ReferenceError> {
    let project_root = project_root.as_ref();
    let path = references_path(project_root);
    ensure_no_reference_symlink_components(project_root)?;
    if path.exists() && !force {
        return Ok(ReferenceScaffoldReport {
            written: None,
            skipped: Some(path),
        });
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| ReferenceError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    ensure_no_reference_symlink_components(project_root)?;
    let catalog = parse_catalog(DEFAULT_REFERENCE_CATALOG)?;
    write_catalog_path(&path, &catalog)?;
    Ok(ReferenceScaffoldReport {
        written: Some(path),
        skipped: None,
    })
}

pub fn load_catalog(project_root: impl AsRef<Path>) -> Result<ReferenceCatalog, ReferenceError> {
    let project_root = project_root.as_ref();
    ensure_no_reference_symlink_components(project_root)?;
    let path = references_path(project_root);
    if !path.exists() {
        return Err(ReferenceError::MissingCatalog(path));
    }
    let contents = fs::read_to_string(&path).map_err(|source| ReferenceError::Io {
        path: path.clone(),
        source,
    })?;
    parse_catalog(&contents)
}

pub fn parse_catalog(contents: &str) -> Result<ReferenceCatalog, ReferenceError> {
    let catalog = serde_yaml::from_str::<ReferenceCatalog>(contents)
        .map_err(|error| ReferenceError::Parse(error.to_string()))?;
    validate_catalog(&catalog)?;
    Ok(catalog)
}

pub fn validate_catalog(catalog: &ReferenceCatalog) -> Result<(), ReferenceError> {
    if catalog.version != REFERENCES_VERSION {
        return Err(ReferenceError::UnsupportedVersion(catalog.version));
    }
    if catalog.references.is_empty() {
        return Err(ReferenceError::EmptyCatalog);
    }
    for (id, reference) in &catalog.references {
        validate_reference(id, reference)?;
    }
    Ok(())
}

pub fn cache_root() -> PathBuf {
    env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .unwrap_or_else(|| PathBuf::from(".cache"))
        .join("ultrafuzz")
        .join("references")
}

pub fn cache_dir_for(reference: &ReferenceEntry) -> Result<PathBuf, ReferenceError> {
    cache_dir_for_root(reference, &cache_root())
}

fn cache_dir_for_root(reference: &ReferenceEntry, root: &Path) -> Result<PathBuf, ReferenceError> {
    let (owner, repo) = github_repo_parts(reference, &ReferenceId::from("cache-path"))?;
    Ok(root
        .join("github")
        .join(owner)
        .join(repo)
        .join(&reference.commit))
}

pub fn sync_project_references(
    project_root: impl AsRef<Path>,
) -> Result<SyncReport, ReferenceError> {
    let catalog = load_catalog(project_root)?;
    sync_catalog(&catalog)
}

pub fn sync_catalog(catalog: &ReferenceCatalog) -> Result<SyncReport, ReferenceError> {
    validate_catalog(catalog)?;
    let cache_root = cache_root();
    let mut synced = Vec::new();
    for group in reference_cache_groups(catalog) {
        let cache_dir = cache_dir_for_root(&group.reference, &cache_root)?;
        let fetched = if group.ids.iter().all(|id| {
            catalog
                .references
                .get(id)
                .is_some_and(|reference| cached_reference_ok(id, reference, &cache_dir).is_ok())
        }) {
            false
        } else {
            fetch_reference(&group.ids[0], &group.reference, &cache_dir)?;
            true
        };
        for id in group.ids {
            let reference = catalog
                .references
                .get(&id)
                .ok_or_else(|| ReferenceError::UnknownReference(id.clone()))?;
            synced.push(SyncedReference {
                id,
                repo: reference.repo.clone(),
                commit: reference.commit.clone(),
                cache_dir: cache_dir.clone(),
                fetched,
            });
        }
    }
    Ok(SyncReport { cache_root, synced })
}

pub fn status_project_references(
    project_root: impl AsRef<Path>,
) -> Result<ReferenceStatusReport, ReferenceError> {
    let project_root = project_root.as_ref();
    let catalog = load_catalog(project_root)?;
    status_catalog(project_root, &catalog)
}

pub fn status_catalog(
    project_root: impl AsRef<Path>,
    catalog: &ReferenceCatalog,
) -> Result<ReferenceStatusReport, ReferenceError> {
    validate_catalog(catalog)?;
    status_catalog_with_cache_root(project_root, catalog, &cache_root())
}

fn status_catalog_with_cache_root(
    project_root: impl AsRef<Path>,
    catalog: &ReferenceCatalog,
    cache_root: &Path,
) -> Result<ReferenceStatusReport, ReferenceError> {
    let mut references = Vec::new();
    for (id, reference) in &catalog.references {
        let cache_dir = cache_dir_for_root(reference, cache_root)?;
        let mut messages = Vec::new();
        let ok = match cached_reference_ok(id, reference, &cache_dir) {
            Ok(()) => {
                messages.push("cache ok".to_owned());
                true
            }
            Err(error) => {
                messages.push(error.to_string());
                false
            }
        };
        references.push(ReferenceStatus {
            id: id.clone(),
            repo: reference.repo.clone(),
            commit: reference.commit.clone(),
            cache_dir,
            ok,
            messages,
        });
    }
    Ok(ReferenceStatusReport {
        catalog_path: references_path(project_root),
        cache_root: cache_root.to_path_buf(),
        references,
    })
}

pub fn verify_references_cached<'a>(
    catalog: &ReferenceCatalog,
    references: impl IntoIterator<Item = &'a ReferenceId>,
) -> Result<(), ReferenceError> {
    validate_catalog(catalog)?;
    verify_references_cached_with_cache_root(catalog, references, &cache_root())
}

fn verify_references_cached_with_cache_root<'a>(
    catalog: &ReferenceCatalog,
    references: impl IntoIterator<Item = &'a ReferenceId>,
    cache_root: &Path,
) -> Result<(), ReferenceError> {
    for id in references {
        let reference = catalog
            .references
            .get(id)
            .ok_or_else(|| ReferenceError::UnknownReference(id.clone()))?;
        let cache_dir = cache_dir_for_root(reference, cache_root)?;
        cached_reference_ok(id, reference, &cache_dir)?;
    }
    Ok(())
}

pub fn update_project_references_latest(
    project_root: impl AsRef<Path>,
) -> Result<UpdateReport, ReferenceError> {
    let project_root = project_root.as_ref();
    let path = references_path(project_root);
    let mut catalog = load_catalog(project_root)?;
    let resolved_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut updated = Vec::new();
    for (id, reference) in &mut catalog.references {
        let old_commit = reference.commit.clone();
        let new_commit = resolve_github_default_branch_sha(&reference.repo)?;
        reference.commit = new_commit.clone();
        reference.resolved_at = resolved_at.clone();
        updated.push(UpdatedReference {
            id: id.clone(),
            repo: reference.repo.clone(),
            old_commit,
            new_commit,
        });
    }
    validate_catalog(&catalog)?;
    write_catalog_path(&path, &catalog)?;
    Ok(UpdateReport {
        catalog_path: path,
        updated,
    })
}

pub fn materialize_reference_artifacts(
    catalog: &ReferenceCatalog,
    id: &ReferenceId,
    artifact_dir: impl AsRef<Path>,
    required_artifacts: &[PathBuf],
    primary_artifact: Option<&Path>,
) -> Result<MaterializedReference, ReferenceError> {
    materialize_reference_artifacts_with_cache_root(
        catalog,
        id,
        artifact_dir,
        required_artifacts,
        primary_artifact,
        &cache_root(),
    )
}

fn materialize_reference_artifacts_with_cache_root(
    catalog: &ReferenceCatalog,
    id: &ReferenceId,
    artifact_dir: impl AsRef<Path>,
    required_artifacts: &[PathBuf],
    primary_artifact: Option<&Path>,
    cache_root: &Path,
) -> Result<MaterializedReference, ReferenceError> {
    let artifact_dir = artifact_dir.as_ref();
    let reference = catalog
        .references
        .get(id)
        .ok_or_else(|| ReferenceError::UnknownReference(id.clone()))?;
    let primary_artifact = primary_artifact
        .ok_or_else(|| ReferenceError::MissingPrimaryArtifact { id: id.clone() })?;
    let cache_dir = cache_dir_for_root(reference, cache_root)?;
    cached_reference_ok(id, reference, &cache_dir)?;
    let manifest = read_cache_manifest(id, &cache_dir)?;

    let reference_artifact = artifact_dir.join(primary_artifact);
    if let Some(parent) = reference_artifact.parent() {
        fs::create_dir_all(parent).map_err(|source| ReferenceError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let markdown = normalized_reference_markdown(id, reference, &cache_dir)?;
    fs::write(&reference_artifact, markdown).map_err(|source| ReferenceError::Io {
        path: reference_artifact.clone(),
        source,
    })?;

    let manifest_artifact = artifact_dir.join(RUN_REFERENCE_MANIFEST_FILE);
    if let Some(parent) = manifest_artifact.parent() {
        fs::create_dir_all(parent).map_err(|source| ReferenceError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let artifacts = vec![manifest_file_for_path(artifact_dir, primary_artifact)?];
    let run_manifest = RunReferenceManifest {
        schema_version: "1.0".to_owned(),
        reference: id.clone(),
        provider: reference.provider,
        repo: reference.repo.clone(),
        commit: reference.commit.clone(),
        resolved_at: reference.resolved_at.clone(),
        source_files: manifest
            .files
            .into_iter()
            .filter(|file| reference.paths.iter().any(|path| path == &file.path))
            .collect(),
        artifacts,
    };
    write_pretty_json(&manifest_artifact, &run_manifest)?;

    for required in required_artifacts {
        if !artifact_dir.join(required).is_file() {
            return Err(ReferenceError::MissingRequiredArtifact {
                id: id.clone(),
                path: required.clone(),
            });
        }
    }

    Ok(MaterializedReference {
        reference_artifact,
        manifest_artifact,
    })
}

fn validate_reference(id: &ReferenceId, reference: &ReferenceEntry) -> Result<(), ReferenceError> {
    match reference.provider {
        ReferenceProvider::Github => {}
    }
    github_repo_parts(reference, id)?;
    if !is_full_sha(&reference.commit) {
        return Err(ReferenceError::InvalidCommit {
            id: id.clone(),
            commit: reference.commit.clone(),
        });
    }
    if reference.paths.is_empty() {
        return Err(ReferenceError::MissingPaths { id: id.clone() });
    }
    let mut seen = BTreeSet::new();
    for path in &reference.paths {
        validate_reference_path(id, path)?;
        if !seen.insert(path.clone()) {
            return Err(ReferenceError::DuplicatePath {
                id: id.clone(),
                path: path.clone(),
            });
        }
    }
    Ok(())
}

fn github_repo_parts(
    reference: &ReferenceEntry,
    id: &ReferenceId,
) -> Result<(String, String), ReferenceError> {
    let Some((owner, repo)) = reference.repo.split_once('/') else {
        return Err(ReferenceError::InvalidRepo {
            id: id.clone(),
            repo: reference.repo.clone(),
        });
    };
    if owner.is_empty()
        || repo.is_empty()
        || reference.repo.split('/').count() != 2
        || !owner.bytes().all(is_github_repo_byte)
        || !repo.bytes().all(is_github_repo_byte)
    {
        return Err(ReferenceError::InvalidRepo {
            id: id.clone(),
            repo: reference.repo.clone(),
        });
    }
    Ok((owner.to_owned(), repo.to_owned()))
}

fn is_github_repo_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
}

fn is_full_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_reference_path(id: &ReferenceId, path: &Path) -> Result<(), ReferenceError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(ReferenceError::InvalidPath {
            id: id.clone(),
            path: path.to_path_buf(),
        });
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(ReferenceError::InvalidPath {
                    id: id.clone(),
                    path: path.to_path_buf(),
                });
            }
        }
    }
    Ok(())
}

fn ensure_no_reference_symlink_components(project_root: &Path) -> Result<(), ReferenceError> {
    let mut current = project_root.to_path_buf();
    for component in Path::new(PROJECT_REFERENCES_FILE).components() {
        match component {
            Component::Normal(_) => current.push(component.as_os_str()),
            _ => {
                return Err(ReferenceError::InvalidPath {
                    id: ReferenceId::from("references-catalog"),
                    path: PathBuf::from(PROJECT_REFERENCES_FILE),
                });
            }
        }

        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ReferenceError::SymlinkReferencePath(current));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(ReferenceError::Io {
                    path: current,
                    source,
                });
            }
        }
    }

    Ok(())
}

fn cached_reference_ok(
    id: &ReferenceId,
    reference: &ReferenceEntry,
    cache_dir: &Path,
) -> Result<(), ReferenceError> {
    if !cache_dir.is_dir() {
        return Err(ReferenceError::MissingCache {
            id: id.clone(),
            cache_dir: cache_dir.to_path_buf(),
        });
    }
    let manifest = read_cache_manifest(id, cache_dir)?;
    if manifest.provider != reference.provider
        || manifest.repo != reference.repo
        || manifest.commit != reference.commit
    {
        return Err(ReferenceError::InvalidCacheManifest {
            id: id.clone(),
            path: cache_dir.join(CACHE_MANIFEST_FILE),
            reason: "provider, repo, or commit does not match catalog".to_owned(),
        });
    }
    let manifest_files = manifest
        .files
        .iter()
        .map(|file| (&file.path, file))
        .collect::<BTreeMap<_, _>>();
    for path in &reference.paths {
        let cache_path = cache_dir.join(path);
        if !cache_path.is_file() {
            return Err(ReferenceError::MissingCachedPath {
                id: id.clone(),
                path: path.clone(),
                cache_path,
            });
        }
        let Some(file) = manifest_files.get(path) else {
            return Err(ReferenceError::InvalidCacheManifest {
                id: id.clone(),
                path: cache_dir.join(CACHE_MANIFEST_FILE),
                reason: format!("missing manifest entry for `{}`", path.display()),
            });
        };
        let current = manifest_file_for_path(cache_dir, path)?;
        if current != **file {
            return Err(ReferenceError::DigestMismatch {
                id: id.clone(),
                path: path.clone(),
            });
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct ReferenceCacheKey {
    provider: ReferenceProvider,
    repo: String,
    commit: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ReferenceCacheGroup {
    ids: Vec<ReferenceId>,
    reference: ReferenceEntry,
}

fn reference_cache_groups(catalog: &ReferenceCatalog) -> Vec<ReferenceCacheGroup> {
    let mut groups = BTreeMap::<ReferenceCacheKey, ReferenceCacheGroup>::new();
    for (id, reference) in &catalog.references {
        let key = ReferenceCacheKey {
            provider: reference.provider,
            repo: reference.repo.clone(),
            commit: reference.commit.clone(),
        };
        let group = groups.entry(key).or_insert_with(|| ReferenceCacheGroup {
            ids: Vec::new(),
            reference: ReferenceEntry {
                provider: reference.provider,
                repo: reference.repo.clone(),
                commit: reference.commit.clone(),
                paths: Vec::new(),
                resolved_at: reference.resolved_at.clone(),
            },
        });
        group.ids.push(id.clone());
        for path in &reference.paths {
            if !group
                .reference
                .paths
                .iter()
                .any(|existing| existing == path)
            {
                group.reference.paths.push(path.clone());
            }
        }
    }
    for group in groups.values_mut() {
        group.ids.sort();
        group.reference.paths.sort();
    }
    groups.into_values().collect()
}

fn fetch_reference(
    id: &ReferenceId,
    reference: &ReferenceEntry,
    cache_dir: &Path,
) -> Result<(), ReferenceError> {
    let (owner, repo_name) = github_repo_parts(reference, id)?;
    let remote = format!("https://github.com/{owner}/{repo_name}.git");
    let cache_parent = cache_dir
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    fs::create_dir_all(&cache_parent).map_err(|source| ReferenceError::Io {
        path: cache_parent.clone(),
        source,
    })?;
    let temp = TempDir::new_in(&cache_parent).map_err(|source| ReferenceError::Io {
        path: cache_parent.clone(),
        source,
    })?;
    run_git(temp.path(), &["init"])?;
    run_git(temp.path(), &["remote", "add", "origin", &remote])?;
    run_git(
        temp.path(),
        &[
            "fetch",
            "--depth=1",
            "--filter=blob:none",
            "origin",
            &reference.commit,
        ],
    )?;

    let staging = temp.path().join("cache");
    fs::create_dir_all(&staging).map_err(|source| ReferenceError::Io {
        path: staging.clone(),
        source,
    })?;
    let mut files = Vec::new();
    for path in &reference.paths {
        let data = git_blob(id, temp.path(), &reference.commit, path)?;
        let destination = staging.join(path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|source| ReferenceError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        fs::write(&destination, data).map_err(|source| ReferenceError::Io {
            path: destination.clone(),
            source,
        })?;
        files.push(manifest_file_for_path(&staging, path)?);
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let manifest = ReferenceCacheManifest {
        schema_version: "1.0".to_owned(),
        provider: reference.provider,
        repo: reference.repo.clone(),
        commit: reference.commit.clone(),
        fetched_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        files,
    };
    write_pretty_json(staging.join(CACHE_MANIFEST_FILE), &manifest)?;

    replace_cache_dir(&staging, cache_dir, temp.path())?;
    Ok(())
}

fn replace_cache_dir(
    staging: &Path,
    cache_dir: &Path,
    temp_root: &Path,
) -> Result<(), ReferenceError> {
    let backup = temp_root.join("previous-cache");
    if cache_dir.exists() {
        fs::rename(cache_dir, &backup).map_err(|source| ReferenceError::Io {
            path: cache_dir.to_path_buf(),
            source,
        })?;
    }
    match fs::rename(staging, cache_dir) {
        Ok(()) => Ok(()),
        Err(source) => {
            if backup.exists() && !cache_dir.exists() {
                let _ = fs::rename(&backup, cache_dir);
            }
            Err(ReferenceError::Io {
                path: cache_dir.to_path_buf(),
                source,
            })
        }
    }
}

fn resolve_github_default_branch_sha(repo: &str) -> Result<String, ReferenceError> {
    let reference = ReferenceEntry {
        provider: ReferenceProvider::Github,
        repo: repo.to_owned(),
        commit: "0000000000000000000000000000000000000000".to_owned(),
        paths: vec![PathBuf::from("README.md")],
        resolved_at: String::new(),
    };
    let (owner, repo_name) = github_repo_parts(&reference, &ReferenceId::from("update-latest"))?;
    let remote = format!("https://github.com/{owner}/{repo_name}.git");
    let output = Command::new("git")
        .args(["ls-remote", "--symref", &remote, "HEAD"])
        .output()
        .map_err(|source| ReferenceError::Io {
            path: PathBuf::from("git"),
            source,
        })?;
    if !output.status.success() {
        return Err(ReferenceError::Git {
            command: format!("git ls-remote --symref {remote} HEAD"),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .find_map(|(sha, name)| (name == "HEAD" && is_full_sha(sha)).then(|| sha.to_owned()))
        .ok_or_else(|| ReferenceError::MissingHeadSha {
            repo: repo.to_owned(),
        })
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<(), ReferenceError> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|source| ReferenceError::Io {
            path: cwd.to_path_buf(),
            source,
        })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(ReferenceError::Git {
            command: format!("git {}", args.join(" ")),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

fn git_blob(
    id: &ReferenceId,
    cwd: &Path,
    commit: &str,
    path: &Path,
) -> Result<Vec<u8>, ReferenceError> {
    let object = format!("{commit}:{}", path.to_string_lossy());
    let object_type = git_object_type(cwd, &object)?;
    if object_type != "blob" {
        return Err(ReferenceError::NonBlobPath {
            id: id.clone(),
            path: path.to_path_buf(),
            commit: commit.to_owned(),
            object_type,
        });
    }
    let output = Command::new("git")
        .current_dir(cwd)
        .args(["show", &object])
        .output()
        .map_err(|source| ReferenceError::Io {
            path: cwd.to_path_buf(),
            source,
        })?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(ReferenceError::Git {
            command: format!("git show {object}"),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

fn git_object_type(cwd: &Path, object: &str) -> Result<String, ReferenceError> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(["cat-file", "-t", object])
        .output()
        .map_err(|source| ReferenceError::Io {
            path: cwd.to_path_buf(),
            source,
        })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        Err(ReferenceError::Git {
            command: format!("git cat-file -t {object}"),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

fn normalized_reference_markdown(
    id: &ReferenceId,
    reference: &ReferenceEntry,
    cache_dir: &Path,
) -> Result<String, ReferenceError> {
    let mut markdown = String::new();
    markdown.push_str(&format!("# Pinned Reference: {id}\n\n"));
    markdown.push_str("- Provider: github\n");
    markdown.push_str(&format!("- Repository: `{}`\n", reference.repo));
    markdown.push_str(&format!("- Commit: `{}`\n", reference.commit));
    markdown.push_str(&format!("- Resolved at: `{}`\n\n", reference.resolved_at));
    for path in &reference.paths {
        let cache_path = cache_dir.join(path);
        let bytes = fs::read(&cache_path).map_err(|source| ReferenceError::Io {
            path: cache_path.clone(),
            source,
        })?;
        let text = String::from_utf8_lossy(&bytes);
        markdown.push_str(&format!("## `{}`\n\n", path.display()));
        if path.extension().and_then(|value| value.to_str()) == Some("md") {
            markdown.push_str(text.trim_end());
            markdown.push_str("\n\n");
        } else {
            markdown.push_str("```");
            if let Some(language) = fenced_language(path) {
                markdown.push_str(language);
            }
            markdown.push('\n');
            markdown.push_str(text.trim_end());
            markdown.push_str("\n```\n\n");
        }
    }
    Ok(markdown)
}

fn fenced_language(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|value| value.to_str()) {
        Some("sol") => Some("solidity"),
        Some("spec") => Some("cvl"),
        Some("conf") => Some("text"),
        Some("yaml" | "yml") => Some("yaml"),
        Some("json") => Some("json"),
        Some("sh") => Some("bash"),
        _ => None,
    }
}

fn read_cache_manifest(
    id: &ReferenceId,
    cache_dir: &Path,
) -> Result<ReferenceCacheManifest, ReferenceError> {
    let path = cache_dir.join(CACHE_MANIFEST_FILE);
    let bytes = fs::read(&path).map_err(|source| ReferenceError::Io {
        path: path.clone(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(|source| ReferenceError::InvalidCacheManifest {
        id: id.clone(),
        path,
        reason: source.to_string(),
    })
}

fn write_catalog_path(path: &Path, catalog: &ReferenceCatalog) -> Result<(), ReferenceError> {
    let contents = serde_yaml::to_string(catalog)
        .map_err(|error| ReferenceError::Serialize(error.to_string()))?;
    fs::write(path, contents).map_err(|source| ReferenceError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn write_pretty_json(path: impl AsRef<Path>, value: &impl Serialize) -> Result<(), ReferenceError> {
    let path = path.as_ref();
    let contents = serde_json::to_string_pretty(value)
        .map_err(|error| ReferenceError::Serialize(error.to_string()))?;
    fs::write(path, format!("{contents}\n")).map_err(|source| ReferenceError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn manifest_file_for_path(
    root: &Path,
    relative_path: &Path,
) -> Result<ReferenceManifestFile, ReferenceError> {
    let full_path = root.join(relative_path);
    let bytes = fs::read(&full_path).map_err(|source| ReferenceError::Io {
        path: full_path.clone(),
        source,
    })?;
    Ok(ReferenceManifestFile {
        path: relative_path.to_path_buf(),
        size_bytes: bytes.len() as u64,
        sha256: hex_sha256(&bytes),
    })
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_catalog(commit: &str, path: &str) -> String {
        format!(
            r#"version: 1
references:
  properties.example:
    provider: github
    repo: owner/repo
    commit: {commit}
    paths:
      - {path}
    resolved_at: "2026-06-23T00:00:00Z"
"#
        )
    }

    fn example_catalog(paths: Vec<PathBuf>) -> (ReferenceId, ReferenceCatalog) {
        let id = ReferenceId::from("properties.example");
        let mut references = BTreeMap::new();
        references.insert(
            id.clone(),
            ReferenceEntry {
                provider: ReferenceProvider::Github,
                repo: "owner/repo".to_owned(),
                commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
                paths,
                resolved_at: "2026-06-23T00:00:00Z".to_owned(),
            },
        );
        (
            id,
            ReferenceCatalog {
                version: REFERENCES_VERSION,
                references,
            },
        )
    }

    fn git_stdout(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn parses_valid_catalog() {
        let catalog = parse_catalog(&valid_catalog(
            "0123456789abcdef0123456789abcdef01234567",
            "README.md",
        ))
        .unwrap();
        let reference = catalog
            .references
            .get(&ReferenceId::from("properties.example"))
            .unwrap();
        assert_eq!(reference.repo, "owner/repo");
        assert_eq!(reference.paths, vec![PathBuf::from("README.md")]);
    }

    #[test]
    fn bundled_default_catalog_is_valid() {
        let catalog = parse_catalog(DEFAULT_REFERENCE_CATALOG).unwrap();
        assert_eq!(catalog.references.len(), 9);
        let rounding = catalog
            .references
            .get(&ReferenceId::from("properties.montyly-rounding"))
            .unwrap();
        assert_eq!(rounding.repo, "montyly/montyly.github.io");
        assert_eq!(rounding.commit, "a3dbfa1fbacd05fb2e5e7c66acb2243dafd1483d");
    }

    #[cfg(unix)]
    #[test]
    fn write_default_catalog_rejects_symlinked_ultrafuzz_dir() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join(".ultrafuzz")).unwrap();

        let error = write_default_reference_catalog(temp.path(), false).unwrap_err();

        assert!(matches!(error, ReferenceError::SymlinkReferencePath(_)));
    }

    #[cfg(unix)]
    #[test]
    fn write_default_catalog_rejects_symlinked_reference_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join(".ultrafuzz")).unwrap();
        let outside_file = temp.path().join("outside.yml");
        fs::write(&outside_file, "do not overwrite\n").unwrap();
        std::os::unix::fs::symlink(&outside_file, references_path(temp.path())).unwrap();

        let error = write_default_reference_catalog(temp.path(), true).unwrap_err();

        assert!(matches!(error, ReferenceError::SymlinkReferencePath(_)));
        assert_eq!(
            fs::read_to_string(outside_file).unwrap(),
            "do not overwrite\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn load_catalog_rejects_symlinked_reference_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join(".ultrafuzz")).unwrap();
        let outside_file = temp.path().join("outside.yml");
        fs::write(&outside_file, DEFAULT_REFERENCE_CATALOG).unwrap();
        std::os::unix::fs::symlink(&outside_file, references_path(temp.path())).unwrap();

        let error = load_catalog(temp.path()).unwrap_err();

        assert!(matches!(error, ReferenceError::SymlinkReferencePath(_)));
    }

    #[test]
    fn cache_groups_union_paths_for_shared_repo_commit() {
        let mut references = BTreeMap::new();
        for (id, paths) in [
            (
                "properties.first",
                vec![PathBuf::from("README.md"), PathBuf::from("docs/a.md")],
            ),
            (
                "properties.second",
                vec![PathBuf::from("README.md"), PathBuf::from("docs/b.md")],
            ),
        ] {
            references.insert(
                ReferenceId::from(id),
                ReferenceEntry {
                    provider: ReferenceProvider::Github,
                    repo: "owner/repo".to_owned(),
                    commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
                    paths,
                    resolved_at: "2026-06-23T00:00:00Z".to_owned(),
                },
            );
        }
        let catalog = ReferenceCatalog {
            version: REFERENCES_VERSION,
            references,
        };

        let groups = reference_cache_groups(&catalog);

        assert_eq!(groups.len(), 1);
        assert_eq!(
            groups[0].ids,
            vec![
                ReferenceId::from("properties.first"),
                ReferenceId::from("properties.second")
            ]
        );
        assert_eq!(
            groups[0].reference.paths,
            vec![
                PathBuf::from("README.md"),
                PathBuf::from("docs/a.md"),
                PathBuf::from("docs/b.md")
            ]
        );
    }

    #[test]
    fn rejects_short_commits() {
        let error = parse_catalog(&valid_catalog("abc123", "README.md")).unwrap_err();
        assert!(error.to_string().contains("full 40-character SHA"));
    }

    #[test]
    fn rejects_unsafe_paths() {
        let error = parse_catalog(&valid_catalog(
            "0123456789abcdef0123456789abcdef01234567",
            "../README.md",
        ))
        .unwrap_err();
        assert!(error.to_string().contains("relative and traversal-free"));
    }

    #[test]
    fn git_blob_rejects_directory_paths() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]).unwrap();
        fs::create_dir(temp.path().join("docs")).unwrap();
        fs::write(temp.path().join("docs/page.md"), "# Page\n").unwrap();
        run_git(temp.path(), &["add", "."]).unwrap();
        let output = Command::new("git")
            .current_dir(temp.path())
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
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let commit = git_stdout(temp.path(), &["rev-parse", "HEAD"]);

        let error = git_blob(
            &ReferenceId::from("properties.example"),
            temp.path(),
            &commit,
            Path::new("docs"),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            ReferenceError::NonBlobPath { object_type, .. } if object_type == "tree"
        ));
    }

    #[test]
    fn status_reports_missing_cache() {
        let temp = tempfile::tempdir().unwrap();
        let catalog = parse_catalog(&valid_catalog(
            "0123456789abcdef0123456789abcdef01234567",
            "README.md",
        ))
        .unwrap();
        let report =
            status_catalog_with_cache_root(temp.path(), &catalog, &temp.path().join("cache"))
                .unwrap();
        assert!(!report.ok());
        assert!(report.references[0].messages[0].contains("missing"));
    }

    #[test]
    fn materializes_cached_reference_artifacts_and_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let (id, catalog) = example_catalog(vec![
            PathBuf::from("README.md"),
            PathBuf::from("contracts/Invariant.sol"),
        ]);
        let reference = catalog.references.get(&id).unwrap();
        let cache_root = temp.path().join("cache");
        let cache_dir = cache_dir_for_root(reference, &cache_root).unwrap();
        fs::create_dir_all(cache_dir.join("contracts")).unwrap();
        fs::write(cache_dir.join("README.md"), "# Reference\n\nUse this.").unwrap();
        fs::write(
            cache_dir.join("contracts/Invariant.sol"),
            "contract Invariant {}\n",
        )
        .unwrap();
        let cache_manifest = ReferenceCacheManifest {
            schema_version: "1.0".to_owned(),
            provider: ReferenceProvider::Github,
            repo: reference.repo.clone(),
            commit: reference.commit.clone(),
            fetched_at: "2026-06-23T00:00:00Z".to_owned(),
            files: vec![
                manifest_file_for_path(&cache_dir, Path::new("README.md")).unwrap(),
                manifest_file_for_path(&cache_dir, Path::new("contracts/Invariant.sol")).unwrap(),
            ],
        };
        write_pretty_json(cache_dir.join(CACHE_MANIFEST_FILE), &cache_manifest).unwrap();

        let artifacts_dir = temp.path().join("artifacts");
        let materialized = materialize_reference_artifacts_with_cache_root(
            &catalog,
            &id,
            &artifacts_dir,
            &[
                PathBuf::from("references/example.md"),
                PathBuf::from(RUN_REFERENCE_MANIFEST_FILE),
            ],
            Some(Path::new("references/example.md")),
            &cache_root,
        )
        .unwrap();

        let markdown = fs::read_to_string(&materialized.reference_artifact).unwrap();
        assert!(markdown.contains("# Pinned Reference: properties.example"));
        assert!(markdown.contains("- Repository: `owner/repo`"));
        assert!(markdown.contains("## `README.md`"));
        assert!(markdown.contains("## `contracts/Invariant.sol`"));
        assert!(markdown.contains("```solidity\ncontract Invariant {}\n```"));

        let run_manifest: RunReferenceManifest =
            serde_json::from_slice(&fs::read(&materialized.manifest_artifact).unwrap()).unwrap();
        assert_eq!(run_manifest.reference, id);
        assert_eq!(run_manifest.source_files.len(), 2);
        assert_eq!(run_manifest.artifacts.len(), 1);
        assert_eq!(
            run_manifest.artifacts[0].path,
            PathBuf::from("references/example.md")
        );
    }

    #[test]
    fn status_reports_digest_mismatch() {
        let temp = tempfile::tempdir().unwrap();
        let (id, catalog) = example_catalog(vec![PathBuf::from("README.md")]);
        let reference = catalog.references.get(&id).unwrap();
        let cache_root = temp.path().join("cache");
        let cache_dir = cache_dir_for_root(reference, &cache_root).unwrap();
        fs::create_dir_all(&cache_dir).unwrap();
        fs::write(cache_dir.join("README.md"), "# Reference\n").unwrap();
        let cache_manifest = ReferenceCacheManifest {
            schema_version: "1.0".to_owned(),
            provider: ReferenceProvider::Github,
            repo: reference.repo.clone(),
            commit: reference.commit.clone(),
            fetched_at: "2026-06-23T00:00:00Z".to_owned(),
            files: vec![ReferenceManifestFile {
                path: PathBuf::from("README.md"),
                size_bytes: 0,
                sha256: "0".repeat(64),
            }],
        };
        write_pretty_json(cache_dir.join(CACHE_MANIFEST_FILE), &cache_manifest).unwrap();

        let report = status_catalog_with_cache_root(temp.path(), &catalog, &cache_root).unwrap();

        assert!(!report.ok());
        assert!(report.references[0].messages[0].contains("digest mismatch"));
    }
}
