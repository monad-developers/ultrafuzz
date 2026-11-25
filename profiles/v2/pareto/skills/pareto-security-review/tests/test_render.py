"""Offline checks of configuration and task rendering; no audit is launched."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
from config import load_config
from render import render_phase, validate_plan, inventory


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pareto-render-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "source space"
        (self.workspace / "src").mkdir(parents=True)
        (self.workspace / "src/Pool.sol").write_text("contract Pool { function deposit() external {} }\n")
        self.run = self.root / "run space"
        self.config = self.root / "config.toml"
        self.config.write_text('''[target]
project = "Sample"
repository = "example/fixture"
revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
workspace = ''' + json.dumps(str(self.workspace)) + '''
scope = ["src"]
threat_model = "Untrusted users; trusted administrators."
[workflow]
number_of_hunters = 3
file_hunters_per_group = 2
entrypoint_hunters_per_group = 1
merge_batch_size = 2
number_of_shards = 2
verifiers_per_shard = 2
appeal_reviewers = 2
''')
        self.plan = {
            "revision": "a" * 40, "scope": ["src"],
            "entry_points": ["src/Pool.sol:Pool.deposit()"],
            "entry_point_inventory_complete": True, "limitations": [],
            "file_groups": [{"id": "pool-file", "files": ["src/Pool.sol"], "purpose": "Pool state", "effort": "small"}],
            "entrypoint_groups": [{"id": "pool-path", "files": ["src/Pool.sol"], "entry_points": ["src/Pool.sol:Pool.deposit()"], "purpose": "Deposit path", "effort": "small"}],
        }

    def prepared(self):
        render_phase("prepare", self.config, self.run)
        (self.run / "partition-plan.json").write_text(json.dumps(self.plan))
        render_phase("hunt", self.config, self.run)

    def test_defaults_no_budget_and_configurable_counts(self):
        config = load_config(self.config)
        self.assertNotIn("budget_usd", config["runtime"])
        self.assertEqual(config["workflow"]["number_of_hunters"], 3)
        self.assertEqual(config["workflow"]["appeal_restore_limit"], 2)
        self.assertEqual(config["runtime"]["max_output_tokens"], 131072)

    def test_invalid_configuration_rejected(self):
        for text in ('[workflow]\nnumber_of_shards=0\n', '[workflow]\nnumber_of_hunters=true\n',
                     '[workflow]\nrejection_min_votes=3\n', '[runtime]\nbudget_usd=-1\n',
                     '[workflow]\nunknown_setting=1\n'):
            with self.subTest(text=text):
                self.config.write_text(text)
                with self.assertRaises(ValueError):
                    load_config(self.config)

    def test_placeholder_target_cannot_prepare(self):
        with self.assertRaisesRegex(ValueError, "placeholders"):
            render_phase("prepare", SKILL / "config.toml", self.run)

    def test_plan_coverage_and_explicit_hunter_total(self):
        config = load_config(self.config)
        groups = validate_plan(self.plan, config, inventory(config))
        self.assertEqual(sum(g["hunters"] for g in groups), 3)
        self.plan["file_groups"] = []
        with self.assertRaisesRegex(ValueError, "exactly one"):
            validate_plan(self.plan, config, inventory(config))

    def test_scope_cannot_leave_workspace(self):
        self.config.write_text(self.config.read_text().replace('["src"]', '["../outside"]'))
        with self.assertRaisesRegex(ValueError, "workspace-relative"):
            render_phase("prepare", self.config, self.run)

    def test_entry_point_inventory_limitation_required(self):
        self.plan["entry_point_inventory_complete"] = False
        with self.assertRaisesRegex(ValueError, "limitation"):
            validate_plan(self.plan, load_config(self.config), ["src/Pool.sol"])
        self.plan["limitations"] = ["Dynamic entry points not inventoried."]
        self.assertEqual(len(validate_plan(self.plan, load_config(self.config), ["src/Pool.sol"])), 2)

    def test_hunt_mergers_manifest_and_readable_prompts(self):
        self.prepared()
        manifest = json.loads((self.run / "manifest.json").read_text())
        self.assertEqual(manifest["prepared_stages"], ["hunt"])
        outputs = manifest["expected_outputs"]
        self.assertEqual(len(outputs), 6)  # 3 hunters + 2 batch mergers + final merger
        self.assertEqual(sum(x["role"] == "hunter" for x in outputs), 3)
        final = (self.run / "tasks/merger-final.txt").read_text()
        self.assertIn("batch-1.md", final)
        self.assertIn("batch-2.md", final)
        self.assertNotIn("batch-9.md", final)
        for prompt in (self.run / "tasks").glob("*.txt"):
            self.assertNotIn("{{", prompt.read_text())
        hunter = (self.run / "tasks/reviewer-01.txt").read_text()
        self.assertIn("forge build --threads 1", hunter)
        self.assertIn("test -s '", hunter)  # shell quoting survives a workspace with spaces

    def test_repeated_render_preserves_results_and_detects_changes(self):
        self.prepared()
        report = self.run / "agents/reviewer-01/report.md"
        report.write_text("Completed review\n")
        before = (self.run / "manifest.json").read_bytes()
        render_phase("hunt", self.config, self.run)
        self.assertEqual(report.read_text(), "Completed review\n")
        self.assertEqual(before, (self.run / "manifest.json").read_bytes())
        self.config.write_text(self.config.read_text().replace("number_of_hunters = 3", "number_of_hunters = 4"))
        with self.assertRaisesRegex(ValueError, "configuration changed"):
            render_phase("hunt", self.config, self.run)
        self.assertEqual(report.read_text(), "Completed review\n")

    def test_verify_then_appeal_candidate_assignments(self):
        self.prepared()
        shards = self.run / "verify/shards"
        shards.mkdir(parents=True)
        (shards / "shard-01.md").write_text("# Shard 01\n### [C-001] Sample\n")
        (shards / "shard-02.md").write_text("No candidates in this shard.\n")
        (self.run / "merge/candidates.md").write_text("### [C-001] Sample\n")
        render_phase("verify", self.config, self.run)
        manifest = json.loads((self.run / "manifest.json").read_text())
        verify = [x for x in manifest["expected_outputs"] if x["role"] == "verifier"]
        self.assertEqual(len(verify), 4)
        self.assertEqual(verify[0]["candidate_ids"], ["C-001"])
        self.assertEqual(verify[-1]["candidate_ids"], [])
        self.assertIn("Write exactly No candidates in this shard.", (self.run / "tasks/verifier-a-02.txt").read_text())
        appeal = self.run / "appeal"
        appeal.mkdir()
        (appeal / "pre-report.md").write_text("Partial report\n")
        (appeal / "pre-report.md.status.json").write_text(json.dumps({"rejected": ["C-001"]}))
        render_phase("appeal", self.config, self.run)
        manifest = json.loads((self.run / "manifest.json").read_text())
        self.assertEqual(manifest["prepared_stages"], ["hunt", "verify", "appeal"])
        appeals = [x for x in manifest["expected_outputs"] if x["role"] == "appeal"]
        self.assertEqual([x["candidate_ids"] for x in appeals], [[], ["C-001"]])

    def test_supplied_reports_policy_and_search_independent(self):
        reference = self.root / "prior-report.md"
        reference.write_text("Previous report")
        self.config.write_text(self.config.read_text() + '\n[references]\nsupplied_reports = [' + json.dumps(str(reference)) + ']\nallow_search = false\n')
        self.prepared()
        hunter = (self.run / "tasks/reviewer-01.txt").read_text()
        self.assertIn(str(reference), hunter)
        self.assertIn("Known does not mean fixed or false", hunter)
        self.assertIn("Do not search for or fetch additional reports", hunter)

    def test_stale_shard_bodies_cannot_be_bound_to_revised_candidates(self):
        self.prepared()
        shards = self.run / "verify/shards"
        shards.mkdir(parents=True)
        (shards / "shard-01.md").write_text("### [C-001] Sample\nOld evidence.\n")
        (shards / "shard-02.md").write_text("No candidates in this shard.\n")
        (self.run / "merge/candidates.md").write_text("### [C-001] Sample\nNew evidence.\n")
        with self.assertRaisesRegex(ValueError, "Shard contents differ"):
            render_phase("verify", self.config, self.run)

    def test_appeals_cannot_resume_after_pre_report_evidence_changes(self):
        self.test_verify_then_appeal_candidate_assignments()
        (self.run / "appeal/appeal-2.md").write_text("Saved restoration.\n")
        (self.run / "appeal/pre-report.md").write_text("Different rejection evidence for the same candidate.\n")
        with self.assertRaisesRegex(ValueError, "Inputs for appeal changed"):
            render_phase("appeal", self.config, self.run)
        self.assertEqual((self.run / "appeal/appeal-2.md").read_text(), "Saved restoration.\n")


if __name__ == "__main__":
    unittest.main()
