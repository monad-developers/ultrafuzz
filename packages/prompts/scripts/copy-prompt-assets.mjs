import { cpSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../.ultrafuzz/prompts/", import.meta.url));
const destination = fileURLToPath(new URL("../dist/assets/prompts", import.meta.url));

if (!statSync(source).isDirectory()) {
  throw new Error(`canonical prompt asset root is not a directory: ${source}`);
}

// `pnpm -r test` can build this package from several dependents at once. Copying in place would let
// one process remove the destination while another is mid-copy, so stage a complete tree and swap it
// into position instead. Every step tolerates a concurrent winner.
const assetsRoot = path.dirname(destination);
const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
const staging = path.join(assetsRoot, `.prompts.staging-${suffix}`);
const superseded = path.join(assetsRoot, `.prompts.superseded-${suffix}`);

mkdirSync(assetsRoot, { recursive: true });
rmSync(staging, { recursive: true, force: true });
cpSync(source, staging, { recursive: true, force: true });

try {
  renameSync(destination, superseded);
} catch (error) {
  if (!isMissing(error)) throw error;
}
try {
  renameSync(staging, destination);
} catch (error) {
  // A concurrent build already published an identical tree; keep the winner's directory.
  if (!isAlreadyPublished(error)) throw error;
  rmSync(staging, { recursive: true, force: true });
}
rmSync(superseded, { recursive: true, force: true });

function isMissing(error) {
  return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isAlreadyPublished(error) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(String(error.code))
  );
}
