#!/usr/bin/env python3
"""Write bounded target E2E artifacts for the target E2E CI workflow."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)


def project_discovery(repo: Path, artifact: Path, out: Path) -> None:
    markers = [
        name
        for name in ["foundry.toml", "hardhat.config.ts", "hardhat.config.js", "package.json"]
        if (repo / name).exists()
    ]
    solidity_dirs = [
        str(path.relative_to(repo))
        for path in repo.glob("*")
        if path.is_dir() and any(path.glob("**/*.sol"))
    ][:12]
    vyper_dirs = [
        str(path.relative_to(repo))
        for path in repo.glob("*")
        if path.is_dir() and any(path.glob("**/*.vy"))
    ][:12]
    top_level = sorted(path.name for path in repo.iterdir() if not path.name.startswith("."))[:40]
    write_text(
        artifact / "setup" / "project-discovery.md",
        "\n".join(
            [
                "# CI Project Snapshot",
                "",
                f"- Repository: {repo}",
                f"- Markers: {', '.join(markers) if markers else 'none'}",
                f"- Solidity directories: {', '.join(solidity_dirs) if solidity_dirs else 'none'}",
                f"- Vyper directories: {', '.join(vyper_dirs) if vyper_dirs else 'none'}",
                f"- Top-level entries: {', '.join(top_level) if top_level else 'none'}",
                "",
            ]
        ),
    )
    write_json(out, [])


def signal_analysis(repo: Path, artifact: Path, out: Path) -> None:
    profile = os.environ.get("ULTRAFUZZ_E2E_SIGNAL_PROFILE", "control")
    expected = os.environ.get("ULTRAFUZZ_E2E_EXPECTED_FINDINGS", "any")
    source_files = sorted(
        str(path.relative_to(repo))
        for path in list(repo.glob("**/*.sol")) + list(repo.glob("**/*.vy"))
    )[:30]
    test_files = sorted(
        str(path.relative_to(repo))
        for path in list(repo.glob("test/**/*.sol")) + list(repo.glob("tests/**/*.ts")) + list(repo.glob("tests/**/*.py"))
    )[:30]
    write_text(
        artifact / "signal-analysis.md",
        "\n".join(
            [
                "# CI Signal Analysis",
                "",
                f"- Signal profile: {profile}",
                f"- Source files sampled: {', '.join(source_files) if source_files else 'none'}",
                f"- Test files sampled: {', '.join(test_files) if test_files else 'none'}",
                "- The target E2E profile emits one source-backed CI signal unless the matrix expects eq:0.",
                "",
            ]
        ),
    )
    findings = [] if expected == "eq:0" else [finding(profile, source_files, test_files)]
    write_json(out, findings)
    write_json(
        artifact / "generated-tests.json",
        generated_tests_manifest(artifact),
    )


def generated_tests_manifest(artifact: Path) -> dict[str, object]:
    return {
        "schema_version": "1.0",
        "run_id": infer_run_id(artifact),
        "node_id": infer_node_id(artifact),
        "generated_tests": [],
    }


def infer_run_id(artifact: Path) -> str:
    if artifact.parent.name == "artifacts" and artifact.parent.parent.name:
        return artifact.parent.parent.name
    return "ci-target-e2e"


def infer_node_id(artifact: Path) -> str:
    return artifact.name or "signal-analysis"


def finding(profile: str, source_files: list[str], test_files: list[str]) -> dict[str, object]:
    evidence_path = source_files[0] if source_files else (test_files[0] if test_files else "repository-root")
    title = {
        "aave-v4": "CI signal preserved for Aave v4 stateful invariant surface",
        "very-liquid-vaults": "CI signal preserved for Very Liquid Vaults market boundary surface",
        "stableswap-ng-vyper": "CI signal preserved for StableSwapNG Vyper AMM invariant surface",
    }.get(profile, "CI signal preserved for target repository surface")
    return {
        "schema_version": "1.0",
        "id": f"ci-{profile.replace('_', '-').replace(' ', '-')}-signal-001",
        "title": title,
        "severity_guess": "medium",
        "confidence": "high",
        "status": "needs-review",
        "summary": "Bounded target E2E signal generated from repository structure and selected CI profile.",
        "affected_files": [evidence_path],
        "evidence": [{"kind": "repository-sample", "path": evidence_path}],
        "reproductions": [{"type": "ci-helper", "command": "python3 .ultrafuzz/ci/target-e2e-artifacts.py signal-analysis"}],
        "notes": [
            "impact=Medium",
            "likelihood=Medium",
            "context=CI target signal preservation via deterministic profile",
        ],
    }


def final_report(repo: Path, artifact: Path, out: Path, findings_path: Path | None, run_metadata_path: Path | None) -> None:
    profile = os.environ.get("ULTRAFUZZ_E2E_SIGNAL_PROFILE", "control")
    expected = os.environ.get("ULTRAFUZZ_E2E_EXPECTED_FINDINGS", "any")
    findings = read_findings(findings_path)
    run_metadata = wait_for_report_run_metadata(repo, run_metadata_path)
    report = {
        "schema_version": "ultrafuzz.e2e.report.v1",
        "target_repository": str(repo),
        "signal_profile": profile,
        "expected_findings": expected,
        "finding_count": len(findings),
        "issues": findings,
        "run_metadata": run_metadata,
        "findings": findings,
    }
    write_json(artifact / "report.json", report)
    write_text(
        artifact / "report.md",
        "\n".join(
            [
                "# Target E2E Report",
                "",
                f"- Signal profile: {profile}",
                f"- Expected findings: {expected}",
                f"- Findings: {len(findings)}",
                f"- Tokens used: {run_metadata['tokens_used']}",
                f"- Estimated spend: {run_metadata['estimated_spend']}",
                "",
            ]
        ),
    )
    write_json(out, [])


def read_findings(path: Path | None) -> list[object]:
    if path is None or not path.exists():
        return []
    parsed = json.loads(path.read_text())
    if not isinstance(parsed, list):
        raise SystemExit(f"findings input must be an array: {path}")
    return parsed


def report_run_metadata(path: Path | None) -> dict[str, object]:
    if path is None or not path.exists():
        return {
            "tokens_used": "unavailable",
            "estimated_spend": "unavailable",
            "partial_pricing": False,
            "source_run_ids": [],
        }
    parsed = json.loads(path.read_text())
    accounting = parsed.get("accounting") if isinstance(parsed, dict) else None
    cumulative = accounting.get("cumulative") if isinstance(accounting, dict) else None
    if not isinstance(cumulative, dict):
        return {
            "tokens_used": "unavailable",
            "estimated_spend": "unavailable",
            "partial_pricing": False,
            "source_run_ids": [],
        }
    source_run_ids = cumulative.get("source_run_ids")
    return {
        "tokens_used": str(cumulative.get("tokens_used") or "unavailable"),
        "estimated_spend": str(cumulative.get("estimated_spend") or "unavailable"),
        "partial_pricing": bool(cumulative.get("partial_pricing")),
        "source_run_ids": [value for value in source_run_ids if isinstance(value, str)]
        if isinstance(source_run_ids, list)
        else [],
    }


def wait_for_report_run_metadata(repo: Path, path: Path | None) -> dict[str, object]:
    deadline = time.monotonic() + env_float("ULTRAFUZZ_E2E_METADATA_WAIT_SECONDS", 60.0)
    poll_seconds = max(0.25, env_float("ULTRAFUZZ_E2E_METADATA_POLL_SECONDS", 2.0))
    while True:
        refresh_run_metadata(repo, path)
        run_metadata = report_run_metadata(path)
        if report_run_metadata_available(run_metadata) or time.monotonic() >= deadline:
            return run_metadata
        time.sleep(min(poll_seconds, max(0.0, deadline - time.monotonic())))


def report_run_metadata_available(run_metadata: dict[str, object]) -> bool:
    return is_available_label(run_metadata.get("tokens_used")) and is_available_label(run_metadata.get("estimated_spend"))


def refresh_run_metadata(repo: Path, path: Path | None) -> None:
    if path is None or not path.exists():
        return
    parsed = json.loads(path.read_text())
    if not isinstance(parsed, dict):
        return
    run_id = parsed.get("run_id")
    if not isinstance(run_id, str) or run_id.strip() == "":
        return
    accounting = parsed.get("accounting") if isinstance(parsed, dict) else None
    cumulative = accounting.get("cumulative") if isinstance(accounting, dict) else None
    if (
        isinstance(cumulative, dict)
        and is_available_label(cumulative.get("tokens_used"))
        and is_available_label(cumulative.get("estimated_spend"))
    ):
        return
    ultrafuzz_bin = os.environ.get("ULTRAFUZZ_BIN", "ultrafuzz")
    try:
        subprocess.run(
            [ultrafuzz_bin, "inspect", run_id, "--project", str(repo), "--json"],
            cwd=repo,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return max(0.0, float(raw))
    except ValueError:
        return default


def is_available_label(value: object) -> bool:
    return isinstance(value, str) and value.strip() != "" and value.strip().lower() != "unavailable"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["project-discovery", "signal-analysis", "final-report"])
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--findings", type=Path)
    parser.add_argument("--run-metadata", type=Path)
    args = parser.parse_args()
    args.artifact.mkdir(parents=True, exist_ok=True)
    if args.mode == "project-discovery":
        project_discovery(args.repo.resolve(), args.artifact.resolve(), args.out.resolve())
    elif args.mode == "signal-analysis":
        signal_analysis(args.repo.resolve(), args.artifact.resolve(), args.out.resolve())
    else:
        final_report(args.repo.resolve(), args.artifact.resolve(), args.out.resolve(), args.findings, args.run_metadata)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
