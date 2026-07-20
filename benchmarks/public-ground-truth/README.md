# Public benchmark labels

These labels cover only the old, open-source EVMBench and Ultrafuzz-bench
cohorts. They are scoring inputs, not evidence that a new target is vulnerable.

EVMBench labels are materialized at runtime from the exact Frontier Evals commit
pinned in `benchmarks/evmbench-detect.json`. The Ultrafuzz-bench YAML files in
this directory normalize already-public audit reports and retain their source
URLs and retrieval identities. Low-value informational and gas-only observations
are excluded where the source report distinguishes them.

Workers copy labels outside each target checkout before planning. Published
Actions artifacts contain candidate reports and normalized findings, not these
ground-truth files.
