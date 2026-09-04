import test from 'node:test';
import assert from 'node:assert/strict';

import { placeName } from '../js/geocode.js';

/* reverseGeocode itself makes a network call, so — like vault.js's pick() —
 * it is checked by hand rather than under node --test. placeName is the pure
 * part that turns a Nominatim response into a short string, and that is what
 * these exercise, with response shapes taken from Nominatim's documented
 * reverse-lookup format. */

test('a named point of interest leads, followed by locality and country', () => {
  const data = {
    name: 'Bistro du Chef',
    address: { amenity: 'restaurant', city: 'Paris', country: 'France' },
    display_name: 'Bistro du Chef, Rue de Rivoli, Paris, France',
  };
  assert.equal(placeName(data), 'Bistro du Chef, Paris, France');
});

test('falls back to the amenity name when there is no specific name', () => {
  const data = { address: { shop: 'wine', town: 'Beaune', country: 'France' } };
  assert.equal(placeName(data), 'wine, Beaune, France');
});

test('a locality alone, with no point of interest', () => {
  const data = { address: { village: 'Meursault', country: 'France' } };
  assert.equal(placeName(data), 'Meursault, France');
});

test('a duplicate between the specific name and the locality is not repeated', () => {
  // e.g. reverse-geocoding a point right in the middle of the city itself.
  const data = { name: 'Paris', address: { city: 'Paris', country: 'France' } };
  assert.equal(placeName(data), 'Paris, France');
});

test('nothing usable in address falls back to display_name', () => {
  const data = { address: {}, display_name: 'Somewhere, Unnamed Region' };
  assert.equal(placeName(data), 'Somewhere, Unnamed Region');
});

test('a response with nothing at all returns null', () => {
  assert.equal(placeName({ address: {} }), null);
  assert.equal(placeName(null), null);
});

test('a remote locality still falls back to the state', () => {
  const data = { address: { state: 'Kakheti', country: 'Georgia' } };
  assert.equal(placeName(data), 'Kakheti, Georgia');
});
