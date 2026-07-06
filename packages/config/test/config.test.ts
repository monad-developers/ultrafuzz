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
  loadProjectConfig,
  parseProjectConfigToml,
  redactDiagnostics,
  redactResolvedConfig,
  resolveConfig,
  restoreRedactedConfig,
  serializeRedactedResolvedConfigToml,
  validateTriageConfig
} from "../src/index.js";

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
  });

  it("applies defaults, prompt metadata, project TOML, env, then runtime overrides", () => {
    const project = parseProjectConfigToml(`
schema_version = "1.0"
dynamic_strategies_enumerator = 5

[run]
max_parallel_agents = 2
default_timeout_seconds = 1200

[models]
default = "project-model"

[models.project-model]
agent = "CodexAgent"
model = "gpt-5.5"
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
    expect(resolved.value.triage).toEqual({ quorum: 2, panelSize: 4 });
    expect(resolved.value.models.default).toBe("project-model");
    expect(resolved.value.models.profiles["project-model"]?.agent).toBe("CodexAgent");
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
  it("fails invalid model profiles with typed diagnostics", () => {
    const resolved = resolveConfig({
      env: {},
      projectConfig: {
        models: {
          profiles: {
            "../bad": {
              agent: "../missing",
              model: "",
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
        "CONFIG_MODEL_TIMEOUT_INVALID"
      ])
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
