import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SMITHERS_COMPATIBILITY_PATCHES } from "../src/smithers.js";
import { patchedSmithersRunner } from "./patched-smithers-runner.js";
import { temporaryRoot } from "./temporary-root.js";

interface Inspection {
  status?: string;
  run?: { status?: string };
  steps?: Array<{ id?: string; nodeId?: string; state?: string }>;
}

const SKIPPED_BEHIND_PRODUCER = {
  "prepare:producer": "finished",
  "node:producer": "failed",
  "verify:producer": "skipped",
  "prepare:consumer": "skipped",
  "node:consumer": "skipped",
  "verify:consumer": "skipped",
  "prepare:downstream": "skipped",
  "node:downstream": "skipped",
  "verify:downstream": "skipped"
};

// The task each campaign runs beside the triplets.
const SIDE_TASKS = {
  // Finished work that a resume must not run again.
  independent: `<Task id="independent" output={outputs.result} retries={0}>
      {() => (record("independent"), { value: "independent" })}
    </Task>`,
  // Runnable in the same pass that skips the failed agent's verifier, so that
  // pass also dispatches it. Its first attempt fails retryably, and upstream
  // answers a retryable failure with a new decision but no render.
  sibling: `<Task id="sibling" output={outputs.result} dependsOn={["node:producer"]} retries={1}>
      {() => {
        record("sibling");
        if (exists("sibling-failed")) return { value: "sibling" };
        fs.writeFileSync(path.join(root, "sibling-failed"), "");
        throw new Error("synthetic transient failure");
      }}
    </Task>`
};

test("a failed agent's skip cascade reaches every descendant without executing one", async () => {
  const campaign = startCampaign("ufz-skip-cascade-");
  assert.deepEqual(await campaign.waitForTerminalStates(), { ...SKIPPED_BEHIND_PRODUCER, independent: "finished" });
  assert.deepEqual(campaign.executed().sort(), ["independent", "node:producer", "prepare:producer"]);
});

test("a skip that shares its pass with dispatched work still reaches every descendant", async () => {
  const campaign = startCampaign("ufz-skip-shared-pass-", "sibling");
  assert.deepEqual(await campaign.waitForTerminalStates(), { ...SKIPPED_BEHIND_PRODUCER, sibling: "finished" });
  assert.deepEqual(campaign.executed().sort(), ["node:producer", "prepare:producer", "sibling", "sibling"]);
});

test("a resumed session reopens skipped descendants only once --retry-failed resets their producer", async () => {
  const campaign = startCampaign("ufz-resume-reopen-");
  const firstPass = await campaign.waitForTerminalStates();
  const executedBeforeResume = campaign.executed();

  // A plain resume leaves the producer failed, so every skip still holds:
  // neither the failed agent's verifier nor any descendant may run.
  campaign.resume();
  assert.deepEqual(await campaign.waitForTerminalStates(), firstPass);
  assert.deepEqual(campaign.executed(), executedBeforeResume);

  // What `resume --retry-failed` does for a failed non-verifier node: reset
  // only that node, then resume.
  fs.writeFileSync(path.join(campaign.root, "producer-may-succeed"), "");
  for (const [nodeId, state] of Object.entries(firstPass)) {
    if (state === "failed" || state === "stalled") campaign.resetNode(nodeId);
  }
  campaign.resume();
  const recovered = await campaign.waitForTerminalStates();
  assert.deepEqual(
    Object.keys(recovered).filter((nodeId) => recovered[nodeId] !== "finished"),
    [],
    JSON.stringify(recovered)
  );
  // The finished preparation and the independent task keep their outputs.
  assert.deepEqual(campaign.executed().slice(executedBeforeResume.length).sort(), [
    "node:consumer",
    "node:downstream",
    "node:producer",
    "prepare:consumer",
    "prepare:downstream",
    "verify:consumer",
    "verify:downstream",
    "verify:producer"
  ]);
});

let sharedRunner: string | undefined;

function startCampaign(prefix: string, sideTask: keyof typeof SIDE_TASKS = "independent") {
  const root = temporaryRoot(prefix);
  // Ultrafuzz's scheduler patches and resume hydration together decide what a resumed session runs again.
  const runner = (sharedRunner ??= patchedSmithersRunner(
    temporaryRoot("ufz-patched-smithers-"),
    SMITHERS_COMPATIBILITY_PATCHES.filter(
      (patch) => patch.packageName === "@smthrs/scheduler" || patch.id === "resume_hydration"
    )
  ));
  const runId = `${path.basename(root)}-${process.pid}`;
  const workflow = path.join(root, ".smithers", "workflows", "reopen.tsx");
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  fs.symlinkSync(path.dirname(runner), path.join(root, ".smithers", "node_modules"), "dir");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  fs.writeFileSync(workflow, syntheticWorkflowSource(root, SIDE_TASKS[sideTask]));
  const smithers = (args: string[]): string =>
    execFileSync("bun", [path.join(runner, "src", "bin", "smithers.js"), ...args, "--format", "json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SMITHERS_POST_FAILURE: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
  smithers(["up", workflow, "--detach", "--run-id", runId, "--root", root, "--input", "{}"]);
  const executedLog = path.join(root, "executed.log");
  return {
    root,
    resume: () => smithers(["up", workflow, "--resume", runId, "--run-id", runId, "--force", "--detach"]),
    resetNode: (nodeId: string) =>
      smithers(["timetravel", workflow, "--run-id", runId, "--node-id", nodeId, "--no-deps", "--force"]),
    executed: (): string[] =>
      fs.existsSync(executedLog) ? fs.readFileSync(executedLog, "utf8").trim().split("\n") : [],
    waitForTerminalStates: async (): Promise<Record<string, string | undefined>> => {
      let inspected: Inspection = {};
      for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
        inspected = JSON.parse(smithers(["inspect", runId])) as Inspection;
        const status = inspected.status ?? inspected.run?.status;
        if (status === "finished" || status === "failed" || status === "cancelled") {
          assert.equal(status, "finished", JSON.stringify(inspected));
          return Object.fromEntries(
            [...Object.keys(SKIPPED_BEHIND_PRODUCER), sideTask].map((nodeId) => [
              nodeId,
              inspected.steps?.find((step) => (step.id ?? step.nodeId) === nodeId)?.state
            ])
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`workflow did not finish: ${JSON.stringify(inspected)}`);
    }
  };
}

// A producer -> consumer -> downstream chain of generated prepare/node/verify
// triplets, skipped with the generated workflow's own predicates. The
// producer's agent fails until `producer-may-succeed` exists, and preparation
// refuses an input that was never verified, as dependency admission does.
function syntheticWorkflowSource(root: string, sideTask: string): string {
  const template = fs.readFileSync(
    path.join(runtimePackageRoot(), "src", "templates", "smithers", "workflows", "workflow.tsx"),
    "utf8"
  );
  const start = template.indexOf("type WorkflowTaskStateContext =");
  const end = template.indexOf("const agentPromptTemplate =", start);
  assert.ok(start >= 0 && end > start);
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import path from "node:path";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
${template.slice(start, end)}
const root = ${JSON.stringify(root)};
const record = (nodeId: string) => fs.appendFileSync(path.join(root, "executed.log"), nodeId + "\\n");
const exists = (name: string) => fs.existsSync(path.join(root, name));
const { Workflow, Parallel, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  result: z.object({ value: z.string() })
});
export default smithers((ctx) => {
  // The skip rules the generated render loop gives one attempt's triplet.
  const triplet = (id: string, requires: string[]) => {
    const verifiers = requires.map((producer) => "verify:" + producer);
    const failedDependencies = failedWorkflowPrerequisites(ctx, verifiers);
    const failedPreparation = failedWorkflowPrerequisites(ctx, ["prepare:" + id]);
    const failedAgent = failedWorkflowPrerequisites(ctx, ["node:" + id]);
    return [
      <Task key={"prepare:" + id} id={"prepare:" + id} output={outputs.result} dependsOn={verifiers}
        skipIf={shouldSkipWorkflowTask(ctx, "prepare:" + id, failedDependencies)} continueOnFail retries={0}>
        {() => {
          record("prepare:" + id);
          for (const producer of requires) {
            if (!exists("verified-" + producer)) throw new Error("input " + producer + " was never verified");
          }
          return { value: id };
        }}
      </Task>,
      <Task key={"node:" + id} id={"node:" + id} output={outputs.result} dependsOn={["prepare:" + id]}
        skipIf={shouldSkipWorkflowTask(ctx, "node:" + id, [...failedDependencies, ...failedPreparation])}
        continueOnFail retries={0}>
        {() => {
          record("node:" + id);
          if (id === "producer" && !exists("producer-may-succeed")) throw new Error("synthetic agent failure");
          fs.writeFileSync(path.join(root, "produced-" + id), "");
          return { value: id };
        }}
      </Task>,
      <Task key={"verify:" + id} id={"verify:" + id} output={outputs.result} dependsOn={["node:" + id]}
        skipIf={shouldSkipWorkflowTask(ctx, "verify:" + id, [...failedDependencies, ...failedPreparation, ...failedAgent])}
        continueOnFail retries={0}>
        {() => {
          record("verify:" + id);
          if (!exists("produced-" + id)) throw new Error("agent task did not succeed");
          fs.writeFileSync(path.join(root, "verified-" + id), "");
          return { value: id };
        }}
      </Task>
    ];
  };
  return <Workflow name="reopen"><Parallel>
    {triplet("producer", [])}
    {triplet("consumer", ["producer"])}
    {triplet("downstream", ["consumer"])}
    ${sideTask}
  </Parallel></Workflow>;
});
`;
}

function runtimePackageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (directory !== path.dirname(directory)) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) {
      const metadata = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string };
      if (metadata.name === "@ultrafuzz/runtime") return directory;
    }
    directory = path.dirname(directory);
  }
  throw new Error("runtime package root not found");
}
