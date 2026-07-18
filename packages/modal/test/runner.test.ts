import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createTrackedSourceArchive,
  modalImageBuildCommand,
  modalVolumeRelativeRoot,
  modalWorkerEntrypointCommand
} from "../src/runner.js";

describe("Modal image source staging", () => {
  it("archives tracked files only", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-archive-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), ".private/\n", "utf8");
    fs.writeFileSync(path.join(root, "tracked.txt"), "tracked\n", "utf8");
    fs.writeFileSync(path.join(root, "untracked.txt"), "untracked\n", "utf8");
    fs.mkdirSync(path.join(root, ".private"));
    fs.writeFileSync(path.join(root, ".private", "benchmark.json"), "private\n", "utf8");
    execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root });
    const archive = path.join(root, "source.tgz");

    createTrackedSourceArchive(root, archive);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");

    expect(entries).toEqual(expect.arrayContaining([".gitignore", "tracked.txt"]));
    expect(entries).not.toContain("untracked.txt");
    expect(entries).not.toContain(".private/benchmark.json");
  });
});

describe("Modal worker identity", () => {
  it("makes the compiled source tree readable by the non-root worker", () => {
    expect(modalImageBuildCommand()).toContain("chown -R ubuntu:ubuntu /opt/ultrafuzz");
  });

  it("stages as root and executes the worker as the non-root image user", () => {
    const command = modalWorkerEntrypointCommand("anthropic");

    expect(command).toContain('chown -R ubuntu:ubuntu "$data_root"');
    expect(command).toContain("chown -R ubuntu:ubuntu '/run/ultrafuzz-auth/claude'");
    expect(command).toContain("runuser -u ubuntu -- env HOME='/home/ubuntu'");
    expect(command).toContain("/opt/ultrafuzz/packages/modal/dist/worker.js");
  });

  it("can launch a worker that resumes the persisted workspace", () => {
    expect(modalWorkerEntrypointCommand("openai", true)).toContain("ULTRAFUZZ_MODAL_RESUME_EXISTING='1'");
  });

  it("maps only /data children into the volume-relative root", () => {
    expect(modalVolumeRelativeRoot("/data/run-one/model-one")).toBe("run-one/model-one");
    expect(() => modalVolumeRelativeRoot("/outside/run-one")).toThrow("must be a child of /data");
  });
});
