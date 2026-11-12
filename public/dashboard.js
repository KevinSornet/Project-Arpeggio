// Dashboard side: compiles every branch's release plans into stats + forecasts.
const charts = {};
let today = null;
let preset = store.get('arpeggio.preset', 'month');

function rangeFor(p) {
  const t = new Date(today + 'T00:00:00');
  const y = t.getFullYear(), m = t.getMonth();
  switch (p) {
    case 'month': return [new Date(y, m, 1), new Date(y, m + 1, 0)];
    case '3m': return [new Date(y, m - 2, 1), new Date(y, m + 1, 0)];
    case 'ytd': return [new Date(y, 0, 1), new Date(y, m + 1, 0)];
    case '12m': return [new Date(y, m - 11, 1), new Date(y, m + 1, 0)];
    default: return [null, null];
  }
}

function applyPreset(p) {
  if (!today) { // data not here yet: remember the choice, onData applies it
    preset = p;
    $$('#presets button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
    return;
  }
  preset = p;
  store.set('arpeggio.preset', p);
  const [f, t] = rangeFor(p);
  $('#from').value = f ? isoDate(f) : '';
  $('#to').value = t ? isoDate(t) : '';
  $$('#presets button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  load();
}

// ---------- chart styling (palette from the validated reference instance)
function theme() {
  return {
    s1: cssVar('--series-1'), s2: cssVar('--series-2'), s3: cssVar('--series-3'), s4: cssVar('--series-4'), ink: cssVar('--ink'), ink2: cssVar('--ink-2'),
    muted: cssVar('--muted'), grid: cssVar('--grid'), axis: cssVar('--axis'), surface: cssVar('--surface'),
  };
}

function baseOptions(c, { horizontal = false, legend = false, stacked = false } = {}) {
  const valueAxis = {
    beginAtZero: true, stacked, grid: { color: c.grid, drawTicks: false }, border: { display: false },
    ticks: { color: c.muted, precision: 0, padding: 6, font: { size: 11 } },
  };
  const catAxis = {
    stacked, grid: { display: false }, border: { color: c.axis },
    ticks: { color: c.ink2, font: { size: 11 }, autoSkip: true, maxRotation: 0 },
  };
  return {
    responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: 'index', intersect: false },
    animation: { duration: 250 },
    plugins: {
      legend: { display: legend, position: 'top', align: 'end', labels: { color: c.ink2, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2, font: { size: 11 } } },
      tooltip: { backgroundColor: c.ink, titleColor: c.surface, bodyColor: c.surface, padding: 10, cornerRadius: 8, displayColors: legend, boxPadding: 4 },
    },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
}

function draw(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart($('#' + id), config);
}

function barChart(id, items, { horizontal = false, label = 'Units sold' } = {}) {
  const c = theme();
  draw(id, {
    type: 'bar',
    data: {
      labels: items.map(i => i.label),
      datasets: [{ label, data: items.map(i => i.value), backgroundColor: c.s1, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28 }],
    },
    options: baseOptions(c, { horizontal }),
  });
}

// ---------- render
function kpiTile(label, value, foot, hero = false) {
  return `<div class="card kpi${hero ? ' hero' : ''}"><div class="label">${label}</div><div class="value">${value}</div><div class="foot">${foot}</div></div>`;
}

function render(s) {
  const k = s.kpi, proj = k.projection;
  const curMonthName = fmtDate(proj.month + '-01', { month: 'long' });
  $('#kpis').innerHTML = [
    kpiTile(`Projected ${curMonthName} sales`, fmtNum(proj.value),
      `Likely ${fmtNum(proj.low)}–${fmtNum(proj.high)} · ${fmtNum(k.sold_mtd)} sold so far`, true),
    kpiTile('Units sold', fmtNum(k.sold), `${fmtNum(k.entries)} releases in range`),
    kpiTile('Open pipeline', fmtNum(k.open), `≈ ${fmtNum(k.expected_from_open)} expected to close${k.overdue ? ` · ${k.overdue} overdue` : ''}`),
    kpiTile('Cancellation rate', fmtPct(k.cancel_rate), `${fmtNum(k.cancelled)} cancelled of ${fmtNum(k.sold + k.cancelled)} closed`),
    kpiTile('Financed share', fmtPct(k.financing_share), 'Financing + bank PO of units sold'),
  ].join('');

  // trend + forecast
  const c = theme();
  const hist = s.history.slice(0, -1); // complete months
  const fc = s.forecast;
  const labels = [...hist.map(h => h.month), ...fc.map(f => f.month)];
  const n = hist.length;
  const pad = arr => [...Array(n - 1).fill(null), hist.at(-1)?.sold ?? null, ...arr];
  draw('cTrend', {
    type: 'line',
    data: {
      labels: labels.map(fmtMonth),
      datasets: [
        { label: 'Actual', data: [...hist.map(h => h.sold), ...fc.map(() => null)], borderColor: c.s1, backgroundColor: c.s1, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, tension: .25 },
        { label: 'Forecast', data: pad(fc.map(f => f.value)), borderColor: c.s1, backgroundColor: c.s1, borderDash: [6, 5], borderWidth: 2, pointRadius: 3, pointStyle: 'circle', pointBackgroundColor: c.surface, tension: .25 },
        { label: 'Likely high', data: pad(fc.map(f => f.high)), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: c.s1 + '22' },
        { label: 'Likely low', data: pad(fc.map(f => f.low)), borderWidth: 0, pointRadius: 0, fill: false },
      ],
    },
    options: {
      ...baseOptions(c, { legend: true }),
      plugins: {
        ...baseOptions(c, { legend: true }).plugins,
        legend: { ...baseOptions(c, { legend: true }).plugins.legend, labels: { ...baseOptions(c, { legend: true }).plugins.legend.labels, filter: i => i.text === 'Actual' || i.text === 'Forecast' } },
        tooltip: {
          ...baseOptions(c, { legend: true }).plugins.tooltip,
          filter: (item) => item.raw != null && !(item.dataset.label === 'Forecast' && item.dataIndex < n),
          callbacks: { label: i => ` ${i.dataset.label}: ${fmtNum(i.raw)}` },
        },
      },
    },
  });

  $('#tForecast').innerHTML = `
    <thead><tr><th>Month</th><th class="num">Forecast</th><th class="num">Range</th><th class="num">Booked*</th></tr></thead>
    <tbody>${fc.map(f => `<tr><td>${fmtDate(f.month + '-01', { month: 'short', year: 'numeric' })}</td>
      <td class="num"><b>${fmtNum(f.value)}</b></td><td class="num ink2">${fmtNum(f.low)}–${fmtNum(f.high)}</td>
      <td class="num ink2">${fmtNum(f.pipeline)}</td></tr>`).join('')}</tbody>`;
  $('#forecastNote').innerHTML = `*Booked = open release plans already entered by dealers, weighted by each transaction type's historical close rate.
    Forecast blends that pipeline with the sales trend (Holt's smoothing), adjusted for last year's seasonality.`;

  barChart('cBranch', s.by_branch);
  barChart('cVariant', s.by_variant, { horizontal: true });
  barChart('cTxn', s.by_transaction, { horizontal: true });
  barChart('cBank', s.by_bank, { horizontal: true });

  // one stacked segment per open status, in pipeline order; colors follow the status, not its rank
  const stc = statusColors(meta.statuses); // same red → green scale as the Sales table
  draw('cWeekly', {
    type: 'bar',
    data: {
      labels: s.weekly_pipeline.map(w => fmtDate(w.week, { month: 'short', day: 'numeric' })),
      datasets: s.weekly_statuses.map(name => ({
        label: name, data: s.weekly_pipeline.map(w => w.counts[name] || 0),
        backgroundColor: statusColor(stc, name, 'open'),
        borderColor: c.surface, borderWidth: { top: 2 }, borderSkipped: 'start', maxBarThickness: 28,
      })),
    },
    options: baseOptions(c, { legend: true, stacked: true }),
  });

  $('#tClose').innerHTML = `<tbody>${Object.entries(s.close_rate).map(([t, v]) =>
    `<tr><td>${t}</td><td class="num"><b>${fmtPct(v)}</b></td></tr>`).join('')}</tbody>`;

  const nextMonth = fc[1];
  $('#vfSub').textContent = `${fmtDate(nextMonth.month + '-01', { month: 'long' })} · ${fmtNum(nextMonth.value)} units total`;
  $('#tVariantFc').innerHTML = `
    <thead><tr><th>Variant</th><th class="num">Mix</th><th class="num">Forecast</th><th class="num">Booked</th></tr></thead>
    <tbody>${s.variant_forecast.map(v => `<tr><td>${esc(v.variant)}</td><td class="num ink2">${fmtPct(v.share)}</td>
      <td class="num"><b>${fmtNum(v.forecast)}</b></td><td class="num ink2">${v.booked}</td></tr>`).join('')}</tbody>`;

  $('#tBranch').innerHTML = `
    <thead><tr><th>Dealer</th><th class="num">Sold</th><th class="num">Open</th><th class="num">Exp. close</th><th class="num">Cancelled</th><th class="num">Close rate</th><th class="num">Financed</th></tr></thead>
    <tbody>${s.branch_table.map(b => `<tr><td><b>${esc(b.branch)}</b></td><td class="num">${b.sold}</td><td class="num">${b.open}</td>
      <td class="num ink2">${fmtNum(b.expected)}</td><td class="num">${b.cancelled}</td><td class="num">${fmtPct(b.close_rate)}</td>
      <td class="num ink2">${fmtPct(b.financing)}</td></tr>`).join('') || '<tr><td class="empty" colspan="7">No data in range</td></tr>'}</tbody>`;

  $('#tGrm').innerHTML = `
    <thead><tr><th>#</th><th>GRM</th><th>Dealer</th><th class="num">Sold</th><th class="num">Open</th><th class="num">Cancelled</th></tr></thead>
    <tbody>${s.grm_table.map((g, i) => `<tr><td class="muted">${i + 1}</td><td><b>${esc(g.grm)}</b></td><td class="ink2">${esc(g.branch)}</td>
      <td class="num">${g.sold}</td><td class="num">${g.open}</td><td class="num">${g.cancelled}</td></tr>`).join('') || '<tr><td class="empty" colspan="6">No data in range</td></tr>'}</tbody>`;

  $('#upSub').textContent = `${s.upcoming.length} open releases${k.overdue ? ` · ${k.overdue} overdue past target date` : ''}`;
  $('#tUpcoming').innerHTML = `
    <thead><tr><th>Date</th><th>Dealer</th><th>Variant</th><th>Unit</th><th>Color</th><th>Transaction</th><th>Bank</th><th>Client</th><th>GRM</th><th>Status</th></tr></thead>
    <tbody>${s.upcoming.map(r => `<tr><td class="num">${fmtDate(r.target_date, { month: 'short', day: 'numeric' })}</td>
      <td><b>${esc(r.branch)}</b></td><td>${esc(r.variant)}</td><td class="ink2">${esc(r.unit)}</td><td class="ink2">${esc(r.color)}</td>
      <td>${esc(r.transaction_type)}</td><td>${esc(r.bank)}</td><td class="client">${esc(r.client)}</td><td class="ink2">${esc(r.grm)}</td>
      <td><span class="pill"><span class="dot" style="background:${statusColor(stc, r.status, r.cat)}"></span>${esc(r.status)}</span></td></tr>`).join('')
      || '<tr><td class="empty" colspan="10">Nothing scheduled in the next 14 days</td></tr>'}</tbody>`;

  $('#updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// Data comes in ONE request (shared with the Sales page and remembered between visits),
// refreshes every minute, and every filter change recalculates right here.
const SPEC = { releases: {} };
let lastStats = null;
let allRows = [];
let meta = null;
let controlsReady = false;

function filters() {
  return { from: $('#from').value, to: $('#to').value, branch: $('#branch').value };
}

function load() {
  if (!meta) return;
  lastStats = Stats.compute(allRows, meta, filters(), meta.today);
  render(lastStats);
}

function onData(d) {
  meta = d.meta;
  today = meta.today;
  allRows = d.releases;
  const cur = $('#branch').value || store.get('arpeggio.dashBranch', '');
  if (me.role === 'dealer') {
    $('#branch').innerHTML = `<option>${esc(me.dealer)}</option>`;
    $('#branch').disabled = true;
  } else {
    $('#branch').innerHTML = '<option value="">All dealers</option>' + meta.branches.map(b => `<option>${esc(b)}</option>`).join('');
    if (meta.branches.includes(cur)) $('#branch').value = cur;
  }
  if (!controlsReady) {
    controlsReady = true;
    applyPreset(preset); // sets the date range, then draws
  } else {
    load();
  }
}

$('#exportBtn').addEventListener('click', e => {
  e.preventDefault();
  const f = filters();
  const rows = allRows.filter(r => (!f.branch || r.branch === f.branch) && (!f.from || r.target_date >= f.from) && (!f.to || r.target_date <= f.to));
  download(`releases${f.branch ? ' ' + f.branch : ''}${f.from ? ' ' + f.from : ''}${f.to ? ' to ' + f.to : ''}.csv`, toCsv(rows));
});

$$('#presets button').forEach(b => b.onclick = () => applyPreset(b.dataset.p));
['#from', '#to'].forEach(sel => $(sel).addEventListener('change', () => {
  $$('#presets button').forEach(b => b.classList.remove('on'));
  load();
}));
$('#branch').addEventListener('change', () => { store.set('arpeggio.dashBranch', $('#branch').value); load(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => lastStats && render(lastStats));

loadPage(SPEC, onData).then(() => {
  // live: pick up new dealer entries every minute (one request each time)
  setInterval(() => loadPage(SPEC, onData).catch(() => {}), 60_000);
}).catch(err => toast(err.message));
