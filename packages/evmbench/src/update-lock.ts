#!/usr/bin/env node

import path from "node:path";

import {
  findUltrafuzzRepoRoot,
  generateEvmbenchDefinition,
  resolvePublicTargetHead,
  verifyEvmbenchDefinition,
  writeEvmbenchDefinition
} from "./definition.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const harnessRoot = requiredOption(args, "--harness");
  const repoRoot = findUltrafuzzRepoRoot();
  const benchmarkDir = path.resolve(option(args, "--benchmark-dir") ?? path.join(repoRoot, "benchmarks", "evmbench"));
  const write = args.includes("--write");
  if (write && args.includes("--check")) throw new Error("--write and --check are mutually exclusive");
  if (write) {
    const definition = await generateEvmbenchDefinition({
      harnessRoot,
      resolveTargetCommit: resolvePublicTargetHead
    });
    writeEvmbenchDefinition(benchmarkDir, definition);
    console.log("Updated the pinned EVMBench definition.");
    return;
  }
  await verifyEvmbenchDefinition({ benchmarkDir, harnessRoot });
  console.log("Verified the pinned EVMBench definition.");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return path.resolve(value);
}

await main();
