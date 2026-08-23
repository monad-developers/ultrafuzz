import { describe, expect, it } from "vitest";

import { readBoundedResponseBytes } from "../src/bounded-response.js";
import {
  MAX_EPHEMERAL_JUDGE_CREDENTIAL_RESPONSE_BYTES,
  parseEphemeralJudgeCredentialResponse,
  type JudgeCredentialResponseError
} from "../src/judge-credential.js";

describe("ephemeral judge credential responses", () => {
  it("projects the exact credential-broker response without mutating its bytes", () => {
    const contents = Buffer.from('{"key":"temporary-secret"}\n', "utf8");
    const before = Buffer.from(contents);

    expect(parseEphemeralJudgeCredentialResponse(contents)).toBe("temporary-secret");
    expect(Buffer.from(contents)).toEqual(before);
  });

  it.each([
    ["malformed", Buffer.from('{"key":', "utf8")],
    ["duplicate", Buffer.from('{"key":"first","key":"shadow"}', "utf8")],
    ["invalid UTF-8", Uint8Array.from([0x7b, 0x22, 0x6b, 0x65, 0x79, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]
  ])("rejects %s strict-JSON evidence without mutating it", (_name, contents) => {
    const before = Buffer.from(contents);

    expect(() => parseEphemeralJudgeCredentialResponse(contents)).toThrow(
      expect.objectContaining<Partial<JudgeCredentialResponseError>>({
        name: "JudgeCredentialResponseError",
        category: "unreachable"
      })
    );
    expect(Buffer.from(contents)).toEqual(before);
  });

  it.each([
    ['{"key":""}', "empty key"],
    ['{"key":" padded "}', "normalized key"],
    ['{"key":"secret","expires_in":900}', "extra property"],
    ['["secret"]', "non-object"]
  ])("rejects the unsupported %s broker shape", (contents) => {
    expect(() => parseEphemeralJudgeCredentialResponse(Buffer.from(contents, "utf8"))).toThrow(
      expect.objectContaining<Partial<JudgeCredentialResponseError>>({
        name: "JudgeCredentialResponseError",
        category: "authentication-failure"
      })
    );
  });

  it("bounds the streamed response before strict parsing", async () => {
    const response = new Response("x".repeat(MAX_EPHEMERAL_JUDGE_CREDENTIAL_RESPONSE_BYTES + 1));

    await expect(
      readBoundedResponseBytes(response, MAX_EPHEMERAL_JUDGE_CREDENTIAL_RESPONSE_BYTES, "judge credential response")
    ).rejects.toThrow(/exceeds the .*byte limit/u);
  });
});
