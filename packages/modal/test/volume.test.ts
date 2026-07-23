import type { Volume } from "modal";
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

  it("uses the public lookup path without a control-plane write when creation is disabled", async () => {
    const volume = { volumeId: "volume-id" } as Volume;
    const volumeGetOrCreate = vi.fn();
    const fromName = vi.fn(async () => volume);
    const client = fakeClient(volumeGetOrCreate, fromName);

    await expect(getOrCreateModalV2Volume(client, "volume-name", { createIfMissing: false })).resolves.toBe(volume);

    expect(volumeGetOrCreate).not.toHaveBeenCalled();
    expect(fromName).toHaveBeenCalledWith("volume-name", { createIfMissing: false });
  });

  it("rejects an incompatible filesystem version before attaching the volume", async () => {
    const volumeGetOrCreate = vi.fn(async () => ({
      volumeId: "volume-id",
      version: 1,
      metadata: undefined
    }));
    const fromName = vi.fn();
    const client = fakeClient(volumeGetOrCreate, fromName);

    await expect(getOrCreateModalV2Volume(client, "volume-name", { createIfMissing: true })).rejects.toThrow(
      /filesystem version 2/u
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

    await expect(getOrCreateModalV2Volume(client, "volume-name", { createIfMissing: true })).rejects.toThrow(
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
