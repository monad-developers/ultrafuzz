import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sha256File } from "@ultrafuzz/artifacts";
import type { ResolvedConfig } from "@ultrafuzz/config";
import { normalizeRelativePath, validateSafeRelativePath } from "@ultrafuzz/security";

import type { PlannedGraph } from "./types.js";
import { retryFallbackProfileIds } from "./retry-chain.js";
import { sha256Stable } from "./utils.js";

export const DATA_GOVERNANCE_POLICY_ENV = "ULTRAFUZZ_DATA_GOVERNANCE_POLICY" as const;
export const DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV = "ULTRAFUZZ_DATA_DISCLOSURE_ACKNOWLEDGEMENTS" as const;
export const DATA_GOVERNANCE_POLICY_SCHEMA_VERSION = "ultrafuzz.data-governance-policy.v1" as const;
export const DATA_GOVERNANCE_PROVENANCE_SCHEMA_VERSION = "ultrafuzz.data-governance-provenance.v1" as const;
export const DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION = "ultrafuzz.data-disclosure-acknowledgement.v1" as const;

const MAX_ENV_JSON_BYTES = 256 * 1024;
const DESTINATION_PATTERN = /^(?:model|cloud|artifact):[a-z0-9][a-z0-9._-]{0,127}$/u;
const AGENT_REF_PATTERN = /^(?!.*\.\.)[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u;
const OPENROUTER_MODEL_ID_PATTERN = /^[^\s\p{Cc}]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVIEW_SIGNOFF_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HOSTED_BUILTIN_MODEL_AGENTS = new Set([
  "CodexAgent",
  "ClaudeAgent",
  "KimiAgent",
  "DeepSeekAgent",
  "OpenRouterAgent"
]);

export interface DataDestinationPolicy {
  destination: string;
  processor: string;
  region: string;
  retention_policy: string;
  training_policy: string;
  dpa_status: string;
  minimization_policy: string;
  data_handling_basis: string;
}

export interface DataGovernancePolicy {
  schema_version: typeof DATA_GOVERNANCE_POLICY_SCHEMA_VERSION;
  sensitivity: "public" | "private";
  source_destinations: string[];
  artifact_destinations: string[];
  destination_policies: DataDestinationPolicy[];
  local_model_agents: string[];
  openrouter_model_allowlist: string[];
  production_source_roots: string[];
  review_signoff_keys: DataGovernanceReviewSignoffKey[];
}

export interface DataGovernanceReviewSignoffKey {
  key_id: string;
  algorithm: "ed25519";
  public_key_spki_base64: string;
}

export interface DataGovernanceReviewSignoffAuthority extends DataGovernanceReviewSignoffKey {
  public_key_sha256: string;
}

export interface DataDisclosureAcknowledgement {
  schema_version: typeof DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION;
  destination: string;
  policy_digest: string;
  input_digest: string;
  acknowledged_by: string;
  acknowledged_at: string;
}

export interface DataGovernanceProvenance {
  schema_version: typeof DATA_GOVERNANCE_PROVENANCE_SCHEMA_VERSION;
  policy: DataGovernancePolicy;
  policy_digest: string;
  input_digest: string;
  target: {
    commit: string | null;
    tree: string | null;
    dirty: boolean;
    worktree_digest: string | null;
  };
  required_source_destinations: string[];
  required_artifact_destinations: string[];
  acknowledgements: DataDisclosureAcknowledgement[];
  acknowledgement_status: "approved" | "not-required" | "pending";
}

export interface PrepareDataGovernanceInput {
  projectRoot: string;
  config: ResolvedConfig;
  graph: PlannedGraph;
  graphFingerprint: string;
  configFingerprint: string;
  promptDigest: string;
  sourceRunId?: string;
  referenceExpectationsDigest?: string;
  operatorPrompt?: string;
  workflowInput?: unknown;
  env?: Record<string, string | undefined>;
}

export interface DataGovernanceDiagnostic {
  code: string;
  message: string;
  severity: "error";
  source: "governance";
  path: string;
  details?: Record<string, unknown>;
}

export function prepareDataGovernance(input: PrepareDataGovernanceInput): {
  provenance: DataGovernanceProvenance;
  diagnostics: DataGovernanceDiagnostic[];
} {
  const env = input.env ?? process.env;
  const policy = parseDataGovernancePolicy(env[DATA_GOVERNANCE_POLICY_ENV]);
  const policyDigest = sha256Stable(policy);
  const target = captureDataGovernanceTargetIdentity(input.projectRoot);
  const required = requiredDestinations(input.config, input.graph, policy);
  const inputDigest = sha256Stable({
    schema_version: DATA_GOVERNANCE_PROVENANCE_SCHEMA_VERSION,
    graph_fingerprint: input.graphFingerprint,
    config_fingerprint: input.configFingerprint,
    prompt_digest: input.promptDigest,
    source_run_id: input.sourceRunId ?? null,
    reference_expectations_digest: input.referenceExpectationsDigest ?? null,
    operator_prompt_digest: sha256Stable(input.operatorPrompt ?? null),
    workflow_input_digest: sha256Stable(input.workflowInput ?? null),
    target
  });
  const parsedAcknowledgements = parseAcknowledgements(env[DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV]);
  const requiredAcknowledgementDestinations = policy.sensitivity === "private" ? [...required.external].sort() : [];
  const acknowledgements = requiredAcknowledgementDestinations.flatMap((destination) => {
    const acknowledgement = parsedAcknowledgements.find((entry) => entry.destination === destination);
    return acknowledgement !== undefined &&
      acknowledgement.policy_digest === policyDigest &&
      acknowledgement.input_digest === inputDigest
      ? [acknowledgement]
      : [];
  });
  const diagnostics = governanceDiagnostics({
    policy,
    policyDigest,
    inputDigest,
    requiredSource: required.source,
    requiredArtifact: required.artifact,
    requiredAcknowledgementDestinations,
    acknowledgements,
    parsedAcknowledgements,
    openRouterModels: required.openRouterModels,
    configuredProductionSourceRoots: normalizedConfiguredProductionSourceRoots(input.config),
    target
  });
  return {
    provenance: {
      schema_version: DATA_GOVERNANCE_PROVENANCE_SCHEMA_VERSION,
      policy,
      policy_digest: policyDigest,
      input_digest: inputDigest,
      target,
      required_source_destinations: required.source,
      required_artifact_destinations: required.artifact,
      acknowledgements,
      acknowledgement_status:
        requiredAcknowledgementDestinations.length === 0
          ? "not-required"
          : acknowledgements.length === requiredAcknowledgementDestinations.length
            ? "approved"
            : "pending"
    },
    diagnostics
  };
}

export function parseDataGovernancePolicy(value: string | undefined): DataGovernancePolicy {
  if (value === undefined || value.trim().length === 0) {
    return {
      schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
      sensitivity: "private",
      source_destinations: [],
      artifact_destinations: [],
      destination_policies: [],
      local_model_agents: [],
      openrouter_model_allowlist: [],
      production_source_roots: [],
      review_signoff_keys: []
    };
  }
  const parsed = parseBoundedJson(value, DATA_GOVERNANCE_POLICY_ENV);
  assertExactKeys(
    parsed,
    [
      "schema_version",
      "sensitivity",
      "source_destinations",
      "artifact_destinations",
      "destination_policies",
      "local_model_agents",
      "openrouter_model_allowlist",
      "production_source_roots",
      "review_signoff_keys"
    ],
    DATA_GOVERNANCE_POLICY_ENV
  );
  if (parsed.schema_version !== DATA_GOVERNANCE_POLICY_SCHEMA_VERSION) {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.schema_version must be ${DATA_GOVERNANCE_POLICY_SCHEMA_VERSION}`);
  }
  if (parsed.sensitivity !== "public" && parsed.sensitivity !== "private") {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.sensitivity must be public or private`);
  }
  const sourceDestinations = destinationList(parsed.source_destinations, "source_destinations");
  const artifactDestinations = destinationList(parsed.artifact_destinations, "artifact_destinations");
  const destinationPolicies = destinationPolicyList(parsed.destination_policies);
  const declaredDestinations = [...new Set([...sourceDestinations, ...artifactDestinations])].sort();
  const policyDestinations = destinationPolicies.map((entry) => entry.destination);
  if (!arraysEqual(declaredDestinations, policyDestinations)) {
    throw new Error(
      `${DATA_GOVERNANCE_POLICY_ENV}.destination_policies must name every declared source/artifact destination exactly once`
    );
  }
  return {
    schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
    sensitivity: parsed.sensitivity,
    source_destinations: sourceDestinations,
    artifact_destinations: artifactDestinations,
    destination_policies: destinationPolicies,
    local_model_agents: agentRefList(parsed.local_model_agents, "local_model_agents"),
    openrouter_model_allowlist: openRouterModelList(parsed.openrouter_model_allowlist),
    production_source_roots: productionSourceRootList(parsed.production_source_roots),
    review_signoff_keys: reviewSignoffKeyList(parsed.review_signoff_keys)
  };
}

export function dataGovernanceReviewSignoffAuthorities(
  policy: DataGovernancePolicy
): DataGovernanceReviewSignoffAuthority[] {
  return policy.review_signoff_keys.map((entry) => ({
    ...entry,
    public_key_sha256: hashBytes(Buffer.from(entry.public_key_spki_base64, "base64"))
  }));
}

export function parseAcknowledgements(value: string | undefined): DataDisclosureAcknowledgement[] {
  if (value === undefined || value.trim().length === 0) return [];
  const parsed = parseBoundedJsonValue(value, DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV);
  if (!Array.isArray(parsed) || parsed.length > 128) {
    throw new Error(`${DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV} must be a JSON array with at most 128 entries`);
  }
  const destinations = new Set<string>();
  return parsed.map((candidate, index) => {
    const label = `${DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV}[${index}]`;
    const record = asRecord(candidate, label);
    assertExactKeys(
      record,
      ["schema_version", "destination", "policy_digest", "input_digest", "acknowledged_by", "acknowledged_at"],
      label
    );
    if (record.schema_version !== DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION) {
      throw new Error(`${label}.schema_version must be ${DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION}`);
    }
    const destination = destinationValue(record.destination, `${label}.destination`);
    if (destinations.has(destination)) throw new Error(`${label}.destination duplicates ${destination}`);
    destinations.add(destination);
    const policyDigest = digestValue(record.policy_digest, `${label}.policy_digest`);
    const inputDigest = digestValue(record.input_digest, `${label}.input_digest`);
    const acknowledgedBy = boundedNonEmptyString(record.acknowledged_by, `${label}.acknowledged_by`);
    const acknowledgedAt = boundedNonEmptyString(record.acknowledged_at, `${label}.acknowledged_at`);
    if (!isCanonicalUtcTimestamp(acknowledgedAt)) {
      throw new Error(`${label}.acknowledged_at must be a canonical UTC timestamp`);
    }
    return {
      schema_version: DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION,
      destination,
      policy_digest: policyDigest,
      input_digest: inputDigest,
      acknowledged_by: acknowledgedBy,
      acknowledged_at: acknowledgedAt
    };
  });
}

function governanceDiagnostics(input: {
  policy: DataGovernancePolicy;
  policyDigest: string;
  inputDigest: string;
  requiredSource: string[];
  requiredArtifact: string[];
  requiredAcknowledgementDestinations: string[];
  acknowledgements: DataDisclosureAcknowledgement[];
  parsedAcknowledgements: DataDisclosureAcknowledgement[];
  openRouterModels: string[];
  configuredProductionSourceRoots: string[];
  target: DataGovernanceProvenance["target"];
}): DataGovernanceDiagnostic[] {
  const diagnostics: DataGovernanceDiagnostic[] = [];
  if (
    input.policy.sensitivity === "private" &&
    (input.target.commit === null || input.target.tree === null || input.target.worktree_digest === null)
  ) {
    diagnostics.push({
      code: "DATA_GOVERNANCE_PRIVATE_TARGET_UNBOUND",
      message: "private campaign disclosure requires a Git target whose exact commit, tree, and worktree are bound",
      severity: "error",
      source: "governance",
      path: DATA_GOVERNANCE_POLICY_ENV,
      details: {
        policy_digest: input.policyDigest,
        input_digest: input.inputDigest
      }
    });
  }
  const missingSource = input.requiredSource.filter(
    (destination) => !input.policy.source_destinations.includes(destination)
  );
  const missingArtifact = input.requiredArtifact.filter(
    (destination) => !input.policy.artifact_destinations.includes(destination)
  );
  if (missingSource.length > 0 || missingArtifact.length > 0) {
    diagnostics.push({
      code: "DATA_GOVERNANCE_DESTINATION_NOT_ALLOWED",
      message:
        `campaign data policy does not allow every effective destination; update ${DATA_GOVERNANCE_POLICY_ENV} ` +
        `outside the repository before launch`,
      severity: "error",
      source: "governance",
      path: DATA_GOVERNANCE_POLICY_ENV,
      details: {
        missing_source_destinations: missingSource,
        missing_artifact_destinations: missingArtifact,
        policy_digest: input.policyDigest,
        input_digest: input.inputDigest
      }
    });
  }
  const unapprovedOpenRouterModels = input.openRouterModels.filter(
    (model) => !input.policy.openrouter_model_allowlist.includes(model)
  );
  if (unapprovedOpenRouterModels.length > 0) {
    diagnostics.push({
      code: "DATA_GOVERNANCE_OPENROUTER_MODEL_NOT_ALLOWED",
      message:
        `effective OpenRouter models are not present in the operator-owned ` +
        `${DATA_GOVERNANCE_POLICY_ENV}.openrouter_model_allowlist`,
      severity: "error",
      source: "governance",
      path: DATA_GOVERNANCE_POLICY_ENV,
      details: {
        models: unapprovedOpenRouterModels,
        policy_digest: input.policyDigest,
        input_digest: input.inputDigest
      }
    });
  }
  if (!arraysEqual(input.policy.production_source_roots, input.configuredProductionSourceRoots)) {
    diagnostics.push({
      code: "DATA_GOVERNANCE_PRODUCTION_SOURCE_ROOTS_MISMATCH",
      message:
        `operator-owned ${DATA_GOVERNANCE_POLICY_ENV}.production_source_roots must exactly match the resolved ` +
        "production source roots before launch",
      severity: "error",
      source: "governance",
      path: DATA_GOVERNANCE_POLICY_ENV,
      details: {
        policy_roots: input.policy.production_source_roots,
        configured_roots: input.configuredProductionSourceRoots,
        policy_digest: input.policyDigest,
        input_digest: input.inputDigest
      }
    });
  }
  const approved = new Set(input.acknowledgements.map((entry) => entry.destination));
  const stale = input.parsedAcknowledgements
    .filter((entry) => input.requiredAcknowledgementDestinations.includes(entry.destination))
    .filter((entry) => entry.policy_digest !== input.policyDigest || entry.input_digest !== input.inputDigest)
    .map((entry) => entry.destination);
  const missingAcknowledgements = input.requiredAcknowledgementDestinations.filter(
    (destination) => !approved.has(destination)
  );
  if (missingAcknowledgements.length > 0) {
    diagnostics.push({
      code: "DATA_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED",
      message:
        `private campaign disclosure requires operator-owned acknowledgements in ` +
        `${DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV}; bind each listed destination to the exact policy and input digests`,
      severity: "error",
      source: "governance",
      path: DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV,
      details: {
        destinations: missingAcknowledgements,
        stale_destinations: [...new Set(stale)].sort(),
        policy_digest: input.policyDigest,
        input_digest: input.inputDigest,
        acknowledgement_schema_version: DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION
      }
    });
  }
  return diagnostics;
}

function requiredDestinations(
  config: ResolvedConfig,
  graph: PlannedGraph,
  policy: DataGovernancePolicy
): { source: string[]; artifact: string[]; external: Set<string>; openRouterModels: string[] } {
  const source = new Set<string>();
  const artifact = new Set<string>();
  const external = new Set<string>();
  const openRouterModels = new Set<string>();
  const destinationAgents = new Map<string, string>();
  const addModelDestination = (agentRef: string, modelName?: string): void => {
    const destination = modelDestination(agentRef, policy.local_model_agents);
    const existingAgentRef = destinationAgents.get(destination);
    if (existingAgentRef !== undefined && existingAgentRef !== agentRef) {
      throw new Error(
        `distinct model agents ${existingAgentRef} and ${agentRef} normalize to the same data destination ${destination}`
      );
    }
    destinationAgents.set(destination, agentRef);
    source.add(destination);
    if (!policy.local_model_agents.includes(agentRef)) external.add(destination);
    if (agentRef === "OpenRouterAgent" && modelName !== undefined) openRouterModels.add(modelName);
  };
  for (const node of graph.nodes) {
    for (const model of node.model_fanout) {
      addModelDestination(model.agent_ref, model.model_name);
      for (const fallbackId of retryFallbackProfileIds(config, model.model_profile_id)) {
        const fallback = config.models.profiles[fallbackId];
        if (fallback === undefined) {
          throw new Error(`cannot derive data governance for missing fallback model profile ${fallbackId}`);
        }
        addModelDestination(fallback.agent, fallback.model);
      }
    }
  }
  if (config.execution.mode === "cloud" && config.execution.provider === "modal") {
    source.add("cloud:modal");
    artifact.add("cloud:modal");
    external.add("cloud:modal");
  }
  return {
    source: [...source].sort(),
    artifact: [...artifact].sort(),
    external,
    openRouterModels: [...openRouterModels].sort()
  };
}

function modelDestination(agentRef: string, localModelAgents: string[]): string {
  switch (agentRef) {
    case "CodexAgent":
      return "model:openai";
    case "ClaudeAgent":
      return "model:anthropic";
    case "KimiAgent":
      return "model:moonshot";
    case "DeepSeekAgent":
      return "model:deepseek";
    case "OpenRouterAgent":
      return "model:openrouter";
    default: {
      const normalized = normalizedAgentRef(agentRef);
      if (normalized.length === 0) throw new Error(`cannot derive a data destination for agent ${agentRef}`);
      return localModelAgents.includes(agentRef)
        ? `model:local-${normalized.slice(0, 122)}`
        : `model:custom-${normalized.slice(0, 121)}`;
    }
  }
}

function normalizedAgentRef(agentRef: string): string {
  return agentRef
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function captureDataGovernanceTargetIdentity(projectRoot: string): DataGovernanceProvenance["target"] {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024
    }).trim();
  let commit: string;
  let tree: string;
  try {
    commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).toLowerCase();
    tree = git(["rev-parse", "--verify", "HEAD^{tree}"]).toLowerCase();
    if (!/^[a-f0-9]{40,64}$/u.test(commit) || !/^[a-f0-9]{40,64}$/u.test(tree)) {
      throw new Error("target repository returned an invalid commit or tree identity");
    }
  } catch {
    // Non-Git targets remain supported, but the null identity makes the weaker
    // provenance explicit and still participates in the acknowledgement digest.
    return { commit: null, tree: null, dirty: true, worktree_digest: null };
  }
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
    cwd: projectRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  return {
    commit,
    tree,
    dirty: status.length > 0,
    worktree_digest: gitWorktreeDigest(projectRoot, tree, status)
  };
}

function gitWorktreeDigest(projectRoot: string, tree: string, status: Buffer): string {
  const diff = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], {
    cwd: projectRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
  const untrackedOutput = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: projectRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  const untracked = untrackedOutput
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0)
    .sort()
    .map((relativePath) => {
      const absolutePath = path.resolve(projectRoot, relativePath);
      const relative = path.relative(projectRoot, absolutePath);
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Git returned an untracked path outside the target repository");
      }
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        return { path: relativePath, kind: "symlink", sha256: hashBytes(Buffer.from(fs.readlinkSync(absolutePath))) };
      }
      if (!stat.isFile()) throw new Error(`untracked target path is not a regular file: ${relativePath}`);
      return { path: relativePath, kind: "file", sha256: sha256File(absolutePath) };
    });
  return sha256Stable({
    tree,
    status_sha256: hashBytes(status),
    tracked_diff_sha256: hashBytes(diff),
    untracked
  });
}

function hashBytes(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseBoundedJson(value: string, label: string): Record<string, unknown> {
  return asRecord(parseBoundedJsonValue(value, label), label);
}

function parseBoundedJsonValue(value: string, label: string): unknown {
  if (Buffer.byteLength(value, "utf8") > MAX_ENV_JSON_BYTES)
    throw new Error(`${label} exceeds ${MAX_ENV_JSON_BYTES} bytes`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function destinationList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.${field} must be an array with at most 128 entries`);
  }
  const normalized = value.map((entry, index) => destinationValue(entry, `${field}[${index}]`)).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.${field} must not contain duplicates`);
  }
  return normalized;
}

function destinationPolicyList(value: unknown): DataDestinationPolicy[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.destination_policies must be an array with at most 128 entries`);
  }
  const destinations = new Set<string>();
  return value
    .map((candidate, index): DataDestinationPolicy => {
      const label = `${DATA_GOVERNANCE_POLICY_ENV}.destination_policies[${index}]`;
      const record = asRecord(candidate, label);
      assertExactKeys(
        record,
        [
          "destination",
          "processor",
          "region",
          "retention_policy",
          "training_policy",
          "dpa_status",
          "minimization_policy",
          "data_handling_basis"
        ],
        label
      );
      const destination = destinationValue(record.destination, `${label}.destination`);
      if (destinations.has(destination)) throw new Error(`${label}.destination duplicates ${destination}`);
      destinations.add(destination);
      return {
        destination,
        processor: boundedNonEmptyString(record.processor, `${label}.processor`),
        region: boundedNonEmptyString(record.region, `${label}.region`),
        retention_policy: boundedNonEmptyString(record.retention_policy, `${label}.retention_policy`),
        training_policy: boundedNonEmptyString(record.training_policy, `${label}.training_policy`),
        dpa_status: boundedNonEmptyString(record.dpa_status, `${label}.dpa_status`),
        minimization_policy: boundedNonEmptyString(record.minimization_policy, `${label}.minimization_policy`),
        data_handling_basis: boundedNonEmptyString(record.data_handling_basis, `${label}.data_handling_basis`)
      };
    })
    .sort((left, right) => left.destination.localeCompare(right.destination));
}

function agentRefList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.${field} must be an array with at most 128 entries`);
  }
  const entries = value
    .map((entry, index) => {
      if (typeof entry !== "string" || !AGENT_REF_PATTERN.test(entry)) {
        throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.${field}[${index}] must be a canonical agent reference`);
      }
      if (HOSTED_BUILTIN_MODEL_AGENTS.has(entry)) {
        throw new Error(
          `${DATA_GOVERNANCE_POLICY_ENV}.${field}[${index}] cannot reclassify hosted built-in agent ${entry} as local`
        );
      }
      return entry;
    })
    .sort();
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.${field} must not contain duplicates`);
  }
  return entries;
}

function openRouterModelList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(
      `${DATA_GOVERNANCE_POLICY_ENV}.openrouter_model_allowlist must be an array with at most 128 entries`
    );
  }
  const entries = value
    .map((entry, index) => {
      if (
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 256 ||
        !OPENROUTER_MODEL_ID_PATTERN.test(entry)
      ) {
        throw new Error(
          `${DATA_GOVERNANCE_POLICY_ENV}.openrouter_model_allowlist[${index}] must be an exact OpenRouter catalogue ID`
        );
      }
      return entry;
    })
    .sort();
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.openrouter_model_allowlist must not contain duplicates`);
  }
  return entries;
}

function productionSourceRootList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.production_source_roots must be an array with 1 to 128 entries`);
  }
  const roots = value
    .map((entry, index) => {
      const label = `${DATA_GOVERNANCE_POLICY_ENV}.production_source_roots[${index}]`;
      if (typeof entry !== "string" || entry.length > 4096) {
        throw new Error(`${label} must be a bounded canonical project-relative path`);
      }
      if (entry === ".") return entry;
      const validated = validateSafeRelativePath(entry);
      if (!validated.ok || validated.value === undefined || validated.value !== entry) {
        throw new Error(`${label} must be a canonical project-relative path`);
      }
      return validated.value;
    })
    .sort();
  if (new Set(roots).size !== roots.length) {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.production_source_roots must not contain duplicates`);
  }
  return roots;
}

function normalizedConfiguredProductionSourceRoots(config: ResolvedConfig): string[] {
  return [...config.permissions.productionSourceRoots]
    .map((root) => (root === "." ? root : normalizeRelativePath(root)))
    .sort();
}

function reviewSignoffKeyList(value: unknown): DataGovernanceReviewSignoffKey[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${DATA_GOVERNANCE_POLICY_ENV}.review_signoff_keys must be an array with at most 32 entries`);
  }
  const keyIds = new Set<string>();
  return value
    .map((candidate, index): DataGovernanceReviewSignoffKey => {
      const label = `${DATA_GOVERNANCE_POLICY_ENV}.review_signoff_keys[${index}]`;
      const record = asRecord(candidate, label);
      assertExactKeys(record, ["key_id", "algorithm", "public_key_spki_base64"], label);
      if (typeof record.key_id !== "string" || !REVIEW_SIGNOFF_KEY_ID_PATTERN.test(record.key_id)) {
        throw new Error(`${label}.key_id must be a canonical signing-key ID`);
      }
      if (keyIds.has(record.key_id)) throw new Error(`${label}.key_id duplicates ${record.key_id}`);
      keyIds.add(record.key_id);
      if (record.algorithm !== "ed25519") throw new Error(`${label}.algorithm must be ed25519`);
      if (typeof record.public_key_spki_base64 !== "string" || record.public_key_spki_base64.length > 4096) {
        throw new Error(`${label}.public_key_spki_base64 must be a bounded canonical base64 SPKI key`);
      }
      const bytes = Buffer.from(record.public_key_spki_base64, "base64");
      if (bytes.length === 0 || bytes.toString("base64") !== record.public_key_spki_base64) {
        throw new Error(`${label}.public_key_spki_base64 must be canonical base64`);
      }
      let publicKey: crypto.KeyObject;
      try {
        publicKey = crypto.createPublicKey({ key: bytes, format: "der", type: "spki" });
      } catch (error) {
        throw new Error(`${label}.public_key_spki_base64 is not a DER SPKI public key`, { cause: error });
      }
      const canonical = publicKey.export({ format: "der", type: "spki" });
      if (publicKey.asymmetricKeyType !== "ed25519" || !Buffer.from(canonical).equals(bytes)) {
        throw new Error(`${label}.public_key_spki_base64 must be a canonical Ed25519 SPKI public key`);
      }
      return {
        key_id: record.key_id,
        algorithm: "ed25519",
        public_key_spki_base64: record.public_key_spki_base64
      };
    })
    .sort((left, right) => left.key_id.localeCompare(right.key_id));
}

function destinationValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !DESTINATION_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical model:, cloud:, or artifact: destination`);
  }
  return value;
}

function digestValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function boundedNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4096) {
    throw new Error(`${label} must be a non-empty string of at most 4096 characters`);
  }
  return value.trim();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
