from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.tsa.holtwinters import ExponentialSmoothing

from .metrics import mae, mase, rmse


@dataclass
class ForecastCandidate:
    method: str
    status: str
    metrics: dict[str, float | int | str | bool | None]
    hard_checks_passed: bool
    warnings: list[str]
    forecasts: list[float]
    lower: list[float]
    upper: list[float]


def _naive(train: np.ndarray, horizon: int) -> np.ndarray:
    return np.repeat(train[-1], horizon).astype(float)


def _seasonal_naive(train: np.ndarray, horizon: int, period: int) -> np.ndarray:
    if len(train) < period:
        raise ValueError("history shorter than seasonal period")
    repeats = int(np.ceil(horizon / period))
    return np.tile(train[-period:], repeats)[:horizon].astype(float)


def _ets(train: np.ndarray, horizon: int, period: int | None) -> np.ndarray:
    seasonal = "add" if period and len(train) >= period * 2 else None
    seasonal_periods = period if seasonal else None
    model = ExponentialSmoothing(train, trend="add", damped_trend=True, seasonal=seasonal, seasonal_periods=seasonal_periods)
    return np.asarray(model.fit(optimized=True).forecast(horizon), dtype=float)


def _arima(train: np.ndarray, horizon: int, seasonal_period: int | None) -> np.ndarray:
    seasonal_order = (1, 0, 1, seasonal_period) if seasonal_period and len(train) >= seasonal_period * 2 else (0, 0, 0, 0)
    model = ARIMA(train, order=(1, 1, 1), seasonal_order=seasonal_order, enforce_stationarity=False, enforce_invertibility=False)
    return np.asarray(model.fit().forecast(horizon), dtype=float)


def forecast(method: str, train: np.ndarray, horizon: int, period: int | None) -> np.ndarray:
    if method == "naive":
        return _naive(train, horizon)
    if method == "seasonal_naive":
        if not period:
            raise ValueError("seasonal period is required")
        return _seasonal_naive(train, horizon, period)
    if method == "ets":
        return _ets(train, horizon, period)
    if method in {"arima", "sarima"}:
        return _arima(train, horizon, period if method == "sarima" else None)
    raise ValueError(f"unknown forecasting method: {method}")


def detect_period(values: np.ndarray, config: dict[str, Any]) -> int | None:
    configured = config.get("seasonal_period")
    if configured is not None:
        value = int(configured)
        return value if value > 1 else None
    if len(values) >= 14:
        for candidate in (7, 12, 4):
            if len(values) >= candidate * 2:
                first = values[-candidate * 2:-candidate]
                second = values[-candidate:]
                if np.std(values) > 0 and np.corrcoef(first, second)[0, 1] > 0.55:
                    return candidate
    return None


def rolling_splits(length: int, horizon: int, requested_folds: int = 3) -> list[tuple[int, int]]:
    if horizon < 1:
        raise ValueError("forecast horizon must be positive")
    min_train = max(horizon * 2, 8)
    if length < min_train + horizon:
        return []
    max_folds = (length - min_train) // horizon
    folds = min(requested_folds, max_folds)
    starts = [length - horizon * (folds - index + 1) for index in range(folds)]
    return [(max(start, min_train), horizon) for start in starts]


def evaluate_forecast_method(values: np.ndarray, method: str, horizon: int, period: int | None, folds: list[tuple[int, int]]) -> ForecastCandidate:
    fold_mae: list[float] = []
    fold_rmse: list[float] = []
    fold_mase: list[float] = []
    warnings: list[str] = []
    for train_end, fold_horizon in folds:
        train = values[:train_end]
        actual = values[train_end:train_end + fold_horizon]
        try:
            predicted = forecast(method, train, fold_horizon, period)
            if len(predicted) != len(actual) or not np.all(np.isfinite(predicted)):
                raise ValueError("forecast contains invalid values")
        except Exception as error:
            return ForecastCandidate(method, "ineligible", {}, False, [str(error)], [], [], [])
        fold_mae.append(mae(actual, predicted))
        fold_rmse.append(rmse(actual, predicted))
        fold_mase.append(mase(actual, predicted, train))
    if not fold_mae:
        return ForecastCandidate(method, "ineligible", {}, False, ["insufficient_history"], [], [], [])
    try:
        final_forecast = forecast(method, values, horizon, period)
    except Exception as error:
        return ForecastCandidate(method, "ineligible", {}, False, [str(error)], [], [], [])
    residual_scale = float(np.quantile(np.abs(np.asarray(fold_mae)), 0.95)) if fold_mae else 0.0
    if not np.isfinite(residual_scale) or residual_scale == 0:
        residual_scale = float(np.std(values[-min(len(values), horizon):]))
    lower = (final_forecast - 1.96 * residual_scale).tolist()
    upper = (final_forecast + 1.96 * residual_scale).tolist()
    metrics = {
        "mae": float(np.mean(fold_mae)),
        "rmse": float(np.mean(fold_rmse)),
        "mase": float(np.nanmean(fold_mase)) if np.isfinite(np.nanmean(fold_mase)) else None,
        "mae_std": float(np.std(fold_mae)),
        "folds": len(fold_mae),
        "horizon": horizon,
        "seasonal_period": period or 0
    }
    if len(fold_mae) < 3:
        warnings.append("limited_backtest_folds")
    return ForecastCandidate(method, "success", metrics, True, warnings, final_forecast.tolist(), lower, upper)


def run_forecast(values: np.ndarray, config: dict[str, Any]) -> tuple[list[ForecastCandidate], ForecastCandidate | None, dict[str, Any]]:
    horizon = int(config.get("horizon", max(1, min(5, len(values) // 5))))
    period = detect_period(values, config)
    folds = rolling_splits(len(values), horizon, int(config.get("backtest_folds", 3)))
    methods = list(config.get("methods", ["naive", "seasonal_naive", "ets", "arima", "sarima"]))
    candidates = [evaluate_forecast_method(values, method, horizon, period, folds) for method in methods]
    valid = [candidate for candidate in candidates if candidate.hard_checks_passed]
    selected = min(valid, key=lambda item: (float(item.metrics.get("mae", np.inf)), float(item.metrics.get("mae_std", np.inf)), item.method)) if valid else None
    diagnostics = {
        "horizon": horizon,
        "seasonal_period": period,
        "folds": [{"train_end": train_end, "horizon": fold_horizon} for train_end, fold_horizon in folds],
        "status": "validated" if len(folds) >= 3 else "limited" if folds else "exploratory"
    }
    return candidates, selected, diagnostics
