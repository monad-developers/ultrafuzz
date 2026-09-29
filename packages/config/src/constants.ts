export const CONFIG_FILE_NAME = "ultrafuzz.toml";
export const MAX_TIMEOUT_SECONDS = 86_400;
/** A whole campaign outlasts any one task, so its deadline has a separate, higher cap. */
export const MAX_WORKFLOW_DEADLINE_SECONDS = 604_800;
