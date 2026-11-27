import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { environmentSecrets, redactText } from "./artifacts";
import type { RunRecord } from "./types";

const OWNERSHIP = ".ultrafuzz-files.json";
interface Ownership { schema: "ultrafuzz.files.v1"; run_id: string; files: string[] }
interface PullRequest { number: number; state: "OPEN" | "CLOSED" | "MERGED"; url: string; mergedAt: string | null; baseRefName: string }

/**
 * The pull request of the run was merged, and the package differs from the merged files. Merged results are never
 * changed, so a new attempt with the same package gives the same answer.
 */
export class ResultsMerged extends Error {
  /** `pr_url` is the merged pull request. A local record can be without it: a recovered run, or a first publication that failed after the request was made. */
  constructor(id: string, readonly pr_url?: string) {
    super(`Results for ${id} were already merged; these artifacts differ. Preserve the merged result and publish a new run.`);
    this.name = "ResultsMerged";
  }
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function errorText(text: string): string {
  return redactText(text, environmentSecrets()).text.slice(-3000);
}

async function command(args: string[], cwd: string, allowFailure = false, env?: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0 && !allowFailure) throw new Error(`${args[0]} ${args[1]} failed (${code}): ${errorText(stderr || stdout)}`);
  return { code, stdout, stderr };
}

/**
 * `gh repo clone` gives its credentials to the clone only. The later commands in that checkout get them from the
 * same helper as in source.ts, for github.com only. Git never asks at the terminal: a missing credential is an error.
 */
function git(args: string[], cwd: string, allowFailure = false) {
  return command([
    "git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "credential.https://github.com.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential", ...args,
  ], cwd, allowFailure, { ...process.env, GIT_TERMINAL_PROMPT: "0" });
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}

async function files(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!safePath(path)) throw new Error(`Unsafe artifact path: ${path}`);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Cannot publish non-regular artifact: ${path}`);
  }
  return result.sort();
}

/** Existing repository contents, including directories, may be untrusted links. */
async function safeTarget(checkout: string, path: string): Promise<string> {
  if (!safePath(path)) throw new Error(`Unsafe publication path: ${path}`);
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const candidate = join(checkout, ...parts.slice(0, i));
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || (i < parts.length && !info.isDirectory())) throw new Error(`Unsafe repository path: ${path}`);
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  return join(checkout, path);
}

async function readOwnership(checkout: string, root: string, id: string): Promise<string[]> {
  const path = await safeTarget(checkout, `${root}/${OWNERSHIP}`);
  if (!await exists(path)) return [];
  const manifest: Ownership = JSON.parse(await readFile(path, "utf8"));
  if (manifest.schema !== "ultrafuzz.files.v1" || manifest.run_id !== id || !Array.isArray(manifest.files)
    || manifest.files.some((file) => typeof file !== "string" || !safePath(file) || file === OWNERSHIP))
    throw new Error("Existing publication ownership manifest is invalid");
  return [...new Set(manifest.files)];
}

async function applyArtifacts(checkout: string, root: string, id: string, artifacts: string): Promise<boolean> {
  const owned = new Set(await readOwnership(checkout, root, id));
  const incoming = (await files(artifacts)).filter((file) => file !== OWNERSHIP);
  const incomingSet = new Set(incoming);
  // Check all collisions before changing anything; external tools own all unlisted files.
  for (const file of incoming) {
    const destination = await safeTarget(checkout, `${root}/${file}`);
    if (await exists(destination) && !owned.has(file)) throw new Error(`Publication would overwrite an external file: ${root}/${file}`);
  }
  for (const file of owned) {
    if (incomingSet.has(file)) continue;
    const path = await safeTarget(checkout, `${root}/${file}`);
    if (await exists(path)) {
      if (!(await lstat(path)).isFile()) throw new Error(`Owned artifact is no longer a regular file: ${root}/${file}`);
      await rm(path);
    }
  }
  for (const file of incoming) {
    const destination = await safeTarget(checkout, `${root}/${file}`);
    if (await exists(destination) && !(await lstat(destination)).isFile()) throw new Error(`Artifact destination is not a file: ${root}/${file}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(artifacts, file)), { mode: 0o644 });
  }
  const manifest: Ownership = { schema: "ultrafuzz.files.v1", run_id: id, files: incoming };
  const manifestPath = await safeTarget(checkout, `${root}/${OWNERSHIP}`);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  // Add only the run subtree. Every untouched external file retains its bytes. `--force`: an ignore rule of the
  // results repository or of this machine must not leave a file of the package out of the commit without an error.
  await git(["add", "--force", "--", root], checkout);
  const diff = await git(["diff", "--cached", "--quiet"], checkout, true);
  if (diff.code > 1) throw new Error(`Cannot compare staged artifacts: ${errorText(diff.stderr)}`);
  return diff.code === 1;
}

async function pullRequests(repository: string, branch: string, cwd: string): Promise<PullRequest[]> {
  const response = await command(["gh", "pr", "list", "--repo", repository, "--head", branch, "--state", "all", "--limit", "100", "--json", "number,state,url,mergedAt,baseRefName"], cwd);
  return (JSON.parse(response.stdout) as PullRequest[]).sort((a, b) => b.number - a.number);
}

/** Publish an already-redacted bundle without force pushes or ownership of evaluator files. */
export async function publishRun(record: RunRecord, artifactDir: string, options: { cwd?: string } = {}): Promise<{ pr_url: string }> {
  const cwd = options.cwd ?? process.cwd();
  const repository = record.publication.repository;
  if (!repository) throw new Error("No results repository is recorded for this run. Set results_repository in ultrafuzz.toml and launch with --publish.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) throw new Error("Results repository must be owner/name");
  if (![record.id, record.label].every((value) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "..")) throw new Error("Unsafe run id or label");
  const branch = `ultrafuzz/${record.id}`, root = `attempts/${record.label}/runs/${record.id}`;
  if (record.publication.branch !== branch || record.publication.path !== root) throw new Error("Publication branch or directory does not match the run identity");
  const info = JSON.parse((await command(["gh", "repo", "view", repository, "--json", "isPrivate,defaultBranchRef"], cwd)).stdout);
  if (info.isPrivate !== true) throw new Error("Results repository must be private");
  if (typeof info.defaultBranchRef?.name !== "string" || !info.defaultBranchRef.name) throw new Error("Results repository must have an initialized default branch");
  const artifacts = resolve(artifactDir);
  if ((await lstat(artifacts)).isSymbolicLink()) throw new Error("Artifact directory cannot be a symbolic link");
  const temporary = await mkdtemp(join(tmpdir(), "ultrafuzz-publish-"));
  const checkout = join(temporary, "repository");
  try {
    await command(["gh", "repo", "clone", repository, checkout, "--", "--no-checkout", "--filter=blob:none"], cwd);
    let published = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const prs = await pullRequests(repository, branch, cwd);
      const pr = prs[0];
      const merged = !!pr && (pr.state === "MERGED" || !!pr.mergedAt);
      const remote = await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], checkout);
      const ref = merged ? (pr.baseRefName || info.defaultBranchRef.name)
        : remote.stdout.trim() ? branch : pr ? `refs/pull/${pr.number}/head` : info.defaultBranchRef.name;
      await git(["fetch", "--no-tags", "origin", ref], checkout);
      // Only the directory of this run is read or written, so only that directory is checked out: the cost of a
      // publication does not grow with the runs that the repository already holds. An older git that cannot do
      // this checks out the whole tree, as before.
      if ((await git(["sparse-checkout", "set", "--cone", root], checkout, true)).code !== 0) await git(["sparse-checkout", "disable"], checkout, true);
      await git(["checkout", "--detach", "--force", "FETCH_HEAD"], checkout);
      const changed = await applyArtifacts(checkout, root, record.id, artifacts);
      if (merged) {
        if (changed) throw new ResultsMerged(record.id, pr.url);
        return { pr_url: pr.url };
      }
      if (changed) {
        await git(["-c", "user.name=Ultrafuzz", "-c", "user.email=ultrafuzz@localhost", "commit", "-m", `Collect run ${record.id}`], checkout);
        const push = await git(["push", "origin", `HEAD:refs/heads/${branch}`], checkout, true);
        if (push.code !== 0) {
          if (/(non-fast-forward|fetch first|stale info|cannot lock ref|\[rejected\])/.test(push.stderr) && attempt < 2) continue;
          throw new Error(`Result publication push failed: ${errorText(push.stderr || push.stdout)}`);
        }
      }
      published = true;
      break;
    }
    if (!published) throw new Error("Results branch changed repeatedly; collection can be retried");
    let pr = (await pullRequests(repository, branch, cwd))[0];
    if (pr?.state === "MERGED" || pr?.mergedAt) throw new Error("Results PR was merged during publication; recollect to verify the merged artifacts");
    if (pr?.state === "CLOSED") {
      await command(["gh", "pr", "reopen", String(pr.number), "--repo", repository], cwd);
      return { pr_url: pr.url };
    }
    if (pr) return { pr_url: pr.url };
    const body = join(temporary, "body.md");
    await writeFile(body, `Results for run \`${record.id}\`, grouped under \`${record.label}\`.\n\nThe run record, report, prompt, usage and retained evidence are in \`${root}/\`. External evaluation files can be added alongside them.\n`);
    const creation = await command(["gh", "pr", "create", "--repo", repository, "--head", branch, "--base", info.defaultBranchRef.name, "--title", `Run ${record.id}: ${record.label}`, "--body-file", body], cwd, true);
    // Another collector may have created the PR after the previous lookup.
    pr = (await pullRequests(repository, branch, cwd))[0];
    if (pr) return { pr_url: pr.url };
    if (creation.code !== 0) throw new Error(`Result PR creation failed: ${errorText(creation.stderr || creation.stdout)}`);
    const url = creation.stdout.trim();
    if (!/^https:\/\/[^\s]+\/pull\/\d+$/.test(url)) throw new Error("GitHub did not return a result PR URL; retry collection to look it up");
    return { pr_url: url };
  } catch (error) {
    // The caller must know this answer from every other failure. Its text holds only the run ID.
    if (error instanceof ResultsMerged) throw error;
    throw new Error(errorText(error instanceof Error ? error.message : String(error)));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
