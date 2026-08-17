import { describe, expect, it } from "bun:test";

import {
  evaluateDependencyAdvisoryPolicy,
  parseAuditCommandResult
} from "../check-production-dependency-advisories.mjs";

const highAdvisory = {
  github_advisory_id: "GHSA-2345-6789-cfgh",
  module_name: "synthetic-package",
  severity: "high",
  findings: [{ version: "1.0.0", paths: ["app>synthetic-package"], dev: false }]
};

describe("production dependency advisory policy", () => {
  it("passes a supported audit with no actionable advisories", () => {
    expect(evaluateDependencyAdvisoryPolicy(auditWith([]), exceptions([]), "2026-08-17")).toEqual({
      actionableCount: 0,
      activeExceptionCount: 0,
      errors: []
    });
  });

  it("blocks uncovered High and Critical production advisories but not Moderate advisories", () => {
    const audit = auditWith([
      highAdvisory,
      { ...highAdvisory, github_advisory_id: "GHSA-3456-789c-fghj", severity: "critical" },
      { ...highAdvisory, github_advisory_id: "GHSA-4567-89cf-ghjm", severity: "moderate" }
    ]);
    const result = evaluateDependencyAdvisoryPolicy(audit, exceptions([]), "2026-08-17");

    expect(result.actionableCount).toBe(2);
    expect(result.errors).toEqual([
      "unapproved high production advisory GHSA-2345-6789-cfgh in synthetic-package",
      "unapproved critical production advisory GHSA-3456-789c-fghj in synthetic-package"
    ]);
  });

  it("accepts an accountable, current, bounded exception", () => {
    const result = evaluateDependencyAdvisoryPolicy(
      auditWith([highAdvisory]),
      exceptions([validException()]),
      "2026-08-17"
    );

    expect(result).toEqual({ actionableCount: 1, activeExceptionCount: 1, errors: [] });
  });

  it("rejects expired, future-reviewed, and overlong exceptions", () => {
    expect(
      evaluateDependencyAdvisoryPolicy(
        auditWith([highAdvisory]),
        exceptions([{ ...validException(), expires: "2026-08-16" }]),
        "2026-08-17"
      ).errors
    ).toContain("dependency advisory exception 1 expired on 2026-08-16");
    expect(
      evaluateDependencyAdvisoryPolicy(
        auditWith([highAdvisory]),
        exceptions([{ ...validException(), reviewed_on: "2026-08-18", expires: "2026-08-19" }]),
        "2026-08-17"
      ).errors
    ).toContain("dependency advisory exception 1 review date 2026-08-18 is in the future");
    expect(
      evaluateDependencyAdvisoryPolicy(
        auditWith([highAdvisory]),
        exceptions([{ ...validException(), expires: "2026-10-01" }]),
        "2026-08-17"
      ).errors
    ).toContain("dependency advisory exception 1 validity exceeds 30 days");
  });

  it("rejects malformed, duplicate, mismatched, and stale exceptions", () => {
    expect(evaluateDependencyAdvisoryPolicy(auditWith([]), { exceptions: [] }, "2026-08-17").errors).toContain(
      "dependency advisory exceptions use an unsupported schema version"
    );
    expect(
      evaluateDependencyAdvisoryPolicy(
        auditWith([highAdvisory]),
        exceptions([{ ...validException(), owner: "security-owner", unexpected: true }]),
        "2026-08-17"
      ).errors
    ).toEqual(
      expect.arrayContaining([
        "dependency advisory exception 1 contains unknown field unexpected",
        "dependency advisory exception 1 owner must be a GitHub login beginning with @"
      ])
    );
    expect(
      evaluateDependencyAdvisoryPolicy(
        auditWith([highAdvisory]),
        exceptions([validException(), validException()]),
        "2026-08-17"
      ).errors
    ).toContain("dependency advisory exception 2 duplicates GHSA-2345-6789-cfgh for synthetic-package");
    expect(
      evaluateDependencyAdvisoryPolicy(
        auditWith([highAdvisory]),
        exceptions([{ ...validException(), severity: "critical" }]),
        "2026-08-17"
      ).errors
    ).toContain("exception severity for GHSA-2345-6789-cfgh in synthetic-package does not match the registry advisory");
    expect(
      evaluateDependencyAdvisoryPolicy(auditWith([]), exceptions([validException()]), "2026-08-17").errors
    ).toContain("stale dependency advisory exception GHSA-2345-6789-cfgh for synthetic-package");
  });

  it("fails closed on changed audit schemas, malformed findings, and inconsistent counts", () => {
    expect(evaluateDependencyAdvisoryPolicy({}, exceptions([]), "2026-08-17").errors).toContain(
      "pnpm audit uses an unsupported JSON schema (expected an advisories object)"
    );
    expect(
      evaluateDependencyAdvisoryPolicy(
        auditWith([{ ...highAdvisory, findings: [{ dev: true }] }]),
        exceptions([]),
        "2026-08-17"
      ).errors
    ).toContain("pnpm audit advisory 1 finding 1 must explicitly be a production dependency");
    const inconsistent = auditWith([highAdvisory]);
    inconsistent.metadata.vulnerabilities.high = 0;
    expect(evaluateDependencyAdvisoryPolicy(inconsistent, exceptions([]), "2026-08-17").errors).toContain(
      "pnpm audit metadata reports 0 high advisories but the advisory map contains 1"
    );
  });

  it("reports audit process, exit, and JSON failures explicitly", () => {
    expect(() =>
      parseAuditCommandResult({ status: 2, signal: null, stdout: "", stderr: "registry unavailable" })
    ).toThrow("pnpm audit --prod failed with exit code 2: registry unavailable");
    expect(() =>
      parseAuditCommandResult({
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: ""
      })
    ).toThrow("pnpm audit --prod terminated without an exit code (SIGTERM)");
    expect(() =>
      parseAuditCommandResult({
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: new Error("spawn failed")
      })
    ).toThrow("could not run pnpm audit --prod: spawn failed");
    expect(() =>
      parseAuditCommandResult({ status: 1, signal: null, stdout: "not-json", stderr: "bad response" })
    ).toThrow("pnpm audit --prod did not return valid JSON: bad response");
    expect(
      parseAuditCommandResult({ status: 1, signal: null, stdout: JSON.stringify(auditWith([])), stderr: "" })
    ).toEqual(auditWith([]));
  });
});

function auditWith(advisories: Array<Record<string, unknown>>) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const advisory of advisories) {
    const severity = advisory.severity;
    if (typeof severity === "string" && severity in counts) counts[severity as keyof typeof counts] += 1;
  }
  return {
    advisories: Object.fromEntries(advisories.map((advisory, index) => [String(index + 1), advisory])),
    metadata: {
      vulnerabilities: counts,
      dependencies: 1,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 1
    }
  };
}

function exceptions(values: unknown[]) {
  return { schema_version: "ultrafuzz.dependency-advisory-exceptions.v1", exceptions: values };
}

function validException() {
  return {
    advisory: "GHSA-2345-6789-cfgh",
    package: "synthetic-package",
    severity: "high",
    status: "not-reachable",
    reviewed_on: "2026-08-15",
    expires: "2026-09-14",
    owner: "@security-owner",
    tracking_issue: "#616",
    reachability: "The affected parser is not called by production inputs.",
    rationale: "Retained briefly while the upstream dependency is upgraded."
  };
}
