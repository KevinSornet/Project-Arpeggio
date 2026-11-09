// Data references: manage the lists that feed the Sales dropdowns and the dashboard logic.
const HELP = {
  dealer: 'Dealer branches that log releases.',
  variant: 'Model lines. Deleting a variant also removes its units from the list.',
  unit: 'Specific units, each linked to a variant. The Sales form only offers units of the chosen variant.',
  color: 'Paint colors offered on the Sales form.',
  transaction: 'Payment types. "Needs bank" ones ask for a bank and count as financed on the dashboard.',
  status: 'Release statuses, in pipeline order. Category drives the dashboard: Open = still in pipeline, Sold = counted as a sale, Cancelled = lost deal.',
  bank: 'Banks offered for financing and bank PO deals.',
};
const CAT_OPTIONS = {
  status: [['open', 'Open (pipeline)'], ['sold', 'Sold'], ['cancelled', 'Cancelled']],
  transaction: [['', 'No bank'], ['bank', 'Needs bank']],
};

let data = null;
let kind = store.get('arpeggio.refKind', 'dealer');

const opts = (pairs, sel) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

async function load() {
  data = await api.get('/api/refs');
  render();
}

function items() {
  let list = data.refs[kind];
  if (kind === 'unit' && $('#variantFilter').value) list = list.filter(u => u.parent === $('#variantFilter').value);
  return list;
}

function render() {
  $('#tabs').innerHTML = Object.entries(data.kinds).map(([k, label]) =>
    `<button class="${k === kind ? 'on' : ''}" data-kind="${k}">${esc(label)}<span class="count">${data.refs[k].length}</span></button>`).join('');
  $('#kindTitle').textContent = data.kinds[kind];
  $('#kindHelp').textContent = HELP[kind];

  const variants = data.refs.variant.map(v => [v.name, v.name]);
  $('#variantFilterWrap').hidden = kind !== 'unit';
  $('#addParentWrap').hidden = kind !== 'unit';
  $('#addCategoryWrap').hidden = !CAT_OPTIONS[kind];
  if (kind === 'unit') {
    const cur = $('#variantFilter').value;
    $('#variantFilter').innerHTML = opts([['', 'All variants'], ...variants], cur);
    $('#addForm').parent.innerHTML = opts(variants, cur || $('#addForm').parent.value);
  }
  if (CAT_OPTIONS[kind]) $('#addForm').category.innerHTML = opts(CAT_OPTIONS[kind]);

  const list = items();
  $('#thead').innerHTML = `<tr><th style="width:56px">Order</th><th>Name</th>
    ${kind === 'unit' ? '<th>Variant</th>' : ''}${CAT_OPTIONS[kind] ? '<th>Category</th>' : ''}
    <th class="num">Used in releases</th><th></th></tr>`;
  $('#list').innerHTML = list.map((it, i) => `
    <tr data-id="${it.id}">
      <td class="nowrap">
        <button type="button" class="icon move" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button><button type="button" class="icon move" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
      </td>
      <td><input class="ref-name" value="${esc(it.name)}" data-orig="${esc(it.name)}" aria-label="Name"></td>
      ${kind === 'unit' ? `<td><select class="ref-parent" aria-label="Variant">${opts(variants, it.parent)}</select></td>` : ''}
      ${CAT_OPTIONS[kind] ? `<td><select class="ref-cat" aria-label="Category">${opts(CAT_OPTIONS[kind], it.category || (kind === 'status' ? 'open' : ''))}</select></td>` : ''}
      <td class="num">${it.usage}</td>
      <td><button type="button" class="icon danger del">Delete</button></td>
    </tr>`).join('') || `<tr><td colspan="6" class="empty">Nothing here yet. Add the first one above.</td></tr>`;
}

async function save(id, patch, msg) {
  try {
    data = await api.send('PUT', `/api/refs/${id}`, patch);
    render();
    if (msg) toast(msg);
  } catch (err) { toast(err.message); render(); }
}

$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-kind]');
  if (!b) return;
  kind = b.dataset.kind;
  store.set('arpeggio.refKind', kind);
  $('#addForm').reset();
  render();
});

$('#list').addEventListener('change', e => {
  const id = e.target.closest('tr')?.dataset.id;
  if (!id) return;
  if (e.target.classList.contains('ref-name')) {
    const name = e.target.value.trim(), orig = e.target.dataset.orig;
    if (!name || name === orig) { e.target.value = orig; return; }
    const it = data.refs[kind].find(x => x.id == id);
    if (it.usage && !confirm(`Rename "${orig}" to "${name}"?\nThis also updates ${it.usage} existing release(s).`)) { e.target.value = orig; return; }
    save(id, { name }, 'Renamed');
  }
  if (e.target.classList.contains('ref-parent')) save(id, { parent: e.target.value }, 'Variant updated');
  if (e.target.classList.contains('ref-cat')) save(id, { category: e.target.value }, 'Category updated');
});
$('#list').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('ref-name')) e.target.blur();
});

$('#list').addEventListener('click', async e => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const it = data.refs[kind].find(x => x.id == tr.dataset.id);
  if (e.target.closest('.del')) {
    let msg = `Remove "${it.name}" from the ${data.kinds[kind]} list?`;
    if (it.usage) msg += `\n${it.usage} existing release(s) keep this value; it just won't be offered for new ones.`;
    if (kind === 'variant') {
      const n = data.refs.unit.filter(u => u.parent === it.name).length;
      if (n) msg += `\nIts ${n} unit(s) will be removed from the Units list too.`;
    }
    if (!confirm(msg)) return;
    data = await api.send('DELETE', `/api/refs/${it.id}`);
    render();
    toast('Removed');
  }
  const mv = e.target.closest('.move');
  if (mv) {
    // reorder within the full list for this kind (not just the filtered view)
    const full = data.refs[kind].map(x => x.id);
    const view = items().map(x => x.id);
    const vi = view.indexOf(it.id), other = view[vi + Number(mv.dataset.dir)];
    if (other == null) return;
    const a = full.indexOf(it.id), b = full.indexOf(other);
    [full[a], full[b]] = [full[b], full[a]];
    data = await api.send('POST', '/api/refs/reorder', { ids: full });
    render();
  }
});

$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const res = await api.send('POST', '/api/refs', {
      kind, name: f.name.value, parent: f.parent.value, category: CAT_OPTIONS[kind] ? f.category.value : '',
    });
    data = res;
    f.name.value = '';
    render();
    toast(`Added ${res.added}${res.skipped ? `, ${res.skipped} already existed` : ''}`);
  } catch (err) { toast(err.message); }
});
$('#addForm').name.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.target.value.includes('\n')) { e.preventDefault(); $('#addForm').requestSubmit(); }
});
$('#variantFilter').addEventListener('change', () => {
  $('#addForm').parent.value = $('#variantFilter').value || $('#addForm').parent.value;
  render();
});

initShell().then(load).catch(err => toast(err.message));
