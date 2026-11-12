// Admin page: who signed in and what they changed (the Activity tab of the Google Sheet).
const ACTION = {
  login: { label: 'Signed in', cls: 'muted' },
  login_failed: { label: 'Failed sign-in', cls: 'bad' },
  password_changed: { label: 'Changed password', cls: 'muted' },
  release_added: { label: 'Added release', cls: 'good' },
  release_edited: { label: 'Edited release', cls: '' },
  release_deleted: { label: 'Deleted release', cls: 'bad' },
  import: { label: 'Imported CSV', cls: 'good' },
  list_added: { label: 'Data references: added', cls: '' },
  list_changed: { label: 'Data references: changed', cls: '' },
  list_removed: { label: 'Data references: removed', cls: 'bad' },
  user_added: { label: 'User added', cls: '' },
  user_changed: { label: 'User changed', cls: '' },
  user_deleted: { label: 'User deleted', cls: 'bad' },
};
const CHANGE_ACTIONS = new Set(['release_added', 'release_edited', 'release_deleted', 'import']);
const actionLabel = a => ACTION[a]?.label || a;

let data = { rows: [], users: [], dealers: [], total: 0 };
let shown = [];
let days = +store.get('arpeggio.activityDays', '7');

function isoDay(d) { return isoDate(d); }
function range() { return { from: $('#from').value, to: $('#to').value }; }

/** "Nov 12, 2:14 PM" + "3 h ago" */
function when(iso) {
  if (!iso) return '<span class="muted">never</span>';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  const mins = Math.round((Date.now() - d) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  return `${esc(d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} <span class="muted">· ${ago}</span>`;
}

function setPreset(n) {
  days = n;
  store.set('arpeggio.activityDays', String(n));
  const to = new Date(), from = new Date();
  from.setDate(from.getDate() - (n - 1));
  $('#from').value = isoDay(from);
  $('#to').value = isoDay(to);
  $$('#presets button').forEach(b => b.classList.toggle('on', +b.dataset.p === n));
}

function fillFilters() {
  const keep = id => $(id).value;
  const person = keep('#person'), dealer = keep('#dealer'), kind = keep('#kind');
  const names = [...new Set([...data.users.map(u => u.username), ...data.rows.map(r => r.username)])].filter(Boolean).sort();
  $('#person').innerHTML = '<option value="">Everyone</option>' + names.map(n => `<option>${esc(n)}</option>`).join('');
  $('#dealer').innerHTML = '<option value="">All dealers</option>' + data.dealers.map(d => `<option>${esc(d)}</option>`).join('');
  $('#kind').innerHTML = '<option value="">Everything</option><option value="changes">Release changes only</option>'
    + Object.entries(ACTION).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#person').value = names.includes(person) ? person : '';
  $('#dealer').value = data.dealers.includes(dealer) ? dealer : '';
  $('#kind').value = kind;
}

function render() {
  const person = $('#person').value, dealer = $('#dealer').value, kind = $('#kind').value;
  const q = $('#search').value.trim().toLowerCase();
  shown = data.rows.filter(r => (!person || r.username === person)
    && (!dealer || r.dealer === dealer)
    && (!kind || (kind === 'changes' ? CHANGE_ACTIONS.has(r.action) : r.action === kind))
    && (!q || `${r.details} ${r.release_id} ${r.username}`.toLowerCase().includes(q)));

  // last seen per person (from the Users tab) + how many release changes they made in this range
  const changes = {};
  data.rows.forEach(r => { if (CHANGE_ACTIONS.has(r.action)) changes[r.username] = (changes[r.username] || 0) + 1; });
  const people = data.users
    .filter(u => (!person || u.username === person) && (!dealer || u.dealer === dealer))
    .sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || '') || a.username.localeCompare(b.username));
  $('#people').innerHTML = people.map(u => `
    <tr class="${u.active ? '' : 'inactive'}">
      <td><b>${esc(u.username)}</b>${u.name ? ` <span class="muted">${esc(u.name)}</span>` : ''}${u.active ? '' : ' <span class="muted">(disabled)</span>'}</td>
      <td>${ROLE_LABEL[u.role] || esc(u.role)}</td>
      <td>${esc(u.dealer) || '<span class="muted">All dealers</span>'}</td>
      <td>${when(u.last_login)}</td>
      <td>${when(u.last_seen)}</td>
      <td class="num">${changes[u.username] || 0}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No one matches these filters.</td></tr>';

  const more = data.total > data.rows.length ? ` (newest ${data.rows.length} of ${data.total} loaded; pick a shorter range to see older ones)` : '';
  $('#count').textContent = `${shown.length} event${shown.length === 1 ? '' : 's'}${more}`;
  $('#events').innerHTML = shown.slice(0, 1000).map(r => `
    <tr>
      <td class="nowrap">${when(r.at)}</td>
      <td><b>${esc(r.username)}</b></td>
      <td>${esc(r.dealer)}</td>
      <td><span class="act ${ACTION[r.action]?.cls || ''}">${esc(actionLabel(r.action))}</span></td>
      <td class="num">${r.release_id ? '#' + esc(r.release_id) : ''}</td>
      <td class="details">${esc(r.details)}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">Nothing happened in this range.</td></tr>';
  if (shown.length > 1000) $('#events').insertAdjacentHTML('beforeend', `<tr><td colspan="6" class="empty">Showing the newest 1,000. Narrow the filters or export to see all ${shown.length}.</td></tr>`);
}

async function fetchRange() {
  try {
    data = await api.call('activity', range());
    fillFilters();
    render();
  } catch (err) { toast(err.message); }
}

$$('#presets button').forEach(b => b.onclick = () => { setPreset(+b.dataset.p); fetchRange(); });
['#from', '#to'].forEach(id => $(id).addEventListener('change', () => { $$('#presets button').forEach(b => b.classList.remove('on')); fetchRange(); }));
['#person', '#dealer', '#kind'].forEach(id => $(id).addEventListener('change', render));
let searchT;
$('#search').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(render, 200); });

$('#exportBtn').onclick = () => {
  const q = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = shown.map(r => [r.at, r.username, r.dealer, actionLabel(r.action), r.release_id, r.details].map(v => q(String(v ?? ''))).join(','));
  download(`activity ${$('#from').value} to ${$('#to').value}.csv`, '﻿' + ['TIME,USERNAME,DEALER,WHAT,RELEASE ID,DETAILS', ...lines].join('\r\n'));
};

setPreset([1, 7, 30, 90].includes(days) ? days : 7);
// one request: the page shell + this date range of the log
loadPage({ activity: range() }, d => {
  if (!d.activity) return; // older Apps Script without the activity log
  data = d.activity;
  fillFilters();
  render();
}).then(d => {
  if (d && !d.activity) fetchRange(); // fallback: ask separately
}).catch(err => toast(err.message));
