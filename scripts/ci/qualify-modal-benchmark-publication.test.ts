import { describe, expect, it } from "bun:test";

import { qualifyModalBenchmarkPublication } from "./qualify-modal-benchmark-publication.mjs";

const repository = "monad-developers/ultrafuzz";
const candidate = "a".repeat(40);
const currentPullRequestHead = "b".repeat(40);
const successfulJobs = [
  {
    jobs: [
      { name: "launch", conclusion: "success" },
      { name: "collect", conclusion: "success" }
    ]
  }
];

describe("trusted Modal benchmark publication qualification", () => {
  it("accepts a successful main push as smoke", () => {
    expect(
      qualifyModalBenchmarkPublication(event({ event: "push", head_branch: "main" }), successfulJobs, repository)
    ).toEqual({
      eligible: true,
      candidateCommit: candidate,
      benchmarkMode: "smoke",
      reason: expect.any(String)
    });
  });

  it("accepts a successful manual run as full", () => {
    expect(qualifyModalBenchmarkPublication(event({ event: "workflow_dispatch" }), successfulJobs, repository)).toEqual(
      expect.objectContaining({ eligible: true, candidateCommit: candidate, benchmarkMode: "full" })
    );
  });

  it("uses the immutable workflow-run head instead of the mutable PR association", () => {
    const pullRequestEvent = event({
      event: "pull_request",
      head_sha: candidate,
      pull_requests: [{ head: { sha: currentPullRequestHead } }]
    });
    expect(qualifyModalBenchmarkPublication(pullRequestEvent, successfulJobs, repository)).toEqual(
      expect.objectContaining({ eligible: true, candidateCommit: candidate, benchmarkMode: "smoke" })
    );
  });

  it("skips draft and incomplete producers whose paid jobs did not both succeed", () => {
    const draftJobs = [
      {
        jobs: [
          { name: "launch", conclusion: "skipped" },
          { name: "collect", conclusion: "skipped" }
        ]
      }
    ];
    expect(qualifyModalBenchmarkPublication(event({ event: "pull_request" }), draftJobs, repository)).toEqual(
      expect.objectContaining({ eligible: false })
    );
    expect(
      qualifyModalBenchmarkPublication(
        event({ event: "pull_request" }),
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

  it("fails closed for the wrong repository, workflow, event, branch, conclusion, or run head", () => {
    const mutations = [
      { head_repository: { full_name: "example/other" } },
      { path: ".github/workflows/other.yml" },
      { event: "schedule" },
      { event: "push", head_branch: "feature" },
      { conclusion: "failure" },
      { event: "pull_request", head_sha: "not-a-commit" }
    ];
    for (const mutation of mutations) {
      expect(
        qualifyModalBenchmarkPublication(event(mutation), successfulJobs, repository),
        JSON.stringify(mutation)
      ).toEqual(expect.objectContaining({ eligible: false }));
    }
  });
});

function event(overrides: Record<string, unknown>) {
  return {
    workflow_run: {
      conclusion: "success",
      event: "pull_request",
      path: ".github/workflows/eval-benchmarks.yml",
      head_repository: { full_name: repository },
      head_branch: "feature",
      head_sha: candidate,
      pull_requests: [{ head: { sha: candidate } }],
      ...overrides
    }
  };
}
