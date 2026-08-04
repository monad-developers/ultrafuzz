import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Modal benchmark scope workflow binding", () => {
  it("resolves only the exact DeepSeek Flash smoke marker for a manual smoke plan", () => {
    const valid = runRecoveryDiscovery({ event: "workflow_dispatch", mode: "smoke", markers: [deepseekMarker()] });
    expect(valid.status).toBe(0);
    expect(valid.githubEnv).toContain("BENCHMARK_MODE=smoke\n");
    expect(valid.githubEnv).toContain("EXPECTED_PROVIDER=deepseek\n");
    expect(valid.githubEnv).toContain("EXPECTED_MODEL=deepseek-v4-flash\n");
    expect(valid.githubEnv).toContain("EXPECTED_REASONING=max\n");
    expect(valid.githubOutput).toContain("benchmark_mode=smoke\n");

    for (const markers of [
      [],
      [{ name: "Benchmark scope deepseek-v4-flash-smoke", conclusion: "failure" }],
      [{ name: "Benchmark scope full", conclusion: "success" }],
      [{ name: "Benchmark scope push-smoke", conclusion: "success" }],
      [deepseekMarker(), deepseekMarker()],
      [deepseekMarker(), { name: "Benchmark scope unknown", conclusion: "failure" }],
      [deepseekMarker(), { name: "Benchmark scope full", conclusion: "skipped" }]
    ]) {
      const rejected = runRecoveryDiscovery({ event: "workflow_dispatch", mode: "smoke", markers });
      expect(rejected.status, JSON.stringify(markers)).not.toBe(0);
      expect(rejected.githubEnv).not.toContain("EXPECTED_PROVIDER=");
    }
  });

  it("preserves exact push-smoke and manual-full recovery identities", () => {
    const push = runRecoveryDiscovery({
      event: "push",
      mode: "smoke",
      markers: [{ name: "Benchmark scope push-smoke", conclusion: "success" }]
    });
    expect(push.status).toBe(0);
    expect(push.githubEnv).toContain("BENCHMARK_MODE=smoke\nEXPECTED_PROVIDER=openai\n");

    const full = runRecoveryDiscovery({
      event: "workflow_dispatch",
      mode: "full",
      markers: [{ name: "Benchmark scope full", conclusion: "success" }]
    });
    expect(full.status).toBe(0);
    expect(full.githubEnv).toContain("BENCHMARK_MODE=full\nEXPECTED_PROVIDER=\n");
  });

  it("rejects missing or duplicated launch jobs when an immutable plan exists", () => {
    for (const launchJobCount of [0, 2]) {
      const rejected = runRecoveryDiscovery({
        event: "workflow_dispatch",
        mode: "smoke",
        markers: [deepseekMarker()],
        launchJobCount
      });
      expect(rejected.status, String(launchJobCount)).not.toBe(0);
    }
  });

  it("passes the scope-bound expected provider into both cleanup paths", () => {
    const producer = parse(fs.readFileSync(path.resolve(".github/workflows/eval-benchmarks.yml"), "utf8")) as Workflow;
    const recovery = parse(
      fs.readFileSync(path.resolve(".github/workflows/eval-benchmark-recovery.yml"), "utf8")
    ) as Workflow;
    const producerValidation = stepRun(producer, "Validate incomplete-run cleanup paths");
    const producerLaunchValidation = stepRun(producer, "Validate Modal benchmark launch guardrails");
    expect(producerLaunchValidation).toContain("--expected-provider deepseek");
    expect(producerLaunchValidation).toContain("--expected-model deepseek-v4-flash");
    expect(producerLaunchValidation).toContain("--expected-reasoning max");
    expect(producerValidation).toContain("profile_args=(");
    expect(producerValidation).toContain("--expected-provider deepseek");
    expect(producerValidation).toContain("--expected-model deepseek-v4-flash");
    expect(producerValidation).toContain("--expected-reasoning max");
    expect(producerValidation).toContain("profile_args=(--expected-provider openai)");
    expect(producerValidation).toContain('"${profile_args[@]}"');

    const recoveryValidation = stepRun(recovery, "Validate incomplete-run identity and termination scopes");
    expect(recoveryValidation).toContain('profile_args=(--expected-provider "$EXPECTED_PROVIDER")');
    expect(recoveryValidation).toContain('--expected-model "$EXPECTED_MODEL"');
    expect(recoveryValidation).toContain('--expected-reasoning "$EXPECTED_REASONING"');
    expect(recoveryValidation).toContain('"${profile_args[@]}"');
  });
});

interface Workflow {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
}

function deepseekMarker() {
  return { name: "Benchmark scope deepseek-v4-flash-smoke", conclusion: "success" };
}

function stepRun(workflow: Workflow, name: string): string {
  for (const job of Object.values(workflow.jobs)) {
    const step = job.steps.find((candidate) => candidate.name === name);
    if (step?.run !== undefined) return step.run;
  }
  throw new Error(`missing workflow step ${name}`);
}

function runRecoveryDiscovery(input: {
  event: "push" | "workflow_dispatch";
  mode: "smoke" | "full";
  markers: Array<{ name: string; conclusion: string }>;
  launchJobCount?: number;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-recovery-scope-"));
  roots.push(root);
  const fakeBin = path.join(root, "bin");
  const artifactsPath = path.join(root, "artifacts.json");
  const jobsPath = path.join(root, "jobs.json");
  const githubEnv = path.join(root, "github-env");
  const githubOutput = path.join(root, "github-output");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    `#!/usr/bin/env bash
case "$*" in
  *'/artifacts?'*) cat "$TEST_ARTIFACT_INDEX" ;;
  *'/jobs?'*) cat "$TEST_JOB_INDEX" ;;
  *) exit 64 ;;
esac
`
  );
  fs.chmodSync(path.join(fakeBin, "gh"), 0o700);
  fs.writeFileSync(
    artifactsPath,
    JSON.stringify({
      artifacts: [
        {
          name: `modal-benchmark-plan-${input.mode}-12345-2`,
          expired: false
        }
      ]
    })
  );
  fs.writeFileSync(
    jobsPath,
    JSON.stringify({
      jobs: Array.from({ length: input.launchJobCount ?? 1 }, () => ({
        name: "launch",
        conclusion: "failure",
        steps: input.markers
      }))
    })
  );
  fs.writeFileSync(githubEnv, "");
  fs.writeFileSync(githubOutput, "");

  const workflow = parse(
    fs.readFileSync(path.resolve(".github/workflows/eval-benchmark-recovery.yml"), "utf8")
  ) as Workflow;
  const result = spawnSync(
    "bash",
    ["-euo", "pipefail", "-c", stepRun(workflow, "Discover the exact pre-compute benchmark plan")],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
        GITHUB_REPOSITORY: "monad-developers/ultrafuzz",
        GITHUB_ENV: githubEnv,
        GITHUB_OUTPUT: githubOutput,
        SOURCE_RUN_ID: "12345",
        SOURCE_RUN_ATTEMPT: "2",
        SOURCE_EVENT: input.event,
        TEST_ARTIFACT_INDEX: artifactsPath,
        TEST_JOB_INDEX: jobsPath
      }
    }
  );
  return {
    status: result.status,
    githubEnv: fs.readFileSync(githubEnv, "utf8"),
    githubOutput: fs.readFileSync(githubOutput, "utf8"),
    stderr: result.stderr
  };
}
