import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStrictJsonBytes } from "../packages/artifacts/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultExceptionPath = path.join(root, ".github", "dependency-advisory-exceptions.json");
const exceptionSchema = "ultrafuzz.dependency-advisory-exceptions.v1";
const auditSchema = "ultrafuzz.production-dependency-audit.v1";
export const APPROVED_AUDIT_ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const highSeverities = new Set(["high", "critical"]);
const knownSeverities = new Set(["info", "low", "moderate", ...highSeverities]);
const exceptionStatuses = new Set(["not-reachable", "remediation-in-progress", "risk-accepted"]);
const ghsaIdentifier = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/u;
const maximumExceptionDays = 30;
const maximumAuditBytes = 16 * 1024 * 1024;
const maximumExceptionBytes = 1024 * 1024;
const maximumAuditItems = 100_000;
const exactPackageVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const cweIdentifier = /^CWE-[1-9]\d*$/u;

export function evaluateDependencyAdvisoryPolicy(audit, exceptionDocument, asOf) {
  const errors = [];
  const asOfMs = parseDate(asOf, "policy evaluation date", errors);
  const advisories = parseProductionAudit(audit, errors);
  const exceptions = parseExceptions(exceptionDocument, asOfMs, errors);
  const matchedExceptions = new Set();

  for (const advisory of advisories) {
    const key = advisoryKey(advisory.github_advisory_id, advisory.module_name);
    const exception = exceptions.get(key);
    if (exception === undefined) {
      errors.push(
        `unapproved ${advisory.severity} production advisory ${advisory.github_advisory_id} in ${advisory.module_name}`
      );
      continue;
    }
    matchedExceptions.add(key);
    if (exception.severity !== advisory.severity) {
      errors.push(
        `exception severity for ${advisory.github_advisory_id} in ${advisory.module_name} does not match the registry advisory`
      );
    }
  }

  for (const [key, exception] of exceptions) {
    if (!matchedExceptions.has(key)) {
      errors.push(`stale dependency advisory exception ${exception.advisory} for ${exception.package}`);
    }
  }

  return {
    actionableCount: advisories.length,
    activeExceptionCount: matchedExceptions.size,
    errors
  };
}

export function parseProductionDependencyListCommandResult(result) {
  if (result.error !== undefined) {
    throw new Error(`could not enumerate production dependencies: ${result.error.message}`, { cause: result.error });
  }
  if (result.status === null) {
    const signal = typeof result.signal === "string" ? ` (${result.signal})` : "";
    throw new Error(`production dependency enumeration terminated without an exit code${signal}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `production dependency enumeration failed with exit code ${result.status}${formatStderr(result.stderr)}`
    );
  }
  if (!(result.stdout instanceof Uint8Array)) {
    throw new Error("production dependency enumeration did not return byte output");
  }
  return parseStrictJsonDocument(
    result.stdout,
    maximumAuditBytes,
    `production dependency enumeration did not return strict JSON${formatStderr(result.stderr)}`
  );
}

function parseProductionAudit(audit, errors) {
  if (!isRecord(audit)) {
    errors.push("production dependency audit must be an object");
    return [];
  }
  rejectUnknownFields(
    audit,
    new Set(["schema_version", "source", "advisories"]),
    "production dependency audit",
    errors
  );
  if (audit.schema_version !== auditSchema)
    errors.push("production dependency audit uses an unsupported schema version");
  if (audit.source !== APPROVED_AUDIT_ENDPOINT) errors.push("production dependency audit source is not approved");
  if (!Array.isArray(audit.advisories)) {
    errors.push("production dependency audit advisories must be an array");
    return [];
  }
  if (audit.advisories.length > maximumAuditItems) errors.push("production dependency audit has too many advisories");
  const actionable = [];
  const seen = new Set();
  for (const [index, candidate] of audit.advisories.entries()) {
    const prefix = `production dependency advisory ${index + 1}`;
    if (!isRecord(candidate)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    rejectUnknownFields(candidate, new Set(["advisory", "package", "severity"]), prefix, errors);
    const advisory = candidate.advisory;
    const packageName = candidate.package;
    const severity = candidate.severity;
    let valid = true;
    if (typeof advisory !== "string" || !ghsaIdentifier.test(advisory)) {
      errors.push(`${prefix} has an invalid GitHub advisory identifier`);
      valid = false;
    }
    if (!isPackageName(packageName)) {
      errors.push(`${prefix} has an invalid package name`);
      valid = false;
    }
    if (typeof severity !== "string" || !knownSeverities.has(severity)) {
      errors.push(`${prefix} has an invalid severity`);
      valid = false;
    }
    const key =
      typeof advisory === "string" && typeof packageName === "string" ? advisoryKey(advisory, packageName) : "";
    if (key !== "" && seen.has(key)) {
      errors.push(`${prefix} duplicates ${advisory} for ${packageName}`);
      valid = false;
    }
    if (key !== "") seen.add(key);
    if (valid && highSeverities.has(severity)) {
      actionable.push({
        github_advisory_id: advisory,
        module_name: packageName,
        severity
      });
    }
  }
  return actionable;
}

function parseExceptions(document, asOfMs, errors) {
  const exceptions = new Map();
  if (!isRecord(document) || document.schema_version !== exceptionSchema) {
    errors.push("dependency advisory exceptions use an unsupported schema version");
    return exceptions;
  }
  for (const field of Object.keys(document).sort()) {
    if (field !== "schema_version" && field !== "exceptions") {
      errors.push(`dependency advisory exception document contains unknown field ${field}`);
    }
  }
  if (!Array.isArray(document.exceptions)) {
    errors.push("dependency advisory exceptions must be an array");
    return exceptions;
  }

  for (const [index, candidate] of document.exceptions.entries()) {
    const prefix = `dependency advisory exception ${index + 1}`;
    if (!isRecord(candidate)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const allowedFields = new Set([
      "advisory",
      "package",
      "severity",
      "status",
      "reviewed_on",
      "expires",
      "owner",
      "tracking_issue",
      "reachability",
      "rationale"
    ]);
    for (const field of Object.keys(candidate).sort()) {
      if (!allowedFields.has(field)) errors.push(`${prefix} contains unknown field ${field}`);
    }

    const advisory = requiredText(candidate.advisory, `${prefix} advisory`, errors);
    const packageName = requiredText(candidate.package, `${prefix} package`, errors);
    const severity = requiredText(candidate.severity, `${prefix} severity`, errors).toLowerCase();
    const status = requiredText(candidate.status, `${prefix} status`, errors);
    const reviewedOn = requiredText(candidate.reviewed_on, `${prefix} reviewed_on`, errors);
    const expires = requiredText(candidate.expires, `${prefix} expires`, errors);
    const owner = requiredText(candidate.owner, `${prefix} owner`, errors);
    const trackingIssue = requiredText(candidate.tracking_issue, `${prefix} tracking_issue`, errors);
    requiredText(candidate.reachability, `${prefix} reachability`, errors, 10);
    requiredText(candidate.rationale, `${prefix} rationale`, errors, 10);

    if (!ghsaIdentifier.test(advisory)) errors.push(`${prefix} advisory must be a canonical GHSA identifier`);
    if (!isPackageName(packageName)) errors.push(`${prefix} package must be a valid bounded package name`);
    if (!highSeverities.has(severity)) errors.push(`${prefix} severity must be high or critical`);
    if (!exceptionStatuses.has(status)) {
      errors.push(`${prefix} status must be not-reachable, remediation-in-progress, or risk-accepted`);
    }
    if (!/^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner)) {
      errors.push(`${prefix} owner must be a GitHub login beginning with @`);
    }
    if (!/^#[1-9]\d*$/u.test(trackingIssue)) {
      errors.push(`${prefix} tracking_issue must be a GitHub issue number`);
    }

    const reviewedOnMs = parseDate(reviewedOn, `${prefix} reviewed_on`, errors);
    const expiresMs = parseDate(expires, `${prefix} expires`, errors);
    validateExceptionDates(prefix, reviewedOn, reviewedOnMs, expires, expiresMs, asOfMs, errors);

    if (ghsaIdentifier.test(advisory) && isPackageName(packageName)) {
      const key = advisoryKey(advisory, packageName);
      if (exceptions.has(key)) errors.push(`${prefix} duplicates ${advisory} for ${packageName}`);
      else exceptions.set(key, { advisory, package: packageName, severity });
    }
  }
  return exceptions;
}

function validateExceptionDates(prefix, reviewedOn, reviewedOnMs, expires, expiresMs, asOfMs, errors) {
  if (reviewedOnMs === undefined || expiresMs === undefined) return;
  if (expiresMs < reviewedOnMs) errors.push(`${prefix} expires before its review date`);
  const durationDays = (expiresMs - reviewedOnMs) / 86_400_000;
  if (durationDays > maximumExceptionDays) {
    errors.push(`${prefix} validity exceeds ${maximumExceptionDays} days`);
  }
  if (asOfMs === undefined) return;
  if (reviewedOnMs > asOfMs) errors.push(`${prefix} review date ${reviewedOn} is in the future`);
  if (expiresMs < asOfMs) errors.push(`${prefix} expired on ${expires}`);
}

function enumerateProductionDependencies() {
  const result = spawnSync("pnpm", ["list", "--prod", "--recursive", "--json", "--depth", "Infinity"], {
    cwd: root,
    maxBuffer: maximumAuditBytes,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000
  });
  return productionAuditRequestFromPnpmList(parseProductionDependencyListCommandResult(result));
}

export function productionAuditRequestFromPnpmList(document) {
  if (!Array.isArray(document) || document.length === 0 || document.length > 1_000) {
    throw new Error("production dependency enumeration uses an unsupported workspace schema");
  }
  const versionsByPackage = new Map();
  const pending = [...document];
  let visited = 0;
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!isRecord(candidate)) throw new Error("production dependency enumeration contains a non-object entry");
    visited += 1;
    if (visited > maximumAuditItems) throw new Error("production dependency enumeration is too large");
    for (const field of ["dependencies", "optionalDependencies"]) {
      const dependencies = candidate[field];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies)) throw new Error(`production dependency ${field} must be an object`);
      for (const [packageName, descriptor] of Object.entries(dependencies)) {
        if (!isPackageName(packageName) || !isRecord(descriptor)) {
          throw new Error("production dependency enumeration contains an invalid package entry");
        }
        const version = descriptor.version;
        if (typeof version !== "string" || version.length === 0 || version.length > 256) {
          throw new Error(`production dependency ${packageName} has an invalid version`);
        }
        if (version.startsWith("link:")) {
          if (!packageName.startsWith("@ultrafuzz/")) {
            throw new Error(`production dependency ${packageName} is a non-workspace link and cannot be audited`);
          }
        } else {
          if (!exactPackageVersion.test(version)) {
            throw new Error(`production dependency ${packageName} is not resolved to one exact registry version`);
          }
          if (!isApprovedRegistryResolution(descriptor.resolved)) {
            throw new Error(`production dependency ${packageName} is not resolved from the approved registry`);
          }
          const registryPackageName = packageNameFromPnpmDescriptor(packageName, descriptor.from, version);
          const versions = versionsByPackage.get(registryPackageName) ?? new Set();
          versions.add(version);
          versionsByPackage.set(registryPackageName, versions);
        }
        pending.push(descriptor);
      }
    }
  }
  if (versionsByPackage.size === 0) throw new Error("production dependency enumeration found no registry packages");
  const request = Object.fromEntries(
    [...versionsByPackage]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([packageName, versions]) => [packageName, [...versions].sort()])
  );
  if (Buffer.byteLength(JSON.stringify(request)) > maximumAuditBytes) {
    throw new Error("production dependency audit request is too large");
  }
  return request;
}

export function strictProductionAuditFromBulkResponse(bulk, request) {
  if (!isRecord(bulk)) throw new Error("approved registry audit response must be an object");
  if (!isRecord(request) || Object.keys(request).length === 0) {
    throw new Error("production dependency audit request is invalid");
  }
  const advisories = [];
  const seen = new Set();
  for (const [packageName, candidates] of Object.entries(bulk).sort(([left], [right]) => left.localeCompare(right))) {
    if (!Object.hasOwn(request, packageName)) {
      throw new Error(`approved registry returned an unrequested package ${packageName}`);
    }
    if (!Array.isArray(candidates)) {
      throw new Error(`approved registry advisories for ${packageName} must be an array`);
    }
    for (const [index, candidate] of candidates.entries()) {
      const prefix = `approved registry advisory ${packageName}[${index}]`;
      if (!isRecord(candidate)) throw new Error(`${prefix} must be an object`);
      const fields = new Set(["id", "url", "title", "severity", "vulnerable_versions", "cwe", "cvss"]);
      const unknown = Object.keys(candidate).filter((field) => !fields.has(field));
      const missing = [...fields].filter((field) => !Object.hasOwn(candidate, field));
      if (unknown.length > 0 || missing.length > 0) {
        throw new Error(`${prefix} uses an unsupported schema`);
      }
      if (!Number.isSafeInteger(candidate.id) || candidate.id < 1) throw new Error(`${prefix} has an invalid id`);
      const advisory = ghsaFromApprovedUrl(candidate.url, prefix);
      requireBoundedRegistryText(candidate.title, `${prefix} title`);
      requireBoundedRegistryText(candidate.vulnerable_versions, `${prefix} vulnerable_versions`);
      if (typeof candidate.severity !== "string" || !knownSeverities.has(candidate.severity)) {
        throw new Error(`${prefix} has an invalid severity`);
      }
      validateRegistryCwe(candidate.cwe, prefix);
      validateRegistryCvss(candidate.cvss, prefix);
      const key = advisoryKey(advisory, packageName);
      if (seen.has(key)) throw new Error(`${prefix} duplicates ${advisory}`);
      seen.add(key);
      advisories.push({ advisory, package: packageName, severity: candidate.severity });
      if (advisories.length > maximumAuditItems) throw new Error("approved registry returned too many advisories");
    }
  }
  return { schema_version: auditSchema, source: APPROVED_AUDIT_ENDPOINT, advisories };
}

export async function fetchApprovedProductionAudit(request, fetchImpl = fetch) {
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > maximumAuditBytes) throw new Error("production dependency audit request is too large");
  const response = await fetchImpl(APPROVED_AUDIT_ENDPOINT, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(120_000)
  });
  if (!(response instanceof Response) || response.status !== 200) {
    throw new Error(`approved registry audit request failed with HTTP ${response?.status ?? "invalid response"}`);
  }
  const bytes = await readBoundedResponse(response, maximumAuditBytes);
  const bulk = parseStrictJsonDocument(bytes, maximumAuditBytes, "approved registry audit response is not strict JSON");
  return strictProductionAuditFromBulkResponse(bulk, request);
}

async function runApprovedProductionAudit() {
  return await fetchApprovedProductionAudit(enumerateProductionDependencies());
}

function parseOptions(argv) {
  const options = { asOf: new Date().toISOString().slice(0, 10), auditFile: undefined };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--audit-file" && option !== "--as-of") throw new Error(`unknown option: ${option}`);
    if (seen.has(option)) throw new Error(`${option} may be provided only once`);
    seen.add(option);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (option === "--audit-file") options.auditFile = value;
    else options.asOf = value;
    index += 1;
  }
  return options;
}

function ghsaFromApprovedUrl(value, prefix) {
  if (typeof value !== "string") throw new Error(`${prefix} has an invalid URL`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${prefix} has an invalid URL`);
  }
  const match = parsed.pathname.match(
    /^\/advisories\/(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})$/u
  );
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    match === null
  ) {
    throw new Error(`${prefix} does not identify one canonical GitHub advisory`);
  }
  return match[1];
}

function requireBoundedRegistryText(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_000 ||
    value.trim() !== value ||
    hasAsciiControl(value, false)
  ) {
    throw new Error(`${label} must be bounded text without edge whitespace or control characters`);
  }
}

function validateRegistryCwe(value, prefix) {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((entry) => typeof entry !== "string" || !cweIdentifier.test(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${prefix} has invalid CWE metadata`);
  }
}

function validateRegistryCvss(value, prefix) {
  if (!isRecord(value)) throw new Error(`${prefix} has invalid CVSS metadata`);
  const fields = Object.keys(value).sort();
  if (fields.length !== 2 || fields[0] !== "score" || fields[1] !== "vectorString") {
    throw new Error(`${prefix} has invalid CVSS metadata`);
  }
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 10) {
    throw new Error(`${prefix} has invalid CVSS score`);
  }
  if (value.vectorString === null && value.score === 0) return;
  requireBoundedRegistryText(value.vectorString, `${prefix} CVSS vector`);
  if (!/^CVSS:\d\.\d\//u.test(value.vectorString)) throw new Error(`${prefix} has invalid CVSS vector`);
}

function packageNameFromPnpmDescriptor(alias, from, version) {
  if (from === alias) return alias;
  if (typeof from !== "string" || from.length === 0 || from.length > 512) {
    throw new Error(`production dependency ${alias} does not identify its registry package`);
  }
  const versionSuffix = `@${version}`;
  const candidate = from.endsWith(versionSuffix) ? from.slice(0, -versionSuffix.length) : from;
  if (!isPackageName(candidate)) {
    throw new Error(`production dependency ${alias} does not identify its registry package`);
  }
  return candidate;
}

function isApprovedRegistryResolution(value) {
  if (typeof value !== "string") return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "registry.npmjs.org" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.pathname.startsWith("/")
  );
}

async function readBoundedResponse(response, maximumBytes) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const declaredBytes = /^\d+$/u.test(declaredLength) ? Number(declaredLength) : Number.NaN;
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
      void response.body?.cancel("approved registry audit response is too large").catch(() => undefined);
      throw new Error("approved registry audit response is too large");
    }
  }
  if (response.body === null) throw new Error("approved registry audit response has no body");
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("approved registry audit response has invalid bytes");
      if (value.byteLength > maximumBytes - totalBytes || chunks.length >= maximumAuditItems) {
        void reader.cancel("approved registry audit response is too large").catch(() => undefined);
        throw new Error("approved registry audit response is too large");
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The response body is never reused.
    }
  }
  return Buffer.concat(chunks, totalBytes);
}

function parseDate(value, label, errors) {
  if (typeof value !== "string" || !dateOnly.test(value)) {
    errors.push(`${label} must use YYYY-MM-DD`);
    return undefined;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    errors.push(`${label} is not a real calendar date`);
    return undefined;
  }
  return parsed;
}

function requiredText(value, label, errors, minimumLength = 2) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimumLength ||
    value.length > 2_000 ||
    hasAsciiControl(value, false)
  ) {
    errors.push(`${label} must be a bounded string without edge whitespace or control characters`);
    return "";
  }
  return value;
}

function isPackageName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 214 &&
    value.trim() === value &&
    !hasAsciiControl(value, true)
  );
}

function hasAsciiControl(value, includeSpace) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127 || (includeSpace && code === 32)) return true;
  }
  return false;
}

function advisoryKey(advisory, packageName) {
  return `${advisory}\0${packageName}`;
}

function rejectUnknownFields(value, allowed, label, errors) {
  for (const field of Object.keys(value).sort()) {
    if (!allowed.has(field)) errors.push(`${label} contains unknown field ${field}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(filePath, maximumBytes, label) {
  const bytes = fs.readFileSync(filePath);
  return parseStrictJsonDocument(bytes, maximumBytes, `${label} is not strict JSON`);
}

function parseStrictJsonDocument(bytes, maximumBytes, label) {
  if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  try {
    return parseStrictJsonBytes(bytes, {
      maxBytes: maximumBytes,
      maxDepth: 128,
      maxItems: maximumAuditItems,
      maxProperties: maximumAuditItems
    });
  } catch (error) {
    throw new Error(label, { cause: error });
  }
}

function formatStderr(value) {
  if (!(typeof value === "string" || value instanceof Uint8Array)) return "";
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  const excerpt = text.replace(/\s+/gu, " ").trim().slice(0, 500);
  return excerpt.length === 0 ? "" : `: ${excerpt}`;
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    const audit =
      options.auditFile === undefined
        ? await runApprovedProductionAudit()
        : readJson(path.resolve(options.auditFile), maximumAuditBytes, "dependency audit fixture");
    const exceptionDocument = readJson(
      defaultExceptionPath,
      maximumExceptionBytes,
      "dependency advisory exception document"
    );
    const result = evaluateDependencyAdvisoryPolicy(audit, exceptionDocument, options.asOf);
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`dependency advisory policy: ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `dependency advisory policy passed: ${result.actionableCount} High/Critical production advisories; ${result.activeExceptionCount} active exceptions`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`dependency advisory policy: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) void main();
