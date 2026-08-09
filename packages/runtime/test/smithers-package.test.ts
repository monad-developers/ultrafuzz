import assert from "node:assert/strict";
import test from "node:test";

import { assertSmithersPackageManifest, renderSmithersPackageJson } from "../src/smithers-package.js";

function currentManifest(): Record<string, unknown> {
  return JSON.parse(renderSmithersPackageJson()) as Record<string, unknown>;
}

test("the generated Smithers package manifest is the one accepted current document", () => {
  assert.doesNotThrow(() => assertSmithersPackageManifest(currentManifest()));
});

test("historical Smithers dependency manifests fail instead of being migrated", () => {
  const manifest = currentManifest();
  manifest.dependencies = {
    ...(manifest.dependencies as Record<string, unknown>),
    "smithers-orchestrator": "0.31.0"
  };

  assert.throws(() => assertSmithersPackageManifest(manifest), /must retain Ultrafuzz's exact runner versions/u);
});

test("Smithers package manifests reject extra root, dependency, and override fields", () => {
  const mutations: Array<(manifest: Record<string, unknown>) => void> = [
    (manifest) => {
      manifest.scripts = { custom: "node custom.js" };
    },
    (manifest) => {
      (manifest.dependencies as Record<string, unknown>)["custom-agent-package"] = "1.2.3";
    },
    (manifest) => {
      (manifest.overrides as Record<string, unknown>)["custom-build-package"] = "2.3.4";
    }
  ];

  for (const mutate of mutations) {
    const manifest = currentManifest();
    mutate(manifest);
    assert.throws(() => assertSmithersPackageManifest(manifest), /must retain Ultrafuzz's exact runner versions/u);
  }
});
