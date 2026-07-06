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
          requiredArtifacts: ["setup/project-discovery.md"],
          primaryArtifact: "setup/project-discovery.md",
          artifactDir: path.join(runArtifacts, "project-discovery")
        },
        {
          id: "base-test-setup",
          dependsOn: ["project-discovery"],
          requiredArtifacts: ["setup/base-test-setup.md"],
          primaryArtifact: "setup/base-test-setup.md",
          artifactDir: path.join(runArtifacts, "base-test-setup")
        },
        {
          id: "boundary-tests",
          dependsOn: ["base-test-setup"],
          requiredArtifacts: ["findings.json", "generated-tests.json"],
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
    expect(result.renderedMarkdown).toContain(path.join("boundary-tests-0", "findings.json"));
    expect(result.renderedMarkdown).toContain("## Ultrafuzz Output Contract");
    expect(result.renderedMarkdown).toContain(path.join("boundary-tests-0", "generated-tests.json"));
    expect(result.renderedMarkdown).toContain("severity_guess");
    expect(result.renderedMarkdown).toContain("generated_tests");
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
      requiredArtifacts: ["unrelated.txt"],
      primaryArtifact: "unrelated.txt",
      artifactDir: path.join(tmp, "runs", "run-1", "artifacts", "unrelated")
    });
    input.prompt = "{{artifact_handoff:unrelated}}";

    expect(() => renderPrompt(input)).toThrow(/not an ancestor/);
  });

  it("rejects missing primary artifacts for handoffs", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    delete input.graph.logicalNodes[1]!.primaryArtifact;

    expect(() => renderPrompt(input)).toThrow(/primary_artifact/);
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
