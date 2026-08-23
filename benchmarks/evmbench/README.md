# EVMBench integration

This directory pins Ultrafuzz to EVMBench's official detect benchmark. The official
NanoEval grader is authoritative: normalized results keep its score, maximum score,
recall, detect-award, and fully typed per-audit fields under `official_evmbench`.
Recorder extras remain only in the preserved upstream JSONL and are never copied
into the normalized result.

`cohort.json` pins the public target set used by the Modal full benchmark lane. The
remaining manifests and profiles in this directory support the official EVMBench
adapter described below.

The lock points at exact commits for the maintained EVMBench repository, its
frontier-evals submodule, and every public target snapshot. Audit build contexts and
benchmark evidence are represented by one-way manifests so the repository can
detect upstream drift without republishing benchmark answers. Platform-specific OCI
image IDs are recorded in each run's provenance after the images are built.

## Profiles

- `smoke` uses lower concurrency and shorter node and workflow deadlines. Use it for
  the upstream debug split and adapter checks.
- `full` uses the complete topology with longer deadlines and bounded concurrency.
  Use it for the detect split only after a dry-run and budget review.

The public full lane binds the packaged Ultrafuzz `full` audit profile. Target
preparation validates that profile, and the launcher derives its current
catalog and topology digests and refuses an effective-policy mismatch before
creating a run. The actual run-plan policy and topology origin are checked again
before public-history publication; the lane does not inherit the direct-only
project topology.

Both profiles are explicit JSON files under `profiles/`. Model and reasoning
overrides become part of the benchmark identity and the overlay image, so repeated
runs with the same lock and controls record the same identity.

The profile, lock, catalog, and normalized-result contracts are closed v2 JSON
documents. The v2 bump intentionally has no v1 compatibility parser or conversion;
malformed, legacy, and extra fields fail validation at their read boundary.

## Prerequisites

- Node.js and the workspace's pinned pnpm version
- Git, Docker with BuildKit support, and `uv`
- Authentication accepted by the official harness and the selected Ultrafuzz agent
- Enough local disk for the official audit images, separate Ultrafuzz overlays, and
  preserved upstream result files

Do not place credentials in this directory, the lock, image build arguments, or
result files. The adapter uses the authentication material that the official harness
places in its isolated agent container.

## Commands

Validate the full matrix without building images or making model calls:

```bash
pnpm benchmark:evmbench -- --split detect-tasks --profile full --dry-run
```

Run the official debug split with the smoke profile:

```bash
pnpm benchmark:evmbench -- --split debug --profile smoke --model gpt-5.5 --auth-path /secure/path/to/auth.json
```

Run one pinned audit, or the complete detect split with an explicit concurrency
limit:

```bash
pnpm benchmark:evmbench -- --audit 2023-07-pooltogether --profile smoke --auth-path /secure/path/to/auth.json
pnpm benchmark:evmbench -- --split detect-tasks --profile full --concurrency 5 --auth-path /secure/path/to/auth.json
```

For non-gold runs, `--auth-path` must name a regular, non-symlinked subscription
authentication file. The official harness forwards it only at runtime; it is never
copied into an image or result artifact.

Verify the official grader wiring with its own gold-solution mode:

```bash
pnpm benchmark:evmbench -- --split debug --profile smoke --gold
```

The gold command still invokes the official judge. It is not a credential-free
test and should be run only with an approved budget.

## Images and isolation

The runner builds target source images from the pinned harness after replacing each
mutable clone with a detached checkout of the locked target commit. It then builds a
self-contained Ultrafuzz overlay for every selected audit. Source images and
overlays use distinct repository names; upstream audit tags are never overwritten or
retagged.

Only allowlisted non-answer files referenced by an upstream audit Dockerfile enter
its sanitized build context. The harness remains on the host, and neither benchmark
answers nor grader inputs are copied, cloned, or mounted into the agent-visible
container. The adapter writes exactly one agent output:
`/home/agent/submission/audit.md`.

The Ultrafuzz overlay is built from committed Git files only. Its exact generated
workflow dependencies are installed while the image has build-time network access,
then seeded into each initialized audit workspace so execution remains compatible
with the official runtime network policy.

## Results and provenance

Each real run writes under `.ultrafuzz/evmbench/results/` unless `--output` is
provided. The `upstream/` directory is the unmodified official output. The sibling
`normalized-summary.json` adds:

- the official metric family with closed, typed per-audit aggregates;
- exact Ultrafuzz, EVMBench, frontier-evals, and target commits;
- source and overlay image IDs;
- profile, topology, model, reasoning, and concurrency fingerprints; and
- runtime plus explicit completeness states for token and cost accounting.

The runner never infers unavailable usage or cost values. A missing value remains
`null` with `unavailable` completeness.

## Cost and execution policy

The debug split includes both an Ultrafuzz campaign and official judge calls. The
full split multiplies both workloads across the complete matrix, so there is no
stable currency estimate independent of model pricing and provider policy. Always
run the credential-free dry-run first, review the selected matrix and concurrency,
and apply provider-side budget controls before a paid run.

CI runs unit tests, lock verification against a prepared pinned checkout, formatting,
lint, and typechecking. It does not launch paid model calls. Gold, one-target smoke,
and full detect runs are opt-in operational checks.

## Updating the pin

1. Check out the maintained public EVMBench repository and initialize its submodule.
2. Review upstream audit, split, agent, grader, and image changes.
3. Regenerate the lock and privacy-safe catalog:

   ```bash
   pnpm benchmark:evmbench:lock -- --harness /path/to/evmbench --write
   ```

4. Verify the generated files and full matrix:

   ```bash
   pnpm benchmark:evmbench:lock -- --harness /path/to/evmbench --check
   pnpm benchmark:evmbench -- --split detect-tasks --profile full --dry-run --harness /path/to/evmbench
   ```

The updater fails for missing repositories, duplicate audit or finding IDs, missing
finding documents, split/catalog drift, unsafe Docker context inputs, changed
finding manifests, mutable target refs, and digest mismatches.

## Troubleshooting

- A lock or catalog mismatch means the prepared harness is not at the pinned commits
  or its audit data drifted. Do not bypass the check; prepare the pinned checkout or
  intentionally update the lock.
- A source-image commit mismatch means a stale local image was found. Remove that
  single Ultrafuzz-owned source tag and rebuild it; do not alter upstream tags.
- If the adapter exits without a submission, inspect the preserved upstream run log
  and the Ultrafuzz run under the audit workspace. Empty and symlinked reports are
  rejected intentionally.
- If a real run is interrupted, rerun it with the same profile. The adapter resumes
  an existing nonterminal Ultrafuzz run when its persisted run directory is present.
