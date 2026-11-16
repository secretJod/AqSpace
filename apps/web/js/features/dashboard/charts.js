/* =====================================================================================================
   What this file does:
     Small chart helpers for the dashboard (`AQ.charts`). They wrap Chart.js (js/vendor/chart.umd.js)
     with ONE shared dark HUD theme (fonts, grid lines, tooltips, gradient fills, draw-in animation)
     so the dashboard cards never repeat that configuration. The heatmap is drawn with plain DOM.

   How it fits:
     Needs AQ.util.el (util.js) and the vendored Chart.js (js/vendor/chart.umd.js, served from our own
     origin because the CSP only allows same-origin scripts). Loaded before dashboard.js, which calls
     `area()`, `bar()`, `donut()` and `heatmap()`. Every helper returns { update(data), destroy() };
     `update` animates in place (chart.update), it never rebuilds the chart. Without Chart.js the
     helpers return a harmless no-op handle. Under prefers-reduced-motion all chart animation is off.
     A series is `{ label, data: number[], color? }`; colours default to PALETTE in order.

   Start reading at:
     `THEME` (the colours), then `area()` in section 3.
   ===================================================================================================== */
(function () {
  "use strict";
  var el = AQ.util.el;

  // ===== 1. Theme =====
  // Colours were checked with a colour-blindness validator on the #0e0e0e panel background.
  var PALETTE = ["#5fd4ff", "#2f8fb3", "#8aa4b8", "#c7d3dd", "#1f6a87", "#56677a"]; // instrument tints: cyan -> steel (no rainbow)
  var THEME = {
    font: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    display: '"Playfair Display", Georgia, serif',
    mono: '"JetBrains Mono", ui-monospace, Consolas, monospace', // HUD numerals (ticks, tooltips)
    text: "#8b98a8", // axis labels (HUD muted, AA on navy)
    textStrong: "#e6edf5", // tooltip title (--text)
    grid: "rgba(138,155,176,.28)",
    tipBg: "rgba(9,13,18,.96)",
    tipLine: "rgba(95,212,255,.7)",
    duration: 600, // ms for update animations (0 when the user prefers reduced motion)
    drawIn: 900 // ms for the first left-to-right draw of an area chart
  };

  function reducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }
  function hasChartJs() {
    return typeof window.Chart === "function";
  }

  // ===== 1b. HUD plugins: neon glow + crosshair =====
  // Glow: Chart.js draws each line dataset with canvas shadowBlur in the line's own colour, so the
  // stroke looks like a neon tube. Only line charts; bars and donuts stay crisp for readability.
  var glowPlugin = {
    id: "aqGlow",
    beforeDatasetDraw: function (chart, args) {
      if (chart.config.type !== "line") return;
      var ds = chart.data.datasets[args.index],
        ctx = chart.ctx;
      ctx.save();
      ctx.shadowColor = typeof ds.borderColor === "string" ? ds.borderColor : "#3ee6ff";
      ctx.shadowBlur = 3;
    },
    afterDatasetDraw: function (chart) {
      if (chart.config.type === "line") chart.ctx.restore();
    }
  };
  // Crosshair: a thin dashed vertical line through the hovered point (the tooltip is the readout).
  var crosshairPlugin = {
    id: "aqCrosshair",
    afterDraw: function (chart) {
      var tip = chart.tooltip,
        area = chart.chartArea;
      if (
        !tip ||
        !tip.getActiveElements ||
        !tip.getActiveElements().length ||
        chart.config.type === "doughnut" ||
        !area
      )
        return;
      var x = tip.getActiveElements()[0].element.x,
        ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = "rgba(95,212,255,.6)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };

  // Set the Chart.js global defaults once (fonts + colours shared by every chart).
  function applyDefaults() {
    if (!hasChartJs() || applyDefaults.done) return;
    applyDefaults.done = true;
    var C = window.Chart;
    C.defaults.font.family = THEME.mono;
    C.register(glowPlugin, crosshairPlugin); // neon glow on lines + crosshair readout (section 1b)
    C.defaults.font.size = 10;
    C.defaults.color = THEME.text;
    C.defaults.animation.duration = reducedMotion() ? 0 : THEME.duration;
    C.defaults.animation.easing = "easeOutQuart";
    C.defaults.plugins.legend.labels.boxWidth = 8;
    C.defaults.plugins.legend.labels.boxHeight = 8;
    C.defaults.plugins.legend.labels.usePointStyle = true;
    C.defaults.plugins.legend.labels.pointStyle = "rect";
    C.defaults.plugins.legend.labels.padding = 14;
  }

  // The tooltip styling used by every chart (drawn on the canvas by Chart.js, so no inline styles needed).
  function tooltipOptions(extra) {
    var base = {
      backgroundColor: THEME.tipBg,
      titleColor: THEME.textStrong,
      bodyColor: THEME.text,
      borderColor: THEME.tipLine,
      borderWidth: 1,
      cornerRadius: 0,
      padding: 10,
      displayColors: true,
      boxPadding: 4,
      usePointStyle: false,
      caretSize: 0,
      boxWidth: 7,
      boxHeight: 7,
      titleFont: { family: THEME.mono, weight: "600", size: 11 },
      bodyFont: { family: THEME.mono, size: 11 }
    };
    if (extra)
      Object.keys(extra).forEach(function (k) {
        base[k] = extra[k];
      });
    return base;
  }

  /**
   * Formats minutes for tooltips and axis ticks.
   * @param {number} min
   * @returns {string} "45 min", "1 hr 5 min", "2 hr"
   */
  function fmtMinutes(min) {
    min = Math.round(+min || 0);
    if (min < 60) return min + " min";
    var h = Math.floor(min / 60),
      r = min % 60;
    return h + " hr" + (r ? " " + r + " min" : "");
  }

  // Hex colour -> "rgba(r,g,b,a)".
  function rgba(hex, a) {
    var h = String(hex || "#ffffff").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  // A vertical gradient (solid at the top, softer at the baseline) for bars and line fills.
  // Chart.js calls this per data point; the gradient is cached per chart area height.
  function verticalGradient(color, top, bottom) {
    var cache = {};
    return function (ctx) {
      var area = ctx.chart.chartArea;
      if (!area) return color;
      var key = area.top + ":" + area.bottom;
      if (!cache[key]) {
        var g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, rgba(color, top));
        g.addColorStop(1, rgba(color, bottom));
        cache[key] = g;
      }
      return cache[key];
    };
  }

  // Axis options shared by bar and line charts.
  function scales(opts) {
    return {
      x: {
        stacked: !!opts.stacked,
        grid: { display: false, drawBorder: false },
        border: { display: false },
        ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: opts.maxTicks || 10, padding: 6 }
      },
      y: {
        stacked: !!opts.stacked,
        beginAtZero: true,
        grid: { color: THEME.grid, drawBorder: false, drawTicks: false },
        border: { display: false, dash: [1, 3] },
        ticks: {
          maxTicksLimit: 5,
          padding: 8,
          callback: function (v) {
            return opts.minutes ? fmtMinutes(v) : v;
          }
        }
      }
    };
  }

  // The "draw-in" animation: points appear left to right, each a little later than the previous one.
  // (The pattern from the Chart.js "progressive line" sample.) Only the first render uses it;
  // `update()` keeps the normal in-place animation.
  function drawInAnimation(pointCount) {
    if (reducedMotion()) return false;
    var perPoint = THEME.drawIn / Math.max(1, pointCount);
    var previousY = function (ctx) {
      return ctx.index === 0
        ? ctx.chart.scales.y.getPixelForValue(0)
        : ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.index - 1].getProps(["y"], true).y;
    };
    return {
      x: {
        type: "number",
        easing: "linear",
        duration: perPoint,
        from: NaN,
        delay: function (ctx) {
          if (ctx.type !== "data" || ctx.xStarted) return 0;
          ctx.xStarted = true;
          return ctx.index * perPoint;
        }
      },
      y: {
        type: "number",
        easing: "linear",
        duration: perPoint,
        from: previousY,
        delay: function (ctx) {
          if (ctx.type !== "data" || ctx.yStarted) return 0;
          ctx.yStarted = true;
          return ctx.index * perPoint;
        }
      }
    };
  }

  // Wraps a Chart.js instance so callers get the same small object from every helper.
  function handle(chart, applyData) {
    return {
      chart: chart,
      update: function (data) {
        if (!chart) return;
        applyData(chart, data || {});
        chart.options.animation = reducedMotion() ? false : { duration: THEME.duration }; // no draw-in on updates
        chart.update();
      },
      destroy: function () {
        if (chart) {
          try {
            chart.destroy();
          } catch {
            /* already gone */
          }
          chart = null;
        }
      }
    };
  }
  // When Chart.js is missing (file not loaded) we return a harmless no-op handle instead of throwing.
  function noop() {
    return { chart: null, update: function () {}, destroy: function () {} };
  }

  // ===== 2. Bar chart (stacked by kind, rounded tops, click a bar -> onClick(index)) =====
  function barDatasets(series, compact) {
    return (series || []).map(function (s, i) {
      var color = s.color || PALETTE[i % PALETTE.length];
      return {
        label: s.label,
        data: s.data,
        backgroundColor: verticalGradient(color, 0.9, 0.55),
        hoverBackgroundColor: color,
        borderColor: color,
        borderWidth: 0,
        borderRadius: 0,
        borderSkipped: "bottom",
        maxBarThickness: compact ? 10 : 34,
        categoryPercentage: 0.62
      };
    });
  }
  /**
   * A bar chart (stacked by kind when asked, rounded tops).
   * @param {HTMLCanvasElement} canvas
   * @param {{labels?: string[], series?: object[], stacked?: boolean, onClick?: function(number): void, compact?: boolean}} [opts]
   *   onClick receives the index of the clicked bar; compact hides axes and tooltips
   * @returns {{chart: object|null, update: function({labels?: string[], series?: object[]}): void, destroy: function(): void}}
   */
  function bar(canvas, opts) {
    opts = opts || {};
    applyDefaults();
    if (!hasChartJs()) return noop();
    var compact = !!opts.compact;
    var chart = new window.Chart(canvas, {
      type: "bar",
      data: { labels: opts.labels || [], datasets: barDatasets(opts.series, compact) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: compact ? 0 : { top: 8 } },
        interaction: { mode: "index", intersect: false },
        onClick: function (evt) {
          if (typeof opts.onClick !== "function") return;
          var pts = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
          if (pts.length) opts.onClick(pts[0].index, chart.data.labels[pts[0].index]);
        },
        onHover: function (evt, items) {
          // pointer cursor over a bar when the bars are clickable
          if (evt.native && evt.native.target)
            evt.native.target.style.cursor = items.length && opts.onClick ? "pointer" : "default";
        },
        scales: compact
          ? { x: { display: false, stacked: true }, y: { display: false, stacked: true, beginAtZero: true } }
          : scales({ stacked: opts.stacked !== false, minutes: true, maxTicks: opts.maxTicks }),
        plugins: {
          legend: { display: !compact && (opts.series || []).length > 1, position: "top", align: "end" },
          tooltip: tooltipOptions({
            enabled: !compact,
            callbacks: {
              label: function (c) {
                return " " + c.dataset.label + ": " + fmtMinutes(c.parsed.y);
              },
              footer: function (items) {
                var sum = 0;
                items.forEach(function (c) {
                  sum += c.parsed.y || 0;
                });
                return items.length > 1 ? "Total: " + fmtMinutes(sum) : "";
              }
            },
            footerColor: THEME.textStrong,
            footerFont: { family: THEME.font, size: 11 }
          })
        }
      }
    });
    return handle(chart, function (ch, data) {
      if (data.labels) ch.data.labels = data.labels;
      if (data.series) {
        // keep the dataset objects (so Chart.js animates from old to new values) and only swap the numbers
        data.series.forEach(function (s, i) {
          if (ch.data.datasets[i]) {
            ch.data.datasets[i].data = s.data;
            ch.data.datasets[i].label = s.label;
          } else ch.data.datasets.push(barDatasets([s], compact)[0]);
        });
        ch.data.datasets.length = data.series.length;
      }
    });
  }

  // ===== 3. Area chart: a smooth line with a vertical gradient fill, edge to edge =====
  // `compact` hides axes, padding and tooltips (sparkline). Without it the chart has axes + tooltips.
  function areaDatasets(series, compact) {
    return (series || []).map(function (s, i) {
      var color = s.color || PALETTE[i % PALETTE.length];
      return {
        label: s.label,
        data: s.data,
        borderColor: color,
        backgroundColor: verticalGradient(color, compact ? 0.2 : 0.16, 0),
        fill: true,
        tension: 0.32,
        borderWidth: 1.5,
        borderCapStyle: "butt",
        pointRadius: 0,
        pointHitRadius: 12,
        pointHoverRadius: compact ? 0 : 3,
        pointHoverStyle: "rect",
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: "#0a0a0a",
        pointHoverBorderWidth: 1,
        clip: compact ? { left: 0, top: 4, right: 0, bottom: 0 } : 8
      };
    });
  }
  function normaliseSeries(opts) {
    if (opts.series) return opts.series;
    return [{ label: opts.label || "Minutes", data: opts.data || [], color: opts.color }];
  }
  /**
   * A smooth line with a vertical gradient fill. `compact` gives an edge-to-edge sparkline with no
   * axes, padding or tooltip.
   * @param {HTMLCanvasElement} canvas
   * @param {{data?: number[], series?: object[], label?: string, color?: string, compact?: boolean,
   *   labels?: Array, minutes?: boolean, drawIn?: boolean, maxTicks?: number}} [opts] pass `data` for one
   *   series or `series` for several; `minutes: false` shows raw numbers instead of "1 hr 5 min"
   * @returns {{chart: object|null, update: function({data?: number[], series?: object[], labels?: Array}): void, destroy: function(): void}}
   */
  function area(canvas, opts) {
    opts = opts || {};
    applyDefaults();
    if (!hasChartJs()) return noop();
    var compact = !!opts.compact;
    var series = normaliseSeries(opts);
    var labels =
      opts.labels ||
      (series[0].data || []).map(function (_, i) {
        return i;
      });
    var minutes = opts.minutes !== false;
    var chart = new window.Chart(canvas, {
      type: "line",
      data: { labels: labels, datasets: areaDatasets(series, compact) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: compact ? 0 : { top: 8, right: 4 } },
        interaction: { mode: "index", intersect: false },
        events: compact ? [] : undefined,
        animation: opts.drawIn === false ? undefined : drawInAnimation((series[0].data || []).length),
        scales: compact
          ? { x: { display: false }, y: { display: false, beginAtZero: true, grace: "5%" } }
          : scales({ minutes: minutes, maxTicks: opts.maxTicks }),
        plugins: {
          legend: { display: !compact && series.length > 1, position: "top", align: "end" },
          tooltip: tooltipOptions({
            enabled: !compact,
            callbacks: {
              label: function (c) {
                return " " + c.dataset.label + ": " + (minutes ? fmtMinutes(c.parsed.y) : c.parsed.y);
              }
            }
          })
        }
      }
    });
    return handle(chart, function (ch, data) {
      var next = data.series || (data.data ? [{ data: data.data }] : null);
      if (next)
        next.forEach(function (s, i) {
          if (ch.data.datasets[i]) ch.data.datasets[i].data = s.data;
        });
      if (data.labels) ch.data.labels = data.labels;
      else if (next && !opts.labels)
        ch.data.labels = (next[0].data || []).map(function (_, i) {
          return i;
        });
    });
  }

  // ===== 4. Donut (share of time per playlist) with an optional centre label =====
  // The centre text is drawn on the canvas by a tiny plugin (no DOM overlay, no inline styles).
  var centerTextPlugin = {
    id: "aqCenterText",
    afterDraw: function (chart) {
      var c = chart.options.plugins.aqCenterText;
      if (!c || (!c.value && !c.label)) return;
      var meta = chart.getDatasetMeta(0),
        arc = meta && meta.data && meta.data[0];
      if (!arc) return;
      var ctx = chart.ctx,
        x = arc.x,
        y = arc.y,
        r = arc.innerRadius || 40;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = THEME.textStrong;
      ctx.font = "700 " + Math.max(16, Math.round(r * 0.4)) + "px " + THEME.mono;
      ctx.fillText(String(c.value || ""), x, y - (c.label ? r * 0.12 : 0));
      if (c.label) {
        ctx.fillStyle = THEME.text;
        ctx.font = "600 " + Math.max(9, Math.round(r * 0.15)) + "px " + THEME.mono;
        ctx.fillText(String(c.label), x, y + r * 0.3);
      }
      ctx.restore();
    }
  };
  // Dial ticks: a fine scale ring just outside the donut (minor every 3.6deg = 1%, major every 10%)
  // plus a hairline guide inside it, so the ring reads as an instrument bezel.
  var dialTicksPlugin = {
    id: "aqDialTicks",
    afterDraw: function (chart) {
      var meta = chart.getDatasetMeta(0),
        arc = meta && meta.data && meta.data[0];
      if (!arc) return;
      var ctx = chart.ctx,
        x = arc.x,
        y = arc.y,
        R = arc.outerRadius,
        ri = arc.innerRadius;
      ctx.save();
      for (var i = 0; i < 100; i++) {
        var a = (i / 100) * Math.PI * 2 - Math.PI / 2,
          major = i % 10 === 0,
          r0 = R + 3,
          r1 = R + (major ? 10 : 6);
        ctx.strokeStyle = major ? "rgba(199,211,221,.75)" : "rgba(138,155,176,.4)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + r0 * Math.cos(a), y + r0 * Math.sin(a));
        ctx.lineTo(x + r1 * Math.cos(a), y + r1 * Math.sin(a));
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(138,155,176,.25)";
      ctx.beginPath();
      ctx.arc(x, y, ri - 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  };
  /**
   * A donut (share of time per playlist) with an optional centre label.
   * @param {HTMLCanvasElement} canvas
   * @param {{labels?: string[], values?: number[], colors?: string[], legend?: string|false,
   *   center?: {value: string, label: string}}} [opts] legend is a position ("right" by default) or false
   * @returns {{chart: object|null, update: function({labels?: string[], values?: number[], center?: object}): void, destroy: function(): void}}
   */
  function donut(canvas, opts) {
    opts = opts || {};
    applyDefaults();
    if (!hasChartJs()) return noop();
    var colors = opts.colors || PALETTE;
    var chart = new window.Chart(canvas, {
      type: "doughnut",
      plugins: [centerTextPlugin, dialTicksPlugin],
      data: {
        labels: opts.labels || [],
        datasets: [
          {
            data: opts.values || [],
            backgroundColor: colors,
            hoverBackgroundColor: colors,
            borderColor: "rgba(9,13,18,1)", // a hairline dark gap between the slices
            borderWidth: 1.5,
            borderRadius: 0,
            hoverOffset: 3,
            spacing: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "82%",
        layout: { padding: 14 },
        animation: reducedMotion() ? false : { animateRotate: true, animateScale: true, duration: 900 },
        plugins: {
          aqCenterText: opts.center || null,
          legend: { display: opts.legend !== false && opts.legend !== "none", position: opts.legend || "right" },
          tooltip: tooltipOptions({
            callbacks: {
              label: function (c) {
                var total = 0;
                c.dataset.data.forEach(function (v) {
                  total += v || 0;
                });
                var pct = total ? Math.round((100 * c.parsed) / total) : 0;
                return " " + fmtMinutes(c.parsed) + " · " + pct + "%";
              }
            }
          })
        }
      }
    });
    return handle(chart, function (ch, data) {
      if (data.labels) ch.data.labels = data.labels;
      if (data.values) ch.data.datasets[0].data = data.values;
      if (data.center) ch.options.plugins.aqCenterText = data.center;
    });
  }

  // ===== 5. Heatmap (7 weekdays x 24 hours, plain DOM so hover/tooltip/focus are normal elements) =====
  var DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  /**
   * @param {number} h hour 0..23
   * @returns {string} "12 am", "3 pm", ...
   */
  function hourLabel(h) {
    if (h === 0) return "12 am";
    if (h === 12) return "12 pm";
    return h < 12 ? h + " am" : h - 12 + " pm";
  }
  // Five brightness levels of one hue (a sequential scale: dark -> bright means little -> a lot).
  function heatLevel(value, max) {
    if (!value || !max) return 0;
    var r = value / max;
    return r < 0.2 ? 1 : r < 0.45 ? 2 : r < 0.75 ? 3 : 4;
  }
  /**
   * A 7 x 24 heatmap of plain DOM cells. Plain elements (not a canvas) so hover, tooltip and focus work
   * like any other element; the whole grid also has one role="img" label for screen readers.
   * @param {HTMLElement} container
   * @param {number[][]} matrix 7 rows (Mon..Sun) of 24 minute values
   * @param {object} [opts] unused, accepted for symmetry with the other helpers
   * @returns {{update: function(number[][]): void, destroy: function(): void}}
   */
  function heatmap(container, matrix, opts) {
    var root = el("div", "hm");
    root.setAttribute("role", "img");
    root.setAttribute("aria-label", "Minutes studied per weekday and hour");
    var tip = el("div", "hm__tip");
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;

    // top row: hour labels every 3 hours
    var head = el("div", "hm__hours");
    head.appendChild(el("span", "hm__corner"));
    for (var h = 0; h < 24; h++)
      head.appendChild(el("span", "hm__hour", h % 3 === 0 ? hourLabel(h).replace(" ", "") : ""));
    root.appendChild(head);

    var cells = []; // [row][col] -> cell element
    DAYS.forEach(function (name, r) {
      var row = el("div", "hm__row");
      row.appendChild(el("span", "hm__day", name));
      cells[r] = [];
      for (var c = 0; c < 24; c++) {
        var cell = el("span", "hm__cell hm__l0");
        cell.setAttribute("data-r", String(r));
        cell.setAttribute("data-c", String(c));
        row.appendChild(cell);
        cells[r][c] = cell;
      }
      root.appendChild(row);
    });
    root.appendChild(tip);
    container.appendChild(root);

    var current = matrix;
    function paint(m) {
      current = m;
      var max = 0;
      for (var r = 0; r < 7; r++) for (var c = 0; c < 24; c++) max = Math.max(max, (m[r] && m[r][c]) || 0);
      for (r = 0; r < 7; r++)
        for (c = 0; c < 24; c++) {
          var v = (m[r] && m[r][c]) || 0;
          cells[r][c].className = "hm__cell hm__l" + heatLevel(v, max);
        }
    }
    paint(matrix || []);

    // one listener on the grid (not 168) shows the tooltip for the hovered cell
    function showTip(cell) {
      var r = +cell.getAttribute("data-r"),
        c = +cell.getAttribute("data-c");
      var v = (current[r] && current[r][c]) || 0;
      tip.textContent = DAYS[r] + " " + hourLabel(c) + " · " + (v ? fmtMinutes(v) : "nothing yet");
      tip.hidden = false;
      // place the tip above the cell, kept inside the grid
      var cr = cell.getBoundingClientRect(),
        rr = root.getBoundingClientRect();
      var left = cr.left - rr.left + cr.width / 2;
      left = Math.max(60, Math.min(rr.width - 60, left));
      tip.style.left = left + "px";
      tip.style.top = cr.top - rr.top - 8 + "px";
    }
    function onOver(e) {
      var t = e.target;
      if (t.classList && t.classList.contains("hm__cell")) showTip(t);
    }
    function onOut(e) {
      if (!root.contains(e.relatedTarget) || (e.relatedTarget && !e.relatedTarget.classList.contains("hm__cell")))
        tip.hidden = true;
    }
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);

    return {
      update: function (m) {
        paint(m || []);
      },
      destroy: function () {
        root.removeEventListener("mouseover", onOver);
        root.removeEventListener("mouseout", onOut);
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  // ===== 6. Public API =====
  AQ.charts = {
    /** Fixed colour order for categories, checked for colour blindness on the dark panel. */
    PALETTE: PALETTE,
    fmtMinutes: fmtMinutes,
    hourLabel: hourLabel,
    area: area,
    bar: bar,
    donut: donut,
    heatmap: heatmap
  };
})();
