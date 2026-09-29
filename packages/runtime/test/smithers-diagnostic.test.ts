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

test("workflow process diagnostics drop the runner name from prose but keep paths, file names and URLs", () => {
  const workflowPath = "/work/target/.smithers/workflows/ultrafuzz-run.tsx";
  const agentsUrl = "file:///work/target/.smithers/agents/index.ts";
  const names = `${workflowPath} (${agentsUrl}) from smithers.db; delete .smithers and restart`;
  const docs = "See https://smithers.sh/reference/errors";
  const error = Object.assign(new Error("Command failed"), {
    code: 1,
    stderr: Buffer.from(`smithers could not load ${names} smithers. ${docs}\n`, "utf8")
  });

  const diagnostic = smithersDiagnostic(error, "WORKFLOW_SUBMISSION_FAILED");

  const expected = `workflow runner could not load ${names} workflow runner. ${docs}\n`;
  assert.equal(diagnostic.details?.stderr, expected);
  assert.ok(diagnostic.message.endsWith(`stderr: ${expected.trim()}`), diagnostic.message);
});

test("non-process workflow diagnostics retain their explicit safe message", () => {
  const diagnostic = smithersDiagnostic(new Error("sealed workflow evidence is incomplete"), "WORKFLOW_INVALID");

  assert.equal(diagnostic.message, "sealed workflow evidence is incomplete");
  assert.deepEqual(diagnostic.details, {});
});
