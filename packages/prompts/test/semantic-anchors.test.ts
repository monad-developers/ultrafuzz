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
  it("keeps pinned schemas as the sole producer-side JSON shape authority", () => {
    const deliberateCorrectionFixture = "smoke/json-validation-correction.md";
    const forbiddenShapeAuthority = [
      /schema_version/u,
      /ultrafuzz\.[a-z0-9-]+\.v[0-9]+/u,
      /```json/u,
      /empty JSON array/iu,
      /(?:canonical\s+)?findings?\s+v[0-9]+/iu,
      /top-level (?:JSON )?(?:array|object)/iu,
      /object wrapper/iu,
      /(?:write|use|return|emit)[^.\n]{0,100}(?:`\[\]`|empty (?:JSON )?(?:array|list|manifest))/iu,
      /with (?:this|the) (?:exact )?(?:JSON )?shape/iu,
      /exact (?:top-level )?(?:JSON )?(?:keys|fields)/iu,
      /leave (?:the )?field absent/iu,
      /null runtime budgets/iu,
      /non-empty\s+`property_ids`\s+array/iu,
      /Omit the `ledger_ids` field/iu,
      /JSON string itself/iu,
      /non-null `(?:execution\.started_at|deterministic_reproducer_ref)`/iu,
      /top-level `dedupe_key`/iu,
      /omit both backend fields/iu
    ];

    for (const asset of loadBuiltInPromptAssets()) {
      let markdown = asset.markdown;
      if (asset.relativePath === deliberateCorrectionFixture) {
        expect(asset.markdown).toContain('{"schema_version":"1.0","findings":[]}');
        expect(asset.markdown).toContain("Deliberately write the schema-invalid JSON object");
        markdown = markdown.replace('{"schema_version":"1.0","findings":[]}', "");
      }
      for (const pattern of forbiddenShapeAuthority) {
        expect(markdown, `${asset.relativePath}: ${String(pattern)}`).not.toMatch(pattern);
      }
    }

    const templateRoot = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/", import.meta.url)
    );
    for (const filename of [
      "boundary-recipes.mdx",
      "coverage-evidence-markdown.mdx",
      "findings.mdx",
      "generated-tests.mdx",
      "output-contract.mdx"
    ] as const) {
      const template = readFileSync(`${templateRoot}/${filename}`, "utf8");
      for (const pattern of forbiddenShapeAuthority) {
        expect(template, `${filename}: ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

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
      expect(asset.markdown, asset.relativePath).toContain("do not invent expectation IDs");
      expect(asset.markdown, asset.relativePath).toContain("schema's no-expectation representation");
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
  it("preserves optional evidence semantics without owning the JSON representation", () => {
    // Matched on whitespace-normalised text. These anchors exist to stop prose from drifting back into
    // contradicting its gate, and pinning exact line breaks would make an innocent reflow look like a
    // semantic regression.
    const flat = (relativePath: string) => prompt(relativePath).replace(/\s+/gu, " ");

    // Preserve the required source join while delegating the no-ledger
    // representation to the pinned schema (#297, #299).
    const fanin = flat("properties/property-specification-fanin.md");
    expect(fanin).toContain("Every ledger ID must be attributed to at least one canonical property");
    expect(fanin).toContain("do not invent ledger IDs for a property that maps to no ledger entry");

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

    // The reversible companion grammar must preserve optional members exactly:
    // absent JSON members are omitted, while present arrays retain their exact values and order.
    expect(fanin).toContain("then optional `ledger_ids` and `reference_expectations`");
    expect(fanin).toContain("When an optional member is absent from JSON, omit its Markdown field entirely");
    expect(fanin).toContain("a blank field or `[]` is not omission");

    // `reference_expectations` is also optional. Keep the semantic source join here while leaving
    // optionality and empty forms to the pinned schema (#328).
    const implementation = flat("strategies/invariants/implement-properties.md");
    expect(implementation).toContain("{{schema_path}}/implemented-properties.schema.json");
    expect(implementation).toContain(
      "Carry the complete expectation-ID set for a selected property when the source property has one"
    );
    expect(implementation).toContain("do not invent an empty expectation set for a property that has none");
    expect(implementation).toContain(
      "Preserve generated and changed test paths separately from invariant/helper implementation paths"
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
    const flatFinalReport = finalReport.replace(/\s+/gu, " ");
    expect(finalReport).toContain("reference_expected_property_ids");
    expect(finalReport).toContain("reference_expectation_ids");
    expect(finalReport).toMatch(/Preserve these arrays even when the property priority is below/iu);
    // The runtime derives blocker summaries from the selected implementation
    // records. Preserve that semantic projection without redefining the JSON
    // member type owned by the pinned report schema.
    expect(finalReport).toContain("<property-id>: <the record's blocker summary text>");
    expect(flatFinalReport).toContain("in canonical catalog order");
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
    expect(flatFinalReport).toContain("no blank line between the heading and the first bullet");
    expect(finalReport).toMatch(
      /`Reference expectation properties` counts the properties carrying a reference\s+expectation/u
    );
    expect(finalReport).toContain("exact corresponding blocker-summary value");
    // The gate accepts the summary as written or Markdown-escaped. Describing
    // reportPublicProse in prose was tried and was wrong in three ways, so the
    // prompt must keep promising the laxer contract the gate actually applies.
    expect(finalReport).toMatch(/Markdown-escaping the special characters is\s+accepted but not\s+required/u);
  });

  it("requires renumbered property findings to retain authenticated campaign identity", () => {
    const finalReport = prompt("review/final-report.md").replace(/\s+/gu, " ");
    expect(finalReport).toContain(
      "set its `property_provenance.source_finding_id` to the exact authenticated upstream campaign finding ID"
    );
    expect(finalReport).toContain("keep `property_provenance.finding_id` equal to the report ID");
    expect(finalReport).toContain("Obtain that source ID from the matching lifecycle source record");
    expect(finalReport).toContain("omit `source_finding_id` after renumbering");
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
    expect(implementation).toMatch(
      /own canonical\s+observation identity and backend-admitted assertion\/invariant entrypoint/u
    );
    expect(implementation).toMatch(/never put several property IDs behind\s+one assertion entrypoint/u);
    expect(implementation).toContain("reference_expectations");
    expect(implementation).toContain("even when its priority is below the configured threshold");
    expect(campaign).toContain("Audit inherited handlers before the final Recon smoke");
    expect(campaign).toMatch(
      /Record every reached protocol revert, panic, or out-of-gas failure as a\s+raw backend failure/u
    );
    expect(campaign).toContain("Build an intended-property-entrypoint set");
    expect(campaign).toMatch(/record an independent terminal status for every implemented property/u);
    expect(campaign).toContain("A campaign is not `complete` when any intended property entrypoint is");
    expect(corpus).toContain("documented valid preconditions");
  });

  it("uses the repository's detected test root for invariant scaffolding", () => {
    const setup = prompt("strategies/invariants/setup.md");
    const implementation = prompt("strategies/invariants/implement-properties.md");
    const campaign = prompt("strategies/invariants/invariant-testing-campaign.md");

    expect(setup).toMatch(/Detect `?<test-root>`?.*test\/.*tests\//su);
    expect(setup).toMatch(/existing test-root convention.*test\/recon.*tests\/recon/su);
    expect(implementation).toMatch(/That root is the\s+repository's own top-level `test\/` or `tests\/` directory/u);
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

  it("uses preflighted Recon coverage tooling without installing it during a run", () => {
    const coverage = prompt("strategies/invariants/coverage.md");

    expect(coverage).toContain("`recon-generate coverage`");
    expect(coverage.split("\n").length).toBeLessThan(180);
    expect(coverage.match(/official documentation or direct CLI `--help`/gu)).toHaveLength(1);
    expect(coverage).not.toContain("The tool expects a Magic directory");
    expect(coverage).not.toContain("npx -y recon-generate");
    expect(coverage).not.toContain("recon-generate@latest");
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
    // The verifier reads exactly three source-location forms, so the prompt has to
    // name them: a producer that guessed `L55` failed a whole campaign.
    expect(discovery).toMatch(
      /`source_location` as `line <n>`, `lines <first>-<last>`, or the name of the\s+declared symbol/u
    );
    expect(discovery).toMatch(/an abbreviation such as `L55` is rejected/u);
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
    expect(campaignNode?.outputs?.find((output) => output.path === "recon-fuzzer-results.json")?.contract).toBe(
      "ultrafuzz/property-campaign@3"
    );
    expect(campaignNode?.outputs?.find((output) => output.path === "campaign-plan.json")?.contract).toBe(
      "ultrafuzz/invariant-campaign-plan@2"
    );
    expect(topology.nodes.find((node) => node.id === "dynamic-strategy-generator")?.depends_on).toContain(
      "stateful-invariant-campaign"
    );
    expect(topology.nodes.find((node) => node.id === "dedupe-findings")?.depends_on).toContain(
      "stateful-invariant-campaign"
    );
    expect(`${topologySource}\n${aggregate}\n${dynamic}`).not.toContain("stateful-invariant-recon-campaign");
    expect(aggregate).toContain("{{ancestor_generated_test_manifests}}");
    expect(dynamic).toContain("{{artifact_path:stateful-invariant-campaign}}/generated-tests.json");

    expect(campaign).toContain("final recon-fuzzer campaign");
    expect(campaign).toContain("one implemented Chimera property suite");
    expect(campaign).toContain("recon-fuzzer is the single final bug-finding backend");
    expect(campaign).toContain("Preserve the existing priority-threshold selection");
    expect(campaign).toContain("workers = max(1, available_vcpus)");
    expect(campaign).toContain("1 vCPU means 1 worker");
    expect(campaign).toMatch(/higher\s+counts use `available_vcpus` workers on the one backend/u);
    expect(campaign).toContain("finalization reserve");
    expect(flatCampaign).toContain(
      "reserve the complete `{{invariant_testing_fuzzer_timeout}}` seconds for the supervised Recon process"
    );
    expect(flatCampaign).toContain("The shutdown grace and artifact reserve are both additional to, not part of");
    expect(flatCampaign).toContain(
      "`timeout --preserve-status --signal=INT --kill-after=300s {{invariant_testing_fuzzer_timeout}}s recon fuzz . --contract CryticTester --test-mode assertion --workers <workers> --test-limit 18446744073709551615 --seq-len 100 --timeout {{invariant_testing_fuzzer_timeout}} --corpus-dir echidna --recon-corpus-dir recon-corpus`"
    );
    expect(flatCampaign).toContain("`--seq-len 100` prevents a generated `seqLen: 1`");
    expect(flatCampaign).toContain("prevents Recon's default 50,000-call cap");
    expect(flatCampaign).toContain("Do not use `--foreground`");
    expect(flatCampaign).toContain("`fuzzing_deadline_utc = backend_started_at + configured timeout`");
    expect(flatCampaign).toContain("`force_kill_deadline_utc = fuzzing deadline + host grace`");
    expect(flatCampaign).toContain("`final_artifact_deadline_utc = force-kill deadline + artifact reserve`");
    expect(campaign).not.toContain("configured budget minus the finalization reserve");
    expect(campaign).toMatch(/do not\s+divide it into per-backend slices/u);
    expect(campaign).toContain("backends/recon-fuzzer");
    expect(campaign).not.toContain("backends/echidna");
    expect(campaign).not.toContain("backends/medusa");
    expect(campaign).toContain("Finalize the backend record before deduplicating failures");
    // The campaign gate was once written from a sentence that read as one
    // finding per counterexample, and the node failed for every deduplicated
    // run until both sides were corrected. Neither side may drift back alone.
    expect(flatCampaign).toContain("Do not emit one finding per counterexample");
    expect(flatCampaign).toContain("must reuse the ID of one of the failures it covers");
    expect(flatCampaign).toContain("a finding may only name a property that some backend failure reported");
    expect(campaign).toContain("one distinct root cause, not one entry in the backend");
    expect(campaign).toMatch(/single counterexample broke several properties at once/u);
    expect(campaign).toContain("all contributing backend provenance");
    expect(flatCampaign).toContain("using the schema-defined representation for the number of contributing siblings");
    expect(flatCampaign).toContain("Copy every backend identity exactly from those siblings");
    expect(flatCampaign).toContain("keep multiple identities unique and sorted");
    expect(campaign).toContain("A later pass must never erase");
    expect(campaign).toContain("property_ids");
    expect(campaign).toContain("deterministic Foundry reproducer for every unique failure");
    expect(campaign).toContain("classify it as `blocked-unreproduced`");
    expect(flatCampaign).toContain(
      "Choose the pinned summary schema's outcome variant that matches the finalized backend execution and result usability"
    );
    expect(flatCampaign).toContain("Preserve every usable finding when execution ended early, crashed, or timed out");
    expect(flatCampaign).toContain("copy the actual reason from this run");
    expect(flatCampaign).toContain("`complete`: recon-fuzzer ran through the full configured fuzzing interval");
    expect(campaign).toContain("`partial`: recon-fuzzer produced usable results but ended early");
    expect(campaign).toContain("`blocked`: recon-fuzzer produced no usable results");
    expect(campaign).toContain("--workers <workers>");
    expect(campaign).toContain("{{schema_path}}/invariant-campaign-plan-v2.schema.json");
    expect(campaign).not.toContain("{{schema_path}}/invariant-campaign-plan.schema.json");
    expect(campaign).toContain("{{schema_path}}/campaign-summary.schema.json");
    expect(campaign).toContain("{{schema_path}}/property-campaign.schema.json");
    expect(flatCampaign).toContain(
      "The campaign-plan, implemented-properties, findings, and campaign-summary references must retain their exact declared artifact paths"
    );
    expect(flatCampaign).toContain(
      "Emit exactly one schema-defined property-result row for every implemented record in `implemented-properties.json`"
    );
    expect(flatCampaign).toContain(
      "Bind deterministic reproducer evidence or the actual reproduction blocker according to the pinned failure variant"
    );
    expect(flatCampaign).toContain(
      "run every exact `ultrafuzz json validate` command displayed in the output contract"
    );
    expect(flatCampaign).toContain("Do not repair, normalize, or convert an older campaign document");
    expect(campaign).toContain("{{artifact_dir}}/recon-fuzzer-results.json");
    expect(flatCampaign).toContain(
      "Populate the schema-admitted summary references and backend status from the exact sibling artifacts"
    );
    expect(flatCampaign).toContain("pre-deduplication count from every failure in every sibling backend result");
    expect(flatCampaign).toContain("post-deduplication count from every object in `findings.json`");
    expect(flatCampaign).toContain("do not prove that every finding is a distinct root cause");
    expect(campaign).toContain("schema-defined `contributing_backend_failures` collection");
    expect(flatCampaign).toContain("must partition every property-derived failure");
    expect(campaign).toContain("`deduplication.pre_dedup_count`");
    expect(flatCampaign).toContain("must be a subset of the finding's `property_ids`");
    expect(flatCampaign).toContain("must be the exact union across those contributed failures");
    expect(flatCampaign).toContain(
      "Every entry binds the exact backend identity, failure ID, and campaign-result artifact reference"
    );
    expect(flatCampaign).toContain("not to the backend-internal `paths.raw_results` evidence file");
    expect(flatCampaign).toContain("Plain failure ID strings and omitted `raw_result_ref` values are invalid");
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
    expect(coverage).toMatch(/Confirm their exact shapes and empty\s+forms with the rendered output contract/u);
    expect(coverage).toContain("never overstate the result");
    expect(coverage).not.toContain("it alone defines");
  });

  it("renders the canonical coverage projection into both portable prompts", () => {
    const placeholder = "{{coverage_evidence_markdown_projection}}";
    for (const relativePath of ["strategies/invariants/coverage.md", "review/final-report.md"] as const) {
      const markdown = prompt(relativePath);
      expect(markdown, relativePath).toContain(placeholder);
      expect(markdown.split(placeholder), relativePath).toHaveLength(2);
      expect(markdown, relativePath).not.toContain("docs/reference/artifacts-reports.md");
    }

    const partialPath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/coverage-evidence-markdown.mdx", import.meta.url)
    );
    const docsPath = fileURLToPath(new URL("../../../docs/reference/artifacts-reports.md", import.meta.url));
    const partial = readFileSync(partialPath, "utf8").trim();
    const docs = readFileSync(docsPath, "utf8");

    expect(partial.match(/Raw `covg-eval` output is for iteration only/gu)).toHaveLength(1);
    expect(partial).toMatch(/Apply public-prose\s+sanitization to `<summary>` and `<exclusion_reason>`/u);
    expect(docs).toContain(partial);
  });

  it("documents status-dependent differential and dynamic evidence beside pinned schemas", () => {
    const lane = prompt("strategies/differential/differential-lane-author.md");
    const differentialAuditor = prompt("strategies/differential/reference-and-lane-auditor.md");
    const differentialTriage = prompt("strategies/differential/differential-red-triage.md");
    const dynamic = prompt("strategies/dynamic-strategy-generator.md");
    const flatDynamic = dynamic.replace(/\s+/gu, " ");

    expect(lane).toContain("{{schema_path}}/differential-lane-result.schema.json");
    expect(lane).toContain("pinned schema's status-dependent variant");
    expect(lane).toContain("must exactly equal that assigned-lane\npayload");
    expect(differentialTriage).toContain("{{schema_path}}/differential-red-triage.schema.json");
    expect(differentialTriage).toContain("each must classify every exact\nregistry hash once in registry order");
    expect(differentialTriage).toContain("A semantic red may\nnot be relabeled `compile_harness_defect`");
    expect(differentialTriage).toContain("Set `repair_allowed: true` only for `harness_bug` or\n`reference_bug`");
    expect(differentialAuditor).toContain("reports `validation.passed: true`");
    expect(differentialAuditor).toContain("in `covered_surfaces`");
    expect(differentialAuditor).toContain("disposition vocabulary defined only by the pinned schema");
    expect(dynamic).toContain("{{schema_path}}/dynamic-strategy-plan.schema.json");
    expect(dynamic).toContain("schema-defined plan status and corresponding empty or populated\nvariant");
    expect(flatDynamic).toContain("pinned schema's unavailable-budget representation");
    expect(dynamic).toContain("selected count equal the selected-strategy array\nlength");
    expect(dynamic).toContain("A strategy ID cannot be both selected and rejected");
    expect(flatDynamic).toContain("Every enumerator recommendation must appear exactly once");
    expect(flatDynamic).toContain("identifies every recommending enumerator in enumerator-output order");
    expect(dynamic).toContain("`dynamic_strategy_id` must name a row in `selected-strategies.json`");
    expect(flatDynamic).toContain("Every generated-file strategy ID must name a selected strategy");
    expect(flatDynamic).toContain("one named, non-mutating contextual gate");
  });

  it("keeps generated-test context semantics beside the schema-owned bundle shape", () => {
    const aggregate = prompt("review/aggregate-test-files.md");
    const dedupe = prompt("review/dedupe-findings.md");
    const dynamic = prompt("strategies/dynamic-strategy-generator.md");
    const templatePath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/generated-tests.mdx", import.meta.url)
    );
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: { id: string; outputs?: Array<{ path: string; contract: string }> }[];
    };
    const requiredArtifactsById = new Map(
      topology.nodes.map((node) => [node.id, (node.outputs ?? []).map((output) => output.path)])
    );
    const promptCorpus = loadBuiltInPromptAssets()
      .map((asset) => asset.markdown)
      .join("\n");
    const aggregateManifestSources = new Set(generatedTestManifestSources(aggregate));
    const generatedTestProducers = new Set(
      topology.nodes
        .filter((node) => node.outputs?.some((output) => output.contract === "ultrafuzz/generated-tests@3"))
        .map((node) => node.id)
    );

    const generatedTestsTemplate = readFileSync(templatePath, "utf8");
    expect(generatedTestsTemplate).toContain("exact pinned schema named by `Validate against`");
    expect(generatedTestsTemplate).toContain("exact `Validation command`");
    expect(generatedTestsTemplate).toContain("must be strict UTF-8 text");
    expect(generatedTestsTemplate).toContain("logical producer");
    expect(generatedTestsTemplate).toContain("checked-in native framework");
    expect(generatedTestsTemplate).not.toContain("ultrafuzz.generated-tests.v3");
    expect(generatedTestsTemplate).not.toContain("schema_version");
    expect(generatedTestsTemplate).not.toContain("`generated_tests`");
    expect(generatedTestsTemplate).not.toContain("`support_files`");
    expect(generatedTestsTemplate).not.toContain("size_bytes");
    expect(aggregate).toContain("{{schema_path}}/generated-tests.schema.json");
    expect(aggregate).toContain("schema-defined runnable and support entries together as one\natomic source bundle");
    expect(aggregate).toContain("recorded byte size and digest to match the companion exactly");
    expect(dedupe).toContain("{{schema_path}}/generated-tests.schema.json");
    expect(dedupe).toContain("schema-defined runnable and support entries together as the complete bundle");
    expect(dedupe).toContain("recorded byte length and digest match");
    expect(dynamic).toContain("{{schema_path}}/generated-tests.schema.json");
    expect(dynamic).toMatch(/bind its one bundle framework to the repository's checked-in\s+native framework/u);
    expect(dynamic).toContain("Never mix frameworks in one bundle");
    expect(dynamic).toMatch(/Classify independently\s+runnable tests as runnable/u);
    expect(dynamic).toContain("exact byte-for-byte companion mirrored beneath this node's");
    expect(dynamic).toContain("recorded byte size and digest must\nmatch that companion");
    expect(dynamic).toContain("Keep strategy IDs, destination intent, and validation\nstatus");
    expect(dynamic).toContain("Do not publish support without a runnable test");
    expect(dynamic).toContain("schema-defined empty bundle when no runnable test was produced");
    expect(dynamic).not.toContain("only `language`, `framework`, `description`");
    expect(dynamic).not.toContain("strategy id, source path, destination intent, and\nvalidation status");
    expect(`${readFileSync(templatePath, "utf8")}\n${promptCorpus}`).not.toContain("test_files");
    expect(readFileSync(topologyPath, "utf8")).toMatch(
      /id: reference-harness-author[\s\S]*outputs:[\s\S]*path: generated-tests\.json/u
    );
    // The aggregate prompt no longer hardcodes one {{artifact_path:<producer>}} line
    // per generated-test producer: it resolves them through
    // {{ancestor_generated_test_manifests}}, which is what lets the packaged smoke
    // and invariant-only topologies work, since those producers do not exist there.
    // A static list would have to be edited for every topology.
    expect(aggregate).toContain("{{ancestor_generated_test_manifests}}");
    expect([...aggregateManifestSources]).toEqual([]);
    expect(generatedTestProducers.size).toBeGreaterThan(0);
    for (const sourceId of new Set([
      ...generatedTestManifestSources(aggregate),
      ...generatedTestManifestSources(dynamic)
    ])) {
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

    expect(dedupe).toContain("{{ancestor_artifacts}}");
    expect(dedupe).toContain("When this list includes project-discovery or base-test setup handoffs");
    expect(dedupe).toMatch(
      /When they are absent, do not treat the omission as an error and do not\s+run native tests/u
    );
    expect(dedupe).toContain("For Foundry");
    expect(dedupe).toContain("For Hardhat");
    expect(dedupe).toContain("For Vyper");
    expect(dedupe).toContain("For mixed repositories");
    expect(dedupe).toContain("{{schema_path}}/generated-tests.schema.json");
    expect(dedupe).toContain("schema-defined runnable and support entries together as the complete bundle");
    expect(dedupe).toContain("manifest's one root-level `framework`");
    expect(dedupe).toContain("bundle framework is absent, invalid, mixed, or incompatible");
    expect(dedupe).toContain("Do not infer,\nsynthesize, normalize, or convert a missing or mismatched framework");
    expect(dedupe).toContain("Strategy workspaces are isolated from this node");
    expect(dedupe).toMatch(/copy\s+every exact byte-for-byte canonical companion/u);
    expect(dedupe).toContain("Do not execute a non-runnable support entry");
    expect(dedupe).toMatch(/blocked without\s+partially copying the bundle/u);
    expect(dedupe).toMatch(/under the existing\s+native test root in `\{\{workspace_path\}\}`/u);
    expect(dedupe).toContain("recorded byte length and digest match");
    expect(dedupe).toMatch(/every symlink even\s+when its target remains inside the artifact directory/u);
    expect(dedupe).toMatch(/Never search a\s+strategy workspace/u);
    expect(dedupe).toContain("Every kept finding's `dedupe_key` must be\nexactly equal as JSON");
    expect(dedupe).toMatch(/corresponding `dedupe_key` on its lifecycle record/u);
    expect(dedupe).toMatch(/The key is not\s+ledger-only metadata/u);
    expect(dedupe).toContain("Keep the dedupe keys unique across the kept\nfinding population");
    expect(dedupe).toMatch(
      /key, finding identity, title, optional family identity, and complete\s+strategy-hit provenance must agree with the kept finding and lifecycle record/u
    );
    expect(dedupe).toMatch(/same order, `dedupe_key`, finding\s+ID, title, optional family ID, and exact hit array/u);
    expect(dedupe).toContain("Never install, fetch, restore, or update dependencies during dedupe");
    expect(dedupe).not.toContain("restore project-pinned dependencies first");
    expect(dedupe).not.toContain("Dependency hydration used only");
  });

  it("aggregates canonical generated-test companions into framework-native roots", () => {
    const aggregate = prompt("review/aggregate-test-files.md");

    expect(aggregate).toContain("canonical generated-test companions");
    expect(aggregate).toContain("{{schema_path}}/generated-tests.schema.json");
    expect(aggregate).toContain("schema-defined runnable and support entries together as one\natomic source bundle");
    expect(aggregate).toContain("exact byte-for-byte companion");
    expect(aggregate).toContain("strict UTF-8 text regular file");
    expect(aggregate).toContain("Treat each accepted\nmanifest as one atomic bundle");
    expect(aggregate).toMatch(/every symlink even when its target remains inside\s+the artifact directory/u);
    expect(aggregate).toContain("Foundry `.t.sol`");
    expect(aggregate).toMatch(/Hardhat `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, or `.mts`/u);
    expect(aggregate).toContain("existing native Python test `.py` files");
    expect(aggregate).toContain("Bind its one framework to the checked-in native framework");
    expect(aggregate).toMatch(/Never infer, synthesize, normalize, or\s+convert a missing or mismatched framework/u);
    expect(aggregate).toContain("Preserve the manifest's one `framework` only on its `source_bundles` record");
    expect(aggregate).toContain("copied and skipped entry rows must not repeat `framework`");
    expect(aggregate).toContain("repository's existing JavaScript or TypeScript test root");
    expect(aggregate).toContain("existing pytest, Ape, Brownie, or other native test root");
    expect(aggregate).toContain("never flatten files or overwrite one entry with another");
    expect(aggregate).toMatch(/Do\s+not copy unknown manifest entry fields/u);
    expect(aggregate).toContain("{{schema_path}}/aggregation-manifest.schema.json");
    expect(aggregate).toContain("Record one source-bundle row for every declared manifest");
    expect(aggregate).toContain("Bind each row to the source manifest's logical node");
    expect(aggregate).toContain(
      "attempt, run, framework, exact path, immutable digest, entry counts, and actual\ndisposition"
    );
    expect(aggregate).toContain("artifact-relative path, byte size, digest, and any\nsource metadata exactly");
    expect(aggregate).toContain("corresponding\n`generated-test` or `support-file` kind");
    expect(aggregate).toContain("Every considered source entry appears exactly once");
    expect(aggregate).toContain(
      "A bundle is atomic: `copied` means all of its generated tests and\nsupport files appear once"
    );
    expect(aggregate).toContain("`empty`\nmeans both source counts are zero");
    expect(aggregate).not.toContain("schema_version");
    expect(aggregate).not.toContain("ultrafuzz.aggregation-manifest.v1");
    expect(aggregate).not.toContain("```json");
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
    expect(report).toContain("{{schema_path}}/aggregation-manifest.schema.json");
    expect(report).toContain("Bind each row through its exact authenticated source-bundle and\nmanifest identity");
    expect(report).toContain("never infer a framework from an extension");
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
    expect(markdown).toContain("Severity must equal the matrix result for impact and likelihood");
    expect(markdown).toContain("Never emit a final-severity alias or re-rate confidence");
    expect(markdown).toContain(
      "Do not emit `final_severity`,\n`upstream_severity`, note-token aliases, or compatibility fields"
    );
    expect(markdown).toContain("Do not emit `Critical`");
    expect(markdown).toContain("exactly one object per\ntriaged finding, in the same order, with the same `id`");
    expect(markdown).toContain("Never drop, add, merge,\nsplit, or reorder a record");
    expect(markdown).toContain("You own exactly six fields");
    expect(markdown).toContain("Do not touch `status`, `notes`, or `confidence`");
    expect(markdown).toContain(
      "preserve the upstream preliminary\nseverity estimate and lowercase confidence unchanged"
    );
    expect(markdown).toContain("stay in `severity-classified-findings.json`");
    expect(markdown).toContain("Never append these tokens to `notes`");
    expect(markdown).not.toContain("Exclude invalid, out-of-scope, duplicate-only");
    expect(markdown).not.toContain("use a\ncanonical `status`");
  });

  it("keeps the final-report matrix guard in the report prompt", () => {
    const markdown = prompt("review/final-report.md");
    const flatMarkdown = markdown.replace(/\s+/gu, " ");

    expect(markdown).toContain("Impact x Likelihood");
    expect(markdown).toContain("High impact + Low likelihood must render as Medium");
    expect(markdown).toContain("Medium impact + Low likelihood must render as Low");
    expect(markdown).toContain("Every production issue severity equals the Impact x Likelihood matrix result");
    expect(markdown).toContain("{{schema_path}}/report.schema.json");
    expect(markdown).toContain("run the exact `ultrafuzz json validate` command");
    expect(markdown).toContain("`severity_guess`, `severity`, `impact`, and");
    expect(markdown).toMatch(/canonical originating strategy name\s+when one is available/u);
    expect(markdown).toContain("`strategy_provenance` when\nthe upstream finding has it");
    expect(flatMarkdown).toContain(
      "Derive structured detection rates from the exact strategy hits and configured loop counts"
    );
    expect(flatMarkdown).toContain("Do not emit removed or compatibility aliases");
    expect(flatMarkdown).toContain(
      "pinned report schema alone defines how zero, one, or several producing backends are represented"
    );
    expect(flatMarkdown).toContain("never invent a backend or use a historical compatibility value");
    expect(markdown).toContain("For every schema-admitted multi-span citation");
    expect(markdown).toContain("require them not to touch or overlap");
    expect(flatMarkdown).toContain("stable-sort issues High, then Medium, then Low");
    expect(flatMarkdown).toContain("preserving source order within each severity");
    expect(markdown).toContain("`H-01`, `M-01`, and `L-01`");
    expect(markdown).toContain("`H-09`, `H-10`");
    expect(flatMarkdown).toContain("identity through the exact `lifecycle.dedupe_key`, `source_artifacts`");
    expect(flatMarkdown).toContain(
      "host renderer validates this authored order, numbering, and title shape without sorting"
    );
    // Presentation identity is report-owned; substantive upstream fields stay
    // byte-identical and lifecycle metadata authenticates the source join.
    expect(markdown).toMatch(
      /In strict severity-handoff mode, copy every field the severity-classified\s+finding already carries/u
    );
    expect(markdown).toContain("byte-for-byte");
    expect(flatMarkdown).toContain("except the report-owned `id` and `title`");
    expect(flatMarkdown).toContain(
      "In bounded classification mode, apply the same byte-for-byte rule to every field already carried by the normalized deduped finding"
    );
    expect(flatMarkdown).toContain("In bounded classification mode, compute and author the matrix result");
    expect(flatMarkdown).toContain(
      "In strict severity-handoff mode, reject a mismatch instead of correcting the artifact"
    );
    expect(markdown).not.toContain("bounded-final-review");
    expect(markdown).toMatch(/`summary`, `family_variants`, and `recommended_next_action` stay byte-identical/u);
    // `ultrafuzz json validate` is schema-only, so ordering is undetectable
    // before the host gate rejects the artifact.
    expect(markdown).toContain("sort the\nspans by their starting line");
    expect(markdown).toMatch(/greater than the previous\s+entry's `end_line`/u);
    // Every severity finding carries its own key; the finding_id fallback the
    // prompt used to allow is unreachable and contradicts the gate.
    expect(markdown).toMatch(/source finding you render has a `dedupe_key` exactly equal to its\s+lifecycle record/iu);
    expect(markdown).toContain("never fall back to `finding_id`");
    expect(markdown).not.toContain("when the finding has no dedupe key");
  });

  it("keeps findings semantics beside the schema-owned JSON shape", () => {
    const templatePath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/findings.mdx", import.meta.url)
    );
    const template = readFileSync(templatePath, "utf8");
    expect(template).toContain("exact pinned schema named by `Validate against`");
    expect(template).toContain("exact `Validation command`");
    expect(template).toContain("schema alone owns the JSON version");
    expect(template).toContain("later severity review owns final severity");
    expect(template).toContain("Cite evidence at its real source location");
    expect(template).not.toContain("ultrafuzz.finding.v2");
    expect(template).not.toContain("schema_version");
    expect(template).not.toContain("triage_classification");
    expect(template).not.toContain("final_severity");
  });

  it("gives the final-report producer the canonical Markdown renderer", () => {
    const markdown = prompt("review/final-report.md");
    expect(markdown).toContain(
      "ultrafuzz report render --file '{{artifact_path}}/report.json' --output '{{artifact_path}}/report.md'"
    );
    expect(markdown).toMatch(/Do not (?:author or )?hand-edit\s+`report\.md` after/u);
    expect(markdown).toContain("the renderer succeeds");
  });

  it("keeps dedupe lifecycle records free of later-stage ownership", () => {
    const markdown = prompt("review/dedupe-findings.md");
    expect(markdown).toContain("Do not write triage, severity, disposition, comparison, or later\nstage fields");
    expect(markdown).toContain("remove `triage_classification` from\na dedupe lifecycle record");
  });

  it("reuses the shared review prompts in the smoke topology", () => {
    const topologyPath = fileURLToPath(new URL("../../config/topologies/smoke.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: Array<{ id: string; prompt?: string; depends_on?: string[] }>;
    };
    const prompts = new Map(topology.nodes.map((node) => [node.id, node.prompt]));
    const finalReport = topology.nodes.find((node) => node.id === "final-report");
    const assets = loadBuiltInPromptAssets().map((asset) => asset.relativePath);

    expect(prompts.get("dedupe-findings")).toBe("review/dedupe-findings.md");
    expect(prompts.get("final-report")).toBe("review/final-report.md");
    expect(finalReport?.depends_on).toContain("smoke-context");
    expect(assets).not.toContain("smoke/smoke-dedupe-findings.md");
    expect(assets).not.toContain("smoke/smoke-final-report.md");
  });

  it("delegates the boundary-recipes JSON shape to its pinned schema", () => {
    const boundary = prompt("strategies/boundary-tests.md");
    const templatePath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/boundary-recipes.mdx", import.meta.url)
    );
    const template = readFileSync(templatePath, "utf8");

    expect(boundary).toContain("{{schema_path}}/boundary-recipes.schema.json");
    expect(boundary).toMatch(/exact\s+`ultrafuzz json validate` command/u);
    expect(template).toContain("exact pinned schema named by `Validate against`");
    expect(template).toContain("exact `Validation command`");
    for (const duplicate of [
      "ultrafuzz.boundary-recipes.v1",
      "schema_version",
      "deferred_or_spec_gated",
      "coverage_priorities",
      "preferred_downstream_lane"
    ]) {
      expect(boundary).not.toContain(duplicate);
      expect(template).not.toContain(duplicate);
    }
  });

  it("delegates boundary-family JSON shapes to their pinned schemas", () => {
    const cases = [
      ["strategies/admin-config-boundaries.md", "admin-config-boundary-matrix.schema.json"],
      ["strategies/external-dependency-boundaries.md", "dependency-scope-matrix.schema.json"],
      ["strategies/externalized-state-accounting.md", "externalized-state-accounting.schema.json"]
    ] as const;

    for (const [relativePath, schemaFile] of cases) {
      const markdown = prompt(relativePath);
      expect(markdown, relativePath).toContain(`{{schema_path}}/${schemaFile}`);
      expect(markdown, relativePath).toMatch(/exact\s+`ultrafuzz json validate` command/u);
      expect(markdown, relativePath).toMatch(/contextual\s+requirements beyond JSON Schema/u);
      expect(markdown, relativePath).not.toContain("schema_version");
      expect(markdown, relativePath).not.toContain("exact keys");
    }
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
