import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { artifactSchemaRegistry } from "@ultrafuzz/artifacts";

import { extractPromptVariables, loadBuiltInPromptAssets } from "../src/index.js";

// Prompt wording is deliberately not pinned here: the output contract and the artifact gates decide
// what a prompt's artifacts must contain. These tests cover what neither the prompt catalog loader,
// the renderer, nor topology validation checks: how shipped prompts bind producers and schemas, and
// the reference docs' copy of a shared output-contract partial.

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
      for (const [reference, filename = ""] of asset.markdown.matchAll(/\{\{schema_path\}\}\/([\w.-]+)/gu)) {
        references += 1;
        expect(shipped.has(filename), `${asset.relativePath}: ${reference}`).toBe(true);
      }
    }
    expect(references).toBeGreaterThan(0);
  });

  it("keeps the reference docs' copy of the coverage-evidence Markdown partial verbatim", () => {
    const partialPath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/coverage-evidence-markdown.mdx", import.meta.url)
    );
    const docsPath = fileURLToPath(new URL("../../../docs/reference/artifacts-reports.md", import.meta.url));

    expect(readFileSync(docsPath, "utf8")).toContain(readFileSync(partialPath, "utf8").trim());
  });
});
