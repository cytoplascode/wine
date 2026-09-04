/* Reverse geocoding for the "Drink city" and "Drink country" fields: a
 * human-readable locality for the coordinates a label photo was taken at,
 * split in two so a Base can filter by either. This is the one place the app ever
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

/**
 * `{ city, country }` for `{ lat, lon }` — either half may be null when
 * the geocoder does not know it — or null on any failure at all.
 */
export async function reverseGeocode({ lat, lon }) {
  const url = `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return locality(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Split a Nominatim reverse-lookup response into `{ city, country }`. Points
 * of interest belong in the app's separate "Drink venue" field — the city
 * kept here stays deliberately broad so it reads the same whichever specific
 * spot within a town the bottle was photographed at. Falls through
 * city→town→village→municipality→suburb→state when the finer-grained key is
 * missing, which is what covers a rural bottle where Nominatim only has a
 * region name to give.
 *
 * Pure, so it is testable without a network call. Returns null when neither
 * a city nor a country came back — nothing to fill in — rather than an
 * object of two nulls.
 */
export function locality(data) {
  if (!data) return null;
  const address = data.address || {};
  const city = address.city || address.town || address.village
    || address.municipality || address.suburb || address.state || null;
  const country = address.country || null;
  return (city || country) ? { city, country } : null;
}
