/**
 * app.js: startup, the app shell, routing and banners.
 *
 * Routes (hash based, so the app works from any folder on GitHub Pages):
 *   #/home  #/inbox  #/inbox/review  #/space/:id  #/collection/:id  #/note/:id
 *   #/favorites  #/archive  #/trash  #/settings  #/types  #/types/:id
 *   #/tags  #/tag/:id  #/views  #/view/:id  #/today  #/search?q=
 *   #/templates  #/review  #/tidy  #/stats
 */
import { app } from './context.js';
import { readLock } from './data/crypto.js';
import { NotesDb } from './data/db.js';
import { openStorage } from './data/storage.js';
import { startPwa } from './pwa.js';
import { fill, frameThrottle, h, modName } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { newNote } from './views/actions.js';
import { startCalendarSync } from './views/calendarConnection.js';
import { startReminders } from './views/reminders.js';
import { dashboardLayout } from './data/dashboard.js';
import { openCaptureDialog } from './views/capture.js';
import { collectionView, notFound, spaceView } from './views/folder.js';
import { runLockScreen } from './views/lockScreen.js';
import { lockNow, startAutoLock } from './views/lockSettings.js';
import { statsPageView } from './views/statsPage.js';
import { homeView } from './views/home.js';
import { inboxReviewView, inboxView } from './views/inbox.js';
import { archiveView, favoritesView, trashView } from './views/lists.js';
import { noteView } from './views/note.js';
import { openPalette } from './views/palette.js';
import { searchPageView } from './views/searchPage.js';
import { templatesPageView } from './views/templatesPage.js';
import { timetableView } from './views/timetable.js';
import { tidyPageView } from './views/tidyPage.js';
import { todayView } from './views/today.js';
import { weeklyReviewView } from './views/weeklyReview.js';
import { runOnboarding } from './views/onboarding.js';
import { savedView, savedViewsPageView } from './views/savedViews.js';
import { tagView, tagsPageView } from './views/tags.js';
import { settingsView } from './views/settings.js';
import { typeEditorView, typesListView } from './views/typesPage.js';
import { installShortcuts, showShortcuts } from './views/shortcuts.js';
import { createSidebar } from './views/sidebar.js';
import { applyTheme } from './views/theme.js';
import { exportBackup } from './views/transfer.js';

window.__notesStarted = true;

function resolveRoute(path) {
  const [clean, query] = path.split('?');
  const [first, second] = clean.split('/');
  switch (first) {
    case 'home': return { key: 'home', build: homeView };
    case 'inbox': return second === 'review'
      ? { key: 'inbox/review', build: inboxReviewView }
      : { key: 'inbox', build: inboxView };
    case 'space': return { key: `space/${second}`, build: () => spaceView({ id: second }) };
    case 'collection': return { key: `collection/${second}`, build: () => collectionView({ id: second }) };
    case 'note': return { key: `note/${second}`, build: () => noteView({ id: second, isNew: query === 'new' }) };
    case 'today': return { key: 'today', build: todayView };
    case 'timetable': return { key: 'timetable', build: () => timetableView({ query }) };
    case 'templates': return { key: 'templates', build: templatesPageView };
    case 'review': return { key: 'review', build: weeklyReviewView };
    case 'tidy': return { key: 'tidy', build: tidyPageView };
    case 'stats': return { key: 'stats', build: statsPageView };
    case 'search': return { key: `search?${query ?? ''}`, build: () => searchPageView({ query }) };
    case 'tags': return { key: 'tags', build: tagsPageView };
    case 'tag': return { key: `tag/${second}`, build: () => tagView({ id: decodeURIComponent(second) }) };
    case 'views': return { key: 'views', build: savedViewsPageView };
    case 'view': return { key: `view/${second}`, build: () => savedView({ id: decodeURIComponent(second), isNew: query === 'new' }) };
    case 'favorites': return { key: 'favorites', build: favoritesView };
    case 'archive': return { key: 'archive', build: archiveView };
    case 'trash': return { key: 'trash', build: trashView };
    case 'settings': return { key: 'settings', build: settingsView };
    case 'types': return second
      ? { key: `types/${second}`, build: () => typeEditorView({ id: decodeURIComponent(second) }) }
      : { key: 'types', build: typesListView };
    default: return { key: 'missing', build: () => notFound("This page doesn't exist.") };
  }
}

function currentPath() {
  return location.hash.replace(/^#\/?/, '') || 'home';
}

function startShell() {
  const { db } = app;
  const sidebar = createSidebar();
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const banners = h('div', { class: 'banners' });
  const scrim = h('div', { class: 'scrim', onClick: () => app.setSidebarOpen(false) });
  const content = h('div', { class: 'main-content' }, banners, main);

  const menuButton = h('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': 'Open navigation',
    'aria-expanded': 'false',
    onClick: () => app.setSidebarOpen(true),
  }, icon('menu', 20));

  const aside = h('aside', { class: 'sidebar', id: 'sidebar' },
    h('div', { class: 'sidebar-top' },
      h('button', {
        class: 'capture-button',
        type: 'button',
        onClick: () => {
          app.setSidebarOpen(false);
          app.openCapture();
        },
      }, icon('plus', 17), h('span', null, 'Quick capture'), h('kbd', null, 'N')),
      h('button', {
        class: 'search-button',
        type: 'button',
        onClick: () => {
          app.setSidebarOpen(false);
          app.openPalette();
        },
      }, icon('search', 16), h('span', null, 'Search'), h('kbd', null, `${modName} K`))),
    sidebar.el);

  const fab = h('button', {
    class: 'fab',
    type: 'button',
    'aria-label': 'Quick capture',
    onClick: () => app.openCapture(),
  }, icon('plus', 24));

  const shell = h('div', { class: 'app' },
    h('a', { class: 'skip-link', href: '#main', onClick: (event) => { event.preventDefault(); main.focus(); } }, 'Skip to content'),
    h('header', { class: 'topbar' },
      menuButton,
      h('span', { class: 'topbar-title' }),
      h('button', {
        class: 'icon-btn topbar-search', type: 'button', 'aria-label': 'Search', onClick: () => app.openPalette(),
      }, icon('search', 19))),
    aside, scrim, content, fab);
  document.body.append(shell);
  const topbarTitle = shell.querySelector('.topbar-title');

  app.setSidebarOpen = (open) => {
    document.body.classList.toggle('sidebar-open', open);
    menuButton.setAttribute('aria-expanded', String(open));
    if (open) sidebar.el.querySelector('.nav-link')?.focus();
  };
  app.openCapture = openCaptureDialog;
  app.openPalette = openPalette;
  app.currentNoteId = () => (viewKey?.startsWith('note/') ? viewKey.slice(5) : null);
  app.showShortcuts = showShortcuts;
  app.toggleFocus = (force) => {
    const next = force ?? !document.body.classList.contains('focus-mode');
    document.body.classList.toggle('focus-mode', next);
    if (next) toast('Focus mode. Press Esc to leave.', { duration: 2500 });
  };
  app.navigate = (path) => {
    if (currentPath() === path) route();
    else location.hash = `#/${path}`;
  };
  app.reloadRoute = () => route(true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
      app.setSidebarOpen(false);
      menuButton.focus();
    }
  });

  // -- Routing ---------------------------------------------------------------------------

  let view = null;
  let viewKey = null;

  function route(force = false) {
    const path = currentPath();
    const target = resolveRoute(path);
    if (!force && target.key === viewKey && view) return;
    view?.destroy?.();
    if (path.endsWith('?new')) history.replaceState(null, '', `#/${path.replace('?new', '')}`);
    let built;
    try {
      built = target.build();
    } catch (error) {
      console.error(error);
      built = notFound('This page could not be opened.');
    }
    view = built;
    viewKey = target.key;
    // Remembered on this device only, for "Open the app on: the last note I opened".
    if (viewKey.startsWith('note/') && db.getMeta('lastNoteId') !== viewKey.slice(5)) db.setMeta('lastNoteId', viewKey.slice(5));
    renderBanners();
    main.replaceChildren(view.el);
    main.scrollTop = 0;
    document.title = `${view.title} · Notes`;
    topbarTitle.textContent = view.title;
    sidebar.setActive(target.key);
    view.mounted?.();
    if (!view.keepsFocus && !document.querySelector('dialog[open]')) {
      main.querySelector('.page-title')?.focus({ preventScroll: true });
    }
    document.body.classList.remove('focus-mode');
  }

  window.addEventListener('hashchange', () => route());

  // -- Reacting to data changes ----------------------------------------------------------

  let pendingStructural = false;
  const pendingChange = { stores: new Set(), ids: new Set(), structural: false, source: 'local' };

  const flushChanges = frameThrottle(() => {
    if (pendingStructural) sidebar.render();
    else if (pendingChange.stores.has('notes') || pendingChange.ids.has('gcalEvents')) sidebar.refreshDue();
    pendingStructural = false;
    const change = {
      stores: new Set(pendingChange.stores),
      ids: new Set(pendingChange.ids),
      structural: pendingChange.structural,
      source: pendingChange.source,
    };
    pendingChange.stores.clear();
    pendingChange.ids.clear();
    pendingChange.structural = false;
    pendingChange.source = 'local';

    if (view?.reloadIf?.(change)) {
      route(true);
      return;
    }
    view?.update?.(change);
    renderBanners();
  });

  db.on((change) => {
    if (change.structural) pendingStructural = true;
    for (const store of change.stores) pendingChange.stores.add(store);
    for (const id of change.ids) pendingChange.ids.add(id);
    pendingChange.structural ||= change.structural;
    if (change.source === 'remote') pendingChange.source = 'remote';
    flushChanges();
  });

  // -- Banners ---------------------------------------------------------------------------

  let saveFailed = false;
  db.onPersistError(() => {
    saveFailed = true;
    renderBanners();
  });

  function banner(text, ...actions) {
    return h('div', { class: 'banner', role: 'status' }, h('span', { class: 'banner-text' }, text), actions);
  }

  const dashboardShowsNudge = () => dashboardLayout(db.getSettings()).some((w) => w.id === 'nudge' && w.on);

  function renderBanners() {
    fill(banners,
      db.storage.kind === 'memory' && banner('This browser is blocking storage. Notes will be lost when you close this page. Download a backup from Settings before leaving.'),
      db.storage.kind === 'localstorage' && banner('This browser is blocking the main database, so notes are kept in a small fallback store with limited space. Keep backups.'),
      saveFailed && banner("Your latest changes couldn't be saved. Device storage may be full. Download a backup now, then free up some space.",
        h('button', { class: 'btn btn-small', type: 'button', onClick: exportBackup }, 'Download backup')),
      // The dashboard has its own backup reminder at the bottom.
      db.backupDue() && !(viewKey === 'home' && dashboardShowsNudge()) && banner("It's been a while since your last backup. Your notes exist only on this device.",
        h('button', {
          class: 'btn btn-small btn-primary',
          type: 'button',
          onClick: async () => {
            await exportBackup();
            renderBanners();
          },
        }, 'Download backup'),
        h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => {
            db.snoozeBackup();
            renderBanners();
          },
        }, 'Later')),
    );
  }

  // -- Start -----------------------------------------------------------------------------

  installShortcuts({
    getNewNoteTarget: () => view?.newNoteTarget ?? {},
    newNote,
    toggleSidebar: () => document.body.classList.toggle('sidebar-hidden'),
  });

  sidebar.render();
  renderBanners();
  route(true);
}

async function start() {
  // The app's files work offline even before the passcode is entered.
  startPwa();
  let storage = await openStorage();
  const lock = await readLock(storage);
  if (lock) {
    document.getElementById('boot')?.remove();
    storage = await runLockScreen(storage, lock);
  }
  const db = new NotesDb(storage);
  await db.open();
  app.db = db;
  db.onRemoteErase = () => location.reload();

  // Writes are grouped on a short timer, so save right away when the page may be going away.
  // This runs after the note page's own listeners, which add any unsaved text first.
  window.addEventListener('pagehide', () => db.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') db.flush();
  });

  applyTheme(db.getSettings().theme);

  // Asks the browser not to clear this data under storage pressure. Some browsers decide silently.
  navigator.storage?.persist?.().catch(() => {});

  document.getElementById('boot')?.remove();

  if (!db.getMeta('onboarded')) {
    if (db.data.notes.size === 0) await runOnboarding();
    else db.setMeta('onboarded', true);
  }
  // The backup reminder counts from here until the first export.
  if (!db.getMeta('firstUsedAt')) db.setMeta('firstUsedAt', Date.now());

  // Opening the app's plain address goes to the screen chosen in Settings.
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    const choice = db.getSettings().startScreen;
    const last = db.getMeta('lastNoteId');
    const note = choice === 'last' && last ? db.getNote(last) : null;
    if (choice === 'inbox') history.replaceState(null, '', '#/inbox');
    else if (note && !note.trashedAt) history.replaceState(null, '', `#/note/${encodeURIComponent(note.id)}`);
  }

  startShell();
  startCalendarSync();
  startReminders();
  startAutoLock();
  app.lockNow = lockNow;

  // Done after startup so it can never slow down opening the app.
  setTimeout(() => {
    db.collectOrphanAssets().catch((error) => console.warn('Image cleanup skipped:', error));
    db.collectOrphanVersions().catch((error) => console.warn('Version cleanup skipped:', error));
  }, 5000);
}

start().catch((error) => {
  console.error(error);
  const failed = document.getElementById('notice-failed');
  document.getElementById('boot-loading')?.setAttribute('hidden', '');
  if (failed) failed.hidden = false;
});
