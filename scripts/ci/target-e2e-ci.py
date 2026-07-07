#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


FAILED_STATUSES = {"failed", "cancelled", "canceled", "timed_out", "timeout", "error"}


def redact(path: Path) -> None:
    secret = os.environ.get("OPENAI_API_KEY", "").encode()
    if not secret or not path.exists():
        return
    path.write_bytes(path.read_bytes().replace(secret, b"[REDACTED_OPENAI_API_KEY]"))


def load_json(path: Path) -> dict[str, Any]:
    body = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(body, dict):
        raise SystemExit(f"Expected JSON object in {path}")
    return body


def assert_cli_ok(path: Path, label: str) -> None:
    body = load_json(path)
    if body.get("ok") is not True:
        diagnostics = body.get("diagnostics")
        raise SystemExit(f"{label} returned ok=false: {json.dumps(diagnostics, indent=2)}")


def assert_inspect_healthy(path: Path) -> None:
    body = load_json(path)
    diagnostics = body.get("diagnostics") or []
    blocking = [
        diagnostic
        for diagnostic in diagnostics
        if isinstance(diagnostic, dict) and diagnostic.get("severity") == "error"
    ]
    if blocking:
        raise SystemExit(f"inspect reported blocking diagnostics: {json.dumps(blocking, indent=2)}")

    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    status = data.get("status")
    workflow = data.get("workflow") if isinstance(data.get("workflow"), dict) else {}
    workflow_status = workflow.get("status")
    if status in FAILED_STATUSES or workflow_status in FAILED_STATUSES:
        raise SystemExit(f"run is not healthy: status={status!r}, workflow_status={workflow_status!r}")


def write_target_metadata(path: Path, target_name: str, target_repository: str, signal_profile: str, expected_findings: str) -> None:
    write_json(path, {
        "schema_version": "1.0",
        "target_name": target_name,
        "target_repository": target_repository,
        "signal_profile": signal_profile,
        "expected_findings": expected_findings,
    })


def copy_report_json(envelope_path: Path, output_path: Path) -> None:
    envelope = load_json(envelope_path)
    data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
    json_path = data.get("json_path")
    if not isinstance(json_path, str):
        raise SystemExit("report command did not return data.json_path")
    source = Path(json_path)
    if not source.is_file():
        raise SystemExit(f"report JSON does not exist: {source}")
    report = json.loads(source.read_text(encoding="utf-8"))
    write_json(output_path, report)


def assert_report_accounting(envelope_path: Path, target_name: str, signal_profile: str) -> None:
    envelope = load_json(envelope_path)
    mismatches = report_accounting_mismatches(envelope)
    if mismatches:
        raise SystemExit(
            f"{target_name} ({signal_profile}) report command returned accounting mismatch diagnostics: "
            f"{json.dumps(mismatches, indent=2)}"
        )

    data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
    json_path = data.get("json_path")
    markdown_path = data.get("markdown_path")
    if not isinstance(json_path, str):
        raise SystemExit("report command did not return data.json_path")
    if not isinstance(markdown_path, str):
        raise SystemExit("report command did not return data.markdown_path")

    report = load_json(Path(json_path))
    run_metadata = report.get("run_metadata") if isinstance(report.get("run_metadata"), dict) else {}
    tokens_used = label_field(run_metadata, ["tokens_used", "tokensUsed", "token_usage", "tokenUsage"])
    estimated_spend = label_field(run_metadata, ["estimated_spend", "estimatedSpend", "estimated_cost", "estimatedCost"])
    if not positive_integer_label(tokens_used):
        raise SystemExit(
            f"{target_name} ({signal_profile}) final report is missing positive token usage: {tokens_used!r}"
        )
    if not positive_usd_label(estimated_spend):
        raise SystemExit(
            f"{target_name} ({signal_profile}) final report is missing positive estimated spend: {estimated_spend!r}"
        )

    markdown = Path(markdown_path).read_text(encoding="utf-8")
    if "Tokens used: unavailable" in markdown or tokens_used not in markdown:
        raise SystemExit(f"{target_name} ({signal_profile}) report.md does not render token usage {tokens_used!r}")
    if "Estimated spend: unavailable" in markdown or estimated_spend not in markdown:
        raise SystemExit(f"{target_name} ({signal_profile}) report.md does not render estimated spend {estimated_spend!r}")

    print(
        f"Accounting assertion passed for {target_name} ({signal_profile}): "
        f"tokens={tokens_used}, estimated_spend={estimated_spend}"
    )


def assert_report_findings(report_path: Path, expected: str, target_name: str, signal_profile: str) -> None:
    report = load_json(report_path)
    if not report.get("schema_version"):
        raise SystemExit("Final report JSON is missing schema_version")
    issues = report.get("issues")
    if not isinstance(issues, list):
        raise SystemExit("Final report JSON must contain an issues array")
    findings = report.get("findings")
    if not isinstance(findings, list):
        raise SystemExit("Final report JSON must contain a findings array")
    if len(findings) != len(issues):
        raise SystemExit("Final report JSON issues and findings arrays must have matching counts")
    count = len(issues)
    if expected == "eq:0" and count != 0:
        raise SystemExit(f"{target_name} ({signal_profile}) expected exactly 0 findings, got {count}")
    if expected == "gt:0" and count <= 0:
        raise SystemExit(f"{target_name} ({signal_profile}) expected more than 0 findings, got {count}")
    if expected not in {"any", "eq:0", "gt:0"}:
        raise SystemExit(f"Unsupported expected findings expression: {expected!r}")
    print(f"Finding count assertion passed for {target_name} ({signal_profile}): {count} findings matched {expected}")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def report_accounting_mismatches(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    diagnostics = envelope.get("diagnostics")
    if not isinstance(diagnostics, list):
        return []
    return [
        diagnostic
        for diagnostic in diagnostics
        if isinstance(diagnostic, dict) and diagnostic.get("code") == "REPORT_ACCOUNTING_MISMATCH"
    ]


def label_field(value: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        field = value.get(key)
        if isinstance(field, str):
            return field
        if isinstance(field, int) and not isinstance(field, bool):
            return f"{field:,}"
        if isinstance(field, float) and field.is_integer():
            return f"{int(field):,}"
    return None


def positive_integer_label(value: str | None) -> bool:
    if value is None or value.strip().lower() == "unavailable":
        return False
    digits = value.replace(",", "").strip()
    return digits.isdigit() and int(digits) > 0


def positive_usd_label(value: str | None) -> bool:
    if value is None or value.strip().lower() == "unavailable":
        return False
    normalized = value.strip().removeprefix("$").removesuffix("+")
    try:
        return float(normalized) > 0
    except ValueError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Target E2E CI helper commands.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    redact_parser = subparsers.add_parser("redact")
    redact_parser.add_argument("path", type=Path)

    cli_parser = subparsers.add_parser("assert-cli-ok")
    cli_parser.add_argument("path", type=Path)
    cli_parser.add_argument("label")

    inspect_parser = subparsers.add_parser("assert-inspect-healthy")
    inspect_parser.add_argument("path", type=Path)

    metadata_parser = subparsers.add_parser("write-target-metadata")
    metadata_parser.add_argument("path", type=Path)
    metadata_parser.add_argument("target_name")
    metadata_parser.add_argument("target_repository")
    metadata_parser.add_argument("signal_profile")
    metadata_parser.add_argument("expected_findings")

    copy_parser = subparsers.add_parser("copy-report-json")
    copy_parser.add_argument("envelope_path", type=Path)
    copy_parser.add_argument("output_path", type=Path)

    accounting_parser = subparsers.add_parser("assert-report-accounting")
    accounting_parser.add_argument("envelope_path", type=Path)
    accounting_parser.add_argument("target_name")
    accounting_parser.add_argument("signal_profile")

    findings_parser = subparsers.add_parser("assert-report-findings")
    findings_parser.add_argument("report_path", type=Path)
    findings_parser.add_argument("expected")
    findings_parser.add_argument("target_name")
    findings_parser.add_argument("signal_profile")

    args = parser.parse_args()
    if args.command == "redact":
        redact(args.path)
    elif args.command == "assert-cli-ok":
        assert_cli_ok(args.path, args.label)
    elif args.command == "assert-inspect-healthy":
        assert_inspect_healthy(args.path)
    elif args.command == "write-target-metadata":
        write_target_metadata(args.path, args.target_name, args.target_repository, args.signal_profile, args.expected_findings)
    elif args.command == "copy-report-json":
        copy_report_json(args.envelope_path, args.output_path)
    elif args.command == "assert-report-accounting":
        assert_report_accounting(args.envelope_path, args.target_name, args.signal_profile)
    elif args.command == "assert-report-findings":
        assert_report_findings(args.report_path, args.expected, args.target_name, args.signal_profile)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
