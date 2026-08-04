import { describe, expect, it } from "vitest";

import { parsePublicModelIdentity, publicModelIdentityScope } from "../src/public-diagnostics.js";

const DEEPSEEK_ALIAS_IDENTITY = {
  schema_version: "ultrafuzz.eval.model-identity.v1",
  configured_model: "deepseek-v4-flash",
  provider_reported_model: "deepseek-v4-flash",
  identity_scope: "provider-reported-alias",
  provider_version_status: "unverified",
  invocation_count: 1,
  invocations: [
    {
      invocation_id: "workflow-one/task-one/0",
      configured_model: "deepseek-v4-flash",
      provider_reported_model: "deepseek-v4-flash"
    }
  ]
} as const;

describe("public model identity", () => {
  it("requires explicit alias scope with an unverified provider version for DeepSeek V4 Flash", () => {
    expect(parsePublicModelIdentity(DEEPSEEK_ALIAS_IDENTITY)).toEqual(DEEPSEEK_ALIAS_IDENTITY);
    expect(publicModelIdentityScope("deepseek-v4-flash")).toBe("provider-reported-alias");
    expect(publicModelIdentityScope("claude-sonnet-5")).toBe("provider-reported-model-id");

    for (const field of ["identity_scope", "provider_version_status"] as const) {
      const missing = structuredClone(DEEPSEEK_ALIAS_IDENTITY) as Record<string, unknown>;
      delete missing[field];
      expect(() => parsePublicModelIdentity(missing)).toThrow();
    }
  });

  it("rejects scope relabeling, concrete-version claims, and unknown identity fields", () => {
    expect(() =>
      parsePublicModelIdentity({
        ...DEEPSEEK_ALIAS_IDENTITY,
        identity_scope: "provider-reported-model-id"
      })
    ).toThrow(/scope/u);
    expect(() =>
      parsePublicModelIdentity({
        ...DEEPSEEK_ALIAS_IDENTITY,
        provider_version_status: "verified"
      })
    ).toThrow();
    expect(() =>
      parsePublicModelIdentity({
        ...DEEPSEEK_ALIAS_IDENTITY,
        provider_version: "DeepSeek-V4-Flash-0731"
      })
    ).toThrow();
  });
});
