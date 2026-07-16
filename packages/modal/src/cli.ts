#!/usr/bin/env node

import path from "node:path";

import { buildModalImage, collectModalBenchmark, launchModalBenchmark, modalBenchmarkStatus } from "./runner.js";

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
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
      conditionIds: options(argv, "--condition"),
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
  throw new Error(
    "usage: ultrafuzz-modal <build|launch|status|collect> [--config path] [--model slug] [--condition id] [--state path]"
  );
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

await main();
