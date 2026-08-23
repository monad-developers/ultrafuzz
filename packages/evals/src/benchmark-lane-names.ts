/** Closed public benchmark lane identity shared by manifests and retained schemas. */
export const BENCHMARK_LANE_NAMES = ["smoke", "threat-model", "full"] as const;

export type BenchmarkLaneName = (typeof BENCHMARK_LANE_NAMES)[number];
