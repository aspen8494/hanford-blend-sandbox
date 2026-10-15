/**
 * app.js — UI controller for the HLW Blend Sandbox.
 *
 * Loads web/data/mission_data.json, drives the engine (build → glass
 * evaluate → roll-up), renders metrics, two canvas charts, and the
 * campaign table.  Everything is client-side; the only fetch is the
 * local dataset.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt = {
    int: v => v == null ? '–' : Math.round(v).toLocaleString(),
    fixed: (v, d) => v == null ? '–' : v.toFixed(d),
    kt: v => v == null ? '–' : (v / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }),
    Mt: v => v == null ? '–' : (v / 1e6).toFixed(2),
  };

  const state = {
    data: null,
    scen: null,
    mission: null,
    running: false,
  };

  // -------------------------------------------------------------- load
  async function loadData() {
    const res = await fetch('data/mission_data.json');
    state.data = await res.json();
    Glass.setCovariance(state.data.covariance);
    const sel = $('sel-scenario');
    for (const [tag, s] of Object.entries(state.data.scenarios)) {
      const opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = `${tag}  (${s.n_appd} App-D + ${s.n_heel} heels)`;
      sel.appendChild(opt);
    }
    sel.value = '135.120.150';
    buildWacOverrides();
    updateScenarioNote();
  }

  function currentScenario() {
    const tag = $('sel-scenario').value;
    const scen = JSON.parse(JSON.stringify(state.data.scenarios[tag]));
    scen.__wacRows = state.data.wac;
    return scen;
  }

  function updateScenarioNote() {
    const tag = $('sel-scenario').value;
    const s = state.data.scenarios[tag];
    $('scenario-note').textContent =
      `Supernatant ρ ${(parseInt(tag.split('.')[0], 10) / 100).toFixed(2)} g/mL · ` +
      `target liquid ρ ${(parseInt(tag.split('.')[1], 10) / 100).toFixed(2)} · ` +
      `solids ${parseInt(tag.split('.')[2], 10) / 10} wt%`;
  }

  function buildWacOverrides() {
    const host = $('wac-overrides');
    host.innerHTML = '';
    const keyCriteria = [
      ['GTar_NaK', 'NaK conc. (µg/g)'],
      ['GTar_AlFeZr', 'Al+Fe+Zr (µg/g)'],
      ['Conc_NOx', 'NOₓ (mol/L)'],
      ['BDens', 'Bulk density (g/mL)'],
      ['WRatio_UFis_UTot', 'UFis/UTot'],
    ];
    for (const [key, label] of keyCriteria) {
      const row = document.createElement('label');
      row.className = 'wac-ov-row';
      row.innerHTML =
        `<span>${label}</span>` +
        `<input type="number" step="any" data-wac="${key}" placeholder="scaled">`;
      host.appendChild(row);
    }
  }

  function collectOverrides() {
    const out = {};
    document.querySelectorAll('#wac-overrides input[data-wac]').forEach(inp => {
      const v = parseFloat(inp.value);
      if (isFinite(v)) out[inp.dataset.wac] = v;
    });
    return out;
  }

  // -------------------------------------------------------------- run
  async function run() {
    if (state.running || !state.data) return;
    state.running = true;
    $('btn-run').textContent = 'Working…';
    $('btn-run').disabled = true;

    // let the button paint before the synchronous build
    await new Promise(r => setTimeout(r, 30));

    const t0 = performance.now();
    const scen = currentScenario();
    const opts = {
      bandKgal: [parseFloat($('rng-vmin').value), parseFloat($('rng-vmax').value)],
      wacScale: parseFloat($('rng-wac').value) / 100,
      wacOverrides: collectOverrides(),
      includeHeels: $('chk-heels').checked,
      enforceQuadrants: $('chk-quadrants').checked,
      maxCampaigns: 200,
    };
    const mission = Engine.buildMission(scen, opts);
    const t1 = performance.now();

    // glass evaluation per campaign (the expensive part) — chunked so the
    // progress renders
    const evals = [];
    let done = 0;
    const total = mission.campaigns.length;
    for (const c of mission.campaigns) {
      const wasteVec = Engine.campaignWasteVector(scen.layers, c.recipe);
      const r = Glass.formulate(wasteVec);
      evals.push({
        waste_loading: r.waste_loading,
        glass_kg: r.waste_loading > 0 ? c.waste_kg / r.waste_loading : 0,
        all_pass: r.success && r.evaluation.all_pass,
        evaluation: r.evaluation,
        gfc: r.gfc_raw_mass_fraction,
        glass: r.glass,
      });
      done++;
      if (done % 2 === 0) {
        $('btn-run').textContent = `Glass ${done}/${total}…`;
        await new Promise(r2 => setTimeout(r2, 0));
      }
    }
    const t2 = performance.now();

    const totals = Engine.missionTotals(mission.campaigns, evals, {
      glassTPerDay: parseFloat($('rng-rate').value),
      availability: parseFloat($('rng-avail').value) / 100,
    });

    state.mission = { scen, mission, evals, totals };
    renderAll();
    console.log(`build ${Math.round(t1 - t0)} ms, glass ${Math.round(t2 - t1)} ms`);

    state.running = false;
    $('btn-run').textContent = 'Build mission';
    $('btn-run').disabled = false;
  }

  // -------------------------------------------------------------- render
  function renderAll() {
    const { mission, evals, totals, scen } = state.mission;
    $('metrics').hidden = false;

    $('m-campaigns').textContent = fmt.int(mission.campaigns.length);
    $('m-waste').textContent = fmt.Mt(totals.total_waste_kg) + ' Mt';
    $('m-glass').textContent = fmt.Mt(totals.total_glass_kg) + ' Mt';
    $('m-canisters').textContent = fmt.int(totals.canisters);
    $('m-wl').textContent = fmt.fixed(totals.avg_waste_loading, 3);
    $('m-duration').textContent = fmt.fixed(totals.duration_years, 1) + ' yr';

    // dropped-criteria note (transparent about structurally unsatisfiable rows)
    const note = $('drop-note');
    if (mission.dropped && mission.dropped.length) {
      const labels = mission.dropped.map(k => Engine.WAC_LABELS[k] || k);
      note.hidden = false;
      note.innerHTML =
        `<strong>Not binding at this scale:</strong> the scaled limits for ` +
        `${labels.length} criteria sit outside every available layer's range, ` +
        `so they cannot constrain any blend here: <span class="mono">` +
        labels.join(', ') + `</span>. The full application drops these rows ` +
        `silently during its LP relaxation; the sandbox reports them.`;
    } else {
      note.hidden = true;
    }

    renderGlassChart();
    renderWLChart();
    renderTable();
  }

  // -------------------------------------------------------------- charts
  // SVG-based charts (DOM): crisp at any zoom, print-friendly, and
  // inspectable in headless engines (canvas pixels are not).

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  function chartFrame(host, H) {
    host.innerHTML = '';
    const W = 760;
    const pad = { l: 56, r: 12, t: 16, b: 26 };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%',
                               style: 'height:auto', role: 'img' });
    host.appendChild(svg);
    return { svg, W, H, pad, cw: W - pad.l - pad.r, ch: H - pad.t - pad.b };
  }

  function axisLabels(f, W, H, pad, ch, ticks, fmt) {
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + ch - (ch * i) / 4;
      f.appendChild(svgEl('line', {
        x1: pad.l, y1: y, x2: W - pad.r, y2: y,
        stroke: '#8ea0bd', 'stroke-opacity': 0.25, 'stroke-width': 1 }));
      const t = svgEl('text', {
        x: pad.l - 6, y: y + 3, 'text-anchor': 'end',
        fill: '#8ea0bd', 'font-size': 10 });
      t.textContent = fmt(ticks(i));
      f.appendChild(t);
    }
  }

  function renderGlassChart() {
    const { mission, evals } = state.mission;
    const host = $('chart-glass');
    const H = 240;
    const f = chartFrame(host, H);
    const { svg, W, pad, cw, ch } = f;
    const vals = mission.campaigns.map((c, i) => evals[i].glass_kg / 1000);   // tonnes
    const maxV = Math.max(...vals, 1);
    const n = vals.length;
    const bw = Math.max(1.5, cw / n - 1.5);

    axisLabels(svg, W, H, pad, ch, i => (maxV * i) / 4,
               v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0));

    const qcolors = { SE: '#3b82f6', NE: '#10b981', NW: '#f59e0b', SW: '#ef4444', other: '#94a3b8' };
    vals.forEach((v, i) => {
      const h = (v / maxV) * ch;
      const x = pad.l + (i * cw) / n + 0.75;
      let col = qcolors[mission.campaigns[i].quad] || qcolors.other;
      if (!evals[i].all_pass) col = '#64748b';
      svg.appendChild(svgEl('rect', {
        x: x.toFixed(1), y: (pad.t + ch - h).toFixed(1),
        width: bw.toFixed(1), height: h.toFixed(1), fill: col }));
    });
    const t = svgEl('text', { x: W / 2, y: H - 6, 'text-anchor': 'middle',
                              fill: '#8ea0bd', 'font-size': 10 });
    t.textContent = 'campaign';
    svg.appendChild(t);
    // legend
    let lx = pad.l;
    for (const [q, col] of Object.entries(qcolors).slice(0, 4)) {
      svg.appendChild(svgEl('rect', { x: lx, y: 3, width: 8, height: 8, fill: col }));
      const lt = svgEl('text', { x: lx + 11, y: 11, fill: '#8ea0bd', 'font-size': 10 });
      lt.textContent = q;
      svg.appendChild(lt);
      lx += 44;
    }
  }

  function renderWLChart() {
    const { mission, evals } = state.mission;
    const host = $('chart-wl');
    const H = 200;
    const f = chartFrame(host, H);
    const { svg, W, pad, cw, ch } = f;
    const n = mission.campaigns.length;

    const KL = 3.785412;
    const vmin = parseFloat($('rng-vmin').value) * KL;
    const vmax = parseFloat($('rng-vmax').value) * KL;
    const vMax = Math.max(...mission.campaigns.map(c => c.volume_kL), vmax) * 1.05;

    axisLabels(svg, W, H, pad, ch, i => (vMax * i) / 4, v => v.toFixed(0));

    // volume band shading
    const y0 = pad.t + ch - (vmax / vMax) * ch;
    const y1 = pad.t + ch - (vmin / vMax) * ch;
    svg.appendChild(svgEl('rect', {
      x: pad.l, y: y0, width: cw, height: Math.max(0, y1 - y0),
      fill: 'rgba(59,130,246,0.12)' }));

    // volume bars
    mission.campaigns.forEach((c, i) => {
      const h = (c.volume_kL / vMax) * ch;
      svg.appendChild(svgEl('rect', {
        x: (pad.l + (i * cw) / n + 0.75).toFixed(1),
        y: (pad.t + ch - h).toFixed(1),
        width: Math.max(1.5, cw / n - 1.5).toFixed(1), height: h.toFixed(1),
        fill: '#cbd5e1' }));
    });

    // WL polyline
    const wlMax = Math.max(...evals.map(e => e.waste_loading), 0.1) * 1.15;
    const pts = evals.map((e, i) => {
      const x = pad.l + ((i + 0.5) * cw) / n;
      const y = pad.t + ch - (e.waste_loading / wlMax) * ch;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    svg.appendChild(svgEl('polyline', {
      points: pts, fill: 'none', stroke: '#f97316', 'stroke-width': 1.6 }));
    evals.forEach((e, i) => {
      const x = pad.l + ((i + 0.5) * cw) / n;
      const y = pad.t + ch - (e.waste_loading / wlMax) * ch;
      svg.appendChild(svgEl('circle', { cx: x.toFixed(1), cy: y.toFixed(1),
                                       r: 1.6, fill: '#f97316' }));
    });

    const t = svgEl('text', { x: W / 2, y: H - 6, 'text-anchor': 'middle',
                              fill: '#8ea0bd', 'font-size': 10 });
    t.textContent = 'campaign (bars: volume kL · line: waste loading · band: target)';
    svg.appendChild(t);
  }

  function renderTable() {
    const { mission, evals } = state.mission;
    const tbody = document.querySelector('#tbl-campaigns tbody');
    tbody.innerHTML = '';
    const KL = 3.785412;
    mission.campaigns.forEach((c, i) => {
      const e = evals[i];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${c.n}</td>
        <td>${c.quad}</td>
        <td class="layers">${c.recipe.map(r => r.layer).join(', ')}</td>
        <td class="num">${fmt.int(c.volume_kL)}</td>
        <td class="num">${fmt.fixed(c.volume_kL / KL, 0)}</td>
        <td class="num">${fmt.int(c.waste_kg / 1000)}</td>
        <td class="num">${fmt.fixed(e.waste_loading, 3)}</td>
        <td class="num">${fmt.int(e.glass_kg / 1000)}</td>
        <td class="num">${fmt.fixed(e.glass_kg / 3097, 1)}</td>
        <td>${e.all_pass ? '<span class="ok">pass</span>' : '<span class="bad">fail</span>'}</td>`;
      tr.addEventListener('click', () => showDetail(c, e, i));
      tbody.appendChild(tr);
    });
  }

  function showDetail(c, e, i) {
    const host = $('campaign-detail');
    $('detail-title').textContent = `— campaign ${c.n} (${c.quad})`;
    const g = e.glass || {};
    const topOx = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const gfc = Object.entries(e.gfc || {}).sort((a, b) => b[1] - a[1]);
    const fails = Object.entries(e.evaluation.constraints).filter(([k, v]) => !v[1]);
    host.querySelector('#detail-body').innerHTML = `
      <div class="detail-grid">
        <div>
          <h3>Recipe</h3>
          <table class="mini">
            ${c.recipe.map(r => `<tr><td>${r.layer}</td>
              <td class="num">${(r.fraction * 100).toFixed(1)}%</td>
              <td class="num">${fmt.int(r.kL)} kL</td></tr>`).join('')}
          </table>
          <h3>Glass formers (raw mass frac)</h3>
          <table class="mini">
            ${gfc.map(([k, v]) => `<tr><td>${k}</td><td class="num">${(v * 100).toFixed(2)}%</td></tr>`).join('')}
          </table>
        </div>
        <div>
          <h3>Glass properties</h3>
          <table class="mini">
            <tr><td>η @1150°C</td><td class="num">${fmt.fixed(e.evaluation.eta1150, 2)} Pa·s</td></tr>
            <tr><td>PCT NL</td><td class="num">${fmt.fixed(e.evaluation.NL, 2)} g/m²</td></tr>
            <tr><td>k1208</td><td class="num">${fmt.fixed(e.evaluation.k1208, 4)} in</td></tr>
            <tr><td>SO₃ solubility (3TS)</td><td class="num">${fmt.fixed(e.evaluation.wso3_3ts, 2)} wt%</td></tr>
            <tr><td>N<sub>NaLi</sub></td><td class="num">${fmt.fixed(e.evaluation.NNaLi, 3)}</td></tr>
            <tr><td>Waste loading</td><td class="num">${fmt.fixed(e.waste_loading, 4)}</td></tr>
          </table>
          <h3>Top glass oxides</h3>
          <table class="mini">
            ${topOx.map(([k, v]) => `<tr><td>${k}</td><td class="num">${(v * 100).toFixed(2)}%</td></tr>`).join('')}
          </table>
          ${fails.length
            ? `<p class="bad">Constraint margins exceeded: ${fails.map(f => f[0]).join(', ')}</p>`
            : '<p class="ok">All 11 glass constraints satisfied.</p>'}
        </div>
      </div>`;
    host.hidden = false;
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // -------------------------------------------------------------- wire up
  function wire() {
    $('btn-run').addEventListener('click', run);
    $('btn-reset').addEventListener('click', () => window.location.reload());
    $('sel-scenario').addEventListener('change', updateScenarioNote);
    $('rng-vmin').addEventListener('input', e => $('out-vmin').textContent = e.target.value);
    $('rng-vmax').addEventListener('input', e => $('out-vmax').textContent = e.target.value);
    $('rng-wac').addEventListener('input', e => $('out-wac').textContent = e.target.value);
    $('rng-rate').addEventListener('input', e => $('out-rate').textContent = parseFloat(e.target.value).toFixed(1));
    $('rng-avail').addEventListener('input', e => $('out-avail').textContent = e.target.value);
    window.addEventListener('resize', () => {
      if (state.mission) { renderGlassChart(); renderWLChart(); }
    });
  }

  wire();
  loadData().then(() => {
    run();   // build the default mission on load
  }).catch(err => {
    document.body.insertAdjacentHTML('afterbegin',
      `<div style="background:#fee2e2;color:#7f1d1d;padding:12px;font-family:system-ui">
        Failed to load mission data: ${err}. Serve the web/ folder over HTTP
        (e.g. \`python3 -m http.server\`) — fetch() cannot read the local
        dataset from a file:// page.</div>`);
  });
})();
