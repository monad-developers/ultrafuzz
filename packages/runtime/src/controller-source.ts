import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readSinglyLinkedRegularFileSnapshotInside } from "@ultrafuzz/artifacts";
import { loadRuntimeTemplate } from "./runtime-template.js";
const MAX_CONTROLLER_FILE_BYTES = 2 * 1024 * 1024,
  SNAPSHOT_PREFIX = ".smithers/agents/";
export const PROVIDER_SCOPED_SENSITIVE_ENVIRONMENT_CAPABILITY =
  "ultrafuzz.provider-scoped-sensitive-environment.v1" as const;
const PROVIDER_SCOPED_SENSITIVE_ENVIRONMENT_DECLARATION = Buffer.from(
  `export const PROVIDER_SCOPED_SENSITIVE_ENVIRONMENT_CAPABILITY =\n  "${PROVIDER_SCOPED_SENSITIVE_ENVIRONMENT_CAPABILITY}" as const;`,
  "utf8"
);
const UNTRUSTED_SOURCE =
  "controller adapter source must exactly match the packaged stock closure; rerun ultrafuzz init --force";
const CONTROLLER_NAMES =
  "claude codex deepseek environment index kimi opencode openrouter pi provider-home strict-json toml".split(" ");
export const STOCK_CONTROLLER_SOURCE_TEMPLATES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(CONTROLLER_NAMES.map((name) => [`${name}.ts`, `smithers/agents/${name}.tsx`]))
);
type ControllerFile = { name: string; contents: Buffer };
export type ControllerSourceInspection = Readonly<{ digest: string; stock: true; files: readonly string[] }>;
export type PackagedControllerSource = Readonly<{
  digest: string;
  stock: true;
  files: readonly Readonly<ControllerFile>[];
}>;
export function loadPackagedControllerSource(): PackagedControllerSource {
  const files = expectedControllerFiles();
  return { digest: controllerDigest(files), stock: true, files };
}
export function inspectControllerSource(projectRoot: string): ControllerSourceInspection {
  const root = path.join(path.resolve(projectRoot), ".smithers", "agents"),
    before = untrustedCall(() => fs.lstatSync(root, { bigint: true }));
  if (!before.isDirectory() || before.isSymbolicLink() || fs.realpathSync(root) !== root)
    throw untrustedControllerSource();
  const expected = loadPackagedControllerSource().files;
  assertExactNames(root, expected);
  const files = expected.map(({ name, contents: packaged }) => {
    const contents = untrustedCall(() =>
      readSinglyLinkedRegularFileSnapshotInside(
        root,
        path.join(root, name),
        MAX_CONTROLLER_FILE_BYTES,
        "controller adapter source"
      )
    );
    if (!contents.equals(packaged)) throw untrustedControllerSource();
    return { name, contents };
  });
  assertExactNames(root, expected);
  const after = fs.lstatSync(root, { bigint: true });
  if (!sameIdentity(before, after)) throw untrustedControllerSource();
  return { digest: controllerDigest(files), stock: true, files: files.map((file) => file.name) };
}
export function assertControllerSourceDigest(projectRoot: string, expectedDigest: string): ControllerSourceInspection {
  const inspected = inspectControllerSource(projectRoot);
  if (inspected.digest !== expectedDigest) throw controllerSourceChanged();
  return inspected;
}
export function assertControllerExecutionSnapshotDigest(
  executionFiles: readonly { snapshotPath: string; contents: Buffer }[],
  expectedDigest: string
): void {
  const files = executionFiles.flatMap(({ snapshotPath, contents }): ControllerFile[] => {
    if (!snapshotPath.startsWith(SNAPSHOT_PREFIX)) return [];
    const name = snapshotPath.slice(SNAPSHOT_PREFIX.length);
    if (name.includes("/") || name.includes("\\") || contents.byteLength > MAX_CONTROLLER_FILE_BYTES)
      throw controllerSourceChanged();
    return [{ name, contents }];
  });
  if (controllerDigest(files) !== expectedDigest) throw controllerSourceChanged();
}
export function assertProviderScopedSensitiveEnvironmentCapability(
  executionFiles: readonly { snapshotPath: string; contents: Buffer }[],
  sensitiveEnvironmentNames: string | undefined
): void {
  if ((sensitiveEnvironmentNames ?? "").trim().length === 0) return;
  const environment = executionFiles.find((file) => file.snapshotPath === `${SNAPSHOT_PREFIX}environment.ts`);
  if (environment === undefined || !environment.contents.includes(PROVIDER_SCOPED_SENSITIVE_ENVIRONMENT_DECLARATION)) {
    throw new Error(
      "sealed controller predates provider-scoped sensitive allowlisted environment handling; " +
        "rerun ultrafuzz init --force and start a new run"
    );
  }
}
function expectedControllerFiles(): ControllerFile[] {
  return Object.entries(STOCK_CONTROLLER_SOURCE_TEMPLATES)
    .map(([name, template]) => ({ name, contents: Buffer.from(loadRuntimeTemplate(template), "utf8") }))
    .sort((left, right) => compareStrings(left.name, right.name));
}
function assertExactNames(root: string, expected: readonly ControllerFile[]): void {
  const actual = fs.readdirSync(root).sort(compareStrings);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]?.name))
    throw untrustedControllerSource();
}
function controllerDigest(files: readonly ControllerFile[]): string {
  const hash = crypto.createHash("sha256").update("ultrafuzz-controller-source-v1\0");
  for (const { name, contents } of [...files].sort((left, right) => compareStrings(left.name, right.name))) {
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(Buffer.byteLength(name), 0);
    header.writeUInt32BE(contents.byteLength, 4);
    hash.update(header).update(name).update(contents);
  }
  return hash.digest("hex");
}
const sameIdentity = (left: fs.BigIntStats, right: fs.BigIntStats): boolean =>
  (["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const).every((field) => left[field] === right[field]);
const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
function untrustedCall<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw untrustedControllerSource(error);
  }
}
const untrustedControllerSource = (cause?: unknown): Error =>
  new Error(UNTRUSTED_SOURCE, cause === undefined ? undefined : { cause });
const controllerSourceChanged = (): Error => new Error("controller adapter source changed after validation");
