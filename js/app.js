import { PRESETS, DEFAULT_PRESET, STAT_LABELS, makeScorer, presetStats } from './scoring.js';

const POS = ['G', 'F', 'C'];
const POS_COLS = [...POS, 'all'];
const POS_LABEL = { G: 'Guards', F: 'Forwards', C: 'Centers', all: 'All' };
const BREAKDOWN = ['fp', 'pts', 'reb', 'ast', 'tpm', 'stl', 'blk'];
const VIEWS = ['dvp', 'stats', 'team', 'adj'];

// Everything here is mirrored in the URL so views can be bookmarked/shared.
const DEFAULTS = {
  season: null, view: 'dvp', score: DEFAULT_PRESET, pace: 'game', win: 'all', po: '0',
  team: null, pos: 'G', sort: null, dir: 'desc',
};
const ALLOWED = {
  view: VIEWS, score: Object.keys(PRESETS), pace: ['game', '100'], win: ['all', '10', '5'],
  po: ['0', '1', '2'], pos: [...POS, 'all'], dir: ['asc', 'desc'],
};

const state = { ...DEFAULTS };
let seasonsIndex = null;
let meta = {};
const cache = new Map();
let D = null; // prepared data for the selected season

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));
const fmtSigned = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d));

// ------------------------------------------------------------------ URL state

function readURL() {
  const q = new URLSearchParams(location.search);
  for (const k of Object.keys(DEFAULTS)) {
    if (!q.has(k)) continue;
    const v = q.get(k);
    if (ALLOWED[k] && !ALLOWED[k].includes(v)) continue;
    state[k] = v;
  }
}

function writeURL() {
  const q = new URLSearchParams();
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = state[k];
    if (v == null || (v === def && k !== 'season')) continue;
    if (k === 'team' && state.view !== 'team') continue;
    if (k === 'pos' && state.view !== 'stats') continue;
    q.set(k, v);
  }
  const s = q.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
}

// ------------------------------------------------------------------ data

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadSeason(season) {
  if (!cache.has(season)) {
    const p = getJSON(`data/${season}.json`).then(prepare);
    p.catch(() => cache.delete(season)); // allow a retry after a failed fetch
    cache.set(season, p);
  }
  return cache.get(season);
}

function prepare(raw) {
  const R = raw.rows;
  const G = raw.games;
  const n = R.g.length;
  const nGames = G.id.length;
  const nTeams = raw.teams.id.length;
  const opp = new Int16Array(n);
  const pos = new Array(n);
  const rowsByGame = Array.from({ length: nGames }, () => []);
  const teamGames = Array.from({ length: nTeams }, () => []);
  for (let i = 0; i < n; i++) {
    const g = R.g[i];
    opp[i] = G.home[g] === R.t[i] ? G.away[g] : G.home[g];
    pos[i] = raw.players.pos[R.p[i]];
    rowsByGame[g].push(i);
  }
  for (let g = 0; g < nGames; g++) { // games are sorted by date in the file
    teamGames[G.home[g]].push(g);
    teamGames[G.away[g]].push(g);
  }
  const hasPlayoffs = G.po.some((x) => x === 1);
  return { raw, R, G, n, nTeams, opp, pos, rowsByGame, teamGames, hasPlayoffs, scoreKey: null };
}

const gameIncluded = (g) => (state.po === '1' ? true : state.po === '2' ? D.G.po[g] === 1 : D.G.po[g] === 0);
const paceOn = () => state.pace === '100';

// Fantasy points + each player's leave-one-out average (the "expected" line
// used for opponent adjustment) for the current preset and game type.
function ensureScores() {
  const key = `${state.score}|${state.po}`;
  if (D.scoreKey === key) return;
  const { R, n } = D;
  const f = makeScorer(state.score, R);
  const fp = new Float64Array(n);
  const nP = D.raw.players.id.length;
  const sum = new Float64Array(nP);
  const cnt = new Int32Array(nP);
  for (let i = 0; i < n; i++) {
    fp[i] = f(i);
    if (gameIncluded(R.g[i])) { sum[R.p[i]] += fp[i]; cnt[R.p[i]]++; }
  }
  const base = new Float64Array(n);
  const seasonAvg = new Float64Array(nP);
  for (let p = 0; p < nP; p++) seasonAvg[p] = cnt[p] ? sum[p] / cnt[p] : NaN;
  for (let i = 0; i < n; i++) {
    const p = R.p[i];
    base[i] = cnt[p] > 1 ? (sum[p] - (gameIncluded(R.g[i]) ? fp[i] : 0)) / (cnt[p] - (gameIncluded(R.g[i]) ? 1 : 0)) : NaN;
  }
  Object.assign(D, { fp, base, seasonAvg, playerGames: cnt, scoreKey: key });
}

// A defense's games under the current filters, oldest -> newest.
function windowGames(t) {
  let games = D.teamGames[t].filter(gameIncluded);
  if (paceOn()) games = games.filter((g) => D.G.poss[g]);
  if (state.win !== 'all') games = games.slice(-Number(state.win));
  return games;
}

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function std(a) {
  const xs = a.filter((x) => !Number.isNaN(x));
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

// Per-game totals allowed by defense t to opponents at each position,
// using valueFn(rowIndex) (NaN = skip). Returns {games, G:{avg,med}, ...}.
function defenseAgg(t, valueFn) {
  const games = windowGames(t);
  const per = { G: [], F: [], C: [], all: [] };
  for (const g of games) {
    const sums = { G: 0, F: 0, C: 0, all: 0 };
    const k = paceOn() ? 100 / D.G.poss[g] : 1;
    for (const i of D.rowsByGame[g]) {
      if (D.R.t[i] === t) continue;
      const v = valueFn(i);
      if (Number.isNaN(v)) continue;
      sums.all += v;
      if (D.pos[i]) sums[D.pos[i]] += v;
    }
    for (const c of POS_COLS) per[c].push(sums[c] * k);
  }
  const out = { games: games.length };
  for (const c of POS_COLS) out[c] = { avg: mean(per[c]), med: median(per[c]) };
  return out;
}

const statFn = (stat) => {
  if (stat === 'fp') return (i) => D.fp[i];
  const col = D.R[stat];
  return (i) => (col[i] == null ? NaN : col[i]);
};
const adjFn = () => (i) => D.fp[i] - D.base[i];
const statAvailable = (stat) => stat === 'fp' || D.raw.coverage.stats[stat] !== false;

// ------------------------------------------------------------------ rendering helpers

const teamAbbr = (t) => D.raw.teams.abbr[t];
const teamName = (t) => D.raw.teams.name[t];

function heatCells(rows, cols, { center = 'mean', skewCols = cols } = {}) {
  // For each column, colour by distance from the column mean (or 0), scaled to the
  // largest distance. Higher = softer matchup (warm), lower = tougher (cool).
  const scale = {};
  for (const c of cols) {
    const vals = rows.map((r) => r[c].avg).filter((v) => !Number.isNaN(v));
    const mid = center === 'zero' ? 0 : mean(vals);
    const spread = Math.max(...vals.map((v) => Math.abs(v - mid)), 1e-9);
    scale[c] = { mid, spread, sd: std(vals) };
  }
  return (r, c, digits = 1, signed = false) => {
    const { avg, med } = r[c];
    if (Number.isNaN(avg)) return '<td class="heat na">—</td>';
    const { mid, spread, sd } = scale[c];
    const tt = (avg - mid) / spread;
    const mix = `calc(var(--heat-max) * ${Math.abs(tt).toFixed(3)})`;
    // Median flag only where it means something (fantasy totals, not 0/1/2 counts).
    const skew = skewCols.includes(c) && sd > 0 && Math.abs(avg - med) > sd;
    const f = signed ? fmtSigned : fmt;
    const title = `${teamAbbr(r.t)} · ${POS_LABEL[c] || STAT_LABELS[c] || 'Fantasy'}: avg ${f(avg, 2)}, median ${f(med, 2)}, ${r.games} games`;
    return `<td class="heat ${tt >= 0 ? 'soft' : 'tough'}" style="--mix:${mix}" title="${esc(title)}">`
      + `<span class="v">${f(avg, digits)}</span><span class="m${skew ? ' skew' : ''}">med ${f(med, digits)}</span></td>`;
  };
}

function sortHeader(key, label, cls = '') {
  const active = state.sort === key;
  const aria = active ? ` aria-sort="${state.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
  return `<th class="${cls}"${aria}><button type="button" data-sort="${key}">${label}</button></th>`;
}

function sortRows(rows, getters, defaultKey) {
  const key = getters[state.sort] ? state.sort : defaultKey;
  if (!getters[state.sort]) state.sort = defaultKey;
  const g = getters[key];
  const dir = state.dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const x = g(a); const y = g(b);
    if (typeof x === 'string') return x.localeCompare(y) * dir;
    if (Number.isNaN(x)) return 1;
    if (Number.isNaN(y)) return -1;
    return (x - y) * dir;
  });
}

function teamCell(t) {
  return `<td><a class="team-link" href="?${linkFor({ view: 'team', team: teamAbbr(t) })}" data-team="${esc(teamAbbr(t))}">`
    + `<span class="team-cell"><b>${esc(teamAbbr(t))}</b><small>${esc(teamName(t))}</small></span></a></td>`;
}

function linkFor(over) {
  const q = new URLSearchParams();
  const s = { ...state, ...over, sort: null, dir: 'desc' };
  for (const [k, def] of Object.entries(DEFAULTS)) if (s[k] != null && (s[k] !== def || k === 'season')) q.set(k, s[k]);
  return q.toString();
}

function rateLabel() { return paceOn() ? 'per 100 possessions' : 'per game'; }
function windowLabel() { return state.win === 'all' ? 'all games' : `each defense's last ${state.win} games`; }
function typeLabel() { return { 0: 'regular season', 1: 'regular season + playoffs', 2: 'playoffs' }[state.po]; }

function legend(lo = 'Tougher', hi = 'Softer') {
  return `<div class="legend" aria-hidden="true"><span>${lo}</span><span class="bar"></span><span>${hi}</span></div>`;
}

function teamsWithGames() {
  return [...Array(D.nTeams).keys()].filter((t) => windowGames(t).length > 0);
}

function emptyMsg() {
  return `<p class="empty">No games match these filters${state.po === '2' && !D.hasPlayoffs ? ' (no playoff games this season yet)' : ''}.</p>`;
}

// ------------------------------------------------------------------ views

function viewDvp() {
  const teams = teamsWithGames();
  if (!teams.length) return emptyMsg();
  const fn = statFn('fp');
  let rows = teams.map((t) => ({ t, ...defenseAgg(t, fn) }));
  const getters = { team: (r) => teamAbbr(r.t), games: (r) => r.games };
  for (const c of POS_COLS) getters[c] = (r) => r[c].avg;
  rows = sortRows(rows, getters, 'all');
  const cell = heatCells(rows, POS_COLS);
  return `
    <div class="view-head">
      <div>
        <h2>Fantasy points allowed by position</h2>
        <p>${esc(PRESETS[state.score].label)} points scored against each defense, ${rateLabel()}, ${windowLabel()}, ${typeLabel()}.
        Big number = average, small = median; ◆ marks teams where a few outlier games pull the average away from the median.</p>
      </div>
      ${legend()}
    </div>
    <div class="table-wrap"><table>
      <thead><tr>${sortHeader('team', 'Defense', 'l')}${POS_COLS.map((c) => sortHeader(c, POS_LABEL[c])).join('')}${sortHeader('games', 'GP')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${teamCell(r.t)}${POS_COLS.map((c) => cell(r, c)).join('')}<td class="muted">${r.games}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="foot-note">“All” includes players without a listed position. Click a team for the game-by-game drill-down.</p>`;
}

function viewStats() {
  const teams = teamsWithGames();
  const posSeg = `<div class="seg" role="group" aria-label="Position"><span>Position</span><div>${[...POS, 'all']
    .map((p) => `<button type="button" data-key="pos" data-val="${p}" aria-pressed="${state.pos === p}">${p === 'all' ? 'All' : p}</button>`).join('')}</div></div>`;
  if (!teams.length) return `<div class="view-head"><div><h2>Stat breakdown</h2></div><div class="view-tools">${posSeg}</div></div>${emptyMsg()}`;
  const cols = BREAKDOWN.filter(statAvailable);
  const missing = BREAKDOWN.filter((s) => !statAvailable(s));
  let rows = teams.map((t) => {
    const r = { t };
    for (const s of cols) {
      const a = defenseAgg(t, statFn(s));
      r.games = a.games;
      r[s] = a[state.pos];
    }
    return r;
  });
  const getters = { team: (r) => teamAbbr(r.t), games: (r) => r.games };
  for (const s of cols) getters[s] = (r) => r[s].avg;
  rows = sortRows(rows, getters, 'fp');
  const cell = heatCells(rows, cols, { skewCols: ['fp'] });
  const label = (s) => (s === 'fp' ? 'Fantasy' : STAT_LABELS[s]);
  return `
    <div class="view-head">
      <div>
        <h2>What each defense allows to ${state.pos === 'all' ? 'all players' : POS_LABEL[state.pos].toLowerCase()}</h2>
        <p>Box-score stats allowed ${rateLabel()}, ${windowLabel()}, ${typeLabel()}. Average with median below.</p>
      </div>
      <div class="view-tools">${posSeg}${legend()}</div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>${sortHeader('team', 'Defense', 'l')}${cols.map((s) => sortHeader(s, label(s))).join('')}${sortHeader('games', 'GP')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${teamCell(r.t)}${cols.map((s) => cell(r, s, s === 'fp' || s === 'pts' || s === 'reb' ? 1 : 2)).join('')}<td class="muted">${r.games}</td></tr>`).join('')}</tbody>
    </table></div>
    ${missing.length ? `<p class="foot-note">Not available for ${D.raw.season}: ${missing.map((s) => STAT_LABELS[s]).join(', ')}.</p>` : ''}`;
}

function viewAdj() {
  const teams = teamsWithGames();
  if (!teams.length) return emptyMsg();
  const fn = adjFn();
  let rows = teams.map((t) => ({ t, ...defenseAgg(t, fn) }));
  const getters = { team: (r) => teamAbbr(r.t), games: (r) => r.games };
  for (const c of POS_COLS) getters[c] = (r) => r[c].avg;
  rows = sortRows(rows, getters, 'all');
  const cell = heatCells(rows, POS_COLS, { center: 'zero' });
  return `
    <div class="view-head">
      <div>
        <h2>Fantasy points allowed above / below opponents' averages</h2>
        <p>For every player who faced the defense: her fantasy points that game minus her ${typeLabel()} average in her other games,
        summed by position, ${rateLabel()}, ${windowLabel()}. Positive = the defense lets players beat their usual output.</p>
      </div>
      ${legend('Holds below avg', 'Allows above avg')}
    </div>
    <div class="table-wrap"><table>
      <thead><tr>${sortHeader('team', 'Defense', 'l')}${POS_COLS.map((c) => sortHeader(c, POS_LABEL[c])).join('')}${sortHeader('games', 'GP')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${teamCell(r.t)}${POS_COLS.map((c) => cell(r, c, 1, true)).join('')}<td class="muted">${r.games}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="foot-note">Players with only one game this season have no baseline and are left out.</p>`;
}

function viewTeam() {
  const abbrs = D.raw.teams.abbr;
  let t = abbrs.indexOf(state.team);
  if (t < 0) { t = 0; state.team = abbrs[0]; }
  const order = [...abbrs.keys()].sort((a, b) => teamName(a).localeCompare(teamName(b)));
  const picker = `<label><span>Defense</span><select id="team-select">${order
    .map((i) => `<option value="${esc(abbrs[i])}"${i === t ? ' selected' : ''}>${esc(teamName(i))}</option>`).join('')}</select></label>`;
  const games = windowGames(t);
  const head = `<div class="view-head"><div><h2>Who scored against the ${esc(teamName(t))}</h2>
    <p>${esc(PRESETS[state.score].label)} scoring · ${windowLabel().replace("each defense's", 'the')} · ${typeLabel()}.</p></div>
    <div class="view-tools">${picker}</div></div>`;
  if (!games.length) return head + emptyMsg();

  const agg = defenseAgg(t, statFn('fp'));
  const adj = defenseAgg(t, adjFn());
  const tiles = POS_COLS.map((c) => `<div class="tile"><div class="k">${POS_LABEL[c]} · FP ${paceOn() ? '/100' : '/g'}</div>
    <div class="big">${fmt(agg[c].avg)}</div><div class="sub">median ${fmt(agg[c].med)} · vs avg ${fmtSigned(adj[c].avg)}</div></div>`).join('');

  // Player summary vs this defense
  const { R, fp, base, seasonAvg } = D;
  const byP = new Map();
  for (const g of games) {
    for (const i of D.rowsByGame[g]) {
      if (R.t[i] === t) continue;
      const p = R.p[i];
      if (!byP.has(p)) byP.set(p, { p, team: R.t[i], gp: 0, min: [], fp: [], diff: [] });
      const e = byP.get(p);
      e.gp++;
      if (R.min[i] != null) e.min.push(R.min[i]);
      e.fp.push(fp[i]);
      if (!Number.isNaN(base[i])) e.diff.push(fp[i] - base[i]);
    }
  }
  let prow = [...byP.values()].map((e) => ({ ...e, minAvg: mean(e.min), fpAvg: mean(e.fp), sAvg: seasonAvg[e.p], dAvg: mean(e.diff) }));
  const getters = {
    player: (r) => D.raw.players.name[r.p], gp: (r) => r.gp, min: (r) => r.minAvg,
    fp: (r) => r.fpAvg, savg: (r) => r.sAvg, diff: (r) => r.dAvg,
  };
  prow = sortRows(prow, getters, 'fp');
  const posTag = (p) => `<span class="pos-tag">${esc(D.raw.players.pos[p] || '?')}</span>`;
  const diffCell = (v) => `<td class="${v > 0 ? 'diff-pos' : v < 0 ? 'diff-neg' : ''}">${fmtSigned(v)}</td>`;
  const playersTable = `<div class="table-wrap"><table>
    <thead><tr>${sortHeader('player', 'Player', 'l')}<th class="l">Pos</th><th class="l">Team</th>${sortHeader('gp', 'GP')}${sortHeader('min', 'MIN')}${sortHeader('fp', 'FP vs')}${sortHeader('savg', 'Season avg')}${sortHeader('diff', '+/- avg')}</tr></thead>
    <tbody>${prow.map((r) => `<tr><td>${esc(D.raw.players.name[r.p])}</td><td class="l">${posTag(r.p)}</td><td class="l muted">${esc(teamAbbr(r.team))}</td>
      <td>${r.gp}</td><td>${fmt(r.minAvg)}</td><td><b>${fmt(r.fpAvg)}</b></td><td class="muted">${fmt(r.sAvg)}</td>${diffCell(r.dAvg)}</tr>`).join('')}</tbody>
  </table></div>`;

  // Game log, newest first
  const statCols = ['min', 'pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'tov'].filter((s) => s === 'min' || statAvailable(s));
  const logRows = [...games].reverse().map((g) => {
    const G = D.G;
    const home = G.home[g] === t;
    const o = home ? G.away[g] : G.home[g];
    const rows = D.rowsByGame[g].filter((i) => R.t[i] !== t).sort((a, b) => fp[b] - fp[a]);
    const total = rows.reduce((s, i) => s + fp[i], 0);
    const head = `<tr class="game-head"><td colspan="${statCols.length + 5}">${esc(G.date[g])} · ${home ? 'vs' : '@'} ${esc(teamAbbr(o))}${G.po[g] ? ' · Playoffs' : ''}
      <small>${fmt(total)} FP allowed${G.poss[g] ? ` · ${fmt(G.poss[g])} poss` : ''}</small></td></tr>`;
    return head + rows.map((i) => `<tr><td>${esc(D.raw.players.name[R.p[i]])}</td><td class="l">${posTag(R.p[i])}</td>
      ${statCols.map((s) => `<td${s === 'min' ? '' : ' class="muted"'}>${s === 'min' ? fmt(R.min[i]) : (R[s][i] ?? '—')}</td>`).join('')}
      <td><b>${fmt(fp[i])}</b></td><td class="muted">${fmt(base[i])}</td>${diffCell(fp[i] - base[i])}</tr>`).join('');
  }).join('');
  const logTable = `<div class="table-wrap"><table>
    <thead><tr><th class="l">Player</th><th class="l">Pos</th>${statCols.map((s) => `<th>${s === 'min' ? 'MIN' : STAT_LABELS[s]}</th>`).join('')}<th>FP</th><th>Her avg</th><th>+/-</th></tr></thead>
    <tbody>${logRows}</tbody></table></div>`;

  return `${head}
    <div class="summary">${tiles}<div class="tile"><div class="k">Games</div><div class="big">${games.length}</div><div class="sub">${typeLabel()}</div></div></div>
    <h3>Players vs ${esc(teamAbbr(t))}</h3>${playersTable}
    <p class="foot-note">Player tables are raw per-game numbers. “Season avg” is her ${typeLabel()} average; “+/- avg” compares each game with her average in her other games.</p>
    <h3>Game log</h3>${logTable}`;
}

// ------------------------------------------------------------------ chrome

function renderNotices() {
  const cov = D.raw.coverage;
  const out = [];
  if (cov.position_rows < 0.95) {
    out.push(`Positions are missing for ${Math.round((1 - cov.position_rows) * 100)}% of player-games in ${D.raw.season}. Those players count only toward “All”.`);
  }
  if (cov.possessions === 0) out.push(`Possession data isn't available for ${D.raw.season}, so per-100 numbers are disabled.`);
  else if (cov.possessions < 1 && paceOn()) out.push(`Possessions are missing for ${Math.round((1 - cov.possessions) * 100)}% of games; per-100 numbers skip those games.`);
  const missing = presetStats(state.score).filter((s) => cov.stats[s] === false);
  if (missing.length) out.push(`${missing.map((s) => STAT_LABELS[s]).join(', ')} not recorded for ${D.raw.season}; ${PRESETS[state.score].label} scoring counts them as 0.`);
  if (cov.stats.min === false) out.push(`Minutes played aren't available for ${D.raw.season}.`);
  $('#notices').innerHTML = out.map((m) => `<p class="notice">${esc(m)}</p>`).join('');
}

function renderControls() {
  document.querySelectorAll('.controls .seg button').forEach((b) => b.setAttribute('aria-pressed', String(state[b.dataset.key] === b.dataset.val)));
  const noPoss = D && D.raw.coverage.possessions === 0;
  const pace100 = document.querySelector('[data-key="pace"][data-val="100"]');
  pace100.disabled = noPoss;
  pace100.title = noPoss ? 'No possession data for this season' : '';
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
  $('#season').value = String(state.season);
  $('#score').value = state.score;
  const m = meta[String(state.season)];
  if (m) {
    const when = new Date(m.updated).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    $('#updated').textContent = `Updated ${when} · games through ${m.last_game}${m.complete ? ' · final' : ''}`;
  } else {
    $('#updated').textContent = '';
  }
}

function render() {
  if (!D) return;
  if (D.raw.coverage.possessions === 0 && paceOn()) state.pace = 'game';
  ensureScores();
  renderControls();
  renderNotices();
  const views = { dvp: viewDvp, stats: viewStats, team: viewTeam, adj: viewAdj };
  $('#main').innerHTML = views[state.view]();
  writeURL();
}

async function selectSeason(season) {
  state.season = Number(season);
  $('#main').innerHTML = '<p class="loading">Loading…</p>';
  try {
    D = await loadSeason(state.season);
    render();
  } catch (e) {
    D = null;
    $('#main').innerHTML = `<p class="empty">Couldn't load ${esc(season)} data (${esc(e.message)}).</p>`;
  }
}

function bind() {
  $('#season').addEventListener('change', (e) => { state.sort = null; selectSeason(e.target.value); });
  $('#score').addEventListener('change', (e) => { state.score = e.target.value; render(); });
  document.addEventListener('click', (e) => {
    const seg = e.target.closest('.seg button[data-key]');
    if (seg) {
      state[seg.dataset.key] = seg.dataset.val;
      render();
      return;
    }
    const tab = e.target.closest('.tabs button[data-view]');
    if (tab) {
      if (state.view !== tab.dataset.view) { state.view = tab.dataset.view; state.sort = null; state.dir = 'desc'; }
      render();
      return;
    }
    const sort = e.target.closest('th button[data-sort]');
    if (sort) {
      const k = sort.dataset.sort;
      if (state.sort === k) state.dir = state.dir === 'desc' ? 'asc' : 'desc';
      else { state.sort = k; state.dir = ['team', 'player'].includes(k) ? 'asc' : 'desc'; }
      render();
      return;
    }
    const link = e.target.closest('a[data-team]');
    if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      Object.assign(state, { view: 'team', team: link.dataset.team, sort: null, dir: 'desc' });
      render();
      window.scrollTo({ top: 0 });
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'team-select') { state.team = e.target.value; render(); }
  });
}

async function init() {
  readURL();
  $('#score').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
  bind();
  try {
    [seasonsIndex, meta] = await Promise.all([getJSON('data/seasons.json'), getJSON('data/meta.json').catch(() => ({}))]);
  } catch (e) {
    $('#main').innerHTML = `<p class="empty">Couldn't load the season index (${esc(e.message)}). Run the pipeline to create data/seasons.json.</p>`;
    return;
  }
  const seasons = seasonsIndex.seasons || [];
  $('#season').innerHTML = seasons.map((s) => `<option value="${s}">${s}</option>`).join('');
  const wanted = Number(state.season);
  await selectSeason(seasons.includes(wanted) ? wanted : seasonsIndex.default ?? seasons[0]);
}

init();
