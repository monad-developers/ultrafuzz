#!/usr/bin/env node

import path from "node:path";

import {
  buildModalImage,
  collectModalBenchmark,
  launchModalBenchmark,
  modalBenchmarkStatus,
  overseeModalBenchmarks
} from "./runner.js";

const usage =
  "usage: ultrafuzz-modal <build|launch|status|collect|overseer> [--config path] [--model slug] [--state path]";

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  if (command === "build") {
    const result = await buildModalImage({
      appName: option(argv, "--app"),
      imageName: option(argv, "--image"),
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
      statePath: option(argv, "--state")
    });
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (command === "status") {
    const rows = await modalBenchmarkStatus({ statePath: requiredOption(argv, "--state") });
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (command === "collect") {
    await collectModalBenchmark({
      statePath: requiredOption(argv, "--state"),
      outputDir: path.resolve(option(argv, "--output") ?? ".ultrafuzz/modal/results")
    });
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
      configPaths.length !== recoveryStatePaths.length
    ) {
      throw new Error("overseer requires matching repeated --config, --state, and --recovery-state options");
    }
    await overseeModalBenchmarks({
      jobs: configPaths.map((configPath, index) => ({
        configPath,
        statePath: statePaths[index]!,
        recoveryStatePath: recoveryStatePaths[index]!,
        ...(recoveryImages[index] === undefined ? {} : { recoveryImage: recoveryImages[index] })
      })),
      pollMs: pollSeconds(argv) * 1000
    });
    return;
  }
  throw new Error(usage);
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

function pollSeconds(argv: string[]): number {
  const value = option(argv, "--poll-seconds");
  if (value === undefined) return 60;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 1) throw new Error("--poll-seconds must be a positive number");
  return seconds;
}

await main();
