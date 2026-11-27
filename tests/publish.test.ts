import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const id = "20261103-120000-aabbccdd";
const branch = `ultrafuzz/${id}`;
const runPath = `attempts/baseline/runs/${id}`;
const publisher = new URL("../src/publish.ts", import.meta.url).pathname;
const gitBinary = Bun.which("git")!;
async function git(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn([gitBinary, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(err);
  return out;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ultrafuzz-publish-test-"));
  roots.push(root);
  const remote = join(root, "remote.git"), seed = join(root, "seed"), artifacts = join(root, "artifacts"), bin = join(root, "bin");
  await mkdir(seed); await mkdir(artifacts); await mkdir(bin);
  await git(["init", "--bare", remote], root);
  await git(["init", "--initial-branch=main"], seed);
  await writeFile(join(seed, "README.md"), "Private results\n");
  await git(["add", "README.md"], seed); await git(["commit", "-m", "Initialize"], seed);
  await git(["remote", "add", "origin", remote], seed); await git(["push", "origin", "main"], seed);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);
  await writeFile(join(artifacts, "report.md"), "Report one\n");
  await writeFile(join(artifacts, "run.yml"), `id: ${id}\n`);
  const state = join(root, "pr.json");
  await writeFile(state, "[]");
  const record = { id, label: "baseline", publication: { repository: "example/results", branch, path: runPath } };
  await writeFile(join(root, "record.json"), JSON.stringify(record));
  await writeFile(join(root, "publish.ts"), `import { publishRun } from ${JSON.stringify(publisher)};\ntry { console.log(JSON.stringify(await publishRun(await Bun.file(process.argv[2]).json(), process.argv[3]))); } catch (error) { console.error(error.name + ": " + error.message); process.exit(1); }\n`);
  await writeFile(join(bin, "gh"), `#!${process.execPath}
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2), state = process.env.TEST_PR_STATE;
await writeFile(process.env.TEST_GH_LOG, args.join(" ") + "\\n", {flag:"a"});
if (args[0] === "repo" && args[1] === "view") console.log(JSON.stringify({isPrivate: process.env.TEST_PUBLIC !== "1",defaultBranchRef:{name:"main"}}));
else if (args[0] === "repo" && args[1] === "clone") {
 const child=Bun.spawn([process.env.TEST_GIT,"clone","--no-checkout",process.env.TEST_REMOTE,args[3]],{stdout:"ignore",stderr:"pipe"});
 const err=await new Response(child.stderr).text();const code=await child.exited;if(code){console.error(err);process.exit(code);}
} else if (args[0] === "pr" && args[1] === "list") console.log(await readFile(state,"utf8"));
else if (args[0] === "pr" && args[1] === "create") {
 const pr={number:1,state:"OPEN",url:"https://github.com/example/results/pull/1",mergedAt:null,baseRefName:"main"};
 await writeFile(state,JSON.stringify([pr]));console.log(pr.url);
} else if (args[0] === "pr" && args[1] === "reopen") {
 const prs=JSON.parse(await readFile(state,"utf8"));prs[0].state="OPEN";await writeFile(state,JSON.stringify(prs));
} else {console.error("Unexpected gh command");process.exit(1);}
`);
  await chmod(join(bin, "gh"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_REMOTE: remote, TEST_PR_STATE: state, TEST_GIT: gitBinary, TEST_GH_LOG: join(root, "gh.log") };
  const publish = async (extra: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, join(root, "publish.ts"), join(root, "record.json"), artifacts], { cwd: root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  return { root, remote, seed, artifacts, bin, state, publish };
}

test("publication preserves external files, removes only stale owned files, and reopens its PR", async () => {
  const f = await fixture();
  expect((await f.publish()).code).toBe(0);
  await git(["fetch", "origin", branch], f.seed);
  await git(["checkout", "-b", branch, "FETCH_HEAD"], f.seed);
  await writeFile(join(f.seed, runPath, "findings.yml"), "external: true\n");
  await writeFile(join(f.seed, runPath, "judgments.json"), '{"score":4}\n');
  await git(["add", "--", runPath], f.seed); await git(["commit", "-m", "External evaluation"], f.seed);
  await git(["push", "origin", branch], f.seed);
  await rm(join(f.artifacts, "report.md"));
  await writeFile(join(f.artifacts, "report.md.gz"), "stand-in compressed report");
  const prs = JSON.parse(await readFile(f.state, "utf8")); prs[0].state = "CLOSED"; await writeFile(f.state, JSON.stringify(prs));
  const second = await f.publish();
  expect(second.code).toBe(0);
  expect(await git(["show", `${branch}:${runPath}/findings.yml`], f.remote)).toBe("external: true\n");
  expect(await git(["show", `${branch}:${runPath}/judgments.json`], f.remote)).toBe('{"score":4}\n');
  expect(await git(["ls-tree", "-r", "--name-only", branch], f.remote)).not.toContain(`${runPath}/report.md\n`);
  expect(JSON.parse(await readFile(f.state, "utf8"))[0].state).toBe("OPEN");
  const head = await git(["rev-parse", branch], f.remote);
  expect((await f.publish()).code).toBe(0);
  expect(await git(["rev-parse", branch], f.remote)).toBe(head);
});

test("merged unchanged results return the old PR; changed artifacts fail without rewriting history", async () => {
  const f = await fixture();
  expect((await f.publish()).code).toBe(0);
  await git(["fetch", "origin", branch], f.seed);
  await git(["merge", "--ff-only", "FETCH_HEAD"], f.seed);
  await git(["push", "origin", "main"], f.seed);
  await git(["push", "origin", "--delete", branch], f.seed);
  const prs = JSON.parse(await readFile(f.state, "utf8")); prs[0].state = "MERGED"; prs[0].mergedAt = "2026-11-03T13:00:00Z"; await writeFile(f.state, JSON.stringify(prs));
  const unchanged = await f.publish();
  expect(unchanged.code).toBe(0);
  expect(JSON.parse(unchanged.stdout).pr_url).toEndWith("/pull/1");
  const head = await git(["rev-parse", "main"], f.remote);
  await writeFile(join(f.artifacts, "report.md"), "Changed report\n");
  const changed = await f.publish();
  expect(changed.code).toBe(1);
  expect(changed.stderr).toContain("already merged");
  // The caller gets this answer as an error of its own class, so it can tell it from a failure that a new attempt can repair.
  expect(changed.stderr).toStartWith(`ResultsMerged: Results for ${id} were already merged; these artifacts differ.`);
  expect(await git(["rev-parse", "main"], f.remote)).toBe(head);
});

test("public destinations are rejected before cloning", async () => {
  const f = await fixture();
  const result = await f.publish({ TEST_PUBLIC: "1" });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("must be private");
  expect(await readFile(join(f.root, "gh.log"), "utf8")).not.toContain("repo clone");
});

test("a record without a results repository is refused before any GitHub call", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "record.json"), JSON.stringify({ id, label: "baseline", publication: { state: "disabled", repository: null, branch, path: runPath } }));
  const result = await f.publish();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("No results repository");
  expect(await Bun.file(join(f.root, "gh.log")).exists()).toBe(false);
});

test("a competing remote commit is fetched and preserved on retry", async () => {
  const f = await fixture();
  await writeFile(join(f.bin, "git"), `#!${process.execPath}
import { mkdir, writeFile } from "node:fs/promises";
const args=process.argv.slice(2), real=process.env.TEST_GIT;
async function run(a,cwd){const p=Bun.spawn([real,"-c","user.name=Other","-c","user.email=other@localhost",...a],{cwd,stdout:"ignore",stderr:"pipe"});const e=await new Response(p.stderr).text();if(await p.exited)throw Error(e);}
if(args.includes("push") && !await Bun.file(process.env.TEST_RACE_MARKER).exists()){
 await writeFile(process.env.TEST_RACE_MARKER,"1");const d=process.env.TEST_RACE_CHECKOUT;
 await run(["clone",process.env.TEST_REMOTE,d],process.cwd());await run(["checkout","-b",${JSON.stringify(branch)}],d);
 await mkdir(d+"/"+${JSON.stringify(runPath)},{recursive:true});await writeFile(d+"/"+${JSON.stringify(`${runPath}/external.json`)},"external result\\n");
 await run(["add","."],d);await run(["commit","-m","Concurrent result"],d);await run(["push","origin",${JSON.stringify(branch)}],d);
}
const p=Bun.spawn([real,...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(await p.exited);
`);
  await chmod(join(f.bin, "git"), 0o755);
  const result = await f.publish({ TEST_RACE_MARKER: join(f.root, "race"), TEST_RACE_CHECKOUT: join(f.root, "competitor") });
  expect(result.code).toBe(0);
  expect(await git(["show", `${branch}:${runPath}/external.json`], f.remote)).toBe("external result\n");
  expect(await git(["show", `${branch}:${runPath}/report.md`], f.remote)).toBe("Report one\n");
});

test("unowned collisions are refused without deleting external evidence", async () => {
  const f = await fixture();
  await git(["checkout", "-b", branch], f.seed);
  await mkdir(join(f.seed, runPath), { recursive: true });
  await writeFile(join(f.seed, runPath, "report.md"), "External report\n");
  await git(["add", "."], f.seed); await git(["commit", "-m", "Existing external file"], f.seed);
  await git(["push", "origin", branch], f.seed);
  const result = await f.publish();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("overwrite an external file");
  expect(await git(["show", `${branch}:${runPath}/report.md`], f.remote)).toBe("External report\n");
});

/** A `git` that comes first on PATH. It runs the real git and then writes one JSON line for the call: arguments, prompt setting and the files of the working tree. */
async function recordingGit(f: Awaited<ReturnType<typeof fixture>>): Promise<() => Promise<Array<{ args: string[]; prompt: string | null; files: string[] }>>> {
  const log = join(f.root, "git.log");
  await writeFile(join(f.bin, "git"), `#!${process.execPath}
import { appendFile, readdir } from "node:fs/promises";
const args = process.argv.slice(2);
const child = Bun.spawn([process.env.TEST_GIT, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const code = await child.exited;
let files = [];
try { files = (await readdir(".", { recursive: true })).filter(name => !name.startsWith(".git/") && name !== ".git").sort(); } catch {}
await appendFile(${JSON.stringify(log)}, JSON.stringify({ args, prompt: process.env.GIT_TERMINAL_PROMPT ?? null, files }) + "\\n");
process.exit(code);
`);
  await chmod(join(f.bin, "git"), 0o755);
  return async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

test("files that an ignore rule of the results repository matches are published all the same", async () => {
  const f = await fixture();
  // As from a .gitignore template: logs and library directories are ignored.
  await writeFile(join(f.seed, ".gitignore"), "*.log\nlib/\nbuild/\n");
  await git(["add", ".gitignore"], f.seed); await git(["commit", "-m", "Ignore rules"], f.seed); await git(["push", "origin", "main"], f.seed);
  await mkdir(join(f.artifacts, "raw/workspace/lib"), { recursive: true });
  await writeFile(join(f.artifacts, "raw/stderr.log"), "stderr\n");
  await writeFile(join(f.artifacts, "raw/worker.log"), "worker\n");
  await writeFile(join(f.artifacts, "raw/workspace/lib/Harness.sol"), "contract Harness {}\n");
  expect((await f.publish()).code).toBe(0);
  const tree = (await git(["ls-tree", "-r", "--name-only", branch], f.remote)).trim().split("\n");
  const manifest = JSON.parse(await git(["show", `${branch}:${runPath}/.ultrafuzz-files.json`], f.remote)) as { files: string[] };
  // The commit holds each file that the ownership manifest names.
  expect(manifest.files).toEqual(["raw/stderr.log", "raw/worker.log", "raw/workspace/lib/Harness.sol", "report.md", "run.yml"]);
  for (const file of manifest.files) expect(tree).toContain(`${runPath}/${file}`);
  // A second publication of the same package changes nothing, and a file that is no longer in the package is removed.
  const head = await git(["rev-parse", branch], f.remote);
  expect((await f.publish()).code).toBe(0);
  expect(await git(["rev-parse", branch], f.remote)).toBe(head);
  await rm(join(f.artifacts, "raw/worker.log"));
  expect((await f.publish()).code).toBe(0);
  expect(await git(["ls-tree", "-r", "--name-only", branch], f.remote)).not.toContain("raw/worker.log");
});

test("git gets its GitHub credentials from gh and never asks at the terminal", async () => {
  const f = await fixture(), calls = await recordingGit(f);
  expect((await f.publish()).code).toBe(0);
  const seen = await calls();
  for (const verb of ["ls-remote", "fetch", "checkout", "add", "commit", "push"]) expect(seen.some(call => call.args.includes(verb)) ? "" : verb).toBe("");
  for (const call of seen) {
    expect(call.prompt).toBe("0");
    // The helper of github.com is reset and then set to gh. Other hosts and local remotes keep the configuration of the user.
    const text = call.args.join(" ");
    expect(text).toContain("-c credential.https://github.com.helper= -c credential.https://github.com.helper=!gh auth git-credential");
    expect(text).toContain("-c core.hooksPath=/dev/null -c commit.gpgsign=false");
    expect(text).not.toMatch(/-c credential\.helper=/);
  }
});

test("only the directory of the run is checked out, whatever the results repository already holds", async () => {
  const f = await fixture();
  // Two earlier runs are merged in the results repository, and a link stands where a label directory could be.
  for (const path of [`attempts/baseline/runs/20261101-000000-00000001/report.md`, `attempts/other/runs/20261102-000000-00000002/raw/transcript.jsonl`, "attempts/note.txt"]) {
    await mkdir(join(f.seed, path, ".."), { recursive: true });
    await writeFile(join(f.seed, path), "earlier result\n");
  }
  await git(["add", "."], f.seed); await git(["commit", "-m", "Earlier runs"], f.seed); await git(["push", "origin", "main"], f.seed);
  const calls = await recordingGit(f);
  expect((await f.publish()).code).toBe(0);
  const checkouts = (await calls()).filter(call => call.args.includes("checkout") && !call.args.includes("sparse-checkout"));
  expect(checkouts.length).toBeGreaterThan(0);
  for (const { files } of checkouts) {
    // The files next to each parent directory are there, so a link on the path is still seen. The other runs are not.
    expect(files).toContain("README.md");
    expect(files).toContain("attempts/note.txt");
    expect(files.filter(name => name.includes("20261101-000000-00000001") || name.includes("attempts/other/"))).toEqual([]);
  }
  // The commit keeps the files that were not checked out.
  const tree = await git(["ls-tree", "-r", "--name-only", branch], f.remote);
  for (const path of [`${runPath}/report.md`, "attempts/baseline/runs/20261101-000000-00000001/report.md", "attempts/other/runs/20261102-000000-00000002/raw/transcript.jsonl"]) expect(tree).toContain(path);

  // A link where the label directory would be is refused, as with a full checkout.
  const linked = await fixture();
  await mkdir(join(linked.seed, "attempts")); await mkdir(join(linked.seed, "elsewhere"));
  await writeFile(join(linked.seed, "elsewhere/keep.txt"), "external\n");
  await Bun.spawn(["ln", "-s", "../elsewhere", join(linked.seed, "attempts/baseline")]).exited;
  await git(["add", "."], linked.seed); await git(["commit", "-m", "A link"], linked.seed); await git(["push", "origin", "main"], linked.seed);
  const refused = await linked.publish();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("Unsafe repository path");

  // A git that cannot do a sparse checkout still publishes, with the whole tree.
  const old = await fixture();
  await writeFile(join(old.bin, "git"), `#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = "sparse-checkout" ]; then echo "git: 'sparse-checkout' is not a git command." >&2; exit 1; fi; done\nexec "$TEST_GIT" "$@"\n`);
  await chmod(join(old.bin, "git"), 0o755);
  expect((await old.publish()).code).toBe(0);
  expect(await git(["show", `${branch}:${runPath}/report.md`], old.remote)).toBe("Report one\n");

  // A git that has the command but fails to set the directory of the run can leave a sparse checkout of another
  // directory behind. The publication then turns the sparse checkout off and works with the whole tree.
  const partial = await fixture();
  await writeFile(join(partial.bin, "git"), `#!/bin/sh\nprevious=\nfor arg in "$@"; do\n  if [ "$previous" = "sparse-checkout" ] && [ "$arg" = "set" ]; then "$TEST_GIT" sparse-checkout set --cone not-the-run >/dev/null 2>&1; echo "error: the cone could not be set" >&2; exit 129; fi\n  previous=$arg\ndone\nexec "$TEST_GIT" "$@"\n`);
  await chmod(join(partial.bin, "git"), 0o755);
  const published = await partial.publish();
  expect(published.stderr).toBe("");
  expect(published.code).toBe(0);
  expect(await git(["show", `${branch}:${runPath}/report.md`], partial.remote)).toBe("Report one\n");
});
