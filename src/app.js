/* Options Risk Check — the page. All math lives in core.js. */
(function () {
  'use strict';
  var C = window.Core;
  var KEY = 'options-risk-check.v1';
  var DATA = 'data/';
  var $ = function (id) { return document.getElementById(id); };

  var SETTINGS = [
    ['dteAlert', 'Management window', 'days to expiration'],
    ['dteUrgent', 'Urgent', 'days to expiration'],
    ['profitTarget', 'Profit target', '% of max profit'],
    ['deltaAlert', 'Short option delta alert', 'for example 0.40'],
    ['nearStrikePct', 'Stock close to a short strike', '% away'],
    ['maxTickerPct', 'Most in one ticker', '% of account'],
    ['maxSectorPct', 'Most in one sector', '% of account'],
    ['maxCashPct', 'Cash needed limit', '% of cash available'],
    ['leapsDte', 'PMCC long call roll window', 'days to expiration'],
    ['leapsDeltaMin', 'PMCC long call lowest delta', 'for example 0.70'],
    ['rate', 'Interest rate used in the math', '%']
  ];
  var STATUS_TEXT = { act: 'Needs action', watch: 'Watch', data: 'Missing info', good: 'Profit target', ok: 'OK' };

  // ---------- saved data (this browser only) ----------
  function freshState() {
    return { account: { value: '', cash: '', type: 'cash' }, cfg: Object.assign({}, C.DEFAULTS), positions: [], examples: false };
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !Array.isArray(s.positions)) return null;
      s.cfg = Object.assign({}, C.DEFAULTS, s.cfg || {});
      s.account = Object.assign({ value: '', cash: '', type: 'cash' }, s.account || {});
      return s;
    } catch (e) { return null; }
  }
  var storageOk = true;
  function saveState() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) {
      if (storageOk) toast('This browser is not letting the page save. Use More → Save to file to keep your trades.');
      storageOk = false;
    }
  }
  var state = loadState() || freshState();
  var prices = null;
  var analyses = [], summary = null;
  var openDetails = {};

  // ---------- helpers ----------
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var money = C.money;
  function money2(v) { if (v === null || v === undefined || !isFinite(v)) return '—'; return (v > 0 ? '+' : '') + money(v, 2); }
  function signedMoney(v) { if (v === null || v === undefined || !isFinite(v)) return '—'; return (v > 0 ? '+' : '') + money(v); }
  function cls(v) { return v > 0 ? 'pos' : (v < 0 ? 'neg' : ''); }
  function pct(v, d) { return (v === null || v === undefined || !isFinite(v)) ? '—' : v.toFixed(d === undefined ? 1 : d).replace('-', '−') + '%'; }
  function pctOf(v) { return (v === null || v === undefined || !isFinite(v)) ? '—' : (v * 100).toFixed(1) + '%'; }
  function n2(v) { return (v === null || v === undefined || !isFinite(v)) ? '—' : v.toFixed(2); }
  function shortDate(s) {
    var t = C.parseDate(s); if (t === null) return '';
    var d = new Date(t);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCDate() + " '" + String(d.getUTCFullYear()).slice(2);
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3800);
  }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function describe(p) {
    var st = C.STRATEGIES[p.strategy]; if (!st) return '';
    var L = p.legs || [], q = p.qty, k = function (i) { return C.fmtK(C.num(L[i].strike)); }, e = function (i) { return shortDate(L[i].expiry); };
    switch (p.strategy) {
      case 'csp': return '−' + q + ' ' + k(0) + 'P · ' + e(0);
      case 'cc': return p.sharesQty + ' sh @ ' + p.sharesCost + ' · −' + q + ' ' + k(0) + 'C · ' + e(0);
      case 'shares': return p.sharesQty + ' sh @ ' + p.sharesCost;
      case 'pcs': return k(0) + '/' + k(1) + 'P · ' + e(0) + ' · ×' + q;
      case 'ccs': return k(0) + '/' + k(1) + 'C · ' + e(0) + ' · ×' + q;
      case 'ic': return k(0) + '/' + k(1) + 'P · ' + k(2) + '/' + k(3) + 'C · ' + e(0) + ' · ×' + q;
      case 'pmcc': return '+' + k(0) + 'C ' + e(0) + ' / −' + k(1) + 'C ' + e(1) + ' · ×' + q;
    }
    return '';
  }

  // ---------- account and settings ----------
  function initAccount() {
    $('accValue').value = state.account.value || '';
    $('accCash').value = state.account.cash || '';
    $('accType').value = state.account.type || 'cash';
    ['accValue', 'accCash'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        state.account[id === 'accValue' ? 'value' : 'cash'] = $(id).value.trim();
        saveState(); render();
      });
    });
    $('accType').addEventListener('change', function () { state.account.type = $('accType').value; saveState(); render(); });
    buildSettings();
    $('btnResetSettings').addEventListener('click', function () {
      state.cfg = Object.assign({}, C.DEFAULTS); saveState(); buildSettings(); render(); toast('Alert settings are back to the starting points.');
    });
  }
  function buildSettings() {
    $('settingsGrid').innerHTML = SETTINGS.map(function (s) {
      return '<label>' + esc(s[1]) + ' <span class="opt">(' + esc(s[2]) + ')</span>' +
        '<input data-cfg="' + s[0] + '" inputmode="decimal" value="' + esc(state.cfg[s[0]]) + '"></label>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('[data-cfg]'), function (inp) {
      inp.addEventListener('input', function () {
        var v = C.num(inp.value);
        if (v === null || v < 0) return;
        state.cfg[inp.getAttribute('data-cfg')] = v; saveState(); render();
      });
    });
  }

  // ---------- prices ----------
  function fmtTime(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '?';
    return new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  }
  function setPriceStatus() {
    var el = $('priceStatus');
    el.classList.remove('warn');
    if (!prices) { el.textContent = 'Prices: using the prices you type in. Automatic prices are not available right now.'; return; }
    var text = 'Stock prices as of ' + fmtTime(prices.stocks_updated) + '.';
    var chainTimes = Object.keys(prices.chains || {}).map(function (k) { return Date.parse(prices.chains[k].updated); }).filter(isFinite);
    if (chainTimes.length) text += ' Option prices last pulled ' + fmtTime(new Date(Math.min.apply(null, chainTimes)).toISOString()) + '; between pulls they are estimated from the newest stock price.';
    var age = Date.now() - Date.parse(prices.stocks_updated);
    if (isFinite(age) && age > 30 * 3600000) {
      text = 'These automatic prices are old. The update may have failed, so check prices with your broker. ' + text;
      el.classList.add('warn');
    }
    el.textContent = text;
  }
  function getJson(path) {
    return fetch(DATA + path + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  }
  function refreshPrices(quiet) {
    var btn = $('btnRefresh');
    btn.disabled = true;
    var done = function () { btn.disabled = false; setPriceStatus(); render(); };
    if (!window.fetch || location.protocol === 'file:') {
      if (!quiet) toast('Automatic prices are not available here, so the page uses the prices you type in.');
      done(); return;
    }
    Promise.all([getJson('stocks.json'), getJson('info.json').catch(function () { return null; })])
      .then(function (res) {
        var st = res[0], inf = res[1];
        if (!st || !st.stocks || !st.updated) throw new Error('bad');
        var stocks = {};
        Object.keys(st.stocks).forEach(function (k) {
          var v = st.stocks[k]; stocks[k] = { price: typeof v === 'number' ? v : (v && v.price) };
        });
        var next = { stocks_updated: st.updated, stocks: stocks, info: (inf && inf.info) || {}, chains: {} };
        var held = {};
        state.positions.forEach(function (p) {
          var tk = String(p.ticker || '').toUpperCase();
          if (stocks[tk] && (p.legs || []).length && /^[A-Z0-9.\-]+$/.test(tk)) held[tk] = true;
        });
        return Promise.all(Object.keys(held).map(function (tk) {
          return getJson('chains/' + encodeURIComponent(tk) + '.json')
            .then(function (c) { if (c && c.exps) next.chains[tk] = c; })
            .catch(function () {});
        })).then(function () { return next; });
      })
      .then(function (next) {
        prices = next;
        if (!quiet) toast('Prices refreshed.');
        done();
      })
      .catch(function () {
        if (!quiet) toast(prices ? 'Could not reach the newest prices. Showing the last ones loaded.' : 'Automatic prices are not available right now, so the page uses the prices you type in.');
        done();
      });
  }

  // ---------- risk profile charts (plain SVG) ----------
  var charts = {};
  var SVGNS = 'http://www.w3.org/2000/svg';
  function niceStep(span, count) {
    var raw = span / Math.max(count, 1), mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }
  function ticks(min, max, count) {
    if (!(max > min)) { max = min + 1; }
    var st = niceStep(max - min, count), out = [];
    for (var v = Math.ceil(min / st) * st; v <= max + st * 1e-9; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : v);
    return out;
  }
  function el(tag, attrs, parent) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function chartSlot(id, spec) { charts[id] = spec; return '<div class="rchart" data-chart="' + esc(id) + '"></div>'; }
  function drawCharts() {
    Array.prototype.forEach.call(document.querySelectorAll('.rchart[data-chart]'), function (box) {
      var spec = charts[box.getAttribute('data-chart')];
      if (spec) drawChart(box, spec);
    });
  }
  function drawChart(box, spec) {
    box.innerHTML = '';
    var W = Math.max(box.clientWidth, 260), narrow = W < 480, H = spec.height || (narrow ? 200 : 230);
    var m = { l: narrow ? 52 : 64, r: 12, t: 22, b: 28 };
    var xs = spec.xs, x0 = xs[0], x1 = xs[xs.length - 1];
    var vals = [0];
    spec.series.forEach(function (sr) { sr.ys.forEach(function (v) { if (v !== null && isFinite(v)) vals.push(v); }); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.08 || 1;
    var yt = ticks(lo - pad, hi + pad, narrow ? 4 : 5);
    var y0 = Math.min(yt[0], lo - pad), y1 = Math.max(yt[yt.length - 1], hi + pad);
    var X = function (v) { return m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r); };
    var Y = function (v) { return m.t + (y1 - v) / (y1 - y0) * (H - m.t - m.b); };

    if (spec.series.length > 1) {
      var lg = document.createElement('div'); lg.className = 'rlegend';
      spec.series.forEach(function (sr) {
        var it = document.createElement('span'); it.className = 'rkey';
        var ln = document.createElement('i'); ln.className = 'line ' + sr.cls; it.appendChild(ln);
        it.appendChild(document.createTextNode(sr.name)); lg.appendChild(it);
      });
      box.appendChild(lg);
    }
    var wrap = document.createElement('div'); wrap.className = 'rplot'; wrap.tabIndex = 0;
    wrap.setAttribute('role', 'img'); wrap.setAttribute('aria-label', spec.label || 'Risk profile');
    box.appendChild(wrap);
    var svg = el('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H }, wrap);
    // gridlines and y labels
    yt.forEach(function (v) {
      if (v < y0 || v > y1) return;
      el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: v === 0 ? 'zero' : 'grid' }, svg);
      var t = el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'ax' }, svg); t.textContent = spec.yFmt(v);
    });
    if (yt.indexOf(0) < 0) el('line', { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), class: 'zero' }, svg);
    // x labels
    ticks(x0, x1, narrow ? 4 : 7).forEach(function (v) {
      if (v < x0 || v > x1) return;
      var t = el('text', { x: X(v), y: H - 8, 'text-anchor': 'middle', class: 'ax' }, svg); t.textContent = spec.xFmt(v);
    });
    // strike ticks
    (spec.strikes || []).forEach(function (k) {
      if (k < x0 || k > x1) return;
      el('line', { x1: X(k), x2: X(k), y1: H - m.b, y2: H - m.b + 5, class: 'stk' }, svg);
    });
    // "now" marker
    if (spec.now !== undefined && spec.now >= x0 && spec.now <= x1) {
      el('line', { x1: X(spec.now), x2: X(spec.now), y1: m.t - 6, y2: H - m.b, class: 'nowline' }, svg);
      var nt = el('text', { x: X(spec.now), y: m.t - 9, 'text-anchor': X(spec.now) > W - 60 ? 'end' : (X(spec.now) < m.l + 40 ? 'start' : 'middle'), class: 'nowlbl' }, svg);
      nt.textContent = spec.nowLabel || 'Now';
    }
    // lines
    spec.series.forEach(function (sr) {
      var d = '', pen = false;
      sr.ys.forEach(function (v, i) {
        if (v === null || !isFinite(v)) { pen = false; return; }
        d += (pen ? 'L' : 'M') + X(xs[i]).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true;
      });
      el('path', { d: d, class: 'sline ' + sr.cls }, svg);
    });
    // breakeven dots on the zero line
    (spec.dots || []).forEach(function (x) {
      if (x < x0 || x > x1) return;
      el('circle', { cx: X(x), cy: Y(0), r: 4, class: 'bedot ' + (spec.dotCls || 's2') }, svg);
    });
    // hover: crosshair + one tooltip with every series
    var cross = el('line', { x1: 0, x2: 0, y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' }, svg);
    var marks = spec.series.map(function (sr) { return el('circle', { r: 4, class: 'hdot ' + sr.cls, visibility: 'hidden' }, svg); });
    var tip = document.createElement('div'); tip.className = 'rtip'; tip.hidden = true; wrap.appendChild(tip);
    var idx = -1;
    function show(i) {
      idx = Math.max(0, Math.min(xs.length - 1, i));
      var px = X(xs[idx]);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      tip.textContent = '';
      var h = document.createElement('div'); h.className = 'th'; h.textContent = spec.xName + ' ' + spec.xFmt(xs[idx], true); tip.appendChild(h);
      spec.series.forEach(function (sr, j) {
        var v = sr.ys[idx];
        if (v === null || !isFinite(v)) { marks[j].setAttribute('visibility', 'hidden'); return; }
        marks[j].setAttribute('cx', px); marks[j].setAttribute('cy', Y(v)); marks[j].setAttribute('visibility', 'visible');
        var row = document.createElement('div'); row.className = 'tr';
        var key = document.createElement('i'); key.className = 'line ' + sr.cls; row.appendChild(key);
        var b = document.createElement('b'); b.textContent = signedMoney(v); row.appendChild(b);
        var n = document.createElement('span'); n.textContent = ' ' + sr.name; row.appendChild(n);
        tip.appendChild(row);
      });
      tip.hidden = false;
      var tw = tip.offsetWidth, left = px + 12;
      if (left + tw > W - 4) left = px - tw - 12;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = (m.t + 2) + 'px';
    }
    function hide() { cross.setAttribute('visibility', 'hidden'); marks.forEach(function (mk) { mk.setAttribute('visibility', 'hidden'); }); tip.hidden = true; }
    function nearest(clientX) {
      var r = svg.getBoundingClientRect(), x = x0 + (clientX - r.left - m.l) / (W - m.l - m.r) * (x1 - x0);
      var best = 0; for (var i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
      return best;
    }
    wrap.addEventListener('pointermove', function (e) { show(nearest(e.clientX)); });
    wrap.addEventListener('pointerleave', hide);
    wrap.addEventListener('focus', function () {
      var s0 = spec.now !== undefined ? spec.now : xs[Math.floor(xs.length / 2)];
      var best = 0; for (var i = 1; i < xs.length; i++) if (Math.abs(xs[i] - s0) < Math.abs(xs[best] - s0)) best = i;
      show(best);
    });
    wrap.addEventListener('blur', hide);
    wrap.addEventListener('keydown', function (e) {
      var step = Math.max(1, Math.round(xs.length / 40));
      if (e.key === 'ArrowRight') { show(idx + step); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { show(idx - step); e.preventDefault(); }
    });
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });

  function tradeChartHtml(a, p, suffix) {
    var rp = C.riskProfile(a);
    if (!rp) return '';
    var series = [];
    if (rp.now) series.push({ name: rp.sharesOnly ? 'P/L' : 'Today', cls: 's1', ys: rp.now });
    if (rp.exp) series.push({ name: p.strategy === 'pmcc' ? 'At short call expiration (' + shortDate(rp.expDate) + ')' : 'At expiration (' + shortDate(rp.expDate) + ')', cls: 's2', ys: rp.exp });
    if (!series.length) return '<p class="note">The risk profile needs the current option prices. Type them in, or press Refresh prices.</p>';
    var id = 'trade-' + p.id + (suffix || '');
    var price = function (v) { return v >= 1000 ? Math.round(v).toLocaleString('en-US') : (Math.round(v * 100) / 100).toString(); };
    var html = '<div class="rbox"><div class="rtitle">Risk profile</div>' + chartSlot(id, {
      xs: rp.xs, series: series, now: rp.S, nowLabel: 'Now ' + n2(rp.S), strikes: rp.strikes, dots: rp.breakevens,
      dotCls: rp.exp ? 's2' : 's1', xName: 'Stock at', xFmt: function (v) { return price(v); }, yFmt: function (v) { return shortMoney(v); },
      label: a.ticker + ' risk profile: profit or loss across stock prices'
    });
    var t = rp.table;
    html += '<table class="rtable"><thead><tr><th>Stock move</th>' + t.map(function (r) { return '<th class="n">' + (r.pct === 0 ? 'Now' : (r.pct > 0 ? '+' : '−') + Math.abs(r.pct) + '%') + '<span class="src">' + price(r.price) + '</span></th>'; }).join('') + '</tr></thead><tbody>';
    series.forEach(function (sr) {
      var key = sr.cls === 's1' ? 'now' : 'exp';
      html += '<tr><td><i class="line ' + sr.cls + '"></i>' + esc(sr.name.replace(/ \(.*\)$/, '')) + '</td>' + t.map(function (r) { return '<td class="n ' + cls(r[key]) + '">' + signedMoney(r[key]) + '</td>'; }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    var be = rp.breakevens.length ? 'Breakeven' + (rp.breakevens.length > 1 ? 's' : '') + (rp.exp ? ' at expiration' : '') + ': ' + rp.breakevens.map(function (b) { return b.toFixed(2); }).join(' and ') + ' (dots). ' : '';
    html += '<p class="note">' + be + 'Small ticks on the bottom edge mark your strikes. "Today" uses each option\'s current implied volatility; the expiration line assumes the stock sits at that price on that date.' +
      (p.strategy === 'pmcc' ? ' For a PMCC the long call still has time value at the short call\'s expiration, so that line is an estimate.' : '') + '</p></div>';
    return html;
  }
  function shortMoney(v) {
    var a = Math.abs(v), s = v < 0 ? '−$' : '$';
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return s + Math.round(a / 1000) + 'k';
    if (a >= 1000) return s + (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return s + Math.round(a);
  }

  // ---------- rendering ----------
  function render() {
    var now = new Date();
    analyses = state.positions.map(function (p) { return C.analyzePosition(p, state.cfg, prices, now); });
    summary = C.summarize(analyses, state.account, state.cfg);
    $('exampleBanner').hidden = !state.examples || !state.positions.length;
    renderAttention();
    renderExposure();
    renderPositions();
  }

  function renderAttention() {
    var el = $('attention');
    if (!state.positions.length) {
      el.innerHTML = '<p class="empty">No trades yet. Press <b>+ Add trade</b> to add your first one, or use <b>More ▾ → Load example trades</b> to see how it works.</p>';
      return;
    }
    var html = '';
    var acctFlags = summary.flags;
    if (acctFlags.length) {
      var worst = acctFlags[0].sev;
      html += '<div class="att ' + worst + '"><div class="att-head"><b>Whole account</b></div><ul>' +
        acctFlags.map(function (f) { return '<li class="' + f.sev + '">' + esc(f.text) + '</li>'; }).join('') + '</ul></div>';
    }
    var show = analyses.map(function (a, i) { return { a: a, p: state.positions[i] }; })
      .filter(function (x) { return x.a.flags.some(function (f) { return f.sev !== 'info'; }); })
      .sort(function (x, y) { return C.SEVERITY[y.a.status] - C.SEVERITY[x.a.status]; });
    show.forEach(function (x) {
      var a = x.a;
      var flags = a.flags.filter(function (f) { return f.sev !== 'info'; });
      html += '<div class="att ' + a.status + '"><div class="att-head"><b>' + esc(a.ticker) + '</b><span class="tag">' + esc(a.st ? a.st.short : '') + '</span>' +
        '<span class="pill ' + a.status + '">' + STATUS_TEXT[a.status] + '</span>' +
        '<span class="small muted">' + esc(describe(x.p)) + '</span>' +
        '<button type="button" class="linkbtn" data-edit="' + esc(x.p.id) + '">Edit</button></div><ul>' +
        flags.map(function (f) { return '<li class="' + f.sev + '">' + esc(f.text) + '</li>'; }).join('') + '</ul></div>';
    });
    if (!html) html = '<p class="allclear">All clear. Nothing has hit your alert settings right now.</p>';
    else html = '<div class="att-list">' + html + '</div>';
    el.innerHTML = html;
  }

  function renderExposure() {
    var el = $('exposure'), s = summary;
    if (!state.positions.length) { el.innerHTML = '<p class="empty">Add trades to see your cash, delta and stress test.</p>'; return; }
    var cashPct = s.cashPct, barCls = cashPct === null ? '' : (cashPct >= state.cfg.maxCashPct ? 'act' : (cashPct >= 0.75 * state.cfg.maxCashPct ? 'watch' : ''));
    var tiles = '';
    tiles += '<div class="tile"><div class="k">Cash needed</div><div class="v">' + money(s.cashNeeded) + '</div>' +
      '<div class="d">' + (s.cash !== null ? 'of ' + money(s.cash) + ' cash (' + pct(cashPct, 0) + ')' : 'Enter your cash above') + '</div>' +
      (cashPct !== null ? '<div class="bar ' + barCls + '"><span style="width:' + Math.min(cashPct, 100).toFixed(1) + '%"></span></div>' : '') + '</div>';
    tiles += '<div class="tile"><div class="k">Delta dollars</div><div class="v ' + cls(s.deltaDollars) + '">' + signedMoney(s.deltaDollars) + '</div>' +
      '<div class="d">Acts like this much stock' + (s.deltaPct !== null ? ' · ' + pct(s.deltaPct, 0) + ' of account' : '') + '</div></div>';
    tiles += '<div class="tile"><div class="k">If SPY moves 1%</div><div class="v">≈ ' + money(Math.abs(s.spyOnePct)) + '</div>' +
      '<div class="d">' + (s.spyOnePct >= 0 ? 'Gain if SPY rises, loss if it falls' : 'Gain if SPY falls, loss if it rises') + ' (beta-weighted)</div></div>';
    tiles += '<div class="tile"><div class="k">Open P/L</div><div class="v ' + cls(s.pl) + '">' + signedMoney(s.pl) + '</div>' +
      '<div class="d">' + (s.plMissing ? s.plMissing + ' trade(s) missing prices left out' : 'All open trades') + '</div></div>';
    tiles += '<div class="tile"><div class="k">Theta</div><div class="v ' + cls(s.theta) + '">' + money2(s.theta) + '</div>' +
      '<div class="d">Per day from time decay, if nothing else changes</div></div>';
    tiles += '<div class="tile"><div class="k">Vega</div><div class="v ' + cls(s.vega) + '">' + money2(s.vega) + '</div>' +
      '<div class="d">If implied volatility rises 1 point on every trade</div></div>';
    tiles += '<div class="tile"><div class="k">Gamma</div><div class="v ' + cls(s.gamma1pct) + '">' + signedMoney(s.gamma1pct) + '</div>' +
      '<div class="d">Change in delta dollars if SPY rises 1%' + (s.gamma1pct < 0 ? '; negative means delta moves against you' : '') + '</div></div>';
    tiles += '<div class="tile"><div class="k">Greeks cover</div><div class="v">' + (s.count - s.greeksMissing) + ' of ' + s.count + '</div>' +
      '<div class="d">' + (s.greeksMissing ? s.greeksMissing + ' trade(s) need option prices to be included' : 'Every trade is included') + '</div></div>';

    var notes = [];
    notes.push('<b>Cash needed</b> counts the full strike × 100 for each short put, and the width of the spread × 100 for credit spreads and iron condors. <b>Capital</b> is that cash for short puts, the max loss for spreads, condors and PMCCs, and the market value for shares.');
    if (s.deltaMissing) notes.push(s.deltaMissing + ' trade(s) are missing prices, so they are left out of the delta totals.');
    if (s.betaAssumed.length) notes.push('Beta of 1.0 was used for: ' + esc(s.betaAssumed.join(', ')) + '. Add a beta under More details for a better SPY number.');

    function groupTable(title, rows, limit, label) {
      if (!rows.length) return '';
      return '<div><h4>' + title + '</h4><table class="grp"><thead><tr><th>' + label + '</th><th class="n">Capital</th><th class="n">% of account</th><th class="n">Cash needed</th><th class="n">Delta $</th></tr></thead><tbody>' +
        rows.map(function (g) {
          var over = g.pct !== null && g.pct > limit && g.key !== 'Unknown';
          return '<tr class="' + (over ? 'over' : '') + '"><td>' + esc(g.key) + '</td><td class="n">' + money(g.capital) + '</td><td class="n">' + pct(g.pct) + '</td><td class="n">' + money(g.cash) + '</td><td class="n ' + cls(g.deltaDollars) + '">' + signedMoney(g.deltaDollars) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    var groups = '<div class="two">' + groupTable('By ticker', s.byTicker, state.cfg.maxTickerPct, 'Ticker') + groupTable('By sector', s.bySector, state.cfg.maxSectorPct, 'Sector') + '</div>';

    var incomplete = s.stress.some(function (r) { return r.incomplete; });
    var stress = '<h4>Stress test</h4><table class="stress"><thead><tr><th>Market move</th><th class="n">Estimated P/L</th><th class="n">% of account</th><th class="n">Short puts in the money</th><th class="n">Cash needed for those</th></tr></thead><tbody>' +
      s.stress.map(function (r) {
        var over = s.cash !== null && r.cash > s.cash;
        return '<tr class="' + (over ? 'over' : '') + '"><td>' + (r.move > 0 ? '+' : '') + r.move + '%</td><td class="n ' + cls(r.chg) + '">' + signedMoney(r.chg) + '</td><td class="n">' + pct(r.pct) + '</td><td class="n">' + r.itmPuts + '</td><td class="n">' + money(r.cash) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="note">Each stock moves by the market move × its beta, today, and every option is repriced at the new stock price. Implied volatility is held the same; in a real selloff it usually rises, which makes short options lose more.' +
      (incomplete ? ' Some trades are missing prices and are only partly included.' : '') + ' Highlighted rows need more cash than you have.</p>';

    var ap = C.accountProfile(analyses), acct = '';
    if (ap.count) {
      acct = '<div class="rbox acct"><div class="rtitle">Risk profile: whole account</div>' + chartSlot('account', {
        xs: ap.moves, series: [{ name: 'Change in P/L from today', cls: 's1', ys: ap.chg }], now: 0, nowLabel: 'SPY now',
        xName: 'SPY', xFmt: function (v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '%'; }, yFmt: shortMoney,
        label: 'Whole account risk profile: change in profit or loss if SPY moves'
      }) + '<p class="note">How much your account would gain or lose today if SPY moved by each amount, with each stock moving by its beta and every option repriced. The table below shows the same numbers at set points.' +
        (ap.partial ? ' ' + ap.partial + ' trade(s) are missing prices and are only partly included.' : '') + '</p></div>';
    }
    el.innerHTML = '<div class="tiles">' + tiles + '</div>' + groups + acct + stress + '<p class="note">' + notes.join(' ') + '</p>';
    drawCharts();
  }

  function srcTag(src) {
    if (!src) return '';
    var t = { auto: 'auto', typed: 'typed', estimate: 'est.' }[src] || src;
    return '<span class="src">' + t + '</span>';
  }

  function legLines(a) {
    return '<ul class="leglines">' + a.legs.map(function (l, i) {
      var role = a.st.legs[i] ? a.st.legs[i].role : '';
      return '<li><b>' + esc(role) + ' ' + C.fmtK(l.K) + '</b> · ' + shortDate(l.expiry) + ' · ' + (l.dte === null ? '—' : l.dte) + ' days<br>' +
        'Filled ' + n2(l.fill) + ' · now ' + n2(l.mark) + srcTag(l.mSrc) + ' · delta ' + n2(l.delta) + ' · IV ' + (l.iv ? (l.iv * 100).toFixed(1) + '%' : '—') + ' · Prob ITM ' + pctOf(l.probItm) +
        ' · P/L <span class="' + cls(l.pl) + '">' + signedMoney(l.pl) + '</span></li>';
    }).join('') + '</ul>';
  }

  function detailHtml(a, p, compact) {
    if (a.errors && a.errors.length) {
      return '<ul class="errors">' + a.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
    }
    var legRows = a.legs.map(function (l, i) {
      var role = a.st.legs[i] ? a.st.legs[i].role : '';
      return '<tr><td>' + esc(role) + '</td><td class="n">' + C.fmtK(l.K) + '</td><td>' + shortDate(l.expiry) + '</td><td class="n">' + (l.dte === null ? '—' : l.dte) + '</td>' +
        '<td class="n">' + n2(l.fill) + '</td><td class="n">' + n2(l.mark) + srcTag(l.mSrc) + '</td><td class="n">' + n2(l.delta) + '</td><td class="n">' + (l.iv ? (l.iv * 100).toFixed(1) + '%' : '—') + '</td><td class="n">' + pctOf(l.probItm) + '</td><td class="n ' + cls(l.pl) + '">' + signedMoney(l.pl) + '</td></tr>';
    }).join('');
    var legTable = !a.legs.length ? '' : compact ? legLines(a) : '<table class="legtable"><thead><tr><th>Leg</th><th class="n">Strike</th><th>Expires</th><th class="n">Days</th><th class="n">Filled</th><th class="n">Now</th><th class="n">Delta</th><th class="n">IV</th><th class="n" title="Chance this option finishes in the money, based on its implied volatility">Prob ITM</th><th class="n">P/L</th></tr></thead><tbody>' + legRows + '</tbody></table>';
    var shares = a.Q ? '<p class="small">' + a.Q + ' shares at ' + n2(a.C) + ' cost · P/L ' + signedMoney(a.sharesPL) + '</p>' : '';
    var kv = [
      ['Stock price', n2(a.S) + srcTag(a.sSrc)],
      ['Credit / debit', a.credit >= 0 ? money(a.credit) + ' credit' : money(-a.credit) + ' debit'],
      ['Max profit', money(a.maxProfit) + (a.maxProfitIsEstimate ? ' (estimate)' : '') + (p.strategy === 'shares' ? '' : '')],
      ['Max loss', money(a.maxLoss)],
      ['Breakeven', a.breakevens.length ? a.breakevens.map(function (b) { return b.toFixed(2); }).join(' / ') : '—'],
      ['Cash needed', money(a.collateral)],
      ['Position delta', a.posDelta === null ? '—' : a.posDelta.toFixed(1)],
      ['Delta $', signedMoney(a.deltaDollars)],
      ['Beta-weighted delta $', signedMoney(a.bwDeltaDollars) + (a.beta === null ? ' (beta 1.0 used)' : ' (beta ' + a.beta + ')')],
      ['Theta per day', money2(a.theta)],
      ['Gamma', a.posGamma === null ? '—' : a.posGamma.toFixed(3) + ' <span class="src">delta change per $1 move</span>'],
      ['Vega', a.vega === null ? '—' : money2(a.vega) + ' <span class="src">per 1 point of IV</span>'],
      ['Dividend yield', (a.dq * 100).toFixed(2) + '%' + srcTag(a.dqSrc)],
      ['Sector', esc(a.sector)],
      ['Earnings', a.earnings ? C.fmtD(a.earnings) : '—'],
      ['Ex-dividend', a.exDiv ? C.fmtD(a.exDiv) : '—']
    ];
    if (p.strategy === 'pmcc') kv.splice(5, 0, ['Lowest safe short strike', a.pmccMinShortStrike.toFixed(2)]);
    if (p.notes) kv.push(['Notes', esc(p.notes)]);
    var flags = a.flags.length ? '<ul class="small">' + a.flags.map(function (f) { return '<li>' + esc(f.text) + '</li>'; }).join('') + '</ul>' : '';
    return tradeChartHtml(a, p, compact ? '-c' : '') + '<div class="detail-grid"><div>' + legTable + shares + flags + '</div><dl class="kv">' +
      kv.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl></div>';
  }

  function renderPositions() {
    var el = $('positions');
    if (!state.positions.length) { el.innerHTML = '<p class="empty">No trades yet.</p>'; return; }
    var order = analyses.map(function (a, i) { return i; }).sort(function (x, y) {
      var d = C.SEVERITY[analyses[y].status] - C.SEVERITY[analyses[x].status];
      return d || String(analyses[x].ticker).localeCompare(String(analyses[y].ticker));
    });
    var rows = '', cards = '';
    order.forEach(function (i) {
      var a = analyses[i], p = state.positions[i], id = esc(p.id);
      var ok = !(a.errors && a.errors.length);
      var cap = ok && a.captured !== null ? Math.round(a.captured) + '%' : '—';
      var dte = ok && a.nearestDte !== null ? a.nearestDte : '—';
      var acts = '<button type="button" class="linkbtn" data-detail="' + id + '">' + (openDetails[p.id] ? 'Hide' : 'Details') + '</button>' +
        '<button type="button" class="linkbtn" data-edit="' + id + '">Edit</button>' +
        '<button type="button" class="linkbtn danger" data-del="' + id + '">Delete</button>';
      rows += '<tr><td><span class="pill ' + a.status + '">' + STATUS_TEXT[a.status] + '</span></td>' +
        '<td class="trade"><b>' + esc(a.ticker) + '</b><span class="tag">' + esc(a.st ? a.st.short : '?') + '</span><span class="legs">' + esc(describe(p)) + '</span></td>' +
        '<td class="n">' + dte + '</td><td class="n">' + (ok ? n2(a.S) + srcTag(a.sSrc) : '—') + '</td>' +
        '<td class="n ' + (ok ? cls(a.pl) : '') + '">' + (ok ? signedMoney(a.pl) : '—') + '</td><td class="n">' + cap + '</td>' +
        '<td class="n">' + (ok ? money(a.maxLoss) : '—') + '</td><td class="n ' + (ok ? cls(a.deltaDollars) : '') + '">' + (ok ? signedMoney(a.deltaDollars) : '—') + '</td>' +
        '<td class="n ' + (ok ? cls(a.theta) : '') + '">' + (ok ? money2(a.theta) : '—') + '</td>' +
        '<td class="acts">' + acts + '</td></tr>';
      if (openDetails[p.id]) rows += '<tr class="detail-row"><td colspan="10">' + detailHtml(a, p) + '</td></tr>';

      cards += '<div class="pcard"><div class="top2"><div><b>' + esc(a.ticker) + '</b><span class="tag">' + esc(a.st ? a.st.short : '?') + '</span></div><span class="pill ' + a.status + '">' + STATUS_TEXT[a.status] + '</span></div>' +
        '<div class="legs">' + esc(describe(p)) + '</div>' +
        '<dl><dt>Days left</dt><dd>' + dte + '</dd><dt>Stock</dt><dd>' + (ok ? n2(a.S) : '—') + '</dd>' +
        '<dt>P/L</dt><dd class="' + (ok ? cls(a.pl) : '') + '">' + (ok ? signedMoney(a.pl) : '—') + '</dd><dt>Profit captured</dt><dd>' + cap + '</dd>' +
        '<dt>Max loss</dt><dd>' + (ok ? money(a.maxLoss) : '—') + '</dd><dt>Delta $</dt><dd>' + (ok ? signedMoney(a.deltaDollars) : '—') + '</dd>' +
        '<dt>Theta/day</dt><dd>' + (ok ? money2(a.theta) : '—') + '</dd></dl>' +
        (openDetails[p.id] ? '<div class="detail-box">' + detailHtml(a, p, true) + '</div>' : '') +
        '<div class="acts">' + acts + '</div></div>';
    });
    el.innerHTML = '<table class="ptable"><thead><tr><th>Status</th><th>Trade</th><th class="n">Days left</th><th class="n">Stock</th><th class="n">P/L</th><th class="n">Profit captured</th><th class="n">Max loss</th><th class="n">Delta $</th><th class="n">Theta/day</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table><div class="pcards">' + cards + '</div>' +
      '<p class="note">"Days left" is for the nearest short option. "Profit captured" is the share of the credit you have kept so far (for covered calls and PMCCs, of the short call). <span class="src">auto</span> = filled in automatically, <span class="src">typed</span> = typed by you, <span class="src">est.</span> = estimated between full option updates.</p>';
    drawCharts();
  }

  // ---------- trade form ----------
  var editingId = null;
  function strategyOptions() {
    $('f-strategy').innerHTML = Object.keys(C.STRATEGIES).map(function (k) {
      return '<option value="' + k + '">' + esc(C.STRATEGIES[k].name) + '</option>';
    }).join('');
  }
  function buildLegFields(strategy, p) {
    var st = C.STRATEGIES[strategy];
    var legs = (p && p.strategy === strategy && p.legs) || [];
    var html = '';
    var expA = '', expB = '';
    legs.forEach(function (l, i) { if (st.legs[i] && st.legs[i].exp === 'a') expA = expA || l.expiry; if (st.legs[i] && st.legs[i].exp === 'b') expB = expB || l.expiry; });
    if (st.legs.length) {
      html += '<div class="row2 expbox">';
      if (strategy === 'pmcc') {
        html += '<label>Long call (LEAPS) expiration <input type="date" id="f-exp-b" value="' + esc(expB) + '"></label>';
        html += '<label>Short call expiration <input type="date" id="f-exp-a" value="' + esc(expA) + '"></label>';
      } else {
        html += '<label>Expiration <input type="date" id="f-exp-a" value="' + esc(expA) + '"></label><span></span>';
      }
      html += '</div><p class="hint">Prices are per share, the way your broker shows them (1.10, not 110). "Price now" fills in automatically when available.</p>';
    }
    st.legs.forEach(function (t, i) {
      var l = legs[i] || {};
      html += '<div class="legbox"><div class="lt"><span class="side ' + t.side + '">' + (t.side === 'sell' ? 'SOLD' : 'BOUGHT') + '</span>' + esc(t.role) + '</div><div class="row3">' +
        '<label>Strike <input id="f-strike-' + i + '" inputmode="decimal" value="' + esc(l.strike) + '"></label>' +
        '<label>' + (t.side === 'sell' ? 'Received' : 'Paid') + ' <input id="f-fill-' + i + '" inputmode="decimal" value="' + esc(l.fill) + '"></label>' +
        '<label>Price now <input id="f-mark-' + i + '" inputmode="decimal" value="' + esc(l.mark) + '"></label>' +
        '</div></div>';
    });
    if (st.shares) {
      html += '<div class="legbox"><div class="lt">Shares</div><div class="row2" style="margin:0">' +
        '<label>Number of shares <input id="f-shq" inputmode="numeric" value="' + esc(p && p.strategy === strategy ? p.sharesQty : '') + '"></label>' +
        '<label>Cost per share <input id="f-shc" inputmode="decimal" value="' + esc(p && p.strategy === strategy ? p.sharesCost : '') + '"></label></div></div>';
    }
    $('legFields').innerHTML = html;
    $('qtyLabel').style.visibility = st.legs.length ? 'visible' : 'hidden';
  }
  function openForm(p) {
    editingId = p ? p.id : null;
    $('dlgTitle').textContent = p ? 'Edit trade' : 'Add a trade';
    $('formErrors').hidden = true;
    var strategy = p ? p.strategy : ($('f-strategy').value || 'csp');
    $('f-strategy').value = strategy;
    $('f-ticker').value = p ? p.ticker : '';
    $('f-qty').value = p ? (p.qty || '') : '';
    $('f-stock').value = p ? (p.stockPrice || '') : '';
    $('f-earn').value = p ? (p.earnings || '') : '';
    $('f-exdiv').value = p ? (p.exDiv || '') : '';
    $('f-beta').value = p ? (p.beta || '') : '';
    $('f-divy').value = p ? (p.divYield || '') : '';
    $('f-sector').value = p ? (p.sector || '') : '';
    $('f-open').value = p ? (p.openDate || '') : '';
    $('f-notes').value = p ? (p.notes || '') : '';
    buildLegFields(strategy, p);
    var d = $('tradeDialog');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    $('f-ticker').focus();
  }
  function closeForm() { var d = $('tradeDialog'); if (d.close) d.close(); else d.removeAttribute('open'); }
  function readForm() {
    var strategy = $('f-strategy').value, st = C.STRATEGIES[strategy];
    var v = function (id) { var e = $(id); return e ? e.value.trim() : ''; };
    var p = {
      id: editingId || newId(), strategy: strategy, ticker: v('f-ticker').toUpperCase(),
      qty: st.legs.length ? C.num(v('f-qty')) : null, stockPrice: v('f-stock'),
      earnings: v('f-earn'), exDiv: v('f-exdiv'), beta: v('f-beta'), divYield: v('f-divy'), sector: v('f-sector'), openDate: v('f-open'), notes: v('f-notes'),
      legs: st.legs.map(function (t, i) {
        return { side: t.side, type: t.type, strike: v('f-strike-' + i), expiry: v(t.exp === 'b' ? 'f-exp-b' : 'f-exp-a'), fill: v('f-fill-' + i), mark: v('f-mark-' + i) };
      })
    };
    if (st.shares) { p.sharesQty = C.num(v('f-shq')); p.sharesCost = v('f-shc'); }
    return p;
  }
  function submitForm(ev) {
    ev.preventDefault();
    var p = readForm();
    var errs = C.validate(p);
    if (errs.length) {
      $('formErrors').innerHTML = errs.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('');
      $('formErrors').hidden = false;
      $('formErrors').scrollIntoView({ block: 'nearest' });
      return;
    }
    var idx = state.positions.findIndex(function (x) { return x.id === p.id; });
    if (idx >= 0) state.positions[idx] = p; else state.positions.push(p);
    saveState(); closeForm(); render();
    toast(idx >= 0 ? 'Trade updated.' : 'Trade added.');
    if (prices && !prices.chains[p.ticker]) refreshPrices(true);
  }

  // ---------- files ----------
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function saveFile() {
    var data = { app: 'options-risk-check', version: 1, saved: new Date().toISOString(), account: state.account, cfg: state.cfg, positions: state.positions };
    download('options-risk-check-backup-' + C.isoToday(new Date()) + '.json', JSON.stringify(data, null, 2), 'application/json');
    toast('Backup file saved to your downloads.');
  }
  function loadFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(reader.result);
        if (!d || d.app !== 'options-risk-check' || !Array.isArray(d.positions)) throw new Error('bad');
        state = { account: Object.assign({ value: '', cash: '', type: 'cash' }, d.account || {}), cfg: Object.assign({}, C.DEFAULTS, d.cfg || {}), positions: d.positions, examples: false };
        saveState(); initAccountValues(); buildSettings(); render();
        toast('Loaded ' + d.positions.length + ' trade(s) from the file.');
      } catch (e) { toast('That file is not an Options Risk Check backup.'); }
    };
    reader.readAsText(file);
  }
  function initAccountValues() {
    $('accValue').value = state.account.value || ''; $('accCash').value = state.account.cash || ''; $('accType').value = state.account.type || 'cash';
  }
  function csvCell(v) { var s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function round2(v) { return v === null || v === undefined || !isFinite(v) ? '' : Math.round(v * 100) / 100; }
  function downloadCsv() {
    var head = ['Ticker', 'Strategy', 'Trade', 'Status', 'Stock price', 'Days left (nearest short)', 'P/L', 'Profit captured %', 'Max profit', 'Max loss', 'Cash needed', 'Position delta', 'Delta $', 'Beta-weighted delta $', 'Theta/day', 'Gamma', 'Vega', 'Sector', 'Earnings', 'Ex-dividend', 'Alerts'];
    var lines = [head.map(csvCell).join(',')];
    analyses.forEach(function (a, i) {
      var p = state.positions[i];
      lines.push([a.ticker, a.st ? a.st.name : '', describe(p), STATUS_TEXT[a.status], round2(a.S), a.nearestDte, round2(a.pl), a.captured === null || a.captured === undefined ? '' : Math.round(a.captured),
        round2(a.maxProfit), round2(a.maxLoss), round2(a.collateral), a.posDelta === null || a.posDelta === undefined ? '' : Math.round(a.posDelta * 10) / 10, round2(a.deltaDollars), round2(a.bwDeltaDollars), round2(a.theta), a.posGamma === null || a.posGamma === undefined ? '' : Math.round(a.posGamma * 1000) / 1000, round2(a.vega),
        a.sector || '', a.earnings || '', a.exDiv || '', (a.flags || []).map(function (f) { return f.text; }).join(' | ')].map(csvCell).join(','));
    });
    if (summary) {
      lines.push('');
      lines.push(['Account totals'].map(csvCell).join(','));
      lines.push(['Cash needed', round2(summary.cashNeeded)].map(csvCell).join(','));
      lines.push(['Cash available', round2(summary.cash)].map(csvCell).join(','));
      lines.push(['Delta $', round2(summary.deltaDollars)].map(csvCell).join(','));
      lines.push(['Beta-weighted delta $', round2(summary.bwDeltaDollars)].map(csvCell).join(','));
      lines.push(['Open P/L', round2(summary.pl)].map(csvCell).join(','));
      lines.push(['Theta/day', round2(summary.theta)].map(csvCell).join(','));
      lines.push(['Vega (per 1 IV point)', round2(summary.vega)].map(csvCell).join(','));
      lines.push(['Gamma (delta $ change per 1% SPY)', round2(summary.gamma1pct)].map(csvCell).join(','));
    }
    download('options-risk-check-' + C.isoToday(new Date()) + '.csv', '﻿' + lines.join('\r\n'), 'text/csv');
    toast('Spreadsheet saved to your downloads.');
  }

  // ---------- example trades (made-up tickers and prices) ----------
  function fridayAfter(days) {
    var d = new Date(); d.setDate(d.getDate() + days);
    while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
    return C.isoToday(d);
  }
  function dateAfter(days) { var d = new Date(); d.setDate(d.getDate() + days); return C.isoToday(d); }
  function loadExamples() {
    var e30 = fridayAfter(28), e9 = fridayAfter(7), e23 = fridayAfter(21), e5 = fridayAfter(2), e37 = fridayAfter(35), e400 = fridayAfter(400);
    var L = function (side, type, strike, expiry, fill, mark) { return { side: side, type: type, strike: String(strike), expiry: expiry, fill: String(fill), mark: String(mark) }; };
    state = freshState();
    state.examples = true;
    state.account = { value: '100000', cash: '60000', type: 'cash' };
    state.positions = [
      { id: newId(), strategy: 'csp', ticker: 'DEMO-A', qty: 2, stockPrice: '48.20', beta: '1.3', sector: 'Technology', legs: [L('sell', 'put', 45, e30, 1.10, 0.55)] },
      { id: newId(), strategy: 'csp', ticker: 'DEMO-B', qty: 1, stockPrice: '101.50', beta: '1.1', sector: 'Consumer', earnings: dateAfter(4), legs: [L('sell', 'put', 100, e9, 2.40, 2.10)] },
      { id: newId(), strategy: 'cc', ticker: 'DEMO-C', qty: 2, stockPrice: '58.40', beta: '0.9', sector: 'Industrials', sharesQty: 200, sharesCost: '62', legs: [L('sell', 'call', 60, e23, 0.95, 0.70)] },
      { id: newId(), strategy: 'pcs', ticker: 'DEMO-D', qty: 3, stockPrice: '212', beta: '1.2', sector: 'Technology', legs: [L('sell', 'put', 205, e5, 1.35, 1.60), L('buy', 'put', 200, e5, 0.45, 0.30)] },
      { id: newId(), strategy: 'ic', ticker: 'DEMO-E', qty: 1, stockPrice: '455', beta: '1.0', sector: 'Index ETF', legs: [L('buy', 'put', 420, e37, 1.20, 0.70), L('sell', 'put', 425, e37, 1.85, 1.10), L('sell', 'call', 485, e37, 1.70, 1.40), L('buy', 'call', 490, e37, 1.05, 0.80)] },
      { id: newId(), strategy: 'pmcc', ticker: 'DEMO-F', qty: 1, stockPrice: '130', beta: '1.4', sector: 'Technology', exDiv: dateAfter(12), legs: [L('buy', 'call', 100, e400, 36.50, 38.20), L('sell', 'call', 135, e30, 2.10, 1.60)] },
      { id: newId(), strategy: 'shares', ticker: 'DEMO-G', stockPrice: '27.50', beta: '0.8', sector: 'Energy', sharesQty: 100, sharesCost: '30', legs: [] }
    ];
    saveState(); initAccountValues(); buildSettings(); render();
    toast('Example trades loaded. They use made-up tickers and prices.');
  }

  var clearArmed = false, clearTimer = null;
  function clearAll(btn) {
    if (!clearArmed) {
      clearArmed = true; btn.textContent = 'Press again to delete every trade';
      clearTimeout(clearTimer); clearTimer = setTimeout(function () { clearArmed = false; btn.textContent = 'Clear everything'; }, 4000);
      return false;
    }
    clearArmed = false; btn.textContent = 'Clear everything';
    state = freshState(); saveState(); initAccountValues(); buildSettings(); render();
    toast('Everything cleared.');
    return true;
  }

  // ---------- wiring ----------
  var delArmed = null, delTimer = null;
  function onClick(ev) {
    var t = ev.target.closest('button'); if (!t) return;
    if (t.hasAttribute('data-edit')) {
      var p = state.positions.find(function (x) { return x.id === t.getAttribute('data-edit'); });
      if (p) openForm(p);
    } else if (t.hasAttribute('data-detail')) {
      var id = t.getAttribute('data-detail'); openDetails[id] = !openDetails[id]; renderPositions();
    } else if (t.hasAttribute('data-del')) {
      var did = t.getAttribute('data-del');
      if (delArmed !== did) {
        delArmed = did;
        Array.prototype.forEach.call(document.querySelectorAll('[data-del="' + did + '"]'), function (b) { b.textContent = 'Confirm delete'; });
        clearTimeout(delTimer); delTimer = setTimeout(function () { delArmed = null; renderPositions(); }, 4000);
        return;
      }
      delArmed = null;
      state.positions = state.positions.filter(function (x) { return x.id !== did; });
      if (!state.positions.length) state.examples = false;
      saveState(); render(); toast('Trade deleted.');
    } else if (t.hasAttribute('data-act')) {
      var act = t.getAttribute('data-act');
      if (act !== 'clear') $('moreMenu').removeAttribute('open');
      if (act === 'save-file') saveFile();
      else if (act === 'load-file') $('fileInput').click();
      else if (act === 'csv') downloadCsv();
      else if (act === 'examples') loadExamples();
      else if (act === 'clear') { if (clearAll(t)) $('moreMenu').removeAttribute('open'); }
    }
  }

  function init() {
    strategyOptions();
    initAccount();
    document.addEventListener('click', onClick);
    $('btnAdd').addEventListener('click', function () { openForm(null); });
    $('btnAdd2').addEventListener('click', function () { openForm(null); });
    $('btnRefresh').addEventListener('click', function () { refreshPrices(false); });
    $('f-strategy').addEventListener('change', function () {
      var cur = editingId ? state.positions.find(function (x) { return x.id === editingId; }) : null;
      buildLegFields($('f-strategy').value, cur);
    });
    $('tradeForm').addEventListener('submit', submitForm);
    $('dlgCancel').addEventListener('click', closeForm);
    $('dlgClose').addEventListener('click', closeForm);
    $('fileInput').addEventListener('change', function () { if (this.files && this.files[0]) loadFile(this.files[0]); this.value = ''; });
    document.addEventListener('click', function (ev) {
      var m = $('moreMenu'); if (m.open && !m.contains(ev.target)) m.removeAttribute('open');
    });
    if (!state.positions.length) $('guide').setAttribute('open', '');
    render();
    refreshPrices(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
