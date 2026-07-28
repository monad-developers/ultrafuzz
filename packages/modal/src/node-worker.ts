import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { parseModalNodeSandboxInput } from "./node-provider.js";
import { extractSafeTarArchive, sha256File } from "./safe-archive.js";

const PROJECT_ROOT = "/workspace/project";

async function main(): Promise<void> {
  const requestPath = requiredOption("--request");
  const archivePath = requiredOption("--project-archive");
  const dataRoot = requiredOption("--data-root");
  const input = parseModalNodeSandboxInput(JSON.parse(fs.readFileSync(requestPath, "utf8")) as unknown);
  const publishing = `${dataRoot}.publishing`;
  fs.rmSync(PROJECT_ROOT, { recursive: true, force: true });
  fs.rmSync(publishing, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_ROOT, { recursive: true, mode: 0o700 });
  fs.mkdirSync(publishing, { recursive: true, mode: 0o700 });
  try {
    if (input.project_archive_sha256 === undefined || sha256File(archivePath) !== input.project_archive_sha256) {
      throw new Error("cloud handoff archive digest mismatch");
    }
    await extractSafeTarArchive(archivePath, PROJECT_ROOT, { gzip: true, label: "cloud handoff" });
    assertSafeTree(PROJECT_ROOT);
    await runChecked(
      "install-smithers",
      "npm",
      [
        "install",
        "--prefix",
        path.join(PROJECT_ROOT, ".smithers"),
        "--ignore-scripts",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
        "--loglevel=error"
      ],
      PROJECT_ROOT
    );
    const workflowPath = anchoredProjectPath(input.workflow_path);
    const localRunId = `${input.run_id}-${crypto.createHash("sha256").update(input.task_id).digest("hex").slice(0, 12)}`;
    const smithers = path.join(PROJECT_ROOT, ".smithers", "node_modules", ".bin", "smithers");
    await runChecked(
      "run-workflow",
      smithers,
      [
        "up",
        workflowPath,
        "--run-id",
        localRunId,
        "--max-concurrency",
        "1",
        "--root",
        PROJECT_ROOT,
        "--input",
        JSON.stringify({
          cloud_worker: true,
          task_id: input.task_id,
          ...(input.operator_prompt === undefined ? {} : { operator_prompt: input.operator_prompt })
        }),
        "--format",
        "json"
      ],
      PROJECT_ROOT,
      {
        ULTRAFUZZ_CLOUD_WORKER: "1",
        ULTRAFUZZ_ARTIFACTS_MODULE: "file:///opt/ultrafuzz/packages/artifacts/dist/index.js",
        ULTRAFUZZ_RUNTIME_MODULE: "file:///opt/ultrafuzz/packages/runtime/dist/index.js"
      }
    );

    const artifactDir = anchoredProjectPath(input.artifact_dir);
    const workspaceDir = anchoredProjectPath(input.workspace_dir);
    mergeWorkspaceArtifacts(workspaceDir, artifactDir, input.attempt_id);
    const credentialValues = input.agent_credential_env.flatMap((name) => {
      const value = process.env[name];
      return value === undefined || value === "" ? [] : [value];
    });
    assertNoCredentialValuesInTree(artifactDir, credentialValues);
    if (fs.existsSync(workspaceDir)) {
      assertNoCredentialValuesInTree(workspaceDir, credentialValues);
    }
    const staging = path.join(publishing, "bundle");
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    copySafeTree(artifactDir, path.join(staging, "artifacts"));
    if (fs.existsSync(workspaceDir)) {
      copySafeTree(workspaceDir, path.join(staging, "workspace"));
    }
    const artifactArchive = path.join(publishing, "artifacts.tgz");
    await runChecked("archive-results", "tar", ["-czf", artifactArchive, "-C", staging, "."], PROJECT_ROOT);
    const digest = sha256File(artifactArchive);
    fs.writeFileSync(
      path.join(publishing, "result.json"),
      `${JSON.stringify({
        schema_version: "ultrafuzz.modal.node-result.v1",
        status: "succeeded",
        artifact_archive: path.posix.join(dataRoot, "artifacts.tgz"),
        artifact_sha256: digest,
        storage_lineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`
      })}\n`,
      { mode: 0o600 }
    );
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.renameSync(publishing, dataRoot);
    await runChecked("sync-results", "sync", [], "/data");
  } catch (error) {
    fs.rmSync(publishing, { recursive: true, force: true });
    throw error;
  }
}

async function runChecked(
  phase: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {}
): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = readBoundedText(child.stdout);
  const stderr = readBoundedText(child.stderr);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    throw new CloudWorkerCommandError(phase, path.basename(command), exitCode, stdoutText, stderrText);
  }
}

class CloudWorkerCommandError extends Error {
  constructor(
    readonly phase: string,
    readonly command: string,
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(`cloud worker phase ${phase} failed with code ${exitCode}`);
  }
}

function readBoundedText(stream: Readable | null, limit = 4_096): Promise<string> {
  if (stream === null) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let length = 0;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (length >= limit) return;
      const remaining = limit - length;
      chunks.push(chunk.slice(0, remaining));
      length += Math.min(chunk.length, remaining);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(chunks.join("")));
  });
}

function workerErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof CloudWorkerCommandError) {
    return {
      schema_version: "ultrafuzz.modal.node-worker-error.v1",
      message: error.message,
      phase: error.phase,
      command: error.command,
      exit_code: error.exitCode,
      ...(error.stdout.trim() === "" ? {} : { stdout: error.stdout.trim().slice(0, 2_000) }),
      ...(error.stderr.trim() === "" ? {} : { stderr: error.stderr.trim().slice(0, 2_000) })
    };
  }
  return {
    schema_version: "ultrafuzz.modal.node-worker-error.v1",
    message: error instanceof Error ? error.message : String(error)
  };
}

function mergeWorkspaceArtifacts(workspaceDir: string, artifactDir: string, attemptId: string): void {
  const mirror = path.join(workspaceDir, "artifacts", attemptId);
  if (!fs.existsSync(mirror)) return;
  copySafeTree(mirror, artifactDir, true);
}

export function copySafeTree(source: string, destination: string, onlyMissing = false): void {
  const resolvedSource = path.resolve(source);
  const sourceStat = fs.lstatSync(resolvedSource);
  const root = fs.realpathSync(resolvedSource);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || root !== resolvedSource) {
    throw new Error("cloud publication source is unsafe");
  }
  assertSafeDirectoryTarget(destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const sourcePath = path.join(root, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copySafeTree(sourcePath, destinationPath, onlyMissing);
    } else if (entry.isFile()) {
      const stat = fs.lstatSync(sourcePath);
      if (stat.nlink !== 1) throw new Error("cloud publication file is hard-linked");
      if (onlyMissing && fs.existsSync(destinationPath)) continue;
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    } else {
      throw new Error("cloud publication excludes links and special files");
    }
  }
}

export function assertNoCredentialValuesInTree(root: string, credentialValues: readonly string[]): void {
  const values = [...new Set(credentialValues.filter((value) => value.length > 0))].map((value) =>
    Buffer.from(value, "utf8")
  );
  if (values.length === 0) return;
  assertSafeTree(root);
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (values.some((value) => Buffer.from(entry.name, "utf8").includes(value))) {
      throw new Error("cloud publication contains an injected credential value");
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    if (fileContainsCredentialValue(filePath, values)) {
      throw new Error("cloud publication contains an injected credential value");
    }
  }
}

function fileContainsCredentialValue(filePath: string, credentialValues: readonly Buffer[]): boolean {
  const descriptor = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const longest = Math.max(...credentialValues.map((value) => value.byteLength));
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) return false;
      const contents = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (credentialValues.some((value) => contents.includes(value))) return true;
      carry = contents.subarray(Math.max(0, contents.byteLength - longest + 1));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertSafeDirectoryTarget(destination: string): void {
  const resolved = path.resolve(destination);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
      throw new Error("cloud publication destination is unsafe");
    }
    return;
  }
  const parent = path.dirname(resolved);
  if (parent !== resolved) {
    assertSafeDirectoryTarget(parent);
  }
}

function assertSafeTree(root: string): void {
  const resolvedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(resolvedRoot) !== resolvedRoot) {
    throw new Error("cloud handoff archive root is unsafe");
  }
  for (const entry of fs.readdirSync(resolvedRoot, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const stat = fs.lstatSync(full);
    if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) {
      throw new Error("cloud handoff archive contains an unsafe filesystem entry");
    }
  }
}

function anchoredProjectPath(value: string): string {
  const resolved = path.resolve(PROJECT_ROOT, value);
  if (resolved === PROJECT_ROOT || !resolved.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new Error("cloud worker path escapes the project");
  }
  return resolved;
}

function requiredOption(name: string): string {
  const value = optionValue(name);
  if (value === undefined || value.trim() === "") throw new Error("cloud worker option is missing");
  return value;
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function sanitizedWorkerErrorPayload(error: unknown): Record<string, unknown> {
  const payload = workerErrorPayload(error);
  const requestPath = optionValue("--request");
  const values: string[] = [];
  if (requestPath !== undefined) {
    try {
      const input = parseModalNodeSandboxInput(JSON.parse(fs.readFileSync(requestPath, "utf8")) as unknown);
      for (const name of input.agent_credential_env) {
        const value = process.env[name];
        if (value !== undefined && value !== "") values.push(value);
      }
    } catch {
      // The controller performs another redaction pass; an unreadable request must not mask the original failure.
    }
  }
  let serialized = JSON.stringify(payload);
  for (const value of values.sort((left, right) => right.length - left.length)) {
    serialized = serialized.replaceAll(value, "[credential]");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function publishWorkerFailure(payload: Record<string, unknown>): void {
  const dataRoot = optionValue("--data-root");
  if (dataRoot === undefined || dataRoot.trim() === "") return;
  try {
    if (fs.existsSync(path.join(dataRoot, "result.json"))) return;
    fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    const destination = path.join(dataRoot, "error.json");
    const pending = `${destination}.pending-${process.pid}`;
    fs.writeFileSync(pending, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(pending, destination);
  } catch {
    // stderr remains the fallback when durable storage itself is unavailable.
  }
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  void main().catch((error: unknown) => {
    const payload = sanitizedWorkerErrorPayload(error);
    publishWorkerFailure(payload);
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  });
}
