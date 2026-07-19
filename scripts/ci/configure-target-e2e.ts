#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

const EXCLUDED_SMOKE_NODES = new Set([
  "differential-library-tests",
  "stateful-invariant-setup",
  "stateful-invariant-handlers",
  "stateful-invariant-coverage",
  "stateful-invariant-implement-properties",
  "stateful-invariant-recon-campaign",
  "differential-oracle-planner",
  "reference-harness-author",
  "reference-and-lane-auditor",
  "differential-lane-author",
  "differential-red-triage",
  "differential-repair-and-report-review",
  "dynamic-strategy-generator"
]);

const MODEL_PROFILE = "target-e2e";
const MODEL_NAME = "gpt-5.6-luna";
const REASONING_EFFORT = "high";

interface TopologyNode {
  id: string;
  kind?: string;
  prompt?: string;
  depends_on: string[];
  model_profiles?: string[];
}

interface TopologyDocument {
  version: number;
  defaults: { strategy_loops: number };
  groups?: Record<
    string,
    {
      defaults?: {
        loops?: number;
        timeout_seconds?: number;
        model_profiles?: string[];
      };
    }
  >;
  nodes: TopologyNode[];
}

export function configureTargetE2e(targetRoot: string, nodeTimeoutSeconds: number): void {
  if (!Number.isInteger(nodeTimeoutSeconds) || nodeTimeoutSeconds <= 0) {
    throw new Error("node timeout must be a positive integer");
  }

  const topologyPath = resolve(targetRoot, ".ultrafuzz", "topology.yml");
  const configPath = resolve(targetRoot, "ultrafuzz.toml");
  if (!existsSync(topologyPath) || !existsSync(configPath)) {
    throw new Error("target must be initialized before configuring the smoke topology");
  }

  const parsed: unknown = parse(readFileSync(topologyPath, "utf-8"));
  const topology = requireTopology(parsed);
  const ids = new Set(topology.nodes.map((node) => node.id));
  const missingExcluded = [...EXCLUDED_SMOKE_NODES].filter((id) => !ids.has(id));
  if (missingExcluded.length > 0) {
    throw new Error(`production topology is missing expected smoke exclusions: ${missingExcluded.join(", ")}`);
  }

  topology.defaults.strategy_loops = 1;
  for (const group of Object.values(topology.groups ?? {})) {
    if (group.defaults?.loops !== undefined) {
      group.defaults.loops = 1;
    }
    if (group.defaults?.timeout_seconds !== undefined) {
      group.defaults.timeout_seconds = nodeTimeoutSeconds;
    }
    if (group.defaults?.model_profiles !== undefined) {
      group.defaults.model_profiles = [MODEL_PROFILE];
    }
  }

  topology.nodes = topology.nodes
    .filter((node) => !EXCLUDED_SMOKE_NODES.has(node.id))
    .map((node) => ({
      ...node,
      depends_on: node.depends_on.filter((dependency) => !EXCLUDED_SMOKE_NODES.has(dependency)),
      ...(node.model_profiles === undefined ? {} : { model_profiles: [MODEL_PROFILE] })
    }));

  writeFileSync(topologyPath, stringify(topology, { lineWidth: 120 }), "utf-8");
  writeFileSync(configPath, smokeConfig(nodeTimeoutSeconds), "utf-8");
  rewriteReviewPrompts(resolve(targetRoot, ".ultrafuzz", "prompts"));
}

function rewriteReviewPrompts(promptsRoot: string): void {
  for (const relativePath of ["review/dedupe-findings.md", "review/aggregate-test-files.md"]) {
    const path = join(promptsRoot, relativePath);
    if (!existsSync(path)) continue;

    let content = readFileSync(path, "utf-8");
    for (const nodeId of EXCLUDED_SMOKE_NODES) {
      const escapedNodeId = escapeRegExp(nodeId);
      content = content
        .replace(new RegExp(`(?:^|\\n)[^\\n]*:\\n\\{\\{artifact_path:${escapedNodeId}\\}\\}[^\\n]*\\n`, "gu"), "\n")
        .replace(new RegExp(`(?:^|\\n)\\{\\{artifact_handoff:${escapedNodeId}\\}\\}\\n`, "gu"), "\n");
    }
    content = content
      .replace(
        /\nAlso inspect the Dynamic strategy generator outputs before deduping:\n+(?=Then, build a stable dedupe key)/u,
        "\n"
      )
      .replace(/\n{3,}/gu, "\n\n");
    writeFileSync(path, content, "utf-8");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function requireTopology(value: unknown): TopologyDocument {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.defaults) || !Array.isArray(value.nodes)) {
    throw new Error("production topology has an unsupported shape");
  }
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || !Array.isArray(node.depends_on)) {
      throw new Error("production topology contains an invalid node");
    }
  }
  return value as unknown as TopologyDocument;
}

function smokeConfig(nodeTimeoutSeconds: number): string {
  return `schema_version = "1.0"
dynamic_strategies_enumerator = 1

[project]
repo = "."

[run]
output_dir = ".ultrafuzz/runs"
max_parallel_agents = 4
max_parallel_nodes = 4
keep_workspaces = false
workspace_mode = "git-worktree"
default_timeout_seconds = ${nodeTimeoutSeconds}
workflow_deadline_seconds = 21600
controller_lease_seconds = 30

[models]
default = "${MODEL_PROFILE}"

[models.${MODEL_PROFILE}]
agent = "CodexAgent"
model = "${MODEL_NAME}"
reasoning = "${REASONING_EFFORT}"
timeout_seconds = ${nodeTimeoutSeconds}

[permissions]
trust_model = "skip-permissions"
prompt_review_required = true
materialize_outputs_as_unstaged = true
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function main(argv: string[]): number {
  if (argv.length !== 2) {
    throw new Error("usage: configure-target-e2e.ts <target_root> <node_timeout_seconds>");
  }
  configureTargetE2e(argv[0] as string, Number(argv[1]));
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
