#!/usr/bin/env python3
"""Extract a scaled-down, client-side dataset from the full Hanford HLW
blending application (../Hanford_Tank_BBI/ewg_app).

Produces web/data/mission_data.json containing:
  - per-scenario layer vectors (App-D DFHLW layers + homogenized heels):
    oxide mass fractions, waste-oxide mass, true slurry volume, per-layer
    WAP values (normalized keys, Solids Loading in wt%)
  - the 36-criterion WAC table (scenarios.json 'wac')
  - the GFC library + example waste vectors (PNNL-35884 Tables 3-3/3-4)
  - the Appendix-C covariance matrices for Upred margins
  - engine constants (canister kg, volume band, min transfer, ...)

Source of truth: RPP-RPT-64878-01 (App D/E, §6.2) + PNNL-35884 Rev. 1.
Nothing here is invented; every number is copied from the main app's
extracted App-D data layer.

Usage:
    python3 tools/build_sandbox_data.py [--root PATH_TO_EWG_APP]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import OrderedDict

DEFAULT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "..", "Hanford_Tank_BBI", "ewg_app")

# Scenarios shipped in the sandbox (subset of the 32 published App-D tags).
# Covers the full supernatant-density range at the 120/150 design point,
# plus the three Table A-30 review anchors at 135.
SCENARIO_TAGS = [
    "120.120.150", "125.120.150", "130.120.150", "135.120.150",
    "140.120.150", "135.105.200", "135.104.220", "135.120.100",
]

QUADRANT_FARMS = {
    "SE": ["AN", "AP", "AW", "AX", "AY", "AZ"],
    "NE": ["A", "C"],
    "NW": ["B", "BX", "BY"],
    "SW": ["S", "SX", "SY"],
}

# App-D WAP labels (the main app's layer_wac files use these)
# -> short engine keys.  Heel files already use the bare labels.
WAP_RENAME = {
    "WAP Unit Dose": "UD",
    "WAP Unit Dose Alternate": "UDAlt",
    "WAP Equivalent Cs-137 Concentration": "Conc_Cs137eq",
    "WAP UHGRtotal @140 °F": "HGR140",
    "WAP UHGRtotal @195 °F": "HGR195",
    "WAP Pu to Metals Loading Ratio": "WRatio_Pu_Metals",
    "WAP U-Fissile to U-Total Ratio": "WRatio_UFis_UTot",
    "WAP NO2- + NO3- Molar Concentration": "Conc_NOx",
    "WAP TOC Mass Fraction (w/ Oxalate)": "Conc_TOC",
    "WAP PCB Mass Fraction": "Conc_PCB",
    "WAP Bulk Density": "BDens",
    "WAP Liquid Density": "LDens",
    "WAP Solids Loading": "SolidsLoading",
    "WAP pH": "pH",
    "WAP Cl-/OH- Molar Ratio": "MRatio_Cl_OH",
    "WAP NaK Mass Concentration": "GTar_NaK",
    "WAP AlFeZr Mass Concentration": "GTar_AlFeZr",
    "WAP F Mass Concentration": "GTar_F",
    "WAP S Mass Concentration": "GTar_S",
    "WAP Zr Mass Concentration": "GTar_Zr",
    "WAP FeCrNi Mass Concentration": "GTar_FeCrNi",
    "WAP P Mass Concentration": "GTar_P",
    "WAP Fe Mass Concentration": "GTar_Fe",
    "WAP Cr Mass Concentration": "GTar_Cr",
    "WAP Cd Mass Concentration": "GTar_Cd",
    "WAP Mn Mass Concentration": "GTar_Mn",
    "WAP Ca Mass Concentration": "GTar_Ca",
    "WAP Th Mass Concentration": "GTar_Th",
    "WAP Al Mass Concentration": "GTar_Al",
    "WAP Cl Mass Concentration": "GTar_Cl",
    "WAP U Mass Concentration": "GTar_U",
    "WAP Bi Mass Concentration": "GTar_Bi",
    "WAP Na Mass Concentration": "GTar_Na",
    "WAP Cr/Sol Mass Ratio": "GTar_CrSol",
    "WAP S/Sol Mass Ratio": "GTar_SSol",
    "WAP NaK/Sol Mass Ratio": "GTar_NaKSol",
    # heel-native bare labels
    "Unit Dose": "UD",
    "Equivalent Cs-137 Concentration": "Conc_Cs137eq",
    "UHGRtotal @140 °F": "HGR140",
    "UHGRtotal @195 °F": "HGR195",
    "Pu to Metals Loading Ratio": "WRatio_Pu_Metals",
    "U-Fissile to U-Total Ratio": "WRatio_UFis_UTot",
    "NO2- + NO3- Molar Concentration": "Conc_NOx",
    "TOC Mass Fraction": "Conc_TOC",
    "PCB Mass Fraction": "Conc_PCB",
    "Bulk Density": "BDens",
    "Solids Loading": "SolidsLoading",
    "pH": "pH",
    # exact linear-form radiological ratios (App-D per-L slurry values)
    "WAP Pu(s) per L Slurry": "PuPerL",
    "WAP Pu-Metals(s) per L Slurry": "PuMetPerL",
    "WAP UFis(s) per L Slurry": "UFisPerL",
    "WAP UTot(s) per L Slurry": "UTotPerL",
}

# stream props kept in the sandbox (kL / kg units as extracted)
STREAM_KEEP = [
    "StreamProp Slurry Volume",
    "StreamProp Slurry Mass",
    "StreamProp Slurry Density",
    "StreamProp Liquid Volume",
    "StreamProp Liquid Mass",
    "StreamProp Liquid Density",
    "StreamProp Solids Mass",
    "StreamProp Waste Oxide Mass",
]
STREAM_RENAME = {
    "StreamProp Slurry Volume": "slurry_kL",
    "StreamProp Slurry Mass": "slurry_kg",
    "StreamProp Slurry Density": "slurry_rho",
    "StreamProp Liquid Volume": "liq_kL",
    "StreamProp Liquid Mass": "liq_kg",
    "StreamProp Liquid Density": "liq_rho",
    "StreamProp Solids Mass": "solids_kg",
    "StreamProp Waste Oxide Mass": "waste_oxide_kg",
}


def sig(v, digits=9):
    """Round to `digits` significant digits (compact, deterministic JSON)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v
    if not math.isfinite(f) or f == 0.0:
        return 0.0
    return float(f"{f:.{digits}g}")


def quadrant_of(tank: str) -> str:
    farm = tank.split("-", 1)[0]
    for q, farms in QUADRANT_FARMS.items():
        if farm in farms:
            return q
    return "other"


def layer_index(name: str) -> int:
    if "_" not in name:
        return 0
    suffix = name.split("_", 1)[1]
    if suffix.startswith("A"):
        try:
            return int(suffix[1:])
        except ValueError:
            return 0
    if suffix.startswith("L"):
        try:
            return int(suffix[1:]) + 100
        except ValueError:
            return 100
    return 50


def layer_series(name: str) -> str:
    if name.endswith("_H1"):
        return "H"
    suffix = name.split("_", 1)[1]
    return "A" if suffix.startswith("A") else "L"


def extract_layer(name: str, rec: dict, wap_raw: dict) -> dict:
    tank = name.split("_", 1)[0]
    ox = {}
    for k, v in rec.get("oxides", {}).items():
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if abs(f) > 1e-12:
            ox[k] = sig(f)
    total_kg = sig(rec.get("total_kg", 0.0))

    sp_raw = rec.get("stream_props") or {}
    sp = {}
    for src, dst in STREAM_RENAME.items():
        if src in sp_raw:
            sp[dst] = sig(sp_raw[src])

    # slurry volume: true App-D value, heel fallback oxide/1300 (same rule
    # as the full app's _layer_slurry_kL)
    slurry_kL = sp.get("slurry_kL") or 0.0
    if not slurry_kL or slurry_kL <= 0:
        slurry_kL = total_kg / 1300.0
        sp.setdefault("slurry_kL", sig(slurry_kL))

    # WAP normalization
    wap = {}
    for raw_key, val in wap_raw.items():
        key = WAP_RENAME.get(raw_key)
        if key is None:
            continue
        try:
            f = float(val)
        except (TypeError, ValueError):
            continue
        wap[key] = f
    # Solids Loading normalized to wt% (App-D stores fraction, heels store
    # wt% — normalize to one basis so the LP and pass/fail share units)
    sl = wap.get("SolidsLoading")
    if sl is not None and 0.0 < sl < 1.0:
        wap["SolidsLoading"] = sl * 100.0
    wap = {k: sig(v) for k, v in sorted(wap.items())}

    return OrderedDict([
        ("id", name),
        ("tank", tank),
        ("quad", quadrant_of(tank)),
        ("series", layer_series(name)),
        ("idx", layer_index(name)),
        ("total_kg", total_kg),
        ("slurry_kL", sig(slurry_kL)),
        ("method", rec.get("method", "")),
        ("oxides", OrderedDict(sorted(ox.items()))),
        ("stream", OrderedDict(sorted(sp.items()))),
        ("wap", wap),
    ])


def extract_scenario(root: str, tag: str) -> dict:
    lv_path = os.path.join(root, "ewg", "data", f"layer_vectors_{tag}.json")
    lw_path = os.path.join(root, "ewg", "data", f"layer_wac_{tag}.json")
    with open(lv_path) as f:
        lv = json.load(f)
    with open(lw_path) as f:
        wac_per_layer = json.load(f).get("wac_per_layer", {})

    layers = OrderedDict()
    for name in sorted(lv.keys(), key=lambda n: (n.split("_")[0], layer_index(n))):
        layers[name] = extract_layer(name, lv[name], wac_per_layer.get(name, {}))
    n_appd = sum(1 for l in layers.values() if l["series"] != "H")
    n_heel = len(layers) - n_appd
    return OrderedDict([
        ("tag", tag),
        ("label", tag.replace(".", " · ")),
        ("n_layers", len(layers)),
        ("n_appd", n_appd),
        ("n_heel", n_heel),
        ("layers", layers),
    ])


def extract_wac_table(root: str) -> list:
    with open(os.path.join(root, "ewg", "data", "scenarios.json")) as f:
        sc = json.load(f)
    return sc["wac"]


def extract_gfc(root: str) -> dict:
    sys.path.insert(0, root)
    from ewg.gfc import GFCS, GFC_NAMES, EXAMPLE_WASTES  # noqa: E402
    return {
        "gfcs": OrderedDict((n, {k: sig(v) for k, v in sorted(GFCS[n].items())})
                             for n in GFC_NAMES),
        "example_wastes": OrderedDict(
            (n, {k: sig(v) for k, v in sorted(w.items()) if abs(float(v)) > 1e-12})
            for n, w in EXAMPLE_WASTES.items()),
    }


def extract_covariance(root: str) -> dict:
    with open(os.path.join(root, "ewg", "data", "appc_covariance.json")) as f:
        raw = json.load(f)
    out = {}
    for model, mat in raw.items():
        terms = list(mat.keys())
        n = len(terms)
        M = [[0.0] * n for _ in range(n)]
        for i, t in enumerate(terms):
            row = mat[t]
            m = min(len(row), n)
            for j in range(m):
                M[i][j] = sig(row[j], 6)
        out[model] = {"terms": terms, "M": M}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    out_path = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        "..", "web", "data", "mission_data.json")

    data = OrderedDict()
    data["meta"] = OrderedDict([
        ("title", "Hanford HLW Blending Mission Sandbox"),
        ("source", "RPP-RPT-64878-01 (App D/E, §6.2) + PNNL-35884 Rev. 1 (EWG2.5)"),
        ("provenance", "Extracted from the full mission application's App-D data layer; "
                       "see tools/build_sandbox_data.py"),
        ("canister_kg", 3097.0),
        ("band_kgal", [450.0, 550.0]),
        ("kl_per_kgal", 3.785412),
        ("min_transfer_kL", 38.0),
        ("max_tanks_per_campaign", 5),
        ("default_wac_scale", 0.60),
        ("wac_scale_overrides", {"WRatio_UFis_UTot": 0.90, "Conc_NOx": 0.90}),
        ("glass_t_per_day", 5.0),
        ("melter_availability", 0.65),
        ("rho_slurry_heel_fallback", 1300.0),
    ])
    data["scenarios"] = OrderedDict(
        (tag, extract_scenario(root, tag)) for tag in SCENARIO_TAGS)
    data["wac"] = extract_wac_table(root)
    data["gfc"] = extract_gfc(root)
    data["covariance"] = extract_covariance(root)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    size = os.path.getsize(out_path)
    print(f"wrote {out_path}  ({size/1024:.0f} KB)")
    for tag, s in data["scenarios"].items():
        print(f"  {tag}: {s['n_layers']} layers ({s['n_appd']} App-D + {s['n_heel']} heels)")


if __name__ == "__main__":
    main()
