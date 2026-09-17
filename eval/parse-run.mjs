#!/usr/bin/env node
/* Parser-only re-scoring.
 *
 *   node eval/parse-run.mjs [eval/out/<run>.jsonl] [--data eval/data/<set>] [--show] [--misses]
 *
 * Takes a run whose rows carry `meta.lines` (the ppocr extractor records
 * them), re-runs the app's parseLabel over those lines in Node and scores
 * the result. OCR is the slow, fixed part; this loop lets a parser rule be
 * judged in under a second against exactly the text the recogniser produced.
 * Defaults to the newest ppocr run of the set in eval/out. Truth is re-read
 * from <data>/labels.jsonl, so photos labelled after the run still score.
 * `--show` prints the lines each photo was parsed from, tallest first, with
 * the assigned fields; `--misses` shows only the photos that lost a field.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLabel } from '../js/parse.js';
import { score, formatTable, bySource, FIELD_MAP } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const show = args.includes('--show');
const missesOnly = args.includes('--misses');
const dataIdx = args.indexOf('--data');
const dataDir = path.resolve(dataIdx >= 0 ? args[dataIdx + 1] : path.join(here, 'data'));
const setName = path.basename(dataDir) === 'data' ? '' : `${path.basename(dataDir)}-`;
let file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--data');
if (!file) {
  const outDir = path.join(here, 'out');
  const prefix = `ppocr-${setName}`;
  file = fs.readdirSync(outDir)
    .filter((f) => f.startsWith(prefix) && /^\d{4}-/.test(f.slice(prefix.length)) && f.endsWith('.jsonl'))
    .sort().pop();
  if (!file) { console.error(`no ${prefix}* run in eval/out — run \`npm run eval -- --extractor ppocr --data ${path.relative(process.cwd(), dataDir)}\` first`); process.exit(2); }
  file = path.join(outDir, file);
}

// Truth as it is now, not as it was when the run was recorded.
const labelsPath = path.join(dataDir, 'labels.jsonl');
const truthByFile = new Map(fs.existsSync(labelsPath)
  ? fs.readFileSync(labelsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map(({ file: f, ...t }) => [f, t])
  : []);

const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rescored = rows.map((row) => {
  const truth = truthByFile.get(row.file) ?? row.truth ?? {};
  const lines = row.meta?.lines;
  if (!lines) return { ...row, truth, pred: {} };
  const text = lines.map((l) => l.text).join('\n');
  const { fields } = parseLabel({ text, lines });
  return { ...row, truth, pred: fields, lines };
});

const hasTruth = (row) => Object.keys(FIELD_MAP).some((k) => row.truth?.[k]);
const lostField = (row) => score([row]).worst.some((w) => w.misses.length);

if (show || missesOnly) {
  for (const row of rescored) {
    if (!hasTruth(row)) continue;
    if (missesOnly && !lostField(row)) continue;
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
for (const [source, subset] of bySource(rescored)) {
  console.log(formatTable(score(subset), `source: ${source}`));
}
