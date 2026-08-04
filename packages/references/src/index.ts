import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoSymlinkComponents,
  assertPathInside,
  prepareSafeFilePath,
  readJsonFile,
  safeResolveInside,
  sha256File,
  writeFileDurable,
  writeJsonDurable
} from "@ultrafuzz/artifacts";
import { parse, stringify } from "yaml";

import {
  VULNERABILITY_DATABASE_CATALOG_ARTIFACT_PATH,
  VULNERABILITY_DATABASE_MATERIALIZED_DIRECTORY,
  VULNERABILITY_DATABASE_REFERENCE_KIND,
  VULNERABILITY_DATABASE_REQUIRED_PATHS,
  parseVulnerabilityDatabaseCatalog,
  parseVulnerabilityDatabaseGitTree,
  validateVulnerabilityDatabaseDirectory,
  validateVulnerabilityDatabaseGitTree,
  vulnerabilityDatabaseReferencePaths,
  type VulnerabilityDatabaseGitTreeEntry
} from "./vulnerability-database.js";

export * from "./vulnerability-database.js";

export const PROJECT_REFERENCES_FILE = ".ultrafuzz/references.yml";
export const REFERENCES_VERSION = 1;
export const CACHE_MANIFEST_FILE = ".ultrafuzz-reference-manifest.json";
export const RUN_REFERENCE_MANIFEST_FILE = "references/manifest.json";
export const REFERENCE_CACHE_SCHEMA_VERSION = "1.0";
export const RUN_REFERENCE_MANIFEST_SCHEMA_VERSION = "1.0";

export type ReferenceProvider = "github";
export type ReferenceKind = "document" | typeof VULNERABILITY_DATABASE_REFERENCE_KIND;

export interface ReferenceCatalog {
  version: number;
  references: Record<string, ReferenceEntry>;
}

export interface ReferenceEntry {
  kind?: ReferenceKind;
  provider: ReferenceProvider;
  repo: string;
  commit: string;
  paths: string[];
  resolved_at: string;
}

export interface ReferenceScaffoldReport {
  written?: string;
  skipped?: string;
}

export interface ReferenceStatusReport {
  catalogPath: string;
  cacheRoot: string;
  references: ReferenceStatus[];
  ok: boolean;
}

export interface ReferenceStatus {
  id: string;
  repo: string;
  commit: string;
  cacheDir: string;
  ok: boolean;
  messages: string[];
}

export interface SyncReport {
  cacheRoot: string;
  synced: SyncedReference[];
}

export interface SyncedReference {
  id: string;
  repo: string;
  commit: string;
  cacheDir: string;
  fetched: boolean;
}

export interface UpdateReport {
  catalogPath: string;
  updated: UpdatedReference[];
}

export interface UpdatedReference {
  id: string;
  repo: string;
  oldCommit: string;
  newCommit: string;
}

export interface MaterializedReference {
  referenceArtifact: string;
  manifestArtifact: string;
}

export interface ReferenceManifestFile {
  path: string;
  size_bytes: number;
  sha256: string;
}

export interface ReferenceCacheManifest {
  schema_version: string;
  provider: ReferenceProvider;
  repo: string;
  commit: string;
  fetched_at: string;
  files: ReferenceManifestFile[];
}

export interface RunReferenceManifest {
  schema_version: string;
  reference: string;
  provider: ReferenceProvider;
  repo: string;
  commit: string;
  resolved_at: string;
  kind?: ReferenceKind;
  source_files: ReferenceManifestFile[];
  artifacts: ReferenceManifestFile[];
}

export interface ReferenceCacheOptions {
  cacheRoot?: string;
}

export class ReferenceError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ReferenceError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function referencesPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_REFERENCES_FILE);
}

export function defaultReferenceCatalogYaml(): string {
  for (const candidate of defaultReferenceCatalogCandidates()) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }
  throw referenceError("MISSING_DEFAULT_CATALOG", "unable to locate bundled default references catalog");
}

export function writeDefaultReferenceCatalog(projectRoot: string, force = false): ReferenceScaffoldReport {
  const root = path.resolve(projectRoot);
  fs.mkdirSync(root, { recursive: true });
  const filePath = referencesPath(root);
  assertNoSymlinkComponents(root, filePath, "references catalog");
  if (fs.existsSync(filePath) && !force) {
    return { skipped: filePath };
  }
  const catalog = parseReferenceCatalog(defaultReferenceCatalogYaml());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertNoSymlinkComponents(root, filePath, "references catalog");
  writeFileDurable(filePath, serializeReferenceCatalog(catalog));
  return { written: filePath };
}

export function loadReferenceCatalog(projectRoot: string): ReferenceCatalog {
  const root = path.resolve(projectRoot);
  const filePath = referencesPath(root);
  if (!fs.existsSync(filePath)) {
    throw referenceError("MISSING_CATALOG", `missing references file: ${filePath}`, { path: filePath });
  }
  assertNoSymlinkComponents(root, filePath, "references catalog");
  return parseReferenceCatalog(fs.readFileSync(filePath, "utf8"));
}

export function parseReferenceCatalog(contents: string): ReferenceCatalog {
  let parsed: unknown;
  try {
    parsed = parse(contents);
  } catch (error) {
    throw referenceError("CATALOG_PARSE_FAILED", `failed to parse references YAML: ${messageFor(error)}`);
  }
  const catalog = normalizeReferenceCatalog(parsed);
  validateReferenceCatalog(catalog);
  return catalog;
}

export function serializeReferenceCatalog(catalog: ReferenceCatalog): string {
  validateReferenceCatalog(catalog);
  return stringify(catalog);
}

export function validateReferenceCatalog(catalog: ReferenceCatalog): void {
  if (catalog.version !== REFERENCES_VERSION) {
    throw referenceError("UNSUPPORTED_VERSION", `unsupported references version: ${catalog.version}`, {
      version: catalog.version
    });
  }
  const entries = Object.entries(catalog.references);
  if (entries.length === 0) {
    throw referenceError("EMPTY_CATALOG", "references catalog must contain at least one reference");
  }
  for (const [id, reference] of entries) {
    validateReferenceId(id);
    validateReference(id, reference);
  }
}

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdgCache = env.XDG_CACHE_HOME;
  const home = env.HOME ?? os.homedir();
  return path.join(xdgCache && xdgCache.length > 0 ? xdgCache : path.join(home, ".cache"), "ultrafuzz", "references");
}

export function cacheDirFor(reference: ReferenceEntry, root = cacheRoot()): string {
  return cacheDirForRoot(reference, root);
}

export function statusProjectReferences(
  projectRoot: string,
  options: ReferenceCacheOptions = {}
): ReferenceStatusReport {
  const catalog = loadReferenceCatalog(projectRoot);
  return statusReferenceCatalog(projectRoot, catalog, options);
}

export function statusReferenceCatalog(
  projectRoot: string,
  catalog: ReferenceCatalog,
  options: ReferenceCacheOptions = {}
): ReferenceStatusReport {
  validateReferenceCatalog(catalog);
  const root = path.resolve(options.cacheRoot ?? cacheRoot());
  const references = Object.entries(catalog.references)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, reference]) => {
      const cacheDir = cacheDirForRoot(reference, root);
      const messages: string[] = [];
      let ok = false;
      try {
        cachedReferenceOk(id, reference, cacheDir);
        messages.push("cache ok");
        ok = true;
      } catch (error) {
        messages.push(messageFor(error));
      }
      return {
        id,
        repo: reference.repo,
        commit: reference.commit,
        cacheDir,
        ok,
        messages
      };
    });
  return {
    catalogPath: referencesPath(path.resolve(projectRoot)),
    cacheRoot: root,
    references,
    ok: references.every((reference) => reference.ok)
  };
}

export function verifyReferencesCached(
  catalog: ReferenceCatalog,
  references: Iterable<string>,
  options: ReferenceCacheOptions = {}
): void {
  validateReferenceCatalog(catalog);
  const root = path.resolve(options.cacheRoot ?? cacheRoot());
  for (const id of references) {
    const reference = catalog.references[id];
    if (!reference) {
      throw referenceError("UNKNOWN_REFERENCE", `unknown reference \`${id}\``, { id });
    }
    cachedReferenceOk(id, reference, cacheDirForRoot(reference, root));
  }
}

export function syncProjectReferences(projectRoot: string, options: ReferenceCacheOptions = {}): SyncReport {
  return syncReferenceCatalog(loadReferenceCatalog(projectRoot), options);
}

export function syncReferenceCatalog(catalog: ReferenceCatalog, options: ReferenceCacheOptions = {}): SyncReport {
  validateReferenceCatalog(catalog);
  const root = path.resolve(options.cacheRoot ?? cacheRoot());
  const synced: SyncedReference[] = [];
  for (const group of referenceCacheGroups(catalog)) {
    const cacheDir = cacheDirForRoot(group.reference, root);
    const fetched = group.ids.every((id) => {
      const reference = catalog.references[id];
      if (!reference) {
        return false;
      }
      try {
        cachedReferenceOk(id, reference, cacheDir);
        return true;
      } catch {
        return false;
      }
    })
      ? false
      : fetchReference(group.ids[0]!, group.reference, cacheDir);
    for (const id of group.ids) {
      const reference = catalog.references[id]!;
      synced.push({
        id,
        repo: reference.repo,
        commit: reference.commit,
        cacheDir,
        fetched
      });
    }
  }
  return { cacheRoot: root, synced };
}

export function updateProjectReferencesLatest(projectRoot: string): UpdateReport {
  const root = path.resolve(projectRoot);
  const catalogPath = referencesPath(root);
  const catalog = loadReferenceCatalog(root);
  const resolvedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  const updated: UpdatedReference[] = [];
  for (const [id, reference] of Object.entries(catalog.references).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const oldCommit = reference.commit;
    const newCommit = resolveGithubDefaultBranchSha(reference.repo);
    reference.commit = newCommit;
    reference.resolved_at = resolvedAt;
    updated.push({ id, repo: reference.repo, oldCommit, newCommit });
  }
  validateReferenceCatalog(catalog);
  assertNoSymlinkComponents(root, catalogPath, "references catalog");
  writeFileDurable(catalogPath, serializeReferenceCatalog(catalog));
  return { catalogPath, updated };
}

export function materializeReferenceArtifacts(input: {
  catalog: ReferenceCatalog;
  id: string;
  artifactDir: string;
  outputs: Array<{ path: string; primary: boolean }>;
  cacheRoot?: string;
}): MaterializedReference {
  validateReferenceCatalog(input.catalog);
  const reference = input.catalog.references[input.id];
  if (!reference) {
    throw referenceError("UNKNOWN_REFERENCE", `unknown reference \`${input.id}\``, { id: input.id });
  }
  const primaryArtifact = input.outputs.find((output) => output.primary)?.path;
  if (!primaryArtifact) {
    throw referenceError(
      "MISSING_PRIMARY_ARTIFACT",
      `reference \`${input.id}\` cannot materialize without a primary artifact`,
      {
        id: input.id
      }
    );
  }
  const cacheDir = cacheDirForRoot(reference, path.resolve(input.cacheRoot ?? cacheRoot()));
  cachedReferenceOk(input.id, reference, cacheDir);
  const cacheManifest = readCacheManifest(input.id, cacheDir);

  const artifactDir = path.resolve(input.artifactDir);
  const referenceArtifact = prepareSafeFilePath(artifactDir, primaryArtifact);
  const artifactFiles: ReferenceManifestFile[] = [];
  if (referenceKind(reference) === VULNERABILITY_DATABASE_REFERENCE_KIND) {
    if (primaryArtifact !== VULNERABILITY_DATABASE_CATALOG_ARTIFACT_PATH) {
      throw referenceError(
        "INVALID_VULNERABILITY_DATABASE_OUTPUT",
        `vulnerability database reference \`${input.id}\` primary output must be ${VULNERABILITY_DATABASE_CATALOG_ARTIFACT_PATH}`
      );
    }
    const database = validateVulnerabilityDatabaseDirectory(cacheDir);
    for (const sourcePath of vulnerabilityDatabaseReferencePaths(database.catalog)) {
      const source = safeResolveInside(cacheDir, sourcePath, "cached vulnerability database path");
      const artifactPath = path.posix.join(VULNERABILITY_DATABASE_MATERIALIZED_DIRECTORY, sourcePath);
      const destination = prepareSafeFilePath(artifactDir, artifactPath);
      writeFileDurable(destination, fs.readFileSync(source));
      artifactFiles.push(manifestFileForPath(artifactDir, artifactPath));
    }
    validateVulnerabilityDatabaseDirectory(path.join(artifactDir, VULNERABILITY_DATABASE_MATERIALIZED_DIRECTORY), {
      provider: reference.provider,
      repo: reference.repo,
      commit: reference.commit,
      resolved_at: reference.resolved_at
    });
  } else {
    writeFileDurable(referenceArtifact, normalizedReferenceMarkdown(input.id, reference, cacheDir));
    artifactFiles.push(manifestFileForPath(artifactDir, primaryArtifact));
  }

  const manifestArtifact = prepareSafeFilePath(artifactDir, RUN_REFERENCE_MANIFEST_FILE);
  const sourcePaths = effectiveCachedReferencePaths(reference, cacheDir);
  const runManifest: RunReferenceManifest = {
    schema_version: RUN_REFERENCE_MANIFEST_SCHEMA_VERSION,
    reference: input.id,
    provider: reference.provider,
    repo: reference.repo,
    commit: reference.commit,
    resolved_at: reference.resolved_at,
    ...(reference.kind === undefined ? {} : { kind: reference.kind }),
    source_files: cacheManifest.files.filter((file) => sourcePaths.includes(file.path)),
    artifacts: artifactFiles
  };
  writeJsonDurable(manifestArtifact, runManifest);

  for (const required of input.outputs.map((output) => output.path)) {
    const requiredPath = safeResolveInside(artifactDir, required, "required reference artifact");
    if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
      throw referenceError(
        "MISSING_REQUIRED_ARTIFACT",
        `reference \`${input.id}\` expected required artifact \`${required}\` to be generated`,
        { id: input.id, path: required }
      );
    }
  }

  return { referenceArtifact, manifestArtifact };
}

export function readCacheManifest(id: string, cacheDir: string): ReferenceCacheManifest {
  const manifestPath = path.join(cacheDir, CACHE_MANIFEST_FILE);
  let manifest: unknown;
  try {
    manifest = readJsonFile(manifestPath);
  } catch (error) {
    throw referenceError(
      "INVALID_CACHE_MANIFEST",
      `cached reference \`${id}\` has invalid manifest at ${manifestPath}: ${messageFor(error)}`,
      { id, path: manifestPath }
    );
  }
  return normalizeCacheManifest(id, manifest, manifestPath);
}

function normalizeReferenceCatalog(value: unknown): ReferenceCatalog {
  if (!isRecord(value)) {
    throw referenceError("INVALID_CATALOG", "references catalog must be an object");
  }
  if (!Number.isInteger(value.version)) {
    throw referenceError("INVALID_CATALOG", "references catalog version must be an integer");
  }
  if (!isRecord(value.references)) {
    throw referenceError("INVALID_CATALOG", "references catalog must define references");
  }
  const references: Record<string, ReferenceEntry> = {};
  for (const [id, entry] of Object.entries(value.references)) {
    references[id] = normalizeReferenceEntry(id, entry);
  }
  return { version: value.version as number, references };
}

function normalizeReferenceEntry(id: string, value: unknown): ReferenceEntry {
  if (!isRecord(value)) {
    throw referenceError("INVALID_REFERENCE", `reference \`${id}\` must be an object`, { id });
  }
  if (value.provider !== "github") {
    throw referenceError("UNSUPPORTED_PROVIDER", `reference \`${id}\` must use provider \`github\``, { id });
  }
  if (value.kind !== undefined && value.kind !== "document" && value.kind !== VULNERABILITY_DATABASE_REFERENCE_KIND) {
    throw referenceError("INVALID_REFERENCE_KIND", `reference \`${id}\` has invalid kind \`${String(value.kind)}\``, {
      id
    });
  }
  if (typeof value.repo !== "string" || typeof value.commit !== "string" || typeof value.resolved_at !== "string") {
    throw referenceError("INVALID_REFERENCE", `reference \`${id}\` must define repo, commit, and resolved_at`, { id });
  }
  if (!Array.isArray(value.paths) || value.paths.some((item) => typeof item !== "string")) {
    throw referenceError("INVALID_REFERENCE", `reference \`${id}\` paths must be a string array`, { id });
  }
  return {
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    provider: "github",
    repo: value.repo,
    commit: value.commit,
    paths: [...value.paths],
    resolved_at: value.resolved_at
  };
}

function validateReference(id: string, reference: ReferenceEntry): void {
  githubRepoParts(reference, id);
  if (!isFullSha(reference.commit)) {
    throw referenceError(
      "INVALID_COMMIT",
      `reference \`${id}\` has invalid commit \`${reference.commit}\`; expected full 40-character SHA`,
      { id, commit: reference.commit }
    );
  }
  if (reference.paths.length === 0) {
    throw referenceError("MISSING_PATHS", `reference \`${id}\` has no paths`, { id });
  }
  const seen = new Set<string>();
  for (const referencePath of reference.paths) {
    validateReferencePath(id, referencePath);
    if (seen.has(referencePath)) {
      throw referenceError("DUPLICATE_PATH", `reference \`${id}\` repeats path \`${referencePath}\``, {
        id,
        path: referencePath
      });
    }
    seen.add(referencePath);
  }
  if (referenceKind(reference) === VULNERABILITY_DATABASE_REFERENCE_KIND) {
    const required = [...VULNERABILITY_DATABASE_REQUIRED_PATHS].sort();
    const actual = [...reference.paths].sort();
    if (JSON.stringify(actual) !== JSON.stringify(required)) {
      throw referenceError(
        "INVALID_VULNERABILITY_DATABASE_PATHS",
        `reference \`${id}\` must list exactly ${required.join(", ")}; record paths are discovered from catalog.json`,
        { id }
      );
    }
  }
}

function validateReferenceId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    throw referenceError("INVALID_REFERENCE_ID", `invalid reference id \`${id}\``, { id });
  }
}

function githubRepoParts(reference: ReferenceEntry, id: string): { owner: string; repo: string } {
  const parts = reference.repo.split("/");
  const [owner, repoName] = parts;
  if (
    parts.length !== 2 ||
    owner === undefined ||
    repoName === undefined ||
    owner.length === 0 ||
    repoName.length === 0 ||
    !isGithubRepoPart(owner) ||
    !isGithubRepoPart(repoName)
  ) {
    throw referenceError("INVALID_REPO", `reference \`${id}\` has invalid GitHub repo \`${reference.repo}\``, {
      id,
      repo: reference.repo
    });
  }
  return { owner, repo: repoName };
}

function isGithubRepoPart(value: string): boolean {
  return value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/u.test(value);
}

function isFullSha(value: string): boolean {
  return /^[0-9a-fA-F]{40}$/u.test(value);
}

function validateReferencePath(id: string, referencePath: string): void {
  if (
    referencePath.length === 0 ||
    referencePath.includes("\\") ||
    path.posix.isAbsolute(referencePath) ||
    path.win32.isAbsolute(referencePath) ||
    referencePath.includes("//") ||
    referencePath.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    !/^[A-Za-z0-9._/@+-]+$/u.test(referencePath)
  ) {
    throw referenceError(
      "INVALID_REFERENCE_PATH",
      `reference \`${id}\` has invalid path \`${referencePath}\`; paths must be relative and traversal-free`,
      { id, path: referencePath }
    );
  }
}

function cacheDirForRoot(reference: ReferenceEntry, root: string): string {
  const { owner, repo } = githubRepoParts(reference, "cache-path");
  const githubRoot = path.resolve(root, "github");
  const commitDir = path.resolve(githubRoot, owner, repo, reference.commit);
  const cacheDir =
    referenceKind(reference) === "document"
      ? commitDir
      : path.resolve(githubRoot, owner, repo, VULNERABILITY_DATABASE_REFERENCE_KIND, reference.commit);
  assertPathInside(githubRoot, cacheDir, "reference cache path");
  return cacheDir;
}

function cachedReferenceOk(id: string, reference: ReferenceEntry, cacheDir: string): void {
  if (!fs.existsSync(cacheDir) || !fs.statSync(cacheDir).isDirectory()) {
    throw referenceError(
      "MISSING_CACHE",
      `cached reference \`${id}\` is missing at ${cacheDir}; run \`ultrafuzz references sync\` before running offline`,
      { id, cacheDir }
    );
  }
  const manifest = readCacheManifest(id, cacheDir);
  if (
    manifest.provider !== reference.provider ||
    manifest.repo !== reference.repo ||
    manifest.commit !== reference.commit
  ) {
    throw referenceError(
      "INVALID_CACHE_MANIFEST",
      `cached reference \`${id}\` has invalid manifest at ${path.join(
        cacheDir,
        CACHE_MANIFEST_FILE
      )}: provider, repo, or commit does not match catalog`,
      { id, cacheDir }
    );
  }
  const manifestFiles = new Map(manifest.files.map((file) => [file.path, file]));
  for (const referencePath of effectiveCachedReferencePaths(reference, cacheDir)) {
    const cachePath = safeResolveInside(cacheDir, referencePath, "cached reference path");
    if (!fs.existsSync(cachePath) || !fs.statSync(cachePath).isFile()) {
      throw referenceError(
        "MISSING_CACHED_PATH",
        `cached reference \`${id}\` is missing source path \`${referencePath}\` at ${cachePath}; run \`ultrafuzz references sync\``,
        { id, path: referencePath, cachePath }
      );
    }
    const manifestFile = manifestFiles.get(referencePath);
    if (!manifestFile) {
      throw referenceError(
        "INVALID_CACHE_MANIFEST",
        `cached reference \`${id}\` has invalid manifest at ${path.join(
          cacheDir,
          CACHE_MANIFEST_FILE
        )}: missing manifest entry for \`${referencePath}\``,
        { id, path: referencePath }
      );
    }
    const current = manifestFileForPath(cacheDir, referencePath);
    if (
      current.path !== manifestFile.path ||
      current.size_bytes !== manifestFile.size_bytes ||
      current.sha256 !== manifestFile.sha256
    ) {
      throw referenceError("DIGEST_MISMATCH", `cached reference \`${id}\` digest mismatch for \`${referencePath}\``, {
        id,
        path: referencePath
      });
    }
  }
  if (referenceKind(reference) === VULNERABILITY_DATABASE_REFERENCE_KIND) {
    validateVulnerabilityDatabaseDirectory(cacheDir);
  }
}

interface ReferenceCacheGroup {
  ids: string[];
  reference: ReferenceEntry;
}

function referenceCacheGroups(catalog: ReferenceCatalog): ReferenceCacheGroup[] {
  const groups = new Map<string, ReferenceCacheGroup>();
  for (const [id, reference] of Object.entries(catalog.references).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const key = `${reference.provider}\0${reference.repo}\0${reference.commit}\0${referenceKind(reference)}`;
    const group =
      groups.get(key) ??
      ({
        ids: [],
        reference: {
          ...(reference.kind === undefined ? {} : { kind: reference.kind }),
          provider: reference.provider,
          repo: reference.repo,
          commit: reference.commit,
          paths: [],
          resolved_at: reference.resolved_at
        }
      } satisfies ReferenceCacheGroup);
    group.ids.push(id);
    for (const referencePath of reference.paths) {
      if (!group.reference.paths.includes(referencePath)) {
        group.reference.paths.push(referencePath);
      }
    }
    group.reference.paths.sort();
    groups.set(key, group);
  }
  return [...groups.values()];
}

function fetchReference(id: string, reference: ReferenceEntry, cacheDir: string): boolean {
  const { owner, repo } = githubRepoParts(reference, id);
  const remote = `https://github.com/${owner}/${repo}.git`;
  const cacheParent = path.dirname(cacheDir);
  fs.mkdirSync(cacheParent, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(cacheParent, ".sync-"));
  try {
    runGit(tempRoot, ["init"]);
    runGit(tempRoot, ["remote", "add", "origin", remote]);
    runGit(tempRoot, ["fetch", "--depth=1", "--filter=blob:none", "origin", reference.commit]);

    const staging = path.join(tempRoot, "cache");
    fs.mkdirSync(staging, { recursive: true });
    const files: ReferenceManifestFile[] = [];
    const sourcePaths = referencePathsAtCommit(id, reference, tempRoot);
    for (const referencePath of sourcePaths) {
      const data = gitBlob(id, tempRoot, reference.commit, referencePath);
      const destination = safeResolveInside(staging, referencePath, "reference cache path");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, data);
      files.push(manifestFileForPath(staging, referencePath));
    }
    if (referenceKind(reference) === VULNERABILITY_DATABASE_REFERENCE_KIND) {
      validateVulnerabilityDatabaseDirectory(staging);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    writeJsonDurable(path.join(staging, CACHE_MANIFEST_FILE), {
      schema_version: REFERENCE_CACHE_SCHEMA_VERSION,
      provider: reference.provider,
      repo: reference.repo,
      commit: reference.commit,
      fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
      files
    } satisfies ReferenceCacheManifest);
    replaceCacheDir(staging, cacheDir, tempRoot);
    return true;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function replaceCacheDir(staging: string, cacheDir: string, tempRoot: string): void {
  const backup = path.join(tempRoot, "previous-cache");
  if (fs.existsSync(cacheDir)) {
    fs.renameSync(cacheDir, backup);
  }
  try {
    fs.renameSync(staging, cacheDir);
  } catch (error) {
    if (fs.existsSync(backup) && !fs.existsSync(cacheDir)) {
      fs.renameSync(backup, cacheDir);
    }
    throw error;
  }
}

function resolveGithubDefaultBranchSha(repo: string): string {
  const reference: ReferenceEntry = {
    provider: "github",
    repo,
    commit: "0000000000000000000000000000000000000000",
    paths: ["README.md"],
    resolved_at: ""
  };
  const { owner, repo: repoName } = githubRepoParts(reference, "update-latest");
  const remote = `https://github.com/${owner}/${repoName}.git`;
  let stdout: string;
  try {
    stdout = execFileSync("git", ["ls-remote", "--symref", remote, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    throw referenceError(
      "GIT_FAILED",
      `git command failed: git ls-remote --symref ${remote} HEAD: ${stderrFor(error)}`
    );
  }
  for (const line of stdout.split("\n")) {
    const [sha, name] = line.split("\t");
    if (name === "HEAD" && sha !== undefined && isFullSha(sha)) {
      return sha;
    }
  }
  throw referenceError("MISSING_HEAD_SHA", `git output for \`${repo}\` did not contain a full HEAD SHA`, { repo });
}

function runGit(cwd: string, args: string[]): void {
  try {
    execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    throw referenceError("GIT_FAILED", `git command failed: git ${args.join(" ")}: ${stderrFor(error)}`, {
      command: ["git", ...args]
    });
  }
}

function gitBlob(id: string, cwd: string, commit: string, referencePath: string): Buffer {
  const object = `${commit}:${referencePath}`;
  const objectType = gitOutput(cwd, ["cat-file", "-t", object]).trim();
  if (objectType !== "blob") {
    throw referenceError(
      "NON_BLOB_PATH",
      `reference \`${id}\` path \`${referencePath}\` at commit ${commit} resolved to \`${objectType}\`, expected a blob`,
      { id, path: referencePath, commit, objectType }
    );
  }
  try {
    return execFileSync("git", ["show", object], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw referenceError("GIT_FAILED", `git command failed: git show ${object}: ${stderrFor(error)}`, {
      command: ["git", "show", object]
    });
  }
}

function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw referenceError("GIT_FAILED", `git command failed: git ${args.join(" ")}: ${stderrFor(error)}`, {
      command: ["git", ...args]
    });
  }
}

function referencePathsAtCommit(id: string, reference: ReferenceEntry, checkout: string): string[] {
  if (referenceKind(reference) !== VULNERABILITY_DATABASE_REFERENCE_KIND) return [...reference.paths];
  const catalog = parseVulnerabilityDatabaseCatalog(gitBlob(id, checkout, reference.commit, "catalog.json"));
  const entries = gitTreeEntries(checkout, reference.commit);
  validateVulnerabilityDatabaseGitTree(entries, catalog);
  return vulnerabilityDatabaseReferencePaths(catalog);
}

function effectiveCachedReferencePaths(reference: ReferenceEntry, cacheDir: string): string[] {
  if (referenceKind(reference) !== VULNERABILITY_DATABASE_REFERENCE_KIND) return [...reference.paths];
  const catalogPath = safeResolveInside(cacheDir, "catalog.json", "cached vulnerability database catalog");
  return vulnerabilityDatabaseReferencePaths(parseVulnerabilityDatabaseCatalog(fs.readFileSync(catalogPath)));
}

function gitTreeEntries(cwd: string, commit: string): VulnerabilityDatabaseGitTreeEntry[] {
  let output: Buffer;
  try {
    output = execFileSync("git", ["ls-tree", "-r", "-z", commit], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    throw referenceError("GIT_FAILED", `git command failed: git ls-tree -r -z ${commit}: ${stderrFor(error)}`, {
      command: ["git", "ls-tree", "-r", "-z", commit]
    });
  }
  return parseVulnerabilityDatabaseGitTree(output);
}

function referenceKind(reference: ReferenceEntry): ReferenceKind {
  return reference.kind ?? "document";
}

function normalizedReferenceMarkdown(id: string, reference: ReferenceEntry, cacheDir: string): string {
  const lines: string[] = [
    `# Pinned Reference: ${id}`,
    "",
    "- Provider: github",
    `- Repository: \`${reference.repo}\``,
    `- Commit: \`${reference.commit}\``,
    `- Resolved at: \`${reference.resolved_at}\``,
    ""
  ];
  for (const referencePath of reference.paths) {
    const cachePath = safeResolveInside(cacheDir, referencePath, "cached reference path");
    const text = fs.readFileSync(cachePath, "utf8").trimEnd();
    lines.push(`## \`${referencePath}\``, "");
    if (path.extname(referencePath) === ".md") {
      lines.push(text, "");
    } else {
      lines.push(`\`\`\`${fencedLanguage(referencePath) ?? ""}`, text, "```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function fencedLanguage(referencePath: string): string | undefined {
  switch (path.extname(referencePath)) {
    case ".sol":
      return "solidity";
    case ".spec":
      return "cvl";
    case ".conf":
      return "text";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".json":
      return "json";
    case ".sh":
      return "bash";
    default:
      return undefined;
  }
}

function manifestFileForPath(root: string, relativePath: string): ReferenceManifestFile {
  const absolutePath = safeResolveInside(root, relativePath, "reference manifest path");
  return {
    path: relativePath,
    size_bytes: fs.statSync(absolutePath).size,
    sha256: sha256File(absolutePath)
  };
}

function normalizeCacheManifest(id: string, value: unknown, manifestPath: string): ReferenceCacheManifest {
  if (!isRecord(value)) {
    throw referenceError("INVALID_CACHE_MANIFEST", `cached reference \`${id}\` manifest must be an object`, {
      id,
      path: manifestPath
    });
  }
  if (value.provider !== "github" || typeof value.repo !== "string" || typeof value.commit !== "string") {
    throw referenceError("INVALID_CACHE_MANIFEST", `cached reference \`${id}\` manifest has invalid identity`, {
      id,
      path: manifestPath
    });
  }
  if (typeof value.schema_version !== "string" || typeof value.fetched_at !== "string") {
    throw referenceError("INVALID_CACHE_MANIFEST", `cached reference \`${id}\` manifest has invalid metadata`, {
      id,
      path: manifestPath
    });
  }
  if (!Array.isArray(value.files)) {
    throw referenceError("INVALID_CACHE_MANIFEST", `cached reference \`${id}\` manifest files must be an array`, {
      id,
      path: manifestPath
    });
  }
  return {
    schema_version: value.schema_version,
    provider: "github",
    repo: value.repo,
    commit: value.commit,
    fetched_at: value.fetched_at,
    files: value.files.map((file, index) => normalizeManifestFile(id, file, `${manifestPath}:files[${index}]`))
  };
}

function normalizeManifestFile(id: string, value: unknown, location: string): ReferenceManifestFile {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.sha256 !== "string") {
    throw referenceError("INVALID_CACHE_MANIFEST", `cached reference \`${id}\` manifest file entry is invalid`, {
      id,
      location
    });
  }
  if (!Number.isInteger(value.size_bytes) || (value.size_bytes as number) < 0) {
    throw referenceError("INVALID_CACHE_MANIFEST", `cached reference \`${id}\` manifest file size is invalid`, {
      id,
      location
    });
  }
  validateReferencePath(id, value.path);
  if (!/^[0-9a-f]{64}$/u.test(value.sha256)) {
    throw referenceError("INVALID_CACHE_MANIFEST", `cached reference \`${id}\` manifest sha256 is invalid`, {
      id,
      location
    });
  }
  return {
    path: value.path,
    size_bytes: value.size_bytes as number,
    sha256: value.sha256
  };
}

function defaultReferenceCatalogCandidates(): string[] {
  return [
    fileURLToPath(new URL("./default-references.yml", import.meta.url)),
    fileURLToPath(new URL("../../../.ultrafuzz/references.yml", import.meta.url)),
    fileURLToPath(new URL("../../../../.ultrafuzz/references.yml", import.meta.url))
  ];
}

function referenceError(code: string, message: string, details?: Record<string, unknown>): ReferenceError {
  return new ReferenceError(code, message, details);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stderrFor(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr)) {
      return stderr.toString("utf8").trim();
    }
    if (typeof stderr === "string") {
      return stderr.trim();
    }
  }
  return messageFor(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
