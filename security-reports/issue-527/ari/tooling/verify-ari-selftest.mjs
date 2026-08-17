#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  ASSESSOR_LIMITS,
  PATHS,
  PINS,
  REVIEWED_REMEDIATION_HEADS,
  assertAssessorInputsUnchanged,
  assertCandidateAncestry,
  assertOutputLocations,
  captureAssessorInputs,
  createByteLimitTransform,
  superviseChildProcess
} from "./ari-refresh-common.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const verifierPath = path.join(directory, "verify-ari.mjs");
const schemaPath = path.join(directory, "ari-refresh.schema.json");
const codexWrapperPath = path.join(directory, "run-codex-structured.mjs");
const claudeWrapperPath = path.join(directory, "run-claude-structured.mjs");
const selftestCommit = randomBytes(20).toString("hex");
const finalCommit = PINS.final ?? selftestCommit;
const finalBase = PINS.final_base;
const pins = {
  skill_commit: PINS.skill,
  ari_commit: PINS.ari,
  baseline_commit: PINS.baseline
};
const weights = { Low: 1, Medium: 3, High: 5, Critical: 8 };

const controlsForGap = (gap) => {
  const statuses =
    gap === 0.5
      ? ["Partial"]
      : gap === 0.25
        ? ["Partial", "Partial"]
        : gap === 0.2
          ? ["Applied"]
          : gap === 0.1
            ? ["Applied", "Partial"]
            : gap === 0.04
              ? ["Applied", "Applied"]
              : gap === 0.03
                ? ["Applied", "Applied", "Applied"]
                : [];
  return statuses.map((status, index) => ({
    id: `C${index + 1}`,
    title: `${status} control ${index + 1}`,
    status,
    effectiveness: null,
    effectiveness_rationale: null,
    independence_group: `group-${index + 1}`
  }));
};

const gradeFor = (ari, threats) => {
  const order = ["A", "B", "C", "D", "F"];
  const band = ari <= 10 ? "A" : ari <= 25 ? "B" : ari <= 45 ? "C" : ari <= 70 ? "D" : "F";
  const highGaps = threats.filter((threat) => threat.weight >= 5).map((threat) => threat.gap);
  const caps = [band];
  if (highGaps.some((gap) => gap > 0.1)) caps.push("B");
  if (highGaps.some((gap) => gap >= 0.5)) caps.push("C");
  if (highGaps.filter((gap) => gap >= 0.5).length >= 2) caps.push("D");
  if (highGaps.filter((gap) => gap >= 1).length >= 3) caps.push("F");
  return {
    band,
    cap: caps.slice(1).sort((left, right) => order.indexOf(right) - order.indexOf(left))[0] ?? null,
    grade: caps.sort((left, right) => order.indexOf(right) - order.indexOf(left))[0]
  };
};

const stateFrom = (specifications, label) => {
  const threats = specifications.map(([id, severity, gap]) => ({
    id,
    title: `Pinned title ${id}`,
    severity,
    weight: weights[severity],
    controls: controlsForGap(gap),
    gap,
    residual_mass: weights[severity] * gap
  }));
  const riskMass = threats.reduce((sum, threat) => sum + threat.residual_mass, 0);
  const riskCapacity = threats.reduce((sum, threat) => sum + threat.weight, 0);
  const ari = (100 * riskMass) / riskCapacity;
  const grade = gradeFor(ari, threats);
  return {
    label,
    ari,
    risk_mass: riskMass,
    risk_capacity: riskCapacity,
    band_grade: grade.band,
    grade: grade.grade,
    severity_gate_grade_cap: grade.cap,
    threats
  };
};

const specifications = {
  openai: [
    ["T1", "High", 0.25],
    ["T2", "High", 0.5],
    ["T3", "High", 0.5],
    ["T4", "High", 0.5],
    ["T5", "High", 0.04],
    ["T6", "High", 0.5],
    ["T7", "Medium", 0.04],
    ["T8", "Medium", 0.5],
    ["T9", "High", 0.2],
    ["T10", "High", 0.2],
    ["T11", "Medium", 0.5]
  ],
  anthropic: [
    ["T1", "High", 0.5],
    ["T2", "Medium", 0.03],
    ["T3", "Medium", 0.5],
    ["T4", "Medium", 0.5],
    ["T5", "Medium", 0.03],
    ["T6", "Low", 0.03],
    ["T7", "Medium", 0.5],
    ["T8", "Low", 0.04],
    ["T9", "Low", 0.2],
    ["T10", "High", 0.1]
  ]
};

const buildReport = (lane) => {
  const state = stateFrom(specifications[lane], "old");
  const pivot = structuredClone(state);
  pivot.label = "pivot";
  const final = structuredClone(state);
  final.label = "final";
  const isOpenAi = lane === "openai";
  return {
    lane,
    intended_model: isOpenAi ? "gpt-5.6-sol" : "claude-fable-5",
    actual_model: isOpenAi ? "gpt-5.6-sol" : "claude-fable-5",
    effort: isOpenAi ? "xhigh" : "max",
    degradation: null,
    ...pins,
    final_commit: finalCommit,
    old: state,
    pivot,
    final,
    delta_scope: 0,
    delta_controls: 0,
    accepted_yolo_residuals: [
      "D-01: no OS containment",
      "D-02: no egress allowlist",
      "D-03: no command allowlist or in-run approvals",
      "D-04: no mediated filesystem reads"
    ],
    scope_changes: [],
    verification_notes: ["Self-test fixture"],
    report_markdown: "Self-test report. ".repeat(80)
  };
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const successfulOutcome = (deadlineMs) => ({
  code: 0,
  signal: null,
  spawn_error: null,
  termination_reason: null,
  timed_out: false,
  output_limit_exceeded: false,
  term_sent: false,
  kill_sent: false,
  deadline_ms: deadlineMs,
  term_grace_ms: ASSESSOR_LIMITS.term_grace_ms,
  wall_time_ms: 123
});

const successfulAttemptRuntime = (rawBytes = 256) => ({
  spawn_error: null,
  termination_reason: null,
  timed_out: false,
  output_limit_exceeded: false,
  term_sent: false,
  kill_sent: false,
  deadline_ms: ASSESSOR_LIMITS.claude_attempt_deadline_ms,
  term_grace_ms: ASSESSOR_LIMITS.term_grace_ms,
  wall_time_ms: 123,
  stdout_max_bytes: ASSESSOR_LIMITS.claude_stdout_max_bytes,
  stdout_observed_bytes: rawBytes,
  stdout_captured_bytes: rawBytes,
  stdout_limit_exceeded: false,
  stdout_stream_error: null,
  raw_bytes: rawBytes
});

const buildMetadata = (report, reportBytes) => {
  const schemaHash = sha256(readFileSync(schemaPath));
  const promptHash = "a".repeat(64);
  const assessorInputs = {
    prompt_sha256: promptHash,
    schema_sha256: schemaHash,
    remediation_manifest_sha256: PINS.remediation_manifest_sha256,
    orchestration: {
      root: directory,
      files: {},
      manifest_sha256: "b".repeat(64)
    }
  };
  const repositories = {
    final: { path: "/selftest/final", commit: finalCommit, clean: true },
    baseline: { path: PATHS.baseline, commit: PINS.baseline, clean: true },
    skill: { path: PATHS.skill, commit: PINS.skill, clean: true },
    ari: { path: PATHS.ari, commit: PINS.ari, clean: true },
    reports: { path: PATHS.reports, commit: PINS.reports, clean: true }
  };
  const common = {
    status: "succeeded",
    error: null,
    lane: report.lane,
    intended_model: report.intended_model,
    actual_model: report.actual_model,
    effort: report.effort,
    degradation: report.degradation,
    cli_version: "selftest",
    limits: { ...ASSESSOR_LIMITS },
    structured_output: {
      max_bytes: ASSESSOR_LIMITS.structured_output_max_bytes,
      bytes: reportBytes.length,
      limit_exceeded: false
    },
    ...pins,
    reports_commit: PINS.reports,
    final_commit: finalCommit,
    final_base: finalBase,
    reviewed_remediation_heads: REVIEWED_REMEDIATION_HEADS,
    repositories_before: repositories,
    repositories_after: structuredClone(repositories),
    assessor_inputs_before: assessorInputs,
    assessor_inputs_after: structuredClone(assessorInputs),
    prompt_sha256: promptHash,
    schema_sha256: schemaHash,
    remediation_manifest_sha256: assessorInputs.remediation_manifest_sha256,
    output_sha256: sha256(reportBytes)
  };
  if (report.lane === "openai") {
    const eventBytes = 512;
    return {
      ...common,
      commanded_model: "gpt-5.6-sol",
      execution: successfulOutcome(ASSESSOR_LIMITS.codex_deadline_ms),
      event_stream: {
        max_bytes: ASSESSOR_LIMITS.codex_event_max_bytes,
        observed_bytes: eventBytes,
        captured_bytes: eventBytes,
        limit_exceeded: false,
        stream_error: null,
        file_bytes: eventBytes
      },
      events_sha256: "e".repeat(64),
      event_bytes: eventBytes
    };
  }
  const fallbackUsed = report.actual_model === "claude-opus-4-8";
  const selectedUsage = fallbackUsed
    ? { "claude-opus-4-8": { input_tokens: 1 } }
    : { "claude-fable-5": { input_tokens: 1 } };
  const attempts = fallbackUsed
    ? [
        {
          label: "primary",
          commanded_model: "claude-fable-5",
          automatic_fallback_model: "claude-opus-4-8",
          ...successfulAttemptRuntime(),
          exit_code: 0,
          signal: null,
          json_envelope_parsed: true,
          json_envelope_object: true,
          envelope_parse_error: null,
          retry_reason: "primary_missing_structured_output",
          used_models: ["claude-fable-5"],
          model_usage: { "claude-fable-5": { input_tokens: 1 } },
          structured_output_present: false,
          raw_sha256: "c".repeat(64)
        },
        {
          label: "explicit_fallback",
          commanded_model: "claude-opus-4-8",
          automatic_fallback_model: null,
          ...successfulAttemptRuntime(),
          exit_code: 0,
          signal: null,
          json_envelope_parsed: true,
          json_envelope_object: true,
          envelope_parse_error: null,
          retry_reason: null,
          used_models: ["claude-opus-4-8"],
          model_usage: selectedUsage,
          structured_output_present: true,
          raw_sha256: "d".repeat(64)
        }
      ]
    : [
        {
          label: "primary",
          commanded_model: "claude-fable-5",
          automatic_fallback_model: "claude-opus-4-8",
          ...successfulAttemptRuntime(),
          exit_code: 0,
          signal: null,
          json_envelope_parsed: true,
          json_envelope_object: true,
          envelope_parse_error: null,
          retry_reason: null,
          used_models: ["claude-fable-5"],
          model_usage: selectedUsage,
          structured_output_present: true,
          raw_sha256: "c".repeat(64)
        }
      ];
  return {
    ...common,
    primary_model: "claude-fable-5",
    fallback_model: "claude-opus-4-8",
    auxiliary_model_environment_policy: {
      ANTHROPIC_SMALL_FAST_MODEL: "commanded_model",
      CLAUDE_CODE_AUTO_MODE_MODEL: "commanded_model",
      CLAUDE_CODE_BG_CLASSIFIER_MODEL: "commanded_model",
      CLAUDE_CONTEXT_COLLAPSE_MODEL: "commanded_model"
    },
    used_models: fallbackUsed ? ["claude-opus-4-8"] : ["claude-fable-5"],
    fallback_used: fallbackUsed,
    explicit_retry: fallbackUsed,
    selected_attempt: fallbackUsed ? "explicit_fallback" : "primary",
    model_usage: selectedUsage,
    attempts,
    raw_sha256: fallbackUsed ? "d".repeat(64) : "c".repeat(64),
    primary_raw_sha256: "c".repeat(64),
    fallback_raw_sha256: fallbackUsed ? "d".repeat(64) : null
  };
};

const temporaryDirectory = path.join(PATHS.outputRoot, selftestCommit);
const reportPath = path.join(temporaryDirectory, "report.json");
const metadataPath = path.join(temporaryDirectory, "report.meta.json");
const copiedSchemaPath = path.join(temporaryDirectory, "copied-schema.json");
const outputGuardCommit = selftestCommit;
const outputGuardDirectory = temporaryDirectory;

const writeFixture = (report) => {
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(reportPath, reportBytes, { mode: 0o600 });
  writeFileSync(metadataPath, `${JSON.stringify(buildMetadata(report, reportBytes), null, 2)}\n`, {
    mode: 0o600
  });
};

const runVerifier = (expectedStatus, expectedMessage = null, verifierSchemaPath = schemaPath) => {
  const result = spawnSync(
    process.execPath,
    [verifierPath, reportPath, metadataPath, finalCommit, finalBase, verifierSchemaPath],
    { encoding: "utf8" }
  );
  if (result.status !== expectedStatus) {
    throw new Error(
      `verifier exited ${result.status}, expected ${expectedStatus}\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  if (expectedMessage && !result.stderr.includes(expectedMessage)) {
    throw new Error(`verifier error did not include ${expectedMessage}:\n${result.stderr}`);
  }
};

const runSchemaValidator = (expectedStatus) => {
  const source = [
    "import json,sys",
    "from jsonschema import Draft202012Validator",
    "schema=json.load(open(sys.argv[1], encoding='utf-8'))",
    "instance=json.load(open(sys.argv[2], encoding='utf-8'))",
    "Draft202012Validator.check_schema(schema)",
    "errors=list(Draft202012Validator(schema).iter_errors(instance))",
    "raise SystemExit(1 if errors else 0)"
  ].join(";");
  const result = spawnSync("python3", ["-c", source, schemaPath, reportPath], { encoding: "utf8" });
  if (result.status !== expectedStatus) {
    throw new Error(`schema validator exited ${result.status}, expected ${expectedStatus}`);
  }
};

const testByteLimitTransform = async () => {
  let limitCallbacks = 0;
  const captured = [];
  const limiter = createByteLimitTransform(8, () => {
    limitCallbacks += 1;
  });
  await pipeline(
    Readable.from([Buffer.alloc(5, 0x61), Buffer.alloc(7, 0x62), Buffer.alloc(3, 0x63)]),
    limiter.stream,
    new Writable({
      write(chunk, _encoding, callback) {
        captured.push(Buffer.from(chunk));
        callback();
      }
    })
  );
  const stats = limiter.stats();
  if (
    stats.max_bytes !== 8 ||
    stats.observed_bytes !== 15 ||
    stats.captured_bytes !== 8 ||
    stats.limit_exceeded !== true ||
    Buffer.concat(captured).length !== 8 ||
    limitCallbacks !== 1
  ) {
    throw new Error(`byte-limit transform self-test failed: ${JSON.stringify({ stats, limitCallbacks })}`);
  }
};

const runDeadlineChild = async (source, deadlineMs, termGraceMs) => {
  const child = spawn(process.execPath, ["-e", source], {
    stdio: "ignore",
    detached: true
  });
  return superviseChildProcess(child, { deadlineMs, termGraceMs }).completion;
};

const testProcessSupervision = async () => {
  const termOutcome = await runDeadlineChild(
    "process.on('SIGTERM', () => process.exit(42)); setInterval(() => {}, 1000);",
    750,
    250
  );
  if (
    termOutcome.termination_reason !== "deadline" ||
    termOutcome.timed_out !== true ||
    termOutcome.term_sent !== true ||
    termOutcome.kill_sent !== false ||
    termOutcome.code !== 42 ||
    termOutcome.signal !== null
  ) {
    throw new Error(`TERM deadline self-test failed: ${JSON.stringify(termOutcome)}`);
  }

  const descendantOutcome = await runDeadlineChild(
    [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
      "process.on('SIGTERM', () => process.exit(43));",
      "setInterval(() => {}, 1000);"
    ].join(" "),
    750,
    150
  );
  if (
    descendantOutcome.termination_reason !== "deadline" ||
    descendantOutcome.timed_out !== true ||
    descendantOutcome.term_sent !== true ||
    descendantOutcome.kill_sent !== true ||
    descendantOutcome.code !== 43 ||
    descendantOutcome.signal !== null
  ) {
    throw new Error(`descendant cleanup self-test failed: ${JSON.stringify(descendantOutcome)}`);
  }

  const killOutcome = await runDeadlineChild("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", 500, 150);
  if (
    killOutcome.termination_reason !== "deadline" ||
    killOutcome.timed_out !== true ||
    killOutcome.term_sent !== true ||
    killOutcome.kill_sent !== true ||
    killOutcome.code !== null ||
    killOutcome.signal !== "SIGKILL"
  ) {
    throw new Error(`SIGKILL grace-period self-test failed: ${JSON.stringify(killOutcome)}`);
  }
};

let selftestDirectoryCreated = false;
try {
  await testByteLimitTransform();
  await testProcessSupervision();

  if (PINS.final === null) {
    let unfrozenFinalRejected = false;
    try {
      assertCandidateAncestry("/selftest/nonexistent-final", finalCommit, finalBase);
    } catch (error) {
      unfrozenFinalRejected = error instanceof Error && error.message.includes("final aggregate commit is not frozen");
    }
    if (!unfrozenFinalRejected) throw new Error("unfrozen aggregate final did not fail closed");
  }

  const codexWrapper = readFileSync(codexWrapperPath, "utf8");
  const claudeWrapper = readFileSync(claudeWrapperPath, "utf8");
  if (!codexWrapper.includes('"--dangerously-bypass-approvals-and-sandbox"')) {
    throw new Error("Codex wrapper lost the required YOLO flag");
  }
  if (!/finally\s*\{[\s\S]*assertPostflightIntegrity/.test(codexWrapper)) {
    throw new Error("Codex wrapper no longer guarantees postflight integrity from finally");
  }
  if (!codexWrapper.includes("detached: true") || !codexWrapper.includes("codex_event_limit")) {
    throw new Error("Codex wrapper lost detached supervision or its event-stream limit");
  }
  if (!claudeWrapper.includes('"--dangerously-skip-permissions"')) {
    throw new Error("Claude wrapper lost the required YOLO flag");
  }
  if (!claudeWrapper.includes("detached: true") || !claudeWrapper.includes("claude_stdout_limit")) {
    throw new Error("Claude wrapper lost detached supervision or its stdout limit");
  }
  if ((claudeWrapper.match(/await runClaude\(\{/g) ?? []).length !== 2) {
    throw new Error("Claude wrapper must contain exactly the primary and explicit fallback invocations");
  }
  for (const requiredPolicy of [
    "primary_timeout",
    "primary_stdout_limit",
    "primary_nonzero_exit",
    "primary_missing_structured_output",
    "primary_invalid_json_envelope",
    "automaticFallbackModel: null",
    "no further fallback is permitted"
  ]) {
    if (!claudeWrapper.includes(requiredPolicy)) {
      throw new Error(`Claude wrapper is missing retry policy marker: ${requiredPolicy}`);
    }
  }

  mkdirSync(outputGuardDirectory, { mode: 0o700 });
  selftestDirectoryCreated = true;
  const guardPromptPath = path.join(outputGuardDirectory, "prompt.md");
  const guardOutputPath = path.join(outputGuardDirectory, "report.json");
  writeFileSync(guardPromptPath, "Guard self-test prompt\n", { mode: 0o600 });
  assertOutputLocations(guardPromptPath, [guardOutputPath], outputGuardCommit);
  let outsideOutputRejected = false;
  try {
    assertOutputLocations(guardPromptPath, [path.join(PATHS.outputRoot, "outside.json")], outputGuardCommit);
  } catch {
    outsideOutputRejected = true;
  }
  if (!outsideOutputRejected) throw new Error("output confinement self-test did not reject an outside output");

  const inputSnapshot = captureAssessorInputs(guardPromptPath, schemaPath);
  assertAssessorInputsUnchanged(inputSnapshot, guardPromptPath, schemaPath);
  writeFileSync(guardPromptPath, "Mutated guard self-test prompt\n");
  let mutationRejected = false;
  try {
    assertAssessorInputsUnchanged(inputSnapshot, guardPromptPath, schemaPath);
  } catch {
    mutationRejected = true;
  }
  if (!mutationRejected) throw new Error("assessor input integrity self-test did not reject a mutation");

  for (const lane of ["openai", "anthropic"]) {
    writeFixture(buildReport(lane));
    runSchemaValidator(0);
    runVerifier(0);
  }

  const validExplicitFallback = buildReport("anthropic");
  validExplicitFallback.actual_model = "claude-opus-4-8";
  validExplicitFallback.degradation = "claude-fable-5 refused; explicitly retried with claude-opus-4-8";
  writeFixture(validExplicitFallback);
  runSchemaValidator(0);
  runVerifier(0);

  const validAutomaticFallback = buildReport("anthropic");
  validAutomaticFallback.actual_model = "claude-opus-4-8";
  validAutomaticFallback.degradation = "claude-fable-5 overloaded; claude-opus-4-8 served the primary invocation";
  writeFixture(validAutomaticFallback);
  const automaticFallbackMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  automaticFallbackMetadata.explicit_retry = false;
  automaticFallbackMetadata.selected_attempt = "primary";
  automaticFallbackMetadata.attempts = [
    {
      ...automaticFallbackMetadata.attempts[1],
      label: "primary",
      commanded_model: "claude-fable-5",
      automatic_fallback_model: "claude-opus-4-8"
    }
  ];
  automaticFallbackMetadata.primary_raw_sha256 = "d".repeat(64);
  automaticFallbackMetadata.fallback_raw_sha256 = null;
  automaticFallbackMetadata.raw_sha256 = "d".repeat(64);
  writeFileSync(metadataPath, `${JSON.stringify(automaticFallbackMetadata, null, 2)}\n`);
  runVerifier(0);

  const nonzeroPrimaryFallback = buildReport("anthropic");
  nonzeroPrimaryFallback.actual_model = "claude-opus-4-8";
  nonzeroPrimaryFallback.degradation = "claude-fable-5 exited; explicitly retried with claude-opus-4-8";
  writeFixture(nonzeroPrimaryFallback);
  const nonzeroMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  Object.assign(nonzeroMetadata.attempts[0], {
    exit_code: 1,
    signal: null,
    json_envelope_parsed: false,
    json_envelope_object: false,
    envelope_parse_error: "empty stdout",
    retry_reason: "primary_nonzero_exit",
    used_models: [],
    model_usage: {}
  });
  writeFileSync(metadataPath, `${JSON.stringify(nonzeroMetadata, null, 2)}\n`);
  runVerifier(0);

  writeFixture(validExplicitFallback);
  const primaryTimeoutMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  Object.assign(primaryTimeoutMetadata.attempts[0], {
    exit_code: null,
    signal: "SIGTERM",
    termination_reason: "deadline",
    timed_out: true,
    output_limit_exceeded: false,
    term_sent: true,
    kill_sent: false,
    wall_time_ms: ASSESSOR_LIMITS.claude_attempt_deadline_ms + 1,
    stdout_observed_bytes: 0,
    stdout_captured_bytes: 0,
    stdout_limit_exceeded: false,
    raw_bytes: 0,
    json_envelope_parsed: false,
    json_envelope_object: false,
    envelope_parse_error: "terminated at deadline",
    retry_reason: "primary_timeout",
    used_models: [],
    model_usage: {},
    structured_output_present: false
  });
  writeFileSync(metadataPath, `${JSON.stringify(primaryTimeoutMetadata, null, 2)}\n`);
  runVerifier(0);

  writeFixture(validExplicitFallback);
  const primaryCapMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  Object.assign(primaryCapMetadata.attempts[0], {
    exit_code: null,
    signal: "SIGTERM",
    termination_reason: "claude_stdout_limit",
    timed_out: false,
    output_limit_exceeded: true,
    term_sent: true,
    kill_sent: false,
    stdout_observed_bytes: ASSESSOR_LIMITS.claude_stdout_max_bytes + 1,
    stdout_captured_bytes: ASSESSOR_LIMITS.claude_stdout_max_bytes,
    stdout_limit_exceeded: true,
    raw_bytes: ASSESSOR_LIMITS.claude_stdout_max_bytes,
    json_envelope_parsed: false,
    json_envelope_object: false,
    envelope_parse_error: "stdout truncated at cap",
    retry_reason: "primary_stdout_limit",
    used_models: [],
    model_usage: {},
    structured_output_present: false
  });
  writeFileSync(metadataPath, `${JSON.stringify(primaryCapMetadata, null, 2)}\n`);
  runVerifier(0);

  writeFixture(validExplicitFallback);
  const fallbackTimeoutMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  Object.assign(fallbackTimeoutMetadata.attempts[1], {
    exit_code: null,
    signal: "SIGKILL",
    termination_reason: "deadline",
    timed_out: true,
    output_limit_exceeded: false,
    term_sent: true,
    kill_sent: true,
    wall_time_ms: ASSESSOR_LIMITS.claude_attempt_deadline_ms + ASSESSOR_LIMITS.term_grace_ms
  });
  writeFileSync(metadataPath, `${JSON.stringify(fallbackTimeoutMetadata, null, 2)}\n`);
  runVerifier(1, "metadata explicit fallback timed_out");

  writeFixture(validExplicitFallback);
  const excessiveFallbackMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  excessiveFallbackMetadata.attempts.push(structuredClone(excessiveFallbackMetadata.attempts[1]));
  writeFileSync(metadataPath, `${JSON.stringify(excessiveFallbackMetadata, null, 2)}\n`);
  runVerifier(1, "at most one explicit fallback");

  writeFixture(buildReport("openai"));
  const incorrectLimitsMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  incorrectLimitsMetadata.limits.codex_deadline_ms -= 1;
  writeFileSync(metadataPath, `${JSON.stringify(incorrectLimitsMetadata, null, 2)}\n`);
  runVerifier(1, "metadata.limits.codex_deadline_ms");

  const quantizationFailure = buildReport("openai");
  quantizationFailure.old.threats[0].controls[0].effectiveness = 0.73;
  quantizationFailure.old.threats[0].controls[0].effectiveness_rationale = "Invalid self-test value";
  writeFixture(quantizationFailure);
  runSchemaValidator(1);
  runVerifier(1, "multiple of 0.05");

  const schemaOnlyFailure = buildReport("openai");
  schemaOnlyFailure.unexpected = true;
  writeFixture(schemaOnlyFailure);
  runVerifier(1, "schema $");

  const malformedShapeFailure = buildReport("openai");
  malformedShapeFailure.old.threats = null;
  writeFixture(malformedShapeFailure);
  runVerifier(1, "schema $.old.threats");

  const laneConditionFailure = buildReport("openai");
  laneConditionFailure.intended_model = "claude-fable-5";
  writeFixture(laneConditionFailure);
  runSchemaValidator(1);

  const customRationaleFailure = buildReport("openai");
  customRationaleFailure.old.threats[0].controls[0].effectiveness = 0.75;
  writeFixture(customRationaleFailure);
  runSchemaValidator(1);

  const notAppliedFailure = buildReport("openai");
  notAppliedFailure.old.threats[0].controls[0].status = "Not Applied";
  notAppliedFailure.old.threats[0].controls[0].effectiveness = 0.5;
  writeFixture(notAppliedFailure);
  runSchemaValidator(1);

  const duplicateFailure = buildReport("openai");
  duplicateFailure.old.threats[1].id = "T1";
  writeFixture(duplicateFailure);
  runVerifier(1, "duplicate threat IDs");

  const titleFailure = buildReport("openai");
  titleFailure.final.threats[0].title = "Changed title";
  writeFixture(titleFailure);
  runVerifier(1, "titles");

  const residualFailure = buildReport("openai");
  residualFailure.accepted_yolo_residuals.pop();
  writeFixture(residualFailure);
  runVerifier(1, "exactly D-01");

  const labelFailure = buildReport("openai");
  labelFailure.old.label = "baseline";
  writeFixture(labelFailure);
  runVerifier(1, "old.label");

  const schemaHashFailure = buildReport("openai");
  writeFixture(schemaHashFailure);
  const mismatchedMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  mismatchedMetadata.schema_sha256 = "0".repeat(64);
  writeFileSync(metadataPath, `${JSON.stringify(mismatchedMetadata, null, 2)}\n`);
  runVerifier(1, "metadata.schema_sha256");

  writeFixture(buildReport("openai"));
  writeFileSync(metadataPath, "null\n");
  runVerifier(1, "metadata must be a JSON object");

  writeFixture(buildReport("openai"));
  writeFileSync(copiedSchemaPath, readFileSync(schemaPath));
  runVerifier(1, "schema must be the bundled", copiedSchemaPath);

  console.log("ari-refresh-selftest-ok");
} finally {
  if (selftestDirectoryCreated) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
