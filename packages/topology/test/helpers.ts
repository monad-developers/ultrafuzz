import type { ProjectTopology } from "../src/index.js";

export function validTopology(overrides: Partial<ProjectTopology> = {}): ProjectTopology {
  return {
    version: 1,
    defaults: { strategy_loops: 2 },
    groups: {
      setup: { label: "Setup", color: "#2563eb" },
      strategies: { label: "Strategies", color: "#7c3aed" },
      review: { label: "Review", color: "#0f766e" }
    },
    nodes: [
      { id: "__start__", kind: "meta", role: "start", depends_on: [] },
      {
        id: "setup",
        prompt: "setup/setup.md",
        group: "setup",
        depends_on: ["__start__"],
        required_artifacts: ["setup.md"],
        primary_artifact: "setup.md"
      },
      {
        id: "strategy",
        prompt: "strategies/strategy.md",
        group: "strategies",
        depends_on: ["setup"],
        required_artifacts: ["findings.json"],
        primary_artifact: "findings.json"
      },
      {
        id: "review",
        prompt: "review/review.md",
        group: "review",
        depends_on: ["strategy"],
        required_artifacts: ["report.md"],
        primary_artifact: "report.md"
      },
      { id: "__finish__", kind: "meta", role: "finish", depends_on: ["review"] }
    ],
    ...overrides
  };
}
