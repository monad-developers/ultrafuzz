import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "frontend", "dist");
const target = path.join(root, "dist", "public");
const javascriptBundle = path.join(source, "assets", "dashboard.js");

const bundleStat = fs.lstatSync(javascriptBundle);
if (!bundleStat.isFile() || bundleStat.isSymbolicLink()) {
  throw new Error(`dashboard browser bundle is not a regular file: ${javascriptBundle}`);
}
if (bundleStat.size > 16 * 1024 * 1024) {
  throw new Error(`dashboard browser bundle exceeds the 16 MiB verification limit: ${javascriptBundle}`);
}
const bundleSource = fs.readFileSync(javascriptBundle, "utf8");
const executableSource = bundleSource
  .replaceAll(`'require("ajv/dist/runtime/ucs2length").default'`, "''")
  .replaceAll(`'require("ajv/dist/runtime/equal").default'`, "''");
if (/\brequire\s*\(/u.test(executableSource)) {
  throw new Error("dashboard browser bundle contains a CommonJS require call");
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });
