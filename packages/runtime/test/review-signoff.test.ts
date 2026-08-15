import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { layoutForRunRoot, sha256Bytes } from "@ultrafuzz/artifacts";

import {
  MATERIALIZE_REVIEW_SIGNOFF_SCHEMA_VERSION,
  assertMaterializeReviewTargetRemainedCurrent,
  loadAndVerifyMaterializeReviewSignoff,
  loadOperatorAuthenticatedDataGovernancePolicy,
  loadOperatorAuthenticatedMaterializeReviewAuthorities,
  materializeReviewSignoffRequest,
  materializeReviewSignoffSigningPayload,
  verifyRecordedMaterializeReviewSignoff,
  type MaterializeReviewSigningAuthority,
  type MaterializeReviewSignoffRequest,
  type MaterializeReviewUnsignedSignoff
} from "../src/review-signoff.js";
import {
  captureDataGovernanceTargetIdentity,
  DATA_GOVERNANCE_POLICY_ENV,
  DATA_GOVERNANCE_POLICY_SCHEMA_VERSION
} from "../src/data-governance.js";
import { initProject } from "../src/init.js";
import { planRun } from "../src/plan-run.js";
import { compileSmithersWorkflow, smithersExecutionControlFiles } from "../src/smithers.js";
import { sealWorkflowControlFiles } from "../src/workflow-integrity.js";

function reviewerAuthority(keyId = "security-reviewer-2026"): {
  authority: MaterializeReviewSigningAuthority;
  privateKey: crypto.KeyObject;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const bytes = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  return {
    authority: {
      key_id: keyId,
      algorithm: "ed25519",
      public_key_spki_base64: bytes.toString("base64"),
      public_key_sha256: sha256Bytes(bytes)
    },
    privateKey
  };
}

function request(authority: MaterializeReviewSigningAuthority): MaterializeReviewSignoffRequest {
  return {
    schema_version: MATERIALIZE_REVIEW_SIGNOFF_SCHEMA_VERSION,
    decision: "accepted",
    run_id: "review-run",
    target_commit: "a".repeat(40),
    target_tree: "b".repeat(40),
    target_clean: true,
    target_worktree_digest: "9".repeat(64),
    graph_fingerprint: "c".repeat(64),
    final_report_digest: "d".repeat(64),
    selected_artifacts: [
      { source: "artifacts/final-report/report.md", destination: "audit/report.md", sha256: "e".repeat(64) }
    ],
    trusted_signers: [
      {
        key_id: authority.key_id,
        algorithm: authority.algorithm,
        public_key_sha256: authority.public_key_sha256
      }
    ]
  };
}

function signedDocument(
  expected: MaterializeReviewSignoffRequest,
  privateKey: crypto.KeyObject,
  keyId: string
): MaterializeReviewUnsignedSignoff & { signature: string } {
  const unsigned: MaterializeReviewUnsignedSignoff = {
    ...expected,
    reviewer: "security-reviewer@example.test",
    reviewed_at: "2026-08-15T00:00:00.000Z",
    signing_key_id: keyId
  };
  return {
    ...unsigned,
    signature: crypto.sign(null, materializeReviewSignoffSigningPayload(unsigned), privateKey).toString("base64")
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeSmallTopology(projectRoot: string): void {
  fs.writeFileSync(
    path.join(projectRoot, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: stdout.txt
        contract: ultrafuzz/text@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

function governancePolicy(
  authority: MaterializeReviewSigningAuthority,
  productionSourceRoots: string[] = ["contracts", "src"]
): string {
  return JSON.stringify({
    schema_version: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
    sensitivity: "public",
    source_destinations: ["model:openai"],
    artifact_destinations: [],
    destination_policies: [
      {
        destination: "model:openai",
        processor: "synthetic test process",
        region: "local test process",
        retention_policy: "synthetic test fixtures only",
        training_policy: "not used for training",
        dpa_status: "not applicable to synthetic fixtures",
        minimization_policy: "synthetic fixture content only",
        data_handling_basis: "synthetic public test fixtures"
      }
    ],
    local_model_agents: [],
    openrouter_model_allowlist: [],
    production_source_roots: productionSourceRoots,
    review_signoff_keys: [
      {
        key_id: authority.key_id,
        algorithm: authority.algorithm,
        public_key_spki_base64: authority.public_key_spki_base64
      }
    ]
  });
}

async function sealedGovernanceRun(policyJson: string, runId: string) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-review-sealed-"));
  execFileSync("git", ["init", "-q"], { cwd: projectRoot });
  git(projectRoot, ["config", "user.email", "tester@example.invalid"]);
  git(projectRoot, ["config", "user.name", "Ultrafuzz Tester"]);
  const initialized = initProject({ projectRoot, force: true });
  assert.equal(initialized.ok, true, JSON.stringify(initialized.diagnostics));
  writeSmallTopology(projectRoot);
  git(projectRoot, ["add", "."]);
  git(projectRoot, ["commit", "-m", "sealed fixture"]);
  const plan = await planRun({
    projectRoot,
    runId,
    env: { [DATA_GOVERNANCE_POLICY_ENV]: policyJson }
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const value = plan.value!;
  const compiled = compileSmithersWorkflow({
    projectRoot,
    config: value.resolved_config,
    graph: value.expanded_graph,
    runLayout: value.layout,
    workflowName: `ultrafuzz-${runId}`,
    renderedPrompts: value.rendered_prompts
  });
  const executionFiles = await smithersExecutionControlFiles(compiled, value.layout, { SMITHERS_BIN: "/bin/true" });
  for (const node of value.graph.nodes) {
    const taskNodeIds = compiled.tasks
      .filter((task) => task.concreteNodeId === node.id)
      .map((task) => task.smithersNodeId);
    if (taskNodeIds.length > 0) node.workflow = { node_id: taskNodeIds[0]!, task_node_ids: taskNodeIds };
  }
  fs.writeFileSync(value.layout.graphPath, `${JSON.stringify(value.graph, null, 2)}\n`, "utf8");
  sealWorkflowControlFiles({
    projectRoot,
    layout: value.layout,
    workflowPath: compiled.workflowPath,
    expandedGraphPath: compiled.expandedGraphPath,
    configPath: compiled.configPath,
    evidenceWorkflowPath: compiled.evidenceWorkflowPath,
    tasksPath: compiled.tasksPath,
    inputPath: compiled.inputPath,
    executionFiles
  });
  return {
    projectRoot,
    layout: value.layout,
    governancePath: path.join(value.layout.root, "data-governance.json")
  };
}

test("materialization review signoff is Ed25519-authenticated and bound to every reviewed digest", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-review-target-"));
  const runRoot = path.join(projectRoot, ".ultrafuzz", "runs", "review-run");
  fs.mkdirSync(runRoot, { recursive: true });
  const layout = layoutForRunRoot(runRoot, "review-run");
  const signer = reviewerAuthority();
  const expected = request(signer.authority);
  const signoffPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ufz-reviewer-owned-")), "signoff.json");
  fs.writeFileSync(
    signoffPath,
    `${JSON.stringify(signedDocument(expected, signer.privateKey, signer.authority.key_id))}\n`
  );

  const verified = loadAndVerifyMaterializeReviewSignoff({
    signoffPath,
    projectRoot,
    layout,
    expected,
    authorities: [signer.authority]
  });
  assert.equal(verified.decision, "accepted");
  assert.match(verified.signoff_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    verifyRecordedMaterializeReviewSignoff({
      signoff: verified,
      expected,
      authorities: [signer.authority]
    }),
    verified
  );

  assert.throws(
    () =>
      loadAndVerifyMaterializeReviewSignoff({
        signoffPath,
        projectRoot,
        layout,
        expected: { ...expected, final_report_digest: "f".repeat(64) },
        authorities: [signer.authority]
      }),
    /stale or does not bind/u
  );

  const noncanonicalUnsigned: MaterializeReviewUnsignedSignoff = {
    ...expected,
    reviewer: "security-reviewer@example.test",
    reviewed_at: "2026-08-15T00:00:00Z",
    signing_key_id: signer.authority.key_id
  };
  fs.writeFileSync(
    signoffPath,
    `${JSON.stringify({
      ...noncanonicalUnsigned,
      signature: crypto
        .sign(null, materializeReviewSignoffSigningPayload(noncanonicalUnsigned), signer.privateKey)
        .toString("base64")
    })}\n`,
    "utf8"
  );
  assert.throws(
    () =>
      loadAndVerifyMaterializeReviewSignoff({
        signoffPath,
        projectRoot,
        layout,
        expected,
        authorities: [signer.authority]
      }),
    /reviewed_at must be a canonical UTC timestamp/u
  );
});

test("a YOLO agent cannot self-assert review identity without the sealed private key", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-review-forgery-target-"));
  const runRoot = path.join(projectRoot, ".ultrafuzz", "runs", "review-run");
  fs.mkdirSync(runRoot, { recursive: true });
  const layout = layoutForRunRoot(runRoot, "review-run");
  const trusted = reviewerAuthority();
  const attacker = reviewerAuthority("attacker-key");
  const expected = request(trusted.authority);
  const signoffPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ufz-review-forgery-")), "signoff.json");
  fs.writeFileSync(
    signoffPath,
    `${JSON.stringify(signedDocument(expected, attacker.privateKey, trusted.authority.key_id))}\n`,
    "utf8"
  );

  assert.throws(
    () =>
      loadAndVerifyMaterializeReviewSignoff({
        signoffPath,
        projectRoot,
        layout,
        expected,
        authorities: [trusted.authority]
      }),
    /invalid Ed25519 signature/u
  );
});

test("repository-controlled signoff files are rejected", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-review-owned-boundary-"));
  const runRoot = path.join(projectRoot, ".ultrafuzz", "runs", "review-run");
  fs.mkdirSync(runRoot, { recursive: true });
  const layout = layoutForRunRoot(runRoot, "review-run");
  const signer = reviewerAuthority();
  const expected = request(signer.authority);
  const signoffPath = path.join(projectRoot, "signoff.json");
  fs.writeFileSync(signoffPath, "{}\n", "utf8");
  assert.throws(
    () =>
      loadAndVerifyMaterializeReviewSignoff({
        signoffPath,
        projectRoot,
        layout,
        expected,
        authorities: [signer.authority]
      }),
    /operator-owned outside the project/u
  );
});

test("materialization rejects dirty targets and target drift after signature verification", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-review-clean-target-"));
  execFileSync("git", ["init", "-q"], { cwd: projectRoot });
  git(projectRoot, ["config", "user.email", "tester@example.invalid"]);
  git(projectRoot, ["config", "user.name", "Ultrafuzz Tester"]);
  fs.writeFileSync(path.join(projectRoot, "tracked.txt"), "reviewed target\n", "utf8");
  git(projectRoot, ["add", "tracked.txt"]);
  git(projectRoot, ["commit", "-m", "reviewed target"]);
  const signer = reviewerAuthority();
  const targetCommit = git(projectRoot, ["rev-parse", "HEAD^{commit}"]).toLowerCase();
  const targetTree = git(projectRoot, ["rev-parse", "HEAD^{tree}"]).toLowerCase();
  const targetWorktreeDigest = captureDataGovernanceTargetIdentity(projectRoot).worktree_digest;
  assert.ok(targetWorktreeDigest);
  const expected: MaterializeReviewSignoffRequest = {
    ...request(signer.authority),
    target_commit: targetCommit,
    target_tree: targetTree,
    target_worktree_digest: targetWorktreeDigest
  };
  const runRoot = path.join(projectRoot, ".ultrafuzz", "runs", "review-run");
  const layout = layoutForRunRoot(runRoot, "review-run");
  const signoffPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ufz-review-clean-signoff-")), "signoff.json");
  fs.writeFileSync(
    signoffPath,
    `${JSON.stringify(signedDocument(expected, signer.privateKey, signer.authority.key_id))}\n`,
    "utf8"
  );
  assert.equal(
    loadAndVerifyMaterializeReviewSignoff({
      signoffPath,
      projectRoot,
      layout,
      expected,
      authorities: [signer.authority]
    }).decision,
    "accepted"
  );
  assert.doesNotThrow(() => assertMaterializeReviewTargetRemainedCurrent(projectRoot, expected));

  fs.writeFileSync(path.join(projectRoot, "tracked.txt"), "dirty after review\n", "utf8");
  assert.throws(
    () => assertMaterializeReviewTargetRemainedCurrent(projectRoot, expected),
    /requires a clean target working tree/u
  );
  fs.writeFileSync(path.join(projectRoot, "tracked.txt"), "reviewed target\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "untracked.txt"), "model-readable bytes\n", "utf8");
  assert.throws(
    () => assertMaterializeReviewTargetRemainedCurrent(projectRoot, expected),
    /requires a clean target working tree/u
  );
  fs.rmSync(path.join(projectRoot, "untracked.txt"));

  fs.writeFileSync(path.join(projectRoot, "tracked.txt"), "new committed target\n", "utf8");
  git(projectRoot, ["add", "tracked.txt"]);
  git(projectRoot, ["commit", "-m", "target drift after verification"]);
  assert.throws(
    () => assertMaterializeReviewTargetRemainedCurrent(projectRoot, expected),
    /target changed after signoff verification and before mutation/u
  );
});

test("materialization review rejects a clean target switched after execution was sealed", async () => {
  const trusted = reviewerAuthority();
  const policyJson = governancePolicy(trusted.authority);
  const sealed = await sealedGovernanceRun(policyJson, "switched-target-after-execution");
  const authorities = loadOperatorAuthenticatedMaterializeReviewAuthorities({
    projectRoot: sealed.projectRoot,
    layout: sealed.layout,
    operatorPolicyJson: policyJson
  });
  fs.appendFileSync(
    path.join(sealed.projectRoot, ".git", "info", "exclude"),
    "/.smithers/workflows/\n/.ultrafuzz/runs/\n",
    "utf8"
  );

  fs.writeFileSync(path.join(sealed.projectRoot, "post-run-target.txt"), "different clean target\n", "utf8");
  git(sealed.projectRoot, ["add", "post-run-target.txt"]);
  git(sealed.projectRoot, ["commit", "-m", "switch target after sealed execution"]);

  assert.throws(
    () =>
      materializeReviewSignoffRequest({
        projectRoot: sealed.projectRoot,
        layout: sealed.layout,
        selections: [],
        authorities
      }),
    /does not exactly match the clean target sealed before model execution/u
  );
});

test("run-local reviewer-key substitution cannot replace the externally resupplied operator trust root", async () => {
  const trusted = reviewerAuthority("reviewer");
  const attacker = reviewerAuthority("reviewer");
  const trustedPolicy = governancePolicy(trusted.authority);
  const attackerPolicy = governancePolicy(attacker.authority);
  const sealed = await sealedGovernanceRun(attackerPolicy, "forged-local-authority");

  assert.throws(
    () =>
      loadOperatorAuthenticatedDataGovernancePolicy({
        projectRoot: sealed.projectRoot,
        layout: sealed.layout,
        operatorPolicyJson: undefined
      }),
    /operator data-governance policy to be supplied again/u
  );
  const locallyClaimed = loadOperatorAuthenticatedMaterializeReviewAuthorities({
    projectRoot: sealed.projectRoot,
    layout: sealed.layout,
    operatorPolicyJson: attackerPolicy
  });
  assert.equal(locallyClaimed[0]?.public_key_sha256, attacker.authority.public_key_sha256);
  assert.throws(
    () =>
      loadOperatorAuthenticatedMaterializeReviewAuthorities({
        projectRoot: sealed.projectRoot,
        layout: sealed.layout,
        operatorPolicyJson: trustedPolicy
      }),
    /operator data-governance policy does not match the policy sealed before model execution/u
  );
});

test("run-local production-root downgrade cannot bypass externally authenticated review classification", async () => {
  const trusted = reviewerAuthority();
  const operatorPolicy = governancePolicy(trusted.authority);
  const downgradedRunPolicy = governancePolicy(trusted.authority, ["other"]);
  const sealed = await sealedGovernanceRun(downgradedRunPolicy, "forged-production-roots");

  assert.throws(
    () =>
      loadOperatorAuthenticatedDataGovernancePolicy({
        projectRoot: sealed.projectRoot,
        layout: sealed.layout,
        operatorPolicyJson: operatorPolicy
      }),
    /operator data-governance policy does not match|production source roots/u
  );
});

test("altered or missing governance provenance fails sealed authority authentication", async () => {
  const trusted = reviewerAuthority();
  const policyJson = governancePolicy(trusted.authority);
  const sealed = await sealedGovernanceRun(policyJson, "governance-snapshot-integrity");
  const original = fs.readFileSync(sealed.governancePath);
  const load = () =>
    loadOperatorAuthenticatedMaterializeReviewAuthorities({
      projectRoot: sealed.projectRoot,
      layout: sealed.layout,
      operatorPolicyJson: policyJson
    });
  assert.equal(load()[0]?.public_key_sha256, trusted.authority.public_key_sha256);

  fs.writeFileSync(sealed.governancePath, Buffer.concat([original, Buffer.from(" ")]));
  assert.throws(load, /sealed workflow execution file changed|data-governance provenance/u);
  fs.writeFileSync(sealed.governancePath, original);
  fs.rmSync(sealed.governancePath);
  assert.throws(load, /ENOENT|workflow execution file|data-governance provenance/u);
});
