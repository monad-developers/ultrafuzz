import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { validateArtifactContract, validateFindingsSchema } from "../../packages/artifacts/dist/index.js";

const MANIFEST_SCHEMA_VERSION = "1.0";
const CANONICAL_TARGETS = new Map(
  Object.entries({
    "very-liquid-vaults-foundry": {
      framework: "foundry",
      repository: "https://github.com/rheo-xyz/very-liquid-vaults",
      repository_slug: "rheo-xyz/very-liquid-vaults",
      revision: "e50384709a696c86ab0440bbbc3dd14a5f4ff6ec"
    },
    "venus-isolated-pools-hardhat": {
      framework: "hardhat",
      repository: "https://github.com/code-423n4/2023-05-venus",
      repository_slug: "code-423n4/2023-05-venus",
      revision: "9853f6f4fe906b635e214b22de9f627c6a17ba5b"
    },
    "stableswap-ng-vyper": {
      framework: "vyper",
      repository: "https://github.com/curvefi/stableswap-ng",
      repository_slug: "curvefi/stableswap-ng",
      revision: "8c78731ed43c22e6bcdcb5d39b0a7d02f8cb0386"
    }
  } satisfies Record<
    string,
    { framework: "foundry" | "hardhat" | "vyper"; repository: string; repository_slug: string; revision: string }
  >)
);
const REQUIRED_TARGET_IDS = new Set(CANONICAL_TARGETS.keys());
const REQUIRED_FRAMEWORKS = new Set(["foundry", "hardhat", "vyper"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;
const SYNTHETIC_PROVENANCE_PATTERN = /(?:ci-helper|signal-analysis|target-e2e-artifacts)/iu;
const SENSITIVE_NAME_PATTERN = /(?:auth|credential|key|password|secret|token)/iu;
const MAX_DIAGNOSTIC_BYTES = 1_000_000;

type JsonObject = Record<string, unknown>;

export interface TargetToolchain {
  runtime: string;
  package_manager?: string;
  install_command: string;
  build_command: string;
}

export interface TargetManifestEntry {
  id: string;
  name: string;
  framework: "foundry" | "hardhat" | "vyper";
  repository: string;
  repository_slug: string;
  revision: string;
  toolchain: TargetToolchain;
  known_vulnerability_references: string[];
}

export interface TargetManifest {
  schema_version: typeof MANIFEST_SCHEMA_VERSION;
  targets: TargetManifestEntry[];
}

export function loadTargetManifest(path: string): TargetManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  return validateTargetManifest(parsed);
}

export function validateTargetManifest(value: unknown): TargetManifest {
  if (!isRecord(value) || value.schema_version !== MANIFEST_SCHEMA_VERSION || !Array.isArray(value.targets)) {
    throw new Error("target manifest must contain the supported schema version and a targets array");
  }
  if (value.targets.length !== REQUIRED_TARGET_IDS.size) {
    throw new Error(`target manifest must contain exactly ${REQUIRED_TARGET_IDS.size} targets`);
  }

  const targets = value.targets.map((target, index) => validateTarget(target, index));
  requireExactSet(
    targets.map((target) => target.id),
    REQUIRED_TARGET_IDS,
    "target IDs"
  );
  requireExactSet(
    targets.map((target) => target.framework),
    REQUIRED_FRAMEWORKS,
    "target frameworks"
  );
  requireUnique(
    targets.map((target) => target.repository),
    "target repositories"
  );
  requireUnique(
    targets.map((target) => target.revision),
    "target revisions"
  );

  const hardhat = targets.find((target) => target.framework === "hardhat");
  if (hardhat?.toolchain.runtime !== "Node.js 16" || hardhat.toolchain.package_manager !== "Yarn 1.22.1") {
    throw new Error("Hardhat target must pin Node.js 16 and Yarn 1.22.1");
  }
  return { schema_version: MANIFEST_SCHEMA_VERSION, targets };
}

export function targetById(manifest: TargetManifest, id: string): TargetManifestEntry {
  const target = manifest.targets.find((entry) => entry.id === id);
  if (target === undefined) {
    throw new Error(`unknown target ID: ${id}`);
  }
  return target;
}

export function targetField(manifestPath: string, id: string, field: string): string {
  const target = targetById(loadTargetManifest(manifestPath), id);
  const allowed: Record<string, string> = {
    name: target.name,
    repository: target.repository,
    revision: target.revision
  };
  const value = allowed[field];
  if (value === undefined) {
    throw new Error(`unsupported target field: ${field}`);
  }
  return value;
}

export function writeTargetMetadata(
  manifestPath: string,
  id: string,
  outputPath: string,
  checkedOutRevision: string
): void {
  const target = targetById(loadTargetManifest(manifestPath), id);
  if (checkedOutRevision !== target.revision) {
    throw new Error("checked-out target revision does not match the immutable manifest revision");
  }
  writeJson(outputPath, {
    schema_version: MANIFEST_SCHEMA_VERSION,
    target,
    checked_out_revision: checkedOutRevision,
    smoke_policy: {
      trials: 1,
      strategy_loops: 1,
      excluded_lanes: ["stateful-invariant", "differential", "dynamic-strategy"],
      model_profile: "target-e2e",
      model: "gpt-5.6-luna",
      reasoning: "high"
    }
  });
}

export function extractReportEvidence(envelopePath: string, evidenceRoot: string): void {
  const envelope = loadJsonObject(envelopePath);
  const data = isRecord(envelope.data) ? envelope.data : {};
  const jsonPath = requireRegularFile(data.json_path, "report JSON");
  const markdownPath = requireRegularFile(data.markdown_path, "report Markdown");
  const reportText = readFileSync(jsonPath, "utf-8");
  const markdown = readFileSync(markdownPath, "utf-8");
  assertNoSensitiveMaterial(reportText, "report JSON");
  assertNoSensitiveMaterial(markdown, "report Markdown");

  const reportValidation = validateArtifactContract("ultrafuzz/report@1", reportText, jsonPath);
  if (!reportValidation.ok) {
    throw new Error(`terminal report schema validation failed: ${formatIssues(reportValidation.issues)}`);
  }
  const report = JSON.parse(reportText) as JsonObject;
  const issues = report.issues as unknown[];

  const artifactsRoot = dirname(dirname(jsonPath));
  const severityPath = findArtifactFile(artifactsRoot, "severity-classification", "severity-classified-findings.json");
  const severityBody: unknown = JSON.parse(readFileSync(severityPath, "utf-8"));
  const normalized = normalizedFindings(severityBody);
  const findings = normalized.filter(isPromotedFinding);
  if (findings.length === 0) {
    throw new Error("final normalized findings must contain at least one promoted finding");
  }

  const findingsValidation = validateFindingsSchema(findings, severityPath);
  if (!findingsValidation.ok) {
    throw new Error(`final findings schema validation failed: ${formatIssues(findingsValidation.issues)}`);
  }
  for (const [index, finding] of findings.entries()) {
    assertFindingEvidence(finding as JsonObject, index);
  }
  if (issues.length !== findings.length) {
    throw new Error(`report JSON count ${issues.length} does not match final findings count ${findings.length}`);
  }
  if (typeof report.finding_count === "number" && report.finding_count !== findings.length) {
    throw new Error("report JSON finding_count does not match final findings count");
  }

  const markdownCount = [...markdown.matchAll(/^## \[(?:H|M|L)-\d{2}\] - /gmu)].length;
  if (markdownCount !== findings.length) {
    throw new Error(`report Markdown count ${markdownCount} does not match final findings count ${findings.length}`);
  }

  mkdirSync(evidenceRoot, { recursive: true });
  copyFileSync(jsonPath, join(evidenceRoot, "report.json"));
  copyFileSync(markdownPath, join(evidenceRoot, "report.md"));
  writeJson(join(evidenceRoot, "findings.json"), findings);
  writeJson(join(evidenceRoot, "run-summary.json"), {
    schema_version: MANIFEST_SCHEMA_VERSION,
    finding_count: findings.length,
    run_metadata: isRecord(report.run_metadata) ? report.run_metadata : {}
  });
}

export function redactText(input: string, env: Record<string, string | undefined> = process.env): string {
  let output = input;
  const sensitiveEntries = Object.entries(env)
    .filter(([name]) => SENSITIVE_NAME_PATTERN.test(name))
    .sort(([left], [right]) => right.length - left.length);
  for (const [, value] of sensitiveEntries) {
    if (value !== undefined && value.length >= 8) {
      output = output.split(value).join("[REDACTED_SENSITIVE_VALUE]");
    }
  }
  for (const [name] of sensitiveEntries) {
    output = output.split(name).join("[REDACTED_SENSITIVE_NAME]");
  }
  return output
    .replace(/\b(?:sk|gh[opsu]|github_pat)_[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED_TOKEN]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED_USERINFO]@");
}

export function redactFile(path: string, maxBytes = MAX_DIAGNOSTIC_BYTES): void {
  if (!existsSync(path)) {
    return;
  }
  const redacted = redactText(readFileSync(path, "latin1"));
  const encoded = Buffer.from(redacted, "latin1");
  if (encoded.length <= maxBytes) {
    writeFileSync(path, encoded);
    return;
  }
  const suffix = Buffer.from("\n[TRUNCATED_BOUNDED_DIAGNOSTIC]\n", "utf-8");
  writeFileSync(path, Buffer.concat([encoded.subarray(0, Math.max(0, maxBytes - suffix.length)), suffix]));
}

function validateTarget(value: unknown, index: number): TargetManifestEntry {
  if (!isRecord(value)) {
    throw new Error(`target manifest entry ${index} must be an object`);
  }
  const id = requiredString(value.id, `targets[${index}].id`);
  const expected = CANONICAL_TARGETS.get(id);
  if (expected === undefined) {
    throw new Error(`targets[${index}].id is not in the canonical smoke matrix`);
  }
  const name = requiredString(value.name, `targets[${index}].name`);
  const framework = requiredString(value.framework, `targets[${index}].framework`);
  if (!REQUIRED_FRAMEWORKS.has(framework)) {
    throw new Error(`targets[${index}].framework is unsupported`);
  }
  if (framework !== expected.framework) {
    throw new Error(`targets[${index}].framework does not match the canonical smoke matrix`);
  }
  const repository = requiredString(value.repository, `targets[${index}].repository`);
  const repositoryMatch = REPOSITORY_PATTERN.exec(repository);
  if (repositoryMatch === null) {
    throw new Error(`targets[${index}].repository must be a canonical GitHub HTTPS URL`);
  }
  if (repository !== expected.repository) {
    throw new Error(`targets[${index}].repository does not match the canonical smoke matrix`);
  }
  const repositorySlug = requiredString(value.repository_slug, `targets[${index}].repository_slug`);
  if (repositorySlug !== `${repositoryMatch[1]}/${repositoryMatch[2]}`) {
    throw new Error(`targets[${index}].repository_slug must match repository`);
  }
  if (repositorySlug !== expected.repository_slug) {
    throw new Error(`targets[${index}].repository_slug does not match the canonical smoke matrix`);
  }
  const revision = requiredString(value.revision, `targets[${index}].revision`);
  if (!SHA_PATTERN.test(revision)) {
    throw new Error(`targets[${index}].revision must be a full immutable commit SHA`);
  }
  if (revision !== expected.revision) {
    throw new Error(`targets[${index}].revision does not match the canonical smoke matrix`);
  }
  if (!isRecord(value.toolchain)) {
    throw new Error(`targets[${index}].toolchain must be an object`);
  }
  const toolchain: TargetToolchain = {
    runtime: requiredString(value.toolchain.runtime, `targets[${index}].toolchain.runtime`),
    ...(value.toolchain.package_manager === undefined
      ? {}
      : {
          package_manager: requiredString(
            value.toolchain.package_manager,
            `targets[${index}].toolchain.package_manager`
          )
        }),
    install_command: requiredString(value.toolchain.install_command, `targets[${index}].toolchain.install_command`),
    build_command: requiredString(value.toolchain.build_command, `targets[${index}].toolchain.build_command`)
  };
  if (!Array.isArray(value.known_vulnerability_references) || value.known_vulnerability_references.length === 0) {
    throw new Error(`targets[${index}] must include a public known-vulnerability reference`);
  }
  const references = value.known_vulnerability_references.map((reference, referenceIndex) => {
    const url = requiredString(reference, `targets[${index}].known_vulnerability_references[${referenceIndex}]`);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new Error(`targets[${index}] contains an invalid known-vulnerability URL`);
    }
    return url;
  });
  return {
    id,
    name,
    framework: framework as TargetManifestEntry["framework"],
    repository,
    repository_slug: repositorySlug,
    revision,
    toolchain,
    known_vulnerability_references: references
  };
}

function normalizedFindings(value: unknown): JsonObject[] {
  const findings = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.findings)
      ? value.findings
      : null;
  if (findings === null || !findings.every(isRecord)) {
    throw new Error("severity-classified findings must be an array or an object with a findings array");
  }
  return findings;
}

function isPromotedFinding(finding: JsonObject): boolean {
  const lifecycle = isRecord(finding.lifecycle) ? finding.lifecycle : {};
  const disposition = finding.final_disposition ?? lifecycle.final_disposition;
  if (disposition !== undefined) {
    return disposition === "promoted";
  }
  return finding.triage_classification === "true-positive";
}

function assertFindingEvidence(finding: JsonObject, index: number): void {
  const requiredStrings = ["source_node_id", "strategy", "model_id", "model"];
  const requiredIndexes = ["attempt_index", "model_index", "loop_index"];
  if (requiredStrings.some((field) => typeof finding[field] !== "string" || finding[field] === "")) {
    throw new Error(`finding ${index} is missing normal workflow provenance`);
  }
  if (requiredIndexes.some((field) => !Number.isInteger(finding[field]) || Number(finding[field]) < 0)) {
    throw new Error(`finding ${index} is missing normal workflow attempt provenance`);
  }
  if (!Array.isArray(finding.affected_files) || !finding.affected_files.some(nonEmptyString)) {
    throw new Error(`finding ${index} is missing concrete affected source files`);
  }
  if (!Array.isArray(finding.evidence) || !finding.evidence.some(concreteEvidence)) {
    throw new Error(`finding ${index} is missing concrete evidence`);
  }
  if (containsSyntheticProvenance(finding)) {
    throw new Error(`finding ${index} contains synthetic helper provenance`);
  }
  assertNoSensitiveMaterial(JSON.stringify(finding), `finding ${index}`);
}

function concreteEvidence(value: unknown): boolean {
  return nonEmptyString(value) || (isRecord(value) && nonEmptyString(value.path));
}

function containsSyntheticProvenance(value: unknown): boolean {
  if (typeof value === "string") {
    return SYNTHETIC_PROVENANCE_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsSyntheticProvenance);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (isRecord(value.provenance)) {
    const origin = value.provenance.origin;
    if (typeof origin === "string" && /synthetic/iu.test(origin)) {
      return true;
    }
  }
  return Object.values(value).some(containsSyntheticProvenance);
}

function assertNoSensitiveMaterial(value: string, label: string): void {
  for (const [name, secret] of Object.entries(process.env)) {
    if (!SENSITIVE_NAME_PATTERN.test(name)) continue;
    if (value.includes(name) || (secret !== undefined && secret.length >= 8 && value.includes(secret))) {
      throw new Error(`${label} contains sensitive authentication material`);
    }
  }
  if (/\b(?:sk|gh[opsu]|github_pat)_[A-Za-z0-9_-]{12,}\b/u.test(value)) {
    throw new Error(`${label} contains credential-like material`);
  }
}

function findArtifactFile(artifactsRoot: string, nodeId: string, fileName: string): string {
  const candidates = [nodeId, ...readdirSync(artifactsRoot).filter((entry) => entry.startsWith(`${nodeId}-`))];
  for (const candidate of candidates) {
    const path = join(artifactsRoot, candidate, fileName);
    if (existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) {
      return path;
    }
  }
  throw new Error(`${fileName} is missing from the completed production review pipeline`);
}

function requireRegularFile(value: unknown, label: string): string {
  if (typeof value !== "string" || !existsSync(value)) {
    throw new Error(`${label} path is missing`);
  }
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  return resolve(value);
}

function loadJsonObject(path: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!isRecord(parsed)) {
    throw new Error(`${basename(path)} must contain a JSON object`);
  }
  return parsed;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function requireExactSet(values: string[], expected: Set<string>, label: string): void {
  if (values.length !== expected.size || values.some((value) => !expected.has(value))) {
    throw new Error(`target manifest ${label} do not match the canonical smoke matrix`);
  }
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`target manifest contains duplicate ${label}`);
  }
}

function formatIssues(issues: Array<{ path: string; message: string }>): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
