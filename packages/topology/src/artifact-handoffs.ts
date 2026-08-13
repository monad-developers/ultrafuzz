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
  const expectedContentPattern = new Set([
    "ultrafuzz/findings@2",
    "ultrafuzz/triaged-findings@1",
    "ultrafuzz/severity-classified-findings@1"
  ]).has(contract)
    ? "findings?"
    : undefined;
  const findingsOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/findings@2");
  if (contract === "ultrafuzz/findings@2" && findingsOutputs.length === 1 && findingsOutputs[0]!.path === outputPath) {
    if (
      variables.some((variable) => variable.name === "output_findings_path") &&
      hasWriteInstruction(promptText, "output_findings_path", "findings?")
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
      hasWriteInstruction(promptText, "output_stage_findings_path", "findings?")
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

function hasWriteInstruction(promptText: string, variable: string, expectedContentPattern?: string): boolean {
  const token =
    `\\{\\{\\s*${escapeRegExp(variable)}\\s*\\}\\}` + `(?=$|[\\s\\x60'"),;!\\]}]|\\.(?=$|[\\s\\x60'"),;!\\]}]))`;
  return hasAffirmativeWriteInstruction(promptText, token, expectedContentPattern);
}

function hasAffirmativeWriteInstruction(
  promptText: string,
  destinationPattern: string,
  expectedContentPattern?: string
): boolean {
  const outputVerb = `(?:write|emit|save|persist|produce|create|mirror|list|record|store|put|publish|serialize|output(?!\\s*(?::|\\b(?:is|are|was|were)\\b))|deliver)`;
  const passiveOutputVerb = `(?:written|emitted|saved|persisted|produced|created|mirrored|listed|recorded|stored|put|published|serialized|output|delivered)`;
  const passiveSubject =
    `(?:(?:the|all|any)\\s+)?(?:(?:confirmed|structured|normalized|generated|final|required)\\s+){0,3}` +
    `(?:findings?|outputs?|artifacts?|results?|reports?|manifests?|catalogs?|ledgers?|files?)`;
  const mandatoryPreamble =
    `(?:(?:the\\s+)?agent\\s+(?:(?:is\\s+(?:required|mandated)\\s+to)|(?:must|shall|should))|` +
    `you\\s+(?:(?:are\\s+(?:required|mandated)\\s+to)|(?:must|shall|should)))`;
  const mandatoryPassive =
    `${passiveSubject}\\s+(?:(?:must|shall)\\s+be|(?:are|is)\\s+to\\s+be|(?:are|is)\\s+(?:required|mandated)\\s+to\\s+be|` +
    `(?:are|is)\\s+mandatory\\s+(?:and\\s+)?(?:must|shall)\\s+be)\\s+${passiveOutputVerb}\\b`;
  const destinationFirstContent =
    expectedContentPattern ?? "findings?|outputs?|artifacts?|results?|reports?|manifests?|catalogs?|ledgers?|files?";
  const destinationFirstPassive = new RegExp(
    `(?:^|[.!?]\\s+|\\n\\s*)[\\x60'"]?(?:${destinationPattern})[\\x60'"]?\\s+` +
      `(?:(?:must|shall)\\s+be|(?:is|are)\\s+to\\s+be|(?:is|are)\\s+(?:required|mandated)\\s+to\\s+be)\\s+` +
      `${passiveOutputVerb}\\b[^.!?]{0,160}\\b(?:${destinationFirstContent})\\b`,
    "gimu"
  );
  for (const match of promptText.matchAll(destinationFirstPassive)) {
    const directiveIndex = match.index + instructionVerbOffset(match[0]);
    if (
      !hasNonRequiredDirectiveMeaning(promptText, match[0], match.index, directiveIndex) &&
      !hasNonRequiredDirectiveScope(promptText, directiveIndex) &&
      (expectedContentPattern === undefined || !hasProjectedArtifactContent(match[0], expectedContentPattern))
    ) {
      return true;
    }
  }
  const crossSentenceSubject =
    `(?:(?:the|all|any)\\s+)?(?:(?:confirmed|structured|normalized|generated|final|required)\\s+){0,3}` +
    `(?:${expectedContentPattern ?? "findings?|outputs?|artifacts?|results?|reports?|manifests?|catalogs?|ledgers?|files?"})`;
  const crossSentencePassive = new RegExp(
    `(?:^|[.!?]\\s+|\\n\\s*)(?:[-*+>]\\s+)?(?:(?:also|always|immediately|please|then)\\s+)?` +
      `${outputVerb}\\s+${crossSentenceSubject}\\s*[.!?]\\s*(?:they|it|these|those|this|that)\\s+` +
      `(?:(?:must|shall)\\s+be|(?:are|is)\\s+to\\s+be|(?:are|is)\\s+(?:required|mandated)\\s+to\\s+be)\\s+` +
      `${passiveOutputVerb}\\b[^.!?]{0,200}${destinationPattern}`,
    "gimu"
  );
  for (const match of promptText.matchAll(crossSentencePassive)) {
    const directiveIndex = match.index + instructionVerbOffset(match[0]);
    if (
      !hasNonRequiredDirectiveMeaning(promptText, match[0], match.index, directiveIndex) &&
      !hasNonRequiredDirectiveScope(promptText, directiveIndex) &&
      hasDirectDestinationBinding(match[0], destinationPattern, expectedContentPattern)
    ) {
      return true;
    }
  }
  const requiredException = new RegExp(
    `(?:^|[.!?]\\s+|\\n\\s*)(?:(?:(?:(?:you|the\\s+agent)\\s+)?(?:do\\s+not|never|must\\s+not|shall\\s+not|cannot)\\s+(?:fail|forget)\\s+to|without\\s+fail,)\\s*${outputVerb}\\b|(?:do\\s+not|never|must\\s+not|shall\\s+not)\\s+omit\\s+writing\\b|(?:be\\s+sure\\s+to|make\\s+sure\\s+to|the\\s+agent\\s+is\\s+required\\s+to|you\\s+need\\s+to)\\s+${outputVerb}\\b)[^.!?]{0,200}${destinationPattern}`,
    "gimu"
  );
  for (const match of promptText.matchAll(requiredException)) {
    const directiveIndex = match.index + instructionVerbOffset(match[0]);
    const prefix = promptText.slice(0, directiveIndex);
    const normalizedMatchStart = match[0].replace(/^[.!?][ \t]*(?=\r?\n)/u, "");
    const startsMarkdownItem = /^\r?\n[ \t]*[-*+>][ \t]+/u.test(normalizedMatchStart);
    const precedingLine = prefix.trimEnd().split(/\r?\n/u).at(-1)?.trim() ?? "";
    const startsIndependentSentence =
      !startsMarkdownItem &&
      (/^[.!?]\s+/u.test(match[0]) || (/^\r?\n/u.test(normalizedMatchStart) && /[.!?]\s*$/u.test(precedingLine)));
    if (
      !hasNonRequiredDirectiveMeaning(promptText, match[0], match.index, directiveIndex) &&
      !hasNonRequiredDirectiveScope(promptText, directiveIndex, undefined, true, startsIndependentSentence) &&
      hasDirectDestinationBinding(match[0], destinationPattern, expectedContentPattern)
    )
      return true;
  }
  const mandatoryLeadIn =
    `(?:(?:(?:also|always|immediately|otherwise|please|then|finally)\\s*,?\\s+)|` +
    `(?:(?:regardless\\s+of\\s+(?:(?:the\\s+)?(?:outcome|result)|whether\\b[^,]{0,100})|` +
    `no\\s+matter\\s+(?:(?:the\\s+)?(?:outcome|result)|whether\\b[^,]{0,100})|` +
    `whether\\s+or\\s+not[^,]{0,100}|whether\\b[^,]{0,100}\\bor\\s+not|even\\s+if[^,]{0,100}|` +
    `in\\s+every\\s+case|at\\s+completion)\\s*,\\s*))?`;
  const directive = new RegExp(
    `(?:^|[.!?]\\s+|\\n\\s*|\\band\\s+|(?:required\\s+output|output):\\s+|;\\s+|,\\s+(?:(?:but|yet)\\s+|(?=(?:also|immediately|then)\\b)))(?:[-*+>]\\s+)?${mandatoryLeadIn}(?:(?:ensure(?:\\s+you)?|remember\\s+to|${mandatoryPreamble})\\s+)?(?:${outputVerb}\\b(?!\\s+(?:whether|if)\\b)|${mandatoryPassive})[^.!?]{0,200}${destinationPattern}`,
    "gimu"
  );
  for (const match of promptText.matchAll(directive)) {
    const directiveIndex = match.index + instructionVerbOffset(match[0]);
    const prefix = promptText.slice(0, directiveIndex);
    const startsOrderedListItem = /(?:^|\r?\n)[ \t]*\d+$/u.test(prefix) && /^\.[ \t]+/u.test(match[0]);
    const normalizedMatchStart = startsOrderedListItem ? match[0] : match[0].replace(/^[.!?][ \t]*(?=\r?\n)/u, "");
    const startsOnContinuationLine = /^\r?\n/u.test(normalizedMatchStart);
    const startsAfterSentence = /^[.!?][ \t]*\r?\n/u.test(match[0]);
    const startsNewParagraph = /^\r?\n[ \t]*\r?\n/u.test(normalizedMatchStart);
    const startsMarkdownItem = /^\r?\n[ \t]*[-*+>][ \t]+/u.test(normalizedMatchStart);
    const previousNonemptyLine = prefix
      .split(/\r?\n/u)
      .reverse()
      .find((line) => line.trim() !== "");
    const startsIndependentMarkdownItem = startsMarkdownItem && /^[ \t]*[-*+>][ \t]+/u.test(previousNonemptyLine ?? "");
    const currentBlock = prefix.split(/\r?\n\s*\r?\n/u).at(-1) ?? "";
    const currentLines = currentBlock.split(/\r?\n/u);
    const listIntroducer =
      currentLines
        .filter((line) => line.trim() !== "" && !/^\s*(?:[-*+>]|\d+\.)\s*/u.test(line))
        .at(-1)
        ?.trim() ?? "";
    const precedingHeading = prefix.trimEnd().split(/\r?\n/u).at(-1)?.trim() ?? "";
    const allowedLineBoundary =
      !startsOnContinuationLine ||
      startsAfterSentence ||
      startsNewParagraph ||
      startsIndependentMarkdownItem ||
      /[.!?:]\s*$/u.test(precedingHeading) ||
      /\{\{[^{}\r\n]+\}\}\s*$/u.test(precedingHeading) ||
      previousNonemptyLine === undefined;
    const startsAfterSentenceBoundary = /^[.!?]\s+/u.test(match[0]);
    const startsAfterClauseBoundary = /^[,;]\s+/u.test(match[0]);
    const startsAfterBareSemicolon = /^;\s+(?!(?:also|but|immediately|then|yet)\b)/iu.test(match[0]);
    const precedingClause = prefix.slice(
      Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("!"), prefix.lastIndexOf("?")) + 1
    );
    const startsIndependentClause =
      startsAfterClauseBoundary &&
      /\b(?:write|emit|save|persist|produce|create|mirror|list|record|store|put|publish|serialize|output|deliver)\b/iu.test(
        precedingClause
      );
    const startsWithUnconditionalLeadIn =
      /^(?:[.!?]\s+|\r?\n\s*)?(?:(?:regardless\s+of|no\s+matter)\s+(?:(?:the\s+)?(?:outcome|result)|whether\b[^,]{0,100})|whether\s+or\s+not[^,]{0,100}|whether\b[^,]{0,100}\bor\s+not|even\s+if[^,]{0,100}|in\s+every\s+case|at\s+completion)\s*,/iu.test(
        match[0]
      );
    const startsIndependentSentence =
      (!startsMarkdownItem && startsAfterSentenceBoundary) ||
      (startsOnContinuationLine && !startsMarkdownItem && /[.!?]\s*$/u.test(precedingHeading));
    const startsIndependentDirective =
      startsIndependentSentence || startsIndependentClause || startsWithUnconditionalLeadIn;
    if (
      !allowedLineBoundary ||
      (startsAfterBareSemicolon && !startsIndependentClause) ||
      hasNonRequiredDirectiveScope(
        promptText,
        directiveIndex,
        startsIndependentDirective ? undefined : listIntroducer || undefined,
        startsIndependentDirective,
        startsIndependentDirective
      )
    )
      continue;
    if (startsOrderedListItem && listIntroducer !== "" && isNonRequiredDirectiveHeading(listIntroducer)) continue;
    if (
      !hasNonRequiredDirectiveMeaning(promptText, match[0], match.index, directiveIndex) &&
      allowedLineBoundary &&
      hasDirectDestinationBinding(match[0], destinationPattern, expectedContentPattern)
    ) {
      return true;
    }
  }
  return false;
}

function hasNonRequiredDirectiveMeaning(
  promptText: string,
  matchText: string,
  matchIndex: number,
  directiveIndex: number
): boolean {
  const negativeObject =
    /\b(?:write|writing|emit|save|persist|produce|create|mirror|list|record|store|put|publish|serialize|output|deliver)\s+(?:no\b|nothing\b|zero\b|anything\s+except\b)/iu.test(
      matchText
    );
  const followingSentence = promptText
    .slice(directiveIndex, directiveIndex + matchText.length + 100)
    .split(/[.!?](?:\s|$)/u, 1)[0]!;
  const directiveText = followingSentence.replace(/,\s*if\s+any\s*,/giu, ",");
  const conditionalDirectiveText = directiveText
    .replace(/\b(?:regardless\s+of|irrespective\s+of|no\s+matter)\s+whether\b/giu, "")
    .replace(/\bwhether\s+or\s+not\b/giu, "")
    .replace(/\bwhether\b[^,;.!?]{0,100}\bor\s+not\b/giu, "")
    .replace(/\beven\s+if\b/giu, "");
  const descriptiveClause =
    /\b(?:whether|if)\b/iu.test(conditionalDirectiveText) ||
    /\b(?:assessment|answer|decision|description|note|report|summary)\b[^.!?]{0,120}\b(?:about|of|on|regarding)\b/iu.test(
      directiveText
    );
  const explicitEmptyPlaceholder =
    /\b(?:write|emit|save|persist|produce|create|mirror|list|record|store|put|publish|serialize|output|deliver)\s+(?:(?:an?|the)\s+)?(?:(?:empty|blank)\s+)?(?:placeholder|dummy|stub|sentinel)\b/iu.test(
      directiveText
    ) ||
    /\b(?:write|emit|save|persist|produce|create|mirror|list|record|store|put|publish|serialize|output|deliver)\s*(?:\[\]|\{\})/iu.test(
      directiveText
    ) ||
    /\b(?:write|emit|save|persist|produce|create|mirror|list|record|store|put|publish|serialize|output|deliver)\s+(?:(?:an?|the)\s+)?(?:empty|blank|zero[- ](?:entry|item))\s+(?:(?:json|findings?)\s+)?(?:array|object|file|artifact|manifest|placeholder)\b/iu.test(
      directiveText
    );
  const trailingClause =
    promptText
      .slice(matchIndex + matchText.length)
      .match(/^[^.!?]*/u)?.[0]
      .trim() ?? "";
  const unconditionalTrailingClause =
    /^[,;]?\s*(?:even\s+if|whether\s+or\s+not|whether\b[^,;.!?]{0,100}\bor\s+not\b|(?:regardless\s+of|irrespective\s+of|no\s+matter)\s+whether)\b/iu.test(
      trailingClause
    );
  const discretionaryClause =
    (!unconditionalTrailingClause &&
      /^[,;]?\s*(?:at\s+(?:need|your\s+discretion)|assuming|as\s+long\s+as|conditionally|contingent\s+on|depending\s+(?:on|upon)|discretionary|except\s+(?:if|when)|in\s+(?:case|the\s+event)|optional|optionally|should\s+(?:you\s+wish|\w+\s+\w+)|subject\s+to|to\s+the\s+extent|whether|whenever|if|when|where|unless|provided|upon\s+request|only\s+(?:as|if|when)|as\s+(?:appropriate|needed)|on\s+(?:request|demand))\b/iu.test(
        trailingClause
      )) ||
    /^(?:[.;]\s*)?(?:(?:this|that|the\s+output|publication)\s+is\s+optional|omit\s+when)\b/iu.test(
      promptText.slice(matchIndex + matchText.length)
    );
  return negativeObject || descriptiveClause || explicitEmptyPlaceholder || discretionaryClause;
}

function instructionVerbOffset(value: string): number {
  return value.search(
    /\b(?:write|writing|written|emit|emitted|save|saved|persist|persisted|produce|produced|create|created|mirror|mirrored|list|listed|record|recorded|store|stored|put|publish|published|serialize|serialized|output(?!\s*(?::|\b(?:is|are|was|were)\b))|deliver|delivered)\b/iu
  );
}

function hasDirectDestinationBinding(
  matchText: string,
  destinationPattern: string,
  expectedContentPattern?: string
): boolean {
  const destination = new RegExp(destinationPattern, "imu").exec(matchText);
  if (destination === null) return false;
  const actionVerb =
    /\b(write|writing|written|emit|emitted|save|saved|persist|persisted|produce|produced|create|created|mirror|mirrored|list|listed|record|recorded|store|stored|put|publish|published|serialize|serialized|output|deliver|delivered|inspect|read|review|check|verify|examine|assess|describe|explain|mention|reference|refer|determine|decide|consider|delete|remove|avoid|skip|omit|do|say|state|indicate|point|link|compare)\b/giu;
  const verbs = Array.from(matchText.slice(0, destination.index).matchAll(actionVerb));
  const lastVerb = verbs.at(-1);
  const previousVerb = verbs.at(-2);
  const outputIsContentNoun =
    expectedContentPattern !== undefined &&
    lastVerb?.[1]?.toLocaleLowerCase("en-US") === "output" &&
    previousVerb !== undefined &&
    new RegExp(`\\b(?:${expectedContentPattern})\\b(?:\\s+(?:artifact|document|file|json))?\\s*$`, "iu").test(
      matchText.slice(previousVerb.index + previousVerb[0].length, lastVerb.index)
    );
  const nearestVerb = outputIsContentNoun ? previousVerb : lastVerb;
  if (
    nearestVerb === undefined ||
    !/^(?:write|writing|written|emit|emitted|save|saved|persist|persisted|produce|produced|create|created|mirror|mirrored|list|listed|record|recorded|store|stored|put|publish|published|serialize|serialized|output|deliver|delivered)$/iu.test(
      nearestVerb[1]!
    )
  ) {
    return false;
  }

  const beforeNearestVerb = matchText.slice(0, nearestVerb.index);
  if (
    /(?:\b(?:do\s+not|never|must\s+not|shall\s+not|should\s+not|cannot|(?:can|could|will|would|may|might|need)\s+not|(?:is|are)\s+(?:not\s+(?:allowed|permitted|required)|unable|forbidden|prohibited)\s+to|avoid|skip|omit|fail(?:ed|ing)?\s+to|refuse\s+to|decline\s+to)|\b(?:don|doesn|can|won|mustn|shouldn|couldn|wouldn)['’]t|\b(?:isn|aren)['’]t\s+(?:allowed|permitted|required|able)\s+to)\s*$/iu.test(
      beforeNearestVerb
    ) &&
    !/\b(?:do\s+not|never|must\s+not|shall\s+not|cannot)\s+(?:(?:fail|forget)\s+to|omit)\s*$/iu.test(beforeNearestVerb)
  ) {
    return false;
  }

  const binding = matchText
    .slice(nearestVerb.index + nearestVerb[0].length, destination.index)
    .replace(/,\s*if\s+any\s*,/giu, ",");
  if (
    /\b(?:parent\s+)?(?:directory|folder)\s+(?:for|at|containing)\s*$/iu.test(binding.trimEnd()) ||
    /\b(?:summary|report|note|description|assessment|logs?|message|explanation|account)\b[^.!?]{0,100}\b(?:that|whether|if|mentioning|saying|stating|containing|including|citing|quoting|about|regarding|on)\b/iu.test(
      binding
    )
  ) {
    return false;
  }

  const relationship = Array.from(
    binding.matchAll(/\b(to|at|in|into|under|as|for|about|regarding|on|before|after|alongside|near)\b/giu)
  ).at(-1);
  if (
    expectedContentPattern !== undefined &&
    !hasExpectedArtifactContent(matchText, nearestVerb, binding, relationship, expectedContentPattern)
  ) {
    return false;
  }
  if (relationship === undefined) {
    return !/^(?:list|listed|record|recorded)$/iu.test(nearestVerb[1]!) && !/[\p{L}\p{N}]/u.test(binding);
  }
  return /^(?:to|at|in|into|under|as)$/iu.test(relationship[1]!);
}

function hasExpectedArtifactContent(
  matchText: string,
  nearestVerb: RegExpMatchArray,
  binding: string,
  relationship: RegExpMatchArray | undefined,
  expectedContentPattern: string
): boolean {
  const expectedContent = new RegExp(`\\b(?:${expectedContentPattern})\\b`, "iu");
  const directObject = binding
    .slice(0, relationship?.index ?? binding.length)
    .replace(/^[\s,:;()-]+|[\s,:;()-]+$/gu, "");
  const passiveForm =
    /^(?:written|emitted|saved|persisted|produced|created|mirrored|listed|recorded|stored|published|serialized|delivered)$/iu.test(
      nearestVerb[1]!
    );
  const beforeNearestVerb = matchText.slice(0, nearestVerb.index);
  const passivePutOrOutput =
    /^(?:put|output)$/iu.test(nearestVerb[1]!) &&
    /\b(?:must|shall|is|are)\s+(?:(?:required|mandated)\s+to\s+)?be\s*$/iu.test(beforeNearestVerb);
  const contentBinding = passiveForm || passivePutOrOutput ? beforeNearestVerb : directObject;
  if (expectedContent.test(contentBinding)) {
    return !hasProjectedArtifactContent(contentBinding, expectedContentPattern);
  }
  return /^(?:(?:the|a|an|all|any|required|declared|current|final|structured|normalized)\s+)*(?:it|them|this|that|these|those|output|artifact|result|document|file|json)$/iu.test(
    directObject
  );
}

function hasProjectedArtifactContent(value: string, expectedContentPattern: string): boolean {
  return new RegExp(
    `(?:\\b(?:number|count|total|checksum|digest|hash|metadata|summary|description|assessment)\\s+(?:of\\s+)?(?:the\\s+)?(?:${expectedContentPattern})\\b|` +
      `\\b(?:${expectedContentPattern})\\s+(?:number|count|total|checksum|digest|hash|metadata|summary|description|assessment)\\b)`,
    "iu"
  ).test(value);
}

function hasNonRequiredDirectiveScope(
  promptText: string,
  matchIndex: number,
  listIntroducer?: string,
  ignoreCurrentLine = false,
  ignoreCompletedSentence = false
): boolean {
  const prefix = promptText.slice(0, matchIndex);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  const currentLinePrefix = prefix.slice(lineStart).trim();
  const structuralPrefix = prefix.slice(0, lineStart);
  const block = structuralPrefix.split(/\r?\n\s*\r?\n/u).at(-1) ?? "";
  const lines = block.split(/\r?\n/u);
  const previousStructuralLine = structuralPrefix
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !/^\s*(?:[-*+>]|\d+\.)\s+/u.test(line))
    .at(-1)
    ?.trim();
  const markdownScopeHeading = nearestMarkdownDirectiveHeading(structuralPrefix);
  const blockScopeHeading = lines
    .filter((line) => /:\s*$/u.test(line.trim()))
    .at(-1)
    ?.trim();
  if (
    (markdownScopeHeading !== undefined && isNonRequiredDirectiveHeading(markdownScopeHeading)) ||
    (blockScopeHeading !== undefined && isNonRequiredDirectiveHeading(blockScopeHeading))
  ) {
    return true;
  }
  if (ignoreCompletedSentence && previousStructuralLine !== undefined && /[.!?]\s*$/u.test(previousStructuralLine)) {
    return false;
  }
  const structuralHeading =
    listIntroducer ??
    (!ignoreCurrentLine && /[\p{L}\p{N}]/u.test(currentLinePrefix) ? currentLinePrefix : undefined) ??
    lines
      .filter((line) => line.trim() !== "" && !/^\s*(?:[-*+>]|\d+\.)\s+/u.test(line))
      .at(-1)
      ?.trim() ??
    (previousStructuralLine !== undefined && /:\s*$/u.test(previousStructuralLine)
      ? previousStructuralLine
      : undefined) ??
    "";
  return isNonRequiredDirectiveHeading(structuralHeading);
}

function nearestMarkdownDirectiveHeading(promptPrefix: string): string | undefined {
  for (const line of promptPrefix.split(/\r?\n/u).reverse()) {
    const trimmed = line.trim();
    const markdownHeading = trimmed.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/u);
    if (markdownHeading !== null) return markdownHeading[1]!.trim();
  }
  return undefined;
}

function isNonRequiredDirectiveHeading(heading: string): boolean {
  if (
    /(?:\bnot\s+optional\b|\bnon[- ]optional\b|\b(?:do\s+not|never|must\s+not|shall\s+not)\s+(?:fail(?:\s+to)?|forget(?:\s+to)?|omit|skip)(?:\s+(?:this|the\s+(?:artifact|following|output)))?\s*[:.)-]?\s*$|\b(?:required|mandatory)\b[^:\r\n]{0,80}\b(?:do\s+not|never)\s+(?:omit|skip|forget)\b)/iu.test(
      heading
    )
  ) {
    return false;
  }
  return (
    /(?:\b(?:advisory|avoid|banned|barred|candidate|cannot|decline|disallowed|discourage|discouraged|discretionary|elective|example|except|exclude|forbidden|illegal|ignore|ignored|illustrative|never|no|nonessential|not|omit|optional|optionally|prevent|prohibited|recommended|refuse|refrain|skip|suggested|unnecessary|unauthorized|without)\b|(?:aren|don|mayn|mustn|shouldn|can)['’]t|\bif\s+(?:needed|useful)\b|\bwhen\s+(?:appropriate|convenient|useful)\b|\bas\s+needed\b|\bat\s+your\s+discretion\b)/iu.test(
      heading
    ) || /^(?:possible\s+output|for\s+reference\s+only|recommendation\s+output)\s*:/iu.test(heading)
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
