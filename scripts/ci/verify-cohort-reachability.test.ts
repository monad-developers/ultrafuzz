import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  anonymousGitArguments,
  anonymousGitEnvironment,
  anonymousRequestHeaders,
  classifyGitRemoteFailure,
  classifySubmoduleUrl,
  cohortReachabilityExitCode,
  describeCohortReachability,
  parseGitmodules,
  resolveSubmoduleUrl,
  verifyCohortReachability
} from "./verify-cohort-reachability.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "ci", "verify-cohort-reachability.mjs");
const REVISION = "e50384709a696c86ab0440bbbc3dd14a5f4ff6ec";
const OTHER_REVISION = "9853f6f4fe906b635e214b22de9f627c6a17ba5b";
// The exact anonymous denial GitHub returns for a private, deleted, or renamed
// repository, which is what broke the smoke cohort on 2026-08-27.
const DENIED = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
const RESOLVE_FAILED = "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com";

interface CohortTarget {
  id: string;
  framework: string;
  repository: string;
  revision: string;
}

interface Finding {
  target: string;
  kind: string;
  path?: string;
  url: string;
  class: string;
  detail: string;
}

interface ReachabilityResult {
  cohort: string;
  lane: string;
  target_ids: string[];
  probe_count: number;
  findings: Finding[];
  status: string;
}

interface FetchOutcome {
  status: "found" | "absent" | "transient";
  body?: string;
  detail?: string;
}

interface RemoteOutcome {
  status: "reachable" | "unreachable" | "transient";
  detail?: string;
}

interface FakeProbe {
  fetchText(url: string): Promise<FetchOutcome>;
  headStatus(url: string): Promise<FetchOutcome>;
  lsRemote(url: string): Promise<RemoteOutcome>;
  calls: { fetchText: string[]; headStatus: string[]; lsRemote: string[] };
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function target(id: string, repository: string, revision = REVISION): CohortTarget {
  return { id, framework: "foundry", repository, revision };
}

function writeCohort(targets: CohortTarget[], smokeTargets?: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-reachability-"));
  roots.push(root);
  const cohortPath = path.join(root, "cohort.json");
  fs.writeFileSync(
    cohortPath,
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.benchmark.cohort.v1",
        smoke_targets: smokeTargets ?? targets.map((entry) => entry.id),
        targets
      },
      undefined,
      2
    )}\n`
  );
  return cohortPath;
}

function writeRawCohort(contents: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-reachability-"));
  roots.push(root);
  const cohortPath = path.join(root, "cohort.json");
  fs.writeFileSync(cohortPath, contents);
  return cohortPath;
}

function gitmodules(entries: Array<{ path: string; url?: string }>): string {
  return entries
    .map(
      (entry) =>
        `[submodule "${entry.path}"]\n\tpath = ${entry.path}\n${entry.url === undefined ? "" : `\turl = ${entry.url}\n`}`
    )
    .join("");
}

/**
 * Every probe is injected, so no test reaches the network. `gitmodules` is keyed
 * by `<owner>/<name>`; every other repository answers as if the revision
 * declares no submodule.
 */
function fakeProbe(
  options: {
    gitmodules?: Record<string, string>;
    unreachable?: string[];
    transient?: string[];
    transientOnce?: string[];
    absentRevisions?: string[];
  } = {}
): FakeProbe {
  const seen = new Set<string>();
  const probe: FakeProbe = {
    calls: { fetchText: [], headStatus: [], lsRemote: [] },
    fetchText(url: string) {
      probe.calls.fetchText.push(url);
      const slug = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\//u.exec(url)?.[1] ?? "";
      if (options.transient?.includes(url) === true) return Promise.resolve({ status: "transient", detail: "socket" });
      const body = options.gitmodules?.[slug];
      if (body === undefined) return Promise.resolve({ status: "absent", detail: "HTTP 404" });
      return Promise.resolve({ status: "found", body });
    },
    headStatus(url: string) {
      probe.calls.headStatus.push(url);
      if (options.transient?.includes(url) === true)
        return Promise.resolve({ status: "transient", detail: "HTTP 502" });
      const absent = options.absentRevisions?.some((revision) => url.endsWith(revision)) === true;
      return Promise.resolve(absent ? { status: "absent", detail: "HTTP 404" } : { status: "found" });
    },
    lsRemote(url: string) {
      probe.calls.lsRemote.push(url);
      if (options.unreachable?.includes(url) === true) {
        return Promise.resolve({ status: "unreachable", detail: DENIED });
      }
      if (options.transient?.includes(url) === true) {
        return Promise.resolve({ status: "transient", detail: RESOLVE_FAILED });
      }
      if (options.transientOnce?.includes(url) === true && !seen.has(url)) {
        seen.add(url);
        return Promise.resolve({ status: "transient", detail: RESOLVE_FAILED });
      }
      return Promise.resolve({ status: "reachable" });
    }
  };
  return probe;
}

function verify(input: {
  cohortPath: string;
  lane?: string;
  probe: FakeProbe;
  attempts?: number;
}): Promise<ReachabilityResult> {
  return verifyCohortReachability({
    lane: input.lane ?? "smoke",
    cohortPath: input.cohortPath,
    probe: input.probe,
    attempts: input.attempts ?? 3,
    backoffMs: 0
  }) as Promise<ReachabilityResult>;
}

describe("cohort reachability preflight", () => {
  it("passes a cohort whose every target and submodule is anonymously reachable", async () => {
    const probe = fakeProbe({
      gitmodules: {
        "rheo-xyz/very-liquid-vaults": gitmodules([
          { path: "lib/forge-std", url: "https://github.com/foundry-rs/forge-std" },
          { path: "lib/properties", url: "https://github.com/crytic/properties" }
        ])
      }
    });
    const cohortPath = writeCohort([
      target("very-liquid-vaults-foundry", "https://github.com/rheo-xyz/very-liquid-vaults"),
      target("stableswap-ng-vyper", "https://github.com/curvefi/stableswap-ng", OTHER_REVISION)
    ]);

    const result = await verify({ cohortPath, probe });

    expect(result.findings).toEqual([]);
    expect(result.status).toBe("reachable");
    expect(cohortReachabilityExitCode(result.status)).toBe(0);
    expect(result.target_ids).toEqual(["very-liquid-vaults-foundry", "stableswap-ng-vyper"]);
    expect(describeCohortReachability(result)).toContain("anonymously reachable");
    // Discovery reads `.gitmodules` at the pinned revision, never at a branch.
    expect(probe.calls.fetchText.sort()).toEqual(
      [
        `https://raw.githubusercontent.com/rheo-xyz/very-liquid-vaults/${REVISION}/.gitmodules`,
        `https://raw.githubusercontent.com/curvefi/stableswap-ng/${OTHER_REVISION}/.gitmodules`
      ].sort()
    );
    expect(probe.calls.lsRemote.sort()).toEqual(
      [
        "https://github.com/foundry-rs/forge-std",
        "https://github.com/crytic/properties",
        "https://github.com/curvefi/stableswap-ng"
      ].sort()
    );
    expect(probe.calls.headStatus).toEqual([
      `https://codeload.github.com/curvefi/stableswap-ng/tar.gz/${OTHER_REVISION}`
    ]);
  });

  it("fails on the private transitive submodule that stalled published history", async () => {
    // The 2026-08-27 incident: `lib/console3` was flipped private, so
    // `git submodule update --init --recursive` aborted in the credential-less
    // Modal sandbox before the model started, and every push run since reported
    // an unpublishable incomplete generation as green.
    const probe = fakeProbe({
      gitmodules: {
        "rheo-xyz/very-liquid-vaults": gitmodules([
          { path: "lib/forge-std", url: "https://github.com/foundry-rs/forge-std" },
          { path: "lib/console3", url: "https://github.com/aviggiano/console3" },
          { path: "lib/create2deployer", url: "https://github.com/pcaversaccio/create2deployer" }
        ])
      },
      unreachable: ["https://github.com/aviggiano/console3"]
    });
    const cohortPath = writeCohort([
      target("very-liquid-vaults-foundry", "https://github.com/rheo-xyz/very-liquid-vaults")
    ]);

    const result = await verify({ cohortPath, probe });

    expect(result.status).toBe("unreachable");
    expect(cohortReachabilityExitCode(result.status)).toBe(1);
    expect(result.findings).toEqual([
      {
        target: "very-liquid-vaults-foundry",
        kind: "submodule",
        path: "lib/console3",
        url: "https://github.com/aviggiano/console3",
        class: "unreachable",
        detail: `cannot be cloned anonymously: ${DENIED}`
      }
    ]);
    const report = describeCohortReachability(result);
    expect(report).toContain("https://github.com/aviggiano/console3");
    expect(report).toContain("lib/console3");
    expect(report).toContain("very-liquid-vaults-foundry");
    expect(report).toContain("ANONYMOUSLY");
    // The public siblings must not be blamed for the private one.
    expect(report).not.toContain("forge-std");
    expect(report).not.toContain("create2deployer");
  });

  it("reports every unreachable dependency in one run", async () => {
    const probe = fakeProbe({
      gitmodules: {
        "rheo-xyz/very-liquid-vaults": gitmodules([
          { path: "lib/console3", url: "https://github.com/aviggiano/console3" },
          { path: "lib/ercx-tests", url: "https://github.com/runtimeverification/ercx-tests" },
          { path: "lib/erc4626-tests", url: "https://github.com/aviggiano/erc4626-tests" }
        ])
      },
      unreachable: [
        "https://github.com/aviggiano/console3",
        "https://github.com/aviggiano/erc4626-tests",
        "https://github.com/code-423n4/2023-05-venus"
      ]
    });
    const cohortPath = writeCohort([
      target("very-liquid-vaults-foundry", "https://github.com/rheo-xyz/very-liquid-vaults"),
      target("venus-isolated-pools-hardhat", "https://github.com/code-423n4/2023-05-venus", OTHER_REVISION),
      target("stableswap-ng-vyper", "https://github.com/curvefi/stableswap-ng", OTHER_REVISION)
    ]);

    const result = await verify({ cohortPath, probe });

    expect(result.status).toBe("unreachable");
    expect(result.findings.map((finding) => [finding.target, finding.path, finding.url, finding.class])).toEqual([
      ["very-liquid-vaults-foundry", "lib/console3", "https://github.com/aviggiano/console3", "unreachable"],
      ["very-liquid-vaults-foundry", "lib/erc4626-tests", "https://github.com/aviggiano/erc4626-tests", "unreachable"],
      ["venus-isolated-pools-hardhat", undefined, "https://github.com/code-423n4/2023-05-venus", "unreachable"]
    ]);
    const report = describeCohortReachability(result);
    for (const url of [
      "https://github.com/aviggiano/console3",
      "https://github.com/aviggiano/erc4626-tests",
      "https://github.com/code-423n4/2023-05-venus"
    ]) {
      expect(report).toContain(url);
    }
    // A denial mid-cohort may not stop the sweep: the last target is still probed.
    expect(probe.calls.headStatus).toContain(
      `https://codeload.github.com/curvefi/stableswap-ng/tar.gz/${OTHER_REVISION}`
    );
  });

  it("fails a target whose pinned revision is not anonymously resolvable", async () => {
    const probe = fakeProbe({ absentRevisions: [REVISION] });
    const cohortPath = writeCohort([
      target("very-liquid-vaults-foundry", "https://github.com/rheo-xyz/very-liquid-vaults")
    ]);

    const result = await verify({ cohortPath, probe });

    expect(result.status).toBe("unreachable");
    expect(result.findings).toEqual([
      {
        target: "very-liquid-vaults-foundry",
        kind: "repository",
        url: "https://github.com/rheo-xyz/very-liquid-vaults",
        class: "unreachable",
        detail: `pins revision ${REVISION}, which is not anonymously resolvable: HTTP 404`
      }
    ]);
    expect(describeCohortReachability(result)).toContain(REVISION);
  });

  it("distinguishes a transient probe failure from a denial", async () => {
    const probe = fakeProbe({
      gitmodules: {
        "rheo-xyz/very-liquid-vaults": gitmodules([
          { path: "lib/console3", url: "https://github.com/aviggiano/console3" }
        ])
      },
      transient: ["https://github.com/aviggiano/console3"]
    });
    const cohortPath = writeCohort([
      target("very-liquid-vaults-foundry", "https://github.com/rheo-xyz/very-liquid-vaults")
    ]);

    const result = await verify({ cohortPath, probe, attempts: 3 });

    expect(result.status).toBe("unverified");
    expect(cohortReachabilityExitCode(result.status)).toBe(2);
    expect(result.findings).toEqual([
      {
        target: "very-liquid-vaults-foundry",
        kind: "submodule",
        path: "lib/console3",
        url: "https://github.com/aviggiano/console3",
        class: "unverified",
        detail: `cannot be cloned anonymously: ${RESOLVE_FAILED}`
      }
    ]);
    const report = describeCohortReachability(result);
    expect(report).toContain("not evidence of a private dependency");
    expect(report).not.toContain("UNREACHABLE");
    // Bounded retries: exactly `attempts` probes of the flaky url, no more.
    expect(probe.calls.lsRemote).toEqual([
      "https://github.com/aviggiano/console3",
      "https://github.com/aviggiano/console3",
      "https://github.com/aviggiano/console3"
    ]);
  });

  it("retries a transient probe and accepts the recovered result", async () => {
    const probe = fakeProbe({
      gitmodules: {
        "rheo-xyz/very-liquid-vaults": gitmodules([
          { path: "lib/forge-std", url: "https://github.com/foundry-rs/forge-std" }
        ])
      },
      transientOnce: ["https://github.com/foundry-rs/forge-std"]
    });
    const cohortPath = writeCohort([
      target("very-liquid-vaults-foundry", "https://github.com/rheo-xyz/very-liquid-vaults")
    ]);

    const result = await verify({ cohortPath, probe });

    expect(result.status).toBe("reachable");
    expect(probe.calls.lsRemote).toHaveLength(2);
  });

  it("redacts a credential embedded in a submodule url before it reaches a log", async () => {
    const credentialed = "https://ci-bot:hunter2pass@github.com/rheo-xyz/private-dep";
    const probe = fakeProbe({
      gitmodules: {
        "rheo-xyz/very-liquid-vaults": gitmodules([{ path: "lib/private-dep", url: credentialed }])
      },
      unreachable: [credentialed]
    });
    const cohortPath = writeCohort([
      target("very-liquid-vaults-foundry", "https://github.com/rheo-xyz/very-liquid-vaults")
    ]);

    const result = await verify({ cohortPath, probe });

    expect(result.findings[0]?.url).toBe("<redacted>/rheo-xyz/private-dep");
    const report = describeCohortReachability(result);
    expect(report).not.toContain("hunter2pass");
    expect(report).not.toContain("ci-bot");
    // The probe itself still receives the url git would clone.
    expect(probe.calls.lsRemote).toEqual([credentialed]);
  });

  it("treats only a definitive anonymous denial as unreachable, and a throttle as transient", () => {
    const httpFailure = (status: number) =>
      `fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: ${status}`;

    expect(classifyGitRemoteFailure(httpFailure(401))).toBe("unreachable");
    expect(classifyGitRemoteFailure(httpFailure(404))).toBe("unreachable");
    // GitHub answers secondary rate limiting with 403, and the full lane makes
    // one probe per submodule from a shared-NAT runner ip, so a throttle must
    // never be reported as a private dependency.
    expect(classifyGitRemoteFailure(httpFailure(403))).toBe("transient");
    expect(classifyGitRemoteFailure(httpFailure(408))).toBe("transient");
    expect(classifyGitRemoteFailure(httpFailure(429))).toBe("transient");
    expect(classifyGitRemoteFailure(httpFailure(500))).toBe("transient");
    expect(classifyGitRemoteFailure(DENIED)).toBe("unreachable");
    expect(classifyGitRemoteFailure("fatal: Permission denied (publickey).")).toBe("unreachable");
    expect(classifyGitRemoteFailure(RESOLVE_FAILED)).toBe("transient");
    expect(classifyGitRemoteFailure("ssh: connect to host github.com port 22: Connection timed out")).toBe("transient");
  });

  it("resolves every selector to the cohort it names", async () => {
    const cohortOf = (directory: string) =>
      JSON.parse(fs.readFileSync(path.join(repoRoot, "benchmarks", directory, "cohort.json"), "utf8")) as {
        targets: CohortTarget[];
      };
    const selected = async (lane: string) =>
      (await verifyCohortReachability({ lane, repoRoot, probe: fakeProbe(), backoffMs: 0 })) as ReachabilityResult;

    for (const [lane, directory] of [
      ["smoke", "ultrafuzzbench"],
      ["threat-model", "ultrafuzzbench"],
      ["full", "evmbench"],
      ["ultrafuzz-bench", "ultrafuzzbench"],
      ["evmbench", "evmbench"]
    ] as const) {
      expect((await selected(lane)).cohort, lane).toBe(path.join(repoRoot, "benchmarks", directory, "cohort.json"));
    }
    // A cohort name sweeps every target that cohort pins, in both cohorts: the
    // selector may not silently mean "every ultrafuzzbench target".
    expect((await selected("ultrafuzz-bench")).target_ids).toEqual(
      cohortOf("ultrafuzzbench").targets.map((entry) => entry.id)
    );
    expect((await selected("evmbench")).target_ids).toEqual(cohortOf("evmbench").targets.map((entry) => entry.id));
  });

  it("selects the targets the lane runs", async () => {
    const cohortPath = writeCohort(
      [
        target("very-liquid-vaults-foundry", "https://github.com/rheo-xyz/very-liquid-vaults"),
        target("venus-isolated-pools-hardhat", "https://github.com/code-423n4/2023-05-venus", OTHER_REVISION),
        target("stableswap-ng-vyper", "https://github.com/curvefi/stableswap-ng", OTHER_REVISION)
      ],
      ["very-liquid-vaults-foundry"]
    );

    expect((await verify({ cohortPath, lane: "smoke", probe: fakeProbe() })).target_ids).toEqual([
      "very-liquid-vaults-foundry"
    ]);
    expect((await verify({ cohortPath, lane: "threat-model", probe: fakeProbe() })).target_ids).toEqual([
      "very-liquid-vaults-foundry"
    ]);
    expect((await verify({ cohortPath, lane: "ultrafuzz-bench", probe: fakeProbe() })).target_ids).toEqual([
      "very-liquid-vaults-foundry",
      "venus-isolated-pools-hardhat",
      "stableswap-ng-vyper"
    ]);
    await expect(verify({ cohortPath, lane: "all", probe: fakeProbe() })).rejects.toThrow(
      /lane must be one of smoke, threat-model, full, ultrafuzz-bench, evmbench/u
    );
    await expect(verify({ cohortPath, probe: fakeProbe(), attempts: 0 })).rejects.toThrow(
      /attempts must be a positive integer/u
    );
  });

  it("refuses a malformed or unparseable cohort", async () => {
    const probe = fakeProbe();
    await expect(verify({ cohortPath: writeRawCohort("{ not json"), probe })).rejects.toThrow(
      /failed to read benchmark manifest/u
    );
    await expect(
      verify({
        cohortPath: writeRawCohort(
          `${JSON.stringify({
            schema_version: "ultrafuzz.benchmark.cohort.v1",
            smoke_targets: ["very-liquid-vaults-foundry"],
            targets: [
              { id: "very-liquid-vaults-foundry", framework: "foundry", repository: "https://github.com/rheo-xyz/x" }
            ]
          })}\n`
        ),
        probe
      })
    ).rejects.toThrow(/failed benchmark schema validation/u);
    await expect(
      verify({
        cohortPath: writeRawCohort(
          `${JSON.stringify({
            schema_version: "ultrafuzz.benchmark.cohort.v1",
            smoke_targets: ["absent-target"],
            targets: [target("very-liquid-vaults-foundry", "https://github.com/rheo-xyz/x")]
          })}\n`
        ),
        probe
      })
    ).rejects.toThrow(/benchmark (schema|semantic) validation/u);
    await expect(
      verify({ cohortPath: writeRawCohort(`${JSON.stringify({ schema_version: "cohort.v9" })}\n`), probe })
    ).rejects.toThrow(/must declare/u);
    expect(probe.calls.lsRemote).toEqual([]);
  });

  it("rejects an incomplete injected probe instead of silently reaching the network", async () => {
    await expect(
      verifyCohortReachability({
        lane: "smoke",
        cohortPath: writeCohort([target("t", "https://github.com/rheo-xyz/very-liquid-vaults")]),
        probe: { lsRemote: () => Promise.resolve({ status: "reachable" }) }
      })
    ).rejects.toThrow(/probe must implement fetchText/u);
  });

  it("handles relative, scp-like, non-GitHub, and remote-helper submodule urls", async () => {
    const probe = fakeProbe({
      gitmodules: {
        "rheo-xyz/very-liquid-vaults": gitmodules([
          { path: "lib/console3", url: "../console3" },
          { path: "lib/mirror", url: "git@gitlab.com:group/mirror.git" },
          { path: "lib/vendored", url: "https://git.sr.ht/~user/vendored" },
          { path: "lib/evil", url: "ext::sh" },
          { path: "lib/local", url: "/srv/git/local.git" },
          { path: "lib/nourl" }
        ])
      },
      unreachable: ["https://github.com/rheo-xyz/console3"]
    });
    const cohortPath = writeCohort([
      target("very-liquid-vaults-foundry", "https://github.com/rheo-xyz/very-liquid-vaults")
    ]);

    const result = await verify({ cohortPath, probe });

    expect(result.findings.map((finding) => [finding.path, finding.url, finding.class])).toEqual([
      ["lib/console3", "https://github.com/rheo-xyz/console3", "unreachable"],
      ["lib/evil", "ext::sh", "unreachable"],
      ["lib/local", "/srv/git/local.git", "unreachable"],
      ["lib/nourl", "(none)", "unreachable"]
    ]);
    // A relative url is resolved against the superproject before probing, and
    // the forms git cannot clone anonymously are never handed to `ls-remote`.
    expect(probe.calls.lsRemote).toEqual([
      "https://github.com/rheo-xyz/console3",
      "git@gitlab.com:group/mirror.git",
      "https://git.sr.ht/~user/vendored"
    ]);
  });

  it("parses .gitmodules and resolves relative urls the way git does", () => {
    const document = [
      "# a comment",
      '[submodule "lib/forge-std"]',
      "\tpath = lib/forge-std",
      "\turl = https://github.com/foundry-rs/forge-std",
      '[submodule "named-only"]',
      "\turl = ../named-only",
      "[core]",
      "\turl = https://github.com/not-a/submodule",
      '[submodule "lib/branched"]',
      "\tpath = lib/branched",
      "\turl = https://github.com/o/branched",
      "\tbranch = main"
    ].join("\n");

    expect(parseGitmodules(document, "https://github.com/rheo-xyz/very-liquid-vaults")).toEqual([
      {
        path: "lib/forge-std",
        declared_url: "https://github.com/foundry-rs/forge-std",
        url: "https://github.com/foundry-rs/forge-std"
      },
      {
        path: "named-only",
        declared_url: "../named-only",
        url: "https://github.com/rheo-xyz/named-only"
      },
      {
        path: "lib/branched",
        declared_url: "https://github.com/o/branched",
        url: "https://github.com/o/branched"
      }
    ]);
    expect(parseGitmodules("", "https://github.com/o/r")).toEqual([]);
    expect(resolveSubmoduleUrl("../sibling", "https://github.com/o/r.git")).toBe("https://github.com/o/sibling");
    expect(resolveSubmoduleUrl("./nested", "https://github.com/o/r")).toBe("https://github.com/o/r/nested");
    expect(resolveSubmoduleUrl("../../../too-far", "https://github.com/o/r")).toBeUndefined();
    expect(resolveSubmoduleUrl("../x", "git@github.com:o/r.git")).toBeUndefined();
    expect(classifySubmoduleUrl("https://github.com/o/r").probeable).toBe(true);
    expect(classifySubmoduleUrl("git@github.com:o/r.git").probeable).toBe(true);
    expect(classifySubmoduleUrl("ssh://git@example.com/o/r.git").probeable).toBe(true);
    expect(classifySubmoduleUrl('ext::sh -c "curl attacker"').probeable).toBe(false);
    expect(classifySubmoduleUrl("file:///srv/git/r.git").probeable).toBe(false);
    expect(classifySubmoduleUrl("--upload-pack=touch").probeable).toBe(false);
  });

  it("probes with no credential at all, because the sandbox has none", () => {
    // The crux of this gate: `GITHUB_TOKEN`/`gh` in CI would read a private
    // dependency successfully and report the cohort as healthy.
    const environment = anonymousGitEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      GITHUB_TOKEN: "gho_example",
      GH_TOKEN: "gho_example",
      GIT_ASKPASS: "/usr/bin/askpass",
      SSH_ASKPASS: "/usr/bin/askpass",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: basic Z2l0aHVi",
      GIT_SSH_COMMAND: "ssh -i /home/runner/key",
      SSH_AUTH_SOCK: "/tmp/ssh-XXXX/agent.1234"
    });

    // An scp-like or `ssh://` submodule url is the one form an ambient
    // credential can still authenticate: an agent socket, a `~/.ssh/config`
    // stanza, or a default `~/.ssh/id_*` key would read a private dependency
    // successfully and report the cohort as healthy.
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSH_COMMAND:
        "ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -o IdentityAgent=none -o IdentityFile=/dev/null"
    });
    expect(Object.keys(anonymousRequestHeaders()).map((name) => name.toLowerCase())).not.toContain("authorization");
    const args = anonymousGitArguments("https://github.com/o/r");
    expect(args).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "-c",
      "http.extraHeader=",
      "ls-remote",
      "--heads",
      "https://github.com/o/r"
    ]);
    const source = fs.readFileSync(scriptPath, "utf8");
    expect(source).not.toContain("Authorization");
    expect(source).not.toContain("Bearer");
    expect(source).not.toContain("process.env.GITHUB_TOKEN");
    expect(source).not.toContain("process.env.GH_TOKEN");
    // The REST API's unauthenticated ceiling is 60 requests an hour per IP, and
    // the only way to raise it is the token that would defeat this gate.
    expect(source).not.toContain("https://api.github.com");
  });

  it("exits non-zero from the entrypoint for an unusable invocation", () => {
    for (const args of [[], ["--lane"], ["--lane", "everything"], ["--cohort", "/nonexistent/cohort.json"]]) {
      const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd: repoRoot, encoding: "utf8" });
      expect(result.status, args.join(" ")).not.toBe(0);
    }
    const malformed = spawnSync(
      process.execPath,
      [scriptPath, "--lane", "smoke", "--cohort", writeRawCohort("{ not json")],
      { cwd: repoRoot, encoding: "utf8" }
    );
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain("failed to read benchmark manifest");
  });

  it("gates the producer workflow before any Modal spend, and stays out of the general CI gate", () => {
    const workflowPath = path.join(repoRoot, ".github", "workflows", "eval-benchmarks.yml");
    const workflowText = fs.readFileSync(workflowPath, "utf8");
    const workflow = parseYaml(workflowText) as {
      jobs: Record<
        string,
        {
          steps: Array<{
            name?: string;
            run?: string;
            uses?: string;
            env?: Record<string, string>;
            "continue-on-error"?: boolean;
          }>;
        }
      >;
    };
    const steps = workflow.jobs.launch!.steps;
    const indexOf = (name: string) => steps.findIndex((step) => step.name === name);
    const preflight = steps.findIndex((step) => step.run?.includes("verify-cohort-reachability.mjs") === true);

    expect(preflight).toBeGreaterThan(indexOf("Install and build the candidate"));
    // A broken cohort must cost seconds of preflight, not a paid image build or
    // a detached sandbox that fails pre-model and publishes nothing.
    expect(preflight).toBeLessThan(indexOf("Build an immutable Modal image for the candidate"));
    expect(preflight).toBeLessThan(indexOf("Launch detached Modal benchmark sandboxes"));
    expect(steps[preflight]?.run).toContain('--lane "$BENCHMARK_MODE"');
    // A named denial must stay fatal, so the step may not blanket-tolerate a
    // non-zero exit; only the gate's own inconclusive verdict is tolerated.
    expect(steps[preflight]?.["continue-on-error"]).toBeUndefined();
    expect(steps[preflight]?.run).not.toContain("|| true");
    // An authenticated probe would read the private dependency and pass.
    expect(steps[preflight]?.env ?? {}).toEqual({});
    for (const step of steps) {
      if (step.run?.includes("verify-cohort-reachability.mjs") !== true) continue;
      expect(step.run).not.toContain("GITHUB_TOKEN");
      expect(step.run).not.toContain("GH_TOKEN");
    }
    expect(fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")).not.toContain(
      "verify-cohort-reachability"
    );
  });

  it("blocks the workflow on a denial and only annotates an unproven cohort", () => {
    const workflow = parseYaml(
      fs.readFileSync(path.join(repoRoot, ".github", "workflows", "eval-benchmarks.yml"), "utf8")
    ) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    const script = workflow.jobs.launch!.steps.find(
      (step) => step.run?.includes("verify-cohort-reachability.mjs") === true
    )?.run;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-reachability-wiring-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "scripts", "ci"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "ci", "verify-cohort-reachability.mjs"),
      'console.error("stub reachability report");\nprocess.exitCode = Number(process.env.STUB_EXIT);\n'
    );
    // The producer's own shell: a non-zero exit fails the step unless the script
    // itself decides otherwise.
    const runStep = (exitCode: string) => {
      const summaryPath = path.join(root, `summary-${exitCode}.md`);
      fs.writeFileSync(summaryPath, "");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script!], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BENCHMARK_MODE: "smoke",
          STUB_EXIT: exitCode,
          GITHUB_STEP_SUMMARY: summaryPath
        }
      });
      return { status: result.status, stdout: result.stdout, summary: fs.readFileSync(summaryPath, "utf8") };
    };

    const reachable = runStep("0");
    expect(reachable.status).toBe(0);
    expect(reachable.stdout).toContain("stub reachability report");
    expect(reachable.summary).toBe("");
    // Exit 2 is the gate's own "proved nothing": a resolver blip or a 403
    // throttle may not block a benchmark run on inconclusive evidence.
    const unverified = runStep("2");
    expect(unverified.status).toBe(0);
    expect(unverified.stdout).toContain("::warning title=Cohort reachability unverified::");
    expect(unverified.summary).toContain("Cohort reachability unverified");
    expect(unverified.summary).toContain("stub reachability report");
    // Exit 1 is a named anonymous denial: red in four seconds, instead of a
    // four-hour paid run that reports success and publishes nothing.
    const unreachable = runStep("1");
    expect(unreachable.status).toBe(1);
    expect(unreachable.stdout).toContain("stub reachability report");
    expect(unreachable.stdout).not.toContain("::warning");
    expect(unreachable.summary).toBe("");
  });
});
