import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SMITHERS_EXECUTABLE_CAPABILITY: unique symbol = Symbol("ultrafuzz.smithers-executable-capability");

interface FileIdentity {
  path: string;
  device: number;
  inode: number;
  size: number;
  sha256: string;
}

interface SmithersExecutableIdentity {
  runner: FileIdentity;
  interpreter: FileIdentity;
}

type CapableEnvironment = Record<string, string | undefined> & {
  [SMITHERS_EXECUTABLE_CAPABILITY]?: Readonly<SmithersExecutableIdentity>;
};

export interface SmithersExecutableAnchor {
  executable: string;
  argumentPrefix: readonly string[];
  assertCurrent(): void;
  close(): void;
}

/**
 * Binds both the runner bytes and the interpreter selected by its shebang to
 * an in-memory environment object. The private symbol prevents workflow or
 * process environment variables from manufacturing this authority.
 */
export function bindSmithersExecutableCapability<T extends Record<string, string | undefined>>(
  env: T,
  executable: string
): T {
  const runner = verifiedRegularFile(executable, true, "workflow runner");
  const interpreter = verifiedInterpreter(runner.path);
  (env as Record<string, string | undefined>).SMITHERS_BIN = runner.path;
  Object.defineProperty(env, SMITHERS_EXECUTABLE_CAPABILITY, {
    configurable: false,
    enumerable: true,
    writable: false,
    value: Object.freeze({ runner: Object.freeze(runner), interpreter: Object.freeze(interpreter) })
  });
  return env;
}

export function smithersExecutableCapability(
  env: Record<string, string | undefined> | undefined
): Readonly<SmithersExecutableIdentity> | undefined {
  return (env as CapableEnvironment | undefined)?.[SMITHERS_EXECUTABLE_CAPABILITY];
}

/**
 * Opens the already-attested runner and interpreter and executes both through
 * held descriptors. Digest and inode checks reject replacement inside a still
 * valid snapshot root, while directly invoking the resolved interpreter makes
 * a later PATH substitution irrelevant.
 */
export function acquireSmithersExecutableAnchor(
  env: Record<string, string | undefined> | undefined
): SmithersExecutableAnchor | undefined {
  const capability = smithersExecutableCapability(env);
  if (capability === undefined) return undefined;
  if (process.platform === "win32") {
    throw new Error("workflow runner capability requires executable descriptor paths on this platform");
  }
  const requested = env?.SMITHERS_BIN?.trim() || capability.runner.path;
  const runnerDescriptor = openRegularFileNoFollow(requested);
  let interpreterDescriptor: number | undefined;
  try {
    assertDescriptorIdentity(runnerDescriptor, capability.runner, "workflow runner");
    interpreterDescriptor = openRegularFileNoFollow(capability.interpreter.path);
    assertDescriptorIdentity(interpreterDescriptor, capability.interpreter, "workflow runner interpreter");
    const runnerPath = requiredExecutableDescriptorPath(runnerDescriptor, capability.runner, "workflow runner");
    const interpreterPath = requiredExecutableDescriptorPath(
      interpreterDescriptor,
      capability.interpreter,
      "workflow runner interpreter"
    );
    let closed = false;
    const assertCurrent = (): void => {
      if (closed) throw new Error("workflow runner executable anchor is already closed");
      assertDescriptorIdentity(runnerDescriptor, capability.runner, "workflow runner");
      assertDescriptorIdentity(interpreterDescriptor!, capability.interpreter, "workflow runner interpreter");
      assertPathIdentity(requested, capability.runner, "workflow runner");
      assertPathIdentity(capability.interpreter.path, capability.interpreter, "workflow runner interpreter");
    };
    assertCurrent();
    return {
      executable: interpreterPath,
      argumentPrefix: [runnerPath],
      assertCurrent,
      close: () => {
        if (closed) return;
        closed = true;
        closeFileDescriptors([interpreterDescriptor!, runnerDescriptor]);
      }
    };
  } catch (error) {
    try {
      closeFileDescriptors([...(interpreterDescriptor === undefined ? [] : [interpreterDescriptor]), runnerDescriptor]);
    } catch {
      // Preserve the identity/setup failure after attempting every close.
    }
    throw error;
  }
}

function closeFileDescriptors(descriptors: readonly number[]): void {
  let failed = false;
  let failure: unknown;
  for (const descriptor of descriptors) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
}

function verifiedRegularFile(executable: string, requireExecutable: boolean, label: string): FileIdentity {
  if (!path.isAbsolute(executable)) throw new Error(`${label} capability requires an absolute path`);
  const resolved = fs.realpathSync(executable);
  const descriptor = openRegularFileNoFollow(resolved);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} capability must name a regular file`);
    if (requireExecutable) fs.accessSync(resolved, fs.constants.X_OK);
    return {
      path: resolved,
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      sha256: digestDescriptor(descriptor)
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifiedInterpreter(runner: string): FileIdentity {
  const firstLine = fs.readFileSync(runner, "utf8").split(/\r?\n/u, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) throw new Error("workflow runner executable is missing an interpreter shebang");
  const words = firstLine.slice(2).trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) throw new Error("workflow runner executable has an invalid interpreter shebang");
  let interpreter: string;
  if (path.basename(words[0]!) === "env") {
    if (words.length !== 2 || words[1]!.startsWith("-")) {
      throw new Error("workflow runner executable uses an unsupported env interpreter shebang");
    }
    interpreter = resolveTrustedCommand(words[1]!);
  } else {
    if (words.length !== 1 || !path.isAbsolute(words[0]!)) {
      throw new Error("workflow runner executable requires one absolute interpreter");
    }
    interpreter = words[0]!;
  }
  return verifiedRegularFile(interpreter, true, "workflow runner interpreter");
}

function resolveTrustedCommand(command: string): string {
  if (command === "node") return process.execPath;
  const sourcePath = process.env.PATH ?? "";
  for (const entry of sourcePath.split(path.delimiter)) {
    if (entry.length === 0) continue;
    const candidate = path.resolve(entry, command);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync(candidate);
      }
    } catch {
      // Try the next trusted process PATH entry.
    }
  }
  throw new Error(`workflow runner interpreter is unavailable: ${command}`);
}

function openRegularFileNoFollow(filePath: string): number {
  return fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
}

function digestDescriptor(descriptor: number): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function assertDescriptorIdentity(descriptor: number, identity: FileIdentity, label: string): void {
  const stat = fs.fstatSync(descriptor);
  if (
    !stat.isFile() ||
    stat.dev !== identity.device ||
    stat.ino !== identity.inode ||
    stat.size !== identity.size ||
    digestDescriptor(descriptor) !== identity.sha256
  ) {
    throw new Error(`${label} changed at the controller command boundary`);
  }
}

function assertPathIdentity(filePath: string, identity: FileIdentity, label: string): void {
  const descriptor = openRegularFileNoFollow(filePath);
  try {
    assertDescriptorIdentity(descriptor, identity, label);
  } finally {
    fs.closeSync(descriptor);
  }
}

function requiredExecutableDescriptorPath(descriptor: number, identity: FileIdentity, label: string): string {
  const candidate = `/proc/${process.pid}/fd/${descriptor}`;
  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile() && stat.dev === identity.device && stat.ino === identity.inode) return candidate;
  } catch {
    // Fall through to the fail-closed unsupported-platform error.
  }
  throw new Error(`${label} cannot be executed safely without file-descriptor paths`);
}
