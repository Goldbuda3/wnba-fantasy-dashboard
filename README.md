# WNBA Defense vs Position

A WNBA fantasy basketball dashboard that shows how each team's defense performs against guards, forwards and centers. It is a static site: everything runs in the visitor's browser, the data is plain JSON, and it's hosted on GitHub Pages. Python runs only in GitHub Actions (or on your machine) to fetch box scores and write the JSON.

**Views**

1. **Defense vs position**: fantasy points allowed per game to G / F / C (and all players) by every team, sortable and color-coded. Warm cells mark soft matchups and cool cells mark tough ones.
2. **Stat breakdown**: points, rebounds, assists, 3PM, steals and blocks allowed, for one position at a time.
3. **Team drill-down**: pick a defense to see every player who scored against it, game by game, with minutes and her season average.
4. **Matchup +/-**: how far above or below their own averages opponents score against each defense (opponent-adjusted).

Every view has these filters:

- scoring preset (Standard / DraftKings / FanDuel / Custom)
- per game or per 100 possessions
- full season, last 10 or last 5 games
- regular season, with playoffs, or playoffs only

Each cell shows the average with the median underneath. ◆ marks teams where a few outlier games pull the average away from the median. The selected season and filters are kept in the URL, so any view can be bookmarked or shared.

## Repo structure

```
index.html                  page shell
css/style.css               styles (light + dark, mobile)
js/app.js                   data loading, aggregation, views, URL state
js/scoring.js               scoring presets (edit to change point values)
data/
  2026.json …               one file per season (columnar raw stats)
  seasons.json              list of available seasons
  meta.json                 last-updated timestamp + summary per season
pipeline/
  fetch.py                  fetch → clean → validate → write JSON
  config.json               default seasons, expected team counts, validation limits
  positions.json            raw position → G/F/C mapping
requirements.txt            Python dependencies
.github/workflows/update-data.yml   manual (workflow_dispatch) fetch + deploy
```

### Data format

Each `data/<season>.json` stores **raw box-score stats, not fantasy points**, so the browser can apply any scoring format. To keep the files small (~180–270 KB, much less gzipped), everything is stored as columnar arrays:

- `teams`, `players`, `games`: lookup tables. Games have date, playoff flag, home/away team index and possessions.
- `rows`: one entry per player-game. `g` (game index), `p` (player index), `t` (her team index), then `min pts reb ast stl blk tov tpm fgm fga ftm fta`.
- `coverage`: what the season has. That's the share of rows with a position, the share of games with possession data, and which stats exist. The UI shows a warning when something is missing.

**Possessions** per game are the average of both teams' `FGA − OREB + TOV + 0.44 × FTA`, from team box scores. If team box scores are missing, the pipeline sums player box scores instead.

**Positions** are grouped into G, F and C using `pipeline/positions.json`. Hybrid listings use the **first listed position**: G-F → G, F-G → F, F-C → F, C-F → C. Change the mapping there, then re-run the pipeline with `--force`. A player with no position in some games gets her most common position from the rest of the season. Players with no position anywhere count only toward "All".

## Run the pipeline locally

Python 3.10+.

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

python pipeline/fetch.py                      # default seasons from config.json (last 5)
python pipeline/fetch.py --seasons 2022-2026  # a range
python pipeline/fetch.py --seasons 2019,2021  # a list
python pipeline/fetch.py --seasons 2025 --force
```

- Data comes from ESPN box scores via [sportsdataverse](https://github.com/sportsdataverse/sportsdataverse-py), the Python port of wehoop. If that fails, the script falls back to `nba_api` (stats.wnba.com, league ID `10`).
- **Completed seasons are skipped** if their file already exists. Use `--force` to re-fetch. The current season (current calendar year, or `current_season` in `config.json`) is always re-fetched.
- **Validation** runs before anything is written. It checks:
  - the expected number of teams (`expected_team_counts` in `config.json`)
  - that no file is empty
  - 5–20 player rows per team per game
  - no missing core stats
  - no duplicate player-games

  A season that fails is not written, and the script exits with code 1. A few incomplete games in the source data are dropped with a warning (more than 2% fails the season).
- All-Star and other exhibition games are dropped automatically.

## Preview the site locally

The site loads JSON with `fetch`, so open it through a local web server, not as a `file://` path:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## Put it on GitHub and enable Pages

1. Create an empty repo on GitHub (for example `wnba-fantasy-dashboard`), then push:
   ```bash
   git remote add origin https://github.com/<you>/wnba-fantasy-dashboard.git
   git push -u origin main
   ```
2. In the repo go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Run the workflow once (below). The site will be at `https://<you>.github.io/wnba-fantasy-dashboard/`.

## Run the workflow manually

**Actions → Update data and deploy → Run workflow**, then fill in:

- **seasons**: blank for the default (last 5), or e.g. `2026` or `2018-2026`.
- **force**: re-fetch seasons that already have files.
- **deploy_only**: skip fetching and just redeploy. Use this after changing the HTML/CSS/JS, because the workflow doesn't run on push.

The job sets up Python, installs dependencies and runs `pipeline/fetch.py`. That step fails, and nothing is published, if validation fails. Otherwise the job commits `data/` only if something changed, then deploys the site to Pages.

## Add more seasons

1. Run `python pipeline/fetch.py --seasons 2015-2021` locally (or put `2015-2021` in the workflow's **seasons** input).
2. Commit the new `data/*.json`. `seasons.json` is rebuilt from whatever files are in `data/`, so the season dropdown updates automatically.
3. For a **new** season (e.g. 2027), add its team count to `expected_team_counts` in `pipeline/config.json`. Update it again whenever a team joins or folds. Each season file has its own team list, so expansion, relocation and folded teams need no other changes.

Older seasons have gaps. Examples:

- 2002 has almost no box-score data, so validation rejects it.
- Most players before ~2010 have no position listed.
- Some seasons lack minutes.

The pipeline handles these without crashing and records them in `coverage`, and the dashboard shows a warning for that season.

## Turn on the weekly schedule

In `.github/workflows/update-data.yml`, uncomment:

```yaml
  schedule:
    - cron: "0 13 * * 2"
```

That runs every Tuesday at 13:00 UTC (8 AM Central in-season during daylight time, 7 AM in winter). Commit it to `main` before the season starts. Scheduled runs use the default seasons. Completed seasons are skipped, so only the current one is re-fetched. Comment it out again after the Finals.

## Change scoring presets

### In the dashboard (Custom)

Pick **Custom** in the Scoring dropdown. An editor opens with a box for each stat, pre-filled with ESPN's default values, plus double-double and triple-double bonuses (0 = off). Every number recalculates as you type.

- Your values go into the link (`cs=pts1,reb1.2,ast1.5,...`), so sharing the URL shares your scoring.
- They're also saved in your browser, so Custom remembers them next time. A shared link's values take priority over saved ones.
- **Reset to ESPN** puts the ESPN values back.

The dashboard opens with **Standard (ESPN)** selected. To change that, set `DEFAULT_PRESET` in `js/scoring.js`.

### In the code

Edit `js/scoring.js`. Each preset has:

```js
draftkings: {
  label: 'DraftKings',
  values: { pts: 1, tpm: 0.5, reb: 1.25, ast: 1.5, stl: 2, blk: 2, tov: -0.5 },
  bonus: { dd: 1.5, td: 3, cats: ['pts', 'reb', 'ast', 'blk', 'stl'], stack: true },
},
```

- `values`: points per stat (keys: `pts reb ast stl blk tov tpm fgm fga ftm fta`).
- `bonus` (optional): double-double / triple-double bonus. `stack: true` means a triple-double also earns the double-double bonus.
- Add a new key (above `custom`) to add a preset; it appears in the dropdown automatically. Change `DEFAULT_PRESET` to change the default (currently `standard`).
- The Custom preset starts from the `standard` values, so changing `standard` also changes Custom's starting point.

Preset values, as checked on 2026-10-03:

| | PTS | 3PM | REB | AST | STL | BLK | TOV | Other |
|---|---|---|---|---|---|---|---|---|
| Standard (ESPN default points) | 1 | 1 | 1 | 2 | 4 | 4 | −2 | FGM 2, FGA −1, FTM 1, FTA −1 |
| DraftKings | 1 | 0.5 | 1.25 | 1.5 | 2 | 2 | −0.5 | Double-double +1.5, triple-double +3 |
| FanDuel | 1 | — | 1.2 | 1.5 | 3 | 3 | −1 | no bonuses |

Re-check the official rules before each season. Sites change their scoring.

## How the numbers are computed

- **Allowed per game**: for each game a defense played, add up the fantasy points (or stat) of every opposing player at that position, then take the average and median across games. Defenses are ranked on these per-game (or per-100) numbers, never on totals.
- **Per 100 possessions**: each game's total × 100 ÷ that game's possessions, then averaged. Games without possession data are skipped.
- **Last 5 / Last 10**: each defense's own most recent N games of the selected game type.
- **Opponent adjustment**: for every opposing player-game, her fantasy points minus her average in her *other* games of the selected game type (leave-one-out). These differences are summed by position and averaged per game. Players with only one game have no baseline and are skipped.
