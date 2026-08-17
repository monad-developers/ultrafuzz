#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  ASSESSOR_LIMITS,
  PATHS,
  PINS,
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
    "usage: node run-codex-structured.mjs <prompt.md> <schema.json> <output.json> <final-checkout> <expected-final-commit> <expected-final-base>"
  );
  process.exit(2);
}
process.umask(0o077);

const model = "gpt-5.6-sol";
const effort = "xhigh";
const eventPath = `${outputPath}.events.jsonl`;
const metadataPath = `${outputPath}.meta.json`;
const generationSchemaPath = `${outputPath}.generation.schema.json`;

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

const deriveCodexGenerationSchema = (canonicalSchema) => {
  const schema = JSON.parse(canonicalSchema);
  let addedObjectTypes = 0;
  let addedClosedObjects = 0;
  let omittedUniqueItems = 0;
  for (const label of ["old", "pivot", "final"]) {
    const state = structuredClone(schema.$defs.state);
    state.properties.label = { type: "string", const: label };
    schema.properties[label] = state;
  }
  delete schema.$defs.control.allOf;
  delete schema.allOf;
  delete schema.$schema;
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Object.hasOwn(value, "uniqueItems")) {
      delete value.uniqueItems;
      omittedUniqueItems += 1;
    }
    if (Object.hasOwn(value, "properties") && value.type === undefined) {
      value.type = "object";
      addedObjectTypes += 1;
    }
    if (Object.hasOwn(value, "properties") && value.additionalProperties === undefined) {
      value.additionalProperties = false;
      addedClosedObjects += 1;
    }
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(schema);
  return {
    bytes: `${JSON.stringify(schema, null, 2)}\n`,
    transform:
      "inline labeled states, omit canonical-only conditionals, and close typed object schemas",
    added_object_types: addedObjectTypes,
    added_closed_objects: addedClosedObjects,
    omitted_control_conditionals: true,
    omitted_lane_conditionals: true,
    omitted_unique_items: omittedUniqueItems
  };
};

const main = async () => {
  const prompt = readFileSync(promptPath, "utf8");
  const before = assertPinnedRepositories(checkoutPath, expectedFinalCommit);
  const ancestry = assertCandidateAncestry(checkoutPath, expectedFinalCommit, expectedFinalBase);
  assertRenderedPrompt(prompt, {
    lane: "openai",
    intendedModel: model,
    effort,
    finalCheckout: checkoutPath,
    expectedFinalCommit,
    expectedFinalBase
  });
  assertOutputLocations(promptPath, [outputPath, eventPath, metadataPath, generationSchemaPath], expectedFinalCommit);
  const inputsBefore = captureAssessorInputs(promptPath, schemaPath);
  const generationSchema = deriveCodexGenerationSchema(readFileSync(schemaPath, "utf8"));
  writeFileSync(generationSchemaPath, generationSchema.bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const cliVersion = commandVersion("codex");

  let after;
  let inputsAfter;
  let structured;
  let execution = null;
  let eventStreamError = null;
  let eventStats = {
    max_bytes: ASSESSOR_LIMITS.codex_event_max_bytes,
    observed_bytes: 0,
    captured_bytes: 0,
    limit_exceeded: false
  };
  let structuredOutput = {
    max_bytes: ASSESSOR_LIMITS.structured_output_max_bytes,
    bytes: null,
    limit_exceeded: false
  };
  let failure = null;
  try {
    const eventStream = createWriteStream(eventPath, {
      encoding: "utf8",
      mode: 0o600,
      flags: "wx"
    });
    const child = spawn(
      "codex",
      [
        "exec",
        "--model",
        model,
        "--config",
        `model_reasoning_effort=\"${effort}\"`,
        "--dangerously-bypass-approvals-and-sandbox",
        "--ephemeral",
        "--json",
        "--color",
        "never",
        "--cd",
        checkoutPath,
        "--add-dir",
        PATHS.baseline,
        "--add-dir",
        PATHS.audit,
        "--output-schema",
        path.resolve(generationSchemaPath),
        "--output-last-message",
        outputPath,
        prompt
      ],
      {
        cwd: checkoutPath,
        env: process.env,
        stdio: ["ignore", "pipe", "inherit"],
        detached: true
      }
    );

    const supervisor = superviseChildProcess(child, {
      deadlineMs: ASSESSOR_LIMITS.codex_deadline_ms,
      termGraceMs: ASSESSOR_LIMITS.term_grace_ms
    });
    const eventLimiter = createByteLimitTransform(ASSESSOR_LIMITS.codex_event_max_bytes, () => {
      supervisor.terminate("codex_event_limit");
    });
    const eventPipeline = pipeline(child.stdout, eventLimiter.stream, eventStream).catch((error) => {
      eventStreamError = errorSummary(error);
      supervisor.terminate("codex_event_stream_error");
    });

    execution = await supervisor.completion;
    await eventPipeline;
    eventStats = eventLimiter.stats();

    if (eventStreamError !== null) {
      throw new Error(`Codex JSONL event pipeline failed: ${eventStreamError.message}`);
    }
    if (execution.spawn_error !== null) {
      throw new Error(`Codex failed to spawn: ${execution.spawn_error}`);
    }
    if (execution.timed_out) {
      throw new Error(`Codex exceeded its ${execution.deadline_ms}ms wall-clock deadline`);
    }
    if (execution.output_limit_exceeded || eventStats.limit_exceeded) {
      throw new Error(`Codex JSONL event stream exceeded ${eventStats.max_bytes} bytes`);
    }
    if (execution.termination_reason !== null) {
      throw new Error(`Codex was terminated: ${execution.termination_reason}`);
    }
    if (execution.code !== 0) {
      throw new Error(`codex exited with ${execution.code ?? `signal ${execution.signal}`}`);
    }

    if (!existsSync(outputPath)) throw new Error("Codex did not produce its structured output file");
    chmodSync(outputPath, 0o600);
    structuredOutput.bytes = fileBytes(outputPath);
    structuredOutput.limit_exceeded = structuredOutput.bytes > structuredOutput.max_bytes;
    if (structuredOutput.limit_exceeded) {
      throw new Error(`Codex structured output exceeded ${structuredOutput.max_bytes} bytes`);
    }
    structured = JSON.parse(readFileSync(outputPath, "utf8"));
    assertCommonProvenance(structured, {
      lane: "openai",
      intendedModel: model,
      effort,
      expectedFinalCommit
    });
    if (structured.actual_model !== model || structured.degradation !== null) {
      throw new Error(
        `Codex provenance mismatch: expected ${model}/${effort} with no degradation, got ${structured.actual_model}/${structured.effort} degradation=${structured.degradation}`
      );
    }
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
          : new AggregateError([failure, error], "Codex execution and postflight integrity checks failed");
    }
  }

  const outputFile = fileSnapshot(outputPath, ASSESSOR_LIMITS.structured_output_max_bytes);
  const eventFile = fileSnapshot(eventPath, ASSESSOR_LIMITS.codex_event_max_bytes);
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
    lane: "openai",
    intended_model: model,
    commanded_model: model,
    actual_model: structured?.actual_model ?? null,
    effort,
    degradation: structured?.degradation ?? null,
    cli_version: cliVersion,
    limits: { ...ASSESSOR_LIMITS },
    execution,
    event_stream: {
      ...eventStats,
      stream_error: eventStreamError,
      file_bytes: eventFile.bytes
    },
    structured_output: structuredOutput,
    generation_schema: {
      purpose: "generation_only",
      canonical_verification_authoritative: true,
      transform: generationSchema.transform,
      added_object_types: generationSchema.added_object_types,
      added_closed_objects: generationSchema.added_closed_objects,
      omitted_control_conditionals: generationSchema.omitted_control_conditionals,
      omitted_lane_conditionals: generationSchema.omitted_lane_conditionals,
      omitted_unique_items: generationSchema.omitted_unique_items,
      path: path.resolve(generationSchemaPath),
      bytes: fileBytes(generationSchemaPath),
      sha256: sha256File(generationSchemaPath)
    },
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
    events_sha256: eventFile.sha256,
    event_bytes: eventFile.bytes
  };
  writeJsonExclusive(metadataPath, metadata);

  if (failure !== null) throw failure;

  console.log(
    JSON.stringify(
      {
        output: path.resolve(outputPath),
        metadata: path.resolve(metadataPath),
        events: path.resolve(eventPath),
        model,
        effort
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
