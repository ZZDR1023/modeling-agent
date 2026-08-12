#!/usr/bin/env python3
"""Reproduce an exported modeling project without the TypeScript application or run database."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import zlib
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
REPRODUCIBILITY = ROOT / "reproducibility"
OUTPUT = ROOT / "reproduced"


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _safe(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    resolved_root = root.resolve()
    if path != resolved_root and resolved_root not in path.parents:
        raise RuntimeError(f"Unsafe package path: {relative}")
    return path


def _verify_package_manifest() -> int:
    payload = _read_json(REPRODUCIBILITY / "package-manifest.json")
    files = payload.get("files")
    if not isinstance(files, list):
        raise RuntimeError("package-manifest.json has no file inventory")
    for record in files:
        if not isinstance(record, dict):
            raise RuntimeError("package manifest contains an invalid record")
        path = _safe(ROOT, str(record.get("path", "")))
        if not path.is_file():
            raise RuntimeError(f"Packaged file is missing: {path.relative_to(ROOT)}")
        if path.stat().st_size != int(record.get("size_bytes", -1)):
            raise RuntimeError(f"Packaged file size mismatch: {path.relative_to(ROOT)}")
        if _sha256(path) != record.get("sha256"):
            raise RuntimeError(f"Packaged file hash mismatch: {path.relative_to(ROOT)}")
    return len(files)


def _normalise_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "task_id": result.get("task_id"),
        "plugin_id": result.get("plugin_id"),
        "status": result.get("status"),
        "selected_method": result.get("selected_method"),
        "method_results": result.get("method_results", []),
        "metrics": result.get("metrics", {}),
        "warnings": result.get("warnings", []),
        "error": result.get("error"),
    }


def _run_task(task: dict[str, Any], python_root: Path) -> dict[str, Any]:
    task_id = str(task["task_id"])
    request_template = _read_json(_safe(REPRODUCIBILITY / "experiments", str(task["request"])))
    expected_result = _read_json(_safe(REPRODUCIBILITY / "experiments", str(task["expected_result"])))
    output_root = OUTPUT / "experiments" / task_id
    output_root.mkdir(parents=True, exist_ok=True)
    request = dict(request_template)
    request["run_id"] = "standalone-reproduction"
    request["output_dir"] = str(output_root.resolve())
    rewritten_files = []
    for item in request.get("data_files", []):
        rewritten = dict(item)
        packaged_path = _safe(ROOT, str(item["absolute_path"]))
        rewritten["absolute_path"] = str(packaged_path)
        rewritten_files.append(rewritten)
    request["data_files"] = rewritten_files
    request_path = output_root / "experiment-request.json"
    _write_json(request_path, request)

    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(python_root)
    completed = subprocess.run(
        [sys.executable, "-m", "modeling_agent.runner", "--request", str(request_path)],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=900,
        check=False,
    )
    result_path = output_root / "experiment-result.json"
    if not result_path.is_file():
        raise RuntimeError(f"{task_id} did not produce experiment-result.json: {completed.stderr.strip()}")
    actual_result = _read_json(result_path)
    if completed.returncode != 0 or actual_result.get("status") != "success":
        raise RuntimeError(f"{task_id} reproduction failed: {completed.stderr.strip() or completed.stdout.strip()}")
    if _normalise_result(actual_result) != _normalise_result(expected_result):
        raise RuntimeError(f"{task_id} reproduced result does not match the frozen semantic result")

    verified = 0
    frozen_attempt = _safe(REPRODUCIBILITY / "experiments", str(task["request"])).parent
    for artifact in task.get("expected_artifacts", []):
        artifact_path = _safe(output_root, str(artifact["path"]))
        frozen_path = _safe(frozen_attempt, str(artifact["path"]))
        if not frozen_path.is_file():
            raise RuntimeError(f"{task_id} frozen artifact is missing: {artifact['path']}")
        if frozen_path.stat().st_size != int(artifact["size_bytes"]) or _sha256(frozen_path) != artifact["sha256"]:
            raise RuntimeError(f"{task_id} frozen artifact does not match its manifest: {artifact['path']}")
        if not artifact_path.is_file():
            raise RuntimeError(f"{task_id} reproduced artifact is missing: {artifact['path']}")
        if artifact_path.stat().st_size != int(artifact["size_bytes"]):
            raise RuntimeError(f"{task_id} reproduced artifact size mismatch: {artifact['path']}")
        if _sha256(artifact_path) != artifact["sha256"]:
            raise RuntimeError(f"{task_id} reproduced artifact hash mismatch: {artifact['path']}")
        verified += 1
    return {"task_id": task_id, "status": "verified", "verified_artifact_count": verified}


def _pdf_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _fallback_pdf(title: str, markdown: str) -> bytes:
    lines = [title] + [line.strip() for line in markdown.splitlines() if line.strip()]
    lines = [line.encode("ascii", "replace").decode("ascii")[:92] for line in lines[:50]]
    operations = ["BT", "/F1 10 Tf", "50 790 Td", "12 TL"]
    for index, line in enumerate(lines):
        if index:
            operations.append("T*")
        operations.append(f"({_pdf_text(line)}) Tj")
    operations.append("ET")
    stream = zlib.compress(("\n".join(operations) + "\n").encode("ascii"))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        f"<< /Length {len(stream)} /Filter /FlateDecode >>\nstream\n".encode("ascii") + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    header = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    chunks = [header]
    offsets = [0]
    cursor = len(header)
    for number, body in enumerate(objects, start=1):
        record = f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
        offsets.append(cursor)
        chunks.append(record)
        cursor += len(record)
    xref_offset = cursor
    xref = ["xref", f"0 {len(objects) + 1}", "0000000000 65535 f "]
    xref.extend(f"{offset:010d} 00000 n " for offset in offsets[1:])
    trailer = "\n".join(xref) + f"\ntrailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n"
    chunks.append(trailer.encode("ascii"))
    return b"".join(chunks)


def _build_report() -> tuple[str, str | None]:
    deliverables = OUTPUT / "deliverables"
    deliverables.mkdir(parents=True, exist_ok=True)
    source_markdown = ROOT / "deliverables" / "report.md"
    source_tex = ROOT / "deliverables" / "report.tex"
    markdown = deliverables / "report.md"
    tex = deliverables / "report.tex"
    shutil.copy2(source_markdown, markdown)
    shutil.copy2(source_tex, tex)
    renderer = "builtin"
    warning: str | None = None
    xelatex = shutil.which("xelatex")
    if xelatex:
        completed = subprocess.run(
            [xelatex, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-output-directory", ".", tex.name],
            cwd=deliverables,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
            check=False,
        )
        if completed.returncode == 0 and (deliverables / "report.pdf").is_file():
            renderer = "xelatex"
        else:
            warning = f"xelatex exited with {completed.returncode}; used the bundled PDF renderer"
    if renderer == "builtin":
        title = _read_json(REPRODUCIBILITY / "problem-spec.json").get("title", "Reproduced report")
        (deliverables / "report.pdf").write_bytes(_fallback_pdf(str(title), markdown.read_text(encoding="utf-8")))
    for suffix in ("aux", "log", "out", "toc"):
        (deliverables / f"report.{suffix}").unlink(missing_ok=True)
    return renderer, warning


def main() -> int:
    try:
        package_file_count = _verify_package_manifest()
        config = _read_json(REPRODUCIBILITY / "reproduce.json")
        tasks = config.get("tasks")
        if not isinstance(tasks, list) or not tasks:
            raise RuntimeError("reproduce.json has no frozen experiment tasks")
        if OUTPUT.exists():
            shutil.rmtree(OUTPUT)
        python_root = REPRODUCIBILITY / "python"
        task_results = [_run_task(task, python_root) for task in tasks]
        renderer, warning = _build_report()
        result = {
            "schema_version": "1.0.0",
            "status": "success",
            "package_file_count": package_file_count,
            "task_count": len(tasks),
            "verified_task_count": len(task_results),
            "tasks": task_results,
            "report_pdf": "deliverables/report.pdf",
            "report_renderer": renderer,
            "warning": warning,
        }
        _write_json(OUTPUT / "reproduction-result.json", result)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as error:
        failure = {"status": "failed", "error": {"class": "standalone_reproduction_failure", "message": str(error)}}
        print(json.dumps(failure, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
