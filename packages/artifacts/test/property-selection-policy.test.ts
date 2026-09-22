import assert from "node:assert/strict";
import test from "node:test";
import {
  derivePropertyImplementationCoverage,
  type PropertiesArtifact,
  type ImplementedPropertiesArtifact
} from "../src/property-provenance.js";

const catalog: PropertiesArtifact = {
  schema_version: "ultrafuzz.properties.v2",
  properties: (["high", "medium", "low"] as const).map((priority) => ({
    id: `property-${priority}`,
    description: `The ${priority} accounting check holds.`,
    category: "accounting",
    priority,
    sources: [{ source_node_id: "lens", source_property_id: priority }],
    reference_expectations: [`benchmark:${priority}`]
  }))
};

function implementation(
  threshold: "high" | "medium",
  ids: string[]
): ImplementedPropertiesArtifact & { selection: NonNullable<ImplementedPropertiesArtifact["selection"]> } {
  return {
    schema_version: "ultrafuzz.implemented-properties.v3",
    selection: {
      priority_threshold: threshold,
      priorities: threshold === "high" ? ["high"] : ["high", "medium"],
      property_ids: ids
    },
    properties: ids.map((id) => {
      const property = catalog.properties.find((entry) => entry.id === id);
      assert.ok(property, `Unknown fixture property: ${id}`);
      return {
        property_id: id,
        status: "implemented",
        implementation_paths: ["test/Properties.sol"],
        test_paths: [],
        reference_expectations: property.reference_expectations
      };
    })
  };
}

for (const threshold of ["high", "medium"] as const) {
  test(`strict ${threshold} selection excludes lower-priority expectations without losing their metadata`, () => {
    const ids = threshold === "high" ? ["property-high"] : ["property-high", "property-medium"];
    const selected = implementation(threshold, ids);
    const configuredSelection = { ...selected.selection, reference_expectation_selection: "priority" as const };
    const result = derivePropertyImplementationCoverage(catalog, selected, {
      configuredSelection,
      requireConfiguredSelection: true
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.deepEqual(result.value?.selected_property_ids, ids);
    assert.deepEqual(result.value?.implemented_property_ids, ids);
    assert.deepEqual(result.value?.reference_expected_property_ids, [
      "property-high",
      "property-medium",
      "property-low"
    ]);
    assert.deepEqual(result.value?.reference_expectation_ids, ["benchmark:high", "benchmark:medium", "benchmark:low"]);

    const expanded = implementation(threshold, ["property-high", "property-medium", "property-low"]);
    const rejected = derivePropertyImplementationCoverage(catalog, expanded, { configuredSelection });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.issues.some((issue) => issue.code === "PROPERTY_IMPLEMENTATION_SELECTION_MISMATCH"));
  });
}

test("explicit benchmark mandatory selection still includes below-threshold expected properties", () => {
  const selected = implementation("high", ["property-high", "property-medium", "property-low"]);
  const result = derivePropertyImplementationCoverage(catalog, selected, {
    configuredSelection: { ...selected.selection, reference_expectation_selection: "mandatory" },
    requireConfiguredSelection: true
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.value?.selected_property_ids, ["property-high", "property-medium", "property-low"]);
});

test("selected properties must preserve their expectation tags under strict selection", () => {
  const selected = implementation("high", ["property-high"]);
  const property = selected.properties[0];
  assert.ok(property);
  delete property.reference_expectations;
  const result = derivePropertyImplementationCoverage(catalog, selected, {
    configuredSelection: { ...selected.selection, reference_expectation_selection: "priority" }
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "PROPERTY_IMPLEMENTATION_REFERENCE_EXPECTATIONS_MISMATCH"));
});
