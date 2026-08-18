import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const OPERATOR_NPM_VERSION = "11.19.0";
const OPERATOR_NPM_CLOSURE_SHA256 = "4823bc9e925ce3ddecaa33d5d7fd01b1de0ba3c395332a58bcbbc481c2a1cdbe";
const OPERATOR_NPM_MAX_FILES = 10_000;
const OPERATOR_NPM_MAX_DIRECTORIES = 2_500;
const OPERATOR_NPM_MAX_BYTES = 64 * 1024 * 1024;
const OPERATOR_NPM_MAX_DEPTH = 32;
const OPERATOR_NPM_SNAPSHOT_DIRECTORY = "operator-npm";
let testOperatorNpmCli: string | undefined;

interface OperatorNpmClosure {
  bytes: number;
  digest: string;
  directories: number;
  files: number;
}

export interface OperatorNpmProvision {
  assertCurrent: () => void;
  cliPath: string;
}

export interface OperatorNpmAuthority {
  cacheKey: string;
  provision: (controllerRoot: string) => OperatorNpmProvision;
}

/**
 * Resolves npm from operator authority only. The normal path is the runtime's
 * integrity-pinned npm dependency, whose entire published closure is checked
 * before it is copied into the private controller root. Test injection is
 * available only under Node's test runner and is never forwarded to a workflow
 * or model child.
 */
export function resolveOperatorNpmAuthority(
  targetRoot: string,
  _env: Record<string, string | undefined> | undefined
): OperatorNpmAuthority {
  if (testOperatorNpmCli !== undefined) return testOperatorNpmAuthority(targetRoot, testOperatorNpmCli);

  const sourceRoot = bundledOperatorNpmRoot();
  assertBundledOperatorNpmManifest(sourceRoot);
  const sourceClosure = inspectOperatorNpmClosure(sourceRoot);
  if (sourceClosure.digest !== OPERATOR_NPM_CLOSURE_SHA256) {
    throw new Error("bundled operator npm closure differs from the release-pinned digest");
  }
  return {
    cacheKey: `bundled:${OPERATOR_NPM_CLOSURE_SHA256}:${targetAuthorityCacheKey(targetRoot)}`,
    provision: (controllerRoot) => {
      const snapshotRoot = path.join(controllerRoot, OPERATOR_NPM_SNAPSHOT_DIRECTORY);
      copyOperatorNpmClosure(sourceRoot, snapshotRoot);
      assertOperatorNpmSnapshot(snapshotRoot);
      const cliPath = path.join(snapshotRoot, "bin", "npm-cli.js");
      assertRegularOperatorNpmCli(cliPath, targetRoot);
      return {
        cliPath,
        assertCurrent: () => {
          assertOperatorNpmSnapshot(snapshotRoot);
          assertRegularOperatorNpmCli(cliPath, targetRoot);
        }
      };
    }
  };
}

function bundledOperatorNpmRoot(): string {
  const require = createRequire(import.meta.url);
  return fs.realpathSync(path.dirname(require.resolve("npm/package.json")));
}

function assertBundledOperatorNpmManifest(packageRoot: string): void {
  const manifestPath = path.join(packageRoot, "package.json");
  const bytes = readRegularFileStable(manifestPath, "bundled operator npm manifest", 1024 * 1024);
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("bundled operator npm manifest is invalid JSON", { cause: error });
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    (manifest as Record<string, unknown>).name !== "npm" ||
    (manifest as Record<string, unknown>).version !== OPERATOR_NPM_VERSION
  ) {
    throw new Error(`bundled operator npm manifest must identify npm ${OPERATOR_NPM_VERSION}`);
  }
}

function testOperatorNpmAuthority(targetRoot: string, configuredPath: string): OperatorNpmAuthority {
  if (!path.isAbsolute(configuredPath)) throw new Error("operator npm CLI path must be absolute");
  const cliPath = fs.realpathSync(configuredPath);
  assertRegularOperatorNpmCli(cliPath, targetRoot);
  const initial = regularFileIdentity(cliPath);
  return {
    cacheKey: `test:${cliPath}:${initial}:${targetAuthorityCacheKey(targetRoot)}`,
    provision: () => ({
      cliPath,
      assertCurrent: () => {
        assertRegularOperatorNpmCli(cliPath, targetRoot);
        if (regularFileIdentity(cliPath) !== initial) throw new Error("operator npm CLI changed after selection");
      }
    })
  };
}

function targetAuthorityCacheKey(targetRoot: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.realpathSync(path.resolve(targetRoot)))
    .digest("hex");
}

/** Test-only dependency injection for deterministic installer fixtures. */
export function setOperatorNpmCliForTests(cliPath: string): void {
  if (process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error("operator npm test injection is available only under the Node test runner");
  }
  testOperatorNpmCli = cliPath;
}

function assertRegularOperatorNpmCli(cliPath: string, targetRoot: string): void {
  const resolvedTarget = path.resolve(targetRoot);
  const canonicalTarget = fs.realpathSync(resolvedTarget);
  if (pathInside(resolvedTarget, cliPath) || pathInside(canonicalTarget, cliPath)) {
    throw new Error("operator npm CLI must be outside the target repository");
  }
  const stat = fs.lstatSync(cliPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
    throw new Error("operator npm CLI must be a non-group/world-writable, singly linked regular file");
  }
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function regularFileIdentity(filePath: string): string {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error("operator npm CLI is no longer a singly linked regular file");
  }
  return crypto
    .createHash("sha256")
    .update(`${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}\0`)
    .update(readRegularFileStable(filePath, "operator npm CLI"))
    .digest("hex");
}

function inspectOperatorNpmClosure(root: string, requireReadOnly = false): OperatorNpmClosure {
  const hash = crypto.createHash("sha256").update("ultrafuzz-operator-npm-v1\0");
  let bytes = 0,
    directories = 0,
    files = 0;

  const visit = (absolute: string, relative: string, depth: number): void => {
    if (depth > OPERATOR_NPM_MAX_DEPTH) throw new Error("operator npm closure is too deeply nested");
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`operator npm closure contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) {
      directories += 1;
      if (directories > OPERATOR_NPM_MAX_DIRECTORIES) throw new Error("operator npm closure has too many directories");
      if (requireReadOnly && (stat.mode & 0o777) !== 0o500) {
        throw new Error(`operator npm snapshot directory is not read-only: ${relative}`);
      }
      hash.update("d\0").update(relative).update("\0");
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(path.join(absolute, name), relative === "." ? name : `${relative}/${name}`, depth + 1);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`operator npm closure contains a non-regular entry: ${relative}`);
    files += 1;
    if (files > OPERATOR_NPM_MAX_FILES) throw new Error("operator npm closure has too many files");
    if (requireReadOnly && (stat.mode & 0o777) !== 0o400) {
      throw new Error(`operator npm snapshot file is not read-only: ${relative}`);
    }
    if (requireReadOnly && stat.nlink !== 1) {
      throw new Error(`operator npm snapshot file is multiply linked: ${relative}`);
    }
    const contents = readRegularFileStable(
      absolute,
      `operator npm closure file ${relative}`,
      OPERATOR_NPM_MAX_BYTES - bytes
    );
    bytes += contents.byteLength;
    if (bytes > OPERATOR_NPM_MAX_BYTES) throw new Error("operator npm closure is oversized");
    hash.update("f\0").update(relative).update("\0").update(`${contents.byteLength}\0`).update(contents);
  };

  visit(root, ".", 0);
  return { bytes, digest: hash.digest("hex"), directories, files };
}

function copyOperatorNpmClosure(sourceRoot: string, destinationRoot: string): void {
  if (fs.existsSync(destinationRoot)) throw new Error("operator npm snapshot path already exists");
  let bytes = 0,
    directories = 0,
    files = 0;
  const copy = (source: string, destination: string, depth: number): void => {
    if (depth > OPERATOR_NPM_MAX_DEPTH) throw new Error("operator npm source is too deeply nested");
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error("operator npm source changed to a symbolic link during snapshot");
    if (stat.isDirectory()) {
      directories += 1;
      if (directories > OPERATOR_NPM_MAX_DIRECTORIES) throw new Error("operator npm source has too many directories");
      fs.mkdirSync(destination, { mode: 0o700 });
      for (const name of fs.readdirSync(source).sort()) {
        copy(path.join(source, name), path.join(destination, name), depth + 1);
      }
      fs.chmodSync(destination, 0o500);
      return;
    }
    if (!stat.isFile()) throw new Error("operator npm source changed to a non-regular entry during snapshot");
    files += 1;
    if (files > OPERATOR_NPM_MAX_FILES) throw new Error("operator npm source has too many files");
    const contents = readRegularFileStable(source, "bundled operator npm closure", OPERATOR_NPM_MAX_BYTES - bytes);
    bytes += contents.byteLength;
    // This is a process-private disposable staging tree, not durable run state.
    // A failed copy discards the entire controller root, and the completed tree
    // is closure-hashed before use, so per-file fsync would add ~2,000 disk
    // barriers without improving recovery or authenticity.
    fs.writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
    fs.chmodSync(destination, 0o400);
  };
  copy(sourceRoot, destinationRoot, 0);
}

function assertOperatorNpmSnapshot(snapshotRoot: string): void {
  const closure = inspectOperatorNpmClosure(snapshotRoot, true);
  if (closure.digest !== OPERATOR_NPM_CLOSURE_SHA256) {
    throw new Error("private operator npm snapshot differs from the release-pinned closure");
  }
}

function readRegularFileStable(filePath: string, label: string, maxBytes = OPERATOR_NPM_MAX_BYTES): Buffer {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > BigInt(maxBytes)) throw new Error(`${label} is oversized`);
    const contents = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.size !== BigInt(contents.byteLength)
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

// Used only by the release-time digest regeneration test. Runtime callers use
// `resolveOperatorNpmAuthority`, which always checks the pinned constant.
export function bundledOperatorNpmClosureForValidation(): OperatorNpmClosure {
  const root = bundledOperatorNpmRoot();
  assertBundledOperatorNpmManifest(root);
  return inspectOperatorNpmClosure(root);
}
