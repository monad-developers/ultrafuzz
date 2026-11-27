import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { parse } from "yaml";
import { environmentSecrets, prepareArtifacts, redactDirectory, redactText } from "../src/artifacts";
import type { RunRecord } from "../src/types";

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ultrafuzz-artifacts-test-"));
  directories.push(root);
  const source = join(root, "source"), destination = join(root, "destination");
  await mkdir(join(source, "raw"), { recursive: true });
  await writeFile(join(source, "raw/report.md"), "# Report\nNo findings.\n");
  await writeFile(join(source, "raw/transcript.jsonl"), '{"message":"completed"}\n');
  await writeFile(join(source, "prompt.txt"), "Review the supplied source.\n");
  return { root, source, destination };
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function record(): RunRecord {
  return {
    schema: "ultrafuzz.run.v2", id: "20261103-120000-aabbccdd", label: "baseline", ultrafuzz_version: "0.2.0",
    source: { repository: "example/source", commit: "a".repeat(40) }, profile: { name: "v2/audit", sha256: "b".repeat(64) },
    harness: { name: "opencode", model: "provider/model" }, state: "finished", status: "succeeded", end: "completed", exit_code: 0,
    created_at: "2026-11-03T12:00:00Z", started_at: "2026-11-03T12:00:01Z", finished_at: "2026-11-03T12:10:00Z",
    last_observed_at: null, session_id: "session-1", continuation: null, inputs: [], omitted: [],
    usage: { input_tokens: 10, output_tokens: 20, cost_usd: null, cost_provenance: "unknown" },
    executor: { name: "modal", app: "ultrafuzz", cpu: 1, memory_mib: 1024, timeout_seconds: 3600, runtime_id: "sb-1", volume_name: "volume-1" },
    collection: { state: "pending", path: null, report: null },
    publication: { state: "pending", repository: "example/results", branch: "ultrafuzz/20261103-120000-aabbccdd", path: "attempts/baseline/runs/20261103-120000-aabbccdd", pr_url: null },
  };
}

test("redaction validates mnemonics and preserves public development fixtures and unlabeled hashes", () => {
  const mnemonic = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const dev = "test test test test test test test test test test test junk";
  const invalid = "abandon ".repeat(12).trim();
  const anvil = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const key = "9".repeat(64);
  const input = `${mnemonic}\n${dev}\n${invalid}\nhash: ${key}\nprivate_key: 0x${key}\nprivate_key: 0x${anvil}\nknown-secret`;
  const result = redactText(input, ["known-secret"]);
  expect(result.count).toBe(3);
  expect(result.text).not.toContain(mnemonic);
  expect(result.text).toContain(dev);
  expect(result.text).toContain(invalid);
  expect(result.text).toContain(`hash: ${key}`);
  expect(result.text).toContain(anvil);
  expect(redactText(dev, [dev]).text).toBe("[REDACTED]");
});

test("positive credential patterns include Google, Modal, and valid JWT structure", () => {
  const jwt = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"sub":"user"}').toString("base64url")}.abcdef0123456789`;
  const input = `AIza${"a".repeat(35)} ak-${"x".repeat(30)} as-${"y".repeat(30)} ${jwt} eyJbad.notjson.signature`;
  const result = redactText(input);
  expect(result.count).toBe(4);
  expect(result.text).toContain("eyJbad.notjson.signature");
});

test("the Modal token pattern leaves hyphenated words alone and still finds a token in every usual place", () => {
  for (const text of [
    "See https://example.org/findings/shares-can-be-used-as-collateral-without-a-health-check",
    "treats-as-settled-any-pending-withdrawal",
    "the-loan-is-marked-ak-collateralised-before-the-check-runs",
    "known_as-abcdefghijklmnopqrstuvwxyz",
  ]) expect(redactText(text)).toEqual({ text, count: 0 });
  const id = `ak-${"A1b2C3d4E5".repeat(2)}xy`, secret = `as-${"Z9y8X7w6V5".repeat(2)}uv`;
  for (const text of [`MODAL_TOKEN_ID=${id}`, `token_secret: "${secret}"`, `'${secret}'`, `(${id})`, `id ${id}, secret ${secret}.`, `${id}\n${secret}`]) {
    const result = redactText(text);
    expect(result.text).not.toContain(id.slice(3));
    expect(result.text).not.toContain(secret.slice(3));
    expect(result.count).toBe(text.split(/a[ks]-[A-Z]/).length - 1);
  }
});

test("host environment values count as secrets only by name and from eight characters on", () => {
  const environment = {
    KEYTIMEOUT: "1", TOKENIZERS_PARALLELISM: "false", ANSIBLE_HOST_KEY_CHECKING: "False", PASSWORD_STORE_CLIP_TIME: "45", SHORT_SECRET: "1234567",
    OPENROUTER_API_KEY: "sk-or-v1-example", MODAL_TOKEN_ID: "ak-example-id", MODAL_TOKEN_SECRET: "as-example-secret", GH_TOKEN: "ghp_example", GITHUB_TOKEN: "github_pat_example",
    AWS_SECRET_ACCESS_KEY: "aws-secret-example", DB_PASSWORD: "12345678", PATH: "/usr/bin:/bin", HOME: "/home/operator", EMPTY_KEY: "", UNSET_TOKEN: undefined,
  };
  expect(environmentSecrets(environment).sort()).toEqual(["12345678", "ak-example-id", "as-example-secret", "aws-secret-example", "ghp_example", "github_pat_example", "sk-or-v1-example"]);
  // A key that the caller knows exactly has no such limit.
  expect(redactText("key=short", ["short"]).text).toBe("key=[REDACTED]");
});

test("a redaction pass can be stopped before a file, replaces files whole and keeps their mode", async () => {
  const { source } = await fixture();
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(source, name), "known-secret\n");
  await chmod(join(source, "a.txt"), 0o644);
  // The pass is stopped when it comes to the third file. The files after it stay as they are.
  let asked = 0;
  expect(await redactDirectory(source, ["known-secret"], () => ++asked > 2)).toBe(2);
  expect(await Promise.all(["a.txt", "b.txt", "c.txt"].map(name => readFile(join(source, name), "utf8")))).toEqual(["[REDACTED]\n", "[REDACTED]\n", "known-secret\n"]);
  expect((await lstat(join(source, "a.txt"))).mode & 0o777).toBe(0o644);
  // No temporary file is left, and a link at the name of the temporary file is not written through.
  expect((await readdir(source)).sort()).toEqual(["a.txt", "b.txt", "c.txt", "prompt.txt", "raw"]);
  const outside = join(source, "..", "outside.txt");
  await writeFile(outside, "untouched");
  await symlink(outside, join(source, `c.txt.ultrafuzz-redact-${process.pid}.tmp`));
  expect(await redactDirectory(source, ["known-secret"])).toBe(1);
  expect(await readFile(outside, "utf8")).toBe("untouched");
  expect(await readFile(join(source, "c.txt"), "utf8")).toBe("[REDACTED]\n");
});

test("a file that an interrupted redaction pass left is not packaged and does not fail the package", async () => {
  const { source, destination } = await fixture();
  // Its name starts like a transcript, which is a mandatory artifact.
  await writeFile(join(source, "raw/transcript.jsonl.ultrafuzz-redact-4242.tmp"), '{"message":"half');
  expect(await redactDirectory(source, ["half"])).toBe(0);
  const result = await prepareArtifacts(source, destination, record());
  expect(result.omitted).toEqual([{ path: "raw/transcript.jsonl.ultrafuzz-redact-4242.tmp", reason: "file of an interrupted redaction pass excluded" }]);
  expect((await readdir(join(destination, "raw"))).sort()).toEqual(["report.md", "transcript.jsonl"]);
});

test("OpenRouter keys are redacted after an interrupted worker without the launch environment", async () => {
  const { source, destination } = await fixture();
  const key = `sk-or-v1-${"a1".repeat(32)}`;
  await writeFile(join(source, "raw/transcript.jsonl"), JSON.stringify({ output: `Bearer ${key}` }) + "\n");
  const result = await prepareArtifacts(source, destination, record());
  expect(result.redactions).toBe(1);
  expect(await readFile(join(destination, "raw/transcript.jsonl"), "utf8")).not.toContain(key);
  expect(redactText("Set sk-or-v1-... in your environment").count).toBe(0);
});

test("worker redaction handles gzip and does not follow symlinks", async () => {
  const { root, source } = await fixture();
  await writeFile(join(root, "outside.txt"), "known-secret");
  await symlink(join(root, "outside.txt"), join(source, "outside-link"));
  await writeFile(join(source, "raw/session.jsonl.gz"), gzipSync('{"key":"known-secret"}\n'));
  expect(await redactDirectory(source, ["known-secret"])).toBe(1);
  expect(gunzipSync(await readFile(join(source, "raw/session.jsonl.gz"))).toString()).toContain("[REDACTED]");
  expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("known-secret");
});

test("staging preserves prompt bytes, gzips large text and records every omitted file", async () => {
  const { root, source, destination } = await fixture();
  await mkdir(join(source, "raw/workspace/corpus"), { recursive: true });
  await writeFile(join(source, "raw/workspace/corpus/input.json"), "{}\n");
  await writeFile(join(source, "raw/workspace/binary.bin"), Buffer.from([0, 255, 1]));
  await symlink(join(root, "outside"), join(source, "raw/workspace/link"));
  await writeFile(join(source, "raw/transcript.jsonl"), "x".repeat(10 * 1024 * 1024 + 1));
  await writeFile(join(source, "raw/private-note.txt"), "known-secret");
  const result = await prepareArtifacts(source, destination, record(), ["known-secret"]);
  expect(result.omitted.map((item) => item.path).sort()).toEqual(["raw/workspace/binary.bin", "raw/workspace/corpus/input.json", "raw/workspace/link"]);
  expect(result.redactions).toBe(1);
  expect(await readFile(join(destination, "prompt.txt"), "utf8")).toBe("Review the supplied source.\n");
  expect(gunzipSync(await readFile(join(destination, "raw/transcript.jsonl.gz"))).length).toBe(10 * 1024 * 1024 + 1);
  expect(await readFile(join(source, "raw/private-note.txt"), "utf8")).toBe("known-secret");
  const run = parse(await readFile(join(destination, "run.yml"), "utf8"));
  expect(run.omitted).toEqual(result.omitted);
  expect(run.redactions).toBe(1);
  const rerun = record(); rerun.omitted = result.omitted;
  expect((await prepareArtifacts(source, destination, rerun, ["known-secret"])).omitted).toEqual(result.omitted);
});

test("a rejected mandatory artifact leaves previous bundle and original output intact", async () => {
  const { source, destination } = await fixture();
  await prepareArtifacts(source, destination, record());
  await writeFile(join(source, "raw/report.md"), Buffer.from([0, 1, 255]));
  await expect(prepareArtifacts(source, destination, record())).rejects.toThrow("mandatory artifact raw/report.md");
  expect(await readFile(join(destination, "raw/report.md"), "utf8")).toContain("No findings");
  expect((await readFile(join(source, "raw/report.md"))).length).toBe(3);
});

test("recollection metadata is stable across observation, collection and publication updates", async () => {
  const { source, destination } = await fixture();
  const run = record();
  await prepareArtifacts(source, destination, run);
  const before = await readFile(join(destination, "run.yml"), "utf8");
  run.last_observed_at = "2026-11-03T14:00:00Z";
  run.publication.state = "published";
  run.publication.pr_url = "https://github.com/example/results/pull/1";
  // Host paths belong to the local record only; the package must not carry them.
  run.collection = { state: "collected", path: "/home/operator/.ultrafuzz/runs/x/artifacts", report: "/home/operator/.ultrafuzz/runs/x/artifacts/raw/report.md" };
  await prepareArtifacts(source, destination, run);
  expect(await readFile(join(destination, "run.yml"), "utf8")).toBe(before);
  expect(before).not.toContain("/home/operator");
  expect(parse(before).executor).toEqual(run.executor);
  expect(parse(before).collection).toBeUndefined();
});

test("redaction covers artifact paths, omission paths and run metadata", async () => {
  const { source, destination } = await fixture();
  await writeFile(join(source, "raw/known-secret.txt"), "Notes\n");
  await writeFile(join(source, "raw/known-secret.bin"), Buffer.from([0, 255]));
  const run = record(); run.inputs = [{ name: "input", path: "/tmp/known-secret", sha256: "a".repeat(64) }];
  const result = await prepareArtifacts(source, destination, run, ["known-secret"]);
  expect(await readFile(join(destination, "raw/[REDACTED].txt"), "utf8")).toBe("Notes\n");
  expect(JSON.stringify(result.omitted)).not.toContain("known-secret");
  const metadata = await readFile(join(destination, "run.yml"), "utf8");
  expect(metadata).not.toContain("known-secret");
  expect(parse(metadata).redactions).toBe(result.redactions);
});
