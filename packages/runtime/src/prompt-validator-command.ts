const VALIDATOR_COMMAND_PREFIXES = {
  schema: "  Validate against: ",
  json: "  Validation command: ",
  contract: "  Contract validation command: "
} as const;

const VALIDATOR_COMMAND_EXECUTABLES = {
  json: "ultrafuzz json validate --schema ",
  contract: "ultrafuzz artifact validate "
} as const;

const RUNTIME_AUTHORED_OUTPUT_PATHS = new Set([
  "workspace.patch",
  "workspace-patch.json",
  "vulnerability-db-manifest.json"
]);

export function producerSchemaBackedOutputCount(outputs: readonly { path: string; schemaFile?: string }[]): number {
  return outputs.filter((output) => output.schemaFile !== undefined && !RUNTIME_AUTHORED_OUTPUT_PATHS.has(output.path))
    .length;
}

/**
 * Refuse to schedule a producer when its declared schema authority did not make it into the prompt.
 * The renderer owns the exact commands; this independent count compares its output with the graph
 * authority so a projection bug cannot silently turn schema-backed outputs into prose-only outputs.
 */
export function assertRenderedPromptValidatorCommands(input: {
  attemptId: string;
  outputContractMarkdown: string;
  schemaBackedOutputCount: number;
}): void {
  const lines = input.outputContractMarkdown.split("\n");
  const actual = {
    schema: lines.filter((line) => line.startsWith(VALIDATOR_COMMAND_PREFIXES.schema)).length,
    json: lines.filter(
      (line) => line.startsWith(VALIDATOR_COMMAND_PREFIXES.json) && line.includes(VALIDATOR_COMMAND_EXECUTABLES.json)
    ).length,
    contract: lines.filter(
      (line) =>
        line.startsWith(VALIDATOR_COMMAND_PREFIXES.contract) && line.includes(VALIDATOR_COMMAND_EXECUTABLES.contract)
    ).length
  };
  const expected = input.schemaBackedOutputCount;
  if (actual.schema === expected && actual.json === expected && actual.contract === expected) return;
  throw new Error(
    `rendered prompt for ${input.attemptId} has incomplete producer validator commands: ` +
      `expected ${expected} schema path(s), JSON validation command(s), and contract validation command(s); ` +
      `found ${actual.schema}, ${actual.json}, and ${actual.contract}`
  );
}
