import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import AdmZip from "adm-zip";
import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import tar from "tar-stream";

const HANDOFF_SUFFIX = "handoff/current-state.json";
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_NESTED_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_NESTED_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;

export class BundleArchive {
  private readonly zip: AdmZip;
  readonly root: string;

  constructor(readonly archivePath: string) {
    this.zip = new AdmZip(archivePath);
    const entries = this.zip.getEntries();
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new Error(`Benchmark handoff has too many ZIP entries: ${entries.length}/${MAX_ZIP_ENTRIES}`);
    }
    const matches = entries.filter((entry) => !entry.isDirectory && entry.entryName.endsWith(HANDOFF_SUFFIX));
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one ${HANDOFF_SUFFIX}, found ${matches.length}`);
    }
    const entryName = matches[0]?.entryName ?? "";
    this.root = entryName.slice(0, -HANDOFF_SUFFIX.length);
  }

  has(relativePath: string): boolean {
    return this.zip.getEntry(this.entryName(relativePath)) !== null;
  }

  list(relativePrefix = ""): string[] {
    const prefix = this.entryName(relativePrefix);
    return this.zip
      .getEntries()
      .filter((entry) => !entry.isDirectory && entry.entryName.startsWith(prefix))
      .map((entry) => entry.entryName.slice(this.root.length));
  }

  readBuffer(relativePath: string, maximumBytes = MAX_JSON_BYTES): Buffer {
    const entryName = this.entryName(relativePath);
    const entry = this.zip.getEntry(entryName);
    if (!entry || entry.isDirectory) throw new Error(`Archive member not found: ${entryName}`);
    if (entry.header.size > maximumBytes) {
      throw new Error(`Archive member exceeds ${maximumBytes} bytes: ${entryName}`);
    }
    const data = entry.getData();
    if (data.length > maximumBytes) throw new Error(`Archive member exceeds ${maximumBytes} bytes: ${entryName}`);
    return data;
  }

  readJson<T = unknown>(relativePath: string): T {
    try {
      return parseStrictJsonBytes(this.readBuffer(relativePath)) as T;
    } catch (error) {
      throw new Error(`Invalid JSON in ${this.entryName(relativePath)}: ${(error as Error).message}`, { cause: error });
    }
  }

  findRowArchive(rowId: string): { relativePath: string; variant: string } {
    const escaped = rowId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`^rows/([^/]+)/${escaped}/row-artifacts\\.tar\\.gz$`, "u");
    const matches = this.list("rows/").flatMap((relativePath) => {
      const match = pattern.exec(relativePath);
      return match ? [{ relativePath, variant: match[1] as string }] : [];
    });
    if (matches.length !== 1) throw new Error(`Expected one row archive for ${rowId}, found ${matches.length}`);
    return matches[0] as { relativePath: string; variant: string };
  }

  async readNestedJson(
    relativeTarGzPath: string,
    selectedSuffixes: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const compressed = this.readBuffer(relativeTarGzPath, MAX_NESTED_ARCHIVE_BYTES);
    return extractSelectedJson(compressed, selectedSuffixes, relativeTarGzPath);
  }

  private entryName(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    return this.root + normalized;
  }
}

export function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe archive-relative path: ${value}`);
  }
  return normalized;
}

async function extractSelectedJson(
  compressed: Buffer,
  selectedSuffixes: Record<string, string>,
  label: string
): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  const extract = tar.extract();
  const gunzip = createGunzip();

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;
    let uncompressedBytes = 0;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    extract.on("entry", (header, stream, next) => {
      const match = Object.entries(selectedSuffixes).find(([, suffix]) => header.name.endsWith(suffix));
      if (!match || header.type !== "file") {
        stream.resume();
        stream.on("end", next);
        stream.on("error", fail);
        return;
      }

      const [key] = match;
      const chunks: Buffer[] = [];
      let byteCount = 0;
      stream.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += bytes.length;
        if (byteCount > MAX_JSON_BYTES) {
          fail(new Error(`Nested JSON exceeds ${MAX_JSON_BYTES} bytes (${header.name}) in ${label}`));
          return;
        }
        chunks.push(bytes);
      });
      stream.on("error", fail);
      stream.on("end", () => {
        try {
          if (key in output) throw new Error(`Duplicate nested JSON match for ${key}`);
          output[key] = parseStrictJsonBytes(Buffer.concat(chunks));
          next();
        } catch (error) {
          fail(new Error(`Invalid nested JSON (${header.name}) in ${label}: ${(error as Error).message}`));
        }
      });
    });
    extract.on("finish", () => {
      if (settled) return;
      const missing = Object.keys(selectedSuffixes).filter((key) => !(key in output));
      if (missing.length > 0) {
        fail(new Error(`Nested archive ${label} is missing: ${missing.join(", ")}`));
        return;
      }
      settled = true;
      resolve(output);
    });
    extract.on("error", fail);
    gunzip.on("data", (chunk: Buffer) => {
      uncompressedBytes += chunk.length;
      if (uncompressedBytes > MAX_NESTED_UNCOMPRESSED_BYTES) {
        fail(new Error(`Nested archive exceeds ${MAX_NESTED_UNCOMPRESSED_BYTES} uncompressed bytes: ${label}`));
        gunzip.destroy();
        extract.destroy();
      }
    });
    gunzip.on("error", fail);
    Readable.from([compressed]).pipe(gunzip).pipe(extract);
  });
}
