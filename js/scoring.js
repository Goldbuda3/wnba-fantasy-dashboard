// Fantasy scoring presets. Values are points per stat; every number in the
// dashboard is recomputed from raw box-score stats with the selected preset.
//
// Stat keys (match the season JSON files):
//   pts reb ast stl blk tov tpm (3-pointers made) fgm fga ftm fta
//
// To change a preset, edit its `values` / `bonus`. To add one, add a new key;
// it shows up in the scoring dropdown automatically.
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
    values: { pts: 1, tpm: 1, fgm: 2, fga: -1, ftm: 1, fta: -1, reb: 1, ast: 2, stl: 4, blk: 4, tov: -2 },
    bonus: null,
  },
  draftkings: {
    label: 'DraftKings',
    // DraftKings WNBA Classic (verified 2026-10-03 against DraftKings' WNBA scoring
    // summary and RotoWire/RotoGrinders DFS guides; draftkings.com/help/rules/wnba).
    // Double-double/triple-double count PTS, REB, AST, BLK, STL.
    values: { pts: 1, tpm: 0.5, reb: 1.25, ast: 1.5, stl: 2, blk: 2, tov: -0.5 },
    bonus: { dd: 1.5, td: 3, cats: ['pts', 'reb', 'ast', 'blk', 'stl'], stack: true },
  },
  fanduel: {
    label: 'FanDuel',
    // FanDuel WNBA (verified 2026-10-03; same scoring as FanDuel NBA, no bonuses):
    // https://www.fanduel.com/fantasy-wnba?t=rules
    values: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, tov: -1 },
    bonus: null,
  },
};

export const DEFAULT_PRESET = 'draftkings';

// Returns a function (stats getter, row index) -> fantasy points.
// `cols` is the season file's `rows` object (columnar arrays).
export function makeScorer(presetKey, cols) {
  const preset = PRESETS[presetKey] || PRESETS[DEFAULT_PRESET];
  const entries = Object.entries(preset.values).filter(([k]) => cols[k]);
  const b = preset.bonus;
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
  return [...new Set([...Object.keys(p.values), ...(p.bonus ? p.bonus.cats : [])])];
}
