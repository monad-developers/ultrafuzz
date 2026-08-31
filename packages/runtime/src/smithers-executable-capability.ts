import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SMITHERS_EXECUTABLE_CAPABILITY: unique symbol = Symbol("ultrafuzz.smithers-executable-capability");
const TARGET_LOCAL_DELEGATION_ANCHOR = "if (!delegateToLocalCliIfPresent()) {";

interface FileIdentity {
  path: string;
  device: number;
  inode: number;
  size: number;
  sha256: string;
}

interface SmithersExecutableIdentity {
  runner: FileIdentity;
  interpreter: FileIdentity & { runtime: "bun" | "other" };
  bunStartup?: Readonly<{ confinement: FileIdentity; config: FileIdentity; environment: FileIdentity }>;
  operatorController?: Readonly<{ root: string; assertCurrent: () => void; nativeContinuation: boolean }>;
}
type Forbidden = Readonly<{ lexical: string; real: string }>;

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
 * Descriptor-path discovery is injectable so the lexical fallback can be
 * exercised on every development platform. Returned paths are never trusted:
 * acquisition verifies that they still name the held descriptor identity.
 */
export interface SmithersExecutableAnchorDependencies {
  executableDescriptorPath(descriptor: number): string | undefined;
}

const DEFAULT_ANCHOR_DEPENDENCIES: SmithersExecutableAnchorDependencies = {
  executableDescriptorPath
};

/**
 * Binds both the runner bytes and the interpreter selected by its shebang to
 * an in-memory environment object. The private symbol prevents workflow or
 * process environment variables from manufacturing this authority.
 */
export function bindSmithersExecutableCapability<T extends Record<string, string | undefined>>(
  env: T,
  executable: string,
  forbiddenRoot?: string
): T {
  return bindSmithersExecutableCapabilityInternal(env, executable, forbiddenRoot);
}

export function bindOperatorSmithersExecutableCapability<T extends Record<string, string | undefined>>(
  env: T,
  executable: string,
  operatorRoot: string,
  assertCurrent: () => void,
  forbiddenRoot?: string,
  nativeContinuation = false
): T {
  const root = fs.realpathSync(path.resolve(operatorRoot));
  assertCurrent();
  if (!pathInside(root, path.resolve(executable)) || !pathInside(root, fs.realpathSync(executable))) {
    throw new Error("operator workflow runner must be inside its controller root");
  }
  const bound = bindSmithersExecutableCapabilityInternal(env, executable, forbiddenRoot, {
    root,
    assertCurrent,
    nativeContinuation
  });
  const capability = smithersExecutableCapability(bound)!;
  if (!pathInside(root, capability.runner.path)) {
    throw new Error("operator workflow runner must be inside its controller root");
  }
  assertCurrent();
  return bound;
}

function bindSmithersExecutableCapabilityInternal<T extends Record<string, string | undefined>>(
  env: T,
  executable: string,
  forbiddenRoot?: string,
  operatorController?: Readonly<{ root: string; assertCurrent: () => void; nativeContinuation: boolean }>
): T {
  const forbidden =
    forbiddenRoot === undefined
      ? undefined
      : { lexical: path.resolve(forbiddenRoot), real: fs.realpathSync(path.resolve(forbiddenRoot)) };
  const runner = verifiedRegularFile(executable, true, "workflow runner");
  if (readVerifiedFile(runner, "workflow runner").includes(TARGET_LOCAL_DELEGATION_ANCHOR))
    throw new Error("workflow runner can delegate controller authority to target code");
  const interpreter = verifiedInterpreter(runner, forbidden);
  const bunStartup =
    interpreter.runtime === "bun" && env.ULTRAFUZZ_BUN_MODULE_CONFINEMENT
      ? verifiedBunStartupControls(env.ULTRAFUZZ_BUN_MODULE_CONFINEMENT, runner)
      : undefined;
  (env as Record<string, string | undefined>).SMITHERS_BIN = runner.path;
  Object.defineProperty(env, SMITHERS_EXECUTABLE_CAPABILITY, {
    configurable: false,
    enumerable: true,
    writable: false,
    value: Object.freeze({
      runner: Object.freeze(runner),
      interpreter: Object.freeze(interpreter),
      ...(bunStartup === undefined ? {} : { bunStartup: Object.freeze(bunStartup) }),
      ...(operatorController === undefined ? {} : { operatorController: Object.freeze(operatorController) })
    })
  });
  return env;
}

export function assertExecutableOutsideRoot(executable: string, forbiddenRoot: string): void {
  const forbidden = { lexical: path.resolve(forbiddenRoot), real: fs.realpathSync(path.resolve(forbiddenRoot)) };
  if (!path.isAbsolute(executable)) throw new Error("workflow runner capability requires an absolute path");
  if (pathInside(forbidden.lexical, path.resolve(executable)))
    throw new Error("workflow runner cannot be inside the target project");
  if (pathInside(forbidden.real, fs.realpathSync(executable)))
    throw new Error("workflow runner cannot resolve inside the target project");
}

export function smithersExecutableCapability(
  env: Record<string, string | undefined> | undefined
): Readonly<SmithersExecutableIdentity> | undefined {
  return (env as CapableEnvironment | undefined)?.[SMITHERS_EXECUTABLE_CAPABILITY];
}

/**
 * Returns the package-resolution root privately bound to an operator-owned
 * native continuation. Caller-provided NODE_PATH never contributes to this
 * value: the controller capability supplies and revalidates the root.
 */
export function nativeOperatorSmithersNodePath(
  env: Record<string, string | undefined> | undefined
): string | undefined {
  const operator = smithersExecutableCapability(env)?.operatorController;
  if (operator?.nativeContinuation !== true) return undefined;
  operator.assertCurrent();
  const nodeModules = path.join(operator.root, ".smithers", "node_modules");
  const lexical = path.resolve(nodeModules);
  const physical = fs.realpathSync(lexical);
  if (
    !pathInside(operator.root, lexical) ||
    !pathInside(operator.root, physical) ||
    !fs.statSync(physical).isDirectory()
  ) {
    throw new Error("operator workflow runner dependency root must remain inside its controller root");
  }
  return lexical;
}

/**
 * Opens the already-attested runner and interpreter and executes both through
 * held descriptors. Digest and inode checks reject replacement inside a still
 * valid snapshot root, while directly invoking the resolved interpreter makes
 * a later PATH substitution irrelevant.
 */
export function acquireSmithersExecutableAnchor(
  env: Record<string, string | undefined> | undefined,
  dependencyOverrides: Partial<SmithersExecutableAnchorDependencies> = {}
): SmithersExecutableAnchor | undefined {
  const capability = smithersExecutableCapability(env);
  if (capability === undefined) return undefined;
  capability.operatorController?.assertCurrent();
  const dependencies = { ...DEFAULT_ANCHOR_DEPENDENCIES, ...dependencyOverrides };
  const requested = env?.SMITHERS_BIN?.trim() || capability.runner.path;
  const runnerDescriptor = openRegularFileNoFollow(requested);
  let interpreterDescriptor: number | undefined;
  try {
    assertDescriptorIdentity(runnerDescriptor, capability.runner, "workflow runner");
    assertPathIdentity(requested, capability.runner, "workflow runner");
    assertPathIdentity(capability.runner.path, capability.runner, "workflow runner");
    interpreterDescriptor = openRegularFileNoFollow(capability.interpreter.path);
    assertDescriptorIdentity(interpreterDescriptor, capability.interpreter, "workflow runner interpreter");
    assertPathIdentity(capability.interpreter.path, capability.interpreter, "workflow runner interpreter");
    const runnerDescriptorPath = verifiedExecutableDescriptorPath(
      dependencies.executableDescriptorPath(runnerDescriptor),
      capability.runner,
      "workflow runner"
    );
    const interpreterDescriptorPath = verifiedExecutableDescriptorPath(
      dependencies.executableDescriptorPath(interpreterDescriptor),
      capability.interpreter,
      "workflow runner interpreter"
    );
    // Use descriptor execution only when both files can remain anchored. A
    // platform without cross-process descriptor paths invokes the canonical
    // attested paths and rechecks path, inode, size, and bytes after the child
    // closes, rejecting any replacement observed during the command.
    const useDescriptorPaths = runnerDescriptorPath !== undefined && interpreterDescriptorPath !== undefined;
    const snapshotRunner = requested !== capability.runner.path;
    const bunModuleConfinement = env?.ULTRAFUZZ_BUN_MODULE_CONFINEMENT?.trim();
    const directOperatorRunner =
      !snapshotRunner &&
      capability.operatorController !== undefined &&
      pathInside(capability.operatorController.root, capability.runner.path) &&
      (capability.operatorController.nativeContinuation ||
        (capability.bunStartup !== undefined &&
          path.dirname(path.dirname(capability.bunStartup.confinement.path)) === capability.operatorController.root));
    const unsealedNativeContinuation =
      directOperatorRunner && capability.operatorController?.nativeContinuation === true;
    if (
      capability.interpreter.runtime === "bun" &&
      !unsealedNativeContinuation &&
      ((!snapshotRunner && !directOperatorRunner) || !bunModuleConfinement || capability.bunStartup === undefined)
    ) {
      throw new Error("Bun workflow runner execution requires a sealed snapshot path");
    }
    const bunControls =
      capability.bunStartup === undefined
        ? undefined
        : {
            confinement: bunModuleConfinement!,
            config: path.join(path.dirname(bunModuleConfinement!), "bunfig.toml"),
            environment: path.join(path.dirname(bunModuleConfinement!), "bun-empty.env")
          };
    if (bunControls !== undefined)
      for (const [name, identity] of Object.entries(capability.bunStartup!))
        assertPathIdentity(bunControls[name as keyof typeof bunControls], identity, `Bun workflow runner ${name}`);
    const interpreterArguments =
      capability.interpreter.runtime === "bun" && bunControls !== undefined
        ? [
            `--config=${bunControls!.config}`,
            `--env-file=${bunControls!.environment}`,
            "--no-env-file",
            "--no-install",
            "--no-addons",
            "--preserve-symlinks-main",
            `--preload=${bunControls!.confinement}`
          ]
        : [];
    let closed = false;
    const assertCurrent = (): void => {
      if (closed) throw new Error("workflow runner executable anchor is already closed");
      capability.operatorController?.assertCurrent();
      assertDescriptorIdentity(runnerDescriptor, capability.runner, "workflow runner");
      assertDescriptorIdentity(interpreterDescriptor!, capability.interpreter, "workflow runner interpreter");
      assertPathIdentity(requested, capability.runner, "workflow runner");
      assertPathIdentity(capability.runner.path, capability.runner, "workflow runner");
      assertPathIdentity(capability.interpreter.path, capability.interpreter, "workflow runner interpreter");
      if (bunControls !== undefined)
        for (const [name, identity] of Object.entries(capability.bunStartup!))
          assertPathIdentity(bunControls[name as keyof typeof bunControls], identity, `Bun workflow runner ${name}`);
    };
    assertCurrent();
    return {
      executable: useDescriptorPaths ? interpreterDescriptorPath : capability.interpreter.path,
      argumentPrefix: [
        ...interpreterArguments,
        snapshotRunner ? requested : useDescriptorPaths ? runnerDescriptorPath : capability.runner.path
      ],
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

function verifiedBunStartupControls(
  confinementPath: string,
  runner: FileIdentity
): NonNullable<SmithersExecutableIdentity["bunStartup"]> {
  const confinement = verifiedRegularFile(confinementPath, false, "Bun workflow runner confinement"),
    controls = path.dirname(confinement.path),
    root = path.dirname(controls);
  if (
    path.basename(controls) !== "controls" ||
    path.basename(confinement.path) !== "bun-module-confinement.js" ||
    !pathInside(root, runner.path)
  )
    throw new Error("Bun workflow runner startup controls must share its sealed snapshot");
  return {
    confinement,
    config: verifiedRegularFile(path.join(controls, "bunfig.toml"), false, "Bun workflow runner config"),
    environment: verifiedRegularFile(
      path.join(controls, "bun-empty.env"),
      false,
      "Bun workflow runner empty environment"
    )
  };
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

function verifiedRegularFile(
  executable: string,
  requireExecutable: boolean,
  label: string,
  forbidden?: Forbidden
): FileIdentity {
  if (!path.isAbsolute(executable)) throw new Error(`${label} capability requires an absolute path`);
  if (forbidden !== undefined && pathInside(forbidden.lexical, path.resolve(executable)))
    throw new Error(`${label} cannot be inside the target project`);
  const resolved = canonicalExecutablePath(executable);
  if (forbidden !== undefined && pathInside(forbidden.real, resolved))
    throw new Error(`${label} cannot resolve inside the target project`);
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

function verifiedInterpreter(runner: FileIdentity, forbidden?: Forbidden): FileIdentity & { runtime: "bun" | "other" } {
  const firstLine = readVerifiedFile(runner, "workflow runner").split(/\r?\n/u, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) throw new Error("workflow runner executable is missing an interpreter shebang");
  const words = firstLine.slice(2).trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) throw new Error("workflow runner executable has an invalid interpreter shebang");
  let interpreter: string;
  let runtime: "bun" | "other";
  if (path.basename(words[0]!) === "env") {
    if (words.length !== 2 || words[1]!.startsWith("-")) {
      throw new Error("workflow runner executable uses an unsupported env interpreter shebang");
    }
    interpreter = resolveTrustedCommand(words[1]!, forbidden);
    runtime = words[1]!.replace(/\.exe$/iu, "").toLowerCase() === "bun" ? "bun" : "other";
  } else {
    if (words.length !== 1 || !path.isAbsolute(words[0]!)) {
      throw new Error("workflow runner executable requires one absolute interpreter");
    }
    interpreter = words[0]!;
    runtime =
      path
        .basename(interpreter)
        .replace(/\.exe$/iu, "")
        .toLowerCase() === "bun"
        ? "bun"
        : "other";
  }
  return { ...verifiedRegularFile(interpreter, true, "workflow runner interpreter", forbidden), runtime };
}

function resolveTrustedCommand(command: string, forbidden?: Forbidden): string {
  if (command === "node") {
    const node = trustedCommandCandidate(process.execPath, forbidden);
    if (node !== undefined) return node;
    throw new Error(`workflow runner interpreter is unavailable: ${command}`);
  }
  const sourcePath = process.env.PATH ?? "";
  for (const entry of sourcePath.split(path.delimiter)) {
    if (entry.length === 0) continue;
    const candidate = path.resolve(entry, command);
    const trusted = trustedCommandCandidate(candidate, forbidden);
    if (trusted !== undefined) return trusted;
  }
  throw new Error(`workflow runner interpreter is unavailable: ${command}`);
}

function trustedCommandCandidate(candidate: string, forbidden?: Forbidden): string | undefined {
  if (forbidden !== undefined && pathInside(forbidden.lexical, candidate)) return undefined;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return undefined;
    fs.accessSync(candidate, fs.constants.X_OK);
    const real = fs.realpathSync(candidate);
    return forbidden !== undefined && pathInside(forbidden.real, real) ? undefined : real;
  } catch {
    return undefined;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function openRegularFileNoFollow(filePath: string): number {
  // O_NONBLOCK makes a hostile FIFO fail the regular-file check instead of
  // wedging the controller while it waits for a writer between path lookup and
  // fstat. It has no effect on reads from the regular files accepted below.
  return fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
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
  const mismatch = !stat.isFile()
    ? "not a regular file"
    : stat.dev !== identity.device
      ? `device ${stat.dev} != ${identity.device}`
      : stat.ino !== identity.inode
        ? `inode ${stat.ino} != ${identity.inode}`
        : stat.size !== identity.size
          ? `size ${stat.size} != ${identity.size}`
          : digestDescriptor(descriptor) !== identity.sha256
            ? "sha256 mismatch"
            : undefined;
  if (mismatch !== undefined) {
    throw new Error(`${label} changed at the controller command boundary (${mismatch}; path ${identity.path})`);
  }
}

const VOLFS_ROOT = "/.vol";

function isVolfsPath(value: string): boolean {
  return value === VOLFS_ROOT || value.startsWith(`${VOLFS_ROOT}/`);
}

/**
 * Canonicalize an executable path.
 *
 * macOS volfs paths (/.vol/<dev>/<ino>/...) are rooted at an inode rather than
 * at a name and have no realpath(3) resolution, so they are already canonical
 * in the only sense available: the path cannot be redirected by renaming or
 * symlinking a component. Callers pair this with assertDescriptorIdentity,
 * which compares device, inode, size, and the SHA-256 of the bytes, so file
 * identity is established by content and inode rather than by name.
 */
function canonicalExecutablePath(filePath: string, identity?: FileIdentity): string {
  if (!isVolfsPath(filePath)) return fs.realpathSync(filePath);
  // A volfs path is inode-rooted and has no realpath(3) resolution, so the
  // attested canonical name cannot be recovered from it. Accept the attested
  // name only once the path is shown to name that exact inode; callers pair
  // this with assertDescriptorIdentity, which also compares size and SHA-256.
  if (identity === undefined) throw new Error("volfs path cannot be canonicalized without an attested identity");
  const stat = fs.lstatSync(filePath);
  if (stat.dev !== identity.device || stat.ino !== identity.inode) {
    throw new Error("volfs path does not name the attested file");
  }
  return identity.path;
}

function assertPathIdentity(filePath: string, identity: FileIdentity, label: string): void {
  let canonical: string;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${label} path is no longer a regular file`);
    }
    canonical = canonicalExecutablePath(filePath, identity);
  } catch (error) {
    throw new Error(
      `${label} changed at the controller command boundary (canonicalize ${filePath}: ${String(error)})`,
      { cause: error }
    );
  }
  if (canonical !== identity.path) {
    throw new Error(
      `${label} changed at the controller command boundary (canonical ${canonical} != ${identity.path})`
    );
  }
  const descriptor = openRegularFileNoFollow(filePath);
  try {
    assertDescriptorIdentity(descriptor, identity, label);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readVerifiedFile(identity: FileIdentity, label: string): string {
  const descriptor = openRegularFileNoFollow(identity.path);
  try {
    assertDescriptorIdentity(descriptor, identity, label);
    const contents = fs.readFileSync(descriptor);
    if (
      contents.byteLength !== identity.size ||
      crypto.createHash("sha256").update(contents).digest("hex") !== identity.sha256
    ) {
      throw new Error(`${label} changed at the controller command boundary`);
    }
    assertDescriptorIdentity(descriptor, identity, label);
    return contents.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function executableDescriptorPath(descriptor: number): string | undefined {
  const candidate = `/proc/${process.pid}/fd/${descriptor}`;
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    // Platforms without cross-process descriptor paths use lexical identity.
  }
  return undefined;
}

function verifiedExecutableDescriptorPath(
  candidate: string | undefined,
  identity: FileIdentity,
  label: string
): string | undefined {
  if (candidate === undefined) return undefined;
  const stat = fs.statSync(candidate);
  if (!stat.isFile() || stat.dev !== identity.device || stat.ino !== identity.inode || stat.size !== identity.size) {
    throw new Error(`${label} descriptor path changed at the controller command boundary`);
  }
  return candidate;
}
