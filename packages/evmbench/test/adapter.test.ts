import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyEvmbenchProfile,
  capEvmbenchTopologyTimeouts,
  copyFinalMarkdown,
  runEvmbenchAdapter,
  seedSmithersDependencies
} from "../src/adapter.js";
import type { EvmbenchStatusVerdict } from "../src/cli-contracts.js";
import { EVMBENCH_PROFILE_VERSION, type EvmbenchProfile } from "../src/contracts.js";

const temporaryDirectories: string[] = [];
const profile: EvmbenchProfile = {
  schema_version: EVMBENCH_PROFILE_VERSION,
  id: "smoke",
  max_concurrency: 2,
  poll_interval_seconds: 1,
  workflow_timeout_seconds: 60,
  node_timeout_seconds: 30,
  model: "synthetic-model",
  reasoning: "high"
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("EVMBench adapter", () => {
  it("applies the named profile without duplicating config logic", () => {
    const root = temporaryDirectory();
    const configPath = path.join(root, "ultrafuzz.toml");
    fs.writeFileSync(configPath, baseConfig(), "utf8");
    applyEvmbenchProfile(configPath, profile);
    const updated = fs.readFileSync(configPath, "utf8");

    expect(updated).toContain("max_parallel_agents = 2");
    expect(updated).toContain('model = "synthetic-model"');
    expect(updated).toContain('reasoning = "high"');
    expect(updated).toContain('auth = "subscription"');
  });

  it("caps explicit topology timeouts at the named profile limit", () => {
    const root = temporaryDirectory();
    const topologyPath = path.join(root, "topology.yml");
    fs.writeFileSync(
      topologyPath,
      [
        "groups:",
        "  strategies:",
        "    defaults:",
        "      timeout_seconds: 7200",
        "nodes:",
        "  - id: reference",
        "    timeout_seconds: 300",
        ""
      ].join("\n"),
      "utf8"
    );

    capEvmbenchTopologyTimeouts(topologyPath, 900);

    expect(fs.readFileSync(topologyPath, "utf8")).toContain("timeout_seconds: 900");
    expect(fs.readFileSync(topologyPath, "utf8")).toContain("timeout_seconds: 300");
  });

  it("waits for completion and copies only the non-empty final Markdown", async () => {
    const root = temporaryDirectory();
    const auditRoot = path.join(root, "audit");
    const submissionRoot = path.join(root, "submission");
    const profilePath = path.join(root, "profile.json");
    const reportPath = path.join(root, "report.md");
    const dependencySeedPath = path.join(root, "seed-node-modules");
    fs.mkdirSync(auditRoot);
    fs.mkdirSync(path.join(auditRoot, ".ultrafuzz"));
    fs.mkdirSync(path.join(dependencySeedPath, "synthetic-package"), { recursive: true });
    fs.writeFileSync(path.join(auditRoot, "ultrafuzz.toml"), baseConfig(), "utf8");
    fs.writeFileSync(path.join(auditRoot, ".ultrafuzz", "topology.yml"), "version: 2\n", "utf8");
    fs.writeFileSync(
      path.join(dependencySeedPath, "synthetic-package", "package.json"),
      '{"name":"synthetic-package"}\n',
      "utf8"
    );
    fs.writeFileSync(profilePath, JSON.stringify(profile), "utf8");
    fs.writeFileSync(reportPath, "# Synthetic report\n", "utf8");
    let statusCalls = 0;
    const invocations: string[][] = [];

    await runEvmbenchAdapter({
      auditRoot,
      submissionRoot,
      profilePath,
      cliPath: "unused",
      dependencySeedPath,
      wait: async () => undefined,
      execute: (args) => {
        invocations.push(args);
        const command = args[0];
        if (command === "status") {
          statusCalls += 1;
          return success("status", statusData(statusCalls === 1 ? "progressing" : "done"));
        }
        if (command === "report") return success("report", reportData(reportPath));
        return defaultSuccess(command, auditRoot);
      }
    });

    expect(fs.readdirSync(submissionRoot)).toEqual(["audit.md"]);
    expect(invocations).toContainEqual(["init", "--project", auditRoot, "--force", "--json"]);
    expect(fs.readFileSync(path.join(submissionRoot, "audit.md"), "utf8")).toBe("# Synthetic report\n");
    expect(
      fs.readFileSync(path.join(auditRoot, ".smithers", "node_modules", "synthetic-package", "package.json"), "utf8")
    ).toBe('{"name":"synthetic-package"}\n');
  });

  it("rejects a symlinked dependency seed", () => {
    const root = temporaryDirectory();
    const seed = path.join(root, "seed");
    const link = path.join(root, "seed-link");
    fs.mkdirSync(seed);
    fs.symlinkSync(seed, link);

    expect(() => seedSmithersDependencies(path.join(root, "audit"), link)).toThrow(
      "Smithers dependency seed must be a regular directory"
    );
  });

  it("rejects empty and symlinked reports", () => {
    const root = temporaryDirectory();
    const empty = path.join(root, "empty.md");
    const link = path.join(root, "link.md");
    fs.writeFileSync(empty, "  \n", "utf8");
    fs.symlinkSync(empty, link);

    expect(() => copyFinalMarkdown({ reportPath: empty, submissionRoot: path.join(root, "submission-a") })).toThrow(
      "final report is empty"
    );
    expect(() => copyFinalMarkdown({ reportPath: link, submissionRoot: path.join(root, "submission-b") })).toThrow(
      "final report must be a regular file"
    );
  });

  it("rejects a symlinked submission directory", () => {
    const root = temporaryDirectory();
    const reportPath = path.join(root, "report.md");
    const outside = path.join(root, "outside");
    const submissionRoot = path.join(root, "submission");
    fs.writeFileSync(reportPath, "# Synthetic report\n", "utf8");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, submissionRoot);

    expect(() => copyFinalMarkdown({ reportPath, submissionRoot })).toThrow(
      "submission root must be a regular directory"
    );
    expect(fs.existsSync(path.join(outside, "audit.md"))).toBe(false);
  });

  it.each([
    ["blocked", "waiting for approval"],
    ["paused", "operator paused the run"]
  ])("fails immediately when an unattended run is %s", async (verdict, reason) => {
    const fixture = adapterFixture();

    await expect(
      runEvmbenchAdapter({
        ...fixture,
        wait: async () => {
          throw new Error("adapter should not wait");
        },
        execute: (args) =>
          args[0] === "status"
            ? success("status", statusData(verdict as "blocked" | "paused", reason))
            : defaultSuccess(args[0], fixture.auditRoot)
      })
    ).rejects.toThrow(`cannot complete unattended while ${verdict}: ${reason}`);
  });

  it("treats a degraded run as terminal non-success without waiting", async () => {
    const fixture = adapterFixture();

    await expect(
      runEvmbenchAdapter({
        ...fixture,
        wait: async () => {
          throw new Error("adapter should not wait");
        },
        execute: (args) =>
          args[0] === "status"
            ? success("status", statusData("degraded", "review loop exhausted before convergence"))
            : defaultSuccess(args[0], fixture.auditRoot)
      })
    ).rejects.toThrow(
      "ended degraded without converging: review loop exhausted before convergence; explicit operator review is required"
    );
  });

  it("does not auto-resume an existing degraded run", async () => {
    const fixture = adapterFixture();
    fs.mkdirSync(path.join(fixture.auditRoot, ".ultrafuzz", "runs", "evmbench-smoke"), { recursive: true });
    const invocations: string[][] = [];

    await expect(
      runEvmbenchAdapter({
        ...fixture,
        execute: (args) => {
          invocations.push(args);
          return args[0] === "status"
            ? success("status", statusData("degraded", "maximum iterations reached"))
            : defaultSuccess(args[0], fixture.auditRoot);
        }
      })
    ).rejects.toThrow("ended degraded without converging: maximum iterations reached");
    expect(invocations.some(([command]) => command === "resume")).toBe(false);
  });

  it.each(["orphaned", "cancel-pending"] as const)("does not auto-resume an existing %s run", async (verdict) => {
    const fixture = adapterFixture();
    fs.mkdirSync(path.join(fixture.auditRoot, ".ultrafuzz", "runs", "evmbench-smoke"), { recursive: true });
    const invocations: string[][] = [];

    await expect(
      runEvmbenchAdapter({
        ...fixture,
        execute: (args) => {
          invocations.push(args);
          return args[0] === "status"
            ? success("status", statusData(verdict, `run is ${verdict}`))
            : defaultSuccess(args[0], fixture.auditRoot);
        }
      })
    ).rejects.toThrow(`ended with ${verdict}`);
    expect(invocations.some(([command]) => command === "resume")).toBe(false);
  });

  it("rejects malformed and unknown status verdicts", async () => {
    const missing = adapterFixture();
    await expect(
      runEvmbenchAdapter({
        ...missing,
        execute: (args) =>
          args[0] === "status"
            ? success("status", { ...statusData("progressing"), verdict: undefined })
            : defaultSuccess(args[0], missing.auditRoot)
      })
    ).rejects.toThrow("verdict");

    const unknown = adapterFixture();
    await expect(
      runEvmbenchAdapter({
        ...unknown,
        execute: (args) =>
          args[0] === "status"
            ? success("status", { ...statusData("progressing"), verdict: "synthetic-status" })
            : defaultSuccess(args[0], unknown.auditRoot)
      })
    ).rejects.toThrow("verdict");
  });

  it("rejects legacy, mislabeled, and open-ended CLI envelopes", async () => {
    const legacy = adapterFixture();
    await expect(
      runEvmbenchAdapter({
        ...legacy,
        execute: (args) =>
          args[0] === "init"
            ? { ok: true, data: initData(legacy.auditRoot) }
            : defaultSuccess(args[0], legacy.auditRoot)
      })
    ).rejects.toThrow("schema_version");

    const mislabeled = adapterFixture();
    await expect(
      runEvmbenchAdapter({
        ...mislabeled,
        execute: (args) =>
          args[0] === "init"
            ? defaultSuccess("run", mislabeled.auditRoot)
            : defaultSuccess(args[0], mislabeled.auditRoot)
      })
    ).rejects.toThrow("command");

    const openEnded = adapterFixture();
    await expect(
      runEvmbenchAdapter({
        ...openEnded,
        execute: (args) =>
          args[0] === "init"
            ? success("init", { ...initData(openEnded.auditRoot), legacy_fallback: true })
            : defaultSuccess(args[0], openEnded.auditRoot)
      })
    ).rejects.toThrow("must NOT have additional properties");
  });
});

function baseConfig(): string {
  return [
    "[run]",
    'output_dir = ".ultrafuzz/runs"',
    "max_parallel_agents = 4",
    "max_parallel_nodes = 8",
    "default_timeout_seconds = 1800",
    "workflow_deadline_seconds = 86400",
    "",
    "[models.default]",
    'agent = "CodexAgent"',
    'model = "default-model"',
    'reasoning = "xhigh"',
    "",
    "[agents.CodexAgent]",
    'auth = "subscription"',
    "",
    "[permissions]",
    'trust_model = "skip-permissions"',
    ""
  ].join("\n");
}

function success(command: string, data: Record<string, unknown>): unknown {
  return {
    schema_version: "ultrafuzz.cli.result.v2",
    command,
    ok: true,
    diagnostics: [],
    data
  };
}

function defaultSuccess(command: string | undefined, auditRoot: string): unknown {
  if (command === "init") return success(command, initData(auditRoot));
  if (command === "run") {
    return success(command, {
      run_id: "evmbench-smoke",
      run_root: path.join(auditRoot, ".ultrafuzz", "runs", "evmbench-smoke"),
      status: "running",
      graph_fingerprint: "a".repeat(64),
      config_fingerprint: "b".repeat(64),
      workflow_ids: ["evmbench-smoke"]
    });
  }
  if (command === "resume") {
    return success(command, {
      run_id: "evmbench-smoke",
      workflow_run_id: "evmbench-smoke",
      workflow_path: path.join(auditRoot, ".ultrafuzz", "runs", "evmbench-smoke", "workflow.ts"),
      action: "resume",
      submitted: true
    });
  }
  throw new Error(`unexpected synthetic command: ${command ?? "missing"}`);
}

function initData(auditRoot: string): Record<string, unknown> {
  return { project_root: auditRoot, created: [], preserved: [], overwritten: [] };
}

function reportData(markdownPath: string): Record<string, unknown> {
  return {
    markdown_path: markdownPath,
    json_path: path.join(path.dirname(markdownPath), "report.json"),
    source: "verified-agent-report"
  };
}

function statusData(verdict: EvmbenchStatusVerdict, reason = "synthetic status"): Record<string, unknown> {
  const terminal = new Set(["done", "degraded", "blocked", "paused", "cancelled", "failed"]).has(verdict);
  return {
    run_id: "evmbench-smoke",
    run_root: "/synthetic/.ultrafuzz/runs/evmbench-smoke",
    status: verdict === "done" ? "succeeded" : "running",
    workflow_ids: ["evmbench-smoke"],
    workflow_run_id: "evmbench-smoke",
    workflow_status: verdict === "done" ? "succeeded" : "running",
    verdict,
    reason,
    counts: {
      finished: verdict === "done" ? 1 : 0,
      in_progress: terminal ? 0 : 1,
      pending: 0,
      failed: verdict === "failed" ? 1 : 0,
      waiting_approval: verdict === "blocked" ? 1 : 0,
      waiting_event: 0,
      waiting_timer: 0,
      skipped: 0,
      other: 0,
      total: 1
    },
    model_mix: [{ engine: "codex", model: "synthetic-model", attempts: 1, quota_parked: false }],
    throughput: { recent_finished: 0, window_ms: 60_000, total_finished: 0, last_finished_at_ms: null },
    progress: {
      percent: verdict === "done" ? 100 : 0,
      finished: verdict === "done" ? 1 : 0,
      in_progress: terminal ? 0 : 1,
      pending: 0,
      failed: verdict === "failed" ? 1 : 0,
      skipped: 0,
      remaining: verdict === "done" ? 0 : 1,
      total: 1
    },
    eta: terminal
      ? { available: false, seconds: null, basis: null, unavailable_reason: "run-terminal" }
      : { available: true, seconds: 10, basis: "run-throughput", unavailable_reason: null },
    current_step: {
      node_id: terminal ? null : "review",
      iteration: terminal ? null : 0,
      started_at: terminal ? null : "2026-08-09T00:00:00.000Z",
      elapsed_seconds: terminal ? null : 1,
      running_count: terminal ? 0 : 1
    },
    gating: [],
    gating_omitted: 0,
    quota: null,
    generated_at_ms: 1
  };
}

function adapterFixture(): Omit<Parameters<typeof runEvmbenchAdapter>[0], "execute"> {
  const root = temporaryDirectory();
  const auditRoot = path.join(root, "audit");
  const submissionRoot = path.join(root, "submission");
  const profilePath = path.join(root, "profile.json");
  const dependencySeedPath = path.join(root, "seed-node-modules");
  fs.mkdirSync(auditRoot);
  fs.mkdirSync(dependencySeedPath);
  fs.mkdirSync(path.join(auditRoot, ".ultrafuzz"));
  fs.writeFileSync(path.join(auditRoot, "ultrafuzz.toml"), baseConfig(), "utf8");
  fs.writeFileSync(path.join(auditRoot, ".ultrafuzz", "topology.yml"), "version: 2\n", "utf8");
  fs.writeFileSync(profilePath, JSON.stringify(profile), "utf8");
  return { auditRoot, submissionRoot, profilePath, cliPath: "unused", dependencySeedPath };
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-evmbench-adapter-"));
  temporaryDirectories.push(directory);
  return directory;
}
