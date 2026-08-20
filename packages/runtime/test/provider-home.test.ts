import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { loadRuntimeTemplate } from "../src/runtime-template.js";
type ResolveProviderHome = (provider: string, configured?: string) => string;
async function loadProviderHome(): Promise<ResolveProviderHome> {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-provider-home-module-")),
    modulePath = path.join(fixture, "provider-home.mjs");
  const compiled = ts.transpileModule(loadRuntimeTemplate("smithers/agents/provider-home.tsx"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  fs.writeFileSync(modulePath, compiled, "utf8");
  return ((await import(pathToFileURL(modulePath).href)) as { resolveProviderHome: ResolveProviderHome })
    .resolveProviderHome;
}
test("provider homes are private, operator-owned, and link-free", async () => {
  const resolve = await loadProviderHome(),
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-provider-home-root-")),
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
