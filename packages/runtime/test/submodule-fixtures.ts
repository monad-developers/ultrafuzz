import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { temporaryRoot } from "./temporary-root.js";

/** Shared Git fixtures for the submodule hydration tests. */

export function writeSmallTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: stdout.txt
        contract: ultrafuzz/text@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

export function writeTrustedNpmLauncher(root: string): string {
  const binDir = path.join(root, "trusted-bin");
  const launcher = path.join(binDir, process.platform === "win32" ? "npm-cli.js" : "npm");
  const npmCli = fs.realpathSync(
    path.join(
      path.dirname(process.execPath),
      ...(process.platform === "win32" ? ["node_modules", "npm", "bin", "npm-cli.js"] : ["npm"])
    )
  );
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    launcher,
    `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, [${JSON.stringify(npmCli)}, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
    "utf8"
  );
  fs.chmodSync(launcher, 0o555);
  return binDir;
}

export function nestedSubmoduleFixture(): {
  root: string;
  source: string;
  dependencyCommit: string;
  nestedCommit: string;
} {
  const root = temporaryRoot("ultrafuzz-pinned-submodules-");
  const nested = path.join(root, "nested");
  initRepository(nested);
  fs.writeFileSync(path.join(nested, "child.txt"), "nested dependency\n");
  fs.writeFileSync(path.join(nested, "tool.sh"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(nested, "tool.sh"), 0o755);
  fs.symlinkSync("child.txt", path.join(nested, "child-link"));
  git(nested, ["add", "."]);
  git(nested, ["commit", "--quiet", "-m", "nested"]);
  const nestedCommit = git(nested, ["rev-parse", "HEAD"]);

  const dependency = path.join(root, "dependency");
  initRepository(dependency);
  fs.writeFileSync(path.join(dependency, "dependency.txt"), "dependency\n");
  git(dependency, ["add", "."]);
  git(dependency, ["commit", "--quiet", "-m", "dependency"]);
  git(dependency, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", nested, "nested/child"]);
  git(dependency, ["commit", "--quiet", "-am", "nested submodule"]);
  const dependencyCommit = git(dependency, ["rev-parse", "HEAD"]);

  const source = path.join(root, "source");
  initRepository(source);
  fs.writeFileSync(path.join(source, "source.txt"), "source\n");
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "source"]);
  git(source, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", dependency, "vendor/dependency"]);
  git(source, [
    "config",
    "-f",
    ".gitmodules",
    "--rename-section",
    "submodule.vendor/dependency",
    "submodule.dependency-alias"
  ]);
  git(source, ["add", ".gitmodules"]);
  git(source, ["commit", "--quiet", "-am", "dependency submodule"]);
  git(source, ["branch", "-M", "ultrafuzz-pinned"]);
  git(source, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
  return { root, source, dependencyCommit, nestedCommit };
}

export function addSubmodule(repository: string, url: string, destination: string): void {
  git(repository, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", url, destination]);
}

export function commitAll(repository: string, message: string): void {
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", message]);
}

export function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function gitCommonDirectory(repository: string): string {
  return fs.realpathSync(
    path.resolve(repository, git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
  );
}

export function gitDirectory(repository: string): string {
  return fs.realpathSync(
    path.resolve(repository, git(repository, ["rev-parse", "--path-format=absolute", "--git-dir"]))
  );
}

export function makeTreeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    fs.chmodSync(root, 0o600);
    return;
  }
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root)) makeTreeWritable(path.join(root, entry));
}

export function initRepository(repository: string): void {
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Ultrafuzz test"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
}

export function childGitMetadata(workspace: string, roots: readonly string[]): string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.name === ".git") entries.push(path.relative(workspace, absolute));
      if (entry.isDirectory()) walk(absolute);
    }
  };
  for (const root of roots) walk(path.join(workspace, ...root.split("/")));
  return entries.sort();
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
