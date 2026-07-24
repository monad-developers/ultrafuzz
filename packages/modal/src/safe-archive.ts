import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";

import tar from "tar-stream";

const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;

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
  options: { gzip: boolean; label: string }
): Promise<void> {
  const root = fs.realpathSync(path.resolve(destination));
  const archive = fs.createReadStream(archivePath);
  const gunzip = options.gzip ? createGunzip() : undefined;
  const extract = tar.extract();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let entries = 0;
    let totalBytes = 0;
    const seen = new Set<string>();
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      archive.destroy();
      gunzip?.destroy();
      extract.destroy();
      reject(
        error instanceof Error ? error : new Error(`${options.label} archive extraction failed: ${String(error)}`)
      );
    };

    extract.on("entry", (header, stream, next) => {
      try {
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
          stream.once("end", next);
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
          stream.once("end", next);
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
        const output = fs.createWriteStream(target, {
          flags: "wx",
          mode: (header.mode ?? 0) & 0o111 ? 0o700 : 0o600
        });
        stream.on("data", (chunk: Buffer | string) => {
          observedBytes += Buffer.byteLength(chunk);
          if (observedBytes > declaredBytes || observedBytes > MAX_ARCHIVE_FILE_BYTES) {
            fail(new Error(`${options.label} archive file exceeds its declared size`));
          }
        });
        stream.once("error", fail);
        output.once("error", fail);
        output.once("finish", () => {
          if (settled) return;
          if (observedBytes !== declaredBytes) {
            fail(new Error(`${options.label} archive file size does not match its header`));
            return;
          }
          next();
        });
        stream.pipe(output);
      } catch (error) {
        stream.resume();
        fail(error);
      }
    });
    extract.once("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    extract.once("error", fail);
    archive.once("error", fail);
    gunzip?.once("error", fail);
    if (gunzip === undefined) {
      archive.pipe(extract);
    } else {
      archive.pipe(gunzip).pipe(extract);
    }
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
