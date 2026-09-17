# Eval data layout

The bake-off driver (`node eval/run.mjs`) reads:

- `eval/data/labels.jsonl` — one JSON object per line (committed):

  ```json
  {"file":"0001.jpg","winery":"Tezi Winery","wine":"Chinuri","vintage":"2022","region":null,"country":"Georgia","appellation":null,"grapes":"Chinuri"}
  ```

  Any field may be `null` or missing — it is then simply not scored for that
  row. `grapes` is a comma-separated list. `file` is a name inside `images/`.

- `eval/data/images/<file>` — the photos (gitignored; a few MB each). Any
  size works; extractors downscale to the app's `MAX_SIDE` themselves.

Rows whose image is missing are skipped, so a partial slice still runs.

Scoring: vintage is exact on the four-digit year; grapes are an
order-insensitive set match; every other field is normalised token-set
similarity with a containment bonus, hit at ≥ 0.6. See `eval/score.mjs`.

## More than one set

A second set lives in its own folder with the same layout, e.g.
`eval/data/winesensed/{images/,labels.jsonl}`, and is chosen with
`--data eval/data/winesensed` on `run.mjs` and `parse-run.mjs`. Photos in
`images/` with no row in `labels.jsonl` are still run — their raw text and
lines are recorded — and simply not scored, so a set can be run first and
labelled afterwards.

Each row may carry `"source"`: `printed` for labels written by a person from
what the bottle shows, `winesensed` for rows imported from the dataset's own
metadata (`node eval/import-winesensed.mjs <table.csv|.jsonl>`). The tables
are reported per source as well as together, because a dataset's canonical
names and the printed ones differ often enough to matter.

The WineSensed set: 800 photos at 480×640 (whole-bottle shots, filenames
are the dataset's image ids), of which 65 were hand-labelled first.
