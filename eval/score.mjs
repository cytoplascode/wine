/* Field-level scoring for the extraction bake-off.
 *
 * Pure — no DOM, no I/O — so it runs under `node --test` and inside the
 * Playwright driver alike. Ground-truth rows use dataset-side keys (winery,
 * wine, vintage, …); predictions use the app's schema keys (Winemaker,
 * WineName, Vintage, …). FIELD_MAP joins the two.
 *
 * A field only counts when the truth has a value: a dataset row with no
 * region is not a miss for the extractor, it is simply not scored.
 */

import { normalize } from '../js/parse.js';

/** dataset key → app schema key */
export const FIELD_MAP = Object.freeze({
  winery: 'Winemaker',
  wine: 'WineName',
  vintage: 'Vintage',
  region: 'Region',
  country: 'Country',
  appellation: 'Appelation',
  grapes: 'Varieties',
});

export const DEFAULT_THRESHOLD = 0.6;

export const tokens = (s) => normalize(s).split(' ').filter(Boolean);

export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Token-set similarity with a containment bonus: "Ausone" against "Château
 *  Ausone" is a hit even though Jaccard alone would say 0.5. */
export function nameSimilarity(truth, pred) {
  const t = tokens(truth);
  const p = tokens(pred);
  if (!t.length) return null;
  if (!p.length) return 0;
  const j = jaccard(t, p);
  // Whole-token containment only: "ausone" inside "chateau ausone" is a hit,
  // but a fragment like "tez" inside "tezi winery" is a partial read, not one.
  const [short, long] = t.length <= p.length ? [t, p] : [p, t];
  const longSet = new Set(long);
  const contained = short.some((x) => x.length >= 3) && short.every((x) => longSet.has(x));
  return contained ? Math.max(j, DEFAULT_THRESHOLD) : j;
}

const splitList = (s) => String(s || '')
  .split(/[,;/&]|\band\b/i)
  .map((x) => normalize(x))
  .filter(Boolean);

/** Grape lists: set similarity over normalised names, order-insensitive. */
export function listSimilarity(truth, pred) {
  const t = splitList(truth);
  const p = splitList(pred);
  if (!t.length) return null;
  if (!p.length) return 0;
  return jaccard(t, p);
}

const digits = (s) => String(s || '').match(/\d{4}/)?.[0] || '';

/** Returns { sim, hit } or null when the truth is empty (unscored). */
export function compareField(datasetKey, truth, pred, threshold = DEFAULT_THRESHOLD) {
  if (truth === null || truth === undefined || String(truth).trim() === '') return null;
  if (datasetKey === 'vintage') {
    const hit = digits(truth) !== '' && digits(truth) === digits(pred);
    return { sim: hit ? 1 : 0, hit };
  }
  const sim = datasetKey === 'grapes'
    ? listSimilarity(truth, pred)
    : nameSimilarity(truth, pred);
  if (sim === null) return null;
  return { sim, hit: sim >= threshold };
}

/**
 * rows: [{ file, truth: {winery,…}, pred: {Winemaker,…} }]
 * Returns per-field accuracy + mean similarity, an overall figure, and the
 * worst rows so a bad run can be looked at rather than just counted.
 */
export function score(rows, { threshold = DEFAULT_THRESHOLD, worstN = 10 } = {}) {
  const perField = {};
  for (const key of Object.keys(FIELD_MAP)) perField[key] = { n: 0, hits: 0, simSum: 0 };
  const rowScores = [];

  for (const row of rows) {
    let n = 0;
    let hits = 0;
    const misses = [];
    for (const [dsKey, appKey] of Object.entries(FIELD_MAP)) {
      const r = compareField(dsKey, row.truth?.[dsKey], row.pred?.[appKey], threshold);
      if (!r) continue;
      const f = perField[dsKey];
      f.n += 1;
      f.simSum += r.sim;
      n += 1;
      if (r.hit) { f.hits += 1; hits += 1; } else {
        misses.push(`${dsKey}: "${row.truth[dsKey]}" ≠ "${row.pred?.[appKey] ?? ''}"`);
      }
    }
    rowScores.push({ file: row.file, n, hits, acc: n ? hits / n : null, misses });
  }

  let totalN = 0;
  let totalHits = 0;
  for (const key of Object.keys(perField)) {
    const f = perField[key];
    f.acc = f.n ? f.hits / f.n : null;
    f.meanSim = f.n ? f.simSum / f.n : null;
    delete f.simSum;
    totalN += f.n;
    totalHits += f.hits;
  }

  const worst = rowScores
    .filter((r) => r.n > 0)
    .sort((a, b) => a.acc - b.acc || b.misses.length - a.misses.length)
    .slice(0, worstN);

  return {
    rows: rows.length,
    overall: totalN ? totalHits / totalN : null,
    scoredFields: totalN,
    perField,
    worst,
  };
}

const pct = (x) => (x === null ? '   —' : `${Math.round(x * 100)}%`.padStart(4));

export function formatTable(summary, label = '') {
  const lines = [];
  if (label) lines.push(label);
  lines.push(`rows: ${summary.rows}   scored fields: ${summary.scoredFields}   overall: ${pct(summary.overall)}`);
  lines.push('field         n   acc   sim');
  for (const [key, f] of Object.entries(summary.perField)) {
    if (!f.n) continue;
    lines.push(`${key.padEnd(12)} ${String(f.n).padStart(3)}  ${pct(f.acc)}  ${pct(f.meanSim)}`);
  }
  if (summary.worst.length) {
    lines.push('worst:');
    for (const w of summary.worst) {
      lines.push(`  ${w.file}  ${pct(w.acc)}  ${w.misses.join(' | ')}`);
    }
  }
  return lines.join('\n');
}
