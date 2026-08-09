import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactSchemaDirectory } from "@ultrafuzz/artifacts";

import { runCli } from "../src/index.js";

test("json validate exposes the strict validator through the primary CLI", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-json-cli-"));
  try {
    const schema = path.join(artifactSchemaDirectory(), "properties.schema.json");
    const valid = path.join(temporary, "valid.json");
    const invalid = path.join(temporary, "invalid.json");
    fs.writeFileSync(valid, '{"schema_version":"ultrafuzz.properties.v1","properties":[]}');
    fs.writeFileSync(invalid, '{"schema_version":"ultrafuzz.properties.v1","properties":[],"extra":true}');

    const validCapture = await capture(["json", "validate", "--schema", schema, "--file", valid]);
    assert.equal(validCapture.code, 0);
    assert.match(validCapture.stdout, /^valid:/u);
    assert.equal(validCapture.stderr, "");

    const invalidCapture = await capture(["json", "validate", "--schema", schema, "--file", invalid, "--json"]);
    assert.equal(invalidCapture.code, 1);
    const envelope = JSON.parse(invalidCapture.stdout) as {
      schema_version: string;
      command: string;
      ok: boolean;
      data: { status: string };
    };
    assert.equal(envelope.schema_version, "ultrafuzz.cli.result.v1");
    assert.equal(envelope.command, "json validate");
    assert.equal(envelope.ok, false);
    assert.equal(envelope.data.status, "instance-error");
    assert.equal(invalidCapture.stderr, "");

    const setupCapture = await capture([
      "json",
      "validate",
      "--schema",
      path.join(temporary, "missing-schema.json"),
      "--file",
      valid
    ]);
    assert.equal(setupCapture.code, 2);
    assert.match(setupCapture.stderr, /JSON_SCHEMA_UNREADABLE/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: process.cwd(),
    env: process.env,
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { code, stdout, stderr };
}
