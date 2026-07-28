import { describe, expect, it } from "bun:test";

import { qualifyModalBenchmarkPublication } from "./qualify-modal-benchmark-publication.mjs";

const repository = "monad-developers/ultrafuzz";
const candidate = "a".repeat(40);
const successfulJobs = [
  {
    jobs: [
      { name: "launch", conclusion: "success" },
      { name: "collect", conclusion: "success" }
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
        successfulJobs,
        artifacts("full"),
        repository
      )
    ).toEqual(expect.objectContaining({ eligible: true, candidateCommit: candidate, benchmarkMode: "full" }));
  });

  it("classifies a manual cloud-node acceptance run from its immutable smoke plan", () => {
    expect(
      qualifyModalBenchmarkPublication(
        event({ event: "workflow_dispatch" }),
        successfulJobs,
        artifacts("smoke"),
        repository
      )
    ).toEqual(expect.objectContaining({ eligible: true, candidateCommit: candidate, benchmarkMode: "smoke" }));
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
              { name: "collect", conclusion: "failure" }
            ]
          }
        ],
        artifacts("smoke"),
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
        qualifyModalBenchmarkPublication(event(mutation), successfulJobs, artifacts("smoke"), repository),
        JSON.stringify(mutation)
      ).toEqual(expect.objectContaining({ eligible: false }));
    }
  });

  it("fails closed when the exact plan lane is missing, duplicated, expired, or ambiguous", () => {
    const invalidArtifacts = [
      [],
      [...artifacts("smoke"), ...artifacts("full")],
      [...artifacts("smoke"), { ...artifacts("smoke")[0] }],
      artifacts("smoke").map((artifact, index) => (index === 0 ? { ...artifact, expired: true } : artifact))
    ];
    for (const value of invalidArtifacts) {
      expect(
        qualifyModalBenchmarkPublication(event({ event: "workflow_dispatch" }), successfulJobs, value, repository)
      ).toEqual(expect.objectContaining({ eligible: false }));
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
      id: 12345,
      run_attempt: 2,
      ...overrides
    }
  };
}

function artifacts(mode: "smoke" | "full") {
  return [
    { name: `modal-benchmark-plan-${mode}-12345-2`, expired: false },
    { name: `modal-benchmark-launch-${mode}-12345-2`, expired: false },
    { name: `public-benchmark-results-${mode}-12345-2`, expired: false }
  ];
}
