/**
 * Wraps a test body so it runs under Ubuntu's default umask, 0002, whatever
 * the runner's umask is, and restores the runner's umask afterwards.
 *
 * CI runners use 022, but under 0002 every directory created without an
 * explicit mode is group writable. A check that refuses group-writable
 * directories then fails only on such hosts, so tests of directories a check
 * requires pin this umask themselves.
 */
export function underGroupWritableUmask<T>(operation: () => T | Promise<T>): () => Promise<T> {
  return async () => {
    const previous = process.umask(0o002);
    try {
      return await operation();
    } finally {
      process.umask(previous);
    }
  };
}
