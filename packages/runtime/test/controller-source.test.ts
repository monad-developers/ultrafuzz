import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as c from "../src/controller-source.js";
import { initProject } from "../src/init.js";
const stockProject = (): string => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-controller-source-"));
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  return project;
};
test("the full stock controller closure is digest-bound to sealed bytes", () => {
  const project = stockProject(),
    inspected = c.inspectControllerSource(project);
  const executionFiles = inspected.files.map((name) => ({
    snapshotPath: `.smithers/agents/${name}`,
    contents: fs.readFileSync(path.join(project, ".smithers", "agents", name))
  }));
  assert.match(inspected.digest, /^[a-f0-9]{64}$/u);
  assert.doesNotThrow(() => c.assertControllerSourceDigest(project, inspected.digest));
  assert.doesNotThrow(() => c.assertControllerExecutionSnapshotDigest(executionFiles, inspected.digest));
  assert.doesNotThrow(() => c.assertProviderScopedSensitiveEnvironmentCapability(executionFiles, "MAINNET_RPC_URL"));
  const legacyExecutionFiles = executionFiles.map((file) => ({ ...file, contents: Buffer.from(file.contents) }));
  const legacyEnvironment = legacyExecutionFiles.find(
    (file) => file.snapshotPath === ".smithers/agents/environment.ts"
  );
  assert.ok(legacyEnvironment);
  legacyEnvironment.contents = Buffer.from(
    legacyEnvironment.contents
      .toString("utf8")
      .replace(
        `export const PROVIDER_SCOPED_SENSITIVE_ENVIRONMENT_CAPABILITY =\n  "${c.PROVIDER_SCOPED_SENSITIVE_ENVIRONMENT_CAPABILITY}" as const;\n\n`,
        ""
      ),
    "utf8"
  );
  assert.doesNotThrow(() => c.assertProviderScopedSensitiveEnvironmentCapability(legacyExecutionFiles, ""));
  assert.throws(
    () => c.assertProviderScopedSensitiveEnvironmentCapability(legacyExecutionFiles, "MAINNET_RPC_URL"),
    /predates provider-scoped sensitive allowlisted environment handling.*start a new run/u
  );
  executionFiles[0]!.contents = Buffer.from("changed");
  assert.throws(
    () => c.assertControllerExecutionSnapshotDigest(executionFiles, inspected.digest),
    /changed after validation/u
  );
  const attacks = [
    (root: string) => fs.appendFileSync(path.join(root, ".smithers/agents/codex.ts"), "\n// custom\n"),
    (root: string) => fs.writeFileSync(path.join(root, ".smithers/agents/extra.ts"), "export {};\n"),
    (root: string) => {
      const file = path.join(root, ".smithers/agents/environment.ts");
      fs.unlinkSync(file);
      fs.symlinkSync("codex.ts", file);
    }
  ];
  for (const attack of attacks) {
    const root = stockProject();
    attack(root);
    assert.throws(() => c.inspectControllerSource(root), /must exactly match the packaged stock closure/u);
  }
});
