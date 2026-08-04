export const SMITHERS_ORCHESTRATOR_VERSION = "0.31.0";
export const SMITHERS_ORCHESTRATOR_BIN_PATH = "src/bin/smithers.js";
export const SMITHERS_EFFECT_VERSION = "3.21.4";
export const KIMI_CODE_VERSION = "0.29.1";

const REQUIRED_SMITHERS_DEPENDENCIES = {
  dependencies: {
    "@moonshot-ai/kimi-code": KIMI_CODE_VERSION,
    "smithers-orchestrator": SMITHERS_ORCHESTRATOR_VERSION,
    zod: "4.4.3"
  },
  devDependencies: {
    typescript: "6.0.3"
  },
  overrides: {
    effect: SMITHERS_EFFECT_VERSION
  }
} as const;

const UNOVERRIDDEN_SMITHERS_DEPENDENCIES = {
  dependencies: REQUIRED_SMITHERS_DEPENDENCIES.dependencies,
  devDependencies: REQUIRED_SMITHERS_DEPENDENCIES.devDependencies
} as const;

const LEGACY_SMITHERS_DEPENDENCIES = {
  dependencies: {
    "smithers-orchestrator": "^0.27.0",
    zod: "^4.4.3"
  },
  devDependencies: {
    typescript: "^6.0.3"
  }
} as const;

const PREVIOUS_SMITHERS_DEPENDENCIES = {
  dependencies: {
    "smithers-orchestrator": "0.29.0",
    zod: "4.4.3"
  },
  devDependencies: {
    typescript: "6.0.3"
  }
} as const;

const OLDER_EXACT_SMITHERS_DEPENDENCIES = {
  dependencies: {
    "smithers-orchestrator": "0.28.0",
    zod: "4.4.3"
  },
  devDependencies: {
    typescript: "6.0.3"
  }
} as const;

const OLDEST_EXACT_SMITHERS_DEPENDENCIES = {
  dependencies: {
    "smithers-orchestrator": "0.27.0",
    zod: "4.4.3"
  },
  devDependencies: {
    typescript: "6.0.3"
  }
} as const;

export interface SmithersPackageMigration {
  manifest: unknown;
  migrated: boolean;
}

export function renderSmithersPackageJson(): string {
  return `${JSON.stringify(
    {
      name: "ultrafuzz-smithers",
      private: true,
      type: "module",
      ...REQUIRED_SMITHERS_DEPENDENCIES
    },
    null,
    2
  )}\n`;
}

export function assertSmithersPackageManifest(value: unknown): void {
  if (!isRecord(value)) {
    throw modifiedManifestError();
  }
  for (const [section, expected] of Object.entries(REQUIRED_SMITHERS_DEPENDENCIES)) {
    const actual = value[section];
    if (!isRecord(actual)) {
      throw modifiedManifestError();
    }
    for (const [name, version] of Object.entries(expected)) {
      if (actual[name] !== version) {
        throw modifiedManifestError();
      }
    }
  }
}

export function migrateLegacySmithersPackageManifest(value: unknown): SmithersPackageMigration {
  const missingRequiredEffectOverride =
    isRecord(value) &&
    hasRequiredVersions(value, UNOVERRIDDEN_SMITHERS_DEPENDENCIES) &&
    (!isRecord(value.overrides) || value.overrides.effect === undefined);
  if (
    !isRecord(value) ||
    value.name !== "ultrafuzz-smithers" ||
    value.private !== true ||
    value.type !== "module" ||
    (![
      PREVIOUS_SMITHERS_DEPENDENCIES,
      OLDER_EXACT_SMITHERS_DEPENDENCIES,
      OLDEST_EXACT_SMITHERS_DEPENDENCIES,
      LEGACY_SMITHERS_DEPENDENCIES
    ].some((dependencies) => hasRequiredVersions(value, dependencies)) &&
      !missingRequiredEffectOverride)
  ) {
    return { manifest: value, migrated: false };
  }
  const dependencies = value.dependencies as Record<string, unknown>;
  const devDependencies = value.devDependencies as Record<string, unknown>;
  return {
    manifest: {
      ...value,
      dependencies: {
        ...dependencies,
        ...REQUIRED_SMITHERS_DEPENDENCIES.dependencies
      },
      devDependencies: {
        ...devDependencies,
        ...REQUIRED_SMITHERS_DEPENDENCIES.devDependencies
      },
      overrides: {
        ...(isRecord(value.overrides) ? value.overrides : {}),
        ...REQUIRED_SMITHERS_DEPENDENCIES.overrides
      }
    },
    migrated: true
  };
}

function hasRequiredVersions(
  value: Record<string, unknown>,
  required:
    | typeof REQUIRED_SMITHERS_DEPENDENCIES
    | typeof PREVIOUS_SMITHERS_DEPENDENCIES
    | typeof OLDER_EXACT_SMITHERS_DEPENDENCIES
    | typeof OLDEST_EXACT_SMITHERS_DEPENDENCIES
    | typeof LEGACY_SMITHERS_DEPENDENCIES
    | typeof UNOVERRIDDEN_SMITHERS_DEPENDENCIES
): boolean {
  for (const [section, expected] of Object.entries(required)) {
    const actual = value[section];
    if (!isRecord(actual)) {
      return false;
    }
    for (const [name, version] of Object.entries(expected)) {
      if (actual[name] !== version) {
        return false;
      }
    }
  }
  return true;
}

function modifiedManifestError(): Error {
  return new Error(
    "generated workflow dependency manifest must retain Ultrafuzz's exact runner versions; recreate it before launch"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
