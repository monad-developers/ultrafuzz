import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSmithersPackageManifest,
  migrateStockSmithers032PackageManifest,
  renderSmithersPackageJson
} from "../src/smithers-package.js";

function currentManifest(): Record<string, unknown> {
  return JSON.parse(renderSmithersPackageJson()) as Record<string, unknown>;
}

test("the generated Smithers package manifest is the one accepted current document", () => {
  assert.doesNotThrow(() => assertSmithersPackageManifest(currentManifest()));
});

test("non-stock historical Smithers dependency manifests fail instead of being migrated", () => {
  const manifest = currentManifest();
  manifest.dependencies = {
    ...(manifest.dependencies as Record<string, unknown>),
    smthrs: "0.31.0"
  };

  assert.throws(() => assertSmithersPackageManifest(manifest), /must retain Ultrafuzz's exact runner versions/u);
});

test("the exact 0.32 generated manifest migrates once and preserves package extensions", () => {
  const historical = currentManifest();
  historical.dependencies = {
    "@moonshot-ai/kimi-code": "0.29.1",
    "smithers-orchestrator": "0.32.0",
    zod: "4.4.3",
    "custom-agent-package": "1.2.3"
  };
  historical.overrides = {
    effect: "4.0.0-beta.102",
    "@effect/opentelemetry": "4.0.0-beta.102",
    "@effect/platform-bun": "4.0.0-beta.102",
    "@effect/platform-node-shared": "4.0.0-beta.102",
    "@effect/sql-sqlite-bun": "4.0.0-beta.102",
    "custom-transitive-package": "3.4.5"
  };

  const migratedText = migrateStockSmithers032PackageManifest(historical);
  assert.ok(migratedText);
  const migrated = JSON.parse(migratedText) as Record<string, Record<string, unknown>>;
  assert.equal(migrated.dependencies?.["smithers-orchestrator"], undefined);
  assert.equal(migrated.dependencies?.smthrs, "0.34.0");
  assert.equal(migrated.dependencies?.["custom-agent-package"], "1.2.3");
  assert.equal(migrated.overrides?.["custom-transitive-package"], "3.4.5");
  assert.doesNotThrow(() => assertSmithersPackageManifest(migrated));

  (historical.dependencies as Record<string, unknown>).smthrs = "0.33.0";
  assert.equal(migrateStockSmithers032PackageManifest(historical), undefined);
});

test("Smithers package manifests preserve typed package extension points but reject wider execution fields", () => {
  const withCustomPackages = currentManifest();
  (withCustomPackages.dependencies as Record<string, unknown>)["custom-agent-package"] = "1.2.3";
  (withCustomPackages.devDependencies as Record<string, unknown>)["custom-build-package"] = "2.3.4";
  (withCustomPackages.overrides as Record<string, unknown>)["custom-transitive-package"] = "3.4.5";
  assert.doesNotThrow(() => assertSmithersPackageManifest(withCustomPackages));

  const mutations: Array<(manifest: Record<string, unknown>) => void> = [
    (manifest) => {
      manifest.scripts = { custom: "node custom.js" };
    },
    (manifest) => {
      (manifest.dependencies as Record<string, unknown>)[" "] = "1.2.3";
    },
    (manifest) => {
      (manifest.dependencies as Record<string, unknown>)["custom-agent-package"] = " ";
    },
    (manifest) => {
      (manifest.dependencies as Record<string, unknown>)["custom-agent-package"] = 123;
    },
    (manifest) => {
      (manifest.devDependencies as Record<string, unknown>)["custom-build-package"] = 234;
    },
    (manifest) => {
      (manifest.overrides as Record<string, unknown>)["custom-transitive-package"] = 345;
    }
  ];

  for (const mutate of mutations) {
    const manifest = currentManifest();
    mutate(manifest);
    assert.throws(() => assertSmithersPackageManifest(manifest), /must retain Ultrafuzz's exact runner versions/u);
  }
});
