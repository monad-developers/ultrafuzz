/** How many times an observer reads live run evidence that keeps being replaced under it before it fails. */
export const OBSERVATION_SNAPSHOT_ATTEMPTS = 3;

/**
 * How the strict readers report an atomic path replacement they straddled: the descriptor they hold
 * is left on the unlinked inode, so its link count drops (or the path now names another inode). The
 * artifacts reader behind `readRunState` and `readRunMetadataDocument` says "file changed while it was
 * read: <path>"; the workflow-control reader says "<document> changed while reading". For a caller
 * that holds control authority either is a lock violation and must fail closed. For an observer
 * reading a live run, whose controller (or another observe-only synchronization) keeps publishing
 * complete documents by atomic rename, it is a transient race: the next read returns a complete,
 * fully validated document.
 */
const TRANSIENT_SNAPSHOT_RACE_MARKERS = ["file changed while it was read", "changed while reading"];

/**
 * Re-read live run evidence that a durable writer replaced while it was being read.
 *
 * Every attempt runs `read` in full, so each retry repeats the strict open, size, identity, parse,
 * schema and semantic checks and no unvalidated snapshot is ever returned. Only the race above is
 * retried; every other failure propagates from the first attempt. The budget is bounded, so evidence
 * under continuous change still fails, with the last race's message (and so the offending path)
 * preserved in the thrown error.
 */
export function retryTransientSnapshotRead<T>(read: () => T, attempts: number = OBSERVATION_SNAPSHOT_ATTEMPTS): T {
  assertSnapshotAttempts(attempts);
  let lastRace: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return read();
    } catch (error) {
      if (!isTransientSnapshotRace(error)) throw error;
      lastRace = error;
    }
  }
  throw exhaustedSnapshotRaceError(attempts, lastRace);
}

/**
 * The asynchronous counterpart of `retryTransientSnapshotRead` for an observation that performs
 * several strict reads internally and surfaces the race by rejecting.
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
