import type { ModalClient, Volume, VolumeFromNameParams } from "modal";

// The Modal JavaScript SDK exposes the control-plane client but does not yet
// expose a public named-volume filesystem-version option.
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
