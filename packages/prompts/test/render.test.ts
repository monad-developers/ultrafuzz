import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptError, renderPrompt, validatePromptVariables, writeRenderedPrompt } from "../src/index.js";

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function baseRenderInput(tmp: string) {
  const runArtifacts = path.join(tmp, "runs", "run-1", "artifacts");
  return {
    prompt:
      "Setup {{artifact_handoff:base-test-setup}}\nAll {{ancestor_artifacts:base-test-setup}}\nCurrent {{artifact_path}}/findings.json",
    graph: {
      logicalNodes: [
        {
          id: "project-discovery",
          outputs: [
            {
              path: "setup/project-discovery.md",
              contract: "ultrafuzz/nonempty-markdown@1",
              primary: true,
              description: "A non-empty Markdown document."
            }
          ],
          artifactDir: path.join(runArtifacts, "project-discovery")
        },
        {
          id: "base-test-setup",
          dependsOn: ["project-discovery"],
          outputs: [
            {
              path: "setup/base-test-setup.md",
              contract: "ultrafuzz/nonempty-markdown@1",
              primary: true,
              description: "A non-empty Markdown document."
            },
            {
              path: "references/expectations.json",
              contract: "ultrafuzz/reference-expectations@1",
              primary: false,
              description: "A typed benchmark expectation catalog."
            }
          ],
          artifactDir: path.join(runArtifacts, "base-test-setup")
        },
        {
          id: "boundary-tests",
          dependsOn: ["base-test-setup"],
          outputs: [
            {
              path: "findings.json",
              contract: "ultrafuzz/findings@1",
              primary: true,
              description: "A findings array with severity_guess.",
              validEmptyExample: "[]"
            },
            {
              path: "generated-tests.json",
              contract: "ultrafuzz/generated-tests@1",
              primary: false,
              description: "A manifest containing generated_tests.",
              validEmptyExample: '{"generated_tests":[]}'
            }
          ],
          artifactDir: path.join(runArtifacts, "boundary-tests")
        }
      ]
    },
    node: {
      logicalId: "boundary-tests",
      concreteId: "boundary-tests-0",
      artifactDir: path.join(runArtifacts, "boundary-tests-0"),
      workspacePath: path.join(tmp, "workspace"),
      repoPath: path.join(tmp, "repo"),
      attemptIndex: 0,
      loopIndex: 0,
      loopCount: 3
    },
    run: {
      id: "run-1",
      artifactsDir: runArtifacts,
      metadataPath: path.join(tmp, "runs", "run-1", "run.json")
    },
    outputs: {
      findingsPath: path.join(runArtifacts, "boundary-tests-0", "findings.json"),
      patchPath: path.join(runArtifacts, "boundary-tests-0", "patch.diff")
    }
  };
}

describe("prompt rendering", () => {
  it("rejects unknown variables before launch", () => {
    expect(() => validatePromptVariables("hello {{unknown_value}}")).toThrow(PromptError);
  });

  it("preserves escaped replacement placeholders as literals for downstream MDX prompts", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Emit \\{{class:liquidation:fixed-term-before-overdue}} exactly.";

    expect(() => validatePromptVariables(input.prompt)).not.toThrow();
    const result = renderPrompt(input);
    expect(result.renderedMarkdown).toContain("Emit {{class:liquidation:fixed-term-before-overdue}} exactly.");
    expect(result.variablesUsed).toEqual([]);
  });

  it("rejects unsafe artifact suffixes and render outputs", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    expect(() => validatePromptVariables("bad {{artifact_path}}/../secret")).toThrow(PromptError);
    expect(() => validatePromptVariables("bad {{artifact_path}}/C:\\secret")).toThrow(PromptError);

    const input = baseRenderInput(tmp);
    input.outputs.findingsPath = path.join(tmp, "escaped-findings.json");
    expect(() => renderPrompt(input)).toThrow(/inside/);
  });

  it("renders validated artifact handoffs and ancestor artifacts", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const result = renderPrompt(baseRenderInput(tmp));

    expect(result.renderedMarkdown).toContain(path.join("base-test-setup", "setup", "base-test-setup.md"));
    expect(result.renderedMarkdown).toContain(path.join("base-test-setup", "references", "expectations.json"));
    expect(result.renderedMarkdown).toContain(path.join("boundary-tests-0", "findings.json"));
    expect(result.renderedMarkdown).toContain("## Ultrafuzz Output Contract");
    expect(result.renderedMarkdown).toContain(path.join("boundary-tests-0", "generated-tests.json"));
    expect(result.renderedMarkdown).toContain("severity_guess");
    expect(result.renderedMarkdown).toContain("generated_tests");
    expect(result.renderedMarkdown).toContain("write each artifact to the exact absolute path");
    expect(result.renderedMarkdown).toContain("final response MUST contain ONLY one raw, valid JSON object");
    expect(result.renderedMarkdown).toContain('{"summary":"A concise description');
    expect(result.renderedMarkdown).toContain("Do NOT include Markdown fences");
  });

  it("does not ask agents to author runtime-owned workspace patch outputs", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.graph.logicalNodes[2]!.outputs = [
      ...(input.graph.logicalNodes[2]!.outputs ?? []),
      {
        path: "workspace.patch",
        contract: "ultrafuzz/text@1",
        primary: false,
        description: "Runtime-captured workspace patch."
      },
      {
        path: "workspace-patch.json",
        contract: "ultrafuzz/workspace-patch@1",
        primary: false,
        description: "Runtime-captured workspace patch manifest."
      }
    ];

    const result = renderPrompt(input);

    expect(result.renderedMarkdown).not.toContain("workspace.patch");
    expect(result.renderedMarkdown).not.toContain("workspace-patch.json");
    expect(result.renderedMarkdown).toContain("generated-tests.json");
  });

  it("renders the resolved invariant priority selection when supplied by the planner", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt =
      "Threshold: {{invariant_property_priority_threshold}}\nFilter: {{invariant_property_priority_filter}}\nPriorities: {{invariant_property_priorities}}";
    input.resolvedConfig = {
      invariantPropertyPriorityThreshold: "medium",
      invariantPropertyPriorityFilter: "properties with priority at or above `medium`",
      invariantPropertyPriorities: ["high", "medium"]
    };

    const result = renderPrompt(input);

    expect(result.renderedMarkdown).toContain("Threshold: medium");
    expect(result.renderedMarkdown).toContain("Filter: properties with priority at or above `medium`");
    expect(result.renderedMarkdown).toContain("Priorities: high, medium");
  });

  it("renders the configured invariant Recon smoke timeout", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Smoke timeout: {{invariant_testing_smoke_timeout}}";
    input.resolvedConfig = { invariantTestingSmokeTimeout: 600 };

    const result = renderPrompt(input);

    expect(result.renderedMarkdown).toContain("Smoke timeout: 600");
    expect(result.variablesUsed).toContain("invariant_testing_smoke_timeout");
  });

  it("renders the task-local schema bundle path", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Lens schema: {{schema_path}}/property-lens.schema.json";

    const result = renderPrompt(input);

    expect(result.renderedMarkdown).toContain(
      path.join(input.node.workspacePath, ".ultrafuzz", "schemas", "property-lens.schema.json")
    );
    expect(result.variablesUsed).toContain("schema_path");
  });

  it("returns model provenance for task metadata", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.node.agentRef = "CodexAgent";
    input.node.modelProfileId = "default";
    input.node.modelName = "gpt-test";
    input.node.modelIndex = 1;
    const result = renderPrompt(input);

    expect(result.metadata.modelProvenance).toEqual({
      agentRef: "CodexAgent",
      modelProfileId: "default",
      modelName: "gpt-test",
      modelIndex: 1,
      loopIndex: 0,
      attemptIndex: 0
    });
  });

  it("rejects non-ancestor handoffs", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.graph.logicalNodes.push({
      id: "unrelated",
      dependsOn: ["project-discovery"],
      outputs: [
        {
          path: "unrelated.txt",
          contract: "ultrafuzz/text@1",
          primary: true,
          description: "Text."
        }
      ],
      artifactDir: path.join(tmp, "runs", "run-1", "artifacts", "unrelated")
    });
    input.prompt = "{{artifact_handoff:unrelated}}";

    expect(() => renderPrompt(input)).toThrow(/not an ancestor/);
  });

  it("rejects missing primary artifacts for handoffs", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.graph.logicalNodes[1]!.outputs = input.graph.logicalNodes[1]!.outputs?.map((output) => ({
      ...output,
      primary: false
    }));

    expect(() => renderPrompt(input)).toThrow(/primary output/);
  });

  it("writes prompt.rendered.md before workflow launch", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const result = renderPrompt(baseRenderInput(tmp));
    const renderedPath = writeRenderedPrompt(result);

    expect(path.basename(renderedPath)).toBe("prompt.rendered.md");
    expect(readFileSync(renderedPath, "utf8")).toBe(result.renderedMarkdown);
  });
});
