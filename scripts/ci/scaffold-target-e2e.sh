#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <target-repository-root> [ultrafuzz-binary]" >&2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi

target_root="$1"
ultrafuzz_bin="${2:-${ULTRAFUZZ_BIN:-ultrafuzz}}"
strategy_loops="${ULTRAFUZZ_E2E_STRATEGY_LOOPS:-1}"
invariant_timeout="${ULTRAFUZZ_E2E_INVARIANT_TIMEOUT:-2min}"
node_timeout="${ULTRAFUZZ_E2E_NODE_TIMEOUT_SECONDS:-360}"
signal_profile="${ULTRAFUZZ_E2E_SIGNAL_PROFILE:-control}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
artifact_helper="$script_dir/target-e2e-artifacts.py"

if [ ! -d "$target_root" ]; then
  echo "Target repository root does not exist: $target_root" >&2
  exit 1
fi
if [ ! -x "$ultrafuzz_bin" ] && ! command -v "$ultrafuzz_bin" >/dev/null 2>&1; then
  echo "Ultrafuzz binary not found or not executable: $ultrafuzz_bin" >&2
  exit 1
fi
if [ ! -f "$artifact_helper" ]; then
  echo "CI artifact helper not found: $artifact_helper" >&2
  exit 1
fi

case "$signal_profile" in
  control | smoke | uniswap-v2)
    signal_profile="control"
    topology_file="$script_dir/target-e2e-topology.yml"
    ;;
  aave-v4)
    topology_file="$script_dir/target-e2e-topology-aave-v4.yml"
    ;;
  very-liquid-vaults | vlv)
    signal_profile="very-liquid-vaults"
    topology_file="$script_dir/target-e2e-topology-very-liquid-vaults.yml"
    ;;
  *)
    echo "Unknown ULTRAFUZZ_E2E_SIGNAL_PROFILE: $signal_profile" >&2
    exit 2
    ;;
esac

(
  cd "$target_root"
  "$ultrafuzz_bin" init --force --strategy-loops "$strategy_loops" >/dev/null
)

mkdir -p \
  "$target_root/.ultrafuzz/ci" \
  "$target_root/.ultrafuzz/prompts/setup" \
  "$target_root/.ultrafuzz/prompts/properties" \
  "$target_root/.ultrafuzz/prompts/strategies/invariants" \
  "$target_root/.ultrafuzz/prompts/strategies" \
  "$target_root/.ultrafuzz/prompts/review"

install -m 0644 "$artifact_helper" "$target_root/.ultrafuzz/ci/target-e2e-artifacts.py"
install -m 0644 "$topology_file" "$target_root/.ultrafuzz/topology.yml"

cat > "$target_root/ultrafuzz.toml" <<TOML
schema_version = "1.0"
dynamic_strategies_enumerator = 1

[project]
repo = "."

[run]
output_dir = ".ultrafuzz/runs"
max_parallel_agents = 1
max_parallel_nodes = 2
keep_workspaces = false
workspace_mode = "git-worktree"
default_timeout_seconds = $node_timeout
enable_dashboard = false

[backend]
default = "codex-cli"

[backend.codex_cli]
command = "codex"
auth_mode = "api-key"
use_project_config = false
args = ["exec"]

[backend.codex_cli.env]

[permissions]
# Live Codex target E2E uses the regular workspace-write sandbox. The workflow
# installs the Linux sandbox runtime before running this target-local config.
sandbox = "workspace-write"
sandbox_required = true
allow_dangerous_bypass = false

[invariants]
property_priority_threshold = "high"
invariant_testing_fuzzer_timeout = "$invariant_timeout"

[triage]
quorum = 1
panel_size = 1

[dashboard]
enabled = false
open_browser = false
live_updates = false
TOML

cat > "$target_root/.ultrafuzz/prompts/setup/project-discovery.md" <<'MD'
---
id: project-discovery
display_name: CI Project Snapshot
---

# CI Project Snapshot

The helper performs the bounded repository scan for Solidity framework markers,
source/test directories, and pinned target identity.

Write:

- {{artifact_path}}/setup/project-discovery.md
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" project-discovery --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD

cat > "$target_root/.ultrafuzz/prompts/setup/actors-flows.md" <<'MD'
---
id: actors-flows
display_name: CI Actors And Flows
---

# CI Actors And Flows

Use the project snapshot:
{{artifact_path:project-discovery}}/setup/project-discovery.md

The helper reads only bounded public interface, README, and test snippets.

Write:

- {{artifact_path}}/setup/actors-flows.md
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" actors-flows --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD

cat > "$target_root/.ultrafuzz/prompts/setup/prepare-foundry-harness.md" <<'MD'
---
id: setup-foundry
display_name: CI Foundry Setup
---

# CI Foundry Setup

Use:
{{artifact_path:project-discovery}}/setup/project-discovery.md
{{artifact_path:actors-flows}}/setup/actors-flows.md

The helper resolves the Foundry binary and reads `foundry.toml` when present.

Write:

- {{artifact_path}}/setup/setup-foundry.md
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" setup-foundry --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD

cat > "$target_root/.ultrafuzz/prompts/setup/discover-base-test.md" <<'MD'
---
id: base-test-setup
display_name: CI Base Test Setup
---

# CI Base Test Setup

Use:
{{artifact_path:setup-foundry}}/setup/setup-foundry.md

The helper scans existing base test fixtures with bounded file searches.

Write:

- {{artifact_path}}/setup/base-test-setup.md
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" base-test-setup --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD

cat > "$target_root/.ultrafuzz/prompts/properties/property-specification-fanin.md" <<'MD'
---
id: property-specification-fanin
display_name: CI Property Fan-In
---

# CI Property Fan-In

Use:
{{artifact_path:project-discovery}}/setup/project-discovery.md
{{artifact_path:actors-flows}}/setup/actors-flows.md
{{artifact_path:base-test-setup}}/setup/base-test-setup.md

Write:

- {{artifact_path}}/properties.md
- {{output_findings_path}}

The helper writes the small CI property catalog for accounting conservation,
public reachability, and strategy liquidity or invariant accounting where the
target source makes that relevant.

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" property-fanin --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD

write_aave_strategy_prompts() {
  cat > "$target_root/.ultrafuzz/prompts/strategies/invariants/setup.md" <<'MD'
---
id: stateful-invariant-setup
display_name: CI Stateful Invariant Setup
---

# CI Stateful Invariant Setup

Use:
{{artifact_path:property-specification-fanin}}/properties.md

The helper reads the pinned Aave v4 invariant prototype files:

- {{repo_path}}/tests/misc/prototype/invariant.t.ts
- {{repo_path}}/tests/misc/prototype/core.ts

Write:

- {{artifact_path}}/setup-inventory.md
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" aave-setup --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD

  cat > "$target_root/.ultrafuzz/prompts/strategies/invariants/handlers.md" <<'MD'
---
id: stateful-invariant-handlers
display_name: CI Stateful Invariant Handlers
---

# CI Stateful Invariant Handlers

Use:
{{artifact_path:stateful-invariant-setup}}/setup-inventory.md

The helper reads the action list in `tests/misc/prototype/invariant.t.ts` and
the user methods in `tests/misc/prototype/core.ts`.

Write:

- {{artifact_path}}/handler-coverage-inventory.md
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" aave-handlers --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD

  cat > "$target_root/.ultrafuzz/prompts/strategies/invariants/coverage.md" <<'MD'
---
id: stateful-invariant-coverage
display_name: CI Stateful Invariant Coverage
---

# CI Stateful Invariant Coverage

Use:
{{artifact_path:stateful-invariant-handlers}}/handler-coverage-inventory.md

This CI lane is intentionally small: the helper preserves one target-grounded
Aave v4 stateful invariant signal without running a long fuzzer. It reads:

- {{repo_path}}/tests/misc/prototype/invariant.t.ts
- {{repo_path}}/tests/misc/prototype/core.ts

Write:

- {{artifact_path}}/coverage-goal.json
- {{artifact_path}}/coverage-report.md
- {{artifact_path}}/generated-tests.json
- {{artifact_path}}/harness-repairs.json
- {{artifact_path}}/findings.json
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" aave-coverage --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD
}

write_vlv_strategy_prompts() {
  cat > "$target_root/.ultrafuzz/prompts/strategies/market-exhaustion-boundaries.md" <<'MD'
---
id: market-exhaustion-boundaries
display_name: CI Market Exhaustion Boundaries
---

# CI Market Exhaustion Boundaries

Use:
{{artifact_path:property-specification-fanin}}/properties.md

This CI lane should preserve one target-grounded finding about strategy
liquidity/removal failure. The helper reads:

- {{repo_path}}/README.md
- {{repo_path}}/src/SizeMetaVault.sol
- {{repo_path}}/test/local/SizeMetaVault.t.sol

Write:

- {{artifact_path}}/market-exhaustion-boundaries.md
- {{artifact_path}}/generated-tests.json
- {{artifact_path}}/findings.json
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" vlv-market --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD
}

write_dedupe_prompt() {
  local prompt="$target_root/.ultrafuzz/prompts/review/dedupe-findings.md"
  case "$signal_profile" in
    aave-v4)
      cat > "$prompt" <<'MD'
---
id: dedupe-findings
display_name: CI Dedupe Findings
---

# CI Dedupe Findings

Input strategy findings:

- stateful-invariant-coverage: {{artifact_path:stateful-invariant-coverage}}/findings.json

Write:

- {{artifact_path}}/deduped-findings.json
- {{artifact_path}}/findings.json
- {{artifact_path}}/strategy-detections.json
- {{artifact_path}}/finding-lifecycle-ledger.json
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" dedupe --profile aave-v4 --artifact "{{artifact_path}}" --out "{{output_findings_path}}" --input "{{artifact_path:stateful-invariant-coverage}}/findings.json"
```

Do not include secrets or environment variable values.
MD
      ;;
    very-liquid-vaults)
      cat > "$prompt" <<'MD'
---
id: dedupe-findings
display_name: CI Dedupe Findings
---

# CI Dedupe Findings

Input strategy findings:

- market-exhaustion-boundaries: {{artifact_path:market-exhaustion-boundaries}}/findings.json

Write:

- {{artifact_path}}/deduped-findings.json
- {{artifact_path}}/findings.json
- {{artifact_path}}/strategy-detections.json
- {{artifact_path}}/finding-lifecycle-ledger.json
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" dedupe --profile very-liquid-vaults --artifact "{{artifact_path}}" --out "{{output_findings_path}}" --input "{{artifact_path:market-exhaustion-boundaries}}/findings.json"
```

Do not include secrets or environment variable values.
MD
      ;;
    *)
      cat > "$prompt" <<'MD'
---
id: dedupe-findings
display_name: CI Dedupe Findings
---

# CI Dedupe Findings

This control profile has no strategy finding inputs.

Write:

- {{artifact_path}}/deduped-findings.json
- {{artifact_path}}/findings.json
- {{artifact_path}}/strategy-detections.json
- {{artifact_path}}/finding-lifecycle-ledger.json
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" dedupe-control --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD
      ;;
  esac
}

cat > "$target_root/.ultrafuzz/prompts/review/triage.md" <<'MD'
---
id: triage
display_name: CI Triage
---

# CI Triage

Use:
{{artifact_path:dedupe-findings}}/deduped-findings.json
{{artifact_path:dedupe-findings}}/finding-lifecycle-ledger.json

Write:

- {{artifact_path}}/triaged-findings.json
- {{artifact_path}}/finding-lifecycle-ledger.json
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" triage --artifact "{{artifact_path}}" --out "{{output_findings_path}}" --deduped "{{artifact_path:dedupe-findings}}/deduped-findings.json" --ledger "{{artifact_path:dedupe-findings}}/finding-lifecycle-ledger.json"
```

Do not include secrets or environment variable values.
MD

cat > "$target_root/.ultrafuzz/prompts/review/severity-classification.md" <<'MD'
---
id: severity-classification
display_name: CI Severity Classification
---

# CI Severity Classification

Use:
{{artifact_path:triage}}/triaged-findings.json
{{artifact_path:dedupe-findings}}/strategy-detections.json
{{artifact_path:triage}}/finding-lifecycle-ledger.json

Write:

- {{artifact_path}}/severity-classified-findings.json
- {{artifact_path}}/strategy-detections.json
- {{artifact_path}}/finding-lifecycle-ledger.json
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" severity --artifact "{{artifact_path}}" --out "{{output_findings_path}}" --triaged "{{artifact_path:triage}}/triaged-findings.json" --detections "{{artifact_path:dedupe-findings}}/strategy-detections.json" --ledger "{{artifact_path:triage}}/finding-lifecycle-ledger.json"
```

Do not include secrets or environment variable values.
MD

cat > "$target_root/.ultrafuzz/prompts/review/aggregate-test-files.md" <<'MD'
---
id: aggregate-test-files
display_name: CI Aggregate Test Files
---

# CI Aggregate Test Files

Use:
{{artifact_path:severity-classification}}/severity-classified-findings.json

This small CI signal run does not materialize generated tests into the target
repository.

Write:

- {{artifact_path}}/aggregation.json
- {{output_findings_path}}

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" aggregate --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```

Do not include secrets or environment variable values.
MD

write_final_report_prompt() {
  local prompt="$target_root/.ultrafuzz/prompts/review/final-report.md"
  local selected
  case "$signal_profile" in
    aave-v4)
      selected='["stateful-invariant-setup","stateful-invariant-handlers","stateful-invariant-coverage"]'
      ;;
    very-liquid-vaults)
      selected='["market-exhaustion-boundaries"]'
      ;;
    *)
      selected='[]'
      ;;
  esac
  cat > "$prompt" <<MD
---
id: final-report
display_name: CI Final Report
---

# CI Final Report

Use:
{{artifact_path:aggregate-test-files}}/aggregation.json
{{artifact_path:severity-classification}}/severity-classified-findings.json
{{artifact_path:severity-classification}}/strategy-detections.json
{{artifact_path:severity-classification}}/finding-lifecycle-ledger.json
{{artifact_path:dedupe-findings}}/deduped-findings.json
{{artifact_path:project-discovery}}/setup/project-discovery.md
{{artifact_path:setup-foundry}}/setup/setup-foundry.md
{{artifact_path:base-test-setup}}/setup/base-test-setup.md

Write:

- {{artifact_path}}/report.md
- {{artifact_path}}/report.json
- {{output_findings_path}}

Read severity-classified findings and write them unchanged as the
\`report.json.findings\` array. The selected strategy list must be:

\`\`\`json
$selected
\`\`\`

\`report.json\` must include \`schema_version: "1.0"\`,
\`signal_profile: "$signal_profile"\`, the selected strategies above, a
\`findings\` array, \`non_production_outcomes: []\`, and
\`materialization.performed: false\`.

Run exactly this command and then stop. Do not perform manual analysis, run extra commands, install dependencies, or edit production files; the helper performs the bounded target inspection and writes all required artifacts:

\`\`\`bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" final-report --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}" --profile "$signal_profile" --selected '$selected' --severity-findings "{{artifact_path:severity-classification}}/severity-classified-findings.json" --aggregation "{{artifact_path:aggregate-test-files}}/aggregation.json"
\`\`\`

Do not include secrets or environment variable values.
MD
}

case "$signal_profile" in
  aave-v4)
    write_aave_strategy_prompts
    ;;
  very-liquid-vaults)
    write_vlv_strategy_prompts
    ;;
esac
write_dedupe_prompt
write_final_report_prompt
