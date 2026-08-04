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
  it("fail-closes every manual-dispatch checkout on one explicit exact candidate", () => {
    const producer = parse(fs.readFileSync(path.resolve(".github/workflows/eval-benchmarks.yml"), "utf8")) as Workflow;
    expect(producer.on?.workflow_dispatch?.inputs?.expected_candidate).toMatchObject({
      required: true,
      type: "string"
    });

    const bindings = Object.entries(producer.jobs).map(([jobName, job]) => {
      const checkoutIndex = job.steps.findIndex((step) => step.with?.ref === "${{ env.BENCHMARK_CANDIDATE }}");
      const bindingIndex = job.steps.findIndex(
        (step) => step.name === "Bind the manual dispatch to the exact benchmark candidate"
      );
      if (bindingIndex < 0) return undefined;
      expect(bindingIndex, `${jobName} binding order`).toBe(checkoutIndex + 1);
      const binding = job.steps[bindingIndex]!;
      expect(binding.if, `${jobName} push isolation`).toContain("github.event_name == 'workflow_dispatch'");
      expect(binding.env).toEqual({
        EXPECTED_CANDIDATE: "${{ inputs.expected_candidate }}",
        EVENT_CANDIDATE: "${{ github.sha }}"
      });
      return binding.run;
    });
    expect(bindings.filter((run) => run !== undefined)).toHaveLength(3);
    const scripts = new Set(bindings.filter((run): run is string => run !== undefined));
    expect(scripts.size).toBe(1);
    const bindingScript = [...scripts][0]!;

    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve("."), encoding: "utf8" });
    expect(head.status).toBe(0);
    const candidate = head.stdout.trim();
    const differentCandidate = candidate === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
    const runBinding = (expectedCandidate: string, eventCandidate: string) =>
      spawnSync("bash", ["-c", bindingScript], {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          EXPECTED_CANDIDATE: expectedCandidate,
          EVENT_CANDIDATE: eventCandidate
        }
      });

    expect(runBinding(candidate, candidate).status).toBe(0);
    for (const [expectedCandidate, eventCandidate] of [
      [candidate.slice(0, -1), candidate],
      ["A".repeat(40), candidate],
      ["g".repeat(40), candidate],
      [`${candidate} `, candidate],
      [candidate, differentCandidate],
      [differentCandidate, differentCandidate]
    ]) {
      expect(runBinding(expectedCandidate!, eventCandidate!).status).not.toBe(0);
    }
  });

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

  it("moves publisher authority onto a fresh runner after an exact sealed handoff", () => {
    const publication = parse(
      fs.readFileSync(path.resolve(".github/workflows/eval-history-publication.yml"), "utf8")
    ) as Workflow;
    const preparation = publication.jobs.publish_modal_benchmark!;
    const publicationJob = publication.jobs.publish_validated_modal_benchmark!;
    expect(publicationJob.needs).toEqual(["qualify_modal_benchmark", "publish_modal_benchmark"]);
    expect(preparation.permissions).toEqual({ actions: "read", contents: "read" });
    expect(publicationJob.permissions).toEqual({ actions: "read", contents: "read" });
    expect(preparation.outputs).toMatchObject({
      generation_sha256: "${{ steps.prepare_publication.outputs.generation_sha256 }}",
      handoff_artifact_id: "${{ steps.upload_publication_handoff.outputs.artifact-id }}"
    });

    const prepareIndex = stepIndex(preparation, "Validate the atomic Modal benchmark generation");
    const unpackIndex = stepIndex(preparation, "Unpack the digest-bound Modal benchmark generation");
    const handoffLayoutIndex = stepIndex(preparation, "Validate the exact publication handoff layout");
    const uploadIndex = stepIndex(preparation, "Upload the sealed publication handoff");
    expect(unpackIndex).toBeGreaterThan(prepareIndex);
    expect(handoffLayoutIndex).toBeGreaterThan(unpackIndex);
    expect(uploadIndex).toBeGreaterThan(handoffLayoutIndex);
    const preparationText = JSON.stringify(preparation);
    expect(preparationText).not.toContain("create-github-app-token");
    expect(preparationText).not.toContain("EVAL_HISTORY_APP_PRIVATE_KEY");
    expect(preparationText).not.toContain("PUBLISHER_TOKEN");
    expect(preparationText).not.toContain("permission-contents");

    const prepare = preparation.steps[prepareIndex]?.run ?? "";
    expect(prepare).toContain("prepare-eval-history-publication.mjs automatic");
    expect(prepare).toContain("generation_sha256=");
    expect(prepare).toContain('>> "$GITHUB_OUTPUT"');
    expect(prepare).not.toContain("unpack-public");
    expect(prepare).not.toContain("verify-unpacked");

    const unpack = preparation.steps[unpackIndex]?.run ?? "";
    expect(unpack).toContain("verify-bundle");
    expect(unpack).toContain("unpack-public");
    expect(unpack).toContain("verify-unpacked");
    expect(unpack).not.toContain("GITHUB_OUTPUT");
    const upload = preparation.steps[uploadIndex]!;
    expect(upload.uses).toContain("actions/upload-artifact@");
    expect(upload.with).toMatchObject({
      name: "eval-history-publication-handoff-${{ github.run_id }}-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/eval-history-publication-handoff",
      "if-no-files-found": "error",
      "include-hidden-files": true,
      overwrite: false,
      "retention-days": 1
    });

    const freshCheckoutIndex = stepIndex(publicationJob, "Check out fresh trusted main publication tooling");
    const freshBuildIndex = stepIndex(publicationJob, "Install and build fresh trusted main");
    const downloadIndex = stepIndex(publicationJob, "Download the exact sealed publication handoff");
    const validateIndex = stepIndex(publicationJob, "Validate the sealed publication handoff before token creation");
    const driftIndex = stepIndex(publicationJob, "Verify fresh tooling, candidate policy, and main reachability");
    const tokenIndex = stepIndex(publicationJob, "Create the narrowly scoped eval-history publisher token");
    const publishIndex = stepIndex(
      publicationJob,
      "Publish the validated generation with remote-tip compare-and-swap retries"
    );
    expect(freshBuildIndex).toBeGreaterThan(freshCheckoutIndex);
    expect(downloadIndex).toBeGreaterThan(freshBuildIndex);
    expect(validateIndex).toBeGreaterThan(downloadIndex);
    expect(driftIndex).toBeGreaterThan(validateIndex);
    expect(tokenIndex).toBeGreaterThan(driftIndex);
    expect(publishIndex).toBeGreaterThan(tokenIndex);
    const download = publicationJob.steps[downloadIndex]!;
    expect(download.with).toMatchObject({
      "artifact-ids": "${{ needs.publish_modal_benchmark.outputs.handoff_artifact_id }}",
      path: "${{ runner.temp }}/eval-history-publication-handoff"
    });
    const validate = publicationJob.steps[validateIndex]?.run ?? "";
    expect(validate).toContain("publish-eval-history-cas.mjs validate-handoff");
    expect(validate).toContain('"$EXPECTED_GENERATION_SHA256"');
    expect(validate).toContain('"$CANDIDATE_COMMIT"');
    expect(validate).toContain('"$EXPECTED_REPOSITORY_URL"');
    const publish = publicationJob.steps[publishIndex]!;
    expect(publish.env).toMatchObject({
      PUBLISHER_TOKEN: "${{ steps.publisher-token.outputs.token }}",
      EXPECTED_GENERATION_SHA256: "${{ needs.publish_modal_benchmark.outputs.generation_sha256 }}"
    });
    expect(publish.run).not.toContain("GIT_CONFIG_");
    expect(publish.run).not.toContain("AUTHORIZATION:");
    expect(publish.run).not.toContain("base64");
    expect(JSON.stringify(publicationJob)).not.toContain("unpack-public");
  });
});

interface Workflow {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean; type?: string }>;
    };
  };
  jobs: Record<string, WorkflowJob>;
}

interface WorkflowJob {
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
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

function stepIndex(job: WorkflowJob, name: string): number {
  const index = job.steps.findIndex((step) => step.name === name);
  if (index < 0) throw new Error(`missing workflow step ${name}`);
  return index;
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
