import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BENCHMARK_LANE_COHORTS,
  BENCHMARK_LANE_NAMES,
  benchmarkLaneSelectedTargetIds,
  loadBenchmarkCohortManifest
} from "../../packages/evals/dist/index.js";
import { redactSecretsInText, sensitiveEnvironmentValues } from "../../packages/security/dist/index.js";

/**
 * Anonymous pre-compute reachability gate for a pinned benchmark cohort.
 *
 * The Modal sandbox clones every target with NO git credential and then runs
 * `git submodule update --init --recursive`, so a single flipped-private
 * dependency aborts preparation before the model starts. That is a
 * `dependency-unreachable` incomplete generation, which the publication gate
 * correctly refuses to publish, so the only remaining symptom is published
 * history that silently stops advancing. This gate proves the reachability the
 * sandbox needs, in seconds, before any Modal image build or sandbox launch.
 *
 * Every probe here is deliberately UNAUTHENTICATED. A `GITHUB_TOKEN` or a `gh`
 * credential reads a private dependency successfully and would mask exactly the
 * failure this gate exists to detect.
 *
 * What this gate does NOT prove: that the gitlink COMMIT each submodule is
 * pinned to still exists. `.gitmodules` records a path and a url only, so a
 * force-push inside a dependency that drops the recorded sha still aborts the
 * sandbox clone with the same pre-model `dependency-unreachable` signature this
 * gate pre-empts. Proving it needs a `git fetch --depth=1 <url> <sha>` per
 * submodule — real object transfer, ~137 of them on the full lane — instead of
 * one `ls-remote`, so it is deliberately out of scope: a green result here means
 * every dependency REPOSITORY is anonymously readable, nothing more.
 */

const COHORT_DIRECTORIES = Object.freeze({ "ultrafuzz-bench": "ultrafuzzbench", evmbench: "evmbench" });
/**
 * Selectors: a benchmark lane name probes exactly the targets that lane runs, a
 * cohort name probes every target that cohort pins.
 */
export const COHORT_REACHABILITY_LANES = Object.freeze([...BENCHMARK_LANE_NAMES, ...Object.keys(COHORT_DIRECTORIES)]);
const GITHUB_REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u;
const SCP_LIKE_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~\-/]+$/u;
const REMOTE_HELPER_URL = /^[A-Za-z0-9+.-]+::/u;
const UNUSABLE_URL = /\s|\p{Cc}/u;
const PROBEABLE_SCHEMES = new Set(["https:", "http:", "git:", "ssh:", "git+ssh:"]);
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 6;
const MAX_GITMODULES_BYTES = 128 * 1024;
const MAX_DETAIL_LENGTH = 240;

/**
 * Anonymous denials. GitHub answers private, deleted, and renamed repositories
 * identically (a 401 that git reports as a missing username), so a denial can
 * never name one of the three on its own. Everything unrecognized stays
 * transient: a DNS blip must never be reported as a private dependency.
 *
 * Only 401 and 404 are definitive HTTP denials. GitHub answers secondary rate
 * limiting with 403, and one probe per submodule from a shared-NAT runner ip
 * trips it, so 403, 408, 429, and every 5xx must fall through to transient or
 * the gate blames a perfectly public dependency for a throttle.
 */
const UNREACHABLE_GIT_STDERR = [
  /could not read Username/iu,
  /Authentication failed/iu,
  /Repository not found/iu,
  /remote: Not Found/iu,
  /returned error: 40[14](?!\d)/u,
  /does not appear to be a git repository/iu,
  /repository .* not found/iu,
  /access denied/iu,
  /Permission denied \(publickey\)/iu
];

const DROPPED_GIT_ENVIRONMENT = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND"
]);

/**
 * `IdentityFile=/dev/null` is what suppresses ssh's built-in `~/.ssh/id_*`
 * defaults: OpenSSH appends those only when no identity file is configured, and
 * `IdentitiesOnly` on its own does not drop them.
 */
const ANONYMOUS_SSH_OPTIONS = Object.freeze([
  "-F /dev/null",
  "-o BatchMode=yes",
  "-o ConnectTimeout=10",
  "-o IdentitiesOnly=yes",
  "-o IdentityAgent=none",
  "-o IdentityFile=/dev/null"
]);

/**
 * Neutralise every ambient way a credential could reach the probe: helper lists
 * and `insteadOf` rewrites in system, global, and environment config, an askpass
 * program, terminal prompting, and every ssh identity. An agent socket, a
 * `~/.ssh/config` stanza, or a default `~/.ssh/id_*` key would authenticate an
 * scp-like or `ssh://` url and report a private dependency as healthy, which is
 * the exact masking this gate exists to prevent.
 */
export function anonymousGitEnvironment(environment) {
  const scrubbed = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || DROPPED_GIT_ENVIRONMENT.has(name) || name.startsWith("GIT_CONFIG_")) continue;
    scrubbed[name] = value;
  }
  return {
    ...scrubbed,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_SSH_COMMAND: `ssh ${ANONYMOUS_SSH_OPTIONS.join(" ")}`
  };
}

/** Headers for the anonymous HTTP probes. No credential header, ever. */
export function anonymousRequestHeaders() {
  return { Accept: "*/*", "User-Agent": "ultrafuzz-cohort-reachability" };
}

/** Whether an anonymous `git ls-remote` failure names a denial or proves nothing. */
export function classifyGitRemoteFailure(message) {
  return UNREACHABLE_GIT_STDERR.some((pattern) => pattern.test(message)) ? "unreachable" : "transient";
}

export function anonymousGitArguments(url) {
  return ["-c", "credential.helper=", "-c", "core.askPass=", "-c", "http.extraHeader=", "ls-remote", "--heads", url];
}

/**
 * Resolve a `.gitmodules` url the way git does: `./` and `../` are relative to
 * the superproject's own remote url, not to the checkout.
 */
export function resolveSubmoduleUrl(url, repository) {
  if (!url.startsWith("./") && !url.startsWith("../")) return url;
  let base;
  try {
    base = new URL(repository);
  } catch {
    return undefined;
  }
  const segments = base.pathname
    .replace(/\.git$/u, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  for (const segment of url.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  base.pathname = `/${segments.join("/")}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

/** Every `[submodule]` entry a `.gitmodules` document declares, in file order. */
export function parseGitmodules(text, repository) {
  const entries = [];
  let current;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const section = /^\[submodule\s+"(.*)"\]$/u.exec(trimmed);
    if (section !== null) {
      current = { name: section[1], path: undefined, url: undefined };
      entries.push(current);
      continue;
    }
    if (trimmed.startsWith("[")) {
      current = undefined;
      continue;
    }
    if (current === undefined) continue;
    const assignment = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/u.exec(trimmed);
    if (assignment === null) continue;
    const key = assignment[1].toLowerCase();
    if (key === "path") current.path = assignment[2].trim();
    if (key === "url") current.url = assignment[2].trim();
  }
  return entries.map((entry) => ({
    path: entry.path === undefined || entry.path.length === 0 ? entry.name : entry.path,
    declared_url: entry.url,
    url: entry.url === undefined ? undefined : resolveSubmoduleUrl(entry.url, repository)
  }));
}

/**
 * Which urls `git ls-remote` may be handed. A remote-helper url (`ext::sh -c`)
 * executes a command, and a local path is unreachable from any sandbox clone,
 * so neither is probed.
 */
export function classifySubmoduleUrl(url) {
  if (url.length === 0 || UNUSABLE_URL.test(url) || url.startsWith("-")) {
    return { probeable: false, detail: "declares an unusable url" };
  }
  if (REMOTE_HELPER_URL.test(url) && !url.includes("://")) {
    return { probeable: false, detail: "declares a git remote-helper url, which this preflight refuses to run" };
  }
  if (SCP_LIKE_URL.test(url)) return { probeable: true };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { probeable: false, detail: "declares a local-path url, which no sandbox clone can reach" };
  }
  if (!PROBEABLE_SCHEMES.has(parsed.protocol)) {
    return { probeable: false, detail: `declares an unreachable ${parsed.protocol} url` };
  }
  return { probeable: true };
}

/**
 * Anonymously prove that every selected cohort target, and every submodule its
 * pinned revision declares, can be cloned with no credential.
 *
 * @param {{ lane: string, cohortPath?: string, repoRoot?: string, probe?: object, attempts?: number, backoffMs?: number }} input
 */
export async function verifyCohortReachability(input) {
  const lane = input.lane;
  if (!COHORT_REACHABILITY_LANES.includes(lane)) {
    throw new Error(`cohort reachability lane must be one of ${COHORT_REACHABILITY_LANES.join(", ")}`);
  }
  const attempts = input.attempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("cohort reachability attempts must be a positive integer");
  }
  const cohortPath =
    input.cohortPath === undefined ? laneCohortPath(lane, input.repoRoot) : path.resolve(input.cohortPath);
  const cohort = loadBenchmarkCohortManifest(cohortPath);
  const targets = selectTargets(lane, cohort, cohortPath);
  const context = {
    probe: resolveProbe(input.probe),
    attempts,
    backoffMs: input.backoffMs ?? DEFAULT_BACKOFF_MS,
    probeCount: 0
  };

  const findings = [];
  for (const wave of waves(targets, PROBE_CONCURRENCY)) {
    for (const targetFindings of await Promise.all(wave.map((target) => checkTarget(target, context)))) {
      findings.push(...targetFindings);
    }
  }
  return {
    cohort: cohortPath,
    lane,
    target_ids: targets.map((target) => target.id),
    probe_count: context.probeCount,
    findings,
    status: cohortReachabilityStatus(findings)
  };
}

export function describeCohortReachability(result) {
  if (result.status === "reachable") {
    return (
      `every ${result.lane} cohort dependency repository is anonymously reachable ` +
      `(${result.target_ids.length} target(s), ${result.probe_count} anonymous probe(s)). ` +
      "This does not prove that the gitlink commit each submodule pins still exists."
    );
  }
  const summary =
    result.status === "unreachable"
      ? `${result.lane} cohort ${result.cohort} pins dependencies that cannot be cloned without a credential. ` +
        "The Modal sandbox clones every target and submodule ANONYMOUSLY, so a private, deleted, or renamed " +
        "dependency aborts preparation before the model starts and produces an unpublishable generation. Make " +
        "each dependency below public, or repin the target that pulls it in."
      : `${result.lane} cohort ${result.cohort} could not be proven anonymously reachable. The probes below ` +
        "failed transiently instead of being denied, so this is not evidence of a private dependency. Re-run the " +
        "gate, and treat a repeated failure as a real outage of the host below.";
  const lines = result.findings.map(
    (finding) =>
      `${finding.class === "unreachable" ? "UNREACHABLE" : "UNVERIFIED"} ${finding.target}` +
      `${finding.path === undefined ? "" : ` ${finding.path}`} ${finding.url} ${finding.detail}`
  );
  return [summary, ...lines].join("\n");
}

/**
 * Exit code by verdict: 1 is a denied dependency, 2 an unproven one. A caller
 * must keep 1 fatal and may tolerate 2, which is evidence of nothing.
 */
export function cohortReachabilityExitCode(status) {
  if (status === "reachable") return 0;
  return status === "unreachable" ? 1 : 2;
}

function cohortReachabilityStatus(findings) {
  if (findings.some((finding) => finding.class === "unreachable")) return "unreachable";
  return findings.length > 0 ? "unverified" : "reachable";
}

function isCohortName(lane) {
  return Object.hasOwn(COHORT_DIRECTORIES, lane);
}

function laneCohortPath(lane, repoRoot) {
  const root =
    repoRoot === undefined ? path.resolve(fileURLToPath(import.meta.url), "..", "..", "..") : path.resolve(repoRoot);
  const directory = COHORT_DIRECTORIES[isCohortName(lane) ? lane : BENCHMARK_LANE_COHORTS[lane]];
  return path.join(root, "benchmarks", directory, "cohort.json");
}

function selectTargets(lane, cohort, cohortPath) {
  const ids = isCohortName(lane)
    ? cohort.targets.map((target) => target.id)
    : benchmarkLaneSelectedTargetIds(lane, cohort);
  const targetsById = new Map(cohort.targets.map((target) => [target.id, target]));
  return ids.map((id) => {
    const target = targetsById.get(id);
    if (target === undefined) throw new Error(`cohort ${cohortPath} selects unknown target ${id}`);
    return target;
  });
}

function resolveProbe(probe) {
  if (probe === undefined) return { fetchText: fetchTextAnonymously, headStatus: headStatusAnonymously, lsRemote };
  for (const name of ["fetchText", "headStatus", "lsRemote"]) {
    if (typeof probe[name] !== "function") throw new Error(`cohort reachability probe must implement ${name}`);
  }
  return probe;
}

async function checkTarget(target, context) {
  const repository = githubRepository(target);
  // One anonymous request proves the repository, the pinned revision, and the
  // submodule declaration at that revision together. Only its 404 is ambiguous,
  // because a target may legitimately declare no submodule at all.
  const raw = await attempt(context, () =>
    context.probe.fetchText(
      `https://raw.githubusercontent.com/${repository.owner}/${repository.name}/${target.revision}/.gitmodules`
    )
  );
  if (raw.status === "transient") {
    return [finding(target, undefined, target.repository, "unverified", detail("could not be probed", raw.detail))];
  }
  let gitmodules = raw.status === "found" ? (raw.body ?? "") : undefined;
  if (gitmodules === undefined) {
    const remote = await attempt(context, () => context.probe.lsRemote(target.repository));
    if (remote.status !== "reachable") {
      return [
        finding(
          target,
          undefined,
          target.repository,
          remote.status === "unreachable" ? "unreachable" : "unverified",
          detail("cannot be cloned anonymously", remote.detail)
        )
      ];
    }
    // codeload rather than api.github.com: the REST API allows 60
    // unauthenticated requests an hour per IP, which a 40-target cohort exhausts
    // in two runs, and the only way to raise that ceiling is the token that
    // would defeat this gate.
    const revision = await attempt(context, () =>
      context.probe.headStatus(
        `https://codeload.github.com/${repository.owner}/${repository.name}/tar.gz/${target.revision}`
      )
    );
    if (revision.status !== "found") {
      return [
        finding(
          target,
          undefined,
          target.repository,
          revision.status === "absent" ? "unreachable" : "unverified",
          detail(`pins revision ${target.revision}, which is not anonymously resolvable`, revision.detail)
        )
      ];
    }
    gitmodules = "";
  }
  if (Buffer.byteLength(gitmodules, "utf8") > MAX_GITMODULES_BYTES) {
    return [finding(target, ".gitmodules", target.repository, "unverified", "declares an oversized .gitmodules")];
  }

  const findings = [];
  for (const entry of parseGitmodules(gitmodules, target.repository)) {
    if (entry.declared_url === undefined) {
      findings.push(finding(target, entry.path, "(none)", "unreachable", "declares no url to clone"));
      continue;
    }
    if (entry.url === undefined) {
      findings.push(
        finding(
          target,
          entry.path,
          entry.declared_url,
          "unverified",
          "declares a relative url that cannot be resolved against the target repository"
        )
      );
      continue;
    }
    const classified = classifySubmoduleUrl(entry.url);
    if (!classified.probeable) {
      findings.push(finding(target, entry.path, entry.declared_url, "unreachable", classified.detail));
      continue;
    }
    const remote = await attempt(context, () => context.probe.lsRemote(entry.url));
    if (remote.status !== "reachable") {
      findings.push(
        finding(
          target,
          entry.path,
          entry.url,
          remote.status === "unreachable" ? "unreachable" : "unverified",
          detail("cannot be cloned anonymously", remote.detail)
        )
      );
    }
  }
  return findings;
}

/** Both cohort schemas pin `https://github.com/<owner>/<name>` exactly. */
function githubRepository(target) {
  const match = GITHUB_REPOSITORY.exec(target.repository);
  if (match === null) throw new Error(`cohort target ${target.id} is not pinned to a github.com repository`);
  return { owner: match[1], name: match[2] };
}

function finding(target, submodulePath, url, findingClass, message) {
  return {
    target: target.id,
    kind: submodulePath === undefined ? "repository" : "submodule",
    ...(submodulePath === undefined ? {} : { path: submodulePath }),
    url: sanitize(url),
    class: findingClass,
    detail: message
  };
}

function detail(summary, probeDetail) {
  return probeDetail === undefined || probeDetail.length === 0 ? summary : `${summary}: ${probeDetail}`;
}

/** Retry only a transient probe, a bounded number of times. */
async function attempt(context, run) {
  let outcome;
  for (let index = 0; index < context.attempts; index += 1) {
    if (index > 0 && context.backoffMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, context.backoffMs * index));
    }
    context.probeCount += 1;
    outcome = await run();
    if (outcome.status !== "transient") return outcome;
  }
  return outcome;
}

function* waves(values, size) {
  for (let index = 0; index < values.length; index += size) yield values.slice(index, index + size);
}

async function fetchTextAnonymously(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: anonymousRequestHeaders(),
      redirect: "follow",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    return { status: "transient", detail: sanitize(error instanceof Error ? error.message : "request failed") };
  }
  if (response.status === 404) return { status: "absent", detail: "HTTP 404" };
  if (!response.ok) return { status: "transient", detail: `HTTP ${response.status}` };
  return { status: "found", body: await response.text() };
}

async function headStatusAnonymously(url) {
  let response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      headers: anonymousRequestHeaders(),
      redirect: "follow",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    return { status: "transient", detail: sanitize(error instanceof Error ? error.message : "request failed") };
  }
  // An anonymous 404 is definitive but ambiguous: it hides an unresolvable
  // revision, a private repository, and a missing one behind one status. Rate
  // limiting and 5xx prove nothing either way.
  if (response.status === 404) return { status: "absent", detail: "HTTP 404" };
  if (!response.ok) return { status: "transient", detail: `HTTP ${response.status}` };
  return { status: "found" };
}

function lsRemote(url) {
  return new Promise((resolve) => {
    execFile(
      "git",
      anonymousGitArguments(url),
      {
        // Outside every checkout, so no repository-local credential or
        // `insteadOf` rewrite can reach the probe.
        cwd: os.tmpdir(),
        env: anonymousGitEnvironment(process.env),
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ status: "reachable" });
          return;
        }
        const message = sanitize(firstLine(stderr) ?? error.message);
        resolve({ status: classifyGitRemoteFailure(message), detail: message });
      }
    );
  });
}

function firstLine(stderr) {
  if (typeof stderr !== "string") return undefined;
  return stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function sanitize(message) {
  const redacted = redactSecretsInText(message, undefined, sensitiveEnvironmentValues(process.env));
  return redacted.length > MAX_DETAIL_LENGTH ? `${redacted.slice(0, MAX_DETAIL_LENGTH)}…` : redacted;
}

async function main(args) {
  let lane;
  let cohortPath;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--lane" && args[index + 1] !== undefined) {
      lane = args[index + 1];
      index += 1;
    } else if (argument === "--cohort" && args[index + 1] !== undefined) {
      cohortPath = args[index + 1];
      index += 1;
    } else {
      throw usageError();
    }
  }
  if (lane === undefined) throw usageError();
  const result = await verifyCohortReachability({ lane, ...(cohortPath === undefined ? {} : { cohortPath }) });
  const report = describeCohortReachability(result);
  if (json) console.log(JSON.stringify(result));
  else if (result.status === "reachable") console.log(report);
  if (result.status === "reachable") return;
  console.error(report);
  process.exitCode = cohortReachabilityExitCode(result.status);
}

function usageError() {
  return new Error(
    `usage: verify-cohort-reachability.mjs --lane <${COHORT_REACHABILITY_LANES.join("|")}> [--cohort <cohort.json>] [--json]`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
