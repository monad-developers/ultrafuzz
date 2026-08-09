import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createGzip } from "node:zlib";

import tar, { type Headers } from "tar-stream";

const ARCHIVE_EPOCH = new Date(0);
const GZIP_HEADER_BYTES = 10;

interface ArchiveEntry {
  readonly absolutePath: string;
  readonly archivePath: string;
  readonly kind: "directory" | "file";
}

/**
 * Write one canonical tar+gzip representation of a safe directory tree.
 * Filesystem timestamps, ownership, traversal order, and host tar defaults are
 * deliberately excluded from the resulting bytes.
 */
export async function writeDeterministicTarGzip(rootPath: string, outputPath: string): Promise<void> {
  const root = fs.realpathSync(path.resolve(rootPath));
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("deterministic archive root must be a regular directory");
  }
  const entries = collectEntries(root);
  const pack = tar.pack();
  const gzip = createGzip({
    level: 9,
    windowBits: 15,
    memLevel: 8,
    strategy: zlibConstants.Z_DEFAULT_STRATEGY
  });
  const output = fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const completion = pipeline(pack, gzip, output);

  try {
    await addDirectoryEntry(pack, "./");
    for (const entry of entries) {
      if (entry.kind === "directory") {
        await addDirectoryEntry(pack, entry.archivePath);
      } else {
        await addFileEntry(pack, root, entry);
      }
    }
    pack.finalize();
    await completion;
    normalizeGzipHeader(outputPath);
  } catch (error) {
    pack.destroy(error instanceof Error ? error : new Error(String(error)));
    gzip.destroy();
    output.destroy();
    await completion.catch(() => undefined);
    fs.rmSync(outputPath, { force: true });
    throw error;
  }
}

function collectEntries(root: string): readonly ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    const children = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareNames(left.name, right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const relativePath = relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
        throw new Error("deterministic archive excludes links, hard links, and special files");
      }
      if (child.isDirectory() && stat.isDirectory()) {
        entries.push({ absolutePath, archivePath: `./${relativePath}/`, kind: "directory" });
        visit(absolutePath, relativePath);
      } else if (child.isFile() && stat.isFile()) {
        entries.push({ absolutePath, archivePath: `./${relativePath}`, kind: "file" });
      } else {
        throw new Error("deterministic archive entry changed while it was inspected");
      }
    }
  };
  visit(root, "");
  return entries;
}

async function addDirectoryEntry(pack: ReturnType<typeof tar.pack>, archivePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    pack.entry(canonicalHeader(archivePath, "directory", 0o700, 0), (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

async function addFileEntry(pack: ReturnType<typeof tar.pack>, root: string, entry: ArchiveEntry): Promise<void> {
  const lexicalBefore = fs.lstatSync(entry.absolutePath, { bigint: true });
  const descriptor = fs.openSync(entry.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1n ||
      !sameFileIdentity(lexicalBefore, openedBefore) ||
      !entry.absolutePath.startsWith(`${root}${path.sep}`)
    ) {
      throw new Error("deterministic archive file is unsafe");
    }
    const mode = (Number(openedBefore.mode) & 0o111) === 0 ? 0o600 : 0o700;
    const sink = pack.entry(canonicalHeader(entry.archivePath, "file", mode, Number(openedBefore.size)));
    await pipeline(fs.createReadStream(entry.absolutePath, { fd: descriptor, autoClose: false }), sink);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const lexicalAfter = fs.lstatSync(entry.absolutePath, { bigint: true });
    if (
      !sameStableFile(openedBefore, openedAfter) ||
      !sameFileIdentity(openedAfter, lexicalAfter) ||
      !sameStableFile(lexicalBefore, lexicalAfter)
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

function normalizeGzipHeader(outputPath: string): void {
  const descriptor = fs.openSync(outputPath, "r+");
  try {
    const header = Buffer.alloc(GZIP_HEADER_BYTES);
    if (
      fs.readSync(descriptor, header, 0, header.length, 0) !== header.length ||
      header[0] !== 0x1f ||
      header[1] !== 0x8b
    ) {
      throw new Error("deterministic archive did not produce a valid gzip stream");
    }
    header.fill(0, 4, 8);
    header[9] = 0xff;
    fs.writeSync(descriptor, header, 0, header.length, 0);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
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
