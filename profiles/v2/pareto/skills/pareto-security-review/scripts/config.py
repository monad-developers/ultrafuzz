"""Read Pareto's portable TOML configuration. No launch or build side effects."""
from __future__ import annotations

import copy
import math
import re
import tomllib
from pathlib import Path

DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / "config.toml"


def load_config(path: str | Path = DEFAULT_CONFIG, require_target: bool = False) -> dict:
    """Merge a per-review file over the packaged defaults and check simple types."""
    with DEFAULT_CONFIG.open("rb") as stream:
        result = tomllib.load(stream)
    with Path(path).open("rb") as stream:
        supplied = tomllib.load(stream)
    for section, values in supplied.items():
        if section not in result or not isinstance(values, dict):
            raise ValueError(f"Unknown or invalid config section: {section}")
        allowed = set(result[section]) | ({"budget_usd"} if section == "runtime" else set())
        for key, value in values.items():
            if key not in allowed:
                raise ValueError(f"Unknown config key: {section}.{key}")
            result[section][key] = value
    for key, value in result["workflow"].items():
        minimum = 0 if key in {"retry_count", "retry_delay_seconds", "negative_evidence_min_chars"} else 1
        if type(value) is not int or value < minimum:
            raise ValueError(f"workflow.{key} must be an integer >= {minimum}")
    if result["workflow"]["rejection_min_votes"] > result["workflow"]["verifiers_per_shard"]:
        raise ValueError("rejection_min_votes cannot exceed verifiers_per_shard")
    for key in ("max_output_tokens", "review_timeout_seconds", "sandbox_timeout_seconds", "task_timeout_seconds", "cpu", "memory_mib", "minimum_free_disk_gib", "build_threads"):
        value = result["runtime"][key]
        if type(value) is not int or value < 1:
            raise ValueError(f"runtime.{key} must be a positive integer")
    for key in ("profile", "harness", "model", "reasoning_effort"):
        if not isinstance(result["runtime"][key], str) or not result["runtime"][key].strip():
            raise ValueError(f"runtime.{key} must be a nonempty string")
    budget = result["runtime"].get("budget_usd")
    if budget is not None and (type(budget) not in (float, int) or not math.isfinite(budget) or budget <= 0):
        raise ValueError("runtime.budget_usd must be positive when supplied")
    if type(result["references"]["allow_search"]) is not bool:
        raise ValueError("references.allow_search must be a boolean")
    for section, key in (("target", "scope"), ("references", "supplied_reports"), ("reporting", "include_severities")):
        value = result[section][key]
        if not isinstance(value, list) or any(not isinstance(x, str) or not x for x in value):
            raise ValueError(f"{section}.{key} must be a list of nonempty strings")
    if not result["target"]["scope"]:
        raise ValueError("target.scope must not be empty")
    if any(s not in ("High", "Medium", "Low") for s in result["reporting"]["include_severities"]):
        raise ValueError("reporting.include_severities accepts High, Medium and Low")
    for key in ("project", "repository", "revision", "workspace", "threat_model"):
        value = result["target"][key]
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"target.{key} must be a nonempty string")
    if require_target:
        target = result["target"]
        for value in [target[k] for k in ("project", "repository", "revision", "workspace", "threat_model")] + target["scope"]:
            if re.search(r"\[(?:PROJECT|REPOSITORY|REVISION|WORKSPACE|AUDIT_SCOPE|THREAT_MODEL)\]", value):
                raise ValueError("Fill target placeholders before preparing a review")
        if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", target["revision"]):
            raise ValueError("target.revision must be a full commit ID")
        workspace = Path(target["workspace"])
        if not workspace.is_absolute() or not workspace.is_dir():
            raise ValueError("target.workspace must be an existing absolute directory")
        for report in result["references"]["supplied_reports"]:
            if not Path(report).is_absolute() or not Path(report).is_file():
                raise ValueError("Each supplied report must be an existing absolute file")
    return copy.deepcopy(result)
