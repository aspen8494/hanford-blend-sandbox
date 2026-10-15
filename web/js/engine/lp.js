/**
 * lp.js — Dense two-phase primal simplex for the sandbox campaign LP.
 *
 * Scaled-down port of the scipy/HiGHS LP used by the full application's
 * `refine_campaign` (ewg/campaign_builder.py).  Campaign LPs here are small
 * (≤ ~12 variables, ≤ ~100 rows), so a textbook dense tableau two-phase
 * simplex with Bland's anti-cycling rule is adequate and keeps the sandbox
 * dependency-free.
 *
 * Problem form:  minimize c·x  s.t.  A·x ≤ b,  0 ≤ x ≤ hi   (b may be < 0)
 *
 * Standard-form conversion (b_std ≥ 0, one basis per row):
 *   b_i ≥ 0 :  A_i·x + s_i = b_i                (slack basic)
 *   b_i < 0 :  (-A_i)·x - s_i + a_i = -b_i      (artificial basic)
 * Phase 1 minimizes Σ a_i; phase 2 minimizes c·x with artificials forbidden.
 */
(function (root) {
  'use strict';

  const PIV_EPS = 1e-10;    // pivot magnitude threshold
  const COST_EPS = 1e-9;    // reduced-cost threshold
  const FEAS_EPS = 1e-7;    // phase-1 feasibility threshold
  const MAX_ITER = 60000;

  /**
   * @param {number[]} c      objective (length n)
   * @param {number[][]} Aub  inequality matrix (m × n)
   * @param {number[]} bub    rhs (length m, any sign)
   * @param {{hi?:number[]}} bounds  per-variable upper bounds (defaults ∞)
   * @returns {{status:'optimal'|'infeasible'|'unbounded', x:number[]|null, obj:number}}
   */
  function solve(c, Aub, bub, bounds) {
    const n = c.length;
    const hi = (bounds && bounds.hi) ? bounds.hi.slice()
                                     : new Array(n).fill(Infinity);

    // --- assemble rows: Aub plus folded upper bounds -------------------
    const rowsA = [], rowsB = [];
    for (let i = 0; i < Aub.length; i++) {
      rowsA.push(Aub[i].slice());
      rowsB.push(bub[i]);
    }
    for (let j = 0; j < n; j++) {
      if (isFinite(hi[j]) && hi[j] >= 0) {
        const row = new Array(n).fill(0);
        row[j] = 1;
        rowsA.push(row);
        rowsB.push(hi[j]);
      }
    }
    const m = rowsA.length;

    // --- build standard-form tableau ------------------------------------
    // columns: [x (n)] + [slack/surplus (m)] + [artificials]
    const nSlack = m;
    let nCols = n + nSlack;
    const T = [];                     // m rows × (nCols+1), last col = rhs
    const basis = new Array(m);
    const isArtificialRow = new Array(m).fill(false);

    // pass 1: count artificials needed
    let nArt = 0;
    const artColOf = new Array(m).fill(-1);
    for (let i = 0; i < m; i++) if (rowsB[i] < 0) nArt++;
    if (nArt > 0) nCols += nArt;

    let nextArt = n + nSlack;
    for (let i = 0; i < m; i++) {
      const row = new Array(nCols + 1).fill(0);
      const b = rowsB[i];
      if (b >= 0) {
        for (let j = 0; j < n; j++) row[j] = rowsA[i][j];
        row[n + i] = 1;               // slack
        row[nCols] = b;
        basis[i] = n + i;
      } else {
        for (let j = 0; j < n; j++) row[j] = -rowsA[i][j];
        row[n + i] = -1;              // surplus (coefficient -1)
        row[nextArt] = 1;             // artificial
        row[nCols] = -b;
        basis[i] = nextArt;
        artColOf[i] = nextArt;
        isArtificialRow[i] = true;
        nextArt++;
      }
      T.push(row);
    }

    const pivot = (r, k) => {
      const piv = T[r][k];
      const Tr = T[r];
      for (let j = 0; j <= nCols; j++) Tr[j] /= piv;
      for (let i = 0; i < m; i++) {
        if (i === r) continue;
        const f = T[i][k];
        if (f !== 0) {
          const Ti = T[i];
          for (let j = 0; j <= nCols; j++) Ti[j] -= f * Tr[j];
        }
      }
      basis[r] = k;
    };

    // generic simplex sweep on a cost vector (minimize), given current basis.
    // enters first improving column (Bland) — guaranteed termination.
    const runSimplex = (cost, forbidden) => {
      for (let iter = 0; iter < MAX_ITER; iter++) {
        // reduced costs: z_j = c_j - Σ_i c_B[i]·T[i][j]
        let k = -1;
        for (let j = 0; j < nCols; j++) {
          if (forbidden && forbidden.has(j)) continue;
          let zj = cost[j] || 0;
          for (let i = 0; i < m; i++) {
            const cb = (basis[i] < cost.length) ? (cost[basis[i]] || 0) : 0;
            if (cb !== 0) zj -= cb * T[i][j];
          }
          if (zj < -COST_EPS) { k = j; break; }
        }
        if (k < 0) return true;   // optimal
        // ratio test (Bland tie-break: smallest row index)
        let r = -1, best = Infinity;
        for (let i = 0; i < m; i++) {
          const aik = T[i][k];
          if (aik > PIV_EPS) {
            const ratio = T[i][nCols] / aik;
            if (ratio < best - 1e-12) { best = ratio; r = i; }
          }
        }
        if (r < 0) return false;  // unbounded
        pivot(r, k);
      }
      return true; // iteration guard hit; treat as converged
    };

    // --- phase 1 ---------------------------------------------------------
    if (nArt > 0) {
      const cost1 = new Array(nCols).fill(0);
      for (let i = 0; i < m; i++) if (artColOf[i] >= 0) cost1[artColOf[i]] = 1;
      const feasible = runSimplex(cost1, null);
      // objective value = Σ artificial basics
      let artSum = 0;
      for (let i = 0; i < m; i++) {
        if (isArtificialRow[i] && basis[i] === artColOf[i]) {
          artSum += Math.max(0, T[i][nCols]);
        }
      }
      if (!feasible || artSum > FEAS_EPS) {
        return { status: 'infeasible', x: null, obj: NaN };
      }
      // drive zero-valued artificials out of the basis where possible
      for (let i = 0; i < m; i++) {
        if (isArtificialRow[i] && basis[i] === artColOf[i]) {
          if (Math.abs(T[i][nCols]) < 1e-8) {
            for (let j = 0; j < n + nSlack; j++) {
              if (Math.abs(T[i][j]) > 1e-8) { pivot(i, j); break; }
            }
          }
        }
      }
    }

    // --- phase 2 ----------------------------------------------------------
    const forbidden = new Set();
    for (let i = 0; i < m; i++) if (artColOf[i] >= 0) forbidden.add(artColOf[i]);
    const cost2 = c.slice();
    runSimplex(cost2, forbidden);

    const x = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      if (basis[i] < n) x[basis[i]] = Math.max(0, T[i][nCols]);
    }
    let obj = 0;
    for (let j = 0; j < n; j++) obj += c[j] * x[j];
    return { status: 'optimal', x, obj };
  }

  const api = { solve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LP = api;
})(typeof self !== 'undefined' ? self : globalThis);
