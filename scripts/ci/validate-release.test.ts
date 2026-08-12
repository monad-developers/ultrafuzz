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
    const reportPath = path.join(root, "report.json");
    fs.mkdirSync(fragments);
    fs.writeFileSync(
      path.join(fragments, "cli-typecheck.json"),
      `${JSON.stringify({
        schema_version: "ultrafuzz.release-validation.report.v1",
        package_id: "ultrafuzz",
        commands: gateIds.map((id) => ({
          id,
          status: id === "benchmark-history" ? "failed" : "passed"
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
      failures?: { commands?: string[] };
      commands?: Array<{ id?: string; status?: string }>;
    };
    expect(report.overall_status).toBe("fail");
    expect(report.failures?.commands).toEqual(["benchmark-history"]);
    expect(report.commands?.find((command) => command.id === "benchmark-history")?.status).toBe("failed");
  });
});
