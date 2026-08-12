import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MODAL_WORKER_LINEAGE_SCHEMA_VERSION } from "../src/defaults.js";
import type { ModalWorkerLineage } from "../src/launch-state.js";
import {
  CheckpointIncompatibleError,
  ensurePersistentWorkerLineage,
  guardCurrentPersistentWorkerLineage
} from "../src/worker-lineage.js";
import { WorkerResultWriter, emptyWorkerCheckpoint, runWithTerminalPersistence } from "../src/worker-result.js";

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
      generationFloorPath: fixture.generationFloorPath,
      executionContext: () => ({ launch_generation: 1, attempt: 1, model_work_started: false })
    });
    await writer.writeTerminal("finished", emptyWorkerCheckpoint());
    const previousGeneration = JSON.parse(fs.readFileSync(fixture.resultPath, "utf8")).generation as number;
    const second = { ...first, attempt: 2, attempt_id: "attempt-2" };
    const retryWriter = await WorkerResultWriter.create({
      statusPath: fixture.statusPath,
      resultPath: fixture.resultPath,
      generationFloorPath: fixture.generationFloorPath,
      writeGuard: guardCurrentPersistentWorkerLineage(fixture.lineagePath, second),
      executionContext: () => ({ launch_generation: 1, attempt: 2, model_work_started: false })
    });

    await ensure(fixture, second);
    await retryWriter.writePartial(emptyWorkerCheckpoint());

    const status = JSON.parse(fs.readFileSync(fixture.statusPath, "utf8")) as { generation: number; attempt: number };
    expect(status).toMatchObject({ generation: previousGeneration + 1, attempt: 2 });
    expect(fs.existsSync(fixture.resultPath)).toBe(false);
  });

  it("serializes competing attempt claims and fences the superseded writer", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    const second = { ...first, attempt: 2, attempt_id: "attempt-2" };
    const third = { ...first, attempt: 3, attempt_id: "attempt-3" };
    const secondWriter = writerFor(fixture, second);
    const thirdWriter = writerFor(fixture, third);

    const claims = await Promise.allSettled([ensure(fixture, second), ensure(fixture, third)]);
    expect(claims.some((claim) => claim.status === "fulfilled")).toBe(true);
    expect(JSON.parse(fs.readFileSync(fixture.lineagePath, "utf8"))).toMatchObject({ attempt: 3 });

    await expect(secondWriter.then((writer) => writer.writePartial(emptyWorkerCheckpoint()))).rejects.toThrow(
      /no longer matches this attempt/u
    );
    await (await thirdWriter).writePartial(emptyWorkerCheckpoint());
    expect(JSON.parse(fs.readFileSync(fixture.statusPath, "utf8"))).toMatchObject({ attempt: 3 });
  });

  it("leaves current result files byte-for-byte unchanged when a superseded worker finalizes", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    const staleWriter = await writerFor(fixture, first);
    const second = { ...first, attempt: 2, attempt_id: "attempt-2" };
    await ensure(fixture, second);
    const currentWriter = await writerFor(fixture, second);
    await currentWriter.writePartial(emptyWorkerCheckpoint());
    await currentWriter.writeTerminal("finished", emptyWorkerCheckpoint());
    const statusBefore = fs.readFileSync(fixture.statusPath);
    const resultBefore = fs.readFileSync(fixture.resultPath);

    await expect(
      runWithTerminalPersistence({
        writer: staleWriter,
        snapshot: async () => emptyWorkerCheckpoint(),
        flush: async () => undefined,
        run: async () => {
          throw new CheckpointIncompatibleError("superseded attempt");
        }
      })
    ).rejects.toThrow("superseded attempt");

    expect(fs.readFileSync(fixture.statusPath)).toEqual(statusBefore);
    expect(fs.readFileSync(fixture.resultPath)).toEqual(resultBefore);
  });

  it("preserves the result generation across a crash after attempt cleanup", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    const firstWriter = await writerFor(fixture, first);
    const terminal = await firstWriter.writeTerminal("finished", emptyWorkerCheckpoint());
    const second = { ...first, attempt: 2, attempt_id: "attempt-2" };

    await ensure(fixture, second);
    expect(fs.existsSync(fixture.statusPath)).toBe(false);
    expect(fs.existsSync(fixture.resultPath)).toBe(false);

    const restarted = await writerFor(fixture, second);
    const partial = await restarted.writePartial(emptyWorkerCheckpoint());
    expect(partial.generation).toBe(terminal.generation + 1);
  });

  it("fails closed when the generation floor is corrupt after attempt cleanup", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    const firstWriter = await writerFor(fixture, first);
    await firstWriter.writeTerminal("finished", emptyWorkerCheckpoint());
    const second = { ...first, attempt: 2, attempt_id: "attempt-2" };
    await ensure(fixture, second);
    fs.writeFileSync(fixture.generationFloorPath, "not json\n");

    await expect(writerFor(fixture, second)).rejects.toThrow(/generation floor is invalid/u);
    expect(fs.existsSync(fixture.statusPath)).toBe(false);
    expect(fs.existsSync(fixture.resultPath)).toBe(false);
  });

  it("serializes result generations from duplicate processes with identical lineage", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    const left = await writerFor(fixture, first);
    const right = await writerFor(fixture, first);

    const written = await Promise.all([
      left.writePartial(emptyWorkerCheckpoint()),
      right.writePartial(emptyWorkerCheckpoint())
    ]);

    expect(written.map((contract) => contract.generation).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(JSON.parse(fs.readFileSync(fixture.statusPath, "utf8"))).toMatchObject({ generation: 2 });
  });

  it("allows a newer resume attempt to roll forward the worker image for the same workspace", async () => {
    const fixture = lineageFixture();
    const first = lineage();
    await ensure(fixture, first);
    fs.mkdirSync(fixture.workspace, { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, "progress"), "preserved\n");
    fs.writeFileSync(fixture.bundle, "validated bundle\n");
    const firstWriter = await writerFor(fixture, first);
    const terminal = await firstWriter.writeTerminal("finished", emptyWorkerCheckpoint());
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
    expect(fs.existsSync(fixture.statusPath)).toBe(false);
    expect(fs.existsSync(fixture.resultPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(fixture.generationFloorPath, "utf8"))).toEqual({
      generation: terminal.generation
    });
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
  generationFloorPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-worker-lineage-"));
  roots.push(root);
  return {
    root,
    workspace: path.join(root, "public-workspace"),
    bundle: path.join(root, "public-results.json"),
    lineagePath: path.join(root, "lineage.json"),
    statusPath: path.join(root, "status.json"),
    resultPath: path.join(root, "result.json"),
    generationFloorPath: path.join(root, "result-generation-floor.json")
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
    attemptCleanupPaths: [fixture.statusPath, fixture.resultPath],
    resultGenerationFloorPath: fixture.generationFloorPath,
    resultGenerationFloor: 0
  });
}

async function writerFor(
  fixture: ReturnType<typeof lineageFixture>,
  value: ModalWorkerLineage
): Promise<WorkerResultWriter> {
  return WorkerResultWriter.create({
    statusPath: fixture.statusPath,
    resultPath: fixture.resultPath,
    generationFloorPath: fixture.generationFloorPath,
    writeGuard: guardCurrentPersistentWorkerLineage(fixture.lineagePath, value),
    executionContext: () => ({
      launch_generation: value.generation,
      attempt: value.attempt,
      model_work_started: false
    })
  });
}
