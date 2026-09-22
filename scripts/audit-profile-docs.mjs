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

With freshly initialized configuration and the shipped topology, the main profiles allocate work as follows:

| Control | Default | Exhaustive |
| --- | --- | --- |
| Ordinary strategy passes | 2 | 3 |
| Stateful pipeline | All five stages, once each | All five stages, once each |
| Selected invariant properties | High priority | High and medium priority |
| Final Recon fuzzing campaign | 1 hour | 4 hours |

Ordinary strategy passes are separate from failure retries and from the fuzzer's randomized call sequences. Exhaustive also retains its differential and dynamic specialist lanes.

The campaign duration covers one shared suite of selected properties, not a separate campaign per property. Setup, a ten-minute deployment smoke, shutdown, and report finalization take additional time. Exhaustive gives only the final campaign node a 16,200-second (4h30m) attempt timeout. Its five allowed attempts share the existing 24-hour workflow deadline with all other work; they are not a promise that every retry can finish.

For these normal audit profiles, \`reference_expectations\` tags link properties to externally expected checks without bypassing the priority threshold. Excluded checks remain visible as unselected in reporting. The benchmark-specific \`invariant-only\` profile explicitly uses \`reference_expectation_selection=mandatory\`, so tagged properties remain required there regardless of priority.

Fresh initialization leaves profile-managed priority and campaign settings unset in the project file, so switching profiles inherits the appropriate values. Explicit settings in an existing project still override the selected profile.

Use \`ultrafuzz config audit-profiles\` for the catalog, \`ultrafuzz config audit-profile <name>\` for effective project settings, and \`ultrafuzz run --audit-profile <name>\` for a one-run override.

Ultrafuzz ships \`default\`, \`exhaustive\`, \`smoke\`, and \`invariant-only\` topology files. Inspect them with \`ultrafuzz topology list\` and \`ultrafuzz topology show <name>\`, or safely copy one into a project with \`ultrafuzz topology copy <name> <path>\`.
`;
}

function formatValue(value) {
  return Array.isArray(value) ? value.join(",") : String(value);
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
