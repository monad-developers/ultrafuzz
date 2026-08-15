import { spawnSync } from "node:child_process";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const shard = args[0];
if (args.length !== 1 || !/^[1-9][0-9]*\/[1-9][0-9]*$/u.test(shard ?? "")) {
  throw new Error("run-runtime-test-shard.mjs requires exactly one index/total argument");
}

const result = spawnSync(process.execPath, ["--test", "dist-test/test/runtime.test.js"], {
  env: { ...process.env, ULTRAFUZZ_RUNTIME_TEST_SHARD: shard },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
