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
  const directiveText = directivePromptBody(promptText);
  for (const output of node.outputs) {
    if (!needsExplicitValidEmptyDestination(node, output)) continue;
    if (promptReferencesCurrentOutput(node, directiveText, variables, output.path, output.contract)) continue;
    throw topologyError(
      "MISSING_PROMPT_OUTPUT_INSTRUCTION",
      `Node \`${node.id}\` prompt \`${promptPath}\` must instruct the agent to write declared output \`${output.path}\`; contract \`${output.contract}\` accepts a valid-empty artifact, so omitting its destination would silently masquerade as an observed empty result`,
      { nodeId: node.id, promptPath, path: output.path, contract: output.contract }
    );
  }
}

/**
 * Remove Markdown regions that describe or quote commands instead of issuing
 * them. The replacement is byte-for-byte length preserving so destination
 * offsets still identify the same source line. A code span containing only a
 * rendered destination remains visible because backticks are the conventional
 * way prompts quote a path; a code span containing prose is never a directive.
 */
function directivePromptBody(promptText: string): string {
  const characters = promptText.split("");
  let inHtmlComment = false;
  let fence: { marker: string; size: number } | undefined;
  let inlineCode: { start: number; contentStart: number; size: number } | undefined;
  let listContentIndent: number | undefined;
  let offset = 0;
  for (const line of promptText.split(/(?<=\n)/u)) {
    const lineWithoutEnding = line.replace(/\r?\n$/u, "");
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(lineWithoutEnding);
    if (fence !== undefined) {
      inlineCode = undefined;
      maskPromptRange(characters, offset, offset + line.length);
      if (fenceMatch !== null && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.size) {
        fence = undefined;
      }
      offset += line.length;
      continue;
    }
    if (fenceMatch !== null) {
      inlineCode = undefined;
      fence = { marker: fenceMatch[1]![0]!, size: fenceMatch[1]!.length };
      maskPromptRange(characters, offset, offset + line.length);
      offset += line.length;
      continue;
    }
    const listMarker = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)/u.exec(lineWithoutEnding);
    if (listMarker !== null) {
      listContentIndent = markdownIndentWidth(listMarker[1]!);
    } else if (lineWithoutEnding.trim() !== "" && markdownIndentWidth(lineWithoutEnding) === 0) {
      listContentIndent = undefined;
    }
    const indent = markdownIndentWidth(lineWithoutEnding);
    if (
      listMarker === null &&
      /^(?: {4,}|\t)\S/u.test(lineWithoutEnding) &&
      (listContentIndent === undefined || indent >= listContentIndent + 4)
    ) {
      inlineCode = undefined;
      maskPromptRange(characters, offset, offset + line.length);
      offset += line.length;
      continue;
    }
    if (lineWithoutEnding.trim() === "") inlineCode = undefined;

    let index = 0;
    while (index < line.length) {
      const absolute = offset + index;
      if (inlineCode !== undefined) {
        if (line[index] !== "`") {
          index += 1;
          continue;
        }
        let tickCount = 1;
        while (line[index + tickCount] === "`") tickCount += 1;
        if (tickCount !== inlineCode.size) {
          index += tickCount;
          continue;
        }
        const spanEnd = absolute + tickCount;
        const content = promptText.slice(inlineCode.contentStart, absolute);
        if (isDestinationOnlyCodeSpan(content)) {
          maskPromptRange(characters, inlineCode.start, inlineCode.contentStart);
          maskPromptRange(characters, absolute, spanEnd);
        } else {
          maskPromptRange(characters, inlineCode.start, spanEnd);
        }
        inlineCode = undefined;
        index += tickCount;
        continue;
      }
      if (inHtmlComment) {
        const close = line.indexOf("-->", index);
        if (close === -1) {
          maskPromptRange(characters, absolute, offset + line.length);
          break;
        }
        maskPromptRange(characters, absolute, offset + close + 3);
        inHtmlComment = false;
        index = close + 3;
        continue;
      }
      if (line.startsWith("<!--", index)) {
        inHtmlComment = true;
        continue;
      }
      if (line[index] !== "`") {
        index += 1;
        continue;
      }
      let tickCount = 1;
      while (line[index + tickCount] === "`") tickCount += 1;
      inlineCode = { start: absolute, contentStart: absolute + tickCount, size: tickCount };
      index += tickCount;
    }
    offset += line.length;
  }
  // Image alternative text and HTML attributes are descriptive metadata, not
  // instructions rendered as prompt prose. Keep offsets stable while hiding
  // those regions from the directive recognizer.
  for (const region of promptText.matchAll(
    /<(code|pre|template|blockquote|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu
  )) {
    maskPromptRange(characters, region.index, region.index + region[0].length);
  }
  for (const image of promptText.matchAll(/!\[[^\]\r\n]*\]\([^)\r\n]*\)/gu)) {
    maskPromptRange(characters, image.index, image.index + image[0].length);
  }
  for (const tag of promptText.matchAll(/<[^>\r\n]*>/gu)) {
    maskPromptRange(characters, tag.index, tag.index + tag[0].length);
  }
  return characters.join("");
}

function markdownIndentWidth(line: string): number {
  let width = 0;
  for (const character of line) {
    if (character === " ") width += 1;
    else if (character === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

function maskPromptRange(characters: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
  }
}

function isDestinationOnlyCodeSpan(content: string): boolean {
  return /^\s*\{\{\s*(?:output_findings_path|output_stage_findings_path|artifact_path|artifact_dir)\s*\}\}(?:\/[A-Za-z0-9._/-]+)?[.,;:]?\s*$/u.test(
    content
  );
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
    if (isQuotedOrCodeLikeDirective(promptText, destinationStart, destinationEnd)) continue;
    if (hasNonRequiredDirectiveScope(promptText, destinationStart)) continue;
    if (hasTrailingCancellation(promptText, destinationEnd)) continue;

    const clause = directiveClauseBefore(promptText, destinationStart);
    if (
      hasDestinationFirstDirective(
        clause,
        promptText,
        destinationStart,
        destinationEnd,
        expectedContentPattern,
        requireExplicitContent
      )
    )
      return true;

    const action = nearestOutputAction(clause, expectedContentPattern);
    if (action === undefined) continue;
    const beforeAction = clause.slice(0, action.index);
    if (/\b(?:agent|worker|model|tool|system)\s+(?:will|would|could|can|may)\s+$/iu.test(beforeAction)) continue;
    if (
      action.text.toLocaleLowerCase("en-US") === "writing" &&
      !/\b(?:do\s+not|never)\s+(?:omit|skip|forget)\s+$/iu.test(beforeAction)
    )
      continue;
    if (
      hasNegatedAction(beforeAction) ||
      hasNonDirectiveActionPreamble(beforeAction) ||
      (hasConditionalPreamble(beforeAction) &&
        !(
          hasFindingsExistenceConditionalPreamble(beforeAction) &&
          hasMandatoryEmptyAlternative(promptText, destinationEnd, expectedContentPattern, destinationPattern)
        ))
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
    const followingClause = boundedFollowingClause(promptText, destinationEnd);
    const destinationClause = followingClause.split(";", 1)[0]!;
    const mandatoryEmptyFallback = hasMandatoryEmptyFallback(
      followingClause,
      expectedContentPattern,
      destinationPattern
    );
    if (
      (hasConditionalSuffix(promptText, destinationEnd) || hasNonMandatoryCondition(destinationClause)) &&
      !mandatoryEmptyFallback
    )
      continue;
    return true;
  }
  return false;
}

function hasMandatoryEmptyFallback(value: string, expectedContentPattern: string, destinationPattern: string): boolean {
  if (hasOptionalEmptyFallbackCancellation(value)) return false;
  const alternative = emptyAlternativeAfterExistenceCondition(value);
  if (alternative !== undefined) {
    return isMandatoryEmptyAlternative(alternative, expectedContentPattern, destinationPattern);
  }
  return (
    /\b(?:empty\s+(?:(?:findings?|json)\s+)?(?:array|form|list)|\[\])\b/iu.test(value) &&
    (/\b(?:if|when)\s+(?:there\s+(?:are|is)\s+)?(?:none|no\s+findings?|no\s+result)\b|\bif\s+none\s+exist/iu.test(
      value
    ) ||
      /\bif\s+(?:(?:any(?:\s+findings?)?|findings?)\s+)?exist\b[^;.!?]*[;.!?]\s*(?:otherwise|else)\b/iu.test(value)) &&
    !hasOptionalConditionOutsideEmptyFallback(value)
  );
}

function emptyAlternativeAfterExistenceCondition(value: string): string | undefined {
  return value.match(
    /^\s*(?:,\s*)?if\s+(?:(?:any(?:\s+findings?)?|findings?)\s+)?exist\b[^;.!?]*[;.!?]\s*(?:otherwise|else)\b([^;.!?]{0,220})/iu
  )?.[1];
}

function hasFindingsExistenceConditionalPreamble(value: string): boolean {
  const normalized = value
    .replace(/^\s*(?:[-*+>]\s+|\d+\.\s+)?/u, "")
    .replace(/^(?:(?:always|also|finally|immediately|otherwise|please|then)\s*,?\s+)*/iu, "")
    .trim();
  return /^(?:if|when)\s+(?:any\s+)?findings?\s+(?:exist|exists|are\s+(?:confirmed|found|present))\b[^,;]*,?\s*$/iu.test(
    normalized
  );
}

function hasOptionalConditionOutsideEmptyFallback(value: string): boolean {
  const withoutEmptyFallback = value
    .replace(
      /(?:,?\s*(?:or|otherwise|else|using)?\s*(?:use|write|create|produce|emit|save)?\s*(?:an?\s+)?(?:schema[- ]defined\s+)?empty\s+(?:(?:findings?|json)\s+)?(?:array|form|list)\s+(?:if|when)\s+(?:there\s+(?:are|is)\s+)?(?:none|no\s+findings?|no\s+result)(?:\s+exist)?)/giu,
      ""
    )
    .replace(
      /(?:,?\s*(?:if|when)\s+(?:there\s+(?:are|is)\s+)?(?:none|no\s+findings?|no\s+result)(?:\s+exist)?\s*,?\s*(?:use|write|create|produce|emit|save)\s+(?:an?\s+)?(?:schema[- ]defined\s+)?empty\s+(?:(?:findings?|json)\s+)?(?:array|form|list))/giu,
      ""
    );
  return hasNonMandatoryCondition(withoutEmptyFallback);
}

const OUTPUT_ACTION_PATTERN =
  /\b(write|writing|emit|save|persist|produce|create|generate|render|materialize|capture|mirror|list|record|store|put|use|publish|serialize|output|deliver|submit|export|place|copy|return|populate|append|document|file|send|written|emitted|saved|persisted|produced|created|mirrored|listed|recorded|stored|published|serialized|delivered|submitted|exported|placed|copied|returned|populated|appended|documented|filed|sent)\b/giu;
const PASSIVE_OUTPUT_ACTION_PATTERN =
  /^(?:written|emitted|saved|persisted|produced|created|mirrored|listed|recorded|stored|published|serialized|delivered|submitted|exported|placed|copied|returned|populated|appended|documented|filed|sent)$/iu;
const EMPTY_OR_PLACEHOLDER_CONTENT_PATTERN =
  /(?:\b(?:placeholder|dummy|stub|sentinel)\b|\[\]|\{\}|\b(?:empty|blank)\s+(?:(?:json|findings?|generated[- ]tests?)\s+)?(?:array|list|object|file|artifact|manifest|bundle|findings?)\b|\bempty\s+findings?\b|\bzero[- ]findings?\b|\bzero[- ](?:entries|entry|items|item)\b|\bno\s+(?:entries|findings?)\b|\bfindings?\s+(?:containing|with)\s+no\s+entries\b)/iu;
const PROJECTED_CONTENT_PATTERN =
  /\b(?:number|count|total|checksum|digest|hash|metadata|summary|description|assessment|documentation|guide|tutorial|example|quotation|quote|command|instruction|string|word|text|name|filename|path|reference|list|link|logs?)\s+(?:of\s+)?|\s+(?:number|count|total|checksum|digest|hash|metadata|summary|description|assessment|documentation|guide|tutorial|example|quotation|quote|command|instruction|string|word|text|name|filename|path|reference|list|link|logs?)\b/iu;

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
    return "(?:findings?(?:\\.json)?|bugs?|defects?|flaws?|issues?|vulnerabilit(?:y|ies))";
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
      if (part.endsWith("ed") && part.length > 4) words.add(`${escapeRegExp(part.slice(0, -2))}(?:ed|ation)`);
      if (part.endsWith("ies")) words.add(`${escapeRegExp(part.slice(0, -3))}y`);
      else if (part.endsWith("s")) words.add(escapeRegExp(part.slice(0, -1)));
      else words.add(`${escapeRegExp(part)}s?`);
    }
  }
  return `(?:${[...phrases, ...words].join("|")}|json)`;
}

function isQuotedOrCodeLikeDirective(promptText: string, destinationStart: number, destinationEnd: number): boolean {
  const lineStart = promptText.lastIndexOf("\n", destinationStart - 1) + 1;
  const lineEndCandidate = promptText.indexOf("\n", destinationEnd);
  const lineEnd = lineEndCandidate === -1 ? promptText.length : lineEndCandidate;
  const line = promptText.slice(lineStart, lineEnd);
  const destinationOffset = destinationStart - lineStart;
  if (/^\s*>/u.test(line)) return true;

  const before = line.slice(0, destinationOffset);
  const after = line.slice(destinationOffset + (destinationEnd - destinationStart));
  if (
    new RegExp(
      `\\b(?:phrase|quotation|quote|string|text|wording)\\b[^.!?;]{0,80}(?:"|“|‘)[^"”’]{0,120}${OUTPUT_ACTION_PATTERN.source}[^"”’]{0,120}(?:"|”|’)[^.!?;]{0,120}$`,
      "iu"
    ).test(before)
  ) {
    return true;
  }
  for (const [open, close] of [
    ['"', '"'],
    ["“", "”"],
    ["‘", "’"]
  ] as const) {
    const opening = before.lastIndexOf(open);
    if (opening === -1 || after.indexOf(close) === -1) continue;
    const quotedPrefix = before.slice(opening + open.length);
    if (new RegExp(OUTPUT_ACTION_PATTERN.source, "iu").test(quotedPrefix)) return true;
  }
  if (hasStraightSingleQuotedDirective(before, after)) return true;
  if (hasClosedQuotedDirectiveBefore(before)) return true;
  const contextStart = Math.max(0, destinationStart - 512);
  const contextBefore = promptText.slice(contextStart, destinationStart);
  const contextAfter = promptText.slice(destinationEnd, Math.min(promptText.length, destinationEnd + 256));
  for (const [open, close] of [
    ['"', '"'],
    ["“", "”"],
    ["‘", "’"]
  ] as const) {
    const opening = contextBefore.lastIndexOf(open);
    if (opening === -1 || contextAfter.indexOf(close) === -1) continue;
    if (new RegExp(OUTPUT_ACTION_PATTERN.source, "iu").test(contextBefore.slice(opening + open.length))) return true;
  }
  if (hasStraightSingleQuotedDirective(contextBefore, contextAfter)) return true;
  if (hasClosedQuotedDirectiveBefore(contextBefore)) return true;
  return false;
}

function hasClosedQuotedDirectiveBefore(value: string): boolean {
  const trimmed = value.trimEnd();
  for (const [open, close] of [
    ['"', '"'],
    ["“", "”"],
    ["‘", "’"]
  ] as const) {
    if (!trimmed.endsWith(close)) continue;
    const closing = trimmed.length - close.length;
    const opening = trimmed.lastIndexOf(open, closing - 1);
    if (opening === -1) continue;
    if (new RegExp(OUTPUT_ACTION_PATTERN.source, "iu").test(trimmed.slice(opening + open.length, closing))) {
      return true;
    }
  }
  return false;
}

function hasStraightSingleQuotedDirective(before: string, after: string): boolean {
  const openings = [...before.matchAll(/(?:^|[\s([{=:])'(?=[\p{L}\p{N}])/gmu)];
  const opening = openings.at(-1);
  const closing = /'(?=$|[\s.,;:!?)}\]])/mu.exec(after);
  if (opening === undefined || closing === null) return false;
  const start = opening.index + opening[0].length;
  return new RegExp(OUTPUT_ACTION_PATTERN.source, "iu").test(before.slice(start));
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
    if (
      match[1]!.toLocaleLowerCase("en-US") === "file" &&
      /\b(?:an?|the|output)\s*$/iu.test(clause.slice(0, match.index))
    ) {
      continue;
    }
    actions.push({ index: match.index, text: match[1]! });
  }
  const nearest = actions.at(-1);
  const previous = actions.at(-2);
  const betweenActions =
    previous === undefined || nearest === undefined
      ? ""
      : clause.slice(previous.index + previous.text.length, nearest.index);
  if (
    previous !== undefined &&
    ((nearest?.text.toLocaleLowerCase("en-US") === "output" &&
      (new RegExp(`\\b${expectedContentPattern}\\b\\s*$`, "iu").test(betweenActions) ||
        (!/[,;]\s*$|\b(?:and|then)\s*$/iu.test(betweenActions) && /[\p{L}\p{N}]/u.test(betweenActions)))) ||
      (/^(?:list|record|store|output)$/iu.test(nearest?.text ?? "") &&
        /\b(?:a|an|the|empty|blank|structured|normalized)\s*$/iu.test(betweenActions)))
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
  if (/^upon\s+(?!complet(?:e|ed|ing|ion)\b)/iu.test(value)) return true;
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
  const unwrapped = value.replace(/^\s*[([{]\s*|\s*[)\]}]\s*$/gu, "").trim();
  if (/^\s*[([]?\s*(?:optional|deprecated|obsolete)\s*[)\]]?\s*$/iu.test(value)) return true;
  if (/^\s*either\s*$/iu.test(value)) return true;
  if (/^\s*(?:as\s+an?\s+example|hypothetically|perhaps|ideally|optionally|possibly)\b/iu.test(unwrapped)) {
    return true;
  }
  if (/\b(?:agent|worker|model|tool|system)\s+(?:will|would|could|can|may)\s+[^.!?;]{0,80}$/iu.test(value)) return true;
  return (
    /(?:\b(?:is|are)\s+(?:merely\s+)?(?:optional|unnecessary|not\s+mandatory)\s+to|\b(?:has|have)\s+(?:the\s+)?option\s+to|\b(?:do|does)\s+not\s+have\s+to|\bneedn['’]t|\b(?:is|are)\s+under\s+no\s+obligation\s+to|\bthere\s+is\s+no\s+requirement\s+to|\ban?\s+optional\s+step\s+is\s+to)\s*$/iu.test(
      value
    ) ||
    /(?:\b(?:may|might|can|could|would)(?:\s+(?:choose|decide|opt)\s+to)?|\b(?:attempt|attempted|attempting|plan|planned|planning|intend|intended|intending|try|tried|trying)(?:\s+to)?|\b(?:consider|considered|considering)|\b(?:feel\s+free|is\s+free|are\s+free|is\s+allowed|are\s+allowed|is\s+permitted|are\s+permitted)\s+to)$/iu.test(
      value
    ) ||
    /(?:\b(?:may|might|can|could|would)\b[^.!?;]{0,80}\bto|\bit\s+(?:is|would\s+be)\s+(?:possible|advisable|recommended|useful|helpful)\s+to|\b(?:we|i)\s+(?:recommend|suggest)\s+(?:that\s+)?(?:you\s+)?[^.!?;]{0,80}|\b(?:perhaps|ideally|optionally|possibly)\s+[^.!?;]{0,80}|\b(?:agent|worker|model|tool|system)\s+(?:will|would|could|can|may)\s+)$/iu.test(
      value
    ) ||
    /\b(?:previous(?:ly)?|historically|earlier|formerly|used\s+to|the\s+(?:old|legacy|previous|prior|earlier)\s+(?:agent|worker|prompt|version)|(?:old|legacy|previous|prior|earlier)\s+instructions?|was\s+(?:asked|required|expected|supposed)\s+to|had\s+to|deprecated|obsolete)\b[^.!?;]{0,180}$/iu.test(
      value
    )
  );
}

function hasDescriptiveWrapper(beforeAction: string): boolean {
  return (
    /^\s*(?:an?\s+)?(?:example|illustrative)\s+(?:command|instruction|output|prompt|text)\b[^.!?;]*$/iu.test(
      beforeAction
    ) ||
    /\b(?:prompt|instruction|command)\s+text\s+(?:is|was)\s*:\s*$/iu.test(beforeAction) ||
    /\b(?:here|this)\s+(?:is|shows?)\s+how\s+to\b[^.!?;]*$/iu.test(beforeAction) ||
    /\b(?:analysis|assessment|answer|decision|description|explanation|note|report|summary|tutorial|example|quotation|quote|command|instruction)\b[^.!?;]{0,180}\b(?:about|of|on|regarding|whether|if|how|why|explaining|stating|showing|that|to)\b[^.!?;]*$/iu.test(
      beforeAction
    ) ||
    /\b(?:assess|decide|determine|describe|explain|mention|quote|recall|say|show|state|summarize|tell)\b[^.!?;]{0,180}\b(?:how|why|whether|if|that|to)\b[^.!?;]*$/iu.test(
      beforeAction
    ) ||
    /\b(?:docs?|documentation|prompt|example|text|message|instructions?)\b[^.!?;]{0,120}\b(?:says?|said|states?|stated|reads?|shows?|instructs?|requires?|required)\b[^.!?;]*$/iu.test(
      beforeAction
    ) ||
    /(?:\bfor\s+(?:documentation|reference|illustration|an?\s+example)|^\s*to\s+(?:describe|document|explain|illustrate|show|demonstrate)\b)[^.!?;]*$/iu.test(
      beforeAction
    ) ||
    /\b(?:for\s+example|e\.g\.|such\s+as)\b[^.!?;]*$/iu.test(beforeAction)
  );
}

function hasMandatoryEmptyAlternative(
  promptText: string,
  destinationEnd: number,
  expectedContentPattern: string,
  destinationPattern: string
): boolean {
  const following = promptText.slice(destinationEnd, Math.min(promptText.length, destinationEnd + 256));
  const match = /^\s*[`'"\])}]*[.!?;]\s*(?:otherwise|else)\b([^.!?;]{0,220})/iu.exec(following);
  if (match === null || !isMandatoryEmptyAlternative(match[1]!, expectedContentPattern, destinationPattern)) {
    return false;
  }
  return !hasOptionalEmptyFallbackCancellation(following.slice(match[0].length));
}

function hasOptionalEmptyFallbackCancellation(value: string): boolean {
  return (
    /\b(?:this|that|the)\s+(?:(?:empty|no[- ]result)\s+)?fallback\s+(?:is|remains?)\s+(?:optional|discretionary|not\s+required)\b/iu.test(
      value
    ) ||
    /\b(?:you\s+)?may\s+(?:omit|skip|ignore)\s+(?:this|that|the)\s+(?:(?:empty|no[- ]result)\s+)?fallback\b/iu.test(
      value
    )
  );
}

function isMandatoryEmptyAlternative(
  alternative: string,
  expectedContentPattern: string,
  destinationPattern: string
): boolean {
  if (/\b(?:elsewhere|stdout|stderr|another|different)\b/iu.test(alternative)) return false;
  if (!/\b(?:use|write|create|produce|emit|save)\b/iu.test(alternative)) return false;
  if (!/(?:\bempty\b|\[\]|\{\}|\bzero[- ](?:findings?|entries|items)\b)/iu.test(alternative)) return false;
  if (hasNonMandatoryCondition(alternative)) return false;
  const action = nearestOutputAction(alternative, expectedContentPattern);
  if (
    action === undefined ||
    hasNegatedAction(alternative.slice(0, action.index)) ||
    hasNonDirectiveActionPreamble(alternative.slice(0, action.index))
  )
    return false;
  if (
    !new RegExp(`\\b${expectedContentPattern}\\b`, "iu").test(alternative) &&
    !/\bempty\s+form\b/iu.test(alternative)
  ) {
    return false;
  }
  return emptyAlternativeTargetsDestination(alternative, destinationPattern);
}

function emptyAlternativeTargetsDestination(alternative: string, destinationPattern: string): boolean {
  const destination = new RegExp(destinationPattern, "mu").exec(alternative);
  if (destination !== null) {
    if (hasExcludedDestinationBinding(alternative.slice(0, destination.index))) return false;
    const withoutDestination =
      alternative.slice(0, destination.index) + alternative.slice(destination.index + destination[0].length);
    return !/\{\{[^{}]+\}\}/u.test(withoutDestination);
  }
  if (/\{\{[^{}]+\}\}/u.test(alternative)) return false;
  return (
    /\bthere\b(?!\s+(?:are|is|was|were)\b)/iu.test(alternative) ||
    /\b(?:same|declared|required)\s+(?:destination|output|artifact|file|path)\b/iu.test(alternative)
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
  const normalized = binding
    .replace(/,\s*if\s+any\s*,/giu, ",")
    .replace(
      /,\s*or\s+(?:an?\s+)?(?:schema[- ]defined\s+)?empty\s+(?:findings?\s+)?(?:array|form|list)\s+if\s+(?:there\s+(?:are|is)\s+)?(?:none|no\s+findings?)\s*,?(?=\s*\b(?:to|at|in|into|under|as)\b)/giu,
      ""
    );
  if (
    /\b(?:if|unless|when|whenever|wherever|only\s+(?:if|when|after)|assuming|provided|should|as\s+(?:appropriate|applicable|needed))\b/iu.test(
      normalized
    )
  ) {
    return false;
  }
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
    const requiredRole = following.match(
      /^\s*[`'"\])}]*(?:as|for)\s+(?:the\s+)?required\s+([^.!?;]{1,160}?)(?:\s+(?:output|artifact|file))?\s*[.!?;]?\s*$/iu
    )?.[1];
    if (requiredRole !== undefined) {
      return new RegExp(`\\b${expectedContentPattern}\\b`, "iu").test(requiredRole);
    }
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

function hasDestinationFirstDirective(
  clause: string,
  promptText: string,
  destinationStart: number,
  destinationEnd: number,
  expectedContentPattern: string,
  requireExplicitContent: boolean
): boolean {
  const prefix = clause.replace(/^\s*(?:[-*+] |\d+\. )/u, "").trim();
  if (
    hasConditionalPreamble(prefix) ||
    hasNonDirectiveActionPreamble(prefix) ||
    hasDescriptiveWrapper(prefix) ||
    /\b(?:do\s+not|never|must\s+not|shall\s+not|should\s+not|avoid|skip|omit|optional|optionally)\b/iu.test(prefix)
  ) {
    return false;
  }
  const allowedPrefix =
    /^(?:(?:always|also|finally|immediately|otherwise|please|then)\s*,?\s+)*(?:(?:ensure|make\s+sure)(?:\s+that)?|(?:in|at|into|to)|(?:place|store|put|return|append|populate|copy|document)(?:\s+(?:in|at|into|to|via))?|the\s+(?:declared\s+)?(?:destination|output|artifact|file)(?:\s+(?:at|in))?)?$/iu;
  if (!allowedPrefix.test(prefix)) return false;
  const following = boundedFollowingClause(promptText, destinationEnd).replace(/^\s*[`'"\])}]+/u, "");
  const requiredDestination = following.match(
    /^\s*(?:is|must\s+be)\s+(?:the\s+)?required\s+(?:destination|output|artifact|file)\s+(?:for|containing|with)\s+([^.!?;]{1,160})/iu
  );
  if (requiredDestination !== null) {
    return contentMatchesExpected(requiredDestination[1]!, promptText, destinationStart, expectedContentPattern);
  }
  const passive = following.match(
    /^\s*(?:(?:must|shall|should)\s+be|(?:is|are)\s+(?:(?:required|mandated)\s+to\s+)?be)\s+(?:written|emitted|saved|persisted|produced|created|mirrored|listed|recorded|stored|published|serialized|output|delivered|submitted|exported|placed|copied|returned|populated|appended|documented)\b([^.!?;]{0,200})/iu
  );
  if (passive !== null) {
    const content = passive[1]!.match(/^\s*(?:with|containing|as)\s+(.+)$/iu)?.[1];
    return (
      content !== undefined &&
      !hasNonMandatoryCondition(content) &&
      contentMatchesExpected(content, promptText, destinationStart, expectedContentPattern)
    );
  }

  const contains = following.match(
    /^\s*(?:(?:must|shall|should|needs?\s+to|is\s+required\s+to)\s+)?(?:contain|contains|include|includes|hold|holds)\s+([^.!?;]{1,200})/iu
  );
  if (contains !== null && /^(?:ensure|make\s+sure|the\s+)/iu.test(prefix)) {
    return (
      !hasNonMandatoryCondition(contains[1]!) &&
      contentMatchesExpected(contains[1]!, promptText, destinationStart, expectedContentPattern)
    );
  }

  const destinationFirstAction = following.match(
    /^\s*[,]?\s*(?:must\s+|shall\s+|should\s+)?(?:write|emit|save|persist|produce|create|mirror|list|record|store|put|publish|serialize|output|deliver|submit|export|place|copy|return|populate|append|document)\s+([^.!?;]{1,200})/iu
  );
  if (destinationFirstAction !== null && /^(?:in|at|into|to)$/iu.test(prefix)) {
    return (
      !hasNonMandatoryCondition(destinationFirstAction[1]!) &&
      contentMatchesExpected(destinationFirstAction[1]!, promptText, destinationStart, expectedContentPattern)
    );
  }

  if (/\b(?:place|store|put|return|append|populate|copy|document)\b/iu.test(prefix)) {
    const content = following.replace(/^\s*[,]?\s*/u, "");
    return (
      content !== "" &&
      !hasNonMandatoryCondition(content) &&
      contentMatchesExpected(content, promptText, destinationStart, expectedContentPattern)
    );
  }
  return (
    !requireExplicitContent &&
    /^(?:ensure|make\s+sure)$/iu.test(prefix) &&
    /^\s*(?:exists|is\s+created)\b/iu.test(following)
  );
}

function hasNonMandatoryCondition(value: string): boolean {
  const normalized = value.replace(/\b(?:even\s+if|whether\s+or\s+not|regardless\s+of\s+whether)\b[^,;]*/giu, "");
  return /\b(?:if|unless|only\s+(?:if|when|after)|when\s+(?!the\s+(?:analysis|audit|task|work)\s+is\s+complete)|whenever|wherever|assuming|provided|should\s+you|as\s+(?:needed|appropriate|applicable)|at\s+your\s+discretion|on\s+request)\b/iu.test(
    normalized
  );
}

function boundedFollowingClause(promptText: string, destinationEnd: number): string {
  return promptText
    .slice(destinationEnd, Math.min(promptText.length, destinationEnd + 256))
    .split(/\r?\n\s*\r?\n|[.!?](?=\s|$)/u, 1)[0]!;
}

function hasConditionalSuffix(promptText: string, destinationEnd: number): boolean {
  const following = boundedFollowingClause(promptText, destinationEnd);
  const beforeSemicolon = following.split(";", 1)[0]!;
  if (/^\s*(?:even\s+if|whether\s+or\s+not|whether\b[^,;]{0,100}\bor\s+not)\b/iu.test(beforeSemicolon)) {
    return false;
  }
  if (/^\s*only\s*[.!?]?\s*$/iu.test(beforeSemicolon)) return false;
  return /^\s*(?:,\s*)?(?:if|unless|when|whenever|once\s+(?!complete\b)|after\s+(?!complet(?:e|ed|ing|ion)\b)|only\s+(?:if|when|after|as)|as\s+(?:applicable|appropriate|needed|long\s+as|an?\s+example)|for\s+example|at\s+(?:need|your\s+discretion)|where\s+(?:helpful|beneficial)|should\b|on\s+request|upon\s+(?!complet(?:e|ed|ing|ion)\b)|assuming|provided|contingent\s+on|subject\s+to|depending\s+(?:on|upon)|in\s+(?:case|the\s+event)|to\s+the\s+extent|except\s+(?:if|when))\b/iu.test(
    beforeSemicolon
  );
}

function hasTrailingCancellation(promptText: string, destinationEnd: number): boolean {
  const following = promptText.slice(destinationEnd, Math.min(promptText.length, destinationEnd + 512));
  return (
    /^\s*(?:[.;,]\s*)?(?:\(\s*)?(?:or|alternatively)\s+(?:(?:write|emit|save|persist|publish|send|deliver)\b[^.!?;]{0,100}\b(?:elsewhere|stdout|stderr|another|different)\b|(?:to\s+)?(?:elsewhere|stdout|stderr|another\s+(?:file|path|destination)|a\s+different\s+(?:file|path|destination))\b|(?:skip|omit|ignore)\s+(?:it|this|that|the\s+(?:file|artifact|output|instruction))\b)/iu.test(
      following
    ) ||
    /^\s*(?:[.;,]\s*)?(?:(?:instead|actually|rather)\s*,?\s*)?(?:do\s+not|never|must\s+not|shall\s+not)\s+(?:actually\s+)?(?:create|write|save|persist|produce|emit|publish|deliver|submit|export)\s+(?:it|this|that|the\s+(?:file|artifact|output)|destination)\b/iu.test(
      following
    ) ||
    /^\s*(?:[.;,]\s*)?(?:instead|actually|rather)\s*,?\s*(?:write|emit|save|persist|publish|send|deliver)\b[^.!?;]{0,120}\b(?:elsewhere|stdout|stderr|another|different)\b/iu.test(
      following
    ) ||
    /^\s*(?:[.;,]\s*)?(?:cancel|disregard|ignore|revoke|withdraw)\s+(?:that|this|the\s+(?:previous|prior|preceding)?)\s*(?:instruction|directive|step)\b/iu.test(
      following
    ) ||
    /^\s*(?:[.;,]\s*)?(?:[-—–]\s*)?(?:\(\s*)?(?:this\s+(?:step|instruction|output)\s+is\s+)?optional(?:ly)?(?:\s*\))?(?=\s|[.!?;]|$)/iu.test(
      following
    ) ||
    /^\s*(?:[.;,]\s*)?(?:(?:but|however|yet)\s*,?\s*)?(?:you\s+)?may\s+omit\s+(?:it|this|that|the\s+(?:step|instruction|file|artifact|output))\b/iu.test(
      following
    ) ||
    /^\s*(?:[.;]\s*)?(?:you\s+)?do\s+not\s+have\s+to\s+do\s+so\b/iu.test(following) ||
    /^\s*(?:[.;]\s*)?(?:do\s+not|never)\s+follow\s+(?:this|that|the)\s+instruction\b/iu.test(following) ||
    /^\s*(?:[.;,]\s*)?(?:(?:but|however|yet)\s*,?\s*)?(?:(?:this|that)(?:\s+output)?\s+is\s+optional|(?:the\s+output|publication)\s+is\s+optional|omit\s+when)\b/iu.test(
      following
    ) ||
    /^\s*(?:[.;]\s*)?(?:is|are)\s+(?:forbidden|prohibited|not\s+(?:allowed|permitted|required))\b/iu.test(following) ||
    /^\s*(?:[.;,]\s*)?(?:(?:which|and\s+this|but\s+this)\s+)?(?:is|are)\s+(?:optional|discretionary|not\s+required)\b/iu.test(
      following
    ) ||
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
  if (hasInheritedNonRequiredDirectiveScope(promptText, destinationStart)) return true;
  const startsListItem = /^\s*(?:[-*+>]|\d+\.)\s+/u.test(currentLinePrefix);
  const structuralStart = Math.max(0, lineStart - 2_048);
  const structuralPrefix = promptText.slice(structuralStart, lineStart);
  const block = structuralPrefix.split(/\r?\n\s*\r?\n/u).at(-1) ?? "";
  const lines = block.split(/\r?\n/u);
  const previousLine =
    structuralPrefix
      .replace(/\r?\n$/u, "")
      .split(/\r?\n/u)
      .at(-1) ?? "";
  if (!startsListItem) {
    const quotedHeading = /^\s*>\s*(.+?:)\s*$/u.exec(previousLine)?.[1];
    if (quotedHeading !== undefined && isNonRequiredDirectiveHeading(quotedHeading, true)) return true;
    const listHeading = /^(\s*(?:[-*+]|\d+[.)])\s+)(.+?:)\s*$/u.exec(previousLine);
    if (
      listHeading !== null &&
      markdownIndentWidth(currentLinePrefix) >=
        markdownIndentWidth(listHeading[1]!) + listHeading[1]!.trimStart().length &&
      isNonRequiredDirectiveHeading(listHeading[2]!, true)
    ) {
      return true;
    }
  }
  const markdownHeading = [...structuralPrefix.matchAll(/^\s*#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gmu)].at(-1)?.[1];
  if (markdownHeading !== undefined && isNonRequiredDirectiveHeading(markdownHeading, true)) return true;
  const previousStructuralLine = structuralPrefix
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !/^\s*(?:[-*+>]|\d+\.)\s+/u.test(line))
    .at(-1)
    ?.trim();
  if (
    !startsListItem &&
    previousStructuralLine !== undefined &&
    /^(?:examples?|deprecated|obsolete|historical(?:\s+(?:examples?|instructions?|output))?)\s*:?$/iu.test(
      previousStructuralLine
    )
  ) {
    return true;
  }
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

function hasInheritedNonRequiredDirectiveScope(promptText: string, destinationStart: number): boolean {
  const prefix = promptText.slice(Math.max(0, destinationStart - 2_048), destinationStart);
  const completedLines = prefix.split(/\r?\n/u).slice(0, -1);
  let plainNonRequired = false;
  const markdownScopes: Array<{ level: number; nonRequired: boolean }> = [];

  for (const sourceLine of completedLines) {
    const line = sourceLine.trim();
    if (line === "") continue;
    const markdown = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/u.exec(line);
    if (markdown !== null) {
      const level = markdown[1]!.length;
      while ((markdownScopes.at(-1)?.level ?? 0) >= level) markdownScopes.pop();
      const heading = markdown[2]!;
      if (isRequiredDirectiveHeading(heading)) {
        plainNonRequired = false;
        markdownScopes.length = 0;
        markdownScopes.push({ level, nonRequired: false });
      } else {
        markdownScopes.push({ level, nonRequired: isNonRequiredDirectiveHeading(heading, true) });
      }
      continue;
    }

    if (isRequiredDirectiveHeading(line)) {
      plainNonRequired = false;
      markdownScopes.length = 0;
      continue;
    }
    const normalized = line.replace(/[.:!?]\s*$/u, "").trim();
    if (
      /^(?:optional(?:\s+output)?|example(?:\s+output)?|if\s+(?:any\s+)?findings?\s+(?:exist|exists)|do\s+not\s+(?:perform|do)(?:\s+(?:this|the\s+following))?)$/iu.test(
        normalized
      )
    ) {
      plainNonRequired = true;
    }
  }
  return plainNonRequired || markdownScopes.some((scope) => scope.nonRequired);
}

function isRequiredDirectiveHeading(heading: string): boolean {
  const normalized = heading
    .replace(/^#{1,6}\s+/u, "")
    .replace(/[:.!?]\s*$/u, "")
    .trim();
  return /^(?:required|mandatory)(?:\s+(?:output|outputs|deliverable|deliverables|artifact|artifacts|action|actions|step|steps))?(?:\s*\([^)]*do\s+not\s+omit[^)]*\))?$|^(?:not\s+optional|non[- ]optional|without\s+fail|no\s+omissions?)$/iu.test(
    normalized
  );
}

function isNonRequiredDirectiveHeading(heading: string, markdown: boolean): boolean {
  const normalized = heading.replace(/[:.!?]\s*$/u, "").trim();
  if (
    /(?:\bnot\s+optional\b|\bnon[- ]optional\b|\b(?:do\s+not|never|must\s+not|shall\s+not)\s+(?:fail(?:\s+to)?|forget(?:\s+to)?|omit|skip)\b|\b(?:required|mandatory)\b[^:\r\n]{0,80}\b(?:do\s+not|never)\s+(?:omit|skip|forget)\b|^without\s+fail$|^no\s+omissions?$|^no[- ]findings?\s+finalization$|^output\s+with\s+no\s+findings?$|^mandatory\s+no[- ]result\s+behaviou?r$)/iu.test(
      normalized
    )
  ) {
    return false;
  }
  if (
    /^(?:optional|deprecated|obsolete|if\s+possible|suggestions?|recommendations?|examples?|illustrations?|quoted?\s+(?:example|instruction|text)|potential\s+actions?|possible\s+output|for\s+reference\s+only|recommendation\s+output|suggested\s+output|recommended\s+output|example\s+output|nonessential\s+output|candidate\s+output|unnecessary\s+output)$/iu.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    /^(?:if|unless|when|whenever|wherever|only\s+(?:if|when|after)|assuming|provided|should)\b/iu.test(normalized) ||
    /\b(?:historical|previous|prior|earlier|quoted|quotation)\b[^:\r\n]{0,80}\b(?:output|instruction|action|behavior|example|text)\b/iu.test(
      normalized
    )
  ) {
    return true;
  }
  if (markdown) {
    if (
      /^(?:never\s+do\s+(?:this|these\s+things)|do\s+not\s+(?:perform\s+)?(?:this|the\s+following)|avoid\s+(?:this|the\s+following)|skip\s+(?:this|the\s+following))$/iu.test(
        normalized
      )
    ) {
      return true;
    }
    const outputScoped =
      /\b(?:output|deliverable|artifact|file|finding|result|publication|instruction|action|step|write|emit|save|persist|produce|create|copy|return|populate|append|document)\b/iu.test(
        normalized
      );
    const clauses = normalized.split(/\s*[;.!?]\s*/u).filter(Boolean);
    const nonRequiredQualifier =
      /\b(?:advisory|avoid|candidate|conditional|discretionary|elective|example|illustrative|nonessential|optional|recommended|suggested|unnecessary|forbidden|prohibited|never|do\s+not|must\s+not|shall\s+not)\b/iu;
    return (
      outputScoped &&
      (clauses.some(
        (clause) =>
          /\b(?:output|deliverable|artifact|file|finding|result|publication|instruction|action|step|write|emit|save|persist|produce|create|copy|return|populate|append|document)\b/iu.test(
            clause
          ) && nonRequiredQualifier.test(clause)
      ) ||
        clauses.some((clause) =>
          /^(?:advisory|candidate|conditional|discretionary|elective|example|illustrative|nonessential|optional|recommended|suggested|unnecessary|forbidden|prohibited)$/iu.test(
            clause.trim()
          )
        ))
    );
  }
  return /(?:\b(?:advisory|avoid|banned|barred|candidate|cannot|conditional|decline|disallowed|discourage|discouraged|discretionary|elective|example|except|exclude|forbidden|historical|illegal|ignore|ignored|illustrative|never|no|nonessential|not|omit|optional|optionally|prevent|prohibited|quoted|recommended|refuse|refrain|skip|suggested|unnecessary|unauthorized)\b|(?:aren|don|mayn|mustn|shouldn|can)['’]t|\bif\s+(?:needed|useful|possible)\b|\bwhen\s+(?:appropriate|convenient|useful)\b|\bas\s+needed\b|\bat\s+your\s+discretion\b)/iu.test(
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
