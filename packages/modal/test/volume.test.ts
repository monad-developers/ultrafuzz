import { NotFoundError, type Volume } from "modal";
import { describe, expect, it, vi } from "vitest";

import { getOrCreateModalV2Volume, type ModalV2VolumeClient } from "../src/volume.js";

describe("Modal version-2 named volumes", () => {
  it("creates and verifies a version-2 volume before attaching it", async () => {
    const volume = { volumeId: "volume-id" } as Volume;
    const volumeGetOrCreate = vi.fn(async () => ({
      volumeId: volume.volumeId,
      version: 0,
      metadata: { version: 2 }
    }));
    const fromName = vi.fn(async () => volume);
    const client = fakeClient(volumeGetOrCreate, fromName);

    await expect(
      getOrCreateModalV2Volume(client, "volume-name", {
        environment: "environment-name",
        createIfMissing: true
      })
    ).resolves.toBe(volume);

    expect(volumeGetOrCreate).toHaveBeenCalledWith({
      deploymentName: "volume-name",
      environmentName: "resolved-environment-name",
      objectCreationType: 1,
      appId: "",
      version: 2
    });
    expect(fromName).toHaveBeenCalledWith("volume-name", {
      environment: "environment-name",
      createIfMissing: false
    });
  });

  it("attests a lookup as version 2 and verifies the public volume identity", async () => {
    const volume = { volumeId: "volume-id" } as Volume;
    const volumeGetOrCreate = vi.fn(async () => ({
      volumeId: volume.volumeId,
      version: 2,
      metadata: undefined
    }));
    const fromName = vi.fn(async () => volume);
    const client = fakeClient(volumeGetOrCreate, fromName);

    await expect(getOrCreateModalV2Volume(client, "volume-name", { createIfMissing: false })).resolves.toBe(volume);

    expect(volumeGetOrCreate).toHaveBeenCalledWith({
      deploymentName: "volume-name",
      environmentName: "resolved-default",
      objectCreationType: 0,
      appId: "",
      version: 2
    });
    expect(fromName).toHaveBeenCalledWith("volume-name", { createIfMissing: false });
  });

  it.each([true, false])(
    "rejects an incompatible filesystem version before attaching the volume (createIfMissing=%s)",
    async (createIfMissing) => {
      const volumeGetOrCreate = vi.fn(async () => ({
        volumeId: "volume-id",
        version: 1,
        metadata: undefined
      }));
      const fromName = vi.fn();
      const client = fakeClient(volumeGetOrCreate, fromName);

      await expect(getOrCreateModalV2Volume(client, "volume-name", { createIfMissing })).rejects.toThrow(
        /requires filesystem version 2/u
      );
      expect(fromName).not.toHaveBeenCalled();
    }
  );

  it("preserves lookup not-found behavior", async () => {
    const missing = Object.assign(new Error("missing"), { code: 5 });
    const volumeGetOrCreate = vi.fn(async () => ({
      volumeId: "unused",
      version: 2
    }));
    volumeGetOrCreate.mockRejectedValueOnce(missing);
    const fromName = vi.fn();
    const client = fakeClient(volumeGetOrCreate, fromName);

    await expect(getOrCreateModalV2Volume(client, "missing-volume", { createIfMissing: false })).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(fromName).not.toHaveBeenCalled();
  });

  it("rejects a changed volume identity", async () => {
    const volumeGetOrCreate = vi.fn(async () => ({
      volumeId: "expected-volume-id",
      version: 2,
      metadata: undefined
    }));
    const fromName = vi.fn(async () => ({ volumeId: "other-volume-id" }) as Volume);
    const client = fakeClient(volumeGetOrCreate, fromName);

    await expect(getOrCreateModalV2Volume(client, "volume-name", { createIfMissing: false })).rejects.toThrow(
      /changed identity/u
    );
  });
});

function fakeClient(
  volumeGetOrCreate: ReturnType<typeof vi.fn>,
  fromName: ReturnType<typeof vi.fn>
): ModalV2VolumeClient {
  return {
    cpClient: { volumeGetOrCreate } as unknown as ModalV2VolumeClient["cpClient"],
    environmentName: (environment?: string) => `resolved-${environment ?? "default"}`,
    volumes: { fromName } as unknown as ModalV2VolumeClient["volumes"]
  };
}
