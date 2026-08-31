import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isRecord, parseStrictJsonBytes, readRegularFileSnapshot, type RunLayout } from "@ultrafuzz/artifacts";

const CLOSURE_SCHEMA_VERSION = "ultrafuzz.trusted-cli-closure.v1" as const;
const CLOSURES_DIRECTORY = "trusted-cli-closures";
const MANIFEST_FILE = "manifest.json";
const MODULE_CONFINEMENT_FILE = "module-confinement.cjs";
const VALIDATOR_SCHEMA_FILE = "validator-preflight/findings.schema.json";
const VALIDATOR_FIXTURE_FILE = "validator-preflight/validator-smoke.valid.json";
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 50_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu;

interface PackageManifest {
  name: string;
  version: string;
  dependencies: Readonly<Record<string, string>>;
  optionalDependencies: Readonly<Record<string, string>>;
  peerDependencies: Readonly<Record<string, string>>;
  peerDependenciesMeta: Readonly<Record<string, Readonly<{ optional?: boolean }>>>;
}

interface SourcePackage {
  id: string;
  root: string;
  snapshotPath: string;
  manifest: PackageManifest;
  manifestBytes: Buffer;
  dependencies: Record<string, string>;
}

export interface TrustedCliClosureFile {
  path: string;
  sha256: string;
  executable: boolean;
}

export interface TrustedCliClosurePackage {
  id: string;
  name: string;
  version: string;
  snapshot_path: string;
  dependencies: Readonly<Record<string, string>>;
  files: readonly TrustedCliClosureFile[];
}

export interface TrustedCliClosureManifest {
  schema_version: typeof CLOSURE_SCHEMA_VERSION;
  cli_entrypoint: string;
  module_confinement: TrustedCliClosureFile;
  validator_preflight: {
    schema: TrustedCliClosureFile;
    fixture: TrustedCliClosureFile;
  };
  packages: readonly TrustedCliClosurePackage[];
}

export interface TrustedCliClosure {
  root: string;
  digest: string;
  cliEntrypoint: string;
  cliSha256: string;
  moduleConfinementPath: string;
  validatorSchemaPath: string;
  validatorFixturePath: string;
  manifest: TrustedCliClosureManifest;
}

/**
 * Publishes a complete Node package closure for the validator CLI. Workspace
 * packages already present in the authenticated workflow generation are
 * preferred over the mutable operator checkout, which keeps historical schema
 * and validator identities stable across controller-only refreshes.
 */
export function prepareTrustedCliClosure(input: {
  layout: RunLayout;
  cliEntrypoint: string;
  validatorSchemaPath: string;
  validatorFixturePath: string;
  executionSnapshotRoot?: string;
  validate: (closure: TrustedCliClosure) => void;
}): TrustedCliClosure {
  const sourceEntrypoint = verifiedSourceEntrypoint(input.cliEntrypoint);
  const cliRoot = packageRoot(sourceEntrypoint);
  const snapshotModules = snapshotModuleRoots(input.executionSnapshotRoot);
  const packages = collectPackageClosure(cliRoot, snapshotModules);
  const cliPackage = packages[0]!;
  const cliRelative = relativePackagePath(cliRoot, sourceEntrypoint);
  if (!cliRelative.startsWith("dist/")) {
    throw new Error("trusted Ultrafuzz CLI entrypoint must be in its package dist directory");
  }
  const cliSnapshotPath = path.posix.join(cliPackage.snapshotPath, cliRelative);
  const closuresRoot = safeClosuresRoot(input.layout);
  const temporaryName = `.tmp-${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
  const temporaryRoot = path.join(closuresRoot, temporaryName);
  fs.mkdirSync(temporaryRoot, { mode: 0o700 });
  let retainedTemporary = true;
  try {
    const closurePackages = packages.map((entry) => copySourcePackage(temporaryRoot, entry));
    createDependencyLinks(temporaryRoot, closurePackages);
    const moduleConfinementBytes = Buffer.from(trustedCliModuleConfinementSource(), "utf8");
    fs.writeFileSync(path.join(temporaryRoot, MODULE_CONFINEMENT_FILE), moduleConfinementBytes, {
      mode: 0o400,
      flag: "wx"
    });
    const validatorSchema = copyClosureIdentityFile(temporaryRoot, input.validatorSchemaPath, VALIDATOR_SCHEMA_FILE);
    const validatorFixture = copyClosureIdentityFile(temporaryRoot, input.validatorFixturePath, VALIDATOR_FIXTURE_FILE);
    const manifest: TrustedCliClosureManifest = {
      schema_version: CLOSURE_SCHEMA_VERSION,
      cli_entrypoint: cliSnapshotPath,
      module_confinement: {
        path: MODULE_CONFINEMENT_FILE,
        sha256: sha256(moduleConfinementBytes),
        executable: false
      },
      validator_preflight: {
        schema: validatorSchema,
        fixture: validatorFixture
      },
      packages: closurePackages
    };
    const manifestBytes = Buffer.from(`${stableJson(manifest)}\n`, "utf8");
    const digest = sha256(manifestBytes);
    fs.writeFileSync(path.join(temporaryRoot, MANIFEST_FILE), manifestBytes, { mode: 0o400, flag: "wx" });
    sealClosure(temporaryRoot, manifest);
    // `readTrustedCliClosureAt` performs the identical full verification, so a
    // separate pass here would only re-read and re-hash the whole closure.
    input.validate(readTrustedCliClosureAt(temporaryRoot, digest, { allowTemporaryName: true }));
    const publishedRoot = path.join(closuresRoot, digest);
    if (pathEntryExists(publishedRoot)) {
      verifyTrustedCliClosureRoot(publishedRoot, digest);
      removeOwnedTemporary(closuresRoot, temporaryName);
      retainedTemporary = false;
    } else {
      try {
        fs.renameSync(temporaryRoot, publishedRoot);
        retainedTemporary = false;
        fsyncDirectory(closuresRoot);
      } catch (error) {
        if (!pathEntryExists(publishedRoot)) throw error;
        verifyTrustedCliClosureRoot(publishedRoot, digest);
        removeOwnedTemporary(closuresRoot, temporaryName);
        retainedTemporary = false;
      }
    }
    const published = readTrustedCliClosure(publishedRoot);
    input.validate(published);
    return published;
  } finally {
    if (retainedTemporary && pathEntryExists(temporaryRoot)) removeOwnedTemporary(closuresRoot, temporaryName);
  }
}

export function readTrustedCliClosureForEntrypoint(input: {
  layout: RunLayout;
  cliEntrypoint: string;
}): TrustedCliClosure {
  const closuresRoot = safeClosuresRoot(input.layout);
  const resolvedEntrypoint = path.resolve(input.cliEntrypoint);
  const relative = path.relative(closuresRoot, resolvedEntrypoint).split(path.sep).join("/");
  const [digest] = relative.split("/");
  if (digest === undefined || !SHA256_PATTERN.test(digest) || relative === digest || relative.startsWith("../")) {
    throw new Error("trusted Ultrafuzz CLI entrypoint is outside its content-addressed closure");
  }
  const closure = readTrustedCliClosure(path.join(closuresRoot, digest));
  if (path.resolve(closure.cliEntrypoint) !== resolvedEntrypoint) {
    throw new Error("trusted Ultrafuzz CLI entrypoint differs from its closure manifest");
  }
  return closure;
}

export function trustedCliClosuresRoot(layout: RunLayout): string {
  return safeClosuresRoot(layout);
}

export function trustedCliChildEnvironment(
  source: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined> {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (["NODE_OPTIONS", "NODE_PATH"].includes(name.toUpperCase())) delete environment[name];
  }
  return environment;
}

function readTrustedCliClosure(root: string): TrustedCliClosure {
  const digest = path.basename(root);
  if (!SHA256_PATTERN.test(digest)) throw new Error("trusted CLI closure has an invalid content address");
  return readTrustedCliClosureAt(root, digest);
}

function readTrustedCliClosureAt(
  root: string,
  digest: string,
  options: { allowTemporaryName?: boolean } = {}
): TrustedCliClosure {
  const manifest = verifyTrustedCliClosureRoot(root, digest, options);
  const cliEntrypoint = path.join(root, ...manifest.cli_entrypoint.split("/"));
  const cli = manifest.packages.flatMap((entry) => entry.files).find((entry) => entry.path === manifest.cli_entrypoint);
  if (cli === undefined) throw new Error("trusted CLI closure manifest omits its CLI entrypoint");
  return {
    root,
    digest,
    cliEntrypoint,
    cliSha256: cli.sha256,
    moduleConfinementPath: path.join(root, MODULE_CONFINEMENT_FILE),
    validatorSchemaPath: path.join(root, ...manifest.validator_preflight.schema.path.split("/")),
    validatorFixturePath: path.join(root, ...manifest.validator_preflight.fixture.path.split("/")),
    manifest
  };
}

function safeClosuresRoot(layout: RunLayout): string {
  const root = path.join(layout.root, CLOSURES_DIRECTORY);
  if (!pathEntryExists(root)) fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("trusted CLI closures root is unsafe");
  const relative = path.relative(path.resolve(layout.root), path.resolve(root));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("trusted CLI closures root escapes the run");
  return root;
}

function snapshotModuleRoots(snapshotRoot: string | undefined): ReadonlyMap<string, string> {
  if (snapshotRoot === undefined) return new Map();
  const modulesRoot = path.join(path.resolve(snapshotRoot), "modules", "@ultrafuzz");
  if (!pathEntryExists(modulesRoot)) {
    throw new Error("trusted CLI identity snapshot is missing its Ultrafuzz modules");
  }
  const modulesStat = fs.lstatSync(modulesRoot);
  if (!modulesStat.isDirectory() || modulesStat.isSymbolicLink()) {
    throw new Error("trusted CLI identity snapshot has an unsafe Ultrafuzz modules directory");
  }
  const roots = new Map<string, string>();
  for (const entry of fs
    .readdirSync(modulesRoot, { withFileTypes: true })
    .sort((left, right) => compare(left.name, right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const root = path.join(modulesRoot, entry.name);
    const manifest = readPackageManifest(root);
    if (manifest.name !== `@ultrafuzz/${entry.name}`) {
      throw new Error("workflow execution snapshot contains a mismatched Ultrafuzz module");
    }
    roots.set(manifest.name, root);
  }
  return roots;
}

function collectPackageClosure(cliRoot: string, snapshotModules: ReadonlyMap<string, string>): SourcePackage[] {
  const packages: SourcePackage[] = [];
  const byRoot = new Map<string, SourcePackage>();
  const add = (root: string): SourcePackage => {
    const resolved = fs.realpathSync(root);
    const existing = byRoot.get(resolved);
    if (existing !== undefined) return existing;
    const manifestBytes = readRegularFileSnapshot(path.join(resolved, "package.json"), 1024 * 1024);
    const manifest = parsePackageManifest(manifestBytes, path.join(resolved, "package.json"));
    const sequence = String(packages.length + 1).padStart(6, "0");
    const entry: SourcePackage = {
      id: `package:${sequence}`,
      root: resolved,
      snapshotPath: `packages/${sequence}`,
      manifest,
      manifestBytes,
      dependencies: {}
    };
    packages.push(entry);
    byRoot.set(resolved, entry);
    return entry;
  };
  add(cliRoot);
  for (let index = 0; index < packages.length; index += 1) {
    const issuer = packages[index]!;
    for (const dependency of packageDependencies(issuer.manifest)) {
      const preferred = snapshotModules.get(dependency.name);
      const dependencyRoot = preferred ?? resolvePackageDependency(issuer.root, dependency.name);
      if (dependencyRoot === undefined) {
        if (dependency.optional) continue;
        throw new Error(`trusted CLI dependency is unavailable: ${issuer.manifest.name} -> ${dependency.name}`);
      }
      const target = add(dependencyRoot);
      issuer.dependencies[dependency.name] = target.id;
    }
    issuer.dependencies = Object.fromEntries(
      Object.entries(issuer.dependencies).sort(([left], [right]) => compare(left, right))
    );
  }
  return packages;
}

function copySourcePackage(root: string, source: SourcePackage): TrustedCliClosurePackage {
  const targetRoot = path.join(root, ...source.snapshotPath.split("/"));
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const files = sourcePackageFiles(source).map((sourcePath): TrustedCliClosureFile => {
    const relative = relativePackagePath(source.root, sourcePath);
    const snapshotPath = path.posix.join(source.snapshotPath, relative);
    const target = path.join(root, ...snapshotPath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const bytes = readStableRegularFile(sourcePath);
    if (relative === "package.json" && !bytes.equals(source.manifestBytes)) {
      throw new Error(`trusted CLI package manifest changed during closure capture: ${source.manifest.name}`);
    }
    const executable = (fs.statSync(sourcePath).mode & 0o111) !== 0;
    fs.writeFileSync(target, bytes, { mode: executable ? 0o500 : 0o400, flag: "wx" });
    return { path: snapshotPath, sha256: sha256(bytes), executable };
  });
  return {
    id: source.id,
    name: source.manifest.name,
    version: source.manifest.version,
    snapshot_path: source.snapshotPath,
    dependencies: source.dependencies,
    files
  };
}

function copyClosureIdentityFile(root: string, sourcePath: string, snapshotPath: string): TrustedCliClosureFile {
  const bytes = readStableRegularFile(sourcePath);
  const target = path.join(root, ...snapshotPath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { mode: 0o400, flag: "wx" });
  return { path: snapshotPath, sha256: sha256(bytes), executable: false };
}

function sourcePackageFiles(source: SourcePackage): string[] {
  const files = [path.join(source.root, "package.json")];
  if (source.manifest.name.startsWith("@ultrafuzz/")) {
    for (const directory of ["dist", "schema"]) {
      const candidate = path.join(source.root, directory);
      if (pathEntryExists(candidate)) files.push(...walkFiles(candidate, false));
    }
    const dockerfile = path.join(source.root, "Dockerfile");
    if (pathEntryExists(dockerfile)) files.push(dockerfile);
  } else {
    files.push(...walkFiles(source.root, true).filter((entry) => entry !== path.join(source.root, "package.json")));
  }
  const unique = [...new Set(files)].sort(compare);
  if (unique.length > MAX_FILES) throw new Error("trusted CLI package closure exceeds file limit");
  return unique;
}

function createDependencyLinks(root: string, packages: readonly TrustedCliClosurePackage[]): void {
  const byId = new Map(packages.map((entry) => [entry.id, entry]));
  for (const issuer of packages) {
    const issuerRoot = path.join(root, ...issuer.snapshot_path.split("/"));
    for (const [name, targetId] of Object.entries(issuer.dependencies)) {
      const target = byId.get(targetId);
      if (target === undefined) throw new Error("trusted CLI closure dependency target is missing");
      const segments = name.split("/");
      const link = path.join(issuerRoot, "node_modules", ...segments);
      fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
      const targetRoot = path.join(root, ...target.snapshot_path.split("/"));
      const relativeTarget = path.relative(path.dirname(link), targetRoot);
      if (relativeTarget.length === 0 || path.isAbsolute(relativeTarget)) {
        throw new Error("trusted CLI closure dependency link is invalid");
      }
      fs.symlinkSync(
        process.platform === "win32" ? targetRoot : relativeTarget,
        link,
        process.platform === "win32" ? "junction" : "dir"
      );
    }
  }
}

function sealClosure(root: string, manifest: TrustedCliClosureManifest): void {
  for (const entry of manifest.packages) {
    for (const file of entry.files) {
      fs.chmodSync(path.join(root, ...file.path.split("/")), file.executable ? 0o500 : 0o400);
    }
  }
  fs.chmodSync(path.join(root, manifest.module_confinement.path), 0o400);
  fs.chmodSync(path.join(root, manifest.validator_preflight.schema.path), 0o400);
  fs.chmodSync(path.join(root, manifest.validator_preflight.fixture.path), 0o400);
  fs.chmodSync(path.join(root, MANIFEST_FILE), 0o400);
  const directories = walkDirectories(root).sort((left, right) => right.length - left.length);
  for (const directory of directories) fs.chmodSync(directory, 0o500);
  fs.chmodSync(root, 0o500);
}

function verifyTrustedCliClosureRoot(
  root: string,
  expectedDigest: string,
  options: { allowTemporaryName?: boolean } = {}
): TrustedCliClosureManifest {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("trusted CLI closure root is unsafe");
  if (options.allowTemporaryName !== true && path.basename(root) !== expectedDigest) {
    throw new Error("trusted CLI closure content address is stale");
  }
  const manifestPath = path.join(root, MANIFEST_FILE);
  const manifestStat = fs.lstatSync(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.nlink !== 1 ||
    !modeMatches(manifestStat, 0o400)
  ) {
    throw new Error("trusted CLI closure manifest is unsafe");
  }
  const manifestBytes = readStableRegularFile(manifestPath);
  if (sha256(manifestBytes) !== expectedDigest) throw new Error("trusted CLI closure manifest digest changed");
  const manifest = parseClosureManifest(manifestBytes);
  const expectedEntries = new Set<string>([
    MANIFEST_FILE,
    manifest.module_confinement.path,
    manifest.validator_preflight.schema.path,
    manifest.validator_preflight.fixture.path,
    path.posix.dirname(manifest.validator_preflight.schema.path)
  ]);
  const confinementPath = path.join(root, manifest.module_confinement.path);
  const confinementStat = fs.lstatSync(confinementPath);
  if (
    !confinementStat.isFile() ||
    confinementStat.isSymbolicLink() ||
    confinementStat.nlink !== 1 ||
    !modeMatches(confinementStat, 0o400) ||
    sha256(readStableRegularFile(confinementPath)) !== manifest.module_confinement.sha256
  ) {
    throw new Error("trusted CLI module confinement changed");
  }
  for (const [label, file] of Object.entries(manifest.validator_preflight)) {
    const candidate = path.join(root, ...file.path.split("/"));
    const stat = fs.lstatSync(candidate);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      !modeMatches(stat, 0o400) ||
      sha256(readStableRegularFile(candidate)) !== file.sha256
    ) {
      throw new Error(`trusted CLI validator ${label} changed`);
    }
  }
  const byId = new Map(manifest.packages.map((entry) => [entry.id, entry]));
  for (const entry of manifest.packages) {
    expectedEntries.add(entry.snapshot_path);
    for (const file of entry.files) {
      expectedEntries.add(file.path);
      const candidate = path.join(root, ...file.path.split("/"));
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error(`trusted CLI closure file is unsafe: ${file.path}`);
      }
      if (!modeMatches(stat, file.executable ? 0o500 : 0o400)) {
        throw new Error(`trusted CLI closure file mode changed: ${file.path}`);
      }
      if (sha256(readStableRegularFile(candidate)) !== file.sha256) {
        throw new Error(`trusted CLI closure file changed: ${file.path}`);
      }
      addParentDirectories(expectedEntries, file.path);
    }
    for (const [name, targetId] of Object.entries(entry.dependencies)) {
      const target = byId.get(targetId);
      if (target === undefined) throw new Error("trusted CLI closure dependency target is missing");
      const linkPath = path.posix.join(entry.snapshot_path, "node_modules", name);
      const link = path.join(root, ...linkPath.split("/"));
      const stat = fs.lstatSync(link);
      if (!stat.isSymbolicLink()) throw new Error(`trusted CLI closure dependency link changed: ${linkPath}`);
      const expectedTarget = path.join(root, ...target.snapshot_path.split("/"));
      if (fs.realpathSync(link) !== fs.realpathSync(expectedTarget)) {
        throw new Error(`trusted CLI closure dependency link target changed: ${linkPath}`);
      }
      expectedEntries.add(linkPath);
      addParentDirectories(expectedEntries, linkPath);
    }
    addParentDirectories(expectedEntries, entry.snapshot_path);
  }
  const observed = walkClosureEntries(root);
  const unexpected = observed.filter((entry) => !expectedEntries.has(entry));
  const missing = [...expectedEntries].filter((entry) => !observed.includes(entry));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `trusted CLI closure path set changed${unexpected.length === 0 ? "" : `; unexpected: ${unexpected.join(", ")}`}${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}`
    );
  }
  if (!modeMatches(rootStat, 0o500)) throw new Error("trusted CLI closure root mode changed");
  for (const relative of observed.filter((entry) => fs.lstatSync(path.join(root, ...entry.split("/"))).isDirectory())) {
    if (!modeMatches(fs.lstatSync(path.join(root, ...relative.split("/"))), 0o500)) {
      throw new Error(`trusted CLI closure directory mode changed: ${relative}`);
    }
  }
  const cli = manifest.packages.flatMap((entry) => entry.files).find((entry) => entry.path === manifest.cli_entrypoint);
  if (cli === undefined) throw new Error("trusted CLI closure manifest omits its CLI entrypoint");
  return manifest;
}

function parseClosureManifest(bytes: Buffer): TrustedCliClosureManifest {
  const value = parseStrictJsonBytes(bytes, {
    maxBytes: 16 * 1024 * 1024,
    maxDepth: 64,
    maxItems: 200_000,
    maxProperties: 200_000
  });
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schema_version", "cli_entrypoint", "module_confinement", "validator_preflight", "packages"])
  ) {
    throw new Error("trusted CLI closure manifest is invalid");
  }
  if (
    value.schema_version !== CLOSURE_SCHEMA_VERSION ||
    !isSnapshotPath(value.cli_entrypoint) ||
    !isRecord(value.module_confinement) ||
    !hasExactKeys(value.module_confinement, ["path", "sha256", "executable"]) ||
    value.module_confinement.path !== MODULE_CONFINEMENT_FILE ||
    typeof value.module_confinement.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.module_confinement.sha256) ||
    value.module_confinement.executable !== false ||
    !isRecord(value.validator_preflight) ||
    !hasExactKeys(value.validator_preflight, ["schema", "fixture"]) ||
    !Array.isArray(value.packages)
  ) {
    throw new Error("trusted CLI closure manifest is invalid");
  }
  const packages = value.packages.map((entry, index): TrustedCliClosurePackage => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["id", "name", "version", "snapshot_path", "dependencies", "files"]) ||
      entry.id !== `package:${String(index + 1).padStart(6, "0")}` ||
      typeof entry.name !== "string" ||
      !PACKAGE_NAME_PATTERN.test(entry.name) ||
      typeof entry.version !== "string" ||
      entry.version.length === 0 ||
      entry.snapshot_path !== `packages/${String(index + 1).padStart(6, "0")}` ||
      !isRecord(entry.dependencies) ||
      !Array.isArray(entry.files)
    ) {
      throw new Error("trusted CLI closure package record is invalid");
    }
    const dependencies: Record<string, string> = {};
    for (const [name, target] of Object.entries(entry.dependencies)) {
      if (!PACKAGE_NAME_PATTERN.test(name) || typeof target !== "string" || !/^package:\d{6}$/u.test(target)) {
        throw new Error("trusted CLI closure dependency record is invalid");
      }
      dependencies[name] = target;
    }
    if (!isSorted(Object.keys(dependencies))) throw new Error("trusted CLI closure dependencies are not ordered");
    const files = entry.files.map((file): TrustedCliClosureFile => {
      if (
        !isRecord(file) ||
        !hasExactKeys(file, ["path", "sha256", "executable"]) ||
        typeof file.path !== "string" ||
        !isSnapshotPath(file.path) ||
        !file.path.startsWith(`${entry.snapshot_path}/`) ||
        typeof file.sha256 !== "string" ||
        !SHA256_PATTERN.test(file.sha256) ||
        typeof file.executable !== "boolean"
      ) {
        throw new Error("trusted CLI closure file record is invalid");
      }
      return { path: file.path, sha256: file.sha256, executable: file.executable };
    });
    if (!isSorted(files.map((file) => file.path)) || new Set(files.map((file) => file.path)).size !== files.length) {
      throw new Error("trusted CLI closure files are duplicated or not ordered");
    }
    if (!files.some((file) => file.path === `${entry.snapshot_path}/package.json`)) {
      throw new Error("trusted CLI closure package omits package.json");
    }
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      snapshot_path: entry.snapshot_path,
      dependencies,
      files
    };
  });
  const ids = new Set(packages.map((entry) => entry.id));
  if (packages.length === 0 || packages.some((entry) => Object.values(entry.dependencies).some((id) => !ids.has(id)))) {
    throw new Error("trusted CLI closure dependency graph is incomplete");
  }
  if (!packages[0]!.files.some((entry) => entry.path === value.cli_entrypoint)) {
    throw new Error("trusted CLI closure entrypoint is not owned by its root package");
  }
  const validatorPreflight = {
    schema: parseIdentityFile(value.validator_preflight.schema, VALIDATOR_SCHEMA_FILE),
    fixture: parseIdentityFile(value.validator_preflight.fixture, VALIDATOR_FIXTURE_FILE)
  };
  return {
    schema_version: CLOSURE_SCHEMA_VERSION,
    cli_entrypoint: value.cli_entrypoint,
    module_confinement: {
      path: MODULE_CONFINEMENT_FILE,
      sha256: value.module_confinement.sha256,
      executable: false
    },
    validator_preflight: validatorPreflight,
    packages
  };
}

function parseIdentityFile(value: unknown, expectedPath: string): TrustedCliClosureFile {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["path", "sha256", "executable"]) ||
    value.path !== expectedPath ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    value.executable !== false
  ) {
    throw new Error("trusted CLI closure identity file is invalid");
  }
  return { path: expectedPath, sha256: value.sha256, executable: false };
}

// Confinement has to be enforced on whichever runtime executes the closure.
// Node.js gets synchronous loader hooks; Bun has no `registerHooks`, so it gets
// the same sealed-module plugin shape used for the workflow controller. Bun
// hands `onLoad` the realpath-resolved path, so the negative-lookahead filter
// covers both the lexical and the resolved check the Node hooks perform. Either
// way an unsupported runtime fails closed instead of running unconfined.
function trustedCliModuleConfinementSource(): string {
  return `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const lexicalRoot = path.resolve(__dirname);
const closureRoot = fs.realpathSync(lexicalRoot);
const reject = (value) => { throw new Error("trusted CLI module resolved outside its content-addressed closure: " + value); };
const confined = (value) => value === closureRoot || value.startsWith(closureRoot + path.sep);
const assertConfined = (value) => {
  if (typeof value !== "string") reject(String(value));
  if (value.startsWith("node:")) return;
  if (!value.startsWith("file:")) reject(value);
  let lexical;
  let resolved;
  try {
    lexical = path.resolve(fileURLToPath(value));
    resolved = fs.realpathSync(lexical);
  } catch { reject(value); }
  if (!confined(lexical)) reject(value);
  if (!confined(resolved)) reject(value);
};
if (process.versions.bun) {
  const { plugin } = require("bun");
  if (typeof plugin !== "function") throw new Error("trusted CLI module confinement is unavailable on this runtime");
  const escape = (value) => [...value].map((character) => "^$.*+?()[]{}|\\\\".includes(character) ? "\\\\" + character : character).join("");
  const allowed = [lexicalRoot, closureRoot].map(escape).join("|");
  const outside = new RegExp("^(?!(?:" + allowed + ")(?:/|$)).+");
  plugin({
    name: "ultrafuzz-trusted-cli-closure",
    setup(build) {
      build.onLoad({ filter: outside, namespace: "file" }, (args) => reject(args.path));
    }
  });
} else {
  const { registerHooks } = require("node:module");
  if (typeof registerHooks !== "function") throw new Error("trusted CLI module confinement is unavailable on this runtime");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      assertConfined(result.url);
      return result;
    },
    load(url, context, nextLoad) {
      assertConfined(url);
      return nextLoad(url, context);
    }
  });
}
`;
}

function readPackageManifest(root: string): PackageManifest {
  return parsePackageManifest(
    readRegularFileSnapshot(path.join(root, "package.json"), 1024 * 1024),
    path.join(root, "package.json")
  );
}

function parsePackageManifest(bytes: Buffer, filePath: string): PackageManifest {
  const value = parseStrictJsonBytes(bytes, {
    maxBytes: 1024 * 1024,
    maxDepth: 32,
    maxItems: 20_000,
    maxProperties: 20_000
  });
  if (!isRecord(value) || typeof value.name !== "string" || !PACKAGE_NAME_PATTERN.test(value.name)) {
    throw new Error(`trusted CLI package has invalid metadata: ${filePath}`);
  }
  const version = typeof value.version === "string" && value.version.length > 0 ? value.version : "0.0.0-private";
  return {
    name: value.name,
    version,
    dependencies: stringMap(value.dependencies, filePath),
    optionalDependencies: stringMap(value.optionalDependencies, filePath),
    peerDependencies: stringMap(value.peerDependencies, filePath),
    peerDependenciesMeta: peerMetadata(value.peerDependenciesMeta, filePath)
  };
}

function stringMap(value: unknown, filePath: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`trusted CLI package dependency metadata is invalid: ${filePath}`);
  const result: Record<string, string> = {};
  for (const [name, range] of Object.entries(value)) {
    if (!PACKAGE_NAME_PATTERN.test(name) || typeof range !== "string") {
      throw new Error(`trusted CLI package dependency metadata is invalid: ${filePath}`);
    }
    result[name] = range;
  }
  return result;
}

function peerMetadata(value: unknown, filePath: string): Readonly<Record<string, Readonly<{ optional?: boolean }>>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`trusted CLI package peer metadata is invalid: ${filePath}`);
  const result: Record<string, Readonly<{ optional?: boolean }>> = {};
  for (const [name, metadata] of Object.entries(value)) {
    if (
      !PACKAGE_NAME_PATTERN.test(name) ||
      !isRecord(metadata) ||
      Object.keys(metadata).some((key) => key !== "optional")
    ) {
      throw new Error(`trusted CLI package peer metadata is invalid: ${filePath}`);
    }
    if (metadata.optional !== undefined && typeof metadata.optional !== "boolean") {
      throw new Error(`trusted CLI package peer metadata is invalid: ${filePath}`);
    }
    result[name] = metadata.optional === undefined ? {} : { optional: metadata.optional };
  }
  return result;
}

function packageDependencies(manifest: PackageManifest): Array<{ name: string; optional: boolean }> {
  const dependencies = new Map<string, boolean>();
  for (const name of Object.keys(manifest.dependencies)) dependencies.set(name, false);
  for (const name of Object.keys(manifest.optionalDependencies)) dependencies.set(name, true);
  for (const name of Object.keys(manifest.peerDependencies)) {
    const optional = manifest.peerDependenciesMeta[name]?.optional === true;
    if (!dependencies.has(name) || !optional) dependencies.set(name, optional);
  }
  return [...dependencies]
    .map(([name, optional]) => ({ name, optional }))
    .sort((left, right) => compare(left.name, right.name));
}

function resolvePackageDependency(issuerRoot: string, dependency: string): string | undefined {
  let current = path.resolve(issuerRoot);
  for (;;) {
    const candidate = path.join(current, "node_modules", ...dependency.split("/"));
    if (pathEntryExists(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function packageRoot(entrypoint: string): string {
  let current = path.dirname(entrypoint);
  for (;;) {
    const packageJson = path.join(current, "package.json");
    if (pathEntryExists(packageJson)) return fs.realpathSync(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error("cannot resolve trusted Ultrafuzz CLI package root");
    current = parent;
  }
}

function verifiedSourceEntrypoint(filePath: string): string {
  if (!path.isAbsolute(filePath)) throw new Error("Ultrafuzz CLI entrypoint must be absolute");
  const resolved = fs.realpathSync(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("Ultrafuzz CLI entrypoint must be an unlinked regular file");
  }
  return resolved;
}

function walkFiles(root: string, skipNodeModules: boolean): string[] {
  const pending = [path.resolve(root)];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compare(left.name, right.name))) {
      if (skipNodeModules && entry.name === "node_modules" && entry.isDirectory()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`trusted CLI package contains a symlink: ${candidate}`);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
      else throw new Error(`trusted CLI package contains a non-regular entry: ${candidate}`);
      if (files.length + pending.length > MAX_FILES) throw new Error("trusted CLI package closure exceeds file limit");
    }
  }
  return files.sort(compare);
}

function walkDirectories(root: string): string[] {
  const pending = [root];
  const directories: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      directories.push(candidate);
      pending.push(candidate);
    }
  }
  return directories;
}

function walkClosureEntries(root: string): string[] {
  const pending = [root];
  const entries: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compare(left.name, right.name))) {
      const candidate = path.join(current, entry.name);
      const relative = path.relative(root, candidate).split(path.sep).join("/");
      entries.push(relative);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(candidate);
    }
  }
  return entries.sort(compare);
}

function addParentDirectories(entries: Set<string>, value: string): void {
  let current = path.posix.dirname(value);
  while (current !== ".") {
    entries.add(current);
    current = path.posix.dirname(current);
  }
}

function relativePackagePath(root: string, filePath: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(filePath)).split(path.sep).join("/");
  if (!isSnapshotPath(relative)) throw new Error("trusted CLI package file escapes its package root");
  return relative;
}

function isSnapshotPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function readStableRegularFile(filePath: string): Buffer {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    // pnpm store payloads are intentionally hard-linked. The published copy is
    // always a new unlinked file; only the source descriptor must stay stable.
    if (!before.isFile() || before.nlink < 1 || before.size > MAX_FILE_BYTES) {
      throw new Error(`trusted CLI closure source is not a safe regular file: ${filePath}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== after.size
    ) {
      throw new Error(`trusted CLI closure source changed while it was read: ${filePath}`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeOwnedTemporary(closuresRoot: string, name: string): void {
  if (!/^\.tmp-\d+-[0-9a-f]{24}$/u.test(name)) throw new Error("refusing unsafe trusted CLI temporary cleanup");
  const target = path.join(closuresRoot, name);
  const relative = path.relative(closuresRoot, target);
  if (relative !== name || path.isAbsolute(relative)) throw new Error("trusted CLI temporary cleanup escaped its root");
  if (!pathEntryExists(target)) return;
  makeTreeWritable(target);
  fs.rmSync(target, { recursive: true, force: false });
}

function makeTreeWritable(root: string): void {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("trusted CLI temporary cleanup root is unsafe");
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) makeTreeWritable(candidate);
    else if (!entry.isSymbolicLink()) fs.chmodSync(candidate, 0o600);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function pathEntryExists(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function modeMatches(stat: fs.Stats, expected: number): boolean {
  return process.platform === "win32" || (stat.mode & 0o777) === expected;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compare(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compare);
  const sortedExpected = [...expected].sort(compare);
  return actual.length === sortedExpected.length && actual.every((entry, index) => entry === sortedExpected[index]);
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
