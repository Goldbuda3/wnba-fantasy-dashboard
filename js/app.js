import {
  PRESETS, DEFAULT_PRESET, STAT_LABELS, EDITABLE_STATS, makeScorer, presetStats,
  encodeCustom, decodeCustom, resetCustom,
} from './scoring.js';

const POS = ['G', 'F', 'C'];
const POS_COLS = [...POS, 'all'];
const POS_LABEL = { G: 'Guards', F: 'Forwards', C: 'Centers', all: 'All' };
const BREAKDOWN = ['fp', 'pts', 'reb', 'ast', 'tpm', 'stl', 'blk'];
const VIEWS = ['dvp', 'stats', 'team', 'adj', 'players'];
const PLAYER_KEYS = ['player', 'per', 'span', 'period', 'mingp', 'minmpg', 'cols', 'ppos'];
const NUMERIC = ['mingp', 'minmpg'];

// Everything here is mirrored in the URL so views can be bookmarked/shared.
const DEFAULTS = {
  season: null, view: 'dvp', score: DEFAULT_PRESET, pace: 'game', win: 'all', po: '0',
  team: null, pos: 'G', sort: null, dir: 'desc', cs: null,
  player: null, per: 'game', span: 'season', period: null, mingp: null, minmpg: null, cols: 'key',
  tpos: 'all', ppos: 'all',
};
const CUSTOM_STORE = 'wnba-dvp-custom-scoring';
const ALLOWED = {
  view: VIEWS, score: Object.keys(PRESETS), pace: ['game', '100'], win: ['all', '10', '5'],
  po: ['0', '1', '2'], pos: [...POS, 'all'], dir: ['asc', 'desc'],
  per: ['game', 'tot'], span: ['season', 'month', 'week'], cols: ['key', 'all'], tpos: ['all', ...POS], ppos: ['all', ...POS],
};

const state = { ...DEFAULTS };
let seasonsIndex = null;
let meta = {};
const cache = new Map();
let D = null; // prepared data for the selected season
const TOP_N = 5; // players shown per position in the team drill-down before "Show all"
const teamExpanded = new Set(); // positions expanded to the full list (reset when the team changes)
let expandedFor = null; // the team teamExpanded belongs to

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
    if (NUMERIC.includes(k) && !/^\d+(\.\d+)?$/.test(v)) continue;
    state[k] = v;
  }
  if (state.cs && !decodeCustom(state.cs)) state.cs = null;
}

function writeURL() {
  const q = new URLSearchParams();
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = state[k];
    if (v == null || (v === def && k !== 'season')) continue;
    if ((k === 'team' || k === 'tpos') && state.view !== 'team') continue;
    if (k === 'pos' && state.view !== 'stats') continue;
    if (k === 'cs' && state.score !== 'custom') continue;
    if (PLAYER_KEYS.includes(k) && state.view !== 'players') continue;
    if (k === 'period' && state.span === 'season') continue;
    q.set(k, v);
  }
  const s = q.toString().replace(/%2C/g, ','); // keep custom scoring readable: cs=pts1,reb1.2,...
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
  const rowsByPlayer = Array.from({ length: raw.players.id.length }, () => []);
  for (let i = 0; i < n; i++) { // rows are in game (date) order
    const g = R.g[i];
    opp[i] = G.home[g] === R.t[i] ? G.away[g] : G.home[g];
    pos[i] = raw.players.pos[R.p[i]];
    rowsByGame[g].push(i);
    rowsByPlayer[R.p[i]].push(i);
  }
  for (let g = 0; g < nGames; g++) { // games are sorted by date in the file
    teamGames[G.home[g]].push(g);
    teamGames[G.away[g]].push(g);
  }
  const hasPlayoffs = G.po.some((x) => x === 1);
  return { raw, R, G, n, nTeams, opp, pos, rowsByGame, rowsByPlayer, teamGames, hasPlayoffs, scoreKey: null };
}

const gameIncluded = (g) => (state.po === '1' ? true : state.po === '2' ? D.G.po[g] === 1 : D.G.po[g] === 0);
const paceOn = () => state.pace === '100';

// Fantasy points + each player's leave-one-out average (the "expected" line
// used for opponent adjustment) for the current preset and game type.
function ensureScores() {
  const key = `${state.score}|${state.score === 'custom' ? encodeCustom() : ''}|${state.po}`;
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

const posTag = (p) => `<span class="pos-tag">${esc(D.raw.players.pos[p] || '?')}</span>`;

function playerLink(p) {
  const id = D.raw.players.id[p];
  return `<a class="player-link" href="?${linkFor({ view: 'players', player: id })}" data-player="${esc(id)}">${esc(D.raw.players.name[p])}</a>`;
}

function linkFor(over) {
  const q = new URLSearchParams();
  const s = { ...state, ...over, sort: null, dir: 'desc' };
  for (const [k, def] of Object.entries(DEFAULTS)) if (s[k] != null && (s[k] !== def || k === 'season')) q.set(k, s[k]);
  return q.toString().replace(/%2C/g, ',');
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
  // The side profile (desktop) shows the chosen team, else the top row.
  const sel = rows.find((r) => teamAbbr(r.t) === state.team) || rows[0];
  return `
    <div class="view-head">
      <div>
        <h2>Fantasy points allowed by position</h2>
        <p>${esc(PRESETS[state.score].label)} points scored against each defense, ${rateLabel()}, ${windowLabel()}, ${typeLabel()}.
        Big number = average, small = median; ◆ marks teams where a few outlier games pull the average away from the median.</p>
      </div>
      ${legend()}
    </div>
    <div class="split">
      <div class="split-main">
        <div class="table-wrap"><table>
          <thead><tr>${sortHeader('team', 'Defense', 'l')}${POS_COLS.map((c) => sortHeader(c, POS_LABEL[c])).join('')}${sortHeader('games', 'GP')}</tr></thead>
          <tbody>${rows.map((r) => `<tr${r === sel ? ' class="selected"' : ''}>${teamCell(r.t)}${POS_COLS.map((c) => cell(r, c)).join('')}<td class="muted">${r.games}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="foot-note">“All” includes players without a listed position.
          <span class="desk-note">Click a team to see its profile.</span><span class="mob-note">Tap a team for its game-by-game drill-down.</span></p>
      </div>
      ${dvpPanel(sel, rows)}
    </div>`;
}

const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));

// Profile of one defense: each position's value, its rank, and a bar against
// the league average (the tick).
function dvpPanel(sel, rows) {
  const abbr = teamAbbr(sel.t);
  const rankOf = (c, v) => rows.filter((r) => r[c].avg > v).length + 1;
  const lines = POS_COLS.map((c) => {
    const v = sel[c].avg;
    if (Number.isNaN(v)) return `<div class="pline"><div class="pline-head"><b>${POS_LABEL[c]}</b><span class="pmeta">no data</span></div></div>`;
    const vals = rows.map((r) => r[c].avg).filter((x) => !Number.isNaN(x));
    const avg = mean(vals);
    const max = Math.max(...vals);
    const d = v - avg;
    return `<div class="pline">
      <div class="pline-head"><b>${POS_LABEL[c]}</b><span class="pv">${fmt(v)}</span>
        <span class="pmeta">${ordinal(rankOf(c, v))} softest · ${fmtSigned(d)} vs avg</span></div>
      <div class="pbar" title="League average ${fmt(avg)}"><span class="fill ${d >= 0 ? 'soft' : 'tough'}" style="width:${(100 * v / max).toFixed(1)}%"></span>
        <span class="tick" style="left:${(100 * avg / max).toFixed(1)}%"></span></div>
    </div>`;
  }).join('');
  const overall = Number.isNaN(sel.all.avg) ? '' : `${ordinal(rankOf('all', sel.all.avg))} softest of ${rows.length} overall · `;
  return `<aside class="dvp-panel" aria-label="Selected defense">
    <div>
      <span class="kicker">${esc(abbr)} defense</span>
      <h2>${esc(teamName(sel.t))}</h2>
      <p class="muted">${overall}${sel.games} games</p>
    </div>
    ${lines}
    <p class="foot-note">Bars: fantasy points allowed ${rateLabel()}; the tick marks the league average.</p>
    <a class="btn-link" href="?${linkFor({ view: 'team', team: abbr })}" data-team="${esc(abbr)}" data-open="1">Open game log →</a>
  </aside>`;
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
  if (expandedFor !== state.team) { teamExpanded.clear(); expandedFor = state.team; }
  const order = [...abbrs.keys()].sort((a, b) => teamName(a).localeCompare(teamName(b)));
  const picker = `<label><span>Defense</span><select id="team-select">${order
    .map((i) => `<option value="${esc(abbrs[i])}"${i === t ? ' selected' : ''}>${esc(teamName(i))}</option>`).join('')}</select></label>`;
  const games = windowGames(t);
  const posFilter = seg('tpos', 'Position', [['all', 'All'], ['G', 'Guards'], ['F', 'Forwards'], ['C', 'Centers']]);
  const head = `<div class="view-head"><div><h2>Who scored against the ${esc(teamName(t))}</h2>
    <p>${esc(PRESETS[state.score].label)} scoring · ${windowLabel().replace("each defense's", 'the')} · ${typeLabel()}.</p></div>
    <div class="view-tools">${picker}${posFilter}</div></div>`;
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
  const diffCell = (v) => `<td class="${v > 0 ? 'diff-pos' : v < 0 ? 'diff-neg' : ''}">${fmtSigned(v)}</td>`;
  const diffChip = (v) => (Number.isNaN(v) ? '<span class="muted">—</span>'
    : `<span class="diff-chip ${v >= 0 ? 'soft' : 'tough'}" style="--mix:${Math.round(15 + Math.min(Math.abs(v) / 20, 1) * 45)}%">${fmtSigned(v)}</span>`);

  // Where this defense ranks against each position, league-wide.
  const league = teamsWithGames().map((x) => defenseAgg(x, statFn('fp')));
  const rankChip = (c) => {
    const v = agg[c].avg;
    const vals = league.map((a) => a[c].avg).filter((x) => !Number.isNaN(x));
    if (Number.isNaN(v) || vals.length < 2) return '';
    const tough = vals.filter((x) => x < v).length + 1;
    const vs = `vs ${POS_LABEL[c].toLowerCase()}`;
    return tough <= Math.ceil(vals.length / 2)
      ? `<span class="rank-chip tough">${ordinal(tough)}-toughest ${vs}</span>`
      : `<span class="rank-chip soft">${ordinal(vals.filter((x) => x > v).length + 1)}-softest ${vs}</span>`;
  };

  // Players grouped by position: top 5 per group, expandable.
  const abbr = teamAbbr(t);
  const thead = `<thead><tr>${sortHeader('player', 'Player', 'l')}<th class="l">Team</th>${sortHeader('gp', 'GP')}${sortHeader('min', 'MIN')}${sortHeader('fp', `FP vs ${esc(abbr)}`)}${sortHeader('savg', 'Her avg')}${sortHeader('diff', '+/- avg')}</tr></thead>`;
  const rowHtml = (r) => `<tr><td>${playerLink(r.p)}</td><td class="l muted">${esc(teamAbbr(r.team))}</td><td class="muted">${r.gp}</td>
    <td class="muted">${fmt(r.minAvg)}</td><td><b>${fmt(r.fpAvg)}</b></td><td class="muted">${fmt(r.sAvg)}</td><td>${diffChip(r.dAvg)}</td></tr>`;
  const sections = [...POS, 'other'].filter((c) => state.tpos === 'all' || state.tpos === c).map((c) => {
    const rows = prow.filter((r) => (D.raw.players.pos[r.p] || 'other') === c);
    if (!rows.length) return '';
    const open = teamExpanded.has(c) || rows.length <= TOP_N;
    const title = c === 'other' ? 'Position not listed' : POS_LABEL[c];
    const context = c === 'other' ? '' : `<span class="muted">${esc(abbr)} allows <b>${fmt(agg[c].avg)}</b> FP ${rateLabel()}</span>${rankChip(c)}`;
    const more = rows.length > TOP_N
      ? `<div class="pos-foot"><button type="button" class="more-btn" data-expand="${c}">${teamExpanded.has(c) ? `Show top ${TOP_N}` : `Show all ${rows.length}${c === 'other' ? '' : ` ${title.toLowerCase()}`}`}</button></div>` : '';
    return `<section class="pos-section" aria-label="${esc(title)}">
      <div class="pos-head"><h3>${title}</h3>${context}<span class="count">${open ? `${rows.length} player${rows.length === 1 ? '' : 's'}` : `Top ${TOP_N} of ${rows.length}`}</span></div>
      <div class="table-wrap flat"><table>${thead}<tbody>${(open ? rows : rows.slice(0, TOP_N)).map(rowHtml).join('')}</tbody></table></div>${more}
    </section>`;
  }).join('');

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
    return head + rows.map((i) => `<tr><td>${playerLink(R.p[i])}</td><td class="l">${posTag(R.p[i])}</td>
      ${statCols.map((s) => `<td${s === 'min' ? '' : ' class="muted"'}>${s === 'min' ? fmt(R.min[i]) : (R[s][i] ?? '—')}</td>`).join('')}
      <td><b>${fmt(fp[i])}</b></td><td class="muted">${fmt(base[i])}</td>${diffCell(fp[i] - base[i])}</tr>`).join('');
  }).join('');
  const logTable = `<div class="table-wrap"><table>
    <thead><tr><th class="l">Player</th><th class="l">Pos</th>${statCols.map((s) => `<th>${s === 'min' ? 'MIN' : STAT_LABELS[s]}</th>`).join('')}<th>FP</th><th>Her avg</th><th>+/-</th></tr></thead>
    <tbody>${logRows}</tbody></table></div>`;

  return `${head}
    <div class="summary">${tiles}<div class="tile"><div class="k">Games</div><div class="big">${games.length}</div><div class="sub">${typeLabel()}</div></div></div>
    <h3>Players vs ${esc(abbr)}</h3>${sections}
    <p class="foot-note">Raw per-game numbers. “Her avg” is her ${typeLabel()} average; “+/- avg” compares each game with her average in her other games.</p>
    <h3>Game log</h3>${logTable}`;
}

// ------------------------------------------------------------------ player stats

const P_STATS = ['min', 'pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'tov', 'pf'];
const SUM_KEYS = [...P_STATS, 'fgm', 'fga', 'ftm', 'fta', 'tpa'];
const COL_LABEL = { min: 'MIN', stk: 'Stocks', pf: 'PF', fgp: 'FG%', tpp: '3P%', ftp: 'FT%', fp: 'FP' };
// Shooting percentages: [made, attempted]. Log columns show them as made-attempted.
const PCT = { fgp: ['fgm', 'fga'], tpp: ['tpm', 'tpa'], ftp: ['ftm', 'fta'] };
const PCT_LOG_LABEL = { fgp: 'FG', tpp: '3P', ftp: 'FT' };
const SPAN_LABEL = { season: 'Season', month: 'Month', week: 'Week' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let playerQuery = ''; // search box text; filters rows in place so typing keeps focus

const isoDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (iso, n) => new Date(isoDate(iso).getTime() + n * 864e5).toISOString().slice(0, 10);
const shortDay = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1].slice(0, 3)} ${Number(iso.slice(8, 10))}`;

// Weeks run Monday-Sunday and are keyed by their Monday; months by YYYY-MM.
const PERIOD = {
  week: {
    key: (iso) => addDays(iso, -((isoDate(iso).getUTCDay() + 6) % 7)),
    label: (k) => `${shortDay(k)} – ${shortDay(addDays(k, 6))}`,
  },
  month: { key: (iso) => iso.slice(0, 7), label: (k) => MONTHS[Number(k.slice(5, 7)) - 1] },
};

function playerCols() {
  const cov = D.raw.coverage.stats;
  const has = (s) => D.R[s] && cov[s] !== false; // files written before a stat was added lack its column
  const cols = P_STATS.filter(has);
  if (cols.includes('stl') && cols.includes('blk')) cols.splice(cols.indexOf('blk') + 1, 0, 'stk');
  for (const [c, [m, a]] of Object.entries(PCT)) if (has(m) && has(a)) cols.push(c);
  return [...cols, 'fp'];
}

// A running stat line: sums plus how many games recorded each stat.
function newLine() {
  return { gp: 0, fp: 0, sum: Object.fromEntries(SUM_KEYS.map((k) => [k, 0])), n: Object.fromEntries(SUM_KEYS.map((k) => [k, 0])) };
}

function addToLine(e, i) {
  e.gp++;
  e.fp += D.fp[i];
  for (const k of SUM_KEYS) {
    const v = D.R[k]?.[i];
    if (v != null) { e.sum[k] += v; e.n[k]++; }
  }
}

const totalsOn = () => state.per === 'tot';

function lineVal(e, c) {
  if (c === 'fp') return totalsOn() ? e.fp : e.fp / e.gp;
  if (PCT[c]) {
    const [m, a] = PCT[c];
    return e.sum[a] ? (100 * e.sum[m]) / e.sum[a] : NaN;
  }
  if (c === 'stk') return lineVal(e, 'stl') + lineVal(e, 'blk'); // "stocks" = steals + blocks
  if (!e.n[c]) return NaN;
  return totalsOn() ? e.sum[c] : e.sum[c] / e.n[c];
}

function lineCells(e, cols) {
  return cols.map((c) => {
    const v = fmt(lineVal(e, c), totalsOn() && c !== 'fp' && !PCT[c] ? 0 : 1);
    return c === 'fp' ? `<td><b>${v}</b></td>` : `<td>${v}</td>`;
  }).join('');
}

const colLabel = (c) => COL_LABEL[c] || STAT_LABELS[c];

// Player-list column groups. `all: true` groups and `allOnly` columns appear
// only with "All stats"; Essentials keeps the list to the columns most people scan.
const PLAYER_GROUPS = [
  { label: 'Fantasy', cols: ['fp'] },
  { label: 'Usage', cols: ['gp', 'min'] },
  { label: 'Scoring', cols: ['pts', 'tpm'] },
  { label: 'Boards & dimes', cols: ['reb', 'ast'] },
  { label: 'Defense', cols: ['stl', 'blk', 'stk'], allOnly: ['stl', 'blk'] },
  { label: 'Mistakes', cols: ['tov', 'pf'], all: true },
  { label: 'Shooting %', cols: ['fgp', 'tpp', 'ftp'], all: true },
];

function playerGroups() {
  const avail = new Set([...playerCols(), 'gp']);
  const all = state.cols === 'all';
  return PLAYER_GROUPS.filter((g) => all || !g.all)
    .map((g) => ({ label: g.label, cols: g.cols.filter((c) => avail.has(c) && (all || !g.allOnly?.includes(c))) }))
    .filter((g) => g.cols.length);
}

function seg(key, label, opts) {
  return `<div class="seg" role="group" aria-label="${label}"><span>${label}</span><div>${opts
    .map(([v, t]) => `<button type="button" data-key="${key}" data-val="${v}" aria-pressed="${state[key] === v}">${t}</button>`).join('')}</div></div>`;
}

const perSeg = () => seg('per', 'Show', [['game', 'Per game'], ['tot', 'Totals']]);

// Period keys that have games under the current game-type filter, newest first.
function periodKeys(span) {
  const keys = new Set();
  for (let g = D.G.id.length - 1; g >= 0; g--) if (gameIncluded(g)) keys.add(PERIOD[span].key(D.G.date[g]));
  return [...keys];
}

function viewPlayers() {
  const p = state.player == null ? -1 : D.raw.players.id.indexOf(state.player);
  if (p >= 0) return viewPlayer(p);
  state.player = null;
  return viewPlayerList();
}

function viewPlayerList() {
  const { span } = state;
  const keys = span === 'season' ? [] : periodKeys(span);
  const period = span === 'season' ? null : (keys.includes(state.period) ? state.period : keys[0] ?? null);
  state.period = period;
  const inSpan = D.G.id.map((_, g) => gameIncluded(g) && (!period || PERIOD[span].key(D.G.date[g]) === period));

  const lines = new Map();
  for (let i = 0; i < D.n; i++) {
    if (!inSpan[D.R.g[i]]) continue;
    const p = D.R.p[i];
    if (!lines.has(p)) lines.set(p, { p, e: newLine() });
    const r = lines.get(p);
    addToLine(r.e, i);
    r.team = D.R.t[i]; // ends on her latest team in the period
  }

  const periodPick = span === 'season' ? '' : `<label><span>${SPAN_LABEL[span]}</span><select id="period-select">${keys
    .map((k) => `<option value="${k}"${k === period ? ' selected' : ''}>${esc(PERIOD[span].label(k))}</option>`).join('')}</select></label>`;
  const search = `<label><span>Find</span><input type="search" id="player-search" placeholder="Player or team" autocomplete="off" value="${esc(playerQuery)}"></label>`;
  const minBox = (id, key, label, step) => `<label class="min-box"><span>${label}</span><input type="number" id="${id}" data-min="${key}" min="0" step="${step}" inputmode="decimal" placeholder="Any" value="${esc(state[key] ?? '')}"></label>`;
  const mins = minBox('min-gp', 'mingp', 'Min GP', 1) + (playerCols().includes('min') ? minBox('min-mpg', 'minmpg', 'Min MPG', 1) : '');
  const colsSeg = seg('cols', 'Columns', [['key', 'Essentials'], ['all', 'All stats']]);
  const posSeg = seg('ppos', 'Position', [['all', 'All'], ...POS.map((p) => [p, p])]);
  const tools = `<div class="view-tools">${perSeg()}${seg('span', 'Period', [['season', 'Season'], ['month', 'Month'], ['week', 'Week']])}${periodPick}${colsSeg}${posSeg}${mins}${search}</div>`;
  const what = period ? (span === 'week' ? `week of ${PERIOD.week.label(period)}` : PERIOD.month.label(period)) : 'full season';
  const head = `<div class="view-head"><div><h2>Player stats</h2>
    <p>${totalsOn() ? 'Totals' : 'Per-game averages'} · ${esc(what)} · ${typeLabel()} · ${esc(PRESETS[state.score].label)} fantasy points.
    Weeks run Monday–Sunday. Click a player for her week-by-week and month-by-month splits.</p></div>${tools}</div>`;
  if (!lines.size) return head + emptyMsg();

  const getters = { player: (r) => D.raw.players.name[r.p], team: (r) => teamAbbr(r.team), gp: (r) => r.e.gp };
  for (const c of playerCols()) getters[c] = (r) => lineVal(r.e, c);
  const rows = sortRows([...lines.values()], getters, 'fp');
  const groups = playerGroups();
  const flat = groups.flatMap((g) => g.cols.map((c, j) => ({ c, start: j === 0 })));
  const cell = (r, { c, start }) => {
    const cls = [start ? 'gs' : '', c === 'fp' ? 'lead' : ''].filter(Boolean).join(' ');
    const v = c === 'gp' ? String(r.e.gp) : fmt(lineVal(r.e, c), totalsOn() && c !== 'fp' && !PCT[c] ? 0 : 1);
    return `<td${cls ? ` class="${cls}"` : ''}>${v}</td>`;
  };
  const rowspan = (th) => th.replace('<th ', '<th rowspan="2" ');
  return `${head}<div class="table-wrap"><table class="grouped">
    <thead>
      <tr>${rowspan(sortHeader('player', 'Player', 'l'))}<th rowspan="2" class="l">Pos</th>${rowspan(sortHeader('team', 'Team', 'l'))}
        ${groups.map((g) => `<th colspan="${g.cols.length}" class="grp">${g.label}</th>`).join('')}</tr>
      <tr>${flat.map(({ c, start }) => sortHeader(c, c === 'gp' ? 'GP' : colLabel(c), start ? 'gs' : '')).join('')}</tr>
    </thead>
    <tbody>${rows.map((r) => `<tr data-find="${esc(`${D.raw.players.name[r.p]} ${teamAbbr(r.team)} ${teamName(r.team)}`.toLowerCase())}" data-gp="${r.e.gp}" data-mpg="${r.e.n.min ? r.e.sum.min / r.e.n.min : ''}" data-pos="${esc(D.raw.players.pos[r.p] || '')}">
      <td>${playerLink(r.p)}</td><td class="l">${posTag(r.p)}</td><td class="l muted">${esc(teamAbbr(r.team))}</td>${flat.map((f) => cell(r, f)).join('')}</tr>`).join('')}</tbody>
  </table></div>
  <p class="empty" id="player-none" hidden>No players match these filters.</p>
  <p class="foot-note" id="player-count"></p>`;
}

function splitTable(rows, span, cols, season) {
  const groups = new Map(); // insertion order = chronological
  for (const i of rows) {
    const k = PERIOD[span].key(D.G.date[D.R.g[i]]);
    if (!groups.has(k)) groups.set(k, newLine());
    addToLine(groups.get(k), i);
  }
  return `<div class="table-wrap"><table>
    <thead><tr><th class="l">${SPAN_LABEL[span]}</th><th>GP</th>${cols.map((c) => `<th>${colLabel(c)}</th>`).join('')}</tr></thead>
    <tbody>${[...groups].map(([k, e]) => `<tr><td>${esc(PERIOD[span].label(k))}</td><td>${e.gp}</td>${lineCells(e, cols)}</tr>`).join('')}</tbody>
    <tfoot><tr><td>Season</td><td>${season.gp}</td>${lineCells(season, cols)}</tr></tfoot>
  </table></div>`;
}

function viewPlayer(p) {
  const { R, G } = D;
  const rows = D.rowsByPlayer[p].filter((i) => gameIncluded(R.g[i]));
  const cols = playerCols();
  const teams = [...new Set(rows.map((i) => R.t[i]))].map(teamAbbr).join(' → ');
  const back = `<a class="back-link" href="?${linkFor({ view: 'players', player: null })}" data-player="">← All players</a>`;
  const head = `${back}<div class="view-head"><div><h2>${esc(D.raw.players.name[p])} ${posTag(p)}</h2>
    <p>${teams ? `${esc(teams)} · ` : ''}${esc(PRESETS[state.score].label)} scoring · ${typeLabel()}. Weeks run Monday–Sunday.</p></div>
    <div class="view-tools">${perSeg()}</div></div>`;
  if (!rows.length) return head + emptyMsg();

  const season = newLine();
  for (const i of rows) addToLine(season, i);
  const tile = (c) => {
    const tot = c === 'fp' ? season.fp : season.sum[c];
    const avg = c === 'fp' ? season.fp / season.gp : (season.n[c] ? season.sum[c] / season.n[c] : NaN);
    return `<div class="tile"><div class="k">${colLabel(c)} / game</div><div class="big">${fmt(avg)}</div>
      <div class="sub">season total ${fmt(tot, c === 'fp' ? 1 : 0)}</div></div>`;
  };
  const tiles = `<div class="tile"><div class="k">Games</div><div class="big">${season.gp}</div><div class="sub">${typeLabel()}</div></div>`
    + ['fp', 'min', 'pts', 'reb', 'ast'].filter((c) => cols.includes(c)).map(tile).join('');

  const logCell = (i, c) => {
    if (c === 'fp') return `<td><b>${fmt(D.fp[i])}</b></td>`;
    if (c === 'min') return `<td>${fmt(R.min[i])}</td>`;
    if (c === 'stk') return `<td>${R.stl[i] == null || R.blk[i] == null ? '—' : R.stl[i] + R.blk[i]}</td>`;
    if (PCT[c]) {
      const [m, a] = PCT[c];
      return `<td class="muted">${R[m][i] ?? '—'}-${R[a][i] ?? '—'}</td>`;
    }
    return `<td>${R[c][i] ?? '—'}</td>`;
  };
  const logRows = [...rows].reverse().map((i) => {
    const g = R.g[i];
    const day = WEEKDAYS[isoDate(G.date[g]).getUTCDay()];
    return `<tr><td>${day} ${esc(shortDay(G.date[g]))}</td><td class="l">${G.home[g] === R.t[i] ? 'vs' : '@'} ${esc(teamAbbr(D.opp[i]))}${G.po[g] ? ' <small class="muted">Playoffs</small>' : ''}</td>
      ${cols.map((c) => logCell(i, c)).join('')}</tr>`;
  }).join('');
  const logTable = `<div class="table-wrap"><table>
    <thead><tr><th class="l">Date</th><th class="l">Opp</th>${cols.map((c) => `<th>${PCT_LOG_LABEL[c] || colLabel(c)}</th>`).join('')}</tr></thead>
    <tbody>${logRows}</tbody></table></div>`;

  return `${head}<div class="summary">${tiles}</div>
    <h3>By week</h3>${splitTable(rows, 'week', cols, season)}
    <h3>By month</h3>${splitTable(rows, 'month', cols, season)}
    <p class="foot-note">${totalsOn() ? 'Totals' : 'Per-game averages'} for each period; the last row is her full ${typeLabel()}. Shooting percentages are made ÷ attempted over the period.</p>
    <h3>Game log</h3>${logTable}`;
}

// Search and minimums hide rows in place, so typing doesn't rebuild the table
// (and steal focus from the box).
function applyPlayerFilters() {
  const q = playerQuery.trim().toLowerCase();
  const minGp = Number(state.mingp) || 0;
  const minMpg = Number(state.minmpg) || 0;
  const trs = document.querySelectorAll('tr[data-find]');
  let shown = 0;
  trs.forEach((tr) => {
    const mpg = tr.dataset.mpg === '' ? NaN : Number(tr.dataset.mpg);
    tr.hidden = (q && !tr.dataset.find.includes(q)) || Number(tr.dataset.gp) < minGp || (minMpg > 0 && !(mpg >= minMpg))
      || (state.ppos !== 'all' && tr.dataset.pos !== state.ppos);
    if (!tr.hidden) shown++;
    tr.classList.toggle('alt', !tr.hidden && shown % 2 === 0); // stripe visible rows only
  });
  const none = $('#player-none');
  if (none) none.hidden = shown > 0 || !trs.length;
  const count = $('#player-count');
  if (count) count.textContent = shown < trs.length ? `Showing ${shown} of ${trs.length} players.` : '';
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

// ------------------------------------------------------------------ custom scoring

const CUSTOM_FIELDS = [...EDITABLE_STATS.map((k) => [k, STAT_LABELS[k]]), ['dd', 'DD bonus'], ['td', 'TD bonus']];

function buildCustomEditor() {
  $('#custom-grid').innerHTML = CUSTOM_FIELDS.map(([k, label]) => `<label><span>${esc(label)}</span>`
    + `<input type="number" step="0.05" inputmode="decimal" data-custom="${k}" aria-label="${esc(label)} points"></label>`).join('');
  fillCustomEditor();
}

function fillCustomEditor() {
  const { values, bonus } = PRESETS.custom;
  document.querySelectorAll('#custom-grid input').forEach((el) => {
    const k = el.dataset.custom;
    el.value = String((k === 'dd' || k === 'td' ? bonus[k] : values[k]) || 0);
  });
}

function saveCustom() {
  try { localStorage.setItem(CUSTOM_STORE, encodeCustom()); } catch { /* storage unavailable */ }
}

function loadSavedCustom() {
  try {
    const saved = localStorage.getItem(CUSTOM_STORE);
    if (saved) decodeCustom(saved);
  } catch { /* storage unavailable */ }
}

function onCustomInput(el) {
  const k = el.dataset.custom;
  const v = el.value.trim() === '' ? 0 : Number(el.value);
  if (!Number.isFinite(v)) return;
  if (k === 'dd' || k === 'td') PRESETS.custom.bonus[k] = v;
  else PRESETS.custom.values[k] = v;
  saveCustom();
  render();
}

function renderControls() {
  const custom = state.score === 'custom';
  $('#custom-scoring').hidden = !custom;
  state.cs = custom ? encodeCustom() : null;
  document.querySelectorAll('.controls .seg button').forEach((b) => b.setAttribute('aria-pressed', String(state[b.dataset.key] === b.dataset.val)));
  const noPoss = D && D.raw.coverage.possessions === 0;
  const pace100 = document.querySelector('[data-key="pace"][data-val="100"]');
  pace100.disabled = noPoss;
  pace100.title = noPoss ? 'No possession data for this season' : '';
  // Rate and window describe defenses; player stats ignore them.
  document.querySelectorAll('[data-defense-only]').forEach((el) => { el.hidden = state.view === 'players'; });
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
  document.querySelectorAll('.bottom-nav button').forEach((b) => {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.season-select').forEach((s) => { s.value = String(state.season); });
  $('#score').value = state.score;
  // Mobile filter button: one line naming the active filters.
  const picked = [...document.querySelectorAll('.controls .seg:not([hidden]) button[aria-pressed="true"]')].map((b) => b.textContent);
  $('#filter-summary').textContent = [PRESETS[state.score].label.split(' (')[0], ...picked].join(' · ');
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
  const views = { dvp: viewDvp, stats: viewStats, team: viewTeam, adj: viewAdj, players: viewPlayers };
  $('#main').innerHTML = views[state.view]();
  if (state.view === 'players') applyPlayerFilters();
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

// ------------------------------------------------------------------ theme + mobile sheet

const THEME_STORE = 'wnba-theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const wideQuery = window.matchMedia('(min-width: 721px)'); // matches the CSS mobile breakpoint
const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light')) === 'dark';

function syncThemeButton() {
  $('#theme-toggle').setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
}

function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_STORE, next); } catch { /* storage unavailable */ }
  syncThemeButton();
}

function setSheet(open) {
  document.body.classList.toggle('sheet-open', open);
  $('#sheet-backdrop').hidden = !open;
  $('#filter-open').setAttribute('aria-expanded', String(open));
  if (open) $('#controls').focus();
  else if (!wideQuery.matches) $('#filter-open').focus();
}

function bind() {
  document.querySelectorAll('.season-select').forEach((s) => s.addEventListener('change', (e) => { state.sort = null; selectSeason(e.target.value); }));
  $('#theme-toggle').addEventListener('click', toggleTheme);
  darkQuery.addEventListener('change', syncThemeButton);
  syncThemeButton();
  $('#filter-open').addEventListener('click', () => setSheet(true));
  $('#filter-done').addEventListener('click', () => setSheet(false));
  $('#sheet-backdrop').addEventListener('click', () => setSheet(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('sheet-open')) setSheet(false); });
  wideQuery.addEventListener('change', () => { if (wideQuery.matches) setSheet(false); });
  $('#score').addEventListener('change', (e) => { state.score = e.target.value; render(); });
  $('#custom-grid').addEventListener('input', (e) => { if (e.target.dataset.custom) onCustomInput(e.target); });
  $('#custom-reset').addEventListener('click', () => { resetCustom(); fillCustomEditor(); saveCustom(); render(); });
  document.addEventListener('click', (e) => {
    const seg = e.target.closest('.seg button[data-key]');
    if (seg) {
      state[seg.dataset.key] = seg.dataset.val;
      if (seg.dataset.key === 'span') state.period = null;
      render();
      return;
    }
    const tab = e.target.closest('.tabs button[data-view], .bottom-nav button[data-view]');
    if (tab) {
      if (tab.dataset.view === 'players') state.player = null; // the tab always opens the full list
      if (state.view !== tab.dataset.view) { state.view = tab.dataset.view; state.sort = null; state.dir = 'desc'; }
      render();
      if (tab.closest('.bottom-nav')) window.scrollTo({ top: 0 });
      return;
    }
    const expand = e.target.closest('button[data-expand]');
    if (expand) {
      const c = expand.dataset.expand;
      if (teamExpanded.has(c)) teamExpanded.delete(c); else teamExpanded.add(c);
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
    const plink = e.target.closest('a[data-player]');
    if (plink && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      Object.assign(state, { view: 'players', player: plink.dataset.player || null, sort: null, dir: 'desc' });
      render();
      window.scrollTo({ top: 0 });
      return;
    }
    const link = e.target.closest('a[data-team]');
    if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      // Desktop DvP: a team click fills the side profile instead of leaving the table.
      if (state.view === 'dvp' && wideQuery.matches && !link.dataset.open) {
        state.team = link.dataset.team;
        render();
        return;
      }
      Object.assign(state, { view: 'team', team: link.dataset.team, sort: null, dir: 'desc' });
      render();
      window.scrollTo({ top: 0 });
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'team-select') { state.team = e.target.value; render(); }
    if (e.target.id === 'period-select') { state.period = e.target.value; render(); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'player-search') { playerQuery = e.target.value; applyPlayerFilters(); }
    const key = e.target.dataset?.min;
    if (key) {
      const v = e.target.value.trim();
      state[key] = /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? v : null;
      applyPlayerFilters();
      writeURL();
    }
  });
}

async function init() {
  readURL();
  if (!state.cs) loadSavedCustom(); // a shared link's values win over saved ones
  $('#score').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
  buildCustomEditor();
  bind();
  try {
    [seasonsIndex, meta] = await Promise.all([getJSON('data/seasons.json'), getJSON('data/meta.json').catch(() => ({}))]);
  } catch (e) {
    $('#main').innerHTML = `<p class="empty">Couldn't load the season index (${esc(e.message)}). Run the pipeline to create data/seasons.json.</p>`;
    return;
  }
  const seasons = seasonsIndex.seasons || [];
  document.querySelectorAll('.season-select').forEach((s) => { s.innerHTML = seasons.map((y) => `<option value="${y}">${y}</option>`).join(''); });
  const wanted = Number(state.season);
  await selectSeason(seasons.includes(wanted) ? wanted : seasonsIndex.default ?? seasons[0]);
}

init();
