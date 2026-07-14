import path from "node:path";

import { describe, expect, it } from "vitest";

import { localSubscriptionAuthPath, subscriptionAuthCopy } from "../src/auth.js";

describe("runtime-only subscription auth", () => {
  it("uses the standard Codex and Claude credential files", () => {
    expect(localSubscriptionAuthPath("openai", {}, "/home/example")).toBe(
      path.join("/home/example", ".codex", "auth.json")
    );
    expect(localSubscriptionAuthPath("anthropic", {}, "/home/example")).toBe(
      path.join("/home/example", ".claude", ".credentials.json")
    );
  });

  it("copies subscription credentials to ephemeral run paths only", () => {
    const codex = subscriptionAuthCopy(
      { provider: "openai", auth_mode: "subscription" },
      { CODEX_HOME: "/secure/codex" },
      "/unused"
    );
    const claude = subscriptionAuthCopy(
      { provider: "anthropic", auth_mode: "subscription" },
      { CLAUDE_CONFIG_DIR: "/secure/claude" },
      "/unused"
    );

    expect(codex).toEqual({ source: "/secure/codex/auth.json", destination: "/run/ultrafuzz-auth/codex/auth.json" });
    expect(claude).toEqual({
      source: "/secure/claude/.credentials.json",
      destination: "/run/ultrafuzz-auth/claude/.credentials.json"
    });
    expect(codex?.destination).not.toContain("/data/");
    expect(claude?.destination).not.toContain("/data/");
  });

  it("does not stage auth files for API-key models", () => {
    expect(subscriptionAuthCopy({ provider: "openai", auth_mode: "api-key" }, {}, "/home/example")).toBeUndefined();
  });
});
