import fs from "node:fs";
import { pathToFileURL } from "node:url";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const PRODUCER_WORKFLOW_PATH = ".github/workflows/eval-benchmarks.yml";
const SUPPORTED_EVENTS = new Set(["push", "workflow_dispatch"]);
// Longitudinal publication is artifact-derived and deliberately allowlisted.
// The production-topology threat-model release gate is not a comparable history row.
const KNOWN_BENCHMARK_MODES = ["smoke", "full", "threat-model"];
const PUBLISHABLE_BENCHMARK_MODES = new Set(["smoke", "full"]);
const REQUIRED_ARTIFACT_PREFIXES = ["modal-benchmark-launch", "public-benchmark-results"];

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
  const jobs = jobRecords(jobsValue);
  const requiredJobs = {};
  for (const requiredJob of ["launch", "collect"]) {
    const matching = jobs.filter((job) => job.name === requiredJob);
    if (matching.length !== 1 || matching[0]?.conclusion !== "success") {
      return ineligible(`the ${requiredJob} job did not complete successfully`);
    }
    requiredJobs[requiredJob] = matching[0];
  }

  const candidateCommit = FULL_COMMIT.test(workflowRun.head_sha) ? workflowRun.head_sha : undefined;
  if (!candidateCommit) {
    return ineligible("the exact benchmark candidate commit could not be established");
  }
  const benchmarkMode = benchmarkModeFromArtifacts(artifactsValue, workflowRun);
  if (!benchmarkMode) {
    return ineligible("the completed producer attempt does not have one unambiguous benchmark artifact lane");
  }

  return {
    eligible: true,
    candidateCommit,
    benchmarkMode,
    reason: "the exact launch and collect jobs completed successfully"
  };
}

function benchmarkModeFromArtifacts(value, workflowRun) {
  const runId = positiveInteger(workflowRun.id);
  const runAttempt = positiveInteger(workflowRun.run_attempt);
  if (!runId || !runAttempt) return undefined;

  const artifacts = artifactRecords(value);
  const observedNames = new Set(artifacts.map((artifact) => string(artifact.name)));
  const availableNames = new Set(
    artifacts.filter((artifact) => artifact.expired === false).map((artifact) => string(artifact.name))
  );
  const observedModes = KNOWN_BENCHMARK_MODES.filter((mode) =>
    REQUIRED_ARTIFACT_PREFIXES.some((prefix) => observedNames.has(`${prefix}-${mode}-${runId}-${runAttempt}`))
  );
  if (observedModes.length !== 1) return undefined;
  const mode = observedModes[0];
  if (!PUBLISHABLE_BENCHMARK_MODES.has(mode)) return undefined;
  return REQUIRED_ARTIFACT_PREFIXES.every((prefix) => availableNames.has(`${prefix}-${mode}-${runId}-${runAttempt}`))
    ? mode
    : undefined;
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
  const eventValue = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const artifactsValue = artifactsPath
    ? JSON.parse(fs.readFileSync(artifactsPath, "utf8"))
    : await fetchProducerArtifacts(eventValue, repository);
  const result = qualifyModalBenchmarkPublication(
    eventValue,
    JSON.parse(fs.readFileSync(jobsPath, "utf8")),
    artifactsValue,
    repository
  );
  const outputs = [`eligible=${String(result.eligible)}`];
  if (result.eligible) {
    outputs.push(`candidate_commit=${result.candidateCommit}`, `benchmark_mode=${result.benchmarkMode}`);
  }
  fs.appendFileSync(outputPath, `${outputs.join("\n")}\n`);
  console.log(result.reason);
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
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
