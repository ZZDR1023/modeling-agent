from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import standalone_reproduce


class StandaloneReportTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary_directory = tempfile.TemporaryDirectory(prefix="standalone-report-")
        self.addCleanup(temporary_directory.cleanup)
        self.root = Path(temporary_directory.name)
        deliverables = self.root / "deliverables"
        deliverables.mkdir()
        (deliverables / "report.md").write_text("# Deterministic report\n", encoding="utf-8")
        (deliverables / "report.tex").write_text("\\documentclass{article}\n", encoding="utf-8")
        self.reproducibility = self.root / "reproducibility"
        self.reproducibility.mkdir()
        (self.reproducibility / "problem-spec.json").write_text(
            json.dumps({"title": "Deterministic report"}),
            encoding="utf-8",
        )
        self.output = self.root / "reproduced"

    def build_report(self) -> tuple[str, str | None]:
        with (
            patch.object(standalone_reproduce, "ROOT", self.root),
            patch.object(standalone_reproduce, "REPRODUCIBILITY", self.reproducibility),
            patch.object(standalone_reproduce, "OUTPUT", self.output),
        ):
            return standalone_reproduce._build_report()

    def assert_builtin_fallback_warning(self, warning: str | None, reason: str) -> None:
        self.assertIsInstance(warning, str)
        normalized = warning.lower()
        for phrase in ("xelatex", reason, "bundled", "fallback"):
            self.assertIn(phrase, normalized)
        self.assertTrue((self.output / "deliverables" / "report.pdf").read_bytes().startswith(b"%PDF-"))

    def test_missing_xelatex_uses_builtin_renderer_with_honest_warning(self) -> None:
        with patch.object(standalone_reproduce.shutil, "which", return_value=None) as which:
            renderer, warning = self.build_report()

        which.assert_called_once_with("xelatex")
        self.assertEqual(renderer, "builtin")
        self.assert_builtin_fallback_warning(warning, "unavailable")

    def test_failed_xelatex_uses_builtin_renderer_and_preserves_warning(self) -> None:
        failure = subprocess.CompletedProcess(args=["xelatex"], returncode=9, stdout="", stderr="compile failed")
        with (
            patch.object(standalone_reproduce.shutil, "which", return_value="/mock/xelatex"),
            patch.object(standalone_reproduce.subprocess, "run", return_value=failure) as run,
        ):
            renderer, warning = self.build_report()

        run.assert_called_once()
        self.assertEqual(renderer, "builtin")
        self.assert_builtin_fallback_warning(warning, "failed")


if __name__ == "__main__":
    unittest.main()
