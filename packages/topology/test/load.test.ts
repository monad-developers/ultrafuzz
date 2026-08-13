import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadTopology, TopologyError } from "../src/index.js";

describe("loadTopology", () => {
  it("fails closed for missing topology", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ufz-topology-"));
    try {
      expect(() => loadTopology(dir)).toThrowError(TopologyError);
      expect(() => loadTopology(dir)).toThrow(expect.objectContaining({ code: "MISSING_TOPOLOGY" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for corrupt YAML", () => {
    const dir = mkProject();
    writeFileSync(path.join(dir, ".ultrafuzz", "topology.yml"), "version: [\n");
    try {
      expect(() => loadTopology(dir)).toThrow(expect.objectContaining({ code: "TOPOLOGY_PARSE" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not classify a dangling topology symlink as missing", () => {
    const dir = mkProject();
    symlinkSync(path.join(dir, "missing-topology.yml"), path.join(dir, ".ultrafuzz", "topology.yml"));
    try {
      expect(() => loadTopology(dir)).toThrow(expect.objectContaining({ code: "SYMLINK_PATH" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for unsupported topology versions", () => {
    const dir = mkProject();
    writeFileSync(
      path.join(dir, ".ultrafuzz", "topology.yml"),
      "version: 1\ndefaults:\n  strategy_loops: 1\nnodes: []\n"
    );
    try {
      expect(() => loadTopology(dir)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_TOPOLOGY_VERSION" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads canonical .ultrafuzz/topology.yml", () => {
    const dir = mkProject();
    writeFileSync(
      path.join(dir, ".ultrafuzz", "topology.yml"),
      "version: 2\ndefaults:\n  strategy_loops: 1\nnodes:\n  - id: __start__\n    kind: meta\n    role: start\n    depends_on: []\n  - id: project-discovery\n    kind: agentic\n    prompt: setup/project-discovery.md\n    depends_on:\n      - __start__\n    outputs:\n      - path: report.md\n        contract: ultrafuzz/nonempty-markdown@1\n        primary: true\n  - id: __finish__\n    kind: meta\n    role: finish\n    depends_on:\n      - project-discovery\n"
    );
    try {
      expect(loadTopology(dir).nodes.map((node) => node.id)).toEqual(["__start__", "project-discovery", "__finish__"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mkProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ufz-topology-"));
  mkdirSync(path.join(dir, ".ultrafuzz"), { recursive: true });
  return dir;
}
