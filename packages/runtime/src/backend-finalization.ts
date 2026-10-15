import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { fsyncDirectory, parseStrictJsonBytes, writeJsonDurable } from "@ultrafuzz/artifacts";
import {
  applyWorkspacePatch,
  captureWorkspacePatch,
  captureWorkspaceTree,
  type WorkspacePatchCapture
} from "./workspace-handoff.js";

const timestamp = z.number().int().nonnegative();
const policySchema = z.strictObject({
  version: z.literal(1),
  token: z.uuid(),
  binding: z.string().regex(/^[a-f0-9]{64}$/u),
  artifactDirectory: z.string(),
  mirrorArtifactDirectory: z.string().optional(),
  workspace: z
    .strictObject({ root: z.string(), productionSourceRoots: z.array(z.string()), baselineTree: z.string() })
    .optional(),
  startedAt: timestamp,
  executionDeadline: timestamp,
  graceMs: timestamp
});
const completionSchema = z.strictObject({
  version: z.literal(1),
  token: z.uuid(),
  binding: z.string().regex(/^[a-f0-9]{64}$/u),
  completedAt: timestamp,
  exitCode: z.literal(0),
  evidenceReady: z.boolean(),
  evidenceDirectory: z.string()
});
const statusSchema = z.strictObject({
  phase: z.enum(["execution", "finalization", "completed", "timed-out", "aborted", "failed"]),
  started_at_ms: timestamp,
  execution_deadline_ms: timestamp,
  finalization_deadline_ms: timestamp.nullable(),
  finalization_grace_ms: timestamp,
  last_activity_at_ms: timestamp,
  checkpoint_available: z.boolean()
});
export type BackendFinalizationStatus = z.infer<typeof statusSchema>;
interface BackendGenerationOptions {
  prompt?: unknown;
  abortSignal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export function backendCheckpointDirectory(runRoot: string, nodeId: string): string {
  return path.join(runRoot, "backend-checkpoints", createHash("sha256").update(nodeId).digest("hex"));
}

function readDocument<T>(file: string, schema: z.ZodType<T>): T | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("invalid backend checkpoint document");
    return schema.parse(parseStrictJsonBytes(fs.readFileSync(file)));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function readBackendFinalizationStatus(directory: string): BackendFinalizationStatus | undefined {
  return readDocument(path.join(directory, "status.json"), statusSchema);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The engine supplies the outer execution + grace ceiling. This inner deadline
 * still stops an ordinary/hung generation at its original execution limit.
 * Only the checkpoint runner's successful exit admits finalization; stdout,
 * heartbeats, provider retries and model text never extend either deadline.
 */
interface FinalizationInput {
  directory: string;
  artifactDirectory: string;
  mirrorArtifactDirectory?: string;
  binding: string;
  timeoutMs: number;
  graceMs: number;
  startedAt?: number;
  workspace?: { root: string; productionSourceRoots: string[] };
}

function prepareFinalization(input: FinalizationInput) {
  if (!Number.isSafeInteger(input.graceMs) || input.graceMs < 0 || input.graceMs > 3_600_000) {
    throw new Error("backend finalization grace must be between 0 and 3600000ms");
  }
  fs.mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(input.directory) !== path.resolve(input.directory)) {
    throw new Error("backend checkpoint directory must not contain symlinks");
  }
  const startedAt = input.startedAt ?? Date.now();
  const policy = policySchema.parse({
    version: 1,
    token: randomUUID(),
    binding: createHash("sha256").update(input.binding).digest("hex"),
    artifactDirectory: fs.realpathSync(input.artifactDirectory),
    ...(input.mirrorArtifactDirectory === undefined
      ? {}
      : { mirrorArtifactDirectory: fs.realpathSync(input.mirrorArtifactDirectory) }),
    startedAt,
    executionDeadline: startedAt + input.timeoutMs,
    graceMs: input.graceMs,
    ...(input.workspace === undefined
      ? {}
      : { workspace: { ...input.workspace, baselineTree: captureWorkspaceTree(input.workspace.root) } })
  });
  const completionPath = path.join(input.directory, "completed.json");
  const previous = readDocument(completionPath, completionSchema);
  const reusable = previous?.binding === policy.binding && previous.evidenceReady;
  if (reusable) {
    if (previous.evidenceDirectory !== path.join(input.directory, previous.token)) {
      throw new Error("backend checkpoint evidence directory is invalid");
    }
    snapshotBackendEvidence(
      path.join(previous.evidenceDirectory, "canonical"),
      policy.artifactDirectory,
      startedAt + policy.graceMs
    );
    if (policy.mirrorArtifactDirectory !== undefined) {
      snapshotBackendEvidence(
        path.join(previous.evidenceDirectory, "workspace"),
        policy.mirrorArtifactDirectory,
        startedAt + policy.graceMs
      );
    }
    if (policy.workspace !== undefined) restoreBackendWorkspace(policy.workspace, previous.evidenceDirectory);
  }
  writeJsonDurable(path.join(input.directory, "active.json"), policy);
  return { policy, reusable };
}

class FinalizationMonitor {
  readonly controller = new AbortController();
  readonly status: BackendFinalizationStatus;
  ended = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rejectDeadline: (error: Error) => void = () => undefined;
  readonly deadline = new Promise<never>((_resolve, reject) => {
    this.rejectDeadline = reject;
  });

  constructor(
    private readonly directory: string,
    private readonly policy: z.infer<typeof policySchema>,
    reusable: boolean,
    private readonly signal?: AbortSignal
  ) {
    this.status = {
      phase: reusable ? "finalization" : "execution",
      started_at_ms: policy.startedAt,
      execution_deadline_ms: policy.executionDeadline,
      finalization_deadline_ms: reusable ? policy.startedAt + policy.graceMs : null,
      finalization_grace_ms: policy.graceMs,
      last_activity_at_ms: policy.startedAt,
      checkpoint_available: reusable
    };
    this.save();
  }

  private save(): void {
    writeJsonDurable(path.join(this.directory, "status.json"), this.status);
  }

  private stop(phase: "timed-out" | "aborted", cause?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    const previousPhase = this.status.phase;
    this.status.phase = phase;
    this.save();
    const status = this.status;
    const error = Object.assign(
      new Error(
        `Backend task ${phase}: phase=${previousPhase}, elapsed_ms=${String(Date.now() - status.started_at_ms)}, ` +
          `execution_deadline_ms=${String(status.execution_deadline_ms)}, ` +
          `finalization_deadline_ms=${String(status.finalization_deadline_ms)}, ` +
          `finalization_grace_ms=${String(status.finalization_grace_ms)}, ` +
          `last_activity_at_ms=${String(status.last_activity_at_ms)}, ` +
          `checkpoint_available=${String(status.checkpoint_available)}`,
        { cause }
      ),
      { code: phase === "timed-out" ? "PROCESS_TIMEOUT" : "TASK_ABORTED" }
    );
    // Reject before propagating cancellation so an adapter's generic abort
    // error cannot hide the phase/deadline diagnostics.
    this.rejectDeadline(error);
    this.controller.abort(error);
  }

  private readonly aborted = (): void => {
    this.stop("aborted", this.signal?.reason);
  };

  start(): void {
    this.signal?.addEventListener("abort", this.aborted, { once: true });
    if (this.signal?.aborted === true) this.aborted();
    else this.check();
  }

  refreshCompletion(): void {
    const completion = readDocument(path.join(this.directory, "completed.json"), completionSchema);
    const { policy, status } = this;
    const before = JSON.stringify(status);
    if (
      status.phase === "execution" &&
      completion?.binding === policy.binding &&
      completion.token === policy.token &&
      completion.completedAt >= policy.startedAt &&
      completion.completedAt <= policy.executionDeadline
    ) {
      status.phase = "finalization";
      // Preserve already-budgeted finalization time for early completion.
      status.finalization_deadline_ms = Math.max(policy.executionDeadline, completion.completedAt + policy.graceMs);
    }
    if (status.phase === "finalization") {
      status.checkpoint_available = completion?.binding === policy.binding && completion.evidenceReady;
    }
    if (JSON.stringify(status) !== before) this.save();
  }

  verifyDeadline(): boolean {
    this.refreshCompletion();
    if (Date.now() >= (this.status.finalization_deadline_ms ?? this.policy.executionDeadline)) this.stop("timed-out");
    return !this.ended;
  }

  private readonly check = (): void => {
    if (this.ended) return;
    try {
      this.refreshCompletion();
      const limit = this.status.finalization_deadline_ms ?? this.policy.executionDeadline;
      if (Date.now() >= limit) {
        this.stop("timed-out");
      } else {
        this.timer = setTimeout(this.check, Math.min(100, limit - Date.now()));
      }
    } catch (error) {
      this.ended = true;
      this.status.phase = "failed";
      this.rejectDeadline(error instanceof Error ? error : new Error("invalid backend checkpoint"));
      this.controller.abort(error);
    }
  };

  activity(): void {
    if (this.ended) return;
    const now = Date.now();
    if (now - this.status.last_activity_at_ms >= 1_000) {
      this.status.last_activity_at_ms = now;
      this.save();
    }
  }

  finish(succeeded: boolean): void {
    if (!this.ended) this.status.phase = succeeded ? "completed" : "failed";
    this.ended = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.aborted);
    this.save();
  }
}

function finalizationContext(directory: string, policy: z.infer<typeof policySchema>, reusable: boolean): string {
  return [
    "\n\n## Checkpointed backend finalization",
    `Execution deadline (UTC): ${new Date(policy.executionDeadline).toISOString()}.`,
    `Bounded finalization grace: ${String(policy.graceMs)}ms. Provider backoff does not extend this budget.`,
    "For checkpointed finalization only, this replaces the earlier prompt-only hard-deadline instruction; ordinary execution keeps its original deadline.",
    `Run the final backend exactly once through: ultrafuzz backend run ${shellQuote(directory)} -- <command>`,
    "Keep the existing supervisor and exact backend arguments inside <command>. Smoke tests are not the final backend.",
    "Backend stdout/stderr are captured in the checkpoint's per-launch stdout.log/stderr.log files. Copy them to the declared artifact log/evidence paths; redirecting the wrapper's stdout does not capture backend output. completed.json names the completed evidence directory.",
    "Only a successful exit checkpoints raw evidence and admits grace. Heartbeats never extend deadlines.",
    "Use the recorded backend exit time for execution.finished_at and end_timestamp. Later artifact finalization must not rewrite the backend execution timestamps or deadline arithmetic.",
    `Checkpoint contents survive artifact cleanup: ${shellQuote(directory)}. They are unverified inputs, not published findings.`,
    reusable
      ? `A successful backend checkpoint already exists. Do not rerun fuzzing. Restore its evidence to the required artifact paths and finish validation within ${String(policy.graceMs)}ms.`
      : "After the backend exits, only parse/checkpoint evidence, generate reproducers and finalize/validate artifacts; do not start another campaign."
  ].join("\n");
}

export async function withBackendFinalization<T, TArgs extends BackendGenerationOptions>(
  input: FinalizationInput & {
    args: TArgs;
    generate: (args: TArgs) => Promise<T>;
  }
): Promise<T> {
  if (input.graceMs === 0) return input.generate(input.args);
  const { policy, reusable } = prepareFinalization(input);
  const monitor = new FinalizationMonitor(input.directory, policy, reusable, input.args.abortSignal);
  let succeeded = false;
  try {
    monitor.start();
    if (monitor.ended) return await monitor.deadline;
    const context = finalizationContext(input.directory, policy, reusable);
    const result = await Promise.race([
      input.generate({
        ...input.args,
        prompt: `${typeof input.args.prompt === "string" ? input.args.prompt : ""}${context}`,
        abortSignal: monitor.controller.signal,
        onStdout: (text) => {
          monitor.activity();
          input.args.onStdout?.(text);
        },
        onStderr: (text) => {
          monitor.activity();
          input.args.onStderr?.(text);
        }
      }),
      monitor.deadline
    ]);
    if (!monitor.verifyDeadline()) return await monitor.deadline;
    succeeded = true;
    return result;
  } finally {
    monitor.finish(succeeded);
  }
}

/** Run-scoped raw evidence is never removed by artifact retry cleanup. */
export async function runCheckpointedBackend(directory: string, command: readonly string[]): Promise<number> {
  const policy = readDocument(path.join(directory, "active.json"), policySchema);
  if (policy === undefined || command.length === 0 || command[0] === undefined) {
    throw new Error("backend run requires an active task policy and a command after --");
  }
  const prior = readDocument(path.join(directory, "completed.json"), completionSchema);
  if (prior?.binding === policy.binding && prior.evidenceReady) {
    throw new Error("backend already completed; reuse the checkpoint and finalize artifacts instead of rerunning");
  }
  if (Date.now() >= policy.executionDeadline) throw new Error("backend execution deadline has expired");
  const evidenceDirectory = path.join(directory, policy.token);
  fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
  // Exclusive creation is also the one-backend-per-attempt admission fence.
  const stdout = fs.openSync(path.join(evidenceDirectory, "stdout.log"), "wx", 0o600);
  const stderr = fs.openSync(path.join(evidenceDirectory, "stderr.log"), "wx", 0o600);
  const child = spawn(command[0], command.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = { requested: false };
  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  const cancel = (): void => {
    if (cancellation.requested) return;
    cancellation.requested = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => {
      kill("SIGKILL");
    }, 2_000);
  };
  const executionTimer = setTimeout(cancel, Math.max(0, policy.executionDeadline - Date.now()));
  const logFailure: { error?: Error } = {};
  const logError = (error: unknown): void => {
    logFailure.error = error instanceof Error ? error : new Error("backend log capture failed", { cause: error });
    cancel();
  };
  child.stdout.on("data", boundedLogWriter(stdout, logError));
  child.stderr.on("data", boundedLogWriter(stderr, logError));
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => {
        resolve(exitCode ?? 1);
      });
    });
    const completedAt = Date.now();
    if (logFailure.error !== undefined) throw logFailure.error;
    fs.fsyncSync(stdout);
    fs.fsyncSync(stderr);
    if (code === 0 && !cancellation.requested && completedAt <= policy.executionDeadline) {
      checkpointSuccessfulBackend({ directory, evidenceDirectory, completedAt, policy });
    }
    return cancellation.requested ? 1 : code;
  } finally {
    clearTimeout(executionTimer);
    if (cancellation.requested) kill("SIGKILL");
    if (killTimer !== undefined) clearTimeout(killTimer);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

function boundedLogWriter(fd: number, onError: (error: unknown) => void): (chunk: Buffer) => void {
  let remaining = 16 * 1024 * 1024;
  let truncated = false;
  let failed = false;
  return (chunk) => {
    if (failed) return;
    try {
      const length = Math.min(remaining, chunk.length);
      if (length > 0) fs.writeSync(fd, chunk.subarray(0, length));
      remaining -= length;
      if (length < chunk.length && !truncated) {
        truncated = true;
        fs.writeSync(fd, "\n[backend log truncated at 16 MiB; inspect structured evidence]\n");
      }
    } catch (error) {
      failed = true;
      onError(error);
    }
  };
}

function checkpointSuccessfulBackend(input: {
  directory: string;
  evidenceDirectory: string;
  completedAt: number;
  policy: z.infer<typeof policySchema>;
}): void {
  const { directory, evidenceDirectory, completedAt, policy } = input;
  const completion = {
    version: 1,
    token: policy.token,
    binding: policy.binding,
    completedAt,
    exitCode: 0,
    evidenceReady: false,
    evidenceDirectory
  };
  // Admit the bounded phase on exit. Copying evidence itself consumes
  // finalization time; only the second durable receipt is reusable on retry.
  writeJsonDurable(path.join(directory, "completed.json"), completion);
  const deadline = Math.max(policy.executionDeadline, completedAt + policy.graceMs);
  snapshotBackendEvidence(policy.artifactDirectory, path.join(evidenceDirectory, "canonical"), deadline);
  if (policy.mirrorArtifactDirectory !== undefined) {
    snapshotBackendEvidence(policy.mirrorArtifactDirectory, path.join(evidenceDirectory, "workspace"), deadline);
  }
  if (policy.workspace !== undefined) {
    writeJsonDurable(
      path.join(evidenceDirectory, "workspace-patch.json"),
      captureWorkspacePatch(
        policy.workspace.root,
        policy.workspace.baselineTree,
        policy.workspace.productionSourceRoots
      )
    );
  }
  fsyncDirectory(evidenceDirectory);
  if (Date.now() >= deadline) throw new Error("backend evidence checkpoint exceeded finalization deadline");
  writeJsonDurable(path.join(directory, "completed.json"), { ...completion, evidenceReady: true });
}

function restoreBackendWorkspace(
  workspace: NonNullable<z.infer<typeof policySchema>["workspace"]>,
  directory: string
): void {
  const patchPath = path.join(directory, "workspace-patch.json");
  const stat = fs.lstatSync(patchPath);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("invalid backend workspace checkpoint");
  const capture = parseStrictJsonBytes(fs.readFileSync(patchPath), {
    maxBytes: 32 * 1024 * 1024
  }) as WorkspacePatchCapture;
  applyWorkspacePatch(workspace.root, capture, workspace.productionSourceRoots);
}

function snapshotBackendEvidence(artifactDirectory: string, checkpoint: string, deadline: number): void {
  if (
    !fs.lstatSync(artifactDirectory).isDirectory() ||
    fs.realpathSync(artifactDirectory) !== path.resolve(artifactDirectory)
  ) {
    throw new Error("unsafe backend checkpoint source");
  }
  fs.mkdirSync(checkpoint, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(checkpoint) !== path.resolve(checkpoint))
    throw new Error("unsafe backend checkpoint destination");
  let remainingBytes = 512 * 1024 * 1024;
  let remainingFiles = 10_000;
  const copy = (source: string, destination: string): void => {
    if (Date.now() >= deadline) throw new Error("backend evidence checkpoint exceeded finalization deadline");
    remainingFiles -= 1;
    if (remainingFiles < 0) throw new Error("backend checkpoint evidence exceeds entry limit");
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(destination).isSymbolicLink()) throw new Error("unsafe backend checkpoint destination");
      for (const entry of fs.readdirSync(source).sort()) copy(path.join(source, entry), path.join(destination, entry));
      fsyncDirectory(destination);
    } else if (stat.isFile() && stat.nlink === 1) {
      remainingBytes -= stat.size;
      if (remainingBytes < 0) throw new Error("backend checkpoint evidence exceeds size limit");
      if (fs.existsSync(destination) && !fs.lstatSync(destination).isFile())
        throw new Error("unsafe backend checkpoint destination");
      fs.copyFileSync(source, destination);
      const fd = fs.openSync(destination, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      throw new Error("backend checkpoint evidence must contain only regular files and directories");
    }
  };
  for (const name of ["backends", "campaign-plan.json"]) {
    const source = path.join(artifactDirectory, name);
    if (fs.existsSync(source)) copy(source, path.join(checkpoint, name));
  }
  fsyncDirectory(checkpoint);
}
