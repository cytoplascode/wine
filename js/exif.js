/* The date and GPS position a label photo was taken at, so a scan can suggest
 * when the wine was drunk and where, instead of defaulting to today and
 * nothing.
 *
 * JPEG only — every photo this app produces or accepts on Chrome for Android
 * is one. Only the calendar date is read, since that is all "Drink date"
 * needs, and only coordinates for position — no altitude, no timestamp.
 * Anything unexpected (no EXIF, a different format, a truncated file, no GPS
 * tags) returns null rather than guessing.
 *
 * This only ever finds anything on a photo imported from the Gallery: a
 * photo taken with this app's own shutter is drawn through a `<canvas>` on
 * its way to a bitmap, which carries none of its source's EXIF forward. A
 * live GPS reading at the moment of capture (see camera.js) is what covers
 * that case instead.
 */

const EXIF_SUB_IFD = 0x8769;        // pointer from IFD0 to the Exif SubIFD
const DATE_TIME_ORIGINAL = 0x9003;  // in the SubIFD: when the shutter opened
const DATE_TIME = 0x0132;           // IFD0 fallback, for a camera that skips the SubIFD
const GPS_IFD = 0x8825;             // pointer from IFD0 to the GPS IFD
const GPS_LAT_REF = 0x0001;         // 'N' or 'S'
const GPS_LAT = 0x0002;             // degrees, minutes, seconds as three rationals
const GPS_LON_REF = 0x0003;         // 'E' or 'W'
const GPS_LON = 0x0004;

/** Today, as the calendar date the phone is currently on — not `toISOString()`,
 *  which reports UTC and can name the wrong day within a few hours of midnight. */
export function localIsoDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` from a photo File's EXIF data, or null. */
export async function readCaptureDate(file) {
  try {
    // The header EXIF lives in sits within the first few dozen KB of a JPEG;
    // capping the read keeps this cheap even on a multi-megabyte photo.
    const buffer = await file.slice(0, 128 * 1024).arrayBuffer();
    return parseExifDate(buffer);
  } catch {
    return null;
  }
}

/** `{ lat, lon }` in decimal degrees from a photo File's EXIF GPS tags, or null. */
export async function readCaptureLocation(file) {
  try {
    const buffer = await file.slice(0, 128 * 1024).arrayBuffer();
    return parseExifLocation(buffer);
  } catch {
    return null;
  }
}

/** Pure and synchronous, so it is testable without a real photo file. */
export function parseExifDate(buffer) {
  return walkApp1(buffer, readApp1Date);
}

/** Pure and synchronous, mirroring parseExifDate. */
export function parseExifLocation(buffer) {
  return walkApp1(buffer, readApp1Location);
}

/**
 * Scan a JPEG's markers for its EXIF (APP1) segment(s), handing each to
 * `extract` until one yields a result. More than one APP1 segment is
 * unusual, but a first segment that parses without carrying what `extract`
 * is after should not stop the search.
 */
function walkApp1(buffer, extract) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;   // not a JPEG

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) return null;   // not a marker: malformed, or past the header
    if (marker === 0xffda) return null;              // start of scan — no more markers before pixel data
    const length = view.getUint16(offset + 2);
    if (marker === 0xffe1) {
      const result = extract(view, offset + 4);
      if (result) return result;
    }
    offset += 2 + length;
  }
  return null;
}

/** The TIFF payload of one APP1 segment, or null if it isn't a valid EXIF one. */
function readTiffHeader(view, start) {
  if (start + 6 > view.byteLength) return null;
  if (view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0) return null;   // "Exif\0\0"

  const tiff = start + 6;
  if (tiff + 8 > view.byteLength) return null;
  const byteOrder = view.getUint16(tiff);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null;   // 'II' little-endian, 'MM' big-endian
  const little = byteOrder === 0x4949;
  if (view.getUint16(tiff + 2, little) !== 0x002a) return null;    // TIFF magic number

  const ifd0 = tiff + view.getUint32(tiff + 4, little);
  return { tiff, little, ifd0Entries: readIFD(view, ifd0, little) };
}

function readApp1Date(view, start) {
  const header = readTiffHeader(view, start);
  if (!header) return null;
  const { tiff, little, ifd0Entries } = header;

  const subIfdPointer = ifd0Entries.get(EXIF_SUB_IFD);
  if (subIfdPointer) {
    const subIfd = tiff + view.getUint32(subIfdPointer.valueOffset, little);
    const original = readIFD(view, subIfd, little).get(DATE_TIME_ORIGINAL);
    const date = original && toIsoDate(readAscii(view, tiff, original, little));
    if (date) return date;
  }

  const fallback = ifd0Entries.get(DATE_TIME);
  return fallback ? toIsoDate(readAscii(view, tiff, fallback, little)) : null;
}

function readApp1Location(view, start) {
  const header = readTiffHeader(view, start);
  if (!header) return null;
  const { tiff, little, ifd0Entries } = header;

  const gpsPointer = ifd0Entries.get(GPS_IFD);
  if (!gpsPointer) return null;
  const gpsIfd = tiff + view.getUint32(gpsPointer.valueOffset, little);
  const gpsEntries = readIFD(view, gpsIfd, little);

  const latRef = gpsEntries.get(GPS_LAT_REF);
  const lat = gpsEntries.get(GPS_LAT);
  const lonRef = gpsEntries.get(GPS_LON_REF);
  const lon = gpsEntries.get(GPS_LON);
  if (!latRef || !lat || !lonRef || !lon) return null;

  const latitude = readDegrees(view, tiff, lat, little, readAsciiChar(view, latRef));
  const longitude = readDegrees(view, tiff, lon, little, readAsciiChar(view, lonRef));
  if (latitude === null || longitude === null) return null;

  // Some cameras write a structurally complete but zeroed-out GPS IFD as
  // their placeholder for "no fix was acquired" rather than omitting the
  // tags altogether — this is Null Island, not a real bottle of wine.
  if (latitude === 0 && longitude === 0) return null;

  return { lat: latitude, lon: longitude };
}

/** The single inline ASCII character of a GPS *Ref tag ('N'/'S'/'E'/'W'). */
function readAsciiChar(view, entry) {
  return String.fromCharCode(view.getUint8(entry.valueOffset));
}

/** Degrees, minutes, seconds — three RATIONALs — folded to decimal degrees,
 *  negated for the southern and western hemispheres. Null if any of the
 *  three is n/0: EXIF's own convention for "value not available", not zero —
 *  treating it as zero is what silently turned an absent GPS fix into
 *  0°0'0", the other shape "no fix" shows up as on cameras that omit the
 *  denominator instead of the whole tag. */
function readDegrees(view, tiffStart, entry, little, ref) {
  if (entry.count < 3) return null;
  const offset = tiffStart + view.getUint32(entry.valueOffset, little);
  if (offset < 0 || offset + 24 > view.byteLength) return null;

  const part = (i) => {
    const numerator = view.getUint32(offset + i * 8, little);
    const denominator = view.getUint32(offset + i * 8 + 4, little);
    return denominator ? numerator / denominator : null;
  };
  const degrees = part(0);
  const minutes = part(1);
  const seconds = part(2);
  if (degrees === null || minutes === null || seconds === null) return null;

  const decimal = degrees + minutes / 60 + seconds / 3600;
  return ref === 'S' || ref === 'W' ? -decimal : decimal;
}

/** Tag → `{ type, count, valueOffset }` for one IFD table. */
function readIFD(view, ifdOffset, little) {
  const entries = new Map();
  if (ifdOffset < 0 || ifdOffset + 2 > view.byteLength) return entries;

  const count = view.getUint16(ifdOffset, little);
  for (let i = 0; i < count; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;
    entries.set(view.getUint16(entryOffset, little), {
      type: view.getUint16(entryOffset + 2, little),
      count: view.getUint32(entryOffset + 4, little),
      valueOffset: entryOffset + 8,
    });
  }
  return entries;
}

/** An ASCII tag's text. Four bytes or fewer sit inline in the entry itself;
 *  anything longer is an offset to where the bytes actually live. */
function readAscii(view, tiffStart, entry, little) {
  const length = entry.count;
  const dataOffset = length <= 4 ? entry.valueOffset : tiffStart + view.getUint32(entry.valueOffset, little);
  if (dataOffset < 0 || dataOffset + length > view.byteLength) return '';

  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(dataOffset + i));
  return text.replace(/\0+$/, '');
}

/** EXIF dates read "YYYY:MM:DD HH:MM:SS" — reformatting the digits directly,
 *  rather than round-tripping a Date, so no timezone conversion can shift
 *  the calendar day. */
function toIsoDate(text) {
  const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(text || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
