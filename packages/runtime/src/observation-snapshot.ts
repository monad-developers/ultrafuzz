const DEFAULT_OBSERVATION_SNAPSHOT_ATTEMPTS = 3;

export function retryTransientSnapshotRead<T>(
  read: () => T,
  attempts: number = DEFAULT_OBSERVATION_SNAPSHOT_ATTEMPTS
): T {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error("observation snapshot attempts must be a positive safe integer");
  }
  let lastRace: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return read();
    } catch (error) {
      if (!isTransientSnapshotRace(error)) throw error;
      lastRace = error;
    }
  }
  throw new Error(`run evidence changed during ${String(attempts)} consecutive snapshot read attempts`, {
    cause: lastRace
  });
}

function isTransientSnapshotRace(error: unknown): boolean {
  return error instanceof Error && error.message.includes("file changed while it was read");
}
