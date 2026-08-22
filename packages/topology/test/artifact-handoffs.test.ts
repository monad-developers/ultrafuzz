import { describe, expect, it } from "vitest";

import { extractPromptVariables, validateTopology } from "../src/index.js";
import { validTopology } from "./helpers.js";

describe("artifact handoff validation", () => {
  it("accepts ancestor handoffs to primary artifacts", () => {
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: {
          "review/review.md": "Read {{artifact_handoff:strategy}}."
        }
      })
    ).not.toThrow();
  });

  it("accepts compact generated-test authority with matching, findings-only, or no ancestors", () => {
    const topology = validTopology();
    topology.nodes[2] = {
      ...topology.nodes[2]!,
      outputs: [
        ...topology.nodes[2]!.outputs!,
        { path: "generated-tests.json", contract: "ultrafuzz/generated-tests@3", primary: false }
      ]
    };
    topology.nodes.splice(3, 0, {
      id: "findings-only-strategy",
      prompt: "strategies/findings-only.md",
      group: "strategies",
      depends_on: ["setup"],
      outputs: [{ path: "findings.json", contract: "ultrafuzz/findings@2", primary: true }]
    });
    topology.nodes[4] = {
      ...topology.nodes[4]!,
      depends_on: ["strategy", "findings-only-strategy"]
    };
    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/review.md": "Read {{ancestor_contract_artifact_authority:ultrafuzz/generated-tests@3}}."
        }
      })
    ).not.toThrow();

    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: {
          "review/review.md": "Read {{ancestor_contract_artifact_authority:ultrafuzz/generated-tests@3}}."
        }
      })
    ).not.toThrow();

    const rootConsumer = validTopology();
    rootConsumer.nodes.splice(1, 0, {
      id: "orphan-review",
      prompt: "review/orphan-review.md",
      group: "review",
      depends_on: ["__start__"],
      outputs: [{ path: "orphan.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true }]
    });
    const finish = rootConsumer.nodes.find((node) => node.id === "__finish__")!;
    finish.depends_on = [...finish.depends_on, "orphan-review"];
    expect(() =>
      validateTopology(rootConsumer, {
        promptTexts: {
          "review/orphan-review.md": "Read {{ancestor_contract_artifact_authority:ultrafuzz/generated-tests@3}}."
        }
      })
    ).not.toThrow();
  });

  it("accepts compact exact-path authority and rejects unsafe paths", () => {
    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: {
          "review/review.md":
            "Read {{ancestor_artifact_path_authority:findings.json,setup/project-discovery.md,optional.json}}."
        }
      })
    ).not.toThrow();

    expect(() =>
      validateTopology(validTopology(), {
        promptTexts: { "review/review.md": "Read {{ancestor_artifact_path_authority:../secret}}." }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PROMPT_ARTIFACT_REFERENCE" }));
  });

  it("rejects legacy ancestor collections with migration diagnostics", () => {
    for (const variable of [
      "ancestor_artifacts",
      "ancestor_artifacts:strategy",
      "ancestor_artifacts_by_path:findings.json",
      "ancestor_generated_test_manifests",
      "ancestor_generated_test_manifest_authorities"
    ]) {
      expect(() =>
        validateTopology(validTopology(), {
          promptTexts: { "review/review.md": `Read {{${variable}}}.` }
        })
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_PROMPT_ARTIFACT_REFERENCE",
          message: expect.stringContaining("is no longer supported; migrate to")
        })
      );
    }
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
      "ultrafuzz/report@3"
    ] as const) {
      topology.nodes[3] = {
        ...topology.nodes[3]!,
        outputs:
          contract === "ultrafuzz/findings@2" || contract === "ultrafuzz/report@3"
            ? [
                { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true },
                { path: contract === "ultrafuzz/report@3" ? "report.json" : "findings.json", contract }
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
      "Verification: run forge test.",
      "Resolution: use checks-effects-interactions.",
      "Access: only invoke public entrypoints.",
      "## Verification: run forge test",
      "### Access: only invoke public entrypoints",
      "Set access to public before testing.",
      "Use verification as evidence when classifying findings.",
      "Write verification as a concise testing summary.",
      "Require access to the source tree before triage.",
      "Set access controls to public before testing.",
      "Write verification steps before summarizing the report.",
      "Record classification vectors as evidence.",
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
    expect(() =>
      validateTopology(topology, {
        promptTexts: {
          "review/triage.md":
            "Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}. Record access: internal evidence on each finding."
        }
      })
    ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));
    for (const proseAlias of [
      "### Access: internal",
      "## Verification: summary ##",
      "<h3>Access: internal</h3>",
      "Access: internal\n---",
      "## Rating: critical",
      "Record access -> internal evidence on each finding.",
      "Record the reachability -> helper-only evidence on each finding.",
      "Record root_reason -> renamed evidence on each finding.",
      "Record severity_alias_v2 -> critical evidence on each finding.",
      "Record classification_v2 -> bug evidence on each finding.",
      "Record access_alias -> internal evidence on each finding.",
      "Record classification_v3 -> bug evidence on each finding.",
      "Record classificationAlias -> bug evidence on each finding.",
      "Record access_v2 -> internal evidence on each finding.",
      "Record accessAlias -> internal evidence on each finding.",
      "Record verification_v2 -> summary evidence on each finding.",
      "Record verificationAlias -> summary evidence on each finding.",
      "Record access | internal evidence on each finding.",
      "Record root_cause: renamed evidence on each finding.",
      "Record reachability -> helper-only evidence on each finding.",
      "Record verification ↦ summary evidence on each finding.",
      "Record root_cause ⟶ renamed evidence on each finding.",
      "Record access ≔ internal evidence on each finding."
    ]) {
      expect(
        () =>
          validateTopology(topology, {
            promptTexts: {
              "review/triage.md": `Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}.\n${proseAlias}`
            }
          }),
        proseAlias
      ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));
    }
    for (const wordMapping of [
      "Set access to internal on every finding.",
      "Write verification as summary on every finding.",
      "Record verification maps to summary on every finding.",
      "Set rating to critical on every finding.",
      "Record classification_v2 equals bug on every finding.",
      "Record classification_v3 equal to bug on every finding."
    ]) {
      expect(
        () =>
          validateTopology(topology, {
            promptTexts: {
              "review/triage.md": `Use {{finding_reachability_vocabulary}} and {{finding_note_key_vocabulary}}. ${wordMapping}`
            }
          }),
        wordMapping
      ).toThrow(expect.objectContaining({ code: "DUPLICATED_REPORT_VOCABULARY" }));
    }
    for (const proseAlias of [
      "Record Verification: summary evidence on each finding.",
      "Record Resolution: fixed evidence on each finding.",
      "Record Access: internal evidence on each finding."
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
});
