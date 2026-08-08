import fs from "node:fs";
import { pathToFileURL } from "node:url";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const PRODUCER_WORKFLOW_PATH = ".github/workflows/eval-benchmarks.yml";
const SUPPORTED_EVENTS = new Set(["push", "workflow_dispatch"]);
/**
 * The producer declares its dispatched lane as a `launch` step name, because the
 * `workflow_run` payload carries no dispatch inputs. Reading a step name is the
 * same introspection the producer's own recovery job already performs.
 */
const LANE_STEP_PREFIX = "Benchmark lane ";
/**
 * Which lane each trigger is allowed to have produced. Publication is a
 * longitudinal claim about one comparable series, so a lane that is not in this
 * map -- notably the `threat-model` release gate, which runs the production
 * topology and a different execution policy against the same three targets --
 * is deliberately not published into `benchmarks/history.json`. The v0.1.0
 * release owner reviews that cohort directly (#183).
 */
const PUBLISHABLE_LANES = { push: "smoke", workflow_dispatch: "full" };

export function qualifyModalBenchmarkPublication(eventValue, jobsValue, repository) {
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

  const declaredLanes = stepNames(requiredJobs.launch)
    .filter((name) => name.startsWith(LANE_STEP_PREFIX))
    .map((name) => name.slice(LANE_STEP_PREFIX.length));
  if (declaredLanes.length !== 1) {
    return ineligible("the producer run did not declare exactly one benchmark lane");
  }
  const lane = declaredLanes[0];
  if (lane !== PUBLISHABLE_LANES[eventName]) {
    return ineligible(`the ${lane} lane produced by ${eventName} is not published to the longitudinal history`);
  }

  const candidateCommit = FULL_COMMIT.test(workflowRun.head_sha) ? workflowRun.head_sha : undefined;
  if (!candidateCommit) {
    return ineligible("the exact benchmark candidate commit could not be established");
  }

  return {
    eligible: true,
    candidateCommit,
    benchmarkMode: lane,
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

function stepNames(job) {
  const steps = record(job).steps;
  return Array.isArray(steps) ? steps.map((step) => string(record(step).name)) : [];
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
