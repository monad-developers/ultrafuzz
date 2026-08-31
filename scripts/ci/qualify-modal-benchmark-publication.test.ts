import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { qualifyModalBenchmarkPublication } from "./qualify-modal-benchmark-publication.mjs";

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

function artifacts(mode: "smoke" | "full", overrides: { expired?: boolean; runAttempt?: number } = {}) {
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
