import { artifactContractDefinition, findingReportSemanticAssignment } from "@ultrafuzz/artifacts";
import { PromptError, extractPromptVariables, parsePromptFrontmatter } from "@ultrafuzz/prompts";
import type { PromptVariableReference } from "@ultrafuzz/prompts";
import { START_NODE_ID } from "./types.js";
import type { NormalizedProjectTopology, NormalizedTopologyNode } from "./types.js";
import { topologyError } from "./errors.js";
import { isSafeId } from "./path-utils.js";

export { extractPromptVariables };
export type { PromptVariableReference };

export interface ArtifactHandoffValidationOptions {
  promptTexts?: Record<string, string>;
}

const REPORT_VOCABULARY_CONTRACTS = new Set([
  "ultrafuzz/findings@2",
  "ultrafuzz/triaged-findings@1",
  "ultrafuzz/severity-classified-findings@1",
  "ultrafuzz/report@2"
]);

export function validateArtifactHandoffs(
  topology: NormalizedProjectTopology,
  options: ArtifactHandoffValidationOptions = {}
): void {
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  for (const node of topology.nodes) {
    if (node.kind !== "agentic") {
      continue;
    }
    const promptText = promptTextForNode(node, options.promptTexts);
    if (promptText === undefined) {
      continue;
    }
    const promptBody = promptBodyForNode(node, promptText);
    const variables = extractPromptVariablesForNode(node, promptBody);
    validateReportVocabularyVariables(node, promptBody, variables);
    for (const variable of variables) {
      validatePromptVariable(node, variable, nodeById);
    }
    validateOutputInstructions(node, promptBody, variables);
  }
}

function validateReportVocabularyVariables(
  node: NormalizedTopologyNode,
  promptText: string,
  variables: PromptVariableReference[]
): void {
  const publishesReportVocabulary = node.outputs.some((output) => REPORT_VOCABULARY_CONTRACTS.has(output.contract));
  if (!publishesReportVocabulary) return;
  for (const variable of ["finding_reachability_vocabulary", "finding_note_key_vocabulary"]) {
    if (!variables.some((reference) => reference.name === variable)) {
      throw topologyError(
        "MISSING_REPORT_VOCABULARY_REFERENCE",
        `Node \`${node.id}\` prompt must reference authoritative report vocabulary \`{{${variable}}}\``,
        { nodeId: node.id, variable }
      );
    }
  }
  const duplicated = findingReportSemanticAssignment(promptText);
  if (duplicated !== undefined) {
    throw topologyError(
      "DUPLICATED_REPORT_VOCABULARY",
      `Node \`${node.id}\` prompt duplicates unsupported report-bound key \`${duplicated.key}\`; use the authoritative rendered variables`,
      { nodeId: node.id, key: duplicated.key }
    );
  }
}

function promptBodyForNode(node: NormalizedTopologyNode, promptText: string): string {
  try {
    return parsePromptFrontmatter(promptText).body;
  } catch (error) {
    if (error instanceof PromptError) throw topologyErrorForPromptError(node, error);
    throw error;
  }
}

function validateOutputInstructions(
  node: NormalizedTopologyNode,
  promptText: string,
  variables: PromptVariableReference[]
): void {
  const promptPath = node.prompt ?? (node.group ? `${node.group}/${node.id}.md` : `${node.id}.md`);
  for (const output of node.outputs) {
    if (!needsExplicitValidEmptyDestination(node, output)) continue;
    if (promptReferencesCurrentOutput(node, promptText, variables, output.path, output.contract)) continue;
    throw topologyError(
      "MISSING_PROMPT_OUTPUT_INSTRUCTION",
      `Node \`${node.id}\` prompt \`${promptPath}\` must instruct the agent to write declared output \`${output.path}\`; contract \`${output.contract}\` accepts a valid-empty artifact, so omitting its destination would silently masquerade as an observed empty result`,
      { nodeId: node.id, promptPath, path: output.path, contract: output.contract }
    );
  }
}

function needsExplicitValidEmptyDestination(
  node: NormalizedTopologyNode,
  output: NormalizedTopologyNode["outputs"][number]
): boolean {
  // The runtime, rather than the agent, owns the canonical workspace patch
  // pair. Requiring its prompt to tell the model to write either member would
  // contradict the publication boundary that rejects agent-authored patches.
  if (
    output.path === "workspace.patch" &&
    output.contract === "ultrafuzz/text@1" &&
    node.outputs.some(
      (candidate) => candidate.path === "workspace-patch.json" && candidate.contract === "ultrafuzz/workspace-patch@1"
    )
  ) {
    return false;
  }
  return artifactContractDefinition(output.contract).validEmptyExample !== undefined;
}

function promptReferencesCurrentOutput(
  node: NormalizedTopologyNode,
  promptText: string,
  variables: PromptVariableReference[],
  outputPath: string,
  contract: string
): boolean {
  const expectedContentPattern = expectedOutputContentPattern(outputPath, contract);
  const findingsOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/findings@2");
  if (contract === "ultrafuzz/findings@2" && findingsOutputs.length === 1 && findingsOutputs[0]!.path === outputPath) {
    if (
      variables.some((variable) => variable.name === "output_findings_path") &&
      hasWriteInstruction(promptText, "output_findings_path", expectedContentPattern, true)
    ) {
      return true;
    }
  }
  const stageFindingsOutputs = node.outputs.filter((output) =>
    new Set(["ultrafuzz/findings@2", "ultrafuzz/triaged-findings@1", "ultrafuzz/severity-classified-findings@1"]).has(
      output.contract
    )
  );
  if (stageFindingsOutputs.length === 1 && stageFindingsOutputs[0]!.path === outputPath) {
    if (
      variables.some((variable) => variable.name === "output_stage_findings_path") &&
      hasWriteInstruction(promptText, "output_stage_findings_path", expectedContentPattern, true)
    ) {
      return true;
    }
  }
  const escapedPath = escapeRegExp(outputPath);
  const destinationBoundary = `(?=$|[\\s\\x60'"),;!\\]}]|\\.(?=$|[\\s\\x60'"),;!\\]}]))`;
  if (
    variables.some(
      (variable) => variable.name === "artifact_path" && variable.argument === undefined && variable.path === outputPath
    )
  ) {
    return hasAffirmativeWriteInstruction(
      promptText,
      `\\{\\{\\s*artifact_path\\s*\\}\\}/${escapedPath}${destinationBoundary}`,
      expectedContentPattern
    );
  }
  return hasAffirmativeWriteInstruction(
    promptText,
    `\\{\\{\\s*artifact_dir\\s*\\}\\}/${escapedPath}${destinationBoundary}`,
    expectedContentPattern
  );
}

function hasWriteInstruction(
  promptText: string,
  variable: string,
  expectedContentPattern: string,
  requireExplicitContent: boolean
): boolean {
  const token =
    `\\{\\{\\s*${escapeRegExp(variable)}\\s*\\}\\}` + `(?=$|[\\s\\x60'"),;!\\]}]|\\.(?=$|[\\s\\x60'"),;!\\]}]))`;
  return hasAffirmativeWriteInstruction(promptText, token, expectedContentPattern, requireExplicitContent);
}

function hasAffirmativeWriteInstruction(
  promptText: string,
  destinationPattern: string,
  expectedContentPattern: string,
  requireExplicitContent = false
): boolean {
  // Keep destination matching case-sensitive. Artifact paths are Linux paths,
  // and accepting a differently-cased spelling validates a prompt that writes
  // a different file. Language checks below remain case-insensitive.
  const destination = new RegExp(destinationPattern, "gmu");
  for (const occurrence of promptText.matchAll(destination)) {
    const destinationStart = occurrence.index;
    const destinationEnd = destinationStart + occurrence[0].length;
    if (hasNonRequiredDirectiveScope(promptText, destinationStart)) continue;
    if (hasTrailingCancellation(promptText, destinationEnd)) continue;

    const clause = directiveClauseBefore(promptText, destinationStart);
    if (hasDestinationFirstPassive(clause, promptText, destinationEnd, expectedContentPattern)) return true;

    const action = nearestOutputAction(clause, expectedContentPattern);
    if (action === undefined) continue;
    const beforeAction = clause.slice(0, action.index);
    if (
      hasNegatedAction(beforeAction) ||
      hasNonDirectiveActionPreamble(beforeAction) ||
      (hasConditionalPreamble(beforeAction) &&
        !hasMandatoryEmptyAlternative(promptText, destinationEnd, expectedContentPattern))
    ) {
      continue;
    }
    if (hasDescriptiveWrapper(beforeAction)) continue;

    const binding = clause.slice(action.index + action.text.length);
    if (hasExcludedDestinationBinding(binding)) continue;
    if (isPassiveOutputAction(action.text)) {
      if (!isMandatoryPassive(beforeAction)) continue;
      const subject = passiveSubject(beforeAction);
      if (!contentMatchesExpected(subject, promptText, destinationStart, expectedContentPattern)) continue;
    } else if (
      !hasActiveDestinationBinding(
        binding,
        promptText,
        destinationStart,
        destinationEnd,
        expectedContentPattern,
        requireExplicitContent
      )
    ) {
      continue;
    }
    if (hasConditionalSuffix(promptText, destinationEnd)) continue;
    return true;
  }
  return false;
}

const OUTPUT_ACTION_PATTERN =
  /\b(write|writing|emit|save|persist|produce|create|mirror|list|record|store|put|publish|serialize|output|deliver|submit|export|place|written|emitted|saved|persisted|produced|created|mirrored|listed|recorded|stored|published|serialized|delivered|submitted|exported|placed)\b/giu;
const PASSIVE_OUTPUT_ACTION_PATTERN =
  /^(?:written|emitted|saved|persisted|produced|created|mirrored|listed|recorded|stored|published|serialized|delivered|submitted|exported|placed)$/iu;
const EMPTY_OR_PLACEHOLDER_CONTENT_PATTERN =
  /(?:\b(?:placeholder|dummy|stub|sentinel)\b|\[\]|\{\}|\b(?:empty|blank)\s+(?:(?:json|findings?|generated[- ]tests?)\s+)?(?:array|list|object|file|artifact|manifest|bundle|findings?)\b|\bempty\s+findings?\b|\bzero[- ]findings?\b|\bzero[- ](?:entries|entry|items|item)\b|\bno\s+(?:entries|findings?)\b|\bfindings?\s+(?:containing|with)\s+no\s+entries\b)/iu;
const PROJECTED_CONTENT_PATTERN =
  /\b(?:number|count|total|checksum|digest|hash|metadata|summary|description|assessment)\s+(?:of\s+)?|\s+(?:number|count|total|checksum|digest|hash|metadata|summary|description|assessment)\b/iu;

interface OutputAction {
  index: number;
  text: string;
}

function expectedOutputContentPattern(outputPath: string, contract: string): string {
  if (
    new Set(["ultrafuzz/findings@2", "ultrafuzz/triaged-findings@1", "ultrafuzz/severity-classified-findings@1"]).has(
      contract
    )
  ) {
    return "findings?(?:\\.json)?";
  }
  const contractName = contract.slice(contract.indexOf("/") + 1, contract.lastIndexOf("@"));
  const filename = outputPath.split("/").at(-1) ?? outputPath;
  const basename = filename.replace(/\.[^.]+$/u, "");
  const phrases = new Set<string>();
  const words = new Set<string>();
  for (const name of [contractName, basename]) {
    const parts = name.split(/[-_.]+/u).filter((part) => part.length > 1);
    if (parts.length > 0) phrases.add(parts.map(escapeRegExp).join("[- _.]?"));
    for (const part of parts) {
      words.add(escapeRegExp(part));
      if (part.endsWith("ies")) words.add(`${escapeRegExp(part.slice(0, -3))}y`);
      else if (part.endsWith("s")) words.add(escapeRegExp(part.slice(0, -1)));
      else words.add(`${escapeRegExp(part)}s?`);
    }
  }
  return `(?:${[...phrases, ...words].join(
    "|"
  )}|artifacts?|outputs?|files?|documents?|records?|catalogs?|ledgers?|manifests?|bundles?|matri(?:x|ces)|plans?|summaries?|registr(?:y|ies)|json)`;
}

function directiveClauseBefore(promptText: string, destinationStart: number): string {
  const windowStart = Math.max(0, destinationStart - 512);
  const window = promptText.slice(windowStart, destinationStart);
  let boundary = 0;
  for (const match of window.matchAll(/[.!?](?=\s|$)|;|\r?\n\s*(?:[-*+>]|\d+\.)\s+/gu)) {
    if (match[0] === ";" && /\b(?:never|do\s+not|must\s+not|shall\s+not)\s*$/iu.test(window.slice(0, match.index))) {
      continue;
    }
    boundary = match.index + match[0].length;
  }
  return window.slice(boundary);
}

function nearestOutputAction(clause: string, expectedContentPattern: string): OutputAction | undefined {
  const actions: OutputAction[] = [];
  for (const match of clause.matchAll(OUTPUT_ACTION_PATTERN)) {
    actions.push({ index: match.index, text: match[1]! });
  }
  const nearest = actions.at(-1);
  const previous = actions.at(-2);
  if (
    previous !== undefined &&
    ((nearest?.text.toLocaleLowerCase("en-US") === "output" &&
      new RegExp(`\\b${expectedContentPattern}\\b\\s*$`, "iu").test(
        clause.slice(previous.index + previous.text.length, nearest.index)
      )) ||
      (/^(?:list|record|store|output)$/iu.test(nearest?.text ?? "") &&
        /\b(?:a|an|the|empty|blank|structured|normalized)\s*$/iu.test(
          clause.slice(previous.index + previous.text.length, nearest?.index)
        )))
  ) {
    return previous;
  }
  return nearest;
}

function isPassiveOutputAction(action: string): boolean {
  return PASSIVE_OUTPUT_ACTION_PATTERN.test(action);
}

function hasNegatedAction(beforeAction: string): boolean {
  const normalizedBeforeAction = beforeAction.replace(/[:;]\s*$/u, " ");
  if (
    /\b(?:do\s+not|never|must\s+not|shall\s+not|cannot)\s+(?:(?:fail|forget)\s+to|omit(?:\s+writing)?)\s*$/iu.test(
      normalizedBeforeAction
    )
  ) {
    return false;
  }
  return (
    /(?:\b(?:do\s+not(?:\s+ever)?|never|must\s+not|shall\s+not|should\s+not|cannot|(?:can|could|will|would|may|might|need)\s+not|avoid|skip|omit|fail(?:ed|ing)?\s+to|refuse\s+to|decline\s+to|under\s+no\s+circumstances|no\s+agent\s+should|need\s+not|there\s+is\s+no\s+need\s+to)\s*$|\b(?:don|doesn|can|won|mustn|shouldn|couldn|wouldn)['’]t\s*$)/iu.test(
      normalizedBeforeAction
    ) ||
    /\b(?:is|are)\s+(?:forbidden|prohibited|barred|not\s+(?:allowed|permitted|required))\s+to\s*$/iu.test(
      normalizedBeforeAction
    ) ||
    /\b(?:isn|aren)['’]t\s+(?:required|obliged|expected)\s+to\s*$/iu.test(normalizedBeforeAction)
  );
}

function hasConditionalPreamble(beforeAction: string): boolean {
  const value = beforeAction
    .replace(/^\s*(?:[-*+>]\s+|\d+\.\s+)?/u, "")
    .replace(/^(?:(?:always|also|finally|immediately|otherwise|please|then)\s*,?\s+)*/iu, "")
    .trim();
  if (
    /^(?:even\s+if|whether\s+or\s+not|whether\b[^,]{0,100}\bor\s+not|(?:regardless|irrespective)\s+of\s+whether|no\s+matter\s+whether|in\s+every\s+case|at\s+completion|without\s+fail)\b/iu.test(
      value
    )
  ) {
    return false;
  }
  if (
    /^(?:when|after|once)\b[^,]{0,100}\b(?:analysis|audit|task|work|strategy)\b[^,]{0,60}\bcomplete(?:d)?\b/iu.test(
      value
    )
  ) {
    return false;
  }
  if (/^(?:after\s+completing\s+(?:the\s+)?(?:analysis|audit|task|work)|once\s+complete)\b/iu.test(value)) {
    return false;
  }
  const conditionalLead =
    "(?:if|unless|only\\s+(?:if|when|after|as)|assuming|provided|whenever|wherever|where|when|once|" +
    "as\\s+(?:applicable|appropriate|needed|long\\s+as)|at\\s+(?:need|your\\s+discretion)|" +
    "on\\s+request|upon\\s+request|should|contingent\\s+on|subject\\s+to|depending\\s+(?:on|upon)|" +
    "in\\s+(?:case|the\\s+event)|to\\s+the\\s+extent)";
  return (
    new RegExp(`^${conditionalLead}\\b`, "iu").test(value) ||
    new RegExp(`(?:^|[,;]|\\band\\s*,?)\\s*${conditionalLead}\\b[^,;]*,?\\s*$`, "iu").test(value)
  );
}

function hasNonDirectiveActionPreamble(beforeAction: string): boolean {
  const value = beforeAction.replace(/[:;,]\s*$/u, "").trimEnd();
  return /(?:\b(?:may|might|can|could|would)(?:\s+(?:choose|decide|opt)\s+to)?|\b(?:attempt|attempted|attempting|plan|planned|planning|intend|intended|intending|try|tried|trying)(?:\s+to)?|\b(?:consider|considered|considering)|\b(?:feel\s+free|is\s+free|are\s+free|is\s+allowed|are\s+allowed|is\s+permitted|are\s+permitted)\s+to)$/iu.test(
    value
  );
}

function hasDescriptiveWrapper(beforeAction: string): boolean {
  return /\b(?:assessment|answer|decision|description|note|report|summary)\b[^.!?;]{0,160}\b(?:about|of|on|regarding|whether|if|explaining|stating)\b[^.!?;]*$/iu.test(
    beforeAction
  );
}

function hasMandatoryEmptyAlternative(
  promptText: string,
  destinationEnd: number,
  expectedContentPattern: string
): boolean {
  const following = promptText.slice(destinationEnd, Math.min(promptText.length, destinationEnd + 256));
  const alternative = following.match(/^\s*[`'"\])}]*[.!?]\s*(?:otherwise|else)\b([^.!?]{0,220})/iu)?.[1];
  if (alternative === undefined) return false;
  if (/\b(?:elsewhere|stdout|stderr|another|different)\b/iu.test(alternative)) return false;
  if (!/\b(?:use|write|create|produce|emit|save)\b/iu.test(alternative)) return false;
  if (!/(?:\bempty\b|\[\]|\{\}|\bzero[- ](?:findings?|entries|items)\b)/iu.test(alternative)) return false;
  return (
    new RegExp(`\\b${expectedContentPattern}\\b`, "iu").test(alternative) || /\bempty\s+form\b/iu.test(alternative)
  );
}

function hasExcludedDestinationBinding(binding: string): boolean {
  return /(?:\b(?:not\s+(?:to|at|in|into|under|as)|other\s+than|anything\s+but|anything\s+except)\b|\bto\s+[^,;]{0,100},\s*not\s*$)/iu.test(
    binding
  );
}

function hasActiveDestinationBinding(
  binding: string,
  promptText: string,
  destinationStart: number,
  destinationEnd: number,
  expectedContentPattern: string,
  requireExplicitContent: boolean
): boolean {
  const normalized = binding.replace(/,\s*if\s+any\s*,/giu, ",");
  if (
    /\b(?:parent\s+)?(?:directory|folder)\s+(?:for|at|containing)\s*$/iu.test(normalized.trimEnd()) ||
    /\b(?:summary|report|note|description|assessment|logs?|message|explanation|account)\b[^.!?]{0,100}\b(?:that|whether|if|mentioning|saying|stating|containing|including|citing|quoting|about|regarding|on)\b/iu.test(
      normalized
    )
  ) {
    return false;
  }
  const relationships = Array.from(normalized.matchAll(/\b(to|at|in|into|under|as)\b/giu));
  const relationship = relationships.at(-1);
  let directObject = normalized;
  if (relationship !== undefined) {
    if (/[\p{L}\p{N}]/u.test(normalized.slice(relationship.index + relationship[0].length))) return false;
    directObject = normalized.slice(0, relationship.index);
  } else if (/[\p{L}\p{N}]/u.test(normalized)) {
    return false;
  }
  directObject = directObject.replace(/^[\s,:;`()\u005b\u005d-]+|[\s,:;`()\u005b\u005d-]+$/gu, "");
  if (directObject === "") {
    const following = boundedFollowingClause(promptText, destinationEnd);
    const contained = following.match(/^\s*[`'"\])}]*(?:containing|with)\s+([^.!?;]{1,160})/iu)?.[1];
    if (contained !== undefined)
      return contentMatchesExpected(contained, promptText, destinationStart, expectedContentPattern);
    return !requireExplicitContent;
  }
  return contentMatchesExpected(directObject, promptText, destinationStart, expectedContentPattern);
}

function contentMatchesExpected(
  content: string,
  promptText: string,
  destinationStart: number,
  expectedContentPattern: string
): boolean {
  if (EMPTY_OR_PLACEHOLDER_CONTENT_PATTERN.test(content)) return false;
  if (/\b(?:anything|everything)\s+(?:but|except)\b/iu.test(content)) return false;
  const expected = new RegExp(`\\b${expectedContentPattern}\\b`, "iu");
  if (new RegExp(`\\b(?:not|except|excluding)\\s+(?:the\\s+)?${expectedContentPattern}\\b`, "iu").test(content)) {
    return false;
  }
  if (expected.test(content)) return !PROJECTED_CONTENT_PATTERN.test(content);
  if (
    /^(?:(?:the|all|any|required|declared|current|final|structured|normalized)\s+)*(?:(?:it|them|they|this|that|these|those)(?:\s+[\w-]+){0,4}|result|output)$/iu.test(
      content
    )
  ) {
    const antecedent = previousDirectiveContext(promptText, destinationStart, expectedContentPattern);
    return expected.test(antecedent) && !EMPTY_OR_PLACEHOLDER_CONTENT_PATTERN.test(antecedent);
  }
  return false;
}

function previousDirectiveContext(
  promptText: string,
  destinationStart: number,
  expectedContentPattern: string
): string {
  const window = promptText.slice(Math.max(0, destinationStart - 512), destinationStart);
  const segments = window
    .split(/[.!?](?=\s|$)|;/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const current = segments.at(-1) ?? "";
  const currentActions = Array.from(current.matchAll(OUTPUT_ACTION_PATTERN));
  const currentAction = currentActions.at(-1);
  const beforeCurrentAction = current.slice(0, currentAction?.index ?? current.length);
  if (new RegExp(`\\b${expectedContentPattern}\\b`, "iu").test(beforeCurrentAction)) return beforeCurrentAction;
  return segments.at(-2) ?? beforeCurrentAction;
}

function isMandatoryPassive(beforeAction: string): boolean {
  return /(?:\b(?:must|shall|should)\s+be|\b(?:is|are)\s+(?:(?:required|mandated)\s+)?to\s+be|\b(?:has|have|need|needs)\s+to\s+be|\bit\s+is\s+required\s+that\b[^.!?;]{0,120}\bbe|\bensure\b[^.!?;]{0,120}\b(?:is|are|be)|\bmake\s+sure\b[^.!?;]{0,120}\b(?:is|are|be))\s*$/iu.test(
    beforeAction
  );
}

function passiveSubject(beforeAction: string): string {
  const withoutModal = beforeAction.replace(
    /(?:\b(?:must|shall|should)\s+be|\b(?:is|are)\s+(?:(?:required|mandated)\s+)?to\s+be|\b(?:has|have|need|needs)\s+to\s+be|\bbe)\s*$/iu,
    ""
  );
  const introduced = withoutModal.replace(/^.*?\b(?:it\s+is\s+required\s+that|ensure|make\s+sure)\b/iu, "");
  return introduced.split(/\b(?:after|before|while|by|following|about|regarding|reviewing)\b/iu, 1)[0]!.trim();
}

function hasDestinationFirstPassive(
  clause: string,
  promptText: string,
  destinationEnd: number,
  expectedContentPattern: string
): boolean {
  if (/[\p{L}\p{N}]/u.test(clause)) return false;
  const following = boundedFollowingClause(promptText, destinationEnd).replace(/^\s*[`'"\])}]+/u, "");
  const passive = following.match(
    /^\s*(?:(?:must|shall|should)\s+be|(?:is|are)\s+(?:(?:required|mandated)\s+to\s+)?be)\s+(?:written|emitted|saved|persisted|produced|created|mirrored|listed|recorded|stored|published|serialized|output|delivered|submitted|exported|placed)\b([^.!?;]{0,200})/iu
  );
  if (passive === null) return false;
  const content = passive[1]!.match(/^\s*(?:with|containing|as)\s+(.+)$/iu)?.[1];
  return content !== undefined && contentMatchesExpected(content, promptText, destinationEnd, expectedContentPattern);
}

function boundedFollowingClause(promptText: string, destinationEnd: number): string {
  return promptText
    .slice(destinationEnd, Math.min(promptText.length, destinationEnd + 256))
    .split(/[.!?](?=\s|$)/u, 1)[0]!;
}

function hasConditionalSuffix(promptText: string, destinationEnd: number): boolean {
  const following = boundedFollowingClause(promptText, destinationEnd);
  const beforeSemicolon = following.split(";", 1)[0]!;
  if (/^\s*(?:even\s+if|whether\s+or\s+not|whether\b[^,;]{0,100}\bor\s+not)\b/iu.test(beforeSemicolon)) {
    return false;
  }
  return /^\s*(?:,\s*)?(?:if|unless|when|whenever|once\s+(?!complete\b)|only\s+(?:if|when|after|as)|as\s+(?:applicable|appropriate|needed|long\s+as)|at\s+(?:need|your\s+discretion)|where\s+(?:helpful|beneficial)|should\b|on\s+request|upon\s+request|assuming|provided|contingent\s+on|subject\s+to|depending\s+(?:on|upon)|in\s+(?:case|the\s+event)|to\s+the\s+extent|except\s+(?:if|when))\b/iu.test(
    beforeSemicolon
  );
}

function hasTrailingCancellation(promptText: string, destinationEnd: number): boolean {
  const following = promptText.slice(destinationEnd, Math.min(promptText.length, destinationEnd + 256));
  return (
    /^\s*(?:[.;,]\s*)?(?:(?:but|however|yet)\s*,?\s*)?(?:(?:this|that)(?:\s+output)?\s+is\s+optional|(?:the\s+output|publication)\s+is\s+optional|omit\s+when)\b/iu.test(
      following
    ) ||
    /^\s*(?:[.;]\s*)?(?:is|are)\s+(?:forbidden|prohibited|not\s+(?:allowed|permitted|required))\b/iu.test(following) ||
    /^\s*(?:[.;]\s*)?(?:(?:but|however|yet)\s*,?\s*)?(?:do\s+not|never|must\s+not|shall\s+not)\s+(?:actually\s+)?(?:create|write|save|persist|produce|emit|publish|deliver|submit|export)\s+(?:it|this|that|the\s+(?:file|artifact|output)|destination)\b/iu.test(
      following
    )
  );
}

function hasNonRequiredDirectiveScope(promptText: string, destinationStart: number): boolean {
  const lineStart = promptText.lastIndexOf("\n", destinationStart - 1) + 1;
  const currentLinePrefix = promptText.slice(lineStart, destinationStart);
  const inlineHeading = currentLinePrefix.match(/^\s*([^:\r\n]{1,120}):/u)?.[1];
  if (inlineHeading !== undefined) return isNonRequiredDirectiveHeading(inlineHeading, false);
  const startsListItem = /^\s*(?:[-*+>]|\d+\.)\s+/u.test(currentLinePrefix);
  const structuralStart = Math.max(0, lineStart - 2_048);
  const structuralPrefix = promptText.slice(structuralStart, lineStart);
  const block = structuralPrefix.split(/\r?\n\s*\r?\n/u).at(-1) ?? "";
  const lines = block.split(/\r?\n/u);
  const markdownHeading = [...structuralPrefix.matchAll(/^\s*#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gmu)].at(-1)?.[1];
  if (markdownHeading !== undefined && isNonRequiredDirectiveHeading(markdownHeading, true)) return true;
  const previousStructuralLine = structuralPrefix
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !/^\s*(?:[-*+>]|\d+\.)\s+/u.test(line))
    .at(-1)
    ?.trim();
  if (
    previousStructuralLine !== undefined &&
    /:\s*$/u.test(previousStructuralLine) &&
    isNonRequiredDirectiveHeading(previousStructuralLine, false)
  ) {
    return true;
  }
  const blockHeading = lines
    .filter((line) => /:\s*$/u.test(line.trim()) && !/^\s*(?:[-*+>]|\d+\.)\s+/u.test(line))
    .at(-1)
    ?.trim();
  if (blockHeading !== undefined && isNonRequiredDirectiveHeading(blockHeading, false)) return true;

  const structuralHeading = lines
    .filter((line) => line.trim() !== "" && !/^\s*(?:[-*+>]|\d+\.)\s+/u.test(line))
    .at(-1)
    ?.trim();
  if (structuralHeading === undefined) return false;
  if (!startsListItem && /[.!?]\s*$/u.test(structuralHeading)) return false;
  return isNonRequiredDirectiveHeading(structuralHeading, false);
}

function isNonRequiredDirectiveHeading(heading: string, markdown: boolean): boolean {
  const normalized = heading.replace(/:\s*$/u, "").trim();
  if (
    /(?:\bnot\s+optional\b|\bnon[- ]optional\b|\b(?:do\s+not|never|must\s+not|shall\s+not)\s+(?:fail(?:\s+to)?|forget(?:\s+to)?|omit|skip)\b|\b(?:required|mandatory)\b[^:\r\n]{0,80}\b(?:do\s+not|never)\s+(?:omit|skip|forget)\b|^without\s+fail$)/iu.test(
      normalized
    )
  ) {
    return false;
  }
  if (
    /^(?:optional|if\s+possible|suggestions?|recommendations?|potential\s+actions?|possible\s+output|for\s+reference\s+only|recommendation\s+output|suggested\s+output|recommended\s+output|example\s+output|nonessential\s+output|candidate\s+output|unnecessary\s+output)$/iu.test(
      normalized
    )
  ) {
    return true;
  }
  if (markdown) {
    return /^(?:never\s+do\s+this|do\s+not\s+(?:perform\s+)?(?:this|the\s+following)|avoid\s+(?:this|the\s+following)|skip\s+(?:this|the\s+following))$/iu.test(
      normalized
    );
  }
  return /(?:\b(?:advisory|avoid|banned|barred|candidate|cannot|decline|disallowed|discourage|discouraged|discretionary|elective|example|except|exclude|forbidden|illegal|ignore|ignored|illustrative|never|no|nonessential|not|omit|optional|optionally|prevent|prohibited|recommended|refuse|refrain|skip|suggested|unnecessary|unauthorized)\b|(?:aren|don|mayn|mustn|shouldn|can)['’]t|\bif\s+(?:needed|useful|possible)\b|\bwhen\s+(?:appropriate|convenient|useful)\b|\bas\s+needed\b|\bat\s+your\s+discretion\b)/iu.test(
    normalized
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function promptTextForNode(
  node: NormalizedTopologyNode,
  promptTexts: Record<string, string> | undefined
): string | undefined {
  if (!promptTexts) {
    return undefined;
  }
  const promptPath = node.prompt ?? (node.group ? `${node.group}/${node.id}.md` : `${node.id}.md`);
  return promptTexts[promptPath] ?? promptTexts[node.id];
}

function validatePromptVariable(
  node: NormalizedTopologyNode,
  variable: PromptVariableReference,
  nodeById: Map<string, NormalizedTopologyNode>
): void {
  if (variable.name === "artifact_path" && variable.argument !== undefined) {
    const referenced = requireSingleNodeId(node, variable);
    const producer = validateAncestorReference(node, referenced, nodeById);
    if (variable.path !== undefined && !producer.outputs.some((output) => output.path === variable.path)) {
      throw topologyError(
        "UNDECLARED_PROMPT_ARTIFACT_REFERENCE",
        `Prompt references undeclared output \`${variable.path}\` from node \`${referenced}\``,
        { nodeId: node.id, referenced, path: variable.path }
      );
    }
    return;
  }

  if (variable.name === "artifact_handoff") {
    const referenced = requireSingleNodeId(node, variable);
    const producer = validateAncestorReference(node, referenced, nodeById);
    if (!producer.outputs.some((output) => output.primary)) {
      throw topologyError(
        "MISSING_PROMPT_ARTIFACT_HANDOFF",
        `Node \`${referenced}\` does not declare a primary output for handoff`,
        { nodeId: node.id, referenced }
      );
    }
    return;
  }

  if (variable.name === "ancestor_artifacts") {
    const producers =
      variable.argument === undefined || variable.argument.trim().length === 0
        ? node.depends_on
        : variable.argument
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
    if (producers.length === 0) {
      throw topologyError("INVALID_PROMPT_ARTIFACT_REFERENCE", "ancestor_artifacts found no producer nodes", {
        nodeId: node.id,
        variable: variable.raw
      });
    }
    for (const producerId of producers) {
      if (!isSafeId(producerId)) {
        throw topologyError("INVALID_PROMPT_ARTIFACT_REFERENCE", `Invalid producer id \`${producerId}\``, {
          nodeId: node.id,
          referenced: producerId
        });
      }
      const producer = validateAncestorReference(node, producerId, nodeById);
      if (producer.outputs.length === 0) {
        throw topologyError(
          "INVALID_PROMPT_ARTIFACT_REFERENCE",
          `ancestor_artifacts producer \`${producerId}\` has no outputs`,
          { nodeId: node.id, referenced: producerId }
        );
      }
    }
    return;
  }

  if (variable.name === "ancestor_generated_test_manifests") {
    const producers = [...nodeById.values()].filter(
      (candidate) =>
        candidate.id !== node.id &&
        isAncestor(node, candidate.id, nodeById, new Set()) &&
        candidate.outputs.some((output) => output.contract === "ultrafuzz/generated-tests@3")
    );
    if (producers.length === 0) {
      throw topologyError(
        "INVALID_PROMPT_ARTIFACT_REFERENCE",
        "ancestor_generated_test_manifests found no ancestor outputs with contract `ultrafuzz/generated-tests@3`",
        { nodeId: node.id, variable: variable.raw }
      );
    }
  }
}

function extractPromptVariablesForNode(node: NormalizedTopologyNode, promptText: string): PromptVariableReference[] {
  try {
    return extractPromptVariables(promptText);
  } catch (error) {
    if (error instanceof PromptError) {
      throw topologyErrorForPromptError(node, error);
    }
    throw error;
  }
}

function topologyErrorForPromptError(node: NormalizedTopologyNode, error: PromptError): Error {
  const details = isRecord(error.details) ? error.details : {};
  const variable = typeof details.variable === "string" ? details.variable : undefined;
  if (error.code === "missing-template-variable") {
    return topologyError("UNKNOWN_PROMPT_VARIABLE", error.message, {
      nodeId: node.id,
      ...(variable ? { variable } : {}),
      reason: error.code
    });
  }
  return topologyError("INVALID_PROMPT_ARTIFACT_REFERENCE", error.message, {
    nodeId: node.id,
    ...(variable ? { variable } : {}),
    reason: error.code
  });
}

function requireSingleNodeId(node: NormalizedTopologyNode, variable: PromptVariableReference): string {
  const referenced = variable.argument?.trim();
  if (!referenced || referenced.includes(",")) {
    throw topologyError("INVALID_PROMPT_ARTIFACT_REFERENCE", `Invalid artifact variable \`${variable.raw}\``, {
      nodeId: node.id,
      variable: variable.raw
    });
  }
  if (!isSafeId(referenced) || referenced === START_NODE_ID) {
    throw topologyError("INVALID_PROMPT_ARTIFACT_REFERENCE", `Invalid producer id \`${referenced}\``, {
      nodeId: node.id,
      referenced
    });
  }
  return referenced;
}

function validateAncestorReference(
  node: NormalizedTopologyNode,
  referenced: string,
  nodeById: Map<string, NormalizedTopologyNode>
): NormalizedTopologyNode {
  const producer = nodeById.get(referenced);
  if (!producer) {
    throw topologyError(
      "UNKNOWN_PROMPT_ARTIFACT_REFERENCE",
      `Prompt references unknown topology node \`${referenced}\``,
      { nodeId: node.id, referenced }
    );
  }
  if (producer.id === node.id || !isAncestor(node, referenced, nodeById, new Set())) {
    throw topologyError(
      "NON_ANCESTOR_PROMPT_ARTIFACT_REFERENCE",
      `Prompt references non-ancestor topology node \`${referenced}\``,
      { nodeId: node.id, referenced }
    );
  }
  return producer;
}

function isAncestor(
  node: NormalizedTopologyNode,
  referenced: string,
  nodeById: Map<string, NormalizedTopologyNode>,
  visited: Set<string>
): boolean {
  for (const dependency of node.depends_on) {
    if (dependency === referenced) {
      return true;
    }
    if (visited.has(dependency)) {
      continue;
    }
    visited.add(dependency);
    const dependencyNode = nodeById.get(dependency);
    if (dependencyNode && isAncestor(dependencyNode, referenced, nodeById, visited)) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
