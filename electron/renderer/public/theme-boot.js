// Runs before the app bundle so the first paint already has the right theme.
// Mirrors resolveDark() in src/lib/theme.ts.
(function () {
  try {
    var t = localStorage.getItem('mn-theme');
    var dark = t === 'dark' || (t !== 'light' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {}
})();
