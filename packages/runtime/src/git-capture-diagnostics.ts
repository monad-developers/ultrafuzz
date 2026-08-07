/**
 * Turning an oversized-git-capture failure into something an operator can act on.
 *
 * Kept out of `workspace-handoff.ts` for one reason: that module is re-exported wholesale by the
 * package index (`export * from "./workspace-handoff.js"`), so anything exported from it becomes public
 * API. The diagnostic helper below has to be exported for its tests, and an `@internal` tag is only a
 * comment — it does not stop `export *`. Living here, it is importable by the tests and by
 * `workspace-handoff.ts` without widening what the package promises.
 */

/** Refuse to hand off a patch above this; the ceiling the DOWNSTREAM node has to accept. */
export const MAX_PATCH_BYTES = 16 * 1024 * 1024;

/**
 * Ceiling on any single git capture. Named because the reported number and the enforced number must be
 * the same thing: an operator who is told the buffer is N bytes will size the workspace against N.
 */
export const MAX_GIT_CAPTURE_BYTES = MAX_PATCH_BYTES * 2;

/**
 * `diff --git a/<path> b/<path>`, on its own line, which is how every hunk in the capture begins.
 *
 * The optional quotes matter: git renders a path with non-ASCII bytes as `"a/caf\303\251.txt"
 * "b/caf\303\251.txt"`, changing the separator from ` b/` to `" "b/`. Without them such a file is
 * silently missing from the attribution. Anchoring to line start is what makes this safe against a file
 * whose own CONTENT contains a header line — in a unified diff those arrive prefixed with `+`.
 */
const DIFF_HEADER = /^diff --git "?a\/(.+?)"? "?b\//gmu;

/**
 * Own keys Node hangs off a `spawnSync` error that must not reach a durable failure record: the captured
 * payload in `stdout`, the duplicate of it in `output`, and `error`, which is a self-reference (`e.error
 * === e`) carrying no information but making the object impossible to `JSON.stringify` at all.
 */
const DISCARDED_SPAWN_FIELDS = ["stdout", "stderr", "output", "error"] as const;

/** How much of git's own stderr to keep on the cause; enough to read, far too little to bloat a write. */
const RETAINED_STDERR_BYTES = 2048;

/** How much of it to inline in the message, which lands in logs that are read by eye. */
const INLINED_STDERR_BYTES = 400;

/** A string whose UTF-8 encoding is at most `limit` bytes, taken from the head of `buffer`. */
function truncateUtf8(buffer: Buffer, limit: number): string {
  // Decoding is LOSSY, and a lossy decode can GROW: every byte that is not valid UTF-8 becomes U+FFFD,
  // which re-encodes to THREE bytes. So bounding the input buffer bounds nothing -- 2048 bytes of 0xFF
  // come back as a string worth 6144. Shrink until the ENCODED text fits, which is the bound the
  // constant names. `runGitBuffer` omits `encoding` precisely because git's output need not be valid
  // UTF-8, so this is the ordinary case for it, not a contrived one.
  let take = Math.min(limit, buffer.length);
  let text = buffer.subarray(0, take).toString("utf8");
  for (let encoded = Buffer.byteLength(text, "utf8"); take > 0 && encoded > limit; ) {
    // Scale by the observed ratio, but always cut by at least one byte so this terminates. The ratio is
    // at most 3, so the first step lands at or below a third of the limit and one more settles it.
    take = Math.max(0, Math.min(take - 1, Math.floor((take * limit) / encoded)));
    text = buffer.subarray(0, take).toString("utf8");
    encoded = Buffer.byteLength(text, "utf8");
  }
  // A cut mid-sequence leaves a trailing replacement character standing for bytes that were never read.
  return take < buffer.length && text.endsWith("\uFFFD") ? text.slice(0, -1) : text;
}

/**
 * Bytes a spawn capture actually occupied, read from the capture as Node handed it over.
 *
 * The distinction is the whole point: `maxBuffer` counts bytes, so every comparison against it has to
 * count bytes too. Measuring a decoded string instead inflates an undecodable capture threefold and can
 * invert the comparison outright.
 */
function captureBytes(value: unknown): number {
  return Buffer.isBuffer(value) ? value.length : typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

/**
 * Rethrows an oversized-output failure as something an operator can act on.
 *
 * `execFileSync` raises a bare Node `SystemError` when git writes more than `maxBuffer`: message
 * `spawnSync git ENOBUFS`, with no subcommand, no size, and no indication that the workspace is at fault.
 * Six sandboxes died at one node across three Aave v4 runs; R47 is the one whose stack was captured, and
 * it names this error. The other five recorded no cause at all, so attributing them here is inference.
 * Several causal theories were pursued and refuted before that stack was read out of a 68 MB log by hand.
 *
 * The attribution is read out of the truncated capture the error already carries, NOT by measuring the
 * workspace. Measuring the workspace prices the wrong thing — file size on disk is not diff size, and a
 * staged listing is mostly tracked files that were never modified and contribute nothing — which the
 * `bulk that contributed nothing` test pins as an executable assertion rather than a claim here.
 *
 * Know the boundary. `error.stdout` holds roughly the first `MAX_GIT_CAPTURE_BYTES` git wrote, and git
 * emits in path order, so this ranks a PREFIX. A big root sorting after the cutoff is invisible: with
 * 34 MB in `contracts/` and 100 MB in `zzz-corpus/`, only `contracts` is named. Two consequences worth
 * knowing before trusting the numbers — the message states the first, and both make every figure a floor:
 *
 *   1. Roots past the cutoff are missing entirely, so this is a lead, not a survey of the workspace.
 *   2. The LAST root in the prefix is truncated mid-hunk, so its total is understated by however much of
 *      it fell past the cutoff. Two close entries can invert on where the cutoff happened to land. How
 *      often that last root is also the one ranked first is not something this code or its tests measure,
 *      so no claim is made about it.
 *
 * Completing it would need a second, bounded pass (`diff --raw` plus `cat-file --batch-check`); worth
 * doing if this message ever proves insufficient.
 *
 * Scope: this improves the string. It does not prevent the failure — the run is over when it fires.
 *
 * @internal Exported only so its tests can hand it a captured payload directly. Reaching this through
 * real git costs a >32 MB write per case, which priced the cheap cases out of existence — and one of the
 * cases nobody could afford is what caught the message claiming an ordering the code does not produce.
 */
export function rethrowOversizedGitOutput(args: readonly string[], error: unknown): never {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== "ENOBUFS") throw error;
  const subcommand = args.find((argument) => !argument.startsWith("-")) ?? "git";
  const capturedStdout = (error as { stdout?: unknown }).stdout;
  const capturedStderr = (error as { stderr?: unknown }).stderr;
  // `latin1`, not `utf8`, when the capture arrived as bytes. It is a byte/code-unit bijection, so a
  // string offset IS a byte offset and a span below needs no re-encoding estimate at all. `utf8` is
  // lossy here — `runGitBuffer` leaves the capture undecoded exactly because git's output need not be
  // valid UTF-8 — and each undecodable byte would come back as U+FFFD worth three, inflating a root's
  // apparent contribution threefold and ranking a smaller contributor first. `DIFF_HEADER` is pure
  // ASCII and git quotes non-ASCII paths (`"a/caf\303\251.txt"`), so the choice cannot affect matching.
  const diff = Buffer.isBuffer(capturedStdout)
    ? capturedStdout.toString("latin1")
    : typeof capturedStdout === "string"
      ? capturedStdout
      : "";
  // One code unit is one byte in the latin1 case, so the span is exact and costs no allocation. When
  // Node decoded upstream (`runGit` passes `encoding`) that decode has already happened and cannot be
  // undone; re-encoding the slice is then exact for everything that round-trips, which is all a string
  // capture can hold.
  const spanBytes = Buffer.isBuffer(capturedStdout)
    ? (start: number, end: number): number => end - start
    : (start: number, end: number): number => Buffer.byteLength(diff.slice(start, end), "utf8");
  const retainedStderr = truncateUtf8(
    Buffer.isBuffer(capturedStderr)
      ? capturedStderr
      : Buffer.from(typeof capturedStderr === "string" ? capturedStderr : "", "utf8"),
    RETAINED_STDERR_BYTES
  );

  const totals = new Map<string, { bytes: number; files: number }>();
  // `exec` in a loop rather than materialising every match: this code runs inside a process that has
  // already hit an allocation ceiling, and a 32 MB capture of minimal headers holds over a million of
  // them. Only the previous header's root and offset are ever needed.
  const matcher = new RegExp(DIFF_HEADER.source, DIFF_HEADER.flags);
  const record = (root: string, start: number, end: number): void => {
    const total = totals.get(root) ?? { bytes: 0, files: 0 };
    totals.set(root, { bytes: total.bytes + spanBytes(start, end), files: total.files + 1 });
  };
  let pending: { root: string; start: number } | undefined;
  for (let header = matcher.exec(diff); header !== null; header = matcher.exec(diff)) {
    if (pending !== undefined) record(pending.root, pending.start, header.index);
    pending = { root: (header[1] ?? "").split("/")[0] ?? "", start: header.index };
  }
  if (pending !== undefined) record(pending.root, pending.start, diff.length);
  const attribution = [...totals.entries()]
    .sort((left, right) => right[1].bytes - left[1].bytes)
    .slice(0, 5)
    .map(
      ([root, total]) => `${root} (>=${total.bytes} diff bytes in ${total.files} file${total.files === 1 ? "" : "s"})`
    )
    .join(", ");

  // ENOBUFS fires on EITHER stream. Saying "the workspace is too large" when git merely wrote a lot of
  // stderr would be a confident lie, so claim it only when stdout is the larger capture. An earlier form
  // tested `diff === ""`, which still told that lie whenever a little stdout accompanied the flood.
  // Measure the captures as Node handed them over. Measuring after a decode gets this wrong in BOTH
  // directions: a UTF-16 code-unit count under-counts dense CJK stderr, and re-encoding an undecodable
  // capture over-counts it threefold. Either one picks the wrong stream, and picking stderr wrongly
  // suppresses the contributor attribution this diagnostic exists to produce.
  const overflowedStderr = captureBytes(capturedStderr) > captureBytes(capturedStdout);
  const detail = overflowedStderr
    ? `wrote more than the ${MAX_GIT_CAPTURE_BYTES}-byte capture buffer to stderr: ${truncateUtf8(Buffer.from(retainedStderr, "utf8"), INLINED_STDERR_BYTES)}`
    : // Both ceilings, because they differ and only one of them is the one being reported. An operator
      // told about the 32 MB buffer who trims to just under it hits `workspace patch exceeds` next.
      `produced more than the ${MAX_GIT_CAPTURE_BYTES}-byte capture buffer (a handed-off patch must also stay under ${MAX_PATCH_BYTES} bytes); the workspace is too large to hand off`;

  // Drop the payload before attaching this as a `cause`. The engine's `errorToJson` walks `cause` and
  // de-cycles with a WeakSet, so it does NOT throw — an earlier version of this comment was wrong to say
  // it did — but it does not TRUNCATE either. Node holds the capture in both `stdout` and `output[1]`, so
  // an unstripped cause serializes to a multiple of the capture. Measured against `errorToJson` 0.32.0:
  // a 4 MB STRING capture (`runGit`) serializes to 8,389,061 chars, 2.0x, because Node holds the payload
  // in both `stdout` and `output[1]`. A 1 MB BUFFER capture (`runGitBuffer`) serializes to 25,041,207
  // chars, 23.9x, because a Buffer expands into one JSON key per byte. Stripped, both come to 386 chars
  // plus whatever stderr head is retained. `error` goes too:
  // it is a self-reference, `e.error === e`, that only a de-cycling serializer survives.
  for (const field of DISCARDED_SPAWN_FIELDS) delete (error as unknown as Record<string, unknown>)[field];
  // A head of stderr is cheap and is the only surviving record of what git actually said, which the
  // message carries only when stderr was the stream that overflowed.
  if (retainedStderr !== "") (error as unknown as Record<string, unknown>).stderr = retainedStderr;

  throw new Error(
    // The cutoff is the capture Node actually retained, not `MAX_GIT_CAPTURE_BYTES`. Node keeps the
    // limit rounded up to the end of the read that crossed it, so the constant is smaller than what was
    // captured, and totals derived from the capture can exceed a cutoff quoted as the constant — a
    // message that contradicts its own arithmetic in the same sentence.
    `git ${subcommand} ${detail}${attribution === "" ? "" : `. Largest contributors within the first ${captureBytes(capturedStdout)} bytes git wrote; git emits in path order, so anything past that cutoff is not visible here: ${attribution}`}`,
    { cause: error }
  );
}
