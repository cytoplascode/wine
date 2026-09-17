#!/usr/bin/env node
/* Fetch the PP-OCR ONNX models the ppocr extractor needs into eval/models/ppocr/.
 *
 * Source: the npm package `paddle-ocr-onnx-models` (Apache-2.0) — RapidOCR's
 * ONNX conversions of the PaddleOCR detector / recogniser / classifier. npm is
 * used because it is reachable from environments where HuggingFace and the
 * Baidu CDN are not. Idempotent; re-run to refresh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(here, 'models', 'ppocr');
const PKG = 'paddle-ocr-onnx-models';
const VERSION = '0.2.0';
const WANT = [
  'ch_PP-OCRv4_det_infer.onnx',     // detector: script-agnostic, best of the set
  'en_PP-OCRv4_rec.onnx',           // recogniser: Latin script, PaddleOCR en_dict
  'ch_ppocr_mobile_v2.0_cls_infer.onnx', // 0/180° orientation classifier
];

fs.mkdirSync(dest, { recursive: true });
if (WANT.every((f) => fs.existsSync(path.join(dest, f)))) {
  console.log(`models already present in ${path.relative(process.cwd(), dest)}`);
  process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(require_os_tmpdir()), 'ppocr-'));
const tgz = path.join(tmp, 'pkg.tgz');
const url = `https://registry.npmjs.org/${PKG}/-/${PKG}-${VERSION}.tgz`;
console.log(`downloading ${url}`);
const res = await fetch(url);
if (!res.ok) { console.error(`download failed: ${res.status}`); process.exit(1); }
fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
for (const f of WANT) {
  fs.copyFileSync(path.join(tmp, 'package', 'models', f), path.join(dest, f));
  console.log(`  ${f}  ${(fs.statSync(path.join(dest, f)).size / 1048576).toFixed(1)} MB`);
}
fs.copyFileSync(path.join(tmp, 'package', 'LICENSE'), path.join(dest, 'LICENSE.paddleocr.txt'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('done');

function require_os_tmpdir() { return process.env.TMPDIR || '/tmp'; }
