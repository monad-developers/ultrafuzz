import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CACHE_MANIFEST_FILE,
  defaultReferenceCatalogYaml,
  parseReferenceCatalog,
  REFERENCE_CACHE_SCHEMA_VERSION,
  type ReferenceCatalog
} from "@ultrafuzz/references";

/**
 * The pinned web3 vulnerability database exactly as the shipped `.ultrafuzz/references.yml`
 * declares it. Tests bind their local cache representation to this entry rather than appending a
 * fixture entry, so a catalog edit can never make the "clean scaffold" assertions vacuous.
 */
export const SHIPPED_VULNERABILITY_DATABASE = shippedReference("vulnerability-database.web3");

export function shippedReferenceCatalog(): ReferenceCatalog {
  return parseReferenceCatalog(defaultReferenceCatalogYaml());
}

export function shippedReference(id: string): { repo: string; commit: string; paths: readonly string[] } {
  const entry = shippedReferenceCatalog().references[id];
  assert.ok(entry, `shipped references.yml must define ${id}`);
  return { repo: entry.repo, commit: entry.commit, paths: entry.paths };
}

/**
 * Seeds every shipped document reference with a deterministic local representation so an offline
 * clean-scaffold plan never depends on network state or on an ambient developer cache.
 */
export function writeShippedDocumentReferenceCaches(xdgCacheHome: string, catalog: ReferenceCatalog): void {
  for (const [id, reference] of Object.entries(catalog.references)) {
    if (reference.kind === "vulnerability-database") continue;
    const [owner, repo] = reference.repo.split("/");
    const cacheDir = path.join(xdgCacheHome, "ultrafuzz", "references", "github", owner!, repo!, reference.commit);
    const files = reference.paths
      .map((relativePath) => {
        const filePath = path.join(cacheDir, ...relativePath.split("/"));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const contents = Buffer.from(`# ${id}\n\nOffline fixture for ${relativePath}.\n`);
        fs.writeFileSync(filePath, contents);
        return fixtureFileDigest(relativePath, contents);
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, CACHE_MANIFEST_FILE),
      `${JSON.stringify(
        {
          schema_version: REFERENCE_CACHE_SCHEMA_VERSION,
          provider: "github",
          repo: reference.repo,
          commit: reference.commit,
          fetched_at: "2026-08-04T00:00:00Z",
          files
        },
        null,
        2
      )}\n`
    );
  }
}

/**
 * One invented vulnerability class in the published upstream v1 shape: camelCase `catalog.json`
 * carrying `schemaVersion`/`algorithm`/`aggregateSha256`, dotted record and capability IDs,
 * `sourcePath`/`selectedArtifactPath`, `routing`, `applicability`, `sources`, and `reviewStatus`,
 * plus a class Markdown file with upstream frontmatter and the required upstream sections. No
 * upstream record prose is reproduced here.
 */
export const VULNERABILITY_DATABASE_FIXTURE_CLASS_ID = "accounting.selected-class" as const;
export const VULNERABILITY_DATABASE_FIXTURE_SOURCE_PATH = "classes/accounting/selected-class.md" as const;

export interface UpstreamVulnerabilityDatabaseFixture {
  metadataBytes: Buffer;
  capabilityBytes: Buffer;
  catalogBytes: Buffer;
  recordBytes: Buffer;
  aggregateSha256: string;
  paths: string[];
}

export function upstreamVulnerabilityDatabaseFixture(): UpstreamVulnerabilityDatabaseFixture {
  const source = [
    "---",
    "schemaVersion: 1",
    `id: ${VULNERABILITY_DATABASE_FIXTURE_CLASS_ID}`,
    "title: Selected accounting class",
    "domain: accounting",
    "primaryCategory: accounting.balance",
    "secondaryCategories: []",
    "capabilities:",
    "  required:",
    "    - audit.catalog",
    "  optional:",
    "    - audit.unmodeled",
    "  incompatible: []",
    "attackSurfaces:",
    "  - accounting entrypoint",
    "sources:",
    "  - title: Runtime fixture",
    "    url: https://example.com/runtime-fixture",
    "review:",
    "  status: draft",
    "---",
    "",
    "Invented fixture prose for the selected accounting class.",
    "",
    "## Preconditions",
    "",
    "The fixture capability is present.",
    "",
    "## Broken invariant",
    "",
    "Accounting must remain balanced.",
    "",
    "## Likely impact",
    "",
    "Assets may be misaccounted.",
    "",
    "## Detection guidance",
    "",
    "Inspect balance transitions.",
    "",
    "## False positives and boundaries",
    "",
    "Intentional rounding is excluded.",
    "",
    "## Examples",
    "",
    "Compare credited and debited values.",
    "",
    "## Hunter instructions",
    "",
    "Trace assets through the accounting path.",
    ""
  ].join("\n");
  const metadata = [
    "schema_version: 1",
    "classes: classes/**/*.md",
    "capabilities: capabilities.yml",
    "catalog: catalog.json",
    ""
  ].join("\n");
  const capabilities = [
    "schema_version: 1",
    "capabilities:",
    "  - id: audit.catalog",
    "    title: Audit catalog",
    "    description: The protocol exposes the fixture capability.",
    "  - id: audit.unmodeled",
    "    title: Unmodeled audit capability",
    "    description: The goal planner retains unknown when threat modeling omits this capability.",
    ""
  ].join("\n");
  const recordBytes = Buffer.from(source);
  const capabilityDefinitions = [
    {
      id: "audit.catalog",
      title: "Audit catalog",
      description: "The protocol exposes the fixture capability."
    },
    {
      id: "audit.unmodeled",
      title: "Unmodeled audit capability",
      description: "The goal planner retains unknown when threat modeling omits this capability."
    }
  ];
  const records = [
    {
      id: VULNERABILITY_DATABASE_FIXTURE_CLASS_ID,
      title: "Selected accounting class",
      sourcePath: VULNERABILITY_DATABASE_FIXTURE_SOURCE_PATH,
      selectedArtifactPath: "vulnerability-db/selected/accounting/selected-class.md",
      sha256: digestFixtureBytes(recordBytes),
      bytes: recordBytes.byteLength,
      routing: {
        domain: "accounting",
        primaryCategory: "accounting.balance",
        secondaryCategories: [],
        attackSurfaces: ["accounting entrypoint"]
      },
      applicability: { required: ["audit.catalog"], optional: ["audit.unmodeled"], incompatible: [] },
      sources: [{ title: "Runtime fixture", url: "https://example.com/runtime-fixture" }],
      reviewStatus: "draft"
    }
  ];
  const catalog = {
    schemaVersion: 1,
    algorithm: "sha256",
    aggregateSha256: upstreamFixtureAggregateSha256(capabilityDefinitions, records),
    capabilities: capabilityDefinitions,
    records
  };
  return {
    metadataBytes: Buffer.from(metadata),
    capabilityBytes: Buffer.from(capabilities),
    catalogBytes: Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`),
    recordBytes,
    aggregateSha256: catalog.aggregateSha256,
    paths: ["capabilities.yml", "catalog.json", VULNERABILITY_DATABASE_FIXTURE_SOURCE_PATH, "database.yml"]
  };
}

/**
 * Independent reimplementation of the upstream aggregate digest: canonical
 * schemaVersion/algorithm/capabilities/records JSON plus a trailing newline, excluding the aggregate
 * field. It keeps the fixture bound to the digest contract the reference boundary recomputes.
 */
function upstreamFixtureAggregateSha256(capabilities: unknown[], records: unknown[]): string {
  return digestFixtureBytes(
    Buffer.from(`${JSON.stringify({ schemaVersion: 1, algorithm: "sha256", capabilities, records })}\n`)
  );
}

export function writeUpstreamVulnerabilityDatabaseFixture(root: string): UpstreamVulnerabilityDatabaseFixture {
  const fixture = upstreamVulnerabilityDatabaseFixture();
  fs.mkdirSync(path.join(root, "classes", "accounting"), { recursive: true });
  fs.writeFileSync(path.join(root, "database.yml"), fixture.metadataBytes);
  fs.writeFileSync(path.join(root, "capabilities.yml"), fixture.capabilityBytes);
  fs.writeFileSync(path.join(root, "catalog.json"), fixture.catalogBytes);
  fs.writeFileSync(path.join(root, VULNERABILITY_DATABASE_FIXTURE_SOURCE_PATH), fixture.recordBytes);
  return fixture;
}

export function writeShippedVulnerabilityDatabaseCache(xdgCacheHome: string): void {
  const cacheDir = path.join(
    xdgCacheHome,
    "ultrafuzz",
    "references",
    "github",
    "aviggiano",
    "web3-vulnerability-database",
    "vulnerability-database",
    SHIPPED_VULNERABILITY_DATABASE.commit
  );
  const fixture = writeUpstreamVulnerabilityDatabaseFixture(cacheDir);
  const files = fixture.paths.map((relativePath) =>
    fixtureFileDigest(relativePath, fs.readFileSync(path.join(cacheDir, ...relativePath.split("/"))))
  );
  fs.writeFileSync(
    path.join(cacheDir, CACHE_MANIFEST_FILE),
    `${JSON.stringify(
      {
        schema_version: REFERENCE_CACHE_SCHEMA_VERSION,
        provider: "github",
        repo: "aviggiano/web3-vulnerability-database",
        commit: SHIPPED_VULNERABILITY_DATABASE.commit,
        fetched_at: "2026-08-04T00:00:00Z",
        files
      },
      null,
      2
    )}\n`
  );
}

export function fixtureFileDigest(
  filePath: string,
  contents: Buffer
): { path: string; size_bytes: number; sha256: string } {
  return { path: filePath, size_bytes: contents.byteLength, sha256: digestFixtureBytes(contents) };
}

export function digestFixtureBytes(contents: Buffer): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}
