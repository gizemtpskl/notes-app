/**
 * sw.js: makes the app work offline.
 *
 * Every file comes from the cache first, so the app opens instantly with or without a connection.
 * In the background it checks for a newer version by fetching every file and comparing bytes.
 * Only when all of them arrive is the cache replaced, so a dropped connection can never leave a
 * mix of old and new files. The page is then told, and offers to reload. This needs no version
 * number to remember when publishing an update.
 *
 * Notes are never here. They live in IndexedDB, and this file only ever handles the app's own files.
 *
 * WHEN ADDING A FILE to the app, add it to FILES. tests.html checks this list against the server.
 */
const CACHE = 'notes-app';

const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'favicon.ico',
  'apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'data/defaults.json',
  'css/theme.css',
  'css/app.css',
  'css/editor.css',
  'css/fields.css',
  'css/organize.css',
  'css/dashboard.css',
  'css/study.css',
  'css/timetable.css',
  'css/polish.css',
  'js/boot.js',
  'js/app.js',
  'js/context.js',
  'js/pwa.js',
  'js/data/agenda.js',
  'js/data/crypto.js',
  'js/data/daily.js',
  'js/data/dates.js',
  'js/data/db.js',
  'js/data/fieldKinds.js',
  'js/data/filing.js',
  'js/data/filters.js',
  'js/data/dashboard.js',
  'js/data/flashcards.js',
  'js/data/googleCalendar.js',
  'js/data/googleErrors.js',
  'js/data/habits.js',
  'js/data/html.js',
  'js/data/ics.js',
  'js/data/journal.js',
  'js/data/links.js',
  'js/data/picker.js',
  'js/data/porting.js',
  'js/data/reminders.js',
  'js/data/review.js',
  'js/data/schema.js',
  'js/data/search.js',
  'js/data/stats.js',
  'js/data/sync.js',
  'js/data/syncScope.js',
  'js/data/storage.js',
  'js/data/tasks.js',
  'js/data/taskText.js',
  'js/data/templates.js',
  'js/data/text.js',
  'js/data/timetable.js',
  'js/data/tidy.js',
  'js/data/types.js',
  'js/data/weekly.js',
  'js/data/zip.js',
  'js/editor/editor.js',
  'js/editor/highlight.js',
  'js/editor/math.js',
  'js/ui/dialog.js',
  'js/ui/dom.js',
  'js/ui/drag.js',
  'js/ui/icons.js',
  'js/ui/menu.js',
  'js/ui/pointerDrag.js',
  'js/ui/toast.js',
  'js/views/actions.js',
  'js/views/blockDialog.js',
  'js/views/calendarConnection.js',
  'js/views/calendarSettings.js',
  'js/views/calendarViews.js',
  'js/views/capture.js',
  'js/views/collectionViews.js',
  'js/views/dashboardWidgets.js',
  'js/views/courseViews.js',
  'js/views/dialogs.js',
  'js/views/fieldWidgets.js',
  'js/views/filterBar.js',
  'js/views/driveSync.js',
  'js/views/flashcardsField.js',
  'js/views/folder.js',
  'js/views/gridDrag.js',
  'js/views/habitsDialog.js',
  'js/views/googleAuth.js',
  'js/views/historyDialog.js',
  'js/views/home.js',
  'js/views/images.js',
  'js/views/inbox.js',
  'js/views/journal.js',
  'js/views/lists.js',
  'js/views/lockScreen.js',
  'js/views/lockSettings.js',
  'js/views/mathDialog.js',
  'js/views/note.js',
  'js/views/noteLinks.js',
  'js/views/noteList.js',
  'js/views/onboarding.js',
  'js/views/organizeDialog.js',
  'js/views/palette.js',
  'js/views/pickerDialog.js',
  'js/views/reminders.js',
  'js/views/presenter.js',
  'js/views/quiz.js',
  'js/views/savedViews.js',
  'js/views/searchPage.js',
  'js/views/selection.js',
  'js/views/settings.js',
  'js/views/shortcuts.js',
  'js/views/sidebar.js',
  'js/views/statsPage.js',
  'js/views/syncSettings.js',
  'js/views/tags.js',
  'js/views/tasksAgenda.js',
  'js/views/tasksField.js',
  'js/views/templatesPage.js',
  'js/views/theme.js',
  'js/views/tidyPage.js',
  'js/views/timetable.js',
  'js/views/timetableTools.js',
  'js/views/today.js',
  'js/views/transfer.js',
  'js/views/typesPage.js',
  'js/views/weeklyReview.js',
  'vendor/katex/katex.mjs',
  'vendor/katex/katex.min.css',
  'vendor/katex/LICENSE',
  'vendor/katex/fonts/KaTeX_AMS-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
  'vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2',
  'vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Main-Bold.woff2',
  'vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2',
  'vendor/katex/fonts/KaTeX_Main-Italic.woff2',
  'vendor/katex/fonts/KaTeX_Main-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2',
  'vendor/katex/fonts/KaTeX_Math-Italic.woff2',
  'vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2',
  'vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2',
  'vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Script-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Size1-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Size2-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Size3-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Size4-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2',
];

const urls = () => FILES.map((file) => new URL(file, self.registration.scope).href);

/** Fetches every file past any browser cache. Throws unless all of them arrive. */
async function fetchAll() {
  return Promise.all(urls().map(async (url) => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return { url, response };
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const files = await fetchAll();
    const cache = await caches.open(CACHE);
    await Promise.all(files.map(({ url, response }) => cache.put(url, response)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function sameBytes(a, b) {
  if (!a) return false;
  const [x, y] = await Promise.all([a.clone().arrayBuffer(), b.clone().arrayBuffer()]);
  if (x.byteLength !== y.byteLength) return false;
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

let checking = null;

/** Looks for a new version. All or nothing: see the note at the top. */
async function checkForUpdate() {
  let files;
  try {
    files = await fetchAll();
  } catch {
    return false; // Offline, or a file is missing. The current version stays.
  }
  const cache = await caches.open(CACHE);
  let changed = false;
  for (const { url, response } of files) {
    if (!changed && !await sameBytes(await cache.match(url), response)) changed = true;
  }
  if (!changed) return false;
  await Promise.all(files.map(({ url, response }) => cache.put(url, response)));
  for (const client of await self.clients.matchAll()) client.postMessage('update-ready');
  return true;
}

self.addEventListener('message', (event) => {
  if (event.data === 'check-for-update') {
    checking ??= checkForUpdate().finally(() => {
      checking = null;
    });
    event.waitUntil(checking);
  }
});

// A reminder was tapped: bring the app forward, on the timetable.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      open.navigate?.(new URL('./#/timetable', self.registration.scope).href).catch(() => {});
    } else {
      await self.clients.openWindow(new URL('./#/timetable', self.registration.scope).href);
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    // The test page always runs the code on the server, with everything it loads.
    const client = event.clientId ? await self.clients.get(event.clientId) : null;
    const forTests = client?.url.endsWith('/tests.html') || (request.mode === 'navigate' && url.pathname.endsWith('/tests.html'));
    if (forTests) return fetch(request);
    const cache = await caches.open(CACHE);
    const key = request.mode === 'navigate' ? new URL('./', self.registration.scope).href : url.href;
    const cached = await cache.match(key);
    return cached ?? fetch(request);
  })());
});
