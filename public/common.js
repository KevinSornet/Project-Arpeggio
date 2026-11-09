// Shared helpers for Arpeggio pages.
function toLogin() {
  location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
  return new Promise(() => {}); // stop the caller while the page navigates away
}

const api = {
  async get(path) {
    const r = await fetch(path);
    if (r.status === 401) return toLogin();
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, path, body, raw = false) {
    const r = await fetch(path, {
      method,
      headers: raw ? { 'Content-Type': 'text/csv' } : { 'Content-Type': 'application/json' },
      body: raw ? body : JSON.stringify(body),
    });
    if (r.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/me/password')) return toLogin();
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

// ---------- page shell: navigation + signed-in user menu
const PAGES = [
  { key: 'sales', href: '/sales', label: 'Sales entry' },
  { key: 'dashboard', href: '/dashboard', label: 'Dashboard' },
  { key: 'references', href: '/references', label: 'Data references', admin: true },
  { key: 'users', href: '/users', label: 'Users', admin: true },
];
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', dealer: 'Dealer staff' };
let me = null;

async function initShell() {
  me = await api.get('/api/me');
  const nav = $('nav.nav[data-page]');
  if (nav) {
    nav.innerHTML = PAGES.filter(p => !p.admin || me.role === 'admin').map(p =>
      `<a href="${p.href}" class="${p.key === nav.dataset.page ? 'active' : ''}">${p.label}</a>`).join('');
  }
  const bar = $('.topbar');
  if (bar && !$('#userMenu')) {
    bar.insertAdjacentHTML('beforeend', `
      <details class="user-menu" id="userMenu">
        <summary><span class="avatar">${esc((me.name || me.username).slice(0, 1).toUpperCase())}</span>
          <span class="who"><b>${esc(me.name || me.username)}</b><small>${ROLE_LABEL[me.role]}${me.dealer ? ' · ' + esc(me.dealer) : ''}</small></span></summary>
        <div class="menu">
          <div class="muted" style="font-size:12px;padding:4px 8px">Signed in as ${esc(me.username)}</div>
          <button type="button" id="pwBtn">Change password</button>
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
    $('#logoutBtn').onclick = async () => { await api.send('POST', '/api/logout', {}); location.href = '/login'; };
    $('#pwBtn').onclick = () => { $('#userMenu').open = false; $('#pwForm').reset(); $('#pwDlg').showModal(); };
    $('#pwCancel').onclick = () => $('#pwDlg').close();
    $('#pwForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      if (f.new.value !== f.again.value) return toast('New passwords don\'t match');
      try {
        await api.send('POST', '/api/me/password', { current: f.current.value, new: f.new.value });
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
