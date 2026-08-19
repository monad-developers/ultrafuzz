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
  [...namedTests.values()].flat()
);

function runNodeTests(files, testNames) {
  const args = ["--test"];
  if (testNames !== undefined) {
    const pattern = `^(?:${testNames.map(escapeRegExp).join("|")})$`;
    args.push(`--test-name-pattern=${pattern}`);
  }
  args.push(...files);

  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
