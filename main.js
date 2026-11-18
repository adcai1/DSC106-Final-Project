// Prototype: uneven warming explorer (D3 v7).
// Data: data/twins.json (CMIP6 GFDL-ESM4 monthly climatologies on 2-degree land cells), data/places.json (Natural Earth).

const SCEN = ['ssp126', 'ssp245', 'ssp585'];
const SCEN_INFO = {
  ssp126: { word: 'low', code: 'SSP1-2.6', color: '#2b6f6b' },
  ssp245: { word: 'middle', code: 'SSP2-4.5', color: '#c98b2b' },
  ssp585: { word: 'high', code: 'SSP5-8.5', color: '#a8322d' },
};
const MONTH_SHORT = ['Year', 'J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_LONG = ['the year as a whole', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const P_FLOOR = 0.1; // mm/day: baseline floor so % change in near-zero-rain months does not explode

// Fixed color domains so colors mean the same thing in every scenario and month.
const VARS = {
  T: {
    name: 'temperature', unit: '°C', fmt: d3.format('+.1f'),
    color: d3.scaleDiverging([-3, 0, 12], t => d3.interpolateRdBu(1 - t)).clamp(true),
    ticks: [-3, 0, 3, 6, 9, 12], tickFmt: v => (v > 0 ? '+' : '') + v + (v === 12 ? '+' : ''),
    legend: 'Change in average temperature, 2081–2100 vs 1995–2014 (°C)',
  },
  P: {
    name: 'rainfall', unit: '%', fmt: v => d3.format('+.0f')(v) + '%',
    color: d3.scaleDiverging([-75, 0, 75], d3.interpolateBrBG).clamp(true),
    ticks: [-75, -50, -25, 0, 25, 50, 75], tickFmt: v => (v > 0 ? '+' : '') + v + '%',
    legend: 'Change in average precipitation, 2081–2100 vs 1995–2014 (%, clipped at ±75%)',
  },
};

const state = { v: 'T', s: 'ssp585', m: 0, hoverLat: null, playing: null };
let D, PLACES, cells, rows, cellSel, ctx = {};
const cache = new Map();

// ---------- layout ----------
const MW = 860, MH = 430;
const projection = d3.geoEqualEarth().fitExtent([[6, 6], [MW - 6, MH - 6]], { type: 'Sphere' });
const geoPath = d3.geoPath(projection);
const yOfLat = lat => projection([0, lat])[1];      // shared vertical scale for map and profile
const PW = 230, PM = { l: 34, r: 12 };
const tooltip = d3.select('#tooltip');

Promise.all([d3.json('data/twins.json'), d3.json('data/places.json')]).then(([twins, places]) => {
  D = twins;
  PLACES = places.rows.map(([name, country, lat, lon, pop]) => ({ name, country, lat, lon, pop }))
    .filter(p => p.pop >= 100000);
  cells = D.cells.map(([lat, lon], i) => ({ i, lat, lon, w: Math.cos(lat * Math.PI / 180) }));
  rows = d3.groups(cells, c => c.lat).map(([lat, cs]) => ({ lat, cells: cs }))
    .filter(r => r.cells.length >= 3).sort((a, b) => b.lat - a.lat);
  buildTiles();
  buildMap();
  buildProfile();
  buildControls();
  render(false);
}).catch(err => {
  d3.select('#summary').text('Could not load the data: ' + err.message);
  console.error(err);
});

// ---------- data ----------
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

function values(v, s, m) {
  const key = `${v}|${s}|${m}`;
  if (cache.has(key)) return cache.get(key);
  const now = D.present_clim[v], fut = D.scenarios[s][v];
  const out = new Float32Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const a = m === 0 ? mean(now[i]) : now[i][m - 1];
    const b = m === 0 ? mean(fut[i]) : fut[i][m - 1];
    out[i] = v === 'T' ? b - a : (b - a) / Math.max(a, P_FLOOR) * 100;
  }
  cache.set(key, out);
  return out;
}

function weightedMean(vals, subset) {
  let s = 0, w = 0;
  for (const c of subset) { s += vals[c.i] * c.w; w += c.w; }
  return s / w;
}

function rowMeans(v, s, m) {
  const vals = values(v, s, m);
  return rows.map(r => ({ lat: r.lat, val: mean(r.cells.map(c => vals[c.i])) }));
}

function placeName(c) {
  let best = null, bestD = Infinity;
  for (const p of PLACES) {
    if (Math.abs(p.lat - c.lat) > 4) continue;
    const d = d3.geoDistance([c.lon, c.lat], [p.lon, p.lat]) * 6371;
    const score = d - Math.log10(p.pop) * 25;     // prefer bigger places when they are close
    if (d < 300 && score < bestD) { bestD = score; best = p; }
  }
  const ll = `${Math.abs(c.lat)}°${c.lat >= 0 ? 'N' : 'S'}, ${Math.abs(c.lon)}°${c.lon >= 0 ? 'E' : 'W'}`;
  return best ? { title: `near ${best.name}, ${best.country}`, ll } : { title: ll, ll: '' };
}

// ---------- section 1: tiles ----------
function buildTiles() {
  const data = SCEN.map(s => ({ s, val: weightedMean(values('T', s, 0), cells) }));
  const t = d3.select('#tiles').selectAll('div').data(data).join('div').attr('class', 'tile')
    .style('border-top-color', d => SCEN_INFO[d.s].color);
  t.append('div').attr('class', 'num').text(d => d3.format('+.1f')(d.val) + '°C');
  t.append('div').attr('class', 'lab').text(d => `${SCEN_INFO[d.s].word} emissions (${SCEN_INFO[d.s].code})`);
}

// ---------- section 2: map ----------
function cellPath(c) {
  const h = D.grid_deg / 2;
  const pts = [[c.lon - h, c.lat - h], [c.lon - h, c.lat + h], [c.lon + h, c.lat + h], [c.lon + h, c.lat - h]]
    .map(p => projection(p));
  return 'M' + pts.map(p => p.map(n => n.toFixed(1)).join(',')).join('L') + 'Z';
}

function buildMap() {
  const svg = d3.select('#map').attr('viewBox', [0, 0, MW, MH]);
  svg.append('path').attr('class', 'sphere').attr('d', geoPath({ type: 'Sphere' }));
  svg.append('path').attr('class', 'graticule').attr('d', geoPath(d3.geoGraticule10()));
  cellSel = svg.append('g').selectAll('path').data(cells).join('path')
    .attr('class', 'cell').attr('d', cellPath)
    .on('mousemove', (e, c) => hoverCell(e, c))
    .on('mouseleave', () => { tooltip.attr('hidden', true); ctx.hoverRing.attr('d', null); setHoverLat(null); });
  ctx.bandG = svg.append('g');
  ctx.maxG = svg.append('g');
  ctx.hoverRing = svg.append('path').attr('class', 'hover-ring');
}

function parallel(lat) {
  return geoPath({ type: 'LineString', coordinates: d3.range(-180, 180.1, 2).map(lon => [lon, lat]) });
}

// ---------- section 2: latitude profile ----------
function buildProfile() {
  const svg = d3.select('#profile').attr('viewBox', [0, 0, PW, MH]);
  ctx.px = d3.scaleLinear().range([PM.l, PW - PM.r]);
  ctx.profDomain = {};
  for (const v of ['T', 'P']) {
    let lo = 0, hi = 0;
    for (const s of SCEN) for (let m = 0; m <= 12; m++) for (const r of rowMeans(v, s, m)) {
      lo = Math.min(lo, r.val); hi = Math.max(hi, r.val);
    }
    ctx.profDomain[v] = d3.nice(lo, hi, 5);
  }
  ctx.pAxis = svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${MH - 22})`);
  // Latitude ticks placed with the map's own projection (Equal Earth y is not linear in latitude).
  const lt = svg.append('g').attr('class', 'axis').selectAll('g').data([-40, -20, 0, 20, 40, 60, 80]).join('g')
    .attr('transform', d => `translate(${PM.l},${yOfLat(d)})`);
  lt.append('line').attr('x1', -3).attr('x2', 0);
  lt.append('text').attr('x', -5).attr('dy', '0.32em').attr('text-anchor', 'end')
    .text(d => d === 0 ? 'Eq' : Math.abs(d) + '°' + (d > 0 ? 'N' : 'S'));
  ctx.zero = svg.append('line').attr('class', 'zero');
  ctx.pLines = svg.append('g');
  ctx.pHover = svg.append('g').style('display', 'none');
  ctx.pHover.append('line').attr('class', 'prof-hover');
  ctx.pHover.append('circle').attr('class', 'prof-dot').attr('r', 4.5);
  ctx.pHoverText = ctx.pHover.append('text').attr('class', 'max-label').attr('dy', -8);

  svg.append('rect').attr('x', 0).attr('y', yOfLat(85)).attr('width', PW).attr('height', yOfLat(-55) - yOfLat(85))
    .attr('fill', 'transparent')
    .on('mousemove', e => {
      const y = d3.pointer(e)[1];
      const r = d3.least(rows, r => Math.abs(yOfLat(r.lat) - y));
      setHoverLat(r.lat);
    })
    .on('mouseleave', () => setHoverLat(null));
}

function drawProfile(animate) {
  const V = VARS[state.v];
  ctx.px.domain(ctx.profDomain[state.v]);
  const ticks = state.v === 'P' ? [-50, 0, 50, 100] : [0, 5, 10];
  ctx.pAxis.call(d3.axisBottom(ctx.px).tickValues(ticks.filter(t => t >= ctx.px.domain()[0] && t <= ctx.px.domain()[1]))
    .tickFormat(v => (v > 0 ? '+' : '') + v + (state.v === 'P' ? '%' : '°')).tickSize(3))
    .call(g => g.select('.domain').remove());
  ctx.zero.attr('x1', ctx.px(0)).attr('x2', ctx.px(0)).attr('y1', yOfLat(85)).attr('y2', yOfLat(-55));
  const line = d3.line().x(d => ctx.px(d.val)).y(d => yOfLat(d.lat)).curve(d3.curveMonotoneY);
  const data = SCEN.map(s => ({ s, pts: rowMeans(state.v, s, state.m) }));
  ctx.pLines.selectAll('path').data(data, d => d.s).join('path')
    .attr('class', 'prof-line')
    .attr('stroke', d => SCEN_INFO[d.s].color)
    .attr('stroke-width', d => d.s === state.s ? 2.6 : 1.2)
    .attr('stroke-opacity', d => d.s === state.s ? 1 : 0.45)
    .sort((a, b) => (a.s === state.s) - (b.s === state.s))
    .transition().duration(animate ? 450 : 0)
    .attr('d', d => line(d.pts));
  const key = d3.select('#profile-key').selectAll('span').data(SCEN).join(enter => {
    const k = enter.append('span'); k.append('i'); k.append('em'); return k;
  });
  key.select('i').style('border-top-color', d => SCEN_INFO[d].color).style('border-top-width', d => d === state.s ? '3px' : '1px');
  key.select('em').style('font-style', 'normal').style('font-weight', d => d === state.s ? 600 : 400).text(d => SCEN_INFO[d].word);
  drawProfileHover();
}

function drawProfileHover() {
  if (state.hoverLat == null) { ctx.pHover.style('display', 'none'); return; }
  const r = rowMeans(state.v, state.s, state.m).find(d => d.lat === state.hoverLat);
  if (!r) return;
  const y = yOfLat(r.lat), x = ctx.px(r.val);
  ctx.pHover.style('display', null);
  ctx.pHover.select('line').attr('x1', PM.l).attr('x2', PW - PM.r).attr('y1', y).attr('y2', y);
  ctx.pHover.select('circle').attr('cx', x).attr('cy', y).attr('fill', SCEN_INFO[state.s].color);
  ctx.pHoverText.attr('x', Math.min(x, PW - 60)).attr('y', y)
    .attr('text-anchor', 'middle').text(VARS[state.v].fmt(r.val));
}

function setHoverLat(lat) {
  state.hoverLat = lat;
  cellSel.classed('dim', c => lat != null && c.lat !== lat);
  ctx.bandG.selectAll('path').data(lat == null ? [] : [lat - 1, lat + 1]).join('path')
    .attr('class', 'band-line').attr('d', parallel);
  drawProfileHover();
}

// ---------- rendering ----------
function render(animate) {
  const V = VARS[state.v], vals = values(state.v, state.s, state.m);
  cellSel.transition().duration(animate ? 450 : 0).attr('fill', c => V.color(vals[c.i]));
  drawProfile(animate);
  drawLegend();
  drawMaxMark(vals);
  drawSummary(vals);
  d3.select('#caption').text(
    `Each cell is a 2° patch of land (${cells.length.toLocaleString()} in all; Antarctica excluded), ` +
    `colored by its change between the 1995–2014 and 2081–2100 averages` +
    (state.v === 'P' ? `. Percent change uses a ${P_FLOOR} mm/day floor on the baseline so very dry months do not explode, ` +
      `and the "largest change" marker only considers places with at least 1 mm/day today. ` : '. ') +
    `The profile on the right averages each row of cells, on the same vertical scale as the map. Model: ${D.model} (${D.member}).`);
  d3.selectAll('#var-seg button').attr('aria-pressed', function () { return this.dataset.v === state.v; });
  d3.selectAll('#scen-seg button').attr('aria-pressed', function () { return this.dataset.s === state.s; });
  d3.selectAll('#month-seg button').attr('aria-pressed', function () { return +this.dataset.m === state.m; });
}

function drawMaxMark(vals) {
  // For rainfall, ignore places with under 1 mm/day today: a tiny baseline makes any change look huge.
  const base = D.present_clim.P;
  const ok = i => state.v === 'T' || (state.m === 0 ? mean(base[i]) : base[i][state.m - 1]) >= 1;
  let k = -1;
  for (let i = 0; i < vals.length; i++) if (ok(i) && (k < 0 || Math.abs(vals[i]) > Math.abs(vals[k]))) k = i;
  const c = cells[k], [x, y] = projection([c.lon, c.lat]);
  const right = x < MW * 0.7;
  const g = ctx.maxG.selectAll('g').data([0]).join(enter => {
    const g = enter.append('g'); g.append('circle').attr('class', 'max-mark').attr('r', 9);
    g.append('text').attr('class', 'max-label'); return g;
  });
  g.select('circle').attr('cx', x).attr('cy', y);
  g.select('text').attr('x', x + (right ? 13 : -13)).attr('y', y + 4).attr('text-anchor', right ? 'start' : 'end')
    .text(`Largest change: ${VARS[state.v].fmt(vals[k])}${state.v === 'T' ? '°C' : ''}`);
}

function drawSummary(vals) {
  const when = state.m === 0 ? 'Over the year as a whole' : `In ${MONTH_LONG[state.m]}`;
  const path = `<b>${SCEN_INFO[state.s].word}</b> emissions`;
  let html;
  if (state.v === 'T') {
    const north = weightedMean(vals, cells.filter(c => c.lat >= 60));
    const trop = weightedMean(vals, cells.filter(c => Math.abs(c.lat) < 20));
    const all = weightedMean(vals, cells);
    html = `${when} under ${path}, land warms <b>${VARS.T.fmt(all)}°C</b> on average. North of 60°N it warms ` +
      `<b>${VARS.T.fmt(north)}°C</b>, ${d3.format('.1f')(north / trop)}× the tropics (${VARS.T.fmt(trop)}°C).`;
  } else {
    let wet = 0, dry = 0, w = 0;
    for (const c of cells) { w += c.w; if (vals[c.i] > 10) wet += c.w; else if (vals[c.i] < -10) dry += c.w; }
    html = `${when} under ${path}, <b>${d3.format('.0%')(wet / w)}</b> of land gets more than 10% wetter ` +
      `and <b>${d3.format('.0%')(dry / w)}</b> gets more than 10% drier.`;
  }
  d3.select('#summary').html(html);
}

function drawLegend() {
  const V = VARS[state.v], w = 320, h = 10;
  const [lo, , hi] = V.color.domain();
  const x = d3.scaleLinear().domain([lo, hi]).range([0, w]);
  const svg = d3.select('#legend').selectAll('svg').data([0]).join('svg').attr('viewBox', [-14, 0, w + 34, 46])
    .attr('width', w + 34).attr('height', 46).style('max-width', '100%');
  svg.selectAll('text.lt').data([0]).join('text').attr('class', 'lt').attr('x', 0).attr('y', 11).text(V.legend);
  const grad = svg.selectAll('defs').data([0]).join('defs').selectAll('linearGradient').data([0]).join('linearGradient')
    .attr('id', 'lg');
  grad.selectAll('stop').data(d3.range(0, 1.001, 0.05)).join('stop')
    .attr('offset', t => t).attr('stop-color', t => V.color(lo + t * (hi - lo)));
  svg.selectAll('rect').data([0]).join('rect').attr('x', 0).attr('y', 17).attr('width', w).attr('height', h)
    .attr('fill', 'url(#lg)');
  svg.selectAll('g.ax').data([0]).join('g').attr('class', 'ax axis').attr('transform', `translate(0,${17 + h})`)
    .call(d3.axisBottom(x).tickValues(V.ticks).tickFormat(V.tickFmt).tickSize(3))
    .call(g => g.select('.domain').remove());
}

function hoverCell(e, c) {
  const V = VARS[state.v], vals = values(state.v, state.s, state.m);
  const now = D.present_clim[state.v][c.i], fut = D.scenarios[state.s][state.v][c.i];
  const a = state.m === 0 ? mean(now) : now[state.m - 1], b = state.m === 0 ? mean(fut) : fut[state.m - 1];
  const nm = placeName(c);
  const f = state.v === 'T' ? v => d3.format('.1f')(v) + '°C' : v => d3.format('.2f')(v) + ' mm/day';
  tooltip.attr('hidden', null)
    .style('left', Math.min(e.clientX + 14, window.innerWidth - 285) + 'px')
    .style('top', (e.clientY + 14) + 'px')
    .html(`<b>${nm.title}</b>${nm.ll ? `<br><span style="color:#7d7a70">${nm.ll}</span>` : ''}` +
      `<br><span class="big">${V.fmt(vals[c.i])}${state.v === 'T' ? '°C' : ''}</span> ${V.name}, ${state.m === 0 ? 'annual' : MONTH_LONG[state.m]}` +
      `<br>${f(a)} today → ${f(b)} in 2081–2100 (${SCEN_INFO[state.s].word})`);
  ctx.hoverRing.attr('d', cellPath(c));
  if (state.hoverLat !== c.lat) {
    state.hoverLat = c.lat;
    ctx.bandG.selectAll('path').remove();
    drawProfileHover();
  }
}

// ---------- controls ----------
function buildControls() {
  d3.selectAll('#var-seg button').on('click', function () { state.v = this.dataset.v; render(true); });
  d3.selectAll('#scen-seg button').on('click', function () { state.s = this.dataset.s; render(true); });
  d3.select('#month-seg').selectAll('button').data(d3.range(13)).join('button')
    .attr('data-m', d => d).attr('aria-label', d => MONTH_LONG[d]).text(d => MONTH_SHORT[d])
    .on('click', (e, d) => { stop(); state.m = d; render(true); });
  d3.select('#play').on('click', () => (state.playing ? stop() : play()));
}

function play() {
  if (state.m === 0 || state.m === 12) state.m = 0;
  d3.select('#play').attr('aria-pressed', true).html('&#10074;&#10074; Pause');
  const tick = () => { state.m = state.m % 12 + 1; render(true); };
  tick();
  state.playing = d3.interval(tick, 1100);
}

function stop() {
  if (state.playing) state.playing.stop();
  state.playing = null;
  d3.select('#play').attr('aria-pressed', false).html('&#9654; Play');
}
