import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { renderSmithersPackageJson, smithersDependencyInstallArgs } from "../../runtime/dist/smithers-package.js";

const seedRoot = process.argv[2] ?? "/opt/ultrafuzz-smithers-seed";
fs.mkdirSync(seedRoot, { recursive: false, mode: 0o755 });
const manifestPath = path.join(seedRoot, "package.json");
const manifest = renderSmithersPackageJson();
fs.writeFileSync(manifestPath, manifest, { encoding: "utf8", flag: "wx", mode: 0o444 });
execFileSync("npm", smithersDependencyInstallArgs({ prefix: seedRoot, registry: "https://registry.npmjs.org" }), {
  stdio: "inherit"
});
if (fs.readFileSync(manifestPath, "utf8") !== manifest) {
  throw new Error("Smithers seed installation changed the pinned generated manifest");
}
