import { SandboxFilesystem } from "modal";

const PAYLOAD_BYTES = 4 * 1024 * 1024 + 257 * 1024;
const requestBytes = [];
let requestSize = 0;
for await (const chunk of process.stdin) {
  requestSize += chunk.byteLength;
  if (requestSize > 64 * 1024) throw new Error("oversized helper request");
  requestBytes.push(chunk);
}
const request = JSON.parse(Buffer.concat(requestBytes, requestSize).toString("utf8"));
const { sandboxId, remotePath, localPath } = request;
const stderrFailure = remotePath === "/data/stderr-failure";
if (
  process.versions.bun !== undefined ||
  process.argv.length !== 2 ||
  Object.keys(request).sort().join(",") !== "localPath,remotePath,sandboxId" ||
  sandboxId !== "sandbox-fixture" ||
  (remotePath !== "/data/result.tgz" && !stderrFailure) ||
  localPath === undefined ||
  process.env.MODAL_TOKEN_ID !== "fixture-token-id" ||
  process.env.MODAL_TOKEN_SECRET !== "fixture-token-secret" ||
  process.env.HTTPS_PROXY !== "http://fixture.invalid:8443" ||
  process.env.OPENROUTER_API_KEY !== undefined ||
  process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined ||
  process.env.UNRELATED_CONTROLLER_SECRET !== undefined ||
  process.env.NODE_OPTIONS !== undefined
) {
  throw new Error("unexpected Modal download helper invocation");
}

if (stderrFailure) {
  await new Promise((resolve) => process.stderr.write(Buffer.alloc(128 * 1024, 0x45), resolve));
  throw new Error("synthetic helper failure");
}

const payload = Buffer.alloc(PAYLOAD_BYTES, 0x5a);
let offset = 0;
let markStdoutDrained;
const stdoutDrained = new Promise((resolve) => {
  markStdoutDrained = resolve;
});
const stdout = new ReadableStream({
  pull(controller) {
    if (offset === payload.byteLength) {
      controller.close();
      markStdoutDrained();
      return;
    }
    const end = Math.min(offset + 16 * 1024, payload.byteLength);
    controller.enqueue(payload.subarray(offset, end));
    offset = end;
  }
});
const processHandle = {
  stdout,
  stderr: { readBytes: async () => new Uint8Array() },
  wait: async () => {
    await stdoutDrained;
    return 0;
  }
};
const filesystem = new SandboxFilesystem(async () => processHandle);
await filesystem.copyToLocal(remotePath, localPath);
