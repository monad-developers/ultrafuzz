#!/usr/bin/env node

import { runEvmbench, type EvmbenchRunnerOptions } from "./runner.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "usage: pnpm benchmark:evmbench -- [--split debug|detect-tasks] [--audit id] [--profile smoke|full] [--model id] [--reasoning level] [--concurrency n] [--auth-path file] [--dry-run] [--gold]"
  );
} else {
  const options: EvmbenchRunnerOptions = {
    split: enumOption(args, "--split", ["debug", "detect-tasks"]),
    audit: option(args, "--audit"),
    profile: enumOption(args, "--profile", ["smoke", "full"]),
    model: option(args, "--model"),
    reasoning: option(args, "--reasoning"),
    concurrency: integerOption(args, "--concurrency"),
    harnessRoot: option(args, "--harness"),
    cacheDir: option(args, "--cache-dir"),
    outputDir: option(args, "--output"),
    authPath: option(args, "--auth-path"),
    dryRun: args.includes("--dry-run"),
    gold: args.includes("--gold")
  };
  if (options.audit !== undefined && option(args, "--split") !== undefined) {
    throw new Error("--audit and --split are mutually exclusive");
  }
  const result = await runEvmbench(options);
  console.log(JSON.stringify(result, null, 2));
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function enumOption<const T extends string>(args: string[], name: string, allowed: readonly T[]): T | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function integerOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
