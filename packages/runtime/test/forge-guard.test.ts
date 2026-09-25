import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createRunLayout } from "@ultrafuzz/artifacts";
import { resolveConfig, type ResolvedConfig } from "@ultrafuzz/config";

import { prepareForgeGuardEnvironment } from "../src/forge-guard.js";

function resolvedConfig(run: Partial<ResolvedConfig["run"]> = {}): ResolvedConfig {
  const resolved = resolveConfig({ env: {}, runtimeOverrides: { run } });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  if (!resolved.ok) throw new Error("config did not resolve");
  return resolved.value;
}

function fixture(runId: string): {
  root: string;
  bin: string;
  forge: string;
  pathValue: string;
  layout: ReturnType<typeof createRunLayout>;
} {
  const root = temporaryRoot("ultrafuzz-forge-guard-");
  const bin = path.join(root, "bin");
  const forge = path.join(bin, "forge");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    forge,
    ["#!/bin/sh", 'printf "%s|%s|%s\\n" "$(ulimit -v)" "$RAYON_NUM_THREADS" "$*"', "exit 23", ""].join("\n"),
    "utf8"
  );
  fs.chmodSync(forge, 0o755);
  return {
    root,
    bin,
    forge,
    pathValue: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    layout: createRunLayout({
      projectRoot: root,
      outputRoot: path.join(root, "runs"),
      runId
    })
  };
}

test("Forge guard creates a leading wrapper and preserves subprocess diagnostics", () => {
  const input = fixture("guarded");
  const prepared = prepareForgeGuardEnvironment({
    layout: input.layout,
    config: resolvedConfig({ forgeVmemLimitKb: 1_048_576, forgeRayonThreads: 3 }),
    env: { PATH: input.pathValue }
  });

  const wrapper = path.join(input.layout.root, "safe-bin", "forge");
  assert.equal(prepared.active, true);
  assert.equal(prepared.env.PATH?.split(path.delimiter)[0], path.dirname(wrapper));
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o700);
  assert.equal(prepared.environmentVariableNames.length, 4);
  assert.match(fs.readFileSync(wrapper, "utf8"), /^#!\/bin\/sh\nset -eu\n/u);

  const result = spawnSync(wrapper, ["test", "--match-test", "guard"], {
    env: { ...process.env, ...prepared.env },
    encoding: "utf8"
  });
  assert.equal(result.status, 23);
  assert.equal(result.stdout, "1048576|3|test --match-test guard\n");
});

test("Forge guard opt-out leaves PATH and the run directory unchanged", () => {
  const input = fixture("unguarded");
  const prepared = prepareForgeGuardEnvironment({
    layout: input.layout,
    config: resolvedConfig({ forgeGuardEnabled: false }),
    env: { PATH: input.pathValue }
  });

  assert.equal(prepared.active, false);
  assert.equal(prepared.env.PATH, input.pathValue);
  assert.deepEqual(prepared.environmentVariableNames, []);
  assert.equal(fs.existsSync(path.join(input.layout.root, "safe-bin")), false);
});

test("Forge guard excludes its run wrapper through a symlinked PATH entry", () => {
  const input = fixture("symlinked-safe-bin");
  prepareForgeGuardEnvironment({
    layout: input.layout,
    config: resolvedConfig(),
    env: { PATH: input.pathValue }
  });

  const wrapper = path.join(input.layout.root, "safe-bin", "forge");
  const safeBinAlias = path.join(input.root, "safe-bin-alias");
  fs.symlinkSync(path.dirname(wrapper), safeBinAlias, "dir");
  const prepared = prepareForgeGuardEnvironment({
    layout: input.layout,
    config: resolvedConfig(),
    env: { PATH: `${safeBinAlias}${path.delimiter}${input.pathValue}` }
  });

  assert.equal(prepared.active, true);
  assert.equal(Object.values(prepared.env).includes(fs.realpathSync(input.forge)), true);
  assert.equal(Object.values(prepared.env).includes(fs.realpathSync(wrapper)), false);
});

test("Forge guard serializes compiler processes independently of agent concurrency", async () => {
  const input = fixture("compiler-lock");
  const log = path.join(input.root, "compiler-order.log");
  fs.writeFileSync(
    input.forge,
    [
      "#!/bin/sh",
      `printf 'start:%s\\n' "$1" >> ${JSON.stringify(log)}`,
      "sleep 0.2",
      `printf 'end:%s\\n' "$1" >> ${JSON.stringify(log)}`,
      ""
    ].join("\n")
  );
  fs.chmodSync(input.forge, 0o755);
  const prepared = prepareForgeGuardEnvironment({
    layout: input.layout,
    config: resolvedConfig(),
    env: { PATH: input.pathValue }
  });
  const wrapper = path.join(input.layout.root, "safe-bin", "forge");
  const run = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(wrapper, [name], { env: { ...process.env, ...prepared.env }, stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`compiler exited ${code}`))));
    });
  await Promise.all([run("one"), run("two")]);
  const events = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(events.length, 4);
  assert.equal(events[0]!.replace("start:", ""), events[1]!.replace("end:", ""));
  assert.equal(events[2]!.replace("start:", ""), events[3]!.replace("end:", ""));
});
