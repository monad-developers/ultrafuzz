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
  await writeFile(join(root, "publish.ts"), `import { publishRun } from ${JSON.stringify(publisher)};\ntry { console.log(JSON.stringify(await publishRun(await Bun.file(process.argv[2]).json(), process.argv[3]))); } catch (error) { console.error(error.message); process.exit(1); }\n`);
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
  expect(await git(["rev-parse", "main"], f.remote)).toBe(head);
});

test("public destinations are rejected before cloning", async () => {
  const f = await fixture();
  const result = await f.publish({ TEST_PUBLIC: "1" });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("must be private");
  expect(await readFile(join(f.root, "gh.log"), "utf8")).not.toContain("repo clone");
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
