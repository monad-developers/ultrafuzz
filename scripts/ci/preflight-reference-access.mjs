#!/usr/bin/env node
/**
 * Proves the pinned private reference is readable *before* any paid work starts.
 *
 * The curated vulnerability database is a private repository, and the detached Modal worker fetches
 * it during its pre-model phase. Without this preflight the first evidence that the read credential
 * is missing arrives only after an immutable image build and a sandbox launch -- a failure that costs
 * compute, produces `model_work_started=false` diagnostics, and reads like an infrastructure flake
 * rather than the external permission prerequisite it actually is.
 *
 * So the credential is proven here, against immutable repository metadata only: one metadata read per
 * private reference and one lookup of the exact pinned commit. Nothing is cloned, no blob is fetched,
 * no model is contacted, and the pinned commit is never resolved to a moving branch. A failure exits
 * non-zero with the precise external action a human must take, and the caller is expected to place
 * this step ahead of the image build.
 *
 * The token arrives in the environment and is only ever sent as an `Authorization` header. It is
 * never printed, never placed in a URL, and never written to a file.
 */
import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

export const REFERENCE_GITHUB_TOKEN_ENV = "ULTRAFUZZ_REFERENCE_GITHUB_TOKEN";
export const REFERENCE_GITHUB_REPOS_ENV = "ULTRAFUZZ_REFERENCE_GITHUB_REPOS";

/** Parses the `owner/repo` allowlist the token is declared for. */
export function referenceAccessAllowlist(value) {
  return [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
    )
  ].sort();
}

/**
 * The exact pinned references this preflight must prove, derived from the catalog and the allowlist.
 *
 * Only allowlisted repositories are probed: a public reference needs no credential, so probing it
 * would send the token to a remote that has no business receiving it. An allowlisted repo that the
 * catalog never names is reported as a configuration error rather than silently ignored, because it
 * means the credential and the pin have drifted apart.
 */
export function referenceAccessTargets(catalog, allowlist) {
  const references = catalog?.references;
  if (references === null || typeof references !== "object") {
    throw new Error("reference catalog has no `references` map");
  }
  const allowed = new Set(allowlist);
  const targets = [];
  const seen = new Set();
  for (const [id, entry] of Object.entries(references)) {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`reference \`${id}\` is not a mapping`);
    }
    if (!allowed.has(entry.repo)) continue;
    if (!/^[0-9a-f]{40}$/u.test(String(entry.commit ?? ""))) {
      throw new Error(`reference \`${id}\` is not pinned to a full commit SHA`);
    }
    targets.push({ id, repo: entry.repo, commit: entry.commit });
    seen.add(entry.repo);
  }
  const unused = [...allowed].filter((repo) => !seen.has(repo)).sort();
  if (unused.length > 0) {
    throw new Error(`${REFERENCE_GITHUB_REPOS_ENV} names repositories no pinned reference uses: ${unused.join(", ")}`);
  }
  if (targets.length === 0) {
    throw new Error(`${REFERENCE_GITHUB_REPOS_ENV} is set but resolved to no pinned reference`);
  }
  return targets.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Turns one probe result into either a pass or the exact external prerequisite blocking it.
 *
 * The status codes are deliberately not collapsed into one "no access" message. "The app is not
 * installed on this repository", "the installation lacks contents:read", and "the pinned commit does
 * not exist" require three different human actions, and reporting the wrong one sends whoever reads
 * this failure to the wrong settings page.
 */
export function referenceAccessVerdict(target, probe) {
  const where = `${target.repo} (reference \`${target.id}\`)`;
  if (probe.repositoryStatus === 200 && probe.commitStatus === 200) {
    return { ok: true, target, detail: `${where}: contents:read confirmed at ${target.commit}` };
  }
  if (probe.repositoryStatus === 401) {
    return {
      ok: false,
      target,
      prerequisite:
        `The reference read token was rejected by GitHub for ${where}. ` +
        "Re-mint it: an installation token expires one hour after it is created, so a job that " +
        "launches or recovers a sandbox must create its own rather than reuse an earlier job's."
    };
  }
  if (probe.repositoryStatus === 404) {
    return {
      ok: false,
      target,
      prerequisite:
        `EXTERNAL PREREQUISITE: install the eval-history GitHub App on ${where} with Repository ` +
        "permission `Contents: Read-only`. The token minted for this run cannot see the repository " +
        "at all, which is what GitHub reports when the App has no installation on it. A repository " +
        "administrator must add it under the App's installation configuration; no change to this " +
        "repository can substitute for that."
    };
  }
  if (probe.repositoryStatus === 403 || probe.commitStatus === 403) {
    return {
      ok: false,
      target,
      prerequisite:
        `EXTERNAL PREREQUISITE: grant the eval-history GitHub App installation on ${where} the ` +
        "Repository permission `Contents: Read-only`. The installation exists but the minted token " +
        "was refused content access, so the permission must be added and the resulting permission " +
        "request accepted by a repository administrator."
    };
  }
  if (probe.commitStatus === 404 || probe.commitStatus === 422) {
    return {
      ok: false,
      target,
      prerequisite:
        `The pinned commit ${target.commit} does not exist in ${where}. The App can read the ` +
        "repository, so this is a bad pin rather than a permission problem: re-pin the reference to " +
        "a commit that exists on the default branch."
    };
  }
  return {
    ok: false,
    target,
    prerequisite:
      `Unexpected GitHub response while proving read access to ${where}: ` +
      `repository=${probe.repositoryStatus} commit=${probe.commitStatus}. ` +
      "Treat this as unproven access and do not start paid compute."
  };
}

/** One authenticated metadata probe. The token only ever travels as a request header. */
async function probeReferenceAccess(target, token, fetchImpl) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "ultrafuzz-reference-preflight",
    "x-github-api-version": "2022-11-28"
  };
  const repository = await fetchImpl(`https://api.github.com/repos/${target.repo}`, {
    method: "GET",
    headers,
    redirect: "error",
    cache: "no-store"
  });
  if (repository.status !== 200) {
    return { repositoryStatus: repository.status, commitStatus: 0 };
  }
  // The pinned commit, never a branch: proving `main` is readable would not prove the immutable
  // revision this run actually materializes is present.
  const commit = await fetchImpl(`https://api.github.com/repos/${target.repo}/commits/${target.commit}`, {
    method: "GET",
    headers: { ...headers, accept: "application/vnd.github.sha" },
    redirect: "error",
    cache: "no-store"
  });
  return { repositoryStatus: repository.status, commitStatus: commit.status };
}

/** Proves every target, collecting all verdicts so one run reports every prerequisite at once. */
export async function verifyReferenceAccess(targets, token, fetchImpl = fetch) {
  const verdicts = [];
  for (const target of targets) {
    verdicts.push(referenceAccessVerdict(target, await probeReferenceAccess(target, token, fetchImpl)));
  }
  return verdicts;
}

export function readReferenceCatalog(catalogPath) {
  return parse(fs.readFileSync(catalogPath, "utf8"));
}

/**
 * The prerequisite to report when no token reached this step at all.
 *
 * In CI an empty token almost always means the mint step itself failed, and it fails for exactly one
 * reason worth acting on: `actions/create-github-app-token` asks GitHub for the App's installation on
 * the target repository and gets `404 Not Found` when there is none. That 404 is indistinguishable
 * from "repository does not exist" at the API level but is reported before any permission is
 * evaluated, so the actionable instruction is to install the App -- not to adjust a permission and not
 * to change anything in this repository.
 */
export function missingReferenceTokenPrerequisite(allowlist) {
  return (
    `EXTERNAL PREREQUISITE: install the eval-history GitHub App on ${allowlist.join(", ")} with ` +
    "Repository permission `Contents: Read-only`.\n" +
    `No token reached this step, which means the mint step could not find an installation of the App ` +
    "on that repository (`actions/create-github-app-token` reports GitHub's `Not Found` from " +
    "`GET /repos/{owner}/{repo}/installation`).\n" +
    "A repository or organization administrator must install it; no change inside this repository can " +
    "substitute for that, and the pin must not be replaced, vendored, or removed to work around it."
  );
}

async function main() {
  const catalogPath = path.resolve(process.argv[2] ?? ".ultrafuzz/references.yml");
  const allowlist = referenceAccessAllowlist(process.env[REFERENCE_GITHUB_REPOS_ENV]);
  if (allowlist.length === 0) {
    // No private reference is declared for this run, so there is nothing to prove and nothing that
    // could fail later for lack of a credential.
    console.log("No private pinned reference is declared; skipping the reference access preflight.");
    return;
  }
  const token = process.env[REFERENCE_GITHUB_TOKEN_ENV];
  if (token === undefined || token.trim() === "") {
    console.error(missingReferenceTokenPrerequisite(allowlist));
    console.error("Pinned private reference access is unproven; refusing to start model-backed compute.");
    process.exit(1);
  }
  const targets = referenceAccessTargets(readReferenceCatalog(catalogPath), allowlist);
  const verdicts = await verifyReferenceAccess(targets, token.trim());
  for (const verdict of verdicts) {
    console.log(verdict.ok ? `ok: ${verdict.detail}` : `FAILED: ${verdict.prerequisite}`);
  }
  if (verdicts.some((verdict) => !verdict.ok)) {
    console.error("Pinned private reference access is unproven; refusing to start model-backed compute.");
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  await main();
}
