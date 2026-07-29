import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { topologyWithStrategyLoops } from "../src/topology-config.js";

describe("Modal benchmark topology loop configuration", () => {
  it("applies configured loops to strategy defaults without rewriting explicit node loops", () => {
    const updated = topologyWithStrategyLoops(
      `version: 2
defaults:
  strategy_loops: 1
groups:
  strategies:
    defaults:
      loops: 1
      timeout_seconds: 7200
nodes:
  - id: boundary-tests
    group: strategies
    depends_on: []
  - id: differential-library-tests
    group: strategies
    loops: 1
    depends_on: []
`,
      3
    );
    const parsed = YAML.parse(updated) as {
      defaults: { strategy_loops: number };
      groups: { strategies: { defaults: { loops: number } } };
      nodes: Array<{ loops?: number }>;
    };
    expect(parsed.defaults.strategy_loops).toBe(3);
    expect(parsed.groups.strategies.defaults.loops).toBe(3);
    expect(parsed.nodes[1]!.loops).toBe(1);
  });
});
