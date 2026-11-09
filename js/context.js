/**
 * context.js: shared app services. Set up once by app.js, then imported by views.
 *   app.db            the NotesDb instance
 *   app.navigate      go to a route, e.g. app.navigate('note/abc')
 *   app.openCapture   open the quick capture box
 *   app.toggleFocus   enter or leave distraction-free mode
 */
export const app = {
  db: null,
  navigate: () => {},
  openCapture: () => {},
  toggleFocus: () => {},
  setSidebarOpen: () => {},
  showShortcuts: () => {},
};
