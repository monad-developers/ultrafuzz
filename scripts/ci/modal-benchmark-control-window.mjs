import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseStrictJsonBytes, readRegularFileSnapshot } from "../../packages/artifacts/dist/index.js";
import { MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID } from "../../packages/modal/dist/modal-contracts.js";
import { readModalDocument } from "../../packages/modal/dist/modal-documents.js";

const SCHEMA_VERSION = "ultrafuzz.modal.ci-control-window.v1";
const MAX_CONTROL_BYTES = 1024 * 1024;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const GENERATION = /^[1-9][0-9]*-[1-9][0-9]*$/u;
const REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const WINDOW_KEYS = [
  "schema_version",
  "candidate_commit",
  "repository",
  "generation",
  "mode",
  "manifest_sha256",
  "control_timeout_seconds",
  "started_at_epoch_seconds",
  "deadline_at_epoch_seconds"
];

export function createModalBenchmarkControlWindow(input) {
  const identity = expectedIdentity(input);
  const manifest = readManifest(input.manifestPath, identity);
  const startedAt = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
    throw new Error("Modal benchmark control start must be a positive epoch second");
  }
  const deadlineAt = startedAt + manifest.control_timeout_seconds;
  if (!Number.isSafeInteger(deadlineAt)) throw new Error("Modal benchmark control deadline exceeds the safe range");
  const window = {
    schema_version: SCHEMA_VERSION,
    candidate_commit: identity.candidateCommit,
    repository: identity.repository,
    generation: identity.generation,
    mode: identity.mode,
    manifest_sha256: manifestDigest(input.manifestPath),
    control_timeout_seconds: manifest.control_timeout_seconds,
    started_at_epoch_seconds: startedAt,
    deadline_at_epoch_seconds: deadlineAt
  };
  const outputPath = path.resolve(input.outputPath);
  fs.writeFileSync(outputPath, `${JSON.stringify(window, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return window;
}

export function readModalBenchmarkControlWindow(input) {
  const identity = expectedIdentity(input);
  const manifest = readManifest(input.manifestPath, identity);
  const windowPath = path.resolve(input.windowPath);
  const value = parseStrictJsonBytes(boundedRegularFile(windowPath, "Modal benchmark control window"), {
    maxBytes: MAX_CONTROL_BYTES,
    maxDepth: 8,
    maxItems: 32,
    maxProperties: 32
  });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Modal benchmark control window must be an object");
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...WINDOW_KEYS].sort())) {
    throw new Error("Modal benchmark control window has unexpected fields");
  }
  if (
    value.schema_version !== SCHEMA_VERSION ||
    value.candidate_commit !== identity.candidateCommit ||
    value.repository !== identity.repository ||
    value.generation !== identity.generation ||
    value.mode !== identity.mode
  ) {
    throw new Error("Modal benchmark control window identity does not match the producer attempt");
  }
  if (!SHA256.test(value.manifest_sha256) || value.manifest_sha256 !== manifestDigest(input.manifestPath)) {
    throw new Error("Modal benchmark control window is not bound to the restored manifest");
  }
  if (
    !Number.isSafeInteger(value.control_timeout_seconds) ||
    value.control_timeout_seconds !== manifest.control_timeout_seconds ||
    !Number.isSafeInteger(value.started_at_epoch_seconds) ||
    value.started_at_epoch_seconds <= 0 ||
    !Number.isSafeInteger(value.deadline_at_epoch_seconds) ||
    value.deadline_at_epoch_seconds !== value.started_at_epoch_seconds + value.control_timeout_seconds
  ) {
    throw new Error("Modal benchmark control window deadline is invalid");
  }
  return value;
}

function readManifest(manifestPath, identity) {
  const absolutePath = path.resolve(manifestPath);
  boundedRegularFile(absolutePath, "Modal benchmark control manifest");
  const manifest = readModalDocument(absolutePath, MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID).value;
  if (
    manifest.candidate_commit !== identity.candidateCommit ||
    manifest.repository !== identity.repository ||
    manifest.generation !== identity.generation ||
    manifest.mode !== identity.mode
  ) {
    throw new Error("Modal benchmark control manifest identity does not match the producer attempt");
  }
  if (!Number.isSafeInteger(manifest.control_timeout_seconds) || manifest.control_timeout_seconds < 300) {
    throw new Error("Modal benchmark control timeout is invalid");
  }
  return manifest;
}

function expectedIdentity(input) {
  if (!FULL_COMMIT.test(input.candidateCommit ?? "")) throw new Error("candidate commit must be a full lowercase SHA");
  if (!REPOSITORY.test(input.repository ?? "")) throw new Error("repository must be a canonical public GitHub URL");
  if (!GENERATION.test(input.generation ?? "")) throw new Error("generation must be a GitHub run-attempt pair");
  if (input.mode !== "smoke" && input.mode !== "full") throw new Error("benchmark mode must be smoke or full");
  return {
    candidateCommit: input.candidateCommit,
    repository: input.repository,
    generation: input.generation,
    mode: input.mode
  };
}

function manifestDigest(manifestPath) {
  return createHash("sha256")
    .update(boundedRegularFile(path.resolve(manifestPath), "Modal benchmark control manifest"))
    .digest("hex");
}

function boundedRegularFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_CONTROL_BYTES) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return readRegularFileSnapshot(filePath, MAX_CONTROL_BYTES);
}

function main(args) {
  const [command, manifestPath, windowPath, candidateCommit, repository, generation, mode] = args;
  if (args.length !== 7 || (command !== "create" && command !== "deadline")) {
    throw new Error(
      "usage: modal-benchmark-control-window.mjs <create|deadline> <manifest> <window> <candidate> <repository> <generation> <smoke|full>"
    );
  }
  if (command === "create") {
    console.log(
      JSON.stringify(
        createModalBenchmarkControlWindow({
          manifestPath,
          outputPath: windowPath,
          candidateCommit,
          repository,
          generation,
          mode
        })
      )
    );
    return;
  }
  console.log(
    readModalBenchmarkControlWindow({ manifestPath, windowPath, candidateCommit, repository, generation, mode })
      .deadline_at_epoch_seconds
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
