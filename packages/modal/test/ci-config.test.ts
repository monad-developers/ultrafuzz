import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("public Modal benchmark configuration", () => {
  it("creates exactly two models by two cohorts with a fixed one-hour budget", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-ci-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "a".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "12345-1",
        output,
        "smoke"
      ],
      { cwd: workspace }
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")) as {
      pairs: Array<{ benchmark: string; model_slug: string; config_path: string }>;
      image_name: string;
    };
    expect(manifest.pairs).toHaveLength(4);
    expect(new Set(manifest.pairs.map((pair) => pair.benchmark))).toEqual(new Set(["evmbench", "ultrafuzz-bench"]));
    expect(new Set(manifest.pairs.map((pair) => pair.model_slug))).toEqual(
      new Set(["benchmark-smoke-gpt-5-6-luna-low", "benchmark-smoke-claude-sonnet-5-low"])
    );
    expect(manifest.image_name).toBe(`ufz-runner-${"a".repeat(40)}`);
    for (const pair of manifest.pairs) {
      const config = JSON.parse(fs.readFileSync(path.join(output, pair.config_path), "utf8")) as {
        node_timeout_seconds: number;
        public_benchmark: { max_runtime_seconds: number };
        braintrust: { judge_api_key_env: string; judge_url?: string };
        models: Array<{ reasoning: string }>;
      };
      expect(config.node_timeout_seconds).toBe(1800);
      expect(config.public_benchmark.max_runtime_seconds).toBe(3600);
      expect(config.braintrust.judge_api_key_env).toBe("OPENAI_API_KEY");
      expect(config.braintrust.judge_url).toBe("https://api.openai.com/v1/chat/completions");
      expect(config.models).toEqual([expect.objectContaining({ reasoning: "low" })]);
    }
  });

  it("rejects an unchunked full public matrix before any Modal work can launch", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-full-"));
    const result = spawnSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "d".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "full-1",
        output,
        "full"
      ],
      { cwd: workspace, encoding: "utf8" }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/supports only the bounded smoke lane/);
    expect(fs.existsSync(path.join(output, "manifest.json"))).toBe(false);
  });

  it("creates an eight-pair before/after Kaden experiment with qualified identities", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-paired-ablation-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "c".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "paired-1",
        output,
        "smoke",
        "paired-kadenzipfel"
      ],
      { cwd: workspace }
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")) as {
      experiment: string;
      pairs: Array<{ pair: string; experiment: string; config_path: string }>;
    };
    expect(manifest.experiment).toBe("paired-kadenzipfel");
    expect(manifest.pairs).toHaveLength(8);
    expect(new Set(manifest.pairs.map((pair) => pair.experiment))).toEqual(
      new Set(["candidate", "without-kadenzipfel"])
    );
    expect(new Set(manifest.pairs.map((pair) => pair.pair)).size).toBe(8);
    for (const pair of manifest.pairs) {
      expect(pair.pair.startsWith(`${pair.experiment}-`)).toBe(true);
      const config = JSON.parse(fs.readFileSync(path.join(output, pair.config_path), "utf8")) as {
        public_benchmark: { experiment: string };
      };
      expect(config.public_benchmark.experiment).toBe(pair.experiment);
    }
  });

  it("uses GitHub Actions only as the asynchronous Modal control and publication plane", () => {
    const workspace = path.resolve("../..");
    const workflow = fs.readFileSync(path.join(workspace, ".github/workflows/eval-benchmarks.yml"), "utf8");
    expect(() => parse(workflow)).not.toThrow();
    expect(workflow).toContain("node packages/modal/dist/cli.js launch");
    expect(workflow).toContain("Launch detached Modal benchmark sandboxes");
    expect(workflow).toContain("publish-eval-history-cas.mjs");
    expect(workflow).toContain("actions/download-artifact@");
    expect(workflow).toContain("--public-results");
    expect(workflow).toContain("retention-days: 30");
    expect(workflow).toContain("[ci skip] Update published eval history");
    expect(workflow).not.toContain("group: publish-eval-history");
    expect(workflow).not.toContain("peter-evans/create-pull-request");
    expect(workflow).not.toContain("ultrafuzz-benchmark");
    expect(workflow).not.toContain("self-hosted");
    expect(workflow).not.toContain("- full");
  });

  it("limits trusted benchmark credentials to main-only Modal steps", () => {
    const workspace = path.resolve("../..");
    const workflow = parse(fs.readFileSync(path.join(workspace, ".github/workflows/eval-benchmarks.yml"), "utf8")) as {
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          if?: string;
          permissions?: Record<string, string>;
          env?: Record<string, string>;
          steps: Array<{
            name?: string;
            env?: Record<string, string>;
            uses?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    const sensitive = [
      "ANTHROPIC_API_KEY",
      "BRAINTRUST_API_KEY",
      "MODAL_TOKEN_ID",
      "MODAL_TOKEN_SECRET",
      "OPENAI_API_KEY"
    ].sort();
    const modalOnly = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"].sort();
    const expectedByStep = new Map<string, string[]>([
      ["launch:Validate benchmark credentials", sensitive],
      ["launch:Build an immutable Modal image for the candidate", modalOnly],
      ["launch:Launch detached Modal benchmark sandboxes", sensitive],
      ["collect:Wait for Modal compute and retry only pre-model launch failures", sensitive],
      ["collect:Collect and validate public finding bundles", sensitive]
    ]);

    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(workflow.jobs.launch?.if).toContain(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'"
    );
    expect(workflow.jobs.launch?.if).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(workflow.jobs.publish?.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.publish?.permissions).toEqual({
      actions: "read",
      contents: "write",
      "pull-requests": "write"
    });

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      expect(
        sensitive.filter((name) => Object.hasOwn(job.env ?? {}, name)),
        `${jobName} job env`
      ).toEqual([]);
      for (const step of job.steps) {
        const key = `${jobName}:${step.name ?? "unnamed"}`;
        const actual = sensitive.filter((name) => Object.hasOwn(step.env ?? {}, name)).sort();
        expect(actual, key).toEqual(expectedByStep.get(key) ?? []);
      }
    }
    for (const jobName of ["launch", "collect"]) {
      const checkout = workflow.jobs[jobName]?.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.["persist-credentials"], `${jobName} checkout credentials`).toBe(false);
    }
    const publicationCheckout = workflow.jobs.publish?.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(publicationCheckout?.with?.ref).toBe("main");
  });

  it("does not cancel CI for distinct main commits before benchmark dispatch", () => {
    const workspace = path.resolve("../..");
    const workflow = parse(fs.readFileSync(path.join(workspace, ".github/workflows/ci.yml"), "utf8")) as {
      concurrency: { group: string; "cancel-in-progress": string };
    };

    expect(workflow.concurrency.group).toContain("github.ref == 'refs/heads/main' && github.sha || github.ref");
    expect(workflow.concurrency["cancel-in-progress"]).toContain("github.ref != 'refs/heads/main'");
  });

  it("validates persisted public results after lineage preflight and seals replacements atomically", () => {
    const workspace = path.resolve("../..");
    const source = fs.readFileSync(path.join(workspace, "packages/modal/src/public-worker.ts"), "utf8");
    const preflight = source.indexOf("await input.preflight");
    const persistedBundle = source.indexOf("if (fs.existsSync(bundlePath))");
    const readPersistedBundle = source.indexOf("readPublicBenchmarkBundle", persistedBundle);
    const assertPersistedLineage = source.indexOf("assertPublicWorkerBundleLineage", readPersistedBundle);

    expect(preflight).toBeGreaterThan(-1);
    expect(persistedBundle).toBeGreaterThan(preflight);
    expect(readPersistedBundle).toBeGreaterThan(persistedBundle);
    expect(assertPersistedLineage).toBeGreaterThan(readPersistedBundle);
    expect(source).toContain("await writePublicBundleAtomic(bundlePath, bundle)");
    expect(source).not.toContain("writeFile(bundlePath");
  });

  it("uses compare-and-swap publication for both automatic and manual history updates", () => {
    const workspace = path.resolve("../..");
    for (const file of ["eval-benchmarks.yml", "eval-history-publication.yml"]) {
      const workflow = fs.readFileSync(path.join(workspace, ".github/workflows", file), "utf8");
      expect(() => parse(workflow)).not.toThrow();
      expect(workflow).toContain("publish-eval-history-cas.mjs");
      expect(workflow).toContain("automation/eval-history");
      expect(workflow).not.toContain("group: publish-eval-history");
      expect(workflow).not.toContain("peter-evans/create-pull-request");
    }
    const manual = parse(
      fs.readFileSync(path.join(workspace, ".github/workflows/eval-history-publication.yml"), "utf8")
    ) as { jobs: { publish: { if?: string } } };
    expect(manual.jobs.publish.if).toBe("github.ref == 'refs/heads/main'");
  });

  it("preserves a pushed publication branch when repository policy blocks automatic pull requests", () => {
    const workspace = path.resolve("../..");
    for (const file of ["eval-benchmarks.yml", "eval-history-publication.yml"]) {
      const workflow = parse(fs.readFileSync(path.join(workspace, ".github/workflows", file), "utf8")) as {
        jobs: Record<
          string,
          {
            steps: Array<{
              name?: string;
              env?: Record<string, string>;
              run?: string;
            }>;
          }
        >;
      };
      const publicationStep = Object.values(workflow.jobs)
        .flatMap((job) => job.steps)
        .find((step) => step.name === "Open the publication pull request when needed");
      expect(publicationStep).toBeDefined();
      expect(publicationStep?.env?.GH_TOKEN).toBe("${{ secrets.EVAL_HISTORY_PR_TOKEN || github.token }}");
      expect(publicationStep?.run).toContain("gh pr create");
      expect(publicationStep?.run).toContain("Another publisher opened the eval-history pull request");
      expect(publicationStep?.run).toContain("::warning title=Eval-history PR not opened::");
      expect(publicationStep?.run).toContain("GITHUB_STEP_SUMMARY");
      expect(publicationStep?.run).toContain("compare/main...automation%2Feval-history?expand=1");
      expect(publicationStep?.run).toContain("publication branch remains pushed");
      expect(publicationStep?.run).not.toContain("Failed to create or find the eval-history publication pull request");
    }
  });

  it("preserves partial launches and defers matrix failure until after artifact upload", () => {
    const workspace = path.resolve("../..");
    const workflowText = fs.readFileSync(path.join(workspace, ".github/workflows/eval-benchmarks.yml"), "utf8");
    const workflow = parse(workflowText) as {
      jobs: Record<
        string,
        {
          if?: string;
          "timeout-minutes"?: number;
          steps: Array<{
            name?: string;
            run?: string;
            if?: string;
            "continue-on-error"?: boolean;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    const launch = workflow.jobs.launch!;
    const collect = workflow.jobs.collect!;
    const step = (name: string) => {
      const found = collect.steps.find((candidate) => candidate.name === name);
      expect(found, `missing collect step ${name}`).toBeDefined();
      return found!;
    };

    const launchScript = launch.steps.find(
      (candidate) => candidate.name === "Launch detached Modal benchmark sandboxes"
    )?.run;
    expect(launchScript).toContain("launch-attempts.jsonl");
    expect(launchScript).toContain("timeout --signal=TERM --kill-after=30s 20m");
    expect(launchScript).toContain("node packages/modal/dist/cli.js launch");
    expect(launchScript).toContain("launch_outcome=failed");
    expect(launchScript).not.toContain("exit 1");
    expect(launch["timeout-minutes"]).toBeGreaterThanOrEqual(180);

    expect(collect.if).toContain("always()");
    expect(collect.if).toContain("needs.launch.result != 'skipped'");
    expect(step("Restore detached launch state")["continue-on-error"]).toBe(true);
    expect(step("Discover recoverable launch control").if).toBe("always()");

    const waitScript = step("Wait for Modal compute and retry only pre-model launch failures").run ?? "";
    expect(waitScript).toContain("launch-state-missing");
    expect(waitScript).toContain("launch-state-empty");
    expect(waitScript).toContain("initial-launch-recovery-succeeded");
    expect(waitScript).toContain("initial-launch-recovery-incomplete");
    expect(waitScript).toContain("initial-launch-recovery-timeout");
    expect(waitScript).toContain("deadline=$((SECONDS + 7200))");
    expect(waitScript).toContain('"$recovery_exit" -eq 137');
    expect(waitScript).toContain("resume-attempt-timeout");
    expect(waitScript).toContain('.phase == "reserved"');
    expect(waitScript).toContain("recovery_mode=fresh");
    expect(waitScript).toContain("recovery_mode=resume");
    expect(waitScript.indexOf("initial-launch-recovery-succeeded")).toBeLessThan(
      waitScript.indexOf("launch-state-missing")
    );
    expect(waitScript).toContain("control-plane-timeout");
    expect(waitScript).toContain("timeout --signal=TERM --kill-after=30s 2m");
    expect(waitScript).toContain("status-query-timeout");
    expect(waitScript).not.toContain("exit 1");

    const collectScript = step("Collect and validate public finding bundles").run;
    expect(collectScript).toContain('.terminal_status == "succeeded"');
    expect(collectScript).toContain("timeout --signal=TERM --kill-after=30s 5m");
    expect(collectScript).toContain("node packages/modal/dist/cli.js collect");
    expect(collectScript).toContain('--config "$BENCHMARK_CONTROL/$config"');
    expect(collectScript).toContain('--state "$BENCHMARK_CONTROL/$state"');
    expect(collectScript).toContain('diagnostic_collection_status = "succeeded"');
    expect(collectScript).toContain('diagnostic_collection_status = "failed"');
    expect(collectScript).toContain('collection_status = "failed"');
    expect(collectScript).toContain("collection-timeout");
    expect(collectScript).not.toContain("rm -rf");

    const resultUpload = step("Upload public benchmark reports and findings");
    const diagnosticsUpload = step("Upload launch state and failure diagnostics");
    const finalGate = step("Fail an incomplete matrix after preserving artifacts");
    expect(resultUpload.if).toBe("always()");
    expect(resultUpload.with?.["if-no-files-found"]).toBe("warn");
    expect(diagnosticsUpload.if).toBe("always()");
    expect(finalGate.if).toBe("always()");
    expect(collect.steps.indexOf(finalGate)).toBeGreaterThan(collect.steps.indexOf(resultUpload));
    expect(collect.steps.indexOf(finalGate)).toBeGreaterThan(collect.steps.indexOf(diagnosticsUpload));
    expect(finalGate.run).toContain("exit 1");
  });

  it("hydrates pinned target submodules before initializing a public benchmark", () => {
    const workspace = path.resolve("../..");
    const worker = fs.readFileSync(path.join(workspace, "packages/modal/src/public-worker.ts"), "utf8");
    const clone = worker.indexOf(
      "await cloneAtCommit(target.repo, target.ref, destination, logPath, { initializeSubmodules: true })"
    );
    const init = worker.indexOf('["node", CLI, "init", "--project", destination', clone);
    const checkout = worker.indexOf('["git", "checkout", "--detach", commit]');
    const submodules = worker.indexOf('["git", "submodule", "update", "--init", "--recursive", "--depth", "1"]');
    const timeoutCap = worker.indexOf("capModalTargetTopologyTimeouts", init);
    const referenceSync = worker.indexOf('["node", CLI, "references", "sync"', init);

    expect(clone).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(clone);
    expect(timeoutCap).toBeGreaterThan(init);
    expect(referenceSync).toBeGreaterThan(timeoutCap);
    expect(checkout).toBeGreaterThan(-1);
    expect(submodules).toBeGreaterThan(checkout);
  });

  it("creates a controlled Kaden-free ablation without changing model or judge identities", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-ablation-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "b".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "ablation-1",
        output,
        "smoke",
        "without-kadenzipfel"
      ],
      { cwd: workspace }
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")) as {
      experiment: string;
      pairs: Array<{ config_path: string }>;
    };
    expect(manifest.experiment).toBe("without-kadenzipfel");
    for (const pair of manifest.pairs) {
      const config = JSON.parse(fs.readFileSync(path.join(output, pair.config_path), "utf8")) as {
        public_benchmark: { excluded_node_ids: string[] };
      };
      expect(config.public_benchmark.excluded_node_ids).toEqual([
        "reference-vulnerabilities-kadenzipfel",
        "kadenzipfel-vulnerability-strategies"
      ]);
    }
  });
});
