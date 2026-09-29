import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { temporaryRoot } from "./temporary-root.js";

// Appends a comment to one of the five compiled modules VALIDATOR_BUILD_IDENTITY hashes, exactly as a
// comment-only rebuild does, but only for the child process that loads it.
const REBUILT_VALIDATOR_PRELOAD = String.raw`
import fs from "node:fs";
const rebuilt = process.env.ULTRAFUZZ_TEST_REBUILT_VALIDATOR_MODULE;
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const contents = readFileSync.call(this, file, ...rest);
  return file === rebuilt && Buffer.isBuffer(contents) ? Buffer.concat([contents, Buffer.from("\n// rebuilt\n")]) : contents;
};
`;

/** The `@ultrafuzz/artifacts` entry a rebuilt-validator script imports to see its own identity. */
export const ARTIFACTS_MODULE_URL = import.meta.resolve("@ultrafuzz/artifacts");

/**
 * Run the ES module `script` in a child process whose `VALIDATOR_BUILD_IDENTITY` differs from this
 * process's, as it would after a rebuild. The script reads `input` from the JSON file named by
 * `process.argv[2]`; its stdout is parsed as JSON and returned.
 */
export function runWithRebuiltValidator(script: string, input: unknown, cwd: string): unknown {
  const scripts = temporaryRoot("ufz-rebuilt-validator-");
  fs.writeFileSync(path.join(scripts, "preload.mjs"), REBUILT_VALIDATOR_PRELOAD, "utf8");
  fs.writeFileSync(path.join(scripts, "script.mjs"), script, "utf8");
  fs.writeFileSync(path.join(scripts, "input.json"), JSON.stringify(input), "utf8");
  const stdout = execFileSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(path.join(scripts, "preload.mjs")).href,
      path.join(scripts, "script.mjs"),
      path.join(scripts, "input.json")
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        ULTRAFUZZ_TEST_REBUILT_VALIDATOR_MODULE: path.join(
          path.dirname(fileURLToPath(ARTIFACTS_MODULE_URL)),
          "strict-json.js"
        )
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000
    }
  );
  return JSON.parse(stdout) as unknown;
}
