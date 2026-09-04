import path from "node:path";

import { Args, Command, Flags } from "@oclif/core";
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
import { runtimeSemanticGateDiagnostics } from "@ultrafuzz/runtime";

import { cliIo, diagnosticsText, emitCommandResult, globalFlags } from "../../command-shared.js";

export default class ArtifactValidate extends Command {
  static override summary = "Validate an artifact's schema and document-local contract semantics";
  static override description =
    "Use the contract ID and artifact path declared in the rendered Ultrafuzz Output Contract. Without task-context flags, this command runs the registered JSON Schema and every document-local semantic gate. The exact generated-test task-context command rendered by Ultrafuzz additionally checks companion files and the sealed run/logical-producer values before publication; other host context remains runtime-owned.";
  static override args = {
    contract: Args.string({ required: true, description: "Declared registered artifact contract ID" }),
    artifactPath: Args.string({ required: true, description: "Declared artifact file to validate" })
  };
  static override flags = {
    ...globalFlags,
    strict: Flags.boolean({ summary: "Fail on optional metadata warnings (CI/development)", default: false }),
    "run-id": Flags.string({
      summary: "Sealed current run ID for generated-test task-context validation"
    }),
    "logical-node-id": Flags.string({
      summary: "Sealed logical producer ID for generated-test task-context validation"
    }),
    "artifact-root": Flags.string({
      summary: "Task artifact root for generated-test companion validation"
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ArtifactValidate);
    const artifactPath = path.resolve(cliIo().cwd, args.artifactPath);
    const contextFlags = [flags["run-id"], flags["logical-node-id"], flags["artifact-root"]];
    const contextual = contextFlags.some((value) => value !== undefined);
    if (contextual && contextFlags.some((value) => value === undefined || value.length === 0)) {
      throw new Error(
        "Generated-test task-context validation requires --run-id, --logical-node-id, and --artifact-root together"
      );
    }
    if (contextual && args.contract !== "ultrafuzz/generated-tests@3") {
      throw new Error("Task-context validation is supported only for ultrafuzz/generated-tests@3");
    }
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
        if (contextual) {
          const artifactRoot = path.resolve(cliIo().cwd, flags["artifact-root"]!);
          const relativeArtifactPath = path.relative(artifactRoot, artifactPath);
          if (
            relativeArtifactPath === "" ||
            path.isAbsolute(relativeArtifactPath) ||
            relativeArtifactPath === ".." ||
            relativeArtifactPath.startsWith(`..${path.sep}`)
          ) {
            throw new Error("Generated-test artifact path must be strictly inside --artifact-root");
          }
          const diagnostics = runtimeSemanticGateDiagnostics({
            schemaFilename: schemaFile as ArtifactSchemaFilename,
            document: validation.value,
            artifactPath,
            strict: flags.strict,
            context: {
              filesystem: { rootDirectory: artifactRoot },
              artifactIdentity: {
                runId: flags["run-id"]!,
                nodeId: flags["logical-node-id"]!,
                artifactPath: relativeArtifactPath.split(path.sep).join(path.posix.sep)
              }
            }
          });
          if (diagnostics.length > 0) {
            validation.ok = !diagnostics.some((diagnostic) => diagnostic.severity === "error");
            validation.issues.push(
              ...diagnostics.map((diagnostic): ArtifactContractIssue => ({
                code: diagnostic.code,
                severity: diagnostic.severity === "warning" ? "warning" : "error",
                message: diagnostic.message,
                path: diagnostic.path ?? artifactPath
              }))
            );
          }
        } else {
          const semanticIssues = executeOfflineSchemaSemanticGates(
            schemaFile as ArtifactSchemaFilename,
            validation.value,
            { strict: flags.strict }
          ).flatMap((result): ArtifactContractIssue[] =>
            result.status !== "failed" && result.status !== "warning"
              ? []
              : result.issues.map((issue) => ({
                  code:
                    issue.code ??
                    (issue.severity === "warning" ? "ARTIFACT_SEMANTIC_GATE_WARNING" : "ARTIFACT_SEMANTIC_GATE_FAILED"),
                  severity: issue.severity ?? "error",
                  message: `Semantic gate ${result.gate}${issue.severity === "warning" ? "" : " failed"}: ${issue.message}`,
                  path: `${artifactPath}#${issue.path}`
                }))
          );
          if (semanticIssues.length > 0) {
            validation.ok = !semanticIssues.some((issue) => issue.severity !== "warning");
            validation.issues.push(...semanticIssues);
          }
        }
      }
    }
    const diagnostics = validation.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      severity: issue.severity ?? "error",
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
        text: validation.ok
          ? `Valid ${args.contract}: ${artifactPath}\n${diagnosticsText(diagnostics)}`
          : diagnosticsText(diagnostics),
        diagnostics
      },
      flags.json === true
    );
  }
}
