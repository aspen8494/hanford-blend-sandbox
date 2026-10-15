# Hanford HLW Blend Sandbox

An in-browser toy of the campaign-building problem: **pack waste blends into
a volume band under WAC constraints and watch the glass mass respond.**
A scaled-down, fully client-side cousin of the campaign builder.

Host the `web/` folder anywhere static — GitHub Pages, S3, your own site.
No server, no build step, no tracking: everything (including the optimizer)
runs in the visitor's browser.

## What it shows

The full blending application plans the vitrification campaign for the
Hanford tank farm: group the DFHLW feed layers (and retrieval heels) into
blends of 450–550 kgal that satisfy Waste Acceptance Criteria (WAC), then
for each blend formulate a compliant borosilicate glass and total the
resulting canisters.  This sandbox reproduces that pipeline at reduced
scope, live in the browser:

- **Campaign builder** — the same greedy volume-band packer with WAC-feasible
  linear-program refinement, quadrant ordering (SE → NE → NW → SW), and the
  ≤5-layer campaign cap.  Interactive: move the volume band, rescale WAC,
  toggle heels.
- **Glass formulation engine** — the EWG2.5 property models (PNNL-35884
  Rev. 1): VFT viscosity, electrical conductivity, PCT response, sulfate
  and phosphate solubility, and the glass-former linear program solved by a
  purpose-built simplex + sequential-linear-programming optimizer, all
  ported 1:1 from the Python implementation.
- **Mission roll-up** — glass mass, canister count, and melter duration at
  your chosen glass rate and availability.

Every number a visitor sees is computed by the same algorithms as the full
application, just with a reduced dataset (one blend-condition scenario family
shipped by default).

## Layout

```
web/                     ← host this folder
  index.html             the sandbox page
  css/sandbox.css
  js/engine/lp.js        dense primal simplex (Bland's rule)
  js/engine/sqp.js       L1-penalty SLP optimizer (scipy-SLSQP analogue)
  js/engine/glass.js     EWG2.5 glass property + formulation models
  js/engine/engine.js    campaign builder + mission roll-up
  js/app.js              UI controller
  data/mission_data.json layers, WAC rows, covariance, scenarios
tools/                   ← python-side, for regenerating web/data
  build_sandbox_data.py  extracts the dataset from the full application
  gen_parity_fixtures.py regenerates formulation parity fixtures
  gen_mission_fixture.py regenerates mission roll-up fixtures
tests/                   ← node, no dependencies
  lp_test.js             simplex unit tests (10)
  glass_parity.js        property-model parity vs Python (57)
  formulate_parity.js    end-to-end formulation parity (27)
  mission_parity.js      mission roll-up parity vs Python
  fixtures/              generated reference outputs from the full app
```

## Run it locally

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000
```

(Any static file server works.  A server is needed because the dataset is
fetched via `fetch()`; `file://` will not load it.)

## Run the tests

```bash
node tests/lp_test.js
node tests/glass_parity.js
node tests/formulate_parity.js
node tests/mission_parity.js 135.120.150        # App-D layers only
node tests/mission_parity.js 135.120.150 heels   # App-D + retrieval heels
```

The fixtures in `tests/fixtures/` are generated from the full application
(`tools/*.py`); regenerate them whenever the full app's models change.

## Parity with the full application

The JS engine is pinned against the Python implementation:

| Test suite | What it pins |
|---|---|
| `lp_test.js` | simplex correctness on hand-checked LPs |
| `glass_parity.js` | property models (η, EC, PCT, solubility, k1208) vs Python, per constraint |
| `formulate_parity.js` | full formulate() output (waste loading, glass, GFCs) on 3 reference wastes |
| `mission_parity.js` | mission roll-up: waste oxide ±5%, glass mass ±7%, campaign count within 25% |

Campaign counts differ slightly between the engines because the greedy
walk's tie-breaking (which layer enters a campaign first among equals) is
not fully specified in the reference; waste totals match exactly because
the same pool is packed either way.  Glass mass absorbs the blend-split
wiggle through per-campaign waste loading.

**This is a marketing overview, not an engineering basis.**  The sandbox
computes with the same algorithms but a reduced data scope; do not use its
numbers for design or compliance work.

## Provenance

- Campaign builder & mission models: ported from the internal blending
  mission application (RPP-RPT-64878-01 campaign framework).
- Glass property models: PNNL-35884 Rev. 1 (EWG2.5), including Table 3-3/3-4
  constraint rows and the Appendix C covariance for uncertainty margins.
- Optimizer: `scipy.optimize.minimize(SLSQP)` re-implemented in JS as an
  L1-penalty sequential linear program over the bundled simplex.
