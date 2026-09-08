import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";

import {
  assertNoSymlinkComponents,
  assertPathInside,
  fsyncDirectory as syncDirectory,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  validateSafeId,
  writeFileDurable
} from "@ultrafuzz/artifacts";

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 16_384;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const tree = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const replacementSchema = z.strictObject({
  schema_version: z.literal("ultrafuzz.workspace-preparation-replacement.v1"),
  attempt_id: z.string(),
  replacement_tree: tree,
  dependency_sha256: digest,
  moves: z
    .array(
      z.strictObject({
        path: z.string(),
        directory: z.boolean(),
        directories: z.array(z.string()).max(MAX_FILES),
        files: z
          .array(
            z.strictObject({ path: z.string(), sha256: digest, size: z.number().int().min(0).max(MAX_FILE_BYTES) })
          )
          .max(MAX_FILES)
      })
    )
    .max(16)
});
const authoritySchema = z.strictObject({
  schema_version: z.literal("ultrafuzz.workspace-preparation-authority.v1"),
  attempt_id: z.string(),
  preparation_tree: tree,
  dependency_sha256: digest
});

export function workspacePreparationAuthorityPath(runRoot: string, attemptId: string): string {
  validateSafeId(attemptId, "workspace preparation attempt ID");
  const candidate = path.resolve(runRoot, "workspace-preparation-authority", `${attemptId}.json`);
  assertNoSymlinkComponents(runRoot, candidate, "protected workspace preparation authority");
  return candidate;
}

export function serializeWorkspacePreparationAuthority(
  attemptId: string,
  preparationTree: string,
  dependencySha256: string
): string {
  return `${JSON.stringify(
    authoritySchema.parse({
      schema_version: "ultrafuzz.workspace-preparation-authority.v1",
      attempt_id: attemptId,
      preparation_tree: preparationTree,
      dependency_sha256: dependencySha256
    })
  )}\n`;
}

export function readWorkspacePreparationAuthority(runRoot: string, attemptId: string) {
  const candidate = workspacePreparationAuthorityPath(runRoot, attemptId);
  if (!fs.existsSync(candidate)) return undefined;
  if (fs.lstatSync(candidate).nlink !== 1)
    throw new Error("artifact-contract failure: hard-linked workspace preparation authority");
  const record = authoritySchema.parse(parseStrictJsonBytes(readRegularFileSnapshot(candidate, MAX_RECORD_BYTES)));
  if (record.attempt_id !== attemptId)
    throw new Error("artifact-contract failure: protected workspace preparation attempt changed");
  return record;
}

export function writeWorkspacePreparationAuthority(
  runRoot: string,
  attemptId: string,
  preparationTree: string,
  dependencySha256: string
): void {
  const candidate = workspacePreparationAuthorityPath(runRoot, attemptId);
  const contents = serializeWorkspacePreparationAuthority(attemptId, preparationTree, dependencySha256);
  if (fs.existsSync(candidate)) {
    if (fs.lstatSync(candidate).nlink !== 1)
      throw new Error("artifact-contract failure: hard-linked workspace preparation authority");
    if (!readRegularFileSnapshot(candidate, MAX_RECORD_BYTES).equals(Buffer.from(contents))) {
      throw new Error("artifact-contract failure: protected workspace preparation authority changed");
    }
    return;
  }
  writeFileDurable(candidate, contents);
  syncDirectoryParents(fs.realpathSync(runRoot), path.dirname(candidate));
}

function replacementRoot(runRoot: string, attemptId: string): string {
  validateSafeId(attemptId, "workspace preparation attempt ID");
  const root = path.resolve(runRoot, "workspace-preparation-replacements", attemptId);
  assertNoSymlinkComponents(runRoot, root, "workspace preparation replacement");
  return root;
}

export function hasPendingWorkspacePreparationReplacement(runRoot: string, attemptId: string): boolean {
  const record = path.join(replacementRoot(runRoot, attemptId), "pending", "replacement.json");
  assertNoSymlinkComponents(runRoot, record, "workspace preparation replacement record");
  return fs.existsSync(record);
}

function syncDirectoryParents(root: string, leaf: string): void {
  for (let current = leaf; ; current = path.dirname(current)) {
    syncDirectory(current);
    if (current === root) return;
    assertPathInside(root, current, "workspace preparation replacement sync path");
  }
}

function checkedPath(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("artifact-contract failure: invalid workspace preparation replacement path");
  }
  const candidate = path.resolve(root, relativePath);
  assertPathInside(root, candidate, "workspace preparation replacement path");
  assertNoSymlinkComponents(root, candidate, "workspace preparation replacement path");
  return candidate;
}

function snapshotEntry(root: string): {
  directory: boolean;
  directories: string[];
  files: Array<{ path: string; sha256: string; size: number }>;
} {
  const files: Array<{ path: string; sha256: string; size: number }> = [];
  const directories: string[] = [];
  let totalBytes = 0;
  const stat = fs.lstatSync(root);
  const directory = stat.isDirectory();
  const visit = (candidate: string, relativePath: string): void => {
    const entry = fs.lstatSync(candidate);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw new Error(`artifact-contract failure: unsafe preparation replacement entry ${candidate}`);
    }
    if (entry.isDirectory()) {
      if (directories.length >= MAX_FILES)
        throw new Error("artifact-contract failure: preparation replacement directory budget exceeded");
      directories.push(relativePath);
      for (const name of fs.readdirSync(candidate).sort())
        visit(path.join(candidate, name), relativePath === "" ? name : `${relativePath}/${name}`);
      return;
    }
    if (entry.nlink !== 1 || files.length >= MAX_FILES) {
      throw new Error(`artifact-contract failure: unsafe preparation replacement file ${candidate}`);
    }
    const bytes = readRegularFileSnapshot(candidate, MAX_FILE_BYTES);
    totalBytes += bytes.length;
    if (totalBytes > 512 * 1024 * 1024)
      throw new Error("artifact-contract failure: preparation replacement byte budget exceeded");
    files.push({
      path: relativePath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length
    });
  };
  visit(root, "");
  return { directory, directories, files };
}

function assertArchivePathSet(pending: string, moves: z.infer<typeof replacementSchema>["moves"]): void {
  if (fs.readdirSync(pending).some((entry) => entry !== "replacement.json" && entry !== "archive")) {
    throw new Error("artifact-contract failure: unexpected pending preparation replacement entry");
  }
  const archive = path.join(pending, "archive");
  if (!fs.existsSync(archive)) return;
  const allowedFiles = new Set<string>();
  const allowedDirectories = new Set<string>([""]);
  for (const move of moves) {
    for (const file of move.files) allowedFiles.add(file.path === "" ? move.path : `${move.path}/${file.path}`);
    for (const directory of move.directories)
      allowedDirectories.add(directory === "" ? move.path : `${move.path}/${directory}`);
    let parent = path.posix.dirname(move.path);
    while (parent !== ".") {
      allowedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const visit = (candidate: string, relativePath: string): void => {
    const stat = fs.lstatSync(candidate);
    if (
      stat.isSymbolicLink() ||
      (!stat.isFile() && !stat.isDirectory()) ||
      !(stat.isDirectory() ? allowedDirectories : allowedFiles).has(relativePath)
    ) {
      throw new Error(`artifact-contract failure: unexpected preparation replacement archive entry ${relativePath}`);
    }
    if (stat.isDirectory())
      for (const entry of fs.readdirSync(candidate))
        visit(path.join(candidate, entry), relativePath === "" ? entry : `${relativePath}/${entry}`);
  };
  visit(archive, "");
}

type ReplacementInput = {
  runRoot: string;
  attemptId: string;
  replacementTree: string;
  dependencySha256: string;
  paths: readonly string[];
  replacementFiles: readonly { path: string; bytes: string }[];
  validatePrevious: () => void;
  rebuild: () => void;
};

function createReplacementRecord(input: ReplacementInput, runRoot: string, pending: string) {
  const root = path.dirname(pending);
  const recordPath = path.join(pending, "replacement.json");
  input.validatePrevious();
  const moves = input.paths.flatMap((relativePath) => {
    const source = checkedPath(runRoot, relativePath);
    return fs.existsSync(source) ? [{ path: relativePath, ...snapshotEntry(source) }] : [];
  });
  const record = replacementSchema.parse({
    schema_version: "ultrafuzz.workspace-preparation-replacement.v1",
    attempt_id: input.attemptId,
    replacement_tree: input.replacementTree,
    dependency_sha256: input.dependencySha256,
    moves
  });
  fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(runRoot, pending, "workspace preparation replacement pending directory");
  const abandoned = fs.readdirSync(pending);
  if (abandoned.length !== 0) {
    if (abandoned.some((entry) => !/^\.replacement\.json\.tmp-\d+-\d+-[a-f0-9]{12}$/u.test(entry))) {
      throw new Error("artifact-contract failure: unrecognized pending preparation replacement state");
    }
    // No committed plan means no source move was authorized. Preserve a
    // killed durable writer's temporary bytes, then start a fresh plan.
    const snapshot = snapshotEntry(pending);
    if (snapshot.directories.length !== 1)
      throw new Error("artifact-contract failure: unsafe uncommitted preparation replacement state");
    fs.renameSync(pending, path.join(root, `uncommitted-${crypto.randomUUID()}`));
    syncDirectory(root);
    fs.mkdirSync(pending, { mode: 0o700 });
  }
  const contents = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(contents) > MAX_RECORD_BYTES) {
    throw new Error("artifact-contract failure: preparation replacement record byte budget exceeded");
  }
  writeFileDurable(recordPath, contents);
  syncDirectoryParents(runRoot, pending);
  return record;
}

/**
 * Retire one reopened attempt's pre-agent evidence, retaining every old byte.
 * The protected pending record authenticates interrupted moves: a missing source
 * is recoverable only when its exact recorded bytes exist in the archive. New
 * evidence is created only after every old store has moved. Finishing the record
 * precedes agent dispatch, so retries can safely repeat the pre-agent rebuild.
 */
export function replaceWorkspacePreparationEvidence(input: ReplacementInput): void {
  const runRoot = fs.realpathSync(input.runRoot);
  const root = replacementRoot(runRoot, input.attemptId);
  const pending = path.join(root, "pending");
  const recordPath = path.join(pending, "replacement.json");
  const allowed = new Set(input.paths);
  if (allowed.size !== input.paths.length)
    throw new Error("artifact-contract failure: duplicate preparation replacement path");
  for (const relativePath of allowed) checkedPath(runRoot, relativePath);
  const replacementFiles = new Map(input.replacementFiles.map((file) => [file.path, file.bytes]));
  if (
    replacementFiles.size !== input.replacementFiles.length ||
    [...replacementFiles.keys()].some((file) => !allowed.has(file))
  ) {
    throw new Error("artifact-contract failure: invalid preparation replacement publication paths");
  }
  let record: z.infer<typeof replacementSchema>;
  if (fs.existsSync(recordPath)) {
    assertNoSymlinkComponents(runRoot, recordPath, "workspace preparation replacement record");
    record = replacementSchema.parse(parseStrictJsonBytes(readRegularFileSnapshot(recordPath, MAX_RECORD_BYTES)));
  } else record = createReplacementRecord(input, runRoot, pending);
  if (
    record.attempt_id !== input.attemptId ||
    record.replacement_tree !== input.replacementTree ||
    record.dependency_sha256 !== input.dependencySha256 ||
    new Set(record.moves.map((move) => move.path)).size !== record.moves.length ||
    record.moves.some((move) => !allowed.has(move.path))
  ) {
    throw new Error("artifact-contract failure: pending preparation replacement authority changed");
  }
  assertArchivePathSet(pending, record.moves);
  const moves = record.moves.map((move) => {
    const source = checkedPath(runRoot, move.path);
    const destination = checkedPath(pending, `archive/${move.path}`);
    const archived = fs.existsSync(destination);
    const observed = snapshotEntry(archived ? destination : source);
    if (
      JSON.stringify(observed) !==
      JSON.stringify({ directory: move.directory, directories: move.directories, files: move.files })
    ) {
      throw new Error(`artifact-contract failure: preparation replacement evidence changed ${move.path}`);
    }
    if (archived && fs.existsSync(source)) {
      const replacement = replacementFiles.get(move.path);
      if (
        replacement === undefined ||
        !readRegularFileSnapshot(source, MAX_RECORD_BYTES).equals(Buffer.from(replacement))
      ) {
        throw new Error(`artifact-contract failure: conflicting preparation replacement evidence ${move.path}`);
      }
    }
    return { source, destination, archived };
  });
  const recordedPaths = new Set(record.moves.map((move) => move.path));
  for (const relativePath of allowed) {
    if (recordedPaths.has(relativePath)) continue;
    const source = checkedPath(runRoot, relativePath);
    if (!fs.existsSync(source)) continue;
    const replacement = replacementFiles.get(relativePath);
    if (
      replacement === undefined ||
      !readRegularFileSnapshot(source, MAX_RECORD_BYTES).equals(Buffer.from(replacement))
    ) {
      throw new Error(`artifact-contract failure: unexpected preparation replacement evidence ${relativePath}`);
    }
  }
  // Validate the complete move set before the first rename, including on resume.
  for (const move of moves) {
    if (move.archived) continue;
    fs.mkdirSync(path.dirname(move.destination), { recursive: true, mode: 0o700 });
    fs.renameSync(move.source, move.destination);
    syncDirectory(path.dirname(move.source));
    syncDirectoryParents(pending, path.dirname(move.destination));
  }
  input.rebuild();
  for (const [relativePath, contents] of replacementFiles)
    writeFileDurable(checkedPath(runRoot, relativePath), contents);
  // Keep old evidence for inspection; no active reader consults this history.
  fs.renameSync(pending, path.join(root, `completed-${crypto.randomUUID()}`));
  syncDirectory(root);
}
