# Archived public benchmark bundles

The checked-in `ultrafuzz.modal.public-benchmark-bundle.v4` files predate the
strict JSON-contract release. They are retained only as immutable historical
evidence and are intentionally rejected by the current bundle reader.

New publications must use `ultrafuzz.modal.public-benchmark-bundle.v5`, contain
only `report.md` and schema-valid `report.json` as their fixed per-row report
files, and pass the current report/run/score lineage checks. There is no v4
fallback, conversion, or repair path.
