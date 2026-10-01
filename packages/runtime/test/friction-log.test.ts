import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { FRICTION_LOG_COMMAND_PATH, frictionLogWrapper, resolveFrogBin } from "../src/friction-log.js";
import { temporaryRoot } from "./temporary-root.js";

const BODY = [
  "## Expected Behavior",
  "forge runs",
  "## Current Behavior",
  "forge aborts",
  "## Possible Solution",
  "skip ulimit -v",
  "## Minimal Reproducible Example",
  "forge test",
  "## Context",
  "macOS"
].join("\n");

// A target repository with a run root inside it, as Ultrafuzz lays one out.
function runFixture(prefix = "ultrafuzz-friction-target-"): {
  target: string;
  runRoot: string;
  command: string;
  entries: string;
} {
  const target = fs.realpathSync(temporaryRoot(prefix));
  spawnSync("git", ["init", "-q", target], { stdio: "ignore" });
  const runRoot = path.join(target, ".ultrafuzz", "runs", "run-1");
  const command = path.join(runRoot, ...FRICTION_LOG_COMMAND_PATH.split("/"));
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.mkdirSync(path.join(runRoot, "friction"), { recursive: true });
  fs.writeFileSync(command, frictionLogWrapper(process.execPath, resolveFrogBin()), { mode: 0o700 });
  return { target, runRoot, command, entries: path.join(runRoot, "friction", ".agents", "friction-log") };
}

function run(fixture: { target: string; command: string }, args: string[], env: Record<string, string> = {}) {
  return spawnSync(fixture.command, args, {
    cwd: fixture.target,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

test("the friction log command records and lists entries with the pinned Frog inside the run only", () => {
  const fixture = runFixture();
  try {
    // An inherited Frog store would send the entry to Postgres, and fail to reach this one.
    const logged = run(fixture, ["log", "forge guard aborts - on darwin", "--severity", "major", "--body", BODY], {
      GITHUB_TOKEN: "must-not-publish",
      FROG_DATABASE_URL: "postgres://127.0.0.1:9/frog"
    });
    assert.equal(logged.status, 0, logged.stderr + logged.stdout);
    const [id] = fs.readdirSync(fixture.entries);
    assert.match(id ?? "", /^\d{14}-forge-guard-aborts$/u);
    const entry = fs.readFileSync(path.join(fixture.entries, id ?? "", "friction.md"), "utf8");
    assert.match(entry, /^---\ntitle: 'forge guard aborts - on darwin'\nseverity: 'major'\n/u);
    assert.match(entry, /## Minimal Reproducible Example\nforge test/u);

    // A value that starts with a dash is data, not an option. Only incur's own flags are refused as values.
    const dashed = run(fixture, ["log", "second problem", "-s", "minor", "-b", `- first bullet\n${BODY}`]);
    assert.equal(dashed.status, 0, dashed.stderr + dashed.stdout);

    const listed = run(fixture, ["list", "--format", "json"]);
    assert.equal(listed.status, 0, listed.stderr + listed.stdout);
    assert.match(listed.stdout, /forge guard aborts - on darwin/u);
    assert.match(listed.stdout, /second problem/u);

    // Frog's own duplicate check reports a clean, coded failure.
    const duplicate = run(fixture, ["log", "forge guard aborts - on darwin", "--body", BODY]);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stdout + duplicate.stderr, /DUPLICATE_FRICTION/u);

    // Nothing lands in the target repository's root.
    assert.deepEqual(fs.readdirSync(fixture.target).sort(), [".git", ".ultrafuzz"]);
  } finally {
    fs.rmSync(fixture.target, { recursive: true, force: true });
  }
});

test("the friction log command keeps entries in the run when the run root contains a colon", () => {
  // GIT_CEILING_DIRECTORIES is a `:`-separated list, so a ceiling at this run root let Frog find the target.
  const fixture = runFixture("ultrafuzz-friction-a:b-target-");
  try {
    const logged = run(fixture, ["log", "colon in the run root", "--body", BODY]);
    assert.equal(logged.status, 0, logged.stderr + logged.stdout);
    assert.equal(fs.readdirSync(fixture.entries).length, 1);
    const listed = run(fixture, ["list", "--format", "json"]);
    assert.equal(listed.status, 0, listed.stderr + listed.stdout);
    assert.match(listed.stdout, /colon in the run root/u);
    assert.deepEqual(fs.readdirSync(fixture.target).sort(), [".git", ".ultrafuzz"]);
  } finally {
    fs.rmSync(fixture.target, { recursive: true, force: true });
  }
});

test("the friction log command refuses every Frog surface beyond local log and list", () => {
  const fixture = runFixture();
  try {
    const refused: Array<[string[], RegExp]> = [
      [["publish"], /only 'log' and 'list' are available/u],
      [["sync"], /only 'log' and 'list' are available/u],
      [["--mcp"], /only 'log' and 'list' are available/u],
      [["log", "x", "--body", BODY, "--publish"], /--publish is not available/u],
      [["log", "x", "--body", BODY, "--update"], /--update is not available/u],
      [["list", "--llms"], /--llms is not available/u],
      [["log", "x", "--body", BODY, "--cwd", fixture.target], /--cwd is not available/u],
      [["log", "x", "--body", BODY, "--cwd=/"], /--cwd=\/ is not available/u],
      [["log", "x", "--body", BODY, "-t", "viem"], /-t is not available/u],
      [["log", "x", "--body", BODY, "--token", "t"], /--token is not available/u],
      [["log", "--", "x"], /-- is not available/u],
      // incur acts on its own flags anywhere in argv, so they are refused where a value belongs too.
      [["log", "x", "--body", "--llms"], /--llms is not available/u],
      [["log", "x", "-s", "--schema"], /--schema is not available/u],
      [["log", "x", "--label", "--help"], /--help is not available/u],
      [["log", "x", "--body", "--mcp"], /--mcp is not available/u],
      // incur reads --format only with a separate value.
      [["list", "--format=json"], /--format=json is not available/u],
      // A trailing value-taking option cannot consume anything Ultrafuzz passes after it.
      [["log", "x", "--body", BODY, "--label"], /the last option is missing its value/u]
    ];
    for (const [args, message] of refused) {
      const result = run(fixture, args);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}${result.stdout}`);
      assert.match(result.stderr, message);
    }
    assert.equal(fs.existsSync(fixture.entries), false);
  } finally {
    fs.rmSync(fixture.target, { recursive: true, force: true });
  }
});

// Stands in for Frog and records what the wrapper hands it.
const RECORDER = `import fs from "node:fs";
fs.writeFileSync(
  process.env.FRICTION_RECORD,
  JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin: fs.readFileSync(0, "utf8") })
);
`;

test("the friction log wrapper hands Frog its run's paths, a fenced environment and no stdin", () => {
  const root = fs.realpathSync(temporaryRoot("ultrafuzz-friction-wrapper-"));
  try {
    const recorder = path.join(root, "recorder.mjs");
    fs.writeFileSync(recorder, RECORDER);
    // The node path is shell-quoted, so a quote in it cannot break out.
    const node = path.join(root, "it's", "node");
    fs.mkdirSync(path.dirname(node));
    fs.symlinkSync(process.execPath, node);
    const wrapper = frictionLogWrapper(node, recorder);
    // The same bytes serve every run: the wrapper finds its run from its own location.
    for (const runRoot of [path.join(root, "run-1"), path.join(root, "a:b", "run-2")]) {
      const command = path.join(runRoot, ...FRICTION_LOG_COMMAND_PATH.split("/"));
      fs.mkdirSync(path.dirname(command), { recursive: true });
      fs.writeFileSync(command, wrapper, { mode: 0o700 });
      const record = path.join(runRoot, "record.json");
      const inherited = {
        GITHUB_TOKEN: "token",
        GH_TOKEN: "token",
        GITHUB_API_URL: "https://github.example.invalid",
        FROG_DATABASE_URL: "postgres://127.0.0.1:9/frog",
        FROG_NAMESPACE: "namespace",
        FROG_SCHEMA: "schema",
        GIT_WORK_TREE: root
      };
      const result = spawnSync(command, ["log", "x", "--body", "b"], {
        cwd: root,
        encoding: "utf8",
        input: "piped input",
        env: { ...process.env, ...inherited, GIT_DIR: path.join(root, ".git"), FRICTION_RECORD: record }
      });
      assert.equal(result.status, 0, result.stderr);
      const seen = JSON.parse(fs.readFileSync(record, "utf8")) as {
        argv: string[];
        env: Record<string, string | undefined>;
        stdin: string;
      };
      // --cwd precedes every agent argument, so no argument can consume or replace it.
      assert.deepEqual(seen.argv, ["log", "--cwd", path.join(runRoot, "friction"), "x", "--body", "b"]);
      // With /dev/null on stdin Frog cannot prompt or open an editor; NO_UPDATE_NOTIFIER stops incur's update check.
      assert.equal(seen.stdin, "");
      assert.equal(seen.env.NO_UPDATE_NOTIFIER, "1");
      // Git and gh are pointed at paths that do not exist.
      assert.equal(seen.env.GIT_DIR, path.join(runRoot, "friction-bin", "no-git"));
      assert.equal(seen.env.GH_CONFIG_DIR, path.join(runRoot, "friction-bin", "no-gh"));
      assert.deepEqual(fs.readdirSync(path.dirname(command)), ["ultrafuzz-friction-log"]);
      for (const name of Object.keys(inherited)) assert.equal(seen.env[name], undefined, name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
