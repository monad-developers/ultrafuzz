export class StatisticsSnapshotRaceError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "StatisticsSnapshotRaceError";
  }
}

export interface CapturedStatisticsSnapshot<T> {
  snapshot: T;
  capturedAtMs: number;
}

export function captureCoherentStatisticsSnapshot<T>(
  read: () => T,
  equal: (left: T, right: T) => boolean,
  attempts: number,
  clock: () => number = Date.now
): CapturedStatisticsSnapshot<T> {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error("statistics snapshot attempts must be a positive safe integer");
  }
  let lastRace: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const first = read();
      const second = read();
      if (equal(first, second)) {
        const capturedAtMs = clock();
        if (!Number.isSafeInteger(capturedAtMs)) {
          throw new Error("statistics snapshot clock must be a safe-integer millisecond timestamp");
        }
        return { snapshot: second, capturedAtMs };
      }
      lastRace = new StatisticsSnapshotRaceError("run evidence changed between snapshot reads");
    } catch (error) {
      if (!isStatisticsSnapshotRace(error)) throw error;
      lastRace = error;
    }
  }
  throw new Error(`run evidence changed during ${attempts} consecutive snapshot attempts`, { cause: lastRace });
}

function isStatisticsSnapshotRace(error: unknown): boolean {
  return (
    error instanceof StatisticsSnapshotRaceError ||
    (error instanceof Error && error.message.includes("file changed while it was read"))
  );
}
