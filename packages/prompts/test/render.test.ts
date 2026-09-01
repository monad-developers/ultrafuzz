import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { promptArtifactAuthorityPathSelectorId } from "@ultrafuzz/artifacts";
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
    prompt: "Setup {{artifact_handoff:base-test-setup}}\nCurrent {{artifact_path}}/findings.json",
    graph: {
      logicalNodes: [
        {
          id: "project-discovery",
          kind: "agentic",
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
          kind: "agentic",
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
          kind: "agentic",
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

interface TopologyOutput {
  path: string;
  contract: string;
  primary?: boolean;
}

interface TopologyNode {
  id: string;
  kind: string;
  prompt?: string;
  depends_on?: string[];
  outputs?: TopologyOutput[];
  dynamic?: unknown;
}

interface TopologyDocument {
  nodes: TopologyNode[];
}

const runtimeOwnedOutputPaths = new Set(["workspace.patch", "workspace-patch.json", "vulnerability-db-manifest.json"]);
const nonSchemaContracts = new Set(["ultrafuzz/nonempty-markdown@1", "ultrafuzz/text@1"]);

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function taskLocalArtifactAuthorityPath(input: PromptRenderInput): string {
  return path.join(input.node.workspacePath, ".ultrafuzz", "authorities", `${input.node.concreteId}.json`);
}

function expectTaskLocalArtifactAuthority(rendered: string, input: PromptRenderInput): void {
  const authorityPath = taskLocalArtifactAuthorityPath(input);
  const legacyTaskManifestPath = path.join(path.dirname(input.run.metadataPath), "smithers", "tasks.json");
  const legacyControlManifestPath = path.join(path.dirname(input.run.metadataPath), "controls", "tasks.json");

  expect(rendered).toContain(`Read the runtime-generated ancestor artifact authority JSON at \`${authorityPath}\``);
  expect(rendered).toContain(`Confirm its \`attempt_id\` is \`${input.node.concreteId}\``);
  expect(rendered).toContain("verifier-admitted ancestor producers");
  expect(rendered).toContain("`artifact_path_base`");
  expect(rendered).not.toContain(legacyTaskManifestPath);
  expect(rendered).not.toContain(legacyControlManifestPath);
  expect(rendered).not.toContain(".ultrafuzz-verification");
  expect(rendered).not.toContain("`dependencyArtifactDirs`");
  expect(rendered).not.toContain("`optionalDependencyArtifactDirs`");
  expect(rendered).not.toContain("`metadata.artifacts.outputs`");
  expect(rendered).not.toContain("- source node_id:");
  expect(rendered).not.toContain("source_manifest_relative_path:");
  expect(rendered).not.toContain("source_manifest_path:");
  expect(rendered).not.toMatch(/"producers"\s*:\s*\[/u);
}

describe("prompt rendering", () => {
  it("renders output-contract guidance from the packaged layout with no repository above it", async () => {
    // This branch copies the prompt tree to dist/assets/prompts. A sealed
    // execution snapshot places the package at modules/@ultrafuzz/prompts/dist,
    // where "../../../" reaches modules/ rather than a repository root, so the
    // repository fallback cannot rescue a resolver that looks anywhere else.
    // Together those two facts took a run down at WORKFLOW_RENDER_FAILED the
    // first time it re-rendered mid-run.
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-packaged-prompts-"));
    tmpDirs.push(tmp);
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const distRoot = path.join(tmp, "modules", "@ultrafuzz", "prompts", "dist");
    mkdirSync(path.dirname(distRoot), { recursive: true });
    cpSync(path.join(repoRoot, "packages", "prompts", "dist"), distRoot, { recursive: true });
    mkdirSync(path.join(tmp, "node_modules"), { recursive: true });
    symlinkSync(
      realpathSync(path.join(repoRoot, "node_modules", "yaml")),
      path.join(tmp, "node_modules", "yaml"),
      "dir"
    );
    expect(existsSync(path.resolve(distRoot, "../../../.ultrafuzz"))).toBe(false);

    const packaged = (await import(
      `${pathToFileURL(path.join(distRoot, "render.js")).href}?packaged-layout=${Date.now()}`
    )) as { renderPrompt: typeof renderPrompt };
    const input = baseRenderInput(tmp);
    input.prompt = `${input.prompt}\n{{coverage_evidence_markdown_projection}}`;

    const rendered = packaged.renderPrompt(input).renderedMarkdown;
    expect(rendered).toContain("For every output declared with `Contract: ultrafuzz/findings@2`");
  });

  it("renders output-contract guidance and prompt partials from an installed package layout", async () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-installed-prompts-"));
    tmpDirs.push(tmp);
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const appRoot = path.join(tmp, "app");
    const packageRoot = path.join(appRoot, "node_modules", "@ultrafuzz", "prompts");
    const distRoot = path.join(packageRoot, "dist");
    mkdirSync(packageRoot, { recursive: true });
    execFileSync(
      "pnpm",
      [
        "exec",
        "tsc",
        "-p",
        path.join(repoRoot, "packages", "prompts", "tsconfig.json"),
        "--outDir",
        distRoot,
        "--tsBuildInfoFile",
        path.join(distRoot, ".tsbuildinfo")
      ],
      { cwd: repoRoot, stdio: "pipe" }
    );
    cpSync(path.join(repoRoot, ".ultrafuzz", "prompts"), path.join(distRoot, "prompts"), { recursive: true });
    copyFileSync(path.join(repoRoot, "packages", "prompts", "package.json"), path.join(packageRoot, "package.json"));
    mkdirSync(path.join(appRoot, "node_modules"), { recursive: true });
    symlinkSync(
      realpathSync(path.join(repoRoot, "node_modules", "yaml")),
      path.join(appRoot, "node_modules", "yaml"),
      "dir"
    );

    const installed = (await import(
      `${pathToFileURL(path.join(distRoot, "render.js")).href}?installed-layout=${Date.now()}`
    )) as { renderPrompt: typeof renderPrompt };
    const input = baseRenderInput(tmp);
    input.prompt = `${input.prompt}\n{{coverage_evidence_markdown_projection}}`;
    const rendered = installed.renderPrompt(input).renderedMarkdown;

    expect(rendered).toContain("For every output declared with `Contract: ultrafuzz/findings@2`");
    expect(rendered).toContain("Validation command: `ultrafuzz json validate --schema");
    expect(rendered).toContain("Contract validation command: `ultrafuzz artifact validate");
    expect(rendered).toContain("- <scope>: `<covered_ranges>/<total_ranges>`");
    expect(rendered).toContain("- Status: unavailable");
  });

  it("rejects unknown variables before launch", () => {
    expect(() => validatePromptVariables("hello {{unknown_value}}")).toThrow(PromptError);
  });

  it("renders the portable findings-stage output identity independently of its physical artifact directory", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Lifecycle stage path: {{output_stage_findings_relative_path}}";
    input.variables = { output_stage_findings_relative_path: "forged.json" };

    expect(() => renderPrompt(input)).toThrow(/topology-derived and cannot be overridden/u);
  });

  it("rejects overrides of the topology-derived standard findings path", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Write findings: {{output_findings_path}}";
    input.variables = { output_findings_path: "forged.json" };

    expect(() => renderPrompt(input)).toThrow(/topology-derived and cannot be overridden/u);
  });

  it("rejects unsafe artifact suffixes and render outputs", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    expect(() => validatePromptVariables("bad {{artifact_path}}/../secret")).toThrow(PromptError);
    expect(() => validatePromptVariables("bad {{artifact_path}}/C:\\secret")).toThrow(PromptError);

    const input = baseRenderInput(tmp);
    input.graph.logicalNodes.find((node) => node.id === input.node.logicalId)!.outputs![0]!.path = "../escaped.json";
    expect(() => renderPrompt(input)).toThrow(/relative and traversal-free/u);
  });

  it("points every schema-backed output at the task-local JSON Schema", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    expect(result.renderedMarkdown).toContain(
      `Contract validation command: \`ultrafuzz artifact validate 'ultrafuzz/findings@2' '${path.join(input.node.artifactDir, "findings.json")}'\``
    );
    expect(result.renderedMarkdown).toContain(
      `Task-context validation command: \`ultrafuzz artifact validate 'ultrafuzz/generated-tests@3' '${path.join(input.node.artifactDir, "generated-tests.json")}' --run-id 'run-1' --logical-node-id 'boundary-tests' --artifact-root '${input.node.artifactDir}'\``
    );
    expect(result.renderedMarkdown).toContain(`orchestrator-supplied JSON Schema under \`${schemaDirectory}\``);
    expect(result.renderedMarkdown).toContain("It is the sole authority on JSON versions");
    expect(result.renderedMarkdown).toContain("Prompt prose may add semantic or run-context requirements");
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
      "task-context command additionally checks the artifact",
      "Host semantic and context verification still runs after you finish"
    ]) {
      expect(result.renderedMarkdown).toContain(guidance);
    }
    expect(result.renderedMarkdown).toContain("generated-tests.schema.json");
    expect(result.renderedMarkdown).toContain("For every output declared with `Contract: ultrafuzz/findings@2`");
    expect(result.renderedMarkdown).toContain("later severity review owns final severity");
    expect(result.renderedMarkdown).toContain(
      "Schema-backed empty form: defined only by the pinned schema; inspect and validate it instead of copying a prose example."
    );
    expect(result.renderedMarkdown).not.toContain('"framework":"foundry"');
    expect(result.renderedMarkdown).not.toContain('"node_id":"<node-id>"');
    expect(result.renderedMarkdown).toContain("## Generated-test Bundle Instructions");
    expect(result.renderedMarkdown).toContain(
      `When you author executable evidence, keep runnable generated test or reproducer source under \`${path.join(input.node.workspacePath, "test", "foundry", "boundary-tests")}\``
    );
    expect(result.renderedMarkdown).toContain(
      `mirror every declared bundle file under \`${path.join(input.node.artifactDir, "generated-tests")}\``
    );
    expect(result.renderedMarkdown).toContain(
      `The manifest is always mandatory: write it to exactly \`${path.join(input.node.artifactDir, "generated-tests.json")}\``
    );
    expect(result.renderedMarkdown).toContain("`run_id` exactly to `run-1`");
    expect(result.renderedMarkdown).toContain("`node_id` exactly to `boundary-tests`");
    expect(result.renderedMarkdown).toContain("logical producer shown here");
    expect(result.renderedMarkdown).toContain("Bind the bundle framework to the one checked-in native framework");
    expect(result.renderedMarkdown).toContain("use the empty bundle defined by the schema");
    expect(result.renderedMarkdown).toContain("Never mix frameworks in one bundle");
    expect(result.renderedMarkdown).not.toContain("optional fields are `language`, `framework`");
    expect(result.renderedMarkdown).not.toContain("ultrafuzz.generated-tests.v3");
  });

  it("binds generated-test context checks to logical identity across concrete attempt shapes", () => {
    const cases = [
      { name: "static", logicalId: "boundary-tests", concreteId: "boundary-tests-storage" },
      { name: "looped", logicalId: "workflow-property-based-tests", concreteId: "workflow-property-based-tests-1" },
      {
        name: "model fanout",
        logicalId: "workflow-property-based-tests",
        concreteId: "workflow-property-based-tests__model_2__attempt_4"
      },
      { name: "runtime dynamic", logicalId: "class-goals", concreteId: "dynamic-class-goals-storage-7" }
    ];
    for (const fixture of cases) {
      const tmp = mkdtempSync(
        path.join(realpathSync(os.tmpdir()), `ufz-render-context-${fixture.name.replaceAll(" ", "-")}-`)
      );
      tmpDirs.push(tmp);
      const input = baseRenderInput(tmp);
      const current = input.graph.logicalNodes.find((node) => node.id === input.node.logicalId)!;
      current.id = fixture.logicalId;
      input.node.logicalId = fixture.logicalId;
      input.node.concreteId = fixture.concreteId;
      input.node.artifactDir = path.join(input.run.artifactsDir, fixture.concreteId);
      input.outputs.patchPath = path.join(input.node.artifactDir, "patch.diff");
      const rendered = renderPrompt(input).renderedMarkdown;
      const command = `Task-context validation command: \`ultrafuzz artifact validate 'ultrafuzz/generated-tests@3' '${path.join(input.node.artifactDir, "generated-tests.json")}' --run-id 'run-1' --logical-node-id '${fixture.logicalId}' --artifact-root '${input.node.artifactDir}'\``;

      expect(rendered, fixture.name).toContain(command);
      expect(rendered, fixture.name).toContain(`\`node_id\` exactly to \`${fixture.logicalId}\``);
    }
  });

  it("keeps findings guidance bound to a custom declared output path", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-custom-findings-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Write only the declared deduplicated findings output.";
    input.graph.logicalNodes.find((node) => node.id === input.node.logicalId)!.outputs![0]!.path =
      "deduped-findings.json";

    const rendered = renderPrompt(input).renderedMarkdown;

    expect(rendered).toContain("For every output declared with `Contract: ultrafuzz/findings@2`");
    expect(rendered).toContain("The declared path is authoritative");
    expect(rendered).toContain(path.join(input.node.artifactDir, "deduped-findings.json"));
    expect(rendered).not.toContain("For `findings.json`");
  });

  it("renders the pinned schema and exact validation commands for every agent-authored JSON output", () => {
    const topologyPaths = [
      fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url)),
      fileURLToPath(new URL("../../config/topologies/exhaustive.yml", import.meta.url)),
      fileURLToPath(new URL("../../config/topologies/invariant-only.yml", import.meta.url)),
      fileURLToPath(new URL("../../config/topologies/smoke.yml", import.meta.url))
    ];
    const fixturePath = fileURLToPath(
      new URL("../../artifacts/test/fixtures/contract-schema-fixtures.json", import.meta.url)
    );
    const schemaFixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, { schema_file: string }>;
    const promptByPath = new Map(loadBuiltInPromptAssets().map((asset) => [asset.relativePath, asset.markdown]));

    for (const topologyPath of topologyPaths) {
      const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as TopologyDocument;
      const topologyName = path.basename(topologyPath, ".yml");
      const root = path.join(realpathSync(os.tmpdir()), "ultrafuzz-schema-authority", topologyName);
      const runArtifacts = path.join(root, "runs", "schema-authority", "artifacts");
      const logicalNodes = topology.nodes.map((node) => ({
        id: node.id,
        kind: node.kind === "reference" ? ("reference" as const) : ("agentic" as const),
        dependsOn: node.depends_on ?? [],
        artifactDir: path.join(runArtifacts, node.id),
        outputs: (node.outputs ?? []).map((output, index) => {
          const schemaFile = schemaFixtures[output.contract]?.schema_file;
          return {
            path: output.path,
            contract: output.contract,
            primary: output.primary ?? index === 0,
            description: `${output.contract} topology output.`,
            ...(schemaFile === undefined ? {} : { schemaFile })
          };
        })
      }));

      for (const node of topology.nodes.filter((candidate) => candidate.kind === "agentic")) {
        const jsonOutputs = (node.outputs ?? []).filter(
          (output) => !runtimeOwnedOutputPaths.has(output.path) && !nonSchemaContracts.has(output.contract)
        );
        for (const output of jsonOutputs) {
          expect(
            schemaFixtures[output.contract]?.schema_file,
            `${topologyPath}:${node.id}:${output.path}`
          ).toBeDefined();
        }
        const schemaBackedOutputs = jsonOutputs.map((output) => ({
          ...output,
          schemaFile: schemaFixtures[output.contract]!.schema_file
        }));
        if (schemaBackedOutputs.length === 0) continue;

        expect(node.prompt, `${topologyPath}:${node.id}`).toBeDefined();
        const promptMarkdown = promptByPath.get(node.prompt!);
        expect(promptMarkdown, `${topologyPath}:${node.id}:${node.prompt}`).toBeDefined();
        const artifactDir = path.join(runArtifacts, `${node.id}-attempt-0`);
        const workspacePath = path.join(root, "workspaces", `${node.id}-attempt-0`);
        const rendered = renderPrompt({
          prompt: promptMarkdown!,
          ...(node.dynamic === undefined
            ? {}
            : {
                dynamicVariables: {
                  "item.goal_prompt": "Investigate the selected fixture goal.",
                  "item.node_id": `dynamic:${node.id}:fixture`
                }
              }),
          graph: { logicalNodes },
          node: {
            logicalId: node.id,
            concreteId: `${node.id}-attempt-0`,
            artifactDir,
            workspacePath,
            repoPath: path.join(root, "repo"),
            attemptIndex: 0,
            loopIndex: 0,
            loopCount: 1
          },
          run: {
            id: "schema-authority",
            artifactsDir: runArtifacts,
            metadataPath: path.join(root, "runs", "schema-authority", "run.json")
          },
          outputs: { patchPath: path.join(artifactDir, "workspace.patch") }
        }).renderedMarkdown;

        expect(occurrences(rendered, "Validate against:"), `${topologyPath}:${node.id}`).toBe(
          schemaBackedOutputs.length
        );
        expect(occurrences(rendered, "Validation command:"), `${topologyPath}:${node.id}`).toBe(
          schemaBackedOutputs.length
        );
        expect(occurrences(rendered, "Contract validation command:"), `${topologyPath}:${node.id}`).toBe(
          schemaBackedOutputs.length
        );
        for (const output of schemaBackedOutputs) {
          const schemaPath = path.join(workspacePath, ".ultrafuzz", "schemas", output.schemaFile);
          const outputPath = path.join(artifactDir, output.path);
          expect(rendered, `${topologyPath}:${node.id}:${output.path}`).toContain(
            `Validate against: \`${schemaPath}\``
          );
          expect(rendered, `${topologyPath}:${node.id}:${output.path}`).toContain(
            `Validation command: \`ultrafuzz json validate --schema '${schemaPath}' --file '${outputPath}'\``
          );
          expect(rendered, `${topologyPath}:${node.id}:${output.path}`).toContain(
            `Contract validation command: \`ultrafuzz artifact validate '${output.contract}' '${outputPath}'\``
          );
        }
      }
    }
  });

  it("renders smoke final review with bounded classification semantics and context", () => {
    const topologyPath = fileURLToPath(new URL("../../config/topologies/smoke.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as TopologyDocument;
    const report = topology.nodes.find((node) => node.id === "final-report");
    expect(report?.prompt).toBe("review/final-report.md");
    expect(report?.depends_on).toContain("smoke-context");

    const promptMarkdown = loadBuiltInPromptAssets().find((asset) => asset.relativePath === report!.prompt)?.markdown;
    expect(promptMarkdown).toBeDefined();
    const root = path.join(realpathSync(os.tmpdir()), "ultrafuzz-smoke-final-report");
    const runArtifacts = path.join(root, "runs", "smoke-render", "artifacts");
    const artifactDir = path.join(runArtifacts, "final-report");
    const workspacePath = path.join(root, "workspaces", "final-report");
    const logicalNodes = topology.nodes.map((node) => ({
      id: node.id,
      kind: node.kind === "reference" ? ("reference" as const) : ("agentic" as const),
      dependsOn: node.depends_on ?? [],
      artifactDir: path.join(runArtifacts, node.id),
      outputs: (node.outputs ?? []).map((output, index) => ({
        path: output.path,
        contract: output.contract,
        primary: output.primary ?? index === 0,
        description: `${output.contract} smoke output.`,
        ...(output.contract === "ultrafuzz/report@3" ? { schemaFile: "report.schema.json" } : {})
      }))
    }));

    const input: PromptRenderInput = {
      prompt: promptMarkdown!,
      graph: { logicalNodes },
      node: {
        logicalId: report!.id,
        concreteId: report!.id,
        artifactDir,
        workspacePath,
        repoPath: path.join(root, "repo"),
        attemptIndex: 0,
        loopIndex: 0,
        loopCount: 1
      },
      run: {
        id: "smoke-render",
        artifactsDir: runArtifacts,
        metadataPath: path.join(root, "runs", "smoke-render", "run.json")
      },
      outputs: { patchPath: path.join(artifactDir, "workspace.patch") }
    };
    const rendered = renderPrompt(input).renderedMarkdown;

    expectTaskLocalArtifactAuthority(rendered, input);
    expect(
      occurrences(
        rendered,
        `Read the runtime-generated ancestor artifact authority JSON at \`${taskLocalArtifactAuthorityPath(input)}\``
      )
    ).toBe(2);
    expect(occurrences(rendered, `Confirm its \`attempt_id\` is \`${input.node.concreteId}\``)).toBe(2);
    const machineSelectorId = promptArtifactAuthorityPathSelectorId(
      [
        "aggregation.json",
        "severity-classified-findings.json",
        "deduped-findings.json",
        "strategy-detections.json",
        "finding-lifecycle-ledger.json",
        "properties.json",
        "implemented-properties.json",
        "recon-fuzzer-results.json",
        "campaign-summary.json",
        "coverage-evidence.json"
      ].sort()
    );
    const contextSelectorId = promptArtifactAuthorityPathSelectorId(
      ["setup/project-discovery.md", "setup/setup-foundry.md", "setup/base-test-setup.md", "smoke-context.md"].sort()
    );
    expect(rendered).toContain(`path entry whose \`id\` is \`${machineSelectorId}\``);
    expect(rendered).toContain(`path entry whose \`id\` is \`${contextSelectorId}\``);
    expect(rendered).not.toContain(path.join(runArtifacts, "smoke-context", "smoke-context.md"));
    expect(rendered).toContain("`deduped-findings.json`");
    expect(rendered).not.toContain(path.join(runArtifacts, "dedupe-findings", "deduped-findings.json"));
    expect(rendered).toContain("In bounded classification mode");
    expect(rendered).toContain("compute `severity` from the matrix");
    expect(rendered).toContain("Strict severity-handoff mode");
    expect(rendered).toMatch(/applies when\s+`severity-classified-findings\.json` is selected/u);
    expect(rendered).not.toContain("bounded-final-review");
    expect(rendered).not.toContain("workspace-patch.json");
  });

  it("renders boundary recipes from the pinned schema without a prose-owned JSON shape", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-boundary-recipes-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    const boundaryPrompt = loadBuiltInPromptAssets().find(
      (asset) => asset.relativePath === "strategies/boundary-tests.md"
    );
    expect(boundaryPrompt).toBeDefined();
    input.prompt = boundaryPrompt!.markdown;
    input.graph.logicalNodes.push({
      id: "property-specification-fanin",
      kind: "agentic",
      outputs: [
        {
          path: "properties.md",
          contract: "ultrafuzz/nonempty-markdown@1",
          primary: true,
          description: "A human-readable property catalog."
        }
      ],
      artifactDir: path.join(input.run.artifactsDir, "property-specification-fanin")
    });
    input.graph.logicalNodes[2]!.dependsOn = ["base-test-setup", "property-specification-fanin"];
    input.graph.logicalNodes[2]!.outputs!.push({
      path: "boundary-recipes.json",
      contract: "ultrafuzz/boundary-recipes@1",
      primary: false,
      description: "Source-backed boundary and negative test recipes.",
      validEmptyExample:
        '{"schema_version":"ultrafuzz.boundary-recipes.v1","recipes":[],"deferred_or_spec_gated":[],"coverage_priorities":[]}',
      schemaFile: "boundary-recipes.schema.json"
    });

    const result = renderPrompt(input);
    const schemaPath = path.join(input.node.workspacePath, ".ultrafuzz", "schemas", "boundary-recipes.schema.json");
    const artifactPath = path.join(input.node.artifactDir, "boundary-recipes.json");

    expect(result.renderedMarkdown).toContain(`\`${schemaPath}\``);
    expect(result.renderedMarkdown).toContain(`Validate against: \`${schemaPath}\``);
    expect(result.renderedMarkdown).toContain(
      `Validation command: \`ultrafuzz json validate --schema '${schemaPath}' --file '${artifactPath}'\``
    );
    expect(result.renderedMarkdown).toContain(
      "For every output declared with `Contract: ultrafuzz/boundary-recipes@1`"
    );
    expect(result.renderedMarkdown).not.toContain("ultrafuzz.boundary-recipes.v1");
    expect(result.renderedMarkdown).not.toContain("deferred_or_spec_gated");
    expect(result.renderedMarkdown).not.toContain("coverage_priorities");
  });

  it("does not invent a Markdown companion for a JSON-only boundary-recipe output", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-json-only-boundary-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Write only the declared structured boundary recipe artifact.";
    input.graph.logicalNodes.find((node) => node.id === input.node.logicalId)!.outputs = [
      {
        path: "custom/recipes.json",
        contract: "ultrafuzz/boundary-recipes@1",
        primary: true,
        description: "Source-backed boundary and negative test recipes.",
        schemaFile: "boundary-recipes.schema.json"
      }
    ];

    const rendered = renderPrompt(input).renderedMarkdown;

    expect(rendered).toContain("For every output declared with `Contract: ultrafuzz/boundary-recipes@1`");
    expect(rendered).toContain("When a human-readable boundary-recipe companion is declared");
    expect(rendered).toContain(path.join(input.node.artifactDir, "custom", "recipes.json"));
    expect(rendered).not.toContain("`boundary-recipes.md`");
  });

  it("renders specialized generated-test instructions for every production producer", () => {
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: Array<{
        id: string;
        kind?: string;
        prompt?: string;
        depends_on?: string[];
        outputs?: Array<{ path: string; contract: string; primary?: boolean }>;
        dynamic?: unknown;
      }>;
    };
    const promptByPath = new Map(loadBuiltInPromptAssets().map((asset) => [asset.relativePath, asset.markdown]));
    const root = path.join(realpathSync(os.tmpdir()), "ultrafuzz-production-generated-test-prompts");
    const runArtifacts = path.join(root, "runs", "generated-test-render", "artifacts");
    const logicalNodes = topology.nodes.map((node) => ({
      id: node.id,
      kind: node.kind === "reference" ? ("reference" as const) : ("agentic" as const),
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
        ...(producer.dynamic === undefined
          ? {}
          : {
              dynamicVariables: {
                "item.goal_prompt": "Investigate the selected fixture goal.",
                "item.node_id": `dynamic:${producer.id}:fixture`
              }
            }),
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
        `When you author executable evidence, keep runnable generated test or reproducer source under \`${path.join(workspacePath, "test", "foundry", producer.id)}\``
      );
      expect(rendered, producer.id).toContain(
        `mirror every declared bundle file under \`${path.join(artifactDir, "generated-tests")}\``
      );
      expect(rendered, producer.id).toContain(
        `The manifest is always mandatory: write it to exactly \`${path.join(artifactDir, "generated-tests.json")}\``
      );
      expect(rendered, producer.id).toContain("generated test, PoC, fuzz-test, and support files are optional");
      expect(rendered, producer.id).toContain("an empty bundle is valid evidence transport");
      expect(rendered, producer.id).toContain("`run_id` exactly to `generated-test-render`");
      expect(rendered, producer.id).toContain(`\`node_id\` exactly to \`${producer.id}\``);
      expect(rendered, producer.id).toContain(
        `Validation command: \`ultrafuzz json validate --schema '${path.join(workspacePath, ".ultrafuzz", "schemas", "generated-tests.schema.json")}' --file '${path.join(artifactDir, "generated-tests.json")}'\``
      );
      expect(rendered, producer.id).toContain(
        `Task-context validation command: \`ultrafuzz artifact validate 'ultrafuzz/generated-tests@3' '${path.join(artifactDir, "generated-tests.json")}' --run-id 'generated-test-render' --logical-node-id '${producer.id}' --artifact-root '${artifactDir}'\``
      );
      expect(rendered, producer.id).not.toContain("{{generated_tests_");
    }
  });

  it("renders the authenticated aggregation bundle contract and validation command", () => {
    const topologyPath = fileURLToPath(new URL("../../../.ultrafuzz/topology.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as {
      nodes: Array<{
        id: string;
        kind?: string;
        prompt?: string;
        depends_on?: string[];
        outputs?: Array<{ path: string; contract: string; primary?: boolean }>;
      }>;
    };
    const promptByPath = new Map(loadBuiltInPromptAssets().map((asset) => [asset.relativePath, asset.markdown]));
    const aggregate = topology.nodes.find((node) => node.id === "aggregate-test-files");
    expect(aggregate?.prompt).toBe("review/aggregate-test-files.md");
    const root = path.join(realpathSync(os.tmpdir()), "ultrafuzz-aggregation-prompt");
    const runArtifacts = path.join(root, "runs", "aggregation-render", "artifacts");
    const artifactDir = path.join(runArtifacts, "aggregate-test-files");
    const workspacePath = path.join(root, "workspaces", "aggregate-test-files");
    const logicalNodes = topology.nodes.map((node) => ({
      id: node.id,
      kind: node.kind === "reference" ? ("reference" as const) : ("agentic" as const),
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

    expect(rendered).toContain(
      `Validate against: \`${path.join(workspacePath, ".ultrafuzz", "schemas", "aggregation-manifest.schema.json")}\``
    );
    expect(rendered).toContain("Record one source-bundle row for every declared manifest");
    expect(rendered).toContain("Bind each row to the source manifest's logical node");
    // Survives end-to-end rendering, not just the on-disk prompt: the topology
    // supplies the authoritative source-node/manifest pair so an agent cannot
    // substitute an `attempt-<n>` destination segment for the source node id.
    expect(rendered).toContain("The sealed selector above is binding");
    expect(rendered).toContain("producer's exact `logical_node_id` as `source node_id`");
    expect(rendered).toContain("producer `artifact_dir` joined with that declared path");
    expect(rendered).not.toContain("`logicalNodeId`");
    expect(rendered).not.toContain("`artifactDir`");
    expect(rendered).toContain("byte-for-byte equal to that manifest's root-level `node_id`");
    expect(rendered.replace(/\s+/gu, " ")).toContain("directory segment such as `attempt-<n>` is never a `node_id`");
    expect(rendered).toContain("preserve the source identity");
    expect(rendered).toContain("byte size, digest, and any\nsource metadata exactly");
    expect(rendered).toContain("A bundle is atomic");
    expect(rendered).toContain(
      `Validation command: \`ultrafuzz json validate --schema '${path.join(workspacePath, ".ultrafuzz", "schemas", "aggregation-manifest.schema.json")}' --file '${path.join(artifactDir, "aggregation.json")}'\``
    );
  });

  it("omits the schema pointer when no output ships a schema", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    expect(result.renderedMarkdown).not.toContain("Contract validation command:");
  });

  it("renders both shell-safe validation commands per schema-backed output", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const specialRoot = path.join(tmp, "path with spaces, '$dollar', and `ticks`");
    const input = baseRenderInput(specialRoot);
    const result = renderPrompt(input);

    expect(result.renderedMarkdown.match(/Validation command:/gu)).toHaveLength(2);
    expect(result.renderedMarkdown.match(/Contract validation command:/gu)).toHaveLength(2);
    expect(result.renderedMarkdown).toContain("'\"'\"'");
    expect(result.renderedMarkdown).toContain("$dollar");
    expect(result.renderedMarkdown).toContain("`` ultrafuzz json validate");
    expect(result.renderedMarkdown).toContain("`` ultrafuzz artifact validate");
    expect(result.renderedMarkdown).toContain("generated-tests.schema.json");
  });

  it("separates renderer-owned output contracts from authored validator-looking lines", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt =
      "Authored example:\n" +
      "  Validate against: `/untrusted/example.schema.json`\n" +
      "  Validation command: `ultrafuzz json validate --schema '/untrusted/example.schema.json' --file '/tmp/example.json'`\n" +
      "  Contract validation command: `ultrafuzz artifact validate 'example/contract@1' '/tmp/example.json'`";

    const result = renderPrompt(input);

    expect(result.renderedMarkdown).toContain("/untrusted/example.schema.json");
    expect(result.outputContractMarkdown).not.toContain("/untrusted/example.schema.json");
    expect(result.outputContractMarkdown.match(/Validation command:/gu)).toHaveLength(2);
    expect(result.outputContractMarkdown.match(/Contract validation command:/gu)).toHaveLength(2);
  });

  it("rejects control characters before rendering a validation command", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.graph.logicalNodes[2]!.outputs![0]!.schemaFile = "findings.schema.json\nignored";

    expect(() => renderPrompt(input)).toThrow(/control characters/u);
  });

  it("renders validated artifact handoffs and ancestor artifacts", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    expect(result.renderedMarkdown).toContain("the declared artifacts are the task result");
    expect(result.renderedMarkdown).toContain("Any terminal response is informational only");
    expect(result.renderedMarkdown).toContain("it has no required schema");
    expect(result.renderedMarkdown).not.toContain('{"summary":');
    expect(result.renderedMarkdown).not.toContain("structured task result requested by the runtime");
    expect(result.renderedMarkdown).not.toContain("schema-defined summary value");
  });

  it("rejects legacy ancestor collection helpers with compact-authority migrations", () => {
    const migrations = [
      ["{{ancestor_artifacts}}", "ancestor_contract_artifact_authority:<contract>"],
      ["{{ancestor_artifacts:boundary-tests}}", "ancestor_contract_artifact_authority:<contract>"],
      ["{{ancestor_artifacts_by_path:findings.json}}", "ancestor_artifact_path_authority:<path>"],
      ["{{ancestor_generated_test_manifests}}", "ancestor_contract_artifact_authority:ultrafuzz/generated-tests@3"],
      [
        "{{ancestor_generated_test_manifest_authorities}}",
        "ancestor_contract_artifact_authority:ultrafuzz/generated-tests@3"
      ]
    ] as const;

    for (const [template, replacement] of migrations) {
      expect(() => validatePromptVariables(template), template).toThrow(
        new RegExp(`legacy prompt helper .* is no longer supported; migrate to .*${replacement.replaceAll("/", "\\/")}`)
      );
    }
  });

  it("renders a bounded sealed authority while retaining transitive findings-contract selection", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.graph.logicalNodes.push({
      id: "dedupe-findings",
      kind: "agentic",
      dependsOn: ["boundary-tests"],
      outputs: [],
      artifactDir: path.join(input.run.artifactsDir, "dedupe-findings")
    });
    input.node.logicalId = "dedupe-findings";
    input.node.concreteId = "dedupe-findings";
    input.node.artifactDir = path.join(input.run.artifactsDir, "dedupe-findings");
    input.outputs.patchPath = path.join(input.node.artifactDir, "patch.diff");
    input.prompt = "Authorities:\n{{ancestor_contract_artifact_authority:ultrafuzz/findings@2}}";
    input.graph.logicalNodes
      .find((node) => node.id === "base-test-setup")!
      .outputs!.push({
        path: "transitive-findings.json",
        contract: "ultrafuzz/findings@2",
        primary: false,
        description: "A transitive findings output included by contract-derived lifecycle intake."
      });

    const result = renderPrompt(input);

    expectTaskLocalArtifactAuthority(result.renderedMarkdown, input);
    expect(result.renderedMarkdown).toContain("entries whose `contract` is `ultrafuzz/findings@2`");
    expect(result.renderedMarkdown).toContain("reject any absolute or escaping result");
    expect(result.renderedMarkdown).not.toContain("base-test-setup");
    expect(result.renderedMarkdown).not.toContain("boundary-tests");
    expect(result.renderedMarkdown).not.toContain("transitive-findings.json");
    expect(result.renderedMarkdown).not.toContain("artifacts/boundary-tests/findings.json");
    expect(result.artifactReferences).toContainEqual({
      kind: "ancestor_contract_artifact_authority",
      logicalIds: ["base-test-setup", "boundary-tests"],
      contract: "ultrafuzz/findings@2"
    });

    const directProducer = input.graph.logicalNodes.find((node) => node.id === "boundary-tests")!;
    directProducer.outputs = directProducer.outputs?.filter((output) => output.contract !== "ultrafuzz/findings@2");
    const transitiveOnly = renderPrompt(input);
    expect(transitiveOnly.renderedMarkdown).toBe(result.renderedMarkdown);
    expect(transitiveOnly.artifactReferences).toContainEqual({
      kind: "ancestor_contract_artifact_authority",
      logicalIds: ["base-test-setup"],
      contract: "ultrafuzz/findings@2"
    });

    const transitiveProducer = input.graph.logicalNodes.find((node) => node.id === "base-test-setup")!;
    transitiveProducer.outputs = transitiveProducer.outputs?.filter(
      (output) => output.contract !== "ultrafuzz/findings@2"
    );
    const emptyAncestorSet = renderPrompt(input);
    expect(emptyAncestorSet.renderedMarkdown).toBe(result.renderedMarkdown);
    expect(emptyAncestorSet.artifactReferences).toContainEqual({
      kind: "ancestor_contract_artifact_authority",
      logicalIds: [],
      contract: "ultrafuzz/findings@2"
    });
  });

  it("does not inline an unbounded ancestor path array into workflow prompts", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.graph.logicalNodes.push(
      {
        id: "differential-oracle-planner",
        kind: "agentic",
        dependsOn: ["boundary-tests"],
        outputs: [
          {
            path: "differential-plan.json",
            contract: "ultrafuzz/differential-plan@1",
            primary: true,
            description: "A differential plan."
          }
        ],
        artifactDirs: [path.join(input.run.artifactsDir, "Planner-Z"), path.join(input.run.artifactsDir, "planner-a")]
      },
      {
        id: "reference-harness-author",
        kind: "agentic",
        dependsOn: ["differential-oracle-planner"],
        outputs: [],
        artifactDir: path.join(input.run.artifactsDir, "reference-harness-author")
      }
    );
    input.node.logicalId = "reference-harness-author";
    input.node.concreteId = "reference-harness-author";
    input.node.artifactDir = path.join(input.run.artifactsDir, "reference-harness-author");
    input.outputs.patchPath = path.join(input.node.artifactDir, "patch.diff");
    input.prompt = "Plans: {{ancestor_contract_artifact_authority:ultrafuzz/differential-plan@1}}";

    const oneAncestor = renderPrompt(input);
    input.graph.logicalNodes.find((node) => node.id === "differential-oracle-planner")!.artifactDirs = Array.from(
      { length: 2_000 },
      (_, index) => path.join(input.run.artifactsDir, `model-attempt-${String(index).padStart(4, "0")}`)
    );
    let dependency = "differential-oracle-planner";
    for (let index = 0; index < 2_000; index += 1) {
      const id = `ancestor-plan-${String(index).padStart(4, "0")}`;
      input.graph.logicalNodes.push({
        id,
        kind: "agentic",
        dependsOn: [dependency],
        outputs: [
          {
            path: "differential-plan.json",
            contract: "ultrafuzz/differential-plan@1",
            primary: true,
            description: "Another differential plan ancestor."
          }
        ],
        artifactDir: path.join(input.run.artifactsDir, id)
      });
      dependency = id;
    }
    input.graph.logicalNodes.find((node) => node.id === "reference-harness-author")!.dependsOn = [dependency];
    const manyAncestors = renderPrompt(input);

    expect(manyAncestors.renderedMarkdown).toBe(oneAncestor.renderedMarkdown);
    expectTaskLocalArtifactAuthority(manyAncestors.renderedMarkdown, input);
    expect(manyAncestors.renderedMarkdown).toContain("entries whose `contract` is `ultrafuzz/differential-plan@1`");
    expect(manyAncestors.renderedMarkdown).not.toContain("differential-plan.json");
    expect(manyAncestors.renderedMarkdown).not.toContain("ancestor-plan-");
    expect(manyAncestors.renderedMarkdown).not.toContain("model-attempt-");
    const authorityReference = manyAncestors.artifactReferences.find(
      (reference) =>
        reference.kind === "ancestor_contract_artifact_authority" &&
        reference.contract === "ultrafuzz/differential-plan@1"
    );
    expect(authorityReference).toMatchObject({
      kind: "ancestor_contract_artifact_authority",
      contract: "ultrafuzz/differential-plan@1"
    });
    expect(
      authorityReference?.kind === "ancestor_contract_artifact_authority" && authorityReference.logicalIds
    ).toHaveLength(2_001);
  });

  it("does not inline model-fanout paths for compact exact-output-path authority", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Setup: {{ancestor_artifact_path_authority:setup/base-test-setup.md}}";

    const oneProducerAttempt = renderPrompt(input);
    input.graph.logicalNodes.find((node) => node.id === "base-test-setup")!.artifactDirs = Array.from(
      { length: 2_000 },
      (_, index) => path.join(input.run.artifactsDir, `setup-model-attempt-${String(index).padStart(4, "0")}`)
    );
    let dependency = "base-test-setup";
    for (let index = 0; index < 2_000; index += 1) {
      const id = `setup-ancestor-${String(index).padStart(4, "0")}`;
      input.graph.logicalNodes.push({
        id,
        kind: "agentic",
        dependsOn: [dependency],
        outputs: [
          {
            path: "setup/base-test-setup.md",
            contract: "ultrafuzz/nonempty-markdown@1",
            primary: true,
            description: "Another exact setup handoff."
          }
        ],
        artifactDir: path.join(input.run.artifactsDir, id)
      });
      dependency = id;
    }
    input.graph.logicalNodes.find((node) => node.id === "boundary-tests")!.dependsOn = [dependency];
    const manyProducerAttempts = renderPrompt(input);

    expect(manyProducerAttempts.renderedMarkdown).toBe(oneProducerAttempt.renderedMarkdown);
    expectTaskLocalArtifactAuthority(manyProducerAttempts.renderedMarkdown, input);
    expect(manyProducerAttempts.renderedMarkdown).toContain(
      `entry whose \`id\` is \`${promptArtifactAuthorityPathSelectorId(["setup/base-test-setup.md"])}\``
    );
    expect(manyProducerAttempts.renderedMarkdown).not.toContain("setup/base-test-setup.md");
    expect(manyProducerAttempts.renderedMarkdown).not.toContain("setup-model-attempt-");
    expect(manyProducerAttempts.renderedMarkdown).not.toContain("setup-ancestor-");
    const authorityReference = manyProducerAttempts.artifactReferences.find(
      (reference) =>
        reference.kind === "ancestor_artifact_path_authority" &&
        reference.relativePaths.includes("setup/base-test-setup.md")
    );
    expect(authorityReference).toMatchObject({
      kind: "ancestor_artifact_path_authority",
      selectorId: promptArtifactAuthorityPathSelectorId(["setup/base-test-setup.md"]),
      relativePaths: ["setup/base-test-setup.md"]
    });
    expect(
      authorityReference?.kind === "ancestor_artifact_path_authority" && authorityReference.logicalIds
    ).toHaveLength(2_001);
  });

  it("keeps coverage-report authority constant across hundreds of producer attempts", () => {
    const topologyPath = fileURLToPath(new URL("../../config/topologies/invariant-only.yml", import.meta.url));
    const topology = YAML.parse(readFileSync(topologyPath, "utf8")) as TopologyDocument;
    const promptByPath = new Map(loadBuiltInPromptAssets().map((asset) => [asset.relativePath, asset.markdown]));
    const root = path.join(realpathSync(os.tmpdir()), "ultrafuzz-coverage-authority-size");
    const runArtifacts = path.join(root, "runs", "coverage-authority-size", "artifacts");
    const logicalNodes: PromptRenderInput["graph"]["logicalNodes"] = topology.nodes.map((node) => ({
      id: node.id,
      kind: node.kind === "reference" ? "reference" : "agentic",
      dependsOn: node.depends_on ?? [],
      artifactDir: path.join(runArtifacts, node.id),
      outputs: (node.outputs ?? []).map((output, index) => ({
        path: output.path,
        contract: output.contract,
        primary: output.primary ?? index === 0,
        description: `${output.contract} invariant output.`
      }))
    }));
    const coverageProducer = logicalNodes.find((node) => node.id === "stateful-invariant-coverage")!;
    const consumerPromptPaths = [
      "strategies/invariants/implement-properties.md",
      "strategies/invariants/invariant-testing-campaign.md"
    ];

    for (const promptPath of consumerPromptPaths) {
      const consumer = topology.nodes.find((node) => node.prompt === promptPath)!;
      const prompt = promptByPath.get(promptPath);
      expect(prompt, promptPath).toBeDefined();
      const artifactDir = path.join(runArtifacts, `${consumer.id}-attempt-0`);
      const input: PromptRenderInput = {
        prompt: prompt!,
        graph: { logicalNodes },
        node: {
          logicalId: consumer.id,
          concreteId: `${consumer.id}-attempt-0`,
          artifactDir,
          workspacePath: path.join(root, "workspaces", `${consumer.id}-attempt-0`),
          repoPath: path.join(root, "repo"),
          attemptIndex: 0,
          loopIndex: 0,
          loopCount: 1
        },
        run: {
          id: "coverage-authority-size",
          artifactsDir: runArtifacts,
          metadataPath: path.join(root, "runs", "coverage-authority-size", "run.json")
        },
        outputs: { patchPath: path.join(artifactDir, "workspace.patch") }
      };

      coverageProducer.artifactDirs = undefined;
      const oneAttempt = renderPrompt(input);
      coverageProducer.artifactDirs = Array.from({ length: 400 }, (_, index) =>
        path.join(runArtifacts, `synthetic-coverage-attempt-${String(index).padStart(3, "0")}`)
      );
      const hundredsOfAttempts = renderPrompt(input);

      expect(hundredsOfAttempts.renderedMarkdown, promptPath).toBe(oneAttempt.renderedMarkdown);
      expect(hundredsOfAttempts.renderedMarkdown.length, promptPath).toBe(oneAttempt.renderedMarkdown.length);
      expectTaskLocalArtifactAuthority(hundredsOfAttempts.renderedMarkdown, input);
      expect(hundredsOfAttempts.renderedMarkdown).toContain(
        `path entry whose \`id\` is \`${promptArtifactAuthorityPathSelectorId(["coverage-report.md"])}\``
      );
      expect(hundredsOfAttempts.renderedMarkdown).not.toContain("synthetic-coverage-attempt-");
    }
  });

  it("renders both compact selectors as task-local authority pointers", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = [
      "{{ancestor_contract_artifact_authority:ultrafuzz/findings@2}}",
      "{{ancestor_artifact_path_authority:findings.json}}"
    ].join("\n");

    const rendered = renderPrompt(input).renderedMarkdown;
    const authorityPath = taskLocalArtifactAuthorityPath(input);

    expectTaskLocalArtifactAuthority(rendered, input);
    expect(occurrences(rendered, `ancestor artifact authority JSON at \`${authorityPath}\``)).toBe(2);
    expect(occurrences(rendered, `Confirm its \`attempt_id\` is \`${input.node.concreteId}\``)).toBe(2);
    expect(occurrences(rendered, "`artifact_path_base`")).toBe(2);
    expect(rendered).toContain("entries whose `contract` is `ultrafuzz/findings@2`");
    expect(rendered).toContain(
      `path entry whose \`id\` is \`${promptArtifactAuthorityPathSelectorId(["findings.json"])}\``
    );
    expect(rendered).not.toContain("project-discovery");
    expect(rendered).not.toContain("base-test-setup");
  });

  it("rejects compact authority selectors that match a reference ancestor", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    const reference = input.graph.logicalNodes.find((node) => node.id === "project-discovery")!;
    reference.kind = "reference";

    input.prompt = "{{ancestor_contract_artifact_authority:ultrafuzz/nonempty-markdown@1}}";
    expect(() => renderPrompt(input)).toThrow(
      /compact authority selector `ancestor_contract_artifact_authority:ultrafuzz\/nonempty-markdown@1` cannot select reference ancestor `project-discovery`; fixed reference consumers must use `artifact_path:project-discovery` or `artifact_handoff:project-discovery`/u
    );

    input.prompt = "{{ancestor_artifact_path_authority:setup/project-discovery.md}}";
    expect(() => renderPrompt(input)).toThrow(
      /compact authority selector `ancestor_artifact_path_authority:setup\/project-discovery\.md` cannot select reference ancestor `project-discovery`; fixed reference consumers must use `artifact_path:project-discovery` or `artifact_handoff:project-discovery`/u
    );

    input.prompt = "{{artifact_path:project-discovery}}\n{{artifact_handoff:project-discovery}}";
    const fixedReference = renderPrompt(input).renderedMarkdown;
    expect(fixedReference).toContain(path.join(input.run.artifactsDir, "project-discovery"));
    expect(fixedReference).toContain(
      path.join(input.run.artifactsDir, "project-discovery", "setup", "project-discovery.md")
    );
  });

  it("keeps zero-match compact authority selectors valid", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = [
      "{{ancestor_contract_artifact_authority:ultrafuzz/report@3}}",
      "{{ancestor_artifact_path_authority:missing.json}}"
    ].join("\n");

    const result = renderPrompt(input);

    expectTaskLocalArtifactAuthority(result.renderedMarkdown, input);
    expect(result.artifactReferences).toContainEqual({
      kind: "ancestor_contract_artifact_authority",
      logicalIds: [],
      contract: "ultrafuzz/report@3"
    });
    expect(result.artifactReferences).toContainEqual({
      kind: "ancestor_artifact_path_authority",
      logicalIds: [],
      selectorId: promptArtifactAuthorityPathSelectorId(["missing.json"]),
      relativePaths: ["missing.json"]
    });
  });

  it("rejects unknown contracts in compact ancestor authority selectors", () => {
    expect(() =>
      validatePromptVariables("{{ancestor_contract_artifact_authority:ultrafuzz/not-a-registered-contract@1}}")
    ).toThrow(/unknown ancestor artifact contract for sealed authority/u);
    expect(() => validatePromptVariables("{{ancestor_contract_artifact_authority}}")).toThrow(
      /requires an exact registered artifact contract/u
    );
  });

  it("rejects missing or duplicate paths in compact ancestor path authority selectors", () => {
    expect(() => validatePromptVariables("{{ancestor_artifact_path_authority}}")).toThrow(
      /requires at least one exact declared output path/u
    );
    expect(() =>
      validatePromptVariables("{{ancestor_artifact_path_authority:setup/base-test-setup.md,setup/base-test-setup.md}}")
    ).toThrow(/duplicate ancestor_artifact_path_authority target/u);
  });

  it("keeps exact-path authority prose constant-size as the selected path group grows", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Setup:\n{{ancestor_artifact_path_authority:reports/0000.json}}";
    const onePath = renderPrompt(input);
    const paths = Array.from({ length: 1_000 }, (_, index) => `reports/${String(index).padStart(4, "0")}.json`);
    input.prompt = `Setup:\n{{ancestor_artifact_path_authority:${paths.join(",")}}}`;
    const manyPaths = renderPrompt(input);

    expect(manyPaths.renderedMarkdown).toHaveLength(onePath.renderedMarkdown.length);
    expectTaskLocalArtifactAuthority(manyPaths.renderedMarkdown, input);
    expect(manyPaths.renderedMarkdown).not.toContain("reports/0000.json");
    expect(manyPaths.artifactReferences).toContainEqual({
      kind: "ancestor_artifact_path_authority",
      logicalIds: [],
      selectorId: promptArtifactAuthorityPathSelectorId(paths),
      relativePaths: paths
    });
  });

  it("does not ask agents to author runtime-owned workspace patch outputs", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "Smoke timeout: {{invariant_testing_smoke_timeout}}";
    input.resolvedConfig = { invariantTestingSmokeTimeout: 600 };

    const result = renderPrompt(input);

    expect(result.renderedMarkdown).toContain("Smoke timeout: 600");
    expect(result.variablesUsed).toContain("invariant_testing_smoke_timeout");
  });

  it("renders the task-local schema bundle path", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
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
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.graph.logicalNodes.push({
      id: "unrelated",
      kind: "agentic",
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
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.graph.logicalNodes[1]!.outputs = input.graph.logicalNodes[1]!.outputs?.map((output) => ({
      ...output,
      primary: false
    }));

    expect(() => renderPrompt(input)).toThrow(/primary output/);
  });

  it("writes prompt.rendered.md before workflow launch", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const result = renderPrompt(baseRenderInput(tmp));
    const renderedPath = writeRenderedPrompt(result);

    expect(path.basename(renderedPath)).toBe("prompt.rendered.md");
    expect(readFileSync(renderedPath, "utf8")).toBe(result.renderedMarkdown);
  });

  it("renders authoritative prompt fragments from their shared authorities", () => {
    const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ufz-render-"));
    tmpDirs.push(tmp);
    const input = baseRenderInput(tmp);
    input.prompt = "{{finding_reachability_vocabulary}}\n{{finding_note_key_vocabulary}}";

    const rendered = renderPrompt(input).renderedMarkdown;
    expect(rendered).toContain("reachability=public-entrypoint-trace");
    expect(rendered).toContain("reachability=public-wrapper-required");
    expect(rendered).toContain("helper_proof=<summary>");
    expect(rendered).not.toContain("reachability=<summary>");
    expect(rendered).toContain("stateful_failure_classification=<production-bug|harness-defect|");
    input.variables = { finding_reachability_vocabulary: "reachability=renamed" };
    expect(() => renderPrompt(input)).toThrow(/authoritative and cannot be overridden/u);
    input.variables = { coverage_evidence_markdown_projection: "replacement" };
    expect(() => renderPrompt(input)).toThrow(/authoritative and cannot be overridden/u);
  });
});
