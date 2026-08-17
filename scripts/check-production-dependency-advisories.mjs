import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultExceptionPath = path.join(root, ".github", "dependency-advisory-exceptions.json");
const exceptionSchema = "ultrafuzz.dependency-advisory-exceptions.v1";
const highSeverities = new Set(["high", "critical"]);
const knownSeverities = new Set(["info", "low", "moderate", ...highSeverities]);
const exceptionStatuses = new Set(["not-reachable", "remediation-in-progress", "risk-accepted"]);
const ghsaIdentifier = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/u;
const maximumExceptionDays = 30;
const maximumAuditBytes = 16 * 1024 * 1024;
const maximumExceptionBytes = 1024 * 1024;

export function evaluateDependencyAdvisoryPolicy(audit, exceptionDocument, asOf) {
  const errors = [];
  const asOfMs = parseDate(asOf, "policy evaluation date", errors);
  const advisories = parsePnpmAudit(audit, errors);
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

export function parseAuditCommandResult(result) {
  if (result.error !== undefined) {
    throw new Error(`could not run pnpm audit --prod: ${result.error.message}`, { cause: result.error });
  }
  if (result.status === null) {
    const signal = typeof result.signal === "string" ? ` (${result.signal})` : "";
    throw new Error(`pnpm audit --prod terminated without an exit code${signal}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`pnpm audit --prod failed with exit code ${result.status}${formatStderr(result.stderr)}`);
  }
  if (typeof result.stdout !== "string") {
    throw new Error("pnpm audit --prod did not return text output");
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`pnpm audit --prod did not return valid JSON${formatStderr(result.stderr)}`, { cause: error });
  }
}

function parsePnpmAudit(audit, errors) {
  if (!isRecord(audit) || !isRecord(audit.advisories)) {
    errors.push("pnpm audit uses an unsupported JSON schema (expected an advisories object)");
    return [];
  }

  const expectedCounts = parseAuditMetadata(audit.metadata, errors);
  const observedCounts = { high: 0, critical: 0 };
  const actionable = [];

  for (const [auditId, candidate] of Object.entries(audit.advisories).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const prefix = `pnpm audit advisory ${auditId}`;
    if (!isRecord(candidate)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }

    const severity = typeof candidate.severity === "string" ? candidate.severity.toLowerCase() : "";
    if (!knownSeverities.has(severity)) {
      errors.push(`${prefix} has an invalid severity`);
      continue;
    }
    if (severity === "high" || severity === "critical") observedCounts[severity] += 1;

    const advisory = candidate.github_advisory_id;
    const packageName = candidate.module_name;
    let valid = true;
    if (typeof advisory !== "string" || !ghsaIdentifier.test(advisory)) {
      errors.push(`${prefix} has an invalid GitHub advisory identifier`);
      valid = false;
    }
    if (!isPackageName(packageName)) {
      errors.push(`${prefix} has an invalid package name`);
      valid = false;
    }
    if (!hasProductionFindings(candidate.findings, prefix, errors)) valid = false;

    if (valid && highSeverities.has(severity)) {
      actionable.push({
        github_advisory_id: advisory,
        module_name: packageName,
        severity
      });
    }
  }

  for (const severity of highSeverities) {
    const expected = expectedCounts[severity];
    if (expected !== undefined && expected !== observedCounts[severity]) {
      errors.push(
        `pnpm audit metadata reports ${expected} ${severity} advisories but the advisory map contains ${observedCounts[severity]}`
      );
    }
  }
  return actionable;
}

function parseAuditMetadata(metadata, errors) {
  const counts = { high: undefined, critical: undefined };
  if (!isRecord(metadata) || !isRecord(metadata.vulnerabilities)) {
    errors.push("pnpm audit uses an unsupported JSON schema (expected metadata.vulnerabilities)");
    return counts;
  }
  for (const severity of highSeverities) {
    const value = metadata.vulnerabilities[severity];
    if (!Number.isSafeInteger(value) || value < 0) {
      errors.push(`pnpm audit metadata ${severity} count must be a nonnegative safe integer`);
    } else {
      counts[severity] = value;
    }
  }
  return counts;
}

function hasProductionFindings(findings, prefix, errors) {
  if (!Array.isArray(findings) || findings.length === 0) {
    errors.push(`${prefix} must contain at least one production finding`);
    return false;
  }
  let valid = true;
  for (const [index, finding] of findings.entries()) {
    if (!isRecord(finding) || finding.dev !== false) {
      errors.push(`${prefix} finding ${index + 1} must explicitly be a production dependency`);
      valid = false;
    }
  }
  return valid;
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

function runPnpmAudit() {
  const result = spawnSync("pnpm", ["audit", "--prod", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: maximumAuditBytes,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000
  });
  return parseAuditCommandResult(result);
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(filePath, maximumBytes, label) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function formatStderr(value) {
  if (typeof value !== "string") return "";
  const excerpt = value.replace(/\s+/gu, " ").trim().slice(0, 500);
  return excerpt.length === 0 ? "" : `: ${excerpt}`;
}

function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    const audit =
      options.auditFile === undefined
        ? runPnpmAudit()
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

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
