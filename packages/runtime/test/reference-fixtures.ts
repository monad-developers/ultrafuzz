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
 * The pinned OWASP SCS reference exactly as the shipped `.ultrafuzz/references.yml`
 * declares it. Tests bind their local cache representation to this entry rather than appending a
 * fixture entry, so a catalog edit can never make the "clean scaffold" assertions vacuous.
 */
export const SHIPPED_VULNERABILITY_DATABASE = shippedReference("vulnerability-database.owasp-scs");

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

/** Invented OWASP source records; no upstream prose is copied into the test suite. */
export const VULNERABILITY_DATABASE_FIXTURE_CLASS_ID = "scwe-016" as const;
export const VULNERABILITY_DATABASE_FIXTURE_SOURCE_PATH = "docs/SCWE/SCSVS-AUTH/SCWE-016.md" as const;

export interface UpstreamVulnerabilityDatabaseFixture {
  catalogBytes: Buffer;
  recordBytes: Buffer;
  aggregateSha256: string;
  paths: string[];
}

export function writeUpstreamVulnerabilityDatabaseFixture(root: string): UpstreamVulnerabilityDatabaseFixture {
  const sources: Record<string, string> = {
    "License.md": "Synthetic test license\n",
    "docs/SCWE/index.md": "# Synthetic SCWE index\n",
    "docs/SCSVS/scsvs.yaml":
      "groups:\n  - gid: SCSVS-AUTH\n    title: Authorization\n    description: Review permission checks.\n  - gid: SCSVS-CODE\n    title: Code\n    description: Review code behavior.\n",
    [VULNERABILITY_DATABASE_FIXTURE_SOURCE_PATH]:
      "---\nid: SCWE-016\ntitle: Synthetic authorization weakness\nmappings:\n  scsvs-cg: [SCSVS-AUTH, SCSVS-CODE]\nstatus: new\n---\n\n## Description\nCheck permissions.\n\n## Remediation\nValidate the caller.\n\n## Examples\nCompare credited and debited values.\n"
  };
  for (const [relativePath, contents] of Object.entries(sources)) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  const paths = Object.keys(sources).sort();
  const aggregate = paths.map((name) => {
    const bytes = Buffer.from(sources[name] ?? "");
    return { path: name, sha256: digestFixtureBytes(bytes), size_bytes: bytes.length };
  });
  return {
    catalogBytes: Buffer.from(sources["docs/SCWE/index.md"] ?? ""),
    recordBytes: Buffer.from(sources[VULNERABILITY_DATABASE_FIXTURE_SOURCE_PATH] ?? ""),
    aggregateSha256: digestFixtureBytes(Buffer.from(JSON.stringify(aggregate))),
    paths
  };
}

export function writeShippedVulnerabilityDatabaseCache(xdgCacheHome: string): void {
  const cacheDir = path.join(
    xdgCacheHome,
    "ultrafuzz",
    "references",
    "github",
    "OWASP",
    "owasp-scs",
    "vulnerability-database",
    SHIPPED_VULNERABILITY_DATABASE.commit
  );
  const fixture = writeUpstreamVulnerabilityDatabaseFixture(cacheDir);
  const files = fixture.paths
    .map((relativePath) => fixtureFileDigest(relativePath, fs.readFileSync(path.join(cacheDir, relativePath))))
    .sort((left, right) => left.path.localeCompare(right.path));
  fs.writeFileSync(
    path.join(cacheDir, CACHE_MANIFEST_FILE),
    `${JSON.stringify(
      {
        schema_version: REFERENCE_CACHE_SCHEMA_VERSION,
        provider: "github",
        repo: "OWASP/owasp-scs",
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
