import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* The QuickAdd user script is the one piece of this app the user copies by
 * hand into their own vault, and the only place the clipboard parcel gets
 * unpacked — so it is worth testing the README's copy of it, verbatim, rather
 * than a second copy that could quietly drift from the one people paste.
 *
 * Obsidian's vault API is mocked: what matters here is the order the writes go
 * in, the names they land under, and that the note's embeds still point at the
 * files after a collision renames the whole set. */

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const source = /````\n```js\n([\s\S]*?)\n```\n````/.exec(readme)[1];
const module_ = { exports: null };
new Function('module', source)(module_);
const run = module_.exports;

function mockVault(existing = []) {
  const files = new Set(existing);
  const written = [];
  const guard = (path) => {
    if (files.has(path)) throw new Error(`File already exists: ${path}`);
    files.add(path);
  };
  return {
    written,
    vault: {
      getAbstractFileByPath: (path) => (files.has(path) ? { path } : null),
      createFolder: async (path) => { guard(path); written.push(['folder', path]); },
      createBinary: async (path, buffer) => {
        guard(path);
        written.push(['binary', path, [...new Uint8Array(buffer)]]);
      },
      create: async (path, content) => { guard(path); written.push(['note', path, content]); },
    },
  };
}

const jpeg = (byte) =>
  `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, byte]).toString('base64')}`;

const BOTTLE = {
  v: 1,
  note: {
    path: 'wines/Château Ausone - 2015.md',
    content: [
      '## Label',
      'Label:: ![[Château Ausone - 2015.jpg]]',
      '## Food',
      'Food:: ![[Château Ausone - 2015 - food.jpg]]',
    ].join('\n'),
  },
  files: [
    { path: 'wines/Château Ausone - 2015.jpg', data: jpeg(1) },
    { path: 'wines/Château Ausone - 2015 - food.jpg', data: jpeg(2) },
  ],
};

/** Run the script over `parcel`, with `existing` already in the vault. */
async function unpack(parcel, existing = []) {
  const clipboard = { readText: async () => JSON.stringify(parcel) };
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
  const app = mockVault(existing);
  await run({ app });
  return app.written;
}

test('the photos are written before the note that links to them', async () => {
  const written = await unpack(BOTTLE);
  assert.deepEqual(written.map((w) => [w[0], w[1]]), [
    ['folder', 'wines'],
    ['binary', 'wines/Château Ausone - 2015.jpg'],
    ['binary', 'wines/Château Ausone - 2015 - food.jpg'],
    ['note', 'wines/Château Ausone - 2015.md'],
  ]);
});

test('the base64 comes back out as the original bytes', async () => {
  const written = await unpack(BOTTLE, ['wines']);
  assert.deepEqual(written[0][2], [0xff, 0xd8, 1]);
  assert.deepEqual(written[1][2], [0xff, 0xd8, 2]);
});

test('a name collision renames note and photos together, embeds included', async () => {
  const written = await unpack(BOTTLE, ['wines', 'wines/Château Ausone - 2015.md']);
  assert.deepEqual(written.map((w) => w[1]), [
    'wines/Château Ausone - 2015 2.jpg',
    'wines/Château Ausone - 2015 2 - food.jpg',
    'wines/Château Ausone - 2015 2.md',
  ]);
  assert.equal(written[2][2], [
    '## Label',
    'Label:: ![[Château Ausone - 2015 2.jpg]]',
    '## Food',
    'Food:: ![[Château Ausone - 2015 2 - food.jpg]]',
  ].join('\n'));
});

test('a photo left over from a half-finished send counts as a collision too', async () => {
  // The note is free but its label is not, so taking the free name would
  // overwrite the photo. The suffix is decided over the whole set at once.
  const written = await unpack(BOTTLE, ['wines', 'wines/Château Ausone - 2015.jpg']);
  assert.equal(written[2][1], 'wines/Château Ausone - 2015 2.md');
});

test('the suffix keeps counting past the second bottle of a name', async () => {
  const written = await unpack(BOTTLE, [
    'wines',
    'wines/Château Ausone - 2015.md',
    'wines/Château Ausone - 2015 2.md',
  ]);
  assert.equal(written[2][1], 'wines/Château Ausone - 2015 3.md');
});

test('a bottle with no food photo writes just the one file', async () => {
  const written = await unpack({
    v: 1,
    note: { path: 'wines/X.md', content: 'Label:: ![[X.jpg]]\nFood::' },
    files: [{ path: 'wines/X.jpg', data: jpeg(3) }],
  }, ['wines']);
  assert.deepEqual(written.map((w) => w[1]), ['wines/X.jpg', 'wines/X.md']);
});

test('a $ in the wine name is not read as a replacement group', async () => {
  // "Ch$&teau" through a naive String.replace would splice the match back in.
  const written = await unpack({
    v: 1,
    note: { path: 'wines/A $& B.md', content: 'Label:: ![[A $& B.jpg]]' },
    files: [{ path: 'wines/A $& B.jpg', data: jpeg(4) }],
  }, ['wines', 'wines/A $& B.md']);
  assert.deepEqual(written.map((w) => w[1]), ['wines/A $& B 2.jpg', 'wines/A $& B 2.md']);
  assert.equal(written[1][2], 'Label:: ![[A $& B 2.jpg]]');
});

test('notes and photos in different, nested folders each get created', async () => {
  const written = await unpack({
    v: 1,
    note: {
      path: 'Wine/Bottles/Château Ausone - 2015.md',
      content: 'Label:: ![[Château Ausone - 2015.jpg]]',
    },
    files: [{ path: 'Wine/Bottles/attachments/Château Ausone - 2015.jpg', data: jpeg(5) }],
  });
  assert.deepEqual(written.map((w) => [w[0], w[1]]), [
    ['folder', 'Wine'],
    ['folder', 'Wine/Bottles'],
    ['folder', 'Wine/Bottles/attachments'],
    ['binary', 'Wine/Bottles/attachments/Château Ausone - 2015.jpg'],
    ['note', 'Wine/Bottles/Château Ausone - 2015.md'],
  ]);
});

test('a folder shared by the note and its photos is only created once', async () => {
  const written = await unpack(BOTTLE);
  assert.deepEqual(written.filter((w) => w[0] === 'folder'), [['folder', 'wines']]);
});

test('anything else on the clipboard is refused, not half-written', async () => {
  const clipboard = { readText: async () => 'some unrelated text I copied' };
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
  const app = mockVault();
  await assert.rejects(() => run({ app }), /Nothing from Label Scanner/);
  assert.deepEqual(app.written, []);
});
