/* Photo capture: live rear camera, plus gallery import as an equal option.
 *
 * A label is very often photographed before the app is even open, so importing
 * an existing picture is a first-class path, not just a fallback. Both routes
 * end at the same place: an ImageBitmap and a capture date handed to onPhoto()
 * — today for a fresh camera shot, or the photo's own EXIF date for an older
 * one pulled from the gallery, so "Drink date" can start from a real guess.
 */

import { $, toast } from './ui.js';
import { readCaptureDate, localIsoDate } from './exif.js';

const TITLES = {
  label: 'Photograph the label',
  food: 'Photograph the food',
};

let stream = null;
let mode = 'label';
let onPhoto = () => {};

export function initCapture(handlers) {
  onPhoto = handlers.onPhoto;

  $('#btn-shutter').addEventListener('click', takePhoto);
  $('#btn-gallery').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', importFromGallery);
}

export async function startCapture(nextMode = 'label') {
  mode = nextMode;
  $('#capture-title').textContent = TITLES[mode];
  showHint(null);

  const video = $('#video');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  } catch (err) {
    // No camera, no permission, or an insecure context: the gallery still works.
    $('#btn-shutter').disabled = true;
    video.hidden = true;
    showHint(cameraHint(err));
    return;
  }

  $('#btn-shutter').disabled = false;
  video.hidden = false;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    /* Autoplay rejections are harmless here — the element is muted and inline. */
  }
}

export function stopCapture() {
  const video = $('#video');
  video.pause();
  video.srcObject = null;
  if (stream) {
    // A rear camera left streaming in the background drains the phone fast.
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
}

async function takePhoto() {
  const video = $('#video');
  if (!video.videoWidth) {
    toast('The camera is not ready yet.');
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  const bitmap = await createImageBitmap(canvas);
  onPhoto(bitmap, mode, localIsoDate());
}

async function importFromGallery(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';           // so re-picking the same file still fires
  if (!file) return;

  try {
    // 'from-image' applies the EXIF orientation tag, which phone cameras rely
    // on: without it a portrait photo arrives on its side.
    const [bitmap, capturedOn] = await Promise.all([
      createImageBitmap(file, { imageOrientation: 'from-image' }),
      readCaptureDate(file),
    ]);
    onPhoto(bitmap, mode, capturedOn || localIsoDate());
  } catch (err) {
    toast(`That image could not be opened: ${err.message}`);
  }
}

function showHint(text) {
  const hint = $('#capture-hint');
  hint.textContent = text || '';
  hint.hidden = !text;
}

function cameraHint(err) {
  if (err.name === 'NotAllowedError') {
    return 'Camera access was blocked. Allow it in the site settings, or tap Gallery to pick a photo.';
  }
  if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
    return 'No camera found on this device. Tap Gallery to pick a photo instead.';
  }
  if (!window.isSecureContext) {
    return 'The camera needs an https connection. Tap Gallery to pick a photo instead.';
  }
  return `The camera could not start (${err.name}). Tap Gallery to pick a photo instead.`;
}
