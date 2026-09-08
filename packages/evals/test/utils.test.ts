import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertTargetRef, describeEvalError, EvalError } from "../src/utils.js";

describe("held-out benchmark target refs", () => {
  const gitTarget = (root: string): string => {
    fs.mkdirSync(root, { recursive: true });
    const run = (args: string[]): string =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    run(["init", "--quiet", "--initial-branch=ultrafuzz-pinned"]);
    run(["config", "user.name", "Ultrafuzz test"]);
    run(["config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(root, "src.txt"), "protocol\n");
    run(["add", "."]);
    run(["commit", "--quiet", "-m", "benchmark"]);
    return run(["rev-parse", "HEAD"]);
  };

  it("accepts a checkout whose hold-out revision was derived from the declared ref", () => {
    const root = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ultrafuzz-holdout-ref-"));
    const head = gitTarget(root);
    const benchmark = "b".repeat(40);
    const recordPath = path.join(root, ".git", "ultrafuzz-pinned-holdout.json");

    // The declared benchmark commit is destroyed, so it cannot resolve.
    expect(() => assertTargetRef(root, benchmark)).toThrow(/is not present in/u);

    fs.writeFileSync(recordPath, JSON.stringify({ source_commit: benchmark, commit: head }), "utf8");
    expect(() => assertTargetRef(root, benchmark)).not.toThrow();

    // A record for a different benchmark, or a different HEAD, is not accepted.
    fs.writeFileSync(recordPath, JSON.stringify({ source_commit: "c".repeat(40), commit: head }), "utf8");
    expect(() => assertTargetRef(root, benchmark)).toThrow(/is not present in/u);
    fs.writeFileSync(recordPath, JSON.stringify({ source_commit: benchmark, commit: "d".repeat(40) }), "utf8");
    expect(() => assertTargetRef(root, benchmark)).toThrow(/is not present in/u);
    fs.writeFileSync(recordPath, "not json", "utf8");
    expect(() => assertTargetRef(root, benchmark)).toThrow(/is not present in/u);

    // An abbreviated pin is accepted, matching the non-held-out path.
    fs.writeFileSync(recordPath, JSON.stringify({ source_commit: benchmark, commit: head }), "utf8");
    expect(() => assertTargetRef(root, benchmark.slice(0, 12))).not.toThrow();
    // A non-SHA ref must never prefix-match its way in.
    expect(() => assertTargetRef(root, "main")).toThrow(/is not present in/u);
    expect(() => assertTargetRef(root, "a".repeat(12))).toThrow(/is not present in/u);
  });
});

describe("describeEvalError", () => {
  const detailsOf = (described: string): unknown => {
    const start = described.indexOf("(details: ");
    expect(start).toBeGreaterThan(0);
    expect(described.endsWith(")")).toBe(true);
    return JSON.parse(described.slice(start + "(details: ".length, -1));
  };

  it("carries the code, the message, and a redacted copy of the details", () => {
    const described = describeEvalError(
      new EvalError("EVAL_LLM_JUDGE_REQUEST_FAILED", "LLM judge gateway request failed", {
        status: 401,
        body: '{"error":"invalid key sk-live-0123456789abcdef"}',
        judge_api_key: "plain-looking-value",
        nested: { Authorization: "Bearer abcdefghijklmnop", note: "kept", "Set-Cookie": "session=1" },
        headers: ["Bearer abcdefghijklmnop", "kept-entry"]
      })
    );
    expect(described.startsWith("EVAL_LLM_JUDGE_REQUEST_FAILED: LLM judge gateway request failed (details: ")).toBe(
      true
    );
    expect(detailsOf(described)).toEqual({
      status: 401,
      body: "[redacted]",
      judge_api_key: "[redacted]",
      nested: { Authorization: "[redacted]", note: "kept", "Set-Cookie": "[redacted]" },
      headers: ["[redacted]", "kept-entry"]
    });
    for (const secret of ["sk-live", "abcdefghijklmnop", "plain-looking-value", "session=1"]) {
      expect(described).not.toContain(secret);
    }
  });

  it("bounds the rendering on a code point boundary and marks truncation", () => {
    const described = describeEvalError(new EvalError("EVAL_X", "boom", { blob: "\u00e9".repeat(4000) }));
    const start = described.indexOf("(details: ") + "(details: ".length;
    const rendered = described.slice(start, -1);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(1500);
    expect(Buffer.byteLength(rendered, "utf8")).toBeGreaterThan(1400);
    expect(rendered.endsWith("\u2026")).toBe(true);
    expect(Buffer.from(rendered, "utf8").toString("utf8")).toBe(rendered);
    expect(described.startsWith("EVAL_X: boom (details: ")).toBe(true);
  });

  it("renders error causes and bigints, and leaves plain errors unchanged", () => {
    expect(
      describeEvalError(
        new EvalError("EVAL_TERMINAL_REPORT_INVALID", "bad report", {
          path: "/run/report.json",
          cause: new Error("ENOENT: missing"),
          bytes: 12n
        })
      )
    ).toBe(
      'EVAL_TERMINAL_REPORT_INVALID: bad report (details: {"path":"/run/report.json","cause":"Error: ENOENT: missing","bytes":"12"})'
    );
    expect(describeEvalError(new EvalError("EVAL_X", "no details"))).toBe("EVAL_X: no details");
    expect(describeEvalError(new EvalError("EVAL_X", "empty details", {}))).toBe("EVAL_X: empty details");
    expect(describeEvalError(new Error("plain failure"))).toBe("plain failure");
    expect(describeEvalError("string failure")).toBe("string failure");
  });
});
