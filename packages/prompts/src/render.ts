import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parsePromptFrontmatter, PromptError } from "./frontmatter.js";
import { builtInPromptRoot } from "./assets.js";

export const RENDERED_PROMPT_FILE = "prompt.rendered.md";

export const SUPPORTED_TEMPLATE_VARIABLES = [
  "repo_path",
  "workspace_path",
  "schema_path",
  "artifact_path",
  "artifact_dir",
  "ancestor_artifacts",
  "run_metadata_path",
  "output_findings_path",
  "output_patch_path",
  "strategy",
  "attempt_index",
  "strategy_loop_index",
  "strategy_loop_count",
  "triage_quorum",
  "triage_panel_size",
  "dynamic_strategies_enumerator",
  "invariant_property_priority_threshold",
  "invariant_property_priority_filter",
  "invariant_property_priorities",
  "invariant_testing_smoke_timeout",
  "invariant_testing_fuzzer_timeout",
  "strategy_attempt_test_dir",
  "vulnerability_database_path",
  "artifact_schema_dir"
] as const;

export type SupportedTemplateVariable = (typeof SUPPORTED_TEMPLATE_VARIABLES)[number];

export interface PromptGraphNode {
  id: string;
  dependsOn?: string[];
  depends_on?: string[];
  artifactDir?: string;
  artifactDirs?: string[];
  outputs?: PromptArtifactOutput[];
}

export interface PromptArtifactOutput {
  path: string;
  contract: string;
  primary: boolean;
  description: string;
  validEmptyExample?: string;
}

export interface PromptConcreteNode {
  id: string;
  logicalId: string;
  logical_id?: string;
  dependsOn?: string[];
  depends_on?: string[];
  artifactDir: string;
  loopIndex?: number;
  loop_index?: number;
  attemptIndex?: number;
  attempt_index?: number;
  model?: string;
  modelName?: string;
  model_name?: string;
  modelIndex?: number;
  model_index?: number;
  modelProfileId?: string;
  model_profile_id?: string;
  agentRef?: string;
  agent_ref?: string;
}

export interface PromptModelProvenance {
  modelProfileId?: string;
  agentRef?: string;
  modelName?: string;
  modelIndex?: number;
  loopIndex?: number;
  attemptIndex?: number;
}

export interface PromptRenderInput {
  prompt: string | { body: string; id?: string; displayName?: string; source?: string };
  variables?: Record<string, string | number | boolean>;
  /**
   * Runtime-discovered values scoped to one dynamic topology item. These are
   * deliberately separate from the closed set of built-in variable overrides:
   * a planner may supply `item.foo` values or namespaced keys such as
   * `liquidation:overdue`, but it cannot redefine trusted runtime variables.
   */
  dynamicVariables?: Record<string, string | number | boolean>;
  graph: {
    logicalNodes: PromptGraphNode[];
    concreteNodes?: PromptConcreteNode[];
  };
  node: {
    logicalId: string;
    concreteId: string;
    artifactDir: string;
    workspacePath: string;
    repoPath: string;
    attemptIndex?: number;
    loopIndex?: number;
    loopCount?: number;
    agentRef?: string;
    modelProfileId?: string;
    modelName?: string;
    modelIndex?: number;
    modelProvenance?: PromptModelProvenance;
  };
  run: {
    id: string;
    artifactsDir: string;
    metadataPath: string;
  };
  outputs: {
    findingsPath: string;
    patchPath: string;
  };
  resolvedConfig?: {
    triage?: {
      quorum?: number;
      panelSize?: number;
    };
    dynamicStrategiesEnumerator?: number;
    invariantPropertyPriorityThreshold?: string | number;
    invariantPropertyPriorityFilter?: string;
    invariantPropertyPriorities?: string[];
    invariantTestingSmokeTimeout?: string | number;
    invariantTestingFuzzerTimeout?: string | number;
    vulnerabilityDatabasePath?: string;
    artifactSchemaDir?: string;
  };
}

export interface PromptRenderResult {
  renderedMarkdown: string;
  renderedPromptPath: string;
  variablesUsed: string[];
  artifactReferences: PromptArtifactReference[];
  metadata: {
    runId: string;
    logicalNodeId: string;
    concreteNodeId: string;
    artifactDir: string;
    promptId?: string;
    displayName?: string;
    modelProvenance?: PromptModelProvenance;
  };
}

export type PromptArtifactReference =
  | { kind: "artifact_path"; logicalId?: string; suffix?: string }
  | { kind: "artifact_handoff"; logicalId: string }
  | { kind: "ancestor_artifacts"; logicalIds: string[] | "direct" };

type ArtifactProducer =
  { kind: "current" } | { kind: "logical"; logicalId: string } | { kind: "handoff"; logicalId: string };

export interface TemplateOccurrence {
  name: string;
  rawName: string;
  start: number;
  end: number;
}

/**
 * The single source of truth for which `{{...}}` occurrences a rendered prompt will actually bind.
 * Escaped `\{{...}}` occurrences are deliberately skipped here and unescaped verbatim at render
 * time, so every contract that promises "this placeholder is bound" must use this parser instead
 * of its own regex.
 */
export function promptTemplateOccurrences(template: string): TemplateOccurrence[] {
  return findTemplateOccurrences(template);
}

export interface PromptVariableReference {
  raw: string;
  name: string;
  argument?: string;
  path?: string;
  scope?: "dynamic-item";
}

export interface PromptVariableParseOptions {
  allowDynamicItemVariables?: boolean;
}

export function isSupportedTemplateVariable(name: string): name is SupportedTemplateVariable {
  return (SUPPORTED_TEMPLATE_VARIABLES as readonly string[]).includes(name);
}

export function isDynamicItemTemplateVariable(name: string): boolean {
  return (
    /^item\.[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/u.test(name) ||
    isNamespacedDynamicReplacementKey(name)
  );
}

/**
 * The exact key shape a dynamic fanout consumer accepts for planner-supplied replacements. Every
 * layer that accepts or produces `replacements` keys must use this predicate so a contract-valid
 * artifact can never carry a key the renderer refuses to bind.
 */
export function isNamespacedDynamicReplacementKey(name: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]*(?::[a-z0-9][a-z0-9_.-]*)+$/u.test(name);
}

export function parsePromptVariableReference(
  rawName: string,
  options: PromptVariableParseOptions = {}
): PromptVariableReference {
  const raw = rawName.trim();
  if (raw === "") {
    throw new PromptError("empty-template-variable", "template variable name cannot be empty");
  }

  const producer = parseArtifactProducer(raw);
  if (producer) {
    if (producer.kind === "current") {
      return { raw, name: raw };
    }
    if (producer.kind === "logical") {
      return { raw, name: "artifact_path", argument: producer.logicalId };
    }
    return { raw, name: "artifact_handoff", argument: producer.logicalId };
  }

  const ancestorArtifacts = parseAncestorArtifactsSelector(raw);
  if (ancestorArtifacts) {
    return ancestorArtifacts === "direct"
      ? { raw, name: "ancestor_artifacts" }
      : { raw, name: "ancestor_artifacts", argument: ancestorArtifacts.join(",") };
  }

  if (options.allowDynamicItemVariables === true && isDynamicItemTemplateVariable(raw)) {
    return { raw, name: raw, scope: "dynamic-item" };
  }

  if (!isSupportedTemplateVariable(raw)) {
    throw new PromptError("missing-template-variable", `unknown prompt template variable: ${raw}`, { variable: raw });
  }

  return { raw, name: raw };
}

export function extractPromptVariables(
  promptText: string,
  options: PromptVariableParseOptions = {}
): PromptVariableReference[] {
  const references: PromptVariableReference[] = [];
  for (const occurrence of findTemplateOccurrences(promptText)) {
    references.push(validatePromptVariableOccurrence(occurrence, promptText, options));
  }
  return references;
}

export function validatePromptVariables(template: string, options: PromptVariableParseOptions = {}): void {
  for (const occurrence of findTemplateOccurrences(template)) {
    validatePromptVariableOccurrence(occurrence, template, options);
  }
}

function validatePromptVariableOccurrence(
  occurrence: TemplateOccurrence,
  template: string,
  options: PromptVariableParseOptions
): PromptVariableReference {
  const reference = parsePromptVariableReference(occurrence.name, options);
  const producer = parseArtifactProducer(occurrence.name);
  if (producer) {
    const suffix = parseArtifactSuffix(producer, template.slice(occurrence.end));
    return suffix.path === undefined ? reference : { ...reference, path: suffix.path };
  }
  const ancestorArtifacts = parseAncestorArtifactsSelector(occurrence.name);
  if (ancestorArtifacts) {
    rejectAncestorArtifactsSuffix(template.slice(occurrence.end));
  }
  return reference;
}

export function renderPrompt(input: PromptRenderInput): PromptRenderResult {
  const body = typeof input.prompt === "string" ? parsePromptFrontmatter(input.prompt).body : input.prompt.body;
  validatePromptVariables(body, { allowDynamicItemVariables: input.dynamicVariables !== undefined });
  validateRenderInputPaths(input);
  validateVariableOverrides(input.variables);
  validateDynamicVariables(input.dynamicVariables);
  const modelProvenance = resolveModelProvenance(input);

  const graph = buildGraphIndex(input);
  const variables = buildVariableContext(input);
  const artifactReferences: PromptArtifactReference[] = [];
  const variablesUsed: string[] = [];
  let rendered = "";
  let consumed = 0;

  for (const occurrence of findTemplateOccurrences(body)) {
    rendered += unescapePromptTemplateLiterals(body.slice(consumed, occurrence.start));
    variablesUsed.push(occurrence.name);

    const producer = parseArtifactProducer(occurrence.name);
    if (producer) {
      const suffix = parseArtifactSuffix(producer, body.slice(occurrence.end));
      rendered += renderArtifactProducer(producer, suffix.path, graph);
      artifactReferences.push(referenceForProducer(producer, suffix.path));
      consumed = occurrence.end + suffix.consumed;
      continue;
    }

    const ancestorArtifacts = parseAncestorArtifactsSelector(occurrence.name);
    if (ancestorArtifacts) {
      rejectAncestorArtifactsSuffix(body.slice(occurrence.end));
      rendered += renderAncestorArtifacts(ancestorArtifacts, graph);
      artifactReferences.push({
        kind: "ancestor_artifacts",
        logicalIds: ancestorArtifacts === "direct" ? "direct" : ancestorArtifacts
      });
      consumed = occurrence.end;
      continue;
    }

    if (isDynamicItemTemplateVariable(occurrence.name)) {
      const resolved = resolveDynamicVariable(occurrence.name, input.dynamicVariables ?? {});
      rendered += resolved.value;
      variablesUsed.push(...resolved.variablesUsed);
    } else {
      const value = variables[occurrence.name];
      if (value === undefined) {
        throw new PromptError("missing-template-variable", `missing prompt template variable: ${occurrence.name}`);
      }
      rendered += value;
    }
    consumed = occurrence.end;
  }
  rendered += unescapePromptTemplateLiterals(body.slice(consumed));
  rendered = appendOutputContract(rendered, input, graph.current);

  return {
    renderedMarkdown: rendered,
    renderedPromptPath: path.join(input.node.artifactDir, RENDERED_PROMPT_FILE),
    variablesUsed: Array.from(new Set(variablesUsed)).sort(),
    artifactReferences,
    metadata: {
      runId: input.run.id,
      logicalNodeId: input.node.logicalId,
      concreteNodeId: input.node.concreteId,
      artifactDir: input.node.artifactDir,
      ...(typeof input.prompt === "string" ? {} : input.prompt.id ? { promptId: input.prompt.id } : {}),
      ...(typeof input.prompt === "string"
        ? {}
        : input.prompt.displayName
          ? { displayName: input.prompt.displayName }
          : {}),
      ...(modelProvenance ? { modelProvenance } : {})
    }
  };
}

function appendOutputContract(rendered: string, input: PromptRenderInput, current: PromptGraphNode): string {
  // Workspace patches are captured from the complete post-agent worktree by
  // the runtime. They remain declared in the graph for validation and
  // dependency handoff, but must not be presented as files for the agent to
  // author (an agent can only see a partial pre-capture patch).
  const outputs = artifactOutputsFor(current).filter(
    (output) => output.path !== "workspace.patch" && output.path !== "workspace-patch.json"
  );
  if (outputs.length === 0) {
    return rendered;
  }

  const contract = renderOutputContractTemplate("output-contract.mdx", {
    artifact_contracts: outputs
      .map((output) => {
        const validEmptyExample = output.validEmptyExample === "" ? "<empty file>" : output.validEmptyExample;
        const empty =
          validEmptyExample === undefined ? "Empty output is not valid." : `Valid empty form: \`${validEmptyExample}\``;
        return [
          `- Path: \`${path.join(input.node.artifactDir, output.path)}\`${output.primary ? " (primary)" : ""}`,
          `  Contract: \`${output.contract}\``,
          `  Schema: ${output.description}`,
          `  ${empty}`
        ].join("\n");
      })
      .join("\n")
  });

  return `${rendered.trimEnd()}\n\n${contract.trimEnd()}\n`;
}

const outputContractTemplateCache = new Map<string, string>();

function renderOutputContractTemplate(relativePath: string, variables: Record<string, string>): string {
  return loadOutputContractTemplate(relativePath).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (_, key: string) => {
    const value = variables[key];
    if (value === undefined) {
      throw new PromptError("missing-template-variable", `missing output contract template variable: ${key}`);
    }
    return value;
  });
}

function loadOutputContractTemplate(relativePath: string): string {
  const cached = outputContractTemplateCache.get(relativePath);
  if (cached !== undefined) {
    return cached;
  }
  const template = readFileSync(path.join(outputContractTemplateRoot(), relativePath), "utf8");
  outputContractTemplateCache.set(relativePath, template);
  return template;
}

function outputContractTemplateRoot(): string {
  return path.join(builtInPromptRoot(), "_templates", "output-contract");
}

export function writeRenderedPrompt(result: PromptRenderResult): string {
  mkdirSync(path.dirname(result.renderedPromptPath), { recursive: true });
  writeFileSync(result.renderedPromptPath, result.renderedMarkdown, "utf8");
  return result.renderedPromptPath;
}

export function renamePromptArtifactReferences(template: string, oldLogicalId: string, newLogicalId: string): string {
  validateArtifactReferenceId(oldLogicalId);
  validateArtifactReferenceId(newLogicalId);

  let rewritten = "";
  let consumed = 0;
  for (const occurrence of findTemplateOccurrences(template)) {
    rewritten += template.slice(consumed, occurrence.start);
    const replacement = renameTemplateVariableName(occurrence.name, oldLogicalId, newLogicalId);
    const leadingWhitespace = occurrence.rawName.length - occurrence.rawName.trimStart().length;
    const trailingWhitespace = occurrence.rawName.length - occurrence.rawName.trimEnd().length;
    rewritten += "{{";
    rewritten += occurrence.rawName.slice(0, leadingWhitespace);
    rewritten += replacement;
    rewritten += occurrence.rawName.slice(occurrence.rawName.length - trailingWhitespace);
    rewritten += "}}";

    consumed = occurrence.end;
    const producer = parseArtifactProducer(occurrence.name);
    if (producer?.kind === "current" || (producer?.kind === "logical" && producer.logicalId === oldLogicalId)) {
      const suffix = rewriteArtifactPathSuffix(template.slice(consumed), oldLogicalId, newLogicalId);
      if (suffix.consumed > 0) {
        rewritten += suffix.value;
        consumed += suffix.consumed;
      }
    }
  }
  rewritten += template.slice(consumed);
  return rewritten;
}

export function validateArtifactRelativePath(relativePath: string): void {
  const parts = relativePath.split("/");
  if (
    relativePath === "" ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes("//") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new PromptError(
      "invalid-artifact-reference",
      `artifact reference path must be relative and traversal-free: ${relativePath}`
    );
  }
  if (!/^[A-Za-z0-9._/@+-]+$/.test(relativePath)) {
    throw new PromptError(
      "invalid-artifact-reference",
      `artifact reference path contains unsupported characters: ${relativePath}`
    );
  }
}

function findTemplateOccurrences(template: string): TemplateOccurrence[] {
  const occurrences: TemplateOccurrence[] = [];
  let offset = 0;
  while (true) {
    const start = template.indexOf("{{", offset);
    if (start === -1) {
      return occurrences;
    }
    if (template[start - 1] === "\\") {
      offset = start + 2;
      continue;
    }
    const end = template.indexOf("}}", start + 2);
    if (end === -1) {
      throw new PromptError("unclosed-template-variable", "template variable is missing a closing delimiter");
    }
    const rawName = template.slice(start + 2, end);
    const name = rawName.trim();
    if (name === "") {
      throw new PromptError("empty-template-variable", "template variable name cannot be empty");
    }
    occurrences.push({
      name,
      rawName,
      start,
      end: end + 2
    });
    offset = end + 2;
  }
}

function unescapePromptTemplateLiterals(template: string): string {
  return template.replaceAll("\\{{", "{{");
}

function parseArtifactProducer(name: string): ArtifactProducer | undefined {
  if (name === "artifact_path" || name === "artifact_dir") {
    return { kind: "current" };
  }
  const handoff = name.match(/^artifact_handoff:(.+)$/);
  if (handoff) {
    validateArtifactReferenceId(handoff[1] ?? "");
    return { kind: "handoff", logicalId: handoff[1] ?? "" };
  }
  const logical = name.match(/^artifact_path:(.+)$/);
  if (logical) {
    validateArtifactReferenceId(logical[1] ?? "");
    return { kind: "logical", logicalId: logical[1] ?? "" };
  }
  return undefined;
}

function parseAncestorArtifactsSelector(name: string): "direct" | string[] | undefined {
  if (name === "ancestor_artifacts") {
    return "direct";
  }
  const selected = name.match(/^ancestor_artifacts:(.+)$/);
  if (!selected) {
    return undefined;
  }
  const seen = new Set<string>();
  const ids = (selected[1] ?? "").split(",").map((part) => part.trim());
  for (const id of ids) {
    validateArtifactReferenceId(id);
    if (seen.has(id)) {
      throw new PromptError("invalid-artifact-reference", `duplicate ancestor_artifacts target: ${id}`);
    }
    seen.add(id);
  }
  return ids;
}

function validateArtifactReferenceId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new PromptError("invalid-artifact-reference", `invalid artifact reference target: ${id}`);
  }
}

function parseArtifactSuffix(producer: ArtifactProducer, afterVariable: string): { path?: string; consumed: number } {
  if (producer.kind === "handoff") {
    if (afterVariable.startsWith("/")) {
      const raw = afterVariable.slice(0, findSuffixEnd(afterVariable));
      throw new PromptError(
        "invalid-artifact-reference",
        `artifact_handoff resolves to a file and cannot accept suffix: ${raw}`
      );
    }
    return { consumed: 0 };
  }
  if (!afterVariable.startsWith("/")) {
    return { consumed: 0 };
  }
  const raw = afterVariable.slice(1);
  const rawEnd = findSuffixEnd(raw);
  const token = raw.slice(0, rawEnd);
  const trimmed = token.replace(/[.,;:!?]+$/g, "");
  if (trimmed === "") {
    return { consumed: 1 };
  }
  validateArtifactRelativePath(trimmed);
  return {
    path: trimmed,
    consumed: 1 + trimmed.length
  };
}

function rejectAncestorArtifactsSuffix(afterVariable: string): void {
  if (afterVariable.startsWith("/")) {
    throw new PromptError("invalid-artifact-reference", "ancestor_artifacts does not accept a path suffix");
  }
}

function findSuffixEnd(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (/\s/.test(char) || "\"'`<>()[]{}|".includes(char)) {
      return index;
    }
  }
  return value.length;
}

interface GraphIndex {
  current: PromptGraphNode;
  logicalNodes: Map<string, PromptGraphNode>;
  ancestorIds: Set<string>;
  directDependencyIds: string[];
  artifactDirsByLogicalId: Map<string, string[]>;
}

function buildGraphIndex(input: PromptRenderInput): GraphIndex {
  const logicalNodes = new Map<string, PromptGraphNode>();
  for (const node of input.graph.logicalNodes) {
    if (logicalNodes.has(node.id)) {
      throw new PromptError("invalid-render-input", `duplicate logical node in render graph: ${node.id}`);
    }
    logicalNodes.set(node.id, node);
  }
  const current = logicalNodes.get(input.node.logicalId);
  if (!current) {
    throw new PromptError(
      "invalid-render-input",
      `current logical node is not present in graph: ${input.node.logicalId}`
    );
  }

  const artifactDirsByLogicalId = new Map<string, string[]>();
  for (const node of input.graph.logicalNodes) {
    const dirs = new Set<string>();
    for (const dir of node.artifactDirs ?? []) {
      dirs.add(dir);
    }
    if (node.artifactDir) {
      dirs.add(node.artifactDir);
    }
    artifactDirsByLogicalId.set(node.id, Array.from(dirs).sort());
  }
  for (const concrete of input.graph.concreteNodes ?? []) {
    const logicalId = concrete.logicalId ?? concrete.logical_id;
    if (!logicalId) {
      throw new PromptError("invalid-render-input", `concrete node \`${concrete.id}\` is missing logicalId`);
    }
    if (!logicalNodes.has(logicalId)) {
      throw new PromptError(
        "invalid-render-input",
        `concrete node \`${concrete.id}\` references unknown logical node \`${logicalId}\``
      );
    }
    const previous = artifactDirsByLogicalId.get(logicalId) ?? [];
    artifactDirsByLogicalId.set(logicalId, Array.from(new Set([...previous, concrete.artifactDir])).sort());
  }
  artifactDirsByLogicalId.set(input.node.logicalId, [input.node.artifactDir]);

  return {
    current,
    logicalNodes,
    ancestorIds: collectAncestorIds(input.node.logicalId, logicalNodes),
    directDependencyIds: dependenciesFor(current),
    artifactDirsByLogicalId
  };
}

function collectAncestorIds(logicalId: string, logicalNodes: Map<string, PromptGraphNode>): Set<string> {
  const ancestors = new Set<string>();
  const stack = [...dependenciesFor(logicalNodes.get(logicalId))];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (ancestors.has(next)) {
      continue;
    }
    ancestors.add(next);
    stack.push(...dependenciesFor(logicalNodes.get(next)));
  }
  return ancestors;
}

function dependenciesFor(node: PromptGraphNode | undefined): string[] {
  return [...(node?.dependsOn ?? node?.depends_on ?? [])].sort();
}

function requiredArtifactsFor(node: PromptGraphNode): string[] {
  const required = (node.outputs ?? []).map((output) => output.path);
  for (const artifact of required) {
    validateArtifactRelativePath(artifact);
  }
  return required;
}

function artifactOutputsFor(node: PromptGraphNode): PromptArtifactOutput[] {
  for (const output of node.outputs ?? []) {
    validateArtifactRelativePath(output.path);
  }
  return node.outputs ?? [];
}

function primaryArtifactFor(node: PromptGraphNode): string | undefined {
  const primary = node.outputs?.find((output) => output.primary)?.path;
  if (primary) {
    validateArtifactRelativePath(primary);
  }
  return primary;
}

function renderArtifactProducer(producer: ArtifactProducer, suffix: string | undefined, graph: GraphIndex): string {
  if (producer.kind === "current") {
    return path.join(graph.artifactDirsByLogicalId.get(graph.current.id)?.[0] ?? "", suffix ?? "");
  }

  const producerNode = graph.logicalNodes.get(producer.logicalId);
  if (!producerNode) {
    throw new PromptError("invalid-artifact-reference", `unknown artifact producer: ${producer.logicalId}`);
  }
  if (!graph.ancestorIds.has(producer.logicalId)) {
    throw new PromptError(
      "not-ancestor",
      `artifact producer \`${producer.logicalId}\` is not an ancestor of \`${graph.current.id}\``
    );
  }

  const dirs = graph.artifactDirsByLogicalId.get(producer.logicalId) ?? [];
  if (dirs.length === 0) {
    throw new PromptError(
      "invalid-artifact-reference",
      `artifact producer \`${producer.logicalId}\` has no concrete artifact directories`
    );
  }

  if (producer.kind === "handoff") {
    const primary = primaryArtifactFor(producerNode);
    if (!primary) {
      throw new PromptError(
        "invalid-artifact-reference",
        `artifact_handoff producer \`${producer.logicalId}\` does not declare a primary output`
      );
    }
    const required = requiredArtifactsFor(producerNode);
    if (!required.includes(primary)) {
      throw new PromptError(
        "invalid-artifact-reference",
        `primary output for \`${producer.logicalId}\` is not listed in outputs`
      );
    }
    const referenceExpectationOutputs = required.filter(
      (output) => output !== primary && /^references\/(?:expectations|reference-expectations)\.json$/u.test(output)
    );
    const handoffOutputs = [primary, ...referenceExpectationOutputs];
    return renderPathList(dirs.flatMap((dir) => handoffOutputs.map((output) => path.join(dir, output))));
  }

  return renderPathList(dirs.map((dir) => path.join(dir, suffix ?? "")));
}

function renderAncestorArtifacts(selector: "direct" | string[], graph: GraphIndex): string {
  const logicalIds = selector === "direct" ? graph.directDependencyIds : selector;
  if (logicalIds.length === 0) {
    throw new PromptError("invalid-artifact-reference", "ancestor_artifacts has no producers");
  }
  const paths: string[] = [];
  for (const logicalId of logicalIds) {
    const node = graph.logicalNodes.get(logicalId);
    if (!node) {
      throw new PromptError("invalid-artifact-reference", `unknown ancestor_artifacts producer: ${logicalId}`);
    }
    if (!graph.ancestorIds.has(logicalId)) {
      throw new PromptError(
        "not-ancestor",
        `ancestor_artifacts producer \`${logicalId}\` is not an ancestor of \`${graph.current.id}\``
      );
    }
    const required = requiredArtifactsFor(node);
    if (required.length === 0) {
      throw new PromptError(
        "invalid-artifact-reference",
        `ancestor_artifacts producer \`${logicalId}\` has no outputs`
      );
    }
    const dirs = graph.artifactDirsByLogicalId.get(logicalId) ?? [];
    for (const dir of dirs) {
      for (const artifact of required) {
        paths.push(path.join(dir, artifact));
      }
    }
  }
  return renderPathList(paths.sort());
}

function renderPathList(paths: string[]): string {
  if (paths.length === 1) {
    return paths[0]!;
  }
  return paths.map((artifactPath) => `- ${artifactPath}`).join("\n");
}

function referenceForProducer(producer: ArtifactProducer, suffix: string | undefined): PromptArtifactReference {
  if (producer.kind === "current") {
    return {
      kind: "artifact_path",
      ...(suffix ? { suffix } : {})
    };
  }
  if (producer.kind === "logical") {
    return {
      kind: "artifact_path",
      logicalId: producer.logicalId,
      ...(suffix ? { suffix } : {})
    };
  }
  return {
    kind: "artifact_handoff",
    logicalId: producer.logicalId
  };
}

function buildVariableContext(input: PromptRenderInput): Record<string, string> {
  return {
    repo_path: input.node.repoPath,
    workspace_path: input.node.workspacePath,
    schema_path: path.join(input.node.workspacePath, ".ultrafuzz", "schemas"),
    artifact_path: input.node.artifactDir,
    artifact_dir: input.node.artifactDir,
    run_metadata_path: input.run.metadataPath,
    output_findings_path: input.outputs.findingsPath,
    output_patch_path: input.outputs.patchPath,
    strategy: input.node.logicalId,
    attempt_index: String(input.node.attemptIndex ?? 0),
    strategy_loop_index: String(input.node.loopIndex ?? 0),
    strategy_loop_count: String(input.node.loopCount ?? 1),
    triage_quorum: String(input.resolvedConfig?.triage?.quorum ?? 1),
    triage_panel_size: String(input.resolvedConfig?.triage?.panelSize ?? 1),
    dynamic_strategies_enumerator: String(input.resolvedConfig?.dynamicStrategiesEnumerator ?? 1),
    invariant_property_priority_threshold: String(input.resolvedConfig?.invariantPropertyPriorityThreshold ?? ""),
    invariant_property_priority_filter: input.resolvedConfig?.invariantPropertyPriorityFilter ?? "",
    invariant_property_priorities: input.resolvedConfig?.invariantPropertyPriorities?.join(", ") ?? "",
    invariant_testing_smoke_timeout: String(input.resolvedConfig?.invariantTestingSmokeTimeout ?? ""),
    invariant_testing_fuzzer_timeout: String(input.resolvedConfig?.invariantTestingFuzzerTimeout ?? ""),
    strategy_attempt_test_dir: path.join(input.node.workspacePath, "test", "foundry", input.node.logicalId),
    vulnerability_database_path: input.resolvedConfig?.vulnerabilityDatabasePath ?? "unavailable",
    artifact_schema_dir: input.resolvedConfig?.artifactSchemaDir ?? "unavailable",
    ...Object.fromEntries(Object.entries(input.variables ?? {}).map(([key, value]) => [key, String(value)])),
    ...Object.fromEntries(Object.entries(input.dynamicVariables ?? {}).map(([key, value]) => [key, String(value)]))
  };
}

function validateRenderInputPaths(input: PromptRenderInput): void {
  const absolutePaths = [
    input.node.repoPath,
    input.node.workspacePath,
    input.node.artifactDir,
    input.run.artifactsDir,
    input.run.metadataPath,
    input.outputs.findingsPath,
    input.outputs.patchPath
  ];
  for (const absolutePath of absolutePaths) {
    if (!path.isAbsolute(absolutePath)) {
      throw new PromptError("invalid-render-input", `render path must be absolute: ${absolutePath}`);
    }
  }
  ensureInsidePath(input.run.artifactsDir, input.node.artifactDir, "node artifact directory");
  ensureInsidePath(input.node.artifactDir, input.outputs.findingsPath, "output findings path");
  ensureInsidePath(input.node.artifactDir, input.outputs.patchPath, "output patch path");
}

function validateVariableOverrides(variables: PromptRenderInput["variables"]): void {
  if (!variables) {
    return;
  }
  for (const [key, value] of Object.entries(variables)) {
    if (!isSupportedTemplateVariable(key)) {
      throw new PromptError("missing-template-variable", `unknown prompt render variable override: ${key}`);
    }
    if (key === "schema_path") {
      throw new PromptError("invalid-render-input", "schema_path is task-local and cannot be overridden");
    }
    if (!(
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )) {
      throw new PromptError("invalid-render-input", `invalid prompt render variable value for ${key}`);
    }
  }
}

function validateDynamicVariables(variables: PromptRenderInput["dynamicVariables"]): void {
  if (!variables) {
    return;
  }
  for (const [key, value] of Object.entries(variables)) {
    if (!isDynamicItemTemplateVariable(key)) {
      throw new PromptError("missing-template-variable", `invalid dynamic item template variable: ${key}`);
    }
    if (isSupportedTemplateVariable(key)) {
      throw new PromptError("invalid-render-input", `dynamic item variable cannot override built-in variable: ${key}`);
    }
    if (!(
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )) {
      throw new PromptError("invalid-render-input", `invalid dynamic item variable value for ${key}`);
    }
  }
}

function resolveDynamicVariable(
  name: string,
  variables: NonNullable<PromptRenderInput["dynamicVariables"]>,
  stack: string[] = []
): { value: string; variablesUsed: string[] } {
  if (stack.includes(name) || stack.length >= 16) {
    throw new PromptError("invalid-render-input", `cyclic or over-deep dynamic item template variable: ${name}`);
  }
  const candidate = variables[name];
  if (candidate === undefined) {
    throw new PromptError("missing-template-variable", `missing dynamic item template variable: ${name}`);
  }
  let value = String(candidate);
  const variablesUsed = [name];
  let rendered = "";
  let consumed = 0;
  for (const occurrence of findTemplateOccurrences(value)) {
    if (!isDynamicItemTemplateVariable(occurrence.name)) {
      throw new PromptError(
        "missing-template-variable",
        `dynamic item value ${name} references non-item variable: ${occurrence.name}`
      );
    }
    const nested = resolveDynamicVariable(occurrence.name, variables, [...stack, name]);
    rendered += value.slice(consumed, occurrence.start);
    rendered += nested.value;
    variablesUsed.push(...nested.variablesUsed);
    consumed = occurrence.end;
  }
  rendered += value.slice(consumed);
  value = rendered;
  return { value, variablesUsed };
}

function resolveModelProvenance(input: PromptRenderInput): PromptModelProvenance | undefined {
  const explicit = input.node.modelProvenance;
  const concrete = input.graph.concreteNodes?.find((node) => node.id === input.node.concreteId);
  const provenance: PromptModelProvenance = {};
  const modelProfileId =
    explicit?.modelProfileId ?? input.node.modelProfileId ?? concrete?.modelProfileId ?? concrete?.model_profile_id;
  const agentRef = explicit?.agentRef ?? input.node.agentRef ?? concrete?.agentRef ?? concrete?.agent_ref;
  const modelName =
    explicit?.modelName ?? input.node.modelName ?? concrete?.modelName ?? concrete?.model_name ?? concrete?.model;
  const modelIndex = explicit?.modelIndex ?? input.node.modelIndex ?? concrete?.modelIndex ?? concrete?.model_index;
  const loopIndex = explicit?.loopIndex ?? input.node.loopIndex ?? concrete?.loopIndex ?? concrete?.loop_index;
  const attemptIndex =
    explicit?.attemptIndex ?? input.node.attemptIndex ?? concrete?.attemptIndex ?? concrete?.attempt_index;

  if (modelProfileId !== undefined) {
    provenance.modelProfileId = modelProfileId;
  }
  if (agentRef !== undefined) {
    provenance.agentRef = agentRef;
  }
  if (modelName !== undefined) {
    provenance.modelName = modelName;
  }
  if (modelIndex !== undefined) {
    provenance.modelIndex = modelIndex;
  }
  if (loopIndex !== undefined) {
    provenance.loopIndex = loopIndex;
  }
  if (attemptIndex !== undefined) {
    provenance.attemptIndex = attemptIndex;
  }

  validateNonNegativeInteger(provenance.modelIndex, "modelIndex");
  validateNonNegativeInteger(provenance.loopIndex, "loopIndex");
  validateNonNegativeInteger(provenance.attemptIndex, "attemptIndex");
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

function validateNonNegativeInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new PromptError("invalid-render-input", `${field} must be a non-negative integer`);
  }
}

function ensureInsidePath(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new PromptError("invalid-render-input", `${label} must stay inside ${root}: ${candidate}`);
}

function renameTemplateVariableName(name: string, oldLogicalId: string, newLogicalId: string): string {
  if (name === `artifact_path:${oldLogicalId}`) {
    return `artifact_path:${newLogicalId}`;
  }
  if (name === `artifact_handoff:${oldLogicalId}`) {
    return `artifact_handoff:${newLogicalId}`;
  }
  const ancestorArtifacts = parseAncestorArtifactsSelector(name);
  if (Array.isArray(ancestorArtifacts)) {
    return `ancestor_artifacts:${ancestorArtifacts.map((id) => (id === oldLogicalId ? newLogicalId : id)).join(",")}`;
  }
  return name;
}

function rewriteArtifactPathSuffix(
  suffix: string,
  oldLogicalId: string,
  newLogicalId: string
): { value: string; consumed: number } {
  if (!suffix.startsWith("/")) {
    return { value: "", consumed: 0 };
  }
  const end = findSuffixEnd(suffix);
  const value = suffix
    .slice(0, end)
    .split("/")
    .map((segment) => rewriteArtifactPathSegment(segment, oldLogicalId, newLogicalId))
    .join("/");
  return { value, consumed: end };
}

function rewriteArtifactPathSegment(segment: string, oldLogicalId: string, newLogicalId: string): string {
  if (segment === oldLogicalId) {
    return newLogicalId;
  }
  if (segment.startsWith(`${oldLogicalId}-`)) {
    return `${newLogicalId}${segment.slice(oldLogicalId.length)}`;
  }
  const extensionIndex = segment.lastIndexOf(".");
  if (extensionIndex > 0 && segment.slice(0, extensionIndex) === oldLogicalId) {
    return `${newLogicalId}${segment.slice(extensionIndex)}`;
  }
  return segment;
}
