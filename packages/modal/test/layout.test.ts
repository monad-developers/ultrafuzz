import { describe, expect, it } from "vitest";

import {
  EVAL_POST_WATCH_MARGIN_MS,
  EVAL_WATCH_TIMEOUT_SECONDS,
  MODAL_MAX_SANDBOX_TIMEOUT_MS,
  MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS,
  MODAL_PUBLIC_SANDBOX_TIMEOUT_MS,
  MODAL_RECOVERY_SANDBOX_TIMEOUT_MS,
  MODAL_SANDBOX_TIMEOUT_MS
} from "../src/defaults.js";
import {
  REMOTE_CONFIG_PATH,
  REMOTE_LAUNCH_READY_PATH,
  REMOTE_LINEAGE_PATH,
  modalVolumeName,
  persistentWorkspaceRoot,
  remoteAuthPath,
  resolvePersistentRemoteRoot
} from "../src/layout.js";
import { modalEvalRunCommand } from "../src/resume.js";

describe("Modal storage layout", () => {
  it("persists workspaces while keeping config and auth ephemeral", () => {
    expect(persistentWorkspaceRoot("run-1", "model-1")).toBe("/data/run-1/model-1/workspace");
    expect(REMOTE_CONFIG_PATH).toBe("/run/ultrafuzz-config/benchmark.json");
    expect(REMOTE_LINEAGE_PATH).toBe("/run/ultrafuzz-config/lineage.json");
    expect(REMOTE_LAUNCH_READY_PATH).toBe("/run/ultrafuzz-config/launch-ready");
    expect(remoteAuthPath("openai")).toBe("/run/ultrafuzz-auth/codex/auth.json");
    expect(remoteAuthPath("anthropic")).toBe("/run/ultrafuzz-auth/claude/.credentials.json");
    expect(remoteAuthPath("deepseek")).toBe("/run/ultrafuzz-auth/deepseek/api-key");
    expect(remoteAuthPath("openrouter")).toBe("/run/ultrafuzz-auth/openrouter/api-key");
    expect(remoteAuthPath("kimi")).toBe("/run/ultrafuzz-auth/kimi/config.toml");
  });

  it("uses stable collision-resistant volume names for logical run identity", () => {
    const sharedPrefix = "x".repeat(120);
    const first = modalVolumeName(`${sharedPrefix}-one`, "model");
    const second = modalVolumeName(`${sharedPrefix}-two`, "model");
    expect(first).toHaveLength(63);
    expect(second).toHaveLength(63);
    expect(first).not.toBe(second);
    expect(modalVolumeName(`${sharedPrefix}-one`, "model")).toBe(first);
  });

  it("keeps the bounded eval watch below the sandbox maximum with a fixed completion margin", () => {
    expect(MODAL_SANDBOX_TIMEOUT_MS).toBe(MODAL_MAX_SANDBOX_TIMEOUT_MS);
    expect(MODAL_MAX_SANDBOX_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
    expect(MODAL_PUBLIC_SANDBOX_TIMEOUT_MS).toBe(6 * 60 * 60 * 1000);
    expect(MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS).toBe(16 * 60 * 60 * 1000);
    expect(MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS).toBeLessThan(MODAL_MAX_SANDBOX_TIMEOUT_MS);
    expect(MODAL_RECOVERY_SANDBOX_TIMEOUT_MS).toBe(MODAL_MAX_SANDBOX_TIMEOUT_MS);
    expect(EVAL_POST_WATCH_MARGIN_MS).toBe(2 * 60 * 60 * 1000);
    expect(EVAL_WATCH_TIMEOUT_SECONDS * 1000).toBe(MODAL_SANDBOX_TIMEOUT_MS - EVAL_POST_WATCH_MARGIN_MS);
    expect(EVAL_WATCH_TIMEOUT_SECONDS * 1000).toBeLessThan(MODAL_SANDBOX_TIMEOUT_MS);

    const command = modalEvalRunCommand({
      cliPath: "/opt/tool/cli.js",
      controlRoot: "/workspace/control",
      suitePath: "/workspace/control/suite.yml",
      evalRunId: "evaluation-one"
    });
    expect(command[command.indexOf("--watch-timeout-seconds") + 1]).toBe(String(EVAL_WATCH_TIMEOUT_SECONDS));
  });

  it("maps only trusted /data children through the resolved Modal mount", () => {
    expect(resolvePersistentRemoteRoot("/data/run-1/model-1", "/resolved-volume")).toBe(
      "/resolved-volume/run-1/model-1"
    );
    expect(() => resolvePersistentRemoteRoot("/other/run-1", "/resolved-volume")).toThrow("must be a child of /data");
  });
});
