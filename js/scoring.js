// Fantasy scoring presets. Values are points per stat; every number in the
// dashboard is recomputed from raw box-score stats with the selected preset.
//
// Stat keys (match the season JSON files):
//   pts reb ast stl blk tov tpm (3-pointers made) fgm fga ftm fta
//
// To change a preset, edit its `values` / `bonus`. To add one, add a new key
// above `custom`; it shows up in the scoring dropdown automatically.
//
// bonus: { dd, td, cats, stack }
//   dd    points for a double-double (10+ in two of `cats`)
//   td    points for a triple-double (10+ in three of `cats`)
//   stack true = a triple-double also earns the double-double bonus

export const STAT_LABELS = {
  pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', tov: 'TOV',
  tpm: '3PM', fgm: 'FGM', fga: 'FGA', ftm: 'FTM', fta: 'FTA',
};

export const PRESETS = {
  standard: {
    label: 'Standard points (ESPN default)',
    // ESPN's default points-league scoring (verified 2026-10-03):
    // https://www.espn.com/fantasy/basketball/story/_/id/30296896/espn-fantasy-default-points-league-scoring-explained
    values: { pts: 1, tpm: 1, fgm: 2, fga: -1, ftm: 1, fta: -1, reb: 1, ast: 2, stl: 3, blk: 3, tov: -1 },
    bonus: { dd: 3, td: 5, cats: ['pts', 'reb', 'ast', 'blk', 'stl'], stack: true },
  },
};

// "Custom" lets visitors type their own values in the dashboard. It starts from
// the ESPN standard values; edits are saved in the URL (shareable) and in the
// browser. Bonus defaults to 0 (off).
PRESETS.custom = {
  label: 'Custom',
  values: { ...PRESETS.standard.values },
  bonus: { dd: 0, td: 0, cats: ['pts', 'reb', 'ast', 'blk', 'stl'], stack: true },
};

export const DEFAULT_PRESET = 'standard';

// Stats shown in the custom editor, in display order.
export const EDITABLE_STATS = ['pts', 'tpm', 'fgm', 'fga', 'ftm', 'fta', 'reb', 'ast', 'stl', 'blk', 'tov'];

export function resetCustom() {
  PRESETS.custom.values = { ...PRESETS.standard.values };
  PRESETS.custom.bonus.dd = 0;
  PRESETS.custom.bonus.td = 0;
}

// Compact text form for the URL / storage, e.g. "pts1,reb1.25,tov-2,dd1.5".
// Only non-zero values are written; anything not listed is 0.
export function encodeCustom() {
  const { values, bonus } = PRESETS.custom;
  const parts = EDITABLE_STATS.filter((k) => values[k]).map((k) => `${k}${values[k]}`);
  if (bonus.dd) parts.push(`dd${bonus.dd}`);
  if (bonus.td) parts.push(`td${bonus.td}`);
  return parts.join(',') || 'none';
}

// Returns false (and leaves the preset unchanged) if the text is invalid.
export function decodeCustom(text) {
  if (!text) return false;
  const values = {};
  const bonus = { dd: 0, td: 0 };
  if (text !== 'none') {
    for (const part of text.split(',')) {
      const m = /^([a-z]+)(-?\d+(?:\.\d+)?)$/.exec(part.trim());
      if (!m) return false;
      const [, k, v] = m;
      if (k === 'dd' || k === 'td') bonus[k] = Number(v);
      else if (EDITABLE_STATS.includes(k)) values[k] = Number(v);
      else return false;
    }
  }
  PRESETS.custom.values = values;
  Object.assign(PRESETS.custom.bonus, bonus);
  return true;
}

// Returns a function (stats getter, row index) -> fantasy points.
// `cols` is the season file's `rows` object (columnar arrays).
export function makeScorer(presetKey, cols) {
  const preset = PRESETS[presetKey] || PRESETS[DEFAULT_PRESET];
  const entries = Object.entries(preset.values).filter(([k]) => cols[k]);
  const b = preset.bonus && (preset.bonus.dd || preset.bonus.td) ? preset.bonus : null;
  return (i) => {
    let fp = 0;
    for (const [k, v] of entries) fp += (cols[k][i] || 0) * v;
    if (b) {
      let tens = 0;
      for (const k of b.cats) if ((cols[k]?.[i] || 0) >= 10) tens++;
      if (tens >= 3) fp += b.td + (b.stack ? b.dd : 0);
      else if (tens === 2) fp += b.dd;
    }
    return fp;
  };
}

// Stats a preset depends on, so the UI can flag ones a season lacks.
export function presetStats(presetKey) {
  const p = PRESETS[presetKey] || PRESETS[DEFAULT_PRESET];
  const bonusOn = p.bonus && (p.bonus.dd || p.bonus.td);
  return [...new Set([...Object.keys(p.values).filter((k) => p.values[k]), ...(bonusOn ? p.bonus.cats : [])])];
}
