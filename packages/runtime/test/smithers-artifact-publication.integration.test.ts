import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureContents = "verified synthetic artifact\n";

test("verified ignored artifacts survive a real successful Smithers worktree reap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-smithers-publication-"));
  const workflowDir = path.join(root, ".smithers", "workflows");
  const workflowPath = path.join(workflowDir, "artifact-publication.tsx");
  const worktreePath = path.join(root, ".smithers", "worktrees", "artifact-publication");
  const canonicalRoot = path.join(root, ".ultrafuzz", "canonical-artifacts");
  const canonicalPath = path.join(canonicalRoot, "result.md");
  const runId = `artifact-publication-${process.pid}-${Date.now()}`;

  try {
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.mkdirSync(canonicalRoot, { recursive: true });
    execGit(root, ["init", "--quiet", "--initial-branch=main"]);
    execGit(root, ["config", "user.name", "Ultrafuzz Synthetic Test"]);
    execGit(root, ["config", "user.email", "synthetic@example.invalid"]);
    fs.writeFileSync(path.join(root, ".gitignore"), "/artifacts/\n/.smithers/\n/.ultrafuzz/\n", "utf8");
    fs.writeFileSync(path.join(root, "README.md"), "# Synthetic fixture\n", "utf8");
    execGit(root, ["add", ".gitignore", "README.md"]);
    execGit(root, ["commit", "--quiet", "-m", "synthetic fixture"]);

    const smithersPackageRoot = fs.realpathSync(path.join(runtimePackageRoot(), "node_modules", "smthrs"));
    fs.symlinkSync(path.dirname(smithersPackageRoot), path.join(root, ".smithers", "node_modules"), "dir");
    fs.writeFileSync(
      workflowPath,
      syntheticWorkflowSource({
        artifactModule: pathToFileURL(path.join(workspaceRoot(), "packages", "artifacts", "dist", "index.js")).href,
        canonicalRoot,
        worktreePath
      }),
      "utf8"
    );

    execFileSync(
      smithersBinary(),
      ["up", workflowPath, "--detach", "--run-id", runId, "--root", root, "--input", "{}", "--format", "json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          SMITHERS_KEEP_WORKTREES: "",
          SMITHERS_POST_FAILURE: "0"
        }
      }
    );

    await waitForSuccessfulReap(root, runId, worktreePath);

    assert.equal(fs.existsSync(worktreePath), false, "the successful task worktree should be reaped");
    assert.equal(fs.readFileSync(canonicalPath, "utf8"), fixtureContents);
    assert.doesNotMatch(execGit(root, ["worktree", "list", "--porcelain"]), /artifact-publication/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function syntheticWorkflowSource(input: {
  artifactModule: string;
  canonicalRoot: string;
  worktreePath: string;
}): string {
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import path from "node:path";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const { publishFileDurableExclusive } = await import(${JSON.stringify(input.artifactModule)});
const canonicalRoot = ${JSON.stringify(input.canonicalRoot)};
const worktreePath = ${JSON.stringify(input.worktreePath)};
const contents = ${JSON.stringify(fixtureContents)};
const { Workflow, Worktree, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  write: z.object({ written: z.literal(true) }),
  verify: z.object({ published: z.literal(true) })
});

export default smithers(() => (
  <Workflow name="synthetic-artifact-publication">
    <Worktree path={worktreePath} branch="synthetic-artifact-publication">
      <Task id="write" output={outputs.write} retries={0}>
        {() => {
          const mirror = path.join(worktreePath, "artifacts", "attempt");
          fs.mkdirSync(mirror, { recursive: true });
          fs.writeFileSync(path.join(mirror, "result.md"), contents, { encoding: "utf8", mode: 0o600 });
          return { written: true };
        }}
      </Task>
      <Task id="verify" output={outputs.verify} dependsOn={["write"]} retries={0}>
        {() => {
          const source = path.join(worktreePath, "artifacts", "attempt", "result.md");
          const verified = fs.readFileSync(source);
          if (verified.toString("utf8") !== contents) throw new Error("synthetic artifact validation failed");
          publishFileDurableExclusive(canonicalRoot, "result.md", verified);
          return { published: true };
        }}
      </Task>
    </Worktree>
  </Workflow>
));
`;
}

async function waitForSuccessfulReap(root: string, runId: string, worktreePath: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let status = "unknown";
  while (Date.now() < deadline) {
    let inspected: { status?: string; run?: { status?: string } };
    try {
      inspected = JSON.parse(
        execFileSync(smithersBinary(), ["inspect", runId, "--format", "json"], {
          cwd: root,
          encoding: "utf8"
        })
      ) as { status?: string; run?: { status?: string } };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    status = inspected.status ?? inspected.run?.status ?? status;
    if (status === "finished" && !fs.existsSync(worktreePath)) return;
    if (["failed", "cancelled", "canceled"].includes(status)) {
      throw new Error(`synthetic Smithers workflow ended with status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`synthetic Smithers workflow did not reap its worktree; final status ${status}`);
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

function workspaceRoot(): string {
  return path.resolve(runtimePackageRoot(), "../..");
}
