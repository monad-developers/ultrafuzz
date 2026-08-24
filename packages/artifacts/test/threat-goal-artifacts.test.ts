import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GOAL_PLAN_POLICY,
  GOAL_PLAN_SCHEMA_VERSION,
  THREAT_MODEL_SCHEMA_VERSION,
  buildFindingSourceExpectations,
  goalPlanExpansionFacts,
  materializeCanonicalThreatModelMarkdown,
  renderThreatModelMarkdown,
  normalizeFindings,
  validateArtifactContract,
  validateGoalPlan,
  validateThreatModel,
  verifyThreatModelEvidenceFiles,
  verifyGoalPlanSelectedRecordSnapshotBytes,
  verifyGoalPlanSelectedRecordSnapshots,
  verifyGoalPlanThreatModelBytes,
  isNamespacedDynamicReplacementKey,
  promptTemplateOccurrences
} from "../src/index.js";

const digest = "a".repeat(64);

/** The limit these fixtures plan under; large enough that no fixture is near it. */
const FIXTURE_MAX_DYNAMIC_NODES = 2048;

/**
 * Fill in the planner-recorded expansion facts for a fixture whose goals have just changed.
 *
 * Fixtures exercise other properties of the contract, so they record the facts the same way the
 * planner does rather than restating them by hand. The dedicated cardinality tests below assert the
 * literal values instead, so this convenience never stands in for the assertion.
 */
function sealGoalPlanCardinality(plan: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(
    plan,
    goalPlanExpansionFacts({
      threat_goals: plan.threat_goals as Array<{ id: string; node_id: string }>,
      class_goals: plan.class_goals as Array<{ id: string; node_id: string }>,
      roaming_goal: plan.roaming_goal as { node_id: string },
      max_dynamic_nodes: FIXTURE_MAX_DYNAMIC_NODES
    })
  );
}

function threatModelFixture(): Record<string, unknown> {
  const evidence = [{ path: "src/Pool.sol", line: 10, symbol: "liquidate" }];
  return {
    schema_version: THREAT_MODEL_SCHEMA_VERSION,
    title: "Protocol threat model",
    scope: {
      summary: "The protocol-owned contracts and their documented integrations are in scope.",
      repository_evidence: evidence,
      exclusions: []
    },
    protocol: {
      summary: "A collateralized lending protocol with permissionless liquidation.",
      archetypes: ["collateralized lending"]
    },
    capabilities: [
      {
        id: "lending.liquidation",
        status: "present",
        rationale: "The pool exposes a liquidation entry point.",
        evidence
      },
      {
        id: "cross-chain.messaging",
        status: "unknown",
        rationale: "No cross-chain integration was established from the inspected scope.",
        evidence: []
      }
    ],
    assets: [
      {
        id: "asset:collateral",
        name: "Borrower collateral",
        description: "Collateral held by the pool.",
        value_at_risk: "All deposited collateral.",
        evidence
      }
    ],
    actors: [
      {
        id: "actor:liquidator",
        name: "Liquidator",
        role: "Repays unhealthy debt in exchange for collateral.",
        trust: "untrusted",
        privileges: [],
        evidence
      }
    ],
    trust_boundaries: [
      {
        id: "boundary:external-call",
        name: "External caller boundary",
        description: "Untrusted callers enter protocol accounting.",
        actor_ids: ["actor:liquidator"],
        evidence
      }
    ],
    attack_surfaces: [
      {
        id: "surface:liquidation",
        name: "Liquidation",
        description: "Liquidation mutates borrower debt and collateral.",
        entry_points: ["Pool.liquidate"],
        asset_ids: ["asset:collateral"],
        actor_ids: ["actor:liquidator"],
        capability_ids: ["lending.liquidation"],
        trust_boundary_ids: ["boundary:external-call"],
        evidence
      }
    ],
    value_flows: [
      {
        id: "flow:liquidation",
        name: "Liquidation value flow",
        description: "Debt is repaid and collateral leaves the pool.",
        steps: ["Repay debt.", "Transfer collateral."],
        asset_ids: ["asset:collateral"],
        actor_ids: ["actor:liquidator"],
        evidence
      }
    ],
    lifecycle_transitions: [
      {
        id: "lifecycle:overdue-liquidation",
        name: "Overdue liquidation",
        from: "healthy",
        to: "liquidatable",
        trigger: "Debt becomes overdue.",
        guards: ["Position is unhealthy."],
        effects: ["Debt and collateral accounting change."],
        evidence
      }
    ],
    invariants: [
      {
        id: "invariant:solvency",
        name: "Solvency",
        kind: "economic",
        statement: "Recorded debt and collateral remain solvent across liquidation.",
        asset_ids: ["asset:collateral"],
        capability_ids: ["lending.liquidation"],
        evidence
      }
    ],
    threats: [
      {
        id: "liquidation:overdue",
        title: "Overdue liquidation can be bypassed",
        description: "A state transition can liquidate at the wrong lifecycle boundary.",
        preconditions: ["A fixed-term position exists."],
        impact: "Bad debt or premature collateral seizure.",
        asset_ids: ["asset:collateral"],
        actor_ids: ["actor:liquidator"],
        attack_surface_ids: ["surface:liquidation"],
        capability_ids: ["lending.liquidation"],
        trust_boundary_ids: ["boundary:external-call"],
        invariant_ids: ["invariant:solvency"],
        assumption_ids: [],
        unknown_ids: [],
        evidence
      }
    ],
    assumptions: [],
    unknowns: [],
    coverage_gaps: []
  };
}

function goalPlanFixture(threatCount = 1): Record<string, unknown> {
  const ids = Array.from({ length: threatCount }, (_, index) =>
    index === 0 ? "liquidation:overdue" : "surface:threat-" + String(index).padStart(3, "0")
  );
  const threatGoals = ids.map((id) => ({
    kind: "threat",
    id,
    node_id: "dynamic:threat:" + id,
    title: "Investigate " + id,
    threat_ids: [id],
    class_ids: [],
    attack_surface_ids: ["surface:liquidation"],
    goal_prompt:
      "Your /goal is to find any vulnerability affecting this surface using threat model threat {{" + id + "}}.",
    replacements: {
      [id]: "Threat " + id + " with its full assets, preconditions, evidence, and invariant context."
    },
    selection_rationale: "The additive policy runs every modeled threat."
  }));
  return sealGoalPlanCardinality({
    schema_version: GOAL_PLAN_SCHEMA_VERSION,
    policy: GOAL_PLAN_POLICY,
    threat_model_sha256: digest,
    vulnerability_database: {
      planner_catalog_schema_version: "ultrafuzz.vulnerability-db.planner-catalog.v1",
      snapshot_manifest_schema_version: "ultrafuzz.vulnerability-db.snapshot.v1",
      database_schema_version: 1,
      aggregate_sha256: digest,
      catalog_sha256: digest
    },
    catalog_class_ids: [],
    modeled_threat_ids: ids,
    threat_goals: threatGoals,
    class_goals: [],
    applicability_decisions: [],
    selected_class_records: [],
    roaming_goal: {
      node_id: "goal-roaming",
      prompt_path: "strategies/roaming-goal.md",
      purpose: "Challenge taxonomy and threat-model completeness."
    },
    counts: {
      threats: threatCount,
      applicable_classes: 0,
      inapplicable_classes: 0,
      dynamic_goals: threatCount,
      total_goals: threatCount + 1
    }
  });
}

test("threat model validates evidence-backed capability states and renders canonical Markdown", () => {
  const result = validateThreatModel(threatModelFixture());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.value);

  const markdown = renderThreatModelMarkdown(result.value!);
  assert.match(markdown, /^# Protocol threat model$/mu);
  assert.match(markdown, /^## Capabilities$/mu);
  assert.match(markdown, /^## Threats$/mu);
  assert.match(markdown, /liquidation:overdue/u);
  assert.match(markdown, /^## Unknowns$/mu);
  assert.doesNotMatch(markdown, /remediation backlog|LINDDUN|ARI/u);
  assert.equal(validateArtifactContract("ultrafuzz/threat-model@1", JSON.stringify(threatModelFixture())).ok, true);
});

test("runtime materialization replaces agent Markdown with the exact canonical threat-model rendering", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-threat-model-"));
  fs.writeFileSync(path.join(artifactDir, "threat-model.json"), JSON.stringify(threatModelFixture()));
  fs.writeFileSync(path.join(artifactDir, "THREAT_MODEL.md"), "# Agent rendering that may drift\n");

  const materialized = materializeCanonicalThreatModelMarkdown(artifactDir);
  const expected = renderThreatModelMarkdown(validateThreatModel(threatModelFixture()).value!);

  assert.equal(materialized.markdown, expected);
  assert.equal(fs.readFileSync(materialized.markdownPath, "utf8"), expected);
  assert.doesNotMatch(expected, /Agent rendering that may drift/u);
});

test("threat model rejects unevidenced present or absent capabilities and broken references", () => {
  const unevidenced = threatModelFixture();
  const capabilities = unevidenced.capabilities as Array<Record<string, unknown>>;
  capabilities[0] = { ...capabilities[0], status: "absent", evidence: [] };
  assert.equal(validateThreatModel(unevidenced).ok, false);

  const broken = threatModelFixture();
  const threats = broken.threats as Array<Record<string, unknown>>;
  threats[0] = { ...threats[0], asset_ids: ["asset:missing"] };
  const result = validateThreatModel(broken);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /Unknown reference asset:missing/u.test(issue.message)));
});

test("threat model evidence paths are bounded canonical repository-relative POSIX paths", () => {
  const invalidPaths = [
    "",
    ".",
    "..",
    "../Pool.sol",
    "/etc/passwd",
    "C:/Windows/System32/config",
    "C:\\Windows\\System32\\config",
    "https://example.com/Pool.sol",
    "file:src/Pool.sol",
    "src\\Pool.sol",
    "src//Pool.sol",
    "src/",
    "src/./Pool.sol",
    "src/lib/../Pool.sol",
    "src/Pool\u0001.sol",
    "a".repeat(513)
  ];
  for (const invalidPath of invalidPaths) {
    const model = threatModelFixture();
    (model.scope as { repository_evidence: Array<{ path: string }> }).repository_evidence[0]!.path = invalidPath;
    const result = validateThreatModel(model);
    assert.equal(result.ok, false, `expected evidence path to fail: ${JSON.stringify(invalidPath)}`);
    assert.ok(
      result.issues.some((issue) => /canonical relative POSIX repository path|Too (?:big|small)/u.test(issue.message)),
      JSON.stringify(result.issues)
    );
  }
});

test("goal-plan applicability evidence uses the strict repository-path contract", () => {
  const plan = goalPlanFixture();
  plan.catalog_class_ids = ["liquidation:class-a"];
  plan.applicability_decisions = [
    {
      class_id: "liquidation:class-a",
      decision: "inapplicable",
      checks: [
        {
          capability_id: "lending.liquidation",
          requirement: "required",
          observed_status: "absent",
          evidence: [{ path: "src/Pool.sol", line: 10 }],
          rationale: "Repository evidence establishes that the required capability is absent."
        }
      ],
      rationale: "The required capability is evidence-backed absent."
    }
  ];
  plan.counts = {
    threats: 1,
    applicable_classes: 0,
    inapplicable_classes: 1,
    dynamic_goals: 1,
    total_goals: 2
  };
  sealGoalPlanCardinality(plan);
  assert.equal(validateGoalPlan(plan).ok, true);

  for (const invalidPath of [
    "../Pool.sol",
    "/etc/passwd",
    "C:/Windows/System32/config",
    "src\\Pool.sol",
    "https://example.com/Pool.sol",
    "file:src/Pool.sol",
    "src/./Pool.sol",
    "src/Pool\u0001.sol"
  ]) {
    const invalid = structuredClone(plan);
    const decisions = invalid.applicability_decisions as Array<{
      checks: Array<{ evidence: Array<{ path: string }> }>;
    }>;
    decisions[0]!.checks[0]!.evidence[0]!.path = invalidPath;
    assert.equal(validateGoalPlan(invalid).ok, false, `expected evidence path to fail: ${JSON.stringify(invalidPath)}`);
  }
});

test("threat model evidence publication requires regular files inside the exact workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-threat-evidence-workspace-"));
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "Pool.sol"), "contract Pool {}\n", "utf8");
  const model = validateThreatModel(threatModelFixture()).value!;
  assert.deepEqual(verifyThreatModelEvidenceFiles(model, workspace), ["src/Pool.sol"]);

  fs.unlinkSync(path.join(workspace, "src", "Pool.sol"));
  assert.throws(() => verifyThreatModelEvidenceFiles(model, workspace), /does not exist/u);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-threat-evidence-outside-"));
  fs.writeFileSync(path.join(outside, "Pool.sol"), "contract Outside {}\n", "utf8");
  fs.symlinkSync(path.join(outside, "Pool.sol"), path.join(workspace, "src", "Pool.sol"));
  assert.throws(() => verifyThreatModelEvidenceFiles(model, workspace), /cannot be a symlink/u);
});

test("additive goal plans preserve all 100 threats plus the fixed roaming goal", () => {
  const plan = goalPlanFixture(100);
  const result = validateGoalPlan(plan);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.value?.threat_goals.length, 100);
  assert.equal(result.value?.counts.dynamic_goals, 100);
  assert.equal(result.value?.counts.total_goals, 101);
  assert.equal(validateArtifactContract("ultrafuzz/goal-plan@1", JSON.stringify(plan)).ok, true);
});

test("goal plans record their own expected dynamic-child cardinality and name every goal lane", () => {
  // #364: the planner writes the expectation down so the eval side can compare against the run
  // without recomputing the rule. The rule is `threats + applicable classes`; the fixed roaming node
  // is a static topology node, so it is a named lane but never a dynamic child.
  const plan = goalPlanFixture(3);
  const result = validateGoalPlan(plan);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.value?.threat_count, 3);
  assert.equal(result.value?.applicable_class_count, 0);
  assert.equal(result.value?.expected_child_count, 3);
  assert.equal(result.value?.max_dynamic_nodes, FIXTURE_MAX_DYNAMIC_NODES);
  assert.deepEqual(
    result.value?.goal_lanes.map((lane) => [lane.kind, lane.lane_id, ...lane.node_ids]),
    [
      ["threat", "liquidation:overdue", "dynamic:threat:liquidation:overdue"],
      ["threat", "surface:threat-001", "dynamic:threat:surface:threat-001"],
      ["threat", "surface:threat-002", "dynamic:threat:surface:threat-002"],
      ["roaming", "goal-roaming", "goal-roaming"]
    ]
  );

  for (const field of [
    "expected_child_count",
    "threat_count",
    "applicable_class_count",
    "max_dynamic_nodes"
  ] as const) {
    const missing = structuredClone(plan);
    delete missing[field];
    assert.equal(validateGoalPlan(missing).ok, false, `${field} must be required`);
  }
  const missingLanes = structuredClone(plan);
  delete missingLanes.goal_lanes;
  assert.equal(validateGoalPlan(missingLanes).ok, false, "goal_lanes must be required");

  // A number that disagrees with the plan it sits in is rejected here, so the eval side can trust
  // that a mismatch it reports is between the planner and the runtime, not inside the plan.
  const understated = structuredClone(plan);
  understated.expected_child_count = 2;
  const understatedResult = validateGoalPlan(understated);
  assert.equal(understatedResult.ok, false);
  assert.ok(understatedResult.issues.some((issue) => /expected_child_count must equal 3/u.test(issue.message)));

  const wrongThreatCount = structuredClone(plan);
  wrongThreatCount.threat_count = 2;
  assert.equal(validateGoalPlan(wrongThreatCount).ok, false);

  // A plan that expects more children than the run is configured to create can only abort the
  // expansion, so it fails as a plan rather than at expansion time.
  const oversized = structuredClone(plan);
  oversized.max_dynamic_nodes = 2;
  const oversizedResult = validateGoalPlan(oversized);
  assert.equal(oversizedResult.ok, false);
  assert.ok(oversizedResult.issues.some((issue) => /exceeding max_dynamic_nodes=2/u.test(issue.message)));

  const droppedLane = structuredClone(plan);
  (droppedLane.goal_lanes as unknown[]).pop();
  assert.equal(validateGoalPlan(droppedLane).ok, false, "a lane must exist for every goal");

  const renamedLane = structuredClone(plan);
  (renamedLane.goal_lanes as Array<Record<string, unknown>>)[0]!.node_ids = ["dynamic:threat:not-the-goal"];
  assert.equal(validateGoalPlan(renamedLane).ok, false, "a lane must own the node ID its goal declares");
});

test("goal-plan lanes cover applicable class goals alongside their threat goals", () => {
  const plan = classGoalPlanFixture("vulnerability-db/selected/accounting/share-inflation.md");
  const result = validateGoalPlan(plan);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.value?.threat_count, 1);
  assert.equal(result.value?.applicable_class_count, 1);
  assert.equal(result.value?.expected_child_count, 2);
  assert.deepEqual(
    result.value?.goal_lanes.map((lane) => lane.kind),
    ["threat", "class", "roaming"]
  );
  assert.deepEqual(result.value?.goal_lanes[1]?.node_ids, ["dynamic:class:accounting:share-inflation"]);
});

test("goal plans bind to the exact upstream threat-model JSON bytes", () => {
  const threatModelBytes = Buffer.from(`${JSON.stringify(threatModelFixture(), null, 2)}\n`, "utf8");
  const plan = goalPlanFixture();
  plan.threat_model_sha256 = crypto.createHash("sha256").update(threatModelBytes).digest("hex");

  assert.equal(verifyGoalPlanThreatModelBytes(plan, threatModelBytes).threat_model_sha256, plan.threat_model_sha256);
  assert.throws(
    () => verifyGoalPlanThreatModelBytes(plan, Buffer.concat([threatModelBytes, Buffer.from("\n")])),
    /does not match the upstream threat-model\.json bytes/u
  );
});

test("goal plans decide every planner-catalog class exactly once", () => {
  const plan = goalPlanFixture();
  plan.catalog_class_ids = ["liquidation:class-a", "liquidation:class-b"];
  plan.applicability_decisions = ["liquidation:class-a", "liquidation:class-b"].map((classId) => ({
    class_id: classId,
    decision: "inapplicable",
    checks: [
      {
        capability_id: "lending.liquidation",
        requirement: "required",
        observed_status: "absent",
        evidence: [{ path: "src/Pool.sol", line: 10, note: "No liquidation entry point is present." }],
        rationale: "Repository evidence proves that the required capability is absent."
      }
    ],
    rationale: "The required capability is evidence-backed absent."
  }));
  plan.counts = {
    threats: 1,
    applicable_classes: 0,
    inapplicable_classes: 2,
    dynamic_goals: 1,
    total_goals: 2
  };
  sealGoalPlanCardinality(plan);
  assert.equal(validateGoalPlan(plan).ok, true);

  const missing = structuredClone(plan);
  (missing.applicability_decisions as unknown[]).pop();
  assert.equal(validateGoalPlan(missing).ok, false);

  const unknown = structuredClone(plan);
  (unknown.applicability_decisions as unknown[]).push({
    ...(unknown.applicability_decisions as Array<Record<string, unknown>>)[0],
    class_id: "liquidation:not-in-catalog"
  });
  assert.equal(validateGoalPlan(unknown).ok, false);
});

test("goal plans retain exact item-scoped MDX replacements for threat and class goals", () => {
  const plan = goalPlanFixture();
  const classId = "liquidation:fixed-term-before-overdue";
  const record = {
    id: classId,
    path: "vulnerability-db/selected/liquidation/fixed-term-before-overdue.md",
    sha256: digest,
    size_bytes: 1024
  };
  plan.catalog_class_ids = [classId];
  (plan.class_goals as unknown[]) = [
    {
      kind: "class",
      id: classId,
      node_id: "dynamic:class:" + classId,
      class_id: classId,
      class_replacement_key: "class:liquidation:fixed-term-before-overdue",
      title: "Fixed-term liquidation before overdue",
      threat_ids: ["liquidation:overdue"],
      threat_replacement_keys: ["liquidation:overdue"],
      attack_surface_ids: ["surface:liquidation"],
      coverage_gap: false,
      selected_record: record,
      goal_prompt:
        "Your /goal is to find a vulnerability of type {{class:liquidation:fixed-term-before-overdue}} using threat model {{liquidation:overdue}}.",
      replacements: {
        "class:liquidation:fixed-term-before-overdue": "Full vulnerability-class instructions and examples.",
        "liquidation:overdue": "Full threat-model context for overdue liquidation."
      },
      selection_rationale: "Liquidation is evidence-backed present."
    }
  ];
  (plan.applicability_decisions as unknown[]) = [
    {
      class_id: classId,
      decision: "applicable",
      checks: [
        {
          capability_id: "lending.liquidation",
          requirement: "required",
          observed_status: "unknown",
          evidence: [],
          rationale: "Unknown does not become a hard exclusion."
        }
      ],
      rationale: "The unknown capability state keeps this class eligible for review."
    }
  ];
  plan.selected_class_records = [record];
  plan.counts = {
    threats: 1,
    applicable_classes: 1,
    inapplicable_classes: 0,
    dynamic_goals: 2,
    total_goals: 3
  };
  sealGoalPlanCardinality(plan);

  const result = validateGoalPlan(plan);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.match(result.value?.class_goals[0]?.goal_prompt ?? "", /\{\{liquidation:overdue\}\}/u);
  assert.equal(
    result.value?.class_goals[0]?.replacements["liquidation:overdue"],
    "Full threat-model context for overdue liquidation."
  );

  const invalid = structuredClone(plan);
  (invalid.applicability_decisions as Array<Record<string, unknown>>)[0]!.decision = "inapplicable";
  assert.equal(validateGoalPlan(invalid).ok, false, "unknown must not silently become an evidence-backed exclusion");

  const unrelatedReplacement = structuredClone(plan);
  const unrelatedGoal = (unrelatedReplacement.class_goals as Array<Record<string, unknown>>)[0]!;
  unrelatedGoal.threat_replacement_keys = ["liquidation:overdue", "liquidation:unrelated"];
  unrelatedGoal.goal_prompt = String(unrelatedGoal.goal_prompt) + " Also inspect {{liquidation:unrelated}}.";
  unrelatedGoal.replacements = {
    ...(unrelatedGoal.replacements as Record<string, unknown>),
    "liquidation:unrelated": "Unrelated context must not expand this class goal."
  };
  assert.equal(validateGoalPlan(unrelatedReplacement).ok, false);
});

test("goal-plan dynamic provenance IDs retain valid dotted threat and class segments", () => {
  const plan = goalPlanFixture();
  const threatId = "oracle:price.v2";
  const classId = "oracle.v2:stale-price";
  const threatGoal = (plan.threat_goals as Array<Record<string, unknown>>)[0]!;
  plan.modeled_threat_ids = [threatId];
  threatGoal.id = threatId;
  threatGoal.node_id = `dynamic:threat:${threatId}`;
  threatGoal.threat_ids = [threatId];
  threatGoal.class_ids = [classId];
  threatGoal.goal_prompt = `Your /goal is to inspect the modeled oracle threat {{${threatId}}}.`;
  threatGoal.replacements = { [threatId]: "Full dotted threat-model context." };
  const selectedRecord = {
    id: classId,
    path: "vulnerability-db/selected/oracle/stale-price.md",
    sha256: digest,
    size_bytes: 256
  };
  plan.catalog_class_ids = [classId];
  plan.class_goals = [
    {
      kind: "class",
      id: classId,
      node_id: `dynamic:class:${classId}`,
      class_id: classId,
      class_replacement_key: `class:${classId}`,
      threat_ids: [threatId],
      threat_replacement_keys: [threatId],
      attack_surface_ids: ["surface:oracle"],
      coverage_gap: false,
      title: "Stale price",
      selected_record: selectedRecord,
      goal_prompt: `Your /goal is to find {{class:${classId}}} using threat model {{${threatId}}}.`,
      replacements: {
        [`class:${classId}`]: "Full dotted vulnerability-class instructions.",
        [threatId]: "Full dotted threat-model context."
      },
      selection_rationale: "The class is applicable to the modeled oracle threat."
    }
  ];
  plan.applicability_decisions = [
    {
      class_id: classId,
      decision: "applicable",
      checks: [],
      rationale: "No evidence-backed hard incompatibility applies."
    }
  ];
  plan.selected_class_records = [selectedRecord];
  plan.counts = {
    threats: 1,
    applicable_classes: 1,
    inapplicable_classes: 0,
    dynamic_goals: 2,
    total_goals: 3
  };
  sealGoalPlanCardinality(plan);

  const result = validateGoalPlan(plan);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.value?.threat_goals[0]?.node_id, "dynamic:threat:oracle:price.v2");
  assert.equal(result.value?.class_goals[0]?.node_id, "dynamic:class:oracle.v2:stale-price");
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/findings@2",
      JSON.stringify([
        {
          schema_version: "ultrafuzz.finding.v2",
          id: "oracle-v2-finding",
          title: "Stale oracle price",
          status: "candidate",
          severity_guess: "High",
          confidence: "high",
          summary: "The v2 oracle can retain a stale observation.",
          producer_node_id: "dynamic:threat:oracle:price.v2",
          source_node_id: "dynamic:threat:oracle:price.v2",
          source_nodes: ["dynamic:threat:oracle:price.v2"]
        }
      ])
    ).ok,
    true
  );
});

test("an applicable class remains planned when no explicit threat maps to it", () => {
  const plan = goalPlanFixture();
  const classId = "accounting:share-inflation";
  const record = {
    id: classId,
    path: "vulnerability-db/selected/accounting/share-inflation.md",
    sha256: digest,
    size_bytes: 512
  };
  plan.catalog_class_ids = [classId];
  plan.class_goals = [
    {
      kind: "class",
      id: classId,
      node_id: "dynamic:class:" + classId,
      class_id: classId,
      class_replacement_key: "class:accounting:share-inflation",
      threat_ids: [],
      threat_replacement_keys: ["threat-model:coverage-gap"],
      attack_surface_ids: ["surface:liquidation"],
      coverage_gap: true,
      title: "Share inflation",
      selected_record: record,
      goal_prompt:
        "Your /goal is to find a vulnerability of type {{class:accounting:share-inflation}} using threat model {{threat-model:coverage-gap}}.",
      replacements: {
        "class:accounting:share-inflation": "Full vulnerability-class context.",
        "threat-model:coverage-gap": "No explicit threat mapped; inspect the full threat model and this gap."
      },
      selection_rationale: "The class is applicable and exposes a threat-model coverage gap."
    }
  ];
  plan.applicability_decisions = [
    {
      class_id: classId,
      decision: "applicable",
      checks: [],
      rationale: "The class has no hard incompatibility."
    }
  ];
  plan.selected_class_records = [record];
  plan.counts = {
    threats: 1,
    applicable_classes: 1,
    inapplicable_classes: 0,
    dynamic_goals: 2,
    total_goals: 3
  };
  sealGoalPlanCardinality(plan);

  const result = validateGoalPlan(plan);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.value?.class_goals[0]?.threat_ids.length, 0);
  assert.equal(result.value?.class_goals[0]?.coverage_gap, true);
});

test("initial finding normalization ignores agent provenance and seeds the runtime-controlled producer", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-goal-provenance-"));
  fs.writeFileSync(
    path.join(artifactDir, "findings.json"),
    JSON.stringify([
      {
        title: "Overdue liquidation bypass",
        status: "candidate",
        severity_guess: "high",
        confidence: "high",
        summary: "The position can be liquidated before its required overdue boundary.",
        source_node_id: "legacy-node",
        source_nodes: ["dynamic:class:liquidation:fixed-term-before-overdue", "legacy-node"]
      }
    ])
  );

  const result = normalizeFindings({
    artifactDir,
    nodeId: "filesystem-safe-attempt",
    provenance: { producerNodeId: "dynamic:threat:liquidation:overdue" }
  });

  assert.equal(result.findings[0]?.source_node_id, "dynamic:threat:liquidation:overdue");
  assert.equal(result.findings[0]?.producer_node_id, "dynamic:threat:liquidation:overdue");
  assert.deepEqual(result.findings[0]?.source_nodes, ["dynamic:threat:liquidation:overdue"]);
});

test("downstream normalization preserves discovery sources without treating the transformer as a discoverer", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-goal-provenance-transform-"));
  fs.writeFileSync(
    path.join(artifactDir, "deduped-findings.json"),
    JSON.stringify([
      {
        title: "Overdue liquidation bypass",
        status: "candidate",
        severity_guess: "high",
        confidence: "high",
        summary: "Two focused hunters corroborated the same root cause.",
        source_nodes: ["dynamic:threat:liquidation:overdue", "dynamic:class:liquidation:fixed-term-before-overdue"]
      }
    ])
  );

  const result = normalizeFindings({
    artifactDir,
    relativePath: "deduped-findings.json",
    provenance: { producerNodeId: "dedupe-findings" },
    preserveSourceNodes: true,
    requireSourceNodes: true,
    allowedSourceNodes: ["dynamic:threat:liquidation:overdue", "dynamic:class:liquidation:fixed-term-before-overdue"]
  });
  assert.equal(result.findings[0]?.producer_node_id, "dedupe-findings");
  assert.equal(result.findings[0]?.source_node_id, "dynamic:threat:liquidation:overdue");
  assert.deepEqual(result.findings[0]?.source_nodes, [
    "dynamic:threat:liquidation:overdue",
    "dynamic:class:liquidation:fixed-term-before-overdue"
  ]);

  const tamperedDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-goal-provenance-tamper-"));
  fs.writeFileSync(
    path.join(tamperedDir, "deduped-findings.json"),
    JSON.stringify([
      {
        title: "Invented source",
        status: "candidate",
        severity_guess: "high",
        confidence: "high",
        summary: "The review node tried to invent discovery provenance.",
        source_nodes: ["dynamic:threat:liquidation:invented"]
      }
    ])
  );
  assert.throws(
    () =>
      normalizeFindings({
        artifactDir: tamperedDir,
        relativePath: "deduped-findings.json",
        provenance: { producerNodeId: "dedupe-findings" },
        preserveSourceNodes: true,
        requireSourceNodes: true,
        allowedSourceNodes: ["dynamic:threat:liquidation:overdue"]
      }),
    /not present in dependency findings/u
  );
});

test("dedupe provenance rejects dropped corroborating sources and incomplete lifecycle coverage", () => {
  const upstream = [
    {
      node_id: "dynamic:threat:liquidation:overdue",
      artifact_path: "artifacts/threat/findings.json",
      finding: {
        id: "threat-finding",
        dedupe_key: "raw:threat",
        producer_node_id: "dynamic:threat:liquidation:overdue",
        source_nodes: ["dynamic:threat:liquidation:overdue"]
      }
    },
    {
      node_id: "dynamic:class:liquidation:fixed-term-before-overdue",
      artifact_path: "artifacts/class/findings.json",
      finding: {
        id: "class-finding",
        dedupe_key: "raw:class",
        producer_node_id: "dynamic:class:liquidation:fixed-term-before-overdue",
        source_nodes: ["dynamic:class:liquidation:fixed-term-before-overdue"]
      }
    }
  ];
  const lifecycleLedger = {
    schema_version: "1.0",
    records: [
      {
        dedupe_key: "root:fixed-term-overdue",
        source_artifacts: [
          {
            node_id: "dynamic:threat:liquidation:overdue",
            finding_id: "threat-finding"
          },
          {
            node_id: "dynamic:class:liquidation:fixed-term-before-overdue",
            finding_id: "class-finding"
          }
        ]
      }
    ]
  };
  const expectations = buildFindingSourceExpectations({
    upstream,
    lifecycleLedger,
    requireLifecycleCoverage: true
  });
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-goal-provenance-drop-"));
  fs.writeFileSync(
    path.join(artifactDir, "deduped-findings.json"),
    JSON.stringify([
      {
        id: "kept-finding",
        dedupe_key: "root:fixed-term-overdue",
        title: "Fixed-term liquidation before overdue",
        status: "candidate",
        severity_guess: "high",
        confidence: "high",
        summary: "Two focused hunters found the same lifecycle boundary bug.",
        source_nodes: ["dynamic:threat:liquidation:overdue"]
      }
    ])
  );
  assert.throws(
    () =>
      normalizeFindings({
        artifactDir,
        relativePath: "deduped-findings.json",
        provenance: { producerNodeId: "dedupe-findings" },
        preserveSourceNodes: true,
        requireSourceNodes: true,
        allowedSourceNodes: upstream.flatMap((entry) => entry.finding.source_nodes),
        sourceExpectations: expectations,
        requireSourceExpectation: true
      }),
    /does not preserve the exact dependency discovery-source union/u
  );

  const complete = JSON.parse(fs.readFileSync(path.join(artifactDir, "deduped-findings.json"), "utf8")) as Array<
    Record<string, unknown>
  >;
  complete[0]!.source_nodes = [
    "dynamic:class:liquidation:fixed-term-before-overdue",
    "dynamic:threat:liquidation:overdue"
  ];
  fs.writeFileSync(path.join(artifactDir, "deduped-findings.json"), JSON.stringify(complete));
  const normalized = normalizeFindings({
    artifactDir,
    relativePath: "deduped-findings.json",
    provenance: { producerNodeId: "dedupe-findings" },
    preserveSourceNodes: true,
    requireSourceNodes: true,
    allowedSourceNodes: upstream.flatMap((entry) => entry.finding.source_nodes),
    sourceExpectations: expectations,
    requireSourceExpectation: true
  });
  assert.deepEqual(normalized.findings[0]?.source_nodes, [
    "dynamic:threat:liquidation:overdue",
    "dynamic:class:liquidation:fixed-term-before-overdue"
  ]);

  const incompleteLedger = structuredClone(lifecycleLedger);
  incompleteLedger.records[0]!.source_artifacts.pop();
  assert.throws(
    () =>
      buildFindingSourceExpectations({
        upstream,
        lifecycleLedger: incompleteLedger,
        requireLifecycleCoverage: true
      }),
    /omitted dependency findings/u
  );
});

test("generic finding ID collisions cannot union unrelated discovery lanes", () => {
  const upstream = [
    {
      node_id: "dynamic:threat:accounting:rounding",
      artifact_path: "artifacts/threat/findings.json",
      finding: {
        id: "finding-1",
        upstream_id: "threat-original",
        dedupe_key: "raw:threat",
        source_nodes: ["dynamic:threat:accounting:rounding"]
      }
    },
    {
      node_id: "dynamic:class:authorization:roles",
      artifact_path: "artifacts/class/findings.json",
      finding: {
        id: "finding-1",
        upstream_id: "class-original",
        dedupe_key: "raw:class",
        source_nodes: ["dynamic:class:authorization:roles"]
      }
    }
  ];
  const lifecycleLedger = {
    schema_version: "1.0",
    records: [
      {
        dedupe_key: "root:rounding",
        family_id: "family:rounding",
        source_artifacts: [
          {
            node_id: "dynamic:threat:accounting:rounding",
            finding_id: "finding-1"
          }
        ]
      },
      {
        dedupe_key: "root:roles",
        family_id: "family:roles",
        source_artifacts: [
          {
            node_id: "dynamic:class:authorization:roles",
            finding_id: "finding-1"
          }
        ]
      }
    ]
  };
  const expectations = buildFindingSourceExpectations({
    upstream,
    lifecycleLedger,
    requireLifecycleCoverage: true
  });
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-provenance-id-collision-"));
  const finding = {
    id: "finding-1",
    dedupe_key: "root:rounding",
    title: "Rounding drift",
    status: "candidate",
    severity_guess: "high",
    confidence: "high",
    summary: "The rounding lane found a loss of accounting precision.",
    source_nodes: ["dynamic:threat:accounting:rounding"]
  };
  fs.writeFileSync(path.join(artifactDir, "deduped-findings.json"), JSON.stringify([finding]));
  const normalized = normalizeFindings({
    artifactDir,
    relativePath: "deduped-findings.json",
    provenance: { producerNodeId: "dedupe-findings" },
    preserveSourceNodes: true,
    requireSourceNodes: true,
    allowedSourceNodes: upstream.flatMap((entry) => entry.finding.source_nodes),
    sourceExpectations: expectations,
    requireSourceExpectation: true
  });
  assert.deepEqual(normalized.findings[0]?.source_nodes, ["dynamic:threat:accounting:rounding"]);

  for (const [label, contradictoryIdentity] of [
    ["family ID", { family_id: "family:roles" }],
    ["finding reference", { upstream_id: "class-original" }]
  ] as const) {
    fs.writeFileSync(
      path.join(artifactDir, "deduped-findings.json"),
      JSON.stringify([{ ...finding, ...contradictoryIdentity }])
    );
    assert.throws(
      () =>
        normalizeFindings({
          artifactDir,
          relativePath: "deduped-findings.json",
          provenance: { producerNodeId: "dedupe-findings" },
          preserveSourceNodes: true,
          requireSourceNodes: true,
          allowedSourceNodes: upstream.flatMap((entry) => entry.finding.source_nodes),
          sourceExpectations: expectations,
          requireSourceExpectation: true
        }),
      new RegExp(`${label} conflicts with higher-priority dependency provenance`, "u")
    );
  }

  const freshOutputIdentity = {
    ...finding,
    id: "kept-finding-new",
    family_id: "family:new",
    source_nodes: ["dynamic:threat:accounting:rounding"]
  };
  fs.writeFileSync(path.join(artifactDir, "deduped-findings.json"), JSON.stringify([freshOutputIdentity]));
  assert.deepEqual(
    normalizeFindings({
      artifactDir,
      relativePath: "deduped-findings.json",
      provenance: { producerNodeId: "dedupe-findings" },
      preserveSourceNodes: true,
      requireSourceNodes: true,
      allowedSourceNodes: upstream.flatMap((entry) => entry.finding.source_nodes),
      sourceExpectations: expectations,
      requireSourceExpectation: true
    }).findings[0]?.source_nodes,
    ["dynamic:threat:accounting:rounding"]
  );

  const ambiguous = {
    ...finding,
    dedupe_key: undefined,
    source_nodes: upstream.flatMap((entry) => entry.finding.source_nodes)
  };
  fs.writeFileSync(path.join(artifactDir, "deduped-findings.json"), JSON.stringify([ambiguous]));
  assert.throws(
    () =>
      normalizeFindings({
        artifactDir,
        relativePath: "deduped-findings.json",
        provenance: { producerNodeId: "dedupe-findings" },
        preserveSourceNodes: true,
        requireSourceNodes: true,
        allowedSourceNodes: upstream.flatMap((entry) => entry.finding.source_nodes),
        sourceExpectations: expectations,
        requireSourceExpectation: true
      }),
    /finding ID matches conflicting dependency provenance records/u
  );

  const forgedStrongIdentity = {
    ...finding,
    dedupe_key: "root:unknown",
    source_nodes: upstream.flatMap((entry) => entry.finding.source_nodes)
  };
  fs.writeFileSync(path.join(artifactDir, "deduped-findings.json"), JSON.stringify([forgedStrongIdentity]));
  assert.throws(
    () =>
      normalizeFindings({
        artifactDir,
        relativePath: "deduped-findings.json",
        provenance: { producerNodeId: "dedupe-findings" },
        preserveSourceNodes: true,
        requireSourceNodes: true,
        allowedSourceNodes: upstream.flatMap((entry) => entry.finding.source_nodes),
        sourceExpectations: expectations,
        requireSourceExpectation: true
      }),
    /dedupe key does not match any dependency provenance record/u
  );

  const duplicateKeyLedger = structuredClone(lifecycleLedger);
  duplicateKeyLedger.records[1]!.dedupe_key = "root:rounding";
  assert.throws(
    () =>
      buildFindingSourceExpectations({
        upstream,
        lifecycleLedger: duplicateKeyLedger,
        requireLifecycleCoverage: true
      }),
    /duplicate dedupe_key/u
  );
});

test("selected vulnerability-class snapshots are manifest-backed exact artifacts", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-selected-classes-"));
  const contents = Buffer.from("# Share inflation\n\nFocused hunter instructions.\n");
  const selectedPath = "vulnerability-db/selected/accounting/share-inflation.md";
  const classId = "accounting:share-inflation";
  const classDigest = crypto.createHash("sha256").update(contents).digest("hex");
  fs.mkdirSync(path.join(artifactDir, "vulnerability-db", "selected", "accounting"), { recursive: true });
  fs.writeFileSync(path.join(artifactDir, selectedPath), contents);
  const manifest = {
    schema_version: "ultrafuzz.vulnerability-db.snapshot.v1",
    database_schema_version: 1,
    aggregate_sha256: digest,
    catalog_sha256: digest,
    files: {},
    records: [
      {
        id: classId,
        path: "classes/accounting/share-inflation.md",
        sha256: classDigest,
        size_bytes: contents.length
      }
    ],
    selected_records: [
      {
        id: classId,
        path: "classes/accounting/share-inflation.md",
        artifact_path: selectedPath,
        sha256: classDigest,
        size_bytes: contents.length
      }
    ]
  };
  fs.writeFileSync(path.join(artifactDir, "vulnerability-db-manifest.json"), JSON.stringify(manifest));

  const plan = goalPlanFixture();
  const selectedRecord = {
    id: classId,
    path: selectedPath,
    sha256: classDigest,
    size_bytes: contents.length
  };
  plan.catalog_class_ids = [classId];
  plan.class_goals = [
    {
      kind: "class",
      id: classId,
      node_id: "dynamic:class:" + classId,
      class_id: classId,
      class_replacement_key: "class:" + classId,
      threat_ids: [],
      threat_replacement_keys: ["threat-model:coverage-gap"],
      attack_surface_ids: [],
      coverage_gap: true,
      title: "Share inflation",
      selected_record: selectedRecord,
      goal_prompt:
        "Your /goal is to find a vulnerability of type {{class:accounting:share-inflation}} using threat model {{threat-model:coverage-gap}}.",
      replacements: {
        "class:accounting:share-inflation": "Focused hunter instructions.",
        "threat-model:coverage-gap": "Inspect the full threat model because the explicit mapping is missing."
      },
      selection_rationale: "Applicable class exposes a coverage gap."
    }
  ];
  plan.applicability_decisions = [
    {
      class_id: classId,
      decision: "applicable",
      checks: [],
      rationale: "No hard incompatibility exists."
    }
  ];
  plan.selected_class_records = [selectedRecord];
  plan.counts = {
    threats: 1,
    applicable_classes: 1,
    inapplicable_classes: 0,
    dynamic_goals: 2,
    total_goals: 3
  };
  sealGoalPlanCardinality(plan);

  const snapshots = verifyGoalPlanSelectedRecordSnapshots(artifactDir, plan);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.path),
    [selectedPath]
  );
  assert.equal(snapshots[0]?.contents.equals(contents), true);

  const inMemory = verifyGoalPlanSelectedRecordSnapshotBytes(plan, manifest, new Map([[selectedPath, contents]]));
  assert.deepEqual(
    inMemory.map((snapshot) => snapshot.path),
    [selectedPath]
  );
  assert.throws(
    () =>
      verifyGoalPlanSelectedRecordSnapshotBytes(
        plan,
        manifest,
        new Map([
          [selectedPath, contents],
          ["vulnerability-db/selected/accounting/unplanned.md", Buffer.from("unplanned")]
        ])
      ),
    /byte map does not exactly match/u
  );
  const extraManifestSelection = structuredClone(manifest);
  extraManifestSelection.selected_records.push({
    ...extraManifestSelection.selected_records[0]!,
    id: "accounting:unplanned",
    artifact_path: "vulnerability-db/selected/accounting/unplanned.md"
  });
  assert.throws(
    () => verifyGoalPlanSelectedRecordSnapshotBytes(plan, extraManifestSelection, new Map([[selectedPath, contents]])),
    /selected set does not match/u
  );

  const unplannedPath = path.join(artifactDir, "vulnerability-db", "selected", "accounting", "unplanned.md");
  fs.writeFileSync(unplannedPath, "# Unplanned\n");
  assert.throws(() => verifyGoalPlanSelectedRecordSnapshots(artifactDir, plan), /byte map does not exactly match/u);
  fs.unlinkSync(unplannedPath);

  const missingCatalogDigest = structuredClone(manifest) as Record<string, unknown>;
  delete missingCatalogDigest.catalog_sha256;
  assert.throws(
    () => verifyGoalPlanSelectedRecordSnapshotBytes(plan, missingCatalogDigest, new Map([[selectedPath, contents]])),
    /catalog_sha256/u,
    "the snapshot manifest must declare the planner catalog digest"
  );
  const tamperedCatalogDigest = { ...structuredClone(manifest), catalog_sha256: "b".repeat(64) };
  assert.throws(
    () => verifyGoalPlanSelectedRecordSnapshotBytes(plan, tamperedCatalogDigest, new Map([[selectedPath, contents]])),
    /does not match goal-plan provenance/u,
    "a one-field catalog digest mismatch must be rejected"
  );

  fs.appendFileSync(path.join(artifactDir, selectedPath), "tampered");
  assert.throws(() => verifyGoalPlanSelectedRecordSnapshots(artifactDir, plan), /bytes do not match/u);
});

test("selected-record paths reject traversal segments in the contract and the in-memory verifier", () => {
  const unsafePaths = [
    "vulnerability-db/selected/../../../escape.md",
    "vulnerability-db/selected/./accounting/share-inflation.md",
    "vulnerability-db/selected/accounting/../share-inflation.md",
    "vulnerability-db/selected/accounting//share-inflation.md",
    "vulnerability-db/selected/.md",
    "vulnerability-db/selected/",
    "vulnerability-db/selected/accounting/share-inflation.md/..",
    "/vulnerability-db/selected/accounting/share-inflation.md",
    "vulnerability-db/selected/accounting\\share-inflation.md",
    "other/selected/accounting/share-inflation.md",
    "vulnerability-db/selected/accounting/share-inflation.txt"
  ];
  assert.equal(
    validateGoalPlan(classGoalPlanFixture("vulnerability-db/selected/accounting/share-inflation.md")).ok,
    true,
    "the canonical selected path stays valid"
  );
  for (const unsafePath of unsafePaths) {
    const tampered = classGoalPlanFixture(unsafePath);
    assert.equal(validateGoalPlan(tampered).ok, false, unsafePath);
    // The exported in-memory verifier must never hand a caller an unnormalized path either.
    assert.throws(() => verifyGoalPlanSelectedRecordSnapshotBytes(tampered, {}, new Map()), /goal plan/u, unsafePath);
  }
});

test("goal-plan replacement keys are exactly the keys the dynamic fanout consumer accepts", () => {
  const plan = goalPlanFixture();
  const goals = plan.threat_goals as Array<Record<string, unknown>>;
  const base = goals[0]!;

  // An unnamespaced key would reach the dynamic fanout consumer as an unresolvable placeholder, so
  // the contract rejects it here rather than letting the next node abort on it.
  const unnamespaced = structuredClone(plan);
  const unnamespacedGoal = (unnamespaced.threat_goals as Array<Record<string, unknown>>)[0]!;
  unnamespacedGoal.replacements = { ...(base.replacements as Record<string, unknown>), detail: "extra" };
  unnamespacedGoal.goal_prompt = `${String(base.goal_prompt)} Extra {{detail}}.`;
  assert.equal(validateGoalPlan(unnamespaced).ok, false, "unnamespaced replacement keys must be rejected");

  // Every accepted plan item must be consumable: the contract and the consumer share one predicate.
  const accepted = validateGoalPlan(plan);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  for (const goal of accepted.value!.threat_goals) {
    for (const key of Object.keys(goal.replacements)) {
      assert.equal(isNamespacedDynamicReplacementKey(key), true, key);
    }
  }
  for (const goal of accepted.value!.class_goals) {
    for (const key of Object.keys(goal.replacements)) {
      assert.equal(isNamespacedDynamicReplacementKey(key), true, key);
    }
  }
});

test("goal-plan replacements are bounded titles, not inlined JSON records", () => {
  const plan = goalPlanFixture();
  const threatId = "liquidation:overdue";
  const withReplacement = (value: unknown): Record<string, unknown> => {
    const next = structuredClone(plan);
    (next.threat_goals as Array<Record<string, unknown>>)[0]!.replacements = { [threatId]: value };
    return next;
  };

  // A replacement is substituted into the goal sentence, so the shape the planner is asked for is a
  // title plus its namespaced ID. That must keep validating.
  const titled = validateGoalPlan(withReplacement("Overdue liquidation bypass (liquidation:overdue)"));
  assert.equal(titled.ok, true, JSON.stringify(titled.issues));
  assert.equal(
    titled.value?.threat_goals[0]?.replacements[threatId],
    "Overdue liquidation bypass (liquidation:overdue)"
  );

  // The cap is a boundary, so both sides of it are asserted rather than only the rejection.
  assert.equal(validateGoalPlan(withReplacement("T".repeat(200))).ok, true);
  const oversized = validateGoalPlan(withReplacement("T".repeat(201)));
  assert.equal(oversized.ok, false, "an over-long replacement must not reach the goal sentence");
  assert.match(oversized.issues.map((issue) => issue.message).join("; "), /at most 200 characters/u);

  // The measured regression: a whole record serialized into the value. Rejected even well under the
  // cap, because the fix is a path reference, not a smaller wall.
  for (const record of [
    '{"id":"liquidation:overdue","assets":[],"evidence":[]}',
    '[{"id":"liquidation:overdue"}]',
    '  {"id":"liquidation:overdue"}  '
  ]) {
    const rejected = validateGoalPlan(withReplacement(record));
    assert.equal(rejected.ok, false, record);
    assert.match(rejected.issues.map((issue) => issue.message).join("; "), /not a serialized JSON record/u);
  }

  // Punctuation is not a record. A title that merely opens with a brace or contains brackets, quotes
  // and colons is prose, and rejecting it would push the planner into worse titles.
  for (const title of [
    "{withdraw} liquidates a fixed-term loan before it is overdue",
    'The "overdue" check reads state [see the ledger]: it is stale',
    "liquidation:overdue -- fixed-term loans, 1e18 rounding"
  ]) {
    const accepted = validateGoalPlan(withReplacement(title));
    assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  }

  // Numeric and boolean replacements are still accepted: they cannot be a JSON wall.
  assert.equal(validateGoalPlan(withReplacement(7)).ok, true);
  assert.equal(validateGoalPlan(withReplacement(true)).ok, true);
});

test("escaped required goal placeholders are rejected instead of rendering as literals", () => {
  const plan = goalPlanFixture();
  const goal = (plan.threat_goals as Array<Record<string, unknown>>)[0]!;
  const threatId = String(goal.id);

  const escaped = structuredClone(plan);
  const escapedGoal = (escaped.threat_goals as Array<Record<string, unknown>>)[0]!;
  escapedGoal.goal_prompt = `Your /goal is to find a bug using threat model threat \\{{${threatId}}}.`;
  const result = validateGoalPlan(escaped);
  assert.equal(result.ok, false, "an escaped required placeholder can never be bound by the renderer");
  assert.ok(result.issues.some((issue) => /must not escape the required item-scoped placeholder/u.test(issue.message)));

  // The shared occurrence parser is the single source of truth for what will be bound.
  assert.deepEqual(
    promptTemplateOccurrences(String(escapedGoal.goal_prompt)).map((occurrence) => occurrence.name),
    []
  );
  assert.deepEqual(
    promptTemplateOccurrences(String(goal.goal_prompt)).map((occurrence) => occurrence.name),
    [threatId]
  );
});

function classGoalPlanFixture(selectedPath: string): Record<string, unknown> {
  const classId = "accounting:share-inflation";
  const plan = goalPlanFixture();
  const selectedRecord = { id: classId, path: selectedPath, sha256: digest, size_bytes: 42 };
  plan.catalog_class_ids = [classId];
  plan.selected_class_records = [selectedRecord];
  plan.class_goals = [
    {
      kind: "class",
      id: classId,
      node_id: "dynamic:class:" + classId,
      class_id: classId,
      class_replacement_key: "class:" + classId,
      threat_ids: [],
      threat_replacement_keys: ["threat-model:coverage-gap"],
      attack_surface_ids: [],
      coverage_gap: true,
      title: "Share inflation",
      selected_record: selectedRecord,
      goal_prompt:
        "Your /goal is to find a vulnerability of type {{class:accounting:share-inflation}} using threat model {{threat-model:coverage-gap}}.",
      replacements: {
        "class:accounting:share-inflation": "Focused hunter instructions.",
        "threat-model:coverage-gap": "Inspect the full threat model because the explicit mapping is missing."
      },
      selection_rationale: "Applicable class exposes a coverage gap."
    }
  ];
  plan.applicability_decisions = [
    { class_id: classId, decision: "applicable", checks: [], rationale: "No hard incompatibility exists." }
  ];
  plan.counts = {
    threats: 1,
    applicable_classes: 1,
    inapplicable_classes: 0,
    dynamic_goals: 2,
    total_goals: 3
  };
  sealGoalPlanCardinality(plan);
  return plan;
}

test("a cross-node dedupe root only resolves through its lifecycle ledger record", () => {
  // Regression for the workflow-sync path, which rebuilt these expectations
  // without the ledger. Without it the union expectation does not exist at all,
  // so a legitimate merge matches nothing and a succeeded node is reported as a
  // task-output-validation-failure.
  const upstream = [
    {
      node_id: "dynamic:threat:liquidation:overdue",
      artifact_path: "/runs/r/artifacts/a/findings.json",
      finding: { id: "f-threat", source_nodes: ["dynamic:threat:liquidation:overdue"] }
    },
    {
      node_id: "dynamic:class:liquidation:fixed-term-before-overdue",
      artifact_path: "/runs/r/artifacts/b/findings.json",
      finding: { id: "f-class", source_nodes: ["dynamic:class:liquidation:fixed-term-before-overdue"] }
    }
  ];
  const lifecycleLedger = {
    schema_version: "1.0",
    records: [
      {
        dedupe_key: "root:fixed-term-overdue",
        source_artifacts: [
          { path: "a/findings.json", node_id: "dynamic:threat:liquidation:overdue", finding_id: "f-threat" },
          {
            path: "b/findings.json",
            node_id: "dynamic:class:liquidation:fixed-term-before-overdue",
            finding_id: "f-class"
          }
        ]
      }
    ]
  };
  const unionOf = (expectations: ReturnType<typeof buildFindingSourceExpectations>): string[][] =>
    expectations.filter((expectation) => expectation.source_nodes.length > 1).map((e) => [...e.source_nodes].sort());

  assert.deepEqual(unionOf(buildFindingSourceExpectations({ upstream, requireLifecycleCoverage: true })), []);
  assert.deepEqual(
    unionOf(buildFindingSourceExpectations({ upstream, lifecycleLedger, requireLifecycleCoverage: true })),
    [["dynamic:class:liquidation:fixed-term-before-overdue", "dynamic:threat:liquidation:overdue"]]
  );

  // The ledger keys the union expectation, so the retained finding must carry
  // that same key. Both prompts now say so explicitly.
  const withLedger = buildFindingSourceExpectations({ upstream, lifecycleLedger, requireLifecycleCoverage: true });
  assert.ok(
    withLedger.some(
      (expectation) =>
        expectation.finding_keys.includes("root:fixed-term-overdue") && expectation.source_nodes.length === 2
    )
  );
});
