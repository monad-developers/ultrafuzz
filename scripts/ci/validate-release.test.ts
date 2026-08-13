import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots: string[] = [];
const gateIds = [
  "docs",
  "config",
  "audit-profile-package",
  "security",
  "topology",
  "prompts",
  "artifacts",
  "runtime",
  "evals",
  "modal",
  "cli",
  "benchmark-history",
  "workspace-typecheck"
];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("release validation report aggregation", () => {
  it("cannot report success when benchmark-history is the only failed gate", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-release-report-"));
    roots.push(root);
    const fragments = path.join(root, "fragments");
    const reportRoot = fs.mkdtempSync(path.join(repoRoot, ".ultrafuzz", "release-report-test-"));
    roots.push(reportRoot);
    const reportPath = path.join(reportRoot, "report.json");
    fs.mkdirSync(fragments);
    fs.writeFileSync(
      path.join(fragments, "cli-typecheck.json"),
      `${JSON.stringify({
        schema_version: "ultrafuzz.release-validation.report.v2",
        package_id: "ultrafuzz",
        generated_at: "2026-08-13T00:00:00.000Z",
        project_root: repoRoot,
        report_path: ".ultrafuzz/release-validation/cli-typecheck.json",
        overall_status: "fail",
        commands: gateIds.map((id) => ({
          id,
          title: id,
          command: `test ${id}`,
          required: true,
          status: id === "benchmark-history" ? "failed" : "passed",
          exit_code: id === "benchmark-history" ? 1 : 0,
          duration_ms: 1,
          validation_gates: ["G-TEST"]
        }))
      })}\n`,
      "utf8"
    );

    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "validate-release.mjs"), "--merge-report-dir", fragments, "--report", reportPath],
      { cwd: repoRoot, encoding: "utf8" }
    );

    expect(result.status).toBe(1);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
      overall_status?: string;
      commands?: Array<{ id?: string; status?: string }>;
    };
    expect(report.overall_status).toBe("fail");
    expect(report.commands?.find((command) => command.id === "benchmark-history")?.status).toBe("failed");
  });
});
