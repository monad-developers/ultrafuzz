#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MANIFEST_PATH = path.join(REPO_ROOT, "benchmarks", "stableswap-ng-vyper", "ground-truth.json");
const RUNTIME_ENTRY = path.join(REPO_ROOT, "packages", "runtime", "dist", "index.js");
const BENCHMARK_CACHE_ROOT = path.resolve(
  REPO_ROOT,
  process.env.ULTRAFUZZ_STABLESWAP_NG_CACHE_DIR ??
    path.join(REPO_ROOT, ".ultrafuzz", "cache", "benchmarks", "stableswap-ng-vyper")
);
const GIT_TIMEOUT_MS = 120_000;

const REQUIRED_SETUP_GUIDANCE = {
  projectDiscovery: [
    "whether production contracts are Solidity, Vyper, or mixed Solidity/Vyper",
    "Record `.vy` production contracts",
    "Vyper-only projects as still needing Solidity-based Foundry tests",
    "project-local compiler evidence"
  ],
  setupFoundry: [
    "Solidity interfaces",
    "public/external ABI",
    "target project's pinned compiler/tooling",
    "`vm.ffi`",
    "hex-decodes the compiler stdout",
    "ABI-encoded `__init__`",
    "without a function selector",
    "`bytes.concat(decodedBytecode, abi.encode(...))`",
    "inline `create`",
    "never pass undecoded `vm.ffi` stdout directly to `create`",
    "`forge test --ffi`",
    "`ffi = true`",
    "`vm.etch` writes runtime bytecode",
    "does not run constructor"
  ],
  baseTestSetup: [
    "Vyper-aware while keeping the tests",
    "ABI-visible",
    "`vm.ffi` plus inline `create`",
    "hex-decode ASCII hex compiler stdout",
    "append ABI-encoded `__init__` constructor",
    "without a function selector",
    "`bytes.concat(decodedBytecode, abi.encode(...))`",
    "Do not pass undecoded `vm.ffi` stdout directly to `create`",
    "constructor-dependent Vyper contracts need decoded initcode",
    "`vm.etch` does not run constructors or init code",
    "project-local Vyper dependencies as explicit validation blockers"
  ]
};

const manifest = readJson(MANIFEST_PATH);
validateManifest(manifest);

const targetRoot = path.join(BENCHMARK_CACHE_ROOT, "checkouts", manifest.target.audited_commit);
const workRoot = path.join(BENCHMARK_CACHE_ROOT, "work", "setup-smoke");
const reportRoot = path.join(BENCHMARK_CACHE_ROOT, "last-smoke-evidence");

await main();

async function main() {
  fs.mkdirSync(BENCHMARK_CACHE_ROOT, { recursive: true });
  ensureTargetCheckout(targetRoot, manifest.target.repository_url, manifest.target.audited_commit);
  const targetEvidence = scanTarget(targetRoot, manifest);
  validateGroundTruthLineAnchors(targetRoot, manifest);

  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.rmSync(reportRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(reportRoot, { recursive: true });
  const projectLocalTarget = prepareProjectLocalTarget(workRoot, targetRoot);

  const setupEvidence = await renderSetupPhase(workRoot, projectLocalTarget.relativePath, manifest, targetEvidence);
  validateSetupEvidence(setupEvidence, manifest);

  const reportPath = path.join(reportRoot, "report.json");
  writeJson(reportPath, {
    schema_version: "1.0",
    benchmark_id: manifest.benchmark_id,
    target: {
      repository: manifest.target.repository,
      audited_commit: manifest.target.audited_commit,
      fixed_commit: manifest.target.fixed_commit,
      checkout: targetRoot,
      project_local_checkout: projectLocalTarget.absolutePath
    },
    run_root: setupEvidence.runRoot,
    rendered_prompts: setupEvidence.renderedPrompts,
    setup_handoffs: setupEvidence.handoffPaths,
    compiler_evidence: targetEvidence.compilerEvidence,
    vyper_files: targetEvidence.vyperFiles,
    selected_findings: manifest.selected_findings.map((finding) => finding.id)
  });

  console.log(`StableSwapNG Vyper setup smoke passed. Evidence: ${reportPath}`);
}

function prepareProjectLocalTarget(projectRoot, checkoutPath) {
  const absolutePath = path.join(projectRoot, "repo");
  runGit(projectRoot, ["clone", "--shared", checkoutPath, "repo"]);
  const actual = runGit(absolutePath, ["rev-parse", "HEAD"]).trim();
  assertEqual(actual, manifest.target.audited_commit, "project-local target checkout commit");
  return {
    relativePath: "repo",
    absolutePath
  };
}

function validateManifest(value) {
  assertRecord(value, "ground-truth manifest");
  assertEqual(value.schema_version, "1.0", "manifest schema_version");
  assertEqual(value.benchmark_id, "stableswap-ng-vyper", "manifest benchmark_id");
  assertRecord(value.target, "manifest target");
  assertEqual(value.target.repository, "curvefi/stableswap-ng", "target repository");
  assertFullSha(value.target.audited_commit, "target audited_commit");
  assertFullSha(value.target.fixed_commit, "target fixed_commit");
  assertEqual(value.target.audited_commit, "8c78731ed43c22e6bcdcb5d39b0a7d02f8cb0386", "target audited_commit");
  assertEqual(value.target.fixed_commit, "bff1522b30819b7b240af17ccfb72b0effbf6c47", "target fixed_commit");
  assertArray(value.target.audited_files, "target audited_files");
  assertArray(value.target.project_local_tooling, "target project_local_tooling");
  assertRecord(value.audit, "manifest audit");
  assertArray(value.selected_findings, "selected_findings");
  if (value.selected_findings.length === 0) {
    fail("ground-truth manifest must include at least one selected finding");
  }
  for (const finding of value.selected_findings) {
    assertRecord(finding, "selected finding");
    assertString(finding.id, "finding id");
    assertString(finding.severity, `finding ${finding.id} severity`);
    assertString(finding.title, `finding ${finding.id} title`);
    assertEqual(finding.status, "Fixed", `finding ${finding.id} status`);
    assertEqual(finding.audited_commit, value.target.audited_commit, `finding ${finding.id} audited_commit`);
    assertEqual(finding.fixed_commit, value.target.fixed_commit, `finding ${finding.id} fixed_commit`);
    assertString(finding.source_url, `finding ${finding.id} source_url`);
    assertArray(finding.affected_locations, `finding ${finding.id} affected_locations`);
    if (finding.affected_locations.length === 0) {
      fail(`finding ${finding.id} must include at least one affected location`);
    }
    for (const location of finding.affected_locations) {
      assertRecord(location, `finding ${finding.id} location`);
      assertString(location.path, `finding ${finding.id} location path`);
      assertPositiveInteger(location.start_line, `finding ${finding.id} start_line`);
      assertPositiveInteger(location.end_line, `finding ${finding.id} end_line`);
      assertString(location.line_text_must_contain, `finding ${finding.id} line_text_must_contain`);
      if (location.end_line < location.start_line) {
        fail(`finding ${finding.id} location ${location.path} has end_line before start_line`);
      }
    }
  }
}

function ensureTargetCheckout(checkoutPath, repositoryUrl, auditedCommit) {
  const requiredPaths = [...manifest.target.audited_files, "pyproject.toml", "ape-config.yaml", "poetry.lock"];
  if (checkoutIsUsable(checkoutPath, auditedCommit, requiredPaths)) {
    return;
  }

  fs.rmSync(checkoutPath, { recursive: true, force: true });
  fs.mkdirSync(checkoutPath, { recursive: true });
  runGit(checkoutPath, ["init", "-q"]);
  runGit(checkoutPath, ["remote", "add", "origin", `${repositoryUrl}.git`]);
  runGit(checkoutPath, ["fetch", "--depth=1", "--filter=blob:none", "origin", auditedCommit]);
  runGit(checkoutPath, ["checkout", "-q", "--detach", "FETCH_HEAD"]);

  const actual = runGit(checkoutPath, ["rev-parse", "HEAD"]).trim();
  assertEqual(actual, auditedCommit, "checked-out StableSwapNG commit");
}

function checkoutIsUsable(checkoutPath, auditedCommit, requiredPaths) {
  if (!fs.existsSync(path.join(checkoutPath, ".git"))) {
    return false;
  }
  try {
    const actual = runGit(checkoutPath, ["rev-parse", "HEAD"]).trim();
    return (
      actual === auditedCommit &&
      requiredPaths.every((relativePath) => fs.existsSync(path.join(checkoutPath, relativePath)))
    );
  } catch {
    return false;
  }
}

function scanTarget(checkoutPath, value) {
  const pyproject = readText(path.join(checkoutPath, "pyproject.toml"));
  const apeConfig = readText(path.join(checkoutPath, "ape-config.yaml"));
  const poetryLockPath = path.join(checkoutPath, "poetry.lock");
  const vyperFiles = collectFiles(path.join(checkoutPath, "contracts", "main"), ".vy").map((filePath) =>
    toPosix(path.relative(checkoutPath, filePath))
  );

  for (const expectedFile of value.target.audited_files) {
    if (!vyperFiles.includes(expectedFile)) {
      fail(`pinned target is missing expected audited Vyper file: ${expectedFile}`);
    }
  }

  assertIncludes(pyproject, 'vyper = "^0.3.9"', "pyproject Vyper dependency");
  assertIncludes(pyproject, "titanoboa", "pyproject titanoboa dependency");
  assertIncludes(pyproject, "e29a70640b67c3e87c248a582454ae6fe8eeec00", "pyproject titanoboa rev");
  assertIncludes(pyproject, 'eth-ape = "^0.6.18"', "pyproject eth-ape dependency");
  assertIncludes(apeConfig, "contracts_folder: contracts/main/", "ape contracts folder");
  assertIncludes(apeConfig, "- name: vyper", "ape Vyper plugin");
  if (!fs.existsSync(poetryLockPath)) {
    fail("pinned target is missing poetry.lock");
  }

  return {
    vyperFiles,
    compilerEvidence: [
      {
        path: "pyproject.toml",
        evidence: 'vyper = "^0.3.9"'
      },
      {
        path: "pyproject.toml",
        evidence: "titanoboa git rev e29a70640b67c3e87c248a582454ae6fe8eeec00"
      },
      {
        path: "pyproject.toml",
        evidence: 'eth-ape = "^0.6.18"'
      },
      {
        path: "ape-config.yaml",
        evidence: "contracts_folder: contracts/main/"
      },
      {
        path: "ape-config.yaml",
        evidence: "ape Vyper plugin"
      },
      {
        path: "poetry.lock",
        evidence: "lockfile exists"
      }
    ]
  };
}

function validateGroundTruthLineAnchors(checkoutPath, value) {
  for (const finding of value.selected_findings) {
    for (const location of finding.affected_locations) {
      const filePath = path.join(checkoutPath, location.path);
      const lines = readText(filePath).split(/\r?\n/u);
      const excerpt = lines.slice(location.start_line - 1, location.end_line).join("\n");
      assertIncludes(excerpt, location.line_text_must_contain, `${finding.id} line anchor ${location.path}`);
    }
  }
}

async function renderSetupPhase(projectRoot, targetRepoPath, value, targetEvidence) {
  if (!fs.existsSync(RUNTIME_ENTRY)) {
    fail(`runtime dist entry is missing: ${RUNTIME_ENTRY}; run pnpm -w build before the smoke`);
  }
  const { initProject, startRun } = await import(pathToFileURL(RUNTIME_ENTRY).href);
  const init = initProject({ projectRoot, force: true });
  if (!init.ok) {
    fail(`ultrafuzz init failed for smoke project: ${JSON.stringify(init.diagnostics, null, 2)}`);
  }

  fs.writeFileSync(path.join(projectRoot, "ultrafuzz.toml"), smokeConfigToml(targetRepoPath), "utf8");
  fs.writeFileSync(path.join(projectRoot, ".ultrafuzz", "topology.yml"), setupOnlyTopologyYaml(), "utf8");

  const run = await startRun({
    projectRoot,
    runId: "stableswap-ng-vyper-setup-smoke",
    env: fakeSmithersEnv(projectRoot),
    maxConcurrency: 1
  });
  if (!run.ok) {
    fail(`ultrafuzz setup smoke run failed: ${JSON.stringify(run.diagnostics, null, 2)}`);
  }

  const runRoot = run.value.run_root;
  const renderedPrompts = {
    projectDiscovery: path.join(runRoot, "artifacts", "project-discovery", "prompt.rendered.md"),
    setupFoundry: path.join(runRoot, "artifacts", "setup-foundry", "prompt.rendered.md"),
    baseTestSetup: path.join(runRoot, "artifacts", "base-test-setup", "prompt.rendered.md")
  };
  const renderedText = Object.fromEntries(
    Object.entries(renderedPrompts).map(([key, promptPath]) => [key, readText(promptPath)])
  );
  validateRenderedSetupPrompts(renderedText);

  const handoffPaths = writeSetupHandoffs(runRoot, value, targetEvidence, renderedPrompts);
  return {
    runRoot,
    renderedPrompts,
    handoffPaths
  };
}

function fakeSmithersEnv(projectRoot) {
  const binDir = path.join(projectRoot, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const executable = path.join(binDir, process.platform === "win32" ? "smithers.cmd" : "smithers");
  if (process.platform === "win32") {
    fs.writeFileSync(executable, '@echo off\necho {"ok":true,"smithers":"accepted"}\n', "utf8");
  } else {
    fs.writeFileSync(executable, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"smithers":"accepted"}\'\n', "utf8");
    fs.chmodSync(executable, 0o755);
  }
  return {
    SMITHERS_BIN: executable
  };
}

function validateRenderedSetupPrompts(renderedText) {
  for (const needle of REQUIRED_SETUP_GUIDANCE.projectDiscovery) {
    assertIncludes(renderedText.projectDiscovery, needle, "rendered project discovery prompt");
  }
  for (const needle of REQUIRED_SETUP_GUIDANCE.setupFoundry) {
    assertIncludes(renderedText.setupFoundry, needle, "rendered setup Foundry prompt");
  }
  for (const needle of REQUIRED_SETUP_GUIDANCE.baseTestSetup) {
    assertIncludes(renderedText.baseTestSetup, needle, "rendered base-test setup prompt");
  }
}

function writeSetupHandoffs(runRoot, value, targetEvidence, renderedPrompts) {
  const projectDiscoveryPath = path.join(runRoot, "artifacts", "project-discovery", "setup", "project-discovery.md");
  const setupFoundryPath = path.join(runRoot, "artifacts", "setup-foundry", "setup", "setup-foundry.md");
  const baseTestSetupPath = path.join(runRoot, "artifacts", "base-test-setup", "setup", "base-test-setup.md");
  const provenancePath = path.join(
    runRoot,
    "artifacts",
    "project-discovery",
    "setup",
    "stableswap-ng-vyper-provenance.json"
  );

  writeText(
    projectDiscoveryPath,
    [
      "# StableSwapNG Vyper Project Discovery",
      "",
      `- Repository: ${value.target.repository}`,
      `- Audited commit: ${value.target.audited_commit}`,
      `- Fixed commit: ${value.target.fixed_commit}`,
      `- Audit source: ${value.audit.github_report_url}`,
      `- Audit PDF: ${value.audit.curve_pdf_url}`,
      "- Production language: Vyper-only production contracts under `contracts/main/`.",
      "- Vyper project discovery: `.vy` production contracts were found and the setup must keep Solidity-based Foundry tests interacting through Solidity interfaces.",
      "- Project-local compiler and dependency evidence:",
      ...targetEvidence.compilerEvidence.map((entry) => `  - ${entry.path}: ${entry.evidence}`),
      "- Audited Vyper files:",
      ...value.target.audited_files.map((filePath) => `  - ${filePath}`),
      "- Selected audit ground truth:",
      ...value.selected_findings.map(
        (finding) =>
          `  - ${finding.id}: ${finding.severity} / ${finding.status} / ${finding.title} (${finding.audit_section})`
      ),
      ""
    ].join("\n")
  );

  writeText(
    setupFoundryPath,
    [
      "# StableSwapNG Vyper Foundry Handoff",
      "",
      `- Source discovery prompt: ${renderedPrompts.projectDiscovery}`,
      "- Keep generated tests Solidity-based and define Solidity interfaces for Vyper contracts' public/external ABI.",
      "- Compile Vyper bytecode with project-local tooling from `pyproject.toml`, `poetry.lock`, and `ape-config.yaml`; do not rely on host-global Vyper installs.",
      "- Use a reusable deployment helper that calls `vm.ffi`, hex-decodes ASCII hex compiler stdout into raw creation bytecode, appends ABI-encoded `__init__` constructor arguments without a function selector using `bytes.concat(decodedBytecode, abi.encode(...))`, and deploys via inline `create`.",
      "- Run local validation with `forge test --ffi` or `ffi = true` in `foundry.toml` when the helper uses `vm.ffi`.",
      "- Reserve `vm.etch` for runtime-code injection cases only; it writes runtime bytecode and does not run constructor or init code.",
      `- Ground-truth provenance: ${value.selected_findings.map((finding) => finding.id).join(", ")}`,
      ""
    ].join("\n")
  );

  writeText(
    baseTestSetupPath,
    [
      "# StableSwapNG Vyper BaseTest Handoff",
      "",
      `- Source setup prompt: ${renderedPrompts.setupFoundry}`,
      "- Build a Vyper-aware BaseTest/Setup fixture while keeping tests Solidity-based.",
      "- Reuse ABI-visible Solidity interfaces or generated ABI-derived interfaces for Vyper contracts.",
      "- Centralize Vyper deployment in a `vm.ffi` plus inline `create` helper that hex-decodes initcode and appends ABI-encoded `__init__` constructor arguments with `bytes.concat(decodedBytecode, abi.encode(...))`.",
      "- Do not pass undecoded `vm.ffi` stdout directly to `create`; constructor-dependent Vyper contracts need decoded initcode plus appended constructor data.",
      "- Treat unavailable `forge`, `vyper`, `vyper-json`, Poetry, Ape, or titanoboa dependencies as explicit validation blockers.",
      "- Use `vm.etch` only when runtime-bytecode injection is intentional and storage initialization is handled separately.",
      `- Audit provenance: ${value.audit.github_report_url}`,
      ""
    ].join("\n")
  );

  writeJson(provenancePath, {
    schema_version: "1.0",
    benchmark_id: value.benchmark_id,
    repository: value.target.repository,
    audited_commit: value.target.audited_commit,
    fixed_commit: value.target.fixed_commit,
    audit_sources: [value.audit.github_report_url, value.audit.curve_pdf_url],
    selected_findings: value.selected_findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
      source_url: finding.source_url,
      affected_locations: finding.affected_locations
    }))
  });

  return {
    projectDiscovery: projectDiscoveryPath,
    setupFoundry: setupFoundryPath,
    baseTestSetup: baseTestSetupPath,
    provenance: provenancePath
  };
}

function validateSetupEvidence(setupEvidence, value) {
  const projectDiscovery = readText(setupEvidence.handoffPaths.projectDiscovery);
  const setupFoundry = readText(setupEvidence.handoffPaths.setupFoundry);
  const baseTestSetup = readText(setupEvidence.handoffPaths.baseTestSetup);
  const provenance = readJson(setupEvidence.handoffPaths.provenance);

  for (const needle of [
    "Vyper project discovery",
    "Project-local compiler and dependency evidence",
    "contracts/main/CurveStableSwapNG.vy",
    value.target.audited_commit,
    value.target.fixed_commit,
    value.selected_findings[0].id
  ]) {
    assertIncludes(projectDiscovery, needle, "project discovery handoff");
  }
  for (const needle of [
    "Solidity interfaces",
    "public/external ABI",
    "`vm.ffi`",
    "hex-decodes",
    "ABI-encoded `__init__` constructor arguments without a function selector",
    "`bytes.concat(decodedBytecode, abi.encode(...))`",
    "inline `create`",
    "`forge test --ffi`",
    "`ffi = true`",
    "`vm.etch`",
    "does not run constructor"
  ]) {
    assertIncludes(setupFoundry, needle, "setup Foundry handoff");
  }
  for (const needle of [
    "Vyper-aware BaseTest",
    "ABI-visible Solidity interfaces",
    "`vm.ffi` plus inline `create`",
    "hex-decodes initcode",
    "ABI-encoded `__init__` constructor arguments",
    "`bytes.concat(decodedBytecode, abi.encode(...))`",
    "Do not pass undecoded `vm.ffi` stdout directly to `create`",
    "`vm.etch` only"
  ]) {
    assertIncludes(baseTestSetup, needle, "base-test setup handoff");
  }

  assertEqual(provenance.benchmark_id, value.benchmark_id, "provenance benchmark_id");
  assertEqual(provenance.audited_commit, value.target.audited_commit, "provenance audited_commit");
  assertArray(provenance.selected_findings, "provenance selected_findings");
  if (provenance.selected_findings.length !== value.selected_findings.length) {
    fail("provenance selected_findings does not match ground-truth manifest");
  }
}

function smokeConfigToml(targetRepoPath) {
  return `schema_version = "1.0"
dynamic_strategies_enumerator = 1

[project]
repo = ${JSON.stringify(targetRepoPath)}

[run]
output_dir = ".ultrafuzz/runs"
max_parallel_agents = 1
max_parallel_nodes = 1
keep_workspaces = false
workspace_mode = "git-worktree"
default_timeout_seconds = 120

[models]
synthesized_default = true

[models.default]
agent = "CodexAgent"
model = "gpt-5.5"

[agents.CodexAgent]
auth = "api-key"
api_key_env = "OPENAI_API_KEY"

[permissions]
trust_model = "skip-permissions"
prompt_review_required = true
materialize_outputs_as_unstaged = true

[invariants]
property_priority_threshold = "high"
invariant_testing_fuzzer_timeout = "1h"

[triage]
quorum = 1
panel_size = 1
`;
}

function setupOnlyTopologyYaml() {
  return `version: 1
defaults:
  strategy_loops: 1
groups:
  setup:
    label: Setup
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    group: setup
    depends_on:
      - __start__
    required_artifacts:
      - setup/project-discovery.md
    primary_artifact: setup/project-discovery.md
  - id: actors-flows
    kind: agentic
    prompt: setup/actors-flows.md
    group: setup
    depends_on:
      - project-discovery
    required_artifacts:
      - setup/actors-flows.md
    primary_artifact: setup/actors-flows.md
  - id: setup-foundry
    kind: agentic
    prompt: setup/prepare-foundry-harness.md
    group: setup
    depends_on:
      - actors-flows
    required_artifacts:
      - setup/setup-foundry.md
    primary_artifact: setup/setup-foundry.md
  - id: base-test-setup
    kind: agentic
    prompt: setup/discover-base-test.md
    group: setup
    depends_on:
      - setup-foundry
    required_artifacts:
      - setup/base-test-setup.md
    primary_artifact: setup/base-test-setup.md
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - base-test-setup
`;
}

function collectFiles(directory, extension) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath, extension);
    }
    return entry.isFile() && entry.name.endsWith(extension) ? [entryPath] : [];
  });
}

function runGit(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS
    });
  } catch (error) {
    const stderr =
      typeof error.stderr === "string"
        ? error.stderr.trim()
        : Buffer.isBuffer(error.stderr)
          ? error.stderr.toString("utf8").trim()
          : "";
    fail(`git ${args.join(" ")} failed in ${cwd}${stderr ? `: ${stderr}` : ""}`);
  }
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
}

function assertFullSha(value, label) {
  assertString(value, label);
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    fail(`${label} must be a full lowercase 40-character SHA`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    fail(`${label} is missing expected evidence: ${needle}`);
  }
}

function fail(message) {
  throw new Error(`[stableswap-ng-vyper-smoke] ${message}`);
}
