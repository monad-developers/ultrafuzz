import { z, type ZodIssue } from "zod/v4";
import { diagnostic, type ConfigDiagnostic, type TriageConfig } from "./types.js";

const triageConfigSchema = z
  .object({
    quorum: z.number().int().positive(),
    panelSize: z.number().int().positive()
  })
  .superRefine((triage, context) => {
    if (triage.quorum > triage.panelSize) {
      context.addIssue({
        code: "custom",
        path: ["quorum"],
        message: "CONFIG_TRIAGE_QUORUM_EXCEEDS_PANEL"
      });
    }
  });

export function validateTriageConfig(triage: TriageConfig, path: string[] = ["triage"]): ConfigDiagnostic[] {
  const parsed = triageConfigSchema.safeParse(triage);
  if (parsed.success) {
    return [];
  }
  return parsed.error.issues.map((issue) => triageConfigDiagnostic(issue, triage, path));
}

export function hasTriageQuorum(agreeingVotes: number, triage: TriageConfig): boolean {
  if (validateTriageConfig(triage).length > 0) {
    return false;
  }
  return agreeingVotes >= triage.quorum;
}

function triageConfigDiagnostic(issue: ZodIssue, triage: TriageConfig, path: string[]): ConfigDiagnostic {
  const code = triageConfigDiagnosticCode(issue);
  return diagnostic(
    code,
    triageConfigDiagnosticMessage(code, triage),
    path.concat(triageConfigPath(issue)),
    "validation"
  );
}

function triageConfigDiagnosticCode(issue: ZodIssue): string {
  if (issue.code === "custom") {
    return issue.message;
  }
  return issue.path[0] === "panelSize" ? "CONFIG_TRIAGE_PANEL_SIZE_INVALID" : "CONFIG_TRIAGE_QUORUM_INVALID";
}

function triageConfigDiagnosticMessage(code: string, triage: TriageConfig): string {
  switch (code) {
    case "CONFIG_TRIAGE_PANEL_SIZE_INVALID":
      return "triage.panel_size must be greater than zero";
    case "CONFIG_TRIAGE_QUORUM_EXCEEDS_PANEL":
      return `triage.quorum (${triage.quorum}) cannot be greater than triage.panel_size (${triage.panelSize})`;
    default:
      return "triage.quorum must be greater than zero";
  }
}

function triageConfigPath(issue: ZodIssue): string[] {
  return issue.path.map((segment) => (segment === "panelSize" ? "panel_size" : String(segment)));
}
