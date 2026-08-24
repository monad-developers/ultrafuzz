import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PARALLEL_LANES = 6;

// #672: concurrently dispatched `prepare:*` worktree tasks failed nondeterministically with a
// Bun-erased `TypeError: undefined is not an object (evaluating 'get')`, and every failure was
// terminal because the preparation Task compiled with retries={0}. These tests drive a real
// `smithers up` (the same Bun-run engine binary production uses) to pin the two engine-level
// facts the fix relies on: simultaneous worktree preparations all succeed, and a preparation
// retry budget of one is honored inside <Worktree> so a single transient hit is absorbed.
test("simultaneously dispatched worktree preparations all succeed under a real Smithers run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-smithers-prep-race-"));
  const workflowDir = path.join(root, ".smithers", "workflows");
  const workflowPath = path.join(workflowDir, "preparation-race.tsx");
  const evidenceRoot = path.join(root, ".ultrafuzz", "preparation-race");
  const runId = `preparation-race-${process.pid}-${Date.now()}`;

  try {
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.mkdirSync(evidenceRoot, { recursive: true });
    initFixtureRepository(root);

    const smithersPackageRoot = fs.realpathSync(path.join(runtimePackageRoot(), "node_modules", "smthrs"));
    fs.symlinkSync(path.dirname(smithersPackageRoot), path.join(root, ".smithers", "node_modules"), "dir");
    fs.writeFileSync(workflowPath, parallelPreparationWorkflowSource({ root, evidenceRoot }), "utf8");

    execFileSync(
      smithersBinary(),
      ["up", workflowPath, "--detach", "--run-id", runId, "--root", root, "--input", "{}", "--format", "json"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, SMITHERS_KEEP_WORKTREES: "", SMITHERS_POST_FAILURE: "0" }
      }
    );

    await waitForSuccessfulCompletion(root, runId, 120_000);

    for (let lane = 0; lane < PARALLEL_LANES; lane += 1) {
      const evidencePath = path.join(evidenceRoot, `lane-${lane}.json`);
      assert.ok(fs.existsSync(evidencePath), `lane ${lane} never finished its preparation`);
      const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as { lane: number; head: string };
      assert.equal(evidence.lane, lane);
      assert.match(evidence.head, /^[0-9a-f]{40}$/u);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree preparation that fails once is retried and the node succeeds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-smithers-prep-retry-"));
  const workflowDir = path.join(root, ".smithers", "workflows");
  const workflowPath = path.join(workflowDir, "preparation-retry.tsx");
  const evidenceRoot = path.join(root, ".ultrafuzz", "preparation-retry");
  const attemptsPath = path.join(evidenceRoot, "attempts.log");
  const runId = `preparation-retry-${process.pid}-${Date.now()}`;

  try {
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.mkdirSync(evidenceRoot, { recursive: true });
    initFixtureRepository(root);

    const smithersPackageRoot = fs.realpathSync(path.join(runtimePackageRoot(), "node_modules", "smthrs"));
    fs.symlinkSync(path.dirname(smithersPackageRoot), path.join(root, ".smithers", "node_modules"), "dir");
    fs.writeFileSync(workflowPath, retriedPreparationWorkflowSource({ root, attemptsPath }), "utf8");

    execFileSync(
      smithersBinary(),
      ["up", workflowPath, "--detach", "--run-id", runId, "--root", root, "--input", "{}", "--format", "json"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, SMITHERS_KEEP_WORKTREES: "", SMITHERS_POST_FAILURE: "0" }
      }
    );

    // With retries={0} this run ends `failed` on the sentinel throw and the wait rejects; the
    // retry budget the #672 fix compiles into preparation Tasks is what lets it finish.
    await waitForSuccessfulCompletion(root, runId, 60_000);

    const attempts = fs
      .readFileSync(attemptsPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    assert.deepEqual(attempts, ["attempt", "attempt"], "the preparation body must run exactly twice");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function initFixtureRepository(root: string): void {
  execGit(root, ["init", "--quiet", "--initial-branch=main"]);
  execGit(root, ["config", "user.name", "Ultrafuzz Synthetic Test"]);
  execGit(root, ["config", "user.email", "synthetic@example.invalid"]);
  fs.writeFileSync(path.join(root, ".gitignore"), "/artifacts/\n/.smithers/\n/.ultrafuzz/\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# Synthetic preparation fixture\n", "utf8");
  execGit(root, ["add", ".gitignore", "README.md"]);
  execGit(root, ["commit", "--quiet", "-m", "synthetic fixture"]);
}

function parallelPreparationWorkflowSource(input: { root: string; evidenceRoot: string }): string {
  return `/** @jsxImportSource smthrs */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const root = ${JSON.stringify(input.root)};
const evidenceRoot = ${JSON.stringify(input.evidenceRoot)};
const lanes = [0, 1, 2, 3, 4, 5];
const { Workflow, Worktree, Task, Parallel, smithers, outputs } = createSmithers({
  input: z.object({}),
  preparation: z.object({ prepared: z.literal(true) })
});

export default smithers(() => (
  <Workflow name="synthetic-preparation-race">
    <Parallel id="synthetic-preparation-lanes">
      {lanes.map((lane) => {
        const worktreePath = path.join(root, ".smithers", "worktrees", "prep-race-" + lane);
        return (
          <Worktree key={"lane-" + lane} path={worktreePath} branch={"synthetic-prep-race-" + lane}>
            <Task id={"prepare:lane-" + lane} output={outputs.preparation} retries={1}>
              {() => {
                const head = execFileSync("git", ["rev-parse", "HEAD"], {
                  cwd: worktreePath,
                  encoding: "utf8"
                }).trim();
                const mirror = path.join(worktreePath, "artifacts", "lane-" + lane);
                fs.mkdirSync(mirror, { recursive: true });
                fs.writeFileSync(path.join(mirror, "prepared.txt"), head + "\\n", "utf8");
                fs.writeFileSync(
                  path.join(evidenceRoot, "lane-" + lane + ".json"),
                  JSON.stringify({ lane, head }),
                  "utf8"
                );
                return { prepared: true };
              }}
            </Task>
          </Worktree>
        );
      })}
    </Parallel>
  </Workflow>
));
`;
}

function retriedPreparationWorkflowSource(input: { root: string; attemptsPath: string }): string {
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import path from "node:path";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const root = ${JSON.stringify(input.root)};
const attemptsPath = ${JSON.stringify(input.attemptsPath)};
const worktreePath = path.join(root, ".smithers", "worktrees", "prep-retry");
const { Workflow, Worktree, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  preparation: z.object({ prepared: z.literal(true) })
});

export default smithers(() => (
  <Workflow name="synthetic-preparation-retry">
    <Worktree path={worktreePath} branch="synthetic-prep-retry">
      <Task id="prepare:retried" output={outputs.preparation} retries={1}>
        {() => {
          const firstAttempt = !fs.existsSync(attemptsPath);
          fs.appendFileSync(attemptsPath, "attempt\\n", "utf8");
          if (firstAttempt) throw new Error("synthetic transient preparation failure");
          return { prepared: true };
        }}
      </Task>
    </Worktree>
  </Workflow>
));
`;
}

async function waitForSuccessfulCompletion(root: string, runId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let status = "unknown";
  while (Date.now() < deadline) {
    try {
      const inspected = JSON.parse(
        execFileSync(smithersBinary(), ["inspect", runId, "--format", "json"], {
          cwd: root,
          encoding: "utf8"
        })
      ) as { status?: string; run?: { status?: string } };
      status = inspected.status ?? inspected.run?.status ?? status;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (status === "finished") return;
    if (["failed", "cancelled", "canceled"].includes(status)) {
      throw new Error(`synthetic Smithers workflow ended with status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`synthetic Smithers workflow did not finish; final status ${status}`);
}

function smithersBinary(): string {
  return path.join(
    runtimePackageRoot(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "smithers.cmd" : "smithers"
  );
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function runtimePackageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      const value = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: string };
      if (value.name === "@ultrafuzz/runtime") return current;
    }
    current = path.dirname(current);
  }
  throw new Error("runtime package root not found");
}
