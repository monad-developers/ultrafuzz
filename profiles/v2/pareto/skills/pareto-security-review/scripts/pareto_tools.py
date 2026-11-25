#!/usr/bin/env python3
"""Deterministic Pareto coverage, sharding and report assembly. Standard library only.

Coverage checks heading mappings, not whether a security review is complete.
Sharding sorts by Solidity basename and candidate ID, then splits equal counts.
It keeps related candidates adjacent, but can split them across shard boundaries.
Assembly writes a report even when reviews are incomplete. Read its JSON status;
an exit code of zero means that the report was written, not that all work finished.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys

CAND = re.compile(r"^### \[(C-\d+)\][ \t]*(.*)$", re.M)
SEV_ORDER = {"High": 0, "Medium": 1, "Low": 2, "Info": 3}
VERDICT = re.compile(
    r"^\W*(C-\d+)\W*:?\s*VERDICT\s*=\s*([\w-]+)\s*;\s*"
    r"SEVERITY\s*=\s*([\w-]+)\s*;\s*EVIDENCE\s*=\s*(.*?)\s*;\s*NOTE\s*=\s*(.*)$", re.I)
DEFAULTS = {"rejection_min_votes": 2, "negative_evidence_min_chars": 10,
            "number_of_shards": 20, "verifiers_per_shard": 2,
            "appeal_restore_limit": 2, "appeal_reviewers": 6}


def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def candidates(path: Path) -> list[dict]:
    text = path.read_text()
    marks = list(CAND.finditer(text))
    out = []
    for i, match in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = re.split(r"^## ", text[match.start():end], flags=re.M)[0].rstrip() + "\n"
        def field(name: str) -> str:
            value = re.search(rf"^- {name}:\s*(.*)$", body, re.M | re.I)
            return value.group(1).strip() if value else ""
        severity = field("Severity")
        out.append({"id": match.group(1), "title": match.group(2).strip(), "body": body,
                    "severity": severity.split()[0].strip("*").capitalize() if severity else "",
                    "location": field("Location")})
    return out


def cmd_coverage(agents_dir: Path, merge_files: list[Path], only: set[str] | None = None) -> int:
    mapped: dict[str, set[str]] = {}
    for file in merge_files:
        for line in file.read_text().splitlines():
            parts = [part.strip() for part in line.strip().strip("|").split("|")]
            if len(parts) >= 3 and re.fullmatch(r"reviewer-\d+", parts[0]):
                mapped.setdefault(parts[0], set()).add(norm(parts[1]))
    missing = 0
    for report in sorted(agents_dir.glob("reviewer-*/report.md")):
        name = report.parent.name
        if only and name not in only:
            continue
        heads = re.findall(r"^#{3,4} (.+)$", report.read_text(), re.M)
        lost = [heading for heading in heads if norm(heading) not in mapped.get(name, set())]
        if lost:
            missing += len(lost)
            print(f"{name}: {len(lost)} unmapped: " + " || ".join(lost))
    print(f"coverage: {missing} unmapped headings (structural mapping only; delivery checked by assemble)")
    return 1 if missing else 0


def cmd_shards(cand_file: Path, out_dir: Path, count: int) -> int:
    if count <= 0:
        raise ValueError("shard count must be positive")
    cands = candidates(cand_file)
    if len({candidate['id'] for candidate in cands}) != len(cands):
        raise ValueError("duplicate candidate IDs; correct the candidate list before sharding")
    def key(candidate: dict) -> tuple[str, int]:
        match = re.search(r"([\w/.-]+\.sol)", candidate["location"])
        return (match.group(1).rsplit("/", 1)[-1] if match else "~other", int(candidate["id"][2:]))
    cands.sort(key=key)
    out_dir.mkdir(parents=True, exist_ok=True)
    for i in range(count):
        chunk = cands[len(cands) * i // count:len(cands) * (i + 1) // count]
        body = "\n".join(candidate["body"] for candidate in chunk) if chunk else "No candidates in this shard.\n"
        (out_dir / f"shard-{i + 1:02d}.md").write_text(
            f"# Shard {i + 1:02d}: {', '.join(candidate['id'] for candidate in chunk) or 'none'}\n\n" + body)
    print(f"{len(cands)} candidates in {count} shards")
    return 0


def config_digest(config: dict) -> str:
    """Match the renderer's review settings; display filters do not alter verdicts."""
    review = {key: value for key, value in config.items() if key != "reporting"}
    return hashlib.sha256((json.dumps(review, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode()).hexdigest()


def file_hash(path: Path) -> str | None:
    """Snapshot an input, including its absence during partial-review recovery."""
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def read_reviews(manifest_path: Path, candidate_ids: set[str], phase: str, settings: dict,
                 config_sha256: str, candidate_input_sha256: str) -> dict:
    """Read only assigned outputs. One output contributes at most one vote per candidate."""
    manifest = json.loads(manifest_path.read_text())
    expected = manifest.get("expected_outputs", [])
    if not isinstance(expected, list):
        raise ValueError("manifest expected_outputs must be a list")
    issues: dict[str, list[str]] = {cid: [] for cid in sorted(candidate_ids)}
    votes: dict[str, list[dict]] = {cid: [] for cid in sorted(candidate_ids)}
    counts = {cid: {"expected": 0, "received": 0} for cid in sorted(candidate_ids)}
    warnings, missing, errors = [], [], []
    if manifest.get("config_sha256") != config_sha256:
        message = "configuration does not match the run manifest; use the original run configuration"
        errors.append(message)
        for cid in candidate_ids:
            issues[cid].append(message)
    if manifest.get("candidate_input_sha256") != candidate_input_sha256:
        message = "candidate input differs from the verifier assignment snapshot; preserve this run and prepare a new review"
        errors.append(message)
        for cid in candidate_ids:
            issues[cid].append(message)
    prepared = manifest.get("prepared_stages", [])
    for stage in (["hunt", "verify"] if phase == "pre-appeal" else ["hunt", "verify", "appeal"]):
        if stage not in prepared:
            errors.append(f"{stage} assignments have not been prepared")
    output_root = Path(manifest.get("output_dir", manifest_path.parent)).resolve()
    if phase == "final" and (not manifest.get("appeal_input_sha256") or
                             manifest["appeal_input_sha256"] != file_hash(output_root / "appeal/pre-report.md")):
        message = "pre-report differs from the appeal assignment snapshot; old appeal results cannot be reused"
        errors.append(message)
        for cid in candidate_ids:
            issues[cid].append(message)
    appeal_verifier_hashes = manifest.get("appeal_verifier_hashes", {})
    if not isinstance(appeal_verifier_hashes, dict):
        appeal_verifier_hashes = {}
    seen_paths, seen_reviewers = set(), set()
    assigned_verifiers = 0
    assigned_appeals = 0
    role_counts = Counter()
    for task in expected:
        role = task.get("role", "")
        if role == "appeal" and phase == "pre-appeal":
            continue
        role_counts[role] += 1
        if role not in ("hunter", "batch-merger", "final-merger", "verifier", "appeal"):
            errors.append(f"unknown expected output role: {role}")
        reviewer = task.get("reviewer_id", "")
        rel = task.get("path", "")
        path = (manifest_path.parent / rel).resolve()
        assigned = task.get("candidate_ids", [])
        if not isinstance(assigned, list) or any(not isinstance(cid, str) for cid in assigned):
            errors.append(f"{reviewer}: invalid candidate assignment list")
            continue
        assigned_ids = set(assigned)
        relevant = assigned_ids & candidate_ids
        is_review = role in ("verifier", "appeal")
        if role == "verifier":
            assigned_verifiers += 1
            for cid in relevant:
                counts[cid]["expected"] += 1
        if role == "appeal":
            assigned_appeals += 1
        def problem(message: str, affected: set[str] | None = None) -> None:
            errors.append(message)
            for cid in relevant if affected is None else affected:
                issues[cid].append(message)
        if not rel or not reviewer or not path.is_relative_to(output_root):
            problem(f"{reviewer or 'unnamed task'}: invalid output path or reviewer ID")
            continue
        if path in seen_paths or reviewer in seen_reviewers:
            problem(f"{reviewer}: duplicate expected reviewer or output path")
            continue
        seen_paths.add(path)
        seen_reviewers.add(reviewer)
        if role == "verifier" and phase == "final" and (
                rel not in appeal_verifier_hashes or appeal_verifier_hashes[rel] != file_hash(path)):
            problem(f"{reviewer}: verifier evidence changed after appeal assignment; old appeals cannot be reused")
        if assigned_ids - candidate_ids:
            problem(f"{reviewer}: assignment refers to unknown candidates")
        try:
            text = path.read_text()
        except (OSError, UnicodeError) as exc:
            text = ""
            warnings.append(f"{reviewer}: could not read output ({type(exc).__name__})")
        if not text.strip():
            if task.get("required", True):
                missing.append(str(rel))
                problem(f"{reviewer}: missing or empty output {rel}")
            continue
        if not is_review:
            continue
        parsed: dict[str, dict] = {}
        conflicted: set[str] = set()
        explicit_empty = "No candidates restored." if role == "appeal" else "No candidates in this shard."
        empty_declared = text.strip() == explicit_empty
        if empty_declared:
            if role == "verifier" and assigned_ids:
                problem(f"{reviewer}: claimed empty shard with assigned candidates")
        else:
            for number, line in enumerate(text.splitlines(), 1):
                line = line.strip()
                if not line or line.startswith("```"):
                    continue
                match = VERDICT.match(line)
                hinted = re.search(r"\bC-\d+\b", line)
                affected = {hinted.group(0)} if hinted and hinted.group(0) in relevant else relevant
                if not match:
                    problem(f"{reviewer}:{number}: malformed verdict line", affected)
                    continue
                cid, verdict, severity, evidence, note = match.groups()
                verdict, severity = verdict.lower(), severity.capitalize()
                if cid not in assigned_ids or cid not in candidate_ids:
                    problem(f"{reviewer}:{number}: verdict for unassigned candidate {cid}")
                    continue
                valid = verdict in ("finding", "informational", "invalid") and severity in ("High", "Medium", "Low", "-")
                valid = valid and bool(evidence.strip()) and bool(note.strip())
                valid = valid and (verdict != "finding" or severity in ("High", "Medium", "Low"))
                valid = valid and (role != "appeal" or verdict == "finding")
                if not valid:
                    problem(f"{reviewer}:{number}: unknown or invalid verdict fields for {cid}", {cid})
                    continue
                vote = {"verdict": verdict, "severity": severity, "evidence": evidence.strip(),
                        "note": note.strip(), "reviewer": reviewer, "file": str(rel), "role": role}
                if cid in parsed:
                    if parsed[cid] != vote:
                        conflicted.add(cid)
                        problem(f"{reviewer}: conflicting duplicate verdicts for {cid}", {cid})
                    else:
                        warnings.append(f"{reviewer}: duplicate identical verdict for {cid}; counted once")
                else:
                    parsed[cid] = vote
            if role == "appeal" and not parsed:
                problem(f"{reviewer}: no valid restoration or explicit no-restoration result")
        if role == "appeal" and len(parsed) > settings["appeal_restore_limit"]:
            warnings.append(f"{reviewer}: {len(parsed)} restorations exceed the configured cap "
                            f"of {settings['appeal_restore_limit']}; all valid restorations retained")
        for cid, vote in parsed.items():
            if cid not in conflicted:
                votes[cid].append(vote)
                if role == "verifier":
                    counts[cid]["received"] += 1
        if role == "verifier":
            for cid in sorted(relevant - parsed.keys()):
                problem(f"{reviewer}: no valid verdict for {cid}", {cid})
    expected_verifiers = settings["number_of_shards"] * settings["verifiers_per_shard"]
    if assigned_verifiers != expected_verifiers:
        errors.append(f"expected {expected_verifiers} verifier assignments, found {assigned_verifiers}")
    if phase == "final" and assigned_appeals != settings["appeal_reviewers"]:
        errors.append(f"expected {settings['appeal_reviewers']} appeal assignments, found {assigned_appeals}")
    if "number_of_hunters" in settings and "merge_batch_size" in settings:
        hunters, batch_size = settings["number_of_hunters"], settings["merge_batch_size"]
        required_roles = {"hunter": hunters, "batch-merger": (hunters + batch_size - 1) // batch_size,
                          "final-merger": 1}
        for role, count in required_roles.items():
            if role_counts[role] != count:
                errors.append(f"expected {count} {role} assignments, found {role_counts[role]}")
    for cid, count in counts.items():
        if count["expected"] != settings["verifiers_per_shard"]:
            issues[cid].append(f"expected {settings['verifiers_per_shard']} verifier assignments for {cid}, found {count['expected']}")
    return {"votes": votes, "issues": issues, "counts": counts, "warnings": warnings,
            "missing_outputs": missing, "errors": errors}


def cmd_assemble(cand_file: Path, verify_dir: Path, report: Path, *, manifest: Path,
                 config: dict | None = None, phase: str = "final", status_path: Path | None = None) -> int:
    # verify_dir remains in the CLI for compatibility; the assignment manifest owns inputs.
    config = config or {}
    settings = {**DEFAULTS, **config.get("workflow", {})}
    candidate_text = cand_file.read_text()
    cands = candidates(cand_file)
    ids = {candidate["id"] for candidate in cands}
    candidate_hash = hashlib.sha256(cand_file.read_bytes()).hexdigest()
    data = read_reviews(manifest, ids, phase, settings, config_digest(config), candidate_hash)
    malformed = [line for line in candidate_text.splitlines()
                 if re.match(r"^#{2,4}\s+(?:\[|C-\d)", line) and not CAND.match(line)]
    empty_marker = bool(re.search(r"^No candidates\.[ \t]*$", candidate_text, re.M))
    input_problem = bool(malformed) or (not cands and not empty_marker) or (bool(cands) and empty_marker)
    if input_problem:
        message = "candidate input has malformed headings or no recognized candidates; use 'No candidates.' for a true empty result"
        data["errors"].append(message)
        for cid in ids:
            data["issues"][cid].append(message)
    duplicates = {cid for cid, count in Counter(candidate["id"] for candidate in cands).items() if count > 1}
    for cid in duplicates:
        data["issues"][cid].append("duplicate candidate ID; candidate blocks preserved for correction")
    include = config.get("reporting", {}).get("include_severities", ["High", "Medium", "Low"])
    results = []
    for candidate in cands:
        cid = candidate["id"]
        votes = data["votes"][cid]
        negatives = [vote for vote in votes if vote["verdict"] in ("informational", "invalid")
                     and len(vote["evidence"]) > settings["negative_evidence_min_chars"]]
        positive = [vote for vote in votes if vote["verdict"] == "finding"]
        severity = min((vote["severity"] for vote in positive), key=SEV_ORDER.get, default=None)
        severity_source = "finding verdicts" if severity else "candidate label" if candidate["severity"] in SEV_ORDER else "Low fallback"
        severity = severity or (candidate["severity"] if candidate["severity"] in SEV_ORDER else "Low")
        incomplete = bool(data["issues"][cid]) or data["counts"][cid]["received"] < data["counts"][cid]["expected"]
        rejected = not incomplete and len(votes) >= settings["rejection_min_votes"] and len(negatives) == len(votes)
        if incomplete or not votes:
            category = "unreviewed" if not votes else "unresolved"
        elif rejected:
            category = "informational" if all(vote["verdict"] == "informational" for vote in votes) else "rejected"
        elif positive:
            category = "finding"
        else:
            category = "unresolved"
        results.append({**candidate, "final": severity, "severity_source": severity_source,
                        "category": category, "rejected": rejected, "votes": votes,
                        "review_counts": data["counts"][cid], "issues": data["issues"][cid]})
    results.sort(key=lambda candidate: (SEV_ORDER[candidate["final"]], int(candidate["id"][2:])))
    complete = not data["errors"] and not data["missing_outputs"] and all(
        not result["issues"] and result["review_counts"]["received"] == result["review_counts"]["expected"]
        for result in results)
    status = {"schema_version": 1, "phase": phase, "complete": complete, "include_severities": include,
              "missing_outputs": data["missing_outputs"], "errors": data["errors"], "warnings": data["warnings"],
              "rejected": [result["id"] for result in results if result["rejected"]],
              "candidates": [{key: value for key, value in result.items() if key != "body"} for result in results]}
    lines = ["# Security review report", "", f"Review completion: **{'Complete' if complete else 'Incomplete'}** ({phase}).",
             "Report generation and review completion are separate. Findings below reflect the recorded verdicts.", ""]
    if data["errors"] or data["missing_outputs"]:
        lines += ["## Missing or incomplete work", ""] + [f"- {error}" for error in data["errors"]] + [""]
    if data["warnings"]:
        lines += ["## Warnings", ""] + [f"- {warning}" for warning in data["warnings"]] + [""]
    lines += ["| Severity | Findings |", "|---|---|"]
    for severity in ("High", "Medium", "Low"):
        lines.append(f"| {severity} | {sum(result['category'] == 'finding' and result['final'] == severity for result in results)} |")
    lines += ["", "Counts include findings moved to the display-filter appendix.", ""]
    sections = [(f"{severity} findings", lambda result, severity=severity: result["category"] == "finding" and result["final"] == severity and severity in include) for severity in ("High", "Medium", "Low")]
    sections += [("Appendix: findings outside the display filter", lambda result: result["category"] == "finding" and result["final"] not in include),
                 ("Informational observations", lambda result: result["category"] == "informational"),
                 ("Unresolved or unreviewed candidates", lambda result: result["category"] in ("unresolved", "unreviewed")),
                 ("Appendix: rejected candidates", lambda result: result["category"] == "rejected")]
    for title, predicate in sections:
        lines += [f"## {title}", ""]
        selected = [result for result in results if predicate(result)]
        if not selected:
            lines += ["None.", ""]
        for result in selected:
            body = re.sub(r"^- Severity:.*$", f"- Severity: {result['final']}", result["body"], count=1, flags=re.M)
            count = result["review_counts"]
            lines += [body.rstrip(), f"- Classification: {result['category']}", f"- Severity source: {result['severity_source']}",
                      f"- Reviews received: {count['received']} of {count['expected']} verifier results."]
            if result["issues"]:
                lines += ["- Review incomplete: " + "; ".join(result["issues"])]
            for vote in result["votes"]:
                lines.append(f"- {vote['reviewer']}: {vote['verdict']}/{vote['severity']}; EVIDENCE={vote['evidence']}; NOTE={vote['note']}")
            if not result["votes"]:
                lines.append("- Verification: Unreviewed; no valid verdict received.")
            lines.append("")
    if input_problem:
        lines += ["## Appendix: unparsed candidate input", "",
                  "The original candidate file is preserved. Its contents follow for correction:", ""]
        lines += ["    " + line for line in candidate_text.splitlines()] + [""]
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("\n".join(lines) + "\n")
    status_path = status_path or Path(str(report) + ".status.json")
    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(json.dumps(status, indent=2) + "\n")
    print(json.dumps({"report": str(report), "status": str(status_path), "complete": complete,
                      "findings": sum(result["category"] == "finding" for result in results),
                      "rejected": len(status["rejected"])}))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    coverage = sub.add_parser("coverage")
    coverage.add_argument("agents_dir", type=Path)
    coverage.add_argument("merge_files", type=Path, nargs="+")
    coverage.add_argument("--only")
    shards = sub.add_parser("shards")
    shards.add_argument("candidates", type=Path)
    shards.add_argument("out_dir", type=Path)
    shards.add_argument("--count", type=int)
    shards.add_argument("--config", type=Path)
    assemble = sub.add_parser("assemble")
    assemble.add_argument("candidates", type=Path)
    assemble.add_argument("verify_dir", type=Path)
    assemble.add_argument("report", type=Path)
    assemble.add_argument("--manifest", type=Path, required=True)
    assemble.add_argument("--config", type=Path)
    assemble.add_argument("--phase", choices=("pre-appeal", "final"), default="final")
    assemble.add_argument("--status", type=Path)
    args = parser.parse_args(argv)
    try:
        config = {}
        if getattr(args, "config", None):
            from config import load_config
            config = load_config(args.config, require_target=False)
        if args.command == "coverage":
            return cmd_coverage(args.agents_dir, args.merge_files, set(args.only.split(",")) if args.only else None)
        if args.command == "shards":
            count = args.count if args.count is not None else config.get("workflow", {}).get("number_of_shards", 20)
            return cmd_shards(args.candidates, args.out_dir, count)
        return cmd_assemble(args.candidates, args.verify_dir, args.report, manifest=args.manifest,
                            config=config, phase=args.phase, status_path=args.status)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(f"pareto: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
