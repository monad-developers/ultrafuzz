import { NotFoundError, Volume, type ModalClient } from "modal";

const MODAL_OBJECT_LOOKUP = 0;
const MODAL_OBJECT_CREATE_IF_MISSING = 1;
const MODAL_VOLUME_FS_V2 = 2;
const GRPC_NOT_FOUND = 5;

/**
 * Resolve a named Modal Volume while explicitly requiring the v2 filesystem.
 * The public TypeScript SDK does not currently expose the protocol's version
 * field on VolumeService.fromName(), but its supported control-plane client
 * does. V2 is required for durable atomic staging of the shared Kimi
 * credential and its lineage sidecar across worker restarts.
 */
export async function modalVolumeFromNameV2(
  client: Pick<ModalClient, "cpClient" | "environmentName">,
  name: string,
  params: { createIfMissing: boolean; environment?: string }
): Promise<Volume> {
  let response: Awaited<ReturnType<ModalClient["cpClient"]["volumeGetOrCreate"]>>;
  try {
    response = await client.cpClient.volumeGetOrCreate({
      appId: "",
      deploymentName: name,
      environmentName: client.environmentName(params.environment),
      objectCreationType: params.createIfMissing ? MODAL_OBJECT_CREATE_IF_MISSING : MODAL_OBJECT_LOOKUP,
      version: MODAL_VOLUME_FS_V2
    });
  } catch (error) {
    if (!params.createIfMissing && isGrpcNotFound(error)) {
      throw new NotFoundError(`Modal Volume ${name} was not found`);
    }
    throw error;
  }
  const version = response.metadata?.version ?? response.version;
  if (version !== MODAL_VOLUME_FS_V2) {
    throw new Error(
      `Modal Volume ${name} uses filesystem v${version || "unknown"}; Ultrafuzz requires a newly named v2 volume`
    );
  }
  return new Volume(response.volumeId, name);
}

function isGrpcNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === GRPC_NOT_FOUND;
}
