import {
  executeSchemaSemanticGates,
  type ArtifactSchemaFilename,
  type SemanticGateContext,
  type SemanticGateExecutionResult
} from "@ultrafuzz/artifacts";

import type { RuntimeDiagnostic } from "./types.js";

export interface RuntimeSemanticGateRequest {
  schemaFilename: ArtifactSchemaFilename;
  document: unknown;
  artifactPath: string;
  context?: SemanticGateContext;
}

/**
 * Execute the schema registry's semantic gates at a trusted host boundary.
 * Contextual gates fail closed: a caller must supply the named runtime facts,
 * and `requires-context` is a durable error rather than an implicit pass.
 */
export function runtimeSemanticGateDiagnostics(request: RuntimeSemanticGateRequest): RuntimeDiagnostic[] {
  return executeSchemaSemanticGates(request.schemaFilename, {
    document: request.document,
    context: request.context
  }).flatMap((result) => semanticGateResultDiagnostics(request, result));
}

function semanticGateResultDiagnostics(
  request: RuntimeSemanticGateRequest,
  result: SemanticGateExecutionResult
): RuntimeDiagnostic[] {
  if (result.status === "passed") return [];
  if (result.status === "requires-context") {
    return [
      {
        code: "ARTIFACT_SEMANTIC_GATE_CONTEXT_UNAVAILABLE",
        message: `Semantic gate ${result.gate} cannot execute without trusted host context: ${result.missingContext.join(", ")}`,
        severity: "error",
        source: "semantic-gates",
        path: request.artifactPath,
        details: {
          schema_file: request.schemaFilename,
          gate: result.gate,
          scope: result.scope,
          required_context: [...result.requiredContext],
          missing_context: [...result.missingContext]
        }
      }
    ];
  }
  return result.issues.map((issue) => ({
    code: "ARTIFACT_SEMANTIC_GATE_FAILED",
    message: `Semantic gate ${result.gate} failed: ${issue.message}`,
    severity: "error" as const,
    source: "semantic-gates",
    path: `${request.artifactPath}#${issue.path}`,
    details: {
      schema_file: request.schemaFilename,
      gate: result.gate,
      scope: result.scope
    }
  }));
}
