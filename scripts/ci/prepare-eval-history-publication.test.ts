import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION,
  automaticProducerPolicyDimensions,
  assertAutomaticBundleDigest,
  assertAutomaticPublicationFinalLaunch,
  assertAutomaticPublicationModelEvidence,
  assertPublicBenchmarkBundleMatrixScope,
  parseAutomaticPublicationProfileOptions,
  publicationTreeDigest,
  readValidatedAutomaticPublicationBundle,
  readAutomaticPublicationManifest,
  readAutomaticPublicationLaunchState,
  summarizePublicBenchmarkBundlePublication,
  trustedCandidateRuntimePolicyDimensions,
  verifyAutomaticPublicationUnpacked,
  validateAutomaticPublicationManifest,
  validateAutomaticPairConfig,
  validateBenchmarkPolicyFiles,
  validateProducerPolicyDimensions
} from "./prepare-eval-history-publication.mjs";

const roots: string[] = [];
const context = {
  candidateCommit: "a".repeat(40),
  repository: "https://github.com/monad-developers/ultrafuzz",
  producerRunId: "12345",
  producerRunAttempt: "2",
  mode: "smoke"
} as const;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("trusted automatic eval-history publication handoff", () => {
  it("binds the exact bundle bytes and deterministic extracted publication tree", () => {
    const root = temporaryRoot("ultrafuzz-publication-digest-");
    const bundlePath = path.join(root, "public-results.json");
    const extractedRoot = path.join(root, "unpacked");
    const pairRoot = path.join(extractedRoot, "pair-a");
    const summaryContents = Buffer.from(`${JSON.stringify({ eval_run_id: "run-a", score: 1 })}\n`, "utf8");
    const emptyContents = Buffer.alloc(0);
    const bundle = {
      schema_version: "test.public-bundle.v1",
      files: [
        {
          path: "eval/summary.json",
          size_bytes: summaryContents.byteLength,
          sha256: sha256(summaryContents),
          contents_base64: summaryContents.toString("base64")
        },
        {
          path: "eval/empty.jsonl",
          size_bytes: emptyContents.byteLength,
          sha256: sha256(emptyContents),
          contents_base64: emptyContents.toString("base64")
        }
      ]
    };
    const bundleBytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    fs.writeFileSync(bundlePath, bundleBytes);
    const bundleModule = {
      MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES: 1024 * 1024,
      PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION: "test.public-bundle.v1",
      parsePublicBenchmarkBundle(value: unknown) {
        return value as typeof bundle;
      }
    };

    const prepared = readValidatedAutomaticPublicationBundle(bundlePath, bundleModule);
    expect(prepared.bundle_sha256).toBe(sha256(bundleBytes));
    writeFile(path.join(pairRoot, "eval", "summary.json"), summaryContents.toString("utf8"));
    writeFile(path.join(pairRoot, "eval", "empty.jsonl"), "");
    expect(publicationTreeDigest(pairRoot)).toBe(prepared.publication_tree_sha256);
    const planPath = path.join(root, "plan.json");
    fs.writeFileSync(
      planPath,
      `${JSON.stringify({
        schema_version: AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION,
        pairs: [{ unpack_path: "pair-a", publication_tree_sha256: prepared.publication_tree_sha256 }]
      })}\n`
    );
    expect(verifyAutomaticPublicationUnpacked(planPath, extractedRoot)).toEqual({ pairs: 1 });

    const substitutedBundle = Buffer.from(`${JSON.stringify({ ...bundle, substituted: true }, null, 2)}\n`, "utf8");
    fs.writeFileSync(bundlePath, substitutedBundle);
    expect(() => assertAutomaticBundleDigest(bundlePath, prepared.bundle_sha256)).toThrow(
      /bundle digest changed after trusted preparation/u
    );
    writeFile(path.join(pairRoot, "eval", "summary.json"), `${JSON.stringify({ eval_run_id: "run-a", score: 2 })}\n`);
    expect(() => verifyAutomaticPublicationUnpacked(planPath, extractedRoot)).toThrow(/tree digest does not match/u);
  });

  it("accepts complete exact DeepSeek V4 Flash identity and pricing evidence", () => {
    const { bundle, model, pair } = deepSeekAutomaticPublicationBundle();
    expect(assertAutomaticPublicationModelEvidence(bundle, model, pair)).toBeUndefined();
  });

  it("accepts provider-reported model-ID scope for non-alias model identifiers", () => {
    const { bundle, model, pair } = deepSeekAutomaticPublicationBundle("gpt-5.6-luna");
    expect(assertAutomaticPublicationModelEvidence(bundle, model, pair)).toBeUndefined();
  });

  it("rejects self-consistent current v7/v4 profiles with substituted DeepSeek Flash rates", () => {
    const substitutions = [
      ["uncached_input", 0.15],
      ["cache_read", 0.003],
      ["cache_write", 0],
      ["output", 0.3],
      ["reasoning", 0.3]
    ] as const;

    for (const [component, replacement] of substitutions) {
      const fixture = deepSeekAutomaticPublicationBundle();
      const pricing = fixture.diagnostics.rows[0]!.pricing;
      const rates = pricing.rates_usd_per_million as Record<string, number | null>;
      const usage = pricing.usage as Record<string, number>;
      const componentCosts = pricing.component_costs_usd as Record<string, number>;
      rates[component] = replacement;
      componentCosts.uncached_input = (usage.uncached_input_tokens! * rates.uncached_input!) / 1_000_000;
      componentCosts.cache_read = (usage.cache_read_tokens! * rates.cache_read!) / 1_000_000;
      componentCosts.cache_write =
        rates.cache_write === null ? 0 : (usage.cache_write_tokens! * rates.cache_write) / 1_000_000;
      componentCosts.output = (usage.output_tokens! * rates.output!) / 1_000_000;
      componentCosts.reasoning = (usage.reasoning_tokens! * rates.reasoning!) / 1_000_000;
      pricing.cost_usd = Object.values(componentCosts).reduce((total, value) => total + value, 0);
      fixture.summary.rows[0]!.efficiency.cost_usd = pricing.cost_usd;
      fixture.syncBundleFiles();
      expect(
        () => assertAutomaticPublicationModelEvidence(fixture.bundle, fixture.model, fixture.pair),
        component
      ).toThrow(/invalid DeepSeek Flash accounting/u);
    }
  });

  it("rejects missing, partial, mixed, or substituted DeepSeek V4 Flash evidence", () => {
    const cases: Array<[string, (fixture: ReturnType<typeof deepSeekAutomaticPublicationBundle>) => void]> = [
      [
        "missing top-level provider identity",
        ({ bundle }) => Reflect.deleteProperty(bundle, "provider_reported_model")
      ],
      [
        "missing invocation identity",
        ({ diagnostics }) =>
          Reflect.deleteProperty(diagnostics.rows[0]!.model_identity.invocations[0]!, "provider_reported_model")
      ],
      [
        "missing identity scope",
        ({ diagnostics }) => Reflect.deleteProperty(diagnostics.rows[0]!.model_identity, "identity_scope")
      ],
      [
        "substituted identity scope",
        ({ diagnostics }) => (diagnostics.rows[0]!.model_identity.identity_scope = "provider-reported-model-id")
      ],
      [
        "missing provider version status",
        ({ diagnostics }) => Reflect.deleteProperty(diagnostics.rows[0]!.model_identity, "provider_version_status")
      ],
      [
        "unsupported provider version claim",
        ({ diagnostics }) => (diagnostics.rows[0]!.model_identity.provider_version_status = "verified")
      ],
      ["partial pricing", ({ diagnostics }) => (diagnostics.rows[0]!.pricing.pricing_complete = false)],
      [
        "mixed invocation identity",
        ({ diagnostics }) =>
          (diagnostics.rows[0]!.model_identity.invocations[0]!.provider_reported_model = "deepseek-v4-pro")
      ],
      ["dated provider identity", ({ bundle }) => (bundle.provider_reported_model = "deepseek-v4-flash-202607")],
      [
        "substituted catalog source",
        ({ diagnostics }) => (diagnostics.rows[0]!.pricing.catalog.source = "provider-default")
      ],
      [
        "substituted output rate",
        ({ diagnostics }) => (diagnostics.rows[0]!.pricing.rates_usd_per_million.output = 0.3)
      ],
      [
        "reasoning double charge",
        ({ diagnostics }) => {
          const pricing = diagnostics.rows[0]!.pricing;
          pricing.usage.reasoning_tokens = 25;
          pricing.usage.inclusive_token_total += 25;
          pricing.usage.billable_token_total += 25;
          pricing.usage.total_tokens += 25;
          pricing.component_costs_usd.reasoning = 0.000007;
          pricing.cost_usd += 0.000007;
        }
      ]
    ];

    for (const [label, mutate] of cases) {
      const fixture = deepSeekAutomaticPublicationBundle();
      mutate(fixture);
      fixture.syncBundleFiles();
      expect(
        () => assertAutomaticPublicationModelEvidence(fixture.bundle, fixture.model, fixture.pair),
        label
      ).toThrow();
    }
  });

  it("binds a v7 bundle to the exact final successful launch receipt", () => {
    const receipt = automaticPublicationReceipt();
    expect(assertAutomaticPublicationFinalLaunch(receipt)).toEqual(receipt.state.launches[0]);
  });

  it("accepts a final success after an explicitly safe pre-model retry", () => {
    const receipt = automaticPublicationReceipt();
    const priorLaunch = structuredClone(receipt.state.launches[0]!);
    priorLaunch.attempt_id = "safe-pre-model-retry";
    const finalLaunch = receipt.state.launches[0]!;
    finalLaunch.attempt = 2;
    finalLaunch.attempt_id = "final-after-safe-retry";
    receipt.state.attempt_history = [priorLaunch];

    const priorLifecycle = structuredClone(receipt.state.recovery_lifecycle[0]!);
    priorLifecycle.attempt_id = priorLaunch.attempt_id;
    priorLifecycle.terminal_reason = "operational-failure";
    priorLifecycle.terminal_class = "operational-failure";
    priorLifecycle.model_work_started = false;
    const finalLifecycle = receipt.state.recovery_lifecycle[0]!;
    finalLifecycle.attempt = 2;
    finalLifecycle.attempt_id = finalLaunch.attempt_id;
    receipt.state.recovery_lifecycle = [priorLifecycle, finalLifecycle];
    receipt.bundle.lineage.attempt = 2;
    receipt.bundle.lineage.attempt_id = finalLaunch.attempt_id;

    expect(assertAutomaticPublicationFinalLaunch(receipt)).toEqual(finalLaunch);
  });

  it("rejects nonfinal attempts that may have started model work or have ambiguous terminal state", () => {
    for (const mutate of [
      (lifecycle: ReturnType<typeof automaticPublicationReceipt>["state"]["recovery_lifecycle"][number]) => {
        lifecycle.terminal_reason = "operational-failure";
        lifecycle.terminal_class = "operational-failure";
        lifecycle.model_work_started = true;
      },
      (lifecycle: ReturnType<typeof automaticPublicationReceipt>["state"]["recovery_lifecycle"][number]) => {
        lifecycle.terminal_reason = "unknown";
        lifecycle.terminal_class = "unknown";
        lifecycle.model_work_started = "unknown";
      },
      (lifecycle: ReturnType<typeof automaticPublicationReceipt>["state"]["recovery_lifecycle"][number]) => {
        lifecycle.terminal_reason = "active";
        lifecycle.terminal_class = "active";
        lifecycle.model_work_started = false;
        delete lifecycle.finished_at;
      }
    ]) {
      const receipt = automaticPublicationReceipt();
      const priorLaunch = structuredClone(receipt.state.launches[0]!);
      priorLaunch.attempt_id = "unsafe-prior-attempt";
      const finalLaunch = receipt.state.launches[0]!;
      finalLaunch.attempt = 2;
      finalLaunch.attempt_id = "final-after-unsafe-attempt";
      receipt.state.attempt_history = [priorLaunch];

      const priorLifecycle = structuredClone(receipt.state.recovery_lifecycle[0]!);
      priorLifecycle.attempt_id = priorLaunch.attempt_id;
      mutate(priorLifecycle);
      const finalLifecycle = receipt.state.recovery_lifecycle[0]!;
      finalLifecycle.attempt = 2;
      finalLifecycle.attempt_id = finalLaunch.attempt_id;
      receipt.state.recovery_lifecycle = [priorLifecycle, finalLifecycle];
      receipt.bundle.lineage.attempt = 2;
      receipt.bundle.lineage.attempt_id = finalLaunch.attempt_id;

      expect(() => assertAutomaticPublicationFinalLaunch(receipt)).toThrow(/unsafe nonfinal launch lifecycle/u);
    }
  });

  it("rejects legacy v3, v4, v5, and v6 bundles in automatic publication", () => {
    for (const schemaVersion of [
      "ultrafuzz.modal.public-benchmark-bundle.v3",
      "ultrafuzz.modal.public-benchmark-bundle.v4",
      "ultrafuzz.modal.public-benchmark-bundle.v5",
      "ultrafuzz.modal.public-benchmark-bundle.v6"
    ]) {
      const receipt = automaticPublicationReceipt();
      receipt.bundle.schema_version = schemaVersion;
      expect(() => assertAutomaticPublicationFinalLaunch(receipt)).toThrow(/must use .*\.v7/u);
    }
  });

  it("rejects missing, invalid, and symlinked final launch state files", () => {
    const root = temporaryRoot("ultrafuzz-publication-state-");
    const pair = smokeManifest().pairs[0]!;
    const statePath = path.join(root, pair.state_path);
    const parser = {
      parseModalLaunchState(value: unknown) {
        if (
          typeof value !== "object" ||
          value === null ||
          !("schema_version" in value) ||
          value.schema_version !== "ultrafuzz.modal.launch-state.v3"
        ) {
          throw new Error("not a current launch state");
        }
        return value;
      }
    };

    expect(() => readAutomaticPublicationLaunchState(root, pair, parser)).toThrow();
    fs.writeFileSync(statePath, `${JSON.stringify({ schema_version: "ultrafuzz.modal.launch-state.v2" })}\n`);
    expect(() => readAutomaticPublicationLaunchState(root, pair, parser)).toThrow(/launch state .* is invalid/u);
    const finalState = automaticPublicationReceipt().state;
    fs.writeFileSync(statePath, `${JSON.stringify(finalState)}\n`);
    expect(readAutomaticPublicationLaunchState(root, pair, parser)).toEqual(finalState);
    fs.unlinkSync(statePath);
    const outside = path.join(root, "outside.state.json");
    fs.writeFileSync(outside, `${JSON.stringify(automaticPublicationReceipt().state)}\n`);
    fs.symlinkSync(outside, statePath);
    expect(() => readAutomaticPublicationLaunchState(root, pair, parser)).toThrow(/symbolic link/u);
  });

  it("rejects stale same-run bundles and nonterminal launch state", () => {
    const stale = automaticPublicationReceipt();
    const priorLaunch = structuredClone(stale.state.launches[0]!);
    priorLaunch.attempt_id = "prior-attempt";
    const currentLaunch = stale.state.launches[0]!;
    currentLaunch.attempt = 2;
    currentLaunch.attempt_id = "current-attempt";
    stale.state.attempt_history = [priorLaunch];
    const priorLifecycle = structuredClone(stale.state.recovery_lifecycle[0]!);
    priorLifecycle.attempt_id = priorLaunch.attempt_id;
    priorLifecycle.terminal_reason = "operational-failure";
    priorLifecycle.terminal_class = "operational-failure";
    const currentLifecycle = stale.state.recovery_lifecycle[0]!;
    currentLifecycle.attempt = 2;
    currentLifecycle.attempt_id = currentLaunch.attempt_id;
    stale.state.recovery_lifecycle = [priorLifecycle, currentLifecycle];
    stale.bundle.lineage.attempt = 1;
    stale.bundle.lineage.attempt_id = priorLaunch.attempt_id;
    expect(() => assertAutomaticPublicationFinalLaunch(stale)).toThrow(/launch attempt.*lineage/u);

    const active = automaticPublicationReceipt();
    const lifecycle = active.state.recovery_lifecycle[0]!;
    lifecycle.terminal_reason = "active";
    lifecycle.terminal_class = "active";
    lifecycle.model_work_started = "unknown";
    delete lifecycle.finished_at;
    expect(() => assertAutomaticPublicationFinalLaunch(active)).toThrow(/successful launch/u);
  });

  it("rejects replayed successes and state identity or fingerprint substitutions", () => {
    const replayed = automaticPublicationReceipt();
    const priorLaunch = structuredClone(replayed.state.launches[0]!);
    priorLaunch.attempt_id = "prior-success";
    const currentLaunch = replayed.state.launches[0]!;
    currentLaunch.attempt = 2;
    currentLaunch.attempt_id = "replayed-success";
    replayed.state.attempt_history = [priorLaunch];
    const priorLifecycle = structuredClone(replayed.state.recovery_lifecycle[0]!);
    priorLifecycle.attempt_id = priorLaunch.attempt_id;
    const currentLifecycle = replayed.state.recovery_lifecycle[0]!;
    currentLifecycle.attempt = 2;
    currentLifecycle.attempt_id = currentLaunch.attempt_id;
    replayed.state.recovery_lifecycle = [priorLifecycle, currentLifecycle];
    replayed.bundle.lineage.attempt = 2;
    replayed.bundle.lineage.attempt_id = currentLaunch.attempt_id;
    expect(() => assertAutomaticPublicationFinalLaunch(replayed)).toThrow(/successful launch history/u);

    for (const mutate of [
      (receipt: ReturnType<typeof automaticPublicationReceipt>) => (receipt.state.logical_run_id = "ci-other-run"),
      (receipt: ReturnType<typeof automaticPublicationReceipt>) => (receipt.state.source_revision = "b".repeat(40)),
      (receipt: ReturnType<typeof automaticPublicationReceipt>) => (receipt.state.fingerprints.config = "9".repeat(64)),
      (receipt: ReturnType<typeof automaticPublicationReceipt>) =>
        (receipt.bundle.lineage.image_fingerprint = "8".repeat(64)),
      (receipt: ReturnType<typeof automaticPublicationReceipt>) =>
        (receipt.bundle.lineage.model_fingerprint = "7".repeat(64))
    ]) {
      const receipt = automaticPublicationReceipt();
      mutate(receipt);
      expect(() => assertAutomaticPublicationFinalLaunch(receipt)).toThrow(/mismatched/u);
    }
  });

  it("accepts only the exact event-bound smoke manifest", () => {
    expect(validateAutomaticPublicationManifest(smokeManifest(), smokeContext())).toEqual(smokeManifest());
  });

  it("requires an explicit trusted provider and exact profile for a DeepSeek smoke manifest", () => {
    const manifest = deepSeekSmokeManifest();

    expect(() => validateAutomaticPublicationManifest(manifest, smokeContext())).toThrow();
    const exactContext = {
      ...smokeContext(),
      expectedProviders: ["deepseek"],
      expectedModel: "deepseek-v4-flash",
      expectedReasoning: "max"
    };
    expect(validateAutomaticPublicationManifest(manifest, exactContext)).toEqual(manifest);

    const substituted = deepSeekSmokeManifest("deepseek-v4-pro", "high");
    expect(() => validateAutomaticPublicationManifest(substituted, exactContext)).toThrow(
      /exact expected model profile/u
    );
  });

  it("parses exact automatic publication profile flags and rejects ambiguous combinations", () => {
    expect(
      parseAutomaticPublicationProfileOptions([
        "--expected-reasoning",
        "max",
        "--expected-provider",
        "deepseek",
        "--expected-model",
        "deepseek-v4-flash"
      ])
    ).toEqual({
      expectedProviders: ["deepseek"],
      expectedModel: "deepseek-v4-flash",
      expectedReasoning: "max"
    });
    for (const options of [
      ["--expected-provider", "deepseek", "--expected-model", "deepseek-v4-flash"],
      ["--expected-provider", "deepseek", "--expected-reasoning", "max"],
      ["--expected-model", "deepseek-v4-flash", "--expected-reasoning", "max"],
      ["--expected-provider", "deepseek", "--expected-provider", "openai"],
      ["--unknown", "value"]
    ]) {
      expect(() => parseAutomaticPublicationProfileOptions(options)).toThrow();
    }
  });

  it("rejects coherent producer model or reasoning substitutions outside the trusted DeepSeek Flash scope", () => {
    const exactContext = {
      ...context,
      generation: "12345-2",
      benchmark: "ultrafuzz-bench",
      targets: smokeTargets(),
      expectedModel: "deepseek-v4-flash",
      expectedReasoning: "max"
    };
    expect(
      validateAutomaticPairConfig(...deepSeekPairConfigArguments("deepseek-v4-flash", "max"), exactContext, new Set())
    ).toBeUndefined();
    for (const [model, reasoning] of [
      ["deepseek-v4-pro", "max"],
      ["deepseek-v4-flash", "high"]
    ]) {
      expect(() =>
        validateAutomaticPairConfig(...deepSeekPairConfigArguments(model!, reasoning!), exactContext, new Set())
      ).toThrow(/expected model|expected reasoning/u);
    }
  });

  it("accepts a safe overridden smoke runner before unpacking producer bundles", () => {
    const modelSlug = "benchmark-smoke-gpt-5-6-luna-202607-high";
    const pair = {
      ...smokeManifest().pairs[0]!,
      pair: `ultrafuzz-bench-${modelSlug}`,
      model_slug: modelSlug,
      config_path: `ultrafuzz-bench-${modelSlug}.json`
    };
    const model = {
      slug: modelSlug,
      model: "gpt-5.6-luna-202607",
      provider: "openai",
      agent: "CodexAgent",
      reasoning: "high",
      auth_mode: "api-key"
    };
    const config = {
      schema_version: "ultrafuzz.modal.benchmark.v1",
      run_id: "ci-12345-2-smoke-ultrafuzz-bench-openai",
      app_name: "ultrafuzz-evals",
      image_name: `ufz-runner-${"a".repeat(40)}`,
      node_timeout_seconds: 1800,
      loops: 1,
      braintrust: {
        project: "ultrafuzz-public-benchmarks",
        api_key_env: "BRAINTRUST_API_KEY",
        judge_api_key_env: "OPENAI_API_KEY",
        judge_url: "https://api.openai.com/v1/chat/completions"
      },
      public_benchmark: {
        benchmark: "ultrafuzz-bench",
        lane: "smoke",
        runner_model_profile: modelSlug,
        candidate_repository: context.repository,
        candidate_commit: context.candidateCommit,
        targets: smokeTargets(),
        max_runtime_seconds: 15_000
      }
    };
    expect(
      validateAutomaticPairConfig(
        config,
        model,
        pair,
        {
          ...context,
          generation: "12345-2",
          benchmark: "ultrafuzz-bench",
          targets: smokeTargets()
        },
        new Set()
      )
    ).toBeUndefined();
  });

  it("rejects untrusted identity, topology, provider, and path mutations", () => {
    const cases: Array<[string, (manifest: ReturnType<typeof smokeManifest>) => void]> = [
      ["unexpected root field", (manifest) => Object.assign(manifest, { command: "echo unsafe" })],
      ["candidate", (manifest) => (manifest.candidate_commit = "b".repeat(40))],
      ["repository", (manifest) => (manifest.repository = "https://github.com/example/other")],
      ["generation", (manifest) => (manifest.generation = "12345-1")],
      ["mode", (manifest) => (manifest.mode = "full")],
      ["benchmark", (manifest) => (manifest.benchmark = "evmbench")],
      ["execution mode", (manifest) => (manifest.execution.mode = "local")],
      ["dry run", (manifest) => (manifest.execution.dry_run = true)],
      ["image", (manifest) => (manifest.image_name = "ufz-runner-other")],
      ["target count", (manifest) => manifest.targets.pop()],
      ["target duplicate", (manifest) => (manifest.targets[1] = manifest.targets[0]!)],
      ["target repository", (manifest) => (manifest.targets[0]!.repository = "https://example.com/other")],
      ["matrix row count", (manifest) => (manifest.matrix_rows_per_pair = 4)],
      ["pair provider", (manifest) => (manifest.pairs[0]!.provider = "anthropic")],
      ["pair field", (manifest) => Object.assign(manifest.pairs[0]!, { extra: true })],
      ["pair traversal", (manifest) => (manifest.pairs[0]!.pair = "../escape")],
      ["config traversal", (manifest) => (manifest.pairs[0]!.config_path = "../config.json")],
      ["state absolute path", (manifest) => (manifest.pairs[0]!.state_path = "/tmp/state.json")],
      ["state backslash", (manifest) => (manifest.pairs[0]!.state_path = "pair\\state.json")],
      ["state control character", (manifest) => (manifest.pairs[0]!.state_path = "pair\n.state.json")],
      ["model slug lane", (manifest) => (manifest.pairs[0]!.model_slug = "benchmark-full-model-high")]
    ];
    for (const [label, mutate] of cases) {
      const manifest = smokeManifest();
      mutate(manifest);
      expect(() => validateAutomaticPublicationManifest(manifest, smokeContext()), label).toThrow();
    }
  });

  it("requires the exact full provider set, ordering, and unique control paths", () => {
    const fullContext = fullPublicationContext();
    expect(
      validateAutomaticPublicationManifest(fullManifest(), fullContext).pairs.map((pair) => pair.provider)
    ).toEqual(["openai", "anthropic", "kimi", "deepseek"]);
    expect(() =>
      validateAutomaticPublicationManifest(fullManifest(), {
        ...fullContext,
        expectedProviders: ["deepseek"]
      })
    ).toThrow(/full benchmark must expect exactly openai, anthropic, kimi, and deepseek in order/u);

    for (const mutate of [
      (manifest: ReturnType<typeof fullManifest>) => manifest.pairs.pop(),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.provider = "openai"),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.pair = manifest.pairs[0]!.pair),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.model_slug = manifest.pairs[0]!.model_slug),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.config_path = manifest.pairs[0]!.config_path),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.state_path = manifest.pairs[0]!.state_path),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[2]!.provider = "anthropic"),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[3]!.provider = "kimi")
    ]) {
      const manifest = fullManifest();
      mutate(manifest);
      expect(() => validateAutomaticPublicationManifest(manifest, fullContext)).toThrow();
    }
  });

  it("accepts policy-derived trial and cohort matrix dimensions", () => {
    const manifest = smokeManifest();
    manifest.matrix_rows_per_pair = 6;
    manifest.control_timeout_seconds = 37_500;
    expect(
      validateAutomaticPublicationManifest(manifest, {
        ...smokeContext(),
        targetCount: 3,
        trialsPerVariant: 2
      })
    ).toEqual(manifest);

    const changedCohort = fullManifest();
    changedCohort.targets.push({
      id: "target-41",
      repository: "https://github.com/example/target-41",
      revision: "b".repeat(40),
      framework: "foundry"
    });
    changedCohort.matrix_rows_per_pair = 41;
    changedCohort.control_timeout_seconds = 21_000;
    expect(
      validateAutomaticPublicationManifest(changedCohort, {
        ...context,
        mode: "full",
        targets: changedCohort.targets,
        targetCount: 41,
        trialsPerVariant: 1
      })
    ).toEqual(changedCohort);
  });

  it("accepts an older-policy producer with newer publication tooling", () => {
    const root = temporaryRoot("ultrafuzz-publication-older-policy-");
    const manifest = smokeManifest();
    manifest.control_timeout_seconds = 12_000;
    const pair = manifest.pairs[0]!;
    fs.writeFileSync(
      path.join(root, pair.config_path),
      `${JSON.stringify({ public_benchmark: { max_runtime_seconds: 7_200 } })}\n`
    );

    const producerPolicy = automaticProducerPolicyDimensions(manifest, root);
    expect(producerPolicy).toEqual({
      matrixRowsPerPair: 3,
      controlTimeoutSeconds: 12_000,
      maxParallelEvalRows: 3,
      maxParallelWorkflowNodes: 4,
      maxRuntimeSeconds: 7_200
    });
    expect(validateProducerPolicyDimensions(producerPolicy, { ...producerPolicy })).toEqual(producerPolicy);
    expect(() =>
      validateProducerPolicyDimensions(producerPolicy, {
        ...producerPolicy,
        maxRuntimeSeconds: 15_000,
        controlTimeoutSeconds: 19_800
      })
    ).toThrow(/trusted candidate policy/u);
    expect(
      validateAutomaticPublicationManifest(manifest, {
        ...smokeContext(),
        ...producerPolicy
      })
    ).toEqual(manifest);
  });

  it("reads runtime and concurrency policy from the trusted candidate checkout", () => {
    expect(trustedCandidateRuntimePolicyDimensions(process.cwd(), "smoke")).toEqual({
      maxParallelEvalRows: 3,
      maxParallelWorkflowNodes: 4,
      maxRuntimeSeconds: 15_000,
      evalCleanupSeconds: 300,
      scorePerWaveTimeoutSeconds: 2_700,
      reportTimeoutSeconds: 300,
      preparationTimeoutSeconds: 1_200,
      controlPollingGraceSeconds: 300
    });
  });

  it("ignores declaration-shaped comments, strings, templates, and nested constants", () => {
    const root = temporaryRoot("ultrafuzz-publication-policy-decoys-");
    const benchmarkPath = path.join(root, "packages/evals/src/benchmark-manifest.ts");
    const workerPath = path.join(root, "packages/modal/src/public-worker.ts");
    const preparationPath = path.join(root, "scripts/ci/prepare-modal-benchmarks.mjs");
    for (const filePath of [benchmarkPath, workerPath, preparationPath]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(
      benchmarkPath,
      [
        'const decoy = "export const BENCHMARK_SMOKE_MAX_PARALLEL_RUNS = 99;";',
        "// export const BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS = 98;",
        "function nested() { const BENCHMARK_SMOKE_MAX_PARALLEL_RUNS = 97; return 97; }",
        "export const BENCHMARK_SMOKE_MAX_PARALLEL_RUNS = 3;",
        "export const BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS = 4;"
      ].join("\n")
    );
    fs.writeFileSync(
      workerPath,
      [
        "const decoy = `export const PUBLIC_BENCHMARK_SMOKE_MAX_RUNTIME_SECONDS = 99;`;",
        "/* export const PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS = 98; */",
        "export const PUBLIC_BENCHMARK_SMOKE_MAX_RUNTIME_SECONDS = 2 * 60 * 60;",
        "export const PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS = 5 * 60;",
        "export const PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS = 45 * 60;",
        "export const PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS = 5 * 60;",
        "export const PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS = 20 * 60;"
      ].join("\n")
    );
    fs.writeFileSync(
      preparationPath,
      [
        'const decoy = "const PUBLIC_CONTROL_POLLING_GRACE_SECONDS = 99;";',
        "const PUBLIC_CONTROL_POLLING_GRACE_SECONDS = 5 * 60;"
      ].join("\n")
    );

    expect(trustedCandidateRuntimePolicyDimensions(root, "smoke")).toEqual({
      maxParallelEvalRows: 3,
      maxParallelWorkflowNodes: 4,
      maxRuntimeSeconds: 7_200,
      evalCleanupSeconds: 300,
      scorePerWaveTimeoutSeconds: 2_700,
      reportTimeoutSeconds: 300,
      preparationTimeoutSeconds: 1_200,
      controlPollingGraceSeconds: 300
    });
  });

  it("rejects public bundles that omit a trusted target even when the row count still matches", () => {
    const targetIds = ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"];
    const modelSlug = smokeManifest().pairs[0]!.model_slug;
    const pair = smokeManifest().pairs[0]!.pair;
    const expected = {
      matrixRowsPerPair: 3,
      targetIds,
      trialsPerVariant: 1,
      modelSlug
    };

    expect(() =>
      assertPublicBenchmarkBundleMatrixScope(bundleWithMatrix(matrixRows(targetIds, modelSlug)), expected, pair)
    ).not.toThrow();
    expect(() =>
      assertPublicBenchmarkBundleMatrixScope(
        bundleWithMatrix(matrixRows([targetIds[0]!, targetIds[1]!, targetIds[1]!], modelSlug)),
        expected,
        pair
      )
    ).toThrow(/missing target result\(s\).*stableswap-ng-vyper/u);
    expect(() =>
      assertPublicBenchmarkBundleMatrixScope(
        bundleWithMatrix(matrixRows([targetIds[0]!, targetIds[1]!], modelSlug)),
        expected,
        pair
      )
    ).toThrow(/row count 2 does not match expected 3/u);
  });

  it("summarizes only complete scored public bundles for automatic history ingestion", () => {
    const targetIds = ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"];
    const modelSlug = smokeManifest().pairs[0]!.model_slug;
    const pair = smokeManifest().pairs[0]!.pair;
    const expected = {
      matrixRowsPerPair: 3,
      targetIds,
      targets: smokeTargets(),
      trialsPerVariant: 1,
      modelSlug,
      evalRunId: "ci-12345-2-smoke-ultrafuzz-bench-openai-benchmark-smoke-gpt-5-6-luna-high"
    };
    const publicationUrl = "https://github.com/monad-developers/ultrafuzz/actions/runs/12345/artifacts";

    expect(
      summarizePublicBenchmarkBundlePublication(
        completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId),
        expected,
        pair,
        publicationUrl
      )
    ).toEqual({
      status: "succeeded",
      target_ids: targetIds,
      executed_case_count: 3,
      graded_case_count: 3,
      publication_url: publicationUrl
    });
    const failedBundle = completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId);
    failedBundle.status = "failed";
    failedBundle.targets[2]!.status = "failed";
    expect(summarizePublicBenchmarkBundlePublication(failedBundle, expected, pair, publicationUrl)).toMatchObject({
      status: "failed",
      executed_case_count: 3,
      graded_case_count: 3
    });
    expect(() =>
      summarizePublicBenchmarkBundlePublication(
        completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId, { launched: 0 }),
        expected,
        pair,
        publicationUrl
      )
    ).toThrow(/executed case count/u);
    expect(() =>
      summarizePublicBenchmarkBundlePublication(
        completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId, {}, { rows: [] }),
        expected,
        pair,
        publicationUrl
      )
    ).toThrow(/graded case count/u);
  });

  it("rejects omitted, partial, or mismatched matrix target frameworks during automatic preparation", () => {
    const targetIds = ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"];
    const modelSlug = smokeManifest().pairs[0]!.model_slug;
    const pair = smokeManifest().pairs[0]!.pair;
    const expected = {
      matrixRowsPerPair: 3,
      targetIds,
      targets: smokeTargets(),
      trialsPerVariant: 1,
      modelSlug,
      evalRunId: "ci-12345-2-smoke-ultrafuzz-bench-openai-benchmark-smoke-gpt-5-6-luna-high"
    };
    const publicationUrl = "https://github.com/monad-developers/ultrafuzz/actions/runs/12345/artifacts";

    const cases: Array<[string, (matrix: PublicationMatrixRow[]) => void]> = [
      [
        "all framework maps omitted",
        (matrix) => matrix.forEach((row) => Reflect.deleteProperty(row, "workflow_input"))
      ],
      [
        "one target key omitted",
        (matrix) => {
          const row = matrix[1]!;
          if (row.workflow_input?.target_frameworks === undefined) throw new Error("missing framework fixture");
          Reflect.deleteProperty(row.workflow_input.target_frameworks, row.target_id);
        }
      ],
      ["one row omitted", (matrix) => Reflect.deleteProperty(matrix[2]!, "workflow_input")],
      [
        "one framework substituted",
        (matrix) => {
          const row = matrix[0]!;
          if (row.workflow_input?.target_frameworks === undefined) throw new Error("missing framework fixture");
          row.workflow_input.target_frameworks[row.target_id] = "hardhat";
        }
      ]
    ];

    for (const [label, mutate] of cases) {
      const matrix = matrixRows(targetIds, modelSlug);
      mutate(matrix);
      const bundle = completeHistoryBundle(matrix, expected.evalRunId);
      expect(() => summarizePublicBenchmarkBundlePublication(bundle, expected, pair, publicationUrl), label).toThrow(
        /matrix row .*?(?:workflow input|target frameworks|framework)/u
      );
    }
  });

  it("requires every bundle target framework to exactly match trusted policy during automatic preparation", () => {
    const targetIds = ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"];
    const modelSlug = smokeManifest().pairs[0]!.model_slug;
    const pair = smokeManifest().pairs[0]!.pair;
    const expected = {
      matrixRowsPerPair: 3,
      targetIds,
      targets: smokeTargets(),
      trialsPerVariant: 1,
      modelSlug,
      evalRunId: "ci-12345-2-smoke-ultrafuzz-bench-openai-benchmark-smoke-gpt-5-6-luna-high"
    };
    const publicationUrl = "https://github.com/monad-developers/ultrafuzz/actions/runs/12345/artifacts";

    const missing = completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId);
    Reflect.deleteProperty(missing.targets[0]!, "framework");
    expect(() => summarizePublicBenchmarkBundlePublication(missing, expected, pair, publicationUrl)).toThrow(
      /target 0 must contain exactly .*framework/u
    );

    const substituted = completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId);
    substituted.targets[0]!.framework = "hardhat";
    expect(() => summarizePublicBenchmarkBundlePublication(substituted, expected, pair, publicationUrl)).toThrow(
      /does not match the trusted benchmark policy/u
    );
  });

  it("rejects symlinked and oversized producer manifests before parsing", () => {
    const root = temporaryRoot("ultrafuzz-publication-manifest-");
    const target = path.join(root, "manifest.json");
    fs.writeFileSync(target, `${JSON.stringify(smokeManifest())}\n`);
    const symlink = path.join(root, "manifest-link.json");
    fs.symlinkSync(target, symlink);
    expect(() => readAutomaticPublicationManifest(symlink, smokeContext())).toThrow();

    const oversized = path.join(root, "oversized.json");
    fs.writeFileSync(oversized, " ".repeat(1024 * 1024 + 1));
    expect(() => readAutomaticPublicationManifest(oversized, smokeContext())).toThrow();
  });

  it("rejects a clean candidate policy commit whose selected manifest is a symlink", () => {
    const root = temporaryRoot("ultrafuzz-publication-policy-");
    fs.mkdirSync(path.join(root, "benchmarks"));
    fs.writeFileSync(path.join(root, "benchmarks/lanes.json"), "{}\n");
    fs.writeFileSync(path.join(root, "benchmarks/ultrafuzz-bench.json"), "{}\n");
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Test"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["add", "benchmarks"]);
    git(root, ["commit", "-m", "regular policy"]);
    const regularCommit = git(root, ["rev-parse", "HEAD"]).trim();
    expect(
      validateBenchmarkPolicyFiles({
        policyRoot: root,
        candidateCommit: regularCommit,
        benchmark: "ultrafuzz-bench"
      })
    ).toBe(fs.realpathSync(root));

    fs.unlinkSync(path.join(root, "benchmarks/lanes.json"));
    fs.writeFileSync(path.join(root, "outside.json"), "{}\n");
    fs.symlinkSync("../outside.json", path.join(root, "benchmarks/lanes.json"));
    git(root, ["add", "benchmarks/lanes.json"]);
    git(root, ["commit", "-m", "symlink policy"]);
    const symlinkCommit = git(root, ["rev-parse", "HEAD"]).trim();
    expect(() =>
      validateBenchmarkPolicyFiles({
        policyRoot: root,
        candidateCommit: symlinkCommit,
        benchmark: "ultrafuzz-bench"
      })
    ).toThrow(/symbolic link/u);
  });
});

function smokeContext() {
  return { ...context, targets: smokeTargets() };
}

function deepSeekAutomaticPublicationBundle(model = "deepseek-v4-flash") {
  const pair = `ultrafuzz-bench-benchmark-smoke-${model}-max`;
  const rowId = "very-liquid-vaults-foundry-row-1";
  const totalTokens = 1_750;
  const costUsd = 0.0002114;
  const diagnostics = {
    schema_version: "ultrafuzz.modal.public-eval-diagnostics.v4",
    model,
    rows: [
      {
        row_id: rowId,
        model_identity: {
          schema_version: "ultrafuzz.eval.model-identity.v1",
          configured_model: model,
          provider_reported_model: model,
          identity_scope: model === "deepseek-v4-flash" ? "provider-reported-alias" : "provider-reported-model-id",
          provider_version_status: "unverified",
          invocation_count: 1,
          invocations: [
            {
              invocation_id: "workflow-1/node-1/attempt-1/event-1",
              configured_model: model,
              provider_reported_model: model
            }
          ]
        },
        pricing: {
          schema_version: "ultrafuzz.eval.pricing-evidence.v1",
          configured_model: model,
          provider_reported_model: model,
          catalog: {
            source: "models.dev",
            status: "available",
            fetched_at: "2026-08-03T00:00:00.000Z",
            catalog_sha256: "a".repeat(64),
            resolved_models: [model],
            unresolved_models: [] as string[]
          },
          rates_usd_per_million: {
            uncached_input: 0.14,
            cache_read: 0.0028,
            cache_write: null,
            output: 0.28,
            reasoning: 0.28
          },
          usage: {
            uncached_input_tokens: 1_000,
            cache_read_tokens: 500,
            cache_write_tokens: 0,
            output_tokens: 250,
            reasoning_tokens: 0,
            inclusive_token_total: totalTokens,
            billable_token_total: totalTokens,
            total_tokens: totalTokens
          },
          component_costs_usd: {
            uncached_input: 0.00014,
            cache_read: 0.0000014,
            cache_write: 0,
            output: 0.00007,
            reasoning: 0
          },
          cost_usd: costUsd,
          usage_complete: true,
          pricing_complete: true,
          partial_pricing: false,
          event_count: 1,
          priced_event_count: 1,
          unpriced_event_count: 0,
          thinking_tokens_included_in_output: true
        }
      }
    ]
  };
  const summary = {
    rows: [
      {
        row_id: rowId,
        efficiency: {
          total_tokens: totalTokens,
          cost_usd: costUsd,
          usage: { status: "complete", reason: null },
          cost: { status: "complete", reason: null }
        }
      }
    ]
  };
  const bundle = {
    schema_version: "ultrafuzz.modal.public-benchmark-bundle.v7",
    model,
    provider_reported_model: model,
    files: [
      {
        path: "eval/public-eval-diagnostics.json",
        contents_base64: Buffer.from(`${JSON.stringify(diagnostics)}\n`, "utf8").toString("base64")
      },
      {
        path: "eval/summary.json",
        contents_base64: Buffer.from(`${JSON.stringify(summary)}\n`, "utf8").toString("base64")
      }
    ]
  };
  const syncBundleFiles = () => {
    bundle.files[0]!.contents_base64 = Buffer.from(`${JSON.stringify(diagnostics)}\n`, "utf8").toString("base64");
    bundle.files[1]!.contents_base64 = Buffer.from(`${JSON.stringify(summary)}\n`, "utf8").toString("base64");
  };
  return { bundle, diagnostics, model, pair, summary, syncBundleFiles };
}

function automaticPublicationReceipt() {
  const configFingerprint = "1".repeat(64);
  const sourceFingerprint = "2".repeat(64);
  const imageFingerprint = "3".repeat(64);
  const modelFingerprint = "4".repeat(64);
  const candidateCommit = "a".repeat(40);
  const logicalRunId = "ci-12345-2-smoke-ultrafuzz-bench-openai";
  const model = {
    slug: "benchmark-smoke-gpt-5-6-luna-high",
    model: "gpt-5.6-luna",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "high",
    auth_mode: "api-key"
  };
  const attemptId = "final-attempt";
  const launchedAt = "2026-08-03T00:00:00.000Z";
  const finishedAt = "2026-08-03T00:10:00.000Z";
  const launch = {
    ...model,
    generation: 1,
    attempt: 1,
    attempt_id: attemptId,
    model_fingerprint: modelFingerprint,
    volume_name: "benchmark-volume",
    remote_root: "/benchmark",
    workspace_mode: "fresh",
    phase: "launched",
    reserved_at: launchedAt,
    sandbox_id: "sandbox-1",
    launched_at: launchedAt
  };
  const state = {
    schema_version: "ultrafuzz.modal.launch-state.v3",
    logical_run_id: logicalRunId,
    generation: 1,
    generation_mode: "fresh",
    generation_start_reason: "initial",
    app: "ultrafuzz-evals",
    image: `ufz-runner-${candidateCommit}`,
    image_id: "image-1",
    timeout_ms: 86_400_000,
    source_revision: candidateCommit,
    fingerprints: {
      config: configFingerprint,
      source: sourceFingerprint,
      image: imageFingerprint
    },
    launches: [launch],
    attempt_history: [] as Array<typeof launch>,
    recovery_lifecycle: [
      {
        schema_version: "ultrafuzz.modal.recovery-lifecycle.v1",
        logical_run_id: logicalRunId,
        model_slug: model.slug,
        generation: 1,
        attempt: 1,
        attempt_id: attemptId,
        trigger_action: "initial-launch",
        start_reason: "initial",
        terminal_reason: "succeeded",
        terminal_class: "succeeded",
        launched_at: launchedAt,
        finished_at: finishedAt,
        worker_exit_code: 0,
        fingerprints: {
          config: configFingerprint,
          source: sourceFingerprint,
          image: imageFingerprint,
          model: modelFingerprint
        },
        model_work_started: true as boolean | "unknown",
        last_durable_transition_at: finishedAt,
        node_counts_before: "unknown",
        node_counts_after: { succeeded: 7 },
        progress_made: true,
        controller_requested: false,
        node_attempt_ledger_digest: "5".repeat(64),
        evaluation_lineage_digest: "6".repeat(64)
      }
    ]
  };
  const evalRunId = `${logicalRunId}-${model.slug}`;
  return {
    pair: `ultrafuzz-bench-${model.slug}`,
    bundle: {
      schema_version: "ultrafuzz.modal.public-benchmark-bundle.v7",
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      model_slug: model.slug,
      model: model.model,
      provider_reported_model: model.model,
      reasoning: model.reasoning,
      candidate_commit: candidateCommit,
      eval_run_id: evalRunId,
      lineage: {
        logical_run_id: logicalRunId,
        generation: 1,
        attempt: 1,
        attempt_id: attemptId,
        config_fingerprint: configFingerprint,
        source_fingerprint: sourceFingerprint,
        image_fingerprint: imageFingerprint,
        model_fingerprint: modelFingerprint
      }
    },
    config: {
      run_id: logicalRunId,
      app_name: "ultrafuzz-evals",
      image_name: `ufz-runner-${candidateCommit}`
    },
    model,
    state,
    context: {
      benchmark: "ultrafuzz-bench",
      mode: "smoke",
      candidateCommit
    },
    expectedEvalRunId: evalRunId,
    configFingerprint,
    sourceFingerprint,
    imageFingerprint,
    modelFingerprint
  };
}

function fullPublicationContext() {
  return { ...context, mode: "full" as const, targets: fullTargets() };
}

function smokeManifest() {
  const modelSlug = "benchmark-smoke-gpt-5-6-luna-high";
  const pair = `ultrafuzz-bench-${modelSlug}`;
  return {
    candidate_commit: "a".repeat(40),
    repository: "https://github.com/monad-developers/ultrafuzz",
    generation: "12345-2",
    mode: "smoke",
    benchmark: "ultrafuzz-bench",
    execution: { mode: "modal", dry_run: false },
    image_name: `ufz-runner-${"a".repeat(40)}`,
    targets: smokeTargets(),
    matrix_rows_per_pair: 3,
    control_timeout_seconds: 19_800,
    concurrency: {
      max_parallel_eval_rows_per_sandbox: 3,
      max_parallel_workflow_nodes_per_row: 4,
      max_live_runner_workflows_by_provider: { openai: 3 },
      max_live_judge_rows: 3
    },
    pairs: [
      {
        pair,
        benchmark: "ultrafuzz-bench",
        mode: "smoke",
        lane: "smoke",
        model_slug: modelSlug,
        provider: "openai",
        config_path: `${pair}.json`,
        state_path: `${pair}.state.json`
      }
    ]
  };
}

function deepSeekSmokeManifest(model = "deepseek-v4-flash", reasoning = "max") {
  const manifest = smokeManifest();
  const modelSlug = `benchmark-smoke-${model}-${reasoning}`;
  const pair = `ultrafuzz-bench-${modelSlug}`;
  const providerConcurrency = manifest.concurrency.max_live_runner_workflows_by_provider as Record<string, number>;
  delete providerConcurrency.openai;
  providerConcurrency.deepseek = 3;
  manifest.pairs = [
    {
      ...manifest.pairs[0]!,
      pair,
      model_slug: modelSlug,
      provider: "deepseek",
      config_path: `${pair}.json`,
      state_path: `${pair}.state.json`
    }
  ];
  return manifest;
}

function deepSeekPairConfigArguments(modelName: string, reasoning: string) {
  const manifest = deepSeekSmokeManifest(modelName, reasoning);
  const pair = manifest.pairs[0]!;
  const model = {
    slug: pair.model_slug,
    model: modelName,
    provider: "deepseek",
    agent: "DeepSeekAgent",
    reasoning,
    auth_mode: "api-key"
  };
  const config = {
    schema_version: "ultrafuzz.modal.benchmark.v1",
    run_id: "ci-12345-2-smoke-ultrafuzz-bench-deepseek",
    app_name: "ultrafuzz-evals",
    image_name: `ufz-runner-${"a".repeat(40)}`,
    node_timeout_seconds: 1800,
    loops: 1,
    braintrust: {
      project: "ultrafuzz-public-benchmarks",
      api_key_env: "BRAINTRUST_API_KEY",
      judge_api_key_env: "OPENAI_API_KEY",
      judge_url: "https://api.openai.com/v1/chat/completions"
    },
    public_benchmark: {
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      runner_model_profile: pair.model_slug,
      candidate_repository: context.repository,
      candidate_commit: context.candidateCommit,
      targets: smokeTargets(),
      max_runtime_seconds: 15_000
    }
  };
  return [config, model, pair] as const;
}

function fullManifest() {
  const pairs = [
    ["openai", "benchmark-full-gpt-5-6-luna-high"],
    ["anthropic", "benchmark-full-claude-sonnet-5-high"],
    ["kimi", "benchmark-full-kimi-k3-max"],
    ["deepseek", "benchmark-full-deepseek-v4-pro-max"]
  ].map(([provider, modelSlug]) => {
    const pair = `evmbench-${modelSlug}`;
    return {
      pair,
      benchmark: "evmbench",
      mode: "full",
      lane: "full",
      model_slug: modelSlug,
      provider,
      config_path: `${pair}.json`,
      state_path: `${pair}.state.json`
    };
  });
  return {
    candidate_commit: "a".repeat(40),
    repository: "https://github.com/monad-developers/ultrafuzz",
    generation: "12345-2",
    mode: "full",
    benchmark: "evmbench",
    execution: { mode: "modal", dry_run: false },
    image_name: `ufz-runner-${"a".repeat(40)}`,
    targets: fullTargets(),
    matrix_rows_per_pair: 40,
    control_timeout_seconds: 14_700,
    concurrency: {
      max_parallel_eval_rows_per_sandbox: 20,
      max_parallel_workflow_nodes_per_row: 8,
      max_live_runner_workflows_by_provider: { openai: 20, anthropic: 20, kimi: 20, deepseek: 20 },
      max_live_judge_rows: 80
    },
    pairs
  };
}

function smokeTargets() {
  return [
    {
      id: "very-liquid-vaults-foundry",
      repository: "https://github.com/benchmark-targets/very-liquid-vaults",
      revision: "1".repeat(40),
      framework: "foundry"
    },
    {
      id: "venus-isolated-pools-hardhat",
      repository: "https://github.com/benchmark-targets/venus-isolated-pools",
      revision: "2".repeat(40),
      framework: "hardhat"
    },
    {
      id: "stableswap-ng-vyper",
      repository: "https://github.com/benchmark-targets/stableswap-ng",
      revision: "3".repeat(40),
      framework: "vyper"
    }
  ];
}

function fullTargets() {
  return Array.from({ length: 40 }, (_value, index) => ({
    id: `evmbench-target-${String(index + 1).padStart(2, "0")}`,
    repository: "https://github.com/benchmark-targets/evmbench-target",
    revision: `${String(index % 10).repeat(40)}`,
    framework: "foundry"
  }));
}

interface PublicationMatrixRow {
  id: string;
  target_id: string;
  variant_id: string;
  trial_id: string;
  workflow_input?: { target_frameworks?: Record<string, string> };
}

function bundleWithMatrix(matrix: PublicationMatrixRow[]) {
  return {
    files: [
      {
        path: "eval/matrix.json",
        contents_base64: Buffer.from(`${JSON.stringify(matrix)}\n`, "utf8").toString("base64")
      }
    ]
  };
}

function completeHistoryBundle(
  matrix: PublicationMatrixRow[],
  evalRunId: string,
  diagnosticsSummaryOverrides: Record<string, unknown> = {},
  scoreSummaryOverrides: Record<string, unknown> = {}
) {
  const trustedTargets = new Map(smokeTargets().map((target) => [target.id, target]));
  const diagnosticsRows = matrix.map((row, index) => ({
    row_id: row.id,
    target_id: row.target_id,
    variant_id: row.variant_id,
    trial_id: row.trial_id,
    run_status: "launched",
    final_status: "succeeded",
    workflow_status: "succeeded",
    workflow_terminal: true,
    terminal_disposition: "clean",
    terminal_report_present: true,
    workflow_ids: [`workflow-${index + 1}`],
    diagnostic_codes: [],
    failed_nodes: [],
    scoring_ready: true,
    reason_codes: []
  }));
  const diagnostics = {
    eval_run_id: evalRunId,
    summary: {
      planned: matrix.length,
      launched: matrix.length,
      launch_failed: 0,
      run_records_missing: 0,
      workflow_succeeded: matrix.length,
      workflow_failed: 0,
      workflow_nonterminal: 0,
      genuine_task_failure_rows: 0,
      terminal_reports_present: matrix.length,
      scoring_ready: true,
      ...diagnosticsSummaryOverrides
    },
    rows: diagnosticsRows
  };
  const scoreSummary = {
    eval_run_id: evalRunId,
    rows: matrix.map((row) => ({ row_id: row.id })),
    ...scoreSummaryOverrides
  };
  return {
    status: "succeeded",
    executed_case_count: matrix.length,
    graded_case_count: matrix.length,
    targets: matrix.map((row, index) => {
      const trustedTarget = trustedTargets.get(row.target_id);
      return {
        id: row.target_id,
        repository: trustedTarget?.repository ?? `https://github.com/benchmark-targets/${row.target_id}`,
        revision: trustedTarget?.revision ?? String(index + 1).repeat(40),
        framework: trustedTarget?.framework ?? (index % 3 === 0 ? "foundry" : index % 3 === 1 ? "hardhat" : "vyper"),
        status: "succeeded",
        executed_case_count: 1,
        graded_case_count: 1,
        publication_location: {
          bundle_path: "public-results.json",
          report_paths: [
            `reports/${row.id}/report.md`,
            `reports/${row.id}/report.json`,
            `reports/${row.id}/findings.normalized.json`
          ]
        }
      };
    }),
    files: [
      {
        path: "eval/matrix.json",
        contents_base64: Buffer.from(`${JSON.stringify(matrix)}\n`, "utf8").toString("base64")
      },
      {
        path: "eval/public-eval-diagnostics.json",
        contents_base64: Buffer.from(`${JSON.stringify(diagnostics)}\n`, "utf8").toString("base64")
      },
      {
        path: "eval/summary.json",
        contents_base64: Buffer.from(`${JSON.stringify(scoreSummary)}\n`, "utf8").toString("base64")
      }
    ]
  };
}

function matrixRows(targetIds: string[], modelSlug: string): PublicationMatrixRow[] {
  return targetIds.map((targetId, index) => ({
    id: `${targetId}-row-${index + 1}`,
    target_id: targetId,
    variant_id: modelSlug,
    trial_id: "trial-1",
    workflow_input: {
      target_frameworks: {
        [targetId]: index % 3 === 0 ? "foundry" : index % 3 === 1 ? "hardhat" : "vyper"
      }
    }
  }));
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
