import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION = "ultrafuzz.eval-history-publication-generation.v2";

const TARGET_BRANCH = "main";
const TARGET_REF = `refs/heads/${TARGET_BRANCH}`;
const TARGET_REMOTE_REF = `refs/remotes/origin/${TARGET_BRANCH}`;
const MAX_ATTEMPTS = 12;
const MAX_GENERATION_BYTES = 1024 * 1024;
const MAX_PUBLICATION_TREE_BYTES = 256 * 1024 * 1024;
const HANDOFF_GENERATION_FILE = "generation.json";
const HANDOFF_INPUT_DIRECTORY = "unpacked";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_OBSERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const COMMIT_MESSAGE = "Update published eval history";
const COMMIT_AUTHOR_NAME = "ultrafuzz-eval-history-publisher[bot]";
const COMMIT_AUTHOR_EMAIL = "308007741+ultrafuzz-eval-history-publisher[bot]@users.noreply.github.com";
const HISTORY_PATHS = [
  "benchmarks/history.json",
  "docs/assets/eval-history/latest-summary.svg",
  "docs/assets/eval-history/quality.svg",
  "docs/assets/eval-history/performance-cost.svg",
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
    const run = strictRecord(value, `publication run ${index}`, [
      "eval_run_id",
      "benchmark",
      "lane",
      "status",
      "input_path",
      "bundle_sha256",
      "publication_tree_sha256",
      "target_ids",
      "observation_ids",
      "executed_case_count",
      "graded_case_count",
      "publication_url"
    ]);
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
    if (
      [...inputPaths].some(
        (existing) =>
          inputPath === existing || inputPath.startsWith(`${existing}/`) || existing.startsWith(`${inputPath}/`)
      )
    ) {
      throw new Error(`publication generation repeats or overlaps input path ${inputPath}`);
    }
    inputPaths.add(inputPath);
    const targetIds = targetIdsForPublicationRun(run.target_ids, evalRunId);
    const observationIds = observationIdsForPublicationRun(run.observation_ids, evalRunId);
    const status = publicationStatus(run.status, evalRunId);
    const executedCaseCount = positiveSafeInteger(
      run.executed_case_count,
      `publication run ${evalRunId} executed_case_count`
    );
    const gradedCaseCount = positiveSafeInteger(
      run.graded_case_count,
      `publication run ${evalRunId} graded_case_count`
    );
    const bundleSha256 = sha256Value(run.bundle_sha256, `publication run ${evalRunId} bundle_sha256`);
    const publicationTreeSha256 = sha256Value(
      run.publication_tree_sha256,
      `publication run ${evalRunId} publication_tree_sha256`
    );
    if (
      gradedCaseCount > executedCaseCount ||
      targetIds.length !== observationIds.length ||
      targetIds.length > executedCaseCount ||
      targetIds.length > gradedCaseCount
    ) {
      throw new Error(`publication run ${evalRunId} observation and case counts do not cover its target set`);
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
      status,
      bundle_sha256: bundleSha256,
      publication_tree_sha256: publicationTreeSha256,
      target_ids: targetIds,
      observation_ids: observationIds,
      executed_case_count: executedCaseCount,
      graded_case_count: gradedCaseCount,
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

export function validateEvalHistoryPublicationHandoff(input) {
  const handoffRoot = regularDirectoryPath(input.handoffRoot, "publication handoff root");
  assertExactDirectoryEntries(handoffRoot, [HANDOFF_GENERATION_FILE, HANDOFF_INPUT_DIRECTORY], "publication handoff");
  const generationPath = regularFilePath(
    path.join(handoffRoot, HANDOFF_GENERATION_FILE),
    "publication handoff generation JSON"
  );
  const inputRoot = regularDirectoryPath(
    path.join(handoffRoot, HANDOFF_INPUT_DIRECTORY),
    "publication handoff input root"
  );
  const generation = readAndParseGeneration(generationPath, input.expectedGenerationSha256);
  if (
    input.expectedCandidateCommit !== undefined &&
    generation.candidate_commit !== fullCommit(input.expectedCandidateCommit, "expected publication candidate commit")
  ) {
    throw new Error("publication handoff candidate commit does not match the trusted workflow output");
  }
  if (
    input.expectedRepositoryUrl !== undefined &&
    generation.candidate_repository_url !== canonicalGitHubRepositoryUrl(input.expectedRepositoryUrl)
  ) {
    throw new Error("publication handoff repository does not match the current workflow repository");
  }
  assertExactGenerationInputLayout(generation, inputRoot);
  validateGenerationInputs(generation, inputRoot);
  return {
    schema_version: generation.schema_version,
    candidate_commit: generation.candidate_commit,
    eval_run_ids: generation.runs.map((run) => run.eval_run_id)
  };
}

export function publishEvalHistoryGeneration(input) {
  const generationPath = regularFilePath(input.generationPath, "publication generation JSON");
  const generation = readAndParseGeneration(generationPath, input.expectedGenerationSha256);
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
  const toolingCommit = gitOutput(repositoryRoot, ["rev-parse", "HEAD"]);
  const cliPath = regularFilePath(
    path.join(repositoryRoot, "packages", "cli", "dist", "index.js"),
    "built Ultrafuzz CLI"
  );
  const publicationRemote = resolvePublicationRemote(
    repositoryRoot,
    generation.candidate_repository_url,
    input.testOnlyPublicationRemoteUrl
  );
  if (!publicationRemote.testOnly && publisherTokenValue(input.publisherToken) === undefined) {
    throw new Error("canonical GitHub publication requires a publisher token");
  }
  assertSafePublicationTransport(repositoryRoot, publicationRemote.originUrl);
  const publisherTransportEnvironment = publisherGitEnvironment(input.publisherToken, publicationRemote.testOnly);
  const publisherTransportRedactions = publisherAuthorityRedactions(input.publisherToken);

  const temporaryParent = fs.realpathSync(os.tmpdir());
  const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "ultrafuzz-eval-history-publish-"));
  assertSafeTemporaryRoot(temporaryRoot);
  let activeWorktree;
  try {
    const snapshotRoot = path.join(temporaryRoot, "input-snapshot");
    fs.mkdirSync(snapshotRoot, { recursive: false, mode: 0o700 });
    const snapshots = snapshotGenerationInputs(generation, inputRoot, snapshotRoot);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const base = refreshCompatibleRemoteBase(
        repositoryRoot,
        publicationRemote.pushUrl,
        publisherTransportEnvironment,
        publisherTransportRedactions,
        toolingCommit
      );
      const worktree = path.join(temporaryRoot, `worktree-${attempt}`);
      checked("git", ["worktree", "add", "--detach", worktree, base.ref], { cwd: repositoryRoot });
      activeWorktree = worktree;
      try {
        installRunSnapshots(snapshots, worktree);
        const historyBefore = readPublicationHistory(worktree);
        appendGenerationWithCli(generation, worktree, cliPath, benchmarkPolicyRoot);
        const publicationKind = assertExactAutomaticPublicationDelta(
          generation,
          historyBefore,
          readPublicationHistory(worktree)
        );
        const stagedPaths = stageExactPublication(worktree, publicationKind);
        let commit = base.oid;
        let createdCommit = false;
        if (stagedPaths.length > 0) {
          commit = createPublicationCommit(worktree, base.oid, generation);
          createdCommit = true;
        }
        const needsPush = createdCommit;

        if (!needsPush) {
          const latest = refreshCompatibleRemoteBase(
            repositoryRoot,
            publicationRemote.pushUrl,
            publisherTransportEnvironment,
            publisherTransportRedactions,
            toolingCommit
          );
          if (!sameRemoteState(base, latest)) {
            reportRetry(attempt, "a remote tip advanced during an idempotent rebuild");
            continue;
          }
          return publicationResult(generation, latest.oid, attempt, false);
        }

        assertSafePublicationTransport(repositoryRoot, publicationRemote.originUrl, worktree);
        const pushArgs = ["push", "--no-verify", publicationRemote.pushUrl, `HEAD:${TARGET_REF}`];
        const push = run("git", pushArgs, {
          cwd: worktree,
          env: publisherTransportEnvironment,
          redact: publisherTransportRedactions
        });
        if (push.status === 0) {
          const published = refreshCompatibleRemoteBase(
            repositoryRoot,
            publicationRemote.pushUrl,
            publisherTransportEnvironment,
            publisherTransportRedactions,
            toolingCommit
          );
          if (!isAncestor(repositoryRoot, commit, published.oid)) {
            throw new Error(`pushed commit ${commit} is not present on origin/${TARGET_BRANCH}`);
          }
          return publicationResult(generation, commit, attempt, true);
        }

        const latest = refreshCompatibleRemoteBase(
          repositoryRoot,
          publicationRemote.pushUrl,
          publisherTransportEnvironment,
          publisherTransportRedactions,
          toolingCommit
        );
        if (!sameRemoteState(base, latest)) {
          reportRetry(attempt, "the publication push lost a remote-tip race");
          continue;
        }
        throw processFailure("git", pushArgs, push);
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
  return validateGenerationInputs(generation, inputRoot).map(({ run, source }) => {
    const snapshot = path.join(snapshotRoot, run.eval_run_id);
    copyTree(source, snapshot);
    assertPublicationTreeDigest(snapshot, run.publication_tree_sha256, run.eval_run_id);
    validateEvalRunIdentity(path.join(snapshot, "eval"), run.eval_run_id, generation.candidate_commit);
    return { run, snapshot };
  });
}

function validateGenerationInputs(generation, inputRoot) {
  return generation.runs.map((run) => {
    const source = sourceDirectory(inputRoot, run.input_path, run.eval_run_id);
    validateTree(source, `publication tree for eval run ${run.eval_run_id}`);
    assertPublicationTreeDigest(source, run.publication_tree_sha256, run.eval_run_id);
    validateEvalRunIdentity(path.join(source, "eval"), run.eval_run_id, generation.candidate_commit);
    return { run, source };
  });
}

function installRunSnapshots(snapshots, worktree) {
  const runsRoot = path.join(worktree, ".ultrafuzz", "evals", "runs");
  fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  for (const { run, snapshot } of snapshots) {
    const destination = path.join(runsRoot, run.eval_run_id);
    if (fs.existsSync(destination))
      throw new Error(`temporary eval run destination already exists: ${run.eval_run_id}`);
    copyTree(path.join(snapshot, "eval"), destination);
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

function stageExactPublication(worktree, publicationKind) {
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
  const expected = publicationKind === "first" ? HISTORY_PATHS : [];
  if (!samePathSet(staged, expected)) {
    throw new Error(
      publicationKind === "first"
        ? `first automatic publication must change history and all nine charts; changed: ${staged.join(", ")}`
        : `automatic publication replay must be a true zero-change rebuild; changed: ${staged.join(", ")}`
    );
  }
  return staged;
}

function readPublicationHistory(worktree) {
  const historyPath = regularFilePath(path.join(worktree, HISTORY_PATHS[0]), "publication history JSON");
  let history;
  try {
    history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  } catch (error) {
    throw new Error("publication history is not valid JSON", { cause: error });
  }
  if (
    typeof history !== "object" ||
    history === null ||
    Array.isArray(history) ||
    !Array.isArray(history.observations)
  ) {
    throw new Error("publication history must contain an observations array");
  }
  return history.observations.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`publication history observation ${index} must be an object`);
    }
    return value;
  });
}

function assertExactAutomaticPublicationDelta(generation, before, after) {
  const expectedById = new Map();
  const expectedRunIds = new Set(generation.runs.map((run) => run.eval_run_id));
  for (const run of generation.runs) {
    for (const [index, observationId] of run.observation_ids.entries()) {
      if (expectedById.has(observationId)) {
        throw new Error(`publication generation repeats observation ID ${observationId}`);
      }
      expectedById.set(observationId, { run, targetId: run.target_ids[index] });
    }
  }
  const beforeById = observationsById(before, "base publication history");
  const afterById = observationsById(after, "generated publication history");
  const beforeExpected = [...expectedById.keys()].filter((id) => beforeById.has(id));
  const relatedBefore = before.filter((observation) => expectedRunIds.has(observation.source_eval_run_id));
  if (
    relatedBefore.length !== beforeExpected.length ||
    (beforeExpected.length !== 0 && beforeExpected.length !== expectedById.size)
  ) {
    throw new Error("automatic publication base contains a partial or foreign observation set for this generation");
  }

  for (const [id, canonicalBefore] of beforeById) {
    const current = afterById.get(id);
    if (current === undefined || stableJson(current) !== stableJson(canonicalBefore)) {
      throw new Error(`automatic publication modified or removed existing observation ${id}`);
    }
  }

  const relatedAfter = after.filter((observation) => expectedRunIds.has(observation.source_eval_run_id));
  if (relatedAfter.length !== expectedById.size) {
    throw new Error("automatic publication produced an incomplete or foreign observation set");
  }
  for (const [observationId, expected] of expectedById) {
    const observation = afterById.get(observationId);
    if (observation === undefined) {
      throw new Error(`automatic publication did not produce expected observation ${observationId}`);
    }
    assertAutomaticObservationMetadata(observation, observationId, expected, generation);
  }
  assertAutomaticRunAggregates(generation, afterById);
  const appended = [...afterById.keys()].filter((id) => !beforeById.has(id));
  const expectedAppended = beforeExpected.length === 0 ? [...expectedById.keys()] : [];
  if (!samePathSet(appended, expectedAppended)) {
    throw new Error("automatic publication observation delta does not exactly match its generation");
  }
  return beforeExpected.length === 0 ? "first" : "replay";
}

function assertAutomaticObservationMetadata(observation, observationId, expected, generation) {
  const { run, targetId } = expected;
  if (
    observation.source_eval_run_id !== run.eval_run_id ||
    observation.target !== targetId ||
    observation.candidate_commit !== generation.candidate_commit ||
    observation.benchmark !== run.benchmark ||
    observation.lane !== run.lane ||
    observation.source_artifact !== generation.source_artifact ||
    observation.publication_url !== run.publication_url ||
    !Number.isSafeInteger(observation.executed_case_count) ||
    observation.executed_case_count <= 0 ||
    !Number.isSafeInteger(observation.graded_case_count) ||
    observation.graded_case_count <= 0
  ) {
    throw new Error(`automatic publication observation ${observationId} does not match generation metadata`);
  }
}

function assertAutomaticRunAggregates(generation, afterById) {
  for (const run of generation.runs) {
    const observations = run.observation_ids.map((id) => afterById.get(id));
    if (observations.some((observation) => observation === undefined)) {
      throw new Error(`automatic publication run ${run.eval_run_id} is missing expected observations`);
    }
    const executed = observations.reduce((sum, observation) => sum + observation.executed_case_count, 0);
    const graded = observations.reduce((sum, observation) => sum + observation.graded_case_count, 0);
    const status = observations.every((observation) => observation.status === "succeeded")
      ? "succeeded"
      : observations.some((observation) => observation.status === "failed")
        ? "failed"
        : "genuine-task-failures";
    if (executed !== run.executed_case_count || graded !== run.graded_case_count || status !== run.status) {
      throw new Error(`automatic publication run ${run.eval_run_id} does not match expected status or case counts`);
    }
  }
}

function observationsById(observations, label) {
  const values = new Map();
  for (const [index, observation] of observations.entries()) {
    const id = requiredObservationId(observation.id, `${label} observation ${index} ID`);
    if (values.has(id)) throw new Error(`${label} repeats observation ${id}`);
    values.set(id, observation);
  }
  return values;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function samePathSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((entry) => expectedSet.has(entry));
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

function resolvePublicationRemote(repositoryRoot, candidateRepositoryUrl, testOnlyPublicationRemoteUrl) {
  const originUrl = gitOutput(repositoryRoot, ["remote", "get-url", "origin"]);
  if (testOnlyPublicationRemoteUrl !== undefined) {
    const testRemote = realDirectory(testOnlyPublicationRemoteUrl, "test-only publication remote");
    if (path.resolve(originUrl) !== testRemote) throw new Error("test-only publication remote does not match origin");
    return { originUrl, pushUrl: testRemote, testOnly: true };
  }
  const canonical = canonicalGitHubRepositoryUrl(candidateRepositoryUrl);
  if (originUrl !== canonical && originUrl !== `${canonical}.git`) {
    throw new Error("publication origin must be the canonical candidate GitHub HTTPS repository");
  }
  return { originUrl, pushUrl: `${canonical}.git`, testOnly: false };
}

function assertSafePublicationTransport(repositoryRoot, expectedOriginUrl, worktree) {
  if (gitOutput(repositoryRoot, ["remote", "get-url", "origin"]) !== expectedOriginUrl) {
    throw new Error("publication origin URL changed after trusted checkout");
  }
  const commonNames = nulPaths(
    checked("git", ["config", "--local", "--name-only", "--null", "--list"], { cwd: repositoryRoot }).stdout
  );
  const originUrls = localConfigValues(repositoryRoot, "remote.origin.url");
  if (originUrls.length !== 1 || originUrls[0] !== expectedOriginUrl) {
    throw new Error("publication origin URL configuration changed after trusted checkout");
  }
  const originFetches = localConfigValues(repositoryRoot, "remote.origin.fetch");
  if (
    originFetches.length !== 1 ||
    !["+refs/heads/*:refs/remotes/origin/*", "+refs/heads/main:refs/remotes/origin/main"].includes(originFetches[0])
  ) {
    throw new Error("publication origin fetch configuration changed after trusted checkout");
  }
  const worktreeNames = [];
  if (worktree !== undefined) {
    const worktreeConfigValue = gitOutput(worktree, ["rev-parse", "--git-path", "config.worktree"]);
    const worktreeConfig = path.isAbsolute(worktreeConfigValue)
      ? worktreeConfigValue
      : path.resolve(worktree, worktreeConfigValue);
    const stat = fs.lstatSync(worktreeConfig, { throwIfNoEntry: false });
    if (stat !== undefined) {
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("publication worktree configuration is not a regular file");
      }
      worktreeNames.push(
        ...nulPaths(
          checked("git", ["config", "--file", worktreeConfig, "--name-only", "--null", "--list"], {
            cwd: worktree
          }).stdout
        )
      );
    }
  }
  const unsafe = commonNames.filter((name) => unsafePublicationTransportKey(name, true));
  unsafe.push(...worktreeNames.filter((name) => unsafePublicationTransportKey(name, false)));
  if (unsafe.length > 0) {
    throw new Error(`publication repository contains unsafe transport configuration: ${unsafe.join(", ")}`);
  }
}

function localConfigValues(repositoryRoot, key) {
  const args = ["config", "--local", "--null", "--get-all", key];
  const result = run("git", args, { cwd: repositoryRoot });
  if (result.status === 1) return [];
  if (result.status !== 0) throw processFailure("git", args, result);
  return nulPaths(result.stdout);
}

function unsafePublicationTransportKey(name, allowCanonicalOrigin) {
  const key = name.toLowerCase();
  if (
    key.startsWith("http.") ||
    key.startsWith("credential.") ||
    key.startsWith("url.") ||
    key.startsWith("include.") ||
    key.startsWith("includeif.") ||
    key.startsWith("protocol.") ||
    key.startsWith("ssh.") ||
    key === "core.sshcommand" ||
    key === "core.askpass"
  ) {
    return true;
  }
  if (!key.startsWith("remote.")) return false;
  return !allowCanonicalOrigin || (key !== "remote.origin.url" && key !== "remote.origin.fetch");
}

function refreshRemoteBase(repositoryRoot, publicationRemoteUrl, environment, redactions) {
  checked("git", ["fetch", "--no-tags", publicationRemoteUrl, "+refs/heads/main:refs/remotes/origin/main"], {
    cwd: repositoryRoot,
    env: environment,
    redact: redactions
  });
  const oid = gitOutput(repositoryRoot, ["rev-parse", TARGET_REMOTE_REF]);
  return { ref: TARGET_REMOTE_REF, oid };
}

function refreshCompatibleRemoteBase(repositoryRoot, publicationRemoteUrl, environment, redactions, toolingCommit) {
  const base = refreshRemoteBase(repositoryRoot, publicationRemoteUrl, environment, redactions);
  if (!isAncestor(repositoryRoot, toolingCommit, base.oid)) {
    throw new Error(`origin/${TARGET_BRANCH} is not descended from publication tooling commit ${toolingCommit}`);
  }
  const advancedPaths = nulPaths(
    checked("git", ["diff", "--name-only", "--no-renames", "-z", `${toolingCommit}..${base.oid}`, "--"], {
      cwd: repositoryRoot
    }).stdout
  );
  assertAllowedPaths(advancedPaths, "publication base advancement since the tooling checkout");
  return base;
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

function assertExactGenerationInputLayout(generation, inputRoot) {
  const tree = { children: new Map(), leaf: false };
  for (const run of generation.runs) {
    let node = tree;
    for (const [index, segment] of run.input_path.split("/").entries()) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { children: new Map(), leaf: false };
        node.children.set(segment, child);
      }
      node = child;
      if (index === run.input_path.split("/").length - 1) node.leaf = true;
    }
  }

  function walk(directory, node, relative) {
    if (node.leaf) return;
    const expected = [...node.children.keys()].sort(compareText);
    assertExactDirectoryEntries(
      directory,
      expected,
      `publication input layout${relative === "" ? "" : ` at ${relative}`}`
    );
    for (const name of expected) {
      const childPath = path.join(directory, name);
      const stat = fs.lstatSync(childPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`publication input layout contains a non-directory or symbolic link: ${relative}${name}`);
      }
      walk(childPath, node.children.get(name), `${relative}${name}/`);
    }
  }

  walk(inputRoot, tree, "");
}

function assertExactDirectoryEntries(root, expected, label) {
  const actual = fs.readdirSync(root).sort(compareText);
  const canonicalExpected = [...expected].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(canonicalExpected)) {
    throw new Error(`${label} must contain exactly ${canonicalExpected.join(", ")}`);
  }
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

export function publicationTreeDigest(rootValue) {
  const root = realDirectory(rootValue, "publication tree root");
  const entries = [];
  let totalBytes = 0;
  function walk(directory, relativeDirectory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name))) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) throw new Error(`publication tree contains a symbolic link: ${relativePath}`);
      if (stat.isDirectory()) {
        walk(entryPath, relativePath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`publication tree contains a non-regular entry: ${relativePath}`);
      if (stat.size > MAX_PUBLICATION_TREE_BYTES) {
        throw new Error(`publication tree file exceeds the size limit: ${relativePath}`);
      }
      const descriptor = fs.openSync(entryPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.size !== stat.size) {
          throw new Error(`publication tree file changed while hashing: ${relativePath}`);
        }
        const contents = fs.readFileSync(descriptor);
        totalBytes += contents.byteLength;
        if (totalBytes > MAX_PUBLICATION_TREE_BYTES) throw new Error("publication tree exceeds the size limit");
        const completed = fs.fstatSync(descriptor);
        if (!completed.isFile() || completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs) {
          throw new Error(`publication tree file changed while hashing: ${relativePath}`);
        }
        entries.push({ path: relativePath, size_bytes: contents.byteLength, sha256: sha256(contents) });
      } finally {
        fs.closeSync(descriptor);
      }
    }
  }
  walk(root, "");
  if (entries.length === 0) throw new Error("publication tree must contain at least one file");
  return sha256(Buffer.from(JSON.stringify(entries), "utf8"));
}

function assertPublicationTreeDigest(root, expectedDigest, evalRunId) {
  const actual = publicationTreeDigest(root);
  if (actual !== expectedDigest) {
    throw new Error(`publication tree digest does not match generation for ${evalRunId}`);
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

function observationIdsForPublicationRun(value, evalRunId) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_048) {
    throw new Error(`publication run ${evalRunId} observation_ids must be a non-empty array`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const id = requiredObservationId(entry, `publication run ${evalRunId} observation_ids ${index}`);
    if (seen.has(id)) throw new Error(`publication run ${evalRunId} repeats observation ${id}`);
    seen.add(id);
    return id;
  });
}

function requiredObservationId(value, label) {
  const id = requiredString(value, label);
  if (!SAFE_OBSERVATION_ID.test(id)) throw new Error(`${label} is not a safe observation ID`);
  return id;
}

function sha256Value(value, label) {
  const digest = requiredString(value, label);
  if (!SHA256.test(digest)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return digest;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

function readAndParseGeneration(generationPath, expectedGenerationSha256) {
  return parseEvalHistoryPublicationGeneration(
    readGeneration(generationPath, sha256Value(expectedGenerationSha256, "expected publication generation SHA-256"))
  );
}

function readGeneration(filePath, expectedSha256) {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_GENERATION_BYTES) {
      throw new Error("publication generation JSON is empty or too large");
    }
    const contents = fs.readFileSync(descriptor);
    if (sha256(contents) !== expectedSha256) {
      throw new Error("publication generation SHA-256 does not match the trusted workflow output");
    }
    try {
      return JSON.parse(contents.toString("utf8"));
    } catch (error) {
      throw new Error(`failed to parse publication generation JSON ${filePath}`, { cause: error });
    }
  } finally {
    fs.closeSync(descriptor);
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

function regularDirectoryPath(value, label) {
  const resolved = path.resolve(requiredString(value, label));
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a regular directory`);
  }
  return fs.realpathSync(resolved);
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
    env: options.env ?? (command === "git" ? hardenedGitEnvironment(false) : publisherFreeEnvironment()),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: redactSensitiveText(result.stdout ?? "", options.redact),
    stderr: redactSensitiveText(result.stderr ?? "", options.redact)
  };
}

function publisherFreeEnvironment() {
  const forbiddenTransportEnvironment = new Set([
    "CURL_CA_BUNDLE",
    "CURL_HOME",
    "CURL_SSL_BACKEND",
    "OPENSSL_CONF",
    "OPENSSL_CONF_INCLUDE",
    "OPENSSL_ENGINES",
    "OPENSSL_MODULES",
    "QLOGDIR",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SSLKEYLOGFILE"
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const upper = name.toUpperCase();
      return (
        upper !== "PUBLISHER_TOKEN" &&
        upper !== "GH_TOKEN" &&
        upper !== "GITHUB_TOKEN" &&
        !upper.startsWith("GIT_") &&
        !upper.startsWith("GCM_") &&
        !upper.startsWith("SSH_") &&
        !/^(?:HTTP|HTTPS|ALL|NO)_PROXY$/u.test(upper) &&
        !forbiddenTransportEnvironment.has(upper)
      );
    })
  );
}

function publisherGitEnvironment(publisherToken, allowFileProtocol) {
  const token = publisherTokenValue(publisherToken);
  if (token === undefined && !allowFileProtocol) {
    throw new Error("canonical GitHub publication requires a publisher token");
  }
  const authorization =
    token === undefined
      ? undefined
      : `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
  return hardenedGitEnvironment(allowFileProtocol, authorization);
}

function hardenedGitEnvironment(allowFileProtocol, authorization) {
  const entries = [
    ["credential.helper", ""],
    ["core.hooksPath", "/dev/null"],
    ["http.proxy", ""],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["protocol.file.allow", allowFileProtocol ? "always" : "never"]
  ];
  if (authorization !== undefined) entries.unshift(["http.https://github.com/.extraheader", authorization]);
  const environment = {
    ...publisherFreeEnvironment(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(entries.length)
  };
  for (const [index, [key, value]] of entries.entries()) {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return environment;
}

function publisherAuthorityRedactions(publisherToken) {
  const token = publisherTokenValue(publisherToken);
  if (token === undefined) return [];
  return [token, Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")];
}

function publisherTokenValue(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\r\n\0]/u.test(value)) {
    throw new Error("publisher token is invalid");
  }
  return value;
}

function redactSensitiveText(value, sensitiveValues = []) {
  let redacted = value;
  for (const sensitive of sensitiveValues) redacted = redacted.split(sensitive).join("[REDACTED]");
  return redacted;
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
  const publisherToken = takePublisherTokenFromEnvironment();
  const testOnlyPublicationRemoteUrl = process.env.ULTRAFUZZ_HISTORY_CAS_TEST_LOCAL_REMOTE;
  delete process.env.ULTRAFUZZ_HISTORY_CAS_TEST_LOCAL_REMOTE;
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate-handoff") {
    if (publisherToken !== undefined) throw new Error("handoff validation must not receive publisher authority");
    const [handoffRoot, expectedGenerationSha256, expectedCandidateCommit, expectedRepositoryUrl, ...extra] = args;
    if (
      handoffRoot === undefined ||
      expectedGenerationSha256 === undefined ||
      expectedCandidateCommit === undefined ||
      expectedRepositoryUrl === undefined ||
      extra.length > 0
    ) {
      throw new Error(
        "usage: publish-eval-history-cas.mjs validate-handoff <handoff-root> <expected-generation-sha256> <expected-candidate-commit> <expected-repository-url>"
      );
    }
    const result = validateEvalHistoryPublicationHandoff({
      handoffRoot,
      expectedGenerationSha256,
      expectedCandidateCommit,
      expectedRepositoryUrl
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (publisherToken === undefined && testOnlyPublicationRemoteUrl === undefined) {
    throw new Error("canonical GitHub publication requires a publisher token");
  }
  const [inputRoot, benchmarkPolicyRoot, expectedGenerationSha256, ...extra] = args;
  if (
    command === undefined ||
    inputRoot === undefined ||
    benchmarkPolicyRoot === undefined ||
    expectedGenerationSha256 === undefined ||
    extra.length > 0
  ) {
    throw new Error(
      "usage: publish-eval-history-cas.mjs <generation.json> <input-root> <benchmark-policy-root> <expected-generation-sha256>"
    );
  }
  const result = publishEvalHistoryGeneration({
    generationPath: command,
    inputRoot,
    benchmarkPolicyRoot,
    expectedGenerationSha256,
    publisherToken,
    testOnlyPublicationRemoteUrl
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function takePublisherTokenFromEnvironment() {
  const token = publisherTokenValue(process.env.PUBLISHER_TOKEN);
  for (const name of Object.keys(process.env)) {
    const upper = name.toUpperCase();
    if (
      upper === "PUBLISHER_TOKEN" ||
      upper === "GH_TOKEN" ||
      upper === "GITHUB_TOKEN" ||
      upper.startsWith("GIT_CONFIG_") ||
      upper.startsWith("GCM_") ||
      upper.startsWith("SSH_") ||
      upper === "GIT_ASKPASS" ||
      upper === "GIT_SSH" ||
      upper === "GIT_SSH_COMMAND"
    ) {
      delete process.env[name];
    }
  }
  return token;
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
