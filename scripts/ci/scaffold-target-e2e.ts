#!/usr/bin/env bun
/**
 * Scaffold the deterministic target E2E fixture into a cloned target repository.
 *
 * Runs under Bun (which executes TypeScript directly); only Node.js built-ins
 * are used so the script stays dependency-free.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const RENDERED_FIXTURE_FILES = [
  "ultrafuzz.toml",
  ".ultrafuzz/topology.yml",
  ".ultrafuzz/prompts/setup/project-discovery.md",
  ".ultrafuzz/prompts/strategies/signal-analysis.md",
  ".ultrafuzz/prompts/review/final-report.md"
];

interface Args {
  targetRoot: string;
  nodeTimeout: number;
  agentRef: string;
  modelName: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function parsePositiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer, got: ${raw}`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  let targetRoot: string | null = null;
  let nodeTimeout = parsePositiveInteger(
    process.env.ULTRAFUZZ_E2E_NODE_TIMEOUT_SECONDS ?? "420",
    "ULTRAFUZZ_E2E_NODE_TIMEOUT_SECONDS"
  );
  let agentRef = process.env.ULTRAFUZZ_E2E_AGENT ?? "CodexAgent";
  let modelName = process.env.ULTRAFUZZ_E2E_MODEL ?? "gpt-5.5";

  const usage =
    "usage: scaffold-target-e2e.ts <target_root> [--node-timeout <seconds>] [--agent-ref <ref>] [--model-name <name>]";
  const queue = [...argv];
  while (queue.length > 0) {
    const argument = queue.shift() as string;
    const [flag, inlineValue] =
      argument.startsWith("--") && argument.includes("=")
        ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)]
        : [argument, undefined];
    const takeValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const value = queue.shift();
      if (value === undefined) {
        fail(`missing value for ${flag}\n${usage}`);
      }
      return value;
    };
    switch (flag) {
      case "--node-timeout":
        nodeTimeout = parsePositiveInteger(takeValue(), "--node-timeout");
        break;
      case "--agent-ref":
        agentRef = takeValue();
        break;
      case "--model-name":
        modelName = takeValue();
        break;
      default:
        if (flag.startsWith("--")) {
          fail(`unknown option: ${flag}\n${usage}`);
        }
        if (targetRoot !== null) {
          fail(`unexpected extra positional argument: ${flag}\n${usage}`);
        }
        targetRoot = flag;
    }
  }
  if (targetRoot === null) {
    fail(usage);
  }
  return { targetRoot, nodeTimeout, agentRef, modelName };
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fixtureDir = join(scriptDir, "target-e2e-fixture");
  const artifactHelper = join(scriptDir, "target-e2e-artifacts.ts");

  if (!isDirectory(args.targetRoot)) {
    fail(`Target repository root does not exist: ${args.targetRoot}`);
  }
  if (!isDirectory(fixtureDir)) {
    fail(`CI fixture directory not found: ${fixtureDir}`);
  }
  if (!isFile(artifactHelper)) {
    fail(`CI artifact helper not found: ${artifactHelper}`);
  }

  const values: Record<string, string> = {
    __NODE_TIMEOUT__: String(args.nodeTimeout),
    __AGENT_REF__: args.agentRef,
    __MODEL_NAME__: args.modelName
  };

  const ciDir = join(args.targetRoot, ".ultrafuzz", "ci");
  mkdirSync(ciDir, { recursive: true });
  copyFileSync(artifactHelper, join(ciDir, "target-e2e-artifacts.ts"));

  for (const fixtureFile of RENDERED_FIXTURE_FILES) {
    const source = join(fixtureDir, fixtureFile);
    const destination = join(args.targetRoot, fixtureFile);
    mkdirSync(dirname(destination), { recursive: true });
    let text = readFileSync(source, "utf-8");
    for (const [placeholder, replacement] of Object.entries(values)) {
      text = text.split(placeholder).join(replacement);
    }
    writeFileSync(destination, text, "utf-8");
  }

  return 0;
}

process.exit(main(process.argv.slice(2)));
