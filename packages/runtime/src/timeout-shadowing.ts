import type { ResolvedConfig } from "@ultrafuzz/config";
import type { ExpandedGraph, ProjectTopology } from "@ultrafuzz/topology";

import type { RuntimeDiagnostic } from "./types.js";

/**
 * Warn about each topology `timeout_seconds` pin below the default it overrides (#675).
 *
 * A node's timeout resolves to its own pin, then its group's pin, then its model profile's
 * `timeout_seconds`, then `run.default_timeout_seconds`. A pin therefore wins even when it is the
 * shorter window, so raising the profile or run default silently does not reach a pinned node, as
 * when #645 raised the profile default and the packaged `goals` and `strategies` group pins kept
 * those nodes at 7200 seconds. Each pin is reported once, with the largest default it overrides and
 * the agentic nodes it applies to.
 */
export function timeoutShadowingDiagnostics(
  topology: ProjectTopology,
  expanded: ExpandedGraph,
  config: ResolvedConfig
): RuntimeDiagnostic[] {
  const topologyNodes = new Map(topology.nodes.map((node) => [node.id, node]));
  const pins = new Map<
    string,
    {
      label: string;
      path: string;
      fallback: string | undefined;
      seconds: number;
      shadowed: { seconds: number; source: string };
      nodes: Set<string>;
    }
  >();
  for (const node of expanded.nodes) {
    const pinned = node.timeoutSeconds;
    const declared = topologyNodes.get(node.logicalId);
    if (node.kind !== "agentic" || pinned === undefined || declared === undefined) continue;
    const groupPin =
      declared.group === undefined ? undefined : topology.groups?.[declared.group]?.defaults?.timeout_seconds;
    const pin =
      declared.timeout_seconds === undefined && declared.group !== undefined
        ? {
            key: `group:${declared.group}`,
            label: `group \`${declared.group}\``,
            path: `groups.${declared.group}.defaults.timeout_seconds`,
            fallback: undefined
          }
        : {
            key: `node:${declared.id}`,
            label: `node \`${declared.id}\``,
            path: `nodes.${declared.id}.timeout_seconds`,
            // Removing a node pin inside a group that pins falls back to the group's pin, not the default.
            fallback:
              declared.group === undefined || groupPin === undefined
                ? undefined
                : `\`groups.${declared.group}.defaults.timeout_seconds\`=${String(groupPin)}`
          };
    // The default task compilation would apply without the pin: the profile's own timeout, else the
    // run default. Expansion folds the run default into each fan-out entry, so read the profile itself.
    const profileIds = node.modelFanout.length === 0 ? [undefined] : node.modelFanout.map((m) => m.modelProfileId);
    for (const profileId of profileIds) {
      const profileTimeout = profileId === undefined ? undefined : config.models.profiles[profileId]?.timeoutSeconds;
      const shadowed =
        profileId === undefined || profileTimeout === undefined
          ? { seconds: config.run.defaultTimeoutSeconds, source: "`run.default_timeout_seconds`" }
          : { seconds: profileTimeout, source: `model profile \`${profileId}\` \`timeout_seconds\`` };
      if (shadowed.seconds <= pinned) continue;
      const entry = pins.get(pin.key) ?? { ...pin, seconds: pinned, shadowed, nodes: new Set<string>() };
      if (shadowed.seconds > entry.shadowed.seconds) entry.shadowed = shadowed;
      entry.nodes.add(declared.id);
      pins.set(pin.key, entry);
    }
  }
  return [...pins.values()].map((pin) => {
    const nodes = [...pin.nodes].sort();
    const named = nodes.slice(0, 3).join(", ");
    const applies = nodes.length > 3 ? `${named} and ${String(nodes.length - 3)} more nodes` : named;
    const remedy =
      pin.fallback === undefined
        ? "Raise or remove the pin to use the longer default."
        : `Raise the pin, or remove it to fall back to ${pin.fallback}.`;
    return {
      code: "TOPOLOGY_TIMEOUT_SHADOWS_DEFAULT",
      message: `topology ${pin.label} pins timeout_seconds=${String(pin.seconds)}, below ${pin.shadowed.source}=${String(pin.shadowed.seconds)}; the pin wins, so ${applies} time out after ${String(pin.seconds)} seconds. ${remedy}`,
      severity: "warning",
      source: "topology",
      path: pin.path
    };
  });
}
