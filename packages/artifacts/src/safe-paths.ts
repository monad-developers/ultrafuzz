import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ArtifactPathError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArtifactPathError";
    this.code = code;
  }
}

export function validateSafeId(value: string, label = "id"): string {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new ArtifactPathError(
      "unsafe-id",
      `${label} must match ${SAFE_ID_PATTERN.source}; received ${JSON.stringify(value)}`
    );
  }
  if (value === "." || value === "..") {
    throw new ArtifactPathError("unsafe-id", `${label} cannot be ${value}`);
  }
  return value;
}

export function normalizeSafeRelativePath(value: string, label = "artifact path"): string {
  if (value.length === 0) {
    throw new ArtifactPathError("empty-path", `${label} cannot be empty`);
  }
  if (value.includes("\0")) {
    throw new ArtifactPathError("nul-byte", `${label} cannot contain NUL bytes`);
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new ArtifactPathError("absolute-path", `${label} must be relative`);
  }
  if (value.includes("\\")) {
    throw new ArtifactPathError("backslash-path", `${label} must use forward slashes`);
  }

  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new ArtifactPathError("path-traversal", `${label} cannot traverse outside its root`);
  }
  if (normalized.startsWith("/")) {
    throw new ArtifactPathError("absolute-path", `${label} must be relative`);
  }

  for (const segment of normalized.split("/")) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":") ||
      !SAFE_PATH_SEGMENT_PATTERN.test(segment)
    ) {
      throw new ArtifactPathError("unsafe-path-segment", `${label} contains unsafe segment ${JSON.stringify(segment)}`);
    }
  }
  return normalized;
}

export function assertPathInside(root: string, candidate: string, label = "path"): void {
  const rootAbsolute = path.resolve(root);
  const candidateAbsolute = path.resolve(candidate);
  const relative = path.relative(rootAbsolute, candidateAbsolute);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new ArtifactPathError("path-escape", `${label} escapes ${rootAbsolute}`);
}

export function assertNoSymlinkComponents(root: string, candidate: string, label = "path"): void {
  const rootAbsolute = path.resolve(root);
  const candidateAbsolute = path.resolve(candidate);
  assertPathInside(rootAbsolute, candidateAbsolute, label);
  if (!fs.existsSync(rootAbsolute)) {
    throw new ArtifactPathError("missing-root", `${label} root does not exist: ${rootAbsolute}`);
  }
  if (fs.lstatSync(rootAbsolute).isSymbolicLink()) {
    throw new ArtifactPathError("symlink-root", `${label} root cannot be a symlink`);
  }

  const relative = path.relative(rootAbsolute, candidateAbsolute);
  if (relative === "") {
    return;
  }

  let current = rootAbsolute;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      return;
    }
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new ArtifactPathError("symlink-escape", `${label} crosses symlink ${current}`);
    }
  }
}

export function safeResolveInside(root: string, relativePath: string, label = "artifact path"): string {
  const normalized = normalizeSafeRelativePath(relativePath, label);
  const rootAbsolute = path.resolve(root);
  const candidate = path.resolve(rootAbsolute, ...normalized.split("/"));
  assertPathInside(rootAbsolute, candidate, label);
  assertNoSymlinkEscape(rootAbsolute, path.dirname(candidate), label);
  return candidate;
}

export function assertRegularFileInside(root: string, filePath: string, label = "file path"): void {
  const rootAbsolute = path.resolve(root);
  const fileAbsolute = path.resolve(filePath);
  assertPathInside(rootAbsolute, fileAbsolute, label);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(fileAbsolute);
  } catch {
    throw new ArtifactPathError("missing-file", `${label} does not exist: ${fileAbsolute}`);
  }
  if (stat.isSymbolicLink()) {
    throw new ArtifactPathError("symlink-escape", `${label} cannot be a symlink: ${fileAbsolute}`);
  }
  if (!stat.isFile()) {
    throw new ArtifactPathError("not-file", `${label} must be a regular file: ${fileAbsolute}`);
  }
  assertNoSymlinkEscape(rootAbsolute, path.dirname(fileAbsolute), label);
  assertRealPathInside(rootAbsolute, fileAbsolute, label);
}

export function ensureSafeDirectory(root: string, relativePath = "."): string {
  const rootAbsolute = path.resolve(root);
  const directory =
    relativePath === "." ? rootAbsolute : safeResolveInside(rootAbsolute, relativePath, "directory path");
  fs.mkdirSync(directory, { recursive: true });
  assertNoSymlinkEscape(rootAbsolute, directory, "directory path");
  assertRealPathInside(rootAbsolute, directory, "directory path");
  return directory;
}

export function prepareSafeFilePath(root: string, relativePath: string): string {
  const filePath = safeResolveInside(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertNoSymlinkEscape(path.resolve(root), path.dirname(filePath), "artifact path");
  assertRealPathInside(path.resolve(root), path.dirname(filePath), "artifact path");
  return filePath;
}

export function toPosixRelativePath(root: string, candidate: string): string {
  assertPathInside(root, candidate);
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return normalizeSafeRelativePath(relative.split(path.sep).join("/"));
}

export function writeFileDurable(filePath: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
  );
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
  fsyncDirectory(path.dirname(filePath));
}

export interface DurablePublicationResult {
  path: string;
  sha256: string;
  created: boolean;
}

/**
 * Publishes already-validated bytes without replacing an existing canonical
 * artifact. Hard-link-capable filesystems get an atomic publication boundary;
 * filesystems that reject hard links get a durable O_EXCL descriptor write.
 * A concurrent publisher is accepted only when it wrote the exact same bytes.
 */
export function publishFileDurableExclusive(
  root: string,
  relativePath: string,
  data: string | Uint8Array
): DurablePublicationResult {
  const rootAbsolute = fs.realpathSync(root);
  const destinationCandidate = prepareSafeFilePath(rootAbsolute, relativePath);
  const destinationDirectory = fs.realpathSync(path.dirname(destinationCandidate));
  assertPathInside(rootAbsolute, destinationDirectory, "published artifact directory");
  const destination = path.join(destinationDirectory, path.basename(destinationCandidate));
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const digest = sha256Bytes(bytes);

  if (fs.existsSync(destination)) {
    assertPublishedBytes(rootAbsolute, destination, bytes);
    return { path: destination, sha256: digest, created: false };
  }

  const temporary = path.join(
    destinationDirectory,
    `.${path.basename(destination)}.publish-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
  );
  let temporaryFd: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let linked = false;
  try {
    temporaryFd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600
    );
    temporaryIdentity = fileIdentity(fs.fstatSync(temporaryFd, { bigint: true }));
    fs.writeFileSync(temporaryFd, bytes);
    fs.fsyncSync(temporaryFd);
    const descriptor = temporaryFd;
    temporaryFd = undefined;
    fs.closeSync(descriptor);

    try {
      fs.linkSync(temporary, destination);
      linked = true;
    } catch (error) {
      if (isUnsupportedHardLinkError(error)) {
        const created = publishFileDurableWithoutHardLink(rootAbsolute, destination, bytes);
        return { path: destination, sha256: digest, created };
      }
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      assertPublishedBytes(rootAbsolute, destination, bytes);
      return { path: destination, sha256: digest, created: false };
    }

    assertPublishedBytes(rootAbsolute, destination, bytes, temporaryIdentity);
    return { path: destination, sha256: digest, created: true };
  } catch (error) {
    if (linked && temporaryIdentity !== undefined && !unlinkPublishedIfOwned(destination, temporaryIdentity)) {
      throw new Error("failed to remove an incomplete published artifact", { cause: error });
    }
    throw error;
  } finally {
    if (temporaryFd !== undefined) {
      const descriptor = temporaryFd;
      fs.closeSync(descriptor);
    }
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary);
    }
    fsyncDirectory(destinationDirectory);
  }
}

function publishFileDurableWithoutHardLink(root: string, filePath: string, bytes: Buffer): boolean {
  let fd: number | undefined;
  let identity: FileIdentity | undefined;
  try {
    try {
      fd = fs.openSync(
        filePath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
        0o600
      );
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      assertPublishedBytes(root, filePath, bytes);
      return false;
    }
    identity = fileIdentity(fs.fstatSync(fd, { bigint: true }));
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    const descriptor = fd;
    fd = undefined;
    fs.closeSync(descriptor);
    assertPublishedBytes(root, filePath, bytes, identity);
    return true;
  } catch (error) {
    if (fd !== undefined) {
      const descriptor = fd;
      fd = undefined;
      fs.closeSync(descriptor);
    }
    if (identity !== undefined && !unlinkPublishedIfOwned(filePath, identity)) {
      throw new Error("failed to remove an incomplete published artifact", { cause: error });
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      const descriptor = fd;
      fs.closeSync(descriptor);
    }
  }
}

export function writeJsonDurable(filePath: string, value: unknown): void {
  writeFileDurable(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendLineDurable(filePath: string, line: string, trustedRoot?: string): void {
  appendBytesDurable(filePath, Buffer.from(line.endsWith("\n") ? line : `${line}\n`, "utf8"), trustedRoot);
}

export function appendBytesDurable(filePath: string, bytes: Uint8Array, trustedRoot?: string): void {
  const directory = path.dirname(filePath);
  if (trustedRoot !== undefined) {
    assertNoSymlinkComponents(trustedRoot, directory, "append directory");
  }
  fs.mkdirSync(directory, { recursive: true });
  if (trustedRoot !== undefined) {
    assertNoSymlinkComponents(trustedRoot, filePath, "append path");
  }
  const fd = fs.openSync(
    filePath,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new ArtifactPathError("not-file", `append path must be a regular file: ${filePath}`);
    }
    if (trustedRoot !== undefined) {
      assertNoSymlinkComponents(trustedRoot, filePath, "append path");
    }
    const contents = Buffer.from(bytes);
    let offset = 0;
    while (offset < contents.length) {
      const written = fs.writeSync(fd, contents, offset, contents.length - offset);
      if (written <= 0) throw new Error(`append write made no progress: ${filePath}`);
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(directory);
}

/**
 * Durably drops everything past `length`. Used to discard a torn trailing record
 * left by a process that died mid-append: such a fragment was never a complete
 * line, so no reader can have treated it as durable evidence.
 */
export function truncateDurable(filePath: string, length: number, trustedRoot?: string): void {
  if (trustedRoot !== undefined) {
    assertNoSymlinkComponents(trustedRoot, filePath, "truncate path");
  }
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new ArtifactPathError("not-file", `truncate path must be a regular file: ${filePath}`);
    }
    fs.ftruncateSync(fd, length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(filePath));
}

export function readJsonFile<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function sha256Bytes(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function sha256File(filePath: string): string {
  return sha256Bytes(fs.readFileSync(filePath));
}

export interface SafeFileEntry {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
}

export function listSafeFiles(
  root: string,
  options: {
    exclude?: (relativePath: string, absolutePath: string) => boolean;
  } = {}
): SafeFileEntry[] {
  const rootAbsolute = path.resolve(root);
  assertNoSymlinkEscape(rootAbsolute, rootAbsolute, "artifact root");
  const entries: SafeFileEntry[] = [];

  function walk(directory: string): void {
    assertNoSymlinkEscape(rootAbsolute, directory, "artifact path");
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, dirent.name);
      const relativePath = toPosixRelativePath(rootAbsolute, absolutePath);
      if (dirent.isSymbolicLink()) {
        throw new ArtifactPathError("symlink-escape", `artifact path contains symlink ${relativePath}`);
      }
      if (options.exclude?.(relativePath, absolutePath)) {
        continue;
      }
      if (dirent.isDirectory()) {
        walk(absolutePath);
      } else if (dirent.isFile()) {
        entries.push({
          relativePath,
          absolutePath,
          sizeBytes: fs.statSync(absolutePath).size
        });
      }
    }
  }

  if (fs.existsSync(rootAbsolute)) {
    walk(rootAbsolute);
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function assertNoSymlinkEscape(root: string, candidate: string, label: string): void {
  const rootAbsolute = path.resolve(root);
  const candidateAbsolute = path.resolve(candidate);
  assertPathInside(rootAbsolute, candidateAbsolute, label);
  if (!fs.existsSync(rootAbsolute)) {
    return;
  }
  assertNoSymlinkComponents(rootAbsolute, candidateAbsolute, label);
}

function assertRealPathInside(root: string, candidate: string, label: string): void {
  if (!fs.existsSync(root) || !fs.existsSync(candidate)) {
    return;
  }
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  assertPathInside(realRoot, realCandidate, label);
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

function fileIdentity(stat: fs.BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(left: FileIdentity, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPublishedBytes(root: string, filePath: string, expected: Buffer, expectedIdentity?: FileIdentity): void {
  assertRegularFileInside(root, filePath, "published artifact");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const descriptorStat = fs.fstatSync(fd, { bigint: true });
    const pathStat = fs.statSync(filePath, { bigint: true });
    if (
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino ||
      (expectedIdentity !== undefined && !sameFileIdentity(expectedIdentity, descriptorStat))
    ) {
      throw new ArtifactPathError(
        "published-file-changed",
        `published artifact changed during validation: ${filePath}`
      );
    }
    assertRegularFileInside(root, filePath, "published artifact");
    if (!fs.readFileSync(fd).equals(expected)) {
      throw new ArtifactPathError(
        "existing-file-conflict",
        `published artifact already exists with different contents: ${filePath}`
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

function unlinkPublishedIfOwned(filePath: string, identity: FileIdentity): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const beforeUnlink = fs.fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(identity, beforeUnlink)) return true;
    fs.unlinkSync(filePath);
    // A replacement between the identity check and unlink would remove a
    // different inode and leave this descriptor's link count unchanged.
    return fs.fstatSync(fd, { bigint: true }).nlink < beforeUnlink.nlink;
  } catch (error) {
    return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isUnsupportedHardLinkError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code))
  );
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is best effort on filesystems that do not expose it.
  }
}
