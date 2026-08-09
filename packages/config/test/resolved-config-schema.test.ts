import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONFIG_SCHEMA_EXPORTS,
  CONFIG_SCHEMA_METADATA,
  RESOLVED_CONFIG_JSON_SCHEMA_ID,
  RESOLVED_CONFIG_SCHEMA_FILENAME,
  RESOLVED_CONFIG_SCHEMA_VERSION,
  configSchemaBundleDigest,
  configSchemaDirectory,
  configSchemaRegistry,
  parseProjectConfigToml,
  parseResolvedConfigJsonBytes,
  resolvedConfigJsonSchema,
  resolvedConfigValidatorsAgree,
  resolvedConfigZodSchema,
  resolveConfig,
  serializeResolvedConfigJsonBytes,
  validateResolvedConfigJson
} from "../src/index.js";

const EXPECTED_SCHEMA_SHA256 = "7857da04f0b0154e09324ecbd39e18afcd5bf6b0a6007f6a6f818495caff7250";
const EXPECTED_BUNDLE_SHA256 = "4803cb5946019d5fbc7f663580f930cec93107b0b966296adb01ac4df310f5fe";

describe("resolved config JSON contract", () => {
  it("registers the exact checked-in Draft 2020-12 schema and stable digests", () => {
    const schemaPath = path.join(configSchemaDirectory(), RESOLVED_CONFIG_SCHEMA_FILENAME);
    const schemaBytes = fs.readFileSync(schemaPath);
    const canonical = JSON.parse(schemaBytes.toString("utf8")) as Record<string, unknown>;
    const registry = configSchemaRegistry();

    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      filename: RESOLVED_CONFIG_SCHEMA_FILENAME,
      id: RESOLVED_CONFIG_JSON_SCHEMA_ID,
      role: "runtime-state",
      sha256: EXPECTED_SCHEMA_SHA256,
      typescriptExport: "resolvedConfigJsonSchema",
      zodParser: "resolvedConfigZodSchema"
    });
    expect(registry[0]?.contractIds).toEqual([]);
    expect(registry[0]?.semanticGates).toEqual(CONFIG_SCHEMA_METADATA[RESOLVED_CONFIG_SCHEMA_FILENAME]?.semanticGates);
    expect(registry[0]?.schema).toEqual(canonical);
    expect(resolvedConfigJsonSchema).toEqual(canonical);
    expect(CONFIG_SCHEMA_EXPORTS.resolvedConfigJsonSchema).toBe(resolvedConfigJsonSchema);
    expect(crypto.createHash("sha256").update(schemaBytes).digest("hex")).toBe(EXPECTED_SCHEMA_SHA256);
    expect(configSchemaBundleDigest()).toBe(EXPECTED_BUNDLE_SHA256);
  });

  it("accepts and round-trips the canonical fixture as the exact immutable serialized bytes", () => {
    const fixtureBytes = readFixture("resolved-config.valid.json");
    const parsed = parseResolvedConfigJsonBytes(fixtureBytes);
    const serialized = serializeResolvedConfigJsonBytes(parsed);
    const resolvedDefault = resolveConfig({ env: {} });

    expect(parsed.schemaVersion).toBe(RESOLVED_CONFIG_SCHEMA_VERSION);
    expect(serialized.equals(fixtureBytes)).toBe(true);
    expect(resolvedDefault.ok).toBe(true);
    if (resolvedDefault.ok)
      expect(serializeResolvedConfigJsonBytes(resolvedDefault.value).equals(fixtureBytes)).toBe(true);
    expect(validateResolvedConfigJson(parsed)).toEqual({ ok: true, issues: [], truncated: false });
    const zod = resolvedConfigZodSchema.safeParse(parsed);
    expect(zod.success).toBe(true);
    if (zod.success) expect(zod.data).toEqual(parsed);
  });

  it("rejects the checked-in historical-version fixture without aliasing or conversion", () => {
    const fixtureBytes = readFixture("resolved-config.invalid-version.json");
    const value = JSON.parse(fixtureBytes.toString("utf8")) as unknown;

    expect(validateResolvedConfigJson(value).ok).toBe(false);
    expect(resolvedConfigZodSchema.safeParse(value).success).toBe(false);
    expect(resolvedConfigValidatorsAgree(value)).toBe(true);
    expect(() => parseResolvedConfigJsonBytes(fixtureBytes)).toThrow(/does not match/u);
  });

  it("keeps Ajv and non-transforming Zod aligned on targeted negative mutations", () => {
    const mutations: Array<{ label: string; mutate: (value: Record<string, unknown>) => void }> = [
      { label: "unknown root field", mutate: (value) => void (value.legacy = true) },
      { label: "unknown nested field", mutate: (value) => void (record(value.run).legacy = true) },
      { label: "missing required boolean", mutate: (value) => void delete record(value.run).keepWorkspaces },
      { label: "nullable optional", mutate: (value) => void (record(value.project).name = null) },
      { label: "bad project path", mutate: (value) => void (record(value.project).repo = "../target") },
      { label: "trailing path separator", mutate: (value) => void (record(value.project).repo = "target/") },
      { label: "zero parallelism", mutate: (value) => void (record(value.run).maxParallelAgents = 0) },
      {
        label: "unsafe integer parallelism",
        mutate: (value) => void (record(value.run).maxParallelAgents = Number.MAX_SAFE_INTEGER + 1)
      },
      { label: "local provider", mutate: (value) => void (record(value.execution).provider = "modal") },
      { label: "cloud without provider settings", mutate: (value) => void (record(value.execution).mode = "cloud") },
      {
        label: "bad node map key",
        mutate: (value) => void (record(record(value.execution).nodes).Uppercase = { resources: {} })
      },
      {
        label: "unknown node resource",
        mutate: (value) =>
          void (record(record(record(record(value.execution).nodes)["project-discovery"]).resources).gpu = 1)
      },
      {
        label: "duplicate credentials",
        mutate: (value) => {
          const execution = record(value.execution);
          execution.mode = "cloud";
          execution.provider = "modal";
          execution.providers = {
            modal: {
              app: "ultrafuzz",
              image: "runner:current",
              credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_ID"]
            }
          };
        }
      },
      { label: "empty profiles", mutate: (value) => void (record(value.models).profiles = {}) },
      { label: "unknown profile property", mutate: (value) => void (profile(value, "default").temperature = 1) },
      { label: "unsupported Kimi reasoning", mutate: (value) => void (profile(value, "kimi").reasoning = "xhigh") },
      {
        label: "DeepSeek subscription",
        mutate: (value) => void (record(record(value.agents).DeepSeekAgent).auth = "subscription")
      },
      {
        label: "missing api key env",
        mutate: (value) => void delete record(record(value.agents).CodexAgent).apiKeyEnv
      },
      { label: "empty agents", mutate: (value) => void (value.agents = {}) },
      { label: "bad trust model", mutate: (value) => void (record(value.permissions).trustModel = "sandbox") },
      { label: "bad endpoint", mutate: (value) => void (evalProvider(value, "braintrust").endpoint = "http://local") },
      { label: "old 1.0 version", mutate: (value) => void (value.schemaVersion = "1.0") },
      { label: "old namespaced version", mutate: (value) => void (value.schemaVersion = "ultrafuzz.config.v1") },
      { label: "case variant", mutate: (value) => void (value.schemaVersion = "ULTRAFUZZ.CONFIG.V2") }
    ];

    for (const mutation of mutations) {
      const value = validFixture();
      if (mutation.label === "unknown node resource") {
        record(value.execution).nodes = { "project-discovery": { resources: {} } };
      }
      mutation.mutate(value);
      const ajv = validateResolvedConfigJson(value).ok;
      const zod = resolvedConfigZodSchema.safeParse(value).success;
      expect({ label: mutation.label, ajv, zod }).toEqual({ label: mutation.label, ajv: false, zod: false });
    }
  });

  it("keeps Ajv and Zod aligned on a fully typed cloud configuration", () => {
    const value = validFixture();
    const execution = record(value.execution);
    execution.mode = "cloud";
    execution.provider = "modal";
    execution.nodes = {
      "project-discovery": {
        resources: { cpu: 8, memoryMiB: 16_384, timeoutSeconds: 3_600 }
      }
    };
    execution.providers = {
      modal: {
        app: "ultrafuzz",
        image: "runner:current",
        region: "us-east",
        credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
      }
    };
    record(value.project).name = "Ultrafuzz target";
    record(value.invariants).referenceExpectationEnforcement = "fail";
    evalProvider(value, "braintrust").endpoint = "https://api.braintrust.dev";

    expect(validateResolvedConfigJson(value).ok).toBe(true);
    expect(resolvedConfigZodSchema.safeParse(value).success).toBe(true);
    expect(resolvedConfigValidatorsAgree(value)).toBe(true);
  });

  it("rejects duplicate keys and invalid UTF-8 before schema validation", () => {
    const duplicate = Buffer.from(
      readFixture("resolved-config.valid.json")
        .toString("utf8")
        .replace(
          '"schemaVersion": "ultrafuzz.config.v2",',
          '"schemaVersion": "ultrafuzz.config.v2",\n  "schemaVersion": "ultrafuzz.config.v2",'
        ),
      "utf8"
    );
    expect(() => parseResolvedConfigJsonBytes(duplicate)).toThrow(/duplicate/u);
    expect(() => parseResolvedConfigJsonBytes(Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]))).toThrow(/UTF-8/u);
  });

  it.each(["1.0", "v2", "ultrafuzz.config.v1", "ULTRAFUZZ.CONFIG.V2", ""])(
    "rejects TOML schema version spelling %j without normalizing it",
    (schemaVersion) => {
      const parsed = parseProjectConfigToml(`schema_version = ${JSON.stringify(schemaVersion)}\n`);
      expect(parsed.ok).toBe(false);
      expect(parsed.diagnostics).toContainEqual(
        expect.objectContaining({ code: "CONFIG_SCHEMA_VERSION_UNSUPPORTED", path: ["schema_version"] })
      );
    }
  );
});

function fixturePath(filename: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", filename);
}

function readFixture(filename: string): Buffer {
  return fs.readFileSync(fixturePath(filename));
}

function validFixture(): Record<string, unknown> {
  return JSON.parse(readFixture("resolved-config.valid.json").toString("utf8")) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("fixture value is not an object");
  return value as Record<string, unknown>;
}

function profile(value: Record<string, unknown>, id: string): Record<string, unknown> {
  return record(record(record(value.models).profiles)[id]);
}

function evalProvider(value: Record<string, unknown>, id: string): Record<string, unknown> {
  return record(record(record(value.eval).providers)[id]);
}
