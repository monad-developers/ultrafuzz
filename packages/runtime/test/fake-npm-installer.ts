import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { KIMI_CODE_VERSION, SMITHERS_VERSION } from "../src/smithers-package.js";
import { setOperatorNpmCliForTests } from "../src/operator-npm.js";

// `failures` makes the fake npm exit non-zero for its first N invocations, so a test
// can drive the install retry loop. The npm log doubles as the attempt counter.
export function writeFakeNpmInstaller(
  project: string,
  failures: {
    count: number;
    stderr: readonly string[];
    integrity?: string;
    imported?: string;
    optional?: string;
    required?: string;
  } = { count: 0, stderr: [] }
): {
  activate: () => void;
  binDir: string;
  npmLogPath: string;
  smithersLogPath: string;
} {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-fake-npm-"));
  const npm = path.join(binDir, "npm");
  const npmLogPath = path.join(project, "npm-install.log");
  const smithersLogPath = path.join(project, "local-smithers.log");
  const dependencies = [
    ["@moonshot-ai/kimi-code", KIMI_CODE_VERSION],
    ["@smthrs/tool-context", SMITHERS_VERSION],
    ["react", "19.2.4"],
    ["smthrs", SMITHERS_VERSION],
    ["zod", "4.4.3"]
  ];
  fs.writeFileSync(
    npm,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      `const args = process.argv.slice(2), log = ${JSON.stringify(npmLogPath)};`,
      'fs.appendFileSync(log, `${args.join(" ")}\\n`);',
      `if (fs.readFileSync(log, "utf8").trimEnd().split("\\n").length <= ${failures.count}) { ${failures.stderr.map((line) => `process.stderr.write(${JSON.stringify(`${line}\n`)});`).join(" ")} process.exit(1); }`,
      `const prefix = args[args.indexOf("--prefix") + 1], dependencies = ${JSON.stringify(dependencies)}, packages = { '': JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8')) };`,
      `const integrity = ${JSON.stringify(failures.integrity ?? `sha512-${Buffer.alloc(64).toString("base64")}`)};`,
      "for (const [name, version] of dependencies) { const root = path.join(prefix, 'node_modules', ...name.split('/')); fs.mkdirSync(root, { recursive: true }); const manifest = { name, version, ...(name === 'smthrs' ? { bin: { smithers: 'src/bin/smithers.js' }, ..." +
        JSON.stringify({
          ...(failures.optional === undefined ? {} : { optionalDependencies: { [failures.optional]: "1.0.0" } }),
          ...(failures.required === undefined ? {} : { dependencies: { [failures.required]: "1.0.0" } })
        }) +
        " } : {}) }; fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(manifest)}\\n`); fs.writeFileSync(path.join(root, 'index.js'), 'export {};\\n'); packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}/-/fixture.tgz`, integrity }; }",
      "const target = path.join(prefix, 'node_modules/smthrs/src/bin/smithers.js'); fs.mkdirSync(path.dirname(target), { recursive: true });",
      `fs.writeFileSync(target, ${JSON.stringify('#!/bin/sh\nif [ -n "$SMITHERS_FAKE_CLOUD_ENV_LOG" ]; then printf \'%s|%s\\n\' "$MODAL_TOKEN_ID" "$MODAL_TOKEN_SECRET" > "$SMITHERS_FAKE_CLOUD_ENV_LOG"; fi\nprintf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"\nprintf \'%s\\n\' \'{"ok":true}\'\n')});`,
      "fs.chmodSync(target, 0o755);",
      "const shim = path.join(prefix, 'node_modules/.bin/smithers'); fs.mkdirSync(path.dirname(shim), { recursive: true }); fs.symlinkSync(path.relative(path.dirname(shim), target), shim);",
      "fs.writeFileSync(path.join(prefix, 'package-lock.json'), `${JSON.stringify({ name: 'ultrafuzz-smithers', lockfileVersion: 3, requires: true, packages })}\\n`);"
    ].join("\n"),
    "utf8"
  );
  const optionalRunner =
    (failures.imported ?? failures.optional) === undefined
      ? undefined
      : `#!/usr/bin/env bun\nconst fs = require("node:fs");\nrequire("../../index.js");\ntry { require(${JSON.stringify(failures.imported ?? failures.optional)}); } catch {}\nif (process.env.SMITHERS_FAKE_CLOUD_ENV_LOG) fs.writeFileSync(process.env.SMITHERS_FAKE_CLOUD_ENV_LOG, (process.env.MODAL_TOKEN_ID ?? "") + "|" + (process.env.MODAL_TOKEN_SECRET ?? "") + "\\n");\nif (process.env.SMITHERS_FAKE_LOG) fs.appendFileSync(process.env.SMITHERS_FAKE_LOG, process.argv.slice(2).join(" ") + "\\n");\nconsole.log('{"ok":true}');\n`;
  if (optionalRunner !== undefined)
    fs.appendFileSync(npm, `\nfs.writeFileSync(target, ${JSON.stringify(optionalRunner)});\n`);
  fs.chmodSync(npm, 0o500);
  const activate = (): void => setOperatorNpmCliForTests(npm);
  activate();
  return { activate, binDir, npmLogPath, smithersLogPath };
}
