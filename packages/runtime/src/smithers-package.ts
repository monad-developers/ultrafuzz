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

export const REQUIRED_SMITHERS_OVERRIDES: Readonly<Record<string, string>> = {
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

// When each pinned version above reached npm. This is the input to the
// resolution cutoff below, and the reason a pin bump cannot silently leave the
// cutoff behind: `assertSmithersResolutionCutoff`, which the suite runs, demands
// an entry for every `name@version` the manifest pins, so raising a pin without
// recording its publish instant fails the build rather than a launch.
const SMITHERS_PIN_PUBLISH_TIMES: Readonly<Record<string, string>> = {
  "@effect/opentelemetry@4.0.0-beta.102": "2026-07-26T22:24:29.050Z",
  "@effect/platform-bun@4.0.0-beta.102": "2026-07-26T22:24:35.293Z",
  "@effect/platform-node-shared@4.0.0-beta.102": "2026-07-26T22:24:39.301Z",
  "@effect/sql-sqlite-bun@4.0.0-beta.102": "2026-07-26T22:24:42.599Z",
  "@moonshot-ai/kimi-code@0.29.1": "2026-07-24T05:27:08.545Z",
  "effect@4.0.0-beta.102": "2026-07-26T22:24:42.705Z",
  "smithers-orchestrator@0.32.0": "2026-08-01T05:00:25.735Z",
  "typescript@6.0.3": "2026-04-16T23:38:27.905Z",
  "zod@4.4.3": "2026-05-04T07:06:40.819Z"
};

// The pin list above closes the hazard one package at a time, and only for
// packages that have already broken a run. What it cannot cover is the rest of
// the transitive closure: the generated workspace installs with
// `--package-lock=false`, so every open range below the pins re-resolves against
// whatever npm holds at that instant. Two costs follow. A version published
// minutes ago can be selected before its tarball has propagated to the CDN edge
// the container talks to, and npm reports that gap as a hard E404 -- R54 lost a
// whole generation at workflow submission to `@ai-sdk/provider@4.0.7`, published
// 2m08s earlier. Quieter but worse, two runs from the *same* image launched hours
// apart install different trees, so a benchmark comparing runs against a fixed
// ground truth is not comparing like with like.
//
// The general rule, in place of extending the pin list a name at a time: resolve
// the whole tree as of a fixed instant. `npm install --before` ignores every
// version published after it, so resolution depends on the manifest and this
// constant, not on the wall clock -- which is exactly what an in-flight resume
// needs, and it needs no lockfile in the run workspace, so `--package-lock=false`
// and the generated manifest is current-only.
//
// The rule for moving it: the next UTC midnight after the newest pin above. It
// must never precede a pinned version's own publish instant -- npm would fail to
// find the pin at all -- and dating it a day back keeps every selectable tarball
// well past propagation.
export const SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF = "2026-08-02T00:00:00Z";

/**
 * Fails when a pinned version has no recorded publish instant, or when the
 * resolution cutoff predates one -- either way `npm install --before` could not
 * install the pin it was handed.
 */
export function assertSmithersResolutionCutoff(): void {
  const cutoff = Date.parse(SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF);
  if (Number.isNaN(cutoff)) {
    throw new Error(
      `Smithers dependency resolution cutoff is not a valid instant: ${SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF}`
    );
  }
  for (const [name, version] of pinnedSmithersVersions()) {
    const published = SMITHERS_PIN_PUBLISH_TIMES[`${name}@${version}`];
    if (published === undefined) {
      throw new Error(
        `pinned Smithers dependency ${name}@${version} has no recorded publish instant; record it and move SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF past it`
      );
    }
    if (Date.parse(published) > cutoff) {
      throw new Error(
        `SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF ${SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF} predates ${name}@${version}, published ${published}`
      );
    }
  }
}

function* pinnedSmithersVersions(): Generator<readonly [string, string]> {
  for (const section of Object.values(REQUIRED_SMITHERS_DEPENDENCIES)) {
    for (const [name, version] of Object.entries(section)) {
      yield [name, version] as const;
    }
  }
}

export interface SmithersInstallCommandOptions {
  /** Directory holding the generated workspace manifest, passed to `npm --prefix`. */
  readonly prefix: string;
  /** Registry to install from; omitted, npm uses the ambient configuration. */
  readonly registry?: string;
}

/**
 * The argv both installers of the generated workspace run. Shared so the
 * resolution cutoff cannot be present on one path and missing on the other.
 */
export function smithersDependencyInstallArgs({ prefix, registry }: SmithersInstallCommandOptions): string[] {
  return [
    "install",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--package-lock=false",
    `--before=${SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF}`,
    ...(registry === undefined ? [] : [`--registry=${registry}`]),
    "--no-audit",
    "--no-fund",
    "--loglevel=error"
  ];
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["name", "private", "type", "dependencies", "devDependencies", "overrides"]) ||
    value.name !== "ultrafuzz-smithers" ||
    value.private !== true ||
    value.type !== "module"
  ) {
    throw modifiedManifestError();
  }
  for (const [section, expected] of Object.entries(REQUIRED_SMITHERS_DEPENDENCIES)) {
    const actual = value[section];
    const validSection =
      isRecord(actual) &&
      (section === "dependencies" ? hasDependencyEntries(actual) : hasExactKeys(actual, Object.keys(expected)));
    if (!validSection) {
      throw modifiedManifestError();
    }
    for (const [name, version] of Object.entries(expected)) {
      if (actual[name] !== version) {
        throw modifiedManifestError();
      }
    }
  }
}

function modifiedManifestError(): Error {
  return new Error(
    "generated workflow dependency manifest must retain Ultrafuzz's exact runner versions; recreate it before launch"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function hasDependencyEntries(value: Record<string, unknown>): boolean {
  return Object.entries(value).every(
    ([name, version]) =>
      name.length > 0 &&
      name.trim() === name &&
      typeof version === "string" &&
      version.length > 0 &&
      version.trim() === version
  );
}
