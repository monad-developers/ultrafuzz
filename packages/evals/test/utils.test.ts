import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendJsonLine, readJsonLines } from "../src/utils.js";

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
