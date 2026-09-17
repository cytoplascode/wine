#!/usr/bin/env node
/* Draw what automatic label detection did.
 *
 *   node eval/crop-preview.mjs [--data eval/data] [--limit N] [--only a.jpg,b.jpg]
 *
 * For each photo: the text boxes (thin), the six handles and the arcs they
 * make (thick), and the flattened result beside it, written to
 * eval/out/crops/<file>.png. Looking at these is how a placement rule gets
 * judged before it is trusted on numbers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { serve } from './serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const dataDir = path.resolve(repo, args.data || 'eval/data');
const limit = args.limit ? Number(args.limit) : Infinity;
const only = args.only ? new Set(args.only.split(',')) : null;
const port = Number(args.port || 8766);

const files = fs.readdirSync(path.join(dataDir, 'images'))
  .filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && (!only || only.has(f))).sort().slice(0, limit);
const outDir = path.join(repo, 'eval/out/crops');
fs.mkdirSync(outDir, { recursive: true });

const server = await serve(repo, port);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(5 * 60 * 1000);
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`${base}/eval/harness.html?extractor=ppocr`);
await page.waitForFunction(() => window.extract || window.harnessError);

const relData = path.relative(repo, dataDir).split(path.sep).join('/');
for (const file of files) {
  const url = `${base}/${relData}/images/${encodeURIComponent(file)}`;
  const png = await page.evaluate(async (u) => {
    const { configure } = await import('/js/ppocr.js');
    configure({ vendor: new URL('/vendor/ppocr/', location.href).href, threads: 1 });
    const { findLabel } = await import('/js/autocrop.js');
    const { flattenLabel } = await import('/js/flatten.js');
    const { fitWrapAngle } = await import('/js/warp.js');
    const { edgeArc } = await import('/js/warp.js');
    const blob = await (await fetch(u)).blob();
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const found = await findLabel(bitmap);
    const scale = Math.min(1, 700 / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale); const h = Math.round(bitmap.height * scale);
    let flat = null;
    if (found) flat = flattenLabel(bitmap, found.points, fitWrapAngle(found.points));
    const fw = flat ? Math.round(flat.width * (h / flat.height) * 0.6) : 0;
    const out = document.createElement('canvas');
    out.width = w + (flat ? fw + 10 : 0); out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (found) {
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,200,255,0.9)';
      for (const b of found.boxes) ctx.strokeRect(b.left * scale, b.top * scale, (b.right - b.left) * scale, (b.bottom - b.top) * scale);
      const p = found.points.map((q) => ({ x: q.x * scale, y: q.y * scale }));
      ctx.lineWidth = 3; ctx.strokeStyle = '#ff3366';
      ctx.beginPath();
      const top = edgeArc(p[0], p[1], p[2]); const bottom = edgeArc(p[5], p[4], p[3]);
      ctx.moveTo(top[0].x, top[0].y); for (const q of top) ctx.lineTo(q.x, q.y);
      ctx.lineTo(p[3].x, p[3].y);
      for (const q of [...bottom].reverse()) ctx.lineTo(q.x, q.y);
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = '#fff';
      for (const q of p) { ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.fill(); }
      ctx.drawImage(flat, w + 10, 0, fw, h * 0.6);
      ctx.fillStyle = '#fff'; ctx.font = '13px sans-serif';
      ctx.fillText(`found ${Object.entries(found.found).filter(([, v]) => v).map(([k]) => k).join(',') || 'none'}  wrap ${Math.round(fitWrapAngle(found.points) * 180 / Math.PI)}°  ${found.ms} ms`, w + 12, h * 0.6 + 20);
    } else {
      ctx.fillStyle = '#fff'; ctx.font = '16px sans-serif'; ctx.fillText('no label found', 10, 24);
    }
    bitmap.close();
    return out.toDataURL('image/png').split(',')[1];
  }, url);
  const target = path.join(outDir, `${file.replace(/\.[^.]+$/, '')}.png`);
  fs.writeFileSync(target, Buffer.from(png, 'base64'));
  process.stderr.write(`${file} → ${path.relative(repo, target)}\n`);
}
await browser.close();
server.close();
