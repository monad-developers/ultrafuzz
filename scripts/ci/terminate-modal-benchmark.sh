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
  while IFS=$'\t' read -r _config state; do
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
  if [ "$pass" -eq 1 ]; then
    sleep 20
  fi
done

if [ "$termination_failed" = true ]; then
  exit 1
fi
