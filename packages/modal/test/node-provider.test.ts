import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SandboxFilesystemNotFoundError, type Sandbox } from "modal";
import { runWithToolContext } from "@smithers-orchestrator/tool-context";
import { describe, expect, it, vi } from "vitest";

import { WORKSPACE_SOURCE_ATTESTATION_FILE } from "@ultrafuzz/runtime";

import { acquireKimiModalNodeExecutionLease, prepareSubscriptionAuthCopy } from "../src/auth.js";

import {
  cleanupModalNodeRun,
  cleanupModalNodeLocalState,
  createModalNodeHandoffArchive,
  createModalNodeSandboxProvider as createRawModalNodeSandboxProvider,
  finalizeModalNodeSandbox,
  ModalNodeCleanupRefusedError,
  modalNodeExecutionIdentity,
  modalNodeExecutionReceipt,
  modalNodeRequestFingerprint,
  modalNodeSandboxName,
  modalNodeTags,
  modalNodeVolumeName,
  parseCloudAgentAuthDescriptor,
  parseModalNodeSandboxInput,
  assertNoForwardedCredentialBytes,
  type ModalNodeSandboxInput
} from "../src/node-provider.js";
import {
  assertAgentRuntimeTree,
  cloudAgentCommandRole,
  cloudAgentInvocation,
  cloudAgentSubprocessInvocation,
  CloudWorkerCommandError,
  cloudPublicationBoundary,
  copyAttemptVerificationMarker,
  copyPublishedEvidenceTree,
  copySafeTree,
  copyVerifiedPublishedEvidenceTree,
  finalizeWorkerHandoffCleanup,
  finalizeWorkerSecretCleanup,
  initializeDurableNodeWorkspace,
  rewriteCloudAgentAuthConfig,
  runAfterCloudAgentQuiescence,
  runDurableWorkflow,
  sealCloudKimiSubscriptionAuthHome,
  stageCanonicalNodeResultBundle,
  workflowCommandArguments,
  workerResultPublicationMode,
  workerErrorPayload
} from "../src/node-worker.js";
import { extractSafeTarArchive } from "../src/safe-archive.js";

const PROVIDER_ID_ENV = "ULTRAFUZZ_TEST_PROVIDER_ID";
const PROVIDER_SECRET_ENV = "ULTRAFUZZ_TEST_PROVIDER_SECRET";
const AGENT_ENV = "ULTRAFUZZ_TEST_AGENT_KEY";
const KIMI_CREDENTIAL_LEASE_ID = "9".repeat(64);
const KIMI_CREDENTIAL_LEASE_OWNER = "lease-owner-test";

function deepSeekAgentAuth(sourceEnv = AGENT_ENV): ModalNodeSandboxInput["agent_auth"] {
  return {
    agent: "DeepSeekAgent",
    provider: "deepseek",
    auth: { mode: "api-key", source_env: sourceEnv }
  };
}

function kimiApiAgentAuth(): ModalNodeSandboxInput["agent_auth"] {
  return {
    agent: "KimiAgent",
    provider: "kimi",
    auth: {
      mode: "api-key",
      source_env: "KIMI_API_KEY",
      fallback_source_env: "MOONSHOT_API_KEY",
      base_url_source_env: "KIMI_BASE_URL"
    }
  };
}

function createModalNodeSandboxProvider(
  options: Parameters<typeof createRawModalNodeSandboxProvider>[0]
): ReturnType<typeof createRawModalNodeSandboxProvider> {
  const provider = createRawModalNodeSandboxProvider(options);
  return {
    ...provider,
    run(request) {
      const input = request.input as Partial<ModalNodeSandboxInput> | undefined;
      return runWithToolContext(
        {
          runId: request.runId,
          nodeId: input?.task_id,
          iteration: 0,
          attempt: 1
        },
        () => provider.run(request)
      );
    }
  };
}

describe("Modal node sandbox provider", () => {
  it("keeps workflow and controller lineage stable across distinct cloud tasks", () => {
    const common: ModalNodeSandboxInput = {
      schema_version: "ultrafuzz.modal.node.v1",
      run_id: "runtime-run",
      task_id: "node:attempt-one",
      attempt_id: "attempt-one",
      execution_generation: "generation-one",
      workflow_execution_id: "workflow-execution-one",
      controller_invocation_id: "controller-invocation-one",
      base_commit: "a".repeat(40),
      workflow_path: ".smithers/workflows/runtime-run.tsx",
      run_root: ".ultrafuzz/runs/runtime-run",
      artifact_dir: ".ultrafuzz/runs/runtime-run/artifacts/attempt-one",
      workspace_dir: ".ultrafuzz/runs/runtime-run/workspaces/attempt-one",
      dependency_artifact_dirs: [],
      project_archive_sha256: "b".repeat(64),
      resources: { cpu: 2, memory_mib: 4096, timeout_seconds: 60 },
      agent_auth: deepSeekAgentAuth(),
      request_fingerprint: "c".repeat(64),
      execution_identity: "d".repeat(64)
    };
    const first = modalNodeExecutionReceipt(
      { runId: "workflow-run" },
      common,
      { sandboxId: "sandbox-one" } as Pick<Sandbox, "sandboxId">,
      { artifact_sha256: "e".repeat(64) },
      { runId: "workflow-run", nodeId: "node:attempt-one", iteration: 0, attempt: 1 }
    );
    const second = modalNodeExecutionReceipt(
      { runId: "workflow-run" },
      {
        ...common,
        task_id: "node:attempt-two",
        attempt_id: "attempt-two",
        artifact_dir: ".ultrafuzz/runs/runtime-run/artifacts/attempt-two",
        workspace_dir: ".ultrafuzz/runs/runtime-run/workspaces/attempt-two",
        request_fingerprint: "f".repeat(64),
        execution_identity: "0".repeat(64)
      },
      { sandboxId: "sandbox-two" } as Pick<Sandbox, "sandboxId">,
      { artifact_sha256: "1".repeat(64) },
      { runId: "workflow-run", nodeId: "node:attempt-two", iteration: 0, attempt: 1 }
    );

    expect(new Set([first.workflow_execution_id, second.workflow_execution_id])).toEqual(
      new Set(["workflow-execution-one"])
    );
    expect(new Set([first.controller_invocation_id, second.controller_invocation_id])).toEqual(
      new Set(["controller-invocation-one"])
    );
    expect(first.checkpoint_generation_id).toBe(second.checkpoint_generation_id);
    expect(first.executor_retry_id).not.toBe(second.executor_retry_id);
  });

  it("terminates and closes even when local archive cleanup fails", async () => {
    const sandbox = fakeSandbox(undefined);
    const close = vi.fn();
    const release = vi.fn(async () => undefined);
    await expect(
      finalizeModalNodeSandbox(
        () => {
          throw new Error("local cleanup failed");
        },
        sandbox,
        close,
        release
      )
    ).rejects.toThrow("local cleanup failed");
    expect(sandbox.terminate).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("prioritizes unproven sandbox termination over local cleanup failure", async () => {
    const sandbox = fakeSandbox(undefined);
    sandbox.terminate = vi.fn(async () => {
      throw new Error("termination failed");
    });
    const close = vi.fn();
    await expect(
      finalizeModalNodeSandbox(
        () => {
          throw new Error("local cleanup failed");
        },
        sandbox,
        close
      )
    ).rejects.toThrow("remained live after termination");
    expect(close).toHaveBeenCalledOnce();
  });

  it("prioritizes remote credential proof over local cleanup failure", async () => {
    const cleanupError = new Error("local cleanup failed");
    const remoteProofError = new Error("credential fence remote proof failed");
    const failure = await finalizeModalNodeSandbox(
      () => {
        throw cleanupError;
      },
      undefined,
      () => undefined,
      async () => {
        throw remoteProofError;
      }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cause: remoteProofError,
      errors: [remoteProofError, cleanupError],
      message: remoteProofError.message
    });
  });

  it("attempts every prepared-auth and staging cleanup independently", () => {
    const first = new Error("archive cleanup failed");
    const second = new Error("snapshot cleanup failed");
    const events: string[] = [];
    let failure: unknown;
    try {
      cleanupModalNodeLocalState(
        () => {
          events.push("archive");
          throw first;
        },
        () => {
          events.push("snapshot");
          throw second;
        },
        () => events.push("handoff")
      );
    } catch (error) {
      failure = error;
    }

    expect(events).toEqual(["archive", "snapshot", "handoff"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([first, second]);
  });

  it("preserves termination, cleanup, and close failures while surfacing unproven termination", async () => {
    const sandbox = fakeSandbox(undefined);
    const terminationError = new Error("termination failed");
    const cleanupError = new Error("local cleanup failed");
    const closeError = new Error("client close failed");
    const release = vi.fn(async () => undefined);
    sandbox.terminate = vi.fn(async () => {
      throw terminationError;
    });

    const failure = await finalizeModalNodeSandbox(
      () => {
        throw cleanupError;
      },
      sandbox,
      () => {
        throw closeError;
      },
      release
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(Object.prototype.propertyIsEnumerable.call(failure, "errors")).toBe(true);
    expect(failure).toMatchObject({
      cause: expect.objectContaining({
        cause: terminationError,
        message: "cloud node sandbox remained live after termination"
      }),
      errors: [
        expect.objectContaining({
          cause: terminationError,
          message: "cloud node sandbox remained live after termination"
        }),
        cleanupError,
        closeError
      ],
      message: "cloud node sandbox remained live after termination"
    });
    expect(sandbox.terminate).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(false);
    expect(closeError.message).toBe("client close failed");
  });

  it("attempts termination when the initial sandbox state query fails", async () => {
    const sandbox = fakeSandbox(undefined);
    sandbox.poll.mockRejectedValueOnce(new Error("transient state query failure"));
    const close = vi.fn();

    await expect(finalizeModalNodeSandbox(() => undefined, sandbox, close)).resolves.toBeUndefined();

    expect(sandbox.terminate).toHaveBeenCalledOnce();
    expect(sandbox.poll).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves every failure when sandbox termination cannot be verified", async () => {
    const sandbox = fakeSandbox(undefined);
    const initialPollError = new Error("initial poll failed");
    const terminationError = new Error("termination failed");
    const verificationError = new Error("verification poll failed");
    sandbox.poll.mockRejectedValueOnce(initialPollError).mockRejectedValueOnce(verificationError);
    sandbox.terminate = vi.fn(async () => {
      throw terminationError;
    });

    const failure = await finalizeModalNodeSandbox(
      () => undefined,
      sandbox,
      () => undefined
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cause: verificationError,
      errors: [initialPollError, terminationError, verificationError],
      message: "cloud node sandbox termination state could not be verified"
    });
    expect(sandbox.terminate).toHaveBeenCalledOnce();
    expect(sandbox.poll).toHaveBeenCalledTimes(2);
  });

  it("uses stable bounded identities without embedding raw controller identifiers", () => {
    const tags = modalNodeTags("run/with spaces", "node:attempt");
    expect(tags).toEqual({
      purpose: "ultrafuzz-node",
      run: expect.stringMatching(/^run-with-spaces-[0-9a-f]{12}$/u),
      attempt: expect.stringMatching(/^node-attempt-base-[0-9a-f]{12}$/u),
      isolation_protocol: "rootless-durable-v3"
    });
    expect(modalNodeSandboxName("run/with spaces", "node:attempt")).toMatch(
      /^ufz-run-with-spaces-node-attempt-bas-[0-9a-f]{12}$/u
    );
    expect(modalNodeVolumeName("run/with spaces")).toMatch(/^ultrafuzz-node-run-with-spaces-[0-9a-f]{12}$/u);
    expect(modalNodeTags("run/with spaces", "node:attempt", "reset-one").attempt).not.toBe(tags.attempt);
  });

  it("strictly validates cloud agent/provider authentication descriptors", () => {
    expect(() =>
      parseCloudAgentAuthDescriptor({
        agent: "DeepSeekAgent",
        provider: "anthropic",
        auth: { mode: "api-key", source_env: AGENT_ENV }
      })
    ).toThrow(/agent\/provider authentication pairing is invalid/u);
    expect(() =>
      parseCloudAgentAuthDescriptor({
        ...deepSeekAgentAuth(),
        auth: { mode: "api-key", source_env: AGENT_ENV, attacker: true }
      })
    ).toThrow(/API-key authentication source is invalid/u);
    expect(() => parseCloudAgentAuthDescriptor(deepSeekAgentAuth("NODE_OPTIONS"))).toThrow(/reserved or invalid/u);
    expect(() => parseCloudAgentAuthDescriptor(deepSeekAgentAuth("ULTRAFUZZ_KIMI_SESSION_HOME"))).toThrow(
      /reserved or invalid/u
    );
    expect(() =>
      parseCloudAgentAuthDescriptor({
        agent: "KimiAgent",
        provider: "kimi",
        auth: { mode: "api-key", source_env: "KIMI_API_KEY" }
      })
    ).toThrow(/Kimi API-key authentication source shape is invalid/u);
  });

  it.each([
    ["CodexAgent", "openai"],
    ["ClaudeAgent", "anthropic"],
    ["DeepSeekAgent", "deepseek"]
  ])("rejects subscription authentication for %s", (agent, provider) => {
    expect(() => parseCloudAgentAuthDescriptor({ agent, provider, auth: { mode: "subscription" } })).toThrow(
      /supported only for Kimi/u
    );
  });

  it("requires an exact model alias for Kimi subscription authentication", () => {
    const fixture = createProjectFixture();
    try {
      expect(() =>
        parseModalNodeSandboxInput({
          ...fixture.input,
          agent_auth: { agent: "KimiAgent", provider: "kimi", auth: { mode: "subscription" } }
        })
      ).toThrow(/requires an exact model alias/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects unsafe cloud attempt identifiers before marker paths are created", () => {
    const fixture = createProjectFixture();
    try {
      for (const attemptId of ["../attempt-one", "nested/attempt-one", ".attempt-one", "attempt one"]) {
        expect(() => parseModalNodeSandboxInput({ ...fixture.input, attempt_id: attemptId })).toThrow(
          /cloud node attempt_id is invalid/u
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("changes recovery identity when any execution-bound input changes", () => {
    const fixture = createProjectFixture();
    try {
      const base: ModalNodeSandboxInput = {
        ...fixture.input,
        project_archive_sha256: "1".repeat(64)
      };
      const identify = (input: ModalNodeSandboxInput): string => {
        const request_fingerprint = modalNodeRequestFingerprint(input);
        return modalNodeExecutionIdentity({ ...input, request_fingerprint });
      };
      const baselineFingerprint = modalNodeRequestFingerprint(base);
      const baseline = identify(base);
      const variants: ModalNodeSandboxInput[] = [
        { ...base, task_id: "node:attempt-two" },
        { ...base, workflow_execution_id: "workflow-execution-two" },
        { ...base, controller_invocation_id: "controller-invocation-two" },
        { ...base, base_commit: "b".repeat(40) },
        { ...base, project_archive_sha256: "2".repeat(64) },
        { ...base, operator_prompt: "different request" }
      ];
      expect(new Set(variants.map(identify)).size).toBe(variants.length);
      expect(variants.map(identify)).not.toContain(baseline);
      expect(modalNodeRequestFingerprint(variants[3]!)).not.toBe(baselineFingerprint);
    } finally {
      fixture.cleanup();
    }
  });

  it("runs the trusted workflow controller as root with an exact clean environment", () => {
    const invocation = cloudAgentInvocation(
      "/workspace/project/.smithers/node_modules/.bin/smithers",
      ["up", "workflow.tsx"],
      deepSeekAgentAuth(),
      {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        DEEPSEEK_API_KEY: "agent-key-value",
        [PROVIDER_ID_ENV]: "controller-token-id",
        [PROVIDER_SECRET_ENV]: "controller-token-secret",
        OPENAI_JUDGE_API_KEY: "judge-key-value",
        NODE_OPTIONS: "--require=/tmp/untrusted.js"
      }
    );

    expect(invocation.command).toBe("/workspace/project/.smithers/node_modules/.bin/smithers");
    expect(invocation.args).toEqual(["up", "workflow.tsx"]);
    expect(invocation.env).toMatchObject({
      HOME: "/workspace/agent-home",
      USER: "ultrafuzz-agent",
      LOGNAME: "ultrafuzz-agent",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      DEEPSEEK_API_KEY: "agent-key-value",
      ULTRAFUZZ_CLOUD_WORKER: "1"
    });
    expect(invocation.env).not.toHaveProperty(PROVIDER_ID_ENV);
    expect(invocation.env).not.toHaveProperty(PROVIDER_SECRET_ENV);
    expect(invocation.env).not.toHaveProperty("OPENAI_JUDGE_API_KEY");
    expect(invocation.env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("pins Kimi sessions to the pre-owned agent home", () => {
    const invocation = cloudAgentInvocation(
      "/workspace/project/.smithers/node_modules/.bin/smithers",
      [],
      kimiApiAgentAuth(),
      {
        KIMI_API_KEY: "agent-key-value"
      }
    );

    expect(invocation.env.ULTRAFUZZ_KIMI_SESSION_HOME).toBe("/workspace/agent-home/.kimi-code-sessions");
  });

  it("seals Kimi subscription credentials against worker-side rotation while leaving only OAuth locks writable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-worker-seal-"));
    const agentHome = path.join(root, "agent-home");
    const authHome = path.join(agentHome, ".kimi-code");
    const credentials = path.join(authHome, "credentials");
    const credential = path.join(credentials, "kimi-code.json");
    const uid = process.getuid?.() ?? fs.statSync(root).uid;
    const gid = process.getgid?.() ?? fs.statSync(root).gid;
    try {
      fs.mkdirSync(credentials, { recursive: true });
      fs.writeFileSync(path.join(authHome, "config.toml"), "[providers.kimi]\n");
      fs.writeFileSync(path.join(authHome, "device_id"), "device-a\n");
      fs.writeFileSync(credential, '{"access_token":"A","refresh_token":"A-refresh"}\n');

      sealCloudKimiSubscriptionAuthHome(authHome, agentHome, {
        rootUid: uid,
        rootGid: gid,
        agentUid: uid,
        agentGid: gid
      });
      expect(fs.statSync(agentHome).mode & 0o777).toBe(0o755);
      expect(fs.statSync(authHome).mode & 0o777).toBe(0o555);
      expect(fs.statSync(credentials).mode & 0o777).toBe(0o555);
      expect(fs.statSync(credential).mode & 0o777).toBe(0o444);
      expect(() => fs.writeFileSync(credential, '{"access_token":"B","refresh_token":"B-refresh"}\n')).toThrow();
      expect(() => fs.writeFileSync(path.join(credentials, "successor.json"), "C\n")).toThrow();
      expect(fs.readFileSync(credential, "utf8")).toContain('"access_token":"A"');

      const oauthLock = path.join(authHome, "oauth", "kimi-code.lock");
      fs.writeFileSync(oauthLock, "lock\n");
      expect(fs.readFileSync(oauthLock, "utf8")).toBe("lock\n");

      // Reproduce the recursive ownership preparation performed before every
      // supervised model command, then prove resealing restores the boundary.
      fs.chmodSync(agentHome, 0o700);
      fs.chmodSync(authHome, 0o700);
      fs.chmodSync(credentials, 0o700);
      fs.chmodSync(credential, 0o600);
      sealCloudKimiSubscriptionAuthHome(authHome, agentHome, {
        rootUid: uid,
        rootGid: gid,
        agentUid: uid,
        agentGid: gid
      });
      expect(fs.statSync(credential).mode & 0o777).toBe(0o444);
      expect(fs.statSync(path.join(authHome, "oauth")).mode & 0o777).toBe(0o700);
    } finally {
      for (const entry of [agentHome, authHome, credentials, credential]) {
        if (fs.existsSync(entry)) fs.chmodSync(entry, fs.lstatSync(entry).isDirectory() ? 0o700 : 0o600);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops only the model CLI subprocess to a capability-free uid", () => {
    const invocation = cloudAgentSubprocessInvocation("/usr/local/bin/claude", ["--print", "prompt"]);

    expect(invocation.command).toBe("/usr/bin/setpriv");
    expect(invocation.args.slice(0, 8)).toEqual([
      "--reuid=65532",
      "--regid=65532",
      "--clear-groups",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--pdeathsig=SIGKILL"
    ]);
    expect(invocation.args.slice(8)).toEqual(["/usr/local/bin/claude", "--print", "prompt"]);
    expect(() => cloudAgentSubprocessInvocation("claude", ["--print"])).toThrow(/executable is invalid/u);
  });

  it("quiesces only exact model invocation shapes and fails closed otherwise", () => {
    expect(cloudAgentCommandRole("codex", ["exec", "--json", "prompt"])).toBe("model");
    expect(cloudAgentCommandRole("claude", ["--print", "--output-format", "stream-json"])).toBe("model");
    expect(cloudAgentCommandRole("kimi", ["--model", "kimi-for-coding", "--print"])).toBe("model");
    expect(cloudAgentCommandRole("claude", ["auth", "status"])).toBe("diagnostic");
    expect(() => cloudAgentCommandRole("codex", ["--version"])).toThrow(/shape is unsupported/u);
    expect(() => cloudAgentCommandRole("claude", ["auth", "login"])).toThrow(/shape is unsupported/u);
    expect(() => cloudAgentCommandRole("kimi", ["login"])).toThrow(/shape is unsupported/u);
  });

  it("rewrites selected worker auth to canonical child names and isolated subscription state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-config-"));
    const configPath = path.join(root, "ultrafuzz.toml");
    const chown = vi.spyOn(fs, "chownSync").mockImplementation(() => undefined);
    try {
      fs.writeFileSync(
        configPath,
        [
          "[agents.DeepSeekAgent]",
          'api_key_env = "HOST_DEEPSEEK_KEY"',
          "",
          "[agents.KimiAgent]",
          'config_dir = "/host/kimi"',
          ""
        ].join("\n")
      );
      rewriteCloudAgentAuthConfig(deepSeekAgentAuth(), root);
      const deepSeekConfig = fs.readFileSync(configPath, "utf8");
      expect(deepSeekConfig).toContain('api_key_env = "DEEPSEEK_API_KEY"');
      expect(deepSeekConfig).toContain('config_dir = "/workspace/agent-home/.deepseek-claude"');

      rewriteCloudAgentAuthConfig({ agent: "KimiAgent", provider: "kimi", auth: { mode: "subscription" } }, root);
      expect(fs.readFileSync(configPath, "utf8")).toContain('config_dir = "/workspace/agent-home/.kimi-code"');
      expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(false);
    } finally {
      chown.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts only runtime trees and symlink targets contained by the agent home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-agent-runtime-tree-"));
    const agentHome = path.join(root, "agent-home");
    const safeTarget = path.join(agentHome, "kimi-sessions");
    const safeLink = path.join(agentHome, "current-kimi-sessions");
    const outside = path.join(root, "outside");
    const escapingLink = path.join(agentHome, "escaping-kimi-sessions");
    const outsideLexicalLink = path.join(root, "project-kimi-sessions");
    try {
      fs.mkdirSync(safeTarget, { recursive: true });
      fs.writeFileSync(path.join(safeTarget, "session.json"), "{}\n");
      fs.mkdirSync(outside);
      fs.symlinkSync(safeTarget, safeLink, "dir");
      fs.symlinkSync(outside, escapingLink, "dir");
      fs.symlinkSync(safeTarget, outsideLexicalLink, "dir");

      expect(() => assertAgentRuntimeTree(safeLink, agentHome)).not.toThrow();
      expect(() => assertAgentRuntimeTree(escapingLink, agentHome)).toThrow(/escapes its writable boundaries/u);
      expect(() => assertAgentRuntimeTree(outsideLexicalLink, agentHome)).toThrow(/escapes its writable boundaries/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins cloud results to a root-private ephemeral /run boundary", () => {
    expect(cloudPublicationBoundary("/run/ultrafuzz-node-results/run/attempt")).toEqual({
      root: "/run/ultrafuzz-node-results",
      resultRoot: "/run/ultrafuzz-node-results/run/attempt",
      uid: 0,
      gid: 0,
      mode: 0o700
    });
    expect(() => cloudPublicationBoundary("/data/shared-result")).toThrow(/escapes the private runtime root/u);
    expect(() => cloudPublicationBoundary("/run/ultrafuzz-node-results")).toThrow(/escapes the private runtime root/u);
  });

  it("kills a daemonized agent UID before permitting trusted postflight", async () => {
    const events: string[] = [];
    let now = 0;
    let daemonAlive = true;
    await expect(
      runAfterCloudAgentQuiescence(
        async () => {
          events.push("direct-child-exited");
        },
        async () => {
          events.push("root-postflight");
          return "published";
        },
        {
          now: () => now,
          pause: async () => {
            now += 250;
          },
          scan: () => (daemonAlive ? [4242] : []),
          signal: (_pid, signal) => {
            events.push(signal);
            if (signal === "SIGKILL") daemonAlive = false;
          },
          timeoutMs: 2_000
        }
      )
    ).resolves.toBe("published");
    expect(events).toEqual(["direct-child-exited", "SIGTERM", "SIGTERM", "SIGKILL", "root-postflight"]);
  });

  it("never runs root postflight when UID quiescence cannot be proven", async () => {
    const postflight = vi.fn(async () => undefined);
    await expect(
      runAfterCloudAgentQuiescence(async () => undefined, postflight, {
        scan: () => {
          throw new Error("proc unavailable");
        }
      })
    ).rejects.toThrow("proc unavailable");
    expect(postflight).not.toHaveBeenCalled();
  });

  it("runs credential quarantine after a failed workflow once UID quiescence is proven", async () => {
    const workflowError = new Error("workflow failed after rotating credentials");
    const postflight = vi.fn(async (agentError: unknown) => {
      expect(agentError).toBe(workflowError);
      return "candidate-quarantined";
    });

    const failure = await runAfterCloudAgentQuiescence(
      async () => {
        throw workflowError;
      },
      postflight,
      { scan: () => [], pause: async () => undefined }
    ).catch((error: unknown) => error);

    expect(failure).toBe(workflowError);
    expect(postflight).toHaveBeenCalledOnce();
  });

  it.each(["candidate read", "UID quiescence"])(
    "suppresses opaque successor-token streams when %s fails before classification",
    async (failurePhase) => {
      const opaqueSuccessor = "opaque-successor-token-without-a-label";
      const commandError = new CloudWorkerCommandError(
        "run-workflow",
        "smithers",
        7,
        `stdout ${opaqueSuccessor}`,
        `stderr ${opaqueSuccessor}`,
        true
      );
      const failure =
        failurePhase === "UID quiescence"
          ? await runAfterCloudAgentQuiescence(
              async () => {
                throw commandError;
              },
              async () => undefined,
              {
                scan: () => {
                  throw new Error("proc unavailable");
                }
              }
            ).catch((error: unknown) => error)
          : new AggregateError([commandError, new Error("candidate validation failed")], commandError.message, {
              cause: commandError
            });

      const payload = workerErrorPayload(failure, ["initial-access", "initial-refresh"], {
        rotationPossible: true,
        successorSecretsClassified: false
      });
      expect(payload).toMatchObject({
        schema_version: "ultrafuzz.modal.node-worker-error.v1",
        phase: "run-workflow",
        streams_suppressed: true
      });
      expect(JSON.stringify(payload)).not.toContain(opaqueSuccessor);
      expect(payload).not.toHaveProperty("stdout");
      expect(payload).not.toHaveProperty("stderr");
    }
  );

  it("never retains intermediate command streams after the final successor is classified", () => {
    const intermediateSuccessor = "opaque-intermediate-g1-token";
    const finalSuccessor = "classified-final-g2-token";
    const commandError = new CloudWorkerCommandError(
      "run-workflow",
      "smithers",
      9,
      `stdout ${intermediateSuccessor}`,
      `stderr ${intermediateSuccessor}`,
      true
    );
    const failure = new AggregateError([commandError, new Error("final candidate publication failed")], "failed", {
      cause: commandError
    });

    expect(recursiveOwnValueContains(failure, intermediateSuccessor)).toBe(false);
    const payload = workerErrorPayload(failure, ["initial-access", "initial-refresh", finalSuccessor], {
      rotationPossible: true,
      successorSecretsClassified: true
    });
    expect(payload).toMatchObject({
      schema_version: "ultrafuzz.modal.node-worker-error.v1",
      phase: "run-workflow",
      command: "smithers",
      exit_code: 9,
      streams_suppressed: true
    });
    expect(JSON.stringify(payload)).not.toContain(intermediateSuccessor);
    expect(JSON.stringify(payload)).not.toContain(finalSuccessor);
    expect(payload).not.toHaveProperty("stdout");
    expect(payload).not.toHaveProperty("stderr");
  });

  it("preserves bounded command diagnostics when subscription rotation is impossible", () => {
    const commandError = new CloudWorkerCommandError(
      "install-smithers",
      "npm",
      11,
      "ordinary stdout",
      "ordinary stderr"
    );
    const payload = workerErrorPayload(commandError, [], {
      rotationPossible: false,
      successorSecretsClassified: true
    });
    expect(payload).toMatchObject({
      phase: "install-smithers",
      command: "npm",
      exit_code: 11,
      stdout: "ordinary stdout",
      stderr: "ordinary stderr"
    });
    expect(payload).not.toHaveProperty("streams_suppressed");
  });

  it("removes the trusted snapshot after a transport-first cleanup failure and aggregates both failures", () => {
    const events: string[] = [];
    const transportError = new Error("transport cleanup failed");
    const snapshotError = new Error("snapshot cleanup failed");
    let failure: unknown;
    try {
      finalizeWorkerHandoffCleanup(
        undefined,
        () => {
          events.push("transport");
          throw transportError;
        },
        () => {
          events.push("trusted-snapshot");
          throw snapshotError;
        }
      );
    } catch (error) {
      failure = error;
    }

    expect(events).toEqual(["transport", "trusted-snapshot"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([transportError, snapshotError]);
  });

  it("attempts every final secret cleanup while preserving the workflow failure as primary", () => {
    const workflowError = new Error("workflow failed");
    const launcherError = new Error("launcher cleanup failed");
    const snapshotError = new Error("snapshot cleanup failed");
    const events: string[] = [];
    let failure: unknown;
    try {
      finalizeWorkerSecretCleanup(
        workflowError,
        () => {
          events.push("launcher");
          throw launcherError;
        },
        () => {
          events.push("snapshot");
          throw snapshotError;
        },
        () => events.push("agent-home")
      );
    } catch (error) {
      failure = error;
    }

    expect(events).toEqual(["launcher", "snapshot", "agent-home"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cause: workflowError,
      errors: [workflowError, launcherError, snapshotError],
      message: workflowError.message
    });
  });

  it("waits for registered diagnostics before exposing the postflight tree", async () => {
    const events: string[] = [];
    let now = 0;
    let diagnosticRegistered = true;
    await expect(
      runAfterCloudAgentQuiescence(
        async () => {
          events.push("model-exited");
        },
        async () => {
          events.push("postflight");
          return "verified";
        },
        {
          now: () => now,
          pause: async () => {
            now += 100;
            if (now === 200) {
              diagnosticRegistered = false;
              events.push("diagnostic-stopped");
            }
          },
          scan: () => [],
          settled: () => !diagnosticRegistered,
          timeoutMs: 1_000
        }
      )
    ).resolves.toBe("verified");
    expect(events).toEqual(["model-exited", "diagnostic-stopped", "postflight"]);
  });

  it("freezes adversarial daemon mutations before trusted postflight", async () => {
    let now = 0;
    let daemonAlive = true;
    let hostileRevision = 0;
    const verified = await runAfterCloudAgentQuiescence(
      async () => undefined,
      async () => {
        expect(daemonAlive).toBe(false);
        return hostileRevision;
      },
      {
        now: () => now,
        pause: async () => {
          now += 250;
          if (daemonAlive) hostileRevision += 1;
        },
        scan: () => (daemonAlive ? [31337] : []),
        signal: (_pid, signal) => {
          if (signal === "SIGKILL") daemonAlive = false;
        },
        timeoutMs: 2_000
      }
    );
    expect(verified).toBe(2);
    expect(hostileRevision).toBe(verified);
  });

  it("creates an immutable handoff from committed source plus only declared dependency evidence", async () => {
    const fixture = createProjectFixture();
    fs.writeFileSync(path.join(fixture.root, "local-only-secret"), "must stay local\n");
    fs.writeFileSync(path.join(fixture.root, "source.txt"), "current checkout B\n");
    fs.writeFileSync(path.join(fixture.root, "current-only.txt"), "must not cross the pinned handoff\n");
    execFileSync("git", ["add", "source.txt", "current-only.txt"], { cwd: fixture.root });
    execFileSync("git", ["commit", "--quiet", "-m", "move current checkout to B"], { cwd: fixture.root });
    const currentCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: fixture.root,
      encoding: "utf8"
    }).trim();
    expect(currentCommit).not.toBe(fixture.input.base_commit);
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-handoff-extracted-"));
    try {
      const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" });
      expect(entries).toContain("./source.txt");
      expect(entries).toContain(`./${fixture.input.workflow_path}`);
      expect(entries).toContain(`./${fixture.input.prompt_path}`);
      expect(entries).toContain("./.smithers/agents/deepseek.ts");
      expect(entries).toContain("./.smithers/agents/kimi.ts");
      for (const dependency of fixture.input.dependency_artifact_dirs) {
        expect(entries).toContain(`./${dependency}/`);
        const marker = `./${fixture.input.run_root}/.ultrafuzz-verification/${path.basename(dependency)}.json`;
        expect(entries).toContain(marker);
      }
      expect(entries).not.toContain("local-only-secret");
      expect(entries).not.toContain("current-only.txt");
      expect(entries).not.toContain("unrelated.txt");
      expect(entries).not.toContain(`./${fixture.input.run_root}/.ultrafuzz-verification/unrelated.json`);
      expect(entries).not.toContain("stale.txt");
      expect(entries).not.toContain(`./${fixture.input.run_root}/workspaces/`);
      expect(entries).not.toContain(`./${fixture.input.run_root}/logs/`);
      expect(entries).not.toContain("./.git/logs/");
      expect(entries).not.toContain("./.git/hooks/");
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/u);
      await extractSafeTarArchive(archive.path, extracted, { gzip: true, label: "cloud handoff test" });
      const extractedCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: extracted,
        encoding: "utf8"
      }).trim();
      expect(extractedCommit).toBe(fixture.input.base_commit);
      expect(fs.readFileSync(path.join(extracted, "source.txt"), "utf8")).toBe("committed source\n");
      expect(fs.readFileSync(path.join(extracted, ".smithers", "agents", "deepseek.ts"), "utf8")).toContain(
        "createDeepSeekAgent"
      );
      expect(() => execFileSync("git", ["cat-file", "-e", "HEAD^"], { cwd: extracted, stdio: "ignore" })).toThrow();
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true });
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("creates byte-identical handoffs for unchanged declared inputs", async () => {
    const fixture = createProjectFixture();
    let first: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    let second: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    let changed: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    try {
      first = await createModalNodeHandoffArchive(fixture.root, fixture.input);
      const declaredInput = path.join(fixture.root, fixture.input.dependency_artifact_dirs[0]!, "declared.txt");
      const perturbedTime = new Date("2030-01-02T03:04:05.000Z");
      fs.utimesSync(declaredInput, perturbedTime, perturbedTime);
      second = await createModalNodeHandoffArchive(fixture.root, fixture.input);

      expect(second.sha256).toBe(first.sha256);
      expect(fs.readFileSync(second.path)).toEqual(fs.readFileSync(first.path));

      fs.writeFileSync(declaredInput, "changed declared evidence\n");
      changed = await createModalNodeHandoffArchive(fixture.root, fixture.input);
      expect(changed.sha256).not.toBe(first.sha256);
    } finally {
      first?.cleanup();
      second?.cleanup();
      changed?.cleanup();
      fixture.cleanup();
    }
  });

  it("validates the exact base commit and confines generated workflows to .smithers/workflows", async () => {
    const fixture = createProjectFixture();
    try {
      expect(() => parseModalNodeSandboxInput({ ...fixture.input, base_commit: "A".repeat(40) })).toThrow(
        /base commit is invalid/u
      );
      expect(() => parseModalNodeSandboxInput({ ...fixture.input, workflow_execution_id: "bad identity!" })).toThrow(
        /workflow_execution_id is invalid/u
      );
      await expect(
        createModalNodeHandoffArchive(fixture.root, {
          ...fixture.input,
          workflow_path: fixture.input.prompt_path!
        })
      ).rejects.toThrow(/workflow path must stay inside \.smithers\/workflows/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("includes the JSON schema bundle needed by rendered property prompts", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    try {
      const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" });
      expect(entries).toContain("./.ultrafuzz/schemas/property-lens.schema.json");
      expect(entries).toContain("./.ultrafuzz/schemas/properties.schema.json");
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects committed symlinks before building a cloud handoff archive", async () => {
    const fixture = createProjectFixture();
    try {
      fs.symlinkSync("source.txt", path.join(fixture.root, "source-link.txt"));
      execFileSync("git", ["add", "source-link.txt"], { cwd: fixture.root });
      execFileSync("git", ["commit", "--quiet", "-m", "add symlink"], { cwd: fixture.root });
      fixture.input.base_commit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: fixture.root,
        encoding: "utf8"
      }).trim();

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /unsafe filesystem entry|unsupported symlink entry/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects symlinked dependency verification marker directories in cloud handoff archives", async () => {
    const fixture = createProjectFixture();
    try {
      const markerRoot = path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification");
      const realMarkerRoot = path.join(fixture.root, fixture.input.run_root, "real-markers");
      fs.rmSync(markerRoot, { recursive: true, force: true });
      fs.mkdirSync(realMarkerRoot);
      fs.symlinkSync(realMarkerRoot, markerRoot, "dir");

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /dependency verification marker directory is not an anchored run path/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects symlinked dependency verification marker files in cloud handoff archives", async () => {
    const fixture = createProjectFixture();
    try {
      const markerRoot = path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification");
      const marker = path.join(markerRoot, "dependency-one.json");
      fs.rmSync(marker, { force: true });
      fs.symlinkSync("dependency-two.json", marker);

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /cloud handoff file must be a regular unlinked file/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects link entries before extracting a cloud result archive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-archive-link-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const outside = path.join(root, "outside");
    const archive = path.join(root, "result.tgz");
    try {
      fs.mkdirSync(source);
      fs.mkdirSync(destination);
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(source, "escape"), "dir");
      execFileSync("tar", ["-czf", archive, "-C", source, "."]);

      await expect(extractSafeTarArchive(archive, destination, { gzip: true, label: "test result" })).rejects.toThrow(
        /unsupported symlink entry/u
      );
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to publish a symlinked artifact root from a worker", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-symlink-"));
    try {
      const outside = path.join(root, "outside");
      const source = path.join(root, "artifact-root");
      const destination = path.join(root, "published");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "secret.txt"), "must not publish\n");
      fs.symlinkSync(outside, source, "dir");

      expect(() => copySafeTree(source, destination)).toThrow(/cloud publication source is unsafe/u);
      expect(fs.existsSync(path.join(destination, "secret.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to publish through a symlinked worker destination", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-destination-symlink-"));
    try {
      const source = path.join(root, "source");
      const outside = path.join(root, "outside");
      const destination = path.join(root, "destination");
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(source, "finding.json"), '{"ok":true}\n');
      fs.symlinkSync(outside, destination, "dir");

      expect(() => copySafeTree(source, destination)).toThrow(/cloud publication destination is unsafe/u);
      expect(fs.existsSync(path.join(outside, "finding.json"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes every manifest-declared artifact and nested invariant evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-manifest-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "published");
      const node = path.join(source, "property-specification-fanin");
      fs.mkdirSync(node, { recursive: true });
      const property = path.join(node, "properties.json");
      const generated = path.join(node, "generated-tests", "HubInvariant.t.sol");
      const nestedManifest = path.join(node, "fixtures", "artifact-manifest.json");
      const oneLevelFixtureManifest = path.join(source, "reports", "artifact-manifest.json");
      fs.mkdirSync(path.dirname(generated), { recursive: true });
      fs.mkdirSync(path.dirname(nestedManifest), { recursive: true });
      fs.mkdirSync(path.dirname(oneLevelFixtureManifest), { recursive: true });
      fs.writeFileSync(property, '{"schema_version":"ultrafuzz.properties.v1"}\n');
      fs.writeFileSync(generated, "contract HubInvariant {}\n");
      fs.writeFileSync(nestedManifest, '{"schema_version":"fixture"}\n');
      fs.writeFileSync(oneLevelFixtureManifest, '{"schema_version":"fixture"}\n');
      const manifest = {
        schema_version: "1.0",
        files: [
          manifestEntry("property-specification-fanin/properties.json", property),
          manifestEntry("property-specification-fanin/generated-tests/HubInvariant.t.sol", generated)
        ]
      };
      fs.writeFileSync(path.join(source, "artifact-manifest.json"), `${JSON.stringify(manifest)}\n`);

      copyPublishedEvidenceTree(source, destination);

      expect(fs.readFileSync(path.join(destination, "property-specification-fanin", "properties.json"), "utf8")).toBe(
        '{"schema_version":"ultrafuzz.properties.v1"}\n'
      );
      expect(
        fs.readFileSync(
          path.join(destination, "property-specification-fanin", "generated-tests", "HubInvariant.t.sol"),
          "utf8"
        )
      ).toBe("contract HubInvariant {}\n");
      expect(fs.existsSync(path.join(destination, "artifact-manifest.json"))).toBe(true);
      expect(
        fs.readFileSync(
          path.join(destination, "property-specification-fanin", "fixtures", "artifact-manifest.json"),
          "utf8"
        )
      ).toBe('{"schema_version":"fixture"}\n');
      expect(fs.readFileSync(path.join(destination, "reports", "artifact-manifest.json"), "utf8")).toBe(
        '{"schema_version":"fixture"}\n'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages only marker-verified cloud artifact publications", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-verified-publication-"));
    try {
      const source = path.join(root, "artifacts");
      const destination = path.join(root, "published");
      const marker = path.join(root, "attempt-one.json");
      const finding = path.join(source, "finding.json");
      const companion = path.join(source, "generated-tests", "Property.t.sol");
      fs.mkdirSync(path.dirname(companion), { recursive: true });
      fs.writeFileSync(finding, '{"ok":true}\n');
      fs.writeFileSync(companion, "contract Property {}\n");
      fs.writeFileSync(path.join(source, "workspace-mirror-extra.txt"), "unverified\n");
      fs.writeFileSync(
        marker,
        `${JSON.stringify({
          schema_version: "ultrafuzz.artifact-verification.v1",
          attempt_id: "attempt-one",
          artifacts: [],
          publications: [
            {
              path: "finding.json",
              sha256: crypto.createHash("sha256").update(fs.readFileSync(finding)).digest("hex")
            },
            {
              path: "generated-tests/Property.t.sol",
              sha256: crypto.createHash("sha256").update(fs.readFileSync(companion)).digest("hex")
            }
          ]
        })}\n`
      );

      copyVerifiedPublishedEvidenceTree(source, destination, marker, "attempt-one");

      expect(fs.readFileSync(path.join(destination, "finding.json"), "utf8")).toBe('{"ok":true}\n');
      expect(fs.readFileSync(path.join(destination, "generated-tests", "Property.t.sol"), "utf8")).toBe(
        "contract Property {}\n"
      );
      expect(fs.existsSync(path.join(destination, "workspace-mirror-extra.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages the current cloud attempt verification marker for controller publication", () => {
    const fixture = createProjectFixture();
    const destination = path.join(path.dirname(fixture.root), "verification-staging");
    try {
      fs.writeFileSync(
        path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"),
        '{"attempt_id":"attempt-one"}\n'
      );
      copyAttemptVerificationMarker(fixture.root, fixture.input, destination);

      expect(fs.readFileSync(path.join(destination, "attempt-one.json"), "utf8")).toContain(
        '"attempt_id":"attempt-one"'
      );
      expect(fs.existsSync(path.join(destination, "dependency-one.json"))).toBe(false);
    } finally {
      fixture.cleanup();
      fs.rmSync(destination, { recursive: true, force: true });
    }
  });

  it("rejects unsafe cloud attempt verification markers before staging", () => {
    const fixture = createProjectFixture();
    const destination = path.join(path.dirname(fixture.root), "verification-staging");
    try {
      const markerRoot = path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification");
      const marker = path.join(markerRoot, "attempt-one.json");
      fs.symlinkSync("dependency-one.json", marker);

      expect(() => copyAttemptVerificationMarker(fixture.root, fixture.input, destination)).toThrow(
        /verification marker is unsafe/u
      );
    } finally {
      fixture.cleanup();
      fs.rmSync(destination, { recursive: true, force: true });
    }
  });

  it("rejects unsafe cloud attempt ids before staging verification markers", () => {
    const fixture = createProjectFixture();
    const destination = path.join(path.dirname(fixture.root), "verification-staging");
    try {
      expect(() =>
        copyAttemptVerificationMarker(
          fixture.root,
          { run_root: fixture.input.run_root, attempt_id: "../attempt-one" },
          destination
        )
      ).toThrow(/cloud node attempt_id is invalid/u);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fixture.cleanup();
      fs.rmSync(destination, { recursive: true, force: true });
    }
  });

  it("fails publication when a manifest declaration is missing or has a wrong digest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-manifest-invalid-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "published");
      fs.mkdirSync(source, { recursive: true });
      const missing = path.join(source, "missing.json");
      fs.writeFileSync(
        path.join(source, "artifact-manifest.json"),
        `${JSON.stringify({
          schema_version: "1.0",
          files: [
            { path: "missing.json", size_bytes: 7, sha256: "0".repeat(64), provenance: { producer_node_id: "fixture" } }
          ]
        })}\n`
      );
      expect(() => copyPublishedEvidenceTree(source, destination)).toThrow(/manifest file is unavailable/u);

      fs.writeFileSync(missing, "actual\n");
      fs.writeFileSync(
        path.join(source, "artifact-manifest.json"),
        `${JSON.stringify({
          schema_version: "1.0",
          files: [{ ...manifestEntry("missing.json", missing), sha256: "0".repeat(64) }]
        })}\n`
      );
      expect(() => copyPublishedEvidenceTree(source, destination)).toThrow(/manifest file digest mismatch/u);

      fs.writeFileSync(
        path.join(source, "artifact-manifest.json"),
        `${JSON.stringify({ schema_version: "1.0", files: [] })}\n`
      );
      expect(() => copyPublishedEvidenceTree(source, destination)).toThrow(/at least one file/u);

      fs.writeFileSync(
        path.join(source, "artifact-manifest.json"),
        `${JSON.stringify({
          schema_version: "1.0",
          files: [manifestEntry("missing.json", missing), manifestEntry("missing.json", missing)]
        })}\n`
      );
      expect(() => copyPublishedEvidenceTree(source, destination)).toThrow(/duplicate file path/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects forwarded credentials in canonical artifact bytes or paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-credential-scan-"));
    try {
      fs.writeFileSync(path.join(root, "safe.json"), '{"ok":true}\n');
      expect(() => assertNoForwardedCredentialBytes(root, ["agent-key-value", "controller-token-value"])).not.toThrow();

      fs.writeFileSync(path.join(root, "leak.txt"), "prefix agent-key-value suffix\n");
      expect(() => assertNoForwardedCredentialBytes(root, ["agent-key-value"])).toThrow(
        /canonical artifacts contain a forwarded credential/u
      );
      fs.unlinkSync(path.join(root, "leak.txt"));
      fs.writeFileSync(path.join(root, "controller-token-value.txt"), "otherwise safe\n");
      expect(() => assertNoForwardedCredentialBytes(root, ["controller-token-value"])).toThrow(
        /canonical artifacts contain a forwarded credential/u
      );
      fs.unlinkSync(path.join(root, "controller-token-value.txt"));

      const encodedCredential = "agent key/value+with=encoding";
      for (const [name, encoded] of [
        ["base64", Buffer.from(encodedCredential).toString("base64")],
        ["base64url", Buffer.from(encodedCredential).toString("base64url")],
        ["hex", Buffer.from(encodedCredential).toString("hex")],
        [
          "mixed-hex",
          Buffer.from(encodedCredential)
            .toString("hex")
            .replace(/[a-f]/gu, (digit, offset) => (offset % 2 === 0 ? digit.toUpperCase() : digit))
        ],
        ["percent", encodeURIComponent(encodedCredential)],
        ["partial-percent", "agent+key%2fvalue%2Bwith%3dencoding"]
      ]) {
        const leak = path.join(root, `${name}.txt`);
        fs.writeFileSync(leak, `${encoded}\n`);
        expect(() => assertNoForwardedCredentialBytes(root, [encodedCredential])).toThrow(
          /canonical artifacts contain a forwarded credential/u
        );
        fs.unlinkSync(leak);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages only canonical task artifacts while retaining mirrors and source attestation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-canonical-result-"));
    try {
      const artifactDir = path.join(root, "canonical", "attempt-one");
      const workspaceDir = path.join(root, "workspace");
      const sourceProofRoot = path.join(root, "source-proofs");
      const mirror = path.join(workspaceDir, "artifacts", "attempt-one");
      const stagingDir = path.join(root, "staging");
      fs.mkdirSync(path.join(artifactDir, "generated-tests"), { recursive: true });
      fs.mkdirSync(path.join(mirror, "generated-tests"), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, "node_modules", ".bin"), { recursive: true });
      fs.mkdirSync(sourceProofRoot, { recursive: true });
      fs.mkdirSync(stagingDir);

      fs.writeFileSync(path.join(artifactDir, "report.md"), "# canonical report\n");
      fs.writeFileSync(path.join(artifactDir, "report.json"), '{"schema_version":"1.0"}\n');
      fs.writeFileSync(path.join(artifactDir, "findings.normalized.json"), "[]\n");
      fs.writeFileSync(
        path.join(artifactDir, WORKSPACE_SOURCE_ATTESTATION_FILE),
        '{"schema_version":"ultrafuzz.workspace-source-attestation.v1"}\n'
      );
      fs.writeFileSync(path.join(mirror, "report.md"), "# stale mirror report\n");
      fs.writeFileSync(path.join(mirror, "generated-tests", "Generated.t.sol"), "contract GeneratedTest {}\n");
      fs.symlinkSync("/usr/bin/env", path.join(workspaceDir, "node_modules", ".bin", "tool"));
      fs.writeFileSync(path.join(sourceProofRoot, "attempt-one.invariant.json"), "durable source proof\n");
      fs.writeFileSync(path.join(sourceProofRoot, "attempt-one.json"), "pinned source proof\n");
      fs.writeFileSync(path.join(sourceProofRoot, "unrelated.json"), "unrelated proof\n");

      stageCanonicalNodeResultBundle({
        artifactDir,
        workspaceDir,
        sourceProofRoot,
        projectRoot: root,
        runRoot: "run",
        attemptId: "attempt-one",
        stagingDir,
        publicationMode: "legacy-markerless-v1"
      });

      expect(fs.readdirSync(stagingDir).sort()).toEqual(["artifacts", "source-proofs"]);
      const published = path.join(stagingDir, "artifacts");
      expect(fs.readFileSync(path.join(published, "report.md"), "utf8")).toBe("# canonical report\n");
      expect(fs.readFileSync(path.join(published, "report.json"), "utf8")).toContain('"schema_version":"1.0"');
      expect(fs.readFileSync(path.join(published, "findings.normalized.json"), "utf8")).toBe("[]\n");
      expect(fs.readFileSync(path.join(published, WORKSPACE_SOURCE_ATTESTATION_FILE), "utf8")).toContain(
        "ultrafuzz.workspace-source-attestation.v1"
      );
      expect(fs.readFileSync(path.join(published, "generated-tests", "Generated.t.sol"), "utf8")).toContain(
        "GeneratedTest"
      );
      expect(fs.existsSync(path.join(stagingDir, "workspace"))).toBe(false);
      expect(fs.existsSync(path.join(published, "node_modules"))).toBe(false);
      expect(fs.readdirSync(path.join(stagingDir, "source-proofs")).sort()).toEqual([
        "attempt-one.invariant.json",
        "attempt-one.json"
      ]);
      expect(fs.readFileSync(path.join(stagingDir, "source-proofs", "attempt-one.invariant.json"), "utf8")).toBe(
        "durable source proof\n"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes a persisted inner workflow before attempting a new cloud-node run", () => {
    const fixture = createProjectFixture();
    try {
      const resume = workflowCommandArguments(
        "/volume/workflow.tsx",
        "/volume/workspace",
        "inner-run",
        fixture.input,
        true
      );
      const fresh = workflowCommandArguments(
        "/volume/workflow.tsx",
        "/volume/workspace",
        "inner-run",
        fixture.input,
        false
      );
      expect(resume).toEqual(
        expect.arrayContaining(["up", "/volume/workflow.tsx", "--resume", "--force", "--run-id", "inner-run"])
      );
      expect(fresh).toEqual(expect.arrayContaining(["up", "/volume/workflow.tsx", "--run-id", "inner-run"]));
      expect(fresh).not.toContain("--resume");
    } finally {
      fixture.cleanup();
    }
  });

  it("falls back to a fresh inner workflow only when no persisted run exists", async () => {
    const fixture = createProjectFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-inner-workflow-test-"));
    const logPath = path.join(root, "commands.jsonl");
    const fakeSmithers = path.join(root, "smithers.mjs");
    fs.writeFileSync(
      fakeSmithers,
      `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args.includes("--resume")) { process.stderr.write("RUN_NOT_FOUND\\n"); process.exit(4); }
`
    );
    fs.chmodSync(fakeSmithers, 0o700);
    try {
      await runDurableWorkflow(fakeSmithers, "/volume/workflow.tsx", fixture.root, "inner-run", fixture.input);
      const commands = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual(expect.arrayContaining(["--resume", "--force", "--run-id", "inner-run"]));
      expect(commands[1]).toEqual(expect.arrayContaining(["--run-id", "inner-run"]));
      expect(commands[1]).not.toContain("--resume");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("keeps workspace mutations and failure checkpoints on durable storage for a replacement worker", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const replacementArchive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const replacementBytes = fs.readFileSync(replacementArchive.path);
    replacementBytes[4] = replacementBytes[4]! ^ 1;
    fs.writeFileSync(replacementArchive.path, replacementBytes);
    replacementArchive.sha256 = crypto.createHash("sha256").update(replacementBytes).digest("hex");
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "attempt");
    const input = identifiedModalNodeInput({ ...fixture.input, project_archive_sha256: archive.sha256 });
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, input);
      first.recordCheckpoint("prepared");
      const generatedProperty = path.join(first.projectRoot, fixture.input.workspace_dir, "test", "Property.t.sol");
      fs.mkdirSync(path.dirname(generatedProperty), { recursive: true });
      fs.writeFileSync(generatedProperty, "contract Property {}\n");
      first.recordCheckpoint("failed", new Error("campaign interrupted"));

      const replacementInput = identifiedModalNodeInput({
        ...fixture.input,
        project_archive_sha256: replacementArchive.sha256
      });
      await expect(
        initializeDurableNodeWorkspace(volumeRoot, replacementArchive.path, replacementInput)
      ).rejects.toThrow(/durable workspace request does not match/u);
      const replacement = await initializeDurableNodeWorkspace(volumeRoot, archive.path, input);
      expect(
        fs.readFileSync(
          path.join(replacement.projectRoot, fixture.input.workspace_dir, "test", "Property.t.sol"),
          "utf8"
        )
      ).toBe("contract Property {}\n");
      const index = JSON.parse(fs.readFileSync(replacement.checkpointIndex, "utf8")) as {
        checkpoints: Array<{ checkpoint_id: string; stage: string; manifest: string }>;
      };
      expect(index.checkpoints).toEqual([
        expect.objectContaining({ checkpoint_id: "0001-prepared", stage: "prepared" }),
        expect.objectContaining({ checkpoint_id: "0002-failed", stage: "failed" })
      ]);
      const failureManifest = index.checkpoints[1]?.manifest;
      expect(failureManifest).toBe(path.join(volumeRoot, "checkpoints", "0002-failed.json"));
      expect(JSON.parse(fs.readFileSync(failureManifest!, "utf8"))).toMatchObject({
        stage: "failed",
        workspace_path: replacement.projectRoot,
        error: "campaign interrupted"
      });
      expect(fs.readFileSync(path.join(volumeRoot, "input", "project.tgz"))).toHaveLength(
        fs.readFileSync(archive.path).length
      );
      expect(replacement.input.project_archive_sha256).toBe(archive.sha256);
      expect(replacementArchive.sha256).not.toBe(archive.sha256);
    } finally {
      archive.cleanup();
      replacementArchive.cleanup();
      fixture.cleanup();
    }
  });

  it("seeds a reset generation from the prior generation's durable outputs", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const baseInput = identifiedModalNodeInput({ ...fixture.input, project_archive_sha256: archive.sha256 });
    const volumeParent = path.join(path.dirname(fixture.root), "modal-volume");
    const priorRoot = path.join(volumeParent, "attempt-base");
    const resetRoot = path.join(volumeParent, "attempt-reset");
    const secondResetRoot = path.join(volumeParent, "attempt-reset-again");
    const interruptedRoot = path.join(volumeParent, "attempt-interrupted");
    try {
      const prior = await initializeDurableNodeWorkspace(priorRoot, archive.path, baseInput);
      const generatedProperty = path.join(prior.projectRoot, fixture.input.workspace_dir, "test", "Property.t.sol");
      fs.mkdirSync(path.dirname(generatedProperty), { recursive: true });
      fs.writeFileSync(generatedProperty, "contract Property {}\n");
      const finding = path.join(prior.projectRoot, fixture.input.artifact_dir, "finding.json");
      fs.writeFileSync(finding, '{"id":"prior"}\n');
      const priorLog = path.join(prior.projectRoot, fixture.input.run_root, "logs", "campaign.log");
      fs.mkdirSync(path.dirname(priorLog), { recursive: true });
      fs.writeFileSync(priorLog, "prior log\n");
      prior.recordCheckpoint("failed", new Error("reset requested"));

      fs.mkdirSync(path.join(interruptedRoot, "input"), { recursive: true });
      fs.copyFileSync(archive.path, path.join(interruptedRoot, "input", "project.tgz"));
      const interruptedInput = identifiedModalNodeInput({ ...baseInput, execution_generation: "reset-interrupted" });
      fs.writeFileSync(path.join(interruptedRoot, "input", "request.json"), `${JSON.stringify(interruptedInput)}\n`);
      const interrupted = await initializeDurableNodeWorkspace(interruptedRoot, archive.path, interruptedInput);
      expect(
        fs.existsSync(
          path.join(interrupted.projectRoot, ".ultrafuzz", "recovered", "attempt-base", "workspace", "test")
        )
      ).toBe(true);

      const resetInput = identifiedModalNodeInput({ ...baseInput, execution_generation: "reset-one" });
      const reset = await initializeDurableNodeWorkspace(resetRoot, archive.path, resetInput);
      expect(fs.existsSync(path.join(reset.projectRoot, resetInput.workspace_dir))).toBe(false);
      expect(
        fs.readFileSync(
          path.join(
            reset.projectRoot,
            ".ultrafuzz",
            "recovered",
            "attempt-base",
            "workspace",
            "test",
            "Property.t.sol"
          ),
          "utf8"
        )
      ).toBe("contract Property {}\n");
      expect(fs.existsSync(path.join(reset.projectRoot, resetInput.artifact_dir, "finding.json"))).toBe(false);
      expect(
        fs.readFileSync(
          path.join(reset.projectRoot, ".ultrafuzz", "recovered", "attempt-base", "artifacts", "finding.json"),
          "utf8"
        )
      ).toBe('{"id":"prior"}\n');
      expect(
        fs.readFileSync(
          path.join(reset.projectRoot, ".ultrafuzz", "recovered", "attempt-base", "logs", "campaign.log"),
          "utf8"
        )
      ).toBe("prior log\n");
      const prepared = reset.recordCheckpoint("prepared");
      expect(prepared.restored_from).toBe(priorRoot);

      const secondReset = await initializeDurableNodeWorkspace(
        secondResetRoot,
        archive.path,
        identifiedModalNodeInput({ ...resetInput, execution_generation: "reset-two" })
      );
      expect(
        fs.readFileSync(
          path.join(
            secondReset.projectRoot,
            ".ultrafuzz",
            "recovered",
            "attempt-reset",
            "previous-recovered",
            "attempt-base",
            "workspace",
            "test",
            "Property.t.sol"
          ),
          "utf8"
        )
      ).toBe("contract Property {}\n");
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("recognizes a completed checkpoint so publication retries skip the inner workflow", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const input = identifiedModalNodeInput({ ...fixture.input, project_archive_sha256: archive.sha256 });
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "completed");
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, input);
      first.recordCheckpoint("completed");
      const retry = await initializeDurableNodeWorkspace(volumeRoot, archive.path, input);
      expect(retry.hasCompletedCheckpoint).toBe(true);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("exposes only traverse access through durable lineage ancestors before model launch", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const input = identifiedModalNodeInput({ ...fixture.input, project_archive_sha256: archive.sha256 });
    const volumeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-volume-test-"));
    const runRoot = path.join(volumeRoot, "bounded-run");
    const attemptRoot = path.join(runRoot, "bounded-attempt");
    fs.mkdirSync(attemptRoot, { recursive: true, mode: 0o700 });
    try {
      await initializeDurableNodeWorkspace(attemptRoot, archive.path, input);
      const mode = (directory: string): number => fs.statSync(directory).mode & 0o777;
      expect(mode(runRoot)).toBe(0o711);
      expect(mode(attemptRoot)).toBe(0o711);
      expect(mode(path.join(attemptRoot, "workspace"))).toBe(0o700);
      expect(mode(path.join(attemptRoot, "input"))).toBe(0o700);
      expect(mode(path.join(attemptRoot, "checkpoints"))).toBe(0o700);
    } finally {
      archive.cleanup();
      fs.rmSync(volumeRoot, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("publishes only old markerless completed durable handoffs with the legacy result schema", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const input = identifiedModalNodeInput({ ...fixture.input, project_archive_sha256: archive.sha256 });
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "legacy-completed");
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, input);
      fs.rmSync(path.join(first.projectRoot, input.run_root, ".ultrafuzz-verification"), {
        recursive: true,
        force: true
      });
      first.recordCheckpoint("completed");

      const retry = await initializeDurableNodeWorkspace(volumeRoot, archive.path, input);

      expect(retry.hasCompletedCheckpoint).toBe(true);
      expect(workerResultPublicationMode(retry.projectRoot, retry.input, retry.hasCompletedCheckpoint)).toBe(
        "legacy-markerless-v1"
      );

      fs.writeFileSync(
        path.join(retry.projectRoot, retry.input.workflow_path),
        'const ARTIFACT_VERIFICATION_SCHEMA_VERSION = "ultrafuzz.artifact-verification.v1";\n'
      );
      expect(workerResultPublicationMode(retry.projectRoot, retry.input, retry.hasCompletedCheckpoint)).toBe(
        "verified-v2"
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("reattaches to one live attempt, validates its durable checkpoint, and publishes only after confirmed stop", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ listed: [sandbox] });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    const events: string[] = [];
    const copyToLocal = sandbox.filesystem.copyToLocal;
    sandbox.filesystem.copyToLocal = vi.fn(async (remote: string, local: string) => {
      events.push("quarantine-copy");
      await copyToLocal(remote, local);
    });
    sandbox.poll = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(0);
    sandbox.terminate = vi.fn(async () => {
      events.push("terminate");
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"))).toBe(false);
    }) as never;
    client.close = vi.fn(() => {
      events.push("close");
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"), "utf8")).toBe(
        '{"ok":true}\n'
      );
    });
    const heartbeat = vi.fn((data?: unknown) => {
      if ((data as { stage?: string } | undefined)?.stage === "published") events.push("published-heartbeat");
    });
    try {
      const completed = await runWithToolContext(
        { runId: "controller-run", nodeId: "node:attempt-one", iteration: 0, attempt: 1 },
        () =>
          provider.run({
            runId: "controller-run",
            sandboxId: "node:attempt",
            input: fixture.input,
            rootDir: fixture.root,
            heartbeat
          })
      );
      expect(completed).toMatchObject({
        status: "finished",
        remoteRunId: "sandbox-one",
        workspaceId: "run-one/attempt-one/base"
      });
      const receipt = (
        completed.output as {
          summary: string;
          ultrafuzz_execution: Record<string, string>;
        }
      ).ultrafuzz_execution;
      expect(receipt.execution_identity).toMatch(/^[0-9a-f]{64}$/u);
      expect(receipt.request_fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(receipt).toEqual({
        schema_version: "ultrafuzz.executor-result.v1",
        execution_mode: "cloud",
        workflow_run_id: "controller-run",
        agent_task_id: "node:attempt-one",
        agent_iteration: 0,
        agent_attempt: 1,
        strategy_attempt_id: "attempt-one",
        workflow_execution_id: "workflow-execution-fixture",
        controller_invocation_id: "controller-invocation-fixture",
        checkpoint_generation_id: testLineageId("checkpoint", ["controller-run", "base"]),
        executor_retry_id: testLineageId("retry", ["controller-run", "node:attempt-one", "sandbox-one", result.digest]),
        execution_identity: receipt.execution_identity,
        request_fingerprint: receipt.request_fingerprint,
        executor_result_digest: result.digest
      });
      expect(client.sandboxes.create).not.toHaveBeenCalled();
      expect(sandbox.exec).not.toHaveBeenCalled();
      expect(sandbox.filesystem.copyFromLocal).not.toHaveBeenCalled();
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(client.cpClient.volumeGetOrCreate).toHaveBeenCalledOnce();
      expect(client.volumes.fromName).toHaveBeenCalledOnce();
      expect(client.volumes.delete).not.toHaveBeenCalled();
      expect(events).toEqual(["quarantine-copy", "terminate", "close", "published-heartbeat"]);
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"), "utf8")).toBe(
        '{"ok":true}\n'
      );
      expect(
        fs.readFileSync(
          path.join(fixture.root, fixture.input.run_root, "source-proofs", "attempt-one.invariant.json"),
          "utf8"
        )
      ).toBe("durable source proof\n");
      expect(
        fs.readFileSync(path.join(fixture.root, fixture.input.run_root, "source-proofs", "attempt-one.json"), "utf8")
      ).toBe("pinned source proof\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(false);
      expect(
        fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, WORKSPACE_SOURCE_ATTESTATION_FILE), "utf8")
      ).toContain("ultrafuzz.workspace-source-attestation.v1");
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "report.md"), "utf8")).toBe(
        "# remote report\n"
      );
      expect(fs.existsSync(path.join(fixture.root, fixture.input.workspace_dir, "work.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.workspace_dir, "local.txt"), "utf8")).toBe(
        "excluded\n"
      );
      expect(
        fs.readFileSync(
          path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"),
          "utf8"
        )
      ).toBe('{"verified":true}\n');
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("recovers a published result before starting a replacement worker", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(client.sandboxes.create).toHaveBeenCalledOnce();
      expect(client.secrets.fromObject).toHaveBeenCalledWith({ DEEPSEEK_API_KEY: "agent-key-value" });
      expect(client.sandboxes.create.mock.calls[0]?.[2]).toMatchObject({
        volumes: { "/data": { volumeId: "volume-one" } }
      });
      expect(sandbox.exec).not.toHaveBeenCalled();
      expect(sandbox.filesystem.copyFromLocal).not.toHaveBeenCalled();
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects a result whose execution identity does not match its controller request", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result, { resultIdentity: "0".repeat(64) });
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/cloud node result is invalid/u);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"))).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("accepts legacy v1 cloud results that predate verification marker archives", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive({
      schemaVersion: "ultrafuzz.modal.node-result.v1",
      includeVerificationMarker: false
    });
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ listed: [sandbox] });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(
        fs.existsSync(path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"))
      ).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects attacker-controlled fields outside the exact cloud result schema", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive({
      extraResultFields: {
        attacker: "must-not-survive",
        ultrafuzz_execution: { execution_identity: "attacker-controlled" }
      }
    });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/cloud node result is invalid/u);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"))).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects v2 cloud results that omit the attempt verification marker", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive({ includeVerificationMarker: false });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const workspaceWork = path.join(fixture.root, fixture.input.workspace_dir, "work.txt");
      const sourceProofRoot = path.join(fixture.root, fixture.input.run_root, "source-proofs");
      fs.writeFileSync(artifactFinding, "existing artifact\n");
      fs.writeFileSync(workspaceWork, "existing workspace\n");
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/missing artifact verification marker/u);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe("existing artifact\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(true);
      expect(fs.readFileSync(workspaceWork, "utf8")).toBe("existing workspace\n");
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.json"))).toBe(false);
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.invariant.json"))).toBe(false);
      expect(
        fs.existsSync(path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"))
      ).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects v2 cloud results with conflicting existing verification markers before mutating publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const workspaceWork = path.join(fixture.root, fixture.input.workspace_dir, "work.txt");
      const sourceProofRoot = path.join(fixture.root, fixture.input.run_root, "source-proofs");
      const verificationMarker = path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        "attempt-one.json"
      );
      fs.writeFileSync(artifactFinding, "existing artifact\n");
      fs.writeFileSync(workspaceWork, "existing workspace\n");
      fs.writeFileSync(verificationMarker, "existing marker\n");

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/would replace an immutable publication file/u);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe("existing artifact\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(true);
      expect(fs.readFileSync(workspaceWork, "utf8")).toBe("existing workspace\n");
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.json"))).toBe(false);
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.invariant.json"))).toBe(false);
      expect(fs.readFileSync(verificationMarker, "utf8")).toBe("existing marker\n");
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects hard-linked existing verification marker destinations before mutating publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const workspaceWork = path.join(fixture.root, fixture.input.workspace_dir, "work.txt");
      const sourceProofRoot = path.join(fixture.root, fixture.input.run_root, "source-proofs");
      const verificationMarker = path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        "attempt-one.json"
      );
      const linkedMarker = path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "linked.json");
      fs.writeFileSync(artifactFinding, "existing artifact\n");
      fs.writeFileSync(workspaceWork, "existing workspace\n");
      fs.writeFileSync(linkedMarker, '{"verified":true}\n');
      fs.linkSync(linkedMarker, verificationMarker);

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/destination file is unsafe/u);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe("existing artifact\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(true);
      expect(fs.readFileSync(workspaceWork, "utf8")).toBe("existing workspace\n");
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.json"))).toBe(false);
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.invariant.json"))).toBe(false);
      expect(fs.readFileSync(verificationMarker, "utf8")).toBe('{"verified":true}\n');
      expect(fs.readFileSync(linkedMarker, "utf8")).toBe('{"verified":true}\n');
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects v2 cloud results missing artifacts before mutating workspace publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive({ includeArtifactsDirectory: false });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const workspaceWork = path.join(fixture.root, fixture.input.workspace_dir, "work.txt");
      const sourceProofRoot = path.join(fixture.root, fixture.input.run_root, "source-proofs");
      fs.writeFileSync(artifactFinding, "existing artifact\n");
      fs.writeFileSync(workspaceWork, "existing workspace\n");

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/missing a required publication directory/u);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe("existing artifact\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(true);
      expect(fs.readFileSync(workspaceWork, "utf8")).toBe("existing workspace\n");
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.json"))).toBe(false);
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.invariant.json"))).toBe(false);
      expect(
        fs.existsSync(path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"))
      ).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("refuses a terminal result that lacks a durable checkpoint reference", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive({ includeDurableCheckpoint: false });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/cloud node result is invalid/u);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"))).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("terminates a legacy recovery candidate and never resumes it", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const legacy = fakeSandbox(undefined, {
      sandboxId: "legacy-sandbox",
      tags: modalNodeTags("controller-run", "node:attempt")
    });
    const replacement = fakeSandbox(result, { sandboxId: "replacement-sandbox" });
    const client = fakeClient({ listed: [legacy], created: replacement, preserveListedTags: true });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished", remoteRunId: "replacement-sandbox" });
      expect(legacy.terminate).toHaveBeenCalledOnce();
      expect(legacy.filesystem.readText).not.toHaveBeenCalled();
      expect(legacy.exec).not.toHaveBeenCalled();
      expect(client.sandboxes.create).toHaveBeenCalledOnce();
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("terminates every duplicate exact recovery candidate and aggregates failures", async () => {
    const fixture = createProjectFixture();
    const first = fakeSandbox(undefined, { sandboxId: "duplicate-one" });
    const second = fakeSandbox(undefined, { sandboxId: "duplicate-two" });
    first.poll = vi.fn(async () => null);
    first.terminate = vi.fn(async () => {
      throw new Error("first duplicate termination failed");
    }) as never;
    const client = fakeClient({ listed: [first, second] });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      const failure = await Promise.resolve(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect(aggregateErrorMessages(failure).join("\n")).toMatch(/multiple live cloud node sandboxes/u);
      expect(aggregateErrorMessages(failure).join("\n")).toMatch(/first duplicate termination failed/u);
      expect(first.terminate).toHaveBeenCalledOnce();
      expect(second.terminate).toHaveBeenCalledOnce();
      expect(client.sandboxes.create).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects legacy cloud results that include a recursively copied workspace", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive({ includeWorkspace: true });
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ listed: [sandbox] });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/must contain only canonical artifacts/u);
      expect(fs.existsSync(path.join(fixture.root, fixture.input.workspace_dir, "work.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it.each([
    ["forwarded agent", "agent-key-value"],
    ["controller Modal", "provider-secret-value"]
  ])("rejects %s credentials before controller publication", async (_label, credential) => {
    const fixture = createProjectFixture();
    const result = createResultArchive({ extraArtifactContents: `leaked=${credential}\n` });
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ listed: [sandbox] });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/canonical artifacts contain a forwarded credential/u);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "leak.txt"))).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("reports structured worker diagnostics when a fresh cloud worker fails", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined);
    sandbox.exec = vi.fn(async (command: string[]) =>
      command[0] === "node"
        ? fakeContainerProcess({
            exitCode: 7,
            stdout: "worker stdout\n",
            stderr:
              '{"schema_version":"ultrafuzz.modal.node-worker-error.v1","message":"cloud worker phase run-workflow failed with code 7","phase":"run-workflow","command":"smithers","exit_code":7,"stderr":"workflow failed"}\n'
          })
        : fakeContainerProcess()
    ) as never;
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/run-workflow.*workflow failed/u);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(sandbox.exec).toHaveBeenNthCalledWith(
        1,
        expect.arrayContaining(["/usr/bin/install", "0700", "/root/.ultrafuzz-node-transport"])
      );
      expect(sandbox.exec).toHaveBeenCalledWith([
        "/usr/bin/chmod",
        "0600",
        "/root/.ultrafuzz-node-transport/project.tgz",
        "/root/.ultrafuzz-node-transport/request.json"
      ]);
      expect(sandbox.filesystem.copyFromLocal).toHaveBeenCalledTimes(2);
    } finally {
      fixture.cleanup();
    }
  });

  it("aggregates the original worker failure with redacted termination and close failures", async () => {
    const fixture = createProjectFixture();
    const providerCredential = Buffer.from("provider-secret-value").toString("base64");
    const agentCredential = Buffer.from("agent-key-value").toString("hex");
    const sandbox = fakeSandbox(undefined);
    sandbox.exec = vi.fn(async (command: string[]) =>
      command[0] === "node"
        ? fakeContainerProcess({
            exitCode: 7,
            stderr: `${JSON.stringify({
              schema_version: "ultrafuzz.modal.node-worker-error.v1",
              message: `${providerCredential} run-workflow failed`,
              phase: "run-workflow",
              command: "smithers",
              exit_code: 7,
              stderr: "workflow failed"
            })}\n`
          })
        : fakeContainerProcess()
    ) as never;
    sandbox.terminate = vi.fn(async () => {
      throw new Error(`${providerCredential} termination failed`);
    });
    const client = fakeClient({ created: sandbox });
    client.close = vi.fn(() => {
      throw new Error(`${agentCredential} close failed`);
    });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      const failure = await Promise.resolve(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect(Object.prototype.propertyIsEnumerable.call(failure, "errors")).toBe(true);
      expect(failure).toMatchObject({
        message: "Modal node execution failed: cloud node sandbox remained live after termination"
      });
      const [terminationFailure, closeFailure, executionFailure] = (failure as AggregateError).errors as Error[];
      expect(terminationFailure).toMatchObject({
        cause: expect.objectContaining({ message: "[credential] termination failed" }),
        message: "cloud node sandbox remained live after termination"
      });
      expect(closeFailure?.message).toBe("[credential] close failed");
      expect(executionFailure?.message).toMatch(/\[credential\] run-workflow failed/u);
      expect((failure as AggregateError).errors).toHaveLength(3);
      expect(JSON.stringify(aggregateErrorMessages(failure))).not.toMatch(
        new RegExp(`${providerCredential}|${agentCredential}`, "u")
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the original worker failure primary when only client close also fails", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined);
    sandbox.exec = vi.fn(async (command: string[]) =>
      command[0] === "node" ? fakeContainerProcess({ exitCode: 7, stderr: "workflow failed" }) : fakeContainerProcess()
    ) as never;
    const client = fakeClient({ created: sandbox });
    client.close = vi.fn(() => {
      throw new Error("client close failed");
    });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      const failure = await Promise.resolve(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      const [executionFailure, closeFailure] = (failure as AggregateError).errors as Error[];
      expect(failure).toMatchObject({
        cause: executionFailure,
        message: expect.stringMatching(/workflow failed/u)
      });
      expect(executionFailure?.message).toMatch(/workflow failed/u);
      expect(closeFailure?.message).toMatch(/client close failed/u);
      expect((failure as AggregateError).errors).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
  });

  it("bounds both normal and finalizer shutdown when published-result termination never settles", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    sandbox.terminate = vi.fn(() => new Promise<number>(() => undefined)) as never;
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(fakeClient({ listed: [sandbox] })),
      modalShutdown: { timeoutMs: 25 }
    });
    try {
      const shutdownStartedAt = Date.now();
      const run = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        heartbeat: vi.fn()
      });
      const failure = await Promise.resolve(run).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(errorGraphText(failure)).toContain("monotonic deadline");
      expect(Date.now() - shutdownStartedAt).toBeLessThan(2_000);
      expect(sandbox.poll).toHaveBeenCalled();
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"))).toBe(false);
      expect(sandbox.terminate).toHaveBeenCalledTimes(2);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("redacts configured credentials from finalizer failures", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ listed: [sandbox] });
    client.close = vi.fn(() => {
      throw new Error("agent-key-value close failed");
    });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      const run = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        heartbeat: vi.fn()
      });
      await expect(run).rejects.toThrow("[credential] close failed");
      await expect(run).rejects.not.toThrow("agent-key-value");
      expect(sandbox.terminate).toHaveBeenCalledOnce();
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("brokers a quarantined Kimi rotation only after termination and before publication", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const rawCandidate = `${JSON.stringify({
      access_token: "child-controlled-access",
      refresh_token: "rotated-refresh",
      expires_at: 9_999_999_999,
      attacker: "must-not-survive"
    })}\n`;
    const result = createResultArchive({ candidateCredential: rawCandidate });
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const events: string[] = [];
    const releaseLease = vi.fn(async () => {
      events.push("lease-release");
    });
    const acquireLease = vi.fn(
      async (
        model: string,
        env: Record<string, string | undefined>,
        _home: string,
        options: { timeoutMs?: number }
      ) => {
        events.push("lease-acquire");
        expect(model).toBe("kimi-k3");
        expect(env.KIMI_CODE_HOME).toBe(kimiSource);
        expect(options).toEqual({ timeoutMs: 60_000 });
        return testKimiExecutionLease(kimiSource, releaseLease);
      }
    );
    let candidateLocalPath: string | undefined;
    const copyToLocal = sandbox.filesystem.copyToLocal;
    sandbox.filesystem.copyToLocal = vi.fn(async (remote: string, local: string) => {
      if (remote.endsWith("/kimi-credential-candidate.json")) {
        events.push("candidate-quarantined");
        candidateLocalPath = local;
      } else {
        events.push("artifacts-quarantined");
      }
      await copyToLocal(remote, local);
    });
    const terminate = sandbox.terminate;
    sandbox.terminate = vi.fn(async (...args: unknown[]) => {
      events.push("terminate");
      await (terminate as unknown as (...values: unknown[]) => Promise<void>)(...args);
    }) as never;
    const broker = vi.fn(
      async (input: { candidateCredential: string; initialCredential: string; model: string; source: string }) => {
        events.push("broker");
        expect(sandbox.terminate).toHaveBeenCalledOnce();
        expect(releaseLease).not.toHaveBeenCalled();
        expect(input.candidateCredential).toBe(rawCandidate);
        expect(JSON.parse(input.initialCredential)).toMatchObject({ refresh_token: "initial-refresh" });
        expect(input.model).toBe("kimi-k3");
        expect(fs.readdirSync(input.source).sort()).toEqual(["config.toml", "credentials", "device_id"]);
        return {
          access_token: "provider-validated-access",
          refresh_token: "provider-validated-refresh",
          expires_at: 4_100_000_000,
          expires_in: 3600
        };
      }
    );
    const reconcile = vi.fn(
      async (
        model: string,
        credential: string,
        env: Record<string, string | undefined>,
        _home: string,
        options: { sourceRefreshTokenSha256: string }
      ) => {
        events.push("reconcile");
        expect(releaseLease).not.toHaveBeenCalled();
        expect(model).toBe("kimi-k3");
        expect(JSON.parse(credential)).toMatchObject({
          access_token: "provider-validated-access",
          refresh_token: "provider-validated-refresh"
        });
        expect(env.KIMI_CODE_HOME).toBe(kimiSource);
        expect(options.sourceRefreshTokenSha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe(
          "stale\n"
        );
        expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"))).toBe(false);
        return true;
      }
    );
    client.close = vi.fn(() => events.push("close"));
    fixture.input.agent_auth = {
      agent: "KimiAgent",
      provider: "kimi",
      auth: { mode: "subscription", config_dir: kimiSource }
    };
    fixture.input.agent_model = "kimi-k3";
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiBroker: broker as never,
      kimiReconcile: reconcile as never,
      kimiExecutionLease: acquireLease as never
    });
    const heartbeat = vi.fn((data?: unknown) => {
      if ((data as { stage?: string } | undefined)?.stage === "published") events.push("published");
    });
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(events).toEqual([
        "lease-acquire",
        "candidate-quarantined",
        "artifacts-quarantined",
        "terminate",
        "broker",
        "reconcile",
        "lease-release",
        "close",
        "published"
      ]);
      expect(broker).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(acquireLease).toHaveBeenCalledOnce();
      expect(releaseLease).toHaveBeenCalledOnce();
      expect(client.sandboxes.create.mock.calls[0]?.[2]).toMatchObject({
        tags: expect.objectContaining({
          credential_lease: KIMI_CREDENTIAL_LEASE_ID,
          credential_lease_owner: KIMI_CREDENTIAL_LEASE_OWNER
        })
      });
      expect(candidateLocalPath).toBeDefined();
      expect(fs.existsSync(candidateLocalPath!)).toBe(false);
      expect(client.secrets.fromObject).not.toHaveBeenCalled();
      expect(client.cpClient.volumeGetOrCreate).toHaveBeenCalledOnce();
      expect(client.volumes.fromName).toHaveBeenCalledOnce();
      expect(client.volumes.delete).not.toHaveBeenCalled();
      expect(sandbox.filesystem.copyToLocal.mock.calls.map(([remote]) => remote)).not.toContainEqual(
        expect.stringContaining("/data/")
      );
      const publishedRoot = path.join(fixture.root, fixture.input.artifact_dir);
      expect(
        fs
          .readdirSync(publishedRoot, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
          .join("\n")
      ).not.toContain("rotated-refresh");
    } finally {
      result.cleanup();
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("never stages or reconciles a replacement Kimi root installed after lease acquisition", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const heldSource = `${kimiSource}-held`;
    const rawCandidate = `${JSON.stringify({
      access_token: "child-access",
      refresh_token: "child-refresh",
      expires_at: 9_999_999_999
    })}\n`;
    const result = createResultArchive({ candidateCredential: rawCandidate });
    const sandbox = fakeSandbox(result);
    let acquiredLease: Awaited<ReturnType<typeof acquireKimiModalNodeExecutionLease>> | undefined;
    let replacementBytes: Buffer | undefined;
    const acquireLease = vi.fn(async (...args: Parameters<typeof acquireKimiModalNodeExecutionLease>) => {
      acquiredLease = await acquireKimiModalNodeExecutionLease(...args);
      fs.renameSync(kimiSource, heldSource);
      const replacement = createKimiSubscriptionFixture();
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
      replacementBytes = fs.readFileSync(replacementCredential);
      fs.renameSync(replacement, kimiSource);
      return acquiredLease;
    });
    const broker = vi.fn(async (input: { initialCredential: string; source: string }) => {
      expect(JSON.parse(input.initialCredential)).toMatchObject({
        access_token: "initial-access",
        refresh_token: "initial-refresh"
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(input.source, "credentials", "kimi-code.json"), "utf8"))
      ).toMatchObject({ access_token: "initial-access", refresh_token: "initial-refresh" });
      expect(fs.readFileSync(path.join(input.source, "device_id"), "utf8")).toBe("device-test\n");
      return {
        access_token: "provider-successor-access",
        refresh_token: "provider-successor-refresh",
        expires_at: Math.floor(Date.now() / 1000) + 10_000,
        expires_in: 3600
      };
    });
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(fakeClient({ created: sandbox })),
      kimiBroker: broker as never,
      kimiExecutionLease: acquireLease
    });
    try {
      const failure = await Promise.resolve(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).catch((error: unknown) => error);

      expect(errorGraphText(failure)).toContain("different physical directory");
      expect(broker).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(path.join(heldSource, "credentials", "kimi-code.json"), "utf8"))).toMatchObject(
        { access_token: "initial-access", refresh_token: "initial-refresh" }
      );
      expect(fs.readFileSync(path.join(kimiSource, "credentials", "kimi-code.json"))).toEqual(replacementBytes);
      expect(openFileDescriptorsBelow(heldSource)).toEqual([]);
    } finally {
      await acquiredLease?.release().catch(() => undefined);
      result.cleanup();
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
      fs.rmSync(heldSource, { recursive: true, force: true });
    }
  });

  it("recovers, reconciles, and redacts a rotated Kimi credential after workflow failure", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const successorAccess = "opaque-successor-access";
    const successorRefresh = "opaque-successor-refresh";
    const rawCandidate = `${JSON.stringify({
      access_token: successorAccess,
      refresh_token: successorRefresh,
      expires_at: 9_999_999_999
    })}\n`;
    const sandbox = fakeSandbox(undefined, { sandboxId: "failed-rotation-sandbox" });
    const events: string[] = [];
    let workerLaunched = false;
    sandbox.filesystem.readText = vi.fn(async (remote: string) => {
      if (!workerLaunched || !remote.endsWith("/kimi-credential-recovery.json")) {
        throw new SandboxFilesystemNotFoundError("not found");
      }
      const tags = await sandbox.getTags();
      return `${JSON.stringify({
        schema_version: "ultrafuzz.modal.kimi-credential-recovery.v1",
        status: "quarantined",
        storage_lineage: "run-one/attempt-one/base",
        execution_identity: tags.execution_identity,
        credential_candidate: path.posix.join(path.posix.dirname(remote), "kimi-credential-candidate.json")
      })}\n`;
    });
    sandbox.filesystem.copyToLocal = vi.fn(async (remote: string, local: string) => {
      expect(remote).toMatch(/kimi-credential-candidate\.json$/u);
      events.push("candidate-quarantined");
      fs.writeFileSync(local, rawCandidate, { mode: 0o600 });
    });
    sandbox.exec = vi.fn(async (command: string[]) => {
      if (command[0] !== "node") return fakeContainerProcess();
      workerLaunched = true;
      events.push("worker-failed");
      return fakeContainerProcess({
        exitCode: 7,
        stderr: `workflow failed after rotation: ${successorRefresh}`
      });
    }) as never;
    const originalTerminate = sandbox.terminate;
    sandbox.terminate = vi.fn(async (...args: unknown[]) => {
      events.push("terminate");
      await (originalTerminate as unknown as (...values: unknown[]) => Promise<void>)(...args);
    }) as never;
    const lease = testKimiExecutionLease(
      kimiSource,
      vi.fn(async () => {
        events.push("lease-release");
      })
    );
    lease.markRotationPossible = vi.fn(async () => {
      events.push("rotation-possible");
    });
    lease.markRotationResolved = vi.fn(async () => {
      events.push("rotation-resolved");
    });
    const client = fakeClient({ created: sandbox });
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never,
      kimiBroker: vi.fn(async (brokerInput: { candidateCredential: string }) => {
        events.push("broker");
        expect(brokerInput.candidateCredential).toBe(rawCandidate);
        return {
          access_token: "provider-access",
          refresh_token: "provider-refresh",
          expires_at: 9_999_999_999
        };
      }) as never,
      kimiReconcile: vi.fn(async () => {
        events.push("reconcile");
        return true;
      }) as never
    });
    try {
      const failure = await Promise.resolve(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(errorGraphText(failure)).toContain("credential-observing worker output was withheld");
      expect(errorGraphText(failure)).not.toContain("workflow failed after rotation");
      expect(errorGraphText(failure)).not.toContain(successorAccess);
      expect(errorGraphText(failure)).not.toContain(successorRefresh);
      expect(events).toEqual([
        "rotation-possible",
        "worker-failed",
        "candidate-quarantined",
        "terminate",
        "broker",
        "reconcile",
        "rotation-resolved",
        "lease-release"
      ]);
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("surfaces and retains a durable Kimi fence when failed rotation recovery is missing", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const opaqueSuccessor = "missing-recovery-opaque-successor-refresh";
    const sandbox = fakeSandbox(undefined, { sandboxId: "missing-recovery-sandbox" });
    sandbox.exec = vi.fn(async (command: string[]) =>
      command[0] === "node"
        ? fakeContainerProcess({
            exitCode: 7,
            stderr: `workflow failed before candidate recovery: ${opaqueSuccessor}`
          })
        : fakeContainerProcess()
    ) as never;
    let rotationPossible = false;
    const releaseLease = vi.fn(async () => {
      if (rotationPossible) {
        throw new Error("Kimi Modal credential rotation remains durably unresolved; credential fence was retained");
      }
    });
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    lease.markRotationPossible = vi.fn(async () => {
      rotationPossible = true;
    });
    lease.markRotationResolved = vi.fn(async () => {
      rotationPossible = false;
    });
    const client = fakeClient({ created: sandbox });
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never
    });
    try {
      const failure = await Promise.resolve(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as Error).message).toMatch(/remains durably unresolved/u);
      expect((failure as Error).message).toMatch(/credential fence was retained/u);
      expect(((failure as AggregateError).errors[0] as Error).message).toMatch(/credential fence was retained/u);
      expect(errorGraphText(failure)).toMatch(/credential recovery.*is missing/su);
      expect(errorGraphText(failure)).toContain("credential-observing worker output was withheld");
      expect(errorGraphText(failure)).not.toContain(opaqueSuccessor);
      expect(releaseLease).toHaveBeenCalledOnce();
      expect(lease.markRotationResolved).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("never surfaces successor-bearing worker output when rotation recovery is malformed", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const opaqueSuccessor = "malformed-recovery-opaque-successor-refresh";
    const sandbox = fakeSandbox(undefined, { sandboxId: "malformed-recovery-sandbox" });
    let workerLaunched = false;
    sandbox.filesystem.readText = vi.fn(async (remote: string) => {
      if (!workerLaunched || !remote.endsWith("/kimi-credential-recovery.json")) {
        throw new SandboxFilesystemNotFoundError("not found");
      }
      return `{"refresh_token":"${opaqueSuccessor}", invalid-json`;
    });
    sandbox.exec = vi.fn(async (command: string[]) => {
      if (command[0] !== "node") return fakeContainerProcess();
      workerLaunched = true;
      return fakeContainerProcess({
        exitCode: 9,
        stdout: `successor appeared on stdout: ${opaqueSuccessor}`,
        stderr: `successor appeared on stderr: ${opaqueSuccessor}`
      });
    }) as never;
    let rotationPossible = false;
    const releaseLease = vi.fn(async () => {
      if (rotationPossible) {
        throw new Error("Kimi Modal credential rotation remains durably unresolved; credential fence was retained");
      }
    });
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    lease.markRotationPossible = vi.fn(async () => {
      rotationPossible = true;
    });
    lease.markRotationResolved = vi.fn(async () => {
      rotationPossible = false;
    });
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(fakeClient({ created: sandbox })),
      kimiExecutionLease: vi.fn(async () => lease) as never
    });
    try {
      const failure = await Promise.resolve(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      const graph = errorGraphText(failure);
      expect(graph).toContain("credential-observing worker output was withheld");
      expect(graph).toContain("credential recovery manifest is invalid");
      expect(graph).not.toContain(opaqueSuccessor);
      expect(lease.markRotationResolved).not.toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("retains the durable Kimi fence when successor lineage cannot be reconciled", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const result = createResultArchive({
      candidateCredential: `${JSON.stringify({
        access_token: "successor-access",
        refresh_token: "successor-refresh",
        expires_at: 9_999_999_999
      })}\n`
    });
    const sandbox = fakeSandbox(result, { sandboxId: "unreconciled-lineage-sandbox" });
    let rotationPossible = false;
    const releaseLease = vi.fn(async () => {
      if (rotationPossible) {
        throw new Error("Kimi Modal credential rotation remains durably unresolved; credential fence was retained");
      }
    });
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    lease.markRotationPossible = vi.fn(async () => {
      rotationPossible = true;
    });
    lease.markRotationResolved = vi.fn(async () => {
      rotationPossible = false;
    });
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(fakeClient({ created: sandbox })),
      kimiExecutionLease: vi.fn(async () => lease) as never,
      kimiBroker: vi.fn(async () => ({
        access_token: "provider-access",
        refresh_token: "provider-refresh",
        expires_at: 9_999_999_999
      })) as never,
      kimiReconcile: vi.fn(async () => false) as never
    });
    try {
      const failure = await Promise.resolve(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).catch((error: unknown) => error);

      expect((failure as Error).message).toMatch(/remains durably unresolved/u);
      expect(errorGraphText(failure)).toContain("lineage could not be reconciled");
      expect(lease.markRotationResolved).not.toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledOnce();
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
    } finally {
      result.cleanup();
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("releases a Kimi execution lease when auth preparation fails before sandbox creation", async () => {
    const fixture = createProjectFixture();
    const missingSource = path.join(path.dirname(fixture.root), "missing-kimi-source");
    const releaseLease = vi.fn(async () => undefined);
    const acquireLease = vi.fn(async () => testKimiExecutionLease(missingSource, releaseLease));
    const client = fakeClient({});
    fixture.input.agent_auth = {
      agent: "KimiAgent",
      provider: "kimi",
      auth: { mode: "subscription", config_dir: missingSource }
    };
    fixture.input.agent_model = "kimi-k3";
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: acquireLease as never
    });
    try {
      const failure = await Promise.resolve(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/ENOENT|no such file/u);
      expect(errorGraphText(failure)).toContain("[auth-path]");
      expect(errorGraphText(failure)).not.toContain(missingSource);
      expect(acquireLease).toHaveBeenCalledOnce();
      expect(releaseLease).toHaveBeenCalledOnce();
      expect(client.apps.fromName).toHaveBeenCalledOnce();
      expect(client.sandboxes.create).not.toHaveBeenCalled();
      expect(client.close).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
    }
  });

  it("re-lists and stops an unassigned live candidate after recovery discovery fails", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const releaseLease = vi.fn(async () => undefined);
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    const candidate = fakeSandbox(undefined, {
      sandboxId: "unassigned-find-candidate",
      tags: modalNodeTags("controller-run", "node:attempt")
    });
    let stopped = false;
    let terminationAttempts = 0;
    candidate.poll = vi.fn(async () => (stopped ? 0 : null));
    candidate.terminate = vi.fn(async () => {
      terminationAttempts += 1;
      if (terminationAttempts === 1) throw new Error("first candidate termination failed");
      stopped = true;
    }) as never;
    const client = fakeClient({});
    let listCalls = 0;
    client.sandboxes.list = vi.fn(async function* () {
      listCalls += 1;
      // The first six calls are the two delayed pre-snapshot proof sweeps:
      // credential lease, exact legacy attempt, and app-wide legacy migration.
      if (listCalls > 6) yield candidate;
    }) as never;
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never
    });
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/first candidate termination failed|remained live/u);
      expect(candidate.terminate).toHaveBeenCalledTimes(2);
      expect(client.sandboxes.create).not.toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("re-lists an ambiguously committed create and stops it before releasing the lease", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const releaseLease = vi.fn(async () => undefined);
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    const committed = fakeSandbox(undefined, { sandboxId: "ambiguous-create-candidate" });
    const client = fakeClient({});
    let createCommitted = false;
    let postCommitListCalls = 0;
    let firstVisiblePostCommitSweep: number | undefined;
    client.sandboxes.create = vi.fn(
      async (_app: unknown, _image: unknown, params: { tags?: Record<string, string> }) => {
        committed.setTestTags(params.tags ?? {});
        createCommitted = true;
        throw new Error("create response lost after commit");
      }
    ) as never;
    client.sandboxes.list = vi.fn(async function* (params: { tags: Record<string, string> }) {
      if (!createCommitted) return;
      postCommitListCalls += 1;
      const completedFilterSet = Math.ceil(postCommitListCalls / 4);
      // All four filters in the first complete post-create proof sweep are
      // empty; the sandbox becomes visible only in the following sweep.
      if (completedFilterSet === 1) return;
      const tags = await committed.getTags();
      if (Object.entries(params.tags).every(([key, value]) => tags[key] === value)) {
        firstVisiblePostCommitSweep ??= completedFilterSet;
        yield committed;
      }
    }) as never;
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never
    });
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow("create response lost after commit");
      expect(committed.terminate).toHaveBeenCalledOnce();
      expect(postCommitListCalls).toBeGreaterThan(4);
      expect(firstVisiblePostCommitSweep).toBe(2);
      expect(releaseLease).toHaveBeenCalledOnce();
      expect(
        client.sandboxes.list.mock.calls.some(
          ([params]) =>
            params.tags.credential_lease === KIMI_CREDENTIAL_LEASE_ID &&
            typeof params.tags.execution_identity === "string"
        )
      ).toBe(true);
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("cleans up a stale credential-lease owner before taking the credential snapshot", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    fs.rmSync(path.join(kimiSource, "device_id"));
    const rawCandidate = `${JSON.stringify({
      access_token: "child-access",
      refresh_token: "child-refresh",
      expires_at: 9_999_999_999
    })}\n`;
    const result = createResultArchive({ candidateCredential: rawCandidate });
    const stale = fakeSandbox(undefined, {
      sandboxId: "stale-lease-owner",
      tags: {
        ...modalNodeTags("prior-controller-run", "prior-node:attempt"),
        credential_lease: KIMI_CREDENTIAL_LEASE_ID,
        credential_lease_owner: "prior-lease-owner"
      }
    });
    const fresh = fakeSandbox(result, { sandboxId: "fresh-kimi-sandbox" });
    const events: string[] = [];
    const terminateStale = stale.terminate;
    stale.terminate = vi.fn(async (...args: unknown[]) => {
      events.push("stale-owner-terminated");
      fs.writeFileSync(path.join(kimiSource, "device_id"), "device-restored-before-snapshot\n", { mode: 0o600 });
      await (terminateStale as unknown as (...values: unknown[]) => Promise<void>)(...args);
    }) as never;
    const client = fakeClient({ listed: [stale], created: fresh, preserveListedTags: true });
    client.images.fromName = vi.fn(async () => {
      events.push("image-after-snapshot");
      expect(fs.existsSync(path.join(kimiSource, "device_id"))).toBe(true);
      return {};
    }) as never;
    const releaseLease = vi.fn(async () => {
      events.push("lease-release");
      return undefined;
    });
    const lease = testKimiExecutionLease(kimiSource, releaseLease, "replacement-lease-owner");
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never,
      kimiBroker: vi.fn(async () => ({ access_token: "brokered", refresh_token: "brokered-refresh" })) as never,
      kimiReconcile: vi.fn(async () => true) as never
    });
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished", remoteRunId: "fresh-kimi-sandbox" });
      expect(stale.terminate).toHaveBeenCalledOnce();
      expect(events.indexOf("stale-owner-terminated")).toBeLessThan(events.indexOf("image-after-snapshot"));
      expect(events.at(-1)).toBe("lease-release");
    } finally {
      result.cleanup();
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("stops app-wide legacy sandboxes from other attempts before snapshotting Kimi credentials", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    fs.rmSync(path.join(kimiSource, "device_id"));
    const legacy = fakeSandbox(undefined, {
      sandboxId: "cross-attempt-legacy-sandbox",
      tags: {
        purpose: "ultrafuzz-node",
        run: "legacy-run",
        attempt: "legacy-attempt"
      }
    });
    const modernNonKimi = fakeSandbox(undefined, {
      sandboxId: "modern-non-kimi-sandbox",
      tags: modalNodeTags("parallel-run", "parallel-node:attempt")
    });
    const client = fakeClient({ listed: [legacy, modernNonKimi], preserveListedTags: true });
    const releaseLease = vi.fn(async () => undefined);
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never,
      kimiRemoteQuiescence: { settlementMs: 1, timeoutMs: 100 }
    });
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/ENOENT|no such file/u);
      expect(legacy.terminate).toHaveBeenCalledOnce();
      expect(modernNonKimi.terminate).not.toHaveBeenCalled();
      expect(
        client.sandboxes.list.mock.calls.some(
          ([params]) => Object.keys(params.tags).length === 1 && params.tags.purpose === "ultrafuzz-node"
        )
      ).toBe(true);
      expect(releaseLease).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("prevents a superseded lease owner from creating a sandbox and disposes its local handles", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const releaseLease = vi.fn(async () => undefined);
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    lease.assertOwner = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("Kimi Modal execution lease ownership was superseded"));
    const client = fakeClient({});
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never
    });
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/ownership was superseded/u);
      expect(lease.assertOwner).toHaveBeenCalledTimes(4);
      expect(client.sandboxes.create).not.toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("retains the durable Kimi fence when remote enumeration cannot be proven", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const releaseLease = vi.fn(async () => undefined);
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    const client = fakeClient({});
    client.sandboxes.list = vi.fn(async function* () {
      yield* [];
      throw new Error("remote list unavailable");
    }) as never;
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never
    });
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/remote enumeration could not be proven/u);
      expect(client.sandboxes.list).toHaveBeenCalledTimes(2);
      expect(releaseLease).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("retains the durable Kimi fence when fresh remote candidates prevent settlement", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const releaseLease = vi.fn(async () => undefined);
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    const client = fakeClient({});
    let candidateId = 0;
    client.sandboxes.list = vi.fn(async function* () {
      candidateId += 1;
      yield fakeSandbox(undefined, { sandboxId: `still-appearing-${candidateId}` });
    }) as never;
    let remoteClock = 0;
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never,
      kimiRemoteQuiescence: {
        now: () => remoteClock,
        pause: async (ms) => {
          remoteClock += ms;
        },
        settlementMs: 5,
        timeoutMs: 20
      }
    });
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/deadline|remote enumeration could not be proven/u);
      expect(client.sandboxes.create).not.toHaveBeenCalled();
      expect(candidateId).toBeGreaterThan(4);
      expect(releaseLease).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("retains the durable Kimi fence when a remote candidate cannot be poll-proven stopped", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const releaseLease = vi.fn(async () => undefined);
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    const candidate = fakeSandbox(undefined, {
      sandboxId: "unprovable-remote-candidate",
      tags: {
        ...modalNodeTags("prior-controller-run", "prior-node:attempt"),
        credential_lease: KIMI_CREDENTIAL_LEASE_ID,
        credential_lease_owner: "prior-lease-owner"
      }
    });
    candidate.poll = vi.fn(async () => {
      throw new Error("remote poll unavailable");
    });
    const client = fakeClient({ listed: [candidate], preserveListedTags: true });
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never
    });
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/remote quiescence could not be proven/u);
      expect(candidate.terminate).toHaveBeenCalledTimes(2);
      expect(releaseLease).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it.each(["list", "poll", "terminate"] as const)(
    "bounds a never-settling remote %s RPC and retains the durable Kimi fence",
    async (operation) => {
      const fixture = createProjectFixture();
      const kimiSource = createKimiSubscriptionFixture();
      const releaseLease = vi.fn(async () => undefined);
      const lease = testKimiExecutionLease(kimiSource, releaseLease);
      const candidate = fakeSandbox(undefined, { sandboxId: `never-settling-${operation}` });
      const client = fakeClient({});
      if (operation === "list") {
        client.sandboxes.list = vi.fn(
          () =>
            ({
              [Symbol.asyncIterator]: () => ({
                next: () => new Promise<IteratorResult<Sandbox>>(() => undefined),
                return: async () => ({ done: true, value: undefined })
              })
            }) as AsyncIterable<Sandbox>
        ) as never;
      } else {
        client.sandboxes.list = vi.fn(async function* () {
          yield candidate;
        }) as never;
        if (operation === "poll") {
          candidate.poll = vi.fn(() => new Promise<number | null>(() => undefined));
        } else {
          candidate.poll = vi.fn(async () => null);
          candidate.terminate = vi.fn(() => new Promise<void>(() => undefined)) as never;
        }
      }
      selectKimiSubscription(fixture.input, kimiSource);
      const provider = createModalNodeSandboxProvider({
        ...providerOptions(client),
        kimiExecutionLease: vi.fn(async () => lease) as never,
        kimiRemoteQuiescence: {
          settlementMs: 1,
          timeoutMs: 20
        }
      });
      try {
        await expect(
          provider.run({
            runId: "controller-run",
            sandboxId: "node:attempt",
            input: fixture.input,
            rootDir: fixture.root,
            heartbeat: vi.fn()
          })
        ).rejects.toThrow(/deadline|remote (?:enumeration|quiescence) could not be proven/u);
        expect(releaseLease).toHaveBeenCalledOnce();
      } finally {
        fixture.cleanup();
        fs.rmSync(kimiSource, { recursive: true, force: true });
      }
    }
  );

  it("uses a monotonic remote settlement clock despite a forward wall-clock jump", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    fs.rmSync(path.join(kimiSource, "device_id"));
    const releaseLease = vi.fn(async () => undefined);
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    const client = fakeClient({});
    let listCalls = 0;
    client.sandboxes.list = vi.fn(() => {
      listCalls += 1;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined })
        })
      } as AsyncIterable<Sandbox>;
    }) as never;
    let wallClock = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    selectKimiSubscription(fixture.input, kimiSource);
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      kimiExecutionLease: vi.fn(async () => lease) as never,
      kimiRemoteQuiescence: {
        pause: async (ms) => {
          wallClock += 10_000_000;
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
        settlementMs: 5,
        timeoutMs: 100
      }
    });
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/ENOENT|no such file/u);
      expect(listCalls).toBeGreaterThanOrEqual(8);
      expect(releaseLease).toHaveBeenCalledOnce();
    } finally {
      dateNow.mockRestore();
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("binds Moonshot fallback credentials into the canonical Kimi API-key secret", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      env: {
        [PROVIDER_ID_ENV]: "provider-id-value",
        [PROVIDER_SECRET_ENV]: "provider-secret-value",
        MOONSHOT_API_KEY: "moonshot-key-value"
      }
    });
    fixture.input.agent_auth = kimiApiAgentAuth();
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(client.secrets.fromObject).toHaveBeenCalledWith({ KIMI_API_KEY: "moonshot-key-value" });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("treats Moonshot as an optional Kimi fallback when compiled cloud tasks list both names", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      env: {
        [PROVIDER_ID_ENV]: "provider-id-value",
        [PROVIDER_SECRET_ENV]: "provider-secret-value",
        KIMI_API_KEY: "kimi-key-value"
      }
    });
    fixture.input.agent_auth = kimiApiAgentAuth();
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(client.secrets.fromObject).toHaveBeenCalledWith({ KIMI_API_KEY: "kimi-key-value" });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("binds a compiled Moonshot fallback list into Kimi Code's canonical API-key secret", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      env: {
        [PROVIDER_ID_ENV]: "provider-id-value",
        [PROVIDER_SECRET_ENV]: "provider-secret-value",
        MOONSHOT_API_KEY: "moonshot-key-value"
      }
    });
    fixture.input.agent_auth = kimiApiAgentAuth();
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(client.secrets.fromObject).toHaveBeenCalledWith({ KIMI_API_KEY: "moonshot-key-value" });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("forwards optional Kimi API base URLs into cloud-node workers", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      env: {
        [PROVIDER_ID_ENV]: "provider-id-value",
        [PROVIDER_SECRET_ENV]: "provider-secret-value",
        KIMI_API_KEY: "kimi-key-value",
        KIMI_BASE_URL: "https://kimi.example.invalid/v1"
      }
    });
    fixture.input.agent_auth = kimiApiAgentAuth();
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(client.secrets.fromObject).toHaveBeenCalledWith({
        KIMI_API_KEY: "kimi-key-value",
        KIMI_BASE_URL: "https://kimi.example.invalid/v1"
      });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("refuses to publish cloud results through a symlinked project destination prefix", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ listed: [sandbox] });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    const outside = path.join(path.dirname(fixture.root), "outside-artifacts");
    try {
      fixture.input.artifact_dir = "published-artifacts/attempt-one";
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(fixture.root, "published-artifacts"), "dir");

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/artifact directory is not an anchored project path/u);
      expect(fs.existsSync(path.join(outside, "attempt-one", "finding.json"))).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("terminates a fresh sandbox when cancellation interrupts the worker", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined);
    sandbox.filesystem.readText = vi.fn(async () => {
      throw new SandboxFilesystemNotFoundError("not found");
    });
    sandbox.exec = vi.fn(async (command: string[]) =>
      command[0] === "node"
        ? fakeContainerProcess({ wait: () => new Promise<number>(() => undefined) })
        : fakeContainerProcess()
    ) as never;
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    const controller = new AbortController();
    try {
      const running = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        signal: controller.signal,
        heartbeat: vi.fn()
      });
      await vi.waitFor(() =>
        expect(sandbox.exec).toHaveBeenCalledWith(
          expect.arrayContaining(["node", expect.stringContaining("node-worker")])
        )
      );
      controller.abort();
      await expect(running).rejects.toThrow("cancelled");
      expect(sandbox.terminate).toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it("does not report cancellation complete while its sandbox remains live", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined);
    sandbox.filesystem.readText = vi.fn(async () => {
      throw new SandboxFilesystemNotFoundError("not found");
    });
    sandbox.exec = vi.fn(async (command: string[]) =>
      command[0] === "node"
        ? fakeContainerProcess({ wait: () => new Promise<number>(() => undefined) })
        : fakeContainerProcess()
    ) as never;
    sandbox.terminate = vi.fn(async () => {
      throw new Error("termination failed");
    });
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ created: sandbox })));
    const controller = new AbortController();
    try {
      const running = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        signal: controller.signal,
        heartbeat: vi.fn()
      });
      await vi.waitFor(() =>
        expect(sandbox.exec).toHaveBeenCalledWith(
          expect.arrayContaining(["node", expect.stringContaining("node-worker")])
        )
      );
      controller.abort();
      await expect(running).rejects.toThrow("remained live after termination");
    } finally {
      fixture.cleanup();
    }
  });

  it("bounds stuck shutdown and releases the local Kimi lease behind a durable unresolved fence", async () => {
    const fixture = createProjectFixture();
    const kimiSource = createKimiSubscriptionFixture();
    const sandbox = fakeSandbox(undefined);
    sandbox.filesystem.readText = vi.fn(async () => {
      throw new SandboxFilesystemNotFoundError("not found");
    });
    sandbox.exec = vi.fn(async (command: string[]) =>
      command[0] === "node"
        ? fakeContainerProcess({ wait: () => new Promise<number>(() => undefined) })
        : fakeContainerProcess()
    ) as never;
    sandbox.poll = vi.fn(() => new Promise<number | null>(() => undefined));
    sandbox.terminate = vi.fn(() => new Promise<number>(() => undefined)) as never;
    const releaseLease = vi.fn(async () => undefined);
    const lease = testKimiExecutionLease(kimiSource, releaseLease);
    const acquireLease = vi.fn(async () => lease);
    fixture.input.agent_auth = {
      agent: "KimiAgent",
      provider: "kimi",
      auth: { mode: "subscription", config_dir: kimiSource }
    };
    fixture.input.agent_model = "kimi-k3";
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(fakeClient({ created: sandbox })),
      kimiExecutionLease: acquireLease as never,
      modalShutdown: { timeoutMs: 25 }
    });
    const controller = new AbortController();
    try {
      const running = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        signal: controller.signal,
        heartbeat: vi.fn()
      });
      await vi.waitFor(() =>
        expect(sandbox.exec).toHaveBeenCalledWith(
          expect.arrayContaining(["node", expect.stringContaining("node-worker")])
        )
      );
      const shutdownStartedAt = Date.now();
      controller.abort();
      const failure = await Promise.resolve(running).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(errorGraphText(failure)).toContain("deadline");
      expect(Date.now() - shutdownStartedAt).toBeLessThan(2_000);
      expect(acquireLease).toHaveBeenCalledOnce();
      expect(lease.markRotationPossible).toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
      fs.rmSync(kimiSource, { recursive: true, force: true });
    }
  });

  it("requires force before terminating sandboxes and their durable volume for a run", async () => {
    const active = fakeSandbox(undefined);
    const refusedClient = fakeClient({ listed: [active] });
    const refused = cleanupModalNodeRun(providerOptions(refusedClient), "controller-run");
    await expect(refused).rejects.toBeInstanceOf(ModalNodeCleanupRefusedError);
    await expect(refused).rejects.toMatchObject({
      name: "ModalNodeCleanupRefusedError",
      code: "MODAL_NODE_CLEANUP_REFUSED",
      message: "cloud cleanup refused because the run still has active node sandboxes"
    });
    expect(refusedClient.volumes.fromName).not.toHaveBeenCalled();
    expect(refusedClient.volumes.delete).not.toHaveBeenCalled();

    const forceClient = fakeClient({ listed: [fakeSandbox(undefined)] });
    await expect(cleanupModalNodeRun(providerOptions(forceClient), "controller-run", { force: true })).resolves.toEqual(
      { terminated: 1, volumeDeleted: true }
    );
    expect(forceClient.volumes.fromName).not.toHaveBeenCalled();
    expect(forceClient.volumes.delete).toHaveBeenCalledWith("ultrafuzz-node-controller-run-5bc2f4467115");
  });

  it("treats a sandbox that finishes during forced cleanup as already terminated", async () => {
    const sandbox = fakeSandbox(undefined);
    sandbox.poll = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(0);
    sandbox.terminate = vi.fn(async () => {
      throw new Error("sandbox already stopped");
    });
    const client = fakeClient({ listed: [sandbox] });

    await expect(cleanupModalNodeRun(providerOptions(client), "controller-run", { force: true })).resolves.toEqual({
      terminated: 1,
      volumeDeleted: true
    });
    expect(sandbox.detach).not.toHaveBeenCalled();
    expect(client.volumes.fromName).not.toHaveBeenCalled();
    expect(client.volumes.delete).toHaveBeenCalledWith("ultrafuzz-node-controller-run-5bc2f4467115");
  });

  it("forces cleanup of every candidate and preserves all termination failures", async () => {
    const first = fakeSandbox(undefined, { sandboxId: "cleanup-one" });
    const second = fakeSandbox(undefined, { sandboxId: "cleanup-two" });
    const healthy = fakeSandbox(undefined, { sandboxId: "cleanup-three" });
    for (const [sandbox, message] of [
      [first, "cleanup one failed"],
      [second, "cleanup two failed"]
    ] as const) {
      sandbox.poll = vi.fn(async () => null);
      sandbox.terminate = vi.fn(async () => {
        throw new Error(message);
      }) as never;
    }
    const client = fakeClient({ listed: [first, second, healthy] });
    const failure = await cleanupModalNodeRun(providerOptions(client), "controller-run", { force: true }).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AggregateError);
    const messages = aggregateErrorMessages(failure).join("\n");
    expect(messages).toMatch(/cleanup one failed/u);
    expect(messages).toMatch(/cleanup two failed/u);
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(second.terminate).toHaveBeenCalledOnce();
    expect(healthy.terminate).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("fails without echoing configured credential identifiers", async () => {
    const fixture = createProjectFixture();
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(fakeClient({})),
      env: {}
    });
    try {
      const run = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        heartbeat: vi.fn()
      });
      await expect(run).rejects.toThrow(/configured cloud .*credential.* is unavailable/u);
      await expect(run).rejects.not.toThrow(PROVIDER_ID_ENV);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects controller or trusted-environment names as child credentials", async () => {
    const fixture = createProjectFixture();
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({})));
    try {
      fixture.input.agent_auth = deepSeekAgentAuth(PROVIDER_SECRET_ENV);
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/overlap controller credentials/u);

      fixture.input.agent_auth = deepSeekAgentAuth("NODE_OPTIONS");
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/reserved or invalid/u);
    } finally {
      fixture.cleanup();
    }
  });
});

function aggregateErrorMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (typeof error !== "object" || error === null) return [String(error)];
  if (seen.has(error)) return [];
  seen.add(error);
  const messages = error instanceof Error ? [error.message] : [String(error)];
  if (error instanceof AggregateError) {
    for (const failure of error.errors) messages.push(...aggregateErrorMessages(failure, seen));
  }
  if (error instanceof Error && error.cause !== undefined) {
    messages.push(...aggregateErrorMessages(error.cause, seen));
  }
  return messages;
}

function testLineageId(prefix: string, value: unknown): string {
  return `${prefix}-${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function identifiedModalNodeInput(input: ModalNodeSandboxInput): ModalNodeSandboxInput & {
  execution_identity: string;
  project_archive_sha256: string;
  request_fingerprint: string;
} {
  if (input.project_archive_sha256 === undefined) throw new Error("test cloud archive digest is unavailable");
  const projectArchiveSha256 = input.project_archive_sha256;
  const { request_fingerprint: _requestFingerprint, execution_identity: _executionIdentity, ...unidentified } = input;
  const fingerprintInput = { ...unidentified, project_archive_sha256: projectArchiveSha256 };
  const requestFingerprint = modalNodeRequestFingerprint(fingerprintInput);
  const identified = { ...fingerprintInput, request_fingerprint: requestFingerprint };
  return {
    ...identified,
    execution_identity: modalNodeExecutionIdentity(identified)
  };
}

function providerOptions(client: ReturnType<typeof fakeClient>) {
  let remoteClock = 0;
  return {
    app: "ultrafuzz-test",
    image: "ultrafuzz-test-image",
    credentialEnv: [PROVIDER_ID_ENV, PROVIDER_SECRET_ENV],
    env: {
      [PROVIDER_ID_ENV]: "provider-id-value",
      [PROVIDER_SECRET_ENV]: "provider-secret-value",
      [AGENT_ENV]: "agent-key-value"
    },
    clientFactory: () => client as never,
    kimiRemoteQuiescence: {
      now: () => remoteClock,
      pause: async (ms: number) => {
        remoteClock += ms;
      },
      settlementMs: 5,
      timeoutMs: 100
    }
  };
}

function createProjectFixture() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-provider-test-"));
  const root = path.join(temporaryRoot, "project");
  const runRoot = ".ultrafuzz/runs/run-one";
  const artifactDir = `${runRoot}/artifacts/attempt-one`;
  const dependencyArtifactDirs = [`${runRoot}/artifacts/dependency-one`, `${runRoot}/artifacts/dependency-two`];
  const workspaceDir = `${runRoot}/workspaces/attempt-one`;
  const workflowPath = ".smithers/workflows/ultrafuzz-run-one.tsx";
  const promptPath = `${runRoot}/prompts/attempt-one.md`;
  fs.mkdirSync(path.join(root, path.dirname(workflowPath)), { recursive: true });
  fs.mkdirSync(path.join(root, path.dirname(promptPath)), { recursive: true });
  fs.mkdirSync(path.join(root, ".smithers", "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, artifactDir), { recursive: true });
  for (const dependency of dependencyArtifactDirs) {
    fs.mkdirSync(path.join(root, dependency), { recursive: true });
    fs.writeFileSync(path.join(root, dependency, "declared.txt"), `${dependency}\n`);
  }
  const markerRoot = path.join(root, runRoot, ".ultrafuzz-verification");
  fs.mkdirSync(markerRoot, { recursive: true });
  for (const dependency of dependencyArtifactDirs) {
    fs.writeFileSync(
      path.join(markerRoot, `${path.basename(dependency)}.json`),
      `${JSON.stringify({
        schema_version: "ultrafuzz.artifact-verification.v1",
        attempt_id: path.basename(dependency),
        artifacts: [],
        publications: []
      })}\n`
    );
  }
  fs.writeFileSync(path.join(markerRoot, "unrelated.json"), "{}\n");
  fs.mkdirSync(path.join(root, runRoot, "artifacts", "unrelated"), { recursive: true });
  fs.mkdirSync(path.join(root, workspaceDir), { recursive: true });
  fs.mkdirSync(path.join(root, runRoot, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "source.txt"), "historical source\n");
  fs.writeFileSync(path.join(root, "historical-secret.txt"), "must not survive shallow handoff\n");
  fs.writeFileSync(
    path.join(root, ".smithers", "agents", "deepseek.ts"),
    "export const createDeepSeekAgent = () => ({});\n"
  );
  fs.writeFileSync(path.join(root, ".smithers", "agents", "kimi.ts"), "export const createKimiAgent = () => ({});\n");
  fs.writeFileSync(path.join(root, workflowPath), "export default {};\n");
  fs.writeFileSync(path.join(root, promptPath), "rendered prompt\n");
  fs.writeFileSync(path.join(root, artifactDir, "stale.txt"), "stale\n");
  fs.writeFileSync(path.join(root, runRoot, "artifacts", "unrelated", "unrelated.txt"), "unrelated\n");
  fs.writeFileSync(path.join(root, workspaceDir, "local.txt"), "excluded\n");
  fs.writeFileSync(path.join(root, runRoot, "logs", "local.log"), "excluded\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Ultrafuzz Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@invalid"], { cwd: root });
  execFileSync("git", ["add", "source.txt", "historical-secret.txt"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "historical fixture"], { cwd: root });
  fs.writeFileSync(path.join(root, "source.txt"), "committed source\n");
  fs.unlinkSync(path.join(root, "historical-secret.txt"));
  execFileSync("git", ["add", "source.txt", "historical-secret.txt"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  const baseCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  const input: ModalNodeSandboxInput = {
    schema_version: "ultrafuzz.modal.node.v1",
    run_id: "run-one",
    task_id: "node:attempt-one",
    attempt_id: "attempt-one",
    execution_generation: "base",
    workflow_execution_id: "workflow-execution-fixture",
    controller_invocation_id: "controller-invocation-fixture",
    base_commit: baseCommit,
    workflow_path: workflowPath,
    prompt_path: promptPath,
    run_root: runRoot,
    artifact_dir: artifactDir,
    workspace_dir: workspaceDir,
    dependency_artifact_dirs: dependencyArtifactDirs,
    resources: {
      cpu: 2,
      memory_mib: 4096,
      timeout_seconds: 60
    },
    agent_auth: deepSeekAgentAuth()
  };
  return {
    root,
    input,
    cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true })
  };
}

function selectKimiSubscription(input: ModalNodeSandboxInput, source: string): void {
  input.agent_auth = {
    agent: "KimiAgent",
    provider: "kimi",
    auth: { mode: "subscription", config_dir: source }
  };
  input.agent_model = "kimi-k3";
}

function testKimiExecutionLease(
  source: string,
  release = vi.fn(async () => undefined),
  ownerId = KIMI_CREDENTIAL_LEASE_OWNER
) {
  return {
    assertOwner: vi.fn(async () => undefined),
    credentialLeaseId: KIMI_CREDENTIAL_LEASE_ID,
    credentialPath: path.join(source, "credentials", "kimi-code.json"),
    leasePath: path.join(source, "oauth", "modal-execution"),
    markRotationPossible: vi.fn(async () => undefined),
    markRotationResolved: vi.fn(async () => undefined),
    ownerId,
    prepareAuthCopy: vi.fn(async (env: Record<string, string | undefined> = {}) => {
      const prepared = await prepareSubscriptionAuthCopy(
        { provider: "kimi", auth_mode: "subscription", model: "kimi-k3" },
        { ...env, KIMI_CODE_HOME: source }
      );
      if (prepared === undefined) throw new Error("test Kimi subscription snapshot is unavailable");
      return prepared;
    }),
    reconcileCredential: vi.fn(async () => true),
    source,
    release
  };
}

function createKimiSubscriptionFixture(): string {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-kimi-source-"));
  fs.mkdirSync(path.join(source, "credentials"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "config.toml"),
    `default_model = "kimi-k3"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
oauth = { storage = "file", key = "oauth/kimi-code" }

[models.kimi-k3]
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
      access_token: "initial-access",
      refresh_token: "initial-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 7_200,
      expires_in: 3_600
    })}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(source, "device_id"), "device-test\n", { mode: 0o600 });
  return source;
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

function manifestEntry(relativePath: string, filePath: string) {
  return {
    path: relativePath,
    size_bytes: fs.statSync(filePath).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
    provenance: { producer_node_id: "fixture" }
  };
}

function createResultArchive(
  options: {
    candidateCredential?: string;
    extraArtifactContents?: string;
    extraResultFields?: Record<string, unknown>;
    includeWorkspace?: boolean;
    includeArtifactsDirectory?: boolean;
    includeDurableCheckpoint?: boolean;
    includeVerificationMarker?: boolean;
    schemaVersion?: "ultrafuzz.modal.node-result.v1" | "ultrafuzz.modal.node-result.v2";
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-result-test-"));
  const bundle = path.join(root, "bundle");
  const archive = path.join(root, "result.tgz");
  if (options.includeArtifactsDirectory !== false) {
    fs.mkdirSync(path.join(bundle, "artifacts"), { recursive: true });
  }
  fs.mkdirSync(path.join(bundle, "source-proofs"), { recursive: true });
  if (options.includeVerificationMarker !== false) {
    fs.mkdirSync(path.join(bundle, "verification"), { recursive: true });
  }
  if (options.includeArtifactsDirectory !== false) {
    fs.writeFileSync(path.join(bundle, "artifacts", "finding.json"), '{"ok":true}\n');
    fs.writeFileSync(path.join(bundle, "artifacts", "report.md"), "# remote report\n");
    fs.writeFileSync(path.join(bundle, "artifacts", "report.json"), '{"schema_version":"1.0"}\n');
    fs.writeFileSync(path.join(bundle, "artifacts", "findings.normalized.json"), "[]\n");
    if (options.extraArtifactContents !== undefined) {
      fs.writeFileSync(path.join(bundle, "artifacts", "leak.txt"), options.extraArtifactContents);
    }
    fs.writeFileSync(
      path.join(bundle, "artifacts", WORKSPACE_SOURCE_ATTESTATION_FILE),
      '{"schema_version":"ultrafuzz.workspace-source-attestation.v1"}\n'
    );
  }
  fs.writeFileSync(path.join(bundle, "source-proofs", "attempt-one.invariant.json"), "durable source proof\n");
  fs.writeFileSync(path.join(bundle, "source-proofs", "attempt-one.json"), "pinned source proof\n");
  if (options.includeWorkspace === true) {
    fs.mkdirSync(path.join(bundle, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "workspace", "work.txt"), "remote workspace\n");
  }
  if (options.includeVerificationMarker !== false) {
    fs.writeFileSync(path.join(bundle, "verification", "attempt-one.json"), '{"verified":true}\n');
  }
  execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const tags = modalNodeTags("controller-run", "node:attempt");
  const resultAttemptRoot = `/run/ultrafuzz-node-results/${tags.run}/${tags.attempt}`;
  const durableAttemptRoot = `/data/ultrafuzz-nodes/${tags.run}/${tags.attempt}`;
  const durableCheckpoint = `${durableAttemptRoot}/checkpoints/0003-completed.json`;
  const durableCheckpointIndex = `${durableAttemptRoot}/checkpoints/index.json`;
  return {
    archive,
    candidateCredential: options.candidateCredential,
    digest,
    result: JSON.stringify({
      ...(options.extraResultFields ?? {}),
      schema_version: options.schemaVersion ?? "ultrafuzz.modal.node-result.v2",
      status: "succeeded",
      artifact_archive: `${resultAttemptRoot}/artifacts.tgz`,
      artifact_sha256: digest,
      storage_lineage: "run-one/attempt-one/base",
      execution_identity: "set-from-sandbox-tags",
      ...(options.candidateCredential === undefined
        ? {}
        : { credential_candidate: `${resultAttemptRoot}/kimi-credential-candidate.json` }),
      ...(options.includeDurableCheckpoint === false
        ? {}
        : {
            durable_checkpoint: durableCheckpoint,
            durable_checkpoint_index: durableCheckpointIndex
          })
    }),
    durableCheckpoint: JSON.stringify({
      schema_version: "ultrafuzz.modal.node-checkpoint.v1",
      checkpoint_id: "0003-completed",
      sequence: 3,
      stage: "completed",
      created_at: "2026-08-01T00:00:02.000Z",
      storage_lineage: "run-one/attempt-one/base",
      workspace_path: `${durableAttemptRoot}/workspace`,
      run_root: ".ultrafuzz/runs/run-one",
      handoff_archive: `${durableAttemptRoot}/input/project.tgz`,
      project_archive_sha256: "set-from-request",
      execution_identity: "set-from-request",
      request_fingerprint: "set-from-request",
      base_commit: "set-from-request"
    }),
    durableCheckpointIndex: JSON.stringify({
      schema_version: "ultrafuzz.modal.node-checkpoint-index.v1",
      storage_lineage: "run-one/attempt-one/base",
      workspace_path: `${durableAttemptRoot}/workspace`,
      run_root: ".ultrafuzz/runs/run-one",
      handoff_archive: `${durableAttemptRoot}/input/project.tgz`,
      project_archive_sha256: "set-from-request",
      execution_identity: "set-from-request",
      request_fingerprint: "set-from-request",
      base_commit: "set-from-request",
      checkpoints: [
        {
          checkpoint_id: "0001-prepared",
          sequence: 1,
          stage: "prepared",
          created_at: "2026-08-01T00:00:00.000Z",
          manifest: `${durableAttemptRoot}/checkpoints/0001-prepared.json`
        },
        {
          checkpoint_id: "0002-running",
          sequence: 2,
          stage: "running",
          created_at: "2026-08-01T00:00:01.000Z",
          manifest: `${durableAttemptRoot}/checkpoints/0002-running.json`
        },
        {
          checkpoint_id: "0003-completed",
          sequence: 3,
          stage: "completed",
          created_at: "2026-08-01T00:00:02.000Z",
          manifest: durableCheckpoint
        }
      ]
    }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function fakeContainerProcess(
  options: {
    exitCode?: number;
    stderr?: string;
    stdout?: string;
    wait?: () => Promise<number>;
  } = {}
) {
  return {
    stdout: { readText: vi.fn(async () => options.stdout ?? "") },
    stderr: { readText: vi.fn(async () => options.stderr ?? "") },
    wait: vi.fn(options.wait ?? (async () => options.exitCode ?? 0))
  };
}

function identifiedWorkerInputForSandbox(executionIdentity: string | undefined): ModalNodeSandboxInput & {
  execution_identity: string;
  project_archive_sha256: string;
  request_fingerprint: string;
} {
  if (executionIdentity === undefined) throw new Error("fake sandbox execution identity is unavailable");
  for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("ultrafuzz-node-handoff-")) continue;
    const requestPath = path.join(os.tmpdir(), entry.name, "request.json");
    try {
      const input = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Partial<ModalNodeSandboxInput>;
      if (
        input.execution_identity === executionIdentity &&
        typeof input.project_archive_sha256 === "string" &&
        typeof input.request_fingerprint === "string"
      ) {
        return input as ModalNodeSandboxInput & {
          execution_identity: string;
          project_archive_sha256: string;
          request_fingerprint: string;
        };
      }
    } catch {
      // Other tests can clean their handoff directory between listing and inspection.
    }
  }
  throw new Error("fake sandbox could not locate its identified handoff request");
}

function fakeSandbox(
  result: ReturnType<typeof createResultArchive> | undefined,
  options: { resultIdentity?: string; sandboxId?: string; tags?: Record<string, string> } = {}
) {
  let exitCode: number | null = null;
  let sandboxTags: Record<string, string> = { ...(options.tags ?? {}) };
  return {
    sandboxId: options.sandboxId ?? "sandbox-one",
    poll: vi.fn(async () => exitCode),
    terminate: vi.fn(async () => {
      exitCode = 0;
    }),
    detach: vi.fn(),
    getTags: vi.fn(async () => sandboxTags),
    setTestTags: (tags: Record<string, string>) => {
      sandboxTags = { ...tags };
    },
    exec: vi.fn(),
    filesystem: {
      readText: vi.fn(async (remote: string) => {
        if (result === undefined) throw new SandboxFilesystemNotFoundError("not found");
        if (remote.endsWith("/0003-completed.json") || remote.endsWith("/checkpoints/index.json")) {
          const input = identifiedWorkerInputForSandbox(sandboxTags.execution_identity);
          const serialized = remote.endsWith("/0003-completed.json")
            ? result.durableCheckpoint
            : result.durableCheckpointIndex;
          return JSON.stringify({
            ...(JSON.parse(serialized) as Record<string, unknown>),
            project_archive_sha256: input.project_archive_sha256,
            execution_identity: input.execution_identity,
            request_fingerprint: input.request_fingerprint,
            base_commit: input.base_commit
          });
        }
        return JSON.stringify({
          ...(JSON.parse(result.result) as Record<string, unknown>),
          execution_identity: options.resultIdentity ?? sandboxTags.execution_identity
        });
      }),
      copyFromLocal: vi.fn(async () => undefined),
      copyToLocal: vi.fn(async (remote: string, local: string) => {
        if (result === undefined) throw new Error("result is unavailable");
        if (remote.endsWith("/kimi-credential-candidate.json")) {
          if (result.candidateCredential === undefined) throw new Error("credential candidate is unavailable");
          fs.writeFileSync(local, result.candidateCredential, { mode: 0o600 });
        } else {
          fs.copyFileSync(result.archive, local);
        }
      })
    }
  } as unknown as Sandbox & {
    poll: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    getTags: ReturnType<typeof vi.fn>;
    setTestTags: (tags: Record<string, string>) => void;
    exec: ReturnType<typeof vi.fn>;
    filesystem: {
      readText: ReturnType<typeof vi.fn>;
      copyFromLocal: ReturnType<typeof vi.fn>;
      copyToLocal: ReturnType<typeof vi.fn>;
    };
  };
}

function fakeClient(options: { listed?: Sandbox[]; created?: Sandbox; preserveListedTags?: boolean }) {
  const listed = options.listed ?? [];
  const createdSandboxes: Sandbox[] = [];
  const volume = { volumeId: "volume-one" };
  return {
    cpClient: {
      volumeGetOrCreate: vi.fn(async () => ({ volumeId: volume.volumeId, metadata: { version: 2 } }))
    },
    environmentName: vi.fn(() => "default"),
    apps: {
      fromName: vi.fn(async () => ({ appId: "app-one" }))
    },
    images: {
      fromName: vi.fn(async () => ({}))
    },
    volumes: {
      fromName: vi.fn(async () => volume),
      delete: vi.fn(async () => undefined)
    },
    secrets: {
      fromObject: vi.fn(async () => ({}))
    },
    sandboxes: {
      create: vi.fn(async (_app: unknown, _image: unknown, params: { tags?: Record<string, string> }) => {
        const sandbox = options.created ?? fakeSandbox(undefined);
        (sandbox as unknown as { setTestTags?: (tags: Record<string, string>) => void }).setTestTags?.(
          params.tags ?? {}
        );
        createdSandboxes.push(sandbox);
        return sandbox;
      }),
      list: vi.fn(async function* (params: { tags: Record<string, string> }) {
        for (const sandbox of listed) {
          if (options.preserveListedTags === true) {
            const tags = await sandbox.getTags();
            if (Object.entries(params.tags).every(([key, value]) => tags[key] === value)) yield sandbox;
            continue;
          }
          if (params.tags.execution_identity !== undefined) {
            (sandbox as unknown as { setTestTags?: (tags: Record<string, string>) => void }).setTestTags?.(params.tags);
          }
          yield sandbox;
        }
        for (const sandbox of createdSandboxes) {
          if (listed.some((candidate) => candidate.sandboxId === sandbox.sandboxId)) continue;
          const tags = await sandbox.getTags();
          if (Object.entries(params.tags).every(([key, value]) => tags[key] === value)) yield sandbox;
        }
      })
    },
    close: vi.fn()
  };
}

function errorGraphText(error: unknown, seen = new Set<unknown>()): string {
  if (typeof error !== "object" || error === null || seen.has(error)) return String(error);
  seen.add(error);
  const values = [error instanceof Error ? error.message : String(error)];
  if (error instanceof Error && error.cause !== undefined) values.push(errorGraphText(error.cause, seen));
  if (error instanceof AggregateError) {
    for (const nested of error.errors) values.push(errorGraphText(nested, seen));
  }
  return values.join("\n");
}

function recursiveOwnValueContains(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") return value.includes(needle);
  if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    let nested: unknown;
    try {
      nested = Reflect.get(value, key);
    } catch {
      continue;
    }
    if (recursiveOwnValueContains(nested, needle, seen)) return true;
  }
  return false;
}
