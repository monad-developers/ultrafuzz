import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { loadBuiltInPromptAssets } from "../src/index.js";

function prompt(relativePath: string): string {
  const asset = loadBuiltInPromptAssets().find((entry) => entry.relativePath === relativePath);
  if (!asset) {
    throw new Error(`missing built-in prompt ${relativePath}`);
  }
  return asset.markdown;
}

function generatedTestManifestSources(markdown: string): string[] {
  return [...markdown.matchAll(/\{\{artifact_path:([^}]+)\}\}\/generated-tests\.json/gu)].map((match) => match[1]!);
}

describe("prompt semantic anchors", () => {
  it("does not require unused fuzzer CLIs during project discovery", () => {
    const markdown = prompt("setup/project-discovery.md");
    const promptCorpus = loadBuiltInPromptAssets()
      .map((asset) => asset.markdown)
      .join("\n");

    expect(markdown).toContain("forge --version");
    expect(promptCorpus).not.toContain("echidna --version");
    expect(promptCorpus).not.toContain("medusa --version");
    expect(promptCorpus).not.toContain("halmos --version");
    expect(promptCorpus).not.toContain("medusa version");
  });

  it("keeps generated-test manifests on the canonical generated_tests contract", () => {
    const aggregate = prompt("review/aggregate-test-files.md");
    const dynamic = prompt("strategies/dynamic-strategy-generator.md");
    const templatePath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/generated-tests.mdx", import.meta.url)
    );
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: { id: string; required_artifacts?: string[] }[];
    };
    const requiredArtifactsById = new Map(topology.nodes.map((node) => [node.id, node.required_artifacts ?? []]));
    const promptCorpus = loadBuiltInPromptAssets()
      .map((asset) => asset.markdown)
      .join("\n");
    const manifestSources = new Set([
      ...generatedTestManifestSources(aggregate),
      ...generatedTestManifestSources(dynamic)
    ]);

    expect(readFileSync(templatePath, "utf8")).toContain("generated_tests");
    expect(aggregate).toContain("manifest `generated_tests` entries");
    expect(dynamic).toContain("`generated_tests` carrying");
    expect(`${readFileSync(templatePath, "utf8")}\n${promptCorpus}`).not.toContain("test_files");
    expect(readFileSync(topologyPath, "utf8")).toMatch(
      /id: reference-harness-author[\s\S]*required_artifacts:[\s\S]*- generated-tests\.json/u
    );
    for (const sourceId of manifestSources) {
      expect(requiredArtifactsById.get(sourceId), sourceId).toContain("generated-tests.json");
    }
  });

  it("keeps the severity matrix and reportability gates in the classifier prompt", () => {
    const markdown = prompt("review/severity-classification.md");

    expect(markdown).toContain("Impact x Likelihood");
    expect(markdown).toContain("| High | High | High | Medium |");
    expect(markdown.toLowerCase()).toContain("public reachability");
    expect(markdown).toContain("incomplete-spec");
    expect(markdown).toContain("final_severity == matrix(impact, likelihood)");
    expect(markdown).toContain("Do not emit `Critical`");
  });

  it("keeps the final-report matrix guard in the report prompt", () => {
    const markdown = prompt("review/final-report.md");

    expect(markdown).toContain("Impact x Likelihood");
    expect(markdown).toContain("High impact + Low likelihood must render as Medium");
    expect(markdown).toContain("Medium impact + Low likelihood must render as Low");
    expect(markdown).toContain("Every production issue severity equals the Impact x Likelihood matrix result");
  });

  it("keeps the empty findings array contract in prompt-owned templates", () => {
    const templatePath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/findings.mdx", import.meta.url)
    );
    expect(readFileSync(templatePath, "utf8")).toContain("Use `[]` when there are no findings");
  });
});
