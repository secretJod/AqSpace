/* =====================================================================================================
   settings-view.js - the Settings page (#/settings, AQ.settingsView)

   What this file does:
     Draws the account's Settings page. Its "AI keys" section has one row per AI provider with its state
     (connected •••• last4, server key, failing, not connected) and Connect / Replace / Test / Remove, plus
     "Which AI does what": a provider picker per task (notes, Smart arrange, assistant, doubts).
     When notes or Smart arrange sent the user here (ai-keys.js), the setup card for that provider opens
     straight away and the action they clicked continues after the key is saved.

   How it fits:
     app.js calls `AQ.settingsView.mount(view)` for #/settings and `destroy()` when leaving. The page is
     reached from the profile menu (features/profile/profile.js). Data and the setup card come from
     features/ai/ai-keys.js (AQ.aiKeys); requests go through AQ.api.request (/api/v1/ai...). Styles: css/ai.css.

   Security:
     Keys never pass through this page: the setup card sends them straight to the server, which only ever
     returns their last 4 characters. All text is written with textContent, never innerHTML.

   Start reading at:
     `mount()`, then `paint()`.
   ===================================================================================================== */

/* AQ.settingsView.mount(container) -> { destroy() } */
(function () {
  "use strict";
  var AQ = (window.AQ = window.AQ || {});
  var u = AQ.util,
    el = u.el;

  // ===== 1. Small helpers =====
  function btn(label, cls, key) {
    var b = el("button", cls || "btn btn--ghost btn--sm", label);
    b.type = "button";
    if (key) b.setAttribute("data-k", key);
    return b;
  }
  function badgeOf(p) {
    var tail = p.last4 ? " •••• " + p.last4 : "";
    if (p.connected && p.status === "failing") return { cls: "fail", text: "⚠ Failing" + tail };
    if (p.connected) return { cls: "ok", text: "✓ Connected" + tail };
    if (p.serverKey) return { cls: "server", text: "Server key" };
    return { cls: "none", text: "✗ Not connected" };
  }

  // ===== 2. The screen =====
  function mount(container) {
    var K = AQ.aiKeys;
    var root = el("section", "ai-set");
    root.setAttribute("aria-labelledby", "ai-set-title");
    var head = el("header", "ai-set__head");
    head.appendChild(el("p", "eyebrow", "Account"));
    var h1 = el("h1", "ai-set__title", "Settings");
    h1.id = "ai-set-title";
    h1.tabIndex = -1;
    h1.setAttribute("data-focus-fallback", "");
    head.appendChild(h1);
    root.appendChild(head);
    var keys = el("section", "ai-set__section");
    keys.setAttribute("aria-labelledby", "ai-keys-title");
    var kh = el("h2", "ai-set__section-title", "AI keys");
    kh.id = "ai-keys-title";
    keys.appendChild(kh);
    keys.appendChild(
      el(
        "p",
        "ai-set__lead",
        "Connect your own free AI keys. They are used only for your own notes and Smart arrange. Each key is tested, stored encrypted for your account only and never shown again, only its last 4 characters."
      )
    );
    var body = el("div", "ai-set__body");
    keys.appendChild(body);
    root.appendChild(keys);
    container.appendChild(root);

    var destroyed = false,
      off = null;
    var phase = "loading",
      errStatus = 0;
    var rowMsg = {}; // provider -> {kind, text}
    var taskMsg = {}; // task -> {kind, text}
    var busy = {}; // "test:groq" ... -> true

    if (!K) {
      body.appendChild(el("p", "ai-set__note", "The AI settings could not be loaded. Reload the page to try again."));
      return {
        destroy: function () {
          if (root.parentNode) root.parentNode.removeChild(root);
        }
      };
    }

    function focusKey() {
      var a = document.activeElement;
      return a && body.contains(a) ? a.getAttribute("data-k") : null;
    }
    function findKey(k) {
      return k ? body.querySelector('[data-k="' + k + '"]') : null;
    }
    function rowFocus(pid) {
      return function () {
        return findKey("replace:" + pid) || findKey("connect:" + pid) || h1;
      };
    }

    function msgLine(m, cls) {
      var p = el("p", cls, m ? m.text : "");
      p.setAttribute("role", "status");
      if (m && m.kind) p.setAttribute("data-kind", m.kind);
      return p;
    }

    function paintOffline() {
      var box = el("div", "ai-set__card ai-set__empty");
      box.appendChild(el("h2", "ai-set__h2", "The AQspace server is not connected"));
      box.appendChild(
        el("p", null, "Your AI keys are kept on the AQspace server, which this page cannot reach right now.")
      );
      var p = el("p", "muted", "Start it with ");
      p.appendChild(el("code", null, "docker compose up"));
      p.appendChild(document.createTextNode(" and reload this page."));
      box.appendChild(p);
      var again = btn("Check again", "btn btn--ghost btn--sm", "again");
      again.addEventListener("click", load);
      box.appendChild(again);
      body.appendChild(box);
    }
    function paintError() {
      var box = el("div", "ai-set__card ai-set__empty");
      box.setAttribute("role", "alert");
      box.appendChild(el("h2", "ai-set__h2", "Could not load your AI connections"));
      box.appendChild(
        el(
          "p",
          "muted",
          errStatus === 404
            ? "This server does not support AI keys yet."
            : "The AQspace server did not answer as expected" +
                (errStatus ? " (status " + errStatus + ")" : "") +
                ". Try again in a moment."
        )
      );
      var again = btn("Try again", "btn btn--ghost btn--sm", "again");
      again.addEventListener("click", load);
      box.appendChild(again);
      body.appendChild(box);
    }

    function providerRows(d) {
      var sec = el("section", "ai-set__card");
      sec.setAttribute("aria-labelledby", "ai-prov-h");
      var h = el("h2", "ai-set__h2", "Providers");
      h.id = "ai-prov-h";
      sec.appendChild(h);
      var list = el("ul", "ai-list");
      var byId = {};
      d.providers.forEach(function (p) {
        if (p && p.id) byId[p.id] = p;
      });
      var ids = K.ORDER.slice();
      d.providers.forEach(function (p) {
        if (p && p.id && ids.indexOf(p.id) < 0 && K.PROVIDERS[p.id]) ids.push(p.id);
      });
      ids.forEach(function (pid) {
        var info = K.providerInfo(pid);
        var p = byId[pid] || { id: pid, label: info.label, connected: false, status: "missing", serverKey: false };
        var b = badgeOf(p);
        var li = el("li", "ai-row");
        li.setAttribute("data-state", b.cls);
        var main = el("div", "ai-row__main");
        var name = el("h3", "ai-row__name", p.label || info.label);
        main.appendChild(name);
        main.appendChild(el("span", "ai-badge ai-badge--" + b.cls, b.text));
        var uses = K.TASK_ORDER.filter(function (t) {
          return d.tasks[t] && d.tasks[t].provider === pid;
        }).map(function (t) {
          return K.TASKS[t].label;
        });
        var meta = [];
        if (uses.length) meta.push("Used for " + uses.join(", "));
        if (p.connected && p.checkedAt) meta.push("checked " + u.timeAgo(p.checkedAt));
        if (!p.connected && p.serverKey) meta.push("the server's own key is used until you connect yours");
        if (meta.length) main.appendChild(el("p", "ai-row__meta", meta.join(" · ")));
        li.appendChild(main);

        var acts = el("div", "ai-row__actions");
        var label = p.label || info.label;
        if (p.connected) {
          var rep = btn("Replace", "btn btn--ghost btn--sm", "replace:" + pid);
          rep.setAttribute("aria-label", "Replace " + label + " key");
          rep.addEventListener("click", function () {
            connect(pid, rep);
          });
          var test = btn(busy["test:" + pid] ? "Testing…" : "Test", "btn btn--ghost btn--sm", "test:" + pid);
          test.setAttribute("aria-label", "Test " + label + " key");
          test.disabled = !!busy["test:" + pid];
          test.addEventListener("click", function () {
            testKey(pid, label);
          });
          var rm = btn("Remove", "btn btn--danger btn--sm", "remove:" + pid);
          rm.setAttribute("aria-label", "Remove " + label + " key");
          rm.disabled = !!busy["remove:" + pid];
          rm.addEventListener("click", function () {
            removeKey(pid, label, rm);
          });
          acts.appendChild(rep);
          acts.appendChild(test);
          acts.appendChild(rm);
        } else {
          var con = btn("Connect", "btn btn--white btn--sm", "connect:" + pid);
          con.setAttribute("aria-label", "Connect " + label);
          con.addEventListener("click", function () {
            connect(pid, con);
          });
          acts.appendChild(con);
        }
        li.appendChild(acts);
        li.appendChild(msgLine(rowMsg[pid], "ai-row__status"));
        list.appendChild(li);
      });
      sec.appendChild(list);
      return sec;
    }

    function taskRows(d) {
      var sec = el("section", "ai-set__card");
      sec.setAttribute("aria-labelledby", "ai-task-h");
      var h = el("h2", "ai-set__h2", "Which AI does what");
      h.id = "ai-task-h";
      sec.appendChild(h);
      var list = el("ul", "ai-tasks");
      K.TASK_ORDER.forEach(function (task) {
        var t = d.tasks[task] || {};
        var meta = K.TASKS[task];
        var li = el("li", "ai-task");
        var lab = el("label", "ai-task__label");
        lab.htmlFor = "ai-task-" + task;
        lab.appendChild(el("span", "ai-task__name", meta.label));
        lab.appendChild(
          el("span", "ai-task__what", meta.what + (task === "assistant" || task === "doubts" ? " (coming soon)" : ""))
        );
        li.appendChild(lab);

        var ctl = el("div", "ai-task__ctl");
        var sel = el("select", "ai-task__select");
        sel.id = "ai-task-" + task;
        sel.setAttribute("data-k", "task:" + task);
        // "" = no override (the server's default for this task); aq-api cannot tell "chose the default" from "no override"
        var nameOf = function (pid) {
          return (K.providerInfo(pid) || { label: pid }).label;
        };
        if (t["default"]) {
          var od = el("option", null, "Default (" + nameOf(t["default"]) + ")");
          od.value = "";
          sel.appendChild(od);
        }
        var ids = K.ORDER.slice();
        if (t.provider && ids.indexOf(t.provider) < 0 && t.provider !== t["default"]) ids.unshift(t.provider);
        ids.forEach(function (pid) {
          var o = el("option", null, nameOf(pid));
          o.value = pid;
          sel.appendChild(o);
        });
        var current = t["default"] && t.provider === t["default"] ? "" : t.provider || "";
        sel.value = current;
        sel.disabled = !!busy["task:" + task];
        sel.addEventListener("change", function () {
          setTask(task, sel.value, current);
        });
        ctl.appendChild(sel);
        var pill = el("span", "ai-pill ai-pill--" + (t.ready ? "ok" : "warn"), t.ready ? "Ready" : "Needs a key");
        ctl.appendChild(pill);
        if (!t.ready && t.provider && K.PROVIDERS[t.provider]) {
          var c = btn("Connect", "btn btn--ghost btn--sm", "tconnect:" + task);
          c.setAttribute("aria-label", "Connect " + K.providerInfo(t.provider).label + " for " + meta.label);
          c.addEventListener("click", function () {
            connect(t.provider, c, task);
          });
          ctl.appendChild(c);
        }
        li.appendChild(ctl);
        li.appendChild(msgLine(taskMsg[task], "ai-task__status"));
        list.appendChild(li);
      });
      sec.appendChild(list);
      return sec;
    }

    function paint() {
      if (destroyed) return;
      var k = focusKey();
      body.textContent = "";
      body.setAttribute("aria-busy", phase === "loading" ? "true" : "false");
      if (phase === "loading") {
        body.appendChild(el("p", "ai-set__note muted", "Loading your AI keys…"));
        return;
      }
      if (phase === "offline") paintOffline();
      else if (phase === "error") paintError();
      else {
        var d = K.state();
        body.appendChild(providerRows(d));
        body.appendChild(taskRows(d));
        body.appendChild(
          el(
            "p",
            "ai-set__foot muted",
            "Free keys have usage limits. If a key stops working it is marked “Failing”; replace it or test it again later."
          )
        );
      }
      var f = findKey(k);
      if (f && f.focus) f.focus();
    }

    // ===== 3. Actions =====
    function connect(pid, opener, task, after) {
      K.connect(pid, {
        opener: opener,
        task: task,
        restore: rowFocus(pid),
        onSaved: function () {
          rowMsg[pid] = { kind: "ok", text: "✓ Key works" };
          paint();
          if (typeof after === "function") after(); // e.g. the notes the user asked for before coming here
        }
      });
    }

    function testKey(pid, label) {
      var k = "test:" + pid;
      if (busy[k]) return;
      busy[k] = true;
      rowMsg[pid] = { kind: "busy", text: "Testing…" };
      paint();
      AQ.api.request("POST", "/api/v1/ai/keys/" + encodeURIComponent(pid) + "/test", {}, { timeout: 45000 }).then(
        function (r) {
          busy[k] = false;
          if (r.status === 200 && r.json && r.json.status === "ok") rowMsg[pid] = { kind: "ok", text: "✓ Key works" };
          else if (r.status === 200 && r.json)
            rowMsg[pid] = {
              kind: "error",
              text:
                "⚠ " + (typeof r.json.error === "string" ? r.json.error.slice(0, 240) : label + " rejected the key.")
            };
          else if (r.status === 404) rowMsg[pid] = { kind: "error", text: "No " + label + " key is stored." };
          else rowMsg[pid] = { kind: "error", text: K.failText(r) };
          return K.refresh().catch(function () {
            paint();
          });
        },
        function () {
          busy[k] = false;
          rowMsg[pid] = { kind: "error", text: "Could not reach the AQspace server." };
          paint();
        }
      );
    }

    function removeKey(pid, label, opener) {
      AQ.dialog.confirm(
        {
          title: "Remove your " + label + " key?",
          message:
            "Features that use " +
            label +
            " will ask for a key again (unless the server has its own key). You can connect it again at any time.",
          confirmLabel: "Remove key",
          danger: true,
          opener: opener,
          restore: rowFocus(pid)
        },
        function () {
          var k = "remove:" + pid;
          busy[k] = true;
          rowMsg[pid] = { kind: "busy", text: "Removing…" };
          paint();
          AQ.api.request("DELETE", "/api/v1/ai/keys/" + encodeURIComponent(pid)).then(
            function (r) {
              busy[k] = false;
              if (r.status === 204 || r.status === 200 || r.status === 404)
                rowMsg[pid] = { kind: "ok", text: label + " key removed." };
              else rowMsg[pid] = { kind: "error", text: K.failText(r) };
              return K.refresh().catch(function () {
                paint();
              });
            },
            function () {
              busy[k] = false;
              rowMsg[pid] = { kind: "error", text: "Could not reach the AQspace server." };
              paint();
            }
          );
        }
      );
    }

    function setTask(task, provider, previous) {
      var k = "task:" + task;
      if (busy[k] || provider === previous) return;
      busy[k] = true;
      taskMsg[task] = { kind: "busy", text: "Saving…" };
      AQ.api.request("PUT", "/api/v1/ai/tasks/" + encodeURIComponent(task), { provider: provider || null }).then(
        function (r) {
          busy[k] = false;
          if (r.status === 200 && r.json) {
            var used = r.json.provider || provider,
              info = K.providerInfo(used);
            taskMsg[task] = {
              kind: "ok",
              text:
                K.TASKS[task].label +
                " now uses " +
                (info ? info.label : used) +
                (provider ? "" : " (default)") +
                (r.json.ready === false ? ". Connect a key to use it." : ".")
            };
            return K.refresh().catch(function () {
              paint();
            });
          }
          taskMsg[task] = {
            kind: "error",
            text:
              r.json && typeof r.json.error === "string" ? r.json.error.slice(0, 200) : "Could not change the provider."
          };
          paint(); // repaints the select with the stored (previous) provider
        },
        function () {
          busy[k] = false;
          taskMsg[task] = { kind: "error", text: "Could not reach the AQspace server." };
          paint();
        }
      );
      paint();
    }

    // ===== 4. Loading =====
    function load() {
      if (!K.state()) {
        phase = "loading";
        paint();
      }
      K.settled().then(function () {
        if (destroyed) return;
        if (!K.connected()) {
          phase = "offline";
          paint();
          return;
        }
        return K.refresh().then(
          function () {
            if (destroyed) return;
            phase = "ready";
            paint();
            openIntent();
          },
          function (e) {
            if (destroyed) return;
            if (K.state()) {
              phase = "ready";
              paint();
              return;
            }
            phase = "error";
            errStatus = (e && e.status) || 0;
            paint();
          }
        );
      });
    }

    /* Sent here by a feature that needs a key: open that provider's setup card and continue afterwards. */
    function openIntent() {
      var i = K.takeIntent ? K.takeIntent() : null;
      if (!i || !K.PROVIDERS[i.provider]) return;
      connect(i.provider, findKey("connect:" + i.provider) || findKey("replace:" + i.provider) || h1, i.task, i.run);
    }

    off = K.subscribe(function () {
      if (!destroyed && phase === "ready") paint();
    });
    if (K.state() && K.connected()) {
      phase = "ready";
      paint();
    } // instant repaint from the cache when the page re-renders
    load();

    return {
      destroy: function () {
        destroyed = true;
        if (off) {
          off();
          off = null;
        }
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  AQ.settingsView = { mount: mount };
})();
