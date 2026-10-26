(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var API_URL = String(cfg.API_URL || "").trim();
  var TOKEN = String(cfg.TOKEN || "").trim();
  var MODE = API_URL ? "sheet" : "local";

  // Data sebelum tanggal ini dianggap input manual (sebelum aplikasi dipakai).
  var APP_START = "2026-10-19";

  var LS_DATA = "rdk_records_v1";
  var LS_THEME = "rdk_theme";

  var state = {
    all: [],
    rows: [],
    filters: { from: "", to: "", nama: "", sumber: "all" },
    loading: false,
    error: null,
    loadedAt: null
  };

  var el = {};

  /* ---- util ------------------------------------------------------------ */

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function pad2(n) { return ("0" + n).slice(-2); }

  // "9:19" -> "09:19"
  function padTime(t) {
    var s = String(t == null ? "" : t).trim();
    var m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return s;
    var h = parseInt(m[1], 10);
    if (h > 23) return s;
    return (h < 10 ? "0" : "") + h + ":" + m[2];
  }

  function timeOnly(t) {
    var s = String(t || "");
    if (s.indexOf("T") === -1) return padTime(s);
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function toDateISO(v) {
    var s = String(v || "");
    if (!s) return "";
    if (s.indexOf("T") !== -1) {
      var d = new Date(s);
      if (isNaN(d.getTime())) return s;
      return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    }
    return s.slice(0, 10);
  }

  function toMinutes(t) {
    if (!t) return null;
    var p = String(t).split(":");
    var h = parseInt(p[0], 10);
    var m = parseInt(p[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }

  function durMinutes(a, b) {
    var x = toMinutes(a);
    var y = toMinutes(b);
    if (x === null || y === null) return null;
    var d = y - x;
    if (d < 0) d += 1440;
    return d;
  }

  function normalize(r) {
    r = r || {};
    var d1m = timeOnly(r.d1_mulai);
    var d1s = timeOnly(r.d1_selesai);
    var d2m = timeOnly(r.d2_mulai);
    var d2s = timeOnly(r.d2_selesai);
    var d1 = durMinutes(d1m, d1s);
    var d2 = durMinutes(d2m, d2s);
    if (d1 === null) d1 = Number(r.d1_menit) || 0;
    if (d2 === null) d2 = Number(r.d2_menit) || 0;
    return {
      id: r.id || "",
      tanggal: toDateISO(r.tanggal),
      nama: String(r.nama || "").trim(),
      jumlah_line: Number(r.jumlah_line) || 0,
      d1_mulai: d1m, d1_selesai: d1s, d1_menit: d1 || 0,
      d2_mulai: d2m, d2_selesai: d2s, d2_menit: d2 || 0,
      total_menit: (d1 || 0) + (d2 || 0)
    };
  }

  function fmtDuration(min) {
    if (min === null || min === undefined || isNaN(min)) return "-";
    min = Math.round(min);
    if (min <= 0) return "0m";
    var h = Math.floor(min / 60);
    var m = min % 60;
    if (h && m) return h + "j " + m + "m";
    if (h) return h + "j";
    return m + "m";
  }

  function fmtNumber(n) {
    var v = Number(n);
    if (isNaN(v)) return "0";
    return v.toLocaleString("id-ID");
  }

  function fmtDecimal(n) {
    var v = Number(n);
    if (!isFinite(v)) return "0";
    return v.toLocaleString("id-ID", { maximumFractionDigits: 1 });
  }

  function fmtDate(iso) {
    var p = String(iso || "").split("-");
    if (p.length !== 3) return String(iso || "-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }

  function shortDate(iso) {
    var p = String(iso || "").split("-");
    if (p.length !== 3) return String(iso || "-");
    return p[2] + "/" + p[1];
  }

  var HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

  function weekday(iso) {
    var p = String(iso || "").split("-");
    if (p.length !== 3) return "-";
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (isNaN(d.getTime())) return "-";
    return HARI[d.getDay()];
  }

  function fmtAxis(v) {
    if (v >= 60) return fmtDecimal(v / 60) + "j";
    return Math.round(v) + "m";
  }

  function niceMax(v) {
    if (v <= 10) return Math.max(1, Math.ceil(v));
    var exp = Math.pow(10, Math.floor(Math.log10(v)));
    var f = v / exp;
    var nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * exp;
  }

  function sum(rows, key) {
    return rows.reduce(function (s, r) { return s + (Number(r[key]) || 0); }, 0);
  }

  function groupBy(rows, fn) {
    var m = new Map();
    rows.forEach(function (r) {
      var k = fn(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return m;
  }

  function palette() {
    var cs = getComputedStyle(document.documentElement);
    function v(name) { return cs.getPropertyValue(name).trim(); }
    return {
      p1: v("--p1") || "#c2410c",
      p2: v("--p2") || "#0f766e",
      muted: v("--muted-bar") || "#a49b8b",
      grid: v("--grid-line") || "rgba(90,82,70,.16)"
    };
  }

  /* ---- penyimpanan ----------------------------------------------------- */

  function localRead() {
    try { return JSON.parse(localStorage.getItem(LS_DATA)) || []; }
    catch (e) { return []; }
  }

  async function apiList() {
    var url = API_URL + "?action=list";
    if (TOKEN) url += "&token=" + encodeURIComponent(TOKEN);
    var res = await fetch(url, { method: "GET", redirect: "follow" });
    if (!res.ok) throw new Error("Server merespons HTTP " + res.status);
    var data;
    try { data = await res.json(); }
    catch (e) { throw new Error("Respons server bukan JSON (kuota Apps Script mungkin habis)"); }
    if (!data || !data.ok) throw new Error((data && data.error) || "Respons server tidak valid");
    return data.data || [];
  }

  /* ---- filter ---------------------------------------------------------- */

  function applyFilters() {
    var f = state.filters;
    return state.all.filter(function (r) {
      if (f.from && r.tanggal < f.from) return false;
      if (f.to && r.tanggal > f.to) return false;
      if (f.nama && r.nama !== f.nama) return false;
      if (f.sumber === "app" && r.tanggal < APP_START) return false;
      if (f.sumber === "manual" && r.tanggal >= APP_START) return false;
      return true;
    });
  }

  function applyDateDefaults() {
    if (!state.all.length) return;
    var dates = state.all.map(function (r) { return r.tanggal; }).sort();
    if (!state.filters.from) { state.filters.from = dates[0]; el.fFrom.value = dates[0]; }
    if (!state.filters.to) { state.filters.to = dates[dates.length - 1]; el.fTo.value = dates[dates.length - 1]; }
  }

  function fillNameOptions() {
    var names = [];
    var seen = {};
    state.all.forEach(function (r) {
      var k = r.nama.toLowerCase();
      if (r.nama && !seen[k]) { seen[k] = true; names.push(r.nama); }
    });
    names.sort(function (a, b) { return a.localeCompare(b, "id"); });
    var keep = el.fNama.value;
    el.fNama.innerHTML = '<option value="">Semua orang</option>' + names.map(function (n) {
      return '<option value="' + esc(n) + '">' + esc(n) + "</option>";
    }).join("");
    if (keep && names.indexOf(keep) !== -1) el.fNama.value = keep;
  }

  /* ---- agregasi -------------------------------------------------------- */

  function personStats(rows) {
    var out = [];
    groupBy(rows, function (r) { return r.nama || "(tanpa nama)"; }).forEach(function (g, name) {
      var men = sum(g, "d1_menit") + sum(g, "d2_menit");
      var line = sum(g, "jumlah_line");
      out.push({
        nama: name,
        entri: g.length,
        line: line,
        menit: men,
        avgMenit: g.length ? men / g.length : 0,
        linePerEntri: g.length ? line / g.length : 0,
        linePerJam: men > 0 ? line / (men / 60) : 0
      });
    });
    out.sort(function (a, b) { return b.menit - a.menit || b.line - a.line; });
    return out;
  }

  function dateStats(rows) {
    var out = [];
    groupBy(rows, function (r) { return r.tanggal; }).forEach(function (g, d) {
      var men = sum(g, "d1_menit") + sum(g, "d2_menit");
      var line = sum(g, "jumlah_line");
      var orang = {};
      g.forEach(function (r) { orang[r.nama] = 1; });
      out.push({
        tanggal: d,
        entri: g.length,
        orang: Object.keys(orang).length,
        line: line,
        menit: men,
        linePerJam: men > 0 ? line / (men / 60) : 0,
        sumber: d >= APP_START ? "app" : "manual"
      });
    });
    out.sort(function (a, b) { return a.tanggal.localeCompare(b.tanggal); });
    return out;
  }

  /* ---- chart: batang bertumpuk harian ---------------------------------- */

  function renderDaily() {
    var host = el.chartDaily;
    var rows = state.rows;
    if (!rows.length) return empty(host);

    var byDate = groupBy(rows, function (r) { return r.tanggal; });
    var dates = Array.from(byDate.keys()).sort();
    var pal = palette();

    var legendH = 24;
    var W = host.clientWidth || 760;
    var H = Math.max(180, (host.clientHeight || 300) - legendH);
    var padL = 50, padR = 16, padT = 16, padB = 40;
    var iw = Math.max(120, W - padL - padR);
    var ih = Math.max(70, H - padT - padB);

    var data = dates.map(function (d) {
      var g = byDate.get(d);
      return { d: d, p1: sum(g, "d1_menit"), p2: sum(g, "d2_menit"), n: g.length };
    });

    var maxV = Math.max.apply(null, data.map(function (x) { return x.p1 + x.p2; }).concat([1]));
    var top = niceMax(maxV);
    var y = function (v) { return padT + ih * (1 - v / top); };

    var band = iw / dates.length;
    var barW = Math.max(10, Math.min(46, band * 0.56));
    var parts = [];

    for (var t = 0; t <= 4; t++) {
      var v = top * t / 4;
      var yy = y(v);
      parts.push('<line x1="' + padL + '" x2="' + (padL + iw) + '" y1="' + yy + '" y2="' + yy +
        '" stroke="' + pal.grid + '" stroke-width="1"/>');
      parts.push('<text x="' + (padL - 8) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="10.5" fill="currentColor" opacity=".6">' +
        esc(fmtAxis(v)) + "</text>");
    }

    var labelStep = Math.ceil(dates.length / Math.max(4, Math.floor(iw / 56)));

    data.forEach(function (x, i) {
      var cx = padL + band * (i + 0.5);
      var x0 = cx - barW / 2;
      var total = x.p1 + x.p2;

      if (x.p1 > 0) {
        parts.push('<rect x="' + x0 + '" y="' + y(x.p1) + '" width="' + barW + '" height="' +
          (ih * x.p1 / top) + '" rx="2" fill="' + pal.p1 + '"/>');
      }
      if (x.p2 > 0) {
        parts.push('<rect x="' + x0 + '" y="' + y(x.p1 + x.p2) + '" width="' + barW + '" height="' +
          (ih * x.p2 / top) + '" rx="2" fill="' + pal.p2 + '"/>');
      }
      if (band > 36 && total > 0) {
        parts.push('<text x="' + cx + '" y="' + (y(total) - 6) + '" text-anchor="middle" font-size="10.5" fill="currentColor" opacity=".7">' +
          esc(fmtAxis(total)) + "</text>");
      }
      if (i % labelStep === 0) {
        parts.push('<text x="' + cx + '" y="' + (padT + ih + 18) + '" text-anchor="middle" font-size="10.5" fill="currentColor" opacity=".65">' +
          esc(shortDate(x.d)) + "</text>");
      }
      parts.push('<rect x="' + (padL + band * i) + '" y="' + padT + '" width="' + band + '" height="' + ih +
        '" fill="transparent"><title>' +
        esc(fmtDate(x.d) + " · " + x.n + " entri\nProses 1: " + fmtDuration(x.p1) +
          "\nProses 2: " + fmtDuration(x.p2) + "\nTotal: " + fmtDuration(total)) +
        "</title></rect>");
    });

    host.innerHTML = legendHTML([["Proses 1", pal.p1], ["Proses 2", pal.p2]]) +
      '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H +
      '" role="img" aria-label="Durasi per tanggal">' + parts.join("") + "</svg>";
  }

  /* ---- chart: donat komposisi ------------------------------------------ */

  function renderDonut() {
    var host = el.chartDonut;
    var rows = state.rows;
    if (!rows.length) return empty(host);

    var pal = palette();
    var p1 = sum(rows, "d1_menit");
    var p2 = sum(rows, "d2_menit");
    var total = p1 + p2;
    if (!total) return empty(host, "Durasi masih nol.");

    var legendH = 46;
    var W = host.clientWidth || 320;
    var H = Math.max(150, (host.clientHeight || 300) - legendH);
    var cx = W / 2;
    var cy = H / 2;
    var r = Math.max(34, Math.min(W, H) * 0.31);
    var sw = Math.max(16, r * 0.36);
    var circ = 2 * Math.PI * r;

    var segs = [
      { label: "Proses 1", value: p1, color: pal.p1 },
      { label: "Proses 2", value: p2, color: pal.p2 }
    ].filter(function (s) { return s.value > 0; });

    var off = 0;
    var arcs = segs.map(function (s) {
      var len = circ * (s.value / total);
      var piece = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + s.color +
        '" stroke-width="' + sw + '" stroke-dasharray="' + len + " " + (circ - len) +
        '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 ' + cx + " " + cy + ')">' +
        "<title>" + esc(s.label + ": " + fmtDuration(s.value) + " (" + Math.round(s.value / total * 100) + "%)") + "</title></circle>";
      off += len;
      return piece;
    }).join("");

    var center =
      '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" font-size="19" font-weight="500" fill="currentColor">' +
      esc(fmtDuration(total)) + "</text>" +
      '<text x="' + cx + '" y="' + (cy + 17) + '" text-anchor="middle" font-size="10.5" fill="currentColor" opacity=".6">total durasi</text>';

    host.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H +
      '" role="img" aria-label="Komposisi proses">' + arcs + center + "</svg>" +
      '<div class="legend">' + segs.map(function (s) {
        return "<span><i style=\"background:" + s.color + "\"></i>" + esc(s.label) + " · " +
          esc(fmtDuration(s.value)) + " (" + Math.round(s.value / total * 100) + "%)</span>";
      }).join("") + "</div>";
  }

  /* ---- chart: batang horizontal ---------------------------------------- */

  function renderHBars(host, items, color, unitFmt) {
    if (!items.length) return empty(host);

    var W = host.clientWidth || 420;
    var rowH = 36;
    var padT = 6;
    var padB = 6;
    var H = Math.max(90, items.length * rowH + padT + padB);
    host.style.height = H + "px";

    var labelW = Math.min(104, Math.max(64, W * 0.26));
    var valueW = 76;
    var barMax = Math.max(40, W - labelW - valueW - 10);
    var max = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));

    var parts = [];
    items.forEach(function (it, i) {
      var yTop = padT + i * rowH;
      var cy = yTop + rowH / 2;
      var w = Math.max(2, barMax * (it.value / max));
      var label = it.label.length > 14 ? it.label.slice(0, 13) + "…" : it.label;

      parts.push('<text x="0" y="' + (cy + 4) + '" font-size="12" fill="currentColor">' + esc(label) + "</text>");
      parts.push('<rect x="' + labelW + '" y="' + (cy - 7) + '" width="' + barMax + '" height="14" rx="3" fill="currentColor" opacity=".07"/>');
      parts.push('<rect x="' + labelW + '" y="' + (cy - 7) + '" width="' + w + '" height="14" rx="3" fill="' + color + '">' +
        "<title>" + esc(it.label + ": " + it.tooltip) + "</title></rect>");
      parts.push('<text x="' + (W - 2) + '" y="' + (cy + 4) + '" text-anchor="end" font-size="11.5" fill="currentColor" opacity=".8">' +
        esc(unitFmt(it.value)) + "</text>");
    });

    host.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H +
      '" role="img" aria-label="' + esc(host.getAttribute("aria-label") || "grafik") + '">' + parts.join("") + "</svg>";
  }

  function renderPerson() {
    var pal = palette();
    var items = personStats(state.rows).map(function (p) {
      return { label: p.nama, value: p.menit, tooltip: fmtDuration(p.menit) + " · " + p.entri + " entri" };
    });
    renderHBars(el.chartPerson, items, pal.p1, function (v) { return fmtDuration(v); });
  }

  function renderLine() {
    var pal = palette();
    var items = personStats(state.rows).slice().sort(function (a, b) { return b.line - a.line; }).map(function (p) {
      return { label: p.nama, value: p.line, tooltip: fmtNumber(p.line) + " line · " + p.entri + " entri" };
    });
    renderHBars(el.chartLine, items, pal.p2, function (v) { return fmtNumber(v); });
  }

  /* ---- perbandingan manual vs aplikasi --------------------------------- */

  function renderCompare() {
    var rows = state.rows;
    var app = rows.filter(function (r) { return r.tanggal >= APP_START; });
    var man = rows.filter(function (r) { return r.tanggal < APP_START; });

    function blok(label, g, cls) {
      var n = g.length;
      var men = sum(g, "d1_menit") + sum(g, "d2_menit");
      var line = sum(g, "jumlah_line");
      return {
        label: label, cls: cls, entri: n, menit: men, line: line,
        avgMenit: n ? men / n : 0,
        avgP1: n ? sum(g, "d1_menit") / n : 0,
        avgP2: n ? sum(g, "d2_menit") / n : 0,
        linePerJam: men > 0 ? line / (men / 60) : 0
      };
    }

    var a = blok("Aplikasi, sesudah " + fmtDate(APP_START), app, "app");
    var m = blok("Manual, sebelum " + fmtDate(APP_START), man, "manual");
    var totalMenit = a.menit + m.menit;

    function angka(b) {
      if (!b.entri) return '<span class="compare-v">–</span>';
      var jam = b.avgMenit >= 60;
      return '<span class="compare-v">' + esc(fmtDecimal(jam ? b.avgMenit / 60 : b.avgMenit)) +
        "<small>" + (jam ? "jam" : "menit") + "</small></span>";
    }

    function sisi(b) {
      var pct = totalMenit ? Math.round(b.menit / totalMenit * 100) : 0;
      return '<div class="compare-side">' +
        '<span class="compare-k">' + esc(b.label) + "</span>" +
        angka(b) +
        '<span class="compare-s">rata-rata per entri</span>' +
        '<span class="compare-s">' + fmtNumber(b.entri) + " entri · " + fmtNumber(b.line) +
        " line · " + esc(fmtDuration(b.menit)) + "</span>" +
        '<span class="compare-s">P1 ' + esc(fmtDuration(b.avgP1)) + " · P2 " +
        esc(fmtDuration(b.avgP2)) + " · " + fmtNumber(Math.round(b.linePerJam)) + " line/jam</span>" +
        '<div class="compare-track"><div class="compare-fill" style="width:' + pct +
        "%;background:" + (b.cls === "app" ? "var(--accent)" : "var(--muted-bar)") + '"></div></div>' +
        "</div>";
    }

    var html = sisi(m);

    if (a.entri && m.entri) {
      var diff = a.avgMenit - m.avgMenit;
      var pctDiff = m.avgMenit ? (diff / m.avgMenit) * 100 : 0;
      var turun = diff <= 0;
      html += '<div class="compare-delta ' + (turun ? "down" : "up") + '">' +
        '<span class="delta-big">' + (turun ? "−" : "+") + fmtDecimal(Math.abs(diff)) + " menit</span>" +
        '<span class="delta-sub">' + (pctDiff > 0 ? "+" : "−") +
        fmtDecimal(Math.abs(pctDiff)) + "% " + (turun ? "lebih cepat" : "lebih lama") + "</span></div>";
    } else {
      html += '<div class="compare-delta"><span class="delta-sub">belum ada pembanding</span></div>';
    }

    html += sisi(a);
    html += '<div class="compare-foot">Data sebelum ' + esc(fmtDate(APP_START)) +
      " dianggap input manual. Perbandingan memakai rata-rata per entri, bukan per orang.</div>";

    el.compareBox.innerHTML = html;
  }

  /* ---- KPI ------------------------------------------------------------- */

  function renderKpis() {
    var rows = state.rows;
    var menit = sum(rows, "d1_menit") + sum(rows, "d2_menit");
    var line = sum(rows, "jumlah_line");
    var orang = {};
    rows.forEach(function (r) { if (r.nama) orang[r.nama] = 1; });
    var nOrang = Object.keys(orang).length;
    var tanggal = {};
    rows.forEach(function (r) { tanggal[r.tanggal] = 1; });
    var nHari = Object.keys(tanggal).length;

    el.kEntri.textContent = fmtNumber(rows.length);
    el.kEntriSub.textContent = nHari + " hari kerja";

    el.kLine.textContent = fmtNumber(line);
    el.kLineSub.textContent = rows.length ? fmtNumber(Math.round(line / rows.length)) + " per entri" : "-";

    el.kDur.textContent = fmtDuration(menit);
    el.kDurSub.textContent = rows.length ? fmtDuration(menit / rows.length) + " per entri" : "-";

    el.kOrang.textContent = fmtNumber(nOrang);
    el.kOrangSub.textContent = nOrang === 1 ? "1 orang" : nOrang + " orang";

    el.kAvg.textContent = rows.length ? fmtDuration(menit / rows.length) : "-";
    el.kAvgSub.textContent = rows.length ? fmtNumber(Math.round(line / rows.length)) + " line" : "-";

    el.kRate.textContent = menit > 0 ? fmtNumber(Math.round(line / (menit / 60))) : "-";
    el.kRateSub.textContent = "line per jam";
  }

  /* ---- tabel ----------------------------------------------------------- */

  function renderTables() {
    var people = personStats(state.rows);
    var tMenit = 0, tLine = 0, tEntri = 0;

    el.tblPersonBody.innerHTML = people.map(function (p) {
      tMenit += p.menit; tLine += p.line; tEntri += p.entri;
      return "<tr>" +
        '<td class="name-cell">' + esc(p.nama) + "</td>" +
        '<td class="num">' + fmtNumber(p.entri) + "</td>" +
        '<td class="num">' + fmtNumber(p.line) + "</td>" +
        '<td class="num">' + fmtDuration(p.menit) + "</td>" +
        '<td class="num">' + fmtDuration(p.avgMenit) + "</td>" +
        '<td class="num">' + fmtNumber(Math.round(p.linePerEntri)) + "</td>" +
        '<td class="num">' + fmtNumber(Math.round(p.linePerJam)) + "</td>" +
        "</tr>";
    }).join("") || '<tr><td colspan="7" class="muted">Tidak ada data.</td></tr>';

    el.tblPersonFoot.innerHTML = people.length
      ? "<tr><td>Total</td>" +
        '<td class="num">' + fmtNumber(tEntri) + "</td>" +
        '<td class="num">' + fmtNumber(tLine) + "</td>" +
        '<td class="num">' + fmtDuration(tMenit) + "</td>" +
        '<td class="num">' + fmtDuration(tEntri ? tMenit / tEntri : 0) + "</td>" +
        '<td class="num">' + fmtNumber(tEntri ? Math.round(tLine / tEntri) : 0) + "</td>" +
        '<td class="num">' + fmtNumber(tMenit ? Math.round(tLine / (tMenit / 60)) : 0) + "</td></tr>"
      : "";

    var dates = dateStats(state.rows);
    var dEntri = 0, dLine = 0, dMenit = 0;

    el.tblDateBody.innerHTML = dates.map(function (d) {
      dEntri += d.entri; dLine += d.line; dMenit += d.menit;
      return "<tr>" +
        '<td class="name-cell">' + esc(fmtDate(d.tanggal)) + "</td>" +
        "<td>" + esc(weekday(d.tanggal)) + "</td>" +
        '<td class="num">' + fmtNumber(d.entri) + "</td>" +
        '<td class="num">' + fmtNumber(d.orang) + "</td>" +
        '<td class="num">' + fmtNumber(d.line) + "</td>" +
        '<td class="num">' + fmtDuration(d.menit) + "</td>" +
        '<td class="num">' + fmtNumber(Math.round(d.linePerJam)) + "</td>" +
        '<td><span class="badge badge-' + d.sumber + '">' +
        (d.sumber === "app" ? "Aplikasi" : "Manual") + "</span></td>" +
        "</tr>";
    }).join("") || '<tr><td colspan="8" class="muted">Tidak ada data.</td></tr>';

    el.tblDateFoot.innerHTML = dates.length
      ? "<tr><td>Total</td><td>" + dates.length + " hari</td>" +
        '<td class="num">' + fmtNumber(dEntri) + "</td><td></td>" +
        '<td class="num">' + fmtNumber(dLine) + "</td>" +
        '<td class="num">' + fmtDuration(dMenit) + "</td>" +
        '<td class="num">' + fmtNumber(dMenit ? Math.round(dLine / (dMenit / 60)) : 0) + "</td><td></td></tr>"
      : "";
  }

  /* ---- render ---------------------------------------------------------- */

  function legendHTML(items) {
    return '<div class="legend">' + items.map(function (it) {
      return '<span><i style="background:' + it[1] + '"></i>' + esc(it[0]) + "</span>";
    }).join("") + "</div>";
  }

  function empty(host, msg) {
    host.innerHTML = '<div class="chart-empty">' + esc(msg || "Belum ada data pada filter ini.") + "</div>";
  }

  function showState(msg, isError) {
    el.mainState.className = "state" + (isError ? " state-error" : "");
    el.mainState.hidden = !msg;

    if (!msg) {
      el.mainState.textContent = "";
      return;
    }
    if (isError) {
      el.mainState.innerHTML = "<strong>Data gagal dimuat</strong><br>" + esc(msg) +
        '<div><button class="btn btn-ghost" type="button" data-retry>Muat ulang</button></div>';
    } else {
      el.mainState.textContent = msg;
    }
  }

  function setConn(kind, text) {
    el.connDot.setAttribute("data-state", kind);
    el.connText.textContent = text;
  }

  function render() {
    if (state.error) return;

    var rows = applyFilters();
    state.rows = rows;

    if (!rows.length) {
      el.compareCard.hidden = true;
      el.kpis.hidden = true;
      el.grid.hidden = true;
      showState(state.all.length
        ? "Tidak ada entri yang cocok dengan filter. Ubah rentang tanggal, nama, atau sumber data."
        : "Belum ada data. Isi lewat halaman Input data.");
      el.metaPeriode.textContent = "tidak ada data";
      el.filterNote.textContent = "";
      return;
    }

    el.compareCard.hidden = false;
    el.kpis.hidden = false;
    el.grid.hidden = false;
    showState("");

    var dates = rows.map(function (r) { return r.tanggal; }).sort();
    el.metaPeriode.textContent = fmtDate(dates[0]) + " – " + fmtDate(dates[dates.length - 1]) +
      " · " + fmtNumber(rows.length) + " entri";

    el.filterNote.textContent = "Menampilkan " + fmtNumber(rows.length) + " dari " +
      fmtNumber(state.all.length) + " entri · batas aplikasi " + fmtDate(APP_START);

    renderKpis();
    renderDaily();
    renderDonut();
    renderPerson();
    renderLine();
    renderCompare();
    renderTables();
  }

  function renderCharts() {
    if (state.error || !state.rows.length) return;
    renderDaily();
    renderDonut();
    renderPerson();
    renderLine();
    renderCompare();
  }

  /* ---- tema ------------------------------------------------------------ */

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    el.themeToggle.textContent = theme === "dark" ? "Mode terang" : "Mode gelap";
    el.themeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    try { localStorage.setItem(LS_THEME, theme); } catch (e) { /* opsional */ }
    renderCharts();
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(LS_THEME); } catch (e) { saved = null; }
    if (!saved) {
      saved = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    applyTheme(saved);
  }

  /* ---- init ------------------------------------------------------------ */

  function cache() {
    [
      "connDot", "connText", "themeToggle", "metaPeriode",
      "fFrom", "fTo", "fNama", "fSumber", "btnReset", "btnRefresh", "filterNote",
      "kpis", "kEntri", "kEntriSub", "kLine", "kLineSub", "kDur", "kDurSub",
      "kOrang", "kOrangSub", "kAvg", "kAvgSub", "kRate", "kRateSub",
      "grid", "chartDaily", "chartDonut", "chartPerson", "chartLine",
      "compareCard", "compareBox", "tblPersonBody", "tblPersonFoot", "tblDateBody", "tblDateFoot",
      "mainState", "footStore", "footTime"
    ].forEach(function (id) { el[id] = document.getElementById(id); });
  }

  function timeStamp(d) {
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  async function load() {
    state.loading = true;
    state.error = null;
    setConn("loading", "Memuat data…");
    showState("Memuat data…");
    el.btnRefresh.disabled = true;

    try {
      var raw = MODE === "local" ? localRead() : await apiList();
      state.all = (raw || []).map(normalize).filter(function (r) { return r.tanggal; });
      state.loadedAt = new Date();

      setConn(MODE === "sheet" ? "sheet" : "local",
        MODE === "sheet" ? "Tersambung Google Sheets" : "Mode lokal (browser)");
      el.footStore.textContent = MODE === "sheet" ? "Google Sheets" : "browser ini";
      el.footTime.textContent = "dimuat " + timeStamp(state.loadedAt);

      applyDateDefaults();
      fillNameOptions();
      render();
    } catch (ex) {
      state.error = ex;
      state.all = [];
      state.rows = [];
      setConn("error", "Gagal memuat data");
      el.compareCard.hidden = true;
      el.kpis.hidden = true;
      el.grid.hidden = true;
      el.metaPeriode.textContent = "gagal memuat";
      showState(ex.message, true);
    } finally {
      state.loading = false;
      el.btnRefresh.disabled = false;
    }
  }

  function bind() {
    el.themeToggle.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
    });

    el.fFrom.addEventListener("change", function () {
      state.filters.from = el.fFrom.value;
      render();
    });
    el.fTo.addEventListener("change", function () {
      state.filters.to = el.fTo.value;
      render();
    });
    el.fNama.addEventListener("change", function () {
      state.filters.nama = el.fNama.value;
      render();
    });
    el.fSumber.addEventListener("change", function () {
      state.filters.sumber = el.fSumber.value;
      render();
    });

    el.btnReset.addEventListener("click", function () {
      state.filters = { from: "", to: "", nama: "", sumber: "all" };
      el.fFrom.value = "";
      el.fTo.value = "";
      el.fNama.value = "";
      el.fSumber.value = "all";
      applyDateDefaults();
      render();
    });

    el.btnRefresh.addEventListener("click", function () { load(); });

    // State error menyediakan aksinya sendiri supaya pengguna tidak buntu.
    el.mainState.addEventListener("click", function (e) {
      if (e.target.closest("[data-retry]")) load();
    });

    window.addEventListener("resize", debounce(renderCharts, 160));
  }

  function init() {
    cache();
    initTheme();
    bind();
    load();
  }

  init();
})();
