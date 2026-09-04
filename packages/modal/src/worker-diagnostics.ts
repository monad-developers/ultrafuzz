import { redactSecretsInText, SENSITIVE_REDACTION_PLACEHOLDER } from "@ultrafuzz/security";

/**
 * Bytes of child stderr retained while the rest is discarded, so a non-zero exit can name its own reason
 * without persisting provider responses or benchmark contents.
 */
export const WORKER_STDERR_TAIL_BYTES = 8_192;

/**
 * Byte bound on one diagnostic message. It is the collector's bound, not this module's:
 * `assertSanitizedModalCollectedFiles` refuses a worker log carrying a longer `message` and discards
 * status.json, result.json and the recovery lifecycle along with it.
 */
export const MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES = 1_000;
const MAX_TERMINATION_DETAIL_BYTES = 2_000;
const MAX_CAUSE_CHAIN_DEPTH = 8;
const MAX_WORKER_DIAGNOSTIC_LOG_ENTRIES = 3;
const MAX_WORKER_DIAGNOSTIC_LOG_PAYLOAD_CHARACTERS = 8_192;
const WORKER_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

/** Codes both workers emit for their own children. Every reader greps these, so they are shared, not local. */
export const WORKER_COMMAND_FAILED_DIAGNOSTIC_CODE = "WORKER_COMMAND_FAILED";
export const WORKER_COMMAND_INTERRUPTED_DIAGNOSTIC_CODE = "WORKER_COMMAND_INTERRUPTED";
/** Code both workers emit for a failure nothing else named; without it the contract alone calls it a sandbox death. */
export const WORKER_UNHANDLED_FAILURE_DIAGNOSTIC_CODE = "WORKER_UNHANDLED_FAILURE";
/** Message a failure diagnostic carries when its detail could not pass the collector's secret gate. */
export const WORKER_FAILURE_DETAIL_WITHHELD_MESSAGE = "failure detail withheld by the secret gate";

export interface WorkerDiagnostic {
  code: string;
  message: string;
}

export interface BoundedStderrTail {
  append: (chunk: Buffer) => void;
  sanitized: (forbiddenSecretValues?: readonly string[], maxBytes?: number) => string;
}

/**
 * Redact a diagnostic string so it can be printed or persisted: caller-supplied secret values first, then the
 * package-wide secret patterns, then control characters, then a byte bound.
 */
export function sanitizeWorkerDiagnosticMessage(
  message: string,
  options: {
    forbiddenSecretValues?: readonly string[];
    maxBytes?: number;
    keep?: "head" | "tail";
  } = {}
): string {
  let sanitized = message;
  for (const secret of [...new Set((options.forbiddenSecretValues ?? []).filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length
  )) {
    sanitized = sanitized.split(secret).join(SENSITIVE_REDACTION_PLACEHOLDER);
  }
  sanitized = [...redactSecretsInText(sanitized)]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const bytes = Buffer.from(sanitized, "utf8");
  const maxBytes = options.maxBytes ?? MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES;
  if (bytes.length <= maxBytes) return sanitized;
  return boundedDecodedBytes(bytes, maxBytes, options.keep === "head" ? "head" : "tail");
}

/**
 * Decode at most `maxBytes` of UTF-8, cutting from the end being dropped.
 *
 * Decoding a byte slice that begins or ends inside a multi-byte sequence substitutes U+FFFD -- three bytes --
 * for each orphaned byte, so slicing to `maxBytes` and decoding yields up to `maxBytes + 2` bytes keeping the
 * head and `maxBytes + 6` keeping the tail. The bound has to hold on the decoded string, because that string
 * is what the collector measures. Dropping whole code points keeps the result a pure function of the input,
 * which the durable ledgers that compare whole objects for duplicate conflicts require.
 */
function boundedDecodedBytes(bytes: Buffer, maxBytes: number, keep: "head" | "tail"): string {
  const decoded = (keep === "head" ? bytes.subarray(0, maxBytes) : bytes.subarray(bytes.length - maxBytes)).toString(
    "utf8"
  );
  return keep === "head" ? boundedPrefix(decoded, maxBytes) : boundedSuffix(decoded, maxBytes);
}

/** The longest prefix of `text` ending on a code point boundary whose UTF-8 encoding fits `maxBytes`. */
function boundedPrefix(text: string, maxBytes: number): string {
  let retainedBytes = 0;
  let end = 0;
  while (end < text.length) {
    const next = end + codePointUnits(text, end);
    const codePointBytes = Buffer.byteLength(text.slice(end, next), "utf8");
    if (retainedBytes + codePointBytes > maxBytes) break;
    retainedBytes += codePointBytes;
    end = next;
  }
  return text.slice(0, end);
}

/** The longest suffix of `text` starting on a code point boundary whose UTF-8 encoding fits `maxBytes`. */
function boundedSuffix(text: string, maxBytes: number): string {
  let retainedBytes = Buffer.byteLength(text, "utf8");
  let start = 0;
  while (retainedBytes > maxBytes && start < text.length) {
    const next = start + codePointUnits(text, start);
    retainedBytes -= Buffer.byteLength(text.slice(start, next), "utf8");
    start = next;
  }
  return text.slice(start);
}

/**
 * UTF-16 code units the code point at `index` occupies.
 *
 * A cut has to land on a code point boundary: splitting a surrogate pair would leave a lone surrogate, which
 * `Buffer.byteLength` charges three bytes for, so the byte accounting above would undercount its own output.
 */
function codePointUnits(text: string, index: number): number {
  const lead = text.charCodeAt(index);
  const trail = text.charCodeAt(index + 1);
  return lead >= 0xd800 && lead <= 0xdbff && trail >= 0xdc00 && trail <= 0xdfff ? 2 : 1;
}

/**
 * The `eval-failure-diagnostics` payload for one worker log line, or `undefined` when nothing survives.
 *
 * Every bound applied here belongs to the collector: `isGenericWorkerLifecycleLine` accepts at most three
 * `{code, message}` entries, a `^[A-Z][A-Z0-9_]{0,127}$` code, a message of at most
 * `MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES` that redaction leaves unchanged and holds no forbidden value, and a
 * payload of at most 8,192 characters -- and `assertSanitizedModalCollectedFiles` discards the entire
 * collected file set for one line outside that grammar. An entry that cannot be expressed inside it is
 * dropped here, so a diagnostic that will not fit costs its own reason rather than all of the evidence.
 */
export function workerDiagnosticLogPayload(
  diagnostics: readonly WorkerDiagnostic[],
  forbiddenSecretValues: readonly string[] = []
): string | undefined {
  const entries = diagnostics
    .filter((diagnostic) => WORKER_DIAGNOSTIC_CODE.test(diagnostic.code))
    .map((diagnostic) => ({
      code: diagnostic.code,
      message: sanitizeWorkerDiagnosticMessage(diagnostic.message, { forbiddenSecretValues })
    }))
    .filter((entry) => collectableDiagnosticMessage(entry.message, forbiddenSecretValues))
    .slice(0, MAX_WORKER_DIAGNOSTIC_LOG_ENTRIES);
  for (let count = entries.length; count > 0; count -= 1) {
    const payload = Buffer.from(JSON.stringify(entries.slice(0, count)), "utf8").toString("base64url");
    if (payload.length <= MAX_WORKER_DIAGNOSTIC_LOG_PAYLOAD_CHARACTERS) return payload;
  }
  return undefined;
}

/**
 * The diagnostic naming `error` under `code`: its described cause chain when the collector will carry that
 * text, otherwise a fixed notice that the detail was withheld.
 *
 * `workerDiagnosticLogPayload` drops an entry the collected grammar cannot carry, which is right for a child's
 * stderr tail -- the exit code still names the failure -- and wrong here, where the entry is the only trace
 * the failure leaves: an empty line is the silent `sandbox-exited` misattribution again (#320). Withholding
 * the detail keeps the code in the log and still fails closed on the text.
 */
export function workerFailureDiagnostic(
  code: string,
  error: unknown,
  forbiddenSecretValues: readonly string[] = []
): WorkerDiagnostic {
  const message = describeWorkerTermination(error, MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES);
  return workerDiagnosticLogPayload([{ code, message }], forbiddenSecretValues) === undefined
    ? { code, message: WORKER_FAILURE_DETAIL_WITHHELD_MESSAGE }
    : { code, message };
}

/**
 * Whether the collector will accept this message.
 *
 * Sanitizing bounds and redacts, but neither property survives composition for free: a bound applied to
 * redacted text can cut away the context that made a token unremarkable, and the collector re-runs redaction
 * and demands a fixed point.
 */
function collectableDiagnosticMessage(message: string, forbiddenSecretValues: readonly string[]): boolean {
  return (
    Buffer.byteLength(message, "utf8") <= MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES &&
    redactSecretsInText(message) === message &&
    !forbiddenSecretValues.some((secret) => secret.length > 0 && message.includes(secret))
  );
}

/** Retain only the last `maxBytes` of everything appended, dropping the head as it streams. */
export function createBoundedStderrTail(maxBytes: number = WORKER_STDERR_TAIL_BYTES): BoundedStderrTail {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  return {
    append(chunk) {
      const retained = chunk.byteLength > maxBytes ? chunk.subarray(chunk.byteLength - maxBytes) : chunk;
      if (retained.byteLength === 0) return;
      chunks.push(retained);
      retainedBytes += retained.byteLength;
      while (chunks.length > 1 && retainedBytes - chunks[0]!.byteLength >= maxBytes) {
        retainedBytes -= chunks.shift()!.byteLength;
      }
    },
    sanitized(forbiddenSecretValues, sanitizedMaxBytes) {
      const buffer = Buffer.concat(chunks);
      return sanitizeWorkerDiagnosticMessage(
        buffer.subarray(Math.max(0, buffer.byteLength - maxBytes)).toString("utf8"),
        {
          forbiddenSecretValues: forbiddenSecretValues ?? [],
          ...(sanitizedMaxBytes === undefined ? {} : { maxBytes: sanitizedMaxBytes })
        }
      );
    }
  };
}

/**
 * Drain a child's stdout and stderr so it never blocks on a full pipe, retaining a bounded stderr tail for
 * diagnostics.
 */
export function drainChildOutput(
  child: { stdout: AsyncIterable<unknown> | null; stderr: AsyncIterable<unknown> | null },
  maxBytes: number = WORKER_STDERR_TAIL_BYTES
): { drained: Promise<void>; stderrTail: BoundedStderrTail } {
  const stderrTail = createBoundedStderrTail(maxBytes);
  const drain = async (stream: AsyncIterable<unknown> | null, tail?: BoundedStderrTail): Promise<void> => {
    if (stream === null) return;
    for await (const chunk of stream) {
      // Drain child output without persisting provider responses or benchmark contents; only the bounded,
      // redacted stderr tail survives.
      if (tail !== undefined) tail.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
    }
  };
  return {
    drained: Promise.all([drain(child.stdout), drain(child.stderr, stderrTail)]).then(() => undefined),
    stderrTail
  };
}

/**
 * The `cause` for a child that exited non-zero: what ran, how it exited, and its redacted stderr tail.
 *
 * The stderr tail's budget is reduced by the prefix so the whole message fits one collected diagnostic.
 * Bounding the composed string instead would cut from the tail-kept end and drop the label, the only part
 * that says which of a worker's sixteen commands this was.
 */
export function childExitFailureCause(
  label: string,
  exitCode: number,
  stderrTail: BoundedStderrTail,
  forbiddenSecretValues?: readonly string[]
): Error {
  const prefix = `${label} exited ${String(exitCode)}`;
  const detail = stderrTail.sanitized(
    forbiddenSecretValues,
    Math.max(0, MAX_WORKER_DIAGNOSTIC_MESSAGE_BYTES - Buffer.byteLength(`${prefix}: `, "utf8"))
  );
  return new Error(detail === "" ? prefix : `${prefix}: ${detail}`);
}

/**
 * Render a rejection value and its `cause` chain as bounded, redacted text.
 *
 * Deliberately never inspects the error object itself: an `execFileSync` `ENOBUFS` `SystemError` carries
 * `output`, `stdout` and `stderr` properties holding up to the whole captured stream, which `util.inspect`
 * would dump verbatim. Only `name`, `code` and `message` are read at each link.
 */
export function describeWorkerTermination(error: unknown, maxBytes: number = MAX_TERMINATION_DETAIL_BYTES): string {
  const seen = new Set<unknown>();
  const links: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && links.length < MAX_CAUSE_CHAIN_DEPTH && !seen.has(current)) {
    seen.add(current);
    links.push(describeErrorLink(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  const described = sanitizeWorkerDiagnosticMessage(links.join(" <- "), { maxBytes, keep: "head" });
  // A rejection with `undefined`, `null` or an empty string still has to name itself, otherwise the terminal
  // log is the bare prefix again, which is the failure mode this whole module exists to remove.
  return described === "" ? String(error) : described;
}

/**
 * The call frames of the rejection's own stack, bounded and redacted, or `undefined` when it has none.
 *
 * `Error.prototype.stack` is a plain string of `name: message` plus frames; it never carries an error's own
 * enumerable properties, so an `execFileSync` `ENOBUFS` `SystemError`'s `output`/`stdout`/`stderr` payload
 * cannot reach it. Without the frames an unanticipated failure -- a `TypeError` in the worker's own code,
 * exactly the class that leaves no other trace -- names no file and no line.
 */
export function workerTerminationStack(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  const frames = error.stack.split("\n").filter((line) => /^\s+at\s/u.test(line));
  if (frames.length === 0) return undefined;
  const sanitized = sanitizeWorkerDiagnosticMessage(frames.join("\n"), {
    maxBytes: MAX_TERMINATION_DETAIL_BYTES,
    keep: "head"
  });
  return sanitized === "" ? undefined : sanitized;
}

function describeErrorLink(value: unknown): string {
  if (value instanceof Error) {
    const code = "code" in value && typeof value.code === "string" ? ` (${value.code})` : "";
    return `${value.name}${code}: ${value.message}`;
  }
  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
}
