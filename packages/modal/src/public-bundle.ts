import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertFindingsSchema, assertRegularFileInside } from "@ultrafuzz/artifacts";
import {
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  parsePublicEvalDiagnostics
} from "@ultrafuzz/evals";
import { redactSecretsInText } from "@ultrafuzz/security";
import { z } from "zod/v4";

import type { ModalWorkerLineage } from "./launch-state.js";

export const PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION = "ultrafuzz.modal.public-benchmark-bundle.v4" as const;
export const MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES = 256 * 1024 * 1024;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_FILE_BYTES / 3);
const MAX_ROWS = 2_048;
const PUBLIC_REPORT_FILES = ["report.md", "report.json", "findings.normalized.json"] as const;
const DEFAULT_PUBLICATION_BUNDLE_PATH = "public-results.json";
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const fullSha = z.string().regex(/^[0-9a-f]{40}$/u);
const caseCount = z.number().int().nonnegative().max(MAX_ROWS);
const bundleStatus = z.enum(["succeeded", "genuine-task-failures"]);
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "must be a canonical relative POSIX path"
  );

const bundleFileSchema = z.strictObject({
  path: relativePath,
  size_bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  sha256,
  contents_base64: z.string().max(MAX_FILE_BASE64_CHARACTERS)
});

const targetPublicationLocationSchema = z.strictObject({
  bundle_path: relativePath,
  report_paths: z
    .array(relativePath)
    .min(1)
    .max(MAX_ROWS * PUBLIC_REPORT_FILES.length)
});

const bundleTargetSchema = z.strictObject({
  id: safeId,
  repository: z.string().url().max(2_048),
  revision: fullSha,
  framework: safeId.optional(),
  status: bundleStatus,
  executed_case_count: caseCount,
  graded_case_count: caseCount,
  publication_location: targetPublicationLocationSchema
});

const bundleLineageSchema = z.strictObject({
  logical_run_id: safeId,
  generation: z.number().int().positive(),
  attempt: z.number().int().positive(),
  attempt_id: safeId,
  config_fingerprint: sha256,
  source_fingerprint: sha256,
  image_fingerprint: sha256,
  model_fingerprint: sha256
});
const bundleExecutionSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("local"),
    acceptance_e2e: z.literal(false)
  }),
  z.strictObject({
    mode: z.literal("cloud"),
    provider: z.literal("modal"),
    acceptance_e2e: z.boolean()
  })
]);

const cloudAttemptState = z.enum([
  "prepared",
  "queued",
  "launching",
  "running",
  "publishing",
  "succeeded",
  "failed",
  "cancelled",
  "provider-unknown"
]);
const smokeCloudDependencies = {
  "smoke-context": [],
  "time-warp-sequences": ["smoke-context"],
  "external-dependency-boundaries": ["smoke-context"],
  "externalized-state-accounting": ["smoke-context"],
  "lifecycle-view-boundaries": ["smoke-context"],
  "dedupe-findings": [
    "smoke-context",
    "time-warp-sequences",
    "external-dependency-boundaries",
    "externalized-state-accounting",
    "lifecycle-view-boundaries"
  ],
  "final-report": [
    "smoke-context",
    "time-warp-sequences",
    "external-dependency-boundaries",
    "externalized-state-accounting",
    "lifecycle-view-boundaries",
    "dedupe-findings"
  ]
} as const;
const cloudIdentity = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const publicCloudAttemptSchema = z.strictObject({
  logical_node_id: safeId,
  task_id: cloudIdentity,
  attempt_id: cloudIdentity,
  execution_generation: safeId,
  state: z.literal("succeeded"),
  requested_resources: z.strictObject({
    cpu: z.number().positive().finite(),
    memory_mib: z.number().int().positive(),
    timeout_seconds: z.number().int().positive()
  }),
  resolved_resources: z.strictObject({
    cpu: z.number().positive().finite(),
    memory_mib: z.number().int().positive(),
    timeout_seconds: z.number().int().positive()
  }),
  resource_confirmation: z.enum(["provider-create-accepted", "provider-reattached"]),
  handoff_sha256: sha256,
  request_sha256: sha256,
  dependency_inputs: z
    .array(
      z.strictObject({
        logical_node_id: safeId,
        attempt_id: cloudIdentity,
        sha256
      })
    )
    .max(64),
  provider_execution_ids: z.array(cloudIdentity).min(1).max(16),
  retry_index: z.number().int().nonnegative().max(15),
  executed: z.literal(true),
  resumed: z.boolean(),
  reused: z.boolean(),
  storage_lineage: z.string().min(1).max(2_048),
  output_sha256: sha256,
  publication_artifact_sha256: sha256,
  cleanup_state: z.literal("terminated"),
  transitions: z
    .array(
      z.strictObject({
        state: cloudAttemptState,
        at: z.string().datetime({ offset: true }),
        provider_execution_id: cloudIdentity.optional()
      })
    )
    .min(1)
    .max(128)
});
const publicCloudEvidenceSchema = z
  .strictObject({
    schema_version: z.literal("ultrafuzz.modal.public-cloud-evidence.v1"),
    row_id: safeId,
    run_id: safeId,
    controller_run_id: cloudIdentity,
    provider: z.literal("modal"),
    acceptance_e2e: z.boolean(),
    controlled_faults: z
      .array(
        z.strictObject({
          fault: z.enum(["detach", "interrupt"]),
          task_id: cloudIdentity,
          attempt_id: cloudIdentity,
          execution_generation: safeId,
          claimed_at: z.string().datetime({ offset: true })
        })
      )
      .max(2),
    resume: z
      .strictObject({
        action: z.literal("resume"),
        submitted: z.literal(true),
        pause_request_status: z.literal("pause-requested"),
        pause_requested_at: z.string().datetime({ offset: true }),
        pause_status: z.literal("paused"),
        pause_detach_attempt_ids: z.array(cloudIdentity).length(1),
        pause_detach_claims: z.record(
          cloudIdentity,
          z.strictObject({
            controller_run_id: cloudIdentity,
            task_id: cloudIdentity,
            attempt_id: cloudIdentity,
            provider_execution_id: cloudIdentity,
            provider_state_at_detach: z.literal("live"),
            claimed_at: z.string().datetime({ offset: true })
          })
        ),
        completed_attempt_ids_before_pause: z.array(cloudIdentity).min(1).max(64),
        live_attempt_ids_before_pause: z.array(cloudIdentity).min(1).max(64),
        attempt_states_before_pause: z.record(cloudIdentity, cloudAttemptState),
        attempt_provider_execution_ids_before_pause: z.record(cloudIdentity, z.array(cloudIdentity).min(1).max(16)),
        completed_attempt_ids_before_resume: z.array(cloudIdentity).min(1).max(64),
        live_attempt_ids_before_resume: z.array(cloudIdentity).min(1).max(64),
        attempt_states_before_resume: z.record(cloudIdentity, cloudAttemptState),
        provider_execution_ids_before_resume: z.array(cloudIdentity).min(1).max(128),
        attempt_provider_execution_ids_before_resume: z.record(cloudIdentity, z.array(cloudIdentity).min(1).max(16)),
        invoked_at: z.string().datetime({ offset: true })
      })
      .optional(),
    attempts: z.array(publicCloudAttemptSchema).min(1).max(2_048)
  })
  .superRefine((value, context) => {
    if (
      value.acceptance_e2e &&
      (value.resume === undefined || value.attempts.length !== 7 || value.controlled_faults.length !== 2)
    ) {
      context.addIssue({
        code: "custom",
        message: "cloud acceptance evidence requires controlled fault and resume proof with exactly seven attempts"
      });
    }
    if (!value.acceptance_e2e && (value.resume !== undefined || value.controlled_faults.length !== 0)) {
      context.addIssue({
        code: "custom",
        message: "non-acceptance cloud evidence must not claim controlled fault or resume proof"
      });
    }
    const logical = new Set<string>();
    const providerIds = new Set<string>();
    for (const attempt of value.attempts) {
      if (logical.has(attempt.logical_node_id)) {
        context.addIssue({ code: "custom", message: "cloud evidence repeats a logical node" });
      }
      logical.add(attempt.logical_node_id);
      if (JSON.stringify(attempt.requested_resources) !== JSON.stringify(attempt.resolved_resources)) {
        context.addIssue({ code: "custom", message: "cloud evidence resolved resources do not match the request" });
      }
      if (
        new Set(attempt.dependency_inputs.map((dependency) => dependency.logical_node_id)).size !==
        attempt.dependency_inputs.length
      ) {
        context.addIssue({ code: "custom", message: "cloud evidence repeats a dependency producer" });
      }
      if (attempt.retry_index !== Math.max(0, attempt.provider_execution_ids.length - 1)) {
        context.addIssue({ code: "custom", message: "cloud evidence retry index does not match provider executions" });
      }
      for (const providerId of attempt.provider_execution_ids) {
        if (providerIds.has(providerId)) {
          context.addIssue({ code: "custom", message: "cloud evidence reuses a provider execution" });
        }
        providerIds.add(providerId);
      }
    }
    const attemptsByLogicalNode = new Map(value.attempts.map((attempt) => [attempt.logical_node_id, attempt]));
    for (const attempt of value.attempts) {
      for (const dependency of attempt.dependency_inputs) {
        const producer = attemptsByLogicalNode.get(dependency.logical_node_id);
        if (
          producer === undefined ||
          producer.attempt_id !== dependency.attempt_id ||
          producer.publication_artifact_sha256 !== dependency.sha256
        ) {
          context.addIssue({
            code: "custom",
            message: `cloud evidence producer identity is invalid or producer publication digest is mismatched for ${attempt.logical_node_id}`
          });
        }
      }
    }
    if (!value.acceptance_e2e || value.resume === undefined) return;
    const attemptsByNode = new Map(value.attempts.map((attempt) => [attempt.logical_node_id, attempt]));
    const attemptsById = new Map(value.attempts.map((attempt) => [attempt.attempt_id, attempt]));
    if (
      attemptsByNode.size !== Object.keys(smokeCloudDependencies).length ||
      attemptsById.size !== value.attempts.length ||
      Object.keys(smokeCloudDependencies).some((nodeId) => !attemptsByNode.has(nodeId))
    ) {
      context.addIssue({ code: "custom", message: "cloud acceptance topology is not the exact smoke topology" });
      return;
    }
    for (const [nodeId, dependencies] of Object.entries(smokeCloudDependencies)) {
      const attempt = attemptsByNode.get(nodeId)!;
      const actualDependencies = attempt.dependency_inputs.map((dependency) => dependency.logical_node_id).sort();
      if (JSON.stringify(actualDependencies) !== JSON.stringify([...dependencies].sort())) {
        context.addIssue({ code: "custom", message: `cloud acceptance fan-in is invalid for ${nodeId}` });
      }
      for (const dependency of attempt.dependency_inputs) {
        if (attemptsByNode.get(dependency.logical_node_id)?.attempt_id !== dependency.attempt_id) {
          context.addIssue({ code: "custom", message: `cloud acceptance producer identity is invalid for ${nodeId}` });
        }
      }
      const expectedCpu = nodeId === "smoke-context" ? 4 : 2;
      const expectedMemory = nodeId === "smoke-context" ? 8_192 : 4_096;
      if (
        attempt.requested_resources.cpu !== expectedCpu ||
        attempt.requested_resources.memory_mib !== expectedMemory ||
        attempt.requested_resources.timeout_seconds !== 1_800
      ) {
        context.addIssue({ code: "custom", message: `cloud acceptance resources are invalid for ${nodeId}` });
      }
      const expectedExecutions = nodeId === "external-dependency-boundaries" ? 2 : 1;
      if (attempt.provider_execution_ids.length !== expectedExecutions) {
        context.addIssue({ code: "custom", message: `cloud acceptance replacement count is invalid for ${nodeId}` });
      }
    }
    const faults = new Map(value.controlled_faults.map((fault) => [fault.fault, fault]));
    const detachAttempt = attemptsByNode.get("smoke-context")!;
    const interruptAttempt = attemptsByNode.get("external-dependency-boundaries")!;
    const detach = faults.get("detach");
    const interrupt = faults.get("interrupt");
    if (
      faults.size !== 2 ||
      detach === undefined ||
      interrupt === undefined ||
      detach.task_id !== detachAttempt.task_id ||
      detach.attempt_id !== detachAttempt.attempt_id ||
      detach.execution_generation !== detachAttempt.execution_generation ||
      interrupt.task_id !== interruptAttempt.task_id ||
      interrupt.attempt_id !== interruptAttempt.attempt_id ||
      interrupt.execution_generation !== interruptAttempt.execution_generation
    ) {
      context.addIssue({ code: "custom", message: "cloud acceptance controlled fault identities are invalid" });
    } else {
      assertControlledFaultTransitions(detachAttempt, detach, "detach", context);
      assertControlledFaultTransitions(interruptAttempt, interrupt, "interrupt", context);
    }
    const contextAttempt = attemptsByNode.get("smoke-context")!;
    if (!contextAttempt.resumed && !contextAttempt.reused) {
      context.addIssue({ code: "custom", message: "cloud acceptance did not prove controller reattachment" });
    }
    const resume = value.resume;
    if (!sameStringSet(resume.pause_detach_attempt_ids, Object.keys(resume.pause_detach_claims))) {
      context.addIssue({ code: "custom", message: "cloud acceptance pause detach claim summary is inconsistent" });
    }
    for (const attemptId of resume.pause_detach_attempt_ids) {
      const attempt = attemptsById.get(attemptId);
      const claim = resume.pause_detach_claims[attemptId];
      const beforeResumeIds = resume.attempt_provider_execution_ids_before_resume[attemptId];
      if (
        attempt === undefined ||
        claim === undefined ||
        claim.controller_run_id !== value.controller_run_id ||
        claim.task_id !== attempt.task_id ||
        claim.attempt_id !== attemptId ||
        Date.parse(claim.claimed_at) < Date.parse(resume.pause_requested_at) ||
        !resume.live_attempt_ids_before_resume.includes(attemptId) ||
        resume.attempt_states_before_resume[attemptId] !== "provider-unknown" ||
        beforeResumeIds === undefined ||
        !beforeResumeIds.includes(claim.provider_execution_id) ||
        !attempt.provider_execution_ids.includes(claim.provider_execution_id) ||
        attempt.resource_confirmation !== "provider-reattached" ||
        !attempt.transitions.some(
          (transition) =>
            transition.state === "running" &&
            transition.provider_execution_id === claim.provider_execution_id &&
            Date.parse(transition.at) >= Math.max(Date.parse(claim.claimed_at), Date.parse(resume.invoked_at))
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "cloud acceptance did not reattach the provider deliberately detached after pause request"
        });
      }
    }
    for (const attemptId of [
      ...resume.pause_detach_attempt_ids,
      ...Object.keys(resume.attempt_states_before_pause),
      ...Object.keys(resume.attempt_states_before_resume),
      ...Object.keys(resume.attempt_provider_execution_ids_before_pause),
      ...Object.keys(resume.attempt_provider_execution_ids_before_resume)
    ]) {
      if (!attemptsById.has(attemptId)) {
        context.addIssue({ code: "custom", message: "cloud acceptance resume evidence names an unknown attempt" });
      }
    }
    const liveStates = new Set(["queued", "launching", "running", "publishing", "provider-unknown"]);
    for (const attemptId of resume.completed_attempt_ids_before_pause) {
      const attempt = attemptsById.get(attemptId);
      const beforeIds = resume.attempt_provider_execution_ids_before_pause[attemptId];
      const beforeResumeIds = resume.attempt_provider_execution_ids_before_resume[attemptId];
      if (
        attempt === undefined ||
        resume.attempt_states_before_pause[attemptId] !== "succeeded" ||
        resume.attempt_states_before_resume[attemptId] !== "succeeded" ||
        beforeIds === undefined ||
        beforeResumeIds === undefined ||
        !sameStringSet(beforeResumeIds, beforeIds) ||
        !sameStringSet(beforeIds, attempt.provider_execution_ids)
      ) {
        context.addIssue({ code: "custom", message: "cloud acceptance repeated completed work across pause" });
      }
    }
    for (const attemptId of resume.live_attempt_ids_before_pause) {
      const attempt = attemptsById.get(attemptId);
      const beforeIds = resume.attempt_provider_execution_ids_before_pause[attemptId];
      const beforeResumeIds = resume.attempt_provider_execution_ids_before_resume[attemptId];
      const beforeResumeState = resume.attempt_states_before_resume[attemptId];
      if (
        attempt === undefined ||
        !liveStates.has(resume.attempt_states_before_pause[attemptId] ?? "") ||
        beforeIds === undefined ||
        beforeResumeIds === undefined ||
        (!liveStates.has(beforeResumeState ?? "") && beforeResumeState !== "succeeded") ||
        beforeIds.some((providerId) => !beforeResumeIds.includes(providerId)) ||
        beforeResumeIds.some((providerId) => !attempt.provider_execution_ids.includes(providerId)) ||
        (attempt.logical_node_id !== "external-dependency-boundaries" &&
          (beforeIds.length !== beforeResumeIds.length || beforeIds.length !== attempt.provider_execution_ids.length))
      ) {
        context.addIssue({ code: "custom", message: "cloud acceptance duplicated or lost live work across pause" });
      }
    }
    for (const attemptId of resume.live_attempt_ids_before_resume) {
      const attempt = attemptsById.get(attemptId);
      const beforeIds = resume.attempt_provider_execution_ids_before_resume[attemptId];
      if (
        attempt === undefined ||
        !liveStates.has(resume.attempt_states_before_resume[attemptId] ?? "") ||
        beforeIds === undefined ||
        beforeIds.some((providerId) => !attempt.provider_execution_ids.includes(providerId)) ||
        (attempt.logical_node_id !== "external-dependency-boundaries" &&
          beforeIds.length !== attempt.provider_execution_ids.length)
      ) {
        context.addIssue({ code: "custom", message: "cloud acceptance duplicated or lost live work after pause" });
      }
    }
    for (const attemptId of resume.completed_attempt_ids_before_resume) {
      const attempt = attemptsById.get(attemptId);
      const beforeIds = resume.attempt_provider_execution_ids_before_resume[attemptId];
      if (
        attempt === undefined ||
        beforeIds === undefined ||
        !sameStringSet(beforeIds, attempt.provider_execution_ids)
      ) {
        context.addIssue({ code: "custom", message: "cloud acceptance repeated completed work after resume" });
      }
    }
    const providerIdsBeforeResume = Object.values(resume.attempt_provider_execution_ids_before_resume).flat();
    if (!sameStringSet(providerIdsBeforeResume, resume.provider_execution_ids_before_resume)) {
      context.addIssue({
        code: "custom",
        message: "cloud acceptance resume provider identity summary is inconsistent"
      });
    }
  });

function assertControlledFaultTransitions(
  attempt: z.infer<typeof publicCloudAttemptSchema>,
  fault: z.infer<typeof publicCloudEvidenceSchema>["controlled_faults"][number],
  kind: "detach" | "interrupt",
  context: z.RefinementCtx
): void {
  const firstProviderId = attempt.provider_execution_ids[0];
  const secondProviderId = attempt.provider_execution_ids[1];
  const claimedAt = Date.parse(fault.claimed_at);
  const preFault = attempt.transitions.some(
    (transition) =>
      transition.provider_execution_id === firstProviderId &&
      (transition.state === "launching" || transition.state === "running") &&
      Date.parse(transition.at) <= claimedAt
  );
  const terminalAfterFault = attempt.transitions.some(
    (transition) =>
      ["failed", "cancelled", "provider-unknown"].includes(transition.state) && Date.parse(transition.at) >= claimedAt
  );
  const resumedSameProvider = attempt.transitions.some(
    (transition) =>
      kind === "detach" &&
      transition.provider_execution_id === firstProviderId &&
      transition.state === "running" &&
      Date.parse(transition.at) >= claimedAt
  );
  const launchedReplacement =
    kind === "interrupt" &&
    secondProviderId !== undefined &&
    secondProviderId !== firstProviderId &&
    attempt.transitions.some(
      (transition) =>
        transition.provider_execution_id === secondProviderId &&
        (transition.state === "launching" || transition.state === "running") &&
        Date.parse(transition.at) >= claimedAt
    );
  if (!preFault || !terminalAfterFault || (kind === "detach" ? !resumedSameProvider : !launchedReplacement)) {
    context.addIssue({ code: "custom", message: `cloud acceptance ${kind} transition proof is invalid` });
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}

const bundleSchema = z.strictObject({
  schema_version: z.literal(PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION),
  benchmark: z.enum(["evmbench", "ultrafuzz-bench"]),
  lane: z.enum(["smoke", "full"]),
  model_slug: safeId,
  model: z.string().min(1).max(256),
  reasoning: z.string().min(1).max(64),
  judge_model: z.literal("gpt-5.6-sol"),
  judge_reasoning: z.literal("xhigh"),
  candidate_commit: z.string().regex(/^[0-9a-f]{40}$/u),
  eval_run_id: safeId,
  lineage: bundleLineageSchema,
  execution: bundleExecutionSchema,
  status: bundleStatus,
  executed_case_count: caseCount,
  graded_case_count: caseCount,
  targets: z.array(bundleTargetSchema).min(1).max(MAX_ROWS),
  created_at: z.string().datetime({ offset: true }),
  files: z
    .array(bundleFileSchema)
    .min(1)
    .max(MAX_ROWS * 4 + 16)
});

export type PublicBenchmarkBundle = z.infer<typeof bundleSchema>;
type PublicBenchmarkBundleFile = z.infer<typeof bundleFileSchema>;
type PublicBenchmarkBundleTarget = z.infer<typeof bundleTargetSchema>;
type PublicBenchmarkBundleMetadata = Pick<
  PublicBenchmarkBundle,
  "status" | "executed_case_count" | "graded_case_count" | "targets"
>;

export interface PublicBenchmarkBundleSource {
  path: string;
  root: string;
  source: string;
}

export function createPublicBenchmarkBundle(input: {
  benchmark: PublicBenchmarkBundle["benchmark"];
  lane: PublicBenchmarkBundle["lane"];
  modelSlug: string;
  model: string;
  reasoning: string;
  candidateCommit: string;
  evalRunId: string;
  lineage: Pick<
    ModalWorkerLineage,
    "logical_run_id" | "generation" | "attempt" | "attempt_id" | "fingerprints" | "model_fingerprint"
  >;
  execution?: PublicBenchmarkBundle["execution"];
  files: PublicBenchmarkBundleSource[];
  forbiddenSecretValues?: readonly string[];
  createdAt?: string;
  publicationBundlePath?: string;
}): PublicBenchmarkBundle {
  const forbiddenSecretValues = [...new Set(input.forbiddenSecretValues ?? [])].filter((value) => value.length > 0);
  const files = input.files.map((entry) => {
    const contents = readRegularFileNoFollow(entry.root, entry.source);
    if (contents.byteLength > MAX_FILE_BYTES) throw new Error(`public benchmark file is too large: ${entry.path}`);
    assertPublicBenchmarkFileContainsNoSecrets(entry.path, contents, forbiddenSecretValues);
    return {
      path: entry.path,
      size_bytes: contents.byteLength,
      sha256: digest(contents),
      contents_base64: contents.toString("base64")
    };
  });
  const metadata = summarizePublicBenchmarkBundleFiles(
    files,
    input.publicationBundlePath ?? DEFAULT_PUBLICATION_BUNDLE_PATH
  );
  const bundle = parsePublicBenchmarkBundle(
    {
      schema_version: PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION,
      benchmark: input.benchmark,
      lane: input.lane,
      model_slug: input.modelSlug,
      model: input.model,
      reasoning: input.reasoning,
      judge_model: "gpt-5.6-sol",
      judge_reasoning: "xhigh",
      candidate_commit: input.candidateCommit,
      eval_run_id: input.evalRunId,
      lineage: {
        logical_run_id: input.lineage.logical_run_id,
        generation: input.lineage.generation,
        attempt: input.lineage.attempt,
        attempt_id: input.lineage.attempt_id,
        config_fingerprint: input.lineage.fingerprints.config,
        source_fingerprint: input.lineage.fingerprints.source,
        image_fingerprint: input.lineage.fingerprints.image,
        model_fingerprint: input.lineage.model_fingerprint
      },
      execution: input.execution ?? { mode: "local", acceptance_e2e: false },
      ...metadata,
      created_at: input.createdAt ?? new Date().toISOString(),
      files
    },
    forbiddenSecretValues
  );
  if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES) {
    throw new Error("public benchmark bundle exceeds the size limit");
  }
  return bundle;
}

function assertPublicBenchmarkFileContainsNoSecrets(
  bundlePath: string,
  contents: Buffer,
  forbiddenSecretValues: readonly string[]
): void {
  if (forbiddenSecretValues.some((secret) => contents.includes(Buffer.from(secret, "utf8")))) {
    throw new Error(`public benchmark file contains an injected secret value: ${bundlePath}`);
  }
  const text = contents.toString("utf8");
  if (redactSecretsInText(text) !== text) {
    throw new Error(`public benchmark file contains secret-like content: ${bundlePath}`);
  }
}

function readRegularFileNoFollow(root: string, source: string): Buffer {
  assertRegularFileInside(root, source, "public benchmark bundle source");
  return readRegularFilePathNoFollow(source, MAX_FILE_BYTES, `public benchmark file is too large: ${source}`);
}

function readRegularFilePathNoFollow(filePath: string, maxBytes: number, tooLargeMessage: string): Buffer {
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const nonBlocking = (fs.constants as typeof fs.constants & { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`public benchmark source is not a regular file: ${filePath}`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) throw new Error(tooLargeMessage);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - totalBytes));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) return Buffer.concat(chunks, totalBytes);
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    throw new Error(tooLargeMessage);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function parsePublicBenchmarkBundle(
  value: unknown,
  forbiddenSecretValues: readonly string[] = []
): PublicBenchmarkBundle {
  const parsed = bundleSchema.parse(value);
  const exactSecrets = [...new Set(forbiddenSecretValues)].filter((secret) => secret.length > 0);
  const paths = new Set<string>();
  const contentsByPath = new Map<string, Buffer>();
  let decodedBytes = 0;
  for (const file of parsed.files) {
    if (paths.has(file.path)) throw new Error(`duplicate public benchmark bundle path: ${file.path}`);
    paths.add(file.path);
    if (!isAllowedBundlePath(file.path)) throw new Error(`public benchmark bundle path is not allowed: ${file.path}`);
    const contents = Buffer.from(file.contents_base64, "base64");
    if (contents.toString("base64") !== file.contents_base64) {
      throw new Error(`public benchmark bundle file is not canonical base64: ${file.path}`);
    }
    if (contents.byteLength !== file.size_bytes || digest(contents) !== file.sha256) {
      throw new Error(`public benchmark bundle integrity check failed: ${file.path}`);
    }
    assertPublicBenchmarkFileContainsNoSecrets(file.path, contents, exactSecrets);
    contentsByPath.set(file.path, contents);
    decodedBytes += contents.byteLength;
  }
  if (decodedBytes > MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES) {
    throw new Error("public benchmark bundle exceeds the size limit");
  }
  for (const required of [
    "eval/eval.json",
    "eval/matrix.json",
    "eval/runs.jsonl",
    "eval/run-summary.json",
    `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`,
    "eval/scores.jsonl",
    "eval/summary.json",
    "eval/summary.md"
  ]) {
    if (!paths.has(required)) throw new Error(`public benchmark bundle is missing ${required}`);
  }
  const matrixContents = contentsByPath.get("eval/matrix.json");
  if (matrixContents === undefined) throw new Error("public benchmark bundle is missing eval/matrix.json");
  const matrixRows = parseMatrixRows(matrixContents);
  const summaryContents = contentsByPath.get("eval/summary.json");
  if (summaryContents === undefined) throw new Error("public benchmark bundle is missing eval/summary.json");
  const summaryRows = parseSummaryRows(summaryContents);
  const diagnosticsPath = `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`;
  const diagnosticsContents = contentsByPath.get(diagnosticsPath);
  if (diagnosticsContents === undefined) throw new Error(`public benchmark bundle is missing ${diagnosticsPath}`);
  const diagnostics = parseBundleDiagnostics(diagnosticsContents);
  assertBundleDiagnosticsLineage(parsed, diagnostics);
  if (!diagnostics.summary.scoring_ready) {
    throw new Error("public benchmark bundle diagnostics are not ready for scoring");
  }
  if (diagnostics.rows.length !== matrixRows.size) {
    throw new Error("public benchmark bundle diagnostics row set does not match the matrix");
  }
  if (summaryRows.size !== matrixRows.size) {
    throw new Error("public benchmark bundle graded row set does not match the matrix");
  }
  for (const diagnostic of diagnostics.rows) {
    const matrixRow = matrixRows.get(diagnostic.row_id);
    if (
      matrixRow === undefined ||
      matrixRow.target_id !== diagnostic.target_id ||
      matrixRow.variant_id !== diagnostic.variant_id ||
      matrixRow.trial_id !== diagnostic.trial_id
    ) {
      throw new Error(`public benchmark bundle diagnostics row does not match the matrix: ${diagnostic.row_id}`);
    }
  }
  for (const rowId of summaryRows) {
    if (!matrixRows.has(rowId)) {
      throw new Error(`public benchmark bundle graded row does not match the matrix: ${rowId}`);
    }
  }
  for (const bundlePath of paths) {
    if (!bundlePath.startsWith("reports/")) continue;
    const rowId = bundlePath.split("/")[1];
    if (rowId === undefined || !matrixRows.has(rowId)) {
      throw new Error(`public benchmark bundle contains a report for an unexpected matrix row: ${bundlePath}`);
    }
  }
  for (const rowId of matrixRows.keys()) {
    for (const reportFile of PUBLIC_REPORT_FILES) {
      const required = `reports/${rowId}/${reportFile}`;
      if (!paths.has(required)) throw new Error(`public benchmark bundle is missing ${required}`);
    }
  }
  assertPublicCloudEvidence(
    parsed.execution,
    matrixRows,
    contentsByPath,
    parsed.targets.map((target) => target.id)
  );
  assertSmokeFindingFloor(parsed.lane, matrixRows, contentsByPath);
  const publicationBundlePath = uniqueDeclaredPublicationBundlePath(parsed.targets);
  const expectedMetadata = summarizePublicBenchmarkBundleContents({
    matrixRows,
    diagnostics,
    summaryRows,
    publicationBundlePath
  });
  assertPublicBenchmarkBundleMetadata(parsed, expectedMetadata);
  return parsed;
}

function assertPublicCloudEvidence(
  execution: PublicBenchmarkBundle["execution"],
  matrixRows: Map<string, PublicBundleMatrixRow>,
  contentsByPath: Map<string, Buffer>,
  expectedTargetIds: string[]
): void {
  const cloudPaths = [...contentsByPath.keys()].filter((bundlePath) => bundlePath.startsWith("cloud/"));
  if (execution.mode === "local") {
    if (cloudPaths.length > 0) {
      throw new Error("local public benchmark bundle must not contain cloud evidence");
    }
    return;
  }
  if (cloudPaths.length !== matrixRows.size) {
    throw new Error("public benchmark bundle cloud evidence row set does not match the matrix");
  }
  if (
    execution.acceptance_e2e &&
    (matrixRows.size !== expectedTargetIds.length ||
      JSON.stringify([...new Set([...matrixRows.values()].map((row) => row.target_id))].sort()) !==
        JSON.stringify([...expectedTargetIds].sort()))
  ) {
    throw new Error("public benchmark bundle cloud acceptance target set is not the exact checked-in smoke cohort");
  }
  const allProviderIds = new Set<string>();
  const runIds = new Set<string>();
  for (const rowId of matrixRows.keys()) {
    const bundlePath = `cloud/${rowId}/evidence.json`;
    const contents = contentsByPath.get(bundlePath);
    if (contents === undefined) throw new Error(`public benchmark bundle is missing ${bundlePath}`);
    let evidence;
    try {
      evidence = publicCloudEvidenceSchema.parse(JSON.parse(contents.toString("utf8")) as unknown);
    } catch (error) {
      const details =
        error instanceof z.ZodError
          ? [...new Set(error.issues.map((issue) => issue.message))].join("; ")
          : "invalid JSON";
      throw new Error(`public benchmark bundle cloud evidence is invalid: ${rowId}: ${details}`, { cause: error });
    }
    if (evidence.row_id !== rowId || runIds.has(evidence.run_id)) {
      throw new Error(`public benchmark bundle cloud evidence identity is invalid: ${rowId}`);
    }
    if (evidence.acceptance_e2e !== execution.acceptance_e2e) {
      throw new Error(`public benchmark bundle cloud acceptance mode is inconsistent: ${rowId}`);
    }
    runIds.add(evidence.run_id);
    for (const attempt of evidence.attempts) {
      for (const providerId of attempt.provider_execution_ids) {
        if (allProviderIds.has(providerId)) {
          throw new Error("public benchmark bundle reuses a Modal sandbox across matrix rows");
        }
        allProviderIds.add(providerId);
      }
    }
  }
}

function assertSmokeFindingFloor(
  lane: PublicBenchmarkBundle["lane"],
  matrixRows: Map<string, PublicBundleMatrixRow>,
  contentsByPath: Map<string, Buffer>
): void {
  if (lane !== "smoke") return;
  for (const rowId of matrixRows.keys()) {
    const bundlePath = `reports/${rowId}/findings.normalized.json`;
    const contents = contentsByPath.get(bundlePath);
    let findings;
    try {
      findings = assertFindingsSchema(
        contents === undefined ? undefined : (JSON.parse(contents.toString("utf8")) as unknown)
      );
    } catch (error) {
      throw new Error(`smoke benchmark row ${rowId} has invalid normalized findings`, { cause: error });
    }
    if (findings.length === 0) {
      throw new Error(`smoke benchmark row ${rowId} must report at least one normalized finding`);
    }
  }
}

interface PublicBundleMatrixRow {
  id: string;
  target_id: string;
  variant_id: string;
  trial_id: string;
  target: {
    id: string;
    repo: string;
    ref: string;
  };
  framework?: string;
}

function parseMatrixRows(contents: Buffer): Map<string, PublicBundleMatrixRow> {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("public benchmark bundle eval/matrix.json is not valid JSON", { cause: error });
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("public benchmark bundle eval/matrix.json must be a non-empty array");
  }
  const rows = new Map<string, PublicBundleMatrixRow>();
  for (const [index, row] of value.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`public benchmark bundle matrix row ${index} must be an object`);
    }
    const input = row as Record<string, unknown>;
    const id = safeId.safeParse(input.id);
    if (!id.success) throw new Error(`public benchmark bundle matrix row ${index} has an invalid ID`);
    const targetId = safeId.safeParse(input.target_id);
    const variantId = safeId.safeParse(input.variant_id);
    const trialId = safeId.safeParse(input.trial_id);
    if (!targetId.success || !variantId.success || !trialId.success) {
      throw new Error(`public benchmark bundle matrix row ${index} has an invalid identity`);
    }
    const target = parseMatrixTargetIdentity(input.target, targetId.data, index);
    const framework = parseMatrixTargetFramework(input, targetId.data, index);
    if (rows.has(id.data)) throw new Error(`public benchmark bundle matrix repeats row ID ${id.data}`);
    rows.set(id.data, {
      id: id.data,
      target_id: targetId.data,
      variant_id: variantId.data,
      trial_id: trialId.data,
      target,
      ...(framework === undefined ? {} : { framework })
    });
  }
  return rows;
}

function parseMatrixTargetIdentity(value: unknown, targetId: string, index: number): PublicBundleMatrixRow["target"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`public benchmark bundle matrix row ${index} is missing target identity`);
  }
  const target = value as Record<string, unknown>;
  const id = safeId.safeParse(target.id);
  const repo = z.string().url().max(2_048).safeParse(target.repo);
  const ref = fullSha.safeParse(target.ref);
  if (!id.success || !repo.success || !ref.success || id.data !== targetId) {
    throw new Error(`public benchmark bundle matrix row ${index} has an invalid target identity`);
  }
  return { id: id.data, repo: repo.data, ref: ref.data };
}

function parseMatrixTargetFramework(row: Record<string, unknown>, targetId: string, index: number): string | undefined {
  const workflowInput = recordValue(row.workflow_input);
  const frameworks = recordValue(workflowInput?.target_frameworks);
  if (frameworks === undefined || !(targetId in frameworks)) return undefined;
  const framework = safeId.safeParse(frameworks[targetId]);
  if (!framework.success) {
    throw new Error(`public benchmark bundle matrix row ${index} has an invalid target framework`);
  }
  return framework.data;
}

function parseSummaryRows(contents: Buffer): Set<string> {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("public benchmark bundle eval/summary.json is not valid JSON", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("public benchmark bundle eval/summary.json must be an object");
  }
  const rowsValue = (value as Record<string, unknown>).rows;
  if (!Array.isArray(rowsValue) || rowsValue.length === 0) {
    throw new Error("public benchmark bundle eval/summary.json rows must be a non-empty array");
  }
  const rows = new Set<string>();
  for (const [index, row] of rowsValue.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`public benchmark bundle summary row ${index} must be an object`);
    }
    const rowId = safeId.safeParse((row as Record<string, unknown>).row_id);
    if (!rowId.success) throw new Error(`public benchmark bundle summary row ${index} has an invalid row ID`);
    if (rows.has(rowId.data)) throw new Error(`public benchmark bundle summary repeats row ID ${rowId.data}`);
    rows.add(rowId.data);
  }
  return rows;
}

function summarizePublicBenchmarkBundleFiles(
  files: readonly PublicBenchmarkBundleFile[],
  publicationBundlePath: string
): PublicBenchmarkBundleMetadata {
  const contentsByPath = new Map<string, Buffer>();
  for (const file of files) contentsByPath.set(file.path, Buffer.from(file.contents_base64, "base64"));
  const matrixContents = contentsByPath.get("eval/matrix.json");
  if (matrixContents === undefined) throw new Error("public benchmark bundle is missing eval/matrix.json");
  const summaryContents = contentsByPath.get("eval/summary.json");
  if (summaryContents === undefined) throw new Error("public benchmark bundle is missing eval/summary.json");
  const diagnosticsContents = contentsByPath.get(`eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`);
  if (diagnosticsContents === undefined) {
    throw new Error(`public benchmark bundle is missing eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`);
  }
  return summarizePublicBenchmarkBundleContents({
    matrixRows: parseMatrixRows(matrixContents),
    diagnostics: parseBundleDiagnostics(diagnosticsContents),
    summaryRows: parseSummaryRows(summaryContents),
    publicationBundlePath
  });
}

function summarizePublicBenchmarkBundleContents(input: {
  matrixRows: Map<string, PublicBundleMatrixRow>;
  diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>;
  summaryRows: Set<string>;
  publicationBundlePath: string;
}): PublicBenchmarkBundleMetadata {
  const diagnosticsByRow = new Map(input.diagnostics.rows.map((row) => [row.row_id, row]));
  const rowsByTarget = new Map<string, PublicBundleMatrixRow[]>();
  for (const row of input.matrixRows.values()) {
    rowsByTarget.set(row.target_id, [...(rowsByTarget.get(row.target_id) ?? []), row]);
  }

  const targets = [...rowsByTarget.values()]
    .map((rows): PublicBenchmarkBundleTarget => {
      const first = rows[0]!;
      const target = first.target;
      const frameworks = new Set(rows.flatMap((row) => (row.framework === undefined ? [] : [row.framework])));
      if (frameworks.size > 1) {
        throw new Error(`public benchmark bundle target ${first.target_id} has inconsistent framework identity`);
      }
      for (const row of rows) {
        if (row.target.id !== target.id || row.target.repo !== target.repo || row.target.ref !== target.ref) {
          throw new Error(`public benchmark bundle target ${first.target_id} has inconsistent target identity`);
        }
      }
      const diagnostics = rows.map((row) => diagnosticsByRow.get(row.id)).filter((row) => row !== undefined);
      const executedCaseCount = diagnostics.filter(
        (row) => row?.run_status === "launched" && row.workflow_terminal && row.terminal_report_present
      ).length;
      const gradedCaseCount = rows.filter((row) => input.summaryRows.has(row.id)).length;
      const status = diagnostics.every(
        (row) => row?.final_status === "succeeded" && row.workflow_status === "succeeded"
      )
        ? "succeeded"
        : "genuine-task-failures";
      const reportPaths = rows.flatMap((row) =>
        PUBLIC_REPORT_FILES.map((reportFile) => `reports/${row.id}/${reportFile}`)
      );
      return {
        id: target.id,
        repository: target.repo,
        revision: target.ref,
        ...(frameworks.size === 0 ? {} : { framework: [...frameworks][0]! }),
        status,
        executed_case_count: executedCaseCount,
        graded_case_count: gradedCaseCount,
        publication_location: {
          bundle_path: input.publicationBundlePath,
          report_paths: reportPaths
        }
      };
    })
    .sort((left, right) => compareText(left.id, right.id));

  const executedCaseCount = targets.reduce((sum, target) => sum + target.executed_case_count, 0);
  const gradedCaseCount = targets.reduce((sum, target) => sum + target.graded_case_count, 0);
  return {
    status: targets.every((target) => target.status === "succeeded") ? "succeeded" : "genuine-task-failures",
    executed_case_count: executedCaseCount,
    graded_case_count: gradedCaseCount,
    targets
  };
}

function uniqueDeclaredPublicationBundlePath(targets: readonly PublicBenchmarkBundleTarget[]): string {
  const bundlePaths = new Set(targets.map((target) => target.publication_location.bundle_path));
  if (bundlePaths.size !== 1) throw new Error("public benchmark bundle target publication paths are inconsistent");
  return [...bundlePaths][0]!;
}

function assertPublicBenchmarkBundleMetadata(
  bundle: PublicBenchmarkBundle,
  expected: PublicBenchmarkBundleMetadata
): void {
  if (bundle.executed_case_count === 0) {
    throw new Error("public benchmark bundle executed case count must be positive");
  }
  if (bundle.graded_case_count === 0) {
    throw new Error("public benchmark bundle graded case count must be positive");
  }
  for (const target of bundle.targets) {
    if (target.executed_case_count === 0) {
      throw new Error(`public benchmark bundle target ${target.id} executed case count must be positive`);
    }
    if (target.graded_case_count === 0) {
      throw new Error(`public benchmark bundle target ${target.id} graded case count must be positive`);
    }
  }
  const actualMetadata: PublicBenchmarkBundleMetadata = {
    status: bundle.status,
    executed_case_count: bundle.executed_case_count,
    graded_case_count: bundle.graded_case_count,
    targets: bundle.targets
  };
  if (JSON.stringify(actualMetadata) !== JSON.stringify(expected)) {
    throw new Error("public benchmark bundle result metadata does not match its scored files");
  }
}

function parseBundleDiagnostics(contents: Buffer): ReturnType<typeof parsePublicEvalDiagnostics> {
  if (contents.byteLength > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES) {
    throw new Error("public benchmark bundle diagnostics exceed the size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("public benchmark bundle diagnostics are not valid JSON", { cause: error });
  }
  try {
    return parsePublicEvalDiagnostics(value);
  } catch (error) {
    throw new Error("public benchmark bundle diagnostics are invalid", { cause: error });
  }
}

function assertBundleDiagnosticsLineage(
  bundle: PublicBenchmarkBundle,
  diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>
): void {
  const mismatches = [
    diagnostics.benchmark === bundle.benchmark ? undefined : "benchmark",
    diagnostics.lane === bundle.lane ? undefined : "lane",
    diagnostics.model_slug === bundle.model_slug ? undefined : "model slug",
    diagnostics.model === bundle.model ? undefined : "model",
    diagnostics.reasoning === bundle.reasoning ? undefined : "reasoning",
    diagnostics.candidate_commit === bundle.candidate_commit ? undefined : "candidate commit",
    diagnostics.eval_run_id === bundle.eval_run_id ? undefined : "eval run",
    diagnostics.lineage.logical_run_id === bundle.lineage.logical_run_id ? undefined : "logical run lineage",
    diagnostics.lineage.generation === bundle.lineage.generation ? undefined : "generation lineage",
    diagnostics.lineage.attempt === bundle.lineage.attempt ? undefined : "attempt lineage",
    diagnostics.lineage.attempt_id === bundle.lineage.attempt_id ? undefined : "attempt ID lineage",
    diagnostics.lineage.config_fingerprint === bundle.lineage.config_fingerprint ? undefined : "configuration lineage",
    diagnostics.lineage.source_fingerprint === bundle.lineage.source_fingerprint ? undefined : "source lineage",
    diagnostics.lineage.image_fingerprint === bundle.lineage.image_fingerprint ? undefined : "image lineage",
    diagnostics.lineage.model_fingerprint === bundle.lineage.model_fingerprint ? undefined : "model lineage"
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`public benchmark bundle diagnostics do not match ${mismatches.join(", ")}`);
  }
}

export function readPublicBenchmarkBundle(
  filePath: string,
  forbiddenSecretValues: readonly string[] = []
): PublicBenchmarkBundle {
  const contents = readRegularFilePathNoFollow(
    filePath,
    MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES,
    "public benchmark bundle exceeds the size limit"
  );
  return parsePublicBenchmarkBundle(JSON.parse(contents.toString("utf8")) as unknown, forbiddenSecretValues);
}

export function extractPublicBenchmarkBundle(bundle: PublicBenchmarkBundle, outputDirectory: string): void {
  const parsed = parsePublicBenchmarkBundle(bundle);
  const output = normalizedBundleOutputDirectory(outputDirectory);
  const staging = fs.mkdtempSync(path.join(path.dirname(output), `.${path.basename(output)}.staging-`));
  fs.chmodSync(staging, 0o700);
  try {
    for (const file of parsed.files) {
      writeStagedBundleFile(staging, file.path, Buffer.from(file.contents_base64, "base64"));
    }
    assertStrictExtractedTree(
      staging,
      parsed.files.map((file) => file.path)
    );
    fs.chmodSync(staging, 0o755);
    replaceExtractedDirectory(staging, output);
  } catch (error) {
    if (fs.lstatSync(staging, { throwIfNoEntry: false }) !== undefined) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
}

function normalizedBundleOutputDirectory(candidate: string): string {
  const requested = path.resolve(candidate);
  if (path.dirname(requested) === requested) {
    throw new Error("public benchmark bundle output cannot be a filesystem root");
  }
  const parent = path.dirname(requested);
  const root = path.parse(parent).root;
  let current = root;
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("public benchmark bundle output parent root must be a regular directory");
  }
  const relativeParent = path.relative(root, parent);
  for (const component of relativeParent.split(path.sep).filter((part) => part.length > 0)) {
    current = path.join(current, component);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      try {
        fs.mkdirSync(current, { mode: 0o755 });
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`public benchmark bundle output parent contains a non-directory or symbolic link: ${current}`);
    }
  }
  return path.join(parent, path.basename(requested));
}

function writeStagedBundleFile(root: string, relativeFilePath: string, contents: Buffer): void {
  const parts = relativeFilePath.split("/");
  const fileName = parts.pop();
  if (fileName === undefined) throw new Error("public benchmark bundle file path is empty");

  let directory = root;
  for (const part of parts) {
    directory = path.join(directory, part);
    try {
      fs.mkdirSync(directory, { mode: 0o755 });
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`public benchmark bundle output contains a non-directory component: ${relativeFilePath}`);
    }
  }

  const destination = path.join(directory, fileName);
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
    0o644
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`public benchmark bundle output is not a regular file: ${relativeFilePath}`);
    }
    fs.writeFileSync(descriptor, contents);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertStrictExtractedTree(root: string, expectedFiles: readonly string[]): void {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("public benchmark bundle extraction root must be a regular directory");
  }

  const expectedFileSet = new Set(expectedFiles);
  const expectedDirectories = new Set<string>();
  for (const expectedFile of expectedFiles) {
    let directory = path.posix.dirname(expectedFile);
    while (directory !== ".") {
      expectedDirectories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }

  const actualFiles = new Set<string>();
  function walk(directory: string, relativeDirectory: string): void {
    for (const entryName of fs.readdirSync(directory)) {
      const relativeEntry = relativeDirectory.length === 0 ? entryName : `${relativeDirectory}/${entryName}`;
      const entryPath = path.join(directory, entryName);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`public benchmark bundle extraction contains a symbolic link: ${relativeEntry}`);
      }
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relativeEntry)) {
          throw new Error(`public benchmark bundle extraction contains an unexpected directory: ${relativeEntry}`);
        }
        walk(entryPath, relativeEntry);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`public benchmark bundle extraction contains a non-regular entry: ${relativeEntry}`);
      }
      actualFiles.add(relativeEntry);
    }
  }
  walk(root, "");

  if (
    actualFiles.size !== expectedFileSet.size ||
    [...actualFiles].some((relativeFilePath) => !expectedFileSet.has(relativeFilePath))
  ) {
    throw new Error("public benchmark bundle extraction does not match the strict file tree");
  }
}

function assertReplaceableOutputTree(output: string): boolean {
  const rootStat = fs.lstatSync(output, { throwIfNoEntry: false });
  if (rootStat === undefined) return false;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("public benchmark bundle output must be a regular directory");
  }

  function walk(directory: string): void {
    for (const entryName of fs.readdirSync(directory)) {
      const entryPath = path.join(directory, entryName);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`public benchmark bundle output contains a symbolic link: ${entryPath}`);
      }
      if (stat.isDirectory()) {
        walk(entryPath);
      } else if (!stat.isFile()) {
        throw new Error(`public benchmark bundle output contains a non-regular entry: ${entryPath}`);
      }
    }
  }
  walk(output);
  return true;
}

function replaceExtractedDirectory(staging: string, output: string): void {
  const hadPrevious = assertReplaceableOutputTree(output);
  if (!hadPrevious) {
    fs.renameSync(staging, output);
    return;
  }

  const backup = path.join(
    path.dirname(output),
    `.${path.basename(output)}.backup-${process.pid}-${crypto.randomBytes(12).toString("hex")}`
  );
  fs.renameSync(output, backup);
  try {
    // Validate the exact object moved aside as well as the path inspected above.
    // This closes the ordinary check/rename race without ever traversing a link.
    assertReplaceableOutputTree(backup);
    fs.renameSync(staging, output);
  } catch (error) {
    if (fs.lstatSync(output, { throwIfNoEntry: false }) === undefined) {
      fs.renameSync(backup, output);
    }
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isAllowedBundlePath(value: string): boolean {
  const evalFiles = new Set([
    "eval/eval.json",
    "eval/matrix.json",
    "eval/runs.jsonl",
    "eval/run-summary.json",
    `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`,
    "eval/scores.jsonl",
    "eval/summary.json",
    "eval/summary.md",
    "eval/review/new-findings.jsonl"
  ]);
  if (evalFiles.has(value)) return true;
  if (/^cloud\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/evidence\.json$/u.test(value)) return true;
  return /^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:report\.md|report\.json|findings\.normalized\.json)$/u.test(
    value
  );
}

function digest(contents: Uint8Array): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
