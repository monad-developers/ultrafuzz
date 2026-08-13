import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const catalogPath = path.join(root, "packages", "config", "audit-profiles.yml");
const outputPath = path.join(root, "docs", "reference", "audit-profiles.md");
const catalog = YAML.parse(fs.readFileSync(catalogPath, "utf8"));
const output = render(catalog);

if (process.argv.includes("--check")) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== output) {
    console.error("docs/reference/audit-profiles.md is stale; run pnpm docs:audit-profiles");
    process.exit(1);
  }
} else {
  fs.writeFileSync(outputPath, output, "utf8");
  console.log(path.relative(root, outputPath));
}

function render(catalog) {
  const profiles = Object.entries(catalog.profiles);
  const rows = profiles.map(([id, profile]) => {
    const name = `\`${id}\`${id === "default" ? " (default)" : ""}`;
    const topology = profile.topology_path === undefined ? "Project topology" : `\`${profile.topology_path}\``;
    const settings = Object.entries(profile.settings)
      .map(([key, value]) => `\`${key}=${formatValue(value)}\``)
      .join("; ");
    return `| ${name} | ${escapeCell(profile.intended_use)} | ${topology} | ${settings || "None"} |`;
  });
  return `# Audit profiles

This reference is generated from \`packages/config/audit-profiles.yml\`. Run \`pnpm docs:audit-profiles\` after changing the catalog; \`pnpm docs:check\` rejects drift.

| Profile | Intended use | Topology | Profile settings |
| --- | --- | --- | --- |
${rows.join("\n")}

Profiles provide coherent defaults. Explicit project configuration and one-run CLI options still win:

\`built-in defaults < audit profile < project configuration < CLI/runtime override\`

Topology selection is atomic rather than merged:

\`.ultrafuzz/topology.yml < profile topology_path < project topology_path < --topology-path\`

The \`default\` profile is reserved for the unmodified project workflow: it has no settings overrides and uses the project topology. Catalogs without \`profiles.default\` are rejected.

Use \`ultrafuzz config audit-profiles\` for the catalog, \`ultrafuzz config audit-profile <name>\` for effective project settings, and \`ultrafuzz run --audit-profile <name>\` for a one-run override.

Ultrafuzz ships \`full\`, \`smoke\`, and \`invariant-only\` topology files. Inspect them with \`ultrafuzz topology list\` and \`ultrafuzz topology show <name>\`, or safely copy one into a project with \`ultrafuzz topology copy <name> <path>\`.
`;
}

function formatValue(value) {
  return Array.isArray(value) ? value.join(",") : String(value);
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
