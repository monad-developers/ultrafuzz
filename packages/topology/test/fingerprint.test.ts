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
        configFingerprint: { agent_profile: "codex-default" },
        promptTexts: { "strategies/strategy.md": "original" }
      })
    );

    const changedTopology = validTopology({ defaults: { strategy_loops: 3 } });
    expect(fingerprintGraph(expandTopology(changedTopology))).not.toBe(base);

    expect(
      fingerprintGraph(
        expandTopology(validTopology(), {
          configFingerprint: { agent_profile: "codex-default" },
          promptTexts: { "strategies/strategy.md": "changed" }
        })
      )
    ).not.toBe(base);

    expect(
      fingerprintGraph(
        expandTopology(validTopology(), {
          configFingerprint: { agent_profile: "claude-default" },
          promptTexts: { "strategies/strategy.md": "original" }
        })
      )
    ).not.toBe(base);
  });
});
