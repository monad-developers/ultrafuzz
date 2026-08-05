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
  it("routes every property lens through the task-local JSON schema bundle", () => {
    const propertyPrompts = loadBuiltInPromptAssets().filter((asset) => asset.relativePath.startsWith("properties/"));
    expect(propertyPrompts.length).toBeGreaterThan(0);
    for (const asset of propertyPrompts) {
      expect(asset.markdown, asset.relativePath).not.toContain("packages/artifacts/schema/");
      if (asset.markdown.includes("property-lens.schema.json") || asset.markdown.includes("properties.schema.json")) {
        expect(asset.markdown, asset.relativePath).toContain("{{schema_path}}/");
      }
    }
  });

  it("preserves source-guided denial-of-service and liveness requirements", () => {
    const lensPrompts = loadBuiltInPromptAssets().filter((asset) =>
      [
        "properties/0kn0t-lens.md",
        "properties/aviggiano-lens.md",
        "properties/certora-thinking-lens.md",
        "properties/josselin-feist-lens.md",
        "properties/property-specification-a16z.md",
        "properties/property-specification-crytic.md",
        "properties/property-specification-runtime-verification.md",
        "properties/recon-lens.md"
      ].includes(asset.relativePath)
    );

    expect(lensPrompts).toHaveLength(8);
    for (const asset of lensPrompts) {
      expect(asset.markdown, asset.relativePath).toContain(
        "Source-preserving liveness requirements"
      );
      expect(asset.markdown, asset.relativePath).toContain(
        "supply, withdraw, repay, and liquidation"
      );
      expect(asset.markdown, asset.relativePath).toContain(
        "input-validation exceptions"
      );
    }
  });

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

  it("keeps the final invariant campaign backend-neutral on the single recon-fuzzer backend", () => {
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
        "recon-fuzzer-results.json",
        "generated-tests.json",
        "findings.json"
      ])
    );
    expect(campaignNode?.outputs?.map((output) => output.path)).not.toContain("echidna-results.json");
    expect(campaignNode?.outputs?.map((output) => output.path)).not.toContain("medusa-results.json");
    expect(topology.nodes.find((node) => node.id === "dynamic-strategy-generator")?.depends_on).toContain(
      "stateful-invariant-campaign"
    );
    expect(topology.nodes.find((node) => node.id === "dedupe-findings")?.depends_on).toContain(
      "stateful-invariant-campaign"
    );
    expect(`${topologySource}\n${aggregate}\n${dynamic}`).not.toContain("stateful-invariant-recon-campaign");
    expect(aggregate).toContain("{{artifact_path:stateful-invariant-campaign}}/generated-tests.json");
    expect(dynamic).toContain("{{artifact_path:stateful-invariant-campaign}}/generated-tests.json");

    expect(campaign).toContain("final recon-fuzzer campaign");
    expect(campaign).toContain("one implemented Chimera property suite");
    expect(campaign).toContain("recon-fuzzer is the single final bug-finding backend");
    expect(campaign).toContain("Preserve the existing priority-threshold selection");
    expect(campaign).toContain("workers = max(1, available_vcpus)");
    expect(campaign).toContain("1 vCPU means 1 worker");
    expect(campaign).toMatch(/higher\s+counts use `available_vcpus` workers on the one backend/u);
    expect(campaign).toContain("finalization reserve");
    expect(campaign).toContain("do not divide it into per-backend slices");
    expect(campaign).toContain("backends/recon-fuzzer");
    expect(campaign).not.toContain("backends/echidna");
    expect(campaign).not.toContain("backends/medusa");
    expect(campaign).toContain("Finalize the backend record before deduplicating failures");
    expect(campaign).toContain("all contributing backend provenance");
    expect(campaign).toContain("A later pass must never erase");
    expect(campaign).toContain("property_ids");
    expect(campaign).toContain("deterministic Foundry reproducer for every unique failure");
    expect(campaign).toContain("classify it as `blocked-unreproduced`");
    expect(campaign).toContain("`complete`: recon-fuzzer ran to its expected terminal state");
    expect(campaign).toContain("`partial`: recon-fuzzer produced usable results but ended early");
    expect(campaign).toContain("`blocked`: recon-fuzzer produced no usable results");
    expect(campaign).toContain("--workers <workers>");
    expect(campaign).toContain("using the literal\nstring `recon`");
    expect(campaign).toContain("{{artifact_dir}}/recon-fuzzer-results.json");
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

  it("keeps admin/config tests target-native and mirrors canonical generated-test companions", () => {
    const admin = prompt("strategies/admin-config-boundaries.md");

    expect(admin).toContain("focused target-native tests");
    expect(admin).toContain("Base test setup (when rendered):");
    expect(admin).not.toContain("Base Foundry setup:");
    expect(admin).toContain("For Foundry targets, write `.t.sol`");
    expect(admin).toMatch(/For\s+Hardhat targets, use the existing JavaScript or TypeScript test location/u);
    expect(admin).toMatch(/For Vyper targets, use the existing pytest, Ape,\s+Brownie/u);
    expect(admin).toContain("Keep every generated test");
    expect(admin).toContain("inside `{{workspace_path}}`");
    expect(admin).toMatch(/Do not introduce Foundry into a Hardhat or Vyper\s+target/u);
    expect(admin).toMatch(/Do not install or fetch\s+missing tools or dependencies/u);
    expect(admin).toContain("{{artifact_dir}}/generated-tests/GeneratedTest.ext");
    expect(admin).toContain("`generated-tests/<relative-file>` path");
    expect(admin).toContain("{{artifact_dir}}/generated-tests.json");
    expect(admin).toContain("Never list the workspace");
  });

  it("validates deduped native reproducers without hydrating isolated workspaces", () => {
    const dedupe = prompt("review/dedupe-findings.md");

    expect(dedupe).toContain("{{artifact_path:project-discovery}}/setup/project-discovery.md");
    expect(dedupe).toContain("{{artifact_path:base-test-setup}}/setup/base-test-setup.md");
    expect(dedupe).toContain("For Foundry");
    expect(dedupe).toContain("For Hardhat");
    expect(dedupe).toContain("For Vyper");
    expect(dedupe).toContain("For mixed repositories");
    expect(dedupe).toMatch(/manifest\s+`framework` and `language`/u);
    expect(dedupe).toContain("Strategy workspaces are isolated from this node");
    expect(dedupe).toContain("copy only its exact byte-for-byte canonical");
    expect(dedupe).toContain("under the existing native test root in\n`{{workspace_path}}`");
    expect(dedupe).toContain("normalized relative POSIX");
    expect(dedupe).toContain("every symlink even when its\ntarget remains inside the artifact directory");
    expect(dedupe).toContain("Never search a strategy workspace");
    expect(dedupe).toContain("Never install, fetch, restore, or update dependencies during dedupe");
    expect(dedupe).not.toContain("restore project-pinned dependencies first");
    expect(dedupe).not.toContain("Dependency hydration used only");
  });

  it("aggregates canonical generated-test companions into framework-native roots", () => {
    const aggregate = prompt("review/aggregate-test-files.md");

    expect(aggregate).toContain("canonical generated-test companions");
    expect(aggregate).toContain("`generated_tests` array as the source of truth");
    expect(aggregate).toContain("exact byte-for-byte companion");
    expect(aggregate).toContain("normalized relative POSIX");
    expect(aggregate).toContain("every symlink even when its target remains\ninside the artifact directory");
    expect(aggregate).toContain("Foundry `.t.sol`");
    expect(aggregate).toContain("Hardhat `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, or `.mts`");
    expect(aggregate).toContain("existing native Python test `.py` files");
    expect(aggregate).toContain("repository's existing JavaScript or TypeScript test root");
    expect(aggregate).toContain("existing pytest, Ape, Brownie, or other native test root");
    expect(aggregate).toContain("never overwrite one entry with another");
    expect(aggregate).toContain("Do not copy unknown manifest\nentry fields");
    expect(aggregate).not.toContain("source_manifest_entry");
    expect(aggregate).not.toContain("collect generated Foundry `.t.sol` files");
  });

  it("embeds one self-contained reproducer in the target's native language", () => {
    const report = prompt("review/final-report.md");

    expect(report).toContain("generated target-native reproducers belong in the normal issue");
    expect(report).toContain("exact canonical `generated-tests/<relative-file>` companion");
    expect(report).toContain("exactly one fenced code\nblock");
    expect(report).toContain("minimized self-contained target-native reproducer");
    expect(report).toContain("`solidity` for Foundry `.t.sol`");
    expect(report).toContain("`javascript` or `typescript` for Hardhat");
    expect(report).toContain("`python` (or `vyper`");
    expect(report).toContain("Never translate a JavaScript, TypeScript");
    expect(report).toContain("report must be self-sufficient");
    expect(report).toContain("Stop and report an invalid\nupstream artifact");
    expect(report).not.toContain("generated Solidity PoCs");
    expect(report).not.toContain("minimized self-contained Foundry reproducer");
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
    expect(markdown).toContain("canonical normalized finding");
    expect(markdown).toContain("`severity_guess`, `severity`, `impact`, and");
    expect(markdown).toContain("canonical `strategy` field a non-empty");
    expect(markdown).toContain("structured `strategy_provenance` object");
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
