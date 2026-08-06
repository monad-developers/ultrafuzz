import fs from "node:fs";
import path from "node:path";

import { SMITHERS_ORCHESTRATOR_VERSION } from "@ultrafuzz/runtime";

// Derived, never a literal: a duplicated version literal silently stops matching the
// pinned runner on the next upgrade, and every CLI test built on this helper then
// presents an invalid install and falls through to a real network install.
const PINNED_RUNNER_VERSION = SMITHERS_ORCHESTRATOR_VERSION;
const PINNED_RUNNER_BIN = "src/bin/smithers.js";

/**
 * Installs a minimal physical copy of the pinned workflow runner dependency.
 * CLI tests intentionally exercise the same package-discovery path as users;
 * they do not receive the runtime's private in-memory executable capability.
 */
export function installPinnedFakeRunner(project: string, contents: string): string {
  const nodeModules = path.join(project, ".smithers", "node_modules");
  const runnerRoot = path.join(nodeModules, "smithers-orchestrator");
  const runner = path.join(runnerRoot, ...PINNED_RUNNER_BIN.split("/"));
  const binDirectory = path.join(nodeModules, ".bin");
  const linkedRunner = path.join(binDirectory, process.platform === "win32" ? "smithers.cmd" : "smithers");

  writePackage(nodeModules, "@moonshot-ai/kimi-code", "0.29.1");
  writePackage(nodeModules, "@smithers-orchestrator/tool-context", PINNED_RUNNER_VERSION);
  writePackage(nodeModules, "react", "19.2.4");
  writePackage(nodeModules, "zod", "4.4.3");
  fs.mkdirSync(path.dirname(runner), { recursive: true });
  fs.writeFileSync(
    path.join(runnerRoot, "package.json"),
    `${JSON.stringify({
      name: "smithers-orchestrator",
      version: PINNED_RUNNER_VERSION,
      type: "module",
      bin: { smithers: PINNED_RUNNER_BIN },
      dependencies: {}
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(runner, contents, "utf8");
  fs.chmodSync(runner, 0o755);
  fs.mkdirSync(binDirectory, { recursive: true });
  if (process.platform === "win32") {
    const reference = path.relative(binDirectory, runner).replaceAll("/", "\\");
    fs.writeFileSync(linkedRunner, `@"%~dp0\\${reference}" %*\r\n`, "utf8");
  } else {
    fs.symlinkSync(path.relative(binDirectory, runner), linkedRunner);
  }
  return runner;
}

export function pinnedFakeRunnerPath(project: string): string {
  return path.join(project, ".smithers", "node_modules", "smithers-orchestrator", ...PINNED_RUNNER_BIN.split("/"));
}

function writePackage(nodeModules: string, name: string, version: string): void {
  const packageRoot = path.join(nodeModules, ...name.split("/"));
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version, type: "module", main: "index.js", dependencies: {} })}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(packageRoot, "index.js"), "export {};\n", "utf8");
}
