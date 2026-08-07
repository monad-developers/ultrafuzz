import { redactSecretsInText, SENSITIVE_REDACTION_PLACEHOLDER } from "@ultrafuzz/security";

/**
 * Bytes of child stderr retained while the rest is discarded, so a non-zero exit can name its own reason
 * without persisting provider responses or benchmark contents.
 */
export const WORKER_STDERR_TAIL_BYTES = 8_192;

const MAX_DIAGNOSTIC_MESSAGE_BYTES = 1_000;
const MAX_TERMINATION_DETAIL_BYTES = 2_000;
const MAX_CAUSE_CHAIN_DEPTH = 8;

export interface BoundedStderrTail {
  append: (chunk: Buffer) => void;
  sanitized: (forbiddenSecretValues?: readonly string[]) => string;
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
  const maxBytes = options.maxBytes ?? MAX_DIAGNOSTIC_MESSAGE_BYTES;
  if (bytes.length <= maxBytes) return sanitized;
  return (options.keep === "head" ? bytes.subarray(0, maxBytes) : bytes.subarray(bytes.length - maxBytes)).toString(
    "utf8"
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
    sanitized(forbiddenSecretValues) {
      const buffer = Buffer.concat(chunks);
      return sanitizeWorkerDiagnosticMessage(
        buffer.subarray(Math.max(0, buffer.byteLength - maxBytes)).toString("utf8"),
        { forbiddenSecretValues: forbiddenSecretValues ?? [] }
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

/** The `cause` for a child that exited non-zero: what ran, how it exited, and its redacted stderr tail. */
export function childExitFailureCause(
  label: string,
  exitCode: number,
  stderrTail: BoundedStderrTail,
  forbiddenSecretValues?: readonly string[]
): Error {
  const detail = stderrTail.sanitized(forbiddenSecretValues);
  return new Error(`${label} exited ${exitCode}${detail === "" ? "" : `: ${detail}`}`);
}

/**
 * Render a rejection value and its `cause` chain as bounded, redacted text.
 *
 * Deliberately never inspects the error object itself: an `execFileSync` `ENOBUFS` `SystemError` carries
 * `output`, `stdout` and `stderr` properties holding up to the whole captured stream, which `util.inspect`
 * would dump verbatim. Only `name`, `code` and `message` are read at each link.
 */
export function describeWorkerTermination(error: unknown): string {
  const seen = new Set<unknown>();
  const links: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && links.length < MAX_CAUSE_CHAIN_DEPTH && !seen.has(current)) {
    seen.add(current);
    links.push(describeErrorLink(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  const described = sanitizeWorkerDiagnosticMessage(links.join(" <- "), {
    maxBytes: MAX_TERMINATION_DETAIL_BYTES,
    keep: "head"
  });
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
