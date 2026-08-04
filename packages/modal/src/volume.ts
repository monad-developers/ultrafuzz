import { NotFoundError, type ModalClient, type Volume, type VolumeFromNameParams } from "modal";

// Verified against the generated control-plane enums shipped by the exact
// modal@0.9.0 dependency pinned in this package. Re-verify these values before
// upgrading Modal: the public SDK does not expose named-volume FS versions.
const OBJECT_CREATION_TYPE_LOOKUP = 0;
const OBJECT_CREATION_TYPE_CREATE_IF_MISSING = 1;
const VOLUME_FS_VERSION_V2 = 2;
const GRPC_NOT_FOUND = 5;

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
  const createIfMissing = params.createIfMissing === true;
  let resolved: Awaited<ReturnType<ModalClient["cpClient"]["volumeGetOrCreate"]>>;
  try {
    resolved = await client.cpClient.volumeGetOrCreate({
      deploymentName: name,
      environmentName: client.environmentName(params.environment),
      objectCreationType: createIfMissing ? OBJECT_CREATION_TYPE_CREATE_IF_MISSING : OBJECT_CREATION_TYPE_LOOKUP,
      appId: "",
      version: VOLUME_FS_VERSION_V2
    });
  } catch (error) {
    if (!createIfMissing && isGrpcNotFound(error)) {
      throw new NotFoundError(`Modal Volume ${name} was not found`);
    }
    throw error;
  }
  const version = resolved.metadata?.version ?? resolved.version;
  if (version !== VOLUME_FS_VERSION_V2) {
    throw new Error(
      `Modal named volume ${name} uses filesystem version ${version || "unknown"}; Ultrafuzz requires filesystem version 2`
    );
  }

  // Resolve through the supported public service as well, but never permit it
  // to create an unversioned volume. Matching identities proves the mountable
  // SDK object names the exact v2 control-plane object attested above.
  const volume = await client.volumes.fromName(name, {
    ...params,
    createIfMissing: false
  });
  if (volume.volumeId !== resolved.volumeId) {
    throw new Error("Modal named volume changed identity during version-2 resolution");
  }
  return volume;
}

function isGrpcNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === GRPC_NOT_FOUND;
}
