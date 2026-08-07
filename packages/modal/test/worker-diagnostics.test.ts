import { spawn } from "node:child_process";

import { expect, it } from "vitest";

import { OperationalDispositionError } from "../src/terminal-disposition.js";
import {
  childExitFailureCause,
  createBoundedStderrTail,
  describeWorkerTermination,
  drainChildOutput,
  sanitizeWorkerDiagnosticMessage,
  workerTerminationStack
} from "../src/worker-diagnostics.js";

it("retains only the last bytes appended to a bounded stderr tail", () => {
  const tail = createBoundedStderrTail(16);
  tail.append(Buffer.from("A".repeat(64), "utf8"));
  tail.append(Buffer.from("BBBB", "utf8"));
  tail.append(Buffer.from("tail-end", "utf8"));

  expect(tail.sanitized()).toBe("AAAABBBBtail-end");
});

it("redacts caller-supplied secrets and control characters in a diagnostic message", () => {
  expect(
    sanitizeWorkerDiagnosticMessage("line one\nOPENAI_API_KEY=fixture-key\ttail ", {
      forbiddenSecretValues: ["fixture-key"]
    })
  ).toBe("line one OPENAI_API_KEY=<redacted> tail");
  expect(sanitizeWorkerDiagnosticMessage("abcdefghij", { maxBytes: 4, keep: "head" })).toBe("abcd");
  expect(sanitizeWorkerDiagnosticMessage("abcdefghij", { maxBytes: 4 })).toBe("ghij");
});

it("carries a bounded redacted stderr tail into the cause of a child that exits non-zero", async () => {
  const secret = "sk-ant-fixtureworkerstderr";
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        `process.stdout.write("provider response that must never be retained".repeat(500));`,
        `process.stderr.write("x".repeat(200000) + "\\n");`,
        `process.stderr.write("fatal: ENOBUFS while capturing ${secret}\\n");`,
        `process.exitCode = 3;`
      ].join("")
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const { drained, stderrTail } = drainChildOutput(child);
  const exitCode = await new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));
  await drained;

  const cause = childExitFailureCause("workspace handoff", exitCode, stderrTail);

  expect(cause.message).toContain("workspace handoff exited 3");
  expect(cause.message).toContain("fatal: ENOBUFS while capturing <redacted>");
  expect(cause.message).not.toContain(secret);
  expect(cause.message).not.toContain("provider response");
  expect(Buffer.byteLength(cause.message, "utf8")).toBeLessThan(1_100);
});

it("renders the whole cause chain without dumping error payload properties", () => {
  const enobufs = Object.assign(new Error("spawnSync git ENOBUFS"), {
    name: "SystemError",
    code: "ENOBUFS",
    stdout: `diff --git a/echidna ${"D".repeat(50_000)}`,
    stderr: "workspace patch payload",
    output: ["", "workspace patch payload"]
  });
  const disposition = new Error("worker operation failed", {
    cause: new Error("workspace-handoff exited 1: fatal: ENOBUFS", { cause: enobufs })
  });
  disposition.name = "OperationalDispositionError";

  const rendered = describeWorkerTermination(disposition);

  expect(rendered).toBe(
    "OperationalDispositionError: worker operation failed <- Error: workspace-handoff exited 1: fatal: ENOBUFS" +
      " <- SystemError (ENOBUFS): spawnSync git ENOBUFS"
  );
  expect(rendered).not.toContain("workspace patch payload");
  expect(rendered).not.toContain("D".repeat(64));
});

it("prints the reason the child gave, composed the way the worker composes it", async () => {
  const child = spawn(
    process.execPath,
    ["-e", `process.stderr.write("fatal: cannot handoff workspace\\n"); process.exitCode = 1;`],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const { drained, stderrTail } = drainChildOutput(child);
  const exitCode = await new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));
  await drained;

  const thrown = new OperationalDispositionError("sandbox-exited", {
    cause: childExitFailureCause("workspace handoff", exitCode, stderrTail)
  });

  expect(describeWorkerTermination(thrown)).toBe(
    "OperationalDispositionError: worker operation failed <- Error: workspace handoff exited 1: fatal: cannot handoff workspace"
  );
});

it("describes non-Error rejections and self-referencing cause chains", () => {
  expect(describeWorkerTermination("worker terminated by string")).toBe("worker terminated by string");
  const looping = new Error("loop");
  looping.cause = looping;
  expect(describeWorkerTermination(looping)).toBe("Error: loop");
});

it("names an empty rejection rather than printing a bare prefix", () => {
  expect(describeWorkerTermination(undefined)).toBe("undefined");
  expect(describeWorkerTermination(null)).toBe("null");
  expect(describeWorkerTermination(new Error(""))).toBe("Error:");
});

it("locates an unanticipated failure by its own stack frames", () => {
  let unanticipated: unknown;
  try {
    (undefined as unknown as { missingHandler: () => void }).missingHandler();
  } catch (error) {
    unanticipated = error;
  }

  // The message alone names no file and no line, which is the complaint in #307.
  expect(describeWorkerTermination(unanticipated)).not.toContain("worker-diagnostics.test.ts");
  const stack = workerTerminationStack(unanticipated);
  expect(stack).toBeDefined();
  expect(stack).toContain("worker-diagnostics.test.ts");
  expect(stack).not.toContain("\n");
  expect(Buffer.byteLength(stack!, "utf8")).toBeLessThanOrEqual(2_000);
});

it("takes stack frames from the plain string, never from the error's payload properties", () => {
  const enobufs = Object.assign(new Error("spawnSync git ENOBUFS"), {
    name: "SystemError",
    code: "ENOBUFS",
    stdout: `diff --git a/echidna ${"D".repeat(50_000)}`,
    stderr: "workspace patch payload",
    output: ["", "workspace patch payload"]
  });

  const stack = workerTerminationStack(enobufs);

  expect(stack).toBeDefined();
  expect(stack).not.toContain("workspace patch payload");
  expect(stack).not.toContain("D".repeat(64));
  expect(workerTerminationStack("not an error")).toBeUndefined();
  expect(workerTerminationStack(Object.assign(new Error("no frames"), { stack: "Error: no frames" }))).toBeUndefined();
});
