import os from "node:os";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import lockfile from "proper-lockfile";
import { parse, stringify } from "smol-toml";

import type { ModalModelSpec, ModelProvider } from "./defaults.js";
import { remoteAuthDir, remoteAuthPath } from "./layout.js";

export interface SubscriptionAuthCopy {
  source: string;
  destination: string;
  entries?: SubscriptionAuthCopyEntry[];
  cleanup?: () => Promise<void>;
}

export interface SubscriptionAuthCopyEntry {
  source: string;
  destination: string;
}

export interface KimiSubscriptionAuthPreparationOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

export function subscriptionAuthCopy(
  model: Pick<ModalModelSpec, "provider" | "auth_mode">,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir()
): SubscriptionAuthCopy | undefined {
  if (model.auth_mode !== "subscription") {
    return undefined;
  }
  if (model.provider === "kimi") {
    const source = localSubscriptionAuthPath(model.provider, env, home);
    return {
      source,
      destination: remoteAuthPath(model.provider),
      entries: kimiSubscriptionAuthEntries(source)
    };
  }
  return {
    source: localSubscriptionAuthPath(model.provider, env, home),
    destination: remoteAuthPath(model.provider)
  };
}

export async function prepareSubscriptionAuthCopy(
  model: Pick<ModalModelSpec, "provider" | "auth_mode" | "model">,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir(),
  options: KimiSubscriptionAuthPreparationOptions = {}
): Promise<SubscriptionAuthCopy | undefined> {
  const direct = subscriptionAuthCopy(model, env, home);
  if (direct === undefined || model.provider !== "kimi") return direct;

  const source = direct.source;
  const credentialPath = await refreshKimiSubscriptionAuth(source, model.model, env, options);
  const snapshot = await mkdtemp(path.join(os.tmpdir(), "ultrafuzz-kimi-auth-"));
  try {
    const config = kimiConfig(await readFile(path.join(source, "config.toml"), "utf8"));
    const token = kimiOAuthToken(await readFile(credentialPath, "utf8"), credentialPath);
    await writeFile(path.join(snapshot, "config.toml"), kimiSnapshotConfig(config, model.model), {
      encoding: "utf8",
      mode: 0o600
    });
    await mkdir(path.join(snapshot, "credentials"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(snapshot, "credentials", path.basename(credentialPath)),
      `${JSON.stringify(kimiWorkerOAuthSnapshot(token), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await cp(path.join(source, "device_id"), path.join(snapshot, "device_id"));
    return {
      source: snapshot,
      destination: remoteAuthPath("kimi"),
      entries: kimiSubscriptionAuthEntries(snapshot, path.basename(credentialPath)),
      cleanup: async () => {
        await rm(snapshot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

export async function refreshKimiSubscriptionAuth(
  source: string,
  model: string,
  env: Record<string, string | undefined> = process.env,
  options: KimiSubscriptionAuthPreparationOptions = {}
): Promise<string> {
  const config = kimiConfig(await readFile(path.join(source, "config.toml"), "utf8"));
  const credentialPath = kimiCredentialPath(source, config, model);
  await access(credentialPath, constants.R_OK | constants.W_OK);
  await access(path.join(source, "device_id"), constants.R_OK);

  const release = await acquireKimiRefreshLock(source);
  try {
    const token = kimiOAuthToken(await readFile(credentialPath, "utf8"), credentialPath);
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    const threshold = Math.max(300, Math.floor((token.expires_in ?? 0) * 0.5));
    if (token.expires_at - threshold > now) return credentialPath;
    if (token.refresh_token.trim() === "") {
      throw new Error("Kimi subscription token is near expiry and has no refresh token; run `kimi login`");
    }
    const fetchImpl = options.fetch ?? fetch;
    const oauthHost = (env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST ?? "https://auth.kimi.com").replace(/\/+$/u, "");
    const response = await fetchImpl(`${oauthHost}/api/oauth/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Msh-Platform": "kimi_code_cli",
        "X-Msh-Version": "0.29.1",
        "X-Msh-Device-Id": (await readFile(path.join(source, "device_id"), "utf8")).trim(),
        "X-Msh-Device-Name": os.hostname(),
        "X-Msh-Device-Model": os.arch(),
        "X-Msh-Os-Version": `${os.type()} ${os.release()}`
      },
      body: new URLSearchParams({
        client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
        grant_type: "refresh_token",
        refresh_token: token.refresh_token
      })
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(`Kimi subscription token refresh failed with HTTP ${response.status}`);
    }
    const refreshed = kimiOAuthRefresh(payload);
    const next = {
      ...token,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: now + refreshed.expires_in,
      expires_in: refreshed.expires_in,
      token_type: refreshed.token_type ?? token.token_type ?? "Bearer",
      scope: refreshed.scope ?? token.scope ?? ""
    };
    await writeJsonAtomic(credentialPath, next);
    return credentialPath;
  } finally {
    await release();
  }
}

export function localSubscriptionAuthPath(
  provider: ModelProvider,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir()
): string {
  if (provider === "openai") {
    return path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "auth.json");
  }
  if (provider === "anthropic") {
    return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), ".credentials.json");
  }
  return env.KIMI_CODE_HOME ?? env.KIMI_SHARE_DIR ?? path.join(home, ".kimi-code");
}

export function runnerApiKeyEnv(provider: ModelProvider): "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "KIMI_API_KEY" {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  return "KIMI_API_KEY";
}

export function runnerApiKeySourceEnv(provider: ModelProvider): readonly string[] {
  if (provider === "kimi") return ["KIMI_API_KEY", "MOONSHOT_API_KEY"];
  return [runnerApiKeyEnv(provider)];
}

function kimiSubscriptionAuthEntries(source: string, credentialFile = "kimi-code.json"): SubscriptionAuthCopyEntry[] {
  return [
    { source: path.join(source, "config.toml"), destination: path.posix.join(remoteAuthDir("kimi"), "config.toml") },
    {
      source: path.join(source, "credentials", credentialFile),
      destination: path.posix.join(remoteAuthDir("kimi"), "credentials", credentialFile)
    },
    { source: path.join(source, "device_id"), destination: path.posix.join(remoteAuthDir("kimi"), "device_id") }
  ];
}

interface KimiConfig {
  models?: Record<string, Record<string, unknown>>;
  providers?: Record<string, Record<string, unknown>>;
  thinking?: unknown;
}

interface KimiOAuthToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
}

function kimiConfig(text: string): KimiConfig {
  const value = parse(text) as unknown;
  if (!isRecord(value)) throw new Error("Kimi Code config.toml must contain a TOML document");
  return value as KimiConfig;
}

function kimiCredentialPath(source: string, config: KimiConfig, model: string): string {
  const { providerName, provider } = kimiModelProvider(config, model);
  const oauth = provider.oauth;
  if (!isRecord(oauth) || oauth.storage !== "file" || typeof oauth.key !== "string") {
    throw new Error(`Kimi subscription provider ${providerName} must use file-backed OAuth credentials`);
  }
  const tokenName = path.posix.basename(oauth.key.trim());
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(tokenName)) {
    throw new Error(`Kimi subscription provider ${providerName} has an unsafe OAuth credential key`);
  }
  return path.join(source, "credentials", `${tokenName}.json`);
}

function kimiSnapshotConfig(config: KimiConfig, model: string): string {
  const { modelConfig, providerName, provider } = kimiModelProvider(config, model);
  const snapshot: Record<string, unknown> = {
    default_model: model,
    providers: { [providerName]: provider },
    models: { [model]: modelConfig }
  };
  if (isRecord(config.thinking)) snapshot.thinking = config.thinking;
  return stringify(snapshot as Parameters<typeof stringify>[0]);
}

function kimiModelProvider(
  config: KimiConfig,
  model: string
): { modelConfig: Record<string, unknown>; providerName: string; provider: Record<string, unknown> } {
  const modelConfig = config.models?.[model] ?? (model === "kimi-k3" ? config.models?.["kimi-code/k3"] : undefined);
  if (!isRecord(modelConfig)) {
    throw new Error(`Kimi subscription model alias is missing from config.toml: ${model}`);
  }
  const providerName = modelConfig.provider;
  if (providerName === undefined) {
    throw new Error(`Kimi subscription model alias is missing from config.toml: ${model}`);
  }
  if (typeof providerName !== "string") {
    throw new Error(`Kimi subscription model ${model} has an invalid provider`);
  }
  const provider = config.providers?.[providerName];
  if (!isRecord(provider)) {
    throw new Error(`Kimi subscription provider is missing from config.toml: ${providerName}`);
  }
  return { modelConfig, providerName, provider };
}

function kimiWorkerOAuthSnapshot(token: KimiOAuthToken): KimiOAuthToken {
  return {
    ...token,
    refresh_token: ""
  };
}

function kimiOAuthToken(text: string, credentialPath: string): KimiOAuthToken {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Kimi subscription credentials are invalid JSON: ${credentialPath}`);
  }
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    typeof value.refresh_token !== "string" ||
    typeof value.expires_at !== "number"
  ) {
    throw new Error(`Kimi subscription credentials have an unsupported shape: ${credentialPath}`);
  }
  return value as KimiOAuthToken;
}

function kimiOAuthRefresh(value: unknown): {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
} {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    value.access_token === "" ||
    typeof value.refresh_token !== "string" ||
    value.refresh_token === "" ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  ) {
    throw new Error("Kimi subscription token refresh returned an unsupported response");
  }
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_in: value.expires_in,
    ...(typeof value.token_type === "string" ? { token_type: value.token_type } : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {})
  };
}

async function acquireKimiRefreshLock(source: string): Promise<() => Promise<void>> {
  const oauthDir = path.join(source, "oauth");
  const target = path.join(oauthDir, "kimi-code");
  await mkdir(oauthDir, { recursive: true, mode: 0o700 });
  const targetHandle = await open(target, "a", 0o600);
  await targetHandle.close();
  try {
    return await lockfile.lock(target, {
      retries: {
        retries: 120,
        factor: 1,
        minTimeout: 500,
        maxTimeout: 1_000
      },
      stale: 5_000,
      realpath: false
    });
  } catch (error) {
    throw new Error(
      `unable to acquire Kimi OAuth refresh lock: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

async function writeJsonAtomic(filePath: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
