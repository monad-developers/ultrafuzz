/**
 * Release validation lane policy.
 *
 * `.github/workflows/ci.yml` used to hard-code its release-validation matrix and
 * gate the whole job on `github.event_name != 'pull_request'`. Every runtime test
 * therefore reported `skipping` on pull requests, so a change could break resume
 * and still merge with every check green. The lane table now lives here, in one
 * tested place, and each lane declares whether it is required on pull requests.
 *
 * Lanes marked `pull_request: true` must together execute the whole
 * `@ultrafuzz/runtime` test suite: `runtime-1`..`runtime-4` cover every test in
 * `packages/runtime/test/runtime.test.ts` (the shard splitter assigns each test
 * name to exactly one of the four shards) and `runtime-supporting` covers every
 * other runtime test file plus the Bun adapter contracts.
 */

/** @typedef {{ lane: string, description: string, gates: string, timeout_minutes: number, pull_request: boolean, build_modal_dependencies?: boolean, build_release_reporter?: boolean, build_cli?: boolean }} ReleaseValidationLane */

/** @type {readonly ReleaseValidationLane[]} */
export const RELEASE_VALIDATION_LANES = Object.freeze([
  {
    lane: "package-gates",
    description: "Package, dependency, and policy gates",
    gates:
      "dependency-advisories,ci-scripts,docs,config,audit-profile-package,packed-install,security,references,topology,prompts,artifacts,dashboard,evals,evmbench,modal",
    timeout_minutes: 45,
    pull_request: false,
    build_modal_dependencies: true
  },
  {
    lane: "runtime-supporting",
    description: "Node.js 24 runtime support tests and Bun 1.3.14 adapter contracts",
    gates: "runtime-supporting",
    // Once relocated cloud-worker tests run to completion, this lane also
    // reaches the subprocess-heavy lifecycle suite. Shared-runner contention
    // can push that complete pass beyond 75 minutes, so retain a bounded budget
    // that covers the full fail-closed validation instead of canceling it late.
    timeout_minutes: 120,
    pull_request: true,
    build_modal_dependencies: true
  },
  {
    lane: "runtime-1",
    description: "Node.js 24 runtime integration tests, shard 1/4",
    gates: "runtime-1",
    // A slow hosted runner passed 59 of shard 4's 67 tests before the old
    // 75-minute cutoff. Give every shard the same bounded completion budget.
    timeout_minutes: 120,
    pull_request: true,
    build_modal_dependencies: true
  },
  {
    lane: "runtime-2",
    description: "Node.js 24 runtime integration tests, shard 2/4",
    gates: "runtime-2",
    timeout_minutes: 120,
    pull_request: true,
    build_modal_dependencies: true
  },
  {
    lane: "runtime-3",
    description: "Node.js 24 runtime integration tests, shard 3/4",
    gates: "runtime-3",
    timeout_minutes: 120,
    pull_request: true,
    build_modal_dependencies: true
  },
  {
    lane: "runtime-4",
    description: "Node.js 24 runtime integration tests, shard 4/4",
    gates: "runtime-4",
    timeout_minutes: 120,
    pull_request: true,
    build_modal_dependencies: true
  },
  {
    lane: "cli",
    description: "CLI package tests",
    gates: "cli",
    // The complete local CLI suite took 76 minutes before job setup overhead.
    timeout_minutes: 120,
    pull_request: false,
    build_release_reporter: true
  },
  {
    lane: "benchmark-history-typecheck",
    description: "Benchmark history charts and workspace typecheck",
    gates: "benchmark-history,workspace-typecheck",
    timeout_minutes: 45,
    pull_request: false,
    build_release_reporter: true,
    build_cli: true
  }
]);

/**
 * Release validation gates that must run before a pull request can merge.
 * Together these execute every `@ultrafuzz/runtime` test, which is where run
 * resume, controller refresh, replay, and fork are covered.
 *
 * @type {readonly string[]}
 */
export const PULL_REQUEST_REQUIRED_GATES = Object.freeze([
  "runtime-supporting",
  "runtime-1",
  "runtime-2",
  "runtime-3",
  "runtime-4"
]);

/**
 * @param {string} eventName GitHub `github.event_name`.
 * @returns {ReleaseValidationLane[]} lanes to expand into the workflow matrix.
 */
export function selectReleaseValidationLanes(eventName) {
  if (typeof eventName !== "string" || eventName.length === 0) {
    throw new Error("release validation lane selection requires a GitHub event name");
  }
  const lanes =
    eventName === "pull_request"
      ? RELEASE_VALIDATION_LANES.filter((lane) => lane.pull_request)
      : [...RELEASE_VALIDATION_LANES];
  const selectedGates = new Set(lanes.flatMap((lane) => lane.gates.split(",")));
  const missing = PULL_REQUEST_REQUIRED_GATES.filter((gate) => !selectedGates.has(gate));
  if (missing.length > 0) {
    throw new Error(`release validation lanes omit required gates: ${missing.join(", ")}`);
  }
  return lanes.map((lane) => Object.fromEntries(Object.entries(lane).filter(([key]) => key !== "pull_request")));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const index = process.argv.indexOf("--event");
  const eventName = index === -1 ? undefined : process.argv[index + 1];
  if (eventName === undefined) throw new Error("release-validation-lanes.mjs requires --event <github.event_name>");
  process.stdout.write(`${JSON.stringify(selectReleaseValidationLanes(eventName))}\n`);
}
