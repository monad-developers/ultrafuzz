import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";

const ORCHESTRATION_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SCHEMA_PATH = path.join(ORCHESTRATION_ROOT, "ari-refresh.schema.json");

export const PATHS = Object.freeze({
  baseline: "/home/ubuntu/ultrafuzz-527-worktrees/ari-baseline",
  audit: "/home/ubuntu/ultrafuzz-issue-527/.audit-orchestration",
  skill: "/home/ubuntu/ultrafuzz-issue-527/.audit-orchestration/claude-sec-skills",
  ari: "/home/ubuntu/ultrafuzz-issue-527/.audit-orchestration/ari",
  reports: "/home/ubuntu/ultrafuzz-issue-527/.audit-orchestration/ultrafuzz-sec-skills-reports",
  remediationManifest: "/home/ubuntu/ultrafuzz-issue-527/.audit-orchestration/issue-527-remediation-groups.json",
  outputRoot: "/home/ubuntu/ultrafuzz-527-ari-refresh"
});

export const PINS = Object.freeze({
  skill: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e",
  ari: "847f5e300d1977be9a437ead50826ddd5930a01d",
  baseline: "a634d948038f502e5e677477138dca0c763e2380",
  reports: "b4f992a23e1f9a33f7c5fa2d4a5c6817c7c7a06a",
  remediation_manifest_sha256: "fac2351a5f6130bcd2f62d2fb894d31362df19b49c3f43145f3eb315dd2ce6b5",
  final_base: "e0b872e387307128cc6fbf049e7623b031c5ff22",
  final: "950c0c44bfea54f4a7706ff99eb10ccf11127597"
});

export const ASSESSOR_LIMITS = Object.freeze({
  codex_deadline_ms: 90 * 60 * 1000,
  claude_attempt_deadline_ms: 90 * 60 * 1000,
  term_grace_ms: 10 * 1000,
  claude_stdout_max_bytes: 8 * 1024 * 1024,
  codex_event_max_bytes: 128 * 1024 * 1024,
  structured_output_max_bytes: 8 * 1024 * 1024
});

const PRIOR_REPORTS = Object.freeze({
  openai: {
    path: `${PATHS.reports}/reports/threat-model/openai-gpt-5.6-sol-xhigh.md`,
    sha256: "8977c5062a5e865d1fe11dbbb81f060d810850eda1ea4d8a96439d42de9624ce",
    baselineNeedles: ["33.816326530612244", "16.57", "49", "Grade D"]
  },
  anthropic: {
    path: `${PATHS.reports}/reports/threat-model/anthropic-claude-fable-5-max.md`,
    sha256: "a5ec4508cfb0c274493f62c647fc6e032f2295560ba292fcb64d4b41a25d7a02",
    baselineNeedles: ["28.392857142857142", "7.95", "28", "Grade C"]
  }
});

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
export const REVIEWED_REMEDIATION_HEADS_BY_GROUP = Object.freeze({
  prioritized_core: "8c6a7985df4cc38404a577a0977f85e9f3e629a2",
  remaining_highs: "6c0f71dedb5580c9285d928ddd66056ee868de67",
  credential_minimization: "62ad4e58f2691bbf55a038f7ae3e7942eafe2a34",
  bounded_inputs: "38ebd41573a9400ba2c0452defbf26c1e662d2d4",
  dependency_advisory: "bc345d86ef5f4a29e5cd35524387946ec6cec1e0"
});
export const REVIEWED_REMEDIATION_HEADS = Object.freeze(Object.values(REVIEWED_REMEDIATION_HEADS_BY_GROUP));

const git = (repositoryPath, args) =>
  execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

const signalProcessGroup = (child, signal) => {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
};

const signalProcessTree = (child, signal) => {
  if (signalProcessGroup(child, signal)) return true;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
};

const processGroupExists = (child) => {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === "object" && error.code === "EPERM";
  }
};

export const superviseChildProcess = (child, { deadlineMs, termGraceMs }) => {
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`deadlineMs must be a positive integer, got ${deadlineMs}`);
  }
  if (!Number.isInteger(termGraceMs) || termGraceMs <= 0) {
    throw new Error(`termGraceMs must be a positive integer, got ${termGraceMs}`);
  }

  let terminate;
  const completion = new Promise((resolve) => {
    const startedAt = Date.now();
    let finished = false;
    let leaderClosed = false;
    let exitCode = null;
    let exitSignal = null;
    let terminationReason = null;
    let termSent = false;
    let killSent = false;
    let spawnError = null;
    let killTimer = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      resolve({
        code: exitCode,
        signal: exitSignal,
        spawn_error: spawnError,
        termination_reason: terminationReason,
        timed_out: terminationReason === "deadline",
        output_limit_exceeded: terminationReason?.endsWith("_limit") ?? false,
        term_sent: termSent,
        kill_sent: killSent,
        deadline_ms: deadlineMs,
        term_grace_ms: termGraceMs,
        wall_time_ms: Date.now() - startedAt
      });
    };

    terminate = (reason) => {
      if (finished || terminationReason !== null) return false;
      terminationReason = reason;
      termSent = signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = null;
        if (leaderClosed) {
          killSent = signalProcessGroup(child, "SIGKILL");
          finish();
        } else {
          killSent = signalProcessTree(child, "SIGKILL");
        }
      }, termGraceMs);
      return true;
    };

    const deadlineTimer = setTimeout(() => terminate("deadline"), deadlineMs);
    child.once("error", (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
    });
    child.once("close", (code, signal) => {
      leaderClosed = true;
      exitCode = code;
      exitSignal = signal;
      clearTimeout(deadlineTimer);
      if (killTimer !== null && processGroupExists(child)) return;
      finish();
    });
  });

  return {
    completion,
    terminate: (reason) => terminate(reason)
  };
};

export const createByteLimitTransform = (maxBytes, onLimit) => {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive integer, got ${maxBytes}`);
  }
  const stats = { max_bytes: maxBytes, observed_bytes: 0, captured_bytes: 0, limit_exceeded: false };
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      stats.observed_bytes += bytes.length;
      const remaining = Math.max(0, maxBytes - stats.captured_bytes);
      if (remaining > 0) {
        const captured = bytes.subarray(0, remaining);
        stats.captured_bytes += captured.length;
        this.push(captured);
      }
      if (stats.observed_bytes > maxBytes && !stats.limit_exceeded) {
        stats.limit_exceeded = true;
        try {
          onLimit();
        } catch (error) {
          callback(error);
          return;
        }
      }
      callback();
    }
  });
  return { stream, stats: () => ({ ...stats }) };
};

const assertCommit = (value, label) => {
  if (!COMMIT_PATTERN.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character commit, got ${value}`);
  }
};

const assertFrozenFinalCommit = (expectedFinalCommit) => {
  assertCommit(expectedFinalCommit, "expected final commit");
  if (typeof PINS.final !== "string" || !COMMIT_PATTERN.test(PINS.final)) {
    throw new Error("final aggregate commit is not frozen in PINS.final");
  }
  if (expectedFinalCommit !== PINS.final) {
    throw new Error(`final aggregate commit mismatch: expected frozen ${PINS.final}, got ${expectedFinalCommit}`);
  }
};

const assertRepository = (repositoryPath, expectedCommit, label) => {
  const actualCommit = git(repositoryPath, ["rev-parse", "HEAD"]);
  if (actualCommit !== expectedCommit) {
    throw new Error(`${label} HEAD mismatch: expected ${expectedCommit}, got ${actualCommit}`);
  }
  const status = git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") {
    throw new Error(`${label} is not clean:\n${status}`);
  }
  return { path: realpathSync(repositoryPath), commit: actualCommit, clean: true };
};

export const assertPinnedRepositories = (finalCheckout, expectedFinalCommit) => {
  assertFrozenFinalCommit(expectedFinalCommit);
  return {
    final: assertRepository(finalCheckout, expectedFinalCommit, "final checkout"),
    baseline: assertRepository(PATHS.baseline, PINS.baseline, "ARI baseline checkout"),
    skill: assertRepository(PATHS.skill, PINS.skill, "threat-model skill checkout"),
    ari: assertRepository(PATHS.ari, PINS.ari, "ARI specification checkout"),
    reports: assertRepository(PATHS.reports, PINS.reports, "prior-report checkout")
  };
};

export const assertCandidateAncestry = (finalCheckout, expectedFinalCommit, expectedFinalBase) => {
  assertFrozenFinalCommit(expectedFinalCommit);
  assertCommit(expectedFinalBase, "expected final base");
  if (expectedFinalBase !== PINS.final_base) {
    throw new Error(`final base mismatch: expected frozen ${PINS.final_base}, got ${expectedFinalBase}`);
  }
  const resolvedBase = git(finalCheckout, ["rev-parse", `${expectedFinalBase}^{commit}`]);
  if (resolvedBase !== expectedFinalBase) {
    throw new Error(`final base mismatch: expected ${expectedFinalBase}, resolved ${resolvedBase}`);
  }
  const requiredAncestors = { final_base: expectedFinalBase, ...REVIEWED_REMEDIATION_HEADS_BY_GROUP };
  for (const [group, ancestor] of Object.entries(requiredAncestors)) {
    if (typeof ancestor !== "string" || !COMMIT_PATTERN.test(ancestor)) {
      throw new Error(`${group} reviewed head is not frozen to a full lowercase commit`);
    }
    try {
      git(finalCheckout, ["merge-base", "--is-ancestor", ancestor, expectedFinalCommit]);
    } catch {
      throw new Error(`required ${group} commit ${ancestor} is not an ancestor of ${expectedFinalCommit}`);
    }
  }
  return { final_base: expectedFinalBase, reviewed_remediation_heads: REVIEWED_REMEDIATION_HEADS };
};

const isInside = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

export const assertOutputLocations = (promptPath, outputPaths, expectedFinalCommit) => {
  assertCommit(expectedFinalCommit, "expected final commit");
  const outputRoot = realpathSync(PATHS.outputRoot);
  if ((statSync(outputRoot).mode & 0o777) !== 0o700) {
    throw new Error(`output root must have mode 0700: ${outputRoot}`);
  }
  try {
    git(PATHS.outputRoot, ["rev-parse", "--is-inside-work-tree"]);
    throw new Error(`output root must not be inside a Git checkout: ${outputRoot}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("output root must not")) throw error;
  }

  const expectedCommitRoot = path.join(outputRoot, expectedFinalCommit);
  const commitRoot = realpathSync(expectedCommitRoot);
  if (commitRoot !== expectedCommitRoot || !isInside(commitRoot, outputRoot)) {
    throw new Error(`final-commit output root must resolve exactly to ${expectedCommitRoot}: ${commitRoot}`);
  }
  if ((statSync(commitRoot).mode & 0o777) !== 0o700) {
    throw new Error(`final-commit output root must have mode 0700: ${commitRoot}`);
  }

  const resolvedPrompt = realpathSync(promptPath);
  if (!isInside(resolvedPrompt, commitRoot)) {
    throw new Error(`rendered prompt must be under ${commitRoot}: ${resolvedPrompt}`);
  }
  if ((statSync(resolvedPrompt).mode & 0o777) !== 0o600) {
    throw new Error(`rendered prompt must have mode 0600: ${resolvedPrompt}`);
  }

  for (const outputPath of outputPaths) {
    const resolved = path.resolve(outputPath);
    const resolvedParent = realpathSync(path.dirname(resolved));
    if (!isInside(resolvedParent, commitRoot)) {
      throw new Error(`output must be under ${commitRoot}: ${resolved}`);
    }
    if (existsSync(resolved)) {
      throw new Error(`refusing to overwrite existing output: ${resolved}`);
    }
  }
};

export const sha256File = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");

export const assertBundledSchema = (schemaPath) => {
  const expected = realpathSync(BUNDLED_SCHEMA_PATH);
  const actual = realpathSync(schemaPath);
  if (actual !== expected) {
    throw new Error(`schema must be the bundled ARI refresh schema at ${expected}, got ${actual}`);
  }
  return actual;
};

const captureOrchestrationManifest = () => {
  const files = {};
  for (const entry of readdirSync(ORCHESTRATION_ROOT, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (!entry.isFile()) {
      throw new Error(`unexpected non-file in ARI refresh orchestration directory: ${entry.name}`);
    }
    const filePath = path.join(ORCHESTRATION_ROOT, entry.name);
    const stats = statSync(filePath);
    files[entry.name] = {
      sha256: sha256File(filePath),
      bytes: stats.size,
      mode: (stats.mode & 0o777).toString(8).padStart(3, "0")
    };
  }
  return {
    root: realpathSync(ORCHESTRATION_ROOT),
    files,
    manifest_sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex")
  };
};

export const captureAssessorInputs = (promptPath, schemaPath) => {
  assertBundledSchema(schemaPath);
  const remediationManifestHash = sha256File(PATHS.remediationManifest);
  if (remediationManifestHash !== PINS.remediation_manifest_sha256) {
    throw new Error(
      `remediation manifest hash mismatch: expected ${PINS.remediation_manifest_sha256}, got ${remediationManifestHash}`
    );
  }
  return {
    prompt_sha256: sha256File(promptPath),
    schema_sha256: sha256File(schemaPath),
    remediation_manifest_sha256: remediationManifestHash,
    orchestration: captureOrchestrationManifest()
  };
};

export const assertAssessorInputsUnchanged = (before, promptPath, schemaPath) => {
  const after = captureAssessorInputs(promptPath, schemaPath);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("rendered prompt, schema, or ARI refresh orchestration assets changed during assessor execution");
  }
  return after;
};

export const assertPostflightIntegrity = (
  finalCheckout,
  expectedFinalCommit,
  assessorInputsBefore,
  promptPath,
  schemaPath
) => {
  let repositories;
  let assessorInputs;
  const failures = [];
  try {
    repositories = assertPinnedRepositories(finalCheckout, expectedFinalCommit);
  } catch (error) {
    failures.push(error);
  }
  try {
    assessorInputs = assertAssessorInputsUnchanged(assessorInputsBefore, promptPath, schemaPath);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "multiple ARI assessor postflight checks failed");
  return { repositories, assessorInputs };
};

export const assertRenderedPrompt = (
  prompt,
  { lane, intendedModel, effort, finalCheckout, expectedFinalCommit, expectedFinalBase }
) => {
  if (/\{\{[A-Z0-9_]+\}\}/.test(prompt)) {
    throw new Error("rendered prompt still contains template placeholders");
  }
  const priorReport = PRIOR_REPORTS[lane];
  if (!priorReport) throw new Error(`unsupported prompt lane ${lane}`);
  const actualReportHash = sha256File(priorReport.path);
  if (actualReportHash !== priorReport.sha256) {
    throw new Error(`prior ${lane} report hash mismatch: expected ${priorReport.sha256}, got ${actualReportHash}`);
  }
  const requiredNeedles = [
    lane,
    intendedModel,
    effort,
    PINS.skill,
    PINS.ari,
    PINS.baseline,
    PATHS.remediationManifest,
    priorReport.path,
    realpathSync(finalCheckout),
    expectedFinalCommit,
    expectedFinalBase,
    ...priorReport.baselineNeedles
  ];
  for (const needle of requiredNeedles) {
    if (!prompt.includes(needle)) throw new Error(`rendered prompt is missing required value: ${needle}`);
  }
  const staleReportRoot = "/home/ubuntu/ultrafuzz-sec-skills/reports/threat-model";
  if (prompt.includes(staleReportRoot)) {
    throw new Error(`rendered prompt references stale prior reports under ${staleReportRoot}`);
  }
};

export const commandVersion = (command, args = ["--version"]) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

export const writeJsonExclusive = (filePath, value) => {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
};

export const fileBytes = (filePath) => statSync(filePath).size;

export const assertCommonProvenance = (structured, { lane, intendedModel, effort, expectedFinalCommit }) => {
  const expected = {
    lane,
    intended_model: intendedModel,
    effort,
    skill_commit: PINS.skill,
    ari_commit: PINS.ari,
    baseline_commit: PINS.baseline,
    final_commit: expectedFinalCommit
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (structured[field] !== expectedValue) {
      throw new Error(
        `structured provenance mismatch for ${field}: expected ${expectedValue}, got ${structured[field]}`
      );
    }
  }
};
