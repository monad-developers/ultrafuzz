import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Test files that stand in for what the provider-home adapter reads to decide
 * whether only the operator can write to a group-writable directory:
 * `/etc/passwd`, `/etc/group`, `/etc/nsswitch.conf`, and `/bin/ls`, here a
 * fake that logs each call to `lsCalls`. Without `ls`, the adapter runs the
 * host's `/bin/ls`.
 */
export type ProviderHomeHost = Readonly<{
  passwd: string;
  group: string;
  nsswitch: string;
  ls?: string;
  lsCalls: string;
}>;

/**
 * How the fake `ls` answers: the line it prints for `--version`, the mark it
 * prints after a directory's permissions or a whole listing in their place,
 * and its standard error and exit status.
 */
export type FakeLs = Readonly<{ version?: string; mark?: string; listing?: string; stderr?: string; status?: number }>;

/** A host whose files live in `directory`, with a fake `ls` unless `realLs`. */
export function providerHomeHost(directory: string, options: { realLs?: boolean } = {}): ProviderHomeHost {
  return {
    passwd: path.join(directory, "passwd"),
    group: path.join(directory, "group"),
    nsswitch: path.join(directory, "nsswitch.conf"),
    ...(options.realLs === true ? {} : { ls: path.join(directory, "ls") }),
    lsCalls: path.join(directory, "ls-calls")
  };
}

/**
 * The provider-home adapter source, reading `host`'s files instead of the
 * host's own. Each path must occur exactly once, so a renamed constant fails
 * the test instead of quietly reading the host's files.
 */
export function readingHost(source: string, host: ProviderHomeHost): string {
  let rewritten = source;
  for (const [hostFile, testFile] of [
    ["/etc/passwd", host.passwd],
    ["/etc/group", host.group],
    ["/etc/nsswitch.conf", host.nsswitch],
    ["/bin/ls", host.ls]
  ] as const) {
    const literal = JSON.stringify(hostFile);
    assert.equal(rewritten.split(literal).length, 2, `the provider-home source must name ${hostFile} exactly once`);
    if (testFile !== undefined) rewritten = rewritten.replace(literal, JSON.stringify(testFile));
  }
  return rewritten;
}

/**
 * Writes a host like Ubuntu's: the test process's user, named `operator`, is
 * the only account with its primary group, a user-private group; accounts and
 * groups come from the files and systemd; and `ls` is GNU's and shows no ACL.
 * The options add names to that group's member list, append other entries,
 * replace `nsswitch.conf`, and change how the fake `ls` answers.
 */
export function writeHost(
  host: ProviderHomeHost,
  options: {
    members?: readonly string[];
    passwd?: readonly string[];
    group?: readonly string[];
    nsswitch?: string;
    ls?: FakeLs;
  } = {}
): void {
  const { uid, gid } = operatorIds();
  const lines = (entries: readonly string[]): string => entries.map((entry) => `${entry}\n`).join("");
  fs.writeFileSync(
    host.passwd,
    lines([`operator:x:${uid}:${gid}:Operator:/home/operator:/bin/sh`, ...(options.passwd ?? [])]),
    "utf8"
  );
  fs.writeFileSync(
    host.group,
    lines([`operator:x:${gid}:${(options.members ?? []).join(",")}`, ...(options.group ?? [])]),
    "utf8"
  );
  fs.writeFileSync(host.nsswitch, options.nsswitch ?? "passwd: files systemd\ngroup: files systemd\n", "utf8");
  fs.writeFileSync(host.lsCalls, "", "utf8");
  if (host.ls !== undefined) writeFakeLs(host.ls, host.lsCalls, options.ls ?? {});
}

/**
 * The calls the fake `ls` has had since the host was written, one per entry:
 * its `LC_ALL` and `HOME`, each `unset` when absent, then its arguments.
 */
export function lsCalls(host: ProviderHomeHost): string[] {
  return fs.readFileSync(host.lsCalls, "utf8").split("\n").filter(Boolean);
}

/**
 * The directories from the root down to `directory` that are group writable
 * without the sticky bit: the ones whose group the adapter checks. Below a
 * group-writable temporary directory, the first is not the fixture's own.
 */
export function groupWritableAncestors(directory: string): string[] {
  const ancestors: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    if ((fs.lstatSync(current).mode & 0o1020) === 0o020) ancestors.unshift(current);
    if (current === path.dirname(current)) return ancestors;
  }
}

/** The test process's user and primary group IDs. */
export function operatorIds(): { uid: number; gid: number } {
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  assert.ok(uid !== undefined && gid !== undefined, "provider-home host files need POSIX user and group IDs");
  return { uid, gid };
}

function writeFakeLs(file: string, calls: string, ls: FakeLs): void {
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  const listing =
    ls.listing === undefined
      ? `printf '%s 2 operator operator 4096 Jan  1 00:00 %s\\n' ${quote(`drwxrwxr-x${ls.mark ?? ""}`)} "$3"`
      : `printf '%s\\n' ${quote(ls.listing)}`;
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      `printf '%s %s %s\\n' "\${LC_ALL-unset}" "\${HOME-unset}" "$*" >> ${quote(calls)}`,
      'if [ "$1" = --version ]; then',
      `  printf '%s\\n' ${quote(ls.version ?? "ls (GNU coreutils) 9.4")}`,
      "else",
      `  ${listing}`,
      "fi",
      `printf '%s' ${quote(ls.stderr ?? "")} >&2`,
      `exit ${String(ls.status ?? 0)}`,
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(file, 0o700);
}
