import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evmbenchProfileSchema, type EvmbenchProfile } from "./adapter.js";
import {
  benchmarkIdentity,
  buildPinnedAuditDockerfile,
  findUltrafuzzRepoRoot,
  loadEvmbenchDefinition,
  localDockerContextFiles,
  serializeJson,
  verifyEvmbenchDefinition,
  type EvmbenchCatalogAudit,
  type EvmbenchDefinition
} from "./definition.js";
import {
  normalizeEvmbenchResult,
  readNanoevalFinalReport,
  type EvmbenchOperationalMetrics,
  type EvmbenchRunProvenance
} from "./results.js";

export interface EvmbenchRunnerOptions {
  repoRoot?: string;
  benchmarkDir?: string;
  harnessRoot?: string;
  cacheDir?: string;
  outputDir?: string;
  split?: "debug" | "detect-tasks";
  audit?: string;
  profile?: "smoke" | "full";
  model?: string;
  reasoning?: string;
  concurrency?: number;
  dryRun?: boolean;
  gold?: boolean;
  authPath?: string;
}

export interface EvmbenchRunPlan {
  benchmark_identity: string;
  split: "debug" | "detect-tasks" | "single-audit";
  profile: "smoke" | "full";
  model: string;
  reasoning: string;
  concurrency: number;
  audits: Array<{ id: string; repository: string; target_commit: string }>;
  dry_run: boolean;
  official_grader: true;
}

export interface EvmbenchRunnerResult {
  plan: EvmbenchRunPlan;
  output_dir?: string;
  normalized_summary?: string;
}

export async function runEvmbench(options: EvmbenchRunnerOptions = {}): Promise<EvmbenchRunnerResult> {
  const repoRoot = path.resolve(options.repoRoot ?? findUltrafuzzRepoRoot());
  const benchmarkDir = path.resolve(options.benchmarkDir ?? path.join(repoRoot, "benchmarks", "evmbench"));
  const definition = loadEvmbenchDefinition(benchmarkDir);
  const harnessRoot = await ensurePinnedHarness({
    definition,
    requestedRoot: options.harnessRoot,
    cacheDir: path.resolve(options.cacheDir ?? path.join(repoRoot, ".ultrafuzz", "evmbench", "cache"))
  });
  await verifyEvmbenchDefinition({ benchmarkDir, harnessRoot });
  assertAgentAdapterIsolation(benchmarkDir);

  const profile = loadProfile(benchmarkDir, options);
  const selected = selectAudits(definition, options);
  const candidate = gitRevision(repoRoot);
  if (!options.dryRun && candidate.dirty) {
    throw new Error("real benchmark runs require a clean Ultrafuzz checkout");
  }
  const profileFingerprint = benchmarkIdentity(profile);
  const topologyFingerprint = sha256File(path.join(repoRoot, ".ultrafuzz", "topology.yml"));
  const identity = benchmarkIdentity({
    definition: definition.lock,
    catalog: definition.lock.catalog.sha256,
    selected: selected.map((audit) => audit.id),
    profile,
    profile_fingerprint: profileFingerprint,
    topology_fingerprint: topologyFingerprint,
    ultrafuzz_commit: candidate.commit,
    gold: options.gold === true
  });
  const plan: EvmbenchRunPlan = {
    benchmark_identity: identity,
    split: options.audit === undefined ? (options.split ?? "debug") : "single-audit",
    profile: profile.id,
    model: profile.model,
    reasoning: profile.reasoning,
    concurrency: profile.max_concurrency,
    audits: selected.map((audit) => ({
      id: audit.id,
      repository: audit.repository,
      target_commit: audit.target_commit
    })),
    dry_run: options.dryRun === true,
    official_grader: true
  };
  if (options.dryRun) return { plan };
  const authPath = options.gold ? undefined : requiredAuthPath(options.authPath);

  const outputDir = path.resolve(
    options.outputDir ??
      path.join(repoRoot, ".ultrafuzz", "evmbench", "results", `${timestamp()}-${identity.slice("sha256:".length, 14)}`)
  );
  if (fs.existsSync(outputDir)) throw new Error(`benchmark output already exists: ${outputDir}`);
  const upstreamRoot = path.join(outputDir, "upstream");
  const recordsDir = path.join(upstreamRoot, "records");
  const runsDir = path.join(upstreamRoot, "runs");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });

  const projectRoot = evmbenchProjectRoot(harnessRoot);
  injectAgentAdapter(benchmarkDir, projectRoot);
  const imageState = buildImages({
    repoRoot,
    projectRoot,
    benchmarkDir,
    definition,
    selected,
    profile,
    identity,
    ultrafuzzCommit: candidate.commit,
    gold: options.gold === true
  });
  const startedAt = Date.now();
  runOfficialNanoeval({
    projectRoot,
    recordsDir,
    runsDir,
    split: options.split ?? "debug",
    audit: options.audit,
    concurrency: profile.max_concurrency,
    timeoutSeconds: profile.workflow_timeout_seconds,
    imageRepository: options.gold ? imageState.sourceRepository : imageState.overlayRepository,
    gold: options.gold === true,
    authPath
  });
  const runtimeSeconds = (Date.now() - startedAt) / 1_000;
  const finalReport = readNanoevalFinalReport(findFiles(recordsDir, (file) => file.endsWith(".jsonl")));
  const operational: EvmbenchOperationalMetrics = {
    runtime_seconds: runtimeSeconds,
    token_usage: null,
    cost_usd: null,
    completeness: { runtime: "complete", token_usage: "unavailable", cost: "unavailable" }
  };
  const provenance: EvmbenchRunProvenance = {
    benchmark_identity: identity,
    ultrafuzz_commit: candidate.commit,
    ultrafuzz_dirty: candidate.dirty,
    evmbench_commit: definition.lock.evmbench.commit,
    frontier_evals_commit: definition.lock.frontier_evals.commit,
    targets: selected.map((audit) => ({ audit_id: audit.id, source_commit: audit.target_commit })),
    audit_images: imageState.images,
    profile: profile.id,
    profile_fingerprint: profileFingerprint,
    topology_fingerprint: topologyFingerprint,
    model: profile.model,
    agent: options.gold ? "official-gold" : "ultrafuzz",
    reasoning: profile.reasoning,
    concurrency: profile.max_concurrency
  };
  const normalized = normalizeEvmbenchResult({ finalReport, provenance, operational });
  const normalizedPath = path.join(outputDir, "normalized-summary.json");
  fs.writeFileSync(normalizedPath, serializeJson(normalized), { encoding: "utf8", mode: 0o644 });
  return { plan, output_dir: outputDir, normalized_summary: normalizedPath };
}

export async function ensurePinnedHarness(input: {
  definition: EvmbenchDefinition;
  requestedRoot?: string;
  cacheDir: string;
}): Promise<string> {
  if (input.requestedRoot !== undefined) {
    const requested = path.resolve(input.requestedRoot);
    assertHarnessCommits(requested, input.definition);
    return requested;
  }
  const root = path.join(input.cacheDir, "harness", input.definition.lock.evmbench.commit);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    execChecked("git", ["clone", "--no-checkout", input.definition.lock.evmbench.repository, root]);
    execChecked("git", ["fetch", "--depth", "1", "origin", input.definition.lock.evmbench.commit], root);
    execChecked("git", ["checkout", "--detach", input.definition.lock.evmbench.commit], root);
    execChecked("git", ["submodule", "update", "--init", "--recursive", "--depth", "1"], root);
  }
  assertHarnessCommits(root, input.definition);
  return root;
}

function buildImages(input: {
  repoRoot: string;
  projectRoot: string;
  benchmarkDir: string;
  definition: EvmbenchDefinition;
  selected: EvmbenchCatalogAudit[];
  profile: EvmbenchProfile;
  identity: string;
  ultrafuzzCommit: string;
  gold: boolean;
}): {
  sourceRepository: string;
  overlayRepository: string;
  images: EvmbenchRunProvenance["audit_images"];
} {
  const suffix = input.identity.slice("sha256:".length, "sha256:".length + 12);
  const ploitImage = `ultrafuzz/evmbench-ploit:${suffix}`;
  const baseImage = `ultrafuzz/evmbench-base:${suffix}`;
  const sourceRepository = `ultrafuzz/evmbench-source-${suffix}`;
  const overlayRepository = `ultrafuzz/evmbench-${suffix}-${input.profile.id}`;
  buildBaseImages(input.projectRoot, ploitImage, baseImage);
  const images: EvmbenchRunProvenance["audit_images"] = [];
  for (const audit of input.selected) {
    const sourceImage = `${sourceRepository}:${audit.id}`;
    buildPinnedAuditImage({ projectRoot: input.projectRoot, audit, baseImage, tag: sourceImage });
    const actualCommit = execChecked("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "git",
      sourceImage,
      "-C",
      "/home/agent/audit",
      "rev-parse",
      "HEAD"
    ]).trim();
    if (actualCommit !== audit.target_commit) throw new Error(`source image commit mismatch for ${audit.id}`);
    const sourceDigest = inspectImageDigest(sourceImage);
    let overlayDigest: string | null = null;
    if (!input.gold) {
      const overlayImage = `${overlayRepository}:${audit.id}`;
      if (!imageExists(overlayImage))
        withTrackedBuildContext(input.repoRoot, (contextRoot) => {
          execChecked(
            "docker",
            [
              "build",
              "--file",
              path.join(contextRoot, "benchmarks", "evmbench", "overlay.Dockerfile"),
              "--build-arg",
              `BASE_IMAGE=${sourceImage}`,
              "--build-arg",
              `PROFILE=${input.profile.id}`,
              "--build-arg",
              `MODEL=${input.profile.model}`,
              "--build-arg",
              `REASONING=${input.profile.reasoning}`,
              "--build-arg",
              `ULTRAFUZZ_COMMIT=${input.ultrafuzzCommit}`,
              "--build-arg",
              `EVMBENCH_COMMIT=${input.definition.lock.evmbench.commit}`,
              "--build-arg",
              `FRONTIER_EVALS_COMMIT=${input.definition.lock.frontier_evals.commit}`,
              "--tag",
              overlayImage,
              contextRoot
            ],
            contextRoot
          );
        });
      overlayDigest = inspectImageDigest(overlayImage);
    }
    images.push({ audit_id: audit.id, source_image_digest: sourceDigest, overlay_image_digest: overlayDigest });
  }
  return { sourceRepository, overlayRepository, images };
}

function buildBaseImages(projectRoot: string, ploitImage: string, baseImage: string): void {
  if (!imageExists(ploitImage)) {
    execChecked("docker", [
      "build",
      "--file",
      path.join(projectRoot, "ploit", "Dockerfile"),
      "--target",
      "ploit-builder",
      "--tag",
      ploitImage,
      projectRoot
    ]);
  }
  if (imageExists(baseImage)) return;
  withTempDir((directory) => {
    const upstream = fs.readFileSync(path.join(projectRoot, "evmbench", "Dockerfile"), "utf8");
    const dockerfile = upstream.replace(/^FROM\s+ploit-builder:latest\s+AS\s+ploit$/mu, `FROM ${ploitImage} AS ploit`);
    if (dockerfile === upstream) throw new Error("EVMBench base Dockerfile no longer uses the expected builder image");
    fs.writeFileSync(path.join(directory, "Dockerfile"), dockerfile, "utf8");
    execChecked("docker", ["build", "--tag", baseImage, directory]);
  });
}

function buildPinnedAuditImage(input: {
  projectRoot: string;
  audit: EvmbenchCatalogAudit;
  baseImage: string;
  tag: string;
}): void {
  if (imageExists(input.tag)) return;
  const auditDir = path.join(input.projectRoot, "audits", input.audit.id);
  const upstream = fs.readFileSync(path.join(auditDir, "Dockerfile"), "utf8");
  const dockerfile = buildPinnedAuditDockerfile({
    dockerfile: upstream,
    repository: input.audit.repository,
    targetCommit: input.audit.target_commit,
    baseImage: input.baseImage
  });
  withTempDir((directory) => {
    fs.writeFileSync(path.join(directory, "Dockerfile"), dockerfile, "utf8");
    for (const relative of localDockerContextFiles(upstream)) {
      const source = path.resolve(auditDir, relative);
      const destination = path.resolve(directory, relative);
      assertInside(auditDir, source, "audit context source");
      assertInside(directory, destination, "audit context destination");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    execChecked("docker", ["build", "--tag", input.tag, directory]);
  });
}

function runOfficialNanoeval(input: {
  projectRoot: string;
  recordsDir: string;
  runsDir: string;
  split: "debug" | "detect-tasks";
  audit?: string;
  concurrency: number;
  timeoutSeconds: number;
  imageRepository: string;
  gold: boolean;
  authPath?: string;
}): void {
  execChecked("uv", ["sync", "--frozen"], input.projectRoot);
  const selection = input.audit === undefined ? `evmbench.audit_split=${input.split}` : `evmbench.audit=${input.audit}`;
  const args = [
    "run",
    "python",
    "-m",
    "evmbench.nano.entrypoint",
    selection,
    "evmbench.mode=detect",
    `evmbench.runs_dir=${input.runsDir}`,
    "evmbench.log_to_run_dir=True",
    `evmbench.apply_gold_solution=${input.gold ? "True" : "False"}`,
    ...(input.authPath === undefined ? [] : [`evmbench.codex_auth_path=${input.authPath}`]),
    "evmbench.solver=evmbench.nano.solver.EVMbenchSolver",
    `evmbench.solver.agent_id=${input.gold ? "human" : "ultrafuzz"}`,
    `evmbench.solver.timeout=${input.timeoutSeconds}`,
    `runner.concurrency=${input.concurrency}`
  ];
  const environment = {
    ...process.env,
    EVMBENCH_AUDIT_IMAGE_REPO: input.imageRepository,
    NANOEVAL_LOG_DIR: input.recordsDir
  };
  const result = spawnSync("uv", args, {
    cwd: input.projectRoot,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"]
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`official EVMBench runner exited with ${result.status ?? "unknown"}`);
}

function loadProfile(benchmarkDir: string, options: EvmbenchRunnerOptions): EvmbenchProfile {
  const id = options.profile ?? "smoke";
  const filePath = path.join(benchmarkDir, "profiles", `${id}.json`);
  const base = evmbenchProfileSchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  return evmbenchProfileSchema.parse({
    ...base,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.concurrency === undefined ? {} : { max_concurrency: options.concurrency })
  });
}

function selectAudits(definition: EvmbenchDefinition, options: EvmbenchRunnerOptions): EvmbenchCatalogAudit[] {
  const ids = options.audit === undefined ? definition.lock.splits[options.split ?? "debug"] : [options.audit];
  const audits = new Map(definition.catalog.audits.map((audit) => [audit.id, audit]));
  return ids.map((id) => {
    const audit = audits.get(id);
    if (audit === undefined) throw new Error(`audit ${id} is not in the pinned detect catalog`);
    return audit;
  });
}

function assertHarnessCommits(root: string, definition: EvmbenchDefinition): void {
  const actualRoot = execChecked("git", ["rev-parse", "HEAD"], root).trim();
  const actualFrontier = execChecked("git", ["rev-parse", "HEAD"], path.join(root, "frontier-evals")).trim();
  if (actualRoot !== definition.lock.evmbench.commit)
    throw new Error("EVMBench harness commit does not match the lock");
  if (actualFrontier !== definition.lock.frontier_evals.commit) {
    throw new Error("frontier-evals harness commit does not match the lock");
  }
}

function assertAgentAdapterIsolation(benchmarkDir: string): void {
  const agentRoot = path.join(benchmarkDir, "agent", "ultrafuzz");
  const relativeFiles = findFiles(agentRoot, () => true)
    .map((file) => path.relative(agentRoot, file))
    .sort();
  if (JSON.stringify(relativeFiles) !== JSON.stringify(["config.yaml", "start.sh"])) {
    throw new Error("EVMBench agent bundle may contain only its config and start script");
  }
}

function injectAgentAdapter(benchmarkDir: string, projectRoot: string): void {
  const source = path.join(benchmarkDir, "agent", "ultrafuzz");
  const destination = path.join(projectRoot, "evmbench", "agents", "ultrafuzz");
  fs.cpSync(source, destination, { recursive: true, force: true });
  fs.chmodSync(path.join(destination, "start.sh"), 0o755);
}

function evmbenchProjectRoot(harnessRoot: string): string {
  return path.join(harnessRoot, "frontier-evals", "project", "evmbench");
}

function gitRevision(repoRoot: string): { commit: string; dirty: boolean } {
  return {
    commit: execChecked("git", ["rev-parse", "HEAD"], repoRoot).trim().toLowerCase(),
    dirty: execChecked("git", ["status", "--porcelain"], repoRoot).trim() !== ""
  };
}

function requiredAuthPath(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("a subscription authentication file is required for a non-gold benchmark run");
  }
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("subscription authentication must be a regular file");
  }
  return absolute;
}

function inspectImageDigest(image: string): string {
  const digest = execChecked("docker", ["image", "inspect", "--format", "{{.Id}}", image]).trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new Error(`Docker returned an invalid digest for ${image}`);
  return digest;
}

function imageExists(image: string): boolean {
  const result = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  return result.status === 0;
}

function execChecked(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
}

function findFiles(root: string, include: (file: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...findFiles(absolute, include));
    else if (entry.isFile() && include(absolute)) files.push(absolute);
  }
  return files;
}

function withTempDir(action: (directory: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-evmbench-"));
  try {
    action(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function withTrackedBuildContext(repoRoot: string, action: (directory: string) => void): void {
  withTempDir((directory) => {
    const tracked = execChecked("git", ["ls-files", "-z"], repoRoot).split("\0").filter(Boolean);
    for (const relative of tracked) {
      const source = path.resolve(repoRoot, relative);
      const destination = path.resolve(directory, relative);
      assertInside(repoRoot, source, "tracked build context source");
      assertInside(directory, destination, "tracked build context destination");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(source), destination);
      } else if (stat.isFile()) {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, stat.mode);
      } else {
        throw new Error(`unsupported tracked build context entry: ${relative}`);
      }
    }
    action(directory);
  });
}

function assertInside(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} escapes its root`);
}

function sha256File(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}
