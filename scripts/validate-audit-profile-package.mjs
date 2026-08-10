import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
run("pnpm", ["--filter", "@ultrafuzz/config", "build"], root);
run("pnpm", ["--filter", "@ultrafuzz/prompts", "build"], root);

const expectedConfigFiles = [
  "dist/audit-profiles.yml",
  "dist/topologies/full.yml",
  "dist/topologies/invariant-only.yml",
  "dist/topologies/smoke.yml"
];
assertPackFiles(path.join(root, "packages", "config"), expectedConfigFiles);
assertPackFiles(path.join(root, "packages", "prompts"), [
  "dist/prompts/invariant-only/aggregate-test-files.md",
  "dist/prompts/invariant-only/dedupe-findings.md"
]);

for (const relativePath of expectedConfigFiles) {
  const sourceRelative = relativePath.replace(/^dist\//u, "");
  const source = path.join(root, "packages", "config", sourceRelative);
  const built = path.join(root, "packages", "config", relativePath);
  if (!fs.readFileSync(source).equals(fs.readFileSync(built))) {
    throw new Error(`${relativePath} does not match its packaged source asset`);
  }
}

function assertPackFiles(packageRoot, expected) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed in ${packageRoot}: ${result.stderr || result.stdout}`);
  }
  const output = JSON.parse(result.stdout);
  const files = new Set(output[0]?.files?.map((entry) => entry.path) ?? []);
  for (const expectedPath of expected) {
    if (!files.has(expectedPath)) throw new Error(`${path.basename(packageRoot)} pack is missing ${expectedPath}`);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}
