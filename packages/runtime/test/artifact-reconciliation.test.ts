import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunLayout, getNodeArtifactDir, getNodeWorkspaceDir } from "@ultrafuzz/artifacts";

import { reconcileRequiredArtifactsFromWorkspace } from "../src/artifact-reconciliation.js";
import { verifyRequiredArtifactsForAttempt } from "../src/artifact-gates.js";
import { onlyTransientArtifactDiagnostics } from "../src/workflow-sync.js";
import type { PlannedGraphNode } from "../src/types.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-reconcile-"));
}

function plannedNode(requiredArtifacts: string[]): PlannedGraphNode {
  return {
    id: "strategy-a",
    logical_id: "strategy-a",
    display_name: "Strategy A",
    kind: "agentic",
    depends_on: [],
    artifact_dir: "artifacts/strategy-a",
    outputs: requiredArtifacts.map((artifactPath, index) => ({
      path: artifactPath,
      contract:
        artifactPath === "generated-tests.json" ? "ultrafuzz/generated-tests@1" : "ultrafuzz/nonempty-markdown@1",
      contract_digest: "a".repeat(64),
      primary: index === 0
    })),
    prompt_id: "strategy-a",
    prompt_path: "strategies/strategy-a.md",
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: []
  };
}

function setup(requiredArtifacts: string[]) {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const workspaceDir = getNodeWorkspaceDir(layout, "strategy-a", { create: true });
  const mirrorDir = path.join(workspaceDir, "artifacts", "strategy-a");
  fs.mkdirSync(mirrorDir, { recursive: true });
  return { layout, artifactDir, workspaceDir, mirrorDir, node: plannedNode(requiredArtifacts) };
}

function writeFile(root: string, relative: string, contents: string): string {
  const filePath = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

test("reconciles only the exact task-owned mirrored artifact path", async () => {
  const fixture = setup(["reports/output.json"]);
  writeFile(fixture.workspaceDir, "other/reports/output.json", "decoy\n");
  writeFile(fixture.mirrorDir, "reports/output.json", "canonical bytes\n");

  const result = await reconcileRequiredArtifactsFromWorkspace({
    layout: fixture.layout,
    node: fixture.node,
    attemptId: "strategy-a"
  });

  assert.deepEqual(result.materialized, ["reports/output.json"]);
  assert.equal(fs.readFileSync(path.join(fixture.artifactDir, "reports", "output.json"), "utf8"), "canonical bytes\n");
});

test("reconciles without relying on Linux descriptor pseudo-paths", async () => {
  const fixture = setup(["output.json"]);
  writeFile(fixture.mirrorDir, "output.json", "portable bytes\n");
  const originalRealpathSync = fs.realpathSync;

  fs.realpathSync = ((candidate, options) => {
    if (String(candidate).startsWith("/proc/self/fd/")) {
      throw new Error("descriptor pseudo-paths are unavailable");
    }
    return originalRealpathSync(candidate, options as never);
  }) as typeof fs.realpathSync;
  try {
    const result = await reconcileRequiredArtifactsFromWorkspace({
      layout: fixture.layout,
      node: fixture.node,
      attemptId: "strategy-a"
    });
    assert.deepEqual(result.materialized, ["output.json"]);
  } finally {
    fs.realpathSync = originalRealpathSync;
  }
});

test("ignores same-suffix files outside the exact mirrored artifact path", async () => {
  const fixture = setup(["output.json"]);
  writeFile(fixture.workspaceDir, "elsewhere/output.json", "decoy\n");

  const result = await reconcileRequiredArtifactsFromWorkspace({
    layout: fixture.layout,
    node: fixture.node,
    attemptId: "strategy-a"
  });

  assert.deepEqual(result.materialized, []);
  assert.equal(fs.existsSync(path.join(fixture.artifactDir, "output.json")), false);
});

test("never overwrites an existing canonical artifact", async () => {
  const fixture = setup(["output.json"]);
  writeFile(fixture.artifactDir, "output.json", "existing\n");
  writeFile(fixture.mirrorDir, "output.json", "replacement\n");

  const result = await reconcileRequiredArtifactsFromWorkspace({
    layout: fixture.layout,
    node: fixture.node,
    attemptId: "strategy-a"
  });

  assert.deepEqual(result.materialized, []);
  assert.equal(fs.readFileSync(path.join(fixture.artifactDir, "output.json"), "utf8"), "existing\n");
});

test("rejects empty, directory, symlink, hard-link, and traversal sources", async () => {
  const empty = setup(["empty.json"]);
  writeFile(empty.mirrorDir, "empty.json", "");
  assert.deepEqual(
    (
      await reconcileRequiredArtifactsFromWorkspace({
        layout: empty.layout,
        node: empty.node,
        attemptId: "strategy-a"
      })
    ).materialized,
    []
  );

  const directory = setup(["directory.json"]);
  fs.mkdirSync(path.join(directory.mirrorDir, "directory.json"));
  await assert.rejects(() =>
    reconcileRequiredArtifactsFromWorkspace({
      layout: directory.layout,
      node: directory.node,
      attemptId: "strategy-a"
    })
  );

  const symlink = setup(["linked.json"]);
  const outside = writeFile(tempProject(), "outside.json", "outside\n");
  fs.symlinkSync(outside, path.join(symlink.mirrorDir, "linked.json"));
  await assert.rejects(() =>
    reconcileRequiredArtifactsFromWorkspace({ layout: symlink.layout, node: symlink.node, attemptId: "strategy-a" })
  );
  assert.equal(fs.existsSync(path.join(symlink.artifactDir, "linked.json")), false);

  const hardLink = setup(["linked.json"]);
  const hardLinkOutside = writeFile(path.dirname(hardLink.workspaceDir), "outside.json", "outside\n");
  fs.linkSync(hardLinkOutside, path.join(hardLink.mirrorDir, "linked.json"));
  await assert.rejects(() =>
    reconcileRequiredArtifactsFromWorkspace({
      layout: hardLink.layout,
      node: hardLink.node,
      attemptId: "strategy-a"
    })
  );
  assert.equal(fs.existsSync(path.join(hardLink.artifactDir, "linked.json")), false);

  const traversal = setup(["../escape.json"]);
  await assert.rejects(() =>
    reconcileRequiredArtifactsFromWorkspace({
      layout: traversal.layout,
      node: traversal.node,
      attemptId: "strategy-a"
    })
  );
  assert.equal(fs.existsSync(path.join(traversal.layout.artifactsDir, "escape.json")), false);
});

test("rejects an intermediate source-directory swap between validation and open", async () => {
  const fixture = setup(["nested/output.json"]);
  const source = writeFile(fixture.mirrorDir, "nested/output.json", "inside\n");
  const sourceDirectory = path.dirname(source);
  const preservedDirectory = path.join(fixture.mirrorDir, "nested-preserved");
  const outsideDirectory = tempProject();
  writeFile(outsideDirectory, "output.json", "outside\n");
  const originalOpenSync = fs.openSync;
  let swapped = false;

  fs.openSync = ((filePath, flags, mode) => {
    if (!swapped && String(filePath) === source) {
      swapped = true;
      fs.renameSync(sourceDirectory, preservedDirectory);
      fs.symlinkSync(outsideDirectory, sourceDirectory);
    }
    return originalOpenSync(filePath, flags, mode);
  }) as typeof fs.openSync;
  try {
    await assert.rejects(() =>
      reconcileRequiredArtifactsFromWorkspace({
        layout: fixture.layout,
        node: fixture.node,
        attemptId: "strategy-a"
      })
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(sourceDirectory, { force: true });
    fs.renameSync(preservedDirectory, sourceDirectory);
  }

  assert.equal(swapped, true);
  assert.equal(fs.existsSync(path.join(fixture.artifactDir, "nested", "output.json")), false);
});

test("rejects a destination-directory move during publication", async () => {
  const fixture = setup(["nested/output.json"]);
  writeFile(fixture.mirrorDir, "nested/output.json", "inside\n");
  const destinationDirectory = path.join(fixture.artifactDir, "nested");
  const movedDirectory = path.join(fixture.layout.root, "moved-destination");
  const outsideDirectory = tempProject();
  const originalOpenSync = fs.openSync;
  let swapped = false;

  fs.openSync = ((filePath, flags, mode) => {
    if (!swapped && String(filePath).includes(".output.json.reconcile-")) {
      swapped = true;
      fs.renameSync(destinationDirectory, movedDirectory);
      fs.symlinkSync(outsideDirectory, destinationDirectory);
    }
    return originalOpenSync(filePath, flags, mode);
  }) as typeof fs.openSync;
  try {
    await assert.rejects(() =>
      reconcileRequiredArtifactsFromWorkspace({
        layout: fixture.layout,
        node: fixture.node,
        attemptId: "strategy-a"
      })
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(destinationDirectory, { force: true });
    fs.renameSync(movedDirectory, destinationDirectory);
  }

  assert.equal(swapped, true);
  assert.equal(fs.existsSync(path.join(fixture.artifactDir, "nested", "output.json")), false);
  assert.deepEqual(fs.readdirSync(outsideDirectory), []);
});

test("reconciles manifest-enumerated generated companions before the strict gate", async () => {
  const fixture = setup(["generated-tests.json"]);
  writeFile(
    fixture.mirrorDir,
    "generated-tests.json",
    JSON.stringify({
      schema_version: "1.0",
      run_id: "run-1",
      node_id: "strategy-a",
      generated_tests: [{ path: "generated-tests/Example.t.sol" }]
    })
  );
  writeFile(fixture.mirrorDir, "generated-tests/Example.t.sol", "contract ExampleTest {}\n");

  const result = await reconcileRequiredArtifactsFromWorkspace({
    layout: fixture.layout,
    node: fixture.node,
    attemptId: "strategy-a"
  });

  assert.deepEqual(result.materialized, ["generated-tests.json", "generated-tests/Example.t.sol"]);
  assert.equal(verifyRequiredArtifactsForAttempt(fixture.layout, fixture.node, "strategy-a").ok, true);
});

test("reconciles a missing generated companion when the canonical manifest already exists", async () => {
  const fixture = setup(["generated-tests.json"]);
  const manifest = JSON.stringify({
    schema_version: "1.0",
    run_id: "run-1",
    node_id: "strategy-a",
    generated_tests: [{ path: "generated-tests/Example.t.sol" }]
  });
  writeFile(fixture.artifactDir, "generated-tests.json", manifest);
  writeFile(fixture.mirrorDir, "generated-tests/Example.t.sol", "contract ExampleTest {}\n");

  const result = await reconcileRequiredArtifactsFromWorkspace({
    layout: fixture.layout,
    node: fixture.node,
    attemptId: "strategy-a"
  });

  assert.deepEqual(result.materialized, ["generated-tests/Example.t.sol"]);
  assert.equal(verifyRequiredArtifactsForAttempt(fixture.layout, fixture.node, "strategy-a").ok, true);
});

// #398: the reconciliation grace decides whether a gate failure is the benign
// "artifacts have not landed on the durable volume yet" case. It judged the
// whole diagnostic list against a code allowlist with no severity filter, so a
// warning -- which by construction cannot fail a node -- collapsed the grace and
// turned a transient miss into an immediate artifact-contract failure with a
// consumed retry. Reachable today on property-lens nodes, which are the only
// ones that can currently emit a warning.
test("a warning does not collapse the artifact reconciliation grace", () => {
  const transient = {
    code: "REQUIRED_ARTIFACT_MISSING",
    message: "required artifact is not yet visible",
    severity: "error" as const,
    source: "artifact-gate"
  };
  const warning = {
    code: "PROPERTY_REFERENCE_EXPECTATION_SANITIZED",
    message: "the lens output was sanitized",
    severity: "warning" as const,
    source: "property-provenance"
  };
  const fatal = {
    code: "PROPERTY_FINDING_REFERENCE_MISSING",
    message: "a real contract failure",
    severity: "error" as const,
    source: "property-provenance"
  };

  assert.equal(onlyTransientArtifactDiagnostics([transient]), true, "a lone transient miss keeps the grace");
  assert.equal(
    onlyTransientArtifactDiagnostics([transient, warning]),
    true,
    "a warning alongside a transient miss must not collapse the grace"
  );
  assert.equal(
    onlyTransientArtifactDiagnostics([transient, fatal]),
    false,
    "a genuine contract error must still skip the grace"
  );
  assert.equal(onlyTransientArtifactDiagnostics([warning]), false, "warnings alone are not a transient artifact miss");
  assert.equal(onlyTransientArtifactDiagnostics([]), false, "an empty list is not a transient artifact miss");
});
