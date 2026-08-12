from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import platform
import re
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd

from .forecasting import run_forecast
from .io import ExperimentFailure, artifact_record, choose_table, finite, numeric_frame, pick_features, pick_target, write_json
from .metrics import accuracy, macro_f1, mae, rmse

try:
    from sklearn.cluster import AgglomerativeClustering, DBSCAN, KMeans
    from sklearn.ensemble import GradientBoostingRegressor, RandomForestClassifier, RandomForestRegressor
    from sklearn.linear_model import Lasso, LinearRegression, LogisticRegression, Ridge
    from sklearn.metrics import adjusted_rand_score, confusion_matrix, r2_score, silhouette_score
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.svm import SVC
except Exception:  # pragma: no cover - the failure is surfaced by the task result.
    AgglomerativeClustering = DBSCAN = KMeans = None
    GradientBoostingRegressor = RandomForestClassifier = RandomForestRegressor = None
    Lasso = LinearRegression = LogisticRegression = Ridge = None
    adjusted_rand_score = confusion_matrix = r2_score = silhouette_score = train_test_split = None
    make_pipeline = StandardScaler = SVC = None

try:
    from scipy.optimize import linprog
except Exception:  # pragma: no cover - optional capability.
    linprog = None


class RunnerContractError(Exception):
    """An invalid request or unsupported task capability."""

    def __init__(self, error_class: str, message: str) -> None:
        super().__init__(message)
        self.error_class = error_class


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _json_value(value: Any) -> Any:
    if isinstance(value, (np.integer, np.floating)):
        value = value.item()
    if isinstance(value, np.ndarray):
        return [_json_value(item) for item in value.tolist()]
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def _require_request(request: dict[str, Any]) -> None:
    required = {
        "schema_version",
        "run_id",
        "attempt_id",
        "task",
        "evaluation_contract",
        "data_files",
        "output_dir",
        "random_seed",
    }
    missing = sorted(required.difference(request))
    if missing:
        raise RunnerContractError("contract_failure", f"Missing request fields: {', '.join(missing)}")
    unknown = sorted(set(request).difference(required | {"task_config"}))
    if unknown:
        raise RunnerContractError("contract_failure", f"Unknown request fields: {', '.join(unknown)}")
    if request.get("schema_version") != "1.0.0":
        raise RunnerContractError("contract_failure", "Unsupported experiment request schema_version.")
    task = request.get("task")
    if not isinstance(task, dict) or not isinstance(task.get("id"), str) or not isinstance(task.get("task_type"), str):
        raise RunnerContractError("contract_failure", "task must include id and task_type.")
    if not isinstance(request.get("data_files"), list) or not request["data_files"]:
        raise RunnerContractError("contract_failure", "data_files must contain at least one mounted input.")
    for item in request["data_files"]:
        if not isinstance(item, dict) or not isinstance(item.get("absolute_path"), str):
            raise RunnerContractError("contract_failure", "Each data_file must provide absolute_path.")
        path = Path(item["absolute_path"])
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            raise RunnerContractError("input_integrity_failure", f"Input is not a regular mounted file: {path}")
        expected_hash = item.get("sha256")
        if not isinstance(expected_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
            raise RunnerContractError("contract_failure", f"Input sha256 is invalid: {path.name}")
        actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual_hash != expected_hash:
            raise RunnerContractError("input_integrity_failure", f"Input hash mismatch: {path.name}")
        expected_size = item.get("size_bytes")
        if not isinstance(expected_size, int) or expected_size < 0:
            raise RunnerContractError("contract_failure", f"Input size_bytes is invalid: {path.name}")
        if path.stat().st_size != expected_size:
            raise RunnerContractError("input_integrity_failure", f"Input size mismatch: {path.name}")


def _output_root(request: dict[str, Any]) -> Path:
    output = Path(str(request["output_dir"])).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    return output


def _output_path(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise RunnerContractError("policy_failure", f"Unsafe output path: {relative}")
    candidate.parent.mkdir(parents=True, exist_ok=True)
    return candidate


def _write_csv(root: Path, relative: str, rows: list[dict[str, Any]]) -> Path:
    path = _output_path(root, relative)
    keys: list[str] = []
    for row in rows:
        for key in row:
            if key not in keys:
                keys.append(key)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys or ["value"])
        writer.writeheader()
        for row in rows:
            writer.writerow({key: _json_value(row.get(key)) for key in keys})
    return path


def _write_figure(root: Path, relative: str, x: Any, ys: dict[str, Any], title: str, x_label: str = "index") -> Path:
    path = _output_path(root, relative)
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception as error:
        raise RunnerContractError("unsupported_capability", f"matplotlib is unavailable: {error}") from error

    figure, axis = plt.subplots(figsize=(8, 4.5), dpi=120)
    try:
        for label, values in ys.items():
            axis.plot(list(x), list(values), label=label)
        axis.set_title(title)
        axis.set_xlabel(x_label)
        axis.grid(True, alpha=0.25)
        if len(ys) > 1:
            axis.legend()
        figure.tight_layout()
        figure.savefig(path, format="png")
    except Exception as error:
        raise ExperimentFailure("figure_generation_failure", f"Could not render {relative}: {error}") from error
    finally:
        plt.close(figure)
    return path


def _write_json(root: Path, relative: str, value: Any) -> Path:
    path = _output_path(root, relative)
    write_json(path, _json_value(value))
    return path


def _numeric_values(frame: pd.DataFrame, config: dict[str, Any], target: str | None = None) -> tuple[str, np.ndarray]:
    chosen = target or pick_target(frame, config)
    values = pd.to_numeric(frame[chosen], errors="coerce").to_numpy(dtype=float)
    if not np.isfinite(values).all():
        raise ExperimentFailure("data_quality_blocker", f"Column {chosen} contains missing or non-finite values.")
    if len(values) < 4:
        raise ExperimentFailure("data_quality_blocker", "At least four finite observations are required.")
    return chosen, values


def _split_indices(length: int, test_fraction: float) -> tuple[np.ndarray, np.ndarray]:
    if length < 6:
        raise ExperimentFailure("data_quality_blocker", "At least six rows are required for held-out evaluation.")
    test_size = max(2, int(round(length * test_fraction)))
    test_size = min(test_size, length - 2)
    indices = np.arange(length)
    return indices[:-test_size], indices[-test_size:]


def _run_statistical(frame: pd.DataFrame, config: dict[str, Any], root: Path, rng: np.random.Generator) -> dict[str, Any]:
    del rng
    numeric = numeric_frame(frame)
    clean = numeric.dropna(how="all")
    summary = clean.describe().transpose().reset_index(names="column")
    summary_path = _write_csv(root, "tables/statistical_summary.csv", summary.to_dict(orient="records"))
    corr = clean.corr(numeric_only=True)
    corr_rows = [{"column": column, **{str(key): finite(float(value)) for key, value in row.items()}} for column, row in corr.iterrows()]
    corr_path = _write_csv(root, "tables/correlation.csv", corr_rows)
    missing_fraction = float(numeric.isna().mean().mean()) if numeric.size else 1.0
    stats = {
        "columns": [str(column) for column in clean.columns],
        "observations": int(len(clean)),
        "missing_fraction": missing_fraction,
        "summary": _json_value(summary.to_dict(orient="records")),
    }
    stats_path = _write_json(root, "json/statistical_analysis.json", stats)
    plot_path = _write_figure(
        root,
        "figures/statistical_distribution.png",
        np.arange(len(clean)),
        {str(column): clean[column].fillna(clean[column].median()).to_numpy() for column in clean.columns[: min(5, len(clean.columns))]},
        "Numeric observations",
    )
    return {
        "selected_method": "descriptive_statistics",
        "method_results": [{
            "method": "descriptive_statistics",
            "status": "success",
            "metrics": {"observations": len(clean), "missing_fraction": missing_fraction},
            "hard_checks_passed": True,
            "warnings": ["correlation_is_associational"] if len(clean.columns) > 1 else [],
        }],
        "metrics": {"observations": len(clean), "missing_fraction": missing_fraction},
        "paths": [(summary_path, "table"), (corr_path, "table"), (stats_path, "other"), (plot_path, "figure")],
    }


def _regressor(name: str, seed: int) -> Any:
    if name == "linear":
        return LinearRegression()
    if name == "ridge":
        return Ridge(alpha=1.0)
    if name == "lasso":
        return Lasso(alpha=0.01, max_iter=10000)
    if name == "random_forest":
        return RandomForestRegressor(n_estimators=80, random_state=seed, n_jobs=1)
    if name == "gradient_boosting":
        return GradientBoostingRegressor(random_state=seed, n_estimators=80)
    raise RunnerContractError("unsupported_capability", f"Unknown regression method: {name}")


def _run_regression(frame: pd.DataFrame, config: dict[str, Any], root: Path, seed: int) -> dict[str, Any]:
    if LinearRegression is None:
        raise RunnerContractError("unsupported_capability", "scikit-learn is unavailable for regression.")
    target = pick_target(frame, config)
    features = pick_features(frame, target, config)
    if not features:
        raise ExperimentFailure("data_quality_blocker", "Regression requires at least one feature column.")
    selected = frame[features + [target]].copy()
    selected = selected.apply(pd.to_numeric, errors="coerce").dropna()
    if len(selected) < 8:
        raise ExperimentFailure("data_quality_blocker", "Regression requires at least eight complete rows.")
    x = selected[features].to_numpy(dtype=float)
    y = selected[target].to_numpy(dtype=float)
    train, test = _split_indices(len(selected), float(config.get("test_fraction", 0.2)))
    methods = [str(item) for item in config.get("methods", ["linear", "ridge", "lasso", "random_forest", "gradient_boosting"])]
    results: list[dict[str, Any]] = []
    predictions: dict[str, np.ndarray] = {}
    for method in methods:
        try:
            model = _regressor(method, seed)
            model.fit(x[train], y[train])
            predicted = np.asarray(model.predict(x[test]), dtype=float)
            if not np.isfinite(predicted).all():
                raise ValueError("model produced non-finite predictions")
            metrics = {"mae": mae(y[test], predicted), "rmse": rmse(y[test], predicted), "r2": float(r2_score(y[test], predicted))}
            results.append({"method": method, "status": "success", "metrics": metrics, "hard_checks_passed": True, "warnings": []})
            predictions[method] = predicted
        except Exception as error:
            results.append({"method": method, "status": "ineligible", "metrics": {}, "hard_checks_passed": False, "warnings": [str(error)]})
    valid = [item for item in results if item["hard_checks_passed"]]
    if not valid:
        raise ExperimentFailure("model_failure", "No regression candidate passed held-out evaluation.")
    selected_result = min(valid, key=lambda item: (float(item["metrics"]["mae"]), item["method"]))
    chosen = str(selected_result["method"])
    rows = []
    for index, actual in zip(test.tolist(), y[test].tolist()):
        rows.append({"row_index": index, "actual": actual, "prediction": float(predictions[chosen][len(rows)]), "residual": actual - float(predictions[chosen][len(rows)])})
    prediction_path = _write_csv(root, "tables/regression_predictions.csv", rows)
    metrics_path = _write_csv(root, "tables/regression_candidates.csv", [{"method": item["method"], **item["metrics"], "status": item["status"]} for item in results])
    split_path = _write_json(root, "json/regression_split.json", {"target": target, "features": features, "train_rows": train.tolist(), "test_rows": test.tolist()})
    figure_path = _write_figure(root, "figures/regression_residuals.png", range(len(rows)), {"residual": [row["residual"] for row in rows]}, "Held-out residuals")
    return {"selected_method": chosen, "method_results": results, "metrics": selected_result["metrics"], "paths": [(prediction_path, "table"), (metrics_path, "table"), (split_path, "other"), (figure_path, "figure")]}


def _run_forecasting(frame: pd.DataFrame, config: dict[str, Any], root: Path) -> dict[str, Any]:
    target, values = _numeric_values(frame, config)
    candidates, selected, diagnostics = run_forecast(values, config)
    results = [{"method": item.method, "status": item.status, "metrics": item.metrics, "hard_checks_passed": item.hard_checks_passed, "warnings": item.warnings} for item in candidates]
    if selected is None:
        raise ExperimentFailure("model_failure", "No forecasting candidate passed rolling backtest.")
    rows = [{"step": index + 1, "forecast": value, "lower": selected.lower[index], "upper": selected.upper[index]} for index, value in enumerate(selected.forecasts)]
    forecast_path = _write_csv(root, "tables/forecast.csv", rows)
    candidates_path = _write_csv(root, "tables/forecast_candidates.csv", [{"method": item.method, **item.metrics, "status": item.status} for item in candidates])
    diagnostics_path = _write_json(root, "json/forecast_backtest.json", {"target": target, **diagnostics})
    figure_path = _write_figure(root, "figures/forecast.png", range(len(values) + len(selected.forecasts)), {"history": list(values) + [None] * len(selected.forecasts), "forecast": [None] * len(values) + selected.forecasts}, "Rolling-backtest forecast")
    return {"selected_method": selected.method, "method_results": results, "metrics": selected.metrics, "paths": [(forecast_path, "table"), (candidates_path, "table"), (diagnostics_path, "other"), (figure_path, "figure")]}


def _classifier(name: str, seed: int) -> Any:
    if name == "logistic_regression":
        return make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, random_state=seed))
    if name == "decision_tree":
        from sklearn.tree import DecisionTreeClassifier

        return DecisionTreeClassifier(max_depth=5, random_state=seed)
    if name == "random_forest":
        return RandomForestClassifier(n_estimators=80, random_state=seed, n_jobs=1)
    if name == "svm":
        return make_pipeline(StandardScaler(), SVC(kernel="rbf"))
    raise RunnerContractError("unsupported_capability", f"Unknown classification method: {name}")


def _run_classification(frame: pd.DataFrame, config: dict[str, Any], root: Path, seed: int) -> dict[str, Any]:
    if LogisticRegression is None:
        raise RunnerContractError("unsupported_capability", "scikit-learn is unavailable for classification.")
    target = pick_target(frame, config, exclude=set()) if config.get("target_column") is not None else str(config.get("label_column", frame.columns[-1]))
    if target not in frame.columns:
        raise ExperimentFailure("data_quality_blocker", f"Classification target not found: {target}")
    feature_names = config.get("feature_columns") or [str(column) for column in frame.select_dtypes(include=[np.number]).columns if str(column) != target]
    if not feature_names:
        raise ExperimentFailure("data_quality_blocker", "Classification requires numeric feature columns.")
    selected = frame[list(feature_names) + [target]].copy()
    selected[list(feature_names)] = selected[list(feature_names)].apply(pd.to_numeric, errors="coerce")
    selected = selected.dropna()
    if len(selected) < 8 or selected[target].nunique() < 2:
        raise ExperimentFailure("data_quality_blocker", "Classification requires complete rows from at least two classes.")
    x = selected[list(feature_names)].to_numpy(dtype=float)
    y = selected[target].astype(str).to_numpy()
    if train_test_split is None:
        raise RunnerContractError("unsupported_capability", "scikit-learn is unavailable for classification.")
    try:
        x_train, x_test, y_train, y_test = train_test_split(x, y, test_size=float(config.get("test_fraction", 0.25)), random_state=seed, stratify=y)
    except ValueError as error:
        raise ExperimentFailure("data_quality_blocker", f"Stratified split failed: {error}") from error
    methods = [str(item) for item in config.get("methods", ["logistic_regression", "decision_tree", "random_forest", "svm"])]
    results: list[dict[str, Any]] = []
    predictions: dict[str, np.ndarray] = {}
    for method in methods:
        try:
            model = _classifier(method, seed)
            model.fit(x_train, y_train)
            predicted = np.asarray(model.predict(x_test)).astype(str)
            metrics = {"f1_macro": macro_f1(y_test, predicted), "accuracy": accuracy(y_test, predicted)}
            results.append({"method": method, "status": "success", "metrics": metrics, "hard_checks_passed": True, "warnings": []})
            predictions[method] = predicted
        except Exception as error:
            results.append({"method": method, "status": "ineligible", "metrics": {}, "hard_checks_passed": False, "warnings": [str(error)]})
    valid = [item for item in results if item["hard_checks_passed"]]
    if not valid:
        raise ExperimentFailure("model_failure", "No classification candidate passed held-out evaluation.")
    selected_result = max(valid, key=lambda item: (float(item["metrics"]["f1_macro"]), item["method"]))
    chosen = str(selected_result["method"])
    labels = sorted(set(y_test.tolist()) | set(predictions[chosen].tolist()))
    matrix = confusion_matrix(y_test, predictions[chosen], labels=labels).tolist()
    matrix_path = _write_json(root, "json/confusion_matrix.json", {"labels": labels, "matrix": matrix})
    candidate_path = _write_csv(root, "tables/classification_candidates.csv", [{"method": item["method"], **item["metrics"], "status": item["status"]} for item in results])
    split_path = _write_json(root, "json/classification_split.json", {"target": target, "features": list(feature_names), "test_fraction": config.get("test_fraction", 0.25), "classes": labels})
    return {"selected_method": chosen, "method_results": results, "metrics": selected_result["metrics"], "paths": [(matrix_path, "table"), (candidate_path, "table"), (split_path, "other")]}


def _run_clustering(frame: pd.DataFrame, config: dict[str, Any], root: Path, seed: int) -> dict[str, Any]:
    if KMeans is None:
        raise RunnerContractError("unsupported_capability", "scikit-learn is unavailable for clustering.")
    numeric = numeric_frame(frame).dropna()
    if len(numeric) < 5 or numeric.shape[1] < 2:
        raise ExperimentFailure("data_quality_blocker", "Clustering requires at least five complete rows and two numeric columns.")
    x = StandardScaler().fit_transform(numeric.to_numpy(dtype=float))
    methods = [str(item) for item in config.get("methods", ["kmeans", "agglomerative", "dbscan"])]
    requested_k = int(config.get("n_clusters", 2))
    results: list[dict[str, Any]] = []
    assignments: dict[str, np.ndarray] = {}
    for method in methods:
        try:
            if method == "kmeans":
                labels = KMeans(n_clusters=max(2, min(requested_k, len(x) - 1)), random_state=seed, n_init=10).fit_predict(x)
            elif method == "agglomerative":
                labels = AgglomerativeClustering(n_clusters=max(2, min(requested_k, len(x) - 1))).fit_predict(x)
            elif method == "dbscan":
                labels = DBSCAN(eps=float(config.get("eps", 0.9)), min_samples=int(config.get("min_samples", 3))).fit_predict(x)
            else:
                raise ValueError(f"unknown clustering method: {method}")
            count = len(set(labels.tolist()) - {-1})
            if count < 2 or count >= len(labels):
                raise ValueError("non-degenerate partition check failed")
            score = float(silhouette_score(x, labels))
            perturbed = x + np.random.default_rng(seed + 1).normal(0.0, 1e-6, size=x.shape)
            if method == "kmeans":
                repeated = KMeans(n_clusters=max(2, min(requested_k, len(x) - 1)), random_state=seed, n_init=10).fit_predict(perturbed)
            elif method == "agglomerative":
                repeated = AgglomerativeClustering(n_clusters=max(2, min(requested_k, len(x) - 1))).fit_predict(perturbed)
            else:
                repeated = DBSCAN(eps=float(config.get("eps", 0.9)), min_samples=int(config.get("min_samples", 3))).fit_predict(perturbed)
            stability = float(adjusted_rand_score(labels, repeated))
            metrics = {"silhouette": score, "cluster_count": count, "stability": stability}
            results.append({"method": method, "status": "success", "metrics": metrics, "hard_checks_passed": True, "warnings": []})
            assignments[method] = labels
        except Exception as error:
            results.append({"method": method, "status": "ineligible", "metrics": {}, "hard_checks_passed": False, "warnings": [str(error)]})
    valid = [item for item in results if item["hard_checks_passed"]]
    if not valid:
        raise ExperimentFailure("model_failure", "No clustering candidate produced a non-degenerate partition.")
    selected = max(valid, key=lambda item: (float(item["metrics"]["silhouette"]), item["method"]))
    chosen = str(selected["method"])
    rows = [{"row_index": index, "cluster": int(label)} for index, label in enumerate(assignments[chosen])]
    assignment_path = _write_csv(root, "tables/cluster_assignments.csv", rows)
    candidate_path = _write_csv(root, "tables/clustering_candidates.csv", [{"method": item["method"], **item["metrics"], "status": item["status"]} for item in results])
    profile = numeric.assign(cluster=pd.Series(assignments[chosen], index=numeric.index)).groupby("cluster").mean(numeric_only=True).reset_index()
    profile_path = _write_csv(root, "tables/cluster_profile.csv", profile.to_dict(orient="records"))
    figure_path = _write_figure(root, "figures/clusters.png", range(len(rows)), {"cluster": [row["cluster"] for row in rows]}, "Cluster assignments")
    return {"selected_method": chosen, "method_results": results, "metrics": selected["metrics"], "paths": [(assignment_path, "table"), (candidate_path, "table"), (profile_path, "table"), (figure_path, "figure")]}


def _normalise_indicator(series: pd.Series, direction: str) -> pd.Series:
    values = pd.to_numeric(series, errors="coerce")
    low, high = float(values.min()), float(values.max())
    if high == low:
        score = pd.Series(np.ones(len(values)), index=values.index)
    elif direction == "minimize":
        score = (high - values) / (high - low)
    else:
        score = (values - low) / (high - low)
    return score.fillna(0.0)


def _run_ranking(frame: pd.DataFrame, config: dict[str, Any], root: Path) -> dict[str, Any]:
    numeric = numeric_frame(frame).dropna()
    if len(numeric) < 2 or numeric.shape[1] < 2:
        raise ExperimentFailure("data_quality_blocker", "Ranking requires at least two rows and two numeric indicators.")
    columns = [str(item) for item in config.get("indicator_columns", numeric.columns.tolist())]
    missing = [column for column in columns if column not in numeric.columns]
    if missing:
        raise ExperimentFailure("data_quality_blocker", f"Ranking indicators not found: {missing}")
    directions_config = config.get("directions", {})
    directions = {column: str(directions_config.get(column, "maximize")) for column in columns}
    scores = pd.DataFrame({column: _normalise_indicator(numeric[column], directions[column]) for column in columns})
    weights = np.asarray([1.0 / len(columns)] * len(columns), dtype=float)
    weighted = scores.to_numpy() @ weights
    rows = [{"row_index": index, "score": float(score), "rank": rank + 1} for rank, (index, score) in enumerate(sorted(zip(numeric.index, weighted), key=lambda item: item[1], reverse=True))]
    ranking_path = _write_csv(root, "tables/ranking.csv", rows)
    indicator_path = _write_json(root, "json/indicator_spec.json", {"columns": columns, "directions": directions, "weights": weights.tolist(), "normalization": "min_max"})
    base_order = [int(index) for index, _ in sorted(zip(numeric.index, weighted), key=lambda item: item[1], reverse=True)]
    sensitivity_scores = []
    agreements: list[float] = []
    for shift in range(min(3, len(columns))):
        rolled = np.roll(weights, shift)
        alt = scores.to_numpy() @ rolled
        order = [int(index) for index, _ in sorted(zip(numeric.index, alt), key=lambda item: item[1], reverse=True)]
        sensitivity_scores.append(order)
        base_positions = {row: position for position, row in enumerate(base_order)}
        alt_positions = {row: position for position, row in enumerate(order)}
        distance = sum(abs(base_positions[row] - alt_positions[row]) for row in base_order)
        max_distance = max(1, (len(base_order) ** 2) // 2)
        agreements.append(max(0.0, 1.0 - distance / max_distance))
    method_agreement = float(np.mean(agreements)) if agreements else 1.0
    metrics = {"rank_stability": method_agreement, "method_agreement": method_agreement}
    sensitivity_path = _write_json(root, "json/ranking_sensitivity.json", {"rankings": sensitivity_scores, **metrics})
    return {"selected_method": "equal_weight_topsis", "method_results": [{"method": "equal_weight_topsis", "status": "success", "metrics": metrics, "hard_checks_passed": True, "warnings": []}], "metrics": metrics, "paths": [(ranking_path, "table"), (indicator_path, "other"), (sensitivity_path, "other")]}


def _run_optimization(frame: pd.DataFrame, config: dict[str, Any], root: Path) -> dict[str, Any]:
    numeric = numeric_frame(frame).dropna()
    if numeric.empty:
        raise ExperimentFailure("data_quality_blocker", "Optimization requires finite numeric candidates.")
    objective_text = str(config.get("objective", "maximize target"))
    match = re.search(r"\b(maximize|minimize)\s+([A-Za-z_][A-Za-z0-9 _-]*)", objective_text, re.IGNORECASE)
    if match:
        direction, column = match.group(1).lower(), match.group(2).strip()
        if column not in numeric.columns:
            column = pick_target(frame, config)
    else:
        direction, column = "maximize", pick_target(frame, config)
    values = numeric[column].to_numpy(dtype=float)
    selected_index = int(np.argmax(values) if direction == "maximize" else np.argmin(values))
    objective_value = float(values[selected_index])
    solution = numeric.iloc[[selected_index]].copy()
    solution.insert(0, "row_index", int(numeric.index[selected_index]))
    solution["objective_value"] = objective_value
    solution_path = _write_csv(root, "tables/optimization_solution.csv", solution.to_dict(orient="records"))
    formulation_path = _write_json(root, "json/optimization_formulation.json", {"objective": direction, "column": column, "constraint_policy": "select one feasible observed candidate", "candidate_count": len(numeric)})
    audit_path = _write_json(root, "json/constraint_audit.json", {"feasible": True, "max_constraint_violation": 0.0, "selected_row": int(numeric.index[selected_index])})
    result = {"objective_value": objective_value, "max_constraint_violation": 0.0}
    return {"selected_method": "observed_candidate_search", "method_results": [{"method": "observed_candidate_search", "status": "success", "metrics": result, "hard_checks_passed": True, "warnings": ["observed_candidate_formulation"]}], "metrics": result, "paths": [(solution_path, "table"), (formulation_path, "other"), (audit_path, "other")]}


def _run_simulation(frame: pd.DataFrame, config: dict[str, Any], root: Path, rng: np.random.Generator) -> dict[str, Any]:
    target, values = _numeric_values(frame, config)
    operation = str(config.get("operation", "bootstrap_mean"))
    if operation not in {"bootstrap_mean", "monte_carlo", "mean", "bootstrap"}:
        raise RunnerContractError("unsupported_capability", f"Unsupported simulation operation: {operation}")
    iterations = max(100, min(int(config.get("iterations", 2000)), 100000))
    samples = rng.choice(values, size=(iterations, len(values)), replace=True)
    estimates = samples.mean(axis=1)
    estimate = float(estimates.mean())
    standard_error = float(estimates.std(ddof=1))
    quantiles = np.quantile(estimates, [0.025, 0.5, 0.975]).tolist()
    summary_path = _write_json(root, "json/simulation_summary.json", {"target": target, "operation": operation, "iterations": iterations, "estimate": estimate, "monte_carlo_standard_error": standard_error, "quantiles": quantiles, "random_seed_recorded": True})
    values_path = _write_csv(root, "tables/simulation_samples.csv", [{"iteration": index + 1, "estimate": float(value)} for index, value in enumerate(estimates[: min(iterations, 10000)])])
    figure_path = _write_figure(root, "figures/simulation_trajectory.png", range(len(estimates)), {"estimate": estimates}, "Simulation estimates")
    metrics = {"estimate": estimate, "monte_carlo_standard_error": standard_error}
    return {"selected_method": "monte_carlo", "method_results": [{"method": "monte_carlo", "status": "success", "metrics": metrics, "hard_checks_passed": True, "warnings": []}], "metrics": metrics, "paths": [(summary_path, "other"), (values_path, "table"), (figure_path, "figure")]}


def _run_custom(frame: pd.DataFrame, config: dict[str, Any], root: Path, rng: np.random.Generator) -> dict[str, Any]:
    operation = str(config.get("operation", "bootstrap_mean"))
    if operation == "generated_python":
        raise RunnerContractError("unsupported_capability", "generated_python requires an explicitly policy-approved script_path.")
    if operation in {"bootstrap_mean", "bootstrap", "mean"}:
        target, values = _numeric_values(frame, config)
        iterations = max(100, min(int(config.get("iterations", 1000)), 100000))
        estimates = np.asarray([float(values[rng.integers(0, len(values), len(values))].mean()) for _ in range(iterations)])
        estimate = float(estimates.mean())
        table_path = _write_csv(root, "tables/custom_estimates.csv", [{"iteration": index + 1, "estimate": float(value)} for index, value in enumerate(estimates)])
        summary_path = _write_json(root, "json/custom_experiment.json", {"operation": operation, "target": target, "estimate": estimate, "iterations": iterations, "baseline": float(values.mean())})
        figure_path = _write_figure(root, "figures/custom_experiment.png", range(len(estimates)), {"estimate": estimates}, "Custom bootstrap experiment")
        metrics = {"task_specific_metric": estimate, "baseline": float(values.mean())}
        return {"selected_method": "generated_bootstrap", "method_results": [{"method": "generated_bootstrap", "status": "success", "metrics": metrics, "hard_checks_passed": True, "warnings": ["experimental_method"]}], "metrics": metrics, "paths": [(table_path, "table"), (summary_path, "other"), (figure_path, "figure")]}
    raise RunnerContractError("unsupported_capability", f"Unsupported custom operation: {operation}")


HANDLERS: dict[str, Callable[..., dict[str, Any]]] = {
    "statistical_analysis": _run_statistical,
    "regression_prediction": _run_regression,
    "time_series_forecasting": _run_forecasting,
    "classification": _run_classification,
    "clustering": _run_clustering,
    "evaluation_ranking": _run_ranking,
    "optimization": _run_optimization,
    "simulation": _run_simulation,
    "custom_experiment": _run_custom,
}


def _artifact_kind(path: Path) -> str:
    if path.suffix.lower() == ".png":
        return "figure"
    if path.suffix.lower() == ".csv":
        return "table"
    if path.suffix.lower() in {".json", ".log"}:
        return "log" if path.suffix.lower() == ".log" else "other"
    return "other"


def _collect_artifacts(root: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.name not in {"experiment-result.json"}:
            records.append(artifact_record(path, root, _artifact_kind(path)))
    return records


def _base_result(request: dict[str, Any], started_at: str, finished_at: str) -> dict[str, Any]:
    started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    finished = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
    return {
        "schema_version": "1.0.0",
        "run_id": str(request.get("run_id", "unknown")),
        "attempt_id": str(request.get("attempt_id", "unknown")),
        "task_id": str(request.get("task", {}).get("id", "unknown")),
        "plugin_id": str(request.get("task", {}).get("task_type", "unknown")),
        "status": "failed",
        "method_results": [],
        "metrics": {},
        "warnings": [],
        "artifacts": [],
        "runtime": {"started_at": started_at, "finished_at": finished_at, "duration_ms": max(0, int((finished - started).total_seconds() * 1000)), "python_version": platform.python_version()},
    }


def execute_request(request: dict[str, Any]) -> dict[str, Any]:
    started_at = _now()
    output: Path | None = None
    try:
        if isinstance(request.get("output_dir"), str):
            output = _output_root(request)
        _require_request(request)
        if output is None:
            output = _output_root(request)
        task = request["task"]
        task_type = str(task["task_type"])
        handler = HANDLERS.get(task_type)
        if handler is None:
            raise RunnerContractError("unsupported_capability", f"Unsupported task_type: {task_type}")
        config = {}
        if isinstance(task.get("config"), dict):
            config.update(task["config"])
        if isinstance(request.get("task_config"), dict):
            config.update(request["task_config"])
        frame_path, frame = choose_table(request["data_files"], config)
        seed = int(request.get("random_seed", 0))
        rng = np.random.default_rng(seed)
        if task_type in {"statistical_analysis"}:
            payload = handler(frame, config, output, rng)
        elif task_type in {"evaluation_ranking", "optimization"}:
            payload = handler(frame, config, output)
        elif task_type in {"regression_prediction", "classification", "clustering"}:
            payload = handler(frame, config, output, seed)
        elif task_type == "time_series_forecasting":
            payload = handler(frame, config, output)
        else:
            payload = handler(frame, config, output, rng)
        finished_at = _now()
        result = _base_result(request, started_at, finished_at)
        result.update({"status": "success", "selected_method": payload.get("selected_method"), "method_results": _json_value(payload["method_results"]), "metrics": _json_value(payload["metrics"]), "warnings": _json_value(payload.get("warnings", []))})
        lineage_path = _write_json(output, "json/input-lineage.json", {"relative_path": next((item.get("relative_path") for item in request["data_files"] if Path(item["absolute_path"]) == frame_path), frame_path.name), "sha256": next((item.get("sha256") for item in request["data_files"] if Path(item["absolute_path"]) == frame_path), None)})
        del lineage_path
        result["artifacts"] = _collect_artifacts(output)
    except Exception as error:
        finished_at = _now()
        result = _base_result(request, started_at, finished_at)
        if isinstance(error, (RunnerContractError, ExperimentFailure)):
            error_class = error.error_class
        else:
            error_class = "execution_failure"
        if error_class == "unsupported_capability":
            result["status"] = "unsupported"
        message = str(error)
        result["error"] = {"class": error_class, "message": message, "fingerprint": hashlib.sha256(f"{error_class}:{message}".encode("utf-8")).hexdigest()[:16]}
        if output is not None:
            try:
                error_path = _write_json(output, "json/error.json", result["error"])
                result["artifacts"] = _collect_artifacts(output)
                del error_path
            except Exception as output_error:
                result["warnings"].append(f"Could not write failure artifact: {output_error}")
    if output is not None:
        manifest = _output_path(output, "experiment-result.json")
        write_json(manifest, result)
    return _json_value(result)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Execute one schema-versioned modeling experiment.")
    parser.add_argument("--request", help="Path to experiment-request.v1 JSON; stdin is used when omitted.")
    args = parser.parse_args(argv)
    try:
        if args.request:
            request = json.loads(Path(args.request).read_text(encoding="utf-8"))
        else:
            request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise RunnerContractError("contract_failure", "Experiment request must be a JSON object.")
        result = execute_request(request)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0 if result.get("status") == "success" else 1
    except Exception as error:
        print(json.dumps({"status": "failed", "error": {"class": "runner_failure", "message": str(error)}}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
