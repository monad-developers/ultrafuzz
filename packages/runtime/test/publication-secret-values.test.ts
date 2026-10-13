import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createDefaultResolvedConfig, serializeResolvedConfigJsonBytes } from "@ultrafuzz/config";

import { runPublicationForbiddenSecretValues } from "../src/publication-secret-values.js";
import { temporaryRoot } from "./temporary-root.js";

function runRootWithConfig(apiKeyEnv: string | undefined): string {
  const runRoot = temporaryRoot("ufz-publication-secrets-");
  if (apiKeyEnv !== undefined) {
    const config = createDefaultResolvedConfig();
    const agent = config.agents.CodexAgent;
    assert.ok(agent);
    config.agents.CodexAgent = { ...agent, auth: "api-key", apiKeyEnv };
    fs.mkdirSync(path.join(runRoot, "smithers"));
    fs.writeFileSync(path.join(runRoot, "smithers", "resolved-config.json"), serializeResolvedConfigJsonBytes(config));
  }
  return runRoot;
}

test("run publication checks know credentials whose names do not say so (#1217)", () => {
  const environment = {
    AZURE_OPENAI_KEY: "azure-configured-credential",
    RPC_URL: "https://example.quiknode.pro/0123456789abcdef0123456789abcdef/",
    ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "RPC_URL,FORK_BLOCK",
    FORK_BLOCK: "19000000",
    OPENAI_API_KEY: "named-configured-credential"
  };

  // The configured api_key_env and an allowlisted variable whose value is a
  // credential are both checked, besides the value recognized by its name.
  const values = runPublicationForbiddenSecretValues(runRootWithConfig("AZURE_OPENAI_KEY"), environment);
  assert.ok(values.includes("azure-configured-credential"));
  assert.ok(values.includes("named-configured-credential"));
  assert.equal(values.includes("19000000"), false, "an ordinary allowlisted value is not a credential");

  // Without a readable run configuration, the names the environment gives still count.
  const unconfigured = runPublicationForbiddenSecretValues(runRootWithConfig(undefined), environment);
  assert.equal(unconfigured.includes("azure-configured-credential"), false);
  assert.ok(unconfigured.includes("named-configured-credential"));
});
