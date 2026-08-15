import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse, parseDocument } from "yaml";

const SCHEMA_VERSION = "ultrafuzz.modal.toolchain-materials.v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const DIGESTED_IMAGE = /^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/u;
const EXACT_VERSION = /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2}(?:-[A-Za-z0-9.-]+)?$/u;
const REQUIRED_DOWNLOADS = new Set(["node", "foundry", "recon"]);

export function verifyModalToolchainMaterials(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const modalRoot = path.join(root, "packages", "modal");
  const manifestPath = path.join(modalRoot, "toolchain-materials.json");
  const manifestBytes = fs.readFileSync(manifestPath);
  const fingerprint = fs.readFileSync(path.join(modalRoot, "toolchain-materials.sha256"), "utf8");
  const expectedFingerprint = `${sha256(manifestBytes)}  toolchain-materials.json\n`;
  assert(fingerprint === expectedFingerprint, "toolchain material fingerprint does not match the manifest bytes");

  const document = parseDocument(manifestBytes.toString("utf8"), { strict: true, uniqueKeys: true });
  assert(
    document.errors.length === 0,
    `toolchain material manifest is not strict unique-key JSON: ${document.errors[0]}`
  );
  const materials = JSON.parse(manifestBytes.toString("utf8"));
  assert(isRecord(materials), "toolchain material manifest must be an object");
  assert(materials.schema_version === SCHEMA_VERSION, "toolchain material manifest has an unsupported schema");
  assert(
    typeof materials.base_image === "string" && DIGESTED_IMAGE.test(materials.base_image),
    "base image is not digest-pinned"
  );
  assert(
    typeof materials.evmbench_builder_image === "string" && DIGESTED_IMAGE.test(materials.evmbench_builder_image),
    "EVMBench builder image is not digest-pinned"
  );

  assert(isRecord(materials.apt), "toolchain apt material is missing");
  assert(/^20[0-9]{6}T[0-9]{6}Z$/u.test(materials.apt.snapshot), "apt repository is not timestamp-snapshotted");
  assertUniqueSortedStrings(materials.apt.packages, "apt package list");

  assert(Array.isArray(materials.downloads), "toolchain downloads must be an array");
  const downloadNames = new Set();
  for (const download of materials.downloads) {
    assert(isRecord(download), "toolchain download must be an object");
    assert(typeof download.name === "string" && REQUIRED_DOWNLOADS.has(download.name), "unknown toolchain download");
    assert(!downloadNames.has(download.name), `duplicate toolchain download: ${download.name}`);
    downloadNames.add(download.name);
    assert(
      typeof download.version === "string" && EXACT_VERSION.test(download.version),
      `${download.name} version is not exact`
    );
    assert(typeof download.sha256 === "string" && SHA256.test(download.sha256), `${download.name} has no SHA-256`);
    assertSafeHttpsUrl(download.url, `${download.name} download URL`);
  }
  assert(setEquals(downloadNames, REQUIRED_DOWNLOADS), "Node, Foundry, and Recon must all be integrity materials");

  assert(isRecord(materials.global_node_packages), "global Node package materials are missing");
  const modalPackage = readJson(path.join(modalRoot, "package.json"));
  for (const [name, version] of Object.entries(materials.global_node_packages)) {
    assert(typeof version === "string" && EXACT_VERSION.test(version), `${name} global package version is not exact`);
    assert(modalPackage.dependencies?.[name] === version, `${name} is not an exact locked Modal dependency`);
  }
  const workspacePackage = readJson(path.join(root, "package.json"));
  assert(
    workspacePackage.packageManager === materials.package_manager,
    "Corepack package-manager integrity pin drifted"
  );
  assert(
    /^pnpm@[0-9]+\.[0-9]+\.[0-9]+\+sha512\.[a-f0-9]{128}$/u.test(materials.package_manager),
    "package manager has no immutable integrity pin"
  );
  const workspace = parse(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"));
  assert(isRecord(workspace) && isRecord(workspace.allowBuilds), "pnpm lifecycle-script policy is missing");
  assert(
    workspace.allowBuilds["@anthropic-ai/claude-code"] === true,
    "the pinned Claude native installer is not explicitly allowed"
  );
  assert(workspace.allowBuilds.bun === true, "the pinned Bun native installer is not explicitly allowed");
  assert(workspace.allowBuilds["@moonshot-ai/kimi-code"] === false, "the Kimi lifecycle-script policy drifted");
  assert(
    workspace.allowBuilds["better-sqlite3"] === true,
    "the pinned Recon generator SQLite installer is not explicitly allowed"
  );
  assert(
    Object.values(workspace.allowBuilds).every((value) => typeof value === "boolean"),
    "pnpm lifecycle-script policy contains an unresolved decision"
  );

  assert(
    Array.isArray(materials.lockfiles) && materials.lockfiles.length > 0,
    "toolchain lockfile materials are missing"
  );
  const lockKinds = new Set();
  for (const lock of materials.lockfiles) {
    assert(isRecord(lock), "toolchain lockfile material must be an object");
    assert(typeof lock.kind === "string" && !lockKinds.has(lock.kind), `duplicate toolchain lock kind: ${lock.kind}`);
    lockKinds.add(lock.kind);
    const lockPath = safeRelativePath(root, lock.path);
    assert(typeof lock.sha256 === "string" && SHA256.test(lock.sha256), `${lock.kind} lock has no SHA-256`);
    assert(sha256(fs.readFileSync(lockPath)) === lock.sha256, `${lock.kind} lock fingerprint drifted`);
  }

  verifyPnpmClosure(root, materials.global_node_packages);
  verifyPythonClosure(path.join(modalRoot, "security-requirements.lock"));
  verifySmithersClosure(path.join(modalRoot, "smithers-seed"));
  verifyBuildPolicy(root, materials);
  return materials;
}

function verifyPnpmClosure(root, globals) {
  const lock = parse(fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  assert(isRecord(lock) && isRecord(lock.importers) && isRecord(lock.packages), "pnpm lock has an unsupported shape");
  const importer = lock.importers["packages/modal"];
  assert(isRecord(importer) && isRecord(importer.dependencies), "Modal importer is missing from the pnpm lock");
  for (const [name, version] of Object.entries(globals)) {
    const dependency = importer.dependencies[name];
    assert(isRecord(dependency) && dependency.specifier === version, `${name} is not exact in the pnpm importer`);
    assert(
      typeof dependency.version === "string" && dependency.version.startsWith(version),
      `${name} resolution drifted`
    );
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    assert(isRecord(entry) && isRecord(entry.resolution), `pnpm package ${name} has no locked resolution`);
    assert(
      typeof entry.resolution.integrity === "string" && /^sha512-[A-Za-z0-9+/]+=*$/u.test(entry.resolution.integrity),
      `pnpm package ${name} has no registry integrity`
    );
  }
}

function verifyPythonClosure(lockPath) {
  const text = fs.readFileSync(lockPath, "utf8");
  assert(!text.includes("git+"), "Python toolchain lock contains a mutable Git fetch");
  const requirementStarts = text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.length > 0 && !line.startsWith("#") && !/^\s/u.test(line));
  assert(requirementStarts.length > 0, "Python toolchain lock is empty");
  for (let position = 0; position < requirementStarts.length; position += 1) {
    const current = requirementStarts[position];
    const next = requirementStarts[position + 1];
    const block = text
      .split("\n")
      .slice(current.index, next?.index ?? undefined)
      .join("\n");
    assert(/(?:==| @ https:\/\/)/u.test(current.line), `Python requirement is not immutable: ${current.line}`);
    assert(/--hash=sha256:[a-f0-9]{64}/u.test(block), `Python requirement has no SHA-256: ${current.line}`);
  }
}

function verifySmithersClosure(seedRoot) {
  const manifest = readJson(path.join(seedRoot, "package.json"));
  const lock = readJson(path.join(seedRoot, "package-lock.json"));
  assert(lock.lockfileVersion === 3 && isRecord(lock.packages), "Smithers seed must use npm lockfile v3");
  const root = lock.packages[""];
  assert(isRecord(root), "Smithers seed lock has no root package");
  assert(
    JSON.stringify(root.dependencies) === JSON.stringify(manifest.dependencies),
    "Smithers seed dependencies drifted"
  );
  assert(
    JSON.stringify(root.devDependencies) === JSON.stringify(manifest.devDependencies),
    "Smithers seed dev dependencies drifted"
  );
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === "") continue;
    assert(
      isRecord(entry) && typeof entry.version === "string" && EXACT_VERSION.test(entry.version),
      `${name} is not exactly locked`
    );
    assert(
      typeof entry.resolved === "string" && entry.resolved.startsWith("https://registry.npmjs.org/"),
      `${name} has a mutable resolution`
    );
    assert(
      typeof entry.integrity === "string" && /^sha512-[A-Za-z0-9+/]+=*$/u.test(entry.integrity),
      `${name} has no registry integrity`
    );
  }
}

function verifyBuildPolicy(root, materials) {
  const dockerfile = fs.readFileSync(path.join(root, "packages", "modal", "Dockerfile"), "utf8");
  const overlay = fs.readFileSync(path.join(root, "benchmarks", "evmbench", "overlay.Dockerfile"), "utf8");
  const evmbenchRunner = fs.readFileSync(path.join(root, "packages", "evmbench", "src", "runner.ts"), "utf8");
  const runner = fs.readFileSync(path.join(root, "packages", "modal", "src", "runner.ts"), "utf8");
  const seed = fs.readFileSync(path.join(root, "packages", "modal", "scripts", "prepare-smithers-seed.mjs"), "utf8");
  assert(
    dockerfile.startsWith(`FROM ${materials.base_image} AS toolchain\n`),
    "standalone Modal Dockerfile base drifted from the digest material"
  );
  for (const source of [dockerfile, overlay, runner, seed]) {
    assert(!/npm\s+install\s+(?:--global|-g)\b/u.test(source), "unlocked global npm install is forbidden");
    assert(!source.includes("--package-lock=false"), "unlocked npm dependency resolution is forbidden");
  }
  assert(dockerfile.includes("snapshot.ubuntu.com/ubuntu/"), "standalone image does not use the apt snapshot");
  assert(dockerfile.includes("--require-hashes"), "standalone image does not enforce the Python hash lock");
  assert(
    dockerfile.includes(`FROM ${materials.evmbench_builder_image} AS node-tools`),
    "standalone Node tool builder drifted from the digest material"
  );
  assert(dockerfile.includes("pnpm install --frozen-lockfile"), "standalone Node tools do not use the frozen lock");
  assert(dockerfile.includes("recon-generate/dist/index.js"), "standalone image does not expose locked Node tools");
  assert(!dockerfile.includes("node_modules/.bin"), "standalone image links relocatable pnpm command shims");
  assert(runner.includes("--require-hashes"), "Modal image commands do not enforce the Python hash lock");
  assert(runner.includes("loadModalToolchainMaterials"), "Modal image commands do not consume the material manifest");
  assert(runner.includes("sha256sum -c -"), "Modal image commands do not verify downloads before extraction");
  assert(!runner.includes("node_modules/.bin/$tool"), "Modal image links relocatable pnpm command shims");
  assert(seed.includes('"ci"'), "Smithers seed is not installed with npm ci");
  assert(
    overlay.includes(`FROM ${materials.evmbench_builder_image} AS builder`),
    "EVMBench overlay builder image drifted from the digest material"
  );
  assert(overlay.includes("prepare-smithers-seed.mjs"), "EVMBench overlay does not use the locked Smithers seed");
  assert(
    evmbenchRunner.includes("`BASE_IMAGE=${sourceDigest}`"),
    "EVMBench overlay base image is not supplied by digest"
  );
  for (const download of materials.downloads) {
    assert(dockerfile.includes(download.sha256), `${download.name} Dockerfile download is unchecked`);
  }
}

function safeRelativePath(root, value) {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "lockfile path is unsafe"
  );
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  assert(
    relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative),
    "lockfile path escapes the workspace"
  );
  return resolved;
}

function assertSafeHttpsUrl(value, label) {
  assert(typeof value === "string", `${label} is missing`);
  const url = new URL(value);
  assert(
    url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "",
    `${label} is not a fixed HTTPS URL`
  );
}

function assertUniqueSortedStrings(value, label) {
  assert(
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0),
    `${label} is invalid`
  );
  assert(new Set(value).size === value.length, `${label} contains duplicates`);
  assert(JSON.stringify(value) === JSON.stringify([...value].sort()), `${label} must be sorted`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function setEquals(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const option = process.argv.indexOf("--root");
  const root =
    option === -1 ? path.resolve(fileURLToPath(new URL("../..", import.meta.url))) : process.argv[option + 1];
  if (root === undefined) throw new Error("--root requires a directory");
  verifyModalToolchainMaterials(root);
  console.log("Modal toolchain materials verified");
}
