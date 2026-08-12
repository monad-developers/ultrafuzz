import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

import { assertRegularFileInside, writeFileDurable } from "@ultrafuzz/artifacts";

import { validateWorkspacePatchCapture } from "../src/workspace-handoff.js";

/**
 * A node re-executed in a NEW recovery generation rejects its own previous generation's workspace
 * patch as tampering (issue #357).
 *
 * R52's `stateful-invariant-campaign` failed with
 *
 *   artifact-contract failure: workspace patch artifact was modified workspace.patch
 *
 * The mtimes on its volume name the mechanism. The node ran in two generations,
 * 18:37:07Z -> 18:52:34Z and then 19:00:54Z -> 19:15:48Z, and its artifact directory held:
 *
 *   26001  19:15:46Z  invariant-suite-baseline.json
 *    1773  19:15:46Z  invariant-suite-manifest.json
 *     161  18:37:07Z  workspace-patch-baseline.json      <- generation 0 preparation
 *     435  18:52:34Z  workspace-patch.json               <- generation 0 OUTPUT
 *    1141  18:52:34Z  workspace.patch                    <- generation 0 OUTPUT
 *
 * Generation 1 re-ran the agent and captured a patch that legitimately differed from generation 0's,
 * and the guard found the survivor non-empty and unequal and threw. Nothing clears the pair across
 * that boundary: `resetTaskArtifactsForRetry` only fires for `attempt > 1` within ONE process, and a
 * new generation starts a new process at attempt 1. (The run log's `attempt=1 maxAttempts=1` shows
 * this concretely, but the reason is structural rather than a property of that configuration.)
 *
 * The guard is load-bearing and must stay, so the discriminator cannot be content equality -- that is
 * exactly what conflates "my own superseded output" with "someone edited this". Two facts together
 * answer it: the pair validates as a well-formed capture whose manifest digest matches its patch, and
 * its `base_tree` is THIS node's baseline rather than a dependency's, whose artifact dirs agents can
 * read.
 *
 * These tests use the REAL `validateWorkspacePatchCapture`, the REAL `writeFileDurable` and
 * `assertRegularFileInside`, and a REAL git repository, so the durable write path and the validator
 * are exercised rather than simulated. `captureWorkspacePatch` is the one substituted collaborator:
 * it stands in for the agent's work, which is what each scenario needs to vary. They also lift
 * `materializeWorkspacePatch` itself so the CALL is pinned -- the sibling #312 suite records that
 * dropping such a call left all of its rule-level tests green.
 */

const runtimePackageRoot = findRuntimePackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const workflowTemplatePath = path.join(runtimePackageRoot, "src", "templates", "smithers", "workflows", "workflow.tsx");

function findRuntimePackageRoot(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as { name?: string };
      if (manifest.name === "@ultrafuzz/runtime") return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("unable to locate the @ultrafuzz/runtime package root");
    current = parent;
  }
}

const WORKSPACE_PATCH_SCHEMA_VERSION = "ultrafuzz.workspace-patch.v1";

// This node's own baseline, and a DIFFERENT node's, so "is this a capture of my baseline" can be
// distinguished from "does this merely look like a capture".
const OWN_BASELINE = "b92f9cf321dd71d62ac64cafb0611f1eb50613ae";
const DEPENDENCY_BASELINE = "4fefa8df7da3000000000000000000000000000a";
const RESULT_TREE = "00d4d27499671615f4d0fd2871709a4dfdf880a4";

// R52's generation 0 output and the differing capture generation 1 took.
const GENERATION_0_PATCH = "diff --git a/a.t.sol b/a.t.sol\n+++ generation 0\n";
const GENERATION_1_PATCH = "diff --git a/a.t.sol b/a.t.sol\n+++ generation 1\n";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A manifest self-consistent with `patch`, the way `captureWorkspacePatch` builds one. */
function manifestObject(patch: string, baseCommit: string, baseTree = OWN_BASELINE): Record<string, unknown> {
  return {
    schema_version: WORKSPACE_PATCH_SCHEMA_VERSION,
    base_commit: baseCommit,
    base_tree: baseTree,
    result_tree: RESULT_TREE,
    patch_sha256: sha256(patch),
    source_snapshot: { status: "preserved", protected_roots: ["contracts", "src"] },
    files: [{ path: "a.t.sol" }]
  };
}

function manifestText(patch: string, baseCommit: string, baseTree = OWN_BASELINE): string {
  return `${JSON.stringify(manifestObject(patch, baseCommit, baseTree), null, 2)}\n`;
}

/** Lift the named top-level template functions and evaluate them over injected collaborators. */
function loadTemplateFunctions(
  names: readonly string[],
  returned: string,
  collaborators: Record<string, unknown>
): unknown {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const slice = (name: string): string => {
    const start = source.indexOf(`\nfunction ${name}(`);
    assert.ok(start >= 0, `the template does not declare a top-level ${name}`);
    const end = source.indexOf("\n}\n", start);
    assert.ok(end > start, `unterminated helper ${name}`);
    return source.slice(start, end + 3);
  };
  const declaration = [...names.map(slice), `\nreturn ${returned};`].join("\n");
  const emitted = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  const keys = Object.keys(collaborators);
  return new Function(...keys, emitted)(...keys.map((key) => collaborators[key]));
}

type Materializer = (task: unknown) => void;

const TEMPLATE_FUNCTIONS = [
  "isStrictlyInsideDirectory",
  "resolveRegularArtifactFile",
  "holdsSupersededWorkspacePatchPair",
  "writeWorkspacePatchArtifact",
  "materializeWorkspacePatch"
] as const;

/**
 * `captureWorkspacePatch` stands in for the agent's work, which is what each scenario varies. Every
 * other collaborator is the production function, so the durable write path, the path-safety checks and
 * the capture validator all run for real.
 */
function collaborators(
  captured: { patch: string; manifest: unknown },
  roots: readonly string[],
  write: (target: string, contents: string) => void = writeFileDurable
): Record<string, unknown> {
  return {
    path,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    mkdirSync: fs.mkdirSync,
    statSync: fs.statSync,
    realpathSync: fs.realpathSync,
    writeFileDurable: write,
    assertRegularFileInside,
    validateWorkspacePatchCapture,
    captureWorkspacePatch: () => captured,
    taskPublishesWorkspacePatch: () => true,
    taskArtifactRoots: () => [...roots],
    workspacePatchBaselineTrees: new Map([["attempt", OWN_BASELINE]])
  };
}

function loadMaterializer(root: string, captured: { patch: string; manifest: unknown }): Materializer {
  return loadTemplateFunctions(
    TEMPLATE_FUNCTIONS,
    "materializeWorkspacePatch",
    collaborators(captured, [root])
  ) as Materializer;
}

/**
 * A real git repository, because `validateWorkspacePatchCapture` compares the manifest's `base_commit`
 * against `git rev-parse HEAD`. The artifact root lives outside it so the fixture cannot accidentally
 * depend on the artifacts being tracked.
 */
function withFixture(body: (fixture: { root: string; workspaceRoot: string; head: string }) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "uf357-"));
  try {
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(base, "ws-")));
    const root = fs.realpathSync(fs.mkdtempSync(path.join(base, "artifacts-")));
    const git = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
      });
    git("init", "--quiet", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    fs.writeFileSync(path.join(workspaceRoot, "a.t.sol"), "contract A {}\n");
    git("add", "a.t.sol");
    git("commit", "--quiet", "-m", "base");
    body({ root, workspaceRoot, head: git("rev-parse", "HEAD").trim() });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function task(fixture: { root: string; workspaceRoot: string }): unknown {
  return {
    attemptId: "attempt",
    workspacePath: fixture.workspaceRoot,
    productionSourceRoots: ["contracts", "src"],
    metadata: { artifacts: { dir: fixture.root } }
  };
}

function capturedGeneration1(head: string): { patch: string; manifest: unknown } {
  return { patch: GENERATION_1_PATCH, manifest: manifestObject(GENERATION_1_PATCH, head) };
}

const REJECTED = /workspace patch artifact was modified workspace\.patch/u;

test("#357 a re-executed node replaces its own superseded workspace patch", () => {
  withFixture((fixture) => {
    // Exactly R52's surviving pair: generation 0's patch plus the manifest published with it.
    writeFileDurable(path.join(fixture.root, "workspace.patch"), GENERATION_0_PATCH);
    writeFileDurable(path.join(fixture.root, "workspace-patch.json"), manifestText(GENERATION_0_PATCH, fixture.head));

    loadMaterializer(fixture.root, capturedGeneration1(fixture.head))(task(fixture));

    // Generation 1's capture must win outright: this is the write R52 never got to make.
    assert.equal(fs.readFileSync(path.join(fixture.root, "workspace.patch"), "utf8"), GENERATION_1_PATCH);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.root, "workspace-patch.json"), "utf8")) as {
      patch_sha256: string;
    };
    assert.equal(manifest.patch_sha256, sha256(GENERATION_1_PATCH));
  });
});

test("#357 another node's capture is not treated as this node's superseded output", () => {
  withFixture((fixture) => {
    // Well-formed, digest-consistent, and NOT this node's: it declares a dependency's base tree. Agents
    // can read every dependency artifact dir, so copying such a pair here is a reachable mistake. Only
    // the base_tree identity separates this from the accepted case above.
    writeFileDurable(path.join(fixture.root, "workspace.patch"), GENERATION_0_PATCH);
    writeFileDurable(
      path.join(fixture.root, "workspace-patch.json"),
      manifestText(GENERATION_0_PATCH, fixture.head, DEPENDENCY_BASELINE)
    );

    assert.throws(() => loadMaterializer(fixture.root, capturedGeneration1(fixture.head))(task(fixture)), REJECTED);
  });
});

test("#357 an agent-authored workspace patch is still rejected", () => {
  withFixture((fixture) => {
    // No manifest at all: nothing attests that the runtime produced this patch. If this ever passes by
    // writing the capture instead of throwing, the fix has removed the protection rather than narrowing
    // it.
    writeFileDurable(path.join(fixture.root, "workspace.patch"), "diff --git a/x b/x\n+++ authored by the agent\n");

    assert.throws(() => loadMaterializer(fixture.root, capturedGeneration1(fixture.head))(task(fixture)), REJECTED);
  });
});

test("#357 a patch whose manifest digest does not match it is still rejected", () => {
  withFixture((fixture) => {
    // The pair does not cohere: the manifest's `patch_sha256` describes different bytes. That is
    // tampering with one half, or a truncated write, and neither is a superseded runtime capture.
    writeFileDurable(path.join(fixture.root, "workspace.patch"), GENERATION_0_PATCH);
    writeFileDurable(path.join(fixture.root, "workspace-patch.json"), manifestText("unrelated bytes\n", fixture.head));

    assert.throws(() => loadMaterializer(fixture.root, capturedGeneration1(fixture.head))(task(fixture)), REJECTED);
  });
});

test("#357 a capture against a different pinned commit is still rejected", () => {
  withFixture((fixture) => {
    // Re-pinning the target between generations changes what the patch describes. The real validator
    // compares `base_commit` against `git rev-parse HEAD`, so this pair is not this run's output even
    // though it is internally self-consistent.
    writeFileDurable(path.join(fixture.root, "workspace.patch"), GENERATION_0_PATCH);
    writeFileDurable(
      path.join(fixture.root, "workspace-patch.json"),
      manifestText(GENERATION_0_PATCH, "6959e3219b5506bf2acae18551cbb2a68a5b8fba")
    );

    assert.throws(() => loadMaterializer(fixture.root, capturedGeneration1(fixture.head))(task(fixture)), REJECTED);
  });
});

test("#357 a foreign schema version is not treated as a superseded capture", () => {
  withFixture((fixture) => {
    writeFileDurable(path.join(fixture.root, "workspace.patch"), GENERATION_0_PATCH);
    writeFileDurable(
      path.join(fixture.root, "workspace-patch.json"),
      manifestText(GENERATION_0_PATCH, fixture.head).replace(
        WORKSPACE_PATCH_SCHEMA_VERSION,
        "ultrafuzz.workspace-patch.v2"
      )
    );

    assert.throws(() => loadMaterializer(fixture.root, capturedGeneration1(fixture.head))(task(fixture)), REJECTED);
  });
});

test("#357 a malformed manifest is not treated as a superseded capture", () => {
  withFixture((fixture) => {
    writeFileDurable(path.join(fixture.root, "workspace.patch"), GENERATION_0_PATCH);
    writeFileDurable(path.join(fixture.root, "workspace-patch.json"), "{ not json\n");

    assert.throws(() => loadMaterializer(fixture.root, capturedGeneration1(fixture.head))(task(fixture)), REJECTED);
  });
});

test("#357 a superseded patch with no manifest beside it is rejected", () => {
  withFixture((fixture) => {
    // Deleting the manifest half leaves a patch nothing attests to. Accepting it would let an agent
    // launder a patch by removing the manifest, which is the easier of the two edits.
    writeFileDurable(path.join(fixture.root, "workspace.patch"), GENERATION_0_PATCH);

    assert.throws(() => loadMaterializer(fixture.root, capturedGeneration1(fixture.head))(task(fixture)), REJECTED);
  });
});

test("#357 re-publishing an unchanged capture writes nothing", () => {
  withFixture((fixture) => {
    // The pair on disk IS this generation's capture, which `materializeWorkspacePatch` already
    // tolerated. The equality check must short-circuit before the durable write, so the artifact is
    // left byte-identical AND untouched: `writeFileDurable` renames a fresh temp file over the target,
    // so a needless rewrite would change the inode.
    const patchPath = path.join(fixture.root, "workspace.patch");
    writeFileDurable(patchPath, GENERATION_1_PATCH);
    writeFileDurable(path.join(fixture.root, "workspace-patch.json"), manifestText(GENERATION_1_PATCH, fixture.head));
    const before = fs.statSync(patchPath).ino;

    loadMaterializer(fixture.root, capturedGeneration1(fixture.head))(task(fixture));

    assert.equal(fs.readFileSync(patchPath, "utf8"), GENERATION_1_PATCH);
    assert.equal(fs.statSync(patchPath).ino, before);
  });
});

test("#357 every artifact root is classified, not just the canonical one", () => {
  withFixture((fixture) => {
    // `materializeWorkspacePatch` loops over `taskArtifactRoots`, which returns the canonical root AND a
    // mirror inside the agent-controlled workspace. A fix applied to only one of them leaves the other
    // failing exactly as R52 did, and stubbing a single root would never notice: review of this change
    // found precisely that mutation surviving.
    const mirrorRoot = fs.realpathSync(fs.mkdtempSync(path.join(fixture.workspaceRoot, "mirror-")));
    for (const root of [fixture.root, mirrorRoot]) {
      writeFileDurable(path.join(root, "workspace.patch"), GENERATION_0_PATCH);
      writeFileDurable(path.join(root, "workspace-patch.json"), manifestText(GENERATION_0_PATCH, fixture.head));
    }

    const materialize = loadTemplateFunctions(
      TEMPLATE_FUNCTIONS,
      "materializeWorkspacePatch",
      collaborators(capturedGeneration1(fixture.head), [fixture.root, mirrorRoot])
    ) as Materializer;
    materialize(task(fixture));

    for (const root of [fixture.root, mirrorRoot]) {
      assert.equal(fs.readFileSync(path.join(root, "workspace.patch"), "utf8"), GENERATION_1_PATCH);
    }
  });
});

test("#357 a non-regular half of the pair fails closed and names the file", () => {
  withFixture((fixture) => {
    // The classifier resolves both halves through `resolveRegularArtifactFile`, so it can throw. That
    // path was untested, and review found that wrapping the whole classifier in `catch { return }` --
    // which would convert a tampered half into a silent rejection-as-usual -- left the suite green.
    writeFileDurable(path.join(fixture.root, "workspace.patch"), GENERATION_0_PATCH);
    fs.mkdirSync(path.join(fixture.root, "workspace-patch.json"));

    assert.throws(() => loadMaterializer(fixture.root, capturedGeneration1(fixture.head))(task(fixture)), {
      message: /workspace patch artifact is unsafe workspace-patch\.json/u
    });
  });
});

test("#357 the durable pair is never momentarily absent while being replaced", () => {
  withFixture((fixture) => {
    // `materializeWorkspacePatchDependencies` SILENTLY skips a dependency missing both halves, so an
    // absence window between removing the old pair and writing the new one would be a silent hole
    // rather than an error. Deleting first would open exactly that window, so assert the replacement
    // never unlinks: both paths keep a live inode throughout, observed from inside the write path.
    const patchPath = path.join(fixture.root, "workspace.patch");
    const manifestPath = path.join(fixture.root, "workspace-patch.json");
    writeFileDurable(patchPath, GENERATION_0_PATCH);
    writeFileDurable(manifestPath, manifestText(GENERATION_0_PATCH, fixture.head));

    const observations: boolean[] = [];
    const watched = (target: string, contents: string): void => {
      observations.push(fs.existsSync(patchPath) && fs.existsSync(manifestPath));
      writeFileDurable(target, contents);
    };
    const materialize = loadTemplateFunctions(
      TEMPLATE_FUNCTIONS,
      "materializeWorkspacePatch",
      collaborators(capturedGeneration1(fixture.head), [fixture.root], watched)
    ) as Materializer;

    materialize(task(fixture));

    assert.deepEqual(observations, [true, true]);
    assert.equal(fs.readFileSync(patchPath, "utf8"), GENERATION_1_PATCH);
  });
});
