import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EVENT_RECORD_JSON_SCHEMA_ID,
  EVENT_RECORD_TYPES,
  appendEvent,
  assertEventRecord,
  createRunLayout,
  eventRecordSchema,
  replayEvents,
  validateRegisteredJsonSchema
} from "../src/index.js";

const EVENT_ID = `evt-${"a".repeat(24)}`;
const TIMESTAMP = "2026-08-09T00:00:00.000Z";
const LINK_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_LINK_ID = "00000000-0000-4000-8000-000000000002";
const SHA256 = "b".repeat(64);

function event(
  eventType: (typeof EVENT_RECORD_TYPES)[number],
  status: string,
  payload: Record<string, unknown>,
  nodeId?: string
): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.event-record.v2",
    event_id: EVENT_ID,
    timestamp: TIMESTAMP,
    run_id: "run-1",
    event_type: eventType,
    ...(nodeId === undefined ? {} : { node_id: nodeId }),
    status,
    payload
  };
}

const outputContract = {
  path: "report.md",
  contract: "ultrafuzz/text@1",
  contract_digest: SHA256,
  primary: true
};

const validVariantFixtures: Record<string, Record<string, unknown>> = Object.fromEntries(
  [
    event(
      "reference-materialized",
      "succeeded",
      {
        reference: "reference-1",
        repo: "owner/repository",
        commit: "c".repeat(40),
        artifact: "/tmp/reference.md",
        manifest: "/tmp/reference-manifest.json"
      },
      "reference-node"
    ),
    event("run-recovered", "succeeded", {
      recovery_id: LINK_ID,
      prior_status: "failed",
      failed_nodes: [
        {
          node_id: "node-1",
          workflow_task_id: "node:node-1",
          failed_attempt: 1,
          failure_category: "agent-failure"
        }
      ]
    }),
    event("workflow-deadline-exceeded", "timed-out", {
      workflow_run_id: "workflow-1",
      deadline_at: TIMESTAMP
    }),
    event("workflow-synced", "running", {
      workflow_run_id: "workflow-1",
      workflow_status: "running",
      workflow_state: "running",
      synced_nodes: 2,
      accounting_available: true,
      recovery_due: false,
      deadline_exceeded: false
    }),
    event("workflow-failure-unattributed", "failed", {
      workflow_run_id: "workflow-1",
      workflow_state: "failed",
      failed_workflow_tasks: ["task-1"],
      durable_node_statuses: ["running"]
    }),
    event(
      "node-synced",
      "succeeded",
      {
        workflow_run_id: "workflow-1",
        workflow_task_id: "task-1",
        previous_status: "running",
        workflow_state: "finished",
        attempt: 1
      },
      "node-1"
    ),
    event("node-artifacts-verified", "succeeded", { output_contracts: [outputContract], missing: [] }, "node-1"),
    event("node-artifacts-missing", "failed", { output_contracts: [outputContract], missing: ["report.md"] }, "node-1"),
    event(
      "node-controller-refinalization-intent",
      "running",
      {
        operation_id: SHA256,
        workflow_run_id: "workflow-1",
        workflow_link_id: LINK_ID,
        control_generation: SHA256,
        controller_generation: SHA256,
        verifier_task_id: "node:node-1:verify",
        verifier_iteration: 0,
        verifier_attempt: 1,
        marker_sha256: SHA256,
        marker_size_bytes: 128,
        prior_status: "failed"
      },
      "node-1"
    ),
    event(
      "node-controller-refinalization-result",
      "succeeded",
      {
        operation_id: SHA256,
        workflow_run_id: "workflow-1",
        workflow_link_id: LINK_ID,
        control_generation: SHA256,
        controller_generation: SHA256,
        verifier_task_id: "node:node-1:verify",
        verifier_iteration: 0,
        verifier_attempt: 1,
        marker_sha256: SHA256,
        marker_size_bytes: 128,
        prior_status: "failed",
        result: "succeeded",
        artifact_manifest_sha256: SHA256
      },
      "node-1"
    ),
    event("findings-validated", "succeeded", { path: "artifacts/node-1/findings.json", count: 1 }, "node-1"),
    event(
      "artifact-manifest-written",
      "succeeded",
      { file_count: 1, path: "artifacts/node-1/artifact-manifest.json" },
      "node-1"
    ),
    event("materialize-selection", "dry-run", {
      audit_path: "materialize-audit.jsonl",
      mode: "dry-run",
      unstaged: true,
      copies: [{ source: "report.md", destination: "reports/report.md", size_bytes: 10, sha256: SHA256 }],
      patches: []
    }),
    event("workflow-link-recorded", "pending", {
      workflow_link_id: LINK_ID,
      action: "start",
      workflow_run_id: "workflow-1",
      control_generation: SHA256
    }),
    event("workflow-controller-generation-recorded", "failed", {
      workflow_run_id: "workflow-1",
      workflow_link_id: LINK_ID,
      control_generation: SHA256,
      controller_generation: "b".repeat(64),
      previous_controller_generation: SHA256,
      manifest_sha256: "c".repeat(64),
      semantic_fingerprint: "d".repeat(64),
      sequence: 1
    }),
    event("workflow-cancel-confirmed", "canceled", {
      action: "cancel",
      workflow_run_id: "workflow-1",
      confirmed: true
    }),
    event("workflow-cancel-requested", "running", {
      action: "cancel",
      workflow_run_id: "workflow-1",
      confirmed: false
    }),
    event("workflow-compiled", "succeeded", {
      workflow_run_id: "workflow-1",
      workflow_name: "ultrafuzz-run-1",
      control_generation: SHA256,
      workflow_link_id: LINK_ID,
      task_count: 3,
      workflow_path: "smithers/workflow.tsx"
    }),
    event("workflow-submitting", "running", {
      workflow_run_id: "workflow-1",
      workflow_name: "ultrafuzz-run-1",
      control_generation: SHA256,
      workflow_link_id: LINK_ID,
      action: "start"
    }),
    event("workflow-submitted", "running", {
      workflow_run_id: "workflow-1",
      control_generation: SHA256,
      workflow_link_id: LINK_ID,
      controller_invocation_id: EVENT_ID,
      controller_invoked_at: TIMESTAMP
    }),
    event("workflow-submit-failed", "failed", {
      code: "WORKFLOW_SUBMISSION_FAILED",
      message: "submission failed",
      severity: "error",
      source: "workflow",
      details: { exit_code: 1, signal: "SIGTERM", killed: false, stdout: "", stderr: "failure" }
    }),
    event("workflow-lifecycle-already-paused", "paused", {
      action: "pause",
      workflow_run_id: "workflow-1"
    }),
    event("workflow-pause-requested", "running", { action: "pause", workflow_run_id: "workflow-1" }),
    event("workflow-lifecycle-invoking", "running", {
      action: "resume",
      workflow_run_id: "workflow-1",
      control_generation: SHA256,
      workflow_link_id: LINK_ID
    }),
    event("workflow-lifecycle-result", "running", {
      action: "replay",
      source_workflow_run_id: "workflow-1",
      source_workflow_link_id: SOURCE_LINK_ID,
      workflow_run_id: "workflow-2",
      control_generation: SHA256,
      controller_invocation_id: EVENT_ID,
      controller_invoked_at: TIMESTAMP
    }),
    event("workflow-lifecycle-already-running", "running", {
      action: "resume",
      workflow_run_id: "workflow-1",
      workflow_link_id: LINK_ID,
      control_generation: SHA256,
      controller_invocation_id: EVENT_ID,
      controller_invoked_at: TIMESTAMP,
      reset_node: "node-1"
    }),
    event("workflow-lifecycle-submitted", "running", {
      action: "fork",
      workflow_run_id: "workflow-2",
      workflow_link_id: LINK_ID,
      control_generation: SHA256,
      controller_invocation_id: EVENT_ID,
      controller_invoked_at: TIMESTAMP,
      recovered_missing_workflow_run: true
    })
  ].map((fixture) => [fixture.event_type as string, fixture])
);

function assertParity(value: unknown, expected: boolean, label: string): void {
  const ajv = validateRegisteredJsonSchema(EVENT_RECORD_JSON_SCHEMA_ID, value);
  const zod = eventRecordSchema.safeParse(value);
  assert.equal(ajv.ok, expected, `${label}: Ajv ${JSON.stringify(ajv.issues)}`);
  assert.equal(zod.success, expected, `${label}: Zod disagreed with Ajv`);
  if (zod.success) assert.deepEqual(zod.data, value, `${label}: Zod transformed the event record`);
}

test("event-record v2 enumerates every production event as a closed Ajv/Zod union", () => {
  assert.equal(EVENT_RECORD_TYPES.length, 27);
  assert.deepEqual(Object.keys(validVariantFixtures).sort(), [...EVENT_RECORD_TYPES].sort());

  for (const eventType of EVENT_RECORD_TYPES) {
    const fixture = validVariantFixtures[eventType]!;
    assertParity(fixture, true, `${eventType}:valid`);

    assertParity({ ...fixture, provenance: {} }, false, `${eventType}:top-level provenance`);
    assertParity({ ...fixture, status: "unsupported-status" }, false, `${eventType}:status`);

    const payload = fixture.payload as Record<string, unknown>;
    assertParity({ ...fixture, payload: { ...payload, unsupported: true } }, false, `${eventType}:payload extra`);
    const firstPayloadField = Object.keys(payload)[0];
    assert.ok(firstPayloadField !== undefined);
    const missingPayloadField = { ...payload };
    delete missingPayloadField[firstPayloadField];
    assertParity({ ...fixture, payload: missingPayloadField }, false, `${eventType}:payload required`);

    if ("node_id" in fixture) {
      const missingNodeId = { ...fixture };
      delete missingNodeId.node_id;
      assertParity(missingNodeId, false, `${eventType}:node required`);
    } else {
      assertParity({ ...fixture, node_id: "node-1" }, false, `${eventType}:node forbidden`);
    }
  }
});

test("event-record v2 types every array item and rejects old or generic envelopes", () => {
  const unattributed = structuredClone(validVariantFixtures["workflow-failure-unattributed"]!);
  (unattributed.payload as Record<string, unknown>).failed_workflow_tasks = [1];
  assertParity(unattributed, false, "unattributed task array items");

  const artifacts = structuredClone(validVariantFixtures["node-artifacts-verified"]!);
  (artifacts.payload as Record<string, unknown>).output_contracts = [{}];
  assertParity(artifacts, false, "output contract array items");

  const materialize = structuredClone(validVariantFixtures["materialize-selection"]!);
  (materialize.payload as Record<string, unknown>).copies = ["report.md"];
  assertParity(materialize, false, "materialize copy array items");

  assertParity(
    { ...validVariantFixtures["workflow-synced"], schema_version: "ultrafuzz.event-record.v1" },
    false,
    "v1"
  );
  assertParity({ ...validVariantFixtures["workflow-synced"], schema_version: "1.0" }, false, "version alias");
  assertParity({ ...validVariantFixtures["workflow-synced"], event_type: "generic-event" }, false, "generic event");

  const workflowStatusAlias = structuredClone(validVariantFixtures["workflow-synced"]!);
  (workflowStatusAlias.payload as Record<string, unknown>).workflow_status = "in-progress";
  assertParity(workflowStatusAlias, false, "workflow status alias");
  const workflowStateAlias = structuredClone(validVariantFixtures["workflow-synced"]!);
  (workflowStateAlias.payload as Record<string, unknown>).workflow_state = "timed-out";
  assertParity(workflowStateAlias, false, "workflow run-state alias");
  const nodeStateAlias = structuredClone(validVariantFixtures["node-synced"]!);
  (nodeStateAlias.payload as Record<string, unknown>).workflow_state = "retrying";
  assertParity(nodeStateAlias, false, "workflow node-state alias");
  const unattributedAlias = structuredClone(validVariantFixtures["workflow-failure-unattributed"]!);
  (unattributedAlias.payload as Record<string, unknown>).workflow_state = "error";
  assertParity(unattributedAlias, false, "unattributed workflow-state alias");
  assert.throws(
    () => assertEventRecord({ ...validVariantFixtures["workflow-synced"], payload: {} }),
    /event record schema validation failed/u
  );
});

test("event replay and append reject schema-invalid present records without changing their bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-event-v2-"));
  const layout = createRunLayout({ projectRoot: root, runId: "run-1" });
  const oldRecord = {
    ...validVariantFixtures["workflow-synced"],
    schema_version: "ultrafuzz.event-record.v1"
  };
  fs.writeFileSync(layout.eventsPath, `${JSON.stringify(oldRecord)}\n`, "utf8");
  const before = fs.readFileSync(layout.eventsPath);

  assert.throws(() => replayEvents(layout), /event record schema validation failed/u);
  assert.throws(
    () =>
      appendEvent(layout, {
        eventType: "workflow-synced",
        status: "running",
        timestamp: "2026-08-09T00:01:00.000Z",
        payload: {
          workflow_run_id: "workflow-1",
          workflow_status: "running",
          workflow_state: "running",
          synced_nodes: 1,
          accounting_available: true,
          recovery_due: false,
          deadline_exceeded: false
        }
      }),
    /event record schema validation failed/u
  );
  assert.deepEqual(fs.readFileSync(layout.eventsPath), before);
});
