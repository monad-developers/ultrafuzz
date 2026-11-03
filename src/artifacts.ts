import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { stringify } from "yaml";
import type { RunRecord } from "./types";

const MiB = 1024 * 1024;
const GZIP_AT = 10 * MiB;
const FILE_LIMIT = 50 * MiB;
const RUN_LIMIT = 200 * MiB;
const words = new Set(wordlist);
// Public development fixtures, never operator-supplied credentials.
const devMnemonics = new Set([
  "test test test test test test test test test test test junk",
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "myth like bonus scare over problem client lizard pioneer submit female collect",
]);
// The first ten accounts of Anvil's documented default development mnemonic.
const anvilKeys = new Set([
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
]);

/** Positive matches only. Exact handled secrets take precedence over fixture allowlists. */
export function redactText(text: string, secrets: string[] = []): { text: string; count: number } {
  let count = 0;
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    const pieces = text.split(secret);
    if (pieces.length > 1) {
      count += pieces.length - 1;
      text = pieces.join("[REDACTED]");
    }
  }
  text = text.replace(/((?:private[_ -]?key|secret[_ -]?key)["']?\s*[:=]\s*["']?)(?:0x)?([a-f0-9]{64})\b/gi,
    (match, prefix: string, key: string) => {
      if (anvilKeys.has(key.toLowerCase())) return match;
      count++;
      return `${prefix}[REDACTED PRIVATE KEY]`;
    });
  for (const pattern of [
    /\bsk-or-v1-[A-Za-z0-9_-]{32,}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    /\b(?:ak|as)-[A-Za-z0-9_-]{20,}\b/g,
  ]) text = text.replace(pattern, () => { count++; return "[REDACTED]"; });
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, (token) => {
    try {
      const [head, body] = token.split(".");
      const header = JSON.parse(Buffer.from(head!, "base64url").toString());
      JSON.parse(Buffer.from(body!, "base64url").toString());
      if (typeof header.alg !== "string") return token;
      count++;
      return "[REDACTED JWT]";
    } catch { return token; }
  });

  // Check the BIP39 checksum, not merely twelve dictionary-looking words.
  const spans: Array<[number, number]> = [];
  const pending: Array<{ word: string; start: number; end: number }> = [];
  const inspect = () => {
    for (const size of [24, 21, 18, 15, 12]) {
      if (pending.length < size) continue;
      const segment = pending.slice(0, size);
      const mnemonic = segment.map((token) => token.word).join(" ");
      if (!validateMnemonic(mnemonic, wordlist)) continue;
      if (!devMnemonics.has(mnemonic)) {
        spans.push([segment[0]!.start, segment.at(-1)!.end]);
        count++;
      }
      pending.splice(0, size);
      return;
    }
    pending.shift();
  };
  const flush = () => { while (pending.length >= 12) inspect(); pending.length = 0; };
  for (const token of text.matchAll(/\b[a-z]+\b/gi)) {
    const start = token.index!, end = start + token[0].length;
    if (!words.has(token[0].toLowerCase())) { flush(); continue; }
    if (pending.length && !/^\s+$/.test(text.slice(pending.at(-1)!.end, start))) flush();
    pending.push({ word: token[0].toLowerCase(), start, end });
    if (pending.length === 24) inspect();
  }
  flush();
  for (const [start, end] of spans.reverse()) text = `${text.slice(0, start)}[REDACTED MNEMONIC]${text.slice(end)}`;
  return { text, count };
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}

async function* entries(root: string, prefix = ""): AsyncGenerator<{ path: string; kind: "file" | "symlink" | "other" }> {
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* entries(root, path);
    else yield { path, kind: entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other" };
  }
}

/** Redact worker output before its first copy to durable storage. Never follows links. */
export async function redactDirectory(root: string, secrets: string[] = []): Promise<number> {
  let count = 0;
  for await (const entry of entries(root)) {
    if (entry.kind !== "file") continue;
    const path = join(root, entry.path);
    let bytes = await readFile(path);
    const compressed = entry.path.endsWith(".gz");
    let decodedGzip = false;
    if (compressed) {
      try { bytes = gunzipSync(bytes); decodedGzip = true; } catch { /* Unknown binary: exact byte patterns still apply. */ }
    }
    const encoding = isText(bytes) ? "utf8" : "latin1";
    const result = redactText(bytes.toString(encoding), secrets);
    if (!result.count) continue;
    count += result.count;
    const output = Buffer.from(result.text, encoding);
    await writeFile(path, decodedGzip ? gzipSync(output) : output, { mode: 0o600 });
  }
  return count;
}

function mandatory(path: string): boolean {
  path = path.replace(/\.gz$/, "");
  if (optionalWorkspace(path)) return false;
  return /(^|\/)(report\.md|prompt\.txt|transcript[^/]*|sessions?(?:\.[^/]*)?)(\/|$)/i.test(path)
    || path.startsWith("raw/profile/") || path === "run.yml" || path === "usage.yml";
}

function optionalWorkspace(path: string): boolean {
  return /(^|\/)(workspace|workspaces)(\/|$)/.test(path);
}

function excluded(path: string): string | null {
  if (path.split("/").some((part) => /^(?:.*[-_])?corpus(?:[-_].*)?$/i.test(part))) return "fuzz corpus excluded";
  if (path.split("/").some((part) => part === ".git")) return "Git metadata excluded";
  if (/(^|\/)(\.env(?:\..*)?|credentials(?:\.json)?|auth\.json|id_rsa|id_ed25519)$/.test(path)) return "credential store excluded";
  if (path === ".ultrafuzz-files.json") return "publication ownership manifest is generated by publisher";
  return null;
}

function publicationError(path: string, reason: string): Error {
  return new Error(`Cannot publish mandatory artifact ${path}: ${reason}. Original outputs remain on the run Volume.`);
}

/** Stage a sanitized, bounded publication bundle. Source outputs are never modified. */
export async function prepareArtifacts(
  sourceDir: string,
  destDir: string,
  record: RunRecord,
  secrets: string[] = [],
): Promise<{ omitted: RunRecord["omitted"]; redactions: number }> {
  const source = resolve(sourceDir), destination = resolve(destDir);
  if (source === destination || source.startsWith(destination + sep) || destination.startsWith(source + sep))
    throw new Error("Artifact source and destination must be separate directories");
  if ((await lstat(source)).isSymbolicLink()) throw new Error("Artifact source cannot be a symbolic link");
  await mkdir(dirname(destination), { recursive: true });
  const stage = await mkdtemp(join(dirname(destination), ".ultrafuzz-artifacts-"));
  const omitted = record.omitted.map((item) => ({ ...item, path: redactText(item.path, secrets).text }));
  const omit = (path: string, reason: string) => {
    const safe = redactText(path, secrets).text;
    const existing = omitted.findIndex((item) => item.path === safe);
    if (existing >= 0) omitted.splice(existing, 1);
    omitted.push({ path: safe, reason });
  };
  const candidates: Array<{ path: string; output: string; size: number; required: boolean; workspace: boolean }> = [];
  let redactions = 0;
  try {
    for await (const entry of entries(source)) {
      if (entry.path === "run.yml" || entry.path === "usage.yml") continue;
      const safeName = redactText(entry.path, secrets);
      redactions += safeName.count;
      const previousOmission = omitted.findIndex((item) => item.path === safeName.text);
      if (previousOmission >= 0) omitted.splice(previousOmission, 1);
      const required = mandatory(entry.path);
      const reason = entry.kind !== "file" ? `${entry.kind} excluded` : excluded(entry.path);
      if (reason) {
        if (required) throw publicationError(entry.path, reason);
        omit(entry.path, reason);
        continue;
      }
      let bytes = await readFile(join(source, entry.path));
      const wasGzip = entry.path.endsWith(".gz");
      if (wasGzip) {
        try { bytes = gunzipSync(bytes); }
        catch {
          if (required) throw publicationError(entry.path, "invalid gzip data");
          omit(entry.path, "unreadable gzip artifact");
          continue;
        }
      }
      if (!isText(bytes)) {
        if (required) throw publicationError(entry.path, "not valid UTF-8 text");
        omit(entry.path, "binary artifact excluded");
        continue;
      }
      const sanitized = redactText(bytes.toString("utf8"), secrets);
      redactions += sanitized.count;
      bytes = Buffer.from(sanitized.text);
      const gzip = wasGzip || bytes.length > GZIP_AT;
      const output = gzip && !wasGzip ? `${safeName.text}.gz` : safeName.text;
      if (gzip) bytes = gzipSync(bytes);
      if (bytes.length > FILE_LIMIT) {
        if (required) throw publicationError(entry.path, "exceeds the 50 MiB file limit after compression");
        omit(entry.path, "exceeds 50 MiB after compression");
        continue;
      }
      if (candidates.some((candidate) => candidate.output === output)) throw publicationError(entry.path, `compressed path collides with ${output}`);
      await mkdir(dirname(join(stage, output)), { recursive: true });
      await writeFile(join(stage, output), bytes, { mode: 0o600 });
      candidates.push({ path: entry.path, output, size: bytes.length, required, workspace: optionalWorkspace(entry.path) });
    }
    let total = candidates.reduce((sum, candidate) => sum + candidate.size, 0);
    // Lowest-value workspace material is trimmed before other optional evidence.
    const trimmable = candidates.filter((candidate) => !candidate.required).sort((a, b) => Number(b.workspace) - Number(a.workspace) || b.size - a.size);
    for (;;) {
      omitted.sort((a, b) => a.path.localeCompare(b.path));
      // Local observation/publication fields change on every collection, while the
      // result describes the execution. Keeping them out makes recollection stable.
      const { publication, last_observed_at, usage: _usage, ...execution } = record;
      const preliminary = redactText(stringify({ ...execution, omitted, redactions: (record.redactions ?? 0) + redactions }), secrets);
      const usage = redactText(stringify(record.usage), secrets);
      const run = redactText(stringify({ ...execution, omitted, redactions: (record.redactions ?? 0) + redactions + preliminary.count + usage.count }), secrets);
      const metadataSize = Buffer.byteLength(run.text) + Buffer.byteLength(usage.text);
      if (metadataSize > FILE_LIMIT) throw publicationError("run.yml / usage.yml", "metadata exceeds the 50 MiB file limit");
      if (total + metadataSize <= RUN_LIMIT) {
        redactions += run.count + usage.count;
        await writeFile(join(stage, "run.yml"), run.text, { mode: 0o600 });
        await writeFile(join(stage, "usage.yml"), usage.text, { mode: 0o600 });
        break;
      }
      const victim = trimmable.shift();
      if (!victim) throw publicationError("report, transcripts and run metadata", "exceed the 200 MiB run limit together");
      await rm(join(stage, victim.output));
      total -= victim.size;
      omit(victim.path, "trimmed to fit the 200 MiB run limit");
    }
    await rm(destination, { recursive: true, force: true });
    await rename(stage, destination);
    return { omitted, redactions };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
