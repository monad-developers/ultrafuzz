import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ResolvedConfig } from "@ultrafuzz/config";

import {
  DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV,
  DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION,
  DATA_GOVERNANCE_POLICY_ENV,
  DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
  parseAcknowledgements,
  parseDataGovernancePolicy,
  prepareDataGovernance
} from "../src/data-governance.js";
import type { PlannedGraph } from "../src/types.js";

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-data-governance-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "tester@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Ultrafuzz Tester"], { cwd: root });
  fs.writeFileSync(path.join(root, "target.txt"), "target\n", "utf8");
  execFileSync("git", ["add", "target.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "target"], { cwd: root });
  return root;
}

const config = {
  execution: { mode: "local", resources: {}, nodes: {}, providers: {} },
  retry: { agents: [] },
  models: { profiles: {} },
  permissions: { productionSourceRoots: ["src", "contracts"] }
} as unknown as ResolvedConfig;

const graph = {
  nodes: [
    {
      model_fanout: [{ agent_ref: "CodexAgent" }]
    }
  ]
} as unknown as PlannedGraph;

const privatePolicy = JSON.stringify({
  schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
  sensitivity: "private",
  source_destinations: ["model:openai"],
  artifact_destinations: [],
  destination_policies: [
    {
      destination: "model:openai",
      processor: "OpenAI",
      region: "operator-approved provider region",
      retention_policy: "provider contract reviewed for a maximum of 30 days",
      training_policy: "operator reviewed no-training terms",
      dpa_status: "operator reviewed applicable DPA",
      minimization_policy: "only task-relevant source context",
      data_handling_basis: "operator-confirmed confidential source processing"
    }
  ],
  local_model_agents: [],
  openrouter_model_allowlist: [],
  production_source_roots: ["contracts", "src"],
  review_signoff_keys: []
});

test("private campaign disclosures require exact policy/input-bound operator acknowledgements", () => {
  const projectRoot = repository();
  const base = {
    projectRoot,
    config,
    graph,
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    promptDigest: "c".repeat(64),
    operatorPrompt: "review this target"
  };
  const pending = prepareDataGovernance({
    ...base,
    env: { [DATA_GOVERNANCE_POLICY_ENV]: privatePolicy }
  });
  assert.equal(pending.provenance.policy.sensitivity, "private");
  assert.equal(pending.provenance.acknowledgement_status, "pending");
  assert.deepEqual(pending.provenance.required_source_destinations, ["model:openai"]);
  assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "DATA_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED"));

  const acknowledgement = {
    schema_version: DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION,
    destination: "model:openai",
    policy_digest: pending.provenance.policy_digest,
    input_digest: pending.provenance.input_digest,
    acknowledged_by: "security-reviewer@example.test",
    acknowledged_at: "2026-08-15T00:00:00.000Z"
  };
  const approved = prepareDataGovernance({
    ...base,
    env: {
      [DATA_GOVERNANCE_POLICY_ENV]: privatePolicy,
      [DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV]: JSON.stringify([acknowledgement])
    }
  });
  assert.equal(approved.provenance.acknowledgement_status, "approved");
  assert.deepEqual(approved.diagnostics, []);

  const changedInput = prepareDataGovernance({
    ...base,
    operatorPrompt: "review a changed target prompt",
    env: {
      [DATA_GOVERNANCE_POLICY_ENV]: privatePolicy,
      [DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV]: JSON.stringify([acknowledgement])
    }
  });
  assert.equal(changedInput.provenance.acknowledgement_status, "pending");
  assert.ok(
    changedInput.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "DATA_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED" &&
        JSON.stringify(diagnostic.details).includes("model:openai")
    )
  );

  const changedReferenceInput = prepareDataGovernance({
    ...base,
    referenceExpectationsDigest: "d".repeat(64),
    env: {
      [DATA_GOVERNANCE_POLICY_ENV]: privatePolicy,
      [DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV]: JSON.stringify([acknowledgement])
    }
  });
  assert.notEqual(changedReferenceInput.provenance.input_digest, approved.provenance.input_digest);
  assert.equal(changedReferenceInput.provenance.acknowledgement_status, "pending");

  const changedSourceRun = prepareDataGovernance({
    ...base,
    sourceRunId: "source-run-2",
    env: {
      [DATA_GOVERNANCE_POLICY_ENV]: privatePolicy,
      [DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV]: JSON.stringify([acknowledgement])
    }
  });
  assert.notEqual(changedSourceRun.provenance.input_digest, approved.provenance.input_digest);
  assert.equal(changedSourceRun.provenance.acknowledgement_status, "pending");

  fs.writeFileSync(path.join(projectRoot, "target.txt"), "changed target bytes\n", "utf8");
  const changedTarget = prepareDataGovernance({
    ...base,
    env: {
      [DATA_GOVERNANCE_POLICY_ENV]: privatePolicy,
      [DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV]: JSON.stringify([acknowledgement])
    }
  });
  assert.notEqual(changedTarget.provenance.input_digest, approved.provenance.input_digest);
  assert.equal(changedTarget.provenance.acknowledgement_status, "pending");
});

test("campaign data governance defaults to private with no external destinations pre-approved", () => {
  const prepared = prepareDataGovernance({
    projectRoot: repository(),
    config,
    graph,
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    promptDigest: "c".repeat(64),
    env: {}
  });
  assert.equal(prepared.provenance.policy.sensitivity, "private");
  assert.deepEqual(prepared.provenance.policy.source_destinations, []);
  assert.ok(prepared.diagnostics.some((diagnostic) => diagnostic.code === "DATA_GOVERNANCE_DESTINATION_NOT_ALLOWED"));
});

test("private campaigns refuse a non-Git target whose source bytes cannot be bound", () => {
  const prepared = prepareDataGovernance({
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "ufz-data-governance-nongit-")),
    config,
    graph,
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    promptDigest: "c".repeat(64),
    env: { [DATA_GOVERNANCE_POLICY_ENV]: privatePolicy }
  });

  assert.ok(prepared.diagnostics.some((entry) => entry.code === "DATA_GOVERNANCE_PRIVATE_TARGET_UNBOUND"));
});

test("disclosure acknowledgements require canonical UTC timestamps", () => {
  assert.throws(
    () =>
      parseAcknowledgements(
        JSON.stringify([
          {
            schema_version: DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION,
            destination: "model:openai",
            policy_digest: "a".repeat(64),
            input_digest: "b".repeat(64),
            acknowledged_by: "security-reviewer@example.test",
            acknowledged_at: "2026-08-15T00:00:00Z"
          }
        ])
      ),
    /acknowledged_at must be a canonical UTC timestamp/u
  );
});

test("operator production roots must exactly match resolved publication-sensitive roots", () => {
  const policy = JSON.parse(privatePolicy) as Record<string, unknown>;
  policy.production_source_roots = ["other"];
  const prepared = prepareDataGovernance({
    projectRoot: repository(),
    config,
    graph,
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    promptDigest: "c".repeat(64),
    env: { [DATA_GOVERNANCE_POLICY_ENV]: JSON.stringify(policy) }
  });
  assert.ok(
    prepared.diagnostics.some((diagnostic) => diagnostic.code === "DATA_GOVERNANCE_PRODUCTION_SOURCE_ROOTS_MISMATCH")
  );
});

test("operator production roots reject portable case and Unicode aliases", () => {
  for (const roots of [
    ["SRC", "src"],
    ["caf\u00e9", "cafe\u0301"]
  ]) {
    const policy = JSON.parse(privatePolicy) as Record<string, unknown>;
    policy.production_source_roots = roots;
    assert.throws(
      () => parseDataGovernancePolicy(JSON.stringify(policy)),
      /production_source_roots must be unique after Unicode and case normalization/u
    );
  }
});

test("operator policy pins OpenRouter models and can classify a self-hosted agent as local", () => {
  const projectRoot = repository();
  const localGraph = {
    nodes: [
      { model_fanout: [{ agent_ref: "LocalModelAgent", model_name: "local/model" }] },
      { model_fanout: [{ agent_ref: "OpenRouterAgent", model_name: "vendor/review-model" }] }
    ]
  } as unknown as PlannedGraph;
  const policy = {
    schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
    sensitivity: "private",
    source_destinations: ["model:local-localmodelagent", "model:openrouter"],
    artifact_destinations: [],
    destination_policies: [
      destinationPolicy("model:local-localmodelagent", "operator-controlled local service"),
      destinationPolicy("model:openrouter", "OpenRouter")
    ],
    local_model_agents: ["LocalModelAgent"],
    openrouter_model_allowlist: [],
    production_source_roots: ["contracts", "src"],
    review_signoff_keys: []
  };
  const denied = prepareDataGovernance({
    projectRoot,
    config,
    graph: localGraph,
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    promptDigest: "c".repeat(64),
    env: { [DATA_GOVERNANCE_POLICY_ENV]: JSON.stringify(policy) }
  });
  assert.deepEqual(denied.provenance.required_source_destinations, ["model:local-localmodelagent", "model:openrouter"]);
  assert.ok(
    denied.diagnostics.some((diagnostic) => diagnostic.code === "DATA_GOVERNANCE_OPENROUTER_MODEL_NOT_ALLOWED")
  );
  assert.deepEqual(
    (denied.diagnostics.find((diagnostic) => diagnostic.code === "DATA_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED")?.details
      ?.destinations as string[]) ?? [],
    ["model:openrouter"]
  );
});

test("distinct agents cannot share an ambiguous normalized data destination", () => {
  const projectRoot = repository();
  const collisionGraph = {
    nodes: [
      { model_fanout: [{ agent_ref: "Foo:Bar", model_name: "first/model" }] },
      { model_fanout: [{ agent_ref: "Foo-Bar", model_name: "second/model" }] }
    ]
  } as unknown as PlannedGraph;
  const policy = {
    schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
    sensitivity: "private",
    source_destinations: ["model:custom-foo-bar"],
    artifact_destinations: [],
    destination_policies: [destinationPolicy("model:custom-foo-bar", "collision test destination")],
    local_model_agents: [],
    openrouter_model_allowlist: [],
    production_source_roots: ["contracts", "src"],
    review_signoff_keys: []
  };
  const base = {
    projectRoot,
    config,
    graph: collisionGraph,
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    promptDigest: "c".repeat(64)
  };
  assert.throws(
    () =>
      prepareDataGovernance({
        ...base,
        env: { [DATA_GOVERNANCE_POLICY_ENV]: JSON.stringify(policy) }
      }),
    /distinct model agents Foo:Bar and Foo-Bar normalize to the same data destination model:custom-foo-bar/u
  );
});

test("custom agents cannot spoof a built-in provider destination namespace", () => {
  const customGraph = {
    nodes: [{ model_fanout: [{ agent_ref: "openai", model_name: "custom/model" }] }]
  } as unknown as PlannedGraph;
  const policy = {
    schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
    sensitivity: "public",
    source_destinations: ["model:custom-openai"],
    artifact_destinations: [],
    destination_policies: [destinationPolicy("model:custom-openai", "operator-reviewed custom adapter")],
    local_model_agents: [],
    openrouter_model_allowlist: [],
    production_source_roots: ["contracts", "src"],
    review_signoff_keys: []
  };
  const prepared = prepareDataGovernance({
    projectRoot: repository(),
    config,
    graph: customGraph,
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    promptDigest: "c".repeat(64),
    env: { [DATA_GOVERNANCE_POLICY_ENV]: JSON.stringify(policy) }
  });

  assert.deepEqual(prepared.provenance.required_source_destinations, ["model:custom-openai"]);
  assert.deepEqual(prepared.diagnostics, []);
});

test("governance includes every effective retry fallback destination and OpenRouter model", () => {
  const fallbackConfig = {
    execution: { mode: "local", resources: {}, nodes: {}, providers: {} },
    retry: { agents: ["primary", "fallback"] },
    permissions: { productionSourceRoots: ["src", "contracts"] },
    models: {
      profiles: {
        primary: { id: "primary", agent: "CodexAgent", model: "gpt-primary" },
        fallback: { id: "fallback", agent: "OpenRouterAgent", model: "vendor/fallback-model" }
      }
    }
  } as unknown as ResolvedConfig;
  const fallbackGraph = {
    nodes: [
      {
        model_fanout: [{ model_profile_id: "primary", agent_ref: "CodexAgent", model_name: "gpt-primary" }]
      }
    ]
  } as unknown as PlannedGraph;
  const policy = {
    schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
    sensitivity: "public",
    source_destinations: ["model:openai"],
    artifact_destinations: [],
    destination_policies: [destinationPolicy("model:openai", "OpenAI")],
    local_model_agents: [],
    openrouter_model_allowlist: [],
    production_source_roots: ["contracts", "src"],
    review_signoff_keys: []
  };
  const prepared = prepareDataGovernance({
    projectRoot: repository(),
    config: fallbackConfig,
    graph: fallbackGraph,
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    promptDigest: "c".repeat(64),
    env: { [DATA_GOVERNANCE_POLICY_ENV]: JSON.stringify(policy) }
  });
  assert.deepEqual(prepared.provenance.required_source_destinations, ["model:openai", "model:openrouter"]);
  assert.ok(
    prepared.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "DATA_GOVERNANCE_DESTINATION_NOT_ALLOWED" &&
        (diagnostic.details?.missing_source_destinations as string[]).includes("model:openrouter")
    )
  );
  assert.ok(
    prepared.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "DATA_GOVERNANCE_OPENROUTER_MODEL_NOT_ALLOWED" &&
        (diagnostic.details?.models as string[]).includes("vendor/fallback-model")
    )
  );
});

test("hosted built-in model agents cannot be reclassified as local", () => {
  const policy = JSON.parse(privatePolicy) as Record<string, unknown>;
  policy.local_model_agents = ["CodexAgent"];
  assert.throws(
    () => parseDataGovernancePolicy(JSON.stringify(policy)),
    /cannot reclassify hosted built-in agent CodexAgent as local/u
  );
});

function destinationPolicy(destination: string, processor: string): Record<string, string> {
  return {
    destination,
    processor,
    region: "operator-approved region",
    retention_policy: "operator-reviewed retention",
    training_policy: "operator-reviewed training terms",
    dpa_status: "operator-reviewed DPA status",
    minimization_policy: "task-relevant source only",
    data_handling_basis: "operator-confirmed processing"
  };
}
