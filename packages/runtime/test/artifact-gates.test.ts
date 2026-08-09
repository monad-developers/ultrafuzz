import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactContractDefinition,
  artifactContractSchemaBinding,
  artifactSchemaDirectory,
  createInitialRunState,
  createRunLayout,
  getNodeArtifactDir,
  readRunState,
  validateRegisteredJsonFileSync,
  writeArtifact as writeArtifactFile,
  writeRunState,
  writeArtifactManifest
} from "@ultrafuzz/artifacts";
import { loadBuiltInPromptAssets } from "@ultrafuzz/prompts";

import {
  CAMPAIGN_LOGICAL_NODE_IDS,
  dependencyGateForNode,
  verifyRequiredArtifactsForAttempt,
  type PlannedGraphNode
} from "../src/index.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-gates-"));
}

/**
 * Real planned runs record every logical producer in state before any artifact
 * gate executes. These focused fixtures write producer artifacts directly, so
 * keep the state index in sync instead of relying on the removed historical
 * artifact-directory fallback.
 */
function registerArtifactNode(layout: ReturnType<typeof createRunLayout>, nodeId: string): void {
  const state = readRunState(layout);
  if (state.nodes[nodeId] !== undefined) return;
  state.nodes[nodeId] = {
    node_id: nodeId,
    logical_node_id: nodeId,
    status: "succeeded",
    retry_count: 0,
    timed_out: false
  };
  writeRunState(layout, state);
}

function writeArtifact(
  layout: ReturnType<typeof createRunLayout>,
  nodeId: string,
  artifactPath: string,
  contents: string
): string {
  registerArtifactNode(layout, nodeId);
  return writeArtifactFile(layout, nodeId, artifactPath, contents);
}

function boundOutput(
  artifactPath: string,
  contract: PlannedGraphNode["outputs"][number]["contract"],
  primary = false
): PlannedGraphNode["outputs"][number] {
  return {
    path: artifactPath,
    contract,
    contract_digest: artifactContractDefinition(contract).digest,
    ...(artifactContractSchemaBinding(contract) ?? {}),
    primary
  };
}

function currentFinding(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.finding.v2",
    id,
    title: "Property failure",
    status: "confirmed",
    severity_guess: "Medium",
    confidence: "high",
    summary: "The property failed.",
    ...overrides
  };
}

function currentReport(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.report.v2",
    run_metadata: {
      run_id: runId,
      source_run_id: runId,
      repository: ".",
      elapsed_time: "0s",
      models_used: [],
      tokens_used: "0",
      estimated_spend: "$0",
      partial_pricing: false,
      strategy_loops: 1
    },
    issues: [],
    non_production_outcomes: [],
    property_provenance: [],
    ...overrides
  };
}

function currentNonProductionOutcome(id: string, sourceFindingId: string): Record<string, unknown> {
  return currentFinding(id, {
    title: "Non-production outcome",
    triage_classification: "undetermined",
    recommended_next_action: "Review the campaign evidence.",
    lifecycle: {
      dedupe_key: `dedupe-${id}`,
      source_artifacts: [
        {
          path: "findings.json",
          node_id: "stateful-invariant-campaign",
          finding_id: sourceFindingId,
          title: "Property failure",
          relationship: "primary"
        }
      ],
      strategy_hits: []
    }
  });
}

function currentImplementedCoverage(propertyIds: string[]): Record<string, unknown> {
  return {
    priority_threshold: "high",
    priorities: ["high"],
    selected_property_ids: propertyIds,
    implemented_property_ids: propertyIds,
    blocked_property_ids: [],
    pending_property_ids: [],
    deferred_property_ids: [],
    reference_expected_property_ids: [],
    reference_expectation_ids: [],
    blocker_summaries: []
  };
}

// A discovery workspace as a benchmark run sees it: a Git worktree whose pinned branch exists and
// whose tracked sources match it exactly.
function pinnedDiscoveryWorkspace(layout: ReturnType<typeof createRunLayout>): string {
  const workspace = path.join(layout.workspacesDir, "project-discovery");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "Counter.sol"), "contract Counter {}\n");
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: workspace, stdio: ["ignore", "ignore", "ignore"] });
  };
  git(["init", "--quiet", "--initial-branch=ultrafuzz-pinned"]);
  git(["config", "user.name", "Ultrafuzz test"]);
  git(["config", "user.email", "ultrafuzz@example.invalid"]);
  git(["add", "src/Counter.sol"]);
  git(["commit", "--quiet", "-m", "pinned"]);
  return workspace;
}

function invariantProbeLedger(probes: readonly Record<string, string>[]): string {
  return JSON.stringify({
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [],
    // This fixture exercises scan-probe containment only, so it carries no
    // invariant entries and must say why (#292).
    no_invariants_justification:
      "the pinned scan probe fixture exercises probe containment only and declares no invariant",
    inventory_rows: [],
    scan_probes: probes
  });
}

function plannedNode(paths: string[]): PlannedGraphNode {
  return {
    id: "strategy-a",
    logical_id: "strategy-a",
    display_name: "Strategy A",
    kind: "agentic",
    depends_on: [],
    artifact_dir: "artifacts/strategy-a",
    outputs: paths.map((outputPath, index) => {
      const contract =
        outputPath === "workspace-patch.json"
          ? "ultrafuzz/workspace-patch@1"
          : outputPath === "generated-tests.json"
            ? "ultrafuzz/generated-tests@2"
            : outputPath === "findings.json"
              ? "ultrafuzz/findings@2"
              : outputPath === "properties.json"
                ? "ultrafuzz/properties@2"
                : outputPath === "implemented-properties.json"
                  ? "ultrafuzz/implemented-properties@3"
                  : outputPath === "setup/invariant-evidence-ledger.json"
                    ? "ultrafuzz/invariant-ledger@1"
                    : outputPath.startsWith("properties/") && outputPath.endsWith(".json")
                      ? "ultrafuzz/property-lens@2"
                      : ["echidna-results.json", "medusa-results.json", "recon-fuzzer-results.json"].includes(
                            outputPath
                          )
                        ? "ultrafuzz/property-campaign@2"
                        : outputPath === "campaign-summary.json"
                          ? "ultrafuzz/campaign-summary@2"
                          : outputPath === "report.json"
                            ? "ultrafuzz/report@2"
                            : "ultrafuzz/nonempty-markdown@1";
      return boundOutput(outputPath, contract, index === 0);
    }),
    prompt_id: "strategy-a",
    prompt_path: "strategies/strategy-a.md",
    loop: {
      index: 0,
      count: 1,
      mode: "parallel",
      attempt_index: 0
    },
    model_fanout: []
  };
}

test("the campaign provenance gate covers the campaign node the shipped topology runs", () => {
  // Guards the regression this list fixes: the gate was previously keyed on a
  // logical ID the default topology does not contain, so campaign property
  // joins went unverified. A node rename must not silently reintroduce that.
  // The runtime build copies the shipped topology to dist/topology.yml, so this
  // asserts against the exact file the package ships.
  const topologyPath = path.join(import.meta.dirname, "..", "..", "dist", "topology.yml");
  const topologySource = fs.readFileSync(topologyPath, "utf8");
  const campaignIds = [...topologySource.matchAll(/^ {2}- id: (\S+)$/gmu)]
    .map((match) => match[1]!)
    .filter((id) => id.startsWith("stateful-invariant-") && id.includes("campaign"));

  assert.ok(campaignIds.length > 0, "shipped topology declares no invariant campaign node");
  for (const campaignId of campaignIds) {
    assert.ok(
      CAMPAIGN_LOGICAL_NODE_IDS.some((gated) => gated === campaignId),
      `topology campaign node ${campaignId} is not covered by the provenance gate`
    );
  }
});

test("required artifact gate validates generated-test manifest shape and listed files", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const manifestPath = path.join(artifactDir, "generated-tests.json");
  const node = plannedNode(["generated-tests.json"]);

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema_version: "ultrafuzz.generated-tests.v2",
      run_id: "run-1",
      node_id: "strategy-a",
      test_files: [{ path: "generated-tests/Invariant.t.sol" }]
    }),
    "utf8"
  );

  const legacy = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(legacy.ok, false);
  assert.ok(legacy.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema_version: "ultrafuzz.generated-tests.v2",
      run_id: "run-1",
      node_id: "strategy-a",
      generated_tests: [{ path: "generated-tests/Invariant.t.sol" }]
    }),
    "utf8"
  );

  const missingFile = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(missingFile.ok, false);
  assert.ok(missingFile.diagnostics.some((diagnostic) => diagnostic.code === "GENERATED_TEST_FILE_MISSING"));

  fs.mkdirSync(path.join(artifactDir, "generated-tests"), { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "generated-tests", "Invariant.t.sol"), "", "utf8");

  const emptyFile = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(emptyFile.ok, false);
  assert.ok(emptyFile.diagnostics.some((diagnostic) => diagnostic.code === "GENERATED_TEST_FILE_EMPTY"));

  fs.writeFileSync(path.join(artifactDir, "generated-tests", "Invariant.t.sol"), "contract InvariantTest {}\n", "utf8");

  const valid = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.deepEqual(valid.diagnostics, []);
  assert.equal(valid.ok, true);
});

test("workspace patch exclusions pass the contract gate but surface a durable warning", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-workspace-exclusion" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const node = plannedNode(["workspace-patch.json"]);
  fs.writeFileSync(
    path.join(artifactDir, "workspace-patch.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.workspace-patch.v1",
      base_commit: "a".repeat(40),
      base_tree: "b".repeat(40),
      result_tree: "c".repeat(40),
      patch_sha256: "d".repeat(64),
      files: [{ path: "test/Handlers.t.sol" }],
      excluded_files: [
        {
          path: "test/recon/corpus-deep/seed.bin",
          diff_bytes_at_least: 33_865_139,
          reason: "git-diff-overflow"
        }
      ]
    }),
    "utf8"
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(result.ok, true);
  const warning = result.diagnostics.find((entry) => entry.code === "WORKSPACE_PATCH_FILES_EXCLUDED");
  assert.equal(warning?.severity, "warning");
  assert.match(warning?.message ?? "", /test\/recon\/corpus-deep\/seed\.bin/u);
  assert.deepEqual(warning?.details?.excluded_files, [
    {
      path: "test/recon/corpus-deep/seed.bin",
      diff_bytes_at_least: 33_865_139,
      reason: "git-diff-overflow"
    }
  ]);
});

test("required artifact gate rejects contract-invalid empty files and final-component symlinks", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const artifactPath = path.join(artifactDir, "output.json");
  const node = plannedNode(["output.json"]);

  fs.writeFileSync(artifactPath, "", "utf8");
  const empty = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.missing, []);
  assert.ok(empty.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_MARKDOWN_EMPTY"));

  fs.rmSync(artifactPath);
  const outside = path.join(tempProject(), "outside.json");
  fs.writeFileSync(outside, "outside\n", "utf8");
  fs.symlinkSync(outside, artifactPath);
  const symlink = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(symlink.ok, false);
  assert.ok(symlink.diagnostics.some((diagnostic) => diagnostic.code === "symlink-escape"));
});

test("artifact contracts reject malformed outputs and accept canonical empty outputs", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-contracts" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const node = plannedNode(["findings.json", "notes.md"]);

  fs.writeFileSync(path.join(artifactDir, "findings.json"), "{}", "utf8");
  fs.writeFileSync(path.join(artifactDir, "notes.md"), "", "utf8");
  const malformed = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(malformed.ok, false);
  assert.ok(malformed.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));
  assert.ok(malformed.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_MARKDOWN_EMPTY"));

  fs.writeFileSync(path.join(artifactDir, "findings.json"), "[]", "utf8");
  fs.writeFileSync(path.join(artifactDir, "notes.md"), "# No findings\n", "utf8");
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, "strategy-a").ok, true);
});

test("project discovery gate requires ledger evidence to survive in the markdown handoff", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-ledger-markdown" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery",
    artifact_dir: "artifacts/project-discovery"
  };
  const sourceDir = path.join(layout.workspacesDir, node.id, "docs");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "overview.md"),
    `${"\n".repeat(53)}Total borrowed assets <= total supplied assets; source text mentions ### End ledger entry: evidence-borrowed-assets inline.\n`,
    "utf8"
  );
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-borrowed-assets",
        source_path: "docs/overview.md",
        source_location: "lines 54-55",
        kind: "inequality",
        verbatim:
          "Total borrowed assets <= total supplied assets; source text mentions ### End ledger entry: evidence-borrowed-assets inline.",
        inventory_ids: ["inventory-hub-solvency"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-hub-solvency",
        description: "Hub borrowed assets remain at or below supplied assets.",
        ledger_ids: ["evidence-borrowed-assets"]
      }
    ],
    scan_probes: []
  };
  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(
    layout,
    "project-discovery",
    "setup/project-discovery.md",
    [
      "# Discovery",
      "### Ledger entry: evidence-borrowed-assets",
      "- source_path: docs/overview.md",
      "- source_location: lines 54-55",
      "- kind: inequality",
      "- verbatim: Total borrowed assets <= total supplied assets; source text mentions ### End ledger entry: evidence-borrowed-assets inline.",
      "- inventory_ids: inventory-hub-solvency",
      "### End ledger entry: evidence-borrowed-assets",
      "### Inventory row: inventory-hub-solvency",
      "- description: Hub borrowed assets remain at or below supplied assets.",
      "- ledger_ids: evidence-borrowed-assets",
      "### End inventory row: inventory-hub-solvency"
    ].join("\n")
  );

  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, true);

  const symbolMismatchLedger = structuredClone(ledger);
  symbolMismatchLedger.entries[0]!.source_location = "function Hub.totalBorrowed";
  symbolMismatchLedger.entries[0]!.verbatim = "This text is not present in the source";
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify(symbolMismatchLedger)
  );
  const symbolMismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(symbolMismatch.ok, false);
  assert.ok(
    symbolMismatch.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_TEXT_MISMATCH")
  );

  const missingSourceLedger = structuredClone(ledger);
  missingSourceLedger.entries[0]!.source_path = "docs/missing.md";
  const missingSourcePath = writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify(missingSourceLedger)
  );
  assert.equal(
    validateRegisteredJsonFileSync({
      schemaPath: path.join(artifactSchemaDirectory(), "invariant-evidence-ledger.schema.json"),
      filePath: missingSourcePath
    }).status,
    "valid",
    "portable document shape must pass before the named filesystem context gate"
  );
  const missingSource = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingSource.ok, false);
  assert.ok(missingSource.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_MISSING"));

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", "{");
  const malformedLedger = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(malformedLedger.ok, false);
  assert.ok(malformedLedger.diagnostics.some((diagnostic) => diagnostic.code === "JSON_INSTANCE_INVALID"));

  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      scan_probes: []
    })
  );
  const emptyLedger = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(emptyLedger.ok, false);
  assert.ok(emptyLedger.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));

  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "The documentation set states no invariant; only prose overviews are present.",
      scan_probes: [
        {
          id: "probe-docs-no-invariants",
          source_path: "docs/overview.md",
          query: "invariant|accounting|solvency",
          result: "No explicit invariant statements found"
        }
      ]
    })
  );
  const explicitNoEvidence = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(explicitNoEvidence.ok, true, JSON.stringify(explicitNoEvidence.diagnostics));

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(
    layout,
    "project-discovery",
    "setup/project-discovery.md",
    "# Discovery\nevidence-borrowed-assets\ndocs/overview.md\nlines 54-55\n"
  );
  const missingEvidence = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingEvidence.ok, false);
  assert.ok(
    missingEvidence.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING")
  );
});

test("artifact validation rejects a persisted schema binding that differs from the current registry", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-schema-binding-mismatch" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const node = plannedNode(["findings.json"]);
  node.outputs[0]!.schema_sha256 = "0".repeat(64);
  fs.writeFileSync(path.join(artifactDir, "findings.json"), "[]\n", "utf8");

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_SCHEMA_BINDING_MISMATCH"));
});

test("project discovery gate accepts a repository-root scan probe", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-root-probe" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const discoveryWorkspace = path.join(layout.workspacesDir, "project-discovery");
  fs.mkdirSync(discoveryWorkspace, { recursive: true });
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "The repository-wide scan found no invariant statement to record.",
      scan_probes: [
        {
          id: "probe-repository-root",
          source_path: ".",
          query: "repository-wide invariant inventory",
          result: "Repository-wide scan completed"
        }
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

// Issue #292: this is the exact artifact from the report. An empty ledger whose only evidence is
// probe text nothing reads used to satisfy both evidence gates, because the gate enforced the SHAPE
// of the emptiness rather than asking anyone to stand behind it. Emptiness stays reachable, but only
// as an explicit, auditable claim.
test("project discovery gate rejects an empty ledger that does not justify the absence", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-unjustified-empty" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  fs.mkdirSync(path.join(layout.workspacesDir, "project-discovery"), { recursive: true });
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  const ledger = (justification?: string) =>
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      ...(justification === undefined ? {} : { no_invariants_justification: justification }),
      // The issue's literal `"id": "p1"` no longer passes the `^probe-` pattern; everything else
      // about the reported artifact, including the invented result text, is reproduced verbatim.
      scan_probes: [{ id: "probe-p1", source_path: ".", query: "invariant", result: "invented result text" }]
    });

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", ledger());
  const unjustified = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(unjustified.ok, false, JSON.stringify(unjustified.diagnostics));
  assert.ok(
    unjustified.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"),
    JSON.stringify(unjustified.diagnostics)
  );

  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    ledger("This target is a pure library of pure functions and states no invariant of its own.")
  );
  const justified = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(justified.ok, true, JSON.stringify(justified.diagnostics));

  // A justification on a ledger that DOES carry entries is contradictory, so the schema refuses it
  // rather than letting both readings of the artifact coexist.
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-1",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "invariant",
          verbatim: "Total borrowed <= total supplied",
          inventory_ids: ["inventory-1"]
        }
      ],
      inventory_rows: [{ id: "inventory-1", description: "Solvency", ledger_ids: ["evidence-1"] }],
      no_invariants_justification: "Contradicts the entries above.",
      scan_probes: []
    })
  );
  const contradictory = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(contradictory.ok, false);
  assert.ok(
    contradictory.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"),
    JSON.stringify(contradictory.diagnostics)
  );
});

// R45's `project-discovery` died on `artifact-contract failure: invariant scan probe tests is
// unavailable: scan probe is not a regular file` (issue #289). A scan probe records WHERE the agent
// searched, and a directory like `tests/` is a perfectly reasonable thing to have scanned. The
// repository-root probe above is already accepted on exactly that reasoning; a subdirectory was not.
test("project discovery gate accepts a directory scan probe", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-directory-probe" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const discoveryWorkspace = path.join(layout.workspacesDir, "project-discovery");
  fs.mkdirSync(path.join(discoveryWorkspace, "tests"), { recursive: true });
  fs.writeFileSync(path.join(discoveryWorkspace, "tests", "Base.t.sol"), "contract Base {}\n");
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "The tests directory carries no invariant statement to record.",
      scan_probes: [
        {
          id: "probe-tests-directory",
          source_path: "tests",
          query: "invariant harness scan",
          result: "Scanned the tests directory"
        }
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"),
    false,
    JSON.stringify(result.diagnostics)
  );
});

// A symlink that resolves to a directory is deliberately NOT a directory probe: the allowance keys on
// `lstat`, so a leaf symlink cannot be used to reach outside the workspace unread.
test("project discovery gate rejects a symlinked-directory scan probe", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-symlinked-probe" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const discoveryWorkspace = path.join(layout.workspacesDir, "project-discovery");
  fs.mkdirSync(path.join(discoveryWorkspace, "tests"), { recursive: true });
  fs.symlinkSync(path.join(discoveryWorkspace, "tests"), path.join(discoveryWorkspace, "tests-alias"), "dir");
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      scan_probes: [
        {
          id: "probe-tests-alias",
          source_path: "tests-alias",
          query: "invariant harness scan",
          result: "Scanned the tests directory"
        }
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"),
    JSON.stringify(result.diagnostics)
  );
});

// Issue #301: the generated workflow refuses a scan probe whose source is not tracked, unmodified,
// and byte-identical to the pinned commit, but the gate did no Git check at all. A probe naming an
// existing-but-untracked file therefore passed `ultrafuzz validate` and then killed the node mid-run.
// Both sites now call the shared validator, so the gate predicts what the run enforces.
test("project discovery gate rejects an untracked scan probe source in a pinned workspace", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-unpinned-probe" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const discoveryWorkspace = pinnedDiscoveryWorkspace(layout);
  fs.mkdirSync(path.join(discoveryWorkspace, "out"), { recursive: true });
  fs.writeFileSync(path.join(discoveryWorkspace, "out", "Counter.json"), '{"abi":[]}\n');
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    invariantProbeLedger([
      {
        id: "probe-generated-abi",
        source_path: "out/Counter.json",
        query: "invariant harness scan",
        result: "Scanned the generated ABI"
      }
    ])
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_SOURCE_UNPINNED"),
    JSON.stringify(result.diagnostics)
  );
});

// The mirrored rule must not over-fire: a tracked, unmodified, pinned probe source is exactly what
// the run accepts, so the gate has to accept it too.
test("project discovery gate accepts a pinned and unchanged scan probe source", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-pinned-probe" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  pinnedDiscoveryWorkspace(layout);
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    invariantProbeLedger([
      {
        id: "probe-counter",
        source_path: "src/Counter.sol",
        query: "invariant harness scan",
        result: "Scanned the counter source"
      }
    ])
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

// An invariant SOURCE is different: its bytes are the evidence, so a directory must still be refused.
// The ledger here is schema-valid and its markdown handoff is complete, so the directory source is the
// only thing left that can fail the gate.
test("project discovery gate still rejects a directory invariant source", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-directory-source" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const discoveryWorkspace = path.join(layout.workspacesDir, "project-discovery");
  fs.mkdirSync(path.join(discoveryWorkspace, "src"), { recursive: true });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/project-discovery.md",
    [
      "# Discovery",
      "### Ledger entry: evidence-directory-source",
      "- source_path: src",
      "- source_location: line 1",
      "- kind: inequality",
      "- verbatim: contract Hub {}",
      "- inventory_ids: inventory-hub-solvency",
      "### End ledger entry: evidence-directory-source",
      "### Inventory row: inventory-hub-solvency",
      "- description: Hub borrowed assets remain at or below supplied assets.",
      "- ledger_ids: evidence-directory-source",
      "### End inventory row: inventory-hub-solvency"
    ].join("\n")
  );
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-directory-source",
          source_path: "src",
          source_location: "line 1",
          kind: "inequality",
          verbatim: "contract Hub {}",
          inventory_ids: ["inventory-hub-solvency"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-hub-solvency",
          description: "Hub borrowed assets remain at or below supplied assets.",
          ledger_ids: ["evidence-directory-source"]
        }
      ],
      scan_probes: []
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SCHEMA_INVALID"),
    false,
    JSON.stringify(result.diagnostics)
  );
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "not-file"),
    JSON.stringify(result.diagnostics)
  );
});

test("project discovery gate rejects root-normalizing traversal and a symlinked workspace root", () => {
  const traversalLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-root-traversal" });
  const traversalNode = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  fs.mkdirSync(path.join(traversalLayout.workspacesDir, "project-discovery"), { recursive: true });
  writeArtifact(traversalLayout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    traversalLayout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      scan_probes: [
        { id: "probe-traversal", source_path: "foo/..", query: "inventory", result: "done" },
        { id: "probe-drive", source_path: "C:/outside", query: "inventory", result: "done" },
        { id: "probe-backslash", source_path: "C:\\\\outside", query: "inventory", result: "done" },
        { id: "probe-absolute", source_path: "/outside", query: "inventory", result: "done" },
        { id: "probe-nul", source_path: "missing\u0000path", query: "inventory", result: "done" }
      ]
    })
  );
  const traversal = verifyRequiredArtifactsForAttempt(traversalLayout, traversalNode, traversalNode.id);
  assert.equal(traversal.ok, false);
  assert.ok(traversal.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"));

  const canonicalWorkspace = path.join(traversalLayout.workspacesDir, "project-discovery");
  fs.symlinkSync(path.join(canonicalWorkspace, "missing-target"), path.join(canonicalWorkspace, "broken"), "dir");
  writeArtifact(
    traversalLayout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      scan_probes: [
        { id: "probe-broken-parent", source_path: "broken/optional.txt", query: "inventory", result: "absent" }
      ]
    })
  );
  const brokenParent = verifyRequiredArtifactsForAttempt(traversalLayout, traversalNode, traversalNode.id);
  assert.equal(brokenParent.ok, false);
  assert.ok(brokenParent.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"));

  const symlinkLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-root-symlink" });
  const symlinkNode = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  fs.symlinkSync(tempProject(), path.join(symlinkLayout.workspacesDir, "project-discovery"), "dir");
  writeArtifact(symlinkLayout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    symlinkLayout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      scan_probes: [{ id: "probe-root", source_path: ".", query: "inventory", result: "done" }]
    })
  );
  const symlink = verifyRequiredArtifactsForAttempt(symlinkLayout, symlinkNode, symlinkNode.id);
  assert.equal(symlink.ok, false);
  assert.ok(symlink.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"));
});

test("project discovery gate verifies immutable source proof after the discovery workspace is reclaimed", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-source-proof" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-solvency",
        source_path: "docs/overview.md",
        source_location: "lines 1-1",
        kind: "inequality",
        verbatim: "Total borrowed assets <= total supplied assets",
        inventory_ids: ["inventory-solvency"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-solvency",
        description: "Borrowed assets stay below supplied assets.",
        ledger_ids: ["evidence-solvency"]
      }
    ],
    scan_probes: [
      {
        id: "probe-repository-root",
        source_path: ".",
        query: "repository-wide invariant inventory",
        result: "Repository-wide scan completed"
      }
    ]
  };
  const ledgerBytes = Buffer.from(JSON.stringify(ledger));
  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", ledgerBytes.toString("utf8"));
  writeArtifact(
    layout,
    "project-discovery",
    "setup/project-discovery.md",
    "### Ledger entry: evidence-solvency\nsource_path: docs/overview.md\nsource_location: lines 1-1\nverbatim: Total borrowed assets <= total supplied assets\ninventory-solvency\n### End ledger entry: evidence-solvency\n### Inventory row: inventory-solvency\ndescription: Borrowed assets stay below supplied assets.\nledger_ids: evidence-solvency\n### End inventory row: inventory-solvency\n"
  );
  const source = "Total borrowed assets <= total supplied assets\n";
  fs.mkdirSync(path.join(layout.root, "source-proofs"), { recursive: true });
  fs.writeFileSync(
    path.join(layout.root, "source-proofs", "project-discovery.invariant.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-source-proof.v1",
      attempt_id: "project-discovery",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      ledger_sha256: createHash("sha256").update(ledgerBytes).digest("hex"),
      files: [{ path: "docs/overview.md", sha256: createHash("sha256").update(source).digest("hex"), content: source }]
    })
  );
  fs.rmSync(path.join(layout.workspacesDir, "project-discovery"), { recursive: true, force: true });
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, true);

  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      ...ledger,
      scan_probes: [{ id: "probe-unsafe", source_path: "../../outside", query: "inventory", result: "done" }]
    })
  );
  const unsafeRecoveredProbe = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(unsafeRecoveredProbe.ok, false);
  assert.ok(
    unsafeRecoveredProbe.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID")
  );

  fs.writeFileSync(path.join(layout.root, "source-proofs", "project-discovery.invariant.json"), "{}");
  const invalidProof = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(invalidProof.ok, false);
  assert.ok(invalidProof.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_PROOF_INVALID"));
});

test("project discovery gate preserves repeated backslashes in Markdown formula evidence", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-escaped-formula" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const source = "$$ minLB = (maxLB - 100\\\\%) \\\\times lbFactor + 100\\\\% $$\n";
  const sourceDir = path.join(layout.workspacesDir, node.id, "docs");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "overview.md"), source, "utf8");
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-min-lb-formula",
        source_path: "docs/overview.md",
        source_location: "line 1",
        kind: "bound",
        verbatim: source.trim(),
        inventory_ids: ["inventory-min-lb-formula"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-min-lb-formula",
        description: "The minimum liquidation bonus uses the documented lower-bound formula.",
        ledger_ids: ["evidence-min-lb-formula"]
      }
    ],
    scan_probes: []
  };
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(
    layout,
    node.id,
    "setup/project-discovery.md",
    [
      "### Ledger entry: evidence-min-lb-formula",
      "source_path: docs/overview.md",
      "source_location: line 1",
      `verbatim: ${source.trim()}`,
      "inventory-min-lb-formula",
      "### End ledger entry: evidence-min-lb-formula",
      "### Inventory row: inventory-min-lb-formula",
      "description: The minimum liquidation bonus uses the documented lower-bound formula.",
      "ledger_ids: evidence-min-lb-formula",
      "### End inventory row: inventory-min-lb-formula"
    ].join("\n")
  );

  const valid = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  const collapsedSpacing = structuredClone(ledger);
  collapsedSpacing.entries[0]!.verbatim = source.trim().replace("lbFactor +", "lbFactor+");
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(collapsedSpacing));
  const spacingMismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(spacingMismatch.ok, false);
  assert.ok(
    spacingMismatch.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_TEXT_MISMATCH")
  );

  const collapsed = structuredClone(ledger);
  collapsed.entries[0]!.verbatim = source.trim().replaceAll("\\\\", "\\");
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(collapsed));
  const invalid = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_TEXT_MISMATCH"));
});

test("project discovery gate parses source text containing a closing ledger marker", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-marker-collision" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery",
    artifact_dir: "artifacts/project-discovery"
  };
  const verbatim = "Total borrowed assets <= total supplied assets\n### End ledger entry: evidence-marker";
  const sourceDir = path.join(layout.workspacesDir, node.id, "docs");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "overview.md"), `${verbatim}\n`, "utf8");
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-marker",
        source_path: "docs/overview.md",
        source_location: "lines 1-2",
        kind: "inequality",
        verbatim,
        inventory_ids: ["inventory-marker"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-marker",
        description: "The source statement remains linked to its inventory row.",
        ledger_ids: ["evidence-marker"]
      }
    ],
    scan_probes: []
  };
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(
    layout,
    node.id,
    "setup/project-discovery.md",
    [
      "### Ledger entry: evidence-marker",
      "source_path: docs/overview.md",
      "source_location: lines 1-2",
      `verbatim: ${verbatim}`,
      "inventory-marker",
      "### End ledger entry: evidence-marker",
      "### Inventory row: inventory-marker",
      "description: The source statement remains linked to its inventory row.",
      "ledger_ids: evidence-marker",
      "### End inventory row: inventory-marker"
    ].join("\n")
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  writeArtifact(
    layout,
    node.id,
    "setup/project-discovery.md",
    [
      "### Ledger entry (malformed): evidence-marker",
      "source_path: docs/overview.md",
      "source_location: lines 1-2",
      "verbatim: Total borrowed assets <= total supplied assets",
      "  not-a-structural-closer",
      "inventory-marker",
      "### Inventory row: inventory-marker",
      "description: The source statement remains linked to its inventory row.",
      "ledger_ids: evidence-marker",
      "### End inventory row: inventory-marker",
      "### End inventory row: inventory-marker"
    ].join("\n")
  );
  const missingCloser = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingCloser.ok, false);
  assert.ok(
    missingCloser.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING")
  );
});

test("project discovery gate normalizes multiline Markdown presentation prefixes consistently", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-multiline-prefix" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const source = "- first invariant\n- second invariant\n";
  const sourceDir = path.join(layout.workspacesDir, node.id, "docs");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "overview.md"), source, "utf8");
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-multiline-prefix",
        source_path: "docs/overview.md",
        source_location: "lines 1-2",
        kind: "invariant",
        verbatim: source.trim(),
        inventory_ids: ["inventory-multiline-prefix"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-multiline-prefix",
        description: "Both source bullets remain linked to one inventory row.",
        ledger_ids: ["evidence-multiline-prefix"]
      }
    ],
    scan_probes: []
  };
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(
    layout,
    node.id,
    "setup/project-discovery.md",
    [
      "### Ledger entry: evidence-multiline-prefix",
      "source_path: docs/overview.md",
      "source_location: lines 1-2",
      `verbatim: ${source.trim()}`,
      "inventory-multiline-prefix",
      "### End ledger entry: evidence-multiline-prefix",
      "### Inventory row: inventory-multiline-prefix",
      "description: Both source bullets remain linked to one inventory row.",
      "ledger_ids: evidence-multiline-prefix",
      "### End inventory row: inventory-multiline-prefix"
    ].join("\n")
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test("project discovery gate preserves symbol evidence whitespace", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-symbol-whitespace" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const verbatim = "function foo  () external {\n  return;\n}";
  const sourceDir = path.join(layout.workspacesDir, node.id, "src");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "Hub.sol"), `${verbatim}\n`, "utf8");
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-symbol-whitespace",
        source_path: "src/Hub.sol",
        source_location: "function foo",
        kind: "invariant",
        verbatim,
        inventory_ids: ["inventory-symbol-whitespace"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-symbol-whitespace",
        description: "The symbol declaration remains linked to its source evidence.",
        ledger_ids: ["evidence-symbol-whitespace"]
      }
    ],
    scan_probes: []
  };
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(
    layout,
    node.id,
    "setup/project-discovery.md",
    [
      "### Ledger entry: evidence-symbol-whitespace",
      "source_path: src/Hub.sol",
      "source_location: function foo",
      `verbatim: ${verbatim}`,
      "inventory-symbol-whitespace",
      "### End ledger entry: evidence-symbol-whitespace",
      "### Inventory row: inventory-symbol-whitespace",
      "description: The symbol declaration remains linked to its source evidence.",
      "ledger_ids: evidence-symbol-whitespace",
      "### End inventory row: inventory-symbol-whitespace"
    ].join("\n")
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

// Surfaced while settling issue #292 and independent of the empty-ledger question: every shape of
// the ledger returned before fan-in reached a `verifyInvariantProbePath` call, so fan-in checked
// probe containment for no shape at all. An escaping probe path only ever had to survive the
// discovery node, and fan-in re-reads that same artifact without re-checking it.
test("fanin gate checks scan probe containment against the discovery workspace", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-fanin-probe-containment" });
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };
  fs.mkdirSync(path.join(layout.workspacesDir, "project-discovery"), { recursive: true });
  const ledger = (probePath: string) =>
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "Discovery found no invariant statement in this target.",
      scan_probes: [{ id: "probe-1", source_path: probePath, query: "invariant", result: "nothing found" }]
    });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "A canonical property with no ledger evidence behind it.",
          category: "hub-accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-1\n- description: A canonical property with no ledger evidence behind it.\n- category: hub-accounting\n- priority: high\n- sources: property-specification-recon:recon-1\n### End canonical property: property-1\n"
  );

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", ledger("."));
  const contained = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(contained.ok, true, JSON.stringify(contained.diagnostics));

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", ledger("../../outside"));
  const escaping = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(escaping.ok, false, JSON.stringify(escaping.diagnostics));
  assert.ok(
    escaping.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"),
    JSON.stringify(escaping.diagnostics)
  );

  // Fan-in is the second gate that reads this artifact, and issue #292's whole point is that the
  // ledger must have ONE reading at both of them. Discovery's copy of this rule was covered; this
  // one was not, so deleting the fan-in call broke nothing.
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      scan_probes: [{ id: "probe-1", source_path: ".", query: "invariant", result: "nothing found" }]
    })
  );
  const unjustified = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(unjustified.ok, false, JSON.stringify(unjustified.diagnostics));
  assert.ok(
    unjustified.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_NO_INVARIANTS_UNJUSTIFIED"),
    JSON.stringify(unjustified.diagnostics)
  );
});

test("fanin gate requires every invariant ledger entry to map to a canonical property", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-ledger-properties" });
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-borrowed-assets",
        source_path: "docs/overview.md",
        source_location: "lines 54-55",
        kind: "inequality",
        verbatim: "Total borrowed assets <= total supplied assets",
        inventory_ids: ["inventory-hub-solvency"]
      },
      {
        id: "evidence-borrowed-shares",
        source_path: "docs/overview.md",
        source_location: "line 56",
        kind: "invariant",
        verbatim: "Total borrowed shares == total minted debt shares",
        inventory_ids: ["inventory-hub-borrowed-shares"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-hub-solvency",
        description: "Hub borrowed assets remain at or below supplied assets.",
        ledger_ids: ["evidence-borrowed-assets"]
      },
      {
        id: "inventory-hub-borrowed-shares",
        description: "Borrowed share accounting remains consistent.",
        ledger_ids: ["evidence-borrowed-shares"]
      }
    ],
    scan_probes: []
  };
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };
  const missingUpstreamLedger = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingUpstreamLedger.ok, false);
  assert.ok(missingUpstreamLedger.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MISSING"));
  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  const catalog = (ledgerIds: string[]) =>
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Total borrowed assets remain at or below total supplied assets.",
          category: "hub-accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }],
          ledger_ids: ledgerIds
        }
      ]
    });

  writeArtifact(layout, "property-specification-fanin", "properties.json", catalog(["evidence-borrowed-assets"]));
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-1\n- description: Total borrowed assets remain at or below total supplied assets.\n- category: hub-accounting\n- priority: high\n- sources: property-specification-recon:recon-1\n- ledger_ids: evidence-borrowed-assets\n### End canonical property: property-1\n"
  );
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, false);
  const missingMapping = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.ok(missingMapping.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_REFERENCE_MISSING"));

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    catalog(["evidence-borrowed-assets", "evidence-borrowed-shares"])
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-1\n- description: Total borrowed assets remain at or below total supplied assets.\n- category: hub-accounting\n- priority: high\n- sources: property-specification-recon:recon-1\n- ledger_ids: evidence-borrowed-assets, evidence-borrowed-shares\n### End canonical property: property-1\n"
  );
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, true);

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-1\n- description: Total borrowed assets remain at or below total supplied assets.\n- category: hub-accounting\n- priority: high\n- sources: property-specification-recon:recon-1\n- ledger_ids: missing mapping\n### End canonical property: property-1\n"
  );
  const missingMarkdownMapping = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingMarkdownMapping.ok, false);
  assert.ok(
    missingMarkdownMapping.diagnostics.some(
      (diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING"
    )
  );

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    catalog(["evidence-borrowed-assets", "evidence-unknown"])
  );
  const unknownMapping = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(unknownMapping.ok, false);
  assert.ok(unknownMapping.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_REFERENCE_UNKNOWN"));
});

test("property fan-in gate rejects Markdown that omits source-only canonical rows", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-markdown-parity" });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-borrowed-assets",
          source_path: "docs/overview.md",
          source_location: "line 55",
          kind: "invariant",
          verbatim: "Total borrowed assets remain below supplied assets.",
          inventory_ids: ["inventory-hub-solvency"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-hub-solvency",
          description: "Hub borrowed assets remain at or below supplied assets.",
          ledger_ids: ["evidence-borrowed-assets"]
        }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Total borrowed assets | supplied assets remain bounded.",
          category: "hub-accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }],
          ledger_ids: ["evidence-borrowed-assets"]
        },
        {
          id: "property-2",
          description: "Supply share price and drawn index do not decrease.",
          category: "monotonicity",
          priority: "high",
          sources: [{ source_node_id: "property-specification-aviggiano", source_property_id: "aviggiano-2" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-1\n- description: Total borrowed assets \\| supplied assets remain bounded.\n- category: hub-accounting\n- priority: high\n- sources: property-specification-recon:recon-1\n- ledger_ids: evidence-borrowed-assets\n### End canonical property: property-1\n"
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"));

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Total borrowed assets | supplied assets remain bounded.",
          category: "hub-accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }],
          ledger_ids: ["evidence-borrowed-assets"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-1\n- description: Total borrowed assets \\| supplied assets remain bounded.\n- category: hub-accounting\n- priority: high\n- ledger_ids: evidence-borrowed-assets\n### End canonical property: property-1\n"
  );
  const missingSources = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingSources.ok, false);
  assert.ok(
    missingSources.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING" &&
        diagnostic.message.includes("property-specification-recon:recon-1")
    )
  );

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-1\n- description: Total borrowed assets remain at or below supplied assets; evidence-borrowed-assets\n- category: hub-accounting\n- priority: high\n- sources: property-specification-recon:recon-1\n- ledger_ids: evidence-other\n### End canonical property: property-1\n"
  );
  const missingLedgerField = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingLedgerField.ok, false);
  assert.ok(
    missingLedgerField.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING")
  );

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-1\n- description: Total borrowed assets remain at or below supplied assets.\n- category: hub-accounting\n- priority: high\n- sources: property-specification-recon:recon-1<br>property-specification-extra:extra-1\n- ledger_ids: evidence-borrowed-assets, evidence-extra\n### End canonical property: property-1\n"
  );
  const extraMappings = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(extraMappings.ok, false);
  assert.ok(extraMappings.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_EXTRA"));
  assert.ok(
    extraMappings.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_EXTRA")
  );

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-1\n- description: Total borrowed assets remain at or below supplied assets. extra\n- category: hub-accounting extra\n- priority: high extra\n- sources: property-specification-recon:recon-1<br>property-specification-recon:recon-1\n- ledger_ids: evidence-borrowed-assets, evidence-borrowed-assets\n### End canonical property: property-1\n"
  );
  const duplicateAndScalarDrift = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(duplicateAndScalarDrift.ok, false);
  assert.ok(
    duplicateAndScalarDrift.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING")
  );
  assert.ok(
    duplicateAndScalarDrift.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_EXTRA")
  );
  assert.ok(
    duplicateAndScalarDrift.diagnostics.some(
      (diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_EXTRA"
    )
  );

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-1\n| ID | property-2 |\n- description: Total borrowed assets | supplied assets remain bounded.\n- category: hub-accounting\n- priority: high\n- sources: property-specification-recon:recon-1\n- ledger_ids: evidence-borrowed-assets\n### End canonical property: property-1\n### Canonical property: property-extra\n### End canonical property: property-extra\n### Canonical property: property-1\n### End canonical property: property-1\n"
  );
  const headingParity = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(headingParity.ok, false);
  assert.ok(headingParity.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_CANONICAL_UNKNOWN"));
  assert.ok(
    headingParity.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_CANONICAL_DUPLICATE")
  );
  assert.ok(headingParity.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"));
});

// R45 and R46 both lost a full `property-specification-fanin` attempt to this (issue #297). Read from
// R46's own artifacts: 219 canonical properties, 78 with a non-empty `ledger_ids`, and the markdown
// renders the field exactly 78 times. The model did what the prompt asks -- "add a `ledger_ids` array to
// every canonical property THAT REPRESENTS one or more ledger entries" -- and what the schema allows,
// since `ledger_ids` is `.optional()`. Only the gate demanded the field unconditionally.
test("property fan-in gate does not demand a ledger_ids field from a property that has none", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-ledger-optional" });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-supply",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "invariant",
          verbatim: "Supply accounting remains consistent.",
          inventory_ids: ["inventory-supply"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-supply",
          description: "Supply accounting remains consistent.",
          ledger_ids: ["evidence-supply"]
        }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-from-lens-only",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-supply" }]
        },
        {
          id: "property-from-ledger",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-accounting" }],
          ledger_ids: ["evidence-supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    [
      "### Canonical property: property-from-lens-only",
      "- description: Supply completes for valid state.",
      "- category: dos-liveness",
      "- priority: high",
      "- sources: property-specification-recon:recon-supply",
      "### End canonical property: property-from-lens-only",
      "### Canonical property: property-from-ledger",
      "- description: Supply accounting remains consistent.",
      "- category: accounting",
      "- priority: high",
      "- sources: property-specification-recon:recon-accounting",
      "- ledger_ids: evidence-supply",
      "### End canonical property: property-from-ledger"
    ].join("\n")
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING" && diagnostic.message.includes('"ledger_ids"')
    ),
    false,
    JSON.stringify(result.diagnostics)
  );
});

// The other half: a property that DOES have ledger IDs must still render them, so this cannot be read
// as dropping ledger parity altogether.
test("property fan-in gate still requires the ledger_ids field when the property has ledger IDs", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-ledger-required" });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-supply",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "invariant",
          verbatim: "Supply accounting remains consistent.",
          inventory_ids: ["inventory-supply"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-supply",
          description: "Supply accounting remains consistent.",
          ledger_ids: ["evidence-supply"]
        }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-from-ledger",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-accounting" }],
          ledger_ids: ["evidence-supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    [
      "### Canonical property: property-from-ledger",
      "- description: Supply accounting remains consistent.",
      "- category: accounting",
      "- priority: high",
      "- sources: property-specification-recon:recon-accounting",
      "### End canonical property: property-from-ledger"
    ].join("\n")
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING" && diagnostic.message.includes('"ledger_ids"')
    ),
    JSON.stringify(result.diagnostics)
  );
});

test("property fan-in gate ignores optional Markdown ledger evidence when checking ledger ID parity", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-ledger-evidence" });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-supply",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "invariant",
          verbatim: "Supply accounting remains consistent.",
          inventory_ids: ["inventory-supply"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-supply",
          description: "Supply accounting remains consistent.",
          ledger_ids: ["evidence-supply"]
        }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-supply",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-supply" }],
          ledger_ids: ["evidence-supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    [
      "### Canonical property: property-supply",
      "- description: Supply accounting remains consistent.",
      "- category: accounting",
      "- priority: high",
      "- sources: property-specification-recon:recon-supply",
      "- ledger_ids: evidence-supply",
      '- ledger_evidence: {"id":"evidence-supply","source_path":"docs/overview.md","source_location":"line 1"}',
      "### End canonical property: property-supply"
    ].join("\n")
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  for (const evidenceField of ["- ledger evidence:", "| ledger-evidence retained:", "ledger_evidence:"]) {
    writeArtifact(
      layout,
      "property-specification-fanin",
      "properties.md",
      [
        "### Canonical property: property-supply",
        "- description: Supply accounting remains consistent.",
        "- category: accounting",
        "- priority: high",
        "- sources: property-specification-recon:recon-supply",
        "- ledger_ids: evidence-supply",
        evidenceField,
        '  {"id":"evidence-supply",',
        '  "source_path":"docs/overview.md",',
        '  "source_location":"line 1"}',
        "### End canonical property: property-supply"
      ].join("\n")
    );
    const multilineResult = verifyRequiredArtifactsForAttempt(layout, node, node.id);
    assert.equal(multilineResult.ok, true, `${evidenceField}: ${JSON.stringify(multilineResult.diagnostics)}`);
  }

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    [
      "### Canonical property: property-supply",
      "- description: Supply accounting remains consistent.",
      "- category: accounting",
      "- priority: high",
      "- sources: property-specification-recon:recon-supply",
      "- ledger_ids: evidence-supply, evidence-extra",
      "- ledger evidence:",
      '  {"id":"evidence-supply",',
      '  "source_path":"docs/overview.md",',
      '  "source_location":"line 1"}',
      "### End canonical property: property-supply"
    ].join("\n")
  );
  const extraLedgerResult = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(extraLedgerResult.ok, false);
  assert.ok(
    extraLedgerResult.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_EXTRA")
  );
});

test("property fan-in gate preserves reference expectation metadata in Markdown", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-reference-parity" });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-supply",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "liveness",
          verbatim: "Supply completes for valid state.",
          inventory_ids: ["inventory-supply"]
        }
      ],
      inventory_rows: [
        { id: "inventory-supply", description: "Supply remains live.", ledger_ids: ["evidence-supply"] }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"],
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "iSpoke_supply" }],
          ledger_ids: ["evidence-supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-recon",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "reference-properties-recon",
    "references/recon.md",
    "# Examples\n\nFor example, `scfuzzbench:aave-v4:iSpoke_supply` may be used when a supplied benchmark catalog names it.\n"
  );
  writeArtifact(
    layout,
    "reference-properties-recon",
    "references/expectations.json",
    JSON.stringify({
      schema_version: "ultrafuzz.reference-expectations.v2",
      expectations: [{ id: "scfuzzbench:aave-v4:iSpoke_supply" }]
    })
  );
  writeArtifact(
    layout,
    "project-discovery",
    "setup/arbitrary.json",
    JSON.stringify({ expectations: [{ id: "scfuzzbench:aave-v4:iSpoke_supply" }] })
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin",
    depends_on: ["property-specification-recon"]
  };
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-supply\n- description: Supply completes for valid state.\n- category: dos-liveness\n- priority: medium\n- sources: property-specification-recon:iSpoke_supply\n- ledger_ids: evidence-supply\n### End canonical property: property-supply\n"
  );
  const missing = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"));

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-supply\n- description: Supply completes for valid state.\n- category: dos-liveness\n- priority: medium\n- sources: property-specification-recon:iSpoke_supply\n- ledger_ids: evidence-supply\n- reference_expectations: scfuzzbench:aave-v4:iSpoke_supply\n### End canonical property: property-supply\n"
  );
  const valid = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  writeArtifact(
    layout,
    "property-specification-recon",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "medium"
        }
      ]
    })
  );
  const droppedFromLens = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(droppedFromLens.ok, false);
  assert.ok(
    droppedFromLens.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_DROPPED"),
    JSON.stringify(droppedFromLens.diagnostics)
  );
});

test("property lens gate accepts a bound pinned expectation catalog without rewriting the lens", () => {
  const expectationId = "scfuzzbench:aave-v4:iSpoke_supply";
  const catalog = JSON.stringify({
    schema_version: "ultrafuzz.reference-expectations.v2",
    expectations: [{ id: expectationId }]
  });
  const catalogDigest = createHash("sha256").update(catalog).digest("hex");
  const catalogOutput = boundOutput("references/expectations.json", "ultrafuzz/reference-expectations@2");
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-properties-reference-authority",
    stateNodes: [
      {
        id: "reference-properties-recon",
        status: "succeeded",
        outputs: [catalogOutput],
        provenance: {
          origin: "pinned-reference",
          reference_expectations: {
            source: "operator-supplied",
            path: "reference-expectations.json",
            sha256: catalogDigest
          }
        }
      }
    ]
  });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon",
    depends_on: ["reference-properties-recon"]
  };
  const lens = JSON.stringify({
    schema_version: "ultrafuzz.property-lens.v2",
    properties: [
      {
        id: "iSpoke_supply",
        description: "Supply completes for valid state.",
        category: "dos-liveness",
        priority: "high",
        reference_expectations: [expectationId]
      }
    ]
  });
  const lensPath = writeArtifact(layout, node.id, "properties/recon.json", lens);
  writeArtifact(layout, "reference-properties-recon", "references/expectations.json", catalog);
  writeArtifactManifest({
    layout,
    nodeId: "reference-properties-recon",
    outputs: [catalogOutput],
    provenance: { origin: "pinned-reference" }
  });
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(fs.readFileSync(lensPath), before);
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_SANITIZED" ||
        diagnostic.code === "ARTIFACT_VERIFICATION_DIGEST_REFRESHED"
    ),
    false
  );
});

test("property lens gate rejects expectations when no pinned catalog was supplied without rewriting bytes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-no-catalog" });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon"
  };
  const lensPath = writeArtifact(
    layout,
    node.id,
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high",
          reference_expectations: ["LEND_ACC_01"]
        }
      ]
    })
  );
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_CATALOG_ABSENT")
  );
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_UNAUTHORIZED"));
  assert.deepEqual(fs.readFileSync(lensPath), before);
});

test("property lens gate rejects every unauthorized catalog spelling without conversion", () => {
  const suppliedId = "supplied-expectation-01";
  const unauthorizedIds = [
    "testConvertToAssetsSharesDesirable",
    "erc4626.maxDeposit",
    "LEND_ACC_01",
    "LEND-ACC-01",
    "CRYTIC-ERC4626-05",
    "benchmark:unexpected"
  ];
  const catalog = JSON.stringify({
    schema_version: "ultrafuzz.reference-expectations.v2",
    expectations: [{ id: suppliedId }]
  });
  const catalogDigest = createHash("sha256").update(catalog).digest("hex");
  const catalogOutput = boundOutput("references/expectations.json", "ultrafuzz/reference-expectations@2");
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-properties-unauthorized",
    stateNodes: [
      {
        id: "reference-properties-recon",
        status: "succeeded",
        outputs: [catalogOutput],
        provenance: {
          origin: "pinned-reference",
          reference_expectations: {
            source: "operator-supplied",
            path: "reference-expectations.json",
            sha256: catalogDigest
          }
        }
      }
    ]
  });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon",
    depends_on: ["reference-properties-recon"]
  };
  const lensPath = writeArtifact(
    layout,
    node.id,
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high",
          reference_expectations: [suppliedId, ...unauthorizedIds]
        }
      ]
    })
  );
  writeArtifact(layout, "reference-properties-recon", "references/expectations.json", catalog);
  writeArtifactManifest({
    layout,
    nodeId: "reference-properties-recon",
    outputs: [catalogOutput],
    provenance: { origin: "pinned-reference" }
  });
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_UNAUTHORIZED").length,
    unauthorizedIds.length
  );
  assert.deepEqual(fs.readFileSync(lensPath), before);
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_SANITIZED" ||
        diagnostic.code === "ARTIFACT_VERIFICATION_DIGEST_REFRESHED"
    ),
    false
  );
});

test("property lens gate rejects a digest-bound schema-invalid expectation catalog", () => {
  const expectationId = "scfuzzbench:aave-v4:iSpoke_supply";
  const malformedCatalog = JSON.stringify({ expectations: [{ id: expectationId }] });
  const catalogDigest = createHash("sha256").update(malformedCatalog).digest("hex");
  const catalogOutput = boundOutput("references/expectations.json", "ultrafuzz/reference-expectations@2");
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-properties-malformed-catalog",
    stateNodes: [
      {
        id: "reference-properties-recon",
        status: "succeeded",
        outputs: [catalogOutput],
        provenance: {
          origin: "pinned-reference",
          reference_expectations: {
            source: "operator-supplied",
            path: "reference-expectations.json",
            sha256: catalogDigest
          }
        }
      }
    ]
  });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon",
    depends_on: ["reference-properties-recon"]
  };
  const lensPath = writeArtifact(
    layout,
    node.id,
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high",
          reference_expectations: [expectationId]
        }
      ]
    })
  );
  writeArtifact(layout, "reference-properties-recon", "references/expectations.json", malformedCatalog);
  writeArtifactManifest({
    layout,
    nodeId: "reference-properties-recon",
    outputs: [catalogOutput],
    provenance: { origin: "pinned-reference" }
  });
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_TAMPERED"));
  assert.deepEqual(fs.readFileSync(lensPath), before);
});
test("ordinary pinned references without expectation catalogs do not require catalog provenance", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-properties-reference-no-catalog",
    stateNodes: [
      {
        id: "reference-properties-example",
        status: "succeeded",
        outputs: [
          {
            path: "references/example.md",
            contract: "ultrafuzz/nonempty-markdown@1",
            contract_digest: "a".repeat(64),
            primary: true
          }
        ],
        provenance: { origin: "pinned-reference" }
      }
    ]
  });
  writeArtifact(
    layout,
    "property-specification-recon",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high"
        }
      ]
    })
  );
  const base = plannedNode(["properties/recon.json"]);
  const node = {
    ...base,
    id: "property-specification-recon",
    logical_id: "property-specification-recon",
    outputs: base.outputs.map((output) => ({ ...output, contract: "ultrafuzz/property-lens@2" as const })),
    depends_on: ["reference-properties-example"]
  };
  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_PROVENANCE_INVALID"),
    false
  );
});

test("property fan-in gate rejects a lens reference expectation dropped from canonical JSON", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-properties-reference-drop",
    stateNodes: [
      { id: "property-specification-recon-0", logicalNodeId: "property-specification-recon", status: "succeeded" },
      { id: "property-specification-recon-1", logicalNodeId: "property-specification-recon", status: "succeeded" }
    ]
  });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-supply",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "liveness",
          verbatim: "Supply completes for valid state.",
          inventory_ids: ["inventory-supply"]
        }
      ],
      inventory_rows: [
        { id: "inventory-supply", description: "Supply remains live.", ledger_ids: ["evidence-supply"] }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-recon-0",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-recon-1",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Withdraw completes for valid state.",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_withdraw"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"],
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "iSpoke_supply" }],
          ledger_ids: ["evidence-supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    "### Canonical property: property-supply\n- description: Supply completes for valid state.\n- category: dos-liveness\n- priority: medium\n- sources: property-specification-recon:iSpoke_supply\n- ledger_ids: evidence-supply\n- reference_expectations: scfuzzbench:aave-v4:iSpoke_supply\n### End canonical property: property-supply\n"
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin",
    depends_on: ["property-specification-recon-0", "property-specification-recon-1"]
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_DROPPED"),
    JSON.stringify(result.diagnostics)
  );
});

test("property implementation gate rejects an unknown canonical property reference", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-unknown"] },
      properties: [
        {
          property_id: "property-unknown",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const node = {
    ...plannedNode(["implemented-properties.json"]),
    id: "stateful-invariant-implement-properties",
    logical_id: "stateful-invariant-implement-properties"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN"));
  assert.match(
    result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN")?.message ?? "",
    /property-unknown/u
  );
});

test("property implementation gate enforces declared selection coverage and actionable blockers", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-implementation-selection",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-high",
          description: "ScFuzzBench supply liveness must not unexpectedly revert",
          category: "dos-liveness",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "iSpoke_supply" }]
        },
        {
          id: "property-medium",
          description: "A medium-priority non-benchmark relation",
          category: "liveness",
          priority: "medium",
          sources: [{ source_node_id: "property-specification-aviggiano", source_property_id: "aviggiano-medium" }]
        }
      ]
    })
  );
  const nodeId = "stateful-invariant-implement-properties";
  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-high"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "deferred",
          implementation_paths: [],
          test_paths: []
        }
      ]
    })
  );
  const node = {
    ...plannedNode(["implemented-properties.json"]),
    id: nodeId,
    logical_id: nodeId,
    outputs: plannedNode(["implemented-properties.json"]).outputs.map((output) => ({
      ...output,
      contract: "ultrafuzz/implemented-properties@3" as const
    }))
  };

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      properties: [
        {
          property_id: "property-high",
          status: "deferred",
          implementation_paths: [],
          test_paths: []
        }
      ]
    })
  );
  const missingSelection = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(missingSelection.ok, false);
  assert.ok(missingSelection.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-high"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "deferred",
          implementation_paths: [],
          test_paths: []
        }
      ]
    })
  );

  const missingBlocker = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(missingBlocker.ok, false);
  assert.ok(missingBlocker.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-high"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "blocked",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "missing-oracle",
            summary: "No stable target getter exposes the required value.",
            next_action: "Add a read-only harness oracle or document the source-backed blocker."
          }
        }
      ]
    })
  );
  const withBlocker = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(withBlocker.ok, true, JSON.stringify(withBlocker.diagnostics));

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "medium",
        priorities: ["high", "medium"],
        property_ids: ["property-high", "property-medium"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "blocked",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "missing-oracle",
            summary: "No stable target getter exposes the required value.",
            next_action: "Add a read-only harness oracle or document the source-backed blocker."
          }
        },
        {
          property_id: "property-medium",
          status: "blocked",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "missing-oracle",
            summary: "No stable target getter exposes the required value.",
            next_action: "Add a read-only harness oracle or document the source-backed blocker."
          }
        }
      ]
    })
  );
  const configMismatch = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(configMismatch.ok, false);
  assert.ok(
    configMismatch.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_SELECTION_CONFIG_MISMATCH"
    )
  );

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: []
      },
      properties: []
    })
  );
  const missingSelectionId = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(missingSelectionId.ok, false);
  assert.ok(
    missingSelectionId.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_SELECTION_MISMATCH"
    )
  );
  assert.ok(
    missingSelectionId.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_COVERAGE_INCOMPLETE"
    )
  );
});

test("property implementation gate includes lower-priority benchmark expectations in selection", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-benchmark-expectation-selection",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-high",
          description: "Borrowed assets remain bounded",
          category: "hub-accounting",
          priority: "high",
          sources: [
            {
              source_node_id: "property-specification-recon",
              source_property_id: "invariant_totalBorrowedLessThanSupplied_v0"
            }
          ]
        },
        {
          id: "property-supply",
          description: "Supply does not unexpectedly revert for valid state",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"],
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "iSpoke_supply" }]
        }
      ]
    })
  );
  const nodeId = "stateful-invariant-implement-properties";
  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-high"] },
      properties: [
        {
          property_id: "property-high",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const baseNode = plannedNode(["implemented-properties.json"]);
  const node = {
    ...baseNode,
    id: nodeId,
    logical_id: nodeId,
    outputs: baseNode.outputs.map((output) => ({ ...output, contract: "ultrafuzz/implemented-properties@3" as const }))
  };
  const result = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_SELECTION_MISMATCH"),
    JSON.stringify(result.diagnostics)
  );
  assert.match(
    result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_SELECTION_MISMATCH")
      ?.message ?? "",
    /property-supply/u
  );

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-high", "property-supply"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        },
        {
          property_id: "property-supply",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const missingReferenceMetadata = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.ok(
    missingReferenceMetadata.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_REFERENCE_EXPECTATIONS_MISMATCH"
    )
  );

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-high", "property-supply"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        },
        {
          property_id: "property-supply",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: [],
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"]
        }
      ]
    })
  );
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, nodeId).ok, true);
});

test("property implementation gate rejects an unknown finding property reference", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-implementation-finding" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  const nodeId = "stateful-invariant-implement-properties";
  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  writeArtifact(
    layout,
    nodeId,
    "findings.json",
    JSON.stringify([currentFinding("finding-property", { property_ids: ["property-unknown"] })])
  );
  const node = {
    ...plannedNode(["implemented-properties.json", "findings.json"]),
    id: nodeId,
    logical_id: nodeId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN"));
  assert.match(
    result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN")?.path ?? "",
    /findings\.json/u
  );
});

test("campaign gate accepts non-property findings and validates property-derived failures", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-1", ["property-1"], ["failure-1"]),
      currentFinding("finding-setup", {
        title: "Harness setup issue",
        status: "needs-review",
        severity_guess: "Low",
        summary: "The harness setup is incomplete."
      })
    ])
  );
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, campaignId).ok, true);

  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", [], ["failure-1"])])
  );
  const dropped = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(dropped.ok, false);
  assert.ok(dropped.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISMATCH"));

  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [{ id: "failure-2", status: "reproduced", property_ids: ["property-unknown"] }]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-2", ["property-unknown"], ["failure-2"]),
      currentFinding("unknown-property-context", {
        title: "Unknown property failure",
        summary: "The unknown property failed."
      })
    ])
  );
  const unknown = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN"));
});

test("campaign gate accepts a partial dual-backend campaign where one backend saw nothing", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-partial-dual" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const campaignId = "stateful-invariant-campaign";
  // A project-owned topology still on the dual-backend campaign: Echidna
  // observed the failure and Medusa finished clean. Dangling findings must be
  // judged against the union of both records, not each record alone.
  writeArtifact(
    layout,
    campaignId,
    "echidna-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "echidna",
      failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "medusa-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "medusa",
      failures: []
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", ["property-1"], ["failure-1"], 1, ["echidna"])])
  );
  const node = {
    ...plannedNode(["echidna-results.json", "medusa-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  // A finding no record explains is still rejected.
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      {
        ...accountedCampaignFinding(
          "failure-unknown",
          ["property-1"],
          [{ fuzzer_backend: "echidna", failure_id: "failure-unknown" }],
          1,
          ["echidna"]
        ),
        title: "Unexplained failure",
        summary: "No campaign record explains this."
      }
    ])
  );
  const dangling = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(dangling.ok, false);
  assert.ok(
    dangling.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_REFERENCE_UNKNOWN")
  );
});

test("campaign gate still applies to project-owned split recon campaign nodes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-split-campaign" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const campaignId = "stateful-invariant-recon-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-unknown"] }]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([currentFinding("failure-1", { property_ids: ["property-unknown"] })])
  );
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN"));
});

test("final report gate joins the default recon-only campaign backend", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-recon-report",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const node = { ...plannedNode(["report.json"]), id: "final-report", logical_id: "final-report" };
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/Property1.t.sol"]
        }
      ]
    })
  );
  // The default topology emits exactly this record from this node; the report
  // join must resolve `recon` from it rather than reporting a backend mismatch.
  writeArtifact(
    layout,
    "stateful-invariant-campaign",
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [{ id: "finding-property", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-campaign",
    "findings.json",
    JSON.stringify([accountedCampaignFinding("finding-property", ["property-1"], ["finding-property"])])
  );
  writeArtifact(
    layout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(layout.runId, {
        non_production_outcomes: [currentNonProductionOutcome("finding-property", "finding-property")],
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"],
            fuzzer_backend: "recon"
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  // A report claiming a backend the campaign never recorded is still rejected.
  writeArtifact(
    layout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(layout.runId, {
        non_production_outcomes: [currentNonProductionOutcome("finding-property", "finding-property")],
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"],
            fuzzer_backends: ["recon", "medusa"]
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );
  const mismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_FUZZER_BACKEND_MISMATCH"));
});

test("final report gate rejects backend provenance borrowed from an unrelated canonical finding", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-renumbered-report",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const node = { ...plannedNode(["report.json"]), id: "final-report", logical_id: "final-report" };
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["tests/recon/Properties.sol"],
          test_paths: ["tests/recon/CryticToFoundry.sol"]
        }
      ]
    })
  );
  for (const [artifactName, backend, failureId] of [
    ["recon-fuzzer-results.json", "recon", "failure-1"],
    ["medusa-results.json", "medusa", "failure-2"]
  ] as const) {
    writeArtifact(
      layout,
      "stateful-invariant-campaign",
      artifactName,
      JSON.stringify({
        schema_version: "ultrafuzz.property-campaign.v2",
        fuzzer_backend: backend,
        failures: [{ id: failureId, status: "reproduced", property_ids: ["property-1"] }]
      })
    );
  }
  writeArtifact(
    layout,
    "stateful-invariant-campaign",
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-1", ["property-1"], ["failure-1"], 1, ["recon"]),
      accountedCampaignFinding("failure-2", ["property-1"], ["failure-2"], 1, ["medusa"])
    ])
  );

  const report = (fuzzerBackends: string[]) =>
    JSON.stringify(
      currentReport(layout.runId, {
        non_production_outcomes: [currentNonProductionOutcome("failure-1", "failure-1")],
        property_provenance: [
          {
            finding_id: "failure-1",
            title: "Canonical non-production outcome",
            property_ids: ["property-1"],
            sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }],
            implementation_paths: ["tests/recon/Properties.sol"],
            test_paths: ["tests/recon/CryticToFoundry.sol"],
            fuzzer_backends: fuzzerBackends
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    );

  writeArtifact(layout, node.id, "report.json", report(["recon"]));
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, true);

  // A backend recorded for another canonical finding cannot be borrowed merely
  // because it appears elsewhere in the same campaign.
  writeArtifact(layout, node.id, "report.json", report(["medusa"]));
  const mismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_FUZZER_BACKEND_MISMATCH"));
});

test("final report gate rejects legacy report shapes without rewriting them and validates current provenance", () => {
  const legacyLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-legacy-report" });
  const node = {
    ...plannedNode(["report.json"]),
    id: "final-report",
    logical_id: "final-report"
  };
  const legacyPath = writeArtifact(
    legacyLayout,
    node.id,
    "report.json",
    JSON.stringify({
      schema_version: "1.0",
      run_metadata: {},
      issues: [],
      non_production_outcomes: [],
      property_provenance: "unavailable"
    })
  );
  const legacyBytes = fs.readFileSync(legacyPath);
  const legacy = verifyRequiredArtifactsForAttempt(legacyLayout, node, node.id);
  assert.equal(legacy.ok, false);
  assert.ok(legacy.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));
  assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);

  const smokeLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-smoke-report" });
  writeArtifact(smokeLayout, node.id, "report.json", JSON.stringify(currentReport(smokeLayout.runId)));
  assert.equal(verifyRequiredArtifactsForAttempt(smokeLayout, node, node.id).ok, true);

  const currentLayout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-current-report",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  writeArtifact(
    currentLayout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [
            { source_node_id: "property-specification-certora", source_property_id: "certora-1" },
            { source_node_id: "property-specification-crytic", source_property_id: "crytic-2" }
          ]
        }
      ]
    })
  );
  writeArtifact(
    currentLayout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/Property1.t.sol"]
        }
      ]
    })
  );
  writeArtifact(
    currentLayout,
    "stateful-invariant-campaign",
    "echidna-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "echidna",
      failures: [{ id: "finding-property", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    currentLayout,
    "stateful-invariant-campaign",
    "medusa-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "medusa",
      failures: [{ id: "medusa-property", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    currentLayout,
    "stateful-invariant-campaign",
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding(
        "finding-property",
        ["property-1"],
        [
          { fuzzer_backend: "echidna", failure_id: "finding-property" },
          { fuzzer_backend: "medusa", failure_id: "medusa-property" }
        ],
        2,
        ["echidna", "medusa"]
      )
    ])
  );
  const campaignNode = {
    ...plannedNode(["echidna-results.json", "medusa-results.json", "findings.json"]),
    id: "stateful-invariant-campaign",
    logical_id: "stateful-invariant-campaign"
  };
  assert.equal(
    verifyRequiredArtifactsForAttempt(currentLayout, campaignNode, campaignNode.id).ok,
    true,
    "finding-owned provenance must join a deduplicated finding to backends whose failure IDs differ"
  );
  writeArtifact(
    currentLayout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(currentLayout.runId, {
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-unknown"],
            sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
            implementation_paths: [],
            test_paths: []
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );
  const dangling = verifyRequiredArtifactsForAttempt(currentLayout, node, node.id);
  assert.equal(dangling.ok, false);
  assert.ok(dangling.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN"));
  assert.match(
    dangling.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN")?.path ?? "",
    /report\.json/u
  );

  writeArtifact(
    currentLayout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(currentLayout.runId, {
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"],
            fuzzer_backends: ["echidna", "medusa"]
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );
  const incompleteJoin = verifyRequiredArtifactsForAttempt(currentLayout, node, node.id);
  assert.equal(incompleteJoin.ok, false);
  assert.ok(incompleteJoin.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_SOURCES_MISMATCH"));

  writeArtifact(
    currentLayout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(currentLayout.runId, {
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [
              { source_node_id: "property-specification-certora", source_property_id: "certora-1" },
              { source_node_id: "property-specification-crytic", source_property_id: "crytic-2" }
            ],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"],
            fuzzer_backends: ["echidna", "medusa"]
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );
  assert.equal(verifyRequiredArtifactsForAttempt(currentLayout, node, node.id).ok, true);
});

test("current final reports preserve implementation coverage in JSON and Markdown", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-current-coverage",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const node = {
    ...plannedNode(["report.md", "report.json"]),
    id: "final-report",
    logical_id: "final-report"
  };
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-high",
          description: "The accounting relation holds.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "hub-total" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-high"] },
      properties: [
        {
          property_id: "property-high",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/PropertyHigh.t.sol"]
        }
      ]
    })
  );
  const reportPath = "report.json";
  const baseReport = currentReport(layout.runId);
  writeArtifact(layout, node.id, reportPath, JSON.stringify(baseReport));
  writeArtifact(layout, node.id, "report.md", "# Ultrafuzz report\n\nNo coverage section yet.\n");

  const missing = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missing.ok, false);
  assert.ok(
    missing.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MISSING")
  );
  assert.ok(
    missing.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISSING"
    )
  );

  writeArtifact(
    layout,
    node.id,
    reportPath,
    JSON.stringify({
      ...baseReport,
      property_implementation_coverage: {
        priority_threshold: "high",
        priorities: ["high"],
        selected_property_ids: ["property-high"],
        implemented_property_ids: ["property-high"],
        blocked_property_ids: [],
        pending_property_ids: [],
        deferred_property_ids: [],
        reference_expected_property_ids: [],
        reference_expectation_ids: [],
        blocker_summaries: []
      }
    })
  );
  writeArtifact(
    layout,
    node.id,
    "report.md",
    "# Ultrafuzz report\n\n## Property implementation coverage\n\n- Priority threshold: `high`\n- Included priorities: `high`\n- Selected properties: `1`\n- Implemented properties: `1`\n- Blocked properties: `0`\n- Pending properties: `0`\n- Deferred properties: `0`\n- Reference expectation properties: `0`\n"
  );
  const validCoverage = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(validCoverage.ok, true, JSON.stringify(validCoverage.diagnostics));

  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-high"] },
      properties: [
        {
          property_id: "property-high",
          status: "blocked",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/PropertyHigh.t.sol"],
          blocker: { code: "MISSING_ORACLE", summary: "Oracle unavailable_*", next_action: "Add oracle" }
        }
      ]
    })
  );
  writeArtifact(
    layout,
    node.id,
    reportPath,
    JSON.stringify({
      ...baseReport,
      property_implementation_coverage: {
        priority_threshold: "high",
        priorities: ["high"],
        selected_property_ids: ["property-high"],
        implemented_property_ids: [],
        blocked_property_ids: ["property-high"],
        pending_property_ids: [],
        deferred_property_ids: [],
        reference_expected_property_ids: [],
        reference_expectation_ids: [],
        blocker_summaries: ["property-high: Oracle unavailable_*"]
      }
    })
  );
  writeArtifact(
    layout,
    node.id,
    "report.md",
    "# Ultrafuzz report\n\n## Property implementation coverage\n\n- Priority threshold: `high`\n- Included priorities: `high`\n- Selected properties: `1`\n- Implemented properties: `0`\n- Blocked properties: `1`\n- Pending properties: `0`\n- Deferred properties: `0`\n- Reference expectation properties: `0`\n\nBlocker summaries:\n- property-high: Oracle unavailable\\_\\*\n"
  );
  const validBlockedCoverage = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(validBlockedCoverage.ok, true, JSON.stringify(validBlockedCoverage.diagnostics));

  writeArtifact(
    layout,
    node.id,
    "report.md",
    "# Ultrafuzz report\n\n## Property implementation coverage\n\n- Priority threshold: `high`\n- Included priorities: `high`\n- Selected properties: `1`\n- Implemented properties: `0`\n- Blocked properties: `1`\n- Pending properties: `0`\n- Deferred properties: `0`\n- Reference expectation properties: `0`\n\nBlocker summaries:\n- property-high: Wrong summary\n"
  );
  const blockerMarkdownMismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.ok(
    blockerMarkdownMismatch.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISMATCH"
    ),
    JSON.stringify(blockerMarkdownMismatch.diagnostics)
  );

  writeArtifact(
    layout,
    node.id,
    "report.md",
    "# Ultrafuzz report\n\n## Property implementation coverage\n\n- Priority threshold: `high`\n- Included priorities: `high`\n- Selected properties: `1`\n- Implemented properties: `0`\n- Blocked properties: `0`\n- Pending properties: `0`\n- Deferred properties: `0`\n- Reference expectation properties: `0`\n"
  );
  const markdownMismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.ok(
    markdownMismatch.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISMATCH"
    ),
    JSON.stringify(markdownMismatch.diagnostics)
  );

  writeArtifact(
    layout,
    node.id,
    reportPath,
    JSON.stringify({
      ...baseReport,
      property_implementation_coverage: {
        priority_threshold: "high",
        priorities: ["high"],
        selected_property_ids: [],
        implemented_property_ids: [],
        blocked_property_ids: [],
        pending_property_ids: [],
        deferred_property_ids: [],
        reference_expected_property_ids: [],
        reference_expectation_ids: [],
        blocker_summaries: []
      }
    })
  );
  const mismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(mismatch.ok, false);
  assert.ok(
    mismatch.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MISMATCH")
  );
});

test("dependency gates reject reused descendants after an ancestor manifest changes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-reuse" });
  writeArtifact(layout, "ancestor", "result.md", "first\n");
  writeArtifactManifest({ layout, nodeId: "ancestor", createdAt: "2026-07-18T00:00:00.000Z" });
  writeArtifact(layout, "reused", "result.md", "derived\n");
  writeArtifactManifest({
    layout,
    nodeId: "reused",
    prerequisiteNodeIds: ["ancestor"],
    createdAt: "2026-07-18T00:00:01.000Z"
  });
  const state = createInitialRunState({
    runId: "run-reuse",
    graphFingerprint: "graph",
    configFingerprint: "c".repeat(64),
    nodes: [
      { id: "ancestor", status: "succeeded" },
      { id: "reused", status: "reused-from-prior-run" },
      { id: "consumer", status: "pending" }
    ]
  });
  const consumer = { ...plannedNode(["result.md"]), id: "consumer", depends_on: ["reused"] };

  assert.equal(dependencyGateForNode(consumer, state, layout).ok, true);
  writeArtifact(layout, "ancestor", "result.md", "changed\n");
  writeArtifactManifest({ layout, nodeId: "ancestor", createdAt: "2026-07-18T00:00:02.000Z" });
  assert.deepEqual(dependencyGateForNode(consumer, state, layout), {
    ok: false,
    reason_code: "CAUSAL_MANIFEST_MISMATCH",
    reason: "node consumer cannot reuse descendants after a prerequisite manifest changed",
    blocked_by: ["reused"]
  });
});

// Regression: https://github.com/.../issues/386 — the campaign gate demanded a
// finding sharing each raw counterexample's ID, so a campaign that correctly
// deduplicated many counterexamples of one property into one finding failed.
function campaignPropertyCatalog(layout: ReturnType<typeof createRunLayout>, propertyIds: string[]): void {
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: propertyIds.map((propertyId) => ({
        id: propertyId,
        description: `Invariant ${propertyId}`,
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "property-specification-certora", source_property_id: `certora-${propertyId}` }]
      }))
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: propertyIds },
      properties: propertyIds.map((propertyId) => ({
        property_id: propertyId,
        status: "implemented",
        implementation_paths: ["test/recon/Properties.sol"],
        test_paths: []
      }))
    })
  );
}

function campaignFinding(id: string, propertyIds: string[]): Record<string, unknown> {
  const finding = currentFinding(id, {
    title: propertyIds.length > 0 ? `Violation of ${propertyIds.join(", ")}` : "Harness observation"
  });
  // A finding with no property provenance omits the key entirely; an empty
  // array is not how the campaign nodes express "no properties".
  if (propertyIds.length > 0) {
    finding.property_ids = propertyIds;
  }
  return finding;
}

type CampaignFailureReferenceFixture = string | { fuzzer_backend: string; failure_id: string };

function accountedCampaignFinding(
  id: string,
  propertyIds: string[],
  contributions: CampaignFailureReferenceFixture[],
  preDedupCount = contributions.length,
  fuzzerBackends: string[] = ["recon"]
): Record<string, unknown> {
  return {
    ...campaignFinding(id, propertyIds),
    contributing_backend_failures: contributions,
    deduplication: { pre_dedup_count: preDedupCount },
    ...(fuzzerBackends.length === 1 ? { fuzzer_backend: fuzzerBackends[0] } : { fuzzer_backends: fuzzerBackends })
  };
}

function currentCampaignNode(paths: string[]): PlannedGraphNode {
  const node = plannedNode(paths);
  return {
    ...node,
    outputs: node.outputs.map((output) =>
      output.path === "campaign-summary.json"
        ? { ...output, contract: "ultrafuzz/campaign-summary@2" as const }
        : output
    )
  };
}

function writeCampaignSummary(
  layout: ReturnType<typeof createRunLayout>,
  campaignId: string,
  preDeduplication: number,
  postDeduplication: number
): void {
  writeArtifact(
    layout,
    campaignId,
    "campaign-summary.json",
    JSON.stringify({
      schema_version: "ultrafuzz.campaign-summary.v2",
      outcome: "partial",
      implemented_property_suite_refs: ["implemented-properties.json"],
      campaign_plan_ref: "campaign-plan.json",
      backend_results: [{ fuzzer_backend: "recon", status: "partial", result_ref: "recon-fuzzer-results.json" }],
      finding_refs: [],
      reproducer_refs: [],
      failure_counts: {
        pre_deduplication: preDeduplication,
        post_deduplication: postDeduplication
      }
    })
  );
}

test("campaign gate accepts many counterexamples of one property deduplicated into one finding", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-dedup" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [1, 2, 3].map((index) => ({
        id: `failure-${index}`,
        status: "reproduced",
        property_ids: ["property-1"]
      }))
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", ["property-1"], ["failure-1", "failure-2", "failure-3"])])
  );
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.source === "property-provenance"),
    []
  );
  assert.equal(result.ok, true);
});

test("current campaign gate accepts the exact R55 partition: 29 counterexamples, two findings", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-r55" });
  campaignPropertyCatalog(layout, ["property-1", "property-3"]);
  const campaignId = "stateful-invariant-campaign";
  // 27 counterexamples of property-1 and 2 of property-3, exactly as R55 produced.
  const failures = Array.from({ length: 29 }, (_value, index) => ({
    id: `failure-${index + 1}`,
    status: "reproduced",
    property_ids: [index + 1 === 25 || index + 1 === 26 ? "property-3" : "property-1"]
  }));
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding(
        "failure-1",
        ["property-1"],
        failures.filter((failure) => failure.property_ids[0] === "property-1").map((failure) => failure.id)
      ),
      accountedCampaignFinding(
        "failure-25",
        ["property-3"],
        failures.filter((failure) => failure.property_ids[0] === "property-3").map((failure) => failure.id)
      )
    ])
  );
  writeCampaignSummary(layout, campaignId, 29, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.source === "property-provenance"),
    []
  );
  assert.equal(result.ok, true);
});

test("current campaign gate requires partition metadata and accepts an explicit complete partition", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-required" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [
        { id: "failure-1", status: "reproduced", property_ids: ["property-1"] },
        { id: "failure-2", status: "reproduced", property_ids: ["property-1"] }
      ]
    })
  );
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([campaignFinding("failure-1", ["property-1"])]));
  writeCampaignSummary(layout, campaignId, 2, 1);

  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };
  const current = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(current.ok, false);
  assert.ok(current.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_REQUIRED"));
  assert.equal(
    current.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_UNCLAIMED").length,
    2
  );
  assert.ok(
    current.diagnostics
      .filter((diagnostic) => diagnostic.code.startsWith("PROPERTY_CAMPAIGN_PARTITION_"))
      .every((diagnostic) => diagnostic.severity === "error")
  );

  const completePartition = accountedCampaignFinding("failure-1", ["property-1"], ["failure-1", "failure-2"]);
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([completePartition]));
  const complete = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(complete.ok, true, JSON.stringify(complete.diagnostics));
});

test("campaign partition rejects unknown contributions and per-finding count mismatches", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-unknown" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", ["property-1"], ["failure-unknown"], 2)])
  );
  writeCampaignSummary(layout, campaignId, 1, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  for (const code of [
    "PROPERTY_CAMPAIGN_PARTITION_REFERENCE_UNKNOWN",
    "PROPERTY_CAMPAIGN_PARTITION_COUNT_MISMATCH",
    "PROPERTY_CAMPAIGN_PARTITION_UNCLAIMED"
  ]) {
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === code),
      code
    );
  }
});

test("campaign partition rejects duplicate claims and property subset mismatches", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-duplicate" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [
        { id: "failure-1", status: "reproduced", property_ids: ["property-1"] },
        { id: "failure-2", status: "reproduced", property_ids: ["property-2"] }
      ]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-1", ["property-1"], ["failure-1", "failure-2"]),
      accountedCampaignFinding("failure-2", ["property-2"], ["failure-2"])
    ])
  );
  writeCampaignSummary(layout, campaignId, 2, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_DUPLICATE"));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_PROPERTY_MISMATCH")
  );
});

test("campaign partition requires each finding ID to represent one of its contributions", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-representative" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [
        { id: "failure-1", status: "reproduced", property_ids: ["property-1"] },
        { id: "failure-2", status: "reproduced", property_ids: ["property-1"] }
      ]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-1", ["property-1"], ["failure-2"]),
      accountedCampaignFinding("failure-2", ["property-1"], ["failure-1"])
    ])
  );
  writeCampaignSummary(layout, campaignId, 2, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_REPRESENTATIVE_MISMATCH")
      .length,
    2
  );
});

test("campaign partition requires a finding's properties to equal its contribution union", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-property-union" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [
        { id: "failure-1", status: "reproduced", property_ids: ["property-1"] },
        { id: "failure-2", status: "reproduced", property_ids: ["property-2"] }
      ]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-1", ["property-1", "property-2"], ["failure-1"]),
      accountedCampaignFinding("failure-2", ["property-2"], ["failure-2"])
    ])
  );
  writeCampaignSummary(layout, campaignId, 2, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_PROPERTY_MISMATCH")
      .length,
    1
  );
});

test("campaign partition binds finding backend provenance to its exact contributions", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-backend-set" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  for (const backend of ["echidna", "medusa"] as const) {
    writeArtifact(
      layout,
      campaignId,
      `${backend}-results.json`,
      JSON.stringify({
        schema_version: "ultrafuzz.property-campaign.v2",
        fuzzer_backend: backend,
        failures: [{ id: `failure-${backend}`, status: "reproduced", property_ids: ["property-1"] }]
      })
    );
  }
  const contributions = [
    { fuzzer_backend: "echidna", failure_id: "failure-echidna" },
    { fuzzer_backend: "medusa", failure_id: "failure-medusa" }
  ];
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-echidna", ["property-1"], contributions, 2, ["echidna"])])
  );
  writeCampaignSummary(layout, campaignId, 2, 1);
  const node = {
    ...currentCampaignNode(["echidna-results.json", "medusa-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_BACKEND_MISMATCH")
  );
});

test("campaign partition requires qualified references for colliding cross-backend failure IDs", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-qualified" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  for (const backend of ["echidna", "medusa"] as const) {
    writeArtifact(
      layout,
      campaignId,
      `${backend}-results.json`,
      JSON.stringify({
        schema_version: "ultrafuzz.property-campaign.v2",
        fuzzer_backend: backend,
        failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-1"] }]
      })
    );
  }
  const finding = {
    ...accountedCampaignFinding("failure-1", ["property-1"], ["failure-1"], 1, ["echidna", "medusa"])
  };
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([finding]));
  writeCampaignSummary(layout, campaignId, 2, 1);
  const node = {
    ...currentCampaignNode(["echidna-results.json", "medusa-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const ambiguous = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(ambiguous.ok, false);
  assert.ok(
    ambiguous.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_REFERENCE_AMBIGUOUS")
  );

  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      {
        ...finding,
        contributing_backend_failures: [
          { fuzzer_backend: "echidna", failure_id: "failure-1" },
          { fuzzer_backend: "medusa", failure_id: "failure-1" }
        ],
        deduplication: { pre_dedup_count: 2 }
      }
    ])
  );
  const qualified = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(qualified.ok, true, JSON.stringify(qualified.diagnostics));
});

test("campaign gate conditionally reconciles the R55 summary failure counts with every backend failure and finding", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-r55-summary" });
  campaignPropertyCatalog(layout, ["property-1", "property-3"]);
  const campaignId = "stateful-invariant-campaign";
  const failures = Array.from({ length: 29 }, (_value, index) => ({
    id: `failure-${index + 1}`,
    status: "reproduced",
    property_ids: [index + 1 === 25 || index + 1 === 26 ? "property-3" : "property-1"]
  }));
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding(
        "failure-1",
        ["property-1"],
        failures.filter((failure) => failure.property_ids[0] === "property-1").map((failure) => failure.id)
      ),
      accountedCampaignFinding(
        "failure-25",
        ["property-3"],
        failures.filter((failure) => failure.property_ids[0] === "property-3").map((failure) => failure.id)
      )
    ])
  );
  writeCampaignSummary(layout, campaignId, 29, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, campaignId).ok, true);

  writeCampaignSummary(layout, campaignId, 0, 0);
  const mismatched = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(mismatched.ok, false);
  assert.deepEqual(
    mismatched.diagnostics
      .filter((diagnostic) => diagnostic.code === "CAMPAIGN_SUMMARY_FAILURE_COUNT_MISMATCH")
      .map((diagnostic) => diagnostic.path?.split(".").at(-1)),
    ["pre_deduplication", "post_deduplication"]
  );

  const legacyPath = writeArtifact(layout, campaignId, "campaign-summary.json", JSON.stringify({ outcome: "partial" }));
  const legacyBytes = fs.readFileSync(legacyPath);
  const legacy = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(legacy.ok, false);
  assert.ok(legacy.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));
  assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);

  const incompletePath = writeArtifact(
    layout,
    campaignId,
    "campaign-summary.json",
    JSON.stringify({
      schema_version: "ultrafuzz.campaign-summary.v2",
      outcome: "partial",
      implemented_property_suite_refs: ["implemented-properties.json"],
      campaign_plan_ref: "campaign-plan.json",
      backend_results: [{ fuzzer_backend: "recon", status: "partial", result_ref: "recon-fuzzer-results.json" }],
      finding_refs: [],
      reproducer_refs: [],
      failure_counts: { pre_deduplication: 29 }
    })
  );
  const incompleteBytes = fs.readFileSync(incompletePath);
  const incomplete = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));
  assert.deepEqual(fs.readFileSync(incompletePath), incompleteBytes);
});

test("campaign gate still rejects a property-derived failure no finding covers", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-uncovered" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [
        { id: "failure-1", status: "reproduced", property_ids: ["property-1"] },
        { id: "failure-2", status: "reproduced", property_ids: ["property-2"] }
      ]
    })
  );
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([campaignFinding("failure-1", ["property-1"])]));
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  const missing = result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISSING");
  assert.ok(missing);
  assert.match(missing?.path ?? "", /failures\[1\]/u);
});

test("campaign gate does not let an unrelated finding cover a campaign failure", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-unrelated-coverage" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([campaignFinding("unrelated-finding", ["property-1"])])
  );
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISSING"));
});

test("campaign gate names only the genuinely uncovered property of a partially covered failure", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partial" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [
        { id: "failure-1", status: "reproduced", property_ids: ["property-1", "property-2"] },
        { id: "failure-2", status: "reproduced", property_ids: ["property-1"] }
      ]
    })
  );
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([campaignFinding("failure-2", ["property-1"])]));
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  const missing = result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISSING");
  assert.ok(missing);
  assert.match(missing?.message ?? "", /property-2/u);
  // property-1 is covered by the finding, so naming it would send the retry
  // after an artifact that is already correct.
  assert.doesNotMatch(missing?.message ?? "", /property-1/u);
});

test("campaign gate keeps flagging ambiguous and mismatched same-ID findings", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-ambiguous" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [
        { id: "failure-1", status: "reproduced", property_ids: ["property-1"] },
        { id: "failure-2", status: "reproduced", property_ids: ["property-1"] }
      ]
    })
  );
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([campaignFinding("failure-1", ["property-1"]), campaignFinding("failure-1", ["property-1"])])
  );
  const ambiguous = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_AMBIGUOUS"));

  // A finding that claims a failure's ID must still carry that failure's properties,
  // even though other failures may now be covered by a different finding.
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([campaignFinding("failure-1", []), campaignFinding("failure-2", ["property-1"])])
  );
  const mismatched = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISMATCH"));
});

test("campaign gate rejects a failure whose property combination no single finding claims", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-combination" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  // The counterexample that broke both invariants at once is the most
  // interesting one in the file; per-property coverage alone would drop it.
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [
        { id: "failure-1", status: "reproduced", property_ids: ["property-1"] },
        { id: "failure-2", status: "reproduced", property_ids: ["property-2"] },
        { id: "failure-3", status: "reproduced", property_ids: ["property-1", "property-2"] }
      ]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([campaignFinding("failure-1", ["property-1"]), campaignFinding("failure-2", ["property-2"])])
  );
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  const missing = result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISSING");
  assert.ok(missing);
  assert.match(missing?.message ?? "", /failure-3/u);
});

test("campaign gate accepts a deduplicated finding that unions the properties of the failures it covers", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-union" });
  campaignPropertyCatalog(layout, ["property-1", "property-3"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [
        { id: "failure-1", status: "reproduced", property_ids: ["property-1"] },
        { id: "failure-2", status: "reproduced", property_ids: ["property-1", "property-3"] }
      ]
    })
  );
  // The campaign prompt says to reuse a stable failure ID on the deduplicated
  // finding, so the finding that collapses both failures carries failure-1's ID
  // while carrying the union of their properties.
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", ["property-1", "property-3"], ["failure-1", "failure-2"])])
  );
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.source === "property-provenance"),
    []
  );
  assert.equal(result.ok, true);
});

test("campaign gate rejects a finding that claims a property no failure ever reported", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-invented" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  // property-2 is implemented and in the catalog, so only the campaign join can
  // catch it: no counterexample anywhere reported it.
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([campaignFinding("failure-1", ["property-1", "property-2"])])
  );
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  const unobserved = result.diagnostics.find(
    (diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PROPERTY_UNOBSERVED"
  );
  assert.ok(unobserved);
  assert.match(unobserved?.message ?? "", /property-2/u);
  assert.doesNotMatch(unobserved?.message ?? "", /property-1/u);
});

test("campaign gate rejects a property claim anchored to a failure that reported no property", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-harness-anchor" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  // A harness defect legitimately omits property_ids. A finding may not borrow
  // its ID and then attribute a catalog property to it.
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: [{ id: "failure-1", status: "reproduced" }]
    })
  );
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([campaignFinding("failure-1", ["property-1"])]));
  const node = {
    ...plannedNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PROPERTY_UNOBSERVED"),
    `expected an unobserved-property diagnostic, got ${JSON.stringify(result.diagnostics.map((d) => d.code))}`
  );
});

// The coverage block's JSON and Markdown examples in final-report.md drifted
// apart -- the JSON said one included priority while the Markdown rendered two,
// and the Markdown reported zero deferred properties beside a blocker summary
// that only a deferred property can produce. A model copying them could not
// pass the gate. Run the prompt's own examples through the gate rather than
// restating them here, so they cannot drift again.
function fencedBlockAfter(markdown: string, anchor: string, language: string): string {
  const anchorIndex = markdown.indexOf(anchor);
  assert.ok(anchorIndex >= 0, `final-report.md no longer contains ${JSON.stringify(anchor)}`);
  const fence = "```" + language + "\n";
  const start = markdown.indexOf(fence, anchorIndex);
  assert.ok(start >= 0, `no ${language} block follows ${JSON.stringify(anchor)}`);
  const bodyStart = start + fence.length;
  const end = markdown.indexOf("\n```", bodyStart);
  assert.ok(end >= 0, `unterminated ${language} block after ${JSON.stringify(anchor)}`);
  return markdown.slice(bodyStart, end);
}

test("the coverage examples in final-report.md satisfy the coverage gate", () => {
  const finalReport = loadBuiltInPromptAssets().find((asset) => asset.relativePath === "review/final-report.md");
  assert.ok(finalReport, "missing built-in prompt review/final-report.md");
  const coverageJson = JSON.parse(
    fencedBlockAfter(finalReport.markdown, "emit `property_implementation_coverage` with", "json")
  ) as Record<string, unknown>;
  const coverageMarkdown = fencedBlockAfter(
    finalReport.markdown,
    "These bullets are the Markdown rendering",
    "markdown"
  );

  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-prompt-coverage-example",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "medium"\n'
  });
  const node = {
    ...plannedNode(["report.md", "report.json"]),
    id: "final-report",
    logical_id: "final-report"
  };
  // The handoff the prompt's example describes: one implemented high-priority
  // property carrying a reference expectation, and one deferred medium one.
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "The accounting relation holds.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "hub-total" }],
          reference_expectations: ["scfuzzbench:example:expectation-1"]
        },
        {
          id: "property-2",
          description: "The premium delta is conserved.",
          category: "accounting",
          priority: "medium",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "premium-delta" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "medium",
        priorities: ["high", "medium"],
        property_ids: ["property-1", "property-2"]
      },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/Property1.t.sol"],
          reference_expectations: ["scfuzzbench:example:expectation-1"]
        },
        {
          property_id: "property-2",
          status: "deferred",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "transition-oracle-deferred",
            summary: "The handler cannot observe the premium delta returned by the Hub.",
            next_action: "Add property-scoped snapshots around the handler."
          }
        }
      ]
    })
  );
  writeArtifact(
    layout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(layout.runId, {
        property_implementation_coverage: coverageJson
      })
    )
  );
  writeArtifact(
    layout,
    node.id,
    "report.md",
    `# Ultrafuzz report\n\n## Property implementation coverage\n\n${coverageMarkdown}\n`
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
});

test("coverage Markdown accepts a blocker summary escaped or as written, but not reworded", () => {
  const summary = "The handler cannot observe _beforeTokenTransfer deltas *at all*.";
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-blocker-escaping",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const node = {
    ...plannedNode(["report.md", "report.json"]),
    id: "final-report",
    logical_id: "final-report"
  };
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "The premium delta is conserved.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "premium-delta" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "deferred",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "transition-oracle-deferred",
            summary,
            next_action: "Add property-scoped snapshots around the handler."
          }
        }
      ]
    })
  );
  writeArtifact(
    layout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(layout.runId, {
        property_implementation_coverage: {
          priority_threshold: "high",
          priorities: ["high"],
          selected_property_ids: ["property-1"],
          implemented_property_ids: [],
          blocked_property_ids: [],
          pending_property_ids: [],
          deferred_property_ids: ["property-1"],
          reference_expected_property_ids: [],
          reference_expectation_ids: [],
          blocker_summaries: [`property-1: ${summary}`]
        }
      })
    )
  );
  const counts =
    "- Priority threshold: `high`\n- Included priorities: `high`\n- Selected properties: `1`\n" +
    "- Implemented properties: `0`\n- Blocked properties: `0`\n- Pending properties: `0`\n" +
    "- Deferred properties: `1`\n- Reference expectation properties: `0`\n";
  const withBlocker = (bullet: string): string =>
    `# Ultrafuzz report\n\n## Property implementation coverage\n\n${counts}\nBlocker summaries:\n${bullet}\n`;

  writeArtifact(layout, node.id, "report.md", withBlocker(`- property-1: ${summary}`));
  const plain = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(plain.ok, true, JSON.stringify(plain.diagnostics));

  writeArtifact(
    layout,
    node.id,
    "report.md",
    withBlocker("- property-1: The handler cannot observe \\_beforeTokenTransfer deltas \\*at all\\*.")
  );
  const escaped = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(escaped.ok, true, JSON.stringify(escaped.diagnostics));

  // Relaxing the escaping must not relax the join: the Markdown still has to
  // report the same blocker the JSON does.
  writeArtifact(layout, node.id, "report.md", withBlocker("- property-1: Something else entirely."));
  const reworded = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(reworded.ok, false);
  assert.ok(
    reworded.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISMATCH"
    )
  );
});

// #408: the field parser strips a trailing pipe to normalize Markdown table
// cells, which silently truncates any value that legitimately ENDS with one.
// R58's property-specification-fanin failed on five consecutive properties whose
// descriptions quote a row of Aave's docs/overview.md verbatim, as the fan-in
// prompt requires. Any target documenting parameters in tables hits this.
test("properties Markdown parity accepts a description that ends with a pipe", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-fanin-trailing-pipe" });
  // Shaped after R58's property-277: prose, then a verbatim docs table row.
  const description =
    "Project discovery evidence evidence-doc-liquidation-targethf-row (bound) at docs/overview.md:line 237; " +
    "verbatim: | `TargetHealthFactor` | A spoke-wide value set by the Governor. | Must be >= the constant. |";
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-doc-liquidation-targethf-row",
          source_path: "docs/overview.md",
          source_location: "line 237",
          kind: "bound",
          verbatim: "TargetHealthFactor is a per-reserve WAD parameter above the liquidation threshold.",
          inventory_ids: ["inventory-doc-liquidation-targethf-row"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-doc-liquidation-targethf-row",
          description: "TargetHealthFactor is a per-reserve WAD parameter.",
          ledger_ids: ["evidence-doc-liquidation-targethf-row"]
        }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-277",
          description,
          category: "configuration",
          priority: "high",
          sources: [
            { source_node_id: "project-discovery", source_property_id: "evidence-doc-liquidation-targethf-row" }
          ],
          ledger_ids: ["evidence-doc-liquidation-targethf-row"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    `### Canonical property: property-277\ndescription: ${description}\ncategory: configuration\npriority: high\nsources: project-discovery:evidence-doc-liquidation-targethf-row\nledger_ids: evidence-doc-liquidation-targethf-row\n### End canonical property: property-277\n`
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"),
    []
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});
