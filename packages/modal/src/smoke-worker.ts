import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { ModelProvider } from "./defaults.js";
import { remoteAuthPath } from "./layout.js";

const provider = providerOption(process.argv.slice(2));
const phase = phaseOption(process.argv.slice(2));
const dataRoot = dataRootOption(process.argv.slice(2));
const checkpointPath = path.join(dataRoot, "checkpoint.json");
const completionPath = path.join(dataRoot, "completed-unit");
const resultPath = path.join(dataRoot, "result.json");

async function main(): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  const nonRoot = (process.getuid?.() ?? 0) !== 0;
  if (!nonRoot) throw new Error("root identity is not allowed");
  await assertProviderAuth(provider);

  const durableMarker = path.join(dataRoot, phase === "fresh" ? "fresh-write" : "resume-write");
  await writeFile(durableMarker, "ok\n", { flag: "wx", mode: 0o600 });
  const performedCompletedWork = await completeUnitOnce();

  if (phase === "fresh") {
    if (!performedCompletedWork) throw new Error("fresh work was already complete");
    await writeJson(checkpointPath, {
      non_root: nonRoot,
      durable_storage: true,
      provider_auth: provider,
      completed_units: 1
    });
    await flushWrites();
    for (;;) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (performedCompletedWork) throw new Error("resume repeated completed work");
  const completedUnits = (await readFile(completionPath, "utf8")).trim() === "complete" ? 1 : 0;
  await access(checkpointPath, constants.R_OK);
  await writeJson(resultPath, {
    non_root: nonRoot,
    durable_storage: true,
    provider_auth: provider,
    completed_units: completedUnits,
    repeated_units: performedCompletedWork ? 1 : 0
  });
  await flushWrites();
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}

async function assertProviderAuth(selected: ModelProvider): Promise<void> {
  await access(remoteAuthPath(selected), constants.R_OK);
  const other: ModelProvider = selected === "openai" ? "anthropic" : "openai";
  try {
    await access(remoteAuthPath(other), constants.F_OK);
  } catch {
    return;
  }
  throw new Error("unselected provider auth was staged");
}

async function completeUnitOnce(): Promise<boolean> {
  try {
    await writeFile(completionPath, "complete\n", { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

async function writeJson(filePath: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function flushWrites(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("sync", (error) => (error === null ? resolve() : reject(error)));
  });
}

function providerOption(argv: string[]): ModelProvider {
  const value = requiredOption(argv, "--provider");
  if (value !== "openai" && value !== "anthropic") throw new Error("provider is invalid");
  return value;
}

function phaseOption(argv: string[]): "fresh" | "resume" {
  const value = requiredOption(argv, "--phase");
  if (value !== "fresh" && value !== "resume") throw new Error("phase is invalid");
  return value;
}

function dataRootOption(argv: string[]): string {
  const value = path.posix.resolve(requiredOption(argv, "--data-root"));
  if (!value.startsWith("/data/") || value.includes("\0")) throw new Error("data root is invalid");
  return value;
}

function requiredOption(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.trim() === "") throw new Error("required option is missing");
  return value;
}

void main().catch(() => {
  console.error("modal smoke worker failed");
  process.exitCode = 1;
});
