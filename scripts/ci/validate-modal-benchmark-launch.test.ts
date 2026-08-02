import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateModalBenchmarkLaunch } from "./validate-modal-benchmark-launch.mjs";

const roots: string[] = [];
const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: path.resolve("."),
  encoding: "utf8"
}).trim();
const repository = "https://github.com/monad-developers/ultrafuzz";

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Modal benchmark launch guardrails", () => {
  it("accepts the canonical Modal smoke manifest before dispatch", () => {
    const fixture = preparedSmokeFixture();
    expect(validateModalBenchmarkLaunch(fixture.input)).toEqual({
      mode: "smoke",
      benchmark: "ultrafuzz-bench",
      execution: { mode: "modal", dry_run: false },
      target_count: 3,
      matrix_rows_per_pair: 3,
      pair_count: 1
    });
  });

  it("requires an explicit trusted provider override for a DeepSeek smoke manifest", () => {
    const fixture = preparedSmokeFixture({ provider: "deepseek", model: "deepseek-v4-flash", reasoning: "max" });
    expect(() => validateModalBenchmarkLaunch(fixture.input)).toThrow();

    const expected = {
      mode: "smoke",
      benchmark: "ultrafuzz-bench",
      execution: { mode: "modal", dry_run: false },
      target_count: 3,
      matrix_rows_per_pair: 3,
      pair_count: 1
    };
    expect(validateModalBenchmarkLaunch({ ...fixture.input, expectedProviders: ["deepseek"] })).toEqual(expected);

    const output = execFileSync(
      process.execPath,
      [
        path.join(path.resolve("."), "scripts/ci/validate-modal-benchmark-launch.mjs"),
        fixture.manifestPath,
        path.resolve("."),
        "smoke",
        "--expected-provider",
        "deepseek"
      ],
      { cwd: path.resolve("."), encoding: "utf8" }
    );
    expect(JSON.parse(output)).toEqual(expected);
  });

  it("rejects one-target canonical smoke manifests before dispatch", () => {
    const fixture = preparedSmokeFixture();
    const manifest = readJson<LaunchManifest>(fixture.manifestPath);
    manifest.targets = [manifest.targets[0]!];
    manifest.matrix_rows_per_pair = 1;
    writeJson(fixture.manifestPath, manifest);

    expect(() => validateModalBenchmarkLaunch(fixture.input)).toThrow(
      /canonical smoke launch manifest .*missing configured target\(s\).*venus-isolated-pools-hardhat.*stableswap-ng-vyper/u
    );
  });

  it("rejects local-only and dry-run smoke manifests before dispatch", () => {
    const cases: Array<[RegExp, (manifest: LaunchManifest) => void]> = [
      [/Modal benchmark launch manifest .*local-only/u, (manifest) => (manifest.execution.mode = "local")],
      [/Modal benchmark launch manifest .*dry-run/u, (manifest) => (manifest.execution.dry_run = true)]
    ];
    for (const [message, mutate] of cases) {
      const fixture = preparedSmokeFixture();
      const manifest = readJson<LaunchManifest>(fixture.manifestPath);
      mutate(manifest);
      writeJson(fixture.manifestPath, manifest);
      expect(() => validateModalBenchmarkLaunch(fixture.input)).toThrow(message);
    }
  });

  it("rejects a launch manifest for a different candidate than the policy checkout", () => {
    const fixture = preparedSmokeFixture();
    const manifest = readJson<Record<string, unknown>>(fixture.manifestPath);
    manifest.candidate_commit = "b".repeat(40);
    writeJson(fixture.manifestPath, manifest);

    expect(() => validateModalBenchmarkLaunch(fixture.input)).toThrow(/candidate commit does not match/u);
  });

  it("rejects local-only, dry-run, and target-truncated pair configs before dispatch", () => {
    const localOnly = preparedSmokeFixture();
    const localOnlyConfig = readJson<Record<string, unknown>>(localOnly.configPath);
    delete localOnlyConfig.public_benchmark;
    localOnlyConfig.target = { repo: "https://github.com/example/target", ref: "b".repeat(40) };
    localOnlyConfig.ground_truth = {
      repo: "https://github.com/example/truth",
      ref: "c".repeat(40),
      file: "ground-truth.yml"
    };
    writeJson(localOnly.configPath, localOnlyConfig);
    expect(() => validateModalBenchmarkLaunch(localOnly.input)).toThrow(
      /Modal benchmark launch config .*local-only\/private.*manifest/u
    );

    const dryRun = preparedSmokeFixture();
    const dryRunConfig = readJson<Record<string, unknown>>(dryRun.configPath);
    dryRunConfig.execution = { mode: "modal", dry_run: true };
    writeJson(dryRun.configPath, dryRunConfig);
    expect(() => validateModalBenchmarkLaunch(dryRun.input)).toThrow(/Modal benchmark launch config .*dry-run/u);

    const truncated = preparedSmokeFixture();
    const truncatedConfig = readJson<LaunchConfig>(truncated.configPath);
    truncatedConfig.public_benchmark.targets = [truncatedConfig.public_benchmark.targets[0]!];
    writeJson(truncated.configPath, truncatedConfig);
    expect(() => validateModalBenchmarkLaunch(truncated.input)).toThrow(
      /Modal benchmark launch config .*missing configured target\(s\).*expected 3, found 1/u
    );
  });

  it("rejects whitespace-padded Kimi reasoning during CI model matrix preparation", () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-launch-kimi-"));
    roots.push(output);

    let failure: unknown;
    try {
      execFileSync(
        process.execPath,
        [
          path.join(path.resolve("."), "scripts/ci/prepare-modal-benchmarks.mjs"),
          candidate,
          repository,
          "12345-1",
          output,
          "full"
        ],
        {
          cwd: path.resolve("."),
          env: {
            ...process.env,
            BENCHMARK_MODELS_JSON: JSON.stringify([
              { provider: "openai", model: "gpt-5.6-luna", reasoning: "high" },
              { provider: "anthropic", model: "claude-sonnet-5", reasoning: "high" },
              { provider: "kimi", model: "kimi-k3", reasoning: " max " }
            ])
          }
        }
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeDefined();
    const stderr = Buffer.isBuffer((failure as { stderr?: unknown }).stderr)
      ? String((failure as { stderr: Buffer }).stderr)
      : String(failure);
    expect(stderr).toMatch(/reasoning is unsafe|unsupported for Kimi/u);
  });
});

interface LaunchTarget {
  id: string;
  repository: string;
  revision: string;
  framework: string;
}

interface LaunchManifest {
  execution: { mode: string; dry_run: boolean };
  targets: LaunchTarget[];
  matrix_rows_per_pair: number;
  pairs: Array<{ config_path: string }>;
}

interface LaunchConfig {
  public_benchmark: { targets: LaunchTarget[] };
}

function preparedSmokeFixture(model?: { provider: string; model: string; reasoning: string }) {
  const workspace = path.resolve(".");
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-launch-"));
  roots.push(output);
  execFileSync(
    process.execPath,
    [
      path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
      candidate,
      repository,
      "12345-1",
      output,
      "smoke"
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        BENCHMARK_MODELS_JSON: model === undefined ? "" : JSON.stringify([model])
      }
    }
  );
  const manifestPath = path.join(output, "manifest.json");
  const manifest = readJson<LaunchManifest>(manifestPath);
  return {
    manifestPath,
    configPath: path.join(output, manifest.pairs[0]!.config_path),
    input: {
      manifestPath,
      policyRoot: workspace,
      expectedMode: "smoke"
    }
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
