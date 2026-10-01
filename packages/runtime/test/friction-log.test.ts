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
function runFixture(): { target: string; runRoot: string; command: string; entries: string } {
  const target = fs.realpathSync(temporaryRoot("ultrafuzz-friction-target-"));
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
    const logged = run(fixture, ["log", "forge guard aborts - on darwin", "--severity", "major", "--body", BODY], {
      GITHUB_TOKEN: "must-not-publish"
    });
    assert.equal(logged.status, 0, logged.stderr + logged.stdout);
    const [id] = fs.readdirSync(fixture.entries);
    assert.match(id ?? "", /^\d{14}-forge-guard-aborts$/u);
    const entry = fs.readFileSync(path.join(fixture.entries, id ?? "", "friction.md"), "utf8");
    assert.match(entry, /^---\ntitle: 'forge guard aborts - on darwin'\nseverity: 'major'\n/u);
    assert.match(entry, /## Minimal Reproducible Example\nforge test/u);

    // A value that starts with a dash is data, not an option.
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

test("the friction log wrapper is identical for every run and pins its paths from its own location", () => {
  const wrapper = frictionLogWrapper("/usr/bin/node", "/opt/frog/bin.js");
  assert.equal(wrapper, frictionLogWrapper("/usr/bin/node", "/opt/frog/bin.js"));
  assert.match(wrapper, /run_root=\$\(CDPATH= cd -- "\$\(dirname -- "\$0"\)\/\.\." && pwd -P\)/u);
  // --cwd precedes every agent argument, so no argument can consume or replace it.
  assert.match(
    wrapper,
    /exec '\/usr\/bin\/node' '\/opt\/frog\/bin\.js' "\$command" --cwd "\$run_root\/friction" "\$@"\n$/u
  );
  assert.match(wrapper, /\nunset GITHUB_TOKEN GH_TOKEN GITHUB_API_URL GIT_DIR GIT_WORK_TREE\n/u);
  assert.match(wrapper, /\nGIT_CEILING_DIRECTORIES=\$run_root\nexport GIT_CEILING_DIRECTORIES\n/u);
  assert.match(frictionLogWrapper("/it's/node", "/opt/frog/bin.js"), /exec '\/it'\\''s\/node'/u);
});
