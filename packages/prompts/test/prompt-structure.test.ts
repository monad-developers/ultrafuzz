import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { artifactSchemaRegistry } from "@ultrafuzz/artifacts";

import { extractPromptVariables, loadBuiltInPromptAssets, type PromptVariableReference } from "../src/index.js";

// Prompt wording is deliberately not pinned here: the output contract and the artifact gates decide
// what a prompt's artifacts must contain. These tests cover what neither the prompt catalog loader,
// the renderer, nor topology validation checks: how shipped prompts bind producers, schemas and
// runtime-owned values, and the reference docs' copy of a shared output-contract partial.

// Template variables a shipped prompt must keep. The catalog loader, the renderer and topology
// validation only check the references a prompt makes, so a prompt without one of these still loads.
// Each binds something the runtime relies on after the agent finishes:
// - a gate compares the node's output with it: the coverage producer's copy of the coverage-evidence
//   partial (COVERAGE_EVIDENCE_MARKDOWN_MISMATCH), the report's coverage evidence
//   (REPORT_COVERAGE_EVIDENCE_MISMATCH) and goal-search census (the verified
//   report must equal its census-aware projection), the property selection settings
//   (PROPERTY_IMPLEMENTATION_SELECTION_CONFIG_MISMATCH) and the dynamic enumerator policy;
// - the runtime reserves it in the invariant campaign's node window: the smoke and fuzzer budgets;
// - it is the node's only view of runtime-sealed evidence: its ancestors' outputs selected by
//   contract or path (`ancestor_*_authority`), or the goal-search census;
// - the goal-search census records the node's result as coverage of the goal it was generated for:
//   the goal hunter's `item.node_id`, which picks that goal out of a goal plan listing every goal.
// `ancestor_artifact_path_authority:<path>` is kept when any path selector in the prompt lists <path>.
const REQUIRED_PROMPT_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  "properties/property-specification-fanin.md": ["ancestor_contract_artifact_authority:ultrafuzz/property-lens@2"],
  "review/aggregate-test-files.md": ["ancestor_contract_artifact_authority:ultrafuzz/generated-tests@3"],
  "review/dedupe-findings.md": [
    "ancestor_contract_artifact_authority:ultrafuzz/findings@2",
    "ancestor_contract_artifact_authority:ultrafuzz/generated-tests@3",
    "goal_search_coverage_path"
  ],
  "review/final-report.md": ["ancestor_artifact_path_authority:coverage-evidence.json", "goal_search_coverage_path"],
  "strategies/differential/differential-lane-author.md": [
    "ancestor_contract_artifact_authority:ultrafuzz/audited-differential-lanes@1"
  ],
  "strategies/differential/differential-red-triage.md": [
    "ancestor_contract_artifact_authority:ultrafuzz/differential-lane-result@1"
  ],
  "strategies/differential/differential-repair-and-report-review.md": [
    "ancestor_contract_artifact_authority:ultrafuzz/audited-differential-lanes@1",
    "ancestor_contract_artifact_authority:ultrafuzz/differential-lane-result@1",
    "ancestor_contract_artifact_authority:ultrafuzz/differential-red-triage@1",
    "ancestor_contract_artifact_authority:ultrafuzz/semantic-red-registry@1"
  ],
  "strategies/differential/reference-and-lane-auditor.md": [
    "ancestor_contract_artifact_authority:ultrafuzz/differential-plan@1",
    "ancestor_contract_artifact_authority:ultrafuzz/reference-harness@1"
  ],
  "strategies/differential/reference-harness-author.md": [
    "ancestor_contract_artifact_authority:ultrafuzz/differential-plan@1"
  ],
  "strategies/dynamic-strategy-generator.md": [
    "ancestor_contract_artifact_authority:ultrafuzz/boundary-recipes@1",
    "ancestor_contract_artifact_authority:ultrafuzz/findings@2",
    "ancestor_contract_artifact_authority:ultrafuzz/generated-tests@3",
    "dynamic_strategies_enumerator"
  ],
  "strategies/goal-hunter.mdx": ["item.node_id"],
  "strategies/invariants/coverage.md": ["coverage_evidence_markdown_projection", "invariant_testing_smoke_timeout"],
  "strategies/invariants/handlers.md": ["invariant_testing_smoke_timeout"],
  "strategies/invariants/implement-properties.md": [
    "ancestor_artifact_path_authority:coverage-report.md",
    "invariant_property_priorities",
    "invariant_property_priority_threshold",
    "invariant_reference_expectation_selection",
    "invariant_testing_smoke_timeout"
  ],
  "strategies/invariants/invariant-testing-campaign.md": [
    "ancestor_artifact_path_authority:coverage-report.md",
    "invariant_testing_fuzzer_timeout",
    "invariant_testing_smoke_timeout"
  ],
  "strategies/invariants/setup.md": ["invariant_testing_smoke_timeout"]
};

// The gates accept exactly one canonical scoped-coverage section, so the prompt carries one copy.
const EXACTLY_ONCE_PROMPT_VARIABLES = new Set(["coverage_evidence_markdown_projection"]);

// Template variables a shipped prompt must not use. report.md carries no scoped-coverage section,
// and the final-report gate rejects one (REPORT_COVERAGE_EVIDENCE_MARKDOWN_UNEXPECTED), so the report
// prompt must not hand its agent the coverage producer's section format.
const FORBIDDEN_PROMPT_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  "review/final-report.md": ["coverage_evidence_markdown_projection"]
};

// The canonical renderer's Run summary labels, in order. The report prompt's Markdown example shows
// the agent this list; the renderer and `ultrafuzz report`'s accounting diagnostics read these labels.
const RUN_SUMMARY_LABELS = [
  "Run ID",
  "Repository",
  "Commit",
  "Elapsed time",
  "Models used",
  "Tokens used",
  "Estimated spend",
  "Audit profile"
];

function requirementKeys(reference: PromptVariableReference): string[] {
  if (reference.argument === undefined) return [reference.name];
  if (reference.name === "ancestor_artifact_path_authority") {
    return reference.argument.split(",").map((relativePath) => `${reference.name}:${relativePath}`);
  }
  return [`${reference.name}:${reference.argument}`];
}

interface ShippedTopologyNode {
  id: string;
  kind: string;
  prompt?: string;
  group?: string;
  loops?: number;
  model_profiles?: string[];
}

interface ShippedTopology {
  defaults: { strategy_loops: number };
  groups?: Record<string, { defaults?: { loops?: number; model_profiles?: string[] } }>;
  nodes: ShippedTopologyNode[];
}

const SHIPPED_TOPOLOGIES = [
  [".ultrafuzz/topology.yml", "../../../.ultrafuzz/topology.yml"],
  ["packages/config/topologies/default.yml", "../../config/topologies/default.yml"],
  ["packages/config/topologies/exhaustive.yml", "../../config/topologies/exhaustive.yml"],
  ["packages/config/topologies/invariant-only.yml", "../../config/topologies/invariant-only.yml"],
  ["packages/config/topologies/smoke.yml", "../../config/topologies/smoke.yml"]
] as const;

function readTopology(relativePath: string): ShippedTopology {
  const topologyPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return YAML.parse(readFileSync(topologyPath, "utf8")) as ShippedTopology;
}

function effectiveAttemptCount(topology: ShippedTopology, node: ShippedTopologyNode): number {
  const groupDefaults = node.group === undefined ? undefined : topology.groups?.[node.group]?.defaults;
  const loops =
    node.loops ??
    groupDefaults?.loops ??
    (node.kind === "agentic" && node.group === "strategies" ? topology.defaults.strategy_loops : 1);
  const profiles =
    node.kind === "agentic"
      ? node.model_profiles?.length
        ? node.model_profiles
        : groupDefaults?.model_profiles?.length
          ? groupDefaults.model_profiles
          : ["current-profile"]
      : ["current-profile"];
  return loops * profiles.length;
}

function topologyPromptPath(node: ShippedTopologyNode): string | undefined {
  if (node.kind !== "agentic") return undefined;
  return node.prompt ?? (node.group === undefined ? `${node.id}.md` : `${node.group}/${node.id}.md`);
}

describe("shipped prompt structure", () => {
  // `{{artifact_path:<id>}}` and `{{artifact_handoff:<id>}}` render a path for every producer attempt,
  // as a Markdown list when there is more than one, so they cannot stand in for the single path a
  // prompt names inline. Fan-out producers are read through the ancestor authority selectors instead.
  it("keeps named producer helpers on exactly one effective shipped attempt", () => {
    const assetsByPath = new Map(loadBuiltInPromptAssets().map((asset) => [asset.relativePath, asset]));

    for (const [topologyName, relativePath] of SHIPPED_TOPOLOGIES) {
      const topology = readTopology(relativePath);
      const nodesById = new Map(topology.nodes.map((node) => [node.id, node]));

      for (const consumer of topology.nodes) {
        const promptPath = topologyPromptPath(consumer);
        if (promptPath === undefined) continue;
        const asset = assetsByPath.get(promptPath);
        expect(asset, `${topologyName}: ${consumer.id} prompt ${promptPath}`).toBeDefined();
        if (asset === undefined) continue;

        for (const reference of extractPromptVariables(asset.markdown, { allowDynamicItemVariables: true })) {
          if (
            (reference.name !== "artifact_path" && reference.name !== "artifact_handoff") ||
            reference.argument === undefined
          ) {
            continue;
          }
          const producer = nodesById.get(reference.argument);
          expect(producer, `${topologyName}: ${consumer.id} uses ${reference.raw}`).toBeDefined();
          if (producer === undefined) continue;
          expect(
            effectiveAttemptCount(topology, producer),
            `${topologyName}: ${consumer.id} uses ${reference.raw}`
          ).toBe(1);
        }
      }
    }
  });

  // `{{schema_path}}` is the task workspace's `.ultrafuzz/schemas`, which the runtime fills from the
  // artifact schema registry. A prompt that names any other file there, or a repository schema path,
  // points the agent at a schema the task is not given.
  it("names only schemas the task schema bundle ships", () => {
    const shipped = new Set(artifactSchemaRegistry().map((entry) => entry.filename));
    let references = 0;
    for (const asset of loadBuiltInPromptAssets()) {
      expect(asset.markdown, asset.relativePath).not.toContain("packages/artifacts/schema/");
      // Dots and slashes only between path segments, so a sentence-final period is not part of the
      // path, while `sub/findings.schema.json` or `findings.schema.json/old` is read whole and rejected.
      for (const [reference, filename = ""] of asset.markdown.matchAll(
        /\{\{schema_path\}\}\/([\w-]+(?:[./][\w-]+)*)/gu
      )) {
        references += 1;
        expect(shipped.has(filename), `${asset.relativePath}: ${reference}`).toBe(true);
      }
    }
    expect(references).toBeGreaterThan(0);
  });

  it("keeps the template variables that gates, budgets and sealed authorities depend on", () => {
    const assetsByPath = new Map(loadBuiltInPromptAssets().map((asset) => [asset.relativePath, asset]));

    for (const [promptPath, variables] of Object.entries(REQUIRED_PROMPT_VARIABLES)) {
      const asset = assetsByPath.get(promptPath);
      expect(asset, promptPath).toBeDefined();
      const counts = new Map<string, number>();
      for (const reference of extractPromptVariables(asset?.markdown ?? "", { allowDynamicItemVariables: true })) {
        for (const key of requirementKeys(reference)) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const variable of variables) {
        const count = counts.get(variable) ?? 0;
        if (EXACTLY_ONCE_PROMPT_VARIABLES.has(variable)) expect(count, `${promptPath}: {{${variable}}}`).toBe(1);
        else expect(count, `${promptPath}: {{${variable}}}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps template variables out of prompts whose gates reject what they render", () => {
    const assetsByPath = new Map(loadBuiltInPromptAssets().map((asset) => [asset.relativePath, asset]));

    for (const [promptPath, variables] of Object.entries(FORBIDDEN_PROMPT_VARIABLES)) {
      const asset = assetsByPath.get(promptPath);
      expect(asset, promptPath).toBeDefined();
      const names = new Set(
        extractPromptVariables(asset?.markdown ?? "", { allowDynamicItemVariables: true }).flatMap(requirementKeys)
      );
      for (const variable of variables) expect(names.has(variable), `${promptPath}: {{${variable}}}`).toBe(false);
    }
  });

  it("shows the canonical Run summary labels in the final-report Markdown example", () => {
    const asset = loadBuiltInPromptAssets().find((entry) => entry.relativePath === "review/final-report.md");
    expect(asset).toBeDefined();
    const markdown = asset?.markdown ?? "";
    const exampleStart = markdown.indexOf("```md\n# Ultrafuzz report\n");
    expect(exampleStart, "final-report.md report-opening example").toBeGreaterThanOrEqual(0);
    const example = markdown.slice(exampleStart, markdown.indexOf("\n```\n", exampleStart));
    const summaryStart = example.indexOf("\n## Run summary\n");
    expect(summaryStart, "final-report.md Run summary example").toBeGreaterThanOrEqual(0);
    const summary = example.slice(summaryStart);
    const labels = [...summary.matchAll(/^- ([^:\n]+): /gmu)].map((match) => match[1]);

    expect(labels).toEqual(RUN_SUMMARY_LABELS);
  });

  it("keeps the reference docs' copy of the coverage-evidence Markdown partial verbatim", () => {
    const partialPath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/coverage-evidence-markdown.mdx", import.meta.url)
    );
    const docsPath = fileURLToPath(new URL("../../../docs/reference/artifacts-reports.md", import.meta.url));

    expect(readFileSync(docsPath, "utf8")).toContain(readFileSync(partialPath, "utf8").trim());
  });
});
