#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "usage: terminate-modal-benchmark.sh <plan-dir> <state-dir> <pairs-tsv> <build-scope> <state-available> <candidate-source>" >&2
  exit 2
fi

benchmark_plan="$1"
benchmark_state="$2"
cleanup_pair_list="$3"
build_scope="$4"
state_available="$5"
candidate_source="$6"

if [ ! -d "$benchmark_plan" ] || [ ! -f "$cleanup_pair_list" ] || [ -L "$cleanup_pair_list" ]; then
  echo "validated Modal cleanup inputs are unavailable" >&2
  exit 1
fi
if [[ ! "$build_scope" =~ ^[1-9][0-9]*-[1-9][0-9]*$ ]]; then
  echo "Modal cleanup build scope is invalid" >&2
  exit 1
fi
if [ "$state_available" != true ] && [ "$state_available" != false ]; then
  echo "Modal cleanup state availability must be true or false" >&2
  exit 1
fi
if [ ! -d "$candidate_source" ] || ! git -C "$candidate_source" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "Modal cleanup candidate source is invalid" >&2
  exit 1
fi

validated_pair_list="$(mktemp)"
trap 'rm -f "$validated_pair_list"' EXIT
chmod 600 "$validated_pair_list"
declare -A seen_nested_controller_ids=()
validated_pair_count=0
while IFS= read -r pair_line || [ -n "$pair_line" ]; do
  IFS=$'\t' read -r config state nested_controller_ids extra_field <<< "$pair_line"
  expected_line="${config:-}"$'\t'"${state:-}"
  if [ -n "${nested_controller_ids:-}" ]; then
    expected_line+=$'\t'"$nested_controller_ids"
  fi
  if [ -n "${extra_field:-}" ] || [ "$pair_line" != "$expected_line" ] || \
    [[ ! "${config:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || \
    [[ ! "${state:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "Modal cleanup pair list is invalid" >&2
    exit 1
  fi
  if [ -n "${nested_controller_ids:-}" ]; then
    IFS=',' read -r -a controller_ids <<< "$nested_controller_ids"
    [ "${#controller_ids[@]}" -gt 0 ] || {
      echo "Modal cleanup nested controller list is invalid" >&2
      exit 1
    }
    for controller_id in "${controller_ids[@]}"; do
      if [[ ! "$controller_id" =~ ^ultrafuzz-[A-Za-z0-9][A-Za-z0-9._-]{0,117}$ ]] || \
        [ -n "${seen_nested_controller_ids[$controller_id]:-}" ]; then
        echo "Modal cleanup nested controller identity is invalid or duplicated" >&2
        exit 1
      fi
      seen_nested_controller_ids["$controller_id"]=true
    done
  fi
  printf '%s\n' "$pair_line" >> "$validated_pair_list"
  validated_pair_count=$((validated_pair_count + 1))
done < "$cleanup_pair_list"
if [ "$validated_pair_count" -eq 0 ]; then
  echo "Modal cleanup pair list is empty" >&2
  exit 1
fi
cleanup_pair_list="$validated_pair_list"

termination_failed=false
terminate_scope() {
  local label="$1"
  shift
  if ! timeout --signal=TERM --kill-after=30s 5m node packages/modal/dist/cli.js "$@"; then
    echo "::warning title=Modal cleanup uncertainty::Could not confirm termination for $label."
    termination_failed=true
  fi
}

if [ "$state_available" = true ]; then
  while IFS=$'\t' read -r _config state _nested_controller_ids; do
    [ -n "$state" ] || continue
    state_path="$benchmark_state/$state"
    if [ -f "$state_path" ] && [ ! -L "$state_path" ] && \
      jq -e '((.launches | type == "array" and length > 0) or (.attempt_history | type == "array" and length > 0))' \
        "$state_path" > /dev/null 2>&1; then
      terminate_scope "persisted state $state" terminate --state "$state_path"
    fi
  done < "$cleanup_pair_list"
fi

image_name="$(jq -er '.image_name' "$benchmark_plan/manifest.json")"
for pass in 1 2; do
  terminate_scope "image build pass $pass" terminate-build \
    --image "$image_name" \
    --build-scope "$build_scope" \
    --repo-root "$candidate_source"
  while IFS=$'\t' read -r config _state; do
    [ -n "$config" ] || continue
    terminate_scope "eval config $config pass $pass" terminate \
      --config "$benchmark_plan/$config" \
      --repo-root "$candidate_source"
  done < "$cleanup_pair_list"
  while IFS=$'\t' read -r config _state nested_controller_ids; do
    [ -n "$nested_controller_ids" ] || continue
    IFS=',' read -r -a controller_ids <<< "$nested_controller_ids"
    for controller_id in "${controller_ids[@]}"; do
      terminate_scope "nested node controller $controller_id from $config pass $pass" cleanup-node-run \
        --app ultrafuzz-evals \
        --image "$image_name" \
        --run-id "$controller_id"
    done
  done < "$cleanup_pair_list"
  if [ "$pass" -eq 1 ]; then
    sleep 20
  fi
done

if [ "$termination_failed" = true ]; then
  exit 1
fi
