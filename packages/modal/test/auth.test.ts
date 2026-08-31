import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  kimiSubscriptionAuthSecretValues,
  kimiSubscriptionAuthSecretValuesFromRoots,
  kimiSubscriptionCredentialFileName,
  localSubscriptionAuthPath,
  prepareSubscriptionAuthCopy,
  reconcileKimiSubscriptionAuthCredential,
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
    expect(() => localSubscriptionAuthPath("deepseek", {}, "/home/example")).toThrow(
      /does not support subscription authentication/u
    );
    expect(() => localSubscriptionAuthPath("openrouter", {}, "/home/example")).toThrow(
      /does not support subscription authentication/u
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
    expect(subscriptionAuthCopy({ provider: "deepseek", auth_mode: "api-key" }, {}, "/home/example")).toBeUndefined();
    expect(subscriptionAuthCopy({ provider: "openrouter", auth_mode: "api-key" }, {}, "/home/example")).toBeUndefined();
    expect(subscriptionAuthCopy({ provider: "kimi", auth_mode: "api-key" }, {}, "/home/example")).toBeUndefined();
  });

  it("accepts Kimi or Moonshot API keys for Kimi workers", () => {
    expect(runnerApiKeySourceEnv("openai")).toEqual(["OPENAI_API_KEY"]);
    expect(runnerApiKeySourceEnv("deepseek")).toEqual(["DEEPSEEK_API_KEY"]);
    expect(runnerApiKeySourceEnv("openrouter")).toEqual(["OPENROUTER_API_KEY"]);
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

  it.each([
    ["malformed", '{"access_token":"old-access","refresh_token":"old-refresh","expires_at":1999999,"expires_in":3600'],
    [
      "duplicate-key",
      '{"access_token":"old-access","access_token":"shadow","refresh_token":"old-refresh","expires_at":1999999,"expires_in":3600}\n'
    ],
    ["invalid UTF-8", Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]
  ])("rejects %s Kimi credential files without calling the provider or mutating evidence", async (_name, bytes) => {
    const source = kimiAuthFixture();
    const credentialPath = path.join(source, "credentials", "kimi-code.json");
    const evidence = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
    fs.writeFileSync(credentialPath, evidence, { mode: 0o600 });
    let fetchCalled = false;

    await expect(
      refreshKimiSubscriptionAuth(
        source,
        "kimi-k3",
        {},
        {
          fetch: async () => {
            fetchCalled = true;
            throw new Error("provider must not be called");
          }
        }
      )
    ).rejects.toThrow(/not strict bounded JSON/u);

    expect(fetchCalled).toBe(false);
    expect(fs.readFileSync(credentialPath)).toEqual(evidence);
    expect(fs.existsSync(path.join(source, "oauth", "kimi-code.lock"))).toBe(false);
  });

  it.each([
    ["malformed", '{"access_token":"fresh"'],
    [
      "duplicate-key",
      '{"access_token":"fresh","access_token":"shadow","refresh_token":"fresh-refresh","expires_in":900}'
    ],
    ["unsupported", '{"access_token":"fresh","refresh_token":"fresh-refresh","expires_in":900,"token_type":17}'],
    ["invalid UTF-8", Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])],
    ["overflowing expiration", '{"access_token":"fresh","refresh_token":"fresh-refresh","expires_in":9007199254740991}']
  ])("rejects %s Kimi OAuth refresh responses without rewriting the current credential", async (_name, body) => {
    const source = kimiAuthFixture();
    const credentialPath = path.join(source, "credentials", "kimi-code.json");
    const before = fs.readFileSync(credentialPath);

    await expect(
      refreshKimiSubscriptionAuth(
        source,
        "kimi-k3",
        {},
        {
          fetch: async () => new Response(body, { status: 200 }),
          now: () => 2_000_000_000
        }
      )
    ).rejects.toThrow(/strict bounded JSON|unsupported response|unsupported expiration/u);

    expect(fs.readFileSync(credentialPath)).toEqual(before);
  });

  it("preserves explicitly scoped Kimi provider fields across a strict refresh", async () => {
    const source = kimiAuthFixture();
    const credentialPath = path.join(source, "credentials", "kimi-code.json");
    fs.writeFileSync(
      credentialPath,
      `${JSON.stringify({
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_at: 1_999_999,
        expires_in: 3_600,
        provider_session: { generation: 1 }
      })}\n`,
      { mode: 0o600 }
    );

    await refreshKimiSubscriptionAuth(
      source,
      "kimi-k3",
      {},
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              access_token: "fresh-access",
              refresh_token: "fresh-refresh",
              expires_in: 900,
              provider_rotation: { generation: 2 }
            }),
            { status: 200 }
          ),
        now: () => 2_000_000_000
      }
    );

    expect(JSON.parse(fs.readFileSync(credentialPath, "utf8"))).toEqual({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_at: 2_000_900,
      expires_in: 900,
      provider_session: { generation: 1 },
      provider_rotation: { generation: 2 }
    });
  });

  it("uses a persisted Kimi provider OAuth host for refresh unless an env override is present", async () => {
    const urls: string[] = [];
    const refreshResponse = () =>
      new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 900
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return refreshResponse();
    };

    const scopedCredential = await refreshKimiSubscriptionAuth(
      kimiAuthFixture({
        oauthHost: "https://auth.persisted.example",
        oauthKey: "oauth/scoped-kimi-code"
      }),
      "kimi-k3",
      {},
      { fetch: fetchImpl, now: () => 2_000_000_000 }
    );
    await refreshKimiSubscriptionAuth(
      kimiAuthFixture({ oauthHost: "https://auth.persisted.example" }),
      "kimi-k3",
      { KIMI_OAUTH_HOST: "https://auth.env.example/" },
      { fetch: fetchImpl, now: () => 2_000_000_000 }
    );
    await refreshKimiSubscriptionAuth(
      kimiAuthFixture({ oauthHost: "https://auth.persisted.example" }),
      "kimi-k3",
      {
        KIMI_CODE_OAUTH_HOST: "https://auth.code.example",
        KIMI_OAUTH_HOST: "https://auth.env.example"
      },
      { fetch: fetchImpl, now: () => 2_000_000_000 }
    );

    expect(urls).toEqual([
      "https://auth.persisted.example/api/oauth/token",
      "https://auth.env.example/api/oauth/token",
      "https://auth.code.example/api/oauth/token"
    ]);
    expect(path.basename(scopedCredential)).toBe("scoped-kimi-code.json");
    expect(
      fs.existsSync(path.join(path.dirname(path.dirname(scopedCredential)), "oauth", "scoped-kimi-code.lock"))
    ).toBe(false);
  });

  it("does not use the obsolete snake-case Kimi OAuth host as refresh authority", async () => {
    const source = kimiAuthFixture({ oauthHost: "https://obsolete.example" });
    const configPath = path.join(source, "config.toml");
    fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace("oauthHost =", "oauth_host ="), "utf8");
    const urls: string[] = [];

    await refreshKimiSubscriptionAuth(
      source,
      "kimi-k3",
      {},
      {
        fetch: async (input) => {
          urls.push(String(input));
          return new Response(
            JSON.stringify({
              access_token: "fresh-access",
              refresh_token: "fresh-refresh",
              expires_in: 900
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        },
        now: () => 2_000_000_000
      }
    );

    expect(urls).toEqual(["https://auth.kimi.com/api/oauth/token"]);
  });

  it("rejects unsafe Kimi OAuth refresh hosts before sending refresh tokens", async () => {
    const source = kimiAuthFixture();
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch must not be called");
    };

    for (const host of [
      "http://auth.kimi.example",
      "https://user:pass@auth.kimi.example",
      "https://auth.kimi.example/token?leak=1",
      "https://auth.kimi.example/token#fragment"
    ]) {
      await expect(
        refreshKimiSubscriptionAuth(source, "kimi-k3", { KIMI_CODE_OAUTH_HOST: host }, { fetch: fetchImpl })
      ).rejects.toThrow(/Kimi OAuth host must be an HTTPS URL without credentials, a query, or a fragment/u);
    }

    await expect(
      refreshKimiSubscriptionAuth(
        kimiAuthFixture({ fresh: true, oauthHost: "http://auth.kimi.example" }),
        "kimi-k3",
        {},
        {
          fetch: fetchImpl
        }
      )
    ).rejects.toThrow(/Kimi OAuth host must be an HTTPS URL without credentials, a query, or a fragment/u);
  });

  it("ignores access-only Modal Kimi credentials during host reconciliation", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const credentialFile = await kimiSubscriptionCredentialFileName("kimi-k3", { KIMI_CODE_HOME: source });

    expect(credentialFile).toBe("kimi-code.json");
    await expect(
      reconcileKimiSubscriptionAuthCredential(
        "kimi-k3",
        `${JSON.stringify({
          access_token: "remote-access",
          expires_at: 2_020_000,
          expires_in: 900,
          token_type: "Bearer",
          scope: "openid"
        })}\n`,
        { KIMI_CODE_HOME: source }
      )
    ).resolves.toBe(false);

    const token = JSON.parse(fs.readFileSync(path.join(source, "credentials", credentialFile), "utf8")) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
    };
    expect(token).toMatchObject({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: 2_010_000
    });
  });

  it("returns selected Kimi subscription access and refresh tokens without unrelated credentials", async () => {
    const source = kimiAuthFixture({ oauthKey: "oauth/selected-kimi" });
    fs.writeFileSync(
      path.join(source, "credentials", "unrelated-provider.json"),
      `${JSON.stringify({
        access_token: "unrelated-access",
        refresh_token: "unrelated-refresh",
        expires_at: 2_010_000,
        expires_in: 900
      })}\n`
    );

    await expect(kimiSubscriptionAuthSecretValues("kimi-k3", { KIMI_CODE_HOME: source })).resolves.toEqual([
      "old-access",
      "old-refresh"
    ]);
  });

  it("resolves Kimi subscription secrets from separate config and credential roots", async () => {
    const configRoot = kimiAuthFixture({ oauthKey: "oauth/selected-kimi" });
    const credentialRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-kimi-credential-root-test-")
    );
    fs.mkdirSync(path.join(credentialRoot, "credentials"), { recursive: true });
    fs.writeFileSync(
      path.join(credentialRoot, "credentials", "selected-kimi.json"),
      `${JSON.stringify({
        access_token: "remote-access",
        refresh_token: "remote-refresh",
        expires_at: 2_010_000,
        expires_in: 900
      })}\n`
    );

    await expect(kimiSubscriptionAuthSecretValuesFromRoots("kimi-k3", configRoot, credentialRoot)).resolves.toEqual([
      "remote-access",
      "remote-refresh"
    ]);
  });

  it("does not overwrite a newer host Kimi refresh token with stale Modal state", async () => {
    const source = kimiAuthFixture({ fresh: true });

    await expect(
      reconcileKimiSubscriptionAuthCredential(
        "kimi-k3",
        `${JSON.stringify({
          access_token: "stale-remote-access",
          refresh_token: "stale-remote-refresh",
          expires_at: 2_009_970,
          expires_in: 900
        })}\n`,
        { KIMI_CODE_HOME: source }
      )
    ).resolves.toBe(false);

    const token = JSON.parse(fs.readFileSync(path.join(source, "credentials", "kimi-code.json"), "utf8")) as {
      access_token?: string;
      refresh_token?: string;
    };
    expect(token.access_token).toBe("old-access");
    expect(token.refresh_token).toBe("old-refresh");
  });

  it("promotes a refreshed Modal Kimi token only when it descends from the staged host token", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const sourceRefreshTokenSha256 = createHash("sha256").update("old-refresh").digest("hex");

    await expect(
      reconcileKimiSubscriptionAuthCredential(
        "kimi-k3",
        `${JSON.stringify({
          access_token: "remote-successor-access",
          refresh_token: "remote-successor-refresh",
          expires_at: 2_020_000,
          expires_in: 900
        })}\n`,
        { KIMI_CODE_HOME: source },
        os.homedir(),
        { sourceRefreshTokenSha256 }
      )
    ).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(source, "credentials", "kimi-code.json"), "utf8"))).toMatchObject({
      access_token: "remote-successor-access",
      refresh_token: "remote-successor-refresh",
      expires_at: 2_020_000
    });

    await expect(
      reconcileKimiSubscriptionAuthCredential(
        "kimi-k3",
        `${JSON.stringify({
          access_token: "unrelated-remote-access",
          refresh_token: "unrelated-remote-refresh",
          expires_at: 2_030_000,
          expires_in: 900
        })}\n`,
        { KIMI_CODE_HOME: source },
        os.homedir(),
        { sourceRefreshTokenSha256 }
      )
    ).resolves.toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(source, "credentials", "kimi-code.json"), "utf8"))).toMatchObject({
      access_token: "remote-successor-access",
      refresh_token: "remote-successor-refresh",
      expires_at: 2_020_000
    });
  });

  it("snapshots only the Kimi Code files needed by a Modal worker", async () => {
    const credentialFile = "scoped-kimi-code.json";
    const source = kimiAuthFixture({
      fresh: true,
      oauthHost: "https://auth.persisted.example",
      oauthKey: "oauth/scoped-kimi-code"
    });
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
    expect(fs.existsSync(path.join(prepared!.source, "credentials", credentialFile))).toBe(true);
    expect(fs.existsSync(path.join(prepared!.source, "device_id"))).toBe(true);
    expect(fs.existsSync(path.join(prepared!.source, "credentials", "unrelated-provider.json"))).toBe(false);
    expect(fs.existsSync(path.join(prepared!.source, "session_index.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(prepared!.source, "sessions"))).toBe(false);
    const snapshotCredentials = JSON.parse(
      fs.readFileSync(path.join(prepared!.source, "credentials", credentialFile), "utf8")
    ) as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number };
    expect(snapshotCredentials.access_token).toBe("old-access");
    expect(snapshotCredentials.refresh_token).toBe("old-refresh");
    expect(snapshotCredentials.expires_at).toBe(2_010_000);
    const sourceCredentials = JSON.parse(fs.readFileSync(path.join(source, "credentials", credentialFile), "utf8")) as {
      refresh_token?: string;
    };
    expect(sourceCredentials.refresh_token).toBe("old-refresh");
    const snapshotConfig = fs.readFileSync(path.join(prepared!.source, "config.toml"), "utf8");
    expect(snapshotConfig).toContain('[providers."managed:kimi-code"]');
    expect(snapshotConfig).toContain('oauthHost = "https://auth.persisted.example"');
    expect(snapshotConfig).toContain("[models.kimi-k3]");
    expect(snapshotConfig).not.toContain("unrelated");
    expect(snapshotConfig).not.toContain("do-not-copy");

    const snapshot = prepared!.source;
    await prepared?.cleanup?.();
    expect(fs.existsSync(snapshot)).toBe(false);
  });

  it("keeps refreshable 15-minute Kimi worker snapshots for normal row durations", async () => {
    const source = kimiAuthFixture({ fresh: true, expiresAt: 2_000_900, expiresIn: 900 });

    const prepared = await prepareSubscriptionAuthCopy(
      { provider: "kimi", auth_mode: "subscription", model: "kimi-k3" },
      { KIMI_CODE_HOME: source },
      "/unused",
      { now: () => 2_000_000_000 }
    );

    const snapshotCredentials = JSON.parse(
      fs.readFileSync(path.join(prepared!.source, "credentials", "kimi-code.json"), "utf8")
    ) as { refresh_token?: string; expires_at?: number; expires_in?: number };
    expect(snapshotCredentials).toMatchObject({
      refresh_token: "old-refresh",
      expires_at: 2_000_900,
      expires_in: 900
    });
    await prepared?.cleanup?.();
  });

  it("refreshes near-expiry 15-minute Kimi credentials before Modal worker staging", async () => {
    const source = kimiAuthFixture({ fresh: true, expiresAt: 2_000_400, expiresIn: 900 });
    let refreshes = 0;
    const fetchImpl: typeof fetch = async () => {
      refreshes += 1;
      return new Response(
        JSON.stringify({
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          expires_in: 900,
          token_type: "Bearer",
          scope: "openid"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const prepared = await prepareSubscriptionAuthCopy(
      { provider: "kimi", auth_mode: "subscription", model: "kimi-k3" },
      { KIMI_CODE_HOME: source },
      "/unused",
      { fetch: fetchImpl, now: () => 2_000_000_000 }
    );

    expect(refreshes).toBe(1);
    const snapshotCredentials = JSON.parse(
      fs.readFileSync(path.join(prepared!.source, "credentials", "kimi-code.json"), "utf8")
    ) as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number };
    expect(snapshotCredentials).toMatchObject({
      access_token: "refreshed-access",
      refresh_token: "refreshed-refresh",
      expires_at: 2_000_900,
      expires_in: 900
    });
    expect(JSON.parse(fs.readFileSync(path.join(source, "credentials", "kimi-code.json"), "utf8"))).toMatchObject({
      access_token: "refreshed-access",
      refresh_token: "refreshed-refresh"
    });
    await prepared?.cleanup?.();
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
    expect(snapshotConfig).toMatch(/support_efforts\s*=\s*\[\s*"low",\s*"high",\s*"max"\s*\]/u);
    expect(snapshotConfig).not.toContain("kimi-code/k3");
    await prepared?.cleanup?.();
  });
});

function kimiAuthFixture(
  options: {
    fresh?: boolean;
    includeKimiK3Alias?: boolean;
    expiresAt?: number;
    expiresIn?: number;
    oauthHost?: string;
    oauthKey?: string;
  } = {}
): string {
  const source = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-kimi-auth-test-"));
  fs.mkdirSync(path.join(source, "credentials"), { recursive: true });
  const oauthKey = options.oauthKey ?? "oauth/kimi-code";
  const tokenName = path.posix.basename(oauthKey.trim());
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
oauth = { storage = "file", key = ${JSON.stringify(oauthKey)}${options.oauthHost === undefined ? "" : `, oauthHost = ${JSON.stringify(options.oauthHost)}`} }
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
    path.join(source, "credentials", `${tokenName}.json`),
    `${JSON.stringify({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: options.expiresAt ?? (options.fresh ? 2_010_000 : 1_999_999),
      expires_in: options.expiresIn ?? 3600
    })}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(source, "device_id"), "device-test\n", { mode: 0o600 });
  return source;
}
