import type { ProjectTopology } from "../src/index.js";

export function validTopology(overrides: Partial<ProjectTopology> = {}): ProjectTopology {
  return {
    version: 2,
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
        outputs: [{ path: "setup.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true }]
      },
      {
        id: "strategy",
        prompt: "strategies/strategy.md",
        group: "strategies",
        depends_on: ["setup"],
        outputs: [{ path: "findings.json", contract: "ultrafuzz/findings@1", primary: true }]
      },
      {
        id: "review",
        prompt: "review/review.md",
        group: "review",
        depends_on: ["strategy"],
        outputs: [{ path: "report.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true }]
      },
      { id: "__finish__", kind: "meta", role: "finish", depends_on: ["review"] }
    ],
    ...overrides
  };
}
