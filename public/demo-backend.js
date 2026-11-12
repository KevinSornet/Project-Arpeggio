/*
 * Demo backend: runs the real Arpeggio core (core.js) inside the browser, with data kept in this
 * browser's localStorage and pre-filled with fake releases. Used automatically when config.js has
 * no apiUrl, so the GitHub Pages site works as a try-it-out demo before Google is connected.
 */
var DemoBackend = (function () {
  'use strict';
  var STORE_KEY = 'arpeggio.demo.v1';
  var DEMO_PASSWORD = 'demo1234';
  var DEMO_USERS = [
    { username: 'admin', name: 'Demo Admin', role: 'admin', dealer: '' },
    { username: 'manager', name: 'Demo Manager', role: 'manager', dealer: '' },
    { username: 'sucat.staff', name: 'Sucat Sales', role: 'dealer', dealer: 'SUCAT' },
  ];

  // ---------------------------------------------------------------- SHA-256 / HMAC (synchronous)
  var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

  function utf8(s) { return Array.from(new TextEncoder().encode(String(s))); }

  function sha256Bytes(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length * 8;
    var m = bytes.slice();
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    for (var i = 7; i >= 0; i--) m.push(i > 3 ? 0 : (l >>> (i * 8)) & 0xff);
    var w = new Array(64);
    for (var off = 0; off < m.length; off += 64) {
      for (i = 0; i < 16; i++) w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | m[off + i * 4 + 3];
      for (i = 16; i < 64; i++) {
        var a = w[i - 15], b = w[i - 2];
        var s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        var s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var A = H[0], B = H[1], C = H[2], D = H[3], E = H[4], F = H[5], G = H[6], Hh = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
        var t1 = (Hh + S1 + ((E & F) ^ (~E & G)) + K[i] + w[i]) | 0;
        var S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
        var t2 = (S0 + ((A & B) ^ (A & C) ^ (B & C))) | 0;
        Hh = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
      }
      H = [(H[0] + A) | 0, (H[1] + B) | 0, (H[2] + C) | 0, (H[3] + D) | 0, (H[4] + E) | 0, (H[5] + F) | 0, (H[6] + G) | 0, (H[7] + Hh) | 0];
    }
    var out = [];
    H.forEach(function (h) { out.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff); });
    return out;
  }
  function hex(bytes) { return bytes.map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }
  function sha256Hex(s) { return hex(sha256Bytes(utf8(s))); }
  function hmacHex(key, msg) {
    var k = utf8(key);
    if (k.length > 64) k = sha256Bytes(k);
    while (k.length < 64) k.push(0);
    var ipad = k.map(function (b) { return b ^ 0x36; }), opad = k.map(function (b) { return b ^ 0x5c; });
    return hex(sha256Bytes(opad.concat(sha256Bytes(ipad.concat(utf8(msg))))));
  }
  function randomHex(n) { return hex(Array.from(crypto.getRandomValues(new Uint8Array(n)))); }

  // ---------------------------------------------------------------- tables in localStorage
  function MemoryDb(state) { this.s = state; }
  MemoryDb.prototype.save = function () {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.s)); } catch (e) { /* private mode: keep in memory */ }
  };
  MemoryDb.prototype.rows = function (t) { return this.s.tables[t] || (this.s.tables[t] = []); };
  MemoryDb.prototype.all = function (t) {
    var rows = this.rows(t).map(function (r) { return Object.assign({}, r); });
    if (t === 'releases') Arpeggio.canonicalizeRows(this, rows);
    return rows;
  };
  MemoryDb.prototype.get = function (t, id) { var r = this.rows(t).filter(function (x) { return x.id === id; })[0]; return r ? Object.assign({}, r) : null; };
  MemoryDb.prototype.insertMany = function (t, recs) {
    var rows = this.rows(t), self = this;
    var ids = recs.map(function (r) {
      var rec = Object.assign({}, r, { id: ++self.s.nextId[t] || (self.s.nextId[t] = 1) });
      rows.push(rec);
      return rec.id;
    });
    this.save();
    return ids;
  };
  MemoryDb.prototype.insert = function (t, rec) { return this.insertMany(t, [rec])[0]; };
  MemoryDb.prototype.append = function (t, rec) { // same as the sheet's: keep the given id
    this.rows(t).push(Object.assign({}, rec));
    if (this.rows(t).length > 5000) this.s.tables[t] = this.rows(t).slice(-5000); // keep demo storage small
    this.save();
  };
  MemoryDb.prototype.update = function (t, id, patch) {
    var r = this.rows(t).filter(function (x) { return x.id === id; })[0];
    if (!r) throw new Error('Not found');
    Object.keys(patch).forEach(function (k) { if (k !== 'id') r[k] = patch[k]; });
    this.save();
  };
  MemoryDb.prototype.updateWhere = function (t, pred, fn) {
    var n = 0;
    this.rows(t).forEach(function (r) { if (pred(Object.assign({}, r))) { Object.assign(r, fn(Object.assign({}, r)), { id: r.id }); n++; } });
    this.save();
    return n;
  };
  MemoryDb.prototype.remove = function (t, ids) {
    this.s.tables[t] = this.rows(t).filter(function (r) { return ids.indexOf(r.id) < 0; });
    this.save();
  };

  // ---------------------------------------------------------------- environment
  function manilaParts() {
    var p = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }

  var env = null;
  function getEnv() {
    if (env) return env;
    var state = null;
    try { state = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { state = null; }
    var fresh = !state || !state.tables;
    if (fresh) state = { secret: randomHex(32), tables: { releases: [], refs: [], users: [] }, nextId: { releases: 0, refs: 0, users: 0 } };
    var cache = {};
    env = {
      mode: 'demo',
      secret: state.secret,
      db: new MemoryDb(state),
      crypto: { sha256Hex: sha256Hex, hmacHex: hmacHex, randomHex: randomHex },
      cache: {
        get: function (k) { var c = cache[k]; return c && c.until > Date.now() ? c.v : null; },
        put: function (k, v, s) { cache[k] = { v: v, until: Date.now() + s * 1000 }; },
        remove: function (k) { delete cache[k]; },
      },
      withLock: function (fn) { return fn(); },
      now: function () { return Date.now(); },
      nowIso: function () { var p = manilaParts(); return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second; },
      today: function () { var p = manilaParts(); return p.year + '-' + p.month + '-' + p.day; },
    };
    if (fresh) seed(env);
    return env;
  }

  // ---------------------------------------------------------------- fake data
  function seed(env) {
    var db = env.db;
    Arpeggio.setup(env, 'admin', DEMO_PASSWORD);
    DEMO_USERS.slice(1).forEach(function (u) {
      db.insert('users', Object.assign({}, u, { active: 1, password_hash: Arpeggio.hashPassword(env, DEMO_PASSWORD), created_at: env.nowIso() }));
    });
    db.update('users', 1, { name: DEMO_USERS[0].name });

    var seedN = 42;
    var rnd = function () { // mulberry32: repeatable "random" numbers
      seedN |= 0; seedN = (seedN + 0x6D2B79F5) | 0;
      var t = Math.imul(seedN ^ (seedN >>> 15), 1 | seedN);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    var pick = function (a) { return a[Math.floor(rnd() * a.length)]; };
    var weighted = function (items, weights) {
      var total = weights.reduce(function (a, b) { return a + b; }, 0), x = rnd() * total;
      for (var i = 0; i < items.length; i++) { x -= weights[i]; if (x < 0) return items[i]; }
      return items[items.length - 1];
    };
    var FIRST = ['JUAN', 'MARIA', 'JOSE', 'ANA', 'MARK', 'GRACE', 'PAULO', 'ROSE', 'JOHN', 'LIZA', 'CARLO', 'NINA',
      'RAMON', 'DIANA', 'VICTOR', 'ELLA', 'BENJIE', 'TESS', 'ARNEL', 'JOY', 'KEVIN', 'ABBY'];
    var LAST = ['DELA CRUZ', 'SANTOS', 'REYES', 'BAUTISTA', 'GONZALES', 'AQUINO', 'VILLANUEVA', 'FLORES', 'CASTRO',
      'MERCADO', 'PASCUAL', 'SALAZAR', 'TORRES', 'LOPEZ', 'RIVERA', 'MORALES', 'DOMINGO', 'ROXAS'];
    var COMPANIES = ['METRO LOGISTICS INC.', 'SUNRISE REALTY CORP.', 'PACIFIC TOURS INC.', 'GREENFIELD FARMS CORP.'];
    var SEASON = [0, 0.85, 0.9, 1.05, 0.95, 0.95, 1.0, 0.95, 1.0, 1.05, 1.1, 1.15, 1.35];
    var VW = { TERRA: 24, NAVARA: 18, 'URVAN PREMIUM': 10, 'URVAN STANDARD': 9, PATROL: 10, KICKS: 9, LIVINA: 8, ALMERA: 8 };
    var TW = { FINANCING: 45, CASH: 28, 'BANK PO': 15, 'COMPANY PO': 8 };

    var refs = Arpeggio.refsByKind(db);
    var lk = new Arpeggio.Lookups(refs);
    var dealers = refs.dealer.map(function (r) { return r.name; });
    var units = {};
    refs.unit.forEach(function (u) { (units[u.parent] = units[u.parent] || []).push(u.name); });
    var variants = refs.variant.map(function (v) { return v.name; }).filter(function (v) { return units[v]; });
    var txs = refs.transaction.map(function (t) { return t.name; });
    var colors = refs.color.map(function (c) { return c.name; });
    var banks = refs.bank.map(function (b) { return b.name; }).slice(0, 8);
    var sold = refs.status.filter(function (s) { return s.category === 'sold'; })[0].name;
    var cancelled = refs.status.filter(function (s) { return s.category === 'cancelled'; })[0].name;
    var open = refs.status.filter(function (s) { return (s.category || 'open') === 'open'; }).map(function (s) { return s.name; });
    var sizes = {}, grms = {}, usedNames = {}, grmRows = [];
    dealers.forEach(function (d) {
      sizes[d] = 0.5 + rnd() * 0.8;
      grms[d] = [];
      var want = 2 + Math.floor(rnd() * 2);
      while (grms[d].length < want) {
        var nm = pick(FIRST) + ' ' + pick(LAST);
        if (usedNames[nm]) continue;
        usedNames[nm] = 1;
        grms[d].push(nm);
        grmRows.push({ kind: 'grm', name: nm, parent: d, category: '', sort: grmRows.length });
      }
    });
    db.insertMany('refs', grmRows);

    var today = env.today();
    var t0 = new Date(today + 'T00:00:00Z');
    var start = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() - 12, 1));
    var end = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() + 2, 1));
    var iso = function (d) { return d.toISOString().slice(0, 10); };
    var rows = [], ts = env.nowIso();
    for (var d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
      var monthsIn = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + d.getUTCMonth() - start.getUTCMonth();
      var daysAhead = Math.round((d - t0) / 86400000);
      dealers.forEach(function (dealer) {
        var lam = 0.75 * sizes[dealer] * SEASON[d.getUTCMonth() + 1] * (1 + 0.02 * monthsIn) * (d.getUTCDay() === 0 ? 0.55 : 1);
        var k = 0;
        for (var i = 0; i < 6; i++) if (rnd() < lam / 6) k++;
        if (daysAhead > 0) { var kk = 0; for (i = 0; i < k; i++) if (rnd() < Math.max(0.15, 0.95 - daysAhead / 70)) kk++; k = kk; }
        for (i = 0; i < k; i++) {
          var variant = weighted(variants, variants.map(function (v) { return VW[v] || 1; }));
          var tt = weighted(txs, txs.map(function (t) { return TW[t] || 5; }));
          var isBank = !!lk.bankTx[tt], status;
          if (daysAhead < 0) status = rnd() < (isBank ? 0.14 : 0.06) ? cancelled : sold;
          else if (daysAhead === 0) status = rnd() < 0.5 ? sold : open[open.length - 1];
          else {
            var progress = Math.max(0, 1 - daysAhead / 45) + (rnd() - 0.5) * 0.5;
            var stages = isBank ? open : (open.filter(function (s) { return s.toLowerCase().indexOf('bank') < 0; }));
            if (!stages.length) stages = open;
            status = stages[Math.min(stages.length - 1, Math.max(0, Math.floor(progress * stages.length)))];
          }
          rows.push({
            branch: dealer, target_date: iso(d), variant: variant, unit: pick(units[variant]), color: pick(colors),
            cs_number: status === sold || status === open[open.length - 1]
              ? pick('FGHKLMN'.split('')) + pick('ABCDLMR'.split('')) + (100 + Math.floor(rnd() * 900)) + pick('ABCDEF'.split('')) : '',
            transaction_type: tt, bank: isBank ? pick(banks) : '',
            client: /PO$/.test(tt) && rnd() < 0.6 ? pick(COMPANIES) : pick(FIRST) + ' ' + pick(LAST),
            grm: pick(grms[dealer]), status: status,
            remarks: status === cancelled && rnd() < 0.4 ? 'Client backed out' : '',
            created_at: ts, created_by: 'demo', updated_at: ts, updated_by: 'demo',
          });
        }
      });
    }
    db.insertMany('releases', rows);
  }

  return {
    handle: function (req) { return Arpeggio.handle(req, getEnv()); },
    reset: function () { try { localStorage.removeItem(STORE_KEY); } catch (e) {} env = null; },
    accounts: DEMO_USERS.map(function (u) { return { username: u.username, role: u.role, dealer: u.dealer, password: DEMO_PASSWORD }; }),
    _sha256Hex: sha256Hex, _hmacHex: hmacHex,
  };
})();
