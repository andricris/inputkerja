/**
 * Backend Rekap Durasi Kerja.
 * Google Apps Script yang menempel pada satu Google Spreadsheet.
 * Semua data disimpan di sheet bernama SHEET_NAME.
 *
 * Keamanan:
 *  - Semua aksi wajib menyertakan token yang sama dengan Script Property
 *    bernama TOKEN_KEY. Gagal = request ditolak (fail-closed).
 *  - Validasi dilakukan di server, bukan hanya di browser.
 *  - Ada batas baris supaya sheet dan kuota Apps Script tidak dibom.
 */

var SHEET_NAME = 'Data';

var HEADERS = [
  'id', 'timestamp', 'tanggal', 'nama', 'jumlah_line',
  'd1_mulai', 'd1_selesai', 'd1_menit',
  'd2_mulai', 'd2_selesai', 'd2_menit',
  'total_menit'
];

// Kolom teks (1-based). Wajib format plain text supaya Sheets tidak mengubah
// "2026-10-01" atau "09:26" menjadi objek tanggal.
var TEXT_COLUMNS = [1, 2, 3, 4, 6, 7, 9, 10]; // A,B,C,D,F,G,I,J

// Indeks kolom (0-based) yang perlu diformat ulang bila terlanjur jadi Date.
var COL_TANGGAL = 2;
var COL_TIMES = [5, 6, 8, 9];

// Token dibaca dari Project Settings > Script properties > RDK_TOKEN.
var TOKEN_KEY = 'RDK_TOKEN';
var MAX_ROWS = 5000;   // batas baris data
var MAX_LIST = 1000;   // batas baris yang dikirim per request list
var MAX_NAMA = 80;

var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Menerima H:mm maupun HH:mm; nilai diseragamkan ke HH:mm lewat padTime_.
var TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** "9:19" -> "09:19". Nilai di luar format jam dikembalikan apa adanya. */
function padTime_(t) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(t === undefined || t === null ? '' : t).trim());
  if (!m) return String(t === undefined || t === null ? '' : t);
  var h = parseInt(m[1], 10);
  if (h > 23) return String(t);
  return (h < 10 ? '0' : '') + h + ':' + m[2];
}

/* ---- entry points ----------------------------------------------------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action !== 'list') {
    return json({ ok: false, error: 'Aksi tidak dikenal: ' + p.action });
  }
  try {
    requireToken_(p.token);
    return json({ ok: true, data: readAll(MAX_LIST) });
  } catch (err) {
    return json({ ok: false, error: msg_(err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Body bukan JSON yang valid' });
  }

  try {
    requireToken_(body.token);
    if (body.action === 'add') {
      return json({ ok: true, data: addRecord(body.payload || {}) });
    }
    if (body.action === 'update') {
      return json({ ok: true, data: updateRecord(body.payload || {}) });
    }
    if (body.action === 'delete') {
      var res = deleteRecord(body.id);
      if (!res.deleted) return json({ ok: false, error: 'Data tidak ditemukan' });
      return json({ ok: true, data: res });
    }
    return json({ ok: false, error: 'Aksi tidak dikenal: ' + body.action });
  } catch (err) {
    return json({ ok: false, error: msg_(err) });
  }
}

/* ---- auth ------------------------------------------------------------- */

function requireToken_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty(TOKEN_KEY);
  if (!expected) {
    throw new Error('Token backend belum diatur: isi Script property "' +
      TOKEN_KEY + '" dengan nilai yang sama seperti di config.js');
  }
  if (!token || String(token) !== String(expected)) {
    throw new Error('Token tidak valid');
  }
}

function msg_(err) {
  return String(err && err.message ? err.message : err);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---- sheet ------------------------------------------------------------ */

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    TEXT_COLUMNS.forEach(function (col) {
      sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  }
  return sheet;
}

function readAll(limit) {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var count = Math.min(last - 1, Number(limit) || MAX_LIST);
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var values = sheet.getRange(2, 1, count, HEADERS.length).getValues();
  return values
    .filter(function (row) { return row[0] !== '' && row[0] !== null; })
    .map(function (row) {
      var obj = {};
      HEADERS.forEach(function (key, i) {
        var v = row[i];
        if (v instanceof Date) {
          if (i === COL_TANGGAL) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
          else if (COL_TIMES.indexOf(i) !== -1) v = Utilities.formatDate(v, tz, 'HH:mm');
          else v = v.toISOString();
        } else if (typeof v === 'string' && COL_TIMES.indexOf(i) !== -1) {
          // Nilai lama seperti "9:19" diseragamkan ke "09:19" supaya aman
          // dimasukkan ke <input type="time"> di browser.
          v = padTime_(v);
        }
        obj[key] = v;
      });
      return obj;
    });
}

/** Cari baris berdasarkan id. Mengembalikan nomor baris (1-based) atau -1. */
function findRowById_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

/* ---- validasi --------------------------------------------------------- */

function validatePayload_(payload) {
  var nama = String(payload.nama === undefined || payload.nama === null ? '' : payload.nama).trim();
  if (!nama) throw new Error('Nama wajib diisi');
  if (nama.length > MAX_NAMA) throw new Error('Nama maksimal ' + MAX_NAMA + ' karakter');

  var tanggal = String(payload.tanggal || '');
  if (!DATE_RE.test(tanggal)) throw new Error('Format tanggal harus YYYY-MM-DD');

  var jumlah = Number(payload.jumlah_line);
  if (!isFinite(jumlah) || Math.floor(jumlah) !== jumlah || jumlah < 0 || jumlah > 100000) {
    throw new Error('Jumlah line harus bilangan bulat 0-100000');
  }

  var times = {
    d1_mulai: padTime_(payload.d1_mulai),
    d1_selesai: padTime_(payload.d1_selesai),
    d2_mulai: padTime_(payload.d2_mulai),
    d2_selesai: padTime_(payload.d2_selesai)
  };

  ['d1', 'd2'].forEach(function (k) {
    var mulai = times[k + '_mulai'];
    var selesai = times[k + '_selesai'];
    if ((mulai && !selesai) || (!mulai && selesai)) {
      throw new Error(k + ': jam mulai dan jam selesai harus diisi keduanya');
    }
    if (mulai && !TIME_RE.test(mulai)) throw new Error(k + '_mulai format jam harus HH:mm');
    if (selesai && !TIME_RE.test(selesai)) throw new Error(k + '_selesai format jam harus HH:mm');
    if (mulai && diffMinutes(mulai, selesai) === 0) {
      throw new Error(k + ': durasi 0 menit, jam mulai dan selesai sama');
    }
  });

  if (!times.d1_mulai && !times.d2_mulai) {
    throw new Error('Isi minimal satu proses');
  }

  return { nama: nama, tanggal: tanggal, jumlah: jumlah, times: times };
}

/* ---- aksi ------------------------------------------------------------- */

function uid_() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function checkId_(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw new Error('Id tidak valid');
  return String(id);
}

/** Susun objek record dari payload yang sudah divalidasi. */
function recFromPayload_(payload, id, timestamp) {
  var v = validatePayload_(payload);
  var d1 = diffMinutes(v.times.d1_mulai, v.times.d1_selesai);
  var d2 = diffMinutes(v.times.d2_mulai, v.times.d2_selesai);
  return {
    id: id,
    timestamp: timestamp,
    tanggal: v.tanggal,
    nama: v.nama,
    jumlah_line: v.jumlah,
    d1_mulai: v.times.d1_mulai,
    d1_selesai: v.times.d1_selesai,
    d1_menit: d1 === null ? 0 : d1,
    d2_mulai: v.times.d2_mulai,
    d2_selesai: v.times.d2_selesai,
    d2_menit: d2 === null ? 0 : d2,
    total_menit: (d1 || 0) + (d2 || 0)
  };
}

/** Tulis satu baris penuh. Format teks dipasang dulu agar tanggal/jam tetap string. */
function writeRow_(sheet, row, rec) {
  TEXT_COLUMNS.forEach(function (col) {
    sheet.getRange(row, col).setNumberFormat('@');
  });
  sheet.getRange(row, 1, 1, HEADERS.length).setValues([HEADERS.map(function (key) { return rec[key]; })]);
}

function addRecord(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet();
    if (sheet.getLastRow() >= MAX_ROWS + 1) {
      throw new Error('Baris data sudah penuh (' + MAX_ROWS + '), hubungi admin');
    }

    var id = payload.id ? checkId_(payload.id) : uid_();
    if (findRowById_(sheet, id) !== -1) throw new Error('Id duplikat: ' + id);

    var rec = recFromPayload_(payload, id, payload.timestamp || new Date().toISOString());
    writeRow_(sheet, sheet.getLastRow() + 1, rec);
    return rec;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Ubah baris yang sudah ada. Id wajib ada; timestamp asli dipertahankan
 * supaya kolom itu tetap berarti "kapan data dibuat".
 */
function updateRecord(payload) {
  if (!payload || !payload.id) throw new Error('id wajib dikirim untuk mengubah');
  var id = checkId_(payload.id);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet();
    var row = findRowById_(sheet, id);
    if (row === -1) throw new Error('Data tidak ditemukan');

    var existing = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
    var ts = existing[1];
    if (ts instanceof Date) ts = ts.toISOString();
    ts = String(ts || '').trim();
    if (!ts) ts = new Date().toISOString();

    var rec = recFromPayload_(payload, id, ts);
    writeRow_(sheet, row, rec);
    return rec;
  } finally {
    lock.releaseLock();
  }
}

function deleteRecord(id) {
  if (!id) throw new Error('id wajib dikirim untuk menghapus');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet();
    var row = findRowById_(sheet, id);
    if (row === -1) return { deleted: 0, id: id };
    sheet.deleteRow(row);
    return { deleted: 1, id: id };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Sekali jalan dari editor Apps Script: Run > normalizeSheet.
 *
 * Baris lama (ditulis versi sebelumnya) berisi tanggal/jam berformat ISO
 * seperti "2026-10-01T17:00:00.000Z" dan "1899-12-30T02:11:48.000Z".
 * Nilai itu dikonversi ke "yyyy-MM-dd" / "HH:mm" sesuai zona spreadsheet,
 * lalu seluruh kolom teks dikunci ke format plain text.
 *
 * Fungsi ini tidak terlibat di doGet/doPost, jadi tidak perlu deploy ulang
 * untuk menjalankannya.
 */
function normalizeSheet() {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return 'Tidak ada baris data.';

  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var n = last - 1;
  var changed = 0;

  var tanggal = sheet.getRange(2, COL_TANGGAL + 1, n, 1).getValues().map(function (r) {
    var v = legacyToText_(r[0], 'yyyy-MM-dd', tz);
    if (v !== r[0]) changed++;
    return [v];
  });

  var jam = COL_TIMES.map(function (colIdx) {
    return sheet.getRange(2, colIdx + 1, n, 1).getValues().map(function (r) {
      var v = legacyToText_(r[0], 'HH:mm', tz);
      if (v !== r[0]) changed++;
      return [v];
    });
  });

  // Tulis dulu sebagai teks, baru kunci format kolomnya.
  sheet.getRange(2, COL_TANGGAL + 1, n, 1).setValues(tanggal);
  COL_TIMES.forEach(function (colIdx, k) {
    sheet.getRange(2, colIdx + 1, n, 1).setValues(jam[k]);
  });
  TEXT_COLUMNS.forEach(function (col) {
    sheet.getRange(2, col, n, 1).setNumberFormat('@');
  });

  return 'Selesai: ' + changed + ' sel diperbaiki dari ' + n + ' baris.';
}

// ISO (Date atau teks ber-'T') -> pola yang diminta. Selain itu dibiarkan.
// Untuk pola jam hasilnya selalu di-pad ke HH:mm.
function legacyToText_(value, pattern, tz) {
  var out;
  if (value === '' || value === null || value === undefined) return value;
  if (value instanceof Date) {
    out = Utilities.formatDate(value, tz, pattern);
  } else {
    var s = String(value);
    if (s.indexOf('T') === -1) {
      out = s;
    } else {
      var d = new Date(s);
      out = isNaN(d.getTime()) ? s : Utilities.formatDate(d, tz, pattern);
    }
  }
  if (pattern === 'HH:mm') out = padTime_(out);
  return out;
}

/* ---- util ------------------------------------------------------------- */

// Durasi dalam menit; shift yang melewati tengah malam ditambah 24 jam.
function diffMinutes(start, end) {
  var a = toMinutes(start);
  var b = toMinutes(end);
  if (a === null || b === null) return null;
  var d = b - a;
  if (d < 0) d += 1440;
  return d;
}

function toMinutes(t) {
  if (!t) return null;
  var parts = String(t).split(':');
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}
