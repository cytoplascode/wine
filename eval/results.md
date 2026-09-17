# Extraction bake-off — results

All numbers from `node eval/run.mjs`. "Unflattened" means the extractor got the
raw photo with no human crop and no cylindrical unwrap — the zero-help floor.
Scoring rules: `eval/data/README.md`.

## Smoke set: 3 real dinner-table photos (Babunidze, Tezi, Mellot)

### Tesseract baseline (`--langs eng+fra`, unflattened) — 2026-09-17

```
rows: 3   scored fields: 17   overall:  18%
field         n   acc   sim
winery         3   33%   33%
wine           3    0%    0%
vintage        2   50%   50%
region         2    0%    0%
country        3   33%   33%
appellation    1    0%    0%
grapes         3    0%    0%
median 1146 ms/image at 1600 px (2.5 s cold start)
```

What the raw text shows, per image:

- **Babunidze**: the big serif producer line came back as `bNban`; `KHIKHV]`
  was read but nothing claimed it. Everything else was noise tokens.
- **Tezi**: `TEZI WINERY` read cleanly → winery hit; `Produced in Georgia` →
  country hit. `2022` was not read at all. `MITED EDITION` (limited edition)
  was promoted to WineName.
- **Mellot**: `JOSEPH MELLO!` was read (one char off) but the parser put it in
  **WineName** and gave Winemaker a garbage line (`nx pu aemo®`). `2024` hit.
  `SAUVIGNON` arrived as `VIGNON nu.` so the varietal lookup missed.

Two distinct failure classes, which matter for what to fix:

1. **Recognition** — stylised large type is mangled (`bNban`), vintage dropped
   on one of two. This is the Tesseract ceiling; no parser change recovers it.
2. **Attribution** — when a name *is* read, the winemaker/wine-name heuristics
   can assign it to the wrong slot. This is fixable independently of the OCR
   engine and will show up as a gap between `sim` and `acc` on the big slice.
