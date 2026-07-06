import { existsSync } from "node:fs";

const requiredDocs = [
  "README.md",
  "docs/index.md",
  "docs/contributing.md",
  "docs/SPECS.md",
  "docs/assets/ultrafuzz-dashboard.png",
  "docs/tutorials/index.md",
  "docs/tutorials/first-campaign.md",
  "docs/how-to/index.md",
  "docs/how-to/clean-runs.md",
  "docs/how-to/edit-prompts-topology.md",
  "docs/how-to/materialize-tests.md",
  "docs/how-to/restart-continue.md",
  "docs/how-to/review-findings.md",
  "docs/how-to/use-dashboard.md",
  "docs/reference/index.md",
  "docs/reference/artifacts-reports.md",
  "docs/reference/cli.md",
  "docs/reference/configuration.md",
  "docs/reference/dashboard.md",
  "docs/reference/development.md",
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
