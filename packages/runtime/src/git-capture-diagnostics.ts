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

/** Decode at most `limit` BYTES, dropping a replacement character left by a mid-sequence cut. */
function truncateUtf8(buffer: Buffer, limit: number): string {
  const text = buffer.subarray(0, limit).toString("utf8");
  return buffer.length > limit && text.endsWith("\uFFFD") ? text.slice(0, -1) : text;
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
 *   2. The LAST root in the prefix is truncated mid-hunk, and it is often the one ranked first, so the
 *      top entry is the one most understated. Two close entries can invert on where the cutoff landed.
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
  const asText = (value: unknown): string =>
    Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
  const diff = asText((error as { stdout?: unknown }).stdout);
  const capturedStderr = (error as { stderr?: unknown }).stderr;
  const errorOutput = asText(capturedStderr);
  // Bound the BUFFER, not the decoded string: `slice` on a string counts UTF-16 code units, so a
  // constant named `_BYTES` would be honoured at up to three times its value on multi-byte output.
  // Cutting mid-sequence leaves a trailing replacement character which re-encodes to THREE bytes, so
  // dropping it is what makes the retained text actually fit the bound rather than overshoot it.
  const retainedStderr = truncateUtf8(
    Buffer.isBuffer(capturedStderr) ? capturedStderr : Buffer.from(errorOutput, "utf8"),
    RETAINED_STDERR_BYTES
  );

  const totals = new Map<string, { bytes: number; files: number }>();
  const headers = [...diff.matchAll(DIFF_HEADER)];
  headers.forEach((header, position) => {
    const start = header.index ?? 0;
    const end = position + 1 < headers.length ? (headers[position + 1]?.index ?? diff.length) : diff.length;
    const root = (header[1] ?? "").split("/")[0] ?? "";
    const total = totals.get(root) ?? { bytes: 0, files: 0 };
    // `Buffer.byteLength`, not `end - start`: a decoded string is measured in UTF-16 code units, so a
    // 3-byte UTF-8 character counts as 1. Any multi-byte path or content run is undercounted against the
    // byte budget the message is reporting, by an amount that depends entirely on the content.
    totals.set(root, {
      bytes: total.bytes + Buffer.byteLength(diff.slice(start, end), "utf8"),
      files: total.files + 1
    });
  });
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
  // Byte lengths, not string lengths: the buffer that overflowed is measured in bytes, so comparing
  // UTF-16 code units can pick the wrong stream whenever the two differ in encoding density — 30 MB of
  // ASCII stdout has more code units than 12 M CJK characters of stderr worth 36 MB.
  const overflowedStderr = Buffer.byteLength(errorOutput, "utf8") > Buffer.byteLength(diff, "utf8");
  const detail = overflowedStderr
    ? `wrote more than the ${MAX_GIT_CAPTURE_BYTES}-byte capture buffer to stderr: ${truncateUtf8(Buffer.from(retainedStderr, "utf8"), INLINED_STDERR_BYTES)}`
    : // Both ceilings, because they differ and only one of them is the one being reported. An operator
      // told about the 32 MB buffer who trims to just under it hits `workspace patch exceeds` next.
      `produced more than the ${MAX_GIT_CAPTURE_BYTES}-byte capture buffer (a handed-off patch must also stay under ${MAX_PATCH_BYTES} bytes); the workspace is too large to hand off`;

  // Drop the payload before attaching this as a `cause`. The engine's `errorToJson` walks `cause` and
  // de-cycles with a WeakSet, so it does NOT throw — an earlier version of this comment was wrong to say
  // it did — but it does not TRUNCATE either. Node holds the capture in both `stdout` and `output[1]`, so
  // an unstripped cause serializes to hundreds of megabytes where a stripped one is about a kilobyte.
  // (Exact figures depend entirely on the captured content, so none are quoted here.) `error` goes too:
  // it is a self-reference, `e.error === e`, that only a de-cycling serializer survives.
  for (const field of DISCARDED_SPAWN_FIELDS) delete (error as unknown as Record<string, unknown>)[field];
  // A head of stderr is cheap and is the only surviving record of what git actually said, which the
  // message carries only when stderr was the stream that overflowed.
  if (retainedStderr !== "") (error as unknown as Record<string, unknown>).stderr = retainedStderr;

  throw new Error(
    `git ${subcommand} ${detail}${attribution === "" ? "" : `. Largest contributors within the first ${MAX_GIT_CAPTURE_BYTES} bytes git wrote; git emits in path order, so anything past that cutoff is not visible here: ${attribution}`}`,
    { cause: error }
  );
}
