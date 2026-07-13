const EXPECTED_SMITHERS_PACKAGE = {
  name: "ultrafuzz-smithers",
  private: true,
  type: "module",
  dependencies: {
    "smithers-orchestrator": "0.27.0",
    zod: "4.4.3"
  },
  devDependencies: {
    typescript: "6.0.3"
  }
} as const;

export function renderSmithersPackageJson(): string {
  return `${JSON.stringify(EXPECTED_SMITHERS_PACKAGE, null, 2)}\n`;
}

export function assertSmithersPackageManifest(value: unknown): void {
  if (!sameJsonValue(value, EXPECTED_SMITHERS_PACKAGE)) {
    throw new Error("generated workflow dependency manifest has been modified; recreate it before launch");
  }
}

function sameJsonValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) {
    return true;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return false;
  }
  if (!isRecord(actual) || !isRecord(expected)) {
    return false;
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && sameJsonValue(actual[key], expected[key]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
