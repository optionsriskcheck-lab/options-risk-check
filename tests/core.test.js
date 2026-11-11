// Checks the math against numbers that can be worked out by hand or from textbook examples.
const C = require('../src/core.js');
let fails = 0, passes = 0;
function near(name, got, want, tol) {
  const ok = got !== null && Math.abs(got - want) <= (tol || 1e-6);
  if (ok) passes++; else { fails++; console.log('FAIL', name, 'got', got, 'want', want); }
}
function is(name, got, want) {
  if (got === want) passes++; else { fails++; console.log('FAIL', name, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); }
}

// Textbook Black-Scholes: S=100 K=100 T=1 r=5% vol=20%
let c = C.bs('call', 100, 100, 1, 0.05, 0.2), p = C.bs('put', 100, 100, 1, 0.05, 0.2);
near('call price', c.price, 10.4506, 1e-3);
near('put price', p.price, 5.5735, 1e-3);
near('call delta', c.delta, 0.6368, 1e-3);
near('put delta', p.delta, -0.3632, 1e-3);
// put-call parity
near('parity', c.price - p.price, 100 - 100 * Math.exp(-0.05), 1e-6);
// implied vol round trip
near('iv put', C.impliedVol('put', p.price, 100, 100, 1, 0.05), 0.2, 1e-4);
near('iv call otm', C.impliedVol('call', C.bs('call', 50, 60, 0.1, 0.04, 0.45).price, 50, 60, 0.1, 0.04), 0.45, 1e-4);

// Fixed "now" so day counts are predictable: Tue Nov 10 2026, 6 PM Chicago
const now = new Date('2026-11-11T00:00:00Z');
is('days to', C.daysTo('2026-12-18', new Date(2026, 10, 10, 18, 0)), 38);

const cfg = C.DEFAULTS;

// Cash-secured put: 2 x 45P, sold for 1.10, now 0.55
const csp = { id: 1, ticker: 'demo', strategy: 'csp', qty: 2, stockPrice: 48.2,
  legs: [{ side: 'sell', type: 'put', strike: 45, expiry: '2026-12-11', fill: 1.10, mark: 0.55 }] };
let a = C.analyzePosition(csp, cfg, null, new Date(2026, 10, 10, 18, 0));
is('csp errors', a.errors.length, 0);
near('csp credit', a.credit, 220, 1e-9);
near('csp collateral', a.collateral, 9000, 1e-9);
near('csp max loss', a.maxLoss, 9000 - 220, 1e-9);
near('csp pl', a.pl, 110, 1e-9);
near('csp captured', a.captured, 50, 1e-9);
near('csp breakeven', a.breakevens[0], 43.9, 1e-9);
is('csp profit flag', a.flags.some(f => f.sev === 'good'), true);
// short put delta is negative; selling it makes position delta positive
is('csp delta positive', a.posDelta > 0, true);
near('csp delta dollars', a.deltaDollars, a.posDelta * 48.2, 1e-9);

// Delta dollars example from the chat: short put with 0.30 delta at $50 -> about +$1,500
// Build a put whose delta is ~-0.30 and check
const T = C.yearsTo('2026-12-18', new Date(2026, 10, 10, 18, 0));
let K = 50, v = 0.35, lo = 30, hi = 50;
for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (C.bs('put', 50, m, T, 0.04, v).delta < -0.30) hi = m; else lo = m; }
K = (lo + hi) / 2;
const mark30 = C.bs('put', 50, K, T, 0.04, v).price;
a = C.analyzePosition({ id: 2, ticker: 'x', strategy: 'csp', qty: 1, stockPrice: 50,
  legs: [{ side: 'sell', type: 'put', strike: K, expiry: '2026-12-18', fill: mark30, mark: mark30 }] }, cfg, null, new Date(2026, 10, 10, 18, 0));
near('0.30 delta put -> $1,500', a.deltaDollars, 1500, 2);

// Put credit spread: 205/200 x3, credit 1.35-0.45 = 0.90
const pcs = { id: 3, ticker: 'demo', strategy: 'pcs', qty: 3, stockPrice: 212,
  legs: [{ side: 'sell', type: 'put', strike: 205, expiry: '2026-11-13', fill: 1.35, mark: 1.60 },
         { side: 'buy', type: 'put', strike: 200, expiry: '2026-11-13', fill: 0.45, mark: 0.30 }] };
a = C.analyzePosition(pcs, cfg, null, new Date(2026, 10, 10, 18, 0));
near('pcs credit', a.credit, 270, 1e-9);
near('pcs collateral', a.collateral, 1500, 1e-9);
near('pcs max loss', a.maxLoss, 1230, 1e-9);
near('pcs pl', a.pl, (1.35 - 1.60) * 300 + (0.30 - 0.45) * 300, 1e-9);
is('pcs urgent flag', a.status, 'act');

// Iron condor: 420/425P 485/490C x1
const ic = { id: 4, ticker: 'demo', strategy: 'ic', qty: 1, stockPrice: 455,
  legs: [{ side: 'buy', type: 'put', strike: 420, expiry: '2026-12-18', fill: 1.20, mark: 0.70 },
         { side: 'sell', type: 'put', strike: 425, expiry: '2026-12-18', fill: 1.85, mark: 1.10 },
         { side: 'sell', type: 'call', strike: 485, expiry: '2026-12-18', fill: 1.70, mark: 1.40 },
         { side: 'buy', type: 'call', strike: 490, expiry: '2026-12-18', fill: 1.05, mark: 0.80 }] };
a = C.analyzePosition(ic, cfg, null, new Date(2026, 10, 10, 18, 0));
near('ic credit', a.credit, 130, 1e-9);
near('ic max loss', a.maxLoss, 370, 1e-9);
near('ic pl', a.pl, 30, 1e-9);
near('ic breakeven low', a.breakevens[0], 423.7, 1e-9);
near('ic breakeven high', a.breakevens[1], 486.3, 1e-9);

// Wrong strike order is caught
const icBad = JSON.parse(JSON.stringify(ic)); icBad.legs[0].strike = 430;
is('ic bad order caught', C.validate(icBad).length > 0, true);

// PMCC: long 100C, short 135C, debit 36.50 - 2.10 = 34.40 -> min short strike 134.40
const pmcc = { id: 5, ticker: 'demo', strategy: 'pmcc', qty: 1, stockPrice: 130,
  legs: [{ side: 'buy', type: 'call', strike: 100, expiry: '2027-12-17', fill: 36.50, mark: 38.20 },
         { side: 'sell', type: 'call', strike: 135, expiry: '2026-12-11', fill: 2.10, mark: 1.60 }] };
a = C.analyzePosition(pmcc, cfg, null, new Date(2026, 10, 10, 18, 0));
near('pmcc debit max loss', a.maxLoss, 3440, 1e-9);
near('pmcc min short strike', a.pmccMinShortStrike, 134.4, 1e-9);
is('pmcc strike check passes', a.flags.some(f => f.text.indexOf('locks in a loss') >= 0), false);
is('pmcc has est max profit', a.maxProfit !== null && a.maxProfitIsEstimate, true);
const pmccBad = JSON.parse(JSON.stringify(pmcc)); pmccBad.legs[1].strike = 132;
a = C.analyzePosition(pmccBad, cfg, null, new Date(2026, 10, 10, 18, 0));
is('pmcc strike check fails', a.flags.some(f => f.sev === 'act' && f.text.indexOf('locks in a loss') >= 0), true);
// Short call ITM + ex-div before expiry -> urgent
const pmccDiv = JSON.parse(JSON.stringify(pmcc)); pmccDiv.stockPrice = 140; pmccDiv.legs[1].mark = 6.2; pmccDiv.exDiv = '2026-11-20';
a = C.analyzePosition(pmccDiv, cfg, null, new Date(2026, 10, 10, 18, 0));
is('pmcc ex-div flag', a.flags.some(f => f.sev === 'act' && f.text.indexOf('Ex-dividend') === 0), true);

// Covered call below cost basis and not enough shares
const cc = { id: 6, ticker: 'demo', strategy: 'cc', qty: 2, stockPrice: 58.4, sharesQty: 200, sharesCost: 62,
  legs: [{ side: 'sell', type: 'call', strike: 60, expiry: '2026-12-04', fill: 0.95, mark: 0.70 }] };
a = C.analyzePosition(cc, cfg, null, new Date(2026, 10, 10, 18, 0));
is('cc below cost flag', a.flags.some(f => f.text.indexOf('below your share cost') >= 0), true);
near('cc pl', a.pl, (58.4 - 62) * 200 + (0.95 - 0.70) * 200, 1e-9);
near('cc delta includes shares', a.posDelta > 100 && a.posDelta < 200 ? 1 : 0, 1, 0);
const ccShort = JSON.parse(JSON.stringify(cc)); ccShort.sharesQty = 100;
a = C.analyzePosition(ccShort, cfg, null, new Date(2026, 10, 10, 18, 0));
is('cc uncovered flag', a.flags.some(f => f.sev === 'act' && f.text.indexOf('not covered') >= 0), true);

// Stress test: CSP loses money when the stock falls, and more than delta alone suggests
a = C.analyzePosition(csp, cfg, null, new Date(2026, 10, 10, 18, 0));
const s20 = C.stressPosition(a, -20);
is('csp stress negative', s20.chg < 0, true);
is('csp stress worse than delta', s20.chg < a.deltaDollars * -0.20, true);
is('csp ITM after -20%', s20.itmPuts, 2);
near('csp cash after -20%', s20.cash, 9000, 1e-9);

// Account summary
const all = [csp, pcs, ic, pmcc, cc].map(x => C.analyzePosition(x, cfg, null, new Date(2026, 10, 10, 18, 0)));
const sm = C.summarize(all, { value: 100000, cash: 5000, type: 'cash' }, cfg);
near('cash needed', sm.cashNeeded, 9000 + 1500 + 500, 1e-9);
is('cash flag when short', sm.flags.some(f => f.sev === 'act'), true);
is('stress rows', sm.stress.length, 5);

// Automatic prices: chain mid used when fresh, estimate otherwise
const prices = { stocks_updated: '2026-11-10T20:30:00Z',
  stocks: { DEMO: { price: 48 } }, info: { DEMO: { beta: 1.3, sector: 'Technology' } },
  chains: { DEMO: { updated: '2026-11-10T20:25:00Z', S: 48, exps: { '2026-12-11': { P: [[45, 0.6, 0.7, 0.62, 0.38]] } } } } };
a = C.analyzePosition(csp, cfg, prices, new Date(2026, 10, 10, 18, 0));
near('auto stock price', a.S, 48, 1e-9);
near('auto mid', a.legs[0].mark, 0.65, 1e-9);
is('auto source', a.legs[0].mSrc, 'auto');
is('auto beta', a.beta, 1.3);
prices.chains.DEMO.updated = '2026-11-10T16:00:00Z';
a = C.analyzePosition(csp, cfg, prices, new Date(2026, 10, 10, 18, 0));
is('estimate when chain is old', a.legs[0].mSrc, 'estimate');

// Ticker not on the automatic list, and an expiration the list doesn't carry
a = C.analyzePosition(Object.assign({}, csp, { ticker: 'zzzz', stockPrice: '' }), cfg, prices, new Date(2026, 10, 10, 18, 0));
is('not-on-list message', a.flags.some(f => f.text.indexOf('not on the automatic price list') >= 0), true);
const odd = JSON.parse(JSON.stringify(csp)); odd.legs[0].expiry = '2026-12-04'; odd.legs[0].mark = '';
a = C.analyzePosition(odd, cfg, prices, new Date(2026, 10, 10, 18, 0));
is('expiration-not-carried message', a.flags.some(f => f.text.indexOf('not in the automatic option prices') >= 0), true);

// Risk profiles
const N2 = new Date(2026, 10, 10, 18, 0);
let rp = C.riskProfile(C.analyzePosition(csp, cfg, null, N2));
near('csp at-expiration max profit', Math.max.apply(null, rp.exp), 220, 1e-6);
near('csp breakeven from curve', rp.breakevens[0], 43.9, 0.01);
// today's curve passes through today's P/L at today's price
a = C.analyzePosition(csp, cfg, null, N2);
near('today line = current P/L at current price', C.plAt(a, a.S, { kind: 'now' }), a.pl, 0.01);
rp = C.riskProfile(C.analyzePosition(ic, cfg, null, N2));
near('ic max profit at expiration', Math.max.apply(null, rp.exp), 130, 1e-6);
near('ic max loss at expiration', Math.min.apply(null, rp.exp), -370, 1e-6);
is('ic two breakevens', rp.breakevens.length, 2);
near('ic lower breakeven', rp.breakevens[0], 423.7, 0.05);
near('ic upper breakeven', rp.breakevens[1], 486.3, 0.05);
rp = C.riskProfile(C.analyzePosition(pmcc, cfg, null, N2));
is('pmcc expiration line drawn (LEAPS still has time value)', rp.exp !== null, true);
is('pmcc line uses short call expiration', rp.expDate, '2026-12-11');
is('pmcc worst case above -debit', Math.min.apply(null, rp.exp) > -3440, true);
a = C.analyzePosition(pmcc, cfg, null, N2);
near('pmcc today line = current P/L', C.plAt(a, a.S, { kind: 'now' }), a.pl, 0.01);
rp = C.riskProfile(C.analyzePosition({ id: 9, ticker: 'x', strategy: 'shares', stockPrice: 27.5, sharesQty: 100, sharesCost: 30, legs: [] }, cfg, null, N2));
is('shares profile has one line', rp.exp === null && rp.now !== null, true);
near('shares breakeven = cost', rp.breakevens[0], 30, 0.01);
const ap = C.accountProfile(all);
near('account profile 0% move = 0', ap.chg[ap.moves.indexOf(0)], 0, 1e-6);
near('account profile -10% matches stress test', ap.chg[ap.moves.indexOf(-10)], sm.stress[1].chg, 1e-6);

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
