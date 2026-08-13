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
      "Write findings to {{output_findings_path}} if a finding exists.",
      "If any findings are confirmed, write them to {{output_findings_path}}.",
      "Optional:\n- Write findings to {{output_findings_path}}.",
      "Unnecessary output:\nWrite findings to {{output_findings_path}}.",
      "Ignore this step:\nWrite findings to {{output_findings_path}}.",
      "If useful:\n- Write findings to {{output_findings_path}}."
    ]) {
      expect(
        () => validateTopology(validTopology(), { promptTexts: { "strategies/strategy.md": prompt } }),
        prompt
      ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));
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
      expect(() =>
        validateTopology(topology, {
          promptTexts: {
            "review/triage.md": "Use {{ finding_reachability_vocabulary }} and {{ finding_note_key_vocabulary }}."
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
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: { "strategies/strategy.md": "Investigate the target and report your result." }
      })
    ).toThrow(
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

    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: { "strategies/strategy.md": "Write findings to {{output_findings_path}}." }
      })
    ).not.toThrow();
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
      "The agent is required to write findings to {{output_findings_path}}.",
      "- Do not edit source files\n- Write findings to {{output_findings_path}}.",
      "Do not perform any of the following:\n- Modify source files.\n\nRequired output: Write findings to {{output_findings_path}}.",
      "Do not write findings to {{output_findings_path}}. Write findings to {{output_findings_path}}.",
      "Do not write findings to {{output_findings_path}}.\nWrite findings to {{output_findings_path}}.",
      "Write all confirmed findings except duplicates to {{output_findings_path}}.",
      "Required output: write findings to {{output_findings_path}}.",
      "Required output:\n- Write findings to {{output_findings_path}}.",
      "Required output:\n* Write findings to {{output_findings_path}}.",
      "Required output:\n> Write findings to {{output_findings_path}}.",
      "Deliverables:\nWrite findings to {{output_findings_path}}.",
      "Mandatory output:\nWrite findings to {{output_findings_path}}.",
      "You must:\nWrite findings to {{output_findings_path}}.",
      "Required deliverables:\nWrite findings to {{output_findings_path}}.",
      "Mandatory deliverable:\nWrite findings to {{output_findings_path}}.",
      "Output:\nWrite findings to {{output_findings_path}}.",
      "Final output:\nWrite findings to {{output_findings_path}}.",
      "Steps:\nWrite findings to {{output_findings_path}}.",
      "Actions:\nWrite findings to {{output_findings_path}}.",
      "Artifact finalization:\nWrite findings to {{output_findings_path}}."
    ]) {
      expect(() =>
        validateTopology(validTopology(), { promptTexts: { "strategies/strategy.md": prompt } })
      ).not.toThrow();
    }

    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: {
          "strategies/strategy.md":
            "Do not perform any of the following:\n- Write findings to {{output_findings_path}}.\n\nRequired output:\n- Write findings to {{output_findings_path}}."
        }
      })
    ).not.toThrow();

    for (const prompt of [
      "Output is discretionary:\nWrite findings to {{output_findings_path}}.",
      "Discouraged outputs:\n- Write findings to {{output_findings_path}}.",
      "Suggested output:\nWrite findings to {{output_findings_path}}.",
      "Recommended output:\nWrite findings to {{output_findings_path}}.",
      "Example output:\nWrite findings to {{output_findings_path}}.",
      "Output is elective:\nWrite findings to {{output_findings_path}}.",
      "Output is merely illustrative:\nWrite findings to {{output_findings_path}}.",
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
      expect(
        () => validateTopology(validTopology(), { promptTexts: { "strategies/strategy.md": prompt } }),
        prompt
      ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));
    }

    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: {
          "strategies/strategy.md":
            "---\nid: strategy\ndisplay_name: Write findings to {{output_findings_path}}\n---\nInvestigate the target."
        }
      })
    ).toThrow(expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" }));
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
      "Write findings to {{output_findings_path}}."
    ]) {
      expect(() => validateTopology(topology, { promptTexts: { "strategies/strategy.md": prompt } })).toThrow(
        expect.objectContaining({ code: "MISSING_PROMPT_OUTPUT_INSTRUCTION" })
      );
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
  });

  it("does not duplicate destination checks for outputs governed by separate publication gates", () => {
    const topology = validTopology();
    topology.nodes[2] = {
      ...topology.nodes[2]!,
      outputs: [
        { path: "report.json", contract: "ultrafuzz/report@2", primary: true },
        { path: "properties.json", contract: "ultrafuzz/properties@2", primary: false },
        { path: "workspace.patch", contract: "ultrafuzz/text@1", primary: false }
      ]
    };
    expect(() =>
      validateTopology(topology, { promptTexts: { "strategies/strategy.md": "Produce the required report." } })
    ).not.toThrow();
  });
});
