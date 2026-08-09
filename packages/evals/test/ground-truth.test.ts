import { describe, expect, it } from "vitest";

import {
  assertGroundTruthSubject,
  canonicalRepositoryIdentity,
  parseGroundTruthDocument
} from "../src/ground-truth.js";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const BUGS = [{ id: "H-1", title: "Example" }];

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
