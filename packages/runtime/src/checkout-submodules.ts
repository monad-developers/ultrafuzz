import {
  capturePinnedSubmoduleSnapshot,
  fillSubmoduleDependencyCache,
  pinnedSubmoduleExpectation,
  readPinnedSubmoduleSnapshot,
  writePinnedSubmoduleSnapshot,
  type PinnedSubmoduleExpectation
} from "./pinned-submodules.js";

export type CheckoutSubmoduleExpectation =
  | { expectation: PinnedSubmoduleExpectation | undefined; unavailableReason?: undefined }
  | { expectation: undefined; unavailableReason: string };

/**
 * Capture and authenticate the initialized submodules of an ordinary checkout
 * (#1251), so its task worktrees are hydrated like a pinned run's. A checkout
 * whose submodules cannot be sealed, for example because they are not
 * initialized, are dirty, are not at their gitlinks, or sit behind a local URL
 * rewrite, keeps running without hydration and reports why.
 */
export function checkoutSubmoduleExpectationForProject(projectRoot: string): CheckoutSubmoduleExpectation {
  try {
    const captured = capturePinnedSubmoduleSnapshot(projectRoot, "checkout");
    if (captured === undefined) return { expectation: undefined };
    writePinnedSubmoduleSnapshot(projectRoot, captured);
    // Reading back in checkout mode re-verifies the bytes and rejects local URL rewrites.
    const snapshot = readPinnedSubmoduleSnapshot(projectRoot, "checkout");
    if (snapshot === undefined) throw new Error("checkout submodule manifest was not persisted");
    const expectation = pinnedSubmoduleExpectation(snapshot);
    fillSubmoduleDependencyCache(projectRoot, expectation, "checkout");
    return { expectation };
  } catch (error) {
    return { expectation: undefined, unavailableReason: error instanceof Error ? error.message : String(error) };
  }
}
