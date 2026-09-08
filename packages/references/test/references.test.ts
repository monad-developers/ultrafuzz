import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CACHE_MANIFEST_FILE,
  REFERENCE_GITHUB_REPOS_ENV,
  REFERENCE_GITHUB_TOKEN_ENV,
  REFERENCE_TOKEN_REDACTION,
  REFERENCE_CACHE_MANIFEST_JSON_SCHEMA_ID,
  REFERENCE_CACHE_SCHEMA_VERSION,
  RUN_REFERENCE_MANIFEST_FILE,
  defaultReferenceCatalogYaml,
  materializeReferenceArtifacts,
  parseReferenceCatalog,
  referenceCacheManifestJsonSchema,
  referenceSchemaBundleDigest,
  referenceSchemaDirectory,
  referenceSchemaRegistry,
  readCacheManifest,
  serializeReferenceCacheManifest,
  statusReferenceCatalog,
  syncReferenceCatalog,
  updateProjectReferencesLatest
} from "../src/index.js";
import type { ReferenceCacheManifest, ReferenceCatalog, ReferenceEntry, ReferenceManifestFile } from "../src/index.js";
import { fakeGitCommands, fakeGitIsolationEnv, installFakeGit, withProcessEnv } from "./fake-git.js";

const PRIVATE_REFERENCE_TOKEN = "ghs_privatefilteredreferencetoken0123456789"; // gitleaks:allow -- fake credential fixture for the redaction tests
const PRIVATE_REFERENCE_REPO = "example/private-reference";
const PRIVATE_REFERENCE_COMMIT = "cccccccccccccccccccccccccccccccccccccccc";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
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
        schema_version: REFERENCE_CACHE_SCHEMA_VERSION,
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

test("cache manifest reader accepts only the exact current version and canonical shape", () => {
  const cacheRoot = tempDir("ufz-ref-manifest-contract-");
  const cacheDir = writeCacheFixture(cacheRoot);
  const manifestPath = path.join(cacheDir, CACHE_MANIFEST_FILE);
  const canonical = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

  assert.deepEqual(readCacheManifest("properties.example", cacheDir), canonical);

  const { schema_version: _schemaVersion, ...unversioned } = canonical;
  const variants: unknown[] = [
    unversioned,
    { ...canonical, schema_version: "1.0" },
    { ...canonical, legacy: true },
    { ...canonical, fetched_at: "yesterday" },
    { ...canonical, commit: "A".repeat(40) },
    { ...canonical, files: [] },
    {
      ...canonical,
      files: [{ ...((canonical.files as Array<Record<string, unknown>>)[0] ?? {}), legacy_path: "README.md" }]
    }
  ];
  for (const value of variants) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(value)}\n`, "utf8");
    assert.throws(
      () => readCacheManifest("properties.example", cacheDir),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_CACHE_MANIFEST",
      JSON.stringify(value)
    );
  }
});

test("cache manifest semantic gates reject repeated and noncanonical path order", () => {
  const cacheRoot = tempDir("ufz-ref-manifest-semantics-");
  const cacheDir = writeCacheFixture(cacheRoot);
  const manifestPath = path.join(cacheDir, CACHE_MANIFEST_FILE);
  const canonical = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ReferenceCacheManifest;
  const [first, second] = canonical.files;
  assert.ok(first);
  assert.ok(second);

  for (const files of [
    [first, { ...first, size_bytes: first.size_bytes + 1 }],
    [second, first]
  ]) {
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...canonical, files })}\n`, "utf8");
    assert.throws(
      () => readCacheManifest("properties.example", cacheDir),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_CACHE_MANIFEST"
    );
  }
});

test("reference cache schema is registered, byte-pinned, and matches its TypeScript export", () => {
  const registry = referenceSchemaRegistry();
  assert.equal(registry.length, 1);
  const entry = registry[0];
  assert.ok(entry);
  assert.equal(entry.id, REFERENCE_CACHE_MANIFEST_JSON_SCHEMA_ID);
  assert.equal(entry.role, "runtime-state");
  assert.deepEqual(entry.schema, referenceCacheManifestJsonSchema);
  assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
  assert.match(referenceSchemaBundleDigest(), /^[0-9a-f]{64}$/u);
  assert.equal(
    path.resolve(referenceSchemaDirectory(), entry.filename),
    path.resolve(referenceSchemaDirectory(), "reference-cache-manifest.schema.json")
  );
});

test("cache manifest publisher validates the exact serialized bytes", () => {
  const cacheRoot = tempDir("ufz-ref-manifest-publisher-");
  const cacheDir = writeCacheFixture(cacheRoot);
  const manifest = readCacheManifest("properties.example", cacheDir);
  const bytes = serializeReferenceCacheManifest("properties.example", manifest);
  assert.deepEqual(readCacheManifest("properties.example", cacheDir), JSON.parse(bytes.toString("utf8")));

  assert.throws(
    () =>
      serializeReferenceCacheManifest("properties.example", {
        ...manifest,
        schema_version: "1.0" as typeof REFERENCE_CACHE_SCHEMA_VERSION
      }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_CACHE_MANIFEST"
  );
});

test("default catalog restores original pinned property references", () => {
  const catalog = parseReferenceCatalog(defaultReferenceCatalogYaml());

  const ids = Object.keys(catalog.references).sort();
  assert.equal(ids.filter((id) => id.startsWith("properties.")).length, 9);
  assert.deepEqual(
    ids.filter((id) => !id.startsWith("properties.")),
    ["vulnerability-database.owasp-scs"]
  );
  const database = catalog.references["vulnerability-database.owasp-scs"];
  assert.equal(database?.kind, "vulnerability-database");
  assert.equal(database?.repo, "OWASP/owasp-scs");
  assert.equal(database?.commit, "fefd476b83074666ada2d816f103436a18e1ece4");
  assert.deepEqual(database?.paths, ["License.md", "docs/SCSVS/scsvs.yaml", "docs/SCWE/index.md"]);
  assert.equal(database?.resolved_at, "2026-09-08T00:00:00Z");
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

test("private filtered references keep exact credentials for lazy blob reads and isolate ambient Git config", () => {
  const root = tempDir("ufz-ref-private-filtered-");
  const fixtureRoot = path.join(root, "fixture");
  fs.mkdirSync(fixtureRoot);
  fs.writeFileSync(path.join(fixtureRoot, "README.md"), "# Private reference\n", "utf8");
  const fake = installFakeGit(root);
  const basic = Buffer.from(`x-access-token:${PRIVATE_REFERENCE_TOKEN}`, "utf8").toString("base64");
  const expectedHeader = `AUTHORIZATION: basic ${basic}`;
  const ambientSentinel = "ambient-helper-and-header-must-not-run";
  const catalog = fixtureCatalog({
    provider: "github",
    repo: PRIVATE_REFERENCE_REPO,
    commit: PRIVATE_REFERENCE_COMMIT,
    paths: ["README.md"],
    resolved_at: "2026-08-11T00:00:00Z"
  });

  const report = withProcessEnv(
    fakeGitIsolationEnv(fake, fixtureRoot, expectedHeader, ambientSentinel, {
      [REFERENCE_GITHUB_TOKEN_ENV]: PRIVATE_REFERENCE_TOKEN,
      [REFERENCE_GITHUB_REPOS_ENV]: PRIVATE_REFERENCE_REPO
    }),
    () => syncReferenceCatalog(catalog, { cacheRoot: path.join(root, "cache") })
  );

  assert.equal(report.synced[0]?.fetched, true);
  assert.equal(fs.readFileSync(path.join(report.synced[0]!.cacheDir, "README.md"), "utf8"), "# Private reference\n");
  assert.deepEqual(
    fakeGitCommands(fake.logPath).map((args) => args[0]),
    ["init", "remote", "fetch", "cat-file", "show"]
  );
});

test("authenticated lazy-object failures redact raw and encoded credentials", () => {
  const basic = Buffer.from(`x-access-token:${PRIVATE_REFERENCE_TOKEN}`, "utf8").toString("base64");
  const failureText = `rejected token ${PRIVATE_REFERENCE_TOKEN} in AUTHORIZATION: basic ${basic}`;
  for (const command of ["cat-file", "show"]) {
    const root = tempDir(`ufz-ref-private-${command}-failure-`);
    const fixtureRoot = path.join(root, "fixture");
    fs.mkdirSync(fixtureRoot);
    fs.writeFileSync(path.join(fixtureRoot, "README.md"), "# Private reference\n", "utf8");
    const fake = installFakeGit(root);
    let surfaced = "";
    assert.throws(
      () =>
        withProcessEnv(
          fakeGitIsolationEnv(fake, fixtureRoot, `AUTHORIZATION: basic ${basic}`, "ambient-sentinel", {
            [REFERENCE_GITHUB_TOKEN_ENV]: PRIVATE_REFERENCE_TOKEN,
            [REFERENCE_GITHUB_REPOS_ENV]: PRIVATE_REFERENCE_REPO,
            UFZ_FAKE_GIT_FAIL_COMMAND: command,
            UFZ_FAKE_GIT_FAILURE_TEXT: failureText
          }),
          () =>
            syncReferenceCatalog(
              fixtureCatalog({
                provider: "github",
                repo: PRIVATE_REFERENCE_REPO,
                commit: PRIVATE_REFERENCE_COMMIT,
                paths: ["README.md"],
                resolved_at: "2026-08-11T00:00:00Z"
              }),
              { cacheRoot: path.join(root, "cache") }
            )
        ),
      (error: unknown) => {
        surfaced = error instanceof Error ? error.message : String(error);
        return true;
      }
    );
    assert.equal(surfaced.includes(PRIVATE_REFERENCE_TOKEN), false, command);
    assert.equal(surfaced.includes(basic), false, command);
    assert.match(
      surfaced,
      new RegExp(REFERENCE_TOKEN_REDACTION.replaceAll("[", "\\[").replaceAll("]", "\\]"), "u"),
      command
    );
  }
});

test("update-latest ls-remote stays anonymous and isolated for an uncovered repository", () => {
  const project = tempDir("ufz-ref-ls-remote-isolation-");
  const fixtureRoot = path.join(project, "fixture");
  fs.mkdirSync(fixtureRoot);
  const fake = installFakeGit(project);
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".git", "config"),
    `[url "file:///tmp/attacker-selected-reference"]\n  insteadOf = https://github.com/example/public-reference.git\n[http "https://github.com/"]\n  extraHeader = AUTHORIZATION: basic ambient-local-header\n`,
    "utf8"
  );
  fs.mkdirSync(path.join(project, ".ultrafuzz"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "references.yml"),
    `version: 1\nreferences:\n  properties.example:\n    provider: github\n    repo: example/public-reference\n    commit: ${PRIVATE_REFERENCE_COMMIT}\n    paths:\n      - README.md\n    resolved_at: "2026-08-11T00:00:00Z"\n`,
    "utf8"
  );

  const nextCommit = "dddddddddddddddddddddddddddddddddddddddd";
  const previousCwd = process.cwd();
  let updated: ReturnType<typeof updateProjectReferencesLatest>;
  try {
    process.chdir(project);
    updated = withProcessEnv(
      fakeGitIsolationEnv(fake, fixtureRoot, "", "ambient-ls-remote-credential", {
        [REFERENCE_GITHUB_TOKEN_ENV]: PRIVATE_REFERENCE_TOKEN,
        [REFERENCE_GITHUB_REPOS_ENV]: PRIVATE_REFERENCE_REPO,
        UFZ_FAKE_GIT_HEAD: nextCommit,
        UFZ_FAKE_GIT_CALLER_CWD: project
      }),
      () => updateProjectReferencesLatest(project)
    );
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(updated.updated[0]?.newCommit, nextCommit);
  assert.deepEqual(
    fakeGitCommands(fake.logPath).map((args) => args[0]),
    ["ls-remote"]
  );
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
