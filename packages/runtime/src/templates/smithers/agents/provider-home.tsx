import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u,
  CANONICAL_HOMES: Readonly<Record<string, { env: readonly string[]; relative: string }>> = {
    claude: { env: ["CLAUDE_CONFIG_DIR"], relative: ".claude" },
    codex: { env: ["CODEX_HOME"], relative: ".codex" },
    kimi: { env: ["KIMI_CODE_HOME", "KIMI_SHARE_DIR"], relative: ".kimi-code" }
  },
  // The local account files that can show a group-writable ancestor's group
  // to be the operator's private group.
  PASSWD_FILE = "/etc/passwd",
  GROUP_FILE = "/etc/group";
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
  // In a sticky directory, such as /tmp, only an entry's owner can rename or remove it.
  if (!checkPermissions || (stat.mode & 0o1000) !== 0) return;
  if ((stat.mode & 0o002) !== 0) throw writableAncestor(candidate, "is world writable without the sticky bit");
  if ((stat.mode & 0o020) !== 0 && !isOperatorPrivateGroup(stat.uid, stat.gid))
    throw writableAncestor(candidate, "is group writable, and its group is not the operator's private group");
}
const writableAncestor = (candidate: string, reason: string): Error =>
  new Error(
    `provider-home ancestor ${candidate} ${reason}; remove that write access or set ULTRAFUZZ_PROVIDER_HOME_ROOT to a directory outside it`
  );
/**
 * Whether no other account can write to a group-writable directory with this
 * owner and group: the operator owns it, the group is the operator's primary
 * group, and the local account files give that group to nobody else. This is
 * the user-private group that Ubuntu's default umask 0002 relies on. What the
 * files cannot show counts as shared: an unreadable file or unrecognized
 * entry, and an operator account or group missing from them, as with LDAP.
 */
function isOperatorPrivateGroup(owner: number, group: number): boolean {
  if (owner !== process.getuid?.() || group !== process.getgid?.()) return false;
  try {
    const accounts = accountFileEntries(PASSWD_FILE, 7).map(([name, , uid, gid]) => ({
        name,
        uid: Number(uid),
        gid: Number(gid)
      })),
      operator = accounts.filter((account) => account.uid === owner),
      operatorNames = new Set(operator.map((account) => account.name)),
      groups = accountFileEntries(GROUP_FILE, 4).filter(([, , gid]) => Number(gid) === group);
    return (
      operator.some((account) => account.gid === group) &&
      !accounts.some((account) => account.uid !== owner && account.gid === group) &&
      groups.length > 0 &&
      groups.every(([, , , members]) =>
        members.split(",").every((member) => member === "" || operatorNames.has(member))
      )
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
const defaultProviderRoot = (): string =>
  path.join(
    process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state"),
    "ultrafuzz/provider-homes"
  );
