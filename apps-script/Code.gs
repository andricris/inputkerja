/**
 * Backend Rekap Durasi Kerja.
 * Google Apps Script yang menempel pada satu Google Spreadsheet.
 * Semua data disimpan di sheet bernama SHEET_NAME.
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

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'list';
  if (action === 'list') {
    return json({ ok: true, data: readAll() });
  }
  return json({ ok: false, error: 'Aksi tidak dikenal: ' + action });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Body bukan JSON yang valid' });
  }

  var action = body.action;
  try {
    if (action === 'add') {
      return json({ ok: true, data: addRecord(body.payload || {}) });
    }
    if (action === 'delete') {
      return json({ ok: true, data: deleteRecord(body.id) });
    }
    return json({ ok: false, error: 'Aksi tidak dikenal: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

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

function readAll() {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
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
        }
        obj[key] = v;
      });
      return obj;
    });
}

function addRecord(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet();
    var mulai1 = String(payload.d1_mulai || '');
    var selesai1 = String(payload.d1_selesai || '');
    var mulai2 = String(payload.d2_mulai || '');
    var selesai2 = String(payload.d2_selesai || '');

    var d1 = diffMinutes(mulai1, selesai1);
    var d2 = diffMinutes(mulai2, selesai2);
    var rec = {
      id: payload.id || ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
      timestamp: payload.timestamp || new Date().toISOString(),
      tanggal: String(payload.tanggal || ''),
      nama: String(payload.nama || '').trim(),
      jumlah_line: Number(payload.jumlah_line) || 0,
      d1_mulai: mulai1,
      d1_selesai: selesai1,
      d1_menit: d1 === null ? 0 : d1,
      d2_mulai: mulai2,
      d2_selesai: selesai2,
      d2_menit: d2 === null ? 0 : d2,
      total_menit: (d1 || 0) + (d2 || 0)
    };

    var row = sheet.getLastRow() + 1;
    // Format teks dipasang sebelum menulis nilai agar tanggal dan jam tetap string.
    TEXT_COLUMNS.forEach(function (col) {
      sheet.getRange(row, col).setNumberFormat('@');
    });
    sheet.getRange(row, 1, 1, HEADERS.length).setValues([HEADERS.map(function (key) { return rec[key]; })]);
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
    var last = sheet.getLastRow();
    if (last < 2) return { deleted: 0 };

    var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]) === String(id)) {
        sheet.deleteRow(i + 2);
        return { deleted: 1, id: id };
      }
    }
    return { deleted: 0, id: id };
  } finally {
    lock.releaseLock();
  }
}

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

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
