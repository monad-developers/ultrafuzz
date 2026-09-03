import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeDiagnostic } from "../src/types.js";
import {
  describeObservationSynchronizationDeadline,
  observationSynchronizationDeadline
} from "../src/workflow-sync.js";

const NOW_MS = Date.parse("2026-07-31T12:00:00.000Z");
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

function deadline(value: string | undefined): number | undefined {
  return observationSynchronizationDeadline(
    value === undefined ? {} : { ULTRAFUZZ_OBSERVATION_SYNC_TIMEOUT_MS: value },
    NOW_MS
  );
}

test("observationSynchronizationDeadline defaults to 15 seconds after now", () => {
  assert.equal(deadline(undefined), NOW_MS + DEFAULT_TIMEOUT_MS);
});

test("observationSynchronizationDeadline honors an explicit positive override", () => {
  assert.equal(deadline("1"), NOW_MS + 1);
  assert.equal(deadline("2500"), NOW_MS + 2_500);
  assert.equal(deadline("59999"), NOW_MS + 59_999);
});

test("observationSynchronizationDeadline caps positive overrides at 60 seconds", () => {
  assert.equal(deadline("60000"), NOW_MS + MAX_TIMEOUT_MS);
  assert.equal(deadline("60001"), NOW_MS + MAX_TIMEOUT_MS);
  assert.equal(deadline("600000"), NOW_MS + MAX_TIMEOUT_MS);
});

test("observationSynchronizationDeadline falls back to the default for invalid overrides", () => {
  for (const value of ["", " 15", "15 ", "abc", "-1", "1.5", "1e3", "0x10", "00", "+5", "9007199254740993"]) {
    assert.equal(deadline(value), NOW_MS + DEFAULT_TIMEOUT_MS, JSON.stringify(value));
  }
});

test("observationSynchronizationDeadline is disabled by 0 or off", () => {
  for (const value of ["0", "off", "OFF", "Off"]) {
    assert.equal(deadline(value), undefined, JSON.stringify(value));
  }
});

test("describeObservationSynchronizationDeadline explains stale state and names the override", () => {
  const exceeded: RuntimeDiagnostic = {
    code: "WORKFLOW_SYNC_DEADLINE_EXCEEDED",
    message: "workflow synchronization reached its overall deadline at a synchronization checkpoint",
    severity: "warning",
    source: "workflow"
  };
  const described = describeObservationSynchronizationDeadline(exceeded);
  assert.equal(described.code, "WORKFLOW_SYNC_DEADLINE_EXCEEDED");
  assert.equal(described.severity, "warning");
  assert.equal(described.source, "workflow");
  assert.ok(described.message.startsWith(exceeded.message), described.message);
  assert.match(described.message, /local run state and counts may be stale/u);
  assert.match(described.message, /ULTRAFUZZ_OBSERVATION_SYNC_TIMEOUT_MS=off/u);
  // The input diagnostic is not mutated.
  assert.equal(
    exceeded.message,
    "workflow synchronization reached its overall deadline at a synchronization checkpoint"
  );

  const cancelled: RuntimeDiagnostic = {
    code: "WORKFLOW_SYNC_CANCELLED",
    message: "workflow synchronization was cancelled at a synchronization checkpoint",
    severity: "error",
    source: "workflow"
  };
  assert.deepEqual(describeObservationSynchronizationDeadline(cancelled), cancelled);
});
