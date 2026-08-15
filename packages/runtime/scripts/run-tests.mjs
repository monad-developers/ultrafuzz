import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const selectors = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
const passThrough = process.argv.slice(2).filter((argument) => argument.startsWith("-"));

const selectorFiles = new Map([
  [
    "supporting",
    readdirSync("dist-test/test")
      .filter((entry) => entry.endsWith(".test.js") && entry !== "runtime.test.js")
      .sort()
      .map((entry) => path.join("dist-test/test", entry))
  ],
  [
    "materialize",
    ["dist-test/test/materialize.test.js", "dist-test/test/clean.test.js", "dist-test/test/runtime.test.js"]
  ],
  ["clean", ["dist-test/test/clean.test.js", "dist-test/test/runtime.test.js"]],
  ["smithers", ["dist-test/test/runtime.test.js"]]
]);

const testFiles =
  selectors.length === 0
    ? readdirSync("dist-test/test")
        .filter((entry) => entry.endsWith(".test.js"))
        .sort()
        .map((entry) => path.join("dist-test/test", entry))
    : selectors.flatMap((selector) => selectorFiles.get(selector) ?? [`dist-test/test/${selector}.test.js`]);

const result = spawnSync("node", ["--test", ...testFiles, ...passThrough], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
