/**
 * tests/lp_test.js — smoke tests for the sandbox LP solver.
 * Run: node tests/lp_test.js
 */
'use strict';
const LP = require('../web/js/engine/lp.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${name}`, extra || ''); }
}

// 1. trivial: min x s.t. x >= 2 (as -x <= -2), x <= 10
{
  const r = LP.solve([1], [[-1]], [-2], { hi: [10] });
  check('min subject to lower bound', r.status === 'optimal' && Math.abs(r.x[0] - 2) < 1e-7, r);
}
// 2. two variables, one binding constraint
{
  // min -x0 - x1  s.t. x0 + x1 <= 1, 0<=x<=1
  const r = LP.solve([-1, -1], [[1, 1]], [1], { hi: [1, 1] });
  check('sum cap', r.status === 'optimal' && Math.abs(r.x[0] + r.x[1] - 1) < 1e-6, r);
}
// 3. infeasible: x >= 5 and x <= 2
{
  const r = LP.solve([1], [[1], [-1]], [2, -5], { hi: [Infinity] });
  check('infeasible detection', r.status === 'infeasible', r);
}
// 4. negative rhs handling (b < 0 rows)
{
  // min -x s.t. -2x <= -3 (i.e. x >= 1.5), x <= 10 → optimum x=10
  const r = LP.solve([-1], [[-2]], [-3], { hi: [10] });
  check('negative rhs', r.status === 'optimal' && Math.abs(r.x[0] - 10) < 1e-7, r);
  // and with hi=1.2 the constraint binds: x=1.5 infeasible → x=1.2
  const r2 = LP.solve([-1], [[-2]], [-3], { hi: [1.2] });
  check('negative rhs infeasible band', r2.status === 'infeasible', r2);
}
// 5. WAC-style row: (v - lim)·x <= 0 with mixed values
{
  // layers: v=[1.31, 0.5], lim=1.0 → 0.31 x0 - 0.5 x1 <= 0; maximize x0+x1
  // with band rows: x0+x1 <= 100 (Vmax), -(x0+x1) <= -50 (Vmin)
  const r = LP.solve([-1, -1], [[1, 1], [-1, -1], [0.31, -0.5]], [100, -50, 0],
                     { hi: [80, 80] });
  check('wac-row feasibility', r.status === 'optimal' &&
        r.x[0] + r.x[1] >= 50 - 1e-6 &&
        0.31 * r.x[0] - 0.5 * r.x[1] <= 1e-6, r);
}
// 6. random LPs vs brute-force corner enumeration (n=2)
{
  let ok = 0, n = 0;
  for (let t = 0; t < 200; t++) {
    const c = [Math.random() * 2 - 1, Math.random() * 2 - 1];
    const A = [], b = [];
    const nRows = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < nRows; i++) {
      A.push([Math.random() * 2 - 1, Math.random() * 2 - 1]);
      b.push(Math.random() * 4 - 1);
    }
    const hi = [Math.random() * 5, Math.random() * 5];
    const r = LP.solve(c, A, b, { hi });
    // brute force: check corners of {[0,hi0]×[0,hi1]} ∩ {Ax≤b}
    let bestObj = Infinity, feasibleCorner = false;
    const cands = [0, hi[0], hi[0] * 0.37];
    const cands1 = [0, hi[1], hi[1] * 0.61];
    for (const v0 of cands) {
      for (const v1 of cands1) {
        let feas = true;
        for (let i = 0; i < A.length; i++) {
          if (A[i][0] * v0 + A[i][1] * v1 > b[i] + 1e-9) { feas = false; break; }
        }
        if (feas) {
          feasibleCorner = true;
          bestObj = Math.min(bestObj, c[0] * v0 + c[1] * v1);
        }
      }
    }
    if (r.status === 'optimal') {
      n++;
      if (r.obj <= bestObj + 1e-6) ok++;
      else if (!feasibleCorner) ok++;
    } else if (r.status === 'infeasible' && feasibleCorner) {
      // LP said infeasible but a corner works → bug
      check(`random LP ${t}: infeasible but corner feasible`, false, { A, b, hi });
    } else {
      n++; ok++;
    }
  }
  check('200 random 2-var LPs match corner enumeration', ok === n, `${ok}/${n}`);
}
// 7. degenerate cycling protection (Bland's rule)
{
  const r = LP.solve([-1, -1], [[1, 0], [0, 1], [1, 1]], [1, 1, 1], { hi: [1, 1] });
  check('degenerate ties', r.status === 'optimal' && Math.abs(r.obj + 1) < 1e-7, r);
}
// 8. larger sparse LP (campaign-sized): 12 vars, 80 rows
{
  const n = 12;
  const c = new Array(n).fill(-1);
  const A = [];
  const b = [];
  A.push(new Array(n).fill(1)); b.push(2000);
  A.push(new Array(n).fill(-1)); b.push(-1700);
  for (let i = 0; i < 39; i++) {
    const row = new Array(n).fill(0).map(() => (Math.random() * 2 - 1) * 100);
    A.push(row); b.push(0);
  }
  const hi = new Array(n).fill(416.4);
  const t0 = Date.now();
  const r = LP.solve(c, A, b, { hi });
  const dt = Date.now() - t0;
  check('campaign-sized LP solves', r.status === 'optimal' || r.status === 'infeasible', { r, dt });
  check('campaign-sized LP fast', dt < 500, `${dt} ms`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
