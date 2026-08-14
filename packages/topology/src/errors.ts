export type TopologyDiagnosticCode =
  | "MISSING_TOPOLOGY"
  | "TOPOLOGY_IO"
  | "TOPOLOGY_PARSE"
  | "INVALID_TOPOLOGY_SHAPE"
  | "UNSUPPORTED_TOPOLOGY_VERSION"
  | "NO_TOPOLOGY_NODES"
  | "TOO_MANY_TOPOLOGY_NODES"
  | "INVALID_NODE_ID"
  | "DUPLICATE_NODE_ID"
  | "MISSING_META_NODE"
  | "INVALID_META_NODE"
  | "INVALID_REFERENCE_NODE"
  | "REFERENCE_CATALOG"
  | "INVALID_ENTRY_EXIT"
  | "UNKNOWN_DEPENDENCY"
  | "DUPLICATE_DEPENDENCY"
  | "CYCLE_DETECTED"
  | "INVALID_GROUP_ID"
  | "INVALID_GROUP_COLOR"
  | "INVALID_LOOP_COUNT"
  | "TOO_MANY_LOOPS"
  | "TOO_MANY_EXPANDED_NODES"
  | "CONCRETE_NODE_ID_COLLISION"
  | "INVALID_TIMEOUT"
  | "INVALID_MODEL_PROFILE"
  | "UNKNOWN_MODEL_PROFILE"
  | "INVALID_PROMPT_PATH"
  | "MISSING_PROMPT_FILE"
  | "UNKNOWN_TOPOLOGY_FIELD"
  | "INVALID_OUTPUT_CONTRACT"
  | "PROPERTY_ROLE_DECLARATION_CONFLICT"
  | "MISSING_OUTPUT_CONTRACT"
  | "DUPLICATE_OUTPUT_PATH"
  | "INVALID_PRIMARY_OUTPUT"
  | "UNKNOWN_PROMPT_VARIABLE"
  | "INVALID_PROMPT_ARTIFACT_REFERENCE"
  | "UNKNOWN_PROMPT_ARTIFACT_REFERENCE"
  | "NON_ANCESTOR_PROMPT_ARTIFACT_REFERENCE"
  | "UNDECLARED_PROMPT_ARTIFACT_REFERENCE"
  | "MISSING_PROMPT_ARTIFACT_HANDOFF"
  | "MISSING_REPORT_VOCABULARY_REFERENCE"
  | "DUPLICATED_REPORT_VOCABULARY"
  | "SYMLINK_PATH"
  | "SERIALIZATION";

export interface TopologyErrorDetails {
  path?: string;
  nodeId?: string;
  dependency?: string;
  referenced?: string;
  reason?: string;
  [key: string]: unknown;
}

export class TopologyError extends Error {
  readonly code: TopologyDiagnosticCode;
  readonly details: TopologyErrorDetails;

  constructor(code: TopologyDiagnosticCode, message: string, details: TopologyErrorDetails = {}) {
    super(message);
    this.name = "TopologyError";
    this.code = code;
    this.details = details;
  }

  toJSON(): object {
    return {
      code: this.code,
      message: this.message,
      ...this.details
    };
  }
}

export function topologyError(
  code: TopologyDiagnosticCode,
  message: string,
  details: TopologyErrorDetails = {}
): TopologyError {
  return new TopologyError(code, message, details);
}
