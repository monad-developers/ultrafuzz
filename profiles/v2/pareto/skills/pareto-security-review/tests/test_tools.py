"""Offline tests for report decisions and incomplete-output handling."""
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("pareto_tools", Path(__file__).parents[1] / "scripts" / "pareto_tools.py")
tools = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tools)


def candidate(cid="C-001", severity="Medium", location="src/Pool.sol:1"):
    return f"### [{cid}] Example defect\n- Severity: {severity}\n- Location: {location}\n- Root cause: example\n- Impact: example\n"


def vote(cid="C-001", verdict="finding", severity="Medium", evidence="src/Pool.sol:10", note="Supported by the code."):
    return f"{cid}: VERDICT={verdict}; SEVERITY={severity}; EVIDENCE={evidence}; NOTE={note}\n"


class ToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.candidates = self.root / "candidates.md"
        self.candidates.write_text(candidate())
        self.report = self.root / "report.md"
        self.manifest = self.root / "manifest.json"
        self.config = {"workflow": {"number_of_shards": 1, "verifiers_per_shard": 2,
                                    "appeal_reviewers": 1, "appeal_restore_limit": 2}}
        self.tasks = [
            {"reviewer_id": "verifier-a-01", "path": "verify/a.md", "role": "verifier", "candidate_ids": ["C-001"]},
            {"reviewer_id": "verifier-b-01", "path": "verify/b.md", "role": "verifier", "candidate_ids": ["C-001"]},
        ]
        self.stages = ["hunt", "verify"]

    def output(self, path, text):
        dest = self.root / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text)

    def assemble(self, phase="pre-appeal"):
        pre = self.root / "appeal/pre-report.md"
        if phase == "final" and not pre.exists():
            self.output("appeal/pre-report.md", "Synthetic preliminary report.\n")
        self.manifest.write_text(json.dumps({"schema_version": 1, "output_dir": str(self.root),
                                             "config_sha256": tools.config_digest(self.config),
                                             "candidate_input_sha256": hashlib.sha256(self.candidates.read_bytes()).hexdigest(),
                                             "appeal_input_sha256": tools.file_hash(pre),
                                             "appeal_verifier_hashes": {task["path"]: tools.file_hash(self.root / task["path"])
                                                                         for task in self.tasks if task["role"] == "verifier"},
                                             "prepared_stages": self.stages, "expected_outputs": self.tasks}))
        with redirect_stdout(io.StringIO()):
            result = tools.cmd_assemble(self.candidates, self.root / "verify", self.report,
                                        manifest=self.manifest, config=self.config, phase=phase)
        self.assertEqual(result, 0)
        status = json.loads(Path(str(self.report) + ".status.json").read_text())
        return status, self.report.read_text()

    def test_no_reviews_preserves_candidate_as_unreviewed(self):
        status, report = self.assemble()
        self.assertFalse(status["complete"])
        self.assertEqual(status["candidates"][0]["category"], "unreviewed")
        self.assertEqual(len(status["missing_outputs"]), 2)
        self.assertIn("Example defect", report)
        self.assertNotIn("(verified)", report)

    def test_missing_second_review_keeps_positive_result_incomplete(self):
        self.output("verify/a.md", vote())
        status, report = self.assemble()
        self.assertFalse(status["complete"])
        self.assertEqual(status["candidates"][0]["category"], "unresolved")
        self.assertIn("1 of 2 verifier results", report)
        self.assertIn("Supported by the code", report)

    def test_missing_assigned_verdict_is_not_hidden_by_nonempty_file(self):
        self.candidates.write_text(candidate() + candidate("C-002"))
        for task in self.tasks:
            task["candidate_ids"].append("C-002")
        self.output("verify/a.md", vote() + vote("C-002"))
        self.output("verify/b.md", vote())
        status, _ = self.assemble()
        self.assertFalse(status["complete"])
        second = next(c for c in status["candidates"] if c["id"] == "C-002")
        self.assertEqual(second["review_counts"], {"expected": 2, "received": 1})

    def test_all_qualified_negative_votes_reject(self):
        for path in ["verify/a.md", "verify/b.md"]:
            self.output(path, vote(verdict="invalid", severity="-"))
        status, report = self.assemble()
        self.assertTrue(status["complete"])
        self.assertEqual(status["rejected"], ["C-001"])
        self.assertEqual(status["candidates"][0]["category"], "rejected")
        self.assertIn("Root cause: example", report)

    def test_evidence_length_boundary_preserves_candidate(self):
        for path in ["verify/a.md", "verify/b.md"]:
            self.output(path, vote(verdict="invalid", severity="-", evidence="0123456789"))
        status, _ = self.assemble()
        self.assertEqual(status["rejected"], [])
        self.assertEqual(status["candidates"][0]["category"], "unresolved")
        self.config["workflow"]["negative_evidence_min_chars"] = 9
        status, _ = self.assemble()
        self.assertEqual(status["rejected"], ["C-001"])

    def test_configurable_min_votes(self):
        self.config["workflow"].update(verifiers_per_shard=1, rejection_min_votes=1)
        self.tasks.pop()
        self.output("verify/a.md", vote(verdict="invalid", severity="-"))
        status, _ = self.assemble()
        self.assertEqual(status["rejected"], ["C-001"])

    def test_positive_vote_keeps_finding_and_supplies_severity(self):
        self.output("verify/a.md", vote(severity="Low"))
        self.output("verify/b.md", vote(verdict="invalid", severity="-"))
        status, report = self.assemble()
        result = status["candidates"][0]
        self.assertTrue(status["complete"])
        self.assertEqual((result["category"], result["final"], result["severity_source"]), ("finding", "Low", "finding verdicts"))
        self.assertIn("## Low findings", report)

    def test_highest_finding_severity_used(self):
        self.output("verify/a.md", vote(severity="Low"))
        self.output("verify/b.md", vote(severity="High"))
        status, _ = self.assemble()
        self.assertEqual(status["candidates"][0]["final"], "High")

    def test_informational_is_separate_but_available_to_appeal(self):
        for path in ["verify/a.md", "verify/b.md"]:
            self.output(path, vote(verdict="informational", severity="-"))
        status, report = self.assemble()
        self.assertEqual(status["candidates"][0]["category"], "informational")
        self.assertEqual(status["rejected"], ["C-001"])
        self.assertIn("## Informational observations", report)

    def test_identical_duplicate_counts_once(self):
        self.output("verify/a.md", vote(verdict="invalid", severity="-") * 2)
        self.output("verify/b.md", vote(verdict="invalid", severity="-"))
        status, _ = self.assemble()
        self.assertEqual(len(status["candidates"][0]["votes"]), 2)
        self.assertTrue(status["warnings"])

    def test_conflicting_duplicate_is_unresolved(self):
        self.output("verify/a.md", vote() + vote(verdict="invalid", severity="-"))
        self.output("verify/b.md", vote(verdict="invalid", severity="-"))
        status, _ = self.assemble()
        self.assertFalse(status["complete"])
        self.assertEqual(status["rejected"], [])
        self.assertEqual(status["candidates"][0]["category"], "unresolved")

    def test_unknown_or_malformed_vote_cannot_disappear_and_allow_rejection(self):
        for extra in [vote(verdict="probably"), "C-001: VERDICT=invalid; broken fields\n"]:
            with self.subTest(extra=extra):
                self.output("verify/a.md", vote(verdict="invalid", severity="-") + extra)
                self.output("verify/b.md", vote(verdict="invalid", severity="-"))
                status, _ = self.assemble()
                self.assertEqual(status["rejected"], [])
                self.assertFalse(status["complete"])

    def test_unassigned_file_does_not_supply_votes(self):
        self.output("verify/stale.md", vote(verdict="invalid", severity="-") * 3)
        status, _ = self.assemble()
        self.assertEqual(status["candidates"][0]["votes"], [])
        self.assertEqual(status["rejected"], [])

    def test_single_appeal_restores_and_cap_is_warning_only(self):
        self.candidates.write_text(candidate() + candidate("C-002"))
        for task in self.tasks:
            task["candidate_ids"].append("C-002")
        for path in ["verify/a.md", "verify/b.md"]:
            self.output(path, vote(verdict="invalid", severity="-") + vote("C-002", "invalid", "-"))
        self.tasks.append({"reviewer_id": "appeal-1", "path": "appeal/a.md", "role": "appeal", "candidate_ids": ["C-001", "C-002"]})
        self.stages.append("appeal")
        self.config["workflow"]["appeal_restore_limit"] = 1
        self.output("appeal/a.md", vote() + vote("C-002", severity="Low"))
        status, _ = self.assemble("final")
        self.assertEqual([c["category"] for c in status["candidates"]], ["finding", "finding"])
        self.assertEqual(status["rejected"], [])
        self.assertTrue(status["complete"])
        self.assertTrue(any("exceed" in warning for warning in status["warnings"]))

    def test_unprepared_final_stage_cannot_claim_completion(self):
        self.output("verify/a.md", vote())
        self.output("verify/b.md", vote())
        status, _ = self.assemble("final")
        self.assertFalse(status["complete"])
        self.assertIn("appeal assignments have not been prepared", status["errors"])

    def test_changed_configuration_cannot_claim_complete_or_reject(self):
        self.output("verify/a.md", vote(verdict="invalid", severity="-"))
        self.output("verify/b.md", vote(verdict="invalid", severity="-"))
        self.assemble()
        self.config["workflow"]["negative_evidence_min_chars"] = 0
        with redirect_stdout(io.StringIO()):
            tools.cmd_assemble(self.candidates, self.root / "verify", self.report,
                               manifest=self.manifest, config=self.config, phase="pre-appeal")
        status = json.loads(Path(str(self.report) + ".status.json").read_text())
        self.assertFalse(status["complete"])
        self.assertEqual(status["rejected"], [])
        self.assertEqual(status["candidates"][0]["category"], "unresolved")

    def test_missing_hunter_output_marks_run_incomplete(self):
        self.output("verify/a.md", vote())
        self.output("verify/b.md", vote())
        self.tasks.append({"reviewer_id": "reviewer-01", "path": "agents/reviewer-01/report.md", "role": "hunter", "candidate_ids": []})
        status, _ = self.assemble()
        self.assertFalse(status["complete"])
        self.assertIn("agents/reviewer-01/report.md", status["missing_outputs"])

    def test_changed_candidate_body_cannot_reuse_old_negative_verdicts(self):
        self.output("verify/a.md", vote(verdict="invalid", severity="-"))
        self.output("verify/b.md", vote(verdict="invalid", severity="-"))
        status, _ = self.assemble()
        self.assertTrue(status["complete"])
        self.candidates.write_text(candidate().replace("Root cause: example", "Root cause: changed evidence"))
        with redirect_stdout(io.StringIO()):
            tools.cmd_assemble(self.candidates, self.root / "verify", self.report,
                               manifest=self.manifest, config=self.config, phase="pre-appeal")
        status = json.loads(Path(str(self.report) + ".status.json").read_text())
        self.assertFalse(status["complete"])
        self.assertEqual(status["rejected"], [])
        self.assertEqual(status["candidates"][0]["category"], "unresolved")
        self.assertIn("changed evidence", self.report.read_text())

    def test_equivalent_candidate_copy_preserves_completed_review(self):
        self.output("verify/a.md", vote())
        self.output("verify/b.md", vote())
        status, _ = self.assemble()
        self.assertTrue(status["complete"])
        copied = self.root / "candidate-copy.md"
        copied.write_bytes(self.candidates.read_bytes())
        with redirect_stdout(io.StringIO()):
            tools.cmd_assemble(copied, self.root / "verify", self.report,
                               manifest=self.manifest, config=self.config, phase="pre-appeal")
        status = json.loads(Path(str(self.report) + ".status.json").read_text())
        self.assertTrue(status["complete"])
        self.assertEqual(status["candidates"][0]["category"], "finding")

    def test_changed_appeal_evidence_cannot_reuse_old_restoration(self):
        for path in ("verify/a.md", "verify/b.md"):
            self.output(path, vote(verdict="invalid", severity="-"))
        self.tasks.append({"reviewer_id": "appeal-1", "path": "appeal/a.md", "role": "appeal", "candidate_ids": ["C-001"]})
        self.stages.append("appeal")
        self.output("appeal/a.md", vote())
        for changed in ("appeal/pre-report.md", "verify/a.md"):
            with self.subTest(changed=changed):
                status, _ = self.assemble("final")
                self.assertTrue(status["complete"])
                old = (self.root / changed).read_text()
                self.output(changed, old.replace("Synthetic", "Updated") if changed.startswith("appeal") else
                            vote(verdict="invalid", severity="-", note="Updated rejection evidence."))
                with redirect_stdout(io.StringIO()):
                    tools.cmd_assemble(self.candidates, self.root / "verify", self.report,
                                       manifest=self.manifest, config=self.config, phase="final")
                status = json.loads(Path(str(self.report) + ".status.json").read_text())
                self.assertFalse(status["complete"])
                self.assertEqual(status["candidates"][0]["category"], "unresolved")
                self.output(changed, old)

    def test_missing_hunt_declarations_cannot_claim_complete(self):
        self.config["workflow"].update(number_of_hunters=3, merge_batch_size=2)
        self.output("verify/a.md", vote())
        self.output("verify/b.md", vote())
        status, _ = self.assemble()
        self.assertFalse(status["complete"])
        self.assertIn("expected 3 hunter assignments, found 0", status["errors"])
        self.assertIn("expected 2 batch-merger assignments, found 0", status["errors"])

    def test_optional_flag_does_not_hide_missing_assigned_verification(self):
        self.tasks[1]["required"] = False
        self.output("verify/a.md", vote())
        status, _ = self.assemble()
        self.assertFalse(status["complete"])
        self.assertEqual(status["candidates"][0]["category"], "unresolved")

    def test_display_filter_preserves_low_finding_and_evidence(self):
        self.config["reporting"] = {"include_severities": ["High", "Medium"]}
        self.output("verify/a.md", vote(severity="Low"))
        self.output("verify/b.md", vote(severity="Low"))
        status, report = self.assemble()
        self.assertEqual(status["candidates"][0]["category"], "finding")
        filtered = report.split("## Appendix: findings outside the display filter", 1)[1]
        self.assertIn("Example defect", filtered)
        self.assertIn("src/Pool.sol:10", filtered)

    def test_empty_shards_and_explicit_no_appeal_can_complete(self):
        self.candidates.write_text("No candidates.\n\n## Coverage\nreviewer-01 | Notes | NOT-A-FINDING\n")
        for task in self.tasks:
            task["candidate_ids"] = []
            self.output(task["path"], "No candidates in this shard.\n")
        self.tasks.append({"reviewer_id": "appeal-1", "path": "appeal/a.md", "role": "appeal", "candidate_ids": []})
        self.output("appeal/a.md", "No candidates restored.\n")
        self.stages.append("appeal")
        status, _ = self.assemble("final")
        self.assertTrue(status["complete"])

    def test_unknown_verdict_severity_cannot_allow_rejection(self):
        self.output("verify/a.md", vote(verdict="informational", severity="Info"))
        self.output("verify/b.md", vote(verdict="invalid", severity="-"))
        status, _ = self.assemble()
        self.assertFalse(status["complete"])
        self.assertEqual(status["rejected"], [])

    def test_malformed_candidate_input_cannot_become_empty_success(self):
        self.candidates.write_text("### [candidate-1] A defect with an unsupported heading\nEvidence to preserve.\n")
        for task in self.tasks:
            task["candidate_ids"] = []
            self.output(task["path"], "No candidates in this shard.\n")
        status, report = self.assemble()
        self.assertFalse(status["complete"])
        self.assertIn("## Appendix: unparsed candidate input", report)
        self.assertIn("Evidence to preserve.", report)

    def test_partly_malformed_candidate_input_blocks_rejection_and_preserves_text(self):
        self.candidates.write_text(candidate() + "### [C-bad] Another defect\nEvidence to preserve.\n")
        self.output("verify/a.md", vote(verdict="invalid", severity="-"))
        self.output("verify/b.md", vote(verdict="invalid", severity="-"))
        status, report = self.assemble()
        self.assertFalse(status["complete"])
        self.assertEqual(status["rejected"], [])
        self.assertIn("Evidence to preserve.", report)

    def test_zero_shards_rejected_and_empty_shards_written(self):
        with self.assertRaisesRegex(ValueError, "positive"):
            tools.cmd_shards(self.candidates, self.root / "shards", 0)
        with redirect_stdout(io.StringIO()):
            tools.cmd_shards(self.candidates, self.root / "shards", 3)
        shards = list((self.root / "shards").glob("*.md"))
        self.assertEqual(len(shards), 3)
        self.assertEqual(sum("No candidates in this shard." in shard.read_text() for shard in shards), 2)

    def test_coverage_is_heading_mapping_not_delivery_proof(self):
        self.output("agents/reviewer-01/report.md", "### F-1: Example defect\n")
        self.output("batch.md", "reviewer-01 | F 1 Example defect | C-001\n")
        with redirect_stdout(io.StringIO()):
            self.assertEqual(tools.cmd_coverage(self.root / "agents", [self.root / "batch.md"]), 0)
        self.output("batch.md", "reviewer-01 | Other heading | C-001\n")
        with redirect_stdout(io.StringIO()):
            self.assertEqual(tools.cmd_coverage(self.root / "agents", [self.root / "batch.md"]), 1)


if __name__ == "__main__":
    unittest.main()
