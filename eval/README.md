# Extraction bake-off

A measurement loop for "how well does the app read a label", so recogniser and
parser changes are judged on numbers rather than on three photos by eye.

```
npm run eval -- --extractor tesseract --langs eng+fra
npm run eval -- --extractor florence --options '{"device":"wasm"}'
npm run eval -- --extractor florence --limit 20 --options '{"remote":true}'   # laptop, HF reachable
```

Flags: `--extractor <name>` (a module in `extractors/`), `--limit N`,
`--langs eng+fra` (Tesseract), `--options '<json>'` (passed to the extractor),
`--data <dir>` (default `eval/data`), `--port`.

Each run writes `eval/out/<extractor>-<stamp>.jsonl` (one row per image: truth,
prediction, raw text, timing) and prints the score table. Numbers worth keeping
go into `results.md`.

Extractors run **in headless Chromium**, not in Node — the same WASM/WebGPU
code path the phone uses is what gets timed.

- Data layout: `data/README.md`.
- Scoring rules: `score.mjs` (unit-tested in `test/eval-score.test.js`).
- Phone probe for Chrome's built-in Prompt API: open `probe.html` on the device.

## Models (`eval/models/`, gitignored)

transformers.js resolves a model id against `/eval/models/<id>/`. For the
Florence-2 candidate, mirror the HuggingFace repo **onnx-community/Florence-2-base-ft**
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
