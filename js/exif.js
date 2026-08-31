/* The date a label photo was taken, so a scan can suggest when the wine was
 * actually drunk instead of defaulting everything to today.
 *
 * JPEG only — every photo this app produces or accepts on Chrome for Android
 * is one — and only the calendar date, since that is all "Drink date" needs.
 * Anything unexpected (no EXIF, a different format, a truncated file) returns
 * null rather than guessing.
 */

const EXIF_SUB_IFD = 0x8769;        // pointer from IFD0 to the Exif SubIFD
const DATE_TIME_ORIGINAL = 0x9003;  // in the SubIFD: when the shutter opened
const DATE_TIME = 0x0132;           // IFD0 fallback, for a camera that skips the SubIFD

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

/** Pure and synchronous, so it is testable without a real photo file. */
export function parseExifDate(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;   // not a JPEG

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) return null;   // not a marker: malformed, or past the header
    if (marker === 0xffda) return null;              // start of scan — no more markers before pixel data
    const length = view.getUint16(offset + 2);
    if (marker === 0xffe1) {
      const date = readApp1(view, offset + 4);
      if (date) return date;
    }
    offset += 2 + length;
  }
  return null;
}

function readApp1(view, start) {
  if (start + 6 > view.byteLength) return null;
  if (view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0) return null;   // "Exif\0\0"

  const tiff = start + 6;
  if (tiff + 8 > view.byteLength) return null;
  const byteOrder = view.getUint16(tiff);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null;   // 'II' little-endian, 'MM' big-endian
  const little = byteOrder === 0x4949;
  if (view.getUint16(tiff + 2, little) !== 0x002a) return null;    // TIFF magic number

  const ifd0 = tiff + view.getUint32(tiff + 4, little);
  const ifd0Entries = readIFD(view, ifd0, little);

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
