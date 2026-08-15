import crypto from "node:crypto";
import nodeTest from "node:test";

const RUNTIME_TEST_SHARD_ENV = "ULTRAFUZZ_RUNTIME_TEST_SHARD";
const MAX_RUNTIME_TEST_SHARDS = 32;

export interface RuntimeTestShard {
  index: number;
  total: number;
}

export function parseRuntimeTestShard(value: string | undefined): RuntimeTestShard | undefined {
  if (value === undefined) return undefined;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(value);
  if (match === null) throw new Error(`${RUNTIME_TEST_SHARD_ENV} must use the form index/total`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total > MAX_RUNTIME_TEST_SHARDS) {
    throw new Error(`${RUNTIME_TEST_SHARD_ENV} must select at most ${MAX_RUNTIME_TEST_SHARDS} shards`);
  }
  if (index > total) throw new Error(`${RUNTIME_TEST_SHARD_ENV} index must not exceed its total`);
  return { index, total };
}

export function runtimeTestShardForName(name: string, total: number): number {
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_RUNTIME_TEST_SHARDS) {
    throw new Error(`runtime test shard total must be between 1 and ${MAX_RUNTIME_TEST_SHARDS}`);
  }
  const digest = crypto.createHash("sha256").update(name, "utf8").digest();
  return (digest.readUInt32BE(0) % total) + 1;
}

const selectedShard = parseRuntimeTestShard(process.env[RUNTIME_TEST_SHARD_ENV]);

/**
 * Registers every runtime test in normal local runs. Release validation may
 * select one deterministic shard so the large integration file can run on
 * separate GitHub-hosted runners without changing test semantics.
 */
export const test = ((name: string, ...args: unknown[]) => {
  if (selectedShard === undefined || runtimeTestShardForName(name, selectedShard.total) === selectedShard.index) {
    return Reflect.apply(nodeTest, undefined, [name, ...args]);
  }

  const reason = `assigned to runtime test shard ${runtimeTestShardForName(name, selectedShard.total)}/${selectedShard.total}`;
  if (typeof args[0] === "function") {
    return Reflect.apply(nodeTest, undefined, [name, { skip: reason }, args[0]]);
  }
  if (args[0] !== null && typeof args[0] === "object") {
    return Reflect.apply(nodeTest, undefined, [name, { ...args[0], skip: reason }, args[1]]);
  }
  throw new Error(`runtime test ${JSON.stringify(name)} has an unsupported registration shape`);
}) as typeof nodeTest;
