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

const DEFAULT_TOPOLOGY_PATH = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
const INVARIANT_ONLY_TOPOLOGY_PATH = fileURLToPath(
  new URL("../../../packages/config/topologies/invariant-only.yml", import.meta.url)
);

function topologyNodes(topologyPath: string): Array<{
  id: string;
  prompt?: string;
  depends_on?: string[];
  outputs?: Array<{ path: string; contract?: string }>;
}> {
  return (
    YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: Array<{
        id: string;
        prompt?: string;
        depends_on?: string[];
        outputs?: Array<{ path: string; contract?: string }>;
      }>;
    }
  ).nodes;
}

// The NoFuzz control removes fuzz execution and generated-test authoring from the DEFAULT topology
// only; `invariant-only.yml` and `smoke.yml` still ship the campaign chain, and their prompts stay in
// the built-in catalog. So the negative anchors below must be scoped to the prompts the default graph
// can actually reach -- asserting over the whole catalog would fail on those retained prompts, and a
// blanket path-prefix exemption would silently gut the assertions instead.
function reachablePromptPaths(): Set<string> {
  return new Set(
    topologyNodes(DEFAULT_TOPOLOGY_PATH)
      .map((node) => node.prompt)
      .filter((value): value is string => typeof value === "string")
  );
}

function reachablePromptAssets(): Array<{ relativePath: string; markdown: string }> {
  const reachable = reachablePromptPaths();
  const assets = loadBuiltInPromptAssets().filter((asset) => reachable.has(asset.relativePath));
  if (assets.length !== reachable.size) {
    const missing = [...reachable].filter((path) => !assets.some((asset) => asset.relativePath === path));
    throw new Error(`default topology references prompts missing from the catalog: ${missing.join(", ")}`);
  }
  return assets;
}

function reachablePromptCorpus(): string {
  return reachablePromptAssets()
    .map((asset) => asset.markdown)
    .join("\n");
}

// Every `strategies/` prompt the default topology reaches that also declares a `findings.json` output.
// These are the prompts the control reframed from test authoring to source analysis, so they are the
// ones whose findings path and anti-false-positive counterweight the paired precision comparison
// depends on. Derived from the topology so a new strategy node cannot skip the guards below.
function reframedFindingsProducerPrompts(): string[] {
  return topologyNodes(DEFAULT_TOPOLOGY_PATH)
    .filter(
      (node) =>
        typeof node.prompt === "string" &&
        node.prompt.startsWith("strategies/") &&
        (node.outputs ?? []).some((output) => output.path === "findings.json")
    )
    .map((node) => node.prompt!);
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

  it("uses preflighted Recon coverage tooling without installing it during a run", () => {
    const coverage = prompt("strategies/invariants/coverage.md");

    expect(coverage).toContain("`recon-generate coverage`");
    expect(coverage).not.toContain("npx -y recon-generate");
    expect(coverage).not.toContain("recon-generate@latest");
  });

  it("does not require unused fuzzer CLIs during project discovery", () => {
    const markdown = prompt("setup/project-discovery.md");
    const promptCorpus = loadBuiltInPromptAssets()
      .map((asset) => asset.markdown)
      .join("\n");

    // The NoFuzz control makes discovery read-only, so it no longer probes local tooling with
    // `forge --version`; the surviving requirement is that tooling availability is RECORDED as
    // evidence rather than resolved by running a fuzzer CLI.
    expect(markdown).toContain("Record visible project-local tooling evidence");
    expect(markdown).not.toContain("forge --version");
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
    // The campaign chain lives in `invariant-only.yml` under the NoFuzz control; the default topology
    // no longer declares it. The backend-neutrality contract is unchanged and still needs coverage, so
    // this half reads the packaged topology that actually runs the campaign.
    const topologyPath = INVARIANT_ONLY_TOPOLOGY_PATH;
    const topologySource = readFileSync(topologyPath, "utf8");
    const nodes = topologyNodes(topologyPath);
    const campaignNode = nodes.find((node) => node.id === "stateful-invariant-campaign");

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
      "ultrafuzz/campaign-summary@1"
    );
    expect(campaignNode?.outputs?.find((output) => output.path === "campaign-plan.json")?.contract).toBe(
      "ultrafuzz/invariant-campaign-plan@1"
    );
    expect(nodes.find((node) => node.id === "dedupe-findings")?.depends_on).toContain("stateful-invariant-campaign");
    expect(`${topologySource}\n${aggregate}\n${dynamic}`).not.toContain("stateful-invariant-recon-campaign");
    expect(aggregate).toContain("{{ancestor_generated_test_manifests}}");
    // `dynamic-strategy-generator` is absent from `invariant-only.yml`, and the NoFuzz control removed
    // its generated-test manifest handoffs, so it no longer reads the campaign manifest.
    expect(dynamic).not.toContain("{{artifact_path:stateful-invariant-campaign}}/generated-tests.json");

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
    expect(flatCampaign).toContain("`complete`: recon-fuzzer ran through the full configured fuzzing interval");
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
    // Retargeted to `invariant-only.yml`: the NoFuzz control removed the stateful-invariant nodes from
    // the default topology, but the workspace-patch output contract they carry is unchanged and still
    // needs coverage in the topology that declares them.
    const nodes = topologyNodes(INVARIANT_ONLY_TOPOLOGY_PATH);
    const invariantNodeIds = [
      "stateful-invariant-setup",
      "stateful-invariant-handlers",
      "stateful-invariant-coverage",
      "stateful-invariant-implement-properties",
      "stateful-invariant-campaign"
    ];

    for (const id of invariantNodeIds) {
      const outputs = nodes.find((node) => node.id === id)?.outputs ?? [];
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
  });

  it("keeps generated-test manifests on the canonical generated_tests contract", () => {
    // The NoFuzz control removes every `generated-tests.json` output from the DEFAULT topology, but the
    // canonical `generated_tests` manifest contract still ships for `invariant-only.yml`, and the shared
    // `generated-tests.mdx` output-contract template still documents it. Both stay pinned here; only the
    // topology this half reads is retargeted.
    const aggregate = prompt("review/aggregate-test-files.md");
    const templatePath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/generated-tests.mdx", import.meta.url)
    );
    const template = readFileSync(templatePath, "utf8");
    const topologyPath = INVARIANT_ONLY_TOPOLOGY_PATH;
    const nodes = topologyNodes(topologyPath);
    const requiredArtifactsById = new Map(
      nodes.map((node) => [node.id, (node.outputs ?? []).map((output) => output.path)])
    );
    const promptCorpus = loadBuiltInPromptAssets()
      .map((asset) => asset.markdown)
      .join("\n");
    const manifestSources = new Set(generatedTestManifestSources(aggregate));

    expect(template).toContain("generated_tests");
    expect(aggregate).toContain("manifest `generated_tests` entries");
    // Whole-catalog assertion, exactly as at base: the legacy `test_files` key must appear nowhere in
    // the built-in catalog or the shared template, including the prompts the default topology cannot
    // reach. Narrowing this to reachable prompts is not forced by the control.
    expect(`${template}\n${promptCorpus}`).not.toContain("test_files");
    expect(readFileSync(topologyPath, "utf8")).toMatch(
      /id: stateful-invariant-campaign[\s\S]*outputs:[\s\S]*path: generated-tests\.json/u
    );
    for (const sourceId of manifestSources) {
      expect(requiredArtifactsById.get(sourceId), sourceId).toContain("generated-tests.json");
    }
  });

  it("removes generated-test authoring from every prompt the default topology can reach", () => {
    const corpus = reachablePromptCorpus();

    // The control's whole point is that no reachable node authors or runs tests. These negatives are
    // the guard: a prompt drifting back into test authoring would silently un-blind the paired eval.
    expect(corpus).not.toContain("generated-tests.json");
    expect(corpus).not.toContain("generated_tests");
    expect(corpus).not.toContain("strategy_attempt_test_dir");
    expect(corpus).not.toContain("test_files");
    expect(corpus).not.toContain("Solidity PoC code block");

    // And the default topology must declare no generated-test manifest output at all.
    for (const node of topologyNodes(DEFAULT_TOPOLOGY_PATH)) {
      const outputs = (node.outputs ?? []).map((output) => output.path);
      expect(outputs, node.id).not.toContain("generated-tests.json");
      for (const output of node.outputs ?? []) {
        expect(output.contract, node.id).not.toBe("ultrafuzz/generated-tests@1");
      }
    }
  });

  it("keeps a source-backed findings path reachable in the default topology", () => {
    // The control must not be degenerate: removing fuzz execution and test authoring may not remove
    // the ability to report a source-backed finding through a declared findings contract.
    const producers = topologyNodes(DEFAULT_TOPOLOGY_PATH).filter((node) =>
      (node.outputs ?? []).some((output) => output.contract === "ultrafuzz/findings@1")
    );
    expect(producers.length).toBeGreaterThan(0);
    expect(producers.map((node) => node.id)).toContain("dynamic-strategy-generator");
  });

  it("tells every reframed findings producer where to write findings and when to write none", () => {
    // Reframing these nodes from test authoring to source analysis must not leave `findings.json` as a
    // declared output with no instruction to write it (a node would then pass its gate by writing
    // nothing), and must not drop the anti-false-positive counterweight the fuzzing arm keeps. Both
    // halves are graded-outcome-relevant, so they are pinned per prompt rather than over a joined corpus.
    for (const relativePath of reframedFindingsProducerPrompts()) {
      const markdown = prompt(relativePath);
      expect(markdown, relativePath).toMatch(/\{\{output_findings_path\}\}|`findings\.json`/u);
      expect(markdown, relativePath).toContain("A property that holds is not a finding");
      expect(markdown, relativePath).toContain("Write `[]` to `findings.json` when no source-backed violation");
      // Issue #531 PRESERVE: source snapshot. Removing fuzz execution does not license source edits.
      expect(markdown, relativePath).toContain("Do not edit production contracts or repository source files");
    }
  });

  it("keeps the source-snapshot and dependency-mutation prohibitions on every reachable writing node", () => {
    // `setup-foundry` and `base-test-setup` publish a workspace patch that every downstream analysis
    // workspace receives, and the review chain runs with tool access. A single production-source edit or
    // dependency install in any of them would put the control on a different source snapshot than the
    // treatment arm, which no runtime allowlist prevents.
    for (const relativePath of [
      "setup/project-discovery.md",
      "setup/prepare-foundry-harness.md",
      "setup/discover-base-test.md",
      "review/dedupe-findings.md",
      "review/triage.md",
      "review/severity-classification.md",
      "strategies/differential/differential-oracle-planner.md",
      "strategies/differential/reference-and-lane-auditor.md"
    ]) {
      const markdown = prompt(relativePath);
      expect(markdown, relativePath).toContain("Do not edit production contracts or repository source files");
    }

    for (const relativePath of [
      "setup/project-discovery.md",
      "setup/prepare-foundry-harness.md",
      "setup/discover-base-test.md",
      "review/dedupe-findings.md",
      "review/triage.md",
      "review/severity-classification.md",
      "strategies/admin-config-boundaries.md"
    ]) {
      const markdown = prompt(relativePath);
      expect(markdown, relativePath).toMatch(
        /install, fetch, restore,\s+or update dependencies|Do not install or fetch/u
      );
    }
  });

  it("keeps the execution-agnostic oracle-validity and harm guardrails in the reframed prompts", () => {
    // None of these are fuzzing capabilities. Source-only analysis makes the differential soundness
    // rules more load-bearing, not less, and the workflow prompt is the one whose output format became
    // pure prose scenarios -- exactly what the harm guardrail constrains.
    expect(prompt("strategies/differential/differential-lane-author.md")).toContain(
      "Do not compare private storage layout, packed fields, gas-shaped internals, assembly behavior, or production implementation-private state."
    );
    expect(prompt("strategies/differential/reference-and-lane-auditor.md")).toContain(
      "Do not assume the reference, production, or tests are correct."
    );
    expect(prompt("strategies/differential/differential-oracle-planner.md")).toContain(
      "Do not inspect private or hidden sources."
    );
    expect(prompt("strategies/differential/reference-harness-author.md")).toContain(
      "Do not copy production internals into the reference."
    );
    expect(prompt("strategies/workflow-property-based-tests.md")).toContain(
      "Do not write misuse-oriented narratives,\npublic abuse instructions, or harmful walkthroughs."
    );
  });

  it("keeps the base reachability token vocabulary so report.json cannot fingerprint the arm", () => {
    const triage = prompt("review/triage.md");
    const severity = prompt("review/severity-classification.md");
    const differentialLibrary = prompt("strategies/differential-library-tests.md");

    // `severity-classification.md` requires "one of these exact reachability tokens" on every surviving
    // helper-level finding, and those notes propagate into `report.json`. No runtime code or schema
    // constrains the vocabulary, so a renamed token would identify the arm from the graded artifact
    // alone. Keep the base spellings, and keep triage and severity on the same keys.
    for (const token of [
      "`reachability=public-entrypoint-trace`",
      "`reachability=generated-public-wrapper-poc`",
      "`reachability=helper-only`",
      "`reachability=public-wrapper-required`"
    ]) {
      expect(severity, token).toContain(token);
    }
    expect(triage).toContain("reachability=public-entrypoint-trace");
    expect(triage).toContain("reachability=public-wrapper-required");
    expect(differentialLibrary).toContain("reachability=public-wrapper-required");

    for (const markdown of [triage, severity, differentialLibrary]) {
      expect(markdown).not.toContain("public-entrypoint-evidence-required");
    }

    // Severity reads `helper_proof=`, so triage must write that key and not a renamed one.
    expect(severity).toContain("`helper_proof=<summary>`");
    expect(triage).toContain("helper_proof=");
    expect(triage).not.toContain("helper_evidence=");
  });

  it("renders property implementation coverage as unavailable instead of an unsatisfiable read", () => {
    const report = prompt("review/final-report.md");

    // `propertiesSchema` is a strict object over `schema_version` and `properties`, so the canonical
    // catalog cannot carry a `selection` key, and the CLI forces `unavailable` when no
    // `implemented-properties.json` handoff is declared -- which is always true in this topology.
    // Instructing a read of `properties.json.selection` would invite a fabricated coverage object that
    // disagrees with the CLI-derived value.
    expect(report).toContain("The default topology declares no");
    expect(report).toContain("cannot supply a\n`selection` object");
    expect(report).toContain("Do not\nsynthesize a coverage object");
    expect(report).toContain("`report.json.property_implementation_coverage` is the string `unavailable`");
    expect(report).not.toContain("Read the canonical property catalog's");
  });

  it("keeps admin/config boundary analysis source-backed and classification-complete", () => {
    const admin = prompt("strategies/admin-config-boundaries.md");

    // The NoFuzz control converts this node from test authoring to source-evidence bug search. The
    // optional-handoff tolerance and the `base-test-setup` rendering label are unchanged contracts and
    // must not regress to the older "Base Foundry setup:" label.
    expect(admin).toContain("Base test setup (when rendered):");
    expect(admin).not.toContain("Base Foundry setup:");
    expect(admin).toContain("A bounded benchmark topology may intentionally omit");
    expect(admin).toContain("property-guided bug-search specialist");
    expect(admin).toContain("Your job is to find bugs associated with documented admin/configuration");
    expect(admin).toContain("Read these handoff artifacts before analysis:");

    // The classification vocabulary feeds the triage enum, so it must survive the reframing intact.
    for (const classification of [
      "`production-bug`",
      "`implementation-drift`",
      "`incomplete-spec`",
      "`harness-defect`",
      "`inconclusive`"
    ]) {
      expect(admin, classification).toContain(classification);
    }
    expect(admin).toContain("record the source evidence");
    expect(admin).toContain("`analysis_notes`");
    expect(admin).toContain("`review_notes`");

    // No test authoring or execution may remain.
    expect(admin).not.toContain("strategy_attempt_test_dir");
    expect(admin).not.toContain("generated-tests.json");
    expect(admin).not.toContain("For Foundry targets, write `.t.sol`");
  });

  it("dedupes from written findings and source evidence without running native reproducers", () => {
    const dedupe = prompt("review/dedupe-findings.md");

    // The NoFuzz control deletes the native-runner validation section: there are no generated tests to
    // hydrate or execute. Dedupe now works from written artifacts and source evidence only.
    expect(dedupe).toContain("Dedupe from written findings, property artifacts, source evidence");
    expect(dedupe).toContain("{{ancestor_artifacts}}");

    // The dedupe semantics that are NOT about execution must survive intact.
    expect(dedupe).toContain("build a stable dedupe key");
    expect(dedupe).toContain("`family_id`");
    expect(dedupe).toContain("`related_findings`");
    expect(dedupe).toContain("Preserve `property_ids` on every property-derived finding");
    expect(dedupe).toContain("Stateful-analysis records are first-class findings");
    expect(dedupe).toContain("Do not hide adverse evidence");
    expect(dedupe).toContain("Count each strategy loop attempt only once");

    // Removing fuzz execution does not license mutating the pinned target workspace. Issue #531 requires
    // both arms to run against the same source snapshot, so the dependency-mutation and source-edit
    // prohibitions stay exactly as at base -- they are not fuzzing capabilities.
    expect(dedupe).toContain("Never install, fetch, restore, or update dependencies during dedupe");
    expect(dedupe).toContain("Do not rewrite lockfiles or dependency-vendor directories");
    expect(dedupe).toContain("Do not edit production contracts or repository source files");

    // No runner dispatch, workspace hydration, or companion copying may remain.
    expect(dedupe).not.toContain("Strategy workspaces are isolated from this node");
    expect(dedupe).not.toContain("copy only its exact byte-for-byte canonical");
    expect(dedupe).not.toContain("generated-tests.json");
    expect(dedupe).not.toContain("forge --version");
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

  it("requires a source-backed proof-of-concept scenario instead of an embedded reproducer", () => {
    const report = prompt("review/final-report.md");

    // The control has no generated tests to minimize, so the PoC contract becomes an ordered
    // source-backed scenario. `appendProofOfConcept` already treats `proof.code` as optional and
    // requires only the human-readable scenario, so this stays inside the report contract.
    expect(report).toContain("source-backed evidence belong in the normal issue");
    expect(report).toContain("express the Proof of Concept as an ordered");
    expect(report).toContain("name the contract,\nfunction, and source location for each step");
    expect(report).toContain("Use the finding's recorded source evidence");
    expect(report).toContain("report must be self-sufficient");
    expect(report).toContain("Stop\nand report an invalid upstream artifact");

    // The runtime rejects a report.md missing either heading, and the preamble sentence is hardcoded,
    // so all three must survive the reframing byte-for-byte.
    expect(report).toContain("## Property implementation coverage");
    expect(report).toContain("## Property provenance");
    expect(report).toContain("Ultrafuzz is an automated smart-contract fuzzing campaign assistant.");
    // The provenance table header is rendered from a hardcoded 6-column list in the runtime.
    expect(report).toContain("`Implementation/test paths`, and `Fuzzer backends`");

    // No embedded-reproducer contract may remain.
    expect(report).not.toContain("exactly one fenced code\nblock");
    expect(report).not.toContain("minimized self-contained target-native reproducer");
    expect(report).not.toContain("exact canonical `generated-tests/<relative-file>` companion");
    expect(report).not.toContain("generated Solidity PoCs");
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
    expect(markdown).toContain("non-empty `detection_rates` or `strategies` array");
    expect(markdown).toContain("Use exactly one of\nthese array keys; never emit both");
    expect(markdown).toContain("omit both `fuzzer_backend` and `fuzzer_backends`");
    expect(markdown).toContain("never emit a one-entry\n`line_ranges`");
    expect(markdown).toContain("never combine `line_ranges` with `line` or `end_line`");
  });

  it("keeps the empty findings array contract in prompt-owned templates", () => {
    const templatePath = fileURLToPath(
      new URL("../../../.ultrafuzz/prompts/_templates/output-contract/findings.mdx", import.meta.url)
    );
    const template = readFileSync(templatePath, "utf8");
    expect(template).toContain("Use `[]` when there are no findings");
    expect(template).toContain("without anchors or line selectors");
    expect(template).toContain("disjoint spans in `line_ranges`");
    expect(template).toContain("Never emit a one-entry `line_ranges`");
    expect(template).toContain("never combine `line_ranges` with `line` or `end_line`");
    expect(template).toContain("Keep independent explanatory prose in `detail`");
    // The contract accepts findings without a schema_version, so the template must not demand one.
    expect(template).not.toContain('Use `schema_version: "1.0"`');
    expect(template).toContain("`schema_version` is optional");
    expect(template).toContain("exactly `High`, `Medium`, or `Low`");
    expect(template).toContain("including findings that are or may become non-production records");
  });

  it("keeps Vyper target setup guidance concrete for Foundry harnesses", () => {
    const projectDiscovery = prompt("setup/project-discovery.md");
    const setupFoundry = prompt("setup/prepare-foundry-harness.md");
    const baseSetup = prompt("setup/discover-base-test.md");

    // The NoFuzz control makes all three setup nodes read-only, so the Vyper guidance becomes
    // "record the evidence needed to reason about deployment" rather than "build a working harness".
    // Vyper must still be DETECTED and its blockers still recorded, which is what these anchors pin.
    expect(projectDiscovery).toContain("whether production contracts are Solidity, Vyper, or mixed Solidity/Vyper");
    expect(projectDiscovery).toContain("`.vy` production contracts");
    expect(projectDiscovery).toContain("`vyper` or `vyper-json` commands");
    expect(projectDiscovery).toContain("record the Solidity interface and project-local");
    expect(projectDiscovery).toContain("compiler evidence needed to understand deployment and ABI interactions");

    expect(setupFoundry).toContain("record the Solidity interfaces, ABI-derived interfaces");
    expect(setupFoundry).toContain("record concrete bytecode and deployment expectations");
    expect(setupFoundry).toContain("constructor/init argument handling");
    expect(setupFoundry).toContain("FFI configuration notes");
    expect(setupFoundry).toMatch(/project-local\s+Vyper dependency is unavailable/u);
    expect(setupFoundry).toContain("Record whether the Foundry harness appears complete");

    expect(baseSetup).toContain("record visible Solidity interfaces, ABI-derived interfaces");
    expect(baseSetup).toContain("record any project-local compiler or bytecode");
    expect(baseSetup).toContain("constructor/init argument handling, FFI configuration");
    expect(baseSetup).toContain("project-local Vyper dependencies as explicit validation blockers");
    expect(baseSetup).toContain("Record whether compilation status is known from existing evidence");

    // No harness construction or test execution may remain in the setup chain.
    for (const [name, markdown] of [
      ["project-discovery", projectDiscovery],
      ["prepare-foundry-harness", setupFoundry],
      ["discover-base-test", baseSetup]
    ] as const) {
      expect(markdown, name).not.toContain("Make sure Foundry compilation is passing");
      expect(markdown, name).not.toContain("forge test --ffi");
      expect(markdown, name).not.toContain("strategy_attempt_test_dir");
    }
  });
});
