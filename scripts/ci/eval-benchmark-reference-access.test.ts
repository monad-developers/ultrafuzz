import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

/**
 * Static guards on the private-reference credential wiring in `Modal Eval Benchmarks`.
 *
 * The properties asserted here are all *orderings and gates*, not behaviors a unit test can reach:
 * whether access is proven before an image is built, whether a relaunch is refused when it is not,
 * and whether the trusted-event boundary that keeps fork code away from the App private key is still
 * intact. Every one of them is a single-line edit away from silently regressing -- moving a step,
 * dropping an `if`, adding a trigger -- and none of them would fail any other test in this repository.
 */
const WORKFLOW = path.join(import.meta.dir, "..", "..", ".github", "workflows", "eval-benchmarks.yml");
const DATABASE_REPO_NAME = "web3-vulnerability-database";
const MINT_ACTION = "actions/create-github-app-token";
const PREFLIGHT = "scripts/ci/preflight-reference-access.mjs";

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, string | boolean>;
  env?: Record<string, string>;
}

const workflow = parse(fs.readFileSync(WORKFLOW, "utf8")) as {
  on: Record<string, unknown>;
  env: Record<string, string>;
  jobs: Record<string, { steps: WorkflowStep[] }>;
};

function steps(job: string): WorkflowStep[] {
  const found = workflow.jobs[job];
  expect(found, `job ${job} must exist`).toBeDefined();
  return found!.steps;
}

function indexOfStep(job: string, predicate: (step: WorkflowStep) => boolean, label: string): number {
  const at = steps(job).findIndex(predicate);
  expect(at, `${job} must have a step: ${label}`).toBeGreaterThanOrEqual(0);
  return at;
}

function stepAt(job: string, predicate: (step: WorkflowStep) => boolean, label: string): WorkflowStep {
  return steps(job)[indexOfStep(job, predicate, label)]!;
}

const mintStep = (step: WorkflowStep) => step.uses?.startsWith(MINT_ACTION) === true;
const preflightStep = (step: WorkflowStep) => step.run?.includes(PREFLIGHT) === true;
const namedStep = (name: string) => (step: WorkflowStep) => step.name === name;
const waitStep = (step: WorkflowStep) => step.name?.startsWith("Wait for Modal compute") === true;

describe("Modal Eval Benchmarks private-reference credential wiring", () => {
  it("keeps the App private key behind the trusted-event boundary", () => {
    // A `pull_request`/`pull_request_target` trigger would expose repository secrets -- including the
    // App private key -- to code from a fork. Nothing else in this repo would catch that being added.
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    for (const forbidden of ["pull_request", "pull_request_target"]) {
      expect(Object.keys(workflow.on)).not.toContain(forbidden);
    }
  });

  it("declares the private reference allowlist once, at the workflow level", () => {
    // The allowlist is what stops the token being attached to any other remote, so both jobs must
    // inherit the same value rather than restating it.
    expect(workflow.env.ULTRAFUZZ_REFERENCE_GITHUB_REPOS).toBe(`monad-developers/${DATABASE_REPO_NAME}`);
  });

  it("mints a least-privilege, non-revoked token in every job that can start a sandbox", () => {
    // Both jobs must mint their own: an installation token expires an hour after creation, and
    // `collect` can wait far longer than the launch job's token stays valid.
    for (const job of ["launch", "collect"]) {
      const mint = stepAt(job, mintStep, "token mint");
      const inputs = mint.with ?? {};
      expect(inputs.repositories, job).toBe(DATABASE_REPO_NAME);
      expect(inputs["permission-contents"], job).toBe("read");
      // The sandboxes are detached and fetch the reference after the job ends, so a post-job
      // revocation would invalidate a credential the worker still needs.
      expect(inputs["skip-token-revoke"], job).toBe(true);
      expect(String(inputs["private-key"]), job).toContain("secrets.EVAL_HISTORY_APP_PRIVATE_KEY");
      // Pinned by SHA, like every other action in this workflow.
      expect(mint.uses, job).toMatch(/@[0-9a-f]{40}$/u);
    }
  });

  it("proves access before the image build and before any launch in the launch job", () => {
    const mint = indexOfStep("launch", mintStep, "token mint");
    const preflight = indexOfStep("launch", preflightStep, "reference preflight");
    const build = indexOfStep("launch", (step) => step.run?.includes("cli.js build") === true, "image build");
    const launch = indexOfStep("launch", (step) => step.run?.includes("cli.js launch") === true, "sandbox launch");

    // The whole point of the preflight is that it costs nothing, so it must precede the two steps
    // that do cost something. A reordering here would restore paid pre-model failures.
    expect(mint).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(build);
    expect(preflight).toBeLessThan(launch);

    // The launch job's preflight must fail hard: there is no already-running work to protect, so a
    // soft failure would let the image build and launch proceed without proven access.
    expect(steps("launch")[preflight]!["continue-on-error"]).toBeUndefined();
    // And the mint must fail soft, so the preflight is what reports the diagnosis rather than the
    // action's bare `Not Found`.
    expect(steps("launch")[mint]!["continue-on-error"]).toBe(true);

    const proof = steps("launch")[preflight]!;
    const launchStep = steps("launch")[launch]!;
    expect(proof.run).toContain("usable_until_epoch=$((proven_at_epoch + 1800))");
    expect(launchStep.env?.REFERENCE_ACCESS_PROVEN_UNTIL_EPOCH).toBe(
      "${{ steps.reference-preflight.outputs.usable_until_epoch }}"
    );
    expect(launchStep.run).toContain('! [[ "$REFERENCE_ACCESS_PROVEN_UNTIL_EPOCH" =~ ^[0-9]+$ ]]');
    expect(launchStep.run).toContain("reference-access-unproven");
  });

  it("pairs the collect mint with a fail-soft recorded preflight before the wait step", () => {
    const mint = indexOfStep("collect", mintStep, "token mint");
    const preflight = indexOfStep("collect", preflightStep, "reference preflight");
    const wait = indexOfStep("collect", waitStep, "wait step");

    expect(mint).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(wait);

    const step = steps("collect")[preflight]!;
    // Soft, because unproven access to a future relaunch must not abandon sandboxes already running.
    expect(step["continue-on-error"]).toBe(true);
    expect(step.if).toBe("steps.launch_control.outputs.available == 'true'");
    expect(steps("collect")[mint]!["continue-on-error"]).toBe(true);
    // Recorded, because the wait step consumes only the outcome; the prerequisite text must survive
    // into the uploaded diagnostics.
    expect(step.run).toContain("reference-access-preflight.json");
    expect(step.run).toContain("reference-access-preflight.log");
    expect(step.run).toContain("usable_until_epoch=$((proven_at_epoch + 1800))");
  });

  it("still waits and collects when reference access is unproven", () => {
    const wait = stepAt("collect", waitStep, "wait step");
    // Gated on launch control only -- never on the preflight. Work already in flight is collected
    // regardless, which is the whole reason the preflight fails soft.
    expect(wait.if).toBe("steps.launch_control.outputs.available == 'true'");
    expect(String(wait.if)).not.toContain("reference-preflight");

    for (const name of ["Collect and validate public finding bundles", "Upload launch state and failure diagnostics"]) {
      expect(String(stepAt("collect", namedStep(name), name).if), name).toContain("always()");
    }

    // The token is also the value the public-evidence scanner must reject. Omitting it here makes
    // the runner's forbidden-secret check inert even though the worker received the credential.
    const collection = stepAt("collect", namedStep("Collect and validate public finding bundles"), "public collection");
    expect(collection.env?.ULTRAFUZZ_REFERENCE_GITHUB_TOKEN).toBe("${{ steps.reference-token.outputs.token }}");
    expect(collection.env?.ULTRAFUZZ_REFERENCE_GITHUB_REPOS).toBe("${{ env.ULTRAFUZZ_REFERENCE_GITHUB_REPOS }}");
  });

  it("gates every recovery relaunch on proven access and records the exact category", () => {
    const wait = stepAt("collect", waitStep, "wait step");
    const script = String(wait.run);

    expect(wait.env?.REFERENCE_ACCESS_PROVEN).toBe("${{ steps.reference-preflight.outcome == 'success' }}");
    expect(wait.env?.REFERENCE_ACCESS_PROVEN_UNTIL_EPOCH).toBe(
      "${{ steps.reference-preflight.outputs.usable_until_epoch }}"
    );

    // Every relaunch in this script must sit behind the gate. Counting them is the adversarial part:
    // a newly added launch path that forgot the guard fails here instead of silently relaunching with
    // an empty token.
    const relaunches = script.match(/cli\.js launch/gu) ?? [];
    const guards = script.match(/\$REFERENCE_ACCESS_PROVEN" != true/gu) ?? [];
    const freshnessGuards =
      script.match(/! \[\[ "\$REFERENCE_ACCESS_PROVEN_UNTIL_EPOCH" =~ \^\[0-9\]\+\$ \]\]/gu) ?? [];
    expect(relaunches.length).toBeGreaterThan(0);
    expect(guards.length).toBe(relaunches.length);
    expect(freshnessGuards.length).toBe(relaunches.length);
    expect(script.match(/date \+%s/gu)?.length).toBe(relaunches.length);

    expect(script).toContain("reference-access-unproven");
    // The refusal must be terminal for the pair, so the incomplete-matrix gate fails the job rather
    // than the run appearing to succeed with a silently skipped pair.
    expect(script).toMatch(/terminal_status: "failed", category: \$category/u);
  });

  it("does not sleep-loop after a terminal reference-access refusal", () => {
    const script = String(stepAt("collect", waitStep, "wait step").run);
    const transientCase = script.match(/transient-operational-failure\)(?<body>[\s\S]*?)\n[ \t]+\*\)/u)?.groups?.body;
    expect(transientCase).toBeDefined();

    const accessGate = transientCase!.indexOf('if [ "$REFERENCE_ACCESS_PROVEN" != true ]');
    const resumableBranch = transientCase!.indexOf("else", accessGate);
    expect(accessGate).toBeGreaterThanOrEqual(0);
    expect(resumableBranch).toBeGreaterThan(accessGate);

    // A terminal access refusal and a missing config both write an outcome immediately. Only the
    // branch that actually attempts a resume is nonterminal and may force another polling cycle.
    expect(transientCase!.slice(0, resumableBranch)).not.toContain("all_terminal=false");
    expect(transientCase!.slice(resumableBranch)).toContain("all_terminal=false");
  });

  it("fails the matrix rather than passing an incomplete one", () => {
    const gateName = "Fail an incomplete matrix after preserving artifacts";
    expect(String(stepAt("collect", namedStep(gateName), gateName).if)).toContain("always()");
    // Runs after the uploads, so a refusal still preserves its evidence.
    const uploads = indexOfStep(
      "collect",
      namedStep("Upload launch state and failure diagnostics"),
      "diagnostics upload"
    );
    expect(uploads).toBeLessThan(indexOfStep("collect", namedStep(gateName), gateName));
  });
});
