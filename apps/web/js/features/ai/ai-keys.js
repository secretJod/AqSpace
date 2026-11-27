/* =====================================================================================================
   ai-keys.js - the signed-in user's own AI keys (AQ.aiKeys)

   What this file does:
     Knows which AI providers the user has connected (GET /api/v1/ai) and which provider each task uses.
     When notes or Smart arrange need a key the user has not connected, it shows a short prompt that sends
     the user to Settings (#/settings, features/settings/settings-view.js); the action they clicked runs
     once the key is saved there. It also owns the key setup card that the Settings page opens: open the
     provider's key page, follow the numbered steps, paste the key, "Test & save".

   How it fits:
     Loaded by core/boot.js after ui/dialog.js (uses AQ.util, AQ.dialog, AQ.api.request). notes-jobs.js and
     smart-arrange.js call `requireKey(task, onReady)` before starting and `handleError(json, retry)` when
     the server answers 409 {code:"ai_key_required"}. The AI tab calls `mountKeyHint()`. Every caller
     guards with `if (AQ.aiKeys)`, so the app works without this file.

   Security:
     The key only lives in the password input and in the body of one PUT request. It is never written to
     browser storage, never put in a URL, and the input is cleared after saving. The server keeps it
     encrypted, for this account only, and only ever sends back its last 4 characters.

   Start reading at:
     `requireKey()` in section 5, then `openPrompt()` (section 4) and `openCard()` (section 3).
   ===================================================================================================== */

/* AQ.aiKeys
     requireKey(task, onReady, opts?)  task: notes|smart|assistant|doubts. Reads GET /api/v1/ai (cached briefly):
                                       tasks[task].ready -> onReady() now; otherwise a prompt offers "Open Settings"
                                       and onReady() runs once after the key is saved there. opts: { opener }
     handleError(json, retry)          -> true when json.code === "ai_key_required" (same prompt, retry() after save)
     mountKeyHint(container, task)     adds "Connect a key in Settings" to a screen when the task has no key
     takeIntent()                      -> {provider, task, run} the Settings page should open (once), or null
     connect(provider, opts?)          opens the setup card; opts: { opener, task, onSaved }  (Settings page)
     refresh() -> Promise<data|null>   re-reads GET /api/v1/ai;  state() -> the last payload;  subscribe(fn) -> off()
     PROVIDERS, ORDER, TASKS, TASK_ORDER, providerInfo(), failText(), connected(), settled(), invalidate() */
(function () {
  "use strict";
  var AQ = (window.AQ = window.AQ || {});
  var u = AQ.util,
    el = u.el;

  // ===== 1. Providers, tasks, constants =====
  var KEY_RE = /^[A-Za-z0-9_\-.]{20,200}$/;
  var CACHE_MS = 20000;
  var ORDER = ["gemini", "groq", "nvidia", "xai", "huggingface"];
  var PROVIDERS = {
    gemini: {
      label: "Google Gemini",
      short: "Gemini",
      prefix: "AIza",
      keyUrl: "https://aistudio.google.com/app/apikey",
      site: "Google AI Studio",
      steps: [
        "Open Google AI Studio and sign in with your Google account.",
        "Click “Create API key” (accept the terms if asked, and pick or create a project).",
        "Copy the key. It starts with AIza.",
        "Paste it below and press “Test & save”."
      ]
    },
    groq: {
      label: "Groq",
      short: "Groq",
      prefix: "gsk_",
      keyUrl: "https://console.groq.com/keys",
      site: "the Groq console",
      steps: [
        "Open the Groq console and sign in with Google, GitHub or your email.",
        "Click “Create API Key” and name it AQ.",
        "Copy the key. It starts with gsk_ and is shown only once.",
        "Paste it below and press “Test & save”."
      ]
    },
    nvidia: {
      label: "NVIDIA Nemotron",
      short: "NVIDIA",
      prefix: "nvapi-",
      keyUrl: "https://build.nvidia.com/settings/api-keys",
      site: "NVIDIA Build",
      steps: [
        "Open NVIDIA Build and sign in (or create a free NVIDIA account).",
        "Click “Generate API Key”, name it AQ, choose an expiry and confirm.",
        "Copy the key. It starts with nvapi-.",
        "Paste it below and press “Test & save”."
      ]
    },
    xai: {
      label: "xAI Grok",
      short: "Grok",
      prefix: "xai-",
      keyUrl: "https://console.x.ai",
      site: "the xAI console",
      steps: [
        "Open the xAI console and sign in with X, Google or your email.",
        "Go to “API Keys”, click “Create API key” and name it AQ.",
        "Copy the key. It starts with xai-.",
        "Paste it below and press “Test & save”. (New xAI accounts may need credits before calls work.)"
      ]
    },
    huggingface: {
      label: "Hugging Face",
      short: "Hugging Face",
      prefix: "hf_",
      keyUrl: "https://huggingface.co/settings/tokens",
      site: "Hugging Face",
      steps: [
        "Open your Hugging Face access tokens page and sign in.",
        "Click “Create new token”, pick “Fine-grained”, tick “Make calls to Inference Providers” and name it AQ.",
        "Click “Create token” and copy it. It starts with hf_.",
        "Paste it below and press “Test & save”."
      ]
    }
  };
  var TASKS = {
    notes: { label: "Notes", what: "Writing lecture notes", feature: "notes" },
    smart: { label: "Smart arrange", what: "Ordering playlists and finding missing topics", feature: "Smart arrange" },
    assistant: { label: "Assistant", what: "Answering questions about your lectures", feature: "the AI assistant" },
    doubts: { label: "Doubts", what: "Explaining doubts while you watch", feature: "doubt solving" }
  };
  var TASK_ORDER = ["notes", "smart", "assistant", "doubts"];
  var DEFAULT_PROVIDER = { assistant: "groq", doubts: "nvidia" }; // notes / smart defaults come from the server config

  // ===== 2. Server state (GET /api/v1/ai) =====
  var data = null,
    dataAt = 0,
    inflight = null;
  var listeners = [];

  function connected() {
    return !!(AQ.api && AQ.api.available && AQ.api.available() && AQ.api.request);
  }
  function settled() {
    if (!AQ.api || !AQ.api.ready) return Promise.resolve(false);
    return AQ.api.ready().then(
      function (ok) {
        return ok;
      },
      function () {
        return false;
      }
    );
  }
  function emit() {
    listeners.slice().forEach(function (fn) {
      try {
        fn(data);
      } catch {
        /* a bad listener must not stop the others */
      }
    });
  }
  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
  function valid(j) {
    return !!(j && Array.isArray(j.providers) && j.tasks && typeof j.tasks === "object");
  }

  /** Re-reads GET /api/v1/ai. Resolves the payload, or null when it could not be read (no server / old server / error). */
  function refresh() {
    if (!connected()) return Promise.resolve(null);
    if (inflight) return inflight;
    inflight = AQ.api.request("GET", "/api/v1/ai").then(
      function (r) {
        inflight = null;
        if (r.status === 200 && valid(r.json)) {
          data = r.json;
          dataAt = Date.now();
          emit();
          return data;
        }
        var err = new Error("ai " + r.status);
        err.status = r.status;
        err.json = r.json;
        throw err;
      },
      function (e) {
        inflight = null;
        throw e;
      }
    );
    return inflight;
  }
  function load(force) {
    if (!force && data && Date.now() - dataAt < CACHE_MS) return Promise.resolve(data);
    return refresh();
  }
  function invalidate() {
    dataAt = 0;
  }
  function state() {
    return data;
  }
  function providerInfo(id) {
    var p = PROVIDERS[id],
      row = null;
    if (data)
      data.providers.forEach(function (x) {
        if (x && x.id === id) row = x;
      });
    if (!p && !row) return null;
    p = p || {};
    return {
      id: id,
      label: (row && row.label) || p.label || id,
      short: p.short || (row && row.label) || id,
      prefix: (row && row.prefix) || p.prefix || "",
      keyUrl: p.keyUrl || (row && row.keyUrl) || "",
      site: p.site || (row && row.label) || id,
      steps: p.steps || []
    };
  }

  // ===== 3. The setup card (opened from the Settings page) =====
  var card = null; // { provider, task, callbacks: [], cleanup() }

  function toast(msg) {
    var box = document.getElementById("toasts");
    if (!box) return;
    box.textContent = "";
    var t = el("div", "toast");
    t.appendChild(el("span", null, msg));
    box.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 4000);
  }
  function announce(msg) {
    var live = document.getElementById("live");
    if (!live) return;
    live.textContent = "";
    setTimeout(function () {
      live.textContent = msg;
    }, 30);
  }

  /** Message for a failed PUT/POST on /ai/keys. The server's own `error` text is already friendly and key-free. */
  function failText(r) {
    var j = r && r.json,
      s = r ? r.status : 0;
    var msg = j && typeof j.error === "string" ? j.error.slice(0, 240) : "";
    if (s === 429) return msg || "Too many attempts. Wait a minute and try again.";
    if (s === 502 || s === 503)
      return msg || "The notes service is not reachable, so the key could not be tested. Try again in a moment.";
    if (s === 404) return msg || "This server does not support AI keys yet.";
    return msg || "That key did not work. Check that you copied all of it.";
  }

  function openCard(pid, task, cb, opts) {
    opts = opts || {};
    var info = providerInfo(pid);
    if (!info || !AQ.dialog) return false;
    // the card for the same provider is already open: just queue one more action to continue after save
    if (card && card.provider === pid && AQ.dialog.isOpen()) {
      if (typeof cb === "function") card.callbacks.push(cb);
      return true;
    }
    var feature = task && TASKS[task] ? TASKS[task].feature : "";
    var title = feature
      ? "Connect " + info.label + " to use " + feature + " (free)"
      : "Connect " + info.label + " (free)";
    var me = {
      provider: pid,
      task: task || null,
      callbacks: typeof cb === "function" ? [cb] : [],
      onSaved: opts.onSaved,
      cleanup: null
    };
    var d = AQ.dialog.open({
      kind: "Connect AI",
      title: title,
      opener: opts.opener,
      restore: opts.restore,
      onClose: function () {
        if (me.cleanup) me.cleanup();
        if (card === me) card = null;
        if (d && d.element) d.element.classList.remove("aik-dialog"); // the dialog element is shared with every other modal
      }
    });
    card = me;
    d.element.classList.add("aik-dialog");

    var root = el("div", "aik");
    root.appendChild(
      el(
        "p",
        "aik__lead",
        "Your key is tested, then stored encrypted on the AQspace server for your account only. Only its last 4 characters are ever shown again."
      )
    );

    var open = el("a", "btn btn--white aik__open");
    open.href = info.keyUrl;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open " + info.label + " ↗";
    open.setAttribute("aria-label", "Open " + info.label + " key page (new tab)");
    root.appendChild(open);

    var ol = el("ol", "aik__steps");
    info.steps.forEach(function (s) {
      ol.appendChild(el("li", null, s));
    });
    root.appendChild(ol);

    var form = el("form", "aik__form");
    form.setAttribute("novalidate", "");
    form.setAttribute("autocomplete", "off");
    var fid = "aik-key-" + pid;
    var lab = el("label", "aik__label", "Paste your " + info.label + " key");
    lab.htmlFor = fid;
    var wrap = el("div", "aik__inrow");
    var input = el("input", "aik__input");
    input.id = fid;
    input.type = "password";
    input.name = "aq-ai-key";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("data-1p-ignore", "");
    input.setAttribute("data-lpignore", "true");
    input.maxLength = 200;
    if (info.prefix) input.placeholder = info.prefix + "…";
    input.setAttribute("aria-describedby", "aik-status");
    var eye = el("button", "aik__eye", "Show");
    eye.type = "button";
    eye.setAttribute("aria-pressed", "false");
    eye.setAttribute("aria-controls", fid);
    eye.setAttribute("aria-label", "Show key");
    wrap.appendChild(input);
    wrap.appendChild(eye);

    var offer = el("div", "aik__offer");
    offer.hidden = true;
    var offerText = el("span", "aik__offer-text", "");
    var offerBtn = el("button", "btn btn--ghost btn--sm", "Paste detected key?");
    offerBtn.type = "button";
    offer.appendChild(offerText);
    offer.appendChild(offerBtn);

    var row = el("div", "modal__row aik__actions");
    var save = el("button", "btn btn--white", "Test & save");
    save.type = "submit";
    var later = el("button", "btn btn--ghost", "Not now");
    later.type = "button";
    row.appendChild(save);
    row.appendChild(later);

    var status = el("p", "aik__status", "");
    status.id = "aik-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    form.appendChild(lab);
    form.appendChild(wrap);
    form.appendChild(offer);
    form.appendChild(row);
    form.appendChild(status);
    root.appendChild(form);
    d.body.appendChild(root);

    var busy = false,
      detected = "",
      done = false;
    function setStatus(kind, text) {
      status.textContent = text;
      status.setAttribute("data-kind", kind || "");
    }

    eye.addEventListener("click", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      eye.textContent = show ? "Hide" : "Show";
      eye.setAttribute("aria-pressed", show ? "true" : "false");
      eye.setAttribute("aria-label", show ? "Hide key" : "Show key");
      input.focus();
    });
    later.addEventListener("click", function () {
      AQ.dialog.close();
    });
    input.addEventListener("input", function () {
      input.removeAttribute("aria-invalid");
      if (status.getAttribute("data-kind") === "error") setStatus("", "");
    });

    // clipboard detection: when the user comes back from the provider's tab, look for a key on the clipboard
    function looksLikeKey(t) {
      return !!t && KEY_RE.test(t) && (!info.prefix || t.indexOf(info.prefix) === 0);
    }
    function onFocus() {
      if (busy || done || !navigator.clipboard || typeof navigator.clipboard.readText !== "function") return;
      var p;
      try {
        p = navigator.clipboard.readText();
      } catch {
        return;
      }
      if (!p || typeof p.then !== "function") return;
      p.then(
        function (text) {
          text = String(text || "").trim();
          if (card !== me || done || !looksLikeKey(text) || text === input.value.trim()) return;
          detected = text;
          offerText.textContent = "Found a " + info.label + " key on your clipboard (…" + text.slice(-4) + ").";
          offer.hidden = false;
        },
        function () {
          /* no permission / not focused: ignore */
        }
      );
    }
    window.addEventListener("focus", onFocus);
    me.cleanup = function () {
      window.removeEventListener("focus", onFocus);
      detected = "";
      input.value = "";
    };
    offerBtn.addEventListener("click", function () {
      if (!detected) return;
      input.value = detected;
      detected = "";
      offer.hidden = true;
      submit();
    });

    function submit() {
      if (busy) return;
      var key = input.value.trim();
      if (!key) {
        input.setAttribute("aria-invalid", "true");
        setStatus("error", "Paste your key first.");
        input.focus();
        return;
      }
      if (!KEY_RE.test(key)) {
        input.setAttribute("aria-invalid", "true");
        setStatus(
          "error",
          "That does not look like an API key" +
            (info.prefix ? " (" + info.label + " keys start with " + info.prefix + ")" : "") +
            "."
        );
        input.focus();
        return;
      }
      if (!connected()) {
        setStatus("error", "The AQspace server is not reachable, so the key cannot be saved right now.");
        return;
      }
      busy = true;
      offer.hidden = true;
      save.disabled = true;
      save.setAttribute("aria-busy", "true");
      form.setAttribute("aria-busy", "true");
      setStatus(
        "busy",
        info.prefix && key.indexOf(info.prefix) !== 0
          ? "Testing… (this key does not start with " + info.prefix + ")"
          : "Testing…"
      );
      AQ.api.request("PUT", "/api/v1/ai/keys/" + encodeURIComponent(pid), { key: key }, { timeout: 45000 }).then(
        function (r) {
          key = "";
          busy = false;
          save.disabled = false;
          save.removeAttribute("aria-busy");
          form.removeAttribute("aria-busy");
          if (card !== me) return;
          if (r.status === 200 && r.json && r.json.connected) {
            done = true;
            input.value = "";
            input.type = "password";
            setStatus("ok", "✓ Key works");
            toast("✓ " + info.label + " connected");
            announce(info.label + " key works and was saved.");
            invalidate();
            refresh().catch(function () {
              /* the next requireKey reads it again */
            });
            var cbs = me.callbacks;
            me.callbacks = [];
            var onSaved = me.onSaved;
            me.onSaved = null;
            setTimeout(function () {
              if (card === me) AQ.dialog.close();
              if (onSaved) {
                try {
                  onSaved(r.json);
                } catch {
                  /* ignore */
                }
              }
              cbs.forEach(function (fn) {
                try {
                  fn();
                } catch (e) {
                  if (window.console) console.error(e);
                }
              });
            }, 650);
            return;
          }
          input.setAttribute("aria-invalid", "true");
          setStatus("error", failText(r));
          input.focus();
        },
        function () {
          key = "";
          busy = false;
          save.disabled = false;
          save.removeAttribute("aria-busy");
          form.removeAttribute("aria-busy");
          if (card !== me) return;
          setStatus("error", "Could not reach the AQspace server. Check that it is running and try again.");
        }
      );
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      submit();
    });

    // first focus: the "Open <provider>" link (step 1); the input is one Tab away
    open.focus();
    return true;
  }

  // ===== 4. The "connect a key in Settings" prompt =====
  var intent = null; // {provider, task, run}: what the Settings page opens next, and what runs after the save

  /** The Settings page reads (and clears) the provider to open and the action to continue after saving. */
  function takeIntent() {
    var i = intent;
    intent = null;
    return i;
  }

  /** A small dialog: "Connect <provider> to use <feature>" with "Open Settings" / "Not now". */
  function openPrompt(pid, task, run, opts) {
    opts = opts || {};
    var info = providerInfo(pid);
    if (!info || !AQ.dialog) return false;
    var feature = task && TASKS[task] ? TASKS[task].feature : "this feature";
    var d = AQ.dialog.open({
      kind: "AI key needed",
      title: "Connect " + info.label + " to use " + feature,
      opener: opts.opener
    });
    d.body.appendChild(
      el(
        "p",
        "modal__text",
        "Add your own " +
          info.label +
          " key in Settings. It is free, takes about a minute, and is stored encrypted for your account only."
      )
    );
    var row = el("div", "modal__row");
    var go = el("button", "btn btn--white", "Open Settings");
    go.type = "button";
    var later = el("button", "btn btn--ghost", "Not now");
    later.type = "button";
    row.appendChild(go);
    row.appendChild(later);
    d.body.appendChild(row);
    go.addEventListener("click", function () {
      intent = { provider: pid, task: task || null, run: typeof run === "function" ? run : null };
      AQ.dialog.close();
      location.hash = "#/settings";
    });
    later.addEventListener("click", function () {
      AQ.dialog.close();
    });
    go.focus();
    return true;
  }

  /** Adds a short "connect a key in Settings" note to a screen when `task` has no usable key. */
  function mountKeyHint(container, task) {
    var box = el("div", "aik-hint");
    box.hidden = true;
    container.appendChild(box);
    settled().then(function () {
      if (!connected()) return;
      load(false).then(
        function (d) {
          var t = d && d.tasks ? d.tasks[task] : null;
          if (!t || t.ready || !box.isConnected) return;
          var info = providerInfo(t.provider) || { label: t.provider };
          box.appendChild(
            el("p", null, "To use " + TASKS[task].feature + ", connect your own " + info.label + " key.")
          );
          var a = el("a", "btn btn--ghost btn--sm", "Open Settings");
          a.href = "#/settings";
          a.addEventListener("click", function () {
            intent = { provider: t.provider, task: task, run: null };
          });
          box.appendChild(a);
          box.hidden = false;
        },
        function () {
          /* the server decides later */
        }
      );
    });
    return box;
  }

  // ===== 5. Public entry points =====
  function once(fn) {
    var ran = false;
    return function () {
      if (ran) return;
      ran = true;
      if (typeof fn === "function") fn();
    };
  }

  function taskProvider(task) {
    var t = data && data.tasks && data.tasks[task];
    return (t && t.provider) || DEFAULT_PROVIDER[task] || null;
  }

  /** Runs onReady now when the task can run, else sends the user to Settings and runs it once after the key is saved. */
  function requireKey(task, onReady, opts) {
    var go = once(onReady);
    opts = opts || {};
    if (!opts.opener && document.activeElement && document.activeElement !== document.body)
      opts.opener = document.activeElement;
    return settled()
      .then(function () {
        if (!connected()) {
          go();
          return;
        } // no API reachable: the start reports that itself
        return load(false).then(
          function (d) {
            var t = d && d.tasks ? d.tasks[task] : null;
            if (!t || t.ready) {
              go();
              return;
            } // unknown task: let the server decide (it answers 409 if needed)
            var pid = t.provider || taskProvider(task);
            if (!PROVIDERS[pid] || !openPrompt(pid, task, go, opts)) go(); // a provider that takes no user key: the server decides
          },
          function () {
            go();
          }
        ); // GET /ai failed (old server?): the server enforces it anyway
      })
      .catch(function (e) {
        if (window.console) console.error(e);
        go();
      });
  }

  /** A 409 { code: "ai_key_required", provider, task } from a start -> the Settings prompt, retry after save. */
  function handleError(err, retry) {
    var j = (err && (err.code ? err : err.json || err.data || err.body)) || null;
    if (!j || j.code !== "ai_key_required") return false;
    invalidate();
    var pid = j.provider;
    if (!PROVIDERS[pid] && !providerInfo(pid)) return false;
    return openPrompt(pid, j.task || null, typeof retry === "function" ? once(retry) : null, {});
  }

  function connect(pid, opts) {
    opts = opts || {};
    return openCard(pid, opts.task || null, null, opts);
  }

  AQ.aiKeys = {
    requireKey: requireKey,
    handleError: handleError,
    mountKeyHint: mountKeyHint,
    takeIntent: takeIntent,
    refresh: refresh,
    state: state,
    connect: connect,
    subscribe: subscribe,
    connected: connected,
    settled: settled,
    invalidate: invalidate,
    PROVIDERS: PROVIDERS,
    ORDER: ORDER,
    TASKS: TASKS,
    TASK_ORDER: TASK_ORDER,
    providerInfo: providerInfo,
    failText: failText
  };
})();
