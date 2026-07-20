import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), "target-e2e-ci.ts");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("target E2E inspect health", () => {
  it("rejects terminal and non-progressing workflow states", () => {
    for (const status of ["timed-out", "timed_out", "blocked", "stalled", "paused"]) {
      const result = runInspectEnvelope({
        ok: true,
        diagnostics: [],
        data: { status: "running", workflow: { status } }
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("run is not healthy");
    }
  });

  it("accepts a running workflow without blocking diagnostics", () => {
    const result = runInspectEnvelope({
      ok: true,
      diagnostics: [],
      data: { status: "running", workflow: { status: "running" } }
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

function runInspectEnvelope(envelope: unknown) {
  const root = mkdtempSync(join(tmpdir(), "ultrafuzz-target-e2e-inspect-"));
  temporaryRoots.push(root);
  const path = join(root, "inspect.json");
  writeFileSync(path, `${JSON.stringify(envelope)}\n`, "utf-8");
  return spawnSync(process.execPath, [helperPath, "assert-inspect-healthy", path], { encoding: "utf-8" });
}
