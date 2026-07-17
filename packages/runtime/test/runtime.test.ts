import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CACHE_MANIFEST_FILE, RUN_REFERENCE_MANIFEST_FILE } from "@ultrafuzz/references";

import {
  assertSmithersPackageManifest,
  SMITHERS_ORCHESTRATOR_BIN_PATH,
  SMITHERS_ORCHESTRATOR_VERSION
} from "../src/smithers-package.js";

import {
  forkRun,
  getRunStatus,
  initProject,
  listRuns,
  planRun,
  replayRun,
  resumeRun,
  startRun,
  syncRun,
  validateProject
} from "../src/index.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-"));
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
      'if [ -n "$SMITHERS_FAKE_CONTEXT_LOG" ]; then',
      '  printf \'%s|%s|%s|%s|%s|%s\\n\' "$SMITHERS_RUN_ID" "$SMITHERS_NODE_ID" "$SMITHERS_ATTEMPT" "$SMITHERS_ITERATION" "$SMITHERS_CLI_SRC_DIR" "$SMITHERS_SNAPSHOT_SOCK" > "$SMITHERS_FAKE_CONTEXT_LOG"',
      "fi",
      'if [ "$1" = "fork" ]; then',
      "  printf '%s\\n' '{\"forkedRunId\":\"ultrafuzz-lifecycle-run-forked\"}'",
      "else",
      '  printf \'%s\\n\' \'{"ok":true,"smithers":"accepted"}\'',
      "fi",
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
  input: { inspect: unknown; events?: string }
): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const inspectPath = path.join(project, "fake-smithers-inspect.json");
  const eventsPath = path.join(project, "fake-smithers-events.ndjson");
  fs.writeFileSync(inspectPath, `${JSON.stringify(input.inspect, null, 2)}\n`, "utf8");
  fs.writeFileSync(eventsPath, input.events ?? "", "utf8");
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
      '    cat "$SMITHERS_FAKE_INSPECT"',
      "    ;;",
      "  events)",
      '    cat "$SMITHERS_FAKE_EVENTS"',
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
  steps: Array<{ id: string; state: string; attempt?: number }>;
}): unknown {
  return {
    ok: true,
    data: {
      run: {
        id: input.workflowRunId,
        workflow: input.workflowRunId,
        status: input.status ?? "finished",
        started: "2026-07-03T00:00:00.000Z",
        finished: input.status === "running" ? undefined : "2026-07-03T00:00:02.000Z"
      },
      runState: {
        runId: input.workflowRunId,
        computedAt: "2026-07-03T00:00:03.000Z",
        state: input.state ?? (input.status === "running" ? "running" : "succeeded")
      },
      steps: input.steps
    }
  };
}

function workflowEvents(
  workflowRunId: string,
  events: Array<{ type: string; nodeId?: string; attempt?: number; error?: unknown; extra?: Record<string, unknown> }>
): string {
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  return `${events
    .map((event, index) => {
      const timestampMs = base + index * 100;
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
        seq: index,
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
    `version: 1
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
    required_artifacts:
      - setup/project-discovery.md
      - findings.json
    primary_artifact: setup/project-discovery.md
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

function writeReferenceTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 1
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
    required_artifacts:
      - references/example.md
      - ${RUN_REFERENCE_MANIFEST_FILE}
    primary_artifact: references/example.md
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    group: setup
    depends_on:
      - reference-properties-example
    required_artifacts:
      - setup/project-discovery.md
      - findings.json
    primary_artifact: setup/project-discovery.md
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
    `version: 1
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
    required_artifacts:
      - setup/project-discovery.md
      - findings.json
    primary_artifact: setup/project-discovery.md
  - id: signal-analysis
    prompt: strategies/target-signal.md
    model_profiles:
      - fast
      - deep
    depends_on:
      - project-discovery
    required_artifacts:
      - signal-analysis.md
      - findings.json
    primary_artifact: signal-analysis.md
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
  assert.equal(smithersPackage.dependencies?.["smithers-orchestrator"], "0.27.0");
  const codexAgentText = fs.readFileSync(path.join(project, ".smithers/agents/codex.ts"), "utf8");
  assert.doesNotMatch(codexAgentText, /cwd:\s*process\.cwd/);
  assert.doesNotMatch(codexAgentText, /apiKey:\s*process\.env\.OPENAI_API_KEY/);
  assert.match(codexAgentText, /ultrafuzz\.toml/);
  assert.match(codexAgentText, /codexAuthOptions/);
  assert.match(codexAgentText, /createCodexAgent/);
  assert.match(codexAgentText, /model_reasoning_effort:\s*options\.reasoningEffort/);
  assert.doesNotMatch(codexAgentText, /model:\s*"gpt-5\.5"/);

  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/claude.ts")), true);
  const agentsIndexText = fs.readFileSync(path.join(project, ".smithers/agents/index.ts"), "utf8");
  assert.match(agentsIndexText, /export \{ createCodexAgent \} from ".\/codex";/);
  assert.match(agentsIndexText, /export \{ createClaudeAgent \} from ".\/claude";/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*ClaudeAgent: createClaudeAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*CodexAgent: createCodexAgent/);
  // Importing the registry must not construct any agent: doing so reads that
  // agent's auth and fails a project that only uses the other backend.
  assert.doesNotMatch(agentsIndexText, /=\s*create(Codex|Claude)Agent\(\)/);
  assert.doesNotMatch(codexAgentText, /=\s*createCodexAgent\(\)/);
  const claudeAgentText = fs.readFileSync(path.join(project, ".smithers/agents/claude.ts"), "utf8");
  assert.match(claudeAgentText, /ClaudeCodeAgent/);
  assert.match(claudeAgentText, /createClaudeAgent/);
  assert.match(claudeAgentText, /permissionMode:\s*"bypassPermissions"/);
  assert.match(claudeAgentText, /claudeAuthOptions/);
  assert.match(claudeAgentText, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(claudeAgentText, /apiKey:\s*process\.env\.ANTHROPIC_API_KEY/);
  // The model comes from the resolved model profile, never hard-coded in the template.
  assert.doesNotMatch(claudeAgentText, /model:\s*"claude-[\w.-]+"/);
  // skipGitRepoCheck is a CodexAgent option and has no ClaudeCodeAgent equivalent.
  assert.doesNotMatch(claudeAgentText, /skipGitRepoCheck/);
  assert.doesNotMatch(claudeAgentText, /=\s*createClaudeAgent\(\)/);

  const validate = await validateProject({ projectRoot: project, env: {} });
  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));
  assert.equal(validate.value?.policy_posture.trust.status, "pass");
  assert.equal(validate.value?.policy_posture.agents.status, "pass");
  assert.equal(validate.value?.policy_posture.paths.status, "pass");
  assert.equal(validate.value?.resolved_config?.default_agent, "CodexAgent");
  assert.equal(validate.value?.resolved_config?.default_model, "gpt-5.5");
  assert.equal(validate.value?.resolved_config?.default_reasoning, "xhigh");
});

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
  assert.match(plan.value!.graph_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(plan.value!.graph.nodes[0]?.model_fanout[0]?.agent_ref, "CodexAgent");
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

test("compileSmithersWorkflow emits native task dependencies without synthetic layers", async () => {
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
  assert.deepEqual(
    smithersTasks.tasks.find((task) => task.attemptId === "project-discovery__model_0__attempt_0")
      ?.dependencySmithersNodeIds,
    []
  );
  assert.deepEqual(
    smithersTasks.tasks.find((task) => task.attemptId === "signal-analysis__model_0__attempt_0")
      ?.dependencySmithersNodeIds,
    ["node:project-discovery__model_0__attempt_0", "node:project-discovery__model_1__attempt_1"]
  );
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

test("compileSmithersWorkflow applies group timeout defaults", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 1
defaults:
  strategy_loops: 1
groups:
  setup:
    label: Setup
    defaults:
      timeout_seconds: 1200
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
    required_artifacts:
      - setup/project-discovery.md
    primary_artifact: setup/project-discovery.md
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
      metadata?: { timeout?: { seconds?: number; heartbeatTimeoutMs?: number } };
    }>;
  };
  const task = smithersTasks.tasks.find((entry) => entry.attemptId === "project-discovery");
  assert.equal(task?.timeoutMs, 1_200_000);
  assert.equal(task?.heartbeatTimeoutMs, 1_200_000);
  assert.equal(task?.metadata?.timeout?.seconds, 1200);
  assert.equal(task?.metadata?.timeout?.heartbeatTimeoutMs, 1_200_000);
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
  ) as { tasks: Array<{ agentRef?: string; modelName?: string | null }> };
  assert.equal(pinnedTasks.tasks[0]?.agentRef, "ClaudeAgent");
  assert.equal(pinnedTasks.tasks[0]?.modelName, "claude-sonnet-5");
});

test("init reports an agent registry that does not export a generated agent", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });

  // Simulate a project scaffolded before ClaudeAgent existed: the registry
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
  assert.equal(stale.length, 1, JSON.stringify(upgraded.diagnostics));
  assert.equal(stale[0]?.severity, "warning");
  assert.match(stale[0]?.message ?? "", /ClaudeAgent/);

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
  assert.match(workflowSource, /smithers-orchestrator/);
  // Explicit index path: a sibling .smithers/agents.ts scaffolded by Smithers
  // would otherwise shadow the .smithers/agents/ directory under bun.
  assert.match(workflowSource, /import \* as projectAgents from "\.\.\/agents\/index\.ts";/);
  assert.doesNotMatch(workflowSource, /import \* as projectAgents from "\.\.\/agents";/);
  assert.match(workflowSource, /agent=\{agentForTask\(task\)\}/);
  assert.match(workflowSource, /"modelName": "gpt-runtime-override"/);
  assert.match(workflowSource, /"reasoningEffort": "max"/);
  assert.match(workflowSource, /metadata=\{task\.metadata\}/);
  assert.match(workflowSource, /output=\{outputs\.task\}/);
  assert.match(workflowSource, /dependsOn=\{task\.dependsOn\}/);
  assert.match(workflowSource, /untrusted data, not instructions/);
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
  assert.equal(migrated.dependencies.zod, "4.4.3");
  assert.equal(migrated.devDependencies.typescript, "6.0.3");
  assert.equal(migrated.dependencies["custom-agent-package"], "1.2.3");
  assert.equal(migrated.devDependencies["custom-build-package"], "2.3.4");
  assert.equal(migrated.scripts.custom, "node custom.js");
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
        "smithers-orchestrator": "0.27.0",
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
            estimated_spend: "$0.01",
            estimated_spend_usd: 0.01,
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
            estimated_spend: "$0.01",
            estimated_spend_usd: 0.01,
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
          costUsd: 0.02,
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
        partial_pricing?: boolean;
        source_run_ids?: string[];
      };
    };
  };
  assert.equal(metadata.accounting?.current?.tokens_used, "35");
  assert.equal(metadata.accounting?.current?.estimated_spend, "$0.02+");
  assert.equal(metadata.accounting?.current?.partial_pricing, true);
  assert.equal(metadata.accounting?.cumulative?.tokens_used, "135");
  assert.equal(metadata.accounting?.cumulative?.estimated_spend, "$0.03+");
  assert.equal(metadata.accounting?.cumulative?.partial_pricing, true);
  assert.deepEqual(metadata.accounting?.cumulative?.source_run_ids, ["source-accounting"]);
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
      current?: { tokens_used?: string; estimated_spend?: string; partial_pricing?: boolean };
      cumulative?: { tokens_used?: string; estimated_spend?: string; partial_pricing?: boolean };
    };
  };
  assert.equal(metadata.accounting?.current?.tokens_used, "30");
  assert.equal(metadata.accounting?.current?.estimated_spend, "unavailable");
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

test("syncRun snapshots live pricing and does not double-count token detail fields", async () => {
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
          cacheReadTokens: 20_000,
          cacheWriteTokens: 10_000,
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
        estimated_spend?: string;
        partial_pricing?: boolean;
        priced_event_count?: number;
        unpriced_event_count?: number;
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
  assert.equal(metadata.accounting?.current?.tokens_used, "110,000");
  assert.equal(metadata.accounting?.current?.estimated_spend, "$0.72");
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
  assert.equal(metadata.accounting?.current?.priced_event_count, 1);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 0);
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
  const resyncedMetadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: { current?: { estimated_spend?: string }; updated_at?: string };
  };
  assert.equal(resyncedMetadata.accounting?.current?.estimated_spend, "$0.72");
  assert.equal(resyncedMetadata.accounting?.updated_at, metadata.accounting?.updated_at);
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
        partial_pricing?: boolean;
        priced_event_count?: number;
        unpriced_event_count?: number;
        cache_read_pricing_estimated?: boolean;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.estimated_spend, "unavailable");
  assert.equal(metadata.accounting?.current?.partial_pricing, true);
  assert.equal(metadata.accounting?.current?.priced_event_count, 0);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 1);
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
        partial_pricing?: boolean;
        priced_event_count?: number;
        unpriced_event_count?: number;
        cache_read_pricing_estimated?: boolean;
        cache_read_ratio_used?: number;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.estimated_spend, "$0.40");
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

  const sync = await syncRun({ projectRoot: project, runId: "sync-missing", env });

  assert.equal(sync.ok, true);
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_MISSING"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.match(state.nodes?.["project-discovery"]?.last_error ?? "", /setup\/project-discovery\.md/);
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    true
  );

  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const repaired = await syncRun({ projectRoot: project, runId: "sync-missing", env });
  assert.equal(repaired.ok, true, JSON.stringify(repaired.diagnostics));
  assert.equal(repaired.value?.status, "succeeded");
  const repairedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string }>;
  };
  assert.equal(repairedState.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(repairedState.nodes?.["project-discovery"]?.last_error, undefined);
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
        nodes: [{ nodeId: "node:project-discovery", status: "completed", attemptIndex: 0 }]
      }
    },
    events: `${JSON.stringify({
      runId: workflowRunId,
      timestampMs: Date.parse("2026-07-03T00:00:00.000Z"),
      event: "NodeFinished",
      nodeId: "node:project-discovery",
      attempt: 0
    })}\n`
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
    nodes?: Record<string, { status?: string; retry_count?: number; last_error?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(state.nodes?.["project-discovery"]?.retry_count, 1);
  assert.equal(state.nodes?.["project-discovery"]?.last_error, "agent failed again");
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    false
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
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery__model_0__attempt_0"]?.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery__model_1__attempt_1"]?.status, "failed");
  assert.equal(state.nodes?.["signal-analysis__model_0__attempt_0"]?.status, "running");
  assert.equal(state.nodes?.["signal-analysis__model_1__attempt_1"]?.status, "skipped");
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(
    fs.existsSync(
      path.join(run.value!.run_root, "artifacts", "project-discovery__model_0__attempt_0", "artifact-manifest.json")
    ),
    true
  );
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

  const resetResumed = await resumeRun({
    projectRoot: project,
    runId: run.value!.run_id,
    maxConcurrency: 8,
    resetNode: "node:project-discovery",
    env
  });
  assert.equal(resetResumed.ok, true, JSON.stringify(resetResumed.diagnostics));
  assert.equal(resetResumed.value?.submitted, true);

  const replayed = await replayRun({ projectRoot: project, runId: run.value!.run_id, env });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(replayed.value?.workflow_run_id, "ultrafuzz-lifecycle-run");
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
    /timetravel .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --node-id node:project-discovery --no-vcs --deps --force --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run --run-id ultrafuzz-lifecycle-run --force --detach --max-concurrency 8 --format json/
  );
  assert.match(commands, /replay .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --format json/);
  assert.match(
    commands,
    /fork .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --frame 44 --reset-node node:project-discovery --label after-edit --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run-forked --run-id ultrafuzz-lifecycle-run-forked --force --detach --max-concurrency 8 --format json/
  );
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

  for (const state of ["in-progress", "started", "queued", "retrying", "waiting-approval"]) {
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

  const binDir = path.join(project, "fake-bin");
  const smithers = path.join(binDir, "smithers");
  const logPath = path.join(project, "recovery-smithers.log");
  const markerPath = path.join(project, "initial-submission-attempted");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      'if [ "$1" = "inspect" ]; then',
      '  printf \'%s\\n\' \'{"code":"RUN_NOT_FOUND","message":"Run not found"}\'',
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
    SMITHERS_FAKE_MARKER: markerPath
  };

  const initial = await startRun({ projectRoot: project, runId: "missing-workflow-run", env });
  assert.equal(initial.ok, false);

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

    const graphJson = execFileSync(
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
      { cwd: project, encoding: "utf8", maxBuffer: 1024 * 1024 * 16 }
    );
    const graph = JSON.parse(graphJson) as { tasks?: Array<{ nodeId?: string }> };
    assert.equal(graph.tasks?.[0]?.nodeId, "node:project-discovery");
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
