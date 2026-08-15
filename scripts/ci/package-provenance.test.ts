import { describe, expect, it } from "bun:test";

import {
  comparePackageProvenance,
  normalizeRegistryMetadata,
  readBoundedResponseBytes
} from "../check-package-provenance.mjs";

const metadata = {
  name: "critical-tool",
  version: "1.2.3",
  _npmUser: {
    name: "GitHub Actions",
    email: "npm-oidc-no-reply@github.com",
    trustedPublisher: { id: "github", oidcConfigId: "oidc:expected" }
  },
  maintainers: [
    { name: "zeta", email: "zeta@example.invalid" },
    { name: "alpha", email: "alpha@example.invalid" }
  ],
  repository: { type: "git", url: "git+https://github.com/example/critical-tool.git" },
  dist: {
    integrity: "sha512-synthetic",
    signatures: [{ keyid: "SHA256:key", sig: "signature" }],
    attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } }
  }
};

describe("critical package provenance", () => {
  it("normalizes publisher, maintainer, signature, and provenance identity", () => {
    expect(normalizeRegistryMetadata(metadata, "critical-tool", "1.2.3")).toEqual({
      version: "1.2.3",
      publisher: {
        name: "GitHub Actions",
        email: "npm-oidc-no-reply@github.com",
        trusted_publisher: { id: "github", oidc_config_id: "oidc:expected" }
      },
      maintainers: [
        { name: "alpha", email: "alpha@example.invalid" },
        { name: "zeta", email: "zeta@example.invalid" }
      ],
      repository: "git+https://github.com/example/critical-tool.git",
      integrity: "sha512-synthetic",
      signature_key_ids: ["SHA256:key"],
      provenance_predicate: "https://slsa.dev/provenance/v1"
    });
  });

  it("reports exact publisher and provenance drift", () => {
    const expected = normalizeRegistryMetadata(metadata, "critical-tool", "1.2.3");
    const actual = structuredClone(expected);
    actual.publisher.name = "unexpected-publisher";
    actual.provenance_predicate = null;
    expect(comparePackageProvenance(expected, actual, "critical-tool").map((item) => item.field)).toEqual([
      "publisher",
      "provenance_predicate"
    ]);
  });

  it("streams registry metadata through a hard limit despite dishonest or missing length headers", async () => {
    let cancelled = false;
    const chunks = [new Uint8Array(4).fill(0x61), new Uint8Array(4).fill(0x62)];
    const dishonest = new Response(
      new ReadableStream({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        }
      }),
      { headers: { "content-length": "1" } }
    );
    await expect(readBoundedResponseBytes(dishonest, 7)).rejects.toThrow(/exceeds the response limit/u);
    expect(cancelled).toBe(true);

    const chunked = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("abc"));
          controller.enqueue(new TextEncoder().encode("def"));
          controller.close();
        }
      })
    );
    expect(new TextDecoder().decode(await readBoundedResponseBytes(chunked, 6))).toBe("abcdef");
  });
});
