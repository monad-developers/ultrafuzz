export type PolicySeverity = "error" | "warning" | "info";

export interface PolicyDiagnostic {
  code: string;
  message: string;
  severity: PolicySeverity;
  path?: string;
  key?: string;
  details?: Record<string, unknown>;
}

export interface UnsafeModeAuditInput {
  mode: string;
  scope: string;
  reason: string;
  operator: string;
  acknowledgement: string;
  approvedAt?: string;
}

export interface UnsafeModeAuditRecord extends UnsafeModeAuditInput {
  approvedAt: string;
}

export interface PolicyResult<T = undefined> {
  ok: boolean;
  diagnostics: PolicyDiagnostic[];
  value?: T;
  audit: UnsafeModeAuditRecord[];
}

export function policyError(
  code: string,
  message: string,
  fields: Omit<PolicyDiagnostic, "code" | "message" | "severity"> = {}
): PolicyDiagnostic {
  return { code, message, severity: "error", ...fields };
}

export function policyResult<T = undefined>(
  diagnostics: PolicyDiagnostic[],
  value?: T,
  audit: UnsafeModeAuditRecord[] = []
): PolicyResult<T> {
  const result: PolicyResult<T> = {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
    audit
  };
  if (value !== undefined) {
    result.value = value;
  }
  return result;
}
