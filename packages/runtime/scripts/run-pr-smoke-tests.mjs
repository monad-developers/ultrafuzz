import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const supportingTestFiles = [
  "dist-test/test/agent-adapter-boundaries.test.js",
  "dist-test/test/runtime-test-shard.test.js",
  "dist-test/test/source-revision.test.js",
  "dist-test/test/workflow-control.test.js"
];

const namedTests = new Map([
  [
    "test/runtime.test.ts",
    [
      "init resolves one-hour node and execution-resource timeout defaults",
      "validate rejects unknown agent references before launch",
      "plan creates run layout, graph fingerprint, and rendered prompt before Smithers submission",
      "compileSmithersWorkflow gates native dependencies on deterministic artifact verification",
      "compileSmithersWorkflow maps cloud attempts to portable provider sandboxes",
      "resume, replay, and fork delegate linked runs to Smithers lifecycle verbs",
      "ordinary resume checks active-run ownership before detached preflight",
      "a refresh resume reuses its own ownership inspection instead of inspecting twice",
      "native continuation does not use historical trusted CLI identity as an authorization gate",
      // Reads the release that is actually pinned. This is the lane's tripwire
      // for a runner bump that widens an enum or the inspect envelope, which
      // otherwise only shows up as a failed production run.
      "pinned runner state and envelope contracts match Ultrafuzz's mirrors",
      "the pinned runner drops resume pointers only from dead attempts"
    ]
  ],
  [
    "test/generated-workflow-verifier.test.ts",
    ["generated workflow input is an exact current-only envelope with bounded JSON operator data"]
  ]
]);
const bunTestFile = "test/runtime.test.ts";
const bunTestNamePrefix = "Bun adapter contract: ";
const bunTestNames = [
  "generated DeepSeek adapter uses the official endpoint and preserves independent usage components",
  "generated DeepSeek adapter cleans an upstream command when environment policy rejects it",
  "generated DeepSeek adapter corrects Smithers result and failed-attempt telemetry",
  "generated DeepSeek adapter rejects ambiguous or noncanonical result telemetry",
  // Needs bun:sqlite, so it can only run in this lane. Gates the claim that the
  // pinned runner's schema migrations are additive over a stopped 0.34.0 store.
  "pinned store migrations are additive over a 0.34.0 database"
];
const selectedBunTestNames = bunTestNames.map((name) => `${bunTestNamePrefix}${name}`);
const smokeEnvironment = { ...process.env };
delete smokeEnvironment.ULTRAFUZZ_RUNTIME_TEST_SHARD;
const selectedTestNames = [...namedTests.values()].flat();

for (const [sourcePath, names] of namedTests) {
  const source = readFileSync(sourcePath, "utf8");
  for (const name of names) {
    if (!source.includes(`test(${JSON.stringify(name)}`)) {
      throw new Error(`PR runtime smoke test is not registered: ${name}`);
    }
  }
}
const bunTestSource = readFileSync(bunTestFile, "utf8");
for (const name of bunTestNames) {
  if (!bunTestSource.includes(JSON.stringify(name))) {
    throw new Error(`PR Bun runtime smoke test is not registered: ${name}`);
  }
}

runNodeTests(supportingTestFiles);
runNodeTests(
  [...namedTests.keys()].map((sourcePath) => `dist-test/${sourcePath.replace(/\.ts$/u, ".js")}`),
  selectedTestNames,
  selectedTestNames
);
runBunTests(`dist-test/${bunTestFile.replace(/\.ts$/u, ".js")}`, selectedBunTestNames);

function runNodeTests(files, testNames, expectedTestNames) {
  const args = ["--test", "--test-reporter=tap"];
  if (testNames !== undefined) {
    const pattern = `^(?:${testNames.map(escapeRegExp).join("|")})$`;
    args.push(`--test-name-pattern=${pattern}`);
  }
  args.push(...files);

  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: smokeEnvironment,
    stdio: ["inherit", "pipe", "pipe"]
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (expectedTestNames !== undefined) assertNamedTestsPassed(result.stdout ?? "", expectedTestNames);
}

function runBunTests(file, testNames) {
  const pattern = `^(?:${testNames.map(escapeRegExp).join("|")})$`;
  const result = spawnSync("bun", ["test", file, "--test-name-pattern", pattern], {
    encoding: "utf8",
    env: smokeEnvironment,
    stdio: ["inherit", "pipe", "pipe"]
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  assertBunTestsPassed(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, testNames);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertNamedTestsPassed(output, expectedTestNames) {
  const passedTestNames = [...output.matchAll(/^ok [0-9]+ - (.+)$/gmu)]
    .map((match) => match[1])
    .filter((name) => !name.includes(" # SKIP") && !name.includes(" # TODO"))
    .sort();
  const expected = [...expectedTestNames].sort();
  if (passedTestNames.length !== expected.length || passedTestNames.some((name, index) => name !== expected[index])) {
    throw new Error(`PR runtime smoke passed unexpected tests: ${JSON.stringify(passedTestNames)}`);
  }
}

// Bun's runner prints a `(fail) <name>` line per failure but no per-test line
// for a pass -- verified against the pinned `bun-version: 1.3.14` in ci.yml, and
// against 1.4.0. So the post-condition is read off the run summary instead: the
// name pattern selects exactly `expectedTestNames`, so a rename, a skip or a
// filtered-out test shows up as a pass count below the expected one, which is
// the property this check exists to enforce. `stripAnsi` because bun colourises
// the summary whenever it believes it has a terminal.
function assertBunTestsPassed(output, expectedTestNames) {
  const plain = stripAnsi(output);
  const failures = [...plain.matchAll(/^\(fail\) (.+?)(?: \[[^\]]*\])?$/gmu)].map((match) => match[1]);
  if (failures.length > 0) {
    throw new Error(`PR Bun runtime smoke failed tests: ${JSON.stringify(failures)}`);
  }
  const summary = (label) => {
    const matches = [...plain.matchAll(new RegExp(`^\\s*(\\d+) ${label}$`, "gmu"))].map((match) => Number(match[1]));
    if (matches.length !== 1) {
      throw new Error(`PR Bun runtime smoke could not read the "${label}" count from the runner summary`);
    }
    return matches[0];
  };
  const passed = summary("pass");
  const failed = summary("fail");
  if (failed !== 0) throw new Error(`PR Bun runtime smoke reported ${failed} failing test(s)`);
  if (passed !== expectedTestNames.length) {
    throw new Error(
      `PR Bun runtime smoke ran ${passed} of ${expectedTestNames.length} expected tests; one was renamed, skipped, or filtered out`
    );
  }
}

function stripAnsi(value) {
  // Built with `new RegExp` rather than a literal: the CSI introducer is a
  // control character, which a regex literal cannot carry past `no-control-regex`.
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
}
