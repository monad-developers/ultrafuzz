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
 *
 * The `{1,4096}` bound is not cosmetic. An unbounded lazy `(.+?)` pushes one backtrack frame per
 * iteration, and `.` stops only at line terminators — not at NUL, and not at the end of a path — so on a
 * capture with no newline for tens of megabytes it overflows the stack and throws `RangeError: Maximum
 * call stack size exceeded` OUT of the handler, destroying the ENOBUFS it exists to explain and
 * replacing it with something less actionable than the bare error. Measured at 10 MB: throws in 64 ms.
 * 4096 is `PATH_MAX` on Linux, so no path git can hand back is excluded, and the bounded form is also
 * substantially faster (measured 14.7x on the 10 MB case).
 *
 * This bound and the latin1 view below are REDUNDANT: the overflow needs a two-byte string, and either
 * one alone prevents it. The regression test pins the property — that no `RangeError` escapes — and
 * removing either guard on its own leaves it green, which was verified by mutation rather than assumed.
 * Both are kept because the latin1 view is a choice a later change could reverse without noticing this.
 */
const DIFF_HEADER = /^diff --git "?a\/(.{1,4096}?)"? "?b\//gmu;

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

/**
 * Distinct roots to keep totals for. The table is the last structure here that grows with the CAPTURE
 * rather than with a constant, and the capture's root names are whatever the agent wrote to disk, so its
 * cardinality is not bounded by anything in this repo. Peak RSS on a 51 MB capture of 1.19M headers with
 * all-distinct roots, each figure from `/usr/bin/time -v` on the same fixture:
 *
 *   hold the capture and do nothing else      454 MB          (what the code did before this change)
 *   materialise every match, table unbounded  976 MB  +522 MB  3101 ms
 *   stream the matches, table unbounded       724 MB  +270 MB  1842 ms
 *   stream the matches, table capped here     457 MB    +3 MB   817 ms
 *
 * Only the last row ships. This runs inside a process that has just been REFUSED an allocation, so the
 * tail of that distribution is exactly when it must not ask for more.
 *
 * Roots past the cap are counted — with their bytes, not merely a file count — rather than silently
 * dropped. Admission is first-encounter order, so a root arriving after the table fills is excluded no
 * matter how large it is, and a truncated ranking that reads as a complete one is how an operator gets
 * sent after the wrong directory.
 */
const MAX_RANKED_ROOTS = 4096;

/**
 * Global `git` options that consume the NEXT argument, which is therefore not the subcommand.
 *
 * Without this, `git -c core.quotepath=false diff` reports its subcommand as `core.quotepath=false`: the
 * value does not start with `-`, so a plain "first non-flag argument" scan stops on it. Naming the wrong
 * thing is worse here than naming nothing, because the entire complaint this diagnostic answers is that
 * the original error named no subcommand at all. The `--opt=value` forms need no entry — they start with
 * `-` and are skipped anyway.
 */
const GIT_OPTIONS_TAKING_A_VALUE = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix"
]);

/** The subcommand in a `git` argument list, skipping global options and their values. */
function gitSubcommand(args: readonly string[]): string {
  for (let position = 0; position < args.length; position += 1) {
    const argument = args[position] ?? "";
    if (GIT_OPTIONS_TAKING_A_VALUE.has(argument)) {
      position += 1;
      continue;
    }
    if (!argument.startsWith("-")) return argument;
  }
  return "git";
}

/** A string whose UTF-8 encoding is at most `limit` bytes, taken from the head of `buffer`. */
function truncateUtf8(buffer: Buffer, limit: number): string {
  // Decoding is LOSSY, and a lossy decode can GROW: every byte that is not valid UTF-8 becomes U+FFFD,
  // which re-encodes to THREE bytes. So bounding the input buffer bounds nothing -- 2048 bytes of 0xFF
  // come back as a string worth 6144. Shrink until the ENCODED text fits, which is the bound the
  // constant names. Neither git wrapper passes `encoding`, precisely because git's output need not be
  // valid UTF-8, so an undecodable capture is the ordinary case here, not a contrived one.
  // `Math.max(0, ...)` because `subarray(0, -1)` is END-relative and would return nearly the whole
  // buffer -- a negative limit is unreachable from the two constants here, but "unreachable" is a
  // property of today's callers, not of this function.
  let take = Math.max(0, Math.min(limit, buffer.length));
  let text = buffer.subarray(0, take).toString("utf8");
  for (let encoded = Buffer.byteLength(text, "utf8"); take > 0 && encoded > limit;) {
    // Scale by the observed ratio, and cut by at least one byte so `take` strictly decreases: that, with
    // the `take > 0` guard, is the whole termination argument. Iteration count is NOT bounded by two --
    // the ratio applies to the whole prefix while the excess may sit in one region of it. Fuzzed over
    // 200,000 random buffers of mixed valid and invalid UTF-8: 6 iterations worst case, and zero cases
    // where the returned text exceeded the limit.
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
  const subcommand = gitSubcommand(args);
  const capturedStdout = (error as { stdout?: unknown }).stdout;
  const capturedStderr = (error as { stderr?: unknown }).stderr;
  // Work on a `latin1` view of the capture, whatever form it arrived in. Three things fall out of that
  // one choice, and none of them hold for a `utf8` view:
  //
  //   1. latin1 is a byte/code-unit bijection, so a string offset IS a byte offset: `end - start` is the
  //      exact span, with no re-encoding estimate and no per-header slice allocation.
  //   2. `utf8` is lossy on a capture Node did not decode — neither `runGit` nor `runGitBuffer` passes
  //      `encoding`, precisely because git's output need not be valid UTF-8 — and each undecodable byte
  //      returns as U+FFFD worth three, inflating a root's contribution threefold and ranking a smaller
  //      one first. The string branch below is a FALLBACK, not a live path: once Node has decoded, the
  //      original bytes are gone and nothing here can recover them, which is why the fix for that case
  //      lives at the call site rather than in this function.
  //   3. A latin1 string is one-byte internally. `DIFF_HEADER` over a TWO-byte string overflows V8's
  //      backtrack stack on a capture with no line terminator, throwing `RangeError` out of this
  //      handler; a single character above U+00FF anywhere in the capture is enough to flip a string to
  //      two-byte. The bound on the quantifier is the direct fix, but never handing the regex a
  //      two-byte string removes the precondition as well.
  //
  // `DIFF_HEADER` is pure ASCII and git quotes non-ASCII paths (`"a/caf\303\251.txt"`), so the view
  // cannot affect what matches — only what the offsets mean.
  const diff = Buffer.isBuffer(capturedStdout)
    ? capturedStdout.toString("latin1")
    : typeof capturedStdout === "string"
      ? Buffer.from(capturedStdout, "utf8").toString("latin1")
      : "";
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
  // Files, not roots: one increment per header that could not be admitted. Carrying the BYTES too is
  // what keeps the cap honest -- admission is first-encounter order, so a root arriving after the table
  // fills is excluded regardless of size, and a count alone cannot tell an operator whether what was
  // dropped is negligible or larger than everything ranked above it.
  let unrankedFiles = 0;
  let unrankedBytes = 0;
  const record = (root: string, start: number, end: number): void => {
    const total = totals.get(root);
    if (total === undefined && totals.size >= MAX_RANKED_ROOTS) {
      unrankedFiles += 1;
      unrankedBytes += end - start;
      return;
    }
    // `end - start` is exact: `diff` is a latin1 view, so one code unit is one byte.
    const previous = total ?? { bytes: 0, files: 0 };
    totals.set(root, { bytes: previous.bytes + (end - start), files: previous.files + 1 });
  };
  let pending: { root: string; start: number } | undefined;
  for (let header = matcher.exec(diff); header !== null; header = matcher.exec(diff)) {
    if (pending !== undefined) record(pending.root, pending.start, header.index);
    pending = { root: (header[1] ?? "").split("/")[0] ?? "", start: header.index };
  }
  if (pending !== undefined) record(pending.root, pending.start, diff.length);
  const ranked = [...totals.entries()]
    .sort((left, right) => right[1].bytes - left[1].bytes)
    .slice(0, 5)
    .map(
      ([root, total]) => `${root} (>=${total.bytes} diff bytes in ${total.files} file${total.files === 1 ? "" : "s"})`
    )
    .join(", ");
  const attribution =
    unrankedFiles === 0
      ? ranked
      : `${ranked} (and ${unrankedBytes} diff bytes in ${unrankedFiles} further file${unrankedFiles === 1 ? "" : "s"} under roots past the ${MAX_RANKED_ROOTS}-root table, not counted above)`;

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
