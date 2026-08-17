#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ASSESSOR_LIMITS,
  PATHS,
  PINS,
  REVIEWED_REMEDIATION_HEADS,
  assertBundledSchema
} from "./ari-refresh-common.mjs";

const [inputPath, metadataPath, expectedFinalCommit, expectedFinalBase, schemaPath] = process.argv.slice(2);
if (!inputPath || !metadataPath || !expectedFinalCommit || !expectedFinalBase || !schemaPath) {
  console.error(
    "usage: node verify-ari.mjs <ari-refresh.json> <metadata.json> <expected-final-commit> <expected-final-base> <schema.json>"
  );
  process.exit(2);
}

const reportBytes = readFileSync(inputPath);
const metadataBytes = readFileSync(metadataPath);
const errors = [];
let schemaBytes = Buffer.alloc(0);
let report = null;
let metadata = null;
try {
  report = JSON.parse(reportBytes.toString("utf8"));
} catch (error) {
  errors.push(`report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
try {
  metadata = JSON.parse(metadataBytes.toString("utf8"));
} catch (error) {
  errors.push(`metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

let bundledSchema = false;
try {
  const bundledSchemaPath = assertBundledSchema(schemaPath);
  schemaBytes = readFileSync(bundledSchemaPath);
  bundledSchema = true;
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}

if (bundledSchema) {
  const schemaValidatorSource = String.raw`
import json
import sys
from jsonschema import Draft202012Validator

schema_bytes, separator, report_bytes = sys.stdin.buffer.read().partition(b"\0")
if not separator:
    raise ValueError("missing schema/report separator")
schema = json.loads(schema_bytes.decode("utf-8"))
report = json.loads(report_bytes.decode("utf-8"))
Draft202012Validator.check_schema(schema)
validation_errors = sorted(
    Draft202012Validator(schema).iter_errors(report),
    key=lambda error: [str(part) for part in error.absolute_path],
)
for validation_error in validation_errors:
    path = "$" + "".join(
        f"[{part}]" if isinstance(part, int) else f".{part}"
        for part in validation_error.absolute_path
    )
    print(f"{path}: {validation_error.message}")
raise SystemExit(1 if validation_errors else 0)
`;
  const schemaValidation = spawnSync("python3", ["-c", schemaValidatorSource], {
    input: Buffer.concat([schemaBytes, Buffer.from([0]), reportBytes]),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (schemaValidation.error) {
    errors.push(`schema validation failed to run: ${schemaValidation.error.message}`);
  } else if (schemaValidation.status !== 0) {
    const validationErrors = schemaValidation.stdout.trim();
    if (validationErrors) {
      for (const validationError of validationErrors.split("\n")) {
        errors.push(`schema ${validationError}`);
      }
    } else {
      const failure = schemaValidation.stderr.trim() || `python3 exited ${schemaValidation.status}`;
      errors.push(`schema validation failed: ${failure}`);
    }
  }
}

const grades = ["A", "B", "C", "D", "F"];
const weights = { Low: 1, Medium: 3, High: 5, Critical: 8 };
const defaultEffectiveness = { Applied: 0.8, Partial: 0.5 };
const pins = {
  skill_commit: PINS.skill,
  ari_commit: PINS.ari,
  baseline_commit: PINS.baseline
};
const laneProvenance = {
  openai: {
    intendedModel: "gpt-5.6-sol",
    allowedActualModels: ["gpt-5.6-sol"],
    effort: "xhigh",
    oldIds: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11"],
    oldSeverities: ["High", "High", "High", "High", "High", "High", "Medium", "Medium", "High", "High", "Medium"]
  },
  anthropic: {
    intendedModel: "claude-fable-5",
    allowedActualModels: ["claude-fable-5", "claude-opus-4-8"],
    effort: "max",
    oldIds: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"],
    oldSeverities: ["High", "Medium", "Medium", "Medium", "Medium", "Low", "Medium", "Low", "Low", "High"]
  }
};

const close = (actual, expected, tolerance, label) => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    errors.push(`${label}: reported ${actual}, recalculated ${expected}`);
  }
};

const equal = (actual, expected, label) => {
  if (actual !== expected) errors.push(`${label}: reported ${actual}, expected ${expected}`);
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const validateConfiguredLimits = () => {
  if (!isObject(metadata.limits)) {
    errors.push("metadata.limits must be an object");
    return;
  }
  const expectedKeys = Object.keys(ASSESSOR_LIMITS).sort();
  const actualKeys = Object.keys(metadata.limits).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    errors.push("metadata.limits must contain exactly the centrally configured assessor limits");
  }
  for (const [limit, expected] of Object.entries(ASSESSOR_LIMITS)) {
    equal(metadata.limits[limit], expected, `metadata.limits.${limit}`);
  }
};

const validateChildOutcome = (outcome, label, expectedDeadlineMs) => {
  if (!isObject(outcome)) {
    errors.push(`${label} must be an object`);
    return;
  }
  equal(outcome.deadline_ms, expectedDeadlineMs, `${label}.deadline_ms`);
  equal(outcome.term_grace_ms, ASSESSOR_LIMITS.term_grace_ms, `${label}.term_grace_ms`);
  if (!Number.isInteger(outcome.wall_time_ms) || outcome.wall_time_ms < 0) {
    errors.push(`${label}.wall_time_ms must be a nonnegative integer`);
  }
  for (const flag of ["timed_out", "output_limit_exceeded", "term_sent", "kill_sent"]) {
    if (typeof outcome[flag] !== "boolean") errors.push(`${label}.${flag} must be boolean`);
  }
  if (outcome.spawn_error !== null && (typeof outcome.spawn_error !== "string" || outcome.spawn_error === "")) {
    errors.push(`${label}.spawn_error must be null or a nonempty string`);
  }
  if (
    outcome.termination_reason !== null &&
    (typeof outcome.termination_reason !== "string" || outcome.termination_reason === "")
  ) {
    errors.push(`${label}.termination_reason must be null or a nonempty string`);
  }
  equal(outcome.timed_out, outcome.termination_reason === "deadline", `${label}.timed_out provenance`);
  equal(
    outcome.output_limit_exceeded,
    typeof outcome.termination_reason === "string" && outcome.termination_reason.endsWith("_limit"),
    `${label}.output_limit_exceeded provenance`
  );
  if (outcome.termination_reason === null && (outcome.term_sent === true || outcome.kill_sent === true)) {
    errors.push(`${label}: signals were sent without a termination reason`);
  }

  const naturalExit = Number.isInteger(outcome.code) && outcome.code >= 0 && outcome.signal === null;
  const signalExit = outcome.code === null && typeof outcome.signal === "string" && outcome.signal !== "";
  const spawnFailureExit =
    outcome.spawn_error !== null &&
    (outcome.code === null || Number.isInteger(outcome.code)) &&
    (outcome.signal === null || typeof outcome.signal === "string");
  if (!naturalExit && !signalExit && !spawnFailureExit) {
    errors.push(`${label}: invalid code/signal/spawn_error provenance`);
  }
};

const requireSuccessfulOutcome = (outcome, label) => {
  equal(outcome?.code, 0, `${label}.code`);
  equal(outcome?.signal, null, `${label}.signal`);
  equal(outcome?.spawn_error, null, `${label}.spawn_error`);
  equal(outcome?.termination_reason, null, `${label}.termination_reason`);
  equal(outcome?.timed_out, false, `${label}.timed_out`);
  equal(outcome?.output_limit_exceeded, false, `${label}.output_limit_exceeded`);
  equal(outcome?.term_sent, false, `${label}.term_sent`);
  equal(outcome?.kill_sent, false, `${label}.kill_sent`);
};

const validateCaptureStats = (
  { maxBytes, observedBytes, capturedBytes, limitExceeded, fileBytes: capturedFileBytes },
  expectedMaxBytes,
  label
) => {
  equal(maxBytes, expectedMaxBytes, `${label}.max_bytes`);
  for (const [field, value] of [
    ["observed_bytes", observedBytes],
    ["captured_bytes", capturedBytes],
    ["file_bytes", capturedFileBytes]
  ]) {
    if (!Number.isInteger(value) || value < 0) errors.push(`${label}.${field} must be a nonnegative integer`);
  }
  if (Number.isInteger(observedBytes) && Number.isInteger(capturedBytes) && observedBytes < capturedBytes) {
    errors.push(`${label}.observed_bytes must be at least captured_bytes`);
  }
  if (Number.isInteger(capturedBytes) && capturedBytes > expectedMaxBytes) {
    errors.push(`${label}.captured_bytes exceeds the configured cap`);
  }
  if (Number.isInteger(capturedBytes) && Number.isInteger(capturedFileBytes)) {
    equal(capturedFileBytes, capturedBytes, `${label}.file_bytes`);
  }
  if (typeof limitExceeded !== "boolean") {
    errors.push(`${label}.limit_exceeded must be boolean`);
  } else if (Number.isInteger(observedBytes)) {
    equal(limitExceeded, observedBytes > expectedMaxBytes, `${label}.limit_exceeded provenance`);
  }
};

const validateStructuredOutput = () => {
  const output = metadata.structured_output;
  if (!isObject(output)) {
    errors.push("metadata.structured_output must be an object");
    return;
  }
  equal(output.max_bytes, ASSESSOR_LIMITS.structured_output_max_bytes, "metadata.structured_output.max_bytes");
  equal(output.bytes, reportBytes.length, "metadata.structured_output.bytes");
  equal(output.limit_exceeded, false, "metadata.structured_output.limit_exceeded");
  if (reportBytes.length > ASSESSOR_LIMITS.structured_output_max_bytes) {
    errors.push("report exceeds the configured structured-output byte limit");
  }
};

const band = (ari) => (ari <= 10 ? "A" : ari <= 25 ? "B" : ari <= 45 ? "C" : ari <= 70 ? "D" : "F");

const worse = (...values) =>
  values.filter(Boolean).sort((left, right) => grades.indexOf(right) - grades.indexOf(left))[0];

const duplicateValues = (values) => {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
};

const calculateState = (state, stateName) => {
  let riskMass = 0;
  let riskCapacity = 0;
  const highGaps = [];
  const duplicateThreatIds = duplicateValues(state.threats.map((threat) => threat.id));
  if (duplicateThreatIds.length > 0) {
    errors.push(`${stateName}: duplicate threat IDs ${duplicateThreatIds.join(", ")}`);
  }

  for (const threat of state.threats) {
    const prefix = `${stateName}.${threat.id}`;
    const expectedWeight = weights[threat.severity];
    if (threat.weight !== expectedWeight) {
      errors.push(`${prefix}.weight: reported ${threat.weight}, expected ${expectedWeight}`);
    }

    const duplicateControlIds = duplicateValues(threat.controls.map((control) => control.id));
    if (duplicateControlIds.length > 0) {
      errors.push(`${prefix}: duplicate control IDs ${duplicateControlIds.join(", ")}`);
    }

    const presentGroups = new Set();
    let eliminated = false;
    let leakage = 1;

    for (const control of threat.controls) {
      const controlPrefix = `${prefix}.${control.id}`;
      if (control.status === "Not Applied") {
        if (control.effectiveness !== null) {
          errors.push(`${controlPrefix}: Not Applied controls must have null effectiveness`);
        }
        if (control.effectiveness_rationale !== null) {
          errors.push(`${controlPrefix}: Not Applied controls must have null effectiveness_rationale`);
        }
        if (control.independence_group !== null) {
          errors.push(`${controlPrefix}: Not Applied controls must have null independence_group`);
        }
        continue;
      }

      if (control.independence_group === null) {
        errors.push(`${controlPrefix}: present controls require an independence_group`);
      } else if (presentGroups.has(control.independence_group)) {
        errors.push(`${controlPrefix}: duplicate present independence_group ${control.independence_group}`);
      } else {
        presentGroups.add(control.independence_group);
      }

      if (control.status === "Eliminated") {
        eliminated = true;
        if (control.effectiveness !== null) {
          errors.push(`${controlPrefix}: Eliminated effectiveness must be null`);
        }
        if (control.effectiveness_rationale !== null) {
          errors.push(`${controlPrefix}: Eliminated controls must have null effectiveness_rationale`);
        }
        continue;
      }

      const fallback = defaultEffectiveness[control.status];
      const effectiveness = control.effectiveness ?? fallback;
      if (fallback === undefined || !Number.isFinite(effectiveness) || effectiveness < 0 || effectiveness >= 1) {
        errors.push(`${controlPrefix}: invalid effectiveness/status combination`);
        continue;
      }
      if (control.effectiveness !== null) {
        if (!control.effectiveness_rationale) {
          errors.push(`${controlPrefix}: custom effectiveness requires a rationale`);
        }
        const fivePercentUnits = control.effectiveness * 20;
        if (Math.abs(fivePercentUnits - Math.round(fivePercentUnits)) > 1e-9) {
          errors.push(`${controlPrefix}: custom effectiveness must be a multiple of 0.05`);
        }
      } else if (control.effectiveness_rationale !== null) {
        errors.push(`${controlPrefix}: default effectiveness requires a null effectiveness_rationale`);
      }
      leakage *= 1 - effectiveness;
    }

    const gap = eliminated ? 0 : Math.max(0.03, leakage);
    const residualMass = expectedWeight * gap;
    close(threat.gap, gap, 0.000001, `${prefix}.gap`);
    close(threat.residual_mass, residualMass, 0.000001, `${prefix}.residual_mass`);
    riskMass += residualMass;
    riskCapacity += expectedWeight;
    if (expectedWeight >= 5) highGaps.push(gap);
  }

  const ari = riskCapacity === 0 ? 0 : (100 * riskMass) / riskCapacity;
  const expectedBand = band(ari);
  let cap = null;
  if (highGaps.some((gap) => gap > 0.1)) cap = worse(cap, "B");
  if (highGaps.some((gap) => gap >= 0.5)) cap = worse(cap, "C");
  if (highGaps.filter((gap) => gap >= 0.5).length >= 2) cap = worse(cap, "D");
  if (highGaps.filter((gap) => gap >= 1).length >= 3) cap = worse(cap, "F");
  const expectedGrade = worse(expectedBand, cap);

  close(state.risk_mass, riskMass, 0.000001, `${stateName}.risk_mass`);
  close(state.risk_capacity, riskCapacity, 0, `${stateName}.risk_capacity`);
  close(state.ari, ari, 0.000001, `${stateName}.ari`);
  equal(state.band_grade, expectedBand, `${stateName}.band_grade`);
  equal(state.severity_gate_grade_cap, cap, `${stateName}.severity_gate_grade_cap`);
  equal(state.grade, expectedGrade, `${stateName}.grade`);

  return { ari, riskMass, riskCapacity, band: expectedBand, cap, grade: expectedGrade };
};

const validateSemantics = () => {
  const expectedLane = laneProvenance[report.lane];
  if (!expectedLane) {
    errors.push(`unsupported lane ${report.lane}`);
  } else {
    equal(report.intended_model, expectedLane.intendedModel, "intended_model");
    equal(report.effort, expectedLane.effort, "effort");
    if (!expectedLane.allowedActualModels.includes(report.actual_model)) {
      errors.push(`actual_model: unapproved ${report.actual_model}`);
    }
  }

  for (const [field, expected] of Object.entries(pins)) equal(report[field], expected, field);
  if (!/^[a-f0-9]{40}$/.test(expectedFinalCommit)) {
    errors.push(`expected final commit is not a full lowercase commit: ${expectedFinalCommit}`);
  }
  if (PINS.final !== null) equal(expectedFinalCommit, PINS.final, "expected final aggregate pin");
  if (!/^[a-f0-9]{40}$/.test(expectedFinalBase)) {
    errors.push(`expected final base is not a full lowercase commit: ${expectedFinalBase}`);
  }
  equal(expectedFinalBase, PINS.final_base, "expected final base pin");
  equal(report.final_commit, expectedFinalCommit, "final_commit");
  equal(report.old.label, "old", "old.label");
  equal(report.pivot.label, "pivot", "pivot.label");
  equal(report.final.label, "final", "final.label");

  const old = calculateState(report.old, "old");
  const pivot = calculateState(report.pivot, "pivot");
  const final = calculateState(report.final, "final");

  if (expectedLane) {
    const oldIds = report.old.threats.map((threat) => threat.id);
    const oldSeverities = report.old.threats.map((threat) => threat.severity);
    if (JSON.stringify(oldIds) !== JSON.stringify(expectedLane.oldIds)) {
      errors.push(`old threat IDs/order differ from the pinned ${report.lane} report`);
    }
    if (JSON.stringify(oldSeverities) !== JSON.stringify(expectedLane.oldSeverities)) {
      errors.push(`old threat severities/order differ from the pinned ${report.lane} report`);
    }
  }

  const pivotShape = report.pivot.threats.map((threat) => [threat.id, threat.title, threat.severity, threat.weight]);
  const finalShape = report.final.threats.map((threat) => [threat.id, threat.title, threat.severity, threat.weight]);
  if (JSON.stringify(pivotShape) !== JSON.stringify(finalShape)) {
    errors.push("pivot/final threat IDs, order, titles, severities, or weights differ");
  }

  close(report.delta_scope, pivot.ari - old.ari, 0.000001, "delta_scope");
  close(report.delta_controls, final.ari - pivot.ari, 0.000001, "delta_controls");
  close(report.delta_scope + report.delta_controls, final.ari - old.ari, 0.000001, "delta decomposition total");

  const expectedOld =
    report.lane === "openai"
      ? { ari: 33.816326530612244, riskMass: 16.57, riskCapacity: 49, grade: "D" }
      : report.lane === "anthropic"
        ? { ari: 28.392857142857142, riskMass: 7.95, riskCapacity: 28, grade: "C" }
        : null;
  if (expectedOld) {
    close(old.ari, expectedOld.ari, 0.000001, "old pinned ARI");
    close(old.riskMass, expectedOld.riskMass, 0.000001, "old pinned risk mass");
    close(old.riskCapacity, expectedOld.riskCapacity, 0, "old pinned risk capacity");
    equal(old.grade, expectedOld.grade, "old pinned grade");
  }

  const residualIds = report.accepted_yolo_residuals.map((residual) => /^(D-0[1-4])\b/.exec(residual)?.[1] ?? null);
  const requiredResidualIds = ["D-01", "D-02", "D-03", "D-04"];
  if (
    residualIds.includes(null) ||
    residualIds.length !== 4 ||
    JSON.stringify([...residualIds].sort()) !== JSON.stringify(requiredResidualIds)
  ) {
    errors.push("accepted_yolo_residuals must contain exactly D-01, D-02, D-03, and D-04 once each");
  }

  equal(metadata.status, "succeeded", "metadata.status");
  equal(metadata.error, null, "metadata.error");
  validateConfiguredLimits();
  validateStructuredOutput();
  equal(metadata.lane, report.lane, "metadata.lane");
  equal(metadata.intended_model, report.intended_model, "metadata.intended_model");
  equal(metadata.actual_model, report.actual_model, "metadata.actual_model");
  equal(metadata.effort, report.effort, "metadata.effort");
  equal(metadata.degradation, report.degradation, "metadata.degradation");
  for (const [field, expected] of Object.entries(pins)) equal(metadata[field], expected, `metadata.${field}`);
  equal(metadata.reports_commit, PINS.reports, "metadata.reports_commit");
  if (typeof metadata.cli_version !== "string" || metadata.cli_version.trim() === "") {
    errors.push("metadata.cli_version must be a nonempty string");
  }
  equal(metadata.final_commit, expectedFinalCommit, "metadata.final_commit");
  equal(metadata.final_base, expectedFinalBase, "metadata.final_base");
  if (JSON.stringify(metadata.reviewed_remediation_heads) !== JSON.stringify(REVIEWED_REMEDIATION_HEADS)) {
    errors.push("metadata.reviewed_remediation_heads does not match the eight pinned reviewed heads");
  }
  equal(metadata.output_sha256, createHash("sha256").update(reportBytes).digest("hex"), "metadata.output_sha256");
  equal(metadata.schema_sha256, createHash("sha256").update(schemaBytes).digest("hex"), "metadata.schema_sha256");
  if (JSON.stringify(metadata.repositories_before) !== JSON.stringify(metadata.repositories_after)) {
    errors.push("metadata repository snapshots differ before and after execution");
  }
  const expectedRepositories = {
    final: { commit: expectedFinalCommit, path: null },
    baseline: { commit: PINS.baseline, path: PATHS.baseline },
    skill: { commit: PINS.skill, path: PATHS.skill },
    ari: { commit: PINS.ari, path: PATHS.ari },
    reports: { commit: PINS.reports, path: PATHS.reports }
  };
  for (const [repository, expectedRepository] of Object.entries(expectedRepositories)) {
    const snapshot = metadata.repositories_before?.[repository];
    equal(snapshot?.commit, expectedRepository.commit, `metadata.repositories_before.${repository}.commit`);
    equal(snapshot?.clean, true, `metadata.repositories_before.${repository}.clean`);
    if (expectedRepository.path !== null) {
      equal(snapshot?.path, expectedRepository.path, `metadata.repositories_before.${repository}.path`);
    } else if (typeof snapshot?.path !== "string" || !path.isAbsolute(snapshot.path)) {
      errors.push("metadata.repositories_before.final.path must be absolute");
    }
  }
  if (JSON.stringify(metadata.assessor_inputs_before) !== JSON.stringify(metadata.assessor_inputs_after)) {
    errors.push("metadata assessor input snapshots differ before and after execution");
  }
  equal(
    metadata.assessor_inputs_before?.prompt_sha256,
    metadata.prompt_sha256,
    "metadata.assessor_inputs_before.prompt_sha256"
  );
  equal(
    metadata.assessor_inputs_before?.schema_sha256,
    metadata.schema_sha256,
    "metadata.assessor_inputs_before.schema_sha256"
  );
  equal(
    metadata.assessor_inputs_before?.remediation_manifest_sha256,
    metadata.remediation_manifest_sha256,
    "metadata.assessor_inputs_before.remediation_manifest_sha256"
  );
  equal(metadata.remediation_manifest_sha256, PINS.remediation_manifest_sha256, "metadata.remediation_manifest_sha256");

  if (report.lane === "openai") {
    equal(report.actual_model, "gpt-5.6-sol", "OpenAI actual_model");
    equal(report.degradation, null, "OpenAI degradation");
    equal(metadata.commanded_model, "gpt-5.6-sol", "metadata.commanded_model");
    validateChildOutcome(metadata.execution, "metadata.execution", ASSESSOR_LIMITS.codex_deadline_ms);
    requireSuccessfulOutcome(metadata.execution, "metadata.execution");
    if (!isObject(metadata.event_stream)) {
      errors.push("metadata.event_stream must be an object");
    } else {
      validateCaptureStats(
        {
          maxBytes: metadata.event_stream.max_bytes,
          observedBytes: metadata.event_stream.observed_bytes,
          capturedBytes: metadata.event_stream.captured_bytes,
          limitExceeded: metadata.event_stream.limit_exceeded,
          fileBytes: metadata.event_stream.file_bytes
        },
        ASSESSOR_LIMITS.codex_event_max_bytes,
        "metadata.event_stream"
      );
      equal(metadata.event_stream.limit_exceeded, false, "metadata.event_stream.limit_exceeded");
      equal(metadata.event_stream.stream_error, null, "metadata.event_stream.stream_error");
      equal(metadata.event_bytes, metadata.event_stream.captured_bytes, "metadata.event_bytes");
    }
    if (!/^[a-f0-9]{64}$/.test(metadata.events_sha256)) {
      errors.push("metadata.events_sha256 is not a lowercase SHA-256");
    }
  } else if (report.lane === "anthropic") {
    const primaryModel = "claude-fable-5";
    const fallbackModel = "claude-opus-4-8";
    const expectedAuxiliaryModelEnvironmentPolicy = {
      ANTHROPIC_SMALL_FAST_MODEL: "commanded_model",
      CLAUDE_CODE_AUTO_MODE_MODEL: "commanded_model",
      CLAUDE_CODE_BG_CLASSIFIER_MODEL: "commanded_model",
      CLAUDE_CONTEXT_COLLAPSE_MODEL: "commanded_model"
    };
    equal(metadata.primary_model, primaryModel, "metadata.primary_model");
    equal(metadata.fallback_model, fallbackModel, "metadata.fallback_model");
    if (
      JSON.stringify(metadata.auxiliary_model_environment_policy) !==
      JSON.stringify(expectedAuxiliaryModelEnvironmentPolicy)
    ) {
      errors.push("Anthropic metadata has an unexpected auxiliary model environment policy");
    }
    const matchesModel = (reportedModel, allowedModel) =>
      typeof reportedModel === "string" &&
      (reportedModel === allowedModel || reportedModel.startsWith(`${allowedModel}-`));
    const modelsWithPositiveUsage = (modelUsage) =>
      Object.entries(modelUsage ?? {})
        .filter(([, usage]) => {
          if (usage === null || typeof usage !== "object") return false;
          return Object.values(usage).some((value) => typeof value === "number" && value > 0);
        })
        .map(([model]) => model);
    const usedModels = modelsWithPositiveUsage(metadata.model_usage);
    if (JSON.stringify(usedModels) !== JSON.stringify(metadata.used_models)) {
      errors.push("metadata.used_models does not match positive metadata.model_usage entries");
    }
    if (usedModels.length === 0) errors.push("Anthropic metadata has no positive model usage");
    const unexpectedModels = usedModels.filter(
      (model) => !matchesModel(model, primaryModel) && !matchesModel(model, fallbackModel)
    );
    if (unexpectedModels.length > 0) {
      errors.push(`Anthropic metadata contains unapproved models: ${unexpectedModels.join(", ")}`);
    }

    const attempts = metadata.attempts;
    const directFallback = metadata.forced_explicit_fallback === true;
    if (!Array.isArray(attempts) || (directFallback ? attempts.length !== 1 : ![1, 2].includes(attempts.length))) {
      errors.push(
        directFallback
          ? "Anthropic direct-fallback metadata.attempts must contain exactly one explicit fallback"
          : "Anthropic metadata.attempts must contain one primary attempt and at most one explicit fallback"
      );
    } else {
      const expectedExplicitRetry = !directFallback && attempts.length === 2;
      equal(metadata.explicit_retry, expectedExplicitRetry, "metadata.explicit_retry");
      equal(
        metadata.selected_attempt,
        directFallback || expectedExplicitRetry ? "explicit_fallback" : "primary",
        "metadata.selected_attempt"
      );

      for (const [attemptIndex, attempt] of attempts.entries()) {
        const attemptUsedModels = modelsWithPositiveUsage(attempt.model_usage);
        if (JSON.stringify(attemptUsedModels) !== JSON.stringify(attempt.used_models)) {
          errors.push(`${attempt.label}: used_models does not match positive model_usage entries`);
        }
        const attemptOutcome = {
          code: attempt.exit_code,
          signal: attempt.signal,
          spawn_error: attempt.spawn_error,
          termination_reason: attempt.termination_reason,
          timed_out: attempt.timed_out,
          output_limit_exceeded: attempt.output_limit_exceeded,
          term_sent: attempt.term_sent,
          kill_sent: attempt.kill_sent,
          deadline_ms: attempt.deadline_ms,
          term_grace_ms: attempt.term_grace_ms,
          wall_time_ms: attempt.wall_time_ms
        };
        validateChildOutcome(
          attemptOutcome,
          `metadata.attempts[${attemptIndex}]`,
          ASSESSOR_LIMITS.claude_attempt_deadline_ms
        );
        validateCaptureStats(
          {
            maxBytes: attempt.stdout_max_bytes,
            observedBytes: attempt.stdout_observed_bytes,
            capturedBytes: attempt.stdout_captured_bytes,
            limitExceeded: attempt.stdout_limit_exceeded,
            fileBytes: attempt.raw_bytes
          },
          ASSESSOR_LIMITS.claude_stdout_max_bytes,
          `metadata.attempts[${attemptIndex}].stdout`
        );
        if (attempt.output_limit_exceeded === true) {
          equal(
            attempt.termination_reason,
            "claude_stdout_limit",
            `metadata.attempts[${attemptIndex}].termination_reason`
          );
        }
        if (
          attempt.stdout_stream_error !== null &&
          (!isObject(attempt.stdout_stream_error) ||
            typeof attempt.stdout_stream_error.name !== "string" ||
            typeof attempt.stdout_stream_error.message !== "string")
        ) {
          errors.push(`${attempt.label}: invalid stdout_stream_error provenance`);
        }
        const exitedBySignal =
          attempt.exit_code === null && typeof attempt.signal === "string" && attempt.signal !== "";
        const validExitCode = Number.isInteger(attempt.exit_code) && attempt.exit_code >= 0;
        if (typeof attempt.json_envelope_parsed !== "boolean" || typeof attempt.json_envelope_object !== "boolean") {
          errors.push(`${attempt.label}: invalid JSON envelope provenance flags`);
        }
        if (attempt.json_envelope_object === true && attempt.json_envelope_parsed !== true) {
          errors.push(`${attempt.label}: JSON object provenance requires a parsed envelope`);
        }
        if (attempt.json_envelope_parsed === true && attempt.envelope_parse_error !== null) {
          errors.push(`${attempt.label}: parsed envelope requires a null envelope_parse_error`);
        }
        if (
          attempt.json_envelope_parsed === false &&
          (typeof attempt.envelope_parse_error !== "string" || attempt.envelope_parse_error === "")
        ) {
          errors.push(`${attempt.label}: unparsed envelope requires a nonempty envelope_parse_error`);
        }
        const primaryFailureWithoutUsage =
          !directFallback &&
          expectedExplicitRetry &&
          attemptIndex === 0 &&
          (attempt.timed_out === true ||
            attempt.stdout_limit_exceeded === true ||
            attempt.spawn_error !== null ||
            attempt.stdout_stream_error !== null ||
            attempt.termination_reason !== null ||
            (validExitCode && attempt.exit_code !== 0) ||
            exitedBySignal ||
            attempt.json_envelope_object === false);
        if (attemptUsedModels.length === 0 && !primaryFailureWithoutUsage) {
          errors.push(`${attempt.label}: no positive model usage`);
        }
        const attemptUnexpectedModels = attemptUsedModels.filter(
          (model) => !matchesModel(model, primaryModel) && !matchesModel(model, fallbackModel)
        );
        if (attemptUnexpectedModels.length > 0) {
          errors.push(`${attempt.label}: unapproved models ${attemptUnexpectedModels.join(", ")}`);
        }
        if (!/^[a-f0-9]{64}$/.test(attempt.raw_sha256)) {
          errors.push(`${attempt.label}: raw_sha256 is not a lowercase SHA-256`);
        }
      }

      const validateExplicitFallbackAttempt = (explicitFallbackAttempt, attemptIndex) => {
        const fallbackAttemptModels = modelsWithPositiveUsage(explicitFallbackAttempt.model_usage);
        const prefix = `metadata.attempts[${attemptIndex}]`;
        equal(explicitFallbackAttempt.label, "explicit_fallback", `${prefix}.label`);
        equal(explicitFallbackAttempt.commanded_model, fallbackModel, `${prefix}.commanded_model`);
        equal(explicitFallbackAttempt.automatic_fallback_model, null, `${prefix}.automatic_fallback_model`);
        equal(explicitFallbackAttempt.exit_code, 0, "metadata explicit fallback exit_code");
        equal(explicitFallbackAttempt.signal, null, "metadata explicit fallback signal");
        equal(explicitFallbackAttempt.spawn_error, null, "metadata explicit fallback spawn_error");
        equal(explicitFallbackAttempt.termination_reason, null, "metadata explicit fallback termination_reason");
        equal(explicitFallbackAttempt.timed_out, false, "metadata explicit fallback timed_out");
        equal(explicitFallbackAttempt.output_limit_exceeded, false, "metadata explicit fallback output_limit_exceeded");
        equal(explicitFallbackAttempt.term_sent, false, "metadata explicit fallback term_sent");
        equal(explicitFallbackAttempt.kill_sent, false, "metadata explicit fallback kill_sent");
        equal(explicitFallbackAttempt.stdout_limit_exceeded, false, "metadata explicit fallback stdout_limit_exceeded");
        equal(explicitFallbackAttempt.stdout_stream_error, null, "metadata explicit fallback stdout_stream_error");
        equal(explicitFallbackAttempt.json_envelope_parsed, true, "metadata explicit fallback json_envelope_parsed");
        equal(explicitFallbackAttempt.json_envelope_object, true, "metadata explicit fallback json_envelope_object");
        equal(explicitFallbackAttempt.retry_reason, null, "metadata explicit fallback retry_reason");
        equal(
          explicitFallbackAttempt.structured_output_present,
          true,
          "metadata explicit fallback structured_output_present"
        );
        if (
          !fallbackAttemptModels.some((model) => matchesModel(model, fallbackModel)) ||
          fallbackAttemptModels.some((model) => !matchesModel(model, fallbackModel))
        ) {
          errors.push("explicit fallback must contain positive Opus-only model usage");
        }
        if (JSON.stringify(explicitFallbackAttempt.model_usage) !== JSON.stringify(metadata.model_usage)) {
          errors.push("selected explicit fallback model_usage differs from metadata.model_usage");
        }
      };

      if (directFallback) {
        const explicitFallbackAttempt = attempts[0];
        validateExplicitFallbackAttempt(explicitFallbackAttempt, 0);
        equal(metadata.primary_raw_sha256, null, "metadata.primary_raw_sha256");
        equal(metadata.fallback_raw_sha256, explicitFallbackAttempt.raw_sha256, "metadata.fallback_raw_sha256");
        equal(metadata.raw_sha256, explicitFallbackAttempt.raw_sha256, "metadata.raw_sha256");
      } else {
        const primaryAttempt = attempts[0];
        equal(primaryAttempt.label, "primary", "metadata.attempts[0].label");
        equal(primaryAttempt.commanded_model, primaryModel, "metadata.attempts[0].commanded_model");
        equal(primaryAttempt.automatic_fallback_model, fallbackModel, "metadata.attempts[0].automatic_fallback_model");

        if (expectedExplicitRetry) {
          const explicitFallbackAttempt = attempts[1];
          const expectedRetryReason = primaryAttempt.timed_out
            ? "primary_timeout"
            : primaryAttempt.stdout_limit_exceeded
              ? "primary_stdout_limit"
              : primaryAttempt.spawn_error !== null
                ? "primary_spawn_error"
                : primaryAttempt.stdout_stream_error !== null
                  ? "primary_stdout_stream_error"
                  : primaryAttempt.termination_reason !== null
                    ? "primary_terminated"
                    : primaryAttempt.exit_code !== 0 || primaryAttempt.signal !== null
                      ? "primary_nonzero_exit"
                      : primaryAttempt.json_envelope_object === false
                        ? "primary_invalid_json_envelope"
                        : "primary_missing_structured_output";
          equal(primaryAttempt.retry_reason, expectedRetryReason, "metadata primary retry_reason");
          if (expectedRetryReason === "primary_missing_structured_output") {
            equal(
              primaryAttempt.structured_output_present,
              false,
              "metadata primary missing structured_output_present"
            );
          }
          validateExplicitFallbackAttempt(explicitFallbackAttempt, 1);
        } else {
          equal(primaryAttempt.exit_code, 0, "metadata primary exit_code");
          equal(primaryAttempt.signal, null, "metadata primary signal");
          equal(primaryAttempt.spawn_error, null, "metadata primary spawn_error");
          equal(primaryAttempt.termination_reason, null, "metadata primary termination_reason");
          equal(primaryAttempt.timed_out, false, "metadata primary timed_out");
          equal(primaryAttempt.output_limit_exceeded, false, "metadata primary output_limit_exceeded");
          equal(primaryAttempt.term_sent, false, "metadata primary term_sent");
          equal(primaryAttempt.kill_sent, false, "metadata primary kill_sent");
          equal(primaryAttempt.stdout_limit_exceeded, false, "metadata primary stdout_limit_exceeded");
          equal(primaryAttempt.stdout_stream_error, null, "metadata primary stdout_stream_error");
          equal(primaryAttempt.json_envelope_parsed, true, "metadata primary json_envelope_parsed");
          equal(primaryAttempt.json_envelope_object, true, "metadata primary json_envelope_object");
          equal(primaryAttempt.retry_reason, null, "metadata primary retry_reason");
          equal(primaryAttempt.structured_output_present, true, "metadata primary structured_output_present");
          if (JSON.stringify(primaryAttempt.model_usage) !== JSON.stringify(metadata.model_usage)) {
            errors.push("selected primary model_usage differs from metadata.model_usage");
          }
        }
        equal(metadata.primary_raw_sha256, primaryAttempt.raw_sha256, "metadata.primary_raw_sha256");
        if (expectedExplicitRetry) {
          equal(metadata.fallback_raw_sha256, attempts[1].raw_sha256, "metadata.fallback_raw_sha256");
          equal(metadata.raw_sha256, attempts[1].raw_sha256, "metadata.raw_sha256");
        } else {
          equal(metadata.fallback_raw_sha256, null, "metadata.fallback_raw_sha256");
          equal(metadata.raw_sha256, primaryAttempt.raw_sha256, "metadata.raw_sha256");
        }
      }
    }

    const fallbackUsed = usedModels.some((model) => matchesModel(model, fallbackModel));
    const expectedActualModel = fallbackUsed ? fallbackModel : primaryModel;
    equal(report.actual_model, expectedActualModel, "Anthropic actual_model from modelUsage");
    equal(metadata.fallback_used, fallbackUsed, "metadata.fallback_used");
    if (!fallbackUsed) {
      equal(report.degradation, null, "Anthropic primary degradation");
    } else if (
      typeof report.degradation !== "string" ||
      !report.degradation.includes(primaryModel) ||
      !report.degradation.includes(fallbackModel)
    ) {
      errors.push(`Anthropic fallback degradation must name ${primaryModel} and ${fallbackModel}`);
    }
  }
  return { old, pivot, final };
};

let calculations = null;
const reportIsObject = report !== null && typeof report === "object" && !Array.isArray(report);
const metadataIsObject = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata);
if (!metadataIsObject) errors.push("metadata must be a JSON object");
if (reportIsObject && metadataIsObject) {
  try {
    calculations = validateSemantics();
  } catch (error) {
    errors.push(`semantic validation could not complete: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (errors.length === 0 && calculations === null) {
  errors.push("semantic validation did not produce calculated states");
}

if (errors.length > 0) {
  console.error(errors.map((error) => `ERROR ${error}`).join("\n"));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      lane: report.lane,
      actual_model: report.actual_model,
      old: calculations.old,
      pivot: calculations.pivot,
      final: calculations.final,
      delta_scope: report.delta_scope,
      delta_controls: report.delta_controls
    },
    null,
    2
  )
);
