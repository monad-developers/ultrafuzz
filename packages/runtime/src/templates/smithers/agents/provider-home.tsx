import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u,
  CANONICAL_HOMES: Readonly<Record<string, { env: readonly string[]; relative: string }>> = {
    claude: { env: ["CLAUDE_CONFIG_DIR"], relative: ".claude" },
    codex: { env: ["CODEX_HOME"], relative: ".codex" },
    kimi: { env: ["KIMI_CODE_HOME", "KIMI_SHARE_DIR"], relative: ".kimi-code" }
  },
  // What can show that only the operator can write to a group-writable
  // ancestor: the local account files, the name-service configuration that
  // says no other source adds accounts or groups, and ls, which marks a
  // directory that has an ACL. Node and Bun cannot read ACLs themselves.
  PASSWD_FILE = "/etc/passwd",
  GROUP_FILE = "/etc/group",
  NSSWITCH_FILE = "/etc/nsswitch.conf",
  LS = "/bin/ls",
  // `compat` also reads the files; the NIS entries it would add are refused as
  // unrecognized. systemd adds only records that root defines.
  LOCAL_NAME_SERVICES: ReadonlySet<string> = new Set(["files", "compat", "systemd"]),
  // A fixed locale, and no ls setting, such as TIME_STYLE, from the operator's environment.
  LS_OPTIONS = { encoding: "utf8", env: { LC_ALL: "C" } } as const;
export function resolveProviderHome(provider: string, configured?: string): string {
  const selectedRoot = process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT?.trim();
  if (configured === undefined && !selectedRoot) {
    const canonical = CANONICAL_HOMES[provider];
    if (canonical !== undefined) {
      const envHome = canonical.env.map((name) => process.env[name]?.trim()).find(Boolean);
      return prepareProviderHome(envHome ?? path.join(os.homedir(), canonical.relative));
    }
  }
  const relative = configured ?? "",
    components = configured === undefined ? [] : relative.split("/");
  if (
    configured !== undefined &&
    (relative.length === 0 ||
      relative.length > 1024 ||
      path.isAbsolute(relative) ||
      relative.includes("\\") ||
      components.some((component) => component === "." || component === ".." || !SAFE_COMPONENT.test(component)))
  )
    throw new Error("agent config_dir must be a safe relative path beneath the Ultrafuzz provider-home root");
  const root = selectedRoot || defaultProviderRoot();
  if (!path.isAbsolute(root)) throw new Error("ULTRAFUZZ_PROVIDER_HOME_ROOT must be an absolute operator-owned path");
  return prepareProviderHome(path.join(prepareProviderHome(root), provider, ...components));
}
function prepareProviderHome(candidate: string): string {
  if (!path.isAbsolute(candidate)) throw new Error("operator-owned provider-home paths must be absolute");
  const lexical = path.resolve(candidate);
  let current = path.parse(lexical).root;
  for (const component of lexical.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      assertSafeDirectory(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      mkdirSync(current, { mode: 0o700 });
      assertSafeDirectory(current, false);
    }
  }
  if (realpathSync(lexical) !== lexical) throw new Error("operator-owned provider home cannot cross symbolic links");
  const final = lstatSync(lexical);
  if ((final.mode & 0o777) !== 0o700 || (typeof process.getuid === "function" && final.uid !== process.getuid()))
    throw new Error("provider homes must be operator-owned with private 0700 permissions");
  return lexical;
}
function assertSafeDirectory(candidate: string, checkPermissions = true): void {
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe provider-home component");
  if (!checkPermissions) return;
  // A directory's owner can change its permissions, and can rename its entries even when it is sticky.
  if (stat.uid !== 0 && stat.uid !== process.getuid?.())
    throw new Error(
      `provider-home ancestor ${candidate} is owned by another account; set ULTRAFUZZ_PROVIDER_HOME_ROOT to a directory outside it`
    );
  // In a sticky directory, such as /tmp, only root, the directory's owner and
  // an entry's owner can rename or remove the entry.
  if ((stat.mode & 0o1000) !== 0) return;
  if ((stat.mode & 0o002) !== 0) throw writableAncestor(candidate, "is world writable without the sticky bit");
  const refusal = (stat.mode & 0o020) === 0 ? undefined : groupWriteRefusal(candidate, stat.uid, stat.gid);
  if (refusal !== undefined) throw writableAncestor(candidate, refusal);
}
const writableAncestor = (candidate: string, reason: string): Error =>
  new Error(
    `provider-home ancestor ${candidate} ${reason}; remove that write access or set ULTRAFUZZ_PROVIDER_HOME_ROOT to a directory outside it`
  );
/**
 * Why another account may be able to write to a group-writable directory with
 * this owner and group, or undefined when only the operator can: the operator
 * owns it, the host's account sources show its group to be the operator's
 * user-private group, which Ubuntu's default umask 0002 relies on, and ls
 * shows it has no ACL. What cannot be shown counts as shared.
 */
function groupWriteRefusal(directory: string, owner: number, group: number): string | undefined {
  const notPrivate = "is group writable, and its group is not the operator's private group";
  if (owner !== process.getuid?.() || group !== process.getgid?.()) return notPrivate;
  if (!takesAccountsFromLocalFiles())
    return "is group writable, and /etc/nsswitch.conf does not limit accounts and groups to the local files and systemd";
  if (!isOperatorPrivateGroup(owner, group)) return notPrivate;
  const acl = lsShowsAcl(directory);
  if (acl === true) return "is group writable, and ls marks it as having an ACL";
  return acl === undefined ? "is group writable, and ls cannot show whether it has an ACL" : undefined;
}
/**
 * Whether the local account files show `group` to be the operator's private
 * group: the operator's /etc/passwd account has it as its primary group, no
 * other account does, and /etc/group lists no member but the operator.
 * Membership goes by name, so a member name that another account also has
 * counts as that account's. An unreadable file or unrecognized entry, and an
 * operator account or group missing from the files, as with LDAP, count as
 * shared.
 */
function isOperatorPrivateGroup(owner: number, group: number): boolean {
  try {
    const accounts = accountFileEntries(PASSWD_FILE, 7).map(([name, , uid, gid]) => ({
        name,
        uid: Number(uid),
        gid: Number(gid)
      })),
      isOperatorName = (name: string): boolean =>
        accounts.some((account) => account.name === name) &&
        accounts.every((account) => account.name !== name || account.uid === owner),
      groups = accountFileEntries(GROUP_FILE, 4).filter(([, , gid]) => Number(gid) === group);
    return (
      accounts.some((account) => account.uid === owner && account.gid === group) &&
      accounts.every((account) => account.uid === owner || account.gid !== group) &&
      groups.length > 0 &&
      groups.every(([, , , members]) => members.split(",").every((member) => member === "" || isOperatorName(member)))
    );
  } catch {
    return false;
  }
}
/** An account file's entries: `fields` colon-separated fields each, with numeric IDs after the name and password. */
function accountFileEntries(file: string, fields: 4 | 7): string[][] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((entry) => entry.trim() !== "" && !entry.startsWith("#"))
    .map((entry) => {
      const values = entry.split(":");
      if (values.length !== fields || !values.slice(2, fields === 7 ? 4 : 3).every((id) => /^\d+$/u.test(id)))
        throw new Error(`${file} has an unrecognized entry`);
      return values;
    });
}
/**
 * Whether /etc/nsswitch.conf takes accounts, groups and supplementary groups
 * only from the local files and systemd. Another source, such as LDAP or
 * SSSD, can give the operator's group to accounts the files do not list.
 * Every line for those databases counts, since glibc versions differ on
 * which one they use, and a missing passwd or group line or an unreadable
 * file counts as another source.
 */
function takesAccountsFromLocalFiles(): boolean {
  try {
    const services = new Map<string, string[]>();
    for (const line of readFileSync(NSSWITCH_FILE, "utf8").split("\n")) {
      // As glibc reads it: a comment starts at "#", and spaces or colons end the database name.
      const [, name, specification] = /^([^\s:]+)[\s:]*(.*)$/u.exec(line.replace(/#.*/u, "").trim()) ?? [];
      // Database names are compared in lower case, which can only refuse more.
      const database = name?.toLowerCase();
      if (database === undefined || !["passwd", "group", "initgroups"].includes(database)) continue;
      // An action in brackets, such as [SUCCESS=merge], names no service; an
      // unclosed one leaves a name that no service has.
      const named = (specification ?? "").replace(/\[[^\]]*\]/gu, " ");
      services.set(database, [...(services.get(database) ?? []), ...named.split(/\s+/u).filter(Boolean)]);
    }
    return (
      services.has("passwd") &&
      services.has("group") &&
      [...services.values()].every(
        (list) => list.length > 0 && list.every((service) => LOCAL_NAME_SERVICES.has(service))
      )
    );
  } catch {
    return false;
  }
}
/**
 * Whether ls shows that a directory has an ACL: true when it marks one, false
 * when it shows there is none, undefined when it cannot show either. With an
 * ACL, the group permission bits are the ACL mask, the most that any named
 * user or group entry grants. GNU ls marks an ACL with "+" and a security
 * context alone, such as SELinux's, with ".". The uutils ls that Ubuntu 26.04
 * uses marks any extended attribute with "+", but prints "." in its place when
 * there is a security context; releases before 0.1.0 do not name themselves in
 * --version, and those before 0.0.24 mark nothing. Another ls, such as
 * BusyBox's, a failed ls, and a listing that does not start with a directory's
 * mode cannot show it.
 */
function lsShowsAcl(directory: string): boolean | undefined {
  const version = spawnSync(LS, ["--version"], LS_OPTIONS),
    listing = spawnSync(LS, ["-ld", "--", directory], LS_OPTIONS);
  if ([version, listing].some((result) => result.status !== 0 || result.stderr !== "")) return undefined;
  const gnu = version.stdout.startsWith("ls (GNU coreutils) "),
    mark = /^d[-rwxsStT]{9}([.+]?) /u.exec(listing.stdout)?.[1];
  if (!gnu && !version.stdout.startsWith("ls (uutils coreutils) ")) return undefined;
  if (mark === "+") return true;
  return mark === "" || (gnu && mark === ".") ? false : undefined;
}
const defaultProviderRoot = (): string =>
  path.join(
    process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state"),
    "ultrafuzz/provider-homes"
  );
