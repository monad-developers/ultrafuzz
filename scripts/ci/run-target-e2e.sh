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
ultrafuzz_bin="${ULTRAFUZZ_BIN:-ultrafuzz}"
agent_ref="${ULTRAFUZZ_E2E_AGENT:-CodexAgent}"
model_name="${ULTRAFUZZ_E2E_MODEL:-gpt-5.5}"
work_root="${ULTRAFUZZ_E2E_WORK_ROOT:-.codex-runs/e2e-targets}"
wait_seconds="${ULTRAFUZZ_E2E_WAIT_SECONDS:-1800}"
poll_interval_seconds="${ULTRAFUZZ_E2E_POLL_INTERVAL_SECONDS:-15}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ci_helper="$script_dir/target-e2e-ci.py"
clone_repository="$target_repository"
checkout_ref=""
checkout_kind=""

if ! command -v "$ultrafuzz_bin" >/dev/null 2>&1 && [ ! -x "$ultrafuzz_bin" ]; then
  echo "Ultrafuzz CLI not found or not executable: $ultrafuzz_bin" >&2
  exit 1
fi
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "OPENAI_API_KEY must be set before running target repository E2E." >&2
  exit 1
fi
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::add-mask::${OPENAI_API_KEY}"
fi

slug="$(printf '%s' "$target_repository" \
  | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://##; s#^git@##; s#[^A-Za-z0-9._-]+#-#g; s#^-+##; s#-+$##' \
  | cut -c 1-80)"
if [ -z "$slug" ]; then
  slug="target"
fi

run_root="${work_root}/${slug}"
target_root="${run_root}/repo"
evidence_root="${run_root}/evidence"
run_id="e2e-${slug//./-}"

redact_file() {
  local path="$1"
  python3 "$ci_helper" redact "$path"
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
  python3 "$ci_helper" assert-cli-ok "$path" "$label"
}

assert_inspect_healthy() {
  local path="$1"
  python3 "$ci_helper" assert-inspect-healthy "$path"
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

  rm -rf "$diagnostics_root"
  mkdir -p "$diagnostics_root"

  for path in run.json state.json graph.json config.resolved.toml events.jsonl smithers/submission.json smithers/input.json smithers/tasks.json; do
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
      find "$latest_run/artifacts" -maxdepth 4 -type f \
        \( -name '*.json' -o -name '*.md' -o -name '*.log' \) \
        -print0
    )
  fi
}

normalize_github_target() {
  local target="$1"
  local without_query="${target%%[\?#]*}"
  if [[ "$without_query" =~ ^https://github\.com/([^/]+)/([^/]+)(\.git)?/(releases/tag|tree|commit)/(.+)$ ]]; then
    local owner="${BASH_REMATCH[1]}"
    local repo="${BASH_REMATCH[2]%.git}"
    local kind="${BASH_REMATCH[4]}"
    local ref="${BASH_REMATCH[5]}"
    clone_repository="https://github.com/${owner}/${repo}.git"
    checkout_ref="$ref"
    checkout_kind="$kind"
  elif [[ "$without_query" =~ ^https://github\.com/([^/]+)/([^/]+)(\.git)?/?$ ]]; then
    local owner="${BASH_REMATCH[1]}"
    local repo="${BASH_REMATCH[2]%.git}"
    clone_repository="https://github.com/${owner}/${repo}.git"
  elif [[ "$without_query" != *"://"* && "$without_query" != git@* && "$without_query" == */* && ! -d "$without_query/.git" ]]; then
    clone_repository="https://github.com/${without_query%.git}.git"
  fi
}

clone_target() {
  echo "Cloning target repository: ${clone_repository}${checkout_ref:+ @ ${checkout_ref}}"
  if [ -d "$clone_repository/.git" ]; then
    git clone "$clone_repository" "$target_root"
  elif [ -n "$checkout_ref" ] && { [ "$checkout_kind" = "releases/tag" ] || [ "$checkout_kind" = "tree" ]; }; then
    git clone --depth 1 --branch "$checkout_ref" --recurse-submodules --shallow-submodules "$clone_repository" "$target_root"
  elif [ -n "$checkout_ref" ]; then
    git clone --filter=blob:none --no-checkout "$clone_repository" "$target_root"
    git -C "$target_root" fetch --depth 1 origin "$checkout_ref"
    git -C "$target_root" checkout --detach FETCH_HEAD
    git -C "$target_root" submodule update --init --recursive --depth 1
  else
    git clone --depth 1 --recurse-submodules --shallow-submodules "$clone_repository" "$target_root"
  fi
}

write_target_metadata() {
  python3 "$ci_helper" write-target-metadata "$evidence_root/target.json" "$target_name" "$target_repository" "$signal_profile" "$expected_findings"
}

install_target_workflow_dependencies() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required to install target workflow dependencies" >&2
    exit 1
  fi
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

wait_for_report() {
  local deadline=$((SECONDS + wait_seconds))
  while [ "$SECONDS" -le "$deadline" ]; do
    if ! run_cli_json "$evidence_root/inspect.json" "$evidence_root/inspect.stderr.log" \
      "$ultrafuzz_bin" inspect "$run_id" --project "$target_root" --json; then
      archive_latest_run_diagnostics
      echo "Unable to inspect run ${run_id}; diagnostics copied to ${evidence_root}/run-diagnostics." >&2
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
  echo "Timed out waiting for final report for ${run_id}; diagnostics copied to ${evidence_root}/run-diagnostics." >&2
  return 1
}

copy_report_json() {
  python3 "$ci_helper" copy-report-json "$evidence_root/final-report.json" "$evidence_root/report.json"
}

assert_report_accounting() {
  python3 "$ci_helper" assert-report-accounting "$evidence_root/final-report.json" "$target_name" "$signal_profile"
}

assert_report_findings() {
  python3 "$ci_helper" assert-report-findings "$evidence_root/report.json" "$expected_findings" "$target_name" "$signal_profile"
}

rm -rf "$run_root"
mkdir -p "$work_root" "$evidence_root"

write_target_metadata
normalize_github_target "$target_repository"
clone_target

run_cli_json "$evidence_root/init.json" "$evidence_root/init.stderr.log" \
  "$ultrafuzz_bin" init --project "$target_root" --force --json
assert_cli_ok "$evidence_root/init.json" "init"

python3 "$script_dir/scaffold-target-e2e.py" "$target_root"
install_target_workflow_dependencies

run_cli_json "$evidence_root/validate.json" "$evidence_root/validate.stderr.log" \
  "$ultrafuzz_bin" validate --project "$target_root" --json
assert_cli_ok "$evidence_root/validate.json" "validate"

run_status=0
run_cli_json "$evidence_root/run.json" "$evidence_root/run.stderr.log" \
  "$ultrafuzz_bin" run \
    --project "$target_root" \
    --run-id "$run_id" \
    --agent "$agent_ref" \
    --model "$model_name" \
    --max-concurrency "${ULTRAFUZZ_E2E_MAX_CONCURRENCY:-1}" \
    --json || run_status=$?
archive_latest_run_diagnostics
if [ "$run_status" -ne 0 ]; then
  echo "Ultrafuzz run command failed with status ${run_status}; diagnostics copied to ${evidence_root}/run-diagnostics." >&2
  exit "$run_status"
fi
assert_cli_ok "$evidence_root/run.json" "run"

wait_for_report
archive_latest_run_diagnostics
copy_report_json
assert_report_accounting
assert_report_findings

echo "Ultrafuzz target E2E completed for ${target_repository}; evidence: ${evidence_root}"
