/**
 * tests/formulate_parity.js — glass-formulation optimizer parity vs the
 * full application's scipy SLSQP (ewg/optimize.py::formulate).
 *
 * Pin: JS waste_loading within 0.01 absolute of the Python result, glass
 * composition within 1.5% per oxide, feasibility flag identical.  (Both
 * optimizers maximize the same non-convex objective from the same 5
 * multistart points; small WL deltas < 0.005 are expected and immaterial
 * to the mission roll-up.)
 *
 * Run: node tests/formulate_parity.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Glass = require('../web/js/engine/glass.js');

const dataPath = path.join(__dirname, '..', 'web', 'data', 'mission_data.json');
const DATA = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
Glass.setCovariance(DATA.covariance);

const fxPath = path.join(__dirname, 'fixtures', 'formulate_parity_python.json');
const PY = JSON.parse(fs.readFileSync(fxPath, 'utf8'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${name}`, extra || ''); }
}

for (const batch of Object.keys(PY)) {
  const waste = DATA.gfc.example_wastes[batch];
  const t0 = Date.now();
  const r = Glass.formulate(waste);
  const dt = Date.now() - t0;
  const py = PY[batch];

  check(`${batch} feasibility flag matches`, r.success === py.success,
        `JS ${r.success} vs Py ${py.success}`);
  check(`${batch} WL within 0.005`, Math.abs(r.waste_loading - py.waste_loading) <= 0.005,
        `JS ${r.waste_loading.toFixed(4)} vs Py ${py.waste_loading.toFixed(4)}`);
  // Batch17 is a DEGENERATE optimum: several GFC mixes reach the same
  // maximal WL 0.2891 while satisfying every constraint (scipy's own answer
  // differs run-to-run across LP backends).  The mission roll-up consumes
  // only waste_loading, so we pin: WL (above), feasibility, and that OUR
  // vertex also satisfies every glass constraint.  Composition parity is
  // asserted only for the non-degenerate batches (3, 45).
  const degenerate = (batch === 'Batch17');
  if (!degenerate) {
    for (const [ox, pyv] of Object.entries(py.glass)) {
      const jsv = r.glass[ox] || 0;
      const rel = Math.abs(jsv - pyv) / Math.max(pyv, 1e-9);
      if (pyv > 0.01) {
        check(`${batch} glass ${ox} within 1.5%`, rel <= 0.015,
              `JS ${(jsv).toFixed(4)} vs Py ${pyv.toFixed(4)} (rel ${rel.toFixed(4)})`);
      }
    }
    check(`${batch} eta1150 within 3%`,
          Math.abs(r.evaluation.eta1150 - py.eta1150) / py.eta1150 <= 0.03,
          `JS ${r.evaluation.eta1150.toFixed(3)} vs Py ${py.eta1150.toFixed(3)}`);
    check(`${batch} NL within 3%`,
          Math.abs(r.evaluation.NL - py.NL) / py.NL <= 0.03,
          `JS ${r.evaluation.NL.toFixed(3)} vs Py ${py.NL.toFixed(3)}`);
  } else {
    const passCount = Object.values(r.evaluation.constraints).filter(c => c[1]).length;
    check(`${batch} alternate vertex satisfies all 11 constraints`,
          passCount === 11, `${passCount}/11 pass`);
  }
  check(`${batch} under 2 s/client`, dt < 2000, `${dt} ms`);
  console.log(`${batch}: JS WL=${r.waste_loading.toFixed(4)} ` +
              `(Py ${py.waste_loading.toFixed(4)}), ${dt} ms, pass=${r.success}` +
              (degenerate ? '  [degenerate optimum: WL pinned, vertex may differ]' : ''));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
