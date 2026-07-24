import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseModalNodeSandboxInput } from "./node-provider.js";

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
    await runChecked("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", archivePath, "-C", PROJECT_ROOT], "/");
    assertSafeTree(PROJECT_ROOT);
    await runChecked(
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
    const staging = path.join(publishing, "bundle");
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    copySafeTree(artifactDir, path.join(staging, "artifacts"));
    if (fs.existsSync(workspaceDir)) {
      copySafeTree(workspaceDir, path.join(staging, "workspace"));
    }
    const artifactArchive = path.join(publishing, "artifacts.tgz");
    await runChecked("tar", ["-czf", artifactArchive, "-C", staging, "."], PROJECT_ROOT);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(artifactArchive)).digest("hex");
    fs.writeFileSync(
      path.join(publishing, "result.json"),
      `${JSON.stringify({
        schema_version: "ultrafuzz.modal.node-result.v1",
        status: "succeeded",
        artifact_archive: path.posix.join(dataRoot, "artifacts.tgz"),
        artifact_sha256: digest,
        storage_lineage: `${input.run_id}/${input.attempt_id}`
      })}\n`,
      { mode: 0o600 }
    );
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.renameSync(publishing, dataRoot);
    await runChecked("sync", [], dataRoot);
  } catch (error) {
    fs.rmSync(publishing, { recursive: true, force: true });
    throw error;
  }
}

async function runChecked(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {}
): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore"]
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error("cloud worker operation failed");
  }
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
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.trim() === "") throw new Error("cloud worker option is missing");
  return value;
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
