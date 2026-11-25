import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_ROOT, WORKER_COMMAND, executorRecord, loadExecutor, startingJob, storedRecord } from "../src/executor";
import type { Config, ExecutorName } from "../src/types";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const id = "20261103-120000-aabbccdd";
const config: Config = {
  defaults: { executor: "docker", harness: "opencode", model: "example/model", audit_profile: "v2/pareto" },
  docker: { cpu: 2, memory_mib: 4096, timeout_seconds: 21600, image: "example/worker:1" },
  modal: { app: "ultrafuzz", environment: "main", cpu: 4, memory_mib: 8192, timeout_seconds: 21600 },
  openrouter: { key_env: "EXAMPLE_KEY" }, repositories: {},
};

test("the factory returns an adapter with the five executor operations", async () => {
  for (const name of ["docker", "modal"] as const) {
    const executor = await loadExecutor(name);
    for (const operation of ["launch", "observe", "download", "cancel", "recover"] as const) expect(typeof executor[operation]).toBe("function");
  }
  await expect(loadExecutor("kubernetes" as ExecutorName)).rejects.toThrow("Unknown executor kubernetes. Use one of: docker, modal.");
});

test("each executor block holds resolved settings and the handles its platform needs", () => {
  expect(executorRecord(config, "docker", id, 3600)).toEqual({ name: "docker", cpu: 2, memory_mib: 4096, timeout_seconds: 3600, image: "example/worker:1", container_name: `ultrafuzz-${id}`, volume_name: `ultrafuzz-${id}`, runtime_id: null });
  expect(executorRecord(config, "modal", id, 7200)).toEqual({ name: "modal", app: "ultrafuzz", environment: "main", cpu: 4, memory_mib: 8192, timeout_seconds: 7200, volume_name: id, runtime_id: null });
  expect(() => executorRecord({ ...config, modal: undefined }, "modal", id, 3600)).toThrow("Executor modal is not configured. Add a [modal] table to ultrafuzz.toml.");
  expect(() => executorRecord({ ...config, docker: undefined }, "docker", id, 3600)).toThrow("Executor docker is not configured.");
  expect(() => executorRecord(config, "kubernetes" as ExecutorName, id, 3600)).toThrow("must be one of: docker, modal");
});

test("the worker starts from the shared mount point and a fresh deadline", async () => {
  expect(RUN_ROOT).toBe("/run-data");
  expect(WORKER_COMMAND.at(-1)).toContain("exec bun /opt/ultrafuzz/worker.js --root /run-data");
  const staging = await mkdtemp(join(tmpdir(), "ultrafuzz-executor-")); directories.push(staging);
  await writeFile(join(staging, "job.json"), JSON.stringify({ deadline_at: "2000-01-01T00:00:00.000Z", record: { id, state: "prepared", started_at: null } }));
  const before = Date.now(), job = await startingJob(staging, 3600);
  expect(Date.parse(job.deadline_at)).toBeGreaterThanOrEqual(before + 3600_000);
  expect(Date.parse(job.deadline_at)).toBeLessThanOrEqual(Date.now() + 3600_000);
  expect(job.record.state).toBe("launching");
  expect(job.record.started_at).not.toBeNull();
});

test("records read back from a store must be v0.2 records with a known executor", () => {
  const record = { schema: "ultrafuzz.run.v2", id, executor: { name: "docker" } };
  expect(storedRecord(JSON.stringify(record)).id).toBe(id);
  for (const invalid of [{ ...record, schema: "ultrafuzz.run.v1" }, { ...record, id: "../escape" }, { ...record, executor: undefined }, { ...record, executor: { name: "kubernetes" } }, null]) {
    expect(() => storedRecord(JSON.stringify(invalid))).toThrow("Invalid v0.2 run record");
  }
});
