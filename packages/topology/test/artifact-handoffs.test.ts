import { describe, expect, it } from "vitest";

import { extractPromptVariables, validateTopology } from "../src/index.js";
import { validTopology } from "./helpers.js";

describe("artifact handoff validation", () => {
  it("accepts ancestor handoffs to primary artifacts", () => {
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: {
          "review/review.md": "Read {{artifact_handoff:strategy}} and {{ancestor_artifacts:strategy}}."
        }
      })
    ).not.toThrow();
  });

  it("requires an ancestor generated-test manifest for the contract-derived handoff", () => {
    const topology = validTopology();
    topology.nodes[2] = {
      ...topology.nodes[2]!,
      outputs: [
        ...topology.nodes[2]!.outputs!,
        { path: "generated-tests.json", contract: "ultrafuzz/generated-tests@3", primary: false }
      ]
    };
    expect(() =>
      validateTopology(topology, {
        promptTexts: { "review/review.md": "Read {{ancestor_generated_test_manifests}}." }
      })
    ).not.toThrow();
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: { "review/review.md": "Read {{ancestor_generated_test_manifests}}." }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PROMPT_ARTIFACT_REFERENCE" }));
  });

  it("accepts optional ancestor handoffs filtered by exact output path", () => {
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: {
          "review/review.md":
            "Read {{ancestor_artifacts_by_path:findings.json,setup/project-discovery.md,optional.json}}."
        }
      })
    ).not.toThrow();

    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: { "review/review.md": "Read {{ancestor_artifacts_by_path:../secret}}." }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PROMPT_ARTIFACT_REFERENCE" }));
  });

  it("prefers an explicit prompt path over a colliding node-id catalog entry", () => {
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: {
          review: "Read {{artifact_handoff:missing}}.",
          "review/review.md": "Read {{artifact_handoff:strategy}}."
        }
      })
    ).not.toThrow();
  });

  it("rejects unknown, non-ancestor, and missing-primary handoffs", () => {
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: { "review/review.md": "Read {{artifact_handoff:missing}}." }
      })
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_PROMPT_ARTIFACT_REFERENCE" }));

    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: { "setup/setup.md": "Read {{artifact_handoff:review}}." }
      })
    ).toThrow(expect.objectContaining({ code: "NON_ANCESTOR_PROMPT_ARTIFACT_REFERENCE" }));

    const topology = validTopology();
    topology.nodes[2] = {
      ...topology.nodes[2]!,
      outputs: topology.nodes[2]!.outputs?.map((output) => ({ ...output, primary: false }))
    };
    expect(() =>
      validateTopology(topology, {
        promptTexts: { "review/review.md": "Read {{artifact_handoff:strategy}}." }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PRIMARY_OUTPUT" }));
  });

  it("rejects exact paths that are not declared by the producer", () => {
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: { "review/review.md": "Read {{artifact_path:strategy}}/undeclared.json." }
      })
    ).toThrow(expect.objectContaining({ code: "UNDECLARED_PROMPT_ARTIFACT_REFERENCE" }));
  });

  it("rejects unknown prompt variables", () => {
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: { "review/review.md": "Use {{not_a_real_variable}}." }
      })
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_PROMPT_VARIABLE" }));
  });

  it("rejects pruned prompt variables during handoff extraction", () => {
    expect(() => extractPromptVariables("Use {{model_profile_id}}.")).toThrow(/unknown prompt template variable/);
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: {
          "review/review.md": "Use {{model_profile_id}} and {{artifact_handoff:strategy}}."
        }
      })
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_PROMPT_VARIABLE" }));
  });

  it("validates prompt variables for implicit group/id prompt paths", () => {
    const topology = validTopology();
    topology.nodes[3] = { ...topology.nodes[3]!, prompt: undefined };

    expect(() =>
      validateTopology(topology, {
        promptTexts: { "review/review.md": "Use {{not_a_real_variable}}." }
      })
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_PROMPT_VARIABLE" }));
  });

  it("requires review producers and consumers to share authoritative report vocabularies", () => {
    const topology = validTopology();
    topology.nodes[3] = {
      ...topology.nodes[3]!,
      id: "triage",
      prompt: "review/triage.md",
      outputs: [{ path: "reviewed-findings.json", contract: "ultrafuzz/findings@2", primary: true }]
    };
    topology.nodes[4] = { ...topology.nodes[4]!, depends_on: ["triage"] };

    for (const contract of [
      "ultrafuzz/findings@2",
      "ultrafuzz/triaged-findings@1",
      "ultrafuzz/severity-classified-findings@1",
      "ultrafuzz/report@2"
    ] as const) {
      topology.nodes[3] = {
        ...topology.nodes[3]!,
        outputs:
          contract === "ultrafuzz/findings@2" || contract === "ultrafuzz/report@2"
            ? [
                { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true },
                { path: contract === "ultrafuzz/report@2" ? "report.json" : "findings.json", contract }
              ]
            : [{ path: "reviewed-findings.json", contract, primary: true }]
      };
      expect(() =>
        validateTopology(topology, {
          promptTexts: { "review/triage.md": "Hard-code reachability=renamed-public-trace." }
        })
      ).toThrow(expect.objectContaining({ code: "MISSING_REPORT_VOCABULARY_REFERENCE" }));
      expect(() =>
        validateTopology(topology, {
          promptTexts: {
            "review/triage.md": "Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}."
          }
        })
      ).not.toThrow();
    }
    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md":
            "FOUNDRY_PROFILE=ci seed=123. Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}."
        }
      })
    ).not.toThrow();
    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md":
            "CHAIN_ID=1 block=latest and a=b. Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}."
        }
      })
    ).not.toThrow();
    for (const unsupported of [
      "audit_decision=accepted",
      "finding_outcome=confirmed",
      "reachabilityEvidence=renamed",
      "reachability=renamed-public-trace",
      "reachability =renamed-public-trace",
      "reachability = renamed-public-trace",
      "likelihood=likely",
      "9root_cause=renamed",
      "audit_decision=accepted on each issue",
      "audit_decision=accepted on each result",
      "Set audit_decision=accepted",
      "Use audit_decision=accepted",
      "Define audit_decision=accepted",
      "Mark audit_decision=accepted",
      "Treat audit_decision=accepted as final",
      "Require audit_decision=accepted",
      "Mandate audit_decision=accepted",
      "The model returns audit_decision=accepted",
      "Assign audit_decision=accepted",
      "Enforce audit_decision=accepted"
    ]) {
      expect(() =>
        validateTopology(topology, {
          promptTexts: {
            "review/triage.md": `Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}. Put ${unsupported} on each finding.`
          }
        })
      ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));
    }
    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md":
            "Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}, plus classification_evidence=<summary>."
        }
      })
    ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));

    for (const renamed of ["ROOTCAUSE=renamed", "RootCause=renamed", "_root_cause=renamed"]) {
      expect(() =>
        validateTopology(topology, {
          promptTexts: {
            "review/triage.md": `Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}. Put ${renamed} on each finding.`
          }
        })
      ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));
    }

    topology.nodes[3] = {
      ...topology.nodes[3]!,
      group: "strategies"
    };
    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md": "Write stateful_failure_alias=renamed to the finding notes."
        }
      })
    ).toThrow(expect.objectContaining({ code: "MISSING_REPORT_VOCABULARY_REFERENCE" }));

    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md":
            "Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}, plus stateful_failure_alias=renamed."
        }
      })
    ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));

    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md":
            "Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}. Put root_cause_reason=renamed in notes."
        }
      })
    ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));

    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md":
            "Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}. Put root_cause_reason=renamed on each finding."
        }
      })
    ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));

    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md":
            "Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}. Put ROOT_CAUSE=renamed on each finding."
        }
      })
    ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));
  });
});
