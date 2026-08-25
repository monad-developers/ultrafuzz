import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Bytes, type RunDataGovernanceReference } from "@ultrafuzz/artifacts";
import type { ResolvedConfig } from "@ultrafuzz/config";
import {
  DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV,
  DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION,
  DATA_GOVERNANCE_POLICY_ENV,
  DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
  DATA_GOVERNANCE_PROVENANCE_PATH,
  modelDestination,
  parseAcknowledgements,
  parseDataGovernancePolicy,
  prepareDataGovernance,
  type DataGovernancePolicy,
  targetIdentity
} from "../src/data-governance.js";
import { initProject } from "../src/init.js";
import { planRun } from "../src/plan-run.js";
import {
  DATA_DISCLOSURE_ACKNOWLEDGEMENTS_JSON_SCHEMA_ID,
  DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID
} from "../src/runtime-contracts.js";
import {
  DATA_DISCLOSURE_ACKNOWLEDGEMENTS_SEMANTIC_GATES,
  DATA_GOVERNANCE_POLICY_SEMANTIC_GATES,
  runtimeSchemaRegistry,
  validateRuntimeJsonSchema
} from "../src/schema-registry.js";
import { assertSealedDataGovernance } from "../src/smithers.js";
import type { PlannedGraph } from "../src/types.js";
function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-governance-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "tester@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Ultrafuzz Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "target.txt"), "target\n");
  execFileSync("git", ["add", "target.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "target"], { cwd: root });
  return root;
}
const config = {
  execution: { mode: "local", resources: {}, nodes: {}, providers: {} },
  retry: { agents: ["primary"] },
  models: { profiles: { primary: { id: "primary", agent: "CodexAgent", model: "gpt-test" } } }
} as unknown as ResolvedConfig;
const graph = {
  nodes: [{ model_fanout: [{ model_profile_id: "primary", agent_ref: "CodexAgent", model_name: "gpt-test" }] }]
} as unknown as PlannedGraph;
const destinationPolicy = (destination: string) => ({
  destination,
  ...Object.fromEntries(
    "processor region retention_policy training_policy dpa_status minimization_policy data_handling_basis"
      .split(" ")
      .map((key) => [key, "reviewed"])
  )
});
function policy(
  options: {
    sensitivity?: "public" | "private";
    source?: string[];
    artifact?: string[];
    openRouterModels?: string[];
  } = {}
): string {
  const source = [...(options.source ?? ["model:openai"])].sort();
  const artifact = [...(options.artifact ?? [])].sort();
  const destinations = [...new Set([...source, ...artifact])].sort();
  return JSON.stringify({
    schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
    sensitivity: options.sensitivity ?? "private",
    source_destinations: source,
    artifact_destinations: artifact,
    destination_policies: destinations.map(destinationPolicy),
    openrouter_model_allowlist: [...(options.openRouterModels ?? [])].sort()
  });
}
const prepare = (projectRoot: string, env: Record<string, string | undefined>, operatorPrompt = "review target") =>
  prepareDataGovernance({
    projectRoot,
    config,
    graph,
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    promptDigest: "c".repeat(64),
    operatorPrompt,
    env: { ULTRAFUZZ_PROVIDER_HOME_ROOT: path.join(projectRoot, "provider-homes"), ...env }
  });
const useSmallTopology = (projectRoot: string): void =>
  fs.writeFileSync(
    path.join(projectRoot, ".ultrafuzz", "topology.yml"),
    "version: 2\ndefaults: { strategy_loops: 1 }\nnodes:\n  - { id: __start__, kind: meta, role: start, depends_on: [] }\n  - { id: project-discovery, kind: agentic, prompt: setup/project-discovery.md, depends_on: [__start__], outputs: [{ path: setup/project-discovery.md, contract: ultrafuzz/nonempty-markdown@1, primary: true }] }\n  - { id: __finish__, kind: meta, role: finish, depends_on: [project-discovery] }\n"
  );
test("private policy acknowledgements bind exact routes, prompts, and target bytes", () => {
  const root = repository(),
    defaults = prepare(root, {}),
    policyJson = policy(),
    pending = prepare(root, { [DATA_GOVERNANCE_POLICY_ENV]: policyJson });
  assert.equal(defaults.provenance.policy.sensitivity, "private");
  assert.ok(defaults.diagnostics.some(({ code }) => code === "DATA_GOVERNANCE_DESTINATION_NOT_ALLOWED"));
  assert.throws(() => parseDataGovernancePolicy(policyJson.replace("{", '{"sensitivity":"public",')), /strict JSON/u);
  assert.equal(pending.provenance.acknowledgement_status, "pending");
  assert.ok(pending.diagnostics.some(({ code }) => code === "DATA_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED"));
  assert.match(pending.diagnostics.at(-1)?.message ?? "", /policy_digest=[a-f0-9]{64}; input_digest=[a-f0-9]{64}/u);
  const acknowledgement = {
    schema_version: DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION,
    destination: "model:openai",
    policy_digest: pending.provenance.policy_digest,
    input_digest: pending.provenance.input_digest,
    acknowledged_by: "reviewer@example.invalid",
    acknowledged_at: "2026-08-17T00:00:00.000Z"
  };
  assert.equal(validateRuntimeJsonSchema(DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID, JSON.parse(policyJson)).ok, true);
  assert.equal(validateRuntimeJsonSchema(DATA_DISCLOSURE_ACKNOWLEDGEMENTS_JSON_SCHEMA_ID, [acknowledgement]).ok, true);
  const env = {
    [DATA_GOVERNANCE_POLICY_ENV]: policyJson,
    [DATA_DISCLOSURE_ACKNOWLEDGEMENTS_ENV]: JSON.stringify([acknowledgement])
  };
  assert.deepEqual(prepare(root, env).diagnostics, []);
  const stale = [
    prepare(root, { ...env, OPENAI_BASE_URL: "https://gateway.example/v1" }),
    prepare(root, env, "changed prompt")
  ];
  fs.writeFileSync(path.join(root, "target.txt"), "changed target\n");
  const dirty = prepare(root, env);
  stale.push(dirty);
  assert.ok(dirty.diagnostics.some(({ code }) => code === "DATA_GOVERNANCE_PRIVATE_TARGET_UNBOUND"));
  assert.equal(targetIdentity(root, [path.join(root, "target.txt")]).dirty, true);
  for (const result of stale) assert.equal(result.provenance.acknowledgement_status, "pending");
  fs.writeFileSync(path.join(root, "oversized.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.throws(() => prepare(root, env), /file exceeds the 16777216-byte limit/u);
});
test("governance JSON Schemas and runtime parsers have scalar acceptance parity", () => {
  const validPolicy = JSON.parse(policy()) as DataGovernancePolicy,
    validAcknowledgement = {
      schema_version: DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION,
      destination: "model:openai",
      policy_digest: "a".repeat(64),
      input_digest: "b".repeat(64),
      acknowledged_by: "reviewer@example.invalid",
      acknowledged_at: "2026-08-17T00:00:00.000Z"
    },
    impossibleTimestamp = { ...validAcknowledgement, acknowledged_at: "2026-99-99T99:99:99.999Z" },
    leapSecondTimestamp = { ...validAcknowledgement, acknowledged_at: "2026-12-31T23:59:60.000Z" },
    whitespaceAcknowledgement = { ...validAcknowledgement, acknowledged_by: " reviewer@example.invalid " },
    c1ModelPolicy = structuredClone(validPolicy),
    whitespacePolicy = structuredClone(validPolicy),
    unicodePolicy = structuredClone(validPolicy),
    trailingNewlinePolicy = structuredClone(validPolicy);
  c1ModelPolicy.openrouter_model_allowlist = [`vendor/\u0085model`];
  whitespacePolicy.destination_policies[0]!.processor = " reviewed ";
  unicodePolicy.destination_policies[0]!.processor = "😀".repeat(3_000);
  trailingNewlinePolicy.source_destinations = ["model:openai\n"];
  trailingNewlinePolicy.destination_policies[0]!.destination = "model:openai\n";

  const cases = [
    {
      name: "valid policy",
      schemaId: DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID,
      value: validPolicy,
      expected: true,
      parse: () => parseDataGovernancePolicy(JSON.stringify(validPolicy))
    },
    {
      name: "impossible acknowledgement timestamp",
      schemaId: DATA_DISCLOSURE_ACKNOWLEDGEMENTS_JSON_SCHEMA_ID,
      value: [impossibleTimestamp],
      expected: false,
      parse: () => parseAcknowledgements(JSON.stringify([impossibleTimestamp]))
    },
    {
      name: "non-ECMAScript leap-second timestamp",
      schemaId: DATA_DISCLOSURE_ACKNOWLEDGEMENTS_JSON_SCHEMA_ID,
      value: [leapSecondTimestamp],
      expected: false,
      parse: () => parseAcknowledgements(JSON.stringify([leapSecondTimestamp]))
    },
    {
      name: "C1 control in model ID",
      schemaId: DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID,
      value: c1ModelPolicy,
      expected: false,
      parse: () => parseDataGovernancePolicy(JSON.stringify(c1ModelPolicy))
    },
    {
      name: "leading and trailing policy whitespace",
      schemaId: DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID,
      value: whitespacePolicy,
      expected: false,
      parse: () => parseDataGovernancePolicy(JSON.stringify(whitespacePolicy))
    },
    {
      name: "leading and trailing acknowledgement whitespace",
      schemaId: DATA_DISCLOSURE_ACKNOWLEDGEMENTS_JSON_SCHEMA_ID,
      value: [whitespaceAcknowledgement],
      expected: false,
      parse: () => parseAcknowledgements(JSON.stringify([whitespaceAcknowledgement]))
    },
    {
      name: "3,000 astral characters",
      schemaId: DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID,
      value: unicodePolicy,
      expected: true,
      parse: () => parseDataGovernancePolicy(JSON.stringify(unicodePolicy))
    },
    {
      name: "destination with a trailing newline",
      schemaId: DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID,
      value: trailingNewlinePolicy,
      expected: false,
      parse: () => parseDataGovernancePolicy(JSON.stringify(trailingNewlinePolicy))
    }
  ] as const;

  for (const entry of cases) {
    const schemaAccepted = validateRuntimeJsonSchema(entry.schemaId, entry.value).ok;
    let runtimeAccepted = true;
    try {
      entry.parse();
    } catch {
      runtimeAccepted = false;
    }
    assert.equal(schemaAccepted, entry.expected, `${entry.name}: unexpected JSON Schema result`);
    assert.equal(runtimeAccepted, schemaAccepted, `${entry.name}: runtime parser disagrees with JSON Schema`);
  }
  assert.deepEqual(parseDataGovernancePolicy(JSON.stringify(unicodePolicy)), unicodePolicy);
});
test("governance semantic gates reject projected duplicates, incomplete coverage, and noncanonical order", () => {
  const validPolicy = JSON.parse(
      policy({ source: ["model:z", "model:a"], openRouterModels: ["vendor/z", "vendor/a"] })
    ) as DataGovernancePolicy,
    missingPolicy = structuredClone(validPolicy),
    duplicatePolicy = structuredClone(validPolicy),
    unorderedPolicy = structuredClone(validPolicy),
    acknowledgement = {
      schema_version: DATA_DISCLOSURE_ACKNOWLEDGEMENT_SCHEMA_VERSION,
      destination: "model:a",
      policy_digest: "a".repeat(64),
      input_digest: "b".repeat(64),
      acknowledged_by: "reviewer@example.invalid",
      acknowledged_at: "2026-08-17T00:00:00.000Z"
    },
    duplicateAcknowledgements = [acknowledgement, { ...acknowledgement, input_digest: "c".repeat(64) }];
  validPolicy.destination_policies[0]!.processor = "reviewed value";
  missingPolicy.destination_policies.pop();
  duplicatePolicy.destination_policies.push({
    ...duplicatePolicy.destination_policies[0]!,
    processor: "second row"
  });
  unorderedPolicy.source_destinations.reverse();

  assert.deepEqual(parseDataGovernancePolicy(JSON.stringify(validPolicy)), validPolicy);
  assert.equal(validateRuntimeJsonSchema(DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID, missingPolicy).ok, true);
  assert.throws(
    () => parseDataGovernancePolicy(JSON.stringify(missingPolicy)),
    new RegExp(DATA_GOVERNANCE_POLICY_SEMANTIC_GATES[1], "u")
  );
  assert.equal(validateRuntimeJsonSchema(DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID, duplicatePolicy).ok, true);
  assert.throws(
    () => parseDataGovernancePolicy(JSON.stringify(duplicatePolicy)),
    new RegExp(DATA_GOVERNANCE_POLICY_SEMANTIC_GATES[0], "u")
  );
  assert.equal(validateRuntimeJsonSchema(DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID, unorderedPolicy).ok, true);
  assert.throws(
    () => parseDataGovernancePolicy(JSON.stringify(unorderedPolicy)),
    new RegExp(DATA_GOVERNANCE_POLICY_SEMANTIC_GATES[2], "u")
  );
  assert.equal(
    validateRuntimeJsonSchema(DATA_DISCLOSURE_ACKNOWLEDGEMENTS_JSON_SCHEMA_ID, duplicateAcknowledgements).ok,
    true
  );
  assert.throws(
    () => parseAcknowledgements(JSON.stringify(duplicateAcknowledgements)),
    new RegExp(DATA_DISCLOSURE_ACKNOWLEDGEMENTS_SEMANTIC_GATES[0], "u")
  );

  const registry = new Map(runtimeSchemaRegistry().map((entry) => [entry.id, entry]));
  assert.deepEqual(
    registry.get(DATA_GOVERNANCE_POLICY_JSON_SCHEMA_ID)?.semanticGates,
    DATA_GOVERNANCE_POLICY_SEMANTIC_GATES
  );
  assert.deepEqual(
    registry.get(DATA_DISCLOSURE_ACKNOWLEDGEMENTS_JSON_SCHEMA_ID)?.semanticGates,
    DATA_DISCLOSURE_ACKNOWLEDGEMENTS_SEMANTIC_GATES
  );
});
test("policy pins explicit and home routes, Modal, and OpenRouter models", () => {
  const root = repository(),
    homes = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-provider-routes-"));
  const routed = {
    ...config,
    agents: { KimiAgent: { auth: "subscription" }, ClaudeAgent: { auth: "subscription" } }
  } as ResolvedConfig;
  assert.match(
    modelDestination("ClaudeAgent", routed, {
      ANTHROPIC_BASE_URL: "https://explicit-route",
      ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "anthropic_base_url"
    }),
    /^model:claude-route-/u
  );
  const selectors = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "us-east-1",
    ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "CLAUDE_CODE_USE_BEDROCK,AWS_REGION"
  };
  assert.notEqual(
    modelDestination("ClaudeAgent", routed, selectors),
    modelDestination("ClaudeAgent", routed, { ...selectors, AWS_REGION: "eu-west-1" })
  );
  assert.equal(
    modelDestination("ClaudeAgent", routed, { AZURE_EXTENSION_DIR: "/opt/az/azcliextensions" }),
    "model:anthropic"
  );
  const routes = [
    [".codex", "config.toml", '"model_provider" = "private"\n'],
    [".kimi-code", "config.toml", 'provider = "private"\n'],
    [".claude", "settings.json", '{"env":{"ANTHROPIC_BASE_URL":"https://home-route"}}']
  ] as const;
  for (const [relative, file, contents] of routes) {
    fs.mkdirSync(path.join(homes, relative));
    fs.writeFileSync(path.join(homes, relative, file), contents);
  }
  for (const agent of ["CodexAgent", "KimiAgent", "ClaudeAgent"])
    assert.match(modelDestination(agent, routed, { HOME: homes }), /^model:.*-route-/u);
  fs.writeFileSync(
    path.join(homes, ".claude", "settings.json"),
    '{"env":{"AZURE_EXTENSION_DIR":"/opt/az/azcliextensions"}}'
  );
  assert.equal(modelDestination("ClaudeAgent", routed, { HOME: homes }), "model:anthropic");
  const kimiApiKey = {
    ...config,
    agents: { KimiAgent: { auth: "api-key", apiKeyEnv: "KIMI_API_KEY" } }
  } as ResolvedConfig;
  assert.equal(modelDestination("KimiAgent", kimiApiKey, { HOME: homes }), "model:moonshot");
  assert.match(
    modelDestination("KimiAgent", kimiApiKey, { HOME: homes, KIMI_BASE_URL: "https://gateway.example/v1" }),
    /^model:kimi-route-/u
  );
  const cloud = {
    ...config,
    execution: { mode: "cloud", provider: "modal", resources: {}, nodes: {}, providers: {} }
  } as unknown as ResolvedConfig;
  assert.throws(
    () => modelDestination("CodexAgent", cloud, { HOME: homes }),
    /cloud execution cannot use host provider-home routing/u
  );
  const claudeSettings = path.join(homes, ".claude", "settings.json");
  fs.writeFileSync(claudeSettings, '{"theme":"dark","permissions":{"allow":["Bash(*)"]},"hooks":{}}');
  assert.equal(modelDestination("ClaudeAgent", cloud, { HOME: homes }), "model:anthropic");
  for (const value of [
    { apiKeyHelper: "/operator/helper" },
    { processWrapper: "/operator/wrapper" },
    { proxyAuth: "operator" },
    { env: { HTTPS_PROXY: "https://proxy.example" } }
  ]) {
    fs.writeFileSync(claudeSettings, JSON.stringify(value));
    assert.throws(
      () => modelDestination("ClaudeAgent", cloud, { HOME: homes }),
      /cloud execution cannot use host provider-home routing/u
    );
  }
  const mixedGraph = {
      nodes: [{ model_fanout: [{ agent_ref: "OpenRouterAgent", model_name: "vendor/review-model" }] }]
    } as unknown as PlannedGraph,
    govern = (value: string) =>
      prepareDataGovernance({
        projectRoot: root,
        config: cloud,
        graph: mixedGraph,
        graphFingerprint: "a".repeat(64),
        configFingerprint: "b".repeat(64),
        promptDigest: "c".repeat(64),
        env: { [DATA_GOVERNANCE_POLICY_ENV]: value }
      }),
    destinations = {
      sensitivity: "public" as const,
      source: ["cloud:modal", "model:openrouter"],
      artifact: ["cloud:modal"]
    },
    denied = govern(policy(destinations));
  assert.deepEqual(denied.provenance.required_artifact_destinations, ["cloud:modal"]);
  assert.ok(denied.diagnostics.some(({ code }) => code === "DATA_GOVERNANCE_OPENROUTER_MODEL_NOT_ALLOWED"));
  assert.deepEqual(govern(policy({ ...destinations, openRouterModels: ["vendor/review-model"] })).diagnostics, []);
});
test("target identity rejects target PATH git and scrubs Git environment overrides", () => {
  const root = repository(),
    expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    bin = path.join(root, "bin"),
    fake = path.join(bin, "git");
  fs.mkdirSync(bin);
  fs.writeFileSync(fake, '#!/bin/sh\nprintf x > "$0.used"\nexit 97\n');
  fs.chmodSync(fake, 0o755);
  const names = ["PATH", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"] as const,
    saved = names.map((name) => [name, process.env[name]] as const);
  try {
    process.env.PATH = bin;
    for (const name of names.slice(1)) process.env[name] = path.join(root, `hostile-${name}`);
    assert.equal(targetIdentity(root).commit, expected);
    assert.equal(fs.existsSync(`${fake}.used`), false);
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
  fs.rmSync(bin, { recursive: true });
  const clean = targetIdentity(root);
  execFileSync("git", ["update-index", "--assume-unchanged", "target.txt"], { cwd: root });
  fs.writeFileSync(path.join(root, "target.txt"), "hidden change\n");
  const hidden = targetIdentity(root);
  assert.equal(clean.dirty, false);
  assert.equal(hidden.dirty, true);
  assert.notEqual(hidden.worktree_digest, clean.worktree_digest);
});
test("target identity excludes only exact controller-owned untracked outputs", () => {
  const root = repository(),
    owned = [
      path.join(root, ".ultrafuzz/runs/current"),
      path.join(root, ".ultrafuzz/runs"),
      path.join(root, ".smithers/node_modules"),
      path.join(root, ".smithers/workflows")
    ],
    initial = targetIdentity(root, owned);
  for (const directory of owned) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "generated"), "controller\n");
  }
  assert.deepEqual(targetIdentity(root, owned), initial);
  const trackedOwned = path.join(owned[0]!, "generated");
  execFileSync("git", ["add", "-f", path.relative(root, trackedOwned)], { cwd: root });
  execFileSync("git", ["commit", "-qm", "track controller path"], { cwd: root });
  fs.writeFileSync(trackedOwned, "target modification\n");
  assert.equal(targetIdentity(root, owned).dirty, true);
  fs.writeFileSync(path.join(root, "unrelated"), "target\n");
  assert.equal(targetIdentity(root, owned).dirty, true);
});
test("governance precedes preflight and rejects a policy mutated during it", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-governance-plan-"));
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  useSmallTopology(project);
  let calls = 0;
  const blocked = await planRun(
    { projectRoot: project, runId: "governance-before-preflight", env: {} },
    {
      enforceDataGovernance: true,
      beforeMaterialize: async () => {
        calls += 1;
        return [];
      }
    }
  );
  assert.equal(blocked.ok, false);
  assert.equal(calls, 0);
  const env: Record<string, string | undefined> = {
    ULTRAFUZZ_PROVIDER_HOME_ROOT: path.join(project, "provider-homes"),
    [DATA_GOVERNANCE_POLICY_ENV]: policy({ sensitivity: "public" })
  };
  const changed = await planRun(
    { projectRoot: project, runId: "governance-recheck", env },
    {
      enforceDataGovernance: true,
      beforeMaterialize: async () => {
        env[DATA_GOVERNANCE_POLICY_ENV] = policy({
          sensitivity: "public",
          source: ["model:openai", "artifact:changed"]
        });
        return [];
      }
    }
  );
  assert.equal(changed.ok, false);
  assert.equal(changed.diagnostics[0]?.code, "DATA_GOVERNANCE_INPUT_CHANGED_DURING_PREFLIGHT");
});
test("planning persists digest-bound governance and sealing detects tamper", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-governance-persist-"));
  assert.equal(initProject({ projectRoot, force: true }).ok, true);
  useSmallTopology(projectRoot);
  const planned = await planRun(
    {
      projectRoot,
      runId: "governance-persisted",
      env: {
        ULTRAFUZZ_PROVIDER_HOME_ROOT: path.join(projectRoot, "provider-homes"),
        [DATA_GOVERNANCE_POLICY_ENV]: policy({ sensitivity: "public" })
      }
    },
    { enforceDataGovernance: true }
  );
  assert.equal(planned.ok, true, JSON.stringify(planned.diagnostics));
  const provenanceBytes = fs.readFileSync(path.join(planned.value!.run_root, DATA_GOVERNANCE_PROVENANCE_PATH)),
    planBytes = fs.readFileSync(path.join(planned.value!.run_root, "plan.json"));
  const reference = (JSON.parse(planBytes.toString("utf8")) as { data_governance: RunDataGovernanceReference })
    .data_governance;
  assert.equal(reference.sha256, sha256Bytes(provenanceBytes));
  assert.deepEqual(reference, planned.value!.data_governance);
  const sealed = [
    { snapshotPath: "controls/plan.json", contents: planBytes },
    { snapshotPath: `controls/${DATA_GOVERNANCE_PROVENANCE_PATH}`, contents: provenanceBytes }
  ];
  assert.doesNotThrow(() => assertSealedDataGovernance(sealed, reference, planned.value!.run_id));
  sealed[1]!.contents = Buffer.from(provenanceBytes.toString("utf8").replace('"public"', '"private"'));
  assert.throws(
    () => assertSealedDataGovernance(sealed, reference, planned.value!.run_id),
    /differs from the authenticated launch decision/u
  );
});
test("target identity rejects Git content filters before execution", () => {
  const root = repository(),
    attributes = path.join(root, ".gitattributes");
  fs.writeFileSync(attributes, "target.txt filter=owned\n");
  execFileSync("git", ["add", ".gitattributes"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "attributes"], { cwd: root });
  const marker = path.join(root, "filter-ran"),
    helper = path.join(root, "clean-filter.sh");
  fs.writeFileSync(helper, "#!/bin/sh\n: > " + marker + "\ncat\n");
  fs.chmodSync(helper, 0o755);
  execFileSync("git", ["config", "filter.owned.clean", helper], { cwd: root });
  fs.writeFileSync(path.join(root, "target.txt"), "changed\n");
  assert.throws(() => targetIdentity(root), /Git content filters are forbidden/u);
  assert.equal(fs.existsSync(marker), false);
});

test("Codex CLI bookkeeping in config.toml does not change the acknowledged route", () => {
  const homes = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-codex-route-"));
  fs.mkdirSync(path.join(homes, ".codex"));
  const configPath = path.join(homes, ".codex", "config.toml");
  // What the Codex CLI writes on its own: model selection, marketplace
  // refresh timestamps, plugin toggles, and project trust levels. None of it
  // can redirect traffic, and the CLI rewrites it on invocation, so it must
  // not participate in the disclosure route digest (#908).
  fs.writeFileSync(
    configPath,
    [
      'model = "gpt-5.6-luna"',
      'model_reasoning_effort = "high"',
      "",
      "[marketplaces.openai-bundled]",
      'last_updated = "2026-08-25T13:35:06Z"',
      'source_type = "local"',
      "",
      '[plugins."sites@openai-bundled"]',
      "enabled = true",
      "",
      '[projects."/home/operator"]',
      'trust_level = "trusted"',
      ""
    ].join("\n")
  );
  assert.equal(modelDestination("CodexAgent", config, { HOME: homes }), "model:openai");

  // Routing declarations still pin (and, after acknowledgement, still fail
  // closed): a provider selection or endpoint makes the digest reappear.
  for (const routing of [
    'model_provider = "private"\n',
    '[model_providers.private]\nbase_url = "https://gateway.example/v1"\n',
    'base_url = "https://gateway.example/v1"\n'
  ]) {
    fs.writeFileSync(configPath, routing);
    assert.match(modelDestination("CodexAgent", config, { HOME: homes }), /^model:codex-route-/u);
  }
});
