import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
  OWASP_SCS_REQUIRED_PATHS,
  defaultReferenceCatalogYaml,
  materializeReferenceArtifacts,
  owaspScsGitTreePaths,
  parseReferenceCatalog,
  parseVulnerabilityDatabaseGitTree,
  snapshotSelectedVulnerabilityDatabaseRecords,
  statusReferenceCatalog,
  syncReferenceCatalog,
  validateVulnerabilityDatabaseDirectory
} from "../src/index.js";
import { fakeGitIsolationEnv, installFakeGit, withProcessEnv } from "./fake-git.js";

const recordPath = "docs/SCWE/SCSVS-AUTH/SCWE-016.md";

test("the shipped OWASP pin yields its complete stable catalog and exact selected sources offline", (t) => {
  const pinned = JSON.parse(
    gunzipSync(fs.readFileSync(new URL("../../test/fixtures/owasp-scs-fefd476b.json.gz", import.meta.url))).toString(
      "utf8"
    )
  ) as {
    repo: string;
    commit: string;
    git_tree: string;
    files: { path: string; mode: string; type: string; git_blob: string; contents: string }[];
  };
  const reference = parseReferenceCatalog(defaultReferenceCatalogYaml()).references["vulnerability-database.owasp-scs"];
  assert.ok(reference);
  assert.equal(reference.repo, pinned.repo);
  assert.equal(reference.commit, pinned.commit);
  const entries = parseVulnerabilityDatabaseGitTree(Buffer.from(pinned.git_tree));
  assert.deepEqual(
    owaspScsGitTreePaths(entries),
    pinned.files.map((file) => file.path)
  );
  assert.equal(pinned.files.length, 159);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-owasp-pin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "upstream");
  for (const file of pinned.files) {
    const bytes = Buffer.from(file.contents);
    const blob = crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(blob, file.git_blob, file.path);
    assert.ok(pinned.git_tree.includes(`${file.mode} ${file.type} ${blob}\t${file.path}\0`));
    const destination = path.join(upstream, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  const catalog = { version: 1 as const, references: { "vulnerability-database.owasp-scs": reference } };
  const cacheRoot = path.join(root, "cache");
  const fake = installFakeGit(root);
  const synced = withProcessEnv(fakeGitIsolationEnv(fake, upstream, "", "ambient"), () =>
    syncReferenceCatalog(catalog, { cacheRoot })
  );
  assert.ok(synced.synced[0]);
  assert.equal(statusReferenceCatalog(root, catalog, { cacheRoot }).ok, true);
  const artifactDir = path.join(root, "artifacts");
  materializeReferenceArtifacts({
    id: "vulnerability-database.owasp-scs",
    catalog,
    artifactDir,
    outputs: [{ path: "vulnerability-db/catalog.json", primary: true }],
    cacheRoot
  });
  const database = validateVulnerabilityDatabaseDirectory(path.join(artifactDir, "vulnerability-db"), reference);
  assert.equal(database.records.length, 156);
  assert.equal(database.catalog.capabilities.length, 11);
  assert.equal(database.catalogSha256, "d0d80cea8aa096938e9ee663a96046c75fa0e93eedbc4d12962dc0d08e8b0c01");
  assert.equal(
    database.catalog.database_aggregate_sha256,
    "ec8f24f50bb6ee35d2333ef1fbefd1fb36d37df1bcb38884a7a3d54704cb17e4"
  );
  for (const record of database.records) {
    assert.deepEqual(record.capabilities.required, []);
    assert.deepEqual(record.capabilities.incompatible, []);
  }
  const selected = snapshotSelectedVulnerabilityDatabaseRecords({
    database,
    classIds: database.records.map((record) => record.id),
    outputDir: path.join(root, "snapshot")
  });
  assert.equal(selected.manifest.selected_records.length, 156);
  for (const record of selected.manifest.selected_records) {
    assert.deepEqual(
      fs.readFileSync(path.join(root, "snapshot", record.artifact_path)),
      fs.readFileSync(path.join(upstream, record.path))
    );
  }
});

function fixture(root: string): void {
  const files = {
    "License.md": "Synthetic license\n",
    "docs/SCWE/index.md": "# Synthetic index\n",
    "docs/SCSVS/scsvs.yaml":
      "groups:\n  - gid: SCSVS-AUTH\n    title: Authorization\n    description: Check authorization boundaries.\n",
    [recordPath]:
      "---\nid: SCWE-016\ntitle: Synthetic authorization weakness\nmappings:\n  scsvs-cg: [SCSVS-AUTH]\nstatus: new\n---\n\n## Description\nA caller can bypass a permission check.\n\n## Remediation\nCheck caller permissions.\n\n## Examples\nSynthetic example.\n"
  };
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), bytes);
  }
}

test("OWASP sync, offline status, materialization and snapshots preserve exact SCWE sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-owasp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "upstream");
  fixture(upstream);
  const reference = parseReferenceCatalog(defaultReferenceCatalogYaml()).references["vulnerability-database.owasp-scs"];
  assert.ok(reference);
  const catalog = { version: 1 as const, references: { "vulnerability-database.owasp-scs": reference } };
  const fake = installFakeGit(root);
  const cacheRoot = path.join(root, "cache");
  const synced = withProcessEnv(fakeGitIsolationEnv(fake, upstream, "", "ambient"), () =>
    syncReferenceCatalog(catalog, { cacheRoot })
  );
  assert.ok(synced.synced[0]);
  const cacheDir = synced.synced[0].cacheDir;
  assert.equal(statusReferenceCatalog(root, catalog, { cacheRoot }).ok, true);
  const database = validateVulnerabilityDatabaseDirectory(cacheDir, reference);
  assert.equal(database.catalog.database_schema_version, 4);
  assert.deepEqual(
    database.catalog.capabilities.map((group) => group.id),
    ["scsvs-auth"]
  );
  const record = database.records[0];
  assert.ok(record);
  assert.equal(record.id, "scwe-016");
  assert.deepEqual(record.capabilities, { required: [], optional: ["scsvs-auth"], incompatible: [] });
  assert.match(record.guidance.detection_guidance, /Check caller permissions/u);
  const artifactDir = path.join(root, "artifacts");
  materializeReferenceArtifacts({
    id: "vulnerability-database.owasp-scs",
    catalog,
    artifactDir,
    outputs: [{ path: "vulnerability-db/catalog.json", primary: true }],
    cacheRoot
  });
  assert.deepEqual(fs.readFileSync(path.join(artifactDir, "vulnerability-db/catalog.json")), database.catalogBytes);
  assert.deepEqual(
    validateVulnerabilityDatabaseDirectory(path.join(artifactDir, "vulnerability-db")).catalogBytes,
    database.catalogBytes
  );
  const outputDir = path.join(root, "snapshot");
  const snapshot = snapshotSelectedVulnerabilityDatabaseRecords({ database, classIds: [record.id], outputDir });
  assert.ok(snapshot.recordPaths[0]);
  assert.deepEqual(fs.readFileSync(snapshot.recordPaths[0]), fs.readFileSync(path.join(upstream, recordPath)));
  assert.equal(snapshot.manifest.files.metadata.path, "License.md");
  assert.equal(snapshot.manifest.source.repo, "OWASP/owasp-scs");
  fs.appendFileSync(path.join(cacheDir, recordPath), "tampered\n");
  assert.equal(statusReferenceCatalog(root, catalog, { cacheRoot }).ok, false);
  fs.copyFileSync(path.join(upstream, recordPath), path.join(cacheDir, recordPath));
  const second = "docs/SCWE/SCSVS-AUTH/SCWE-017.md";
  fs.writeFileSync(
    path.join(cacheDir, second),
    fs.readFileSync(path.join(upstream, recordPath), "utf8").replaceAll("SCWE-016", "SCWE-017")
  );
  assert.equal(statusReferenceCatalog(root, catalog, { cacheRoot }).ok, false);
  fs.unlinkSync(path.join(cacheDir, second));
  fs.unlinkSync(path.join(cacheDir, recordPath));
  assert.equal(statusReferenceCatalog(root, catalog, { cacheRoot }).ok, false);
});

test("OWASP rejects unsafe Git entries and mismatched source identities", (t) => {
  const entries = [...OWASP_SCS_REQUIRED_PATHS, recordPath].map((name) => ({
    path: name,
    mode: "100644",
    type: "blob"
  }));
  assert.deepEqual(owaspScsGitTreePaths(entries), entries.map((entry) => entry.path).sort());
  assert.throws(
    () =>
      owaspScsGitTreePaths(entries.map((entry) => (entry.path === recordPath ? { ...entry, mode: "120000" } : entry))),
    /regular Git blob/u
  );
  assert.throws(() => owaspScsGitTreePaths(entries.slice(1)), /missing License.md/u);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-owasp-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root);
  const file = path.join(root, recordPath);
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, original.replace("id: SCWE-016", "id: SCWE-017"));
  assert.throws(() => validateVulnerabilityDatabaseDirectory(root), /ID\/path mismatch/u);
  fs.writeFileSync(file, original.replace("scsvs-cg: [SCSVS-AUTH]", "scsvs-cg: [SCSVS-UNKNOWN]"));
  assert.throws(() => validateVulnerabilityDatabaseDirectory(root), /unknown or mismatched/u);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(root, "License.md"), file);
  assert.throws(() => validateVulnerabilityDatabaseDirectory(root), /symlink/u);
});

test("vulnerability references require OWASP source paths and reject obsolete database layouts", (t) => {
  const catalog = parseReferenceCatalog(defaultReferenceCatalogYaml());
  const id = "vulnerability-database.owasp-scs";
  const reference = catalog.references[id];
  assert.ok(reference);
  assert.throws(
    () =>
      parseReferenceCatalog(
        JSON.stringify({
          version: 1,
          references: { [id]: { ...reference, paths: ["database.yml", "capabilities.yml", "catalog.json"] } }
        })
      ),
    /must list exactly/u
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-owasp-required-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "database.yml"), "schema_version: 3\n");
  assert.throws(() => validateVulnerabilityDatabaseDirectory(root), /missing vulnerability database file License.md/u);
});

test("OWASP snapshots are repeatable, repair partial writes, and reject conflicts or stale selections", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-owasp-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "upstream");
  fixture(upstream);
  const reference = parseReferenceCatalog(defaultReferenceCatalogYaml()).references["vulnerability-database.owasp-scs"];
  assert.ok(reference);
  const database = validateVulnerabilityDatabaseDirectory(upstream, reference);
  const input = { database, classIds: ["scwe-016"], outputDir: path.join(root, "selected") };
  const result = snapshotSelectedVulnerabilityDatabaseRecords(input);
  const selectedPath = result.recordPaths[0];
  assert.ok(selectedPath);
  const bytes = fs.readFileSync(selectedPath);
  assert.deepEqual(snapshotSelectedVulnerabilityDatabaseRecords(input), result);
  fs.writeFileSync(selectedPath, bytes.subarray(0, 12));
  snapshotSelectedVulnerabilityDatabaseRecords(input);
  assert.deepEqual(fs.readFileSync(selectedPath), bytes);
  fs.writeFileSync(selectedPath, "conflicting content");
  assert.throws(() => snapshotSelectedVulnerabilityDatabaseRecords(input), /conflicting content/u);
  fs.writeFileSync(selectedPath, bytes);
  assert.throws(() => snapshotSelectedVulnerabilityDatabaseRecords({ ...input, classIds: [] }), /unexpected selected/u);
  assert.throws(
    () => snapshotSelectedVulnerabilityDatabaseRecords({ ...input, classIds: ["scwe-016", "scwe-016"] }),
    /duplicate vulnerability class/u
  );
  assert.throws(
    () => snapshotSelectedVulnerabilityDatabaseRecords({ ...input, classIds: ["scwe-999"] }),
    /unknown vulnerability class/u
  );
});
