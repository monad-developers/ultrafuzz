import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SandboxFilesystemNotFoundError, type Sandbox } from "modal";
import { runWithToolContext } from "@smithers-orchestrator/tool-context";
import { describe, expect, it, vi } from "vitest";

import { WORKSPACE_SOURCE_ATTESTATION_FILE } from "@ultrafuzz/runtime";

import {
  cleanupModalNodeRun,
  createModalNodeHandoffArchive,
  createModalNodeSandboxProvider as createRawModalNodeSandboxProvider,
  finalizeModalNodeSandbox,
  ModalNodeCleanupRefusedError,
  modalNodeExecutionIdentity,
  modalNodeExecutionReceipt,
  modalNodeRequestFingerprint,
  modalNodeSandboxName,
  modalNodeTags,
  parseCloudAgentAuthDescriptor,
  parseModalNodeSandboxInput,
  assertNoForwardedCredentialBytes,
  type ModalNodeSandboxInput
} from "../src/node-provider.js";
import {
  cloudAgentCommandRole,
  cloudAgentInvocation,
  cloudAgentSubprocessInvocation,
  cloudPublicationBoundary,
  copySafeTree,
  rewriteCloudAgentAuthConfig,
  runAfterCloudAgentQuiescence,
  stageCanonicalNodeResultBundle
} from "../src/node-worker.js";
import { extractSafeTarArchive } from "../src/safe-archive.js";

const PROVIDER_ID_ENV = "ULTRAFUZZ_TEST_PROVIDER_ID";
const PROVIDER_SECRET_ENV = "ULTRAFUZZ_TEST_PROVIDER_SECRET";
const AGENT_ENV = "ULTRAFUZZ_TEST_AGENT_KEY";

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
    await expect(
      finalizeModalNodeSandbox(
        () => {
          throw new Error("local cleanup failed");
        },
        sandbox,
        close
      )
    ).rejects.toThrow("local cleanup failed");
    expect(sandbox.terminate).toHaveBeenCalledOnce();
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

  it("preserves termination, cleanup, and close failures while surfacing unproven termination", async () => {
    const sandbox = fakeSandbox(undefined);
    const terminationError = new Error("termination failed");
    const cleanupError = new Error("local cleanup failed");
    const closeError = new Error("client close failed");
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
      }
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
      isolation_protocol: "rootless-ephemeral-v2"
    });
    expect(modalNodeSandboxName("run/with spaces", "node:attempt")).toMatch(
      /^ufz-run-with-spaces-node-attempt-bas-[0-9a-f]{12}$/u
    );
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
      expect(fs.readFileSync(configPath, "utf8")).toContain('api_key_env = "DEEPSEEK_API_KEY"');

      rewriteCloudAgentAuthConfig({ agent: "KimiAgent", provider: "kimi", auth: { mode: "subscription" } }, root);
      expect(fs.readFileSync(configPath, "utf8")).toContain('config_dir = "/workspace/agent-home/.kimi-code"');
      expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(false);
    } finally {
      chown.mockRestore();
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
      }
      expect(entries).not.toContain("local-only-secret");
      expect(entries).not.toContain("current-only.txt");
      expect(entries).not.toContain("unrelated.txt");
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages only canonical task artifacts while retaining mirrors and source attestation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-canonical-result-"));
    try {
      const artifactDir = path.join(root, "canonical", "attempt-one");
      const workspaceDir = path.join(root, "workspace");
      const mirror = path.join(workspaceDir, "artifacts", "attempt-one");
      const stagingDir = path.join(root, "staging");
      fs.mkdirSync(path.join(artifactDir, "generated-tests"), { recursive: true });
      fs.mkdirSync(path.join(mirror, "generated-tests"), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, "node_modules", ".bin"), { recursive: true });
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

      stageCanonicalNodeResultBundle({ artifactDir, workspaceDir, attemptId: "attempt-one", stagingDir });

      expect(fs.readdirSync(stagingDir)).toEqual(["artifacts"]);
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("quarantines an ephemeral result and publishes only after confirmed sandbox stop", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive({
      extraResultFields: {
        attacker: "must-not-survive",
        ultrafuzz_execution: { execution_identity: "attacker-controlled" }
      }
    });
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
      expect(client.volumes.fromName).not.toHaveBeenCalled();
      expect(client.volumes.delete).not.toHaveBeenCalled();
      expect(events).toEqual(["quarantine-copy", "terminate", "close", "published-heartbeat"]);
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"), "utf8")).toBe(
        '{"ok":true}\n'
      );
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
      expect(client.sandboxes.create.mock.calls[0]?.[2]).not.toHaveProperty("volumes");
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
    const sandbox = fakeSandbox(undefined);
    sandbox.exec = vi.fn(async (command: string[]) =>
      command[0] === "node"
        ? fakeContainerProcess({
            exitCode: 7,
            stderr:
              '{"schema_version":"ultrafuzz.modal.node-worker-error.v1","message":"provider-secret-value run-workflow failed","phase":"run-workflow","command":"smithers","exit_code":7,"stderr":"workflow failed"}\n'
          })
        : fakeContainerProcess()
    ) as never;
    sandbox.terminate = vi.fn(async () => {
      throw new Error("provider-secret-value termination failed");
    });
    const client = fakeClient({ created: sandbox });
    client.close = vi.fn(() => {
      throw new Error("agent-key-value close failed");
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
      const [executionFailure, terminationFailure, closeFailure] = (failure as AggregateError).errors as Error[];
      expect(executionFailure?.message).toMatch(/\[credential\] run-workflow failed/u);
      expect(terminationFailure).toMatchObject({
        cause: expect.objectContaining({ message: "[credential] termination failed" }),
        message: "cloud node sandbox remained live after termination"
      });
      expect(closeFailure?.message).toBe("[credential] close failed");
      expect((failure as AggregateError).errors).toHaveLength(3);
      expect(JSON.stringify(aggregateErrorMessages(failure))).not.toMatch(/provider-secret-value|agent-key-value/u);
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

  it("fails closed when termination cannot prove that a published-result sandbox stopped", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    sandbox.terminate = vi.fn(async () => {
      throw new Error("provider-secret-value termination failed");
    });
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const run = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        heartbeat: vi.fn()
      });
      await expect(run).rejects.toThrow("remained live after termination");
      await expect(run).rejects.not.toThrow("provider-secret-value");
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
    const client = fakeClient({ listed: [sandbox] });
    const events: string[] = [];
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
      kimiReconcile: reconcile as never
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
        "artifacts-quarantined",
        "candidate-quarantined",
        "terminate",
        "broker",
        "reconcile",
        "close",
        "published"
      ]);
      expect(broker).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(candidateLocalPath).toBeDefined();
      expect(fs.existsSync(candidateLocalPath!)).toBe(false);
      expect(client.secrets.fromObject).not.toHaveBeenCalled();
      expect(client.volumes.fromName).not.toHaveBeenCalled();
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

  it("requires force before terminating ephemeral sandboxes for a run", async () => {
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
      { terminated: 1 }
    );
    expect(forceClient.volumes.fromName).not.toHaveBeenCalled();
    expect(forceClient.volumes.delete).not.toHaveBeenCalled();
  });

  it("treats a sandbox that finishes during forced cleanup as already terminated", async () => {
    const sandbox = fakeSandbox(undefined);
    sandbox.poll = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(0);
    sandbox.terminate = vi.fn(async () => {
      throw new Error("sandbox already stopped");
    });
    const client = fakeClient({ listed: [sandbox] });

    await expect(cleanupModalNodeRun(providerOptions(client), "controller-run", { force: true })).resolves.toEqual({
      terminated: 1
    });
    expect(sandbox.detach).not.toHaveBeenCalled();
    expect(client.volumes.fromName).not.toHaveBeenCalled();
    expect(client.volumes.delete).not.toHaveBeenCalled();
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

function providerOptions(client: ReturnType<typeof fakeClient>) {
  return {
    app: "ultrafuzz-test",
    image: "ultrafuzz-test-image",
    credentialEnv: [PROVIDER_ID_ENV, PROVIDER_SECRET_ENV],
    env: {
      [PROVIDER_ID_ENV]: "provider-id-value",
      [PROVIDER_SECRET_ENV]: "provider-secret-value",
      [AGENT_ENV]: "agent-key-value"
    },
    clientFactory: () => client as never
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

function createResultArchive(
  options: {
    candidateCredential?: string;
    extraArtifactContents?: string;
    extraResultFields?: Record<string, unknown>;
    includeWorkspace?: boolean;
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-result-test-"));
  const bundle = path.join(root, "bundle");
  const archive = path.join(root, "result.tgz");
  fs.mkdirSync(path.join(bundle, "artifacts"), { recursive: true });
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
  if (options.includeWorkspace === true) {
    fs.mkdirSync(path.join(bundle, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "workspace", "work.txt"), "remote workspace\n");
  }
  execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const tags = modalNodeTags("controller-run", "node:attempt");
  return {
    archive,
    candidateCredential: options.candidateCredential,
    digest,
    result: JSON.stringify({
      ...(options.extraResultFields ?? {}),
      schema_version: "ultrafuzz.modal.node-result.v1",
      status: "succeeded",
      artifact_archive: path.posix.join("/run/ultrafuzz-node-results", tags.run!, tags.attempt!, "artifacts.tgz"),
      artifact_sha256: digest,
      storage_lineage: "run-one/attempt-one/base",
      ...(options.candidateCredential === undefined
        ? {}
        : {
            credential_candidate: path.posix.join(
              "/run/ultrafuzz-node-results",
              tags.run!,
              tags.attempt!,
              "kimi-credential-candidate.json"
            )
          })
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
      readText: vi.fn(async () => {
        if (result === undefined) throw new SandboxFilesystemNotFoundError("not found");
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
  return {
    apps: {
      fromName: vi.fn(async () => ({ appId: "app-one" }))
    },
    images: {
      fromName: vi.fn(async () => ({}))
    },
    volumes: {
      fromName: vi.fn(async () => ({})),
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
        return sandbox;
      }),
      list: vi.fn(async function* (params: { tags: Record<string, string> }) {
        for (const sandbox of listed) {
          if (params.tags.execution_identity !== undefined && options.preserveListedTags !== true) {
            (sandbox as unknown as { setTestTags?: (tags: Record<string, string>) => void }).setTestTags?.(params.tags);
          }
          yield sandbox;
        }
      })
    },
    close: vi.fn()
  };
}
