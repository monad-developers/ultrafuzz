import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import AdmZip from "adm-zip";
import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import tar from "tar-stream";

const HANDOFF_PATH = "handoff/current-state.json";
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
    const matches = entries.filter(
      (entry) =>
        !entry.isDirectory &&
        (entry.entryName === HANDOFF_PATH || /^[A-Za-z0-9_.-]+\/handoff\/current-state\.json$/u.test(entry.entryName))
    );
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one canonical ${HANDOFF_PATH}, found ${matches.length}`);
    }
    const entryName = matches[0]?.entryName ?? "";
    this.root = entryName.slice(0, -HANDOFF_PATH.length);
  }

  readBuffer(relativePath: string, maximumBytes = MAX_JSON_BYTES): Buffer {
    const entryName = this.entryName(relativePath);
    const matches = this.zip.getEntries().filter((entry) => !entry.isDirectory && entry.entryName === entryName);
    if (matches.length !== 1)
      throw new Error(`Expected exactly one archive member ${entryName}, found ${matches.length}`);
    const entry = matches[0]!;
    if (entry.header.size > maximumBytes) {
      throw new Error(`Archive member exceeds ${maximumBytes} bytes: ${entryName}`);
    }
    const data = entry.getData();
    if (data.length > maximumBytes) throw new Error(`Archive member exceeds ${maximumBytes} bytes: ${entryName}`);
    return data;
  }

  readJson(relativePath: string): unknown {
    try {
      return parseStrictJsonBytes(this.readBuffer(relativePath));
    } catch (error) {
      throw new Error(`Invalid JSON in ${this.entryName(relativePath)}: ${(error as Error).message}`, { cause: error });
    }
  }

  async readNestedJson(
    relativeTarGzPath: string,
    selectedPaths: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const compressed = this.readBuffer(relativeTarGzPath, MAX_NESTED_ARCHIVE_BYTES);
    for (const selectedPath of Object.values(selectedPaths)) assertCanonicalRelativePath(selectedPath);
    return extractSelectedJson(compressed, selectedPaths, relativeTarGzPath);
  }

  private entryName(relativePath: string): string {
    assertCanonicalRelativePath(relativePath);
    return this.root + relativePath;
  }
}

export function assertCanonicalRelativePath(value: string): void {
  if (
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe archive-relative path: ${value}`);
  }
}

async function extractSelectedJson(
  compressed: Buffer,
  selectedPaths: Record<string, string>,
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
      const match = Object.entries(selectedPaths).find(([, selectedPath]) => header.name === selectedPath);
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
      const missing = Object.keys(selectedPaths).filter((key) => !(key in output));
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
