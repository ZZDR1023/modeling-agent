from __future__ import annotations

import numpy as np


def mae(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.mean(np.abs(actual - predicted)))


def rmse(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(actual - predicted))))


def mase(actual: np.ndarray, predicted: np.ndarray, training: np.ndarray) -> float:
    scale = np.mean(np.abs(np.diff(training))) if len(training) > 1 else np.nan
    if not np.isfinite(scale) or scale == 0:
        return float("nan")
    return float(mae(actual, predicted) / scale)


def accuracy(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.mean(actual == predicted))


def macro_f1(actual: np.ndarray, predicted: np.ndarray) -> float:
    labels = np.unique(np.concatenate([actual, predicted]))
    scores: list[float] = []
    for label in labels:
        tp = np.sum((actual == label) & (predicted == label))
        fp = np.sum((actual != label) & (predicted == label))
        fn = np.sum((actual == label) & (predicted != label))
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        scores.append(2 * precision * recall / (precision + recall) if precision + recall else 0.0)
    return float(np.mean(scores)) if scores else 0.0


def safe_mean(values: list[float]) -> float | None:
    finite_values = [value for value in values if np.isfinite(value)]
    return float(np.mean(finite_values)) if finite_values else None
