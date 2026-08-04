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
    expect(resolved.value.run.workflowDeadlineSeconds).toBe(86_400);
    expect(resolved.value.run.controllerLeaseSeconds).toBe(30);
    expect(resolved.value.run.forgeGuardEnabled).toBe(true);
    expect(resolved.value.run.forgeVmemLimitKb).toBe(12_582_912);
    expect(resolved.value.run.forgeRayonThreads).toBe(1);
    expect(resolved.value.execution).toEqual({
      mode: "local",
      retentionDays: 30,
      resources: {
        cpu: 4,
        memoryMiB: 8192,
        timeoutSeconds: 1800
      },
      nodes: {},
      providers: {}
    });
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
credential_env = ["CLOUD_CREDENTIAL_ONE", "CLOUD_CREDENTIAL_TWO"]
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({
      projectConfig: parsed.value,
      env: {
        CLOUD_CREDENTIAL_ONE: "first-secret-value",
        CLOUD_CREDENTIAL_TWO: "second-secret-value"
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
    expect(serialized).toContain('credential_env = ["CLOUD_CREDENTIAL_ONE", "CLOUD_CREDENTIAL_TWO"]');
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
      env: { CLOUD_CREDENTIAL_ONE: "available" },
      projectConfig: {
        execution: {
          mode: "cloud",
          provider: "modal",
          providers: {
            modal: {
              app: "node-runs",
              image: "runner:stable",
              credentialEnv: ["CLOUD_CREDENTIAL_ONE", "CLOUD_CREDENTIAL_TWO"]
            }
          }
        }
      }
    });
    expect(missingCredential.ok).toBe(false);
    if (!missingCredential.ok) {
      expect(missingCredential.diagnostics.map((entry) => entry.code)).toContain("CONFIG_EXECUTION_CREDENTIAL_MISSING");
      expect(missingCredential.diagnostics.map((entry) => entry.message).join("\n")).not.toContain(
        "CLOUD_CREDENTIAL_TWO"
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
              credentialEnv: ["CLOUD_CREDENTIAL_ONE", "CLOUD_CREDENTIAL_TWO"]
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
    }
  });

  it("applies defaults, prompt metadata, project TOML, env, then runtime overrides", () => {
    const project = parseProjectConfigToml(`
schema_version = "1.0"
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
config_dir = ".codex/team"
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
      configDir: ".codex/team"
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
config_dir = ".kimi-code"
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.agents?.CodexAgent?.auth).toBe("api-key");
    expect(parsed.value.agents?.CodexAgent?.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(parsed.value.agents?.KimiAgent).toEqual({
      auth: "api-key",
      apiKeyEnv: "MOONSHOT_API_KEY",
      configDir: ".kimi-code"
    });

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
              agent: "../missing",
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
    expect(resolved.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "CONFIG_MODEL_PROFILE_ID_INVALID",
        "CONFIG_MODEL_AGENT_INVALID",
        "CONFIG_MODEL_DEFAULT_UNKNOWN",
        "CONFIG_MODEL_NAME_EMPTY",
        "CONFIG_MODEL_REASONING_EMPTY",
        "CONFIG_MODEL_TIMEOUT_INVALID"
      ])
    );
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
