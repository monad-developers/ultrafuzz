#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <target-id> [prepared-target-root]" >&2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi

target_id="$1"
prepared_target_root="${2:-}"
ultrafuzz_bin="${ULTRAFUZZ_BIN:-ultrafuzz}"
work_root="${ULTRAFUZZ_E2E_WORK_ROOT:-.codex-runs/e2e-targets}"
e2e_mode="${ULTRAFUZZ_E2E_MODE:-submission}"
wait_seconds="${ULTRAFUZZ_E2E_WAIT_SECONDS:-18000}"
poll_interval_seconds="${ULTRAFUZZ_E2E_POLL_INTERVAL_SECONDS:-30}"
node_timeout_seconds="${ULTRAFUZZ_E2E_NODE_TIMEOUT_SECONDS:-900}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="$script_dir/target-e2e-manifest.json"
ci_helper="$script_dir/target-e2e-ci.ts"
config_helper="$script_dir/configure-target-e2e.ts"
fake_runner_source="$script_dir/fake-target-e2e-smithers.sh"

if ! command -v "$ultrafuzz_bin" >/dev/null 2>&1 && [ ! -x "$ultrafuzz_bin" ]; then
  echo "Ultrafuzz CLI not found or not executable: $ultrafuzz_bin" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to run the target E2E CI helpers" >&2
  exit 1
fi
case "$e2e_mode" in
  submission) ;;
  live)
    if [ -z "${OPENAI_API_KEY:-}" ]; then
      echo "The live target E2E mode requires its model credential." >&2
      exit 1
    fi
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
      echo "::add-mask::${OPENAI_API_KEY}"
    fi
    ;;
  *)
    echo "ULTRAFUZZ_E2E_MODE must be 'submission' or 'live'." >&2
    exit 2
    ;;
esac

bun "$ci_helper" validate-manifest "$manifest"
target_name="$(bun "$ci_helper" target-field "$manifest" "$target_id" name)"
target_repository="$(bun "$ci_helper" target-field "$manifest" "$target_id" repository)"
target_revision="$(bun "$ci_helper" target-field "$manifest" "$target_id" revision)"

run_root="${work_root}/${target_id}"
evidence_root="${run_root}/evidence"
target_root="${prepared_target_root:-${run_root}/repo}"
run_id="e2e-${target_id}"
fake_runner_log="$evidence_root/fake-smithers-invocation.json"

case "$run_root" in
  "" | "/" | "." | "..")
    echo "Refusing unsafe target E2E work root." >&2
    exit 1
    ;;
esac

redact_file() {
  local path="$1"
  bun "$ci_helper" redact "$path"
}

run_cli_json() {
  local stdout_path="$1"
  local stderr_path="$2"
  shift 2

  set +e
  "$@" >"$stdout_path" 2>"$stderr_path"
  local status=$?
  set -e

  redact_file "$stdout_path"
  redact_file "$stderr_path"
  if [ -s "$stderr_path" ]; then
    cat "$stderr_path" >&2
  fi
  return "$status"
}

assert_cli_ok() {
  local path="$1"
  local label="$2"
  bun "$ci_helper" assert-cli-ok "$path" "$label"
}

assert_inspect_healthy() {
  local path="$1"
  bun "$ci_helper" assert-inspect-healthy "$path"
}

archive_latest_run_diagnostics() {
  local runs_root="$target_root/.ultrafuzz/runs"
  local latest_run=""
  local diagnostics_root="$evidence_root/run-diagnostics"

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

  rm -rf -- "$diagnostics_root"
  mkdir -p "$diagnostics_root"
  for path in run.json state.json graph.json config.resolved.toml; do
    if [ -f "$latest_run/$path" ]; then
      cp "$latest_run/$path" "$diagnostics_root/$path"
      redact_file "$diagnostics_root/$path"
    fi
  done
  mkdir -p "$diagnostics_root/smithers"
  for path in submission.json tasks.json workflow.tsx; do
    if [ -f "$latest_run/smithers/$path" ]; then
      cp "$latest_run/smithers/$path" "$diagnostics_root/smithers/$path"
      redact_file "$diagnostics_root/smithers/$path"
    fi
  done
}

clone_target() {
  git clone --filter=blob:none --no-checkout "$target_repository" "$target_root"
  git -C "$target_root" fetch --depth 1 origin "$target_revision"
  git -C "$target_root" checkout --detach FETCH_HEAD
  git -C "$target_root" submodule update --init --recursive --depth 1
}

verify_target_revision() {
  if [ ! -d "$target_root/.git" ] && [ ! -f "$target_root/.git" ]; then
    echo "Prepared target root is not a git checkout: $target_root" >&2
    exit 1
  fi
  local actual_revision
  actual_revision="$(git -C "$target_root" rev-parse HEAD)"
  if [ "$actual_revision" != "$target_revision" ]; then
    echo "Prepared target checkout does not match its immutable manifest revision." >&2
    exit 1
  fi
  bun "$ci_helper" write-target-metadata "$manifest" "$target_id" "$evidence_root/target.json" "$actual_revision"
}

install_target_workflow_dependencies() {
  set +e
  bun install --cwd "$target_root/.smithers" >"$evidence_root/smithers-install.log" 2>&1
  local status=$?
  set -e
  redact_file "$evidence_root/smithers-install.log"
  if [ "$status" -ne 0 ]; then
    cat "$evidence_root/smithers-install.log" >&2
    exit "$status"
  fi
}

sync_reference_cache() {
  run_cli_json "$evidence_root/references-sync.json" "$evidence_root/references-sync.stderr.log" \
    "$ultrafuzz_bin" references sync --project "$target_root" --json
  assert_cli_ok "$evidence_root/references-sync.json" "references sync"

  run_cli_json "$evidence_root/references-status.json" "$evidence_root/references-status.stderr.log" \
    "$ultrafuzz_bin" references status --project "$target_root" --json
  assert_cli_ok "$evidence_root/references-status.json" "references status"
}

wait_for_report() {
  local deadline=$((SECONDS + wait_seconds))
  while [ "$SECONDS" -le "$deadline" ]; do
    if ! run_cli_json "$evidence_root/inspect.json" "$evidence_root/inspect.stderr.log" \
      "$ultrafuzz_bin" inspect "$run_id" --project "$target_root" --json; then
      archive_latest_run_diagnostics
      echo "Unable to inspect run ${run_id}; bounded diagnostics were archived." >&2
      return 1
    fi
    if ! assert_cli_ok "$evidence_root/inspect.json" "inspect"; then
      archive_latest_run_diagnostics
      return 1
    fi
    if ! assert_inspect_healthy "$evidence_root/inspect.json"; then
      archive_latest_run_diagnostics
      return 1
    fi

    if run_cli_json "$evidence_root/final-report.json" "$evidence_root/final-report.stderr.log" \
      "$ultrafuzz_bin" report "$run_id" --project "$target_root" --json; then
      assert_cli_ok "$evidence_root/final-report.json" "report"
      return 0
    fi
    sleep "$poll_interval_seconds"
  done

  archive_latest_run_diagnostics
  echo "Timed out waiting for final report for ${run_id}; bounded diagnostics were archived." >&2
  return 1
}

preserved_build_log=""
if [ -n "$prepared_target_root" ] && [ -f "$evidence_root/target-build.log" ] && \
  [ ! -L "$evidence_root/target-build.log" ]; then
  preserved_build_log="$(mktemp)"
  cp -- "$evidence_root/target-build.log" "$preserved_build_log"
fi

rm -rf -- "$run_root"
mkdir -p "$work_root" "$evidence_root"
if [ -n "$preserved_build_log" ]; then
  cp -- "$preserved_build_log" "$evidence_root/target-build.log"
  rm -f -- "$preserved_build_log"
fi
if [ -z "$prepared_target_root" ]; then
  clone_target
fi
verify_target_revision

run_cli_json "$evidence_root/init.json" "$evidence_root/init.stderr.log" \
  "$ultrafuzz_bin" init --project "$target_root" --force --json
assert_cli_ok "$evidence_root/init.json" "init"

bun "$config_helper" "$target_root" "$node_timeout_seconds"
install_target_workflow_dependencies
sync_reference_cache

run_cli_json "$evidence_root/validate.json" "$evidence_root/validate.stderr.log" \
  "$ultrafuzz_bin" validate --project "$target_root" --json
assert_cli_ok "$evidence_root/validate.json" "validate"

run_status=0
if [ "$e2e_mode" = "submission" ]; then
  fake_runner="$run_root/fake-bin/smithers"
  mkdir -p "$(dirname "$fake_runner")"
  install -m 0755 "$fake_runner_source" "$fake_runner"
  run_cli_json "$evidence_root/run.json" "$evidence_root/run.stderr.log" \
    env -u OPENAI_API_KEY \
      SMITHERS_BIN="$fake_runner" \
      SMITHERS_FAKE_LOG="$fake_runner_log" \
      "$ultrafuzz_bin" run \
        --project "$target_root" \
        --run-id "$run_id" \
        --json || run_status=$?
else
  run_cli_json "$evidence_root/run.json" "$evidence_root/run.stderr.log" \
    "$ultrafuzz_bin" run \
      --project "$target_root" \
      --run-id "$run_id" \
      --json || run_status=$?
fi
archive_latest_run_diagnostics
if [ "$run_status" -ne 0 ]; then
  echo "Ultrafuzz run command failed with status ${run_status}; bounded diagnostics were archived." >&2
  exit "$run_status"
fi
assert_cli_ok "$evidence_root/run.json" "run"

if [ "$e2e_mode" = "submission" ]; then
  bun "$ci_helper" assert-run-submission \
    "$evidence_root/run.json" \
    "$evidence_root/run-diagnostics/state.json" \
    "$evidence_root/run-diagnostics/run.json" \
    "$evidence_root/run-diagnostics/smithers/submission.json" \
    "$fake_runner_log" \
    "$run_id"
  echo "Ultrafuzz bounded target submission completed for ${target_id}; no live agents were run. Evidence: ${evidence_root}"
  exit 0
fi

wait_for_report
archive_latest_run_diagnostics
bun "$ci_helper" assert-report-accounting "$evidence_root/final-report.json" "$target_name"
bun "$ci_helper" extract-evidence "$evidence_root/final-report.json" "$evidence_root"

echo "Ultrafuzz target E2E completed for ${target_id}; evidence: ${evidence_root}"
