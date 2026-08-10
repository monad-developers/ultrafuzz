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

  it("grounds reference expectation metadata in supplied JSON catalogs", () => {
    const propertyPrompts = loadBuiltInPromptAssets().filter(
      (asset) =>
        asset.relativePath.startsWith("properties/") &&
        asset.relativePath !== "properties/property-specification-fanin.md"
    );
    expect(propertyPrompts).toHaveLength(8);
    for (const asset of propertyPrompts) {
      expect(asset.markdown, asset.relativePath).toContain("exact identifiers present in the");
      expect(asset.markdown, asset.relativePath).toContain("{{schema_path}}/reference-expectations.schema.json");
      expect(asset.markdown, asset.relativePath).not.toContain("scfuzzbench:aave-v4:iSpoke_supply");
    }
    const fanin = prompt("properties/property-specification-fanin.md");
    expect(fanin).toContain("{{schema_path}}/reference-expectations.schema.json");
    expect(fanin).not.toContain("scfuzzbench:aave-v4:iSpoke_supply");
    expect(prompt("strategies/invariants/implement-properties.md")).not.toContain("scfuzzbench:aave-v4:iSpoke_supply");
  });

  // Two prompts told the model to do something the gates then rejected, and each cost a live Aave run a
  // full agentic node attempt before being found (#291, #297, #299). The gate halves are fixed; these
  // anchors keep the prompt halves from drifting back, since a prompt that contradicts its gate is only
  // discoverable by burning a node.
  it("states that optional evidence fields are optional", () => {
    // Matched on whitespace-normalised text. These anchors exist to stop prose from drifting back into
    // contradicting its gate, and pinning exact line breaks would make an innocent reflow look like a
    // semantic regression.
    const flat = (relativePath: string) => prompt(relativePath).replace(/\s+/gu, " ");

    // `canonical_property.ledger_ids` is `.optional()` with `minItems: 1`, so a property that maps to no
    // ledger entry has nothing to render and must not be asked for an empty field (#297, #299).
    const fanin = flat("properties/property-specification-fanin.md");
    expect(fanin).toContain("when that property has ledger IDs, include its complete `ledger_ids` list");
    expect(fanin).toContain("Omit the `ledger_ids` field entirely for a property that maps to no ledger entry");

    // A scan probe records WHERE the agent searched, so a directory or an absent path is valid (#289,
    // #291). But a probe naming a regular FILE still goes through `readInvariantSourceSnapshot` and is
    // compared against the pinned commit -- an earlier draft of this sentence claimed only ledger
    // entries are byte-checked, which is false, and that is precisely the prompt-versus-gate divergence
    // this anchor exists to prevent.
    const discovery = flat("setup/project-discovery.md");
    expect(discovery).toContain("may name a real directory you searched, or a path that turned out not to exist");
    expect(discovery).toContain("tracked at the pinned commit and unmodified");
    // Both implementations gate on `isDirectory() && !isSymbolicLink()`, and any path reached through a
    // symlinked parent is rejected too, so "a directory" without this caveat is over-broad.
    expect(discovery).toContain("A symlink is not");
    expect(discovery).not.toContain("only ledger `entries` are checked byte-for-byte");

    // The twin sentence four lines below the fan-in change said "render the exact ledger IDs" with no
    // condition, contradicting it. An unconditioned instruction here is worse than an absent one: an
    // empty rendered field is tolerated, but a placeholder such as `ledger_ids: none` is rejected as
    // `INVARIANT_LEDGER_MARKDOWN_MAPPING_EXTRA`.
    expect(fanin).toContain("and, when present, render the exact ledger IDs under a `ledger_ids` field");

    // `reference_expectations` is also optional. The contract accepts empty legacy arrays, but its
    // canonical output form omits the field when there are no IDs. Only the two required path arrays
    // use `[]` to say that a selected property produced no corresponding path (#328).
    const implementation = flat("strategies/invariants/implement-properties.md");
    expect(implementation).toContain(
      "Omit `reference_expectations` from its structured record when the property has none"
    );
    expect(implementation).toContain(
      "Include `implementation_paths` and `test_paths` on every record, using an empty array for either path field when no corresponding path exists"
    );
    expect(implementation).toContain(
      "Omit `reference_expectations` entirely when the property has none; do not emit an empty array"
    );
    expect(implementation).not.toContain("both path arrays on every record");
  });

  it("preserves source-guided denial-of-service and liveness requirements", () => {
    const lensPrompts = loadBuiltInPromptAssets().filter(
      (asset) =>
        asset.relativePath.startsWith("properties/") &&
        asset.relativePath !== "properties/property-specification-fanin.md"
    );

    expect(lensPrompts).toHaveLength(8);
    for (const asset of lensPrompts) {
      expect(asset.markdown, asset.relativePath).toContain("Source-preserving liveness requirements");
      expect(asset.markdown, asset.relativePath).toMatch(
        /supply, withdraw,\s+repay,\s+or liquidation when applicable/u
      );
      expect(asset.markdown, asset.relativePath).toMatch(
        /input-validation exceptions and\s+other preconditions\s+when\s+they apply/u
      );
      expect(asset.markdown, asset.relativePath).toContain("that guidance as explicit property rows");
      expect(asset.markdown, asset.relativePath).toMatch(
        /describe successful completion for valid\s+state and inputs/u
      );
      expect(asset.markdown, asset.relativePath).toContain("high`, `medium`, or `low");
      expect(asset.markdown, asset.relativePath).toMatch(
        /Use `high` for source-described liveness failures affecting user\s+funds or protocol health/u
      );
    }
  });

  it("extracts target-derived equations without collapsing distinct variants", () => {
    const lensPrompts = loadBuiltInPromptAssets().filter(
      (asset) =>
        asset.relativePath.startsWith("properties/") &&
        asset.relativePath !== "properties/property-specification-fanin.md"
    );

    expect(lensPrompts).toHaveLength(8);
    for (const asset of lensPrompts) {
      expect(asset.markdown, asset.relativePath).toContain("Target-derived invariant extraction");
      expect(asset.markdown, asset.relativePath).toContain("preserve every explicit mathematical invariant");
      expect(asset.markdown, asset.relativePath).toMatch(
        /retaining exact operands,\s+constants, named formulas, units, denominator expressions, and rounding\s+direction/u
      );
      expect(asset.markdown, asset.relativePath).toMatch(
        /Keep distinct formula, denominator, and rounding variants as separate\s+property rows/u
      );
      expect(asset.markdown, asset.relativePath).toMatch(
        /aggregate accounting\s+relationships between supplied assets, borrowed\s+assets, and shares/u
      );
      expect(asset.markdown, asset.relativePath).toContain(
        "explicitly documented or source-observed aggregate accounting"
      );
      expect(asset.markdown, asset.relativePath).toMatch(
        /record the target getter, function, or source location that supplies its\s+oracle/u
      );
    }

    const fanin = prompt("properties/property-specification-fanin.md");
    expect(fanin).toContain("{{artifact_handoff:project-discovery}}");
    expect(fanin).toContain("{{artifact_handoff:actors-flows}}");
    expect(fanin).toContain("{{artifact_handoff:base-test-setup}}");
    expect(fanin).toContain("Target-derived consolidation");
    expect(fanin).toMatch(/Retain every explicit mathematical\s+invariant/u);
    expect(fanin).toMatch(
      /Preserve exact operands, constants, units, denominator\s+expressions, and rounding direction/u
    );
    expect(fanin).toMatch(/Keep\s+distinct formula, denominator, and rounding variants/u);
    expect(fanin).toMatch(
      /explicitly documented or source-observed aggregate\s+accounting\s+relationships between supplied assets, borrowed\s+assets, and shares/u
    );
    expect(fanin).toMatch(/getter, function, test, or source\s+location that supplies each oracle/u);
    expect(fanin).toContain("Verbatim source-evidence ledger");
    expect(fanin).toContain("{{artifact_path:project-discovery}}/setup/invariant-evidence-ledger.json");
    expect(fanin).toContain("{{schema_path}}/invariant-evidence-ledger.schema.json");
    expect(fanin).toMatch(/Map every ledger entry to at least one canonical property\s+row/u);
  });

  it("requires a mechanical byte-preserving check for escaped ledger source text", () => {
    const discovery = prompt("setup/project-discovery.md");

    expect(discovery).toMatch(/obtain each cited source span mechanically/iu);
    expect(discovery).toMatch(/Do not retype or render Markdown or LaTeX/iu);
    expect(discovery).toMatch(/preserve every backslash/iu);
    expect(discovery).toContain("load the JSON ledger and compare each `verbatim` field");
    expect(discovery).toMatch(/JSON escaping is serialization only/iu);
  });

  it("requires final reports to preserve benchmark expectation coverage", () => {
    const finalReport = prompt("review/final-report.md");
    expect(finalReport).toContain("reference_expected_property_ids");
    expect(finalReport).toContain("reference_expectation_ids");
    expect(finalReport).toMatch(/Preserve these arrays even when the property priority is below/iu);
    // The report contract takes blocker_summaries as strings. The prompt used to
    // show only an empty array and say "using each typed blocker summary", so a
    // run emitted the typed objects and the contract discarded the whole report.
    expect(finalReport).toContain("Every element is a plain string, never an object");
    expect(finalReport).toContain("<property-id>: <the record's blocker summary text>");
    expect(finalReport).toMatch(/in\s+canonical catalog order/u);
    // The gate compares blocker_summaries byte-for-byte with
    // `${propertyId}: ${record.blocker.summary}`, so a paraphrase fails it just
    // as surely as an object does.
    expect(finalReport).toContain("Copy that summary text verbatim");
    // The Markdown half of the same coverage block is compared line by line and
    // was documented nowhere. Pin every label the gate matches on, not a sample.
    for (const label of [
      "Priority threshold",
      "Included priorities",
      "Selected properties",
      "Implemented properties",
      "Blocked properties",
      "Pending properties",
      "Deferred properties",
      "Reference expectation properties"
    ]) {
      expect(finalReport).toContain(`- ${label}: \``);
    }
    expect(finalReport).toMatch(/a line reading exactly\s+`Blocker summaries:`/u);
    expect(finalReport).toMatch(/no blank line between\s+the heading and the first bullet/u);
    expect(finalReport).toMatch(/Reference expectation properties`,\s+which counts `reference_expected_property_ids`/u);
    // The gate accepts the summary as written or Markdown-escaped. Describing
    // reportPublicProse in prose was tried and was wrong in three ways, so the
    // prompt must keep promising the laxer contract the gate actually applies.
    expect(finalReport).toMatch(/Markdown-escaping the special characters is accepted but not\s+required/u);
  });

  it("keeps protocol failures observable during invariant handler execution", () => {
    const handlers = prompt("strategies/invariants/handlers.md");
    const setup = prompt("strategies/invariants/setup.md");
    const coverage = prompt("strategies/invariants/coverage.md");
    const implementation = prompt("strategies/invariants/implement-properties.md");
    const campaign = prompt("strategies/invariants/invariant-testing-campaign.md");
    const corpus = `${handlers}\n${setup}\n${coverage}\n${implementation}\n${campaign}`;

    expect(handlers).toContain("Invoke each protocol entrypoint as a direct call");
    expect(handlers).toContain("Every reached target revert, panic, or out-of-gas failure propagates to Recon");
    expect(handlers).toContain("documented precondition cannot be met");
    expect(handlers).toContain("return before invoking the target");
    expect(handlers).toContain("narrowly documented non-protocol dependency");
    expect(handlers).toContain("property-scoped expected-revert case");
    expect(handlers).toContain("typed high-level function call");
    expect(handlers).toContain("blanket `try/catch`");
    expect(handlers).toContain("Scan `try/catch`, `.call`, and `.delegatecall`");
    expect(handlers).toMatch(/Synthetic coverage-only\s+handlers/u);
    expect(handlers).toContain("audit every handler source");
    expect(setup).toContain("Every protocol call made during setup remains directly observable");
    expect(setup).toMatch(/revert,\s+panic, or out-of-gas failure propagate/u);
    expect(coverage).toContain("Audit inherited handlers before coverage fuzzing");
    expect(coverage).toMatch(
      /Every reached protocol revert, panic, or out-of-gas failure remains part of\s+the coverage evidence/u
    );
    expect(implementation).toContain("Audit inherited handlers before implementing properties");
    expect(implementation).toContain("Every assertion observes state after a directly invoked protocol action");
    expect(implementation).toContain("reference_expectations");
    expect(implementation).toContain("even when its priority is below the configured threshold");
    expect(campaign).toContain("Audit inherited handlers before the final Recon smoke");
    expect(campaign).toMatch(
      /Record every reached protocol revert, panic, or out-of-gas failure as a\s+raw backend failure/u
    );
    expect(corpus).toContain("documented valid preconditions");
  });

  it("uses the repository's detected test root for invariant scaffolding", () => {
    const setup = prompt("strategies/invariants/setup.md");
    const implementation = prompt("strategies/invariants/implement-properties.md");
    const campaign = prompt("strategies/invariants/invariant-testing-campaign.md");

    expect(setup).toMatch(/Detect `?<test-root>`?.*test\/.*tests\//su);
    expect(setup).toMatch(/existing test-root convention.*test\/recon.*tests\/recon/su);
    expect(implementation).toContain("replace that prefix with the detected");
    expect(implementation).toMatch(/test\/foundry.*tests\/foundry/su);
    expect(campaign).toMatch(/test\/foundry.*tests\/foundry/su);
  });

  it("uses a configured smoke budget for every invariant Recon stage", () => {
    const promptPaths = [
      "strategies/invariants/setup.md",
      "strategies/invariants/handlers.md",
      "strategies/invariants/coverage.md",
      "strategies/invariants/implement-properties.md",
      "strategies/invariants/invariant-testing-campaign.md"
    ];
    for (const relativePath of promptPaths) {
      const markdown = prompt(relativePath);
      expect(markdown, relativePath).toContain("{{invariant_testing_smoke_timeout}}");
      expect(markdown, relativePath).not.toContain("timeout 120 recon fuzz");
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

  it("records exact target equations and their observable oracles during discovery", () => {
    const discovery = prompt("setup/project-discovery.md");

    expect(discovery).toContain("Invariant and equation inventory");
    expect(discovery).toContain("Extract every explicit equation, inequality, bound, and state relation");
    expect(discovery).toContain("exact operands, units, and rounding semantics");
    expect(discovery).toContain("Preserve distinct denominator and rounding variants");
    expect(discovery).toMatch(
      /For each entry, name the getter,\s+function,\s+test,\s+or source location that supplies each\s+oracle/u
    );
    expect(discovery).toMatch(/liveness requirements for public and external\s+operations/u);
    expect(discovery).toMatch(
      /aggregate accounting relationships between supplied assets, borrowed assets,\s+and shares when those relationships are explicitly documented or observed/u
    );
    expect(discovery).toContain("Verbatim source-evidence ledger");
    expect(discovery).toMatch(/every explicitly enumerated bullet or formula/u);
    expect(discovery).toMatch(/Copy each such statement\s+verbatim/u);
    expect(discovery).toMatch(
      /Do not summarize, merge, or omit a source\s+bullet before it has a corresponding ledger entry/u
    );
    expect(discovery).toMatch(/source path and line or symbol location/u);
    expect(discovery).toContain("including statements under generic headings");
    expect(discovery).toContain("Byte-preserving ledger construction");
    expect(discovery).toMatch(/derive the value by reading the cited file and slicing the requested\s+line range/u);
    expect(discovery).toMatch(/serializes the ledger with\s+`JSON\.stringify`/u);
    expect(discovery).toMatch(/repeated\s+backslashes and other literals/u);
    expect(discovery).toMatch(/Build the Markdown\s+handoff from those same parsed ledger objects/u);
  });

  it("keeps the final invariant campaign backend-neutral on the single recon-fuzzer backend", () => {
    const campaign = prompt("strategies/invariants/invariant-testing-campaign.md");
    const flatCampaign = campaign.replace(/\s+/gu, " ");
    const aggregate = prompt("review/aggregate-test-files.md");
    const dynamic = prompt("strategies/dynamic-strategy-generator.md");
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topologySource = readFileSync(topologyPath, "utf8");
    const topology = YAML.parse(topologySource) as {
      nodes: { id: string; depends_on?: string[]; outputs?: Array<{ path: string; contract: string }> }[];
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
    expect(campaignNode?.outputs?.find((output) => output.path === "campaign-summary.json")?.contract).toBe(
      "ultrafuzz/campaign-summary@2"
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
    // The campaign gate was once written from a sentence that read as one
    // finding per counterexample, and the node failed for every deduplicated
    // run until both sides were corrected. Neither side may drift back alone.
    expect(campaign).toContain("Do not emit one finding per\ncounterexample");
    expect(campaign).toContain("reuse the ID of one of the failures it covers");
    expect(campaign).toContain("a finding may\n     only name a property that some backend failure reported");
    expect(campaign).toContain("one distinct root cause, not one entry in the backend");
    expect(campaign).toMatch(/single counterexample broke several properties at once/u);
    expect(campaign).toContain("all contributing backend provenance");
    expect(flatCampaign).toContain("Use the top-level string `fuzzer_backend` when exactly one");
    expect(flatCampaign).toContain("unique, lexicographically sorted `fuzzer_backends` array when several");
    expect(flatCampaign).toContain("Never emit both fields");
    expect(flatCampaign).toContain("Nested detail such as `backend_provenance` may supplement these join fields");
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
    expect(flatCampaign).toContain("`failure_counts.pre_deduplication` and `failure_counts.post_deduplication`");
    expect(flatCampaign).toContain("total number of entries across every sibling backend record's `failures` array");
    expect(flatCampaign).toContain("total number of objects in `findings.json`, including non-property findings");
    expect(flatCampaign).toContain("do not prove that every finding is a distinct root cause");
    expect(campaign).toContain("`contributing_backend_failures` array");
    expect(flatCampaign).toContain("must partition every property-derived failure");
    expect(campaign).toContain("`deduplication.pre_dedup_count`");
    expect(flatCampaign).toContain("must be a subset of the finding's `property_ids`");
    expect(flatCampaign).toContain("must be the exact union across those contributed failures");
    expect(campaign).toContain('{"fuzzer_backend":"<backend>","failure_id":"<id>"}');
  });

  it("publishes runtime-owned workspace patches for every invariant handoff", () => {
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: {
        id: string;
        outputs?: Array<{ path: string; contract?: string }>;
      }[];
    };
    const invariantNodeIds = [
      "stateful-invariant-setup",
      "stateful-invariant-handlers",
      "stateful-invariant-coverage",
      "stateful-invariant-implement-properties",
      "stateful-invariant-campaign"
    ];

    for (const id of invariantNodeIds) {
      const outputs = topology.nodes.find((node) => node.id === id)?.outputs ?? [];
      expect(outputs, id).toEqual(
        expect.arrayContaining([
          { path: "workspace.patch", contract: "ultrafuzz/text@1" },
          { path: "workspace-patch.json", contract: "ultrafuzz/workspace-patch@1" }
        ])
      );
    }
  });

  it("keeps invariant setup and coverage JSON-first with Markdown parity", () => {
    const setup = prompt("strategies/invariants/setup.md");
    const coverage = prompt("strategies/invariants/coverage.md");
    for (const invariantPrompt of [setup, coverage]) {
      expect(invariantPrompt).toContain("{{artifact_path:property-specification-fanin}}/properties.json");
      expect(invariantPrompt).toContain("{{artifact_path:property-specification-fanin}}/properties.md");
      expect(invariantPrompt).toContain("machine-readable source of truth");
      expect(invariantPrompt).toContain("source-only properties");
    }
    expect(coverage).toContain("`not-run` has a null measurement and no\n     blockers");
    expect(coverage).toContain("`target-met` has a\n     measurement from 90 through 100 and no blockers");
    expect(coverage).toContain("`blocked` has at least one typed\n     blocker");
  });

  it("documents status-dependent differential and dynamic JSON evidence", () => {
    const lane = prompt("strategies/differential/differential-lane-author.md");
    const dynamic = prompt("strategies/dynamic-strategy-generator.md");

    expect(lane).toContain("`green` requires a non-null assigned\nlane");
    expect(lane).toContain("`semantic_red_frozen` requires the same assigned-lane and command\nevidence");
    expect(lane).toContain("`compile_or_harness_defect` requires an\nassigned lane");
    expect(lane).toContain("`no_assigned_lane` requires every lane/source/command field to be null");
    expect(lane).toContain("must exactly equal the assigned\nlane payload");
    expect(dynamic).toContain("Use `selected` only with at least one selected strategy");
    expect(dynamic).toContain("A strategy ID cannot be both selected and rejected");
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
    expect(dynamic).toContain("Use the exact `ultrafuzz.generated-tests.v2` manifest shape");
    expect(dynamic).toContain("`path` with the\n`generated-tests/<file>` prefix");
    expect(dynamic).toContain("they are not generated-test\nmanifest fields");
    expect(dynamic).not.toContain("strategy id, source path, destination intent, and\nvalidation status");
    expect(`${readFileSync(templatePath, "utf8")}\n${promptCorpus}`).not.toContain("test_files");
    expect(readFileSync(topologyPath, "utf8")).toMatch(
      /id: reference-harness-author[\s\S]*outputs:[\s\S]*path: generated-tests\.json/u
    );
    for (const sourceId of manifestSources) {
      expect(requiredArtifactsById.get(sourceId), sourceId).toContain("generated-tests.json");
    }
  });

  it("keeps actors-flows limited to its declared Markdown output", () => {
    const actors = prompt("setup/actors-flows.md");
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: { id: string; outputs?: Array<{ path: string }> }[];
    };

    expect(topology.nodes.find((node) => node.id === "actors-flows")?.outputs?.map((output) => output.path)).toEqual([
      "setup/actors-flows.md"
    ]);
    expect(actors).toContain("declares only the actor-flow Markdown output");
    expect(actors).toContain("do not create an\nundeclared `findings.json`");
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
    expect(aggregate).toContain("required `kind`\n  (`generated-test` or `support-file`)");
    expect(aggregate).toContain("Every considered source entry appears exactly once");
    expect(aggregate).toContain("plus skipped `generated-test`\nrows");
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
    expect(markdown).toContain("severity == matrix(impact, likelihood)");
    expect(markdown).toContain("Never emit `final_severity` or another alias");
    expect(markdown).toContain("Do not emit `Critical`");
  });

  it("keeps the final-report matrix guard in the report prompt", () => {
    const markdown = prompt("review/final-report.md");

    expect(markdown).toContain("Impact x Likelihood");
    expect(markdown).toContain("High impact + Low likelihood must render as Medium");
    expect(markdown).toContain("Medium impact + Low likelihood must render as Low");
    expect(markdown).toContain("Every production issue severity equals the Impact x Likelihood matrix result");
    expect(markdown).toContain("canonical finding v2");
    expect(markdown).toContain("`severity_guess`, `severity`, `impact`, and");
    expect(markdown).toContain("canonical `strategy` field a non-empty");
    expect(markdown).toContain("structured `strategy_provenance` object");
    expect(markdown).toContain("canonical non-empty `detection_rates` array");
    expect(markdown).toContain("Do not emit the removed\n`strategies` alias");
    expect(markdown).toContain("Never emit both fields");
    expect(markdown).toContain("When no known campaign backend produced the\nfinding, omit both");
    expect(markdown).toContain("never emit a one-entry `line_ranges`");
    expect(markdown).toContain("never combine `line_ranges` with");
    expect(markdown).toContain("`line` or `end_line`");
  });

  it("keeps the empty findings array contract in prompt-owned templates", () => {
    const templatePath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/findings.mdx", import.meta.url)
    );
    const template = readFileSync(templatePath, "utf8");
    expect(template).toContain("Use `[]` when there are no findings");
    expect(template).toContain('Every finding must set `schema_version` to exactly `"ultrafuzz.finding.v2"`');
    expect(template).toContain("Unknown fields are invalid");
    expect(template).toContain("`{}` is invalid");
    expect(template).toContain("Evidence entries are either non-empty strings or non-empty closed objects");
    expect(template).toContain("without anchors or line selectors");
    expect(template).toContain("disjoint spans with `line_ranges`");
    expect(template).toContain("Never emit a one-entry `line_ranges`");
    expect(template).toContain("never combine `line_ranges` with `line` or `end_line`");
    expect(template).toContain("Keep independent explanatory prose in `detail`");
    expect(template).not.toContain("`schema_version` is optional");
    expect(template).toContain("exactly `High`, `Medium`, or `Low`");
    expect(template).toContain("later severity review owns the final `severity`");
    expect(template).not.toContain("final_severity");
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
