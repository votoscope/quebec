#!/usr/bin/env python3
"""
XGBoost quantile regression vs GP Matérn for riding-level effects.

Compares XGBoost multi-output quantile regression with the GP Matérn
results from the JS model (R² 0.44 holdout, -0.16 anti-transfert).

Validation:
  1. Holdout 50% répété (R² multivarié) — même critère que le GP
  2. Inter-transition (anti-transfert) — train 2018→2022, test 2022→2026

XGBoost quantile regression: one model per target coordinate (5 targets),
each predicting the median (quantile 0.5). Prediction intervals from
quantiles 0.05 and 0.95.

Run: python js/tools/xgboost_test.py   (from the repo root)
"""

import json
import sys
import numpy as np
from pathlib import Path
from xgboost import XGBRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import r2_score

sys.stdout.reconfigure(encoding='utf-8')

# --- load data ---------------------------------------------------------------
DATA_PATH = Path(__file__).parent.parent / "data" / "riding_effects_data.json"
with open(DATA_PATH) as f:
    data = json.load(f)

X_train = np.array(data["train"]["X"])
Y_train = np.array(data["train"]["Y"])
X_test = np.array(data["test2026"]["X"])
Y_test = np.array(data["test2026"]["Y"])

n_train, n_features = X_train.shape
n_targets = Y_train.shape[1]

print("=" * 70)
print("XGBoost Quantile Regression vs GP Matérn — Effets par circonscription")
print("=" * 70)
print(f"\nDonnées:")
print(f"  Entraînement (2017 map, 2014→2018 → 2018→2022): {n_train} circonscriptions")
print(f"  Features: {n_features} (14 démographie ILR + 5 résidu précédent ILR)")
print(f"  Targets: {n_targets} coordonnées ILR")
print(f"  Test inter-transition (2026 map, 2022→2026): {X_test.shape[0]} circonscriptions")

# --- helper: multivariate R² (same as GP) -------------------------------------
def multivariate_r2(y_true, y_pred):
    """R² multivarié: 1 - SSE_model / SSE_null (prédire la moyenne)."""
    sse_model = np.sum((y_true - y_pred) ** 2)
    sse_null = np.sum((y_true - np.mean(y_true, axis=0)) ** 2)
    return 1 - sse_model / sse_null if sse_null > 0 else 0.0

# --- XGBoost parameters -------------------------------------------------------
XGB_PARAMS = {
    "n_estimators": 100,
    "max_depth": 4,
    "learning_rate": 0.1,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_alpha": 1.0,  # L1 regularization
    "reg_lambda": 1.0,  # L2 regularization
    "random_state": 42,
    "n_jobs": -1,
}

def train_xgb(X, Y, quantile=0.5):
    """Train one XGBoost model per target coordinate."""
    models = []
    for j in range(Y.shape[1]):
        if quantile == 0.5:
            model = XGBRegressor(objective="reg:squarederror", **XGB_PARAMS)
        else:
            model = XGBRegressor(
                objective="reg:quantileerror",
                quantile_alpha=quantile,
                **{k: v for k, v in XGB_PARAMS.items() if k != "random_state"},
                random_state=42,
            )
        model.fit(X, Y[:, j])
        models.append(model)
    return models

def predict_xgb(models, X):
    """Predict all target coordinates."""
    preds = np.column_stack([m.predict(X) for m in models])
    return preds

# --- 1. Holdout 50% répété (même critère que le GP) ---------------------------
print("\n" + "=" * 70)
print("1. HOLDOUT 50% RÉPÉTÉ (R² multivarié, 15 répétitions)")
print("=" * 70)
print("  (même critère que le GP Matérn: R² = 0,44)")

r2_scores = []
for rep in range(15):
    X_tr, X_te, Y_tr, Y_te = train_test_split(
        X_train, Y_train, test_size=0.5, random_state=rep
    )
    models = train_xgb(X_tr, Y_tr)
    Y_pred = predict_xgb(models, X_te)
    r2 = multivariate_r2(Y_te, Y_pred)
    r2_scores.append(r2)

mean_r2 = np.mean(r2_scores)
sd_r2 = np.std(r2_scores)
print(f"\n  XGBoost holdout R²: {mean_r2:.3f} ± {sd_r2:.3f} (15 répétitions)")
print(f"  GP Matérn holdout R²: 0,44 (référence JS)")
print(f"  Différence: {mean_r2 - 0.44:+.3f}")

# Per-coordinate R²
print("\n  R² par coordonnée ILR (moyenne 15 répétitions):")
models_full = train_xgb(X_train, Y_train)
Y_pred_full = predict_xgb(models_full, X_train)
for j in range(n_targets):
    r2_j = r2_score(Y_train[:, j], Y_pred_full[:, j])
    print(f"    ILR[{j}]: R² = {r2_j:.3f}")

# --- 2. Inter-transition (anti-transfert) ------------------------------------
print("\n" + "=" * 70)
print("2. INTER-TRANSITION (ANTI-TRANSFERT)")
print("=" * 70)
print("  Train: 2018→2022 (2017 map). Test: 2022→2026 (2026 map).")
print("  (même critère que le post-mortem: GP = -0,16)")

models_inter = train_xgb(X_train, Y_train)
Y_pred_inter = predict_xgb(models_inter, X_test)
r2_inter = multivariate_r2(Y_test, Y_pred_inter)

print(f"\n  XGBoost inter-transition R²: {r2_inter:.3f}")
print(f"  GP Matérn inter-transition R²: -0,16 (référence post-mortem)")
print(f"  Différence: {r2_inter - (-0.16):+.3f}")

# Per-coordinate
print("\n  R² par coordonnée (inter-transition):")
for j in range(n_targets):
    r2_j = r2_score(Y_test[:, j], Y_pred_inter[:, j])
    print(f"    ILR[{j}]: R² = {r2_j:.3f}")

# --- 3. Quantile regression (intervalles) -------------------------------------
print("\n" + "=" * 70)
print("3. QUANTILE REGRESSION (intervalles de prédiction)")
print("=" * 70)

# Train quantile models (5%, 50%, 95%)
models_q05 = train_xgb(X_train, Y_train, quantile=0.05)
models_q50 = train_xgb(X_train, Y_train, quantile=0.50)
models_q95 = train_xgb(X_train, Y_train, quantile=0.95)

# Predict on test set
Y_q05 = predict_xgb(models_q05, X_test)
Y_q50 = predict_xgb(models_q50, X_test)
Y_q95 = predict_xgb(models_q95, X_test)

# Coverage: fraction of true values within [q05, q95]
coverage = np.mean((Y_test >= Y_q05) & (Y_test <= Y_q95))
print(f"\n  Couverture [q05, q95] sur test inter-transition: {coverage * 100:.1f}%")
print(f"  (cible: 90%)")

# Interval width
width = np.mean(Y_q95 - Y_q05)
print(f"  Largeur moyenne des intervalles: {width:.3f} (ILR units)")

# Compare with GP posterior (approximate: GP gives mean + std)
# The GP residuals have std ~0.3-0.4 in ILR (from the simulation)
print(f"  (référence: écart-type résidus GP ~0,3-0,4 ILR)")

# --- 4. Feature importance ----------------------------------------------------
print("\n" + "=" * 70)
print("4. IMPORTANCE DES FEATURES (XGBoost, coordonnées moyennées)")
print("=" * 70)

importance = np.mean([m.feature_importances_ for m in models_full], axis=0)
feature_names = [f"demo_{i}" for i in range(14)] + [f"prev_resid_{i}" for i in range(5)]
# Sort by importance
idx = np.argsort(importance)[::-1]
print("\n  Top 10 features:")
for i in idx[:10]:
    print(f"    {feature_names[i]:15s}: {importance[i]:.3f}")

# --- 5. Verdict ---------------------------------------------------------------
print("\n" + "=" * 70)
print("VERDICT")
print("=" * 70)

print(f"""
  Holdout 50% (même critère que GP):
    XGBoost R² = {mean_r2:.3f} ± {sd_r2:.3f}
    GP Matérn R² = 0,44
    → {"XGBoost MEILLEUR" if mean_r2 > 0.44 else "GP MEILLEUR" if mean_r2 < 0.44 else "ÉGALITÉ"} ({mean_r2 - 0.44:+.3f})

  Inter-transition (anti-transfert):
    XGBoost R² = {r2_inter:.3f}
    GP Matérn R² = -0,16
    → {"XGBoost MEILLEUR" if r2_inter > -0.16 else "GP MEILLEUR" if r2_inter < -0.16 else "ÉGALITÉ"} ({r2_inter - (-0.16):+.3f})

  Intervalles (quantile regression):
    Couverture [q05, q95]: {coverage * 100:.1f}% (cible 90%)
    → {"BIEN CALIBRÉ" if 0.85 <= coverage <= 0.95 else "À VÉRIFIER"}

  Interprétation:
    - Si XGBoost gagne en holdout MAIS perd en inter-transition:
      c'est de l'overfitting (même problème que le GP, mais pire).
    - Si XGBoost gagne en holdout ET en inter-transition:
      c'est un vrai progrès, XGBoost capture des patterns que le GP manque.
    - Si XGBoost perd partout: le GP reste le meilleur choix.
""")

# Save results
results = {
    "xgboost": {
        "holdout_r2_mean": float(mean_r2),
        "holdout_r2_sd": float(sd_r2),
        "inter_transition_r2": float(r2_inter),
        "coverage_90": float(coverage),
        "interval_width": float(width),
    },
    "gp_reference": {
        "holdout_r2": 0.44,
        "inter_transition_r2": -0.16,
    },
}
results_path = Path(__file__).parent.parent / "data" / "xgboost_results.json"
with open(results_path, "w") as f:
    json.dump(results, f, indent=2)
print(f"\nRésultats sauvegardés: {results_path}")
