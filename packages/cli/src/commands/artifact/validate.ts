import path from "node:path";

import { Args, Command } from "@oclif/core";
import {
  DEFAULT_MAX_JSON_INSTANCE_BYTES,
  artifactContractSchemaFile,
  executeOfflineSchemaSemanticGates,
  isArtifactContractId,
  readRegularFileSnapshot,
  validateArtifactContractBytes,
  type ArtifactContractIssue,
  type ArtifactContractValidationResult,
  type ArtifactSchemaFilename
} from "@ultrafuzz/artifacts";

import { cliIo, diagnosticsText, emitCommandResult, globalFlags } from "../../command-shared.js";

export default class ArtifactValidate extends Command {
  static override summary = "Validate an artifact's schema and document-local contract semantics";
  static override description =
    "Use the contract ID and artifact path declared in the rendered Ultrafuzz Output Contract. This command runs the registered JSON Schema and every document-local semantic gate. It cannot authenticate workspace inputs or cross-artifact/run context; the runtime performs those checks at publication.";
  static override args = {
    contract: Args.string({ required: true, description: "Declared registered artifact contract ID" }),
    artifactPath: Args.string({ required: true, description: "Declared artifact file to validate" })
  };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ArtifactValidate);
    const artifactPath = path.resolve(cliIo().cwd, args.artifactPath);
    const validation: ArtifactContractValidationResult = isArtifactContractId(args.contract)
      ? validateArtifactContractBytes(
          args.contract,
          readRegularFileSnapshot(artifactPath, DEFAULT_MAX_JSON_INSTANCE_BYTES),
          artifactPath
        )
      : {
          ok: false,
          issues: [
            { code: "ARTIFACT_CONTRACT_UNKNOWN", message: `Unknown contract ${args.contract}`, path: artifactPath }
          ]
        };
    if (validation.ok && validation.value !== undefined && isArtifactContractId(args.contract)) {
      const schemaFile = artifactContractSchemaFile(args.contract);
      if (schemaFile !== undefined) {
        const semanticIssues = executeOfflineSchemaSemanticGates(
          schemaFile as ArtifactSchemaFilename,
          validation.value
        ).flatMap((result): ArtifactContractIssue[] =>
          result.status !== "failed"
            ? []
            : result.issues.map((issue) => ({
                code: "ARTIFACT_SEMANTIC_GATE_FAILED",
                message: `Semantic gate ${result.gate} failed: ${issue.message}`,
                path: `${artifactPath}#${issue.path}`
              }))
        );
        if (semanticIssues.length > 0) {
          validation.ok = false;
          validation.issues.push(...semanticIssues);
        }
      }
    }
    const diagnostics = validation.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      severity: "error" as const,
      source: "artifact-contracts",
      path: issue.path
    }));
    emitCommandResult(
      this,
      "artifact validate",
      {
        ok: validation.ok,
        command: "artifact validate",
        data: { contract: args.contract, path: artifactPath },
        text: validation.ok ? `Valid ${args.contract}: ${artifactPath}\n` : diagnosticsText(diagnostics),
        diagnostics
      },
      flags.json === true
    );
  }
}
