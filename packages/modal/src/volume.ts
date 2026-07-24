import type { ModalClient, Volume, VolumeFromNameParams } from "modal";

// Verified against the generated control-plane enums shipped by the exact
// modal@0.9.0 dependency pinned in this package. Re-verify both values before
// upgrading Modal: the public SDK does not expose named-volume FS versions.
const OBJECT_CREATION_TYPE_CREATE_IF_MISSING = 1;
const VOLUME_FS_VERSION_V2 = 2;

export interface ModalV2VolumeClient {
  cpClient: Pick<ModalClient["cpClient"], "volumeGetOrCreate">;
  environmentName(environment?: string): string;
  volumes: Pick<ModalClient["volumes"], "fromName">;
}

export async function getOrCreateModalV2Volume(
  client: ModalV2VolumeClient,
  name: string,
  params: VolumeFromNameParams = {}
): Promise<Volume> {
  if (!params.createIfMissing) return await client.volumes.fromName(name, params);

  const resolved = await client.cpClient.volumeGetOrCreate({
    deploymentName: name,
    environmentName: client.environmentName(params.environment),
    objectCreationType: OBJECT_CREATION_TYPE_CREATE_IF_MISSING,
    appId: "",
    version: VOLUME_FS_VERSION_V2
  });
  const version = resolved.metadata?.version ?? resolved.version;
  if (version !== VOLUME_FS_VERSION_V2) {
    throw new Error("Modal named volume did not resolve to filesystem version 2");
  }

  const volume = await client.volumes.fromName(name, {
    ...params,
    createIfMissing: false
  });
  if (volume.volumeId !== resolved.volumeId) {
    throw new Error("Modal named volume changed identity during version-2 resolution");
  }
  return volume;
}
