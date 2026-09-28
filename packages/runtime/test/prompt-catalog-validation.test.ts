import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { initProject, validateProject } from "../src/index.js";
import { temporaryRoot } from "./temporary-root.js";

// Runs use the project copy of a prompt, and `ultrafuzz init` without `--force` keeps it. After an
// upgrade a scaffolded copy therefore keeps an older release's text while the gates move on, and
// nothing said so until a node failed its artifact gate.
test("validate warns about a project prompt that differs from the built-in prompt at its path", async () => {
  const project = temporaryRoot("ufz-prompt-drift-");
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const promptPath = (relativePath: string) => path.join(project, ".ultrafuzz", "prompts", ...relativePath.split("/"));
  const driftWarnings = (result: Awaited<ReturnType<typeof validateProject>>) =>
    result.diagnostics
      .filter((diagnostic) => diagnostic.code === "PROMPT_DIFFERS_FROM_BUILT_IN")
      .map((diagnostic) => [diagnostic.severity, diagnostic.path]);

  const scaffolded = await validateProject({ projectRoot: project, env: {} });
  assert.equal(scaffolded.ok, true, JSON.stringify(scaffolded.diagnostics));
  assert.equal(scaffolded.value?.policy_posture.prompts.status, "pass");
  assert.deepEqual(driftWarnings(scaffolded), []);

  fs.appendFileSync(promptPath("review/triage.md"), "\nA local edit.\n", "utf8");
  // A prompt the project adds has no built-in counterpart, so it is not drift.
  fs.writeFileSync(promptPath("strategies/project-only.md"), "A project-only prompt.\n", "utf8");
  const edited = await validateProject({ projectRoot: project, env: {} });
  assert.equal(edited.ok, true, JSON.stringify(edited.diagnostics));
  assert.equal(edited.value?.policy_posture.prompts.status, "warn");
  assert.deepEqual(driftWarnings(edited), [["warning", ".ultrafuzz/prompts/review/triage.md"]]);

  // The remedy the warning names restores the built-in copy.
  fs.rmSync(promptPath("review/triage.md"));
  assert.equal(initProject({ projectRoot: project }).ok, true);
  const restored = await validateProject({ projectRoot: project, env: {} });
  assert.equal(restored.value?.policy_posture.prompts.status, "pass");
  assert.deepEqual(driftWarnings(restored), []);
});
