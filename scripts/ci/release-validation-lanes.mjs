/**
 * Release validation lane table.
 *
 * `.github/workflows/ci.yml` expands this table into its release-validation
 * matrix on every event, pull requests included. While lanes were gated off
 * pull requests, every skipped suite reported `skipping` and its regressions
 * merged with all checks green, then failed on main.
 */

/** @typedef {{ lane: string, description: string, gates: string, timeout_minutes: number, build_modal_dependencies?: boolean, build_release_reporter?: boolean, build_cli?: boolean }} ReleaseValidationLane */

/** @type {readonly ReleaseValidationLane[]} */
export const RELEASE_VALIDATION_LANES = Object.freeze([
  {
    lane: "package-gates",
    description: "Package, dependency, and policy gates",
    gates:
      "dependency-advisories,ci-scripts,docs,config,audit-profile-package,packed-install,security,references,topology,prompts,artifacts,dashboard,evals,evmbench,modal",
    timeout_minutes: 45,
    build_modal_dependencies: true
  },
  {
    lane: "runtime-supporting",
    description: "Node.js 24 runtime support tests and Bun 1.3.14 adapter contracts",
    gates: "runtime-supporting",
    // The subprocess-heavy lifecycle suite can exceed 75 minutes under
    // shared-runner contention, so retain a bounded budget that covers the
    // full fail-closed validation instead of canceling it late.
    timeout_minutes: 120
  },
  {
    lane: "runtime-1",
    description: "Node.js 24 runtime integration tests, shard 1/4",
    gates: "runtime-1",
    // A slow hosted runner passed 59 of shard 4's 67 tests before the old
    // 75-minute cutoff. Give every shard the same bounded completion budget.
    timeout_minutes: 120
  },
  {
    lane: "runtime-2",
    description: "Node.js 24 runtime integration tests, shard 2/4",
    gates: "runtime-2",
    timeout_minutes: 120
  },
  {
    lane: "runtime-3",
    description: "Node.js 24 runtime integration tests, shard 3/4",
    gates: "runtime-3",
    timeout_minutes: 120
  },
  {
    lane: "runtime-4",
    description: "Node.js 24 runtime integration tests, shard 4/4",
    gates: "runtime-4",
    timeout_minutes: 120
  },
  {
    lane: "cli",
    description: "CLI package tests",
    gates: "cli",
    // The complete local CLI suite took 76 minutes before job setup overhead.
    timeout_minutes: 120,
    build_release_reporter: true
  },
  {
    lane: "cli-e2e",
    description: "End-to-end campaign with controller kill and resume on the pinned engine",
    gates: "cli-e2e",
    timeout_minutes: 60,
    build_release_reporter: true
  },
  {
    lane: "benchmark-history-typecheck",
    description: "Benchmark history charts and workspace typecheck",
    gates: "benchmark-history,workspace-typecheck",
    timeout_minutes: 45,
    build_release_reporter: true,
    build_cli: true
  }
]);

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(RELEASE_VALIDATION_LANES)}\n`);
}
