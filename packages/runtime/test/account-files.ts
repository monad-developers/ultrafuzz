import assert from "node:assert/strict";
import fs from "node:fs";

/** Files in the `/etc/passwd` and `/etc/group` formats that a test writes. */
export type AccountFiles = Readonly<{ passwd: string; group: string }>;

/**
 * The provider-home adapter source, reading `files` instead of the host's
 * `/etc/passwd` and `/etc/group`, so a test decides who shares a group.
 */
export function readingAccountFiles(source: string, files: AccountFiles): string {
  let rewritten = source;
  for (const [hostFile, testFile] of [
    ["/etc/passwd", files.passwd],
    ["/etc/group", files.group]
  ] as const) {
    const literal = JSON.stringify(hostFile);
    assert.equal(rewritten.split(literal).length, 2, `the provider-home source must name ${hostFile} exactly once`);
    rewritten = rewritten.replace(literal, JSON.stringify(testFile));
  }
  return rewritten;
}

/**
 * Writes account files in which the test process's user, named `operator`,
 * is the only account with its primary group: a user-private group. The
 * options add names to that group's member list and append other entries.
 */
export function writeAccountFiles(
  files: AccountFiles,
  options: { members?: readonly string[]; passwd?: readonly string[]; group?: readonly string[] } = {}
): void {
  const { uid, gid } = operatorIds();
  const lines = (entries: readonly string[]): string => entries.map((entry) => `${entry}\n`).join("");
  fs.writeFileSync(
    files.passwd,
    lines([`operator:x:${uid}:${gid}:Operator:/home/operator:/bin/sh`, ...(options.passwd ?? [])]),
    "utf8"
  );
  fs.writeFileSync(
    files.group,
    lines([`operator:x:${gid}:${(options.members ?? []).join(",")}`, ...(options.group ?? [])]),
    "utf8"
  );
}

/** The test process's user and primary group IDs. */
export function operatorIds(): { uid: number; gid: number } {
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  assert.ok(uid !== undefined && gid !== undefined, "account files need POSIX user and group IDs");
  return { uid, gid };
}
