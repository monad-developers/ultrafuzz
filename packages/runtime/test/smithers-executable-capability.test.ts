import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  acquireSmithersExecutableAnchor,
  assertExecutableOutsideRoot,
  bindOperatorSmithersExecutableCapability,
  bindSmithersExecutableCapability,
  smithersExecutableCapability
} from "../src/smithers-executable-capability.js";
import { runSmithersInspectionCommand, streamSmithersCommand } from "../src/smithers.js";
import { BUN_MODULE_CONFINEMENT_SOURCE } from "../src/workflow-integrity.js";

function temporaryDirectory(prefix: string): string {
  return temporaryRoot(prefix);
}

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, "utf8");
  fs.chmodSync(filePath, 0o700);
}

function nodeRunner(root: string, source = "console.log(JSON.stringify({ trusted: true }));\n"): string {
  const runner = path.join(root, "runner.js");
  writeExecutable(runner, `#!/usr/bin/env node\n${source}`);
  return runner;
}

const bunAvailable = (process.env.PATH ?? "")
  .split(path.delimiter)
  .some((entry) => fs.existsSync(path.join(entry, process.platform === "win32" ? "bun.exe" : "bun")));

test("environment strings cannot manufacture a Smithers executable capability", () => {
  const env = { SMITHERS_BIN: process.execPath };

  assert.equal(smithersExecutableCapability(env), undefined);
  assert.equal(acquireSmithersExecutableAnchor(env), undefined);
});

test("the Smithers executable capability survives controlled environment cloning", () => {
  const root = temporaryDirectory("ufz-runner-capability-clone-");
  const env = bindSmithersExecutableCapability({}, nodeRunner(root));
  const cloned = { ...env };

  assert.ok(smithersExecutableCapability(cloned));
  const anchor = acquireSmithersExecutableAnchor(cloned);
  assert.ok(anchor);
  anchor.close();
});

test("Smithers commands invoke the bound interpreter instead of a substituted PATH command", async () => {
  const root = temporaryDirectory("ufz-runner-interpreter-");
  const runner = nodeRunner(root);
  const hostileBin = path.join(root, "hostile-bin");
  const hostileMarker = path.join(root, "hostile-node-ran");
  fs.mkdirSync(hostileBin);
  writeExecutable(
    path.join(hostileBin, "node"),
    `#!/bin/sh\nprintf hostile > ${JSON.stringify(hostileMarker)}\nexit 97\n`
  );
  const env = bindSmithersExecutableCapability({ PATH: hostileBin }, runner);

  const result = await runSmithersInspectionCommand({
    args: ["inspect", "fixture", "--format", "json"],
    projectRoot: root,
    env
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.json, { trusted: true });
  assert.equal(fs.existsSync(hostileMarker), false);
});

test(
  "Bun anchors ignore target startup and module resolution",
  { skip: !bunAvailable || process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  async () => {
    const root = temporaryDirectory("ufz-runner-bun-startup-"),
      snapshot = path.join(root, "snapshot"),
      trusted = path.join(snapshot, "node_modules", "@smthrs", "cli"),
      runner = path.join(snapshot, "dependencies", "smthrs", "runner.ts"),
      guard = path.join(snapshot, "controls", "bun-module-confinement.js"),
      marker = path.join(root, "preload-ran");
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.mkdirSync(trusted, { recursive: true });
    fs.mkdirSync(path.dirname(guard), { recursive: true });
    fs.writeFileSync(guard, "export {};\n");
    fs.writeFileSync(path.join(path.dirname(guard), "bunfig.toml"), "\n");
    fs.writeFileSync(path.join(path.dirname(guard), "bun-empty.env"), "\n");
    writeExecutable(
      runner,
      "#!/usr/bin/env bun\nimport '@smthrs/cli'; console.log(JSON.stringify({ dotenv: process.env.ULTRAFUZZ_HOSTILE_DOTENV ?? null, injections: ['BUN_OPTIONS', 'BUN_INSPECT_PRELOAD', 'NODE_PATH', 'NODE_OPTIONS'].map((name) => process.env[name] ?? null) }));\n"
    );
    for (const [file, contents] of [
      [path.join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n'],
      [path.join(root, "preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "hostile");\n`],
      [path.join(root, "attacker.ts"), `await Bun.write(${JSON.stringify(marker)}, "hostile");\n`],
      [path.join(root, "tsconfig.json"), '{"compilerOptions":{"paths":{"@smthrs/cli":["./attacker.ts"]}}}\n'],
      [path.join(snapshot, "tsconfig.json"), "{}\n"],
      [path.join(trusted, "package.json"), '{"name":"@smthrs/cli","type":"module","exports":"./index.ts"}\n'],
      [path.join(trusted, "index.ts"), "export {};\n"],
      [path.join(root, ".env"), "ULTRAFUZZ_HOSTILE_DOTENV=hostile\n"]
    ] as const)
      fs.writeFileSync(file, contents, "utf8");
    const injectionNames = ["BUN_OPTIONS", "BUN_INSPECT_PRELOAD", "NODE_PATH", "NODE_OPTIONS"] as const,
      env: Record<string, string | undefined> = bindSmithersExecutableCapability(
        {
          ...Object.fromEntries(injectionNames.map((name) => [name, "hostile"])),
          ULTRAFUZZ_BUN_MODULE_CONFINEMENT: guard
        },
        runner
      ),
      snapshotDescriptor = fs.openSync(snapshot, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    assert.throws(() => acquireSmithersExecutableAnchor(env), /requires a sealed snapshot path/u);
    env.SMITHERS_BIN = `/proc/${process.pid}/fd/${snapshotDescriptor}/dependencies/smthrs/runner.ts`;
    env.ULTRAFUZZ_BUN_MODULE_CONFINEMENT = `/proc/${process.pid}/fd/${snapshotDescriptor}/controls/bun-module-confinement.js`;
    const anchor = acquireSmithersExecutableAnchor(env);
    assert.ok(anchor);
    try {
      const expected = [
        `--config=${path.join(path.dirname(env.ULTRAFUZZ_BUN_MODULE_CONFINEMENT!), "bunfig.toml")}`,
        `--env-file=${path.join(path.dirname(env.ULTRAFUZZ_BUN_MODULE_CONFINEMENT!), "bun-empty.env")}`,
        "--no-env-file",
        "--no-install",
        "--no-addons",
        "--preserve-symlinks-main"
      ];
      assert.deepEqual(anchor.argumentPrefix.slice(0, 6), expected);
      assert.equal(anchor.argumentPrefix[6], `--preload=${env.ULTRAFUZZ_BUN_MODULE_CONFINEMENT}`);
    } finally {
      anchor.close();
    }
    try {
      const result = await runSmithersInspectionCommand({
        args: ["inspect", "fixture"],
        projectRoot: root,
        env,
        environmentVariableNames: injectionNames
      });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.json, { dotenv: null, injections: [null, null, null, null] });
      assert.equal(fs.existsSync(marker), false);
      const sealedGuard = env.ULTRAFUZZ_BUN_MODULE_CONFINEMENT;
      delete env.ULTRAFUZZ_BUN_MODULE_CONFINEMENT;
      assert.throws(() => acquireSmithersExecutableAnchor(env), /requires a sealed snapshot path/u);
      env.ULTRAFUZZ_BUN_MODULE_CONFINEMENT = sealedGuard;
      const sealedEmptyEnvironment = path.join(path.dirname(sealedGuard), "bun-empty.env");
      fs.writeFileSync(sealedEmptyEnvironment, "ULTRAFUZZ_HOSTILE_DOTENV=hostile\n");
      assert.throws(() => acquireSmithersExecutableAnchor(env), /changed at the controller command boundary/u);
      fs.writeFileSync(sealedEmptyEnvironment, "\n");
      fs.writeFileSync(guard, "malformed");
      assert.throws(() => acquireSmithersExecutableAnchor(env), /changed at the controller command boundary/u);
    } finally {
      fs.closeSync(snapshotDescriptor);
    }
  }
);

test(
  "operator-owned Bun runners use privately bound startup authority",
  { skip: !bunAvailable || process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  async () => {
    const root = temporaryDirectory("ufz-operator-runner-"),
      operatorRoot = path.join(root, "operator"),
      targetRoot = path.join(root, "target"),
      runner = path.join(operatorRoot, "node_modules", "smthrs", "src", "bin", "workflow runner.js"),
      resultModule = path.join(path.dirname(runner), "result.ts"),
      controls = path.join(operatorRoot, "controls"),
      confinement = path.join(controls, "bun-module-confinement.js"),
      hostileMarker = path.join(root, "hostile-runner-executed");
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.mkdirSync(controls, { recursive: true });
    fs.mkdirSync(targetRoot);
    fs.writeFileSync(resultModule, "export const trusted = true;\n");
    writeExecutable(
      runner,
      '#!/usr/bin/env bun\nimport { trusted } from "./result.ts"; console.log(JSON.stringify({ trusted }));\n'
    );
    fs.writeFileSync(confinement, BUN_MODULE_CONFINEMENT_SOURCE);
    fs.writeFileSync(path.join(controls, "bunfig.toml"), "\n");
    fs.writeFileSync(path.join(controls, "bun-empty.env"), "\n");
    let current = true;
    let checks = 0;
    const env = bindOperatorSmithersExecutableCapability(
      { ULTRAFUZZ_BUN_MODULE_CONFINEMENT: confinement },
      runner,
      operatorRoot,
      () => {
        checks += 1;
        if (!current) throw new Error("operator controller changed during execution");
      },
      targetRoot
    );
    const anchor = acquireSmithersExecutableAnchor(env);
    assert.ok(anchor);
    assert.match(anchor.argumentPrefix.at(-1) ?? "", /^\/proc\/[0-9]+\/fd\/[0-9]+$/u);
    anchor.close();

    const result = await runSmithersInspectionCommand({
      args: ["inspect", "fixture", "--format", "json"],
      projectRoot: targetRoot,
      env
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.json, { trusted: true });
    assert.ok(checks >= 4);

    const replacementAnchor = acquireSmithersExecutableAnchor(env);
    assert.ok(replacementAnchor);
    fs.renameSync(runner, `${runner}.original`);
    writeExecutable(
      runner,
      `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(hostileMarker)}, "hostile"); console.log(JSON.stringify({ trusted: false }));\n`
    );
    try {
      const stdout = execFileSync(
        replacementAnchor.executable,
        [...replacementAnchor.argumentPrefix, "inspect", "fixture", "--format", "json"],
        { cwd: targetRoot, env: process.env, encoding: "utf8" }
      );
      assert.deepEqual(JSON.parse(stdout), { trusted: true });
      assert.equal(fs.existsSync(hostileMarker), false);
      assert.throws(() => replacementAnchor.assertCurrent(), /changed at the controller command boundary/u);
    } finally {
      replacementAnchor.close();
    }

    current = false;
    assert.throws(() => acquireSmithersExecutableAnchor(env), /operator controller changed during execution/u);
  }
);

test(
  "native operator continuations resolve target workflows from only the privately bound package root",
  { skip: !bunAvailable || process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  async () => {
    const root = temporaryDirectory("ufz-native-operator-modules-"),
      operatorRoot = path.join(root, "operator"),
      targetRoot = path.join(root, "target"),
      operatorNodeModules = path.join(operatorRoot, ".smithers", "node_modules"),
      runner = path.join(operatorNodeModules, "smthrs", "src", "bin", "smithers.js"),
      trustedPackage = path.join(operatorNodeModules, "native-continuation-dependency"),
      hostileNodeModules = path.join(root, "hostile-node-modules"),
      hostilePackage = path.join(hostileNodeModules, "native-continuation-dependency"),
      hostileMarker = path.join(root, "hostile-package-ran"),
      workflow = path.join(targetRoot, ".smithers", "workflows", "continued.tsx");
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.mkdirSync(trustedPackage, { recursive: true });
    fs.mkdirSync(hostilePackage, { recursive: true });
    fs.mkdirSync(path.dirname(workflow), { recursive: true });
    for (const [packageRoot, source] of [
      [trustedPackage, 'export default "trusted";\n'],
      [hostilePackage, `await Bun.write(${JSON.stringify(hostileMarker)}, "hostile"); export default "hostile";\n`]
    ] as const) {
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({ name: "native-continuation-dependency", type: "module", exports: "./index.js" })}\n`
      );
      fs.writeFileSync(path.join(packageRoot, "index.js"), source);
    }
    fs.writeFileSync(
      workflow,
      'import dependency from "native-continuation-dependency"; export default dependency;\n',
      "utf8"
    );
    writeExecutable(
      runner,
      "#!/usr/bin/env bun\nconst workflow = await import(process.argv[3]); console.log(JSON.stringify({ dependency: workflow.default, nodePath: process.env.NODE_PATH ?? null }));\n"
    );
    let checks = 0;
    const env = bindOperatorSmithersExecutableCapability(
      { NODE_PATH: hostileNodeModules },
      runner,
      operatorRoot,
      () => {
        checks += 1;
      },
      targetRoot,
      true
    );

    const result = await runSmithersInspectionCommand({
      args: ["inspect", workflow, "--format", "json"],
      projectRoot: targetRoot,
      env,
      environmentVariableNames: ["NODE_PATH"]
    });

    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.json, { dependency: "trusted", nodePath: operatorNodeModules });
    assert.equal(fs.existsSync(hostileMarker), false);
    assert.ok(checks >= 3);
  }
);

test("streaming Smithers commands keep the executable anchor through child close", async () => {
  const root = temporaryDirectory("ufz-runner-stream-");
  const runner = nodeRunner(root, "console.log(JSON.stringify({ sequence: 1 }));\n");
  const lines: string[] = [];

  const result = await streamSmithersCommand({
    args: ["events", "fixture", "--watch"],
    projectRoot: root,
    env: bindSmithersExecutableCapability({}, runner),
    maxLines: 5,
    onLine: (line) => {
      lines.push(line);
    }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stoppedByCaller, false);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [{ sequence: 1 }]
  );
});

test(
  "runner and interpreter anchors close after an asynchronous spawn failure",
  { skip: process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  async () => {
    const root = temporaryDirectory("ufz-runner-spawn-failure-");
    const runner = nodeRunner(root);
    const env = bindSmithersExecutableCapability({}, runner);
    const identities = [fs.statSync(fs.realpathSync(runner)), fs.statSync(fs.realpathSync(process.execPath))];
    const anchoredDescriptorCount = (): number =>
      fs.readdirSync("/proc/self/fd").filter((entry) => {
        try {
          const stat = fs.fstatSync(Number(entry));
          return identities.some((identity) => stat.dev === identity.dev && stat.ino === identity.ino);
        } catch {
          return false;
        }
      }).length;
    const before = anchoredDescriptorCount();

    const result = await runSmithersInspectionCommand({
      args: ["inspect", "fixture"],
      projectRoot: path.join(root, "missing-cwd"),
      env
    });

    assert.equal(result.ok, false);
    assert.equal(anchoredDescriptorCount(), before);
  }
);

test(
  "descriptor anchors execute the attested runner while its pathname is replaced",
  { skip: process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  () => {
    const root = temporaryDirectory("ufz-runner-descriptor-");
    const runner = nodeRunner(root);
    const displaced = `${runner}.displaced`;
    const env = bindSmithersExecutableCapability({}, runner);
    const anchor = acquireSmithersExecutableAnchor(env);
    assert.ok(anchor);
    assert.match(anchor.executable, /^\/proc\/\d+\/fd\/\d+$/u);
    assert.match(anchor.argumentPrefix[0] ?? "", /^\/proc\/\d+\/fd\/\d+$/u);

    fs.renameSync(runner, displaced);
    writeExecutable(runner, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ hostile: true }));\n");
    try {
      const stdout = execFileSync(anchor.executable, [...anchor.argumentPrefix], {
        encoding: "utf8"
      });
      assert.deepEqual(JSON.parse(stdout), { trusted: true });
      assert.throws(() => anchor.assertCurrent(), /workflow runner changed at the controller command boundary/u);
    } finally {
      anchor.close();
    }
  }
);

test("lexical fallback revalidates the held runner bytes", () => {
  const root = temporaryDirectory("ufz-runner-path-bytes-");
  const runner = path.join(root, "runner.js");
  const original = "#!/usr/bin/env node\nconsole.log('trusted');\n";
  const replacement = "#!/usr/bin/env node\nconsole.log('hostile');\n";
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement));
  writeExecutable(runner, original);
  const anchor = acquireSmithersExecutableAnchor(bindSmithersExecutableCapability({}, runner), {
    executableDescriptorPath: () => undefined
  });
  assert.ok(anchor);
  assert.equal(anchor.executable, fs.realpathSync(process.execPath));
  assert.deepEqual(anchor.argumentPrefix, [fs.realpathSync(runner)]);

  fs.writeFileSync(runner, replacement, "utf8");
  try {
    assert.throws(() => anchor.assertCurrent(), /workflow runner changed at the controller command boundary/u);
  } finally {
    anchor.close();
  }
});

test("lexical fallback rejects an identical-byte pathname replacement", () => {
  const root = temporaryDirectory("ufz-runner-path-identity-");
  const runner = nodeRunner(root);
  const displaced = `${runner}.displaced`;
  const contents = fs.readFileSync(runner);
  const anchor = acquireSmithersExecutableAnchor(bindSmithersExecutableCapability({}, runner), {
    executableDescriptorPath: () => undefined
  });
  assert.ok(anchor);

  fs.renameSync(runner, displaced);
  fs.writeFileSync(runner, contents);
  fs.chmodSync(runner, 0o700);
  try {
    assert.throws(() => anchor.assertCurrent(), /workflow runner changed at the controller command boundary/u);
  } finally {
    anchor.close();
  }
});

test("capability binding hashes the exact runner bytes used to parse the shebang", () => {
  const root = temporaryDirectory("ufz-runner-shebang-bytes-");
  const runner = path.join(root, "runner.js");
  const original = "#!/usr/bin/env node\nconsole.log('trusted');\n";
  const replacement = "#!/usr/bin/env node\nconsole.log('hostile');\n";
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement));
  writeExecutable(runner, original);
  const descriptor = Object.getOwnPropertyDescriptor(fs, "readFileSync")!;
  const originalReadFileSync = fs.readFileSync;
  Object.defineProperty(fs, "readFileSync", {
    ...descriptor,
    value: (file: unknown, ...args: unknown[]): unknown =>
      typeof file === "number" ? Buffer.from(replacement) : Reflect.apply(originalReadFileSync, fs, [file, ...args])
  });
  try {
    assert.throws(
      () => bindSmithersExecutableCapability({}, runner),
      /workflow runner changed at the controller command boundary/u
    );
  } finally {
    Object.defineProperty(fs, "readFileSync", descriptor);
  }
});

test("anchor acquisition rejects a replaced shebang interpreter", { skip: process.platform === "win32" }, () => {
  const root = temporaryDirectory("ufz-runner-interpreter-identity-");
  const interpreter = path.join(root, "trusted-sh");
  const displaced = `${interpreter}.displaced`;
  fs.copyFileSync("/bin/sh", interpreter);
  fs.chmodSync(interpreter, 0o700);
  const runner = path.join(root, "runner.sh");
  writeExecutable(runner, `#!${interpreter}\nprintf '%s\\n' trusted\n`);
  const env = bindSmithersExecutableCapability({}, runner);

  fs.renameSync(interpreter, displaced);
  fs.copyFileSync(displaced, interpreter);
  fs.chmodSync(interpreter, 0o700);

  assert.throws(
    () => acquireSmithersExecutableAnchor(env),
    /workflow runner interpreter changed at the controller command boundary/u
  );
});

test("untrusted descriptor paths are rejected and acquired descriptors are closed", () => {
  const root = temporaryDirectory("ufz-runner-descriptor-path-");
  const runner = nodeRunner(root);
  const env = bindSmithersExecutableCapability({}, runner);

  assert.throws(
    () =>
      acquireSmithersExecutableAnchor(env, {
        executableDescriptorPath: () => runner
      }),
    /workflow runner interpreter descriptor path changed at the controller command boundary/u
  );

  const anchor = acquireSmithersExecutableAnchor(env, { executableDescriptorPath: () => undefined });
  assert.ok(anchor);
  anchor.close();
  anchor.close();
  assert.throws(() => anchor.assertCurrent(), /workflow runner executable anchor is already closed/u);
});

test("capability binding rejects ambiguous or relative shebang authority", () => {
  const root = temporaryDirectory("ufz-runner-shebang-");
  const relative = path.join(root, "relative.js");
  writeExecutable(relative, "#!/usr/bin/env node\n");
  assert.throws(
    () => bindSmithersExecutableCapability({}, path.basename(relative)),
    /workflow runner capability requires an absolute path/u
  );

  const ambiguous = path.join(root, "ambiguous.js");
  writeExecutable(ambiguous, "#!/usr/bin/env -S node --no-warnings\n");
  assert.throws(
    () => bindSmithersExecutableCapability({}, ambiguous),
    /workflow runner executable uses an unsupported env interpreter shebang/u
  );
});

test(
  "capability binding rejects target-contained runner and interpreter paths",
  { skip: process.platform === "win32" },
  () => {
    const target = temporaryDirectory("ufz-runner-target-"),
      outside = temporaryDirectory("ufz-runner-outside-"),
      local = nodeRunner(target),
      external = path.join(outside, "absolute.sh"),
      insideLink = path.join(target, "external-link"),
      outsideLink = path.join(outside, "local-link");
    writeExecutable(external, "#!/bin/sh\nexit 0\n");
    fs.symlinkSync(external, insideLink);
    fs.symlinkSync(local, outsideLink);
    for (const runner of [local, insideLink, outsideLink])
      assert.throws(() => assertExecutableOutsideRoot(runner, target), /inside the target project/u);
    const localInterpreter = path.join(target, "sh"),
      insideInterpreterLink = path.join(target, "external-sh"),
      outsideInterpreterLink = path.join(outside, "local-sh");
    fs.copyFileSync("/bin/sh", localInterpreter);
    fs.chmodSync(localInterpreter, 0o700);
    fs.symlinkSync("/bin/sh", insideInterpreterLink);
    fs.symlinkSync(localInterpreter, outsideInterpreterLink);
    for (const [name, interpreter] of [
      ["local", localInterpreter],
      ["lexical-link", insideInterpreterLink],
      ["real-link", outsideInterpreterLink]
    ] as const) {
      const runner = path.join(outside, `${name}.sh`);
      writeExecutable(runner, `#!${interpreter}\nexit 0\n`);
      assert.throws(
        () => bindSmithersExecutableCapability({}, runner, target),
        /interpreter cannot (?:be|resolve) inside the target project/u
      );
    }
    assert.equal(assertExecutableOutsideRoot(external, target), undefined);
    assert.ok(smithersExecutableCapability(bindSmithersExecutableCapability({}, external, target)));
  }
);

test(
  "capability binding rejects a workflow-runner FIFO without blocking",
  { skip: process.platform === "win32" },
  () => {
    const root = temporaryDirectory("ufz-runner-fifo-");
    const fifo = path.join(root, "runner");
    execFileSync("mkfifo", [fifo]);

    assert.throws(
      () => bindSmithersExecutableCapability({}, fifo),
      /workflow runner capability must name a regular file/u
    );
  }
);
