"""Exercise the public CLIs together with synthetic reports, without agents or builds."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL = Path(__file__).resolve().parents[1]


class WorkflowTests(unittest.TestCase):
    def test_complete_pipeline_and_missing_review_recovery(self):
        with tempfile.TemporaryDirectory(prefix="pareto-workflow-") as temp:
            root = Path(temp)
            workspace = root / "source with spaces"
            (workspace / "src").mkdir(parents=True)
            (workspace / "src/Fixture.sol").write_text(
                "contract Fixture { function inspect() external {} }\n"
            )
            config = root / "review.toml"
            config.write_text(
                '[target]\nproject="Fixture"\nrepository="example/fixture"\n'
                'revision="' + "a" * 40 + '"\nworkspace=' + json.dumps(str(workspace)) + '\n'
                'scope=["src"]\nthreat_model="Untrusted users; trusted administrator."\n'
                '[workflow]\nnumber_of_hunters=3\nfile_hunters_per_group=2\n'
                'entrypoint_hunters_per_group=1\nmerge_batch_size=2\n'
                'number_of_shards=3\nverifiers_per_shard=2\nappeal_reviewers=2\n'
                '[reporting]\ninclude_severities=["High","Medium"]\n'
            )
            run = root / "run with spaces"

            def cli(script, *args):
                result = subprocess.run(
                    [sys.executable, str(SKILL / "scripts" / script), *map(str, args)],
                    text=True, capture_output=True, timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                return result.stdout

            def render(phase):
                cli("render.py", phase, "--config", config, "--out", run)

            def manifest():
                return json.loads((run / "manifest.json").read_text())

            def assemble(phase, report):
                cli("pareto_tools.py", "assemble", run / "merge/candidates.md",
                    run / "verify", report, "--manifest", run / "manifest.json",
                    "--config", config, "--phase", phase)
                return json.loads(Path(str(report) + ".status.json").read_text())

            render("prepare")
            (run / "partition-plan.json").write_text(json.dumps({
                "revision": "a" * 40, "scope": ["src"],
                "entry_points": ["src/Fixture.sol:Fixture.inspect()"],
                "entry_point_inventory_complete": True, "limitations": [],
                "file_groups": [{"id": "fixture-file", "files": ["src/Fixture.sol"],
                                 "purpose": "Fixture state", "effort": "small"}],
                "entrypoint_groups": [{"id": "fixture-path", "files": ["src/Fixture.sol"],
                                       "entry_points": ["src/Fixture.sol:Fixture.inspect()"],
                                       "purpose": "External call path", "effort": "small"}],
            }))
            render("hunt")
            # Synthetic artifacts stand in for agents. No source is compiled or audited.
            for output in manifest()["expected_outputs"]:
                path = run / output["path"]
                if output["role"] == "hunter":
                    path.write_text("### Note\nSynthetic observation.\n")
                elif output["role"] == "batch-merger":
                    path.write_text("## Coverage\nSynthetic merge output.\n")
            (run / "merge/candidates.md").write_text(
                "### [C-001] First synthetic candidate\n- Severity: Medium\n"
                "- Location: src/Fixture.sol:1\n- Root cause: Synthetic fixture.\n"
                "### [C-002] Second synthetic candidate\n- Severity: Low\n"
                "- Location: src/Fixture.sol:1\n- Root cause: Synthetic fixture.\n"
            )
            cli("pareto_tools.py", "shards", run / "merge/candidates.md",
                run / "verify/shards", "--config", config)
            render("verify")
            for output in manifest()["expected_outputs"]:
                if output["role"] != "verifier":
                    continue
                lines = []
                for cid in output["candidate_ids"]:
                    verdict, severity = ("finding", "Low") if cid == "C-001" else ("invalid", "-")
                    lines.append(f"{cid}: VERDICT={verdict}; SEVERITY={severity}; "
                                 "EVIDENCE=src/Fixture.sol:1; NOTE=Synthetic verdict.")
                (run / output["path"]).write_text(
                    "\n".join(lines) + "\n" if lines else "No candidates in this shard.\n"
                )
            pre = run / "appeal/pre-report.md"
            status = assemble("pre-appeal", pre)
            self.assertTrue(status["complete"], status)
            self.assertEqual(status["rejected"], ["C-002"])
            render("appeal")
            for output in manifest()["expected_outputs"]:
                if output["role"] == "appeal":
                    (run / output["path"]).write_text(
                        "C-002: VERDICT=finding; SEVERITY=Medium; "
                        "EVIDENCE=src/Fixture.sol:1; NOTE=Synthetic appeal.\n"
                        if output["candidate_ids"] else "No candidates restored.\n"
                    )
            report = run / "report.md"
            status = assemble("final", report)
            self.assertTrue(status["complete"], status)
            appendix = report.read_text().split("## Appendix: findings outside the display filter", 1)[1].split("## Informational", 1)[0]
            self.assertIn("First synthetic candidate", appendix)

            # Reformatting a report must not invalidate completed reviews or their votes.
            config.write_text(config.read_text().replace(
                'include_severities=["High","Medium"]', 'include_severities=["High","Medium","Low"]'))
            status = assemble("final", report)
            self.assertTrue(status["complete"], status)
            low_section = report.read_text().split("## Low findings", 1)[1].split("## Appendix", 1)[0]
            self.assertIn("First synthetic candidate", low_section)
            self.assertEqual(status["include_severities"], ["High", "Medium", "Low"])
            self.assertEqual({x["id"]: x["category"] for x in status["candidates"]},
                             {"C-001": "finding", "C-002": "finding"})
            text = report.read_text()
            self.assertIn("Appendix: findings outside the display filter", text)
            self.assertIn("First synthetic candidate", text)
            self.assertNotIn("(verified)", text)

            # A missing review must not be hidden by successful report generation.
            missing = next(x for x in manifest()["expected_outputs"]
                           if x["role"] == "verifier" and "C-001" in x["candidate_ids"])
            missing_path = run / missing["path"]
            saved = missing_path.read_text()
            missing_path.unlink()
            status = assemble("final", report)
            self.assertFalse(status["complete"])
            first = next(x for x in status["candidates"] if x["id"] == "C-001")
            self.assertEqual(first["category"], "unresolved")
            self.assertEqual(first["review_counts"], {"expected": 2, "received": 1})
            self.assertIn("First synthetic candidate", report.read_text())

            missing_path.write_text(saved)
            status = assemble("final", report)
            self.assertTrue(status["complete"], status)


if __name__ == "__main__":
    unittest.main()
