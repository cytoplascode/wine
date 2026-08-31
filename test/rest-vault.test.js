import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  describe, test as testConnection, fileExists, writeFile,
} from '../js/rest-vault.js';

/* `connect()`/`restore()`/`disconnect()` persist through IndexedDB, which
 * only exists in a browser — same reason vault.test.js never exercises
 * vault.js's `pick()`. What's tested here is the actual HTTP conversation
 * (`test`, `fileExists`, `writeFile`), which — deliberately — never touches
 * storage at all; see the comment in rest-vault.js. */

const API_KEY = 'sekret-key';

/** A stub standing in for the plugin's server: enough of its contract to
 *  drive the client against — bearer auth, 404 for a missing file, and a
 *  vault path that echoes back what it received so a test can check the
 *  request itself rather than just the response. */
function startStub() {
  const seen = [];
  const files = new Set(['wines/Existing Wine.md']);

  const server = http.createServer((req, res) => {
    let body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      const path = decodeURIComponent(req.url.replace(/^\/vault\//, ''));
      seen.push({
        method: req.method, path, auth: req.headers.authorization,
        contentType: req.headers['content-type'], body: Buffer.concat(body),
      });

      if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === 'GET' && (path === '' || path === 'wines/')) {
        res.writeHead(200).end('{}');
        return;
      }
      if (req.method === 'GET') {
        if (files.has(path)) res.writeHead(200).end('content');
        else res.writeHead(404).end();
        return;
      }
      if (req.method === 'PUT') {
        files.add(path);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        seen,
        port,
        // fetch() keeps its connection alive by default, and a plain
        // server.close() waits for existing sockets to end on their own —
        // which they never do here — so it would hang forever otherwise.
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
      });
    });
  });
}

const candidate = (port, apiKey = API_KEY) => ({ host: '127.0.0.1', port, https: false, apiKey });

/* ── describe() — pure, mirrors vault.test.js's style ─────────────────── */

test('not configured offers to connect', () => {
  const card = describe('none');
  assert.equal(card.dot, 'warn');
  assert.deepEqual(card.button, ['Connect', 'connect']);
});

test('a working connection is named and offers to disconnect', () => {
  const card = describe('ok', { host: '127.0.0.1', port: 27123 });
  assert.equal(card.dot, 'ok');
  assert.match(card.text, /127\.0\.0\.1:27123/);
  assert.deepEqual(card.button, ['Disconnect', 'disconnect']);
});

test('a bad key is told apart from an unreachable server', () => {
  const badKey = describe('unauthorized');
  const unreachable = describe('unreachable');
  assert.equal(badKey.dot, 'err');
  assert.match(badKey.text, /key/);
  assert.equal(unreachable.dot, 'err');
  assert.match(unreachable.text, /open/);
  assert.notEqual(badKey.text, unreachable.text);
});

/* ── Talking to a real (stub) server ────────────────────────────────── */

test('test() tells a good key from a bad one from an unreachable host', async () => {
  const stub = await startStub();
  try {
    assert.equal(await testConnection(candidate(stub.port)), 'ok');
    assert.equal(await testConnection(candidate(stub.port, 'wrong-key')), 'unauthorized');
    assert.equal(await testConnection(candidate(59999)), 'unreachable');
  } finally {
    await stub.close();
  }
});

test('fileExists checks the right path and reads 404 as "no"', async () => {
  const stub = await startStub();
  try {
    const c = candidate(stub.port);
    assert.equal(await fileExists(c, 'wines/Existing Wine.md'), true);
    assert.equal(await fileExists(c, 'wines/Not There.md'), false);

    const check = stub.seen.find((r) => r.path === 'wines/Not There.md');
    assert.equal(check.auth, `Bearer ${API_KEY}`);
  } finally {
    await stub.close();
  }
});

test('writeFile PUTs with the given content type and a URL-safe path', async () => {
  const stub = await startStub();
  try {
    const c = candidate(stub.port);
    await writeFile(c, 'wines/Château Ausone - 2015.md', '---\nfoo: bar\n---', 'text/markdown');

    const put = stub.seen.find((r) => r.method === 'PUT');
    assert.equal(put.path, 'wines/Château Ausone - 2015.md');
    assert.equal(put.contentType, 'text/markdown');
    assert.equal(put.body.toString('utf8'), '---\nfoo: bar\n---');
  } finally {
    await stub.close();
  }
});

test('an unreachable server raises a clear error rather than a raw fetch failure', async () => {
  const stub = await startStub();
  const c = candidate(stub.port);
  await stub.close();

  await assert.rejects(() => fileExists(c, 'wines/Anything.md'), /Could not reach Obsidian/);
});
