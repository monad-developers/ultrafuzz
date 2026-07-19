import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyEvmbenchProfile,
  copyFinalMarkdown,
  EVMBENCH_PROFILE_VERSION,
  runEvmbenchAdapter,
  seedSmithersDependencies,
  type EvmbenchProfile
} from "../src/adapter.js";

const temporaryDirectories: string[] = [];
const profile: EvmbenchProfile = {
  schema_version: EVMBENCH_PROFILE_VERSION,
  id: "smoke",
  max_concurrency: 2,
  poll_interval_seconds: 1,
  workflow_timeout_seconds: 60,
  node_timeout_seconds: 30,
  model: "synthetic-model",
  reasoning: "high"
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("EVMBench adapter", () => {
  it("applies the named profile without duplicating config logic", () => {
    const root = temporaryDirectory();
    const configPath = path.join(root, "ultrafuzz.toml");
    fs.writeFileSync(configPath, baseConfig(), "utf8");
    applyEvmbenchProfile(configPath, profile);
    const updated = fs.readFileSync(configPath, "utf8");

    expect(updated).toContain("max_parallel_agents = 2");
    expect(updated).toContain('model = "synthetic-model"');
    expect(updated).toContain('reasoning = "high"');
    expect(updated).toContain('auth = "subscription"');
  });

  it("waits for completion and copies only the non-empty final Markdown", async () => {
    const root = temporaryDirectory();
    const auditRoot = path.join(root, "audit");
    const submissionRoot = path.join(root, "submission");
    const profilePath = path.join(root, "profile.json");
    const reportPath = path.join(root, "report.md");
    const dependencySeedPath = path.join(root, "seed-node-modules");
    fs.mkdirSync(auditRoot);
    fs.mkdirSync(path.join(dependencySeedPath, "synthetic-package"), { recursive: true });
    fs.writeFileSync(path.join(auditRoot, "ultrafuzz.toml"), baseConfig(), "utf8");
    fs.writeFileSync(
      path.join(dependencySeedPath, "synthetic-package", "package.json"),
      '{"name":"synthetic-package"}\n',
      "utf8"
    );
    fs.writeFileSync(profilePath, JSON.stringify(profile), "utf8");
    fs.writeFileSync(reportPath, "# Synthetic report\n", "utf8");
    let statusCalls = 0;

    await runEvmbenchAdapter({
      auditRoot,
      submissionRoot,
      profilePath,
      cliPath: "unused",
      dependencySeedPath,
      wait: async () => undefined,
      execute: (args) => {
        const command = args[0];
        if (command === "status") {
          statusCalls += 1;
          return success({ verdict: statusCalls === 1 ? "progressing" : "done" });
        }
        if (command === "report") return success({ markdown_path: reportPath });
        return success({});
      }
    });

    expect(fs.readdirSync(submissionRoot)).toEqual(["audit.md"]);
    expect(fs.readFileSync(path.join(submissionRoot, "audit.md"), "utf8")).toBe("# Synthetic report\n");
    expect(
      fs.readFileSync(path.join(auditRoot, ".smithers", "node_modules", "synthetic-package", "package.json"), "utf8")
    ).toBe('{"name":"synthetic-package"}\n');
  });

  it("rejects a symlinked dependency seed", () => {
    const root = temporaryDirectory();
    const seed = path.join(root, "seed");
    const link = path.join(root, "seed-link");
    fs.mkdirSync(seed);
    fs.symlinkSync(seed, link);

    expect(() => seedSmithersDependencies(path.join(root, "audit"), link)).toThrow(
      "Smithers dependency seed must be a regular directory"
    );
  });

  it("rejects empty and symlinked reports", () => {
    const root = temporaryDirectory();
    const empty = path.join(root, "empty.md");
    const link = path.join(root, "link.md");
    fs.writeFileSync(empty, "  \n", "utf8");
    fs.symlinkSync(empty, link);

    expect(() => copyFinalMarkdown({ reportPath: empty, submissionRoot: path.join(root, "submission-a") })).toThrow(
      "final report is empty"
    );
    expect(() => copyFinalMarkdown({ reportPath: link, submissionRoot: path.join(root, "submission-b") })).toThrow(
      "final report must be a regular file"
    );
  });
});

function baseConfig(): string {
  return [
    "[run]",
    'output_dir = ".ultrafuzz/runs"',
    "max_parallel_agents = 4",
    "max_parallel_nodes = 8",
    "default_timeout_seconds = 1800",
    "workflow_deadline_seconds = 86400",
    "",
    "[models.default]",
    'agent = "CodexAgent"',
    'model = "default-model"',
    'reasoning = "xhigh"',
    "",
    "[agents.CodexAgent]",
    'auth = "subscription"',
    "",
    "[permissions]",
    'trust_model = "skip-permissions"',
    ""
  ].join("\n");
}

function success(data: Record<string, unknown>): unknown {
  return { ok: true, data };
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-evmbench-adapter-"));
  temporaryDirectories.push(directory);
  return directory;
}
