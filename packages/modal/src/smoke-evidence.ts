import { MODAL_SMOKE_CHECKPOINT_SCHEMA_ID, MODAL_SMOKE_COMPLETION_SCHEMA_ID } from "./modal-contracts.js";
import { parseModalDocumentBytes } from "./modal-documents.js";
import type { ModalSmokeCheckpoint, ModalSmokeCompletion } from "./smoke.js";

export function parseModalSmokeCheckpointBytes(bytes: Uint8Array): ModalSmokeCheckpoint {
  const document = parseModalDocumentBytes(MODAL_SMOKE_CHECKPOINT_SCHEMA_ID, bytes).value;
  return {
    nonRoot: document.non_root,
    durableStorage: document.durable_storage,
    providerAuth: document.provider_auth,
    completedUnits: document.completed_units
  };
}

export function parseModalSmokeCompletionBytes(bytes: Uint8Array): ModalSmokeCompletion {
  const document = parseModalDocumentBytes(MODAL_SMOKE_COMPLETION_SCHEMA_ID, bytes).value;
  return {
    nonRoot: document.non_root,
    durableStorage: document.durable_storage,
    providerAuth: document.provider_auth,
    completedUnits: document.completed_units,
    repeatedUnits: document.repeated_units
  };
}
