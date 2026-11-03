import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { c as createTar } from "tar";
import { deadlines, nonemptyReport, removeProjectCustomizations, runWorker } from "../src/worker";
import { codexPricingModelMatches, harnessCommand, prepareHarness, profileEnvironment, usageFromEvents } from "../src/harnesses";
import type { WorkerJob } from "../src/types";

const temporary: string[] = [];
const oldPath = process.env.PATH, oldKey = process.env.OPENROUTER_API_KEY;
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); process.env.PATH = oldPath; if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey; });
function jobFixture(harness: "opencode" | "claude-code" | "codex" = "opencode"): { root: string; job: WorkerJob } {
  const root = mkdtempSync(join(tmpdir(), "ultrafuzz-worker-test-")); temporary.push(root); chmodSync(root, 0o755);
  const job: WorkerJob = { deadline_at: new Date(Date.now() + 3600_000).toISOString(), workspace: join(root, "workspace"), output_dir: join(root, "outputs"), profile_dir: join(root, "profile"), reference_dir: join(root, "reference"), prompt_path: join(root, "prompt.txt"), record: {
    schema: "ultrafuzz.run.v2", id: "20261103-120000-abcd1234", label: "test", ultrafuzz_version: "0.2.0", source: { repository: "https://example.com/source", commit: "abc" }, profile: { name: "v2/test", sha256: "" }, harness: { name: harness, model: "openrouter/vendor/model" }, state: "prepared", status: "pending", end: null, exit_code: null, created_at: new Date().toISOString(), started_at: null, finished_at: null, last_observed_at: null, session_id: null, continuation: null, inputs: [], omitted: [], usage: { input_tokens: null, output_tokens: null, cost_usd: null, cost_provenance: "unavailable" }, modal: { app: "test", cpu: 1, memory_mib: 1024, timeout_seconds: 3600, sandbox_id: null, volume_name: "test" }, publication: { state: "pending", repository: "owner/results", branch: "ultrafuzz/test", path: "attempts/test/runs/test", pr_url: null },
  }};
  for (const directory of [job.workspace, job.profile_dir, job.reference_dir, job.output_dir]) mkdirSync(directory, { recursive: true });
  writeFileSync(job.prompt_path, "Inspect source and write a report.");
  writeFileSync(join(job.profile_dir, "prompt.mdx"), "Inspect source.");
  return { root, job };
}
async function stubRun(behavior: string): Promise<{ root: string; job: WorkerJob }> {
  const fixture = jobFixture(), { root, job } = fixture;
  const source = join(root, "source"), bin = join(root, "bin"); mkdirSync(source); mkdirSync(bin);
  writeFileSync(join(source, "source.sol"), "// source");
  await createTar({ gzip: true, cwd: source, file: join(root, "source.tar.gz") }, ["source.sol"]);
  const script = `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo '1.19.3'; exit 0; fi\ncat >/dev/null\necho '{"type":"text","sessionID":"ses_test"}'\n${behavior}\n`;
  writeFileSync(join(bin, "opencode"), script, { mode: 0o755 });
  writeFileSync(join(root, "job.json"), JSON.stringify(job));
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.OPENROUTER_API_KEY = "test-secret-never-publish";
  return fixture;
}

describe("worker execution contract", () => {
  test("cutoffs share an absolute deadline, including short runs", () => {
    expect(deadlines(0, 3600_000)).toEqual({ initial: 1800_000, continuation: 3000_000, export: 3600_000 });
    expect(deadlines(0, 60_000)).toEqual({ initial: 30_000, continuation: 50_000, export: 60_000 });
    expect(deadlines(120_000, 3600_000, 3600_000)).toEqual({ initial: 1800_000, continuation: 3000_000, export: 3600_000 });
  });
  test("missing report gets exactly one native continuation and retained evidence", async () => {
    const { root, job } = await stubRun(`if [[ "$*" == *"--session ses_test"* ]]; then echo finished > '${"REPLACE"}'; fi\necho "$OPENROUTER_API_KEY" >&2`);
    const script = join(root, "bin/opencode"); writeFileSync(script, readFileSync(script, "utf8").replace("REPLACE", join(job.output_dir, "raw/report.md")));
    const record = await runWorker(root);
    expect(record.status).toBe("succeeded"); expect(record.continuation?.report_after).toBe(true); expect(record.session_id).toBe("ses_test");
    expect(readFileSync(join(job.output_dir, "raw/transcript.jsonl"), "utf8").split("ses_test").length - 1).toBe(2);
    expect(readFileSync(join(job.output_dir, "raw/stderr.log"), "utf8")).not.toContain("test-secret-never-publish");
    expect(JSON.parse(readFileSync(join(root, "complete.json"), "utf8"))).toEqual(record);
    expect(existsSync(join(job.output_dir, "run.yml"))).toBe(true);
  });
  test("a second missing report finishes failed without a third invocation", async () => {
    const { root, job } = await stubRun("echo '{\"type\":\"step_finish\",\"part\":{\"id\":\"step\",\"cost\":0.02,\"tokens\":{\"input\":4,\"output\":2}}}'");
    const record = await runWorker(root);
    expect(record.status).toBe("failed"); expect(record.continuation?.report_after).toBe(false);
    expect(readFileSync(join(job.output_dir, "raw/transcript.jsonl"), "utf8").split("ses_test").length - 1).toBe(2);
  });
  test("cancellation preserves evidence and skips continuation", async () => {
    const { root, job } = await stubRun("sleep 20");
    const cancel = setTimeout(() => process.emit("SIGTERM"), 50);
    const record = await runWorker(root); clearTimeout(cancel);
    expect(record.end).toBe("cancelled"); expect(record.continuation).toBeNull();
    expect(existsSync(join(job.output_dir, "raw/transcript.jsonl"))).toBe(true);
    expect(existsSync(join(root, "complete.json"))).toBe(true);
  });
  test("a cancellation marker before startup prevents harness invocation", async () => {
    const { root, job } = await stubRun("exit 99");
    writeFileSync(join(root, "cancelled"), "");
    const record = await runWorker(root);
    expect(record.end).toBe("cancelled"); expect(record.started_at).toBeNull();
    expect(existsSync(join(root, "worker.pid"))).toBe(true);
    expect(existsSync(join(job.output_dir, "raw/transcript.jsonl"))).toBe(false);
    expect(existsSync(join(root, "complete.json"))).toBe(true);
  });
  test("timeout uses original deadline and preserves partial transcript", async () => {
    const { root, job } = await stubRun("sleep 20");
    job.deadline_at = new Date(Date.now() + 1000).toISOString();
    job.record.modal.timeout_seconds = 1;
    writeFileSync(join(root, "job.json"), JSON.stringify(job));
    const record = await runWorker(root);
    expect(record.end).toBe("timeout"); expect(record.continuation).toBeNull();
    expect(readFileSync(join(job.output_dir, "raw/transcript.jsonl"), "utf8")).toContain("ses_test");
  });
  test("native configs keep host credentials out and select OpenRouter", () => {
    for (const harness of ["claude-code", "opencode", "codex"] as const) {
      const { root, job } = jobFixture(harness); const context = prepareHarness(root, job, "secret");
      expect(context.env.MODAL_TOKEN_SECRET).toBeUndefined(); expect(context.env.GITHUB_TOKEN).toBeUndefined();
      expect(harnessCommand(context, "ses_test").join(" ")).toContain(harness === "codex" ? "resume ses_test" : harness === "claude-code" ? "--resume ses_test" : "--session ses_test");
      expect(readFileSync(context.configPath, "utf8")).not.toContain("secret");
      if (harness === "claude-code") expect(context.env.ANTHROPIC_AUTH_TOKEN).toBe("secret");
    }
  });
  test("source customizations are removed only from disposable tree", () => {
    const { job } = jobFixture(); mkdirSync(join(job.workspace, "nested/.agents"), { recursive: true });
    writeFileSync(join(job.workspace, "nested/AGENTS.md"), "malicious instructions"); writeFileSync(join(job.workspace, "nested/source.sol"), "code");
    removeProjectCustomizations(job.workspace);
    expect(existsSync(join(job.workspace, "nested/.agents"))).toBe(false);
    expect(existsSync(join(job.workspace, "nested/AGENTS.md"))).toBe(false);
    expect(existsSync(join(job.workspace, "nested/source.sol"))).toBe(true);
  });
  test("profile environment supports native knobs without replacing routing or homes", () => {
    expect(profileEnvironment("opencode", { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "64000" })).toEqual({ OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "64000" });
    expect(profileEnvironment("claude-code", { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" })).toEqual({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
    for (const key of ["OPENROUTER_API_KEY", "HOME", "OPENCODE_CONFIG", "OPENCODE_DISABLE_PROJECT_CONFIG"]) expect(() => profileEnvironment("opencode", { [key]: "x" })).toThrow();
    expect(() => profileEnvironment("claude-code", { CLAUDE_CODE_OAUTH_TOKEN: "x" })).toThrow();
  });
  test("whitespace reports are incomplete", () => {
    const { root } = jobFixture(); const report = join(root, "report.md"); writeFileSync(report, " \n\t");
    expect(nonemptyReport(report)).toBe(false);
  });
  test("OpenCode accounting includes cache and reasoning components", () => {
    const usage = usageFromEvents("opencode", [{ type: "step_finish", part: { id: "step", cost: 0.1, tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } } } }]);
    expect(usage.input_tokens).toBe(100); expect(usage.output_tokens).toBe(50); expect(usage.cost_usd).toBe(0.1);
  });
  test("mixed Codex model usage is not priced at the lead model's rate", () => {
    expect(codexPricingModelMatches("vendor/model", [{ agents: { reviewer: { model: "vendor/other" } } }], [])).toBe(false);
    expect(codexPricingModelMatches("vendor/model", [], ["vendor/other"])).toBe(false);
    expect(codexPricingModelMatches("vendor/model", [{ model: "openrouter/vendor/model" }], ["vendor/model"])).toBe(true);
  });
  test("Claude resume cumulative costs are not double-counted", () => {
    const usage = usageFromEvents("claude-code", [{ type: "result", session_id: "same", total_cost_usd: 2, usage: { input_tokens: 4, output_tokens: 2 } }, { type: "result", session_id: "same", total_cost_usd: 3, usage: { input_tokens: 6, output_tokens: 3 } }]);
    expect(usage.cost_usd).toBe(3);
  });
});
