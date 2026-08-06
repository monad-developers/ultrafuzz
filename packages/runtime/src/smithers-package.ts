export const SMITHERS_ORCHESTRATOR_VERSION = "0.32.0";
export const SMITHERS_ORCHESTRATOR_PACKAGE_NAME = "smithers-orchestrator";
// Upstream renamed the npm package after 0.32.0, the newest release published
// under the name Ultrafuzz pins. Nothing further will ever ship as
// `smithers-orchestrator`, so any future upgrade means moving to this name.
export const SMITHERS_SUCCESSOR_PACKAGE_NAME = "smthrs";
export const SMITHERS_ORCHESTRATOR_BIN_PATH = "src/bin/smithers.js";
// Smithers 0.32.0 migrated its runtime from Effect 3 to Effect 4 and pins
// exactly this version across its own packages. Track what Smithers declares:
// left unpinned, npm installs two Effect copies side by side and the engine
// loses the single Effect module identity its services are keyed on.
export const SMITHERS_EFFECT_VERSION = "4.0.0-beta.102";
export const KIMI_CODE_VERSION = "0.29.1";

// The `@effect/*` packages Smithers pulls in must be pinned alongside Effect
// itself, not just deduplicated. `@effect/platform-bun` asks for
// `@effect/platform-node-shared: ^4.0.0-beta.102`, an open caret over
// prereleases, and the generated workspace is installed with
// `--package-lock=false`. Unpinned, two cloud containers resuming the same run
// at different times install different `@effect/*` builds, and a newer beta that
// needs Effect APIs absent from the pinned core breaks every run including
// in-flight resumes. Every entry below publishes at SMITHERS_EFFECT_VERSION and
// peers `^4.0.0-beta.102`, so the pinned set is internally consistent.
const SMITHERS_EFFECT_PACKAGE_NAMES = [
  "@effect/opentelemetry",
  "@effect/platform-bun",
  "@effect/platform-node-shared",
  "@effect/sql-sqlite-bun"
] as const;

const REQUIRED_SMITHERS_OVERRIDES: Readonly<Record<string, string>> = {
  effect: SMITHERS_EFFECT_VERSION,
  ...Object.fromEntries(SMITHERS_EFFECT_PACKAGE_NAMES.map((name) => [name, SMITHERS_EFFECT_VERSION]))
};

const REQUIRED_SMITHERS_DEPENDENCIES = {
  dependencies: {
    "@moonshot-ai/kimi-code": KIMI_CODE_VERSION,
    "smithers-orchestrator": SMITHERS_ORCHESTRATOR_VERSION,
    zod: "4.4.3"
  },
  devDependencies: {
    typescript: "6.0.3"
  },
  overrides: REQUIRED_SMITHERS_OVERRIDES
} as const;

const UNOVERRIDDEN_SMITHERS_DEPENDENCIES = {
  dependencies: REQUIRED_SMITHERS_DEPENDENCIES.dependencies,
  devDependencies: REQUIRED_SMITHERS_DEPENDENCIES.devDependencies
} as const;

/** Manifest sections keyed by name, so one comparison covers deps and overrides. */
type SmithersManifestSections = Readonly<Record<string, Readonly<Record<string, string>>>>;

interface SmithersDependencyShape extends SmithersManifestSections {
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
  // A manifest already carrying the current runner but an incomplete override
  // block still has to migrate: that is how a project root written before an
  // override was added, or before one was retargeted, picks the new pin up.
  const staleRequiredOverrides =
    isRecord(value) &&
    hasRequiredVersions(value, UNOVERRIDDEN_SMITHERS_DEPENDENCIES) &&
    !hasRequiredVersions(value, { overrides: REQUIRED_SMITHERS_OVERRIDES });
  if (
    !isRecord(value) ||
    value.name !== "ultrafuzz-smithers" ||
    value.private !== true ||
    value.type !== "module" ||
    (!SUPERSEDED_SMITHERS_DEPENDENCIES.some((dependencies) => hasRequiredVersions(value, dependencies)) &&
      !staleRequiredOverrides)
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

function hasRequiredVersions(value: Record<string, unknown>, required: SmithersManifestSections): boolean {
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
