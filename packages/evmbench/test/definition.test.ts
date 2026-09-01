import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildPinnedAuditDockerfile,
  generateEvmbenchDefinition,
  loadEvmbenchDefinition,
  localDockerContextFiles,
  verifyEvmbenchDefinition,
  writeEvmbenchDefinition
} from "../src/definition.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("EVMBench definition", () => {
  it("round-trips a pinned catalog and detects upstream finding drift", async () => {
    const fixture = createHarnessFixture();
    const definition = await generateEvmbenchDefinition({
      harnessRoot: fixture.harnessRoot,
      resolveTargetCommit: async () => "a".repeat(40)
    });
    writeEvmbenchDefinition(fixture.benchmarkDir, definition);

    expect(loadEvmbenchDefinition(fixture.benchmarkDir)).toEqual(definition);
    await expect(
      verifyEvmbenchDefinition({ benchmarkDir: fixture.benchmarkDir, harnessRoot: fixture.harnessRoot })
    ).resolves.toEqual(definition);

    fs.writeFileSync(path.join(fixture.auditDir, "findings", "H-02.md"), "Synthetic observation.\n", "utf8");
    fs.appendFileSync(
      path.join(fixture.auditDir, "config.yaml"),
      "  - id: H-02\n    title: Synthetic observation\n",
      "utf8"
    );
    await expect(
      verifyEvmbenchDefinition({ benchmarkDir: fixture.benchmarkDir, harnessRoot: fixture.harnessRoot })
    ).rejects.toThrow("audit catalog drifted");
  });

  it("rejects duplicate finding IDs", async () => {
    const fixture = createHarnessFixture();
    fs.appendFileSync(
      path.join(fixture.auditDir, "config.yaml"),
      "  - id: H-01\n    title: Duplicate synthetic observation\n",
      "utf8"
    );
    await expect(
      generateEvmbenchDefinition({
        harnessRoot: fixture.harnessRoot,
        resolveTargetCommit: async () => "a".repeat(40)
      })
    ).rejects.toThrow("duplicate finding ID");
  });

  it("rejects duplicate-key and symlinked definition snapshots", async () => {
    const duplicate = createHarnessFixture();
    const duplicateDefinition = await generateEvmbenchDefinition({
      harnessRoot: duplicate.harnessRoot,
      resolveTargetCommit: async () => "a".repeat(40)
    });
    writeEvmbenchDefinition(duplicate.benchmarkDir, duplicateDefinition);
    const lockPath = path.join(duplicate.benchmarkDir, "benchmark.lock.json");
    const lockText = fs.readFileSync(lockPath, "utf8");
    fs.writeFileSync(
      lockPath,
      lockText.replace(
        '  "schema_version": "ultrafuzz.evmbench.lock.v2",',
        '  "schema_version": "ultrafuzz.evmbench.lock.v2",\n  "schema_version": "ultrafuzz.evmbench.lock.v2",'
      ),
      "utf8"
    );
    expect(() => loadEvmbenchDefinition(duplicate.benchmarkDir)).toThrow("duplicate property name");

    const symlinked = createHarnessFixture();
    const symlinkedDefinition = await generateEvmbenchDefinition({
      harnessRoot: symlinked.harnessRoot,
      resolveTargetCommit: async () => "a".repeat(40)
    });
    writeEvmbenchDefinition(symlinked.benchmarkDir, symlinkedDefinition);
    const catalogPath = path.join(symlinked.benchmarkDir, "audit-catalog.json");
    const displaced = path.join(path.dirname(symlinked.benchmarkDir), "displaced-catalog.json");
    fs.renameSync(catalogPath, displaced);
    fs.symlinkSync(displaced, catalogPath);
    expect(() => loadEvmbenchDefinition(symlinked.benchmarkDir)).toThrow("cannot open regular file");
  });

  it("reports a missing audit directory with the audit ID", async () => {
    const fixture = createHarnessFixture();
    fs.rmSync(fixture.auditDir, { recursive: true });

    await expect(
      generateEvmbenchDefinition({
        harnessRoot: fixture.harnessRoot,
        resolveTargetCommit: async () => "a".repeat(40)
      })
    ).rejects.toThrow("audit directory missing for synthetic-audit");
  });

  it("reports missing finding documents and Docker context inputs", async () => {
    const missingFinding = createHarnessFixture();
    fs.rmSync(path.join(missingFinding.auditDir, "findings", "H-01.md"));
    await expect(
      generateEvmbenchDefinition({
        harnessRoot: missingFinding.harnessRoot,
        resolveTargetCommit: async () => "a".repeat(40)
      })
    ).rejects.toThrow("audit synthetic-audit is missing finding document H-01.md");

    const missingContext = createHarnessFixture();
    fs.appendFileSync(
      path.join(missingContext.auditDir, "Dockerfile"),
      "COPY hardhat.config.js $AUDIT_DIR/hardhat.config.js\n",
      "utf8"
    );
    await expect(
      generateEvmbenchDefinition({
        harnessRoot: missingContext.harnessRoot,
        resolveTargetCommit: async () => "a".repeat(40)
      })
    ).rejects.toThrow("audit synthetic-audit Docker context input is not a file: hardhat.config.js");
  });

  it("pins the target checkout and permits only non-sensitive Docker context inputs", () => {
    const repository = "https://github.com/evmbench-org/synthetic-audit.git";
    const source = [
      "FROM evmbench/base:latest",
      `RUN git clone --recurse ${repository} $AUDIT_DIR`,
      "COPY hardhat.config.js $AUDIT_DIR/hardhat.config.js"
    ].join("\n");
    const pinned = buildPinnedAuditDockerfile({
      dockerfile: source,
      repository,
      targetCommit: "b".repeat(40),
      baseImage: "ultrafuzz/evmbench-base:pinned"
    });

    expect(pinned).toContain(`fetch --depth 1 origin ${"b".repeat(40)}`);
    expect(pinned).not.toContain("git clone");
    expect(localDockerContextFiles(source)).toEqual(["hardhat.config.js"]);
    expect(() => localDockerContextFiles("COPY findings/report.md /tmp/report.md")).toThrow(
      "unsafe audit build context source"
    );
  });
});

function createHarnessFixture(): { harnessRoot: string; benchmarkDir: string; auditDir: string } {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-evmbench-definition-"));
  temporaryDirectories.push(root);
  const harnessRoot = path.join(root, "harness");
  const frontierRoot = path.join(harnessRoot, "frontier-evals");
  const projectRoot = path.join(frontierRoot, "project", "evmbench");
  const auditDir = path.join(projectRoot, "audits", "synthetic-audit");
  fs.mkdirSync(path.join(auditDir, "findings"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "splits"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "splits", "debug.txt"), "synthetic-audit\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "splits", "detect-tasks.txt"), "synthetic-audit\n", "utf8");
  fs.writeFileSync(
    path.join(auditDir, "config.yaml"),
    [
      "id: synthetic-audit",
      "framework: foundry",
      "vulnerabilities:",
      "  - id: H-01",
      "    title: Synthetic observation",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(auditDir, "findings", "H-01.md"), "Synthetic observation.\n", "utf8");
  fs.writeFileSync(
    path.join(auditDir, "Dockerfile"),
    [
      "FROM evmbench/base:latest",
      "RUN git clone --recurse https://github.com/evmbench-org/synthetic-audit.git $AUDIT_DIR",
      ""
    ].join("\n"),
    "utf8"
  );
  initGit(frontierRoot);
  initGit(harnessRoot);
  return { harnessRoot, benchmarkDir: path.join(root, "benchmark"), auditDir };
}

function initGit(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: directory });
  execFileSync("git", ["config", "advice.addEmbeddedRepo", "false"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: directory });
}
