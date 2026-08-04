import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";

import lockfile from "proper-lockfile";
import { parse, stringify } from "smol-toml";

import type { ModalModelSpec, ModelProvider } from "./defaults.js";
import { remoteAuthDir, remoteAuthPath } from "./layout.js";

export interface SubscriptionAuthCopy {
  source: string;
  destination: string;
  entries?: SubscriptionAuthCopyEntry[];
  cleanup?: () => Promise<void>;
}

export interface SubscriptionAuthCopyEntry {
  source: string;
  destination: string;
}

export interface KimiSubscriptionAuthPreparationOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

export interface KimiSubscriptionAuthBrokerInput {
  candidateCredential: string;
  initialCredential: string;
  model: string;
  source: string;
  env?: Record<string, string | undefined>;
}

export interface KimiModalNodeExecutionLease {
  assertOwner(): Promise<void>;
  credentialLeaseId: string;
  credentialPath: string;
  leasePath: string;
  markRotationPossible(): Promise<void>;
  markRotationResolved(): Promise<void>;
  ownerId: string;
  prepareAuthCopy(
    env?: Record<string, string | undefined>,
    options?: KimiSubscriptionAuthPreparationOptions
  ): Promise<SubscriptionAuthCopy>;
  reconcileCredential(remoteCredential: string, options?: { sourceRefreshTokenSha256?: string }): Promise<boolean>;
  release(): Promise<void>;
  source: string;
}

type KimiModalNodeExecutionLeaseState = "active" | "rotation-possible" | "resolved";

type KimiModalNodeExecutionLeaseHandleState = "open" | "releasing" | "closed";

interface KimiLeaseCredentialHandleBinding {
  current: FileHandle;
  pendingLocalRefresh?: {
    intendedCredentialSha256: string;
  };
}

export function subscriptionAuthCopy(
  model: Pick<ModalModelSpec, "provider" | "auth_mode">,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir()
): SubscriptionAuthCopy | undefined {
  if (model.auth_mode !== "subscription") {
    return undefined;
  }
  if (model.provider === "kimi") {
    const source = localSubscriptionAuthPath(model.provider, env, home);
    return {
      source,
      destination: remoteAuthPath(model.provider),
      entries: kimiSubscriptionAuthEntries(source)
    };
  }
  return {
    source: localSubscriptionAuthPath(model.provider, env, home),
    destination: remoteAuthPath(model.provider)
  };
}

export async function prepareSubscriptionAuthCopy(
  model: Pick<ModalModelSpec, "provider" | "auth_mode" | "model">,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir(),
  options: KimiSubscriptionAuthPreparationOptions = {}
): Promise<SubscriptionAuthCopy | undefined> {
  const direct = subscriptionAuthCopy(model, env, home);
  if (direct === undefined || model.provider !== "kimi") return direct;

  const source = direct.source;
  const credentialPath = await refreshKimiSubscriptionAuth(source, model.model, env, options);
  const snapshot = await mkdtemp(path.join(os.tmpdir(), "ultrafuzz-kimi-auth-"));
  try {
    const config = kimiConfig(await readFile(path.join(source, "config.toml"), "utf8"));
    const token = kimiOAuthToken(await readFile(credentialPath, "utf8"), credentialPath);
    await writeFile(path.join(snapshot, "config.toml"), kimiSnapshotConfig(config, model.model), {
      encoding: "utf8",
      mode: 0o600
    });
    await mkdir(path.join(snapshot, "credentials"), { recursive: true, mode: 0o700 });
    // Modal workers share one Kimi auth home per row. The refresh token is
    // deliberately staged into that shared home so long-running rows can refresh
    // under Kimi Code's OAuth lock instead of racing independent credential
    // copies.
    await writeFile(
      path.join(snapshot, "credentials", path.basename(credentialPath)),
      `${JSON.stringify(kimiWorkerOAuthSnapshot(token), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await cp(path.join(source, "device_id"), path.join(snapshot, "device_id"));
    return {
      source: snapshot,
      destination: remoteAuthPath("kimi"),
      entries: kimiSubscriptionAuthEntries(snapshot, path.basename(credentialPath)),
      cleanup: async () => {
        await rm(snapshot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

export async function refreshKimiSubscriptionAuth(
  source: string,
  model: string,
  env: Record<string, string | undefined> = process.env,
  options: KimiSubscriptionAuthPreparationOptions = {}
): Promise<string> {
  const config = kimiConfig(await readFile(path.join(source, "config.toml"), "utf8"));
  const credential = kimiCredentialRef(source, config, model);
  const credentialPath = credential.path;
  const oauthHost = kimiOAuthHost(env, credential.oauthHost);
  await access(credentialPath, constants.R_OK | constants.W_OK);
  await access(path.join(source, "device_id"), constants.R_OK);

  const release = await acquireKimiRefreshLock(source, credential.lockName);
  try {
    const token = kimiOAuthToken(await readFile(credentialPath, "utf8"), credentialPath);
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    const threshold = Math.max(300, Math.floor((token.expires_in ?? 0) * 0.5));
    if (token.expires_at - threshold > now) return credentialPath;
    if (token.refresh_token.trim() === "") {
      throw new Error("Kimi subscription token is near expiry and has no refresh token; run `kimi login`");
    }
    const refreshed = await exchangeKimiOAuthRefresh(
      {
        deviceId: (await readFile(path.join(source, "device_id"), "utf8")).trim(),
        oauthHost,
        refreshToken: token.refresh_token
      },
      options
    );
    const next = mergeKimiOAuthRefresh(token, refreshed, now);
    await writeJsonAtomic(credentialPath, next);
    return credentialPath;
  } finally {
    await release();
  }
}

/**
 * Serializes one Modal node-provider Kimi subscription attempt against one
 * rotating credential. The ordinary OAuth lock protects an individual refresh
 * only; this distinct lease is deliberately scoped to the node-provider
 * lifecycle from before it snapshots a token until after it brokers and
 * reconciles the worker's successor. The detached benchmark runner has a
 * separate recovery lifecycle and does not use this primitive.
 */
export async function acquireKimiModalNodeExecutionLease(
  model: string,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir(),
  options: { timeoutMs?: number; lockUpdateMs?: number } = {}
): Promise<KimiModalNodeExecutionLease> {
  // Canonicalize a whole-home alias, which makes aliases of the same Kimi
  // home share one lease, then reject nested aliases and hard-linked
  // credentials. Otherwise two distinct homes could point at one rotating
  // credential while acquiring different local locks and remote lease tags.
  const source = await realpath(localSubscriptionAuthPath("kimi", env, home));
  const sourceDirectoryHandle = await openValidatedKimiLeaseDirectory(source, "Kimi subscription auth root");
  let credentialsDirectoryHandle: FileHandle | undefined;
  let oauthDirectoryHandle: FileHandle | undefined;
  let configHandle: FileHandle | undefined;
  let credentialHandle: FileHandle | undefined;
  let deviceHandle: FileHandle | undefined;
  let targetHandle: FileHandle | undefined;
  let fenceHandle: FileHandle | undefined;
  let releaseLock: (() => Promise<void>) | undefined;
  let config: KimiConfig | undefined;
  let credential: ReturnType<typeof kimiCredentialRef> | undefined;
  let credentialName: string | undefined;
  let sourceAnchor: string | undefined;
  let credentialsAnchor: string | undefined;
  let oauthAnchor: string | undefined;
  let credentialsDirectoryDevice: string | undefined;
  let credentialsDirectoryInode: string | undefined;
  let target: string | undefined;
  let leaseName: string | undefined;
  let fenceName: string | undefined;
  try {
    sourceAnchor = await kimiLeaseDirectoryDescriptorPath(sourceDirectoryHandle, "Kimi subscription auth root");
    configHandle = await openKimiLeaseFileAt(
      sourceAnchor,
      "config.toml",
      constants.O_RDONLY,
      "Kimi subscription config"
    );
    deviceHandle = await openKimiLeaseFileAt(
      sourceAnchor,
      "device_id",
      constants.O_RDONLY,
      "Kimi subscription device identity"
    );
    credentialsDirectoryHandle = await openKimiLeaseDirectoryAt(
      sourceAnchor,
      "credentials",
      "Kimi subscription credential directory"
    );
    credentialsAnchor = await kimiLeaseDirectoryDescriptorPath(
      credentialsDirectoryHandle,
      "Kimi subscription credential directory"
    );
    const credentialsDirectoryMetadata = await credentialsDirectoryHandle.stat({ bigint: true });
    credentialsDirectoryDevice = String(credentialsDirectoryMetadata.dev);
    credentialsDirectoryInode = String(credentialsDirectoryMetadata.ino);
    config = kimiConfig(await readKimiLeaseFile(configHandle, "Kimi subscription config"));
    credential = kimiCredentialRef(source, config, model);
    credentialName = path.basename(credential.path);
    credentialHandle = await openKimiLeaseFileAt(
      credentialsAnchor,
      credentialName,
      constants.O_RDWR,
      "Kimi subscription credential"
    );

    const oauthDir = path.join(sourceAnchor, "oauth");
    try {
      await mkdir(oauthDir, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    oauthDirectoryHandle = await openKimiLeaseDirectoryAt(
      sourceAnchor,
      "oauth",
      "Kimi subscription OAuth lock directory"
    );
    oauthAnchor = await kimiLeaseDirectoryDescriptorPath(
      oauthDirectoryHandle,
      "Kimi subscription OAuth lock directory"
    );
    leaseName = `.${credential.lockName}.ultrafuzz-modal-node-execution`;
    fenceName = `.${credential.lockName}.ultrafuzz-modal-node-fence`;
    target = path.join(source, "credentials", leaseName);
    const anchoredTarget = path.join(credentialsAnchor, leaseName);
    targetHandle = await openKimiLeaseFileAt(
      credentialsAnchor,
      leaseName,
      constants.O_CREAT | constants.O_RDWR,
      "Kimi Modal execution lease file"
    );
    await targetHandle.chmod(0o600);
    fenceHandle = await openKimiLeaseFileAt(
      credentialsAnchor,
      fenceName,
      constants.O_CREAT | constants.O_RDWR,
      "Kimi Modal execution fence file"
    );
    await fenceHandle.chmod(0o600);

    const timeoutMs = Math.max(5_000, Math.floor(options.timeoutMs ?? 120_000));
    releaseLock = await lockfile.lock(anchoredTarget, {
      retries: {
        retries: Math.max(1, Math.ceil(timeoutMs / 500)),
        factor: 1,
        minTimeout: 250,
        maxTimeout: 500
      },
      // If the controller dies while its detached worker may still be using
      // the token, do not let another controller immediately reuse that token.
      stale: timeoutMs + 300_000,
      ...(options.lockUpdateMs === undefined ? {} : { update: Math.max(1_000, Math.floor(options.lockUpdateMs)) }),
      realpath: false
    });
    const [previousTarget, previousFence] = await Promise.all([
      readBoundKimiExecutionLeaseMetadata(
        credentialsAnchor,
        leaseName,
        targetHandle,
        "Kimi Modal execution lease file"
      ),
      readBoundKimiExecutionLeaseMetadata(credentialsAnchor, fenceName, fenceHandle, "Kimi Modal execution fence file")
    ]);
    if (previousTarget === undefined && previousFence === undefined) {
      const legacyLeaseName = `${credential.lockName}.ultrafuzz-modal-node-execution`;
      const legacyFenceName = `${credential.lockName}.ultrafuzz-modal-node-fence`;
      const [legacyTarget, legacyFence] = await Promise.all([
        readOptionalKimiExecutionLeaseMetadataAt(
          oauthAnchor,
          legacyLeaseName,
          "legacy Kimi Modal execution lease file"
        ),
        readOptionalKimiExecutionLeaseMetadataAt(oauthAnchor, legacyFenceName, "legacy Kimi Modal execution fence file")
      ]);
      assertKimiLegacyExecutionLeaseJournalsMigratable(legacyTarget, legacyFence);
    } else {
      assertKimiExecutionLeaseJournalsAcquirable(previousTarget, previousFence);
    }
  } catch (error) {
    await releaseLock?.().catch(() => undefined);
    await closeKimiLeaseHandles([
      targetHandle,
      fenceHandle,
      credentialHandle,
      configHandle,
      deviceHandle,
      credentialsDirectoryHandle,
      oauthDirectoryHandle,
      sourceDirectoryHandle
    ]).catch(() => undefined);
    throw new Error(
      `unable to acquire Kimi Modal execution lease: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  if (
    releaseLock === undefined ||
    targetHandle === undefined ||
    fenceHandle === undefined ||
    credentialHandle === undefined ||
    configHandle === undefined ||
    deviceHandle === undefined ||
    credentialsDirectoryHandle === undefined ||
    oauthDirectoryHandle === undefined ||
    config === undefined ||
    credential === undefined ||
    credentialName === undefined ||
    sourceAnchor === undefined ||
    credentialsAnchor === undefined ||
    oauthAnchor === undefined ||
    target === undefined ||
    leaseName === undefined ||
    fenceName === undefined ||
    credentialsDirectoryDevice === undefined ||
    credentialsDirectoryInode === undefined
  ) {
    await releaseLock?.().catch(() => undefined);
    await closeKimiLeaseHandles([
      targetHandle,
      fenceHandle,
      credentialHandle,
      configHandle,
      deviceHandle,
      credentialsDirectoryHandle,
      oauthDirectoryHandle,
      sourceDirectoryHandle
    ]).catch(() => undefined);
    throw new Error("Kimi Modal execution lease handles were not initialized");
  }

  const heldReleaseLock = releaseLock;
  const heldTargetHandle = targetHandle;
  const heldFenceHandle = fenceHandle;
  const heldCredentialHandle: KimiLeaseCredentialHandleBinding = { current: credentialHandle };
  const heldConfigHandle = configHandle;
  const heldDeviceHandle = deviceHandle;
  const heldCredentialsDirectoryHandle = credentialsDirectoryHandle;
  const heldOauthDirectoryHandle = oauthDirectoryHandle;
  const heldConfig = config;
  const heldCredential = credential;
  const heldCredentialName = credentialName;
  const heldSourceAnchor = sourceAnchor;
  const heldCredentialsAnchor = credentialsAnchor;
  const heldOauthAnchor = oauthAnchor;
  const heldTarget = target;
  const heldLeaseName = leaseName;
  const heldFenceName = fenceName;
  const credentialPath = path.join(source, "credentials", heldCredentialName);
  const credentialLeaseId = createHash("sha256")
    .update("ultrafuzz.kimi-modal-credential.v2\0")
    .update(credentialsDirectoryDevice)
    .update("\0")
    .update(credentialsDirectoryInode)
    .update("\0")
    .update(heldCredentialName)
    .digest("hex");
  const ownerId = randomUUID();
  const journalPairId = randomUUID();

  let handleState: KimiModalNodeExecutionLeaseHandleState = "open";
  let rotationState: KimiModalNodeExecutionLeaseState = "active";
  let transitionSequence = 1;
  let operationTail = Promise.resolve();
  try {
    await writeKimiExecutionLeaseStatePair(
      heldCredentialsAnchor,
      heldLeaseName,
      heldTargetHandle,
      heldFenceName,
      heldFenceHandle,
      credentialLeaseId,
      ownerId,
      journalPairId,
      transitionSequence,
      rotationState
    );
    await heldCredentialsDirectoryHandle.sync();
    await sourceDirectoryHandle.sync();
  } catch (error) {
    await heldReleaseLock().catch(() => undefined);
    await closeKimiLeaseHandles([
      heldTargetHandle,
      heldFenceHandle,
      heldCredentialHandle.current,
      heldConfigHandle,
      heldDeviceHandle,
      heldCredentialsDirectoryHandle,
      heldOauthDirectoryHandle,
      sourceDirectoryHandle
    ]).catch(() => undefined);
    throw new Error("unable to initialize Kimi Modal execution lease metadata", { cause: error });
  }
  const serializeLeaseOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const assertLeaseOpen = (): void => {
    if (handleState !== "open") throw new Error("Kimi Modal execution lease is no longer usable");
  };
  const assertOwnerUnlocked = async (): Promise<void> => {
    assertLeaseOpen();
    let targetMetadata: unknown;
    let fenceMetadata: unknown;
    try {
      await assertKimiLeaseRootEntry(source, sourceDirectoryHandle, "Kimi subscription auth root");
      await assertKimiLeaseDirectoryEntryMatchesHandle(
        heldSourceAnchor,
        "credentials",
        heldCredentialsDirectoryHandle,
        "Kimi subscription credential directory"
      );
      await assertKimiLeaseDirectoryEntryMatchesHandle(
        heldSourceAnchor,
        "oauth",
        heldOauthDirectoryHandle,
        "Kimi subscription OAuth lock directory"
      );
      await assertKimiLeaseEntryMatchesHandle(
        heldSourceAnchor,
        "config.toml",
        heldConfigHandle,
        "Kimi subscription config"
      );
      await assertKimiLeaseEntryMatchesHandle(
        heldSourceAnchor,
        "device_id",
        heldDeviceHandle,
        "Kimi subscription device identity"
      );
      await assertKimiLeaseEntryMatchesHandle(
        heldCredentialsAnchor,
        heldCredentialName,
        heldCredentialHandle.current,
        credentialPath
      );
      [targetMetadata, fenceMetadata] = await Promise.all([
        readBoundKimiExecutionLeaseMetadata(
          heldCredentialsAnchor,
          heldLeaseName,
          heldTargetHandle,
          "Kimi Modal execution lease file"
        ),
        readBoundKimiExecutionLeaseMetadata(
          heldCredentialsAnchor,
          heldFenceName,
          heldFenceHandle,
          "Kimi Modal execution fence file"
        )
      ]);
    } catch (error) {
      throw new Error("Kimi Modal execution lease ownership could not be verified", { cause: error });
    }
    if (
      ![targetMetadata, fenceMetadata].every((metadata) =>
        isKimiExecutionLeaseOwnerState(
          metadata,
          credentialLeaseId,
          ownerId,
          journalPairId,
          transitionSequence,
          rotationState
        )
      )
    ) {
      throw new Error("Kimi Modal execution lease ownership was superseded");
    }
  };
  const transitionRotationStateUnlocked = async (next: KimiModalNodeExecutionLeaseState): Promise<void> => {
    const nextSequence = transitionSequence + 1;
    await writeKimiExecutionLeaseStatePair(
      heldCredentialsAnchor,
      heldLeaseName,
      heldTargetHandle,
      heldFenceName,
      heldFenceHandle,
      credentialLeaseId,
      ownerId,
      journalPairId,
      nextSequence,
      next
    );
    transitionSequence = nextSequence;
    rotationState = next;
  };
  const armRotationGenerationUnlocked = async (): Promise<void> => {
    if (rotationState === "active") return;
    if (rotationState !== "resolved") {
      throw new Error("Kimi Modal credential rotation remains durably unresolved");
    }
    await transitionRotationStateUnlocked("active");
  };
  const markRotationPossibleUnlocked = async (): Promise<void> => {
    await assertOwnerUnlocked();
    if (rotationState === "rotation-possible") return;
    if (rotationState === "resolved") await armRotationGenerationUnlocked();
    await transitionRotationStateUnlocked("rotation-possible");
  };
  const markRotationResolvedUnlocked = async (): Promise<void> => {
    await assertOwnerUnlocked();
    if (rotationState === "resolved") return;
    if (rotationState !== "rotation-possible") {
      throw new Error("Kimi Modal credential rotation was not marked possible");
    }
    await transitionRotationStateUnlocked("resolved");
  };
  const assertOwner = (): Promise<void> => serializeLeaseOperation(assertOwnerUnlocked);
  return {
    assertOwner,
    credentialLeaseId,
    credentialPath,
    leasePath: heldTarget,
    markRotationPossible: () => serializeLeaseOperation(markRotationPossibleUnlocked),
    markRotationResolved: () => serializeLeaseOperation(markRotationResolvedUnlocked),
    ownerId,
    prepareAuthCopy: (leaseEnv = env, preparationOptions = {}) =>
      serializeLeaseOperation(async () => {
        await assertOwnerUnlocked();
        await refreshKimiSubscriptionCredentialHandle(
          heldCredentialHandle,
          heldDeviceHandle,
          heldCredentialsDirectoryHandle,
          heldCredentialsAnchor,
          heldOauthAnchor,
          heldCredential,
          heldCredentialName,
          credentialPath,
          leaseEnv,
          preparationOptions,
          markRotationPossibleUnlocked,
          async () => {
            await markRotationResolvedUnlocked();
            await armRotationGenerationUnlocked();
          }
        );
        await assertOwnerUnlocked();
        return snapshotKimiSubscriptionAuthFromLease({
          config: heldConfig,
          configHandle: heldConfigHandle,
          credentialHandle: heldCredentialHandle.current,
          credentialName: heldCredentialName,
          credentialPath,
          deviceHandle: heldDeviceHandle,
          model
        });
      }),
    reconcileCredential: (remoteCredential, reconcileOptions = {}) =>
      serializeLeaseOperation(async () => {
        await assertOwnerUnlocked();
        const reconciled = await reconcileKimiSubscriptionCredentialHandle(
          heldCredentialHandle,
          heldCredentialsDirectoryHandle,
          heldCredentialsAnchor,
          heldOauthAnchor,
          heldCredential.lockName,
          heldCredentialName,
          credentialPath,
          remoteCredential,
          reconcileOptions
        );
        await assertOwnerUnlocked();
        return reconciled;
      }),
    source,
    release: () =>
      serializeLeaseOperation(async () => {
        if (handleState === "closed") return;
        let primaryError: unknown;
        try {
          await assertOwnerUnlocked();
          if (rotationState === "rotation-possible") {
            throw new Error("Kimi Modal credential rotation remains durably unresolved; credential fence was retained");
          }
          if (rotationState !== "resolved") await transitionRotationStateUnlocked("resolved");
        } catch (error) {
          primaryError = error;
        }

        handleState = "releasing";
        const cleanupErrors: unknown[] = [];
        for (const cleanup of [
          heldReleaseLock,
          () => heldCredentialsDirectoryHandle.sync(),
          () => sourceDirectoryHandle.sync()
        ]) {
          try {
            await cleanup();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          await closeKimiLeaseHandles([
            heldTargetHandle,
            heldFenceHandle,
            heldCredentialHandle.current,
            heldConfigHandle,
            heldDeviceHandle,
            heldCredentialsDirectoryHandle,
            heldOauthDirectoryHandle,
            sourceDirectoryHandle
          ]);
        } catch (error) {
          cleanupErrors.push(error);
        }
        handleState = "closed";
        const failures = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors];
        if (failures.length === 0) return;
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Kimi Modal execution lease release failed");
      })
  };
}

async function refreshKimiSubscriptionCredentialHandle(
  credentialHandle: KimiLeaseCredentialHandleBinding,
  deviceHandle: FileHandle,
  credentialsDirectoryHandle: FileHandle,
  credentialsAnchor: string,
  oauthAnchor: string,
  credential: ReturnType<typeof kimiCredentialRef>,
  credentialName: string,
  credentialPath: string,
  env: Record<string, string | undefined>,
  options: KimiSubscriptionAuthPreparationOptions,
  markRotationPossible: () => Promise<void>,
  resolveAndRearmRotation: () => Promise<void>
): Promise<void> {
  const release = await acquireKimiRefreshLockAt(oauthAnchor, credential.lockName);
  try {
    await assertKimiLeaseEntryMatchesHandle(
      credentialsAnchor,
      credentialName,
      credentialHandle.current,
      credentialPath
    );
    if (credentialHandle.pendingLocalRefresh !== undefined) {
      await recoverPendingKimiLocalRefresh(
        credentialHandle,
        credentialsDirectoryHandle,
        credentialsAnchor,
        credentialName,
        credentialPath,
        resolveAndRearmRotation
      );
      return;
    }
    const token = kimiOAuthToken(await readKimiLeaseFile(credentialHandle.current, credentialPath), credentialPath);
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    const threshold = Math.max(300, Math.floor((token.expires_in ?? 0) * 0.5));
    if (token.expires_at - threshold > now) return;
    if (token.refresh_token.trim() === "") {
      throw new Error("Kimi subscription token is near expiry and has no refresh token; run `kimi login`");
    }
    const deviceId = (await readKimiLeaseFile(deviceHandle, "Kimi subscription device identity")).trim();
    // A response can have rotated the one-time refresh token even if the
    // controller dies before observing it. Fence conservatively before the
    // request, and resolve only after the replacement rename and directory
    // fsync have both succeeded.
    await assertKimiLeaseEntryMatchesHandle(
      credentialsAnchor,
      credentialName,
      credentialHandle.current,
      credentialPath
    );
    await markRotationPossible();
    await assertKimiLeaseEntryMatchesHandle(
      credentialsAnchor,
      credentialName,
      credentialHandle.current,
      credentialPath
    );
    const refreshed = await exchangeKimiOAuthRefresh(
      {
        oauthHost: kimiOAuthHost(env, credential.oauthHost),
        refreshToken: token.refresh_token,
        deviceId
      },
      options
    );
    const intendedCredential = mergeKimiOAuthRefresh(token, refreshed, now);
    credentialHandle.pendingLocalRefresh = {
      intendedCredentialSha256: kimiLeaseJsonSha256(intendedCredential, credentialPath)
    };
    try {
      await replaceKimiLeaseJsonAtomic(
        credentialHandle,
        credentialsDirectoryHandle,
        credentialsAnchor,
        credentialName,
        intendedCredential,
        credentialPath
      );
    } catch (error) {
      if (!(error instanceof KimiLeaseDirectorySyncAfterRenameError)) throw error;
      try {
        await recoverPendingKimiLocalRefresh(
          credentialHandle,
          credentialsDirectoryHandle,
          credentialsAnchor,
          credentialName,
          credentialPath,
          resolveAndRearmRotation
        );
        return;
      } catch {
        // Preserve the original commit failure and the pending exact-successor
        // intent. A later preparation can retry proof and directory fsync, but
        // can never mistake different installed bytes for the intended token.
        throw error;
      }
    }
    await resolveAndRearmRotation();
    credentialHandle.pendingLocalRefresh = undefined;
  } finally {
    await release();
  }
}

async function recoverPendingKimiLocalRefresh(
  binding: KimiLeaseCredentialHandleBinding,
  directoryHandle: FileHandle,
  directoryAnchor: string,
  credentialName: string,
  label: string,
  resolveAndRearmRotation: () => Promise<void>
): Promise<void> {
  const pending = binding.pendingLocalRefresh;
  if (pending === undefined) return;
  const installed = await readKimiLeaseFile(binding.current, label);
  const installedSha256 = createHash("sha256").update(installed, "utf8").digest("hex");
  if (installedSha256 !== pending.intendedCredentialSha256) {
    throw new Error("pending Kimi local-refresh successor does not exactly match the installed credential");
  }
  await assertKimiLeaseEntryMatchesHandle(directoryAnchor, credentialName, binding.current, label);
  await directoryHandle.sync();
  await assertKimiLeaseEntryMatchesHandle(directoryAnchor, credentialName, binding.current, label);
  await resolveAndRearmRotation();
  binding.pendingLocalRefresh = undefined;
}

async function reconcileKimiSubscriptionCredentialHandle(
  credentialHandle: KimiLeaseCredentialHandleBinding,
  credentialsDirectoryHandle: FileHandle,
  credentialsAnchor: string,
  oauthAnchor: string,
  lockName: string,
  credentialName: string,
  credentialPath: string,
  remoteCredential: string,
  options: { sourceRefreshTokenSha256?: string }
): Promise<boolean> {
  const remoteToken = kimiOAuthToken(remoteCredential, `Modal volume ${path.basename(credentialPath)}`, {
    requireRefreshToken: false
  });
  if (remoteToken.refresh_token.trim() === "") return false;
  const release = await acquireKimiRefreshLockAt(oauthAnchor, lockName);
  try {
    if (credentialHandle.pendingLocalRefresh !== undefined) {
      throw new Error("pending Kimi local-refresh successor must be recovered before remote reconciliation");
    }
    const localToken = kimiOAuthToken(
      await readKimiLeaseFile(credentialHandle.current, credentialPath),
      credentialPath
    );
    if (isKimiCredentialCommitEquivalent(localToken, remoteToken)) {
      // A prior rename may have committed even though the containing-directory
      // fsync threw. Re-fsync the directory and recognize the exact intended
      // refresh-token/expiry generation idempotently.
      await assertKimiLeaseEntryMatchesHandle(
        credentialsAnchor,
        credentialName,
        credentialHandle.current,
        credentialPath
      );
      await credentialsDirectoryHandle.sync();
      await assertKimiLeaseEntryMatchesHandle(
        credentialsAnchor,
        credentialName,
        credentialHandle.current,
        credentialPath
      );
      return true;
    }
    if (!shouldReplaceKimiCredential(localToken, remoteToken, options)) return false;
    await replaceKimiLeaseJsonAtomic(
      credentialHandle,
      credentialsDirectoryHandle,
      credentialsAnchor,
      credentialName,
      remoteToken,
      credentialPath
    );
    return true;
  } finally {
    await release();
  }
}

async function snapshotKimiSubscriptionAuthFromLease(input: {
  config: KimiConfig;
  configHandle: FileHandle;
  credentialHandle: FileHandle;
  credentialName: string;
  credentialPath: string;
  deviceHandle: FileHandle;
  model: string;
}): Promise<SubscriptionAuthCopy> {
  // Revalidate every held inode before consuming it, but snapshot only through
  // the descriptors acquired with the execution lease.
  await readKimiLeaseFile(input.configHandle, "Kimi subscription config");
  const credentialText = await readKimiLeaseFile(input.credentialHandle, input.credentialPath);
  const token = kimiOAuthToken(credentialText, input.credentialPath);
  const deviceId = await readKimiLeaseFile(input.deviceHandle, "Kimi subscription device identity");
  const snapshot = await mkdtemp(path.join(os.tmpdir(), "ultrafuzz-kimi-auth-"));
  try {
    await writeFile(path.join(snapshot, "config.toml"), kimiSnapshotConfig(input.config, input.model), {
      encoding: "utf8",
      mode: 0o600
    });
    await mkdir(path.join(snapshot, "credentials"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(snapshot, "credentials", input.credentialName),
      `${JSON.stringify(kimiWorkerOAuthSnapshot(token), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await writeFile(path.join(snapshot, "device_id"), deviceId, { encoding: "utf8", mode: 0o600 });
    return {
      source: snapshot,
      destination: remoteAuthPath("kimi"),
      entries: kimiSubscriptionAuthEntries(snapshot, input.credentialName),
      cleanup: async () => {
        await rm(snapshot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

async function acquireKimiRefreshLockAt(oauthAnchor: string, lockName: string): Promise<() => Promise<void>> {
  const targetHandle = await openKimiLeaseFileAt(
    oauthAnchor,
    lockName,
    constants.O_CREAT | constants.O_RDWR,
    "Kimi OAuth refresh lock file"
  );
  await targetHandle.close();
  const target = path.join(oauthAnchor, lockName);
  try {
    return await lockfile.lock(target, {
      retries: {
        retries: 120,
        factor: 1,
        minTimeout: 500,
        maxTimeout: 1_000
      },
      stale: 5_000,
      realpath: false
    });
  } catch (error) {
    throw new Error(
      `unable to acquire Kimi OAuth refresh lock: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

async function replaceKimiLeaseJsonAtomic(
  binding: KimiLeaseCredentialHandleBinding,
  directoryHandle: FileHandle,
  directoryAnchor: string,
  credentialName: string,
  value: Record<string, unknown>,
  label: string
): Promise<void> {
  const serialized = serializeKimiLeaseJson(value, label);
  const previousHandle = binding.current;
  await assertKimiLeaseEntryMatchesHandle(directoryAnchor, credentialName, previousHandle, label);

  const temporaryName = `ultrafuzz-${randomUUID()}.tmp`;
  const temporaryPath = path.join(directoryAnchor, temporaryName);
  let temporaryHandle: FileHandle | undefined;
  let replacementHandle: FileHandle | undefined;
  let temporaryCreated = false;
  let renamed = false;
  try {
    temporaryHandle = await openKimiLeaseFileAt(
      directoryAnchor,
      temporaryName,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      "temporary Kimi subscription credential"
    );
    temporaryCreated = true;
    let offset = 0;
    while (offset < serialized.length) {
      const { bytesWritten } = await temporaryHandle.write(serialized, offset, serialized.length - offset, offset);
      if (bytesWritten <= 0) throw new Error(`${label} could not be written completely`);
      offset += bytesWritten;
    }
    await temporaryHandle.chmod(0o600);
    await temporaryHandle.sync();
    const temporaryMetadata = await temporaryHandle.stat({ bigint: true });
    await assertKimiLeaseEntryMatchesHandle(directoryAnchor, credentialName, previousHandle, label);
    await rename(temporaryPath, path.join(directoryAnchor, credentialName));
    renamed = true;

    const committedHandle = temporaryHandle;
    temporaryHandle = undefined;
    binding.current = committedHandle;
    const commitErrors: unknown[] = [];
    let rebindError: unknown;
    let directorySyncError: unknown;
    let previousCloseError: unknown;
    try {
      replacementHandle = await openKimiLeaseFileAt(
        directoryAnchor,
        credentialName,
        constants.O_RDWR,
        "replacement Kimi subscription credential"
      );
      const replacementMetadata = await replacementHandle.stat({ bigint: true });
      if (
        replacementMetadata.dev !== temporaryMetadata.dev ||
        replacementMetadata.ino !== temporaryMetadata.ino ||
        replacementMetadata.size !== BigInt(serialized.length)
      ) {
        throw new Error(`${label} replacement could not be rebound safely`);
      }
      await assertKimiLeaseEntryMatchesHandle(directoryAnchor, credentialName, replacementHandle, label);
      binding.current = replacementHandle;
      replacementHandle = undefined;
      await committedHandle.close();
    } catch (error) {
      rebindError = error;
      commitErrors.push(error);
    }
    try {
      await directoryHandle.sync();
    } catch (error) {
      directorySyncError = error;
      commitErrors.push(error);
    }
    try {
      await previousHandle.close();
    } catch (error) {
      previousCloseError = error;
      commitErrors.push(error);
    }
    if (directorySyncError !== undefined && rebindError === undefined && previousCloseError === undefined) {
      throw new KimiLeaseDirectorySyncAfterRenameError(directorySyncError);
    }
    if (commitErrors.length === 1) throw commitErrors[0];
    if (commitErrors.length > 1) {
      throw new AggregateError(commitErrors, `${label} replacement could not be committed durably`);
    }
  } finally {
    await replacementHandle?.close().catch(() => undefined);
    await temporaryHandle?.close().catch(() => undefined);
    if (temporaryCreated && !renamed) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

class KimiLeaseDirectorySyncAfterRenameError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Kimi credential directory fsync failed after rename", { cause });
  }
}

function kimiLeaseJsonSha256(value: Record<string, unknown>, label: string): string {
  return createHash("sha256").update(serializeKimiLeaseJson(value, label)).digest("hex");
}

function serializeKimiLeaseJson(value: Record<string, unknown>, label: string): Buffer {
  const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (serialized.length < 1 || serialized.length > 1024 * 1024) {
    throw new Error(`${label} has an unsafe size`);
  }
  return serialized;
}

async function assertKimiLeaseEntryMatchesHandle(
  directoryAnchor: string,
  name: string,
  handle: FileHandle,
  label: string
): Promise<void> {
  const [entry, held] = await Promise.all([
    lstat(path.join(directoryAnchor, name), { bigint: true }),
    handle.stat({ bigint: true })
  ]);
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    !held.isFile() ||
    entry.nlink !== 1n ||
    held.nlink !== 1n ||
    entry.dev !== held.dev ||
    entry.ino !== held.ino
  ) {
    throw new Error(`${label} is no longer owned by the Kimi Modal node execution lease`);
  }
}

async function assertKimiLeaseRootEntry(root: string, handle: FileHandle, label: string): Promise<void> {
  const held = await handle.stat({ bigint: true });
  let entry: BigIntStats;
  try {
    entry = await lstat(root, { bigint: true });
  } catch (error) {
    // A renamed root remains safely reachable through the held descriptor. A
    // different directory installed at the canonical pathname is a split
    // physical lease namespace and must supersede this lease.
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    !held.isDirectory() ||
    entry.dev !== held.dev ||
    entry.ino !== held.ino
  ) {
    throw new Error(`${label} pathname now names a different physical directory`);
  }
}

async function assertKimiLeaseDirectoryEntryMatchesHandle(
  parentAnchor: string,
  name: string,
  handle: FileHandle,
  label: string
): Promise<void> {
  const [entry, held] = await Promise.all([
    lstat(path.join(parentAnchor, name), { bigint: true }),
    handle.stat({ bigint: true })
  ]);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    !held.isDirectory() ||
    entry.dev !== held.dev ||
    entry.ino !== held.ino
  ) {
    throw new Error(`${label} is no longer owned by the Kimi Modal node execution lease`);
  }
}

async function readBoundKimiExecutionLeaseMetadata(
  directoryAnchor: string,
  name: string,
  handle: FileHandle,
  label: string
): Promise<Record<string, unknown> | undefined> {
  await assertKimiLeaseEntryMatchesHandle(directoryAnchor, name, handle, label);
  const metadata = await readKimiExecutionLeaseMetadata(handle);
  await assertKimiLeaseEntryMatchesHandle(directoryAnchor, name, handle, label);
  return metadata;
}

async function readOptionalKimiExecutionLeaseMetadataAt(
  directoryAnchor: string,
  name: string,
  label: string
): Promise<OptionalKimiExecutionLeaseJournal> {
  if (!isSafeKimiLeaseEntryName(name)) throw new Error(`${label} name is unsafe`);
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(path.join(directoryAnchor, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { declaresPairState: false, exists: false, metadata: undefined };
      }
      throw error;
    }
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw new Error(`${label} is unsafe`);
    const journal = await readKimiExecutionLeaseJournal(handle);
    await assertKimiLeaseEntryMatchesHandle(directoryAnchor, name, handle, label);
    return { ...journal, exists: true };
  } catch (error) {
    if (error instanceof Error && error.message === `${label} is unsafe`) throw error;
    throw new Error(`${label} is unsafe`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeBoundKimiExecutionLeaseMetadata(
  directoryAnchor: string,
  name: string,
  handle: FileHandle,
  label: string,
  credentialLeaseId: string,
  ownerId: string,
  journalPairId: string,
  transitionSequence: number,
  rotationState: KimiModalNodeExecutionLeaseState
): Promise<void> {
  await assertKimiLeaseEntryMatchesHandle(directoryAnchor, name, handle, label);
  await writeKimiExecutionLeaseMetadata(
    handle,
    credentialLeaseId,
    ownerId,
    journalPairId,
    transitionSequence,
    rotationState
  );
  await assertKimiLeaseEntryMatchesHandle(directoryAnchor, name, handle, label);
}

async function writeKimiExecutionLeaseStatePair(
  directoryAnchor: string,
  leaseName: string,
  leaseHandle: FileHandle,
  fenceName: string,
  fenceHandle: FileHandle,
  credentialLeaseId: string,
  ownerId: string,
  journalPairId: string,
  transitionSequence: number,
  rotationState: KimiModalNodeExecutionLeaseState
): Promise<void> {
  const lease = {
    name: leaseName,
    handle: leaseHandle,
    label: "Kimi Modal execution lease file"
  };
  const fence = {
    name: fenceName,
    handle: fenceHandle,
    label: "Kimi Modal execution fence file"
  };
  // Any unresolved transition reaches the independent sidecar first; a
  // resolution reaches it last. Therefore replacing either one pathname can
  // never make a single-path swap hide an unresolved generation.
  const entries = rotationState === "resolved" ? [lease, fence] : [fence, lease];
  for (const entry of entries) {
    await writeBoundKimiExecutionLeaseMetadata(
      directoryAnchor,
      entry.name,
      entry.handle,
      entry.label,
      credentialLeaseId,
      ownerId,
      journalPairId,
      transitionSequence,
      rotationState
    );
  }
  await Promise.all(
    entries.map((entry) => assertKimiLeaseEntryMatchesHandle(directoryAnchor, entry.name, entry.handle, entry.label))
  );
}

function isKimiExecutionLeaseOwnerState(
  metadata: unknown,
  credentialLeaseId: string,
  ownerId: string,
  journalPairId: string,
  transitionSequence: number,
  rotationState: KimiModalNodeExecutionLeaseState
): boolean {
  return (
    isRecord(metadata) &&
    metadata.schema_version === "ultrafuzz.kimi-modal-execution-lease.v1" &&
    metadata.credential_lease === credentialLeaseId &&
    metadata.owner_id === ownerId &&
    metadata.journal_pair_id === journalPairId &&
    metadata.transition_sequence === transitionSequence &&
    metadata.rotation_state === rotationState
  );
}

function assertKimiExecutionLeaseJournalsAcquirable(
  target: Record<string, unknown> | undefined,
  fence: Record<string, unknown> | undefined
): void {
  if (target === undefined && fence === undefined) return;

  const targetPair = kimiExecutionLeasePairState(target);
  const fencePair = kimiExecutionLeasePairState(fence);
  const exactPair =
    targetPair !== undefined &&
    fencePair !== undefined &&
    targetPair.credentialLeaseId === fencePair.credentialLeaseId &&
    targetPair.ownerId === fencePair.ownerId &&
    targetPair.journalPairId === fencePair.journalPairId &&
    targetPair.transitionSequence === fencePair.transitionSequence &&
    targetPair.rotationState === fencePair.rotationState;
  if (!exactPair || targetPair?.rotationState !== "resolved") {
    throw new Error(
      "a durable unresolved Kimi Modal credential-rotation fence is present or its paired journals are inconsistent"
    );
  }
}

interface OptionalKimiExecutionLeaseJournal {
  declaresPairState: boolean;
  exists: boolean;
  metadata: Record<string, unknown> | undefined;
}

function assertKimiLegacyExecutionLeaseJournalsMigratable(
  target: OptionalKimiExecutionLeaseJournal,
  fence: OptionalKimiExecutionLeaseJournal
): void {
  if (!target.exists && !fence.exists) return;

  // The only legacy namespace state that can be distinguished from an
  // authentic pre-sidecar release is a completely unpaired resolved primary
  // with no sidecar contents. Paired records in the replaceable OAuth
  // namespace are never trusted as migration authority.
  if (
    target.exists &&
    target.metadata?.rotation_state === "resolved" &&
    !target.declaresPairState &&
    (!fence.exists || (fence.metadata === undefined && !fence.declaresPairState))
  ) {
    return;
  }

  throw new Error(
    "a durable unresolved Kimi Modal credential-rotation fence is present or its legacy journals are unsafe"
  );
}

function kimiExecutionLeaseDeclaresPairState(metadata: Record<string, unknown> | undefined): boolean {
  return (
    metadata !== undefined &&
    (Object.hasOwn(metadata, "journal_pair_id") || Object.hasOwn(metadata, "transition_sequence"))
  );
}

function kimiExecutionLeasePairState(metadata: Record<string, unknown> | undefined):
  | {
      credentialLeaseId: string;
      ownerId: string;
      journalPairId: string;
      transitionSequence: number;
      rotationState: KimiModalNodeExecutionLeaseState;
    }
  | undefined {
  if (
    metadata === undefined ||
    typeof metadata.credential_lease !== "string" ||
    typeof metadata.owner_id !== "string" ||
    typeof metadata.journal_pair_id !== "string" ||
    metadata.journal_pair_id === "" ||
    !Number.isSafeInteger(metadata.transition_sequence) ||
    (metadata.transition_sequence as number) < 1 ||
    (metadata.rotation_state !== "active" &&
      metadata.rotation_state !== "rotation-possible" &&
      metadata.rotation_state !== "resolved")
  ) {
    return undefined;
  }
  return {
    credentialLeaseId: metadata.credential_lease,
    ownerId: metadata.owner_id,
    journalPairId: metadata.journal_pair_id,
    transitionSequence: metadata.transition_sequence as number,
    rotationState: metadata.rotation_state
  };
}

async function readKimiLeaseFile(handle: FileHandle, label: string): Promise<string> {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > 1024 * 1024) {
    throw new Error(`${label} is unsafe`);
  }
  const contents = Buffer.alloc(metadata.size);
  const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
  if (bytesRead !== contents.length) throw new Error(`${label} could not be read completely`);
  return contents.toString("utf8");
}

async function readKimiExecutionLeaseJournal(handle: FileHandle): Promise<{
  declaresPairState: boolean;
  metadata: Record<string, unknown> | undefined;
}> {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1024 * 1024) {
    throw new Error("Kimi Modal execution lease file is unsafe");
  }
  if (metadata.size === 0) return { declaresPairState: false, metadata: undefined };
  const serialized = Buffer.alloc(metadata.size);
  const { bytesRead } = await handle.read(serialized, 0, serialized.length, 0);
  if (bytesRead !== serialized.length) {
    throw new Error("Kimi Modal execution lease metadata could not be read completely");
  }
  const journal = serialized.toString("utf8");
  if (!journal.endsWith("\n")) {
    throw new Error("Kimi Modal execution lease journal has a torn record");
  }
  const records = journal.slice(0, -1).split("\n");
  let last: Record<string, unknown> | undefined;
  let activeOwner: string | undefined;
  let activeCredentialLease: string | undefined;
  let activeState: KimiModalNodeExecutionLeaseState | undefined;
  let declaresPairState = false;
  for (const record of records) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record) as unknown;
    } catch (error) {
      throw new Error("Kimi Modal execution lease journal has a malformed record", { cause: error });
    }
    if (
      !isRecord(parsed) ||
      parsed.schema_version !== "ultrafuzz.kimi-modal-execution-lease.v1" ||
      typeof parsed.credential_lease !== "string" ||
      typeof parsed.owner_id !== "string" ||
      (parsed.rotation_state !== "active" &&
        parsed.rotation_state !== "rotation-possible" &&
        parsed.rotation_state !== "resolved")
    ) {
      throw new Error("Kimi Modal execution lease journal has an invalid record");
    }
    declaresPairState ||= kimiExecutionLeaseDeclaresPairState(parsed);
    const state = parsed.rotation_state as KimiModalNodeExecutionLeaseState;
    const owner = parsed.owner_id;
    const credentialLease = parsed.credential_lease;
    if (state === "active") {
      if (activeState !== undefined && activeState !== "resolved") {
        throw new Error("Kimi Modal execution lease journal has an invalid state transition");
      }
      activeOwner = owner;
      activeCredentialLease = credentialLease;
      activeState = state;
    } else {
      if (
        activeState === undefined ||
        activeState === "resolved" ||
        owner !== activeOwner ||
        credentialLease !== activeCredentialLease ||
        (state === "rotation-possible" && activeState !== "active")
      ) {
        throw new Error("Kimi Modal execution lease journal has an invalid state transition");
      }
      activeState = state;
    }
    last = parsed;
  }
  return { declaresPairState, metadata: last };
}

async function readKimiExecutionLeaseMetadata(handle: FileHandle): Promise<Record<string, unknown> | undefined> {
  return (await readKimiExecutionLeaseJournal(handle)).metadata;
}

async function writeKimiExecutionLeaseMetadata(
  handle: FileHandle,
  credentialLeaseId: string,
  ownerId: string,
  journalPairId: string,
  transitionSequence: number,
  rotationState: KimiModalNodeExecutionLeaseState
): Promise<void> {
  const serialized = Buffer.from(
    `${JSON.stringify({
      schema_version: "ultrafuzz.kimi-modal-execution-lease.v1",
      credential_lease: credentialLeaseId,
      owner_id: ownerId,
      journal_pair_id: journalPairId,
      transition_sequence: transitionSequence,
      rotation_state: rotationState
    })}\n`,
    "utf8"
  );
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size + serialized.length > 1024 * 1024) {
    throw new Error("Kimi Modal execution lease file is unsafe");
  }
  let offset = 0;
  while (offset < serialized.length) {
    const { bytesWritten } = await handle.write(serialized, offset, serialized.length - offset, metadata.size + offset);
    if (bytesWritten <= 0) {
      throw new Error("Kimi Modal execution lease metadata could not be written completely");
    }
    offset += bytesWritten;
  }
  await handle.chmod(0o600);
  await handle.sync();
}

async function assertKimiLeaseDirectory(directory: string, label: string): Promise<void> {
  const resolved = path.resolve(directory);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(resolved)) !== resolved) {
    throw new Error(`${label} is unsafe`);
  }
}

async function openValidatedKimiLeaseDirectory(directory: string, label: string): Promise<FileHandle> {
  const resolved = path.resolve(directory);
  await assertKimiLeaseDirectory(resolved, label);
  const before = await lstat(resolved, { bigint: true });
  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(resolved, { bigint: true });
    if (
      !opened.isDirectory() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      (await realpath(resolved)) !== resolved
    ) {
      throw new Error(`${label} is unsafe`);
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function openKimiLeaseDirectoryAt(parentAnchor: string, name: string, label: string): Promise<FileHandle> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) throw new Error(`${label} name is unsafe`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path.join(parentAnchor, name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error(`${label} is unsafe`);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof Error && error.message === `${label} is unsafe`) throw error;
    throw new Error(`${label} is unsafe`, { cause: error });
  }
}

async function openKimiLeaseFileAt(
  directoryAnchor: string,
  name: string,
  flags: number,
  label: string
): Promise<FileHandle> {
  if (!isSafeKimiLeaseEntryName(name)) throw new Error(`${label} name is unsafe`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path.join(directoryAnchor, name), flags | constants.O_NOFOLLOW, 0o600);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`${label} is unsafe`);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof Error && error.message === `${label} is unsafe`) throw error;
    throw new Error(`${label} is unsafe`, { cause: error });
  }
}

function isSafeKimiLeaseEntryName(name: string): boolean {
  return /^(?!\.{1,2}$)[A-Za-z0-9.][A-Za-z0-9._-]{0,254}$/u.test(name);
}

async function kimiLeaseDirectoryDescriptorPath(handle: FileHandle, label: string): Promise<string> {
  const held = await handle.stat({ bigint: true });
  if (!held.isDirectory()) throw new Error(`${label} is unsafe`);
  const candidates = process.platform === "win32" ? [] : [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`];
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate, { bigint: true });
      if (metadata.isDirectory() && metadata.dev === held.dev && metadata.ino === held.ino) return candidate;
    } catch {
      // Continue to the next descriptor filesystem, if one exists.
    }
  }
  throw new Error(`${label} cannot be held through a directory descriptor on this platform`);
}

async function closeKimiLeaseHandles(handles: Array<FileHandle | undefined>): Promise<void> {
  const settled = await Promise.allSettled(handles.flatMap((handle) => (handle === undefined ? [] : [handle.close()])));
  const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length > 0) {
    throw new AggregateError(failures, "unable to close Kimi Modal execution lease handles");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/**
 * Declassifies a child-written Kimi credential only through Kimi's trusted OAuth endpoint.
 *
 * Every child-controlled field except `refresh_token` is ignored. The returned document is
 * reconstructed from the trusted initial credential and a validated provider response; callers
 * may then commit it with their own lineage/CAS protocol. This function never writes either the
 * raw child candidate or the brokered result.
 */
export async function brokerKimiSubscriptionAuthRotation(
  input: KimiSubscriptionAuthBrokerInput,
  options: KimiSubscriptionAuthPreparationOptions = {}
): Promise<Record<string, unknown>> {
  const config = kimiConfig(await readFile(path.join(input.source, "config.toml"), "utf8"));
  const credential = kimiCredentialRef(input.source, config, input.model);
  const initial = kimiOAuthToken(input.initialCredential, "trusted initial Kimi subscription credential");
  const refreshToken = kimiCandidateRefreshToken(input.candidateCredential);
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const refreshed = await exchangeKimiOAuthRefresh(
    {
      deviceId: (await readFile(path.join(input.source, "device_id"), "utf8")).trim(),
      oauthHost: kimiOAuthHost(input.env ?? process.env, credential.oauthHost),
      refreshToken
    },
    options
  );
  return mergeKimiOAuthRefresh(initial, refreshed, now);
}

export function kimiSubscriptionCredentialLineageSha256(credential: string): string {
  const token = kimiOAuthToken(credential, "trusted initial Kimi subscription credential");
  return kimiRefreshTokenSha256(token.refresh_token);
}

export async function kimiSubscriptionCredentialFileName(
  model: string,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir()
): Promise<string> {
  const source = localSubscriptionAuthPath("kimi", env, home);
  const config = kimiConfig(await readFile(path.join(source, "config.toml"), "utf8"));
  return path.basename(kimiCredentialPath(source, config, model));
}

export async function kimiSubscriptionAuthSecretValues(
  model: string,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir()
): Promise<string[]> {
  const source = localSubscriptionAuthPath("kimi", env, home);
  return kimiSubscriptionAuthSecretValuesFromRoots(model, source, source);
}

export async function kimiSubscriptionAuthSecretValuesFromRoots(
  model: string,
  configRoot: string,
  credentialRoot = configRoot
): Promise<string[]> {
  const config = kimiConfig(await readFile(path.join(configRoot, "config.toml"), "utf8"));
  const credentialFile = path.basename(kimiCredentialPath(configRoot, config, model));
  const credentialPath = path.join(credentialRoot, "credentials", credentialFile);
  const token = kimiOAuthToken(await readFile(credentialPath, "utf8"), credentialPath, {
    requireRefreshToken: false
  });
  return [...new Set([token.access_token, token.refresh_token].filter((value) => value.length > 0))];
}

export async function reconcileKimiSubscriptionAuthCredential(
  model: string,
  remoteCredential: string,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir(),
  options: { sourceRefreshTokenSha256?: string } = {}
): Promise<boolean> {
  const source = localSubscriptionAuthPath("kimi", env, home);
  const config = kimiConfig(await readFile(path.join(source, "config.toml"), "utf8"));
  const credential = kimiCredentialRef(source, config, model);
  const credentialPath = credential.path;
  const remoteToken = kimiOAuthToken(remoteCredential, `Modal volume ${path.basename(credentialPath)}`, {
    requireRefreshToken: false
  });
  if (remoteToken.refresh_token.trim() === "") return false;
  await access(credentialPath, constants.R_OK | constants.W_OK);
  await access(path.join(source, "device_id"), constants.R_OK);

  const release = await acquireKimiRefreshLock(source, credential.lockName);
  try {
    const localToken = kimiOAuthToken(await readFile(credentialPath, "utf8"), credentialPath);
    if (isKimiCredentialCommitEquivalent(localToken, remoteToken)) {
      const directory = await open(path.dirname(credentialPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return true;
    }
    if (!shouldReplaceKimiCredential(localToken, remoteToken, options)) return false;
    await writeJsonAtomic(credentialPath, remoteToken);
    return true;
  } finally {
    await release();
  }
}

export function localSubscriptionAuthPath(
  provider: ModelProvider,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir()
): string {
  if (provider === "openai") {
    return path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "auth.json");
  }
  if (provider === "anthropic") {
    return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), ".credentials.json");
  }
  if (provider === "deepseek") {
    throw new Error("DeepSeek does not support subscription authentication");
  }
  return env.KIMI_CODE_HOME ?? env.KIMI_SHARE_DIR ?? path.join(home, ".kimi-code");
}

export function runnerApiKeyEnv(
  provider: ModelProvider
): "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "DEEPSEEK_API_KEY" | "KIMI_API_KEY" {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  return "KIMI_API_KEY";
}

export function runnerApiKeySourceEnv(provider: ModelProvider): readonly string[] {
  if (provider === "kimi") return ["KIMI_API_KEY", "MOONSHOT_API_KEY"];
  return [runnerApiKeyEnv(provider)];
}

function kimiSubscriptionAuthEntries(source: string, credentialFile = "kimi-code.json"): SubscriptionAuthCopyEntry[] {
  return [
    { source: path.join(source, "config.toml"), destination: path.posix.join(remoteAuthDir("kimi"), "config.toml") },
    {
      source: path.join(source, "credentials", credentialFile),
      destination: path.posix.join(remoteAuthDir("kimi"), "credentials", credentialFile)
    },
    { source: path.join(source, "device_id"), destination: path.posix.join(remoteAuthDir("kimi"), "device_id") }
  ];
}

interface KimiConfig {
  models?: Record<string, Record<string, unknown>>;
  providers?: Record<string, Record<string, unknown>>;
  thinking?: unknown;
}

interface KimiOAuthToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
}

interface KimiOAuthRefresh {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

interface KimiOAuthExchangeInput {
  deviceId: string;
  oauthHost: string;
  refreshToken: string;
}

const KIMI_REFRESH_TOKEN_MAX_BYTES = 64 * 1024;
const KIMI_CREDENTIAL_CANDIDATE_MAX_BYTES = 1024 * 1024;

function kimiConfig(text: string): KimiConfig {
  const value = parse(text) as unknown;
  if (!isRecord(value)) throw new Error("Kimi Code config.toml must contain a TOML document");
  return value as KimiConfig;
}

function kimiCredentialPath(source: string, config: KimiConfig, model: string): string {
  return kimiCredentialRef(source, config, model).path;
}

function kimiCredentialRef(
  source: string,
  config: KimiConfig,
  model: string
): { path: string; lockName: string; oauthHost?: string } {
  const { providerName, provider } = kimiModelProvider(config, model);
  const oauth = provider.oauth;
  if (!isRecord(oauth) || oauth.storage !== "file" || typeof oauth.key !== "string") {
    throw new Error(`Kimi subscription provider ${providerName} must use file-backed OAuth credentials`);
  }
  const tokenName = path.posix.basename(oauth.key.trim());
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(tokenName)) {
    throw new Error(`Kimi subscription provider ${providerName} has an unsafe OAuth credential key`);
  }
  return {
    path: path.join(source, "credentials", `${tokenName}.json`),
    lockName: tokenName,
    oauthHost: kimiPersistedOAuthHost(providerName, oauth)
  };
}

function kimiSnapshotConfig(config: KimiConfig, model: string): string {
  const { modelConfig, providerName, provider } = kimiModelProvider(config, model);
  const snapshot: Record<string, unknown> = {
    default_model: model,
    providers: { [providerName]: provider },
    models: { [model]: kimiSnapshotModelConfig(model, modelConfig) }
  };
  if (isRecord(config.thinking)) snapshot.thinking = config.thinking;
  return stringify(snapshot as Parameters<typeof stringify>[0]);
}

function kimiSnapshotModelConfig(model: string, modelConfig: Record<string, unknown>): Record<string, unknown> {
  if (model !== "kimi-k3" || modelConfig.support_efforts !== undefined || modelConfig.model !== "k3") {
    return modelConfig;
  }
  return { ...modelConfig, support_efforts: ["low", "high", "max"] };
}

function kimiModelProvider(
  config: KimiConfig,
  model: string
): { modelConfig: Record<string, unknown>; providerName: string; provider: Record<string, unknown> } {
  const modelConfig = config.models?.[model] ?? (model === "kimi-k3" ? config.models?.["kimi-code/k3"] : undefined);
  if (!isRecord(modelConfig)) {
    throw new Error(`Kimi subscription model alias is missing from config.toml: ${model}`);
  }
  const providerName = modelConfig.provider;
  if (providerName === undefined) {
    throw new Error(`Kimi subscription model alias is missing from config.toml: ${model}`);
  }
  if (typeof providerName !== "string") {
    throw new Error(`Kimi subscription model ${model} has an invalid provider`);
  }
  const provider = config.providers?.[providerName];
  if (!isRecord(provider)) {
    throw new Error(`Kimi subscription provider is missing from config.toml: ${providerName}`);
  }
  return { modelConfig, providerName, provider };
}

function kimiWorkerOAuthSnapshot(token: KimiOAuthToken): Record<string, unknown> {
  return { ...token };
}

function kimiOAuthToken(
  text: string,
  credentialPath: string,
  options: { requireRefreshToken?: boolean } = {}
): KimiOAuthToken {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Kimi subscription credentials are invalid JSON: ${credentialPath}`);
  }
  const refreshToken = isRecord(value) && typeof value.refresh_token === "string" ? value.refresh_token : "";
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    typeof value.expires_at !== "number" ||
    ((options.requireRefreshToken ?? true) && typeof value.refresh_token !== "string")
  ) {
    throw new Error(`Kimi subscription credentials have an unsupported shape: ${credentialPath}`);
  }
  return { ...value, refresh_token: refreshToken } as KimiOAuthToken;
}

async function exchangeKimiOAuthRefresh(
  input: KimiOAuthExchangeInput,
  options: KimiSubscriptionAuthPreparationOptions
): Promise<KimiOAuthRefresh> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${input.oauthHost}/api/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Msh-Platform": "kimi_code_cli",
      "X-Msh-Version": "0.29.1",
      "X-Msh-Device-Id": input.deviceId,
      "X-Msh-Device-Name": os.hostname(),
      "X-Msh-Device-Model": os.arch(),
      "X-Msh-Os-Version": `${os.type()} ${os.release()}`
    },
    body: new URLSearchParams({
      client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
      grant_type: "refresh_token",
      refresh_token: input.refreshToken
    })
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`Kimi subscription token refresh failed with HTTP ${response.status}`);
  }
  return kimiOAuthRefresh(payload);
}

function mergeKimiOAuthRefresh(
  initial: KimiOAuthToken,
  refreshed: KimiOAuthRefresh,
  now: number
): Record<string, unknown> {
  return {
    ...initial,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    expires_at: now + refreshed.expires_in,
    expires_in: refreshed.expires_in,
    token_type: refreshed.token_type ?? initial.token_type ?? "Bearer",
    scope: refreshed.scope ?? initial.scope ?? ""
  };
}

function kimiCandidateRefreshToken(candidateCredential: string): string {
  const candidateBytes = Buffer.byteLength(candidateCredential, "utf8");
  if (candidateBytes <= 0 || candidateBytes > KIMI_CREDENTIAL_CANDIDATE_MAX_BYTES) {
    throw new Error("untrusted Kimi credential candidate has an unsafe size");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(candidateCredential) as unknown;
  } catch (error) {
    throw new Error("untrusted Kimi credential candidate is not valid JSON", { cause: error });
  }
  const refreshToken = isRecord(candidate) ? candidate.refresh_token : undefined;
  if (
    typeof refreshToken !== "string" ||
    refreshToken.trim() === "" ||
    refreshToken.includes("\0") ||
    Buffer.byteLength(refreshToken, "utf8") > KIMI_REFRESH_TOKEN_MAX_BYTES
  ) {
    throw new Error("untrusted Kimi credential candidate has an invalid refresh token");
  }
  return refreshToken;
}

function kimiOAuthRefresh(value: unknown): KimiOAuthRefresh {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    value.access_token === "" ||
    typeof value.refresh_token !== "string" ||
    value.refresh_token === "" ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    (value.token_type !== undefined && (typeof value.token_type !== "string" || value.token_type.trim() === "")) ||
    (value.scope !== undefined && (typeof value.scope !== "string" || value.scope.trim() === ""))
  ) {
    throw new Error("Kimi subscription token refresh returned an unsupported response");
  }
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_in: value.expires_in,
    ...(typeof value.token_type === "string" ? { token_type: value.token_type } : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {})
  };
}

function kimiPersistedOAuthHost(providerName: string, oauth: Record<string, unknown>): string | undefined {
  const value = oauth.oauth_host ?? oauth.oauthHost;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Kimi subscription provider ${providerName} has an invalid OAuth host`);
  }
  return value;
}

function kimiOAuthHost(env: Record<string, string | undefined>, persistedOAuthHost?: string): string {
  const value = env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST ?? persistedOAuthHost ?? "https://auth.kimi.com";
  const normalized = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new Error(`Kimi OAuth host is invalid: ${value}`, { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Kimi OAuth host must be an HTTPS URL without credentials, a query, or a fragment");
  }
  return normalized.replace(/\/+$/u, "");
}

function shouldReplaceKimiCredential(
  localToken: KimiOAuthToken,
  remoteToken: KimiOAuthToken,
  options: { sourceRefreshTokenSha256?: string } = {}
): boolean {
  const localHasRefresh = localToken.refresh_token.trim() !== "";
  const remoteHasRefresh = remoteToken.refresh_token.trim() !== "";
  if (remoteHasRefresh && !localHasRefresh) return true;
  if (!remoteHasRefresh) return false;
  if (remoteToken.refresh_token === localToken.refresh_token) {
    return remoteToken.expires_at > localToken.expires_at;
  }
  if (options.sourceRefreshTokenSha256 === undefined) return false;
  if (kimiRefreshTokenSha256(localToken.refresh_token) !== options.sourceRefreshTokenSha256) return false;
  return remoteToken.expires_at > localToken.expires_at;
}

function isKimiCredentialCommitEquivalent(localToken: KimiOAuthToken, intendedToken: KimiOAuthToken): boolean {
  return (
    localToken.refresh_token.trim() !== "" &&
    localToken.refresh_token === intendedToken.refresh_token &&
    localToken.expires_at === intendedToken.expires_at
  );
}

function kimiRefreshTokenSha256(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

async function acquireKimiRefreshLock(source: string, lockName = "kimi-code"): Promise<() => Promise<void>> {
  const oauthDir = path.join(source, "oauth");
  const target = path.join(oauthDir, lockName);
  await mkdir(oauthDir, { recursive: true, mode: 0o700 });
  const targetHandle = await open(target, "a", 0o600);
  await targetHandle.close();
  try {
    return await lockfile.lock(target, {
      retries: {
        retries: 120,
        factor: 1,
        minTimeout: 500,
        maxTimeout: 1_000
      },
      stale: 5_000,
      realpath: false
    });
  } catch (error) {
    throw new Error(
      `unable to acquire Kimi OAuth refresh lock: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

async function writeJsonAtomic(filePath: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
