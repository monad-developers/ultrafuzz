import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
const script = path.resolve("scripts/ci/terminate-modal-benchmark.sh");

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("exact Modal benchmark termination", () => {
  it("uses persisted IDs first and performs two exact config and image sweeps", () => {
    const fixture = terminationFixture();
    execFileSync("bash", [script, fixture.plan, fixture.state, fixture.pairs, "12345-2", "true", fixture.candidate], {
      env: fixture.env
    });

    expect(fs.readFileSync(fixture.calls, "utf8").trim().split("\n")).toEqual([
      `packages/modal/dist/cli.js terminate --state ${fixture.state}/pair.state.json`,
      `packages/modal/dist/cli.js terminate-build --image ufz-runner-${"a".repeat(40)} --build-scope 12345-2 --repo-root ${fixture.candidate}`,
      `packages/modal/dist/cli.js terminate --config ${fixture.plan}/pair.json --repo-root ${fixture.candidate}`,
      ...fixture.controllerIds.map(
        (controllerId) =>
          `packages/modal/dist/cli.js cleanup-node-run --app ultrafuzz-evals --image ufz-runner-${"a".repeat(40)} --run-id ${controllerId}`
      ),
      `packages/modal/dist/cli.js terminate-build --image ufz-runner-${"a".repeat(40)} --build-scope 12345-2 --repo-root ${fixture.candidate}`,
      `packages/modal/dist/cli.js terminate --config ${fixture.plan}/pair.json --repo-root ${fixture.candidate}`,
      ...fixture.controllerIds.map(
        (controllerId) =>
          `packages/modal/dist/cli.js cleanup-node-run --app ultrafuzz-evals --image ufz-runner-${"a".repeat(40)} --run-id ${controllerId}`
      )
    ]);
  });

  it("runs every sweep but reports uncertainty when one exact termination fails", () => {
    const fixture = terminationFixture();
    const result = spawnSync(
      "bash",
      [script, fixture.plan, fixture.state, fixture.pairs, "12345-2", "false", fixture.candidate],
      { encoding: "utf8", env: { ...fixture.env, FAIL_TERMINATE_BUILD: "true" } }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Modal cleanup uncertainty");
    expect(fs.readFileSync(fixture.calls, "utf8").trim().split("\n")).toHaveLength(10);
  });

  it("rejects unsafe or duplicated nested identities before any termination", () => {
    for (const value of [
      "pair.json\tpair.state.json\t../other",
      "pair.json\tpair.state.json\tultrafuzz-row-one,ultrafuzz-row-one",
      "pair.json\tpair.state.json\tultrafuzz-row-one\textra"
    ]) {
      const fixture = terminationFixture();
      fs.writeFileSync(fixture.pairs, `${value}\n`);
      const result = spawnSync(
        "bash",
        [script, fixture.plan, fixture.state, fixture.pairs, "12345-2", "true", fixture.candidate],
        { encoding: "utf8", env: fixture.env }
      );
      expect(result.status).toBe(1);
      expect(fs.existsSync(fixture.calls)).toBe(false);
    }
  });
});

function terminationFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-termination-"));
  roots.push(root);
  const plan = path.join(root, "plan");
  const state = path.join(root, "state");
  const candidate = path.join(root, "candidate");
  const bin = path.join(root, "bin");
  const pairs = path.join(root, "pairs.tsv");
  const calls = path.join(root, "calls.log");
  const controllerIds = ["ultrafuzz-row-one", "ultrafuzz-row-two", "ultrafuzz-row-three"];
  for (const directory of [plan, state, candidate, bin]) fs.mkdirSync(directory);

  fs.writeFileSync(
    path.join(plan, "manifest.json"),
    `${JSON.stringify({ image_name: `ufz-runner-${"a".repeat(40)}` })}\n`
  );
  fs.writeFileSync(path.join(plan, "pair.json"), "{}\n");
  fs.writeFileSync(path.join(state, "pair.state.json"), '{"launches":[{}],"attempt_history":[]}\n');
  fs.writeFileSync(pairs, `pair.json\tpair.state.json\t${controllerIds.join(",")}\n`);
  fs.writeFileSync(path.join(candidate, "tracked.txt"), "candidate\n");
  execFileSync("git", ["init", "--quiet"], { cwd: candidate });

  writeExecutable(
    path.join(bin, "timeout"),
    '#!/usr/bin/env bash\nset -euo pipefail\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n'
  );
  writeExecutable(
    path.join(bin, "node"),
    '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nif [ "${FAIL_TERMINATE_BUILD:-false}" = true ] && [ "${2:-}" = terminate-build ]; then exit 1; fi\n'
  );
  writeExecutable(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");

  return {
    plan,
    state,
    candidate,
    pairs,
    calls,
    controllerIds,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: calls }
  };
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o700 });
}
