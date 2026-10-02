(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var API_URL = String(cfg.API_URL || "").trim();
  var TOKEN = String(cfg.TOKEN || "").trim();
  var MODE = API_URL ? "sheet" : "local";
  var LS_DATA = "rdk_records_v1";
  var LS_THEME = "rdk_theme";

  var state = {
    records: [],
    loading: false,
    error: null,
    filters: { from: "", to: "", q: "" }
  };

  // Nomor urut load: hasil request lama yang baru sampai dibuang supaya
  // tidak menimpa data yang lebih baru.
  var loadSeq = 0;

  var el = {};

  /* ---- util ------------------------------------------------------------ */

  function uid() {
    return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function numOrNull(value) {
    if (value === undefined || value === null || value === "") return null;
    var n = Number(value);
    return isNaN(n) ? null : n;
  }

  function todayISO() {
    var d = new Date();
    var local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function toMinutes(t) {
    if (!t) return null;
    var parts = String(t).split(":");
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }

  // Shift yang melewati tengah malam dihitung sebagai hari berikutnya.
  function durMinutes(start, end) {
    var a = toMinutes(start);
    var b = toMinutes(end);
    if (a === null || b === null) return null;
    var d = b - a;
    if (d < 0) d += 1440;
    return d;
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

  function pad2(n) {
    return ("0" + n).slice(-2);
  }

  // Samakan semua nilai tanggal ke yyyy-MM-dd lokal, termasuk data lama berupa ISO UTC.
  function toDateISO(value) {
    var s = String(value || "");
    if (!s) return "";
    if (s.indexOf("T") !== -1) {
      var d = new Date(s);
      if (isNaN(d.getTime())) return s;
      return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    }
    return s.slice(0, 10);
  }

  function fmtDate(value) {
    var p = String(value || "").split("-");
    if (p.length !== 3) return String(value || "-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }

  // Jam yang terlanjur tersimpan sebagai objek tanggal (data lama) dikembalikan ke HH:mm.
  function timeOnly(t) {
    var s = String(t || "");
    if (s.indexOf("T") === -1) return s;
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  function normalize(r) {
    r = r || {};
    var d1_mulai = timeOnly(r.d1_mulai);
    var d1_selesai = timeOnly(r.d1_selesai);
    var d2_mulai = timeOnly(r.d2_mulai);
    var d2_selesai = timeOnly(r.d2_selesai);
    var d1 = durMinutes(d1_mulai, d1_selesai);
    var d2 = durMinutes(d2_mulai, d2_selesai);
    if (d1 === null) d1 = numOrNull(r.d1_menit);
    if (d2 === null) d2 = numOrNull(r.d2_menit);
    return {
      id: r.id || uid(),
      timestamp: r.timestamp || "",
      tanggal: toDateISO(r.tanggal),
      nama: String(r.nama || "").trim(),
      jumlah_line: numOrNull(r.jumlah_line) || 0,
      d1_mulai: d1_mulai,
      d1_selesai: d1_selesai,
      d1_menit: d1 || 0,
      d2_mulai: d2_mulai,
      d2_selesai: d2_selesai,
      d2_menit: d2 || 0,
      total_menit: (d1 || 0) + (d2 || 0)
    };
  }

  /* ---- penyimpanan ----------------------------------------------------- */

  function localRead() {
    try {
      return JSON.parse(localStorage.getItem(LS_DATA)) || [];
    } catch (e) {
      return [];
    }
  }

  function localWrite(rows) {
    localStorage.setItem(LS_DATA, JSON.stringify(rows));
  }

  // Satu pintu baca respons: cek status HTTP, cek JSON, cek flag ok.
  async function parseResponse(res) {
    if (!res.ok) throw new Error("Server merespons HTTP " + res.status);
    var data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error("Respons server bukan JSON (kuota Apps Script mungkin sudah habis)");
    }
    if (!data || !data.ok) throw new Error((data && data.error) || "Respons server tidak valid");
    return data;
  }

  function listURL() {
    var url = API_URL + "?action=list";
    if (TOKEN) url += "&token=" + encodeURIComponent(TOKEN);
    return url;
  }

  function postBody(obj) {
    obj.token = TOKEN;
    return JSON.stringify(obj);
  }

  async function apiList() {
    if (MODE === "local") return localRead();
    var res = await fetch(listURL(), { method: "GET", redirect: "follow" });
    var data = await parseResponse(res);
    return data.data || [];
  }

  async function apiAdd(rec) {
    if (MODE === "local") {
      var rows = localRead();
      rows.push(rec);
      localWrite(rows);
      return rec;
    }
    var res = await fetch(API_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: postBody({ action: "add", payload: rec })
    });
    var data = await parseResponse(res);
    return data.data || rec;
  }

  async function apiDelete(id) {
    if (MODE === "local") {
      localWrite(localRead().filter(function (r) { return r.id !== id; }));
      return true;
    }
    var res = await fetch(API_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: postBody({ action: "delete", id: id })
    });
    await parseResponse(res);
    return true;
  }

  /* ---- turunan data ---------------------------------------------------- */

  function getFiltered() {
    var f = state.filters;
    var q = f.q.trim().toLowerCase();
    return state.records.filter(function (r) {
      if (f.from && (!r.tanggal || r.tanggal < f.from)) return false;
      if (f.to && (!r.tanggal || r.tanggal > f.to)) return false;
      if (q && r.nama.toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(function (a, b) {
      if (a.tanggal !== b.tanggal) return String(b.tanggal || "").localeCompare(String(a.tanggal || ""));
      return a.nama.localeCompare(b.nama, "id");
    });
  }

  function sumOf(rows, key) {
    return rows.reduce(function (s, r) { return s + (Number(r[key]) || 0); }, 0);
  }

  /* ---- render ---------------------------------------------------------- */

  function setConn(stateName, text) {
    el.connDot.setAttribute("data-state", stateName);
    el.connText.textContent = text;
  }

  function cellProses(mulai, selesai, menit) {
    if (!mulai || !selesai) return '<span class="muted">Belum diisi</span>';
    return '<span class="cell-time"><span class="range">' + esc(mulai) + " - " + esc(selesai) +
      '</span><span class="span">' + fmtDuration(menit) + "</span></span>";
  }

  function renderStates(rows, allCount) {
    var host = el.tableStates;
    if (state.loading) {
      host.innerHTML = '<div class="state"><span class="spinner" aria-hidden="true"></span>Memuat data...</div>';
      el.tableWrap.hidden = true;
      return;
    }
    if (state.error) {
      host.innerHTML = '<div class="state state-error"><strong>Data gagal dimuat</strong>' +
        esc(state.error.message) +
        '<div style="margin-top:12px"><button class="btn btn-ghost" data-action="retry" type="button">Coba lagi</button></div></div>';
      el.tableWrap.hidden = true;
      return;
    }
    if (allCount === 0) {
      host.innerHTML = '<div class="state"><strong>Belum ada entri</strong>' +
        "Isi form di atas untuk menambah data pertama.</div>";
      el.tableWrap.hidden = true;
      return;
    }
    if (rows.length === 0) {
      host.innerHTML = '<div class="state"><strong>Tidak ada entri yang cocok</strong>' +
        "Ubah rentang tanggal atau kata kunci, lalu coba lagi.</div>";
      el.tableWrap.hidden = true;
      return;
    }
    host.innerHTML = "";
    el.tableWrap.hidden = false;
  }

  function renderTable(rows) {
    var body = el.dataBody;
    var html = "";
    rows.forEach(function (r) {
      html += "<tr>" +
        '<td data-label="Tanggal">' + (r.tanggal ? esc(fmtDate(r.tanggal)) : '<span class="muted">-</span>') + "</td>" +
        '<td data-label="Nama" class="name-cell">' + esc(r.nama) + "</td>" +
        '<td data-label="Line" class="num">' + fmtNumber(r.jumlah_line) + "</td>" +
        '<td data-label="Proses 1">' + cellProses(r.d1_mulai, r.d1_selesai, r.d1_menit) + "</td>" +
        '<td data-label="Proses 2">' + cellProses(r.d2_mulai, r.d2_selesai, r.d2_menit) + "</td>" +
        '<td data-label="Total" class="num">' + fmtDuration(r.total_menit) + "</td>" +
        '<td class="cell-aksi"><button class="btn btn-ghost btn-del" type="button" data-del="' + esc(r.id) +
        '" aria-label="Hapus entri ' + esc(r.nama) + '">Hapus</button></td>' +
        "</tr>";
    });
    body.innerHTML = html;

    el.dataFoot.innerHTML = "<tr>" +
      "<td></td>" +
      "<td>Total " + fmtNumber(rows.length) + " entri</td>" +
      '<td class="num">' + fmtNumber(sumOf(rows, "jumlah_line")) + "</td>" +
      '<td class="muted">' + fmtDuration(sumOf(rows, "d1_menit")) + "</td>" +
      '<td class="muted">' + fmtDuration(sumOf(rows, "d2_menit")) + "</td>" +
      '<td class="num">' + fmtDuration(sumOf(rows, "total_menit")) + "</td>" +
      "<td></td>" +
      "</tr>";
  }

  function renderNameList() {
    var seen = {};
    var names = [];
    state.records.forEach(function (r) {
      var key = r.nama.toLowerCase();
      if (r.nama && !seen[key]) {
        seen[key] = true;
        names.push(r.nama);
      }
    });
    names.sort(function (a, b) { return a.localeCompare(b, "id"); });
    el.namaList.innerHTML = names.map(function (n) {
      return '<option value="' + esc(n) + '"></option>';
    }).join("");
  }

  function render() {
    var all = state.records;
    var rows = getFiltered();

    el.footStore.textContent = MODE === "sheet" ? "Google Sheets" : "browser ini (mode lokal)";

    el.stats.hidden = all.length === 0 || !!state.error;
    el.statCount.textContent = fmtNumber(rows.length);
    el.statLine.textContent = fmtNumber(sumOf(rows, "jumlah_line"));
    el.statDur.textContent = fmtDuration(sumOf(rows, "total_menit"));

    if (state.loading) {
      el.rekapMeta.textContent = "Memuat data...";
    } else if (state.error) {
      el.rekapMeta.textContent = "Gagal memuat data.";
    } else if (all.length === 0) {
      el.rekapMeta.textContent = "Belum ada data tercatat.";
    } else {
      el.rekapMeta.textContent = "Menampilkan " + fmtNumber(rows.length) +
        " dari " + fmtNumber(all.length) + " entri.";
    }

    renderStates(rows, all.length);
    if (!state.loading && !state.error && all.length > 0 && rows.length > 0) {
      renderTable(rows);
    } else {
      el.dataBody.innerHTML = "";
      el.dataFoot.innerHTML = "";
    }
    renderNameList();
  }

  /* ---- form ------------------------------------------------------------ */

  function showFormError(msg) {
    el.formError.textContent = msg;
    el.formError.hidden = false;
  }

  function clearFormError() {
    el.formError.textContent = "";
    el.formError.hidden = true;
    [el.nama, el.tanggal, el.jumlah_line, el.d1_mulai, el.d1_selesai, el.d2_mulai, el.d2_selesai]
      .forEach(function (i) { i.removeAttribute("aria-invalid"); });
  }

  function readForm() {
    return {
      nama: el.nama.value.trim(),
      tanggal: el.tanggal.value,
      jumlah_line: el.jumlah_line.value,
      d1_mulai: el.d1_mulai.value,
      d1_selesai: el.d1_selesai.value,
      d2_mulai: el.d2_mulai.value,
      d2_selesai: el.d2_selesai.value
    };
  }

  function validate(v) {
    if (!v.nama) { el.nama.setAttribute("aria-invalid", "true"); return "Nama wajib diisi."; }
    if (!v.tanggal) { el.tanggal.setAttribute("aria-invalid", "true"); return "Tanggal wajib diisi."; }
    if (v.jumlah_line === "" || isNaN(Number(v.jumlah_line))) {
      el.jumlah_line.setAttribute("aria-invalid", "true");
      return "Jumlah line wajib diisi dengan angka.";
    }
    if (Number(v.jumlah_line) < 0) {
      el.jumlah_line.setAttribute("aria-invalid", "true");
      return "Jumlah line tidak boleh negatif.";
    }
    var pairs = [["Proses 1", v.d1_mulai, v.d1_selesai], ["Proses 2", v.d2_mulai, v.d2_selesai]];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if ((p[1] && !p[2]) || (!p[1] && p[2])) {
        return p[0] + ": jam mulai dan jam selesai harus diisi keduanya.";
      }
      if (p[1] && p[2] && durMinutes(p[1], p[2]) === 0) {
        return p[0] + ": durasi 0 menit, jam mulai dan jam selesai sama.";
      }
    }
    if (!v.d1_mulai && !v.d2_mulai) return "Isi minimal satu proses dengan jam mulai dan jam selesai.";
    return null;
  }

  // Durasi yang tidak wajar dikonfirmasi dulu sebelum disimpan.
  function confirmOddDuration(v) {
    var checks = [["Proses 1", v.d1_mulai, v.d1_selesai], ["Proses 2", v.d2_mulai, v.d2_selesai]];
    var odd = [];
    checks.forEach(function (c) {
      var d = durMinutes(c[1], c[2]);
      if (d !== null && d > 720) odd.push(c[0] + " " + fmtDuration(d));
    });
    if (!odd.length) return true;
    return window.confirm("Durasi tidak wajar: " + odd.join(", ") + ".\nLanjutkan simpan?");
  }

  function updatePreviews() {
    var d1 = durMinutes(el.d1_mulai.value, el.d1_selesai.value);
    var d2 = durMinutes(el.d2_mulai.value, el.d2_selesai.value);
    el.d1_dur.textContent = d1 === null ? "-" : fmtDuration(d1);
    el.d2_dur.textContent = d2 === null ? "-" : fmtDuration(d2);
    el.totalPreview.textContent = (d1 === null && d2 === null) ? "-" : fmtDuration((d1 || 0) + (d2 || 0));
  }

  async function onSubmit(e) {
    e.preventDefault();
    clearFormError();
    var v = readForm();
    var err = validate(v);
    if (err) { showFormError(err); return; }
    if (!confirmOddDuration(v)) return;

    var rec = normalize({
      id: uid(),
      timestamp: new Date().toISOString(),
      tanggal: v.tanggal,
      nama: v.nama,
      jumlah_line: Number(v.jumlah_line) || 0,
      d1_mulai: v.d1_mulai,
      d1_selesai: v.d1_selesai,
      d2_mulai: v.d2_mulai,
      d2_selesai: v.d2_selesai
    });

    el.submitBtn.disabled = true;
    el.submitBtn.textContent = "Menyimpan...";
    try {
      await apiAdd(rec);
      el.entryForm.reset();
      el.tanggal.value = todayISO();
      updatePreviews();
      await load();
    } catch (ex) {
      showFormError("Gagal menyimpan: " + ex.message);
    } finally {
      el.submitBtn.disabled = false;
      el.submitBtn.textContent = "Simpan data";
    }
  }

  /* ---- muat & aksi ----------------------------------------------------- */

  async function load() {
    var seq = ++loadSeq;
    state.loading = true;
    state.error = null;
    setConn("loading", "Memuat data...");
    render();
    try {
      var data = await apiList();
      if (seq !== loadSeq) return; // hasil lama, buang
      state.records = (data || []).map(normalize);
      setConn(MODE === "sheet" ? "sheet" : "local",
        MODE === "sheet" ? "Tersambung Google Sheets" : "Mode lokal (browser)");
    } catch (ex) {
      if (seq !== loadSeq) return;
      state.error = ex;
      state.records = [];
      setConn("error", "Gagal memuat data");
    }
    if (seq !== loadSeq) return;
    state.loading = false;
    render();
  }

  async function onDelete(id) {
    var rec = state.records.filter(function (r) { return r.id === id; })[0];
    var label = rec ? rec.nama : "ini";
    if (!window.confirm('Hapus entri "' + label + '"?')) return;
    try {
      await apiDelete(id);
      await load();
    } catch (ex) {
      window.alert("Gagal menghapus: " + ex.message);
    }
  }

  /* ---- export ---------------------------------------------------------- */

  function buildExportRows(rows) {
    var aoa = [[
      "Tanggal", "Nama", "Jumlah Line",
      "Proses 1 mulai", "Proses 1 selesai", "Proses 1 (menit)", "Proses 1 (jam)",
      "Proses 2 mulai", "Proses 2 selesai", "Proses 2 (menit)", "Proses 2 (jam)",
      "Total (menit)", "Total (jam)"
    ]];
    rows.forEach(function (r) {
      aoa.push([
        r.tanggal, r.nama, Number(r.jumlah_line) || 0,
        r.d1_mulai, r.d1_selesai, r.d1_menit || 0, fmtDuration(r.d1_menit),
        r.d2_mulai, r.d2_selesai, r.d2_menit || 0, fmtDuration(r.d2_menit),
        r.total_menit || 0, fmtDuration(r.total_menit)
      ]);
    });
    aoa.push([
      "", "TOTAL " + rows.length + " entri", sumOf(rows, "jumlah_line"),
      "", "", sumOf(rows, "d1_menit"), fmtDuration(sumOf(rows, "d1_menit")),
      "", "", sumOf(rows, "d2_menit"), fmtDuration(sumOf(rows, "d2_menit")),
      sumOf(rows, "total_menit"), fmtDuration(sumOf(rows, "total_menit"))
    ]);
    return aoa;
  }

  // Netralkan formula Excel: nilai yang diawali =, +, -, @ bisa dieksekusi
  // saat file CSV dibuka. Tanda kutip di depan memaksa Excel memakainya sebagai teks.
  function csvCell(cell) {
    var s = String(cell == null ? "" : cell);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCSV(aoa, filename) {
    var csv = aoa.map(function (row) {
      return row.map(csvCell).join(";");
    }).join("\r\n");
    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, filename);
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function onExport() {
    var rows = getFiltered();
    if (!rows.length) {
      window.alert("Tidak ada data pada filter saat ini, jadi belum ada yang bisa diunduh.");
      return;
    }
    var fname = "rekap-durasi-kerja-" + todayISO() + (state.filters.from || state.filters.to ? "-filter" : "");
    var aoa = buildExportRows(rows);
    if (window.XLSX) {
      var ws = window.XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [
        { wch: 11 }, { wch: 22 }, { wch: 11 },
        { wch: 12 }, { wch: 13 }, { wch: 14 }, { wch: 11 },
        { wch: 12 }, { wch: 13 }, { wch: 14 }, { wch: 11 },
        { wch: 12 }, { wch: 11 }
      ];
      var wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Rekap");
      window.XLSX.writeFile(wb, fname + ".xlsx");
    } else {
      exportCSV(aoa, fname + ".csv");
    }
  }

  /* ---- tema ------------------------------------------------------------ */

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    el.themeToggle.textContent = theme === "dark" ? "Mode terang" : "Mode gelap";
    el.themeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    try { localStorage.setItem(LS_THEME, theme); } catch (e) { /* penyimpanan tema opsional */ }
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
      "connDot", "connText", "themeToggle",
      "entryForm", "nama", "namaList", "tanggal", "jumlah_line",
      "d1_mulai", "d1_selesai", "d1_dur", "d2_mulai", "d2_selesai", "d2_dur",
      "formError", "totalPreview", "submitBtn",
      "rekapMeta", "stats", "statCount", "statLine", "statDur",
      "filterFrom", "filterTo", "filterQ", "resetFilter", "exportBtn",
      "tableStates", "tableWrap", "dataBody", "dataFoot", "footStore"
    ].forEach(function (id) { el[id] = document.getElementById(id); });
  }

  function bind() {
    el.entryForm.addEventListener("submit", onSubmit);
    el.entryForm.addEventListener("reset", function () {
      setTimeout(function () {
        el.tanggal.value = todayISO();
        clearFormError();
        updatePreviews();
      }, 0);
    });
    [el.d1_mulai, el.d1_selesai, el.d2_mulai, el.d2_selesai].forEach(function (i) {
      i.addEventListener("input", updatePreviews);
      i.addEventListener("change", updatePreviews);
    });
    [el.nama, el.tanggal, el.jumlah_line].forEach(function (i) {
      i.addEventListener("input", function () { i.removeAttribute("aria-invalid"); });
    });

    el.themeToggle.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
    });

    el.filterFrom.addEventListener("change", function () { state.filters.from = el.filterFrom.value; render(); });
    el.filterTo.addEventListener("change", function () { state.filters.to = el.filterTo.value; render(); });
    el.filterQ.addEventListener("input", function () { state.filters.q = el.filterQ.value; render(); });
    el.resetFilter.addEventListener("click", function () {
      el.filterFrom.value = "";
      el.filterTo.value = "";
      el.filterQ.value = "";
      state.filters = { from: "", to: "", q: "" };
      render();
    });

    el.exportBtn.addEventListener("click", onExport);

    el.dataBody.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-del]");
      if (btn) onDelete(btn.getAttribute("data-del"));
    });

    el.tableStates.addEventListener("click", function (e) {
      if (e.target.closest('[data-action="retry"]')) load();
    });
  }

  function init() {
    cache();
    initTheme();
    bind();
    el.tanggal.value = todayISO();
    updatePreviews();
    load();
  }

  init();
})();
