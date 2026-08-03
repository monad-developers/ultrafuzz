import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_POSTFLIGHT_FAILURE_CODES,
  AgentPostflightError,
  agentPostflightFailureCode,
  runAgentWithPostflight
} from "../src/agent-postflight.js";

test("agent postflight failures retain successful provider usage and their original cause", async () => {
  const cause = new Error("artifact detail that remains internal");
  const usage = Object.freeze({ inputTokens: 11, outputTokens: 7 });
  const error = await capturedFailure(
    runAgentWithPostflight(
      async () => Object.freeze({ usage }),
      async (_result, postflight) => postflight("artifact-validation-postflight", async () => Promise.reject(cause))
    )
  );

  assert.ok(error instanceof AgentPostflightError);
  assert.equal(error.code, "artifact-validation-postflight");
  assert.equal(error.cause, cause);
  assert.equal(error.usage, usage);
  assert.deepEqual(error.details, { failureRetryable: false });
  assert.equal(agentPostflightFailureCode(error), "artifact-validation-postflight");
  assert.equal(Object.getOwnPropertyDescriptor(error, "details")?.enumerable, true);
  assert.equal(Object.getOwnPropertyDescriptor(error, "details")?.writable, false);
  assert.equal(Object.isFrozen(error.details), true);
  assert.equal(Object.getOwnPropertyDescriptor(error, "usage")?.writable, false);
});

test("agent postflight usage capture tolerates immutable results and exotic getters", async () => {
  const fallbackUsage = Object.freeze({ inputTokens: 19, outputTokens: 5 });
  const result = Object.freeze(
    Object.defineProperties(
      {},
      {
        usage: {
          enumerable: true,
          get: () => {
            throw new Error("exotic usage getter");
          }
        },
        totalUsage: { enumerable: true, get: () => fallbackUsage }
      }
    )
  );
  const error = await capturedFailure(
    runAgentWithPostflight(
      async () => result,
      async (_value, postflight) =>
        postflight("final-report-materialization-postflight", () => assert.fail("invalid artifact"))
    )
  );

  assert.ok(error instanceof AgentPostflightError);
  assert.equal(error.usage, fallbackUsage);

  const inaccessible = Object.freeze(
    Object.defineProperties(
      {},
      {
        usage: { get: () => assert.fail("usage unavailable") },
        totalUsage: { get: () => assert.fail("total usage unavailable") }
      }
    )
  );
  const inaccessibleError = await capturedFailure(
    runAgentWithPostflight(
      async () => inaccessible,
      async (_value, postflight) => postflight("artifact-preparation-postflight", () => assert.fail("prepare failed"))
    )
  );
  assert.ok(inaccessibleError instanceof AgentPostflightError);
  assert.equal(inaccessibleError.usage, undefined);
});

test("agent postflight boundary preserves ordinary provider failures unchanged", async () => {
  const providerError = Object.assign(new Error("provider failed"), { usage: { inputTokens: 3 } });
  let postflightCalled = false;
  const error = await capturedFailure(
    runAgentWithPostflight(
      async () => Promise.reject(providerError),
      () => {
        postflightCalled = true;
      }
    )
  );

  assert.equal(error, providerError);
  assert.equal(postflightCalled, false);
  assert.equal(agentPostflightFailureCode(error), undefined);
});

test("agent postflight parser recognizes only allowlisted bounded stage markers", () => {
  for (const code of AGENT_POSTFLIGHT_FAILURE_CODES) {
    assert.equal(agentPostflightFailureCode(`AgentPostflightError: ultrafuzz-agent-postflight:${code}: detail`), code);
  }
  assert.equal(agentPostflightFailureCode("ultrafuzz-agent-postflight:private-stage: detail"), undefined);
  assert.equal(
    agentPostflightFailureCode("prefixultrafuzz-agent-postflight:artifact-validation-postflight"),
    undefined
  );
  assert.equal(
    agentPostflightFailureCode('provider said "ultrafuzz-agent-postflight:artifact-validation-postflight: quoted"'),
    undefined
  );
  assert.equal(
    agentPostflightFailureCode("provider error: ultrafuzz-agent-postflight:artifact-validation-postflight: embedded"),
    undefined
  );
  assert.equal(
    agentPostflightFailureCode({
      get message() {
        throw new Error("unreadable");
      }
    }),
    undefined
  );
});

async function capturedFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected promise to reject");
}
