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

  it("keeps the final invariant campaign backend-neutral and dual-backend", () => {
    const campaign = prompt("strategies/invariants/invariant-testing-campaign.md");
    const aggregate = prompt("review/aggregate-test-files.md");
    const dynamic = prompt("strategies/dynamic-strategy-generator.md");
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topologySource = readFileSync(topologyPath, "utf8");
    const topology = YAML.parse(topologySource) as {
      nodes: { id: string; depends_on?: string[]; outputs?: Array<{ path: string }> }[];
    };
    const campaignNode = topology.nodes.find((node) => node.id === "stateful-invariant-campaign");

    expect(campaignNode?.outputs?.map((output) => output.path)).toEqual(
      expect.arrayContaining([
        "campaign-plan.json",
        "campaign-summary.json",
        "campaign-report.md",
        "echidna-results.json",
        "medusa-results.json",
        "generated-tests.json",
        "findings.json"
      ])
    );
    expect(topology.nodes.find((node) => node.id === "dynamic-strategy-generator")?.depends_on).toContain(
      "stateful-invariant-campaign"
    );
    expect(topology.nodes.find((node) => node.id === "dedupe-findings")?.depends_on).toContain(
      "stateful-invariant-campaign"
    );
    expect(`${topologySource}\n${aggregate}\n${dynamic}`).not.toContain("stateful-invariant-recon-campaign");
    expect(aggregate).toContain("{{artifact_path:stateful-invariant-campaign}}/generated-tests.json");
    expect(dynamic).toContain("{{artifact_path:stateful-invariant-campaign}}/generated-tests.json");

    expect(campaign).toContain("Echidna and Medusa");
    expect(campaign).toContain("one implemented Chimera property suite");
    expect(campaign).toContain("Recon is only the coverage backend and deployment smoke");
    expect(campaign).toContain("Preserve the existing priority-threshold selection");
    expect(campaign).toContain("workers_per_fuzzer = max(1, floor(available_vcpus / 2))");
    expect(campaign).toContain("1 vCPU means 1 worker");
    expect(campaign).toContain("2 vCPUs means 1 worker per backend in parallel");
    expect(campaign).toMatch(/odd\s+counts of at least 3/u);
    expect(campaign).toContain("even counts use `available_vcpus / 2`");
    expect(campaign).toContain("same parent deadline");
    expect(campaign).toContain("two equal fixed slices");
    expect(campaign).toContain("finalization reserve");
    expect(campaign).toContain("backends/echidna");
    expect(campaign).toContain("backends/medusa");
    expect(campaign).toContain("Finalize both backend records before deduplicating failures");
    expect(campaign).toContain("all contributing backend provenance");
    expect(campaign).toContain("A later pass or a passing result from the other backend must never erase");
    expect(campaign).toContain("property_ids");
    expect(campaign).toContain("deterministic Foundry reproducer for every unique failure");
    expect(campaign).toContain("classify it as `blocked-unreproduced`");
    expect(campaign).toContain("`complete`: Echidna and Medusa both ran to their expected terminal state");
    expect(campaign).toContain("`partial`: exactly one backend was unavailable");
    expect(campaign).toContain("`blocked`: neither backend produced usable results");
    expect(campaign).toMatch(/start\/end timestamps so\s+multi-vCPU runs prove that the two campaigns overlapped/u);
  });

  it("keeps generated-test manifests on the canonical generated_tests contract", () => {
    const aggregate = prompt("review/aggregate-test-files.md");
    const dynamic = prompt("strategies/dynamic-strategy-generator.md");
    const templatePath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/generated-tests.mdx", import.meta.url)
    );
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: { id: string; outputs?: Array<{ path: string }> }[];
    };
    const requiredArtifactsById = new Map(
      topology.nodes.map((node) => [node.id, (node.outputs ?? []).map((output) => output.path)])
    );
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
      /id: reference-harness-author[\s\S]*outputs:[\s\S]*path: generated-tests\.json/u
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
    const template = readFileSync(templatePath, "utf8");
    expect(template).toContain("Use `[]` when there are no findings");
    expect(template).toContain("without anchors or line selectors");
  });

  it("keeps Vyper target setup guidance concrete for Foundry harnesses", () => {
    const projectDiscovery = prompt("setup/project-discovery.md");
    const setupFoundry = prompt("setup/prepare-foundry-harness.md");
    const baseSetup = prompt("setup/discover-base-test.md");

    expect(projectDiscovery).toContain("whether production contracts are Solidity, Vyper, or mixed Solidity/Vyper");
    expect(projectDiscovery).toContain("`.vy` production contracts");
    expect(projectDiscovery).toContain("`vyper` or `vyper-json` commands");
    expect(projectDiscovery).toContain("Vyper-only projects as still needing Solidity-based Foundry tests");

    expect(setupFoundry).toContain("`test/foundry/<strategy>`");
    expect(setupFoundry).toMatch(/do not ask Foundry to\s+compile `\.vy` files as Solidity sources/u);
    expect(setupFoundry).toContain("Solidity interfaces");
    expect(setupFoundry).toContain("public/external ABI");
    expect(setupFoundry).toContain("target project's pinned compiler/tooling");
    expect(setupFoundry).toContain("`vm.ffi`");
    expect(setupFoundry).toContain("hex-decodes the compiler stdout");
    expect(setupFoundry).toContain("ABI-encoded `__init__`");
    expect(setupFoundry).toContain("without a function selector");
    expect(setupFoundry).toContain("`bytes.concat(decodedBytecode, abi.encode(...))`");
    expect(setupFoundry).toContain("inline `create`");
    expect(setupFoundry).toContain("never pass undecoded `vm.ffi` stdout directly to `create`");
    expect(setupFoundry).toContain("`forge test --ffi`");
    expect(setupFoundry).toContain("`ffi = true`");
    expect(setupFoundry).toContain("`vm.etch` writes runtime bytecode");
    expect(setupFoundry).toContain("does not run constructor");
    expect(setupFoundry).toMatch(/project-local\s+Vyper dependency is unavailable/u);

    expect(baseSetup).toContain("Vyper-aware while keeping the tests");
    expect(baseSetup).toContain("ABI-derived interfaces");
    expect(baseSetup).toContain("`vyper`, or `vyper-json`");
    expect(baseSetup).toContain("`vm.ffi` plus inline `create`");
    expect(baseSetup).toContain("hex-decode ASCII hex compiler stdout");
    expect(baseSetup).toContain("append ABI-encoded `__init__` constructor");
    expect(baseSetup).toContain("without a function selector");
    expect(baseSetup).toContain("`bytes.concat(decodedBytecode, abi.encode(...))`");
    expect(baseSetup).toContain("Do not pass undecoded `vm.ffi` stdout directly to `create`");
    expect(baseSetup).toContain("constructor-dependent Vyper contracts need decoded initcode");
    expect(baseSetup).toContain("`vm.etch` does not run constructors or init code");
    expect(baseSetup).toContain("project-local Vyper dependencies as explicit validation blockers");
  });
});
