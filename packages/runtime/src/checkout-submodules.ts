import { recordCheckoutSubmodules, type PinnedSubmoduleExpectation } from "./pinned-submodules.js";

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
    return { expectation: recordCheckoutSubmodules(projectRoot) };
  } catch (error) {
    return { expectation: undefined, unavailableReason: error instanceof Error ? error.message : String(error) };
  }
}
