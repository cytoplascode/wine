# Extraction bake-off — results

All numbers from `node eval/run.mjs`. "Unflattened" means the extractor got the
raw photo with no human crop and no cylindrical unwrap — the zero-help floor.
Scoring rules: `eval/data/README.md`.

## Smoke set: 8 real dinner-table photos

Babunidze, Tezi, Mellot, Unico, Shaverde, Nimbi, Aladasturi, Papari Valley —
the user's own phone photos, labelled only with what is printed on the label.

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

### Tesseract baseline, 8 photos (`--langs eng+fra`, unflattened) — 2026-09-17

```
rows: 8   scored fields: 40   overall:  18%
field         n   acc   sim
winery         7   14%   14%
wine           8    0%    2%
vintage        6   50%   50%
region         3    0%    0%
country        6   17%   17%
appellation    2    0%    0%
grapes         8   25%   25%
median 1193 ms/image
```

Same 18% as the 3-photo run, so the floor is stable. The extra photos sharpen
the diagnosis: on Shaverde and Papari Valley the *small italic body copy* was
read nearly verbatim ("micro-zone of Kakheti, this wine reflects the heritage…",
"has passed through three terraces of…") while the large display type —
SHAVERDE, the *Papari Valley* script, NIMBI, UNICO — was not read at all. The
parser's biggest-line heuristic then had nothing to grab and promoted body
sentences into Winemaker / WineName. Fine print yes, stylised headline no:
that is the recogniser ceiling, and it is exactly the text a wine label leads
with.

## Phone probe — Pixel 9 Pro, Chrome 153 (2026-09-17)

```
LanguageModel: false   legacyAi: false        → no built-in Prompt API; Gemini Nano
                                                 from a PWA is not available. Closed.
webgpu: true           requestAdapter(): null → GPU adapter not handed out on a
                                                 default request. Probe v2 retries with
                                                 power preferences + fallback adapter.
deviceMemoryGB: 8                              (Chrome caps this value; ignore)
```

Consequence: until probe v2 says otherwise, the phone is a **WASM-only**
target. That makes CPU-cheap recognisers (PP-OCR) relatively more attractive
than a 230M-param VLM, whatever the accuracy numbers say.

### Probe v2 — same phone, 2026-09-17

```
gpuAdapter: null   gpuAdapterHighPerf: null   gpuAdapterLowPower: null   gpuAdapterFallback: null
webgpu: true       wgslFeatures: 12          → the API object exists, but Chrome hands out
                                               no adapter under any preference, not even
                                               the software fallback. WebGPU is blocklisted
                                               or disabled for this device in Chrome 153.
crossOriginIsolated: false  sharedArrayBuffer: false
                                             → served from GitHub Pages without COOP/COEP:
                                               no threads unless the app ships the
                                               coi-serviceworker shim.
hardwareConcurrency: 8      wasmSimd: true   → with the shim, ORT-web gets 8 SIMD threads.
```

Probe v2 settles it: the phone is **WASM-only**, and that is a property of
the browser on this device, not of the probe. A 230M-parameter VLM
(Florence-2) on single-thread WASM is tens of seconds to minutes per photo;
it is out as a phone candidate regardless of how it scores on a laptop.
PP-OCR on WASM is about 1 s per photo with threads (2.3 s without), which
the shim makes reachable on Pages. The in-browser decision is therefore
PP-OCRv4 + the parser, with the remaining accuracy work in the parser rules
and dictionaries.

## PP-OCRv4 (DB det + CRNN rec) via ONNX Runtime Web, WASM — 2026-09-17

Models: `ch_PP-OCRv4_det_infer` (4.5 MB) + `en_PP-OCRv4_rec` (7.3 MB), from
npm `paddle-ocr-onnx-models` (Apache-2.0). Runtime `onnxruntime-web` 1.29,
CPU-only WASM build (3.6 MB gzipped). No human crop, no unwrap.

```
rows: 8   scored fields: 40   overall:  45%      (Tesseract: 18%)
field         n   acc   sim
winery         7   71%   66%                     (14%)
wine           8    0%    1%                     ( 0%)
vintage        6  100%  100%                     (50%)
region         3    0%    0%
country        6   67%   67%                     (17%)
appellation    2    0%    0%
grapes         8   38%   38%                     (25%)
median  1036 ms/image  threads=4  (this sandbox's CPU)
median  2347 ms/image  threads=1  (what GitHub Pages gets without a COOP/COEP shim)
```

What the raw text now contains — the words Tesseract could not read at all:

```
BABUNIDZE | WINES | KHIKHVI | Qvevri Amber Dry Wine | Kakheti, Georgia
TEZI WINERY | 2022 | LIMITED EDITION | Qvevri Dry Amber | Produced in Georgia
JOSEPH MELLOT | LA GAUPIERE | SAUVIGNON | BLANC | 2024
UNICO | BLEND SAPERAVI | 2022
SHAVERDE | Gulordaia tamily | Winery | MUKUZANI | Dry Red Georgian Wine | 2024
ESTD | 2024 | NIMBI | RKATSITELI | WHITE DRY | WINE | INTENTO COLLECTION | PRODUCT OF GEORGIA
11% | 2024 | Aladasturi Rose | 750ml
Papari Valley | 3 Qvevri Terraces | Medium-Sweet | … | Produced in Georgia
```

Every producer and wine name is present as a clean line. So the picture has
inverted: **recognition is no longer the bottleneck, attribution is.** The
wine name is in the text on all 8 photos and the parser scores it on 0 —
it picks "LIMITED EDITION", "ESTD", "attisdid" (a body-copy fragment), or
nothing. Winery misses are the same class: "WHITE DRY" over NIMBI, "OTERUX
DUGIENOS" (the appellation line, misread) over JOSEPH MELLOT. These are
parser rules, tunable against this harness with the recogniser held fixed.

Recogniser weaknesses that remain, for the record: the *en* dictionary has
no accents (GAUPIÈRE → GAUPIERE; harmless, scoring normalises); script and
italic body copy come through as fragments ("eracesfTro", "attisdid");
"Gulordava Family" → "Gulordaia tamily". None of those touch the name fields.

Detection came free: the union of DB boxes is a tight label bounding box on
all 8 photos (recorded per row as `meta.box` in the JSONL) — the input a
future auto-placed crop would start from.

## PP-OCRv4 + attribution rules in the parser — 2026-09-17

Same OCR run as above; only `js/parse.js` and `js/wine-data.js` changed.
Re-scored offline with `node eval/parse-run.mjs` (re-parses the recorded
lines in under a second), then confirmed with a fresh `npm run eval`.

```
rows: 8   scored fields: 40   overall:  78%      (before: 45%, Tesseract: 18%)
field         n   acc   sim
winery         7   86%   80%                     (71%)
wine           8   75%   75%                     ( 0%)
vintage        6  100%  100%                     (100%)
region         3   67%   67%                     ( 0%)
country        6   83%   83%                     (67%)
appellation    2   50%   50%                     ( 0%)
grapes         8   63%   63%                     (38%)
median 1047 ms/image  threads=4
```

Rules added, all general (no per-bottle special cases):

- **Descriptor lines** ("WHITE DRY", "Qvevri Dry Amber", "Medium-Sweet") are
  words that only describe the wine; they are never a name and never merge
  into one.
- **Marketing lines** ("LIMITED EDITION", "ESTD 1997", "PRODUCT OF …") are
  excluded from the names likewise.
- **Prose** — a line with sentence words ("was", "aged", "through") or a
  long line with several stopwords — is body copy, not a name. Papari
  Valley's back-story sentence no longer wins WineName.
- **Merging is conservative**: a line that is already a field (vintage,
  grape, place, descriptor) never continues the line above it, and neither
  does a line below 50 confidence. NIMBI / RKATSITELI, KHIKHVI / country
  stay separate lines.
- **Junk fragments** (bare numbers, `%`, units, low-confidence one- or
  two-letter reads) become rows of their own instead of being glued onto a
  neighbour: "SHAVERDE 88 HS" is now "SHAVERDE".
- **Wine-name fallback**: when no cuvée-style line exists, a line that is
  wholly a grape ("RKATSITELI", "BLEND SAPERAVI") or wholly an appellation
  ("MUKUZANI") is the wine name — that is how varietal-labelled and
  PDO-labelled bottles are named.
- **Georgian dictionaries**: 17 grapes, 19 PDOs with their regions, and
  "amber" as a wine type. Plus Coteaux du Giennois for the Mellot bottle.

Remaining misses, and why they are not parser bugs:

- **Mellot** (29%): the top line is the appellation "COTEAUX DU GIENNOIS"
  in an ornate face, read as "OTERUX DUGIENOS" at 78 confidence — a
  recogniser error. Because it is the tallest clean-looking line it takes
  Winemaker and pushes JOSEPH MELLOT to WineName. Fuzzy appellation
  matching (edit distance against the dictionary) would catch this one and
  is the obvious next rule; it also needs the accent-less *en* dictionary
  to stop confusing È and E.
- **Tezi** (60%): "Chinuri" is simply not printed on the front label in a
  form the recogniser read. Needs the back label, or a second pass on the
  small type.
- **Papari, Shaverde** (grapes): Saperavi is not printed on the front.
  Mukuzani is a Saperavi-only PDO, so an *appellation → implied grape*
  table would fill Shaverde; Papari needs the back label.

## Shipped: PP-OCR in the app — 2026-09-17

The engine moved into the app as `js/ppocr.js` (runtime and models vendored
under `vendor/ppocr/`, 16 MB, the wasm core gzipped to 3.6 MB and inflated
with DecompressionStream) and the eval extractor became a wrapper over that
same module. Re-measured through it:

```
rows: 8   scored fields: 40   overall:  78%   median 1049 ms/image  threads=4
```

Identical to the pre-integration run, after one regression caught on the way:
setting `imageSmoothingQuality = 'high'` on the resampling canvases — an
innocent-looking default elsewhere in the app — changed the detector's boxes
("SHAVERDE" → "SHAV ERDE Hay") and the recogniser's spacing ("Produced
inGeorgia") and cost 15 points (78% → 63%). Plain `drawImage` is what the
models were measured with, and what ships.

Smoke test of the shipped path in headless Chromium behind a plain static
server (no COOP/COEP headers, as GitHub Pages sends): the service worker's
injected headers make the page cross-origin isolated after one automatic
reload; the download card fetches the five files; recognition runs on 4
threads at 685 ms warm (2.1 s cold, including the model load); a second
launch touches the network for nothing. The Tesseract engine remains
selectable and still reads.

## WineSensed slice — 800 photos at 480×640, 65 hand-labelled — 2026-09-17

The user's zip: 800 WineSensed photos, whole-bottle shots at 480×640 with
label text 8–20 px tall, no metadata. 65 were labelled by hand from what
the label prints (`"source":"printed"`); the rest ran unlabelled so their
lines are recorded for when the dataset's own table arrives
(`eval/import-winesensed.mjs`). Median 397 ms/photo, 4 threads.

```
                       before this round   after
rows: 65 labelled      overall: 55%        63%
winery         60       35%                40%
wine           56       48%                52%
vintage        43       84%                84%
region         37       41%                59%
country        42       64%                74%
appellation    37       46%                68%
grapes         29       83%                83%
smoke set (8)          78%                 78%
```

Rules added, all general:

- Dictionary: 40 more appellations and areas as labels print them (New
  World AVAs with their state or province as region, wide Italian IGTs,
  Sherry, Tokaji, Valle de Uco …), Mexico and "Baja California" as a
  country line — which used to read as California, USA.
- Boilerplate that a small photo mangles *and* runs together
  ("DICAZIONEGEOGANIATIN", "PROLOGICO/ORGANIC") is caught by looking for
  long boilerplate words as approximate substrings of the space-stripped
  line. Awards ("IWSC TROPHY"), classifications ("CRU BOURGEOIS", "GRAND
  CRU CLASSÉ DE GRAVES") and leftover strength/volume fragments are noise.
- A long place name read as one word with a few letters wrong
  ("BRUNELLOMONTALCIN") is matched to the dictionary within 15% of its
  length; a line that is essentially an appellation is never the producer,
  and when it becomes the wine name it is written in dictionary spelling.
- "Appellation Moulis Contrôlée" under a "MOULIS-EN-MÉDOC" headline records
  the fuller entry and its region.
- Words of a place on the label are withheld from fuzzy grape matching
  (the Tarantino IGT is not "Sagrantino").
- A producer name wrapped onto a "Vineyard and Cellars" line is rejoined;
  a possessive lone word ("LINDEMAN'S") is the producer; "Bin 25" and
  "N° 3" open a cuvée name; descriptor words grew (solera, reserva, pale,
  late harvest, cuvée …) so "SOLERA RESERVA" and "BRUT CUVEE" stop being
  names.

Upscaling ×2 before detection was measured and **not kept**: 53% against
55%, slower, with vintage and wine both down. The detector already sees
these photos at their native size and the recogniser gains nothing from
interpolated pixels.

Where the remaining misses are, from the 65:

- **Recogniser, ~half of the winery misses**: script and ornate faces at
  this resolution ("Colomé" → "stomi", "Georges Kriter" → "GueryeKeitr",
  "Jean-Claude" → "ean-cTaude", "Julien Sunier" → "Juliew Suer"), and
  producers not detected at all when the label is dark or blurred. These
  photos are far smaller than the app's flattened labels; they bound the
  parser's ceiling here, not the phone's.
- **Attribution that needs knowledge, not rules**: the producer printed
  small under a big cuvée (Farnese under EDIZIONE, Tselepos under CANAVA
  CHRISSOU, Catena Zapata under ADRIANNA VINEYARD). A producer list would
  settle these; a size rule cannot.
- **Truth ambiguity**: whether "Champagne", "Napa Valley" or "Brut" is the
  wine name of a bottle that prints no other — the fallback names the
  appellation, which is right for Mukuzani and Fleurie and arguable for
  Champagne.
