import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertRuntimeDocument,
  INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID,
  INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID,
  INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID,
  PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID,
  PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID,
  parseRuntimeDocumentBytes,
  RUNTIME_DOCUMENT_SCHEMA_IDS,
  runtimeSchemaRegistry,
  WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID,
  WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
  WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID,
  type RuntimeDocumentSchemaId
} from "../src/index.js";

const fixtures = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "test/fixtures/runtime-document-schema-fixtures.json"), "utf8")
) as Record<string, Record<string, unknown>>;

test("every retained runtime document has a current positive fixture and rejects legacy or open shapes", () => {
  const registrations = runtimeSchemaRegistry().filter((entry) =>
    (RUNTIME_DOCUMENT_SCHEMA_IDS as readonly string[]).includes(entry.id)
  );
  assert.deepEqual(Object.keys(fixtures).sort(), registrations.map((entry) => entry.filename).sort());

  for (const entry of registrations) {
    const schemaId = entry.id as RuntimeDocumentSchemaId;
    const fixture = structuredClone(fixtures[entry.filename]!);
    assert.equal(assertRuntimeDocument(schemaId, fixture, entry.filename), fixture);
    assert.throws(
      () => assertRuntimeDocument(schemaId, { ...fixture, schema_version: "1.0" }, entry.filename),
      /schema_version/u,
      `${entry.filename} accepted a legacy version`
    );
    assert.throws(
      () => assertRuntimeDocument(schemaId, { ...fixture, legacy: true }, entry.filename),
      /additionalProperties/u,
      `${entry.filename} accepted an unknown field`
    );
    const bytes = Buffer.from(JSON.stringify(fixture), "utf8");
    assert.deepEqual(parseRuntimeDocumentBytes(schemaId, bytes, entry.filename), fixture);
  }
});

test("runtime document semantic gates reject projected duplicates, noncanonical order, and broken chains", () => {
  const baseline = fixture("invariant-suite-baseline.schema.json");
  const baselineFile = (baseline.files as Array<Record<string, unknown>>)[0]!;
  assert.throws(
    () =>
      assertRuntimeDocument(
        INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID,
        {
          ...baseline,
          files: [baselineFile, { ...baselineFile, sha256: "9".repeat(64) }]
        },
        "baseline"
      ),
    /invariant-suite-baseline-path-identity-and-budget/u
  );

  const handoff = fixture("invariant-suite-handoff.schema.json");
  assert.throws(
    () =>
      assertRuntimeDocument(
        INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID,
        { ...handoff, tombstones: ["test/Z.sol", "test/A.sol"] },
        "handoff"
      ),
    /invariant-suite-handoff-identity-order-and-budget/u
  );

  const workspaceSnapshot = fixture("invariant-workspace-snapshot.schema.json");
  const workspaceFile = (workspaceSnapshot.files as Array<Record<string, unknown>>)[0]!;
  assert.throws(
    () =>
      assertRuntimeDocument(
        INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID,
        {
          ...workspaceSnapshot,
          files: [workspaceFile, { ...workspaceFile, sha256: "7".repeat(64) }]
        },
        "workspace snapshot"
      ),
    /invariant-workspace-snapshot-path-identity-and-budget/u
  );

  const pinnedSnapshot = fixture("pinned-submodule-snapshot.schema.json");
  assert.throws(
    () =>
      assertRuntimeDocument(
        PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID,
        { ...pinnedSnapshot, top_level_roots: ["vendor/z", "vendor/a"] },
        "pinned snapshot"
      ),
    /pinned-submodule-snapshot-closure-order-and-budget/u
  );
  assert.throws(
    () =>
      assertRuntimeDocument(
        PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID,
        {
          ...pinnedSnapshot,
          recursive_gitlinks: [
            ...(pinnedSnapshot.recursive_gitlinks as Array<Record<string, unknown>>),
            {
              path: "vendor/dependency/nested/child",
              commit: "f".repeat(40),
              tree: "1".repeat(40)
            }
          ],
          entries: [
            { path: "vendor/dependency", type: "directory", mode: 493 },
            { path: "vendor/dependency/nested", type: "directory", mode: 493 },
            { path: "vendor/dependency/nested/child", type: "directory", mode: 493 },
            {
              path: "vendor/dependency/nested/child/link",
              type: "symlink",
              target: "../../outside-child-repository"
            }
          ]
        },
        "pinned snapshot"
      ),
    /pinned-submodule-snapshot-closure-order-and-budget/u
  );

  const pinnedExpectation = fixture("pinned-submodule-expectation.schema.json");
  assert.throws(
    () =>
      assertRuntimeDocument(
        PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID,
        { ...pinnedExpectation, file_count: 2, entry_count: 1 },
        "pinned expectation"
      ),
    /pinned-submodule-expectation-order-and-accounting/u
  );

  const seal = fixture("workflow-control-integrity.schema.json");
  const executionFile = (seal.execution_files as Array<Record<string, unknown>>)[0]!;
  assert.throws(
    () =>
      assertRuntimeDocument(
        WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID,
        {
          ...seal,
          execution_files: [
            executionFile,
            { ...executionFile, snapshot_path: "controls/tasks.json", sha256: "8".repeat(64) }
          ]
        },
        "seal"
      ),
    /workflow-control-integrity-identity-order/u
  );

  const dependencies = fixture("workflow-execution-dependencies.schema.json");
  assert.throws(
    () =>
      assertRuntimeDocument(
        WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
        {
          ...dependencies,
          issuers: [{ id: "root", snapshot_path: ".", dependencies: { react: "missing" } }]
        },
        "dependencies"
      ),
    /workflow-execution-dependency-closure-and-order/u
  );

  const journal = fixture("workflow-run-link-journal.schema.json");
  const initial = (journal.entries as Array<Record<string, unknown>>)[0]!;
  assert.throws(
    () =>
      assertRuntimeDocument(
        WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID,
        {
          ...journal,
          entries: [
            initial,
            {
              ...initial,
              link_id: "second",
              action: "resume",
              source_workflow_run_id: initial.workflow_run_id,
              source_workflow_link_id: initial.link_id,
              controller_invocation_id: "invocation",
              controller_invoked_at: "2026-08-09T12:00:01.000Z",
              lifecycle_result_event_id: "result",
              lifecycle_result_at: "2026-08-09T12:00:02.000Z"
            }
          ]
        },
        "journal"
      ),
    /workflow-run-link-chain-and-order/u
  );
});

test("strict runtime document parsing rejects duplicate keys before schema validation", () => {
  assert.throws(
    () =>
      parseRuntimeDocumentBytes(
        INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID,
        Buffer.from(
          '{"schema_version":"ultrafuzz.invariant-suite-baseline.v1","schema_version":"duplicate","files":[]}',
          "utf8"
        ),
        "baseline"
      ),
    /duplicate property name/u
  );
});

function fixture(filename: string): Record<string, unknown> {
  return structuredClone(fixtures[filename]!);
}
