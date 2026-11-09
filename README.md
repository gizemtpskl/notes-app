# Notes

A private notes app for one person. It holds any kind of note, stays organized over thousands of them, and keeps everything in your own browser. There is no server, no account and no tracking, and it works offline.

It's a static site: plain HTML, CSS and JavaScript modules, with no build step.

The one exception to "no server" is optional: you can connect your own Google Calendar. See [Where your data lives](#where-your-data-lives).

## Run it on your computer

Browsers block JavaScript modules on pages opened directly from a file, so it needs a small local server:

```bash
cd notes-app
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Publish it on GitHub Pages

1. Create a repository on GitHub and push this folder to it, with `index.html` at the top level.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, then your branch (usually `main`) and the `/ (root)` folder. Save.
4. After a minute or so, the app is at `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`.

No build or configuration is needed. All paths are relative, so it works from any folder.

**Your notes won't move by themselves.** Browsers keep data separately for each address, so notes made at `localhost` don't appear on your GitHub Pages address. To bring them across: at the old address, go to **Settings → Download backup**. At the new one, use **Settings → Import backup**.

Publishing the app does not publish your notes. They stay in your browser and are never uploaded. A public repository only makes the app's code public.

### Publishing an update

Push your changes. Open copies of the app check for a new version in the background and offer a **Reload** button. There is no version number to bump. If you add a new file to the app, also add it to the `FILES` list in `sw.js`, or it won't be available offline. `tests.html` checks that every listed file exists.

## Dashboard

The app opens on the dashboard (or on the Inbox or your last note: **Settings → Open the app on**). It greets you, has quick capture, and shows widgets in two columns on a wide screen and one on a phone, in the same order:

- **Your day:** everything for today in one list, in time order: timetable blocks, tasks with and without a time, deadlines and Google Calendar events, with what's on now and next marked. Tasks can be ticked here.
- **Your week:** Monday to Sunday at a glance, each day with what it holds, and totals for the week: hours on the timetable, tasks done, deadlines, habits and journal days. On a phone it's a strip of days with counts.
- Then journal check-in, Inbox, course review, habits, continue, pinned notes, "Bored? Try this", tonight's watch, on this day, and tidy-up and backup reminders.

Today's tasks, Schedule, Next 7 days and Weekly progress are also available in **Edit dashboard**. They start switched off, because Your day and Your week cover them. A widget with nothing to show shrinks to an "All clear" line or hides.

**Edit dashboard** lets you drag widgets into a new order (or use the arrows), make one wide, hide it, and set options, such as which list feeds Today's tasks or "Bored?". Journal entries never appear unless you allow them in **On this day**, and then only their titles.

- **Journal check-in:** one tap sets today's mood or energy, starting today's entry if needed.
- **Habits:** daily habits you define, ticked from the dashboard, with a streak and the last seven days.
- **Course review:** flashcards use spaced repetition. A card you get right comes back after 1, 3, 7, 14, then 30 days, and one you miss comes back tomorrow. New cards are due straight away. **Exam prep** has the same **Review** button.

## Timetable

**Timetable** in the sidebar (`G` then `C`) has a week grid, a single day and an agenda list. On a phone it opens on today, and swiping sideways changes the day.

- **Adding:** type a line like `German Tue 18:15-20:00` and press Enter, click an empty spot in the grid, or use **New block**. Typed lines are shown in the editor first, so you can check them.
- **Repeating:** pick weekdays, every week, every 2 weeks, or odd or even weeks. A semester stops its blocks on its last day (**Hours and semesters**).
- **One week only:** opening a repeating block asks whether to change only that occurrence or all of them. One occurrence can also be cancelled and brought back.
- **Overlaps:** the editor warns about them before you save, and the grid shows them side by side, marked in words.
- **Dragging (mouse or pen):** draw a block on an empty part of a day, drag a block to move it, or drag its bottom edge to change its end. Times snap to 15 minutes, and Esc puts it back. On a touch screen a finger scrolls the grid, so blocks are changed in their editor there.
- **Tasks:** **Tasks** opens a list of open tasks. Drag one onto a day, or use **Schedule**. The block keeps the task's checkbox, and **Unschedule** puts it back in the list. Ticking it on either side ticks it on both.
- **Notes for a session:** a block's editor has **Write the lecture note** for classes and study sessions, which makes a course note with the date and lecture number, and **Write a note for this session** for anything else. The note links back to its session.
- **Reminders:** choose one in a block's editor. They show while the app is open in a tab, as a notification if you allow it. A static site has no server, so it can't remind you while it's closed.
- **More (⋯):** **Find free time**, **Print this week**, **Export as .ics**, and **Import an .ics file**, which shows what's in the file and lets you choose before anything is added. Calendar files use local times, and odd or even weeks are written out week by week, because calendar apps can't express them.
- **Keyboard:** Tab to a block, use the arrow keys to move between blocks, and press Enter to open one.

## Where your data lives

- Everything is stored in this browser on this device, in IndexedDB. If that's blocked, it falls back to localStorage, and as a last resort to memory, with a warning.
- There is no copy anywhere else. Clearing your browser data or losing the device loses your notes unless you have a backup. The app reminds you after 14 days without one.
- **Backups:** Settings has a JSON backup of everything, including images and version history, which can be imported again. Markdown exports (a note, a collection, or everything as a zip) are for reading elsewhere.
- **Passcode lock (optional):** encrypts everything stored on the device with AES-GCM, using a key protected by your passcode (PBKDF2 with SHA-256, 600,000 rounds). **A forgotten passcode cannot be recovered.** Backup files are not encrypted, so keep them somewhere safe. The lock protects what's stored on the device, for instance from someone reading the browser's files. It doesn't protect against anything running in the browser while the app is unlocked. It needs https or localhost.
- **Google Calendar (optional, off by default):** when you set it up in **Settings → Google Calendar**, the text, date and time of tasks that have a time go to your main Google calendar, and today's events are copied to the Today page. Tasks in private notes are never sent. The access token stays in memory only, and the link's data is left out of backups.
- A strict Content Security Policy blocks injected scripts and every external request except to Google's sign-in and Calendar addresses, which the app only contacts once Google Calendar is turned on. Opening a note can never contact another site.

## How notes are organized

Four independent layers. A note's place, kind and connections can each change without affecting the others.

| Layer | What it is | Example |
|---|---|---|
| **Space** | A broad area of life, about 8 at most. A note is in one, or in none while in the Inbox. | School, Personal, Fun |
| **Collection** | A project, list or notebook inside a space, nested one level at most. | DL-FS2026 › Lecture notes |
| **Type** | What kind of note it is: its fields and views. Built-in and custom types use one system. | Journal entry, Checklist, Watchlist item |
| **Tags and links** | Connections across everything. | `#thesis`, `[[Another note]]` |

### The data model

```mermaid
erDiagram
    SPACE ||--o{ COLLECTION : contains
    COLLECTION ||--o{ COLLECTION : "nests one level"
    SPACE ||--o{ NOTE : holds
    COLLECTION ||--o{ NOTE : holds
    NOTETYPE ||--o{ NOTE : "gives fields to"
    NOTETYPE ||--o{ COLLECTION : "is the default of"
    NOTE }o--o{ TAG : "tagged with"
    NOTE }o--o{ NOTE : "links to"
    NOTE ||--o{ VERSION : "keeps the last 20"
    NOTETYPE ||--o{ TEMPLATE : "shapes"
    SAVEDVIEW }o--o{ NOTE : "shows by filter"
    SEMESTER ||--o{ TIMEBLOCK : "bounds"
    SPACE ||--o{ TIMEBLOCK : "colors"
    TIMEBLOCK }o--o| NOTE : "links to"
    HABIT { string id string name string icon number order object done }
    TIMEBLOCK }o--o| NOTE : "gives a task in it a time"
    TIMEBLOCK ||--o{ NOTE : "has notes for its sessions"

    SPACE { string id string name string icon string color number order }
    COLLECTION { string id string name string spaceId string parentId string defaultTypeId object view number order }
    NOTETYPE { string id string name string icon array fields string defaultView boolean builtin }
    NOTE { string id string title html body string spaceId string collectionId string typeId object fields array tagIds array links boolean pinned boolean favorite boolean archived boolean private number trashedAt number created number updated number opened }
    TAG { string id string name }
    SAVEDVIEW { string id string name object filter object view boolean pinned number order }
    TEMPLATE { string id string name string typeId string title html body object fields array tagIds }
    VERSION { number at string title html body object fields array tagIds }
    TIMEBLOCK { string id string title string type date date string start string end object repeat string semesterId string spaceId string collectionId string noteId string color string location object exceptions number reminder object task object sessions string uid }
    SEMESTER { string id string name date start date end }
```

Rules worth knowing:

- A note is in the Inbox exactly when `spaceId` is `null`.
- `note.links` is always worked out from the body and "Link to a note" fields. Backlinks aren't stored at all.
- Field values are stored by field id, so renaming a field keeps its data, and changing a note's type and back loses nothing.
- Built-in types and templates live in the code. They are never stored or exported.
- A time block repeating weekly is stored once. Each week is worked out when it's shown, and a change to one week is kept in `exceptions` under the date it originally fell on. Times are wall-clock times, so daylight saving never moves a class.

## Folders

```text
index.html              The app's only page
tests.html              Data layer tests, with pass or fail for each
sw.js                   Offline support
manifest.webmanifest    Install information
css/                    Design tokens (theme.css) and styles
data/defaults.json      Starting spaces and collections, offered on first run
icons/                  App icons
vendor/katex/           Math rendering, a local copy (MIT license)
js/
  app.js                Startup, routing, banners
  pwa.js                Service worker setup
  data/                 The data layer, with no user interface
    schema.js           The data model
    db.js               All reads and writes
    storage.js          IndexedDB, localStorage and memory, behind one interface
    crypto.js           The optional passcode lock
    types.js            Built-in note types
    fieldKinds.js       What each kind of field can hold
    html.js             Sanitizing note bodies, and Markdown conversion
    search.js           Full-text search
    filters.js          Filters for lists and saved views
    links.js            Wiki links
    templates.js        Note templates
    porting.js          Backup, import and Markdown export
    timetable.js          Timetable repeats, exceptions, semesters, conflicts, free time
    ics.js                Timetable to and from .ics calendar files
    reminders.js          Which timetable reminders are due
    habits.js             Daily habits and streaks
    review.js             Spaced repetition for flashcards
    dashboard.js          Which dashboard widgets show, in what order and size
    agenda.js             What a day and a week hold, for Your day and Your week
    googleCalendar.js     The optional Google Calendar link
    flashcards.js, journal.js, tasks.js, taskText.js, daily.js, picker.js, tidy.js, weekly.js, stats.js, filing.js, dates.js, text.js, zip.js
  editor/               The rich text editor, math and code colors
  ui/                   Small building blocks: elements, dialogs, menus, toasts, icons
  views/                Every page and dialog
```

`js/data/db.js` explains how the data layer works at the top of the file, and how to add an operation.

## Connect Google Calendar

This is optional and free. It needs a Google project of your own, because a site with no server has nowhere to keep a shared one. **Settings → Google Calendar** has the steps and shows the exact address to register. Register each address you use: both `http://localhost:8000` and `http://localhost` on your computer, and `https://YOUR-USERNAME.github.io`, with no folder, on GitHub Pages.

While the Google project is in Testing, Google asks you to approve access again about once a week. A sign-in lasts about an hour and ends when the page reloads, so the Today page shows a **Sign in** button when one is needed.

## Testing

Open `/tests.html` while the app is running. It tests the data layer on a temporary in-memory database, so your real notes are never touched: creating, moving, archiving and restoring notes, search, tag merging, backlinks, import and export round trips, invalid imports, encryption and more. Each test shows pass or fail.

## Keyboard

Press `?` anywhere for the full list. The ones used most:

| Keys | What it does |
|---|---|
| `N` | Quick capture to the Inbox. `Ctrl/Cmd+N` too, where the browser allows it. |
| `Ctrl/Cmd+K` | Search and commands |
| `G` then `H`, `O`, `C` or `I` | Go to the Dashboard, Today, Timetable or Inbox |
| `[[` | Link to another note, while writing |
| `/` | Insert a block, while writing |
| `$x^2$` | A math formula, while writing |

## Browser support

Built for current versions of Chrome, Edge, Safari and Firefox. Code block colors need the CSS Custom Highlight API. Where it's missing, code simply appears in one color. Installing as an app works differently in each browser: see **Settings → Use it offline**.

## Credits

Math is drawn by [KaTeX](https://katex.org), copyright Khan Academy and other contributors, used under the MIT license. See `vendor/katex/LICENSE`.
