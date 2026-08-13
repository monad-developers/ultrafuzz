import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as artifactExports from "../src/index.js";
import { CANONICAL_TIMESTAMP_PATTERN, CANONICAL_UUID_PATTERN } from "../src/portable-json-primitives.js";
import {
  ARTIFACT_CONTRACT_IDS,
  ARTIFACT_CONTRACT_SCHEMA_FILES,
  ARTIFACT_SCHEMA_METADATA,
  JSON_ARTIFACT_CONTRACT_IDS,
  MAX_FINDINGS,
  MAX_FINDING_COUNT,
  MAX_FINDING_NESTED_ITEMS,
  MAX_FINDING_PATH_CODE_POINTS,
  MAX_FINDING_STRING_CODE_POINTS,
  MAX_PROPERTY_CAMPAIGN_COUNT,
  MAX_PROPERTY_CAMPAIGN_NESTED_ITEMS,
  MAX_PROPERTY_CAMPAIGN_PATH_CODE_POINTS,
  MAX_PROPERTY_CAMPAIGN_RECORDS,
  MAX_PROPERTY_CAMPAIGN_STRING_CODE_POINTS,
  NON_JSON_ARTIFACT_CONTRACT_IDS,
  analysisAccountingSummarySchema,
  analysisAttemptHistorySchema,
  analysisBundleOmissionsSchema,
  analysisEvaluationMetricsSchema,
  analysisBundleManifestSchema,
  analysisRecoverySummarySchema,
  analysisTerminalStatusSchema,
  artifactContractDefinition,
  artifactContractSchemaFile,
  artifactSchemaRegistry,
  assertAnalysisAccountingSummary,
  assertAnalysisAttemptHistory,
  assertAnalysisBundleOmissions,
  assertAnalysisEvaluationMetrics,
  assertAnalysisRecoverySummary,
  assertAnalysisTerminalStatus,
  createInitialRunState,
  executeSemanticGate,
  invariantLedgerSchema,
  invariantSourceProofSchema,
  isArtifactContractId,
  parseStrictJson,
  validateAnalysisBundleManifestSchema,
  validateArtifactContract,
  validateArtifactContractBytes,
  validateInvariantLedgerSchema,
  validateInvariantSourceProofSchema,
  validateRegisteredJsonSchema,
  validateWorkspacePatchSchema,
  workspacePatchSchema
} from "../src/index.js";

interface ContractFixture {
  schema_file: string;
  valid: unknown;
  invalid: unknown;
}

interface ZodLikeParser {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = [
  path.resolve(moduleDirectory, "..", "..", "test", "fixtures", "contract-schema-fixtures.json"),
  path.resolve(moduleDirectory, "fixtures", "contract-schema-fixtures.json")
].find((candidate) => fs.existsSync(candidate));
if (fixturePath === undefined) throw new Error(`Contract fixtures are unavailable near ${moduleDirectory}`);
const contractFixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, ContractFixture>;

const removedContractIds = [
  "ultrafuzz/campaign-summary@1",
  "ultrafuzz/findings@1",
  "ultrafuzz/generated-tests@1",
  "ultrafuzz/generated-tests@2",
  "ultrafuzz/implemented-properties@1",
  "ultrafuzz/implemented-properties@2",
  "ultrafuzz/invariant-campaign-plan@1",
  "ultrafuzz/json-array@1",
  "ultrafuzz/json-object@1",
  "ultrafuzz/properties@1",
  "ultrafuzz/property-campaign@1",
  "ultrafuzz/property-campaign@2",
  "ultrafuzz/property-lens@1",
  "ultrafuzz/reference-expectations@1",
  "ultrafuzz/report@1"
] as const;

test("the registry, schema metadata, mappings, and fixtures cover every current contract exactly once", () => {
  const registry = artifactSchemaRegistry();
  const registeredContractIds = registry.flatMap((entry) => entry.contractIds).sort();

  assert.deepEqual(registeredContractIds, [...JSON_ARTIFACT_CONTRACT_IDS].sort());
  assert.deepEqual(Object.keys(contractFixtures).sort(), [...JSON_ARTIFACT_CONTRACT_IDS].sort());
  assert.deepEqual(Object.keys(ARTIFACT_CONTRACT_SCHEMA_FILES).sort(), [...JSON_ARTIFACT_CONTRACT_IDS].sort());
  assert.deepEqual(Object.keys(ARTIFACT_SCHEMA_METADATA).sort(), registry.map((entry) => entry.filename).sort());
  assert.equal(new Set(ARTIFACT_CONTRACT_IDS).size, ARTIFACT_CONTRACT_IDS.length);

  for (const contract of JSON_ARTIFACT_CONTRACT_IDS) {
    const schemaFile = artifactContractSchemaFile(contract);
    const fixture = contractFixtures[contract];
    const registryMatches = registry.filter((entry) => entry.contractIds.includes(contract));
    assert.equal(artifactContractDefinition(contract).format, "json", contract);
    assert.equal(typeof schemaFile, "string", contract);
    assert.equal(fixture?.schema_file, schemaFile, contract);
    assert.equal(registryMatches.length, 1, contract);
    assert.equal(registryMatches[0]?.filename, schemaFile, contract);
    const metadata = ARTIFACT_SCHEMA_METADATA[schemaFile as keyof typeof ARTIFACT_SCHEMA_METADATA];
    assert.deepEqual(metadata?.contractIds, [contract], contract);
  }

  for (const contract of NON_JSON_ARTIFACT_CONTRACT_IDS) {
    assert.equal(artifactContractSchemaFile(contract), undefined, contract);
    assert.equal(artifactContractDefinition(contract).format === "json", false, contract);
  }
  for (const contract of removedContractIds) assert.equal(isArtifactContractId(contract), false, contract);
});

test("every JSON contract has canonical positive and negative fixtures and validation is non-mutating", () => {
  for (const contract of JSON_ARTIFACT_CONTRACT_IDS) {
    const fixture = contractFixtures[contract]!;
    const validBefore = structuredClone(fixture.valid);
    const invalidBefore = structuredClone(fixture.invalid);
    const validBytes = JSON.stringify(fixture.valid);
    const invalidBytes = JSON.stringify(fixture.invalid);

    const valid = validateArtifactContract(contract, validBytes, `${contract}:valid`);
    const invalid = validateArtifactContract(contract, invalidBytes, `${contract}:invalid`);

    assert.equal(valid.ok, true, `${contract}: ${JSON.stringify(valid.issues)}`);
    assert.equal(invalid.ok, false, contract);
    assert.deepEqual(fixture.valid, validBefore, `${contract} valid value mutated`);
    assert.deepEqual(fixture.invalid, invalidBefore, `${contract} invalid value mutated`);
    assert.equal(JSON.stringify(fixture.valid), validBytes, `${contract} valid bytes changed`);
    assert.equal(JSON.stringify(fixture.invalid), invalidBytes, `${contract} invalid bytes changed`);
    assert.deepEqual(parseStrictJson(validBytes), fixture.valid, contract);
  }
});

test("coverage evidence reconciles scoped denominators and keeps excluded ranges out of selected scope", () => {
  const valid = structuredClone(contractFixtures["ultrafuzz/coverage-evidence@1"]!.valid) as Record<string, unknown>;
  assert.equal(executeSemanticGate("coverage-evidence-reconciliation", { document: valid }).status, "passed");

  const independentlyScoped = structuredClone(valid) as {
    files: Array<{ path: string; covered_ranges: number; total_ranges: number }>;
    views: Array<{ scope: string; covered_ranges: number; total_ranges: number }>;
    counted_ranges: Array<Record<string, unknown>>;
  };
  independentlyScoped.counted_ranges.push({
    file: "src/Core.sol",
    kind: "production",
    start_line: 2,
    line_count: 1,
    selected: false,
    covered: true
  });
  independentlyScoped.files.find((entry) => entry.path === "src/Core.sol")!.covered_ranges = 2;
  independentlyScoped.files.find((entry) => entry.path === "src/Core.sol")!.total_ranges = 2;
  independentlyScoped.views.find((entry) => entry.scope === "production-source")!.covered_ranges = 2;
  independentlyScoped.views.find((entry) => entry.scope === "production-source")!.total_ranges = 3;
  assert.equal(
    executeSemanticGate("coverage-evidence-reconciliation", { document: independentlyScoped }).status,
    "passed"
  );

  const hiddenExcludedRange = structuredClone(valid) as {
    counted_ranges: Array<Record<string, unknown>>;
  };
  hiddenExcludedRange.counted_ranges.push({
    file: "src/Critical.sol",
    kind: "production",
    start_line: 1,
    line_count: 1,
    selected: true,
    covered: false
  });
  const rejected = executeSemanticGate("coverage-evidence-reconciliation", { document: hiddenExcludedRange });
  assert.equal(rejected.status, "failed");
  assert.ok(
    rejected.status === "failed" &&
      rejected.issues.some((issue) => /included in the selected-range scope/u.test(issue.message))
  );

  const legacyReversedRange = structuredClone(valid) as {
    counted_ranges: Array<Record<string, unknown>>;
  };
  delete legacyReversedRange.counted_ranges[0]!.line_count;
  legacyReversedRange.counted_ranges[0]!.end_line = 0;
  assert.equal(
    validateArtifactContract("ultrafuzz/coverage-evidence@1", JSON.stringify(legacyReversedRange)).ok,
    false
  );

  const emptyRange = structuredClone(valid) as { counted_ranges: Array<{ line_count: number }> };
  emptyRange.counted_ranges[0]!.line_count = 0;
  assert.equal(validateArtifactContract("ultrafuzz/coverage-evidence@1", JSON.stringify(emptyRange)).ok, false);

  const unauthenticatedCriticalFlag = structuredClone(valid) as { files: Array<Record<string, unknown>> };
  unauthenticatedCriticalFlag.files[0]!.critical = false;
  assert.equal(
    validateArtifactContract("ultrafuzz/coverage-evidence@1", JSON.stringify(unauthenticatedCriticalFlag)).ok,
    false
  );
});

test("strict contract parsing rejects duplicate keys in every object-shaped canonical fixture", () => {
  for (const contract of JSON_ARTIFACT_CONTRACT_IDS) {
    const fixture = contractFixtures[contract]!;
    const duplicate = duplicateFixtureJson(fixture.valid);
    if (duplicate === undefined) continue;
    const result = validateArtifactContract(contract, duplicate, `${contract}:duplicate`);
    assert.equal(result.ok, false, contract);
    assert.equal(result.issues[0]?.code, "ARTIFACT_JSON_DUPLICATE_KEY", contract);
  }
});

test("byte-level contract validation rejects invalid UTF-8 before shape validation", () => {
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  for (const contract of ["ultrafuzz/findings@2", "ultrafuzz/nonempty-markdown@1", "ultrafuzz/text@1"] as const) {
    const result = validateArtifactContractBytes(contract, invalidUtf8, `${contract}:invalid-utf8`);
    assert.equal(result.ok, false, contract);
    assert.match(result.issues[0]?.code ?? "", /ARTIFACT_(?:JSON|UTF8)_INVALID/u, contract);
  }
});

test("checked-in canonical schemas equal every metadata-named TypeScript export", () => {
  const exports = artifactExports as unknown as Record<string, unknown>;
  for (const entry of artifactSchemaRegistry()) {
    assert.ok(entry.typescriptExport in exports, `${entry.filename}: ${entry.typescriptExport}`);
    assert.deepEqual(exports[entry.typescriptExport], entry.schema, entry.filename);
  }
});

test("Ajv and every retained Zod parser agree bidirectionally on positive, negative, and required-field fixtures", () => {
  const exports = artifactExports as unknown as Record<string, unknown>;
  for (const entry of artifactSchemaRegistry()) {
    if (entry.zodParser === undefined) continue;
    const parser = exports[entry.zodParser] as ZodLikeParser | undefined;
    assert.equal(typeof parser?.safeParse, "function", `${entry.filename}: ${entry.zodParser}`);
    const positive = zodPositiveFixture(entry.filename, entry.contractIds);
    const negative = invalidRootFixture(positive);

    assertParity(entry.id, parser!, positive, true, `${entry.filename}:positive`);
    assertParity(entry.id, parser!, negative, false, `${entry.filename}:negative`);

    if (isRecord(positive)) {
      const required = Array.isArray(entry.schema.required) ? entry.schema.required : [];
      for (const key of required) {
        if (typeof key !== "string") continue;
        const missing = structuredClone(positive);
        delete missing[key];
        assertParity(entry.id, parser!, missing, false, `${entry.filename}:missing:${key}`);
      }
    }
  }
});

test("property-campaign v3 JSON Schema and Zod agree on every portable status conditional", () => {
  const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === "property-campaign.schema.json");
  assert.ok(entry?.zodParser !== undefined);
  const parser = (artifactExports as unknown as Record<string, unknown>)[entry.zodParser] as ZodLikeParser;
  const base = structuredClone(contractFixtures["ultrafuzz/property-campaign@3"]!.valid) as Record<string, unknown>;
  const executionBase = base.execution as Record<string, unknown>;
  const coverageBase = base.coverage as Record<string, unknown>;
  const withExecution = (execution: Record<string, unknown>): Record<string, unknown> => ({
    ...structuredClone(base),
    execution: { ...executionBase, ...execution }
  });
  const withCoverage = (coverage: Record<string, unknown>): Record<string, unknown> => ({
    ...structuredClone(base),
    coverage: { ...coverageBase, ...coverage }
  });
  const result = (status: string, failureIds: string[], reason: string | null): Record<string, unknown> => ({
    property_id: "property-1",
    status,
    failure_ids: failureIds,
    coverage_metric_names: [],
    evidence_refs: [],
    reason
  });
  const failure = (
    status: string,
    deterministicReproducerRef: string | null,
    reproductionBlocker: string | null
  ): Record<string, unknown> => ({
    id: "failure-1",
    status,
    property_ids: ["property-1"],
    entrypoint: "handler()",
    sequence: ["handler()"],
    precondition_evidence: ["fixture precondition held"],
    raw_reproducer_ref: "backends/recon-fuzzer/results.json",
    deterministic_reproducer_ref: deterministicReproducerRef,
    reproduction_blocker: reproductionBlocker
  });
  const cases: Array<{ label: string; value: unknown; expected: boolean }> = [
    { label: "execution-unavailable", value: base, expected: true },
    {
      label: "execution-complete",
      value: withExecution({
        status: "complete",
        usable_results: true,
        started_at: "2026-01-01T00:00:00Z",
        exit_code: 0,
        failure: null
      }),
      expected: true
    },
    {
      label: "execution-complete-nonzero",
      value: withExecution({
        status: "complete",
        usable_results: true,
        started_at: "2026-01-01T00:00:00Z",
        exit_code: 1,
        failure: null
      }),
      expected: false
    },
    {
      label: "execution-partial",
      value: withExecution({
        status: "partial",
        usable_results: true,
        started_at: "2026-01-01T00:00:00Z",
        exit_code: 1,
        failure: { category: "process-failed", summary: "The backend stopped early." }
      }),
      expected: true
    },
    {
      label: "execution-partial-without-failure",
      value: withExecution({
        status: "partial",
        usable_results: true,
        started_at: "2026-01-01T00:00:00Z",
        exit_code: 1,
        failure: null
      }),
      expected: false
    },
    {
      label: "execution-blocked",
      value: withExecution({
        status: "blocked",
        usable_results: false,
        started_at: null,
        exit_code: null,
        failure: { category: "smoke-failed", summary: "The smoke did not pass." }
      }),
      expected: true
    },
    {
      label: "execution-blocked-after-start",
      value: withExecution({
        status: "blocked",
        usable_results: false,
        started_at: "2026-01-01T00:00:00Z",
        exit_code: null,
        failure: { category: "smoke-failed", summary: "The smoke did not pass." }
      }),
      expected: false
    },
    {
      label: "execution-timed-out",
      value: withExecution({
        status: "timed-out",
        usable_results: true,
        started_at: "2026-01-01T00:00:00Z",
        exit_code: null,
        failure: { category: "deadline-exceeded", summary: "The deadline elapsed." }
      }),
      expected: true
    },
    {
      label: "execution-timed-out-wrong-category",
      value: withExecution({
        status: "timed-out",
        usable_results: true,
        started_at: "2026-01-01T00:00:00Z",
        exit_code: null,
        failure: { category: "process-failed", summary: "The deadline elapsed." }
      }),
      expected: false
    },
    {
      label: "execution-unavailable-wrong-category",
      value: withExecution({ failure: { category: "process-failed", summary: "Recon is unavailable." } }),
      expected: false
    },
    {
      label: "coverage-reported",
      value: withCoverage({
        status: "reported",
        metrics: [{ name: "executions", value: 1, unit: "count", source_ref: "backends/recon-fuzzer/results.json" }],
        unavailable_reason: null
      }),
      expected: true
    },
    {
      label: "coverage-count-fraction",
      value: withCoverage({
        status: "reported",
        metrics: [{ name: "executions", value: 1.5, unit: "count", source_ref: "backends/recon-fuzzer/results.json" }],
        unavailable_reason: null
      }),
      expected: false
    },
    {
      label: "coverage-ratio-over-one",
      value: withCoverage({
        status: "reported",
        metrics: [
          { name: "branch-ratio", value: 1.01, unit: "ratio", source_ref: "backends/recon-fuzzer/results.json" }
        ],
        unavailable_reason: null
      }),
      expected: false
    },
    {
      label: "coverage-percent-over-one-hundred",
      value: withCoverage({
        status: "reported",
        metrics: [
          { name: "branch-percent", value: 100.1, unit: "percent", source_ref: "backends/recon-fuzzer/results.json" }
        ],
        unavailable_reason: null
      }),
      expected: false
    },
    {
      label: "coverage-reported-empty",
      value: withCoverage({ status: "reported", metrics: [], unavailable_reason: null }),
      expected: false
    },
    {
      label: "coverage-unavailable-with-metric",
      value: withCoverage({
        status: "unavailable",
        metrics: [{ name: "executions", value: 1, unit: "count", source_ref: "backends/recon-fuzzer/results.json" }],
        unavailable_reason: "The backend did not report coverage."
      }),
      expected: false
    },
    {
      label: "property-result-failed",
      value: { ...structuredClone(base), property_results: [result("failed", ["failure-1"], null)] },
      expected: true
    },
    {
      label: "property-result-failed-without-failure",
      value: { ...structuredClone(base), property_results: [result("failed", [], null)] },
      expected: false
    },
    {
      label: "property-result-passed",
      value: { ...structuredClone(base), property_results: [result("passed", [], null)] },
      expected: true
    },
    {
      label: "property-result-passed-with-reason",
      value: { ...structuredClone(base), property_results: [result("passed", [], "Unexpected reason")] },
      expected: false
    },
    {
      label: "property-result-inconclusive",
      value: {
        ...structuredClone(base),
        property_results: [result("inconclusive", [], "The run ended before classification.")]
      },
      expected: true
    },
    {
      label: "property-result-inconclusive-without-reason",
      value: { ...structuredClone(base), property_results: [result("inconclusive", [], null)] },
      expected: false
    },
    {
      label: "failure-reproduced",
      value: {
        ...structuredClone(base),
        failures: [failure("reproduced", "backends/recon-fuzzer/reproducers/failure-1.t.sol", null)]
      },
      expected: true
    },
    {
      label: "failure-reproduced-without-deterministic-path",
      value: { ...structuredClone(base), failures: [failure("reproduced", null, null)] },
      expected: false
    },
    {
      label: "failure-blocked",
      value: {
        ...structuredClone(base),
        failures: [failure("blocked-unreproduced", null, "The raw sequence did not replay deterministically.")]
      },
      expected: true
    },
    {
      label: "failure-blocked-without-blocker",
      value: { ...structuredClone(base), failures: [failure("blocked-unreproduced", null, null)] },
      expected: false
    },
    {
      label: "unsafe-plan-reference",
      value: { ...structuredClone(base), campaign_plan_ref: "../campaign-plan.json" },
      expected: false
    },
    {
      label: "canonical-plan-reference",
      value: { ...structuredClone(base), campaign_plan_ref: ".plans/campaign@v3+smoke.json" },
      expected: true
    },
    {
      label: "overlong-plan-reference-segment",
      value: { ...structuredClone(base), campaign_plan_ref: `${"a".repeat(129)}/campaign-plan.json` },
      expected: false
    },
    {
      label: "unsafe-evidence-reference",
      value: {
        ...structuredClone(base),
        property_results: [
          {
            ...result("inconclusive", [], "The run ended before classification."),
            evidence_refs: ["/tmp/result.json"]
          }
        ]
      },
      expected: false
    }
  ];

  for (const fixture of cases) {
    assertParity(entry.id, parser, fixture.value, fixture.expected, `property-campaign:${fixture.label}`);
  }
});

test("finding-derived and property-campaign resource bounds agree in Ajv and Zod", () => {
  const registry = artifactSchemaRegistry();
  const exports = artifactExports as unknown as Record<string, unknown>;
  const findingEntry = registry.find((candidate) => candidate.filename === "finding.schema.json");
  const findingsEntry = registry.find((candidate) => candidate.filename === "findings.schema.json");
  const campaignEntry = registry.find((candidate) => candidate.filename === "property-campaign.schema.json");
  const strategyEntry = registry.find((candidate) => candidate.filename === "strategy-detections.schema.json");
  const triagedEntry = registry.find((candidate) => candidate.filename === "triaged-findings.schema.json");
  const severityEntry = registry.find((candidate) => candidate.filename === "severity-classified-findings.schema.json");
  const lifecycleEntry = registry.find((candidate) => candidate.filename === "finding-lifecycle-ledger.schema.json");
  assert.ok(findingEntry?.zodParser !== undefined);
  assert.ok(findingsEntry?.zodParser !== undefined);
  assert.ok(campaignEntry?.zodParser !== undefined);
  assert.ok(strategyEntry?.zodParser !== undefined);
  assert.ok(triagedEntry?.zodParser !== undefined);
  assert.ok(severityEntry?.zodParser !== undefined);
  assert.ok(lifecycleEntry?.zodParser !== undefined);
  const findingParser = exports[findingEntry.zodParser] as ZodLikeParser;
  const findingsParser = exports[findingsEntry.zodParser] as ZodLikeParser;
  const campaignParser = exports[campaignEntry.zodParser] as ZodLikeParser;
  const strategyParser = exports[strategyEntry.zodParser] as ZodLikeParser;
  const triagedParser = exports[triagedEntry.zodParser] as ZodLikeParser;
  const severityParser = exports[severityEntry.zodParser] as ZodLikeParser;
  const lifecycleParser = exports[lifecycleEntry.zodParser] as ZodLikeParser;
  const finding = structuredClone((contractFixtures["ultrafuzz/findings@2"]!.valid as unknown[])[0]) as Record<
    string,
    unknown
  >;
  const campaign = structuredClone(contractFixtures["ultrafuzz/property-campaign@3"]!.valid) as Record<string, unknown>;
  const assertBoundary = (
    schemaId: string,
    parser: ZodLikeParser,
    label: string,
    boundary: unknown,
    overflow: unknown
  ): void => {
    assertParity(schemaId, parser, boundary, true, `${label}:boundary`);
    assertParity(schemaId, parser, overflow, false, `${label}:overflow`);
  };

  const findingString = { ...finding, summary: "🙂".repeat(MAX_FINDING_STRING_CODE_POINTS) };
  assertBoundary(findingEntry.id, findingParser, "finding:string-code-points", findingString, {
    ...findingString,
    summary: `${findingString.summary as string}🙂`
  });
  const findingPath = { ...finding, affected_files: ["🙂".repeat(MAX_FINDING_PATH_CODE_POINTS)] };
  assertBoundary(findingEntry.id, findingParser, "finding:path-code-points", findingPath, {
    ...findingPath,
    affected_files: [`${(findingPath.affected_files as string[])[0]}🙂`]
  });
  const findingNested = { ...finding, notes: Array<string>(MAX_FINDING_NESTED_ITEMS).fill("note") };
  assertBoundary(findingEntry.id, findingParser, "finding:nested-items", findingNested, {
    ...findingNested,
    notes: [...(findingNested.notes as string[]), "overflow"]
  });
  assertBoundary(
    findingEntry.id,
    findingParser,
    "finding:numeric-count",
    { ...finding, attempt_index: MAX_FINDING_COUNT },
    { ...finding, attempt_index: MAX_FINDING_COUNT + 1 }
  );
  const findingsBoundary = Array<Record<string, unknown>>(MAX_FINDINGS).fill(finding);
  assertBoundary(findingsEntry.id, findingsParser, "findings:top-level-items", findingsBoundary, [
    ...findingsBoundary,
    finding
  ]);

  const strategyDetection = structuredClone(
    (contractFixtures["ultrafuzz/strategy-detections@1"]!.valid as unknown[])[0]
  ) as Record<string, unknown>;
  const strategyBoundary = Array<Record<string, unknown>>(MAX_FINDINGS).fill(strategyDetection);
  assertBoundary(strategyEntry.id, strategyParser, "strategy-detections:top-level-items", strategyBoundary, [
    ...strategyBoundary,
    strategyDetection
  ]);
  const strategyNested = {
    ...strategyDetection,
    hits: Array<Record<string, unknown>>(MAX_FINDING_NESTED_ITEMS).fill({ strategy: "strategy-1" })
  };
  assertBoundary(
    strategyEntry.id,
    strategyParser,
    "strategy-detections:hits",
    [strategyNested],
    [
      {
        ...strategyNested,
        hits: [...(strategyNested.hits as Record<string, unknown>[]), { strategy: "overflow" }]
      }
    ]
  );

  const triaged = structuredClone((contractFixtures["ultrafuzz/triaged-findings@1"]!.valid as unknown[])[0]) as Record<
    string,
    unknown
  >;
  const triagedBoundary = Array<Record<string, unknown>>(MAX_FINDINGS).fill(triaged);
  assertBoundary(triagedEntry.id, triagedParser, "triaged-findings:top-level-items", triagedBoundary, [
    ...triagedBoundary,
    triaged
  ]);
  const triageNotes = {
    ...triaged,
    notes: Array<string>(MAX_FINDING_NESTED_ITEMS).fill("triage_reason=confirmed")
  };
  assertBoundary(
    triagedEntry.id,
    triagedParser,
    "triaged-findings:notes",
    [triageNotes],
    [{ ...triageNotes, notes: [...(triageNotes.notes as string[]), "overflow"] }]
  );
  const triageReasonPrefix = "triage_reason=";
  const triageAstral = {
    ...triaged,
    notes: [`${triageReasonPrefix}${"🙂".repeat(MAX_FINDING_STRING_CODE_POINTS - [...triageReasonPrefix].length)}`]
  };
  assertBoundary(
    triagedEntry.id,
    triagedParser,
    "triaged-findings:note-code-points",
    [triageAstral],
    [{ ...triageAstral, notes: [`${(triageAstral.notes as string[])[0]}🙂`] }]
  );

  const severity = structuredClone(
    (contractFixtures["ultrafuzz/severity-classified-findings@1"]!.valid as unknown[])[0]
  ) as Record<string, unknown>;
  const severityBoundary = Array<Record<string, unknown>>(MAX_FINDINGS).fill(severity);
  assertBoundary(severityEntry.id, severityParser, "severity-findings:top-level-items", severityBoundary, [
    ...severityBoundary,
    severity
  ]);
  const severityAstral = { ...severity, severity_rationale: "🙂".repeat(MAX_FINDING_STRING_CODE_POINTS) };
  assertBoundary(
    severityEntry.id,
    severityParser,
    "severity-findings:rationale-code-points",
    [severityAstral],
    [{ ...severityAstral, severity_rationale: `${severityAstral.severity_rationale}🙂` }]
  );

  const lifecycleRecord = {
    dedupe_key: "finding-1",
    source_artifacts: [],
    strategy_hits: [],
    stages: [{ stage: "raw", artifact_path: "findings/raw.json", finding_id: "finding-1" }]
  };
  const lifecycle = {
    schema_version: "ultrafuzz.finding-lifecycle-ledger.v1",
    records: Array<Record<string, unknown>>(MAX_FINDINGS).fill(lifecycleRecord)
  };
  assertBoundary(lifecycleEntry.id, lifecycleParser, "finding-lifecycle:top-level-records", lifecycle, {
    ...lifecycle,
    records: [...lifecycle.records, lifecycleRecord]
  });
  const lifecycleStages = {
    schema_version: lifecycle.schema_version,
    records: [
      {
        ...lifecycleRecord,
        stages: Array<Record<string, unknown>>(MAX_FINDING_NESTED_ITEMS).fill({
          stage: "raw",
          artifact_path: "findings/raw.json",
          finding_id: "finding-1"
        })
      }
    ]
  };
  assertBoundary(lifecycleEntry.id, lifecycleParser, "finding-lifecycle:stages", lifecycleStages, {
    ...lifecycleStages,
    records: [
      {
        ...lifecycleStages.records[0],
        stages: [
          ...lifecycleStages.records[0]!.stages,
          { stage: "triaged", artifact_path: "findings/triaged.json", finding_id: "finding-1" }
        ]
      }
    ]
  });

  const campaignString = { ...campaign, fuzzer_backend: "🙂".repeat(MAX_PROPERTY_CAMPAIGN_STRING_CODE_POINTS) };
  assertBoundary(campaignEntry.id, campaignParser, "property-campaign:string-code-points", campaignString, {
    ...campaignString,
    fuzzer_backend: `${campaignString.fuzzer_backend as string}🙂`
  });
  const campaignPathSegments = [
    ...Array<string>(31).fill("a".repeat(128)),
    "a".repeat(MAX_PROPERTY_CAMPAIGN_PATH_CODE_POINTS - 31 * 128 - 31)
  ];
  const campaignPath = { ...campaign, campaign_plan_ref: campaignPathSegments.join("/") };
  assertBoundary(campaignEntry.id, campaignParser, "property-campaign:path-code-points", campaignPath, {
    ...campaignPath,
    campaign_plan_ref: `${campaignPath.campaign_plan_ref as string}a`
  });
  const failure = {
    id: "failure-1",
    status: "reproduced",
    property_ids: ["property-1"],
    entrypoint: "handler()",
    sequence: Array<string>(MAX_PROPERTY_CAMPAIGN_NESTED_ITEMS).fill("handler()"),
    precondition_evidence: [],
    raw_reproducer_ref: "backends/recon-fuzzer/results.json",
    deterministic_reproducer_ref: "backends/recon-fuzzer/reproducers/failure-1.t.sol",
    reproduction_blocker: null
  };
  const campaignNested = { ...campaign, failures: [failure] };
  assertBoundary(campaignEntry.id, campaignParser, "property-campaign:nested-items", campaignNested, {
    ...campaignNested,
    failures: [{ ...failure, sequence: [...failure.sequence, "overflow"] }]
  });
  const propertyResult = {
    property_id: "property-1",
    status: "passed",
    failure_ids: [],
    coverage_metric_names: [],
    evidence_refs: [],
    reason: null
  };
  const campaignRecords = {
    ...campaign,
    property_results: Array<Record<string, unknown>>(MAX_PROPERTY_CAMPAIGN_RECORDS).fill(propertyResult)
  };
  assertBoundary(campaignEntry.id, campaignParser, "property-campaign:top-level-records", campaignRecords, {
    ...campaignRecords,
    property_results: [...(campaignRecords.property_results as Record<string, unknown>[]), propertyResult]
  });
  const campaignExecution = campaign.execution as Record<string, unknown>;
  assertBoundary(
    campaignEntry.id,
    campaignParser,
    "property-campaign:numeric-count",
    { ...campaign, execution: { ...campaignExecution, workers: MAX_PROPERTY_CAMPAIGN_COUNT } },
    { ...campaign, execution: { ...campaignExecution, workers: MAX_PROPERTY_CAMPAIGN_COUNT + 1 } }
  );
});

test("analysis-bundle payload schemas and retained Zod reject the same current-version and boundary mutations", () => {
  const cases: Array<{ filename: string; parser: ZodLikeParser; label: string; value: unknown; expected: boolean }> =
    [];
  const add = (filename: string, parser: ZodLikeParser, label: string, value: unknown, expected = false): void => {
    cases.push({ filename, parser, label, value, expected });
  };

  const payloadSchemas = [
    ["analysis-bundle-terminal-status.schema.json", analysisTerminalStatusSchema],
    ["analysis-bundle-evaluation-metrics.schema.json", analysisEvaluationMetricsSchema],
    ["analysis-bundle-accounting-summary.schema.json", analysisAccountingSummarySchema],
    ["analysis-bundle-attempt-history.schema.json", analysisAttemptHistorySchema],
    ["analysis-bundle-recovery-summary.schema.json", analysisRecoverySummarySchema],
    ["analysis-bundle-omissions.schema.json", analysisBundleOmissionsSchema]
  ] as const;
  for (const [filename, parser] of payloadSchemas) {
    const historical = analysisBundleFixture(filename);
    historical.schema_version = "ultrafuzz.analysis-bundle.v0";
    add(filename, parser, "historical-version", historical);

    const unexpected = analysisBundleFixture(filename);
    unexpected.unexpected = true;
    add(filename, parser, "unknown-root-field", unexpected);
  }

  const terminalUnsafeCount = analysisBundleFixture("analysis-bundle-terminal-status.schema.json");
  terminalUnsafeCount.run_count = Number.MAX_SAFE_INTEGER + 1;
  add(
    "analysis-bundle-terminal-status.schema.json",
    analysisTerminalStatusSchema,
    "unsafe-run-count",
    terminalUnsafeCount
  );
  const terminalBadTimestamp = analysisBundleFixture("analysis-bundle-terminal-status.schema.json");
  terminalBadTimestamp.started_at = "2026-08-09T00:00Z";
  add(
    "analysis-bundle-terminal-status.schema.json",
    analysisTerminalStatusSchema,
    "timestamp-without-seconds",
    terminalBadTimestamp
  );
  const terminalBadEnum = analysisBundleFixture("analysis-bundle-terminal-status.schema.json");
  terminalBadEnum.status = "complete";
  add("analysis-bundle-terminal-status.schema.json", analysisTerminalStatusSchema, "unknown-status", terminalBadEnum);
  const terminalNullTimestamp = analysisBundleFixture("analysis-bundle-terminal-status.schema.json");
  terminalNullTimestamp.finished_at = null;
  add(
    "analysis-bundle-terminal-status.schema.json",
    analysisTerminalStatusSchema,
    "null-optional-timestamp",
    terminalNullTimestamp
  );

  const evaluationUnsafeCount = analysisBundleFixture("analysis-bundle-evaluation-metrics.schema.json");
  evaluationUnsafeCount.row_count = Number.MAX_SAFE_INTEGER + 1;
  add(
    "analysis-bundle-evaluation-metrics.schema.json",
    analysisEvaluationMetricsSchema,
    "unsafe-row-count",
    evaluationUnsafeCount
  );
  const evaluationNullMetric = analysisBundleFixture("analysis-bundle-evaluation-metrics.schema.json");
  (evaluationNullMetric.metrics as Record<string, unknown>).precision = null;
  add(
    "analysis-bundle-evaluation-metrics.schema.json",
    analysisEvaluationMetricsSchema,
    "null-required-metric",
    evaluationNullMetric
  );
  const evaluationNullableSeverity = analysisBundleFixture("analysis-bundle-evaluation-metrics.schema.json");
  (evaluationNullableSeverity.metrics as Record<string, unknown>).severity_accuracy = null;
  add(
    "analysis-bundle-evaluation-metrics.schema.json",
    analysisEvaluationMetricsSchema,
    "nullable-severity",
    evaluationNullableSeverity,
    true
  );
  const evaluationNestedUnknown = analysisBundleFixture("analysis-bundle-evaluation-metrics.schema.json");
  (evaluationNestedUnknown.totals as Record<string, unknown>).other = 0;
  add(
    "analysis-bundle-evaluation-metrics.schema.json",
    analysisEvaluationMetricsSchema,
    "unknown-total-field",
    evaluationNestedUnknown
  );

  const accountingUnsafeCount = analysisBundleFixture("analysis-bundle-accounting-summary.schema.json");
  accountingUnsafeCount.total_tokens = Number.MAX_SAFE_INTEGER + 1;
  add(
    "analysis-bundle-accounting-summary.schema.json",
    analysisAccountingSummarySchema,
    "unsafe-token-count",
    accountingUnsafeCount
  );
  const accountingBadBoolean = analysisBundleFixture("analysis-bundle-accounting-summary.schema.json");
  accountingBadBoolean.partial_pricing = "false";
  add(
    "analysis-bundle-accounting-summary.schema.json",
    analysisAccountingSummarySchema,
    "string-boolean",
    accountingBadBoolean
  );
  const accountingNullableValues = analysisBundleFixture("analysis-bundle-accounting-summary.schema.json");
  accountingNullableValues.runtime_observed_run_count = 0;
  accountingNullableValues.runtime_seconds = null;
  accountingNullableValues.estimated_spend_usd = null;
  add(
    "analysis-bundle-accounting-summary.schema.json",
    analysisAccountingSummarySchema,
    "nullable-runtime-and-spend",
    accountingNullableValues,
    true
  );

  const attemptUnsafeOrdinal = analysisBundleFixture("analysis-bundle-attempt-history.schema.json");
  ((attemptUnsafeOrdinal.attempts as unknown[])[0] as Record<string, unknown>).ordinal = Number.MAX_SAFE_INTEGER + 1;
  add(
    "analysis-bundle-attempt-history.schema.json",
    analysisAttemptHistorySchema,
    "unsafe-ordinal",
    attemptUnsafeOrdinal
  );
  const attemptBadTimestamp = analysisBundleFixture("analysis-bundle-attempt-history.schema.json");
  ((attemptBadTimestamp.attempts as unknown[])[0] as Record<string, unknown>).finished_at = "2026-08-09T00:00Z";
  add(
    "analysis-bundle-attempt-history.schema.json",
    analysisAttemptHistorySchema,
    "timestamp-without-seconds",
    attemptBadTimestamp
  );
  const attemptBadEnum = analysisBundleFixture("analysis-bundle-attempt-history.schema.json");
  ((attemptBadEnum.attempts as unknown[])[0] as Record<string, unknown>).workflow_status = "complete";
  add("analysis-bundle-attempt-history.schema.json", analysisAttemptHistorySchema, "unknown-status", attemptBadEnum);
  const attemptNestedUnknown = analysisBundleFixture("analysis-bundle-attempt-history.schema.json");
  ((attemptNestedUnknown.attempts as unknown[])[0] as Record<string, unknown>).other = true;
  add(
    "analysis-bundle-attempt-history.schema.json",
    analysisAttemptHistorySchema,
    "unknown-attempt-field",
    attemptNestedUnknown
  );

  const recoveryUnsafeCount = analysisBundleFixture("analysis-bundle-recovery-summary.schema.json");
  recoveryUnsafeCount.total_generations = Number.MAX_SAFE_INTEGER + 1;
  add(
    "analysis-bundle-recovery-summary.schema.json",
    analysisRecoverySummarySchema,
    "unsafe-generation-count",
    recoveryUnsafeCount
  );
  const recoveryNestedUnknown = analysisBundleFixture("analysis-bundle-recovery-summary.schema.json");
  (recoveryNestedUnknown.terminal_classes as Record<string, unknown>).other = 0;
  add(
    "analysis-bundle-recovery-summary.schema.json",
    analysisRecoverySummarySchema,
    "unknown-terminal-class",
    recoveryNestedUnknown
  );

  const duplicateOmissionKind = analysisBundleFixture("analysis-bundle-omissions.schema.json");
  (duplicateOmissionKind.omissions as unknown[]).push({
    kind: "recovery-summary",
    path: "data/recovery-summary.json",
    reason: "data-unavailable"
  });
  add(
    "analysis-bundle-omissions.schema.json",
    analysisBundleOmissionsSchema,
    "duplicate-kind-with-different-reason",
    duplicateOmissionKind
  );
  const omissionBadReason = analysisBundleFixture("analysis-bundle-omissions.schema.json");
  ((omissionBadReason.omissions as unknown[])[0] as Record<string, unknown>).reason = "legacy-source";
  add("analysis-bundle-omissions.schema.json", analysisBundleOmissionsSchema, "unknown-reason", omissionBadReason);
  const omissionNestedUnknown = analysisBundleFixture("analysis-bundle-omissions.schema.json");
  ((omissionNestedUnknown.omissions as unknown[])[0] as Record<string, unknown>).other = true;
  add(
    "analysis-bundle-omissions.schema.json",
    analysisBundleOmissionsSchema,
    "unknown-omission-field",
    omissionNestedUnknown
  );

  for (const fixture of cases) {
    assertParity(
      registeredSchemaId(fixture.filename),
      fixture.parser,
      fixture.value,
      fixture.expected,
      `${fixture.filename}:${fixture.label}`
    );
  }
});

test("analysis-bundle reconciliation is exclusively enforced by named gates and public assertions", () => {
  const terminal = analysisBundleFixture("analysis-bundle-terminal-status.schema.json");
  terminal.status = "failed";
  const evaluation = analysisBundleFixture("analysis-bundle-evaluation-metrics.schema.json");
  (evaluation.totals as Record<string, unknown>).finding_count = 2;
  const accounting = analysisBundleFixture("analysis-bundle-accounting-summary.schema.json");
  accounting.total_tokens = 14;
  const attempts = analysisBundleFixture("analysis-bundle-attempt-history.schema.json");
  ((attempts.attempts as unknown[])[0] as Record<string, unknown>).ordinal = 2;
  const recovery = analysisBundleFixture("analysis-bundle-recovery-summary.schema.json");
  recovery.total_generations = 2;
  const omissions = analysisBundleFixture("analysis-bundle-omissions.schema.json");
  omissions.omissions = [
    { kind: "recovery-summary", path: "data/recovery-summary.json", reason: "source-missing" },
    { kind: "accounting-summary", path: "data/accounting-summary.json", reason: "source-missing" }
  ];

  const cases = [
    {
      filename: "analysis-bundle-terminal-status.schema.json",
      parser: analysisTerminalStatusSchema,
      gate: "analysis-bundle-terminal-status-reconciliation" as const,
      value: terminal,
      assertion: assertAnalysisTerminalStatus
    },
    {
      filename: "analysis-bundle-evaluation-metrics.schema.json",
      parser: analysisEvaluationMetricsSchema,
      gate: "analysis-bundle-evaluation-count-reconciliation" as const,
      value: evaluation,
      assertion: assertAnalysisEvaluationMetrics
    },
    {
      filename: "analysis-bundle-accounting-summary.schema.json",
      parser: analysisAccountingSummarySchema,
      gate: "analysis-bundle-accounting-reconciliation" as const,
      value: accounting,
      assertion: assertAnalysisAccountingSummary
    },
    {
      filename: "analysis-bundle-attempt-history.schema.json",
      parser: analysisAttemptHistorySchema,
      gate: "analysis-bundle-attempt-order" as const,
      value: attempts,
      assertion: assertAnalysisAttemptHistory
    },
    {
      filename: "analysis-bundle-recovery-summary.schema.json",
      parser: analysisRecoverySummarySchema,
      gate: "analysis-bundle-recovery-reconciliation" as const,
      value: recovery,
      assertion: assertAnalysisRecoverySummary
    },
    {
      filename: "analysis-bundle-omissions.schema.json",
      parser: analysisBundleOmissionsSchema,
      gate: "analysis-bundle-omission-order" as const,
      value: omissions,
      assertion: assertAnalysisBundleOmissions
    }
  ];

  for (const fixture of cases) {
    assertParity(
      registeredSchemaId(fixture.filename),
      fixture.parser,
      fixture.value,
      true,
      `${fixture.filename}:semantic-shape`
    );
    assert.equal(executeSemanticGate(fixture.gate, { document: fixture.value }).status, "failed", fixture.filename);
    assert.throws(() => fixture.assertion(fixture.value), /schema validation failed/u, fixture.filename);
  }
});

test("projected uniqueness, joins, and ordering stay outside structural Zod while public validators run named gates", () => {
  const analysisSchemaId = registeredSchemaId("analysis-bundle.schema.json");
  const unsortedAnalysisManifest = {
    schema_version: "ultrafuzz.analysis-bundle.v1",
    policy_version: "ultrafuzz.analysis-bundle-policy.v1",
    files: [
      {
        kind: "omissions",
        path: "omissions.json",
        media_type: "application/json",
        size_bytes: 10,
        sha256: "a".repeat(64)
      },
      {
        kind: "terminal-status",
        path: "data/terminal-status.json",
        media_type: "application/json",
        size_bytes: 20,
        sha256: "b".repeat(64)
      }
    ]
  };
  assertParity(
    analysisSchemaId,
    analysisBundleManifestSchema,
    unsortedAnalysisManifest,
    true,
    "analysis-bundle:semantic-order"
  );
  assert.equal(
    executeSemanticGate("analysis-bundle-path-order", { document: unsortedAnalysisManifest }).status,
    "failed"
  );
  assert.equal(validateAnalysisBundleManifestSchema(unsortedAnalysisManifest).ok, false);

  const sourceProofSchemaId = registeredSchemaId("invariant-source-proof.schema.json");
  const duplicateSourceProof = canonicalInvariantSourceProof();
  duplicateSourceProof.files.push({ ...duplicateSourceProof.files[0]! });
  assertParity(
    sourceProofSchemaId,
    invariantSourceProofSchema,
    duplicateSourceProof,
    true,
    "invariant-source-proof:semantic-path-uniqueness"
  );
  assert.equal(
    executeSemanticGate("invariant-source-proof-path-uniqueness", { document: duplicateSourceProof }).status,
    "failed"
  );
  const sourceProofValidation = validateInvariantSourceProofSchema(duplicateSourceProof);
  assert.equal(sourceProofValidation.ok, false);
  assert.equal(sourceProofValidation.issues[0]?.path, "$.files[1].path");
  assert.match(sourceProofValidation.issues[0]?.message ?? "", /Duplicate source proof path/u);

  const workspacePatchSchemaId = registeredSchemaId("workspace-patch.schema.json");
  const duplicateWorkspacePatch = canonicalWorkspacePatch();
  duplicateWorkspacePatch.files.push({ ...duplicateWorkspacePatch.files[0]! });
  assertParity(
    workspacePatchSchemaId,
    workspacePatchSchema,
    duplicateWorkspacePatch,
    true,
    "workspace-patch:semantic-path-uniqueness"
  );
  assert.equal(
    executeSemanticGate("workspace-patch-path-uniqueness", { document: duplicateWorkspacePatch }).status,
    "failed"
  );
  const workspacePatchValidation = validateWorkspacePatchSchema(duplicateWorkspacePatch);
  assert.equal(workspacePatchValidation.ok, false);
  assert.equal(workspacePatchValidation.issues.length, 1);
  assert.equal(workspacePatchValidation.issues[0]?.path, "$.files[1].path");

  const overlappingWorkspacePatch = {
    ...canonicalWorkspacePatch(),
    excluded_files: [{ path: "foundry.toml", diff_bytes_at_least: 1, reason: "git-diff-overflow" as const }]
  };
  assertParity(
    workspacePatchSchemaId,
    workspacePatchSchema,
    overlappingWorkspacePatch,
    true,
    "workspace-patch:semantic-included-excluded-disjointness"
  );
  assert.equal(
    executeSemanticGate("workspace-patch-path-uniqueness", { document: overlappingWorkspacePatch }).status,
    "failed"
  );
  const overlappingWorkspaceValidation = validateWorkspacePatchSchema(overlappingWorkspacePatch);
  assert.equal(overlappingWorkspaceValidation.ok, false);
  assert.equal(overlappingWorkspaceValidation.issues.length, 1);
  assert.equal(overlappingWorkspaceValidation.issues[0]?.path, "$.excluded_files[0].path");
  assert.match(overlappingWorkspaceValidation.issues[0]?.message ?? "", /both included and excluded/u);

  const invariantLedgerSchemaId = registeredSchemaId("invariant-evidence-ledger.schema.json");
  const duplicateLedgerId = canonicalInvariantLedger();
  duplicateLedgerId.entries.push({ ...duplicateLedgerId.entries[0]! });
  assertParity(
    invariantLedgerSchemaId,
    invariantLedgerSchema,
    duplicateLedgerId,
    true,
    "invariant-ledger:semantic-projected-id-uniqueness"
  );
  assert.equal(
    executeSemanticGate("invariant-ledger-projected-id-uniqueness", { document: duplicateLedgerId }).status,
    "failed"
  );
  const duplicateLedgerValidation = validateInvariantLedgerSchema(duplicateLedgerId);
  assert.equal(duplicateLedgerValidation.ok, false);
  assert.equal(duplicateLedgerValidation.issues[0]?.path, "$.entries[1].id");
  assert.match(duplicateLedgerValidation.issues[0]?.message ?? "", /Duplicate ledger entry ID/u);

  const brokenLedgerJoin = canonicalInvariantLedger();
  brokenLedgerJoin.entries[0]!.inventory_ids = ["inventory-unregistered"];
  assertParity(
    invariantLedgerSchemaId,
    invariantLedgerSchema,
    brokenLedgerJoin,
    true,
    "invariant-ledger:semantic-cross-array-join"
  );
  assert.equal(executeSemanticGate("invariant-ledger-id-joins", { document: brokenLedgerJoin }).status, "failed");
  const brokenLedgerValidation = validateInvariantLedgerSchema(brokenLedgerJoin);
  assert.equal(brokenLedgerValidation.ok, false);
  assert.ok(brokenLedgerValidation.issues.some((issue) => /references unknown inventory row/u.test(issue.message)));
});

test("portable constraints remain identical in Ajv and the four retained structural Zod parsers", () => {
  const analysisManifestWithoutOmissions = {
    schema_version: "ultrafuzz.analysis-bundle.v1",
    policy_version: "ultrafuzz.analysis-bundle-policy.v1",
    files: [
      {
        kind: "terminal-status",
        path: "data/terminal-status.json",
        media_type: "application/json",
        size_bytes: 20,
        sha256: "a".repeat(64)
      }
    ]
  };
  assertParity(
    registeredSchemaId("analysis-bundle.schema.json"),
    analysisBundleManifestSchema,
    analysisManifestWithoutOmissions,
    false,
    "analysis-bundle:required-kind"
  );

  const analysisManifestWithLargeJsonInteger = {
    schema_version: "ultrafuzz.analysis-bundle.v1",
    policy_version: "ultrafuzz.analysis-bundle-policy.v1",
    files: [
      {
        kind: "omissions",
        path: "omissions.json",
        media_type: "application/json",
        size_bytes: Number.MAX_SAFE_INTEGER + 1,
        sha256: "a".repeat(64)
      }
    ]
  };
  assertParity(
    registeredSchemaId("analysis-bundle.schema.json"),
    analysisBundleManifestSchema,
    analysisManifestWithLargeJsonInteger,
    true,
    "analysis-bundle:json-integer-range"
  );

  const analysisManifestWithDuplicateKind = structuredClone(analysisManifestWithLargeJsonInteger);
  analysisManifestWithDuplicateKind.files.push({ ...analysisManifestWithDuplicateKind.files[0]! });
  assertParity(
    registeredSchemaId("analysis-bundle.schema.json"),
    analysisBundleManifestSchema,
    analysisManifestWithDuplicateKind,
    false,
    "analysis-bundle:portable-kind-cardinality"
  );

  const sourceProofWithTraversal = canonicalInvariantSourceProof();
  sourceProofWithTraversal.files[0]!.path = "docs/../secret.txt";
  assertParity(
    registeredSchemaId("invariant-source-proof.schema.json"),
    invariantSourceProofSchema,
    sourceProofWithTraversal,
    false,
    "invariant-source-proof:path-shape"
  );

  const workspacePatchWithUnsafePath = canonicalWorkspacePatch();
  workspacePatchWithUnsafePath.files[0]!.path = ".git/config";
  assertParity(
    registeredSchemaId("workspace-patch.schema.json"),
    workspacePatchSchema,
    workspacePatchWithUnsafePath,
    false,
    "workspace-patch:path-shape"
  );

  const invariantLedgerWithDuplicateScalar = canonicalInvariantLedger();
  invariantLedgerWithDuplicateScalar.entries[0]!.inventory_ids = ["inventory-solvency", "inventory-solvency"];
  assertParity(
    registeredSchemaId("invariant-evidence-ledger.schema.json"),
    invariantLedgerSchema,
    invariantLedgerWithDuplicateScalar,
    false,
    "invariant-ledger:portable-unique-items"
  );

  const emptyInvariantLedgerWithoutJustification = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [],
    inventory_rows: [],
    scan_probes: [
      {
        id: "probe-docs",
        source_path: "docs/overview.md",
        query: "invariant",
        result: "No invariant found"
      }
    ]
  };
  assertParity(
    registeredSchemaId("invariant-evidence-ledger.schema.json"),
    invariantLedgerSchema,
    emptyInvariantLedgerWithoutJustification,
    false,
    "invariant-ledger:portable-empty-ledger-conditional"
  );
});

test("Ajv and retained Zod parsers agree on canonical unique-array constraints", () => {
  const mismatches: string[] = [];
  const finding = structuredClone(
    (contractFixtures["ultrafuzz/findings@2"]!.valid as Array<Record<string, unknown>>)[0]!
  );
  finding.contributing_backend_failures = [
    {
      fuzzer_backend: "recon",
      failure_id: "backend-failure-1",
      raw_result_ref: "recon-fuzzer-results.json"
    },
    {
      fuzzer_backend: "recon",
      failure_id: "backend-failure-1",
      raw_result_ref: "recon-fuzzer-results.json"
    }
  ];

  const implementedBase = contractFixtures["ultrafuzz/implemented-properties@3"]!.valid as Record<string, unknown>;
  const implementedWithDuplicateImplementationPaths: Record<string, unknown> & {
    properties: Array<{ implementation_paths: string[]; test_paths: string[]; [key: string]: unknown }>;
  } = {
    ...structuredClone(implementedBase),
    selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
    properties: [
      {
        property_id: "property-1",
        status: "implemented",
        implementation_paths: ["test/Properties.sol", "test/Properties.sol"],
        test_paths: []
      }
    ]
  };
  const implementedWithDuplicateTestPaths = structuredClone(implementedWithDuplicateImplementationPaths);
  implementedWithDuplicateTestPaths.properties[0]!.implementation_paths = [];
  implementedWithDuplicateTestPaths.properties[0]!.test_paths = ["test/Property.t.sol", "test/Property.t.sol"];

  const report = {
    ...(structuredClone(contractFixtures["ultrafuzz/report@2"]!.valid) as Record<string, unknown>),
    property_implementation_coverage: {
      priority_threshold: "high",
      priorities: ["high", "high"],
      selected_property_ids: [],
      implemented_property_ids: [],
      blocked_property_ids: [],
      pending_property_ids: [],
      deferred_property_ids: [],
      reference_expected_property_ids: [],
      reference_expectation_ids: [],
      blocker_summaries: []
    }
  };

  for (const [filename, value, label] of [
    ["finding.schema.json", finding, "duplicate contributing_backend_failures"],
    [
      "implemented-properties.schema.json",
      implementedWithDuplicateImplementationPaths,
      "duplicate implementation_paths"
    ],
    ["implemented-properties.schema.json", implementedWithDuplicateTestPaths, "duplicate test_paths"],
    ["report.schema.json", report, "duplicate coverage priorities"]
  ] as const) {
    const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === filename);
    assert.ok(entry?.zodParser !== undefined, filename);
    const parser = (artifactExports as unknown as Record<string, unknown>)[entry.zodParser] as ZodLikeParser;
    const ajv = validateRegisteredJsonSchema(entry.id, value);
    const zod = parser.safeParse(value);
    assert.equal(ajv.ok, false, `${filename}:${label}: Ajv fixture must exercise uniqueItems`);
    if (zod.success) mismatches.push(`${filename}: ${label}`);
  }
  assert.deepEqual(mismatches, [], `Zod accepted JSON-Schema-invalid unique arrays: ${mismatches.join("; ")}`);
});

test("portable generated-test paths and implementation selection uniqueness agree bidirectionally", () => {
  const generatedEntry = artifactSchemaRegistry().find(
    (candidate) => candidate.filename === "generated-tests.schema.json"
  );
  assert.ok(generatedEntry?.zodParser !== undefined);
  const generatedParser = (artifactExports as unknown as Record<string, unknown>)[
    generatedEntry.zodParser
  ] as ZodLikeParser;
  const generated = {
    schema_version: "ultrafuzz.generated-tests.v3",
    run_id: "run-1",
    node_id: "node-1",
    framework: "foundry",
    generated_tests: [{ path: "generated-tests/nested/Invariant.t.sol", size_bytes: 1, sha256: "a".repeat(64) }],
    support_files: []
  };
  assertParity(generatedEntry.id, generatedParser, generated, true, "generated-tests:path:safe");
  const maxLengthPath = `generated-tests/${[...Array.from({ length: 31 }, () => "a".repeat(128)), "b".repeat(81)].join(
    "/"
  )}`;
  assert.equal(maxLengthPath.length, 4_096);
  for (const [label, candidatePath, expected] of [
    ["maximum-path-bytes", maxLengthPath, true],
    ["excess-path-bytes", `${maxLengthPath}b`, false],
    ["maximum-path-segments", `generated-tests/${Array.from({ length: 63 }, () => "a").join("/")}`, true],
    ["excess-path-segments", `generated-tests/${Array.from({ length: 64 }, () => "a").join("/")}`, false]
  ] as const) {
    const candidate = structuredClone(generated);
    candidate.generated_tests[0]!.path = candidatePath;
    assertParity(generatedEntry.id, generatedParser, candidate, expected, `generated-tests:path:${label}`);
  }
  for (const [label, unsafePath] of [
    ["wrong-root", "tests/Invariant.t.sol"],
    ["traversal", "generated-tests/../Invariant.t.sol"],
    ["backslash", "generated-tests/nested\\Invariant.t.sol"],
    ["oversized-segment", `generated-tests/${"a".repeat(129)}`],
    ["trailing-newline", "generated-tests/Invariant.t.sol\n"]
  ] as const) {
    const candidate = structuredClone(generated);
    candidate.generated_tests[0]!.path = unsafePath;
    assertParity(generatedEntry.id, generatedParser, candidate, false, `generated-tests:path:${label}`);
  }

  const supportEntry = {
    path: "generated-tests/nested/InvariantFixture.sol",
    size_bytes: 1,
    sha256: "b".repeat(64)
  };
  assertParity(
    generatedEntry.id,
    generatedParser,
    { ...generated, support_files: [supportEntry] },
    true,
    "generated-tests:distinct-support-file"
  );
  assertParity(
    generatedEntry.id,
    generatedParser,
    {
      ...generated,
      generated_tests: [generated.generated_tests[0], structuredClone(generated.generated_tests[0])]
    },
    false,
    "generated-tests:duplicate-generated-test-entry"
  );
  assertParity(
    generatedEntry.id,
    generatedParser,
    {
      ...generated,
      support_files: [supportEntry, { sha256: "b".repeat(64), size_bytes: 1, path: supportEntry.path }]
    },
    false,
    "generated-tests:duplicate-support-file-entry"
  );
  assertParity(
    generatedEntry.id,
    generatedParser,
    { ...generated, generated_tests: [], support_files: [supportEntry] },
    false,
    "generated-tests:support-requires-runnable-test"
  );
  const boundedEntries = Array.from({ length: 1_024 }, (_, index) => ({
    path: `generated-tests/bounded-${index}.sol`,
    size_bytes: 1,
    sha256: index.toString(16).padStart(64, "0")
  }));
  assertParity(
    generatedEntry.id,
    generatedParser,
    { ...generated, generated_tests: boundedEntries },
    true,
    "generated-tests:maximum-array-items"
  );
  assertParity(
    generatedEntry.id,
    generatedParser,
    {
      ...generated,
      generated_tests: [
        ...boundedEntries,
        { path: "generated-tests/excess.sol", size_bytes: 1, sha256: "f".repeat(64) }
      ]
    },
    false,
    "generated-tests:excess-array-items"
  );

  const implementedEntry = artifactSchemaRegistry().find(
    (candidate) => candidate.filename === "implemented-properties.schema.json"
  );
  assert.ok(implementedEntry?.zodParser !== undefined);
  const implementedParser = (artifactExports as unknown as Record<string, unknown>)[
    implementedEntry.zodParser
  ] as ZodLikeParser;
  const duplicateSelection = {
    schema_version: "ultrafuzz.implemented-properties.v3",
    selection: {
      priority_threshold: "high",
      priorities: ["high"],
      property_ids: ["property-1", "property-1"]
    },
    properties: []
  };
  assertParity(
    implementedEntry.id,
    implementedParser,
    duplicateSelection,
    false,
    "implemented-properties:duplicate-selection-property-id"
  );
});

test("run-state handwritten integer constraints match Zod's safe-integer boundary", () => {
  const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === "run-state.schema.json");
  assert.ok(entry?.zodParser !== undefined);
  const parser = (artifactExports as unknown as Record<string, unknown>)[entry.zodParser] as ZodLikeParser;
  const timestamp = "2026-08-09T00:00:00.000Z";
  const taskWorkflow = {
    run_id: "workflow-1",
    task_id: "verify:node-a",
    agent_task_id: "node:node-a",
    verifier_task_id: "verify:node-a",
    state: "finished" as const,
    attempt: 1
  };
  const base = createInitialRunState({
    runId: "run-1",
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    createdAt: timestamp,
    nodes: []
  });
  base.started_at = timestamp;
  base.finished_at = timestamp;
  base.workflow_deadline_at = timestamp;
  base.nodes["node-a"] = {
    node_id: "node-a",
    status: "succeeded",
    retry_count: 1,
    timed_out: false,
    attempt_index: 1,
    loop_index: 1,
    model_index: 1,
    started_at: timestamp,
    finished_at: timestamp,
    provenance: { workflow: taskWorkflow, findings_count: 1 }
  };
  assertParity(entry.id, parser, base, true, "run-state:safe-integer:baseline");

  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  const mutations: ReadonlyArray<{ label: string; apply: (value: typeof base) => void }> = [
    { label: "controller-duration", apply: (value) => (value.controller_lease.duration_ms = unsafe) },
    { label: "controller-recoveries", apply: (value) => (value.controller_lease.recovery_attempts = unsafe) },
    { label: "requested-concurrency", apply: (value) => (value.concurrency.requested_concurrency = unsafe) },
    { label: "effective-concurrency", apply: (value) => (value.concurrency.effective_concurrency = unsafe) },
    { label: "ready-queue", apply: (value) => (value.concurrency.ready_queue_depth = unsafe) },
    { label: "active-work", apply: (value) => (value.concurrency.active_work = unsafe) },
    { label: "queued-duration", apply: (value) => (value.concurrency.queued_duration_ms = unsafe) },
    { label: "active-duration", apply: (value) => (value.concurrency.active_duration_ms = unsafe) },
    { label: "idle-duration", apply: (value) => (value.concurrency.idle_duration_ms = unsafe) },
    { label: "node-retries", apply: (value) => (value.nodes["node-a"]!.retry_count = unsafe) },
    { label: "node-attempt", apply: (value) => (value.nodes["node-a"]!.attempt_index = unsafe) },
    { label: "node-loop", apply: (value) => (value.nodes["node-a"]!.loop_index = unsafe) },
    { label: "node-model", apply: (value) => (value.nodes["node-a"]!.model_index = unsafe) },
    {
      label: "node-findings",
      apply: (value) => (value.nodes["node-a"]!.provenance = { workflow: taskWorkflow, findings_count: unsafe })
    },
    {
      label: "task-attempt",
      apply: (value) =>
        (value.nodes["node-a"]!.provenance = {
          workflow: { ...taskWorkflow, attempt: unsafe },
          findings_count: 1
        })
    }
  ];
  for (const mutation of mutations) {
    const candidate = structuredClone(base);
    mutation.apply(candidate);
    assertParity(entry.id, parser, candidate, false, `run-state:unsafe-integer:${mutation.label}`);
  }
});

test("canonical timestamp and UUID lexical mutations agree in handwritten schemas and retained Zod", () => {
  const eventEntry = artifactSchemaRegistry().find((candidate) => candidate.filename === "event-record.schema.json");
  const attemptEntry = artifactSchemaRegistry().find(
    (candidate) => candidate.filename === "node-attempt-ledger.schema.json"
  );
  const runStateEntry = artifactSchemaRegistry().find((candidate) => candidate.filename === "run-state.schema.json");
  assert.ok(eventEntry?.zodParser !== undefined);
  assert.ok(attemptEntry?.zodParser !== undefined);
  assert.ok(runStateEntry?.zodParser !== undefined);
  const exports = artifactExports as unknown as Record<string, unknown>;
  const eventParser = exports[eventEntry.zodParser] as ZodLikeParser;
  const attemptParser = exports[attemptEntry.zodParser] as ZodLikeParser;
  const runStateParser = exports[runStateEntry.zodParser] as ZodLikeParser;

  const timestampMutations = [
    ["lowercase", "2026-08-09t00:00:00.000z"],
    ["space-separator", "2026-08-09 00:00:00.000Z"],
    ["leap-second", "2016-12-31T23:59:60Z"],
    ["missing-seconds", "2026-08-09T00:00Z"]
  ] as const;
  for (const [label, timestamp] of timestampMutations) {
    const event = zodPositiveFixture(eventEntry.filename, eventEntry.contractIds) as { timestamp: string };
    event.timestamp = timestamp;
    assertParity(eventEntry.id, eventParser, event, false, `event-record:timestamp:${label}`);

    const attempt = zodPositiveFixture(attemptEntry.filename, attemptEntry.contractIds) as {
      lifecycle: { started_at: string };
    };
    attempt.lifecycle.started_at = timestamp;
    assertParity(attemptEntry.id, attemptParser, attempt, false, `node-attempt:timestamp:${label}`);

    const state = createInitialRunState({
      runId: "run-1",
      graphFingerprint: "a".repeat(64),
      configFingerprint: "b".repeat(64),
      createdAt: "2026-08-09T00:00:00.000Z",
      nodes: []
    });
    state.created_at = timestamp;
    assertParity(runStateEntry.id, runStateParser, state, false, `run-state:timestamp:${label}`);
  }

  const validUuid = "00000000-0000-4000-8000-000000000001";
  const eventWithLink = {
    schema_version: "ultrafuzz.event-record.v2",
    event_id: `evt-${"a".repeat(24)}`,
    timestamp: "2026-08-09T00:00:00.000Z",
    run_id: "run-1",
    event_type: "workflow-link-recorded",
    status: "running",
    payload: {
      workflow_link_id: validUuid,
      action: "start",
      workflow_run_id: "workflow-1",
      control_generation: "c".repeat(64)
    }
  };
  const stateWithLink = createInitialRunState({
    runId: "run-1",
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    createdAt: "2026-08-09T00:00:00.000Z",
    nodes: [],
    provenance: {
      workflow: {
        inspection: { runId: "workflow-1" },
        runId: "workflow-1",
        compiledRunId: "workflow-1",
        name: "workflow",
        controlGeneration: "c".repeat(64),
        linkId: validUuid,
        executionSnapshot: `smithers/execution-snapshots/${"d".repeat(64)}`
      }
    }
  });
  assertParity(eventEntry.id, eventParser, eventWithLink, true, "event-record:uuid:valid-v4");
  assertParity(runStateEntry.id, runStateParser, stateWithLink, true, "run-state:uuid:valid-v4");
  for (const [label, uuid] of [
    ["unsupported-version", "00000000-0000-9000-8000-000000000001"],
    ["invalid-variant", "00000000-0000-4000-7000-000000000001"]
  ] as const) {
    const event = structuredClone(eventWithLink);
    event.payload.workflow_link_id = uuid;
    assertParity(eventEntry.id, eventParser, event, false, `event-record:uuid:${label}`);
    const state = structuredClone(stateWithLink);
    state.provenance!.workflow.linkId = uuid;
    assertParity(runStateEntry.id, runStateParser, state, false, `run-state:uuid:${label}`);
  }
});

test("every retained Zod timestamp and UUID field publishes its canonical lexical pattern", () => {
  let audited = 0;
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${String(index)}`));
      return;
    }
    if (!isRecord(value)) return;
    if (value.format === "date-time" || value.format === "uuid") {
      audited += 1;
      assert.equal(
        value.pattern,
        value.format === "date-time" ? CANONICAL_TIMESTAMP_PATTERN : CANONICAL_UUID_PATTERN,
        path
      );
    }
    for (const [key, item] of Object.entries(value)) visit(item, `${path}/${key}`);
  };

  for (const entry of artifactSchemaRegistry()) {
    if (entry.zodParser !== undefined) visit(entry.schema, entry.filename);
  }
  assert.ok(audited > 0);
});

test("JSON Schema maxLength and retained Zod count Unicode code points identically", () => {
  const usageEntry = artifactSchemaRegistry().find((candidate) => candidate.filename === "usage-ledger.schema.json");
  const attemptEntry = artifactSchemaRegistry().find(
    (candidate) => candidate.filename === "node-attempt-ledger.schema.json"
  );
  assert.ok(usageEntry?.zodParser !== undefined);
  assert.ok(attemptEntry?.zodParser !== undefined);
  const exports = artifactExports as unknown as Record<string, unknown>;
  const usageParser = exports[usageEntry.zodParser] as ZodLikeParser;
  const attemptParser = exports[attemptEntry.zodParser] as ZodLikeParser;

  for (const field of ["model", "agent"] as const) {
    const boundary = zodPositiveFixture(usageEntry.filename, usageEntry.contractIds) as {
      usage: { model: string; agent: string };
    };
    boundary.usage[field] = "🙂".repeat(1_024);
    assertParity(usageEntry.id, usageParser, boundary, true, `usage-ledger:${field}:astral-boundary`);
    const overflow = structuredClone(boundary);
    overflow.usage[field] += "🙂";
    assertParity(usageEntry.id, usageParser, overflow, false, `usage-ledger:${field}:astral-overflow`);
  }

  const failedAttempt = zodPositiveFixture(attemptEntry.filename, attemptEntry.contractIds) as Record<
    string,
    unknown
  > & { manifests: { output_sha256: string | null }; failure_message?: string };
  failedAttempt.outcome = "failed";
  failedAttempt.manifests.output_sha256 = null;
  failedAttempt.failure_category = "executor-error";
  failedAttempt.failure_message = "🙂".repeat(1_000);
  assertParity(
    attemptEntry.id,
    attemptParser,
    failedAttempt,
    true,
    "node-attempt:failure-message:astral-structural-boundary"
  );
  const overflowAttempt = structuredClone(failedAttempt);
  overflowAttempt.failure_message += "🙂";
  assertParity(
    attemptEntry.id,
    attemptParser,
    overflowAttempt,
    false,
    "node-attempt:failure-message:astral-structural-overflow"
  );
});

test("run-state v5 JSON Schema and Zod agree on every closed provenance variant", () => {
  const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === "run-state.schema.json");
  assert.ok(entry?.zodParser !== undefined);
  const parser = (artifactExports as unknown as Record<string, unknown>)[entry.zodParser] as ZodLikeParser;
  const base = createInitialRunState({
    runId: "run-1",
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    nodes: []
  });
  const withNodeProvenance = (provenance: unknown): unknown => ({
    ...base,
    nodes: {
      "node-1": {
        node_id: "node-1",
        status: "succeeded",
        retry_count: 0,
        timed_out: false,
        provenance
      }
    }
  });
  const taskWorkflow = {
    run_id: "workflow-1",
    task_id: "verify:node-1",
    agent_task_id: "node:node-1",
    verifier_task_id: "verify:node-1",
    state: "finished",
    attempt: 1
  };
  const cases: Array<{ label: string; value: unknown; expected: boolean }> = [
    {
      label: "run-workflow",
      value: {
        ...base,
        provenance: {
          workflow: {
            inspection: { runId: "workflow-1" },
            runId: "workflow-1",
            compiledRunId: "workflow-1",
            name: "workflow",
            controlGeneration: "c".repeat(64),
            linkId: "00000000-0000-4000-8000-000000000001",
            executionSnapshot: `smithers/execution-snapshots/${"d".repeat(64)}`
          }
        }
      },
      expected: true
    },
    {
      label: "execution-task",
      value: withNodeProvenance({
        workflow: taskWorkflow,
        output_contracts: { ok: true, missing: [], artifact_manifest_sha256: "a".repeat(64) },
        findings_count: 0
      }),
      expected: true
    },
    {
      label: "execution-aggregate",
      value: withNodeProvenance({
        workflow: { run_id: "workflow-1", aggregate_attempt_statuses: ["failed", "succeeded"] }
      }),
      expected: true
    },
    {
      label: "execution-dynamic-lineage",
      value: withNodeProvenance({ source_node_id: "threat-model" }),
      expected: true
    },
    {
      label: "reference",
      value: withNodeProvenance({
        origin: "pinned-reference",
        reference: "baseline",
        repo: "https://example.invalid/reference.git",
        commit: "e".repeat(40),
        reference_expectations: {
          source: "operator-supplied",
          path: "references/expectations.json",
          sha256: "f".repeat(64)
        }
      }),
      expected: true
    },
    {
      label: "blocked",
      value: withNodeProvenance({
        reason_code: "DEPENDENCY_NOT_SATISFIED",
        blocked_by: ["dependency-1"]
      }),
      expected: true
    },
    {
      label: "legacy-generic-object",
      value: withNodeProvenance({ arbitrary: { nested: true } }),
      expected: false
    },
    {
      label: "partial-task-identity",
      value: withNodeProvenance({ workflow: { run_id: "workflow-1", task_id: "node:node-1" } }),
      expected: false
    },
    {
      label: "empty-aggregate",
      value: withNodeProvenance({ workflow: { run_id: "workflow-1", aggregate_attempt_statuses: [] } }),
      expected: false
    },
    {
      label: "empty-dynamic-lineage",
      value: withNodeProvenance({ source_node_id: "" }),
      expected: false
    },
    {
      label: "partial-reference-revision",
      value: withNodeProvenance({ origin: "pinned-reference", reference: "baseline", repo: "repo" }),
      expected: false
    },
    {
      label: "empty-blocker-list",
      value: withNodeProvenance({ reason_code: "DEPENDENCY_NOT_SATISFIED", blocked_by: [] }),
      expected: false
    },
    {
      label: "duplicate-output-missing-path",
      value: withNodeProvenance({
        workflow: taskWorkflow,
        output_contracts: { ok: false, missing: ["result.json", "result.json"] }
      }),
      expected: false
    }
  ];

  for (const fixture of cases) {
    assertParity(entry.id, parser, fixture.value, fixture.expected, `run-state:${fixture.label}`);
  }
});

test("run-state node map-key equality is exclusively a named semantic gate", () => {
  const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === "run-state.schema.json");
  assert.ok(entry?.zodParser !== undefined);
  const parser = (artifactExports as unknown as Record<string, unknown>)[entry.zodParser] as ZodLikeParser;
  const state = createInitialRunState({
    runId: "run-1",
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    createdAt: "2026-08-09T00:00:00.000Z",
    nodes: []
  });
  state.nodes["map-key"] = {
    node_id: "different-node-id",
    status: "succeeded",
    retry_count: 0,
    timed_out: false
  };

  assertParity(entry.id, parser, state, true, "run-state:semantic-node-map-key");
  const gate = executeSemanticGate("run-state-node-key-equality", { document: state });
  assert.equal(gate.status, "failed");
  if (gate.status === "failed") {
    assert.equal(gate.issues.length, 1);
    assert.equal(gate.issues[0]?.path, "$.nodes.map-key.node_id");
  }
});

test("node-attempt JSON Schema and Zod agree on portable outcome conditionals", () => {
  const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === "node-attempt-ledger.schema.json");
  assert.ok(entry?.zodParser !== undefined);
  const parser = (artifactExports as unknown as Record<string, unknown>)[entry.zodParser] as ZodLikeParser;
  const succeeded = zodPositiveFixture(entry.filename, entry.contractIds) as Record<string, unknown>;
  const failed = {
    ...structuredClone(succeeded),
    outcome: "failed",
    manifests: { input_sha256: "a".repeat(64), output_sha256: null },
    failure_category: "executor-error"
  };
  const reused = {
    ...structuredClone(succeeded),
    outcome: "reused",
    reuse: {
      status: "reused",
      source: { workflow_run_id: "workflow-source", source_event_sequence: 1 }
    }
  };
  const failedWithoutCategory = structuredClone(failed) as Record<string, unknown>;
  delete failedWithoutCategory.failure_category;
  const cases: Array<{ label: string; value: unknown; expected: boolean }> = [
    { label: "succeeded", value: succeeded, expected: true },
    {
      label: "succeeded-null-output",
      value: { ...structuredClone(succeeded), manifests: { input_sha256: "a".repeat(64), output_sha256: null } },
      expected: false
    },
    {
      label: "succeeded-failure-detail",
      value: { ...structuredClone(succeeded), failure_category: "executor-error" },
      expected: false
    },
    { label: "failed", value: failed, expected: true },
    { label: "failed-missing-category", value: failedWithoutCategory, expected: false },
    { label: "reused", value: reused, expected: true },
    {
      label: "reused-executed-status",
      value: { ...structuredClone(reused), reuse: { status: "executed" } },
      expected: false
    },
    {
      label: "reused-null-output",
      value: { ...structuredClone(reused), manifests: { input_sha256: "a".repeat(64), output_sha256: null } },
      expected: false
    },
    {
      label: "semantic-order-is-shape-valid",
      value: {
        ...structuredClone(succeeded),
        started_event_sequence: 3,
        source_event_sequence: 2,
        lifecycle: {
          started_at: "2026-08-09T00:02:00.000Z",
          finished_at: "2026-08-09T00:01:00.000Z"
        }
      },
      expected: true
    },
    {
      label: "semantic-byte-limit-is-shape-valid",
      value: { ...structuredClone(failed), failure_message: "🙂".repeat(251) },
      expected: true
    }
  ];

  for (const fixture of cases) {
    assertParity(entry.id, parser, fixture.value, fixture.expected, `node-attempt:${fixture.label}`);
  }
});

function assertParity(schemaId: string, parser: ZodLikeParser, value: unknown, expected: boolean, label: string): void {
  const before = structuredClone(value);
  const ajv = validateRegisteredJsonSchema(schemaId, value);
  const zod = parser.safeParse(value);
  assert.equal(ajv.ok, expected, `${label}: Ajv ${JSON.stringify(ajv.issues)}`);
  assert.equal(zod.success, expected, `${label}: Zod disagreed with Ajv`);
  assert.deepEqual(value, before, `${label}: validation mutated its input`);
  if (zod.success) assert.deepEqual(zod.data, value, `${label}: retained Zod parser transformed its input`);
}

function zodPositiveFixture(filename: string, contractIds: readonly string[]): unknown {
  if (contractIds.length === 1) {
    const fixture = contractFixtures[contractIds[0]!];
    if (fixture === undefined) throw new Error(`Missing contract fixture for ${contractIds[0]}`);
    return fixture.valid;
  }
  switch (filename) {
    case "analysis-bundle-accounting-summary.schema.json":
      return {
        schema_version: "ultrafuzz.analysis-bundle.v1",
        run_count: 1,
        accounted_run_count: 1,
        runtime_observed_run_count: 1,
        runtime_seconds: 2,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_write_tokens: 4,
        reasoning_tokens: 5,
        total_tokens: 15,
        estimated_spend_usd: 0.25,
        partial_pricing: false,
        event_count: 1,
        priced_event_count: 1,
        unpriced_event_count: 0
      };
    case "analysis-bundle-attempt-history.schema.json":
      return {
        schema_version: "ultrafuzz.analysis-bundle.v1",
        attempts: [
          {
            ordinal: 1,
            launcher_status: "launched",
            workflow_status: "succeeded",
            started_at: "2026-08-09T00:00:00.000Z",
            finished_at: "2026-08-09T00:00:01.000Z"
          }
        ]
      };
    case "analysis-bundle-evaluation-metrics.schema.json":
      return {
        schema_version: "ultrafuzz.analysis-bundle.v1",
        row_count: 1,
        totals: {
          ground_truth_bug_count: 1,
          finding_count: 1,
          true_positives: 1,
          false_positives: 0,
          missed: 0,
          human_review_queue_count: 0,
          duplicate_count: 0
        },
        metrics: {
          precision: 1,
          recall: 1,
          f1_score: 1,
          full_match_rate: 1,
          severity_accuracy: 1,
          true_positive_accuracy: 1,
          duplicate_rate: 0,
          report_schema_valid_rate: 1
        }
      };
    case "analysis-bundle-omissions.schema.json":
      return {
        schema_version: "ultrafuzz.analysis-bundle.v1",
        omissions: [
          {
            kind: "recovery-summary",
            path: "data/recovery-summary.json",
            reason: "source-missing"
          }
        ]
      };
    case "analysis-bundle-recovery-summary.schema.json":
      return {
        schema_version: "ultrafuzz.analysis-bundle.v1",
        total_generations: 1,
        terminal_generations: 1,
        active_generations: 0,
        progress_generations: 1,
        no_progress_generations: 0,
        unknown_progress_generations: 0,
        model_work_generations: 1,
        no_model_work_generations: 0,
        unknown_model_work_generations: 0,
        genuine_failures: 0,
        rotations: 0,
        resumptions: 0,
        start_reasons: {
          initial: 1,
          "pre-model-retry": 0,
          "post-model-resume": 0,
          "image-rollout": 0,
          "stale-probe-rotation": 0,
          "operator-restart": 0,
          unknown: 0
        },
        terminal_reasons: {
          active: 0,
          succeeded: 1,
          "genuine-worker-failure": 0,
          "operational-failure": 0,
          "image-rollout": 0,
          "stale-probe-rotation": 0,
          "operator-request": 0,
          timeout: 0,
          "resource-termination": 0,
          "recovery-budget-exhausted": 0,
          unknown: 0
        },
        terminal_classes: {
          active: 0,
          succeeded: 1,
          "genuine-worker-failure": 0,
          "operational-failure": 0,
          "controller-rotation": 0,
          timeout: 0,
          "resource-termination": 0,
          "recovery-budget-exhausted": 0,
          unknown: 0
        }
      };
    case "analysis-bundle-terminal-status.schema.json":
      return {
        schema_version: "ultrafuzz.analysis-bundle.v1",
        terminal: true,
        status: "succeeded",
        run_count: 1,
        status_counts: {
          pending: 0,
          running: 0,
          paused: 0,
          succeeded: 1,
          failed: 0,
          "timed-out": 0,
          canceled: 0,
          unknown: 0
        },
        started_at: "2026-08-09T00:00:00.000Z",
        finished_at: "2026-08-09T00:00:01.000Z"
      };
    case "analysis-bundle.schema.json":
      return {
        schema_version: "ultrafuzz.analysis-bundle.v1",
        policy_version: "ultrafuzz.analysis-bundle-policy.v1",
        files: [
          {
            kind: "omissions",
            path: "omissions.json",
            media_type: "application/json",
            size_bytes: 10,
            sha256: "a".repeat(64)
          }
        ]
      };
    case "finding.schema.json":
      return (contractFixtures["ultrafuzz/findings@2"]!.valid as unknown[])[0];
    case "event-query-facade.schema.json":
      return {
        schema_version: "ultrafuzz.event-query-facade.v1",
        run_id: "run-1",
        append_log: "events.jsonl",
        index_root: "events.index",
        indexes: ["run", "node", "type", "status", "timestamp"],
        filters: {
          run_id: "events.index/run/<run-id>.jsonl",
          node_id: "events.index/node/<node-id>.jsonl",
          event_type: "events.index/type/<event-type>.jsonl",
          status: "events.index/status/<status>.jsonl",
          timestamp: "events.index/timestamp/<yyyy-mm-dd>.jsonl"
        },
        long_filters: {
          run_id: "events.index/run/sha256/<sha256-hex(run-id)>.jsonl",
          node_id: "events.index/node/sha256/<sha256-hex(node-id)>.jsonl",
          event_type: "events.index/type/sha256/<sha256-hex(event-type)>.jsonl",
          status: "events.index/status/sha256/<sha256-hex(status)>.jsonl"
        },
        index_key_encoding: {
          version: "ultrafuzz.event-index-key.v1",
          direct_max_id_length: 122,
          direct_id_path: "<dimension>/<id>.jsonl",
          long_id_path: "<dimension>/sha256/<sha256-hex(id)>.jsonl",
          digest: "sha256",
          hash_input_encoding: "utf8",
          digest_encoding: "hex"
        }
      };
    case "event-record.schema.json":
      return {
        schema_version: "ultrafuzz.event-record.v2",
        event_id: `evt-${"a".repeat(24)}`,
        timestamp: "2026-08-09T00:00:00.000Z",
        run_id: "run-1",
        event_type: "workflow-synced",
        status: "running",
        payload: {
          workflow_run_id: "workflow-1",
          workflow_status: "running",
          workflow_state: "running",
          synced_nodes: 1,
          accounting_available: true,
          recovery_due: false,
          deadline_exceeded: false
        }
      };
    case "invariant-source-proof.schema.json":
      return {
        schema_version: "ultrafuzz.invariant-source-proof.v1",
        attempt_id: "project-discovery",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        ledger_sha256: "c".repeat(64),
        files: [{ path: "docs/overview.md", sha256: "d".repeat(64), content: "Invariant source text" }]
      };
    case "node-attempt-ledger.schema.json":
      return {
        schema_version: "ultrafuzz.node-attempt-ledger.v1",
        run_id: "run-1",
        workflow_run_id: "workflow-1",
        control_generation: "c".repeat(64),
        node_id: "node-1",
        strategy_attempt_id: "strategy-1",
        iteration: 0,
        attempt: 1,
        started_event_sequence: 1,
        source_event_sequence: 2,
        lifecycle: {
          started_at: "2026-08-09T00:00:00.000Z",
          finished_at: "2026-08-09T00:01:00.000Z"
        },
        outcome: "succeeded",
        reuse: { status: "executed" },
        manifests: { input_sha256: "a".repeat(64), output_sha256: "b".repeat(64) }
      };
    case "run-state.schema.json":
      return createInitialRunState({
        runId: "run-1",
        graphFingerprint: "graph-fingerprint",
        configFingerprint: "config-fingerprint",
        nodes: []
      });
    case "terminal-disposition.schema.json":
      return {
        schema_version: "ultrafuzz.terminal-disposition.v1",
        kind: "task-output-validation-failure"
      };
    case "usage-ledger.schema.json":
      return {
        schema_version: "ultrafuzz.usage-ledger.v1",
        run_id: "run-1",
        workflow_run_id: "workflow-1",
        control_generation: "c".repeat(64),
        source_event_sequence: 3,
        observed_timestamp_ms: Date.parse("2026-08-09T00:00:00.000Z"),
        node_id: "node:1",
        iteration: 0,
        attempt: 1,
        usage: { model: "model", agent: "agent", input_tokens: 1, output_tokens: 2 }
      };
    default:
      throw new Error(`Missing retained-Zod positive fixture for ${filename}`);
  }
}

function invalidRootFixture(value: unknown): unknown {
  if (isRecord(value)) return { ...value, __unexpected_fixture_field: true };
  return null;
}

function analysisBundleFixture(filename: string): Record<string, unknown> {
  const fixture = zodPositiveFixture(filename, []);
  assert.ok(isRecord(fixture), `${filename}: expected an object fixture`);
  return structuredClone(fixture);
}

function duplicateFixtureJson(value: unknown): string | undefined {
  if (isRecord(value)) return duplicateObjectJson(value);
  if (Array.isArray(value) && isRecord(value[0])) return `[${duplicateObjectJson(value[0])}]`;
  return undefined;
}

function duplicateObjectJson(value: Record<string, unknown>): string {
  const key = Object.keys(value)[0];
  assert.ok(key !== undefined);
  const serialized = JSON.stringify(value);
  return `{${JSON.stringify(key)}:${JSON.stringify(value[key])},${serialized.slice(1)}`;
}

function registeredSchemaId(filename: string): string {
  const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === filename);
  assert.ok(entry, `Missing registered schema ${filename}`);
  return entry.id;
}

function canonicalInvariantSourceProof() {
  return {
    schema_version: "ultrafuzz.invariant-source-proof.v1" as const,
    attempt_id: "project-discovery",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    ledger_sha256: "c".repeat(64),
    files: [{ path: "docs/overview.md", sha256: "d".repeat(64), content: "Invariant source text" }]
  };
}

function canonicalWorkspacePatch() {
  return {
    schema_version: "ultrafuzz.workspace-patch.v1" as const,
    base_commit: "a".repeat(40),
    base_tree: "b".repeat(40),
    result_tree: "c".repeat(40),
    patch_sha256: "d".repeat(64),
    source_snapshot: { status: "preserved" as const, protected_roots: ["contracts", "src"] },
    files: [{ path: "foundry.toml" }]
  };
}

function canonicalInvariantLedger() {
  return {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1" as const,
    entries: [
      {
        id: "evidence-1",
        source_path: "docs/overview.md",
        source_location: "line 10",
        kind: "invariant" as const,
        verbatim: "Assets remain solvent",
        inventory_ids: ["inventory-solvency"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-solvency",
        description: "Solvency invariant",
        ledger_ids: ["evidence-1"]
      }
    ],
    scan_probes: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
