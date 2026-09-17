#!/usr/bin/env node
/* Parser-only re-scoring.
 *
 *   node eval/parse-run.mjs [eval/out/<run>.jsonl] [--show]
 *
 * Takes a run whose rows carry `meta.lines` (the ppocr extractor records
 * them), re-runs the app's parseLabel over those lines in Node and scores
 * the result. OCR is the slow, fixed part; this loop lets a parser rule be
 * judged in under a second against exactly the text the recogniser produced.
 * Defaults to the newest ppocr run in eval/out. `--show` prints the lines
 * each photo was parsed from, tallest first, with the assigned fields.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLabel } from '../js/parse.js';
import { score, formatTable } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const show = args.includes('--show');
let file = args.find((a) => !a.startsWith('--'));
if (!file) {
  const outDir = path.join(here, 'out');
  file = fs.readdirSync(outDir).filter((f) => f.startsWith('ppocr-') && f.endsWith('.jsonl')).sort().pop();
  if (!file) { console.error('no ppocr run in eval/out — run `npm run eval -- --extractor ppocr` first'); process.exit(2); }
  file = path.join(outDir, file);
}

const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rescored = rows.map((row) => {
  const lines = row.meta?.lines;
  if (!lines) return { ...row, pred: {} };
  const text = lines.map((l) => l.text).join('\n');
  const { fields } = parseLabel({ text, lines });
  return { ...row, pred: fields, lines };
});

if (show) {
  for (const row of rescored) {
    console.log(`\n== ${row.file}`);
    const byHeight = [...(row.lines || [])].sort((a, b) => b.height - a.height);
    for (const l of byHeight) {
      console.log(`  h=${String(Math.round(l.height)).padStart(4)}  c=${String(Math.round(l.confidence)).padStart(3)}  ${l.text}`);
    }
    console.log('  →', JSON.stringify(row.pred));
    console.log('  truth', JSON.stringify(row.truth));
  }
  console.log('');
}

console.log(formatTable(score(rescored), `parse-only re-score of ${path.relative(process.cwd(), file)}`));
