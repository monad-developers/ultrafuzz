#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ASSESSOR_LIMITS,
  PATHS,
  PINS,
  assertBundledSchema,
  assertCandidateAncestry,
  assertCommonProvenance,
  assertOutputLocations,
  assertPinnedRepositories,
  assertPostflightIntegrity,
  assertRenderedPrompt,
  captureAssessorInputs,
  commandVersion,
  createByteLimitTransform,
  fileBytes,
  sha256File,
  superviseChildProcess,
  writeJsonExclusive
} from "./ari-refresh-common.mjs";

const [promptPath, schemaPath, outputPath, checkoutPath, expectedFinalCommit, expectedFinalBase] =
  process.argv.slice(2);
if (!promptPath || !schemaPath || !outputPath || !checkoutPath || !expectedFinalCommit || !expectedFinalBase) {
  console.error(
    "usage: node run-claude-structured.mjs <prompt.md> <schema.json> <output.json> <final-checkout> <expected-final-commit> <expected-final-base>"
  );
  process.exit(2);
}
process.umask(0o077);

const primaryModel = "claude-fable-5";
const fallbackModel = "claude-opus-4-8";
const effort = "max";
const forceExplicitFallback = process.env.ARI_CLAUDE_FORCE_EXPLICIT_FALLBACK === "1";
const auxiliaryModelEnvironment = [
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_AUTO_MODE_MODEL",
  "CLAUDE_CODE_BG_CLASSIFIER_MODEL",
  "CLAUDE_CONTEXT_COLLAPSE_MODEL"
];
const metadataPath = `${outputPath}.meta.json`;
const primaryRawPath = `${outputPath}.raw.json`;
const fallbackRawPath = `${outputPath}.fallback.raw.json`;

const errorSummary = (error) => ({
  name: error instanceof Error ? error.name : "Error",
  message: error instanceof Error ? error.message : String(error)
});

const fileSnapshot = (filePath, hashLimit) => {
  if (!existsSync(filePath)) return { bytes: null, sha256: null };
  const bytes = fileBytes(filePath);
  return {
    bytes,
    sha256: bytes <= hashLimit ? sha256File(filePath) : null
  };
};

const usageIsPositive = (usage) => {
  if (usage === null || typeof usage !== "object") return false;
  return Object.values(usage).some((value) => typeof value === "number" && value > 0);
};

const matchesModel = (reportedModel, allowedModel) =>
  reportedModel === allowedModel || reportedModel.startsWith(`${allowedModel}-`);

const modelsWithPositiveUsage = (modelUsage) =>
  Object.entries(modelUsage ?? {})
    .filter(([, usage]) => usageIsPositive(usage))
    .map(([model]) => model);

const deriveClaudeGenerationSchema = (canonicalSchema) => {
  const parsed = JSON.parse(canonicalSchema);
  const declaredDialect = parsed.$schema ?? null;
  const topLevelComposition = parsed.allOf ?? null;
  delete parsed.$schema;
  delete parsed.allOf;
  const schema = JSON.stringify(parsed);
  return {
    schema,
    manifest: {
      purpose: "generation_only",
      canonical_verification_authoritative: true,
      transform: "omit unsupported top-level $schema declaration and lane-conditional allOf",
      omitted_dialect: declaredDialect,
      omitted_top_level_all_of_sha256:
        topLevelComposition === null
          ? null
          : createHash("sha256").update(JSON.stringify(topLevelComposition)).digest("hex"),
      sha256: createHash("sha256").update(schema).digest("hex")
    }
  };
};

const classifyModelUsage = (modelUsage, attemptLabel, { requirePositive = true } = {}) => {
  const usedModels = modelsWithPositiveUsage(modelUsage);
  if (requirePositive && usedModels.length === 0) {
    throw new Error(`${attemptLabel} did not report positive modelUsage`);
  }
  const unexpectedModels = usedModels.filter(
    (model) => !matchesModel(model, primaryModel) && !matchesModel(model, fallbackModel)
  );
  if (unexpectedModels.length > 0) {
    throw new Error(`${attemptLabel} used an unapproved model: ${unexpectedModels.join(", ")}`);
  }
  return usedModels;
};

const runClaude = async ({ commandedModel, automaticFallbackModel, prompt, schema, checkoutPath, rawPath }) => {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--json-schema",
    schema,
    "--model",
    commandedModel,
    "--prompt-suggestions",
    "false"
  ];
  if (automaticFallbackModel !== null) {
    args.push("--fallback-model", automaticFallbackModel);
  }
  args.push(
    "--effort",
    effort,
    "--tools",
    "Bash,Glob,Grep,Read",
    "--dangerously-skip-permissions",
    "--add-dir",
    PATHS.baseline,
    PATHS.audit,
    "--safe-mode",
    "--no-session-persistence",
    prompt
  );

  const child = spawn("claude", args, {
    cwd: checkoutPath,
    env: {
      ...process.env,
      ...Object.fromEntries(auxiliaryModelEnvironment.map((name) => [name, commandedModel]))
    },
    stdio: ["ignore", "pipe", "inherit"],
    detached: true
  });

  const supervisor = superviseChildProcess(child, {
    deadlineMs: ASSESSOR_LIMITS.claude_attempt_deadline_ms,
    termGraceMs: ASSESSOR_LIMITS.term_grace_ms
  });
  const chunks = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  const stdoutLimiter = createByteLimitTransform(ASSESSOR_LIMITS.claude_stdout_max_bytes, () => {
    supervisor.terminate("claude_stdout_limit");
  });
  let stdoutStreamError = null;
  const stdoutPipeline = pipeline(child.stdout, stdoutLimiter.stream, collector).catch((error) => {
    stdoutStreamError = errorSummary(error);
    supervisor.terminate("claude_stdout_stream_error");
  });

  const outcome = await supervisor.completion;
  await stdoutPipeline;
  const stdout = {
    ...stdoutLimiter.stats(),
    stream_error: stdoutStreamError
  };
  const raw = Buffer.concat(chunks);
  writeFileSync(rawPath, raw, { mode: 0o600, flag: "wx" });
  let envelope = null;
  let envelopeParsed = false;
  let envelopeParseError = null;
  try {
    envelope = JSON.parse(raw.toString("utf8"));
    envelopeParsed = true;
  } catch (error) {
    envelopeParseError = error instanceof Error ? error.message : String(error);
  }
  return {
    outcome,
    stdout: { ...stdout, file_bytes: raw.length },
    envelope,
    envelopeParsed,
    envelopeParseError
  };
};

const summarizeAttempt = (label, commandedModel, automaticFallbackModel, rawPath, result, usedModels, retryReason) => {
  const envelope = result.envelope !== null && typeof result.envelope === "object" ? result.envelope : {};
  return {
    label,
    commanded_model: commandedModel,
    automatic_fallback_model: automaticFallbackModel,
    exit_code: result.outcome.code,
    signal: result.outcome.signal,
    spawn_error: result.outcome.spawn_error,
    termination_reason: result.outcome.termination_reason,
    timed_out: result.outcome.timed_out,
    output_limit_exceeded: result.outcome.output_limit_exceeded,
    term_sent: result.outcome.term_sent,
    kill_sent: result.outcome.kill_sent,
    deadline_ms: result.outcome.deadline_ms,
    term_grace_ms: result.outcome.term_grace_ms,
    wall_time_ms: result.outcome.wall_time_ms,
    stdout_max_bytes: result.stdout.max_bytes,
    stdout_observed_bytes: result.stdout.observed_bytes,
    stdout_captured_bytes: result.stdout.captured_bytes,
    stdout_limit_exceeded: result.stdout.limit_exceeded,
    stdout_stream_error: result.stdout.stream_error,
    raw_bytes: result.stdout.file_bytes,
    json_envelope_parsed: result.envelopeParsed,
    json_envelope_object:
      result.envelope !== null && typeof result.envelope === "object" && !Array.isArray(result.envelope),
    envelope_parse_error: result.envelopeParseError,
    retry_reason: retryReason,
    used_models: usedModels,
    model_usage: envelope.modelUsage ?? {},
    structured_output_present: envelope.structured_output !== undefined && envelope.structured_output !== null,
    raw_sha256: sha256File(rawPath),
    duration_ms: envelope.duration_ms ?? null,
    duration_api_ms: envelope.duration_api_ms ?? null,
    total_cost_usd: envelope.total_cost_usd ?? null,
    num_turns: envelope.num_turns ?? null,
    session_id: envelope.session_id ?? null
  };
};

const attemptSucceeded = (result, envelope) =>
  result.outcome.code === 0 &&
  result.outcome.signal === null &&
  result.outcome.spawn_error === null &&
  result.outcome.termination_reason === null &&
  result.outcome.timed_out === false &&
  result.outcome.output_limit_exceeded === false &&
  result.stdout.limit_exceeded === false &&
  result.stdout.stream_error === null &&
  envelope !== null &&
  envelope.structured_output !== undefined &&
  envelope.structured_output !== null;

const primaryRetryReason = (result, envelope) => {
  if (result.outcome.timed_out) return "primary_timeout";
  if (result.stdout.limit_exceeded) return "primary_stdout_limit";
  if (result.outcome.spawn_error !== null) return "primary_spawn_error";
  if (result.stdout.stream_error !== null) return "primary_stdout_stream_error";
  if (result.outcome.termination_reason !== null) return "primary_terminated";
  if (result.outcome.code !== 0 || result.outcome.signal !== null) return "primary_nonzero_exit";
  if (envelope === null) return "primary_invalid_json_envelope";
  return "primary_missing_structured_output";
};

const assertFallbackSucceeded = (result, envelope) => {
  if (result.outcome.timed_out) {
    throw new Error("explicit Opus fallback timed out; no further fallback is permitted");
  }
  if (result.stdout.limit_exceeded) {
    throw new Error("explicit Opus fallback exceeded its stdout limit; no further fallback is permitted");
  }
  if (result.outcome.spawn_error !== null) {
    throw new Error(
      `explicit Opus fallback failed to spawn: ${result.outcome.spawn_error}; no further fallback is permitted`
    );
  }
  if (result.stdout.stream_error !== null) {
    throw new Error("explicit Opus fallback stdout pipeline failed; no further fallback is permitted");
  }
  if (result.outcome.termination_reason !== null) {
    throw new Error(
      `explicit Opus fallback was terminated (${result.outcome.termination_reason}); no further fallback is permitted`
    );
  }
  if (result.outcome.code !== 0 || result.outcome.signal !== null) {
    throw new Error(
      `explicit Opus fallback exited with ${result.outcome.code ?? `signal ${result.outcome.signal}`}; no further fallback is permitted`
    );
  }
  if (envelope === null) {
    throw new Error("explicit Opus fallback returned an invalid JSON envelope; no further fallback is permitted");
  }
  if (envelope.structured_output === undefined || envelope.structured_output === null) {
    throw new Error("explicit Opus fallback did not contain structured_output; no further fallback is permitted");
  }
};

const sumFinite = (values) => {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0);
};

const main = async () => {
  const prompt = readFileSync(promptPath, "utf8");
  assertBundledSchema(schemaPath);
  const canonicalSchema = readFileSync(schemaPath, "utf8");
  const generationSchema = deriveClaudeGenerationSchema(canonicalSchema);
  const primarySchema = forceExplicitFallback ? canonicalSchema : generationSchema.schema;
  const before = assertPinnedRepositories(checkoutPath, expectedFinalCommit);
  const ancestry = assertCandidateAncestry(checkoutPath, expectedFinalCommit, expectedFinalBase);
  assertRenderedPrompt(prompt, {
    lane: "anthropic",
    intendedModel: primaryModel,
    effort,
    finalCheckout: checkoutPath,
    expectedFinalCommit,
    expectedFinalBase
  });
  assertOutputLocations(promptPath, [outputPath, metadataPath, primaryRawPath, fallbackRawPath], expectedFinalCommit);
  const inputsBefore = captureAssessorInputs(promptPath, schemaPath);
  const cliVersion = commandVersion("claude");

  let after;
  let inputsAfter;
  let selectedEnvelope;
  let selectedAttempt;
  let selectedRawPath;
  let structured;
  let selectedUsedModels = [];
  let fallbackUsed = null;
  let expectedActualModel = null;
  let structuredOutput = {
    max_bytes: ASSESSOR_LIMITS.structured_output_max_bytes,
    bytes: null,
    limit_exceeded: false
  };
  let failure = null;
  const attempts = [];
  try {
    const runExplicitFallback = async () => {
      const fallbackResult = await runClaude({
        commandedModel: fallbackModel,
        automaticFallbackModel: null,
        prompt,
        schema: generationSchema.schema,
        checkoutPath,
        rawPath: fallbackRawPath
      });
      const fallbackEnvelope =
        fallbackResult.envelope !== null &&
        typeof fallbackResult.envelope === "object" &&
        !Array.isArray(fallbackResult.envelope)
          ? fallbackResult.envelope
          : null;
      const fallbackUsedModels = modelsWithPositiveUsage(fallbackEnvelope?.modelUsage);
      attempts.push(
        summarizeAttempt(
          "explicit_fallback",
          fallbackModel,
          null,
          fallbackRawPath,
          fallbackResult,
          fallbackUsedModels,
          null
        )
      );
      classifyModelUsage(fallbackEnvelope?.modelUsage, "explicit Opus fallback attempt", {
        requirePositive: false
      });
      assertFallbackSucceeded(fallbackResult, fallbackEnvelope);
      classifyModelUsage(fallbackEnvelope.modelUsage, "successful explicit Opus fallback attempt");
      if (fallbackUsedModels.some((model) => !matchesModel(model, fallbackModel))) {
        throw new Error("explicit Opus fallback reported non-Opus model usage");
      }
      selectedEnvelope = fallbackEnvelope;
      selectedAttempt = "explicit_fallback";
      selectedRawPath = fallbackRawPath;
    };

    if (forceExplicitFallback) {
      await runExplicitFallback();
    } else {
      const primaryResult = await runClaude({
        commandedModel: primaryModel,
        automaticFallbackModel: fallbackModel,
        prompt,
        schema: primarySchema,
        checkoutPath,
        rawPath: primaryRawPath
      });
      const primaryEnvelope =
        primaryResult.envelope !== null &&
        typeof primaryResult.envelope === "object" &&
        !Array.isArray(primaryResult.envelope)
          ? primaryResult.envelope
          : null;
      const primaryUsedModels = modelsWithPositiveUsage(primaryEnvelope?.modelUsage);
      const primarySucceeded = attemptSucceeded(primaryResult, primaryEnvelope);
      const retryReason = primarySucceeded ? null : primaryRetryReason(primaryResult, primaryEnvelope);
      attempts.push(
        summarizeAttempt(
          "primary",
          primaryModel,
          fallbackModel,
          primaryRawPath,
          primaryResult,
          primaryUsedModels,
          retryReason
        )
      );
      classifyModelUsage(primaryEnvelope?.modelUsage, "primary Claude attempt", {
        requirePositive: false
      });

      if (primarySucceeded) {
        classifyModelUsage(primaryEnvelope.modelUsage, "successful primary Claude attempt");
        selectedEnvelope = primaryEnvelope;
        selectedAttempt = "primary";
        selectedRawPath = primaryRawPath;
      } else {
        await runExplicitFallback();
      }
    }

    structured = selectedEnvelope.structured_output;
    selectedUsedModels = classifyModelUsage(selectedEnvelope.modelUsage, "selected Claude attempt");
    fallbackUsed = selectedUsedModels.some((model) => matchesModel(model, fallbackModel));
    expectedActualModel = fallbackUsed ? fallbackModel : primaryModel;
    assertCommonProvenance(structured, {
      lane: "anthropic",
      intendedModel: primaryModel,
      effort,
      expectedFinalCommit
    });
    if (structured.actual_model !== expectedActualModel) {
      throw new Error(
        `Claude actual_model mismatch: selected modelUsage requires ${expectedActualModel}, response says ${structured.actual_model}`
      );
    }
    if (!fallbackUsed && structured.degradation !== null) {
      throw new Error("Claude reported degradation although only the intended model served the selected assessment");
    }
    if (
      fallbackUsed &&
      (typeof structured.degradation !== "string" ||
        !structured.degradation.includes(primaryModel) ||
        !structured.degradation.includes(fallbackModel))
    ) {
      throw new Error(`Claude fallback degradation must name both ${primaryModel} and ${fallbackModel}`);
    }
    structuredOutput.bytes = Buffer.byteLength(`${JSON.stringify(structured, null, 2)}\n`);
    structuredOutput.limit_exceeded = structuredOutput.bytes > structuredOutput.max_bytes;
    if (structuredOutput.limit_exceeded) {
      throw new Error(`Claude structured output exceeded ${structuredOutput.max_bytes} bytes`);
    }
    writeJsonExclusive(outputPath, structured);
  } catch (error) {
    failure = error;
  } finally {
    try {
      ({ repositories: after, assessorInputs: inputsAfter } = assertPostflightIntegrity(
        checkoutPath,
        expectedFinalCommit,
        inputsBefore,
        promptPath,
        schemaPath
      ));
    } catch (error) {
      failure =
        failure === null
          ? error
          : new AggregateError([failure, error], "Claude execution and postflight integrity checks failed");
    }
  }

  const outputFile = fileSnapshot(outputPath, ASSESSOR_LIMITS.structured_output_max_bytes);
  const selectedRawFile =
    selectedRawPath === undefined
      ? { bytes: null, sha256: null }
      : fileSnapshot(selectedRawPath, ASSESSOR_LIMITS.claude_stdout_max_bytes);
  const primaryRawFile = fileSnapshot(primaryRawPath, ASSESSOR_LIMITS.claude_stdout_max_bytes);
  const fallbackRawFile = fileSnapshot(fallbackRawPath, ASSESSOR_LIMITS.claude_stdout_max_bytes);
  if (structuredOutput.bytes === null && outputFile.bytes !== null) {
    structuredOutput = {
      ...structuredOutput,
      bytes: outputFile.bytes,
      limit_exceeded: outputFile.bytes > structuredOutput.max_bytes
    };
  }

  const metadata = {
    status: failure === null ? "succeeded" : "failed",
    error: failure === null ? null : errorSummary(failure),
    lane: "anthropic",
    intended_model: primaryModel,
    primary_model: primaryModel,
    fallback_model: fallbackModel,
    actual_model: expectedActualModel,
    effort,
    degradation: structured?.degradation ?? null,
    cli_version: cliVersion,
    generation_schema: generationSchema.manifest,
    forced_explicit_fallback: forceExplicitFallback,
    auxiliary_model_environment_policy: Object.fromEntries(
      auxiliaryModelEnvironment.map((name) => [name, "commanded_model"])
    ),
    limits: { ...ASSESSOR_LIMITS },
    structured_output: structuredOutput,
    used_models: selectedUsedModels,
    fallback_used: fallbackUsed,
    explicit_retry: !forceExplicitFallback && attempts.length === 2,
    selected_attempt: selectedAttempt ?? null,
    model_usage: selectedEnvelope?.modelUsage ?? {},
    attempts,
    skill_commit: PINS.skill,
    ari_commit: PINS.ari,
    baseline_commit: PINS.baseline,
    reports_commit: PINS.reports,
    final_commit: expectedFinalCommit,
    ...ancestry,
    repositories_before: before,
    repositories_after: after,
    assessor_inputs_before: inputsBefore,
    assessor_inputs_after: inputsAfter,
    prompt_sha256: inputsBefore.prompt_sha256,
    schema_sha256: inputsBefore.schema_sha256,
    remediation_manifest_sha256: inputsBefore.remediation_manifest_sha256,
    output_sha256: outputFile.sha256,
    raw_sha256: selectedRawFile.sha256,
    primary_raw_sha256: primaryRawFile.sha256,
    fallback_raw_sha256: fallbackRawFile.sha256,
    duration_ms: sumFinite(attempts.map((attempt) => attempt.duration_ms)),
    duration_api_ms: sumFinite(attempts.map((attempt) => attempt.duration_api_ms)),
    total_cost_usd: sumFinite(attempts.map((attempt) => attempt.total_cost_usd)),
    num_turns: sumFinite(attempts.map((attempt) => attempt.num_turns)),
    session_id: selectedEnvelope?.session_id ?? null
  };
  writeJsonExclusive(metadataPath, metadata);

  if (failure !== null) throw failure;

  console.log(
    JSON.stringify(
      {
        output: path.resolve(outputPath),
        metadata: path.resolve(metadataPath),
        raw: path.resolve(selectedRawPath),
        primary_raw: primaryRawFile.bytes === null ? null : path.resolve(primaryRawPath),
        fallback_raw: selectedAttempt === "explicit_fallback" ? path.resolve(fallbackRawPath) : null,
        actual_model: expectedActualModel,
        used_models: selectedUsedModels,
        num_turns: metadata.num_turns,
        total_cost_usd: metadata.total_cost_usd
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
