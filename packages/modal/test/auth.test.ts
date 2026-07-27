import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  localSubscriptionAuthPath,
  prepareSubscriptionAuthCopy,
  refreshKimiSubscriptionAuth,
  runnerApiKeySourceEnv,
  subscriptionAuthCopy
} from "../src/auth.js";

describe("runtime-only subscription auth", () => {
  it("uses the standard Codex and Claude credential files", () => {
    expect(localSubscriptionAuthPath("openai", {}, "/home/example")).toBe(
      path.join("/home/example", ".codex", "auth.json")
    );
    expect(localSubscriptionAuthPath("anthropic", {}, "/home/example")).toBe(
      path.join("/home/example", ".claude", ".credentials.json")
    );
    expect(localSubscriptionAuthPath("kimi", {}, "/home/example")).toBe(path.join("/home/example", ".kimi-code"));
    expect(localSubscriptionAuthPath("kimi", { KIMI_CODE_HOME: "/secure/kimi" }, "/unused")).toBe("/secure/kimi");
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
    const kimi = subscriptionAuthCopy(
      { provider: "kimi", auth_mode: "subscription" },
      { KIMI_CODE_HOME: "/secure/kimi" },
      "/unused"
    );

    expect(codex).toEqual({ source: "/secure/codex/auth.json", destination: "/run/ultrafuzz-auth/codex/auth.json" });
    expect(claude).toEqual({
      source: "/secure/claude/.credentials.json",
      destination: "/run/ultrafuzz-auth/claude/.credentials.json"
    });
    expect(kimi).toEqual({
      source: "/secure/kimi",
      destination: "/run/ultrafuzz-auth/kimi/config.toml",
      entries: [
        { source: "/secure/kimi/config.toml", destination: "/run/ultrafuzz-auth/kimi/config.toml" },
        {
          source: "/secure/kimi/credentials/kimi-code.json",
          destination: "/run/ultrafuzz-auth/kimi/credentials/kimi-code.json"
        },
        { source: "/secure/kimi/device_id", destination: "/run/ultrafuzz-auth/kimi/device_id" }
      ]
    });
    expect(codex?.destination).not.toContain("/data/");
    expect(claude?.destination).not.toContain("/data/");
    expect(kimi?.destination).not.toContain("/data/");
  });

  it("does not stage auth files for API-key models", () => {
    expect(subscriptionAuthCopy({ provider: "openai", auth_mode: "api-key" }, {}, "/home/example")).toBeUndefined();
    expect(subscriptionAuthCopy({ provider: "kimi", auth_mode: "api-key" }, {}, "/home/example")).toBeUndefined();
  });

  it("accepts Kimi or Moonshot API keys for Kimi workers", () => {
    expect(runnerApiKeySourceEnv("openai")).toEqual(["OPENAI_API_KEY"]);
    expect(runnerApiKeySourceEnv("kimi")).toEqual(["KIMI_API_KEY", "MOONSHOT_API_KEY"]);
  });

  it("refreshes rotating Kimi OAuth credentials once under the Kimi Code cross-process lock", async () => {
    const source = kimiAuthFixture();
    let refreshes = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      refreshes += 1;
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      await new Promise((resolve) => setImmediate(resolve));
      return new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const options = {
      fetch: fetchImpl,
      now: () => 2_000_000_000
    };
    const credentials = await Promise.all([
      refreshKimiSubscriptionAuth(source, "kimi-k3", {}, options),
      refreshKimiSubscriptionAuth(source, "kimi-k3", {}, options)
    ]);

    expect(refreshes).toBe(1);
    expect(new Set(credentials).size).toBe(1);
    const token = JSON.parse(fs.readFileSync(credentials[0]!, "utf8")) as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
    };
    expect(token).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_at: 2_003_600
    });
    expect(fs.existsSync(path.join(source, "oauth", "kimi-code.lock"))).toBe(false);
  });

  it("snapshots only the Kimi Code files needed by a Modal worker", async () => {
    const source = kimiAuthFixture({ fresh: true });
    fs.appendFileSync(
      path.join(source, "config.toml"),
      `
[providers.unrelated]
type = "kimi"
api_key = "do-not-copy"

[models.unrelated]
provider = "unrelated"
model = "unrelated"
`
    );
    fs.writeFileSync(path.join(source, "credentials", "unrelated-provider.json"), '{"secret":"do-not-copy"}\n');
    fs.writeFileSync(path.join(source, "session_index.jsonl"), '{"unrelated":true}\n');
    fs.mkdirSync(path.join(source, "sessions"));
    fs.writeFileSync(path.join(source, "sessions", "unrelated.json"), "{}\n");

    const prepared = await prepareSubscriptionAuthCopy(
      { provider: "kimi", auth_mode: "subscription", model: "kimi-k3" },
      { KIMI_CODE_HOME: source },
      "/unused",
      { now: () => 2_000_000_000 }
    );
    expect(prepared).toBeDefined();
    expect(prepared?.source).not.toBe(source);
    expect(fs.existsSync(path.join(prepared!.source, "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(prepared!.source, "credentials", "kimi-code.json"))).toBe(true);
    expect(fs.existsSync(path.join(prepared!.source, "device_id"))).toBe(true);
    expect(fs.existsSync(path.join(prepared!.source, "credentials", "unrelated-provider.json"))).toBe(false);
    expect(fs.existsSync(path.join(prepared!.source, "session_index.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(prepared!.source, "sessions"))).toBe(false);
    const snapshotCredentials = JSON.parse(
      fs.readFileSync(path.join(prepared!.source, "credentials", "kimi-code.json"), "utf8")
    ) as { access_token?: string; refresh_token?: string };
    expect(snapshotCredentials.access_token).toBe("old-access");
    expect(snapshotCredentials.refresh_token).toBe("");
    const snapshotConfig = fs.readFileSync(path.join(prepared!.source, "config.toml"), "utf8");
    expect(snapshotConfig).toContain('[providers."managed:kimi-code"]');
    expect(snapshotConfig).toContain("[models.kimi-k3]");
    expect(snapshotConfig).not.toContain("unrelated");
    expect(snapshotConfig).not.toContain("do-not-copy");

    const snapshot = prepared!.source;
    await prepared?.cleanup?.();
    expect(fs.existsSync(snapshot)).toBe(false);
  });

  it("materializes the default kimi-k3 alias from Kimi Code managed k3 config", async () => {
    const source = kimiAuthFixture({ fresh: true, includeKimiK3Alias: false });

    const prepared = await prepareSubscriptionAuthCopy(
      { provider: "kimi", auth_mode: "subscription", model: "kimi-k3" },
      { KIMI_CODE_HOME: source },
      "/unused",
      { now: () => 2_000_000_000 }
    );

    const snapshotConfig = fs.readFileSync(path.join(prepared!.source, "config.toml"), "utf8");
    expect(snapshotConfig).toContain('default_model = "kimi-k3"');
    expect(snapshotConfig).toContain("[models.kimi-k3]");
    expect(snapshotConfig).toContain('model = "k3"');
    expect(snapshotConfig).not.toContain("kimi-code/k3");
    await prepared?.cleanup?.();
  });
});

function kimiAuthFixture(options: { fresh?: boolean; includeKimiK3Alias?: boolean } = {}): string {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-auth-test-"));
  fs.mkdirSync(path.join(source, "credentials"), { recursive: true });
  const kimiK3Alias =
    options.includeKimiK3Alias === false
      ? ""
      : `
[models."kimi-k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
support_efforts = [ "low", "high", "max" ]
default_effort = "max"
`;
  fs.writeFileSync(
    path.join(source, "config.toml"),
    `default_model = "kimi-k3"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
oauth = { storage = "file", key = "oauth/kimi-code" }
${kimiK3Alias}
[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
support_efforts = [ "low", "high", "max" ]
default_effort = "max"
`
  );
  fs.writeFileSync(
    path.join(source, "credentials", "kimi-code.json"),
    `${JSON.stringify({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: options.fresh ? 2_010_000 : 1_999_999,
      expires_in: 3600
    })}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(source, "device_id"), "device-test\n", { mode: 0o600 });
  return source;
}
