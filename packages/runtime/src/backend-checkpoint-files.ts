import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const maxBytes = 512 * 1024 * 1024;
const maxEntries = 10_000;

export function assertCheckpointDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new Error("backend evidence checkpoint exceeded finalization deadline");
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertStableFile(before: fs.BigIntStats, after: fs.BigIntStats): void {
  if (
    !sameIdentity(before, after) ||
    !after.isFile() ||
    after.nlink !== 1n ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw new Error("backend checkpoint file changed while reading");
}

export function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function removeStagedFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!missingPath(error)) throw error;
  }
}

/**
 * All traversal and writes are relative to held directory descriptors, not
 * re-resolved task-writable paths. Fail closed where descriptor-relative paths
 * are unavailable; path checks alone cannot make a rename race safe.
 */
export class CheckpointDirectory {
  private constructor(
    readonly absolute: string,
    readonly fd: number
  ) {}

  static open(absolute: string, create = false): CheckpointDirectory {
    if (process.platform !== "linux")
      throw new Error("backend checkpoints require Linux descriptor-relative filesystem access");
    let current = new CheckpointDirectory("/", fs.openSync("/", directoryFlags));
    try {
      for (const segment of path.resolve(absolute).split("/").filter(Boolean)) {
        const child = current.child(segment, create);
        current.close();
        current = child;
      }
      current.assertCurrent();
      return current;
    } catch (error) {
      current.close();
      throw error;
    }
  }

  private entry(name: string): string {
    if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
      throw new Error("invalid backend checkpoint entry");
    }
    return `/proc/self/fd/${String(this.fd)}/${name}`;
  }

  assertCurrent(): void {
    if (
      fs.realpathSync(`/proc/self/fd/${String(this.fd)}`) !== this.absolute ||
      !sameIdentity(fs.fstatSync(this.fd, { bigint: true }), fs.lstatSync(this.absolute, { bigint: true }))
    ) {
      throw new Error("backend checkpoint directory changed while in use");
    }
  }

  child(name: string, create = false): CheckpointDirectory {
    this.assertCurrent();
    const entry = this.entry(name);
    if (create) {
      try {
        fs.mkdirSync(entry, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    const child = new CheckpointDirectory(path.join(this.absolute, name), fs.openSync(entry, directoryFlags));
    try {
      this.assertCurrent();
      child.assertCurrent();
      return child;
    } catch (error) {
      child.close();
      throw error;
    }
  }

  names(): string[] {
    this.assertCurrent();
    return fs.readdirSync(`/proc/self/fd/${String(this.fd)}`).sort();
  }

  stat(name: string): fs.BigIntStats | undefined {
    this.assertCurrent();
    try {
      return fs.lstatSync(this.entry(name), { bigint: true });
    } catch (error) {
      if (missingPath(error)) return undefined;
      throw error;
    }
  }

  read(name: string, limit = maxBytes): Buffer {
    this.assertCurrent();
    const fd = fs.openSync(this.entry(name), fileFlags);
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit))
        throw new Error("unsafe backend checkpoint file");
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) throw new Error("backend checkpoint file truncated while reading");
        offset += count;
      }
      assertStableFile(before, fs.fstatSync(fd, { bigint: true }));
      assertStableFile(before, fs.lstatSync(this.entry(name), { bigint: true }));
      this.assertCurrent();
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  }

  write(name: string, bytes: Uint8Array, deadline = Infinity): void {
    this.assertCurrent();
    assertCheckpointDeadline(deadline);
    const temporary = this.entry(`.staged-${randomUUID()}`);
    const fd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600
    );
    try {
      // Never truncate a destination inode: replace its directory entry. This
      // cannot follow dangling links or modify another name of a hardlink.
      let offset = 0;
      while (offset < bytes.length) {
        assertCheckpointDeadline(deadline);
        offset += fs.writeSync(fd, bytes, offset, Math.min(bytes.length - offset, 1024 * 1024));
      }
      fs.fsyncSync(fd);
      assertCheckpointDeadline(deadline);
      const before = fs.fstatSync(fd, { bigint: true });
      assertStableFile(before, fs.lstatSync(temporary, { bigint: true }));
      this.assertCurrent();
      fs.renameSync(temporary, this.entry(name));
      assertStableFile(fs.fstatSync(fd, { bigint: true }), fs.lstatSync(this.entry(name), { bigint: true }));
      this.assertCurrent();
      fs.fsyncSync(this.fd);
    } finally {
      fs.closeSync(fd);
      removeStagedFile(temporary);
    }
  }

  createLog(name: string): { write: (chunk: Buffer) => void; close: () => void } {
    this.assertCurrent();
    const fd = fs.openSync(
      this.entry(name),
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600
    );
    const initial = fs.fstatSync(fd, { bigint: true });
    const check = (): void => {
      this.assertCurrent();
      const current = fs.fstatSync(fd, { bigint: true });
      if (
        !sameIdentity(initial, current) ||
        current.nlink !== 1n ||
        !sameIdentity(current, fs.lstatSync(this.entry(name), { bigint: true }))
      )
        throw new Error("backend checkpoint log changed while writing");
    };
    return {
      write: (chunk) => {
        check();
        fs.writeSync(fd, chunk);
        check();
      },
      close: () => {
        try {
          check();
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    };
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

export function checkpointJson(directory: string, name: string, value: unknown): void {
  const root = CheckpointDirectory.open(directory);
  try {
    root.write(name, Buffer.from(`${JSON.stringify(value)}\n`));
  } finally {
    root.close();
  }
}

interface EvidenceEntry {
  path: string;
  sha256: string | null;
  size: number;
}
export type EvidenceManifest = readonly EvidenceEntry[];

/** Capture once into immutable buffers; authenticate these exact bytes before restoring. */
export function captureEvidence(root: CheckpointDirectory, deadline: number): Map<string, Buffer | null> {
  const files = new Map<string, Buffer | null>();
  let remaining = maxBytes;
  const walk = (directory: CheckpointDirectory, prefix: string): void => {
    const names = directory.names();
    for (const name of names) {
      assertCheckpointDeadline(deadline);
      if (files.size >= maxEntries) throw new Error("backend checkpoint evidence exceeds entry limit");
      const relative = `${prefix}${name}`;
      const stat = directory.stat(name);
      if (stat?.isDirectory() === true) {
        files.set(relative, null);
        const child = directory.child(name);
        try {
          walk(child, `${relative}/`);
        } finally {
          child.close();
        }
      } else {
        const bytes = directory.read(name, remaining);
        remaining -= bytes.length;
        files.set(relative, bytes);
      }
    }
    if (JSON.stringify(names) !== JSON.stringify(directory.names()))
      throw new Error("backend checkpoint inventory changed while reading");
  };
  walk(root, "");
  return files;
}

export function evidenceManifest(files: ReadonlyMap<string, Buffer | null>): EvidenceManifest {
  return [...files].map(([name, bytes]) => ({
    path: name,
    size: bytes?.length ?? 0,
    sha256: bytes === null ? null : createHash("sha256").update(bytes).digest("hex")
  }));
}

export function restoreEvidence(
  root: CheckpointDirectory,
  files: ReadonlyMap<string, Buffer | null>,
  deadline: number
): void {
  for (const [relative, bytes] of files) {
    assertCheckpointDeadline(deadline);
    const parts = relative.split("/");
    const name = parts.pop();
    if (name === undefined) throw new Error("invalid backend checkpoint path");
    let current = root;
    try {
      for (const part of parts) {
        const child = current.child(part, true);
        if (current !== root) current.close();
        current = child;
      }
      if (bytes === null) current.child(name, true).close();
      else current.write(name, bytes, deadline);
    } finally {
      if (current !== root) current.close();
    }
  }
}

export function snapshotBackendEvidence(source: string, target: CheckpointDirectory, deadline: number): void {
  const root = CheckpointDirectory.open(source);
  try {
    for (const name of ["backends", "campaign-plan.json"]) {
      const stat = root.stat(name);
      if (stat === undefined) continue;
      assertCheckpointDeadline(deadline);
      if (stat.isDirectory()) {
        const from = root.child(name);
        const to = target.child(name, true);
        try {
          restoreEvidence(to, captureEvidence(from, deadline), deadline);
        } finally {
          from.close();
          to.close();
        }
      } else target.write(name, root.read(name), deadline);
    }
  } finally {
    root.close();
  }
}
