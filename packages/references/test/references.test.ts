import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CACHE_MANIFEST_FILE,
  RUN_REFERENCE_MANIFEST_FILE,
  defaultReferenceCatalogYaml,
  materializeReferenceArtifacts,
  parseReferenceCatalog,
  statusReferenceCatalog,
  syncReferenceCatalog
} from "../src/index.js";
import type { ReferenceCatalog, ReferenceEntry, ReferenceManifestFile } from "../src/index.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixtureReference(): ReferenceEntry {
  return {
    provider: "github",
    repo: "example/repo",
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    paths: ["README.md", "src/Props.sol"],
    resolved_at: "2026-06-23T00:00:00Z"
  };
}

function fixtureCatalog(reference = fixtureReference()): ReferenceCatalog {
  return {
    version: 1,
    references: {
      "properties.example": reference
    }
  };
}

function writeCacheFixture(cacheRoot: string, reference = fixtureReference()): string {
  const cacheDir = path.join(cacheRoot, "github", "example", "repo", reference.commit);
  const files: ReferenceManifestFile[] = [];
  for (const [relativePath, contents] of [
    ["README.md", "# Reference guide\n\nUse properties.\n"],
    ["src/Props.sol", "contract Props {}\n"]
  ] as const) {
    const filePath = path.join(cacheDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
    files.push({
      path: relativePath,
      size_bytes: fs.statSync(filePath).size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
    });
  }
  fs.writeFileSync(
    path.join(cacheDir, CACHE_MANIFEST_FILE),
    `${JSON.stringify(
      {
        schema_version: "1.0",
        provider: "github",
        repo: reference.repo,
        commit: reference.commit,
        fetched_at: "2026-06-23T00:00:00Z",
        files
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return cacheDir;
}

test("default catalog pins the property references and the reviewed vulnerability database", () => {
  const catalog = parseReferenceCatalog(defaultReferenceCatalogYaml());

  const ids = Object.keys(catalog.references).sort();
  assert.equal(ids.filter((id) => id.startsWith("properties.")).length, 9);
  assert.deepEqual(
    ids.filter((id) => !id.startsWith("properties.")),
    ["vulnerability-database.web3"]
  );
  const database = catalog.references["vulnerability-database.web3"];
  assert.equal(database?.kind, "vulnerability-database");
  assert.equal(database?.repo, "aviggiano/web3-vulnerability-database");
  assert.equal(database?.commit, "fbf00e990b1316879b674e9903548dba452e40d5");
  assert.deepEqual(database?.paths, ["database.yml", "capabilities.yml", "catalog.json"]);
  assert.equal(database?.resolved_at, "2026-08-04T22:33:24Z");
  assert.deepEqual(catalog.references["properties.certora-thinking"]?.paths, [
    "06.Lesson_ThinkingProperties/README.md",
    "06.Lesson_ThinkingProperties/AuctionDemonstration/README.md",
    "06.Lesson_ThinkingProperties/AuctionDemonstration/propertiesList.md",
    "06.Lesson_ThinkingProperties/ThinkingPropertiesExercise/TicketDepot/sanity.spec"
  ]);
  for (const reference of Object.values(catalog.references)) {
    assert.match(reference.commit, /^[0-9a-f]{40}$/u);
  }
});

test("catalog validation rejects short SHAs and traversal paths", () => {
  assert.throws(
    () =>
      parseReferenceCatalog(`version: 1
references:
  properties.bad:
    provider: github
    repo: example/repo
    commit: deadbeef
    paths:
      - README.md
    resolved_at: "2026-06-23T00:00:00Z"
`),
    /40-character SHA/u
  );

  assert.throws(
    () =>
      parseReferenceCatalog(`version: 1
references:
  properties.bad:
    provider: github
    repo: example/repo
    commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    paths:
      - ../README.md
    resolved_at: "2026-06-23T00:00:00Z"
`),
    /relative and traversal-free/u
  );
});

test("repository components cannot traverse the reference cache", () => {
  const project = tempDir("ufz-ref-repo-");
  const cacheRoot = path.join(project, "cache");

  for (const repo of ["./repo", "../repo", "owner/.", "owner/..", "../.."]) {
    assert.throws(
      () =>
        syncReferenceCatalog(fixtureCatalog({ ...fixtureReference(), repo }), {
          cacheRoot
        }),
      /invalid GitHub repo/u
    );
  }

  assert.equal(fs.existsSync(cacheRoot), false);
});

test("status and materialization use the pinned offline cache with digest manifests", () => {
  const project = tempDir("ufz-ref-project-");
  const cacheRoot = path.join(project, "cache");
  const cacheDir = writeCacheFixture(cacheRoot);
  const catalog = fixtureCatalog();

  const status = statusReferenceCatalog(project, catalog, { cacheRoot });
  assert.equal(status.ok, true);
  assert.equal(status.references[0]?.cacheDir, cacheDir);

  const artifactDir = path.join(project, "artifacts", "reference-properties-example");
  const materialized = materializeReferenceArtifacts({
    catalog,
    id: "properties.example",
    artifactDir,
    outputs: [
      { path: "references/example.md", primary: true },
      { path: RUN_REFERENCE_MANIFEST_FILE, primary: false }
    ],
    cacheRoot
  });

  const markdown = fs.readFileSync(materialized.referenceArtifact, "utf8");
  assert.match(markdown, /# Pinned Reference: properties\.example/u);
  assert.match(markdown, /```solidity\ncontract Props/u);
  const manifest = JSON.parse(fs.readFileSync(materialized.manifestArtifact, "utf8")) as {
    reference: string;
    source_files: ReferenceManifestFile[];
    artifacts: ReferenceManifestFile[];
  };
  assert.equal(manifest.reference, "properties.example");
  assert.deepEqual(
    manifest.source_files.map((file) => file.path),
    ["README.md", "src/Props.sol"]
  );
  assert.equal(manifest.artifacts[0]?.path, "references/example.md");
  assert.match(manifest.artifacts[0]?.sha256 ?? "", /^[0-9a-f]{64}$/u);
});

test("digest mismatch blocks status and materialization", () => {
  const project = tempDir("ufz-ref-mismatch-");
  const cacheRoot = path.join(project, "cache");
  const cacheDir = writeCacheFixture(cacheRoot);
  fs.writeFileSync(path.join(cacheDir, "README.md"), "tampered\n", "utf8");
  const catalog = fixtureCatalog();

  const status = statusReferenceCatalog(project, catalog, { cacheRoot });
  assert.equal(status.ok, false);
  assert.match(status.references[0]?.messages.join("\n") ?? "", /digest mismatch/u);
  assert.throws(
    () =>
      materializeReferenceArtifacts({
        catalog,
        id: "properties.example",
        artifactDir: path.join(project, "artifacts", "reference-properties-example"),
        outputs: [
          { path: "references/example.md", primary: true },
          { path: RUN_REFERENCE_MANIFEST_FILE, primary: false }
        ],
        cacheRoot
      }),
    /digest mismatch/u
  );
});
