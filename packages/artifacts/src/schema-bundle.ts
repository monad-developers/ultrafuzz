import fs from "node:fs";
import path from "node:path";

import { artifactSchemaFieldSummaries } from "./field-summaries.js";
import { layoutForRunRoot } from "./run-layout.js";
import { safeResolveInside, sha256Bytes, writeFileDurable } from "./safe-paths.js";
import {
  artifactSchemaBundleDigest,
  artifactSchemaDirectory,
  artifactSchemaRegistry,
  readRegularFileSnapshot,
  schemaRegistryBundleDigest,
  type ArtifactSchemaRegistryEntry
} from "./schema-registry.js";
import { artifactSchemaRegistryFromDirectory } from "./sealed-schema-registry.js";
import { readRunState } from "./state.js";

const MAX_SCHEMA_FILE_BYTES = 16 * 1024 * 1024;

/** One complete artifact schema bundle: the directory holding its schema files, and their registry. */
export interface ArtifactSchemaBundle {
  directory: string;
  registry: readonly ArtifactSchemaRegistryEntry[];
  /** `schemaRegistryBundleDigest(registry)`, the digest a planned output records. */
  sha256: string;
}

/** The schema bundle this build installs. */
export function installedArtifactSchemaBundle(): ArtifactSchemaBundle {
  return {
    directory: artifactSchemaDirectory(),
    registry: artifactSchemaRegistry(),
    sha256: artifactSchemaBundleDigest()
  };
}

/**
 * The schema bundle a run was planned with, which its artifacts are validated against (#921): this
 * build's installed schemas when they are that bundle, otherwise the copy sealed in the run's
 * execution snapshot. An upgrade that changes a schema therefore reaches only runs planned after it.
 */
export function plannedArtifactSchemaBundle(runRoot: string, plannedBundleSha256: string): ArtifactSchemaBundle {
  const installed = installedArtifactSchemaBundle();
  if (installed.sha256 === plannedBundleSha256) return installed;
  const directory = sealedArtifactSchemaDirectory(runRoot);
  const registry = artifactSchemaRegistryFromDirectory(directory);
  const sha256 = schemaRegistryBundleDigest(registry);
  if (sha256 !== plannedBundleSha256) {
    throw new Error(`the schema bundle sealed for this run is not the bundle its plan names: ${directory}`);
  }
  return { directory, registry, sha256 };
}

/** The directory of the schema bundle sealed in a run's execution snapshot at launch. */
function sealedArtifactSchemaDirectory(runRoot: string): string {
  const layout = layoutForRunRoot(runRoot);
  const snapshot = readRunState(layout).provenance?.workflow.executionSnapshot;
  if (snapshot === undefined) throw new Error("run state is missing sealed workflow schema authority");
  const snapshotRoot = safeResolveInside(layout.root, snapshot, "sealed workflow execution snapshot");
  return safeResolveInside(snapshotRoot, "modules/@ultrafuzz/artifacts/schema", "sealed artifact schema bundle");
}

/**
 * Materialize a schema bundle, the run's planned one, where an isolated task workspace can read it.
 * A copy that differs, left by an earlier attempt or build or edited in the workspace, is replaced:
 * the copy is only the agent's view of the bundle, and the host and the run's own validator check
 * artifacts against the bundle itself.
 */
export function materializePromptSchemas(destination: string, bundle: ArtifactSchemaBundle): string[] {
  // A workflow rendered before planned schema bundles passes its old options object, or nothing, here.
  if (typeof (bundle as Partial<ArtifactSchemaBundle> | undefined)?.directory !== "string") {
    throw new Error(
      "this run's workflow was rendered by an earlier Ultrafuzz release and cannot prepare its tasks with this one; continue the run with `ultrafuzz resume <run-id> --refresh-controller --retry-failed`"
    );
  }
  const source = bundle.directory;
  const target = path.resolve(destination);
  assertNoSymlinkComponents(target);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`prompt schema source is unavailable: ${source}`);
  }
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`prompt schema destination is unsafe: ${target}`);
    }
    fs.chmodSync(target, 0o700);
  } else {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }

  const copied: string[] = [];
  for (const schema of bundle.registry) {
    const name = schema.filename;
    const sourcePath = path.join(source, name);
    const targetPath = path.join(target, name);
    const sourceEntry = fs.lstatSync(sourcePath);
    if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink() || sourceEntry.nlink !== 1) {
      throw new Error(`prompt schema source entry is unsafe: ${sourcePath}`);
    }
    const sourceBytes = readRegularFileSnapshot(sourcePath, MAX_SCHEMA_FILE_BYTES);
    if (fs.existsSync(targetPath)) {
      const targetEntry = fs.lstatSync(targetPath);
      if (!targetEntry.isFile() || targetEntry.isSymbolicLink() || targetEntry.nlink !== 1) {
        throw new Error(`prompt schema destination entry is unsafe: ${targetPath}`);
      }
      if (!readRegularFileSnapshot(targetPath, MAX_SCHEMA_FILE_BYTES).equals(sourceBytes)) {
        writeFileDurable(targetPath, sourceBytes, { mode: 0o400 });
      }
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
    fs.chmodSync(targetPath, 0o400);
    if (sha256Bytes(readRegularFileSnapshot(targetPath, MAX_SCHEMA_FILE_BYTES)) !== schema.sha256) {
      throw new Error(`prompt schema destination failed its pinned digest check: ${targetPath}`);
    }
    copied.push(targetPath);
  }
  if (copied.length === 0) throw new Error(`prompt schema source is empty: ${source}`);
  copied.push(...materializeFieldSummaries(source, target, bundle));
  // Keep the schema files read-only while allowing the owning task/worktree
  // cleanup to unlink and recreate the directory.
  fs.chmodSync(target, 0o700);
  return copied;
}

/**
 * Copy the bundle's derived field summaries beside its schemas, for the summary paths the rendered
 * output contract names (#1298). A summary is the agent's view of a schema's shape and never a
 * validation input, so it carries no pinned digest; a bundle sealed before summaries existed
 * simply has none to copy and the prompt's summary line is omitted for the same reason.
 */
function materializeFieldSummaries(source: string, target: string, bundle: ArtifactSchemaBundle): string[] {
  const summaries = artifactSchemaFieldSummaries(source);
  if (summaries.size === 0) return [];
  const registered = new Set(bundle.registry.map((entry) => entry.filename));
  const copied: string[] = [];
  for (const [schemaFilename, summary] of summaries) {
    if (!registered.has(schemaFilename)) continue;
    const sourcePath = safeResolveInside(source, summary.summaryFilename, "prompt schema field summary");
    if (!fs.existsSync(sourcePath)) continue;
    const sourceEntry = fs.lstatSync(sourcePath);
    if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink() || sourceEntry.nlink !== 1) {
      throw new Error(`prompt schema field summary source entry is unsafe: ${sourcePath}`);
    }
    const sourceBytes = readRegularFileSnapshot(sourcePath, MAX_SCHEMA_FILE_BYTES);
    const targetPath = safeResolveInside(target, summary.summaryFilename, "prompt schema field summary destination");
    if (fs.existsSync(targetPath)) {
      const targetEntry = fs.lstatSync(targetPath);
      if (!targetEntry.isFile() || targetEntry.isSymbolicLink() || targetEntry.nlink !== 1) {
        throw new Error(`prompt schema field summary destination entry is unsafe: ${targetPath}`);
      }
      if (!readRegularFileSnapshot(targetPath, MAX_SCHEMA_FILE_BYTES).equals(sourceBytes)) {
        writeFileDurable(targetPath, sourceBytes, { mode: 0o400 });
      }
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
    fs.chmodSync(targetPath, 0o400);
    copied.push(targetPath);
  }
  return copied;
}

function assertNoSymlinkComponents(candidate: string): void {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`prompt schema destination crosses a symlink: ${current}`);
    }
  }
}
