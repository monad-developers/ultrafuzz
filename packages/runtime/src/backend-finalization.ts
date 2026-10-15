import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { parseStrictJsonBytes, readSinglyLinkedRegularFileSnapshotInside } from "@ultrafuzz/artifacts";
import { captureWorkspaceTree } from "./workspace-handoff.js";
import { CheckpointDirectory, checkpointJson, missingPath } from "./backend-checkpoint-files.js";
import {
  backendPolicySchema,
  checkpointSuccessfulBackend,
  readCheckpointDocument,
  restoreCompletedBackend,
  type BackendPolicy,
  type BackendCompletion
} from "./backend-checkpoint-state.js";
import { requestBackendLaunch, startBackendSupervisor } from "./backend-supervisor.js";

const nonnegativeInteger = z.number().int().nonnegative();
// JavaScript Date cannot represent every safe-integer millisecond timestamp.
const timestamp = nonnegativeInteger.max(8_640_000_000_000_000);
const statusSchema = z.strictObject({
  phase: z.enum(["execution", "finalization", "completed", "timed-out", "aborted", "failed"]),
  started_at_ms: timestamp,
  execution_deadline_ms: timestamp,
  finalization_deadline_ms: timestamp.nullable(),
  finalization_grace_ms: nonnegativeInteger,
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

export function readBackendFinalizationStatus(directory: string): BackendFinalizationStatus | undefined {
  try {
    // Optional diagnostics remain readable on hosts where checkpoint execution
    // is disabled; absence must not depend on descriptor-relative write support.
    fs.lstatSync(path.join(directory, "status.json"));
    return statusSchema.parse(
      parseStrictJsonBytes(
        readSinglyLinkedRegularFileSnapshotInside(
          directory,
          path.join(directory, "status.json"),
          64 * 1024,
          "backend status"
        )
      )
    );
  } catch (error) {
    if (missingPath(error)) return undefined;
    throw error;
  }
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
  CheckpointDirectory.open(input.directory, true).close();
  const startedAt = input.startedAt ?? Date.now();
  const policy = backendPolicySchema.parse({
    version: 1,
    token: randomUUID(),
    binding: createHash("sha256").update(input.binding).digest("hex"),
    artifactDirectory: path.resolve(input.artifactDirectory),
    ...(input.mirrorArtifactDirectory === undefined
      ? {}
      : { mirrorArtifactDirectory: path.resolve(input.mirrorArtifactDirectory) }),
    startedAt,
    executionDeadline: startedAt + input.timeoutMs,
    graceMs: input.graceMs,
    ...(input.workspace === undefined
      ? {}
      : { workspace: { ...input.workspace, baselineTree: captureWorkspaceTree(input.workspace.root) } })
  });
  try {
    const previous = restoreCompletedBackend(input.directory, policy);
    return { policy, previous };
  } catch (error) {
    checkpointJson(input.directory, "status.json", { ...initialStatus(policy, false), phase: "failed" });
    throw error;
  }
}

function initialStatus(policy: BackendPolicy, reusable: boolean): BackendFinalizationStatus {
  return {
    phase: reusable ? "finalization" : "execution",
    started_at_ms: policy.startedAt,
    execution_deadline_ms: policy.executionDeadline,
    finalization_deadline_ms: reusable ? policy.startedAt + policy.graceMs : null,
    finalization_grace_ms: policy.graceMs,
    last_activity_at_ms: policy.startedAt,
    checkpoint_available: reusable
  };
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
    private readonly policy: BackendPolicy,
    private readonly completion: () => BackendCompletion | undefined,
    reusable: boolean,
    private readonly signal?: AbortSignal
  ) {
    this.status = initialStatus(policy, reusable);
    this.save();
  }

  private save(): void {
    checkpointJson(this.directory, "status.json", this.status);
  }

  private stop(phase: "timed-out" | "aborted", cause?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    const previousPhase = this.status.phase;
    this.status.phase = phase;
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
    try {
      this.save();
    } catch (saveError) {
      this.rejectDeadline(new Error("backend checkpoint status could not be saved", { cause: saveError }));
    } finally {
      this.rejectDeadline(error);
      this.controller.abort(error);
    }
  }

  private readonly aborted = (): void => {
    this.stop("aborted", this.signal?.reason);
  };

  start(): void {
    this.signal?.addEventListener("abort", this.aborted, { once: true });
    if (this.signal?.aborted === true) this.aborted();
    else this.check();
  }

  backendExited(completedAt: number): void {
    const { policy, status } = this;
    if (
      this.ended ||
      status.phase !== "execution" ||
      completedAt < policy.startedAt ||
      completedAt > policy.executionDeadline
    )
      return;
    status.phase = "finalization";
    // Preserve already-budgeted finalization time for early completion.
    status.finalization_deadline_ms = Math.max(policy.executionDeadline, completedAt + policy.graceMs);
    this.save();
  }

  refreshCompletion(): void {
    const completion = this.completion();
    const { policy, status } = this;
    const before = JSON.stringify(status);
    if (status.phase === "execution" && completion?.binding === policy.binding && completion.token === policy.token) {
      this.backendExited(completion.completedAt);
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

function finalizationContext(directory: string, policy: BackendPolicy, reusable: boolean): string {
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
  const { policy, previous } = prepareFinalization(input);
  const reusable = previous !== undefined;
  let completion = previous;
  const monitor = new FinalizationMonitor(input.directory, policy, () => completion, reusable, input.args.abortSignal);
  const supervisor = await startBackendSupervisor({
    token: policy.token,
    executionDeadline: policy.executionDeadline,
    signal: monitor.controller.signal,
    reusable,
    exited: (completedAt) => {
      monitor.backendExited(completedAt);
    },
    evidence: () => {
      const root = CheckpointDirectory.open(input.directory);
      try {
        return root.child(policy.token, true);
      } finally {
        root.close();
      }
    },
    completed: (completedAt) => {
      checkpointSuccessfulBackend({
        directory: input.directory,
        completedAt,
        policy,
        admit: (receipt) => {
          completion = receipt;
        }
      });
      monitor.refreshCompletion();
    }
  });
  let succeeded = false;
  try {
    checkpointJson(input.directory, "active.json", { ...policy, port: supervisor.port });
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
    try {
      monitor.finish(succeeded);
    } finally {
      await supervisor.close();
    }
  }
}

/** The wrapper can request a launch, never declare success or extend a deadline. */
export async function runCheckpointedBackend(directory: string, command: readonly string[]): Promise<number> {
  const activeSchema = backendPolicySchema.extend({ port: z.number().int().min(1).max(65535) });
  const policy = readCheckpointDocument(directory, "active.json", activeSchema);
  if (policy === undefined || command.length === 0)
    throw new Error("backend run requires an active task policy and a command after --");
  return requestBackendLaunch(policy.port, policy.token, command);
}
