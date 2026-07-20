#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "fake target E2E workflow runner: $*" >&2
  exit 64
}

if [ "$#" -lt 2 ]; then
  fail "expected 'up <workflow-path>'"
fi

command_name="$1"
workflow_path="$2"
shift 2

if [ "$command_name" != "up" ]; then
  fail "unsupported command: $command_name"
fi
if [ ! -f "$workflow_path" ]; then
  fail "compiled workflow does not exist: $workflow_path"
fi

detach="false"
supervise="false"
run_id=""
max_concurrency=""
project_root=""
log_dir=""
input_json=""
output_format=""
supervise_interval=""
supervise_stale_threshold=""
supervise_max_concurrent=""

while [ "$#" -gt 0 ]; do
  option="$1"
  shift
  case "$option" in
    --detach)
      detach="true"
      ;;
    --supervise)
      supervise="true"
      ;;
    --run-id | --max-concurrency | --root | --log-dir | --input | --format | \
      --supervise-interval | --supervise-stale-threshold | --supervise-max-concurrent)
      if [ "$#" -eq 0 ]; then
        fail "missing value for $option"
      fi
      value="$1"
      shift
      case "$option" in
        --run-id) run_id="$value" ;;
        --max-concurrency) max_concurrency="$value" ;;
        --root) project_root="$value" ;;
        --log-dir) log_dir="$value" ;;
        --input) input_json="$value" ;;
        --format) output_format="$value" ;;
        --supervise-interval) supervise_interval="$value" ;;
        --supervise-stale-threshold) supervise_stale_threshold="$value" ;;
        --supervise-max-concurrent) supervise_max_concurrent="$value" ;;
      esac
      ;;
    *)
      fail "unsupported argument: $option"
      ;;
  esac
done

if [ "$detach" != "true" ]; then
  fail "submission must use --detach"
fi
if [ "$supervise" != "true" ]; then
  fail "submission must use --supervise"
fi
if [ -z "$run_id" ] || [ -z "$max_concurrency" ] || [ -z "$project_root" ] || \
  [ -z "$log_dir" ] || [ -z "$input_json" ]; then
  fail "submission is missing required run metadata"
fi
if [ "$output_format" != "json" ]; then
  fail "submission must use --format json"
fi
if [ -z "$supervise_interval" ] || [ -z "$supervise_stale_threshold" ] || \
  [ "$supervise_max_concurrent" != "1" ]; then
  fail "submission is missing the bounded supervisor configuration"
fi
if [ ! -d "$project_root" ]; then
  fail "project root does not exist: $project_root"
fi
if [ -z "${SMITHERS_FAKE_LOG:-}" ]; then
  fail "SMITHERS_FAKE_LOG is required"
fi

node - \
  "$SMITHERS_FAKE_LOG" \
  "$workflow_path" \
  "$run_id" \
  "$max_concurrency" \
  "$project_root" \
  "$log_dir" \
  "$output_format" \
  "$supervise_interval" \
  "$supervise_stale_threshold" \
  "$supervise_max_concurrent" \
  "$input_json" <<'NODE'
const fs = require("node:fs");

const [
  logPath,
  workflowPath,
  runId,
  maxConcurrency,
  projectRoot,
  logDir,
  outputFormat,
  superviseInterval,
  superviseStaleThreshold,
  superviseMaxConcurrent,
  inputJson
] = process.argv.slice(2);
const input = JSON.parse(inputJson);
if (input === null || typeof input !== "object" || Array.isArray(input)) {
  throw new Error("workflow input must be a JSON object");
}
if (input.run_id !== runId.replace(/^ultrafuzz-/, "")) {
  throw new Error(`workflow input run_id does not match submission run ID: ${String(input.run_id)}`);
}
if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
  throw new Error("workflow input must contain at least one compiled task");
}
fs.writeFileSync(
  logPath,
  `${JSON.stringify(
    {
      schema_version: "ultrafuzz.target-e2e.submission.v1",
      command: "up",
      workflow_path: workflowPath,
      run_id: runId,
      max_concurrency: Number(maxConcurrency),
      project_root: projectRoot,
      log_dir: logDir,
      format: outputFormat,
      detached: true,
      supervised: true,
      supervise_interval: superviseInterval,
      supervise_stale_threshold: superviseStaleThreshold,
      supervise_max_concurrent: Number(superviseMaxConcurrent),
      input_run_id: input.run_id,
      task_count: input.tasks.length
    },
    null,
    2
  )}\n`,
  "utf8"
);
NODE

printf '%s\n' '{"ok":true,"smithers":"accepted"}'
