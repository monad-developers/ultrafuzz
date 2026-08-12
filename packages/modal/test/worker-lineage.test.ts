import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MODAL_WORKER_LINEAGE_SCHEMA_VERSION } from "../src/defaults.js";
import type { ModalWorkerLineage } from "../src/launch-state.js";
import { CheckpointIncompatibleError, ensurePersistentWorkerLineage } from "../src/worker-lineage.js";
import { WorkerResultWriter, emptyWorkerCheckpoint } from "../src/worker-result.js";

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
    fs.writeFileSync(fixture.statusPath, "old status\n");
    fs.writeFileSync(fixture.resultPath, "old result\n");
    const second = { ...first, attempt: 2, attempt_id: "attempt-2" };

    await ensure(fixture, second);

    expect(JSON.parse(fs.readFileSync(fixture.lineagePath, "utf8"))).toMatchObject({
      attempt: 2,
      attempt_id: "attempt-2"
    });
    expect(fs.existsSync(fixture.bundle)).toBe(true);
    expect(fs.existsSync(fixture.statusPath)).toBe(false);
    expect(fs.existsSync(fixture.resultPath)).toBe(false);
    await expect(ensure(fixture, first)).rejects.toThrow(/newer than the requested attempt/u);
  });

  it("preserves the writer generation read before a same-generation attempt handoff", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    const writer = await WorkerResultWriter.create({
      statusPath: fixture.statusPath,
      resultPath: fixture.resultPath,
      executionContext: () => ({ launch_generation: 1, attempt: 1, model_work_started: false })
    });
    await writer.writeTerminal("finished", emptyWorkerCheckpoint());
    const previousGeneration = JSON.parse(fs.readFileSync(fixture.resultPath, "utf8")).generation as number;
    const second = { ...first, attempt: 2, attempt_id: "attempt-2" };
    const retryWriter = await WorkerResultWriter.create({
      statusPath: fixture.statusPath,
      resultPath: fixture.resultPath,
      executionContext: () => ({ launch_generation: 1, attempt: 2, model_work_started: false })
    });

    await ensure(fixture, second);
    await retryWriter.writePartial(emptyWorkerCheckpoint());

    const status = JSON.parse(fs.readFileSync(fixture.statusPath, "utf8")) as { generation: number; attempt: number };
    expect(status).toMatchObject({ generation: previousGeneration + 1, attempt: 2 });
    expect(fs.existsSync(fixture.resultPath)).toBe(false);
  });

  it("allows a newer resume attempt to roll forward the worker image for the same workspace", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    fs.mkdirSync(fixture.workspace, { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, "progress"), "preserved\n");
    fs.writeFileSync(fixture.bundle, "validated bundle\n");
    const rollout = {
      ...first,
      attempt: 2,
      attempt_id: "attempt-2",
      workspace_mode: "resume" as const,
      fingerprints: { ...first.fingerprints, image: "e".repeat(64) }
    };

    await ensure(fixture, rollout);

    expect(fs.readFileSync(path.join(fixture.workspace, "progress"), "utf8")).toBe("preserved\n");
    expect(fs.readFileSync(fixture.bundle, "utf8")).toBe("validated bundle\n");
    expect(JSON.parse(fs.readFileSync(fixture.lineagePath, "utf8"))).toMatchObject({
      attempt: 2,
      attempt_id: "attempt-2",
      workspace_mode: "resume",
      fingerprints: { image: "e".repeat(64) }
    });
  });

  it("rejects same-generation image changes that are not recovery resumes", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    const recreated = {
      ...first,
      attempt: 2,
      attempt_id: "attempt-2",
      fingerprints: { ...first.fingerprints, image: "e".repeat(64) }
    };

    await expect(ensure(fixture, recreated)).rejects.toThrow(/does not match the requested generation/u);
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
  statusPath: string;
  resultPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-worker-lineage-"));
  roots.push(root);
  return {
    root,
    workspace: path.join(root, "public-workspace"),
    bundle: path.join(root, "public-results.json"),
    lineagePath: path.join(root, "lineage.json"),
    statusPath: path.join(root, "status.json"),
    resultPath: path.join(root, "result.json")
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
    freshCleanupPaths: [fixture.workspace, fixture.bundle, fixture.statusPath, fixture.resultPath],
    attemptCleanupPaths: [fixture.statusPath, fixture.resultPath]
  });
}
