import { runTests } from "./test-scratch.mjs";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const shard = args[0];
if (args.length !== 1 || !/^[1-9][0-9]*\/[1-9][0-9]*$/u.test(shard ?? "")) {
  throw new Error("run-runtime-test-shard.mjs requires exactly one index/total argument");
}

process.exitCode = await runTests(["--test", "dist-test/test/runtime.test.js"], {
  ULTRAFUZZ_RUNTIME_TEST_SHARD: shard
});
