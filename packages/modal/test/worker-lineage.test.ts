import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MODAL_WORKER_LINEAGE_SCHEMA_VERSION } from "../src/defaults.js";
import type { ModalWorkerLineage } from "../src/launch-state.js";
import { CheckpointIncompatibleError, ensurePersistentWorkerLineage } from "../src/worker-lineage.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("persistent Modal worker lineage", () => {
  it("preserves a matching public workspace and rejects a recreated same-numbered attempt", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    fs.mkdirSync(fixture.workspace, { recursive: true });
    fs.writeFileSync(fixture.bundle, "validated bundle\n");

    await ensure(fixture, first);
    expect(fs.readFileSync(fixture.bundle, "utf8")).toBe("validated bundle\n");

    await expect(ensure(fixture, { ...first, attempt_id: "attempt-recreated" })).rejects.toBeInstanceOf(
      CheckpointIncompatibleError
    );
    expect(fs.readFileSync(fixture.bundle, "utf8")).toBe("validated bundle\n");
  });

  it("accepts only monotonically newer attempts within the same immutable generation", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    fs.writeFileSync(fixture.bundle, "validated bundle\n");
    const second = { ...first, attempt: 2, attempt_id: "attempt-2" };

    await ensure(fixture, second);

    expect(JSON.parse(fs.readFileSync(fixture.lineagePath, "utf8"))).toMatchObject({
      attempt: 2,
      attempt_id: "attempt-2"
    });
    expect(fs.existsSync(fixture.bundle)).toBe(true);
    await expect(ensure(fixture, first)).rejects.toThrow(/newer than the requested attempt/u);
  });

  it("clears stale evidence only for a newer explicit fresh generation", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    fs.mkdirSync(fixture.workspace, { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, "stale"), "stale\n");
    fs.writeFileSync(fixture.bundle, "stale bundle\n");
    const next = {
      ...first,
      generation: 2,
      attempt: 1,
      attempt_id: "generation-2-attempt-1",
      fingerprints: { ...first.fingerprints, config: "e".repeat(64) }
    };

    await ensure(fixture, next);

    expect(fs.existsSync(fixture.workspace)).toBe(false);
    expect(fs.existsSync(fixture.bundle)).toBe(false);
    expect(JSON.parse(fs.readFileSync(fixture.lineagePath, "utf8"))).toMatchObject({
      generation: 2,
      attempt_id: "generation-2-attempt-1"
    });
  });

  it("refuses an unversioned persistent workspace in resume mode", async () => {
    const fixture = lineageFixture();
    fs.mkdirSync(fixture.workspace, { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, "stale"), "stale\n");

    await expect(ensure(fixture, { ...lineage(), workspace_mode: "resume" })).rejects.toThrow(
      /unversioned persistent workspace/u
    );
  });
});

function lineageFixture(): {
  root: string;
  workspace: string;
  bundle: string;
  lineagePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-worker-lineage-"));
  roots.push(root);
  return {
    root,
    workspace: path.join(root, "public-workspace"),
    bundle: path.join(root, "public-results.json"),
    lineagePath: path.join(root, "lineage.json")
  };
}

function lineage(): ModalWorkerLineage {
  return {
    schema_version: MODAL_WORKER_LINEAGE_SCHEMA_VERSION,
    logical_run_id: "public-run",
    generation: 1,
    attempt: 1,
    attempt_id: "attempt-1",
    workspace_mode: "fresh",
    fingerprints: { config: "a".repeat(64), source: "b".repeat(64), image: "c".repeat(64) },
    model_fingerprint: "d".repeat(64)
  };
}

async function ensure(fixture: ReturnType<typeof lineageFixture>, value: ModalWorkerLineage): Promise<void> {
  await ensurePersistentWorkerLineage({
    lineagePath: fixture.lineagePath,
    lineage: value,
    workspaceEvidencePaths: [fixture.workspace, fixture.bundle],
    freshCleanupPaths: [fixture.workspace, fixture.bundle]
  });
}
