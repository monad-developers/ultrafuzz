import fs from "node:fs";
import { pathToFileURL } from "node:url";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const PRODUCER_WORKFLOW_PATH = ".github/workflows/eval-benchmarks.yml";
const SUPPORTED_EVENTS = new Set(["pull_request", "push", "workflow_dispatch"]);

export function qualifyModalBenchmarkPublication(eventValue, jobsValue, repository) {
  const event = record(eventValue);
  const workflowRun = record(event.workflow_run);
  const eventName = string(workflowRun.event);

  if (
    workflowRun.conclusion !== "success" ||
    workflowRun.path !== PRODUCER_WORKFLOW_PATH ||
    record(workflowRun.head_repository).full_name !== repository ||
    !SUPPORTED_EVENTS.has(eventName)
  ) {
    return ineligible("the completed run is not an eligible trusted benchmark producer");
  }
  if (eventName === "push" && workflowRun.head_branch !== "main") {
    return ineligible("automatic push benchmarks are restricted to main");
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

  return {
    eligible: true,
    candidateCommit,
    benchmarkMode: eventName === "workflow_dispatch" ? "full" : "smoke",
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
  if (args.length !== 4) {
    throw new Error(
      "usage: qualify-modal-benchmark-publication.mjs <event.json> <jobs.json> <github-output> <repository>"
    );
  }
  const [eventPath, jobsPath, outputPath, repository] = args;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("repository must be an owner/name identifier");
  }
  const result = qualifyModalBenchmarkPublication(
    JSON.parse(fs.readFileSync(eventPath, "utf8")),
    JSON.parse(fs.readFileSync(jobsPath, "utf8")),
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
