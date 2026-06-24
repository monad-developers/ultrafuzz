#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <target-repository-url-or-owner/repo>" >&2
}

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi

target_repository="$1"
target_name="${TARGET_NAME:-$target_repository}"
signal_profile="${ULTRAFUZZ_E2E_SIGNAL_PROFILE:-control}"
expected_findings="${ULTRAFUZZ_E2E_EXPECTED_FINDINGS:-any}"
checkout_ref=""

if [[ "$target_repository" =~ ^https://github.com/([^/]+)/([^/]+)/releases/tag/(.+)$ ]]; then
  clone_url="https://github.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  checkout_ref="${BASH_REMATCH[3]}"
elif [[ "$target_repository" =~ ^https://github.com/([^/]+)/([^/]+)/commit/([0-9A-Fa-f]+)$ ]]; then
  clone_url="https://github.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  checkout_ref="${BASH_REMATCH[3]}"
elif [[ "$target_repository" != *"://"* && "$target_repository" != git@* && "$target_repository" == */* ]]; then
  clone_url="https://github.com/${target_repository}"
else
  clone_url="$target_repository"
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "OPENAI_API_KEY must be set from a CI secret before running Ultrafuzz E2E." >&2
  exit 1
fi
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::add-mask::${OPENAI_API_KEY}"
fi

ultrafuzz_bin="${ULTRAFUZZ_BIN:-$(pwd)/.cargo-target/release/ultrafuzz}"
if [ ! -x "$ultrafuzz_bin" ]; then
  echo "Ultrafuzz binary not found or not executable: $ultrafuzz_bin" >&2
  exit 1
fi

redact_file() {
  local path="$1"
  python3 - "$path" <<'PY'
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
secret = os.environ.get("OPENAI_API_KEY", "").encode()
if not secret or not path.exists():
    raise SystemExit(0)

content = path.read_bytes()
content = content.replace(secret, b"[REDACTED_OPENAI_API_KEY]")
path.write_bytes(content)
PY
}

capture_target_json() {
  local stdout_path="$1"
  local stderr_path="$2"
  shift 2

  set +e
  (
    cd "$target_root"
    "$@"
  ) > "$stdout_path" 2> "$stderr_path"
  local status=$?
  set -e

  redact_file "$stdout_path"
  redact_file "$stderr_path"
  if [ -s "$stderr_path" ]; then
    cat "$stderr_path" >&2
  fi
  return "$status"
}

capture_target_log() {
  local output_path="$1"
  shift

  set +e
  (
    cd "$target_root"
    "$@"
  ) > "$output_path" 2>&1
  local status=$?
  set -e

  redact_file "$output_path"
  cat "$output_path"
  return "$status"
}

archive_latest_run_diagnostics() {
  local runs_root="$target_root/.ultrafuzz/runs"
  local latest_run=""
  local diagnostics_root

  if [ ! -d "$runs_root" ]; then
    return 0
  fi

  latest_run="$(find "$runs_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr \
    | head -n 1 \
    | cut -d' ' -f2-)"
  if [ -z "$latest_run" ]; then
    return 0
  fi

  diagnostics_root="$evidence_root/run-diagnostics"
  rm -rf "$diagnostics_root"
  mkdir -p "$diagnostics_root"

  for path in run.json state.json graph.json config.resolved.toml events.jsonl; do
    if [ -f "$latest_run/$path" ]; then
      mkdir -p "$diagnostics_root/$(dirname "$path")"
      cp "$latest_run/$path" "$diagnostics_root/$path"
      redact_file "$diagnostics_root/$path"
    fi
  done

  if [ -d "$latest_run/artifacts" ]; then
    while IFS= read -r -d '' path; do
      local relative="${path#"$latest_run/"}"
      mkdir -p "$diagnostics_root/$(dirname "$relative")"
      cp "$path" "$diagnostics_root/$relative"
      redact_file "$diagnostics_root/$relative"
    done < <(
      find "$latest_run/artifacts" -maxdepth 3 -type f \
        \( -name stdout.log -o -name stderr.log -o -name metadata.json -o -name prompt.rendered.md \) \
        -print0
    )
  fi
}

slug="$(printf '%s' "$target_repository" \
  | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://##; s#^git@##; s#[^A-Za-z0-9._-]+#-#g; s#^-+##; s#-+$##' \
  | cut -c 1-80)"
if [ -z "$slug" ]; then
  slug="target"
fi

work_root="${ULTRAFUZZ_E2E_WORK_ROOT:-.codex-runs/e2e-targets}"
run_root="${work_root}/${slug}"
target_root="${run_root}/repo"
evidence_root="${run_root}/evidence"

rm -rf "$run_root"
mkdir -p "$work_root" "$evidence_root"

python3 - "$evidence_root/target.json" "$target_name" "$target_repository" "$signal_profile" "$expected_findings" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
path.write_text(json.dumps({
    "schema_version": "1.0",
    "target_name": sys.argv[2],
    "target_repository": sys.argv[3],
    "signal_profile": sys.argv[4],
    "expected_findings": sys.argv[5],
}, indent=2) + "\n")
PY

if [ -n "$checkout_ref" ]; then
  git clone --filter=blob:none --no-checkout "$clone_url" "$target_root"
  (
    cd "$target_root"
    if git fetch --depth 1 origin "$checkout_ref"; then
      git checkout --detach FETCH_HEAD
    elif git fetch --depth 1 origin "refs/tags/${checkout_ref}:refs/tags/${checkout_ref}"; then
      git checkout --detach "$checkout_ref"
    else
      echo "Unable to fetch requested target ref: ${checkout_ref}" >&2
      exit 1
    fi
    git submodule update --init --recursive --depth 1
  )
else
  git clone --depth 1 --recurse-submodules --shallow-submodules "$clone_url" "$target_root"
fi

bash scripts/ci/scaffold-target-e2e.sh "$target_root" "$ultrafuzz_bin"

capture_target_json \
  "$evidence_root/doctor.json" \
  "$evidence_root/doctor.stderr.log" \
  "$ultrafuzz_bin" doctor --backend codex-cli --json --plain --no-color

run_status=0
capture_target_log \
  "$evidence_root/ultrafuzz-run.log" \
  "$ultrafuzz_bin" run \
  --plain \
  --no-color \
  --quiet \
  --backend codex-cli \
  --max-parallel-agents "${ULTRAFUZZ_E2E_MAX_PARALLEL_AGENTS:-1}" \
  --strategy-loops "${ULTRAFUZZ_E2E_STRATEGY_LOOPS:-1}" \
  --dynamic-strategies-enumerator "${ULTRAFUZZ_E2E_DYNAMIC_STRATEGIES_ENUMERATOR:-1}" \
  --triage-quorum "${ULTRAFUZZ_E2E_TRIAGE_QUORUM:-1}" \
  --triage-panel-size "${ULTRAFUZZ_E2E_TRIAGE_PANEL_SIZE:-1}" \
  --invariant-property-priority-threshold high \
  --invariant-testing-fuzzer-timeout "${ULTRAFUZZ_E2E_INVARIANT_TIMEOUT:-5min}" \
  || run_status=$?

archive_latest_run_diagnostics

status_status=0
capture_target_json \
  "$evidence_root/status.json" \
  "$evidence_root/status.stderr.log" \
  "$ultrafuzz_bin" status latest --json --plain --no-color \
  || status_status=$?

report_status=0
capture_target_json \
  "$evidence_root/final-report.json" \
  "$evidence_root/final-report.stderr.log" \
  "$ultrafuzz_bin" report latest --json \
  || report_status=$?

archive_latest_run_diagnostics

if [ "$run_status" -ne 0 ]; then
  echo "Ultrafuzz run command failed with status ${run_status}; diagnostics copied to ${evidence_root}/run-diagnostics." >&2
  exit "$run_status"
fi
if [ "$status_status" -ne 0 ]; then
  echo "Unable to read latest Ultrafuzz status; diagnostics copied to ${evidence_root}/run-diagnostics." >&2
  exit "$status_status"
fi
if [ "$report_status" -ne 0 ]; then
  echo "Unable to read latest Ultrafuzz final report; diagnostics copied to ${evidence_root}/run-diagnostics." >&2
  exit "$report_status"
fi

python3 - "$evidence_root/status.json" "$evidence_root/final-report.json" "$expected_findings" "$target_name" "$signal_profile" <<'PY'
import json
import sys
from pathlib import Path

status_path = Path(sys.argv[1])
report_path = Path(sys.argv[2])
expected = sys.argv[3]
target_name = sys.argv[4]
signal_profile = sys.argv[5]
status = json.loads(status_path.read_text())
report = json.loads(report_path.read_text())

if status.get("status") != "succeeded":
    raise SystemExit(f"Ultrafuzz run did not succeed: {status.get('status')!r}")
if not report.get("schema_version"):
    raise SystemExit("Final report JSON is missing schema_version")
if not report_path.stat().st_size:
    raise SystemExit("Final report JSON is empty")
findings = report.get("findings")
if not isinstance(findings, list):
    raise SystemExit("Final report JSON must contain a findings array")
count = len(findings)
if expected == "any":
    pass
elif expected == "eq:0":
    if count != 0:
        raise SystemExit(
            f"{target_name} ({signal_profile}) expected exactly 0 findings, got {count}"
        )
elif expected == "gt:0":
    if count <= 0:
        raise SystemExit(
            f"{target_name} ({signal_profile}) expected more than 0 findings, got {count}"
        )
else:
    raise SystemExit(f"Unsupported expected findings expression: {expected!r}")
print(
    f"Finding count assertion passed for {target_name} ({signal_profile}): "
    f"{count} findings matched {expected}"
)
PY

echo "Ultrafuzz target E2E completed for ${target_repository}; evidence: ${evidence_root}"
