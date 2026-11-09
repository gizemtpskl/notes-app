/*
 * boot.js: a classic script that runs before anything else. Two jobs:
 *   1. Apply the saved theme before the first paint.
 *   2. Explain what to do when the page is opened from a file, where browsers block
 *      ES modules and the app can't start.
 */
(function () {
  try {
    var theme = localStorage.getItem('personal-notes:theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch (error) {
    // Blocked storage only means the theme is applied slightly later.
  }

  function showStartupNotice(id) {
    var loading = document.getElementById('boot-loading');
    var notice = document.getElementById(id);
    if (loading) loading.hidden = true;
    if (notice) notice.hidden = false;
  }

  window.addEventListener('DOMContentLoaded', function () {
    if (location.protocol === 'file:') showStartupNotice('notice-file');
  });

  // If the module script never starts, for example in a very old browser, say so instead of staying blank.
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!window.__notesStarted && location.protocol !== 'file:') showStartupNotice('notice-failed');
    }, 4000);
  });
})();
