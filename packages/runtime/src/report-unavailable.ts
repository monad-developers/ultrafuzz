/** Expected report absence. This is separate from the execution outcome. */
export class ReportUnavailableError extends Error {
  readonly code = "report-unavailable";

  constructor(reason: string) {
    super(`Report unavailable: ${reason}`);
    this.name = "ReportUnavailableError";
  }
}
