import { describe, expect, it } from "bun:test";

import { evaluateAuditPolicy, validateManifestDependencySpecs } from "../check-dependency-policy.mjs";

const advisory = {
  id: 1,
  github_advisory_id: "GHSA-2345-6789-cfgh",
  module_name: "synthetic-package",
  severity: "high",
  title: "Synthetic production advisory",
  vulnerable_versions: ">=1.0.0 <1.0.1",
  patched_versions: ">=1.0.1",
  url: "https://github.com/advisories/GHSA-2345-6789-cfgh",
  findings: [{ version: "1.0.0", paths: ["app>synthetic-package"] }]
};

describe("dependency policy", () => {
  it("allows only exact external pins and workspace:* internal links", () => {
    const exact = [
      {
        path: "package.json",
        value: { name: "root", dependencies: { internal: "workspace:*", external: "1.2.3" } }
      },
      { path: "packages/internal/package.json", value: { name: "internal" } }
    ];
    expect(validateManifestDependencySpecs(exact)).toEqual([]);
    expect(
      validateManifestDependencySpecs([
        ...exact,
        { path: "packages/bad/package.json", value: { name: "bad", dependencies: { external: "^1.2.3" } } }
      ])
    ).toContain("packages/bad/package.json dependencies.external must pin one exact registry version (found ^1.2.3)");
  });

  it("blocks uncovered high advisories and accepts a current bounded exception", () => {
    // This mirrors the object-shaped JSON emitted by `pnpm audit --prod
    // --json` in pnpm 11, including its numeric advisory map keys.
    const audit = {
      advisories: { "1130736": advisory },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
        dependencies: 1,
        devDependencies: 0,
        optionalDependencies: 0,
        totalDependencies: 1
      }
    };
    expect(evaluateAuditPolicy(audit, exceptions([]), "2026-08-15")).toContain(
      "unapproved high production advisory GHSA-2345-6789-cfgh in synthetic-package"
    );
    expect(evaluateAuditPolicy(audit, exceptions([validException()]), "2026-08-15")).toEqual([]);
  });

  it("fails closed when pnpm audit JSON changes shape or contains malformed advisories", () => {
    expect(evaluateAuditPolicy({ vulnerabilities: {} }, exceptions([]), "2026-08-15")).toContain(
      "pnpm audit uses an unsupported JSON schema (expected an advisories object)"
    );
    expect(
      evaluateAuditPolicy(
        { advisories: { "1": { ...advisory, github_advisory_id: undefined } } },
        exceptions([]),
        "2026-08-15"
      )
    ).toContain("pnpm audit advisory 1 has an invalid GitHub advisory identifier");
  });

  it("rejects expired, overlong, and stale advisory exceptions", () => {
    const audit = { advisories: { "1": advisory } };
    expect(
      evaluateAuditPolicy(audit, exceptions([{ ...validException(), expires: "2026-08-14" }]), "2026-08-15")
    ).toContain("dependency advisory exception 1 expired on 2026-08-14");
    expect(
      evaluateAuditPolicy(audit, exceptions([{ ...validException(), expires: "2027-08-15" }]), "2026-08-15")
    ).toContain("dependency advisory exception 1 expires more than 90 days after review");
    expect(evaluateAuditPolicy({ advisories: {} }, exceptions([validException()]), "2026-08-15")).toContain(
      "stale dependency advisory exception GHSA-2345-6789-cfgh for synthetic-package"
    );
  });
});

function exceptions(values: unknown[]) {
  return { schema_version: "ultrafuzz.dependency-advisory-exceptions.v1", exceptions: values };
}

function validException() {
  return {
    advisory: "GHSA-2345-6789-cfgh",
    package: "synthetic-package",
    severity: "high",
    status: "not-reachable",
    expires: "2026-09-15",
    owner: "@security-owner",
    tracking_issue: "#616",
    reachability: "The affected parser is not called by production inputs.",
    rationale: "Retained temporarily while the upstream dependency is upgraded."
  };
}
