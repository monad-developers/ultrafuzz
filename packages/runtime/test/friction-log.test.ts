import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createRunLayout } from "@ultrafuzz/artifacts";
import { resolveConfig, type ResolvedConfig } from "@ultrafuzz/config";

import {
  FRICTION_LOG_DIR_ENV,
  FRICTION_LOG_ENV,
  frictionLogWrapper,
  prepareFrictionLogEnvironment
} from "../src/friction-log.js";

const BODY = [
  "## Expected Behavior",
  "",
  "forge build completes inside the node timeout.",
  "",
  "## Current Behavior",
  "",
  "forge build is killed before it finishes.",
  "",
  "## Possible Solution",
  "",
  "Raise the per-command timeout.",
  "",
  "## Minimal Reproducible Example",
  "",
  "Run the setup node on a large project.",
  "",
  "## Context",
  "",
  "Synthetic test entry."
].join("\n");

function resolvedConfig(run: Partial<ResolvedConfig["run"]> = {}): ResolvedConfig {
  const resolved = resolveConfig({ env: {}, runtimeOverrides: { run } });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  if (!resolved.ok) throw new Error("config did not resolve");
  return resolved.value;
}

function layout(runId: string): ReturnType<typeof createRunLayout> {
  const root = temporaryRoot("ultrafuzz-friction-log-");
  return createRunLayout({ projectRoot: root, outputRoot: path.join(root, "runs"), runId });
}

function runWrapper(wrapper: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(wrapper, [...args, "--format", "json"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_TOKEN: "ghp_not_a_real_token", GH_TOKEN: "ghp_not_a_real_token" },
    timeout: 60_000
  });
}

function entries(logRoot: string): string[] {
  const directory = path.join(logRoot, ".agents", "friction-log");
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

test("friction log is inert unless run.friction_log_enabled is set", () => {
  const runLayout = layout("friction-disabled");
  const prepared = prepareFrictionLogEnvironment({
    layout: runLayout,
    config: resolvedConfig(),
    env: { PATH: "/usr/bin" }
  });

  assert.equal(prepared.active, false);
  assert.deepEqual(prepared.environmentVariableNames, []);
  assert.deepEqual(prepared.env, { PATH: "/usr/bin" });
  assert.equal(fs.existsSync(path.join(runLayout.root, "friction")), false);
});

test("friction log gives agents absolute paths to a run-owned log and the pinned Frog CLI", () => {
  const runLayout = layout("friction-enabled");
  const prepared = prepareFrictionLogEnvironment({
    layout: runLayout,
    config: resolvedConfig({ frictionLogEnabled: true })
  });

  const logRoot = path.join(runLayout.root, "friction");
  const wrapper = prepared.env[FRICTION_LOG_ENV];
  assert.equal(prepared.active, true);
  assert.deepEqual(prepared.environmentVariableNames, [FRICTION_LOG_ENV, FRICTION_LOG_DIR_ENV]);
  assert.equal(prepared.env[FRICTION_LOG_DIR_ENV], logRoot);
  assert.ok(wrapper !== undefined && path.isAbsolute(wrapper));
  assert.equal(path.dirname(wrapper), logRoot);
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(logRoot, ".agents", "friction-log", "config.json")), true);

  const logged = runWrapper(wrapper, ["log", "forge build times out", "--severity", "blocker", "--body", BODY]);
  assert.equal(logged.status, 0, `${String(logged.stderr)}\n${String(logged.stdout)}`);
  const [entry] = entries(logRoot);
  assert.ok(entry !== undefined);
  const writeUp = fs.readFileSync(path.join(logRoot, ".agents", "friction-log", entry, "friction.md"), "utf8");
  assert.match(writeUp, /severity: 'blocker'/u);
  assert.doesNotMatch(writeUp, /issue:/u);

  const listed = runWrapper(wrapper, ["list"]);
  assert.equal(listed.status, 0, String(listed.stderr));
  const listing = JSON.parse(String(listed.stdout)) as { pending: number; entries: Array<{ state: string }> };
  assert.equal(listing.pending, 1);
  assert.deepEqual(
    listing.entries.map((candidate) => candidate.state),
    ["pending"]
  );

  // Resuming the run reuses the existing log rather than reinitializing it.
  prepareFrictionLogEnvironment({ layout: runLayout, config: resolvedConfig({ frictionLogEnabled: true }) });
  assert.deepEqual(entries(logRoot), [entry]);
});

test("friction log stays in the run directory when the run sits inside the target repository", () => {
  const runLayout = layout("friction-in-repo");
  const projectRoot = path.dirname(path.dirname(runLayout.root));
  const git = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
    assert.equal(result.status, 0, String(result.stderr));
  };
  git("init", "-q");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  git("remote", "add", "origin", "https://github.com/example/private-target.git");

  const prepared = prepareFrictionLogEnvironment({
    layout: runLayout,
    config: resolvedConfig({ frictionLogEnabled: true })
  });
  const wrapper = prepared.env[FRICTION_LOG_ENV];
  const logRoot = prepared.env[FRICTION_LOG_DIR_ENV];
  assert.ok(wrapper !== undefined && logRoot !== undefined);
  const logged = runWrapper(wrapper, ["log", "forge build times out", "--body", BODY]);
  assert.equal(logged.status, 0, `${String(logged.stderr)}\n${String(logged.stdout)}`);

  assert.equal(fs.existsSync(path.join(projectRoot, ".agents")), false);
  assert.equal(fs.existsSync(path.join(projectRoot, ".github")), false);
  const [entry] = entries(logRoot);
  assert.ok(entry !== undefined);
  const writeUp = fs.readFileSync(path.join(logRoot, ".agents", "friction-log", entry, "friction.md"), "utf8");
  assert.doesNotMatch(writeUp, /private-target/u);
});

test("friction log wrapper refuses publishing, retargeting, and other Frog commands", () => {
  const runLayout = layout("friction-restricted");
  const prepared = prepareFrictionLogEnvironment({
    layout: runLayout,
    config: resolvedConfig({ frictionLogEnabled: true })
  });
  const wrapper = prepared.env[FRICTION_LOG_ENV];
  const logRoot = prepared.env[FRICTION_LOG_DIR_ENV];
  assert.ok(wrapper !== undefined && logRoot !== undefined);

  for (const args of [
    ["publish"],
    ["sync"],
    ["init"],
    ["log", "title", "--body", BODY, "--publish"],
    ["log", "title", "--body", BODY, "--target", "owner/repo"],
    ["log", "title", "--body", BODY, "-t", "viem"],
    ["log", "title", "--body", BODY, "--token=secret"],
    ["log", "title", "--body", BODY, "--cwd", runLayout.root],
    ["log", "title", "--body", BODY, "--open"]
  ]) {
    const result = runWrapper(wrapper, args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${String(result.stderr)}`);
  }
  assert.deepEqual(entries(logRoot), []);
});

test("friction log wrapper quotes embedded paths and strips publishing credentials", () => {
  const script = frictionLogWrapper("/opt/node's/bin/node", "/opt/frog/dist/bin.js", "/runs/it's/friction");
  assert.match(script, /^#!\/bin\/sh\n/u);
  assert.match(script, /unset GITHUB_TOKEN GH_TOKEN GITHUB_API_URL GIT_DIR GIT_WORK_TREE\n/u);
  assert.match(script, /GIT_CEILING_DIRECTORIES='\/runs\/it'\\''s'\n/u);
  assert.match(
    script,
    /exec '\/opt\/node'\\''s\/bin\/node' '\/opt\/frog\/dist\/bin\.js' "\$@" --cwd '\/runs\/it'\\''s\/friction'\n/u
  );
});
