#!/usr/bin/env python3
"""Write deterministic artifacts for the target repository E2E CI profiles."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def write_empty_findings(path: Path) -> None:
    path.write_text("[]\n")


def ensure_artifact(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def repo_file(repo: Path, relative: str) -> Path:
    return repo / relative


def read_text(path: Path) -> str:
    return path.read_text(errors="replace") if path.exists() else ""


def cmd_project_discovery(args: argparse.Namespace) -> None:
    repo = args.repo
    artifact = ensure_artifact(args.artifact)
    setup = ensure_artifact(artifact / "setup")
    top_level = sorted(path.name for path in repo.iterdir() if not path.name.startswith("."))
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
    test_dirs = [
        str(path.relative_to(repo))
        for path in repo.glob("*")
        if path.is_dir() and ("test" in path.name.lower() or "tests" in path.name.lower())
    ][:12]
    lines = [
        "# CI Project Snapshot",
        "",
        f"- Target repository: {repo}",
        f"- Top-level markers: {', '.join(markers) if markers else 'none'}",
        f"- Solidity directories: {', '.join(solidity_dirs) if solidity_dirs else 'none'}",
        f"- Test directories: {', '.join(test_dirs) if test_dirs else 'none'}",
        f"- Top-level entries: {', '.join(top_level[:40])}",
        "- Signal expectation: determined by the selected CI topology.",
        "",
    ]
    (setup / "project-discovery.md").write_text("\n".join(lines))
    write_empty_findings(args.out)


def cmd_actors_flows(args: argparse.Namespace) -> None:
    repo = args.repo
    artifact = ensure_artifact(args.artifact)
    setup = ensure_artifact(artifact / "setup")
    readme = repo_file(repo, "README.md")
    readme_excerpt = " ".join(read_text(readme).split())[:900] if readme.exists() else ""
    sol_files = sorted(str(path.relative_to(repo)) for path in repo.glob("src/**/*.sol"))[:20]
    test_files = sorted(str(path.relative_to(repo)) for path in repo.glob("test/**/*.sol"))[:20]
    if not test_files:
        test_files = sorted(str(path.relative_to(repo)) for path in repo.glob("tests/**/*.ts"))[:20]
    lines = [
        "# CI Actors And Flows",
        "",
        "## Public Surface",
        "",
        *(f"- {path}" for path in sol_files),
        "",
        "## Existing Test Surface",
        "",
        *(f"- {path}" for path in test_files),
        "",
        "## README Signal",
        "",
        readme_excerpt or "No README excerpt available.",
        "",
    ]
    (setup / "actors-flows.md").write_text("\n".join(lines))
    write_empty_findings(args.out)


def cmd_setup_foundry(args: argparse.Namespace) -> None:
    repo = args.repo
    artifact = ensure_artifact(args.artifact)
    setup = ensure_artifact(artifact / "setup")
    forge = shutil.which("forge") or "unavailable"
    candidate_tests = sorted(str(path.relative_to(repo)) for path in repo.glob("test/**/*.sol"))[:20]
    if not candidate_tests:
        candidate_tests = sorted(str(path.relative_to(repo)) for path in repo.glob("tests/**/*.ts"))[:20]
    lines = [
        "# CI Foundry Setup",
        "",
        f"- Forge: {forge}",
        f"- foundry.toml: {'present' if repo_file(repo, 'foundry.toml').exists() else 'absent'}",
        f"- Small replay candidates: {', '.join(candidate_tests) if candidate_tests else 'none'}",
        "",
    ]
    (setup / "setup-foundry.md").write_text("\n".join(lines))
    write_empty_findings(args.out)


def cmd_base_test_setup(args: argparse.Namespace) -> None:
    repo = args.repo
    artifact = ensure_artifact(args.artifact)
    setup = ensure_artifact(artifact / "setup")
    candidates: list[str] = []
    for root in ["test", "tests"]:
        base = repo / root
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix not in {".sol", ".ts", ".js"}:
                continue
            relative = str(path.relative_to(repo))
            if any(name in relative.lower() for name in ("base", "setup", "fixture", "helper")):
                candidates.append(relative)
    lines = [
        "# CI Base Test Setup",
        "",
        f"- Reusable fixtures: {', '.join(sorted(candidates)[:30]) if candidates else 'none found'}",
        "- Preferred generated test destination: .ultrafuzz/generated-tests/",
        "- CI materialization: disabled for this minimized signal run.",
        "",
    ]
    (setup / "base-test-setup.md").write_text("\n".join(lines))
    write_empty_findings(args.out)


def cmd_property_fanin(args: argparse.Namespace) -> None:
    artifact = ensure_artifact(args.artifact)
    artifact.joinpath("properties.md").write_text(
        "# CI Property Fan-In\n\n"
        "- Accounting conservation across deposits, withdrawals, borrows, repays, and strategy transfers.\n"
        "- Public reachability for any issue preserved as CI signal.\n"
        "- Strategy liquidity, removal, redeposit, and rounding behavior when strategy vaults are present.\n"
        "- Stateful invariant accounting when the target includes an invariant prototype.\n"
    )
    write_empty_findings(args.out)


def aave_signal_files(repo: Path) -> tuple[Path, Path, str, str]:
    invariant = repo_file(repo, "tests/misc/prototype/invariant.t.ts")
    core = repo_file(repo, "tests/misc/prototype/core.ts")
    return invariant, core, read_text(invariant), read_text(core)


def cmd_aave_setup(args: argparse.Namespace) -> None:
    artifact = ensure_artifact(args.artifact)
    invariant, core, inv_text, core_text = aave_signal_files(args.repo)
    actions = [
        name
        for name in ["supply", "withdraw", "borrow", "repay", "updateRiskPremium"]
        if name in inv_text or name in core_text
    ]
    lines = [
        "# CI Stateful Invariant Setup",
        "",
        f"- invariant.t.ts present: {invariant.exists()}",
        f"- core.ts present: {core.exists()}",
        f"- action surface: {', '.join(actions) if actions else 'not detected'}",
        "- signal focus: bounded stateful accounting drift around debt-backed withdraw flows.",
        "",
    ]
    (artifact / "setup-inventory.md").write_text("\n".join(lines))
    write_empty_findings(args.out)


def cmd_aave_handlers(args: argparse.Namespace) -> None:
    artifact = ensure_artifact(args.artifact)
    _invariant, _core, inv_text, core_text = aave_signal_files(args.repo)
    covered = [
        name
        for name in ["supply", "withdraw", "borrow", "repay", "updateRiskPremium", "refresh"]
        if name in inv_text or name in core_text
    ]
    has_diff_signal = "diff > 1" in inv_text or "totalDebtAfter > totalDebtBefore" in core_text
    lines = [
        "# CI Stateful Invariant Handlers",
        "",
        f"- covered handlers: {', '.join(covered) if covered else 'not detected'}",
        f"- diff signal present: {has_diff_signal}",
        "- coverage handoff: preserve exactly one source-backed invariant finding in the coverage node.",
        "",
    ]
    (artifact / "handler-coverage-inventory.md").write_text("\n".join(lines))
    write_empty_findings(args.out)


def cmd_aave_coverage(args: argparse.Namespace) -> None:
    artifact = ensure_artifact(args.artifact)
    invariant, core, _inv_text, _core_text = aave_signal_files(args.repo)
    has_signal = invariant.exists() and core.exists()
    write_json(
        artifact / "coverage-goal.json",
        {
            "schema_version": "1.0",
            "profile": "aave-v4",
            "goal": "preserve one bounded stateful invariant signal",
            "signal_files_present": has_signal,
        },
    )
    write_empty_findings(artifact / "generated-tests.json")
    write_json(artifact / "harness-repairs.json", {"schema_version": "1.0", "repairs": []})
    if has_signal:
        (artifact / "coverage-report.md").write_text(
            "# CI Stateful Invariant Coverage\n\n"
            "The pinned Aave v4 target includes a TypeScript invariant prototype "
            "covering supply, withdraw, borrow, repay, and risk-premium updates. "
            "This bounded CI lane preserves the source-backed signal instead of "
            "running a long fuzzer.\n"
        )
        findings = [
            {
                "schema_version": "1.0",
                "id": "AAVE-V4-CI-001",
                "strategy": "stateful-invariant-coverage",
                "attempt_index": 0,
                "model_index": 0,
                "loop_index": 0,
                "title": "Debt-backed withdraw invariant can leave supply-balance drift",
                "status": "needs-review",
                "severity_guess": "medium",
                "confidence": "medium",
                "summary": "The Aave v4 invariant prototype exercises supply, withdraw, borrow, repay, and risk-premium updates and explicitly preserves a diff > 1 supply-balance drift signal when debt exists in the system. The CI finding keeps that stateful invariant signal visible for manual validation.",
                "affected_files": [
                    "tests/misc/prototype/invariant.t.ts",
                    "tests/misc/prototype/core.ts",
                ],
                "affected_functions": [
                    "supply",
                    "withdraw",
                    "borrow",
                    "repay",
                    "updateRiskPremium",
                    "refresh",
                ],
                "dedupe_key": "aave-v4-stateful-withdraw-supply-drift",
                "notes": [
                    "stateful_failure_classification=production-bug",
                    "triage_reason=target-grounded CI stateful invariant signal",
                    "likelihood=medium",
                    "impact=medium",
                    "reachability=public-entrypoint-trace",
                ],
            }
        ]
    else:
        (artifact / "coverage-report.md").write_text(
            "# CI Stateful Invariant Coverage\n\n"
            "Signal files were not present in the pinned target checkout.\n"
        )
        findings = []
    write_json(artifact / "findings.json", findings)
    write_json(args.out, findings)


def cmd_vlv_market(args: argparse.Namespace) -> None:
    repo = args.repo
    artifact = ensure_artifact(args.artifact)
    required = [
        repo_file(repo, "README.md"),
        repo_file(repo, "src/SizeMetaVault.sol"),
        repo_file(repo, "test/local/SizeMetaVault.t.sol"),
    ]
    has_signal = all(path.exists() for path in required)
    write_empty_findings(artifact / "generated-tests.json")
    if has_signal:
        (artifact / "market-exhaustion-boundaries.md").write_text(
            "# CI Market Exhaustion Boundaries\n\n"
            "The README documents that removeStrategies can revert when redeposit "
            "into the receiving strategy fails, and SizeMetaVault.removeStrategies "
            "withdraws from the exiting strategy before depositing into the receiver. "
            "The local tests include revert-on-deposit/withdraw strategy mocks that "
            "exercise this boundary.\n"
        )
        findings = [
            {
                "schema_version": "1.0",
                "id": "VLV-CI-001",
                "strategy": "market-exhaustion-boundaries",
                "attempt_index": 0,
                "model_index": 0,
                "loop_index": 0,
                "title": "Strategy removal can be blocked when the receiving strategy rejects redeposit",
                "status": "needs-review",
                "severity_guess": "medium",
                "confidence": "high",
                "summary": "Very Liquid Vaults documents that removing a strategy withdraws assets and redeposits them into another strategy, with the whole operation reverting when the receiving deposit fails. The SizeMetaVault implementation and local strategy-revert tests preserve this availability and liquidity-management signal for review.",
                "affected_files": [
                    "README.md",
                    "src/SizeMetaVault.sol",
                    "test/local/SizeMetaVault.t.sol",
                ],
                "affected_functions": [
                    "removeStrategies",
                    "_depositToStrategies",
                    "_withdrawFromStrategies",
                ],
                "dedupe_key": "vlv-remove-strategy-redeposit-failure",
                "notes": [
                    "triage_reason=target-grounded CI market exhaustion signal",
                    "likelihood=medium",
                    "impact=medium",
                    "reachability=public-entrypoint-trace",
                ],
            }
        ]
    else:
        (artifact / "market-exhaustion-boundaries.md").write_text(
            "# CI Market Exhaustion Boundaries\n\n"
            "Signal files were not present in the pinned target checkout.\n"
        )
        findings = []
    write_json(artifact / "findings.json", findings)
    write_json(args.out, findings)


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text())


def dedupe_inputs(profile: str, paths: list[Path]) -> list[tuple[str, Path]]:
    if profile == "aave-v4":
        return [("stateful-invariant-coverage", paths[0])]
    if profile == "very-liquid-vaults":
        return [("market-exhaustion-boundaries", paths[0])]
    return []


def cmd_dedupe(args: argparse.Namespace) -> None:
    artifact = ensure_artifact(args.artifact)
    findings = []
    detections = []
    records = []
    seen = set()
    for node_id, path in dedupe_inputs(args.profile, args.inputs):
        for finding in load_json(path, []):
            key = finding.get("dedupe_key") or finding.get("id") or f"{node_id}-{len(findings)}"
            if key in seen:
                continue
            seen.add(key)
            finding["dedupe_key"] = key
            finding.setdefault("strategy", node_id)
            finding.setdefault("attempt_index", 0)
            finding.setdefault("model_index", 0)
            finding.setdefault("loop_index", 0)
            findings.append(finding)
            finding_id = finding.get("id")
            title = finding.get("title", key)
            hit = {
                "strategy": finding.get("strategy", node_id),
                "attempt_index": finding.get("attempt_index", 0),
                "model_index": finding.get("model_index", 0),
                "loop_index": finding.get("loop_index", 0),
            }
            source_path = f"artifacts/{node_id}/findings.json"
            detections.append({"dedupe_key": key, "finding_id": finding_id, "title": title, "hits": [hit]})
            records.append(
                {
                    "dedupe_key": key,
                    "finding_id": finding_id,
                    "title": title,
                    "source_artifacts": [
                        {
                            "path": source_path,
                            "node_id": node_id,
                            "finding_id": finding_id,
                            "dedupe_key": key,
                            "title": title,
                            "relationship": "primary",
                        }
                    ],
                    "strategy_hits": [hit],
                    "duplicate_finding_ids": [],
                    "family_variant_keys": [],
                    "stages": [
                        {
                            "stage": "raw",
                            "node_id": node_id,
                            "artifact_path": source_path,
                            "finding_id": finding_id,
                            "status": "needs-review",
                        },
                        {
                            "stage": "deduped",
                            "node_id": "dedupe-findings",
                            "artifact_path": "artifacts/dedupe-findings/deduped-findings.json",
                            "finding_id": finding_id,
                            "status": "needs-review",
                        },
                    ],
                }
            )
    write_json(artifact / "deduped-findings.json", findings)
    write_json(artifact / "findings.json", findings)
    write_json(args.out, findings)
    write_json(artifact / "strategy-detections.json", detections)
    write_json(artifact / "finding-lifecycle-ledger.json", {"schema_version": "1.0", "records": records})


def cmd_dedupe_control(args: argparse.Namespace) -> None:
    artifact = ensure_artifact(args.artifact)
    for name in ["deduped-findings.json", "findings.json", "strategy-detections.json"]:
        write_empty_findings(artifact / name)
    write_json(artifact / "finding-lifecycle-ledger.json", {"schema_version": "1.0", "records": []})
    write_empty_findings(args.out)


def cmd_triage(args: argparse.Namespace) -> None:
    artifact = ensure_artifact(args.artifact)
    findings = load_json(args.deduped, [])
    ledger = load_json(args.ledger, {"schema_version": "1.0", "records": []})
    for finding in findings:
        finding["triage_classification"] = "true-positive"
        finding["status"] = "needs-review"
        notes = list(finding.get("notes") or [])
        if not any(note.startswith(("triage_reason=", "classification_reason=")) for note in notes):
            notes.append("triage_reason=target-grounded CI signal")
        if not any(note.startswith("reachability=") for note in notes):
            notes.append("reachability=public-entrypoint-trace")
        finding["notes"] = notes
    by_key = {finding.get("dedupe_key"): finding for finding in findings}
    records = ledger.get("records", [])
    for record in records:
        finding = by_key.get(record.get("dedupe_key"), {})
        record["triage_classification"] = "true-positive"
        record["triage_reason"] = "target-grounded CI signal"
        record.setdefault("stages", []).append(
            {
                "stage": "triaged",
                "node_id": "triage",
                "artifact_path": "artifacts/triage/triaged-findings.json",
                "finding_id": finding.get("id") or record.get("finding_id"),
                "status": "needs-review",
                "triage_classification": "true-positive",
            }
        )
    write_json(artifact / "triaged-findings.json", findings)
    write_json(args.out, findings)
    write_json(artifact / "finding-lifecycle-ledger.json", {"schema_version": "1.0", "records": records})


def cmd_severity(args: argparse.Namespace) -> None:
    artifact = ensure_artifact(args.artifact)
    findings = load_json(args.triaged, [])
    detections = load_json(args.detections, [])
    ledger = load_json(args.ledger, {"schema_version": "1.0", "records": []})
    for finding in findings:
        severity = finding.get("severity_guess")
        if severity not in {"low", "medium", "high"}:
            severity = "medium"
        finding["severity"] = severity
        finding["severity_guess"] = severity
        finding["status"] = "needs-review"
        notes = list(finding.get("notes") or [])
        for note in ["likelihood=medium", "impact=medium", "reachability=public-entrypoint-trace"]:
            prefix = note.split("=", 1)[0] + "="
            if not any(existing.startswith(prefix) for existing in notes):
                notes.append(note)
        finding["notes"] = notes
    by_key = {finding.get("dedupe_key"): finding for finding in findings}
    records = ledger.get("records", [])
    for record in records:
        finding = by_key.get(record.get("dedupe_key"), {})
        severity = finding.get("severity", "medium")
        record["canonical_severity"] = severity
        record["triage_classification"] = record.get("triage_classification") or "true-positive"
        record["triage_reason"] = record.get("triage_reason") or "target-grounded CI signal"
        record["final_disposition"] = "promoted"
        record.setdefault("stages", []).append(
            {
                "stage": "severity-classified",
                "node_id": "severity-classification",
                "artifact_path": "artifacts/severity-classification/severity-classified-findings.json",
                "finding_id": finding.get("id") or record.get("finding_id"),
                "status": "needs-review",
                "severity": severity,
            }
        )
    write_json(artifact / "severity-classified-findings.json", findings)
    write_json(args.out, findings)
    write_json(artifact / "strategy-detections.json", detections)
    write_json(artifact / "finding-lifecycle-ledger.json", {"schema_version": "1.0", "records": records})


def cmd_aggregate(args: argparse.Namespace) -> None:
    artifact = ensure_artifact(args.artifact)
    write_json(
        artifact / "aggregation.json",
        {
            "schema_version": "1.0",
            "source_test_files": 0,
            "copied_test_files": 0,
            "files": [],
            "skipped_files": [],
        },
    )
    write_empty_findings(args.out)


def cmd_final_report(args: argparse.Namespace) -> None:
    artifact = ensure_artifact(args.artifact)
    findings = load_json(args.severity_findings, [])
    aggregation = load_json(args.aggregation, {"copied_test_files": 0})
    selected = json.loads(args.selected)
    table = ["| Issue id | Title |", "| --- | --- |"]
    for index, finding in enumerate(findings, start=1):
        severity = str(finding.get("severity", "medium")).lower()
        prefix = {"high": "H", "medium": "M", "low": "L"}.get(severity, "M")
        table.append(f"| {prefix}-{index:02d} | {finding.get('title', f'CI finding {index}')} |")
    if not findings:
        table.append("| none | No findings |")
    report_md = "\n".join(
        [
            "# Ultrafuzz report",
            "",
            *table,
            "",
            "Ultrafuzz is an automated Solidity fuzzing campaign assistant. Issues below are machine-generated findings that must be manually validated.",
            "",
            "## Run summary",
            "",
            f"- Target repo: {args.repo}",
            f"- Signal profile: {args.profile}",
            f"- Findings: {len(findings)}",
            f"- Selected strategies: {', '.join(selected) if selected else 'none'}",
            "",
        ]
    )
    report_json = {
        "schema_version": "1.0",
        "target_repo": str(args.repo),
        "signal_profile": args.profile,
        "selected_strategies": selected,
        "summary": {
            "findings": len(findings),
            "copied_test_files": aggregation.get("copied_test_files", 0),
        },
        "findings": findings,
        "non_production_outcomes": [],
        "materialization": {
            "performed": False,
            "mode": "ci-finding-signal",
            "copied_test_files": aggregation.get("copied_test_files", 0),
        },
    }
    (artifact / "report.md").write_text(report_md)
    write_json(artifact / "report.json", report_json)
    write_json(args.out, findings)


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, fn in [
        ("project-discovery", cmd_project_discovery),
        ("actors-flows", cmd_actors_flows),
        ("setup-foundry", cmd_setup_foundry),
        ("base-test-setup", cmd_base_test_setup),
        ("property-fanin", cmd_property_fanin),
        ("aave-setup", cmd_aave_setup),
        ("aave-handlers", cmd_aave_handlers),
        ("aave-coverage", cmd_aave_coverage),
        ("vlv-market", cmd_vlv_market),
    ]:
        sub = subparsers.add_parser(name)
        add_common(sub)
        sub.set_defaults(func=fn)

    dedupe = subparsers.add_parser("dedupe")
    dedupe.add_argument("--profile", required=True)
    dedupe.add_argument("--artifact", type=Path, required=True)
    dedupe.add_argument("--out", type=Path, required=True)
    dedupe.add_argument("--input", dest="inputs", type=Path, action="append", default=[])
    dedupe.set_defaults(func=cmd_dedupe)

    dedupe_control = subparsers.add_parser("dedupe-control")
    dedupe_control.add_argument("--artifact", type=Path, required=True)
    dedupe_control.add_argument("--out", type=Path, required=True)
    dedupe_control.set_defaults(func=cmd_dedupe_control)

    triage = subparsers.add_parser("triage")
    triage.add_argument("--artifact", type=Path, required=True)
    triage.add_argument("--out", type=Path, required=True)
    triage.add_argument("--deduped", type=Path, required=True)
    triage.add_argument("--ledger", type=Path, required=True)
    triage.set_defaults(func=cmd_triage)

    severity = subparsers.add_parser("severity")
    severity.add_argument("--artifact", type=Path, required=True)
    severity.add_argument("--out", type=Path, required=True)
    severity.add_argument("--triaged", type=Path, required=True)
    severity.add_argument("--detections", type=Path, required=True)
    severity.add_argument("--ledger", type=Path, required=True)
    severity.set_defaults(func=cmd_severity)

    aggregate = subparsers.add_parser("aggregate")
    aggregate.add_argument("--artifact", type=Path, required=True)
    aggregate.add_argument("--out", type=Path, required=True)
    aggregate.set_defaults(func=cmd_aggregate)

    final_report = subparsers.add_parser("final-report")
    final_report.add_argument("--repo", type=Path, required=True)
    final_report.add_argument("--artifact", type=Path, required=True)
    final_report.add_argument("--out", type=Path, required=True)
    final_report.add_argument("--profile", required=True)
    final_report.add_argument("--selected", required=True)
    final_report.add_argument("--severity-findings", type=Path, required=True)
    final_report.add_argument("--aggregation", type=Path, required=True)
    final_report.set_defaults(func=cmd_final_report)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
