import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  assertGroundTruthSubject,
  canonicalRepositoryIdentity,
  groundTruthDocumentZodSchema,
  parseGroundTruthDocument,
  readGroundTruthDocument
} from "../src/ground-truth.js";
import { EVAL_GROUND_TRUTH_SCHEMA_ID, validateEvalJsonSchema } from "../src/eval-schema-registry.js";
import { executeEvalSchemaSemanticGates } from "../src/eval-semantic-gates.js";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const BUGS = [{ id: "H-1", title: "Example" }];
const AAVE_GROUND_TRUTH_PATH = fileURLToPath(
  new URL("../../../benchmarks/private-ground-truth/aave-v4-scfuzzbench/findings.yml", import.meta.url)
);
const AAVE_UPSTREAM_REPOSITORY = "https://github.com/aave/aave-v4";
const AAVE_SCFUZZBENCH_REPOSITORY = "https://github.com/scfuzzbench/aave-v4-scfuzzbench";
const AAVE_SCFUZZBENCH_REVISION = "edd6c82721512540c8c90e7a36a4a8e19fd7bdf3";
const PUBLIC_GROUND_TRUTH_PATHS = [
  "stableswap-ng-vyper.yml",
  "venus-isolated-pools-hardhat.yml",
  "very-liquid-vaults-foundry.yml"
].map((filename) =>
  fileURLToPath(new URL(`../../../benchmarks/public-ground-truth/ultrafuzz-bench/${filename}`, import.meta.url))
);

describe("private ground-truth subject binding", () => {
  it("keeps the canonical whole-document schema and retained Zod parser structurally exact", () => {
    const fixture = JSON.parse(
      fs.readFileSync(new URL("./fixtures/eval-ground-truth.valid.json", import.meta.url), "utf8")
    );
    expectStructuralParity(fixture, true);
    expect(executeEvalSchemaSemanticGates(EVAL_GROUND_TRUTH_SCHEMA_ID, fixture)).toEqual([]);
    expect(parseGroundTruthDocument(fixture)).toEqual(fixture);

    const extraRoot = { ...fixture, repaired: true };
    const extraBug = structuredClone(fixture);
    extraBug.bugs[0].legacy_id = "H-1";
    const duplicateBug = structuredClone(fixture);
    duplicateBug.bugs.push(structuredClone(duplicateBug.bugs[0]));
    const oversizedTitle = structuredClone(fixture);
    oversizedTitle.bugs[0].title = "🙂".repeat(16_385);
    for (const invalid of [extraRoot, extraBug, duplicateBug, oversizedTitle]) {
      expectStructuralParity(invalid, false);
    }

    const duplicateId = structuredClone(fixture);
    duplicateId.bugs.push({ id: duplicateId.bugs[0].id, title: "A distinct record with the same identity" });
    expectStructuralParity(duplicateId, true);
    expect(executeEvalSchemaSemanticGates(EVAL_GROUND_TRUTH_SCHEMA_ID, duplicateId)).toEqual([
      expect.objectContaining({ gate: "eval-ground-truth-integrity", path: "$.bugs" })
    ]);
    expect(() => parseGroundTruthDocument(duplicateId)).toThrow();
  });

  it("accepts an exact repository and immutable revision match", () => {
    const document = parseGroundTruthDocument(
      {
        schema_version: "ultrafuzz.eval-ground-truth.v1",
        subject: { repository: "https://github.com/example/target", revision: REVISION },
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

  it("keeps every checked-in public label file on the same current contract", () => {
    for (const filePath of PUBLIC_GROUND_TRUTH_PATHS) {
      const document = readGroundTruthDocument(filePath);
      expect(document.schema_version).toBe("ultrafuzz.eval-ground-truth.v1");
      expect(document.source).toBeDefined();
      expect(document.subject).toBeUndefined();
      expect(document.bugs.length).toBeGreaterThan(0);
      expect(validateEvalJsonSchema(EVAL_GROUND_TRUTH_SCHEMA_ID, document)).toMatchObject({ ok: true });
      expect(executeEvalSchemaSemanticGates(EVAL_GROUND_TRUTH_SCHEMA_ID, document)).toEqual([]);
    }
  });

  it.each([
    ["a bare bug array", BUGS, "EVAL_GROUND_TRUTH_INVALID"],
    ["an unversioned object", { bugs: BUGS }, "EVAL_GROUND_TRUTH_INVALID"],
    ["a previous or unknown version", { schema_version: "1.0", bugs: BUGS }, "EVAL_GROUND_TRUTH_INVALID"],
    [
      "a noncanonical repository alias",
      {
        schema_version: "ultrafuzz.eval-ground-truth.v1",
        subject: { repository: "https://github.com/Example/Target.git/", revision: REVISION },
        bugs: BUGS
      },
      "EVAL_GROUND_TRUTH_SUBJECT_INVALID"
    ],
    [
      "an undeclared root field",
      { schema_version: "ultrafuzz.eval-ground-truth.v1", bugs: BUGS, source: "legacy" },
      "EVAL_GROUND_TRUTH_INVALID"
    ],
    [
      "an undeclared bug field",
      { schema_version: "ultrafuzz.eval-ground-truth.v1", bugs: [{ ...BUGS[0], legacy_id: "H-1" }] },
      "EVAL_GROUND_TRUTH_INVALID"
    ]
  ] as const)("rejects %s instead of reconstructing it", (_description, input, code) => {
    expect(() => parseGroundTruthDocument(input)).toThrowError(expect.objectContaining({ code }));
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
          source: {
            url: "https://example.com/public-report",
            retrieved_sha256: "a".repeat(64),
            note: "A public identity cannot coexist with a private subject."
          },
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

function expectStructuralParity(value: unknown, expected: boolean): void {
  const canonical = validateEvalJsonSchema(EVAL_GROUND_TRUTH_SCHEMA_ID, value).ok;
  const retained = groundTruthDocumentZodSchema.safeParse(value);
  expect(canonical).toBe(expected);
  expect(retained.success).toBe(expected);
  if (retained.success) expect(retained.data).toEqual(value);
}
