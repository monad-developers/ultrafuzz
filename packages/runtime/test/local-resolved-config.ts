import fs from "node:fs";
import path from "node:path";

import { resolveConfig, serializeResolvedConfigJsonBytes } from "@ultrafuzz/config";

/**
 * Publish the default local config as the run's `smithers/resolved-config.json`, as launch does.
 * Resume reads the run's execution mode from that file, so a hand-built run needs one to continue.
 */
export function writeLocalResolvedConfig(runRoot: string): void {
  const resolved = resolveConfig({ env: {} });
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  fs.writeFileSync(
    path.join(runRoot, "smithers", "resolved-config.json"),
    serializeResolvedConfigJsonBytes(resolved.value)
  );
}
