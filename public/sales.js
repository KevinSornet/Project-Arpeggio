// Sales side: dealers enter and maintain their release plans.
// All releases this user may see are loaded once (one request, shared with the Dashboard);
// dealer / month / search / column filters then all run here in the browser, instantly.
const SPEC = { releases: {} };
let meta = null;
let pendingMeta = null; // fresh lists that arrived while the release form was open
let allRows = [];     // every release this user may see
let rows = [];        // rows for the chosen dealer + month + search
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
let stColors = {};
const colorOf = s => statusColor(stColors, s, catOf(s));
const needsBank = t => meta.transactions.find(x => x.name === t)?.category === 'bank';
const cellText = (c, r) => (c.fmt ? c.fmt(r) : r[c.key]) || '';

function applyMeta(m) {
  // Never rebuild the form's dropdowns while someone is filling it in: that would reset their choices.
  if (dlg.open && meta) { pendingMeta = m; return; }
  pendingMeta = null;
  meta = m;
  stColors = statusColors(meta.statuses);
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

dlg.addEventListener('close', () => { if (pendingMeta) { applyMeta(pendingMeta); render(); } });

function viewRows() {
  const branch = branchSel.value, month = monthInput.value;
  const q = $('#search').value.trim().toLowerCase();
  return allRows.filter(r => r.branch === branch
    && (!month || r.target_date.slice(0, 7) === month)
    && (!q || [r.client, r.cs_number, r.unit, r.grm, r.variant, r.remarks].join(' ').toLowerCase().includes(q)));
}

function load() {
  if (!branchSel.value) {
    $('#rows').innerHTML = `<tr><td colspan="12" class="empty">Add your dealer under <a href="references.html">Data references</a> to get started.</td></tr>`;
    return;
  }
  store.set('arpeggio.branch', branchSel.value);
  $('#title').textContent = `${branchSel.value} release pipeline`;
  $('#subtitle').textContent = monthInput.value ? fmtDate(monthInput.value + '-01', { month: 'long', year: 'numeric' }) : 'All months';
  rows = viewRows();
  render();
}

/** Put a saved/changed release into the page (and the saved copy) without reloading everything. */
function upsertRow(row) {
  const put = list => { const i = list.findIndex(r => r.id === row.id); i >= 0 ? (list[i] = row) : list.push(row); };
  put(allRows);
  updateCache(SPEC, c => put(c.releases));
}
function removeRow(id) {
  allRows = allRows.filter(r => r.id !== id);
  updateCache(SPEC, c => { c.releases = c.releases.filter(r => r.id !== id); });
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
  if (!meta) return;
  const active = document.activeElement;
  const focusKey = active?.closest?.('#thead') && active.dataset.filter;
  const caret = focusKey && active.selectionStart;
  applyFilters();
  renderHead();
  if (focusKey) {
    const el = $(`#thead [data-filter="${focusKey}"]`);
    el?.focus();
    if (el?.setSelectionRange && caret != null) el.setSelectionRange(caret, caret);
  }

  const counts = {};
  shown.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const filtered = shown.length !== rows.length ? ` of ${rows.length}` : '';
  $('#chips').innerHTML = `<span class="chip">Showing <b>${shown.length}</b>${filtered}</span>` +
    meta.statuses.filter(s => counts[s.name]).map(s =>
      `<span class="chip"><span class="dot" style="background:${colorOf(s.name)}"></span>${esc(s.name)} <b>${counts[s.name]}</b></span>`).join('');


  if (!shown.length) {
    $('#rows').innerHTML = `<tr><td colspan="12" class="empty">${rows.length ? 'No rows match these filters.' : 'No releases for this view yet. Click <b>+ New release</b> to add one.'}</td></tr>`;
    return;
  }
  $('#rows').innerHTML = shown.map(r => `
    <tr class="st" style="--st:${colorOf(r.status)}" data-id="${r.id}">
      ${COLS.map(c => c.key === 'status'
        ? `<td><span class="dot" style="background:${colorOf(r.status)}"></span>
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
  form.bank.disabled = !needsBank(form.transaction_type.value);
  if (form.bank.disabled) form.bank.value = '';
}

const FORM_FIELDS = ['target_date', 'variant', 'unit', 'color', 'cs_number', 'transaction_type', 'bank', 'client', 'grm', 'status', 'remarks'];

function openDialog(rec = null) {
  editing = rec;
  $('#dlgTitle').textContent = rec ? 'Edit release' : 'New release';
  $('#dlgBranch').textContent = branchSel.value;
  $('#delBtn').hidden = !rec;
  $('#conflictBox').hidden = true;
  fillForm(rec || { target_date: meta.today, status: meta.default_status, transaction_type: 'FINANCING', variant: Object.keys(meta.catalog)[0] }, !!rec);
  dlg.showModal();
}

function fillForm(data, existing) {
  form.reset();
  for (const k of ['variant', 'transaction_type', 'status']) {
    const sel = form[k];
    if (data[k] && ![...sel.options].some(o => o.value === data[k])) sel.insertAdjacentHTML('afterbegin', opt(data[k]));
  }
  fillSelect(form.color, meta.colors, data.color);
  fillSelect(form.bank, meta.banks, data.bank);
  const grms = meta.grms[branchSel.value] || [];
  fillSelect(form.grm, grms, data.grm);
  if (!grms.length && !data.grm) form.grm.options[0].textContent = '— none listed for this dealer —';
  for (const el of form.elements) if (el.name && data[el.name] != null && el.name !== 'unit') el.value = data[el.name];
  syncFormLists(existing ? data.unit : (meta.catalog[form.variant.value] || [''])[0]);
  if (existing) form.bank.value = data.bank || '';
}

const FIELD_LABEL = { target_date: 'Target release', cs_number: 'CS number', transaction_type: 'Transaction', grm: 'GRM' };
const fieldLabel = k => FIELD_LABEL[k] || k[0].toUpperCase() + k.slice(1);
const fieldText = (k, v) => (k === 'target_date' && v ? fmtDate(v) : v) || '—';

/** Someone else saved the same field first: show both versions, keep this person's typing. */
function showConflict(data, mine) {
  const cur = data.current;
  upsertRow(cur);
  load();
  editing = cur;                    // the next Save is checked against their version
  fillForm({ ...cur, ...mine }, true); // their latest values + what this person changed
  const when = cur.updated_at ? new Date(cur.updated_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  $('#conflictBox').innerHTML = `<b>${esc(cur.updated_by || 'Someone')} changed this release${when ? ' on ' + esc(when) : ''} while you were editing it.</b>
    <ul>${data.fields.map(k => `<li>${esc(fieldLabel(k))}: theirs <b>${esc(fieldText(k, cur[k]))}</b>, yours <b>${esc(fieldText(k, mine[k]))}</b></li>`).join('')}</ul>
    Your changes are still in the form. Click <b>Save</b> to use yours, or <b>Cancel</b> to keep theirs.`;
  $('#conflictBox').hidden = false;
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
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Saving…';
    let saved, changes = {};
    if (editing) {
      const base = {};
      FORM_FIELDS.forEach(k => {
        if (String(body[k] ?? '') !== String(editing[k] ?? '')) { changes[k] = body[k] ?? ''; base[k] = editing[k] ?? ''; }
      });
      if (!Object.keys(changes).length) { btn.disabled = false; btn.textContent = 'Save'; dlg.close(); toast('No changes to save'); return; }
      try { saved = await api.call('updateRelease', { id: editing.id, changes, base }); }
      catch (err) { if (err.data?.conflict) { showConflict(err.data, changes); return; } throw err; }
      finally { btn.disabled = false; btn.textContent = 'Save'; }
    } else {
      try { saved = await api.call('createRelease', { release: body }); }
      finally { btn.disabled = false; btn.textContent = 'Save'; }
    }
    upsertRow(saved);
    dlg.close();
    toast(editing ? 'Release updated' : 'Release added');
    load();
  } catch (err) { toast('Not saved: ' + err.message); } // the form stays open with everything typed
});

$('#delBtn').onclick = async () => {
  if (!editing || !confirm(`Delete the release for ${editing.client || 'this client'}?`)) return;
  const btn = $('#delBtn');
  btn.disabled = true;
  try {
    await api.call('deleteRelease', { id: editing.id });
  } catch (err) { toast('Not deleted: ' + err.message); return; }
  finally { btn.disabled = false; }
  removeRow(editing.id);
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
  const id = +e.target.closest('tr').dataset.id;
  const before = allRows.find(r => r.id === id);
  const status = e.target.value;
  if (!before || before._saving) { load(); return; } // one change at a time per row
  allRows = allRows.map(r => r.id === id ? { ...r, status, _saving: true } : r);
  load();
  try {
    upsertRow(await api.call('updateRelease', { id, changes: { status }, base: { status: before.status } }));
    toast(`Status set to ${status}`);
  } catch (err) {
    if (err.data?.conflict) {
      const cur = err.data.current;
      upsertRow(cur); // show their newer status
      toast(`${cur.updated_by || 'Someone'} already changed this status to "${cur.status}". Yours wasn't saved.`);
    } else {
      upsertRow(before); // put it back the way it was
      toast(`Status not saved (${err.message}). It's back to ${before.status}.`);
    }
  }
  load();
});

$('#addBtn').onclick = () => branchSel.value ? openDialog() : toast('Add a dealer under Data references first');

// Export exactly what's on screen (after column filters + sort), in the spreadsheet's layout
$('#exportBtn').onclick = e => {
  e.preventDefault();
  download(`${branchSel.value} releases${monthInput.value ? ' ' + monthInput.value : ''}.csv`, toCsv(shown));
};

// ---------- CSV import: parse in the browser, the server validates each row
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const CSV_ALIAS = {
  'branch': 'branch', 'dealer': 'branch', 'target release date': 'target_date', 'target date': 'target_date',
  'release date': 'target_date', 'date': 'target_date', 'variant': 'variant', 'unit': 'unit', 'color': 'color',
  'colour': 'color', 'cs number': 'cs_number', 'cs no': 'cs_number', 'transaction': 'transaction_type',
  'transaction type': 'transaction_type', 'bank': 'bank', 'client': 'client', 'grm': 'grm', 'status': 'status', 'remarks': 'remarks',
};

function parseReleaseCsv(text) {
  const grid = parseCsv(text.replace(/^\ufeff/, ''));
  // sheet exports often have a title row above the real header
  const h = grid.findIndex(r => { const u = r.join(',').toUpperCase(); return u.includes('VARIANT') && u.includes('STATUS'); });
  if (h < 0) return [];
  const keys = grid[h].map(x => CSV_ALIAS[x.trim().toLowerCase().replace(/\s+/g, ' ')]);
  const out = [];
  grid.slice(h + 1).forEach((r, i) => {
    if (!r.some(v => v.trim())) return;
    const rec = { _row: h + i + 2 };
    keys.forEach((k, j) => { if (k) rec[k] = (r[j] || '').trim(); });
    out.push(rec);
  });
  return out;
}

$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = parseReleaseCsv(await file.text());
    if (!parsed.length) throw new Error('No rows found. Is there a header row with VARIANT and STATUS?');
    toast(`Importing ${parsed.length} rows…`);
    const res = await api.call('importReleases', { rows: parsed, branch: branchSel.value });
    toast(`Imported ${res.added} rows${res.error_count ? `, ${res.error_count} skipped` : ''}`);
    if (res.errors.length) console.warn('Import issues:', res.errors);
    if (res.rows) { res.rows.forEach(upsertRow); load(); }
    else await loadPage(SPEC, onData); // older server: reload everything
  } catch (err) { toast(err.message); }
  e.target.value = '';
};

$('#allMonths').onclick = () => { monthInput.value = ''; store.set('arpeggio.allMonths', '1'); load(); };
monthInput.addEventListener('change', () => { store.set('arpeggio.allMonths', monthInput.value ? '' : '1'); load(); });
let searchT;
$('#search').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(load, 250); });
branchSel.addEventListener('change', load);

function onData(d) {
  applyMeta(d.meta);
  if (me.role === 'dealer') branchSel.disabled = true;
  // keep any change still being saved in this tab on screen
  const saving = allRows.filter(r => r._saving);
  allRows = d.releases.map(r => saving.find(x => x.id === r.id) || r);
  load();
}

loadPage(SPEC, onData).catch(err => toast(err.message));
