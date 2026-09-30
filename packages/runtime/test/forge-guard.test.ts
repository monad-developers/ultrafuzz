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
  options: { outputRoot?: string; throughSymlink?: boolean } = {}
): {
  root: string;
  bin: string;
  forge: string;
  pathValue: string;
  layout: ReturnType<typeof createRunLayout>;
} {
  let root = temporaryRoot("ultrafuzz-forge-guard-");
  if (options.throughSymlink === true) {
    // Every path below a symlinked parent differs from its real path.
    fs.mkdirSync(path.join(root, "real", "project"), { recursive: true });
    fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"), "dir");
    root = path.join(root, "alias", "project");
  }
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
      ...(options.outputRoot === undefined ? {} : { outputRoot: path.join(root, options.outputRoot) }),
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

test("Forge guard clears anything but the wrapper from its directory, which the engine PATH requires", () => {
  const input = fixture("stray-entries");
  const safeBin = path.join(input.layout.root, "safe-bin");
  fs.mkdirSync(path.join(safeBin, "stray-directory"), { recursive: true });
  // What an interrupted write left beside the wrapper while writes were staged there.
  fs.writeFileSync(path.join(safeBin, ".forge.tmp-1-2-3"), "");

  const prepared = prepareForgeGuardEnvironment({
    layout: input.layout,
    projectRoot: input.root,
    config: resolvedConfig(),
    env: { PATH: input.pathValue }
  });

  assert.equal(prepared.active, true);
  assert.deepEqual(prepared.diagnostics, []);
  assert.deepEqual(fs.readdirSync(safeBin), ["forge"]);
  assert.equal(enginePath(input.root, prepared.env)[0], safeBin);
});

// Launch holds the control lock and resume the lifecycle lock, so both can
// prepare the same run's wrapper at once. The one that clears the directory
// must not delete the other's write in progress, and a command composing the
// engine PATH meanwhile must still find the wrapper alone in the directory.
test("Forge guard preparations of one run can overlap", (t) => {
  const input = fixture("overlapping-preparations");
  const safeBin = path.join(input.layout.root, "safe-bin");
  const wrapper = path.join(safeBin, "forge");
  const prepare = () =>
    prepareForgeGuardEnvironment({
      layout: input.layout,
      projectRoot: input.root,
      config: resolvedConfig(),
      env: { PATH: input.pathValue }
    });
  const launched = prepare();
  const renameSync = fs.renameSync;
  let overlapped = false;
  let admittedMidWrite: boolean | undefined;
  let overlapping: ReturnType<typeof prepare> | undefined;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (!overlapped && path.resolve(String(to)) === wrapper) {
      // This command's wrapper is written but not yet in place.
      overlapped = true;
      admittedMidWrite = enginePath(input.root, launched.env)[0] === safeBin;
      overlapping = prepare();
    }
    renameSync(from, to);
  });

  const resumed = prepare();

  assert.equal(overlapped, true);
  assert.equal(admittedMidWrite, true);
  assert.equal(overlapping?.active, true);
  assert.equal(resumed.active, true);
  assert.deepEqual(fs.readdirSync(safeBin), ["forge"]);
  assert.equal(enginePath(input.root, resumed.env)[0], safeBin);
});

test("Forge guard reports itself inactive when the engine PATH would drop its wrapper", () => {
  const throughSymlink = fixture("symlinked-parent", { throughSymlink: true });
  const customOutputDir = fixture("custom-output-dir", { outputRoot: "audit-runs" });

  for (const input of [throughSymlink, customOutputDir]) {
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
    assert.match(
      prepared.diagnostics[0]?.message ?? "",
      /on a path without symbolic links, holding just the wrapper .* without the configured memory and thread limits/u
    );
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
