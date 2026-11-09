// Data references: manage the lists that feed the Sales dropdowns and the dashboard logic.
const HELP = {
  dealer: 'Dealer branches that log releases. Deleting a dealer also removes its GRMs from the list.',
  grm: 'GRMs (sales managers), each linked to a dealer. The Sales form only offers the GRMs of that dealer.',
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

// lists that belong to another list: units -> variant, GRMs -> dealer
const PARENT = { unit: { kind: 'variant', label: 'Variant', filter: 'Show units for', all: 'All variants' },
  grm: { kind: 'dealer', label: 'Dealer', filter: 'Show GRMs for', all: 'All dealers' } };
const CHILD = { variant: 'unit', dealer: 'grm' };

let data = null;
let kind = store.get('arpeggio.refKind', 'dealer');

const opts = (pairs, sel) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

const SPEC = { refs: true };
function setData(d) {
  data = d;
  updateCache(SPEC, c => { c.refs = d; });
}
function load() {
  return loadPage(SPEC, d => { data = d.refs; render(); });
}

function items() {
  let list = data.refs[kind];
  if (PARENT[kind] && $('#parentFilter').value) list = list.filter(u => u.parent === $('#parentFilter').value);
  return list;
}

function render() {
  $('#tabs').innerHTML = Object.entries(data.kinds).map(([k, label]) =>
    `<button class="${k === kind ? 'on' : ''}" data-kind="${k}">${esc(label)}<span class="count">${data.refs[k].length}</span></button>`).join('');
  $('#kindTitle').textContent = data.kinds[kind];
  $('#kindHelp').textContent = HELP[kind];

  const P = PARENT[kind];
  const parents = P ? data.refs[P.kind].map(v => [v.name, v.name]) : [];
  $('#parentFilterWrap').hidden = !P;
  $('#addParentWrap').hidden = !P;
  $('#addCategoryWrap').hidden = !CAT_OPTIONS[kind];
  if (P) {
    $('#parentFilterLabel').textContent = P.filter;
    $('#addParentLabel').textContent = P.label;
    const cur = $('#parentFilter').dataset.kind === kind ? $('#parentFilter').value : '';
    $('#parentFilter').dataset.kind = kind;
    $('#parentFilter').innerHTML = opts([['', P.all], ...parents], cur);
    $('#addForm').parent.innerHTML = opts(parents, cur || $('#addForm').parent.value);
  }
  const unlisted = kind === 'grm' ? data.unlisted_grms || 0 : 0;
  $('#grmImport').hidden = !unlisted;
  $('#grmImportText').textContent = `${unlisted} GRM name${unlisted === 1 ? '' : 's'} on existing releases ${unlisted === 1 ? "isn't" : "aren't"} in this list yet.`;
  if (CAT_OPTIONS[kind]) $('#addForm').category.innerHTML = opts(CAT_OPTIONS[kind]);

  const list = items();
  $('#thead').innerHTML = `<tr><th style="width:56px">Order</th><th>Name</th>
    ${P ? `<th>${P.label}</th>` : ''}${CAT_OPTIONS[kind] ? '<th>Category</th>' : ''}
    <th class="num">Used in releases</th><th></th></tr>`;
  $('#list').innerHTML = list.map((it, i) => `
    <tr data-id="${it.id}">
      <td class="nowrap">
        <button type="button" class="icon move" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button><button type="button" class="icon move" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
      </td>
      <td><input class="ref-name" value="${esc(it.name)}" data-orig="${esc(it.name)}" aria-label="Name"></td>
      ${P ? `<td><select class="ref-parent" aria-label="${P.label}">${opts(parents.some(([v]) => v === it.parent) ? parents : [[it.parent, it.parent || '—'], ...parents], it.parent)}</select></td>` : ''}
      ${CAT_OPTIONS[kind] ? `<td><select class="ref-cat" aria-label="Category">${opts(CAT_OPTIONS[kind], it.category || (kind === 'status' ? 'open' : ''))}</select></td>` : ''}
      <td class="num">${it.usage}</td>
      <td><button type="button" class="icon danger del">Delete</button></td>
    </tr>`).join('') || `<tr><td colspan="6" class="empty">Nothing here yet. Add the first one above.</td></tr>`;
}

async function save(id, patch, msg) {
  try {
    setData(await api.call('updateRef', { id: +id, changes: patch }));
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
  if (e.target.classList.contains('ref-parent')) save(id, { parent: e.target.value }, `${PARENT[kind].label} updated`);
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
    if (CHILD[kind]) {
      const n = data.refs[CHILD[kind]].filter(u => u.parent === it.name).length;
      if (n) msg += `\nIts ${n} ${data.kinds[CHILD[kind]]} entr${n === 1 ? 'y' : 'ies'} will be removed too.`;
    }
    if (!confirm(msg)) return;
    setData(await api.call('deleteRef', { id: it.id }));
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
    setData(await api.call('reorderRefs', { ids: full }));
    render();
  }
});

$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const res = await api.call('addRefs', {
      kind, name: f.name.value, parent: f.parent.value, category: CAT_OPTIONS[kind] ? f.category.value : '',
    });
    setData(res);
    f.name.value = '';
    render();
    toast(`Added ${res.added}${res.skipped ? `, ${res.skipped} already existed` : ''}`);
  } catch (err) { toast(err.message); }
});
$('#addForm').name.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.target.value.includes('\n')) { e.preventDefault(); $('#addForm').requestSubmit(); }
});
$('#parentFilter').addEventListener('change', () => {
  $('#addForm').parent.value = $('#parentFilter').value || $('#addForm').parent.value;
  render();
});
$('#grmImportBtn').onclick = async () => {
  try {
    setData(await api.call('importUsedGrms'));
    render();
    toast(`Added ${data.added} GRM${data.added === 1 ? '' : 's'}, each linked to the dealer it was first used at`);
  } catch (err) { toast(err.message); }
};

load().catch(err => toast(err.message));
