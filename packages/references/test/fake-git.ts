import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FakeGitInstallation {
  binDir: string;
  logPath: string;
}

/** Installs a deterministic Git stand-in that enforces the reference transport environment. */
export function installFakeGit(root: string): FakeGitInstallation {
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "git-calls.jsonl");
  fs.mkdirSync(binDir, { recursive: true });
  const gitPath = path.join(binDir, "git");
  fs.writeFileSync(
    gitPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const env = process.env;

function reject(message) {
  process.stderr.write(message + "\\n");
  process.exit(86);
}

const count = Number(env.GIT_CONFIG_COUNT);
if (!Number.isSafeInteger(count) || count < 1 || count > 2) reject("invalid isolated config count");
const config = [];
for (let index = 0; index < count; index += 1) {
  const key = env["GIT_CONFIG_KEY_" + index];
  const value = env["GIT_CONFIG_VALUE_" + index];
  if (key === undefined || value === undefined) reject("incomplete isolated config entry");
  config.push([key, value]);
}
if (!config.some(([key, value]) => key === "credential.helper" && value === "")) {
  reject("credential helper was not disabled");
}
if (env.GIT_TERMINAL_PROMPT !== "0" || env.GIT_ASKPASS !== "") reject("interactive auth was not disabled");
if (env.GIT_CONFIG_NOSYSTEM !== "1") reject("system config was not disabled");
if (env.GIT_CONFIG_GLOBAL !== env.UFZ_FAKE_GIT_DEV_NULL) reject("global config was not isolated");
if (env.GIT_CONFIG_SYSTEM !== env.UFZ_FAKE_GIT_DEV_NULL) reject("system config was not isolated");
if (env.GIT_CEILING_DIRECTORIES !== process.cwd()) reject("repository discovery ceiling is not command-local");
if (env.UFZ_FAKE_GIT_CALLER_CWD && path.resolve(env.UFZ_FAKE_GIT_CALLER_CWD) === process.cwd()) {
  reject("remote command ran inside the caller repository");
}
for (const forbidden of ["GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE", "GIT_TRACE", "GIT_CURL_VERBOSE"]) {
  if (env[forbidden] !== undefined) reject("inherited Git injection survived: " + forbidden);
}
if (env.ULTRAFUZZ_REFERENCE_GITHUB_TOKEN !== undefined || env.ULTRAFUZZ_REFERENCE_GITHUB_REPOS !== undefined) {
  reject("raw reference credential variables reached Git");
}
const ambientSentinel = env.UFZ_FAKE_GIT_AMBIENT_SENTINEL;
if (ambientSentinel && config.some((entry) => entry.some((value) => value.includes(ambientSentinel)))) {
  reject("ambient Git config reached the isolated command");
}
const authHeaders = config.filter(
  ([key, value]) => key.startsWith("http.") && key.endsWith(".extraheader") && value.startsWith("AUTHORIZATION: basic ")
);
const expectedAuth = env.UFZ_FAKE_GIT_EXPECT_AUTH;
if (expectedAuth === "") {
  if (authHeaders.length !== 0) reject("anonymous command received an authorization header");
} else if (authHeaders.length !== 1 || authHeaders[0][1] !== expectedAuth) {
  reject("authenticated command did not receive the exact scoped header");
}

if (env.UFZ_FAKE_GIT_LOG) {
  fs.appendFileSync(env.UFZ_FAKE_GIT_LOG, JSON.stringify({ args, config }) + "\\n");
}
if (env.UFZ_FAKE_GIT_FAIL_COMMAND === args[0]) {
  process.stderr.write(env.UFZ_FAKE_GIT_FAILURE_TEXT || "injected Git failure");
  process.exit(87);
}

switch (args[0]) {
  case "init":
  case "remote":
    break;
  case "fetch":
    if (!args.includes("--filter=blob:none")) reject("reference fetch was not filtered");
    break;
  case "cat-file":
    process.stdout.write("blob\\n");
    break;
  case "show": {
    const object = args[1] || "";
    const separator = object.indexOf(":");
    if (separator < 0 || !env.UFZ_FAKE_GIT_FIXTURE) reject("invalid fake show request");
    process.stdout.write(fs.readFileSync(path.join(env.UFZ_FAKE_GIT_FIXTURE, object.slice(separator + 1))));
    break;
  }
  case "ls-tree": {
    if (!env.UFZ_FAKE_GIT_FIXTURE) reject("missing fake tree fixture");
    const files = [];
    const pending = [""];
    while (pending.length > 0) {
      const relativeDir = pending.pop();
      const absoluteDir = path.join(env.UFZ_FAKE_GIT_FIXTURE, relativeDir);
      for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const relative = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) pending.push(relative);
        else if (entry.isFile()) files.push(relative.split(path.sep).join("/"));
      }
    }
    files.sort();
    process.stdout.write(files.map((file) => "100644 blob " + "a".repeat(40) + "\\t" + file + "\\0").join(""));
    break;
  }
  case "ls-remote":
    process.stdout.write((env.UFZ_FAKE_GIT_HEAD || "b".repeat(40)) + "\\tHEAD\\n");
    break;
  default:
    reject("unexpected fake Git command: " + args.join(" "));
}
`,
    { mode: 0o700 }
  );
  return { binDir, logPath };
}

export function withProcessEnv<T>(overrides: Record<string, string | undefined>, callback: () => T): T {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function fakeGitCommands(logPath: string): string[][] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { args: string[] }).args);
}

export function fakeGitIsolationEnv(
  fake: FakeGitInstallation,
  fixtureRoot: string,
  expectedAuth: string,
  ambientSentinel: string,
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    PATH: `${fake.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    UFZ_FAKE_GIT_LOG: fake.logPath,
    UFZ_FAKE_GIT_FIXTURE: fixtureRoot,
    UFZ_FAKE_GIT_DEV_NULL: os.devNull,
    UFZ_FAKE_GIT_EXPECT_AUTH: expectedAuth,
    UFZ_FAKE_GIT_AMBIENT_SENTINEL: ambientSentinel,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: ambientSentinel,
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${ambientSentinel}`,
    GIT_CONFIG_PARAMETERS: `'credential.helper'='${ambientSentinel}'`,
    GIT_CONFIG_GLOBAL: path.join(fixtureRoot, "ambient-global.gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(fixtureRoot, "ambient-system.gitconfig"),
    GIT_DIR: path.join(fixtureRoot, "ambient-git-dir"),
    GIT_CEILING_DIRECTORIES: path.join(fixtureRoot, "ambient-ceiling"),
    GIT_TRACE: "1",
    GIT_CURL_VERBOSE: "1",
    ...overrides
  };
}
