import type { ModalClient } from "modal";
import { NotFoundError } from "modal";
import { describe, expect, it, vi } from "vitest";

import { modalVolumeFromNameV2 } from "../src/modal-volume.js";

describe("Modal v2 volumes", () => {
  it("requests filesystem v2 and rejects an existing v1 volume", async () => {
    const volumeGetOrCreate = vi.fn(async () => ({
      metadata: { version: 1 },
      version: 1,
      volumeId: "vo-v1"
    }));
    const client = fakeClient(volumeGetOrCreate);

    await expect(modalVolumeFromNameV2(client, "benchmark-volume", { createIfMissing: true })).rejects.toThrow(
      /requires a newly named v2 volume/u
    );
    expect(volumeGetOrCreate).toHaveBeenCalledWith({
      appId: "",
      deploymentName: "benchmark-volume",
      environmentName: "main",
      objectCreationType: 1,
      version: 2
    });
  });

  it("returns a v2 volume and preserves lookup not-found behavior", async () => {
    const volumeGetOrCreate = vi.fn(async () => ({
      metadata: { version: 2 },
      version: 2,
      volumeId: "vo-v2"
    }));
    const volume = await modalVolumeFromNameV2(fakeClient(volumeGetOrCreate), "benchmark-volume", {
      createIfMissing: false
    });
    expect(volume.volumeId).toBe("vo-v2");
    expect(volume.name).toBe("benchmark-volume");
    expect(volumeGetOrCreate).toHaveBeenCalledWith(expect.objectContaining({ objectCreationType: 0, version: 2 }));

    const missing = Object.assign(new Error("missing"), { code: 5 });
    await expect(
      modalVolumeFromNameV2(
        fakeClient(
          vi.fn(async () => {
            throw missing;
          })
        ),
        "missing-volume",
        { createIfMissing: false }
      )
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

function fakeClient(
  volumeGetOrCreate: (...args: unknown[]) => Promise<unknown>
): Pick<ModalClient, "cpClient" | "environmentName"> {
  return {
    cpClient: { volumeGetOrCreate } as unknown as ModalClient["cpClient"],
    environmentName: () => "main"
  };
}
