// Shared helpers for SVC Sales Tracker pages.
//
// All data goes through api.call(action, params). With an Apps Script URL in config.js the request
// goes to Google; without one, the same backend code (core.js) runs right here in the browser on
// demo data (demo-backend.js).
const CONFIG = window.ARPEGGIO_CONFIG || {};
const API_URL = (CONFIG.apiUrl || '').trim();
const DEMO = !API_URL;
const TOKEN_KEY = 'arpeggio.token';

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

function currentPage() { return (location.pathname.split('/').pop() || 'index.html') + location.search; }

function toLogin() {
  location.href = 'login.html?next=' + encodeURIComponent(currentPage());
  return new Promise(() => {}); // stop the caller while the page navigates away
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => reject(new Error('Could not load ' + src)) });
    document.head.append(el);
  });
}
let demoReady = null;
function demoBackend() {
  demoReady = demoReady || (window.Arpeggio ? Promise.resolve() : loadScript('core.js')).then(() => loadScript('demo-backend.js'));
  return demoReady.then(() => window.DemoBackend);
}

const api = {
  async call(action, params = {}) {
    const req = { ...params, action, token: getToken() };
    let res;
    if (DEMO) {
      res = (await demoBackend()).handle(req);
    } else {
      let r;
      try {
        // text/plain keeps this a "simple" request, which Apps Script accepts from any website
        r = await fetch(API_URL, { method: 'POST', body: JSON.stringify(req), redirect: 'follow' });
      } catch {
        // Apps Script error pages can't be read cross-site, so a crashed script looks like a network failure.
        throw new Error(navigator.onLine === false
          ? 'You\'re offline. Check your internet connection.'
          : 'The SVC Sales Tracker server didn\'t respond properly. If this keeps happening, the admin should check the Apps Script deployment (see DEPLOY.md).');
      }
      res = await r.json().catch(() => ({ error: 'Unexpected reply from the server', status: 502 }));
    }
    if (res && res.error) {
      if (res.status === 401 && action !== 'login' && action !== 'changePassword') { clearCache(); setToken(''); return toLogin(); }
      const e = new Error(res.error);
      e.data = res;
      throw e;
    }
    return res;
  },
};

// ---------- status colors
// Cancelled = red, Sold = green, and the open stages (in their pipeline order from Data references)
// step evenly from red to green through orange and yellow. Interpolated in OKLCH so the steps look
// even to the eye; adding or reordering statuses re-spreads the colors automatically.
const STATUS_RED = [0.575, 0.185, 25];    // ≈ #d03b3b
const STATUS_GREEN = [0.62, 0.19, 142];   // ≈ #0ca30c

function oklchToHex(L, C, H) {
  const toRgb = c => {
    const a = c * Math.cos(H * Math.PI / 180), b = c * Math.sin(H * Math.PI / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  };
  let rgb = toRgb(C);
  for (let c = C; rgb.some(v => v < 0 || v > 1) && c > 0; c -= 0.005) rgb = toRgb(c); // stay inside sRGB
  return '#' + rgb.map(v => {
    v = Math.min(1, Math.max(0, v));
    v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(v * 255).toString(16).padStart(2, '0');
  }).join('');
}

/** t = 0 → red, 1 → green; the middle is lifted a little so yellow reads as yellow, not olive. */
function statusRamp(t) {
  const mix = i => STATUS_RED[i] + (STATUS_GREEN[i] - STATUS_RED[i]) * t;
  return oklchToHex(mix(0) + 0.1 * Math.sin(Math.PI * t), mix(1), mix(2));
}

/** { statusName: '#hex' } for a status list like meta.statuses or the Statuses reference list. */
function statusColors(statuses) {
  const open = statuses.filter(s => (s.category || 'open') === 'open');
  const map = {};
  statuses.forEach(s => {
    const cat = s.category || 'open';
    map[s.name] = statusRamp(cat === 'cancelled' ? 0 : cat === 'sold' ? 1 : (open.indexOf(s) + 1) / (open.length + 1));
  });
  return map;
}

/** Color for one status, with a sensible fallback for values that aren't in the list any more. */
function statusColor(map, name, category) {
  return map[name] || statusRamp(category === 'cancelled' ? 0 : category === 'sold' ? 1 : 0.5);
}

function toCsv(rows) {
  const head = ['BRANCH', 'TARGET RELEASE DATE', 'VARIANT', 'UNIT', 'COLOR', 'CS NUMBER', 'TRANSACTION', 'BANK', 'CLIENT', 'GRM', 'STATUS', 'REMARKS'];
  const q = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = rows.map(r => {
    const [y, m, d] = r.target_date.split('-').map(Number);
    return [r.branch, `${m}/${d}/${y}`, r.variant, r.unit, r.color, r.cs_number, r.transaction_type, r.bank, r.client, r.grm, r.status, r.remarks]
      .map(v => q(String(v ?? ''))).join(',');
  });
  return '﻿' + [head.join(','), ...lines].join('\r\n');
}

function download(filename, text, type = 'text/csv') {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- page shell: navigation + signed-in user menu
const PAGES = [
  { key: 'sales', href: 'sales.html', label: 'Sales entry' },
  { key: 'dashboard', href: 'dashboard.html', label: 'Dashboard' },
  { key: 'references', href: 'references.html', label: 'Data references', admin: true },
  { key: 'users', href: 'users.html', label: 'Users', admin: true },
  { key: 'activity', href: 'activity.html', label: 'Activity', admin: true },
];
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', dealer: 'Dealer staff' };
let me = null;

// ---------- fast page loading
// Every Apps Script request costs ~1.5 s, so each page asks for everything it needs in ONE request
// ('bootstrap'), and shows what it had last time (saved in this browser) while that request runs.
const CACHE_PREFIX = 'arpeggio.cache:';

function cacheKey(spec) {
  const uid = getToken().split('.')[0];
  return `${CACHE_PREFIX}${API_URL || 'demo'}:${uid}:${JSON.stringify(spec)}`;
}
function readCache(spec) {
  try { return JSON.parse(localStorage.getItem(cacheKey(spec)) || 'null'); } catch { return null; }
}
function writeCache(spec, data) {
  try { localStorage.setItem(cacheKey(spec), JSON.stringify(data)); }
  catch { clearCache(); } // storage full: forget old copies rather than fail
}
function clearCache() {
  try { Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX)).forEach(k => localStorage.removeItem(k)); } catch {}
}

async function bootstrap(spec) {
  try {
    return await api.call('bootstrap', spec);
  } catch (err) {
    // the Apps Script hasn't been updated yet: fall back to separate requests
    if (!/Unknown action/.test(err.message)) throw err;
    const [meData, meta] = [await api.call('me'), await api.call('meta')];
    const out = { me: meData, meta };
    if (spec.releases) out.releases = await api.call('releases', spec.releases);
    if (spec.refs) out.refs = await api.call('refs');
    if (spec.users) out.users = await api.call('users');
    return out;
  }
}

/**
 * Load a page's data: calls onData(saved copy, true) straight away if there is one, then
 * onData(fresh data, false) when the server answers. Returns the fresh data.
 */
async function loadPage(spec, onData = () => {}) {
  if (!getToken()) return toLogin();
  const cached = readCache(spec);
  if (cached?.me) {
    applyShell(cached.me);
    try { onData(cached, true); } catch (e) { console.warn('Saved copy could not be shown', e); }
  }
  let fresh;
  try {
    fresh = await bootstrap(spec);
  } catch (err) {
    if (cached) { toast('Showing saved data. ' + err.message); return cached; }
    throw err;
  }
  writeCache(spec, fresh);
  applyShell(fresh.me);
  onData(fresh, false);
  return fresh;
}

/** Keep the saved copy in step after a change, so the next visit opens with it. */
function updateCache(spec, fn) {
  const c = readCache(spec);
  if (c) { fn(c); writeCache(spec, c); }
}

async function initShell() {
  const d = await loadPage({});
  return d.me;
}

function applyShell(meData) {
  me = meData;
  const nav = $('nav.nav[data-page]');
  const page = PAGES.find(p => p.key === nav?.dataset.page);
  if (page?.admin && me.role !== 'admin') { location.href = 'sales.html'; return; }
  if (nav) {
    nav.innerHTML = PAGES.filter(p => !p.admin || me.role === 'admin').map(p =>
      `<a href="${p.href}" class="${p.key === nav.dataset.page ? 'active' : ''}">${p.label}</a>`).join('');
  }
  const bar = $('.topbar');
  if (bar && !$('#userMenu')) {
    bar.insertAdjacentHTML('beforeend', `
      <details class="user-menu" id="userMenu">
        <summary><span class="avatar">${esc((me.name || me.username).slice(0, 1).toUpperCase())}</span>
          ${DEMO ? '<span class="pill demo-pill" title="Data is fake and stays in this browser">Demo</span>' : ''}
          <span class="who"><b>${esc(me.name || me.username)}</b><small>${ROLE_LABEL[me.role]}${me.dealer ? ' · ' + esc(me.dealer) : ''}</small></span></summary>
        <div class="menu">
          <div class="muted" style="font-size:12px;padding:4px 8px">Signed in as ${esc(me.username)}</div>
          <button type="button" id="pwBtn">Change password</button>
          ${DEMO ? '<button type="button" id="demoResetBtn">Reset demo data</button>' : ''}
          <button type="button" id="logoutBtn">Sign out</button>
        </div>
      </details>
      <dialog id="pwDlg"><form id="pwForm">
        <h2>Change password</h2>
        <div class="form-grid" style="grid-template-columns:1fr">
          <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
          <label>New password (8+ characters)<input type="password" name="new" autocomplete="new-password" minlength="8" required></label>
          <label>Repeat new password<input type="password" name="again" autocomplete="new-password" minlength="8" required></label>
        </div>
        <div class="dialog-actions"><button type="button" id="pwCancel">Cancel</button><button class="primary">Save password</button></div>
      </form></dialog>`);
    $('#logoutBtn').onclick = () => { clearCache(); setToken(''); location.href = 'login.html'; };
    if (DEMO) $('#demoResetBtn').onclick = async () => {
      if (!confirm('Throw away all demo changes and start over with fresh demo data?')) return;
      (await demoBackend()).reset(); clearCache(); setToken(''); location.href = 'login.html';
    };
    $('#pwBtn').onclick = () => { $('#userMenu').open = false; $('#pwForm').reset(); $('#pwDlg').showModal(); };
    $('#pwCancel').onclick = () => $('#pwDlg').close();
    $('#pwForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      if (f.new.value !== f.again.value) return toast('New passwords don\'t match');
      try {
        const res = await api.call('changePassword', { current: f.current.value, new: f.new.value });
        setToken(res.token);
        $('#pwDlg').close();
        toast('Password changed');
      } catch (err) { toast(err.message); }
    };
    document.addEventListener('click', e => { if (!e.target.closest('#userMenu')) $('#userMenu').open = false; });
  }
  return me;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d || 1).toLocaleDateString(undefined, opts);
}
const fmtMonth = iso => fmtDate(iso + '-01', { month: 'short', year: '2-digit' });
const fmtPct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
const fmtNum = v => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }));

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toast(msg) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
