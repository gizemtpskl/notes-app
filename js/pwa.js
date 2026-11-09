/**
 * pwa.js: installs the service worker so the app works offline, offers to reload when a new version
 * is ready, and remembers the browser's offer to install the app.
 */
import { toast } from './ui/toast.js';

const CHECK_EVERY_MS = 60 * 60 * 1000;

let installPrompt = null;
const listeners = new Set();

/** True when the browser has offered to install the app. */
export const canInstall = () => Boolean(installPrompt);

export function onInstallChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function promptInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  listeners.forEach((listener) => listener());
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  listeners.forEach((listener) => listener());
});

export async function startPwa() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data === 'update-ready') {
        toast('A new version is ready.', {
          duration: 60000,
          action: { label: 'Reload', run: () => location.reload() },
        });
      }
    });
    const check = () => navigator.serviceWorker.ready.then((ready) => ready.active?.postMessage('check-for-update'));
    check();
    setInterval(check, CHECK_EVERY_MS);
  } catch (error) {
    // The app still works without it, only not offline.
    console.warn('Offline support is unavailable:', error);
  }
}
