import { describe, expect, it } from "vitest";
import { diffPromptIdentity, renamePromptId } from "../src/index.js";

describe("prompt ID rename sync", () => {
  it("synchronizes topology ids, dependencies, prompt files, artifact refs, and concrete ids", () => {
    const result = renamePromptId({
      oldId: "boundary-tests",
      newId: "edge-tests",
      topology: {
        version: 1,
        nodes: [
          {
            id: "boundary-tests",
            prompt: "strategies/boundary-tests.mdx",
            depends_on: ["base-test-setup"],
            outputs: [
              {
                path: "boundary-tests/generated-tests.json",
                contract: "ultrafuzz/generated-tests@3",
                primary: true
              }
            ]
          },
          {
            id: "dedupe-findings",
            prompt: "review/dedupe-findings.mdx",
            depends_on: ["boundary-tests"]
          }
        ]
      },
      promptFiles: [
        {
          path: "strategies/boundary-tests.mdx",
          contents:
            "---\nid: boundary-tests\ndisplay_name: Boundary Tests\n---\nRead {{artifact_handoff:base-test-setup}} and {{artifact_path:boundary-tests}}/boundary-tests.json"
        },
        {
          path: "review/dedupe-findings.mdx",
          contents:
            "---\nid: dedupe-findings\n---\nUse {{ancestor_artifacts:boundary-tests}} and {{artifact_path:boundary-tests}}/generated-tests.json"
        }
      ],
      concreteNodes: [
        {
          id: "boundary-tests-0",
          logicalId: "boundary-tests",
          artifactDir: "/runs/run-1/artifacts/boundary-tests-0"
        },
        {
          id: "dedupe-findings",
          logicalId: "dedupe-findings",
          dependsOn: ["boundary-tests-0"]
        }
      ]
    });

    expect(result.topology.nodes[0]?.id).toBe("edge-tests");
    expect(result.topology.nodes[0]?.prompt).toBe("strategies/edge-tests.mdx");
    expect(result.topology.nodes[0]?.outputs?.map((output) => output.path)).toEqual([
      "edge-tests/generated-tests.json"
    ]);
    expect(result.topology.nodes[1]?.depends_on).toEqual(["edge-tests"]);
    expect(result.promptFiles[0]?.path).toBe("strategies/edge-tests.mdx");
    expect(result.promptFiles[0]?.contents).toContain("id: edge-tests");
    expect(result.promptFiles[0]?.contents).toContain("{{artifact_path:edge-tests}}/edge-tests.json");
    expect(result.promptFiles[1]?.contents).toContain("{{ancestor_artifacts:edge-tests}}");
    expect(result.concreteIdMap).toEqual({ "boundary-tests-0": "edge-tests-0" });
    expect(result.concreteNodes[0]?.artifactDir).toBe("/runs/run-1/artifacts/edge-tests-0");
    expect(result.concreteNodes[1]?.dependsOn).toEqual(["edge-tests-0"]);
  });

  it("rejects frontmatter rename conflicts", () => {
    expect(() =>
      renamePromptId({
        oldId: "boundary-tests",
        newId: "edge-tests",
        topology: {
          version: 1,
          nodes: [{ id: "boundary-tests", prompt: "strategies/boundary-tests.md" }]
        },
        promptFiles: [
          { path: "strategies/boundary-tests.md", contents: "---\nid: boundary-tests\n---\nBody" },
          { path: "strategies/edge-tests.md", contents: "---\nid: edge-tests\n---\nBody" }
        ]
      })
    ).toThrow(/already contains id/);
  });

  it("does not change execution identity for display_name-only edits", () => {
    const before = "---\nid: boundary-tests\ndisplay_name: Boundary Tests\n---\nBody";
    const after = "---\nid: boundary-tests\ndisplay_name: Edge Boundary Tests\n---\nBody";

    expect(diffPromptIdentity(before, after).displayNameOnly).toBe(true);
  });
});
