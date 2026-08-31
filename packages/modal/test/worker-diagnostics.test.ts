import { spawn } from "node:child_process";
import fs from "node:fs";

import { expect, it } from "vitest";

import { assertSanitizedModalCollectedFiles } from "../src/runner.js";
import { OperationalDispositionError } from "../src/terminal-disposition.js";
import {
  childExitFailureCause,
  createBoundedStderrTail,
  describeWorkerTermination,
  drainChildOutput,
  sanitizeWorkerDiagnosticMessage,
  workerDiagnosticLogPayload,
  workerTerminationStack,
  MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES,
  WORKER_COMMAND_FAILED_DIAGNOSTIC_CODE
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

it("emits no more bytes than its bound, wherever the cut lands in a multi-byte sequence", () => {
  // Decoding a byte slice that begins or ends inside a multi-byte sequence substitutes U+FFFD -- three bytes
  // -- for each orphaned byte, so cutting to `maxBytes` and decoding emitted up to `maxBytes + 2` keeping the
  // head and `maxBytes + 6` keeping the tail. `isGenericWorkerLifecycleLine` rejects a `message` over
  // MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES, and the collector then refuses the whole worker log, taking
  // status.json, result.json and the recovery lifecycle with it.
  for (const character of ["é", "€", "ก", "\u{1f600}"]) {
    for (const keep of ["head", "tail"] as const) {
      for (let maxBytes = 1; maxBytes <= 32; maxBytes += 1) {
        const bounded = sanitizeWorkerDiagnosticMessage(character.repeat(64), { maxBytes, keep });
        expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(maxBytes);
      }
    }
  }

  const tailCut = sanitizeWorkerDiagnosticMessage("€".repeat(400));
  expect(Buffer.byteLength(tailCut, "utf8")).toBeLessThanOrEqual(MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES);
  // Durable ledgers compare whole objects for duplicate conflicts, so the same input has to cut the same way.
  expect(sanitizeWorkerDiagnosticMessage("€".repeat(400))).toBe(tailCut);
});

it("drops a diagnostic the collected log grammar cannot carry, never the log itself", () => {
  expect(workerDiagnosticLogPayload([])).toBeUndefined();
  expect(workerDiagnosticLogPayload([{ code: "worker_command_failed", message: "the code alphabet is fixed" }])).toBe(
    undefined
  );

  const capped = workerDiagnosticLogPayload(
    Array.from({ length: 5 }, (_entry, index) => ({
      code: `WORKER_COMMAND_FAILED_${index}`,
      message: `reason ${index}`
    }))
  );
  expect(JSON.parse(Buffer.from(capped!, "base64url").toString("utf8"))).toEqual([
    { code: "WORKER_COMMAND_FAILED_0", message: "reason 0" },
    { code: "WORKER_COMMAND_FAILED_1", message: "reason 1" },
    { code: "WORKER_COMMAND_FAILED_2", message: "reason 2" }
  ]);

  // Three bounded messages still overrun the payload bound once JSON escaping doubles them, so entries go
  // before the line does.
  const escaped = workerDiagnosticLogPayload(
    Array.from({ length: 3 }, () => ({
      code: "WORKER_COMMAND_FAILED_WITH_A_LONG_CODE",
      message: '"'.repeat(MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES)
    }))
  );
  expect(escaped!.length).toBeLessThanOrEqual(8_192);
  expect((JSON.parse(Buffer.from(escaped!, "base64url").toString("utf8")) as unknown[]).length).toBeLessThan(3);
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
  // The label survives, and the whole composed reason fits one collected diagnostic message: the stderr
  // budget is reduced by the prefix rather than the prefix being cut off the tail-kept end.
  expect(cause.message).toMatch(/^workspace handoff exited 3: /u);
  expect(Buffer.byteLength(cause.message, "utf8")).toBeLessThanOrEqual(MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES);
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

it("carries a private worker child-exit reason into a line the collector keeps", async () => {
  // `worker.ts` composed this reason at every non-zero exit and threw it away: `appendGenericLog` takes a
  // lifecycle token and nothing else, so the collected evidence named no reason at all.
  const secret = "opaque-reference-token-value";
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.stderr.write("fatal: could not read Username for 'https://github.com': ${secret}\\n");` +
        `process.exitCode = 128;`
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const { drained, stderrTail } = drainChildOutput(child);
  const exitCode = await new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));
  await drained;

  const cause = childExitFailureCause("references sync", exitCode, stderrTail, [secret]);
  const payload = workerDiagnosticLogPayload(
    [{ code: WORKER_COMMAND_FAILED_DIAGNOSTIC_CODE, message: cause.message }],
    [secret]
  );

  expect(cause.message).toContain("references sync exited 128: fatal: could not read Username");
  expect(cause.message).toContain("<redacted>");
  expect(cause.message).not.toContain(secret);
  expect(payload).toBeDefined();
  expect(() =>
    assertSanitizedModalCollectedFiles(
      {
        "worker.log":
          "2026-01-01T00:00:00.000Z worker-started\n" +
          `2026-01-01T00:00:01.000Z eval-failure-diagnostics ${payload!}\n` +
          "2026-01-01T00:00:01.000Z operation-failed\n"
      },
      { generation: 1, attempt: 2 },
      [secret]
    )
  ).not.toThrow();
});

it("appends nothing to the private worker log outside the two collected productions", () => {
  // `worker.ts` reads its run id, config and volume root at module scope, so it cannot be imported here; the
  // grammar it writes is still the property that decides whether a pair keeps its collected files.
  const source = fs.readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");

  expect([...source.matchAll(/appendFile\(LOG_PATH,/gu)]).toHaveLength(2);
  expect(source).toContain("`${new Date().toISOString()} ${event}\\n`");
  expect(source).toContain("`${new Date().toISOString()} eval-failure-diagnostics ${payload}\\n`");
});
