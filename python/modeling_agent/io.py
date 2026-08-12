from __future__ import annotations

import csv
import hashlib
import json
import mimetypes
import os
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


class ExperimentFailure(Exception):
    def __init__(self, error_class: str, message: str) -> None:
        super().__init__(message)
        self.error_class = error_class


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_csv(path: Path) -> pd.DataFrame:
    try:
        return pd.read_csv(path)
    except UnicodeDecodeError:
        return pd.read_csv(path, encoding="gb18030")


def read_table(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return _read_csv(path)
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(path)
    if suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, list):
            return pd.DataFrame(payload)
        if isinstance(payload, dict):
            return pd.DataFrame(payload)
        raise ExperimentFailure("data_quality_blocker", "JSON input is neither an array nor an object table.")
    if suffix == ".parquet":
        return pd.read_parquet(path)
    raise ExperimentFailure("unsupported_capability", f"Unsupported tabular input: {path.name}")


def choose_table(data_files: list[dict[str, Any]], config: dict[str, Any]) -> tuple[Path, pd.DataFrame]:
    requested = config.get("data_file")
    candidates = [(Path(item["absolute_path"]), str(item.get("relative_path", ""))) for item in data_files]
    if requested:
        requested_value = Path(str(requested)).as_posix()
        requested_path = next((path for path, relative_path in candidates if relative_path == requested_value or path.name == Path(requested_value).name), None)
        if requested_path is None:
            raise ExperimentFailure("data_quality_blocker", f"Configured data_file was not found: {requested}")
        return requested_path, read_table(requested_path)
    for path, _ in candidates:
        if path.suffix.lower() in {".csv", ".xlsx", ".xls", ".json", ".parquet"}:
            return path, read_table(path)
    raise ExperimentFailure("unsupported_capability", "No supported tabular data file was found.")


def numeric_frame(frame: pd.DataFrame) -> pd.DataFrame:
    numeric = frame.select_dtypes(include=[np.number]).copy()
    if numeric.empty:
        raise ExperimentFailure("data_quality_blocker", "No numeric columns were found.")
    return numeric.replace([np.inf, -np.inf], np.nan)


def pick_target(frame: pd.DataFrame, config: dict[str, Any], exclude: set[str] | None = None) -> str:
    exclude = exclude or set()
    requested = config.get("target_column")
    if requested is not None:
        if str(requested) not in frame.columns:
            raise ExperimentFailure("data_quality_blocker", f"target_column not found: {requested}")
        return str(requested)
    candidates = [column for column in frame.columns if column not in exclude and pd.api.types.is_numeric_dtype(frame[column])]
    if not candidates:
        raise ExperimentFailure("data_quality_blocker", "Could not infer a numeric target column; set target_column.")
    return str(candidates[-1])


def pick_features(frame: pd.DataFrame, target: str, config: dict[str, Any]) -> list[str]:
    requested = config.get("feature_columns")
    if requested:
        features = [str(column) for column in requested]
        missing = [column for column in features if column not in frame.columns]
        if missing:
            raise ExperimentFailure("data_quality_blocker", f"Feature columns not found: {missing}")
        return features
    return [str(column) for column in frame.select_dtypes(include=[np.number]).columns if str(column) != target]


def artifact_record(path: Path, root: Path, kind: str = "other", media_type: str | None = None) -> dict[str, Any]:
    media_type = media_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return {
        "kind": kind,
        "relative_path": path.relative_to(root).as_posix(),
        "media_type": media_type,
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
    }


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def finite(value: float) -> float | None:
    return float(value) if np.isfinite(value) else None
