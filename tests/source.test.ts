import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract as extractTar, list as listTar } from "tar";
import { prepareDependency, prepareSource, stageInputs } from "../src/source";

const roots: string[] = [];
const realGit = Bun.which("git")!;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "ultrafuzz-source-test-")); roots.push(path); return path;
}
async function git(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn([realGit, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-c", "protocol.file.allow=always", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(stderr);
  return stdout.trim();
}
async function repository(root: string, name = "repository") {
  const path = join(root, name); await mkdir(path); await git(["init", "--initial-branch=main"], path); return path;
}
async function commit(path: string, message = "Fixture") {
  await git(["add", "-f", "."], path); await git(["commit", "-m", message], path); return git(["rev-parse", "HEAD"], path);
}
async function withEnvironment<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await fn(); } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test("source snapshot records the default-branch commit, retains build inputs and strips credentials and caches", async () => {
  const root = await directory(), repo = await repository(root);
  await mkdir(join(repo, "src")); await mkdir(join(repo, ".cache"));
  await writeFile(join(repo, "src/main.txt"), "source\n");
  await writeFile(join(repo, "package.json"), '{}\n');
  await writeFile(join(repo, ".env"), "SECRET=fixture\n");
  await writeFile(join(repo, ".git-credentials"), "fixture credentials\n");
  await writeFile(join(repo, ".cache/item"), "cache\n");
  await writeFile(join(repo, "build.sh"), "#!/bin/sh\nexit 0\n"); await chmod(join(repo, "build.sh"), 0o755);
  await symlink("src/main.txt", join(repo, "source-link"));
  const head = await commit(repo);
  const destination = join(root, "prepared");
  const result = await prepareSource(repo, "src/", destination);
  expect(result.commit).toBe(head);
  const names: string[] = [];
  await listTar({ file: result.archive, onReadEntry: (entry) => { names.push(entry.path); } });
  expect(names).toContain("./package.json");
  expect(names.some((name) => /(^|\/)\.git(?:\/|$)|\.env$|\.cache|\.git-credentials/.test(name))).toBe(false);
  const unpacked = join(root, "unpacked"); await mkdir(unpacked); await extractTar({ cwd: unpacked, file: result.archive });
  expect(await readFile(join(unpacked, "src/main.txt"), "utf8")).toBe("source\n");
  expect(await readlink(join(unpacked, "source-link"))).toBe("src/main.txt");
  expect((await lstat(join(unpacked, "build.sh"))).mode & 0o111).not.toBe(0);
  expect((await readdir(destination)).sort()).toEqual(["source.tar.gz", "workspace"]);
});

test("recursive submodules are included and dependency revisions resolve independently", async () => {
  const root = await directory(), child = await repository(root, "child"), repo = await repository(root);
  await writeFile(join(child, "library.txt"), "library\n"); await commit(child);
  await writeFile(join(repo, "version.txt"), "old\n");
  await git(["submodule", "add", child, "lib/child"], repo);
  const old = await commit(repo);
  await writeFile(join(repo, "version.txt"), "new\n"); const latest = await commit(repo, "Update");
  await withEnvironment({ GIT_ALLOW_PROTOCOL: "file" }, async () => {
    const source = await prepareSource(repo, undefined, join(root, "source"));
    expect(source.commit).toBe(latest);
    expect(await readFile(join(root, "source/workspace/lib/child/library.txt"), "utf8")).toBe("library\n");
    const dependency = await prepareDependency(repo, old, join(root, "dependency"));
    expect(dependency.commit).toBe(old);
    expect(await readFile(join(dependency.checkout, "version.txt"), "utf8")).toBe("old\n");
    expect((await readdir(join(dependency.checkout, "lib/child"))).includes(".git")).toBe(false);
  });
});

test("staged input hashes identify files and deterministic trees without metadata or host links", async () => {
  const root = await directory(), inputs = join(root, "input-tree"); await mkdir(inputs);
  await writeFile(join(root, "report.md"), "Prior properties\n");
  await writeFile(join(inputs, "data.bin"), Buffer.from([0, 255, 2]));
  await symlink("data.bin", join(inputs, "data-link"));
  await mkdir(join(inputs, ".git")); await writeFile(join(inputs, ".git/config"), "credential=fixture\n");
  await writeFile(join(inputs, ".env"), "SECRET=fixture\n");
  const specs = [{ name: "properties", path: join(root, "report.md"), source_run: "prior-run" }, { name: "library", path: inputs }];
  const first = await stageInputs(specs, join(root, "reference-one"));
  const second = await stageInputs(specs, join(root, "reference-two"));
  expect(first).toEqual(second);
  expect(first[0]).toEqual({ name: "properties", path: "/run-data/reference/properties", source_run: "prior-run", sha256: createHash("sha256").update("Prior properties\n").digest("hex") });
  expect((await readdir(join(root, "reference-one/library"))).sort()).toEqual(["data-link", "data.bin"]);
  await writeFile(join(inputs, "extra"), "new data");
  expect((await stageInputs(specs, join(root, "reference-three")))[1]!.sha256).not.toBe(first[1]!.sha256);
});

test("escaping, absolute and looping input links and device files are rejected atomically", async () => {
  const root = await directory(), input = join(root, "input"), destination = join(root, "reference");
  await mkdir(input); await mkdir(destination); await writeFile(join(destination, "previous"), "retained\n");
  await writeFile(join(root, "host-secret"), "fixture\n");
  for (const target of ["../host-secret", join(root, "host-secret"), "link"]) {
    await symlink(target, join(input, "link"));
    await expect(stageInputs([{ name: "input", path: input }], destination)).rejects.toThrow("symlink");
    await rm(join(input, "link"));
    expect(await readFile(join(destination, "previous"), "utf8")).toBe("retained\n");
  }
  const fifo = Bun.spawn(["mkfifo", join(input, "pipe")], { stdout: "ignore", stderr: "pipe" }); expect(await fifo.exited).toBe(0);
  await expect(stageInputs([{ name: "input", path: input }], destination)).rejects.toThrow("unsupported file");
});

test("source links cannot expose the host or Git credential metadata", async () => {
  const root = await directory(), repo = await repository(root);
  await symlink(".git/config", join(repo, "metadata")); await commit(repo);
  await expect(prepareSource(repo, undefined, join(root, "snapshot"))).rejects.toThrow("excluded metadata");
  await expect(prepareSource("https://user:fixture-token@example.invalid/source.git", undefined, join(root, "url"))).rejects.toThrow("must not contain credentials");
});

test("LFS is materialized when needed and missing tooling or unresolved pointers stop launch", async () => {
  const root = await directory(), repo = await repository(root), bin = join(root, "bin"); await mkdir(bin);
  const payload = "large-file-content\n";
  await writeFile(join(repo, ".gitattributes"), "payload.txt filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(join(repo, "payload.txt"), `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash("sha256").update(payload).digest("hex")}\nsize ${payload.length}\n`);
  await commit(repo);
  await writeFile(join(bin, "git"), `#!${process.execPath}
import {writeFile} from "node:fs/promises";
const args=process.argv.slice(2), i=args.indexOf("lfs");
if(i>=0){if(process.env.TEST_LFS_MODE==="missing")process.exit(1);if(args[i+1]==="pull" && process.env.TEST_LFS_MODE==="materialized")await writeFile("payload.txt",${JSON.stringify(payload)});process.exit(0);}
const p=Bun.spawn([${JSON.stringify(realGit)},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(await p.exited);
`);
  await chmod(join(bin, "git"), 0o755);
  await withEnvironment({ PATH: `${bin}:${process.env.PATH}`, TEST_LFS_MODE: "missing" }, async () => {
    await expect(prepareSource(repo, undefined, join(root, "missing"))).rejects.toThrow("install git-lfs");
    process.env.TEST_LFS_MODE = "unresolved";
    await expect(prepareSource(repo, undefined, join(root, "unresolved"))).rejects.toThrow("did not materialize");
    process.env.TEST_LFS_MODE = "materialized";
    await prepareSource(repo, undefined, join(root, "materialized"));
    expect(await readFile(join(root, "materialized/workspace/payload.txt"), "utf8")).toBe(payload);
  });
});
