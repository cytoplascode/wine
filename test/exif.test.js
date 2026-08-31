import test from 'node:test';
import assert from 'node:assert/strict';

import { parseExifDate, localIsoDate } from '../js/exif.js';

/**
 * Assemble a minimal JPEG carrying one APP1/EXIF segment, byte by byte, so the
 * parser is exercised against the real TIFF layout rather than a canned blob.
 *
 * `dateTimeOriginal` goes in the Exif SubIFD, the tag a real photo actually
 * carries; `dateTimeOnly` goes straight in IFD0, the fallback a camera that
 * skips the SubIFD would leave. Either, both, or neither may be set.
 */
function buildJpeg({ little = true, dateTimeOriginal, dateTimeOnly } = {}) {
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

  // IFD0
  tu16(ifd0Entries.length);
  const ifd0EntryOffsets = {};
  for (const kind of ifd0Entries) {
    ifd0EntryOffsets[kind] = tiff.length;
    tu16(kind === 'subIfd' ? 0x8769 : 0x0132);
    tu16(kind === 'subIfd' ? 4 : 2);            // LONG for the pointer, ASCII for a date string
    tu32(kind === 'subIfd' ? 1 : 20);
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

test('localIsoDate reports the calendar date, not the UTC one', () => {
  // A time chosen so a UTC-based formatter (toISOString) would report the
  // wrong day in any timezone west of UTC — the bug this function exists to
  // avoid.
  const date = new Date(2024, 2, 15, 0, 30);
  assert.equal(localIsoDate(date), '2024-03-15');
});
