# Extraction bake-off

A measurement loop for "how well does the app read a label", so recogniser and
parser changes are judged on numbers rather than on three photos by eye.

```
npm run eval -- --extractor tesseract --langs eng+fra
npm run eval:models                                    # once: PP-OCR models from npm
npm run eval -- --extractor ppocr --options '{"threads":4}'
npm run eval -- --extractor ppocr --options '{"threads":1}'          # GitHub-Pages-without-COOP number
npm run eval -- --extractor florence --options '{"device":"wasm"}'
npm run eval -- --extractor florence --limit 20 --options '{"remote":true}'   # laptop, HF reachable
```

The harness is served by `eval/serve.mjs`, which sends COOP/COEP headers so
ONNX Runtime's threaded WASM build can use SharedArrayBuffer. GitHub Pages
cannot send those headers, so a shipped app either takes the single-thread
number or installs a `coi-serviceworker` shim — the threads=1 run is there
to keep that cost visible. `node eval/serve.mjs 8765` runs the server alone
(binds 0.0.0.0, handy for opening `probe.html` from a phone on the same wifi).

`--options '{"autoCrop":true}'` on the ppocr extractor places the six
handles with the app's label finder (`js/autocrop.js`), unwraps with the
app's own flatten and reads that — the crop-free path a phone gets.
`node eval/crop-preview.mjs [--data …] [--only a.jpg]` draws what the
finder did on each photo (text boxes, handles, the flattened result) into
`eval/out/crops/`, which is how a placement rule is judged before its
number is believed.

Flags: `--extractor <name>` (a module in `extractors/`), `--limit N`,
`--langs eng+fra` (Tesseract), `--options '<json>'` (passed to the extractor),
`--data <dir>` (default `eval/data`), `--port`.

Each run writes `eval/out/<extractor>-<stamp>.jsonl` (one row per image: truth,
prediction, raw text, timing) and prints the score table. Numbers worth keeping
go into `results.md`.

A second set is chosen with `--data eval/data/winesensed` (layout in
`data/README.md`); photos without truth are still run and recorded, and
`node eval/import-winesensed.mjs <table.csv|.jsonl>` turns the dataset's
own metadata into truth rows once it is available.

Parser changes do not need a fresh OCR run: `node eval/parse-run.mjs [--show]`
re-parses the lines recorded in the newest ppocr run (`meta.lines`) with the
app's `parseLabel` in Node and prints the same table in under a second.
`--show` lists every photo's lines tallest-first next to the fields assigned,
which is the fastest way to see *why* a name went to the wrong slot.

Extractors run **in headless Chromium**, not in Node — the same WASM/WebGPU
code path the phone uses is what gets timed.

- Data layout: `data/README.md`.
- Scoring rules: `score.mjs` (unit-tested in `test/eval-score.test.js`).
- Phone probe for Chrome's built-in Prompt API: open `probe.html` on the device.

## Models (`eval/models/`, gitignored)

### PP-OCR (`eval/models/ppocr/`)

`npm run eval:models` fetches the detector, recogniser and classifier from
the npm package `paddle-ocr-onnx-models` (Apache-2.0, RapidOCR's ONNX
conversions) — ~12.5 MB total. That folder is only the source the vendored
copy was taken from: since the engine shipped, `eval/extractors/ppocr.mjs`
is a thin wrapper over the app's own `js/ppocr.js`, loading the runtime and
models from `/vendor/ppocr/`, so the table measures exactly the code the
phone runs. The pure parts (map → boxes, CTC decode, the `en_dict` charset)
live in `js/ppocr-post.js` and are unit-tested.

### Florence-2 (`eval/models/Florence-2-base-ft/`)


transformers.js resolves a model id against `/eval/models/<id>/`. Mirror the HuggingFace repo **onnx-community/Florence-2-base-ft**
into `eval/models/Florence-2-base-ft/`:

```
config.json  generation_config.json  preprocessor_config.json
tokenizer.json  tokenizer_config.json  (plus vocab.json / merges.txt / special_tokens_map.json if present)
onnx/embed_tokens.onnx
onnx/vision_encoder.onnx
onnx/encoder_model.onnx
onnx/decoder_model_merged.onnx
```

Those are the fp32 files (~1 GB total; fine for measuring). To test what
would actually ship, also drop the `_q8` (or `_fp16`) variants of the four
`.onnx` files alongside and run with `--options '{"dtype":"q8"}'` — that is
the ~250–450 MB download the phone would take.

If the machine running the harness can reach HuggingFace, skip all of this
and pass `--options '{"remote":true}'`; the library downloads and caches the
files itself.
