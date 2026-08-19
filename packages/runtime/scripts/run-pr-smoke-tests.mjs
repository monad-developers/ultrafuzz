import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const supportingTestFiles = [
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
      "compileSmithersWorkflow gates native dependencies on deterministic artifact verification"
    ]
  ],
  [
    "test/generated-workflow-verifier.test.ts",
    ["generated workflow input is an exact current-only envelope with bounded JSON operator data"]
  ]
]);
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

runNodeTests(supportingTestFiles);
runNodeTests(
  [...namedTests.keys()].map((sourcePath) => `dist-test/${sourcePath.replace(/\.ts$/u, ".js")}`),
  selectedTestNames,
  selectedTestNames.length
);

function runNodeTests(files, testNames, expectedPasses) {
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
  if (expectedPasses !== undefined) assertTapSummary(result.stdout ?? "", expectedPasses);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertTapSummary(output, expectedPasses) {
  const summary = new Map(
    [...output.matchAll(/^# (tests|pass|fail|skipped) ([0-9]+)$/gmu)].map((match) => [match[1], Number(match[2])])
  );
  if (
    summary.get("tests") !== expectedPasses ||
    summary.get("pass") !== expectedPasses ||
    summary.get("fail") !== 0 ||
    summary.get("skipped") !== 0
  ) {
    throw new Error(`PR runtime smoke expected ${expectedPasses} selected tests to pass without skips`);
  }
}
