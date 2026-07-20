import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EVAL_POST_WATCH_MARGIN_MS,
  EVAL_WATCH_TIMEOUT_SECONDS,
  MODAL_MAX_SANDBOX_TIMEOUT_MS,
  MODAL_SANDBOX_TIMEOUT_MS
} from "../src/defaults.js";
import {
  REMOTE_CONFIG_PATH,
  persistentWorkspaceRoot,
  remoteAuthPath,
  resolvePersistentRemoteRoot
} from "../src/layout.js";

describe("Modal storage layout", () => {
  it("persists workspaces while keeping config and auth ephemeral", () => {
    expect(persistentWorkspaceRoot("run-1", "model-1")).toBe("/data/run-1/model-1/workspace");
    expect(REMOTE_CONFIG_PATH).toBe("/run/ultrafuzz-config/benchmark.json");
    expect(remoteAuthPath("openai")).toBe("/run/ultrafuzz-auth/codex/auth.json");
    expect(remoteAuthPath("anthropic")).toBe("/run/ultrafuzz-auth/claude/.credentials.json");
  });

  it("keeps the bounded eval watch below the sandbox maximum with a fixed completion margin", () => {
    expect(MODAL_SANDBOX_TIMEOUT_MS).toBe(MODAL_MAX_SANDBOX_TIMEOUT_MS);
    expect(MODAL_MAX_SANDBOX_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
    expect(EVAL_POST_WATCH_MARGIN_MS).toBe(2 * 60 * 60 * 1000);
    expect(EVAL_WATCH_TIMEOUT_SECONDS * 1000).toBe(MODAL_SANDBOX_TIMEOUT_MS - EVAL_POST_WATCH_MARGIN_MS);
    expect(EVAL_WATCH_TIMEOUT_SECONDS * 1000).toBeLessThan(MODAL_SANDBOX_TIMEOUT_MS);

    const runnerSource = fs.readFileSync(new URL("../src/runner.ts", import.meta.url), "utf8");
    const workerSource = fs.readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(runnerSource).toContain("timeoutMs: MODAL_SANDBOX_TIMEOUT_MS");
    expect(runnerSource).toContain(
      "latestRecovery === undefined || recoveryImageChanged || latestRecovery.image !== recoveryImage"
    );
    expect(runnerSource).toContain("record.image !== state.image");
    expect(runnerSource).toContain("lease.image !== state.image");
    expect(runnerSource).toContain("sandbox.terminate({ wait: true })");
    expect(workerSource).toMatch(/"--watch-timeout-seconds",\s*String\(EVAL_WATCH_TIMEOUT_SECONDS\)/u);
    expect(workerSource).toMatch(/CLI,\s*"status",\s*runId/u);
    expect(workerSource).toContain("WORKFLOW_STATUS_SYNC_TIMEOUT_MS");
    expect(workerSource).toContain('stdio: ["ignore", "pipe", "pipe"]');
    expect(workerSource).toContain("readLimitedStream");
    expect(workerSource).toContain("workflowSyncSummary");
    expect(workerSource).toContain("terminalDurableRunNeedsMoreWorkflowPolling");
    expect(workerSource).toContain('setStatus("waiting-judge"');
    expect(workerSource).toContain("EVAL_SCORE_TIMEOUT_MS");
    expect(workerSource).toContain("EVAL_PUBLISH_TIMEOUT_MS");
    expect(workerSource).toContain("EVAL_REPORT_TIMEOUT_MS");
    expect(workerSource).toContain("runCheckedWithRetry");
    expect(workerSource).toContain("publish_attempt");
    expect(workerSource).toContain("report_attempt");
    expect(workerSource).toContain('child.kill("SIGKILL")');
    expect(workerSource).toContain("recoverableNodeEntries");
    expect(workerSource).toContain("workflowArtifactsComplete");
    expect(workerSource).toContain("const RECOVERY_MAX_RESETS = 96");
    expect(workerSource).toContain("stale_running_node_count");
    expect(workerSource).toContain("recently_reset_node_count");
    expect(workerSource).toContain("waiting for reset propagation");
    expect(workerSource).toContain("RECOVERY_RESET_SETTLE_MS");
    expect(workerSource).toContain("resetNodeOnCooldown");
    expect(workerSource).toContain("armResetCooldown");
    expect(workerSource).toMatch(/waiting for reset propagation[^]+?await sleep\(RECOVERY_POLL_MS\);/su);
    expect(workerSource).toContain("CONFIG.node_timeout_seconds");
    expect(workerSource).toMatch(
      /await resumeWithResetCandidates\([^]+?\);\s+const cooldownUntil = armResetCooldown\(resetNode, resetCooldowns\);[^]+?continue;/su
    );
    expect(workerSource).toContain("configureGitSafeDirectories(target)");
    expect(workerSource).toContain('"safe.directory"');
  });

  it("maps only trusted /data children through the resolved Modal mount", () => {
    expect(resolvePersistentRemoteRoot("/data/run-1/model-1", "/resolved-volume")).toBe(
      "/resolved-volume/run-1/model-1"
    );
    expect(() => resolvePersistentRemoteRoot("/other/run-1", "/resolved-volume")).toThrow("must be a child of /data");
  });
});
