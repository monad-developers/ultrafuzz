#!/usr/bin/env node

import path from "node:path";

import type { ModalLaunchMode, ModelProvider } from "./defaults.js";
import { extractPublicBenchmarkBundle, readPublicBenchmarkBundle } from "./public-bundle.js";
import {
  buildModalImage,
  collectModalBenchmark,
  launchModalBenchmark,
  ModalTerminationError,
  modalBenchmarkStatus,
  overseeModalBenchmarks,
  terminateModalBenchmark,
  terminateModalBenchmarkConfig,
  terminateModalImageBuild
} from "./runner.js";

const usage =
  "usage: ultrafuzz-modal <build|launch|status|overseer|terminate|terminate-build|collect|unpack-public|smoke> [--config path] [--model slug] [--state path] [--mode resume|fresh] [--fresh] [--public-results] [--bundle path] [--output path] [--provider openai|anthropic|kimi]";

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  if (command === "smoke") {
    const provider = requiredProvider(argv);
    const { runRealModalSmoke } = await import("./smoke-modal.js");
    const result = await runRealModalSmoke(provider);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "passed") process.exitCode = 1;
    return;
  }
  if (command === "build") {
    const result = await buildModalImage({
      appName: option(argv, "--app"),
      imageName: option(argv, "--image"),
      buildScope: option(argv, "--build-scope"),
      repoRoot: option(argv, "--repo-root")
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "launch") {
    const configPath = requiredOption(argv, "--config");
    const state = await launchModalBenchmark({
      configPath,
      modelSlugs: options(argv, "--model"),
      statePath: option(argv, "--state"),
      repoRoot: option(argv, "--repo-root"),
      mode: modalLaunchMode(argv)
    });
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (command === "status") {
    const rows = await modalBenchmarkStatus({ statePath: requiredOption(argv, "--state") });
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (command === "overseer") {
    const configPaths = options(argv, "--config");
    const statePaths = options(argv, "--state");
    const recoveryStatePaths = options(argv, "--recovery-state");
    const recoveryImages = options(argv, "--image");
    if (
      configPaths.length === 0 ||
      configPaths.length !== statePaths.length ||
      configPaths.length !== recoveryStatePaths.length ||
      recoveryImages.length > configPaths.length
    ) {
      throw new Error("overseer requires matching repeated --config, --state, and --recovery-state options");
    }
    const resumeGraceMs = millisecondsOption(argv, "--resume-grace-seconds");
    const staleAfterMs = millisecondsOption(argv, "--stale-seconds");
    const maxNoProgressGenerations = integerOption(argv, "--max-no-progress-generations");
    const backoffBaseMs = millisecondsOption(argv, "--backoff-base-seconds");
    const backoffMaxMs = millisecondsOption(argv, "--backoff-max-seconds");
    const policy = {
      ...(resumeGraceMs === undefined ? {} : { resumeGraceMs }),
      ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
      ...(maxNoProgressGenerations === undefined ? {} : { maxNoProgressGenerations }),
      ...(backoffBaseMs === undefined ? {} : { backoffBaseMs }),
      ...(backoffMaxMs === undefined ? {} : { backoffMaxMs })
    };
    await overseeModalBenchmarks({
      jobs: configPaths.map((configPath, index) => ({
        configPath,
        statePath: statePaths[index]!,
        recoveryStatePath: recoveryStatePaths[index]!,
        ...(recoveryImages[index] === undefined ? {} : { recoveryImage: recoveryImages[index] }),
        ...(argv.includes("--force-rollout") ? { forceRollout: true } : {}),
        policy
      })),
      pollMs: millisecondsOption(argv, "--poll-seconds") ?? 60_000
    });
    return;
  }
  if (command === "terminate") {
    try {
      const statePath = option(argv, "--state");
      const configPath = option(argv, "--config");
      if ((statePath === undefined) === (configPath === undefined)) {
        throw new Error("terminate requires exactly one of --state or --config");
      }
      const counts =
        statePath === undefined
          ? await terminateModalBenchmarkConfig({
              configPath: configPath!,
              repoRoot: option(argv, "--repo-root")
            })
          : await terminateModalBenchmark({ statePath });
      console.log(JSON.stringify(counts));
    } catch (error) {
      if (!(error instanceof ModalTerminationError)) throw error;
      console.log(JSON.stringify(error.counts));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "terminate-build") {
    try {
      const counts = await terminateModalImageBuild({
        appName: option(argv, "--app"),
        imageName: requiredOption(argv, "--image"),
        buildScope: requiredOption(argv, "--build-scope"),
        repoRoot: option(argv, "--repo-root")
      });
      console.log(JSON.stringify(counts));
    } catch (error) {
      if (!(error instanceof ModalTerminationError)) throw error;
      console.log(JSON.stringify(error.counts));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "collect") {
    const includePublicResults = argv.includes("--public-results");
    const configPath = option(argv, "--config");
    await collectModalBenchmark({
      statePath: requiredOption(argv, "--state"),
      outputDir: path.resolve(option(argv, "--output") ?? ".ultrafuzz/modal/results"),
      includePublicResults,
      ...(configPath === undefined
        ? includePublicResults
          ? { configPath: requiredOption(argv, "--config") }
          : {}
        : { configPath })
    });
    return;
  }
  if (command === "unpack-public") {
    const bundle = readPublicBenchmarkBundle(requiredOption(argv, "--bundle"));
    extractPublicBenchmarkBundle(bundle, path.resolve(requiredOption(argv, "--output")));
    console.log(
      JSON.stringify({
        benchmark: bundle.benchmark,
        lane: bundle.lane,
        model_slug: bundle.model_slug,
        candidate_commit: bundle.candidate_commit,
        eval_run_id: bundle.eval_run_id
      })
    );
    return;
  }
  throw new Error(usage);
}

function modalLaunchMode(argv: string[]): ModalLaunchMode {
  const value = option(argv, "--mode");
  const freshAlias = argv.includes("--fresh");
  if (value === undefined) return freshAlias ? "fresh" : "resume";
  if (value !== "resume" && value !== "fresh") throw new Error("--mode must be resume or fresh");
  if (freshAlias && value !== "fresh") throw new Error("--fresh conflicts with --mode resume");
  return value;
}

function requiredProvider(argv: string[]): ModelProvider {
  const value = requiredOption(argv, "--provider");
  if (value !== "openai" && value !== "anthropic" && value !== "kimi") {
    throw new Error("--provider must be openai, anthropic, or kimi");
  }
  return value;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function requiredOption(argv: string[], name: string): string {
  const value = option(argv, name);
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function options(argv: string[], name: string): string[] {
  return argv.flatMap((value, index) => (value === name && argv[index + 1] !== undefined ? [argv[index + 1]!] : []));
}

function millisecondsOption(argv: string[], name: string): number | undefined {
  const seconds = integerOption(argv, name);
  if (seconds === undefined) return undefined;
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`${name} is too large`);
  return milliseconds;
}

function integerOption(argv: string[], name: string): number | undefined {
  const value = option(argv, name);
  if (value === undefined) return undefined;
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer <= 0) throw new Error(`${name} must be a positive integer`);
  return integer;
}

await main();
