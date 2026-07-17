import { DEFAULT_MODAL_IMAGE, type ModelProvider } from "./defaults.js";
import { remoteAuthDir, remoteAuthPath } from "./layout.js";

export const MODAL_SMOKE_RESULT_SCHEMA_VERSION = "ultrafuzz.modal.smoke-result.v1" as const;
export const MODAL_SMOKE_ENTRY_PATH = "/opt/ultrafuzz/packages/modal/dist/smoke-worker.js";
export const MODAL_SMOKE_DATA_ROOT = "/data/ultrafuzz-modal-smoke";

export type ModalSmokePhase = "fresh" | "resume";

export interface ModalSmokePrepared {
  imageName: string;
  entryPath: string;
  volumeIdentity: string;
}

export interface ModalSmokeLaunch {
  owned: boolean;
  sandboxIdentity?: string;
  volumeIdentity: string;
}

export interface ModalSmokeCheckpoint {
  nonRoot: boolean;
  durableStorage: boolean;
  providerAuth: ModelProvider;
  completedUnits: number;
}

export interface ModalSmokeCompletion extends ModalSmokeCheckpoint {
  repeatedUnits: number;
}

export interface ModalSmokeDriver {
  prepare(provider: ModelProvider): Promise<ModalSmokePrepared>;
  launch(prepared: ModalSmokePrepared, phase: ModalSmokePhase, candidate: number): Promise<ModalSmokeLaunch>;
  waitForCheckpoint(launch: ModalSmokeLaunch): Promise<ModalSmokeCheckpoint>;
  terminate(launch: ModalSmokeLaunch): Promise<void>;
  waitForCompletion(launch: ModalSmokeLaunch): Promise<ModalSmokeCompletion>;
  cleanup(prepared: ModalSmokePrepared, launches: ModalSmokeLaunch[]): Promise<void>;
}

export interface ModalSmokeResult {
  schema_version: typeof MODAL_SMOKE_RESULT_SCHEMA_VERSION;
  status: "passed" | "failed";
  provider: ModelProvider;
  checks: {
    production_image: boolean;
    production_entrypoint: boolean;
    non_root: boolean;
    durable_storage: boolean;
    provider_auth: boolean;
    same_volume_resume: boolean;
    completed_work_not_repeated: boolean;
    single_launch_owner: boolean;
  };
  diagnostics: {
    completed_units: number;
    repeated_units: number;
    launch_owners: number;
    failure_code?: "cloud-operation-failed";
  };
}

export function modalSmokeEntrypointCommand(provider: ModelProvider, phase: ModalSmokePhase): string {
  const authPath = remoteAuthPath(provider);
  const authDir = remoteAuthDir(provider);
  return [
    "set -euo pipefail",
    `until test -s '${authPath}'; do sleep 1; done`,
    `install -d -m 700 -o ubuntu -g ubuntu '${MODAL_SMOKE_DATA_ROOT}'`,
    `chown -R ubuntu:ubuntu '${MODAL_SMOKE_DATA_ROOT}' '${authDir}'`,
    `exec runuser -u ubuntu -- env HOME='/home/ubuntu' USER='ubuntu' LOGNAME='ubuntu' node '${MODAL_SMOKE_ENTRY_PATH}' --provider '${provider}' --phase '${phase}' --data-root '${MODAL_SMOKE_DATA_ROOT}'`
  ].join("; ");
}

export async function runModalSmoke(provider: ModelProvider, driver: ModalSmokeDriver): Promise<ModalSmokeResult> {
  let prepared: ModalSmokePrepared | undefined;
  const launches: ModalSmokeLaunch[] = [];
  try {
    prepared = await driver.prepare(provider);
    const fresh = await driver.launch(prepared, "fresh", 0);
    launches.push(fresh);
    if (!fresh.owned) return failedResult(provider, prepared, launches, undefined, undefined);

    const checkpoint = await driver.waitForCheckpoint(fresh);
    await driver.terminate(fresh);

    const resumeAttempts = await Promise.all([
      driver.launch(prepared, "resume", 0),
      driver.launch(prepared, "resume", 1)
    ]);
    launches.push(...resumeAttempts);
    const owners = resumeAttempts.filter((attempt) => attempt.owned);
    if (owners.length !== 1) return failedResult(provider, prepared, launches, checkpoint, undefined);

    const completion = await driver.waitForCompletion(owners[0]!);
    return resultFromEvidence(provider, prepared, launches, checkpoint, completion);
  } finally {
    if (prepared !== undefined) await driver.cleanup(prepared, launches);
  }
}

export function cloudFailureResult(provider: ModelProvider): ModalSmokeResult {
  return {
    schema_version: MODAL_SMOKE_RESULT_SCHEMA_VERSION,
    status: "failed",
    provider,
    checks: {
      production_image: false,
      production_entrypoint: false,
      non_root: false,
      durable_storage: false,
      provider_auth: false,
      same_volume_resume: false,
      completed_work_not_repeated: false,
      single_launch_owner: false
    },
    diagnostics: {
      completed_units: 0,
      repeated_units: 0,
      launch_owners: 0,
      failure_code: "cloud-operation-failed"
    }
  };
}

function failedResult(
  provider: ModelProvider,
  prepared: ModalSmokePrepared,
  launches: ModalSmokeLaunch[],
  checkpoint: ModalSmokeCheckpoint | undefined,
  completion: ModalSmokeCompletion | undefined
): ModalSmokeResult {
  return resultFromEvidence(
    provider,
    prepared,
    launches,
    checkpoint ?? { nonRoot: false, durableStorage: false, providerAuth: provider, completedUnits: 0 },
    completion ?? {
      nonRoot: false,
      durableStorage: false,
      providerAuth: provider,
      completedUnits: checkpoint?.completedUnits ?? 0,
      repeatedUnits: 0
    }
  );
}

function resultFromEvidence(
  provider: ModelProvider,
  prepared: ModalSmokePrepared,
  launches: ModalSmokeLaunch[],
  checkpoint: ModalSmokeCheckpoint,
  completion: ModalSmokeCompletion
): ModalSmokeResult {
  const launchOwners = launches.filter((launch) => launch.owned && launch !== launches[0]).length;
  const sameVolume = launches.every((launch) => launch.volumeIdentity === prepared.volumeIdentity);
  const checks = {
    production_image: prepared.imageName === DEFAULT_MODAL_IMAGE,
    production_entrypoint: prepared.entryPath === MODAL_SMOKE_ENTRY_PATH,
    non_root: checkpoint.nonRoot && completion.nonRoot,
    durable_storage: checkpoint.durableStorage && completion.durableStorage,
    provider_auth: checkpoint.providerAuth === provider && completion.providerAuth === provider,
    same_volume_resume: sameVolume,
    completed_work_not_repeated:
      checkpoint.completedUnits === 1 && completion.completedUnits === 1 && completion.repeatedUnits === 0,
    single_launch_owner: launchOwners === 1
  };
  return {
    schema_version: MODAL_SMOKE_RESULT_SCHEMA_VERSION,
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    provider,
    checks,
    diagnostics: {
      completed_units: completion.completedUnits,
      repeated_units: completion.repeatedUnits,
      launch_owners: launchOwners
    }
  };
}
