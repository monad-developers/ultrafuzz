import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertTargetRef } from "../src/utils.js";

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

    // An abbreviated pin is accepted, matching the non-held-out path.
    fs.writeFileSync(recordPath, JSON.stringify({ source_commit: benchmark, commit: head }), "utf8");
    expect(() => assertTargetRef(root, benchmark.slice(0, 12))).not.toThrow();
    // A non-SHA ref must never prefix-match its way in.
    expect(() => assertTargetRef(root, "main")).toThrow(/is not present in/u);
    expect(() => assertTargetRef(root, "a".repeat(12))).toThrow(/is not present in/u);
  });
});
