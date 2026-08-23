import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { expandTopology, loadTopology } from "../src/index.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOPOLOGY_ROOT = path.join(REPOSITORY_ROOT, "packages", "config", "topologies");
const PACKAGED_TOPOLOGY_IDS = ["default", "full", "smoke", "invariant-only"] as const;
const DIRECT_BUG_FIRST_STRATEGIES = [
  "boundary-tests",
  "encode-decode",
  "differential-library-tests",
  "round-trip",
  "workflow-property-based-tests",
  "time-warp-sequences",
  "expand-coverage",
  "admin-config-boundaries",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "amm-boundary-liquidity",
  "payable-fallback-accounting",
  "packed-action-parity",
  "batch-atomicity-unsupported-actions",
  "router-exact-accounting",
  "rounding-direction-audit",
  "market-exhaustion-boundaries",
  "order-replacement-collateral",
  "state-machine-boundaries",
  "lifecycle-view-boundaries"
] as const;
const STATEFUL_SPECIALIST_STRATEGIES = [
  "stateful-invariant-setup",
  "stateful-invariant-handlers",
  "stateful-invariant-coverage",
  "stateful-invariant-implement-properties",
  "stateful-invariant-campaign"
] as const;
const DEEP_DIFFERENTIAL_SPECIALIST_STRATEGIES = [
  "differential-oracle-planner",
  "reference-harness-author",
  "reference-and-lane-auditor",
  "differential-lane-author",
  "differential-red-triage",
  "differential-repair-and-report-review"
] as const;
const NONDEFAULT_SPECIALIST_STRATEGIES = [
  ...STATEFUL_SPECIALIST_STRATEGIES,
  ...DEEP_DIFFERENTIAL_SPECIALIST_STRATEGIES,
  "dynamic-strategy-generator"
] as const;

interface OutputRole {
  findings: number;
  generatedTests: number;
}

const FINDINGS_WITH_OPTIONAL_TESTS: OutputRole = { findings: 1, generatedTests: 1 };
const FINDINGS_ONLY: OutputRole = { findings: 1, generatedTests: 0 };
const NO_FINDINGS_NO_TESTS: OutputRole = { findings: 0, generatedTests: 0 };
const NO_FINDINGS_WITH_GENERATED_TESTS: OutputRole = { findings: 0, generatedTests: 1 };

const DEFAULT_PROFILE_ROLES: Record<string, OutputRole> = Object.fromEntries(
  DIRECT_BUG_FIRST_STRATEGIES.map((id) => [id, FINDINGS_WITH_OPTIONAL_TESTS])
);
const FULL_PROFILE_ROLES: Record<string, OutputRole> = {
  ...DEFAULT_PROFILE_ROLES,
  "stateful-invariant-setup": FINDINGS_ONLY,
  "stateful-invariant-handlers": FINDINGS_ONLY,
  "stateful-invariant-coverage": FINDINGS_WITH_OPTIONAL_TESTS,
  "stateful-invariant-implement-properties": FINDINGS_WITH_OPTIONAL_TESTS,
  "stateful-invariant-campaign": FINDINGS_WITH_OPTIONAL_TESTS,
  "differential-oracle-planner": NO_FINDINGS_NO_TESTS,
  "reference-harness-author": NO_FINDINGS_WITH_GENERATED_TESTS,
  "reference-and-lane-auditor": NO_FINDINGS_NO_TESTS,
  "differential-lane-author": FINDINGS_WITH_OPTIONAL_TESTS,
  "differential-red-triage": NO_FINDINGS_NO_TESTS,
  "differential-repair-and-report-review": FINDINGS_WITH_OPTIONAL_TESTS,
  "dynamic-strategy-generator": FINDINGS_WITH_OPTIONAL_TESTS
};

// Every shipped topology file must appear here with per-node output roles;
// the role test fails when a topology file exists without a declaration.
const EXPECTED_ROLES_BY_TOPOLOGY: Record<string, Record<string, OutputRole>> = {
  "default.yml": DEFAULT_PROFILE_ROLES,
  "full.yml": FULL_PROFILE_ROLES,
  "invariant-only.yml": {
    "stateful-invariant-setup": FINDINGS_ONLY,
    "stateful-invariant-handlers": FINDINGS_ONLY,
    "stateful-invariant-coverage": FINDINGS_WITH_OPTIONAL_TESTS,
    "stateful-invariant-implement-properties": FINDINGS_WITH_OPTIONAL_TESTS,
    "stateful-invariant-campaign": FINDINGS_WITH_OPTIONAL_TESTS
  },
  "smoke.yml": {
    "time-warp-sequences": FINDINGS_WITH_OPTIONAL_TESTS,
    "external-dependency-boundaries": FINDINGS_WITH_OPTIONAL_TESTS,
    "externalized-state-accounting": FINDINGS_WITH_OPTIONAL_TESTS,
    "lifecycle-view-boundaries": FINDINGS_WITH_OPTIONAL_TESTS,
    "json-validation-correction": FINDINGS_ONLY
  }
};

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

  it("binds every packaged output to one current central contract and every JSON output to a registered schema", () => {
    const currentContracts = new Set<string>(ARTIFACT_CONTRACT_IDS);
    const nonJsonContracts = new Set<string>(NON_JSON_ARTIFACT_CONTRACT_IDS);
    for (const name of PACKAGED_TOPOLOGY_IDS) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      for (const node of topology.nodes) {
        for (const output of node.outputs ?? []) {
          expect(currentContracts.has(output.contract), `${name}:${node.id}/${output.path}`).toBe(true);
          if (!nonJsonContracts.has(output.contract)) {
            expect(artifactContractSchemaBinding(output.contract), `${name}:${node.id}/${output.path}`).toBeDefined();
          }
        }
      }
    }
  });

  it("keeps the packaged default byte-aligned and shared profile handoffs aligned with canonical producers", () => {
    expect(readFileSync(path.join(TOPOLOGY_ROOT, "default.yml"))).toEqual(
      readFileSync(path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml"))
    );
    const canonical = loadTopology(REPOSITORY_ROOT, {
      topologyPath: path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml"),
      requirePromptFiles: true
    });
    const canonicalOutputs = new Map(
      canonical.nodes.map((node) => [
        node.id,
        (node.outputs ?? [])
          .map((output) => [output.path, output.contract] as const)
          .sort(([left], [right]) => left.localeCompare(right))
      ])
    );
    for (const name of ["full", "invariant-only"]) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath: path.join(TOPOLOGY_ROOT, `${name}.yml`),
        requirePromptFiles: true
      });
      for (const node of topology.nodes) {
        const expected = canonicalOutputs.get(node.id);
        if (expected === undefined) continue;
        const actual = (node.outputs ?? [])
          .map((output) => [output.path, output.contract] as const)
          .sort(([left], [right]) => left.localeCompare(right));
        expect(actual, `${name}:${node.id}`).toEqual(expected);
      }
    }
  });

  it("keeps issue 5 strategy output roles aligned in the canonical topology and every packaged topology", () => {
    const packagedFiles = readdirSync(TOPOLOGY_ROOT)
      .filter((entry) => entry.endsWith(".yml"))
      .sort();
    expect(packagedFiles, "every packaged topology file needs declared output roles").toEqual(
      Object.keys(EXPECTED_ROLES_BY_TOPOLOGY).sort()
    );

    const targets: Array<readonly [string, string, Record<string, OutputRole>]> = [
      ["canonical", path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml"), DEFAULT_PROFILE_ROLES],
      ...packagedFiles.map((file) => [file, path.join(TOPOLOGY_ROOT, file), EXPECTED_ROLES_BY_TOPOLOGY[file]!] as const)
    ];

    for (const [name, topologyPath, expectedRoles] of targets) {
      const topology = loadTopology(REPOSITORY_ROOT, {
        topologyPath,
        requirePromptFiles: true
      });
      const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
      const contractsFor = (id: string): string[] => (nodeById.get(id)?.outputs ?? []).map((output) => output.contract);

      for (const [id, role] of Object.entries(expectedRoles)) {
        expect(nodeById.has(id), `${name}:${id} exists`).toBe(true);
        const contracts = contractsFor(id);
        expect(
          contracts.filter((contract) => contract === "ultrafuzz/findings@2"),
          `${name}:${id} findings`
        ).toHaveLength(role.findings);
        expect(
          contracts.filter((contract) => contract === "ultrafuzz/generated-tests@3"),
          `${name}:${id} generated tests`
        ).toHaveLength(role.generatedTests);
      }

      if (expectedRoles === DEFAULT_PROFILE_ROLES || expectedRoles === FULL_PROFILE_ROLES) {
        expect(
          (nodeById.get("boundary-tests")?.outputs ?? []).map((output) => [
            output.path,
            output.contract,
            output.primary === true
          ]),
          `${name}:boundary-tests`
        ).toEqual([
          ["boundary-recipes.md", "ultrafuzz/nonempty-markdown@1", false],
          ["boundary-recipes.json", "ultrafuzz/boundary-recipes@1", false],
          ["findings.json", "ultrafuzz/findings@2", true],
          ["generated-tests.json", "ultrafuzz/generated-tests@3", false]
        ]);
        for (const id of DIRECT_BUG_FIRST_STRATEGIES) {
          const outputs = nodeById.get(id)?.outputs ?? [];
          expect(
            outputs.filter((output) => output.contract === "ultrafuzz/findings@2"),
            `${name}:${id} primary findings`
          ).toEqual([
            expect.objectContaining({ path: "findings.json", contract: "ultrafuzz/findings@2", primary: true })
          ]);
          expect(
            outputs.filter((output) => output.contract === "ultrafuzz/generated-tests@3"),
            `${name}:${id} empty-capable generated-test transport`
          ).toEqual([
            expect.objectContaining({ path: "generated-tests.json", contract: "ultrafuzz/generated-tests@3" })
          ]);
        }
      }
    }
  });

  it("keeps ordinary discovery direct-only while the full profile ships every specialist lane", () => {
    const canonical = loadTopology(REPOSITORY_ROOT, {
      topologyPath: path.join(REPOSITORY_ROOT, ".ultrafuzz", "topology.yml"),
      requirePromptFiles: true
    });
    const full = loadTopology(REPOSITORY_ROOT, {
      topologyPath: path.join(TOPOLOGY_ROOT, "full.yml"),
      requirePromptFiles: true
    });
    const canonicalIds = new Set(canonical.nodes.map((node) => node.id));
    const fullIds = new Set(full.nodes.map((node) => node.id));

    expect(DIRECT_BUG_FIRST_STRATEGIES).toHaveLength(20);
    for (const id of DIRECT_BUG_FIRST_STRATEGIES) {
      expect(canonicalIds.has(id), `canonical:${id}`).toBe(true);
      expect(fullIds.has(id), `full:${id}`).toBe(true);
    }
    expect(canonicalIds.has("differential-library-tests"), "the fast direct differential scout stays default").toBe(
      true
    );
    expect(STATEFUL_SPECIALIST_STRATEGIES).toHaveLength(5);
    expect(DEEP_DIFFERENTIAL_SPECIALIST_STRATEGIES).toHaveLength(6);
    for (const id of NONDEFAULT_SPECIALIST_STRATEGIES) {
      expect(canonicalIds.has(id), `canonical excludes specialist ${id}`).toBe(false);
      expect(fullIds.has(id), `full retains specialist ${id}`).toBe(true);
    }

    expect(canonical.nodes.find((node) => node.id === "dedupe-findings")?.depends_on).toEqual([
      ...DIRECT_BUG_FIRST_STRATEGIES
    ]);
    expect(full.groups.specialists?.defaults?.failure_policy).toBe("continue");
    expect(full.nodes.find((node) => node.id === "dedupe-findings")?.depends_on).toEqual([
      ...DIRECT_BUG_FIRST_STRATEGIES,
      "stateful-invariant-campaign",
      "differential-repair-and-report-review",
      "dynamic-strategy-generator"
    ]);
    for (const id of NONDEFAULT_SPECIALIST_STRATEGIES) {
      expect(full.nodes.find((node) => node.id === id)?.group, `full optional group:${id}`).toBe("specialists");
    }
    expect(full.nodes.find((node) => node.id === "dynamic-strategy-generator")?.depends_on).toEqual([
      ...DIRECT_BUG_FIRST_STRATEGIES
    ]);
    expect(full.nodes.find((node) => node.id === "__finish__")?.depends_on).toEqual(["final-report"]);
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
    for (const name of ["full", "fuzz-only", "invariant-only", "smoke"]) {
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
    for (const name of ["full", "fuzz-only", "invariant-only", "smoke"]) {
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
