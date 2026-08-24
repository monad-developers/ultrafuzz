import assert from "node:assert/strict";
import test from "node:test";

import { smithersDiagnostic } from "../src/smithers.js";

test("workflow process diagnostics omit command payloads and retain bounded stdio", () => {
  const error = Object.assign(
    new Error(
      'Command failed: /private/runner up /private/workflow --input {"target":"private-payload"} --format json'
    ),
    {
      code: 42,
      stdout: Buffer.from('--input {"target":"private-echoed-payload"} --format json runner stdout detail\n', "utf8"),
      stderr: Buffer.from("runner stderr detail token=sk-private-secret\n", "utf8")
    }
  );

  const diagnostic = smithersDiagnostic(error, "WORKFLOW_LIFECYCLE_FAILED");

  assert.match(diagnostic.message, /workflow runner command failed \(exit 42\)/u);
  assert.match(diagnostic.message, /--input <redacted-input> --format json runner stdout detail/u);
  assert.match(diagnostic.message, /runner stderr detail token=<redacted>/u);
  assert.doesNotMatch(diagnostic.message, /private-(?:workflow|payload|echoed-payload|secret)/u);
  assert.equal(diagnostic.details?.exit_code, 42);
  assert.equal(diagnostic.details?.stdout, "--input <redacted-input> --format json runner stdout detail\n");
  assert.equal(diagnostic.details?.stderr, "runner stderr detail token=<redacted>\n");
});

test("non-process workflow diagnostics retain their explicit safe message", () => {
  const diagnostic = smithersDiagnostic(new Error("sealed workflow evidence is incomplete"), "WORKFLOW_INVALID");

  assert.equal(diagnostic.message, "sealed workflow evidence is incomplete");
  assert.deepEqual(diagnostic.details, {});
});
