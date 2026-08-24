import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReleaseValidationReport,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  serializeReleaseValidationReport
} from "../packages/artifacts/dist/index.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportPath = releaseReportPath(readOption("--report") ?? ".ultrafuzz/release-validation.report.json");

const gates = [
  gate(
    "dependency-advisories",
    "Production dependency advisory policy",
    "pnpm",
    ["-w", "security:dependency-advisories"],
    ["G-SECURITY"]
  ),
  gate("ci-scripts", "CI policy script tests", "pnpm", ["-w", "test:ci-scripts"], ["G-CI", "G-SECURITY"]),
  gate("docs", "Documentation inventory", "pnpm", ["-w", "docs:check"], ["G-DOCS"]),
  gate("config", "Config package tests", "pnpm", ["--filter", "@ultrafuzz/config", "test"], ["G-CONFIG"]),
  gate(
    "audit-profile-package",
    "Audit profile package assets",
    "node",
    ["scripts/validate-audit-profile-package.mjs"],
    ["G-CONFIG", "G-CLI"]
  ),
  gate("packed-install", "Packed install, init, and validate", "pnpm", ["-w", "validate:pack"], ["G-PACKAGE"]),
  gate("security", "Security package tests", "pnpm", ["--filter", "@ultrafuzz/security", "test"], ["G-SECURITY"]),
  gate(
    "references",
    "References package tests",
    "pnpm",
    ["--filter", "@ultrafuzz/references", "test"],
    ["G-REFERENCES"]
  ),
  gate("topology", "Topology package tests", "pnpm", ["--filter", "@ultrafuzz/topology", "test"], ["G-TOPOLOGY"]),
  gate("prompts", "Prompt package tests", "pnpm", ["--filter", "@ultrafuzz/prompts", "test"], ["G-PROMPTS"]),
  gate("artifacts", "Artifacts package tests", "pnpm", ["--filter", "@ultrafuzz/artifacts", "test"], ["G-ARTIFACTS"]),
  gate(
    "runtime-supporting",
    "Runtime supporting test files",
    "pnpm",
    ["--filter", "@ultrafuzz/runtime", "test:release:supporting"],
    ["G-RUNTIME"]
  ),
  ...[1, 2, 3, 4].map((index) =>
    gate(
      `runtime-${index}`,
      `Runtime integration tests (shard ${index}/4)`,
      "pnpm",
      ["--filter", "@ultrafuzz/runtime", "test:release:runtime-shard", "--", `${index}/4`],
      ["G-RUNTIME"]
    )
  ),
  gate("dashboard", "Dashboard package tests", "pnpm", ["--filter", "@ultrafuzz/dashboard", "test"], ["G-DASHBOARD"]),
  gate("evals", "Evals package tests", "pnpm", ["--filter", "@ultrafuzz/evals", "test"], ["G-EVALS"]),
  gate("evmbench", "EVMBench package tests", "pnpm", ["--filter", "@ultrafuzz/evmbench", "test"], ["G-EVMBENCH"]),
  gate("modal", "Modal package tests", "pnpm", ["--filter", "@ultrafuzz/modal", "test"], ["G-MODAL"]),
  gate("cli", "CLI package tests", "pnpm", ["--filter", "@ultrafuzz/cli", "test"], ["G-CLI"]),
  gate("benchmark-history", "Benchmark history charts", "pnpm", ["-w", "benchmark:check:prebuilt"], ["G-CLI"]),
  gate("workspace-typecheck", "Workspace typecheck", "pnpm", ["-w", "typecheck"], ["G-WORKSPACE-TYPECHECK"])
];

const mergeReportDir = readOption("--merge-report-dir");
if (mergeReportDir !== undefined && readOption("--gates") !== undefined) {
  throw new Error("--merge-report-dir and --gates cannot be combined");
}

const commands = mergeReportDir === undefined ? selectedGates().map(runGate) : mergeReports(mergeReportDir);
const failedCommands = commands.filter((command) => command.status === "failed");
const overallStatus = failedCommands.length === 0 ? "pass" : "fail";

const report = {
  schema_version: "ultrafuzz.release-validation.report.v2",
  package_id: "ultrafuzz",
  generated_at: new Date().toISOString(),
  project_root: root,
  report_path: path.relative(root, reportPath).split(path.sep).join("/"),
  overall_status: overallStatus,
  commands
};

mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, serializeReleaseValidationReport(report));
console.log(`release validation report: ${path.relative(root, reportPath)}`);
process.exit(overallStatus === "pass" ? 0 : 1);

function gate(id, title, command, args, validationGates) {
  return {
    id,
    title,
    command,
    args,
    commandString: [command, ...args].join(" "),
    required: true,
    validationGates
  };
}

function selectedGates() {
  const value = readOption("--gates");
  if (value === undefined) return gates;
  const ids = value.split(",");
  if (ids.some((id) => id.length === 0)) throw new Error("--gates must be a comma-separated list of gate IDs");
  const selected = new Set(ids);
  if (selected.size !== ids.length) throw new Error("--gates must not contain duplicate gate IDs");
  const unknown = ids.filter((id) => !gates.some((item) => item.id === id));
  if (unknown.length > 0) throw new Error(`unknown release validation gates: ${unknown.join(", ")}`);
  return gates.filter((item) => selected.has(item.id));
}

function runGate(item) {
  const started = Date.now();
  const result = spawnSync(item.command, item.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  const exitCode = result.status ?? 1;
  return commandResult(item, exitCode, Date.now() - started);
}

function mergeReports(relativeDirectory) {
  const directory = path.resolve(root, relativeDirectory);
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const commandsById = new Map();
  const knownIds = new Set(gates.map((item) => item.id));

  for (const file of files) {
    const fragment = parseStrictJsonBytes(readRegularFileSnapshot(path.join(directory, file), 1024 * 1024), {
      maxBytes: 1024 * 1024,
      maxDepth: 32,
      maxItems: 10_000,
      maxProperties: 10_000
    });
    try {
      assertReleaseValidationReport(fragment);
    } catch (error) {
      throw new Error(`${file} is not a current Ultrafuzz release validation report`, { cause: error });
    }
    for (const command of fragment.commands) {
      if (!knownIds.has(command?.id)) throw new Error(`${file} contains an unknown release validation gate`);
      if (commandsById.has(command.id)) throw new Error(`duplicate release validation gate: ${command.id}`);
      if (command.status !== "passed" && command.status !== "failed") {
        throw new Error(`${file} contains an invalid status for ${command.id}`);
      }
      commandsById.set(command.id, command);
    }
  }

  return gates.map((item) => commandsById.get(item.id) ?? missingCommandResult(item));
}

function commandResult(item, exitCode, durationMs) {
  return {
    id: item.id,
    title: item.title,
    command: item.commandString,
    required: item.required,
    status: exitCode === 0 ? "passed" : "failed",
    exit_code: exitCode,
    duration_ms: durationMs,
    validation_gates: item.validationGates
  };
}

function missingCommandResult(item) {
  return {
    ...commandResult(item, 1, 0),
    command: "missing release validation lane result"
  };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function releaseReportPath(value) {
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("release validation report must remain inside the project root");
  }
  const parts = relative.split(path.sep);
  if (parts.some((part) => part === "" || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/u.test(part))) {
    throw new Error("release validation report path must be canonical and contain only safe segments");
  }
  return absolute;
}
