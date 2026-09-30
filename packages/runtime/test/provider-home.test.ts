import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import { type AccountFiles, operatorIds, readingAccountFiles, writeAccountFiles } from "./account-files.js";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { loadRuntimeTemplate } from "../src/runtime-template.js";
import { underGroupWritableUmask } from "./process-umask.js";
type ResolveProviderHome = (provider: string, configured?: string) => string;
/** The adapter's provider-home module, reading `accounts` instead of the host's account files when given. */
async function loadProviderHome(accounts?: AccountFiles): Promise<ResolveProviderHome> {
  const fixture = temporaryRoot("ufz-provider-home-module-"),
    modulePath = path.join(fixture, "provider-home.mjs"),
    source = loadRuntimeTemplate("smithers/agents/provider-home.tsx");
  const compiled = ts.transpileModule(accounts === undefined ? source : readingAccountFiles(source, accounts), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  fs.writeFileSync(modulePath, compiled, "utf8");
  return ((await import(pathToFileURL(modulePath).href)) as { resolveProviderHome: ResolveProviderHome })
    .resolveProviderHome;
}
/**
 * A home as Ubuntu's default umask 0002 leaves it: `~/.local` and
 * `~/.local/state` are group writable, and belong to the operator and the
 * operator's primary group. Each test writes the account files.
 */
function groupWritableHome(): { home: string; local: string; defaultRoot: string; accounts: AccountFiles } {
  const fixture = temporaryRoot("ufz-provider-home-umask-"),
    home = path.join(fixture, "home"),
    local = path.join(home, ".local");
  fs.mkdirSync(home, { mode: 0o750 });
  fs.mkdirSync(path.join(local, "state"), { recursive: true });
  assert.equal(fs.statSync(local).mode & 0o777, 0o775);
  return {
    home,
    local,
    defaultRoot: path.join(local, "state", "ultrafuzz", "provider-homes"),
    accounts: { passwd: path.join(fixture, "passwd"), group: path.join(fixture, "group") }
  };
}
/** Resolves a Codex provider home with the default root, `~/.local/state/ultrafuzz/provider-homes` below `home`. */
function resolveUnderDefaultRoot(resolve: ResolveProviderHome, home: string): string {
  const names = ["HOME", "XDG_STATE_HOME", "ULTRAFUZZ_PROVIDER_HOME_ROOT"] as const,
    previous = names.map((name) => process.env[name]);
  process.env.HOME = home;
  delete process.env.XDG_STATE_HOME;
  delete process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT;
  try {
    return resolve("codex", "teams/codex");
  } finally {
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    });
  }
}
const refusedAncestor = (directory: string, reason: string): { message: string } => ({
  message: `provider-home ancestor ${directory} ${reason}; remove that write access or set ULTRAFUZZ_PROVIDER_HOME_ROOT to a directory outside it`
});
test(
  "provider homes default below a ~/.local that umask 0002 leaves writable to the operator's private group",
  underGroupWritableUmask(async () => {
    const { home, defaultRoot, accounts } = groupWritableHome(),
      resolve = await loadProviderHome(accounts),
      selected = path.join(defaultRoot, "codex", "teams", "codex");
    // Ubuntu lists no member for a user-private group; a host may list the user.
    for (const members of [[], ["operator"]]) {
      writeAccountFiles(accounts, { members });
      assert.equal(resolveUnderDefaultRoot(resolve, home), selected, members.join(","));
    }
    for (let current = selected; current !== path.dirname(path.dirname(defaultRoot)); current = path.dirname(current))
      assert.equal(fs.statSync(current).mode & 0o777, 0o700, current);
  })
);
test(
  "a group-writable provider-home ancestor is refused unless the account files show its group is the operator's alone",
  underGroupWritableUmask(async () => {
    const { home, local, accounts } = groupWritableHome(),
      resolve = await loadProviderHome(accounts),
      { uid, gid } = operatorIds(),
      teammate = `teammate:x:${uid + 1}:${gid}:Teammate:/home/teammate:/bin/sh`,
      refusal = refusedAncestor(local, "is group writable, and its group is not the operator's private group");
    const sharedOrUnknown: Record<string, () => void> = {
      "another member": () => writeAccountFiles(accounts, { members: ["operator", "teammate"] }),
      "another group entry with the same ID": () =>
        writeAccountFiles(accounts, { group: [`shared:x:${gid}:teammate`] }),
      "another account's primary group": () => writeAccountFiles(accounts, { passwd: [teammate] }),
      "another primary group for the operator": () => {
        writeAccountFiles(accounts);
        fs.writeFileSync(accounts.passwd, `operator:x:${uid}:${gid + 1}:Operator:/home/operator:/bin/sh\n`);
      },
      "no operator account": () => {
        writeAccountFiles(accounts);
        fs.writeFileSync(accounts.passwd, "");
      },
      "no group entry": () => {
        writeAccountFiles(accounts);
        fs.writeFileSync(accounts.group, `other:x:${gid + 1}:\n`);
      },
      "an unrecognized entry": () => writeAccountFiles(accounts, { group: ["+:::"] }),
      "no group file": () => {
        writeAccountFiles(accounts);
        fs.rmSync(accounts.group);
      }
    };
    for (const [reason, arrange] of Object.entries(sharedOrUnknown)) {
      arrange();
      assert.throws(() => resolveUnderDefaultRoot(resolve, home), refusal, reason);
      // The same directories pass once the account files show a private group again.
      writeAccountFiles(accounts);
      resolveUnderDefaultRoot(resolve, home);
    }
  })
);
test(
  "a world-writable provider-home ancestor is refused without the sticky bit, whatever its group",
  underGroupWritableUmask(async () => {
    const { home, local, accounts } = groupWritableHome(),
      resolve = await loadProviderHome(accounts);
    writeAccountFiles(accounts);
    resolveUnderDefaultRoot(resolve, home);
    for (const mode of [0o777, 0o757]) {
      fs.chmodSync(local, mode);
      assert.throws(
        () => resolveUnderDefaultRoot(resolve, home),
        refusedAncestor(local, "is world writable without the sticky bit"),
        mode.toString(8)
      );
    }
    // As in /tmp, only an entry's owner can rename or remove it.
    fs.chmodSync(local, 0o1777);
    resolveUnderDefaultRoot(resolve, home);
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
    fs.chmodSync(fixture, 0o777);
    process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = fixture;
    assert.throws(() => resolve("codex", "team"), refusedAncestor(fixture, "is world writable without the sticky bit"));
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
