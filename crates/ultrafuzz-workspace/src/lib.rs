use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};
use thiserror::Error;
use ultrafuzz_core::{NodeId, RunId, WorkspaceMode};

pub const WORKSPACE_MANIFEST_FILE: &str = "workspace-manifest.json";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceRequest {
    pub run_id: RunId,
    pub node_id: NodeId,
    pub target_repo: PathBuf,
    pub workspace_path: PathBuf,
    pub artifact_dir: PathBuf,
    pub mode: WorkspaceMode,
    pub keep_workspaces: bool,
}

impl WorkspaceRequest {
    pub fn attempt(
        run_id: RunId,
        node_id: NodeId,
        target_repo: impl Into<PathBuf>,
        workspace_path: impl Into<PathBuf>,
        artifact_dir: impl Into<PathBuf>,
        mode: WorkspaceMode,
        keep_workspaces: bool,
    ) -> Self {
        Self {
            run_id,
            node_id,
            target_repo: target_repo.into(),
            workspace_path: workspace_path.into(),
            artifact_dir: artifact_dir.into(),
            mode,
            keep_workspaces,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Workspace {
    pub run_id: RunId,
    pub node_id: NodeId,
    pub target_repo: PathBuf,
    pub path: PathBuf,
    pub artifact_dir: PathBuf,
    pub mode: WorkspaceMode,
    pub branch_name: Option<String>,
    pub writable: bool,
    pub persistent: bool,
    cleanup: WorkspaceCleanup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceCleanup {
    DeleteDirectory,
    RemoveGitWorktree,
    Preserve,
    None,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceManifest {
    pub schema_version: String,
    pub run_id: RunId,
    pub node_id: NodeId,
    pub mode: WorkspaceMode,
    pub target_repo: PathBuf,
    pub workspace_path: PathBuf,
    pub artifact_dir: PathBuf,
    pub branch_name: Option<String>,
    pub writable: bool,
    pub persistent: bool,
    pub cleanup: WorkspaceCleanup,
}

pub trait WorkspaceManager: Send + Sync {
    fn create(&self, request: WorkspaceRequest) -> anyhow::Result<Workspace>;
    fn cleanup(&self, workspace: Workspace) -> anyhow::Result<()>;
}

#[derive(Clone, Debug, Default)]
pub struct FilesystemWorkspaceManager;

impl FilesystemWorkspaceManager {
    pub fn new() -> Self {
        Self
    }
}

impl WorkspaceManager for FilesystemWorkspaceManager {
    fn create(&self, request: WorkspaceRequest) -> anyhow::Result<Workspace> {
        create_workspace(request).map_err(Into::into)
    }

    fn cleanup(&self, workspace: Workspace) -> anyhow::Result<()> {
        cleanup_workspace(workspace).map_err(Into::into)
    }
}

pub fn safe_branch_name(run_id: &RunId, node_id: &NodeId) -> Result<String, WorkspaceError> {
    validate_safe_id("run id", run_id.as_str())?;
    validate_safe_id("node id", node_id.as_str())?;
    Ok(format!("ultrafuzz/{run_id}/{node_id}"))
}

pub fn validate_safe_relative_path(path: &Path) -> Result<(), WorkspaceError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(WorkspaceError::UnsafePath {
            path: path.to_path_buf(),
            reason: "path must be non-empty and relative".to_owned(),
        });
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(WorkspaceError::UnsafePath {
                path: path.to_path_buf(),
                reason: "path may not contain traversal or root components".to_owned(),
            });
        }
    }
    Ok(())
}

pub fn ensure_path_inside(root: &Path, path: &Path) -> Result<(), WorkspaceError> {
    let root = canonical_existing(root)?;
    let candidate = canonical_existing_or_parent(path)?;
    if candidate.starts_with(&root) {
        Ok(())
    } else {
        Err(WorkspaceError::UnsafePath {
            path: path.to_path_buf(),
            reason: format!("path is outside {}", root.display()),
        })
    }
}

fn create_workspace(request: WorkspaceRequest) -> Result<Workspace, WorkspaceError> {
    validate_safe_id("node id", request.node_id.as_str())?;
    fs::create_dir_all(&request.artifact_dir)?;
    let target_repo = canonical_existing(&request.target_repo)?;
    validate_no_symlink_escape(&target_repo)?;

    let branch_name = matches!(request.mode, WorkspaceMode::GitWorktree)
        .then(|| safe_branch_name(&request.run_id, &request.node_id))
        .transpose()?;

    let (path, writable, persistent, cleanup) = match request.mode {
        WorkspaceMode::GitWorktree => {
            prepare_empty_workspace_path(&request.workspace_path)?;
            if is_git_repo(&target_repo) {
                let branch = branch_name
                    .as_ref()
                    .expect("git-worktree mode must have a branch name");
                run_git(
                    &target_repo,
                    [
                        OsStr::new("worktree"),
                        OsStr::new("add"),
                        OsStr::new("-B"),
                        OsStr::new(branch),
                        request.workspace_path.as_os_str(),
                        OsStr::new("HEAD"),
                    ],
                )?;
                if let Err(error) =
                    initialize_git_worktree_submodules(&target_repo, &request.workspace_path)
                {
                    cleanup_failed_git_worktree(
                        &target_repo,
                        &request.workspace_path,
                        Some(branch),
                    );
                    return Err(error);
                }
                (
                    request.workspace_path.clone(),
                    true,
                    false,
                    if request.keep_workspaces {
                        WorkspaceCleanup::Preserve
                    } else {
                        WorkspaceCleanup::RemoveGitWorktree
                    },
                )
            } else {
                copy_repo(&target_repo, &request.workspace_path)?;
                initialize_copy_workspace_git_baseline(&request.workspace_path)?;
                (
                    request.workspace_path.clone(),
                    true,
                    false,
                    if request.keep_workspaces {
                        WorkspaceCleanup::Preserve
                    } else {
                        WorkspaceCleanup::DeleteDirectory
                    },
                )
            }
        }
        WorkspaceMode::TempdirCopy => {
            prepare_empty_workspace_path(&request.workspace_path)?;
            copy_repo(&target_repo, &request.workspace_path)?;
            initialize_copy_workspace_git_baseline(&request.workspace_path)?;
            (
                request.workspace_path.clone(),
                true,
                false,
                if request.keep_workspaces {
                    WorkspaceCleanup::Preserve
                } else {
                    WorkspaceCleanup::DeleteDirectory
                },
            )
        }
        WorkspaceMode::InPlaceReadonly => {
            (target_repo.clone(), false, true, WorkspaceCleanup::None)
        }
        WorkspaceMode::PersistentDebug => {
            prepare_empty_workspace_path(&request.workspace_path)?;
            copy_repo(&target_repo, &request.workspace_path)?;
            initialize_copy_workspace_git_baseline(&request.workspace_path)?;
            (
                request.workspace_path.clone(),
                true,
                true,
                WorkspaceCleanup::Preserve,
            )
        }
    };

    let workspace = Workspace {
        run_id: request.run_id.clone(),
        node_id: request.node_id.clone(),
        target_repo: target_repo.clone(),
        path,
        artifact_dir: request.artifact_dir.clone(),
        mode: request.mode,
        branch_name,
        writable,
        persistent,
        cleanup,
    };
    write_workspace_manifest(&workspace, &target_repo)?;
    Ok(workspace)
}

fn cleanup_failed_git_worktree(
    target_repo: &Path,
    workspace_path: &Path,
    branch_name: Option<&str>,
) {
    if workspace_path.exists() {
        let remove_result = Command::new("git")
            .arg("-C")
            .arg(target_repo)
            .arg("worktree")
            .arg("remove")
            .arg("--force")
            .arg(workspace_path)
            .output();
        match remove_result {
            Ok(output) if output.status.success() => {}
            _ => {
                let _ = fs::remove_dir_all(workspace_path);
            }
        }
    }
    if let Some(branch_name) = branch_name {
        let _ = Command::new("git")
            .arg("-C")
            .arg(target_repo)
            .arg("branch")
            .arg("-D")
            .arg(branch_name)
            .output();
    }
}

fn cleanup_workspace(workspace: Workspace) -> Result<(), WorkspaceError> {
    match workspace.cleanup {
        WorkspaceCleanup::Preserve | WorkspaceCleanup::None => Ok(()),
        WorkspaceCleanup::DeleteDirectory => {
            if workspace.path.exists() {
                fs::remove_dir_all(&workspace.path)?;
            }
            Ok(())
        }
        WorkspaceCleanup::RemoveGitWorktree => {
            if workspace.path.exists() {
                let remove_result = Command::new("git")
                    .arg("-C")
                    .arg(&workspace.target_repo)
                    .arg("worktree")
                    .arg("remove")
                    .arg("--force")
                    .arg(&workspace.path)
                    .output();
                match remove_result {
                    Ok(output) if output.status.success() => {}
                    _ => {
                        fs::remove_dir_all(&workspace.path)?;
                    }
                }
            }
            if let Some(branch_name) = &workspace.branch_name {
                let _ = Command::new("git")
                    .arg("-C")
                    .arg(&workspace.target_repo)
                    .arg("branch")
                    .arg("-D")
                    .arg(branch_name)
                    .output();
            }
            Ok(())
        }
    }
}

fn write_workspace_manifest(
    workspace: &Workspace,
    target_repo: &Path,
) -> Result<(), WorkspaceError> {
    let manifest = WorkspaceManifest {
        schema_version: "1.0".to_owned(),
        run_id: workspace.run_id.clone(),
        node_id: workspace.node_id.clone(),
        mode: workspace.mode,
        target_repo: target_repo.to_path_buf(),
        workspace_path: workspace.path.clone(),
        artifact_dir: workspace.artifact_dir.clone(),
        branch_name: workspace.branch_name.clone(),
        writable: workspace.writable,
        persistent: workspace.persistent,
        cleanup: workspace.cleanup,
    };
    let path = workspace.artifact_dir.join(WORKSPACE_MANIFEST_FILE);
    let json = serde_json::to_string_pretty(&manifest)?;
    fs::write(path, format!("{json}\n"))?;
    Ok(())
}

fn prepare_empty_workspace_path(path: &Path) -> Result<(), WorkspaceError> {
    if path.exists() {
        if fs::read_dir(path)?.next().is_some() {
            return Err(WorkspaceError::WorkspaceExists {
                path: path.to_path_buf(),
            });
        }
    } else {
        fs::create_dir_all(path)?;
    }
    Ok(())
}

fn copy_repo(source: &Path, destination: &Path) -> Result<(), WorkspaceError> {
    validate_no_symlink_escape(source)?;
    copy_dir(source, destination, source)
}

fn initialize_copy_workspace_git_baseline(path: &Path) -> Result<(), WorkspaceError> {
    run_git(path, [OsStr::new("init"), OsStr::new("--quiet")])?;
    run_git(path, [OsStr::new("add"), OsStr::new("-A")])?;
    run_git(
        path,
        [
            OsStr::new("-c"),
            OsStr::new("user.email=ultrafuzz@example.invalid"),
            OsStr::new("-c"),
            OsStr::new("user.name=Ultrafuzz"),
            OsStr::new("-c"),
            OsStr::new("commit.gpgsign=false"),
            OsStr::new("commit"),
            OsStr::new("--quiet"),
            OsStr::new("--allow-empty"),
            OsStr::new("-m"),
            OsStr::new("ultrafuzz workspace baseline"),
        ],
    )
}

fn copy_dir(source: &Path, destination: &Path, root: &Path) -> Result<(), WorkspaceError> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_name = entry.file_name();
        if should_skip_copy_entry(source, &file_name) {
            continue;
        }
        let source_path = entry.path();
        let destination_path = destination.join(&file_name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir(&source_path, &destination_path, root)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)?;
        } else if file_type.is_symlink() {
            copy_symlink(&source_path, &destination_path, root)?;
        }
    }
    Ok(())
}

fn should_skip_copy_entry(parent: &Path, file_name: &OsStr) -> bool {
    if file_name == OsStr::new(".git") {
        return true;
    }
    if file_name == OsStr::new(".ultrafuzz") {
        return true;
    }
    if is_sensitive_copy_entry(file_name) {
        return true;
    }
    parent
        .file_name()
        .is_some_and(|name| name == OsStr::new(".ultrafuzz") && file_name == OsStr::new("runs"))
}

fn is_sensitive_copy_entry(file_name: &OsStr) -> bool {
    let Some(name) = file_name.to_str() else {
        return false;
    };
    if name == ".env" || name.starts_with(".env.") {
        return true;
    }
    if matches!(
        name,
        "secrets" | ".secrets" | ".ssh" | ".aws" | ".gcloud" | ".azure"
    ) {
        return true;
    }
    Path::new(name)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| matches!(extension, "pem" | "key"))
}

#[cfg(unix)]
fn copy_symlink(
    source_path: &Path,
    destination_path: &Path,
    root: &Path,
) -> Result<(), WorkspaceError> {
    let target = fs::read_link(source_path)?;
    if target.is_absolute() {
        return Err(WorkspaceError::UnsafePath {
            path: source_path.to_path_buf(),
            reason: "absolute symlinks are not copied into isolated workspaces".to_owned(),
        });
    }
    let resolved = source_path
        .parent()
        .expect("symlink source has parent")
        .join(&target);
    ensure_path_inside(root, &resolved)?;
    std::os::unix::fs::symlink(target, destination_path)?;
    Ok(())
}

#[cfg(not(unix))]
fn copy_symlink(
    source_path: &Path,
    _destination_path: &Path,
    root: &Path,
) -> Result<(), WorkspaceError> {
    let target = fs::read_link(source_path)?;
    if target.is_absolute() {
        return Err(WorkspaceError::UnsafePath {
            path: source_path.to_path_buf(),
            reason: "absolute symlinks are not copied into isolated workspaces".to_owned(),
        });
    }
    let resolved = source_path
        .parent()
        .expect("symlink source has parent")
        .join(&target);
    ensure_path_inside(root, &resolved)?;
    Err(WorkspaceError::UnsupportedSymlink {
        path: source_path.to_path_buf(),
    })
}

fn validate_no_symlink_escape(root: &Path) -> Result<(), WorkspaceError> {
    let root = canonical_existing(root)?;
    validate_no_symlink_escape_inner(&root, &root)
}

fn validate_no_symlink_escape_inner(root: &Path, dir: &Path) -> Result<(), WorkspaceError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            let target = fs::read_link(&path)?;
            let resolved = if target.is_absolute() {
                target
            } else {
                path.parent().expect("symlink path has parent").join(target)
            };
            ensure_path_inside(root, &resolved).map_err(|_| {
                WorkspaceError::SymlinkEscapesRoot {
                    path: path.clone(),
                    target: resolved,
                }
            })?;
        } else if file_type.is_dir() {
            validate_no_symlink_escape_inner(root, &path)?;
        }
    }
    Ok(())
}

fn is_git_repo(path: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .output()
        .is_ok_and(|output| output.status.success())
}

fn initialize_git_worktree_submodules(
    target_repo: &Path,
    workspace_path: &Path,
) -> Result<(), WorkspaceError> {
    for submodule in initialized_direct_submodules(target_repo)? {
        let target_submodule = target_repo.join(&submodule.path);
        let workspace_submodule = workspace_path.join(&submodule.path);
        let config_key = format!("submodule.{}.url", submodule.name);
        run_git_dynamic(
            workspace_path,
            &[
                OsStr::new("config"),
                OsStr::new(&config_key),
                target_submodule.as_os_str(),
            ],
        )?;
        run_git_dynamic(
            workspace_path,
            &[
                OsStr::new("-c"),
                OsStr::new("protocol.file.allow=always"),
                OsStr::new("submodule"),
                OsStr::new("update"),
                OsStr::new("--init"),
                OsStr::new("--no-fetch"),
                OsStr::new("--"),
                submodule.path.as_os_str(),
            ],
        )?;
        initialize_git_worktree_submodules(&target_submodule, &workspace_submodule)?;
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct InitializedSubmodule {
    name: String,
    path: PathBuf,
}

fn initialized_direct_submodules(repo: &Path) -> Result<Vec<InitializedSubmodule>, WorkspaceError> {
    if !repo.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let configured = configured_submodules(repo)?;
    let output = git_output(repo, [OsStr::new("submodule"), OsStr::new("status")])?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| parse_initialized_submodule_status_line(line, &configured))
        .collect())
}

fn configured_submodules(repo: &Path) -> Result<Vec<InitializedSubmodule>, WorkspaceError> {
    let output = git_output(
        repo,
        [
            OsStr::new("config"),
            OsStr::new("--file"),
            OsStr::new(".gitmodules"),
            OsStr::new("--get-regexp"),
            OsStr::new("^submodule\\..*\\.path$"),
        ],
    )?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_gitmodules_path_line)
        .collect())
}

fn parse_gitmodules_path_line(line: &str) -> Option<InitializedSubmodule> {
    let (key, path) = line.split_once(char::is_whitespace)?;
    let name = key
        .strip_prefix("submodule.")?
        .strip_suffix(".path")?
        .trim_matches('"')
        .to_owned();
    Some(InitializedSubmodule {
        name,
        path: PathBuf::from(path.trim()),
    })
}

fn parse_initialized_submodule_status_line(
    line: &str,
    configured: &[InitializedSubmodule],
) -> Option<InitializedSubmodule> {
    if line.trim().is_empty() || line.starts_with('-') {
        return None;
    }
    let mut fields = line.split_whitespace();
    let _revision = fields.next()?;
    let path = PathBuf::from(fields.next()?);
    configured
        .iter()
        .find(|submodule| submodule.path == path)
        .cloned()
}

fn run_git<const N: usize>(repo: &Path, args: [&OsStr; N]) -> Result<(), WorkspaceError> {
    let output = git_output_dynamic(repo, &args)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(WorkspaceError::GitFailed {
            command: "git".to_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

fn git_output<const N: usize>(
    repo: &Path,
    args: [&OsStr; N],
) -> Result<std::process::Output, WorkspaceError> {
    git_output_dynamic(repo, &args)
}

fn run_git_dynamic(repo: &Path, args: &[&OsStr]) -> Result<(), WorkspaceError> {
    let output = git_output_dynamic(repo, args)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(WorkspaceError::GitFailed {
            command: "git".to_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

fn git_output_dynamic(
    repo: &Path,
    args: &[&OsStr],
) -> Result<std::process::Output, WorkspaceError> {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|source| WorkspaceError::GitIo {
            command: "git".to_owned(),
            source,
        })
}

fn validate_safe_id(label: &'static str, value: &str) -> Result<(), WorkspaceError> {
    if value.is_empty()
        || value.starts_with('.')
        || value.ends_with('.')
        || value.contains("..")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(WorkspaceError::UnsafeIdentifier {
            label,
            value: value.to_owned(),
        });
    }
    Ok(())
}

fn canonical_existing(path: &Path) -> Result<PathBuf, WorkspaceError> {
    path.canonicalize().map_err(WorkspaceError::Io)
}

fn canonical_existing_or_parent(path: &Path) -> Result<PathBuf, WorkspaceError> {
    if path.exists() {
        return canonical_existing(path);
    }
    let parent = path.parent().ok_or_else(|| WorkspaceError::UnsafePath {
        path: path.to_path_buf(),
        reason: "path has no parent".to_owned(),
    })?;
    canonical_existing(parent)
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to serialize workspace manifest: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsafe {label} `{value}`")]
    UnsafeIdentifier { label: &'static str, value: String },
    #[error("unsafe path `{path}`: {reason}")]
    UnsafePath { path: PathBuf, reason: String },
    #[error("workspace path already exists and is not empty: {path}")]
    WorkspaceExists { path: PathBuf },
    #[error("symlink `{path}` escapes target repo root with target `{target}`")]
    SymlinkEscapesRoot { path: PathBuf, target: PathBuf },
    #[error("symlink copying is unsupported on this platform: {path}")]
    UnsupportedSymlink { path: PathBuf },
    #[error("failed to run {command}: {source}")]
    GitIo {
        command: String,
        source: std::io::Error,
    },
    #[error("{command} failed: {stderr}")]
    GitFailed { command: String, stderr: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_branch_names_reject_unsafe_ids() {
        assert_eq!(
            safe_branch_name(&RunId::from("run-1"), &NodeId::from("encode-decode-0")).unwrap(),
            "ultrafuzz/run-1/encode-decode-0"
        );
        assert!(safe_branch_name(&RunId::new_unchecked("../run"), &NodeId::from("node")).is_err());
        assert!(safe_branch_name(&RunId::from("run"), &NodeId::new_unchecked("bad/node")).is_err());
    }

    #[test]
    fn path_safety_rejects_traversal() {
        assert!(validate_safe_relative_path(Path::new("src/Test.sol")).is_ok());
        assert!(validate_safe_relative_path(Path::new("../secret")).is_err());
        assert!(validate_safe_relative_path(Path::new("/tmp/secret")).is_err());
    }

    #[test]
    fn ensure_path_inside_rejects_parent_traversal_after_canonicalization() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();

        let error = ensure_path_inside(&root, &root.join("../outside/secret.txt")).unwrap_err();

        assert!(matches!(error, WorkspaceError::UnsafePath { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_path_inside_rejects_symlink_adjacent_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked-outside")).unwrap();

        let error =
            ensure_path_inside(&root, &root.join("linked-outside/missing.txt")).unwrap_err();

        assert!(matches!(error, WorkspaceError::UnsafePath { .. }));
    }

    #[test]
    fn tempdir_copy_creates_unique_workspace_and_manifest_then_cleans() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::write(repo.join("src/Contract.sol"), "contract C {}\n").unwrap();
        let workspace_path = temp.path().join("runs/run/workspaces/encode-decode-0");
        let artifact_dir = temp.path().join("runs/run/artifacts/encode-decode-0");
        let manager = FilesystemWorkspaceManager::new();

        let workspace = manager
            .create(WorkspaceRequest::attempt(
                RunId::from("run"),
                NodeId::from("encode-decode-0"),
                &repo,
                &workspace_path,
                &artifact_dir,
                WorkspaceMode::TempdirCopy,
                false,
            ))
            .unwrap();

        assert_ne!(workspace.path, repo);
        assert!(workspace.path.join("src/Contract.sol").exists());
        assert!(artifact_dir.join(WORKSPACE_MANIFEST_FILE).exists());
        manager.cleanup(workspace).unwrap();
        assert!(!workspace_path.exists());
        assert!(artifact_dir.exists());
    }

    #[test]
    fn tempdir_copy_excludes_sensitive_default_entries() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::create_dir_all(repo.join(".ssh")).unwrap();
        fs::create_dir_all(repo.join("secrets")).unwrap();
        fs::write(repo.join("src/Contract.sol"), "contract C {}\n").unwrap();
        fs::write(repo.join(".env"), "PRIVATE_KEY=secret\n").unwrap();
        fs::write(repo.join(".env.sample"), "RPC_URL=\n").unwrap();
        fs::write(repo.join("wallet.key"), "secret\n").unwrap();
        fs::write(repo.join("cert.pem"), "secret\n").unwrap();
        fs::write(repo.join(".ssh/id_rsa"), "secret\n").unwrap();
        fs::write(repo.join("secrets/token"), "secret\n").unwrap();
        let workspace_path = temp.path().join("runs/run/workspaces/project-discovery");
        let artifact_dir = temp.path().join("runs/run/artifacts/project-discovery");
        let manager = FilesystemWorkspaceManager::new();

        let workspace = manager
            .create(WorkspaceRequest::attempt(
                RunId::from("run"),
                NodeId::from("project-discovery"),
                &repo,
                &workspace_path,
                &artifact_dir,
                WorkspaceMode::TempdirCopy,
                false,
            ))
            .unwrap();

        assert!(workspace.path.join("src/Contract.sol").exists());
        assert!(!workspace.path.join(".env").exists());
        assert!(!workspace.path.join(".env.sample").exists());
        assert!(!workspace.path.join("wallet.key").exists());
        assert!(!workspace.path.join("cert.pem").exists());
        assert!(!workspace.path.join(".ssh").exists());
        assert!(!workspace.path.join("secrets").exists());
        manager.cleanup(workspace).unwrap();
    }

    #[test]
    fn tempdir_copy_is_own_git_root_when_nested_under_target_repo() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join("src")).unwrap();
        run_git_for_test(&repo, ["init"]);
        fs::write(repo.join("src/Contract.sol"), "contract C {}\n").unwrap();
        run_git_for_test(&repo, ["add", "src/Contract.sol"]);
        run_git_for_test(
            &repo,
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

        let workspace_path = repo.join(".ultrafuzz/runs/run/workspaces/base-test-setup");
        let artifact_dir = repo.join(".ultrafuzz/runs/run/artifacts/base-test-setup");
        let manager = FilesystemWorkspaceManager::new();

        let workspace = manager
            .create(WorkspaceRequest::attempt(
                RunId::from("run"),
                NodeId::from("base-test-setup"),
                &repo,
                &workspace_path,
                &artifact_dir,
                WorkspaceMode::TempdirCopy,
                false,
            ))
            .unwrap();

        let top_level = git_output_for_test(&workspace.path, ["rev-parse", "--show-toplevel"]);
        assert_eq!(PathBuf::from(top_level.trim()), workspace.path);
        assert!(git_output_for_test(&workspace.path, ["status", "--short"]).is_empty());

        fs::write(
            workspace.path.join("src/Contract.sol"),
            "contract C { function changed() external {} }\n",
        )
        .unwrap();
        fs::create_dir_all(workspace.path.join("tests")).unwrap();
        fs::write(
            workspace.path.join("tests/New.t.sol"),
            "contract NewTest {}\n",
        )
        .unwrap();

        let status = git_output_for_test(
            &workspace.path,
            ["status", "--short", "--untracked-files=all"],
        );
        assert!(status.contains(" M src/Contract.sol"));
        assert!(status.contains("?? tests/New.t.sol"));
        assert!(!status.contains(".ultrafuzz/"));

        manager.cleanup(workspace).unwrap();
    }

    #[test]
    fn git_worktree_mode_creates_deterministic_branch_workspace() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        run_git_for_test(&repo, ["init"]);
        fs::write(repo.join("README.md"), "repo\n").unwrap();
        run_git_for_test(&repo, ["add", "README.md"]);
        run_git_for_test(
            &repo,
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
        let workspace_path = temp.path().join("runs/run/workspaces/encode-decode-0");
        let artifact_dir = temp.path().join("runs/run/artifacts/encode-decode-0");
        let manager = FilesystemWorkspaceManager::new();

        let workspace = manager
            .create(WorkspaceRequest::attempt(
                RunId::from("run"),
                NodeId::from("encode-decode-0"),
                &repo,
                &workspace_path,
                &artifact_dir,
                WorkspaceMode::GitWorktree,
                false,
            ))
            .unwrap();

        assert_eq!(
            workspace.branch_name.as_deref(),
            Some("ultrafuzz/run/encode-decode-0")
        );
        assert!(workspace.path.join("README.md").exists());
        manager.cleanup(workspace).unwrap();
        assert!(!workspace_path.exists());
    }

    #[test]
    fn failed_git_worktree_setup_cleanup_removes_worktree_and_branch() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        run_git_for_test(&repo, ["init"]);
        fs::write(repo.join("README.md"), "repo\n").unwrap();
        run_git_for_test(&repo, ["add", "README.md"]);
        run_git_for_test(
            &repo,
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

        let workspace_path = temp.path().join("runs/run/workspaces/encode-decode-0");
        let branch_name = "ultrafuzz/run/encode-decode-0";
        run_git_for_test(
            &repo,
            [
                "worktree",
                "add",
                "-B",
                branch_name,
                workspace_path.to_str().unwrap(),
                "HEAD",
            ],
        );
        assert!(workspace_path.exists());
        assert!(git_output_for_test(&repo, ["worktree", "list"]).contains("encode-decode-0"));
        assert!(
            git_output_for_test(&repo, ["branch", "--list", branch_name]).contains(branch_name)
        );

        cleanup_failed_git_worktree(&repo, &workspace_path, Some(branch_name));

        assert!(!workspace_path.exists());
        assert!(!git_output_for_test(&repo, ["worktree", "list"]).contains("encode-decode-0"));
        assert!(git_output_for_test(&repo, ["branch", "--list", branch_name]).is_empty());
    }

    #[test]
    fn git_worktree_mode_initializes_available_submodules() {
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

        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        run_git_for_test(&repo, ["init"]);
        fs::write(repo.join("README.md"), "repo\n").unwrap();
        run_git_for_test(&repo, ["add", "README.md"]);
        run_git_for_test(
            &repo,
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
            .arg(&repo)
            .arg("-c")
            .arg("protocol.file.allow=always")
            .arg("submodule")
            .arg("add")
            .arg(&dependency)
            .arg("lib/dependency")
            .output()
            .unwrap();
        assert_git_success(add_output);
        run_git_for_test(&repo, ["add", ".gitmodules", "lib/dependency"]);
        run_git_for_test(
            &repo,
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

        let workspace_path = temp.path().join("runs/run/workspaces/encode-decode-0");
        let artifact_dir = temp.path().join("runs/run/artifacts/encode-decode-0");
        let manager = FilesystemWorkspaceManager::new();

        let workspace = manager
            .create(WorkspaceRequest::attempt(
                RunId::from("run"),
                NodeId::from("encode-decode-0"),
                &repo,
                &workspace_path,
                &artifact_dir,
                WorkspaceMode::GitWorktree,
                false,
            ))
            .unwrap();

        assert!(workspace.path.join("lib/dependency/dep.txt").is_file());
        assert!(
            git_output_for_test(&workspace.path, ["submodule", "status"])
                .contains("lib/dependency")
        );
        let submodule_root = git_output_for_test(
            &workspace.path.join("lib/dependency"),
            ["rev-parse", "--show-toplevel"],
        );
        assert_eq!(
            PathBuf::from(submodule_root.trim()),
            workspace.path.join("lib/dependency")
        );

        manager.cleanup(workspace).unwrap();
        assert!(!workspace_path.exists());
    }

    #[test]
    fn persistent_debug_workspaces_are_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join("README.md"), "repo\n").unwrap();
        let workspace_path = temp.path().join("debug/encode-decode-0");
        let artifact_dir = temp.path().join("artifacts/encode-decode-0");
        let manager = FilesystemWorkspaceManager::new();

        let workspace = manager
            .create(WorkspaceRequest::attempt(
                RunId::from("run"),
                NodeId::from("encode-decode-0"),
                &repo,
                &workspace_path,
                &artifact_dir,
                WorkspaceMode::PersistentDebug,
                false,
            ))
            .unwrap();
        manager.cleanup(workspace).unwrap();

        assert!(workspace_path.exists());
    }

    #[test]
    fn in_place_mode_is_read_only_and_uses_target_repo() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let workspace_path = temp.path().join("ignored");
        let artifact_dir = temp.path().join("artifacts/project-discovery");
        let manager = FilesystemWorkspaceManager::new();

        let workspace = manager
            .create(WorkspaceRequest::attempt(
                RunId::from("run"),
                NodeId::from("project-discovery"),
                &repo,
                workspace_path,
                &artifact_dir,
                WorkspaceMode::InPlaceReadonly,
                false,
            ))
            .unwrap();

        assert_eq!(workspace.path, repo.canonicalize().unwrap());
        assert!(!workspace.writable);
        manager.cleanup(workspace).unwrap();
        assert!(repo.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", repo.join("passwd-link")).unwrap();
        let workspace_path = temp.path().join("workspace");
        let artifact_dir = temp.path().join("artifacts/node");
        let manager = FilesystemWorkspaceManager::new();

        let error = manager
            .create(WorkspaceRequest::attempt(
                RunId::from("run"),
                NodeId::from("node"),
                &repo,
                workspace_path,
                artifact_dir,
                WorkspaceMode::TempdirCopy,
                false,
            ))
            .unwrap_err();

        assert!(error.to_string().contains("symlink"));
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

    fn git_output_for_test<const N: usize>(repo: &Path, args: [&str; N]) -> String {
        let output = Command::new("git")
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
        String::from_utf8(output.stdout).unwrap()
    }

    fn assert_git_success(output: std::process::Output) {
        assert!(
            output.status.success(),
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
