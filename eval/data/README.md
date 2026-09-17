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
