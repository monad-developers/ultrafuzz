import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), "target-e2e-ci.ts");
const fakeRunnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "fake-target-e2e-smithers.sh");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("target E2E inspect health", () => {
  it("rejects terminal and non-progressing workflow states", () => {
    for (const status of ["timed-out", "timed_out", "blocked", "stalled", "paused"]) {
      const result = runInspectEnvelope({
        ok: true,
        diagnostics: [],
        data: { status: "running", workflow: { status } }
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("run is not healthy");
    }
  });

  it("accepts a running workflow without blocking diagnostics", () => {
    const result = runInspectEnvelope({
      ok: true,
      diagnostics: [],
      data: { status: "running", workflow: { status: "running" } }
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("target E2E bounded submission evidence", () => {
  it("accepts internally consistent run and fake-runner evidence", () => {
    const result = runSubmissionFixture();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects evidence whose state fingerprints disagree with the run result", () => {
    const result = runSubmissionFixture((files) => {
      files.state.config_fingerprint = "different-config";
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fingerprints do not match");
  });

  it("rejects a fake-runner invocation for a different workflow", () => {
    const result = runSubmissionFixture((files) => {
      files.fakeRunner.run_id = "ultrafuzz-some-other-run";
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fake workflow-runner evidence is incomplete or inconsistent");
  });
});

describe("target E2E fake workflow runner", () => {
  it("accepts only a detached, supervised submission and records bounded evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "ultrafuzz-target-e2e-fake-runner-"));
    temporaryRoots.push(root);
    const workflowPath = join(root, "workflow.tsx");
    const logDir = join(root, "logs");
    const logPath = join(root, "invocation.json");
    mkdirSync(logDir);
    writeFileSync(workflowPath, "export default {};\n", "utf-8");

    const result = spawnSync(
      "bash",
      [
        fakeRunnerPath,
        "up",
        workflowPath,
        "--detach",
        "--run-id",
        "ultrafuzz-e2e-test",
        "--max-concurrency",
        "4",
        "--root",
        root,
        "--log-dir",
        logDir,
        "--input",
        JSON.stringify({ run_id: "e2e-test", tasks: [{ id: "task-1" }] }),
        "--format",
        "json",
        "--supervise",
        "--supervise-interval",
        "10s",
        "--supervise-stale-threshold",
        "30s",
        "--supervise-max-concurrent",
        "1"
      ],
      { encoding: "utf-8", env: { ...process.env, SMITHERS_FAKE_LOG: logPath } }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, smithers: "accepted" });
    expect(JSON.parse(readFileSync(logPath, "utf-8"))).toMatchObject({
      schema_version: "ultrafuzz.target-e2e.submission.v1",
      run_id: "ultrafuzz-e2e-test",
      input_run_id: "e2e-test",
      task_count: 1,
      detached: true,
      supervised: true
    });
  });

  it("rejects an execution-capable invocation that is not detached", () => {
    const root = mkdtempSync(join(tmpdir(), "ultrafuzz-target-e2e-fake-runner-reject-"));
    temporaryRoots.push(root);
    const workflowPath = join(root, "workflow.tsx");
    writeFileSync(workflowPath, "export default {};\n", "utf-8");

    const result = spawnSync("bash", [fakeRunnerPath, "up", workflowPath, "--format", "json"], {
      encoding: "utf-8"
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("submission must use --detach");
  });
});

function runInspectEnvelope(envelope: unknown) {
  const root = mkdtempSync(join(tmpdir(), "ultrafuzz-target-e2e-inspect-"));
  temporaryRoots.push(root);
  const path = join(root, "inspect.json");
  writeFileSync(path, `${JSON.stringify(envelope)}\n`, "utf-8");
  return spawnSync(process.execPath, [helperPath, "assert-inspect-healthy", path], { encoding: "utf-8" });
}

function runSubmissionFixture(edit?: (files: Record<string, Record<string, unknown>>) => void) {
  const root = mkdtempSync(join(tmpdir(), "ultrafuzz-target-e2e-submission-"));
  temporaryRoots.push(root);
  const expectedRunId = "e2e-test";
  const expectedWorkflowId = `ultrafuzz-${expectedRunId}`;
  const files: Record<string, Record<string, unknown>> = {
    envelope: {
      ok: true,
      data: {
        run_id: expectedRunId,
        status: "running",
        graph_fingerprint: "graph-fingerprint",
        config_fingerprint: "config-fingerprint",
        workflow_ids: [expectedWorkflowId]
      }
    },
    state: {
      run_id: expectedRunId,
      status: "running",
      graph_fingerprint: "graph-fingerprint",
      config_fingerprint: "config-fingerprint",
      provenance: { workflow: { runId: expectedWorkflowId } }
    },
    metadata: {
      run_id: expectedRunId,
      workflow_ids: [expectedWorkflowId],
      workflow: { run_id: expectedWorkflowId }
    },
    submission: {
      smithers_run_id: expectedWorkflowId,
      command: [
        "smithers",
        "up",
        "/tmp/compiled-workflow.tsx",
        "--detach",
        "--run-id",
        expectedWorkflowId,
        "--max-concurrency",
        "4",
        "--root",
        "/tmp/target",
        "--log-dir",
        "/tmp/logs",
        "--input",
        "<redacted>",
        "--format",
        "json",
        "--supervise",
        "--supervise-interval",
        "10s",
        "--supervise-stale-threshold",
        "30s",
        "--supervise-max-concurrent",
        "1"
      ]
    },
    fakeRunner: {
      schema_version: "ultrafuzz.target-e2e.submission.v1",
      command: "up",
      workflow_path: "/tmp/compiled-workflow.tsx",
      run_id: expectedWorkflowId,
      max_concurrency: 4,
      project_root: "/tmp/target",
      format: "json",
      detached: true,
      supervised: true,
      supervise_max_concurrent: 1,
      input_run_id: expectedRunId,
      task_count: 37
    }
  };
  edit?.(files);

  const paths = Object.fromEntries(
    Object.entries(files).map(([name, body]) => {
      const path = join(root, `${name}.json`);
      writeFileSync(path, `${JSON.stringify(body)}\n`, "utf-8");
      return [name, path];
    })
  );
  return spawnSync(
    process.execPath,
    [
      helperPath,
      "assert-run-submission",
      paths.envelope as string,
      paths.state as string,
      paths.metadata as string,
      paths.submission as string,
      paths.fakeRunner as string,
      expectedRunId
    ],
    { encoding: "utf-8" }
  );
}
