#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 7 ]; then
  echo "usage: watch-modal-benchmark.sh <control-root> <repo-root> <candidate> <repository> <generation> <smoke|full> <handoff-remaining-seconds|0>" >&2
  exit 2
fi

benchmark_control="$1"
repo_root="$2"
candidate_commit="$3"
repository="$4"
generation="$5"
benchmark_mode="$6"
handoff_remaining_seconds="$7"
manifest="$benchmark_control/manifest.json"
window="$benchmark_control/control-window.json"

if [[ ! "$handoff_remaining_seconds" =~ ^[0-9]+$ ]]; then
  echo "handoff remaining seconds must be a non-negative integer" >&2
  exit 2
fi

absolute_deadline="$(node "$repo_root/scripts/ci/modal-benchmark-control-window.mjs" \
  deadline "$manifest" "$window" "$candidate_commit" "$repository" "$generation" "$benchmark_mode")"
if [[ ! "$absolute_deadline" =~ ^[1-9][0-9]*$ ]]; then
  echo "absolute Modal control deadline is invalid" >&2
  exit 1
fi

phase_deadline=0
if [ "$handoff_remaining_seconds" -gt 0 ]; then
  control_timeout_seconds="$(jq -er \
    '.control_timeout_seconds | select(type == "number" and . == floor and . >= 300)' \
    "$manifest")"
  if [ "$handoff_remaining_seconds" -ge "$control_timeout_seconds" ]; then
    echo "handoff reserve must be smaller than the absolute control window" >&2
    exit 1
  fi
  phase_deadline=$((absolute_deadline - handoff_remaining_seconds))
fi

# Reserve the timeout process's TERM-to-KILL grace inside the active boundary.
# No status or recovery command may start unless its timeout plus this grace
# fits before the phase handoff (monitor job) or absolute deadline (final job).
operation_kill_grace_seconds=30
active_deadline="$absolute_deadline"
if [ "$phase_deadline" -gt 0 ]; then
  active_deadline="$phase_deadline"
fi

operation_timeout_seconds() {
  local maximum_seconds="$1"
  local now_epoch remaining_seconds
  now_epoch="$(date +%s)"
  remaining_seconds=$((active_deadline - now_epoch - operation_kill_grace_seconds))
  if [ "$remaining_seconds" -lt 1 ]; then
    return 1
  fi
  if [ "$remaining_seconds" -gt "$maximum_seconds" ]; then
    remaining_seconds="$maximum_seconds"
  fi
  printf '%s\n' "$remaining_seconds"
}

finish_active_boundary() {
  if [ "$phase_deadline" -gt 0 ]; then
    echo "Handing off live Modal compute with at least ${handoff_remaining_seconds} seconds left in the absolute control window."
    return
  fi
  echo "Modal benchmark matrix exceeded its absolute control-plane deadline" >&2
  while IFS=$'\t' read -r pair; do
    local outcome_file="$benchmark_control/outcomes/$pair.json"
    if [ ! -f "$outcome_file" ]; then
      jq -n \
        --arg pair "$pair" \
        --arg category "control-plane-timeout" \
        '{pair: $pair, terminal_status: "failed", category: $category}' \
        > "$outcome_file"
    fi
  done < <(jq -r '.pairs[] | [.pair] | @tsv' "$manifest")
}

# A TERM/KILL timeout cannot run the launch process's finally blocks. Remove
# only the lock and atomic-write temporary files whose exact state basename is
# authorized by the validated manifest. Any other file remains for the strict
# handoff allowlist to reject.
cleanup_state_transients() {
  local state state_path lock_path temporary temporary_name prefix middle pid_part random_part
  shopt -s nullglob
  while IFS=$'\t' read -r state; do
    if [[ ! "$state" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
      echo "Modal benchmark manifest contains an unsafe state path" >&2
      return 1
    fi
    state_path="$benchmark_control/$state"
    lock_path="$state_path.lock"
    if [ -e "$lock_path" ] || [ -L "$lock_path" ]; then
      if [ -L "$lock_path" ] || [ ! -f "$lock_path" ]; then
        echo "Modal launch state lock is not a regular file: $state.lock" >&2
        return 1
      fi
      rm -f -- "$lock_path"
    fi

    prefix=".$state."
    for temporary in "$benchmark_control"/."$state".*.tmp; do
      temporary_name="${temporary##*/}"
      middle="${temporary_name#"$prefix"}"
      middle="${middle%.tmp}"
      pid_part="${middle%%.*}"
      random_part="${middle#*.}"
      if [ "$pid_part" = "$middle" ] || \
         [[ ! "$pid_part" =~ ^[1-9][0-9]*$ ]] || \
         [[ ! "$random_part" =~ ^[0-9a-f]{24}$ ]]; then
        continue
      fi
      if [ -L "$temporary" ] || [ ! -f "$temporary" ]; then
        echo "Modal launch state temporary is not a regular file: $temporary_name" >&2
        return 1
      fi
      rm -f -- "$temporary"
    done
  done < <(jq -r '.pairs[] | [.state_path] | @tsv' "$manifest")
}

mkdir -p \
  "$benchmark_control/diagnostics" \
  "$benchmark_control/failures" \
  "$benchmark_control/outcomes"
cleanup_state_transients

while true; do
  if ! operation_timeout_seconds 1 > /dev/null; then
    finish_active_boundary
    break
  fi
  all_terminal=true
  boundary_reached=false
  while IFS=$'\t' read -r config state pair; do
    if ! operation_timeout_seconds 1 > /dev/null; then
      all_terminal=false
      boundary_reached=true
      break
    fi
    outcome_file="$benchmark_control/outcomes/$pair.json"
    if [ -f "$outcome_file" ]; then
      continue
    fi

    initial_outcome=unknown
    if [ -f "$benchmark_control/launch-attempts.jsonl" ]; then
      initial_outcome="$(jq -r --arg pair "$pair" 'select(.pair == $pair) | .outcome' \
        "$benchmark_control/launch-attempts.jsonl" | tail -n 1)"
    fi
    recovery_mode=
    if [ ! -f "$benchmark_control/$state" ]; then
      recovery_mode=fresh
    elif jq -e '.launches | type == "array" and length == 0' \
      "$benchmark_control/$state" > /dev/null 2>&1; then
      recovery_mode=resume
    fi
    recovery_category=
    if [ "$initial_outcome" = failed ] && [ -n "$recovery_mode" ]; then
      recovery_exit=0
      if [ ! -f "$benchmark_control/$config" ]; then
        recovery_exit=66
      else
        if ! recovery_timeout_seconds="$(operation_timeout_seconds 300)"; then
          all_terminal=false
          boundary_reached=true
          break
        fi
        timeout --signal=TERM --kill-after=30s "${recovery_timeout_seconds}s" \
          node "$repo_root/packages/modal/dist/cli.js" launch \
          --config "$benchmark_control/$config" \
          --state "$benchmark_control/$state" \
          --mode "$recovery_mode" \
          --repo-root "$repo_root" || recovery_exit=$?
        cleanup_state_transients
      fi
      recovery_category=initial-launch-recovery-failed
      if [ "$recovery_exit" -eq 0 ]; then
        recovery_category=initial-launch-recovery-succeeded
      elif [ "$recovery_exit" -eq 124 ] || [ "$recovery_exit" -eq 137 ]; then
        recovery_category=initial-launch-recovery-timeout
      fi
      # The absolute deadline is deliberately not extended here. Recovery is
      # part of the one manifest-derived control window, including across jobs.
      jq -n \
        --arg pair "$pair" \
        --arg mode "$recovery_mode" \
        --arg category "$recovery_category" \
        --argjson exit_code "$recovery_exit" \
        '{pair: $pair, mode: $mode, category: $category, exit_code: $exit_code}' \
        > "$benchmark_control/diagnostics/$pair.initial-launch-recovery.json"
      if ! operation_timeout_seconds 1 > /dev/null; then
        all_terminal=false
        boundary_reached=true
        break
      fi
    fi
    if [ ! -f "$benchmark_control/$state" ]; then
      category=launch-state-missing
      if [ "$recovery_category" = initial-launch-recovery-succeeded ]; then
        category=initial-launch-recovery-incomplete
      elif [ -n "$recovery_category" ]; then
        category="$recovery_category"
      fi
      jq -n \
        --arg pair "$pair" \
        --arg category "$category" \
        '{pair: $pair, terminal_status: "failed", category: $category}' \
        > "$outcome_file"
      continue
    fi
    if jq -e '.launches | type == "array" and length == 0' \
      "$benchmark_control/$state" > /dev/null 2>&1; then
      category=launch-state-empty
      if [ "$recovery_category" = initial-launch-recovery-succeeded ]; then
        category=initial-launch-recovery-incomplete
      elif [ -n "$recovery_category" ]; then
        category="$recovery_category"
      fi
      jq -n \
        --arg pair "$pair" \
        --arg category "$category" \
        '{pair: $pair, terminal_status: "failed", category: $category}' \
        > "$outcome_file"
      continue
    fi

    status_file="$benchmark_control/$pair.status.json"
    status_exit=0
    if ! status_timeout_seconds="$(operation_timeout_seconds 30)"; then
      all_terminal=false
      boundary_reached=true
      break
    fi
    timeout --signal=TERM --kill-after=30s "${status_timeout_seconds}s" \
      node "$repo_root/packages/modal/dist/cli.js" status \
      --state "$benchmark_control/$state" \
      > "$status_file.tmp" || status_exit=$?
    if [ "$status_exit" -ne 0 ]; then
      rm -f "$status_file.tmp"
      all_terminal=false
      status_category=status-query-failed
      if [ "$status_exit" -eq 124 ] || [ "$status_exit" -eq 137 ]; then
        status_category=status-query-timeout
      fi
      jq -n \
        --arg pair "$pair" \
        --arg category "$status_category" \
        '{pair: $pair, category: $category}' \
        > "$benchmark_control/diagnostics/$pair.$status_category.json"
      if ! operation_timeout_seconds 1 > /dev/null; then
        boundary_reached=true
        break
      fi
      continue
    fi
    mv "$status_file.tmp" "$status_file"
    if ! category="$(jq -er '.[0].runner_status.category' "$status_file")"; then
      jq -n \
        --arg pair "$pair" \
        --arg category "runner-status-invalid" \
        '{pair: $pair, terminal_status: "failed", category: $category}' \
        > "$outcome_file"
      continue
    fi
    case "$category" in
      succeeded)
        jq -n \
          --arg pair "$pair" \
          --arg category "$category" \
          '{pair: $pair, terminal_status: "succeeded", category: $category}' \
          > "$outcome_file"
        ;;
      live)
        all_terminal=false
        ;;
      transient-operational-failure)
        all_terminal=false
        if [ ! -f "$benchmark_control/$config" ]; then
          jq -n \
            --arg pair "$pair" \
            --arg category "launch-config-missing" \
            '{pair: $pair, terminal_status: "failed", category: $category}' \
            > "$outcome_file"
        else
          resume_exit=0
          if ! resume_timeout_seconds="$(operation_timeout_seconds 300)"; then
            boundary_reached=true
            break
          fi
          timeout --signal=TERM --kill-after=30s "${resume_timeout_seconds}s" \
            node "$repo_root/packages/modal/dist/cli.js" launch \
            --config "$benchmark_control/$config" \
            --state "$benchmark_control/$state" \
            --mode resume \
            --repo-root "$repo_root" || resume_exit=$?
          cleanup_state_transients
          if [ "$resume_exit" -ne 0 ]; then
            resume_category=resume-attempt-failed
            if [ "$resume_exit" -eq 124 ] || [ "$resume_exit" -eq 137 ]; then
              resume_category=resume-attempt-timeout
            fi
            jq -n \
              --arg pair "$pair" \
              --arg category "$resume_category" \
              --argjson exit_code "$resume_exit" \
              '{pair: $pair, category: $category, exit_code: $exit_code}' \
              > "$benchmark_control/diagnostics/$pair.$resume_category.json"
          fi
          if ! operation_timeout_seconds 1 > /dev/null; then
            boundary_reached=true
            break
          fi
          # Successful or reserved recovery still consumes the same absolute
          # deadline; never replace it with now + control_timeout_seconds.
        fi
        ;;
      *)
        echo "Modal pair $pair ended as $category" >&2
        jq -n \
          --arg pair "$pair" \
          --arg category "$category" \
          '{pair: $pair, terminal_status: "failed", category: $category}' \
          > "$outcome_file"
        ;;
    esac
  done < <(jq -r '.pairs[] | [.config_path, .state_path, .pair] | @tsv' "$manifest")

  if [ "$all_terminal" = true ]; then
    break
  fi
  if [ "$boundary_reached" = true ]; then
    finish_active_boundary
    break
  fi
  if ! operation_timeout_seconds 1 > /dev/null; then
    finish_active_boundary
    break
  fi
  now_epoch="$(date +%s)"
  sleep_seconds=$((active_deadline - now_epoch - operation_kill_grace_seconds))
  if [ "$sleep_seconds" -gt 60 ]; then
    sleep_seconds=60
  elif [ "$sleep_seconds" -lt 1 ]; then
    sleep_seconds=1
  fi
  sleep "$sleep_seconds"
done
