import fs from "node:fs";
import path from "node:path";

import { createEventQueryFacadeInputs } from "./events.js";
import { createInitialRunState, type NodeStateInput, type RunState, writeRunState } from "./state.js";
import {
  assertNoSymlinkComponents,
  assertPathInside,
  ensureSafeDirectory,
  safeResolveInside,
  validateSafeId,
  writeFileDurable,
  writeJsonDurable
} from "./safe-paths.js";

export const RUN_LAYOUT_SCHEMA_VERSION = "1.0";

export interface RunLayout {
  schemaVersion: string;
  runId: string;
  root: string;
  artifactsDir: string;
  workspacesDir: string;
  reviewDir: string;
  runMetadataPath: string;
  sourceRunPath: string;
  resolvedConfigPath: string;
  configRedactionsPath: string;
  graphPath: string;
  graphFingerprintPath: string;
  statePath: string;
  eventsPath: string;
  usageLedgerPath: string;
  pricingCatalogsDir: string;
  attemptLedgerPath: string;
  eventsIndexDir: string;
  workspacesPath: string;
}

export interface CreateRunLayoutInput {
  projectRoot?: string;
  outputRoot?: string;
  runId: string;
  sourceRunId?: string;
  createdAt?: string;
  resolvedConfigToml?: string;
  configRedactions?: unknown;
  graph?: unknown;
  graphFingerprint?: string;
  configFingerprint?: string;
  state?: RunState;
  stateNodes?: NodeStateInput[];
  runMetadata?: Record<string, unknown>;
  overwrite?: boolean;
}

export function createRunLayout(input: CreateRunLayoutInput): RunLayout {
  const runId = validateSafeId(input.runId, "run ID");
  const runsRoot =
    input.outputRoot === undefined
      ? path.resolve(input.projectRoot ?? process.cwd(), ".ultrafuzz", "runs")
      : path.resolve(input.outputRoot);
  const root = path.resolve(runsRoot, runId);
  assertPathInside(runsRoot, root, "run root");
  const guardRoot =
    input.projectRoot === undefined ? nearestExistingAncestor(runsRoot) : path.resolve(input.projectRoot);
  if (input.projectRoot !== undefined) {
    assertPathInside(guardRoot, runsRoot, "runs root");
  }
  assertNoSymlinkComponents(guardRoot, root, "run root");

  const layout = layoutForRunRoot(root, runId);
  for (const directory of [
    layout.root,
    layout.artifactsDir,
    layout.workspacesDir,
    layout.eventsIndexDir,
    layout.reviewDir,
    layout.pricingCatalogsDir
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const sourceRunId = input.sourceRunId === undefined ? undefined : validateSafeId(input.sourceRunId, "source run ID");
  const state =
    input.state ??
    createInitialRunState({
      runId,
      ...(sourceRunId === undefined ? {} : { sourceRunId }),
      graphFingerprint: input.graphFingerprint,
      configFingerprint: input.configFingerprint,
      createdAt,
      nodes: input.stateNodes
    });

  writeJsonIfNeeded(
    layout.runMetadataPath,
    {
      schema_version: RUN_LAYOUT_SCHEMA_VERSION,
      run_id: runId,
      created_at: createdAt,
      ...(sourceRunId === undefined ? {} : { source_run_id: sourceRunId }),
      ...(input.runMetadata ?? {})
    },
    input.overwrite ?? false
  );
  if (sourceRunId !== undefined) {
    writeJsonIfNeeded(
      layout.sourceRunPath,
      {
        schema_version: RUN_LAYOUT_SCHEMA_VERSION,
        run_id: runId,
        source_run_id: sourceRunId,
        created_at: createdAt
      },
      input.overwrite ?? false
    );
  }
  writeTextIfNeeded(layout.resolvedConfigPath, input.resolvedConfigToml ?? "", input.overwrite ?? false);
  writeJsonIfNeeded(
    layout.configRedactionsPath,
    input.configRedactions ?? { schema_version: RUN_LAYOUT_SCHEMA_VERSION, redactions: [] },
    input.overwrite ?? false
  );
  writeJsonIfNeeded(
    layout.graphPath,
    input.graph ?? { schema_version: RUN_LAYOUT_SCHEMA_VERSION, nodes: [] },
    input.overwrite ?? false
  );
  writeTextIfNeeded(layout.graphFingerprintPath, `${input.graphFingerprint ?? ""}\n`, input.overwrite ?? false);
  if ((input.overwrite ?? false) || !fs.existsSync(layout.statePath)) {
    writeRunState(layout, state);
  }
  if ((input.overwrite ?? false) || !fs.existsSync(layout.eventsPath)) {
    writeFileDurable(layout.eventsPath, "");
  }
  if ((input.overwrite ?? false) || !fs.existsSync(layout.usageLedgerPath)) {
    writeFileDurable(layout.usageLedgerPath, "");
  }
  if ((input.overwrite ?? false) || !fs.existsSync(layout.attemptLedgerPath)) {
    writeFileDurable(layout.attemptLedgerPath, "");
  }
  writeJsonIfNeeded(
    layout.workspacesPath,
    { schema_version: RUN_LAYOUT_SCHEMA_VERSION, run_id: runId, workspaces: [] },
    input.overwrite ?? false
  );
  writeJsonIfNeeded(
    path.join(layout.eventsIndexDir, "query-inputs.json"),
    createEventQueryFacadeInputs(layout),
    input.overwrite ?? false
  );

  return layout;
}

export function layoutForRunRoot(root: string, runId = path.basename(root)): RunLayout {
  const safeRunId = validateSafeId(runId, "run ID");
  const absoluteRoot = path.resolve(root);
  return {
    schemaVersion: RUN_LAYOUT_SCHEMA_VERSION,
    runId: safeRunId,
    root: absoluteRoot,
    artifactsDir: path.join(absoluteRoot, "artifacts"),
    workspacesDir: path.join(absoluteRoot, "workspaces"),
    reviewDir: path.join(absoluteRoot, "review"),
    runMetadataPath: path.join(absoluteRoot, "run.json"),
    sourceRunPath: path.join(absoluteRoot, "source-run.json"),
    resolvedConfigPath: path.join(absoluteRoot, "config.resolved.toml"),
    configRedactionsPath: path.join(absoluteRoot, "config.redactions.json"),
    graphPath: path.join(absoluteRoot, "graph.json"),
    graphFingerprintPath: path.join(absoluteRoot, "graph.fingerprint"),
    statePath: path.join(absoluteRoot, "state.json"),
    eventsPath: path.join(absoluteRoot, "events.jsonl"),
    usageLedgerPath: path.join(absoluteRoot, "usage.jsonl"),
    pricingCatalogsDir: path.join(absoluteRoot, "pricing-catalogs"),
    attemptLedgerPath: path.join(absoluteRoot, "attempts.jsonl"),
    eventsIndexDir: path.join(absoluteRoot, "events.index"),
    workspacesPath: path.join(absoluteRoot, "workspaces.json")
  };
}

export function getPricingCatalogSnapshotPath(
  layout: Pick<RunLayout, "pricingCatalogsDir">,
  catalogSha256: string
): string {
  if (!/^[0-9a-f]{64}$/u.test(catalogSha256)) {
    throw new Error(`pricing catalog digest must be a lowercase SHA-256 value: ${catalogSha256}`);
  }
  return safeResolveInside(layout.pricingCatalogsDir, `${catalogSha256}.json`, "pricing catalog snapshot path");
}

export function getNodeArtifactDir(
  layout: RunLayout,
  concreteNodeId: string,
  options: { create?: boolean } = {}
): string {
  const nodeId = validateSafeId(concreteNodeId, "concrete node ID");
  if (options.create === true) {
    return ensureSafeDirectory(layout.artifactsDir, nodeId);
  }
  return safeResolveInside(layout.artifactsDir, nodeId, "node artifact directory");
}

export function getNodeWorkspaceDir(
  layout: RunLayout,
  concreteNodeId: string,
  options: { create?: boolean } = {}
): string {
  const nodeId = validateSafeId(concreteNodeId, "concrete node ID");
  if (options.create === true) {
    return ensureSafeDirectory(layout.workspacesDir, nodeId);
  }
  return safeResolveInside(layout.workspacesDir, nodeId, "node workspace directory");
}

function writeJsonIfNeeded(filePath: string, value: unknown, overwrite: boolean): void {
  if (!overwrite && fs.existsSync(filePath)) {
    return;
  }
  writeJsonDurable(filePath, value);
}

function writeTextIfNeeded(filePath: string, value: string, overwrite: boolean): void {
  if (!overwrite && fs.existsSync(filePath)) {
    return;
  }
  writeFileDurable(filePath, value);
}

function nearestExistingAncestor(candidate: string): string {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}
