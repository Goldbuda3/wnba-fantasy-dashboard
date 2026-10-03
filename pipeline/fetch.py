"""Fetch WNBA player box scores and write one compact JSON file per season.

Usage:
    python pipeline/fetch.py                       # seasons from pipeline/config.json
    python pipeline/fetch.py --seasons 2022-2026   # a range
    python pipeline/fetch.py --seasons 2024,2026   # a list
    python pipeline/fetch.py --seasons 2025 --force

Output (in ./data):
    <season>.json   columnar player-game rows + teams/players/games tables
    seasons.json    index of available seasons
    meta.json       last-updated timestamp and summary per season

Raw stats only. Fantasy points are computed in the browser.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
import warnings
from pathlib import Path

import pandas as pd

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CONFIG = json.loads((Path(__file__).parent / "config.json").read_text())
POSITION_MAP = {
    k.upper(): v
    for k, v in json.loads((Path(__file__).parent / "positions.json").read_text()).items()
    if not k.startswith("_")
}

# Standard column -> raw stat columns written to the season file, in order.
STAT_COLS = ["min", "pts", "reb", "ast", "stl", "blk", "tov", "tpm", "fgm", "fga", "ftm", "fta"]
REQUIRED_STATS = ["pts", "reb", "ast", "stl", "blk", "tov"]


class ValidationError(Exception):
    pass


# --------------------------------------------------------------------------- seasons

def current_season() -> int:
    return CONFIG.get("current_season") or dt.date.today().year


def parse_seasons(spec: str) -> list[int]:
    spec = (spec or "").strip().lower()
    cur = current_season()
    if spec in ("", "last5"):
        return list(range(cur - 4, cur + 1))
    seasons: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = (int(x) for x in part.split("-", 1))
            seasons.update(range(min(a, b), max(a, b) + 1))
        else:
            seasons.add(int(part))
    lo = CONFIG.get("earliest_season", 2002)
    bad = sorted(s for s in seasons if s < lo or s > cur)
    if bad:
        raise SystemExit(f"Seasons out of range ({lo}-{cur}): {bad}")
    return sorted(seasons)


# --------------------------------------------------------------------------- sources

def _col(df: pd.DataFrame, name: str):
    """Column as a Series, or an all-NA Series when the source lacks it (older seasons)."""
    if name in df.columns:
        return df[name]
    return pd.Series([pd.NA] * len(df), index=df.index)


def load_sportsdataverse(season: int) -> tuple[pd.DataFrame, pd.DataFrame | None]:
    import sportsdataverse.wnba as wnba

    raw = wnba.load_wnba_player_boxscore(seasons=[season], return_as_pandas=True)
    if raw is None or len(raw) == 0:
        raise RuntimeError(f"sportsdataverse returned no player rows for {season}")

    p = pd.DataFrame({
        "game_id": _col(raw, "game_id").astype(str),
        "date": pd.to_datetime(_col(raw, "game_date"), errors="coerce").dt.strftime("%Y-%m-%d"),
        "season_type": pd.to_numeric(_col(raw, "season_type"), errors="coerce"),
        "team_id": _col(raw, "team_id").astype(str),
        "team_abbr": _col(raw, "team_abbreviation"),
        "team_name": _col(raw, "team_display_name"),
        "opp_id": _col(raw, "opponent_team_id").astype(str),
        "home_away": _col(raw, "home_away"),
        "athlete_id": _col(raw, "athlete_id").astype(str),
        "name": _col(raw, "athlete_display_name"),
        "pos_raw": _col(raw, "athlete_position_abbreviation"),
        "dnp": _col(raw, "did_not_play"),
        "min": _col(raw, "minutes"),
        "pts": _col(raw, "points"),
        "reb": _col(raw, "rebounds"),
        "oreb": _col(raw, "offensive_rebounds"),
        "ast": _col(raw, "assists"),
        "stl": _col(raw, "steals"),
        "blk": _col(raw, "blocks"),
        "tov": _col(raw, "turnovers"),
        "tpm": _col(raw, "three_point_field_goals_made"),
        "fgm": _col(raw, "field_goals_made"),
        "fga": _col(raw, "field_goals_attempted"),
        "ftm": _col(raw, "free_throws_made"),
        "fta": _col(raw, "free_throws_attempted"),
    })

    team = None
    try:
        tb = wnba.load_wnba_team_boxscore(seasons=[season], return_as_pandas=True)
        if tb is not None and len(tb):
            tov = _col(tb, "total_turnovers")
            if tov.isna().all():
                tov = _col(tb, "turnovers")
            team = pd.DataFrame({
                "game_id": _col(tb, "game_id").astype(str),
                "team_id": _col(tb, "team_id").astype(str),
                "fga": pd.to_numeric(_col(tb, "field_goals_attempted"), errors="coerce"),
                "oreb": pd.to_numeric(_col(tb, "offensive_rebounds"), errors="coerce"),
                "tov": pd.to_numeric(tov, errors="coerce"),
                "fta": pd.to_numeric(_col(tb, "free_throws_attempted"), errors="coerce"),
            })
    except Exception as e:  # team box is optional; possessions fall back to player sums
        print(f"  [warn] team box unavailable for {season}: {e}")
    return p, team


def load_nba_api(season: int) -> tuple[pd.DataFrame, pd.DataFrame | None]:
    """Fallback source: stats.wnba.com via nba_api (league id 10)."""
    from nba_api.stats.endpoints import leaguegamelog, playerindex

    frames = []
    for st, code in (("Regular Season", 2), ("Playoffs", 3)):
        df = leaguegamelog.LeagueGameLog(
            league_id="10", season=str(season), season_type_all_star=st,
            player_or_team_abbreviation="P", timeout=60,
        ).get_data_frames()[0]
        df["season_type"] = code
        frames.append(df)
    raw = pd.concat(frames, ignore_index=True)
    if raw.empty:
        raise RuntimeError(f"nba_api returned no player rows for {season}")

    # MATCHUP looks like "LVA vs. SEA" or "LVA @ SEA"
    opp_abbr = raw["MATCHUP"].str.split(r" vs\. | @ ", regex=True).str[-1]
    abbr_to_id = dict(zip(raw["TEAM_ABBREVIATION"], raw["TEAM_ID"].astype(str)))
    try:
        idx = playerindex.PlayerIndex(league_id="10", season=str(season), timeout=60).get_data_frames()[0]
        pos = dict(zip(idx["PERSON_ID"].astype(str), idx["POSITION"]))
    except Exception:
        pos = {}

    p = pd.DataFrame({
        "game_id": raw["GAME_ID"].astype(str),
        "date": pd.to_datetime(raw["GAME_DATE"], errors="coerce").dt.strftime("%Y-%m-%d"),
        "season_type": raw["season_type"],
        "team_id": raw["TEAM_ID"].astype(str),
        "team_abbr": raw["TEAM_ABBREVIATION"],
        "team_name": raw["TEAM_NAME"],
        "opp_id": opp_abbr.map(abbr_to_id).astype(str),
        "home_away": raw["MATCHUP"].str.contains("vs.", regex=False).map({True: "home", False: "away"}),
        "athlete_id": raw["PLAYER_ID"].astype(str),
        "name": raw["PLAYER_NAME"],
        "pos_raw": raw["PLAYER_ID"].astype(str).map(pos),
        "dnp": False,
        "min": raw["MIN"], "pts": raw["PTS"], "reb": raw["REB"], "oreb": raw["OREB"],
        "ast": raw["AST"], "stl": raw["STL"], "blk": raw["BLK"], "tov": raw["TOV"],
        "tpm": raw["FG3M"], "fgm": raw["FGM"], "fga": raw["FGA"], "ftm": raw["FTM"], "fta": raw["FTA"],
    })
    return p, None  # possessions computed from player sums


def load_season(season: int) -> tuple[pd.DataFrame, pd.DataFrame | None, str]:
    try:
        p, t = load_sportsdataverse(season)
        return p, t, "sportsdataverse"
    except Exception as e:
        print(f"  [warn] sportsdataverse failed for {season}: {e}; trying nba_api")
    p, t = load_nba_api(season)
    return p, t, "nba_api"


# --------------------------------------------------------------------------- transform

def map_position(raw) -> str | None:
    if raw is None or (isinstance(raw, float) and math.isnan(raw)) or raw is pd.NA:
        return None
    key = str(raw).strip().upper()
    if key in ("", "NA", "N/A", "NONE", "NAN"):
        return None
    if key in POSITION_MAP:
        return POSITION_MAP[key]
    # Unknown hybrid spelling: apply the same first-listed rule.
    first = key.replace("/", "-").split("-")[0]
    return POSITION_MAP.get(first)


def clean(p: pd.DataFrame) -> pd.DataFrame:
    p = p.copy()
    p = p[p["season_type"].isin([2, 3])]  # regular season + playoffs; drops preseason/All-Star types

    for c in STAT_COLS + ["oreb"]:
        p[c] = pd.to_numeric(p[c], errors="coerce")

    # Drop DNPs: flagged, or no recorded stats at all.
    dnp = p["dnp"].fillna(False).astype(bool)
    no_stats = p[REQUIRED_STATS].isna().all(axis=1)
    zero_line = (p["min"].fillna(0) == 0) & (p[REQUIRED_STATS + ["fga", "fta"]].fillna(0).sum(axis=1) == 0)
    p = p[~dnp & ~no_stats & ~zero_line]

    # All-Star games appear as teams with only a game or two (e.g. "Team Stewart").
    games_per_team = p.groupby("team_id")["game_id"].nunique()
    exhibition_teams = set(games_per_team[games_per_team < 3].index)
    bad_games = set(p.loc[p["team_id"].isin(exhibition_teams) | p["opp_id"].isin(exhibition_teams), "game_id"])
    if bad_games:
        print(f"  dropping {len(bad_games)} exhibition game(s) (teams: {sorted(p.loc[p.team_id.isin(exhibition_teams), 'team_abbr'].unique())})")
    p = p[~p["game_id"].isin(bad_games)]

    p = p.drop_duplicates(subset=["game_id", "athlete_id"])

    # Positions: map, then fill each player's gaps with her most common mapped position.
    p["pos"] = p["pos_raw"].map(map_position)
    mode = p.dropna(subset=["pos"]).groupby("athlete_id")["pos"].agg(lambda s: s.value_counts().index[0])
    p["pos"] = p["pos"].fillna(p["athlete_id"].map(mode))
    return p


def possessions(p: pd.DataFrame, team: pd.DataFrame | None) -> dict[str, float]:
    """Per-game possessions: mean of both teams' FGA - OREB + TOV + 0.44*FTA."""
    src = None
    if team is not None and not team[["fga", "oreb", "tov", "fta"]].isna().any(axis=None):
        src = team
    elif not p[["fga", "oreb", "tov", "fta"]].isna().any(axis=None):
        src = p.groupby(["game_id", "team_id"])[["fga", "oreb", "tov", "fta"]].sum().reset_index()
    if src is None:
        return {}
    src = src.copy()
    src["poss"] = src["fga"] - src["oreb"] + src["tov"] + 0.44 * src["fta"]
    per_game = src.groupby("game_id")["poss"].mean()
    return {g: round(float(v), 1) for g, v in per_game.items() if v > 0}


def build(season: int, p: pd.DataFrame, team: pd.DataFrame | None, source: str) -> dict:
    p = clean(p)
    poss = possessions(p, team)

    teams = (p.sort_values("date").groupby("team_id")
             .agg(abbr=("team_abbr", "last"), name=("team_name", "last")).reset_index()
             .sort_values("abbr"))
    t_idx = {tid: i for i, tid in enumerate(teams["team_id"])}

    players = (p.groupby("athlete_id")
               .agg(name=("name", "last"), pos=("pos", "first")).reset_index()
               .sort_values("name"))
    p_idx = {aid: i for i, aid in enumerate(players["athlete_id"])}

    # One row per game: home/away team index, playoff flag, possessions.
    g = p.drop_duplicates(subset=["game_id", "team_id"])[["game_id", "date", "season_type", "team_id", "opp_id", "home_away"]]
    games = []
    for gid, grp in g.groupby("game_id"):
        r = grp.iloc[0]
        a, b = r["team_id"], r["opp_id"]
        home, away = (b, a) if str(r["home_away"]).lower() == "away" else (a, b)
        if home not in t_idx or away not in t_idx:
            continue
        games.append((r["date"], gid, int(r["season_type"] == 3), t_idx[home], t_idx[away], poss.get(gid)))
    games.sort()

    # Drop games the source recorded incompletely (e.g. one side has 3 player rows).
    # validate() fails the season if too many are dropped.
    lo, hi = CONFIG["validation"]["min_player_rows_per_team_game"], CONFIG["validation"]["max_player_rows_per_team_game"]
    counts = p.groupby(["game_id", "team_id"]).size()
    tid = teams["team_id"].tolist()
    def complete(gm):
        return all(lo <= counts.get((gm[1], tid[t]), 0) <= hi for t in (gm[3], gm[4]))
    incomplete = [gm for gm in games if not complete(gm)]
    games = [gm for gm in games if complete(gm)]
    for gm in incomplete:
        print(f"  dropping incomplete game {gm[1]} ({gm[0]})")
    g_idx = {gm[1]: i for i, gm in enumerate(games)}

    p = p[p["game_id"].isin(g_idx) & p["team_id"].isin(t_idx)]
    p = p.assign(_g=p["game_id"].map(g_idx), _p=p["athlete_id"].map(p_idx)).sort_values(["_g", "team_id", "_p"])

    def col(c):
        vals = p[c].tolist()
        if c == "min":
            return [None if pd.isna(v) else round(float(v), 1) for v in vals]
        return [None if pd.isna(v) else int(v) for v in vals]

    has = {c: bool(p[c].notna().any()) for c in STAT_COLS}
    return {
        "v": 1,
        "season": season,
        "source": source,
        "dropped_games": len(incomplete),
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "coverage": {
            "positions": round(float(players["pos"].notna().mean()), 3) if len(players) else 0,
            "position_rows": round(float(p["pos"].notna().mean()), 3) if len(p) else 0,
            "possessions": round(sum(1 for gm in games if gm[5]) / len(games), 3) if games else 0,
            "stats": has,
        },
        "teams": {"id": teams["team_id"].tolist(), "abbr": teams["abbr"].tolist(), "name": teams["name"].tolist()},
        "players": {"id": players["athlete_id"].tolist(), "name": players["name"].tolist(),
                    "pos": [None if pd.isna(x) else x for x in players["pos"]]},
        "games": {
            "id": [gm[1] for gm in games], "date": [gm[0] for gm in games], "po": [gm[2] for gm in games],
            "home": [gm[3] for gm in games], "away": [gm[4] for gm in games], "poss": [gm[5] for gm in games],
        },
        "rows": {
            "g": p["_g"].astype(int).tolist(), "p": p["_p"].astype(int).tolist(),
            "t": p["team_id"].map(t_idx).astype(int).tolist(),
            **{c: col(c) for c in STAT_COLS},
        },
    }


# --------------------------------------------------------------------------- validate

def validate(out: dict) -> list[str]:
    """Raise ValidationError on bad data; return non-fatal warnings."""
    season, rows, games, teams = out["season"], out["rows"], out["games"], out["teams"]
    v = CONFIG["validation"]
    errors, warns = [], []
    n_rows, n_games, n_teams = len(rows["g"]), len(games["id"]), len(teams["id"])

    if n_rows == 0 or n_games == 0:
        raise ValidationError(f"{season}: empty output ({n_rows} rows, {n_games} games)")

    expected = CONFIG["expected_team_counts"].get(str(season))
    if expected and n_teams != expected:
        errors.append(f"expected {expected} teams, found {n_teams}: {teams['abbr']}")
    elif not expected and n_teams < 8:
        errors.append(f"only {n_teams} teams found")

    per_team_game: dict[tuple[int, int], int] = {}
    for g, t in zip(rows["g"], rows["t"]):
        per_team_game[(g, t)] = per_team_game.get((g, t), 0) + 1
    for gi in range(n_games):
        for t in (games["home"][gi], games["away"][gi]):
            c = per_team_game.get((gi, t), 0)
            if not v["min_player_rows_per_team_game"] <= c <= v["max_player_rows_per_team_game"]:
                errors.append(f"game {games['id'][gi]} {games['date'][gi]} team {teams['abbr'][t]}: {c} player rows")
    games_per_team = {}
    for gi in range(n_games):
        for t in (games["home"][gi], games["away"][gi]):
            games_per_team[t] = games_per_team.get(t, 0) + 1
    for ti, abbr in enumerate(teams["abbr"]):
        if games_per_team.get(ti, 0) < v["min_games_per_team"]:
            errors.append(f"team {abbr} has no games")

    for c in REQUIRED_STATS:
        nulls = sum(1 for x in rows[c] if x is None)
        if nulls:
            errors.append(f"{nulls} rows missing '{c}'")
    if len(set(zip(rows["g"], rows["p"]))) != n_rows:
        errors.append("duplicate player-game rows")

    dropped = out.get("dropped_games", 0)
    if dropped > 0.02 * (n_games + dropped):
        errors.append(f"{dropped} incomplete games dropped (more than 2%)")
    elif dropped:
        warns.append(f"{dropped} incomplete game(s) in source were dropped")

    cov = out["coverage"]
    if cov["position_rows"] < 0.95:
        warns.append(f"positions known for only {cov['position_rows']:.0%} of rows")
    if cov["possessions"] < 1:
        warns.append(f"possessions available for {cov['possessions']:.0%} of games")
    missing = [k for k, ok in cov["stats"].items() if not ok]
    if missing:
        warns.append(f"stats unavailable: {missing}")

    if errors:
        shown = errors[:15] + ([f"... and {len(errors) - 15} more"] if len(errors) > 15 else [])
        raise ValidationError(f"{season}: " + "; ".join(shown))
    return warns


# --------------------------------------------------------------------------- write

def write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def write_index(meta: dict) -> None:
    seasons = sorted((int(p.stem) for p in DATA_DIR.glob("[0-9][0-9][0-9][0-9].json")), reverse=True)
    meta = {k: v for k, v in meta.items() if int(k) in seasons}
    write_json(DATA_DIR / "seasons.json", {"seasons": seasons, "default": seasons[0] if seasons else None})
    (DATA_DIR / "meta.json").write_text(json.dumps(meta, indent=1, sort_keys=True), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", default=None, help="e.g. 2022-2026, 2024,2026, or last5 (default: config.json)")
    ap.add_argument("--force", action="store_true", help="re-fetch seasons even if their file exists")
    args = ap.parse_args()

    seasons = parse_seasons(args.seasons if args.seasons else CONFIG.get("seasons", "last5"))
    DATA_DIR.mkdir(exist_ok=True)
    meta_path = DATA_DIR / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    cur = current_season()
    failed = []

    print(f"Seasons: {seasons} (current season: {cur}, force: {args.force})")
    for season in seasons:
        path = DATA_DIR / f"{season}.json"
        if path.exists() and season < cur and not args.force:
            print(f"[{season}] complete season already on disk; skipping (use --force to re-fetch)")
            continue
        print(f"[{season}] fetching...")
        try:
            p, team, source = load_season(season)
            out = build(season, p, team, source)
            warns = validate(out)
        except ValidationError as e:
            print(f"[{season}] VALIDATION FAILED: {e}")
            failed.append(season)
            continue
        except Exception as e:
            print(f"[{season}] FETCH FAILED: {type(e).__name__}: {e}")
            failed.append(season)
            continue
        for w in warns:
            print(f"[{season}] warning: {w}")
        write_json(path, out)
        meta[str(season)] = {
            "updated": out["updated"], "source": out["source"],
            "rows": len(out["rows"]["g"]), "games": len(out["games"]["id"]), "teams": len(out["teams"]["id"]),
            "last_game": out["games"]["date"][-1], "complete": season < cur, "warnings": warns,
        }
        print(f"[{season}] wrote {path.name}: {meta[str(season)]['rows']} rows, "
              f"{meta[str(season)]['games']} games, {path.stat().st_size / 1024:.0f} KB")

    write_index(meta)
    if failed:
        print(f"FAILED seasons: {failed}. Their files were not written/updated.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
