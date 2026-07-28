import fs from "node:fs";
import { pathToFileURL } from "node:url";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const PRODUCER_WORKFLOW_PATH = ".github/workflows/eval-benchmarks.yml";
const SUPPORTED_EVENTS = new Set(["push", "workflow_dispatch"]);

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
  for (const requiredJob of ["launch", "collect"]) {
    const matching = jobs.filter((job) => job.name === requiredJob);
    if (matching.length !== 1 || matching[0]?.conclusion !== "success") {
      return ineligible(`the ${requiredJob} job did not complete successfully`);
    }
  }

  const candidateCommit = FULL_COMMIT.test(workflowRun.head_sha) ? workflowRun.head_sha : undefined;
  if (!candidateCommit) {
    return ineligible("the exact benchmark candidate commit could not be established");
  }
  const runId = positiveIdentity(workflowRun.id);
  const runAttempt = positiveIdentity(workflowRun.run_attempt);
  if (runId === undefined || runAttempt === undefined) {
    return ineligible("the exact benchmark producer attempt identity could not be established");
  }
  const artifacts = artifactRecords(artifactsValue);
  const planPattern = new RegExp(
    `^modal-benchmark-plan-(smoke|full)-${escapeRegExp(runId)}-${escapeRegExp(runAttempt)}$`,
    "u"
  );
  const planArtifacts = artifacts.filter((artifact) => planPattern.test(string(artifact.name)));
  if (planArtifacts.length !== 1 || planArtifacts[0]?.expired !== false) {
    return ineligible("the exact immutable benchmark plan artifact does not identify one lane");
  }
  const benchmarkMode = string(planArtifacts[0].name).match(planPattern)?.[1];
  if (benchmarkMode !== "smoke" && benchmarkMode !== "full") {
    return ineligible("the exact immutable benchmark plan artifact has an invalid lane");
  }
  for (const name of [
    `modal-benchmark-plan-${benchmarkMode}-${runId}-${runAttempt}`,
    `modal-benchmark-launch-${benchmarkMode}-${runId}-${runAttempt}`,
    `public-benchmark-results-${benchmarkMode}-${runId}-${runAttempt}`
  ]) {
    if (matchingArtifacts(artifacts, name).length !== 1) {
      return ineligible(`the exact non-expired ${name} artifact is unavailable`);
    }
  }

  return {
    eligible: true,
    candidateCommit,
    benchmarkMode,
    reason: "the exact launch and collect jobs completed successfully"
  };
}

function jobRecords(value) {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page) => {
    const jobs = record(page).jobs;
    return Array.isArray(jobs) ? jobs.map(record) : [];
  });
}

function artifactRecords(value) {
  if (Array.isArray(value) && value.every((entry) => !Array.isArray(record(entry).artifacts))) {
    return value.map(record);
  }
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page) => {
    const artifacts = record(page).artifacts;
    return Array.isArray(artifacts) ? artifacts.map(record) : [];
  });
}

function matchingArtifacts(artifacts, name) {
  return artifacts.filter((artifact) => artifact.name === name && artifact.expired === false);
}

function positiveIdentity(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? value : undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function main(args) {
  if (args.length !== 5) {
    throw new Error(
      "usage: qualify-modal-benchmark-publication.mjs <event.json> <jobs.json> <artifacts.json> <github-output> <repository>"
    );
  }
  const [eventPath, jobsPath, artifactsPath, outputPath, repository] = args;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("repository must be an owner/name identifier");
  }
  const result = qualifyModalBenchmarkPublication(
    JSON.parse(fs.readFileSync(eventPath, "utf8")),
    JSON.parse(fs.readFileSync(jobsPath, "utf8")),
    JSON.parse(fs.readFileSync(artifactsPath, "utf8")),
    repository
  );
  const outputs = [`eligible=${String(result.eligible)}`];
  if (result.eligible) {
    outputs.push(`candidate_commit=${result.candidateCommit}`, `benchmark_mode=${result.benchmarkMode}`);
  }
  fs.appendFileSync(outputPath, `${outputs.join("\n")}\n`);
  console.log(result.reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
