import assert from "node:assert/strict";
import test from "node:test";

import {
  MIGRATABLE_PRIOR_SMITHERS_VERSIONS,
  SMITHERS_VERSION,
  assertSmithersPackageManifest,
  migrateStockSmithers032PackageManifest,
  renderSmithersPackageJson
} from "../src/smithers-package.js";

function currentManifest(): Record<string, unknown> {
  return JSON.parse(renderSmithersPackageJson()) as Record<string, unknown>;
}

/** The document `renderSmithersPackageJson` produced under a superseded pin. */
function priorPinManifest(priorSmithersVersion: string): Record<string, unknown> {
  const manifest = currentManifest();
  manifest.dependencies = {
    ...(manifest.dependencies as Record<string, unknown>),
    smthrs: priorSmithersVersion
  };
  return manifest;
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
  assert.equal(migrated.dependencies?.smthrs, SMITHERS_VERSION);
  assert.equal(migrated.dependencies?.["custom-agent-package"], "1.2.3");
  assert.equal(migrated.overrides?.["custom-transitive-package"], "3.4.5");
  assert.doesNotThrow(() => assertSmithersPackageManifest(migrated));

  // The 0.32 shape keeps its own document rather than being normalised onto the
  // freshly rendered one: extension packages survive, and the rewritten pins are
  // the only difference from the input. Generalising the migrator must not turn
  // this path into a wholesale regeneration.
  assert.deepEqual(migrated.dependencies, {
    "@moonshot-ai/kimi-code": "0.29.1",
    zod: "4.4.3",
    "custom-agent-package": "1.2.3",
    smthrs: SMITHERS_VERSION
  });
  assert.deepEqual(migrated.devDependencies, { typescript: "6.0.3" });
  assert.deepEqual(migrated.overrides, {
    effect: "4.0.0-beta.105",
    "@effect/opentelemetry": "4.0.0-beta.105",
    "@effect/platform-bun": "4.0.0-beta.105",
    "@effect/platform-node-shared": "4.0.0-beta.105",
    "@effect/sql-sqlite-bun": "4.0.0-beta.105",
    "custom-transitive-package": "3.4.5"
  });

  // A 0.32 document that already carries a foreign `smthrs` pin is still refused
  // by the 0.32 path, and the prior-pin path must not rescue it: it still names
  // `smithers-orchestrator`, so it is not a document Ultrafuzz ever generated.
  (historical.dependencies as Record<string, unknown>).smthrs = "0.33.0";
  assert.equal(migrateStockSmithers032PackageManifest(historical), undefined);
});

test("a superseded generated manifest migrates forward in place so a durable run keeps its run ID", () => {
  const migratable: readonly string[] = MIGRATABLE_PRIOR_SMITHERS_VERSIONS;
  // Exactly the versions this repository actually pinned. `0.34.0` is the only
  // `smthrs` pin ever committed, so a longer list would let the migrator rewrite
  // a manifest Ultrafuzz never generated.
  assert.deepEqual([...migratable], ["0.34.0"]);
  // A version that still migrates must not be the one launch demands, or the
  // migrator would rewrite the current document on every launch.
  assert.equal(migratable.includes(SMITHERS_VERSION), false);

  for (const prior of migratable) {
    const migratedText = migrateStockSmithers032PackageManifest(priorPinManifest(prior));
    assert.equal(migratedText, renderSmithersPackageJson(), `${prior} must migrate to the current document`);
    assert.doesNotThrow(() => assertSmithersPackageManifest(JSON.parse(migratedText as string)));
  }
});

test("the current generated manifest is left alone rather than rewritten", () => {
  assert.equal(migrateStockSmithers032PackageManifest(currentManifest()), undefined);
  assert.doesNotThrow(() => assertSmithersPackageManifest(currentManifest()));
});

test("only the recorded prior pins migrate; every other superseded runner is refused", () => {
  for (const version of ["0.31.0", "0.32.0", "0.36.0", "^0.34.0", "0.34.0-rc.1", ""]) {
    assert.equal(
      migrateStockSmithers032PackageManifest(priorPinManifest(version)),
      undefined,
      `smthrs@${version} must not migrate`
    );
  }
});

test("a prior-pin manifest that differs anywhere else is refused instead of silently rewritten", () => {
  // Each mutation is something a hand edit or a partial upgrade could produce.
  // Rewriting any of them would discard project state the operator meant to keep
  // and would install a tree the project was never resolved against, so the
  // migrator must decline and let launch admission report the mismatch.
  const mutations: Array<[string, (manifest: Record<string, unknown>) => void]> = [
    [
      "an unexpected extra dependency",
      (manifest) => {
        (manifest.dependencies as Record<string, unknown>)["custom-agent-package"] = "1.2.3";
      }
    ],
    [
      "an unexpected extra dev dependency",
      (manifest) => {
        (manifest.devDependencies as Record<string, unknown>)["custom-build-package"] = "2.3.4";
      }
    ],
    [
      "a mismatched override family",
      (manifest) => {
        manifest.overrides = {
          ...(manifest.overrides as Record<string, unknown>),
          effect: "4.0.0-beta.102",
          "@effect/opentelemetry": "4.0.0-beta.102",
          "@effect/platform-bun": "4.0.0-beta.102",
          "@effect/platform-node-shared": "4.0.0-beta.102",
          "@effect/sql-sqlite-bun": "4.0.0-beta.102"
        };
      }
    ],
    [
      "a single drifted override",
      (manifest) => {
        (manifest.overrides as Record<string, unknown>)["@effect/platform-bun"] = "4.0.0-beta.106";
      }
    ],
    [
      "an extra override",
      (manifest) => {
        (manifest.overrides as Record<string, unknown>)["custom-transitive-package"] = "3.4.5";
      }
    ],
    [
      "a missing override",
      (manifest) => {
        delete (manifest.overrides as Record<string, unknown>)["@effect/sql-sqlite-bun"];
      }
    ],
    [
      "a drifted sibling pin",
      (manifest) => {
        (manifest.dependencies as Record<string, unknown>)["@moonshot-ai/kimi-code"] = "0.29.0";
      }
    ],
    [
      "a missing dependency",
      (manifest) => {
        delete (manifest.dependencies as Record<string, unknown>).zod;
      }
    ],
    [
      "a drifted dev dependency",
      (manifest) => {
        manifest.devDependencies = { typescript: "6.0.2" };
      }
    ],
    [
      "an executable field",
      (manifest) => {
        manifest.scripts = { custom: "node custom.js" };
      }
    ],
    [
      "a missing section",
      (manifest) => {
        delete manifest.overrides;
      }
    ],
    [
      "a published package identity",
      (manifest) => {
        manifest.private = false;
      }
    ],
    [
      "a renamed workspace",
      (manifest) => {
        manifest.name = "someone-elses-smithers";
      }
    ],
    [
      "a CommonJS module type",
      (manifest) => {
        manifest.type = "commonjs";
      }
    ],
    [
      "a non-string pin",
      (manifest) => {
        (manifest.dependencies as Record<string, unknown>).zod = { version: "4.4.3" };
      }
    ]
  ];

  for (const [label, mutate] of mutations) {
    const manifest = priorPinManifest("0.34.0");
    mutate(manifest);
    assert.equal(migrateStockSmithers032PackageManifest(manifest), undefined, `${label} must not migrate`);
  }

  assert.equal(migrateStockSmithers032PackageManifest(null), undefined);
  assert.equal(migrateStockSmithers032PackageManifest("{}"), undefined);
  assert.equal(migrateStockSmithers032PackageManifest([]), undefined);
});

test("a reordered prior-pin manifest is normalised, since its content is still the generated one", () => {
  const manifest = priorPinManifest("0.34.0");
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  reordered.dependencies = Object.fromEntries(
    Object.entries(reordered.dependencies as Record<string, unknown>).reverse()
  );

  assert.equal(migrateStockSmithers032PackageManifest(reordered), renderSmithersPackageJson());
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
