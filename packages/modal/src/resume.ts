import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TerminalDisposition } from "./terminal-disposition.js";

export interface ModalResumeWorkspace {
  target: string;
  control: string;
  evalRunId: string;
  productRunId: string;
}

export interface ModalResumeRunState {
  run_id: string;
  status?: string;
  nodes?: Record<string, { status?: string }>;
}

export async function locateModalResumeWorkspace(workRoot: string): Promise<ModalResumeWorkspace> {
  const target = path.join(workRoot, "target");
  const control = path.join(workRoot, "control");
  if (!(await isDirectoryNotSymlink(target)) || !(await isDirectoryNotSymlink(control))) {
    throw new Error("persistent workspace is incomplete");
  }
  const evalRoot = path.join(control, ".ultrafuzz", "evals", "runs");
  const candidates = [];
  for (const name of await readdir(evalRoot)) {
    const root = path.join(evalRoot, name);
    if ((await isDirectoryNotSymlink(root)) && (await isRegularFileNotSymlink(path.join(root, "eval.json")))) {
      candidates.push(name);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`resume requires exactly one evaluation run, found ${candidates.length}`);
  }
  const evalRunId = candidates[0]!;
  const records = await readRecords(path.join(evalRoot, evalRunId, "runs.jsonl"));
  const productRunIds = new Set(
    records
      .map((record) => record.ultrafuzz_run_id)
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
  );
  if (productRunIds.size !== 1) {
    throw new Error(`resume requires exactly one linked durable run, found ${productRunIds.size}`);
  }
  return { target, control, evalRunId, productRunId: [...productRunIds][0]! };
}

export async function repairModalEvalRunRecord(
  workspace: ModalResumeWorkspace,
  state: ModalResumeRunState,
  disposition: TerminalDisposition | undefined
): Promise<void> {
  const genuineTaskOutcome = state.status === "failed" && disposition?.kind === "genuine-task-failures";
  if (state.status !== "succeeded" && !genuineTaskOutcome) {
    throw new Error(`refusing to finalize evaluation row from run status ${state.status ?? "unknown"}`);
  }
  if (state.run_id !== workspace.productRunId) {
    throw new Error(`refusing to finalize evaluation row from unrelated run ${state.run_id}`);
  }
  const evalDir = path.join(workspace.control, ".ultrafuzz", "evals", "runs", workspace.evalRunId);
  const recordsPath = path.join(evalDir, "runs.jsonl");
  const records = await readRecords(recordsPath);
  const linked = records.filter((record) => record.ultrafuzz_run_id === state.run_id);
  if (linked.length === 0) throw new Error(`evaluation run does not reference durable run ${state.run_id}`);
  const rowIds = new Set(linked.map((record) => record.row_id));
  if (rowIds.size !== 1) throw new Error("evaluation run has ambiguous linked rows");
  const record = linked[linked.length - 1]!;
  const finalStatus = state.status;
  const updated =
    record.final_status === finalStatus
      ? record
      : { ...record, final_status: finalStatus, finished_at: new Date().toISOString() };
  if (updated !== record) await writeFile(recordsPath, `${JSON.stringify(updated)}\n`, { flag: "a", mode: 0o600 });
  await writeJsonAtomic(path.join(evalDir, "run-summary.json"), {
    eval_run_id: workspace.evalRunId,
    launched: 1,
    failed: 0,
    records: [updated]
  });
}

async function readRecords(filePath: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function isDirectoryNotSymlink(filePath: string): Promise<boolean> {
  return lstat(filePath)
    .then((stat) => stat.isDirectory() && !stat.isSymbolicLink())
    .catch(() => false);
}

async function isRegularFileNotSymlink(filePath: string): Promise<boolean> {
  return lstat(filePath)
    .then((stat) => stat.isFile() && !stat.isSymbolicLink())
    .catch(() => false);
}
