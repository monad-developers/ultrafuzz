import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { modelDestination } from "../src/data-governance.js";
import { loadRuntimeTemplate } from "../src/runtime-template.js";
import { underGroupWritableUmask } from "./process-umask.js";
type ResolveProviderHome = (provider: string, configured?: string) => string;
async function loadProviderHome(): Promise<ResolveProviderHome> {
  const fixture = temporaryRoot("ufz-provider-home-module-"),
    modulePath = path.join(fixture, "provider-home.mjs");
  const compiled = ts.transpileModule(loadRuntimeTemplate("smithers/agents/provider-home.tsx"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  fs.writeFileSync(modulePath, compiled, "utf8");
  return ((await import(pathToFileURL(modulePath).href)) as { resolveProviderHome: ResolveProviderHome })
    .resolveProviderHome;
}
// Ubuntu's layout under its default umask 0002: a 0750 home whose ~/.local is 0775.
test(
  "the default provider-home root is a private directory under HOME that XDG_STATE_HOME does not move",
  underGroupWritableUmask(async () => {
    const resolve = await loadProviderHome(),
      home = temporaryRoot("ufz-provider-home-default-"),
      xdgState = path.join(home, ".local", "state"),
      root = path.join(home, ".ultrafuzz", "provider-homes");
    fs.chmodSync(home, 0o750);
    fs.mkdirSync(xdgState, { recursive: true });
    fs.chmodSync(path.join(home, ".local"), 0o775);
    const previous = Object.fromEntries(
      ["HOME", "XDG_STATE_HOME", "ULTRAFUZZ_PROVIDER_HOME_ROOT"].map((name) => [name, process.env[name]])
    );
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = xdgState;
    delete process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT;
    try {
      assert.equal(resolve("openrouter"), path.join(root, "openrouter"));
      const codex = resolve("codex", "teams/codex");
      assert.equal(codex, path.join(root, "codex", "teams", "codex"));
      for (let current = codex; current !== home; current = path.dirname(current))
        assert.equal(fs.statSync(current).mode & 0o777, 0o700, current);
      // Data governance reads a configured provider's route from the same home.
      fs.writeFileSync(path.join(codex, "config.toml"), 'model_provider = "gateway"\n');
      const config = { agents: { CodexAgent: { configDir: "teams/codex" } } } as never;
      assert.match(
        modelDestination("CodexAgent", config, { HOME: home, XDG_STATE_HOME: xdgState }),
        /^model:codex-route-/u
      );
      // The umask can only clear mkdir's mode bits; chmod restores 0700 when it clears the owner's.
      process.umask(0o277);
      try {
        assert.equal(resolve("deepseek"), path.join(root, "deepseek"));
      } finally {
        process.umask(0o002);
      }
      assert.equal(fs.statSync(path.join(root, "deepseek")).mode & 0o777, 0o700);
      // An explicit root keeps the ancestor check, so the old default beneath ~/.local is refused.
      process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = path.join(xdgState, "ultrafuzz", "provider-homes");
      assert.throws(() => resolve("openrouter"), /provider-home ancestors cannot be group\/world writable/u);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  })
);
test("provider homes are private, operator-owned, and link-free", async () => {
  const resolve = await loadProviderHome(),
    fixture = temporaryRoot("ufz-provider-home-root-"),
    root = path.join(fixture, "operator-state"),
    outside = path.join(fixture, "outside");
  for (const directory of [root, path.join(root, "codex"), outside]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(root, "codex", "linked"));
  const previous: Record<string, string | undefined> = {
    ULTRAFUZZ_PROVIDER_HOME_ROOT: process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT,
    CODEX_HOME: process.env.CODEX_HOME
  };
  process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = root;
  try {
    const selected = resolve("codex", "teams/codex");
    assert.equal(selected, path.join(root, "codex", "teams", "codex"));
    assert.equal(resolve("codex"), path.join(root, "codex"));
    assert.equal(fs.statSync(selected).mode & 0o777, 0o700);
    for (const unsafe of ["", "/tmp/provider", "../provider", ".codex", "team\\codex", "team/../codex"])
      assert.throws(() => resolve("codex", unsafe), /safe relative path/u);
    process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = "relative/operator-state";
    assert.throws(() => resolve("codex", "team"), /must be an absolute operator-owned path/u);
    fs.chmodSync(fixture, 0o775);
    process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = fixture;
    assert.throws(() => resolve("codex", "team"), /(?:group\/world writable|writable by another user)/u);
    const canonical = path.join(fixture, "codex-home");
    fs.chmodSync(fixture, 0o755);
    fs.mkdirSync(canonical, { mode: 0o755 });
    fs.chmodSync(canonical, 0o755);
    delete process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT;
    process.env.CODEX_HOME = canonical;
    assert.throws(() => resolve("codex"), /private 0700/u);
    fs.chmodSync(canonical, 0o700);
    assert.equal(resolve("codex"), canonical);
    process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = root;
    assert.throws(() => resolve("codex", "linked/child"), /unsafe provider-home component/u);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
// The adapter creates each missing provider-home component itself with an
// explicit private mode, so the next call's ancestor check passes on a host
// whose umask leaves new directories group writable.
test(
  "provider homes created under a group-writable umask pass the ancestor check on reuse",
  underGroupWritableUmask(async () => {
    const resolve = await loadProviderHome(),
      fixture = temporaryRoot("ufz-provider-home-umask-"),
      root = path.join(fixture, "operator-state");
    const previous = process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT;
    process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = root;
    try {
      const selected = resolve("codex", "teams/codex");
      assert.equal(resolve("codex", "teams/codex"), selected);
      for (let current = selected; current !== fixture; current = path.dirname(current))
        assert.equal(fs.statSync(current).mode & 0o777, 0o700, current);
    } finally {
      if (previous === undefined) delete process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT;
      else process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = previous;
    }
  })
);
