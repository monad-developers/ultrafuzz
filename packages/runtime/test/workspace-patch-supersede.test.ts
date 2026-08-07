import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

/**
 * A node re-executed in a NEW recovery generation rejects its own previous generation's workspace
 * patch as tampering (issue #357).
 *
 * R52 died here, and it was the only thing between that run and a report.md. The invariant chain had
 * succeeded through `stateful-invariant-setup`, `-handlers`, `-implement-properties` and `-coverage`;
 * `stateful-invariant-campaign` then failed with
 *
 *   artifact-contract failure: workspace patch artifact was modified workspace.patch
 *
 * leaving `triage` -> `dedupe-findings` -> `severity-classification` -> `final-report` unreachable.
 *
 * The mtimes on R52's volume name the mechanism exactly. The campaign node ran in two generations,
 * 18:37:07Z -> 18:52:34Z and then 19:00:54Z -> 19:15:48Z, and its artifact directory held:
 *
 *   26001  19:15:46Z  invariant-suite-baseline.json      <- generation 1 wrote this
 *    1773  19:15:46Z  invariant-suite-manifest.json      <- generation 1
 *     161  18:37:07Z  workspace-patch-baseline.json      <- generation 0 preparation
 *     435  18:52:34Z  workspace-patch.json               <- generation 0 OUTPUT
 *    1141  18:52:34Z  workspace.patch                    <- generation 0 OUTPUT
 *
 * Generation 1 re-ran the agent, wrote its own `invariant-suite*` artifacts, then captured a patch
 * that legitimately differed from generation 0's -- its agent had run again -- and
 * `writeWorkspacePatchArtifact` found the survivor non-empty and unequal and threw. The run log
 * confirms there is no second chance: `attempt=1 maxAttempts=1`, so `resetTaskArtifactsForRetry`
 * (which would have removed the pair, as it is not in the preserved set) never runs, and nothing
 * else clears it.
 *
 * The guard is load-bearing and must stay: it is what stops an agent-authored patch from surviving
 * into a runtime-owned artifact. So the discriminator cannot be content equality, which is what
 * conflates "my own superseded output" with "someone edited this". It is the manifest: a runtime
 * capture records `patch_sha256` over the patch it was taken with, so a superseded PAIR is
 * self-consistent in a way an agent-authored or truncated patch is not.
 *
 * These tests drive the real template functions over a real directory rather than stubs, and they
 * lift `materializeWorkspacePatch` itself so the CALL is pinned too -- the sibling #312 suite records
 * that dropping such a call left all of its rule-level tests green.
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Build a self-consistent manifest for `patch`, the way `captureWorkspacePatch` does, so a fixture
 * pair is indistinguishable from one a previous generation actually published.
 */
function manifestFor(patch: string, resultTree: string): string {
  return `${JSON.stringify(
    {
      schema_version: WORKSPACE_PATCH_SCHEMA_VERSION,
      base_commit: "6959e3219b5506bf2acae18551cbb2a68a5b8fba",
      base_tree: "b92f9cf321dd71d62ac64cafb0611f1eb50613ae",
      result_tree: resultTree,
      patch_sha256: sha256(patch),
      files: [{ path: "tests/foundry/stateful-invariant-campaign/ReconFailureRepros.t.sol" }]
    },
    null,
    2
  )}\n`;
}

// R52's generation 0 output and the differing capture generation 1 took, in production shape.
const GENERATION_0_PATCH = "diff --git a/tests/foundry/a.t.sol b/tests/foundry/a.t.sol\n+++ generation 0\n";
const GENERATION_1_PATCH = "diff --git a/tests/foundry/a.t.sol b/tests/foundry/a.t.sol\n+++ generation 1\n";

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

/**
 * The collaborators `materializeWorkspacePatch` and its callees need. Everything that touches the
 * filesystem is the real thing, so path safety and the write path are exercised, not simulated.
 */
function collaboratorsFor(root: string, captured: { patch: string; manifest: unknown }): Record<string, unknown> {
  return {
    path,
    createHash,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    mkdirSync: fs.mkdirSync,
    rmSync: fs.rmSync,
    statSync: fs.statSync,
    realpathSync: fs.realpathSync,
    writeFileDurable: (target: string, contents: string) => fs.writeFileSync(target, contents),
    assertRegularFileInside: (dir: string, candidate: string, message: string) => {
      const resolved = path.resolve(candidate);
      if (resolved === dir || !resolved.startsWith(`${dir}${path.sep}`)) throw new Error(message);
    },
    captureWorkspacePatch: () => captured,
    taskPublishesWorkspacePatch: () => true,
    taskArtifactRoots: () => [root],
    workspacePatchBaselineTrees: new Map([["attempt", "b92f9cf321dd71d62ac64cafb0611f1eb50613ae"]])
  };
}

const TASK = {
  attemptId: "attempt",
  metadata: { artifacts: { dir: "" } }
} as const;

type Materializer = (task: unknown) => void;

function loadMaterializer(root: string, captured: { patch: string; manifest: unknown }): Materializer {
  return loadTemplateFunctions(
    [
      "isStrictlyInsideDirectory",
      "resolveRegularArtifactFile",
      "discardSupersededWorkspacePatchArtifacts",
      "writeWorkspacePatchArtifact",
      "materializeWorkspacePatch"
    ],
    "materializeWorkspacePatch",
    collaboratorsFor(root, captured)
  ) as Materializer;
}

function withArtifactRoot(body: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf357-"));
  try {
    body(fs.realpathSync(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function task(root: string): unknown {
  // `materializeWorkspacePatch` resolves the workspace path before capturing, so it must be real.
  return { ...TASK, workspacePath: root, metadata: { artifacts: { dir: root } } };
}

const CAPTURED_GENERATION_1 = {
  patch: GENERATION_1_PATCH,
  manifest: JSON.parse(manifestFor(GENERATION_1_PATCH, "00d4d27499671615f4d0fd2871709a4dfdf880a4")) as unknown
};

test("#357 a re-executed node replaces its own superseded workspace patch", () => {
  withArtifactRoot((root) => {
    // Exactly R52's surviving pair: generation 0's patch plus the manifest generation 0 published
    // with it. Self-consistent, because the runtime wrote both.
    fs.writeFileSync(path.join(root, "workspace.patch"), GENERATION_0_PATCH);
    fs.writeFileSync(
      path.join(root, "workspace-patch.json"),
      manifestFor(GENERATION_0_PATCH, "9a3c1f0000000000000000000000000000000001")
    );

    loadMaterializer(root, CAPTURED_GENERATION_1)(task(root));

    // Generation 1's capture must win outright: this is the write that R52 never got to make.
    assert.equal(fs.readFileSync(path.join(root, "workspace.patch"), "utf8"), GENERATION_1_PATCH);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "workspace-patch.json"), "utf8")) as {
      patch_sha256: string;
    };
    assert.equal(manifest.patch_sha256, sha256(GENERATION_1_PATCH));
  });
});

test("#357 an agent-authored workspace patch is still rejected", () => {
  withArtifactRoot((root) => {
    // No manifest at all: nothing attests that the runtime produced this patch, so the guard that
    // keeps agent content out of a runtime-owned artifact must still fire. If this test ever passes
    // by writing the capture instead of throwing, the fix has removed the protection rather than
    // narrowing it.
    fs.writeFileSync(path.join(root, "workspace.patch"), "diff --git a/x b/x\n+++ authored by the agent\n");

    assert.throws(
      () => loadMaterializer(root, CAPTURED_GENERATION_1)(task(root)),
      /workspace patch artifact was modified workspace\.patch/u
    );
  });
});

test("#357 a patch whose manifest digest does not match it is still rejected", () => {
  withArtifactRoot((root) => {
    // The pair exists but does not cohere: the manifest's `patch_sha256` describes different bytes.
    // That is either tampering with one half of the pair or a truncated write, and neither is a
    // superseded runtime capture. Without this case, "has a manifest beside it" would be the whole
    // test, and an agent could get its patch accepted by dropping any manifest next to it.
    fs.writeFileSync(path.join(root, "workspace.patch"), GENERATION_0_PATCH);
    fs.writeFileSync(
      path.join(root, "workspace-patch.json"),
      manifestFor("unrelated bytes\n", "9a3c1f0000000000000000000000000000000001")
    );

    assert.throws(
      () => loadMaterializer(root, CAPTURED_GENERATION_1)(task(root)),
      /workspace patch artifact was modified workspace\.patch/u
    );
  });
});

test("#357 a foreign schema version is not treated as a superseded capture", () => {
  withArtifactRoot((root) => {
    // A manifest this code does not understand cannot be read as evidence about the patch beside it,
    // whatever its `patch_sha256` says.
    fs.writeFileSync(path.join(root, "workspace.patch"), GENERATION_0_PATCH);
    fs.writeFileSync(
      path.join(root, "workspace-patch.json"),
      manifestFor(GENERATION_0_PATCH, "9a3c1f0000000000000000000000000000000001").replace(
        WORKSPACE_PATCH_SCHEMA_VERSION,
        "ultrafuzz.workspace-patch.v2"
      )
    );

    assert.throws(
      () => loadMaterializer(root, CAPTURED_GENERATION_1)(task(root)),
      /workspace patch artifact was modified workspace\.patch/u
    );
  });
});

test("#357 a malformed manifest is not treated as a superseded capture", () => {
  withArtifactRoot((root) => {
    fs.writeFileSync(path.join(root, "workspace.patch"), GENERATION_0_PATCH);
    fs.writeFileSync(path.join(root, "workspace-patch.json"), "{ not json\n");

    assert.throws(
      () => loadMaterializer(root, CAPTURED_GENERATION_1)(task(root)),
      /workspace patch artifact was modified workspace\.patch/u
    );
  });
});

test("#357 re-publishing an unchanged capture stays idempotent", () => {
  withArtifactRoot((root) => {
    // The pair already on disk IS this generation's capture -- the node is being materialized twice
    // in one attempt, which `materializeWorkspacePatch` already tolerated. Discarding must not turn
    // that into a rewrite that reports a change.
    fs.writeFileSync(path.join(root, "workspace.patch"), GENERATION_1_PATCH);
    fs.writeFileSync(
      path.join(root, "workspace-patch.json"),
      `${JSON.stringify(CAPTURED_GENERATION_1.manifest, null, 2)}\n`
    );

    loadMaterializer(root, CAPTURED_GENERATION_1)(task(root));

    assert.equal(fs.readFileSync(path.join(root, "workspace.patch"), "utf8"), GENERATION_1_PATCH);
  });
});

test("#357 a superseded patch with no manifest beside it is rejected", () => {
  withArtifactRoot((root) => {
    // Deleting the manifest half leaves a patch nothing attests to. Accepting it would mean an agent
    // could launder a patch simply by removing the manifest, which is the easier of the two edits.
    fs.writeFileSync(path.join(root, "workspace.patch"), GENERATION_0_PATCH);

    assert.throws(
      () => loadMaterializer(root, CAPTURED_GENERATION_1)(task(root)),
      /workspace patch artifact was modified workspace\.patch/u
    );
  });
});
