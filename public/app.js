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
    // an open dialog (confirm, reject reason) handles its own keys, Escape included
    if (document.querySelector("dialog[open]")) return;
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
    // It only moves the focus: a slash command starts with a `/` typed in the box.
    if (e.key === "/") {
      f = document.querySelector("form.prompt textarea");
      if (f) {
        e.preventDefault();
        f.focus();
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
    // a todo card may also move within its column: that reorders the queue
    if (card.dataset.status === "todo") targets.push("todo");
    columns().forEach((col) => {
      col.classList.toggle("can-drop", targets.indexOf(col.dataset.status) >= 0);
    });
  });
  document.addEventListener("dragend", () => {
    clearMarks();
    endDrag();
  });
  // reordering todo: where in the column the card would land (before or after a card)
  function clearMarks() {
    document.querySelectorAll(".drop-before, .drop-after").forEach((c) => {
      c.classList.remove("drop-before", "drop-after");
    });
  }
  function placeIn(col, e) {
    var cards = Array.prototype.slice
      .call(col.querySelectorAll(".card.topic"))
      .filter((c) => c !== dragging);
    var index = cards.findIndex((c) => {
      var box = c.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    return { cards: cards, index: index < 0 ? cards.length : index };
  }
  document.addEventListener("dragover", (e) => {
    var at;
    var col = dragging && columnAt(e, ".column.can-drop");
    if (!col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    columns().forEach((c) => {
      c.classList.toggle("over", c === col);
    });
    clearMarks();
    if (col.dataset.status === "todo" && dragging.dataset.status === "todo") {
      at = placeIn(col, e);
      if (at.index < at.cards.length) at.cards[at.index].classList.add("drop-before");
      else if (at.cards.length) at.cards[at.cards.length - 1].classList.add("drop-after");
    }
  });
  document.addEventListener("drop", (e) => {
    var at, ids;
    var col = dragging && columnAt(e, ".column.can-drop");
    if (!col) return;
    e.preventDefault();
    var id = dragging.dataset.id;
    var from = dragging.dataset.status;
    var to = col.dataset.status;
    if (from === "todo" && to === "todo") {
      at = placeIn(col, e);
      ids = at.cards.map((c) => c.dataset.id);
      ids.splice(at.index, 0, id);
      clearMarks();
      endDrag();
      fetch(`${d.base || ""}/topics/order`, {
        method: "POST",
        body: new URLSearchParams({ ids: ids.join(",") }),
      }).then(
        (r) => {
          if (!r.ok) showDropError(col, "");
        },
        () => {
          showDropError(col, "");
        },
      );
      return;
    }
    clearMarks();
    endDrag();
    var body = new URLSearchParams({ status: to });
    var send = () =>
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
    if (from === "review" && to === "active") {
      ask("Reason for rejecting (required):", { input: true, ok: "Reject", danger: true }).then(
        (note) => {
          if (!note?.trim()) return;
          body.set("note", note.trim());
          send();
        },
      );
      return;
    }
    if (to === "cancelled") {
      ask("Cancel this topic?", { ok: "Cancel topic", danger: true }).then((yes) => {
        if (yes) send();
      });
      return;
    }
    send();
  });

  // A dialog in the page's style instead of the browser's confirm()/prompt(). Resolves
  // with true (or the typed text) on OK, null on cancel or Escape.
  function ask(message, opts) {
    var o = opts || {};
    return new Promise((resolve) => {
      var dlg = document.createElement("dialog");
      dlg.className = "confirm";
      var form = document.createElement("form");
      form.method = "dialog";
      var p = document.createElement("p");
      p.textContent = message;
      form.appendChild(p);
      var input = null;
      if (o.input) {
        input = document.createElement("input");
        input.autocomplete = "off";
        form.appendChild(input);
      }
      var row = document.createElement("div");
      row.className = "row";
      // not a submit button: Enter in the input must mean OK, not the first button
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        dlg.close("cancel");
      });
      var ok = document.createElement("button");
      ok.value = "ok";
      ok.textContent = o.ok || "OK";
      ok.className = o.danger ? "danger" : "primary";
      row.appendChild(cancel);
      row.appendChild(ok);
      form.appendChild(row);
      dlg.appendChild(form);
      document.body.appendChild(dlg);
      dlg.addEventListener("close", () => {
        var yes = dlg.returnValue === "ok";
        var value = input ? input.value : true;
        dlg.remove();
        resolve(yes ? value : null);
      });
      dlg.showModal();
      (input || ok).focus();
    });
  }
  // htmx's hx-confirm goes through the same dialog; OK is labelled like the button
  document.body.addEventListener("htmx:confirm", (e) => {
    var q = e.detail.question;
    if (!q) return;
    e.preventDefault();
    var elt = e.detail.elt;
    var label = (elt?.textContent || "").trim() || "OK";
    var danger =
      !!elt?.classList && (elt.classList.contains("danger") || elt.classList.contains("delete"));
    ask(q, { ok: label, danger: danger }).then((yes) => {
      if (yes) e.detail.issueRequest(true);
    });
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

  // a button with data-copy puts that text on the clipboard; data-copy-code (on code
  // blocks, see format.ts) copies the block next to it
  document.addEventListener("click", (e) => {
    var b = e.target?.closest
      ? e.target.closest("button[data-copy], button[data-copy-code]")
      : null;
    if (!b) return;
    e.preventDefault();
    var pre = b.hasAttribute("data-copy-code") ? b.parentNode.querySelector("pre") : null;
    var text = pre ? pre.textContent.replace(/\n$/, "") : b.dataset.copy;
    if (!navigator.clipboard) {
      window.prompt("Copy this:", text);
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
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
      // a key never toggled takes its default: a morph keeps `open` from the old key
      if (o === undefined && d.dataset.defaultOpen !== undefined) o = true;
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
  // Hold the inbox still while you are using it. A live refresh that puts a new question
  // on top shifts every card down, and the button under your pointer turns into a
  // different one just as you click. So while the pointer moves over the inbox, or you
  // type in it, refreshes wait until you pause (HOLD_MS), for at most HOLD_MAX_MS.
  var HOLD_MS = 1500;
  var HOLD_MAX_MS = 20000;
  var lastMove = 0;
  var overInbox = false;
  var heldSince = 0;
  var retry = null;
  var forceNext = false;
  document.addEventListener("pointermove", (e) => {
    lastMove = Date.now();
    overInbox = !!e.target?.closest?.("#inbox");
  });
  function usingInbox() {
    var a = document.activeElement;
    var typing = !!a?.closest?.("#inbox") && inField(a);
    return typing || (overInbox && Date.now() - lastMove < HOLD_MS);
  }
  document.body.addEventListener("htmx:beforeRequest", (e) => {
    var el = e.detail?.elt;
    if (el?.id !== "inbox" || e.detail.requestConfig?.verb !== "get") return;
    if (forceNext || !usingInbox()) {
      forceNext = false;
      heldSince = 0;
      return;
    }
    heldSince = heldSince || Date.now();
    if (Date.now() - heldSince > HOLD_MAX_MS) {
      heldSince = 0;
      return; // held long enough: refresh anyway
    }
    e.preventDefault();
    showHeld();
    if (!retry)
      retry = setTimeout(() => {
        retry = null;
        htmx.trigger(el, "sse:changed");
      }, 700);
  });
  // While a refresh is held, the Inbox badge in the header pulses gently: something new
  // is waiting. Nothing on the page moves; a click on the badge shows it right away.
  var holding = false;
  function markBadge() {
    var b = document.getElementById("inbox-badge");
    if (b) b.classList.toggle("held", holding);
  }
  function showHeld() {
    holding = true;
    markBadge();
  }
  function hideHeld() {
    holding = false;
    markBadge();
  }
  document.addEventListener("click", (e) => {
    var inbox = document.getElementById("inbox");
    if (!holding || !inbox || !e.target?.closest?.("#inbox-badge")) return;
    e.preventDefault(); // the badge sits in the Inbox link: stay here, just show what is new
    hideHeld();
    heldSince = 0;
    forceNext = true; // this refresh goes through, even while typing
    htmx.trigger(inbox, "sse:changed");
  });
  document.body.addEventListener("htmx:afterSwap", (e) => {
    var id = e.detail?.target?.id;
    if (id === "inbox") hideHeld();
    else if (id === "inbox-badge") markBadge(); // the badge was replaced: keep its pulse
  });
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
