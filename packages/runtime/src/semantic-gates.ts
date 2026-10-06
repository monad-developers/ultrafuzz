import {
  ARTIFACT_SCHEMA_METADATA,
  executeSemanticGates,
  type ArtifactSchemaFilename,
  type SemanticGateContext,
  type SemanticGateExecutionResult,
  type SemanticGateName
} from "@ultrafuzz/artifacts";

import type { RuntimeDiagnostic } from "./types.js";

export interface RuntimeSemanticGateRequest {
  schemaFilename: ArtifactSchemaFilename;
  document: unknown;
  artifactPath: string;
  context?: SemanticGateContext;
  strict?: boolean;
  /** `"skip"` drops the gates whose facts only a live task worktree holds. Defaults to `"read"`. */
  taskWorktree?: "read" | "skip";
}

/** Gates whose facts are read from the producing task's worktree, which Ultrafuzz deletes after the run (#1227). */
const TASK_WORKTREE_SEMANTIC_GATES: readonly SemanticGateName[] = [
  "workspace-patch-git-binding",
  "invariant-source-proof-git-binding",
  "aggregation-authenticated-source-destination-reconciliation"
];

/**
 * Execute the schema registry's semantic gates at a trusted host boundary.
 * Contextual gates fail closed: a caller must supply the named runtime facts,
 * and `requires-context` is a durable error rather than an implicit pass.
 * Worktree-bound gates are a finalization-time check: a read of finalized
 * output passes `taskWorktree: "skip"` and checks the published bytes only.
 */
export function runtimeSemanticGateDiagnostics(request: RuntimeSemanticGateRequest): RuntimeDiagnostic[] {
  const names = ARTIFACT_SCHEMA_METADATA[request.schemaFilename].semanticGates as readonly SemanticGateName[];
  return executeSemanticGates(
    request.taskWorktree === "skip" ? names.filter((name) => !TASK_WORKTREE_SEMANTIC_GATES.includes(name)) : names,
    { document: request.document, context: request.context, strict: request.strict }
  ).flatMap((result) => semanticGateResultDiagnostics(request, result));
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
    code:
      issue.code ?? (issue.severity === "warning" ? "ARTIFACT_SEMANTIC_GATE_WARNING" : "ARTIFACT_SEMANTIC_GATE_FAILED"),
    message: `Semantic gate ${result.gate}${issue.severity === "warning" ? "" : " failed"}: ${issue.message}`,
    severity: issue.severity ?? "error",
    source: "semantic-gates",
    path: `${request.artifactPath}#${issue.path}`,
    details: {
      schema_file: request.schemaFilename,
      gate: result.gate,
      scope: result.scope,
      ...(issue.sourcePath === undefined ? {} : { source_path: issue.sourcePath })
    }
  }));
}
