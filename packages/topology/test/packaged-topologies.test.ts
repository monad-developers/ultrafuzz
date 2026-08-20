import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { expandTopology, loadTopology } from "../src/index.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOPOLOGY_ROOT = path.join(REPOSITORY_ROOT, "packages", "config", "topologies");

describe("packaged topology collection", () => {
  it("keeps the packaged full graph byte-identical to the initialized project graph", () => {
    const packagedPath = path.join(TOPOLOGY_ROOT, "full.yml");
    const projectPath = path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml");
    expect(fs.readFileSync(packagedPath)).toEqual(fs.readFileSync(projectPath));

    const topology = loadTopology(REPOSITORY_ROOT, {
      topologyPath: packagedPath,
      requirePromptFiles: true
    });
    const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
    for (const id of [
      "reference-vulnerability-database",
      "threat-model",
      "goal-plan",
      "goal-roaming",
      "threat-goals",
      "class-goals"
    ]) {
      expect(nodes.has(id), `${id} must ship in the full topology`).toBe(true);
    }
    expect(nodes.get("threat-goals")?.dynamic?.from).toEqual({ node: "goal-plan", path: "$.threat_goals" });
    expect(nodes.get("class-goals")?.dynamic?.from).toEqual({ node: "goal-plan", path: "$.class_goals" });
  });

  it("validates every shipped topology directly with the built-in prompt catalog", () => {
    for (const name of ["full", "smoke", "invariant-only"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      expect(topology.nodes.length).toBeGreaterThan(2);
    }
  });

  it("keeps the invariant discovery and campaign chain while omitting unrelated strategies", () => {
    const topology = loadTopology(REPOSITORY_ROOT, {
      topologyPath: path.join(TOPOLOGY_ROOT, "invariant-only.yml"),
      requirePromptFiles: true
    });
    const nodeIds = new Set(topology.nodes.map((node) => node.id));
    for (const retained of [
      "project-discovery",
      "base-test-setup",
      "property-specification-fanin",
      "stateful-invariant-setup",
      "stateful-invariant-handlers",
      "stateful-invariant-coverage",
      "stateful-invariant-implement-properties",
      "stateful-invariant-campaign",
      "dedupe-findings",
      "triage",
      "severity-classification",
      "aggregate-test-files",
      "final-report"
    ]) {
      expect(nodeIds.has(retained), `${retained} should be retained`).toBe(true);
    }
    for (const omitted of [
      "boundary-tests",
      "time-warp-sequences",
      "differential-library-tests",
      "differential-oracle-planner",
      "dynamic-strategy-generator"
    ]) {
      expect(nodeIds.has(omitted), `${omitted} should be omitted`).toBe(false);
    }
    expect(topology.nodes.find((node) => node.id === "dedupe-findings")?.prompt).toBe("review/dedupe-findings.md");
    expect(topology.nodes.find((node) => node.id === "aggregate-test-files")?.prompt).toBe(
      "review/aggregate-test-files.md"
    );
    expect(topology.nodes.find((node) => node.id === "stateful-invariant-coverage")?.loops).toBeUndefined();
  });

  it("declares the invariant backend commands in every topology that runs them", () => {
    for (const name of ["full", "invariant-only"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      expect(topology.nodes.find((node) => node.id === "stateful-invariant-coverage")?.required_commands).toEqual([
        "covg-eval",
        "recon",
        "recon-generate"
      ]);
      expect(topology.nodes.find((node) => node.id === "stateful-invariant-campaign")?.required_commands).toEqual([
        "recon"
      ]);
    }
  });

  // Regression guard for #673. `maxAttemptsFor` falls back to 1, so an agentic group that
  // forgets `max_attempts` silently compiles to `retries: 0` and the bounded retry policy
  // from #572 never engages. That is how an 18-hour run ended up with all 179 compiled
  // tasks at `retries: 0`, where one stochastic provider failure was terminal for the node
  // and everything downstream of it.
  it("gives every agentic node in every shipped topology a retry budget", () => {
    for (const name of ["full", "invariant-only", "smoke"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      const graph = expandTopology(topology, { projectRoot: REPOSITORY_ROOT });
      const agentic = graph.nodes.filter((node) => node.kind === "agentic");
      expect(agentic.length, `${name} must ship agentic nodes`).toBeGreaterThan(0);

      const withoutBudget = agentic.filter((node) => node.retryPolicy.maxAttempts < 2).map((node) => node.id);
      expect(
        withoutBudget,
        `${name}.yml compiles these agentic nodes with no retry budget; set max_attempts on their group defaults`
      ).toEqual([]);
    }
  });

  // Regression guard for #675, re-derived for #672/#677.
  //
  // #675's actual defect is a SHADOWING one, not a sizing one. `timeoutSecondsFor` resolves a
  // node pin, then the node's group `timeout_seconds` pin, and `buildSmithersTask` then takes
  // `node.timeoutSeconds ?? profile.timeoutSeconds ?? config.run.defaultTimeoutSeconds`. A pin left
  // behind in a shipped topology therefore wins over both the audit profile and the config default,
  // which is how nodes kept dying at a stale group window in a run configured for a longer one.
  //
  // The first fix raised every pin to 14400 and asserted a floor. That encoded the invariant
  // wrongly in both directions: a floor lets a pin drift upward with no review, and a longer window
  // does not fix a node that never stops — it mostly buys a longer failure, and against
  // `max_attempts: 2` it doubles the worst-case cost of a stuck node (two full windows). The
  // measured cause of nodes hitting their window was a goal statement inflated into a wall of
  // nested JSON, addressed in the goal-plan contract and in the runtime's absolute deadline, not a
  // window that was too short.
  //
  // So the guard is now two-sided, and both sides are the point:
  //   1. every agentic GROUP pin equals the one reviewed agentic window, so changing the window is
  //      a deliberate edit to this constant instead of silent per-topology drift; and
  //   2. no pin — group or node — sits below the largest default it would shadow, read from the
  //      shipped `ultrafuzz.toml` and from every shipped audit profile. That is #675's defect
  //      itself, and it keeps failing if a profile raises `default_timeout_seconds` past a pin.
  const EXPECTED_AGENTIC_TIMEOUT_SECONDS = 7_200;

  /**
   * The largest node timeout that would apply if a pin were removed, and where it comes from.
   * Read from the shipped files rather than hardcoded, so raising a default is what trips the guard.
   */
  function largestShadowedDefault(): { seconds: number; source: string } {
    const toml = fs.readFileSync(path.join(REPOSITORY_ROOT, "ultrafuzz.toml"), "utf8");
    const configured = /^\s*default_timeout_seconds\s*=\s*(\d+)\s*$/mu.exec(toml);
    expect(configured, "ultrafuzz.toml must declare run.default_timeout_seconds").not.toBeNull();
    const candidates = [{ seconds: Number(configured![1]), source: "ultrafuzz.toml `run.default_timeout_seconds`" }];
    const profiles = YAML.parse(
      fs.readFileSync(path.join(REPOSITORY_ROOT, "packages", "config", "audit-profiles.yml"), "utf8")
    ) as { profiles?: Record<string, { settings?: Record<string, unknown> } | null> };
    for (const [profileId, profile] of Object.entries(profiles.profiles ?? {})) {
      const override = profile?.settings?.default_timeout_seconds;
      if (typeof override === "number") {
        candidates.push({ seconds: override, source: `audit profile \`${profileId}\` \`default_timeout_seconds\`` });
      }
    }
    return candidates.reduce((largest, candidate) => (candidate.seconds > largest.seconds ? candidate : largest));
  }

  it("pins every agentic timeout to the reviewed window and never below the default it shadows", () => {
    const shadowed = largestShadowedDefault();
    let pinsChecked = 0;
    for (const name of ["full", "invariant-only", "smoke"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      for (const [groupId, group] of Object.entries(topology.groups)) {
        const pinned = group.defaults?.timeout_seconds;
        if (pinned === undefined) {
          continue;
        }
        const hasAgenticNodes = topology.nodes.some((node) => node.kind === "agentic" && node.group === groupId);
        if (!hasAgenticNodes) {
          continue;
        }
        pinsChecked += 1;
        expect(
          pinned,
          `${name}.yml group \`${groupId}\` pins timeout_seconds=${pinned}; the reviewed agentic window is ${EXPECTED_AGENTIC_TIMEOUT_SECONDS}`
        ).toBe(EXPECTED_AGENTIC_TIMEOUT_SECONDS);
        expect(
          pinned,
          `${name}.yml group \`${groupId}\` pins timeout_seconds=${pinned}, which silently shadows ${shadowed.source}=${shadowed.seconds}`
        ).toBeGreaterThanOrEqual(shadowed.seconds);
      }
      // A node-level pin shadows the same defaults one step earlier in the same resolution order, so
      // it is held to the shadowing rule too. It is deliberately NOT held to the exact window: a
      // single node may legitimately be given a shorter budget than its group, which is a per-node
      // review, whereas a group default governs every agentic node it covers.
      for (const node of topology.nodes) {
        if (node.kind !== "agentic" || node.timeout_seconds === undefined) {
          continue;
        }
        pinsChecked += 1;
        expect(
          node.timeout_seconds,
          `${name}.yml node \`${node.id}\` pins timeout_seconds=${node.timeout_seconds}, which silently shadows ${shadowed.source}=${shadowed.seconds}`
        ).toBeGreaterThanOrEqual(shadowed.seconds);
      }
    }
    // A guard that checks nothing would pass silently if the pins were simply deleted, which is the
    // other way to lose a reviewed window.
    expect(pinsChecked, "the shipped topologies must still pin an agentic timeout somewhere").toBeGreaterThan(0);
  });

  // The other half of the #672/#677 window decision, and the one the reverted 14400 pin made
  // invisible. A group `timeout_seconds` pin is multiplied by that group's `max_attempts` before it
  // is spent: a node that reaches its window is retried, so the worst case a single stuck agentic
  // node can cost is `timeout_seconds * max_attempts`. That product is spent out of the run's
  // `workflow_deadline_seconds`, which each audit profile may pin independently of the topology it
  // selects — so the pin and the deadline are set in two different files by two different edits and
  // nothing connected them. At 7200 x 2 the worst case is 14400, which is a third of the tightest
  // deadline any profile using a pinned topology declares; at 14400 x 2 it would have been 28800 of
  // the same 43200, leaving a real audit two-thirds of its window to do everything else in.
  //
  // This is what makes "is the reviewed window the right size" a mechanical question rather than a
  // taste one, and it fails if either side moves: raising a pin, raising `max_attempts`, or lowering
  // a profile's deadline.
  it("keeps one stuck agentic node from consuming a whole profile's workflow deadline", () => {
    const toml = fs.readFileSync(path.join(REPOSITORY_ROOT, "ultrafuzz.toml"), "utf8");
    const configuredDeadline = /^\s*workflow_deadline_seconds\s*=\s*(\d+)\s*$/mu.exec(toml);
    expect(configuredDeadline, "ultrafuzz.toml must declare run.workflow_deadline_seconds").not.toBeNull();
    const catalogPath = path.join(REPOSITORY_ROOT, "packages", "config", "audit-profiles.yml");
    const catalog = YAML.parse(fs.readFileSync(catalogPath, "utf8")) as {
      profiles?: Record<string, { topology_path?: string; settings?: Record<string, unknown> } | null>;
    };

    let profilesChecked = 0;
    for (const [profileId, profile] of Object.entries(catalog.profiles ?? {})) {
      // `topology_path` is resolved relative to the catalog; a profile that declares none runs the
      // editable project topology, which is the `default` profile's whole point.
      const topologyPath =
        profile?.topology_path === undefined
          ? path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml")
          : path.resolve(path.dirname(catalogPath), profile.topology_path);
      const declaredDeadline = profile?.settings?.workflow_deadline_seconds;
      const deadlineSeconds = typeof declaredDeadline === "number" ? declaredDeadline : Number(configuredDeadline![1]);

      const graph = expandTopology(loadTopology(REPOSITORY_ROOT, { topologyPath, requirePromptFiles: true }), {
        projectRoot: REPOSITORY_ROOT
      });
      for (const node of graph.nodes) {
        if (node.kind !== "agentic" || node.timeoutSeconds === undefined) {
          continue;
        }
        profilesChecked += 1;
        const worstCaseSeconds = node.timeoutSeconds * node.retryPolicy.maxAttempts;
        expect(
          worstCaseSeconds,
          `audit profile \`${profileId}\` runs ${path.basename(topologyPath)} with workflow_deadline_seconds=${deadlineSeconds}, ` +
            `but node \`${node.id}\` can spend ${node.timeoutSeconds} x ${node.retryPolicy.maxAttempts} = ${worstCaseSeconds} seconds of it`
        ).toBeLessThan(deadlineSeconds);
      }
    }
    expect(
      profilesChecked,
      "at least one shipped profile must run a topology with a pinned agentic timeout"
    ).toBeGreaterThan(0);
  });
});
