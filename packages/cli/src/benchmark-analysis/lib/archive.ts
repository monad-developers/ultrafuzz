import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import AdmZip from "adm-zip";
import { parseStrictJsonBytes, readRegularFileSnapshot } from "@ultrafuzz/artifacts";
import tar from "tar-stream";

const HANDOFF_PATH = "handoff/current-state.json";
const MAX_JSON_BYTES = 64 * 1024 * 1024;
// adm-zip retains the compressed input, so bound it to the same compatibility
// envelope already used by other report and benchmark bundle readers.
export const MAX_BUNDLE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_NESTED_ARCHIVE_BYTES = MAX_BUNDLE_ARCHIVE_BYTES;
const MAX_NESTED_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;

export class BundleArchive {
  private readonly zip: AdmZip;
  private readonly entriesByName: ReadonlyMap<string, AdmZip.IZipEntry>;
  readonly root: string;

  constructor(readonly archivePath: string) {
    // Reject symlinks, concurrent replacement, and oversized inputs before
    // passing bytes into the ZIP parser.
    this.zip = new AdmZip(readRegularFileSnapshot(archivePath, MAX_BUNDLE_ARCHIVE_BYTES));
    const entries = this.zip.getEntries();
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new Error(`Benchmark handoff has too many ZIP entries: ${entries.length}/${MAX_ZIP_ENTRIES}`);
    }
    this.entriesByName = validateZipEntryNames(entries);
    const matches = [...this.entriesByName.values()].filter(
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
    const entry = this.entriesByName.get(entryName);
    if (entry === undefined || entry.isDirectory) throw new Error(`Expected exactly one archive member ${entryName}`);
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

function validateZipEntryNames(entries: readonly AdmZip.IZipEntry[]): ReadonlyMap<string, AdmZip.IZipEntry> {
  const byName = new Map<string, AdmZip.IZipEntry>();
  const aliases = new Set<string>();
  for (const entry of entries) {
    const name = entry.entryName;
    const withoutDirectorySlash = entry.isDirectory && name.endsWith("/") ? name.slice(0, -1) : name;
    const segments = withoutDirectorySlash.split("/");
    const canonical = segments.join("/") + (entry.isDirectory ? "/" : "");
    if (
      withoutDirectorySlash.length === 0 ||
      name.includes("\\") ||
      name.includes("\0") ||
      [...name].some((character) => {
        const code = character.codePointAt(0)!;
        return code < 0x20 || code === 0x7f;
      }) ||
      name.startsWith("/") ||
      segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":")) ||
      canonical !== name
    ) {
      throw new Error(`Benchmark handoff contains a non-canonical ZIP member name: ${JSON.stringify(name)}`);
    }
    if (byName.has(name)) throw new Error(`Benchmark handoff contains duplicate ZIP member ${JSON.stringify(name)}`);
    if (aliases.has(withoutDirectorySlash)) {
      throw new Error(`Benchmark handoff contains aliased ZIP members at ${JSON.stringify(withoutDirectorySlash)}`);
    }
    byName.set(name, entry);
    aliases.add(withoutDirectorySlash);
  }
  return byName;
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
