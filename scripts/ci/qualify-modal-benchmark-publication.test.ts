import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { qualifyModalBenchmarkPublication } from "./qualify-modal-benchmark-publication.mjs";

const roots: string[] = [];
const repository = "monad-developers/ultrafuzz";
const candidate = "a".repeat(40);
const runId = 123456;
const runAttempt = 2;
const successfulJobs = [
  {
    jobs: [
      { name: "launch", conclusion: "success" },
      { name: "collect", conclusion: "success" },
      { name: "monitor_full", conclusion: "skipped" }
    ]
  }
];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("trusted Modal benchmark publication qualification", () => {
  it("accepts a successful default-branch push as smoke", () => {
    expect(
      qualifyModalBenchmarkPublication(event({ event: "push" }), successfulJobs, artifacts("smoke"), repository)
    ).toEqual({
      eligible: true,
      candidateCommit: candidate,
      benchmarkMode: "smoke",
      reason: expect.any(String)
    });
  });

  it("accepts a successful manual run as full", () => {
    expect(
      qualifyModalBenchmarkPublication(
        event({ event: "workflow_dispatch" }),
        fullSuccessfulJobs(),
        artifacts("full"),
        repository
      )
    ).toEqual(expect.objectContaining({ eligible: true, candidateCommit: candidate, benchmarkMode: "full" }));
  });

  it("derives a dispatched smoke lane from artifacts rather than the trigger", () => {
    expect(
      qualifyModalBenchmarkPublication(
        event({ event: "workflow_dispatch" }),
        successfulJobs,
        artifacts("smoke"),
        repository
      )
    ).toEqual(expect.objectContaining({ eligible: true, candidateCommit: candidate, benchmarkMode: "smoke" }));
  });

  it("refuses threat-model artifacts from longitudinal publication", () => {
    for (const artifactSet of [
      artifacts("threat-model"),
      { artifacts: [...artifacts("full").artifacts, ...artifacts("threat-model").artifacts] },
      { artifacts: [...artifacts("full").artifacts, artifacts("threat-model").artifacts[0]] },
      { artifacts: [...artifacts("smoke").artifacts, artifacts("threat-model").artifacts[1]] }
    ]) {
      expect(
        qualifyModalBenchmarkPublication(event({ event: "workflow_dispatch" }), successfulJobs, artifactSet, repository)
      ).toEqual(expect.objectContaining({ eligible: false }));
    }
  });

  it("separates a deliberately excluded lane from an ambiguous one", () => {
    expect(
      qualifyModalBenchmarkPublication(
        event({ event: "workflow_dispatch" }),
        successfulJobs,
        artifacts("threat-model"),
        repository
      )
    ).toEqual({
      eligible: false,
      nonLongitudinalLane: "threat-model",
      reason:
        "the completed producer attempt ran the threat-model lane, which by design never publishes a longitudinal eval history row"
    });
    expect(
      qualifyModalBenchmarkPublication(
        event({ event: "workflow_dispatch" }),
        successfulJobs,
        { artifacts: [...artifacts("smoke").artifacts, ...artifacts("threat-model").artifacts] },
        repository
      )
    ).toEqual({
      eligible: false,
      reason: "the completed producer attempt does not have one unambiguous benchmark artifact lane"
    });
  });

  it("skips incomplete producers whose paid jobs did not both succeed", () => {
    const skippedJobs = [
      {
        jobs: [
          { name: "launch", conclusion: "skipped" },
          { name: "collect", conclusion: "skipped" },
          { name: "monitor_full", conclusion: "skipped" }
        ]
      }
    ];
    expect(
      qualifyModalBenchmarkPublication(event({ event: "push" }), skippedJobs, artifacts("smoke"), repository)
    ).toEqual(expect.objectContaining({ eligible: false }));
    expect(
      qualifyModalBenchmarkPublication(
        event({ event: "push" }),
        [
          {
            jobs: [
              { name: "launch", conclusion: "success" },
              { name: "collect", conclusion: "failure" },
              { name: "monitor_full", conclusion: "skipped" }
            ]
          }
        ],
        artifacts("smoke"),
        repository
      )
    ).toEqual(expect.objectContaining({ eligible: false }));
  });

  it("requires the staged monitor only for the full lane", () => {
    expect(
      qualifyModalBenchmarkPublication(
        event({ event: "workflow_dispatch" }),
        successfulJobs,
        artifacts("full"),
        repository
      )
    ).toEqual(expect.objectContaining({ eligible: false }));
    expect(
      qualifyModalBenchmarkPublication(event({ event: "push" }), fullSuccessfulJobs(), artifacts("smoke"), repository)
    ).toEqual(expect.objectContaining({ eligible: false }));
  });

  it("fails closed for a feature branch, wrong repository, workflow, event, conclusion, or run head", () => {
    const mutations = [
      { head_branch: "feature/untrusted-producer" },
      { head_repository: { full_name: "example/other" } },
      { path: ".github/workflows/other.yml" },
      { event: "schedule" },
      { event: "pull_request" },
      { conclusion: "failure" },
      { event: "push", head_sha: "not-a-commit" }
    ];
    for (const mutation of mutations) {
      expect(
        qualifyModalBenchmarkPublication(event(mutation), successfulJobs, artifacts("smoke"), repository),
        JSON.stringify(mutation)
      ).toEqual(expect.objectContaining({ eligible: false }));
    }
  });

  it("fails closed for missing, expired, ambiguous, or wrong-attempt artifacts", () => {
    const invalidArtifacts = [
      { artifacts: [] },
      artifacts("smoke", { expired: true }),
      { artifacts: [...artifacts("smoke").artifacts, ...artifacts("full").artifacts] },
      artifacts("smoke", { runAttempt: runAttempt + 1 })
    ];
    for (const artifactSet of invalidArtifacts) {
      expect(
        qualifyModalBenchmarkPublication(event({ event: "workflow_dispatch" }), successfulJobs, artifactSet, repository)
      ).toEqual(expect.objectContaining({ eligible: false }));
    }
  });

  it("annotates and summarizes a producer attempt that skips the whole publication job", () => {
    const run = qualify(event({ conclusion: "cancelled" }), { summary: true });

    expect(run.status).toBe(0);
    expect(run.output).toBe(
      "eligible=false\nskip_reason=the completed run is not an eligible default-branch benchmark producer\n"
    );
    expect(run.stdout).toContain(
      "::warning::eval history publication skipped: the completed run is not an eligible default-branch benchmark producer"
    );
    expect(run.stdout).toContain(
      "Published eval history does not advance until one complete Modal benchmark generation exists."
    );
    expect(run.stdout.split("\n").filter((line) => line.startsWith("::")).length).toBe(1);
    expect(run.summary).toContain("## Eval history publication skipped (unqualified producer attempt)");
    expect(run.summary).toContain("- Refusal: the completed run is not an eligible default-branch benchmark producer");
    expect(run.summary).toContain(
      "Published eval history does not advance until one complete Modal benchmark generation exists."
    );
  });

  it("summarizes a deliberately excluded lane without annotating it as a refusal", () => {
    const run = qualify(event({ event: "workflow_dispatch" }), {
      summary: true,
      artifacts: artifacts("threat-model")
    });

    expect(run.status).toBe(0);
    expect(run.output).toBe(
      "eligible=false\nskip_reason=the completed producer attempt ran the threat-model lane, which by design never publishes a longitudinal eval history row\n"
    );
    expect(run.stdout).not.toContain("::");
    expect(run.stdout).not.toContain("does not have one unambiguous benchmark artifact lane");
    expect(run.summary).toContain("## Eval history publication not applicable (threat-model lane)");
    expect(run.summary).toContain(
      "- Skipped: the completed producer attempt ran the threat-model lane, which by design never publishes a longitudinal eval history row"
    );
    expect(run.summary).not.toContain(
      "Published eval history does not advance until one complete Modal benchmark generation exists."
    );
  });

  it("leaves a qualified producer attempt unannotated and writes no job summary", () => {
    const run = qualify(event({ event: "push" }), { summary: true });

    expect(run.status).toBe(0);
    expect(run.output).toBe(`eligible=true\ncandidate_commit=${candidate}\nbenchmark_mode=smoke\n`);
    expect(run.stdout).not.toContain("::");
    expect(run.summary).toBeUndefined();
  });

  it("still annotates an unqualified producer outside GitHub Actions", () => {
    const run = qualify(event({ path: ".github/workflows/other.yml" }));

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("::warning::eval history publication skipped:");
    expect(run.summary).toBeUndefined();
  });

  it("strictly parses GitHub-owned event and REST envelopes before projecting fields", () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-github-envelope-"));
    try {
      const eventPath = path.join(root, "event.json");
      const jobsPath = path.join(root, "jobs.json");
      const artifactsPath = path.join(root, "artifacts.json");
      const outputPath = path.join(root, "github-output");
      const eventJson = JSON.stringify(event({ event: "push" }));
      fs.writeFileSync(
        eventPath,
        eventJson.replace('{"repository":', '{"repository":{"default_branch":"shadowed"},"repository":')
      );
      fs.writeFileSync(jobsPath, JSON.stringify(successfulJobs));
      fs.writeFileSync(artifactsPath, JSON.stringify(artifacts("smoke")));

      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/ci/qualify-modal-benchmark-publication.mjs"),
          eventPath,
          jobsPath,
          artifactsPath,
          outputPath,
          repository
        ],
        { cwd: path.resolve("."), encoding: "utf8" }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/strict JSON|duplicate/iu);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function qualify(eventValue: unknown, options: { summary?: boolean; artifacts?: unknown } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modal-publication-qualification-"));
  roots.push(root);
  const eventPath = path.join(root, "event.json");
  const jobsPath = path.join(root, "jobs.json");
  const artifactsPath = path.join(root, "artifacts.json");
  const outputPath = path.join(root, "github-output");
  const summaryPath = path.join(root, "github-step-summary");
  fs.writeFileSync(eventPath, JSON.stringify(eventValue));
  fs.writeFileSync(jobsPath, JSON.stringify(successfulJobs));
  fs.writeFileSync(artifactsPath, JSON.stringify(options.artifacts ?? artifacts("smoke")));
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  if (options.summary === true) env.GITHUB_STEP_SUMMARY = summaryPath;

  const result = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/ci/qualify-modal-benchmark-publication.mjs"),
      eventPath,
      jobsPath,
      artifactsPath,
      outputPath,
      repository
    ],
    { cwd: path.resolve("."), encoding: "utf8", env }
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : undefined,
    summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : undefined
  };
}

function fullSuccessfulJobs() {
  return [
    {
      jobs: [
        { name: "launch", conclusion: "success" },
        { name: "collect", conclusion: "success" },
        { name: "monitor_full", conclusion: "success" }
      ]
    }
  ];
}

function artifacts(
  mode: "smoke" | "full" | "threat-model",
  overrides: { expired?: boolean; runAttempt?: number } = {}
) {
  const attempt = overrides.runAttempt ?? runAttempt;
  const expired = overrides.expired ?? false;
  return {
    artifacts: ["modal-benchmark-launch", "modal-benchmark-control", "public-benchmark-results"].map((prefix) => ({
      name: `${prefix}-${mode}-${runId}-${attempt}`,
      expired
    }))
  };
}

function event(overrides: Record<string, unknown>) {
  return {
    repository: { default_branch: "main" },
    workflow_run: {
      conclusion: "success",
      event: "push",
      path: ".github/workflows/eval-benchmarks.yml",
      head_repository: { full_name: repository },
      head_branch: "main",
      head_sha: candidate,
      id: runId,
      run_attempt: runAttempt,
      ...overrides
    }
  };
}
