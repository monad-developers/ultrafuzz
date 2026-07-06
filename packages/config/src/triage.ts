import { diagnostic, type ConfigDiagnostic, type TriageConfig } from "./types.js";

export function validateTriageConfig(triage: TriageConfig, path: string[] = ["triage"]): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  if (!Number.isInteger(triage.quorum) || triage.quorum <= 0) {
    diagnostics.push(
      diagnostic(
        "CONFIG_TRIAGE_QUORUM_INVALID",
        "triage.quorum must be greater than zero",
        path.concat("quorum"),
        "validation"
      )
    );
  }
  if (!Number.isInteger(triage.panelSize) || triage.panelSize <= 0) {
    diagnostics.push(
      diagnostic(
        "CONFIG_TRIAGE_PANEL_SIZE_INVALID",
        "triage.panel_size must be greater than zero",
        path.concat("panel_size"),
        "validation"
      )
    );
  }
  if (
    Number.isInteger(triage.quorum) &&
    Number.isInteger(triage.panelSize) &&
    triage.quorum > 0 &&
    triage.panelSize > 0 &&
    triage.quorum > triage.panelSize
  ) {
    diagnostics.push(
      diagnostic(
        "CONFIG_TRIAGE_QUORUM_EXCEEDS_PANEL",
        `triage.quorum (${triage.quorum}) cannot be greater than triage.panel_size (${triage.panelSize})`,
        path.concat("quorum"),
        "validation"
      )
    );
  }
  return diagnostics;
}

export function hasTriageQuorum(agreeingVotes: number, triage: TriageConfig): boolean {
  if (validateTriageConfig(triage).length > 0) {
    return false;
  }
  return agreeingVotes >= triage.quorum;
}
