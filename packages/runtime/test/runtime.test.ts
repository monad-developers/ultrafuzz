import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

import type { RunState } from "@ultrafuzz/artifacts";
import { CACHE_MANIFEST_FILE, RUN_REFERENCE_MANIFEST_FILE } from "@ultrafuzz/references";

import {
  assertSmithersPackageManifest,
  KIMI_CODE_VERSION,
  SMITHERS_ORCHESTRATOR_BIN_PATH,
  SMITHERS_ORCHESTRATOR_VERSION
} from "../src/smithers-package.js";

import {
  ARTIFACT_RECONCILIATION_CLOCK_SKEW_MS,
  ARTIFACT_RECONCILIATION_GRACE_MS,
  ARTIFACT_RECONCILIATION_MAX_ATTEMPTS,
  ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS,
  forkRun,
  getRunHealth,
  getRunStatus,
  initProject,
  listRuns,
  planRun,
  pauseRun,
  replayRun,
  repairMissingRenderedPromptsForRun,
  resumeRun,
  startRun,
  syncRun,
  validateProject
} from "../src/index.js";

const runningUnderBun = typeof process.versions.bun === "string";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-"));
}

async function loadGeneratedKimiAgent(project: string): Promise<{
  KimiCode029Agent: new (options: Record<string, unknown>) => {
    issuedSessionId?: string;
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      args: string[];
      env?: Record<string, string>;
      cleanup?: () => Promise<void>;
      benignStderrPatterns: RegExp[];
    }>;
    createOutputInterpreter(): {
      onStdoutLine?: (line: string) => unknown;
      onStderrLine?: (line: string) => unknown;
      onExit?: (result: unknown) => unknown;
    };
  };
}> {
  const fixture = path.join(project, "kimi-agent-executable-test");
  fs.mkdirSync(fixture, { recursive: true });
  const agentsDir = path.join(project, ".smithers", "agents");
  const smithersUrl = pathToFileURL(
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smithers-orchestrator", "src", "index.js"))
  ).href;
  const transpile = (source: string): string =>
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      }
    }).outputText;
  const kimiSource = fs
    .readFileSync(path.join(agentsDir, "kimi.ts"), "utf8")
    .replace('from "smithers-orchestrator"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./toml"', 'from "./toml.mjs"');
  fs.writeFileSync(path.join(fixture, "kimi.mjs"), transpile(kimiSource), "utf8");
  fs.writeFileSync(
    path.join(fixture, "toml.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "toml.ts"), "utf8")),
    "utf8"
  );
  const kimiModule = (await import(pathToFileURL(path.join(fixture, "kimi.mjs")).href)) as {
    KimiCode029Agent: new (options: Record<string, unknown>) => {
      issuedSessionId?: string;
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        args: string[];
        env?: Record<string, string>;
        cleanup?: () => Promise<void>;
        benignStderrPatterns: RegExp[];
      }>;
      createOutputInterpreter(): {
        onStdoutLine?: (line: string) => unknown;
        onStderrLine?: (line: string) => unknown;
        onExit?: (result: unknown) => unknown;
      };
    };
  };
  return { KimiCode029Agent: kimiModule.KimiCode029Agent };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function fakeInstalledSmithersPaths(project: string): {
  packageRoot: string;
  packageJson: string;
  target: string;
  shim: string;
} {
  const packageRoot = path.join(project, ".smithers", "node_modules", "smithers-orchestrator");
  return {
    packageRoot,
    packageJson: path.join(packageRoot, "package.json"),
    target: path.join(packageRoot, ...SMITHERS_ORCHESTRATOR_BIN_PATH.split("/")),
    shim: path.join(project, ".smithers", "node_modules", ".bin", "smithers")
  };
}

function writeFakeInstalledSmithers(
  project: string,
  input: { version?: string; shimTarget?: string; binTarget?: string } = {}
): ReturnType<typeof fakeInstalledSmithersPaths> {
  const paths = fakeInstalledSmithersPaths(project);
  fs.mkdirSync(path.dirname(paths.target), { recursive: true });
  fs.mkdirSync(path.dirname(paths.shim), { recursive: true });
  fs.writeFileSync(
    paths.packageJson,
    `${JSON.stringify({
      name: "smithers-orchestrator",
      version: input.version ?? SMITHERS_ORCHESTRATOR_VERSION,
      bin: { smithers: input.binTarget ?? SMITHERS_ORCHESTRATOR_BIN_PATH }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    paths.target,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SMITHERS_FAKE_LOG\"\nprintf '%s\\n' '{\"ok\":true}'\n",
    "utf8"
  );
  fs.chmodSync(paths.target, 0o755);
  fs.rmSync(paths.shim, { force: true });
  fs.symlinkSync(path.relative(path.dirname(paths.shim), input.shimTarget ?? paths.target), paths.shim);
  return paths;
}

function writeFakePnpmInstalledSmithers(project: string): ReturnType<typeof fakeInstalledSmithersPaths> {
  const paths = fakeInstalledSmithersPaths(project);
  const storeRoot = path.join(
    project,
    ".smithers",
    "node_modules",
    ".pnpm",
    "smithers-orchestrator@unit",
    "node_modules",
    "smithers-orchestrator"
  );
  const storePackageJson = path.join(storeRoot, "package.json");
  const storeTarget = path.join(storeRoot, ...SMITHERS_ORCHESTRATOR_BIN_PATH.split("/"));
  fs.mkdirSync(path.dirname(storeTarget), { recursive: true });
  fs.mkdirSync(path.dirname(paths.shim), { recursive: true });
  fs.writeFileSync(
    storePackageJson,
    `${JSON.stringify({
      name: "smithers-orchestrator",
      version: SMITHERS_ORCHESTRATOR_VERSION,
      bin: { smithers: SMITHERS_ORCHESTRATOR_BIN_PATH }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    storeTarget,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SMITHERS_FAKE_LOG\"\nprintf '%s\\n' '{\"ok\":true}'\n",
    "utf8"
  );
  fs.chmodSync(storeTarget, 0o755);
  fs.symlinkSync(path.relative(path.dirname(paths.packageRoot), storeRoot), paths.packageRoot);
  const linkedTarget = path.relative(path.dirname(paths.shim), paths.target).split(path.sep).join("/");
  fs.writeFileSync(paths.shim, `#!/bin/sh\nbasedir=\${0%/*}\nexec "$basedir/${linkedTarget}" "$@"\n`, "utf8");
  fs.chmodSync(paths.shim, 0o755);
  return paths;
}

function writeFakeNpmInstaller(project: string): {
  binDir: string;
  npmLogPath: string;
  smithersLogPath: string;
} {
  const binDir = path.join(project, "fake-bin");
  const npm = path.join(binDir, "npm");
  const npmLogPath = path.join(project, "npm-install.log");
  const smithersLogPath = path.join(project, "local-smithers.log");
  const paths = fakeInstalledSmithersPaths(project);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    npm,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuote(npmLogPath)}`,
      `mkdir -p ${shellQuote(path.dirname(paths.target))} ${shellQuote(path.dirname(paths.shim))}`,
      `cat > ${shellQuote(paths.packageJson)} <<'EOS'`,
      JSON.stringify({
        name: "smithers-orchestrator",
        version: SMITHERS_ORCHESTRATOR_VERSION,
        bin: { smithers: SMITHERS_ORCHESTRATOR_BIN_PATH }
      }),
      "EOS",
      `cat > ${shellQuote(paths.target)} <<'EOS'`,
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      "printf '%s\\n' '{\"ok\":true}'",
      "EOS",
      `chmod +x ${shellQuote(paths.target)}`,
      `rm -f ${shellQuote(paths.shim)}`,
      `ln -s ${shellQuote(path.relative(path.dirname(paths.shim), paths.target))} ${shellQuote(paths.shim)}`,
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(npm, 0o755);
  return { binDir, npmLogPath, smithersLogPath };
}

function fakeSmithersEnv(project: string): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_LOG" ]; then',
      '  printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_ENV_LOG" ]; then',
      '  printf \'%s|%s|%s\\n\' "$OPENAI_API_KEY" "$AWS_SECRET_ACCESS_KEY" "$FOUNDRY_PROFILE" > "$SMITHERS_FAKE_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_CLOUD_ENV_LOG" ]; then',
      '  printf \'%s|%s\\n\' "$UFZ_PROVIDER_ONE" "$UFZ_PROVIDER_TWO" > "$SMITHERS_FAKE_CLOUD_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_KIMI_ENV_LOG" ]; then',
      '  printf \'%s|%s|%s|%s|%s|%s\\n\' "$KIMI_API_KEY" "$MOONSHOT_API_KEY" "$KIMI_BASE_URL" "$ULTRAFUZZ_KIMI_SHARED_AUTH_HOME" "$ULTRAFUZZ_KIMI_SESSION_HOME" "$ULTRAFUZZ_MODAL_REMOTE_ROOT" > "$SMITHERS_FAKE_KIMI_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_CONTEXT_LOG" ]; then',
      '  printf \'%s|%s|%s|%s|%s|%s\\n\' "$SMITHERS_RUN_ID" "$SMITHERS_NODE_ID" "$SMITHERS_ATTEMPT" "$SMITHERS_ITERATION" "$SMITHERS_CLI_SRC_DIR" "$SMITHERS_SNAPSHOT_SOCK" > "$SMITHERS_FAKE_CONTEXT_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_KEEP_WORKTREES_LOG" ]; then',
      '  printf \'%s\\n\' "$SMITHERS_KEEP_WORKTREES" > "$SMITHERS_FAKE_KEEP_WORKTREES_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_FORGE_GUARD_LOG" ]; then',
      '  command -v forge > "$SMITHERS_FAKE_FORGE_GUARD_LOG"',
      "fi",
      'case "$1" in',
      "  fork)",
      "    printf '%s\\n' '{\"forkedRunId\":\"ultrafuzz-lifecycle-run-forked\"}'",
      "    ;;",
      "  replay)",
      "    printf '%s\\n' '{\"forkedRunId\":\"ultrafuzz-lifecycle-run-replayed\"}'",
      "    ;;",
      "  pause)",
      '    if [ -n "$SMITHERS_FAKE_PAUSE_EMPTY_SUCCESS" ]; then',
      "      exit 0",
      '    elif [ -n "$SMITHERS_FAKE_ALREADY_PAUSED" ]; then',
      "      printf '%s\\n' '{\"status\":\"paused\"}'",
      "    else",
      "      printf '%s\\n' '{\"status\":\"pause-requested\"}'",
      "      exit 2",
      "    fi",
      "    ;;",
      "  status)",
      '    printf \'%s\\n\' \'{"data":{"status":"running","verdict":"running-healthy","reason":"1 running, 2 finished in last 10m","counts":{"finished":2,"inProgress":1,"pending":3,"failed":0,"waitingApproval":0,"waitingEvent":0,"waitingTimer":0,"skipped":0,"other":0,"total":6},"modelMix":[{"engine":"codex","model":"gpt-test","attempts":3,"quotaParked":false}],"throughput":{"recentFinished":2,"windowMs":600000,"totalFinished":2,"lastFinishedAtMs":1000},"bottleneck":[{"nodeId":"project-discovery","iteration":0,"state":"in-progress","detail":"running 1m"}],"bottleneckOmitted":0,"quota":null,"generatedAtMs":2000}}\'',
      "    ;;",
      "  *)",
      '    printf \'%s\\n\' \'{"ok":true,"smithers":"accepted"}\'',
      "    ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log")
  };
}

function fakeLifecycleSmithersEnv(
  project: string,
  input: { inspect: unknown; events?: string; inspectMarkerPath?: string; timeline?: unknown }
): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const inspectPath = path.join(project, "fake-smithers-inspect.json");
  const eventsPath = path.join(project, "fake-smithers-events.ndjson");
  const timelinePath = path.join(project, "fake-smithers-timeline.json");
  fs.writeFileSync(inspectPath, `${JSON.stringify(input.inspect, null, 2)}\n`, "utf8");
  fs.writeFileSync(eventsPath, input.events ?? "", "utf8");
  fs.writeFileSync(
    timelinePath,
    `${JSON.stringify(input.timeline ?? { timeline: { frames: [] } }, null, 2)}\n`,
    "utf8"
  );
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_LOG" ]; then',
      '  printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      "fi",
      'case "$1" in',
      "  inspect)",
      ...(input.inspectMarkerPath === undefined ? [] : [`    touch ${shellQuote(input.inspectMarkerPath)}`]),
      '    cat "$SMITHERS_FAKE_INSPECT"',
      "    ;;",
      "  cancel)",
      "    printf '%s\\n' '{\"status\":\"cancel-requested\"}'",
      "    exit 2",
      "    ;;",
      "  events)",
      '    cat "$SMITHERS_FAKE_EVENTS"',
      "    ;;",
      "  timeline)",
      '    cat "$SMITHERS_FAKE_TIMELINE"',
      "    ;;",
      "  rewind)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "  up)",
      '    if [ -n "$SMITHERS_FAKE_FAIL_UP" ]; then',
      "      printf '%s\\n' 'fake up failure' >&2",
      "      exit 1",
      "    fi",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "  *)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log"),
    SMITHERS_FAKE_INSPECT: inspectPath,
    SMITHERS_FAKE_EVENTS: eventsPath,
    SMITHERS_FAKE_TIMELINE: timelinePath,
    ULTRAFUZZ_PRICING_CATALOG_URL: "off"
  };
}

function pricingCatalogDataUrl(catalog: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(catalog))}`;
}

function workflowInspect(input: {
  workflowRunId: string;
  status?: string;
  state?: string;
  error?: unknown;
  failedChildKeys?: string[];
  includeVerifierSteps?: boolean;
  steps: Array<{ id: string; state: string; attempt?: number }>;
}): unknown {
  const explicitStepIds = new Set(input.steps.map((step) => step.id));
  const steps =
    input.includeVerifierSteps === false
      ? input.steps
      : input.steps.flatMap((step) => {
          if (!step.id.startsWith("node:") || statusFromTestWorkflowState(step.state) !== "succeeded") {
            return [step];
          }
          const verifierId = `verify:${step.id.slice("node:".length)}`;
          return explicitStepIds.has(verifierId)
            ? [step]
            : [step, { id: verifierId, state: "finished", attempt: step.attempt }];
        });
  return {
    ok: true,
    data: {
      run: {
        id: input.workflowRunId,
        workflow: input.workflowRunId,
        status: input.status ?? "finished",
        ...(input.error === undefined ? {} : { error: input.error }),
        started: "2026-07-03T00:00:00.000Z",
        finished: input.status === "running" ? undefined : "2026-07-03T00:00:02.000Z"
      },
      runState: {
        runId: input.workflowRunId,
        computedAt: "2026-07-03T00:00:03.000Z",
        state: input.state ?? (input.status === "running" ? "running" : "succeeded")
      },
      ...(input.failedChildKeys === undefined
        ? {}
        : { failedChildren: input.failedChildKeys.length, failedChildKeys: input.failedChildKeys }),
      steps
    }
  };
}

function statusFromTestWorkflowState(state: string): "succeeded" | "other" {
  return ["finished", "succeeded", "success", "complete", "completed"].includes(state.toLowerCase())
    ? "succeeded"
    : "other";
}

function workflowEvents(
  workflowRunId: string,
  events: Array<{
    type: string;
    nodeId?: string;
    attempt?: number;
    error?: unknown;
    sequence?: number;
    timestampMs?: number;
    extra?: Record<string, unknown>;
  }>
): string {
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  return `${events
    .map((event, index) => {
      const sequence = event.sequence ?? index;
      const timestampMs = event.timestampMs ?? base + index * 100;
      const payload: Record<string, unknown> = {
        type: event.type,
        runId: workflowRunId,
        timestampMs
      };
      if (event.nodeId !== undefined) {
        payload.nodeId = event.nodeId;
      }
      if (event.attempt !== undefined) {
        payload.attempt = event.attempt;
      }
      if (event.error !== undefined) {
        payload.error = event.error;
      }
      if (event.extra !== undefined) {
        Object.assign(payload, event.extra);
      }
      return JSON.stringify({
        runId: workflowRunId,
        seq: sequence,
        timestampMs,
        type: event.type,
        payload
      });
    })
    .join("\n")}\n`;
}

function writeRequiredArtifactSet(runRoot: string, nodeId: string, required: string[]): void {
  const artifactDir = path.join(runRoot, "artifacts", nodeId);
  for (const relative of required) {
    const filePath = path.join(artifactDir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const contents = relative.endsWith(".json")
      ? JSON.stringify([
          {
            schema_version: "1.0",
            id: `finding-${nodeId}`,
            title: "Candidate issue",
            status: "candidate",
            severity_guess: "medium",
            confidence: "medium",
            summary: "The generated evidence needs review."
          }
        ])
      : `artifact for ${nodeId}\n`;
    fs.writeFileSync(filePath, contents, "utf8");
  }
}

function writeSmallTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@1
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

function writeOutOfOrderTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: actors-flows
    kind: agentic
    prompt: setup/actors-flows.md
    depends_on:
      - project-discovery
    outputs:
      - path: setup/actors-flows.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - actors-flows
`,
    "utf8"
  );
}

function writeReferenceTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
groups:
  setup:
    label: Setup
  references:
    label: References
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: reference-properties-example
    kind: reference
    reference: properties.example
    group: references
    depends_on:
      - __start__
    outputs:
      - path: references/example.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: ${RUN_REFERENCE_MANIFEST_FILE}
        contract: ultrafuzz/json-object@1
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    group: setup
    depends_on:
      - reference-properties-example
    outputs:
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@1
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
    `---
id: project-discovery
display_name: Project Discovery
---

Reference:
{{artifact_handoff:reference-properties-example}}

Write output to {{artifact_path}}/setup/project-discovery.md and findings to {{output_findings_path}}.
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "references.yml"),
    `version: 1
references:
  properties.example:
    provider: github
    repo: example/repo
    commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    paths:
      - README.md
      - src/Props.sol
    resolved_at: "2026-06-23T00:00:00Z"
`,
    "utf8"
  );
}

function writeReferenceCache(xdgCacheHome: string): void {
  const cacheDir = path.join(
    xdgCacheHome,
    "ultrafuzz",
    "references",
    "github",
    "example",
    "repo",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  );
  const files: Array<{ path: string; size_bytes: number; sha256: string }> = [];
  for (const [relativePath, contents] of [
    ["README.md", "# Example Reference\n"],
    ["src/Props.sol", "contract Props {}\n"]
  ] as const) {
    const filePath = path.join(cacheDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
    files.push({
      path: relativePath,
      size_bytes: fs.statSync(filePath).size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
    });
  }
  fs.writeFileSync(
    path.join(cacheDir, CACHE_MANIFEST_FILE),
    `${JSON.stringify(
      {
        schema_version: "1.0",
        provider: "github",
        repo: "example/repo",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fetched_at: "2026-06-23T00:00:00Z",
        files
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function writeFanoutProject(project: string): void {
  fs.mkdirSync(path.join(project, ".ultrafuzz", "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(project, ".ultrafuzz", "prompts", "setup"), { recursive: true });
  fs.mkdirSync(path.join(project, ".ultrafuzz", "prompts", "strategies"), { recursive: true });
  fs.mkdirSync(path.join(project, ".smithers", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".smithers", "agents", "index.ts"),
    "export const CodexAgent = {};\nexport const ClaudeAgent = {};\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, "ultrafuzz.toml"),
    `schema_version = "1.0"

[project]
repo = "."

[run]
output_dir = ".ultrafuzz/runs"

[models]
default = "fast"

[models.fast]
agent = "CodexAgent"
model = "gpt-test-fast"

[models.deep]
agent = "ClaudeAgent"
model = "gpt-test-deep"
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    prompt: setup/project-discovery.md
    model_profiles:
      - fast
      - deep
    depends_on:
      - __start__
    outputs:
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@1
  - id: signal-analysis
    prompt: strategies/target-signal.md
    model_profiles:
      - fast
      - deep
    depends_on:
      - project-discovery
    outputs:
      - path: signal-analysis.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@1
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - signal-analysis
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
    `---
id: project-discovery
display_name: Project Discovery
---

Strategy: {{strategy}}
Current artifact dir: {{artifact_path}}
Findings: {{output_findings_path}}
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "strategies", "target-signal.md"),
    `---
id: target-signal
display_name: Target Signal
---

Ancestor snapshots:
{{artifact_path:project-discovery}}/setup/project-discovery.md

Current findings: {{output_findings_path}}
`,
    "utf8"
  );
}

test("init preserves existing project-owned files and validate exposes launch posture", async () => {
  const project = tempProject();
  fs.writeFileSync(path.join(project, "ultrafuzz.toml"), "# custom\n", "utf8");

  const init = initProject({ projectRoot: project });
  assert.equal(init.ok, true);
  assert.equal(init.value?.preserved.includes("ultrafuzz.toml"), true);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "topology.yml")), true);
  assert.equal(fs.existsSync(path.join(project, "topology.yml")), false);
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/index.ts")), true);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz/prompts/setup/project-discovery.md")), true);
  const smithersPackage = JSON.parse(fs.readFileSync(path.join(project, ".smithers/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(smithersPackage.dependencies?.["@moonshot-ai/kimi-code"], KIMI_CODE_VERSION);
  assert.equal(smithersPackage.dependencies?.["smithers-orchestrator"], SMITHERS_ORCHESTRATOR_VERSION);
  const codexAgentText = fs.readFileSync(path.join(project, ".smithers/agents/codex.ts"), "utf8");
  assert.doesNotMatch(codexAgentText, /cwd:\s*process\.cwd/);
  assert.doesNotMatch(codexAgentText, /apiKey:\s*process\.env\.OPENAI_API_KEY/);
  assert.match(codexAgentText, /ultrafuzz\.toml/);
  assert.match(codexAgentText, /codexAuthOptions/);
  // The TOML parser is shared, so a fix reaches every backend at once.
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/toml.ts")), true);
  const tomlHelperText = fs.readFileSync(path.join(project, ".smithers/agents/toml.ts"), "utf8");
  assert.match(codexAgentText, /import \{ readStringTable, stringField \} from ".\/toml";/);
  assert.doesNotMatch(codexAgentText, /function readStringTable/);
  // TOML's \UXXXXXXXX has no JSON equivalent, so values are not JSON.parse'd.
  assert.doesNotMatch(tomlHelperText, /JSON\.parse/);
  assert.match(tomlHelperText, /escape !== "u" && escape !== "U"/);
  assert.match(codexAgentText, /const apiKey = requiredEnv/);
  assert.match(codexAgentText, /return { apiKey, env: { CODEX_API_KEY: apiKey } }/);
  assert.match(codexAgentText, /env: { OPENAI_API_KEY: "", CODEX_API_KEY: "" }/);
  assert.match(codexAgentText, /createCodexAgent/);
  assert.match(codexAgentText, /model_reasoning_effort:\s*options\.reasoningEffort/);
  assert.match(codexAgentText, /addDir:\s*options\.addDir/);
  assert.match(codexAgentText, /sandbox:\s*"workspace-write"/);
  assert.doesNotMatch(codexAgentText, /model:\s*"gpt-5\.5"/);

  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/claude.ts")), true);
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/kimi.ts")), true);
  const agentsIndexText = fs.readFileSync(path.join(project, ".smithers/agents/index.ts"), "utf8");
  assert.match(agentsIndexText, /export \{ createCodexAgent \} from ".\/codex";/);
  assert.match(agentsIndexText, /export \{ createClaudeAgent \} from ".\/claude";/);
  assert.match(agentsIndexText, /export \{ createKimiAgent \} from ".\/kimi";/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*ClaudeAgent: createClaudeAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*CodexAgent: createCodexAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*KimiAgent: createKimiAgent/);
  // Importing the registry must not construct any agent: doing so reads that
  // agent's auth and fails a project that only uses the other backend.
  assert.doesNotMatch(agentsIndexText, /=\s*create(Codex|Claude|Kimi)Agent\(\)/);
  assert.doesNotMatch(codexAgentText, /=\s*createCodexAgent\(\)/);
  const claudeAgentText = fs.readFileSync(path.join(project, ".smithers/agents/claude.ts"), "utf8");
  assert.match(claudeAgentText, /ClaudeCodeAgent/);
  assert.match(claudeAgentText, /createClaudeAgent/);
  assert.match(claudeAgentText, /permissionMode:\s*"bypassPermissions"/);
  assert.match(claudeAgentText, /extraArgs:\s*\["--effort",\s*options\.reasoningEffort\]/);
  assert.match(claudeAgentText, /claudeAuthOptions/);
  assert.match(claudeAgentText, /ANTHROPIC_API_KEY/);
  assert.match(claudeAgentText, /addDir:\s*options\.addDir/);
  assert.doesNotMatch(claudeAgentText, /apiKey:\s*process\.env\.ANTHROPIC_API_KEY/);
  // The model comes from the resolved model profile, never hard-coded in the template.
  assert.doesNotMatch(claudeAgentText, /model:\s*"claude-[\w.-]+"/);
  // skipGitRepoCheck is a CodexAgent option and has no ClaudeCodeAgent equivalent.
  assert.doesNotMatch(claudeAgentText, /skipGitRepoCheck/);
  assert.doesNotMatch(claudeAgentText, /=\s*createClaudeAgent\(\)/);
  assert.match(claudeAgentText, /import \{ readStringTable, stringField \} from ".\/toml";/);
  assert.doesNotMatch(claudeAgentText, /function readStringTable/);
  assert.doesNotMatch(claudeAgentText, /JSON\.parse/);
  const kimiAgentText = fs.readFileSync(path.join(project, ".smithers/agents/kimi.ts"), "utf8");
  assert.match(kimiAgentText, /KimiAgent/);
  assert.match(kimiAgentText, /createKimiAgent/);
  assert.match(kimiAgentText, /KIMI_API_KEY/);
  assert.match(kimiAgentText, /MOONSHOT_API_KEY/);
  assert.match(kimiAgentText, /KIMI_CODE_HOME/);
  assert.match(kimiAgentText, /KIMI_SHARE_DIR/);
  assert.match(kimiAgentText, /--add-dir/);
  assert.match(kimiAgentText, /--prompt/);
  assert.match(kimiAgentText, /--output-format/);
  assert.match(kimiAgentText, /configDir/);
  assert.doesNotMatch(kimiAgentText, /=\s*createKimiAgent\(\)/);
  assert.doesNotMatch(kimiAgentText, /--yolo/);
  assert.doesNotMatch(kimiAgentText, /--auto/);
  assert.doesNotMatch(kimiAgentText, /--print/);
  assert.doesNotMatch(kimiAgentText, /--work-dir/);
  assert.doesNotMatch(kimiAgentText, /--thinking/);
  assert.doesNotMatch(kimiAgentText, /--no-thinking/);
  assert.doesNotMatch(kimiAgentText, /final-message-only/);

  const validate = await validateProject({ projectRoot: project, env: {} });
  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));
  assert.equal(validate.value?.policy_posture.trust.status, "pass");
  assert.equal(validate.value?.policy_posture.agents.status, "pass");
  assert.equal(validate.value?.policy_posture.paths.status, "pass");
  assert.equal(validate.value?.resolved_config?.default_agent, "CodexAgent");
  assert.equal(validate.value?.resolved_config?.default_model, "gpt-5.5");
  assert.equal(validate.value?.resolved_config?.default_reasoning, "xhigh");
});

test(
  "generated Kimi adapter narrows the pinned Smithers command to Kimi Code 0.29.1",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = path.join(project, "kimi-source");
    fs.mkdirSync(path.join(sourceConfig, "credentials"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceConfig, "config.toml"),
      `default_model = "kimi-k3"

[thinking]
enabled = false
effort = "high"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
oauth = { storage = "file", key = "oauth/kimi-code" }

[models.kimi-k3]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
support_efforts = [ "low", "high", "max" ]
default_effort = "high"
`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(sourceConfig, "credentials", "kimi-code.json"),
      JSON.stringify({
        access_token: "fresh-token",
        refresh_token: "refresh-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600
      }),
      "utf8"
    );
    fs.writeFileSync(path.join(sourceConfig, "device_id"), "test-device\n", "utf8");
    fs.writeFileSync(path.join(sourceConfig, "session_index.jsonl"), '{"unrelated":true}\n', "utf8");
    fs.mkdirSync(path.join(sourceConfig, "sessions"));
    fs.writeFileSync(path.join(sourceConfig, "sessions", "unrelated.json"), "{}\n", "utf8");

    const options = {
      model: "kimi-k3",
      configDir: sourceConfig,
      ultrafuzzAuthMode: "subscription",
      ultrafuzzReasoningEffort: "max",
      extraArgs: ["--add-dir", "/workspace/extra"]
    };

    const smithersModule = (await import(
      pathToFileURL(
        fs.realpathSync(path.join(process.cwd(), "node_modules", "smithers-orchestrator", "src", "index.js"))
      ).href
    )) as {
      KimiAgent: new (options: Record<string, unknown>) => {
        buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
          args: string[];
          cleanup?: () => Promise<void>;
        }>;
      };
    };
    const pinnedBase = new smithersModule.KimiAgent(options);
    const pinnedCommand = await pinnedBase.buildCommand({
      prompt: "Pinned Smithers contract",
      cwd: "/workspace/target",
      options: {}
    });
    assert.equal(SMITHERS_ORCHESTRATOR_VERSION, "0.31.0");
    assert.ok(pinnedCommand.args.includes("--final-message-only"));
    assert.ok(pinnedCommand.args.includes("--print"));
    assert.ok(pinnedCommand.args.includes("--work-dir"));
    assert.ok(pinnedCommand.args.includes("--thinking"));
    assert.ok(pinnedCommand.args.includes("--session"));
    await pinnedCommand.cleanup?.();

    const agents = [new KimiCode029Agent(options), new KimiCode029Agent(options)];
    const commands = await Promise.all(
      agents.map((agent) => agent.buildCommand({ prompt: "Return the result", cwd: "/workspace/target", options: {} }))
    );

    const isolatedDirs = commands.map((command) => command.env?.KIMI_SHARE_DIR);
    assert.ok(isolatedDirs.every((directory): directory is string => typeof directory === "string"));
    assert.notEqual(isolatedDirs[0], isolatedDirs[1]);

    for (const command of commands) {
      assert.deepEqual(command.args, [
        "--output-format",
        "text",
        "--model",
        "kimi-k3",
        "--add-dir",
        "/workspace/extra",
        "--prompt",
        "Return the result"
      ]);
      assert.equal(command.args.includes("--session"), false);
      assert.equal(command.env?.KIMI_CODE_HOME, command.env?.KIMI_SHARE_DIR);
      const isolated = command.env?.KIMI_SHARE_DIR;
      assert.ok(isolated);
      const isolatedConfigText = fs.readFileSync(path.join(isolated, "config.toml"), "utf8");
      assert.match(isolatedConfigText, /default_effort = "max"/u);
      assert.match(isolatedConfigText, /\[thinking\]\nenabled = true\neffort = "max"/u);
      assert.doesNotMatch(isolatedConfigText, /enabled = false/u);
      assert.doesNotMatch(isolatedConfigText, /effort = "high"/u);
      assert.equal(fs.readFileSync(path.join(isolated, "device_id"), "utf8"), "test-device\n");
      const isolatedCredentials = JSON.parse(
        fs.readFileSync(path.join(isolated, "credentials", "kimi-code.json"), "utf8")
      ) as { access_token?: string };
      assert.equal(isolatedCredentials.access_token, "fresh-token");
      assert.equal(fs.existsSync(path.join(isolated, "session_index.jsonl")), false);
      assert.equal(fs.existsSync(path.join(isolated, "sessions")), false);
      assert.ok(
        command.benignStderrPatterns.some((pattern) => pattern.test("To resume this session: kimi -r session-1234"))
      );
    }

    const previousSharedAuthHome = process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME;
    const sharedAuthHome = path.join(project, "shared-kimi-auth");
    const sourceCredentialPath = path.join(sourceConfig, "credentials", "kimi-code.json");
    fs.mkdirSync(path.join(sharedAuthHome, "credentials"), { recursive: true });
    fs.writeFileSync(
      path.join(sharedAuthHome, "credentials", "kimi-code.json"),
      `${JSON.stringify({
        access_token: "stale-shared-access",
        expires_at: Math.floor(Date.now() / 1000) + 7200,
        expires_in: 7200
      })}\n`,
      "utf8"
    );
    process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME = sharedAuthHome;
    let sharedAuthCommand: Awaited<ReturnType<InstanceType<typeof KimiCode029Agent>["buildCommand"]>> | undefined;
    try {
      sharedAuthCommand = await new KimiCode029Agent(options).buildCommand({
        prompt: "Shared auth",
        cwd: "/workspace/target",
        options: {}
      });
      assert.ok(sharedAuthCommand.env?.KIMI_CODE_HOME);
      const isolatedCredentials = path.join(sharedAuthCommand.env.KIMI_CODE_HOME, "credentials");
      assert.equal(fs.lstatSync(isolatedCredentials).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(isolatedCredentials), path.join(sharedAuthHome, "credentials"));
      assert.equal(fs.existsSync(path.join(sharedAuthHome, "oauth", "kimi-code")), true);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(sharedAuthHome, "credentials", "kimi-code.json"), "utf8")).refresh_token,
        "refresh-token"
      );
    } finally {
      if (previousSharedAuthHome === undefined) delete process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME;
      else process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME = previousSharedAuthHome;
      await sharedAuthCommand?.cleanup?.();
    }

    fs.writeFileSync(
      path.join(sharedAuthHome, "credentials", "kimi-code.json"),
      `${JSON.stringify({
        access_token: "rotated-shared-access",
        refresh_token: "rotated-shared-refresh",
        expires_at: Math.floor(Date.now() / 1000) + 60,
        expires_in: 900
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      sourceCredentialPath,
      `${JSON.stringify({
        access_token: "ancestor-source-access",
        refresh_token: "refresh-token",
        expires_at: Math.floor(Date.now() / 1000) + 7200,
        expires_in: 900
      })}\n`,
      "utf8"
    );
    process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME = sharedAuthHome;
    let rotatedSharedAuthCommand:
      Awaited<ReturnType<InstanceType<typeof KimiCode029Agent>["buildCommand"]>> | undefined;
    try {
      rotatedSharedAuthCommand = await new KimiCode029Agent(options).buildCommand({
        prompt: "Shared rotated auth",
        cwd: "/workspace/target",
        options: {}
      });
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(sharedAuthHome, "credentials", "kimi-code.json"), "utf8")).refresh_token,
        "rotated-shared-refresh"
      );
    } finally {
      if (previousSharedAuthHome === undefined) delete process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME;
      else process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME = previousSharedAuthHome;
      await rotatedSharedAuthCommand?.cleanup?.();
    }

    fs.writeFileSync(
      sourceCredentialPath,
      `${JSON.stringify({
        access_token: "expired-source-access",
        refresh_token: "source-refresh-must-not-rotate",
        expires_at: 1,
        expires_in: 1
      })}\n`,
      "utf8"
    );
    const previousOauthHost = process.env.KIMI_OAUTH_HOST;
    process.env.KIMI_OAUTH_HOST = "https://127.0.0.1:9";
    let expiredSourceCommand: Awaited<ReturnType<InstanceType<typeof KimiCode029Agent>["buildCommand"]>> | undefined;
    try {
      expiredSourceCommand = await new KimiCode029Agent(options).buildCommand({
        prompt: "Expired source should not refresh during build",
        cwd: "/workspace/target",
        options: {}
      });
      assert.equal(expiredSourceCommand.args.includes("--session"), false);
      const sourceToken = JSON.parse(fs.readFileSync(sourceCredentialPath, "utf8")) as { refresh_token?: string };
      assert.equal(sourceToken.refresh_token, "source-refresh-must-not-rotate");
    } finally {
      if (previousOauthHost === undefined) delete process.env.KIMI_OAUTH_HOST;
      else process.env.KIMI_OAUTH_HOST = previousOauthHost;
      await expiredSourceCommand?.cleanup?.();
    }

    const resumeSession = "00000000-0000-0000-0000-000000000105";
    const resumed = await new KimiCode029Agent(options).buildCommand({
      prompt: "Resume",
      cwd: "/workspace/target",
      options: { resumeSession }
    });
    // Assert the full resume argv so the contract also locks the ABSENCE of a
    // conflicting --continue: a real resume must carry only the specific
    // --session, never continue-latest alongside it.
    assert.deepEqual(resumed.args, [
      "--output-format",
      "text",
      "--session",
      resumeSession,
      "--model",
      "kimi-k3",
      "--add-dir",
      "/workspace/extra",
      "--prompt",
      "Resume"
    ]);
    assert.ok(!resumed.args.includes("--continue"));

    const recoverable = new KimiCode029Agent(options);
    const recoveryCommand = await recoverable.buildCommand({
      prompt: "Recover",
      cwd: "/workspace/target",
      options: {}
    });
    assert.ok(recoveryCommand.env?.KIMI_CODE_HOME);
    const cliSession = "00000000-0000-0000-0000-000000000106";
    const recoveryBucket = "wd_target_000000000106";
    const recoverySessionDir = path.join(recoveryCommand.env.KIMI_CODE_HOME, "sessions", recoveryBucket, cliSession);
    fs.mkdirSync(path.join(recoverySessionDir, "agents", "main"), { recursive: true });
    fs.writeFileSync(
      path.join(recoverySessionDir, "state.json"),
      `${JSON.stringify({
        workDir: "/workspace/target",
        agents: {
          main: {
            homedir: path.join(recoverySessionDir, "agents", "main"),
            type: "agent",
            parentAgentId: null
          }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(recoveryCommand.env.KIMI_CODE_HOME, "session_index.jsonl"),
      `${JSON.stringify({
        sessionId: cliSession,
        sessionDir: recoverySessionDir,
        workDir: "/workspace/target"
      })}\n`,
      "utf8"
    );
    const interpreter = recoverable.createOutputInterpreter();
    const completed = interpreter.onExit?.({
      command: "kimi",
      args: recoveryCommand.args,
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false
    }) as Array<{ type?: string; resume?: string }>;
    assert.equal(completed.find((event) => event.type === "completed")?.resume, cliSession);
    await recoveryCommand.cleanup?.();

    const persistedSessionDir = path.join(sourceConfig, "sessions", recoveryBucket, cliSession);
    assert.equal(fs.existsSync(path.join(persistedSessionDir, "state.json")), true);
    const persistedState = JSON.parse(fs.readFileSync(path.join(persistedSessionDir, "state.json"), "utf8")) as {
      agents?: { main?: { homedir?: string } };
    };
    assert.equal(persistedState.agents?.main?.homedir, path.join(persistedSessionDir, "agents", "main"));

    const resumedCaptured = await new KimiCode029Agent(options).buildCommand({
      prompt: "Resume captured",
      cwd: "/workspace/target",
      options: { resumeSession: cliSession }
    });
    assert.ok(resumedCaptured.env?.KIMI_CODE_HOME);
    assert.deepEqual(resumedCaptured.args, [
      "--output-format",
      "text",
      "--session",
      cliSession,
      "--model",
      "kimi-k3",
      "--add-dir",
      "/workspace/extra",
      "--prompt",
      "Resume captured"
    ]);
    const resumedSessionDir = path.join(resumedCaptured.env.KIMI_CODE_HOME, "sessions", recoveryBucket, cliSession);
    assert.equal(fs.existsSync(path.join(resumedSessionDir, "state.json")), true);
    const resumedState = JSON.parse(fs.readFileSync(path.join(resumedSessionDir, "state.json"), "utf8")) as {
      agents?: { main?: { homedir?: string } };
    };
    assert.equal(resumedState.agents?.main?.homedir, path.join(resumedSessionDir, "agents", "main"));

    const abandoned = new KimiCode029Agent(options);
    const abandonedCommand = await abandoned.buildCommand({
      prompt: "Abandoned before cleanup",
      cwd: "/workspace/target",
      options: {}
    });
    assert.ok(abandonedCommand.env?.KIMI_CODE_HOME);
    const abandonedHome = abandonedCommand.env.KIMI_CODE_HOME;
    assert.match(path.relative(sourceConfig, abandonedHome), /^\.ultrafuzz-invocations\//u);
    const crashSession = "00000000-0000-0000-0000-000000000107";
    const crashBucket = "wd_target_000000000107";
    const abandonedSessionDir = path.join(abandonedHome, "sessions", crashBucket, crashSession);
    fs.mkdirSync(path.join(abandonedSessionDir, "agents", "main"), { recursive: true });
    fs.writeFileSync(
      path.join(abandonedSessionDir, "state.json"),
      `${JSON.stringify({
        workDir: "/workspace/target",
        agents: {
          main: {
            homedir: path.join(abandonedSessionDir, "agents", "main"),
            type: "agent",
            parentAgentId: null
          }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(abandonedHome, "session_index.jsonl"),
      `${JSON.stringify({
        sessionId: crashSession,
        sessionDir: abandonedSessionDir,
        workDir: "/workspace/target"
      })}\n`,
      "utf8"
    );
    const crashResumed = await new KimiCode029Agent(options).buildCommand({
      prompt: "Resume abandoned",
      cwd: "/workspace/target",
      options: { resumeSession: crashSession }
    });
    assert.ok(crashResumed.env?.KIMI_CODE_HOME);
    assert.notEqual(crashResumed.env.KIMI_CODE_HOME, abandonedHome);
    const crashResumedSessionDir = path.join(crashResumed.env.KIMI_CODE_HOME, "sessions", crashBucket, crashSession);
    assert.equal(fs.existsSync(path.join(crashResumedSessionDir, "state.json")), true);
    const crashResumedState = JSON.parse(fs.readFileSync(path.join(crashResumedSessionDir, "state.json"), "utf8")) as {
      agents?: { main?: { homedir?: string } };
    };
    assert.equal(crashResumedState.agents?.main?.homedir, path.join(crashResumedSessionDir, "agents", "main"));

    await Promise.all(commands.map(async (command) => command.cleanup?.()));
    await resumed.cleanup?.();
    await resumedCaptured.cleanup?.();
    await abandonedCommand.cleanup?.();
    await crashResumed.cleanup?.();
    assert.ok(isolatedDirs.every((directory) => !fs.existsSync(directory)));

    const apiKeyAgent = new KimiCode029Agent({
      model: "kimi-k3",
      ultrafuzzAuthMode: "api-key",
      ultrafuzzReasoningEffort: "low",
      apiKey: "test-key"
    });
    const apiKeyCommand = await apiKeyAgent.buildCommand({
      prompt: "API key smoke",
      cwd: "/workspace/target",
      options: {}
    });
    const apiKeyConfigDir = apiKeyCommand.env?.KIMI_SHARE_DIR;
    assert.ok(apiKeyConfigDir);
    assert.equal(apiKeyCommand.env?.KIMI_CODE_HOME, apiKeyConfigDir);
    const apiKeyConfig = fs.readFileSync(path.join(apiKeyConfigDir, "config.toml"), "utf8");
    assert.match(apiKeyConfig, /default_model = "kimi-k3"/);
    assert.match(apiKeyConfig, /\[providers\."ultrafuzz-kimi-api"\]\ntype = "kimi"\napi_key = "test-key"/);
    assert.match(apiKeyConfig, /base_url = "https:\/\/api\.moonshot\.ai\/v1"/);
    assert.match(apiKeyConfig, /\[models\."kimi-k3"\]/);
    assert.match(apiKeyConfig, /model = "k3"/);
    assert.match(apiKeyConfig, /default_effort = "low"/);
    assert.match(apiKeyConfig, /\[thinking\]\nenabled = true\neffort = "low"/u);
    assert.equal(fs.existsSync(path.join(apiKeyConfigDir, "credentials")), false);
    assert.equal(fs.existsSync(path.join(apiKeyConfigDir, "device_id")), false);
    await apiKeyCommand.cleanup?.();
    assert.equal(fs.existsSync(apiKeyConfigDir), false);

    await assert.rejects(
      new KimiCode029Agent({
        ...options,
        ultrafuzzReasoningEffort: "xhigh"
      }).buildCommand({
        prompt: "Unsupported effort",
        cwd: "/workspace/target",
        options: {}
      }),
      /reasoning/u
    );
  }
);

const localKimiCode =
  process.env.ULTRAFUZZ_KIMI_BIN ??
  path.join(process.cwd(), "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs");
test(
  "generated Kimi API config and argv match the real Kimi Code 0.29.1 surface",
  { skip: !runningUnderBun || !fs.existsSync(localKimiCode), timeout: 15_000 },
  async () => {
    assert.equal(execFileSync(localKimiCode, ["--version"], { encoding: "utf8" }).trim(), "0.29.1");
    const help = execFileSync(localKimiCode, ["--help"], { encoding: "utf8" });
    for (const option of ["--session", "--continue", "--model", "--prompt", "--output-format", "--add-dir", "--yolo"]) {
      assert.match(help, new RegExp(option, "u"));
    }
    assert.doesNotMatch(help, /--final-message-only/u);
    assert.doesNotMatch(help, /--print/u);
    assert.doesNotMatch(help, /--work-dir/u);
    assert.doesNotMatch(help, /--thinking/u);

    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const previousBaseUrl = process.env.KIMI_BASE_URL;
    process.env.KIMI_BASE_URL = "https://127.0.0.1:9/v1";
    let command: Awaited<ReturnType<InstanceType<typeof KimiCode029Agent>["buildCommand"]>>;
    try {
      command = await new KimiCode029Agent({
        model: "kimi-k3",
        ultrafuzzAuthMode: "api-key",
        ultrafuzzReasoningEffort: "max",
        apiKey: "contract-test-key"
      }).buildCommand({
        prompt: "Contract only",
        cwd: project,
        options: {}
      });
    } finally {
      if (previousBaseUrl === undefined) delete process.env.KIMI_BASE_URL;
      else process.env.KIMI_BASE_URL = previousBaseUrl;
    }
    assert.ok(command.env?.KIMI_CODE_HOME);
    execFileSync(localKimiCode, ["doctor", "config", path.join(command.env.KIMI_CODE_HOME, "config.toml")], {
      encoding: "utf8"
    });
    const parserArgs = [...command.args];
    const modelIndex = parserArgs.indexOf("--model");
    assert.notEqual(modelIndex, -1);
    parserArgs[modelIndex + 1] = "missing-model-for-contract";
    const parsed = spawnSync(localKimiCode, parserArgs, {
      cwd: project,
      env: {
        ...process.env,
        KIMI_CODE_HOME: command.env.KIMI_CODE_HOME,
        KIMI_SHARE_DIR: command.env.KIMI_CODE_HOME,
        NO_PROXY: "127.0.0.1,localhost"
      },
      encoding: "utf8",
      timeout: 5_000
    });
    assert.equal(parsed.error, undefined);
    assert.notEqual(parsed.status, 0);
    assert.match(`${parsed.stdout}\n${parsed.stderr}`, /not configured|config\.invalid/u);
    assert.doesNotMatch(
      `${parsed.stdout}\n${parsed.stderr}`,
      /Cannot combine|unknown option|--final-message-only|--print|--work-dir|--thinking|--no-thinking/u
    );
    await command.cleanup?.();
  }
);

test(
  "generated Kimi subscription config infers managed K3 reasoning efforts",
  { skip: !runningUnderBun || !fs.existsSync(localKimiCode), timeout: 15_000 },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-managed-k3-"));
    try {
      fs.mkdirSync(path.join(home, "credentials"), { recursive: true });
      fs.writeFileSync(
        path.join(home, "config.toml"),
        `default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://127.0.0.1:9/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = ["video_in", "thinking", "image_in"]
display_name = "K3"
`,
        "utf8"
      );
      fs.writeFileSync(path.join(home, "device_id"), "00000000-0000-0000-0000-000000000106\n", "utf8");
      fs.writeFileSync(
        path.join(home, "credentials", "kimi-code.json"),
        `${JSON.stringify({
          access_token: "contract-access-token",
          refresh_token: "contract-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          expires_in: 900,
          token_type: "Bearer",
          scope: "openid"
        })}\n`,
        "utf8"
      );

      const project = tempProject();
      assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
      const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
      const command = await new KimiCode029Agent({
        model: "kimi-k3",
        ultrafuzzAuthMode: "subscription",
        ultrafuzzReasoningEffort: "max",
        configDir: home
      }).buildCommand({
        prompt: "Contract only",
        cwd: project,
        options: {}
      });
      assert.ok(command.env?.KIMI_CODE_HOME);
      const configPath = path.join(command.env.KIMI_CODE_HOME, "config.toml");
      const configText = fs.readFileSync(configPath, "utf8");
      assert.match(configText, /\[models\.(?:"kimi-k3"|kimi-k3)\]/u);
      assert.match(configText, /support_efforts\s*=\s*\[\s*"low",\s*"high",\s*"max"\s*\]/u);
      assert.match(configText, /default_effort\s*=\s*"max"/u);
      execFileSync(localKimiCode, ["doctor", "config", configPath], { encoding: "utf8" });
      await command.cleanup?.();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);

test(
  "generated Kimi subscription path reflects real Kimi Code 0.29.1 rejecting near-refresh access-only credentials",
  { skip: !runningUnderBun || !fs.existsSync(localKimiCode), timeout: 15_000 },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-frozen-auth-"));
    try {
      fs.mkdirSync(path.join(home, "credentials"), { recursive: true });
      fs.writeFileSync(
        path.join(home, "config.toml"),
        `default_model = "kimi-k3"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://127.0.0.1:9/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"

[models.kimi-k3]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]
support_efforts = [ "low", "high", "max" ]
default_effort = "max"

[thinking]
enabled = true
`,
        "utf8"
      );
      fs.writeFileSync(path.join(home, "device_id"), "00000000-0000-0000-0000-000000000105\n", "utf8");
      fs.writeFileSync(
        path.join(home, "credentials", "kimi-code.json"),
        `${JSON.stringify({
          access_token: "contract-access-token",
          expires_at: Math.floor(Date.now() / 1000) + 60,
          expires_in: 900,
          token_type: "Bearer",
          scope: "openid"
        })}\n`,
        "utf8"
      );
      execFileSync(localKimiCode, ["doctor", "config", path.join(home, "config.toml")], { encoding: "utf8" });
      const parsed = spawnSync(
        localKimiCode,
        ["--output-format", "text", "--model", "kimi-k3", "--prompt", "Contract only"],
        {
          cwd: home,
          env: {
            ...process.env,
            KIMI_CODE_HOME: home,
            KIMI_SHARE_DIR: home,
            NO_PROXY: "127.0.0.1,localhost"
          },
          encoding: "utf8",
          timeout: 5_000
        }
      );
      assert.equal(parsed.error, undefined);
      assert.notEqual(parsed.status, 0);
      assert.match(`${parsed.stdout}\n${parsed.stderr}`, /login_required|refresh_token|no-refresh-token/u);
      assert.doesNotMatch(
        `${parsed.stdout}\n${parsed.stderr}`,
        /Cannot combine|unknown option|--final-message-only|--yolo/u
      );
      const credential = JSON.parse(fs.readFileSync(path.join(home, "credentials", "kimi-code.json"), "utf8")) as {
        refresh_token?: string;
      };
      assert.equal(credential.refresh_token, undefined);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);

type KimiInterpreterEvent = {
  type?: string;
  ok?: boolean;
  answer?: string;
  resume?: string;
  usage?: Record<string, number>;
};

function writeKimiSourceConfig(project: string, name: string): string {
  const sourceConfig = path.join(project, name);
  fs.mkdirSync(path.join(sourceConfig, "credentials"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceConfig, "config.toml"),
    `default_model = "kimi-k3"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
oauth = { storage = "file", key = "oauth/kimi-code" }

[models.kimi-k3]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
support_efforts = [ "low", "high", "max" ]
default_effort = "high"
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(sourceConfig, "credentials", "kimi-code.json"),
    JSON.stringify({
      access_token: "usage-access-token",
      refresh_token: "usage-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(sourceConfig, "device_id"), "usage-device\n", "utf8");
  return sourceConfig;
}

function kimiSubscriptionOptions(sourceConfig: string): Record<string, unknown> {
  return {
    model: "kimi-k3",
    configDir: sourceConfig,
    ultrafuzzAuthMode: "subscription",
    ultrafuzzReasoningEffort: "max"
  };
}

function kimiUsageRecordLine(
  inputOther: number,
  output: number,
  inputCacheRead: number,
  inputCacheCreation: number
): string {
  return JSON.stringify({
    type: "usage.record",
    model: "kimi-k3",
    usage: { inputOther, output, inputCacheRead, inputCacheCreation },
    usageScope: "turn"
  });
}

/** Writes `<home>/sessions/<sessionRelative>/agents/<agentId>/wire.jsonl`. */
function writeKimiWire(home: string, sessionRelative: string, agentId: string, lines: string[]): string {
  const agentDir = path.join(home, "sessions", ...sessionRelative.split("/"), "agents", agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  const wire = path.join(agentDir, "wire.jsonl");
  fs.writeFileSync(wire, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
  return wire;
}

function kimiWireHeaderLine(sessionId: string): string {
  return JSON.stringify({ type: "metadata", version: "1.4", sessionId, createdAt: "2026-07-09T00:00:00.000Z" });
}

function kimiExitResult(args: string[]): unknown {
  return {
    command: "kimi",
    args,
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

function kimiCompletedEvent(events: unknown): KimiInterpreterEvent {
  const completed = (events as KimiInterpreterEvent[]).find((event) => event.type === "completed");
  assert.ok(completed !== undefined, "the Kimi interpreter emitted no completed event");
  return completed;
}

test(
  "generated Kimi adapter reports one invocation's wire usage across every agent wire",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-fresh");

    const agent = new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig));
    const command = await agent.buildCommand({ prompt: "Fresh usage", cwd: "/workspace/target", options: {} });
    const home = command.env?.KIMI_CODE_HOME;
    assert.ok(home);

    const session = "00000000-0000-0000-0000-000000000201";
    const sessionRelative = `wd_target_000000000201/${session}`;
    writeKimiWire(home, sessionRelative, "main", [
      kimiWireHeaderLine(session),
      kimiUsageRecordLine(1_200, 340, 8_000, 500),
      JSON.stringify({ type: "message.appended", role: "assistant", content: "no usage on this record" }),
      kimiUsageRecordLine(90, 12, 0, 0)
    ]);
    writeKimiWire(home, sessionRelative, "sub-1", [
      kimiWireHeaderLine(session),
      kimiUsageRecordLine(700, 60, 1_000, 0)
    ]);

    const completed = kimiCompletedEvent(agent.createOutputInterpreter().onExit?.(kimiExitResult(command.args)));
    // Independent components, summed across the main agent and its sub-agent.
    assert.deepEqual(completed.usage, {
      input_tokens: 1_990,
      output_tokens: 412,
      cache_read_input_tokens: 9_000,
      cache_creation_input_tokens: 500,
      total_tokens: 11_902
    });
    // Kimi folds thinking tokens into `output`; a reasoning alias would double count.
    assert.equal(Object.prototype.hasOwnProperty.call(completed.usage ?? {}, "reasoning_tokens"), false);
    assert.equal(completed.usage?.cache_read_input_tokens !== undefined, true);
    // Attaching usage leaves the rest of the completed event untouched.
    assert.equal(completed.ok, true);

    await command.cleanup?.();
    // Cleanup clears the per-invocation baseline and runtime home, so a reused
    // agent instance cannot re-report the previous invocation's tokens.
    const afterCleanup = kimiCompletedEvent(agent.createOutputInterpreter().onExit?.(kimiExitResult(command.args)));
    assert.equal(Object.prototype.hasOwnProperty.call(afterCleanup, "usage"), false);
  }
);

test(
  "generated Kimi adapter reports only the resumed invocation's own tokens",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-resume");

    const session = "00000000-0000-0000-0000-000000000202";
    const bucket = "wd_target_000000000202";
    const sessionDir = path.join(sourceConfig, "sessions", bucket, session);
    writeKimiWire(sourceConfig, `${bucket}/${session}`, "main", [
      kimiWireHeaderLine(session),
      kimiUsageRecordLine(5_000_000, 400_000, 9_000_000, 100_000),
      kimiUsageRecordLine(1_000, 2_000, 3_000, 4_000)
    ]);
    fs.writeFileSync(
      path.join(sessionDir, "state.json"),
      `${JSON.stringify({
        workDir: "/workspace/target",
        agents: {
          main: { homedir: path.join(sessionDir, "agents", "main"), type: "agent", parentAgentId: null }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(sourceConfig, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: session, sessionDir, workDir: "/workspace/target" })}\n`,
      "utf8"
    );

    const agent = new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig));
    const command = await agent.buildCommand({
      prompt: "Resume usage",
      cwd: "/workspace/target",
      options: { resumeSession: session }
    });
    const home = command.env?.KIMI_CODE_HOME;
    assert.ok(home);
    const runtimeWire = path.join(home, "sessions", bucket, session, "agents", "main", "wire.jsonl");
    assert.equal(fs.existsSync(runtimeWire), true);

    fs.appendFileSync(
      runtimeWire,
      `${kimiUsageRecordLine(1_500, 250, 6_000, 700)}\n${kimiUsageRecordLine(10, 20, 30, 40)}\n`,
      "utf8"
    );

    // The seeded history really is present, so the reported delta is the
    // baseline skipping it rather than an empty resumed wire.
    assert.equal(
      fs
        .readFileSync(runtimeWire, "utf8")
        .split("\n")
        .filter((line) => line.includes('"usage.record"')).length,
      4
    );

    const completed = kimiCompletedEvent(agent.createOutputInterpreter().onExit?.(kimiExitResult(command.args)));
    assert.deepEqual(completed.usage, {
      input_tokens: 1_510,
      output_tokens: 270,
      cache_read_input_tokens: 6_030,
      cache_creation_input_tokens: 740,
      total_tokens: 8_550
    });
    // Session recovery still reports the resumed session alongside the usage.
    assert.equal(completed.resume, session);
    assert.equal(completed.ok, true);
    await command.cleanup?.();
  }
);

test(
  "generated Kimi adapter skips malformed wire usage without fabricating tokens",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-malformed");
    const options = kimiSubscriptionOptions(sourceConfig);

    const tolerant = new KimiCode029Agent(options);
    const tolerantCommand = await tolerant.buildCommand({
      prompt: "Malformed usage",
      cwd: "/workspace/target",
      options: {}
    });
    const tolerantHome = tolerantCommand.env?.KIMI_CODE_HOME;
    assert.ok(tolerantHome);
    const tolerantWire = writeKimiWire(tolerantHome, "wd_target_000000000203/session-203", "main", [
      "not json at all",
      "{",
      JSON.stringify({
        type: "usage.record",
        usage: { inputOther: "12", output: 1, inputCacheRead: 0, inputCacheCreation: 0 }
      }),
      JSON.stringify({
        type: "usage.record",
        usage: { inputOther: -5, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }
      }),
      JSON.stringify({ type: "usage.record", usage: { inputOther: 4, output: 2, inputCacheRead: 1 } }),
      JSON.stringify({ type: "usage.record", model: "kimi-k3" }),
      JSON.stringify({ type: "message.appended", usage: { inputOther: 999, output: 999 } }),
      kimiUsageRecordLine(33, 7, 2, 1)
    ]);
    // A torn final line, exactly as a crashed Kimi process leaves it.
    fs.appendFileSync(tolerantWire, '{"type":"usage.record","model":"kimi-k3","usage":{"inputOth', "utf8");

    const tolerantCompleted = kimiCompletedEvent(
      tolerant.createOutputInterpreter().onExit?.(kimiExitResult(tolerantCommand.args))
    );
    assert.deepEqual(tolerantCompleted.usage, {
      input_tokens: 33,
      output_tokens: 7,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
      total_tokens: 43
    });
    await tolerantCommand.cleanup?.();

    const absent = new KimiCode029Agent(options);
    const absentCommand = await absent.buildCommand({ prompt: "No usage", cwd: "/workspace/target", options: {} });
    const absentHome = absentCommand.env?.KIMI_CODE_HOME;
    assert.ok(absentHome);
    writeKimiWire(absentHome, "wd_target_000000000204/session-204", "main", [
      kimiWireHeaderLine("session-204"),
      "still not json",
      JSON.stringify({ type: "usage.record", usage: { inputOther: Number.NaN } })
    ]);
    const absentCompleted = kimiCompletedEvent(
      absent.createOutputInterpreter().onExit?.(kimiExitResult(absentCommand.args))
    );
    // Absent usage stays absent so accounting reports it unavailable, not zero,
    // and the successful-output and session behavior is unchanged.
    assert.equal(Object.prototype.hasOwnProperty.call(absentCompleted, "usage"), false);
    assert.equal(absentCompleted.type, "completed");
    assert.equal(absentCompleted.ok, true);
    assert.equal(absentCompleted.resume, undefined);
    await absentCommand.cleanup?.();
  }
);

test(
  "generated Kimi adapter reads wire usage only from inside the isolated runtime home",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-isolation");
    // A shared session store outside this invocation's runtime home.
    writeKimiWire(sourceConfig, "wd_other/session-other", "main", [
      kimiUsageRecordLine(9_000_000, 9_000_000, 9_000_000, 9_000_000)
    ]);

    const agent = new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig));
    const command = await agent.buildCommand({ prompt: "Isolated usage", cwd: "/workspace/target", options: {} });
    const home = command.env?.KIMI_CODE_HOME;
    assert.ok(home);

    const escaped = path.join(project, "kimi-escaped-wire");
    fs.mkdirSync(escaped, { recursive: true });
    fs.writeFileSync(
      path.join(escaped, "wire.jsonl"),
      `${kimiUsageRecordLine(7_000_000, 7_000_000, 7_000_000, 7_000_000)}\n`,
      "utf8"
    );
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.symlinkSync(escaped, path.join(home, "sessions", "linked-agent-dir"), "dir");
    fs.symlinkSync(path.join(escaped, "wire.jsonl"), path.join(home, "sessions", "wire.jsonl"));
    writeKimiWire(home, "wd_target_000000000205/session-205", "main", [kimiUsageRecordLine(11, 22, 33, 44)]);

    const completed = kimiCompletedEvent(agent.createOutputInterpreter().onExit?.(kimiExitResult(command.args)));
    assert.deepEqual(completed.usage, {
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 33,
      cache_creation_input_tokens: 44,
      total_tokens: 110
    });
    await command.cleanup?.();
  }
);

test(
  "generated Kimi completed-event usage is what pinned Smithers 0.31.0 consumes",
  { skip: !runningUnderBun },
  async () => {
    const smithersEntry = fs.realpathSync(
      path.join(process.cwd(), "node_modules", "smithers-orchestrator", "src", "index.js")
    );
    const resolved = createRequire(smithersEntry).resolve("@smithers-orchestrator/agents/BaseCliAgent");
    const baseCliAgent = (await import(pathToFileURL(resolved).href)) as {
      extractUsageFromOutput: (raw: string) => unknown;
    };
    // A realistic Kimi Code 0.29.1 stream-json transcript: no `usage` anywhere,
    // so BaseCliAgent provably falls through to the completed event we populate.
    const streamJson = [
      JSON.stringify({ role: "meta", type: "system.version", version: "0.29.1" }),
      JSON.stringify({ role: "assistant", content: "Reviewing the target contracts." }),
      JSON.stringify({ role: "tool", tool_call_id: "call_1", content: "read 42 lines" }),
      JSON.stringify({ role: "assistant", content: "Done." }),
      JSON.stringify({
        type: "goal.summary",
        goalId: "goal_1",
        status: "completed",
        reason: null,
        turnsUsed: 3,
        tokensUsed: 4_242,
        wallClockMs: 9_000
      }),
      JSON.stringify({
        role: "meta",
        type: "session.resume_hint",
        session_id: "00000000-0000-0000-0000-000000000206",
        command: "kimi -r 00000000-0000-0000-0000-000000000206",
        content: "To resume this session: kimi -r 00000000-0000-0000-0000-000000000206"
      })
    ].join("\n");
    assert.equal(baseCliAgent.extractUsageFromOutput(streamJson), undefined);

    // The completed-event fallback reads these exact aliases; a Smithers bump
    // that renames them must fail here rather than silently drop accounting.
    const pinnedSource = fs.readFileSync(path.join(path.dirname(resolved), "BaseCliAgent.js"), "utf8");
    assert.match(pinnedSource, /usageFromCompletedEvent\(completedEvent\)/u);
    for (const alias of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens"
    ]) {
      assert.ok(pinnedSource.includes(alias), `pinned BaseCliAgent no longer reads ${alias}`);
    }
  }
);

test("validate rejects unknown agent references before launch", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  const generatedConfig = fs.readFileSync(configPath, "utf8");
  assert.match(generatedConfig, /\[agents\.CodexAgent\]/);
  assert.match(generatedConfig, /auth = "api-key"/);
  fs.writeFileSync(configPath, generatedConfig.replace('agent = "CodexAgent"', 'agent = "MissingAgent"'), "utf8");

  const validate = await validateProject({ projectRoot: project, env: {} });
  assert.equal(validate.ok, false);
  assert.ok(validate.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN"));

  const run = await startRun({
    projectRoot: project,
    runId: "unknown-agent",
    agent: "MissingAgent",
    env: fakeSmithersEnv(project)
  });
  assert.equal(run.ok, false);
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN"));
});

test("validate ignores unused opt-in model profiles in older agent registries", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  fs.writeFileSync(
    path.join(project, ".smithers/agents/index.ts"),
    'export { createCodexAgent } from "./codex";\n' +
      "export const agentFactories = { CodexAgent: createCodexAgent };\n",
    "utf8"
  );

  const validate = await validateProject({ projectRoot: project, env: {} });
  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));

  const kimiRun = await startRun({
    projectRoot: project,
    runId: "missing-kimi-agent",
    agent: "KimiAgent",
    env: fakeSmithersEnv(project)
  });
  assert.equal(kimiRun.ok, false);
  assert.ok(kimiRun.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN"));
});

test("init and run layout reject symlinked project-owned roots before writes", async () => {
  const project = tempProject();
  const outside = tempProject();
  fs.symlinkSync(outside, path.join(project, ".ultrafuzz"));

  const init = initProject({ projectRoot: project });
  assert.equal(init.ok, false);
  assert.ok(init.diagnostics.some((diagnostic) => diagnostic.code === "INIT_ROOT_UNSAFE"));
  assert.equal(fs.existsSync(path.join(outside, "runs")), false);
});

test("force init rejects symlinked config and nested project files before overwrite", async () => {
  const configProject = tempProject();
  const configOutside = tempProject();
  fs.writeFileSync(path.join(configOutside, "ultrafuzz.toml"), "outside\n", "utf8");
  fs.symlinkSync(path.join(configOutside, "ultrafuzz.toml"), path.join(configProject, "ultrafuzz.toml"));
  const configInit = initProject({ projectRoot: configProject, force: true });
  assert.equal(configInit.ok, false);
  assert.ok(configInit.diagnostics.some((diagnostic) => diagnostic.code === "INIT_PATH_UNSAFE"));
  assert.equal(fs.readFileSync(path.join(configOutside, "ultrafuzz.toml"), "utf8"), "outside\n");

  const topologyProject = tempProject();
  const topologyOutside = tempProject();
  fs.mkdirSync(path.join(topologyProject, ".ultrafuzz"), { recursive: true });
  fs.writeFileSync(path.join(topologyOutside, "topology.yml"), "outside\n", "utf8");
  fs.symlinkSync(path.join(topologyOutside, "topology.yml"), path.join(topologyProject, ".ultrafuzz", "topology.yml"));
  const topologyInit = initProject({ projectRoot: topologyProject, force: true });
  assert.equal(topologyInit.ok, false);
  assert.ok(topologyInit.diagnostics.some((diagnostic) => diagnostic.code === "INIT_PATH_UNSAFE"));
  assert.equal(fs.readFileSync(path.join(topologyOutside, "topology.yml"), "utf8"), "outside\n");
});

test("plan creates run layout, graph fingerprint, and rendered prompt before Smithers submission", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const plan = await planRun({ projectRoot: project, runId: "planned-run", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(fs.existsSync(path.join(plan.value!.run_root, "plan.json")), true);
  assert.equal(fs.existsSync(path.join(plan.value!.run_root, "artifacts/project-discovery/prompt.rendered.md")), true);
  const persistedPlan = JSON.parse(fs.readFileSync(path.join(plan.value!.run_root, "plan.json"), "utf8")) as {
    execution?: { mode?: string; retentionDays?: number };
    rendered_prompts: Array<{ rendered_prompt_snapshot_path?: string }>;
  };
  assert.deepEqual(persistedPlan.execution, plan.value!.resolved_config.execution);
  assert.equal(persistedPlan.rendered_prompts.length, 1);
  assert.match(persistedPlan.rendered_prompts[0]!.rendered_prompt_snapshot_path ?? "", /^prompt-snapshots\//u);
  assert.equal(
    fs.existsSync(path.join(plan.value!.run_root, persistedPlan.rendered_prompts[0]!.rendered_prompt_snapshot_path!)),
    true
  );
  assert.match(plan.value!.graph_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(plan.value!.graph.nodes[0]?.model_fanout[0]?.agent_ref, "CodexAgent");
});

test("repairs only missing rendered prompts from compatible persisted run metadata", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "prompt-repair", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const promptPath = path.join(plan.value!.run_root, "artifacts", "project-discovery", "prompt.rendered.md");
  const expected = fs.readFileSync(promptPath, "utf8");
  fs.rmSync(promptPath);

  assert.equal(
    await repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "prompt-repair",
      runRoot: plan.value!.run_root
    }),
    1
  );
  assert.equal(fs.readFileSync(promptPath, "utf8"), expected);
  assert.equal(
    await repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "prompt-repair",
      runRoot: plan.value!.run_root
    }),
    0
  );
});

test("serializes concurrent prompt repairs without deleting another invocation's output", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "concurrent-prompt-repair", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const promptPath = plan.value!.rendered_prompts[0]!.rendered_prompt_path;
  const expected = fs.readFileSync(promptPath, "utf8");
  fs.rmSync(promptPath);

  const repair = () =>
    repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "concurrent-prompt-repair",
      runRoot: plan.value!.run_root
    });
  assert.deepEqual((await Promise.all([repair(), repair()])).sort(), [0, 1]);
  assert.equal(fs.readFileSync(promptPath, "utf8"), expected);
  assert.equal(fs.existsSync(path.join(plan.value!.run_root, ".prompt-repair")), false);
});

test("repairs from immutable bytes after prompt-affecting runtime overrides and source changes", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const sourcePrompt = path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md");
  fs.appendFileSync(sourcePrompt, "\nOriginal quorum: {{triage_quorum}} of {{triage_panel_size}}.\n", "utf8");
  const plan = await planRun({
    projectRoot: project,
    runId: "prompt-repair-runtime-override",
    runtimeOverrides: { triageQuorum: 6, triagePanelSize: 7 },
    env: {}
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const promptPath = plan.value!.rendered_prompts[0]!.rendered_prompt_path;
  const expected = fs.readFileSync(promptPath, "utf8");
  assert.match(expected, /Original quorum: 6 of 7\./u);
  fs.rmSync(promptPath);
  fs.appendFileSync(sourcePrompt, "\nChanged after planning.\n", "utf8");
  fs.writeFileSync(path.join(project, "ultrafuzz.toml"), "not valid toml = [\n", "utf8");

  assert.equal(
    await repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "prompt-repair-runtime-override",
      runRoot: plan.value!.run_root
    }),
    1
  );
  assert.equal(fs.readFileSync(promptPath, "utf8"), expected);
});

test("refuses all digest-less legacy prompt reuse because original lineage is unprovable", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "legacy-prompt-repair", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const planPath = path.join(plan.value!.run_root, "plan.json");
  const persisted = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
    rendered_prompts: Array<Record<string, unknown>>;
  };
  persisted.rendered_prompts = persisted.rendered_prompts.map(
    ({ rendered_prompt_digest: _digest, rendered_prompt_snapshot_path: _snapshot, ...entry }) => ({
      ...entry,
      rendered_prompt_path: path.join("/__legacy_volume_mount", String(entry.rendered_prompt_path).replace(/^\/+/u, ""))
    })
  );
  fs.writeFileSync(planPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  await assert.rejects(
    repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "legacy-prompt-repair",
      runRoot: plan.value!.run_root
    }),
    /cannot validate legacy rendered prompt/u
  );
});

test("refuses rendered prompt repair when its immutable snapshot does not match the persisted digest", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "prompt-lineage", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const prompt = plan.value!.rendered_prompts[0]!;
  const persisted = JSON.parse(fs.readFileSync(path.join(plan.value!.run_root, "plan.json"), "utf8")) as {
    rendered_prompts: Array<{ rendered_prompt_snapshot_path: string }>;
  };
  const snapshotPath = path.join(plan.value!.run_root, persisted.rendered_prompts[0]!.rendered_prompt_snapshot_path);
  fs.rmSync(prompt.rendered_prompt_path);
  fs.appendFileSync(snapshotPath, "\n.\n", "utf8");

  await assert.rejects(
    repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "prompt-lineage",
      runRoot: plan.value!.run_root
    }),
    /immutable rendered prompt snapshot does not match persisted task metadata/u
  );
  assert.equal(fs.existsSync(prompt.rendered_prompt_path), false);
});

test("refuses to reuse an existing rendered prompt that does not match its persisted digest", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "prompt-validation", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const prompt = plan.value!.rendered_prompts[0]!;
  fs.appendFileSync(prompt.rendered_prompt_path, "\n.\n", "utf8");

  await assert.rejects(
    repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "prompt-validation",
      runRoot: plan.value!.run_root
    }),
    /existing rendered prompt does not match persisted task metadata/u
  );
});

test("plan uses an eval topology override without replacing the project topology", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const canonicalTopology = path.join(project, ".ultrafuzz", "topology.yml");
  const smokeTopology = path.join(project, "smoke-benchmark.yml");
  fs.copyFileSync(canonicalTopology, smokeTopology);
  fs.writeFileSync(canonicalTopology, "not: [valid\n", "utf8");

  const plan = await planRun({
    projectRoot: project,
    topologyPath: smokeTopology,
    runId: "topology-override",
    env: {}
  });

  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.value!.validation.topology?.path, smokeTopology);
  assert.deepEqual(
    plan.value!.graph.nodes.map((node) => node.logical_id),
    ["project-discovery"]
  );
  assert.equal(fs.readFileSync(canonicalTopology, "utf8"), "not: [valid\n");
});

test("plan applies smoke eval model profiles to a normally initialized target", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  const smokeTopology = path.resolve(process.cwd(), "../..", "benchmarks", "smoke-benchmark.yml");

  const plan = await planRun({
    projectRoot: project,
    topologyPath: smokeTopology,
    runId: "smoke-topology-profiles",
    runtimeOverrides: {
      models: {
        profiles: {
          benchmark: { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "high" },
          "smoke-coordination": { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "medium" }
        }
      }
    },
    env: {}
  });

  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const executable = plan.value!.graph.nodes.filter((node) => node.kind === "agentic");
  assert.equal(executable.length, 7);
  const strategies = executable.filter((node) => node.model_fanout[0]?.model_profile_id === "benchmark");
  const coordination = executable.filter((node) => node.model_fanout[0]?.model_profile_id === "smoke-coordination");
  assert.equal(strategies.length, 4);
  assert.ok(strategies.every((node) => node.model_fanout[0]?.reasoning_effort === "high"));
  assert.equal(coordination.length, 3);
  assert.ok(coordination.every((node) => node.model_fanout[0]?.reasoning_effort === "medium"));
});

test("plan materializes pinned reference nodes before rendering dependent prompts", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeReferenceTopology(project);
  const xdgCacheHome = path.join(project, "xdg-cache");
  writeReferenceCache(xdgCacheHome);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = xdgCacheHome;
  try {
    const plan = await planRun({ projectRoot: project, runId: "reference-plan", env: {} });

    assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
    const referenceArtifact = path.join(
      plan.value!.run_root,
      "artifacts",
      "reference-properties-example",
      "references",
      "example.md"
    );
    const referenceManifest = path.join(
      plan.value!.run_root,
      "artifacts",
      "reference-properties-example",
      RUN_REFERENCE_MANIFEST_FILE
    );
    assert.equal(fs.existsSync(referenceArtifact), true);
    assert.equal(fs.existsSync(referenceManifest), true);
    assert.match(fs.readFileSync(referenceArtifact, "utf8"), /# Pinned Reference: properties\.example/u);
    const rendered = fs.readFileSync(
      path.join(plan.value!.run_root, "artifacts", "project-discovery", "prompt.rendered.md"),
      "utf8"
    );
    assert.match(rendered, /reference-properties-example\/references\/example\.md/u);
    const state = JSON.parse(fs.readFileSync(path.join(plan.value!.run_root, "state.json"), "utf8")) as {
      nodes?: Record<string, { status?: string; provenance?: Record<string, unknown> }>;
    };
    assert.equal(state.nodes?.["reference-properties-example"]?.status, "succeeded");
    assert.equal(state.nodes?.["reference-properties-example"]?.provenance?.reference, "properties.example");
  } finally {
    if (previousXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  }
});

test("plan renders prompt variables against attempt artifact directories for model fan-out", async () => {
  const project = tempProject();
  writeFanoutProject(project);

  const plan = await planRun({ projectRoot: project, runId: "fanout-prompts", env: {} });

  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const setupFast = plan.value!.rendered_prompts.find(
    (prompt) => prompt.attempt_id === "project-discovery__model_0__attempt_0"
  );
  const signalFast = plan.value!.rendered_prompts.find(
    (prompt) => prompt.attempt_id === "signal-analysis__model_0__attempt_0"
  );
  assert.ok(setupFast);
  assert.ok(signalFast);

  const setupFastDir = path.join(plan.value!.run_root, "artifacts", "project-discovery__model_0__attempt_0");
  const setupDeepDir = path.join(plan.value!.run_root, "artifacts", "project-discovery__model_1__attempt_1");
  const signalFastDir = path.join(plan.value!.run_root, "artifacts", "signal-analysis__model_0__attempt_0");
  const setupText = fs.readFileSync(setupFast.rendered_prompt_path, "utf8");
  const signalText = fs.readFileSync(signalFast.rendered_prompt_path, "utf8");

  assert.ok(setupText.includes("Strategy: project-discovery"), setupText);
  assert.ok(setupText.includes(setupFastDir), setupText);
  assert.ok(signalText.includes(path.join(signalFastDir, "findings.json")), signalText);
  assert.ok(signalText.includes(path.join(setupFastDir, "setup", "project-discovery.md")), signalText);
  assert.ok(signalText.includes(path.join(setupDeepDir, "setup", "project-discovery.md")), signalText);
});

test("compileSmithersWorkflow gates native dependencies on deterministic artifact verification", async () => {
  const project = tempProject();
  writeFanoutProject(project);

  const plan = await planRun({ projectRoot: project, runId: "native-deps", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-native-deps",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.match(workflowSource, /dependsOn=\{task\.dependsOn\}/);
  assert.match(workflowSource, /const taskOutput = z\.object\(\{/);
  assert.match(workflowSource, /summary: z\.string\(\)\.min\(1\)/);
  assert.match(workflowSource, /smithers-display-name: Ultrafuzz native-deps/);
  assert.doesNotMatch(workflowSource, /__ULTRAFUZZ_/);
  assert.doesNotMatch(workflowSource, /const layers =/);
  assert.doesNotMatch(workflowSource, /<Sequence\b/);
  assert.match(workflowSource, /<Parallel\b/);

  const smithersTasks = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as {
    layers?: unknown;
    tasks: Array<{ attemptId: string; dependencySmithersNodeIds: string[] }>;
  };
  assert.equal("layers" in smithersTasks, false);
  assert.equal(workflowSource.match(/"runtimeContext":/gu)?.length, smithersTasks.tasks.length);
  assert.deepEqual(
    smithersTasks.tasks.find((task) => task.attemptId === "project-discovery__model_0__attempt_0")
      ?.dependencySmithersNodeIds,
    []
  );
  assert.deepEqual(
    smithersTasks.tasks.find((task) => task.attemptId === "signal-analysis__model_0__attempt_0")
      ?.dependencySmithersNodeIds,
    ["verify:project-discovery__model_0__attempt_0", "verify:project-discovery__model_1__attempt_1"]
  );
  assert.match(workflowSource, /id=\{task\.verifierId\}/);
  assert.match(workflowSource, /validateArtifactContract/);
  assert.match(workflowSource, /candidate !== root && candidate\.startsWith/);
  assert.match(workflowSource, /isStrictlyInsideDirectory\(artifactDir, artifactPath\)/);
});

test("compileSmithersWorkflow maps cloud attempts to portable provider sandboxes", async () => {
  const project = tempProject();
  writeFanoutProject(project);

  const plan = await planRun({ projectRoot: project, runId: "cloud-nodes", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  plan.value!.resolved_config.execution = {
    mode: "cloud",
    provider: "modal",
    retentionDays: 30,
    resources: {
      cpu: 4,
      memoryMiB: 8192,
      timeoutSeconds: 1800
    },
    nodes: {
      "project-discovery": {
        resources: {
          cpu: 8,
          memoryMiB: 16384
        }
      }
    },
    providers: {
      modal: {
        app: "ultrafuzz-test",
        image: "ultrafuzz-test",
        credentialEnv: ["ULTRAFUZZ_TEST_PROVIDER_ID", "ULTRAFUZZ_TEST_PROVIDER_SECRET"]
      }
    }
  };
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-cloud-nodes",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const discovery = compiled.tasks.find((task) => task.metadata.node.logicalNodeId === "project-discovery");
  assert.ok(discovery);
  assert.deepEqual(discovery.execution.resources, {
    cpu: 8,
    memoryMiB: 16384,
    timeoutSeconds: 1800
  });
  assert.deepEqual(discovery.execution.agentCredentialEnv, ["OPENAI_API_KEY"]);
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.match(workflowSource, /<Sandbox/);
  assert.match(workflowSource, /createModalNodeSandboxProvider/);
  assert.match(workflowSource, /schema_version: "ultrafuzz\.modal\.node\.v1"/);
  assert.match(workflowSource, /run_id: "cloud-nodes"/u);
  assert.doesNotMatch(workflowSource, /run_id: cloud-nodes/u);
  assert.match(workflowSource, /execution_generation: cloudExecutionGeneration/u);
  assert.match(workflowSource, /"promptPath": "\.ultrafuzz\/runs\/cloud-nodes\//);
  assert.match(workflowSource, /"workspacePath": "\.ultrafuzz\/runs\/cloud-nodes\//);
  assert.match(workflowSource, /"path": "\.ultrafuzz\/runs\/cloud-nodes\/workspaces\//);
  assert.match(workflowSource, /"dependencyArtifactDirs": \[/u);
  const fanIn = compiled.tasks.find((task) => task.metadata.node.logicalNodeId === "signal-analysis");
  assert.equal(fanIn?.dependencyArtifactDirs.length, 2);
  assert.ok(
    fanIn?.dependencyArtifactDirs.every((directory) =>
      directory.startsWith(path.join(project, ".ultrafuzz", "runs", "cloud-nodes", "artifacts"))
    )
  );
  assert.doesNotMatch(workflowSource, new RegExp(`"promptPath": ${JSON.stringify(project)}`, "u"));
  assert.match(workflowSource, /operator_prompt: operatorPromptInput/u);
});

test("compileSmithersWorkflow preserves Kimi cloud API-key binding for Modal fallback credentials", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace(
        '[agents.KimiAgent]\nauth = "subscription"',
        '[agents.KimiAgent]\nauth = "api-key"\napi_key_env = "KIMI_API_KEY"'
      ),
    "utf8"
  );

  const plan = await planRun({ projectRoot: project, runId: "cloud-kimi-nodes", agent: "KimiAgent", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  plan.value!.resolved_config.execution = {
    mode: "cloud",
    provider: "modal",
    retentionDays: 30,
    resources: { cpu: 4, memoryMiB: 8192, timeoutSeconds: 1800 },
    nodes: {},
    providers: {
      modal: {
        app: "ultrafuzz-test",
        image: "ultrafuzz-test",
        credentialEnv: ["ULTRAFUZZ_TEST_PROVIDER_ID", "ULTRAFUZZ_TEST_PROVIDER_SECRET"]
      }
    }
  };
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-cloud-kimi-nodes",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const discovery = compiled.tasks.find((task) => task.metadata.node.logicalNodeId === "project-discovery");
  assert.ok(discovery);
  assert.equal(discovery.agentRef, "KimiAgent");
  assert.deepEqual(discovery.execution.agentCredentialEnv, ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_BASE_URL"]);
});

test("compileSmithersWorkflow escapes the evidence workflow import", async () => {
  const project = tempProject();
  writeFanoutProject(project);

  const plan = await planRun({ projectRoot: project, runId: "escaped-import", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const quotedProjectRoot = path.join(project, 'checkout"quoted');
  fs.mkdirSync(quotedProjectRoot);
  const compiled = compileSmithersWorkflow({
    projectRoot: quotedProjectRoot,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-escaped-import",
    renderedPrompts: plan.value!.rendered_prompts
  });

  let importPath = path
    .relative(path.dirname(compiled.evidenceWorkflowPath), compiled.workflowPath)
    .split(path.sep)
    .join("/");
  if (!importPath.startsWith(".")) {
    importPath = `./${importPath}`;
  }
  importPath = importPath.replace(/\.tsx$/u, "");
  const evidenceSource = fs.readFileSync(compiled.evidenceWorkflowPath, "utf8");
  assert.ok(evidenceSource.includes(`from ${JSON.stringify(importPath)};`), evidenceSource);
});

test("compileSmithersWorkflow applies group execution defaults", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
groups:
  setup:
    label: Setup
    defaults:
      timeout_seconds: 1200
      max_attempts: 2
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    prompt: setup/project-discovery.md
    group: setup
    depends_on:
      - __start__
    outputs:
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );

  const plan = await planRun({ projectRoot: project, runId: "group-timeout", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-group-timeout",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const smithersTasks = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as {
    tasks: Array<{
      attemptId: string;
      timeoutMs: number;
      heartbeatTimeoutMs: number;
      retries: number;
      metadata?: {
        retryPolicy?: { maxAttempts?: number; smithersRetries?: number };
        timeout?: { seconds?: number; heartbeatTimeoutMs?: number };
      };
    }>;
  };
  const task = smithersTasks.tasks.find((entry) => entry.attemptId === "project-discovery");
  assert.equal(task?.timeoutMs, 1_200_000);
  assert.equal(task?.heartbeatTimeoutMs, 1_200_000);
  assert.equal(task?.retries, 1);
  assert.equal(task?.metadata?.retryPolicy?.maxAttempts, 2);
  assert.equal(task?.metadata?.retryPolicy?.smithersRetries, 1);
  assert.equal(task?.metadata?.timeout?.seconds, 1200);
  assert.equal(task?.metadata?.timeout?.heartbeatTimeoutMs, 1_200_000);
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  const expectedRuntimeContext = [
    "## Topology Runtime Context",
    "",
    "- Timeout: 1200 seconds total.",
    "- Finalization reserve: 200 seconds.",
    "- Working budget before finalization: 1000 seconds.",
    "- Stop starting new delegated or tool work when the finalization reserve begins.",
    "- During the reserve, write and validate every required artifact, marking unfinished work blocked instead of omitting outputs."
  ].join("\n");
  assert.equal(
    workflowSource.includes(`"runtimeContext": ${JSON.stringify(expectedRuntimeContext)}`),
    true,
    workflowSource
  );
  assert.match(workflowSource, /\$\{task\.runtimeContext\}\\n\\n\$\{operatorPrompt\}/u);
});

test("topology runtime context keeps a bounded finalization reserve", async () => {
  const { topologyRuntimeContextForTimeout } = await import("../src/smithers.js");
  const cases = [
    { timeoutMs: 1_000, timeoutSeconds: 1, reserveSeconds: 1, workingSeconds: 0 },
    { timeoutMs: 2_000, timeoutSeconds: 2, reserveSeconds: 1, workingSeconds: 1 },
    { timeoutMs: 12_000, timeoutSeconds: 12, reserveSeconds: 2, workingSeconds: 10 },
    { timeoutMs: 7_200_000, timeoutSeconds: 7200, reserveSeconds: 300, workingSeconds: 6900 }
  ];
  for (const entry of cases) {
    const context = topologyRuntimeContextForTimeout(entry.timeoutMs);
    assert.match(context, new RegExp(`- Timeout: ${entry.timeoutSeconds} seconds total\\.`, "u"));
    assert.match(context, new RegExp(`- Finalization reserve: ${entry.reserveSeconds} seconds\\.`, "u"));
    assert.match(context, new RegExp(`- Working budget before finalization: ${entry.workingSeconds} seconds\\.`, "u"));
    if (entry.timeoutSeconds > 1) {
      assert.ok(entry.workingSeconds > 0);
    }
  }
});

test("startRun --agent does not carry the previous agent's model onto the new agent", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  // The default profile is CodexAgent/gpt-5.5/xhigh; switching only the agent
  // must not hand Codex's model and reasoning to Claude.
  const run = await startRun({
    projectRoot: project,
    runId: "agent-switch",
    agent: "ClaudeAgent",
    env: fakeSmithersEnv(project)
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const smithersTasks = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "tasks.json"), "utf8")
  ) as { tasks: Array<{ agentRef?: string; modelName?: string | null; reasoningEffort?: string | null }> };
  assert.equal(smithersTasks.tasks[0]?.agentRef, "ClaudeAgent");
  assert.equal(smithersTasks.tasks[0]?.modelName ?? null, null);
  assert.equal(smithersTasks.tasks[0]?.reasoningEffort ?? null, null);

  // An explicit --model still pins the model for the overridden agent.
  const pinned = await startRun({
    projectRoot: project,
    runId: "agent-switch-pinned",
    agent: "ClaudeAgent",
    model: "claude-sonnet-5",
    env: fakeSmithersEnv(project)
  });
  assert.equal(pinned.ok, true, JSON.stringify(pinned.diagnostics));
  const pinnedTasks = JSON.parse(
    fs.readFileSync(path.join(pinned.value!.run_root, "smithers", "tasks.json"), "utf8")
  ) as { tasks: Array<{ agentRef?: string; modelName?: string | null; reasoningEffort?: string | null }> };
  assert.equal(pinnedTasks.tasks[0]?.agentRef, "ClaudeAgent");
  assert.equal(pinnedTasks.tasks[0]?.modelName, "claude-sonnet-5");
  assert.equal(pinnedTasks.tasks[0]?.reasoningEffort ?? null, null);
});

test("init reports an agent registry that does not export a generated agent", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });

  // Simulate a project scaffolded before ClaudeAgent and KimiAgent existed: the registry
  // predates the adapter, and init preserves project-owned files.
  const registryPath = path.join(project, ".smithers/agents/index.ts");
  fs.writeFileSync(
    registryPath,
    'import { createCodexAgent } from "./codex";\n' +
      'export { createCodexAgent } from "./codex";\n' +
      "export const agentFactories = { CodexAgent: createCodexAgent };\n",
    "utf8"
  );

  const upgraded = initProject({ projectRoot: project });
  assert.equal(upgraded.ok, true);
  const stale = upgraded.diagnostics.filter((entry) => entry.code === "INIT_AGENT_REGISTRY_STALE");
  assert.equal(stale.length, 2, JSON.stringify(upgraded.diagnostics));
  assert.equal(stale[0]?.severity, "warning");
  assert.match(stale.map((entry) => entry.message).join("\n"), /ClaudeAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /KimiAgent/);

  // A registry that names the agent without registering its factory is still
  // stale: nothing resolves it, since generated adapters export only factories.
  fs.writeFileSync(
    registryPath,
    'import { createCodexAgent } from "./codex";\n' +
      'export { CodexAgent, createCodexAgent } from "./codex";\n' +
      'export { ClaudeAgent } from "./claude";\n' +
      "export const agentFactories = { CodexAgent: createCodexAgent };\n",
    "utf8"
  );
  const named = initProject({ projectRoot: project });
  const namedStale = named.diagnostics.filter((entry) => entry.code === "INIT_AGENT_REGISTRY_STALE");
  assert.equal(namedStale.length, 2, JSON.stringify(named.diagnostics));
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /ClaudeAgent/);
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /KimiAgent/);

  // A registry that exports every generated agent stays quiet.
  const regenerated = initProject({ projectRoot: project, force: true });
  assert.equal(
    regenerated.diagnostics.filter((entry) => entry.code === "INIT_AGENT_REGISTRY_STALE").length,
    0,
    JSON.stringify(regenerated.diagnostics)
  );
});

test("startRun compiles normal Smithers tasks, persists provenance, and submits through Smithers CLI", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs.readFileSync(configPath, "utf8").replace('reasoning = "xhigh"', 'reasoning = "max"'),
    "utf8"
  );

  const run = await startRun({
    projectRoot: project,
    runId: "smithers-run",
    env: fakeSmithersEnv(project),
    model: "gpt-runtime-override",
    maxConcurrency: 2,
    prompt: "Operator priority",
    workflowInput: { issue: 2 }
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(run.value?.status, "running");
  assert.deepEqual(run.value!.workflow_ids, ["ultrafuzz-smithers-run"]);

  const list = await listRuns({ projectRoot: project, env: fakeSmithersEnv(project) });
  assert.equal(list.value?.product_runs.length, 1);
  assert.equal(list.value?.runs[0]?.workflow_run_id, "ultrafuzz-smithers-run");
  const status = await getRunStatus({ projectRoot: project, runId: run.value!.run_id, env: fakeSmithersEnv(project) });
  assert.equal(status.value?.status, "running");
  assert.equal(status.value?.metadata?.workflow_ids instanceof Array, true);
  assert.equal(status.value?.workflow?.run_id, "ultrafuzz-smithers-run");
  assert.equal(status.value?.workflow?.inspect.ok, true);
  assert.equal(status.value?.workflow?.events.ok, true);

  const smithersTasks = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "tasks.json"), "utf8")
  ) as {
    tasks: Array<{
      agentRef?: string;
      modelName?: string;
      reasoningEffort?: string;
      timeoutMs?: number;
      retries?: number;
      retryPolicy?: unknown;
      workspacePath?: string;
      artifactDir?: string;
      metadata?: {
        node?: { concreteNodeId?: string };
        model?: { modelName?: string; reasoningEffort?: string };
      };
    }>;
  };
  const smithersInput = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "input.json"), "utf8")
  ) as {
    operator_prompt?: string;
    operator_input?: { issue?: number };
    tasks?: Array<{ prompt?: string; prompt_path?: string }>;
  };
  assert.equal(smithersInput.operator_prompt, "Operator priority");
  assert.equal(smithersInput.operator_input?.issue, 2);
  assert.equal(smithersInput.tasks?.[0]?.prompt, undefined);
  assert.equal(typeof smithersInput.tasks?.[0]?.prompt_path, "string");
  assert.equal(smithersTasks.tasks[0]?.agentRef, "CodexAgent");
  assert.equal(smithersTasks.tasks[0]?.modelName, "gpt-runtime-override");
  assert.equal(smithersTasks.tasks[0]?.reasoningEffort, "max");
  assert.equal(smithersTasks.tasks[0]?.artifactDir, path.join(run.value!.run_root, "artifacts", "project-discovery"));
  assert.notEqual(smithersTasks.tasks[0]?.artifactDir, smithersTasks.tasks[0]?.workspacePath);
  assert.ok(smithersTasks.tasks.every((task) => typeof task.timeoutMs === "number"));
  assert.ok(smithersTasks.tasks.every((task) => typeof task.retries === "number"));
  assert.ok(smithersTasks.tasks.every((task) => task.retryPolicy !== null));
  assert.equal(smithersTasks.tasks[0]?.metadata?.node?.concreteNodeId, "project-discovery");
  assert.equal(smithersTasks.tasks[0]?.metadata?.model?.modelName, "gpt-runtime-override");
  assert.equal(smithersTasks.tasks[0]?.metadata?.model?.reasoningEffort, "max");

  const workflowSource = fs.readFileSync(
    path.join(project, ".smithers", "workflows", "ultrafuzz-smithers-run.tsx"),
    "utf8"
  );
  const expectedArtifactDir = path.join(run.value!.run_root, "artifacts", "project-discovery");
  assert.match(workflowSource, /smithers-orchestrator/);
  // Explicit index path: a sibling .smithers/agents.ts scaffolded by Smithers
  // would otherwise shadow the .smithers/agents/ directory under bun.
  assert.match(workflowSource, /import \* as projectAgents from "\.\.\/agents\/index\.ts";/);
  assert.doesNotMatch(workflowSource, /import \* as projectAgents from "\.\.\/agents";/);
  assert.match(workflowSource, /agent=\{agentForTask\(task\)\}/);
  assert.match(workflowSource, /addDir:\s*\[task\.artifactDir\]/);
  assert.match(workflowSource, /prompt\.replaceAll\(task\.artifactDir, mirroredArtifactDir\(task\)\)/);
  assert.match(workflowSource, /path\.join\(task\.workspacePath, "artifacts", task\.attemptId\)/);
  assert.match(workflowSource, /taskArtifactRoots\(task, artifactDir\)/);
  assert.match(workflowSource, /lstatSync\(candidate\)/);
  assert.match(workflowSource, /function isMissingPathError/);
  assert.match(workflowSource, /function prepareArtifactMirror/);
  assert.match(workflowSource, /function canonicalEmptyArtifact/);
  assert.match(workflowSource, /output\.primary && output\.contract !== "ultrafuzz\/findings@1"/);
  assert.match(workflowSource, /artifactContractDefinition\(output\.contract\)\.validEmptyExample/);
  assert.match(workflowSource, /function artifactAwareAgent/);
  assert.match(workflowSource, /const result = await agent\.generate\(args\);[\s\S]*?prepareArtifactMirror\(task\);/);
  assert.match(workflowSource, /materializeMissingMarkdownArtifacts\(task, result\)/);
  assert.match(workflowSource, /normalizeLegacyFindingFields\(task\)/);
  assert.match(workflowSource, /normalizeLegacyReportProvenance\(task\)/);
  assert.match(workflowSource, /normalizeLegacyGeneratedTestManifests\(task\)/);
  assert.match(workflowSource, /materializeGeneratedTestCompanions\(task\)/);
  assert.match(workflowSource, /const directSourceCandidate = path\.resolve\(workspaceRoot, "test", "foundry"/);
  assert.match(workflowSource, /path\.resolve\(workspaceRoot, "test", "foundry", nodeId, workspaceRelativePath\)/);
  assert.match(workflowSource, /typeof entry === "string" \? \{ path: entry \} : entry/);
  assert.match(workflowSource, /typeof finding\.confidence === "number"/);
  assert.match(workflowSource, /finding\.confidence = String\(finding\.confidence\)/);
  assert.match(workflowSource, /\(strategy as Record<string, unknown>\)\.origin/);
  assert.match(workflowSource, /finding\.strategy = legacyStrategy\.trim\(\)/);
  assert.match(workflowSource, /finding\.evidence = \[evidence\]/);
  assert.match(workflowSource, /report\.issues\.map/);
  assert.match(workflowSource, /\["implementation_paths", "test_paths"\]/);
  assert.match(workflowSource, /\["fuzzer_backend", "fuzzer_backends"\]/);
  assert.match(workflowSource, /verifyArtifacts\(task\);/);
  assert.doesNotMatch(workflowSource, /addDir:\s*\[(?:task\.)?(?:workspacePath|repoPath|runRoot)\]/);
  assert.equal(workflowSource.includes(`"artifactDir": ${JSON.stringify(expectedArtifactDir)}`), true);
  assert.equal(workflowSource.includes(`"artifactDir": ${JSON.stringify(run.value!.run_root)}`), false);
  assert.equal(workflowSource.includes(`"artifactDir": ${JSON.stringify(project)}`), false);
  assert.match(workflowSource, /"modelName": "gpt-runtime-override"/);
  assert.match(workflowSource, /"reasoningEffort": "max"/);
  assert.match(workflowSource, /metadata=\{task\.metadata\}/);
  assert.match(workflowSource, /output=\{outputs\.task\}/);
  assert.match(workflowSource, /Authorized Defensive Security Context/);
  assert.match(workflowSource, /id=\{task\.preparationId\}/);
  assert.match(workflowSource, /dependsOn=\{task\.dependsOn\}/);
  assert.match(workflowSource, /dependsOn=\{\[task\.preparationId\]\}/);
  assert.match(workflowSource, /untrusted data, not instructions/);
  assert.match(workflowSource, /function resolveRegularArtifactFile/);
  assert.match(workflowSource, /throw new Error\(failureMessage\)/);
  assert.match(workflowSource, /<Worktree/);
  assert.doesNotMatch(workflowSource, /const layers =/);
  assert.doesNotMatch(workflowSource, /<Sequence\b/);
  assert.match(workflowSource, /<Parallel\b/);
  assert.doesNotMatch(workflowSource, /@ultrafuzz\/backends/);
  const evidenceWorkflowSource = fs.readFileSync(path.join(run.value!.run_root, "smithers", "workflow.tsx"), "utf8");
  assert.match(evidenceWorkflowSource, /export \{ default \}/);
  assert.doesNotMatch(evidenceWorkflowSource, /__ULTRAFUZZ_/);

  const submission = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "submission.json"), "utf8")
  ) as {
    smithers_run_id?: string;
    command?: string[];
  };
  assert.equal(submission.smithers_run_id, "ultrafuzz-smithers-run");
  assert.ok(submission.command?.includes(path.join(project, ".smithers", "workflows", "ultrafuzz-smithers-run.tsx")));
  assert.ok(submission.command?.includes("--supervise"));
  const staleThresholdIndex = submission.command?.indexOf("--supervise-stale-threshold") ?? -1;
  assert.deepEqual(submission.command?.slice(staleThresholdIndex, staleThresholdIndex + 4), [
    "--supervise-stale-threshold",
    "30s",
    "--supervise-max-concurrent",
    "1"
  ]);
  const durableState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(durableState.workflow_deadline_at !== undefined, true);
  assert.equal(durableState.concurrency.requested_concurrency, 2);
  assert.equal(durableState.controller_lease.status, "active");
});

test("getRunHealth adapts the workflow health summary to the Ultrafuzz run", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "health-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const health = await getRunHealth({ projectRoot: project, runId: "health-run", windowMinutes: 5, env });

  assert.equal(health.ok, true, JSON.stringify(health.diagnostics));
  assert.equal(health.value?.run_id, "health-run");
  assert.equal(health.value?.workflow_run_id, "ultrafuzz-health-run");
  assert.equal(health.value?.verdict, "running-healthy");
  assert.equal(health.value?.counts.in_progress, 1);
  assert.equal(health.value?.model_mix[0]?.quota_parked, false);
  assert.equal(health.value?.gating[0]?.node_id, "project-discovery");
  assert.doesNotMatch(JSON.stringify(health.value), /smithers/iu);
  assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /status ultrafuzz-health-run --window 5/);
});

test("pauseRun accepts the workflow runner pause-request exit and is idempotent once paused", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "pause-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const requested = await pauseRun({ projectRoot: project, runId: "pause-run", env });
  assert.equal(requested.ok, true, JSON.stringify(requested.diagnostics));
  assert.equal(requested.value?.status, "pause-requested");
  assert.equal(requested.value?.submitted, true);

  env.SMITHERS_FAKE_ALREADY_PAUSED = "1";
  const paused = await pauseRun({ projectRoot: project, runId: "pause-run", env });
  assert.equal(paused.ok, true, JSON.stringify(paused.diagnostics));
  assert.equal(paused.value?.status, "paused");
  assert.equal(paused.value?.submitted, false);
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status: string;
  };
  assert.equal(state.status, "paused");
  assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /pause ultrafuzz-pause-run --format json/);
});

test("pauseRun requires explicit workflow confirmation before persisting paused state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "pause-empty", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  env.SMITHERS_FAKE_PAUSE_EMPTY_SUCCESS = "1";
  const requested = await pauseRun({ projectRoot: project, runId: "pause-empty", env });

  assert.equal(requested.ok, true, JSON.stringify(requested.diagnostics));
  assert.equal(requested.value?.status, "pause-requested");
  assert.equal(requested.value?.submitted, true);
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status: string;
  };
  assert.equal(state.status, "running");
});

test("workflow synchronization preserves the paused run state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const launchEnv = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "paused-sync", env: launchEnv });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-paused-sync",
      status: "paused",
      state: "paused",
      steps: [{ id: "node:project-discovery", state: "pending" }]
    })
  });

  const status = await getRunStatus({ projectRoot: project, runId: "paused-sync", env });

  assert.equal(status.ok, true, JSON.stringify(status.diagnostics));
  assert.equal(status.value?.status, "paused");
  assert.equal(status.value?.workflow?.status, "paused");
});

test("workflow synchronization preserves a quota-waiting run with parked tasks", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const launchEnv = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "quota-waiting-sync", env: launchEnv });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-quota-waiting-sync",
      status: "waiting-quota",
      state: "waiting-quota",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    })
  });

  const status = await getRunStatus({ projectRoot: project, runId: "quota-waiting-sync", env });

  assert.equal(status.ok, true, JSON.stringify(status.diagnostics));
  assert.equal(status.value?.status, "running");
  assert.equal(status.value?.workflow?.status, "waiting-quota");
});

test("startRun maps keep_workspaces to the Smithers worktree retention environment", async () => {
  for (const keepWorkspaces of [false, true]) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    if (keepWorkspaces) {
      const configPath = path.join(project, "ultrafuzz.toml");
      fs.writeFileSync(
        configPath,
        fs.readFileSync(configPath, "utf8").replace("keep_workspaces = false", "keep_workspaces = true"),
        "utf8"
      );
    }
    const keepLog = path.join(project, "keep-worktrees.log");
    const env = {
      ...fakeSmithersEnv(project),
      SMITHERS_KEEP_WORKTREES: "1",
      SMITHERS_FAKE_KEEP_WORKTREES_LOG: keepLog
    };

    const run = await startRun({ projectRoot: project, runId: `keep-workspaces-${keepWorkspaces}`, env });

    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    assert.equal(fs.readFileSync(keepLog, "utf8"), keepWorkspaces ? "1\n" : "\n");
  }
});

test("startRun injects the configured Forge guard into the workflow environment and metadata", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const binDir = path.dirname(env.SMITHERS_BIN!);
  const realForge = path.join(binDir, "forge");
  fs.writeFileSync(realForge, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(realForge, 0o755);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("forge_vmem_limit_kb = 12582912", "forge_vmem_limit_kb = 16777216")
      .replace("forge_rayon_threads = 1", "forge_rayon_threads = 2"),
    "utf8"
  );
  const guardLog = path.join(project, "forge-guard.log");
  env.SMITHERS_FAKE_FORGE_GUARD_LOG = guardLog;

  const run = await startRun({ projectRoot: project, runId: "forge-guard", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const wrapper = path.join(run.value!.run_root, "safe-bin", "forge");
  assert.equal(fs.readFileSync(guardLog, "utf8"), `${wrapper}\n`);
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o700);
  assert.match(
    fs.readFileSync(path.join(run.value!.run_root, "config.resolved.toml"), "utf8"),
    /forge_vmem_limit_kb = 16777216/u
  );
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    forge_guard?: Record<string, unknown>;
  };
  assert.deepEqual(metadata.forge_guard, {
    enabled: true,
    active: true,
    virtual_memory_limit_kb: 16_777_216,
    rayon_threads: 2
  });
});

test("startRun forwards configured and explicitly allowed environment variables only", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const environmentLog = path.join(project, "smithers-environment.log");
  const contextLog = path.join(project, "smithers-context.log");
  const env = {
    ...fakeSmithersEnv(project),
    SMITHERS_FAKE_ENV_LOG: environmentLog,
    SMITHERS_FAKE_CONTEXT_LOG: contextLog,
    SMITHERS_RUN_ID: "outer-run",
    SMITHERS_NODE_ID: "outer-node",
    SMITHERS_ATTEMPT: "3",
    SMITHERS_ITERATION: "2",
    SMITHERS_CLI_SRC_DIR: "/outer/cli/src",
    SMITHERS_SNAPSHOT_SOCK: "/outer/snapshot.sock",
    OPENAI_API_KEY: "configured-agent-key",
    AWS_SECRET_ACCESS_KEY: "unrelated-host-key",
    FOUNDRY_PROFILE: "ci",
    ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "FOUNDRY_PROFILE"
  };

  const run = await startRun({ projectRoot: project, runId: "filtered-environment", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(environmentLog, "utf8"), "configured-agent-key||ci\n");
  assert.equal(fs.readFileSync(contextLog, "utf8"), "|||||\n");
});

test("startRun forwards cloud provider credentials through the Smithers environment filter", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    `${fs
      .readFileSync(configPath, "utf8")
      .replace('[execution]\nmode = "local"', '[execution]\nmode = "cloud"\nprovider = "modal"')}

[execution.providers.modal]
app = "ultrafuzz-test"
image = "ultrafuzz-test"
credential_env = ["UFZ_PROVIDER_ONE", "UFZ_PROVIDER_TWO"]
`,
    "utf8"
  );
  const cloudEnvironmentLog = path.join(project, "smithers-cloud-environment.log");
  const env = {
    ...fakeSmithersEnv(project),
    SMITHERS_FAKE_CLOUD_ENV_LOG: cloudEnvironmentLog,
    OPENAI_API_KEY: "configured-agent-key",
    UFZ_PROVIDER_ONE: "provider-one",
    UFZ_PROVIDER_TWO: "provider-two"
  };

  const run = await startRun({ projectRoot: project, runId: "cloud-environment", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(cloudEnvironmentLog, "utf8"), "provider-one|provider-two\n");
});

test("startRun forwards Kimi-specific runtime environment without exposing unrelated secrets", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const kimiEnvironmentLog = path.join(project, "smithers-kimi-environment.log");
  const env = {
    ...fakeSmithersEnv(project),
    SMITHERS_FAKE_KIMI_ENV_LOG: kimiEnvironmentLog,
    KIMI_BASE_URL: "https://kimi.example.invalid/v1",
    ULTRAFUZZ_KIMI_SHARED_AUTH_HOME: "/data/run/kimi-code-auth",
    ULTRAFUZZ_KIMI_SESSION_HOME: "/data/run/kimi-code-sessions",
    ULTRAFUZZ_MODAL_REMOTE_ROOT: "/data/run",
    AWS_SECRET_ACCESS_KEY: "unrelated-host-key"
  };

  const run = await startRun({ projectRoot: project, runId: "kimi-subscription-environment", agent: "KimiAgent", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(
    fs.readFileSync(kimiEnvironmentLog, "utf8"),
    "||https://kimi.example.invalid/v1|/data/run/kimi-code-auth|/data/run/kimi-code-sessions|/data/run\n"
  );
});

test("startRun forwards Moonshot fallback credentials for Kimi API-key auth", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace(
        '[agents.KimiAgent]\nauth = "subscription"',
        '[agents.KimiAgent]\nauth = "api-key"\napi_key_env = "KIMI_API_KEY"'
      ),
    "utf8"
  );
  const kimiEnvironmentLog = path.join(project, "smithers-kimi-api-environment.log");

  const run = await startRun({
    projectRoot: project,
    runId: "kimi-api-environment",
    agent: "KimiAgent",
    env: {
      ...fakeSmithersEnv(project),
      SMITHERS_FAKE_KIMI_ENV_LOG: kimiEnvironmentLog,
      MOONSHOT_API_KEY: "moonshot-fallback-key",
      KIMI_BASE_URL: "https://kimi.example.invalid/v1"
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(
    fs.readFileSync(kimiEnvironmentLog, "utf8"),
    "|moonshot-fallback-key|https://kimi.example.invalid/v1|||\n"
  );
});

test("startRun keeps operational input usable while redacting durable workflow evidence", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  const commandLog = path.join(project, "smithers-command.log");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" > "$SMITHERS_FAKE_LOG"',
      "printf '%s\\n' 'submission api_key=sk-successstdout'",
      "printf '%s\\n' 'submission token=sk-successstderr' >&2",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);

  const run = await startRun({
    projectRoot: project,
    runId: "redacted-evidence",
    prompt: "Operator token=sk-operatorsecret",
    workflowInput: { nested: { api_key: "sk-nestedsecret" }, note: "retain" },
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_BIN: smithers,
      SMITHERS_FAKE_LOG: commandLog
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const operationalCommand = fs.readFileSync(commandLog, "utf8");
  assert.match(operationalCommand, /sk-operatorsecret/);
  assert.match(operationalCommand, /sk-nestedsecret/);

  const inputEvidence = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "input.json"), "utf8")
  ) as {
    operator_prompt?: string;
    operator_input?: { nested?: { api_key?: string }; note?: string };
  };
  assert.equal(inputEvidence.operator_prompt, "Operator token=<redacted>");
  assert.equal(inputEvidence.operator_input?.nested?.api_key, "<redacted>");
  assert.equal(inputEvidence.operator_input?.note, "retain");

  const submissionEvidence = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "submission.json"), "utf8")
  ) as { command?: string[]; stdout?: string; stderr?: string };
  assert.equal(submissionEvidence.stdout, "submission api_key=<redacted>\n");
  assert.equal(submissionEvidence.stderr, "submission token=<redacted>\n");
  const inputArgumentIndex = submissionEvidence.command?.indexOf("--input") ?? -1;
  assert.equal(submissionEvidence.command?.[inputArgumentIndex + 1], "<redacted>");
  assert.doesNotMatch(JSON.stringify(submissionEvidence), /sk-(?:operator|nested|success)/);
});

test("startRun submits prompt paths instead of rendered prompt bodies", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const marker = "ULTRAFUZZ_LARGE_PROMPT_BODY";
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
    `---
id: project-discovery
display_name: Project Discovery
---

${`${marker} `.repeat(2000)}
`,
    "utf8"
  );
  const env = fakeSmithersEnv(project);

  const run = await startRun({
    projectRoot: project,
    runId: "compact-input-run",
    env
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const commandLog = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.doesNotMatch(commandLog, new RegExp(marker));
  assert.ok(commandLog.length < 64_000, `expected compact Smithers command, got ${commandLog.length} bytes`);

  const smithersInput = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "input.json"), "utf8")
  ) as { tasks?: Array<{ prompt?: string; prompt_path?: string }> };
  assert.equal(smithersInput.tasks?.[0]?.prompt, undefined);
  assert.match(smithersInput.tasks?.[0]?.prompt_path ?? "", /prompt\.rendered\.md$/);
  const workflowSource = fs.readFileSync(
    path.join(project, ".smithers", "workflows", "ultrafuzz-compact-input-run.tsx"),
    "utf8"
  );
  assert.match(workflowSource, new RegExp(marker));
});

test("startRun resolves the target-local Smithers binary when it is not on PATH", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "local-smithers.log");
  writeFakeInstalledSmithers(project);

  const run = await startRun({
    projectRoot: project,
    runId: "local-smithers-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(logPath, "utf8"), /up .*ultrafuzz-local-smithers-run\.tsx/);
});

test("startRun patches the pinned CLI cold detached lifecycle", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "patched-admission-smithers.log");
  writeFakeInstalledSmithers(project);
  const cliRoot = path.join(project, ".smithers", "node_modules", "@smithers-orchestrator", "cli");
  const admissionSource = path.join(cliRoot, "src", "detached-admission.js");
  const cliSource = path.join(cliRoot, "src", "index.js");
  fs.mkdirSync(path.dirname(admissionSource), { recursive: true });
  fs.writeFileSync(
    path.join(cliRoot, "package.json"),
    `${JSON.stringify({ name: "@smithers-orchestrator/cli", version: SMITHERS_ORCHESTRATOR_VERSION })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    cliSource,
    [
      '        const supervisor = spawn("bun", supervisorArgs, {',
      "          detached: true,",
      '          stdio: ["ignore", fd, fd],',
      "          env: process.env,",
      "        });",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    admissionSource,
    [
      'export const DETACHED_ADMISSION_NONCE_ENV = "SMITHERS_DETACHED_ADMISSION_NONCE";',
      "export const DETACHED_ADMISSION_TIMEOUT_MS = 30_000;",
      ""
    ].join("\n"),
    "utf8"
  );

  const run = await startRun({
    projectRoot: project,
    runId: "patched-admission-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(admissionSource, "utf8"), /DETACHED_ADMISSION_TIMEOUT_MS = 300_000/u);
  assert.doesNotMatch(fs.readFileSync(admissionSource, "utf8"), /DETACHED_ADMISSION_TIMEOUT_MS = 30_000;/u);
  assert.match(fs.readFileSync(cliSource, "utf8"), /const supervisorFd = openSync\(logFile, "a"\)/u);
  assert.match(fs.readFileSync(cliSource, "utf8"), /stdio: \["ignore", supervisorFd, supervisorFd\]/u);
  assert.doesNotMatch(fs.readFileSync(cliSource, "utf8"), /stdio: \["ignore", fd, fd\]/u);
});

test("startRun accepts the published Smithers bin target with its leading dot segment", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "published-smithers.log");
  writeFakeInstalledSmithers(project, { binTarget: `./${SMITHERS_ORCHESTRATOR_BIN_PATH}` });

  const run = await startRun({
    projectRoot: project,
    runId: "published-smithers-bin-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(logPath, "utf8"), /up .*ultrafuzz-published-smithers-bin-run\.tsx/);
});

test("startRun accepts a package-manager package link and regular command shim inside node_modules", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "pnpm-smithers.log");
  const paths = writeFakePnpmInstalledSmithers(project);

  const run = await startRun({
    projectRoot: project,
    runId: "pnpm-smithers-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.realpathSync(paths.packageRoot).includes(`${path.sep}.pnpm${path.sep}`), true);
  assert.match(fs.readFileSync(logPath, "utf8"), /up .*ultrafuzz-pnpm-smithers-run\.tsx/);
});

test("startRun bootstraps target-local Smithers dependencies when missing", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const installer = writeFakeNpmInstaller(project);

  const run = await startRun({
    projectRoot: project,
    runId: "bootstrap-smithers-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install .*--prefix .*\.smithers/);
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /--ignore-scripts/);
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /--package-lock=false/);
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /--registry=https:\/\/registry\.npmjs\.org/);
  assert.match(fs.readFileSync(installer.smithersLogPath, "utf8"), /up .*ultrafuzz-bootstrap-smithers-run\.tsx/);
});

test("startRun migrates the known generated Smithers caret manifest without dropping custom fields", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const packageJson = path.join(project, ".smithers", "package.json");
  fs.writeFileSync(
    packageJson,
    `${JSON.stringify(
      {
        name: "ultrafuzz-smithers",
        private: true,
        type: "module",
        scripts: { custom: "node custom.js" },
        dependencies: {
          "smithers-orchestrator": "^0.27.0",
          zod: "^4.4.3",
          "custom-agent-package": "1.2.3"
        },
        devDependencies: { typescript: "^6.0.3", "custom-build-package": "2.3.4" }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeFakeInstalledSmithers(project);
  const logPath = path.join(project, "local-smithers.log");

  const run = await startRun({
    projectRoot: project,
    runId: "migrated-smithers-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const migrated = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    scripts: { custom: string };
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(migrated.dependencies["smithers-orchestrator"], SMITHERS_ORCHESTRATOR_VERSION);
  assert.equal(migrated.dependencies["@moonshot-ai/kimi-code"], KIMI_CODE_VERSION);
  assert.equal(migrated.dependencies.zod, "4.4.3");
  assert.equal(migrated.devDependencies.typescript, "6.0.3");
  assert.equal(migrated.dependencies["custom-agent-package"], "1.2.3");
  assert.equal(migrated.devDependencies["custom-build-package"], "2.3.4");
  assert.equal(migrated.scripts.custom, "node custom.js");
});

test("startRun migrates the previous exact Smithers manifest without dropping custom fields", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const packageJson = path.join(project, ".smithers", "package.json");
  const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  manifest.dependencies["smithers-orchestrator"] = "0.29.0";
  manifest.dependencies["custom-agent-package"] = "1.2.3";
  fs.writeFileSync(packageJson, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFakeInstalledSmithers(project, { version: "0.29.0" });
  const installer = writeFakeNpmInstaller(project);

  const run = await startRun({
    projectRoot: project,
    runId: "migrated-exact-smithers-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const migrated = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(migrated.dependencies["smithers-orchestrator"], SMITHERS_ORCHESTRATOR_VERSION);
  assert.equal(migrated.dependencies["@moonshot-ai/kimi-code"], KIMI_CODE_VERSION);
  assert.equal(migrated.dependencies["custom-agent-package"], "1.2.3");
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install/u);
});

test("startRun reinstalls a stale target-local Smithers package before launch", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  writeFakeInstalledSmithers(project, { version: "0.26.0" });
  const installer = writeFakeNpmInstaller(project);

  const run = await startRun({
    projectRoot: project,
    runId: "stale-smithers-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install/u);
  const installed = JSON.parse(fs.readFileSync(fakeInstalledSmithersPaths(project).packageJson, "utf8")) as {
    version: string;
  };
  assert.equal(installed.version, SMITHERS_ORCHESTRATOR_VERSION);
});

test("startRun repairs a target-local Smithers shim that points outside the pinned package", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const paths = fakeInstalledSmithersPaths(project);
  const wrongTarget = path.join(project, ".smithers", "node_modules", "wrong-smithers.js");
  fs.mkdirSync(path.dirname(wrongTarget), { recursive: true });
  fs.writeFileSync(wrongTarget, "#!/bin/sh\nexit 91\n", "utf8");
  writeFakeInstalledSmithers(project, { shimTarget: wrongTarget });
  const installer = writeFakeNpmInstaller(project);

  const run = await startRun({
    projectRoot: project,
    runId: "repaired-smithers-shim-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install/u);
  assert.equal(fs.realpathSync(paths.shim), fs.realpathSync(paths.target));
});

test("generated workflow dependencies require exact runner versions while allowing custom packages", () => {
  assert.throws(
    () =>
      assertSmithersPackageManifest({
        dependencies: {
          "smithers-orchestrator": "^0.27.0",
          zod: "4.4.3"
        },
        devDependencies: { typescript: "6.0.3" }
      }),
    /must retain Ultrafuzz's exact runner versions/u
  );
  assert.doesNotThrow(() =>
    assertSmithersPackageManifest({
      dependencies: {
        "@moonshot-ai/kimi-code": KIMI_CODE_VERSION,
        "smithers-orchestrator": SMITHERS_ORCHESTRATOR_VERSION,
        zod: "4.4.3",
        "custom-agent-package": "1.2.3"
      },
      devDependencies: { typescript: "6.0.3" }
    })
  );
});

test("startRun creates the workflow log directory before submission", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      "log_dir=''",
      'while [ "$#" -gt 0 ]; do',
      "  if [ \"$1\" = '--log-dir' ]; then",
      "    shift",
      '    log_dir="$1"',
      "  fi",
      "  shift",
      "done",
      'if [ ! -d "$log_dir" ]; then',
      "  printf '%s\\n' \"missing log dir: $log_dir\" >&2",
      "  exit 43",
      "fi",
      "printf '%s\\n' '{\"ok\":true}'",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);

  const run = await startRun({
    projectRoot: project,
    runId: "log-dir-run",
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SMITHERS_BIN: smithers }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.existsSync(path.join(run.value!.run_root, "smithers", "logs")), true);
});

test("startRun includes bounded workflow runner stdio when submission fails", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      "printf '%s\\n' 'submission stdout detail api_key=sk-stdoutsecret'",
      "printf '%s\\n' 'submission stderr detail token=sk-stderrsecret' >&2",
      "exit 42",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);

  const run = await startRun({
    projectRoot: project,
    runId: "failed-submit",
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SMITHERS_BIN: smithers }
  });

  assert.equal(run.ok, false);
  const diagnostic = run.diagnostics.find((entry) => entry.code === "WORKFLOW_SUBMISSION_FAILED");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /submission stdout detail/);
  assert.match(diagnostic.message, /submission stderr detail/);
  assert.doesNotMatch(diagnostic.message, /sk-(stdout|stderr)secret/);
  assert.match(diagnostic.message, /<redacted>/);
  assert.equal(diagnostic.details?.exit_code, 42);
  assert.equal(diagnostic.details?.stdout, "submission stdout detail api_key=<redacted>\n");
  assert.equal(diagnostic.details?.stderr, "submission stderr detail token=<redacted>\n");
});

test("syncRun marks successful workflow completion, normalizes findings, and writes manifests", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-success";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-success", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-success", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status?: string;
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  const findings = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "findings.json"), "utf8")
  ) as Array<{ source_node_id?: string }>;
  assert.equal(findings[0]?.source_node_id, "project-discovery");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json"), "utf8")
  ) as {
    files?: Array<{ path?: string }>;
  };
  assert.deepEqual(manifest.files?.map((entry) => entry.path).sort(), [
    "findings.json",
    "prompt.rendered.md",
    "setup/project-discovery.md"
  ]);
  const events = fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8");
  assert.match(events, /findings-normalized/);
  assert.match(events, /artifact-manifest-written/);
});

test("syncRun marks task-output validation failures for terminal disposition", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-invalid-output";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-invalid-output", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  fs.writeFileSync(
    path.join(run.value!.run_root, "artifacts", "project-discovery", "findings.json"),
    `${JSON.stringify([{ title: "incomplete output" }])}\n`,
    "utf8"
  );

  const sync = await syncRun({ projectRoot: project, runId: "sync-invalid-output", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: Record<string, unknown> }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.deepEqual(state.nodes?.["project-discovery"]?.provenance?.terminal_disposition, {
    schema_version: "ultrafuzz.terminal-disposition.v1",
    kind: "task-output-validation-failure"
  });
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    true
  );

  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const manifestPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json");
  fs.rmSync(manifestPath);
  fs.mkdirSync(manifestPath);

  const operational = await syncRun({ projectRoot: project, runId: "sync-invalid-output", env });

  assert.equal(operational.ok, true, JSON.stringify(operational.diagnostics));
  assert.equal(operational.value?.status, "failed");
  assert.ok(operational.diagnostics.some((diagnostic) => diagnostic.source === "artifacts"));
  const operationalState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { provenance?: Record<string, unknown> }>;
  };
  assert.equal(operationalState.nodes?.["project-discovery"]?.provenance?.terminal_disposition, undefined);
});

test("syncRun persists cumulative token accounting and partial pricing from workflow events", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const source = await startRun({
    projectRoot: project,
    runId: "source-accounting",
    env: fakeSmithersEnv(project)
  });
  assert.equal(source.ok, true, JSON.stringify(source.diagnostics));
  const sourceMetadataPath = path.join(source.value!.run_root, "run.json");
  const sourceMetadata = JSON.parse(fs.readFileSync(sourceMetadataPath, "utf8")) as Record<string, unknown>;
  // 0.1 + 0.2 exercises cumulative USD rounding instead of leaking binary float tails.
  fs.writeFileSync(
    sourceMetadataPath,
    `${JSON.stringify(
      {
        ...sourceMetadata,
        accounting: {
          schema_version: "1.0",
          source: "workflow-events",
          workflow_run_id: "ultrafuzz-source-accounting",
          current: {
            input_tokens: 40,
            output_tokens: 60,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 100,
            tokens_used: "100",
            estimated_spend: "$0.10",
            estimated_spend_usd: 0.1,
            partial_pricing: false,
            event_count: 1,
            priced_event_count: 1,
            unpriced_event_count: 0,
            models: ["source-model"],
            agents: ["codex"]
          },
          cumulative: {
            input_tokens: 40,
            output_tokens: 60,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 100,
            tokens_used: "100",
            estimated_spend: "$0.10",
            estimated_spend_usd: 0.1,
            partial_pricing: false,
            event_count: 1,
            priced_event_count: 1,
            unpriced_event_count: 0,
            models: ["source-model"],
            agents: ["codex"],
            source_run_ids: []
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const workflowRunId = "ultrafuzz-lineage-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0.2,
          model: "gpt-test",
          agent: "codex"
        }
      },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 5,
          model: "gpt-test",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({
    projectRoot: project,
    runId: "lineage-accounting",
    sourceRunId: "source-accounting",
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "lineage-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { tokens_used?: string; estimated_spend?: string; partial_pricing?: boolean };
      cumulative?: {
        tokens_used?: string;
        estimated_spend?: string;
        estimated_spend_usd?: number;
        partial_pricing?: boolean;
        source_run_ids?: string[];
      };
    };
  };
  assert.equal(metadata.accounting?.current?.tokens_used, "35");
  assert.equal(metadata.accounting?.current?.estimated_spend, "$0.20+");
  assert.equal(metadata.accounting?.current?.partial_pricing, true);
  assert.equal(metadata.accounting?.cumulative?.tokens_used, "135");
  assert.equal(metadata.accounting?.cumulative?.estimated_spend, "$0.30+");
  assert.equal(metadata.accounting?.cumulative?.estimated_spend_usd, 0.3);
  assert.equal(metadata.accounting?.cumulative?.partial_pricing, true);
  assert.deepEqual(metadata.accounting?.cumulative?.source_run_ids, ["source-accounting"]);
});

test("syncRun preserves generated usage across checkpoint generations and replays idempotently", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-generated-usage";
  const inspect = workflowInspect({
    workflowRunId,
    steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
  });
  const generatedSegment = (generation: string, inputTokens: number, outputTokens: number, costUsd: number) =>
    workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: generation,
          inputTokens,
          outputTokens,
          costUsd,
          model: "generated-model",
          agent: "generated-agent"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ]);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect,
    events: generatedSegment("generation-1", 10, 5, 0.01)
  });
  const run = await startRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const first = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  const generatedEventsPath = path.join(project, "fake-smithers-events.ndjson");
  fs.writeFileSync(generatedEventsPath, generatedSegment("generation-2", 20, 10, 0.02), "utf8");
  const second = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  const replayed = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));

  fs.writeFileSync(
    generatedEventsPath,
    workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "generation-3",
          inputTokens: "malformed",
          model: "generated-model",
          agent: "generated-agent"
        }
      },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "generation-3",
          model: "generated-model",
          agent: "generated-agent"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ]),
    "utf8"
  );
  const incomplete = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(incomplete.ok, true, JSON.stringify(incomplete.diagnostics));

  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        tokens_used?: string;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string }>;
        pricing_complete?: boolean;
      };
      segments?: Array<{
        checkpoint_generation_id?: string;
        total_tokens?: number;
        event_count?: number;
      }>;
      cumulative?: { total_tokens?: number; event_count?: number; usage_complete?: boolean };
      checkpoint?: { ledger_event_count?: number; checkpoint_generation_id?: string };
    };
  };
  const segments = metadata.accounting?.segments ?? [];
  assert.deepEqual(
    segments.map((segment) => [segment.checkpoint_generation_id, segment.total_tokens, segment.event_count]),
    [
      ["generation-1", 15, 1],
      ["generation-2", 30, 1],
      ["generation-3", 0, 2]
    ]
  );
  assert.equal(
    segments.reduce((total, segment) => total + (segment.total_tokens ?? 0), 0),
    metadata.accounting?.cumulative?.total_tokens
  );
  assert.equal(metadata.accounting?.cumulative?.total_tokens, 45);
  assert.equal(metadata.accounting?.cumulative?.event_count, 4);
  assert.equal(metadata.accounting?.current?.tokens_used, "0");
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.deepEqual(
    new Set(metadata.accounting?.current?.usage_incomplete_reasons?.map((reason) => reason.code)),
    new Set(["usage-malformed", "usage-missing"])
  );
  assert.equal(metadata.accounting?.current?.pricing_complete, false);
  assert.equal(metadata.accounting?.cumulative?.usage_complete, false);
  assert.equal(metadata.accounting?.checkpoint?.ledger_event_count, 4);
  assert.equal(metadata.accounting?.checkpoint?.checkpoint_generation_id, "generation-3");
  assert.equal(
    fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8").trim().split("\n").length,
    4,
    "replaying a continuation must not duplicate generated usage"
  );
});

test("syncRun keeps colliding checkpoint names separate across workflow runs", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const firstWorkflowRunId = "ultrafuzz-colliding-generation";
  const secondWorkflowRunId = "ultrafuzz-colliding-generation-fork";
  const usageEvents = (workflowRunId: string, inputTokens: number) =>
    workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "generation-shared",
          inputTokens,
          costUsd: inputTokens / 1_000,
          model: "generated-model",
          agent: "generated-agent"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ]);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: firstWorkflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: usageEvents(firstWorkflowRunId, 10)
  });
  const run = await startRun({ projectRoot: project, runId: "colliding-generation", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const first = await syncRun({ projectRoot: project, runId: "colliding-generation", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  const metadataPath = path.join(run.value!.run_root, "run.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    workflow?: { run_id?: string };
    [key: string]: unknown;
  };
  metadata.workflow = { ...(metadata.workflow ?? {}), run_id: secondWorkflowRunId };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(project, "fake-smithers-inspect.json"),
    `${JSON.stringify(
      workflowInspect({
        workflowRunId: secondWorkflowRunId,
        steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
      }),
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(project, "fake-smithers-events.ndjson"), usageEvents(secondWorkflowRunId, 20), "utf8");

  const second = await syncRun({ projectRoot: project, runId: "colliding-generation", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  const finalMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    accounting?: {
      current?: { workflow_run_id?: string; total_tokens?: number };
      segments?: Array<{ workflow_run_id?: string; checkpoint_generation_id?: string; total_tokens?: number }>;
      cumulative?: { total_tokens?: number };
      checkpoint?: { workflow_run_id?: string };
    };
  };
  assert.deepEqual(
    finalMetadata.accounting?.segments?.map((segment) => [
      segment.workflow_run_id,
      segment.checkpoint_generation_id,
      segment.total_tokens
    ]),
    [
      [firstWorkflowRunId, "generation-shared", 10],
      [secondWorkflowRunId, "generation-shared", 20]
    ]
  );
  assert.equal(finalMetadata.accounting?.current?.workflow_run_id, secondWorkflowRunId);
  assert.equal(finalMetadata.accounting?.current?.total_tokens, 20);
  assert.equal(finalMetadata.accounting?.cumulative?.total_tokens, 30);
  assert.equal(finalMetadata.accounting?.checkpoint?.workflow_run_id, secondWorkflowRunId);
});

test("syncRun counts cache-only usage when aggregate input is explicitly zero", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-cache-only-usage";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "generation-cache",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 12,
          cacheWriteTokens: 3,
          totalTokens: 0,
          costUsd: 0.000012
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "cache-only-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "cache-only-usage", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        total_tokens?: number;
        cache_read_tokens?: number;
        cache_write_tokens?: number;
        event_count?: number;
        usage_complete?: boolean;
        pricing_complete?: boolean;
        estimated_spend_usd?: number;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.total_tokens, 15);
  assert.equal(metadata.accounting?.current?.cache_read_tokens, 12);
  assert.equal(metadata.accounting?.current?.cache_write_tokens, 3);
  assert.equal(metadata.accounting?.current?.event_count, 1);
  assert.equal(metadata.accounting?.current?.usage_complete, true);
  assert.equal(metadata.accounting?.current?.pricing_complete, false);
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 0.000012);
});

test("syncRun preserves sub-microdollar costs across generation rollups", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-precise-cost-usage";
  const generatedSegment = (generation: string) =>
    workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: generation,
          inputTokens: 1,
          outputTokens: 0,
          costUsd: 0.0000004
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ]);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: generatedSegment("generation-1")
  });
  const run = await startRun({ projectRoot: project, runId: "precise-cost-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const first = await syncRun({ projectRoot: project, runId: "precise-cost-usage", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  fs.writeFileSync(path.join(project, "fake-smithers-events.ndjson"), generatedSegment("generation-2"), "utf8");

  const second = await syncRun({ projectRoot: project, runId: "precise-cost-usage", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      segments?: Array<{ estimated_spend_usd?: number }>;
      cumulative?: { estimated_spend_usd?: number };
    };
  };
  assert.deepEqual(
    metadata.accounting?.segments?.map((segment) => segment.estimated_spend_usd),
    [0.0000004, 0.0000004]
  );
  assert.equal(metadata.accounting?.cumulative?.estimated_spend_usd, 0.0000008);
});

test("syncRun uses durable event sequence for the current accounting segment", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-sequenced-usage";
  const event = (seq: number, timestampMs: number, type: string, payload: Record<string, unknown> = {}) =>
    JSON.stringify({
      runId: workflowRunId,
      seq,
      timestampMs,
      type,
      payload: { runId: workflowRunId, timestampMs, type, ...payload }
    });
  const events = `${[
    event(0, 100, "NodeStarted", { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }),
    event(1, 300, "TokenUsageReported", {
      nodeId: "node:project-discovery",
      iteration: 0,
      attempt: 1,
      checkpointGenerationId: "generation-1",
      inputTokens: 10,
      costUsd: 0.01
    }),
    event(2, 200, "TokenUsageReported", {
      nodeId: "node:project-discovery",
      iteration: 0,
      attempt: 1,
      checkpointGenerationId: "generation-2",
      inputTokens: 20,
      costUsd: 0.02
    }),
    event(3, 400, "NodeFinished", { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }),
    event(4, 500, "RunFinished")
  ].join("\n")}\n`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events
  });
  const run = await startRun({ projectRoot: project, runId: "sequenced-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sequenced-usage", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { checkpoint_generation_id?: string; total_tokens?: number };
      segments?: Array<{ checkpoint_generation_id?: string; total_tokens?: number }>;
    };
  };
  assert.deepEqual(
    metadata.accounting?.segments?.map((segment) => [segment.checkpoint_generation_id, segment.total_tokens]),
    [
      ["generation-1", 10],
      ["generation-2", 20]
    ]
  );
  assert.equal(metadata.accounting?.current?.checkpoint_generation_id, "generation-2");
  assert.equal(metadata.accounting?.current?.total_tokens, 20);
});

test("syncRun assigns unseen implicit usage events to a new checkpoint segment", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-implicit-usage";
  const tokenEvent = (inputTokens: number, outputTokens: number, costUsd: number) => ({
    type: "TokenUsageReported",
    nodeId: "node:project-discovery",
    attempt: 1,
    extra: {
      iteration: 0,
      inputTokens,
      outputTokens,
      costUsd,
      model: "generated-model",
      agent: "generated-agent"
    }
  });
  const firstSegment = [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    tokenEvent(10, 5, 0.01),
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    { type: "RunFinished" }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, firstSegment)
  });
  const run = await startRun({ projectRoot: project, runId: "implicit-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const first = await syncRun({ projectRoot: project, runId: "implicit-usage", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  fs.writeFileSync(
    path.join(project, "fake-smithers-events.ndjson"),
    workflowEvents(workflowRunId, [...firstSegment, tokenEvent(20, 10, 0.02)]),
    "utf8"
  );
  const second = await syncRun({ projectRoot: project, runId: "implicit-usage", env });
  const replayed = await syncRun({ projectRoot: project, runId: "implicit-usage", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));

  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      segments?: Array<{ checkpoint_generation_id?: string; total_tokens?: number; event_count?: number }>;
      cumulative?: { total_tokens?: number; event_count?: number };
    };
  };
  const segments = metadata.accounting?.segments ?? [];
  assert.deepEqual(
    segments.map((segment) => [segment.total_tokens, segment.event_count]),
    [
      [15, 1],
      [30, 1]
    ]
  );
  assert.notEqual(segments[0]?.checkpoint_generation_id, segments[1]?.checkpoint_generation_id);
  assert.equal(metadata.accounting?.cumulative?.total_tokens, 45);
  assert.equal(metadata.accounting?.cumulative?.event_count, 2);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("syncRun propagates malformed-only usage ledger state into cumulative accounting", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-malformed-only-usage";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "malformed-only-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  fs.writeFileSync(path.join(run.value!.run_root, "usage.jsonl"), "{malformed\n", "utf8");

  const sync = await syncRun({ projectRoot: project, runId: "malformed-only-usage", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));

  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { event_count?: number; usage_complete?: boolean; usage_incomplete_reasons?: Array<{ code?: string }> };
      segments?: Array<{ event_count?: number; usage_complete?: boolean }>;
      cumulative?: {
        event_count?: number;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string }>;
      };
      checkpoint?: { malformed_entry_count?: number };
    };
  };
  assert.equal(metadata.accounting?.current?.event_count, 1);
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.equal(metadata.accounting?.segments?.length, 1);
  assert.equal(metadata.accounting?.segments?.[0]?.event_count, 1);
  assert.equal(metadata.accounting?.segments?.[0]?.usage_complete, false);
  assert.equal(metadata.accounting?.cumulative?.event_count, 1);
  assert.equal(metadata.accounting?.cumulative?.usage_complete, false);
  assert.deepEqual(
    metadata.accounting?.current?.usage_incomplete_reasons?.map((reason) => reason.code),
    ["ledger-entry-malformed"]
  );
  assert.deepEqual(
    metadata.accounting?.cumulative?.usage_incomplete_reasons?.map((reason) => reason.code),
    ["ledger-entry-malformed"]
  );
  assert.equal(metadata.accounting?.checkpoint?.malformed_entry_count, 1);
});

test("syncRun records unavailable spend when workflow token events are unpriced", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-unpriced-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 10,
          outputTokens: 20,
          model: "gpt-test",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({
    projectRoot: project,
    runId: "unpriced-accounting",
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "unpriced-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        tokens_used?: string;
        estimated_spend?: string;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string; component?: string; model?: string }>;
        partial_pricing?: boolean;
      };
      cumulative?: { tokens_used?: string; estimated_spend?: string; partial_pricing?: boolean };
    };
  };
  assert.equal(metadata.accounting?.current?.tokens_used, "30");
  assert.equal(metadata.accounting?.current?.estimated_spend, "unavailable");
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.deepEqual(metadata.accounting?.current?.usage_incomplete_reasons, [
    {
      code: "component-usage-unavailable",
      component: "cache_read",
      model: "gpt-test"
    }
  ]);
  assert.equal(metadata.accounting?.current?.partial_pricing, true);
  assert.equal(metadata.accounting?.cumulative?.tokens_used, "30");
  assert.equal(metadata.accounting?.cumulative?.estimated_spend, "unavailable");
  assert.equal(metadata.accounting?.cumulative?.partial_pricing, true);
});

test("syncRun retries transient pricing catalog failures", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-transient-pricing-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 100_000,
          outputTokens: 10_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "gpt-test",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = "data:application/json,%7B";
  const run = await startRun({ projectRoot: project, runId: "transient-pricing-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const failedSync = await syncRun({ projectRoot: project, runId: "transient-pricing-accounting", env });
  assert.equal(failedSync.ok, true, JSON.stringify(failedSync.diagnostics));
  const failedMetadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { estimated_spend?: string };
      pricing_catalog?: { status?: string; unresolved_models?: string[] };
    };
  };
  assert.equal(failedMetadata.accounting?.current?.estimated_spend, "unavailable");
  assert.equal(failedMetadata.accounting?.pricing_catalog?.status, "unavailable");
  assert.deepEqual(failedMetadata.accounting?.pricing_catalog?.unresolved_models, ["gpt-test"]);

  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-test": { cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } }
      }
    }
  });
  const recoveredSync = await syncRun({ projectRoot: project, runId: "transient-pricing-accounting", env });
  assert.equal(recoveredSync.ok, true, JSON.stringify(recoveredSync.diagnostics));
  const recoveredMetadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { estimated_spend?: string; partial_pricing?: boolean };
      pricing_catalog?: { status?: string; resolved_models?: string[]; unresolved_models?: string[] };
    };
  };
  assert.equal(recoveredMetadata.accounting?.current?.estimated_spend, "$0.80");
  assert.equal(recoveredMetadata.accounting?.current?.partial_pricing, false);
  assert.equal(recoveredMetadata.accounting?.pricing_catalog?.status, "available");
  assert.deepEqual(recoveredMetadata.accounting?.pricing_catalog?.resolved_models, ["gpt-test"]);
  assert.deepEqual(recoveredMetadata.accounting?.pricing_catalog?.unresolved_models, []);
});

test("syncRun prices independent usage components when cache reads exceed uncached input", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-estimated-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 100_000,
          outputTokens: 10_000,
          cacheReadTokens: 200_000,
          cacheWriteTokens: 10_000,
          reasoningTokens: 5_000,
          model: "gpt-5.6-sol",
          agent: "codex"
        }
      },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 12,
          cacheWriteTokens: 3,
          totalTokens: 0,
          model: "gpt-5.6-sol",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-5.6-sol": {
          cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 }
        }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "estimated-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "estimated-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        tokens_used?: string;
        inclusive_token_total?: number;
        billable_token_total?: number;
        estimated_spend?: string;
        estimated_spend_usd?: number;
        component_costs_usd?: Record<string, number>;
        usage_complete?: boolean;
        pricing_complete?: boolean;
        partial_pricing?: boolean;
        priced_event_count?: number;
        unpriced_event_count?: number;
      };
      cumulative?: {
        inclusive_token_total?: number;
        billable_token_total?: number;
        estimated_spend_usd?: number;
        component_costs_usd?: Record<string, number>;
      };
      pricing_catalog?: {
        source?: string;
        status?: string;
        resolved_models?: string[];
        model_prices?: Record<string, unknown>;
      };
      updated_at?: string;
    };
  };
  assert.equal(metadata.accounting?.current?.tokens_used, "325,015");
  assert.equal(metadata.accounting?.current?.inclusive_token_total, 325_015);
  assert.equal(metadata.accounting?.current?.billable_token_total, 325_015);
  assert.equal(metadata.accounting?.current?.estimated_spend, "$1.11");
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 1.11252475);
  assert.deepEqual(metadata.accounting?.current?.component_costs_usd, {
    uncached_input: 0.5,
    cache_read: 0.100006,
    cache_write: 0.06251875,
    output: 0.3,
    reasoning: 0.15
  });
  assert.equal(
    Number(
      Object.values(metadata.accounting?.current?.component_costs_usd ?? {})
        .reduce((total, cost) => total + cost, 0)
        .toFixed(12)
    ),
    metadata.accounting?.current?.estimated_spend_usd
  );
  assert.equal(metadata.accounting?.current?.usage_complete, true);
  assert.equal(metadata.accounting?.current?.pricing_complete, true);
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
  assert.equal(metadata.accounting?.current?.priced_event_count, 2);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 0);
  assert.equal(metadata.accounting?.cumulative?.inclusive_token_total, 325_015);
  assert.equal(metadata.accounting?.cumulative?.billable_token_total, 325_015);
  assert.equal(metadata.accounting?.cumulative?.estimated_spend_usd, 1.11252475);
  assert.deepEqual(
    metadata.accounting?.cumulative?.component_costs_usd,
    metadata.accounting?.current?.component_costs_usd
  );
  assert.equal(metadata.accounting?.pricing_catalog?.source, "configured-catalog");
  assert.equal(metadata.accounting?.pricing_catalog?.status, "available");
  assert.deepEqual(metadata.accounting?.pricing_catalog?.resolved_models, ["gpt-5.6-sol"]);
  assert.ok(metadata.accounting?.pricing_catalog?.model_prices?.["gpt-5.6-sol"]);

  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-5.6-sol": {
          cost: { input: 50, output: 300, cache_read: 5, cache_write: 62.5 }
        }
      }
    }
  });
  const resync = await syncRun({ projectRoot: project, runId: "estimated-accounting", env });
  assert.equal(resync.ok, true, JSON.stringify(resync.diagnostics));
  const resyncedMetadata = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")
  ) as typeof metadata;
  assert.equal(resyncedMetadata.accounting?.current?.estimated_spend, "$1.11");
  assert.deepEqual(resyncedMetadata.accounting?.current, metadata.accounting?.current);
  assert.deepEqual(resyncedMetadata.accounting?.cumulative, metadata.accounting?.cumulative);
  assert.equal(resyncedMetadata.accounting?.updated_at, metadata.accounting?.updated_at);
});

test("syncRun records a typed incomplete-pricing reason for a missing component rate", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-component-pricing";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 20_000,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          model: "gpt-component-test",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-component-test": { cost: { input: 5, output: 30, cache_write: 6.25 } }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "component-pricing", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "component-pricing", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        inclusive_token_total?: number;
        billable_token_total?: number;
        estimated_spend?: string;
        estimated_spend_usd?: number;
        component_costs_usd?: Record<string, number>;
        usage_complete?: boolean;
        pricing_complete?: boolean;
        pricing_incomplete_reasons?: Array<{ code?: string; component?: string; model?: string }>;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.inclusive_token_total, 31_000);
  assert.equal(metadata.accounting?.current?.billable_token_total, 11_000);
  assert.equal(metadata.accounting?.current?.estimated_spend, "$0.08+");
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 0.08);
  assert.deepEqual(metadata.accounting?.current?.component_costs_usd, {
    uncached_input: 0.05,
    cache_read: 0,
    cache_write: 0,
    output: 0.03,
    reasoning: 0
  });
  assert.equal(metadata.accounting?.current?.usage_complete, true);
  assert.equal(metadata.accounting?.current?.pricing_complete, false);
  assert.deepEqual(metadata.accounting?.current?.pricing_incomplete_reasons, [
    {
      code: "component-rate-unavailable",
      component: "cache_read",
      model: "gpt-component-test"
    }
  ]);
});

test("syncRun applies context-tier pricing from the live catalog", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-tiered-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 300_000,
          outputTokens: 10_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "gpt-tiered",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-tiered": {
          cost: {
            input: 5,
            output: 30,
            cache_read: 0.5,
            tiers: [
              {
                input: 10,
                output: 45,
                cache_read: 1,
                tier: { type: "context", size: 272_000 }
              }
            ]
          }
        }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "tiered-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "tiered-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: { current?: { tokens_used?: string; estimated_spend?: string; partial_pricing?: boolean } };
  };
  assert.equal(metadata.accounting?.current?.tokens_used, "310,000");
  assert.equal(metadata.accounting?.current?.estimated_spend, "$3.45");
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
});

const MOONSHOT_KIMI_CATALOG = {
  moonshotai: {
    models: {
      "kimi-k3": { cost: { input: 3, output: 15, cache_read: 0.3 } }
    }
  }
};

function kimiTokenUsageEvents(workflowRunId: string): string {
  return workflowEvents(workflowRunId, [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
    {
      type: "TokenUsageReported",
      nodeId: "node:project-discovery",
      attempt: 1,
      extra: {
        iteration: 0,
        // Kimi wire components map 1:1 onto Ultrafuzz's independent components.
        inputTokens: 120_000,
        outputTokens: 8_000,
        cacheReadTokens: 400_000,
        cacheWriteTokens: 20_000,
        model: "kimi-k3",
        agent: "KimiAgent"
      }
    },
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
    { type: "RunFinished" }
  ]);
}

test("syncRun publishes durable Kimi accounting and API-comparison cost at Moonshot rates", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-kimi-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: kimiTokenUsageEvents(workflowRunId)
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl(MOONSHOT_KIMI_CATALOG);
  const run = await startRun({ projectRoot: project, runId: "kimi-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "kimi-accounting", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));

  type KimiAccountingSegment = {
    uncached_input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    reasoning_tokens?: number;
    inclusive_token_total?: number;
    billable_token_total?: number;
    total_tokens?: number;
    estimated_spend?: string;
    estimated_spend_usd?: number;
    component_costs_usd?: Record<string, number>;
    usage_complete?: boolean;
    pricing_complete?: boolean;
    partial_pricing?: boolean;
    pricing_incomplete_reasons?: Array<{ code?: string; component?: string; model?: string }>;
    usage_incomplete_reasons?: unknown[];
    models?: string[];
    agents?: string[];
    event_count?: number;
  };
  const readAccounting = (): {
    current?: KimiAccountingSegment;
    cumulative?: KimiAccountingSegment;
    pricing_catalog?: { resolved_models?: string[]; unresolved_models?: string[] };
    updated_at?: string;
  } =>
    (
      JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
        accounting?: {
          current?: KimiAccountingSegment;
          cumulative?: KimiAccountingSegment;
          pricing_catalog?: { resolved_models?: string[]; unresolved_models?: string[] };
          updated_at?: string;
        };
      }
    ).accounting ?? {};

  const accounting = readAccounting();
  for (const segment of [accounting.current, accounting.cumulative]) {
    assert.ok(segment);
    // The four Kimi components stay independent through the durable ledger.
    assert.equal(segment.uncached_input_tokens, 120_000);
    assert.equal(segment.output_tokens, 8_000);
    assert.equal(segment.cache_read_tokens, 400_000);
    assert.equal(segment.cache_write_tokens, 20_000);
    assert.equal(segment.reasoning_tokens, 0);
    assert.equal(segment.inclusive_token_total, 548_000);
    assert.equal(segment.billable_token_total, 528_000);
    assert.equal(segment.total_tokens, 548_000);
    assert.equal(segment.usage_complete, true);
    assert.deepEqual(segment.usage_incomplete_reasons, []);
    assert.equal(segment.estimated_spend_usd, 0.6);
    assert.notEqual(segment.estimated_spend_usd, null);
    assert.deepEqual(segment.component_costs_usd, {
      uncached_input: 0.36,
      cache_read: 0.12,
      cache_write: 0,
      output: 0.12,
      reasoning: 0
    });
    // Cost is populated; pricing is partial only because the Moonshot catalog
    // entry carries no cache-write rate.
    assert.equal(segment.pricing_complete, false);
    assert.equal(segment.partial_pricing, true);
    assert.deepEqual(segment.pricing_incomplete_reasons, [
      { code: "component-rate-unavailable", component: "cache_write", model: "kimi-k3" }
    ]);
    assert.deepEqual(segment.models, ["kimi-k3"]);
    assert.deepEqual(segment.agents, ["KimiAgent"]);
  }
  assert.equal(accounting.current?.estimated_spend, "$0.60+");
  assert.deepEqual(accounting.pricing_catalog?.resolved_models, ["kimi-k3"]);
  assert.deepEqual(accounting.pricing_catalog?.unresolved_models, []);

  const resync = await syncRun({ projectRoot: project, runId: "kimi-accounting", env });
  assert.equal(resync.ok, true, JSON.stringify(resync.diagnostics));
  const resynced = readAccounting();
  assert.deepEqual(resynced.current, accounting.current);
  assert.deepEqual(resynced.cumulative, accounting.cumulative);
  assert.equal(resynced.updated_at, accounting.updated_at);
  assert.equal(resynced.cumulative?.event_count, accounting.cumulative?.event_count);
});

test("syncRun prices Kimi models from Moonshot, not an alphabetically earlier same-name provider", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-kimi-provider-pin";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "kimi-k3",
          agent: "KimiAgent"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    aihubmix: {
      models: {
        "kimi-k3": { cost: { input: 30, output: 150, cache_read: 3 } }
      }
    },
    ...MOONSHOT_KIMI_CATALOG,
    venice: {
      models: {
        "kimi-k3": { cost: { input: 3.75, output: 18.75 } }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "kimi-provider-pin", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "kimi-provider-pin", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { estimated_spend?: string; estimated_spend_usd?: number; partial_pricing?: boolean };
      pricing_catalog?: { model_prices?: Record<string, { inputUsdPerMillion?: number }> };
    };
  };
  // 1M uncached input at $3 plus 100k output at $15 — the Moonshot rates.
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 4.5);
  assert.equal(metadata.accounting?.current?.estimated_spend, "$4.50");
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
  assert.equal(metadata.accounting?.pricing_catalog?.model_prices?.["kimi-k3"]?.inputUsdPerMillion, 3);
});

test("syncRun leaves a Kimi model unpriced when Moonshot does not list it", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-kimi-unresolved";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: kimiTokenUsageEvents(workflowRunId)
  });
  // Only non-Moonshot providers list the alias; borrowing their rate would
  // publish a silently wrong cost, so the model must stay unresolved.
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    crof: { models: { "kimi-k3": { cost: { input: 2, output: 8, cache_read: 0.25 } } } },
    kenari: { models: { "kimi-k3": { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } } },
    moonshotai: { models: { "kimi-k2.6": { cost: { input: 0.95, output: 4, cache_read: 0.16 } } } }
  });
  const run = await startRun({ projectRoot: project, runId: "kimi-unresolved", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "kimi-unresolved", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        total_tokens?: number;
        estimated_spend?: string;
        estimated_spend_usd?: number;
        usage_complete?: boolean;
        pricing_incomplete_reasons?: Array<{ code?: string }>;
      };
      pricing_catalog?: { resolved_models?: string[]; unresolved_models?: string[] };
    };
  };
  assert.deepEqual(metadata.accounting?.pricing_catalog?.resolved_models, []);
  assert.deepEqual(metadata.accounting?.pricing_catalog?.unresolved_models, ["kimi-k3"]);
  assert.equal(metadata.accounting?.current?.total_tokens, 548_000);
  assert.equal(metadata.accounting?.current?.usage_complete, true);
  assert.equal(metadata.accounting?.current?.estimated_spend, "unavailable");
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, undefined);
  assert.ok(
    metadata.accounting?.current?.pricing_incomplete_reasons?.every(
      (reason) => reason.code === "model-pricing-unavailable"
    )
  );
});

test("syncRun does not assume zero cache reads when cache telemetry is missing", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-unknown-cache-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 100_000,
          outputTokens: 10_000,
          model: "gpt-5.6-sol",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-5.6-sol": { cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "unknown-cache-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "unknown-cache-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        estimated_spend?: string;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string; component?: string; model?: string }>;
        pricing_complete?: boolean;
        partial_pricing?: boolean;
        priced_event_count?: number;
        unpriced_event_count?: number;
        cache_read_pricing_estimated?: boolean;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.estimated_spend, "unavailable");
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.deepEqual(metadata.accounting?.current?.usage_incomplete_reasons, [
    {
      code: "component-usage-unavailable",
      component: "cache_read",
      model: "gpt-5.6-sol"
    }
  ]);
  assert.equal(metadata.accounting?.current?.pricing_complete, true);
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
  assert.equal(metadata.accounting?.current?.priced_event_count, 1);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 0);
  assert.equal(metadata.accounting?.current?.cache_read_pricing_estimated, false);
});

test("syncRun can price missing cache telemetry with an evidence-based cache ratio", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-estimated-cache-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 100_000,
          outputTokens: 10_000,
          model: "gpt-5.6-sol",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-5.6-sol": { cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } }
      }
    }
  });
  env.ULTRAFUZZ_CACHE_READ_RATIO = "0.9";
  const run = await startRun({ projectRoot: project, runId: "estimated-cache-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "estimated-cache-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        estimated_spend?: string;
        inclusive_token_total?: number;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string; component?: string; model?: string }>;
        pricing_complete?: boolean;
        partial_pricing?: boolean;
        priced_event_count?: number;
        unpriced_event_count?: number;
        cache_read_pricing_estimated?: boolean;
        cache_read_ratio_used?: number;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.estimated_spend, "$0.84");
  assert.equal(metadata.accounting?.current?.inclusive_token_total, 200_000);
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.deepEqual(metadata.accounting?.current?.usage_incomplete_reasons, [
    {
      code: "component-usage-estimated",
      component: "cache_read",
      model: "gpt-5.6-sol"
    }
  ]);
  assert.equal(metadata.accounting?.current?.pricing_complete, true);
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
  assert.equal(metadata.accounting?.current?.priced_event_count, 1);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 0);
  assert.equal(metadata.accounting?.current?.cache_read_pricing_estimated, true);
  assert.equal(metadata.accounting?.current?.cache_read_ratio_used, 0.9);
});

test("getRunStatus synchronizes without appending duplicate events", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-inspect-idempotent";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "inspect-idempotent", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const first = await getRunStatus({ projectRoot: project, runId: "inspect-idempotent", env });
  const second = await getRunStatus({ projectRoot: project, runId: "inspect-idempotent", env });

  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(first.value?.status, "succeeded");
  assert.equal(second.value?.status, "succeeded");
  assert.equal(second.value?.events, first.value?.events);
});

test("syncRun fails a successful workflow node that is missing required artifacts", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-missing";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-missing", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const graceStartedAt = Date.parse("2026-07-03T00:01:00.000Z");
  const pending = await syncRun({ projectRoot: project, runId: "sync-missing", env }, { now: () => graceStartedAt });

  assert.equal(pending.ok, true);
  assert.equal(pending.value?.status, "running");
  assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"));
  assert.equal(
    fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8").match(/node-artifacts-missing/gu),
    null
  );

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-missing", env },
    { now: () => graceStartedAt + ARTIFACT_RECONCILIATION_GRACE_MS }
  );

  assert.equal(sync.ok, true);
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_MISSING"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        last_error?: string;
        provenance?: {
          failure?: { category?: string; causal_task_id?: string; causal_failure_category?: string };
          terminal_disposition?: unknown;
        };
      }
    >;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.match(state.nodes?.["project-discovery"]?.last_error ?? "", /setup\/project-discovery\.md/);
  assert.deepEqual(state.nodes?.["project-discovery"]?.provenance?.failure, {
    category: "artifact-contract",
    causal_task_id: "verify:project-discovery",
    causal_failure_category: "artifact-contract",
    dependent_task_ids: []
  });
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.terminal_disposition, undefined);
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    true
  );

  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const repaired = await syncRun(
    { projectRoot: project, runId: "sync-missing", env },
    { now: () => graceStartedAt + ARTIFACT_RECONCILIATION_GRACE_MS + 1 }
  );
  assert.equal(repaired.ok, true, JSON.stringify(repaired.diagnostics));
  assert.equal(repaired.value?.status, "succeeded");
  const repairedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string }>;
  };
  assert.equal(repairedState.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(repairedState.nodes?.["project-discovery"]?.last_error, undefined);
});

test("syncRun reconciles exact task-workspace artifact mirrors before strict validation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-reconciled";
  const runnerOverrides = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-reconciled", env: runnerOverrides });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const mirrorRoot = path.join(
    run.value!.run_root,
    "workspaces",
    "project-discovery",
    "artifacts",
    "project-discovery"
  );
  writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-reconciled", env: runnerOverrides });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "setup", "project-discovery.md")),
    true
  );
  assert.match(fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8"), /node-artifacts-reconciled/);
});

test("syncRun starts artifact grace from the refreshed post-inspection clock", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-refreshed-clock";
  const inspectionMarker = path.join(project, "inspection-completed");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ]),
    inspectMarkerPath: inspectionMarker
  });
  const run = await startRun({ projectRoot: project, runId: "sync-refreshed-clock", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const beforeInspection = Date.parse("2026-07-03T00:01:10.000Z");
  const afterInspection = beforeInspection + 120_000;
  const pending = await syncRun(
    { projectRoot: project, runId: "sync-refreshed-clock", env },
    { now: () => (fs.existsSync(inspectionMarker) ? afterInspection : beforeInspection) }
  );
  assert.equal(pending.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { provenance?: { artifact_reconciliation_grace?: { started_at?: string } } }>;
  };
  assert.equal(
    state.nodes?.["project-discovery"]?.provenance?.artifact_reconciliation_grace?.started_at,
    new Date(afterInspection).toISOString()
  );
});

test("syncRun fails closed for semantically invalid persisted artifact grace", async () => {
  const variants: Array<{ label: string; mutate: (grace: Record<string, unknown>) => void }> = [
    {
      label: "oversized-deadline",
      mutate: (grace) => {
        grace.deadline_at = new Date(
          Date.parse(String(grace.started_at)) + ARTIFACT_RECONCILIATION_GRACE_MS + 1
        ).toISOString();
      }
    },
    {
      label: "unordered-last-attempt",
      mutate: (grace) => {
        grace.last_attempt_at = new Date(Date.parse(String(grace.started_at)) - 1).toISOString();
      }
    },
    {
      label: "attempt-overflow",
      mutate: (grace) => {
        grace.attempts = ARTIFACT_RECONCILIATION_MAX_ATTEMPTS + 1;
      }
    },
    {
      label: "future-window",
      mutate: (grace) => {
        const futureStartedAt =
          Date.parse("2026-07-03T00:01:20.000Z") +
          ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS +
          ARTIFACT_RECONCILIATION_CLOCK_SKEW_MS +
          1;
        grace.started_at = new Date(futureStartedAt).toISOString();
        grace.last_attempt_at = new Date(futureStartedAt).toISOString();
        grace.deadline_at = new Date(futureStartedAt + ARTIFACT_RECONCILIATION_GRACE_MS).toISOString();
      }
    }
  ];
  for (const variant of variants) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const workflowRunId = `ultrafuzz-sync-grace-${variant.label}`;
    const runId = `sync-grace-${variant.label}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
      }),
      events: workflowEvents(workflowRunId, [
        { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
        { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
        { type: "RunFinished" }
      ])
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const now = Date.parse("2026-07-03T00:01:20.000Z");
    const pending = await syncRun({ projectRoot: project, runId, env }, { now: () => now });
    assert.equal(pending.value?.status, "running");
    const statePath = path.join(run.value!.run_root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      nodes: Record<string, { provenance: { artifact_reconciliation_grace: Record<string, unknown> } }>;
    };
    variant.mutate(state.nodes["project-discovery"]!.provenance.artifact_reconciliation_grace);
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const rejected = await syncRun(
      { projectRoot: project, runId, env },
      { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
    assert.equal(rejected.value?.status, "failed", variant.label);
    assert.ok(rejected.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_MISSING"));
    assert.equal(
      rejected.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"),
      false
    );
  }
});

test("syncRun stops artifact reconciliation at the retry bound before the grace deadline", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-retry-bound";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-retry-bound", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const startedAt = Date.parse("2026-07-03T00:01:30.000Z");

  for (let attempt = 1; attempt < ARTIFACT_RECONCILIATION_MAX_ATTEMPTS; attempt += 1) {
    const pending = await syncRun(
      { projectRoot: project, runId: "sync-retry-bound", env },
      { now: () => startedAt + (attempt - 1) * ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
    assert.equal(pending.value?.status, "running", `attempt ${attempt}`);
    assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"));
  }

  const bounded = await syncRun(
    { projectRoot: project, runId: "sync-retry-bound", env },
    {
      now: () => startedAt + (ARTIFACT_RECONCILIATION_MAX_ATTEMPTS - 1) * ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS
    }
  );
  assert.ok(
    (ARTIFACT_RECONCILIATION_MAX_ATTEMPTS - 1) * ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS <
      ARTIFACT_RECONCILIATION_GRACE_MS
  );
  assert.equal(bounded.value?.status, "failed");
  assert.ok(bounded.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_MISSING"));
  assert.equal(
    bounded.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"),
    false
  );
});

test("syncRun keeps a strict node pending until a late safe mirror is reconciled once", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-late-mirror";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-late-mirror", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const now = Date.parse("2026-07-03T00:02:00.000Z");

  const pending = await syncRun({ projectRoot: project, runId: "sync-late-mirror", env }, { now: () => now });
  assert.equal(pending.ok, true, JSON.stringify(pending.diagnostics));
  assert.equal(pending.value?.status, "running");
  assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"));

  const mirrorRoot = path.join(
    run.value!.run_root,
    "workspaces",
    "project-discovery",
    "artifacts",
    "project-discovery"
  );
  writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);

  const completed = await syncRun(
    { projectRoot: project, runId: "sync-late-mirror", env },
    { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
  );
  assert.equal(completed.ok, true, JSON.stringify(completed.diagnostics));
  assert.equal(completed.value?.status, "succeeded");
  const eventsPath = path.join(run.value!.run_root, "events.jsonl");
  const beforeRepeat = fs.readFileSync(eventsPath, "utf8");
  assert.equal((beforeRepeat.match(/node-artifacts-reconciled/gu) ?? []).length, 1);
  assert.equal((beforeRepeat.match(/node-artifact-reconciliation-grace-completed/gu) ?? []).length, 1);
  assert.equal((beforeRepeat.match(/node-artifacts-verified/gu) ?? []).length, 1);
  assert.equal((beforeRepeat.match(/node-artifacts-missing/gu) ?? []).length, 0);

  const repeated = await syncRun(
    { projectRoot: project, runId: "sync-late-mirror", env },
    { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS * 2 }
  );
  assert.equal(repeated.ok, true, JSON.stringify(repeated.diagnostics));
  assert.equal(fs.readFileSync(eventsPath, "utf8"), beforeRepeat);
});

test("syncRun retries same-inode regular-file growth during artifact grace", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-growing-mirror";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-growing-mirror", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const now = Date.parse("2026-07-03T00:02:30.000Z");
  const pending = await syncRun({ projectRoot: project, runId: "sync-growing-mirror", env }, { now: () => now });
  assert.equal(pending.value?.status, "running");
  const mirrorRoot = path.join(
    run.value!.run_root,
    "workspaces",
    "project-discovery",
    "artifacts",
    "project-discovery"
  );
  writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);
  const source = path.join(mirrorRoot, "setup", "project-discovery.md");
  const originalReadSync = fs.readSync;
  let grew = false;
  fs.readSync = ((fd, buffer, offset, length, position) => {
    const bytesRead = originalReadSync(fd, buffer, offset, length, position);
    if (!grew && bytesRead > 0 && fs.realpathSync(`/proc/self/fd/${fd}`) === source) {
      grew = true;
      fs.appendFileSync(source, "late growth\n", "utf8");
    }
    return bytesRead;
  }) as typeof fs.readSync;
  let retryable;
  try {
    retryable = await syncRun(
      { projectRoot: project, runId: "sync-growing-mirror", env },
      { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
  } finally {
    fs.readSync = originalReadSync;
  }
  assert.equal(grew, true);
  assert.equal(retryable.value?.status, "running");
  assert.ok(retryable.diagnostics.some((diagnostic) => diagnostic.code === "WORKSPACE_ARTIFACT_RECONCILE_RETRYABLE"));
  assert.ok(retryable.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"));
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "setup", "project-discovery.md")),
    false
  );

  const completed = await syncRun(
    { projectRoot: project, runId: "sync-growing-mirror", env },
    { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS * 2 }
  );
  assert.equal(completed.value?.status, "succeeded", JSON.stringify(completed.diagnostics));
});

test("syncRun rejects a regular-file inode replacement during artifact grace", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-replaced-mirror";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-replaced-mirror", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const now = Date.parse("2026-07-03T00:02:45.000Z");
  const pending = await syncRun({ projectRoot: project, runId: "sync-replaced-mirror", env }, { now: () => now });
  assert.equal(pending.value?.status, "running");
  const mirrorRoot = path.join(
    run.value!.run_root,
    "workspaces",
    "project-discovery",
    "artifacts",
    "project-discovery"
  );
  writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);
  const source = path.join(mirrorRoot, "setup", "project-discovery.md");
  const preserved = `${source}.preserved`;
  const originalOpenSync = fs.openSync;
  let replaced = false;
  fs.openSync = ((filePath, flags, mode) => {
    if (!replaced && String(filePath) === source) {
      replaced = true;
      fs.renameSync(source, preserved);
      fs.writeFileSync(source, "replacement regular file\n", "utf8");
    }
    return originalOpenSync(filePath, flags, mode);
  }) as typeof fs.openSync;
  let rejected;
  try {
    rejected = await syncRun(
      { projectRoot: project, runId: "sync-replaced-mirror", env },
      { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(source, { force: true });
    fs.renameSync(preserved, source);
  }
  assert.equal(replaced, true);
  assert.equal(rejected.value?.status, "failed");
  assert.ok(
    rejected.diagnostics.some(
      (diagnostic) => diagnostic.source === "artifact-reconciliation" && diagnostic.severity === "error"
    )
  );
  assert.equal(
    rejected.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"),
    false
  );
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "setup", "project-discovery.md")),
    false
  );
});

test("syncRun rejects unsafe late mirrors instead of extending artifact grace", async () => {
  for (const sourceKind of ["symlink", "hardlink"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const workflowRunId = `ultrafuzz-sync-unsafe-${sourceKind}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
      }),
      events: workflowEvents(workflowRunId, [
        { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
        { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
        { type: "RunFinished" }
      ])
    });
    const run = await startRun({ projectRoot: project, runId: `sync-unsafe-${sourceKind}`, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const now = Date.parse("2026-07-03T00:03:00.000Z");
    const pending = await syncRun(
      { projectRoot: project, runId: `sync-unsafe-${sourceKind}`, env },
      { now: () => now }
    );
    assert.equal(pending.value?.status, "running");

    const mirrorRoot = path.join(
      run.value!.run_root,
      "workspaces",
      "project-discovery",
      "artifacts",
      "project-discovery"
    );
    fs.mkdirSync(path.join(mirrorRoot, "setup"), { recursive: true });
    const outside = path.join(project, `${sourceKind}-outside.md`);
    fs.writeFileSync(outside, "unsafe source\n", "utf8");
    const source = path.join(mirrorRoot, "setup", "project-discovery.md");
    if (sourceKind === "symlink") {
      fs.symlinkSync(outside, source);
    } else {
      fs.linkSync(outside, source);
    }

    const rejected = await syncRun(
      { projectRoot: project, runId: `sync-unsafe-${sourceKind}`, env },
      { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
    assert.equal(rejected.ok, true);
    assert.equal(rejected.value?.status, "failed");
    assert.ok(
      rejected.diagnostics.some(
        (diagnostic) => diagnostic.source === "artifact-reconciliation" && diagnostic.severity === "error"
      )
    );
    assert.equal(
      rejected.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"),
      false
    );
    assert.equal(
      fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "setup", "project-discovery.md")),
      false
    );
  }
});

test("syncRun rejects a late mirror source swap during artifact grace", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-raced-mirror";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-raced-mirror", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const now = Date.parse("2026-07-03T00:03:30.000Z");
  const pending = await syncRun({ projectRoot: project, runId: "sync-raced-mirror", env }, { now: () => now });
  assert.equal(pending.value?.status, "running");

  const mirrorRoot = path.join(
    run.value!.run_root,
    "workspaces",
    "project-discovery",
    "artifacts",
    "project-discovery"
  );
  writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);
  const source = path.join(mirrorRoot, "setup", "project-discovery.md");
  const sourceDirectory = path.dirname(source);
  const preservedDirectory = path.join(mirrorRoot, "setup-preserved");
  const outsideDirectory = tempProject();
  fs.writeFileSync(path.join(outsideDirectory, "project-discovery.md"), "outside\n", "utf8");
  const originalOpenSync = fs.openSync;
  let swapped = false;
  fs.openSync = ((filePath, flags, mode) => {
    if (!swapped && String(filePath) === source) {
      swapped = true;
      fs.renameSync(sourceDirectory, preservedDirectory);
      fs.symlinkSync(outsideDirectory, sourceDirectory);
    }
    return originalOpenSync(filePath, flags, mode);
  }) as typeof fs.openSync;
  let rejected;
  try {
    rejected = await syncRun(
      { projectRoot: project, runId: "sync-raced-mirror", env },
      { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(sourceDirectory, { force: true });
    fs.renameSync(preservedDirectory, sourceDirectory);
  }
  assert.equal(swapped, true);
  assert.equal(rejected.ok, true);
  assert.equal(rejected.value?.status, "failed");
  assert.ok(
    rejected.diagnostics.some(
      (diagnostic) => diagnostic.source === "artifact-reconciliation" && diagnostic.severity === "error"
    )
  );
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "setup", "project-discovery.md")),
    false
  );
});

test("syncRun honors cancellation and an overall deadline before starting artifact grace", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-budget";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-budget", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const before = fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8");
  const now = Date.parse("2026-07-03T00:04:00.000Z");
  const controller = new AbortController();
  controller.abort();

  const cancelled = await syncRun(
    { projectRoot: project, runId: "sync-budget", env },
    { now: () => now, signal: controller.signal }
  );
  assert.equal(cancelled.ok, false);
  assert.ok(cancelled.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CANCELLED"));
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8"), before);

  const expired = await syncRun(
    { projectRoot: project, runId: "sync-budget", env },
    { now: () => now, deadlineMs: now }
  );
  assert.equal(expired.ok, false);
  assert.ok(expired.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"));
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8"), before);

  let clockReads = 0;
  const expiredAfterInspection = await syncRun(
    { projectRoot: project, runId: "sync-budget", env },
    {
      now: () => now + clockReads++,
      deadlineMs: now + 1
    }
  );
  assert.equal(expiredAfterInspection.ok, false);
  assert.ok(
    expiredAfterInspection.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED")
  );
  assert.equal(clockReads, 2);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8"), before);
});

test("syncRun interrupts large reconciliation copies without publishing or mutating state and events", async () => {
  for (const mode of ["deadline", "abort"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const workflowRunId = `ultrafuzz-sync-large-copy-${mode}`;
    const runId = `sync-large-copy-${mode}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
      }),
      events: workflowEvents(workflowRunId, [
        { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
        { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
        { type: "RunFinished" }
      ])
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const mirrorRoot = path.join(
      run.value!.run_root,
      "workspaces",
      "project-discovery",
      "artifacts",
      "project-discovery"
    );
    writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
      "setup/project-discovery.md",
      "findings.json"
    ]);
    const source = path.join(mirrorRoot, "setup", "project-discovery.md");
    fs.writeFileSync(source, Buffer.alloc(8 * 1024 * 1024, 0x61));

    const statePath = path.join(run.value!.run_root, "state.json");
    const eventsPath = path.join(run.value!.run_root, "events.jsonl");
    const stateBefore = fs.readFileSync(statePath, "utf8");
    const eventsBefore = fs.readFileSync(eventsPath, "utf8");
    const artifactDir = path.join(run.value!.run_root, "artifacts", "project-discovery");
    const destination = path.join(artifactDir, "setup", "project-discovery.md");
    const controller = new AbortController();
    const startedAt = Date.parse("2026-07-03T00:04:30.000Z");
    const deadline = startedAt + 100;
    let currentTime = startedAt;
    let sourceReads = 0;
    let abortScheduled = false;
    const originalReadSync = fs.readSync;
    fs.readSync = ((fd, buffer, offset, length, position) => {
      const bytesRead = originalReadSync(fd, buffer, offset, length, position);
      let openedPath = "";
      try {
        openedPath = fs.realpathSync(`/proc/self/fd/${fd}`);
      } catch {
        // Ignore unrelated descriptors that close between read and inspection.
      }
      if (bytesRead > 0 && openedPath === source) {
        sourceReads += 1;
        if (mode === "deadline" && sourceReads === 2) {
          currentTime = deadline;
        }
        if (mode === "abort" && !abortScheduled) {
          abortScheduled = true;
          setImmediate(() => controller.abort());
        }
      }
      return bytesRead;
    }) as typeof fs.readSync;

    let interrupted;
    try {
      interrupted = await syncRun(
        { projectRoot: project, runId, env },
        mode === "deadline"
          ? { now: () => currentTime, deadlineMs: deadline }
          : { now: () => currentTime, signal: controller.signal }
      );
    } finally {
      fs.readSync = originalReadSync;
    }

    assert.equal(interrupted.ok, false, mode);
    assert.ok(
      interrupted.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === (mode === "deadline" ? "WORKFLOW_SYNC_DEADLINE_EXCEEDED" : "WORKFLOW_SYNC_CANCELLED")
      ),
      mode
    );
    assert.ok(sourceReads >= 1, mode);
    assert.equal(fs.existsSync(destination), false, mode);
    assert.equal(
      fs.readdirSync(artifactDir, { recursive: true }).some((entry) => String(entry).includes(".reconcile-")),
      false,
      mode
    );
    assert.equal(fs.readFileSync(statePath, "utf8"), stateBefore, mode);
    assert.equal(fs.readFileSync(eventsPath, "utf8"), eventsBefore, mode);
  }
});

test("syncRun aborts or times out a blocked inspection child without durable mutation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const binDir = path.join(project, "blocked-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    `#!${process.execPath}
if (process.argv[2] === "inspect") {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write('{"ok":true}\\n');
}
`,
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  const env = {
    SMITHERS_BIN: smithers,
    ULTRAFUZZ_PRICING_CATALOG_URL: "off"
  };
  const run = await startRun({ projectRoot: project, runId: "sync-blocked-child", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const before = fs.readFileSync(statePath, "utf8");

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 50);
  const abortStartedAt = Date.now();
  const cancelled = await syncRun(
    { projectRoot: project, runId: "sync-blocked-child", env },
    { signal: controller.signal }
  );
  clearTimeout(abortTimer);
  assert.equal(cancelled.ok, false);
  assert.ok(cancelled.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CANCELLED"));
  assert.ok(Date.now() - abortStartedAt < 2_000);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);

  const deadlineStartedAt = Date.now();
  const expired = await syncRun(
    { projectRoot: project, runId: "sync-blocked-child", env },
    { deadlineMs: deadlineStartedAt + 100 }
  );
  assert.equal(expired.ok, false);
  assert.ok(expired.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"));
  assert.ok(Date.now() - deadlineStartedAt < 2_000);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
});

test("syncRun requires the deterministic verifier task to succeed", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-verifier-failed";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [
        { id: "node:project-discovery", state: "finished", attempt: 1 },
        { id: "verify:project-discovery", state: "failed", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "verify:project-discovery",
        attempt: 1,
        error: { message: "deterministic artifact verification failed" }
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-verifier-failed", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-verifier-failed", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_VERIFIER_FAILED"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        provenance?: {
          failure?: { category?: string; causal_task_id?: string; causal_failure_category?: string };
          workflow?: { task_id?: string };
        };
      }
    >;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.deepEqual(state.nodes?.["project-discovery"]?.provenance?.failure, {
    category: "artifact-contract",
    causal_task_id: "verify:project-discovery",
    causal_failure_category: "artifact-contract",
    dependent_task_ids: []
  });
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.task_id, "verify:project-discovery");
});

test("syncRun does not finalize an agent before its deterministic verifier has evidence", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-verifier-missing";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      includeVerifierSteps: false,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [{ type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 }])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-verifier-missing", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-verifier-missing", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_TASK_EVIDENCE_MISSING"));
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    false
  );
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.notEqual(state.nodes?.["project-discovery"]?.status, "succeeded");
});

test("syncRun finalizes prerequisite manifests before out-of-order descendants", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-out-of-order";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [
        { id: "node:actors-flows", state: "finished", attempt: 1 },
        { id: "node:project-discovery", state: "finished", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:actors-flows", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-out-of-order", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md"]);
  writeRequiredArtifactSet(run.value!.run_root, "actors-flows", ["setup/actors-flows.md"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-out-of-order", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const descendantManifest = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "artifacts", "actors-flows", "artifact-manifest.json"), "utf8")
  ) as { prerequisite_manifests?: Array<{ node_id?: string }> };
  assert.deepEqual(
    descendantManifest.prerequisite_manifests?.map((entry) => entry.node_id),
    ["project-discovery"]
  );
});

test("syncRun does not mark a completed workflow succeeded without task evidence", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-missing-evidence";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: {
      ok: true,
      data: {
        run: { id: workflowRunId, status: "completed" },
        runState: { runId: workflowRunId, state: "completed" },
        steps: []
      }
    },
    events: ""
  });
  const run = await startRun({ projectRoot: project, runId: "sync-missing-evidence", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-missing-evidence", env });

  assert.equal(sync.ok, true);
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_TASK_EVIDENCE_MISSING"));
});

test("syncRun accepts workflow nodes and top-level event fields", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-alt-shapes";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: {
      ok: true,
      data: {
        run: { id: workflowRunId, status: "completed" },
        runState: { runId: workflowRunId, state: "completed" },
        nodes: [
          { nodeId: "node:project-discovery", status: "completed", attemptIndex: 0 },
          { nodeId: "verify:project-discovery", status: "completed", attemptIndex: 0 }
        ]
      }
    },
    events: `${[
      { nodeId: "node:project-discovery", timestampMs: Date.parse("2026-07-03T00:00:00.000Z") },
      { nodeId: "verify:project-discovery", timestampMs: Date.parse("2026-07-03T00:00:00.100Z") }
    ]
      .map((event) =>
        JSON.stringify({
          runId: workflowRunId,
          timestampMs: event.timestampMs,
          event: "NodeFinished",
          nodeId: event.nodeId,
          attempt: 0
        })
      )
      .join("\n")}\n`
  });
  const run = await startRun({ projectRoot: project, runId: "sync-alt-shapes", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-alt-shapes", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
});

test("syncRun maps failed workflow nodes into durable failed run state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-failed-node";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 2 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "TaskHeartbeatTimeout", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFailed", nodeId: "node:project-discovery", attempt: 1, error: { message: "agent failed" } },
      { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 2 },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 2 },
      { type: "NodeFailed", nodeId: "node:project-discovery", attempt: 2, error: { message: "agent failed again" } }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-failed-node", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-failed-node", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        retry_count?: number;
        last_error?: string;
        provenance?: {
          failure?: { category?: string; causal_task_id?: string; causal_failure_category?: string };
        };
      }
    >;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(state.nodes?.["project-discovery"]?.retry_count, 1);
  assert.equal(state.nodes?.["project-discovery"]?.last_error, "agent failed again");
  assert.deepEqual(state.nodes?.["project-discovery"]?.provenance?.failure, {
    category: "agent-failure",
    causal_task_id: "node:project-discovery",
    causal_failure_category: "agent-failure",
    dependent_task_ids: []
  });
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    false
  );
  const failedLedger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    failedLedger.map((entry) => entry.outcome),
    ["timed-out", "failed"]
  );

  const resumedEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "running", attempt: 3 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 3 },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 3 }
    ])
  });
  const resumed = await syncRun({ projectRoot: project, runId: "sync-failed-node", env: resumedEnv });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.status, "running");
  const resumedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status?: string;
    finished_at?: string;
    nodes?: Record<string, { status?: string; last_error?: string; finished_at?: string }>;
  };
  assert.equal(resumedState.status, "running");
  assert.equal(resumedState.finished_at, undefined);
  assert.equal(resumedState.nodes?.["project-discovery"]?.status, "running");
  assert.equal(resumedState.nodes?.["project-discovery"]?.last_error, undefined);
  assert.equal(resumedState.nodes?.["project-discovery"]?.finished_at, undefined);
});

test("syncRun preserves retry and checkpoint generations in the immutable attempt ledger", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger";
  const firstExecutionEvents = [
    {
      type: "NodeStarted",
      nodeId: "node:project-discovery",
      attempt: 1,
      extra: {
        iteration: 0,
        checkpointGenerationId: "checkpoint-1",
        workflowExecutionId: "execution-1",
        controllerInvocationId: "controller-1"
      }
    },
    {
      type: "NodeFailed",
      nodeId: "node:project-discovery",
      attempt: 1,
      error: { message: "generated executor failure" },
      extra: { iteration: 0 }
    },
    { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 2, extra: { iteration: 0 } },
    {
      type: "NodeStarted",
      nodeId: "node:project-discovery",
      attempt: 2,
      extra: {
        iteration: 0,
        checkpointGenerationId: "checkpoint-1",
        workflowExecutionId: "execution-1",
        controllerInvocationId: "controller-1"
      }
    },
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 2, extra: { iteration: 0 } }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 2 }]
    }),
    events: workflowEvents(workflowRunId, firstExecutionEvents)
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const firstSync = await syncRun({ projectRoot: project, runId: "attempt-ledger", env });
  assert.equal(firstSync.ok, true, JSON.stringify(firstSync.diagnostics));

  const continuedEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 3 }]
    }),
    events: workflowEvents(workflowRunId, [
      ...firstExecutionEvents,
      { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 3, extra: { iteration: 1 } },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 3,
        extra: {
          iteration: 1,
          checkpointGenerationId: "checkpoint-2",
          workflowExecutionId: "execution-2",
          controllerInvocationId: "controller-2"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 3, extra: { iteration: 1 } }
    ])
  });
  const continued = await syncRun({ projectRoot: project, runId: "attempt-ledger", env: continuedEnv });
  const replayed = await syncRun({ projectRoot: project, runId: "attempt-ledger", env: continuedEnv });
  assert.equal(continued.ok, true, JSON.stringify(continued.diagnostics));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));

  const ledgerText = fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8");
  const ledger = ledgerText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger.length, 3);
  assert.doesNotMatch(ledgerText, /generated executor failure/u);
  assert.equal(ledger[1]?.parent_attempt_id, ledger[0]?.attempt_id);
  assert.equal(ledger[2]?.parent_attempt_id, ledger[1]?.attempt_id);

  const status = await getRunStatus({ projectRoot: project, runId: "attempt-ledger", env: continuedEnv });
  assert.deepEqual(status.value?.attempts, {
    total: 3,
    executed: 3,
    reused: 0,
    outcomes: { succeeded: 2, failed: 1, "timed-out": 0, canceled: 0, skipped: 0, reused: 0 },
    strategy_attempts: 1,
    executor_retries: 3,
    checkpoint_generations: 2,
    workflow_executions: 2,
    controller_invocations: 2
  });
  assert.equal(status.value?.state?.nodes["project-discovery"]?.retry_count, 2);
});

test("syncRun records checkpoint continuation entries even when workflow retry counters restart", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger-restarted-counter";
  const firstExecutionEvents = [
    {
      type: "NodeStarted",
      nodeId: "node:project-discovery",
      attempt: 1,
      extra: {
        iteration: 0,
        checkpointGenerationId: "checkpoint-1",
        workflowExecutionId: "execution-1",
        controllerInvocationId: "controller-1"
      }
    },
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, firstExecutionEvents)
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger-restarted-counter", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const firstSync = await syncRun({ projectRoot: project, runId: "attempt-ledger-restarted-counter", env });
  assert.equal(firstSync.ok, true, JSON.stringify(firstSync.diagnostics));

  const continuedEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      ...firstExecutionEvents,
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "checkpoint-2",
          workflowExecutionId: "execution-2",
          controllerInvocationId: "controller-2"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } }
    ])
  });
  const continued = await syncRun({
    projectRoot: project,
    runId: "attempt-ledger-restarted-counter",
    env: continuedEnv
  });
  const replayed = await syncRun({
    projectRoot: project,
    runId: "attempt-ledger-restarted-counter",
    env: continuedEnv
  });
  assert.equal(continued.ok, true, JSON.stringify(continued.diagnostics));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));

  const ledgerText = fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8");
  const ledger = ledgerText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[1]?.parent_attempt_id, ledger[0]?.attempt_id);

  const status = await getRunStatus({
    projectRoot: project,
    runId: "attempt-ledger-restarted-counter",
    env: continuedEnv
  });
  assert.deepEqual(status.value?.attempts, {
    total: 2,
    executed: 2,
    reused: 0,
    outcomes: { succeeded: 2, failed: 0, "timed-out": 0, canceled: 0, skipped: 0, reused: 0 },
    strategy_attempts: 1,
    executor_retries: 2,
    checkpoint_generations: 2,
    workflow_executions: 2,
    controller_invocations: 2
  });
});

test("syncRun distinguishes repeated retry counters by their workflow event identity", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger-repeated-dimensions";
  const repeatedDimensions = {
    iteration: 0,
    checkpointGenerationId: "checkpoint-1",
    workflowExecutionId: "execution-1",
    controllerInvocationId: "controller-1"
  };
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: repeatedDimensions
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: repeatedDimensions
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger-repeated-dimensions", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "attempt-ledger-repeated-dimensions", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.ok(!sync.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  const ledger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger.length, 2);
  assert.equal(new Set(ledger.map((entry) => entry.attempt_id)).size, 2);
  assert.equal(new Set(ledger.map((entry) => entry.executor_retry_id)).size, 2);
});

test("syncRun keeps a terminal-only retry idempotent when its start event arrives later", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger-late-start";
  const startedAt = Date.parse("2026-07-03T00:00:00.100Z");
  const finishedAt = Date.parse("2026-07-03T00:00:00.200Z");
  const terminalEvent = {
    type: "NodeFailed",
    nodeId: "node:project-discovery",
    attempt: 1,
    sequence: 2,
    timestampMs: finishedAt,
    error: { message: "generated executor failure" }
  };
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [terminalEvent])
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger-late-start", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const firstSync = await syncRun({ projectRoot: project, runId: "attempt-ledger-late-start", env });
  assert.equal(firstSync.ok, true, JSON.stringify(firstSync.diagnostics));
  const initialLedger = fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8");

  const completeEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 1,
        timestampMs: startedAt
      },
      terminalEvent
    ])
  });
  const replayed = await syncRun({
    projectRoot: project,
    runId: "attempt-ledger-late-start",
    env: completeEnv
  });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.ok(!replayed.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"), initialLedger);
  assert.equal(initialLedger.trim().split("\n").length, 1);
});

test("syncRun attributes attempts to the controller active when the attempt starts", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger-controller";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunStarted", extra: { controllerInvocationId: "controller-start" } },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "checkpoint-1",
          workflowExecutionId: "execution-1"
        }
      },
      { type: "RunAutoResumed", extra: { controllerInvocationId: "controller-resume" } },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger-controller", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "attempt-ledger-controller", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));

  const ledgerText = fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8");
  const ledger = ledgerText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.controller_invocation_id, "controller-start");
});

test("syncRun keeps skipped override attempts schema-valid", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger-skipped-override";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "skipped", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger-skipped-override", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "attempt-ledger-skipped-override", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.ok(!sync.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));

  const ledger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.outcome, "skipped");
  assert.equal(ledger[0]?.failure_category, undefined);
  assert.deepEqual(ledger[0]?.reuse, { status: "executed" });
});

test("syncRun records reused override attempts with an idempotent source reference", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const sourceWorkflowRunId = "ultrafuzz-attempt-ledger-reuse-source";
  const sourceEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: sourceWorkflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(sourceWorkflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 }
    ])
  });
  const sourceRun = await startRun({ projectRoot: project, runId: "attempt-ledger-reuse-source", env: sourceEnv });
  assert.equal(sourceRun.ok, true, JSON.stringify(sourceRun.diagnostics));
  writeRequiredArtifactSet(sourceRun.value!.run_root, "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);
  const sourceSync = await syncRun({ projectRoot: project, runId: "attempt-ledger-reuse-source", env: sourceEnv });
  assert.equal(sourceSync.ok, true, JSON.stringify(sourceSync.diagnostics));
  const sourceAttempt = JSON.parse(
    fs.readFileSync(path.join(sourceRun.value!.run_root, "attempts.jsonl"), "utf8").trim()
  ) as Record<string, unknown>;

  const workflowRunId = "ultrafuzz-attempt-ledger-reused-override";
  const firstReuseEvents = [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "reused-from-prior-run", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, firstReuseEvents)
  });
  const run = await startRun({
    projectRoot: project,
    runId: "attempt-ledger-reused-override",
    sourceRunId: "attempt-ledger-reuse-source",
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "attempt-ledger-reused-override", env });
  const replayed = await syncRun({ projectRoot: project, runId: "attempt-ledger-reused-override", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.ok(!sync.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  assert.ok(!replayed.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));

  const ledger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const reuse = ledger[0]?.reuse as Record<string, unknown> | undefined;
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.outcome, "reused");
  assert.equal(ledger[0]?.failure_category, undefined);
  assert.equal(reuse?.status, "reused");
  assert.equal(reuse?.source_attempt_id, sourceAttempt.attempt_id);
  assert.notEqual(reuse?.source_attempt_id, ledger[0]?.attempt_id);

  const continuedEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "reused-from-prior-run", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      ...firstReuseEvents,
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 }
    ])
  });
  const continued = await syncRun({
    projectRoot: project,
    runId: "attempt-ledger-reused-override",
    env: continuedEnv
  });
  assert.equal(continued.ok, true, JSON.stringify(continued.diagnostics));
  assert.ok(!continued.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  const continuedLedger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(continuedLedger.length, 2);
  assert.deepEqual(
    continuedLedger.map((entry) => (entry.reuse as Record<string, unknown>).source_attempt_id),
    [sourceAttempt.attempt_id, sourceAttempt.attempt_id]
  );

  const status = await getRunStatus({
    projectRoot: project,
    runId: "attempt-ledger-reused-override",
    env: continuedEnv
  });
  assert.equal(status.ok, true, JSON.stringify(status.diagnostics));
  assert.equal(status.value?.attempts.reused, 2);
});

test("syncRun keeps reset workflow nodes pending while the workflow is running", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-reset-pending";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        error: { message: "CLI timed out after 1800000ms" }
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-reset-pending", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-reset-pending", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status?: string;
    finished_at?: string;
    nodes?: Record<string, { status?: string; last_error?: string; finished_at?: string; timed_out?: boolean }>;
  };
  assert.equal(state.status, "running");
  assert.equal(state.finished_at, undefined);
  assert.equal(state.nodes?.["project-discovery"]?.status, "pending");
  assert.equal(state.nodes?.["project-discovery"]?.timed_out, false);
  assert.equal(state.nodes?.["project-discovery"]?.last_error, undefined);
  assert.equal(state.nodes?.["project-discovery"]?.finished_at, undefined);
});

test("syncRun records external wait reasons from workflow events", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-wait-event-run";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodePending", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeWaitingApproval", nodeId: "node:project-discovery", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "wait-event-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "wait-event-run", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(state.nodes["project-discovery"]?.wait_reason, "approval");
  assert.equal(state.nodes["project-discovery"]?.next_eligible_action, "approve");
});

test("syncRun cancels a nonterminal workflow at its durable workflow deadline", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-deadline-run";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
    }),
    events: workflowEvents(workflowRunId, [{ type: "NodePending", nodeId: "node:project-discovery", attempt: 0 }])
  });
  const run = await startRun({ projectRoot: project, runId: "deadline-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  state.workflow_deadline_at = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const sync = await syncRun({ projectRoot: project, runId: "deadline-run", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "timed-out");
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  assert.equal(persisted.status, "timed-out");
  assert.equal(typeof persisted.finished_at, "string");
  assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /cancel ultrafuzz-deadline-run --format json/u);
  assert.match(fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8"), /workflow-deadline-exceeded/u);

  fs.writeFileSync(
    env.SMITHERS_FAKE_INSPECT!,
    `${JSON.stringify(
      workflowInspect({
        workflowRunId,
        status: "canceled",
        state: "canceled",
        steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
      })
    )}\n`,
    "utf8"
  );
  const acknowledged = await syncRun({ projectRoot: project, runId: "deadline-run", env });

  assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged.diagnostics));
  assert.equal(acknowledged.value?.status, "timed-out");
  assert.equal((fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8").match(/^cancel /gmu) ?? []).length, 1);
});

test("syncRun records model fan-out attempts independently", async () => {
  const project = tempProject();
  writeFanoutProject(project);
  const workflowRunId = "ultrafuzz-sync-fanout";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [
        { id: "node:project-discovery__model_0__attempt_0", state: "finished", attempt: 1 },
        { id: "node:project-discovery__model_1__attempt_1", state: "failed", attempt: 1 },
        { id: "node:signal-analysis__model_0__attempt_0", state: "in-progress", attempt: 1 },
        { id: "node:signal-analysis__model_1__attempt_1", state: "skipped", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery__model_0__attempt_0", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery__model_1__attempt_1",
        attempt: 1,
        error: { message: "model failed" }
      },
      { type: "NodeStarted", nodeId: "node:signal-analysis__model_0__attempt_0", attempt: 1 },
      { type: "NodeSkipped", nodeId: "node:signal-analysis__model_1__attempt_1", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-fanout", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery__model_0__attempt_0", [
    "setup/project-discovery.md",
    "findings.json"
  ]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-fanout", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        provenance?: {
          failure?: {
            category?: string;
            causal_task_id?: string;
            causal_failure_category?: string;
            dependent_task_ids?: string[];
          };
        };
      }
    >;
  };
  assert.equal(state.nodes?.["project-discovery__model_0__attempt_0"]?.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery__model_1__attempt_1"]?.status, "failed");
  assert.equal(state.nodes?.["signal-analysis__model_0__attempt_0"]?.status, "running");
  assert.equal(state.nodes?.["signal-analysis__model_1__attempt_1"]?.status, "skipped");
  assert.deepEqual(state.nodes?.["signal-analysis__model_1__attempt_1"]?.provenance?.failure, {
    category: "dependency-cascade",
    causal_task_id: "node:project-discovery__model_1__attempt_1",
    causal_failure_category: "agent-failure",
    dependent_task_ids: ["node:signal-analysis__model_1__attempt_1"]
  });
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(
    fs.existsSync(
      path.join(run.value!.run_root, "artifacts", "project-discovery__model_0__attempt_0", "artifact-manifest.json")
    ),
    true
  );
  const ledger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const projectDiscoveryAttempts = ledger.filter((entry) => entry.node_id === "project-discovery");
  assert.equal(projectDiscoveryAttempts.length, 2);
  assert.deepEqual(projectDiscoveryAttempts.map((entry) => entry.strategy_attempt_id).sort(), [
    "project-discovery__model_0__attempt_0",
    "project-discovery__model_1__attempt_1"
  ]);
});

test("resume, replay, and fork delegate linked runs to Smithers lifecycle verbs", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId: run.value!.run_id, maxConcurrency: 8, env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.workflow_run_id, "ultrafuzz-lifecycle-run");
  assert.equal(resumed.value?.submitted, true);
  const resumedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(resumedState.concurrency.requested_concurrency, 8);
  assert.equal(resumedState.controller_lease.duration_ms, 30_000);

  const resetResumed = await resumeRun({
    projectRoot: project,
    runId: run.value!.run_id,
    maxConcurrency: 8,
    resetNode: "node:project-discovery",
    env
  });
  assert.equal(resetResumed.ok, true, JSON.stringify(resetResumed.diagnostics));
  assert.equal(resetResumed.value?.submitted, true);
  const cloudGeneration = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "cloud-execution-generation.json"), "utf8")
  ) as { generation?: string; reset_node?: string };
  assert.match(cloudGeneration.generation ?? "", /^[0-9a-f-]{36}$/u);
  assert.equal(cloudGeneration.reset_node, "node:project-discovery");

  const replayed = await replayRun({ projectRoot: project, runId: run.value!.run_id, env });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(replayed.value?.workflow_run_id, "ultrafuzz-lifecycle-run-replayed");
  assert.equal(replayed.value?.submitted, true);

  const missingFrame = await forkRun({ projectRoot: project, runId: run.value!.run_id, env });
  assert.equal(missingFrame.ok, false);
  assert.equal(missingFrame.diagnostics[0]?.code, "WORKFLOW_FORK_FRAME_REQUIRED");

  const forked = await forkRun({
    projectRoot: project,
    runId: run.value!.run_id,
    forkFrame: 44,
    resetNode: "node:project-discovery",
    label: "after-edit",
    maxConcurrency: 8,
    env
  });
  assert.equal(forked.ok, true, JSON.stringify(forked.diagnostics));
  assert.equal(forked.value?.workflow_run_id, "ultrafuzz-lifecycle-run-forked");
  assert.equal(forked.value?.submitted, true);
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    workflow?: { run_id?: string };
    workflow_ids?: string[];
  };
  assert.equal(metadata.workflow?.run_id, "ultrafuzz-lifecycle-run-forked");
  assert.deepEqual(metadata.workflow_ids, ["ultrafuzz-lifecycle-run-forked"]);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run --run-id ultrafuzz-lifecycle-run --detach --max-concurrency 8 --format json/
  );
  assert.match(
    commands,
    /timetravel .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --node-id node:project-discovery --no-vcs --force --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run --run-id ultrafuzz-lifecycle-run --force --detach --max-concurrency 8 --format json/
  );
  assert.match(commands, /replay .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --format json/);
  assert.match(
    commands,
    /fork .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run-replayed --frame 44 --reset-node node:project-discovery --label after-edit --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run-forked --run-id ultrafuzz-lifecycle-run-forked --force --detach --max-concurrency 8 --format json/
  );
});

test("resume refuses to invoke Smithers when a persisted rendered prompt was modified", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "lifecycle-prompt-integrity", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const promptPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "prompt.rendered.md");
  fs.appendFileSync(promptPath, "\nmodified\n", "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId: run.value!.run_id, env });

  assert.equal(resumed.ok, false);
  assert.equal(resumed.diagnostics[0]?.code, "WORKFLOW_LIFECYCLE_FAILED");
  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");
});

test("resume keeps an already-running linked workflow attached without launching a duplicate", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-active-lifecycle-run",
      status: "running",
      steps: [{ id: "node:project-discovery", state: "running", attempt: 1 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "active-lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId: "active-lifecycle-run", maxConcurrency: 8, env });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.workflow_run_id, "ultrafuzz-active-lifecycle-run");
  assert.equal(resumed.value?.submitted, false);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-active-lifecycle-run --format json/u);
  assert.doesNotMatch(commands, /^up /mu);

  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const forced = await resumeRun({
    projectRoot: project,
    runId: "active-lifecycle-run",
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });
  assert.equal(forced.ok, true, JSON.stringify(forced.diagnostics));
  assert.equal(forced.value?.submitted, true);
  const forcedCommands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(
    forcedCommands,
    /up .*ultrafuzz-active-lifecycle-run\.tsx --resume ultrafuzz-active-lifecycle-run --run-id ultrafuzz-active-lifecycle-run --force --detach --max-concurrency 8 --format json/u
  );
});

test("resume retries one failed workflow task before continuing a terminal unfinished run", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-terminal-retry-run",
      status: "failed",
      state: "failed",
      steps: [
        { id: "node:project-discovery", state: "failed", attempt: 1 },
        { id: "node:strategy", state: "pending", attempt: 0 }
      ]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "terminal-retry-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId: "terminal-retry-run",
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-terminal-retry-run --format json/u);
  assert.match(
    commands,
    /timetravel .*ultrafuzz-terminal-retry-run\.tsx --run-id ultrafuzz-terminal-retry-run --node-id node:project-discovery --iteration 0 --no-deps --force --format json/u
  );
  assert.match(
    commands,
    /up .*ultrafuzz-terminal-retry-run\.tsx --resume ultrafuzz-terminal-retry-run --run-id ultrafuzz-terminal-retry-run --force --detach --max-concurrency 8 --format json/u
  );
});

test("resume retries failed tasks reported inside a successful terminal workflow", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-terminal-row-retry-run",
      status: "finished",
      state: "succeeded",
      failedChildKeys: ["node:project-discovery::3", "node:strategy::2"],
      steps: [
        { id: "node:project-discovery", state: "failed", attempt: 1 },
        { id: "node:strategy", state: "failed", attempt: 1 }
      ]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "terminal-row-retry-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId: "terminal-row-retry-run",
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-terminal-row-retry-run --format json/u);
  assert.match(
    commands,
    /timetravel .*ultrafuzz-terminal-row-retry-run\.tsx --run-id ultrafuzz-terminal-row-retry-run --node-id node:project-discovery --iteration 3 --no-deps --force --format json/u
  );
  assert.match(
    commands,
    /timetravel .*ultrafuzz-terminal-row-retry-run\.tsx --run-id ultrafuzz-terminal-row-retry-run --node-id node:strategy --iteration 2 --no-deps --force --format json/u
  );
  assert.match(
    commands,
    /up .*ultrafuzz-terminal-row-retry-run\.tsx --resume ultrafuzz-terminal-row-retry-run --run-id ultrafuzz-terminal-row-retry-run --force --detach --max-concurrency 8 --format json/u
  );
});

test("resume retries one failed workflow task before continuing a stale unfinished run", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-stale-retry-run",
      status: "running",
      state: "stale",
      steps: [
        { id: "node:project-discovery", state: "failed", attempt: 1 },
        { id: "node:strategy", state: "pending", attempt: 0 }
      ]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "stale-retry-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const expired = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  expired.workflow_deadline_at = new Date(0).toISOString();
  fs.writeFileSync(statePath, `${JSON.stringify(expired, null, 2)}\n`, "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const resumedAfter = Date.now();

  const resumed = await resumeRun({
    projectRoot: project,
    runId: "stale-retry-run",
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const resumedState = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  assert.ok(Date.parse(resumedState.workflow_deadline_at ?? "") > resumedAfter);
  assert.equal(resumedState.status, "running");
  assert.equal(resumedState.finished_at, undefined);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-stale-retry-run --format json/u);
  assert.match(
    commands,
    /timetravel .*ultrafuzz-stale-retry-run\.tsx --run-id ultrafuzz-stale-retry-run --node-id node:project-discovery --iteration 0 --no-deps --force --format json/u
  );
  assert.match(
    commands,
    /up .*ultrafuzz-stale-retry-run\.tsx --resume ultrafuzz-stale-retry-run --run-id ultrafuzz-stale-retry-run --force --detach --max-concurrency 8 --format json/u
  );
});

test("resume rewinds a run-level render failure before continuing unfinished work", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-render-recovery-run",
      status: "failed",
      state: "failed",
      error: { code: "WORKFLOW_RENDER_FAILED", cause: { code: "ENOENT" } },
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
    }),
    timeline: { timeline: { frames: [{ frameNo: 2 }, { frameNo: 4 }] } }
  });
  const run = await startRun({ projectRoot: project, runId: "render-recovery-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId: "render-recovery-run",
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /timeline ultrafuzz-render-recovery-run --json/u);
  assert.match(commands, /rewind ultrafuzz-render-recovery-run 4 --yes --json/u);
  assert.match(
    commands,
    /up .*ultrafuzz-render-recovery-run\.tsx --resume ultrafuzz-render-recovery-run --run-id ultrafuzz-render-recovery-run --force --detach --max-concurrency 8 --format json/u
  );
  assert.doesNotMatch(commands, /retry-task/u);
});

test("resume transfers an incompatible legacy workflow ID to a valid durable lineage", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = `legacy-${"x".repeat(56)}`;
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      error: { code: "WORKFLOW_RENDER_FAILED", cause: { code: "ENOENT" } },
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId,
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  assert.match(resumed.value?.workflow_run_id ?? "", /^ufz-recovery-[a-f0-9]{32}$/u);
  const replacementRunId = resumed.value!.workflow_run_id;
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, new RegExp(`inspect ${workflowRunId} --format json`, "u"));
  assert.match(commands, new RegExp(`up .* --detach --run-id ${replacementRunId}`, "u"));
  assert.doesNotMatch(commands, /timeline|rewind|retry-task/u);
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    workflow?: { run_id?: string };
  };
  assert.equal(metadata.workflow?.run_id, replacementRunId);
});

test("resume suppresses duplicate submissions for every active workflow run state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-retrying-lifecycle-run",
      status: "running",
      state: "retrying",
      steps: [{ id: "node:project-discovery", state: "retrying", attempt: 2 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "retrying-lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  for (const state of [
    "in-progress",
    "started",
    "queued",
    "retrying",
    "waiting-approval",
    "waiting-event",
    "waiting-timer"
  ]) {
    fs.writeFileSync(
      env.SMITHERS_FAKE_INSPECT!,
      `${JSON.stringify(
        workflowInspect({
          workflowRunId: "ultrafuzz-retrying-lifecycle-run",
          status: "running",
          state,
          steps: [{ id: "node:project-discovery", state, attempt: 2 }]
        })
      )}\n`,
      "utf8"
    );
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const resumed = await resumeRun({ projectRoot: project, runId: "retrying-lifecycle-run", env });

    assert.equal(resumed.ok, true, `${state}: ${JSON.stringify(resumed.diagnostics)}`);
    assert.equal(resumed.value?.submitted, false, `state ${state} must suppress duplicate resume`);
    const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
    assert.match(commands, /inspect ultrafuzz-retrying-lifecycle-run --format json/u);
    assert.doesNotMatch(commands, /^up /mu, `state ${state} must not launch a duplicate up --resume`);
  }
});

test("resume re-submits a quota-waiting workflow after credentials change", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-quota-resume-run",
      status: "waiting-quota",
      state: "waiting-quota",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "quota-resume-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId: "quota-resume-run", env });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-quota-resume-run --format json/u);
  assert.match(commands, /^up .*--resume ultrafuzz-quota-resume-run/mu);
});

test("resume --reset-node does not repeat a committed reset after a failed continuation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-reset-lifecycle-run",
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "reset-lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const markerPath = path.join(run.value!.run_root, "smithers", "reset-node-applied.json");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const detached = await resumeRun({
    projectRoot: project,
    runId: "reset-lifecycle-run",
    resetNode: "node:project-discovery",
    env: { ...env, SMITHERS_FAKE_FAIL_UP: "1" }
  });

  assert.equal(detached.ok, false);
  assert.equal(detached.diagnostics[0]?.code, "WORKFLOW_LIFECYCLE_FAILED");
  assert.match(detached.diagnostics[0]?.message ?? "", /without repeating the reset/u);
  assert.equal(fs.existsSync(markerPath), true, "reset marker must persist after a failed continuation");
  const failedCommands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(failedCommands, /^timetravel /mu);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const retried = await resumeRun({
    projectRoot: project,
    runId: "reset-lifecycle-run",
    resetNode: "node:project-discovery",
    env
  });

  assert.equal(retried.ok, true, JSON.stringify(retried.diagnostics));
  assert.equal(retried.value?.submitted, true);
  assert.equal(fs.existsSync(markerPath), false, "reset marker must clear after a successful continuation");
  const retriedCommands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.doesNotMatch(retriedCommands, /^timetravel /mu, "retry must not repeat the destructive reset");
  assert.match(
    retriedCommands,
    /up .*ultrafuzz-reset-lifecycle-run\.tsx --resume ultrafuzz-reset-lifecycle-run --run-id ultrafuzz-reset-lifecycle-run --force --detach( --max-concurrency \d+)? --format json/u
  );
});

test("resume re-submits persisted workflow evidence when the workflow run was never created", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  const localConfig = fs.readFileSync(configPath, "utf8");
  fs.writeFileSync(
    configPath,
    `${localConfig.replace('[execution]\nmode = "local"', '[execution]\nmode = "cloud"\nprovider = "modal"')}

[execution.providers.modal]
app = "ultrafuzz-test"
image = "ultrafuzz-test"
credential_env = ["UFZ_PROVIDER_ONE", "UFZ_PROVIDER_TWO"]
`,
    "utf8"
  );

  const binDir = path.join(project, "fake-bin");
  const smithers = path.join(binDir, "smithers");
  const logPath = path.join(project, "recovery-smithers.log");
  const cloudEnvironmentLog = path.join(project, "recovery-cloud-environment.log");
  const markerPath = path.join(project, "initial-submission-attempted");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      'if [ -n "$SMITHERS_FAKE_CLOUD_ENV_LOG" ] && [ "$1" = "up" ]; then',
      '  printf \'%s|%s\\n\' "$UFZ_PROVIDER_ONE" "$UFZ_PROVIDER_TWO" >> "$SMITHERS_FAKE_CLOUD_ENV_LOG"',
      "fi",
      'if [ "$1" = "inspect" ]; then',
      "  printf '%s\\n' '{\"code\":\"INSPECT_FAILED\",\"message\":\"No Smithers run history found at /workspace/target/smithers.db. Run '\\''smithers up <workflow>'\\'' to start a run first.\"}'",
      "  exit 1",
      "fi",
      'if [ "$1" = "up" ] && [ ! -f "$SMITHERS_FAKE_MARKER" ]; then',
      '  : > "$SMITHERS_FAKE_MARKER"',
      "  exit 42",
      "fi",
      "printf '%s\\n' '{\"ok\":true}'",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  const env = {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_LOG: logPath,
    SMITHERS_FAKE_CLOUD_ENV_LOG: cloudEnvironmentLog,
    UFZ_PROVIDER_ONE: "provider-one",
    UFZ_PROVIDER_TWO: "provider-two",
    SMITHERS_FAKE_MARKER: markerPath
  };

  const initial = await startRun({ projectRoot: project, runId: "missing-workflow-run", env });
  assert.equal(initial.ok, false);
  fs.writeFileSync(configPath, localConfig, "utf8");
  fs.writeFileSync(cloudEnvironmentLog, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId: "missing-workflow-run",
    maxConcurrency: 8,
    env
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.workflow_run_id, "ultrafuzz-missing-workflow-run");

  const commands = fs.readFileSync(logPath, "utf8").split("\n");
  const upCommands = commands.filter((line) => line.startsWith("up "));
  assert.equal(upCommands.length, 2);
  assert.match(commands.find((line) => line.startsWith("inspect ")) ?? "", /--format json/u);
  assert.doesNotMatch(upCommands[1] ?? "", /--resume/u);
  assert.match(upCommands[1] ?? "", /--max-concurrency 8 --root /u);
  assert.match(upCommands[1] ?? "", /--log-dir .* --input /u);
  assert.equal(fs.readFileSync(cloudEnvironmentLog, "utf8"), "provider-one|provider-two\n");

  const runRoot = path.join(project, ".ultrafuzz", "runs", "missing-workflow-run");
  const recovery = JSON.parse(fs.readFileSync(path.join(runRoot, "smithers", "recovery-submission.json"), "utf8")) as {
    recovery?: string;
    command?: string[];
  };
  assert.equal(recovery.recovery, "missing-workflow-run");
  assert.equal(recovery.command?.includes("<redacted>"), true);
  const state = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8")) as { status?: string };
  assert.equal(state.status, "running");
});

test(
  "compiled Smithers workflow passes a real non-executing graph smoke",
  { skip: realSmithersGraphUnavailable() },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    fs.symlinkSync(
      path.join(workspaceRoot(), ".smithers", "node_modules"),
      path.join(project, ".smithers", "node_modules"),
      "dir"
    );

    const plan = await planRun({ projectRoot: project, runId: "graph-smoke", env: {} });
    assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
    const { compileSmithersWorkflow } = await import("../src/smithers.js");
    const compiled = compileSmithersWorkflow({
      projectRoot: project,
      config: plan.value!.resolved_config,
      graph: plan.value!.expanded_graph,
      runLayout: plan.value!.layout,
      workflowName: "ultrafuzz-graph-smoke",
      renderedPrompts: plan.value!.rendered_prompts,
      operatorPrompt: "graph smoke"
    });

    const graphProcess = spawnSync(
      "smithers",
      [
        "graph",
        compiled.evidenceWorkflowPath,
        "--run-id",
        compiled.smithersRunId,
        "--root",
        project,
        "--input",
        fs.readFileSync(compiled.inputPath, "utf8"),
        "--compact",
        "--format",
        "json"
      ],
      {
        cwd: project,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
        env: { ...process.env, OPENAI_API_KEY: "test-openai-api-key" }
      }
    );
    if (graphProcess.status !== 0 || graphProcess.stdout.trim() === "") {
      throw (
        graphProcess.error ??
        new Error(
          [
            `smithers graph exited ${String(graphProcess.status)}`,
            graphProcess.stderr.trim(),
            graphProcess.stdout.trim()
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
    }
    const graphJson = graphProcess.stdout;
    const graph = JSON.parse(graphJson) as { tasks?: Array<{ nodeId?: string }> };
    assert.equal(graph.tasks?.[0]?.nodeId, "prepare:project-discovery");
    assert.equal(
      graph.tasks?.some((task) => task.nodeId === "node:project-discovery"),
      true
    );
    assert.equal(
      graph.tasks?.some((task) => task.nodeId === "verify:project-discovery"),
      true
    );
  }
);

function realSmithersGraphUnavailable(): string | false {
  try {
    execFileSync("smithers", ["graph", "--help"], { stdio: "ignore" });
  } catch {
    return "smithers CLI is not installed";
  }
  if (!fs.existsSync(path.join(workspaceRoot(), ".smithers", "node_modules", "smithers-orchestrator"))) {
    return ".smithers Smithers dependencies are not installed";
  }
  return false;
}

function workspaceRoot(): string {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}
