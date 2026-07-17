#!/usr/bin/env node

import path from "node:path";

import type { ModalLaunchMode, ModelProvider } from "./defaults.js";
import { buildModalImage, collectModalBenchmark, launchModalBenchmark, modalBenchmarkStatus } from "./runner.js";

const usage =
  "usage: ultrafuzz-modal <build|launch|status|collect|smoke> [--config path] [--model slug] [--state path] [--mode resume|fresh] [--fresh] [--provider openai|anthropic]";

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
  if (command === "collect") {
    await collectModalBenchmark({
      statePath: requiredOption(argv, "--state"),
      outputDir: path.resolve(option(argv, "--output") ?? ".ultrafuzz/modal/results")
    });
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
  if (value !== "openai" && value !== "anthropic") throw new Error("--provider must be openai or anthropic");
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

await main();
