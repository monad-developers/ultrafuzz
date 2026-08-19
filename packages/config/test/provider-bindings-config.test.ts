import { describe, expect, it } from "vitest";
import { parseProjectConfigToml, resolveConfig, serializeResolvedConfigToml } from "../src/index.js";

const bindingToml = `
[providers.gateway]
kind = "gateway"
base_url = "https://example.test/v1"
auth = "api-key"
api_key_env = "GATEWAY_KEY"
protocols = ["openai-chat"]
preflight = "first-request"

[harnesses.runner]
kind = "runner"
executable = "node"
version = "1.0.0"
config_seed_dir = ".ultrafuzz/harness/runner"
protocols = ["openai-chat"]
events = "jsonl"
sessions = "none"
isolation = "external-sandbox-required"
unattended = true
cloud_portable = true

[harnesses.runner.tools]
filesystem = true
shell = true

[harnesses.runner.usage]
tokens = true
cache = false
cost = false

[models.custom]
agent = "CodexAgent"
harness = "runner"
provider = "gateway"
model = "vendor/model:not-statically-allowlisted"
`;

describe("provider/harness config schema", () => {
  it("parses, resolves, serializes, and reloads independent provider, harness, and opaque model fields", () => {
    const parsed = parseProjectConfigToml(bindingToml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({ projectConfig: parsed.value, env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.models.profiles.custom).toMatchObject({
      harness: "runner",
      provider: "gateway",
      model: "vendor/model:not-statically-allowlisted"
    });
    expect(resolved.value.providers.gateway).toMatchObject({ auth: "api-key", credentialEnv: "GATEWAY_KEY" });
    const serialized = serializeResolvedConfigToml(resolved.value);
    expect(serialized).toContain("[providers.gateway]");
    expect(serialized).toContain("[harnesses.runner]");
    expect(serialized).not.toContain("secret-value");
    const reloaded = parseProjectConfigToml(serialized);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    const reresolved = resolveConfig({ projectConfig: reloaded.value, env: {} });
    expect(reresolved.ok).toBe(true);
    if (!reresolved.ok) return;
    expect(reresolved.value.providers.gateway).toEqual(resolved.value.providers.gateway);
    expect(reresolved.value.harnesses.runner).toEqual(resolved.value.harnesses.runner);
  });

  it("names the profile field for missing references", () => {
    const parsed = parseProjectConfigToml(
      `[models.bad]\nagent = "CodexAgent"\nharness = "missing"\nprovider = "missing"\nmodel = "anything"`
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({ projectConfig: parsed.value, env: {} });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.diagnostics.map((entry) => entry.path.join("."))).toEqual(
      expect.arrayContaining(["models.bad.harness", "models.bad.provider"])
    );
  });

  it("preserves legacy profiles without requiring new fields", () => {
    const resolved = resolveConfig({ env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    for (const agent of ["CodexAgent", "ClaudeAgent", "DeepSeekAgent", "KimiAgent"]) {
      const profile = Object.values(resolved.value.models.profiles).find((candidate) => candidate.agent === agent);
      expect(profile?.harness).toBeUndefined();
      expect(profile?.provider).toBeUndefined();
    }
  });
});
