import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { renderSmithersPackageJson } from "../../runtime/dist/smithers-package.js";

const seedRoot = process.argv[2] ?? "/opt/ultrafuzz-smithers-seed";
const lockedSeedRoot = new URL("../smithers-seed/", import.meta.url);
fs.mkdirSync(seedRoot, { recursive: false, mode: 0o755 });
const manifestPath = path.join(seedRoot, "package.json");
const manifest = renderSmithersPackageJson();
const lockedManifest = fs.readFileSync(new URL("package.json", lockedSeedRoot), "utf8");
if (lockedManifest !== manifest) {
  throw new Error("checked-in Smithers seed lock does not match the generated pinned manifest");
}
fs.writeFileSync(manifestPath, manifest, { encoding: "utf8", flag: "wx", mode: 0o444 });
fs.copyFileSync(new URL("package-lock.json", lockedSeedRoot), path.join(seedRoot, "package-lock.json"));
execFileSync(
  "npm",
  [
    "ci",
    "--prefix",
    seedRoot,
    "--ignore-scripts",
    "--registry=https://registry.npmjs.org",
    "--no-audit",
    "--no-fund",
    "--loglevel=error"
  ],
  { stdio: "inherit" }
);
if (fs.readFileSync(manifestPath, "utf8") !== manifest) {
  throw new Error("Smithers seed installation changed the pinned generated manifest");
}
