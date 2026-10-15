/**
 * engine.js — Campaign builder + mission roll-up for the sandbox.
 *
 * Scaled-down port of the full application's ewg/campaign_builder.py
 * (RPP-RPT-64878-01 §6.2): quadrant-ordered greedy layer walk with
 * per-campaign LP refinement (lp.js), then glass evaluation via glass.js.
 *
 * §6.2 rules reproduced here:
 *   - Quadrant order SE → NE → NW → SW; in-flight layers from prior
 *     quadrants finish first.
 *   - Within-SE tank-order rules (AP-101 → AP-102/AZ-101/AZ-102/AY-101,
 *     AZ-101 → AZ-102/AY-101, AN-101 → AN-106, AW-104 → AW-103/AW-105).
 *   - Layer-stack order within a tank (A-series above L-series).
 *   - A layer drawn partially in one campaign stays in-flight until empty.
 *   - ≤ 5 tanks per campaign (paper Figures 6-2..6-7).
 *   - Campaign volume band 450–550 kgal (Table A-30, mass-balance verified).
 *   - Per-layer per-campaign cap = band_max/5 so 5 tanks can reach the max.
 *   - WAC scaling §6.2: 60% across the board, UFis/UTot and NOx at 90%,
 *     with absolute user overrides.
 */
(function (root) {
  'use strict';
  // Cross-module resolution: Node tests require the sibling LP module;
  // in the browser both share the global scope (root.LP).
  const LP = (typeof module !== 'undefined' && module.exports)
    ? require('./lp.js')
    : root.LP;

  const KL_PER_KGAL = 3.785412;
  const CAMPAIGN_MIN_KGAL = 450.0;
  const CAMPAIGN_MAX_KGAL = 550.0;
  const LAYER_MIN_TRANSFER_KL = 38.0;
  const MAX_TANKS_PER_CAMPAIGN = 5;
  const RHO_SLURRY_FALLBACK = 1300.0;
  const CANISTER_KG = 3097.0;
  const GLASS_T_PER_DAY = 5.0;
  const MELTER_AVAILABILITY = 0.65;

  const QUADRANT_ORDER = ['SE', 'NE', 'NW', 'SW'];
  const FARM_PRIORITY = ['AN', 'AP', 'AW', 'AZ', 'AY', 'A', 'B', 'BX', 'BY', 'C',
                        'S', 'SX', 'SY'];
  const TANK_ORDER_RULES = [
    ['AP-101', ['AP-102', 'AZ-101', 'AZ-102', 'AY-101']],
    ['AZ-101', ['AZ-102', 'AY-101']],
    ['AN-101', ['AN-106']],
    ['AW-104', ['AW-103', 'AW-105']],
  ];

  // WAC limit directions (mirrors campaign_builder.WAC_DIRECTION)
  const WAC_DIRECTION = {
    UD: '<=', UDAlt: '<=', Conc_Cs137eq: '<=',
    HGR140: '<=', HGR195: '<=',
    WRatio_Pu_Metals: '<=', WRatio_UFis_UTot: '<=',
    Conc_NOx: '<=', Conc_TOC: '<=', Conc_PCB: '<=',
    GTar_NaK: '<=', GTar_AlFeZr: '<=', GTar_F: '<=',
    GTar_S: '<=', GTar_Zr: '<=', GTar_FeCrNi: '<=',
    GTar_P: '<=', GTar_Fe: '<=', GTar_Cr: '<=',
    GTar_Cd: '<=', GTar_Mn: '<=', GTar_Ca: '<=',
    GTar_Th: '<=', GTar_Al: '<=', GTar_Cl: '<=',
    GTar_U: '<=', GTar_Bi: '<=', GTar_Na: '<=',
    GTar_CrSol: '<=', GTar_SSol: '<=', GTar_NaKSol: '<=',
    BDens: '<=',
    SolidsLoading: 'range',
    pH: '>=',
    MRatio_Cl_OH: '<=',
  };

  const WAC_LABELS = {
    UD: 'Unit Dose (Sv/L)', UDAlt: 'Unit Dose Alternate (Sv/L)',
    Conc_Cs137eq: 'Cs-137 eq (Ci/L)', HGR140: 'UHGR @140°F',
    HGR195: 'UHGR @195°F', WRatio_Pu_Metals: 'Pu/Metals (g/kg)',
    WRatio_UFis_UTot: 'UFis/UTot (g/kg)', Conc_NOx: 'NO₂⁻+NO₃⁻ (mol/L)',
    Conc_TOC: 'TOC (mass frac)', Conc_PCB: 'PCB (mg/kg)',
    BDens: 'Bulk Density (g/mL)', SolidsLoading: 'Solids Loading (wt%)',
    pH: 'pH', MRatio_Cl_OH: 'Cl⁻/OH⁻ (mol ratio)',
    GTar_NaK: 'NaK (µg/g)', GTar_AlFeZr: 'Al+Fe+Zr (µg/g)',
    GTar_F: 'F (µg/g)', GTar_S: 'S (µg/g)', GTar_Zr: 'Zr (µg/g)',
    GTar_FeCrNi: 'Fe+Cr+Ni (µg/g)', GTar_P: 'P (µg/g)', GTar_Fe: 'Fe (µg/g)',
    GTar_Cr: 'Cr (µg/g)', GTar_Cd: 'Cd (µg/g)', GTar_Mn: 'Mn (µg/g)',
    GTar_Ca: 'Ca (µg/g)', GTar_Th: 'Th (µg/g)', GTar_Al: 'Al (µg/g)',
    GTar_Cl: 'Cl (µg/g)', GTar_U: 'U (µg/g)', GTar_Bi: 'Bi (µg/g)',
    GTar_Na: 'Na (µg/g)', GTar_CrSol: 'Cr/Sol (ratio)', GTar_SSol: 'S/Sol (ratio)',
    GTar_NaKSol: 'NaK/Sol (ratio)',
  };

  // -------- helpers ---------------------------------------------------
  function tankOf(layerId) { return layerId.split('_')[0]; }
  function farmOf(tank) { return tank.split('-')[0]; }

  function layerIndex(id) {
    const i = id.indexOf('_');
    if (i < 0) return 0;
    const suffix = id.slice(i + 1);
    if (suffix[0] === 'A') {
      const v = parseInt(suffix.slice(1), 10);
      return isNaN(v) ? 0 : v;
    }
    if (suffix[0] === 'L') {
      const v = parseInt(suffix.slice(1), 10);
      return isNaN(v) ? 100 : v + 100;
    }
    return 50;
  }

  function slurryKL(layer) {
    const v = layer.stream && layer.stream.slurry_kL;
    return (v != null && v > 0) ? v : (layer.total_kg || 0) / RHO_SLURRY_FALLBACK;
  }

  function layerCrit(layer, key) {
    const v = layer.wap[key];
    return v != null ? v : null;
  }

  // -------- WAC limits ----------------------------------------------
  function wacLimitMap(wacRows) {
    const out = {};
    for (const r of wacRows) {
      if (r.wac_key === 'LDens') continue;      // scenario tag, not a limit
      const v = Number(r.limit);
      if (isFinite(v)) out[r.wac_key] = v;
    }
    return out;
  }

  function paperScaledLimits(wacRows, overrides, baseScale) {
    baseScale = baseScale == null ? 0.60 : baseScale;
    const base = wacLimitMap(wacRows);
    const perKey = { WRatio_UFis_UTot: 0.90, Conc_NOx: 0.90 };
    const out = {};
    for (const k of Object.keys(base)) {
      const s = (perKey[k] != null) ? perKey[k] : baseScale;
      out[k] = base[k] * s;
    }
    if (overrides) {
      for (const k of Object.keys(overrides)) {
        if (k in out) out[k] = Number(overrides[k]);
      }
    }
    return out;
  }

  /**
   * Linearized WAC rows for the campaign LP (volume-weighted blend basis).
   * A row (v_l − lim)·x_l ≤ 0 enforces Σ v_l x_l ≤ lim Σ x_l.
   * Structurally unsatisfiable rows (limit below every layer's value for a
   * '≤' row — e.g. the 60%-scaled BDens/pH/SolidsLoading rows, which the
   * full app's LP silently relaxes away) are dropped and reported, never
   * silently discarded.
   * @returns {{rows: number[][], dropped: string[], count:number}}
   */
  function wacRowsFor(layers, limits) {
    const rows = [];
    const dropped = [];
    let count = 0;
    for (const key of Object.keys(limits)) {
      const lim = limits[key];
      if (!isFinite(lim)) continue;
      const dir = WAC_DIRECTION[key] || '<=';
      const vals = layers.map(l => layerCrit(l, key));
      const have = vals.filter(v => v != null);
      if (!have.length) continue;

      if (dir === '<=') {
        if (Math.min(...have) > lim) { dropped.push(key); continue; }
        rows.push(vals.map(v => (v == null ? 0 : v - lim)));
        count++;
      } else if (dir === '>=') {
        if (Math.max(...have) < lim) { dropped.push(key); continue; }
        rows.push(vals.map(v => (v == null ? 0 : lim - v)));
        count++;
      } else if (dir === 'range') {
        // Solids Loading: 10..22 wt% band (limits in wt% here)
        const lo = 10.0, hi = lim > 0.5 ? lim : 22.0;
        if (Math.min(...have) > hi || Math.max(...have) < lo) {
          dropped.push(key); continue;
        }
        rows.push(vals.map(v => (v == null ? 0 : v - hi)));
        rows.push(vals.map(v => (v == null ? 0 : lo - v)));
        count += 2;
      }
    }
    return { rows, dropped, count };
  }

  function blendValue(layers, vols, key) {
    let num = 0, den = 0;
    for (let i = 0; i < layers.length; i++) {
      const v = layerCrit(layers[i], key);
      if (v == null) continue;
      num += v * vols[i];
      den += vols[i];
    }
    return den > 0 ? num / den : null;
  }

  // -------- eligibility & builder -------------------------------------
  function eligibleLayers(pool, tankDone, layerDone, rules) {
    const out = [];
    for (const l of pool) {
      if (layerDone[l]) continue;
      const tank = tankOf(l);
      let blocked = false;
      for (const [pred, succs] of rules) {
        if (succs.indexOf(tank) >= 0 && !tankDone[pred]) { blocked = true; break; }
      }
      if (blocked) continue;
      // shallowest not-yet-done layer of this tank in the pool
      let shallowest = null;
      for (const o of pool) {
        if (tankOf(o) !== tank || layerDone[o]) continue;
        if (shallowest === null || layerIndex(o) < layerIndex(shallowest)) shallowest = o;
      }
      if (shallowest !== l) continue;
      out.push(l);
    }
    return out;
  }

  /**
   * Build the mission for a scenario (§6.2, scaled down).
   * @param {object} scen  scenario object with `layers` (from mission_data.json)
   * @param {object} opts  { bandKgal, wacOverrides, wacScale, includeHeels,
   *                         maxCampaigns, minTransferKL }
   */
  function buildMission(scen, opts) {
    opts = opts || {};
    const bandKgal = opts.bandKgal || [CAMPAIGN_MIN_KGAL, CAMPAIGN_MAX_KGAL];
    const Vmin = bandKgal[0] * KL_PER_KGAL;
    const Vmax = bandKgal[1] * KL_PER_KGAL;
    const minTransfer = opts.minTransferKL != null ? opts.minTransferKL : LAYER_MIN_TRANSFER_KL;
    const maxCampaigns = opts.maxCampaigns || 200;
    const includeHeels = opts.includeHeels !== false;
    const enforceQuadrants = opts.enforceQuadrants !== false;

    const wacRows = scen.__wacRows || scen.wac_rows || [];
    const layersById = scen.layers;
    const poolAll = Object.keys(layersById)
      .filter(id => includeHeels || layersById[id].series !== 'H');

    const limits = paperScaledLimits(wacRows, opts.wacOverrides, opts.wacScale);

    const remaining = {};
    for (const id of poolAll) remaining[id] = slurryKL(layersById[id]);

    const tanks = {};
    for (const id of poolAll) {
      const t = tankOf(id);
      (tanks[t] = tanks[t] || []).push(id);
    }
    for (const t of Object.keys(tanks)) tanks[t].sort((a, b) => layerIndex(a) - layerIndex(b));

    const tankDone = {};
    for (const t of Object.keys(tanks)) tankDone[t] = false;

    const campaigns = [];
    let inFlight = {};
    let activeQuad = 'SE';
    let nC = 0;
    const droppedAll = new Set();

    while (nC < maxCampaigns) {
      nC++;
      const pool = enforceQuadrants
        ? poolAll.filter(id => layersById[id].quad === activeQuad)
        : poolAll.slice();
      for (const l of Object.values(inFlight)) {
        if (pool.indexOf(l) < 0) pool.push(l);
      }
      const layerDone = {};
      for (const id of poolAll) layerDone[id] = remaining[id] <= 1e-3;

      const stillActive = [];
      for (const l of Object.values(inFlight)) {
        if (remaining[l] > 1e-3) stillActive.push(l);
      }
      const eligible = eligibleLayers(pool, tankDone, layerDone, TANK_ORDER_RULES);
      let hasQuadSupply = pool.some(id => remaining[id] > 1e-3);
      if (!stillActive.length && !eligible.length) hasQuadSupply = false;

      if (!stillActive.length && !hasQuadSupply) {
        const qi = QUADRANT_ORDER.indexOf(activeQuad);
        if (qi + 1 < QUADRANT_ORDER.length) {
          activeQuad = QUADRANT_ORDER[qi + 1];
          inFlight = {};
          nC--;
          continue;
        }
        break;
      }

      // candidate set: in-flight mandatory + new tanks in farm priority
      const activeSet = stillActive.slice();
      const activeTanks = new Set(activeSet.map(tankOf));
      const eligibleNew = eligible
        .filter(l => !activeTanks.has(tankOf(l)))
        .sort((a, b) => {
          const fa = FARM_PRIORITY.indexOf(farmOf(tankOf(a)));
          const fb = FARM_PRIORITY.indexOf(farmOf(tankOf(b)));
          return (fa - fb) || (remaining[b] - remaining[a]);
        });
      for (const l of eligibleNew) {
        if (activeTanks.size >= MAX_TANKS_PER_CAMPAIGN) break;
        activeSet.push(l);
        activeTanks.add(tankOf(l));
      }
      if (!activeSet.length) break;
      activeSet.sort((a, b) => {
        const fa = FARM_PRIORITY.indexOf(farmOf(tankOf(a)));
        const fb = FARM_PRIORITY.indexOf(farmOf(tankOf(b)));
        return (fa - fb) || (remaining[b] - remaining[a]);
      });

      const cand = activeSet.filter(id => remaining[id] > 1e-3);
      if (!cand.length) { inFlight = {}; nC--; continue; }

      // LP setup
      const cap = Vmax / MAX_TANKS_PER_CAMPAIGN;
      const avail = cand.map(id => Math.min(remaining[id], cap));
      const kgPerKl = cand.map(id =>
        (layersById[id].total_kg || 0) / Math.max(slurryKL(layersById[id]), 1e-9));
      const { rows, dropped } = wacRowsFor(cand.map(id => layersById[id]), limits);
      for (const k of dropped) droppedAll.add(k);

      const A = [cand.map(() => 1), cand.map(() => -1)];
      const b = [Vmax, -Vmin];
      for (const row of rows) { A.push(row); b.push(0); }

      let sol = LP.solve(kgPerKl.map(v => -v), A, b, { hi: avail });
      let mode = 'lp';
      let take;
      if (sol.status !== 'optimal') {
        // ladder: volume-only LP, then proportional fill (matches full app)
        sol = LP.solve(kgPerKl.map(v => -v), A.slice(0, 2), b.slice(0, 2), { hi: avail });
        if (sol.status !== 'optimal') {
          const tot = avail.reduce((s, v) => s + v, 0);
          const scale = Math.min(1, Vmax / Math.max(tot, 1e-9));
          take = avail.map(v => v * scale);
          mode = 'proportional-fallback';
          sol = null;
        } else {
          mode = 'volume-only-lp';
        }
      }
      if (sol) take = sol.x;

      // §6.2 min-transfer: takes below the 38 kL minimum are zeroed
      {
        const floor = Math.min(minTransfer, 0.05 * Vmax);
        const pruned = take.map(v => (v < floor ? 0 : v));
        if (pruned.reduce((s, v) => s + v, 0) > 1e-3) take = pruned;
      }

      const totalVol = take.reduce((s, v) => s + v, 0);
      if (totalVol <= 1e-3) { inFlight = {}; nC--; continue; }

      // apply takes, build recipe
      const recipe = [];
      let wasteKg = 0;
      for (let i = 0; i < cand.length; i++) {
        const v = take[i];
        if (v <= 1e-3) continue;
        remaining[cand[i]] = Math.max(0, remaining[cand[i]] - v);
        const totKl = slurryKL(layersById[cand[i]]);
        const frac = Math.min(1.0, v / totKl);
        recipe.push({ layer: cand[i], kL: v, fraction: frac });
        wasteKg += frac * (layersById[cand[i]].total_kg || 0);
      }
      if (!recipe.length) { inFlight = {}; nC--; continue; }

      // WAC blend values for display
      const candLayers = cand.map(id => layersById[id]);
      const wacValues = {};
      for (const key of Object.keys(limits)) {
        const val = blendValue(candLayers, take, key);
        if (val != null) wacValues[key] = val;
      }

      for (const t of Object.keys(tanks)) {
        if (tanks[t].every(id => remaining[id] <= 1e-3)) tankDone[t] = true;
      }
      inFlight = {};
      for (const r of recipe) {
        if (remaining[r.layer] > 1e-3) inFlight[tankOf(r.layer)] = r.layer;
      }

      campaigns.push({
        n: campaigns.length + 1,
        quad: activeQuad,
        mode,
        volume_kL: totalVol,
        waste_kg: wasteKg,
        recipe,
        wac: wacValues,
      });
    }

    return { campaigns, limits, dropped: Array.from(droppedAll) };
  }

  // -------- mission roll-up ------------------------------------------
  function campaignWasteVector(scenLayers, recipe) {
    // blend oxide fractions: fraction-weighted mix of layer vectors
    const tot = {};
    for (const r of recipe) {
      const L = scenLayers[r.layer];
      if (!L) continue;
      for (const ox of Object.keys(L.oxides)) {
        tot[ox] = (tot[ox] || 0) + r.fraction * L.oxides[ox];
      }
    }
    return tot;
  }

  function missionTotals(campaigns, evals, opts) {
    opts = opts || {};
    const canisterKg = opts.canisterKg || CANISTER_KG;
    const tPerDay = opts.glassTPerDay || GLASS_T_PER_DAY;
    const avail = opts.availability || MELTER_AVAILABILITY;
    let glassKg = 0, wasteKg = 0, volKL = 0, wlSum = 0, wlCount = 0;
    const perCampaign = [];
    for (let i = 0; i < campaigns.length; i++) {
      const c = campaigns[i];
      const e = evals && evals[i];
      // waste_loading may live on the eval object OR be merged directly
      // onto the campaign record (the UI/test path) — read both.
      const wl = (e && e.waste_loading != null) ? e.waste_loading : c.waste_loading;
      const glass = wl != null && wl > 0 ? c.waste_kg / wl : null;
      if (glass != null) glassKg += glass;
      if (wl != null && wl > 0) { wlSum += wl; wlCount++; }
      wasteKg += c.waste_kg;
      volKL += c.volume_kL;
      perCampaign.push({
        n: c.n, quad: c.quad, mode: c.mode,
        volume_kL: c.volume_kL, waste_kg: c.waste_kg,
        waste_loading: wl != null ? wl : null,
        glass_kg: glass,
        canisters: glass != null ? glass / canisterKg : null,
      });
    }
    const canisters = glassKg / canisterKg;
    const years = (glassKg / 1000) / (tPerDay * avail) / 365.25;
    return {
      campaigns: perCampaign,
      total_glass_kg: glassKg,
      total_waste_kg: wasteKg,
      total_volume_kL: volKL,
      canisters,
      duration_years: years,
      avg_waste_loading: wlCount ? wlSum / wlCount : 0,
    };
  }

  const api = {
    KL_PER_KGAL, CAMPAIGN_MIN_KGAL, CAMPAIGN_MAX_KGAL,
    LAYER_MIN_TRANSFER_KL, MAX_TANKS_PER_CAMPAIGN, CANISTER_KG,
    GLASS_T_PER_DAY, MELTER_AVAILABILITY,
    QUADRANT_ORDER, TANK_ORDER_RULES, WAC_DIRECTION, WAC_LABELS,
    tankOf, farmOf, layerIndex, slurryKL, layerCrit,
    wacLimitMap, paperScaledLimits, wacRowsFor, blendValue,
    eligibleLayers, buildMission, campaignWasteVector, missionTotals,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== 'undefined' ? self : globalThis);
