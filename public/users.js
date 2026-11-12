// Admin page: create and manage sign-in accounts.
let data = null;
let editing = null;
const form = $('#form');

const opt = (v, l = v, sel = false) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(l)}</option>`;

const SPEC = { users: true };
function load() {
  return loadPage(SPEC, d => { data = d.users; render(); });
}
function putUser(u, remove = false) {
  const apply = list => {
    const i = list.findIndex(x => x.id === u.id);
    if (remove) { if (i >= 0) list.splice(i, 1); }
    else if (i >= 0) list[i] = u; else list.push(u);
  };
  apply(data.users);
  updateCache(SPEC, c => apply(c.users.users));
  render();
}

function render() {
  const counts = { admin: 0, manager: 0, dealer: 0 };
  data.users.filter(u => u.active).forEach(u => counts[u.role]++);
  $('#roleCards').innerHTML = Object.entries(data.roles).map(([r, desc]) => {
    const [title, rest] = desc.split(' — ');
    return `<div class="card kpi"><div class="label">${esc(title)}</div><div class="value">${counts[r]}</div><div class="foot">${esc(rest)}</div></div>`;
  }).join('');

  $('#list').innerHTML = data.users.map(u => `
    <tr data-id="${u.id}" class="${u.active ? '' : 'inactive'}">
      <td><b>${esc(u.username)}</b>${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td>
      <td>${esc(u.name)}</td>
      <td><span class="role-badge ${u.role}">${ROLE_LABEL[u.role]}</span></td>
      <td>${esc(u.dealer) || '<span class="muted">All dealers</span>'}</td>
      <td>${u.active ? 'Yes' : 'Disabled'}</td>
      <td title="${esc(u.last_login)}">${ago(u.last_login)}</td>
      <td title="${esc(u.last_seen)}">${ago(u.last_seen)}</td>
      <td class="nowrap">
        <button class="icon edit">Edit</button>
        <button class="icon toggle">${u.active ? 'Disable' : 'Enable'}</button>
        ${u.id === me.id ? '' : '<button class="icon danger del">Delete</button>'}
      </td>
    </tr>`).join('');
}

/** "3 h ago" style time, or "never" */
function ago(iso) {
  if (!iso) return '<span class="muted">never</span>';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (isNaN(mins)) return esc(iso);
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
}

function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const buf = crypto.getRandomValues(new Uint32Array(12));
  return [...buf].map(n => chars[n % chars.length]).join('');
}

function syncDealer() {
  form.dealer.disabled = form.role.value !== 'dealer';
  if (form.dealer.disabled) form.dealer.value = '';
}

function openDialog(u = null) {
  editing = u;
  form.reset();
  $('#dlgTitle').textContent = u ? `Edit ${u.username}` : 'Add user';
  form.username.disabled = !!u;
  form.role.innerHTML = Object.keys(data.roles).map(r => opt(r, ROLE_LABEL[r])).join('');
  form.dealer.innerHTML = opt('', '— pick a dealer —') + data.dealers.map(d => opt(d)).join('');
  $('#pwLabel').firstChild.textContent = u ? 'New password (leave blank to keep the current one)' : 'Password (8+ characters, share it with them privately)';
  form.password.required = !u;
  if (u) {
    form.username.value = u.username;
    form.name.value = u.name;
    form.role.value = u.role;
    form.dealer.value = u.dealer;
  } else {
    form.role.value = 'dealer';
    form.password.value = genPassword();
  }
  syncDealer();
  $('#dlg').showModal();
}

form.role.addEventListener('change', syncDealer);
$('#genPw').onclick = () => { form.password.value = genPassword(); };
$('#cancelBtn').onclick = () => $('#dlg').close();
$('#addBtn').onclick = () => openDialog();

form.addEventListener('submit', async e => {
  e.preventDefault();
  const body = { name: form.name.value, role: form.role.value, dealer: form.dealer.value };
  if (form.password.value) body.password = form.password.value;
  try {
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    let saved;
    try {
      saved = editing ? await api.call('updateUser', { id: editing.id, changes: body })
        : await api.call('createUser', { user: { ...body, username: form.username.value } });
    } finally { btn.disabled = false; }
    const pw = form.password.value, who = editing ? editing.username : form.username.value.trim().toLowerCase();
    $('#dlg').close();
    if (pw) {
      $('#notice').hidden = false;
      $('#notice').innerHTML = `<div class="card-head" style="margin:0"><div>
          <b>Password for ${esc(who)}:</b> <code id="pwShow" style="font-size:15px">${esc(pw)}</code>
          <div class="muted" style="font-size:12px">Send it to them privately (not in a group chat). They can change it after signing in. It won't be shown again.</div></div>
          <span style="display:flex;gap:8px"><button type="button" id="copyPw">Copy</button><button type="button" id="hideNotice">Done</button></span></div>`;
      $('#copyPw').onclick = () => navigator.clipboard.writeText(pw).then(() => toast('Copied'), () => toast('Select and copy it manually'));
      $('#hideNotice').onclick = () => { $('#notice').hidden = true; $('#notice').innerHTML = ''; };
    } else toast('Saved');
    putUser(saved);
  } catch (err) { toast(err.message); }
});

$('#list').addEventListener('click', async e => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const u = data.users.find(x => x.id == tr.dataset.id);
  try {
    if (e.target.closest('.edit')) openDialog(u);
    if (e.target.closest('.toggle')) {
      putUser(await api.call('updateUser', { id: u.id, changes: { active: u.active ? 0 : 1 } }));
      toast(u.active ? `${u.username} can no longer sign in` : `${u.username} re-enabled`);
    }
    if (e.target.closest('.del')) {
      if (!confirm(`Delete ${u.username}? Their past changes keep their username.`)) return;
      await api.call('deleteUser', { id: u.id });
      putUser(u, true);
      toast('User deleted');
    }
  } catch (err) { toast(err.message); }
});

load().catch(err => toast(err.message));
