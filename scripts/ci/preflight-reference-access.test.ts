import { describe, expect, it } from "bun:test";
import path from "node:path";

import {
  REFERENCE_GITHUB_REPOS_ENV,
  missingReferenceTokenPrerequisite,
  referenceAccessAllowlist,
  referenceAccessTargets,
  referenceAccessVerdict,
  verifyReferenceAccess
} from "./preflight-reference-access.mjs";

const PRIVATE_REPO = "monad-developers/web3-vulnerability-database";
const PINNED = "fbf00e990b1316879b674e9903548dba452e40d5";
const TOKEN = "ghs_examplereferencetokenvalue0123456789";

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    references: {
      "properties.crytic": {
        provider: "github",
        repo: "crytic/properties",
        commit: "5".repeat(40),
        paths: ["README.md"]
      },
      "vulnerability-database.web3": {
        kind: "vulnerability-database",
        provider: "github",
        repo: PRIVATE_REPO,
        commit: PINNED,
        paths: ["database.yml"]
      },
      ...overrides
    }
  };
}

function target(overrides: Record<string, string> = {}) {
  return { id: "vulnerability-database.web3", repo: PRIVATE_REPO, commit: PINNED, ...overrides };
}

describe("pinned private reference access preflight", () => {
  it("parses a deduplicated, sorted allowlist", () => {
    expect(referenceAccessAllowlist(` ${PRIVATE_REPO} , b/z ,, ${PRIVATE_REPO} `)).toEqual(["b/z", PRIVATE_REPO]);
    expect(referenceAccessAllowlist(undefined)).toEqual([]);
    expect(referenceAccessAllowlist("")).toEqual([]);
  });

  it("probes only the allowlisted private reference and never the public ones", () => {
    // The public reference needs no credential, so probing it would send the token to a remote with
    // no business receiving it.
    expect(referenceAccessTargets(catalog(), [PRIVATE_REPO])).toEqual([target()]);
  });

  it("refuses an allowlist that has drifted from the pinned catalog", () => {
    // A credential minted for a repository no reference uses means the pin and the permission have
    // diverged; silently probing nothing would report success for access that was never proven.
    expect(() => referenceAccessTargets(catalog(), [PRIVATE_REPO, "monad-developers/renamed-db"])).toThrow(
      /names repositories no pinned reference uses: monad-developers\/renamed-db/u
    );
    expect(() => referenceAccessTargets(catalog(), ["monad-developers/renamed-db"])).toThrow(
      /names repositories no pinned reference uses/u
    );
  });

  it("refuses a private reference that is not pinned to an immutable commit", () => {
    const moving = catalog({
      "vulnerability-database.web3": {
        provider: "github",
        repo: PRIVATE_REPO,
        commit: "main",
        paths: ["database.yml"]
      }
    });
    expect(() => referenceAccessTargets(moving, [PRIVATE_REPO])).toThrow(/not pinned to a full commit SHA/u);
  });

  it("confirms access only when both the repository and the exact pinned commit are readable", () => {
    const verdict = referenceAccessVerdict(target(), { repositoryStatus: 200, commitStatus: 200 });
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain(PINNED);
  });

  it("reports a missing App installation as the external prerequisite it is", () => {
    // GitHub reports 404, not 403, when the App has no installation on the repository at all, so the
    // human action is "install it", not "add a permission".
    const verdict = referenceAccessVerdict(target(), { repositoryStatus: 404, commitStatus: 0 });
    expect(verdict.ok).toBe(false);
    expect(verdict.prerequisite).toContain("EXTERNAL PREREQUISITE");
    expect(verdict.prerequisite).toContain("install the eval-history GitHub App");
    expect(verdict.prerequisite).toContain("Contents: Read-only");
    expect(verdict.prerequisite).toContain(PRIVATE_REPO);
  });

  it("distinguishes a missing content permission from a missing installation", () => {
    for (const probe of [
      { repositoryStatus: 403, commitStatus: 0 },
      { repositoryStatus: 200, commitStatus: 403 }
    ]) {
      const verdict = referenceAccessVerdict(target(), probe);
      expect(verdict.ok).toBe(false);
      expect(verdict.prerequisite).toContain("grant the eval-history GitHub App installation");
      expect(verdict.prerequisite).not.toContain("install the eval-history GitHub App on");
    }
  });

  it("distinguishes an expired token from an access problem", () => {
    const verdict = referenceAccessVerdict(target(), { repositoryStatus: 401, commitStatus: 0 });
    expect(verdict.ok).toBe(false);
    expect(verdict.prerequisite).toContain("expires one hour");
    expect(verdict.prerequisite).not.toContain("EXTERNAL PREREQUISITE");
  });

  it("distinguishes a bad pin from a permission problem", () => {
    for (const commitStatus of [404, 422]) {
      const verdict = referenceAccessVerdict(target(), { repositoryStatus: 200, commitStatus });
      expect(verdict.ok).toBe(false);
      expect(verdict.prerequisite).toContain("bad pin");
      expect(verdict.prerequisite).toContain(PINNED);
    }
  });

  it("treats any unexpected response as unproven rather than as success", () => {
    const verdict = referenceAccessVerdict(target(), { repositoryStatus: 500, commitStatus: 0 });
    expect(verdict.ok).toBe(false);
    expect(verdict.prerequisite).toContain("do not start paid compute");
  });

  it("sends the token only as an Authorization header and pins the immutable commit", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return { status: 200 } as Response;
    };

    const verdicts = await verifyReferenceAccess([target()], TOKEN, fetchImpl as unknown as typeof fetch);
    expect(verdicts.every((verdict) => verdict.ok)).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.github.com/repos/${PRIVATE_REPO}`,
      `https://api.github.com/repos/${PRIVATE_REPO}/commits/${PINNED}`
    ]);
    // The pinned revision is probed directly: proving `main` is readable would not prove the exact
    // immutable revision this run materializes is present.
    expect(calls[1]!.url).not.toContain("main");
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
      // The token must never appear in a URL, where it would be captured by request logs.
      expect(call.url).not.toContain(TOKEN);
    }
  });

  it("stops before the commit probe when the repository itself is unreadable", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return { status: 404 } as Response;
    };
    const verdicts = await verifyReferenceAccess([target()], TOKEN, fetchImpl as unknown as typeof fetch);
    expect(calls).toEqual([`https://api.github.com/repos/${PRIVATE_REPO}`]);
    expect(verdicts[0]!.ok).toBe(false);
  });

  it("keeps the installation remedy prominent but conditional on the observed mint failure", () => {
    const prerequisite = missingReferenceTokenPrerequisite([PRIVATE_REPO]);

    // The installation case stays first, concrete, and marked external, because it is the one no
    // change in this repository can fix.
    expect(prerequisite).toContain("EXTERNAL PREREQUISITE");
    expect(prerequisite).toContain("install the eval-history GitHub App");
    expect(prerequisite).toContain(PRIVATE_REPO);
    expect(prerequisite).toContain("Contents: Read-only");
    expect(prerequisite).toContain("administrator");
    expect(prerequisite).toContain("/repos/{owner}/{repo}/installation");
    // The forbidden workarounds are named so the failure cannot be "fixed" by weakening the pin.
    expect(prerequisite).toContain("must not be replaced, vendored, or removed");
  });

  it("does not claim an absent token proves the App is uninstalled", () => {
    const prerequisite = missingReferenceTokenPrerequisite([PRIVATE_REPO]);

    // An absent token proves only that the mint produced nothing. Asserting a missing installation
    // unconditionally would send someone to the wrong settings page and, worse, would make a plain
    // credential misconfiguration look like an external prerequisite nobody here can resolve.
    const installationClaim = prerequisite.indexOf("install the eval-history GitHub App");
    const conditional = prerequisite.indexOf("If it reports `Not Found`");
    expect(conditional).toBeGreaterThanOrEqual(0);
    expect(conditional).toBeLessThan(installationClaim);
    expect(prerequisite).toContain("does not by itself identify the cause");

    // Every other cause that produces the same empty output is named, with the remedy that actually
    // applies to it.
    for (const cause of [
      "EVAL_HISTORY_APP_CLIENT_ID",
      "EVAL_HISTORY_APP_PRIVATE_KEY",
      "App authentication error",
      "outage or rate limit",
      "action regression"
    ]) {
      expect(prerequisite).toContain(cause);
    }
    expect(prerequisite).toContain("installing the App will not help");
  });

  it("fails closed on an absent, blank, or rejected token", async () => {
    const script = path.join(import.meta.dir, "preflight-reference-access.mjs");
    const catalogPath = path.join(import.meta.dir, "..", "..", ".ultrafuzz", "references.yml");

    // An empty or whitespace token must never be treated as "no private reference declared".
    for (const token of ["", "   "]) {
      const proc = Bun.spawnSync(["node", script, catalogPath], {
        env: {
          ...process.env,
          ULTRAFUZZ_REFERENCE_GITHUB_REPOS: PRIVATE_REPO,
          ULTRAFUZZ_REFERENCE_GITHUB_TOKEN: token
        }
      });
      const output = new TextDecoder().decode(proc.stderr) + new TextDecoder().decode(proc.stdout);
      expect(proc.exitCode, JSON.stringify(token)).toBe(1);
      expect(output).toContain("refusing to start model-backed compute");
      expect(output).toContain("does not by itself identify the cause");
    }

    // A token GitHub rejects is unproven access, not proven access.
    const rejected = await verifyReferenceAccess([target()], "ghs_rejected", (async () => ({
      status: 401
    })) as unknown as typeof fetch);
    expect(rejected.every((verdict) => verdict.ok)).toBe(false);
  });

  it("names the environment variable a caller must set", () => {
    expect(REFERENCE_GITHUB_REPOS_ENV).toBe("ULTRAFUZZ_REFERENCE_GITHUB_REPOS");
    expect(() => referenceAccessTargets({ references: null }, [PRIVATE_REPO])).toThrow(/no `references` map/u);
  });
});
