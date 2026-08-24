/** Closed public benchmark lane identity shared by manifests and retained schemas. */
export const BENCHMARK_LANE_NAMES = ["smoke", "threat-model", "full"] as const;

export type BenchmarkLaneName = (typeof BENCHMARK_LANE_NAMES)[number];

/** Packaged audit profile executed by each public benchmark lane. */
export function publicBenchmarkLaneAuditProfileId(lane: BenchmarkLaneName): "smoke" | "exhaustive" {
  return lane === "smoke" ? "smoke" : "exhaustive";
}
