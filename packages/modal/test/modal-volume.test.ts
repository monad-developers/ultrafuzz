import { describe, expect, it } from "vitest";

import { modalVolumeFromNameV2 } from "../src/modal-volume.js";
import { getOrCreateModalV2Volume } from "../src/volume.js";

describe("legacy Modal v2 volume import", () => {
  it("is the canonical version-2 control-plane and identity resolver", () => {
    expect(modalVolumeFromNameV2).toBe(getOrCreateModalV2Volume);
  });
});
