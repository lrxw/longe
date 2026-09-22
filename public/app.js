// Keyboard navigation. No build step, no framework.
(() => {
  function inField(el) {
    return (
      el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable)
    );
  }
  function back() {
    var sameOrigin = document.referrer && document.referrer.indexOf(location.origin) === 0;
    if (sameOrigin && history.length > 1) history.back();
    else location.href = document.body.dataset.back || "/board";
  }
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (inField(document.activeElement)) {
        document.activeElement.blur();
        return;
      }
      if (document.body.dataset.page === "topic") back();
      return;
    }
    if (inField(document.activeElement)) return;
    if (e.key === "i") location.href = "/";
    if (e.key === "b") location.href = "/board";
  });
  // flash rows that changed after an SSE refresh
  document.body.addEventListener("htmx:afterSwap", (e) => {
    var el = e.detail && e.detail.target;
    if (el && el.classList) {
      el.classList.add("flash");
      setTimeout(() => {
        el.classList.remove("flash");
      }, 600);
    }
  });
})();
