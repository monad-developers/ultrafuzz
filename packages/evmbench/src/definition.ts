import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

export const EVMBENCH_DEFINITION_VERSION = "ultrafuzz.evmbench.lock.v1" as const;
export const EVMBENCH_CATALOG_VERSION = "ultrafuzz.evmbench.catalog.v1" as const;

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const publicSnapshotRepositorySchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://github.com/evmbench-org/") && value.endsWith(".git"), {
    message: "target repository must be a public EVMBench snapshot"
  });

const catalogAuditSchema = z
  .object({
    id: safeIdSchema,
    repository: publicSnapshotRepositorySchema,
    framework: z.string().min(1).nullable(),
    target_commit: commitSchema,
    audit_context_sha256: digestSchema,
    ground_truth_manifest_sha256: digestSchema
  })
  .strict();

export const evmbenchCatalogSchema = z
  .object({
    schema_version: z.literal(EVMBENCH_CATALOG_VERSION),
    audits: z.array(catalogAuditSchema).min(1)
  })
  .strict();

export const evmbenchLockSchema = z
  .object({
    schema_version: z.literal(EVMBENCH_DEFINITION_VERSION),
    evmbench: z
      .object({ repository: z.literal("https://github.com/paradigmxyz/evmbench.git"), commit: commitSchema })
      .strict(),
    frontier_evals: z
      .object({ repository: z.literal("https://github.com/openai/frontier-evals.git"), commit: commitSchema })
      .strict(),
    selected_split: z.literal("detect-tasks"),
    splits: z
      .object({
        debug: z.array(safeIdSchema).min(1),
        "detect-tasks": z.array(safeIdSchema).min(1)
      })
      .strict(),
    catalog: z.object({ path: z.literal("audit-catalog.json"), sha256: digestSchema }).strict()
  })
  .strict();

export type EvmbenchCatalog = z.infer<typeof evmbenchCatalogSchema>;
export type EvmbenchCatalogAudit = z.infer<typeof catalogAuditSchema>;
export type EvmbenchLock = z.infer<typeof evmbenchLockSchema>;

export interface EvmbenchDefinition {
  lock: EvmbenchLock;
  catalog: EvmbenchCatalog;
}

export type TargetCommitResolver = (repository: string, auditId: string) => Promise<string>;

export function loadEvmbenchDefinition(benchmarkDir: string): EvmbenchDefinition {
  const lockPath = path.join(benchmarkDir, "benchmark.lock.json");
  const lock = evmbenchLockSchema.parse(readJson(lockPath));
  const catalogPath = path.resolve(benchmarkDir, lock.catalog.path);
  assertInside(benchmarkDir, catalogPath, "catalog path");
  const catalogText = fs.readFileSync(catalogPath, "utf8");
  const actualDigest = sha256(catalogText);
  if (actualDigest !== lock.catalog.sha256) {
    throw new Error(`audit catalog digest mismatch: expected ${lock.catalog.sha256}, got ${actualDigest}`);
  }
  const catalog = evmbenchCatalogSchema.parse(JSON.parse(catalogText) as unknown);
  validateDefinitionRelationships(lock, catalog);
  return { lock, catalog };
}

export async function generateEvmbenchDefinition(input: {
  harnessRoot: string;
  resolveTargetCommit: TargetCommitResolver;
}): Promise<EvmbenchDefinition> {
  const harnessRoot = path.resolve(input.harnessRoot);
  const projectRoot = evmbenchProjectRoot(harnessRoot);
  const debug = readSplit(projectRoot, "debug");
  const detect = readSplit(projectRoot, "detect-tasks");
  const detectIds = new Set(detect);
  for (const auditId of debug) {
    if (!detectIds.has(auditId)) throw new Error(`debug audit ${auditId} is absent from detect-tasks`);
  }

  const audits: EvmbenchCatalogAudit[] = [];
  for (const auditId of detect) {
    audits.push(await catalogAudit(projectRoot, auditId, input.resolveTargetCommit));
  }
  const catalog = evmbenchCatalogSchema.parse({ schema_version: EVMBENCH_CATALOG_VERSION, audits });
  const catalogText = serializeJson(catalog);
  const lock = evmbenchLockSchema.parse({
    schema_version: EVMBENCH_DEFINITION_VERSION,
    evmbench: {
      repository: "https://github.com/paradigmxyz/evmbench.git",
      commit: git(harnessRoot, ["rev-parse", "HEAD"]).toLowerCase()
    },
    frontier_evals: {
      repository: "https://github.com/openai/frontier-evals.git",
      commit: git(path.join(harnessRoot, "frontier-evals"), ["rev-parse", "HEAD"]).toLowerCase()
    },
    selected_split: "detect-tasks",
    splits: { debug, "detect-tasks": detect },
    catalog: { path: "audit-catalog.json", sha256: sha256(catalogText) }
  });
  validateDefinitionRelationships(lock, catalog);
  return { lock, catalog };
}

export async function verifyEvmbenchDefinition(input: {
  benchmarkDir: string;
  harnessRoot: string;
}): Promise<EvmbenchDefinition> {
  const committed = loadEvmbenchDefinition(input.benchmarkDir);
  const commits = new Map(committed.catalog.audits.map((audit) => [audit.id, audit.target_commit]));
  const generated = await generateEvmbenchDefinition({
    harnessRoot: input.harnessRoot,
    resolveTargetCommit: async (_repository, auditId) => {
      const commit = commits.get(auditId);
      if (commit === undefined) throw new Error(`locked target commit missing for ${auditId}`);
      return commit;
    }
  });
  if (serializeJson(generated.catalog) !== serializeJson(committed.catalog)) {
    throw new Error("audit catalog drifted from the pinned EVMBench harness");
  }
  if (serializeJson(generated.lock) !== serializeJson(committed.lock)) {
    throw new Error("benchmark lock drifted from the pinned EVMBench harness");
  }
  return committed;
}

export function writeEvmbenchDefinition(benchmarkDir: string, definition: EvmbenchDefinition): void {
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const catalogText = serializeJson(definition.catalog);
  if (sha256(catalogText) !== definition.lock.catalog.sha256) {
    throw new Error("refusing to write a definition with a stale catalog digest");
  }
  fs.writeFileSync(path.join(benchmarkDir, "audit-catalog.json"), catalogText, { encoding: "utf8", mode: 0o644 });
  fs.writeFileSync(path.join(benchmarkDir, "benchmark.lock.json"), serializeJson(definition.lock), {
    encoding: "utf8",
    mode: 0o644
  });
}

export async function resolvePublicTargetHead(repository: string): Promise<string> {
  publicSnapshotRepositorySchema.parse(repository);
  const output = execFileSync("git", ["ls-remote", repository, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  const commit = output.split(/\s+/u)[0]?.toLowerCase();
  return commitSchema.parse(commit);
}

export function buildPinnedAuditDockerfile(input: {
  dockerfile: string;
  repository: string;
  targetCommit: string;
  baseImage: string;
}): string {
  publicSnapshotRepositorySchema.parse(input.repository);
  commitSchema.parse(input.targetCommit);
  if (!/^[A-Za-z0-9][A-Za-z0-9./:@_-]+$/u.test(input.baseImage)) throw new Error("unsafe base image reference");
  const lines = input.dockerfile.split(/\r?\n/u);
  const cloneIndexes = lines.flatMap((line, index) => (line.includes("git clone") ? [index] : []));
  if (cloneIndexes.length !== 1) throw new Error(`expected one target clone instruction, found ${cloneIndexes.length}`);
  const cloneIndex = cloneIndexes[0]!;
  const repositoryWithoutSuffix = input.repository.slice(0, -".git".length);
  if (!lines[cloneIndex]!.includes(input.repository) && !lines[cloneIndex]!.includes(repositoryWithoutSuffix)) {
    throw new Error("target clone instruction does not match the catalog repository");
  }
  lines[cloneIndex] = [
    "RUN git init $AUDIT_DIR && \\",
    `    git -C $AUDIT_DIR remote add origin ${input.repository} && \\`,
    `    git -C $AUDIT_DIR fetch --depth 1 origin ${input.targetCommit} && \\`,
    "    git -C $AUDIT_DIR checkout --detach FETCH_HEAD && \\",
    "    git -C $AUDIT_DIR submodule update --init --recursive"
  ].join("\n");

  let baseReplacements = 0;
  const pinned = lines.map((line) => {
    if (/^\s*FROM\s+evmbench\/base(?::latest)?\s*$/u.test(line)) {
      baseReplacements += 1;
      return `FROM ${input.baseImage}`;
    }
    return line;
  });
  if (baseReplacements !== 1) throw new Error(`expected one EVMBench base image, found ${baseReplacements}`);
  return `${pinned.join("\n").trimEnd()}\n`;
}

export function localDockerContextFiles(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const line of dockerfile.split(/\r?\n/u)) {
    const instruction = /^\s*(COPY|ADD)\s+(.+)$/u.exec(line);
    if (instruction === null) continue;
    if (instruction[1] === "ADD") throw new Error("audit Dockerfiles may not use ADD");
    const tokens = instruction[2]!.trim().split(/\s+/u);
    if (tokens.some((token) => token.startsWith("--"))) throw new Error("COPY options are not supported");
    if (tokens.length < 2) throw new Error("COPY must contain a source and destination");
    for (const source of tokens.slice(0, -1)) {
      if (
        path.isAbsolute(source) ||
        source.includes("*") ||
        source.split(/[\\/]/u).some((part) => part === ".." || FORBIDDEN_CONTEXT_SEGMENTS.has(part.toLowerCase()))
      ) {
        throw new Error(`unsafe audit build context source: ${source}`);
      }
      sources.push(source);
    }
  }
  return [...new Set(sources)].sort();
}

export function benchmarkIdentity(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function findUltrafuzzRepoRoot(start = process.cwd()): string {
  let current = path.resolve(start);
  while (current !== path.dirname(current)) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      const packageJson = record(readJson(packagePath), "package.json");
      if (packageJson.name === "ultrafuzz" && fs.existsSync(path.join(current, "benchmarks"))) return current;
    }
    current = path.dirname(current);
  }
  throw new Error("unable to locate the Ultrafuzz repository root");
}

const FORBIDDEN_CONTEXT_SEGMENTS = new Set(["findings", "patch", "test", "tests", "exploit", "solutions"]);

async function catalogAudit(
  projectRoot: string,
  auditId: string,
  resolveTargetCommit: TargetCommitResolver
): Promise<EvmbenchCatalogAudit> {
  const auditDir = path.join(projectRoot, "audits", auditId);
  const configPath = path.join(auditDir, "config.yaml");
  const dockerfilePath = path.join(auditDir, "Dockerfile");
  const auditStat = fs.statSync(auditDir, { throwIfNoEntry: false });
  if (auditStat === undefined || !auditStat.isDirectory()) {
    throw new Error(`audit directory missing for ${auditId}`);
  }
  const config = record(parseYaml(fs.readFileSync(configPath, "utf8")), `${auditId} config`);
  if (config.id !== auditId) throw new Error(`audit config ID mismatch for ${auditId}`);
  const vulnerabilities = Array.isArray(config.vulnerabilities) ? config.vulnerabilities : [config.vulnerabilities];
  if (vulnerabilities.length === 0) throw new Error(`audit ${auditId} has no findings`);
  const findingEntries = vulnerabilities.map((value, index) => {
    const finding = record(value, `${auditId} finding ${index + 1}`);
    const id = safeIdSchema.parse(finding.id);
    const findingPath = path.join(auditDir, "findings", `${id}.md`);
    if (!fs.statSync(findingPath).isFile()) throw new Error(`audit ${auditId} is missing a finding document`);
    return { id, sha256: sha256(fs.readFileSync(findingPath)) };
  });
  assertUnique(
    findingEntries.map((entry) => entry.id),
    `finding ID in ${auditId}`
  );

  const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  const repository = repositoryFromDockerfile(dockerfile);
  const targetCommit = commitSchema.parse((await resolveTargetCommit(repository, auditId)).toLowerCase());
  const contextFiles = localDockerContextFiles(dockerfile);
  const contextManifest = contextFiles.map((relative) => {
    const absolute = path.resolve(auditDir, relative);
    assertInside(auditDir, absolute, "audit Docker context path");
    if (!fs.statSync(absolute).isFile()) throw new Error(`audit ${auditId} Docker context input is not a file`);
    return { path: relative, sha256: sha256(fs.readFileSync(absolute)) };
  });
  const pinnedDockerfile = buildPinnedAuditDockerfile({
    dockerfile,
    repository,
    targetCommit,
    baseImage: "ultrafuzz/evmbench-base:pinned"
  });
  return catalogAuditSchema.parse({
    id: auditId,
    repository,
    framework: typeof config.framework === "string" && config.framework.length > 0 ? config.framework : null,
    target_commit: targetCommit,
    audit_context_sha256: sha256(canonicalJson({ dockerfile: pinnedDockerfile, files: contextManifest })),
    ground_truth_manifest_sha256: sha256(canonicalJson(findingEntries.sort((a, b) => a.id.localeCompare(b.id))))
  });
}

function repositoryFromDockerfile(dockerfile: string): string {
  const repositories = [
    ...new Set(
      (dockerfile.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?=\s)/gu) ?? []).map(
        (repository) => (repository.endsWith(".git") ? repository : `${repository}.git`)
      )
    )
  ];
  if (repositories.length !== 1) throw new Error(`expected one target repository, found ${repositories.length}`);
  return publicSnapshotRepositorySchema.parse(repositories[0]);
}

function readSplit(projectRoot: string, split: "debug" | "detect-tasks"): string[] {
  const ids = fs
    .readFileSync(path.join(projectRoot, "splits", `${split}.txt`), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => safeIdSchema.parse(line));
  assertUnique(ids, `${split} audit ID`);
  return ids;
}

function validateDefinitionRelationships(lock: EvmbenchLock, catalog: EvmbenchCatalog): void {
  assertUnique(lock.splits.debug, "debug audit ID");
  assertUnique(lock.splits["detect-tasks"], "detect audit ID");
  assertUnique(
    catalog.audits.map((audit) => audit.id),
    "catalog audit ID"
  );
  const catalogIds = catalog.audits.map((audit) => audit.id);
  if (JSON.stringify(catalogIds) !== JSON.stringify(lock.splits["detect-tasks"])) {
    throw new Error("audit catalog order or membership does not match detect-tasks");
  }
}

function evmbenchProjectRoot(harnessRoot: string): string {
  const projectRoot = path.join(harnessRoot, "frontier-evals", "project", "evmbench");
  if (!fs.existsSync(path.join(projectRoot, "splits", "detect-tasks.txt"))) {
    throw new Error("pinned EVMBench project is missing from the harness checkout");
  }
  return projectRoot;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}`);
    seen.add(value);
  }
}

function assertInside(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} escapes its root`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}
