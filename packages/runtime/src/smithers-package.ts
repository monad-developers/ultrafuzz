export const SMITHERS_ORCHESTRATOR_VERSION = "0.32.0";
export const SMITHERS_ORCHESTRATOR_BIN_PATH = "src/bin/smithers.js";
// Smithers 0.32.0 migrated its runtime from Effect 3 to Effect 4 and pins
// `4.0.0-beta.102` across its own packages, but the `@effect/*` packages it
// depends on ask for a newer beta. Left alone, npm installs two Effect copies
// side by side and the engine loses the single Effect module identity its
// services are keyed on, so the generated manifest keeps deduplicating Effect
// onto one version. Track the version Smithers itself declares: it is also what
// pnpm resolves for this workspace, so the repository's Smithers integration
// test exercises the same Effect build that generated cloud runs execute.
export const SMITHERS_EFFECT_VERSION = "4.0.0-beta.102";
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

interface SmithersDependencyShape {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

// Every pinned shape Ultrafuzz has shipped, newest first. A generated manifest
// left behind by an older Ultrafuzz must migrate forward instead of failing the
// launch, because in-flight cloud runs resume against their existing project
// root. Add the outgoing pin here whenever the runner version changes.
const SUPERSEDED_SMITHERS_DEPENDENCIES: readonly SmithersDependencyShape[] = [
  {
    dependencies: { "smithers-orchestrator": "0.31.0", zod: "4.4.3" },
    devDependencies: { typescript: "6.0.3" }
  },
  {
    dependencies: { "smithers-orchestrator": "0.29.0", zod: "4.4.3" },
    devDependencies: { typescript: "6.0.3" }
  },
  {
    dependencies: { "smithers-orchestrator": "0.28.0", zod: "4.4.3" },
    devDependencies: { typescript: "6.0.3" }
  },
  {
    dependencies: { "smithers-orchestrator": "0.27.0", zod: "4.4.3" },
    devDependencies: { typescript: "6.0.3" }
  },
  {
    dependencies: { "smithers-orchestrator": "^0.27.0", zod: "^4.4.3" },
    devDependencies: { typescript: "^6.0.3" }
  }
];

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
    (!SUPERSEDED_SMITHERS_DEPENDENCIES.some((dependencies) => hasRequiredVersions(value, dependencies)) &&
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
  required: SmithersDependencyShape | typeof REQUIRED_SMITHERS_DEPENDENCIES
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
