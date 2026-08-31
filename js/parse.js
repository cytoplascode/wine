/* Turning recognised label text into candidate field values.
 *
 * Every value produced here is a guess that lands in an editable form field, so
 * the heuristics aim to be right often and never to be silently confident. Pure:
 * no DOM, so it runs under `node --test`.
 */

import {
  VARIETALS,
  APPELLATIONS,
  COUNTRIES,
  TYPE_WORDS,
  NOISE_PATTERNS,
  PRODUCER_PREFIXES,
  PRODUCER_SUFFIXES,
  VINEYARD_PATTERNS,
  NON_VINTAGE_MARKERS,
} from './wine-data.js';

/** Accent-folded, punctuation-flattened, lower case. Apostrophes survive so
 *  "nero d'avola" and "barbera d'asti" still match. */
export function normalize(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip combining accents
    .replace(/[’`´]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const contains = (haystack, needle) => ` ${haystack} `.includes(` ${needle} `);

/* Longest first, so "Chianti Classico" is tried before "Chianti". */
const byLengthDesc = (a, b) => normalize(b[0]).length - normalize(a[0]).length;
const SORTED_APPELLATIONS = [...APPELLATIONS].sort(byLengthDesc);
const SORTED_COUNTRIES = [...COUNTRIES].sort(byLengthDesc);
const SORTED_VARIETALS = [...VARIETALS].sort(byLengthDesc);

/**
 * Boilerplate worth catching even when recognition has mangled it. A dark
 * label turned "MIS EN BOUTEILLE AU CHÂTEAU" into "MIS EN BOUTEIT.T.E AU
 * CHATEAU", which the exact patterns missed — and unclaimed boilerplate is
 * exactly what the name heuristics then reach for.
 */
const FUZZY_NOISE = [
  'mis en bouteille', 'contains sulfites', 'contains sulphites',
  'product of', 'produce of', 'estate bottled', 'grand vin',
  'government warning', 'imported by', 'wine of origin',
  'denominazione di origine', 'denominacion de origen',
];

/**
 * A word one edit away from a short varietal name, but a real producer or
 * place name rather than a garbled grape — "Joseph Mellot" is not a misread
 * "Merlot". Fuzzy matching exists for OCR corruption on long, distinctive
 * names ("Gewürztraminer" mangled six ways is still unambiguously that word);
 * on a short common one, an edit distance of 1 reaches other real words too
 * easily to tell corruption from coincidence. Exact matches are unaffected.
 */
const VARIETAL_LOOKALIKES = new Set(['mellot']);

export function isNoise(text) {
  if (NOISE_PATTERNS.some((re) => re.test(text))) return true;

  const words = normalize(text).split(' ').filter(Boolean);
  return FUZZY_NOISE.some((phrase) => {
    const needle = normalize(phrase);
    return findPhrase(words, needle, Math.max(1, Math.floor(needle.length * 0.25))) >= 0;
  });
}

const isYearOnly = (text) => /^\s*(19|20)\d{2}\s*$/.test(text);

/**
 * Read a label.
 * `lines` carry `{ text, height, top }`; `text` is the whole recognised block.
 * Returns `{ fields, auto }` — the values found, and which keys they filled.
 */
export function parseLabel({ text = '', lines = [] } = {}, now = new Date()) {
  const source = lines.length
    ? lines
    : text.split('\n').map((t, i) => ({ text: t.trim(), height: 0, top: i }));

  const merged = mergeWrappedLines(
    joinRowFragments(source.filter((line) => line.text.trim())),
  );
  const normalizedLines = merged.map((line) => normalize(line.text));
  const fullText = normalizedLines.join(' ');

  const fields = {};
  const claimed = new Set();

  merged.forEach((line, i) => { if (isNoise(line.text)) claimed.add(i); });

  const vintage = findVintage(merged, normalizedLines, now);
  if (vintage) {
    fields.Vintage = String(vintage.year);
    claimed.add(vintage.lineIndex);
  }

  const varieties = findVarieties(fullText);
  if (varieties.length) {
    fields.Varieties = varieties.map((v) => v.name).join(', ');
    markLinesContaining(normalizedLines, varieties.map((v) => v.needle), claimed);
  }

  const appellation = findAppellation(merged, normalizedLines);
  if (appellation) {
    fields.Appelation = appellation.name;
    if (appellation.country) fields.Country = appellation.country;
    if (appellation.region) fields.Region = appellation.region;
    claimed.add(appellation.lineIndex);
  }

  if (!fields.Country) {
    const country = findCountry(fullText);
    if (country) {
      fields.Country = country.name;
      markLinesContaining(normalizedLines, [country.needle], claimed);
    }
  }

  const vineyard = findVineyard(merged, claimed);
  if (vineyard) {
    fields.Vineyard = vineyard.name;
    claimed.add(vineyard.lineIndex);
  }

  const type = findType(fullText) || colourOfVarieties(varieties);
  if (type) fields.Type = type;

  const winemaker = findWinemaker(merged, normalizedLines, claimed);
  if (winemaker) {
    fields.Winemaker = winemaker.name;
    claimed.add(winemaker.lineIndex);
  }

  const wineName = findWineName(merged, normalizedLines, claimed);
  if (wineName) {
    fields.WineName = wineName.name;
    claimed.add(wineName.lineIndex);
  }

  return { fields, auto: Object.keys(fields) };
}

/* ── Line assembly ──────────────────────────────────────────────────── */

/**
 * Sparse-text recognition returns each visual line separately, so a wrapped
 * name arrives as "CHÂTEAU LA" + "POMPE". Rejoin neighbours of similar size
 * that sit tight against each other.
 */
/**
 * Rejoin pieces of one visual line that recognition split horizontally.
 *
 * Curvature and glare make Tesseract break a single line into several, so
 * "APPELLATION SAINT-ESTÈPHE" arrives as "APPE", "LLATION SAINT-ESTE", "PHE",
 * each with its own box. Anything sharing a row and sitting close enough is
 * reassembled left to right before the field heuristics see it.
 */
export function joinRowFragments(lines) {
  if (!lines.some((line) => line.right > line.left)) return lines.map((line) => ({ ...line }));

  const remaining = lines.map((line) => ({ ...line }));
  const rows = [];

  while (remaining.length) {
    const seed = remaining.shift();
    const row = [seed];

    for (let i = remaining.length - 1; i >= 0; i--) {
      if (row.some((member) => sameRow(member, remaining[i]))) {
        row.push(remaining.splice(i, 1)[0]);
      }
    }

    row.sort((a, b) => a.left - b.left);
    rows.push({
      text: row.map((piece) => piece.text).join(' ').replace(/\s+/g, ' ').trim(),
      height: Math.max(...row.map((piece) => piece.height)),
      top: Math.min(...row.map((piece) => piece.top)),
      left: Math.min(...row.map((piece) => piece.left)),
      right: Math.max(...row.map((piece) => piece.right)),
      confidence: Math.min(...row.map((piece) => piece.confidence ?? 0)),
    });
  }

  return rows.sort((a, b) => a.top - b.top);
}

function sameRow(a, b) {
  if (!a.height || !b.height) return false;

  const ratio = a.height / b.height;
  if (ratio < 0.6 || ratio > 1.67) return false;

  // Vertical spans must genuinely overlap, not merely be near each other.
  const overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (overlap < Math.min(a.height, b.height) * 0.5) return false;

  // And they must be side by side, not the same words found twice.
  const gap = Math.max(a.left, b.left) - Math.min(a.right, b.right);
  return gap < Math.max(a.height, b.height) * 2.5;
}

export function mergeWrappedLines(lines) {
  if (!lines.some((line) => line.height > 0)) return lines.map((line) => ({ ...line }));

  const out = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (previous && canMerge(previous, line)) {
      previous.text = `${previous.text} ${line.text}`;
      previous.height = Math.max(previous.height, line.height);
      continue;
    }
    out.push({ ...line });
  }
  return out;
}

function canMerge(a, b) {
  if (!a.height || !b.height) return false;
  // A vintage sits alone, however close it is to the name above it.
  if (isYearOnly(a.text) || isYearOnly(b.text)) return false;

  const ratio = a.height / b.height;
  if (ratio < 0.6 || ratio > 1.67) return false;

  const gap = b.top - (a.top + a.height);
  return gap >= -a.height * 0.5 && gap < a.height * 0.9;
}

function markLinesContaining(normalizedLines, needles, claimed) {
  normalizedLines.forEach((line, i) => {
    if (needles.some((needle) => contains(line, needle))) claimed.add(i);
  });
}

/* ── Vintage ────────────────────────────────────────────────────────── */

function findVintage(lines, normalizedLines, now) {
  const maxYear = now.getFullYear() + 1;
  const candidates = [];

  normalizedLines.forEach((normalized, i) => {
    const pattern = /\b(?:19|20)\d{2}\b/g;
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      const year = Number(match[0]);
      if (year < 1900 || year > maxYear) continue;

      // "EST. 1885" and "SINCE 1749" are the estate's age, not the vintage.
      const preceding = normalized.slice(0, match.index).trim().split(' ').pop() || '';
      if (NON_VINTAGE_MARKERS.includes(preceding)) continue;

      candidates.push({
        year,
        lineIndex: i,
        alone: normalized === match[0],
        height: lines[i].height || 0,
      });
    }
  });

  if (!candidates.length) return null;

  // A year printed on a line of its own is the vintage; otherwise the biggest.
  candidates.sort((a, b) => (b.alone - a.alone) || (b.height - a.height));
  return candidates[0];
}

/* ── Varieties ──────────────────────────────────────────────────────── */

function findVarieties(fullText) {
  const words = fullText.split(' ');
  const found = [];

  for (const [name] of SORTED_VARIETALS) {
    const needle = normalize(name);
    const at = findPhrase(words, needle, undefined, VARIETAL_LOOKALIKES);
    if (at < 0) continue;
    // Skip a grape already covered by a longer one: "Cabernet Sauvignon"
    // must not also yield "Sauvignon Blanc"'s "Sauvignon".
    if (found.some((v) => v.needle.includes(needle))) continue;
    found.push({ name, needle, at });
  }

  found.sort((a, b) => a.at - b.at);
  return found;
}

function colourOfVarieties(varieties) {
  if (!varieties.length) return '';
  const colours = new Set();
  for (const variety of varieties) {
    const entry = VARIETALS.find(([name]) => name === variety.name);
    if (entry) colours.add(entry[1]);
  }
  return colours.size === 1 ? [...colours][0] : '';
}

/**
 * Exact phrase match, then a distance-tolerant pass for longer names, because
 * OCR mangles the likes of "Gewürztraminer" more often than not.
 *
 * `fuzzyExclude` withholds specific words from that tolerant pass — a real
 * word close enough in spelling to collide with a short target, where fuzzy
 * matching would rather guess wrong than leave the field blank. It never
 * blocks an exact match.
 */
function findPhrase(words, needle, explicitTolerance, fuzzyExclude) {
  const parts = needle.split(' ');
  const tolerance = explicitTolerance ?? (
    needle.length <= 5 ? 0 : needle.length <= 9 ? 1 : 2
  );

  for (let i = 0; i + parts.length <= words.length; i++) {
    const window = words.slice(i, i + parts.length).join(' ');
    if (window === needle) return i;
    if (!tolerance) continue;
    if (fuzzyExclude && fuzzyExclude.has(window)) continue;
    if (Math.abs(window.length - needle.length) > tolerance) continue;
    if (levenshtein(window, needle) <= tolerance) return i;
  }
  return -1;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/* ── Appellation, country, region ───────────────────────────────────── */

/** Lines that announce themselves as the appellation. */
const APPELLATION_MARKER = /\b(appellation|denominazione|denominaci[oó]n|wine of origin|DOCG|DOCa|DOC|DOP|AOC|AOP|IGP|IGT|AVA)\b/i;

function findAppellation(lines, normalizedLines) {
  const search = (indices) => {
    for (const [name, country, region] of SORTED_APPELLATIONS) {
      const needle = normalize(name);
      for (const i of indices) {
        if (contains(normalizedLines[i], needle)) return { name, country, region, lineIndex: i };
      }
    }
    return null;
  };

  const marked = lines
    .map((line, i) => (APPELLATION_MARKER.test(line.text) ? i : -1))
    .filter((i) => i >= 0);

  // A place name on the line that says "Appellation … Contrôlée" outranks the
  // same kind of word appearing anywhere else on the label — a cuvée called
  // "Saint-Julien" must not outvote the Margaux the bottle actually claims.
  const declared = search(marked);
  if (declared) return declared;

  for (const i of marked) {
    const raw = lines[i].text;

    const french = raw.match(/appellation\s+(.+?)\s+(?:contr[oôóò]l[ée]{1,2}e?|prot[ée]g[ée]e)\b/i);
    if (french) return { name: tidy(french[1]), country: '', region: '', lineIndex: i };

    const abbreviated = raw.match(/^(.*?)\s*\b(?:DOCG|DOCa|DOC|DOP?|AOC|AOP|IGP|IGT|AVA)\b/i);
    if (abbreviated && abbreviated[1].trim().length > 2) {
      return { name: tidy(abbreviated[1]), country: '', region: '', lineIndex: i };
    }
  }

  return search(lines.map((_, i) => i));
}

function findCountry(fullText) {
  for (const [printed, name] of SORTED_COUNTRIES) {
    const needle = normalize(printed);
    if (contains(fullText, needle)) return { name, needle };
  }
  return null;
}

function findVineyard(lines, claimed) {
  for (let i = 0; i < lines.length; i++) {
    if (claimed.has(i)) continue;
    for (const pattern of VINEYARD_PATTERNS) {
      const match = lines[i].text.match(pattern);
      if (match && match[1] && match[1].trim().length > 2) {
        return { name: tidy(match[1]), lineIndex: i };
      }
    }
  }
  return null;
}

/* ── Type ───────────────────────────────────────────────────────────── */

function findType(fullText) {
  for (const [type, words] of TYPE_WORDS) {
    if (words.some((word) => contains(fullText, normalize(word)))) return type;
  }
  return '';
}

/* ── Producer and cuvée ─────────────────────────────────────────────── */

function findWinemaker(lines, normalizedLines, claimed) {
  // A naming word is worth more than size: "Château X" is unambiguous.
  for (let i = 0; i < lines.length; i++) {
    if (claimed.has(i)) continue;
    const normalized = normalizedLines[i];
    const words = normalized.split(' ');
    if (words.length < 2) continue;

    const prefixed = PRODUCER_PREFIXES.some((p) => normalized.startsWith(`${normalize(p)} `));
    const suffixed = PRODUCER_SUFFIXES.some((s) => normalized.endsWith(` ${normalize(s)}`));
    if (prefixed || suffixed) return { name: tidy(lines[i].text), lineIndex: i };
  }

  const tallest = tallestUnclaimed(lines, claimed);
  return tallest ? { name: tidy(tallest.text), lineIndex: tallest.index } : null;
}

function findWineName(lines, normalizedLines, claimed) {
  for (let i = 0; i < lines.length; i++) {
    if (claimed.has(i)) continue;
    if (/^(cuv[ée]e|selecci[oó]n|selezione|reserva|riserva|gran reserva)\b/i.test(lines[i].text.trim())) {
      return { name: tidy(lines[i].text), lineIndex: i };
    }
  }

  const tallest = tallestUnclaimed(lines, claimed);
  return tallest ? { name: tidy(tallest.text), lineIndex: tallest.index } : null;
}

/**
 * Could this line be somebody's name, or is it wreckage?
 *
 * The tallest-unclaimed fallback will otherwise happily nominate whatever is
 * left over — "VOL", "750 Mb", half an appellation — and `WineName` feeds
 * `Name`, which feeds the note's filename. An empty field is much better than
 * a wrong one, and `composeName` already collapses gracefully around a gap.
 */
export function looksLikeName(text, confidence = 100) {
  const normalized = normalize(text);
  if (!normalized || isNoise(text) || isYearOnly(text)) return false;
  if (confidence && confidence < 55) return false;

  const letters = normalized.replace(/[^a-z]/g, '');
  if (letters.length < 4) return false;

  // Mostly digits is a measurement or a code, not a name.
  const digits = normalized.replace(/[^0-9]/g, '').length;
  if (digits > letters.length) return false;

  // Units and other stray tokens that survive on their own.
  const words = normalized.split(' ').filter(Boolean);
  const STRAY = new Set(['vol', 'ml', 'cl', 'alc', 'abv', 'au', 'de', 'du', 'la', 'le', 'el']);
  if (words.length === 1 && (words[0].length < 4 || STRAY.has(words[0]))) return false;

  return words.some((word) => word.length >= 3);
}

function tallestUnclaimed(lines, claimed) {
  let best = null;
  lines.forEach((line, index) => {
    if (claimed.has(index)) return;
    if (!looksLikeName(line.text, line.confidence)) return;
    if (!best || line.height > best.height) best = { ...line, index };
  });
  return best;
}

/** Tidy a captured fragment: collapse spaces, drop trailing punctuation. */
function tidy(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.·•–—-]+|[\s,.·•–—-]+$/g, '')
    .trim();
}
