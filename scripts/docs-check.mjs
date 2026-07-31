import { existsSync, readdirSync, readFileSync } from "node:fs";

const requiredDocs = [
  "README.md",
  "docs/index.md",
  "docs/contributing.md",
  "docs/SPECS.md",
  "docs/assets/ultrafuzz-logo.svg",
  "docs/assets/ultrafuzz-dashboard.png",
  "docs/tutorials/index.md",
  "docs/tutorials/first-campaign.md",
  "docs/how-to/index.md",
  "docs/how-to/clean-runs.md",
  "docs/how-to/edit-prompts-topology.md",
  "docs/how-to/materialize-tests.md",
  "docs/how-to/restart-continue.md",
  "docs/how-to/review-findings.md",
  "docs/how-to/run-evals.md",
  "docs/how-to/use-dashboard.md",
  "docs/reference/index.md",
  "docs/reference/artifacts-reports.md",
  "docs/reference/cli.md",
  "docs/reference/configuration.md",
  "docs/reference/dashboard.md",
  "docs/reference/development.md",
  "docs/reference/evals.md",
  "docs/reference/prompt-variables.md",
  "docs/reference/references.md",
  "docs/reference/topology-yaml.md",
  "docs/explanation/index.md",
  "docs/explanation/backends-safety.md",
  "docs/explanation/bugfinder.md",
  "docs/explanation/campaigns.md",
  "docs/explanation/topology-prompts-artifacts.md",
  "docs/cli.md",
  "docs/config.md",
  "docs/security.md",
  ".ultrafuzz/prompts/review/final-report.md"
];

const missing = requiredDocs.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`Missing required docs: ${missing.join(", ")}`);
  process.exit(1);
}

// Every top-level CLI command must be documented in both the CLI overview and
// the CLI reference, so a new command cannot ship undocumented.
const commandsDir = "packages/cli/src/commands";
const commandNames = readdirSync(commandsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => entry.name.slice(0, -".ts".length))
  .sort();

const cliOverview = readFileSync("docs/cli.md", "utf8");
const cliReference = readFileSync("docs/reference/cli.md", "utf8");
// Require a delimited token in the overview so an incidental prefix such as
// `logs-` cannot satisfy a future `logs` command.
const overviewMentions = (command) => new RegExp(`\`${command}(?:\`| [^\`]*\`)`, "u").test(cliOverview);
const undocumented = commandNames.filter(
  (command) => !cliReference.includes(`ultrafuzz ${command}`) || !overviewMentions(command)
);
if (undocumented.length > 0) {
  console.error(`CLI commands missing from docs/cli.md or docs/reference/cli.md: ${undocumented.join(", ")}`);
  process.exit(1);
}

// Flags that define a documented output contract must be documented too.
const requiredFlagMentions = [
  ["docs/reference/cli.md", "ultrafuzz cancel <run-id>"],
  ["docs/reference/cli.md", "ultrafuzz why <run-id>"],
  ["docs/reference/cli.md", "ultrafuzz timeline <run-id>"],
  ["docs/reference/cli.md", "ultrafuzz events <run-id>"],
  ["docs/reference/cli.md", "ultrafuzz node <run-id> <node-id>"],
  ["docs/reference/cli.md", "ultrafuzz snapshots <run-id>"],
  ["docs/reference/cli.md", "ultrafuzz doctor"],
  ["docs/reference/cli.md", "--tree"],
  ["docs/reference/cli.md", "--history"],
  ["docs/reference/cli.md", "--attempts"],
  ["docs/reference/cli.md", "--tools"],
  ["docs/reference/cli.md", "--interval <seconds>"],
  ["docs/reference/cli.md", "--watch"],
  ["docs/reference/cli.md", "--node <node-id>"],
  ["docs/reference/cli.md", "--type <category>"],
  ["docs/reference/cli.md", "--since <duration>"],
  ["docs/reference/cli.md", "--limit <n>"],
  ["docs/reference/cli.md", "--iteration <n>"]
];
const missingFlagMentions = requiredFlagMentions.filter(
  ([file, needle]) => !readFileSync(file, "utf8").includes(needle)
);
if (missingFlagMentions.length > 0) {
  console.error(
    `Missing documented CLI surfaces: ${missingFlagMentions.map(([file, needle]) => `${needle} in ${file}`).join(", ")}`
  );
  process.exit(1);
}
