/* Move a recognised value from one field into another.
 *
 * Recognition regularly reads a line perfectly and files it in the wrong box —
 * an appellation landing in Region, a cuvée in Wine name — and retyping both
 * fields to fix a mislabelling is the most tedious thing the review screen
 * asks for. So a value can be dragged by its grip onto the field it belongs
 * in, and the two swap.
 *
 * Pointer events rather than HTML5 drag-and-drop, which does not fire at all
 * on Android. Swap rather than move, because a swap is symmetrical: it never
 * destroys the value that was already there, and dragging back undoes it.
 */

import { $ } from './ui.js';

const EDGE = 72;      // px from the edge of the scroller where it starts sliding
const SPEED = 14;     // px per frame at the very edge

let drag = null;
let frame = 0;

export function initFieldDrag() {
  const form = $('#wine-form');
  form.addEventListener('pointerdown', onPointerDown);
  form.addEventListener('pointermove', onPointerMove);
  form.addEventListener('pointerup', onPointerUp);
  form.addEventListener('pointercancel', onPointerUp);
}

const inputOf = (field) => field && field.querySelector('input, textarea, select');

/**
 * Whether `input` can hold `value` without silently losing it. A date or number
 * input given text it cannot parse quietly blanks itself, so those are refused
 * rather than swapped into.
 */
function canHold(input, value) {
  if (!input || input.tagName === 'SELECT') return false;
  if (input.tagName === 'TEXTAREA' || !value) return true;
  if (input.type === 'number') return !Number.isNaN(Number(value));
  if (input.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value);
  return true;
}

/** A swap has to work in both directions, or one of the two values is lost. */
function canSwap(from, to) {
  const a = inputOf(from);
  const b = inputOf(to);
  return canHold(b, a.value.trim()) && canHold(a, b.value.trim());
}

function onPointerDown(event) {
  const grip = event.target.closest('.grip');
  if (!grip) return;

  const field = grip.closest('.field');
  const input = inputOf(field);
  if (!input || !input.value.trim()) return;

  drag = { from: field, target: null, x: event.clientX, y: event.clientY };
  drag.chip = document.createElement('div');
  drag.chip.className = 'drag-chip';
  drag.chip.textContent = input.value.trim();
  document.body.append(drag.chip);
  document.body.classList.add('dragging-field');

  grip.setPointerCapture(event.pointerId);
  moveChip();
  event.preventDefault();
}

function onPointerMove(event) {
  if (!drag) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  moveChip();
  aimAt(drag.x, drag.y);
  if (!frame) frame = requestAnimationFrame(tick);
  event.preventDefault();
}

function onPointerUp() {
  if (!drag) return;
  const { from, target, chip } = drag;

  chip.remove();
  document.body.classList.remove('dragging-field');
  if (target) target.classList.remove('drop-target');
  cancelAnimationFrame(frame);
  frame = 0;
  drag = null;

  if (target) swap(from, target);
}

function moveChip() {
  // Above the finger, which would otherwise be covering it.
  drag.chip.style.left = `${drag.x}px`;
  drag.chip.style.top = `${drag.y - 46}px`;
}

/** Work out what is under the pointer and light it up. */
function aimAt(x, y) {
  const under = document.elementFromPoint(x, y);

  // Dragging onto a collapsed group opens it, so a value can reach a field that
  // is not on screen yet.
  const summary = under && under.closest('.group > summary');
  if (summary) summary.parentElement.open = true;

  const field = under && under.closest('.field');
  const next = field && field !== drag.from && canSwap(drag.from, field) ? field : null;
  if (next === drag.target) return;

  if (drag.target) drag.target.classList.remove('drop-target');
  drag.target = next;
  if (next) next.classList.add('drop-target');
}

/** Slide the form while the pointer is held near its top or bottom edge. */
function tick() {
  frame = 0;
  if (!drag) return;

  const scroller = drag.from.closest('.scroll');
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    const over = Math.max(0, (box.top + EDGE - drag.y) / EDGE);
    const under = Math.max(0, (drag.y - (box.bottom - EDGE)) / EDGE);
    const step = SPEED * (Math.min(under, 1) - Math.min(over, 1));
    if (step) {
      scroller.scrollTop += step;
      aimAt(drag.x, drag.y);
    }
  }

  frame = requestAnimationFrame(tick);
}

function swap(from, to) {
  const a = inputOf(from);
  const b = inputOf(to);
  const value = a.value;
  a.value = b.value;
  b.value = value;

  // Through the DOM event, so the AUTO markers and the grips update themselves
  // exactly as they would for a hand edit.
  for (const input of [a, b]) input.dispatchEvent(new Event('input', { bubbles: true }));

  // Confirmation that the swap landed, without focusing the field — a text
  // input would pop the on-screen keyboard right after a drag gesture, which
  // is the last thing a swap should do.
  for (const field of [from, to]) {
    field.classList.add('field-landed');
    field.addEventListener(
      'animationend',
      () => field.classList.remove('field-landed'),
      { once: true },
    );
  }
}
