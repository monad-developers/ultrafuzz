import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

import { topologyError } from "./errors.js";
import { ensureNoSymlinkComponents } from "./path-utils.js";
import { validateTopology } from "./validate.js";
import { PROJECT_TOPOLOGY_FILE } from "./types.js";
import type { ProjectTopology, TopologyValidationOptions } from "./types.js";

export interface LoadTopologyOptions extends TopologyValidationOptions {
  topologyPath?: string;
  validate?: boolean;
}

export function resolveTopologyPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_TOPOLOGY_FILE);
}

export function loadTopology(projectRoot: string, options: LoadTopologyOptions = {}): ProjectTopology {
  const filePath = options.topologyPath ?? resolveTopologyPath(projectRoot);
  try {
    lstatSync(filePath);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      throw topologyError("MISSING_TOPOLOGY", `Missing topology at ${filePath}`, { path: filePath });
    }
    throw topologyError("TOPOLOGY_IO", `Failed to inspect topology at ${filePath}`, {
      path: filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  ensureNoSymlinkComponents(filePath);
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    throw topologyError("TOPOLOGY_IO", `Failed to read topology at ${filePath}`, {
      path: filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  let parsed: unknown;
  try {
    parsed = parse(contents);
  } catch (error) {
    throw topologyError("TOPOLOGY_PARSE", `Failed to parse topology YAML at ${filePath}`, {
      path: filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  if (options.validate !== false) {
    validateTopology(parsed, { ...options, projectRoot });
  }
  return parsed as ProjectTopology;
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
