import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { qualifyModalBenchmarkPublication } from "./qualify-modal-benchmark-publication.mjs";

const repository = "monad-developers/ultrafuzz";
const candidate = "a".repeat(40);
function successfulJobs(scope = "push-smoke") {
  return [
    {
      jobs: [
        {
          name: "launch",
          conclusion: "success",
          steps: [{ name: `Benchmark scope ${scope}`, conclusion: "success" }]
        },
        { name: "collect", conclusion: "success" }
      ]
    }
  ];
}

describe("trusted Modal benchmark publication qualification", () => {
  it("accepts a successful default-branch push as smoke", () => {
    expect(qualifyModalBenchmarkPublication(event({ event: "push" }), successfulJobs(), repository)).toEqual({
      eligible: true,
      candidateCommit: candidate,
      benchmarkMode: "smoke",
      expectedProvider: "openai",
      reason: expect.any(String)
    });
  });

  it("accepts a successful manual run as full", () => {
    expect(
      qualifyModalBenchmarkPublication(event({ event: "workflow_dispatch" }), successfulJobs("full"), repository)
    ).toEqual({
      eligible: true,
      candidateCommit: candidate,
      benchmarkMode: "full",
      reason: expect.any(String)
    });
  });

  it("accepts the fixed manual DeepSeek Flash profile as a single-provider smoke", () => {
    expect(
      qualifyModalBenchmarkPublication(
        event({ event: "workflow_dispatch" }),
        successfulJobs("deepseek-v4-flash-smoke"),
        repository
      )
    ).toEqual({
      eligible: true,
      candidateCommit: candidate,
      benchmarkMode: "smoke",
      expectedProvider: "deepseek",
      expectedModel: "deepseek-v4-flash",
      expectedReasoning: "max",
      reason: expect.any(String)
    });
  });

  it("writes the DeepSeek smoke mode and expected provider as workflow outputs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-qualification-"));
    try {
      const eventPath = path.join(root, "event.json");
      const jobsPath = path.join(root, "jobs.json");
      const outputPath = path.join(root, "github-output");
      fs.writeFileSync(eventPath, JSON.stringify(event({ event: "workflow_dispatch" })));
      fs.writeFileSync(jobsPath, JSON.stringify(successfulJobs("deepseek-v4-flash-smoke")));
      execFileSync(
        process.execPath,
        [
          path.resolve("scripts/ci/qualify-modal-benchmark-publication.mjs"),
          eventPath,
          jobsPath,
          outputPath,
          repository
        ],
        { cwd: path.resolve("."), encoding: "utf8" }
      );
      expect(fs.readFileSync(outputPath, "utf8")).toBe(
        `eligible=true\ncandidate_commit=${candidate}\nbenchmark_mode=smoke\nexpected_provider=deepseek\nexpected_model=deepseek-v4-flash\nexpected_reasoning=max\n`
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips incomplete producers whose paid jobs did not both succeed", () => {
    const skippedJobs = [
      {
        jobs: [
          { name: "launch", conclusion: "skipped" },
          { name: "collect", conclusion: "skipped" }
        ]
      }
    ];
    expect(qualifyModalBenchmarkPublication(event({ event: "push" }), skippedJobs, repository)).toEqual(
      expect.objectContaining({ eligible: false })
    );
    expect(
      qualifyModalBenchmarkPublication(
        event({ event: "push" }),
        [
          {
            jobs: [
              { name: "launch", conclusion: "success" },
              { name: "collect", conclusion: "failure" }
            ]
          }
        ],
        repository
      )
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
        qualifyModalBenchmarkPublication(event(mutation), successfulJobs(), repository),
        JSON.stringify(mutation)
      ).toEqual(expect.objectContaining({ eligible: false }));
    }
  });

  it("fails closed for a missing, failed, duplicated, unknown, or event-incompatible scope marker", () => {
    const mutations = [
      [],
      [{ name: "Benchmark scope push-smoke", conclusion: "failure" }],
      [
        { name: "Benchmark scope push-smoke", conclusion: "success" },
        { name: "Benchmark scope push-smoke", conclusion: "success" }
      ],
      [{ name: "Benchmark scope other", conclusion: "success" }],
      [{ name: "Benchmark scope full", conclusion: "success" }]
    ];
    for (const steps of mutations) {
      const jobs = successfulJobs();
      jobs[0]!.jobs[0]!.steps = steps;
      expect(qualifyModalBenchmarkPublication(event({ event: "push" }), jobs, repository)).toEqual(
        expect.objectContaining({ eligible: false })
      );
    }
  });
});

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
      ...overrides
    }
  };
}
