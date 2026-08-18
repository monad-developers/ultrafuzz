import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRIAGE_PANEL_SIZE,
  DEFAULT_TRIAGE_QUORUM,
  REDACTION_PLACEHOLDER,
  assertNoRedactionPlaceholders,
  applyDefaultProfileOverrides,
  invariantPropertyPrioritySelection,
  loadProjectConfig,
  parseProjectConfigToml,
  redactDiagnostics,
  redactResolvedConfig,
  resolveExecutionResources,
  resolveConfig,
  restoreRedactedConfig,
  serializeRedactedResolvedConfigToml,
  type ConfigDiagnostic,
  type ProjectConfigInput,
  validateAgentConfigs,
  validateExecutionNodeOverrides,
  validateTriageConfig
} from "../src/index.js";

describe("invariant property priority selection", () => {
  it.each([
    ["high", ["high"]],
    ["medium", ["high", "medium"]],
    ["low", ["high", "medium", "low"]]
  ] as const)("includes priorities at or above %s", (threshold, priorities) => {
    expect(invariantPropertyPrioritySelection(threshold)).toEqual({
      priorities,
      filter: `properties with priority at or above \`${threshold}\``
    });
  });
});

describe("config loading and resolution", () => {
  it("uses quorum 3 and panel size 4 by default", () => {
    const resolved = resolveConfig({ env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.triage).toEqual({
      quorum: DEFAULT_TRIAGE_QUORUM,
      panelSize: DEFAULT_TRIAGE_PANEL_SIZE
    });
    expect(resolved.value.triage).toEqual({ quorum: 3, panelSize: 4 });
    expect(resolved.value.agents.CodexAgent).toEqual({
      auth: "api-key",
      apiKeyEnv: "OPENAI_API_KEY"
    });
    expect(resolved.value.agents.KimiAgent).toEqual({
      auth: "subscription"
    });
    expect(resolved.value.agents.DeepSeekAgent).toEqual({
      auth: "api-key",
      apiKeyEnv: "DEEPSEEK_API_KEY"
    });
    expect(resolved.value.agents.OpenRouterAgent).toEqual({
      auth: "api-key",
      apiKeyEnv: "OPENROUTER_API_KEY"
    });
    expect(resolved.value.models.profiles.default?.reasoning).toBe("xhigh");
    expect(resolved.value.models.profiles.kimi).toEqual({
      id: "kimi",
      agent: "KimiAgent",
      model: "kimi-k3",
      reasoning: "max"
    });
    expect(resolved.value.models.profiles.deepseek).toEqual({
      id: "deepseek",
      agent: "DeepSeekAgent",
      model: "deepseek-v4-pro",
      reasoning: "max"
    });
    expect(resolved.value.retry).toEqual({ sameAgentAttempts: 1, agents: [] });
    expect(resolved.value.run.defaultTimeoutSeconds).toBe(3600);
    expect(resolved.value.run.workflowDeadlineSeconds).toBe(86_400);
    expect(resolved.value.run.controllerLeaseSeconds).toBe(30);
    expect(resolved.value.invariants.invariantTestingSmokeTimeoutSeconds).toBe(600);
    expect(resolved.value.run.forgeGuardEnabled).toBe(true);
    expect(resolved.value.run.forgeVmemLimitKb).toBe(12_582_912);
    expect(resolved.value.run.forgeRayonThreads).toBe(1);
    expect(resolved.value.permissions.productionSourceRoots).toEqual(["src", "contracts"]);
    expect(resolved.value.execution).toEqual({
      mode: "local",
      retentionDays: 30,
      resources: {
        cpu: 4,
        memoryMiB: 8192,
        timeoutSeconds: 3600
      },
      nodes: {},
      providers: {}
    });
  });

  it("resolves an error-agnostic retry policy through explicit model profile IDs", () => {
    const parsed = parseProjectConfigToml(`
[models.sol-xhigh]
agent = "CodexAgent"
model = "gpt-5.6-sol"
reasoning = "xhigh"

[models.gpt55-xhigh]
agent = "CodexAgent"
model = "gpt-5.5"
reasoning = "xhigh"

[retry]
same_agent_attempts = 3
agents = ["sol-xhigh", "gpt55-xhigh"]
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({ env: {}, projectConfig: parsed.value });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics, null, 2));
    expect(resolved.value.retry).toEqual({
      sameAgentAttempts: 3,
      agents: ["sol-xhigh", "gpt55-xhigh"]
    });
    expect(resolved.value.models.profiles["gpt55-xhigh"]).toMatchObject({
      agent: "CodexAgent",
      model: "gpt-5.5",
      reasoning: "xhigh"
    });
    expect(serializeRedactedResolvedConfigToml(resolved.value)).toContain('agents = ["sol-xhigh", "gpt55-xhigh"]');
  });

  it("rejects unknown and duplicate retry profile IDs without parsing provider errors", () => {
    const unknown = resolveConfig({
      env: {},
      projectConfig: { retry: { sameAgentAttempts: 2, agents: ["missing"] } }
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.diagnostics.map((entry) => entry.code)).toContain("CONFIG_RETRY_AGENT_UNKNOWN");
    for (const inherited of ["constructor", "toString"]) {
      const result = resolveConfig({
        env: {},
        projectConfig: { models: { default: inherited }, retry: { agents: ["default", inherited] } }
      });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.diagnostics.map(({ code }) => code)).toEqual(
          expect.arrayContaining(["CONFIG_MODEL_DEFAULT_UNKNOWN", "CONFIG_RETRY_AGENT_UNKNOWN"])
        );
    }

    const duplicate = resolveConfig({
      env: {},
      projectConfig: { retry: { agents: ["default", "default"] } }
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics.map((entry) => entry.code)).toContain("CONFIG_RETRY_AGENT_DUPLICATE");
    }
  });

  it("emits one exact retry-owned diagnostic for each invalid retry field", () => {
    const cases: Array<{
      retry: NonNullable<ProjectConfigInput["retry"]>;
      expected: Pick<ConfigDiagnostic, "code" | "message" | "path">;
    }> = [
      {
        retry: { sameAgentAttempts: 0 },
        expected: {
          code: "CONFIG_RETRY_ATTEMPTS_INVALID",
          message: "retry.same_agent_attempts must be a positive safe integer",
          path: ["retry", "same_agent_attempts"]
        }
      },
      {
        retry: { sameAgentAttempts: 101 },
        expected: {
          code: "CONFIG_RETRY_ATTEMPTS_MAX_EXCEEDED",
          message: "retry.same_agent_attempts must not exceed 100",
          path: ["retry", "same_agent_attempts"]
        }
      },
      {
        retry: { agents: ["../invalid"] },
        expected: {
          code: "CONFIG_RETRY_AGENT_ID_INVALID",
          message: "retry.agents entry 0 must be a valid model profile ID",
          path: ["retry", "agents", "0"]
        }
      },
      {
        retry: { agents: ["default", "default"] },
        expected: {
          code: "CONFIG_RETRY_AGENT_DUPLICATE",
          message: "retry.agents repeats model profile `default`",
          path: ["retry", "agents", "1"]
        }
      },
      {
        retry: { agents: ["missing"] },
        expected: {
          code: "CONFIG_RETRY_AGENT_UNKNOWN",
          message: "retry.agents references unknown model profile `missing`",
          path: ["retry", "agents", "0"]
        }
      }
    ];

    for (const { retry, expected } of cases) {
      const result = resolveConfig({ env: {}, projectConfig: { retry } });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostics.map(({ code, message, path }) => ({ code, message, path }))).toEqual([expected]);
    }
  });

  it("accepts a 100-attempt retry chain and rejects an expanded chain of 101 exactly once", () => {
    const profiles = {
      primary: { agent: "CodexAgent", model: "gpt-5.5" },
      fallback: { agent: "CodexAgent", model: "gpt-5.6-sol" }
    };
    const boundary = resolveConfig({
      env: {},
      projectConfig: {
        models: { profiles },
        retry: { sameAgentAttempts: 99, agents: ["primary", "fallback"] }
      }
    });
    expect(boundary.ok).toBe(true);

    const exceeded = resolveConfig({
      env: {},
      projectConfig: {
        models: { profiles },
        retry: { sameAgentAttempts: 100, agents: ["primary", "fallback"] }
      }
    });
    expect(exceeded.ok).toBe(false);
    if (exceeded.ok) return;
    expect(exceeded.diagnostics.map(({ code, message, path }) => ({ code, message, path }))).toEqual([
      {
        code: "CONFIG_RETRY_CHAIN_MAX_EXCEEDED",
        message: "retry expands to 101 attempts; maximum is 100",
        path: ["retry"]
      }
    ]);
  });

  it("loads and serializes declared production source roots", () => {
    const parsed = parseProjectConfigToml(`
[permissions]
production_source_roots = ["protocol", "packages/core/src"]
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({ env: {}, projectConfig: parsed.value });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.permissions.productionSourceRoots).toEqual(["protocol", "packages/core/src"]);
    expect(serializeRedactedResolvedConfigToml(resolved.value)).toContain(
      'production_source_roots = ["protocol", "packages/core/src"]'
    );
  });

  it("accepts a target-sized invariant Recon smoke timeout", () => {
    const parsed = parseProjectConfigToml(`
[invariants]
invariant_testing_smoke_timeout = "10min"
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.invariants?.invariantTestingSmokeTimeoutSeconds).toBe(600);

    const resolved = resolveConfig({
      env: {},
      projectConfig: { invariants: { invariantTestingSmokeTimeoutSeconds: 900 } }
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.invariants.invariantTestingSmokeTimeoutSeconds).toBe(900);
  });

  // Issue #285 staging switch. The runtime gate reads this key straight out of the RESOLVED config
  // TOML, so a key the loader accepts but the serializer drops would be a switch nobody can flip.
  it("carries the reference expectation enforcement switch into the resolved config", () => {
    const parsed = parseProjectConfigToml(`
[invariants]
reference_expectation_enforcement = "fail"
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.invariants?.referenceExpectationEnforcement).toBe("fail");

    const resolved = resolveConfig({ env: {}, projectConfig: parsed.value });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.invariants.referenceExpectationEnforcement).toBe("fail");
    expect(serializeRedactedResolvedConfigToml(resolved.value)).toContain('reference_expectation_enforcement = "fail"');

    // Absent is the default, and the serialized config must not invent one.
    const defaulted = resolveConfig({ env: {} });
    expect(defaulted.ok).toBe(true);
    if (!defaulted.ok) return;
    expect(defaulted.value.invariants.referenceExpectationEnforcement).toBeUndefined();
    expect(serializeRedactedResolvedConfigToml(defaulted.value)).not.toContain("reference_expectation_enforcement");

    const invalid = parseProjectConfigToml(`
[invariants]
reference_expectation_enforcement = "strict"
`);
    expect(invalid.ok).toBe(false);
  });

  it("resolves provider-neutral cloud resources and logical-node overrides without persisting credentials", () => {
    const parsed = parseProjectConfigToml(`
[execution]
mode = "cloud"
provider = "modal"
retention_days = 45

[execution.resources]
cpu = 8
memory_mib = 16384
timeout_seconds = 3600

[execution.nodes.project-discovery.resources]
cpu = 16
memory_mib = 32768

[execution.providers.modal]
app = "node-runs"
image = "runner:stable"
region = "region-a"
credential_env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({
      projectConfig: parsed.value,
      env: {
        MODAL_TOKEN_ID: "first-secret-value",
        MODAL_TOKEN_SECRET: "second-secret-value"
      }
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics, null, 2));
    expect(resolveExecutionResources(resolved.value, "project-discovery")).toEqual({
      cpu: 16,
      memoryMiB: 32768,
      timeoutSeconds: 3600
    });
    expect(resolveExecutionResources(resolved.value, "other-node")).toEqual({
      cpu: 8,
      memoryMiB: 16384,
      timeoutSeconds: 3600
    });
    const serialized = serializeRedactedResolvedConfigToml(resolved.value);
    expect(serialized).toContain("[execution.nodes.project-discovery.resources]");
    expect(serialized).toContain('credential_env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]');
    expect(serialized).not.toContain("first-secret-value");
    expect(serialized).not.toContain("second-secret-value");
    expect(validateExecutionNodeOverrides(resolved.value, ["project-discovery"])).toEqual([]);
    expect(validateExecutionNodeOverrides(resolved.value, ["different-node"])[0]?.code).toBe(
      "CONFIG_EXECUTION_NODE_UNKNOWN"
    );
  });

  it("rejects incomplete cloud provider selection, credentials, resources, and misplaced local settings", () => {
    const missingProvider = resolveConfig({
      env: {},
      projectConfig: { execution: { mode: "cloud" } }
    });
    expect(missingProvider.ok).toBe(false);
    if (!missingProvider.ok) {
      expect(missingProvider.diagnostics.map((entry) => entry.code)).toContain("CONFIG_EXECUTION_PROVIDER_REQUIRED");
    }

    const missingCredential = resolveConfig({
      env: { MODAL_TOKEN_ID: "available" },
      projectConfig: {
        execution: {
          mode: "cloud",
          provider: "modal",
          providers: {
            modal: {
              app: "node-runs",
              image: "runner:stable",
              credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
            }
          }
        }
      }
    });
    expect(missingCredential.ok).toBe(false);
    if (!missingCredential.ok) {
      expect(missingCredential.diagnostics.map((entry) => entry.code)).toContain("CONFIG_EXECUTION_CREDENTIAL_MISSING");
      expect(missingCredential.diagnostics.map((entry) => entry.message).join("\n")).not.toContain(
        "MODAL_TOKEN_SECRET"
      );
    }

    const invalidResource = resolveConfig({
      env: {},
      projectConfig: { execution: { resources: { cpu: 0 } } }
    });
    expect(invalidResource.ok).toBe(false);

    const localProviderSettings = resolveConfig({
      env: {},
      projectConfig: {
        execution: {
          providers: {
            modal: {
              app: "node-runs",
              image: "runner:stable",
              credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
            }
          }
        }
      }
    });
    expect(localProviderSettings.ok).toBe(false);
    if (!localProviderSettings.ok) {
      expect(localProviderSettings.diagnostics.map((entry) => entry.code)).toContain(
        "CONFIG_EXECUTION_LOCAL_PROVIDER_SETTINGS"
      );
      expect(localProviderSettings.diagnostics.map((entry) => entry.code)).not.toContain(
        "CONFIG_POSITIVE_INTEGER_INVALID"
      );
    }
  });

  it("applies defaults, prompt metadata, project TOML, env, then runtime overrides", () => {
    const project = parseProjectConfigToml(`
schema_version = "ultrafuzz.config.v2"
dynamic_strategies_enumerator = 5

[run]
max_parallel_agents = 2
forge_guard_enabled = false
forge_vmem_limit_kb = 16777216
forge_rayon_threads = 3
default_timeout_seconds = 1200
workflow_deadline_seconds = 7200
controller_lease_seconds = 45

[models]
default = "project-model"

[models.project-model]
agent = "CodexAgent"
model = "gpt-5.5"
reasoning = "max"

[agents.CodexAgent]
auth = "subscription"
config_dir = "teams/codex"
`);
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const resolved = resolveConfig({
      promptMetadata: {
        run: { defaultTimeoutSeconds: 900 },
        models: {
          "prompt-model": {
            agent: "CodexAgent",
            model: "gpt-5.5"
          }
        }
      },
      projectConfig: project.value,
      env: {
        ULTRAFUZZ_MAX_PARALLEL_AGENTS: "7"
      },
      runtimeOverrides: {
        maxParallelAgents: 11,
        triageQuorum: 2,
        triagePanelSize: 4
      }
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics, null, 2));
    expect(resolved.value.run.defaultTimeoutSeconds).toBe(1200);
    expect(resolved.value.run.maxParallelAgents).toBe(11);
    expect(resolved.value.run.workflowDeadlineSeconds).toBe(7200);
    expect(resolved.value.run.controllerLeaseSeconds).toBe(45);
    expect(resolved.value.run.forgeGuardEnabled).toBe(false);
    expect(resolved.value.run.forgeVmemLimitKb).toBe(16_777_216);
    expect(resolved.value.run.forgeRayonThreads).toBe(3);
    expect(resolved.value.triage).toEqual({ quorum: 2, panelSize: 4 });
    expect(resolved.value.models.default).toBe("project-model");
    expect(resolved.value.models.profiles["project-model"]?.agent).toBe("CodexAgent");
    expect(resolved.value.models.profiles["project-model"]?.reasoning).toBe("max");
    expect(resolved.value.agents.CodexAgent).toEqual({
      auth: "subscription",
      apiKeyEnv: "OPENAI_API_KEY",
      configDir: "teams/codex"
    });
  });

  it("returns typed diagnostics for invalid TOML fields and rejects legacy backend tables", () => {
    const parsed = parseProjectConfigToml(`
[run]
max_parallel_agents = "four"
unexpected = true

[backend]
default = "mock"
`);
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["CONFIG_FIELD_TYPE_INVALID", "CONFIG_UNKNOWN_FIELD"])
    );
  });

  it("validates Codex agent auth configuration", () => {
    const parsed = parseProjectConfigToml(`
[agents.CodexAgent]
auth = "api-key"
api_key_env = "OPENAI_API_KEY"

[agents.KimiAgent]
auth = "api-key"
api_key_env = "MOONSHOT_API_KEY"
config_dir = "kimi-code"
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.agents?.CodexAgent?.auth).toBe("api-key");
    expect(parsed.value.agents?.CodexAgent?.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(parsed.value.agents?.KimiAgent).toEqual({
      auth: "api-key",
      apiKeyEnv: "MOONSHOT_API_KEY",
      configDir: "kimi-code"
    });

    for (const [agent, canonical] of Object.entries({
      ClaudeAgent: "ANTHROPIC_API_KEY",
      CodexAgent: "OPENAI_API_KEY",
      DeepSeekAgent: "DEEPSEEK_API_KEY",
      KimiAgent: "KIMI_API_KEY",
      OpenRouterAgent: "OPENROUTER_API_KEY"
    })) {
      expect(validateAgentConfigs({ [agent]: { auth: "api-key", apiKeyEnv: "AWS_SECRET_ACCESS_KEY" } })[0]?.code).toBe(
        "CONFIG_AGENT_API_KEY_ENV_NONCANONICAL"
      );
      expect(validateAgentConfigs({ [agent]: { auth: "api-key", apiKeyEnv: canonical } })).toEqual([]);
    }
    expect(
      validateAgentConfigs({ constructor: { auth: "api-key" as const, apiKeyEnv: "AWS_SECRET_ACCESS_KEY" } })[0]?.code
    ).toBe("CONFIG_AGENT_ID_INVALID");
    {
      const polluted = parseProjectConfigToml(
        '[agents.__proto__]\nauth = "api-key"\napi_key_env = "AWS_SECRET_ACCESS_KEY"\n'
      );
      expect(polluted.ok).toBe(true);
      if (polluted.ok) {
        const result = resolveConfig({ env: {}, projectConfig: polluted.value });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.diagnostics.map(({ code }) => code)).toContain("CONFIG_AGENT_ID_INVALID");
      }
    }
    for (const configDir of ["", "/tmp/provider", "../provider", ".codex", "team\\codex", "team/../codex"])
      expect(validateAgentConfigs({ CodexAgent: { auth: "subscription", configDir } })[0]?.code).toBe(
        "CONFIG_AGENT_CONFIG_DIR_UNSAFE"
      );
    expect(validateAgentConfigs({ CodexAgent: { auth: "subscription", configDir: "teams/codex" } })).toEqual([]);

    const invalid = resolveConfig({
      env: {},
      projectConfig: {
        agents: {
          CodexAgent: {
            auth: "api-key",
            apiKeyEnv: "not valid"
          }
        }
      }
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.diagnostics.map((entry) => entry.code)).toContain("CONFIG_AGENT_API_KEY_ENV_INVALID");

    const defaultResolved = resolveConfig({ env: {} });
    expect(defaultResolved.ok).toBe(true);
    if (!defaultResolved.ok) return;
    const serialized = serializeRedactedResolvedConfigToml(defaultResolved.value);
    expect(serialized).toContain("[agents.CodexAgent]");
    expect(serialized).toContain("[agents.KimiAgent]");
    expect(serialized).toContain('auth = "api-key"');
    expect(serialized).toContain('model = "kimi-k3"');
    expect(serialized).toContain("forge_guard_enabled = true");
    expect(serialized).toContain("forge_vmem_limit_kb = 12582912");
    expect(serialized).toContain("forge_rayon_threads = 1");
  });

  it("preserves opaque OpenRouter catalogue IDs and rejects only unsafe boundaries", () => {
    const model = "~vendor/model.latest:free+preview@2026";
    const accepted = resolveConfig({
      env: {},
      projectConfig: {
        models: {
          profiles: {
            routed: { agent: "OpenRouterAgent", model, reasoning: "high" }
          }
        }
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.models.profiles.routed?.model).toBe(model);
    expect(serializeRedactedResolvedConfigToml(accepted.value)).toContain(`model = ${JSON.stringify(model)}`);

    for (const invalidModel of [
      "vendor/model with-space",
      "vendor/model\nnext",
      "vendor/model\u0080control",
      `vendor/${"m".repeat(250)}`
    ]) {
      const invalid = resolveConfig({
        env: {},
        projectConfig: {
          models: { profiles: { routed: { agent: "OpenRouterAgent", model: invalidModel } } }
        }
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "CONFIG_MODEL_OPENROUTER_ID_INVALID",
            path: ["models", "routed", "model"]
          })
        );
      }
    }
  });

  it("loads ultrafuzz.toml from disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "ultrafuzz-config-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "ultrafuzz.toml"),
      `
[run]
output_dir = ".ultrafuzz/custom-runs"
`
    );

    const loaded = await loadProjectConfig(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.exists).toBe(true);
    expect(loaded.value.config.run?.outputDir).toBe(".ultrafuzz/custom-runs");
  });
});

describe("redaction", () => {
  it("redacts sensitive model values while preserving restore requirements", () => {
    const resolved = resolveConfig({
      env: {},
      projectConfig: {
        models: {
          profiles: {
            "secret-model": {
              agent: "CodexAgent",
              model: "sk-test-secret"
            }
          },
          default: "secret-model"
        }
      }
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics, null, 2));

    const redacted = redactResolvedConfig(resolved.value);
    const toml = serializeRedactedResolvedConfigToml(redacted);

    expect(toml).toContain(REDACTION_PLACEHOLDER);
    expect(toml).not.toContain("sk-test-secret");
    expect(redacted.manifest.entries.map((entry) => entry.key)).toContain("models.profiles.secret-model.model");
    expect(redacted.manifest.entries[0]?.requiredForWorkflowLaunch).toBe(true);

    const restored = restoreRedactedConfig(redacted.config, resolved.value, redacted.manifest);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.models.profiles["secret-model"]?.model).toBe("sk-test-secret");
    expect(assertNoRedactionPlaceholders(restored.value).ok).toBe(true);
  });

  it("rejects literal redaction placeholders before workflow launch", () => {
    const resolved = resolveConfig({ env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    resolved.value.models.profiles.default!.model = "[redacted]";
    const checked = assertNoRedactionPlaceholders(resolved.value);
    expect(checked.ok).toBe(false);
    expect(checked.diagnostics[0]?.code).toBe("CONFIG_REDACTION_PLACEHOLDER_PRESENT");
  });

  it("fails restoration when a required redacted value is unavailable", () => {
    const resolved = resolveConfig({
      env: {},
      projectConfig: {
        models: {
          profiles: {
            "secret-model": {
              agent: "CodexAgent",
              model: "sk-test-secret"
            }
          },
          default: "secret-model"
        }
      }
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics, null, 2));

    const redacted = redactResolvedConfig(resolved.value);
    const current = structuredClone(resolved.value);
    delete current.models.profiles["secret-model"]!.model;

    const restored = restoreRedactedConfig(redacted.config, current, redacted.manifest);
    expect(restored.ok).toBe(false);
    expect(restored.diagnostics.map((entry) => entry.code)).toContain("CONFIG_REDACTION_RESTORE_MISSING");
    expect(restored.diagnostics[0]?.message).toContain("before workflow launch");
  });
});

describe("resolved config named semantic diagnostics", () => {
  const cases: Array<{
    label: string;
    projectConfig: ProjectConfigInput;
    diagnostics: ConfigDiagnostic[];
  }> = [
    {
      label: "unsupported Kimi reasoning",
      projectConfig: {
        models: {
          profiles: {
            "kimi-invalid": {
              agent: "KimiAgent",
              model: "kimi-k3",
              reasoning: "xhigh"
            }
          }
        }
      },
      diagnostics: [
        validationDiagnostic(
          "CONFIG_MODEL_KIMI_REASONING_UNSUPPORTED",
          "Kimi model profile `kimi-invalid` reasoning must be low, high, or max",
          ["models", "kimi-invalid", "reasoning"]
        )
      ]
    },
    {
      label: "unsupported DeepSeek reasoning",
      projectConfig: {
        models: {
          profiles: {
            "deepseek-invalid": {
              agent: "DeepSeekAgent",
              model: "deepseek-v4-pro",
              reasoning: "xhigh"
            }
          }
        }
      },
      diagnostics: [
        validationDiagnostic(
          "CONFIG_MODEL_DEEPSEEK_REASONING_UNSUPPORTED",
          "DeepSeek model profile `deepseek-invalid` reasoning must be low, high, or max",
          ["models", "deepseek-invalid", "reasoning"]
        )
      ]
    },
    {
      label: "unsupported DeepSeek subscription authentication",
      projectConfig: {
        agents: {
          DeepSeekAgent: {
            auth: "subscription"
          }
        }
      },
      diagnostics: [
        validationDiagnostic(
          "CONFIG_AGENT_DEEPSEEK_AUTH_UNSUPPORTED",
          "DeepSeekAgent supports only api-key authentication",
          ["agents", "DeepSeekAgent", "auth"]
        )
      ]
    },
    {
      label: "unsupported OpenRouter subscription authentication",
      projectConfig: {
        agents: {
          OpenRouterAgent: {
            auth: "subscription"
          }
        }
      },
      diagnostics: [
        validationDiagnostic(
          "CONFIG_AGENT_OPENROUTER_AUTH_UNSUPPORTED",
          "OpenRouterAgent supports only api-key authentication",
          ["agents", "OpenRouterAgent", "auth"]
        )
      ]
    },
    {
      label: "a cloud provider selected for local execution",
      projectConfig: {
        execution: {
          provider: "modal"
        }
      },
      diagnostics: [
        validationDiagnostic(
          "CONFIG_EXECUTION_LOCAL_PROVIDER",
          "execution.provider is only valid when execution.mode is cloud",
          ["execution", "provider"]
        )
      ]
    },
    {
      label: "cloud provider settings configured for local execution",
      projectConfig: {
        execution: {
          providers: {
            modal: {
              app: "node-runs",
              image: "runner:stable",
              credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
            }
          }
        }
      },
      diagnostics: [
        validationDiagnostic(
          "CONFIG_EXECUTION_LOCAL_PROVIDER_SETTINGS",
          "cloud provider settings are only valid when execution.mode is cloud",
          ["execution", "providers", "modal"]
        )
      ]
    },
    {
      label: "cloud execution without a provider",
      projectConfig: {
        execution: {
          mode: "cloud"
        }
      },
      diagnostics: [
        validationDiagnostic("CONFIG_EXECUTION_PROVIDER_REQUIRED", "cloud execution requires an execution provider", [
          "execution",
          "provider"
        ])
      ]
    },
    {
      label: "cloud execution without selected-provider settings",
      projectConfig: {
        execution: {
          mode: "cloud",
          provider: "modal"
        }
      },
      diagnostics: [
        validationDiagnostic(
          "CONFIG_EXECUTION_PROVIDER_SETTINGS_REQUIRED",
          "cloud execution requires settings for the selected provider",
          ["execution", "providers", "modal"]
        )
      ]
    }
  ];

  it.each(cases)("reports only the named semantic diagnostic for $label", ({ projectConfig, diagnostics }) => {
    const resolved = resolveConfig({ env: {}, projectConfig });

    expect(resolved).toEqual({ ok: false, diagnostics });
  });
});

describe("model profile and triage validation", () => {
  it("clears default reasoning whenever an agent override switches agents", () => {
    const agentOnly = resolveConfig({ env: {} });
    expect(agentOnly.ok).toBe(true);
    if (!agentOnly.ok) return;
    applyDefaultProfileOverrides(agentOnly.value, { agent: "ClaudeAgent" });
    expect(agentOnly.value.models.profiles.default).toMatchObject({
      agent: "ClaudeAgent"
    });
    expect(agentOnly.value.models.profiles.default?.model ?? null).toBeNull();
    expect(agentOnly.value.models.profiles.default?.reasoning ?? null).toBeNull();

    const pinned = resolveConfig({ env: {} });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    applyDefaultProfileOverrides(pinned.value, { agent: "ClaudeAgent", model: "claude-sonnet-5" });
    expect(pinned.value.models.profiles.default).toMatchObject({
      agent: "ClaudeAgent",
      model: "claude-sonnet-5"
    });
    expect(pinned.value.models.profiles.default?.reasoning ?? null).toBeNull();

    const benchmark = resolveConfig({ env: {} });
    expect(benchmark.ok).toBe(true);
    if (!benchmark.ok) return;
    applyDefaultProfileOverrides(benchmark.value, {
      agent: "CodexAgent",
      model: "gpt-5.6-luna",
      reasoning: "high"
    });
    expect(benchmark.value.models.profiles.default).toMatchObject({
      agent: "CodexAgent",
      model: "gpt-5.6-luna",
      reasoning: "high"
    });
  });

  it("fails invalid model profiles with typed diagnostics", () => {
    const resolved = resolveConfig({
      env: {},
      projectConfig: {
        models: {
          profiles: {
            "../bad": {
              agent: "constructor",
              model: "",
              reasoning: "",
              timeoutSeconds: 0
            }
          },
          default: "missing"
        }
      }
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "CONFIG_MODEL_PROFILE_ID_INVALID", path: ["models", "../bad"] },
      { code: "CONFIG_MODEL_DEFAULT_UNKNOWN", path: ["models", "default"] },
      { code: "CONFIG_MODEL_AGENT_INVALID", path: ["models", "../bad", "agent"] },
      { code: "CONFIG_MODEL_NAME_EMPTY", path: ["models", "../bad", "model"] },
      { code: "CONFIG_MODEL_REASONING_EMPTY", path: ["models", "../bad", "reasoning"] },
      { code: "CONFIG_MODEL_TIMEOUT_INVALID", path: ["models", "../bad", "timeout_seconds"] }
    ]);
  });

  it("rejects Kimi reasoning values that Kimi Code cannot execute", () => {
    const resolved = resolveConfig({
      env: {},
      projectConfig: {
        models: {
          profiles: {
            "kimi-invalid": {
              agent: "KimiAgent",
              model: "kimi-k3",
              reasoning: "xhigh"
            }
          }
        }
      }
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONFIG_MODEL_KIMI_REASONING_UNSUPPORTED",
        path: ["models", "kimi-invalid", "reasoning"]
      })
    );
    expect(resolved.diagnostics.map((entry) => entry.code)).not.toContain("CONFIG_POSITIVE_INTEGER_INVALID");
  });

  it("rejects whitespace-padded Kimi reasoning values instead of normalizing them away", () => {
    const resolved = resolveConfig({
      env: {},
      projectConfig: {
        models: {
          profiles: {
            "kimi-padded": {
              agent: "KimiAgent",
              model: "kimi-k3",
              reasoning: " max "
            }
          }
        }
      }
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONFIG_MODEL_KIMI_REASONING_UNSUPPORTED",
        path: ["models", "kimi-padded", "reasoning"]
      })
    );
  });

  it("rejects DeepSeek reasoning values outside the provider's supported efforts", () => {
    const resolved = resolveConfig({
      env: {},
      projectConfig: {
        models: {
          profiles: {
            "deepseek-invalid": {
              agent: "DeepSeekAgent",
              model: "deepseek-v4-pro",
              reasoning: "xhigh"
            }
          }
        }
      }
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONFIG_MODEL_DEEPSEEK_REASONING_UNSUPPORTED",
        path: ["models", "deepseek-invalid", "reasoning"]
      })
    );
    expect(resolved.diagnostics.map((entry) => entry.code)).not.toContain("CONFIG_POSITIVE_INTEGER_INVALID");
  });

  it("rejects unsupported DeepSeek subscription authentication during config validation", () => {
    const resolved = resolveConfig({
      env: {},
      projectConfig: {
        agents: {
          DeepSeekAgent: {
            auth: "subscription"
          }
        }
      }
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONFIG_AGENT_DEEPSEEK_AUTH_UNSUPPORTED",
        path: ["agents", "DeepSeekAgent", "auth"]
      })
    );
    expect(resolved.diagnostics.map((entry) => entry.code)).not.toContain("CONFIG_POSITIVE_INTEGER_INVALID");
  });

  it("rejects unknown agent and triage helper fields without stripping them", () => {
    expect(
      validateAgentConfigs({
        CodexAgent: {
          auth: "api-key",
          apiKeyEnv: "OPENAI_API_KEY",
          legacy: true
        }
      } as never)
    ).toContainEqual(
      expect.objectContaining({
        code: "CONFIG_AGENT_FIELD_UNKNOWN",
        path: ["agents", "CodexAgent", "legacy"]
      })
    );
    expect(validateTriageConfig({ quorum: 3, panelSize: 4, legacy: true } as never)).toContainEqual(
      expect.objectContaining({
        code: "CONFIG_TRIAGE_FIELD_UNKNOWN",
        path: ["triage", "legacy"]
      })
    );
  });

  it("redacts sensitive diagnostic messages", () => {
    const redacted = redactDiagnostics([
      {
        code: "CONFIG_EXAMPLE",
        severity: "error",
        message: "failed with sk-test-secret",
        path: ["example"],
        source: "validation"
      }
    ]);
    expect(redacted[0]?.message).toBe("failed with <redacted>");
  });

  it("fails invalid triage quorum", () => {
    expect(validateTriageConfig({ quorum: 0, panelSize: 0 }).map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["CONFIG_TRIAGE_QUORUM_INVALID", "CONFIG_TRIAGE_PANEL_SIZE_INVALID"])
    );
    expect(validateTriageConfig({ quorum: 4, panelSize: 3 })[0]?.code).toBe("CONFIG_TRIAGE_QUORUM_EXCEEDS_PANEL");

    const resolved = resolveConfig({
      env: {},
      runtimeOverrides: {
        triageQuorum: 9,
        triagePanelSize: 3
      }
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.diagnostics.map((entry) => entry.code)).toContain("CONFIG_TRIAGE_QUORUM_EXCEEDS_PANEL");
  });
});

function validationDiagnostic(code: string, message: string, path: string[]): ConfigDiagnostic {
  return {
    code,
    severity: "error",
    message,
    path,
    source: "validation"
  };
}
