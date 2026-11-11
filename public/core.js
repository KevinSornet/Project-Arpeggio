/*
 * Arpeggio backend core.
 *
 * The same file runs in two places:
 *   - Google Apps Script (paste it into the script project as "Core.gs"), where it is the real
 *     server: it checks logins and roles and reads/writes the Google Sheet.
 *   - The browser, for demo mode (no Apps Script URL configured) and for shared helpers.
 *
 * It is plain JavaScript with no DOM or Google APIs. Everything environment-specific (storage,
 * hashing, locking, clock) comes in through the `env` object passed to Arpeggio.handle().
 */
var Arpeggio = (function () {
  'use strict';

  // ------------------------------------------------------------ reference data
  var REF_KINDS = {
    dealer: { field: 'branch', label: 'Dealers' },
    grm: { field: 'grm', label: 'GRMs' },                    // parent = dealer
    variant: { field: 'variant', label: 'Variants' },
    unit: { field: 'unit', label: 'Units' },               // parent = variant
    color: { field: 'color', label: 'Colors' },
    transaction: { field: 'transaction_type', label: 'Transactions' }, // category: bank | ''
    status: { field: 'status', label: 'Statuses' },        // category: open | sold | cancelled
    bank: { field: 'bank', label: 'Banks' },
  };
  var PARENT_KIND = { unit: 'variant', grm: 'dealer' };
  var STATUS_CATEGORIES = ['open', 'sold', 'cancelled'];
  var ROLES = {
    admin: 'Admin — everything, incl. users and data references',
    manager: 'Manager — all dealers\' releases and dashboard',
    dealer: 'Dealer staff — only their own dealer',
  };

  var DEFAULT_REFS = {
    dealer: ['ALABANG', 'LAS PINAS', 'SUCAT', 'DASMA', 'SILANG', 'CARMONA', 'CALAMBA', 'KAWIT'],
    variant: ['NAVARA', 'TERRA', 'URVAN STANDARD', 'URVAN PREMIUM', 'ALMERA', 'KICKS', 'LIVINA',
      'PATROL', 'NISSAN Z', 'XTRAIL', 'PRIMERA', 'NAVARA PRO'],
    unit: [
      ['ALMERA', 'NISSAN ALMERA 1.0 VE TURBO CVT WITH NCS'], ['ALMERA', 'NISSAN ALMERA 1.0 VL TURBO CVT WITH NCS'],
      ['KICKS', 'NISSAN KICKS E-POWER VE'], ['KICKS', 'NISSAN KICKS E-POWER VL'],
      ['LIVINA', 'NISSAN LIVINA 1.5 VE AT'], ['LIVINA', 'NISSAN LIVINA 1.5 VL AT'],
      ['NAVARA', 'NAVARA 2.5 VE CALIBRE AT 4X2'], ['NAVARA', 'NAVARA 2.5 CALIBRE-X AT 4X2'],
      ['NAVARA', 'NAVARA 2.5 PRO-4X AT 4X4'], ['NAVARA', 'NAVARA 2.5 VE CALIBRE MT 4X2'],
      ['NAVARA', 'NAVARA 2.5 VE MT 4X4'],
      ['NISSAN Z', 'NISSAN Z 3.0L PREMIUM COUPE AT'], ['NISSAN Z', 'NISSAN Z 3.0L PREMIUM COUPE MT'],
      ['PATROL', 'NISSAN PATROL 3.5-L V6 TT AT 4x4'],
      ['TERRA', 'NISSAN TERRA 2.5 VE AT 4X2'], ['TERRA', 'NISSAN TERRA 2.5 SPORT AT 4X2'],
      ['TERRA', 'NISSAN TERRA 2.5 SPORT AT 4x4'], ['TERRA', 'NISSAN TERRA 2.5 VL AT 4X2'],
      ['URVAN PREMIUM', 'NISSAN URVAN 2.5 PREMIUM AT'], ['URVAN PREMIUM', 'NISSAN URVAN 2.5 PREMIUM MT'],
      ['URVAN STANDARD', 'NISSAN URVAN 2.5 GX VAN MT'], ['URVAN STANDARD', 'NISSAN URVAN 2.5 STANDARD'],
      ['URVAN STANDARD', 'NISSAN URVAN 2.5 STANDARD PLUS'], ['URVAN STANDARD', 'NISSAN URVAN 2.5 CARGO MT'],
      ['XTRAIL', 'NISSAN XTRAIL'], ['PRIMERA', 'PRIMERA'], ['NAVARA PRO', 'NAVARA PRO'],
    ],
    color: ['ASPEN PEARL WHITE', 'ALPINE WHITE', 'PEARL WHITE', 'DIAMOND PEARL WHITE', 'EVEREST WHITE',
      'GALAXY BLACK', 'GRANITE BLACK', 'ONYX BLACK', 'LUNAR METALLIC GRAY', 'GUN METALLIC',
      'STEALTH PEARL GRAY', 'MOONSTONE GRAY', 'FIERY RED', 'CAYENNE RED', 'ROYAL RUBY RED',
      'NEBULA METALLIC RED', 'BRILLIANT SILVER', 'FORGED METALLIC COPPER', 'GUN METALLIC WITH BLACK ROOF',
      'RIPTIDE BLUE', 'IKAZUCHI YELLOW WITH BLACK ROOF', 'CAYENNE RED WITH BLACK ROOF',
      'PREMIUM CORONA ORANGE', 'SEIRAN BLUE WITH BLACK ROOF'],
    transaction: [['FINANCING', 'bank'], ['BANK PO', 'bank'], ['COMPANY PO', ''], ['CASH', '']],
    status: [['For Bank Approval', 'open'], ['w/ Bank Approval / Bank PO', 'open'], ['w/ Payment', 'open'],
      ['For Release', 'open'], ['Sold', 'sold'], ['Cancelled', 'cancelled']],
    bank: ['BDO', 'BPI', 'RCBC', 'PNB', 'PSB', 'EWB', 'METROBANK', 'SECURITY BANK', 'CHINABANK', 'UNIONBANK'],
  };

  var FIELDS = ['branch', 'target_date', 'variant', 'unit', 'color', 'cs_number', 'transaction_type',
    'bank', 'client', 'grm', 'status', 'remarks'];

  // Sheet layout: table -> tab name + [field, header] pairs (column order for new sheets).
  var TABLES = {
    releases: { tab: 'Releases', cols: [
      ['id', 'ID'], ['branch', 'DEALER'], ['target_date', 'TARGET RELEASE DATE'], ['variant', 'VARIANT'],
      ['unit', 'UNIT'], ['color', 'COLOR'], ['cs_number', 'CS NUMBER'], ['transaction_type', 'TRANSACTION'],
      ['bank', 'BANK'], ['client', 'CLIENT'], ['grm', 'GRM'], ['status', 'STATUS'], ['remarks', 'REMARKS'],
      ['created_at', 'CREATED AT'], ['created_by', 'CREATED BY'], ['updated_at', 'UPDATED AT'], ['updated_by', 'UPDATED BY']] },
    refs: { tab: 'References', cols: [
      ['id', 'ID'], ['kind', 'LIST'], ['name', 'NAME'], ['parent', 'PARENT VARIANT'], ['category', 'CATEGORY'], ['sort', 'ORDER']] },
    users: { tab: 'Users', cols: [
      ['id', 'ID'], ['username', 'USERNAME'], ['name', 'NAME'], ['role', 'ROLE'], ['dealer', 'DEALER'],
      ['active', 'ACTIVE'], ['password_hash', 'PASSWORD HASH (DO NOT EDIT)'], ['created_at', 'CREATED AT']] },
  };
  var INT_FIELDS = { id: 1, sort: 1, active: 1 };

  var SESSION_DAYS = 14;
  var HASH_ITER = 2000;
  var MAX_FAILS = 8;

  // ------------------------------------------------------------ helpers
  function ApiError(message, status, extra) { this.message = message; this.status = status || 400; this.extra = extra; }
  function bad(msg, status, extra) { throw new ApiError(msg, status, extra); }

  function key(v) { return String(v == null ? '' : v).trim().replace(/[\s_]+/g, ' ').toLowerCase(); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function parseDate(value) {
    var v = str(value), m;
    if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return valid(+m[1], +m[2], +m[3], v);
    if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
      var y = +m[3]; if (y < 100) y += 2000;
      return valid(y, +m[1], +m[2], v);
    }
    bad('Unrecognised date: "' + v + '"');
  }
  function valid(y, mo, d, raw) {
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) bad('Unrecognised date: "' + raw + '"');
    return y + '-' + pad(mo) + '-' + pad(d);
  }

  function sortRefs(list) {
    return list.slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0) || a.id - b.id; });
  }

  function refsByKind(db) {
    var out = {};
    Object.keys(REF_KINDS).forEach(function (k) { out[k] = []; });
    sortRefs(db.all('refs')).forEach(function (r) { if (out[r.kind]) out[r.kind].push(r); });
    return out;
  }

  /** Canonicalises free-typed values against the reference lists. */
  function Lookups(refs) {
    var self = this;
    this.refs = refs;
    this.canon = {};
    Object.keys(refs).forEach(function (k) {
      self.canon[k] = {};
      refs[k].forEach(function (r) { self.canon[k][key(r.name)] = r.name; });
    });
    this.statusCat = {};
    refs.status.forEach(function (r) { self.statusCat[r.name] = r.category || 'open'; });
    this.bankTx = {};
    refs.transaction.forEach(function (r) { if (r.category === 'bank') self.bankTx[r.name] = true; });
    var first = function (cat) { var s = refs.status.filter(function (r) { return r.category === cat; })[0]; return s ? s.name : null; };
    this.firstSold = first('sold');
    this.firstCancelled = first('cancelled');
    var names = refs.status.map(function (r) { return r.name; });
    this.defaultStatus = names.indexOf('For Release') >= 0 ? 'For Release' : (first('open') || '');
  }
  Lookups.prototype.canonical = function (kind, value) {
    var v = str(value).replace(/\s+/g, ' ');
    return this.canon[kind][key(v)] || v;
  };
  Lookups.prototype.cat = function (status) { return this.statusCat[status] || 'open'; };
  Lookups.prototype.status = function (value) {
    var v = key(value);
    if (!v || v === '-') return this.defaultStatus;
    if ((v === 'released' || v === 'delivered') && this.firstSold) return this.firstSold;
    if ((v === 'canceled' || v === 'cancel') && this.firstCancelled) return this.firstCancelled;
    return this.canonical('status', value);
  };

  function cleanRecord(data, lk) {
    var rec = {};
    FIELDS.forEach(function (k) { rec[k] = str(data[k]); });
    if (!rec.branch) bad('Dealer is required');
    if (!rec.variant) bad('Variant is required');
    rec.target_date = parseDate(rec.target_date);
    Object.keys(REF_KINDS).forEach(function (kind) {
      if (kind !== 'status') rec[REF_KINDS[kind].field] = lk.canonical(kind, rec[REF_KINDS[kind].field]);
    });
    rec.status = lk.status(rec.status);
    rec.transaction_type = rec.transaction_type || 'CASH';
    var knownTx = lk.refs.transaction.some(function (t) { return t.name === rec.transaction_type; });
    if (knownTx && !lk.bankTx[rec.transaction_type]) rec.bank = '';
    rec.cs_number = rec.cs_number.toUpperCase();
    return rec;
  }

  function dealerList(db) {
    var refs = sortRefs(db.all('refs')).filter(function (r) { return r.kind === 'dealer'; }).map(function (r) { return r.name; });
    var extra = {};
    db.all('releases').forEach(function (r) { if (r.branch && refs.indexOf(r.branch) < 0) extra[r.branch] = 1; });
    return refs.concat(Object.keys(extra).sort());
  }

  function addRef(db, kind, name, parent, category) {
    name = str(name);
    if (!name) return null;
    var list = db.all('refs').filter(function (r) { return r.kind === kind; });
    if (list.some(function (r) { return key(r.name) === key(name); })) return null;
    var sort = list.reduce(function (m, r) { return Math.max(m, r.sort || 0); }, -1) + 1;
    return db.insert('refs', { kind: kind, name: name, parent: str(parent), category: str(category), sort: sort });
  }

  function seedDefaults(db) {
    var rows = [];
    Object.keys(DEFAULT_REFS).forEach(function (kind) {
      DEFAULT_REFS[kind].forEach(function (item, i) {
        var r = { kind: kind, name: item, parent: '', category: '', sort: i };
        if (kind === 'unit') { r.parent = item[0]; r.name = item[1]; }
        else if (Array.isArray(item)) { r.name = item[0]; r.category = item[1]; }
        rows.push(r);
      });
    });
    db.insertMany('refs', rows);
  }

  // ------------------------------------------------------------ passwords & sessions
  function hashPassword(env, pw, salt, iter) {
    salt = salt || env.crypto.randomHex(16);
    iter = iter || HASH_ITER;
    var h = env.crypto.sha256Hex(salt + ':' + pw);
    for (var i = 1; i < iter; i++) h = env.crypto.sha256Hex(h + salt + pw);
    return 'sha256i$' + iter + '$' + salt + '$' + h;
  }
  function verifyPassword(env, pw, stored) {
    var p = str(stored).split('$');
    if (p.length !== 4 || p[0] !== 'sha256i') return false;
    return hashPassword(env, String(pw || ''), p[2], +p[1]) === stored;
  }
  function passwordProblem(pw) { return String(pw || '').length < 8 ? 'Password must be at least 8 characters' : null; }
  function version(env, hash) { return env.crypto.sha256Hex('v:' + (hash || '')).slice(0, 12); }
  function makeToken(env, user) {
    var payload = user.id + '.' + Math.floor(env.now() / 1000) + '.' + version(env, user.password_hash);
    return payload + '.' + env.crypto.hmacHex(env.secret, payload);
  }
  function userFromToken(env, db, token) {
    var p = str(token).split('.');
    if (p.length !== 4) return null;
    var payload = p[0] + '.' + p[1] + '.' + p[2];
    if (env.crypto.hmacHex(env.secret, payload) !== p[3]) return null;
    if (env.now() / 1000 - +p[1] > SESSION_DAYS * 86400) return null;
    var u = db.get('users', +p[0]);
    if (!u || !u.active || version(env, u.password_hash) !== p[2]) return null;
    return u;
  }

  function publicUser(u) {
    return { id: u.id, username: u.username, name: u.name || '', role: u.role, dealer: u.dealer || '',
      active: u.active ? 1 : 0, created_at: u.created_at || '' };
  }

  function checkRole(db, data) {
    var role = str(data.role || 'dealer').toLowerCase();
    if (!ROLES[role]) bad('Role must be admin, manager or dealer');
    var dealer = str(data.dealer);
    if (role === 'dealer') { if (dealerList(db).indexOf(dealer) < 0) bad('Pick the dealer this person works for'); }
    else dealer = '';
    return { role: role, dealer: dealer };
  }

  function createUser(env, db, data) {
    var username = str(data.username).toLowerCase();
    if (!/^[a-z0-9._@-]{3,64}$/.test(username)) bad('Username: 3-64 characters, letters/numbers/._@- only');
    if (db.all('users').some(function (u) { return u.username.toLowerCase() === username; })) bad('Username "' + username + '" is taken');
    var rd = checkRole(db, data);
    var prob = passwordProblem(data.password);
    if (prob) bad(prob);
    return db.insert('users', { username: username, name: str(data.name), role: rd.role, dealer: rd.dealer, active: 1,
      password_hash: hashPassword(env, String(data.password)), created_at: env.nowIso() });
  }

  function activeAdmins(db, excludeId) {
    return db.all('users').filter(function (u) { return u.role === 'admin' && u.active && u.id !== excludeId; }).length;
  }

  // ------------------------------------------------------------ actions
  var PUBLIC_ACTIONS = { ping: 1, login: 1 };
  var WRITE_ACTIONS = { login: 1, importUsedGrms: 1, changePassword: 1, createRelease: 1, updateRelease: 1, deleteRelease: 1, importReleases: 1,
    addRefs: 1, updateRef: 1, deleteRef: 1, reorderRefs: 1, createUser: 1, updateUser: 1, deleteUser: 1 };

  function refsPayload(db) {
    var refs = refsByKind(db);
    var rel = db.all('releases');
    Object.keys(refs).forEach(function (kind) {
      var field = REF_KINDS[kind].field, usage = {};
      rel.forEach(function (r) { usage[r[field]] = (usage[r[field]] || 0) + 1; });
      refs[kind].forEach(function (it) { it.usage = usage[it.name] || 0; });
    });
    var kinds = {};
    Object.keys(REF_KINDS).forEach(function (k) { kinds[k] = REF_KINDS[k].label; });
    // GRM names typed on releases that aren't in the GRM list yet (offered as a one-click import)
    var knownGrm = {}, unlisted = {};
    refs.grm.forEach(function (g) { knownGrm[key(g.name)] = 1; });
    rel.forEach(function (r) { var k = key(r.grm); if (k && k !== '-' && !knownGrm[k]) unlisted[k] = 1; });
    return { kinds: kinds, refs: refs, status_categories: STATUS_CATEGORIES, parent_kind: PARENT_KIND,
      unlisted_grms: Object.keys(unlisted).length };
  }

  function handle(req, env) {
    req = req || {};
    try {
      var run = function () { return route(req, env); };
      return WRITE_ACTIONS[req.action] ? env.withLock(run) : run();
    } catch (e) {
      if (e instanceof ApiError) {
        var out = { error: e.message, status: e.status };
        if (e.extra) Object.keys(e.extra).forEach(function (k) { out[k] = e.extra[k]; });
        return out;
      }
      return { error: 'Server error: ' + (e && e.message ? e.message : e), status: 500 };
    }
  }

  function route(req, env) {
    var db = env.db;
    var action = req.action;
    if (action === 'ping') return { ok: true };

    if (action === 'login') {
      var uname = str(req.username).toLowerCase();
      var failKey = 'fail:' + uname;
      var fails = +(env.cache.get(failKey) || 0);
      if (fails >= MAX_FAILS) bad('Too many failed attempts. Try again in 15 minutes.', 429);
      var u = db.all('users').filter(function (x) { return x.username.toLowerCase() === uname; })[0];
      if (!u || !u.active || !verifyPassword(env, req.password, u.password_hash)) {
        env.cache.put(failKey, String(fails + 1), 900);
        bad('Wrong username or password', 401);
      }
      env.cache.remove(failKey);
      return { token: makeToken(env, u), user: publicUser(u) };
    }

    var user = userFromToken(env, db, req.token);
    if (!user) bad('Please sign in', 401);
    var who = user.username;
    var requireRole = function () {
      if (Array.prototype.indexOf.call(arguments, user.role) < 0) bad('You don\'t have permission for that', 403);
    };
    var myBranch = function (requested) {
      if (user.role === 'dealer') {
        if (!user.dealer) bad('Your account isn\'t linked to a dealer yet; ask an admin', 403);
        return user.dealer;
      }
      return str(requested);
    };
    var canTouch = function (row) {
      if (user.role === 'dealer' && row.branch !== myBranch()) bad('That release belongs to another dealer', 403);
    };

    switch (action) {
      // ---- me
      case 'bootstrap': {
        var sub = function (action, extra) {
          var r = { token: req.token, action: action };
          Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
          return route(r, env);
        };
        var res = { me: sub('me'), meta: sub('meta') };
        if (req.releases) res.releases = sub('releases', req.releases);
        if (req.refs) res.refs = sub('refs');
        if (req.users) res.users = sub('users');
        return res;
      }
      case 'me':
        var me = publicUser(user); me.roles = ROLES; me.storage = env.mode; return me;
      case 'changePassword': {
        if (!verifyPassword(env, req.current, user.password_hash)) bad('Current password is wrong');
        var prob = passwordProblem(req.new);
        if (prob) bad(prob);
        var h = hashPassword(env, String(req.new));
        db.update('users', user.id, { password_hash: h });
        user.password_hash = h;
        return { ok: true, token: makeToken(env, user) };
      }

      // ---- lookups for forms + dashboard
      case 'meta': {
        var refs = refsByKind(db);
        var lk = new Lookups(refs);
        var mine = user.role === 'dealer' ? myBranch() : null;
        var grms = {};
        refs.grm.forEach(function (g) {
          if (mine === null || g.parent === mine) (grms[g.parent] = grms[g.parent] || []).push(g.name);
        });
        var catalog = {};
        refs.variant.forEach(function (v) { catalog[v.name] = []; });
        refs.unit.forEach(function (u) { (catalog[u.parent] = catalog[u.parent] || []).push(u.name); });
        return {
          branches: mine !== null ? [mine] : dealerList(db),
          statuses: refs.status.map(function (r) { return { name: r.name, category: r.category || 'open' }; }),
          transactions: refs.transaction.map(function (r) { return { name: r.name, category: r.category || '' }; }),
          banks: refs.bank.map(function (r) { return r.name; }),
          colors: refs.color.map(function (r) { return r.name; }),
          catalog: catalog, default_status: lk.defaultStatus, grms: grms, today: env.today(),
        };
      }

      // ---- releases
      case 'releases': {
        var branch = myBranch(req.branch);
        var from = req.from ? parseDate(req.from) : '', to = req.to ? parseDate(req.to) : '';
        var q = key(req.q);
        var rows = db.all('releases').filter(function (r) {
          if (branch && r.branch !== branch) return false;
          if (from && r.target_date < from) return false;
          if (to && r.target_date > to) return false;
          if (req.status && r.status !== req.status) return false;
          if (q && [r.client, r.cs_number, r.unit, r.grm, r.variant, r.remarks].join(' ').toLowerCase().indexOf(q) < 0) return false;
          return true;
        });
        rows.sort(function (a, b) { return a.target_date < b.target_date ? -1 : a.target_date > b.target_date ? 1 : a.id - b.id; });
        return rows;
      }
      case 'createRelease': {
        var data = req.release || {};
        data.branch = myBranch(data.branch);
        var rec = cleanRecord(data, new Lookups(refsByKind(db)));
        addRef(db, 'dealer', rec.branch);
        var ts = env.nowIso();
        rec.created_at = ts; rec.created_by = who; rec.updated_at = ts; rec.updated_by = who;
        return db.get('releases', db.insert('releases', rec));
      }
      case 'updateRelease': {
        var existing = db.get('releases', +req.id);
        if (!existing) bad('Not found', 404);
        canTouch(existing);
        var changes = req.changes || {};
        // Two people editing the same release: `base` holds the values this person saw when they
        // opened it (for the fields they changed). If someone else has since changed one of those
        // same fields to something different, stop instead of silently overwriting their work.
        // Changes to *different* fields are simply merged below.
        if (req.base) {
          var clashes = Object.keys(changes).filter(function (k) {
            return FIELDS.indexOf(k) >= 0 && k in req.base
              && key(existing[k]) !== key(req.base[k]) && key(existing[k]) !== key(changes[k]);
          });
          if (clashes.length) {
            bad((existing.updated_by || 'Someone') + ' changed this release while you were editing it', 409,
              { conflict: true, current: existing, fields: clashes });
          }
        }
        var merged = {};
        Object.keys(existing).forEach(function (k) { merged[k] = existing[k]; });
        Object.keys(changes).forEach(function (k) { merged[k] = changes[k]; });
        merged.branch = myBranch(merged.branch);
        var upd = cleanRecord(merged, new Lookups(refsByKind(db)));
        addRef(db, 'dealer', upd.branch);
        upd.updated_at = env.nowIso(); upd.updated_by = who;
        db.update('releases', existing.id, upd);
        return db.get('releases', existing.id);
      }
      case 'deleteRelease': {
        var row = db.get('releases', +req.id);
        if (!row) bad('Not found', 404);
        canTouch(row);
        db.remove('releases', [row.id]);
        return { ok: true };
      }
      case 'importReleases': {
        var lk2 = new Lookups(refsByKind(db));
        var force = user.role === 'dealer' ? myBranch() : null;
        var added = [], errors = [];
        var ts2 = env.nowIso();
        (req.rows || []).forEach(function (raw, i) {
          try {
            var r = {};
            FIELDS.forEach(function (k) { r[k] = raw[k]; });
            if (!str(r.branch)) r.branch = req.branch || '';
            if (force !== null) {
              if (key(r.branch) !== key(force)) bad('belongs to "' + r.branch + '"; you can only import ' + force + ' rows');
              r.branch = force;
            }
            var c = cleanRecord(r, lk2);
            c.created_at = ts2; c.created_by = who; c.updated_at = ts2; c.updated_by = who;
            added.push(c);
          } catch (e) {
            if (!(e instanceof ApiError)) throw e;
            errors.push('Row ' + (raw._row || i + 2) + ': ' + e.message);
          }
        });
        added.forEach(function (c) { addRef(db, 'dealer', c.branch); });
        var newIds = db.insertMany('releases', added);
        return { added: added.length, errors: errors.slice(0, 20), error_count: errors.length,
          rows: newIds.map(function (id) { return db.get('releases', id); }) };
      }

      // ---- reference lists (admin)
      case 'refs': requireRole('admin'); return refsPayload(db);
      case 'addRefs': {
        requireRole('admin');
        if (!REF_KINDS[req.kind]) bad('Unknown reference type');
        var names = String(req.name || '').split(/[\r\n]+/).filter(function (n) { return n.trim(); });
        if (!names.length) bad('Name is required');
        if (req.kind === 'unit' && !str(req.parent)) bad('Pick the variant this unit belongs to');
        if (req.kind === 'grm' && !str(req.parent)) bad('Pick the dealer this GRM works for');
        var cat = str(req.category) || (req.kind === 'status' ? 'open' : '');
        var n = 0;
        names.forEach(function (nm) { if (addRef(db, req.kind, nm, req.parent, cat)) n++; });
        var p = refsPayload(db); p.added = n; p.skipped = names.length - n;
        return p;
      }
      case 'updateRef': {
        requireRole('admin');
        var ref = db.get('refs', +req.id);
        if (!ref) bad('Reference not found');
        var ch = req.changes || {};
        var name = str(ch.name != null ? ch.name : ref.name) || ref.name;
        var parent = str(ch.parent != null ? ch.parent : ref.parent);
        var category = str(ch.category != null ? ch.category : ref.category);
        if (ref.kind === 'status' && STATUS_CATEGORIES.indexOf(category) < 0) bad('Status category must be open, sold or cancelled');
        if (db.all('refs').some(function (r) { return r.kind === ref.kind && r.id !== ref.id && key(r.name) === key(name); })) bad('"' + name + '" already exists');
        db.update('refs', ref.id, { name: name, parent: parent, category: category });
        if (name !== ref.name) { // renames flow through so stats stay together
          var field = REF_KINDS[ref.kind].field, old = ref.name;
          db.updateWhere('releases', function (r) { return r[field] === old; }, function () { var o = {}; o[field] = name; return o; });
          if (ref.kind === 'variant') db.updateWhere('refs', function (r) { return r.kind === 'unit' && r.parent === old; }, function () { return { parent: name }; });
          if (ref.kind === 'dealer') {
            db.updateWhere('users', function (u) { return u.dealer === old; }, function () { return { dealer: name }; });
            db.updateWhere('refs', function (r) { return r.kind === 'grm' && r.parent === old; }, function () { return { parent: name }; });
          }
        }
        return refsPayload(db);
      }
      case 'deleteRef': {
        requireRole('admin');
        var target = db.get('refs', +req.id);
        if (target) {
          var ids = [target.id];
          var childKind = { variant: 'unit', dealer: 'grm' }[target.kind];
          if (childKind) db.all('refs').forEach(function (r) { if (r.kind === childKind && r.parent === target.name) ids.push(r.id); });
          db.remove('refs', ids);
        }
        return refsPayload(db);
      }
      case 'importUsedGrms': {
        requireRole('admin');
        var known = {};
        db.all('refs').forEach(function (r) { if (r.kind === 'grm') known[key(r.name)] = 1; });
        var found = [];
        db.all('releases').forEach(function (r) {
          var k = key(r.grm);
          if (k && k !== '-' && !known[k]) { known[k] = 1; found.push({ name: r.grm, parent: r.branch }); }
        });
        found.sort(function (a, b) { return (a.parent + a.name).localeCompare(b.parent + b.name); });
        var added = 0;
        found.forEach(function (g) { if (addRef(db, 'grm', g.name, g.parent, '')) added++; });
        var pl = refsPayload(db); pl.added = added;
        return pl;
      }
      case 'reorderRefs': {
        requireRole('admin');
        var order = {};
        (req.ids || []).forEach(function (id, i) { order[+id] = i; });
        db.updateWhere('refs', function (r) { return order[r.id] != null && order[r.id] !== r.sort; }, function (r) { return { sort: order[r.id] }; });
        return refsPayload(db);
      }

      // ---- users (admin)
      case 'users': {
        requireRole('admin');
        var list = db.all('users').map(publicUser).sort(function (a, b) { return (a.role + a.username).localeCompare(b.role + b.username); });
        return { users: list, roles: ROLES, dealers: dealerList(db) };
      }
      case 'createUser': requireRole('admin'); return publicUser(db.get('users', createUser(env, db, req.user || {})));
      case 'updateUser': {
        requireRole('admin');
        var t = db.get('users', +req.id);
        if (!t) bad('Not found', 404);
        var c2 = req.changes || {};
        var m2 = { name: c2.name != null ? c2.name : t.name, role: c2.role != null ? c2.role : t.role,
          dealer: c2.dealer != null ? c2.dealer : t.dealer, active: c2.active != null ? c2.active : t.active };
        var rd = checkRole(db, m2);
        var active = (m2.active === 1 || m2.active === true || m2.active === '1' || m2.active === 'true') ? 1 : 0;
        if (t.role === 'admin' && (rd.role !== 'admin' || !active) && !activeAdmins(db, t.id)) bad('Keep at least one active admin');
        var patch = { name: str(m2.name), role: rd.role, dealer: rd.dealer, active: active };
        if (c2.password) {
          var pp = passwordProblem(c2.password);
          if (pp) bad(pp);
          patch.password_hash = hashPassword(env, String(c2.password));
        }
        db.update('users', t.id, patch);
        return publicUser(db.get('users', t.id));
      }
      case 'deleteUser': {
        requireRole('admin');
        var d = db.get('users', +req.id);
        if (!d) bad('Not found', 404);
        if (d.id === user.id) bad('You can\'t delete your own account');
        if (d.role === 'admin' && !activeAdmins(db, d.id)) bad('Keep at least one active admin');
        db.remove('users', [d.id]);
        return { ok: true };
      }
    }
    bad('Unknown action: ' + action, 404);
  }

  /** First-time setup: default reference lists + the first admin account. */
  function setup(env, adminUsername, adminPassword) {
    return env.withLock(function () {
      var db = env.db, out = { refs: false, admin: null };
      if (!db.all('refs').length) { seedDefaults(db); out.refs = true; }
      if (!db.all('users').length) {
        var pw = adminPassword || env.crypto.randomHex(6);
        createUser(env, db, { username: adminUsername || 'admin', name: 'Administrator', role: 'admin', password: pw });
        out.admin = { username: adminUsername || 'admin', password: pw };
      }
      return out;
    });
  }

  /** Values typed straight into the sheet ('patrol', 'w/ payment') -> canonical names, for reading. */
  function canonicalizeRows(db, rows) {
    var lk = new Lookups(refsByKind(db));
    rows.forEach(function (r) {
      Object.keys(REF_KINDS).forEach(function (kind) {
        if (kind !== 'status') r[REF_KINDS[kind].field] = lk.canonical(kind, r[REF_KINDS[kind].field]);
      });
      r.status = lk.status(r.status);
      if (r.target_date) { try { r.target_date = parseDate(r.target_date); } catch (e) { /* leave as typed */ } }
    });
  }

  return {
    REF_KINDS: REF_KINDS, PARENT_KIND: PARENT_KIND, STATUS_CATEGORIES: STATUS_CATEGORIES, ROLES: ROLES, DEFAULT_REFS: DEFAULT_REFS,
    FIELDS: FIELDS, TABLES: TABLES, INT_FIELDS: INT_FIELDS,
    handle: handle, setup: setup, hashPassword: hashPassword, parseDate: parseDate, Lookups: Lookups, cleanRecord: cleanRecord,
    canonicalizeRows: canonicalizeRows, key: key, refsByKind: refsByKind,
  };
})();
