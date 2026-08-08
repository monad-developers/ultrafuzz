import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireSmithersExecutableAnchor,
  bindSmithersExecutableCapability,
  smithersExecutableCapability
} from "../src/smithers-executable-capability.js";
import { runSmithersInspectionCommand, streamSmithersCommand } from "../src/smithers.js";

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
