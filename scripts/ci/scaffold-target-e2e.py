#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


RENDERED_FIXTURE_FILES = {
    "ultrafuzz.toml": "ultrafuzz.toml",
    ".ultrafuzz/topology.yml": ".ultrafuzz/topology.yml",
    ".ultrafuzz/prompts/setup/project-discovery.md": ".ultrafuzz/prompts/setup/project-discovery.md",
    ".ultrafuzz/prompts/strategies/signal-analysis.md": ".ultrafuzz/prompts/strategies/signal-analysis.md",
    ".ultrafuzz/prompts/review/final-report.md": ".ultrafuzz/prompts/review/final-report.md",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scaffold the deterministic target E2E fixture into a cloned target repository.")
    parser.add_argument("target_root", type=Path)
    parser.add_argument("--node-timeout", type=int, default=int(os.environ.get("ULTRAFUZZ_E2E_NODE_TIMEOUT_SECONDS", "420")))
    parser.add_argument("--agent-ref", default=os.environ.get("ULTRAFUZZ_E2E_AGENT", "CodexAgent"))
    parser.add_argument("--model-name", default=os.environ.get("ULTRAFUZZ_E2E_MODEL", "gpt-5.5"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    script_dir = Path(__file__).resolve().parent
    fixture_dir = script_dir / "target-e2e-fixture"
    artifact_helper = script_dir / "target-e2e-artifacts.py"

    if not args.target_root.is_dir():
        raise SystemExit(f"Target repository root does not exist: {args.target_root}")
    if not fixture_dir.is_dir():
        raise SystemExit(f"CI fixture directory not found: {fixture_dir}")
    if not artifact_helper.is_file():
        raise SystemExit(f"CI artifact helper not found: {artifact_helper}")

    values = {
        "__NODE_TIMEOUT__": str(args.node_timeout),
        "__AGENT_REF__": args.agent_ref,
        "__MODEL_NAME__": args.model_name,
    }

    ci_dir = args.target_root / ".ultrafuzz" / "ci"
    ci_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(artifact_helper, ci_dir / "target-e2e-artifacts.py")

    for source_name, destination_name in RENDERED_FIXTURE_FILES.items():
        source = fixture_dir / source_name
        destination = args.target_root / destination_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        text = source.read_text(encoding="utf-8")
        for placeholder, replacement in values.items():
            text = text.replace(placeholder, replacement)
        destination.write_text(text, encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
