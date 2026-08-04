import {
  classifyTerminalDisposition,
  inspectTerminalDisposition,
  inspectTerminalDispositionAtRunRoot,
  TERMINAL_DISPOSITION_KINDS,
  verifyRecordedTerminalDisposition,
  type TerminalDisposition,
  type TerminalDispositionKind
} from "@ultrafuzz/evals";

export {
  classifyTerminalDisposition,
  inspectTerminalDisposition,
  inspectTerminalDispositionAtRunRoot,
  TERMINAL_DISPOSITION_KINDS,
  verifyRecordedTerminalDisposition,
  type TerminalDisposition,
  type TerminalDispositionKind
};

export const OPERATIONAL_DISPOSITION_CATEGORIES = [
  "live",
  "finished",
  "capacity-unavailable",
  "authentication-failure",
  "sandbox-exited",
  "unreachable",
  "genuine-evaluation-failure"
] as const;

export type OperationalDispositionCategory = (typeof OPERATIONAL_DISPOSITION_CATEGORIES)[number];
export type OperationalFailureCategory = Extract<
  OperationalDispositionCategory,
  "capacity-unavailable" | "authentication-failure" | "sandbox-exited" | "unreachable"
>;

export class OperationalDispositionError extends Error {
  readonly category: OperationalFailureCategory;

  constructor(category: OperationalFailureCategory, options: { cause?: unknown } = {}) {
    super("worker operation failed", options);
    this.name = "OperationalDispositionError";
    this.category = category;
  }
}

export function operationalDispositionForError(error: unknown): OperationalFailureCategory {
  return error instanceof OperationalDispositionError ? error.category : "sandbox-exited";
}

export async function runBenchmarkExecutionOnce(
  run: () => Promise<void>,
  inspect: () => Promise<TerminalDisposition>
): Promise<TerminalDisposition | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    let disposition: TerminalDisposition;
    try {
      disposition = await inspect();
    } catch {
      throw error;
    }
    if (disposition.kind !== "genuine-task-failures") throw error;
    return disposition;
  }
}

export function canScoreBenchmarkRow(
  finalStatus: string | undefined,
  disposition: TerminalDisposition | undefined
): boolean {
  return finalStatus === "succeeded" || (finalStatus === "failed" && disposition?.kind === "genuine-task-failures");
}
