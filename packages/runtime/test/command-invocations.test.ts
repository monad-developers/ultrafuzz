import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  commandInvocationHook,
  commandInvocationStatus,
  configureCommandInvocationGuard
} from "../src/command-invocations.js";
import { temporaryRoot } from "./temporary-root.js";

const moduleUrl = new URL("../src/command-invocations.js", import.meta.url).href;

function fixture() {
  const root = temporaryRoot("ufz-command-invocations-");
  const registry = path.join(root, "registry");
  const env = {
    ...process.env,
    ULTRAFUZZ_COMMAND_INVOCATIONS: registry,
    ULTRAFUZZ_COMMAND_INVOCATION_ENGINE: "codex",
    // A dead identity exercises conservative orphan handling too. Admission
    // never depends on a lease or assumes that an owner's children died.
    ULTRAFUZZ_COMMAND_INVOCATION_OWNER: "fixture:2147483647:0"
  };
  const event = (toolUseId: string, command = "verification --all") => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    session_id: "session-1",
    tool_use_id: toolUseId,
    cwd: root,
    tool_input: { command }
  });
  return { root, registry, env, event };
}

function denied(result: Record<string, unknown>): boolean {
  return (result.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision === "deny";
}

function handle(result: Record<string, unknown>): string {
  const id = /"invocation_id":"([a-f0-9]{64}-\d+)"/u.exec(String(result.systemMessage))?.[1];
  assert.ok(id);
  return id;
}

function defined<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

function registry(command: { env?: Record<string, string> }): string {
  return defined(command.env?.ULTRAFUZZ_COMMAND_INVOCATIONS);
}

test(
  "long verification, independent poll and duplicate launch perform work only once",
  { timeout: 15_000 },
  async () => {
    const f = fixture();
    const worker = path.join(f.root, "worker.mjs");
    const counter = path.join(f.root, "work-count");
    const release = path.join(f.root, "release");
    fs.writeFileSync(
      worker,
      `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    import { commandInvocationHook } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(process.argv[2]);
    const result = commandInvocationHook(input);
    console.log(JSON.stringify(result));
    if (result.hookSpecificOutput?.permissionDecision !== 'deny') {
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(`
        const fs = require('node:fs');
        fs.appendFileSync(${JSON.stringify(counter)}, 'work\\n');
        const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 20);
      `)}], { stdio: 'inherit' });
      await new Promise(resolve => child.once('exit', resolve));
      console.log(JSON.stringify(commandInvocationHook({ ...input, hook_event_name: 'PostToolUse', tool_response: 'exit code 0' })));
    }
  `
    );
    const first = spawn(process.execPath, [worker, JSON.stringify(f.event("first"))], {
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const firstExit = once(first, "exit");
    try {
      const [data] = await once(first.stdout, "data");
      const result = JSON.parse(String(data).trim()) as Record<string, unknown>;
      const id = handle(result);
      const poll = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { commandInvocationStatus } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(commandInvocationStatus(process.env.ULTRAFUZZ_COMMAND_INVOCATIONS, ${JSON.stringify(id)})));
    `
        ],
        { env: f.env, encoding: "utf8" }
      );
      assert.equal(poll.status, 0, poll.stderr);
      assert.equal(JSON.parse(poll.stdout).invocation_id, id);
      assert.equal(JSON.parse(poll.stdout).status, "completion_unknown");
      const duplicate = spawnSync(process.execPath, [worker, JSON.stringify(f.event("duplicate"))], {
        env: f.env,
        encoding: "utf8",
        timeout: 3_000
      });
      assert.equal(duplicate.status, 0, duplicate.stderr);
      assert.equal(denied(JSON.parse(duplicate.stdout)), true);
      assert.equal(handle(JSON.parse(duplicate.stdout)), id);
      assert.match(duplicate.stdout, /coalesced/u);
      fs.writeFileSync(release, "done");
      assert.equal((await firstExit)[0], 0);
      assert.equal(fs.readFileSync(counter, "utf8"), "work\n");
      assert.equal(commandInvocationStatus(f.registry, id).status, "completed");
      const completedReplay = commandInvocationHook(f.event("first"), f.env);
      assert.equal(denied(completedReplay), true);
      assert.equal(handle(completedReplay), id);
      assert.match(String(completedReplay.systemMessage), /completed/u);
      const again = commandInvocationHook(f.event("after-completion"), f.env);
      assert.equal(denied(again), false);
      assert.notEqual(handle(again), id);
      // A duplicate terminal event for the first call cannot release its successor.
      commandInvocationHook({ ...f.event("first"), hook_event_name: "PostToolUse" }, f.env);
      assert.equal(denied(commandInvocationHook(f.event("fourth"), f.env)), true);
    } finally {
      fs.writeFileSync(release, "done");
      await firstExit;
    }
  }
);

test("racing independent prelaunch hooks admit exactly one invocation", { timeout: 15_000 }, async () => {
  const f = fixture();
  const results = await Promise.all(
    Array.from(
      { length: 12 },
      (_, index) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
      import { commandInvocationHook } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(commandInvocationHook(${JSON.stringify(f.event(`call-${index}`))})));
    `
            ],
            { env: f.env }
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
          });
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code === 0) resolve(JSON.parse(stdout));
            else reject(new Error(stderr));
          });
        })
    )
  );
  assert.equal(results.filter((result) => !denied(result)).length, 1);
  assert.equal(new Set(results.map(handle)).size, 1);
});

test("rewritten terminal hooks durably find their original reservation and preserve replay protection", () => {
  const f = fixture();
  const original = commandInvocationHook(f.event("original"), f.env);
  const otherCommand = "verification --other";
  const other = commandInvocationHook(f.event("other", otherCommand), f.env);
  const terminal = {
    ...f.event("original", otherCommand),
    cwd: path.join(f.root, "rewritten-cwd"),
    hook_event_name: "PostToolUse"
  };
  // No in-memory state from admission is available in this independent hook process.
  const post = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { commandInvocationHook } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(commandInvocationHook(${JSON.stringify(terminal)})));
  `
    ],
    { env: f.env, encoding: "utf8" }
  );
  assert.equal(post.status, 0, post.stderr);
  assert.equal(handle(JSON.parse(post.stdout)), handle(original));
  assert.equal(commandInvocationStatus(f.registry, handle(original)).status, "completed");
  assert.equal(commandInvocationStatus(f.registry, handle(other)).status, "completion_unknown");
  const later = commandInvocationHook(f.event("later"), f.env);
  assert.equal(denied(later), false);
  assert.notEqual(handle(later), handle(original));
  const replay = commandInvocationHook(f.event("original"), f.env);
  assert.equal(denied(replay), true);
  assert.equal(handle(replay), handle(original));
  commandInvocationHook(terminal, f.env);
  assert.equal(commandInvocationStatus(f.registry, handle(later)).status, "completion_unknown");
  assert.equal(denied(commandInvocationHook(f.event("duplicate"), f.env)), true);
});

test("completion correlation is session-scoped and ambiguous native identities cannot release reservations", () => {
  const f = fixture();
  const first = commandInvocationHook(f.event("same-call"), f.env);
  const otherEvent = { ...f.event("same-call", "other-command"), session_id: "session-2" };
  const other = commandInvocationHook(otherEvent, f.env);
  commandInvocationHook({ ...otherEvent, session_id: "unknown-session", hook_event_name: "PostToolUse" }, f.env);
  assert.equal(commandInvocationStatus(f.registry, handle(first)).status, "completion_unknown");
  assert.equal(commandInvocationStatus(f.registry, handle(other)).status, "completion_unknown");
  commandInvocationHook({ ...f.event("same-call", "rewritten-command"), hook_event_name: "PostToolUse" }, f.env);
  assert.equal(commandInvocationStatus(f.registry, handle(first)).status, "completed");
  assert.equal(commandInvocationStatus(f.registry, handle(other)).status, "completion_unknown");
  // Reusing a native identity for a different command is ambiguous, not
  // permission to use an old completion to release the newer reservation.
  const conflicting = commandInvocationHook(f.event("same-call", "conflicting-command"), f.env);
  assert.throws(
    () => commandInvocationHook({ ...f.event("same-call"), hook_event_name: "PostToolUse" }, f.env),
    /ambiguous/u
  );
  assert.equal(commandInvocationStatus(f.registry, handle(conflicting)).status, "completion_unknown");
  assert.equal(denied(commandInvocationHook(f.event("duplicate-conflict", "conflicting-command"), f.env)), true);
});

test("completion lookup ignores torn, corrupt, symlinked and mismatched reservations", () => {
  const f = fixture();
  const original = commandInvocationHook(f.event("original"), f.env);
  const originalHandle = handle(original);
  const originalRecord = JSON.parse(fs.readFileSync(path.join(f.registry, `${originalHandle}.json`), "utf8"));
  for (const [index, contents] of [
    "",
    "{",
    JSON.stringify({ ...originalRecord, invocation_id: "wrong-handle" })
  ].entries()) {
    fs.writeFileSync(path.join(f.registry, `${String(index).repeat(64)}-0.json`), contents);
  }
  fs.symlinkSync(path.join(f.registry, `${originalHandle}.json`), path.join(f.registry, `${"f".repeat(64)}-0.json`));
  // A matching command with the wrong native identity must not mark it done.
  commandInvocationHook({ ...f.event("never-admitted"), hook_event_name: "PostToolUse" }, f.env);
  assert.equal(commandInvocationStatus(f.registry, originalHandle).status, "completion_unknown");
  commandInvocationHook({ ...f.event("original", "rewritten-command"), hook_event_name: "PostToolUse" }, f.env);
  assert.equal(commandInvocationStatus(f.registry, originalHandle).status, "completed");
  for (const prefix of ["0", "1", "2", "f"]) {
    const id = `${prefix.repeat(64)}-0`;
    assert.equal(commandInvocationStatus(f.registry, id).status, "completion_unknown");
    assert.equal(fs.existsSync(path.join(f.registry, `${id}.completed.json`)), false);
  }
});

test("distinct keys, directories and attempts remain concurrent; shell text is not normalized", () => {
  const f = fixture();
  const first = commandInvocationHook(f.event("first"), f.env);
  for (const command of [
    "# ultrafuzz-command-key: independent\nverification --all",
    "verification --other",
    "verification  --all"
  ]) {
    assert.equal(denied(commandInvocationHook(f.event("distinct", command), f.env)), false);
  }
  assert.equal(
    denied(commandInvocationHook({ ...f.event("other-cwd"), cwd: path.join(f.root, "other") }, f.env)),
    false
  );
  assert.equal(
    denied(
      commandInvocationHook(f.event("other-attempt"), {
        ...f.env,
        ULTRAFUZZ_COMMAND_INVOCATIONS: path.join(f.root, "attempt-2")
      })
    ),
    false
  );
  assert.equal(denied(commandInvocationHook(f.event("duplicate"), f.env)), true);
  assert.equal(commandInvocationStatus(f.registry, handle(first)).status, "completion_unknown");
});

test("old, torn, orphaned or PID-reused reservations cannot expire into duplicate work", () => {
  const f = fixture();
  const first = commandInvocationHook(f.event("first"), f.env);
  const id = handle(first);
  const file = path.join(f.registry, `${id}.json`);
  const entry = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...entry, started_at: "2000-01-01T00:00:00.000Z", owner: `wrong-boot:${process.pid}:0` })
  );
  assert.equal(denied(commandInvocationHook(f.event("later"), f.env)), true);
  fs.writeFileSync(file, "");
  assert.equal(denied(commandInvocationHook(f.event("torn"), f.env)), true);
  commandInvocationHook({ ...f.event("first", "rewritten-command"), hook_event_name: "PostToolUse" }, f.env);
  assert.equal(fs.existsSync(path.join(f.registry, `${id}.completed.json`)), false);
  assert.equal(commandInvocationStatus(f.registry, id).status, "completion_unknown");
  assert.equal(
    denied(commandInvocationHook(f.event("explicit", "# ultrafuzz-command-key: restart\nverification --all"), f.env)),
    false
  );
});

test(
  "a controller crash does not admit another command while its orphaned worker is live",
  { timeout: 15_000 },
  async () => {
    const f = fixture();
    const started = path.join(f.root, "started");
    const release = path.join(f.root, "release");
    const finished = path.join(f.root, "finished");
    const childProgram = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, 'working');
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(release)})) {
        clearInterval(timer);
        fs.writeFileSync(${JSON.stringify(finished)}, 'done');
      }
    }, 20);
  `;
    const controller = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    import { commandInvocationHook } from ${JSON.stringify(moduleUrl)};
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    process.env.ULTRAFUZZ_COMMAND_INVOCATION_OWNER = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + process.pid + ':' + start;
    const result = commandInvocationHook(${JSON.stringify(f.event("crashed"))});
    const worker = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { detached: true, stdio: 'ignore' });
    worker.unref();
    console.log(JSON.stringify({ result, pid: worker.pid }));
    process.exit(1);
  `
      ],
      { env: f.env, encoding: "utf8", timeout: 5_000 }
    );
    assert.equal(controller.status, 1, controller.stderr);
    const { result, pid } = JSON.parse(controller.stdout) as { result: Record<string, unknown>; pid: number };
    const waitFor = async (file: string) => {
      const deadline = Date.now() + 3_000;
      while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(file), true, file);
    };
    try {
      await waitFor(started);
      assert.doesNotThrow(() => process.kill(pid, 0));
      const duplicate = commandInvocationHook(f.event("after-crash"), f.env);
      assert.equal(denied(duplicate), true);
      assert.equal(handle(duplicate), handle(result));
      assert.equal(commandInvocationStatus(f.registry, handle(result)).status, "completion_unknown");
    } finally {
      fs.writeFileSync(release, "stop");
      try {
        await waitFor(finished);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Worker already exited. */
        }
      }
    }
  }
);

test("unqualified hook contracts fail open with explicit diagnostics", () => {
  const f = fixture();
  for (const engine of ["claude", "kimi", "unknown"]) {
    const result = commandInvocationHook(f.event("first"), { ...f.env, ULTRAFUZZ_COMMAND_INVOCATION_ENGINE: engine });
    assert.equal(denied(result), false);
    assert.match(String(result.systemMessage), /unsupported hook provider.*inactive/u);
  }
  assert.equal(fs.existsSync(f.registry), false);
});

test("registry rejects symlinks and unsafe status handles", () => {
  const f = fixture();
  fs.symlinkSync(f.root, f.registry);
  assert.throws(() => commandInvocationHook(f.event("first"), f.env), /unsafe/u);
  assert.throws(() => commandInvocationStatus(f.root, "../../outside"), /invalid/u);
});

test("unsupported providers are explicit and keep their original command", () => {
  const command = { command: "kimi", args: ["--print"], env: {} };
  const diagnostics: string[] = [];
  assert.equal(
    configureCommandInvocationGuard({
      engine: "kimi",
      command,
      cwd: temporaryRoot("ufz-command-unsupported-"),
      taskContext: { runId: "run", nodeId: "node", iteration: 0, attempt: 1 },
      diagnostic: (message) => diagnostics.push(message)
    }),
    command
  );
  assert.match(diagnostics.join("\n"), /unsupported provider kimi.*guard inactive/u);
});

test("configuration qualifies the provider, preserves flags and isolates attempt identities", (t) => {
  const root = temporaryRoot("ufz-command-qualification-");
  const binary = path.join(root, "codex");
  fs.writeFileSync(binary, `#!/usr/bin/env node\nconsole.log('codex-cli ' + process.env.FIXTURE_CODEX_VERSION);`, {
    mode: 0o700
  });
  const savedBin = process.env.ULTRAFUZZ_TRUSTED_BIN;
  process.env.ULTRAFUZZ_TRUSTED_BIN = path.join(root, "trusted bin");
  t.after(() => {
    if (savedBin === undefined) delete process.env.ULTRAFUZZ_TRUSTED_BIN;
    else process.env.ULTRAFUZZ_TRUSTED_BIN = savedBin;
  });
  const taskContext = { runId: "run", nodeId: "node", iteration: 0, attempt: 1 };
  const command: Parameters<typeof configureCommandInvocationGuard>[0]["command"] = {
    command: binary,
    args: ["exec", "-c", 'model="fixture"', "-"],
    env: { FIXTURE_CODEX_VERSION: "0.146.0" }
  };
  const messages: string[] = [];
  const configure = (overrides: Partial<Parameters<typeof configureCommandInvocationGuard>[0]> = {}) =>
    configureCommandInvocationGuard({
      engine: "codex",
      cwd: root,
      command,
      taskContext,
      diagnostic: (message) => messages.push(message),
      ...overrides
    });
  const configured = configure();
  const registryRoot = registry(configured);
  assert.equal(command.args.length, 4, "configuration does not mutate the original command");
  assert.equal(configured.args[0], "exec");
  assert.deepEqual(configured.args.slice(-3), command.args.slice(-3));
  assert.match(configured.args.join(" "), /hooks\.state=.*trusted_hash/u);
  assert.equal(configured.args.includes("--dangerously-bypass-hook-trust"), false);
  assert.equal(registry(configure()), registryRoot);
  for (const distinct of [{ runId: "run-2" }, { nodeId: "node-2" }, { iteration: 1 }, { attempt: 2 }]) {
    assert.notEqual(registry(configure({ taskContext: { ...taskContext, ...distinct } })), registryRoot);
  }
  const resume = configure({ command: { ...command, args: ["exec", "resume", "--json", "session", "-"] } });
  assert.deepEqual(resume.args.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(resume.args.slice(-3), ["--json", "session", "-"]);
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    session_id: "session",
    tool_use_id: "call",
    cwd: root,
    tool_input: { command: "verification" }
  };
  const reserved = commandInvocationHook(input, configured.env);
  assert.equal(commandInvocationStatus(registryRoot, handle(reserved)).status, "active");
  assert.equal(configure({ taskContext: undefined }), command);
  assert.match(defined(messages.at(-1)), /task attempt context.*inactive/u);
  const newer = { ...command, env: { FIXTURE_CODEX_VERSION: "0.147.0" } };
  assert.equal(configure({ command: newer }), newer);
  assert.match(defined(messages.at(-1)), /unqualified codex version.*inactive/u);
  assert.equal(configure({ engine: "claude" }), command);
  assert.match(defined(messages.at(-1)), /Claude background completion.*inactive/u);
  for (const flag of [
    "hooks.PreToolUse=[]",
    "hooks={}",
    "--config=hooks.state={}",
    "features.hooks=false",
    "-c=features.hooks=false",
    "-c=hooks.PostToolUse=[]",
    "-cfeatures.hooks=false",
    "-chooks.PostToolUse=[]",
    "-chooks={}",
    "--disable=hooks"
  ]) {
    const custom = { ...command, args: ["exec", ...(flag.startsWith("-") ? [flag] : ["-c", flag]), "-"] };
    assert.equal(configure({ command: custom }), custom);
    assert.match(defined(messages.at(-1)), /caller already supplies.*inactive/u);
  }
});

// Shared by the optional real-CLI qualification below; no provider credentials
// or network outside the local deterministic Responses endpoint are used.
function commandHookFixtureCli(root: string): string {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "ultrafuzz"),
    `#!/usr/bin/env node\n
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    fs.appendFileSync(${JSON.stringify(path.join(root, "hook-inputs"))}, text + '\\n');
    const result = spawnSync(process.execPath, [${JSON.stringify(fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url)))}, ...process.argv.slice(2)], { input: text, encoding: 'utf8', env: process.env });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    process.exit(result.status ?? 1);
  `,
    { mode: 0o700 }
  );
  return bin;
}

function fixtureCodexHookSettings(root: string, codexHome: string, marker: string, rewrite: boolean): void {
  const groups: unknown[] = [{ matcher: "Bash", hooks: [{ type: "command", command: `touch ${marker}` }] }];
  if (rewrite) {
    const script = path.join(root, "rewrite.mjs");
    fs.writeFileSync(
      script,
      `
      let text = ''; for await (const chunk of process.stdin) text += chunk;
      const input = JSON.parse(text);
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: input.tool_input.command + ' # rewritten-by-trusted-hook' } } }));
    `
    );
    // Canonically ordered hash input for Codex 0.146.0's exact hook trust contract.
    const hooks = [
      {
        async: false,
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        timeout: 10,
        type: "command"
      }
    ];
    const matcher = "^Bash$";
    const trustedHash = `sha256:${createHash("sha256")
      .update(JSON.stringify({ event_name: "pre_tool_use", hooks, matcher }))
      .digest("hex")}`;
    groups.push({ matcher, hooks });
    const key = `${path.join(codexHome, "hooks.json")}:pre_tool_use:1:0`;
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash=${JSON.stringify(trustedHash)}\n`
    );
  }
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: groups } }));
}

function scriptedResponsesServer(verification: string, mode: "replay" | "failed" | "stopped" = "replay") {
  const state = {
    results: [] as string[],
    outputs: new Map<string, string>(),
    requestCount: 0,
    generation: 0,
    nativeSession: undefined as number | undefined,
    error: undefined as Error | undefined
  };
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (!request.url?.endsWith("/responses")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[]}');
        return;
      }
      const input = JSON.parse(body).input as Array<{ type?: string; output?: unknown; call_id?: string }>;
      for (const item of input ?? []) {
        if (item.type === "function_call_output") {
          const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
          state.results.push(output);
          if (item.call_id !== undefined) state.outputs.set(item.call_id, output);
          if (item.call_id === `g${state.generation}-original`)
            state.nativeSession = Number(/session ID (\d+)/u.exec(output)?.[1]);
        }
      }
      state.requestCount += 1;
      const { requestCount, generation, nativeSession, results } = state;
      let item: Record<string, unknown>;
      if (requestCount <= 2) {
        item = {
          type: "function_call",
          id: `g${generation}-fc-${requestCount}`,
          call_id: `g${generation}-${requestCount === 1 ? "original" : "duplicate"}`,
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: verification,
            yield_time_ms: 250,
            login: false,
            ...(mode === "stopped" ? { tty: true } : {})
          })
        };
      } else if (requestCount === 3) {
        assert.ok(Number.isSafeInteger(nativeSession), JSON.stringify(results));
        item = {
          type: "function_call",
          id: `g${generation}-fc-poll`,
          call_id: `g${generation}-poll`,
          name: "write_stdin",
          arguments: JSON.stringify({
            session_id: nativeSession,
            chars: mode === "stopped" ? "\u0003" : "",
            yield_time_ms: 10000
          })
        };
      } else if (requestCount === 4) {
        item = {
          type: "function_call",
          id: `g${generation}-fc-replay`,
          call_id: `g${generation}-${mode === "replay" ? "original" : "next"}`,
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: verification,
            yield_time_ms: 250,
            login: false,
            ...(mode === "stopped" ? { tty: true } : {})
          })
        };
      } else {
        item = {
          type: "message",
          id: `g${generation}-msg-final`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "verification observed", annotations: [] }]
        };
      }
      const events = [
        { type: "response.created", response: { id: `resp-${requestCount}` } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `resp-${requestCount}`,
            object: "response",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
          }
        }
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `${events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}`).join("\n\n")}\n\n`
      );
    } catch (error) {
      state.error = error instanceof Error ? error : new Error(String(error));
      response.writeHead(500);
      response.end("fixture failed");
    }
  });
  return { state, server };
}

for (const rewrite of [false, true])
  test(
    `qualified real Codex CLI coalesces live and completed replays${rewrite ? " with a trusted rewriting hook" : ""}`,
    {
      timeout: 45_000,
      skip: !process.env.ULTRAFUZZ_TEST_CODEX
    },
    async () => {
      const root = temporaryRoot("ufz-real-command-hooks-");
      const bin = commandHookFixtureCli(root);
      const counter = path.join(root, "work-count");
      const marker = path.join(root, "untrusted-hook-ran");
      const codexHome = path.join(root, "codex-home");
      fs.mkdirSync(codexHome);
      fixtureCodexHookSettings(root, codexHome, marker, rewrite);
      const verification = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'work\\n'); setTimeout(() => console.log('verification-complete'), 6000);`)}`;
      const { server, state } = scriptedResponsesServer(verification);
      const { results } = state;
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      const savedBin = process.env.ULTRAFUZZ_TRUSTED_BIN;
      process.env.ULTRAFUZZ_TRUSTED_BIN = bin;
      const diagnostics: string[] = [];
      try {
        const command = configureCommandInvocationGuard({
          engine: "codex",
          cwd: root,
          command: {
            command: defined(process.env.ULTRAFUZZ_TEST_CODEX),
            args: [
              "exec",
              "--skip-git-repo-check",
              "--json",
              "--enable",
              "unified_exec",
              "--dangerously-bypass-approvals-and-sandbox",
              "-c",
              'model="gpt-5.5"',
              "-c",
              'model_provider="fixture"',
              "-c",
              `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${address.port}/v1",env_key="ULTRAFUZZ_FIXTURE_API_KEY",wire_api="responses"}`,
              "run verification"
            ],
            env: {
              CODEX_HOME: codexHome,
              ULTRAFUZZ_FIXTURE_API_KEY: "fixture-only",
              OPENAI_API_KEY: "",
              CODEX_API_KEY: ""
            }
          },
          taskContext: { runId: "run", nodeId: "node", attempt: 1, iteration: 0 },
          diagnostic: (message) => diagnostics.push(message)
        });
        assert.match(diagnostics.join("\n"), /enabled/u);
        assert.equal(command.args.includes("--dangerously-bypass-hook-trust"), false);
        let providerSession: string | undefined;
        for (let generation = 0; generation < 2; generation += 1) {
          Object.assign(state, { generation, requestCount: 0, nativeSession: undefined });
          results.length = 0;
          state.outputs.clear();
          const args =
            generation === 0
              ? command.args
              : ["exec", "resume", ...command.args.slice(1, -1), defined(providerSession), "run verification"];
          const child = spawn(command.command, args, {
            cwd: root,
            env: { ...process.env, ...command.env },
            stdio: ["ignore", "pipe", "pipe"],
            detached: true
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
          });
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          const stop = () => {
            try {
              if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already exited. */
            }
          };
          const timer = setTimeout(stop, 35_000);
          try {
            const [code] = await once(child, "exit");
            assert.equal(state.error, undefined);
            assert.equal(code, 0, `${stderr}\n${stdout}\n${JSON.stringify(results)}`);
            providerSession = /"thread_id":"([^"]+)"/u.exec(stdout)?.[1];
            assert.ok(providerSession);
            assert.match(
              results.join("\n"),
              /coalesced/u,
              `${stderr}\n${stdout}\nhook-inputs: ${fs.existsSync(path.join(root, "hook-inputs")) ? fs.readFileSync(path.join(root, "hook-inputs"), "utf8") : "missing"}`
            );
            assert.match(results.join("\n"), /verification-complete/u);
            assert.match(defined(state.outputs.get(`g${generation}-original`)), /coalesced.*completed/u);
            assert.equal(fs.readFileSync(counter, "utf8"), "work\n".repeat(generation + 1));
            assert.equal(fs.existsSync(marker), false, "trusting the guard must not enable other untrusted hooks");
            const registryRoot = registry(command);
            const handles = fs.readdirSync(registryRoot).filter((file) => /^[a-f0-9]{64}-\d+\.json$/u.test(file));
            assert.equal(handles.length, generation + 1);
            for (const file of handles)
              assert.equal(commandInvocationStatus(registryRoot, file.slice(0, -5)).status, "completed");
            if (rewrite) {
              const inputs = fs
                .readFileSync(path.join(root, "hook-inputs"), "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as { hook_event_name: string; tool_input: { command: string } });
              const postInputs = inputs.filter((input) => input.hook_event_name === "PostToolUse");
              assert.equal(postInputs.length, generation + 1);
              assert.ok(
                postInputs.every((input) => input.tool_input.command === `${verification} # rewritten-by-trusted-hook`)
              );
            }
          } finally {
            clearTimeout(timer);
            stop();
          }
        }
      } finally {
        if (savedBin === undefined) delete process.env.ULTRAFUZZ_TRUSTED_BIN;
        else process.env.ULTRAFUZZ_TRUSTED_BIN = savedBin;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

for (const mode of ["failed", "stopped"] as const)
  test(
    `qualified real Codex CLI writes a completion receipt after a ${mode} command`,
    { timeout: 45_000, skip: !process.env.ULTRAFUZZ_TEST_CODEX },
    async () => {
      const root = temporaryRoot("ufz-real-command-terminal-");
      const bin = commandHookFixtureCli(root);
      const counter = path.join(root, "work-count");
      const marker = path.join(root, "untrusted-hook-ran");
      const codexHome = path.join(root, "codex-home");
      fs.mkdirSync(codexHome);
      fixtureCodexHookSettings(root, codexHome, marker, false);
      const worker = `
        const fs = require('node:fs');
        const first = !fs.existsSync(${JSON.stringify(counter)});
        fs.appendFileSync(${JSON.stringify(counter)}, 'work\\n');
        if (first) {
          ${mode === "failed" ? "setTimeout(() => process.exit(7), 6000);" : "setInterval(() => {}, 1000); setTimeout(() => process.exit(124), 30000);"}
        } else {
          console.log('next-completed');
        }
      `;
      const verification = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(worker.replace(/\s+/gu, " ").trim())}`;
      const { server, state } = scriptedResponsesServer(verification, mode);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      const savedBin = process.env.ULTRAFUZZ_TRUSTED_BIN;
      process.env.ULTRAFUZZ_TRUSTED_BIN = bin;
      try {
        const command = configureCommandInvocationGuard({
          engine: "codex",
          cwd: root,
          command: {
            command: defined(process.env.ULTRAFUZZ_TEST_CODEX),
            args: [
              "exec",
              "--skip-git-repo-check",
              "--json",
              "--enable",
              "unified_exec",
              "--dangerously-bypass-approvals-and-sandbox",
              "-c",
              'model="gpt-5.5"',
              "-c",
              'model_provider="fixture"',
              "-c",
              `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${address.port}/v1",env_key="ULTRAFUZZ_FIXTURE_API_KEY",wire_api="responses"}`,
              "run verification"
            ],
            env: {
              CODEX_HOME: codexHome,
              ULTRAFUZZ_FIXTURE_API_KEY: "fixture-only",
              OPENAI_API_KEY: "",
              CODEX_API_KEY: ""
            }
          },
          taskContext: { runId: "run", nodeId: "node", attempt: 1, iteration: 0 },
          diagnostic: (message) => assert.match(message, /enabled/u)
        });
        const startedAt = Date.now();
        const child = spawn(command.command, command.args, {
          cwd: root,
          env: { ...process.env, ...command.env },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        const stop = () => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        };
        const timer = setTimeout(stop, 35_000);
        try {
          const [code] = await once(child, "exit");
          assert.equal(state.error, undefined);
          assert.equal(code, 0, `${stderr}\n${stdout}\n${JSON.stringify(state.results)}`);
          assert.match(state.results.join("\n"), /coalesced/u);
          const terminal = defined(state.outputs.get("g0-poll"));
          if (mode === "failed") assert.match(terminal, /Process exited with code 7/u);
          else {
            assert.match(terminal, /Process exited with code/u);
            assert.ok(Date.now() - startedAt < 20_000, "native session stop must finish before the worker fallback");
          }
          assert.match(defined(state.outputs.get("g0-next")), /next-completed/u);
          assert.equal(fs.readFileSync(counter, "utf8"), "work\nwork\n");
          assert.equal(fs.existsSync(marker), false);
          const registryRoot = registry(command);
          const handles = fs.readdirSync(registryRoot).filter((file) => /^[a-f0-9]{64}-\d+\.json$/u.test(file));
          assert.equal(handles.length, 2);
          for (const file of handles)
            assert.equal(commandInvocationStatus(registryRoot, file.slice(0, -5)).status, "completed");
          const hookInputs = fs
            .readFileSync(path.join(root, "hook-inputs"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { hook_event_name: string });
          assert.equal(hookInputs.filter((input) => input.hook_event_name === "PostToolUse").length, 2);
        } finally {
          clearTimeout(timer);
          stop();
        }
      } finally {
        if (savedBin === undefined) delete process.env.ULTRAFUZZ_TRUSTED_BIN;
        else process.env.ULTRAFUZZ_TRUSTED_BIN = savedBin;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
