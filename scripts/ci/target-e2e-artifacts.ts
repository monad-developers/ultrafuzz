#!/usr/bin/env bun
/**
 * Write bounded target E2E artifacts for the target E2E CI workflow.
 *
 * Runs under Bun (which executes TypeScript directly); only Node.js built-ins
 * are used so the script stays dependency-free after it is copied into the
 * target repository as `.ultrafuzz/ci/target-e2e-artifacts.ts`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

type JsonObject = Record<string, unknown>;

interface Args {
  mode: "project-discovery" | "signal-analysis" | "final-report";
  repo: string;
  artifact: string;
  out: string;
  findings: string | null;
  runMetadata: string | null;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf-8");
}

function listRelativeFiles(root: string): string[] {
  const collected: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        collected.push(relative);
      }
    }
  };
  walk(root, "");
  return collected;
}

function projectDiscovery(repo: string, artifact: string, out: string): void {
  const markers = ["foundry.toml", "hardhat.config.ts", "hardhat.config.js", "package.json"].filter((name) =>
    existsSync(join(repo, name))
  );
  const files = listRelativeFiles(repo);
  const topLevelDirectories = readdirSync(repo, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const solidityDirs = topLevelDirectories
    .filter((name) => files.some((file) => file.startsWith(`${name}/`) && file.endsWith(".sol")))
    .slice(0, 12);
  const vyperDirs = topLevelDirectories
    .filter((name) => files.some((file) => file.startsWith(`${name}/`) && file.endsWith(".vy")))
    .slice(0, 12);
  const topLevel = readdirSync(repo)
    .filter((name) => !name.startsWith("."))
    .sort()
    .slice(0, 40);
  writeText(
    join(artifact, "setup", "project-discovery.md"),
    [
      "# CI Project Snapshot",
      "",
      `- Repository: ${repo}`,
      `- Markers: ${markers.length > 0 ? markers.join(", ") : "none"}`,
      `- Solidity directories: ${solidityDirs.length > 0 ? solidityDirs.join(", ") : "none"}`,
      `- Vyper directories: ${vyperDirs.length > 0 ? vyperDirs.join(", ") : "none"}`,
      `- Top-level entries: ${topLevel.length > 0 ? topLevel.join(", ") : "none"}`,
      ""
    ].join("\n")
  );
  writeJson(out, []);
}

function signalAnalysis(repo: string, artifact: string, out: string): void {
  const profile = process.env.ULTRAFUZZ_E2E_SIGNAL_PROFILE ?? "control";
  const expected = process.env.ULTRAFUZZ_E2E_EXPECTED_FINDINGS ?? "any";
  const files = listRelativeFiles(repo);
  const sourceFiles = files
    .filter((file) => file.endsWith(".sol") || file.endsWith(".vy"))
    .sort()
    .slice(0, 30);
  const testFiles = files
    .filter(
      (file) =>
        (file.startsWith("test/") && file.endsWith(".sol")) ||
        (file.startsWith("tests/") && file.endsWith(".ts")) ||
        (file.startsWith("test/") && file.endsWith(".py")) ||
        (file.startsWith("tests/") && file.endsWith(".py"))
    )
    .sort()
    .slice(0, 30);
  writeText(
    join(artifact, "signal-analysis.md"),
    [
      "# CI Signal Analysis",
      "",
      `- Signal profile: ${profile}`,
      `- Source files sampled: ${sourceFiles.length > 0 ? sourceFiles.join(", ") : "none"}`,
      `- Test files sampled: ${testFiles.length > 0 ? testFiles.join(", ") : "none"}`,
      "- The target E2E profile emits one source-backed CI signal unless the matrix expects eq:0.",
      ""
    ].join("\n")
  );
  const findings = expected === "eq:0" ? [] : [finding(profile, sourceFiles, testFiles)];
  writeJson(out, findings);
  writeJson(join(artifact, "generated-tests.json"), generatedTestsManifest(artifact));
}

function generatedTestsManifest(artifact: string): JsonObject {
  return {
    schema_version: "1.0",
    run_id: inferRunId(artifact),
    node_id: inferNodeId(artifact),
    generated_tests: []
  };
}

function inferRunId(artifact: string): string {
  const parent = dirname(artifact);
  const grandparent = basename(dirname(parent));
  if (basename(parent) === "artifacts" && grandparent !== "") {
    return grandparent;
  }
  return "ci-target-e2e";
}

function inferNodeId(artifact: string): string {
  const name = basename(artifact);
  return name !== "" ? name : "signal-analysis";
}

function finding(profile: string, sourceFiles: string[], testFiles: string[]): JsonObject {
  const evidencePath = sourceFiles[0] ?? testFiles[0] ?? "repository-root";
  const titles: Record<string, string> = {
    "aave-v4": "CI signal preserved for Aave v4 stateful invariant surface",
    "very-liquid-vaults": "CI signal preserved for Very Liquid Vaults market boundary surface",
    "stableswap-ng-vyper": "CI signal preserved for StableSwapNG Vyper AMM invariant surface"
  };
  const title = titles[profile] ?? "CI signal preserved for target repository surface";
  return {
    schema_version: "1.0",
    id: `ci-${profile.replaceAll("_", "-").replaceAll(" ", "-")}-signal-001`,
    title,
    severity_guess: "medium",
    confidence: "high",
    status: "needs-review",
    summary: "Bounded target E2E signal generated from repository structure and selected CI profile.",
    affected_files: [evidencePath],
    evidence: [{ kind: "repository-sample", path: evidencePath }],
    reproductions: [{ type: "ci-helper", command: "bun .ultrafuzz/ci/target-e2e-artifacts.ts signal-analysis" }],
    notes: ["impact=Medium", "likelihood=Medium", "context=CI target signal preservation via deterministic profile"]
  };
}

function finalReport(
  repo: string,
  artifact: string,
  out: string,
  findingsPath: string | null,
  runMetadataPath: string | null
): void {
  const profile = process.env.ULTRAFUZZ_E2E_SIGNAL_PROFILE ?? "control";
  const expected = process.env.ULTRAFUZZ_E2E_EXPECTED_FINDINGS ?? "any";
  const findings = readFindings(findingsPath);
  const runMetadata = waitForReportRunMetadata(repo, runMetadataPath);
  const report = {
    schema_version: "ultrafuzz.e2e.report.v1",
    target_repository: repo,
    signal_profile: profile,
    expected_findings: expected,
    finding_count: findings.length,
    issues: findings,
    run_metadata: runMetadata,
    findings
  };
  writeJson(join(artifact, "report.json"), report);
  writeText(
    join(artifact, "report.md"),
    [
      "# Target E2E Report",
      "",
      `- Signal profile: ${profile}`,
      `- Expected findings: ${expected}`,
      `- Findings: ${findings.length}`,
      `- Tokens used: ${runMetadata.tokens_used}`,
      `- Estimated spend: ${runMetadata.estimated_spend}`,
      ""
    ].join("\n")
  );
  writeJson(out, []);
}

function readFindings(path: string | null): unknown[] {
  if (path === null || !existsSync(path)) {
    return [];
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(parsed)) {
    fail(`findings input must be an array: ${path}`);
  }
  return parsed;
}

interface RunMetadata {
  tokens_used: string;
  estimated_spend: string;
  partial_pricing: boolean;
  source_run_ids: string[];
}

const UNAVAILABLE_RUN_METADATA: RunMetadata = {
  tokens_used: "unavailable",
  estimated_spend: "unavailable",
  partial_pricing: false,
  source_run_ids: []
};

function reportRunMetadata(path: string | null): RunMetadata {
  if (path === null || !existsSync(path)) {
    return { ...UNAVAILABLE_RUN_METADATA };
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const accounting = isJsonObject(parsed) ? parsed.accounting : null;
  const cumulative = isJsonObject(accounting) ? accounting.cumulative : null;
  if (!isJsonObject(cumulative)) {
    return { ...UNAVAILABLE_RUN_METADATA };
  }
  const sourceRunIds = cumulative.source_run_ids;
  return {
    tokens_used: stringOrUnavailable(cumulative.tokens_used),
    estimated_spend: stringOrUnavailable(cumulative.estimated_spend),
    partial_pricing: Boolean(cumulative.partial_pricing),
    source_run_ids: Array.isArray(sourceRunIds)
      ? sourceRunIds.filter((value): value is string => typeof value === "string")
      : []
  };
}

function stringOrUnavailable(value: unknown): string {
  if (value === null || value === undefined || value === "" || value === 0 || value === false) {
    return "unavailable";
  }
  return String(value);
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForReportRunMetadata(repo: string, path: string | null): RunMetadata {
  const deadline = Date.now() + envFloat("ULTRAFUZZ_E2E_METADATA_WAIT_SECONDS", 60.0) * 1000;
  const pollSeconds = Math.max(0.25, envFloat("ULTRAFUZZ_E2E_METADATA_POLL_SECONDS", 2.0));
  for (;;) {
    refreshRunMetadata(repo, path);
    const runMetadata = reportRunMetadata(path);
    if (reportRunMetadataAvailable(runMetadata) || Date.now() >= deadline) {
      return runMetadata;
    }
    sleepSync(Math.min(pollSeconds * 1000, Math.max(0, deadline - Date.now())));
  }
}

function reportRunMetadataAvailable(runMetadata: RunMetadata): boolean {
  return isAvailableLabel(runMetadata.tokens_used) && isAvailableLabel(runMetadata.estimated_spend);
}

function refreshRunMetadata(repo: string, path: string | null): void {
  if (path === null || !existsSync(path)) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return;
  }
  if (!isJsonObject(parsed)) {
    return;
  }
  const runId = parsed.run_id;
  if (typeof runId !== "string" || runId.trim() === "") {
    return;
  }
  const accounting = parsed.accounting;
  const cumulative = isJsonObject(accounting) ? accounting.cumulative : null;
  if (
    isJsonObject(cumulative) &&
    isAvailableLabel(cumulative.tokens_used) &&
    isAvailableLabel(cumulative.estimated_spend)
  ) {
    return;
  }
  const ultrafuzzBin = process.env.ULTRAFUZZ_BIN ?? "ultrafuzz";
  try {
    spawnSync(ultrafuzzBin, ["inspect", runId, "--project", repo, "--json"], {
      cwd: repo,
      stdio: "ignore",
      timeout: 120_000
    });
  } catch {
    // Mirror the Python helper: inspect refresh failures are non-fatal.
  }
}

function envFloat(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(0, parsed);
}

function isAvailableLabel(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "unavailable";
}

function parseArgs(argv: string[]): Args {
  const usage =
    "usage: target-e2e-artifacts.ts <project-discovery|signal-analysis|final-report> " +
    "--repo <path> --artifact <path> --out <path> [--findings <path>] [--run-metadata <path>]";
  let mode: Args["mode"] | null = null;
  const options: Record<string, string> = {};
  const queue = [...argv];
  while (queue.length > 0) {
    const argument = queue.shift() as string;
    if (argument.startsWith("--")) {
      const separator = argument.indexOf("=");
      const flag = separator === -1 ? argument : argument.slice(0, separator);
      const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
      if (!["--repo", "--artifact", "--out", "--findings", "--run-metadata"].includes(flag)) {
        fail(`unknown option: ${flag}\n${usage}`);
      }
      const value = inlineValue ?? queue.shift();
      if (value === undefined) {
        fail(`missing value for ${flag}\n${usage}`);
      }
      options[flag.slice(2)] = value;
    } else if (mode === null) {
      if (!["project-discovery", "signal-analysis", "final-report"].includes(argument)) {
        fail(`invalid mode: ${argument}\n${usage}`);
      }
      mode = argument as Args["mode"];
    } else {
      fail(`unexpected extra positional argument: ${argument}\n${usage}`);
    }
  }
  if (mode === null || options.repo === undefined || options.artifact === undefined || options.out === undefined) {
    fail(usage);
  }
  return {
    mode,
    repo: options.repo,
    artifact: options.artifact,
    out: options.out,
    findings: options.findings ?? null,
    runMetadata: options["run-metadata"] ?? null
  };
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  mkdirSync(args.artifact, { recursive: true });
  const repo = resolve(args.repo);
  const artifact = resolve(args.artifact);
  const out = resolve(args.out);
  if (args.mode === "project-discovery") {
    projectDiscovery(repo, artifact, out);
  } else if (args.mode === "signal-analysis") {
    signalAnalysis(repo, artifact, out);
  } else {
    finalReport(repo, artifact, out, args.findings, args.runMetadata);
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
