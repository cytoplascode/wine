#!/usr/bin/env node
/* Extraction bake-off driver.
 *
 *   node eval/run.mjs --extractor tesseract [--limit 20] [--langs eng+fra]
 *                     [--data eval/data] [--port 8765]
 *
 * Serves the repo over HTTP, opens eval/harness.html in headless Chromium,
 * runs the chosen extractor over every row of <data>/labels.jsonl, writes
 * eval/out/<extractor>-<stamp>.jsonl and prints the per-field score table.
 * Extractors run in the browser on purpose: that is where they will run on
 * the phone, so WASM/WebGPU behaviour is measured, not simulated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { score, formatTable } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const extractor = args.extractor || 'tesseract';
const limit = args.limit ? Number(args.limit) : Infinity;
const port = Number(args.port || 8765);
const dataDir = path.resolve(repo, args.data || 'eval/data');
const options = { langs: args.langs || 'eng', ...(args.options ? JSON.parse(args.options) : {}) };

const labelsPath = path.join(dataDir, 'labels.jsonl');
if (!fs.existsSync(labelsPath)) {
  console.error(`No ${labelsPath} — see eval/data/README.md for the layout.`);
  process.exit(2);
}
const rows = fs.readFileSync(labelsPath, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => fs.existsSync(path.join(dataDir, 'images', r.file)))
  .slice(0, limit);
if (!rows.length) { console.error('No rows with an existing image.'); process.exit(2); }

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
  cwd: repo, stdio: 'ignore',
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${base}/eval/harness.html`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.setDefaultTimeout(10 * 60 * 1000);
page.on('pageerror', (e) => console.error('pageerror:', e.message));

const relData = path.relative(repo, dataDir).split(path.sep).join('/');
const q = new URLSearchParams({ extractor, options: JSON.stringify(options) });
await page.goto(`${base}/eval/harness.html?${q}`);
await page.waitForFunction(() => window.harnessReady || window.harnessError);
const harnessError = await page.evaluate(() => window.harnessError);
if (harnessError) { console.error(harnessError); await browser.close(); server.kill(); process.exit(1); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.mkdirSync(path.join(repo, 'eval/out'), { recursive: true });
const outPath = path.join(repo, 'eval/out', `${extractor}-${stamp}.jsonl`);
const out = fs.createWriteStream(outPath);
const scored = [];

for (const [i, row] of rows.entries()) {
  const url = `${base}/${relData}/images/${encodeURIComponent(row.file)}`;
  let result;
  try {
    result = await page.evaluate((u) => window.extract(u), url);
  } catch (err) {
    result = { fields: {}, rawText: '', ms: null, error: String(err.message || err) };
  }
  const { file, ...truth } = row;
  const record = { file, truth, pred: result.fields || {}, rawText: result.rawText || '', ms: result.ms, error: result.error };
  out.write(`${JSON.stringify(record)}\n`);
  scored.push(record);
  process.stderr.write(`\r${i + 1}/${rows.length}  ${file}  ${result.ms ?? '—'} ms${result.error ? '  ERROR' : ''}     `);
  if (result.error) process.stderr.write(`\n  ${result.error.split('\n')[0].slice(0, 300)}\n`);
}
process.stderr.write('\n');
out.end();
await browser.close();
server.kill();

const summary = score(scored);
const times = scored.map((r) => r.ms).filter((x) => typeof x === 'number').sort((a, b) => a - b);
const median = times.length ? times[Math.floor(times.length / 2)] : null;
console.log(formatTable(summary, `${extractor}  ${JSON.stringify(options)}  median ${median} ms/image`));
console.log(`wrote ${path.relative(repo, outPath)}`);
