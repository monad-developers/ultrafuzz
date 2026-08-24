import YAML from "yaml";
import { isRecord } from "@ultrafuzz/artifacts";

export function topologyWithStrategyLoops(source: string, loops: number): string {
  if (!Number.isSafeInteger(loops) || loops <= 0 || loops > 256) {
    throw new Error("Modal benchmark loops must be a positive integer no greater than 256");
  }
  const document = YAML.parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error("failed to parse target topology");
  }
  const value = document.toJS() as unknown;
  if (!isRecord(value)) {
    throw new Error("target topology must be an object");
  }

  const topology = { ...value };
  topology.defaults = { ...(isRecord(topology.defaults) ? topology.defaults : {}), strategy_loops: loops };
  const groups = { ...(isRecord(topology.groups) ? topology.groups : {}) };
  const strategies = { ...(isRecord(groups.strategies) ? groups.strategies : {}) };
  strategies.defaults = { ...(isRecord(strategies.defaults) ? strategies.defaults : {}), loops };
  groups.strategies = strategies;
  topology.groups = groups;
  return YAML.stringify(topology);
}
