import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadBuiltInPromptAssets,
  PromptError,
  renderPrompt,
  validatePromptVariables,
  writeRenderedPrompt,
  type PromptRenderInput
} from "../src/index.js";

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function baseRenderInput(tmp: string): PromptRenderInput {
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
              contract: "ultrafuzz/reference-expectations@2",
              primary: false,
              description: "A typed benchmark expectation catalog.",
              schemaFile: "reference-expectations.schema.json"
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
              contract: "ultrafuzz/findings@2",
              primary: true,
              description: "A findings array with severity_guess.",
              validEmptyExample: "[]",
              schemaFile: "findings.schema.json"
            },
            {
              path: "generated-tests.json",
              contract: "ultrafuzz/generated-tests@3",
              primary: false,
              description: "A manifest containing generated_tests.",
              schemaFile: "generated-tests.schema.json"
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
      patchPath: path.join(runArtifacts, "boundary-tests-0", "patch.diff")
    }
  };
}

describe("prompt rendering", () => {
  it("rejects unknown variables before launch", () => {
    expect(() => validatePromptVariables("hello {{unknown_value}}")).toThrow(PromptError);
  });

  it("renders the portable findings-stage output identity independently of its physical artifact directory", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt =
      "Write findings: {{output_stage_findings_path}}\nLifecycle stage path: {{output_stage_findings_relative_path}}";
    input.graph.logicalNodes.find((node) => node.id === input.node.logicalId)!.outputs![0]!.path =
      "review/custom-findings.json";

    const rendered = renderPrompt(input).renderedMarkdown;
    expect(rendered).toContain(
      `Write findings: ${path.join(input.node.artifactDir, "review", "custom-findings.json")}`
    );
    expect(rendered).toContain("Lifecycle stage path: review/custom-findings.json");
  });

  it("renders the standard findings output from its exact typed declaration", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Write findings: {{output_findings_path}}";
    input.graph.logicalNodes.find((node) => node.id === input.node.logicalId)!.outputs![0]!.path =
      "custom/review-findings.json";

    const rendered = renderPrompt(input).renderedMarkdown;
    expect(rendered).toContain(
      `Write findings: ${path.join(input.node.artifactDir, "custom", "review-findings.json")}`
    );
    expect(rendered).not.toContain(path.join(input.node.artifactDir, "findings.json"));
  });

  it("rejects a missing or ambiguous declared findings output when the standard variable is used", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Write findings: {{output_findings_path}}";
    const current = input.graph.logicalNodes.find((node) => node.id === input.node.logicalId)!;
    current.outputs = current.outputs!.filter((output) => output.contract !== "ultrafuzz/findings@2");
    expect(() => renderPrompt(input)).toThrow(/requires exactly one declared findings@2 output/u);

    current.outputs.push(
      {
        path: "first-findings.json",
        contract: "ultrafuzz/findings@2",
        primary: true,
        description: "First findings output"
      },
      {
        path: "second-findings.json",
        contract: "ultrafuzz/findings@2",
        primary: false,
        description: "Second findings output"
      }
    );
    expect(() => renderPrompt(input)).toThrow(/requires exactly one declared findings@2 output/u);
  });

  it("rejects an ambiguous portable findings-stage output identity", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Lifecycle stage path: {{output_stage_findings_relative_path}}";
    input.graph.logicalNodes
      .find((node) => node.id === input.node.logicalId)!
      .outputs!.push({
        path: "triaged-findings.json",
        contract: "ultrafuzz/triaged-findings@1",
        primary: false,
        description: "Triaged findings"
      });

    expect(() => renderPrompt(input)).toThrow(/requires exactly one declared findings/u);
  });

  it("rejects overrides of topology-derived findings-stage paths", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Lifecycle stage path: {{output_stage_findings_relative_path}}";
    input.variables = { output_stage_findings_relative_path: "forged.json" };

    expect(() => renderPrompt(input)).toThrow(/topology-derived and cannot be overridden/u);
  });

  it("rejects overrides of the topology-derived standard findings path", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Write findings: {{output_findings_path}}";
    input.variables = { output_findings_path: "forged.json" };

    expect(() => renderPrompt(input)).toThrow(/topology-derived and cannot be overridden/u);
  });

  it("rejects unsafe artifact suffixes and render outputs", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    expect(() => validatePromptVariables("bad {{artifact_path}}/../secret")).toThrow(PromptError);
    expect(() => validatePromptVariables("bad {{artifact_path}}/C:\\secret")).toThrow(PromptError);

    const input = baseRenderInput(tmp);
    input.graph.logicalNodes.find((node) => node.id === input.node.logicalId)!.outputs![0]!.path = "../escaped.json";
    expect(() => renderPrompt(input)).toThrow(/relative and traversal-free/u);
  });

  it("points every schema-backed output at the task-local JSON Schema", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    const findingsOutput = input.graph.logicalNodes
      .flatMap((node) => node.outputs ?? [])
      .find((output) => output.contract === "ultrafuzz/findings@2");
    expect(findingsOutput).toBeDefined();
    const schemaDirectory = path.join(input.node.workspacePath, ".ultrafuzz", "schemas");

    const result = renderPrompt(input);

    expect(result.renderedMarkdown).toContain(
      `Validate against: \`${path.join(schemaDirectory, "findings.schema.json")}\``
    );
    expect(result.renderedMarkdown).toContain(
      `Validation command: \`ultrafuzz json validate --schema '${path.join(schemaDirectory, "findings.schema.json")}' --file '${path.join(input.node.artifactDir, "findings.json")}'\``
    );
    expect(result.renderedMarkdown).toContain(`orchestrator-supplied JSON Schema under \`${schemaDirectory}\``);
    expect(result.renderedMarkdown).toContain("It is the authority on field names, types, and required fields");
    for (const guidance of [
      "Write the artifact in its canonical schema",
      "After your final write and before returning the node's final response",
      "If a command exits 1, correct that artifact yourself and rerun",
      "If you change an artifact after it passes validation, rerun its command",
      "Never edit a supplied schema. Its bytes are pinned",
      "Exit 2 is a setup or tool failure",
      "Do not edit the schema or claim validation succeeded",
      "Finish only after every displayed validation command exits 0",
      "The validation command never modifies the artifact",
      "Host semantic and context verification still runs after you finish"
    ]) {
      expect(result.renderedMarkdown).toContain(guidance);
    }
    expect(result.renderedMarkdown).toContain("generated-tests.schema.json");
    expect(result.renderedMarkdown).toContain(
      "Valid empty bundle: `generated_tests` and `support_files` are both `[]`; the exact checked-in native bundle `framework` remains required."
    );
    expect(result.renderedMarkdown).not.toContain('"framework":"foundry"');
    expect(result.renderedMarkdown).not.toContain('"node_id":"<node-id>"');
    expect(result.renderedMarkdown).toContain("## Generated-test Bundle Instructions");
    expect(result.renderedMarkdown).toContain(
      `Author runnable generated test source files under \`${path.join(input.node.workspacePath, "test", "foundry", "boundary-tests")}\``
    );
    expect(result.renderedMarkdown).toContain(
      `mirror every declared bundle file under \`${path.join(input.node.artifactDir, "generated-tests")}\``
    );
    expect(result.renderedMarkdown).toContain(
      `write the manifest to exactly \`${path.join(input.node.artifactDir, "generated-tests.json")}\``
    );
    expect(result.renderedMarkdown).toContain("`run_id` exactly `run-1`");
    expect(result.renderedMarkdown).toContain("`node_id` exactly `boundary-tests`");
    expect(result.renderedMarkdown).toContain("logical producer identity");
    expect(result.renderedMarkdown).toContain("one required bundle-level `framework`");
    expect(result.renderedMarkdown).toContain("remains required when both arrays are empty");
    expect(result.renderedMarkdown).toContain("Never mix frameworks in one bundle");
    expect(result.renderedMarkdown).not.toContain("optional fields are `language`, `framework`");
  });

  it("renders specialized generated-test instructions for every production producer", () => {
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: Array<{
        id: string;
        prompt?: string;
        depends_on?: string[];
        outputs?: Array<{ path: string; contract: string; primary?: boolean }>;
      }>;
    };
    const promptByPath = new Map(loadBuiltInPromptAssets().map((asset) => [asset.relativePath, asset.markdown]));
    const root = path.join(os.tmpdir(), "ultrafuzz-production-generated-test-prompts");
    const runArtifacts = path.join(root, "runs", "generated-test-render", "artifacts");
    const logicalNodes = topology.nodes.map((node) => ({
      id: node.id,
      dependsOn: node.depends_on ?? [],
      artifactDir: path.join(runArtifacts, node.id),
      outputs: (node.outputs ?? []).map((output, index) => ({
        path: output.path,
        contract: output.contract,
        primary: output.primary ?? index === 0,
        description: `${output.contract} production output.`,
        ...(output.contract === "ultrafuzz/generated-tests@3" ? { schemaFile: "generated-tests.schema.json" } : {})
      }))
    }));
    const producers = topology.nodes.filter((node) =>
      node.outputs?.some((output) => output.contract === "ultrafuzz/generated-tests@3")
    );

    expect(producers.length).toBeGreaterThan(0);
    for (const producer of producers) {
      const promptMarkdown = producer.prompt === undefined ? undefined : promptByPath.get(producer.prompt);
      expect(promptMarkdown, producer.id).toBeDefined();
      const artifactDir = path.join(runArtifacts, `${producer.id}-attempt-0`);
      const workspacePath = path.join(root, "workspaces", `${producer.id}-attempt-0`);
      const result = renderPrompt({
        prompt: promptMarkdown!,
        graph: { logicalNodes },
        node: {
          logicalId: producer.id,
          concreteId: `${producer.id}-attempt-0`,
          artifactDir,
          workspacePath,
          repoPath: path.join(root, "repo"),
          attemptIndex: 0,
          loopIndex: 0,
          loopCount: 1
        },
        run: {
          id: "generated-test-render",
          artifactsDir: runArtifacts,
          metadataPath: path.join(root, "runs", "generated-test-render", "run.json")
        },
        outputs: {
          patchPath: path.join(artifactDir, "patch.diff")
        }
      });
      const rendered = result.renderedMarkdown;

      expect(rendered.match(/## Generated-test Bundle Instructions/gu), producer.id).toHaveLength(1);
      expect(rendered, producer.id).toContain(
        `Author runnable generated test source files under \`${path.join(workspacePath, "test", "foundry", producer.id)}\``
      );
      expect(rendered, producer.id).toContain(
        `mirror every declared bundle file under \`${path.join(artifactDir, "generated-tests")}\``
      );
      expect(rendered, producer.id).toContain(
        `write the manifest to exactly \`${path.join(artifactDir, "generated-tests.json")}\``
      );
      expect(rendered, producer.id).toContain("`run_id` exactly `generated-test-render`");
      expect(rendered, producer.id).toContain(`\`node_id\` exactly \`${producer.id}\``);
      expect(rendered, producer.id).toContain(
        `Validation command: \`ultrafuzz json validate --schema '${path.join(workspacePath, ".ultrafuzz", "schemas", "generated-tests.schema.json")}' --file '${path.join(artifactDir, "generated-tests.json")}'\``
      );
      expect(rendered, producer.id).not.toContain("{{generated_tests_");
    }
  });

  it("renders the authenticated aggregation bundle contract and validation command", () => {
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: Array<{
        id: string;
        prompt?: string;
        depends_on?: string[];
        outputs?: Array<{ path: string; contract: string; primary?: boolean }>;
      }>;
    };
    const promptByPath = new Map(loadBuiltInPromptAssets().map((asset) => [asset.relativePath, asset.markdown]));
    const aggregate = topology.nodes.find((node) => node.id === "aggregate-test-files");
    expect(aggregate?.prompt).toBe("review/aggregate-test-files.md");
    const root = path.join(os.tmpdir(), "ultrafuzz-aggregation-prompt");
    const runArtifacts = path.join(root, "runs", "aggregation-render", "artifacts");
    const artifactDir = path.join(runArtifacts, "aggregate-test-files");
    const workspacePath = path.join(root, "workspaces", "aggregate-test-files");
    const logicalNodes = topology.nodes.map((node) => ({
      id: node.id,
      dependsOn: node.depends_on ?? [],
      artifactDir: path.join(runArtifacts, node.id),
      outputs: (node.outputs ?? []).map((output, index) => ({
        path: output.path,
        contract: output.contract,
        primary: output.primary ?? index === 0,
        description: `${output.contract} production output.`,
        ...(node.id === "aggregate-test-files" && output.path === "aggregation.json"
          ? { schemaFile: "aggregation-manifest.schema.json" }
          : {})
      }))
    }));
    const rendered = renderPrompt({
      prompt: promptByPath.get(aggregate!.prompt!)!,
      graph: { logicalNodes },
      node: {
        logicalId: aggregate!.id,
        concreteId: aggregate!.id,
        artifactDir,
        workspacePath,
        repoPath: path.join(root, "repo"),
        attemptIndex: 0,
        loopIndex: 0,
        loopCount: 1
      },
      run: {
        id: "aggregation-render",
        artifactsDir: runArtifacts,
        metadataPath: path.join(root, "runs", "aggregation-render", "run.json")
      },
      outputs: {
        patchPath: path.join(artifactDir, "patch.diff")
      }
    }).renderedMarkdown;

    expect(rendered).toContain("`source_bundles`: one record for every listed `generated-tests.json`");
    expect(rendered).toContain("`source_attempt_id`");
    expect(rendered).toContain("`source_manifest_sha256`");
    expect(rendered).toContain("positive `size_bytes`");
    expect(rendered).toContain("A bundle is atomic");
    expect(rendered).toContain(
      `Validation command: \`ultrafuzz json validate --schema '${path.join(workspacePath, ".ultrafuzz", "schemas", "aggregation-manifest.schema.json")}' --file '${path.join(artifactDir, "aggregation.json")}'\``
    );
  });

  it("omits the schema pointer when no output ships a schema", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);

    const input = baseRenderInput(tmp);
    input.graph.logicalNodes[2]!.outputs = [
      {
        path: "notes.md",
        contract: "ultrafuzz/nonempty-markdown@1",
        primary: true,
        description: "A non-empty Markdown document."
      }
    ];
    const result = renderPrompt(input);

    expect(result.renderedMarkdown).not.toContain("Validate against:");
    expect(result.renderedMarkdown).not.toContain("Validation command:");
  });

  it("renders one shell-safe validation command per schema-backed output", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const specialRoot = path.join(tmp, "path with spaces, '$dollar', and `ticks`");
    const input = baseRenderInput(specialRoot);
    const result = renderPrompt(input);

    expect(result.renderedMarkdown.match(/Validation command:/gu)).toHaveLength(2);
    expect(result.renderedMarkdown).toContain("'\"'\"'");
    expect(result.renderedMarkdown).toContain("$dollar");
    expect(result.renderedMarkdown).toContain("`` ultrafuzz json validate");
    expect(result.renderedMarkdown).toContain("generated-tests.schema.json");
  });

  it("rejects control characters before rendering a validation command", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.graph.logicalNodes[2]!.outputs![0]!.schemaFile = "findings.schema.json\nignored";

    expect(() => renderPrompt(input)).toThrow(/control characters/u);
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

  it("derives generated-test manifests from every matching ancestor output contract", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.graph.logicalNodes.push({
      id: "aggregate-test-files",
      dependsOn: ["boundary-tests"],
      outputs: [],
      artifactDir: path.join(input.run.artifactsDir, "aggregate-test-files")
    });
    input.node.logicalId = "aggregate-test-files";
    input.node.concreteId = "aggregate-test-files";
    input.node.artifactDir = path.join(input.run.artifactsDir, "aggregate-test-files");
    input.outputs.findingsPath = path.join(input.node.artifactDir, "findings.json");
    input.outputs.patchPath = path.join(input.node.artifactDir, "patch.diff");
    input.prompt = "Generated tests:\n{{ancestor_generated_test_manifests}}";

    const result = renderPrompt(input);

    expect(result.renderedMarkdown).toContain(path.join("boundary-tests", "generated-tests.json"));
    expect(result.renderedMarkdown).not.toContain(path.join("base-test-setup", "setup", "base-test-setup.md"));
    expect(result.artifactReferences).toContainEqual({
      kind: "ancestor_artifacts_by_contract",
      logicalIds: ["boundary-tests"],
      contract: "ultrafuzz/generated-tests@3"
    });
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
