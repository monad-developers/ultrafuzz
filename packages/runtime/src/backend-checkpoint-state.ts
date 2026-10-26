import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod/v4";
import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import { applyWorkspacePatch, captureWorkspacePatch, type WorkspacePatchCapture } from "./workspace-handoff.js";
import {
  CheckpointDirectory,
  assertCheckpointDeadline,
  captureEvidence,
  checkpointJson,
  evidenceManifest,
  restoreEvidence,
  snapshotBackendEvidence
} from "./backend-checkpoint-files.js";

const timestamp = z.number().int().nonnegative();
export const backendPolicySchema = z.strictObject({
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
export type BackendPolicy = z.infer<typeof backendPolicySchema>;
const completionPayloadSchema = z.strictObject({
  version: z.literal(1),
  token: z.uuid(),
  binding: z.string().regex(/^[a-f0-9]{64}$/u),
  completedAt: timestamp,
  exitCode: z.literal(0),
  evidenceReady: z.boolean(),
  evidenceDirectory: z.string(),
  manifest: z.array(
    z.strictObject({
      path: z.string(),
      size: timestamp,
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .nullable()
    })
  )
});
const completionSchema = completionPayloadSchema.extend({ proof: z.string().regex(/^[a-f0-9]{64}$/u) });
export type BackendCompletion = z.infer<typeof completionSchema>;

// Never serialized, passed to an adapter, inherited by a backend, or exposed
// through the launch endpoint. A new runtime process cannot authenticate old
// checkpoints and must fail closed; raw files remain available for diagnosis.
const receiptKey = randomBytes(32);

function proof(directory: string, payload: z.infer<typeof completionPayloadSchema>): string {
  return createHmac("sha256", receiptKey)
    .update(JSON.stringify([path.resolve(directory), payload]))
    .digest("hex");
}

export function readCheckpointDocument<T>(
  directory: string,
  name: string,
  schema: z.ZodType<T>,
  limit = 64 * 1024
): T | undefined {
  const root = CheckpointDirectory.open(directory);
  try {
    if (root.stat(name) === undefined) return undefined;
    return schema.parse(parseStrictJsonBytes(root.read(name, limit), { maxBytes: limit }));
  } finally {
    root.close();
  }
}

function readAuthenticatedCompletion(directory: string): BackendCompletion | undefined {
  const completion = readCheckpointDocument(directory, "completed.json", completionSchema, 8 * 1024 * 1024);
  if (completion === undefined) return undefined;
  const { proof: signature, ...payload } = completion;
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(proof(directory, payload), "hex"))) {
    throw new Error("backend checkpoint receipt authentication failed (modified receipt or runtime restarted)");
  }
  if (completion.evidenceDirectory !== path.join(directory, completion.token))
    throw new Error("invalid backend checkpoint evidence directory");
  return completion;
}

function restoreTree(
  destination: string,
  files: ReadonlyMap<string, Buffer | null>,
  prefix: string,
  deadline: number
): void {
  const root = CheckpointDirectory.open(destination);
  try {
    restoreEvidence(
      root,
      new Map(
        [...files]
          .filter(([name]) => name.startsWith(`${prefix}/`))
          .map(([name, bytes]) => [name.slice(prefix.length + 1), bytes])
      ),
      deadline
    );
  } finally {
    root.close();
  }
}

/** Verify the entire file set and exact bytes before any finalization-only admission or write. */
export function restoreCompletedBackend(directory: string, policy: BackendPolicy): BackendCompletion | undefined {
  const previous = readAuthenticatedCompletion(directory);
  if (previous?.binding !== policy.binding || !previous.evidenceReady) return undefined;
  const root = CheckpointDirectory.open(previous.evidenceDirectory);
  let files: Map<string, Buffer | null>;
  try {
    files = captureEvidence(root, policy.startedAt + policy.graceMs);
  } finally {
    root.close();
  }
  if (JSON.stringify(evidenceManifest(files)) !== JSON.stringify(previous.manifest))
    throw new Error("backend checkpoint evidence digest mismatch or inventory changed");
  const deadline = policy.startedAt + policy.graceMs;
  restoreTree(policy.artifactDirectory, files, "canonical", deadline);
  if (policy.mirrorArtifactDirectory !== undefined)
    restoreTree(policy.mirrorArtifactDirectory, files, "workspace", deadline);
  if (policy.workspace !== undefined) {
    const bytes = files.get("workspace-patch.json");
    if (bytes === undefined || bytes === null) throw new Error("backend workspace checkpoint is missing");
    const capture = parseStrictJsonBytes(bytes, { maxBytes: 32 * 1024 * 1024 }) as WorkspacePatchCapture;
    applyWorkspacePatch(policy.workspace.root, capture, policy.workspace.productionSourceRoots);
  }
  assertCheckpointDeadline(deadline);
  return previous;
}

export function checkpointSuccessfulBackend(input: {
  directory: string;
  completedAt: number;
  policy: BackendPolicy;
  admit: (completion: BackendCompletion) => void;
}): void {
  const { directory, completedAt, policy } = input;
  const payload = completionPayloadSchema.parse({
    version: 1,
    token: policy.token,
    binding: policy.binding,
    completedAt,
    exitCode: 0,
    evidenceReady: false,
    evidenceDirectory: path.join(directory, policy.token),
    manifest: []
  });
  const publish = (): void => {
    const completion = { ...payload, proof: proof(directory, payload) };
    checkpointJson(directory, "completed.json", completion);
    input.admit(completion);
  };
  // Only the supervisor's observed successful exit can call this, not a CLI
  // receipt or policy edit. Snapshot work consumes this fixed grace window.
  publish();
  const deadline = Math.max(policy.executionDeadline, completedAt + policy.graceMs);
  const evidence = CheckpointDirectory.open(payload.evidenceDirectory);
  try {
    const canonical = evidence.child("canonical", true);
    try {
      snapshotBackendEvidence(policy.artifactDirectory, canonical, deadline);
    } finally {
      canonical.close();
    }
    if (policy.mirrorArtifactDirectory !== undefined) {
      const mirror = evidence.child("workspace", true);
      try {
        snapshotBackendEvidence(policy.mirrorArtifactDirectory, mirror, deadline);
      } finally {
        mirror.close();
      }
    }
    if (policy.workspace !== undefined) {
      evidence.write(
        "workspace-patch.json",
        Buffer.from(
          JSON.stringify(
            captureWorkspacePatch(
              policy.workspace.root,
              policy.workspace.baselineTree,
              policy.workspace.productionSourceRoots
            )
          )
        ),
        deadline
      );
    }
    payload.manifest = [...evidenceManifest(captureEvidence(evidence, deadline))];
    assertCheckpointDeadline(deadline);
    payload.evidenceReady = true;
    publish();
  } finally {
    evidence.close();
  }
}
