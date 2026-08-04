import type { InvariantConfig } from "./types.js";

export type InvariantPropertyPriority = InvariantConfig["propertyPriorityThreshold"];

const INVARIANT_PROPERTY_PRIORITIES: readonly InvariantPropertyPriority[] = ["high", "medium", "low"];

export interface InvariantPropertyPrioritySelection {
  priorities: InvariantPropertyPriority[];
  filter: string;
}

/**
 * Resolve the inclusive priority set represented by the configured threshold.
 * A high threshold selects only high-priority properties; lower thresholds
 * include every more important priority as well.
 */
export function invariantPropertyPrioritySelection(
  threshold: InvariantPropertyPriority
): InvariantPropertyPrioritySelection {
  const cutoff = INVARIANT_PROPERTY_PRIORITIES.indexOf(threshold);
  const priorities = INVARIANT_PROPERTY_PRIORITIES.slice(0, cutoff + 1) as InvariantPropertyPriority[];
  return {
    priorities,
    filter: `properties with priority at or above \`${threshold}\``
  };
}
