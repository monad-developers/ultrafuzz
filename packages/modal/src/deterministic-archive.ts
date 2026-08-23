import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createGzip } from "node:zlib";

import tar, { type Headers } from "tar-stream";

const ARCHIVE_EPOCH = new Date(0);
const GZIP_HEADER_BYTES = 10;

interface ArchiveEntry {
  readonly archivePath: string;
  readonly accessPath: string;
  readonly stat: fs.BigIntStats;
}

/**
 * Write one canonical tar+gzip representation of a safe directory tree.
 * Filesystem timestamps, ownership, traversal order, and host tar defaults are
 * deliberately excluded from the resulting bytes.
 */
export async function writeDeterministicTarGzip(rootPath: string, outputPath: string): Promise<void> {
  const root = path.resolve(rootPath);
  const requestedOutput = path.resolve(outputPath);
  const outputParent = fs.realpathSync(path.dirname(requestedOutput));
  const outputName = path.basename(requestedOutput);
  const resolvedOutput = path.join(outputParent, outputName);
  const rootLexical = fs.lstatSync(root, { bigint: true });
  if (!rootLexical.isDirectory() || rootLexical.isSymbolicLink() || fs.realpathSync(root) !== root) {
    throw new Error("deterministic archive root must be a regular directory");
  }
  const outputParentLexical = fs.lstatSync(outputParent, { bigint: true });
  if (!outputParentLexical.isDirectory() || outputParentLexical.isSymbolicLink()) {
    throw new Error("deterministic archive output parent must be a regular directory");
  }
  const outputRelativeToRoot = path.relative(root, resolvedOutput);
  if (
    outputRelativeToRoot === "" ||
    (!path.isAbsolute(outputRelativeToRoot) &&
      outputRelativeToRoot !== ".." &&
      !outputRelativeToRoot.startsWith(`..${path.sep}`))
  ) {
    throw new Error("deterministic archive output must remain outside the archive root");
  }
  const rootDescriptor = fs.openSync(
    root,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
  );
  let outputParentDescriptor: number | undefined;
  let outputParentOpened: fs.BigIntStats | undefined;
  let outputAccessPath: string | undefined;
  let pack: ReturnType<typeof tar.pack> | undefined;
  let gzip: ReturnType<typeof createGzip> | undefined;
  let outputDescriptor: number | undefined;
  let outputIdentity: fs.BigIntStats | undefined;
  let output: fs.WriteStream | undefined;
  let completion: Promise<void> | undefined;

  try {
    const rootOpened = fs.fstatSync(rootDescriptor, { bigint: true });
    if (!rootOpened.isDirectory() || !sameFileIdentity(rootLexical, rootOpened)) {
      throw new Error("deterministic archive root changed while it was opened");
    }
    outputParentDescriptor = fs.openSync(
      outputParent,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
    );
    outputParentOpened = fs.fstatSync(outputParentDescriptor, { bigint: true });
    if (!outputParentOpened.isDirectory() || !sameFileIdentity(outputParentLexical, outputParentOpened)) {
      throw new Error("deterministic archive output parent changed while it was opened");
    }
    outputAccessPath = path.join(openedDirectoryPath(outputParentDescriptor, outputParentOpened), outputName);
    outputDescriptor = fs.openSync(
      outputAccessPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
    outputIdentity = fs.fstatSync(outputDescriptor, { bigint: true });
    pack = tar.pack();
    gzip = createGzip({
      level: 9,
      windowBits: 15,
      memLevel: 8,
      strategy: zlibConstants.Z_DEFAULT_STRATEGY
    });
    output = fs.createWriteStream(outputAccessPath, { fd: outputDescriptor, autoClose: false });
    completion = pipeline(pack, gzip, output);
    void completion.catch(() => undefined);
    await addDirectoryEntry(pack, "./");
    await addDirectoryContents(pack, rootDescriptor, rootOpened, "");
    pack.finalize();
    await completion;
    normalizeGzipHeader(outputDescriptor);
    assertCurrentOutput({
      descriptor: outputDescriptor,
      expected: outputIdentity,
      accessPath: outputAccessPath,
      requestedPath: requestedOutput,
      parentDescriptor: outputParentDescriptor,
      parentExpected: outputParentOpened,
      parentPath: outputParent
    });
  } catch (error) {
    pack?.destroy();
    gzip?.destroy();
    output?.destroy();
    await completion?.catch(() => undefined);
    if (outputIdentity !== undefined && outputAccessPath !== undefined) {
      removeCreatedOutput(outputAccessPath, outputIdentity);
    }
    throw error;
  } finally {
    if (outputDescriptor !== undefined) closeDescriptor(outputDescriptor);
    if (outputParentDescriptor !== undefined) closeDescriptor(outputParentDescriptor);
    closeDescriptor(rootDescriptor);
  }
}

function removeCreatedOutput(outputPath: string, expected: fs.BigIntStats): void {
  try {
    const current = fs.lstatSync(outputPath, { bigint: true });
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      sameFileIdentity(expected, current) &&
      expected.birthtimeNs === current.birthtimeNs
    ) {
      fs.unlinkSync(outputPath);
    }
  } catch {
    // Cleanup is best effort. In particular, never unlink a path that no
    // longer identifies the file this invocation exclusively created.
  }
}

async function addDirectoryContents(
  pack: ReturnType<typeof tar.pack>,
  descriptor: number,
  openedBefore: fs.BigIntStats,
  relativeDirectory: string
): Promise<void> {
  const accessRoot = openedDirectoryPath(descriptor, openedBefore);
  const children = fs
    .readdirSync(accessRoot, { withFileTypes: true })
    .sort((left, right) => compareNames(left.name, right.name));
  for (const child of children) {
    const relativePath = relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
    const accessPath = path.join(accessRoot, child.name);
    const stat = fs.lstatSync(accessPath, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1n)) {
      throw new Error("deterministic archive excludes links, hard links, and special files");
    }
    if (child.isDirectory() && stat.isDirectory()) {
      await addDirectoryEntry(pack, `./${relativePath}/`);
      await addOpenedDirectory(pack, { archivePath: `./${relativePath}/`, accessPath, stat }, relativePath);
    } else if (child.isFile() && stat.isFile()) {
      await addFileEntry(pack, { archivePath: `./${relativePath}`, accessPath, stat });
    } else {
      throw new Error("deterministic archive entry changed while it was inspected");
    }
  }
  const openedAfter = fs.fstatSync(descriptor, { bigint: true });
  if (!sameStableFile(openedBefore, openedAfter)) {
    throw new Error("deterministic archive directory changed while it was read");
  }
}

async function addOpenedDirectory(
  pack: ReturnType<typeof tar.pack>,
  entry: ArchiveEntry,
  relativeDirectory: string
): Promise<void> {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      entry.accessPath,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
    );
  } catch (error) {
    throw new Error("deterministic archive directory changed while it was opened", { cause: error });
  }
  try {
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!openedBefore.isDirectory() || !sameFileIdentity(entry.stat, openedBefore)) {
      throw new Error("deterministic archive directory changed while it was opened");
    }
    await addDirectoryContents(pack, descriptor, openedBefore, relativeDirectory);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const lexicalAfter = fs.lstatSync(entry.accessPath, { bigint: true });
    if (
      !lexicalAfter.isDirectory() ||
      lexicalAfter.isSymbolicLink() ||
      !sameStableFile(openedBefore, openedAfter) ||
      !sameFileIdentity(openedAfter, lexicalAfter) ||
      !sameStableFile(entry.stat, lexicalAfter)
    ) {
      throw new Error("deterministic archive directory changed while it was traversed");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

async function addDirectoryEntry(pack: ReturnType<typeof tar.pack>, archivePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    pack.entry(canonicalHeader(archivePath, "directory", 0o700, 0), (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

async function addFileEntry(pack: ReturnType<typeof tar.pack>, entry: ArchiveEntry): Promise<void> {
  const descriptor = fs.openSync(
    entry.accessPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
  );
  try {
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1n ||
      openedBefore.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      !sameFileIdentity(entry.stat, openedBefore)
    ) {
      throw new Error("deterministic archive file is unsafe");
    }
    const mode = (Number(openedBefore.mode) & 0o111) === 0 ? 0o600 : 0o700;
    const sink = pack.entry(canonicalHeader(entry.archivePath, "file", mode, Number(openedBefore.size)));
    await pipeline(fs.createReadStream(entry.accessPath, { fd: descriptor, autoClose: false }), sink);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const lexicalAfter = fs.lstatSync(entry.accessPath, { bigint: true });
    if (
      !sameStableFile(openedBefore, openedAfter) ||
      !sameFileIdentity(openedAfter, lexicalAfter) ||
      !sameStableFile(entry.stat, lexicalAfter)
    ) {
      throw new Error("deterministic archive file changed while it was read");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function canonicalHeader(name: string, type: "directory" | "file", mode: number, size: number): Headers {
  return {
    name,
    type,
    mode,
    size,
    mtime: ARCHIVE_EPOCH,
    uid: 0,
    gid: 0,
    uname: "",
    gname: ""
  };
}

function normalizeGzipHeader(descriptor: number): void {
  const header = Buffer.alloc(GZIP_HEADER_BYTES);
  if (!readExactly(descriptor, header, 0) || header[0] !== 0x1f || header[1] !== 0x8b) {
    throw new Error("deterministic archive did not produce a valid gzip stream");
  }
  header.fill(0, 4, 8);
  header[9] = 0xff;
  writeExactly(descriptor, header, 0);
  fs.fsyncSync(descriptor);
}

function assertCurrentOutput(input: {
  readonly descriptor: number;
  readonly expected: fs.BigIntStats;
  readonly accessPath: string;
  readonly requestedPath: string;
  readonly parentDescriptor: number;
  readonly parentExpected: fs.BigIntStats;
  readonly parentPath: string;
}): void {
  const openedBefore = fs.fstatSync(input.descriptor, { bigint: true });
  const accessCurrent = fs.lstatSync(input.accessPath, { bigint: true });
  const requestedCurrent = fs.lstatSync(input.requestedPath, { bigint: true });
  const parentOpened = fs.fstatSync(input.parentDescriptor, { bigint: true });
  const parentCurrent = fs.lstatSync(input.parentPath, { bigint: true });
  const openedAfter = fs.fstatSync(input.descriptor, { bigint: true });
  if (
    !openedAfter.isFile() ||
    accessCurrent.isSymbolicLink() ||
    requestedCurrent.isSymbolicLink() ||
    !parentOpened.isDirectory() ||
    !parentCurrent.isDirectory() ||
    parentCurrent.isSymbolicLink() ||
    !sameFileIdentity(input.expected, openedAfter) ||
    !sameStableFile(openedBefore, openedAfter) ||
    !sameStableFile(openedAfter, accessCurrent) ||
    !sameStableFile(openedAfter, requestedCurrent) ||
    !sameFileIdentity(input.parentExpected, parentOpened) ||
    !sameFileIdentity(parentOpened, parentCurrent)
  ) {
    throw new Error("deterministic archive output changed while it was written");
  }
}

function readExactly(descriptor: number, buffer: Buffer, position: number): boolean {
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, position + offset);
    if (read === 0) return false;
    offset += read;
  }
  return true;
}

function writeExactly(descriptor: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(descriptor, buffer, offset, buffer.length - offset, position + offset);
    if (written === 0) throw new Error("deterministic archive could not normalize its gzip header");
    offset += written;
  }
}

function openedDirectoryPath(descriptor: number, expected: fs.BigIntStats): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const current = fs.statSync(candidate, { bigint: true });
      if (current.isDirectory() && sameFileIdentity(current, expected)) return candidate;
    } catch {
      // Try the next descriptor filesystem alias.
    }
  }
  throw new Error("deterministic archive requires a current descriptor-rooted directory path");
}

function closeDescriptor(descriptor: number): void {
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error;
  }
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink;
}

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
