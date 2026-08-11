import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendJsonLine, assertTargetRef, readJsonLines } from "../src/utils.js";

describe("eval JSONL journals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.runIf(process.platform !== "win32")("fsyncs the journal and its containing directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ufz-eval-journal-"));
    const journalPath = path.join(root, "nested", "runs.jsonl");
    const openSync = vi.spyOn(fs, "openSync");
    const fsyncSync = vi.spyOn(fs, "fsyncSync");

    appendJsonLine(journalPath, { row_id: "row-01", ultrafuzz_run_id: "run-01" });

    expect(openSync.mock.calls.map(([openedPath]) => openedPath)).toEqual([journalPath, path.dirname(journalPath)]);
    expect(fsyncSync.mock.calls.map(([fd]) => fd)).toEqual(openSync.mock.results.map(({ value }) => value));
    expect(fsyncSync).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(journalPath, "utf8")).toBe('{"row_id":"row-01","ultrafuzz_run_id":"run-01"}\n');
  });

  it("throws when a valid durable-run link is followed by a torn final line", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ufz-eval-journal-tail-"));
    const journalPath = path.join(root, "runs.jsonl");
    const linkedRow = {
      eval_run_id: "eval-01",
      row_id: "row-01",
      status: "launched",
      ultrafuzz_run_id: "run-01",
      ultrafuzz_run_root: path.join(root, "run-01")
    };
    fs.writeFileSync(journalPath, `${JSON.stringify(linkedRow)}\n{"eval_run_id":"eval-01"`, "utf8");

    expect(() => readJsonLines(journalPath)).toThrow(SyntaxError);
  });
});

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
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-holdout-ref-"));
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
  });
});
