import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exceptionPath = path.join(root, ".github", "dependency-advisory-exceptions.json");
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/u;
const maximumExceptionDays = 90;
const highSeverities = new Set(["high", "critical"]);
const auditSeverities = new Set(["info", "low", "moderate", ...highSeverities]);
const ghsaIdentifier = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/iu;

export function validateManifestDependencySpecs(manifests) {
  const errors = [];
  const workspaceNames = new Set(manifests.map(({ value }) => value.name).filter((name) => typeof name === "string"));
  for (const manifest of manifests) {
    for (const section of dependencySections) {
      const dependencies = manifest.value[section];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies)) {
        errors.push(`${manifest.path} ${section} must be an object`);
        continue;
      }
      for (const [name, specifier] of Object.entries(dependencies).sort(([left], [right]) =>
        left.localeCompare(right)
      )) {
        if (typeof specifier !== "string") {
          errors.push(`${manifest.path} ${section}.${name} must be a string`);
          continue;
        }
        if (workspaceNames.has(name)) {
          if (specifier !== "workspace:*") {
            errors.push(`${manifest.path} ${section}.${name} must use workspace:*`);
          }
        } else if (!exactVersion.test(specifier)) {
          errors.push(`${manifest.path} ${section}.${name} must pin one exact registry version (found ${specifier})`);
        }
      }
    }
  }
  return errors;
}

export function evaluateAuditPolicy(audit, exceptionDocument, asOf) {
  const errors = [];
  const asOfMs = parseDate(asOf, "policy evaluation date", errors);
  if (
    !isRecord(exceptionDocument) ||
    exceptionDocument.schema_version !== "ultrafuzz.dependency-advisory-exceptions.v1"
  ) {
    return ["dependency advisory exceptions use an unsupported schema version"];
  }
  if (!Array.isArray(exceptionDocument.exceptions)) return ["dependency advisory exceptions must be an array"];
  const actionable = parsePnpmAuditAdvisories(audit, errors);
  const exceptions = new Map();
  for (const [index, candidate] of exceptionDocument.exceptions.entries()) {
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
      "expires",
      "owner",
      "tracking_issue",
      "reachability",
      "rationale"
    ]);
    for (const field of Object.keys(candidate)) {
      if (!allowedFields.has(field)) errors.push(`${prefix} contains unknown field ${field}`);
    }
    const advisory = requiredText(candidate.advisory, `${prefix} advisory`, errors);
    const packageName = requiredText(candidate.package, `${prefix} package`, errors);
    const severity = requiredText(candidate.severity, `${prefix} severity`, errors).toLowerCase();
    const status = requiredText(candidate.status, `${prefix} status`, errors);
    const owner = requiredText(candidate.owner, `${prefix} owner`, errors);
    const trackingIssue = requiredText(candidate.tracking_issue, `${prefix} tracking_issue`, errors);
    requiredText(candidate.reachability, `${prefix} reachability`, errors);
    requiredText(candidate.rationale, `${prefix} rationale`, errors);
    const expires = requiredText(candidate.expires, `${prefix} expires`, errors);
    if (!ghsaIdentifier.test(advisory)) {
      errors.push(`${prefix} advisory must be a GHSA identifier`);
    }
    if (!highSeverities.has(severity)) errors.push(`${prefix} severity must be high or critical`);
    if (!new Set(["not-reachable", "risk-accepted"]).has(status)) {
      errors.push(`${prefix} status must be not-reachable or risk-accepted`);
    }
    if (!owner.startsWith("@")) errors.push(`${prefix} owner must be a GitHub login beginning with @`);
    if (!/^#\d+$/u.test(trackingIssue)) errors.push(`${prefix} tracking_issue must be a GitHub issue number`);
    const expiresMs = parseDate(expires, `${prefix} expires`, errors);
    if (asOfMs !== undefined && expiresMs !== undefined) {
      const durationDays = (expiresMs - asOfMs) / 86_400_000;
      if (durationDays < 0) errors.push(`${prefix} expired on ${expires}`);
      if (durationDays > maximumExceptionDays) {
        errors.push(`${prefix} expires more than ${maximumExceptionDays} days after review`);
      }
    }
    const key = `${advisory}\0${packageName}`;
    if (exceptions.has(key)) errors.push(`${prefix} duplicates ${advisory} for ${packageName}`);
    exceptions.set(key, { ...candidate, severity });
  }

  const matchedExceptions = new Set();
  for (const advisory of actionable) {
    const id = String(advisory.github_advisory_id ?? "");
    const packageName = String(advisory.module_name ?? "");
    const severity = String(advisory.severity).toLowerCase();
    const key = `${id}\0${packageName}`;
    const exception = exceptions.get(key);
    if (exception === undefined) {
      errors.push(`unapproved ${severity} production advisory ${id || "<unknown>"} in ${packageName || "<unknown>"}`);
      continue;
    }
    matchedExceptions.add(key);
    if (exception.severity !== severity) {
      errors.push(`exception severity for ${id} in ${packageName} does not match the registry advisory`);
    }
  }
  for (const [key, exception] of exceptions) {
    if (!matchedExceptions.has(key)) {
      errors.push(`stale dependency advisory exception ${exception.advisory} for ${exception.package}`);
    }
  }
  return errors;
}

function parsePnpmAuditAdvisories(audit, errors) {
  if (!isRecord(audit) || !isRecord(audit.advisories)) {
    errors.push("pnpm audit uses an unsupported JSON schema (expected an advisories object)");
    return [];
  }
  const actionable = [];
  for (const [auditId, candidate] of Object.entries(audit.advisories)) {
    const prefix = `pnpm audit advisory ${auditId}`;
    if (!isRecord(candidate)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const severity = typeof candidate.severity === "string" ? candidate.severity.toLowerCase() : "";
    if (!auditSeverities.has(severity)) {
      errors.push(`${prefix} has an invalid severity`);
      continue;
    }
    const advisory = candidate.github_advisory_id;
    const packageName = candidate.module_name;
    if (typeof advisory !== "string" || !ghsaIdentifier.test(advisory)) {
      errors.push(`${prefix} has an invalid GitHub advisory identifier`);
      continue;
    }
    if (
      typeof packageName !== "string" ||
      packageName.length === 0 ||
      packageName.length > 214 ||
      packageName.trim() !== packageName
    ) {
      errors.push(`${prefix} has an invalid package name`);
      continue;
    }
    if (highSeverities.has(severity))
      actionable.push({ ...candidate, github_advisory_id: advisory, module_name: packageName, severity });
  }
  return actionable;
}

function loadWorkspaceManifests() {
  const paths = ["package.json"];
  for (const entry of fs.readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relative = path.posix.join("packages", entry.name, "package.json");
    if (fs.existsSync(path.join(root, relative))) paths.push(relative);
  }
  return paths.sort().map((relative) => ({ path: relative, value: readJson(path.join(root, relative)) }));
}

function loadAudit(options) {
  if (options.auditFile !== undefined) return readJson(path.resolve(options.auditFile));
  const result = spawnSync("pnpm", ["audit", "--prod", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error !== undefined) throw new Error("could not run pnpm audit --prod", { cause: result.error });
  let audit;
  try {
    audit = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`pnpm audit did not return JSON: ${result.stderr.trim()}`, { cause: error });
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`pnpm audit failed with exit code ${result.status}: ${result.stderr.trim()}`);
  }
  return audit;
}

function parseOptions(argv) {
  const options = { asOf: new Date().toISOString().slice(0, 10), auditFile: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--audit-file" && option !== "--as-of") throw new Error(`unknown option: ${option}`);
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

function requiredText(value, label, errors) {
  if (typeof value !== "string" || value.trim() !== value || value.length < 2 || value.length > 2_000) {
    errors.push(`${label} must be a nonempty bounded string without edge whitespace`);
    return "";
  }
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const manifestErrors = validateManifestDependencySpecs(loadWorkspaceManifests());
  const audit = loadAudit(options);
  const auditErrors = evaluateAuditPolicy(audit, readJson(exceptionPath), options.asOf);
  const errors = [...manifestErrors, ...auditErrors];
  if (errors.length > 0) {
    for (const error of errors) console.error(`dependency policy: ${error}`);
    process.exitCode = 1;
    return;
  }
  const advisoryCount = Object.values(audit.advisories ?? {}).filter(
    (advisory) => isRecord(advisory) && highSeverities.has(String(advisory.severity).toLowerCase())
  ).length;
  console.log(`dependency policy passed: exact direct pins; ${advisoryCount} approved high/critical advisories`);
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
