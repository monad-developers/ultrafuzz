import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createRunLayout } from "@ultrafuzz/artifacts";
import { resolveConfig, type ResolvedConfig } from "@ultrafuzz/config";

import { prepareForgeGuardEnvironment } from "../src/forge-guard.js";
import { composeSmithersCommandPath } from "../src/smithers.js";
import { underGroupWritableUmask } from "./process-umask.js";

function resolvedConfig(run: Partial<ResolvedConfig["run"]> = {}): ResolvedConfig {
  const resolved = resolveConfig({ env: {}, runtimeOverrides: { run } });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  if (!resolved.ok) throw new Error("config did not resolve");
  return resolved.value;
}

// The run lives where launch puts it, `<project>/.ultrafuzz/runs/<run-id>`,
// because that is the only place the engine PATH admits the wrapper from.
function fixture(
  runId: string,
  outputRoot?: string
): {
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
      ...(outputRoot === undefined ? {} : { outputRoot: path.join(root, outputRoot) }),
      runId
    })
  };
}

function enginePath(root: string, env: Record<string, string | undefined>): string[] {
  return composeSmithersCommandPath(root, env).split(path.delimiter);
}

test("Forge guard creates a leading wrapper and preserves subprocess diagnostics", () => {
  const input = fixture("guarded");
  const prepared = prepareForgeGuardEnvironment({
    layout: input.layout,
    projectRoot: input.root,
    config: resolvedConfig({ forgeVmemLimitKb: 1_048_576, forgeRayonThreads: 3 }),
    env: { PATH: input.pathValue }
  });

  const wrapper = path.join(input.layout.root, "safe-bin", "forge");
  assert.equal(prepared.active, true);
  assert.deepEqual(prepared.diagnostics, []);
  assert.equal(prepared.env.PATH?.split(path.delimiter)[0], path.dirname(wrapper));
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o700);
  assert.equal(prepared.environmentVariableNames.length, 3);
  assert.match(fs.readFileSync(wrapper, "utf8"), /^#!\/bin\/sh\nset -eu\n/u);

  const result = spawnSync(wrapper, ["test", "--match-test", "guard"], {
    env: { ...process.env, ...prepared.env, PATH: path.dirname(wrapper) },
    encoding: "utf8"
  });
  assert.equal(result.status, 23);
  assert.equal(result.stdout, "1048576|3|test --match-test guard\n");
});

// Ubuntu's default umask made mkdir create safe-bin 0775, which the engine PATH
// refuses, so tasks ran the real Forge while run.json recorded the guard active.
test(
  "Forge guard keeps its wrapper on the engine PATH under a group-writable umask",
  underGroupWritableUmask(() => {
    const input = fixture("group-writable-umask");
    const prepared = prepareForgeGuardEnvironment({
      layout: input.layout,
      projectRoot: input.root,
      config: resolvedConfig(),
      env: { PATH: input.pathValue }
    });

    const safeBin = path.join(input.layout.root, "safe-bin");
    assert.equal(prepared.active, true);
    assert.equal(fs.statSync(safeBin).mode & 0o777, 0o700);
    assert.equal(enginePath(input.root, prepared.env)[0], safeBin);
  })
);

test("Forge guard repairs a group-writable wrapper directory an earlier launch created", () => {
  const input = fixture("group-writable-safe-bin");
  const safeBin = path.join(input.layout.root, "safe-bin");
  fs.mkdirSync(safeBin);
  fs.chmodSync(safeBin, 0o775);

  const prepared = prepareForgeGuardEnvironment({
    layout: input.layout,
    projectRoot: input.root,
    config: resolvedConfig(),
    env: { PATH: input.pathValue }
  });

  assert.equal(prepared.active, true);
  assert.equal(fs.statSync(safeBin).mode & 0o777, 0o700);
  assert.equal(enginePath(input.root, prepared.env)[0], safeBin);
});

test("Forge guard reports itself inactive when the engine PATH would drop its wrapper", () => {
  const strayFile = fixture("stray-file");
  fs.mkdirSync(path.join(strayFile.layout.root, "safe-bin"));
  // What an interrupted durable write leaves beside the wrapper.
  fs.writeFileSync(path.join(strayFile.layout.root, "safe-bin", ".forge.tmp-1-2-3"), "");
  const customOutputDir = fixture("custom-output-dir", "audit-runs");

  for (const input of [strayFile, customOutputDir]) {
    const prepared = prepareForgeGuardEnvironment({
      layout: input.layout,
      projectRoot: input.root,
      config: resolvedConfig(),
      env: { PATH: input.pathValue }
    });

    assert.equal(prepared.active, false, input.layout.root);
    assert.equal(prepared.env.PATH, input.pathValue);
    assert.deepEqual(prepared.environmentVariableNames, []);
    assert.equal(prepared.env.ULTRAFUZZ_REAL_FORGE, undefined);
    assert.deepEqual(
      prepared.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity]),
      [["FORGE_GUARD_INACTIVE", "warning"]]
    );
    assert.match(prepared.diagnostics[0]?.message ?? "", /without the configured memory and thread limits/u);
    assert.equal(enginePath(input.root, prepared.env).includes(path.join(input.layout.root, "safe-bin")), false);
  }
});

test("Forge guard opt-out leaves PATH and the run directory unchanged", () => {
  const input = fixture("unguarded");
  const prepared = prepareForgeGuardEnvironment({
    layout: input.layout,
    projectRoot: input.root,
    config: resolvedConfig({ forgeGuardEnabled: false }),
    env: { PATH: input.pathValue }
  });

  assert.equal(prepared.active, false);
  assert.deepEqual(prepared.diagnostics, []);
  assert.equal(prepared.env.PATH, input.pathValue);
  assert.deepEqual(prepared.environmentVariableNames, []);
  assert.equal(fs.existsSync(path.join(input.layout.root, "safe-bin")), false);
});

test("Forge guard excludes its run wrapper through a symlinked PATH entry", () => {
  const input = fixture("symlinked-safe-bin");
  prepareForgeGuardEnvironment({
    layout: input.layout,
    projectRoot: input.root,
    config: resolvedConfig(),
    env: { PATH: input.pathValue }
  });

  const wrapper = path.join(input.layout.root, "safe-bin", "forge");
  const safeBinAlias = path.join(input.root, "safe-bin-alias");
  fs.symlinkSync(path.dirname(wrapper), safeBinAlias, "dir");
  const prepared = prepareForgeGuardEnvironment({
    layout: input.layout,
    projectRoot: input.root,
    config: resolvedConfig(),
    env: { PATH: `${safeBinAlias}${path.delimiter}${input.pathValue}` }
  });

  assert.equal(prepared.active, true);
  assert.equal(Object.values(prepared.env).includes(fs.realpathSync(input.forge)), true);
  assert.equal(Object.values(prepared.env).includes(fs.realpathSync(wrapper)), false);
});
