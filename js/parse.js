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
  DESCRIPTOR_WORDS,
  MARKETING_PATTERNS,
  PROSE_WORDS,
  STOPWORDS,
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
 * Long boilerplate words that a small photo mangles *and* runs together:
 * "INDICAZIONE GEOGRAFICA TIPICA" arrives as "DICAZIONEGEOGANIATIN", one
 * word with no spaces for the phrase matcher to work with. Each of these is
 * looked for as an approximate substring of the line with its spaces
 * removed; two edits on a nine-letter word is far from any real name.
 */
const BOILERPLATE_WORDS = [
  'indicazione', 'geografica', 'denominazione', 'controllata', 'garantita',
  'appellation', 'controlee', 'protegee', 'imbottigliato', 'embotellado',
  'produced', 'bottled', 'sulfites', 'sulphites', 'contains', 'biologico',
];

function fuzzyContainsWord(squashed, word, tolerance = 2) {
  if (squashed.length + tolerance < word.length) return false;
  for (let start = 0; start < squashed.length; start += 1) {
    for (let len = word.length - tolerance; len <= word.length + tolerance; len += 1) {
      if (start + len > squashed.length) break;
      if (levenshtein(squashed.slice(start, start + len), word) <= tolerance) return true;
    }
  }
  return false;
}

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
  if (FUZZY_NOISE.some((phrase) => {
    const needle = normalize(phrase);
    return findPhrase(words, needle, Math.max(1, Math.floor(needle.length * 0.25))) >= 0;
  })) return true;

  const squashed = words.join('');
  return squashed.length >= 8 && BOILERPLATE_WORDS.some((w) => fuzzyContainsWord(squashed, w));
}

/** The longest dictionary appellation this normalized line contains. */
function appellationIn(normalized) {
  for (const entry of SORTED_APPELLATIONS) {
    const needle = normalize(entry[0]);
    if (contains(normalized, needle)) return { entry, needle };
  }
  return null;
}

/**
 * A long place name read as one word with a few letters wrong:
 * "BRUNELLOMONTALCIN" is Brunello di Montalcino with the spaces lost and
 * two letters dropped. Only lines that are a single long word are tried,
 * against names of ten letters or more, within 15% of their length — an
 * unknown producer's name is never that close to a dictionary entry.
 */
const SQUASHED_APPELLATIONS = SORTED_APPELLATIONS
  .map((entry) => [entry, normalize(entry[0]).replace(/ /g, '')])
  .filter(([, squashed]) => squashed.length >= 10);

function fuzzyAppellation(normalized) {
  if (normalized.includes(' ') || normalized.length < 10) return null;
  for (const [entry, squashed] of SQUASHED_APPELLATIONS) {
    const tolerance = Math.floor(squashed.length * 0.15);
    if (Math.abs(squashed.length - normalized.length) > tolerance) continue;
    if (levenshtein(normalized, squashed) <= tolerance) return entry;
  }
  return null;
}

/** "MOULIS-EN-MÉDOC", "Chianti Classico": a place, with at most one other
 *  word around it. Such a line names where the wine is from, never who made
 *  it, and is handed to the wine-name fallback under its dictionary spelling. */
function isAppellationOnly(normalized) {
  const found = appellationIn(normalized);
  if (found) return leftoverWords(normalized, [found.needle]) <= 1;
  return !!fuzzyAppellation(normalized);
}

const isYearOnly = (text) => /^\s*(19|20)\d{2}\s*$/.test(text);

const DESCRIPTORS = new Set(DESCRIPTOR_WORDS);
const PROSE = new Set(PROSE_WORDS);
const STOP = new Set(STOPWORDS);

/** "DRY RED GEORGIAN WINE": every word describes the bottle, none names it. */
export function isDescriptorLine(text) {
  const words = normalize(text).split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => DESCRIPTORS.has(w));
}

export const isMarketingLine = (text) => MARKETING_PATTERNS.some((re) => re.test(text.trim()));

/** Back-label prose rather than a name: an English function word anywhere
 *  ("aged in the Qvevri", "ed oak. On the") — a leading "the" is a name's
 *  privilege — or a long line with the stopword density of a sentence. */
export function isProse(text) {
  const words = normalize(text).split(' ').filter(Boolean);
  if (!words.length) return false;
  if (words.some((w, i) => PROSE.has(w) || (w === 'the' && i > 0))) return true;
  const stops = words.filter((w) => STOP.has(w)).length;
  return words.length >= 8 && stops >= 2;
}

/** A recognised fragment too small and too uncertain to be glued onto a
 *  neighbour: "88", "HS", "%" beside a real word on the same row. */
function isJunkFragment(line) {
  const text = (line.text || '').trim();
  const letters = normalize(text).replace(/[^a-z]/g, '');
  if (/^[\d\s.,%-]+$/.test(text)) return true;
  if (/^\d{2,4}\s?(ml|cl|l)$/i.test(text)) return true;
  return (line.confidence ?? 100) < 50 && letters.length <= 2;
}

/** Does this line, on its own, already say what it is — a grape, a place, a
 *  year, packaging, a description? Such a line is a field in its own right
 *  and must not be fused with the line above it. */
function isFieldLike(text) {
  if (isYearOnly(text) || isNoise(text) || isDescriptorLine(text)) return true;
  if (isMarketingLine(text) || isProse(text) || CUVEE_PREFIX.test(text.trim())) return true;
  const normalized = normalize(text);
  const hit = (list) => list.some(([name]) => contains(normalized, normalize(name)));
  return hit(SORTED_VARIETALS) || hit(SORTED_COUNTRIES) || hit(SORTED_APPELLATIONS)
    || !!fuzzyAppellation(normalized);
}

/** Lines that open with a word meaning "this is the cuvée's name". */
const CUVEE_PREFIX = /^(cuv[ée]e|selecci[oó]n|selezione|reserva|riserva|gran reserva|bin\s+\d+|n[o°º]\s*\d+)\b/i;

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

  // Words of a place named on the label are never a misread grape: the
  // "Tarantino" IGT is not "Sagrantino" two letters off.
  const placeWords = new Set(SORTED_APPELLATIONS
    .map(([name]) => normalize(name))
    .filter((needle) => contains(fullText, needle))
    .flatMap((needle) => needle.split(' ')));
  const varieties = findVarieties(fullText, placeWords);
  let varietyLine = null;
  if (varieties.length) {
    fields.Varieties = varieties.map((v) => v.name).join(', ');
    markLinesContaining(normalizedLines, varieties.map((v) => v.needle), claimed);
    varietyLine = bareLine(merged, normalizedLines, varieties.map((v) => v.needle), 2);
  }

  const appellation = findAppellation(merged, normalizedLines);
  let appellationLine = null;
  if (appellation) {
    fields.Appelation = appellation.name;
    if (appellation.country) fields.Country = appellation.country;
    if (appellation.region) fields.Region = appellation.region;
    claimed.add(appellation.lineIndex);
    const i = appellation.lineIndex;
    if (!APPELLATION_MARKER.test(merged[i].text)
        && leftoverWords(normalizedLines[i], [normalize(appellation.name)]) <= 1) {
      appellationLine = { ...merged[i], index: i, name: appellation.name };
    }
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

  const wineName = findWineName(merged, normalizedLines, claimed, { varietyLine, appellationLine });
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

  // Junk pieces are emitted as rows of their own rather than glued onto a
  // neighbour: a vintage or a volume still needs to exist as a line, but
  // "SHAVERDE 88 HS" and "11% Aladasturi Rosé" are not names.
  const apart = (line) => isJunkFragment(line) || isNoise(line.text);
  const junk = lines.filter(apart).map((line) => ({ ...line }));
  const remaining = lines.filter((line) => !apart(line)).map((line) => ({ ...line }));
  const rows = [...junk];

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
  // A line that is already a field of its own — a vintage, a grape, a place,
  // a description — never continues the line above it. This is what keeps
  // "NIMBI" and "RKATSITELI" apart when they sit close on a tall label.
  if (isFieldLike(a.text) || isFieldLike(b.text)) return false;
  if ((a.confidence ?? 100) < 50 || (b.confidence ?? 100) < 50) return false;

  const ratio = a.height / b.height;
  if (ratio < 0.7 || ratio > 1.43) return false;

  // Wrapped names sit tight; a gap of half a line is a new line.
  const gap = b.top - (a.top + a.height);
  return gap >= -a.height * 0.5 && gap < a.height * 0.5;
}

/** How many words of `normalized` are neither one of `needles` nor a
 *  descriptor — what is left once the grape or place and the adjectives
 *  around it are removed. "blend saperavi" → 1 ("blend"); "khikhvi" → 0. */
function leftoverWords(normalized, needles) {
  let rest = ` ${normalized} `;
  for (const needle of needles) rest = rest.split(` ${needle} `).join(' ');
  return rest.split(' ').filter((w) => w && !DESCRIPTORS.has(w)).length;
}

/** The tallest line that is essentially just one of `needles` (plus at most
 *  `maxLeftover` other words): "RKATSITELI", "BLEND SAPERAVI", "Aladasturi
 *  Rosé". On a varietal-labelled bottle that line *is* the wine's name. */
function bareLine(lines, normalizedLines, needles, maxLeftover) {
  let best = null;
  lines.forEach((line, index) => {
    const normalized = normalizedLines[index];
    if (!needles.some((needle) => contains(normalized, needle))) return;
    if (isProse(line.text) || isNoise(line.text)) return;
    if (leftoverWords(normalized, needles) > maxLeftover) return;
    if (!best || line.height > best.height) best = { ...line, index };
  });
  return best;
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

function findVarieties(fullText, excludeWords = new Set()) {
  const words = fullText.split(' ');
  const found = [];
  const exclude = new Set([...VARIETAL_LOOKALIKES, ...excludeWords]);

  for (const [name] of SORTED_VARIETALS) {
    const needle = normalize(name);
    const at = findPhrase(words, needle, undefined, exclude);
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

  // "Appellation Moulis Contrôlée" under a "MOULIS-EN-MÉDOC" headline: the
  // dictionary entry that contains the declared word is the one to record,
  // and the headline is the line to attribute it to.
  const fuller = (declaredWord) => {
    const entry = SORTED_APPELLATIONS.find(([name]) => {
      const needle = normalize(name);
      return needle !== declaredWord && contains(needle, declaredWord)
        && normalizedLines.some((line) => contains(line, needle));
    });
    if (!entry) return null;
    const at = normalizedLines.findIndex((line) => contains(line, normalize(entry[0])));
    return { name: entry[0], country: entry[1], region: entry[2], lineIndex: at };
  };

  // A place name on the line that says "Appellation … Contrôlée" outranks the
  // same kind of word appearing anywhere else on the label — a cuvée called
  // "Saint-Julien" must not outvote the Margaux the bottle actually claims.
  const declared = search(marked);
  if (declared) return fuller(normalize(declared.name)) || declared;

  for (const i of marked) {
    const raw = lines[i].text;

    const french = raw.match(/appellation\s+(.+?)\s+(?:contr[oôóò]l[ée]{1,2}e?|prot[ée]g[ée]e)\b/i);
    if (french) {
      return fuller(normalize(french[1])) || { name: tidy(french[1]), country: '', region: '', lineIndex: i };
    }

    const abbreviated = raw.match(/^(.*?)\s*\b(?:DOCG|DOCa|DOC|DOP?|AOC|AOP|IGP|IGT|AVA)\b/i);
    if (abbreviated && abbreviated[1].trim().length > 2) {
      return { name: tidy(abbreviated[1]), country: '', region: '', lineIndex: i };
    }
  }

  const exact = search(lines.map((_, i) => i));
  if (exact) return exact;
  for (let i = 0; i < lines.length; i += 1) {
    const entry = fuzzyAppellation(normalizedLines[i]);
    if (entry) return { name: entry[0], country: entry[1], region: entry[2], lineIndex: i };
  }
  return null;
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

const SUFFIX_WORDS = new Set(PRODUCER_SUFFIXES.flatMap((s) => normalize(s).split(' ')));
const TAIL_GLUE = new Set(['and', 'e', 'y', 'et', 'de', 'di', 'del', 'della', 'the']);

/** "Vineyard and Cellars", "ESTATE WINERY AND VINEYARDS": nothing but the
 *  words a producer's name ends with — the second line of a name that
 *  wrapped, never a name on its own. */
function isProducerTail(normalized) {
  const words = normalized.split(' ').filter(Boolean);
  return words.length > 0
    && words.some((w) => SUFFIX_WORDS.has(w))
    && words.every((w) => SUFFIX_WORDS.has(w) || TAIL_GLUE.has(w));
}

function findWinemaker(lines, normalizedLines, claimed) {
  // A naming word is worth more than size: "Château X" is unambiguous.
  for (let i = 0; i < lines.length; i++) {
    if (claimed.has(i)) continue;
    const normalized = normalizedLines[i];
    const words = normalized.split(' ');

    // A tail joins the name above it; on its own it names nobody.
    if (isProducerTail(normalized)) {
      const above = i - 1;
      if (above >= 0 && !claimed.has(above) && looksLikeName(lines[above].text, lines[above].confidence)
          && !isAppellationOnly(normalizedLines[above])) {
        claimed.add(i);
        return { name: `${tidy(lines[above].text)} ${tidy(lines[i].text)}`, lineIndex: above };
      }
      continue;
    }

    // "Lindeman's", "Penfolds'": a possessive on a lone word is a family name.
    if (words.length === 1 && /[a-z]'s?$/.test(normalized) && normalized.length >= 5) {
      return { name: tidy(lines[i].text), lineIndex: i };
    }
    if (words.length < 2) continue;

    const prefixed = PRODUCER_PREFIXES.some((p) => normalized.startsWith(`${normalize(p)} `));
    const suffixed = PRODUCER_SUFFIXES.some((s) => normalized.endsWith(` ${normalize(s)}`));
    if (prefixed || suffixed) return { name: tidy(lines[i].text), lineIndex: i };
  }

  const tallest = tallestUnclaimed(lines, claimed, (index) => (
    !isAppellationOnly(normalizedLines[index]) && !isProducerTail(normalizedLines[index])
  ));
  return tallest ? { name: tidy(tallest.text), lineIndex: tallest.index } : null;
}

function findWineName(lines, normalizedLines, claimed, { varietyLine, appellationLine } = {}) {
  for (let i = 0; i < lines.length; i++) {
    if (claimed.has(i)) continue;
    if (CUVEE_PREFIX.test(lines[i].text.trim())) {
      return { name: tidy(lines[i].text), lineIndex: i };
    }
  }

  const tallest = tallestUnclaimed(lines, claimed);
  // A line that is just a grape or just an appellation is, on most of the
  // world's labels, the wine's name — "Rkatsiteli", "Mukuzani", "Chablis".
  // It is certain to be a real word about this wine, which an unknown line
  // of similar size is not, so it wins unless the unknown line is clearly
  // the bigger one.
  // The appellation is given under its dictionary spelling: the recognised
  // line may carry a stray fragment beside it ("OELATION BORDEAUX SUPERIEUR").
  const backed = varietyLine || appellationLine;
  const named = (line) => ({ name: line.name || tidy(line.text), lineIndex: line.index });
  if (tallest && backed && backed.height >= tallest.height * 0.8) return named(backed);
  if (tallest) return { name: tidy(tallest.text), lineIndex: tallest.index };
  return backed ? named(backed) : null;
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
  if (isDescriptorLine(text) || isMarketingLine(text) || isProse(text)) return false;
  if (confidence && confidence < 65) return false;

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

function tallestUnclaimed(lines, claimed, accept = () => true) {
  let best = null;
  lines.forEach((line, index) => {
    if (claimed.has(index) || !accept(index)) return;
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
