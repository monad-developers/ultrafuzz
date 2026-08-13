import { describe, expect, it } from "vitest";

import { expandTopology, fingerprintGraph } from "../src/index.js";
import { validTopology } from "./helpers.js";

describe("fingerprintGraph", () => {
  it("is deterministic and run-ID independent", () => {
    const left = fingerprintGraph(expandTopology(validTopology(), { runId: "run-a" }));
    const right = fingerprintGraph(expandTopology(validTopology(), { runId: "run-b" }));
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes for topology, prompt, and config edits", () => {
    const base = fingerprintGraph(
      expandTopology(validTopology(), {
        configFingerprint: "a".repeat(64),
        promptTexts: {
          "strategies/strategy.md":
            "Write original findings to {{output_findings_path}} {{finding_reachability_vocabulary}} {{finding_note_key_vocabulary}}"
        }
      })
    );

    const changedTopology = validTopology({ defaults: { strategy_loops: 3 } });
    expect(fingerprintGraph(expandTopology(changedTopology))).not.toBe(base);

    expect(
      fingerprintGraph(
        expandTopology(validTopology(), {
          configFingerprint: "a".repeat(64),
          promptTexts: {
            "strategies/strategy.md":
              "Write changed findings to {{output_findings_path}} {{finding_reachability_vocabulary}} {{finding_note_key_vocabulary}}"
          }
        })
      )
    ).not.toBe(base);

    expect(
      fingerprintGraph(
        expandTopology(validTopology(), {
          configFingerprint: "b".repeat(64),
          promptTexts: {
            "strategies/strategy.md":
              "Write original findings to {{output_findings_path}} {{finding_reachability_vocabulary}} {{finding_note_key_vocabulary}}"
          }
        })
      )
    ).not.toBe(base);
  });

  it("changes when a node's required commands change", () => {
    const topology = validTopology();
    const base = fingerprintGraph(expandTopology(topology));
    topology.nodes[2] = { ...topology.nodes[2]!, required_commands: ["recon"] };

    expect(fingerprintGraph(expandTopology(topology))).not.toBe(base);
  });
});
