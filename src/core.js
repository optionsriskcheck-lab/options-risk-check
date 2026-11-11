/* Options Risk Check — core math. No page code in here, so it can be tested on its own. */
(function (root) {
  'use strict';

  var DAY = 86400000;

  var STRATEGIES = {
    csp:    { name: 'Cash-secured put', short: 'CSP', shares: false, creditStrategy: true,
              legs: [{ side: 'sell', type: 'put', role: 'Short put', exp: 'a' }] },
    cc:     { name: 'Covered call', short: 'CC', shares: true, creditStrategy: true,
              legs: [{ side: 'sell', type: 'call', role: 'Short call', exp: 'a' }] },
    shares: { name: 'Shares', short: 'Shares', shares: true, creditStrategy: false, legs: [] },
    pcs:    { name: 'Put credit spread', short: 'PCS', shares: false, creditStrategy: true,
              legs: [{ side: 'sell', type: 'put', role: 'Short put (higher strike)', exp: 'a' },
                     { side: 'buy',  type: 'put', role: 'Long put (lower strike)', exp: 'a' }] },
    ccs:    { name: 'Call credit spread', short: 'CCS', shares: false, creditStrategy: true,
              legs: [{ side: 'sell', type: 'call', role: 'Short call (lower strike)', exp: 'a' },
                     { side: 'buy',  type: 'call', role: 'Long call (higher strike)', exp: 'a' }] },
    ic:     { name: 'Iron condor', short: 'IC', shares: false, creditStrategy: true,
              legs: [{ side: 'buy',  type: 'put',  role: 'Long put (lowest strike)', exp: 'a' },
                     { side: 'sell', type: 'put',  role: 'Short put', exp: 'a' },
                     { side: 'sell', type: 'call', role: 'Short call', exp: 'a' },
                     { side: 'buy',  type: 'call', role: 'Long call (highest strike)', exp: 'a' }] },
    pmcc:   { name: "Poor man's covered call", short: 'PMCC', shares: false, creditStrategy: false,
              legs: [{ side: 'buy',  type: 'call', role: 'Long call (LEAPS)', exp: 'b' },
                     { side: 'sell', type: 'call', role: 'Short call', exp: 'a' }] }
  };

  // Common starting points. Every member can change these on the page.
  var DEFAULTS = {
    dteAlert: 21,        // days to expiry: start managing
    dteUrgent: 7,        // days to expiry: gamma risk is high
    profitTarget: 50,    // % of max profit captured
    deltaAlert: 0.40,    // short option delta (ignoring the sign)
    nearStrikePct: 3,    // stock within this % of a short strike
    maxTickerPct: 10,    // % of account in one ticker
    maxSectorPct: 30,    // % of account in one sector
    maxCashPct: 100,     // cash needed as % of cash available
    leapsDte: 120,       // PMCC long call: roll window
    leapsDeltaMin: 0.70, // PMCC long call: minimum delta
    rate: 4.0            // interest rate % used in the option math
  };

  var SEVERITY = { act: 4, watch: 3, data: 2, good: 1, info: 0 };

  // ---------- small helpers ----------
  function num(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).replace(/[$,\s]/g, '');
    if (s === '') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function sum(arr) { var t = 0; for (var i = 0; i < arr.length; i++) t += arr[i]; return t; }
  function parseDate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var p = s.split('-').map(Number);
    var t = Date.UTC(p[0], p[1] - 1, p[2]);
    return isFinite(t) ? t : null;
  }
  function todayUTC(now) { return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()); }
  function daysTo(s, now) {
    var e = parseDate(s);
    if (e === null) return null;
    return Math.round((e - todayUTC(now)) / DAY);
  }
  // Options stop trading at 4:00 PM New York time (about 21:00 UTC in winter, 20:00 in summer).
  function yearsTo(s, now) {
    var e = parseDate(s);
    if (e === null) return null;
    var close = e + 21 * 3600000;
    return Math.max(close - now.getTime(), 0) / (365 * DAY);
  }
  function isoToday(now) {
    var m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
    return now.getFullYear() + '-' + m + '-' + d;
  }

  // ---------- option math (Black-Scholes, no dividends) ----------
  function normCdf(x) {
    // Abramowitz & Stegun 7.1.26, accurate to about 1e-7
    var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    var sign = x < 0 ? -1 : 1;
    var z = Math.abs(x) / Math.SQRT2;
    var t = 1 / (1 + p * z);
    var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * y);
  }

  function bs(type, S, K, T, r, v) {
    if (!(T > 0) || !(v > 0)) {
      var intrinsic = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
      var d = type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
      return { price: intrinsic, delta: d };
    }
    var sq = v * Math.sqrt(T);
    var d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / sq;
    var d2 = d1 - sq;
    if (type === 'call') {
      return { price: S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2), delta: normCdf(d1) };
    }
    return { price: K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1), delta: normCdf(d1) - 1 };
  }

  // Works backwards from an option's price to its implied volatility.
  function impliedVol(type, price, S, K, T, r) {
    if (!(price >= 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
    var lo = 0.005, hi = 5;
    if (price <= bs(type, S, K, T, r, lo).price) return lo;
    if (price >= bs(type, S, K, T, r, hi).price) return null;
    for (var i = 0; i < 100; i++) {
      var mid = (lo + hi) / 2;
      if (bs(type, S, K, T, r, mid).price > price) hi = mid; else lo = mid;
      if (hi - lo < 1e-7) break;
    }
    return (lo + hi) / 2;
  }

  // ---------- automatic price file ----------
  // prices = { stocks_updated, stocks: {TK:{price}}, info: {TK:{beta,sector,earnings,exdiv}},
  //            chains: {TK: {updated, S, exps: {'YYYY-MM-DD': {P: [[strike,bid,ask,last,iv],...], C: [...]}}}} }
  function chainFor(prices, tk) {
    return (prices && prices.chains && prices.chains[tk] && prices.chains[tk].exps) ? prices.chains[tk] : null;
  }
  function lookupOption(prices, tk, type, expiry, K) {
    var ch = chainFor(prices, tk);
    if (!ch || !ch.exps[expiry]) return null;
    var rows = ch.exps[expiry][type === 'put' ? 'P' : 'C'];
    if (!rows) return null;
    for (var i = 0; i < rows.length; i++) {
      if (Math.abs(rows[i][0] - K) < 0.001) {
        return { bid: num(rows[i][1]) || 0, ask: num(rows[i][2]) || 0, last: num(rows[i][3]) || 0, iv: num(rows[i][4]) || 0 };
      }
    }
    return null;
  }
  function chainsFresh(prices, tk) {
    var ch = chainFor(prices, tk);
    if (!ch || !prices.stocks_updated || !ch.updated) return false;
    var a = Date.parse(prices.stocks_updated), b = Date.parse(ch.updated);
    return isFinite(a) && isFinite(b) && Math.abs(a - b) <= 20 * 60000;
  }

  // ---------- checking what the member typed ----------
  function validate(p) {
    var errs = [];
    var st = STRATEGIES[p.strategy];
    if (!st) { errs.push('Pick a strategy.'); return errs; }
    if (!p.ticker || !/^[A-Za-z0-9.\-^]{1,12}$/.test(p.ticker)) errs.push('Enter a ticker (letters, numbers, dots or dashes).');
    if (st.legs.length) {
      var q = num(p.qty);
      if (!(q > 0) || Math.round(q) !== q) errs.push('Contracts must be a whole number above zero.');
      (p.legs || []).forEach(function (l, i) {
        var role = st.legs[i] ? st.legs[i].role : 'Leg ' + (i + 1);
        if (!(num(l.strike) > 0)) errs.push(role + ': enter the strike.');
        if (parseDate(l.expiry) === null) errs.push(role + ': enter the expiration date.');
        if (!(num(l.fill) >= 0)) errs.push(role + ': enter the price you ' + (l.side === 'sell' ? 'received' : 'paid') + ' per share.');
        if (l.mark !== '' && l.mark !== null && l.mark !== undefined && !(num(l.mark) >= 0)) errs.push(role + ': the current price must be a number.');
      });
      if ((p.legs || []).length !== st.legs.length) errs.push('This strategy needs ' + st.legs.length + ' leg(s).');
    }
    if (st.shares) {
      var Q = num(p.sharesQty);
      if (!(Q > 0)) errs.push('Enter the number of shares.');
      if (!(num(p.sharesCost) > 0)) errs.push('Enter your cost per share.');
    }
    if (p.stockPrice !== '' && p.stockPrice !== null && p.stockPrice !== undefined && !(num(p.stockPrice) > 0)) errs.push('The stock price must be a number above zero.');
    if (errs.length) return errs;

    var L = p.legs, K = function (i) { return num(L[i].strike); };
    if (p.strategy === 'pcs' && !(K(1) < K(0))) errs.push('The long put strike must be below the short put strike.');
    if (p.strategy === 'ccs' && !(K(1) > K(0))) errs.push('The long call strike must be above the short call strike.');
    if (p.strategy === 'ic' && !(K(0) < K(1) && K(1) < K(2) && K(2) < K(3)))
      errs.push('Iron condor strikes must go up in order: long put, short put, short call, long call.');
    if (p.strategy === 'pmcc' && !(parseDate(L[0].expiry) > parseDate(L[1].expiry)))
      errs.push('The long call (LEAPS) must expire after the short call.');
    if (p.strategy === 'pmcc' && !(K(0) < K(1))) errs.push('The long call strike should be below the short call strike.');
    return errs;
  }

  // ---------- one position ----------
  function analyzePosition(p, cfgIn, prices, now) {
    var cfg = Object.assign({}, DEFAULTS, cfgIn || {});
    var r = (num(cfg.rate) === null ? 4 : num(cfg.rate)) / 100;
    var st = STRATEGIES[p.strategy];
    var tk = String(p.ticker || '').toUpperCase();
    var out = { id: p.id, ticker: tk, strategy: p.strategy, st: st, flags: [], r: r, errors: validate(p) };
    if (out.errors.length) {
      out.flags.push({ sev: 'data', text: 'This trade has missing or wrong details: ' + out.errors[0] });
      out.status = 'data';
      return out;
    }

    var auto = prices && prices.stocks && prices.stocks[tk];
    var info = (prices && prices.info && prices.info[tk]) || {};
    var S = null, sSrc = null;
    if (auto && num(auto.price) > 0) { S = num(auto.price); sSrc = 'auto'; }
    else if (num(p.stockPrice) > 0) { S = num(p.stockPrice); sSrc = 'typed'; }
    var beta = num(p.beta) !== null ? num(p.beta) : num(info.beta);
    out.S = S; out.sSrc = sSrc;
    out.beta = beta; out.betaUsed = beta === null ? 1 : beta;
    out.sector = (p.sector && String(p.sector).trim()) || info.sector || 'Unknown';
    out.earnings = p.earnings || info.earnings || null;
    out.exDiv = p.exDiv || info.exdiv || null;

    var q = st.legs.length ? num(p.qty) : 0;
    var fresh = chainsFresh(prices, tk);
    out.autoLoaded = !!(prices && prices.stocks);
    out.autoCovered = !!auto;
    out.chainLoaded = !!chainFor(prices, tk);

    var legs = (p.legs || []).map(function (l) {
      var K = num(l.strike), fill = num(l.fill);
      var sign = l.side === 'buy' ? 1 : -1;
      var T = yearsTo(l.expiry, now), dte = daysTo(l.expiry, now);
      var mark = null, mSrc = null, iv = null;
      var o = lookupOption(prices, tk, l.type, l.expiry, K);
      if (o && S > 0) {
        var quote = o.bid > 0 && o.ask > 0;
        if (fresh && quote) { mark = (o.bid + o.ask) / 2; mSrc = 'auto'; }
        else if (o.iv > 0 && T > 0) { iv = o.iv; mark = bs(l.type, S, K, T, r, iv).price; mSrc = 'estimate'; }
        else if (quote) { mark = (o.bid + o.ask) / 2; mSrc = 'auto'; }
        else if (o.last > 0) { mark = o.last; mSrc = 'auto'; }
      }
      if (mark === null && num(l.mark) !== null && num(l.mark) >= 0) { mark = num(l.mark); mSrc = 'typed'; }
      if (iv === null && mark !== null && S > 0 && T > 0) iv = impliedVol(l.type, mark, S, K, T, r);
      var delta = null;
      if (S > 0 && T !== null) {
        if (!(T > 0)) delta = bs(l.type, S, K, 0, r, 0).delta;
        else if (iv) delta = bs(l.type, S, K, T, r, iv).delta;
      }
      return {
        side: l.side, type: l.type, expiry: l.expiry, K: K, fill: fill, q: q, sign: sign, T: T, dte: dte,
        mark: mark, mSrc: mSrc, iv: iv, delta: delta,
        posDelta: delta === null ? null : sign * delta * 100 * q,
        pl: mark === null ? null : sign * (mark - fill) * 100 * q,
        itm: S > 0 ? (l.type === 'put' ? S < K : S > K) : null,
        otmPct: S > 0 ? (l.type === 'put' ? (S - K) / S : (K - S) / S) * 100 : null
      };
    });
    out.legs = legs;
    out.q = q;

    var Q = st.shares ? (num(p.sharesQty) || 0) : 0;
    var C = st.shares ? num(p.sharesCost) : null;
    out.Q = Q; out.C = C;
    out.sharesPL = (Q && S > 0 && C !== null) ? (S - C) * Q : (Q ? null : 0);

    var credit = sum(legs.map(function (l) { return -l.sign * l.fill * 100 * l.q; }));
    out.credit = credit;
    var optPL = legs.length && legs.every(function (l) { return l.pl !== null; }) ? sum(legs.map(function (l) { return l.pl; })) : (legs.length ? null : 0);
    out.optPL = optPL;
    out.pl = (optPL === null || out.sharesPL === null) ? null : optPL + out.sharesPL;

    var shortLegs = legs.filter(function (l) { return l.sign < 0; });
    var longLegs = legs.filter(function (l) { return l.sign > 0; });
    var find = function (arr, type) { return arr.filter(function (l) { return l.type === type; })[0]; };

    var maxProfit = null, maxLoss = null, collateral = 0, capital = null, breakevens = [], captured = null, maxProfitIsEstimate = false;
    switch (p.strategy) {
      case 'csp': {
        var sp = shortLegs[0];
        collateral = sp.K * 100 * q; capital = collateral;
        maxProfit = credit; maxLoss = collateral - credit;
        breakevens = [sp.K - credit / (100 * q)];
        break;
      }
      case 'cc': {
        var sc = shortLegs[0];
        var covered = Math.min(Q, 100 * q);
        capital = (S > 0 ? S : C) * Q;
        maxProfit = (sc.K - C) * covered + credit;
        maxLoss = C * Q - credit;
        breakevens = Q > 0 ? [C - credit / Q] : [];
        break;
      }
      case 'shares': {
        capital = (S > 0 ? S : C) * Q; maxLoss = C * Q; breakevens = [C];
        break;
      }
      case 'pcs': {
        var s1 = find(shortLegs, 'put'), l1 = find(longLegs, 'put');
        collateral = (s1.K - l1.K) * 100 * q;
        maxProfit = credit; maxLoss = collateral - credit; capital = maxLoss;
        breakevens = [s1.K - credit / (100 * q)];
        break;
      }
      case 'ccs': {
        var s2 = find(shortLegs, 'call'), l2 = find(longLegs, 'call');
        collateral = (l2.K - s2.K) * 100 * q;
        maxProfit = credit; maxLoss = collateral - credit; capital = maxLoss;
        breakevens = [s2.K + credit / (100 * q)];
        break;
      }
      case 'ic': {
        var sP = find(shortLegs, 'put'), lP = find(longLegs, 'put'), sC = find(shortLegs, 'call'), lC = find(longLegs, 'call');
        collateral = Math.max(sP.K - lP.K, lC.K - sC.K) * 100 * q;
        maxProfit = credit; maxLoss = collateral - credit; capital = maxLoss;
        breakevens = [sP.K - credit / (100 * q), sC.K + credit / (100 * q)];
        break;
      }
      case 'pmcc': {
        var lc = longLegs[0], scl = shortLegs[0];
        var debit = -credit;
        maxLoss = debit; capital = debit;
        if (lc.iv && lc.T !== null && scl.T !== null) {
          var left = Math.max(lc.T - scl.T, 0);
          maxProfit = bs('call', scl.K, lc.K, left, r, lc.iv).price * 100 * q - debit;
          maxProfitIsEstimate = true;
        }
        out.pmccMinShortStrike = lc.K + debit / (100 * q);
        break;
      }
    }
    out.maxProfit = maxProfit; out.maxLoss = maxLoss; out.collateral = collateral; out.capital = capital;
    out.breakevens = breakevens; out.maxProfitIsEstimate = maxProfitIsEstimate;

    if (st.creditStrategy && p.strategy !== 'cc') {
      if (optPL !== null && credit > 0) captured = optPL / credit * 100;
    } else if (p.strategy === 'cc') {
      var c0 = legs[0];
      if (c0.pl !== null && c0.fill > 0) captured = (c0.fill - c0.mark) / c0.fill * 100;
    } else if (p.strategy === 'pmcc') {
      var s0 = shortLegs[0];
      if (s0.mark !== null && s0.fill > 0) captured = (s0.fill - s0.mark) / s0.fill * 100;
    }
    out.captured = captured;

    var deltaKnown = legs.every(function (l) { return l.posDelta !== null; });
    out.posDelta = deltaKnown ? sum(legs.map(function (l) { return l.posDelta; })) + Q : null;
    out.deltaDollars = (out.posDelta !== null && S > 0) ? out.posDelta * S : null;
    out.bwDeltaDollars = out.deltaDollars === null ? null : out.deltaDollars * out.betaUsed;

    var shortDtes = shortLegs.map(function (l) { return l.dte; });
    out.nearestDte = shortDtes.length ? Math.min.apply(null, shortDtes) : (legs.length ? Math.min.apply(null, legs.map(function (l) { return l.dte; })) : null);

    out.flags = buildFlags(p, out, cfg, now);
    out.status = out.flags.length ? out.flags.reduce(function (a, f) { return SEVERITY[f.sev] > SEVERITY[a] ? f.sev : a; }, 'info') : 'ok';
    if (out.status === 'info') out.status = 'ok';
    return out;
  }

  function fmtK(k) { return (Math.round(k * 100) / 100).toString(); }
  function fmtD(s) {
    var t = parseDate(s); if (t === null) return s || '';
    var d = new Date(t);
    var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    return mon + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }
  function legName(l) { return fmtK(l.K) + ' ' + l.type; }

  function buildFlags(p, a, cfg, now) {
    var f = [];
    var add = function (sev, text) { f.push({ sev: sev, text: text }); };
    var S = a.S;
    var today = isoToday(now);

    if (!(S > 0)) {
      if (a.autoLoaded && !a.autoCovered) add('data', a.ticker + ' is not on the automatic price list. Type the current stock price to see where this trade stands.');
      else add('data', 'Enter the current stock price to see where this trade stands.');
    }
    a.legs.forEach(function (l) {
      if (l.mark === null && a.chainLoaded && l.dte !== null && l.dte >= 0) add('data', 'The ' + fmtD(l.expiry) + ' expiration is not in the automatic option prices. Type the current price of the ' + legName(l) + '.');
      else if (l.mark === null) add('data', 'Enter the current price of the ' + legName(l) + ' to get its P/L and delta.');
      else if (l.delta === null && S > 0) add('data', 'The current price of the ' + legName(l) + ' looks off, so delta could not be worked out. Check it.');
    });

    var expired = a.legs.filter(function (l) { return l.dte !== null && l.dte < 0; });
    if (expired.length) add('info', 'Part of this trade has expired. Update or remove it.');

    var shortLegs = a.legs.filter(function (l) { return l.sign < 0 && l.dte !== null && l.dte >= 0; });

    // Days to expiration (one message for the nearest short leg)
    if (shortLegs.length) {
      var dte = Math.min.apply(null, shortLegs.map(function (l) { return l.dte; }));
      if (dte <= cfg.dteUrgent) add('act', dte + (dte === 1 ? ' day' : ' days') + ' to expiration. Gamma risk is high, so price moves now hit hard.');
      else if (dte <= cfg.dteAlert) add('watch', dte + ' days to expiration, inside your ' + cfg.dteAlert + '-day management window.');
    }

    // Short strikes: in the money, close, delta
    shortLegs.forEach(function (l) {
      if (!(S > 0)) return;
      var nm = 'short ' + legName(l);
      if (l.itm) {
        if (p.strategy === 'cc') add('watch', 'The ' + nm + ' is in the money. Your shares are likely to be called away at ' + fmtK(l.K) + '.');
        else add('act', 'The ' + nm + ' is in the money, so assignment is likely.');
      } else if (l.otmPct !== null && l.otmPct < cfg.nearStrikePct) {
        add('watch', 'The stock is ' + l.otmPct.toFixed(1) + '% from your ' + nm + ' (alert at ' + cfg.nearStrikePct + '%).');
      }
      if (l.delta !== null && Math.abs(l.delta) >= cfg.deltaAlert && !l.itm) {
        add('watch', 'The ' + nm + ' delta is ' + Math.abs(l.delta).toFixed(2) + ' (alert at ' + Number(cfg.deltaAlert).toFixed(2) + ').');
      }
    });

    // Profit target
    if (a.captured !== null && a.captured >= cfg.profitTarget) {
      var what = (p.strategy === 'cc' || p.strategy === 'pmcc') ? 'of the short call premium' : 'of max profit';
      add('good', Math.round(a.captured) + '% ' + what + ' captured, at or past your ' + cfg.profitTarget + '% target.');
    }

    // Earnings before expiration
    if (a.earnings && a.earnings >= today) {
      var lastShort = shortLegs.length ? shortLegs.map(function (l) { return l.expiry; }).sort().slice(-1)[0] : null;
      if (lastShort && a.earnings <= lastShort) add('watch', 'Earnings on ' + fmtD(a.earnings) + ', before your ' + fmtD(lastShort) + ' expiration.');
      else if (!lastShort && daysTo(a.earnings, now) <= 14) add('info', 'Earnings on ' + fmtD(a.earnings) + '.');
    }

    // Ex-dividend with a short call in the money
    if (a.exDiv && a.exDiv >= today && S > 0) {
      shortLegs.filter(function (l) { return l.type === 'call' && l.itm && a.exDiv <= l.expiry; }).forEach(function (l) {
        if (p.strategy === 'pmcc') add('act', 'Ex-dividend ' + fmtD(a.exDiv) + ' with the short ' + legName(l) + ' in the money. Early assignment would leave you short 100 shares per contract.');
        else if (p.strategy === 'cc') add('watch', 'Ex-dividend ' + fmtD(a.exDiv) + ' with the call in the money. Your shares may be called away early.');
        else add('watch', 'Ex-dividend ' + fmtD(a.exDiv) + ' with the short ' + legName(l) + ' in the money. Early assignment risk.');
      });
    }

    // Covered calls and shares
    if (p.strategy === 'cc') {
      var call = a.legs[0];
      if (a.C !== null && call.K < a.C) add('watch', 'The call strike (' + fmtK(call.K) + ') is below your share cost (' + fmtK(a.C) + '). Assignment would lock in a loss.');
      if (a.Q < 100 * a.q) add('act', 'You have ' + a.Q + ' shares but the calls cover ' + (100 * a.q) + '. Part of the call is not covered.');
    }
    if (p.strategy === 'shares') {
      add('info', 'No call is written on these shares.');
      if (S > 0 && a.C !== null && S < a.C) add('info', 'The shares are ' + ((a.C - S) / a.C * 100).toFixed(1) + '% below your cost.');
    }

    // Spreads and condors: pin risk near expiration
    if ((p.strategy === 'pcs' || p.strategy === 'ccs' || p.strategy === 'ic') && S > 0) {
      var pairs = [];
      var sp = a.legs.filter(function (l) { return l.sign < 0 && l.type === 'put'; })[0], lp = a.legs.filter(function (l) { return l.sign > 0 && l.type === 'put'; })[0];
      var sc = a.legs.filter(function (l) { return l.sign < 0 && l.type === 'call'; })[0], lc = a.legs.filter(function (l) { return l.sign > 0 && l.type === 'call'; })[0];
      if (sp && lp) pairs.push([lp.K, sp.K, sp.dte]);
      if (sc && lc) pairs.push([sc.K, lc.K, sc.dte]);
      pairs.forEach(function (pr) {
        if (pr[2] !== null && pr[2] >= 0 && pr[2] <= cfg.dteUrgent && S > pr[0] && S < pr[1])
          add('act', 'The stock is between your ' + fmtK(pr[0]) + ' and ' + fmtK(pr[1]) + ' strikes near expiration (pin risk). Consider closing before expiration.');
      });
    }

    // PMCC checks
    if (p.strategy === 'pmcc') {
      var lcl = a.legs[0], scl = a.legs[1];
      if (scl.K < a.pmccMinShortStrike) add('act', 'The short strike (' + fmtK(scl.K) + ') is below your long strike plus the debit paid (' + a.pmccMinShortStrike.toFixed(2) + '). If the stock runs through it, the trade locks in a loss.');
      if (lcl.dte !== null && lcl.dte >= 0 && lcl.dte <= cfg.leapsDte) add('watch', 'The long call has ' + lcl.dte + ' days left, inside your ' + cfg.leapsDte + '-day roll window.');
      if (lcl.delta !== null && lcl.delta < cfg.leapsDeltaMin) add('watch', 'The long call delta is ' + lcl.delta.toFixed(2) + ' (below ' + Number(cfg.leapsDeltaMin).toFixed(2) + '), so it no longer moves much like the stock.');
    }

    f.sort(function (x, y) { return SEVERITY[y.sev] - SEVERITY[x.sev]; });
    return f;
  }

  // ---------- stress test ----------
  var STRESS_MOVES = [-20, -10, -5, 5, 10];

  function stressPosition(a, movePct) {
    if (a.errors && a.errors.length) return { ok: false, chg: 0, itmPuts: 0, cash: 0 };
    if (!(a.S > 0)) return { ok: false, chg: 0, itmPuts: 0, cash: 0 };
    var newS = Math.max(a.S * (1 + movePct / 100 * a.betaUsed), 0.01);
    var chg = a.Q * (newS - a.S), ok = true;
    a.legs.forEach(function (l) {
      if (l.T === null) { ok = false; return; }
      var v = l.T > 0 ? l.iv : 0.0001;
      if (!v) { ok = false; return; }
      var p0 = bs(l.type, a.S, l.K, l.T, a.r, v).price, p1 = bs(l.type, newS, l.K, l.T, a.r, v).price;
      chg += l.sign * (p1 - p0) * 100 * l.q;
    });
    var itmPuts = 0, cash = 0;
    a.legs.forEach(function (l) {
      if (l.sign < 0 && l.type === 'put' && l.dte !== null && l.dte >= 0 && newS < l.K) {
        itmPuts += l.q;
        if (a.strategy === 'csp') cash += l.K * 100 * l.q;
        else cash += a.collateral; // spreads and condors: the long put caps it at the width
      }
    });
    return { ok: ok, chg: chg, newS: newS, itmPuts: itmPuts, cash: cash };
  }

  // ---------- risk profiles ----------
  // P/L (from the prices you were filled at) if the stock were at S2.
  // when = {kind:'now'} for today, or {kind:'exp', T: years from now} for a future date.
  function plAt(a, S2, when) {
    var total = a.Q ? a.Q * (S2 - a.C) : 0;
    for (var i = 0; i < a.legs.length; i++) {
      var l = a.legs[i];
      if (l.T === null) return null;
      var left = when.kind === 'now' ? l.T : Math.max(l.T - when.T, 0);
      var v;
      if (!(left > 0)) v = bs(l.type, S2, l.K, 0, a.r, 0).price;
      else if (l.iv) v = bs(l.type, S2, l.K, left, a.r, l.iv).price;
      else return null;
      total += l.sign * (v - l.fill) * 100 * l.q;
    }
    return total;
  }

  function zeroCrossings(xs, ys) {
    var out = [];
    for (var i = 1; i < xs.length; i++) {
      var a = ys[i - 1], b = ys[i];
      if (a === null || b === null) continue;
      if (a === 0) out.push(xs[i - 1]);
      else if ((a < 0 && b > 0) || (a > 0 && b < 0)) out.push(xs[i - 1] + (xs[i] - xs[i - 1]) * (-a / (b - a)));
    }
    return out;
  }

  function riskProfile(a) {
    if ((a.errors && a.errors.length) || !(a.S > 0)) return null;
    var legs = a.legs.filter(function (l) { return l.T !== null; });
    var live = legs.filter(function (l) { return l.T > 0; });
    var shorts = live.filter(function (l) { return l.sign < 0; });
    var pick = shorts.length ? shorts : live;
    var target = pick.length ? pick.reduce(function (m, l) { return l.T < m.T ? l : m; }) : null;
    var strikes = legs.map(function (l) { return l.K; });
    var lo = a.S * 0.8, hi = a.S * 1.2;
    if (strikes.length) {
      lo = Math.min(lo, Math.min.apply(null, strikes) * 0.92);
      hi = Math.max(hi, Math.max.apply(null, strikes) * 1.08);
    }
    lo = Math.max(lo, a.S * 0.5); hi = Math.min(hi, a.S * 1.5);
    var N = 160, xs = [];
    for (var i = 0; i <= N; i++) xs.push(lo + (hi - lo) * i / N);
    var now = xs.map(function (x) { return plAt(a, x, { kind: 'now' }); });
    if (now.some(function (v) { return v === null; })) now = null;
    var exp = null;
    if (target) {
      exp = xs.map(function (x) { return plAt(a, x, { kind: 'exp', T: target.T }); });
      if (exp.some(function (v) { return v === null; })) exp = null;
    }
    var at = function (pct) {
      var x = a.S * (1 + pct / 100);
      return { pct: pct, price: x, now: plAt(a, x, { kind: 'now' }), exp: target ? plAt(a, x, { kind: 'exp', T: target.T }) : null };
    };
    var uniq = strikes.filter(function (k, i) { return strikes.indexOf(k) === i; }).sort(function (x, y) { return x - y; });
    return {
      xs: xs, now: now, exp: exp, S: a.S, strikes: uniq,
      expDate: target ? target.expiry : null,
      breakevens: exp ? zeroCrossings(xs, exp) : (now ? zeroCrossings(xs, now) : []),
      table: [-10, -5, 0, 5, 10].map(at),
      sharesOnly: !a.legs.length
    };
  }

  // Whole account: change in P/L from today if SPY moves by each %, each stock moving by its beta.
  function accountProfile(analyses) {
    var good = analyses.filter(function (a) { return !(a.errors && a.errors.length) && a.S > 0; });
    var moves = [], chg = [], partial = 0;
    for (var m = -25; m <= 25; m += 0.5) {
      var total = 0;
      good.forEach(function (a) { var r = stressPosition(a, m); total += r.chg; });
      moves.push(m); chg.push(total);
    }
    good.forEach(function (a) { if (!stressPosition(a, -10).ok) partial++; });
    return { moves: moves, chg: chg, partial: partial, count: good.length };
  }

  // ---------- whole account ----------
  function summarize(analyses, account, cfgIn) {
    var cfg = Object.assign({}, DEFAULTS, cfgIn || {});
    var acct = num(account && account.value), cash = num(account && account.cash);
    var good = analyses.filter(function (a) { return !(a.errors && a.errors.length); });
    var s = { acct: acct, cash: cash, flags: [] };

    s.cashNeeded = sum(good.map(function (a) { return a.collateral || 0; }));
    s.cashPct = cash > 0 ? s.cashNeeded / cash * 100 : null;
    s.cashNeededPctAcct = acct > 0 ? s.cashNeeded / acct * 100 : null;
    s.capital = sum(good.map(function (a) { return a.capital || 0; }));

    var dd = good.map(function (a) { return a.deltaDollars; });
    s.deltaMissing = dd.filter(function (x) { return x === null; }).length;
    s.deltaDollars = sum(dd.filter(function (x) { return x !== null; }));
    s.bwDeltaDollars = sum(good.map(function (a) { return a.bwDeltaDollars; }).filter(function (x) { return x !== null; }));
    s.deltaPct = acct > 0 ? s.deltaDollars / acct * 100 : null;
    s.spyOnePct = s.bwDeltaDollars / 100;
    s.betaAssumed = good.filter(function (a) { return a.beta === null; }).map(function (a) { return a.ticker; });

    var plKnown = good.map(function (a) { return a.pl; });
    s.pl = sum(plKnown.filter(function (x) { return x !== null; }));
    s.plMissing = plKnown.filter(function (x) { return x === null; }).length;

    function group(keyFn) {
      var m = {};
      good.forEach(function (a) {
        var k = keyFn(a);
        if (!m[k]) m[k] = { key: k, capital: 0, cash: 0, deltaDollars: 0, count: 0 };
        m[k].capital += a.capital || 0; m[k].cash += a.collateral || 0; m[k].deltaDollars += a.deltaDollars || 0; m[k].count++;
      });
      return Object.keys(m).map(function (k) { var g = m[k]; g.pct = acct > 0 ? g.capital / acct * 100 : null; return g; })
        .sort(function (x, y) { return y.capital - x.capital; });
    }
    s.byTicker = group(function (a) { return a.ticker; });
    s.bySector = group(function (a) { return a.sector || 'Unknown'; });

    s.stress = STRESS_MOVES.map(function (m) {
      var res = good.map(function (a) { return stressPosition(a, m); });
      var chg = sum(res.map(function (r) { return r.chg; }));
      return {
        move: m, chg: chg, pct: acct > 0 ? chg / acct * 100 : null,
        itmPuts: sum(res.map(function (r) { return r.itmPuts; })),
        cash: sum(res.map(function (r) { return r.cash; })),
        incomplete: res.filter(function (r) { return !r.ok; }).length
      };
    });

    var add = function (sev, text) { s.flags.push({ sev: sev, text: text }); };
    if (!(acct > 0)) add('data', 'Enter your account value to see percentages and concentration.');
    if (!(cash >= 0) || cash === null) add('data', 'Enter your cash available to check that every short put is covered.');
    if (cash !== null && cash >= 0 && s.cashNeeded > cash * cfg.maxCashPct / 100) {
      add('act', 'Cash needed to cover your positions (' + money(s.cashNeeded) + ') is more than ' + (cfg.maxCashPct === 100 ? 'your cash' : cfg.maxCashPct + '% of your cash') + ' (' + money(cash) + ').');
    }
    if (account && account.type === 'margin' && cash !== null && s.cashNeeded > cash) {
      add('watch', 'In a margin account, your broker may let you sell more puts than your cash covers. If they were all assigned, you would need ' + money(s.cashNeeded) + '.');
    }
    if (acct > 0) {
      s.byTicker.forEach(function (g) { if (g.pct > cfg.maxTickerPct) add('watch', g.key + ' is ' + g.pct.toFixed(1) + '% of your account (your limit is ' + cfg.maxTickerPct + '%).'); });
      s.bySector.forEach(function (g) { if (g.key !== 'Unknown' && g.pct > cfg.maxSectorPct) add('watch', g.key + ' is ' + g.pct.toFixed(1) + '% of your account (your limit is ' + cfg.maxSectorPct + '%).'); });
    }
    var bad = analyses.length - good.length;
    if (bad) add('data', bad + (bad === 1 ? ' trade has' : ' trades have') + ' missing or wrong details and are left out of the totals.');
    s.flags.sort(function (x, y) { return SEVERITY[y.sev] - SEVERITY[x.sev]; });
    return s;
  }

  function money(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var d = digits === undefined ? 0 : digits;
    var s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    return (v < 0 ? '−$' : '$') + s;
  }

  var Core = {
    STRATEGIES: STRATEGIES, DEFAULTS: DEFAULTS, SEVERITY: SEVERITY, STRESS_MOVES: STRESS_MOVES,
    num: num, parseDate: parseDate, daysTo: daysTo, yearsTo: yearsTo, isoToday: isoToday,
    bs: bs, impliedVol: impliedVol, normCdf: normCdf, lookupOption: lookupOption,
    validate: validate, analyzePosition: analyzePosition, stressPosition: stressPosition,
    plAt: plAt, riskProfile: riskProfile, accountProfile: accountProfile, zeroCrossings: zeroCrossings,
    summarize: summarize, money: money, fmtD: fmtD, fmtK: fmtK
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(this);
