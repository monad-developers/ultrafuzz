import { describe, expect, it } from "vitest";

import { extractPromptVariables, validateTopology } from "../src/index.js";
import { validTopology } from "./helpers.js";

const FINDING_VOCABULARY_REFERENCES = "\n{{finding_reachability_vocabulary}}\n{{finding_note_key_vocabulary}}\n";

function validateFindingsStrategyPrompt(prompt: string): void {
  validateTopology(validTopology(), {
    promptTexts: { "strategies/strategy.md": `${prompt}${FINDING_VOCABULARY_REFERENCES}` }
  });
}

describe("artifact handoff validation", () => {
  it("accepts ancestor handoffs to primary artifacts", () => {
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: {
          "review/review.md": "Read {{artifact_handoff:strategy}} and {{ancestor_artifacts:strategy}}."
        }
      })
    ).not.toThrow();
    for (const prompt of [
      "Do not write {{output_findings_path}}.",
      "Avoid writing findings to {{output_findings_path}}.",
      "You must not write findings to {{output_findings_path}}.",
      "Writing findings to {{output_findings_path}} is forbidden.",
      "It is forbidden to write findings to {{output_findings_path}}.",
      "Under no circumstances write findings to {{output_findings_path}}.",
      "No agent should write findings to {{output_findings_path}}.",
      "The previous worker failed to write findings to {{output_findings_path}}.",
      "You need not write findings to {{output_findings_path}}.",
      "You should not write findings to {{output_findings_path}}.",
      "Do not ever write findings to {{output_findings_path}}.",
      "Do not: write findings to {{output_findings_path}}.",
      "Never; emit findings to {{output_findings_path}}.",
      "Under no circumstances: write findings to {{output_findings_path}}.",
      "Do not\nwrite findings to {{output_findings_path}}.",
      "Never\nwrite findings to {{output_findings_path}}.",
      "Under no circumstances\n- Write findings to {{output_findings_path}}.",
      "Record whether the existing file at {{output_findings_path}} was produced by another tool.",
      "Write no findings to {{output_findings_path}}.",
      "Write nothing to {{output_findings_path}}.",
      "Write zero output to {{output_findings_path}}.",
      "Write anything except findings to {{output_findings_path}}.",
      "Investigate. Write nothing to {{output_findings_path}}.",
      "Be sure to write nothing to {{output_findings_path}}.",
      "Do not fail to write anything except findings to {{output_findings_path}}.",
      "You must not\nwrite findings to {{output_findings_path}}.",
      "You should not\nwrite findings to {{output_findings_path}}.",
      "Do not ever\nwrite findings to {{output_findings_path}}.",
      "Avoid:\nWrite findings to {{output_findings_path}}.",
      "There is no need to:\nwrite findings to {{output_findings_path}}.",
      "Do not under any circumstances:\nwrite findings to {{output_findings_path}}.",
      "It is forbidden to:\nwrite findings to {{output_findings_path}}.",
      "You are prohibited from doing this:\nwrite findings to {{output_findings_path}}.",
      "Refrain from:\nwrite findings to {{output_findings_path}}.",
      "Don't\nwrite findings to {{output_findings_path}}.",
      "No agent should\nwrite findings to {{output_findings_path}}.",
      "You mustn't:\nWrite findings to {{output_findings_path}}.",
      "You cannot:\nWrite findings to {{output_findings_path}}.",
      "Exclude the following:\n- Write findings to {{output_findings_path}}.",
      "The following is disallowed:\n- Write findings to {{output_findings_path}}.",
      "Omit this action:\nWrite findings to {{output_findings_path}}.",
      "Skip:\n1. Write findings to {{output_findings_path}}.",
      "You aren't allowed to:\nWrite findings to {{output_findings_path}}.",
      "You aren't permitted to:\nWrite findings to {{output_findings_path}}.",
      "You are barred from doing this:\nWrite findings to {{output_findings_path}}.",
      "The following actions are barred:\n- Modify source files.\n- Write findings to {{output_findings_path}}.",
      "Prevent the following:\n- Write findings to {{output_findings_path}}.",
      "Refuse to:\nWrite findings to {{output_findings_path}}.",
      "The following is banned:\nWrite findings to {{output_findings_path}}.",
      "It is illegal to:\nWrite findings to {{output_findings_path}}.",
      "Decline to:\nWrite findings to {{output_findings_path}}.",
      "Do everything except:\nWrite findings to {{output_findings_path}}.",
      "You mayn't:\nWrite findings to {{output_findings_path}}.",
      "Do not perform any of the following:\n- Modify source files.\n- Write findings to {{output_findings_path}}.",
      "Never do these things\n- Change tests.\n- Write findings to {{output_findings_path}}.",
      "Never do these things.\n- Change tests.\n- Write findings to {{output_findings_path}}.",
      "Never do these things.\n- Be sure to write findings to {{output_findings_path}}.",
      "Optional:\n- Be sure to write findings to {{output_findings_path}}.",
      "## Optional\n\nWrite findings to {{output_findings_path}}.",
      "## Never do this\n\nWrite findings to {{output_findings_path}}.",
      "Optional output:\nReview the instructions.\nWrite findings to {{output_findings_path}}.",
      "Do not perform the following:\n1. Write findings to {{output_findings_path}}.",
      "It is forbidden:\n1. Write findings to {{output_findings_path}}.",
      "It is forbidden to do the following:\n\n- Write findings to {{output_findings_path}}.",
      "Do not perform this action:\n\nWrite findings to {{output_findings_path}}.",
      `Do not perform the following action under any circumstances because it would violate the required safety policy and corrupt the audit result irreversibly:\nWrite findings to {{output_findings_path}}.`,
      "There is no need to write findings to {{output_findings_path}}.",
      "The path {{output_findings_path}} exists for another tool.",
      "Write findings to findings.json.",
      "Write an assessment of whether {{output_findings_path}} was produced by another tool.",
      "Write a note stating if {{output_findings_path}} already exists.",
      "Record your decision whether to write {{output_findings_path}}.",
      "Write a summary explaining whether {{output_findings_path}} was produced by another tool.",
      "Write a report stating if {{output_findings_path}} already exists.",
      "Write a description of whether {{output_findings_path}} should be created.",
      "Write an assessment of the existing file at {{output_findings_path}}.",
      "Investigate the output. Write a report explaining whether {{output_findings_path}} was produced by another tool.",
      "Write findings to {{output_findings_path}} if a finding exists.",
      "Write findings to {{output_findings_path}} only if a finding exists.",
      "Write findings to {{output_findings_path}} as long as a finding exists.",
      "If any findings are confirmed, write them to {{output_findings_path}}.",
      "Optional:\n- Write findings to {{output_findings_path}}.",
      "Unnecessary output:\nWrite findings to {{output_findings_path}}.",
      "Ignore this step:\nWrite findings to {{output_findings_path}}.",
      "If useful:\n- Write findings to {{output_findings_path}}."
    ]) {
      expect(() => validateFindingsStrategyPrompt(prompt), prompt).toThrow(
        expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" })
      );
    }
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
      const outputInstruction =
        contract === "ultrafuzz/findings@2"
          ? " Write findings to {{artifact_path}}/findings.json."
          : contract === "ultrafuzz/triaged-findings@1" || contract === "ultrafuzz/severity-classified-findings@1"
            ? " Write findings to {{artifact_path}}/reviewed-findings.json."
            : "";
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
            "review/triage.md": `Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}.${outputInstruction}`
          }
        })
      ).not.toThrow();
      expect(() =>
        validateTopology(topology, {
          promptTexts: {
            "review/triage.md": `Use {{ finding_reachability_vocabulary }} and {{ finding_note_key_vocabulary }}.${outputInstruction}`
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
    for (const evidence of [
      "The HTTP response had status=200.",
      "The oracle returned confidence=0.95.",
      "The trace entered scope=global before reverting.",
      "The shell printed outcome=success.",
      "The proof checks risk=0 after withdrawal.",
      "RISK_FREE_RATE=0.05 impact_price=123 helper_address=0xabc.",
      "Set FOUNDRY_PROFILE=ci.",
      "Use CHAIN_ID=1.",
      "Use CHAIN_ID=1 when testing public entrypoints.",
      "Record block_number=1.",
      "helper_balance=0 proof_size=32 root_slot=0x00 IMPACT_PRICE=123.",
      "MERKLE_ROOT=0xabc PUBLIC_KEY=0x123 risk_ratio=0.5 HELPER_BALANCE=0.",
      "const result = await run();",
      "bytes32 root = tree.root();",
      "verifyProof(root=0xabc, leaf=0xdef); proof_type=merkle.",
      "The command prints result=42.",
      "Run forge test --root=.",
      "Evidence: root=0xabc classification=error result=pass.",
      "Record evidence using helper contracts in each finding note.",
      "Perform a reachability cross-check before triage.",
      "Document reachability edge-cases in the report.",
      "Review the reachability note before triage.",
      "The reachability note was preserved byte-for-byte.",
      "Document reachability note edge-cases in the report.",
      "Reachability: internal functions require a cross-check before triage.",
      "Reachability: internal behavior must be documented.",
      "Do not set reachability to internal on every finding.",
      "The old prompt set reachability to internal on every finding.",
      "Do not set reachability=internal on every finding.",
      "Never write reachability=internal.",
      "The old prompt used reachability=internal.",
      "The historical prompt said Reachability: internal.",
      'Never emit { "reachability": "internal" }.',
      'Do not emit { "reachability": "internal" } on every finding.',
      'The previous prompt emitted { "reachability": "internal" } on every finding.',
      "Historically, prompts used Reachability: internal.",
      'Reject the instruction "Set reachability to internal on every finding."',
      "Example: Reachability: internal.",
      'Example output: { "reachability": "internal" }.',
      "The documentation contains `Reachability: internal.`",
      "An external report says Reachability: internal.",
      "Previously, the worker set reachability to internal on every finding.",
      "Formerly, the worker set reachability to internal on every finding.",
      "<!-- Reachability: internal. -->",
      "Example: rename helper_proof to helperEvidence.",
      "We discuss how to rename helper_proof to helperEvidence.",
      "The phrase `rename helper_proof to helperEvidence` is forbidden.",
      "To rename helper_proof to helperEvidence would be incorrect.",
      "Do not write helper evidence under helperEvidence in every finding note.",
      "The old prompt wrote helper evidence under helperEvidence in every finding note.",
      "Historically, prompts wrote helper evidence under helperEvidence in every finding note.",
      "The legacy prompt set reachability to internal on every finding.",
      "The deprecated prompt set reachability to internal on every finding.",
      "Reject the instruction `Set reachability to internal on every finding.`",
      "```text\nSet reachability to internal on every finding.\n```",
      "Example:\nSet reachability to internal on every finding.",
      "The phrase “Reachability: internal.” is forbidden.",
      "The old prompt incorrectly set reachability to internal on every finding.",
      "Do not ever set reachability to internal on every finding.",
      "The previous version of the prompt set reachability to internal on every finding.",
      "Historically, the prompt set reachability to internal on every finding.",
      "If a prompt says “set reachability to internal,” reject it.",
      "risK=non-semantic Unicode evidence."
    ]) {
      expect(() =>
        validateTopology(topology, {
          promptTexts: {
            "review/triage.md": `Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}. ${evidence}`
          }
        })
      ).not.toThrow();
    }

    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md": `---
id: triage
display_name: "{{finding_reachability_vocabulary}} {{finding_note_key_vocabulary}}"
---
No vocabulary references exist in the rendered prompt body.
`
        }
      })
    ).toThrow(expect.objectContaining({ code: "MISSING_REPORT_VOCABULARY_REFERENCE" }));

    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md": `---
id: triage
display_name: "root_cause=frontmatter-is-metadata"
---
Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}.
`
        }
      })
    ).not.toThrow();

    for (const standalone of ["root_cause=renamed", "reachability=public-entrypoint-trace"]) {
      expect(() =>
        validateTopology(topology, {
          promptTexts: {
            "review/triage.md": `Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}.\n${standalone}`
          }
        })
      ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));
    }
    for (const proseAlias of [
      "For every finding, set the reachability token to renamed-public-trace.",
      "For every finding, set the reachability token to internal.",
      "Use renamed-public-trace for reachability.",
      "Use internal for reachability.",
      "Every finding must include reachability_note renamed-public-trace.",
      "Every finding must include reachability_note internal.",
      "Write helper evidence under helperEvidence in every finding note.",
      'Emit { "reachability": "internal" } on every finding.',
      "Reachability: internal.",
      "Rename helper_proof to helperEvidence.",
      "Rename helper_proof into helperEvidence.",
      "Change helper_proof into helperEvidence.",
      "Replace helper_proof by helperEvidence.",
      "Set `reachability` to `internal` on every finding.",
      "Set the reachability field to internal on every finding.",
      "Rename the helper_proof note key to helperEvidence.",
      "Set **reachability** to **internal** on every finding.",
      "Rename the helper_proof key to helperEvidence.",
      "Do not set reachability to internal on every finding. Set reachability to internal on every finding.",
      "The old prompt set reachability to internal on every finding. Assign reachability internal to every finding.",
      "Never use internal for reachability. Use internal for reachability.",
      "Set the reachability field for every finding to internal.",
      "The reachability field must be internal on every finding.",
      "Every finding must have reachability internal.",
      "Use helperEvidence rather than helper_proof.",
      "Use helperEvidence in place of helper_proof.",
      "Switch helper_proof to helperEvidence.",
      "Rename helper_proof using helperEvidence.",
      "Change helper_proof over to helperEvidence.",
      "***audit_status***=accepted",
      "***report_verdict***=accepted",
      "reachability -> internal",
      "reachability → internal",
      "reachability := internal",
      "Store internal in the reachability field.",
      "Rename helper_proof -> helperEvidence.",
      "Map helper_proof onto helperEvidence.",
      "Set reachability’s value to internal on every finding.",
      "Record reachability internal on every finding.",
      "Write reachability internal on every finding.",
      "Include reachability internal on every finding.",
      "Require reachability internal on every finding.",
      "Every finding must use reachability internal.",
      "Reachability -> internal.",
      "Treat reachability as internal on every finding.",
      "For every finding, reachability is internal.",
      "Every finding's reachability is internal.",
      "All findings use internal reachability.",
      "Output internal in the reachability field on every finding.",
      "Alias helper_proof as helperEvidence.",
      "Call helper_proof helperEvidence.",
      "Retitle helper_proof as helperEvidence.",
      "Convert helper_proof into helperEvidence.",
      "helper_proof becomes helperEvidence.",
      "Write helperEvidence instead of helper_proof.",
      "Reachability is internal.",
      "Ensure reachability is internal on every finding.",
      "reachability:\n  internal",
      'Emit {\n  "reachability":\n  "internal"\n} on every finding.',
      "| reachability | internal |",
      "Rename helper_proof\n  to helperEvidence.",
      "Set the reachability field's value to internal on every finding.",
      "Set reachability for every finding equal to internal.",
      "Reachability must equal internal.",
      "Reachability shall equal internal.",
      "Put internal into the reachability field.",
      "Alias helper_proof to helperEvidence.",
      "Relabel helper_proof as helperEvidence.",
      "Use helperEvidence in lieu of helper_proof.",
      "<strong>reachability</strong> → internal.",
      "Set reachability internal on every finding.",
      "Emit reachability internal on every finding.",
      "Assign reachability internal to every finding.",
      "Mark reachability internal for each finding.",
      "helper_proof: helperEvidence.",
      "Change helper_proof to helperEvidence.",
      "Map helper_proof to helperEvidence.",
      "Replace helper_proof with helperEvidence."
    ]) {
      expect(
        () =>
          validateTopology(topology, {
            promptTexts: {
              "review/triage.md": `Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}. ${proseAlias}`
            }
          }),
        proseAlias
      ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));
    }
    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md":
            "CHAIN_ID=1 block=latest and a=b. Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}."
        }
      })
    ).not.toThrow();
    for (const unsupported of [
      "helper_summary=renamed producer key",
      "reachability_note=helper-only",
      "classification_notes=accepted",
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
      "Enforce audit_decision=accepted",
      "Set attainability=helper-only on each finding",
      "Every finding gets attainment=renamed",
      "All findings must contain attainment=renamed",
      "Set reachability_key=helper-only on each issue",
      "Store reachability_key=helper-only in every output object",
      "Label renamed_key=value on each result",
      "Annotate renamed_key=value on each issue",
      "Populate renamed_key=value in every finding",
      "Put renamed_key=value on each result",
      "Return renamed_key=value for each issue",
      "Write helper reachability under the attainability note key",
      "Add the authoritative wrapper-needed reachability note",
      "Set exposure=public on each finding",
      "Set rating=critical on each finding",
      "root_cause=renamed",
      "Record a `helper_evidence=renamed` note"
    ]) {
      expect(
        () =>
          validateTopology(topology, {
            promptTexts: {
              "review/triage.md": `Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}. Put ${unsupported} on each finding.`
            }
          }),
        unsupported
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
  it("requires explicit destinations for valid-empty output declarations", () => {
    expect(() => validateFindingsStrategyPrompt("Investigate the target and report your result.")).toThrow(
      expect.objectContaining({
        code: "MISSING_PROMPT_OUTPUT_INSTRUCTION",
        message: expect.stringMatching(/strategy.*strategies\/strategy\.md.*findings\.json.*valid-empty/iu),
        details: expect.objectContaining({
          nodeId: "strategy",
          promptPath: "strategies/strategy.md",
          path: "findings.json",
          contract: "ultrafuzz/findings@2"
        })
      })
    );

    expect(() => validateFindingsStrategyPrompt("Write findings to {{output_findings_path}}.")).not.toThrow();
    for (const prompt of [
      "Write confirmed findings, if any, to {{output_findings_path}}.",
      "Do not fail to write findings to {{output_findings_path}}.",
      "Never forget to write findings to {{output_findings_path}}.",
      "Do not omit writing findings to {{output_findings_path}}.",
      "Without fail, write findings to {{output_findings_path}}.",
      "Instructions:\nWrite findings to {{output_findings_path}}.",
      "At completion:\nWrite findings to {{output_findings_path}}.",
      "Final deliverable:\n- Write findings to {{output_findings_path}}.",
      "Results:\n- Write findings to {{output_findings_path}}.",
      "Strategy: {{strategy}}\nCurrent artifact dir: {{artifact_path}}\nWrite findings to {{output_findings_path}}.",
      "Investigate the project and write findings to {{output_findings_path}}.",
      "Please write findings to {{output_findings_path}}.",
      "Always write findings to {{output_findings_path}}.",
      "Ensure you write findings to {{output_findings_path}}.",
      "You should write findings to {{output_findings_path}}.",
      "Remember to write findings to {{output_findings_path}}.",
      "You need to write findings to {{output_findings_path}}.",
      "Be sure to write findings to {{output_findings_path}}.",
      "Do not edit source files.\nBe sure to write findings to {{output_findings_path}}.",
      "Make sure to write findings to {{output_findings_path}}.",
      "The agent must write findings to {{output_findings_path}}.",
      "The agent shall write findings to {{output_findings_path}}.",
      "The agent is required to write findings to {{output_findings_path}}.",
      "The agent is mandated to write findings to {{output_findings_path}}.",
      "Findings must be written to {{output_findings_path}}.",
      "Findings are required to be written to {{output_findings_path}}.",
      "Findings are mandatory and must be written to {{output_findings_path}}.",
      "All confirmed findings shall be written to {{output_findings_path}}.",
      "- Do not edit source files\n- Write findings to {{output_findings_path}}.",
      "Do not perform any of the following:\n- Modify source files.\n\nRequired output: Write findings to {{output_findings_path}}.",
      "Do not write findings to {{output_findings_path}}. Write findings to {{output_findings_path}}.",
      "Do not write findings to {{output_findings_path}}.\nWrite findings to {{output_findings_path}}.",
      "Write all confirmed findings except duplicates to {{output_findings_path}}.",
      "Required output: write findings to {{output_findings_path}}.",
      "Required output:\n- Write findings to {{output_findings_path}}.",
      "Required output:\n* Write findings to {{output_findings_path}}.",
      "Deliverables:\nWrite findings to {{output_findings_path}}.",
      "Mandatory output:\nWrite findings to {{output_findings_path}}.",
      "You must:\nWrite findings to {{output_findings_path}}.",
      "Required deliverables:\nWrite findings to {{output_findings_path}}.",
      "Mandatory deliverable:\nWrite findings to {{output_findings_path}}.",
      "Output:\nWrite findings to {{output_findings_path}}.",
      "Final output:\nWrite findings to {{output_findings_path}}.",
      "Steps:\nWrite findings to {{output_findings_path}}.",
      "Actions:\nWrite findings to {{output_findings_path}}.",
      "Artifact finalization:\nWrite findings to {{output_findings_path}}.",
      "## Optional\n\n## Required output\n\nWrite findings to {{output_findings_path}}."
    ]) {
      expect(() => validateFindingsStrategyPrompt(prompt), prompt).not.toThrow();
    }

    expect(() =>
      validateFindingsStrategyPrompt(
        "Do not perform any of the following:\n- Write findings to {{output_findings_path}}.\n\nRequired output:\n- Write findings to {{output_findings_path}}."
      )
    ).not.toThrow();

    for (const prompt of [
      "Output is discretionary:\nWrite findings to {{output_findings_path}}.",
      "Discouraged outputs:\n- Write findings to {{output_findings_path}}.",
      "Suggested output:\nWrite findings to {{output_findings_path}}.",
      "Recommended output:\nWrite findings to {{output_findings_path}}.",
      "Example output:\nWrite findings to {{output_findings_path}}.",
      "Output is elective:\nWrite findings to {{output_findings_path}}.",
      "Output is merely illustrative:\nWrite findings to {{output_findings_path}}.",
      "## Write findings; optional\n\nWrite findings to {{output_findings_path}}.",
      "Write findings to {{output_findings_path}} when convenient.",
      "Write findings to {{output_findings_path}} at your discretion.",
      "Write findings to {{output_findings_path}} when appropriate.",
      "Write findings to {{output_findings_path}} as needed.",
      "Write findings to {{output_findings_path}} where helpful.",
      "Write findings to {{output_findings_path}} should you wish.",
      "Possible output:\nWrite findings to {{output_findings_path}}.",
      "For reference only:\nWrite findings to {{output_findings_path}}.",
      "Recommendation output:\nWrite findings to {{output_findings_path}}.",
      "Nonessential output:\nWrite findings to {{output_findings_path}}.",
      "Candidate output:\nWrite findings to {{output_findings_path}}.",
      "Investigate. Write findings to {{output_findings_path}} when useful.",
      "Write findings to {{output_findings_path}} when warranted.",
      "Write findings to {{output_findings_path}} where beneficial.",
      "Write findings to {{output_findings_path}} as appropriate.",
      "Write findings to {{output_findings_path}} on request.",
      "Required output:\nBe sure to write findings to {{output_findings_path}} if useful.",
      "Results:\nMake sure to write findings to {{output_findings_path}} when warranted.",
      "Write findings to {{output_findings_path}} upon request.",
      "Write findings to {{output_findings_path}} unless unnecessary.",
      "Write findings to {{output_findings_path}} provided they are useful.",
      "Write findings to {{output_findings_path}} only as warranted.",
      "Write findings to {{output_findings_path}} contingent on usefulness.",
      "Write findings to {{output_findings_path}} subject to need.",
      "Write findings to {{output_findings_path}} whenever beneficial.",
      "Write findings to {{output_findings_path}} depending on circumstances.",
      "Write findings to {{output_findings_path}} in case they help.",
      "Write findings to {{output_findings_path}}. This is optional.",
      "Write findings to {{output_findings_path}}, should findings exist.",
      "Write findings to {{output_findings_path}} except when unnecessary.",
      "Write findings to {{output_findings_path}} at need.",
      "Write findings to {{output_findings_path}} depending upon circumstances.",
      "Write findings to {{output_findings_path}} to the extent helpful.",
      "Write findings to {{output_findings_path}}. Publication is optional.",
      "Write findings to {{output_findings_path}}; omit when unnecessary.",
      "Write findings to {{output_findings_path}} only when valuable.",
      "Write findings to {{output_findings_path}} assuming findings exist.",
      "Write findings to {{output_findings_path}} in the event findings exist.",
      "Investigate first. Write an assessment of the existing file at {{output_findings_path}}.",
      "Investigate first. Write findings to {{output_findings_path}} if a finding exists."
    ]) {
      expect(() => validateFindingsStrategyPrompt(prompt), prompt).toThrow(
        expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" })
      );
    }

    expect(() =>
      validateFindingsStrategyPrompt(
        "---\nid: strategy\ndisplay_name: Write findings to {{output_findings_path}}\n---\nInvestigate the target."
      )
    ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));
  });

  it("rejects placeholder empties and instructions that bind the destination to different content", () => {
    for (const prompt of [
      "Write [] to {{output_findings_path}} as a placeholder.",
      "Write [] to {{output_findings_path}}.",
      "Write to {{output_findings_path}}.",
      "Create an empty placeholder at {{output_findings_path}}.",
      "Create an empty findings array at {{output_findings_path}} without reviewing the target.",
      "Write compiler logs to {{output_findings_path}}.",
      "Write findings, then output compiler logs to {{output_findings_path}}.",
      "Whether or not findings exist, write compiler logs to {{output_findings_path}}.",
      "Save a checksum at {{output_findings_path}}.",
      "Record the number of findings in {{output_findings_path}}.",
      "{{output_findings_path}} must be written with the number of findings.",
      "List source files in {{output_findings_path}}.",
      "If findings exist, then write findings to {{output_findings_path}}.",
      "Unless no findings exist, also write findings to {{output_findings_path}}.",
      "If findings exist, write them to {{output_findings_path}}. Otherwise do nothing.",
      "Where helpful, write findings to {{output_findings_path}}.",
      "Where helpful, validate the JSON, then write findings to {{output_findings_path}}.",
      "On request, write findings to {{output_findings_path}}.",
      "At your discretion, write findings to {{output_findings_path}}.",
      "As needed, write findings to {{output_findings_path}}.",
      "Depending on circumstances, write findings to {{output_findings_path}}.",
      "In case findings exist, write findings to {{output_findings_path}}.",
      "Only when valuable, write findings to {{output_findings_path}}.",
      "Should findings exist, write findings to {{output_findings_path}}.",
      "Review the target and, if useful, write findings to {{output_findings_path}}.",
      "You may choose to write findings to {{output_findings_path}}.",
      "You can write findings to {{output_findings_path}}.",
      "Consider writing findings to {{output_findings_path}}.",
      "The previous worker attempted to write findings to {{output_findings_path}}.",
      "The agent isn't required to write findings to {{output_findings_path}}.",
      "Mention findings in the plan. Collect compiler logs. Write them to {{output_findings_path}}.",
      "If findings exist, write them to {{output_findings_path}}. Otherwise write an empty report elsewhere.",
      "If findings exist, write them to {{output_findings_path}}; otherwise write an empty findings array to {{artifact_dir}}/backup.json.",
      "Collect compiler logs. Write them to {{output_findings_path}}.",
      "{{output_findings_path}} must be written with compiler logs, not findings.",
      "Create a findings placeholder at {{output_findings_path}}.",
      "Write findings, but not to {{output_findings_path}}.",
      "Write findings to somewhere other than {{output_findings_path}}.",
      "Write an empty list of findings to {{output_findings_path}}.",
      "Write findings to stdout, not {{output_findings_path}}.",
      "Write findings to another destination; the declared path {{output_findings_path}} exists for another tool.",
      "{{output_findings_path}} must be written with no findings.",
      "Write anything but findings to {{output_findings_path}}.",
      "Write findings to {{output_findings_path}} only after confirming one.",
      "Write findings to {{output_findings_path}} once a finding is confirmed.",
      "Write findings to {{output_findings_path}} as applicable.",
      "Write empty findings to {{output_findings_path}}.",
      "Write a zero-findings result to {{output_findings_path}}.",
      "Write a findings array with zero entries to {{output_findings_path}}.",
      "Write findings containing no entries to {{output_findings_path}}.",
      "Write findings to {{output_findings_path}}. Never actually create it.",
      "Write findings to {{output_findings_path}}. However, never actually create it.",
      "Write findings to {{output_findings_path}}, but this output is optional.",
      "If possible:\nWrite findings to {{output_findings_path}}.",
      "Suggestion:\nWrite findings to {{output_findings_path}}.",
      "Recommendation:\nWrite findings to {{output_findings_path}}.",
      "Potential action:\nWrite findings to {{output_findings_path}}.",
      "Required output:\n> Write findings to {{output_findings_path}}."
    ]) {
      expect(() => validateFindingsStrategyPrompt(prompt), prompt).toThrow(
        expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" })
      );
    }
  });

  it("rejects conditional, descriptive, historical, quoted, code, comment, and example contexts", () => {
    for (const prompt of [
      "Write findings, if they exist, to {{output_findings_path}}.",
      "Write findings if confirmed to {{output_findings_path}}.",
      "Write findings if useful in {{output_findings_path}}.",
      "Write an explanation of how to save findings to {{output_findings_path}}.",
      "Write an analysis of how to persist findings to {{output_findings_path}}.",
      "Explain why you should write findings to {{output_findings_path}}.",
      "Determine whether to write findings to {{output_findings_path}}.",
      "Decide whether to write findings to {{output_findings_path}}.",
      "Assess whether to write findings to {{output_findings_path}}.",
      "The docs say you must write findings to {{output_findings_path}}.",
      "Write a note saying to write findings to {{output_findings_path}}.",
      "The prior agent was required to write findings to {{output_findings_path}}.",
      "Previously, the worker had to write findings to {{output_findings_path}}.",
      'The example says: "Write findings to {{output_findings_path}}."',
      "The example says: 'Write findings to {{output_findings_path}}.'",
      "The example says: ‘Write findings to {{output_findings_path}}.’",
      'The example says: "Write findings to\n{{output_findings_path}}."',
      "> Write findings to {{output_findings_path}}.",
      "`Write findings to {{output_findings_path}}.`",
      "`Write findings to\n{{output_findings_path}}.`",
      "```markdown\nWrite findings to {{output_findings_path}}.\n```",
      "~~~text\nWrite findings to {{output_findings_path}}.\n~~~",
      "<!-- Write findings to {{output_findings_path}}. -->",
      "<!--\nWrite findings to {{output_findings_path}}.\n-->",
      "Investigate. <!-- Write findings to {{output_findings_path}}. -->",
      "Writing findings to {{output_findings_path}} is optional.",
      "Write findings to {{output_findings_path}}, for example.",
      "Write findings to {{output_findings_path}}. This output is optional.",
      "Write findings documentation to {{output_findings_path}}.",
      "Copy the string 'findings' to {{output_findings_path}}.",
      "If useful, ensure {{output_findings_path}} contains all findings.",
      "Ensure {{output_findings_path}} contains all findings if useful.",
      "Populate {{output_findings_path}} with findings if useful.",
      "It may be useful to write findings to {{output_findings_path}}.",
      "It is possible to write findings to {{output_findings_path}}.",
      "We recommend you write findings to {{output_findings_path}}.",
      "For documentation, write findings to {{output_findings_path}}.",
      "To explain the workflow, write findings to {{output_findings_path}}.",
      "Write findings as appropriate to {{output_findings_path}}.",
      "Perhaps write findings to {{output_findings_path}}.",
      "Ideally write findings to {{output_findings_path}}.",
      "Optionally write findings to {{output_findings_path}}.",
      "The worker will write findings to {{output_findings_path}}.",
      "    Write findings to {{output_findings_path}}.",
      "- Example:\n\n      Write findings to {{output_findings_path}}.",
      "Write a list mentioning findings to {{output_findings_path}}.",
      "Write the filename of findings to {{output_findings_path}}.",
      "Write a link to findings to {{output_findings_path}}.",
      "## Optional output\n\nWrite findings to {{output_findings_path}}.",
      "## If findings exist\n\nWrite findings to {{output_findings_path}}.",
      "## When appropriate\n\nWrite findings to {{output_findings_path}}.",
      "## Example output\n\nWrite findings to {{output_findings_path}}.",
      "## Never write findings\n\nWrite findings to {{output_findings_path}}.",
      "Example: Write findings to {{output_findings_path}}.",
      "Historical output:\nWrite findings to {{output_findings_path}}.",
      "> Example instruction:\nWrite findings to {{output_findings_path}}.",
      "- Example instruction:\n  Write findings to {{output_findings_path}}.",
      "The phrase “write findings” appears next to {{output_findings_path}}.",
      "Here is how to write findings to {{output_findings_path}}.",
      "Upon confirming a finding, write findings to {{output_findings_path}}.",
      "Write findings to {{output_findings_path}} after confirming one.",
      "If convenient, write findings to {{output_findings_path}}. Otherwise write empty findings.",
      "If useful, write findings to {{output_findings_path}}. Else write an empty findings array.",
      "Write findings to {{output_findings_path}} if convenient, or an empty array if there are no findings.",
      "Write findings to {{output_findings_path}} if any exist; otherwise write an empty findings array there if convenient.",
      "The old prompt said to write findings to {{output_findings_path}}.",
      "The prompt text is: Write findings to {{output_findings_path}}.",
      "Example command — write findings to {{output_findings_path}}.",
      "It is optional to write findings to {{output_findings_path}}.",
      "It is not mandatory to write findings to {{output_findings_path}}.",
      "(Optional) Write findings to {{output_findings_path}}.",
      "[Optional] Write findings to {{output_findings_path}}.",
      "Write findings to {{output_findings_path}} (optional).",
      "Write findings to {{output_findings_path}} — optional.",
      "Write findings to {{output_findings_path}}; this step is optional.",
      "An optional step is to write findings to {{output_findings_path}}.",
      "The agent has the option to write findings to {{output_findings_path}}.",
      "Deprecated: Write findings to {{output_findings_path}}.",
      "The following instruction is obsolete:\nWrite findings to {{output_findings_path}}.",
      "Write findings to {{output_findings_path}}. You do not have to do so.",
      "Write findings to {{output_findings_path}}. Do not follow this instruction.",
      "Examples\n\nWrite findings to {{output_findings_path}}.",
      "Write findings to {{output_findings_path}} optionally.",
      "Write findings to {{output_findings_path}}, but you may omit it.",
      "It is unnecessary to write findings to {{output_findings_path}}.",
      "There is no requirement to write findings to {{output_findings_path}}.",
      "You do not have to write findings to {{output_findings_path}}.",
      "The agent needn't write findings to {{output_findings_path}}.",
      "You are under no obligation to write findings to {{output_findings_path}}.",
      "The legacy prompt told agents to write findings to {{output_findings_path}}.",
      "Old instructions asked agents to write findings to {{output_findings_path}}.",
      "As an example, write findings to {{output_findings_path}}.",
      "Hypothetically, write findings to {{output_findings_path}}."
    ]) {
      expect(() => validateFindingsStrategyPrompt(prompt), prompt).toThrow(
        expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" })
      );
    }
  });

  it("accepts explicit imperative findings variants while preserving path-only code spans", () => {
    for (const prompt of [
      "Copy all confirmed findings to {{output_findings_path}}.",
      "Write all confirmed bugs to `{{output_findings_path}}`.",
      "Ensure {{output_findings_path}} contains all confirmed findings.",
      "In {{output_findings_path}}, place all confirmed findings.",
      "Place in {{output_findings_path}} all confirmed findings.",
      "Return all confirmed findings in {{output_findings_path}}.",
      "Populate {{output_findings_path}} with all confirmed findings.",
      "Append all confirmed findings to {{output_findings_path}}.",
      "Document all confirmed findings in {{output_findings_path}}.",
      "1. Required outputs:\n   - Write structured findings to:\n     {{output_findings_path}}",
      "Write structured findings to:\n\n{{output_findings_path}}\n\nReview details when useful."
    ]) {
      expect(() => validateFindingsStrategyPrompt(prompt), prompt).not.toThrow();
    }
  });

  it("accepts mandatory empty-result clauses, affirmative negation headings, and ordinary output verbs", () => {
    for (const prompt of [
      "Write findings to {{output_findings_path}} even if there are none.",
      "If findings exist, write them to {{output_findings_path}}. Otherwise write an empty findings array there.",
      "Write findings to {{output_findings_path}} whether or not any findings exist.",
      "Write findings to {{output_findings_path}} whether any findings exist or not.",
      "Whether or not any findings exist, write findings to {{output_findings_path}}.",
      "Even if there are no findings, write findings to {{output_findings_path}}.",
      "Regardless of whether findings exist, write findings to {{output_findings_path}}.",
      "Not optional:\nWrite findings to {{output_findings_path}}.",
      "Do not forget:\nWrite findings to {{output_findings_path}}.",
      "Never omit:\nWrite findings to {{output_findings_path}}.",
      "Required (do not omit):\nWrite findings to {{output_findings_path}}.",
      "Store findings at {{output_findings_path}}.",
      "Write the standard findings output to {{output_findings_path}}.",
      "Publish findings to {{output_findings_path}}.",
      "Deliver findings to {{output_findings_path}}.",
      "Put findings in {{output_findings_path}}.",
      "Serialize findings to {{output_findings_path}}.",
      "Output findings to {{output_findings_path}}.",
      "{{output_findings_path}} must be written with all findings.",
      "`{{output_findings_path}}` must be written with all findings.",
      "Write the findings. They must be saved to {{output_findings_path}}.",
      "Collect confirmed findings. Write them to {{output_findings_path}}.",
      "Collect confirmed findings, then write them to {{output_findings_path}}.",
      "Write all findings discovered during the audit to {{output_findings_path}}.",
      "The required findings are to be written to {{output_findings_path}}.",
      "Do not write logs; write findings to {{output_findings_path}}.",
      "Do not write logs, but write findings to {{output_findings_path}}.",
      "You must not fail to write findings to {{output_findings_path}}.",
      "Regardless of outcome, write findings to {{output_findings_path}}.",
      "In every case, write findings to {{output_findings_path}}.",
      "At completion, write findings to {{output_findings_path}}.",
      "Finally, write findings to {{output_findings_path}}.",
      "Ensure findings are written to {{output_findings_path}}.",
      "Make sure findings are saved to {{output_findings_path}}.",
      "You have to write findings to {{output_findings_path}}.",
      "It is required that findings be written to {{output_findings_path}}.",
      "Findings have to be written to {{output_findings_path}}.",
      "Findings need to be written to {{output_findings_path}}.",
      "When analysis is complete, write findings to {{output_findings_path}}.",
      "After completing the audit, write findings to {{output_findings_path}}.",
      "Once complete, write findings to {{output_findings_path}}.",
      "Submit findings to {{output_findings_path}}.",
      "Create {{output_findings_path}} containing all findings.",
      "Export findings to {{output_findings_path}}.",
      "Without fail:\nWrite findings to {{output_findings_path}}.",
      "## Do not edit source files\n\nWrite findings to {{output_findings_path}}.",
      "## Optional dependency behavior\n\nAlways write findings to {{output_findings_path}}.",
      "## Write findings; do not modify source files\n\nWrite findings to {{output_findings_path}}.",
      "## No-findings handling\n\nWrite findings to {{output_findings_path}} even if none exist.",
      "Write the findings.json artifact to {{output_findings_path}}.",
      "Write confirmed findings from src/Foo.sol to {{output_findings_path}}.",
      "Do not modify source code, but write findings to {{output_findings_path}}.",
      "Write findings to {{output_findings_path}}; if possible, validate the JSON.",
      "Write findings, or an empty array if there are none, to {{output_findings_path}}.",
      "Always write findings to {{output_findings_path}}, using the schema-defined empty form if none exist.",
      "The output at {{output_findings_path}} must contain all findings.",
      "Write findings to {{output_findings_path}} only.",
      "Generate findings at {{output_findings_path}}.",
      "Render all findings into {{output_findings_path}}.",
      "Materialize the findings in {{output_findings_path}}.",
      "Capture all findings in {{output_findings_path}}.",
      "Use {{output_findings_path}} as the required findings output.",
      "{{output_findings_path}} is the required destination for findings.",
      "If findings exist, write them to {{output_findings_path}}; otherwise write an empty findings array there.",
      "Write findings to {{output_findings_path}} if any exist; otherwise write an empty findings array there.",
      "No-finding finalization:\nWrite findings to {{output_findings_path}} even if there are none.",
      "Output with no findings:\nWrite findings to {{output_findings_path}} even if there are none.",
      "No omissions:\nWrite findings to {{output_findings_path}}.",
      "Mandatory no-result behavior:\nWrite findings to {{output_findings_path}} even if none exist."
    ]) {
      expect(() => validateFindingsStrategyPrompt(prompt), prompt).not.toThrow();
    }
  });

  it("applies valid-empty checks generically and accepts only the exact current output destination", () => {
    const topology = validTopology();
    topology.nodes[2] = {
      ...topology.nodes[2]!,
      outputs: [
        { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true },
        { path: "nested/results.txt", contract: "ultrafuzz/text@1", primary: false }
      ]
    };

    for (const prompt of [
      "Write a result somewhere in {{artifact_dir}}.",
      "Write {{artifact_dir}}/results.txt.",
      "Write findings to {{output_findings_path}}.",
      "The destination is {{artifact_path}}/nested/results.txt. Write logs to {{artifact_path}}/other.txt.",
      "Do not write {{artifact_path}}/nested/results.txt. Write logs to {{artifact_path}}/other.txt.",
      "Write {{artifact_path}}/nested/results.txt.bak.",
      "Write {{artifact_path}}/nested/results.txt/backup.",
      "Write {{artifact_path}}/nested/results.txt-old.",
      "Write {{artifact_path}}/nested/results.txt2."
    ]) {
      expect(() => validateTopology(topology, { promptTexts: { "strategies/strategy.md": prompt } })).toThrow(
        expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" })
      );
    }
    for (const prompt of [
      "Write {{artifact_path}}/nested/results.txt?backup.",
      "Write {{artifact_path}}/nested/results.txt#copy.",
      "Write {{artifact_path}}/nested/results.txt:bak."
    ]) {
      expect(() => validateTopology(topology, { promptTexts: { "strategies/strategy.md": prompt } })).toThrow();
    }
    expect(() =>
      validateTopology(topology, {
        promptTexts: { "strategies/strategy.md": "Write {{artifact_path}}/nested/results.txt." }
      })
    ).not.toThrow();
    expect(() =>
      validateTopology(topology, {
        promptTexts: { "strategies/strategy.md": "Write {{artifact_dir}}/nested/results.txt." }
      })
    ).not.toThrow();
    expect(() =>
      validateTopology(topology, {
        promptTexts: { "strategies/strategy.md": "The result must be written to {{artifact_path}}/nested/results.txt." }
      })
    ).not.toThrow();
  });

  it("does not let an unrelated write authenticate a later destination mention", () => {
    for (const prompt of [
      "Write a note, then inspect {{output_findings_path}}.",
      "Write a note and do not create {{output_findings_path}}.",
      "Write a report about {{output_findings_path}}.",
      "Create the parent directory for {{output_findings_path}}.",
      "Write {{output_findings_path}}.bak.",
      "Write logs elsewhere and inspect {{output_findings_path}}.",
      "Write logs elsewhere; never create {{output_findings_path}}.",
      "Write logs elsewhere; don't create {{output_findings_path}}.",
      "Write logs elsewhere and fail to create {{output_findings_path}}.",
      "Write logs elsewhere and cannot create {{output_findings_path}}.",
      "Write logs elsewhere and may not create {{output_findings_path}}.",
      "Write logs elsewhere; the agent isn't required to create {{output_findings_path}}.",
      "Write logs elsewhere and doesn't create {{output_findings_path}}.",
      "Write logs elsewhere and do nothing to {{output_findings_path}}.",
      "Write logs elsewhere and point to {{output_findings_path}}.",
      "Write logs elsewhere to say {{output_findings_path}} already exists.",
      "Record {{output_findings_path}} exists.",
      "List {{output_findings_path}} among the files to inspect.",
      "Write a summary explaining that {{output_findings_path}} already exists.",
      "Write a note saying {{output_findings_path}} already exists.",
      "Write logs containing {{output_findings_path}}."
    ]) {
      expect(() => validateFindingsStrategyPrompt(prompt), prompt).toThrow(
        expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" })
      );
    }

    const textTopology = validTopology();
    textTopology.nodes[2] = {
      ...textTopology.nodes[2]!,
      outputs: [
        { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true },
        { path: "nested/results.txt", contract: "ultrafuzz/text@1", primary: false }
      ]
    };
    for (const prompt of [
      "Write logs elsewhere and inspect {{artifact_dir}}/nested/results.txt.",
      "Write output to {{artifact_dir}}/nested/results.txt.bak.",
      "Write logs mentioning {{artifact_dir}}/nested/results.txt."
    ]) {
      expect(
        () => validateTopology(textTopology, { promptTexts: { "strategies/strategy.md": prompt } }),
        prompt
      ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));
    }
  });

  it("uses current contract metadata to require generated-test destinations", () => {
    const topology = validTopology();
    topology.nodes[2] = {
      ...topology.nodes[2]!,
      outputs: [
        { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true },
        { path: "generated-tests.json", contract: "ultrafuzz/generated-tests@3", primary: false }
      ]
    };

    expect(() =>
      validateTopology(topology, {
        promptTexts: { "strategies/strategy.md": "Write {{artifact_path}}/report.md." }
      })
    ).toThrow(
      expect.objectContaining({
        code: "MISSING_PROMPT_OUTPUT_INSTRUCTION",
        details: expect.objectContaining({
          path: "generated-tests.json",
          contract: "ultrafuzz/generated-tests@3"
        })
      })
    );
    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "strategies/strategy.md": "Write {{artifact_path}}/report.md. Write {{artifact_path}}/generated-tests.json."
        }
      })
    ).not.toThrow();

    for (const prompt of [
      "Write compiler logs to {{artifact_path}}/generated-tests.json.",
      "Write compiler output to {{artifact_path}}/generated-tests.json.",
      "Write the build artifact to {{artifact_path}}/generated-tests.json.",
      "Write an output file to {{artifact_path}}/generated-tests.json.",
      "Write test logs to {{artifact_path}}/generated-tests.json.",
      "Write findings to {{artifact_path}}/generated-tests.json.",
      "Save a checksum to {{artifact_path}}/generated-tests.json.",
      "Write the report to {{artifact_path}}/generated-tests.json.",
      "Write generated tests, if any exist, to {{artifact_path}}/generated-tests.json.",
      "Explain how to write the generated-test manifest to {{artifact_path}}/generated-tests.json.",
      "The prior agent wrote the generated-test manifest to {{artifact_path}}/generated-tests.json.",
      "Writing generated tests to {{artifact_path}}/generated-tests.json is optional.",
      "Ensure {{artifact_path}}/generated-tests.json contains the generated-test manifest if useful.",
      'The example says: "Write the generated-test manifest to {{artifact_path}}/generated-tests.json."',
      "> Write the generated-test manifest to {{artifact_path}}/generated-tests.json.",
      "`Write the generated-test manifest to {{artifact_path}}/generated-tests.json.`",
      "```markdown\nWrite the generated-test manifest to {{artifact_path}}/generated-tests.json.\n```",
      "<!-- Write the generated-test manifest to {{artifact_path}}/generated-tests.json. -->",
      "## Optional output\n\nWrite the generated-test manifest to {{artifact_path}}/generated-tests.json.",
      "## Example output\n\nWrite the generated-test manifest to {{artifact_path}}/generated-tests.json."
    ]) {
      expect(() => validateTopology(topology, { promptTexts: { "strategies/strategy.md": prompt } }), prompt).toThrow(
        expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" })
      );
    }
    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "strategies/strategy.md": "Write the generated-test manifest to {{artifact_path}}/generated-tests.json."
        }
      })
    ).not.toThrow();
    for (const prompt of [
      "Copy the generated-test manifest to {{artifact_path}}/generated-tests.json.",
      "Ensure {{artifact_path}}/generated-tests.json contains the generated-test manifest.",
      "In {{artifact_path}}/generated-tests.json, place the generated-test manifest.",
      "Place in {{artifact_path}}/generated-tests.json the generated-test manifest.",
      "Return the generated-test manifest in {{artifact_path}}/generated-tests.json.",
      "Populate `{{artifact_path}}/generated-tests.json` with the generated-test manifest.",
      "Append generated tests to {{artifact_path}}/generated-tests.json.",
      "Document the generated-test bundle in {{artifact_path}}/generated-tests.json."
    ]) {
      expect(
        () => validateTopology(topology, { promptTexts: { "strategies/strategy.md": prompt } }),
        prompt
      ).not.toThrow();
    }
  });

  it("matches declared output destinations case-sensitively", () => {
    expect(() => validateFindingsStrategyPrompt("Write findings to {{artifact_dir}}/FINDINGS.JSON.")).toThrow(
      expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" })
    );

    const topology = validTopology();
    topology.nodes[2] = {
      ...topology.nodes[2]!,
      outputs: [
        { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true },
        { path: "generated-tests.json", contract: "ultrafuzz/generated-tests@3", primary: false }
      ]
    };
    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "strategies/strategy.md": "Write the generated-test manifest to {{artifact_dir}}/Generated-Tests.json."
        }
      })
    ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));
  });

  it("validates candidate-heavy prompts without rescanning each full prefix", () => {
    const prompt = "Write findings to {{output_findings_path}} when useful.\n".repeat(8_000);
    const started = performance.now();
    expect(() => validateFindingsStrategyPrompt(prompt)).toThrow(
      expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" })
    );
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 5_000);

  it("requires destinations for primary and properties valid-empty outputs", () => {
    const primaryTopology = validTopology();
    primaryTopology.nodes[2] = {
      ...primaryTopology.nodes[2]!,
      outputs: [{ path: "result.txt", contract: "ultrafuzz/text@1", primary: true }]
    };
    expect(() =>
      validateTopology(primaryTopology, {
        promptTexts: { "strategies/strategy.md": "Produce the required result." }
      })
    ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));
    expect(() =>
      validateTopology(primaryTopology, {
        promptTexts: { "strategies/strategy.md": "Write {{artifact_path}}/result.txt." }
      })
    ).not.toThrow();

    const propertiesTopology = validTopology();
    propertiesTopology.nodes[2] = {
      ...propertiesTopology.nodes[2]!,
      outputs: [
        { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true },
        { path: "properties.json", contract: "ultrafuzz/properties@2", primary: false }
      ]
    };
    expect(() =>
      validateTopology(propertiesTopology, {
        promptTexts: { "strategies/strategy.md": "Produce the required report." }
      })
    ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));
    expect(() =>
      validateTopology(propertiesTopology, {
        promptTexts: { "strategies/strategy.md": "Write {{artifact_path}}/properties.json." }
      })
    ).not.toThrow();
    for (const prompt of [
      "Write compiler output to {{artifact_path}}/properties.json.",
      "Write an output file to {{artifact_path}}/properties.json.",
      "Write source files to {{artifact_path}}/properties.json."
    ]) {
      expect(
        () => validateTopology(propertiesTopology, { promptTexts: { "strategies/strategy.md": prompt } }),
        prompt
      ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));
    }
  });

  it("requires topology-derived findings destinations to resolve uniquely", () => {
    const findingsTopology = validTopology();
    findingsTopology.nodes[2] = {
      ...findingsTopology.nodes[2]!,
      outputs: [
        { path: "first-findings.json", contract: "ultrafuzz/findings@2", primary: true },
        { path: "second-findings.json", contract: "ultrafuzz/findings@2", primary: false }
      ]
    };
    expect(() =>
      validateTopology(findingsTopology, {
        promptTexts: {
          "strategies/strategy.md": `Write findings to {{output_findings_path}}.${FINDING_VOCABULARY_REFERENCES}`
        }
      })
    ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));

    const stageTopology = validTopology();
    stageTopology.nodes[2] = {
      ...stageTopology.nodes[2]!,
      outputs: [
        { path: "triaged-findings.json", contract: "ultrafuzz/triaged-findings@1", primary: true },
        { path: "findings.json", contract: "ultrafuzz/findings@2", primary: false }
      ]
    };
    expect(() =>
      validateTopology(stageTopology, {
        promptTexts: {
          "strategies/strategy.md": `Write findings to {{output_stage_findings_path}}.${FINDING_VOCABULARY_REFERENCES}`
        }
      })
    ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));
  });

  it("exempts only the canonical runtime-owned workspace patch output", () => {
    const topology = validTopology();
    topology.nodes[2] = {
      ...topology.nodes[2]!,
      outputs: [
        { path: "report.json", contract: "ultrafuzz/report@2", primary: true },
        { path: "workspace.patch", contract: "ultrafuzz/text@1", primary: false },
        { path: "workspace-patch.json", contract: "ultrafuzz/workspace-patch@1", primary: false }
      ]
    };
    expect(() =>
      validateTopology(topology, {
        promptTexts: { "strategies/strategy.md": `Produce the required report.${FINDING_VOCABULARY_REFERENCES}` }
      })
    ).not.toThrow();
  });
});
