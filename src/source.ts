import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { create as createTar } from "tar";
import { redactText } from "./artifacts";
import type { InputRecord } from "./types";

const excluded = new Set([".git", ".git-credentials", ".netrc", ".ssh", ".aws", ".env", ".npmrc", ".pypirc", ".cache", ".npm", "node_modules", "__pycache__", ".pytest_cache"]);
const pointerPrefix = "version https://git-lfs.github.com/spec/v1\n";

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function repositoryUrl(repository: string): string {
  if (!repository || /[\x00-\x20\x7f]/.test(repository) || repository.startsWith("-")) throw new Error("Invalid source repository");
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) return `https://github.com/${repository}.git`;
  if (isAbsolute(repository) || repository.startsWith("./") || repository.startsWith("../")) return resolve(repository);
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(repository)) return repository;
  let url: URL;
  try { url = new URL(repository); } catch { throw new Error("Source must be a Git URL, GitHub owner/repo, or local repository path"); }
  if (!["https:", "ssh:", "file:"].includes(url.protocol) || url.password || (url.username && !(url.protocol === "ssh:" && url.username === "git")))
    throw new Error("Source URL must not contain credentials; use the host Git credential helper");
  if (url.search || url.hash) throw new Error("Source repository URL must not contain a query or fragment");
  return repository;
}

async function git(args: string[], cwd: string, input?: string): Promise<string> {
  const child = Bun.spawn([
    "git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never",
    "-c", "credential.https://github.com.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential", ...args,
  ], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" }, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) {
    const secrets = Object.entries(process.env).filter(([key, value]) => value && /TOKEN|KEY|PASSWORD|SECRET/i.test(key)).map(([, value]) => value!);
    throw new Error(`Git ${args[0]} failed: ${redactText(stderr || stdout, secrets).text.slice(-2000)}`);
  }
  return stdout;
}

/** Follow link components only for validation; never read a target outside the supplied tree. */
async function safeLink(root: string, path: string, depth = 0): Promise<void> {
  if (depth > 40 || !inside(root, path) || relative(root, path).split(sep).some((part) => excluded.has(part)))
    throw new Error("Input symlink escapes its tree, loops, or points into excluded metadata");
  const parts = relative(root, path).split(sep).filter(Boolean);
  let cursor = root;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    let info;
    try { info = await lstat(cursor); } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
    if (info.isSymbolicLink()) {
      const target = await readlink(cursor);
      if (isAbsolute(target)) throw new Error("Input contains an absolute symlink");
      return safeLink(root, resolve(dirname(cursor), target, ...parts.slice(i + 1)), depth + 1);
    }
  }
}

async function copyTree(source: string, destination: string, root = source): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await safeLink(root, source);
    await symlink(await readlink(source), destination);
  } else if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
      if (!excluded.has(name)) await copyTree(join(source, name), join(destination, name), root);
    }
    await chmod(destination, 0o755);
  } else if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, info.mode & 0o111 ? 0o755 : 0o644);
  } else throw new Error(`Input contains a device or unsupported file: ${relative(root, source)}`);
}

async function gitRoots(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string) {
    const children = await readdir(directory, { withFileTypes: true });
    if (children.some((child) => child.name === ".git")) result.push(directory);
    for (const child of children) if (child.isDirectory() && !excluded.has(child.name)) await walk(join(directory, child.name));
  }
  await walk(root);
  return result;
}

async function materializeLfs(root: string): Promise<void> {
  for (const directory of await gitRoots(root)) {
    const tracked = await git(["ls-files", "-z"], directory);
    if (!tracked) continue;
    const attributes = (await git(["check-attr", "-z", "--stdin", "filter"], directory, tracked)).split("\0");
    const names: string[] = [];
    for (let i = 0; i + 2 < attributes.length; i += 3) if (attributes[i + 2] === "lfs") names.push(attributes[i]!);
    if (!names.length) continue;
    try { await git(["lfs", "version"], directory); }
    catch { throw new Error("Source uses Git LFS; install git-lfs on the host before launching"); }
    await git(["lfs", "pull", "--include=", "--exclude="], directory);
    for (const name of names) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || (info.size < 1024 && (await readFile(path, "utf8")).startsWith(pointerPrefix)))
        throw new Error(`Git LFS did not materialize ${name}`);
    }
  }
}

async function prepareRepository(repository: string, revision: string | undefined, destination: string) {
  const remote = repositoryUrl(repository);
  if (revision && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(revision) || revision.includes(".."))) throw new Error("Invalid input repository revision");
  destination = resolve(destination);
  await mkdir(destination, { recursive: true });
  const temporary = await mkdtemp(join(destination, ".ultrafuzz-source-"));
  const checkout = join(temporary, "checkout"), clean = join(temporary, "clean");
  try {
    await git(["clone", "--recursive", "--", remote, checkout], destination);
    if (revision) {
      await git(["fetch", "--no-tags", "origin", revision], checkout);
      await git(["checkout", "--detach", "FETCH_HEAD"], checkout);
      await git(["submodule", "update", "--init", "--recursive"], checkout);
    }
    const commit = (await git(["rev-parse", "HEAD"], checkout)).trim();
    await materializeLfs(checkout);
    await copyTree(checkout, clean);
    const archive = join(destination, "source.tar.gz"), stagedArchive = join(temporary, "source.tar.gz");
    await createTar({ cwd: clean, file: stagedArchive, gzip: true, portable: true, mtime: new Date(0) }, ["."]);
    const workspace = join(destination, "workspace");
    await rm(workspace, { recursive: true, force: true });
    await rename(clean, workspace);
    await rename(stagedArchive, archive);
    return { archive, commit, checkout: workspace };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Scope constrains the prompt, not source files needed to build or test the project. */
export async function prepareSource(repository: string, _scope: string | undefined, destination: string): Promise<{ archive: string; commit: string }> {
  const { archive, commit } = await prepareRepository(repository, undefined, destination);
  return { archive, commit };
}

export async function prepareDependency(repository: string, revision: string | undefined, destination: string): Promise<{ archive: string; commit: string; checkout: string }> {
  return prepareRepository(repository, revision, destination);
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function inputHash(root: string): Promise<string> {
  if ((await lstat(root)).isFile()) return fileHash(root);
  const hash = createHash("sha256");
  async function walk(path: string, name: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) hash.update(`L\0${name}\0${await readlink(path)}\0`);
    else if (info.isFile()) hash.update(`F\0${name}\0${info.mode & 0o111 ? "x" : "-"}\0${await fileHash(path)}\0`);
    else {
      hash.update(`D\0${name}\0`);
      for (const child of (await readdir(path)).sort()) await walk(join(path, child), name ? `${name}/${child}` : child);
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}

/** Copy supplied inputs, not host config, and identify the exact staged bytes. */
export async function stageInputs(inputs: Array<{ name: string; path: string; source_run?: string }>, destination: string): Promise<InputRecord[]> {
  const names = new Set<string>();
  for (const input of inputs) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.name) || input.name === ".." || excluded.has(input.name) || names.has(input.name)) throw new Error(`Invalid or duplicate input name: ${input.name}`);
    names.add(input.name);
  }
  destination = resolve(destination);
  for (const input of inputs) {
    const source = resolve(input.path), info = await lstat(source);
    if (excluded.has(basename(source))) throw new Error("An explicitly supplied input cannot be a credential store or cache");
    if (info.isSymbolicLink()) throw new Error("An explicitly supplied input cannot itself be a symlink");
    if (inside(source, destination) || inside(destination, source)) throw new Error("Input sources and destination must not overlap");
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), ".ultrafuzz-inputs-"));
  const records: InputRecord[] = [];
  try {
    for (const input of inputs) {
      const path = join(temporary, input.name);
      await copyTree(resolve(input.path), path);
      records.push({ name: input.name, path: `/run-data/reference/${input.name}`, sha256: await inputHash(path), ...(input.source_run ? { source_run: input.source_run } : {}) });
    }
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return records;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
