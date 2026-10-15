#!/usr/bin/env python3
"""Generate mission-level parity fixtures from the full application.

Runs the full app's build_farm_mission + evaluate_campaign_recipe for the
sandbox's shipped scenarios (App-D layers only, matching the sandbox's
default scope) and stores the roll-up totals for the JS parity test.

Run:  python3 tools/gen_mission_fixture.py [--root PATH] [--tags 135.120.150,...]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

DEFAULT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "..", "Hanford_Tank_BBI", "ewg_app")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--tags", default="135.120.150")
    ap.add_argument("--include-heels", action="store_true",
                    help="Full-farm scope (App-D layers + heels), matching the "
                         "sandbox's includeHeels=true mode")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                 "..", "tests", "fixtures",
                                                 "mission_parity_python.json"))
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    sys.path.insert(0, root)
    from ewg.campaign_builder import build_farm_mission           # noqa: E402
    from ewg.farm_mission import evaluate_campaign_recipe         # noqa: E402
    import ewg.mission as mission_mod                             # noqa: E402
    from ewg.mission import load_layer_vectors_for                # noqa: E402

    out = {}
    for tag in args.tags.split(","):
        t0 = time.time()
        lv = load_layer_vectors_for(tag)
        if args.include_heels:
            layer_subset = None                      # whole farm
        else:
            layer_subset = [l for l in lv.keys() if not l.endswith("_H1")]
        res = build_farm_mission(scenario_tag=tag, layer_subset=layer_subset)

        # blend_vector() reads the SHARED layer_vectors.json, which holds
        # whichever scenario was built/synthesized last (135.120.150 here).
        # For any other tag the fixtures would silently evaluate glass on the
        # WRONG waste compositions (measured: 12.61 vs 16.55 Mt glass for
        # 135.105.200 App-D).  Patch it to read the scenario's own vectors.
        def _blend_vector_scoped(recipe, _lv=lv):
            tot = {}
            for t in recipe:
                fr = t["fraction"]
                for ox, v in _lv[t["layer"]]["oxides"].items():
                    tot[ox] = tot.get(ox, 0.0) + fr * v
            s = sum(tot.values()) or 1.0
            return {k: v / s for k, v in tot.items()}, []
        mission_mod.blend_vector = _blend_vector_scoped
        import ewg.farm_mission as farm_mod
        farm_mod.blend_vector = _blend_vector_scoped

        camps = res["campaigns"]
        glass_kg = 0.0
        waste_kg = 0.0
        for c in camps:
            r = evaluate_campaign_recipe(c["recipe"])
            wl = r["waste_loading"]
            glass_kg += c["waste_kg"] / wl if wl > 0 else 0.0
            waste_kg += c["waste_kg"]
        out[tag] = {
            "n_campaigns": len(camps),
            "total_waste_kg": waste_kg,
            "total_glass_kg": glass_kg,
            "canisters": glass_kg / 3097.0,
            "seconds": round(time.time() - t0, 1),
        }
        print(f"{tag}: {len(camps)} campaigns, {waste_kg/1e6:.2f} Mt oxide, "
              f"{glass_kg/1e6:.2f} Mt glass in {out[tag]['seconds']} s")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=1)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
