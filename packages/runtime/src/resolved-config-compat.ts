import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import {
  createDefaultResolvedConfig,
  parseResolvedConfigJsonBytes,
  RESOLVED_CONFIG_SCHEMA_VERSION,
  type ResolvedConfig
} from "@ultrafuzz/config";

const LEGACY_RESOLVED_CONFIG_SCHEMA_VERSION = "ultrafuzz.resolved-config.v3";
const MAX_RESOLVED_CONFIG_BYTES = 4 * 1024 * 1024;

/**
 * Read an immutable execution snapshot across the v3 -> v4 resource-budget
 * boundary. New persisted documents remain current-only v4. This narrow
 * execution migration validates the entire transformed document as v4 and
 * supplies controller defaults only for the one field that v3 did not have,
 * allowing already-sealed runs to be synchronized or resumed after upgrade.
 */
export function parseExecutionResolvedConfigJsonBytes(bytes: Uint8Array): ResolvedConfig {
  try {
    return parseResolvedConfigJsonBytes(bytes);
  } catch (currentError) {
    const parsed = parseStrictJsonBytes(bytes, {
      maxBytes: MAX_RESOLVED_CONFIG_BYTES,
      maxDepth: 64,
      maxItems: 100_000,
      maxProperties: 100_000
    });
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).schemaVersion !== LEGACY_RESOLVED_CONFIG_SCHEMA_VERSION
    ) {
      throw currentError;
    }
    const legacy = parsed as Record<string, unknown>;
    const run = legacy.run;
    if (run === null || typeof run !== "object" || Array.isArray(run) || Object.hasOwn(run, "resourceBudget")) {
      throw currentError;
    }
    const migrated = {
      ...legacy,
      schemaVersion: RESOLVED_CONFIG_SCHEMA_VERSION,
      run: {
        ...(run as Record<string, unknown>),
        resourceBudget: createDefaultResolvedConfig().run.resourceBudget
      }
    };
    return parseResolvedConfigJsonBytes(Buffer.from(`${JSON.stringify(migrated)}\n`, "utf8"));
  }
}
