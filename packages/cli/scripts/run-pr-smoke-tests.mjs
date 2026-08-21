import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const namedTests = new Map([
  ["test/cli.test.ts", ["status surfaces a terminal product and live workflow lifecycle divergence"]],
  ["test/cli-contracts.test.ts", ["known command failures can retain a valid typed data snapshot"]]
]);
const selectedTestNames = [...namedTests.values()].flat();

for (const [sourcePath, names] of namedTests) {
  const source = readFileSync(sourcePath, "utf8");
  for (const name of names) {
    if (!source.includes(`test(${JSON.stringify(name)}`)) {
      throw new Error(`PR CLI smoke test is not registered: ${name}`);
    }
  }
}

const pattern = `^(?:${selectedTestNames.map(escapeRegExp).join("|")})$`;
const files = [...namedTests.keys()].map((sourcePath) => `dist-test/${sourcePath.replace(/\.ts$/u, ".js")}`);
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=tap", `--test-name-pattern=${pattern}`, ...files],
  {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"]
  }
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
assertNamedTestsPassed(result.stdout ?? "", selectedTestNames);

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
    throw new Error(`PR CLI smoke passed unexpected tests: ${JSON.stringify(passedTestNames)}`);
  }
}
