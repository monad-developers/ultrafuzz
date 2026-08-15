interface Issue531SourceLensFixture {
  nodeId: string;
  propertyId: string;
  artifactPath: string;
}

interface Issue531ReferenceExpectationFixture {
  arm: "treatment" | "control";
  runId: string;
  canonicalPropertyId: string;
  fabricatedExpectationIds: readonly string[];
  sources: readonly Issue531SourceLensFixture[];
}

/**
 * Minimized from the completed #531 paired-run artifacts. These fixtures retain
 * the exact fan-in source joins and fabricated expectation IDs while dropping
 * fields irrelevant to the canonical-subset-of-lens gate. Every captured source
 * lens row omitted `reference_expectations` in the original run.
 */
export const ISSUE_531_REFERENCE_EXPECTATION_FIXTURES = [
  {
    arm: "treatment",
    runId: "aave-v4-v056-gpt55-xhigh-default-20260813-treatment",
    canonicalPropertyId: "property-1",
    fabricatedExpectationIds: ["LEND_ACC_03"],
    sources: [
      {
        nodeId: "property-specification-0kn0t",
        propertyId: "AAVEV4_0KN0T_ACC_001",
        artifactPath: "properties/0kn0t.json"
      },
      {
        nodeId: "property-specification-a16z",
        propertyId: "hub-borrowed-assets-lte-supplied-assets",
        artifactPath: "properties/a16z.json"
      },
      {
        nodeId: "property-specification-aviggiano",
        propertyId: "prop-hub-borrowed-assets-lte-supplied-assets",
        artifactPath: "properties/aviggiano.json"
      },
      {
        nodeId: "property-specification-certora",
        propertyId: "hub-borrowed-assets-lte-supplied-assets",
        artifactPath: "properties/certora.json"
      },
      {
        nodeId: "property-specification-crytic",
        propertyId: "target-hub-borrowed-assets-lte-supplied-assets",
        artifactPath: "properties/crytic.json"
      },
      {
        nodeId: "property-specification-josselin-feist",
        propertyId: "josselin-feist-035-doc-borrowed-assets-lte-supplied",
        artifactPath: "properties/josselin-feist.json"
      },
      {
        nodeId: "property-specification-recon",
        propertyId: "recon-hub-borrowed-assets-lte-supplied-assets",
        artifactPath: "properties/recon.json"
      },
      {
        nodeId: "property-specification-runtime-verification",
        propertyId: "hub-borrowed-assets-lte-supplied-assets",
        artifactPath: "properties/runtime-verification.json"
      }
    ]
  },
  {
    arm: "control",
    runId: "aave-v4-v056-gpt55-xhigh-default-20260813-control",
    canonicalPropertyId: "property-134",
    fabricatedExpectationIds: ["ERC4626-013", "ERC4626-015", "prop_previewDeposit"],
    sources: [
      {
        nodeId: "property-specification-a16z",
        propertyId: "a16z-preview-add-by-assets",
        artifactPath: "properties/a16z.json"
      },
      {
        nodeId: "property-specification-aviggiano",
        propertyId: "prop-preview-add-by-assets-rounding",
        artifactPath: "properties/aviggiano.json"
      },
      {
        nodeId: "property-specification-certora",
        propertyId: "preview-add-by-assets-rounding",
        artifactPath: "properties/certora.json"
      },
      {
        nodeId: "property-specification-crytic",
        propertyId: "crytic-aave-v4-014",
        artifactPath: "properties/crytic.json"
      },
      {
        nodeId: "property-specification-runtime-verification",
        propertyId: "rv-001-preview-add-assets-rounding-down",
        artifactPath: "properties/runtime-verification.json"
      }
    ]
  }
] as const satisfies readonly Issue531ReferenceExpectationFixture[];
