import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fingerprintModalModel } from "../src/config.js";
import { DEFAULT_BENCHMARK_MODELS, MODAL_WORKER_LINEAGE_SCHEMA_VERSION } from "../src/defaults.js";
import type { ModalWorkerLineage } from "../src/launch-state.js";
import {
  CheckpointIncompatibleError,
  ensurePersistentWorkerLineage,
  modelForModalWorkerLineage,
  readModalWorkerLineage
} from "../src/worker-lineage.js";
import { emptyWorkerCheckpoint, WorkerResultWriter } from "../src/worker-result.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("persistent Modal worker lineage", () => {
  it("derives the worker model only from the exact configured lineage fingerprint", () => {
    const model = DEFAULT_BENCHMARK_MODELS[0]!;
    const current = { ...lineage(), model_fingerprint: fingerprintModalModel(model) };

    expect(modelForModalWorkerLineage({ models: [model] }, current)).toBe(model);
    expect(() => modelForModalWorkerLineage({ models: [model] }, lineage())).toThrow(
      /does not identify exactly one configured model/u
    );
  });

  it("rejects duplicate keys in persisted lineage without replacing ownership evidence", async () => {
    const fixture = lineageFixture();
    const current = lineage();
    const serialized = JSON.stringify(current);
    const field = `"logical_run_id":"${current.logical_run_id}"`;
    const duplicate = serialized.replace(field, `${field},"logical_run_id":"shadow-run"`);
    expect(duplicate).not.toBe(serialized);
    fs.writeFileSync(fixture.lineagePath, duplicate, { mode: 0o600 });

    await expect(ensure(fixture, current)).rejects.toThrow(/persisted lineage record is invalid/u);
    expect(fs.readFileSync(fixture.lineagePath, "utf8")).toBe(duplicate);
  });

  it("preserves a matching public workspace and rejects a recreated same-numbered attempt", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    expect(readModalWorkerLineage(fixture.lineagePath)).toEqual(first);
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

  it("clears only attempt results while preserving durable evidence for a same-generation retry", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    fs.mkdirSync(fixture.workspace, { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, "progress"), "preserved workspace\n");
    fs.writeFileSync(fixture.bundle, "preserved bundle\n");
    fs.writeFileSync(fixture.sourceProof, "preserved source proof\n");

    const firstWriter = await WorkerResultWriter.create({
      statusPath: fixture.statusPath,
      resultPath: fixture.resultPath,
      executionContext: () => ({
        launch_generation: first.generation,
        attempt: first.attempt,
        model_work_started: false
      })
    });
    const firstResult = await firstWriter.writeTerminal("unreachable", emptyWorkerCheckpoint());
    const second = { ...first, attempt: 2, attempt_id: "attempt-2" };

    // Production constructs the writer before lineage cleanup so its generation
    // remains monotonic even though the old attempt documents are removed.
    const secondWriter = await WorkerResultWriter.create({
      statusPath: fixture.statusPath,
      resultPath: fixture.resultPath,
      executionContext: () => ({
        launch_generation: second.generation,
        attempt: second.attempt,
        model_work_started: false
      })
    });
    await ensure(fixture, second);

    expect(fs.existsSync(fixture.statusPath)).toBe(false);
    expect(fs.existsSync(fixture.resultPath)).toBe(false);
    expect(fs.readFileSync(path.join(fixture.workspace, "progress"), "utf8")).toBe("preserved workspace\n");
    expect(fs.readFileSync(fixture.bundle, "utf8")).toBe("preserved bundle\n");
    expect(fs.readFileSync(fixture.sourceProof, "utf8")).toBe("preserved source proof\n");

    const secondStatus = await secondWriter.writePartial(emptyWorkerCheckpoint());
    expect(secondStatus).toMatchObject({
      result_type: "partial",
      generation: firstResult.generation + 1,
      launch_generation: 1,
      attempt: 2
    });
    expect(JSON.parse(fs.readFileSync(fixture.statusPath, "utf8"))).toEqual(secondStatus);
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
  sourceProof: string;
  statusPath: string;
  resultPath: string;
  lineagePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-worker-lineage-"));
  roots.push(root);
  return {
    root,
    workspace: path.join(root, "public-workspace"),
    bundle: path.join(root, "public-results.json"),
    sourceProof: path.join(root, "source-proof.json"),
    statusPath: path.join(root, "status.json"),
    resultPath: path.join(root, "result.json"),
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
    freshCleanupPaths: [fixture.workspace, fixture.bundle],
    attemptCleanupPaths: [fixture.statusPath, fixture.resultPath]
  });
}
