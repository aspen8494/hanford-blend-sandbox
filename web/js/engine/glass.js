/**
 * glass.js — EWG2.5 glass formulation for the sandbox (client-side).
 *
 * Faithful port of the full application's ewg/properties.py + ewg/optimize.py
 * (PNNL-35884 Rev. 1 models, paper-verified against Tables 3-5/3-6):
 *   - PCT Ave ln[NL] (PQM, 13 terms, own basis)
 *   - viscosity + EC via VFT (B = Σ Bᵢgᵢ, own basis, T in K)
 *   - sulfate wSO3-3TS PQMM (own basis, SO3-free renorm, MT offset 0.33)
 *   - K-3 ln[k1208] PQM (own basis, (SO3+Cl)-free renorm)
 *   - phosphate logistic (Table 2-12, no intercept)
 *   - N_NaLi immiscibility ≥ 0.20; NALK / NSiAl validity ranges
 *   - MV bounds (Table 3-2) on modeled components
 *   - Upred prediction-uncertainty margins from Appendix-C covariance
 *   - SLSQP multistart (0.40, 0.20, 0.10, 0.05, 0.30) maximize waste loading
 *
 * SLSQP itself is a compact port: BFGS-ish quasi-Newton with an equality
 * and inequality constraint handler (sqp.js in this directory).
 */
(function (root) {
  'use strict';
  // Cross-module resolution: in Node (tests/tools), resolve sibling modules
  // via require; in the browser they share the global scope (root.SQP).
  const SQP = (typeof module !== 'undefined' && module.exports)
    ? require('./sqp.js')
    : root.SQP;

  // ------------------------------------------------------------------
  // GFC library (oxide yield per unit raw chemical)
  // ------------------------------------------------------------------
  const MW = {
    SiO2: 60.0843, B2O3: 69.6202, Al2O3: 101.9613, CaO: 56.0774,
    Na2O: 61.9789, K2O: 94.196, Li2O: 29.8814, ZnO: 81.379, ZrO2: 123.218,
    Cr2O3: 151.9904, V2O5: 181.88, H3BO3: 61.833, H2O: 18.0153,
    Na2CO3: 105.9888, Li2CO3: 73.8909, CaSiO3: 116.1617, CO2: 44.0095,
    Al2SiO5: 162.0456,
  };
  const GFCS = {
    Kyanite:      { Al2O3: MW.Al2O3 / MW.Al2SiO5, SiO2: MW.SiO2 / MW.Al2SiO5 },
    BoricAcid:    { B2O3: MW.B2O3 / (2 * MW.H3BO3) },
    Wollastonite: { CaO: MW.CaO / MW.CaSiO3, SiO2: MW.SiO2 / MW.CaSiO3 },
    Na2CO3:       { Na2O: MW.Na2O / MW.Na2CO3 },
    Li2CO3:       { Li2O: MW.Li2O / MW.Li2CO3 },
    Cr2O3:        { Cr2O3: 1.0 },
    Silica:       { SiO2: 1.0 },
    Zincite:      { ZnO: 1.0 },
    Zircon:       { ZrO2: MW.ZrO2 / (MW.ZrO2 + MW.SiO2), SiO2: MW.SiO2 / (MW.ZrO2 + MW.SiO2) },
    V2O5:         { V2O5: 1.0 },
  };
  const GFC_NAMES = Object.keys(GFCS);

  const FULL_OXIDES = [
    'Al2O3', 'B2O3', 'CaO', 'Cl', 'Cr2O3', 'F', 'Fe2O3', 'K2O', 'Li2O', 'MgO', 'MnO',
    'Na2O', 'NiO', 'P2O5', 'SiO2', 'SO3', 'SnO2', 'TiO2', 'V2O5', 'ZnO', 'ZrO2',
    'RE2O3', 'Bi2O3', 'BaO', 'CdO', 'SrO', 'PbO', 'Ag2O', 'PdO', 'Rh2O3', 'RuO2',
    'UO3', 'ThO2', 'As2O3', 'BeO', 'CoO', 'CuO', 'HgO', 'MoO3', 'Nb2O5',
    'Sb2O3', 'SeO2', 'TeO2', 'Ta2O5', 'Tl2O', 'WO3', 'Y2O3', 'Cs2O', 'Others',
  ];
  const CR2O3_MAX = 0.006;

  // ------------------------------------------------------------------
  // Property-model coefficients (PNNL-35884 Rev. 1, ported verbatim)
  // ------------------------------------------------------------------
  const PCT_LIN = {
    Al2O3: -53.15774, B2O3: 12.07217, CaO: -14.77972, Li2O: 29.306445,
    Na2O: 18.110349, SiO2: -4.531755, SnO2: -10.12384, TiO2: 0.0,
    V2O5: 5.2426736, ZnO: -12.22331, ZrO2: -1.421716, Others: 12.938447,
  };
  const PCT_QUAD = [['Al2O3', 'Al2O3', 137.13002], ['Al2O3', 'CaO', 117.30595]];
  const PCT_MODELED = ['Al2O3', 'B2O3', 'CaO', 'Li2O', 'Na2O', 'SiO2', 'SnO2', 'TiO2', 'V2O5', 'ZnO', 'ZrO2'];
  const PCT_LIMIT = 6.4368;   // g/m2 (limit applied to exp(lnNL))

  const VFT = {
    visc: { A: -2.6135, T0: 600.804, B: {
      Al2O3: 6632.044, B2O3: -519.437, CaO: -389.161, Fe2O3: 1642.818,
      K2O: 623.434, Li2O: -10199.1, MgO: 2055.801, Na2O: -1311.46,
      P2O5: 3729.876, SiO2: 5257.354, SnO2: 3757.721, TiO2: 1644.819,
      V2O5: 1022.555, ZnO: 929.4394, ZrO2: 4921.279, Others: 1907.84,
    } },
    ec: { A: 0.772566, T0: 600.9442, B: {
      Al2O3: -2087.53, B2O3: -1414.09, CaO: -1842.64, Fe2O3: -1266.8,
      K2O: -641.96, Li2O: 4635.015, MgO: -1003.17, Na2O: 1980.649,
      P2O5: -2337.66, SiO2: -1834.85, SnO2: -2442.23, TiO2: -1087.99,
      V2O5: -672.313, ZnO: -731.135, ZrO2: -1831.21, Others: -713.126,
    } },
  };
  const ETA1150_RANGE = [4.0, 6.0];
  const ETA1100_MAX = 15.0;
  const EC1100_MIN = 0.10;
  const EC1200_MAX = 0.70;

  const SO3_LIN = {
    Al2O3: 3.311369, B2O3: 2.480127, CaO: -19.2638, F: 2.90893,
    K2O: 3.564656, Li2O: 15.83879, Na2O: 10.68731, P2O5: 4.275421,
    SiO2: -2.11066, V2O5: 7.299997, ZrO2: -4.67831, Others: -2.85583,
  };
  const SO3_CROSS = [['B2O3', 'CaO', 46.86848], ['Al2O3', 'Na2O', -43.0749],
                     ['CaO', 'SiO2', 52.50427]];
  const SO3_MT_OFFSET = 0.33;

  const K3_LIN = {
    Al2O3: -18.8275, B2O3: -2.23895, CaO: 8.779949, Cr2O3: -296.638,
    Fe2O3: 10.96977, Li2O: 52.95097, MgO: -147.13, MnO: -25.5567,
    Na2O: 22.16205, P2O5: -19.6081, SiO2: -14.8231, SnO2: -2.05913,
    TiO2: -39.9969, V2O5: -9.56704, ZnO: -12.3489, ZrO2: -9.90048,
    Others: 13.76996,
  };
  const K3_SQ = [['Fe2O3', 'Fe2O3', -114.49]];
  const K3_CROSS = [['Cr2O3', 'Na2O', 1093.039], ['MgO', 'SiO2', 337.1618],
                    ['Na2O', 'TiO2', 190.5963]];
  const K3_LIMIT = 0.04;      // in (inches)
  const K3_NALK_RANGE = [0.1381, 0.2743];
  const K3_NSIAL_RANGE = [0.4570, 0.7236];

  const P_LIN = {
    CaO: 52.97384, Li2O: -89.1373, Na2O: 149.5926, P2O5: 45.90846,
    SiO2: 35.94944, RE2O3: 140.3734, Others: -21.222,
  };
  const P_CROSS = [['SiO2', 'Na2O', -557.648]];
  const P_LOGIT_LIMIT = Math.log(0.24 / 0.76);

  const IMMIN_MIN = 0.20;

  const MV = {   // component: [min, max] mass fraction (Table 3-2)
    Al2O3: [0.03, 0.30], B2O3: [0.04, 0.22], Bi2O3: [0.0, 0.07],
    CaO: [0.0, 0.127], Cr2O3: [0.0, 0.0145], F: [0.0, 0.045],
    Fe2O3: [0.0, 0.1198], K2O: [0.0, 0.0584], Li2O: [0.0, 0.0512],
    MgO: [0.0, 0.0502], MnO: [0.0, 0.0204], Na2O: [0.041, 0.27],
    NiO: [0.0, 0.0297], P2O5: [0.0, 0.04], RE2O3: [0.0, 0.0111],
    SiO2: [0.2493, 0.53], SO3: [0.0, 0.028], TiO2: [0.0, 0.0294],
    V2O5: [0.0, 0.0508], UO3: [0.0, 0.063], ZnO: [0.0, 0.04],
    ZrO2: [0.0, 0.0924], Others: [0.0, 0.0377],
  };
  const NALK_RANGE = [0.1381, 0.2743];
  const NSIAL_RANGE = [0.4570, 0.7236];

  const UPRED_CI = { process: 1.645, pct: 1.645, sulfate: 1.96, k3: 1.645, phos: 1.645 };
  const RMSE_PRESS_PCT = 0.5328;
  const ETA_RMSE = { visc: 0.152, ec: 0.193 };

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------
  function nNali(g) {
    const gNa = g.Na2O || 0, gLi = g.Li2O || 0, gB = g.B2O3 || 0, gSi = g.SiO2 || 0;
    const num = gNa + 2.07 * gLi;
    const den = num + gB + gSi;
    return den > 0 ? num / den : 0;
  }
  function nalk(g) { return (g.Na2O || 0) + 0.66 * (g.K2O || 0) + 2.07 * (g.Li2O || 0); }
  function nsial(g) { return (g.SiO2 || 0) + 1.697 * (g.Al2O3 || 0); }

  function basisPct(g) {
    const gm = {};
    for (const k of PCT_MODELED) gm[k] = g[k] || 0;
    gm.Others = 1.0 - PCT_MODELED.reduce((s, k) => s + (g[k] || 0), 0);
    return gm;
  }
  function basisVft(g) {
    const terms = Object.keys(VFT.visc.B).filter(k => k !== 'Others');
    const gv = {};
    for (const k of terms) gv[k] = g[k] || 0;
    gv.Others = 1.0 - terms.reduce((s, k) => s + (g[k] || 0), 0);
    return gv;
  }
  function basisSo3(g) {
    const terms = Object.keys(SO3_LIN).filter(k => k !== 'Others');
    const gs = {};
    for (const k of terms) gs[k] = g[k] || 0;
    gs.Others = 1.0 - terms.reduce((s, k) => s + (g[k] || 0), 0) - (g.SO3 || 0);
    return gs;
  }
  function basisK3(g) {
    const terms = Object.keys(K3_LIN).filter(k => k !== 'Others');
    const gk = {};
    for (const k of terms) gk[k] = g[k] || 0;
    gk.Others = 1.0 - terms.reduce((s, k) => s + (g[k] || 0), 0) - (g.SO3 || 0) - (g.Cl || 0);
    return gk;
  }

  // ------------------------------------------------------------------
  // Upred machinery (covariance matrices injected via setCovariance).
  // Accepts the mission_data.json form {model: {terms:[], M: rows[][]}}
  // and flattens into row-major Float64Array with leading dimension n.
  // ------------------------------------------------------------------
  let COV = null;   // {model: {terms:[], M:Float64Array, n:int}}
  function setCovariance(covRaw) {
    if (!covRaw) { COV = null; return; }
    COV = {};
    for (const model of Object.keys(covRaw)) {
      const { terms, M } = covRaw[model];
      const n = terms.length;
      const flat = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        const row = M[i];
        for (let j = 0; j < n; j++) flat[i * n + j] = row[j] || 0;
      }
      COV[model] = { terms, M: flat, n };
    }
  }

  function covSd(model, terms, x) {
    if (!COV || !COV[model]) return 0;
    const { terms: allTerms, M, n } = COV[model];
    const idx = new Map(allTerms.map((t, i) => [t, i]));
    // var = Σ_k Σ_j x_k M_ik M_j x_j over mapped terms
    let varSum = 0;
    const mapped = [];
    for (let k = 0; k < terms.length; k++) {
      const i = idx.get(terms[k]);
      if (i != null) mapped.push([k, i]);
    }
    for (const [k, i] of mapped) {
      let rowSum = 0;
      for (const [j, jj] of mapped) rowSum += M[i * n + jj] * x[j];
      varSum += x[k] * rowSum;
    }
    return Math.sqrt(Math.max(varSum, 0));
  }

  function quadValue(gm, term) {
    if (term.indexOf('x') < 0) return gm[term] || 0;
    const parts = term.split('x', 1);
    // terms like "Al2O3xAl2O3" — but oxide names contain digits, so split
    // at the LAST x that yields two known keys
    const xi = term.lastIndexOf('x');
    const a = term.slice(0, xi), b = term.slice(xi + 1);
    return ((gm[a] || 0) * (gm[b] || 0));
  }

  function upredPct(g) {
    const gpct = basisPct(g);
    const terms = ['Al2O3', 'B2O3', 'CaO', 'Li2O', 'Na2O', 'SiO2', 'SnO2', 'V2O5', 'ZnO', 'ZrO2',
                   'Others', 'Al2O3xAl2O3', 'Al2O3xCaO'];
    const x = terms.map(t => quadValue(gpct, t));
    const sdModel = covSd('pct', terms, x);
    const sd = Math.sqrt(sdModel * sdModel + RMSE_PRESS_PCT * RMSE_PRESS_PCT);
    let nlv = 0;
    for (const k of Object.keys(PCT_LIN)) nlv += PCT_LIN[k] * (gpct[k] || 0);
    for (const [a, b, c] of PCT_QUAD) nlv += c * (gpct[a] || 0) * (gpct[b] || 0);
    const NL = Math.exp(nlv);
    return Math.exp(nlv + UPRED_CI.pct * sd) - NL;
  }

  function upredVft(model, g, T_C) {
    const spec = VFT[model];
    const gv = basisVft(g);
    const TmT0 = T_C + 273.15 - spec.T0;
    let B = 0;
    for (const k of Object.keys(spec.B)) B += spec.B[k] * (gv[k] || 0);
    const terms = ['A', ...Object.keys(spec.B), 'T0'];
    const x = [1.0, ...Object.keys(spec.B).map(k => (gv[k] || 0) / TmT0), B / (TmT0 * TmT0)];
    const covModel = (model === 'visc') ? 'visc' : 'ec';
    const rmse = ETA_RMSE[model] || 0;
    const sdLog = Math.sqrt(covSd(covModel, terms, x) ** 2 + rmse * rmse);
    const p = Math.pow(10, spec.A + B / TmT0);
    return UPRED_CI.process * sdLog * Math.LN10 * p;
  }

  function upredK3(g) {
    const gk3 = basisK3(g);
    const denom = 1.0 - (g.SO3 || 0) - (g.Cl || 0);
    const d = denom > 0 ? denom : 1.0;
    const x = {};
    for (const k of Object.keys(gk3)) x[k] = gk3[k] / d;
    const terms = ['S0/1', 'Al2O3', 'B2O3', 'CaO', 'Cr2O3', 'Fe2O3', 'Li2O', 'MgO', 'MnO', 'Na2O',
                   'P2O5', 'SiO2', 'SnO2', 'TiO2', 'V2O5', 'ZnO', 'ZrO2', 'Others',
                   'Fe2O3xFe2O3', 'Na2OxCr2O3', 'TiO2xNa2O', 'SiO2xMgO'];
    const xv = terms.map(t => (t === 'S0/1') ? 0 : quadValue(x, t));
    return UPRED_CI.k3 * covSd('k3', terms, xv);
  }

  function upredSo3(g) {
    const gso3 = g.SO3 || 0;
    const gs = basisSo3(g);
    const denom = 1.0 - gso3;
    const d = denom > 0 ? denom : 1.0;
    const x = {};
    for (const k of Object.keys(gs)) x[k] = gs[k] / d;
    const terms = ['Al2O3', 'B2O3', 'CaO', 'F', 'K2O', 'Li2O', 'Na2O', 'P2O5', 'SiO2', 'V2O5',
                   'ZrO2', 'Others', 'B2O3xCaO', 'Al2O3xNa2O', 'CaOxSiO2'];
    return UPRED_CI.sulfate * covSd('so3', terms, terms.map(t => quadValue(x, t)));
  }

  // ------------------------------------------------------------------
  // evaluate() — property evaluation on per-model bases.
  // Accepts either a plain object keyed by oxide name or a dense array
  // in FULL_OXIDES order (what glassOf() returns).
  // ------------------------------------------------------------------
  function evaluate(gIn) {
    const g = {};
    let total = 0;
    if (Array.isArray(gIn)) {
      for (let i = 0; i < FULL_OXIDES.length; i++) {
        const v = Number(gIn[i]);
        if (v) { g[FULL_OXIDES[i]] = v; total += v; }
      }
    } else {
      for (const k of Object.keys(gIn)) {
        const v = Number(gIn[k]);
        if (v) { g[k] = v; total += v; }
      }
    }
    if (total > 0 && (total < 0.999 || total > 1.001)) {
      for (const k of Object.keys(g)) g[k] /= total;
    }

    // PCT
    const gpct = basisPct(g);
    let nlv = 0;
    for (const k of Object.keys(PCT_LIN)) nlv += PCT_LIN[k] * (gpct[k] || 0);
    for (const [a, b, c] of PCT_QUAD) nlv += c * (gpct[a] || 0) * (gpct[b] || 0);
    const NL = Math.exp(nlv);

    // VFT viscosity / EC
    const gvft = basisVft(g);
    let Bv = 0;
    for (const k of Object.keys(VFT.visc.B)) Bv += VFT.visc.B[k] * (gvft[k] || 0);
    let Be = 0;
    for (const k of Object.keys(VFT.ec.B)) Be += VFT.ec.B[k] * (gvft[k] || 0);
    const eta = T => Math.pow(10, VFT.visc.A + Bv / (T + 273.15 - VFT.visc.T0));
    const ec = T => Math.pow(10, VFT.ec.A + Be / (T + 273.15 - VFT.ec.T0));
    const eta1150 = eta(1150), eta1100 = eta(1100);
    const ec1100 = ec(1100), ec1200 = ec(1200);

    // sulfate
    const gso3 = g.SO3 || 0;
    const gso3b = basisSo3(g);
    const xs = {};
    for (const k of Object.keys(SO3_LIN)) xs[k] = (gso3b[k] || 0) / Math.max(1 - gso3, 1e-9);
    let so3 = 0;
    for (const k of Object.keys(SO3_LIN)) so3 += SO3_LIN[k] * (xs[k] || 0);
    for (const [a, b, c] of SO3_CROSS) so3 += c * (xs[a] || 0) * (xs[b] || 0);

    // K-3
    const gk3 = basisK3(g);
    const denom = 1 - gso3 - (g.Cl || 0);
    const d = denom > 0 ? denom : 1e-9;
    const xk = {};
    for (const k of Object.keys(K3_LIN)) xk[k] = (gk3[k] || 0) / d;
    let lnk = 0;
    for (const k of Object.keys(K3_LIN)) lnk += K3_LIN[k] * (xk[k] || 0);
    for (const [a, b, c] of K3_SQ) lnk += c * (xk[a] || 0) * (xk[b] || 0);
    for (const [a, b, c] of K3_CROSS) lnk += c * (xk[a] || 0) * (xk[b] || 0);
    const k1208 = Math.exp(lnk);

    // phosphate logistic
    let logit = 0;
    for (const k of Object.keys(P_LIN)) logit += P_LIN[k] * (g[k] || 0);
    for (const [a, b, c] of P_CROSS) logit += c * (g[a] || 0) * (g[b] || 0);
    const phos = 1 / (1 + Math.exp(-logit));

    const NNaLi = nNali(g), NALK = nalk(g), NSiAl = nsial(g);

    // Upred margins (zero when covariance absent)
    const uPct = COV ? upredPct(g) : 0;
    const uVisc = COV ? upredVft('visc', g, 1150) : 0;
    const uK3 = COV ? upredK3(g) : 0;
    const uSo3 = COV ? upredSo3(g) : 0;

    const tol = 1e-7;
    const okLe = (v, lim) => v <= lim + tol;
    const okGe = (v, lim) => v >= lim - tol;

    const constraints = {
      PCT_NL_g_m2:   [NL, okLe(NL, PCT_LIMIT + uPct)],
      eta1150_Pa_s:  [eta1150, okGe(eta1150, ETA1150_RANGE[0] - uVisc) && okLe(eta1150, ETA1150_RANGE[1] + uVisc)],
      eta1100_Pa_s:  [eta1100, okLe(eta1100, ETA1100_MAX + uVisc)],
      ec1100_S_cm:   [ec1100, okGe(ec1100, Math.max(EC1100_MIN - 0.5 * uVisc / 10, 0))],
      ec1200_S_cm:   [ec1200, okLe(ec1200, EC1200_MAX)],
      wSO3_MT_wt:    [100 * gso3, okLe(100 * gso3, (so3 - SO3_MT_OFFSET + 100 * uSo3))],
      k1208_in:      [k1208, okLe(k1208, K3_LIMIT + uK3)],
      p_phosphate:   [phos, okLe(phos, 0.24)],
      N_NaLi:        [NNaLi, okGe(NNaLi, IMMIN_MIN)],
      NALK_bounds:   [NALK, okGe(NALK, NALK_RANGE[0]) && okLe(NALK, NALK_RANGE[1])],
      NSiAl_bounds:  [NSiAl, okGe(NSiAl, NSIAL_RANGE[0]) && okLe(NSiAl, NSIAL_RANGE[1])],
    };
    const allPass = Object.values(constraints).every(c => c[1]);

    return {
      g, NL, ave_ln_nl: Math.log(NL),
      eta1150, eta1100, ec1100, ec1200,
      wso3_3ts: so3, k1208, ln_k1208: Math.log(k1208),
      p_phos: phos, NNaLi, NALK, NSiAl,
      upred: { pct: uPct, eta1150: uVisc, k1208: uK3, wso3: uSo3 },
      constraints, all_pass: allPass,
    };
  }

  // ------------------------------------------------------------------
  // Contribution matrix: rows = [Waste] + GFCs, cols = FULL_OXIDES
  // (paper Table 3-4 convention: waste row = normalized oxide fractions;
  //  GFC rows = oxide split normalized to 1)
  // ------------------------------------------------------------------
  function buildRows(waste) {
    const s = Object.values(waste).reduce((a, v) => a + v, 0) || 1;
    const wRow = FULL_OXIDES.map(o => (waste[o] || 0) / s);
    const rows = [wRow];
    for (const gname of GFC_NAMES) {
      const gfc = GFCS[gname];
      const sg = Object.values(gfc).reduce((a, v) => a + v, 0);
      rows.push(FULL_OXIDES.map(o => (gfc[o] || 0) / sg));
    }
    return rows;  // (1+N) × OX
  }

  function glassOf(x, M) {
    const nOx = FULL_OXIDES.length;
    const g = new Array(nOx).fill(0);
    let tot = 0;
    for (let r = 0; r < M.length; r++) {
      const xr = x[r];
      if (!xr) continue;
      for (let j = 0; j < nOx; j++) { const v = M[r][j] * xr; g[j] += v; tot += v; }
    }
    if (tot > 0) for (let j = 0; j < nOx; j++) g[j] /= tot;
    return g;
  }

  // ------------------------------------------------------------------
  // formulate() — maximize waste loading via SQP multistart
  // ------------------------------------------------------------------
  function formulate(wasteIn, opts) {
    opts = opts || {};
    const waste = {};
    for (const k of Object.keys(wasteIn)) {
      const v = Number(wasteIn[k]);
      if (v) waste[k] = v;
    }
    const n = 1 + GFC_NAMES.length;
    const names = ['Waste', ...GFC_NAMES];
    const M = buildRows(waste);

    const wso3Waste = waste.SO3 || 0;
    const allowV2O5 = opts.allowV2O5 != null ? opts.allowV2O5 : wso3Waste > 0.005;
    const allowCr2O3 = opts.allowCr2O3 !== false;

    // ---- memoized property evaluation (perf) ---------------------------
    // Every constraint reads the SAME evAt(x) at a given x;
    // with 60 constraints × 2n finite differences the un-memoized path
    // costs ~1,300 evaluate() calls per SQP iteration.  Caching on the
    // point (11 floats, ~20-char key) cuts that to 2n+1 ≈ 23.
    const evCache = new Map();
    const evAt = (x) => {
      const key = x.map(v => v.toFixed(9)).join(',');
      let ev = evCache.get(key);
      if (!ev) {
        ev = evaluate(glassOf(x, M));   // the real evaluation (not memoized)
        if (evCache.size > 40000) evCache.clear();   // bounded
        evCache.set(key, ev);
      }
      return ev;
    };

    // objective + gradient: minimize -x[0]
    const f = x => -x[0];
    const gf = x => { const g = new Array(n).fill(0); g[0] = -1; return g; };

    // equality: Σx = 1
    const eqF = x => x.reduce((s, v) => s + v, 0) - 1;
    const eqJ = () => new Array(n).fill(1);

    // inequality constraints g_i(x) ≥ 0 (sign embedded, mirroring cfun)
    const UC = [
      ['PCT_NL_g_m2', PCT_LIMIT, -1],
      ['eta1150_lo', ETA1150_RANGE[0], +1],
      ['eta1150_hi', ETA1150_RANGE[1], -1],
      ['eta1100', ETA1100_MAX, -1],
      ['ec1100', EC1100_MIN, +1],
      ['ec1200', EC1200_MAX, -1],
      ['k1208', K3_LIMIT, -1],
      ['p_phosphate', 0.24, -1],
      ['N_NaLi', IMMIN_MIN, +1],
      ['NALK_lo', NALK_RANGE[0], +1], ['NALK_hi', NALK_RANGE[1], -1],
      ['NSiAl_lo', NSIAL_RANGE[0], +1], ['NSiAl_hi', NSIAL_RANGE[1], -1],
    ];
    const consF = [];
    const consJ = [];
    for (const [name, lim, sign] of UC) {
      consF.push(x => {
        const ev = evAt(x);
        const u = ev.upred || {};
        let v, limEff;
        switch (name) {
          case 'PCT_NL_g_m2':  v = ev.NL;    limEff = lim + (u.pct || 0); break;
          case 'eta1150_lo':   v = ev.eta1150; limEff = lim - (u.eta1150 || 0); break;
          case 'eta1150_hi':   v = ev.eta1150; limEff = lim + (u.eta1150 || 0); break;
          case 'eta1100':      v = ev.eta1100; limEff = lim + (u.eta1150 || 0); break;
          case 'ec1100':       v = ev.ec1100;  limEff = Math.max(lim - 0.5 * (u.eta1150 || 0) / 10, 0); break;
          case 'ec1200':       v = ev.ec1200;  limEff = lim; break;
          case 'k1208':        v = ev.k1208;   limEff = lim + (u.k1208 || 0); break;
          case 'p_phosphate':  v = ev.p_phos;  limEff = lim; break;
          case 'N_NaLi':       v = ev.NNaLi;   limEff = lim; break;
          case 'NALK_lo':      v = ev.NALK;     limEff = lim; break;
          case 'NALK_hi':      v = ev.NALK;     limEff = lim; break;
          case 'NSiAl_lo':     v = ev.NSiAl;    limEff = lim; break;
          case 'NSiAl_hi':     v = ev.NSiAl;    limEff = lim; break;
        }
        return sign * (v - limEff);
      });
      // numerical gradient (central differences) — models are smooth; the
      // full app relies on SLSQP's own finite differences the same way.
      // CAPTURE the constraint function at push time: closing over
      // `consF[consF.length - 1]` defers the lookup to call time, where it
      // would resolve to whichever constraint was pushed LAST.
      const fn = consF[consF.length - 1];
      consJ.push(x => numGrad(fn, x));
    }
    // sulfate constraint
    const so3Idx = FULL_OXIDES.indexOf('SO3');
    const so3F = x => {
      const ev = evAt(x);
      const u = ev.upred || {};
      const gso3Wt = 100 * glassOf(x, M)[so3Idx];
      return (ev.wso3_3ts - SO3_MT_OFFSET + 100 * (u.wso3 || 0)) - gso3Wt;
    };
    consF.push(so3F);
    consJ.push(x => numGrad(so3F, x));
    // MV bounds on modeled components
    for (const [o, [lo, hi]] of Object.entries(MV)) {
      const idx = FULL_OXIDES.indexOf(o);
      if (idx < 0) continue;
      const loF = x => glassOf(x, M)[idx] - lo;
      const hiF = x => hi - glassOf(x, M)[idx];
      consF.push(loF);
      consJ.push(x => numGrad(loF, x));
      consF.push(hiF);
      consJ.push(x => numGrad(hiF, x));
    }

    const bounds = new Array(n).fill([0, 1]);
    if (!allowV2O5) bounds[names.indexOf('V2O5')] = [0, 0];
    bounds[names.indexOf('Cr2O3')] = allowCr2O3 ? [0, CR2O3_MAX] : [0, 0];

    let best = null;
    for (const wtStart of [0.40, 0.20, 0.10, 0.05, 0.30]) {
      const x0 = new Array(n).fill((1 - wtStart) / (n - 1));
      x0[0] = wtStart;
      const res = SQP.solve(f, gf, x0, { fEq: [eqF], jEq: [eqJ], fIneq: consF, jIneq: consJ, bounds });
      const ev = evaluate(glassOf(res.x, M));
      const feas = res.success && ev.all_pass;
      if (best === null || (feas && ev.all_pass && res.x[0] > best.x[0]) ||
          (!best.feas && feas) || (!best.feas && !feas && res.x[0] > best.x[0])) {
        best = { feas, x: res.x.slice(), ev };
      }
      if (feas && Math.abs(res.x[0] - 0.40) < 1e-6) break;
    }

    const x = best.x;
    const glass = {};
    const gArr = glassOf(x, M);
    FULL_OXIDES.forEach((o, i) => { if (gArr[i] > 1e-12) glass[o] = gArr[i]; });

    // raw GFC demand: x_k / yield_k
    const gfcsUsed = {};
    for (let i = 1; i < n; i++) {
      const y = M[i].reduce((s, v) => s + v, 0);
      if (x[i] > 1e-9 && y > 1e-9) gfcsUsed[names[i]] = x[i] / y;
    }
    let totGlassInput = 0;
    for (let r = 0; r < M.length; r++) for (let j = 0; j < FULL_OXIDES.length; j++) totGlassInput += M[r][j] * x[r];

    return {
      success: best.feas,
      message: best.feas ? 'optimal' : 'no feasible formulation found',
      waste_loading: x[0],
      wl_physical: x[0] / Math.max(totGlassInput, 1e-9),
      glass_input_total: totGlassInput,
      x: Object.fromEntries(names.map((nm, i) => [nm, x[i]])),
      glass, gfc_raw_mass_fraction: gfcsUsed,
      evaluation: best.ev,
    };
  }

  function numGrad(fn, x) {
    const n = x.length;
    const g = new Array(n).fill(0);
    const h = 1e-6;
    for (let j = 0; j < n; j++) {
      const lo = x[j] - h, hi = x[j] + h;
      const xa = x.slice(); xa[j] = lo;
      const xb = x.slice(); xb[j] = hi;
      g[j] = (fn(xb) - fn(xa)) / (2 * h);
    }
    return g;
  }

  const api = {
    GFCS, GFC_NAMES, FULL_OXIDES,
    evaluate, formulate, buildRows, glassOf,
    setCovariance,
    PCT_LIMIT, K3_LIMIT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Glass = api;
})(typeof self !== 'undefined' ? self : globalThis);
