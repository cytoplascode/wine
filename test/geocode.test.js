import test from 'node:test';
import assert from 'node:assert/strict';

import { placeName } from '../js/geocode.js';

/* reverseGeocode itself makes a network call, so — like vault.js's pick() —
 * it is checked by hand rather than under node --test. placeName is the pure
 * part that turns a Nominatim response into a short string, and that is what
 * these exercise, with response shapes taken from Nominatim's documented
 * reverse-lookup format. */

test('city and country make up the whole name', () => {
  const data = {
    name: 'Bistro du Chef',   // ignored — points of interest belong in Venue
    address: { amenity: 'restaurant', city: 'Paris', country: 'France' },
  };
  assert.equal(placeName(data), 'Paris, France');
});

test('any locality granularity is treated the same — city, town, village…', () => {
  assert.equal(placeName({ address: { city: 'Paris', country: 'France' } }), 'Paris, France');
  assert.equal(placeName({ address: { town: 'Beaune', country: 'France' } }), 'Beaune, France');
  assert.equal(placeName({ address: { village: 'Meursault', country: 'France' } }), 'Meursault, France');
});

test('a remote place with no city or town falls back to the state', () => {
  const data = { address: { state: 'Kakheti', country: 'Georgia' } };
  assert.equal(placeName(data), 'Kakheti, Georgia');
});

test('country alone still comes through', () => {
  // Middle of nowhere but the country is known.
  assert.equal(placeName({ address: { country: 'France' } }), 'France');
});

test('a response with nothing usable returns null', () => {
  assert.equal(placeName({ address: {} }), null);
  assert.equal(placeName(null), null);
});
