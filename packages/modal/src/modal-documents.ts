import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertPathInside,
  DEFAULT_MAX_JSON_INSTANCE_BYTES,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  validateRegisteredJsonBytesSync,
  type JsonFileValidationDiagnostic
} from "@ultrafuzz/artifacts";

import { assertModalRetainedZodShape } from "./benchmark-config-zod.js";
import { type DeepReadonly, type ModalContractForSchemaId, type ModalContractSchemaId } from "./modal-contracts.js";
import {
  modalSchemaBundleDigest,
  modalSchemaDirectory,
  modalSchemaEntry,
  modalSchemaRegistry,
  validateModalJsonSchema
} from "./modal-schema-registry.js";
import { assertModalDocumentSemantics } from "./modal-semantic-gates.js";

export const MAX_MODAL_DOCUMENT_BYTES = DEFAULT_MAX_JSON_INSTANCE_BYTES;

export interface ModalDocumentSnapshot<SchemaId extends ModalContractSchemaId> {
  readonly schema_id: SchemaId;
  readonly schema_sha256: string;
  readonly bytes_sha256: string;
  readonly byte_length: number;
  readonly value: DeepReadonly<ModalContractForSchemaId<SchemaId>>;
}

export interface ModalDocumentWriteOptions {
  /** Existing canonical directory that owns every path the writer may mutate. */
  readonly trustedRoot: string;
}

export class ModalDocumentValidationError extends Error {
  readonly schemaId: ModalContractSchemaId;
  readonly diagnostics: readonly JsonFileValidationDiagnostic[];

  constructor(
    schemaId: ModalContractSchemaId,
    message: string,
    diagnostics: readonly JsonFileValidationDiagnostic[] = [],
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "ModalDocumentValidationError";
    this.schemaId = schemaId;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

/**
 * Parse and validate one detached byte snapshot.
 *
 * The same captured bytes go through the same isolated strict parser and pinned
 * schema bundle used by `ultrafuzz json validate`, then through the trusted
 * host's semantic gates. No conversion or repair occurs between those steps.
 */
export function parseModalDocumentBytes<SchemaId extends ModalContractSchemaId>(
  schemaId: SchemaId,
  input: Uint8Array
): ModalDocumentSnapshot<SchemaId> {
  const bytes = Buffer.from(input);
  const entry = modalSchemaEntry(schemaId);
  if (bytes.byteLength > entry.maxInstanceBytes) {
    throw new ModalDocumentValidationError(
      schemaId,
      `Modal JSON document exceeds the ${entry.maxInstanceBytes}-byte limit`
    );
  }
  const validation = validateRegisteredJsonBytesSync({
    schemaPath: path.join(modalSchemaDirectory(), entry.filename),
    instanceBytes: bytes,
    schemaRegistry: modalSchemaRegistry(),
    schemaBundleSha256: modalSchemaBundleDigest()
  });
  if (validation.status !== "valid") {
    const detail = validation.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ");
    throw new ModalDocumentValidationError(
      schemaId,
      `Modal JSON document failed ${schemaId}${detail === "" ? "" : `: ${detail}`}`,
      validation.diagnostics
    );
  }

  let parsed: unknown;
  try {
    parsed = parseStrictJsonBytes(bytes, {
      maxBytes: entry.maxInstanceBytes,
      maxDepth: 128,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    });
  } catch (error) {
    throw new ModalDocumentValidationError(schemaId, `Modal JSON document is not strict JSON`, [], {
      cause: error
    });
  }
  const value = parseModalDocumentValue(schemaId, parsed);
  deepFreeze(value);
  return Object.freeze({
    schema_id: schemaId,
    schema_sha256: entry.sha256,
    bytes_sha256: validation.artifact_sha256 ?? crypto.createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.byteLength,
    value: value as DeepReadonly<ModalContractForSchemaId<SchemaId>>
  });
}

/** Capture a stable regular-file snapshot and validate exactly those bytes. */
export function readModalDocument<SchemaId extends ModalContractSchemaId>(
  filePath: string,
  schemaId: SchemaId
): ModalDocumentSnapshot<SchemaId> {
  const bytes = readRegularFileSnapshot(path.resolve(filePath), modalSchemaEntry(schemaId).maxInstanceBytes);
  return parseModalDocumentBytes(schemaId, bytes);
}

/** Validate an in-memory value without transforming, defaulting, or cloning it. */
export function assertModalDocumentValue<SchemaId extends ModalContractSchemaId>(
  schemaId: SchemaId,
  value: ModalContractForSchemaId<SchemaId>
): void {
  parseModalDocumentValue(schemaId, value);
}

/**
 * Validate an unknown in-memory value through the canonical JSON Schema and
 * the same named host gates used for byte snapshots. The original value is
 * returned without cloning, stripping, defaulting, or otherwise converting it.
 */
export function parseModalDocumentValue<SchemaId extends ModalContractSchemaId>(
  schemaId: SchemaId,
  value: unknown
): ModalContractForSchemaId<SchemaId> {
  const result = validateModalJsonSchema(schemaId, value);
  if (!result.ok) {
    const detail = result.issues.map((issue) => `${issue.instancePath || "/"} ${issue.message}`).join("; ");
    throw new ModalDocumentValidationError(
      schemaId,
      `Modal JSON value failed ${schemaId}${detail === "" ? "" : `: ${detail}`}`
    );
  }
  const contract = value as ModalContractForSchemaId<SchemaId>;
  try {
    assertModalRetainedZodShape(schemaId, contract);
  } catch (error) {
    throw new ModalDocumentValidationError(schemaId, `Modal JSON value failed retained Zod shape validation`, [], {
      cause: error
    });
  }
  try {
    assertModalDocumentSemantics(schemaId, contract);
  } catch (error) {
    throw new ModalDocumentValidationError(schemaId, `Modal JSON value failed trusted semantic gates`, [], {
      cause: error
    });
  }
  return contract;
}

/**
 * Serialize only an already-valid canonical value, then re-parse and revalidate
 * the actual bytes that will be persisted.
 */
export function serializeModalDocument<SchemaId extends ModalContractSchemaId>(
  schemaId: SchemaId,
  value: ModalContractForSchemaId<SchemaId>
): { readonly bytes: Buffer; readonly snapshot: ModalDocumentSnapshot<SchemaId> } {
  assertModalDocumentValue(schemaId, value);
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    throw new ModalDocumentValidationError(schemaId, "Modal JSON value cannot be serialized", [], {
      cause: error
    });
  }
  const bytes = Buffer.from(serialized, "utf8");
  const snapshot = parseModalDocumentBytes(schemaId, bytes);
  return Object.freeze({ bytes, snapshot });
}

/**
 * Persist validated bytes beneath one explicit trusted root.
 *
 * Every parent component is opened without following symlinks. Temp creation,
 * rename, and directory fsync stay anchored to the verified final parent
 * descriptor; there is deliberately no lexical-path publication fallback.
 */
export async function writeModalDocumentAtomic<SchemaId extends ModalContractSchemaId>(
  filePath: string,
  schemaId: SchemaId,
  value: ModalContractForSchemaId<SchemaId>,
  options: ModalDocumentWriteOptions
): Promise<ModalDocumentSnapshot<SchemaId>> {
  const { bytes, snapshot } = serializeModalDocument(schemaId, value);
  const { root, target, parentSegments } = resolveModalDocumentWriteTarget(options.trustedRoot, filePath);
  const directories = await openModalDocumentDirectoryChain(root, parentSegments);
  const parent = directories.at(-1);
  if (parent === undefined) throw new Error("Modal document writer did not open a parent directory");

  const targetAccessPath = path.join(parent.accessPath, path.basename(target));
  const temporaryAccessPath = path.join(
    parent.accessPath,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`
  );
  let handle: FileHandle | undefined;
  let temporaryIdentity: fs.BigIntStats | undefined;
  let initialTarget: fs.BigIntStats | undefined;
  let published = false;
  let completed = false;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  let cleanupMutatedDirectory = false;

  try {
    await assertModalDocumentDirectoryChainCurrent(root, directories);
    initialTarget = await readSafeModalDocumentTarget(root, target, targetAccessPath);

    handle = await fs.promises.open(
      temporaryAccessPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600
    );
    temporaryIdentity = await handle.stat({ bigint: true });
    assertPreparedModalDocumentFile(temporaryIdentity, 0);
    const namedTemporary = await fs.promises.lstat(temporaryAccessPath, { bigint: true });
    if (!sameModalDocumentIdentity(temporaryIdentity, namedTemporary)) {
      throw new Error("Modal document temporary file changed while it was opened");
    }

    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    assertPreparedModalDocumentFile(written, bytes.byteLength, temporaryIdentity);
    await assertOpenedModalDocumentBytes(handle, temporaryIdentity, bytes.byteLength, snapshot.bytes_sha256);

    await assertModalDocumentDirectoryChainCurrent(root, directories);
    await assertModalDocumentTargetUnchanged(root, target, targetAccessPath, initialTarget);
    await fs.promises.rename(temporaryAccessPath, targetAccessPath);
    published = true;

    await assertPublishedModalDocument(root, target, targetAccessPath, temporaryIdentity, bytes.byteLength);
    await assertModalDocumentDirectoryChainCurrent(root, directories);
    await parent.handle.sync();
    await assertPublishedModalDocument(root, target, targetAccessPath, temporaryIdentity, bytes.byteLength);
    await assertOpenedModalDocumentBytes(handle, temporaryIdentity, bytes.byteLength, snapshot.bytes_sha256);
    await assertModalDocumentDirectoryChainCurrent(root, directories);
    completed = true;
  } catch (error) {
    failure = error;
  }

  if (!completed && published && initialTarget === undefined && temporaryIdentity !== undefined) {
    try {
      cleanupMutatedDirectory =
        (await unlinkOwnedModalDocumentPath(targetAccessPath, temporaryIdentity)) || cleanupMutatedDirectory;
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (temporaryIdentity !== undefined) {
    try {
      cleanupMutatedDirectory =
        (await unlinkOwnedModalDocumentPath(temporaryAccessPath, temporaryIdentity)) || cleanupMutatedDirectory;
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupMutatedDirectory) {
    try {
      await parent.handle.sync();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  for (const directory of [...directories].reverse()) {
    try {
      await directory.handle.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (failure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([failure, ...cleanupFailures], "Modal document write and cleanup failed", {
      cause: failure
    });
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Modal document write cleanup failed", {
      cause: cleanupFailures[0]
    });
  }
  return snapshot;
}

interface OpenedModalDocumentDirectory {
  readonly lexicalPath: string;
  readonly accessPath: string;
  readonly handle: FileHandle;
  readonly identity: fs.BigIntStats;
}

function resolveModalDocumentWriteTarget(
  trustedRoot: string,
  filePath: string
): { readonly root: string; readonly target: string; readonly parentSegments: readonly string[] } {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(filePath);
  assertPathInside(root, target, "Modal document target");
  if (target === root) throw new Error("Modal document target must be a file inside its trusted root");

  assertNoSymlinkComponents(root, root, "Modal document trusted root");
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    throw new Error("Modal document trusted root must be an existing canonical physical directory");
  }

  const parent = path.dirname(target);
  assertNoSymlinkComponents(root, parent, "Modal document parent");
  const relativeParent = path.relative(root, parent);
  if (path.isAbsolute(relativeParent) || relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`)) {
    throw new Error("Modal document parent escapes its trusted root");
  }
  const parentSegments = relativeParent === "" ? [] : relativeParent.split(path.sep);
  if (
    parentSegments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\0"))
  ) {
    throw new Error("Modal document parent contains an unsafe path segment");
  }
  const basename = path.basename(target);
  if (basename === "" || basename === "." || basename === ".." || basename.includes("\0")) {
    throw new Error("Modal document target has an unsafe basename");
  }
  return { root, target, parentSegments };
}

async function openModalDocumentDirectoryChain(
  root: string,
  parentSegments: readonly string[]
): Promise<OpenedModalDocumentDirectory[]> {
  const opened: OpenedModalDocumentDirectory[] = [];
  try {
    opened.push(await openModalDocumentDirectory(root));
    for (const segment of parentSegments) {
      const parent = opened.at(-1)!;
      const accessPath = path.join(parent.accessPath, segment);
      const lexicalPath = path.join(parent.lexicalPath, segment);
      let handle: FileHandle;
      try {
        handle = await fs.promises.open(
          accessPath,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
        );
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        try {
          await fs.promises.mkdir(accessPath, { mode: 0o700 });
        } catch (mkdirError) {
          if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError;
        }
        handle = await fs.promises.open(
          accessPath,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
        );
      }
      try {
        opened.push(await describeOpenedModalDocumentDirectory(lexicalPath, handle));
      } catch (error) {
        await closeModalDocumentHandleAfterFailure(handle, error, "Modal document child directory close failed");
      }
      await assertModalDocumentDirectoryChainCurrent(root, opened);
    }
    return opened;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    for (const directory of [...opened].reverse()) {
      try {
        await directory.handle.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], "Modal document parent open and cleanup failed", {
        cause: error
      });
    }
    throw error;
  }
}

async function openModalDocumentDirectory(lexicalPath: string): Promise<OpenedModalDocumentDirectory> {
  const handle = await fs.promises.open(
    lexicalPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  try {
    return await describeOpenedModalDocumentDirectory(lexicalPath, handle);
  } catch (error) {
    return await closeModalDocumentHandleAfterFailure(handle, error, "Modal document root directory close failed");
  }
}

async function closeModalDocumentHandleAfterFailure(
  handle: FileHandle,
  failure: unknown,
  message: string
): Promise<never> {
  try {
    await handle.close();
  } catch (closeError) {
    throw new AggregateError([failure, closeError], message, { cause: closeError });
  }
  throw failure;
}

async function describeOpenedModalDocumentDirectory(
  lexicalPath: string,
  handle: FileHandle
): Promise<OpenedModalDocumentDirectory> {
  const identity = await handle.stat({ bigint: true });
  const lexical = await fs.promises.lstat(lexicalPath, { bigint: true });
  if (
    !identity.isDirectory() ||
    !lexical.isDirectory() ||
    lexical.isSymbolicLink() ||
    !sameModalDocumentIdentity(identity, lexical)
  ) {
    throw new Error("Modal document parent changed while it was opened");
  }
  const accessPath = await modalDocumentDirectoryDescriptorPath(handle.fd, identity);
  return { lexicalPath, accessPath, handle, identity };
}

async function modalDocumentDirectoryDescriptorPath(descriptor: number, expected: fs.BigIntStats): Promise<string> {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const accessed = await fs.promises.stat(candidate, { bigint: true });
      if (accessed.isDirectory() && sameModalDocumentIdentity(expected, accessed)) return candidate;
    } catch {
      // Try the next descriptor filesystem. Publication has no pathname fallback.
    }
  }
  throw new Error("Modal document parent has no verifiable descriptor anchor");
}

async function assertModalDocumentDirectoryChainCurrent(
  root: string,
  directories: readonly OpenedModalDocumentDirectory[]
): Promise<void> {
  const parent = directories.at(-1);
  if (parent === undefined) throw new Error("Modal document parent descriptor chain is empty");
  assertNoSymlinkComponents(root, parent.lexicalPath, "Modal document parent");
  if (fs.realpathSync.native(root) !== root || fs.realpathSync.native(parent.lexicalPath) !== parent.lexicalPath) {
    throw new Error("Modal document parent is no longer canonical");
  }
  for (const directory of directories) {
    const held = await directory.handle.stat({ bigint: true });
    const accessed = await fs.promises.stat(directory.accessPath, { bigint: true });
    const lexical = await fs.promises.lstat(directory.lexicalPath, { bigint: true });
    if (
      !held.isDirectory() ||
      !accessed.isDirectory() ||
      !lexical.isDirectory() ||
      lexical.isSymbolicLink() ||
      !sameModalDocumentIdentity(directory.identity, held) ||
      !sameModalDocumentIdentity(directory.identity, accessed) ||
      !sameModalDocumentIdentity(directory.identity, lexical)
    ) {
      throw new Error("Modal document parent changed during descriptor ownership");
    }
  }
}

async function readSafeModalDocumentTarget(
  root: string,
  lexicalPath: string,
  accessPath: string
): Promise<fs.BigIntStats | undefined> {
  assertNoSymlinkComponents(root, lexicalPath, "Modal document target");
  const accessed = await lstatModalDocumentPath(accessPath);
  const lexical = await lstatModalDocumentPath(lexicalPath);
  if (accessed === undefined || lexical === undefined) {
    if (accessed === undefined && lexical === undefined) return undefined;
    throw new Error("Modal document target changed while it was inspected");
  }
  if (
    accessed.isSymbolicLink() ||
    lexical.isSymbolicLink() ||
    !accessed.isFile() ||
    !lexical.isFile() ||
    accessed.nlink !== 1n ||
    lexical.nlink !== 1n ||
    !sameModalDocumentIdentity(accessed, lexical)
  ) {
    throw new Error("Modal document target must be a physical single-link regular file");
  }
  return accessed;
}

async function assertModalDocumentTargetUnchanged(
  root: string,
  lexicalPath: string,
  accessPath: string,
  expected: fs.BigIntStats | undefined
): Promise<void> {
  const current = await readSafeModalDocumentTarget(root, lexicalPath, accessPath);
  if (
    (expected === undefined && current !== undefined) ||
    (expected !== undefined && (current === undefined || !sameModalDocumentIdentity(expected, current)))
  ) {
    throw new Error("Modal document target changed before atomic publication");
  }
}

function assertPreparedModalDocumentFile(
  candidate: fs.BigIntStats,
  byteLength: number,
  identity: fs.BigIntStats = candidate
): void {
  if (
    !candidate.isFile() ||
    candidate.isSymbolicLink() ||
    candidate.nlink !== 1n ||
    (candidate.mode & 0o777n) !== 0o600n ||
    candidate.size !== BigInt(byteLength) ||
    !sameModalDocumentIdentity(identity, candidate)
  ) {
    throw new Error("Modal document temporary file is not a stable private regular file");
  }
}

async function assertPublishedModalDocument(
  root: string,
  lexicalPath: string,
  accessPath: string,
  expected: fs.BigIntStats,
  byteLength: number
): Promise<void> {
  assertNoSymlinkComponents(root, lexicalPath, "Modal document target");
  const accessed = await fs.promises.lstat(accessPath, { bigint: true });
  const lexical = await fs.promises.lstat(lexicalPath, { bigint: true });
  assertPreparedModalDocumentFile(accessed, byteLength, expected);
  assertPreparedModalDocumentFile(lexical, byteLength, expected);
}

async function assertOpenedModalDocumentBytes(
  handle: FileHandle,
  expected: fs.BigIntStats,
  byteLength: number,
  expectedSha256: string
): Promise<void> {
  const before = await handle.stat({ bigint: true });
  assertPreparedModalDocumentFile(before, byteLength, expected);
  const digest = crypto.createHash("sha256");
  let offset = 0;
  while (offset < byteLength) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, byteLength - offset));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
    if (bytesRead <= 0) throw new Error("Modal document file changed while its persisted bytes were verified");
    digest.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  assertPreparedModalDocumentFile(after, byteLength, expected);
  if (digest.digest("hex") !== expectedSha256) {
    throw new Error("Modal document persisted bytes differ from the validated snapshot");
  }
}

async function unlinkOwnedModalDocumentPath(filePath: string, expected: fs.BigIntStats): Promise<boolean> {
  const current = await lstatModalDocumentPath(filePath);
  if (current === undefined) return false;
  if (!current.isFile() || current.isSymbolicLink() || !sameModalDocumentIdentity(expected, current)) {
    throw new Error("Modal document cleanup path was replaced before it could be removed");
  }
  await fs.promises.unlink(filePath);
  return true;
}

async function lstatModalDocumentPath(filePath: string): Promise<fs.BigIntStats | undefined> {
  try {
    return await fs.promises.lstat(filePath, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameModalDocumentIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry, seen);
  return value;
}
