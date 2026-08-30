/* Crop screen: fits the captured photo to the stage and keeps the mapping
 * between canvas pixels and source-image pixels. */

import { $ } from './ui.js';

let bitmap = null;
let view = { scale: 1, dx: 0, dy: 0 };   // image pixels -> canvas pixels

export function showImage(nextBitmap) {
  bitmap = nextBitmap;
  if (!bitmap) return;
  layout();
  draw();
}

/** Size the canvas to the stage and centre the image inside it. */
function layout() {
  const canvas = $('#crop-canvas');
  const stage = $('#crop-stage');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const boxW = stage.clientWidth;
  const boxH = stage.clientHeight;
  const scale = Math.min(boxW / bitmap.width, boxH / bitmap.height);
  const drawW = bitmap.width * scale;
  const drawH = bitmap.height * scale;

  canvas.style.width = `${drawW}px`;
  canvas.style.height = `${drawH}px`;
  canvas.width = Math.round(drawW * dpr);
  canvas.height = Math.round(drawH * dpr);

  // The canvas is sized to the image, so the image fills it exactly.
  view = { scale: scale * dpr, dx: 0, dy: 0 };
}

export function draw() {
  const canvas = $('#crop-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  drawOverlay(ctx);
}

/* Replaced once the corner overlay lands. */
let drawOverlay = () => {};

export function setOverlayPainter(fn) { drawOverlay = fn; }

export function getBitmap() { return bitmap; }

/** Canvas pixel -> source image pixel. */
export function toImage(x, y) {
  return { x: (x - view.dx) / view.scale, y: (y - view.dy) / view.scale };
}

/** Source image pixel -> canvas pixel. */
export function toCanvas(x, y) {
  return { x: x * view.scale + view.dx, y: y * view.scale + view.dy };
}

/** CSS pixel within the canvas element -> canvas pixel. */
export function toCanvasPixels(clientX, clientY) {
  const canvas = $('#crop-canvas');
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height),
  };
}

window.addEventListener('resize', () => {
  if (bitmap && document.body.dataset.screen === 'crop') { layout(); draw(); }
});
