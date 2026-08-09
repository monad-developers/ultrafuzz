import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  assertGroundTruthSubject,
  canonicalRepositoryIdentity,
  parseGroundTruthDocument,
  readGroundTruthDocument
} from "../src/ground-truth.js";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const BUGS = [{ id: "H-1", title: "Example" }];
const AAVE_GROUND_TRUTH_PATH = fileURLToPath(
  new URL("../../../benchmarks/private-ground-truth/aave-v4-scfuzzbench/findings.yml", import.meta.url)
);
const AAVE_UPSTREAM_REPOSITORY = "https://github.com/aave/aave-v4";
const AAVE_SCFUZZBENCH_REPOSITORY = "https://github.com/scfuzzbench/aave-v4-scfuzzbench";
const AAVE_SCFUZZBENCH_REVISION = "edd6c82721512540c8c90e7a36a4a8e19fd7bdf3";

describe("private ground-truth subject binding", () => {
  it("accepts an exact repository and immutable revision match", () => {
    const document = parseGroundTruthDocument(
      {
        schema_version: "ultrafuzz.eval-ground-truth.v1",
        subject: { repository: "https://github.com/Example/Target.git/", revision: REVISION },
        bugs: BUGS
      },
      { requireSubject: true }
    );

    expect(document.subject).toEqual({ repository: "https://github.com/example/target", revision: REVISION });
    expect(
      assertGroundTruthSubject(document.subject, {
        repository: "https://github.com/example/target",
        revision: REVISION
      })
    ).toEqual(document.subject);
  });

  it("binds the checked-in Aave labels to their exact ScFuzzBench subject", () => {
    const document = readGroundTruthDocument(AAVE_GROUND_TRUTH_PATH, { requireSubject: true });
    const raw = parse(fs.readFileSync(AAVE_GROUND_TRUTH_PATH, "utf8")) as {
      source?: unknown;
      provenance?: Record<string, unknown>;
      canaries?: Array<Record<string, unknown>>;
    };

    expect(
      assertGroundTruthSubject(document.subject, {
        repository: AAVE_SCFUZZBENCH_REPOSITORY,
        revision: AAVE_SCFUZZBENCH_REVISION
      })
    ).toEqual({ repository: AAVE_SCFUZZBENCH_REPOSITORY, revision: AAVE_SCFUZZBENCH_REVISION });
    expect(document.bugs.map((bug) => bug.id)).toEqual([
      "total-borrowed-v0",
      "total-borrowed-v1",
      "total-borrowed-v2",
      "borrowed-shares-sum",
      "added-assets-spoke-sum",
      "added-shares-spoke-sum",
      "monotonic-index-price",
      "liquidation-liveness",
      "repay-liveness",
      "supply-liveness",
      "withdraw-liveness",
      "fee-share-pps"
    ]);
    expect(raw.canaries).toEqual([
      {
        id: "canary-assertion",
        benchmark_name: "assert_canary",
        title: "Harness canary assertion expected to fail"
      },
      {
        id: "canary-invariant",
        benchmark_name: "invariant_canary",
        title: "Harness canary invariant expected to fail"
      }
    ]);
    expect(raw).not.toHaveProperty("source");
    expect(raw.provenance).toMatchObject({
      benchmark_id: "a0a57a3e0b5b533094f20079e9a9b7ef",
      ultrafuzz_target_repo: AAVE_UPSTREAM_REPOSITORY,
      ultrafuzz_target_commit: "6959e3219b5506bf2acae18551cbb2a68a5b8fba",
      scfuzzbench_target_repo: AAVE_SCFUZZBENCH_REPOSITORY,
      scfuzzbench_target_commit: AAVE_SCFUZZBENCH_REVISION
    });

    expect(() =>
      assertGroundTruthSubject(document.subject, {
        repository: AAVE_UPSTREAM_REPOSITORY,
        revision: AAVE_SCFUZZBENCH_REVISION
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_GROUND_TRUTH_SUBJECT_REPOSITORY_MISMATCH" }));
    expect(() =>
      assertGroundTruthSubject(document.subject, {
        repository: AAVE_SCFUZZBENCH_REPOSITORY,
        revision: "f".repeat(40)
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_GROUND_TRUTH_SUBJECT_REVISION_MISMATCH" }));
  });

  it.each([
    [
      "revision drift",
      { repository: "https://github.com/example/target", revision: "f".repeat(40) },
      "EVAL_GROUND_TRUTH_SUBJECT_REVISION_MISMATCH"
    ],
    [
      "upstream versus fork",
      { repository: "https://github.com/example/target", revision: REVISION },
      "EVAL_GROUND_TRUTH_SUBJECT_REPOSITORY_MISMATCH"
    ],
    ["missing binding", undefined, "EVAL_GROUND_TRUTH_SUBJECT_MISSING"]
  ] as const)("rejects %s", (name, subject, code) => {
    expect(() =>
      assertGroundTruthSubject(subject, {
        repository: name === "revision drift" ? "https://github.com/example/target" : "https://github.com/example/fork",
        revision: REVISION
      })
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects competing identities instead of choosing one", () => {
    expect(() =>
      parseGroundTruthDocument(
        {
          schema_version: "ultrafuzz.eval-ground-truth.v1",
          subject: { repository: "https://github.com/example/fork", revision: REVISION },
          source: { repository: "https://github.com/example/target", revision: REVISION },
          bugs: BUGS
        },
        { requireSubject: true }
      )
    ).toThrowError(expect.objectContaining({ code: "EVAL_GROUND_TRUTH_SUBJECT_AMBIGUOUS" }));
  });

  it("keeps the storage repository independent from the bound target", () => {
    expect(canonicalRepositoryIdentity("https://github.com/example/ground-truth.git")).not.toBe(
      canonicalRepositoryIdentity("https://github.com/example/target")
    );
  });
});
