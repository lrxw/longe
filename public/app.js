// Keyboard navigation. No build step, no framework.
//
// One inbox (`/`), one board and one chat per repo (`<base>/board`, `<base>/chat`).
// The body carries data-base:
// the repo prefix of the current page, empty on the inbox (and in single mode).
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
  var d = document.body.dataset;
  function back() {
    var sameOrigin = document.referrer && document.referrer.indexOf(location.origin) === 0;
    if (sameOrigin && history.length > 1) history.back();
    else location.href = `${d.base || ""}/board`;
  }
  document.addEventListener("keydown", (e) => {
    var a, f;
    // Cmd/Ctrl+Enter submits the form you are typing in (prompt box, answer forms)
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && inField(document.activeElement)) {
      f = document.activeElement.form;
      if (f) {
        e.preventDefault();
        f.requestSubmit();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (inField(document.activeElement)) {
        document.activeElement.blur();
        return;
      }
      if (d.page === "topic") back();
      return;
    }
    if (inField(document.activeElement)) return;
    // `/` jumps into the prompt box (chat page, topic page); Escape leaves it again.
    // An empty box gets the `/` too, so typing on starts a slash command.
    if (e.key === "/") {
      f = document.querySelector("form.prompt textarea");
      if (f) {
        e.preventDefault();
        f.focus();
        if (!f.value) {
          f.value = "/";
          showMenu(f);
        }
      }
      return;
    }
    if (e.key === "i") location.href = "/";
    // board of this repo; from the inbox the server picks the one you visited last
    if (e.key === "b") location.href = `${d.base || ""}/board`;
    if (e.key === "c") location.href = `${d.base || ""}/chat`;
    if (e.key >= "1" && e.key <= "9") {
      a = document.querySelector(`nav.repos a[data-n="${e.key}"]`);
      if (a) location.href = a.getAttribute("href");
    }
  });
  // Coming back through the browser's back-forward cache restores the old page as it
  // was, with its SSE stream closed, so changes made in between (say, approving a
  // topic and pressing Escape) are missed. Reload instead.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) location.reload();
  });

  // Drag a topic card onto another column to change its status. The card lists the
  // columns a human may move it to (data-targets, from the transition table); the
  // server checks again and the board refreshes over SSE.
  var dragging = null;
  function columns() {
    return Array.prototype.slice.call(document.querySelectorAll(".column[data-status]"));
  }
  function endDrag() {
    if (dragging) {
      dragging.classList.remove("dragging");
      // a focused element keeps its old content through a morph (ignoreActiveValue);
      // the card is not being edited, so let the refresh update it
      if (document.activeElement === dragging) dragging.blur();
    }
    dragging = null;
    columns().forEach((col) => {
      col.classList.remove("can-drop", "over");
    });
  }
  function columnAt(e, sel) {
    return e.target?.closest ? e.target.closest(sel) : null;
  }
  function showDropError(col, html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    var msg = doc.querySelector(".error");
    var p = document.createElement("p");
    p.className = "drop-error";
    p.textContent = msg ? msg.textContent : "Not allowed.";
    col.appendChild(p);
    setTimeout(() => {
      p.remove();
    }, 6000);
  }
  document.addEventListener("dragstart", (e) => {
    var card = columnAt(e, ".card.topic[draggable]");
    if (!card) return;
    dragging = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.id);
    var targets = (card.dataset.targets || "").split(",");
    columns().forEach((col) => {
      col.classList.toggle("can-drop", targets.indexOf(col.dataset.status) >= 0);
    });
  });
  document.addEventListener("dragend", endDrag);
  document.addEventListener("dragover", (e) => {
    var col = dragging && columnAt(e, ".column.can-drop");
    if (!col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    columns().forEach((c) => {
      c.classList.toggle("over", c === col);
    });
  });
  document.addEventListener("drop", (e) => {
    var col = dragging && columnAt(e, ".column.can-drop");
    if (!col) return;
    e.preventDefault();
    var id = dragging.dataset.id;
    var from = dragging.dataset.status;
    var to = col.dataset.status;
    var note;
    endDrag();
    var body = new URLSearchParams({ status: to });
    if (from === "review" && to === "active") {
      note = window.prompt("Reason for rejecting (required):");
      if (!note?.trim()) return;
      body.set("note", note.trim());
    }
    if (to === "cancelled" && !window.confirm("Cancel this topic?")) return;
    fetch(`${d.base || ""}/topics/${id}/status`, { method: "POST", body: body }).then(
      (r) => {
        if (!r.ok)
          r.text().then((t) => {
            showDropError(col, t);
          });
      },
      () => {
        showDropError(col, "");
      },
    );
  });

  // Slash commands: typing `/` at the start of a prompt box lists the session's commands
  // (from claude's init line). Arrows move, Tab or Enter picks, Escape closes. The menu
  // lives on <body>, so the live refreshes (morph) never touch it. Not in the inbox answer
  // boxes: an answer is stored in the question file, so a command there would never run.
  var commands = null;
  var menu = null;
  var menuField = null;
  var menuItems = [];
  var menuPick = 0;
  function loadCommands() {
    if (commands?.length) return Promise.resolve(commands);
    return fetch(`${d.base || ""}/agent/commands`)
      .then((r) => (r.ok ? r.json() : []))
      .then(
        (list) => {
          commands = Array.isArray(list) ? list : [];
          return commands;
        },
        () => [],
      );
  }
  function hideMenu() {
    if (menu) menu.remove();
    menu = null;
    menuField = null;
  }
  function drawMenu() {
    var box = menuField.getBoundingClientRect();
    menu.innerHTML = "";
    menuItems.forEach((name, i) => {
      var li = document.createElement("li");
      li.textContent = `/${name}`;
      if (i === menuPick) li.className = "on";
      li.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep the focus in the box
        menuPick = i;
        pickCommand();
      });
      menu.appendChild(li);
    });
    menu.style.left = `${box.left + window.scrollX}px`;
    menu.style.top = `${box.bottom + window.scrollY + 2}px`;
    menu.style.minWidth = `${Math.min(box.width, 320)}px`;
    var on = menu.querySelector(".on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }
  function pickCommand() {
    var f = menuField;
    f.value = `/${menuItems[menuPick]} `;
    f.setSelectionRange(f.value.length, f.value.length);
    hideMenu();
  }
  function showMenu(f) {
    var m = /^\/(\S*)$/.exec(f.value);
    if (!m) {
      hideMenu();
      return;
    }
    var q = m[1].toLowerCase();
    loadCommands().then((list) => {
      // the box may have changed while the list loaded
      if (document.activeElement !== f || !/^\/\S*$/.test(f.value)) return;
      var starts = list.filter((n) => n.toLowerCase().indexOf(q) === 0);
      var inside = list.filter((n) => n.toLowerCase().indexOf(q) > 0);
      menuItems = starts.concat(inside);
      if (menuItems.length === 0) {
        hideMenu();
        return;
      }
      if (!menu) {
        menu = document.createElement("ul");
        menu.className = "slash-menu";
        document.body.appendChild(menu);
      }
      menuField = f;
      menuPick = 0;
      drawMenu();
    });
  }
  document.addEventListener("input", (e) => {
    var f = e.target;
    if (f?.matches?.("form.prompt textarea")) showMenu(f);
  });
  document.addEventListener("focusout", (e) => {
    if (e.target === menuField) hideMenu();
  });
  // capture phase: runs before the global keys above (Escape would leave the box)
  document.addEventListener(
    "keydown",
    (e) => {
      var n = menuItems.length;
      if (!menu || e.target !== menuField || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        menuPick = (menuPick + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        drawMenu();
      } else if (e.key === "Tab" || e.key === "Enter") {
        pickCommand();
      } else if (e.key === "Escape") {
        hideMenu();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  // a button with data-copy puts that text on the clipboard
  document.addEventListener("click", (e) => {
    var b = e.target?.closest ? e.target.closest("button[data-copy]") : null;
    if (!b) return;
    e.preventDefault();
    if (!navigator.clipboard) {
      window.prompt("Copy this:", b.dataset.copy);
      return;
    }
    navigator.clipboard.writeText(b.dataset.copy).then(() => {
      var label = b.textContent;
      b.textContent = "Copied";
      setTimeout(() => {
        b.textContent = label;
      }, 1200);
    });
  });

  // The chat panel is replaced every few hundred ms while the agent streams. Remember
  // where you were reading in the transcript before the swap: at the end, follow the
  // stream; anywhere else, stay there.
  var reading = null;
  function transcriptOf(el) {
    return el?.querySelector ? el.querySelector(".transcript") : null;
  }
  // the chat opens at its newest entry
  var first = transcriptOf(document);
  if (first) first.scrollTop = first.scrollHeight;
  // Live refreshes morph the page (idiomorph): elements are updated in place and take
  // the server's attributes. Two things are the reader's, not the server's:
  // - which <details> are open: keep `open` on elements that already exist (new ones
  //   still get the server's initial state);
  // - the value of the field you are typing in.
  if (window.Idiomorph) {
    Idiomorph.defaults.ignoreActiveValue = true;
    Idiomorph.defaults.callbacks.beforeAttributeUpdated = (attr, el) =>
      !(attr === "open" && el.tagName === "DETAILS");
  }
  // Which boxes (<details data-key>) you opened or closed is remembered for this tab and
  // applied again after every refresh and on load, whatever the swap did. Saved on a
  // click of the summary, not on "toggle": a swap that flips `open` fires "toggle" too.
  var OPEN_KEY = "longe:open";
  function openState() {
    try {
      return JSON.parse(sessionStorage.getItem(OPEN_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function applyOpen(root) {
    var state = openState();
    root.querySelectorAll("details[data-key]").forEach((d) => {
      var o = state[d.dataset.key];
      if (o !== undefined && d.open !== o) d.open = o;
    });
  }
  document.addEventListener("click", (e) => {
    var s = e.target?.closest ? e.target.closest("summary") : null;
    var d = s?.parentElement;
    if (d?.tagName !== "DETAILS" || !d.dataset.key) return;
    // the click toggles `open` after this handler: read it on the next tick
    setTimeout(() => {
      var state = openState();
      state[d.dataset.key] = d.open;
      try {
        sessionStorage.setItem(OPEN_KEY, JSON.stringify(state));
      } catch {
        // storage full or disabled: the box just does not remember
      }
    });
  });
  applyOpen(document);
  // Morph still resets the text of fields you are not in (a textarea takes the server's
  // empty content). What you typed there, and the caret, are carried over the swap here.
  var typed = null;
  var FIELDS = "textarea, input:not([type]), input[type=text]";
  function isPage(el) {
    return !!el && /^(board|inbox|topic)$/.test(el.id || "");
  }
  function fieldKey(f) {
    var form = f.form;
    var where = form ? form.getAttribute("hx-post") || form.getAttribute("action") || "" : "";
    return `${where}|${f.name || ""}`;
  }
  function remember(target) {
    var state = { values: {}, focus: null };
    target.querySelectorAll(FIELDS).forEach((f) => {
      var k = fieldKey(f);
      if (f.value) state.values[k] = f.value;
      if (f === document.activeElement)
        state.focus = { key: k, start: f.selectionStart, end: f.selectionEnd };
    });
    return state;
  }
  function restore(target, state) {
    target.querySelectorAll(FIELDS).forEach((f) => {
      var k = fieldKey(f);
      if (state.values[k] !== undefined && !f.value) f.value = state.values[k];
      if (state.focus && state.focus.key === k) {
        f.focus();
        try {
          f.setSelectionRange(state.focus.start, state.focus.end);
        } catch {
          // not every input supports a selection range
        }
      }
    });
  }
  document.body.addEventListener("htmx:beforeSwap", (e) => {
    var target = e.detail?.target;
    var t = transcriptOf(target);
    reading = t
      ? { top: t.scrollTop, atEnd: t.scrollHeight - t.scrollTop - t.clientHeight < 24 }
      : null;
    typed = isPage(target) ? remember(target) : null;
  });
  // The SSE "changed" event names what changed ("repo:id"); after the board or inbox
  // refreshes, only that card is highlighted. Never the whole fragment: that reads as
  // flicker while the agent writes to files.
  var changed = null;
  document.body.addEventListener("htmx:sseMessage", (e) => {
    var d = e.detail || {};
    if (d.type === "changed")
      changed =
        String(d.data || "")
          .split(":")
          .pop() || null;
  });
  // The tab title starts with the blocking count, "(1) Inbox · longe". The server sets
  // it on page load; the inbox badge's refresh keeps it current.
  function titleCount(blocking) {
    if (blocking === undefined) return;
    var n = Number(blocking);
    var rest = document.title.replace(/^\(\d+\) /, "");
    document.title = n > 0 ? `(${n}) ${rest}` : rest;
  }
  function flash(el) {
    el.classList.add("flash");
    setTimeout(() => {
      el.classList.remove("flash");
    }, 600);
  }
  document.body.addEventListener("htmx:afterSwap", (e) => {
    var el = e.detail?.target;
    // an outerHTML swap replaced the target: work on the live element, not the old one
    if (el?.id && !el.isConnected) el = document.getElementById(el.id);
    var t = transcriptOf(el);
    if (t) {
      t.scrollTop = !reading || reading.atEnd ? t.scrollHeight : reading.top;
      reading = null;
    }
    if (isPage(el) && typed) {
      restore(el, typed);
      typed = null;
    }
    if (el) applyOpen(el);
    if (el?.id === "inbox-badge") titleCount(el.dataset.blocking);
    if (el && /^(board|inbox)$/.test(el.id || "")) {
      const card =
        changed && /^[a-z0-9-]+$/.test(changed)
          ? el.querySelector(`.card[data-id="${changed}"]`) || el.querySelector(`#q-${changed}`)
          : null;
      changed = null;
      if (card) flash(card);
    }
  });
})();
