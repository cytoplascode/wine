import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatSize, shortfall, missingAssets, downloadToCache,
} from '../js/download.js';

/** A Cache Storage stand-in: a Map of url → Response. */
function fakeCaches(initial = []) {
  const store = new Map(initial.map((url) => [url, new Response('x')]));
  return {
    store,
    match: async (url) => store.get(url) || undefined,
    open: async () => ({ put: async (url, response) => { store.set(url, response); } }),
  };
}

/** A fetch that serves the given bodies, and records what it was asked for. */
function fakeFetch(bodies, { fail = {}, chunkSize = 4 } = {}) {
  const calls = [];
  const doFetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    const clean = url.split('?')[0];
    if (fail[clean]) return new Response(null, { status: fail[clean], statusText: 'Not Found' });
    const bytes = new TextEncoder().encode(bodies[clean] ?? '');
    if (options.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': String(bytes.length) } });
    }
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' },
    });
  };
  doFetch.calls = calls;
  return doFetch;
}

test('formatSize reads the way a person would say it', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2400), '2 kB');
  assert.equal(formatSize(1_500_000), '1.5 MB');
  assert.equal(formatSize(22_098_300), '22 MB');
  assert.equal(formatSize(NaN), '—');
});

test('shortfall only complains when the phone really is short', () => {
  assert.equal(shortfall({ quota: 100e6, usage: 10e6 }, 37e6), 0);
  assert.ok(shortfall({ quota: 50e6, usage: 30e6 }, 37e6) > 0);
  // A browser that reports nothing gets the benefit of the doubt.
  assert.equal(shortfall(null, 37e6), 0);
  assert.equal(shortfall({}, 37e6), 0);
});

test('missingAssets keeps the order and skips what is cached', async () => {
  const caches = fakeCaches(['/b']);
  assert.deepEqual(await missingAssets(['/a', '/b', '/c'], caches), ['/a', '/c']);
  assert.deepEqual(await missingAssets(['/b'], caches), []);
});

test('downloadToCache stores every missing file and reports bytes as they land', async () => {
  const caches = fakeCaches();
  const fetch = fakeFetch({ '/one': 'aaaaaaaa', '/two': 'bbbb' });
  const seen = [];
  const result = await downloadToCache(['/one', '/two'], 'sam', (p) => seen.push(p), {
    fetch, caches, storage: null,
  });

  assert.equal(result.fetched, 2);
  assert.equal(result.bytes, 12);
  assert.ok(caches.store.has('/one') && caches.store.has('/two'), 'stored under the clean urls');
  // Progress climbs and finishes at the total.
  const loaded = seen.map((p) => p.loaded);
  assert.deepEqual(loaded, [...loaded].sort((a, b) => a - b), 'never goes backwards');
  assert.equal(seen.at(-1).loaded, 12);
  assert.equal(seen.at(-1).total, 12);
  assert.ok(seen.at(-1).complete);
});

test('downloadToCache skips what is already there, so a retry resumes', async () => {
  const caches = fakeCaches(['/one']);
  const fetch = fakeFetch({ '/one': 'aaaaaaaa', '/two': 'bbbb' });
  const result = await downloadToCache(['/one', '/two'], 'sam', null, {
    fetch, caches, storage: null,
  });
  assert.equal(result.fetched, 1);
  assert.ok(!fetch.calls.some((c) => c.url.startsWith('/one')), 'the cached file is not refetched');
});

test('downloadToCache names the file and the status when the server says no', async () => {
  const caches = fakeCaches();
  const fetch = fakeFetch({ '/a/present.onnx': 'aa' }, { fail: { '/a/gone.onnx': 404 } });
  await assert.rejects(
    downloadToCache(['/a/gone.onnx'], 'sam', null, { fetch, caches, storage: null }),
    /gone\.onnx: 404/,
  );
});

test('downloadToCache gives up on a connection that stops sending', async () => {
  const caches = fakeCaches();
  const fetch = async (url, options = {}) => {
    if (options.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '100' } });
    }
    // Two chunks, then silence for good.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-length': '100' } });
  };
  await assert.rejects(
    downloadToCache(['/slow.onnx'], 'sam', null, { fetch, caches, storage: null, stallMs: 50 }),
    /slow\.onnx: the connection stalled after 16 B/,
  );
});

test('downloadToCache refuses when there is no room, before fetching anything', async () => {
  const caches = fakeCaches();
  const fetch = fakeFetch({ '/big.onnx': 'aaaaaaaaaa' });
  await assert.rejects(
    downloadToCache(['/big.onnx'], 'sam', null, {
      fetch, caches, storage: { estimate: async () => ({ quota: 10, usage: 9 }) },
    }),
    /not enough room/,
  );
  assert.ok(!fetch.calls.some((c) => c.method === 'GET'), 'nothing was downloaded');
});

test('downloadToCache asks the network with the marker the worker ignores', async () => {
  const caches = fakeCaches();
  const fetch = fakeFetch({ '/one': 'aa' });
  await downloadToCache(['/one'], 'sam', null, { fetch, caches, storage: null });
  assert.ok(fetch.calls.every((c) => c.url.includes('download=1')), 'every request is marked');
  assert.ok(caches.store.has('/one'), 'but it is stored under the clean url');
});

test('downloadToCache does nothing at all when everything is cached', async () => {
  const caches = fakeCaches(['/one']);
  const fetch = fakeFetch({ '/one': 'aa' });
  const seen = [];
  const result = await downloadToCache(['/one'], 'sam', (p) => seen.push(p), {
    fetch, caches, storage: null,
  });
  assert.equal(result.fetched, 0);
  assert.equal(fetch.calls.length, 0);
  assert.ok(seen.at(-1).complete);
});
