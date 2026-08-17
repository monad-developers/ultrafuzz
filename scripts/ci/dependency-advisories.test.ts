import { describe, expect, it } from "bun:test";

import {
  APPROVED_AUDIT_ENDPOINT,
  evaluateDependencyAdvisoryPolicy,
  fetchApprovedProductionAudit,
  parseProductionDependencyListCommandResult,
  productionAuditRequestFromPnpmList,
  strictProductionAuditFromBulkResponse
} from "../check-production-dependency-advisories.mjs";

const highAdvisory = {
  advisory: "GHSA-2345-6789-cfgh",
  package: "synthetic-package",
  severity: "high"
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
      { ...highAdvisory, advisory: "GHSA-3456-789c-fghj", severity: "critical" },
      { ...highAdvisory, advisory: "GHSA-4567-89cf-ghjm", severity: "moderate" }
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

  it("fails closed on partial, error-bearing, and unknown audit schemas", () => {
    expect(evaluateDependencyAdvisoryPolicy({}, exceptions([]), "2026-08-17").errors).toContain(
      "production dependency audit uses an unsupported schema version"
    );
    const errorBearing = { ...auditWith([]), error: "registry returned partial results" };
    expect(evaluateDependencyAdvisoryPolicy(errorBearing, exceptions([]), "2026-08-17").errors).toContain(
      "production dependency audit contains unknown field error"
    );
    expect(
      evaluateDependencyAdvisoryPolicy(
        { ...auditWith([]), source: "https://attacker.invalid/-/npm/v1/security/advisories/bulk" },
        exceptions([]),
        "2026-08-17"
      ).errors
    ).toContain("production dependency audit source is not approved");
    expect(
      evaluateDependencyAdvisoryPolicy(auditWith([{ ...highAdvisory, unexpected: true }]), exceptions([]), "2026-08-17")
        .errors
    ).toContain("production dependency advisory 1 contains unknown field unexpected");
  });

  it("builds an exact approved-registry request from installed production dependencies", () => {
    const request = productionAuditRequestFromPnpmList([
      {
        name: "@ultrafuzz/runtime",
        dependencies: {
          "@ultrafuzz/security": { version: "link:../security" },
          zod: {
            from: "zod",
            version: "4.4.3",
            resolved: "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz",
            dependencies: {
              nested: {
                from: "nested",
                version: "1.2.3",
                resolved: "https://registry.npmjs.org/nested/-/nested-1.2.3.tgz"
              }
            }
          }
        }
      }
    ]);

    expect(request).toEqual({ nested: ["1.2.3"], zod: ["4.4.3"] });
    expect(() =>
      productionAuditRequestFromPnpmList([
        { dependencies: { zod: { from: "zod", version: "latest", resolved: "https://registry.npmjs.org/zod/latest" } } }
      ])
    ).toThrow("not resolved to one exact registry version");
    expect(() =>
      productionAuditRequestFromPnpmList([
        {
          dependencies: {
            zod: { from: "zod", version: "4.4.3", resolved: "https://attacker.invalid/zod-4.4.3.tgz" }
          }
        }
      ])
    ).toThrow("not resolved from the approved registry");
    expect(() =>
      productionAuditRequestFromPnpmList([{ dependencies: { zod: { from: "zod", version: "4.4.3" } } }])
    ).toThrow("not resolved from the approved registry");
    expect(
      productionAuditRequestFromPnpmList([
        {
          dependencies: {
            "renamed-zod": {
              from: "zod@4.4.3",
              version: "4.4.3",
              resolved: "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz"
            }
          }
        }
      ])
    ).toEqual({ zod: ["4.4.3"] });
  });

  it("strictly validates raw bulk advisories before policy evaluation", () => {
    const request = { "synthetic-package": ["1.0.0"] };
    expect(strictProductionAuditFromBulkResponse({ "synthetic-package": [rawAdvisory()] }, request)).toEqual(
      auditWith([highAdvisory])
    );
    expect(() =>
      strictProductionAuditFromBulkResponse({ "synthetic-package": [{ ...rawAdvisory(), id: undefined }] }, request)
    ).toThrow("invalid id");
    expect(() => strictProductionAuditFromBulkResponse({ "unrequested-package": [rawAdvisory()] }, request)).toThrow(
      "unrequested package"
    );
    expect(() =>
      strictProductionAuditFromBulkResponse({ "synthetic-package": [{ ...rawAdvisory(), extra: true }] }, request)
    ).toThrow("unsupported schema");
    expect(
      strictProductionAuditFromBulkResponse(
        { "synthetic-package": [{ ...rawAdvisory(), cvss: { score: 0, vectorString: null } }] },
        request
      )
    ).toEqual(auditWith([highAdvisory]));
  });

  it("always posts to the approved endpoint and rejects registry errors", async () => {
    const request = { "synthetic-package": ["1.0.0"] };
    let observedUrl = "";
    const audit = await fetchApprovedProductionAudit(request, async (url) => {
      observedUrl = String(url);
      return new Response(JSON.stringify({ "synthetic-package": [rawAdvisory()] }), { status: 200 });
    });
    expect(observedUrl).toBe(APPROVED_AUDIT_ENDPOINT);
    expect(audit).toEqual(auditWith([highAdvisory]));
    await expect(
      fetchApprovedProductionAudit(request, async () => new Response("unavailable", { status: 503 }))
    ).rejects.toThrow("HTTP 503");
    await expect(
      fetchApprovedProductionAudit(request, async () => new Response("not-json", { status: 200 }))
    ).rejects.toThrow("not strict JSON");
    const duplicateSeverity = JSON.stringify({ "synthetic-package": [rawAdvisory()] }).replace(
      '"severity":"high"',
      '"severity":"high","severity":"low"'
    );
    await expect(
      fetchApprovedProductionAudit(request, async () => new Response(duplicateSeverity, { status: 200 }))
    ).rejects.toThrow("not strict JSON");
    const invalidUtf8 = Buffer.concat([
      Buffer.from(
        '{"synthetic-package":[{"id":12345,"url":"https://github.com/advisories/GHSA-2345-6789-cfgh","title":"'
      ),
      Buffer.from([0xff]),
      Buffer.from(
        '","severity":"high","vulnerable_versions":"<=1.0.0","cwe":["CWE-400"],"cvss":{"score":8.1,"vectorString":"CVSS:3.1/AV:N"}}]}'
      )
    ]);
    await expect(
      fetchApprovedProductionAudit(request, async () => new Response(invalidUtf8, { status: 200 }))
    ).rejects.toThrow("not strict JSON");
  });

  it("reports production dependency enumeration process, exit, and JSON failures explicitly", () => {
    expect(() =>
      parseProductionDependencyListCommandResult({
        status: 2,
        signal: null,
        stdout: Buffer.from(""),
        stderr: Buffer.from("list failed")
      })
    ).toThrow("production dependency enumeration failed with exit code 2: list failed");
    expect(() =>
      parseProductionDependencyListCommandResult({
        status: null,
        signal: "SIGTERM",
        stdout: Buffer.from(""),
        stderr: Buffer.from("")
      })
    ).toThrow("production dependency enumeration terminated without an exit code (SIGTERM)");
    expect(() =>
      parseProductionDependencyListCommandResult({
        status: null,
        signal: null,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        error: new Error("spawn failed")
      })
    ).toThrow("could not enumerate production dependencies: spawn failed");
    expect(() =>
      parseProductionDependencyListCommandResult({
        status: 0,
        signal: null,
        stdout: Buffer.from("not-json"),
        stderr: Buffer.from("bad output")
      })
    ).toThrow("production dependency enumeration did not return strict JSON: bad output");
    expect(
      parseProductionDependencyListCommandResult({
        status: 0,
        signal: null,
        stdout: Buffer.from("[]"),
        stderr: Buffer.from("")
      })
    ).toEqual([]);
    expect(() =>
      parseProductionDependencyListCommandResult({
        status: 0,
        signal: null,
        stdout: Buffer.from('[{"dependencies":{}},{"dependencies":{},"dependencies":{"hidden":{}}}]'),
        stderr: Buffer.from("")
      })
    ).toThrow("strict JSON");
  });
});

function auditWith(advisories: Array<Record<string, unknown>>) {
  return {
    schema_version: "ultrafuzz.production-dependency-audit.v1",
    source: APPROVED_AUDIT_ENDPOINT,
    advisories
  };
}

function rawAdvisory() {
  return {
    id: 12345,
    url: "https://github.com/advisories/GHSA-2345-6789-cfgh",
    title: "Synthetic production advisory",
    severity: "high",
    vulnerable_versions: "<=1.0.0",
    cwe: ["CWE-400"],
    cvss: { score: 8.1, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" }
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
