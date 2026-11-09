/*
 * Dashboard statistics and sales forecast, computed in the browser from the releases the
 * signed-in user is allowed to see.
 *
 * Forecast method:
 *   close rate   per transaction type: sold / (sold + cancelled), shrunk toward the overall rate
 *   booked       open releases in a month x their close rate
 *   trend        damped Holt smoothing on monthly units sold, nudged toward last year's seasonality
 *   this month   sold so far + expected from the rest of the pipeline, blended with the trend
 *   next months  the larger of trend and booked pipeline, with a widening likely range
 */
var Stats = (function () {
  'use strict';

  function monthKey(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
  function addMonths(d, n) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function round1(x) { return Math.round(x * 10) / 10; }
  function counter(items) { var c = {}; items.forEach(function (k) { c[k] = (c[k] || 0) + 1; }); return c; }
  function mostCommon(c, top) {
    var arr = Object.keys(c).map(function (k) { return { label: k, value: c[k] }; });
    arr.sort(function (a, b) { return b.value - a.value || a.label.localeCompare(b.label); });
    return top ? arr.slice(0, top) : arr;
  }

  function holt(series, horizon) {
    var alpha = 0.5, beta = 0.3, damp = 0.85;
    if (!series.length) return { fc: Array(horizon).fill(0), sd: 0 };
    if (series.length < 3) {
      var avg = series.reduce(function (a, b) { return a + b; }, 0) / series.length;
      return { fc: Array(horizon).fill(avg), sd: 0 };
    }
    var level = series[0], trend = series[1] - series[0], res = [];
    for (var i = 1; i < series.length; i++) {
      var y = series[i];
      res.push(y - (level + trend));
      var nl = alpha * y + (1 - alpha) * (level + trend);
      trend = beta * (nl - level) + (1 - beta) * trend;
      level = nl;
    }
    var fc = [], cum = 0;
    for (var h = 1; h <= horizon; h++) { cum += Math.pow(damp, h); fc.push(Math.max(0, level + cum * trend)); }
    var sd = Math.sqrt(res.reduce(function (a, r) { return a + r * r; }, 0) / res.length);
    return { fc: fc, sd: sd };
  }

  /**
   * rows: releases (already limited to what the user may see)
   * meta: from the 'meta' action (statuses + transactions with categories)
   * q: { from, to, branch }   today: 'yyyy-mm-dd'
   */
  function compute(allRows, meta, q, today) {
    var statusCat = {}, bankTx = {};
    meta.statuses.forEach(function (s) { statusCat[s.name] = s.category || 'open'; });
    meta.transactions.forEach(function (t) { if (t.category === 'bank') bankTx[t.name] = true; });
    var cat = function (s) { return statusCat[s] || 'open'; };
    var financed = function (r) { return !!bankTx[r.transaction_type]; };

    var scope = allRows.filter(function (r) { return !q.branch || r.branch === q.branch; })
      .map(function (r) { return Object.assign({}, r, { cat: cat(r.status) }); });
    var from = q.from || '0000-01-01', to = q.to || '9999-12-31';
    var inRange = scope.filter(function (r) { return r.target_date >= from && r.target_date <= to; });
    var sold = inRange.filter(function (r) { return r.cat === 'sold'; });
    var cancelled = inRange.filter(function (r) { return r.cat === 'cancelled'; });
    var open = inRange.filter(function (r) { return r.cat === 'open'; });
    var closed = sold.length + cancelled.length;

    // close rate per transaction type
    var hist = {}, totSold = 0, totClosed = 0;
    scope.forEach(function (r) {
      if (r.cat === 'open') return;
      var h = hist[r.transaction_type] = hist[r.transaction_type] || { sold: 0, cancelled: 0 };
      h[r.cat]++; totClosed++; if (r.cat === 'sold') totSold++;
    });
    var overall = totClosed ? totSold / totClosed : 0.85;
    var txNames = meta.transactions.map(function (t) { return t.name; });
    Object.keys(hist).sort().forEach(function (t) { if (txNames.indexOf(t) < 0) txNames.push(t); });
    var closeRate = {};
    txNames.forEach(function (t) {
      var h = hist[t] || { sold: 0, cancelled: 0 };
      closeRate[t] = (h.sold + 5 * overall) / (h.sold + h.cancelled + 5);
    });
    var expected = function (rows) {
      return rows.reduce(function (a, r) { return a + (closeRate[r.transaction_type] != null ? closeRate[r.transaction_type] : overall); }, 0);
    };

    // monthly history + forecast
    var t = new Date(today + 'T00:00:00Z');
    var curMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
    var soldByMonth = counter(scope.filter(function (r) { return r.cat === 'sold'; }).map(function (r) { return r.target_date.slice(0, 7); }));
    var plannedByMonth = counter(scope.filter(function (r) { return r.cat !== 'cancelled'; }).map(function (r) { return r.target_date.slice(0, 7); }));
    var history = [];
    for (var i = 12; i >= 0; i--) {
      var mk = monthKey(addMonths(curMonth, -i));
      history.push({ month: mk, sold: soldByMonth[mk] || 0, planned: plannedByMonth[mk] || 0 });
    }
    var complete = history.slice(0, -1).map(function (h) { return h.sold; });
    while (complete.length && complete[0] === 0) complete.shift();
    var h = holt(complete, 4), trendFc = h.fc, sd = h.sd;
    if (complete.length >= 12) {
      var mean12 = complete.slice(-12).reduce(function (a, b) { return a + b; }, 0) / 12 || 1;
      for (i = 0; i < 4; i++) {
        var ly = soldByMonth[monthKey(addMonths(curMonth, i - 12))];
        if (ly) trendFc[i] *= 1 + 0.5 * (ly / mean12 - 1);
      }
    }

    var openScope = scope.filter(function (r) { return r.cat === 'open'; });
    var daysInMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    var curKey = monthKey(curMonth);
    var soldMtd = scope.filter(function (r) { return r.cat === 'sold' && r.target_date.slice(0, 7) === curKey && r.target_date <= today; }).length;
    var pipelineCur = expected(openScope.filter(function (r) { return r.target_date.slice(0, 7) === curKey; }))
      + scope.filter(function (r) { return r.cat === 'sold' && r.target_date.slice(0, 7) === curKey && r.target_date > today; }).length;
    var pipeProj = soldMtd + pipelineCur;
    var w = Math.min(1, t.getUTCDate() / daysInMonth + 0.35);
    var curProj = w * pipeProj + (1 - w) * Math.max(trendFc[0], pipeProj);
    var forecast = [{
      month: curKey, value: round1(curProj), low: round1(Math.max(soldMtd, curProj - sd * (1 - w))),
      high: round1(curProj + sd * (1 - w) + 0.5), pipeline: round1(pipeProj), trend: round1(trendFc[0]),
    }];
    for (i = 1; i < 4; i++) {
      var k = monthKey(addMonths(curMonth, i));
      var pipe = expected(openScope.filter(function (r) { return r.target_date.slice(0, 7) === k; }));
      var val = Math.max(trendFc[i], pipe), band = sd * Math.sqrt(i);
      forecast.push({ month: k, value: round1(val), low: round1(Math.max(pipe, val - band)), high: round1(val + band),
        pipeline: round1(pipe), trend: round1(trendFc[i]) });
    }

    // next month by variant
    var mixFrom = iso(addMonths(curMonth, -3));
    var mix = counter(scope.filter(function (r) { return r.cat === 'sold' && r.target_date >= mixFrom; }).map(function (r) { return r.variant; }));
    var mixTotal = Object.keys(mix).reduce(function (a, k2) { return a + mix[k2]; }, 0) || 1;
    var nxt = forecast[1];
    var nxtOpen = counter(openScope.filter(function (r) { return r.target_date.slice(0, 7) === nxt.month; }).map(function (r) { return r.variant; }));
    var variantForecast = Object.keys(mix).map(function (v) {
      return { variant: v, share: Math.round(mix[v] / mixTotal * 1000) / 1000, forecast: round1(nxt.value * mix[v] / mixTotal), booked: nxtOpen[v] || 0 };
    }).sort(function (a, b) { return b.forecast - a.forecast; });

    // breakdowns
    var count = function (rows, key, top) { return mostCommon(counter(rows.map(function (r) { return r[key] || '—'; })), top); };
    var dealers = Object.keys(counter(inRange.map(function (r) { return r.branch; }))).sort();
    var branchTable = dealers.map(function (b) {
      var rows = inRange.filter(function (r) { return r.branch === b; });
      var s = rows.filter(function (r) { return r.cat === 'sold'; }).length;
      var c = rows.filter(function (r) { return r.cat === 'cancelled'; }).length;
      var o = rows.filter(function (r) { return r.cat === 'open'; });
      return { branch: b, sold: s, cancelled: c, open: o.length, expected: round1(expected(o)),
        close_rate: s + c ? s / (s + c) : null,
        financing: s ? rows.filter(function (r) { return financed(r) && r.cat === 'sold'; }).length / s : null };
    }).sort(function (a, b) { return b.sold - a.sold; });

    var grm = {};
    inRange.forEach(function (r) {
      var g = grm[r.grm || '—'] = grm[r.grm || '—'] || { sold: 0, cancelled: 0, open: 0, branch: '' };
      g.branch = r.branch; g[r.cat]++;
    });
    var grmTable = Object.keys(grm).map(function (k2) { return Object.assign({ grm: k2 }, grm[k2]); })
      .sort(function (a, b) { return b.sold - a.sold || a.grm.localeCompare(b.grm); }).slice(0, 12);

    // upcoming + weekly pipeline
    var horizonEnd = iso(new Date(t.getTime() + 14 * 86400000));
    var upcoming = openScope.filter(function (r) { return r.target_date >= today && r.target_date <= horizonEnd; });
    var overdue = openScope.filter(function (r) { return r.target_date < today; });
    var openNames = meta.statuses.filter(function (s) { return (s.category || 'open') === 'open'; }).map(function (s) { return s.name; });
    Object.keys(counter(openScope.map(function (r) { return r.status; }))).sort().forEach(function (s) { if (openNames.indexOf(s) < 0) openNames.push(s); });
    var week0 = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000);
    var weekly = [];
    for (i = 0; i < 8; i++) {
      var ws = new Date(week0.getTime() + i * 7 * 86400000), we = new Date(ws.getTime() + 6 * 86400000);
      var c2 = counter(openScope.filter(function (r) { return r.target_date >= iso(ws) && r.target_date <= iso(we); }).map(function (r) { return r.status; }));
      var counts = {};
      openNames.forEach(function (n) { counts[n] = c2[n] || 0; });
      weekly.push({ week: iso(ws), counts: counts });
    }
    var usedOpen = openNames.filter(function (n) { return weekly.some(function (wk) { return wk.counts[n]; }); });

    Object.keys(closeRate).forEach(function (k3) { closeRate[k3] = Math.round(closeRate[k3] * 1000) / 1000; });
    return {
      today: today,
      kpi: {
        entries: inRange.length, sold: sold.length, cancelled: cancelled.length, open: open.length,
        expected_from_open: round1(expected(open)),
        cancel_rate: closed ? cancelled.length / closed : null,
        financing_share: sold.length ? sold.filter(financed).length / sold.length : null,
        sold_mtd: soldMtd, projection: forecast[0], overdue: overdue.length,
      },
      close_rate: closeRate, history: history, forecast: forecast, variant_forecast: variantForecast,
      by_branch: count(sold, 'branch'), by_variant: count(sold, 'variant'), by_transaction: count(sold, 'transaction_type'),
      by_bank: count(sold.filter(financed), 'bank', 8),
      branch_table: branchTable, grm_table: grmTable,
      weekly_pipeline: weekly, weekly_statuses: usedOpen,
      upcoming: upcoming.slice(0, 40), overdue: overdue.slice(0, 40),
    };
  }

  return { compute: compute };
})();
