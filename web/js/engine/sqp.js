/**
 * sqp.js — Sequential linear-quadratic optimizer for the sandbox glass
 * formulation (client-side stand-in for scipy's SLSQP used by the full
 * application's ewg/optimize.py).
 *
 * Algorithm (sequential LP with L1-penalty slacks — the "method of
 * approximation programs" variant of SLSQP's Kraft L1 subproblem,
 * implemented on top of the tested dense simplex in lp.js):
 *
 *   At iterate x, linearize all constraints and solve ONE LP over the
 *   step d and slacks ξ:
 *     min  gᵀd + W·Σξ
 *     s.t. c_i + J_i·d ≥ −ξ_i        (inequalities, slacked)
 *          h_e + J_e·d = 0           (equalities, exact — they are linear)
 *          d_lo ≤ d ≤ d_hi           (box + trust region)
 *   then backtrack on the exact-L1 merit φ(x) = f(x) + W·V(x),
 *   V = Σ|h| + Σ max(0, −c), adapting the trust radius to step success.
 *   An outer penalty loop raises W (×10) and re-runs if V > tol at the
 *   end, guaranteeing feasibility-first behavior.
 *
 * Why not a classical active-set SQP: the property models are exponential
 * (VFT 10^(A+B/T)); a hard-linearized QP overshoots them from infeasible
 * starts and the merit line search stalls (measured: violation crawling
 * at 0.004/iter while multipliers exploded past 1e9).  The slacked-LP
 * step degrades gracefully instead, and every subproblem solves to
 * optimality on the proven simplex.
 *
 * For the small problems here (n = 11 variables, ~60 constraints) each LP
 * takes a few ms.  Parity is pinned by tests/formulate_parity.js against
 * the full app's scipy/SLSQP outputs on the PNNL-35884 example wastes.
 */
(function (root) {
  'use strict';

  const LP = (typeof module !== 'undefined' && module.exports)
    ? require('./lp.js')
    : root.LP;

  const MAX_ITER = 300;
  const OUTER_MAX = 6;         // penalty-escalation restarts
  const VIOL_OK = 5e-5;        // feasibility tolerance (sum over ~60 rows;
                               // the full app applies 1e-7 PER CONSTRAINT and
                               // its slacks carry Upred margins — the sum
                               // scale must accommodate ~60 rows of float
                               // noise on margin-relaxed duplicates)
  const FTOL = 1e-14;          // merit-change convergence tolerance
  const PHOS_OK = 5e-5;        // per-constraint polish tolerance (glass boundary)
  const DELTA0 = 0.25;         // initial trust radius (x are mass fractions)
  const DELTA_MAX = 0.5;

  function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

  /**
   * @param {(x:number[])=>number} f         objective (minimize)
   * @param {(x:number[])=>number[]} gradF   objective gradient
   * @param {number[]} x0                    start (clamped to bounds)
   * @param opts {fEq:[], jEq:[], fIneq:[], jIneq:[], bounds:[[lo,hi]...]}
   */
  function solve(f, gradF, x0, opts) {
    opts = opts || {};
    const n = x0.length;
    const fEq = opts.fEq || [];
    const jEq = opts.jEq || [];
    const fIneq = opts.fIneq || [];
    const jIneq = opts.jIneq || [];
    const bounds = opts.bounds || null;
    const loB = bounds ? bounds.map(b => b[0]) : null;
    const hiB = bounds ? bounds.map(b => b[1]) : null;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

    let x = x0.slice();
    if (bounds) for (let j = 0; j < n; j++) x[j] = clamp(x[j], loB[j], hiB[j]);

    const violation = (xv) => {
      let v = 0;
      for (const fn of fEq) v += Math.abs(fn(xv));
      for (const fn of fIneq) { const c = fn(xv); if (c < 0) v -= c; }
      return v;
    };

    const finish = (xv, success) => ({ x: xv, success, violation: violation(xv) });

    let W = 100.0;
    let best = null;   // best feasible point seen

    for (let outer = 0; outer < OUTER_MAX; outer++) {
      let delta = DELTA0;
      let fx = f(x);
      let V = violation(x);
      let stall = 0;

      for (let iter = 0; iter < MAX_ITER; iter++) {
        const g = gradF(x);

        // ---- slacked LP over step d (shifted so y = d − dLo ≥ 0) --------
        const m = fIneq.length;
        const nVar = n + m;
        const dLo = new Array(n), dHi = new Array(n);
        for (let j = 0; j < n; j++) {
          dLo[j] = bounds ? Math.max(loB[j] - x[j], -delta) : -delta;
          dHi[j] = bounds ? Math.min(hiB[j] - x[j], delta) : delta;
          if (dHi[j] < dLo[j]) dHi[j] = dLo[j];
        }
        // objective: gᵀd + W Σξ ; constant gᵀdLo dropped
        const c = new Array(nVar).fill(0);
        for (let j = 0; j < n; j++) c[j] = g[j];
        for (let i = 0; i < m; i++) c[n + i] = W;

        const A = [];
        const b = [];
        // inequality rows:  c_i + J_i·(y + dLo) + ξ_i ≥ 0
        //   ⇔  −J_i·y − ξ_i ≤ c_i + J_i·dLo
        for (let i = 0; i < m; i++) {
          const Ji = jIneq[i](x);
          const ci = fIneq[i](x);
          const row = new Array(nVar).fill(0);
          for (let j = 0; j < n; j++) row[j] = -Ji[j];
          row[n + i] = -1;
          let rhs = ci;
          for (let j = 0; j < n; j++) rhs += Ji[j] * dLo[j];
          A.push(row); b.push(rhs);
        }
        // equality rows (linear in x — Σx = 1): J_e·d = −h_e, two ≤ rows
        for (let e = 0; e < fEq.length; e++) {
          const Je = jEq[e](x);
          const he = fEq[e](x);
          const row1 = new Array(nVar).fill(0);
          const row2 = new Array(nVar).fill(0);
          for (let j = 0; j < n; j++) { row1[j] = Je[j]; row2[j] = -Je[j]; }
          let rhs1 = -he, rhs2 = he;
          for (let j = 0; j < n; j++) { rhs1 -= Je[j] * dLo[j]; rhs2 += Je[j] * dLo[j]; }
          A.push(row1); b.push(rhs1);
          A.push(row2); b.push(rhs2);
        }
        const hi = new Array(nVar).fill(Infinity);
        for (let j = 0; j < n; j++) hi[j] = dHi[j] - dLo[j];

        const lp = LP.solve(c, A, b, { hi });
        if (lp.status !== 'optimal') break;

        const d = new Array(n);
        for (let j = 0; j < n; j++) d[j] = lp.x[j] + dLo[j];
        const dNorm = Math.sqrt(dot(d, d));
        if (dNorm < 1e-11) {
          if (V < VIOL_OK) return finish(x, true);
          break;
        }

        // ---- L1 merit backtracking --------------------------------------
        const phi0 = fx + W * V;
        let alpha = 1.0, accepted = false, xNew = null;
        for (let ls = 0; ls < 30; ls++) {
          const cand = x.map((v, j) => bounds
            ? clamp(v + alpha * d[j], loB[j], hiB[j])
            : v + alpha * d[j]);
          const phi = f(cand) + W * violation(cand);
          if (phi < phi0 - 1e-14) { accepted = true; xNew = cand; break; }
          alpha *= 0.5;
        }
        if (!accepted) {
          delta *= 0.25;                    // shrink trust region, retry
          if (delta < 1e-9) break;
          continue;
        }

        const fNew = f(xNew);
        const Vnew = violation(xNew);
        const meritPrev = fx + W * V;
        const meritNew = fNew + W * Vnew;
        const improved = meritPrev - meritNew;

        if (Vnew < VIOL_OK && (best === null || fNew < best.f)) {
          best = { x: xNew.slice(), f: fNew };
        }
        x = xNew;
        fx = fNew;
        V = Vnew;
        if (alpha === 1.0 && improved > 1e-10) {
          delta = Math.min(delta * 2, DELTA_MAX);   // full step → grow radius
        }
        if (improved < FTOL) {
          stall++;
          if (stall >= 3) break;
        } else stall = 0;
        if (V < VIOL_OK && improved < 1e-13 && alpha === 1.0) break;
      }

      if (V < VIOL_OK) return finish(x, true);
      if (best && violation(best.x) < VIOL_OK) return finish(best.x, true);

      // ---- backtracking polish ------------------------------------------
      // Near a vertex optimum the linearized LP reports feasible while the
      // TRUE nonlinear constraints sit marginally outside (curvature; measured
      // p_phos +1.4e-4, ec1200 +2e-5 at the returned vertex).  Restoration
      // LPs regenerate the same degenerate direction, so instead walk the
      // solution toward the GFC interior: swap small amounts of Waste for the
      // neutral glass former (largest-coefficient GFC — empirically Silica),
      // renormalize, and stop at the first truly feasible point.  The move
      // is O(1e-3) in WL (0.5293 → 0.5283 measured) — well below the LP/GFC
      // rounding noise the mission roll-up already tolerates.
      {
        // pick the polish recipient: GFC with the largest x (if any) else
        // the GFC with the largest total oxide yield
        let recip = -1, bestVal = -1;
        for (let j = 1; j < n; j++) {
          if (x[j] > bestVal) { bestVal = x[j]; recip = j; }
        }
        if (recip > 0) {
          let xpol = x.slice();
          for (let k = 1; k <= 40; k++) {
            const dW = 0.0005 * k;
            if (dW >= xpol[0]) break;
            const cand = x.slice();
            cand[0] -= dW;
            cand[recip] += dW;
            const t = cand.reduce((s, v) => s + v, 0);
            for (let j = 0; j < n; j++) cand[j] /= t;
            if (violation(cand) < VIOL_OK) { xpol = cand; break; }
            xpol = cand;   // keep best-so-far even if none feasible
          }
          if (violation(xpol) < VIOL_OK) {
            if (best === null || f(xpol) < best.f) best = { x: xpol.slice(), f: f(xpol) };
            return finish(xpol, true);
          }
        }
      }

      // escalate penalty and continue from current point
      W *= 10;
      if (W > 1e12) break;
    }

    if (best && violation(best.x) < VIOL_OK) return finish(best.x, true);
    return finish(x, violation(x) < VIOL_OK);
  }

  const api = { solve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SQP = api;
})(typeof self !== 'undefined' ? self : globalThis);
