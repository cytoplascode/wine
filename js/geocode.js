/* Reverse geocoding for the "Place" field: a human-readable name for the
 * coordinates a label photo was taken at. This is the one place the app ever
 * makes a network request — everything else works fully offline — so any
 * failure here (no connection, the service unreachable, a slow response) is
 * swallowed rather than surfaced: the field just stays blank for the user to
 * fill in by hand, the same as it would on a browser with no network API at
 * all.
 *
 * Nominatim (OpenStreetMap) needs no API key, which is what makes it usable
 * from a static site with nowhere to keep one. Its usage policy asks for an
 * identifying User-Agent, which a browser's fetch() cannot set — that header
 * is forbidden to script — so this relies on the Referer a browser sends on
 * its own instead. Fine for the occasional, one-request-per-bottle traffic
 * this app makes; a heavier integration should route through a server with
 * its own key instead.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const TIMEOUT_MS = 8000;

/** A short place name for `{ lat, lon }`, or null if nothing came back. */
export async function reverseGeocode({ lat, lon }) {
  const url = `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return placeName(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fold a Nominatim reverse-lookup response down to one short, readable
 * string: the town or city, then the country. Points of interest belong to
 * the "Venue" field the app keeps separately — this one stays deliberately
 * broad so it reads the same whichever specific spot within a town the
 * bottle was photographed at.
 *
 * Pure, so it is testable without a network call.
 */
export function placeName(data) {
  if (!data) return null;
  const address = data.address || {};
  const locality = address.city || address.town || address.village
    || address.municipality || address.suburb || address.state;

  const parts = [locality, address.country].filter(Boolean);
  return parts.join(', ') || null;
}
