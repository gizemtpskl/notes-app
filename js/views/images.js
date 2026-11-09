/**
 * images.js: prepares pictures for storage. Large photos are scaled down, because every image
 * also goes into each JSON backup and a phone photo can be many megabytes.
 */
import { app } from '../context.js';
import { toast } from '../ui/toast.js';

const MAX_EDGE = 1800;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const KEEP_AS_IS_BYTES = 400 * 1024;
const STORABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadBitmap(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unreadable image'));
    };
    img.src = url;
  });
}

async function shrink(file) {
  const img = await loadBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency, so transparent areas get a white background.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), mime: 'image/jpeg' };
}

/** Stores an image and returns { id, dataUrl }, or null with a message if it can't be used. */
export async function saveImageFile(file) {
  if (file.size > MAX_INPUT_BYTES) {
    toast(`${file.name} is too large (over 40 MB).`, { error: true });
    return null;
  }
  try {
    const keep = STORABLE.has(file.type) && file.size <= KEEP_AS_IS_BYTES;
    const { dataUrl, mime } = keep
      ? { dataUrl: await readAsDataUrl(file), mime: file.type }
      : await shrink(file);
    const id = await app.db.putAsset({ mime, dataUrl });
    return { id, dataUrl };
  } catch (error) {
    console.error(error);
    toast(`Couldn't add ${file.name || 'that image'}. It may be an unsupported format, or storage may be full.`, { error: true });
    return null;
  }
}
