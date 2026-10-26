import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryRoot } from "./temporary-root.js";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

test("internal hook CLI reserves, coalesces, polls and completes without a public envelope", (t) => {
  const root = temporaryRoot("ufz-command-hook-cli-", t);
  const env = {
    ...process.env,
    ULTRAFUZZ_COMMAND_INVOCATIONS: path.join(root, "registry"),
    ULTRAFUZZ_COMMAND_INVOCATION_OWNER: "fixture:2147483647:0",
    ULTRAFUZZ_COMMAND_INVOCATION_ENGINE: "codex"
  };
  const invoke = (args: string[], input = "") => {
    const result = spawnSync(process.execPath, [cli, "command-hook", ...args], {
      cwd: root,
      env,
      input,
      encoding: "utf8",
      timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const event = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd: root,
    session_id: "session",
    tool_use_id: "original",
    tool_input: { command: "verification --all" }
  };
  const first = invoke([], JSON.stringify(event));
  assert.match(String(first.systemMessage), /reserved/u);
  assert.equal(first.schema_version, undefined);
  const id = /"invocation_id":"([a-f0-9]{64}-\d+)"/u.exec(String(first.systemMessage))?.[1];
  assert.ok(id);
  const duplicate = invoke([], JSON.stringify({ ...event, tool_use_id: "duplicate" }));
  assert.equal((duplicate.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
  assert.equal(invoke(["--status", id]).status, "completion_unknown");
  invoke([], JSON.stringify({ ...event, hook_event_name: "PostToolUse", tool_response: "exit code 0" }));
  assert.equal(invoke(["--status", id]).status, "completed");
  assert.match(String(invoke([], "not json").systemMessage), /guard inactive/u);
  assert.match(String(invoke(["--status", "../../outside"]).systemMessage), /guard inactive/u);
  assert.match(String(invoke([], " ".repeat(1024 * 1024 + 1)).systemMessage), /guard inactive/u);
});
