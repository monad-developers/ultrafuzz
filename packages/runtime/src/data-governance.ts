import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStrictJsonBytes, readSinglyLinkedRegularFileSnapshotInside } from "@ultrafuzz/artifacts";
import type { ResolvedConfig } from "@ultrafuzz/config";
import { z } from "zod";
import { retryFallbackProfileIds } from "./retry-chain.js";
import type { PlannedGraph, RuntimeDiagnostic } from "./types.js";
import { sha256Stable } from "./utils.js";
export const DATA_GOVERNANCE_POLICY_ENV = "ULTRAFUZZ_DATA_GOVERNANCE_POLICY" as const,
  DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV = "ULTRAFUZZ_DATA_DISCLOSURE_ACKNOWLEDGEMENTS" as const,
  MODAL_PUBLIC_BENCHMARK_ENV = "ULTRAFUZZ_MODAL_PUBLIC_BENCHMARK" as const,
  DATA_GOVERNANCE_PROVENANCE_PATH = "data-governance.json" as const,
  DATA_GOVERNANCE_POLICY_SCHEMA_VERSION = "ultrafuzz.data-governance-policy.v1" as const,
  DATA_GOVERNANCE_PROVENANCE_SCHEMA_VERSION = "ultrafuzz.data-governance-provenance.v1" as const,
  DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION = "ultrafuzz.data-disclosure-acknowledgement.v1" as const;
const DESTINATION = /^(?:model|cloud|artifact):[a-z0-9][a-z0-9._-]{0,127}$/u,
  MODEL_ID = /^[^\s\p{Cc}]+$/u,
  DIGEST = /^[a-f0-9]{64}$/u,
  MAX_GOVERNANCE_FILE_BYTES = 16 * 1024 * 1024,
  MAX_GOVERNANCE_TOTAL_BYTES = 64 * 1024 * 1024;
const ROUTE_ENV_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  ClaudeAgent: ["ANTHROPIC_", "CLAUDE_CODE_USE_", "AWS_", "AZURE_", "CLOUD_ML_", "FOUNDRY_", "GOOGLE_"],
  CodexAgent: ["AZURE_OPENAI_", "OPENAI_"],
  KimiAgent: ["KIMI_", "MOONSHOT_"]
};
const ROUTE_ENV_SECRET = /(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN)/u;
const ROUTE_PROXY_ENV = [
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy"
] as const;
const textSchema = z
    .string()
    .max(4096)
    .refine((value) => value.trim() !== "")
    .transform((value) => value.trim()),
  destinationSchema = z.string().max(128).regex(DESTINATION),
  modelSchema = z.string().max(256).regex(MODEL_ID),
  digestSchema = z.string().regex(DIGEST);
const uniqueSorted = (schema: z.ZodString) =>
  z
    .array(schema)
    .max(128)
    .refine((entries) => new Set(entries).size === entries.length, "contains duplicate entries")
    .transform((entries) => [...entries].sort());
const destinationPolicySchema = z.strictObject({
  destination: destinationSchema,
  processor: textSchema,
  region: textSchema,
  retention_policy: textSchema,
  training_policy: textSchema,
  dpa_status: textSchema,
  minimization_policy: textSchema,
  data_handling_basis: textSchema
});
const policySchema = z
  .strictObject({
    schema_version: z.literal(DATA_GOVERNANCE_POLICY_SCHEMA_VERSION),
    sensitivity: z.enum(["public", "private"]),
    source_destinations: uniqueSorted(destinationSchema),
    artifact_destinations: uniqueSorted(destinationSchema),
    destination_policies: z
      .array(destinationPolicySchema)
      .max(128)
      .transform((entries) => [...entries].sort((left, right) => left.destination.localeCompare(right.destination))),
    openrouter_model_allowlist: uniqueSorted(modelSchema)
  })
  .refine(
    (entry) =>
      [...new Set([...entry.source_destinations, ...entry.artifact_destinations])].sort().join("\0") ===
      entry.destination_policies.map((policy) => policy.destination).join("\0"),
    { path: ["destination_policies"], message: "must describe every declared destination exactly once" }
  );
const acknowledgementSchema = z.strictObject({
  schema_version: z.literal(DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION),
  destination: destinationSchema,
  policy_digest: digestSchema,
  input_digest: digestSchema,
  acknowledged_by: textSchema,
  acknowledged_at: textSchema.refine(
    (value) => Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value,
    "must be a canonical UTC timestamp"
  )
});
const acknowledgementsSchema = z
  .array(acknowledgementSchema)
  .max(128)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.destination)).size === entries.length,
    "contains duplicate destinations"
  );
export type DataGovernancePolicy = z.infer<typeof policySchema>;
export type DataDisclosureAcknowledgement = z.infer<typeof acknowledgementSchema>;
export interface DataGovernanceProvenance {
  schema_version: typeof DATA_GOVERNANCE_PROVENANCE_SCHEMA_VERSION;
  policy: DataGovernancePolicy;
  policy_digest: string;
  input_digest: string;
  target: { commit: string | null; tree: string | null; dirty: boolean; worktree_digest: string | null };
  required_source_destinations: string[];
  required_artifact_destinations: string[];
  acknowledgements: DataDisclosureAcknowledgement[];
  acknowledgement_status: "approved" | "not-required" | "pending";
}
type PrepareGovernanceInput = {
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
  controllerOwnedPaths?: string[];
};
export function prepareDataGovernance(input: PrepareGovernanceInput): {
  provenance: DataGovernanceProvenance;
  diagnostics: RuntimeDiagnostic[];
} {
  const env = { ...process.env, ...(input.env ?? {}) },
    target = targetIdentity(input.projectRoot, input.controllerOwnedPaths),
    required = requiredDestinations(input.config, input.graph, env);
  if (env[MODAL_PUBLIC_BENCHMARK_ENV] === "1") {
    required.source = [...new Set([...required.source, "cloud:modal"])].sort();
    required.artifact = [...new Set([...required.artifact, "cloud:modal"])].sort();
    required.external = [...new Set([...required.source, ...required.artifact])].sort();
  }
  const policy =
      env[MODAL_PUBLIC_BENCHMARK_ENV] === "1"
        ? publicBenchmarkPolicy(required)
        : parseDataGovernancePolicy(env[DATA_GOVERNANCE_POLICY_ENV]),
    policyDigest = sha256Stable(policy);
  const inputDigest = sha256Stable({
    schema_version: DATA_GOVERNANCE_PROVENANCE_SCHEMA_VERSION,
    graph_fingerprint: input.graphFingerprint,
    config_fingerprint: input.configFingerprint,
    prompt_digest: input.promptDigest,
    source_run_id: input.sourceRunId ?? null,
    reference_expectations_digest: input.referenceExpectationsDigest ?? null,
    operator_prompt_digest: sha256Stable(input.operatorPrompt ?? null),
    workflow_input_digest: sha256Stable(input.workflowInput ?? null),
    destinations: { source: required.source, artifact: required.artifact },
    target
  });
  const parsed = parseAcknowledgements(env[DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV]),
    requiredAcknowledgements = policy.sensitivity === "private" ? [...required.external].sort() : [];
  const acknowledgements = parsed.filter(
    (entry) =>
      requiredAcknowledgements.includes(entry.destination) &&
      entry.policy_digest === policyDigest &&
      entry.input_digest === inputDigest
  );
  const diagnostics: RuntimeDiagnostic[] = [],
    report = (code: string, message: string, pathValue: string = DATA_GOVERNANCE_POLICY_ENV) =>
      diagnostics.push(errorDiagnostic(code, message, pathValue));
  if (policy.sensitivity === "private" && (target.commit === null || target.dirty))
    report("DATA_GOVERNANCE_PRIVATE_TARGET_UNBOUND", "private campaigns require a clean, exact Git target identity");
  const missingSource = required.source.filter((entry) => !policy.source_destinations.includes(entry)),
    missingArtifact = required.artifact.filter((entry) => !policy.artifact_destinations.includes(entry));
  if (missingSource.length > 0 || missingArtifact.length > 0)
    report(
      "DATA_GOVERNANCE_DESTINATION_NOT_ALLOWED",
      `campaign policy is missing source=[${missingSource.join(", ")}] artifact=[${missingArtifact.join(", ")}]; policy_digest=${policyDigest}; input_digest=${inputDigest}`
    );
  const unapprovedModels = required.openRouterModels.filter(
    (entry) => !policy.openrouter_model_allowlist.includes(entry)
  );
  if (unapprovedModels.length > 0)
    report(
      "DATA_GOVERNANCE_OPENROUTER_MODEL_NOT_ALLOWED",
      `OpenRouter model allowlist is missing ${unapprovedModels.join(", ")}; policy_digest=${policyDigest}; input_digest=${inputDigest}`
    );
  const approved = new Set(acknowledgements.map((entry) => entry.destination)),
    missingAcknowledgements = requiredAcknowledgements.filter((entry) => !approved.has(entry));
  if (missingAcknowledgements.length > 0)
    report(
      "DATA_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED",
      `private disclosure requires acknowledgements for ${missingAcknowledgements.join(", ")}; policy_digest=${policyDigest}; input_digest=${inputDigest}`,
      DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV
    );
  const acknowledgementStatus =
    requiredAcknowledgements.length === 0
      ? "not-required"
      : acknowledgements.length === requiredAcknowledgements.length
        ? "approved"
        : "pending";
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
      acknowledgement_status: acknowledgementStatus
    },
    diagnostics
  };
}
export function parseDataGovernancePolicy(value: string | undefined): DataGovernancePolicy {
  if (value === undefined || value.trim() === "")
    return {
      schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
      sensitivity: "private",
      source_destinations: [],
      artifact_destinations: [],
      destination_policies: [],
      openrouter_model_allowlist: []
    };
  return validated(policySchema, parseJson(value, DATA_GOVERNANCE_POLICY_ENV), DATA_GOVERNANCE_POLICY_ENV);
}
export function parseAcknowledgements(value: string | undefined): DataDisclosureAcknowledgement[] {
  if (value === undefined || value.trim() === "") return [];
  return validated(
    acknowledgementsSchema,
    parseJson(value, DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV),
    DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV
  );
}
function publicBenchmarkPolicy(required: ReturnType<typeof requiredDestinations>): DataGovernancePolicy {
  const destinations = [...new Set([...required.source, ...required.artifact])].sort();
  return {
    schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
    sensitivity: "public",
    source_destinations: required.source,
    artifact_destinations: required.artifact,
    destination_policies: destinations.map((destination) => ({
      destination,
      processor: "configured benchmark service",
      region: "provider-defined",
      retention_policy: "provider terms",
      training_policy: "public benchmark data",
      dpa_status: "not-required",
      minimization_policy: "declared benchmark inputs and outputs only",
      data_handling_basis: "public benchmark"
    })),
    openrouter_model_allowlist: required.openRouterModels
  };
}
function requiredDestinations(config: ResolvedConfig, graph: PlannedGraph, env: NodeJS.ProcessEnv) {
  const source = new Set<string>(),
    artifact = new Set<string>(),
    openRouterModels = new Set<string>();
  const add = (agent: string, model?: string) => {
    source.add(modelDestination(agent, config, env));
    if (agent === "OpenRouterAgent" && model !== undefined) openRouterModels.add(model);
  };
  for (const node of graph.nodes)
    for (const model of node.model_fanout) {
      add(model.agent_ref, model.model_name);
      if (model.model_profile_id === undefined) continue;
      for (const profileId of retryFallbackProfileIds(config, model.model_profile_id)) {
        const fallback = config.models.profiles[profileId];
        if (fallback === undefined) throw new Error(`missing fallback model profile ${profileId}`);
        add(fallback.agent, fallback.model);
      }
    }
  if (config.execution.mode === "cloud" && config.execution.provider === "modal") {
    source.add("cloud:modal");
    artifact.add("cloud:modal");
  }
  return {
    source: [...source].sort(),
    artifact: [...artifact].sort(),
    external: [...new Set([...source, ...artifact])].sort(),
    openRouterModels: [...openRouterModels].sort()
  };
}
export function modelDestination(agent: string, config: ResolvedConfig, env: NodeJS.ProcessEnv): string {
  const builtins: Record<string, string> = {
      CodexAgent: "openai",
      ClaudeAgent: "anthropic",
      KimiAgent: "moonshot",
      DeepSeekAgent: "deepseek",
      OpenRouterAgent: "openrouter"
    },
    route = effectiveRoute(agent, config, env);
  if (route !== undefined) return `model:${agent.toLowerCase().replace("agent", "")}-route-${route}`;
  if (builtins[agent] === undefined) throw new Error(`cannot derive a data destination for ${agent}`);
  return `model:${builtins[agent]}`;
}
function effectiveRoute(agent: string, config: ResolvedConfig, env: NodeJS.ProcessEnv): string | undefined {
  const routeEnvironment = effectiveRouteEnvironment(agent, env),
    provider = { CodexAgent: "codex", KimiAgent: "kimi", ClaudeAgent: "claude" }[agent];
  if (provider === undefined || (agent === "KimiAgent" && config.agents?.KimiAgent?.auth === "api-key"))
    return routeEnvironment.length > 0 ? sha256Stable({ agent, config: null, route: routeEnvironment }) : undefined;
  const configured = config.agents?.[agent]?.configDir,
    selectedRoot = env.ULTRAFUZZ_PROVIDER_HOME_ROOT?.trim(),
    userHome = env.HOME?.trim() || os.homedir(),
    defaultRoot = path.join(
      env.XDG_STATE_HOME?.trim() || path.join(userHome, ".local", "state"),
      "ultrafuzz",
      "provider-homes"
    ),
    home = configured
      ? path.join(selectedRoot || defaultRoot, provider, configured)
      : selectedRoot
        ? path.join(selectedRoot, provider)
        : agent === "CodexAgent"
          ? env.CODEX_HOME?.trim() || path.join(userHome, ".codex")
          : agent === "KimiAgent"
            ? env.KIMI_CODE_HOME?.trim() || env.KIMI_SHARE_DIR?.trim() || path.join(userHome, ".kimi-code")
            : env.CLAUDE_CONFIG_DIR?.trim() || path.join(userHome, ".claude"),
    routeConfig = path.join(home, agent === "ClaudeAgent" ? "settings.json" : "config.toml");
  let configDigest: string | undefined;
  if (fs.existsSync(routeConfig)) {
    const bytes = readSinglyLinkedRegularFileSnapshotInside(home, routeConfig, 1024 * 1024, "provider route config");
    if (agent !== "ClaudeAgent" || claudeSettingsAffectRoute(bytes)) configDigest = hash(bytes);
    if (configDigest !== undefined && config.execution.mode === "cloud")
      throw new Error(
        "cloud execution cannot use host provider-home routing; select and acknowledge the route through environment variables"
      );
  }
  return routeEnvironment.length > 0
    ? sha256Stable({ agent, config: configDigest ?? null, route: routeEnvironment })
    : configDigest;
}
function claudeSettingsAffectRoute(bytes: Buffer): boolean {
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: 1024 * 1024,
    maxDepth: 32,
    maxItems: 4096,
    maxProperties: 4096
  });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Claude settings must be a JSON object");
  if (Object.keys(parsed).some((name) => /(?:helper|refresh|credentialexport|processwrapper|proxyauth)$/iu.test(name)))
    return true;
  const configuredEnv = (parsed as Record<string, unknown>).env;
  if (configuredEnv === undefined) return false;
  if (configuredEnv === null || typeof configuredEnv !== "object" || Array.isArray(configuredEnv))
    throw new Error("Claude settings env must be a JSON object");
  return Object.keys(configuredEnv).some((name) => {
    const upper = name.toUpperCase();
    return (
      ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].includes(upper) ||
      (!ROUTE_ENV_SECRET.test(upper) && ROUTE_ENV_PREFIXES.ClaudeAgent!.some((prefix) => upper.startsWith(prefix)))
    );
  });
}
export function effectiveRouteEnvironment(agent: string, env: NodeJS.ProcessEnv): Array<[string, string]> {
  const names = new Set(
    (env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? "").split(",").map((entry) => entry.trim().toUpperCase())
  );
  for (const name of ROUTE_PROXY_ENV) names.add(name);
  for (const name of Object.keys(env))
    if (!ROUTE_ENV_SECRET.test(name) && ROUTE_ENV_PREFIXES[agent]?.some((prefix) => name.startsWith(prefix)))
      names.add(name);
  if (agent === "CodexAgent") names.add("OPENAI_BASE_URL");
  if (agent === "KimiAgent") names.add("KIMI_BASE_URL");
  names.delete("KIMI_CODE_HOME");
  names.delete("KIMI_SHARE_DIR");
  return [...names].sort().flatMap((name): Array<[string, string]> => {
    const value = env[name];
    return value !== undefined &&
      value.trim() !== "" &&
      !ROUTE_ENV_SECRET.test(name) &&
      (ROUTE_PROXY_ENV.includes(name as never) || ROUTE_ENV_PREFIXES[agent]?.some((prefix) => name.startsWith(prefix)))
      ? [[name, value]]
      : [];
  });
}
export function targetIdentity(
  projectRoot: string,
  ignoredPaths: readonly string[] = []
): DataGovernanceProvenance["target"] {
  let git: string;
  try {
    git = trustedGitExecutable(projectRoot);
  } catch {
    return { commit: null, tree: null, dirty: true, worktree_digest: null };
  }
  const run = (args: string[], encoding: BufferEncoding | "buffer" = "utf8") =>
    execFileSync(git, ["-c", "core.fsmonitor=false", "-c", "diff.ignoreSubmodules=none", ...args], {
      cwd: projectRoot,
      encoding,
      env: {
        PATH: path.dirname(git),
        HOME: path.dirname(git),
        XDG_CONFIG_HOME: path.dirname(git),
        LC_ALL: "C",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_PAGER: ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024
    });
  let commit: string, tree: string;
  try {
    const revision = (value: string) =>
      String(run(["rev-parse", "--verify", value]))
        .trim()
        .toLowerCase();
    commit = revision("HEAD^{commit}");
    tree = revision("HEAD^{tree}");
  } catch {
    return { commit: null, tree: null, dirty: true, worktree_digest: null };
  }
  if (!/^[a-f0-9]{40,64}$/u.test(commit) || !/^[a-f0-9]{40,64}$/u.test(tree)) throw new Error("invalid Git identity");
  const configNames = (run(["config", "--includes", "--null", "--name-only", "--list"], "buffer") as Buffer)
    .toString("utf8")
    .split("\0");
  if (configNames.some((name) => /^filter\..+\.(?:clean|process)$/iu.test(name)))
    throw new Error("Git content filters are forbidden for governed targets");
  const ignored = ignoredPaths.map((entry) => {
      const relative = path.relative(projectRoot, path.resolve(projectRoot, entry)).split(path.sep).join("/");
      if (relative === "" || relative === ".." || relative.startsWith("../"))
        throw new Error("controller-owned governance path escapes the project");
      return relative.replace(/\/$/u, "");
    }),
    diff = run(
      ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "HEAD", "--", "."],
      "buffer"
    ) as Buffer,
    indexFlags = run(["ls-files", "-v", "-z"], "buffer") as Buffer,
    hiddenTrackedState = indexFlags
      .toString("utf8")
      .split("\0")
      .some((entry) => entry !== "" && !entry.startsWith("H ")),
    names = (run(["ls-files", "--others", "--exclude-standard", "-z"], "buffer") as Buffer)
      .toString("utf8")
      .split("\0")
      .filter((name) => name !== "" && !ignored.some((entry) => name === entry || name.startsWith(`${entry}/`)))
      .sort();
  let untrackedBytes = 0;
  const untracked = names.map((name) => {
    const absolute = path.resolve(projectRoot, name),
      relative = path.relative(projectRoot, absolute);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Git returned an unsafe path");
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return { path: name, symlink: fs.readlinkSync(absolute) };
    if (!stat.isFile()) throw new Error(`untracked path is not a regular file: ${name}`);
    const bytes = readSinglyLinkedRegularFileSnapshotInside(
      projectRoot,
      absolute,
      MAX_GOVERNANCE_FILE_BYTES,
      "untracked governance input"
    );
    untrackedBytes += bytes.byteLength;
    if (untrackedBytes > MAX_GOVERNANCE_TOTAL_BYTES) throw new Error("untracked governance input exceeds 64 MiB");
    return { path: name, sha256: hash(bytes) };
  });
  return {
    commit,
    tree,
    dirty: hiddenTrackedState || diff.length > 0 || untracked.length > 0,
    worktree_digest: sha256Stable({ tree, diff: hash(diff), index_flags: hash(indexFlags), untracked })
  };
}
export function trustedGitExecutable(projectRoot: string): string {
  const target = fs.realpathSync(projectRoot),
    uid = process.getuid?.(),
    search = [
      ...(process.env.PATH ?? "").split(path.delimiter),
      ...(process.platform === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin"])
    ];
  for (const entry of new Set(search)) {
    if (!path.isAbsolute(entry)) continue;
    try {
      const executable = fs.realpathSync(path.join(entry, process.platform === "win32" ? "git.exe" : "git")),
        relative = path.relative(target, executable);
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
        continue;
      for (let current = executable; ; current = path.dirname(current)) {
        const stat = fs.lstatSync(current);
        if (
          (current === executable ? !stat.isFile() : !stat.isDirectory()) ||
          stat.isSymbolicLink() ||
          (process.platform !== "win32" &&
            ((stat.mode & 0o022) !== 0 || (uid !== undefined && ![0, uid].includes(stat.uid))))
        )
          throw new Error("untrusted Git executable path");
        if (current === path.dirname(current)) break;
      }
      fs.accessSync(executable, fs.constants.X_OK);
      return executable;
    } catch {
      continue;
    }
  }
  throw new Error("no operator-trusted Git executable is available outside the target repository");
}
function parseJson(value: string, label: string): unknown {
  try {
    return parseStrictJsonBytes(Buffer.from(value), {
      maxBytes: 256 * 1024,
      maxDepth: 32,
      maxItems: 4096,
      maxProperties: 4096
    });
  } catch (error) {
    throw new Error(`${label} must contain bounded strict JSON`, { cause: error });
  }
}
function validated<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(`${label} is invalid: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
  return parsed.data;
}
const hash = (value: crypto.BinaryLike): string => crypto.createHash("sha256").update(value).digest("hex");
const errorDiagnostic = (code: string, message: string, pathValue: string): RuntimeDiagnostic => ({
  code,
  message,
  severity: "error",
  source: "governance",
  path: pathValue
});
