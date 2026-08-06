import fs from "node:fs";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  acquireKimiModalNodeExecutionLease,
  brokerKimiSubscriptionAuthRotation,
  kimiSubscriptionAuthSecretValues,
  kimiSubscriptionAuthSecretValuesFromRoots,
  kimiSubscriptionCredentialFileName,
  kimiRuntimeScopedIdentity,
  localSubscriptionAuthPath,
  prepareSubscriptionAuthCopy,
  reconcileKimiSubscriptionAuthCredential,
  refreshKimiSubscriptionAuth,
  runnerApiKeySourceEnv,
  subscriptionAuthCopy
} from "../src/auth.js";

describe("runtime-only subscription auth", () => {
  it("derives replica-scoped Kimi identity without depending on an image machine-id", () => {
    const identity = kimiRuntimeScopedIdentity("modal-replica-a", "boot-a", "pid:[101]");
    expect(identity).toMatch(/^[0-9a-f]{64}$/u);
    expect(kimiRuntimeScopedIdentity("modal-replica-a", "boot-a", "pid:[101]")).toBe(identity);
    expect(kimiRuntimeScopedIdentity("modal-replica-b", "boot-a", "pid:[101]")).not.toBe(identity);
    expect(kimiRuntimeScopedIdentity("modal-replica-a", "boot-b", "pid:[101]")).not.toBe(identity);
    expect(kimiRuntimeScopedIdentity("modal-replica-a", "boot-a", "pid:[202]")).not.toBe(identity);
    expect(() => kimiRuntimeScopedIdentity("", "boot-a", "pid:[101]")).toThrow(/must be nonempty/u);
  });

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
    expect(subscriptionAuthCopy({ provider: "kimi", auth_mode: "api-key" }, {}, "/home/example")).toBeUndefined();
  });

  it("accepts Kimi or Moonshot API keys for Kimi workers", () => {
    expect(runnerApiKeySourceEnv("openai")).toEqual(["OPENAI_API_KEY"]);
    expect(runnerApiKeySourceEnv("deepseek")).toEqual(["DEEPSEEK_API_KEY"]);
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

  it("serializes Modal node-provider Kimi attempts and removes the lock directory on release", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const env = { KIMI_CODE_HOME: source };
    const leaseFile = path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-execution");
    const lockDirectory = `${leaseFile}.lock`;
    let first: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    let second: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    try {
      first = await acquireKimiModalNodeExecutionLease("kimi-k3", env, "/unused", { timeoutMs: 5_000 });
      expect(first.source).toBe(source);
      expect(first.credentialPath).toBe(path.join(source, "credentials", "kimi-code.json"));
      expect(first.credentialLeaseId).toMatch(/^[0-9a-f]{64}$/u);
      expect(first.ownerId).toMatch(/^[0-9a-f-]{36}$/u);
      const firstMetadata = JSON.parse(fs.readFileSync(leaseFile, "utf8")) as Record<string, unknown>;
      expect(firstMetadata).toMatchObject({
        schema_version: "ultrafuzz.kimi-modal-execution-lease.v1",
        credential_lease: first.credentialLeaseId,
        owner_id: first.ownerId,
        owner_host_id: expect.any(String),
        journal_pair_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        transition_sequence: 1,
        rotation_state: "active"
      });
      await expect(first.assertOwner()).resolves.toBeUndefined();
      fs.writeFileSync(leaseFile, `${JSON.stringify({ ...firstMetadata, owner_id: "superseding-owner" })}\n`);
      await expect(first.assertOwner()).rejects.toThrow(/ownership was superseded/u);
      fs.writeFileSync(leaseFile, `${JSON.stringify(firstMetadata)}\n`);
      expect(fs.existsSync(lockDirectory)).toBe(true);

      let secondAcquired = false;
      const waiting = acquireKimiModalNodeExecutionLease("kimi-k3", env, "/unused", {
        timeoutMs: 5_000
      }).then((lease) => {
        secondAcquired = true;
        second = lease;
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondAcquired).toBe(false);

      await first.release();
      const acquiredSecond = await waiting;
      expect(secondAcquired).toBe(true);
      expect(acquiredSecond.credentialLeaseId).toBe(first.credentialLeaseId);
      expect(acquiredSecond.ownerId).not.toBe(first.ownerId);
      expect(fs.existsSync(lockDirectory)).toBe(true);

      await first.release();
      expect(fs.existsSync(lockDirectory)).toBe(true);
      await acquiredSecond.release();
      expect(fs.existsSync(lockDirectory)).toBe(false);
    } finally {
      await second?.release();
      await first?.release();
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("recovers only an exact paired active journal whose former process owner is dead", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const credentials = path.join(source, "credentials");
    const leaseFile = path.join(credentials, ".kimi-code.ultrafuzz-modal-node-execution");
    const fenceFile = path.join(credentials, ".kimi-code.ultrafuzz-modal-node-fence");
    const deadPid = 2_147_483_647;
    const currentIdentity = testProcessIdentity(process.pid);
    const record = (rotationState: "active" | "rotation-possible", transitionSequence: number) =>
      JSON.stringify({
        schema_version: "ultrafuzz.kimi-modal-execution-lease.v1",
        credential_lease: "a".repeat(64),
        owner_id: "crashed-before-remote-exposure",
        owner_process_id: deadPid,
        ...currentIdentity,
        journal_pair_id: "11111111-2222-4333-8444-555555555555",
        transition_sequence: transitionSequence,
        rotation_state: rotationState
      });
    const activeJournal = `${record("active", 1)}\n`;
    fs.writeFileSync(leaseFile, activeJournal, { mode: 0o600 });
    fs.writeFileSync(fenceFile, activeJournal, { mode: 0o600 });
    let lease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    try {
      lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      const states = fs
        .readFileSync(leaseFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { owner_id: string; rotation_state: string });
      expect(states).toHaveLength(3);
      expect(states[0]).toMatchObject({ owner_id: "crashed-before-remote-exposure", rotation_state: "active" });
      expect(states[1]).toMatchObject({ owner_id: "crashed-before-remote-exposure", rotation_state: "resolved" });
      expect(states[2]).toMatchObject({ owner_id: lease.ownerId, rotation_state: "active" });
      await expect(lease.assertOwner()).resolves.toBeUndefined();
      await lease.release();
      lease = undefined;

      const unresolved = `${record("active", 1)}\n${record("rotation-possible", 2)}\n`;
      fs.writeFileSync(leaseFile, unresolved, { mode: 0o600 });
      fs.writeFileSync(fenceFile, unresolved, { mode: 0o600 });
      await expect(
        acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/durable unresolved Kimi Modal credential-rotation fence/u);
    } finally {
      await lease?.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("recovers a same-host reused PID while foreign locality and legacy PID records fail closed", async () => {
    const currentIdentity = testProcessIdentity(process.pid);
    for (const [name, identityPatch] of [
      ["reused-pid", { owner_process_start: `${currentIdentity.owner_process_start}-reused` }]
    ] as const) {
      const source = kimiAuthFixture({ fresh: true });
      const credentials = path.join(source, "credentials");
      const leaseFile = path.join(credentials, ".kimi-code.ultrafuzz-modal-node-execution");
      const fenceFile = path.join(credentials, ".kimi-code.ultrafuzz-modal-node-fence");
      const active = `${JSON.stringify({
        schema_version: "ultrafuzz.kimi-modal-execution-lease.v1",
        credential_lease: "b".repeat(64),
        owner_id: name,
        owner_process_id: process.pid,
        ...currentIdentity,
        ...identityPatch,
        journal_pair_id: "21111111-2222-4333-8444-555555555555",
        transition_sequence: 1,
        rotation_state: "active"
      })}\n`;
      fs.writeFileSync(leaseFile, active, { mode: 0o600 });
      fs.writeFileSync(fenceFile, active, { mode: 0o600 });
      let lease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
      try {
        lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
          timeoutMs: 5_000
        });
        const records = fs
          .readFileSync(leaseFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { owner_id?: string; rotation_state?: string });
        expect(records).toHaveLength(3);
        expect(records[1]).toMatchObject({ owner_id: name, rotation_state: "resolved" });
        expect(records[2]).toMatchObject({ owner_id: lease.ownerId, rotation_state: "active" });
      } finally {
        await lease?.release().catch(() => undefined);
        fs.rmSync(source, { recursive: true, force: true });
      }
    }

    for (const [name, identityPatch] of [
      ["foreign-host", { owner_host_id: `${currentIdentity.owner_host_id}-replacement` }],
      ["foreign-boot", { owner_boot_id: `${currentIdentity.owner_boot_id}-replacement` }],
      ["foreign-namespace", { owner_pid_namespace: `${currentIdentity.owner_pid_namespace}-replacement` }]
    ] as const) {
      const source = kimiAuthFixture({ fresh: true });
      const credentials = path.join(source, "credentials");
      const leaseFile = path.join(credentials, ".kimi-code.ultrafuzz-modal-node-execution");
      const fenceFile = path.join(credentials, ".kimi-code.ultrafuzz-modal-node-fence");
      const active = `${JSON.stringify({
        schema_version: "ultrafuzz.kimi-modal-execution-lease.v1",
        credential_lease: "d".repeat(64),
        owner_id: name,
        owner_process_id: process.pid,
        ...currentIdentity,
        ...identityPatch,
        journal_pair_id: "41111111-2222-4333-8444-555555555555",
        transition_sequence: 1,
        rotation_state: "active"
      })}\n`;
      fs.writeFileSync(leaseFile, active, { mode: 0o600 });
      fs.writeFileSync(fenceFile, active, { mode: 0o600 });
      try {
        await expect(
          acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
            timeoutMs: 5_000
          })
        ).rejects.toThrow(/durable unresolved Kimi Modal credential-rotation fence/u);
      } finally {
        fs.rmSync(source, { recursive: true, force: true });
      }
    }

    for (const [name, pid] of [
      ["legacy-live-owner", process.pid],
      ["legacy-locally-missing-owner", 2_147_483_647]
    ] as const) {
      const legacySource = kimiAuthFixture({ fresh: true });
      const credentials = path.join(legacySource, "credentials");
      const leaseFile = path.join(credentials, ".kimi-code.ultrafuzz-modal-node-execution");
      const fenceFile = path.join(credentials, ".kimi-code.ultrafuzz-modal-node-fence");
      const legacyActive = `${JSON.stringify({
        schema_version: "ultrafuzz.kimi-modal-execution-lease.v1",
        credential_lease: "c".repeat(64),
        owner_id: name,
        owner_process_id: pid,
        journal_pair_id: "31111111-2222-4333-8444-555555555555",
        transition_sequence: 1,
        rotation_state: "active"
      })}\n`;
      fs.writeFileSync(leaseFile, legacyActive, { mode: 0o600 });
      fs.writeFileSync(fenceFile, legacyActive, { mode: 0o600 });
      try {
        await expect(
          acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: legacySource }, "/unused", {
            timeoutMs: 5_000
          })
        ).rejects.toThrow(/durable unresolved Kimi Modal credential-rotation fence/u);
      } finally {
        fs.rmSync(legacySource, { recursive: true, force: true });
      }
    }
  });

  it("fsyncs a new Kimi execution fence from file through both containing directories", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const credentialsDirectory = path.join(source, "credentials");
    const target = path.join(credentialsDirectory, ".kimi-code.ultrafuzz-modal-node-execution");
    const fence = path.join(credentialsDirectory, ".kimi-code.ultrafuzz-modal-node-fence");
    const probe = await fs.promises.open(source, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    const synced: string[] = [];
    const syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (this: FileHandle) {
      synced.push(fs.readlinkSync(`/proc/self/fd/${this.fd}`));
      await originalSync.call(this);
    });
    let lease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    try {
      lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      expect(synced).toEqual([fence, target, credentialsDirectory, source]);
    } finally {
      syncSpy.mockRestore();
      await lease?.release();
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("fails closed and releases every acquisition resource when directory fsync fails", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const credentialsDirectory = path.join(source, "credentials");
    const target = path.join(credentialsDirectory, ".kimi-code.ultrafuzz-modal-node-execution");
    const fence = path.join(credentialsDirectory, ".kimi-code.ultrafuzz-modal-node-fence");
    const lockDirectory = `${target}.lock`;
    const probe = await fs.promises.open(source, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    const synced: string[] = [];
    const syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (this: FileHandle) {
      const openedPath = fs.readlinkSync(`/proc/self/fd/${this.fd}`);
      synced.push(openedPath);
      if (openedPath === credentialsDirectory) {
        throw Object.assign(new Error("injected credentials directory fsync failure"), { code: "EIO" });
      }
      await originalSync.call(this);
    });
    try {
      await expect(
        acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/unable to initialize Kimi Modal execution lease metadata/u);
      expect(synced).toEqual([fence, target, credentialsDirectory]);
      expect(fs.existsSync(lockDirectory)).toBe(false);
      expect(openFileDescriptorsBelow(source)).toEqual([]);

      syncSpy.mockRestore();
      await expect(
        acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/durable unresolved Kimi Modal credential-rotation fence/u);
      expect(fs.existsSync(lockDirectory)).toBe(false);
      expect(openFileDescriptorsBelow(source)).toEqual([]);
    } finally {
      syncSpy.mockRestore();
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("disposes an unresolved lease while leaving its dual-journal fence authoritative", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const lockDirectory = path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-execution.lock");
    const lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
      timeoutMs: 5_000
    });
    try {
      await lease.markRotationPossible();
      await expect(lease.release()).rejects.toThrow(/rotation remains durably unresolved/u);
      expect(fs.existsSync(lockDirectory)).toBe(false);
      expect(openFileDescriptorsBelow(source)).toEqual([]);
      await expect(lease.assertOwner()).rejects.toThrow(/no longer usable/u);
      await expect(lease.release()).resolves.toBeUndefined();
      await expect(
        acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/durable unresolved Kimi Modal credential-rotation fence/u);
    } finally {
      await lease.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("closes every handle and poisons the lease when post-unlock directory fsync fails", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const credentialsDirectory = path.join(source, "credentials");
    const lockDirectory = path.join(credentialsDirectory, ".kimi-code.ultrafuzz-modal-node-execution.lock");
    const lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
      timeoutMs: 5_000
    });
    const probe = await fs.promises.open(source, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    let injected = false;
    const syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (this: FileHandle) {
      const openedPath = fs.readlinkSync(`/proc/self/fd/${this.fd}`);
      if (!injected && openedPath === credentialsDirectory) {
        injected = true;
        throw Object.assign(new Error("injected post-unlock credentials fsync failure"), { code: "EIO" });
      }
      await originalSync.call(this);
    });
    try {
      await expect(lease.release()).rejects.toThrow(/post-unlock credentials fsync failure/u);
      expect(fs.existsSync(lockDirectory)).toBe(false);
      expect(openFileDescriptorsBelow(source)).toEqual([]);
      await expect(lease.assertOwner()).rejects.toThrow(/no longer usable/u);
      await expect(lease.release()).resolves.toBeUndefined();
    } finally {
      syncSpy.mockRestore();
      await lease.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("rejects nested aliases and hard links to a shared Kimi credential", async () => {
    const physical = kimiAuthFixture({ fresh: true });
    const credentialName = "kimi-code.json";
    const physicalCredential = path.join(physical, "credentials", credentialName);

    const credentialAliasHome = kimiAuthFixture({ fresh: true });
    const credentialAlias = path.join(credentialAliasHome, "credentials", credentialName);
    fs.rmSync(credentialAlias);
    fs.symlinkSync(physicalCredential, credentialAlias);

    const directoryAliasHome = kimiAuthFixture({ fresh: true });
    fs.rmSync(path.join(directoryAliasHome, "credentials"), { recursive: true });
    fs.symlinkSync(path.join(physical, "credentials"), path.join(directoryAliasHome, "credentials"), "dir");

    const hardLinkHome = kimiAuthFixture({ fresh: true });
    const hardLinkCredential = path.join(hardLinkHome, "credentials", credentialName);
    fs.rmSync(hardLinkCredential);
    fs.linkSync(physicalCredential, hardLinkCredential);

    try {
      await expect(
        acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: credentialAliasHome }, "/unused", {
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/credential is unsafe/u);
      await expect(
        acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: directoryAliasHome }, "/unused", {
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/credential directory is unsafe/u);
      await expect(
        acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: hardLinkHome }, "/unused", {
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/credential is unsafe/u);
    } finally {
      fs.rmSync(hardLinkHome, { recursive: true, force: true });
      fs.rmSync(directoryAliasHome, { recursive: true, force: true });
      fs.rmSync(credentialAliasHome, { recursive: true, force: true });
      fs.rmSync(physical, { recursive: true, force: true });
    }
  });

  it("serializes whole-home aliases on the same physical credential-directory lock", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const alias = `${source}-alias`;
    fs.symlinkSync(source, alias, "dir");
    let first: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    let second: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    try {
      first = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      let acquired = false;
      const waiting = acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: alias }, "/unused", {
        timeoutMs: 5_000
      }).then((value) => {
        acquired = true;
        second = value;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(acquired).toBe(false);
      await first.release();
      first = undefined;
      second = await waiting;
      expect(second.source).toBe(source);
      expect(second.credentialPath).toBe(path.join(source, "credentials", "kimi-code.json"));
      expect(second.leasePath).toBe(path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-execution"));
    } finally {
      await second?.release();
      await first?.release();
      fs.rmSync(alias, { force: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("proves the held credential still owns its directory entry before OAuth exchange", async () => {
    const source = kimiAuthFixture();
    const credential = path.join(source, "credentials", "kimi-code.json");
    const heldCredential = `${credential}.held`;
    let exchanges = 0;
    const lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
      timeoutMs: 5_000
    });
    try {
      fs.renameSync(credential, heldCredential);
      fs.writeFileSync(
        credential,
        `${JSON.stringify({
          access_token: "replacement-access",
          refresh_token: "replacement-refresh",
          expires_at: 9_999_999_999,
          expires_in: 3600
        })}\n`,
        { mode: 0o600 }
      );
      const replacementBefore = fs.readFileSync(credential);
      const heldBefore = fs.readFileSync(heldCredential);

      await expect(
        lease.prepareAuthCopy(
          {},
          {
            now: () => 2_000_000_000,
            fetch: async () => {
              exchanges += 1;
              throw new Error("OAuth exchange must not be reached");
            }
          }
        )
      ).rejects.toThrow(/ownership could not be verified/u);
      expect(exchanges).toBe(0);
      expect(fs.readFileSync(credential)).toEqual(replacementBefore);
      expect(fs.readFileSync(heldCredential)).toEqual(heldBefore);
      await expect(lease.release()).rejects.toThrow(/ownership could not be verified/u);
      expect(openFileDescriptorsBelow(source)).toEqual([]);
    } finally {
      await lease.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("fences before local OAuth refresh and rearms a fresh generation after durable commit", async () => {
    const source = kimiAuthFixture();
    const leaseFile = path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-execution");
    const fenceFile = path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-fence");
    let prepared: { cleanup?: () => Promise<void> } | undefined;
    const lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
      timeoutMs: 5_000
    });
    try {
      prepared = await lease.prepareAuthCopy(
        {},
        {
          now: () => 2_000_000_000,
          fetch: async () => {
            expect(lastKimiLeaseJournalState(leaseFile)).toBe("rotation-possible");
            expect(lastKimiLeaseJournalState(fenceFile)).toBe("rotation-possible");
            return new Response(
              JSON.stringify({
                access_token: "local-successor-access",
                refresh_token: "local-successor-refresh",
                expires_in: 3600
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          }
        }
      );
      expect(lastKimiLeaseJournalState(leaseFile)).toBe("active");
      expect(lastKimiLeaseJournalState(fenceFile)).toBe("active");
      expect(fs.readFileSync(leaseFile, "utf8")).toMatch(/rotation-possible.*resolved.*active/su);

      // The successful local generation must not make the later remote-worker
      // generation impossible.
      await lease.markRotationPossible();
      await lease.markRotationResolved();
      await lease.release();
    } finally {
      await prepared?.cleanup?.();
      await lease.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("recovers a committed local refresh after the first credentials-directory fsync fails", async () => {
    const source = kimiAuthFixture();
    const credentialsDirectory = path.join(source, "credentials");
    const leaseFile = path.join(credentialsDirectory, ".kimi-code.ultrafuzz-modal-node-execution");
    const fenceFile = path.join(credentialsDirectory, ".kimi-code.ultrafuzz-modal-node-fence");
    let lease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    let reacquired: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    let prepared:
      | Awaited<ReturnType<Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>>["prepareAuthCopy"]>>
      | undefined;
    const probe = await fs.promises.open(source, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    let armed = false;
    let injected = false;
    let credentialsDirectorySyncs = 0;
    const syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (this: FileHandle) {
      const openedPath = fs.readlinkSync(`/proc/self/fd/${this.fd}`);
      if (armed && openedPath === credentialsDirectory) {
        credentialsDirectorySyncs += 1;
        if (!injected) {
          injected = true;
          throw Object.assign(new Error("injected first local-refresh directory fsync failure"), { code: "EIO" });
        }
      }
      await originalSync.call(this);
    });
    try {
      lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      // Acquisition itself must remain durable; inject only into the refresh
      // commit after the lease has initialized its direct journals.
      armed = true;
      injected = false;
      credentialsDirectorySyncs = 0;
      prepared = await lease.prepareAuthCopy(
        {},
        {
          now: () => 2_000_000_000,
          fetch: async () =>
            new Response(
              JSON.stringify({
                access_token: "fsync-successor-access",
                refresh_token: "fsync-successor-refresh",
                expires_in: 3600
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
        }
      );
      expect(injected).toBe(true);
      expect(credentialsDirectorySyncs).toBeGreaterThanOrEqual(2);
      expect(lastKimiLeaseJournalState(leaseFile)).toBe("active");
      expect(lastKimiLeaseJournalState(fenceFile)).toBe("active");
      expect(
        JSON.parse(fs.readFileSync(path.join(prepared.source, "credentials", "kimi-code.json"), "utf8"))
      ).toMatchObject({
        access_token: "fsync-successor-access",
        refresh_token: "fsync-successor-refresh"
      });
      await prepared.cleanup?.();
      prepared = undefined;
      syncSpy.mockRestore();
      await expect(lease.release()).resolves.toBeUndefined();
      lease = undefined;

      reacquired = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      await expect(reacquired.assertOwner()).resolves.toBeUndefined();
    } finally {
      syncSpy.mockRestore();
      await prepared?.cleanup?.();
      await reacquired?.release().catch(() => undefined);
      await lease?.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("recovers pending local-refresh intent on the next preparation when the bounded retry also fails", async () => {
    const source = kimiAuthFixture();
    const credentialsDirectory = path.join(source, "credentials");
    const leaseFile = path.join(credentialsDirectory, ".kimi-code.ultrafuzz-modal-node-execution");
    let lease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    let reacquired: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    let prepared:
      | Awaited<ReturnType<Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>>["prepareAuthCopy"]>>
      | undefined;
    let syncSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      const probe = await fs.promises.open(source, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      let injected = 0;
      syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (this: FileHandle) {
        const openedPath = fs.readlinkSync(`/proc/self/fd/${this.fd}`);
        if (openedPath === credentialsDirectory && injected < 2) {
          injected += 1;
          throw Object.assign(new Error(`injected deferred local-refresh fsync failure ${injected}`), { code: "EIO" });
        }
        await originalSync.call(this);
      });

      await expect(
        lease.prepareAuthCopy(
          {},
          {
            now: () => 2_000_000_000,
            fetch: async () =>
              new Response(
                JSON.stringify({
                  access_token: "deferred-successor-access",
                  refresh_token: "deferred-successor-refresh",
                  expires_in: 3600
                }),
                { status: 200, headers: { "content-type": "application/json" } }
              )
          }
        )
      ).rejects.toThrow(/injected deferred local-refresh fsync failure 1/u);
      expect(injected).toBe(2);
      expect(lastKimiLeaseJournalState(leaseFile)).toBe("rotation-possible");

      syncSpy.mockRestore();
      syncSpy = undefined;
      const unexpectedFetch = vi.fn(async () => {
        throw new Error("pending successor recovery must precede token freshness and OAuth exchange");
      });
      prepared = await lease.prepareAuthCopy({}, { now: () => 2_000_000_000, fetch: unexpectedFetch });
      expect(unexpectedFetch).not.toHaveBeenCalled();
      expect(lastKimiLeaseJournalState(leaseFile)).toBe("active");
      expect(
        JSON.parse(fs.readFileSync(path.join(prepared.source, "credentials", "kimi-code.json"), "utf8"))
      ).toMatchObject({
        access_token: "deferred-successor-access",
        refresh_token: "deferred-successor-refresh"
      });
      await prepared.cleanup?.();
      prepared = undefined;
      await lease.release();
      lease = undefined;

      reacquired = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      await expect(reacquired.assertOwner()).resolves.toBeUndefined();
    } finally {
      syncSpy?.mockRestore();
      await prepared?.cleanup?.();
      await reacquired?.release().catch(() => undefined);
      await lease?.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it.each(["credential-commit", "rotation-resolve", "active-rearm"] as const)(
    "retains a durable local-refresh fence across the %s crash boundary",
    async (failureBoundary) => {
      const source = kimiAuthFixture();
      const leaseFile = path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-execution");
      const fenceFile = path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-fence");
      const lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      const probe = await fs.promises.open(source, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      let injected = false;
      const syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (this: FileHandle) {
        const openedPath = fs.readlinkSync(`/proc/self/fd/${this.fd}`);
        const isCredentialTemporary =
          path.dirname(openedPath) === path.join(source, "credentials") &&
          path.basename(openedPath).startsWith("ultrafuzz-");
        const journalState =
          openedPath === leaseFile || openedPath === fenceFile ? lastKimiLeaseJournalState(openedPath) : undefined;
        const journal = journalState === undefined ? "" : fs.readFileSync(openedPath, "utf8");
        if (
          !injected &&
          ((failureBoundary === "credential-commit" && isCredentialTemporary) ||
            (failureBoundary === "rotation-resolve" && openedPath === leaseFile && journalState === "resolved") ||
            (failureBoundary === "active-rearm" &&
              openedPath === fenceFile &&
              journalState === "active" &&
              journal.includes('"rotation_state":"resolved"')))
        ) {
          injected = true;
          throw Object.assign(new Error(`injected ${failureBoundary} failure`), { code: "EIO" });
        }
        await originalSync.call(this);
      });
      try {
        await expect(
          lease.prepareAuthCopy(
            {},
            {
              now: () => 2_000_000_000,
              fetch: async () =>
                new Response(
                  JSON.stringify({
                    access_token: "cut-successor-access",
                    refresh_token: "cut-successor-refresh",
                    expires_in: 3600
                  }),
                  { status: 200, headers: { "content-type": "application/json" } }
                )
            }
          )
        ).rejects.toThrow(new RegExp(`injected ${failureBoundary} failure`, "u"));
        expect(injected).toBe(true);
        await expect(lease.release()).rejects.toThrow(/unresolved|ownership (?:could not be verified|was superseded)/u);
        syncSpy.mockRestore();
        expect(openFileDescriptorsBelow(source)).toEqual([]);
        await expect(
          acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
            timeoutMs: 5_000
          })
        ).rejects.toThrow(/durable unresolved Kimi Modal credential-rotation fence/u);
      } finally {
        syncSpy.mockRestore();
        await lease.release().catch(() => undefined);
        fs.rmSync(source, { recursive: true, force: true });
      }
    }
  );

  it("retains an unresolved sidecar fence when the primary lease pathname is replaced", async () => {
    const source = kimiAuthFixture({ fresh: true });
    let lease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    try {
      lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      const heldInode = `${lease.leasePath}.held-inode`;
      fs.renameSync(lease.leasePath, heldInode);
      const replacementRecord = (rotationState: "active" | "resolved") =>
        JSON.stringify({
          schema_version: "ultrafuzz.kimi-modal-execution-lease.v1",
          credential_lease: "f".repeat(64),
          owner_id: "replacement-owner",
          rotation_state: rotationState
        });
      fs.writeFileSync(lease.leasePath, `${replacementRecord("active")}\n${replacementRecord("resolved")}\n`, {
        mode: 0o600
      });

      await expect(lease.markRotationPossible()).rejects.toThrow(/ownership could not be verified/u);
      await expect(lease.release()).rejects.toThrow(/ownership could not be verified/u);
      expect(fs.existsSync(`${lease.leasePath}.lock`)).toBe(false);
      expect(openFileDescriptorsBelow(source)).toEqual([]);
      expect(fs.readFileSync(heldInode, "utf8")).not.toContain('"rotation_state":"resolved"');

      // Exercise proper-lockfile's stale-owner takeover path explicitly. The
      // stale lock directory can be reclaimed, but the untouched sidecar still
      // makes reacquisition fail closed despite the syntactically resolved
      // replacement primary journal.
      fs.mkdirSync(`${lease.leasePath}.lock`, { mode: 0o700 });
      const staleTime = new Date(0);
      fs.utimesSync(`${lease.leasePath}.lock`, staleTime, staleTime);
      await expect(
        acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/durable unresolved Kimi Modal credential-rotation fence/u);
    } finally {
      await lease?.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it.each(["empty", "stale-resolved"] as const)(
    "rejects a %s sidecar replacement at the primary-resolved write boundary",
    async (replacementKind) => {
      const source = kimiAuthFixture({ fresh: true });
      const leaseFile = path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-execution");
      const fenceFile = path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-fence");
      const detachedFence = `${fenceFile}.detached`;
      const lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      await lease.markRotationPossible();
      await lease.markRotationResolved();
      const staleResolvedJournal = `${fs
        .readFileSync(fenceFile, "utf8")
        .trimEnd()
        .split("\n")
        .slice(0, 3)
        .join("\n")}\n`;
      await lease.markRotationPossible();

      const probe = await fs.promises.open(source, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      let replaced = false;
      const syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (this: FileHandle) {
        const openedPath = fs.readlinkSync(`/proc/self/fd/${this.fd}`);
        if (
          !replaced &&
          openedPath === leaseFile &&
          lastKimiLeaseJournalState(leaseFile) === "resolved" &&
          lastKimiLeaseJournalSequence(leaseFile) === 6
        ) {
          replaced = true;
          fs.renameSync(fenceFile, detachedFence);
          fs.writeFileSync(fenceFile, replacementKind === "empty" ? "" : staleResolvedJournal, { mode: 0o600 });
        }
        await originalSync.call(this);
      });
      try {
        await expect(lease.markRotationResolved()).rejects.toThrow(/no longer owned/u);
        expect(replaced).toBe(true);
        await expect(lease.release()).rejects.toThrow(/ownership could not be verified/u);
        syncSpy.mockRestore();
        expect(openFileDescriptorsBelow(source)).toEqual([]);
        await expect(
          acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
            timeoutMs: 5_000
          })
        ).rejects.toThrow(/durable unresolved|paired journals are inconsistent/u);
      } finally {
        syncSpy.mockRestore();
        await lease.release().catch(() => undefined);
        fs.rmSync(source, { recursive: true, force: true });
      }
    }
  );

  it("detects a renamed OAuth namespace without redirecting its credential-directory proper lock", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-oauth-replacement-"));
    const originalOauth = path.join(source, "oauth");
    const heldOauth = path.join(source, "oauth-held");
    const outsideOauth = path.join(outsideRoot, "oauth");
    fs.mkdirSync(outsideOauth, { mode: 0o700 });
    let lease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    try {
      lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000,
        lockUpdateMs: 1_000
      });
      const lockName = `${path.basename(lease.leasePath)}.lock`;
      const realLock = `${lease.leasePath}.lock`;
      const initialRealLockMtime = fs.statSync(realLock).mtimeMs;

      fs.renameSync(originalOauth, heldOauth);
      const replacementLock = path.join(outsideOauth, lockName);
      const sentinel = path.join(replacementLock, "sentinel.txt");
      fs.mkdirSync(replacementLock, { mode: 0o750 });
      fs.writeFileSync(sentinel, "replacement-must-not-change\n", { mode: 0o640 });
      const fixedTime = new Date("2020-01-02T03:04:05.000Z");
      fs.utimesSync(replacementLock, fixedTime, fixedTime);
      fs.utimesSync(sentinel, fixedTime, fixedTime);
      const replacementBefore = fs.statSync(replacementLock);
      const sentinelBefore = fs.statSync(sentinel);
      fs.symlinkSync(outsideOauth, originalOauth, "dir");

      await vi.waitFor(() => expect(fs.statSync(realLock).mtimeMs).toBeGreaterThan(initialRealLockMtime), {
        timeout: 3_000,
        interval: 25
      });
      expect(fs.existsSync(realLock)).toBe(true);
      await expect(lease.release()).rejects.toThrow(/ownership could not be verified/u);

      expect(fs.existsSync(realLock)).toBe(false);
      expect(openFileDescriptorsBelow(source)).toEqual([]);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("replacement-must-not-change\n");
      expect(fs.statSync(replacementLock).mode & 0o777).toBe(replacementBefore.mode & 0o777);
      expect(fs.statSync(replacementLock).mtimeMs).toBe(replacementBefore.mtimeMs);
      expect(fs.statSync(sentinel).mode & 0o777).toBe(sentinelBefore.mode & 0o777);
      expect(fs.statSync(sentinel).mtimeMs).toBe(sentinelBefore.mtimeMs);
    } finally {
      await lease?.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each(["empty", "stale-paired", "legacy-resolved"] as const)(
    "cannot reset an active direct execution fence with a %s OAuth namespace replacement",
    async (replacementKind) => {
      const source = kimiAuthFixture({ fresh: true });
      const originalOauth = path.join(source, "oauth");
      const heldOauth = path.join(source, "oauth-held");
      let lease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
      try {
        lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
          timeoutMs: 5_000
        });
        const directFence = path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-fence");
        const stalePrimary = fs.readFileSync(lease.leasePath, "utf8");
        const staleFence = fs.readFileSync(directFence, "utf8");

        fs.renameSync(originalOauth, heldOauth);
        fs.mkdirSync(originalOauth, { mode: 0o700 });
        const legacyPrimary = path.join(originalOauth, "kimi-code.ultrafuzz-modal-node-execution");
        const legacyFence = path.join(originalOauth, "kimi-code.ultrafuzz-modal-node-fence");
        if (replacementKind === "stale-paired") {
          fs.writeFileSync(legacyPrimary, stalePrimary, { mode: 0o600 });
          fs.writeFileSync(legacyFence, staleFence, { mode: 0o600 });
        } else if (replacementKind === "legacy-resolved") {
          const record = (rotationState: "active" | "rotation-possible" | "resolved") =>
            JSON.stringify({
              schema_version: "ultrafuzz.kimi-modal-execution-lease.v1",
              credential_lease: "e".repeat(64),
              owner_id: "legacy-replacement-owner",
              rotation_state: rotationState
            });
          fs.writeFileSync(
            legacyPrimary,
            `${record("active")}\n${record("rotation-possible")}\n${record("resolved")}\n`,
            { mode: 0o600 }
          );
          fs.writeFileSync(legacyFence, "", { mode: 0o600 });
        }

        await expect(lease.release()).rejects.toThrow(/ownership could not be verified/u);
        lease = undefined;
        await expect(
          acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
            timeoutMs: 5_000
          })
        ).rejects.toThrow(/durable unresolved|paired journals are inconsistent/u);
      } finally {
        await lease?.release().catch(() => undefined);
        fs.rmSync(source, { recursive: true, force: true });
      }
    }
  );

  it("fails an old lease closed when its canonical auth root is replaced by a new physical namespace", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const heldSource = `${source}-held`;
    let oldLease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    let replacementLease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    try {
      oldLease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      fs.renameSync(source, heldSource);

      const replacement = kimiAuthFixture({ fresh: true });
      const replacementCredential = path.join(replacement, "credentials", "kimi-code.json");
      fs.writeFileSync(
        replacementCredential,
        `${JSON.stringify({
          access_token: "attacker-access",
          refresh_token: "attacker-refresh",
          expires_at: 9_999_999_999,
          expires_in: 3600
        })}\n`,
        { mode: 0o640 }
      );
      fs.writeFileSync(path.join(replacement, "device_id"), "attacker-device\n", { mode: 0o640 });
      const replacementBytes = fs.readFileSync(replacementCredential);
      const replacementMetadata = fs.statSync(replacementCredential);
      fs.renameSync(replacement, source);
      const installedReplacementCredential = path.join(source, "credentials", "kimi-code.json");

      replacementLease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      expect(replacementLease.credentialLeaseId).not.toBe(oldLease.credentialLeaseId);
      await expect(oldLease.assertOwner()).rejects.toThrow(/ownership could not be verified/u);
      await expect(oldLease.prepareAuthCopy({}, { now: () => 2_000_000_000 })).rejects.toThrow(
        /ownership could not be verified/u
      );
      await expect(
        oldLease.reconcileCredential(
          `${JSON.stringify({
            access_token: "successor-access",
            refresh_token: "successor-refresh",
            expires_at: 2_020_000,
            expires_in: 3600
          })}\n`,
          { sourceRefreshTokenSha256: createHash("sha256").update("old-refresh").digest("hex") }
        )
      ).rejects.toThrow(/ownership could not be verified/u);
      expect(fs.readFileSync(installedReplacementCredential)).toEqual(replacementBytes);
      expect(fs.statSync(installedReplacementCredential).mode & 0o777).toBe(replacementMetadata.mode & 0o777);
      expect(fs.statSync(installedReplacementCredential).mtimeMs).toBe(replacementMetadata.mtimeMs);
      await expect(oldLease.release()).rejects.toThrow(/ownership could not be verified/u);
      expect(openFileDescriptorsBelow(heldSource)).toEqual([]);
    } finally {
      await replacementLease?.release().catch(() => undefined);
      await oldLease?.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(heldSource, { recursive: true, force: true });
    }
  });

  it("atomically replaces and rebinds a lease credential across fsync failure boundaries", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const credentialPath = path.join(source, "credentials", "kimi-code.json");
    const originalBytes = fs.readFileSync(credentialPath);
    const originalInode = fs.statSync(credentialPath).ino;
    const probe = await fs.promises.open(source, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    let failureBoundary: "temporary-file" | "credentials-directory" | undefined = "temporary-file";
    const syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (this: FileHandle) {
      const openedPath = fs.readlinkSync(`/proc/self/fd/${this.fd}`);
      if (
        failureBoundary === "temporary-file" &&
        path.dirname(openedPath) === path.join(source, "credentials") &&
        path.basename(openedPath).startsWith("ultrafuzz-")
      ) {
        failureBoundary = undefined;
        throw Object.assign(new Error("injected temporary credential fsync failure"), { code: "EIO" });
      }
      if (failureBoundary === "credentials-directory" && openedPath === path.join(source, "credentials")) {
        failureBoundary = undefined;
        throw Object.assign(new Error("injected credential directory fsync failure"), { code: "EIO" });
      }
      await originalSync.call(this);
    });
    let lease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    let prepared:
      | Awaited<ReturnType<Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>>["prepareAuthCopy"]>>
      | undefined;
    const firstRemoteCredential = `${JSON.stringify({
      access_token: "atomic-access",
      refresh_token: "atomic-refresh",
      expires_at: 2_020_000,
      expires_in: 3600
    })}\n`;
    const ambiguousRemoteCredential = `${JSON.stringify({
      access_token: "ambiguous-access",
      refresh_token: "ambiguous-refresh",
      expires_at: 2_030_000,
      expires_in: 3600
    })}\n`;
    const reconcileOptions = {
      sourceRefreshTokenSha256: createHash("sha256").update("old-refresh").digest("hex")
    };
    try {
      lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
        timeoutMs: 5_000
      });
      await lease.markRotationPossible();
      await expect(lease.reconcileCredential(firstRemoteCredential, reconcileOptions)).rejects.toThrow(
        /injected temporary credential fsync failure/u
      );
      expect(fs.readFileSync(credentialPath)).toEqual(originalBytes);
      expect(fs.statSync(credentialPath).ino).toBe(originalInode);
      expect(fs.readdirSync(path.dirname(credentialPath)).sort()).toEqual([
        ".kimi-code.ultrafuzz-modal-node-execution",
        ".kimi-code.ultrafuzz-modal-node-execution.lock",
        ".kimi-code.ultrafuzz-modal-node-fence",
        "kimi-code.json"
      ]);
      await expect(lease.reconcileCredential(firstRemoteCredential, reconcileOptions)).resolves.toBe(true);
      await lease.markRotationResolved();
      const firstReplacementInode = fs.statSync(credentialPath).ino;
      expect(firstReplacementInode).not.toBe(originalInode);

      failureBoundary = "credentials-directory";
      await lease.markRotationPossible();
      await expect(
        lease.reconcileCredential(ambiguousRemoteCredential, {
          sourceRefreshTokenSha256: createHash("sha256").update("atomic-refresh").digest("hex")
        })
      ).rejects.toThrow(/injected credential directory fsync failure/u);
      expect(fs.statSync(credentialPath).ino).not.toBe(firstReplacementInode);
      expect(JSON.parse(fs.readFileSync(credentialPath, "utf8"))).toMatchObject({
        access_token: "ambiguous-access",
        refresh_token: "ambiguous-refresh"
      });
      expect(fs.readdirSync(path.dirname(credentialPath)).sort()).toEqual([
        ".kimi-code.ultrafuzz-modal-node-execution",
        ".kimi-code.ultrafuzz-modal-node-execution.lock",
        ".kimi-code.ultrafuzz-modal-node-fence",
        "kimi-code.json"
      ]);

      syncSpy.mockRestore();
      await expect(
        lease.reconcileCredential(ambiguousRemoteCredential, {
          sourceRefreshTokenSha256: createHash("sha256").update("atomic-refresh").digest("hex")
        })
      ).resolves.toBe(true);
      await lease.markRotationResolved();
      prepared = await lease.prepareAuthCopy({}, { now: () => 2_000_000_000 });
      expect(
        JSON.parse(fs.readFileSync(path.join(prepared.source, "credentials", "kimi-code.json"), "utf8"))
      ).toMatchObject({ access_token: "ambiguous-access", refresh_token: "ambiguous-refresh" });
      await prepared.cleanup?.();
      prepared = undefined;
      await expect(lease.release()).resolves.toBeUndefined();
      lease = undefined;
    } finally {
      syncSpy.mockRestore();
      await prepared?.cleanup?.();
      await lease?.release().catch(() => undefined);
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("rejects linked OAuth ancestors and direct lease targets without touching a victim", async () => {
    const victimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-lease-links-"));
    const victim = path.join(victimRoot, "victim.txt");
    fs.writeFileSync(victim, "untouched\n", { mode: 0o640 });
    const victimMode = fs.statSync(victim).mode & 0o777;
    const targetName = ".kimi-code.ultrafuzz-modal-node-execution";
    const linkedTargets = ["symbolic", "hard"] as const;
    try {
      for (const kind of linkedTargets) {
        const source = kimiAuthFixture({ fresh: true });
        const target = path.join(source, "credentials", targetName);
        if (kind === "symbolic") fs.symlinkSync(victim, target);
        else fs.linkSync(victim, target);
        try {
          await expect(
            acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
              timeoutMs: 5_000
            })
          ).rejects.toThrow(/unsafe|symbolic link|too many levels/u);
        } finally {
          fs.rmSync(source, { recursive: true, force: true });
        }
      }

      const ancestorSource = kimiAuthFixture({ fresh: true });
      fs.symlinkSync(victimRoot, path.join(ancestorSource, "oauth"), "dir");
      try {
        await expect(
          acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: ancestorSource }, "/unused", {
            timeoutMs: 5_000
          })
        ).rejects.toThrow(/OAuth lock directory is unsafe/u);
      } finally {
        fs.rmSync(ancestorSource, { recursive: true, force: true });
      }

      expect(fs.readFileSync(victim, "utf8")).toBe("untouched\n");
      expect(fs.statSync(victim).mode & 0o777).toBe(victimMode);
    } finally {
      fs.rmSync(victimRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on crash-torn lease journal transitions", async () => {
    const record = (state: "active" | "rotation-possible" | "resolved") =>
      JSON.stringify({
        schema_version: "ultrafuzz.kimi-modal-execution-lease.v1",
        credential_lease: "a".repeat(64),
        owner_id: "crashed-owner",
        rotation_state: state
      });
    const journals = [
      `${record("active")}\n`,
      `${record("active")}\n${record("rotation-possible").slice(0, 37)}`,
      `${record("active")}\n${record("rotation-possible")}\n${record("resolved").slice(0, 51)}`
    ];

    for (const journal of journals) {
      const source = kimiAuthFixture({ fresh: true });
      const oauth = path.join(source, "oauth");
      fs.mkdirSync(oauth, { mode: 0o700 });
      fs.writeFileSync(path.join(oauth, "kimi-code.ultrafuzz-modal-node-execution"), journal, { mode: 0o600 });
      try {
        await expect(
          acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", { timeoutMs: 5_000 })
        ).rejects.toThrow(/durable unresolved|torn record|legacy .* is unsafe/u);
      } finally {
        fs.rmSync(source, { recursive: true, force: true });
      }
    }

    const resolvedSource = kimiAuthFixture({ fresh: true });
    const oauth = path.join(resolvedSource, "oauth");
    fs.mkdirSync(oauth, { mode: 0o700 });
    fs.writeFileSync(
      path.join(oauth, "kimi-code.ultrafuzz-modal-node-execution"),
      `${record("active")}\n${record("rotation-possible")}\n${record("resolved")}\n`,
      { mode: 0o600 }
    );
    let lease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    try {
      lease = await acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: resolvedSource }, "/unused", {
        timeoutMs: 5_000
      });
      await expect(lease.assertOwner()).resolves.toBeUndefined();
    } finally {
      await lease?.release();
      fs.rmSync(resolvedSource, { recursive: true, force: true });
    }
  });

  it("never migrates paired execution journals from the replaceable OAuth namespace", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const oauth = path.join(source, "oauth");
    fs.mkdirSync(oauth, { mode: 0o700 });
    const record = (rotationState: "active" | "rotation-possible" | "resolved", transitionSequence: number) =>
      JSON.stringify({
        schema_version: "ultrafuzz.kimi-modal-execution-lease.v1",
        credential_lease: "b".repeat(64),
        owner_id: "paired-legacy-owner",
        journal_pair_id: "11111111-2222-4333-8444-555555555555",
        transition_sequence: transitionSequence,
        rotation_state: rotationState
      });
    const pairedResolved = `${record("active", 1)}\n${record("rotation-possible", 2)}\n${record("resolved", 3)}\n`;
    fs.writeFileSync(path.join(oauth, "kimi-code.ultrafuzz-modal-node-execution"), pairedResolved, {
      mode: 0o600
    });
    fs.writeFileSync(path.join(oauth, "kimi-code.ultrafuzz-modal-node-fence"), pairedResolved, { mode: 0o600 });
    try {
      await expect(
        acquireKimiModalNodeExecutionLease("kimi-k3", { KIMI_CODE_HOME: source }, "/unused", {
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/legacy journals are unsafe/u);
      expect(fs.existsSync(path.join(source, "credentials", ".kimi-code.ultrafuzz-modal-node-execution.lock"))).toBe(
        false
      );
      expect(openFileDescriptorsBelow(source)).toEqual([]);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("brokers Kimi rotation from only the candidate refresh token and validated provider fields", async () => {
    const source = kimiAuthFixture({ fresh: true, oauthHost: "https://auth.persisted.example" });
    const credentialPath = path.join(source, "credentials", "kimi-code.json");
    const persistedBefore = fs.readFileSync(credentialPath, "utf8");
    const initial = {
      ...(JSON.parse(persistedBefore) as Record<string, unknown>),
      token_type: "TrustedInitial",
      scope: "trusted-initial-scope",
      trusted_profile: { account: "stable-account" }
    };
    let exchanges = 0;
    const fetchImpl: typeof fetch = async (request, init) => {
      exchanges += 1;
      expect(String(request)).toBe("https://auth.persisted.example/api/oauth/token");
      expect(new Headers(init?.headers).get("X-Msh-Device-Id")).toBe("device-test");
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("child-refresh-only");
      return new Response(
        JSON.stringify({
          access_token: "provider-access",
          refresh_token: "provider-refresh",
          expires_in: 600,
          token_type: "ProviderBearer",
          scope: "provider-scope",
          injected_provider_field: "must-not-emerge"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const brokered = await brokerKimiSubscriptionAuthRotation(
      {
        source,
        model: "kimi-k3",
        initialCredential: `${JSON.stringify(initial)}\n`,
        candidateCredential: `${JSON.stringify({
          access_token: { attacker: "candidate-access" },
          refresh_token: "child-refresh-only",
          expires_at: 9_999_999_999,
          expires_in: 99_999,
          token_type: "CandidateBearer",
          scope: ["candidate-scope"],
          trusted_profile: { account: "mutated-account" },
          injected_candidate_field: "must-not-emerge"
        })}\n`,
        env: {}
      },
      { fetch: fetchImpl, now: () => 2_000_000_000 }
    );

    expect(exchanges).toBe(1);
    expect(brokered).toEqual({
      ...initial,
      access_token: "provider-access",
      refresh_token: "provider-refresh",
      expires_at: 2_000_600,
      expires_in: 600,
      token_type: "ProviderBearer",
      scope: "provider-scope"
    });
    expect(brokered).not.toHaveProperty("injected_candidate_field");
    expect(brokered).not.toHaveProperty("injected_provider_field");
    expect(fs.readFileSync(credentialPath, "utf8")).toBe(persistedBefore);
  });

  it("fails Kimi brokerage closed on rejected or invalid provider responses without writing the candidate", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const credentialPath = path.join(source, "credentials", "kimi-code.json");
    const initialCredential = fs.readFileSync(credentialPath, "utf8");
    const candidateCredential = `${JSON.stringify({
      access_token: "untrusted-access",
      refresh_token: "untrusted-refresh",
      expires_at: 9_999_999_999,
      injected: "untrusted"
    })}\n`;
    const persistedBefore = fs.readFileSync(credentialPath, "utf8");
    const responses = [
      new Response('{"error":"rejected"}', { status: 401, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ access_token: "provider-access", expires_in: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      new Response(
        JSON.stringify({
          access_token: "provider-access",
          refresh_token: "provider-refresh",
          expires_in: 600,
          scope: ["not-a-provider-string"]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ];

    for (const response of responses) {
      await expect(
        brokerKimiSubscriptionAuthRotation(
          { source, model: "kimi-k3", initialCredential, candidateCredential, env: {} },
          { fetch: async () => response.clone(), now: () => 2_000_000_000 }
        )
      ).rejects.toThrow(/refresh failed with HTTP 401|unsupported response/u);
      expect(fs.readFileSync(credentialPath, "utf8")).toBe(persistedBefore);
    }
  });

  it("rejects missing, empty, NUL, and oversized child refresh tokens before Kimi brokerage", async () => {
    const source = kimiAuthFixture({ fresh: true });
    const initialCredential = fs.readFileSync(path.join(source, "credentials", "kimi-code.json"), "utf8");
    let exchanges = 0;
    const fetchImpl: typeof fetch = async () => {
      exchanges += 1;
      throw new Error("broker must not exchange an invalid child token");
    };
    const candidates = [
      {},
      { refresh_token: "" },
      { refresh_token: "   " },
      { refresh_token: "bad\0token" },
      { refresh_token: "x".repeat(64 * 1024 + 1) }
    ];

    for (const candidate of candidates) {
      await expect(
        brokerKimiSubscriptionAuthRotation(
          {
            source,
            model: "kimi-k3",
            initialCredential,
            candidateCredential: JSON.stringify(candidate),
            env: {}
          },
          { fetch: fetchImpl }
        )
      ).rejects.toThrow(/invalid refresh token/u);
    }
    await expect(
      brokerKimiSubscriptionAuthRotation(
        {
          source,
          model: "kimi-k3",
          initialCredential,
          candidateCredential: JSON.stringify({
            refresh_token: "otherwise-valid",
            padding: "x".repeat(1024 * 1024)
          }),
          env: {}
        },
        { fetch: fetchImpl }
      )
    ).rejects.toThrow(/unsafe size/u);
    expect(exchanges).toBe(0);
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
    const credentialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-credential-root-test-"));
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
    expect(snapshotConfig).toContain('oauth_host = "https://auth.persisted.example"');
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
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-auth-test-"));
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
oauth = { storage = "file", key = ${JSON.stringify(oauthKey)}${options.oauthHost === undefined ? "" : `, oauth_host = ${JSON.stringify(options.oauthHost)}`} }
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

function testProcessIdentity(pid: number): {
  owner_process_start: string;
  owner_host_id: string;
  owner_boot_id: string;
  owner_pid_namespace: string;
} {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const closingParenthesis = stat.lastIndexOf(")");
  if (closingParenthesis < 0) throw new Error("test process stat is malformed");
  const startToken = stat
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/u)[19];
  if (startToken === undefined) throw new Error("test process stat has no start token");
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const pidNamespace = fs.readlinkSync(`/proc/${pid}/ns/pid`);
  return {
    owner_process_start: startToken,
    owner_host_id: kimiRuntimeScopedIdentity(os.hostname(), bootId, pidNamespace),
    owner_boot_id: bootId,
    owner_pid_namespace: pidNamespace
  };
}

function openFileDescriptorsBelow(root: string): string[] {
  return fs
    .readdirSync("/proc/self/fd")
    .flatMap((entry) => {
      try {
        return [fs.readlinkSync(path.join("/proc/self/fd", entry))];
      } catch {
        return [];
      }
    })
    .filter((openedPath) => openedPath === root || openedPath.startsWith(`${root}${path.sep}`));
}

function lastKimiLeaseJournalState(file: string): string | undefined {
  const records = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  const last = records.at(-1);
  if (last === undefined || last === "") return undefined;
  return (JSON.parse(last) as { rotation_state?: string }).rotation_state;
}

function lastKimiLeaseJournalSequence(file: string): number | undefined {
  const records = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  const last = records.at(-1);
  if (last === undefined || last === "") return undefined;
  return (JSON.parse(last) as { transition_sequence?: number }).transition_sequence;
}
