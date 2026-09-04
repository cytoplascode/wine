import test from 'node:test';
import assert from 'node:assert/strict';

import { parseExifDate, parseExifLocation, localIsoDate } from '../js/exif.js';

/**
 * Assemble a minimal JPEG carrying one APP1/EXIF segment, byte by byte, so the
 * parser is exercised against the real TIFF layout rather than a canned blob.
 *
 * `dateTimeOriginal` goes in the Exif SubIFD, the tag a real photo actually
 * carries; `dateTimeOnly` goes straight in IFD0, the fallback a camera that
 * skips the SubIFD would leave. Either, both, or neither may be set.
 */
/**
 * `gps`, when given, is `{ latRef, lat, lonRef, lon }` where `lat`/`lon` are
 * each three `[numerator, denominator]` pairs — degrees, minutes, seconds,
 * exactly the rationals a real GPS IFD stores.
 */
function buildJpeg({ little = true, dateTimeOriginal, dateTimeOnly, gps } = {}) {
  const bytes = [];
  const push = (...values) => bytes.push(...values);
  const at = () => bytes.length;

  const u16 = (value) => (little
    ? push(value & 0xff, (value >> 8) & 0xff)
    : push((value >> 8) & 0xff, value & 0xff));
  const u32 = (value) => (little
    ? push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff)
    : push((value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff));
  const ascii = (text) => push(...Array.from(text, (c) => c.charCodeAt(0)));

  // ── TIFF payload, built into its own byte list so its length is known ──
  const tiff = [];
  const tpush = (...values) => tiff.push(...values);
  const tu16 = (value) => (little
    ? tpush(value & 0xff, (value >> 8) & 0xff)
    : tpush((value >> 8) & 0xff, value & 0xff));
  const tu32 = (value) => (little
    ? tpush(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff)
    : tpush((value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff));
  const tascii = (text) => tpush(...Array.from(text, (c) => c.charCodeAt(0)));

  tpush(...(little ? [0x49, 0x49] : [0x4d, 0x4d]));
  tu16(0x002a);
  tu32(8);                                     // IFD0 starts right after the header

  const ifd0Entries = [];
  if (dateTimeOnly) ifd0Entries.push('dateTimeOnly');
  if (dateTimeOriginal) ifd0Entries.push('subIfd');
  if (gps) ifd0Entries.push('gps');

  // Tag, type (4 = LONG, 2 = ASCII) and count for each possible IFD0 entry.
  const IFD0_SHAPE = {
    subIfd: [0x8769, 4, 1],
    gps: [0x8825, 4, 1],
    dateTimeOnly: [0x0132, 2, 20],
  };

  // IFD0
  tu16(ifd0Entries.length);
  const ifd0EntryOffsets = {};
  for (const kind of ifd0Entries) {
    ifd0EntryOffsets[kind] = tiff.length;
    const [tag, type, count] = IFD0_SHAPE[kind];
    tu16(tag);
    tu16(type);
    tu32(count);
    tpush(0, 0, 0, 0);                          // value patched in below, once offsets are known
  }
  tu32(0);                                      // no next IFD

  const subIfdStart = tiff.length;
  if (dateTimeOriginal) {
    tu16(1);
    const entryOffset = tiff.length;
    tu16(0x9003);
    tu16(2);
    tu32(20);
    tpush(0, 0, 0, 0);                          // patched below
    tu32(0);
    const stringOffset = tiff.length;
    tascii(`${dateTimeOriginal} 12:30:00\0`);
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, stringOffset, little);
    for (let i = 0; i < 4; i++) tiff[entryOffset + 8 + i] = view.getUint8(i);
  }

  if (dateTimeOnly) {
    const stringOffset = tiff.length;
    tascii(`${dateTimeOnly} 09:00:00\0`);
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, stringOffset, little);
    const entryOffset = ifd0EntryOffsets.dateTimeOnly + 8;
    for (let i = 0; i < 4; i++) tiff[entryOffset + i] = view.getUint8(i);
  }
  if (dateTimeOriginal) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, subIfdStart, little);
    const entryOffset = ifd0EntryOffsets.subIfd + 8;
    for (let i = 0; i < 4; i++) tiff[entryOffset + i] = view.getUint8(i);
  }

  if (gps) {
    const patchPointer = (entryOffset, target) => {
      const view = new DataView(new ArrayBuffer(4));
      view.setUint32(0, target, little);
      for (let i = 0; i < 4; i++) tiff[entryOffset + 8 + i] = view.getUint8(i);
    };

    const gpsIfdStart = tiff.length;
    tu16(4);   // GPSLatitudeRef, GPSLatitude, GPSLongitudeRef, GPSLongitude

    tu16(0x0001); tu16(2); tu32(2); tpush(gps.latRef.charCodeAt(0), 0, 0, 0);
    const latEntryOffset = tiff.length;
    tu16(0x0002); tu16(5); tu32(3); tpush(0, 0, 0, 0);
    tu16(0x0003); tu16(2); tu32(2); tpush(gps.lonRef.charCodeAt(0), 0, 0, 0);
    const lonEntryOffset = tiff.length;
    tu16(0x0004); tu16(5); tu32(3); tpush(0, 0, 0, 0);
    tu32(0);   // no next IFD

    const latDataOffset = tiff.length;
    for (const [num, den] of gps.lat) { tu32(num); tu32(den); }
    patchPointer(latEntryOffset, latDataOffset);

    const lonDataOffset = tiff.length;
    for (const [num, den] of gps.lon) { tu32(num); tu32(den); }
    patchPointer(lonEntryOffset, lonDataOffset);

    patchPointer(ifd0EntryOffsets.gps, gpsIfdStart);
  }

  // ── Wrap the TIFF payload in a JPEG APP1 segment ──
  push(0xff, 0xd8);                             // SOI
  push(0xff, 0xe1);                             // APP1
  const app1Length = 2 + 6 + tiff.length;        // length field itself + "Exif\0\0" + TIFF
  bytes.push((app1Length >> 8) & 0xff, app1Length & 0xff);   // JPEG segment lengths are always big-endian
  push(0x45, 0x78, 0x69, 0x66, 0x00, 0x00);      // "Exif\0\0"
  bytes.push(...tiff);

  return new Uint8Array(bytes).buffer;
}

test('reads DateTimeOriginal out of the Exif SubIFD', () => {
  const buffer = buildJpeg({ dateTimeOriginal: '2024:03:15' });
  assert.equal(parseExifDate(buffer), '2024-03-15');
});

test('works in both byte orders a camera might use', () => {
  assert.equal(parseExifDate(buildJpeg({ little: true, dateTimeOriginal: '2019:12:31' })), '2019-12-31');
  assert.equal(parseExifDate(buildJpeg({ little: false, dateTimeOriginal: '2019:12:31' })), '2019-12-31');
});

test('falls back to the IFD0 DateTime tag when there is no SubIFD', () => {
  const buffer = buildJpeg({ dateTimeOnly: '2021:07:04' });
  assert.equal(parseExifDate(buffer), '2021-07-04');
});

test('prefers DateTimeOriginal over the IFD0 fallback when both are present', () => {
  const buffer = buildJpeg({ dateTimeOriginal: '2024:03:15', dateTimeOnly: '2020:01:01' });
  assert.equal(parseExifDate(buffer), '2024-03-15');
});

test('a JPEG with no EXIF at all returns null', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9]);
  assert.equal(parseExifDate(bytes.buffer), null);
});

test('not a JPEG returns null rather than throwing', () => {
  assert.equal(parseExifDate(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), null);
  assert.equal(parseExifDate(new ArrayBuffer(0)), null);
});

test('a truncated EXIF segment returns null rather than throwing', () => {
  const full = new Uint8Array(buildJpeg({ dateTimeOriginal: '2024:03:15' }));
  assert.equal(parseExifDate(full.slice(0, 20).buffer), null);
});

/* ── GPS ────────────────────────────────────────────────────────────── */

const PARIS = {
  latRef: 'N', lat: [[48, 1], [51, 1], [24, 1]],       // 48°51'24" N
  lonRef: 'E', lon: [[2, 1], [21, 1], [3, 1]],          // 2°21'3" E
};

function closeTo(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} not close to ${expected}`);
}

test('reads GPS coordinates out of the GPS IFD', () => {
  const location = parseExifLocation(buildJpeg({ gps: PARIS }));
  assert.ok(location);
  closeTo(location.lat, 48 + 51 / 60 + 24 / 3600);
  closeTo(location.lon, 2 + 21 / 60 + 3 / 3600);
});

test('a southern and western position comes back negative', () => {
  const location = parseExifLocation(buildJpeg({
    gps: { latRef: 'S', lat: [[33, 1], [51, 1], [35, 1]], lonRef: 'W', lon: [[70, 1], [40, 1], [0, 1]] },
  }));
  closeTo(location.lat, -(33 + 51 / 60 + 35 / 3600));
  closeTo(location.lon, -(70 + 40 / 60));
});

test('GPS works in both byte orders a camera might use', () => {
  closeTo(parseExifLocation(buildJpeg({ little: true, gps: PARIS })).lat, 48 + 51 / 60 + 24 / 3600);
  closeTo(parseExifLocation(buildJpeg({ little: false, gps: PARIS })).lat, 48 + 51 / 60 + 24 / 3600);
});

test('a photo with a date but no GPS tags returns null for location', () => {
  assert.equal(parseExifLocation(buildJpeg({ dateTimeOriginal: '2024:03:15' })), null);
});

test('a photo with GPS but no date returns null for the date, and vice versa', () => {
  const buffer = buildJpeg({ gps: PARIS });
  assert.equal(parseExifDate(buffer), null);
  assert.ok(parseExifLocation(buffer));

  const dateOnly = buildJpeg({ dateTimeOriginal: '2024:03:15' });
  assert.equal(parseExifLocation(dateOnly), null);
});

test('a zeroed-out GPS IFD reads as no fix, not Null Island', () => {
  // What a phone that had location services off at capture time actually
  // writes: the tags are all present, but the rationals are 0/1.
  const location = parseExifLocation(buildJpeg({
    gps: { latRef: 'N', lat: [[0, 1], [0, 1], [0, 1]], lonRef: 'E', lon: [[0, 1], [0, 1], [0, 1]] },
  }));
  assert.equal(location, null);
});

test('an all-unset position (n/0 throughout) also reads as no fix', () => {
  // Folds to (0, 0) the same way the 0/1 case does, and is caught by the
  // same final check — not because an n/0 rational is rejected on its own
  // (see below: that would wrongly reject a real position too).
  const location = parseExifLocation(buildJpeg({
    gps: { latRef: 'N', lat: [[0, 0], [0, 0], [0, 0]], lonRef: 'E', lon: [[0, 0], [0, 0], [0, 0]] },
  }));
  assert.equal(location, null);
});

test('a real position with a zero seconds component still reads correctly', () => {
  // Guards against the fix over-firing: only an all-zero *result* is treated
  // as unset, not a coordinate that legitimately has a zero part.
  const location = parseExifLocation(buildJpeg({
    gps: { latRef: 'N', lat: [[48, 1], [51, 1], [0, 1]], lonRef: 'E', lon: [[2, 1], [21, 1], [0, 1]] },
  }));
  closeTo(location.lat, 48 + 51 / 60);
  closeTo(location.lon, 2 + 21 / 60);
});

test('a real position with an unset (n/0) seconds component still reads correctly', () => {
  // The actual shape a real report came back with: some encoders record
  // only degrees and decimal minutes and leave seconds as an explicit n/0
  // "not available" rather than 0/1 — rejecting the whole coordinate over
  // that one unset part is the bug this guards against.
  const location = parseExifLocation(buildJpeg({
    gps: { latRef: 'N', lat: [[48, 1], [51, 1], [0, 0]], lonRef: 'E', lon: [[2, 1], [21, 1], [0, 0]] },
  }));
  assert.ok(location);
  closeTo(location.lat, 48 + 51 / 60);
  closeTo(location.lon, 2 + 21 / 60);
});

test('a JPEG with no EXIF at all returns null for location too', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9]);
  assert.equal(parseExifLocation(bytes.buffer), null);
});

/* ── onError: temporary diagnostics for a report of real GPS data
 *    (confirmed present in Google Photos) not making it through. ── */

test('onError names the reason for each way a location comes back null', () => {
  const reasons = [];
  const onError = (reason) => reasons.push(reason);

  parseExifLocation(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9]).buffer, { onError });
  assert.match(reasons[0], /no EXIF data/);

  reasons.length = 0;
  parseExifLocation(buildJpeg({ dateTimeOriginal: '2024:03:15' }), { onError });
  assert.match(reasons[0], /no GPS tags/);

  reasons.length = 0;
  parseExifLocation(buildJpeg({
    gps: { latRef: 'N', lat: [[0, 1], [0, 1], [0, 1]], lonRef: 'E', lon: [[0, 1], [0, 1], [0, 1]] },
  }), { onError });
  assert.match(reasons[0], /0°, 0°/);

  // n/0 throughout folds to the same (0, 0) and hits the same check.
  reasons.length = 0;
  parseExifLocation(buildJpeg({
    gps: { latRef: 'N', lat: [[0, 0], [0, 0], [0, 0]], lonRef: 'E', lon: [[0, 0], [0, 0], [0, 0]] },
  }), { onError });
  assert.match(reasons[0], /0°, 0°/);
});

test('onError stays silent when a real position is found', () => {
  let called = false;
  parseExifLocation(buildJpeg({ gps: PARIS }), { onError: () => { called = true; } });
  assert.equal(called, false);
});

test('localIsoDate reports the calendar date, not the UTC one', () => {
  // A time chosen so a UTC-based formatter (toISOString) would report the
  // wrong day in any timezone west of UTC — the bug this function exists to
  // avoid.
  const date = new Date(2024, 2, 15, 0, 30);
  assert.equal(localIsoDate(date), '2024-03-15');
});
