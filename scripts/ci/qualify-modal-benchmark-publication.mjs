import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseStrictJsonBytes, readRegularFileSnapshot } from "../../packages/artifacts/dist/index.js";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const MAX_GITHUB_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_GITHUB_API_ENVELOPE_BYTES = 16 * 1024 * 1024;
const PRODUCER_WORKFLOW_PATH = ".github/workflows/eval-benchmarks.yml";
const SUPPORTED_EVENTS = new Set(["push", "workflow_dispatch"]);
// Longitudinal publication is artifact-derived and deliberately allowlisted.
// The production-topology threat-model release gate is not a comparable history row.
const KNOWN_BENCHMARK_MODES = ["smoke", "full", "threat-model"];
const PUBLISHABLE_BENCHMARK_MODES = new Set(["smoke", "full"]);
const REQUIRED_ARTIFACT_PREFIXES = ["modal-benchmark-launch", "modal-benchmark-control", "public-benchmark-results"];
const STALLED_HISTORY_NOTICE =
  "Published eval history does not advance until one complete Modal benchmark generation exists.";

export function qualifyModalBenchmarkPublication(eventValue, jobsValue, artifactsValue, repository) {
  const event = record(eventValue);
  const workflowRun = record(event.workflow_run);
  const eventName = string(workflowRun.event);
  const defaultBranch = string(record(event.repository).default_branch);

  if (
    workflowRun.conclusion !== "success" ||
    workflowRun.path !== PRODUCER_WORKFLOW_PATH ||
    record(workflowRun.head_repository).full_name !== repository ||
    defaultBranch === "" ||
    workflowRun.head_branch !== defaultBranch ||
    !SUPPORTED_EVENTS.has(eventName)
  ) {
    return ineligible("the completed run is not an eligible default-branch benchmark producer");
  }
  const lane = benchmarkLaneFromArtifacts(artifactsValue, workflowRun);
  if (lane.mode === undefined) {
    return ineligible("the completed producer attempt does not have one unambiguous benchmark artifact lane");
  }
  if (!lane.publishable) return nonLongitudinalLane(lane.mode);
  const benchmarkMode = lane.mode;
  const jobs = jobRecords(jobsValue);
  const requiredJobs = {};
  for (const requiredJob of ["launch", "collect"]) {
    const matching = jobs.filter((job) => job.name === requiredJob);
    if (matching.length !== 1 || matching[0]?.conclusion !== "success") {
      return ineligible(`the ${requiredJob} job did not complete successfully`);
    }
    requiredJobs[requiredJob] = matching[0];
  }
  const monitorJobs = jobs.filter((job) => job.name === "monitor_full");
  const expectedMonitorConclusion = benchmarkMode === "full" ? "success" : "skipped";
  if (monitorJobs.length !== 1 || monitorJobs[0]?.conclusion !== expectedMonitorConclusion) {
    return ineligible(`the full-lane monitor job did not have the expected ${expectedMonitorConclusion} conclusion`);
  }

  const candidateCommit = FULL_COMMIT.test(workflowRun.head_sha) ? workflowRun.head_sha : undefined;
  if (!candidateCommit) {
    return ineligible("the exact benchmark candidate commit could not be established");
  }
  return {
    eligible: true,
    candidateCommit,
    benchmarkMode,
    reason: "the exact launch, staged monitor, and collect topology completed successfully"
  };
}

// An absent mode means the observed artifacts never named exactly one lane. A
// present mode with `publishable: false` is a lane this workflow recognises and
// deliberately excludes, which is not the same refusal and must not be reported
// as one.
function benchmarkLaneFromArtifacts(value, workflowRun) {
  const runId = positiveInteger(workflowRun.id);
  const runAttempt = positiveInteger(workflowRun.run_attempt);
  if (!runId || !runAttempt) return {};

  const artifacts = artifactRecords(value);
  const observedNames = new Set(artifacts.map((artifact) => string(artifact.name)));
  const availableNames = new Set(
    artifacts.filter((artifact) => artifact.expired === false).map((artifact) => string(artifact.name))
  );
  const observedModes = KNOWN_BENCHMARK_MODES.filter((mode) =>
    REQUIRED_ARTIFACT_PREFIXES.some((prefix) => observedNames.has(`${prefix}-${mode}-${runId}-${runAttempt}`))
  );
  if (observedModes.length !== 1) return {};
  const mode = observedModes[0];
  if (!PUBLISHABLE_BENCHMARK_MODES.has(mode)) return { mode, publishable: false };
  return REQUIRED_ARTIFACT_PREFIXES.every((prefix) => availableNames.has(`${prefix}-${mode}-${runId}-${runAttempt}`))
    ? { mode, publishable: true }
    : {};
}

function jobRecords(value) {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page) => {
    const jobs = record(page).jobs;
    return Array.isArray(jobs) ? jobs.map(record) : [];
  });
}

function artifactRecords(value) {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page) => {
    const artifacts = record(page).artifacts;
    return Array.isArray(artifacts) ? artifacts.map(record) : [];
  });
}

function ineligible(reason) {
  return { eligible: false, reason };
}

function nonLongitudinalLane(mode) {
  return {
    eligible: false,
    nonLongitudinalLane: mode,
    reason: `the completed producer attempt ran the ${mode} lane, which by design never publishes a longitudinal eval history row`
  };
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(value) {
  return typeof value === "string" ? value : "";
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function main(args) {
  if (args.length !== 4 && args.length !== 5) {
    throw new Error(
      "usage: qualify-modal-benchmark-publication.mjs <event.json> <jobs.json> [artifacts.json] <github-output> <repository>"
    );
  }
  const [eventPath, jobsPath] = args;
  const artifactsPath = args.length === 5 ? args[2] : undefined;
  const outputPath = args.length === 5 ? args[3] : args[2];
  const repository = args.length === 5 ? args[4] : args[3];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("repository must be an owner/name identifier");
  }
  // GitHub owns these transient event/REST envelopes. They are not retained
  // Ultrafuzz evidence, so we strictly parse bounded bytes and project only the
  // fields needed for qualification instead of registering their dynamic whole shape.
  const eventValue = readGitHubEnvelope(eventPath, MAX_GITHUB_EVENT_BYTES, "GitHub workflow-run event");
  const artifactsValue = artifactsPath
    ? readGitHubEnvelope(artifactsPath, MAX_GITHUB_API_ENVELOPE_BYTES, "GitHub artifacts response")
    : await fetchProducerArtifacts(eventValue, repository);
  const result = qualifyModalBenchmarkPublication(
    eventValue,
    readGitHubEnvelope(jobsPath, MAX_GITHUB_API_ENVELOPE_BYTES, "GitHub jobs response"),
    artifactsValue,
    repository
  );
  const outputs = [`eligible=${String(result.eligible)}`];
  if (result.eligible) {
    outputs.push(`candidate_commit=${result.candidateCommit}`, `benchmark_mode=${result.benchmarkMode}`);
  } else {
    outputs.push(`skip_reason=${result.reason}`);
  }
  fs.appendFileSync(outputPath, `${outputs.join("\n")}\n`);
  console.log(result.reason);
  if (!result.eligible) announceSkippedPublication(result);
}

// An unqualified producer skips the whole publication job, so the refusal is
// only ever visible through the annotation and job summary written here. Every
// reason is composed from literals in this module, never GitHub-owned text, so
// no free-form value can forge a workflow command. A lane this workflow
// deliberately excludes was never a history candidate, so it is not a refusal
// and gets no annotation.
function announceSkippedPublication(result) {
  if (result.nonLongitudinalLane !== undefined) {
    appendStepSummary([
      `## Eval history publication not applicable (${result.nonLongitudinalLane} lane)`,
      "",
      `- Skipped: ${result.reason}`,
      "",
      "This producer attempt was never a longitudinal history candidate, so published history is unchanged."
    ]);
    return;
  }
  process.stdout.write(`::warning::eval history publication skipped: ${result.reason}; ${STALLED_HISTORY_NOTICE}\n`);
  appendStepSummary([
    "## Eval history publication skipped (unqualified producer attempt)",
    "",
    `- Refusal: ${result.reason}`,
    "",
    STALLED_HISTORY_NOTICE
  ]);
}

function appendStepSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === "") return;
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

async function fetchProducerArtifacts(eventValue, repository) {
  const runId = positiveInteger(record(record(eventValue).workflow_run).id);
  const token = process.env.GH_TOKEN;
  if (!runId || !token) {
    throw new Error("the producer artifact list requires a workflow run ID and GH_TOKEN");
  }
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );
  if (!response.ok) {
    throw new Error(`could not list producer artifacts: GitHub returned ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return parseGitHubEnvelopeBytes(bytes, MAX_GITHUB_API_ENVELOPE_BYTES, "GitHub artifacts response");
}

function readGitHubEnvelope(filePath, maxBytes, label) {
  let bytes;
  try {
    bytes = readRegularFileSnapshot(path.resolve(filePath), maxBytes);
  } catch (error) {
    throw new Error(`${label} must be a bounded regular file`, { cause: error });
  }
  return parseGitHubEnvelopeBytes(bytes, maxBytes, label);
}

function parseGitHubEnvelopeBytes(bytes, maxBytes, label) {
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds its byte limit`);
  try {
    return parseStrictJsonBytes(bytes, {
      maxBytes,
      maxDepth: 64,
      maxItems: 100_000,
      maxProperties: 100_000
    });
  } catch (error) {
    throw new Error(`${label} must be strict JSON`, { cause: error });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
