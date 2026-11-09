/**
 * Arpeggio — Google Apps Script backend.
 *
 * This project needs TWO script files:
 *   Code.gs  — this file (Google-specific: the sheet, hashing, locking, web endpoint)
 *   Core.gs  — a copy of public/core.js from the repo (the app's rules: logins, roles, validation)
 *
 * Setup is in DEPLOY.md. In short: attach this script to your Google Sheet (Extensions → Apps Script),
 * run setup() once, then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 */

// Leave blank when the script is attached to the spreadsheet (Extensions → Apps Script).
// Otherwise paste the spreadsheet ID here.
var SHEET_ID = '';
var TIME_ZONE = 'Asia/Manila';

// ------------------------------------------------------------------ web endpoint
function doPost(e) {
  var req = {};
  try { req = JSON.parse(e && e.postData ? e.postData.contents : '{}'); } catch (err) { req = {}; }
  return json_(Arpeggio.handle(req, makeEnv_()));
}

function doGet() {
  return json_({ ok: true, app: 'arpeggio', hint: 'The app talks to this address with POST requests.' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------------ run once from the editor
/**
 * Creates the Releases / References / Users tabs, the default reference lists and the first
 * admin account. The admin password is shown in the Execution log (View → Logs).
 */
function setup() {
  var env = makeEnv_();
  Object.keys(Arpeggio.TABLES).forEach(function (t) { env.db.sheet(t); });
  var out = Arpeggio.setup(env, 'admin', '');
  Logger.log(out.refs ? 'Default reference lists added.' : 'Reference lists already present.');
  if (out.admin) {
    Logger.log('FIRST ADMIN ACCOUNT  →  username: %s   password: %s', out.admin.username, out.admin.password);
    Logger.log('Sign in to the app and change this password (click your name, top right).');
  } else {
    Logger.log('Users already exist; no admin created.');
  }
}

/** Emergency reset: sets a new random password for "admin" and re-enables it (shown in the log). */
function resetAdminPassword() {
  var env = makeEnv_();
  var pw = env.crypto.randomHex(6);
  env.withLock(function () {
    var admin = env.db.all('users').filter(function (u) { return u.username === 'admin'; })[0];
    if (!admin) throw new Error('No user named admin');
    env.db.update('users', admin.id, { password_hash: Arpeggio.hashPassword(env, pw), active: 1, role: 'admin' });
  });
  Logger.log('New password for admin: %s', pw);
}

// ------------------------------------------------------------------ environment for the core
function makeEnv_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SECRET');
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('SECRET', secret);
  }
  var cache = CacheService.getScriptCache();
  var db = new SheetDb_(SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet());
  return {
    mode: 'google-sheets',
    secret: secret,
    db: db,
    crypto: {
      sha256Hex: function (s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); },
      hmacHex: function (k, m) { return hex_(Utilities.computeHmacSha256Signature(m, k, Utilities.Charset.UTF_8)); },
      randomHex: function (n) { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, n * 2); },
    },
    cache: {
      get: function (k) { return cache.get(k); },
      put: function (k, v, s) { cache.put(k, v, s); },
      remove: function (k) { cache.remove(k); },
    },
    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);
      db.locked = true;
      try { return fn(); } finally { SpreadsheetApp.flush(); db.locked = false; lock.releaseLock(); }
    },
    now: function () { return Date.now(); },
    nowIso: function () { return Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ss"); },
    today: function () { return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd'); },
  };
}

function hex_(bytes) {
  return bytes.map(function (b) { var v = (b + 256) % 256; return (v < 16 ? '0' : '') + v.toString(16); }).join('');
}

// ------------------------------------------------------------------ the spreadsheet as tables
/**
 * Reads each tab once per request and keeps it in memory; writes go straight to the sheet.
 * Columns are found by their header name, so people can reorder columns or add their own.
 * Rows typed in by hand without an ID (or with a duplicate ID) get a new ID written back.
 */
function SheetDb_(ss) {
  this.ss = ss;
  this.cache = {};
  this.locked = false;
}

SheetDb_.prototype.sheet = function (table) {
  var spec = Arpeggio.TABLES[table];
  var sh = this.ss.getSheetByName(spec.tab);
  var headers = spec.cols.map(function (c) { return c[1]; });
  if (!sh) {
    sh = this.ss.insertSheet(spec.tab);
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@'); // keep values as typed text
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else {
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim().toUpperCase(); });
    var missing = headers.filter(function (h) { return current.indexOf(h.toUpperCase()) < 0; });
    if (missing.length) {
      var start = current.filter(String).length ? lastCol + 1 : 1;
      sh.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
    }
  }
  return sh;
};

SheetDb_.prototype.load_ = function (table) {
  if (this.cache[table]) return this.cache[table];
  var spec = Arpeggio.TABLES[table];
  var sh = this.sheet(table);
  var values = sh.getDataRange().getValues();
  var headerRow = (values[0] || []).map(function (h) { return String(h).trim().toUpperCase(); });
  var pos = {};
  spec.cols.forEach(function (c) { var i = headerRow.indexOf(c[1].toUpperCase()); if (i >= 0) pos[c[0]] = i; });
  var width = headerRow.length;
  var rows = [], seen = {}, needId = [];
  for (var r = 1; r < values.length; r++) {
    var raw = values[r];
    if (!raw.some(function (v) { return String(v).trim() !== ''; })) continue;
    var rec = { _row: r + 1, _raw: raw.slice(0, width) };
    spec.cols.forEach(function (c) {
      var f = c[0], v = pos[f] != null ? raw[pos[f]] : '';
      if (v instanceof Date) v = Utilities.formatDate(v, TIME_ZONE, f === 'target_date' ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm:ss");
      v = v == null ? '' : String(v).trim();
      if (f === 'active') rec[f] = /^(0|false|no|n)$/i.test(v) ? 0 : 1;
      else if (Arpeggio.INT_FIELDS[f]) rec[f] = v === '' || isNaN(+v) ? null : Math.floor(+v);
      else rec[f] = v;
    });
    if (rec.id == null || seen[rec.id]) needId.push(rec); else seen[rec.id] = true;
    rows.push(rec);
  }
  var t = { sheet: sh, pos: pos, width: width, rows: rows };
  this.cache[table] = t;
  if (needId.length) {
    var self = this;
    var assign = function () {
      var max = rows.reduce(function (m, x) { return Math.max(m, x.id || 0); }, 0);
      needId.forEach(function (rec) {
        rec.id = ++max;
        sh.getRange(rec._row, pos.id + 1).setValue(rec.id);
        rec._raw[pos.id] = rec.id;
      });
    };
    if (this.locked) assign(); else { var lock = LockService.getScriptLock(); lock.waitLock(30000); try { assign(); } finally { lock.releaseLock(); } }
  }
  if (table === 'releases') Arpeggio.canonicalizeRows(this, rows);
  return t;
};

SheetDb_.prototype.clean_ = function (rec) {
  var out = {};
  Object.keys(rec).forEach(function (k) { if (k.charAt(0) !== '_') out[k] = rec[k]; });
  return out;
};

SheetDb_.prototype.all = function (table) {
  var self = this;
  return this.load_(table).rows.map(function (r) { return self.clean_(r); });
};

SheetDb_.prototype.get = function (table, id) {
  var rec = this.load_(table).rows.filter(function (r) { return r.id === id; })[0];
  return rec ? this.clean_(rec) : null;
};

SheetDb_.prototype.rowValues_ = function (t, rec) {
  var vals = rec._raw ? rec._raw.slice() : [];
  while (vals.length < t.width) vals.push('');
  Object.keys(t.pos).forEach(function (f) { vals[t.pos[f]] = rec[f] == null ? '' : rec[f]; });
  return vals;
};

SheetDb_.prototype.insertMany = function (table, recs) {
  if (!recs.length) return [];
  var t = this.load_(table), self = this;
  var max = t.rows.reduce(function (m, x) { return Math.max(m, x.id || 0); }, 0);
  var start = t.sheet.getLastRow() + 1;
  var out = recs.map(function (r, i) {
    var rec = {};
    Object.keys(r).forEach(function (k) { rec[k] = r[k]; });
    rec.id = ++max;
    rec._row = start + i;
    rec._raw = self.rowValues_(t, rec);
    return rec;
  });
  var range = t.sheet.getRange(start, 1, out.length, t.width);
  range.setNumberFormat('@');
  range.setValues(out.map(function (r) { return r._raw; }));
  out.forEach(function (r) { t.rows.push(r); });
  return out.map(function (r) { return r.id; });
};

SheetDb_.prototype.insert = function (table, rec) { return this.insertMany(table, [rec])[0]; };

SheetDb_.prototype.findRow_ = function (t, rec) {
  // the row may have moved if someone sorted/inserted rows in the sheet since we read it
  var idCol = t.pos.id + 1;
  if (String(t.sheet.getRange(rec._row, idCol).getValue()) === String(rec.id)) return rec._row;
  var ids = t.sheet.getRange(1, idCol, t.sheet.getLastRow(), 1).getValues();
  for (var i = 1; i < ids.length; i++) if (String(ids[i][0]) === String(rec.id)) return (rec._row = i + 1);
  throw new Error('Row ' + rec.id + ' was removed from the sheet');
};

SheetDb_.prototype.update = function (table, id, patch) {
  var t = this.load_(table);
  var rec = t.rows.filter(function (r) { return r.id === id; })[0];
  if (!rec) throw new Error('Not found: ' + table + ' ' + id);
  Object.keys(patch).forEach(function (k) { if (k !== 'id' && k.charAt(0) !== '_') rec[k] = patch[k]; });
  rec._raw = this.rowValues_(t, rec);
  t.sheet.getRange(this.findRow_(t, rec), 1, 1, t.width).setValues([rec._raw]);
};

SheetDb_.prototype.updateWhere = function (table, pred, fn) {
  var t = this.load_(table), self = this;
  var hits = t.rows.filter(function (r) { return pred(self.clean_(r)); });
  if (hits.length <= 15) {
    hits.forEach(function (r) { self.update(table, r.id, fn(self.clean_(r))); });
    return hits.length;
  }
  // many rows (e.g. renaming a color used 300 times): re-read, patch and write the block once
  this.cache[table] = null;
  t = this.load_(table);
  var byId = {};
  hits.forEach(function (h) { byId[h.id] = true; });
  t.rows.forEach(function (r) {
    if (!byId[r.id]) return;
    var p = fn(self.clean_(r));
    Object.keys(p).forEach(function (k) { r[k] = p[k]; });
    r._raw = self.rowValues_(t, r);
  });
  var all = t.sheet.getRange(1, 1, t.sheet.getLastRow(), t.width).getValues();
  t.rows.forEach(function (r) { if (byId[r.id]) all[r._row - 1] = r._raw; });
  t.sheet.getRange(1, 1, all.length, t.width).setValues(all);
  return hits.length;
};

SheetDb_.prototype.remove = function (table, ids) {
  var t = this.load_(table), self = this;
  var rowsToDelete = t.rows.filter(function (r) { return ids.indexOf(r.id) >= 0; })
    .map(function (r) { return self.findRow_(t, r); })
    .sort(function (a, b) { return b - a; });
  rowsToDelete.forEach(function (n) {
    try { t.sheet.deleteRow(n); }
    catch (e) { t.sheet.getRange(n, 1, 1, t.width).clearContent(); } // Sheets won't delete the last data row
  });
  this.cache[table] = null; // row numbers shifted; re-read next time
};
