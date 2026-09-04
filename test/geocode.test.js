import test from 'node:test';
import assert from 'node:assert/strict';

import { locality } from '../js/geocode.js';

/* reverseGeocode itself makes a network call, so — like vault.js's pick() —
 * it is checked by hand rather than under node --test. locality is the pure
 * part that splits a Nominatim response into { city, country }, and that is
 * what these exercise, with response shapes taken from Nominatim's
 * documented reverse-lookup format. */

test('city and country come back split, ready to fill two fields', () => {
  const data = { address: { city: 'Paris', country: 'France' } };
  assert.deepEqual(locality(data), { city: 'Paris', country: 'France' });
});

test('a POI in the response is ignored — that belongs in Drink venue', () => {
  const data = {
    name: 'Bistro du Chef',
    address: { amenity: 'restaurant', city: 'Paris', country: 'France' },
  };
  assert.deepEqual(locality(data), { city: 'Paris', country: 'France' });
});

test('any locality granularity fills the city half — town, village…', () => {
  assert.deepEqual(locality({ address: { town: 'Beaune', country: 'France' } }),
    { city: 'Beaune', country: 'France' });
  assert.deepEqual(locality({ address: { village: 'Meursault', country: 'France' } }),
    { city: 'Meursault', country: 'France' });
});

test('a remote place with no city or town falls back to the state', () => {
  const data = { address: { state: 'Kakheti', country: 'Georgia' } };
  assert.deepEqual(locality(data), { city: 'Kakheti', country: 'Georgia' });
});

test('either half can be missing without the other going with it', () => {
  assert.deepEqual(locality({ address: { country: 'France' } }),
    { city: null, country: 'France' });
  assert.deepEqual(locality({ address: { city: 'Paris' } }),
    { city: 'Paris', country: null });
});

test('a response with neither city nor country returns null', () => {
  assert.equal(locality({ address: {} }), null);
  assert.equal(locality(null), null);
});
