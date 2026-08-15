import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, ".github", "package-provenance-baseline.json");
const maximumMetadataBytes = 2 * 1024 * 1024;

export function normalizeRegistryMetadata(metadata, expectedName, expectedVersion) {
  if (!isRecord(metadata) || metadata.name !== expectedName || metadata.version !== expectedVersion) {
    throw new Error(`registry metadata identity mismatch for ${expectedName}@${expectedVersion}`);
  }
  const npmUser = person(metadata._npmUser);
  const trustedPublisher = isRecord(metadata._npmUser?.trustedPublisher)
    ? {
        id: requiredString(metadata._npmUser.trustedPublisher.id, "trusted publisher id"),
        oidc_config_id: requiredString(
          metadata._npmUser.trustedPublisher.oidcConfigId,
          "trusted publisher OIDC config ID"
        )
      }
    : null;
  const maintainers = Array.isArray(metadata.maintainers)
    ? metadata.maintainers.map(person).sort((left, right) => identity(left).localeCompare(identity(right)))
    : [];
  const repository =
    typeof metadata.repository === "string"
      ? metadata.repository
      : isRecord(metadata.repository) && typeof metadata.repository.url === "string"
        ? metadata.repository.url
        : null;
  const signatures = Array.isArray(metadata.dist?.signatures) ? metadata.dist.signatures : [];
  return {
    version: expectedVersion,
    publisher: { ...npmUser, trusted_publisher: trustedPublisher },
    maintainers,
    repository,
    integrity: requiredString(metadata.dist?.integrity, "package integrity"),
    signature_key_ids: [
      ...new Set(signatures.map((signature) => requiredString(signature?.keyid, "signature key ID")))
    ].sort(),
    provenance_predicate:
      typeof metadata.dist?.attestations?.provenance?.predicateType === "string"
        ? metadata.dist.attestations.provenance.predicateType
        : null
  };
}

export function comparePackageProvenance(expected, actual, packageName) {
  const drift = [];
  for (const field of [
    "version",
    "publisher",
    "maintainers",
    "repository",
    "integrity",
    "signature_key_ids",
    "provenance_predicate"
  ]) {
    if (JSON.stringify(expected[field]) !== JSON.stringify(actual[field])) {
      drift.push({ package: packageName, field, expected: expected[field], actual: actual[field] });
    }
  }
  return drift;
}

async function registryMetadata(packageName, version) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
  const bytes = await readBoundedResponseBytes(response, maximumMetadataBytes);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function readBoundedResponseBytes(response, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("response limit is invalid");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) throw new Error("registry metadata has an invalid Content-Length");
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("registry metadata exceeds the response limit");
    }
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let byteCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maximumBytes) {
        await reader.cancel("registry metadata exceeds the response limit").catch(() => undefined);
        throw new Error("registry metadata exceeds the response limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function reportPath(argv) {
  if (argv.length === 0) return path.join(root, ".ultrafuzz", "package-provenance.report.json");
  if (argv.length !== 2 || argv[0] !== "--report") throw new Error("usage: check-package-provenance [--report PATH]");
  const target = path.resolve(root, argv[1]);
  const relative = path.relative(root, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("package provenance report must remain inside the repository");
  }
  return target;
}

async function main() {
  const outputPath = reportPath(process.argv.slice(2));
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  if (!isRecord(baseline) || baseline.schema_version !== "ultrafuzz.package-provenance-baseline.v1") {
    throw new Error("package provenance baseline uses an unsupported schema");
  }
  if (!isRecord(baseline.packages) || Object.keys(baseline.packages).length !== 4) {
    throw new Error("package provenance baseline must name the four critical packages");
  }

  const observations = {};
  const drift = [];
  await Promise.all(
    Object.entries(baseline.packages).map(async ([packageName, expected]) => {
      try {
        if (!isRecord(expected)) throw new Error("baseline entry must be an object");
        const version = requiredString(expected.version, "baseline package version");
        const actual = normalizeRegistryMetadata(await registryMetadata(packageName, version), packageName, version);
        observations[packageName] = { status: "observed", value: actual };
        drift.push(...comparePackageProvenance(expected, actual, packageName));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        observations[packageName] = { status: "error", error: message };
        drift.push({ package: packageName, field: "registry_observation", expected: "available", actual: message });
      }
    })
  );

  drift.sort((left, right) => `${left.package}\0${left.field}`.localeCompare(`${right.package}\0${right.field}`));
  const report = {
    schema_version: "ultrafuzz.package-provenance-report.v1",
    generated_at: new Date().toISOString(),
    status: drift.length === 0 ? "stable" : "drift",
    observations: Object.fromEntries(Object.entries(observations).sort(([left], [right]) => left.localeCompare(right))),
    drift
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`package provenance report: ${path.relative(root, outputPath)} (${report.status})`);
  if (drift.length > 0) {
    for (const item of drift) console.error(`package provenance drift: ${item.package} ${item.field}`);
    process.exitCode = 1;
  }
}

function person(value) {
  if (!isRecord(value)) throw new Error("registry identity must be an object");
  return {
    name: requiredString(value.name, "registry identity name"),
    email: requiredString(value.email, "registry identity email")
  };
}

function identity(value) {
  return `${value.name}\0${value.email}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) throw new Error(`${label} is invalid`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
