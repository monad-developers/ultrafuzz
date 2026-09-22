import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CLI_KNOWN_COMMANDS } from "../src/cli-contracts.js";
import { validateCliResultEnvelope } from "../src/cli-schema-registry.js";
import { runCli } from "../src/index.js";

interface ResultEnvelope {
  ok: boolean;
  command: string;
  data: { provider?: string } | null;
  diagnostics: Array<{ code: string; message: string }>;
}

const SUITE = `
schema_version: ultrafuzz.eval.v2
suite: offline-provider-policy
model_profiles:
  runner: { agent: CodexAgent, model: offline-test-model }
targets:
  - id: target
    repo: https://example.invalid/target
    ref: main
    ground_truth: target.yml
variants:
  - id: baseline
run:
  runner_model_profile: runner
  judge_model_profile: runner
  trials_per_variant: 1
metrics:
  recall_threshold: 0.7
reporting:
  node_telemetry: false
`;

test("eval plan and run reject retired CLI providers before loading configuration or credentials", async (t) => {
  const project = temporaryProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, "ultrafuzz.toml"), "invalid TOML [");
  for (const command of ["plan", "run"]) {
    const result = await invoke(project, ["eval", command, "--provider", "braintrust"]);
    assert.notEqual(result.code, 0);
    assert.equal(result.envelope.ok, false);
    assert.equal(result.envelope.diagnostics[0]?.code, "CLI_OCLIF_ERROR");
    assert.match(result.envelope.diagnostics[0]?.message ?? "", /none/u);
  }
});

test("eval plan and run reject retired project and environment selections before planning or launching", async (t) => {
  const project = temporaryProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  for (const source of ["project", "environment"]) {
    fs.writeFileSync(
      path.join(project, "ultrafuzz.toml"),
      `[eval]\nprovider = "${source === "project" ? "braintrust" : "none"}"\n`
    );
    for (const command of ["plan", "run"]) {
      const result = await invoke(
        project,
        ["eval", command, "--suite", "missing-suite.yml"],
        source === "environment" ? { ULTRAFUZZ_EVAL_PROVIDER: "braintrust" } : {}
      );
      assert.equal(result.code, 1);
      assert.equal(result.envelope.ok, false);
      assert.match(result.envelope.diagnostics[0]?.message ?? "", /unsupported eval provider `braintrust`/u);
      assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "evals", "runs")), false);
    }
  }
});

test("an explicit none override preserves offline planning with historical provider metadata", async (t) => {
  const base = temporaryProject();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  const groundTruth = path.join(base, "ground-truth");
  fs.mkdirSync(project);
  fs.mkdirSync(groundTruth);
  fs.writeFileSync(path.join(project, "suite.yml"), SUITE);
  fs.writeFileSync(
    path.join(project, "ultrafuzz.toml"),
    '[eval]\nprovider = "braintrust"\n[eval.providers.braintrust]\napi_key_env = "BRAINTRUST_API_KEY"\n'
  );
  const result = await invoke(
    project,
    [
      "eval",
      "plan",
      "--provider",
      "none",
      "--suite",
      "suite.yml",
      "--ground-truth-root",
      groundTruth,
      "--skip-target-validation"
    ],
    { ULTRAFUZZ_EVAL_PROVIDER: "braintrust" }
  );
  assert.equal(result.code, 0, JSON.stringify(result.envelope.diagnostics));
  assert.equal(result.envelope.ok, true);
  assert.equal(result.envelope.data?.provider, "none");
  assert.equal(validateCliResultEnvelope(result.envelope).ok, true);
  assert.equal(
    validateCliResultEnvelope({ ...result.envelope, data: { ...result.envelope.data, provider: "braintrust" } }).ok,
    false
  );
});

test("eval publish is no longer an executable command while local eval history remains registered", async (t) => {
  const project = temporaryProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  assert.equal(
    CLI_KNOWN_COMMANDS.some((command: string) => command === "eval publish"),
    false
  );
  assert.equal(CLI_KNOWN_COMMANDS.includes("eval history"), true);
  const result = await invoke(project, ["eval", "publish", "old-run"]);
  assert.notEqual(result.code, 0);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.diagnostics[0]?.code, "CLI_OCLIF_ERROR");
});

function temporaryProject(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-cli-retired-provider-"));
}

async function invoke(
  project: string,
  argv: string[],
  overrides: Record<string, string | undefined> = {}
): Promise<{ code: number; envelope: ResultEnvelope }> {
  let stdout = "";
  let stderr = "";
  const env = { ...overrides };
  Object.defineProperty(env, "BRAINTRUST_API_KEY", {
    get() {
      throw new Error("Retired provider credentials must not be read");
    }
  });
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    return Promise.reject(new Error("Network access is forbidden in the offline provider test"));
  };
  try {
    const code = await runCli([...argv, "--project", project, "--json"], {
      cwd: project,
      env,
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
    assert.equal(requests, 0);
    assert.equal(stderr, "");
    return { code, envelope: JSON.parse(stdout) as ResultEnvelope };
  } finally {
    globalThis.fetch = previousFetch;
  }
}
