# UltrafuzzBench

This directory contains the UltrafuzzBench cohort and its checked-in evaluation
artifacts. The serialized benchmark ID remains `ultrafuzz-bench` for compatibility
with existing run and history documents.

- `cohort.json` pins the public target repositories and revisions.
- `lanes.json` defines the shared smoke and full public-benchmark execution policy.
- `ground-truth/` contains public labels used to score UltrafuzzBench targets.
- `results/` archives published public result bundles.
- `history.json` is the append-only public evaluation history.

The full public lane uses the EVMBench cohort, while the smoke lane uses the
UltrafuzzBench cohort. Both lanes intentionally share the policy in `lanes.json`.
