from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from modeling_agent.runner import execute_request


class RunnerContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="modeling-python-"))
        self.data = self.root / "data.csv"
        rows = ["date,x1,x2,target,class"]
        for index in range(1, 41):
            rows.append(f"2024-{(index - 1) // 10 + 1:02d}-{(index - 1) % 10 + 1:02d},{index},{index % 5},{2 * index + (index % 3)},{'A' if index % 2 else 'B'}")
        self.data.write_text("\n".join(rows) + "\n", encoding="utf-8")

    def request(self, task_type: str, config: dict[str, object] | None = None) -> dict[str, object]:
        task = {
            "id": "task-001",
            "title": task_type,
            "task_type": task_type,
            "objective": f"Run {task_type}",
            "requirement_ids": ["req-001"],
            "depends_on": [],
            "input_artifact_ids": ["input-data"],
            "evidence_level": "experimental" if task_type == "custom_experiment" else "standard",
            "budget": {"max_attempts": 1, "max_runtime_seconds": 60, "max_tokens": 1000},
            "config": config or {},
        }
        return {
            "schema_version": "1.0.0",
            "run_id": "run-test",
            "attempt_id": "attempt-test",
            "task": task,
            "evaluation_contract": {
                "schema_version": "1.0.0",
                "contract_id": "eval-task-001",
                "task_id": "task-001",
                "task_type": task_type,
                "primary_objective": task["objective"],
                "metrics": [{"name": "metric", "direction": "target", "role": "primary"}],
                "hard_checks": ["execution_succeeded"],
                "selection_rule": "retain valid result",
                "frozen_at": "2024-01-01T00:00:00Z",
            },
            "data_files": [{
                "artifact_id": "input-data",
                "relative_path": "data.csv",
                "absolute_path": str(self.data),
                "media_type": "text/csv",
                "size_bytes": self.data.stat().st_size,
                "sha256": hashlib.sha256(self.data.read_bytes()).hexdigest(),
            }],
            "output_dir": str(self.root / task_type),
            "random_seed": 7,
            "task_config": config or {},
        }

    def test_all_registered_task_families_produce_contract_results(self) -> None:
        configs = {
            "regression_prediction": {"target_column": "target"},
            "time_series_forecasting": {"target_column": "target", "horizon": 3},
            "classification": {"target_column": "class"},
            "optimization": {"objective": "maximize target"},
            "custom_experiment": {"operation": "bootstrap_mean"},
        }
        for task_type in [
            "statistical_analysis",
            "regression_prediction",
            "time_series_forecasting",
            "classification",
            "clustering",
            "evaluation_ranking",
            "optimization",
            "simulation",
            "custom_experiment",
        ]:
            with self.subTest(task_type=task_type):
                result = execute_request(self.request(task_type, configs.get(task_type)))
                self.assertEqual(result["schema_version"], "1.0.0")
                self.assertEqual(result["status"], "success", result.get("error"))
                self.assertTrue(result["selected_method"])
                self.assertTrue(result["runtime"]["python_version"])
                self.assertGreater(len(result["artifacts"]), 0)
                for artifact in result["artifacts"]:
                    self.assertFalse(Path(artifact["relative_path"]).is_absolute())
                    self.assertNotIn("..", Path(artifact["relative_path"]).parts)
                    self.assertRegex(artifact["sha256"], r"^[a-f0-9]{64}$")

    def test_unsupported_task_type_is_structured(self) -> None:
        result = execute_request(self.request("unknown_task_type"))
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(result["error"]["class"], "unsupported_capability")
        self.assertTrue(result["error"]["fingerprint"])

    def test_tampered_input_is_structured_failure(self) -> None:
        request = self.request("statistical_analysis")
        request["data_files"][0]["sha256"] = "0" * 64
        result = execute_request(request)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["class"], "input_integrity_failure")

    def test_invalid_contract_with_output_dir_writes_failure_manifest(self) -> None:
        request = self.request("statistical_analysis")
        del request["evaluation_contract"]
        result = execute_request(request)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["class"], "contract_failure")
        manifest = Path(request["output_dir"]) / "experiment-result.json"
        self.assertTrue(manifest.is_file())
        self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["status"], "failed")

    def test_invalid_input_is_structured_failure(self) -> None:
        request = self.request("regression_prediction", {"target_column": "missing"})
        result = execute_request(request)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["class"], "data_quality_blocker")
        self.assertTrue(result["error"]["fingerprint"])


if __name__ == "__main__":
    unittest.main()
