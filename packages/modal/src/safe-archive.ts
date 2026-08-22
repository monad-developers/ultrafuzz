import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { createGunzip } from "node:zlib";

import tar from "tar-stream";

const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_ARCHIVE_IDLE_TIMEOUT_MS = 30_000;

export function sha256File(filePath: string): string {
  const descriptor = fs.openSync(filePath, "r");
  const digest = crypto.createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

export async function extractSafeTarArchive(
  archivePath: string,
  destination: string,
  options: { gzip: boolean; label: string; idleTimeoutMs?: number }
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_ARCHIVE_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error(`${options.label} archive idle timeout must be a positive integer`);
  }
  const root = fs.realpathSync(path.resolve(destination));
  const gunzip = options.gzip ? createGunzip() : undefined;
  const extract = tar.extract();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let entries = 0;
    let pendingEntries = 0;
    let extractFinished = false;
    let totalBytes = 0;
    let activeArchiveReader: ArchiveReader | undefined;
    const activeHandles = new Set<FileHandle>();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Set<string>();
    const clearIdleTimer = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      gunzip?.destroy();
      extract.destroy();
      if (activeArchiveReader !== undefined) {
        closeArchiveReaderBestEffort(activeArchiveReader);
        activeArchiveReader = undefined;
      }
      for (const handle of activeHandles) {
        closeFileHandleBestEffort(handle);
      }
      activeHandles.clear();
      reject(
        error instanceof Error ? error : new Error(`${options.label} archive extraction failed: ${String(error)}`)
      );
    };
    const recordProgress = () => {
      if (settled) return;
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        fail(new Error(`${options.label} archive extraction made no progress for ${idleTimeoutMs}ms`));
      }, idleTimeoutMs);
    };
    const completeIfReady = () => {
      if (settled || !extractFinished || pendingEntries !== 0 || activeArchiveReader !== undefined) return;
      settled = true;
      clearIdleTimer();
      resolve();
    };

    extract.on("entry", (header, stream, next) => {
      pendingEntries += 1;
      const completeEntry = () => {
        try {
          next();
          pendingEntries -= 1;
          completeIfReady();
        } catch (error) {
          fail(error);
        }
      };
      try {
        recordProgress();
        entries += 1;
        if (entries > MAX_ARCHIVE_ENTRIES) {
          throw new Error(`${options.label} archive contains too many entries`);
        }
        const relative = safeArchiveRelativePath(header.name, options.label);
        if (relative === undefined) {
          if (header.type !== "directory") {
            throw new Error(`${options.label} archive root entry must be a directory`);
          }
          stream.resume();
          stream.once("end", completeEntry);
          stream.once("error", fail);
          return;
        }
        if (seen.has(relative)) {
          throw new Error(`${options.label} archive contains duplicate path ${relative}`);
        }
        seen.add(relative);
        const target = path.resolve(root, ...relative.split("/"));
        assertArchiveTarget(root, target, options.label);

        if (header.type === "directory") {
          ensureDirectoryTarget(root, target, options.label);
          stream.resume();
          stream.once("end", completeEntry);
          stream.once("error", fail);
          return;
        }
        if (header.type !== "file") {
          throw new Error(`${options.label} archive contains unsupported ${header.type ?? "unknown"} entry`);
        }
        const declaredBytes = header.size ?? 0;
        if (declaredBytes > MAX_ARCHIVE_FILE_BYTES) {
          throw new Error(`${options.label} archive file exceeds the size limit`);
        }
        totalBytes += declaredBytes;
        if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
          throw new Error(`${options.label} archive exceeds the total size limit`);
        }
        ensureDirectoryTarget(root, path.dirname(target), options.label);
        if (fs.existsSync(target)) {
          throw new Error(`${options.label} archive would overwrite an existing path`);
        }
        let observedBytes = 0;
        void (async () => {
          const handle = await fs.promises.open(target, "wx", (header.mode ?? 0) & 0o111 ? 0o700 : 0o600);
          if (settled) {
            closeFileHandleBestEffort(handle);
            return;
          }
          activeHandles.add(handle);
          recordProgress();
          for await (const chunk of stream) {
            if (settled) return;
            const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            observedBytes += bytes.length;
            if (observedBytes > declaredBytes || observedBytes > MAX_ARCHIVE_FILE_BYTES) {
              throw new Error(`${options.label} archive file exceeds its declared size`);
            }
            let offset = 0;
            while (offset < bytes.length) {
              const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
              if (settled) return;
              if (bytesWritten === 0) {
                throw new Error(`${options.label} archive file write made no progress`);
              }
              offset += bytesWritten;
              recordProgress();
            }
          }
          if (settled) return;
          if (observedBytes === 0) {
            // Keep empty entries on Bun's FileHandle write lifecycle before close; open-then-close alone can stall.
            await handle.write(Buffer.alloc(0), 0, 0, null);
            if (settled) return;
            recordProgress();
          }
          if (observedBytes !== declaredBytes) {
            throw new Error(`${options.label} archive file size does not match its header`);
          }
          const close = handle.close();
          next();
          await close;
          activeHandles.delete(handle);
          if (settled) return;
          pendingEntries -= 1;
          recordProgress();
          completeIfReady();
        })().catch(fail);
      } catch (error) {
        stream.resume();
        fail(error);
      }
    });
    extract.once("finish", () => {
      extractFinished = true;
      completeIfReady();
    });
    extract.once("error", fail);
    gunzip?.once("error", fail);
    gunzip?.on("data", recordProgress);
    gunzip?.pipe(extract);
    void (async () => {
      const archiveReader = createArchiveReader(archivePath);
      activeArchiveReader = archiveReader;
      recordProgress();
      const input = gunzip ?? extract;
      let archiveBytes = 0;
      let current = await archiveReader.read();
      for (;;) {
        if (settled) return;
        if (current.done) {
          archiveReader.release();
          if (activeArchiveReader === archiveReader) activeArchiveReader = undefined;
          await endWritable(input);
          break;
        }
        if (current.value === undefined || current.value.byteLength === 0) {
          current = await archiveReader.read();
          continue;
        }
        const bytes = Buffer.from(current.value);
        archiveBytes += bytes.length;
        if (archiveReader.expectedBytes !== undefined && archiveBytes > archiveReader.expectedBytes) {
          throw new Error(`${options.label} archive grew while it was being extracted`);
        }
        recordProgress();
        const following = await archiveReader.read();
        if (settled) return;
        if (following.done) {
          if (archiveReader.expectedBytes !== undefined && archiveBytes !== archiveReader.expectedBytes) {
            throw new Error(`${options.label} archive size changed while it was being extracted`);
          }
          archiveReader.release();
          if (activeArchiveReader === archiveReader) activeArchiveReader = undefined;
          await endWritable(input, bytes);
          break;
        }
        await writeStreamChunk(input, bytes);
        if (settled) return;
        current = following;
      }
      if (settled) return;
      recordProgress();
      completeIfReady();
    })().catch(fail);
    recordProgress();
  });
}

interface ArchiveReader {
  expectedBytes?: number;
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  release(): void;
}

interface BunFileRuntime {
  file(filePath: string): { readonly size: number; stream(): ReadableStream<Uint8Array> };
}

function closeArchiveReaderBestEffort(reader: ArchiveReader): void {
  void reader.cancel().catch(() => undefined);
  try {
    reader.release();
  } catch {
    // Preserve the extraction result while the reader cancellation settles.
  }
}

function createArchiveReader(archivePath: string): ArchiveReader {
  const bun = (globalThis as typeof globalThis & { Bun?: BunFileRuntime }).Bun;
  if (bun !== undefined) {
    const file = bun.file(archivePath);
    const reader = file.stream().getReader();
    return {
      expectedBytes: file.size,
      read: () => reader.read(),
      cancel: async () => {
        await reader.cancel();
      },
      release: () => reader.releaseLock()
    };
  }
  const stream = fs.createReadStream(archivePath);
  const iterator = stream[Symbol.asyncIterator]();
  return {
    read: async () => {
      const result = await iterator.next();
      return result.done ? { done: true } : { done: false, value: Buffer.from(result.value) };
    },
    cancel: async () => {
      stream.destroy();
    },
    release: () => undefined
  };
}

function writeStreamChunk(stream: Writable, bytes: Buffer): Promise<void> {
  if (stream.write(bytes)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function endWritable(stream: Writable, finalBytes?: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (finalBytes === undefined) stream.end(resolve);
    else stream.end(finalBytes, resolve);
  });
}

function closeFileHandleBestEffort(handle: FileHandle): void {
  void handle.close().catch(() => {
    // Preserve the extraction error that caused cleanup.
  });
}

function safeArchiveRelativePath(value: string, label: string): string | undefined {
  if (value.includes("\0") || value.includes("\\")) {
    throw new Error(`${label} archive contains an unsafe path`);
  }
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return undefined;
  if (value.startsWith("/") || parts.some((part) => part === "..")) {
    throw new Error(`${label} archive contains an unsafe path`);
  }
  return parts.join("/");
}

function assertArchiveTarget(root: string, target: string, label: string): void {
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} archive path escapes its destination`);
  }
}

function ensureDirectoryTarget(root: string, target: string, label: string): void {
  if (target === root) return;
  assertArchiveTarget(root, target, label);
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) {
      throw new Error(`${label} archive crosses an unsafe destination path`);
    }
  }
}
