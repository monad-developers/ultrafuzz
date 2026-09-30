import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { temporaryRoot } from "./temporary-root.js";
import {
  type FakeLs,
  type ProviderHomeHost,
  groupWritableAncestors,
  lsCalls,
  operatorIds,
  providerHomeHost,
  readingHost,
  writeHost
} from "./provider-home-host.js";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { loadRuntimeTemplate } from "../src/runtime-template.js";
import { underGroupWritableUmask } from "./process-umask.js";
type ResolveProviderHome = (provider: string, configured?: string) => string;
/** The adapter's provider-home module, reading `host` instead of the host's own files when given. */
async function loadProviderHome(host?: ProviderHomeHost): Promise<ResolveProviderHome> {
  const fixture = temporaryRoot("ufz-provider-home-module-"),
    modulePath = path.join(fixture, "provider-home.mjs"),
    source = loadRuntimeTemplate("smithers/agents/provider-home.tsx");
  const compiled = ts.transpileModule(host === undefined ? source : readingHost(source, host), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  fs.writeFileSync(modulePath, compiled, "utf8");
  return ((await import(pathToFileURL(modulePath).href)) as { resolveProviderHome: ResolveProviderHome })
    .resolveProviderHome;
}
/**
 * A home as Ubuntu's default umask 0002 leaves it: `~/.local` and
 * `~/.local/state` are group writable, and belong to the operator and the
 * operator's primary group. Each test writes the host files.
 */
function groupWritableHome(options: { realLs?: boolean } = {}): {
  home: string;
  local: string;
  defaultRoot: string;
  host: ProviderHomeHost;
} {
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
    host: providerHomeHost(fixture, options)
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
/** Runs `operation` as if the process had these user and primary group IDs. */
function asProcessIds<T>(uid: number, gid: number, operation: () => T): T {
  const { getuid, getgid } = process;
  process.getuid = () => uid;
  process.getgid = () => gid;
  try {
    return operation();
  } finally {
    process.getuid = getuid;
    process.getgid = getgid;
  }
}
const refusedAncestor = (directory: string, reason: string): { message: string } => ({
  message: `provider-home ancestor ${directory} ${reason}; remove that write access or set ULTRAFUZZ_PROVIDER_HOME_ROOT to a directory outside it`
});
const notPrivate = "is group writable, and its group is not the operator's private group",
  aclUnknown = "is group writable, and ls cannot show whether it has an ACL";
test(
  "provider homes default below a ~/.local that umask 0002 leaves writable to the operator's private group",
  underGroupWritableUmask(async () => {
    const { home, local, defaultRoot, host } = groupWritableHome(),
      resolve = await loadProviderHome(host),
      selected = path.join(defaultRoot, "codex", "teams", "codex"),
      // ls, with a fixed locale and no other setting from the operator's
      // environment, shows that each group-writable ancestor has no ACL.
      probes = [
        "C unset --version",
        ...groupWritableAncestors(path.join(local, "state")).map((directory) => `C unset -ld -- ${directory}`)
      ];
    // Ubuntu lists no member for a user-private group; a host may list the user.
    for (const members of [[], ["operator"]]) {
      writeHost(host, { members });
      assert.equal(resolveUnderDefaultRoot(resolve, home), selected, members.join(","));
      assert.deepEqual([...new Set(lsCalls(host))], probes, members.join(","));
    }
    for (let current = selected; current !== path.dirname(path.dirname(defaultRoot)); current = path.dirname(current))
      assert.equal(fs.statSync(current).mode & 0o777, 0o700, current);
  })
);
test(
  "a group-writable provider-home ancestor is refused unless the account files show its group is the operator's alone",
  underGroupWritableUmask(async () => {
    const { home, local, host } = groupWritableHome(),
      resolve = await loadProviderHome(host),
      { uid, gid } = operatorIds(),
      // An account with its own primary group, so only the member lists can share the operator's.
      teammate = `teammate:x:${uid + 1}:${gid + 1}:Teammate:/home/teammate:/bin/sh`,
      refusal = refusedAncestor(groupWritableAncestors(local)[0] ?? local, notPrivate);
    const sharedOrUnknown: Record<string, () => void> = {
      "another member": () => writeHost(host, { members: ["operator", "teammate"], passwd: [teammate] }),
      "another group entry with the same ID": () =>
        writeHost(host, { passwd: [teammate], group: [`shared:x:${gid}:teammate`] }),
      "another account's primary group": () =>
        writeHost(host, { passwd: [`teammate:x:${uid + 1}:${gid}:Teammate:/home/teammate:/bin/sh`] }),
      // Group membership goes by name, so the other account named operator has the group too.
      "a member name another account also has": () =>
        writeHost(host, {
          members: ["operator"],
          passwd: [`operator:x:${uid + 1}:${gid + 1}:Operator:/home/operator:/bin/sh`]
        }),
      "another primary group for the operator": () => {
        writeHost(host);
        fs.writeFileSync(host.passwd, `operator:x:${uid}:${gid + 1}:Operator:/home/operator:/bin/sh\n`);
      },
      "no operator account": () => {
        writeHost(host);
        fs.writeFileSync(host.passwd, "");
      },
      "no group entry": () => {
        writeHost(host);
        fs.writeFileSync(host.group, `other:x:${gid + 1}:\n`);
      },
      "an unrecognized entry": () => writeHost(host, { group: ["+:::"] }),
      "no group file": () => {
        writeHost(host);
        fs.rmSync(host.group);
      }
    };
    for (const [reason, arrange] of Object.entries(sharedOrUnknown)) {
      arrange();
      assert.throws(() => resolveUnderDefaultRoot(resolve, home), refusal, reason);
      // The same directories pass once the account files show a private group again.
      writeHost(host);
      resolveUnderDefaultRoot(resolve, home);
    }
  })
);
test(
  "a group-writable provider-home ancestor is refused unless nsswitch.conf limits accounts and groups to the local files and systemd",
  underGroupWritableUmask(async () => {
    const { home, local, host } = groupWritableHome(),
      resolve = await loadProviderHome(host),
      refusal = refusedAncestor(
        groupWritableAncestors(local)[0] ?? local,
        "is group writable, and /etc/nsswitch.conf does not limit accounts and groups to the local files and systemd"
      );
    for (const nsswitch of [
      "passwd: compat\ngroup: compat\n",
      "passwd:files systemd # sss\n  group: files [SUCCESS=merge] systemd\ninitgroups: files [ NOTFOUND=return ]\n"
    ]) {
      writeHost(host, { nsswitch });
      resolveUnderDefaultRoot(resolve, home);
    }
    const otherSources: Record<string, string | undefined> = {
      "SSSD accounts": "passwd: files sss\ngroup: files sss\n",
      "LDAP groups": "passwd: files\ngroup: files ldap\n",
      "a supplementary-group source": "passwd: files\ngroup: files\ninitgroups: files winbind\n",
      // glibc versions differ on which line for a database they use.
      "an earlier line for a database": "passwd: files\ngroup: files ldap\ngroup: files\n",
      "a later line for a database": "passwd: files\ngroup: files\ngroup: files ldap\n",
      "a database name in capitals": "passwd: files\ngroup: files\nGROUP: ldap\n",
      "no passwd line": "group: files\n",
      "no group line": "passwd: files\n",
      "no service": "passwd:\ngroup: files\n",
      "an unclosed action": "passwd: files\ngroup: files [SUCCESS=merge systemd\n",
      "no nsswitch.conf": undefined
    };
    for (const [reason, nsswitch] of Object.entries(otherSources)) {
      writeHost(host, { nsswitch: nsswitch ?? "" });
      if (nsswitch === undefined) fs.rmSync(host.nsswitch);
      assert.throws(() => resolveUnderDefaultRoot(resolve, home), refusal, reason);
      writeHost(host);
      resolveUnderDefaultRoot(resolve, home);
    }
  })
);
test(
  "a group-writable provider-home ancestor is refused unless GNU or uutils ls shows it has no ACL",
  underGroupWritableUmask(async () => {
    const { home, local, host } = groupWritableHome(),
      resolve = await loadProviderHome(host),
      first = groupWritableAncestors(local)[0] ?? local,
      fakeLs = host.ls,
      uutils = "ls (uutils coreutils) 0.8.0";
    assert.ok(fakeLs !== undefined);
    // With an ACL, the group bits are its mask, the most that a named user or group entry grants.
    const refusals: Record<string, [FakeLs, string]> = {
      "an ACL": [{ mark: "+" }, "is group writable, and ls marks it as having an ACL"],
      "an ACL, or another extended attribute, under uutils": [
        { version: uutils, mark: "+" },
        "is group writable, and ls marks it as having an ACL"
      ],
      // uutils prints "." instead of "+" when there is also a security context.
      "a security context under uutils": [{ version: uutils, mark: "." }, aclUnknown],
      // Before 0.1.0, uutils did not name itself in --version; before 0.0.24 it marked no ACL.
      "an older uutils": [{ version: "/bin/ls 0.0.30" }, aclUnknown],
      "another ls": [{ version: "BusyBox v1.36.1 (2024-06-10 07:11:47 UTC) multi-call binary." }, aclUnknown],
      "an unknown ACL state": [{ mark: "?" }, aclUnknown],
      "a failed ls": [{ status: 2 }, aclUnknown],
      "an ls diagnostic": [{ stderr: "ls: cannot read ACL\n" }, aclUnknown],
      "an unrecognized listing": [{ listing: "total 0" }, aclUnknown],
      "no ls": [{}, aclUnknown]
    };
    for (const [reason, [ls, refusal]] of Object.entries(refusals)) {
      writeHost(host, { ls });
      if (reason === "no ls") fs.rmSync(fakeLs);
      assert.throws(() => resolveUnderDefaultRoot(resolve, home), refusedAncestor(first, refusal), reason);
      writeHost(host);
      resolveUnderDefaultRoot(resolve, home);
    }
    // No mark from uutils means no extended attribute at all, and GNU marks a
    // security context alone, such as SELinux's, with ".": neither grants access.
    for (const ls of [{ version: uutils }, { version: "ls (uutils coreutils) 1.0.0" }, { mark: "." }]) {
      writeHost(host, { ls });
      resolveUnderDefaultRoot(resolve, home);
    }
  })
);
test(
  "the host's /bin/ls shows the group-writable ancestors of a new home have no ACL when it is GNU's or uutils'",
  underGroupWritableUmask(async () => {
    const { home, local, host } = groupWritableHome({ realLs: true }),
      resolve = await loadProviderHome(host),
      version = spawnSync("/bin/ls", ["--version"], { encoding: "utf8" }).stdout ?? "";
    writeHost(host);
    if (/^ls \((?:GNU|uutils) coreutils\) /u.test(version)) resolveUnderDefaultRoot(resolve, home);
    else
      assert.throws(
        () => resolveUnderDefaultRoot(resolve, home),
        refusedAncestor(groupWritableAncestors(local)[0] ?? local, aclUnknown)
      );
  })
);
test(
  "the process's user and primary group, not the account files, decide who the operator is",
  underGroupWritableUmask(async () => {
    const { home, local, host } = groupWritableHome(),
      resolve = await loadProviderHome(host),
      { uid, gid } = operatorIds();
    writeHost(host);
    resolveUnderDefaultRoot(resolve, home);
    // A directory's owner can change its mode, so one that another account owns
    // is refused even when no one else can write to it.
    let owned = home;
    for (let current = home; current !== path.dirname(current); current = path.dirname(current))
      if (fs.lstatSync(current).uid !== 0) owned = current;
    assert.throws(() => asProcessIds(uid + 1, gid, () => resolveUnderDefaultRoot(resolve, home)), {
      message: `provider-home ancestor ${owned} is owned by another account; set ULTRAFUZZ_PROVIDER_HOME_ROOT to a directory outside it`
    });
    // After newgrp, for example, the directory's group is no longer the process's primary group.
    assert.throws(
      () => asProcessIds(uid, gid + 1, () => resolveUnderDefaultRoot(resolve, home)),
      refusedAncestor(groupWritableAncestors(local)[0] ?? local, notPrivate)
    );
  })
);
test(
  "a world-writable provider-home ancestor is refused without the sticky bit, whatever its group",
  underGroupWritableUmask(async () => {
    const { home, local, host } = groupWritableHome(),
      resolve = await loadProviderHome(host);
    writeHost(host);
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
