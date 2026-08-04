// Compatibility name retained for internal callers and downstream source
// imports. The implementation lives in volume.ts so lookup and creation cannot
// drift into different control-plane or identity guarantees again.
export { getOrCreateModalV2Volume as modalVolumeFromNameV2, type ModalV2VolumeClient } from "./volume.js";
