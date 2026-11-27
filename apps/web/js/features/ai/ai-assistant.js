/* =====================================================================================================
   ai-assistant.js - the AI tab (#/ai): ask questions about your own notes (AQ.aiAssistant)

   Who calls it: app.js mounts it for #/ai with `AQ.aiAssistant.mount(view)` and calls `destroy()` on leave.
   What it does: sends POST /api/v1/ai/ask {question, playlistId?} and shows the answer with citation chips
     that open the lecture at the cited time. A 409 {code:"ai_key_required"} goes to AQ.aiKeys.handleError,
     which leads to the Settings page and retries once the key is saved. Key setup never lives on this tab.
   Privacy: the conversation is kept in memory for this page session only. It is never written to storage.
   Safety: answers come from a model, so they are rendered by a small allow-list renderer (paragraphs, bold,
     inline code, code blocks, lists) that builds DOM nodes with textContent. No innerHTML anywhere.
   Styles: css/ai-assistant.css. Key flow: js/features/ai/ai-keys.js.
   ===================================================================================================== */
(function () {
  "use strict";
  var AQ = (window.AQ = window.AQ || {});

  var MAX_LEN = 500;
  var conversation = []; // [{question, scopeLabel, state:"loading"|"done"|"error", res?, error?}], session only
  var scope = ""; // playlist id, "" = all notes
  var redraw = null; // draw() of the mounted screen, so answers that arrive after leaving and coming back still show

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** "754" -> "12:34", "3725" -> "1:02:05". */
  function clock(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      r = s % 60;
    var mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(r).padStart(2, "0");
  }

  // ===== 1. safe markdown =====
  /** Appends inline text with **bold** and `code` to `parent`. Everything else stays plain text. */
  function inline(parent, text) {
    var re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
    var last = 0,
      m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      parent.appendChild(m[2] != null ? el("strong", null, m[2]) : el("code", null, m[3]));
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  /**
   * Renders a short markdown answer into a fragment. Supported: paragraphs, "- "/"* " and "1. " lists,
   * ``` code blocks, **bold** and `code`. Headings ("# x") become bold paragraphs. Links stay plain text.
   */
  function renderMarkdown(md) {
    var frag = document.createDocumentFragment();
    var lines = String(md || "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    var para = [],
      list = null,
      code = null;
    function flushPara() {
      if (!para.length) return;
      var p = el("p");
      inline(p, para.join(" "));
      frag.appendChild(p);
      para = [];
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (code) {
        if (/^\s*```/.test(line)) {
          code = null;
        } else {
          code.textContent += (code.textContent ? "\n" : "") + line;
        }
        continue;
      }
      if (/^\s*```/.test(line)) {
        flushPara();
        list = null;
        var pre = el("pre");
        code = el("code");
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }
      var ul = /^\s*[-*]\s+(.*)$/.exec(line),
        ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        var tag = ul ? "ul" : "ol";
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = el(tag);
          frag.appendChild(list);
        }
        var li = el("li");
        inline(li, (ul || ol)[1]);
        list.appendChild(li);
        continue;
      }
      list = null;
      if (!line.trim()) {
        flushPara();
        continue;
      }
      var h = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (h) {
        flushPara();
        var hp = el("p");
        hp.appendChild(el("strong", null, h[1]));
        frag.appendChild(hp);
        continue;
      }
      para.push(line.trim());
    }
    flushPara();
    return frag;
  }

  // ===== 2. one exchange =====
  // Citations link inside the app (#/playlist/<id>/notes/<videoId>?t=<sec>), which opens the notes and plays
  // the lecture from that second. Anything else is ignored, so a model can never inject a link.
  var CITE_RE = /^#\/playlist\/[a-z0-9-]{1,48}\/notes\/[A-Za-z0-9_-]{11}(?:\?t=\d{1,6})?$/;

  function citationChip(c) {
    var label = [c.title, c.heading, c.startSec != null ? clock(c.startSec) : null].filter(Boolean).join(" · ");
    var href = typeof c.url === "string" && CITE_RE.test(c.url) ? c.url : null;
    var chip = el(href ? "a" : "span", "aia-chip", label || "Lecture");
    if (href) {
      chip.href = href;
      chip.setAttribute("aria-label", "Open " + (label || "lecture") + " in your notes");
    } else chip.title = "This lecture is not in your playlists any more";
    return chip;
  }

  function errorText(r) {
    if (!r) return "Could not reach the server. Check your connection and try again.";
    var j = r.json || {};
    if (r.status === 409) return "Connect your AI key in Settings to ask questions.";
    if (r.status === 429) return "Too many questions right now. Wait a moment and try again.";
    if (r.status === 502) return "The notes service is offline right now. Try again in a little while.";
    if (r.status === 422) return j.error || "That question could not be answered. Try rephrasing it.";
    return j.error || "Something went wrong. Try again.";
  }

  function renderTurn(t, retry) {
    var li = el("li", "aia-turn");
    var q = el("div", "aia-q");
    q.appendChild(el("span", "aia-sr", "You asked: "));
    q.appendChild(el("span", null, t.question));
    if (t.scopeLabel) q.appendChild(el("span", "aia-scope", t.scopeLabel));
    li.appendChild(q);
    var a = el("div", "aia-a");
    if (t.state === "loading") {
      a.classList.add("aia-a--loading");
      a.appendChild(el("span", "aia-dots"));
      a.appendChild(el("span", null, "Searching your notes…"));
    } else if (t.state === "error") {
      a.classList.add("aia-a--error");
      a.appendChild(el("p", null, t.error));
      var again = el("button", "btn btn--ghost btn--sm", "Try again");
      again.type = "button";
      again.addEventListener("click", retry);
      a.appendChild(again);
    } else {
      var res = t.res || {};
      if (res.found === false) {
        a.classList.add("aia-a--notfound");
        a.appendChild(el("p", "aia-nf", "Not found in your notes."));
        if (res.answer) a.appendChild(renderMarkdown(res.answer));
        else a.appendChild(el("p", "aia-muted", "Try other words, or make notes for the lecture that covers it."));
      } else {
        a.appendChild(renderMarkdown(res.answer));
      }
      var cites = Array.isArray(res.citations) ? res.citations : [];
      if (cites.length) {
        var box = el("div", "aia-cites");
        box.appendChild(el("span", "aia-cites__label", "From your notes"));
        cites.forEach(function (c) {
          if (c && typeof c === "object") box.appendChild(citationChip(c));
        });
        a.appendChild(box);
      }
    }
    li.appendChild(a);
    return li;
  }

  // ===== 3. the screen =====
  /**
   * Mounts the assistant into `root`.
   * @param {HTMLElement} root The app's view container.
   * @returns {{destroy: function}} Call on leaving the screen.
   */
  function mount(root) {
    var page = el("section", "aia");
    page.setAttribute("aria-labelledby", "aia-title");
    var head = el("header", "aia__head");
    var h1 = el("h1", "aia__title", "AI assistant");
    h1.id = "aia-title";
    head.appendChild(h1);
    head.appendChild(el("p", "aia__privacy", "Questions are answered from your own notes with your own key."));
    page.appendChild(head);
    if (AQ.aiKeys && AQ.aiKeys.mountKeyHint) AQ.aiKeys.mountKeyHint(page, "assistant");

    var log = el("ol", "aia__log");
    log.setAttribute("aria-live", "polite");
    log.setAttribute("aria-label", "Conversation");
    var empty = el("p", "aia__empty", "Ask anything about the lectures you have notes for.");
    page.appendChild(empty);
    page.appendChild(log);

    var form = el("form", "aia__form");
    form.noValidate = true;
    var row = el("div", "aia__row");
    var scopeLbl = el("label", "aia__scope-lbl", "Search in");
    scopeLbl.htmlFor = "aia-scope";
    var sel = el("select", "aia__select");
    sel.id = "aia-scope";
    sel.appendChild(new Option("All my notes", ""));
    var lists = AQ.store && AQ.store.all ? AQ.store.all() : [];
    lists.forEach(function (p) {
      sel.appendChild(new Option(p.name, p.id));
    });
    sel.value = lists.some(function (p) {
      return p.id === scope;
    })
      ? scope
      : "";
    sel.addEventListener("change", function () {
      scope = sel.value;
    });
    row.appendChild(scopeLbl);
    row.appendChild(sel);
    var clear = el("button", "btn btn--ghost btn--sm aia__clear", "Clear");
    clear.type = "button";
    clear.addEventListener("click", function () {
      conversation = [];
      draw();
      input.focus();
    });
    row.appendChild(clear);
    form.appendChild(row);

    var qLbl = el("label", "aia-sr", "Your question");
    qLbl.htmlFor = "aia-q";
    var input = el("textarea", "aia__input");
    input.id = "aia-q";
    input.rows = 2;
    input.maxLength = MAX_LEN;
    input.placeholder = "Ask about your notes…";
    input.setAttribute("aria-describedby", "aia-count aia-hint");
    var bottom = el("div", "aia__bar");
    var hint = el("span", "aia__hint", "Enter to send, Shift+Enter for a new line");
    hint.id = "aia-hint";
    var count = el("span", "aia__count");
    count.id = "aia-count";
    var send = el("button", "btn btn--white btn--sm aia__send", "Ask");
    send.type = "submit";
    bottom.appendChild(hint);
    bottom.appendChild(count);
    bottom.appendChild(send);
    form.appendChild(qLbl);
    form.appendChild(input);
    form.appendChild(bottom);
    page.appendChild(form);
    root.appendChild(page);

    function updateCount() {
      count.textContent = input.value.length + " / " + MAX_LEN;
      send.disabled = !input.value.trim() || busy();
    }
    function busy() {
      return conversation.some(function (t) {
        return t.state === "loading";
      });
    }

    function draw() {
      log.textContent = "";
      conversation.forEach(function (t) {
        log.appendChild(
          renderTurn(t, function () {
            ask(t);
          })
        );
      });
      empty.hidden = conversation.length > 0;
      clear.disabled = !conversation.length;
      updateCount();
      var last = log.lastElementChild;
      if (last && last.scrollIntoView) last.scrollIntoView({ block: "nearest" });
    }

    function ask(t) {
      t.state = "loading";
      t.error = null;
      draw();
      var body = { question: t.question };
      if (t.playlistId) body.playlistId = t.playlistId;
      AQ.api.request("POST", "/api/v1/ai/ask", body, { timeout: 90000 }).then(
        function (r) {
          if (r.status === 200 && r.json) {
            t.state = "done";
            t.res = r.json;
          } else {
            t.state = "error";
            t.error = errorText(r);
            if (r.status === 409 && AQ.aiKeys && AQ.aiKeys.handleError) {
              AQ.aiKeys.handleError(r.json, function () {
                ask(t);
              });
            }
          }
          if (redraw) redraw();
        },
        function () {
          t.state = "error";
          t.error = errorText(null);
          if (redraw) redraw();
        }
      );
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = input.value.trim().slice(0, MAX_LEN);
      if (!q || busy()) return;
      var opt = sel.options[sel.selectedIndex];
      var t = { question: q, playlistId: sel.value || null, scopeLabel: sel.value ? opt.text : "" };
      conversation.push(t);
      input.value = "";
      ask(t);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });
    input.addEventListener("input", updateCount);

    redraw = draw;
    draw();
    return {
      destroy: function () {
        if (redraw === draw) redraw = null;
      }
    };
  }

  AQ.aiAssistant = { mount: mount, renderMarkdown: renderMarkdown };
})();
