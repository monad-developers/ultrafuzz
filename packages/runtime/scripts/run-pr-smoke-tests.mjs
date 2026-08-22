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
      "resume reopens a terminal failed workflow with only pending ready work",
      "forced retry resume renews a stale terminal deadline without duplicating an active workflow"
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
  "generated DeepSeek adapter rejects ambiguous or noncanonical result telemetry"
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

function assertBunTestsPassed(output, expectedTestNames) {
  const missing = expectedTestNames.filter((name) => !output.includes(`(pass) ${name}`));
  if (missing.length > 0) {
    throw new Error(`PR Bun runtime smoke did not execute expected tests: ${JSON.stringify(missing)}`);
  }
}
