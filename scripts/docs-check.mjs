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
  "docs/reference/prompt-catalog-data.yml",
  "docs/reference/prompt-catalog.md",
  "docs/reference/prompt-variables.md",
  "docs/reference/references.md",
  "docs/reference/topology-yaml.md",
  "docs/explanation/index.md",
  "docs/explanation/aave-v4-invariant-case-study.md",
  "docs/explanation/backends-safety.md",
  "docs/explanation/bugfinder.md",
  "docs/explanation/campaigns.md",
  "docs/explanation/provider-harness-research.md",
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

// The provider/harness page builds a version-gap argument on the harness
// versions the Modal worker image installs. The image source is the single
// source of truth: read the pins out of `runner.ts` and assert the docs print
// the same literals. This check keeps no copy of the version itself, so a pin
// bump means editing `runner.ts` and every version literal the page
// prints — and nothing here.
const runnerSource = "packages/modal/src/runner.ts";
if (!existsSync(runnerSource)) {
  console.error(
    `Cannot verify harness version pins: ${runnerSource} is missing. If the Modal image source moved, update this check.`
  );
  process.exit(1);
}
const runnerText = readFileSync(runnerSource, "utf8");
// `runner.ts` never spells the Codex installable literally — it declares
// `CODEX_CLI_VERSION` and interpolates it into the install command — so the
// constant is what gets matched here and `@openai/codex@<v>` is what the docs
// must print. Claude Code is spelled inline in the install command instead.
// The version character classes admit prerelease spellings (`2.2.0-rc.1`,
// `0.1.0+build`) as well as release ones, while requiring an alphanumeric final
// character so adjacent sentence punctuation is not captured as part of a pin.
// A narrower `[\d.]+` would silently truncate a prerelease on both sides of the
// comparison, so a stale doc could still pass; `VERSION_CHARS` is shared with
// `literalPattern` below so the two halves cannot disagree about what a version
// looks like.
const VERSION_CHARS = "[\\w.+-]*\\w";
const pinPatterns = [
  ["@openai/codex", /CODEX_CLI_VERSION = "([^"]+)"/u],
  ["@anthropic-ai/claude-code", new RegExp(`@anthropic-ai\\/claude-code@(${VERSION_CHARS})`, "u")]
];
const harnessDocs = ["docs/explanation/provider-harness-research.md"];
const staleVersionPins = [];
for (const [pkg, pattern] of pinPatterns) {
  const match = pattern.exec(runnerText);
  if (match === null) {
    console.error(
      `Cannot verify the ${pkg} pin: ${pattern} no longer matches ${runnerSource}. Update this check to follow the image source.`
    );
    process.exit(1);
  }
  const pin = `${pkg}@${match[1]}`;
  // Existence is not enough: a pin may be printed at more than one site, and an
  // `includes` test would pass while another site kept the old version. Every
  // printed literal has to be the current pin, and a stale one is reported with
  // its line so the half-applied bump is named rather than just the file. A `.`
  // is the only regex metacharacter an npm package name can contain, so escaping
  // it is enough to build the literal pattern.
  const literalPattern = new RegExp(`${pkg.replaceAll(".", "\\.")}@${VERSION_CHARS}`, "gu");
  // The two halves must agree on the version grammar, or the comparison below
  // would pit a full pin against a truncated literal and report a stale doc
  // that is current (or, worse, accept a stale one). Asserting the pin itself
  // is expressible in `literalPattern` is what keeps them in step.
  if (pin.match(new RegExp(`^${literalPattern.source}$`, "u")) === null) {
    console.error(
      `Cannot verify the ${pkg} pin: ${runnerSource} declares ${match[1]}, which this check's version pattern (${VERSION_CHARS}) cannot express. Widen it.`
    );
    process.exit(1);
  }
  for (const file of harnessDocs) {
    const lines = readFileSync(file, "utf8").split("\n");
    let printed = 0;
    for (const [index, line] of lines.entries()) {
      for (const literal of line.match(literalPattern) ?? []) {
        printed += 1;
        if (literal !== pin) {
          staleVersionPins.push(`${file}:${index + 1} prints ${literal}, expected ${pin}`);
        }
      }
    }
    if (printed === 0) {
      staleVersionPins.push(`${file} never prints ${pin}`);
    }
  }
}
if (staleVersionPins.length > 0) {
  console.error(
    `Harness version pins out of sync between ${runnerSource} and the provider/harness document: ${staleVersionPins.join(", ")}`
  );
  process.exit(1);
}
