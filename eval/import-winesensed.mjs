#!/usr/bin/env node
/* Turn the WineSensed metadata table into eval truth.
 *
 *   node eval/import-winesensed.mjs <metadata.csv|.jsonl> [--data eval/data/winesensed]
 *                                   [--map image=file,producer=winery,...] [--dry]
 *
 * The dataset's per-image table (CSV or JSONL; parquet is not readable here)
 * is matched to the photos in <data>/images by image id — the filename
 * without extension — and written to <data>/labels.jsonl in the layout
 * eval/data/README.md describes, with `"source":"winesensed"`. Rows already
 * in labels.jsonl from another source are kept; a row for the same file from
 * this source is replaced, so the import can be re-run.
 *
 * Column names are guessed from common spellings (winery / producer,
 * wine / name, vintage / year, region, country, appellation, grapes /
 * variety); `--map` overrides any guess as <column>=<field>.
 */

import fs from 'node:fs';
import path from 'node:path';

const FIELDS = ['file', 'winery', 'wine', 'vintage', 'region', 'country', 'appellation', 'grapes'];
const GUESSES = {
  file: ['image', 'image_id', 'imageid', 'img', 'photo', 'file', 'filename', 'id'],
  winery: ['winery', 'producer', 'winery_name', 'estate', 'domaine'],
  wine: ['wine', 'wine_name', 'name', 'title', 'cuvee', 'label'],
  vintage: ['vintage', 'year'],
  region: ['region', 'region_name', 'sub_region'],
  country: ['country', 'country_name'],
  appellation: ['appellation', 'denomination', 'aoc', 'doc'],
  grapes: ['grapes', 'grape', 'variety', 'varieties', 'varietal', 'grape_variety', 'grape_varieties'],
};

/** RFC 4180-ish CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((v) => v !== '')) rows.push(row); }
  if (!rows.length) return [];
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

export function readTable(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.jsonl?$/i.test(file)) {
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
    return trimmed.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  return parseCsv(text);
}

/** Which column feeds which field: explicit --map first, then the guesses. */
export function columnMap(columns, override = '') {
  const map = {};
  for (const pair of override.split(',').filter(Boolean)) {
    const [col, field] = pair.split('=');
    if (FIELDS.includes(field)) map[field] = col;
  }
  const lower = new Map(columns.map((c) => [c.toLowerCase().trim().replace(/[\s-]+/g, '_'), c]));
  for (const field of FIELDS) {
    if (map[field]) continue;
    const hit = GUESSES[field].find((g) => lower.has(g));
    if (hit) map[field] = lower.get(hit);
  }
  return map;
}

const stem = (name) => String(name).split('/').pop().replace(/\.[a-z0-9]+$/i, '');
const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = Array.isArray(v) ? v.join(', ') : String(v).trim();
  return s && s.toLowerCase() !== 'nan' && s.toLowerCase() !== 'null' && s !== 'N.V.' ? s : null;
};

export function toRows(table, map, present) {
  const out = [];
  for (const r of table) {
    if (!map.file) break;
    const ids = String(r[map.file] ?? '').split(/[;|]/).map(stem).filter(Boolean);
    for (const id of ids) {
      const file = present.get(id);
      if (!file) continue;
      const row = { file };
      for (const field of FIELDS.slice(1)) row[field] = map[field] ? clean(r[map[field]]) : null;
      if (row.vintage) row.vintage = String(row.vintage).match(/\d{4}/)?.[0] ?? null;
      row.source = 'winesensed';
      out.push(row);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
  const input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--data' && args[i - 1] !== '--map');
  if (!input) { console.error('usage: node eval/import-winesensed.mjs <metadata.csv|.jsonl> [--data dir] [--map col=field,...] [--dry]'); process.exit(2); }
  const dataDir = path.resolve(opt('data') || 'eval/data/winesensed');
  const dry = args.includes('--dry');

  const table = readTable(input);
  if (!table.length) { console.error('empty table'); process.exit(2); }
  const map = columnMap(Object.keys(table[0]), opt('map') || '');
  console.error('columns:', Object.keys(table[0]).join(', '));
  console.error('mapping:', JSON.stringify(map));
  if (!map.file) { console.error('no image-id column found — pass --map <column>=file'); process.exit(2); }

  const imagesDir = path.join(dataDir, 'images');
  const present = new Map(fs.readdirSync(imagesDir).map((f) => [stem(f), f]));
  const rows = toRows(table, map, present);
  console.error(`${rows.length} of ${present.size} photos matched (${table.length} table rows)`);

  const labelsPath = path.join(dataDir, 'labels.jsonl');
  const kept = fs.existsSync(labelsPath)
    ? fs.readFileSync(labelsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.source !== 'winesensed')
    : [];
  const merged = [...kept, ...rows];
  if (dry) { console.log(JSON.stringify(rows.slice(0, 5), null, 1)); process.exit(0); }
  fs.writeFileSync(labelsPath, merged.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.error(`wrote ${merged.length} rows to ${path.relative(process.cwd(), labelsPath)} (${kept.length} kept from other sources)`);
}
