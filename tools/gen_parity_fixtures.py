#!/usr/bin/env python3
"""Generate parity fixtures from the full application's Python models.

Writes tests/fixtures/*.json capturing exact evaluate() outputs (including
Upred margins) for a set of glasses, so the JS port can be pinned to the
Python implementation, not just to the paper.

Run from the sandbox repo:
    python3 tools/gen_parity_fixtures.py [--root PATH_TO_EWG_APP]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

DEFAULT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "..", "Hanford_Tank_BBI", "ewg_app")

CASES = [
    # name, glass composition (mass fractions) — paper Table 3-5 glasses
    ("Batch3_T35", {
        "Al2O3": 0.24655, "B2O3": 0.220, "SiO2": 0.268581, "Na2O": 0.141397,
        "ZnO": 0.04, "Li2O": 0.0138,
    }),
    ("HighNa_T35", {
        "Al2O3": 0.0300, "B2O3": 0.066228, "SiO2": 0.499733, "Na2O": 0.18341,
        "CaO": 0.105503, "V2O5": 0.0508,
    }),
    ("Batch45_T35", {
        "Al2O3": 0.090876, "B2O3": 0.10635, "SiO2": 0.391917, "Na2O": 0.228237,
        "ZrO2": 0.056817,
    }),
]

UPRED_CASES = [
    ("Batch3_T35", {
        "Al2O3": 0.24655, "B2O3": 0.220, "SiO2": 0.268581, "Na2O": 0.141397,
        "ZnO": 0.04, "Li2O": 0.0138,
    }),
    ("HighNa_T35", {
        "Al2O3": 0.0300, "B2O3": 0.066228, "SiO2": 0.9 * 0.499733, "Na2O": 0.18341,
        "CaO": 0.105503, "V2O5": 0.0508, "SO3": 0.005, "Cl": 0.002,
    }),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--fixtures-dir", default=None)
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    sys.path.insert(0, root)
    from ewg import properties as P   # noqa: E402

    fdir = args.fixtures_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                             "..", "tests", "fixtures")
    os.makedirs(fdir, exist_ok=True)

    def snap(glass):
        ev = P.evaluate(glass)
        return {
            "NL": float(__import__("math").exp(ev.ave_ln_nl)),
            "eta1150": float(ev.eta1150),
            "eta1100": float(ev.eta1100),
            "ec1100": float(ev.ec1100),
            "ec1200": float(ev.ec1200),
            "wso3_3ts": float(ev.wso3_3ts),
            "k1208": float(__import__("math").exp(ev.ln_k1208)),
            "p_phos": float(ev.p_phos),
            "NNaLi": float(ev.NNaLi),
            "NALK": float(ev.NALK),
            "NSiAl": float(ev.NSiAl),
            "all_pass": bool(ev.all_pass),
        }

    cases = []
    for name, g in CASES:
        cases.append({"name": name, "glass": g, "expected": snap(g)})
    with open(os.path.join(fdir, "glass_parity_python.json"), "w") as f:
        json.dump({"cases": cases}, f, indent=1)

    upred_cases = []
    for name, g in UPRED_CASES:
        ev = P.evaluate(g)
        upred_cases.append({
            "name": name, "glass": g,
            "expected": {
                "pct": float(ev.upred["pct"]),
                "eta1150": float(ev.upred["eta1150"]),
                "k1208": float(ev.upred["k1208"]),
                "wso3": float(ev.upred["wso3"]),
            },
        })
    with open(os.path.join(fdir, "upred_parity_python.json"), "w") as f:
        json.dump({"cases": upred_cases}, f, indent=1)

    print(f"wrote fixtures to {fdir}")


if __name__ == "__main__":
    main()
