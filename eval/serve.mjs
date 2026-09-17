/* Static file server for the eval harness.
 *
 * Replaces `python3 -m http.server` for one reason: ONNX Runtime's threaded
 * WASM build needs SharedArrayBuffer, which needs the page to be cross-origin
 * isolated, which needs COOP/COEP headers. Python's server cannot send them;
 * this one does. Used by run.mjs; can also be run standalone for the probe.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.jsonl': 'application/x-ndjson',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gz': 'application/gzip', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

export function serve(root, port, host = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const port = Number(process.argv[2] || 8765);
  const root = path.resolve(process.argv[3] || '.');
  await serve(root, port, '0.0.0.0');
  console.log(`serving ${root} on http://0.0.0.0:${port} (cross-origin isolated)`);
}
