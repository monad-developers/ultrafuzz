import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseVersion = "0.1.0";
const packageDirectories = [
  "packages/security",
  "packages/prompts",
  "packages/artifacts",
  "packages/config",
  "packages/references",
  "packages/topology",
  "packages/runtime",
  "packages/dashboard",
  "packages/evals",
  "packages/evmbench",
  "packages/modal",
  "packages/cli"
];
const workspacePackageDirectories = fs
  .readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, "packages", entry.name, "package.json")))
  .map((entry) => `packages/${entry.name}`)
  .sort();
const rootManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const pnpmWorkspace = parseYaml(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"));
if (rootManifest.version !== releaseVersion || rootManifest.private !== true) {
  throw new Error(`root package must remain private and declare release version ${releaseVersion}`);
}
assertPackageInventory("packed release", packageDirectories, workspacePackageDirectories);
assertPackageInventory("root package.json workspaces", rootManifest.workspaces, workspacePackageDirectories);
assertPackageInventory("pnpm-workspace.yaml packages", pnpmWorkspace?.packages, workspacePackageDirectories);

const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-packed-install-"));
const tarballRoot = path.join(temporaryRoot, "tarballs");
const consumerRoot = path.join(temporaryRoot, "consumer");
const projectRoot = path.join(temporaryRoot, "initialized-project");
fs.mkdirSync(tarballRoot, { recursive: true });
fs.mkdirSync(consumerRoot, { recursive: true });

try {
  run("pnpm", ["-w", "build"], root, "workspace build");

  const tarballs = new Map();
  for (const relativeDirectory of packageDirectories) {
    const packageRoot = path.join(root, relativeDirectory);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.version !== releaseVersion) {
      throw new Error(`${manifest.name} must declare release version ${releaseVersion}`);
    }
    if (manifest.private !== true) {
      throw new Error(`${manifest.name} must remain private for the source release`);
    }
    const tarballPath = path.join(tarballRoot, `${manifest.name.replace(/^@/u, "").replaceAll("/", "-")}.tgz`);
    run("pnpm", ["pack", "--out", tarballPath], packageRoot, `pack ${manifest.name}`);
    assertRegularFile(tarballPath, `${manifest.name} tarball`);
    tarballs.set(manifest.name, tarballPath);
  }

  fs.writeFileSync(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "ultrafuzz-packed-install-validation",
        version: "1.0.0",
        private: true,
        dependencies: Object.fromEntries(
          [...tarballs].map(([name, tarballPath]) => [name, `file:${tarballPath.split(path.sep).join("/")}`])
        )
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(consumerRoot, "pnpm-workspace.yaml"),
    [
      "packages:",
      '  - "."',
      "overrides:",
      ...[...tarballs].map(([name, tarballPath]) => `  "${name}": "file:${tarballPath.split(path.sep).join("/")}"`),
      "allowBuilds:",
      "  cbor-extract: true",
      "  msgpackr-extract: false",
      "  protobufjs: true",
      ""
    ].join("\n"),
    "utf8"
  );
  run("pnpm", ["install"], consumerRoot, "packed dependency install");

  for (const relativeDirectory of packageDirectories) {
    const packageRoot = path.join(root, relativeDirectory);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const installedRoot = path.join(consumerRoot, "node_modules", ...manifest.name.split("/"));
    assertPackedPackagePayload(packageRoot, installedRoot, manifest);
  }

  const cliPath = path.join(consumerRoot, "node_modules", "@ultrafuzz", "cli", "dist", "index.js");
  assertRegularFile(cliPath, "installed Ultrafuzz CLI");
  run(
    "pnpm",
    ["exec", "ultrafuzz", "init", "--project", projectRoot, "--force", "--json"],
    consumerRoot,
    "packed init"
  );
  run("pnpm", ["exec", "ultrafuzz", "validate", "--project", projectRoot, "--json"], consumerRoot, "packed validate");

  const installedConfigRoot = path.join(consumerRoot, "node_modules", "@ultrafuzz", "config", "dist");
  assertMatchingTree(
    path.join(root, "packages", "config", "topologies"),
    path.join(installedConfigRoot, "topologies"),
    "installed topology assets"
  );
  assertSameBytes(
    path.join(root, "packages", "config", "audit-profiles.yml"),
    path.join(installedConfigRoot, "audit-profiles.yml"),
    "installed audit profile catalog"
  );
  assertSameBytes(
    path.join(root, "ultrafuzz.toml"),
    path.join(installedConfigRoot, "ultrafuzz.toml"),
    "installed default config"
  );
  const installedPromptRoot = path.join(
    consumerRoot,
    "node_modules",
    "@ultrafuzz",
    "prompts",
    "dist",
    "assets",
    "prompts"
  );
  const checkedInPromptRoot = path.join(root, ".ultrafuzz", "prompts");
  assertMatchingTree(checkedInPromptRoot, installedPromptRoot, "installed prompt assets");
  assertMatchingTree(
    checkedInPromptRoot,
    path.join(projectRoot, ".ultrafuzz", "prompts"),
    "initialized prompt assets",
    (relativePath) => !relativePath.startsWith("_templates/")
  );

  const checkedInSchemaRoot = path.join(root, "packages", "artifacts", "schema");
  const installedSchemaRoot = path.join(consumerRoot, "node_modules", "@ultrafuzz", "artifacts", "schema");
  assertMatchingTree(checkedInSchemaRoot, installedSchemaRoot, "installed artifact schemas");

  const initializedTopology = fs.readFileSync(path.join(projectRoot, ".ultrafuzz", "topology.yml"));
  const installedDefaultTopology = fs.readFileSync(path.join(installedConfigRoot, "topologies", "default.yml"));
  if (!initializedTopology.equals(installedDefaultTopology)) {
    throw new Error("packed init did not scaffold the installed default topology bytes");
  }
  for (const name of ["threat-model.schema.json", "goal-plan.schema.json"]) {
    assertSameJson(
      path.join(checkedInSchemaRoot, name),
      path.join(projectRoot, ".ultrafuzz", "schema", name),
      `initialized schema ${name}`
    );
  }

  console.log(`packed install validation passed for ${tarballs.size} packages at ${releaseVersion}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${command} ${args.join(" ")}):\n${result.stderr || result.stdout || `exit ${result.status}`}`
    );
  }
}

function assertRegularFile(filePath, label) {
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

function assertSameBytes(expectedPath, actualPath, label) {
  assertRegularFile(expectedPath, `${label} source`);
  assertRegularFile(actualPath, label);
  if (!fs.readFileSync(actualPath).equals(fs.readFileSync(expectedPath))) {
    throw new Error(`${label} differs from checked-in bytes: ${actualPath}`);
  }
}

function assertSameJson(expectedPath, actualPath, label) {
  assertRegularFile(expectedPath, `${label} source`);
  assertRegularFile(actualPath, label);
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const actual = JSON.parse(fs.readFileSync(actualPath, "utf8"));
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} differs structurally from checked-in schema: ${actualPath}`);
  }
}

function assertMatchingTree(expectedRoot, actualRoot, label, expectedFilter = () => true) {
  const expectedFiles = regularFileInventory(expectedRoot, `${label} source`).filter(expectedFilter);
  const actualFiles = regularFileInventory(actualRoot, label);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `${label} inventory differs from checked-in tree (expected: ${expectedFiles.join(", ")}; actual: ${actualFiles.join(", ")})`
    );
  }
  for (const relativePath of expectedFiles) {
    assertSameBytes(
      path.join(expectedRoot, relativePath),
      path.join(actualRoot, relativePath),
      `${label} ${relativePath}`
    );
  }
}

function assertPackedPackagePayload(packageRoot, installedRoot, manifest) {
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9._-]+$/u.test(entry))
  ) {
    throw new Error(`${manifest.name} must declare an explicit non-empty runtime files allowlist`);
  }
  const expectedFiles = ["LICENSE.md", "package.json"];
  for (const entry of manifest.files) {
    const source = path.join(packageRoot, entry);
    const stat = fs.statSync(source, { throwIfNoEntry: false });
    if (stat?.isFile()) {
      expectedFiles.push(entry);
    } else if (stat?.isDirectory()) {
      expectedFiles.push(
        ...regularFileInventory(source, `${manifest.name} ${entry}`).map((file) => `${entry}/${file}`)
      );
    } else {
      throw new Error(`${manifest.name} files allowlist entry is missing or non-regular: ${entry}`);
    }
  }
  expectedFiles.sort();
  const actualFiles = regularFileInventory(installedRoot, `installed ${manifest.name}`).filter(
    (entry) => !entry.startsWith("node_modules/")
  );
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `installed ${manifest.name} payload differs from its files allowlist (expected: ${expectedFiles.join(", ")}; actual: ${actualFiles.join(", ")})`
    );
  }
  for (const relativePath of expectedFiles.filter((entry) => entry !== "package.json")) {
    const sourcePath =
      relativePath === "LICENSE.md" ? path.join(root, "LICENSE.md") : path.join(packageRoot, relativePath);
    assertSameBytes(sourcePath, path.join(installedRoot, relativePath), `installed ${manifest.name} ${relativePath}`);
  }
}

function regularFileInventory(directory, label) {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label} directory is missing: ${directory}`);
  }
  const files = [];
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const absoluteDirectory = path.join(directory, relativeDirectory);
    for (const entry of fs
      .readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        pending.push(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath.split(path.sep).join("/"));
      } else {
        throw new Error(`${label} contains a non-regular entry: ${path.join(directory, relativePath)}`);
      }
    }
  }
  return files.sort();
}

function assertPackageInventory(label, value, expectedDirectories) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an explicit string array`);
  }
  const directories = value.map((entry) => entry.split(path.sep).join("/"));
  if (directories.some((entry) => !/^packages\/[a-z0-9-]+$/u.test(entry))) {
    throw new Error(`${label} must name explicit packages/<directory> entries without globs or traversal`);
  }
  const duplicates = directories.filter((entry, index) => directories.indexOf(entry) !== index);
  if (duplicates.length > 0) {
    throw new Error(`${label} contains duplicate package entries: ${[...new Set(duplicates)].join(", ")}`);
  }
  const omitted = expectedDirectories.filter((entry) => !directories.includes(entry));
  const unknown = directories.filter((entry) => !expectedDirectories.includes(entry));
  if (omitted.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} does not match the package-directory inventory (omitted: ${omitted.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`
    );
  }
}
