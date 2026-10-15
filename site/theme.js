// Color theme: "system" (default), "light" or "dark", remembered per viewer.
// Loaded in <head> so a saved theme applies before first paint.
(function () {
  var root = document.documentElement;
  root.classList.add("js");

  function saved() {
    try { return localStorage.getItem("theme"); } catch (e) { return null; }
  }

  function apply(theme) {
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    else { theme = "system"; delete root.dataset.theme; }
    document.querySelectorAll("[data-set-theme]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.setTheme === theme));
    });
    return theme;
  }

  apply(saved());
  document.addEventListener("DOMContentLoaded", function () {
    apply(saved());
    document.querySelectorAll("[data-set-theme]").forEach(function (button) {
      button.addEventListener("click", function () {
        var theme = apply(button.dataset.setTheme);
        try {
          if (theme === "system") localStorage.removeItem("theme");
          else localStorage.setItem("theme", theme);
        } catch (e) {}
      });
    });
  });
})();
