import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION = "ultrafuzz.eval-history-publication-generation.v1";

const TARGET_BRANCH = "main";
const TARGET_REF = `refs/heads/${TARGET_BRANCH}`;
const TARGET_REMOTE_REF = `refs/remotes/origin/${TARGET_BRANCH}`;
const MAX_ATTEMPTS = 12;
const MAX_GENERATION_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const COMMIT_MESSAGE = "Update published eval history";
const COMMIT_AUTHOR_NAME = "ultrafuzz-eval-history-publisher[bot]";
const COMMIT_AUTHOR_EMAIL = "308007741+ultrafuzz-eval-history-publisher[bot]@users.noreply.github.com";
const HISTORY_PATHS = [
  "benchmarks/history.json",
  "docs/assets/eval-history/latest-summary.svg",
  "docs/assets/eval-history/quality.svg",
  "docs/assets/eval-history/precision.svg",
  "docs/assets/eval-history/recall.svg",
  "docs/assets/eval-history/f1.svg",
  "docs/assets/eval-history/cumulative-unique-true-positives.svg",
  "docs/assets/eval-history/wall-clock-time.svg",
  "docs/assets/eval-history/cost.svg"
];

export function parseEvalHistoryPublicationGeneration(value) {
  const generation = strictRecord(value, "publication generation", [
    "schema_version",
    "candidate_commit",
    "candidate_repository_url",
    "source_artifact",
    "runs"
  ]);
  if (generation.schema_version !== EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION) {
    throw new Error(
      `publication generation schema_version must be ${EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION}`
    );
  }
  const candidateCommit = fullCommit(generation.candidate_commit, "publication candidate commit");
  const candidateRepositoryUrl = canonicalGitHubRepositoryUrl(generation.candidate_repository_url);
  const sourceArtifact = canonicalGitHubActionsRunUrl(generation.source_artifact, candidateRepositoryUrl);
  if (!Array.isArray(generation.runs) || generation.runs.length === 0 || generation.runs.length > 64) {
    throw new Error("publication generation runs must contain between 1 and 64 entries");
  }
  const ids = new Set();
  const inputPaths = new Set();
  const runs = generation.runs.map((value, index) => {
    const run = strictRecord(
      value,
      `publication run ${index}`,
      ["eval_run_id", "benchmark", "lane", "input_path"],
      ["status", "target_ids", "executed_case_count", "graded_case_count", "publication_url"]
    );
    const evalRunId = safeId(run.eval_run_id, `publication run ${index} eval_run_id`);
    if (ids.has(evalRunId)) throw new Error(`publication generation repeats eval run ${evalRunId}`);
    ids.add(evalRunId);
    if (run.benchmark !== "evmbench" && run.benchmark !== "ultrafuzz-bench") {
      throw new Error(`publication run ${evalRunId} benchmark must be evmbench or ultrafuzz-bench`);
    }
    if (run.lane !== "smoke" && run.lane !== "full") {
      throw new Error(`publication run ${evalRunId} lane must be smoke or full`);
    }
    const inputPath = canonicalRelativePath(run.input_path, `publication run ${evalRunId} input_path`);
    if (inputPaths.has(inputPath)) throw new Error(`publication generation repeats input path ${inputPath}`);
    inputPaths.add(inputPath);
    const targetIds = run.target_ids === undefined ? undefined : targetIdsForPublicationRun(run.target_ids, evalRunId);
    const status = run.status === undefined ? undefined : publicationStatus(run.status, evalRunId);
    const executedCaseCount =
      run.executed_case_count === undefined
        ? undefined
        : positiveSafeInteger(run.executed_case_count, `publication run ${evalRunId} executed_case_count`);
    const gradedCaseCount =
      run.graded_case_count === undefined
        ? undefined
        : positiveSafeInteger(run.graded_case_count, `publication run ${evalRunId} graded_case_count`);
    if (
      executedCaseCount !== undefined &&
      gradedCaseCount !== undefined &&
      (gradedCaseCount > executedCaseCount ||
        (targetIds !== undefined && (targetIds.length > executedCaseCount || targetIds.length > gradedCaseCount)))
    ) {
      throw new Error(`publication run ${evalRunId} case counts do not cover its target set`);
    }
    const publicationUrl =
      run.publication_url === undefined
        ? sourceArtifact
        : canonicalGitHubActionsPublicationUrl(run.publication_url, candidateRepositoryUrl, sourceArtifact);
    return {
      eval_run_id: evalRunId,
      benchmark: run.benchmark,
      lane: run.lane,
      input_path: inputPath,
      ...(status === undefined ? {} : { status }),
      ...(targetIds === undefined ? {} : { target_ids: targetIds }),
      ...(executedCaseCount === undefined ? {} : { executed_case_count: executedCaseCount }),
      ...(gradedCaseCount === undefined ? {} : { graded_case_count: gradedCaseCount }),
      publication_url: publicationUrl
    };
  });
  return {
    schema_version: EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION,
    candidate_commit: candidateCommit,
    candidate_repository_url: candidateRepositoryUrl,
    source_artifact: sourceArtifact,
    runs
  };
}

export function publishEvalHistoryGeneration(input) {
  const generationPath = regularFilePath(input.generationPath, "publication generation JSON");
  const generation = parseEvalHistoryPublicationGeneration(readGeneration(generationPath));
  const inputRoot = realDirectory(input.inputRoot, "publication input root");
  const repositoryRoot = gitRepositoryRoot(input.repositoryRoot ?? process.cwd());
  const benchmarkPolicyRoot = gitRepositoryRoot(input.benchmarkPolicyRoot ?? repositoryRoot);
  if (gitOutput(benchmarkPolicyRoot, ["rev-parse", "HEAD"]) !== generation.candidate_commit) {
    throw new Error("publication checkout does not match the candidate commit");
  }
  if (gitOutput(benchmarkPolicyRoot, ["status", "--porcelain=v1", "--untracked-files=no"]) !== "") {
    throw new Error("publication candidate checkout has tracked modifications");
  }
  if (gitOutput(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=no"]) !== "") {
    throw new Error("publication tooling checkout has tracked modifications");
  }
  const cliPath = regularFilePath(
    path.join(repositoryRoot, "packages", "cli", "dist", "index.js"),
    "built Ultrafuzz CLI"
  );
  checked("git", ["remote", "get-url", "origin"], { cwd: repositoryRoot });

  const temporaryParent = fs.realpathSync(os.tmpdir());
  const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "ultrafuzz-eval-history-publish-"));
  assertSafeTemporaryRoot(temporaryRoot);
  let activeWorktree;
  try {
    const snapshotRoot = path.join(temporaryRoot, "input-snapshot");
    fs.mkdirSync(snapshotRoot, { recursive: false, mode: 0o700 });
    const snapshots = snapshotGenerationInputs(generation, inputRoot, snapshotRoot);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const base = refreshRemoteBase(repositoryRoot);
      const worktree = path.join(temporaryRoot, `worktree-${attempt}`);
      checked("git", ["worktree", "add", "--detach", worktree, base.ref], { cwd: repositoryRoot });
      activeWorktree = worktree;
      try {
        installRunSnapshots(snapshots, worktree);
        appendGenerationWithCli(generation, worktree, cliPath, benchmarkPolicyRoot);
        const stagedPaths = stageExactPublication(worktree);
        let commit = base.oid;
        let createdCommit = false;
        if (stagedPaths.length > 0) {
          commit = createPublicationCommit(worktree, base.oid, generation);
          createdCommit = true;
        }
        const needsPush = createdCommit;

        if (!needsPush) {
          const latest = refreshRemoteBase(repositoryRoot);
          if (!sameRemoteState(base, latest)) {
            reportRetry(attempt, "a remote tip advanced during an idempotent rebuild");
            continue;
          }
          return publicationResult(generation, latest.oid, attempt, false);
        }

        const push = run("git", ["push", "origin", `HEAD:${TARGET_REF}`], { cwd: worktree });
        if (push.status === 0) {
          const published = refreshRemoteBase(repositoryRoot);
          if (!isAncestor(repositoryRoot, commit, published.oid)) {
            throw new Error(`pushed commit ${commit} is not present on origin/${TARGET_BRANCH}`);
          }
          return publicationResult(generation, commit, attempt, true);
        }

        const latest = refreshRemoteBase(repositoryRoot);
        if (!sameRemoteState(base, latest)) {
          reportRetry(attempt, "the publication push lost a remote-tip race");
          continue;
        }
        throw processFailure("git", ["push", "origin", `HEAD:${TARGET_REF}`], push);
      } finally {
        removeWorktree(repositoryRoot, activeWorktree, temporaryRoot);
        activeWorktree = undefined;
      }
    }
    throw new Error(`origin/${TARGET_BRANCH} kept advancing after ${MAX_ATTEMPTS} publication attempts`);
  } finally {
    removeWorktree(repositoryRoot, activeWorktree, temporaryRoot);
    safeRemoveTemporaryRoot(temporaryRoot);
    run("git", ["worktree", "prune"], { cwd: repositoryRoot });
  }
}

function snapshotGenerationInputs(generation, inputRoot, snapshotRoot) {
  return generation.runs.map((run) => {
    const source = sourceDirectory(inputRoot, run.input_path, run.eval_run_id);
    validateEvalRunIdentity(source, run.eval_run_id, generation.candidate_commit);
    validateTree(source, `eval run ${run.eval_run_id}`);
    const snapshot = path.join(snapshotRoot, run.eval_run_id);
    copyTree(source, snapshot);
    validateEvalRunIdentity(snapshot, run.eval_run_id, generation.candidate_commit);
    return { run, snapshot };
  });
}

function installRunSnapshots(snapshots, worktree) {
  const runsRoot = path.join(worktree, ".ultrafuzz", "evals", "runs");
  fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  for (const { run, snapshot } of snapshots) {
    const destination = path.join(runsRoot, run.eval_run_id);
    if (fs.existsSync(destination))
      throw new Error(`temporary eval run destination already exists: ${run.eval_run_id}`);
    copyTree(snapshot, destination);
  }
}

function appendGenerationWithCli(generation, worktree, cliPath, benchmarkPolicyRoot) {
  for (const run of generation.runs) {
    checked(
      "node",
      [
        cliPath,
        "eval",
        "history",
        run.eval_run_id,
        "--project",
        worktree,
        "--benchmark",
        run.benchmark,
        "--lane",
        run.lane,
        "--repository",
        generation.candidate_repository_url,
        "--artifact",
        generation.source_artifact,
        "--publication-url",
        run.publication_url,
        "--benchmark-policy-root",
        benchmarkPolicyRoot
      ],
      { cwd: worktree }
    );
  }
  checked("node", [cliPath, "eval", "history", "--project", worktree, "--check"], { cwd: worktree });
}

function stageExactPublication(worktree) {
  for (const relative of HISTORY_PATHS)
    regularFilePath(path.join(worktree, relative), `publication output ${relative}`);
  checked("git", ["add", "--", ...HISTORY_PATHS], { cwd: worktree });
  checked("git", ["diff", "--cached", "--check"], { cwd: worktree });
  const staged = nulPaths(gitOutput(worktree, ["diff", "--cached", "--name-only", "-z"]));
  assertAllowedPaths(staged, "staged publication");
  const unstagedTracked = nulPaths(gitOutput(worktree, ["diff", "--name-only", "-z"]));
  if (unstagedTracked.length > 0) {
    throw new Error(`eval history CLI changed unexpected tracked paths: ${unstagedTracked.join(", ")}`);
  }
  return staged;
}

function createPublicationCommit(worktree, parent, generation) {
  checked(
    "git",
    [
      "-c",
      `user.name=${COMMIT_AUTHOR_NAME}`,
      "-c",
      `user.email=${COMMIT_AUTHOR_EMAIL}`,
      "commit",
      "--no-verify",
      "-m",
      COMMIT_MESSAGE,
      "-m",
      `Source-Workflow-Run: ${generation.source_artifact}\nCandidate-Commit: ${generation.candidate_commit}`,
      "--",
      ...HISTORY_PATHS
    ],
    { cwd: worktree }
  );
  const commit = gitOutput(worktree, ["rev-parse", "HEAD"]);
  assertCommitContainsOnly(worktree, parent, commit, false);
  return commit;
}

function assertCommitContainsOnly(worktree, parent, commit, allowEmpty) {
  const committed = nulPaths(gitOutput(worktree, ["diff", "--name-only", "-z", parent, commit]));
  if (!allowEmpty && committed.length === 0) throw new Error("publication commit contains no files");
  assertAllowedPaths(committed, "publication commit");
}

function assertAllowedPaths(paths, label) {
  const allowed = new Set(HISTORY_PATHS);
  const unexpected = paths.filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0) {
    throw new Error(
      `${label} contains unexpected paths: ${unexpected.map((entry) => JSON.stringify(entry)).join(", ")}`
    );
  }
}

function refreshRemoteBase(repositoryRoot) {
  checked("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
    cwd: repositoryRoot
  });
  const oid = gitOutput(repositoryRoot, ["rev-parse", TARGET_REMOTE_REF]);
  return { ref: TARGET_REMOTE_REF, oid };
}

function sameRemoteState(left, right) {
  return left.oid === right.oid;
}

function isAncestor(repositoryRoot, ancestor, descendant) {
  const result = run("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repositoryRoot });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw processFailure("git", ["merge-base", "--is-ancestor", ancestor, descendant], result);
}

function publicationResult(generation, commit, attempts, published) {
  return {
    branch: TARGET_BRANCH,
    commit,
    attempts,
    published,
    eval_run_ids: generation.runs.map((run) => run.eval_run_id)
  };
}

function sourceDirectory(inputRoot, relative, evalRunId) {
  let current = inputRoot;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) throw new Error(`input path for eval run ${evalRunId} does not exist: ${relative}`);
    if (stat.isSymbolicLink()) throw new Error(`input path for eval run ${evalRunId} contains a symbolic link`);
  }
  const resolved = fs.realpathSync(current);
  if (!inside(inputRoot, resolved)) throw new Error(`input path for eval run ${evalRunId} escapes the input root`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory()) throw new Error(`input path for eval run ${evalRunId} is not a directory`);
  return resolved;
}

function validateEvalRunIdentity(root, evalRunId, candidateCommit) {
  const manifestPath = regularFilePath(path.join(root, "eval.json"), `eval manifest for ${evalRunId}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`eval manifest for ${evalRunId} is not valid JSON`, { cause: error });
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(`eval manifest for ${evalRunId} must be an object`);
  }
  if (manifest.eval_run_id !== evalRunId) throw new Error(`eval manifest ID does not match ${evalRunId}`);
  if (manifest.provenance?.candidate?.commit !== candidateCommit) {
    throw new Error(`eval manifest candidate commit does not match publication generation for ${evalRunId}`);
  }
}

function validateTree(root, label) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${entry.name}`);
    if (stat.isDirectory()) validateTree(entryPath, label);
    else if (!stat.isFile()) throw new Error(`${label} contains a non-regular file: ${entry.name}`);
  }
}

function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory()) throw new Error(`copy source is not a directory: ${source}`);
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const entry of fs
    .readdirSync(source, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const entryStat = fs.lstatSync(sourcePath);
    if (entryStat.isSymbolicLink()) throw new Error(`copy source contains a symbolic link: ${sourcePath}`);
    if (entryStat.isDirectory()) copyTree(sourcePath, destinationPath);
    else if (entryStat.isFile()) fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    else throw new Error(`copy source contains a non-regular file: ${sourcePath}`);
  }
}

function canonicalGitHubRepositoryUrl(value) {
  const text = requiredString(value, "candidate_repository_url");
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new Error("candidate_repository_url must be a valid URL", { cause: error });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    parts.length !== 2 ||
    !SAFE_ID.test(parts[0]) ||
    !SAFE_ID.test(parts[1])
  ) {
    throw new Error("candidate_repository_url must be a canonical public GitHub repository URL");
  }
  const canonical = `https://github.com/${parts[0]}/${parts[1]}`;
  if (text !== canonical && text !== `${canonical}/`) {
    throw new Error("candidate_repository_url must be a canonical public GitHub repository URL");
  }
  return canonical;
}

function canonicalGitHubActionsRunUrl(value, repositoryUrl) {
  const text = requiredString(value, "source_artifact");
  const escaped = repositoryUrl.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`^${escaped}/actions/runs/[1-9][0-9]*$`, "u").test(text)) {
    throw new Error("source_artifact must be a canonical GitHub Actions run URL for candidate_repository_url");
  }
  return text;
}

function canonicalGitHubActionsPublicationUrl(value, repositoryUrl, sourceArtifact) {
  const text = requiredString(value, "publication_url");
  const escapedRepository = repositoryUrl.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedRun = sourceArtifact.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (
    !new RegExp(
      `^(?:${escapedRun}|${escapedRun}/artifacts|${escapedRepository}/actions/runs/[1-9][0-9]*/artifacts)$`,
      "u"
    ).test(text)
  ) {
    throw new Error("publication_url must be a canonical GitHub Actions run or artifact URL");
  }
  return text;
}

function canonicalRelativePath(value, label) {
  const text = requiredString(value, label);
  if (text.length > 512 || text.includes("\\") || path.posix.isAbsolute(text) || path.win32.isAbsolute(text)) {
    throw new Error(`${label} must be a canonical relative POSIX path`);
  }
  const parts = text.split("/");
  if (parts.some((part) => !SAFE_ID.test(part))) {
    throw new Error(`${label} must contain only safe path segments`);
  }
  return parts.join("/");
}

function targetIdsForPublicationRun(value, evalRunId) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_048) {
    throw new Error(`publication run ${evalRunId} target_ids must be a non-empty array`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const id = safeId(entry, `publication run ${evalRunId} target_ids ${index}`);
    if (seen.has(id)) throw new Error(`publication run ${evalRunId} repeats target ${id}`);
    seen.add(id);
    return id;
  });
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function publicationStatus(value, evalRunId) {
  if (value !== "succeeded" && value !== "genuine-task-failures" && value !== "failed") {
    throw new Error(`publication run ${evalRunId} status is invalid`);
  }
  return value;
}

function strictRecord(value, label, keys, optionalKeys = []) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const allowed = new Set([...keys, ...optionalKeys]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unexpected fields: ${unexpected.join(", ")}`);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}`);
  }
  return value;
}

function safeId(value, label) {
  const id = requiredString(value, label);
  if (!SAFE_ID.test(id)) throw new Error(`${label} is not a safe ID`);
  return id;
}

function fullCommit(value, label) {
  const commit = requiredString(value, label);
  if (!FULL_COMMIT.test(commit)) throw new Error(`${label} must be a full lowercase commit SHA`);
  return commit;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function readGeneration(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_GENERATION_BYTES) throw new Error("publication generation JSON is too large");
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read publication generation JSON ${filePath}`, { cause: error });
  }
}

function gitRepositoryRoot(cwd) {
  const root = gitOutput(path.resolve(cwd), ["rev-parse", "--show-toplevel"]);
  return fs.realpathSync(root);
}

function realDirectory(value, label) {
  const resolved = fs.realpathSync(path.resolve(requiredString(value, label)));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
}

function regularFilePath(value, label) {
  const resolved = path.resolve(requiredString(value, label));
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return resolved;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function nulPaths(value) {
  return value.split("\0").filter((entry) => entry !== "");
}

function gitOutput(cwd, args) {
  return checked("git", args, { cwd }).stdout.trim();
}

function checked(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) throw processFailure(command, args, result);
  return result;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function processFailure(command, args, result) {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return new Error(
    `${command} ${args.join(" ")} failed with exit ${result.status}${detail === "" ? "" : `:\n${detail}`}`
  );
}

function removeWorktree(repositoryRoot, worktree, temporaryRoot) {
  if (worktree === undefined) return;
  const resolved = path.resolve(worktree);
  if (
    path.dirname(resolved) !== path.resolve(temporaryRoot) ||
    !/^worktree-[1-9][0-9]*$/u.test(path.basename(resolved))
  )
    throw new Error(`refusing to remove unsafe worktree path ${resolved}`);
  const result = run("git", ["worktree", "remove", "--force", resolved], { cwd: repositoryRoot });
  if (result.status !== 0 && fs.existsSync(resolved)) {
    process.stderr.write(`warning: failed to unregister temporary worktree ${resolved}: ${result.stderr.trim()}\n`);
  }
}

function assertSafeTemporaryRoot(temporaryRoot) {
  const resolved = path.resolve(temporaryRoot);
  const parent = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("ultrafuzz-eval-history-publish-")) {
    throw new Error(`unsafe publication temporary root ${resolved}`);
  }
}

function safeRemoveTemporaryRoot(temporaryRoot) {
  assertSafeTemporaryRoot(temporaryRoot);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function reportRetry(attempt, reason) {
  process.stderr.write(`Eval history CAS attempt ${attempt} will rebuild because ${reason}.\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const [generationPath, inputRoot, benchmarkPolicyRoot, ...extra] = [command, ...args];
  if (generationPath === undefined || inputRoot === undefined || extra.length > 0) {
    throw new Error("usage: publish-eval-history-cas.mjs <generation.json> <input-root> [benchmark-policy-root]");
  }
  const result = publishEvalHistoryGeneration({
    generationPath,
    inputRoot,
    ...(benchmarkPolicyRoot === undefined ? {} : { benchmarkPolicyRoot })
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
