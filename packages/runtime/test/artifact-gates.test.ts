import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createInitialRunState,
  createRunLayout,
  getNodeArtifactDir,
  writeArtifact,
  writeArtifactManifest
} from "@ultrafuzz/artifacts";

import {
  CAMPAIGN_LOGICAL_NODE_IDS,
  dependencyGateForNode,
  verifyRequiredArtifactsForAttempt,
  type PlannedGraphNode
} from "../src/index.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-gates-"));
}

function plannedNode(paths: string[]): PlannedGraphNode {
  return {
    id: "strategy-a",
    logical_id: "strategy-a",
    display_name: "Strategy A",
    kind: "agentic",
    depends_on: [],
    artifact_dir: "artifacts/strategy-a",
    outputs: paths.map((outputPath, index) => ({
      path: outputPath,
      contract:
        outputPath === "generated-tests.json"
          ? "ultrafuzz/generated-tests@1"
          : outputPath === "findings.json"
            ? "ultrafuzz/findings@1"
            : outputPath === "properties.json"
              ? "ultrafuzz/properties@1"
              : outputPath === "implemented-properties.json"
                ? "ultrafuzz/implemented-properties@1"
                : outputPath === "setup/invariant-evidence-ledger.json"
                  ? "ultrafuzz/invariant-ledger@1"
                  : ["echidna-results.json", "medusa-results.json", "recon-fuzzer-results.json"].includes(outputPath)
                    ? "ultrafuzz/property-campaign@1"
                    : outputPath === "report.json"
                      ? "ultrafuzz/report@1"
                      : "ultrafuzz/nonempty-markdown@1",
      contract_digest: "a".repeat(64),
      primary: index === 0
    })),
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
      schema_version: "1.0",
      run_id: "run-1",
      node_id: "strategy-a",
      test_files: [{ path: "generated-tests/Invariant.t.sol" }]
    }),
    "utf8"
  );

  const legacy = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(legacy.ok, false);
  assert.ok(legacy.diagnostics.some((diagnostic) => diagnostic.code === "GENERATED_TEST_MANIFEST_SCHEMA_INVALID"));

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema_version: "1.0",
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
  assert.ok(malformed.diagnostics.some((diagnostic) => diagnostic.code === "FINDINGS_SCHEMA_INVALID"));
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
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify(missingSourceLedger)
  );
  const missingSource = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingSource.ok, false);
  assert.ok(missingSource.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_MISSING"));

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", "{");
  const malformedLedger = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(malformedLedger.ok, false);
  assert.ok(malformedLedger.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_JSON_INVALID"));
  assert.ok(malformedLedger.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_EVIDENCE_READ_FAILED"));

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
  assert.ok(emptyLedger.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SCHEMA_INVALID"));

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
          id: "probe-docs-no-invariants",
          source_path: "docs/overview.md",
          query: "invariant|accounting|solvency",
          result: "No explicit invariant statements found"
        }
      ]
    })
  );
  const explicitNoEvidence = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(explicitNoEvidence.ok, true);

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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.property-lens.v1",
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
      schema_version: "ultrafuzz.property-lens.v1",
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
      schema_version: "ultrafuzz.property-lens.v1",
      properties: [
        {
          id: "iSpoke_withdraw",
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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
      contract: "ultrafuzz/implemented-properties@2" as const
    }))
  };

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v1",
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
  assert.ok(
    missingSelection.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_SELECTION_MISSING")
  );

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v1",
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
  assert.ok(
    missingBlocker.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_BLOCKER_MISSING")
  );

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
    outputs: baseNode.outputs.map((output) => ({ ...output, contract: "ultrafuzz/implemented-properties@2" as const }))
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
});

test("property implementation gate rejects an unknown finding property reference", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-implementation-finding" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
    JSON.stringify([
      {
        schema_version: "1.0",
        id: "finding-property",
        title: "Property failure",
        status: "reproduced",
        severity_guess: "medium",
        confidence: "high",
        summary: "The property failed.",
        property_ids: ["property-unknown"]
      }
    ])
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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
      schema_version: "ultrafuzz.property-campaign.v1",
      fuzzer_backend: "recon",
      failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      {
        schema_version: "1.0",
        id: "failure-1",
        title: "Property failure",
        status: "reproduced",
        severity_guess: "medium",
        confidence: "high",
        summary: "The property failed.",
        property_ids: ["property-1"]
      },
      {
        schema_version: "1.0",
        id: "finding-setup",
        title: "Harness setup issue",
        status: "needs-review",
        severity_guess: "low",
        confidence: "high",
        summary: "The harness setup is incomplete."
      }
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
    JSON.stringify([
      {
        schema_version: "1.0",
        id: "failure-1",
        title: "Property failure",
        status: "reproduced",
        severity_guess: "medium",
        confidence: "high",
        summary: "The property failed."
      }
    ])
  );
  const dropped = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(dropped.ok, false);
  assert.ok(dropped.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISMATCH"));

  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v1",
      failures: [{ id: "failure-2", status: "reproduced", property_ids: ["property-unknown"] }]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      {
        schema_version: "1.0",
        id: "failure-2",
        title: "Unknown property failure",
        status: "reproduced",
        severity_guess: "medium",
        confidence: "high",
        summary: "The unknown property failed.",
        property_ids: ["property-unknown"]
      }
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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
      schema_version: "ultrafuzz.property-campaign.v1",
      fuzzer_backend: "echidna",
      failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "medusa-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v1",
      fuzzer_backend: "medusa",
      failures: []
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      {
        schema_version: "1.0",
        id: "failure-1",
        title: "Property failure",
        status: "reproduced",
        severity_guess: "medium",
        confidence: "high",
        summary: "The property failed.",
        property_ids: ["property-1"]
      }
    ])
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
        schema_version: "1.0",
        id: "failure-unknown",
        title: "Unexplained failure",
        status: "reproduced",
        severity_guess: "medium",
        confidence: "high",
        summary: "No campaign record explains this.",
        property_ids: ["property-1"]
      }
    ])
  );
  const dangling = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(dangling.ok, false);
  assert.ok(dangling.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_REFERENCE_MISSING"));
});

test("campaign gate still applies to project-owned split recon campaign nodes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-split-campaign" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
      schema_version: "ultrafuzz.property-campaign.v1",
      fuzzer_backend: "recon",
      failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-unknown"] }]
    })
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      {
        schema_version: "1.0",
        id: "failure-1",
        title: "Property failure",
        status: "reproduced",
        severity_guess: "medium",
        confidence: "high",
        summary: "The property failed.",
        property_ids: ["property-unknown"]
      }
    ])
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
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-recon-report" });
  const node = { ...plannedNode(["report.json"]), id: "final-report", logical_id: "final-report" };
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
      schema_version: "ultrafuzz.property-campaign.v1",
      fuzzer_backend: "recon",
      failures: [{ id: "finding-property", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    layout,
    node.id,
    "report.json",
    JSON.stringify({
      schema_version: "1.0",
      run_metadata: {},
      issues: [],
      non_production_outcomes: [],
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
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  // A report claiming a backend the campaign never recorded is still rejected.
  writeArtifact(
    layout,
    node.id,
    "report.json",
    JSON.stringify({
      schema_version: "1.0",
      run_metadata: {},
      issues: [],
      non_production_outcomes: [],
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
      ]
    })
  );
  const mismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_FUZZER_BACKEND_MISMATCH"));
});

test("final report gate rejects dangling property references while allowing historical provenance", () => {
  const historicalLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-historical-report" });
  const node = {
    ...plannedNode(["report.json"]),
    id: "final-report",
    logical_id: "final-report"
  };
  writeArtifact(
    historicalLayout,
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
  assert.equal(verifyRequiredArtifactsForAttempt(historicalLayout, node, node.id).ok, true);

  const smokeLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-smoke-report" });
  writeArtifact(
    smokeLayout,
    node.id,
    "report.json",
    JSON.stringify({
      schema_version: "1.0",
      run_metadata: {},
      issues: [],
      non_production_outcomes: [],
      property_provenance: []
    })
  );
  assert.equal(verifyRequiredArtifactsForAttempt(smokeLayout, node, node.id).ok, true);

  const currentLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-current-report" });
  writeArtifact(
    currentLayout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
      schema_version: "ultrafuzz.property-campaign.v1",
      fuzzer_backend: "echidna",
      failures: [{ id: "finding-property", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    currentLayout,
    "stateful-invariant-campaign",
    "medusa-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v1",
      fuzzer_backend: "medusa",
      failures: [{ id: "finding-property", status: "reproduced", property_ids: ["property-1"] }]
    })
  );
  writeArtifact(
    currentLayout,
    node.id,
    "report.json",
    JSON.stringify({
      schema_version: "1.0",
      run_metadata: {},
      issues: [],
      non_production_outcomes: [],
      property_provenance: [
        {
          finding_id: "finding-property",
          title: "Property failure",
          property_ids: ["property-unknown"],
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
          implementation_paths: [],
          test_paths: []
        }
      ]
    })
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
    JSON.stringify({
      schema_version: "1.0",
      run_metadata: {},
      issues: [],
      non_production_outcomes: [],
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
      ]
    })
  );
  const incompleteJoin = verifyRequiredArtifactsForAttempt(currentLayout, node, node.id);
  assert.equal(incompleteJoin.ok, false);
  assert.ok(incompleteJoin.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_SOURCES_MISMATCH"));

  writeArtifact(
    currentLayout,
    node.id,
    "report.json",
    JSON.stringify({
      schema_version: "1.0",
      run_metadata: {},
      issues: [],
      non_production_outcomes: [],
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
      ]
    })
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
      schema_version: "ultrafuzz.properties.v1",
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
      schema_version: "ultrafuzz.implemented-properties.v1",
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
  const baseReport = {
    schema_version: "1.0",
    run_metadata: {},
    issues: [],
    non_production_outcomes: []
  };
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
        reference_expectation_ids: []
      }
    })
  );
  writeArtifact(
    layout,
    node.id,
    "report.md",
    "# Ultrafuzz report\n\n## Property implementation coverage\n\n- Implemented: 1\n"
  );
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, true);

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
        reference_expectation_ids: []
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
    configFingerprint: "config",
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
