// Sales side: dealers enter and maintain their release plans.
let meta = null;
let rows = [];        // rows loaded for dealer + month + search
let shown = [];       // rows after column filters + sort
let editing = null;
const filters = {};   // column key -> value
let sort = { key: 'target_date', dir: 1 };

const branchSel = $('#branch');
const monthInput = $('#month');
const form = $('#form');
const dlg = $('#dlg');

// Columns: `filter` is 'select' (pick from values present) or 'text' (contains)
const COLS = [
  { key: 'target_date', label: 'Target release', filter: 'text', fmt: r => fmtDate(r.target_date), cls: 'num' },
  { key: 'variant', label: 'Variant', filter: 'select' },
  { key: 'unit', label: 'Unit', filter: 'select' },
  { key: 'color', label: 'Color', filter: 'select' },
  { key: 'cs_number', label: 'CS number', filter: 'text' },
  { key: 'transaction_type', label: 'Transaction', filter: 'select' },
  { key: 'bank', label: 'Bank', filter: 'select' },
  { key: 'client', label: 'Client', filter: 'text', cls: 'client' },
  { key: 'grm', label: 'GRM', filter: 'select' },
  { key: 'status', label: 'Status', filter: 'select' },
  { key: 'remarks', label: 'Remarks', filter: 'text', cls: 'client' },
];

const opt = (v, label = v, sel = false) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
const catOf = s => (meta.statuses.find(x => x.name === s)?.category) || 'open';
const needsBank = t => meta.transactions.find(x => x.name === t)?.category === 'bank';
const cellText = (c, r) => (c.fmt ? c.fmt(r) : r[c.key]) || '';

async function loadMeta() {
  meta = await api.get('/api/meta');
  const saved = branchSel.value || store.get('arpeggio.branch', '');
  branchSel.innerHTML = meta.branches.map(b => opt(b)).join('');
  if (meta.branches.includes(saved)) branchSel.value = saved;
  form.variant.innerHTML = Object.keys(meta.catalog).map(v => opt(v)).join('');
  form.transaction_type.innerHTML = meta.transactions.map(t => opt(t.name)).join('');
  form.bank.innerHTML = opt('', '—') + meta.banks.map(b => opt(b)).join('');
  form.status.innerHTML = meta.statuses.map(s => opt(s.name)).join('');
  form.color.innerHTML = opt('', '—') + meta.colors.map(c => opt(c)).join('');
  if (!monthInput.value && store.get('arpeggio.allMonths', '') !== '1') monthInput.value = meta.today.slice(0, 7);
}

function serverQuery() {
  const p = new URLSearchParams({ branch: branchSel.value });
  if (monthInput.value) {
    const [y, m] = monthInput.value.split('-').map(Number);
    p.set('from', `${monthInput.value}-01`);
    p.set('to', `${monthInput.value}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`);
  }
  if ($('#search').value.trim()) p.set('q', $('#search').value.trim());
  return p;
}

async function load() {
  if (!branchSel.value) {
    $('#rows').innerHTML = `<tr><td colspan="12" class="empty">Add your dealer under <a href="/references">Data references</a> to get started.</td></tr>`;
    return;
  }
  store.set('arpeggio.branch', branchSel.value);
  $('#title').textContent = `${branchSel.value} release pipeline`;
  $('#subtitle').textContent = monthInput.value ? fmtDate(monthInput.value + '-01', { month: 'long', year: 'numeric' }) : 'All months';
  rows = await api.get(`/api/releases?${serverQuery()}`);
  render();
}

function applyFilters() {
  shown = rows.filter(r => COLS.every(c => {
    const f = filters[c.key];
    if (!f) return true;
    if (c.filter === 'select') return (r[c.key] || '(blank)') === f;
    return cellText(c, r).toLowerCase().includes(f.toLowerCase());
  }));
  const col = COLS.find(c => c.key === sort.key);
  shown.sort((a, b) => String(a[col.key] || '').localeCompare(String(b[col.key] || ''), undefined, { numeric: true }) * sort.dir || a.id - b.id);
}

function renderHead() {
  // distinct values (with counts) for each select filter, from rows matching the *other* filters
  const head = COLS.map(c => {
    const arrow = sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" data-sort="${c.key}" title="Sort by ${c.label}">${c.label}${arrow}</th>`;
  }).join('') + '<th></th>';

  const filt = COLS.map(c => {
    const v = filters[c.key] || '';
    if (c.filter === 'text') {
      return `<th><input data-filter="${c.key}" value="${esc(v)}" placeholder="Filter…" class="${v ? 'on' : ''}" aria-label="Filter ${c.label}"></th>`;
    }
    const others = rows.filter(r => COLS.every(o => {
      const f = filters[o.key];
      if (!f || o.key === c.key) return true;
      return o.filter === 'select' ? (r[o.key] || '(blank)') === f : cellText(o, r).toLowerCase().includes(f.toLowerCase());
    }));
    const counts = {};
    others.forEach(r => { const k = r[c.key] || '(blank)'; counts[k] = (counts[k] || 0) + 1; });
    const values = Object.keys(counts).sort((a, b) => a.localeCompare(b));
    if (v && !values.includes(v)) values.unshift(v);
    return `<th><select data-filter="${c.key}" class="${v ? 'on' : ''}" aria-label="Filter ${c.label}">
      ${opt('', 'All')}${values.map(x => opt(x, `${x} (${counts[x] || 0})`, x === v)).join('')}</select></th>`;
  }).join('') + '<th></th>';

  $('#thead').innerHTML = `<tr>${head}</tr><tr class="filters">${filt}</tr>`;
  $('#clearFilters').hidden = !Object.values(filters).some(Boolean);
}

function render() {
  applyFilters();
  renderHead();

  const counts = {};
  shown.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const filtered = shown.length !== rows.length ? ` of ${rows.length}` : '';
  $('#chips').innerHTML = `<span class="chip">Showing <b>${shown.length}</b>${filtered}</span>` +
    meta.statuses.filter(s => counts[s.name]).map(s =>
      `<span class="chip"><span class="dot ${s.category}"></span>${esc(s.name)} <b>${counts[s.name]}</b></span>`).join('');


  if (!shown.length) {
    $('#rows').innerHTML = `<tr><td colspan="12" class="empty">${rows.length ? 'No rows match these filters.' : 'No releases for this view yet. Click <b>+ New release</b> to add one.'}</td></tr>`;
    return;
  }
  $('#rows').innerHTML = shown.map(r => `
    <tr class="st-${catOf(r.status)}" data-id="${r.id}">
      ${COLS.map(c => c.key === 'status'
        ? `<td><span class="dot ${catOf(r.status)}"></span>
            <select class="status-select" aria-label="Status">${meta.statuses.map(s => opt(s.name, s.name, s.name === r.status)).join('')}
            ${meta.statuses.some(s => s.name === r.status) ? '' : opt(r.status, r.status, true)}</select></td>`
        : `<td class="${c.cls || ''}" title="${esc(cellText(c, r))}">${esc(cellText(c, r))}</td>`).join('')}
      <td><button class="icon edit" title="Edit">Edit</button></td>
    </tr>`).join('');
}

// ---------- header interactions (sort + filters)
$('#thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  sort = { key: th.dataset.sort, dir: sort.key === th.dataset.sort ? -sort.dir : 1 };
  render();
});
$('#thead').addEventListener('change', e => {
  if (e.target.tagName !== 'SELECT') return;
  filters[e.target.dataset.filter] = e.target.value;
  render();
});
let filterT;
$('#thead').addEventListener('input', e => {
  if (e.target.tagName !== 'INPUT') return;
  const key = e.target.dataset.filter, pos = e.target.selectionStart;
  filters[key] = e.target.value;
  clearTimeout(filterT);
  filterT = setTimeout(() => {
    render();
    const el = $(`#thead input[data-filter="${key}"]`);
    el.focus(); el.setSelectionRange(pos, pos);
  }, 200);
});
$('#clearFilters').onclick = () => { Object.keys(filters).forEach(k => delete filters[k]); render(); };

// ---------- form
function fillSelect(sel, values, current) {
  const list = [...values];
  if (current && !list.includes(current)) list.unshift(current); // keep legacy values editable
  sel.innerHTML = opt('', '—') + list.map(v => opt(v, v, v === current)).join('');
}

function syncFormLists(keepUnit) {
  fillSelect(form.unit, meta.catalog[form.variant.value] || [], keepUnit);
  $('#grmList').innerHTML = (meta.grms[branchSel.value] || []).map(g => opt(g)).join('');
  form.bank.disabled = !needsBank(form.transaction_type.value);
  if (form.bank.disabled) form.bank.value = '';
}

function openDialog(rec = null) {
  editing = rec;
  form.reset();
  $('#dlgTitle').textContent = rec ? 'Edit release' : 'New release';
  $('#dlgBranch').textContent = branchSel.value;
  $('#delBtn').hidden = !rec;
  const data = rec || { target_date: meta.today, status: meta.default_status, transaction_type: 'FINANCING', variant: Object.keys(meta.catalog)[0] };
  for (const k of ['variant', 'transaction_type', 'status']) {
    const sel = form[k];
    if (data[k] && ![...sel.options].some(o => o.value === data[k])) sel.insertAdjacentHTML('afterbegin', opt(data[k]));
  }
  fillSelect(form.color, meta.colors, data.color);
  fillSelect(form.bank, meta.banks, data.bank);
  for (const el of form.elements) if (el.name && data[el.name] != null && el.name !== 'unit') el.value = data[el.name];
  syncFormLists(rec ? rec.unit : (meta.catalog[form.variant.value] || [''])[0]);
  if (rec) form.bank.value = rec.bank || '';
  dlg.showModal();
}

form.variant.addEventListener('change', () => syncFormLists((meta.catalog[form.variant.value] || [''])[0]));
form.transaction_type.addEventListener('change', () => syncFormLists(form.unit.value));
$('#cancelBtn').onclick = () => dlg.close();

form.addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  body.branch = branchSel.value;
  if (form.bank.disabled) body.bank = '';
  if (needsBank(body.transaction_type) && !body.bank) { toast(`Pick a bank for ${body.transaction_type}`); return; }
  try {
    if (editing) await api.send('PUT', `/api/releases/${editing.id}`, body);
    else await api.send('POST', '/api/releases', body);
    dlg.close();
    toast(editing ? 'Release updated' : 'Release added');
    meta = await api.get('/api/meta'); // refresh GRM list
    load();
  } catch (err) { toast(err.message); }
});

$('#delBtn').onclick = async () => {
  if (!editing || !confirm(`Delete the release for ${editing.client || 'this client'}?`)) return;
  await api.send('DELETE', `/api/releases/${editing.id}`);
  dlg.close();
  toast('Release deleted');
  load();
};

$('#rows').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr && e.target.closest('.edit')) openDialog(rows.find(r => r.id == tr.dataset.id));
});
$('#rows').addEventListener('change', async e => {
  if (!e.target.classList.contains('status-select')) return;
  const id = e.target.closest('tr').dataset.id;
  try {
    await api.send('PUT', `/api/releases/${id}`, { status: e.target.value });
    toast(`Status set to ${e.target.value}`);
    load();
  } catch (err) { toast(err.message); }
});

$('#addBtn').onclick = () => branchSel.value ? openDialog() : toast('Add a dealer under Data references first');

// Export exactly what's on screen (after column filters + sort), in the spreadsheet's layout
$('#exportBtn').onclick = e => {
  e.preventDefault();
  const head = ['BRANCH', 'TARGET RELEASE DATE', 'VARIANT', 'UNIT', 'COLOR', 'CS NUMBER', 'TRANSACTION', 'BANK', 'CLIENT', 'GRM', 'STATUS', 'REMARKS'];
  const q = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = shown.map(r => {
    const [y, m, d] = r.target_date.split('-').map(Number);
    return [r.branch, `${m}/${d}/${y}`, r.variant, r.unit, r.color, r.cs_number, r.transaction_type, r.bank, r.client, r.grm, r.status, r.remarks]
      .map(v => q(String(v ?? ''))).join(',');
  });
  const blob = new Blob(['\ufeff' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${branchSel.value} releases${monthInput.value ? ' ' + monthInput.value : ''}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
};

$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const res = await api.send('POST', `/api/import?branch=${encodeURIComponent(branchSel.value)}`, await file.text(), true);
    toast(`Imported ${res.added} rows${res.error_count ? `, ${res.error_count} skipped` : ''}`);
    if (res.errors.length) console.warn('Import issues:', res.errors);
    await loadMeta();
    load();
  } catch (err) { toast(err.message); }
  e.target.value = '';
};

$('#allMonths').onclick = () => { monthInput.value = ''; store.set('arpeggio.allMonths', '1'); load(); };
monthInput.addEventListener('change', () => { store.set('arpeggio.allMonths', monthInput.value ? '' : '1'); load(); });
let searchT;
$('#search').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(load, 250); });
branchSel.addEventListener('change', load);

initShell()
  .then(() => { if (me.role === 'dealer') branchSel.disabled = true; })
  .then(loadMeta).then(load).catch(err => toast(err.message));
