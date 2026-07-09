import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportPath = path.resolve(root, readOption("--report") ?? ".ultrafuzz/release-validation.report.json");

const gates = [
  gate("docs", "Documentation inventory", "pnpm", ["-w", "docs:check"], ["G-DOCS"]),
  gate("config", "Config package tests", "pnpm", ["--filter", "@ultrafuzz/config", "test"], ["G-CONFIG"]),
  gate("security", "Security package tests", "pnpm", ["--filter", "@ultrafuzz/security", "test"], ["G-SECURITY"]),
  gate("topology", "Topology package tests", "pnpm", ["--filter", "@ultrafuzz/topology", "test"], ["G-TOPOLOGY"]),
  gate("prompts", "Prompt package tests", "pnpm", ["--filter", "@ultrafuzz/prompts", "test"], ["G-PROMPTS"]),
  gate("artifacts", "Artifacts package tests", "pnpm", ["--filter", "@ultrafuzz/artifacts", "test"], ["G-ARTIFACTS"]),
  gate("runtime", "Runtime package tests", "pnpm", ["--filter", "@ultrafuzz/runtime", "test"], ["G-RUNTIME"]),
  gate("evals", "Evals package tests", "pnpm", ["--filter", "@ultrafuzz/evals", "test"], ["G-EVALS"]),
  gate("cli", "CLI package tests", "pnpm", ["--filter", "@ultrafuzz/cli", "test"], ["G-CLI"]),
  gate("workspace-typecheck", "Workspace typecheck", "pnpm", ["-w", "typecheck"], ["G-WORKSPACE-TYPECHECK"])
];

const commands = gates.map(runGate);
const failedCommands = commands.filter((command) => command.status === "failed");
const overallStatus = failedCommands.length === 0 ? "pass" : "fail";

const report = {
  schema_version: "ultrafuzz.release-validation.report.v1",
  package_id: "ultrafuzz",
  generated_at: new Date().toISOString(),
  project_root: root,
  report_path: path.relative(root, reportPath).split(path.sep).join("/"),
  overall_status: overallStatus,
  commands,
  failures: {
    commands: failedCommands.map((command) => command.id)
  }
};

mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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

function runGate(item) {
  const started = Date.now();
  const result = spawnSync(item.command, item.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  const exitCode = result.status ?? 1;
  return {
    id: item.id,
    title: item.title,
    command: item.commandString,
    required: item.required,
    status: exitCode === 0 ? "passed" : "failed",
    exit_code: exitCode,
    duration_ms: Date.now() - started,
    validation_gates: item.validationGates
  };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}
