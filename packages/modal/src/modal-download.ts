import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import { ModalClient } from "modal";
import { isRecord } from "@ultrafuzz/artifacts";

const MODAL_TOKEN_ID_ENV = "MODAL_TOKEN_ID";
const MODAL_TOKEN_SECRET_ENV = "MODAL_TOKEN_SECRET";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;

// Keep the helper isolated from controller and agent credentials. These are
// the only parent settings needed to find Node, create temporary files, and
// honor an explicitly configured TLS/proxy boundary.
const HELPER_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy"
] as const;

export interface ModalDownloadCredentials {
  tokenId: string;
  tokenSecret: string;
}

export interface ModalDownloadRequest extends ModalDownloadCredentials {
  sandboxId: string;
  remotePath: string;
  localPath: string;
}

interface ModalDownloadSandbox {
  readonly sandboxId: string;
  readonly filesystem: {
    copyToLocal(remotePath: string, localPath: string): Promise<void>;
  };
}

export interface ModalDownloadHelperOptions {
  nodeExecutable?: string;
  helperEntrypoint?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Modal's binary command streams currently stop making progress under Bun once
 * a download grows beyond the pipe buffer. Keep the SDK operation in Node when
 * the controller itself is running under Bun.
 */
export async function copyModalSandboxFileToLocal(
  sandbox: ModalDownloadSandbox,
  remotePath: string,
  localPath: string,
  credentials: ModalDownloadCredentials,
  helperOptions: ModalDownloadHelperOptions = {}
): Promise<void> {
  if (process.versions.bun === undefined) {
    await sandbox.filesystem.copyToLocal(remotePath, localPath);
    return;
  }
  await invokeModalDownloadHelper(
    {
      ...credentials,
      sandboxId: sandbox.sandboxId,
      remotePath,
      localPath
    },
    helperOptions
  );
}

export async function invokeModalDownloadHelper(
  request: ModalDownloadRequest,
  options: ModalDownloadHelperOptions = {}
): Promise<void> {
  const helperEntrypoint = options.helperEntrypoint ?? fileURLToPath(import.meta.url);
  const payload = encodeRequest(request);
  const env = helperEnvironment(options.env ?? process.env, request);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      options.nodeExecutable ?? "node",
      [helperEntrypoint],
      { env, maxBuffer: MAX_CHILD_OUTPUT_BYTES, windowsHide: true },
      (error) => {
        if (error === null) resolve();
        else reject(new Error("Modal result download helper failed", { cause: error }));
      }
    );
    // A helper that rejects input may close stdin before the write completes;
    // execFile's callback remains the single completion/error authority.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(payload);
  });
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new Error("Modal result download helper received invalid input");
  }
  const { sandboxId, remotePath, localPath } = await readRequest();
  const tokenId = process.env[MODAL_TOKEN_ID_ENV];
  const tokenSecret = process.env[MODAL_TOKEN_SECRET_ENV];
  if (!validString(tokenId) || !validString(tokenSecret)) {
    throw new Error("Modal result download helper received invalid input");
  }

  const client = new ModalClient({ tokenId, tokenSecret });
  let sandbox: Awaited<ReturnType<ModalClient["sandboxes"]["fromId"]>> | undefined;
  try {
    sandbox = await client.sandboxes.fromId(sandboxId);
    await sandbox.filesystem.copyToLocal(remotePath, localPath);
  } finally {
    sandbox?.detach();
    client.close();
  }
}

function helperEnvironment(source: NodeJS.ProcessEnv, credentials: ModalDownloadCredentials): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of HELPER_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env[MODAL_TOKEN_ID_ENV] = checkedCredential(credentials.tokenId);
  env[MODAL_TOKEN_SECRET_ENV] = checkedCredential(credentials.tokenSecret);
  return env;
}

function encodeRequest(request: ModalDownloadRequest): Buffer {
  const body = {
    sandboxId: checkedField(request.sandboxId),
    remotePath: checkedField(request.remotePath),
    localPath: checkedField(request.localPath)
  };
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  if (payload.byteLength > MAX_REQUEST_BYTES) {
    throw new Error("Modal result download helper request is too large");
  }
  return payload;
}

async function readRequest(): Promise<{ sandboxId: string; remotePath: string; localPath: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Modal result download helper received invalid input");
    }
    chunks.push(bytes);
  }
  if (size === 0) throw new Error("Modal result download helper received invalid input");

  let value: unknown;
  try {
    value = parseStrictJsonBytes(Buffer.concat(chunks, size), {
      maxBytes: MAX_REQUEST_BYTES,
      maxDepth: 1,
      maxItems: 0,
      maxProperties: 3
    });
  } catch {
    throw new Error("Modal result download helper received invalid input");
  }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "localPath,remotePath,sandboxId") {
    throw new Error("Modal result download helper received invalid input");
  }
  return {
    sandboxId: checkedField(value.sandboxId),
    remotePath: checkedField(value.remotePath),
    localPath: checkedField(value.localPath)
  };
}

function checkedCredential(value: string): string {
  if (!validString(value)) throw new Error("Modal result download helper credentials are invalid");
  return value;
}

function checkedField(value: unknown): string {
  if (!validString(value)) throw new Error("Modal result download helper request is invalid");
  return value;
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
