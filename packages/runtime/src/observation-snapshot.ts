/** How many times an observer reads live run evidence that keeps changing under it before it fails. */
export const OBSERVATION_SNAPSHOT_ATTEMPTS = 3;

/**
 * How the strict readers report live evidence that changed while they read it. The artifacts reader
 * behind the JSONL ledgers says "file changed while it was read: <path>" when a writer appended to the
 * file it held; the workflow-control reader says "<document> changed while reading" when the path was
 * republished by atomic rename. For a caller that holds control authority either is a lock violation
 * and must fail closed. For an observer reading a live run, whose controller keeps appending and
 * republishing, it is a transient race: the next read returns a complete, fully validated snapshot.
 */
const TRANSIENT_SNAPSHOT_RACE_MARKERS = ["file changed while it was read", "changed while reading"];

/**
 * Re-run an observation that performs several strict reads internally and surfaces the race by
 * rejecting. Every attempt runs `observe` in full, so each retry repeats the strict open, size,
 * identity, parse, schema and semantic checks and no unvalidated snapshot is ever returned. Only the
 * race above is retried; every other failure propagates from the first attempt. The budget is bounded,
 * so evidence under continuous change still fails, with the last race's message (and so the offending
 * path) preserved in the rejection.
 */
export async function retryTransientSnapshotObservation<T>(
  observe: () => Promise<T>,
  attempts: number = OBSERVATION_SNAPSHOT_ATTEMPTS
): Promise<T> {
  assertSnapshotAttempts(attempts);
  let lastRace: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await observe();
    } catch (error) {
      if (!isTransientSnapshotRace(error)) throw error;
      lastRace = error;
    }
  }
  throw exhaustedSnapshotRaceError(attempts, lastRace);
}

/**
 * Whether `error` reports the transient replacement race. The exhausted-budget error carries the
 * last race's message, so it satisfies this predicate too: a caller that has already spent the
 * budget can recognise the outcome and degrade instead of failing.
 */
export function isTransientSnapshotRace(error: unknown): error is Error {
  return error instanceof Error && isTransientSnapshotRaceMessage(error.message);
}

/** Whether a message (an error's, or a divergence an observer collected) reports the race. */
export function isTransientSnapshotRaceMessage(message: string): boolean {
  return TRANSIENT_SNAPSHOT_RACE_MARKERS.some((marker) => message.includes(marker));
}

function assertSnapshotAttempts(attempts: number): void {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error("observation snapshot attempts must be a positive safe integer");
  }
}

/** The failure an observer reports once `attempts` consecutive reads all raced; names the last racing document. */
export function exhaustedSnapshotRaceError(attempts: number, lastRace: unknown): Error {
  const detail = lastRace instanceof Error ? lastRace.message : String(lastRace);
  return new Error(`run evidence changed during ${String(attempts)} consecutive snapshot read attempts: ${detail}`, {
    cause: lastRace
  });
}
