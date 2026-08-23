import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initProject, validateProject } from "../src/index.js";

const ACCEPTED_OPENROUTER_MODEL = "~vendor/model.latest:free+preview@2026";
const BELL = String.fromCodePoint(7);

function tempProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-model-override-"));
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  return project;
}

function diagnosticCodes(result: Awaited<ReturnType<typeof validateProject>>): string[] {
  return [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))].sort();
}

test("validate rejects an OpenRouter override that drops the model", async () => {
  const project = tempProject();

  const validate = await validateProject({ projectRoot: project, agent: "OpenRouterAgent", env: {} });

  assert.equal(validate.ok, false);
  assert.ok(
    diagnosticCodes(validate).includes("CONFIG_MODEL_OPENROUTER_ID_INVALID"),
    JSON.stringify(validate.diagnostics)
  );
  assert.equal(validate.value?.resolved_config, undefined);
  assert.equal(validate.value?.policy_posture.config.ok, false);
});

test("validate rejects OpenRouter model overrides that are whitespace, control characters, or oversized", async () => {
  const project = tempProject();
  const cases = [
    { label: "whitespace", model: "   ", expected: ["CONFIG_MODEL_NAME_EMPTY", "CONFIG_MODEL_OPENROUTER_ID_INVALID"] },
    { label: "control characters", model: `vendor/model${BELL}id`, expected: ["CONFIG_MODEL_OPENROUTER_ID_INVALID"] },
    { label: "oversized", model: `vendor/${"m".repeat(257)}`, expected: ["CONFIG_MODEL_OPENROUTER_ID_INVALID"] }
  ];

  for (const { label, model, expected } of cases) {
    const validate = await validateProject({
      projectRoot: project,
      agent: "OpenRouterAgent",
      model,
      env: {}
    });

    assert.equal(validate.ok, false, label);
    for (const code of expected) {
      assert.ok(diagnosticCodes(validate).includes(code), `${label}: ${JSON.stringify(validate.diagnostics)}`);
    }
    assert.equal(validate.value?.resolved_config, undefined, label);
  }
});

test("validate accepts and preserves an opaque OpenRouter catalogue model override", async () => {
  const project = tempProject();

  const validate = await validateProject({
    projectRoot: project,
    agent: "OpenRouterAgent",
    model: ACCEPTED_OPENROUTER_MODEL,
    env: {}
  });

  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));
  assert.equal(validate.value?.resolved_config?.default_agent, "OpenRouterAgent");
  assert.equal(validate.value?.resolved_config?.default_model, ACCEPTED_OPENROUTER_MODEL);
});

test("validate still requires the pre-override configured agent factories", async () => {
  const project = tempProject();
  const registryPath = path.join(project, ".smithers/agents/index.ts");
  fs.writeFileSync(
    registryPath,
    fs.readFileSync(registryPath, "utf8").replace("  CodexAgent: createCodexAgent,\n", ""),
    "utf8"
  );

  const validate = await validateProject({
    projectRoot: project,
    agent: "OpenRouterAgent",
    model: ACCEPTED_OPENROUTER_MODEL,
    env: {}
  });

  assert.equal(validate.ok, false);
  assert.deepEqual(
    validate.diagnostics
      .filter((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN")
      .map((diagnostic) => diagnostic.message.match(/agent reference (\w+)/u)?.[1]),
    ["CodexAgent"]
  );
});
