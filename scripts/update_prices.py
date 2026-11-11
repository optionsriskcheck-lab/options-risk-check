#!/usr/bin/env python3
"""Fetches prices from Yahoo Finance (through yfinance) for the Options Risk Check page.

Modes
  stocks  latest stock price for every ticker on the list (runs about every 30 minutes)
  chains  option chains, once a day
  info    earnings dates, ex-dividend dates and beta; also refreshes the S&P 500 list
  all     all three, in that order

Everything is written into --out (the published site's data folder). If something fails,
the last good data is kept, so the page never shows half-broken numbers as if they were fresh.
"""
import argparse
import csv
import io
import json
import math
import os
import random
import sys
import time
import urllib.request
from datetime import date, datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SP500_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
RATE = 0.04          # interest rate used to work out implied volatility (matches the page's default)
NEAR_DAYS = 60       # puts and calls for expirations up to this many days out
PUT_RANGE = (0.60, 1.40)    # keep strikes between 60% and 140% of the stock price
FAR_CALL_RANGE = (0.40, 1.20)  # longer-dated calls (PMCC long legs)


# ---------------------------------------------------------------- helpers
def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def chicago_today():
    if ZoneInfo:
        return datetime.now(ZoneInfo("America/Chicago")).date()
    return datetime.now(timezone.utc).date()


def log(*a):
    print(*a, flush=True)


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)


def num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    return x if math.isfinite(x) else 0.0


def iso(d):
    if d is None:
        return None
    if isinstance(d, datetime):
        return d.date().isoformat()
    if isinstance(d, date):
        return d.isoformat()
    if isinstance(d, (int, float)) and d > 0:  # seconds since 1970
        return datetime.fromtimestamp(d, timezone.utc).date().isoformat()
    s = str(d)[:10]
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        return None


# ---------------------------------------------------------------- option math (same as the page)
def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_price(kind, S, K, T, r, v):
    if T <= 0 or v <= 0:
        return max(S - K, 0.0) if kind == "C" else max(K - S, 0.0)
    sq = v * math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * v * v) * T) / sq
    d2 = d1 - sq
    if kind == "C":
        return S * norm_cdf(d1) - K * math.exp(-r * T) * norm_cdf(d2)
    return K * math.exp(-r * T) * norm_cdf(-d2) - S * norm_cdf(-d1)


def implied_vol(kind, price, S, K, T, r):
    if not (price >= 0 and S > 0 and K > 0 and T > 0):
        return None
    lo, hi = 0.005, 5.0
    if price <= bs_price(kind, S, K, T, r, lo):
        return lo
    if price >= bs_price(kind, S, K, T, r, hi):
        return None
    for _ in range(100):
        mid = (lo + hi) / 2
        if bs_price(kind, S, K, T, r, mid) > price:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-7:
            break
    return (lo + hi) / 2


def years_to(expiry_iso):
    """Options stop trading at 4 PM New York time (about 21:00 UTC); same as the page."""
    d = date.fromisoformat(expiry_iso)
    close = datetime(d.year, d.month, d.day, 21, 0, tzinfo=timezone.utc)
    return max((close - datetime.now(timezone.utc)).total_seconds(), 0) / (365 * 86400)


# ---------------------------------------------------------------- pacing so Yahoo doesn't block us
class Pacer:
    def __init__(self, delay, max_fails=6):
        self.delay = delay
        self.fails = 0
        self.max_fails = max_fails

    def wait(self):
        time.sleep(self.delay + random.uniform(0, self.delay / 2))

    def ok(self):
        self.fails = 0

    def failed(self, e):
        """Returns False when it's time to give up for this run."""
        self.fails += 1
        msg = str(e)
        throttled = "429" in msg or "Too Many" in msg or "Rate" in type(e).__name__
        pause = min(30 * 2 ** (self.fails - 1), 300) if throttled else 2
        log(f"  problem ({type(e).__name__}: {msg[:150]}); pausing {pause}s")
        if self.fails >= self.max_fails:
            return False
        time.sleep(pause)
        return True


# ---------------------------------------------------------------- ticker list
def parse_sp500_csv(text):
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        sym = (r.get("Symbol") or "").strip().upper().replace(".", "-")  # Yahoo writes BRK.B as BRK-B
        if sym:
            out[sym] = (r.get("GICS Sector") or "").strip() or "Unknown"
    return out


def load_universe(out_dir, refresh=False, limit=None):
    """Returns {ticker: sector}: the S&P 500 plus the extra tickers in tickers/extra.csv."""
    uni_path = os.path.join(out_dir, "universe.json")
    sp = None
    if refresh:
        try:
            with urllib.request.urlopen(SP500_URL, timeout=30) as r:
                parsed = parse_sp500_csv(r.read().decode("utf-8"))
            if len(parsed) >= 480:
                sp = parsed
                write_json(uni_path, {"updated": now_iso(), "sp500": sp})
                log(f"S&P 500 list refreshed: {len(sp)} tickers")
            else:
                log(f"S&P 500 list looked wrong ({len(parsed)} rows); keeping the saved one")
        except Exception as e:
            log("Could not refresh the S&P 500 list; keeping the saved one:", e)
    if sp is None:
        sp = read_json(uni_path, {}).get("sp500")
    if not sp:
        with open(os.path.join(ROOT, "tickers", "sp500.csv")) as f:
            sp = parse_sp500_csv(f.read())
    uni = dict(sp)
    with open(os.path.join(ROOT, "tickers", "extra.csv")) as f:
        for r in csv.DictReader(f):
            sym = (r.get("Symbol") or "").strip().upper()
            if sym:
                uni[sym] = (r.get("Sector") or "").strip() or "Unknown"
    if limit:
        keep = sorted(uni)[:limit]
        uni = {k: uni[k] for k in keep}
    return uni


# ---------------------------------------------------------------- stock prices
def batch_quotes(tickers):
    """Yahoo's quote service answers up to ~150 tickers per request."""
    from yfinance.data import YfData

    data = YfData()
    out = {}
    for i in range(0, len(tickers), 150):
        chunk = tickers[i:i + 150]
        j = data.get_raw_json("https://query1.finance.yahoo.com/v7/finance/quote",
                              params={"symbols": ",".join(chunk), "fields": "regularMarketPrice"})
        for q in ((j or {}).get("quoteResponse") or {}).get("result") or []:
            p, s = q.get("regularMarketPrice"), q.get("symbol")
            if s and isinstance(p, (int, float)) and p > 0:
                out[s.upper()] = round(float(p), 4)
        time.sleep(1.5)
    return out


def download_prices(yf, tickers):
    """Slower backup: one chart request per ticker, done in groups of 100."""
    import pandas as pd

    out = {}
    for i in range(0, len(tickers), 100):
        chunk = tickers[i:i + 100]
        try:
            df = yf.download(chunk, period="5d", interval="15m", progress=False, group_by="ticker",
                             threads=True, auto_adjust=False, prepost=False)
        except Exception as e:
            log("  download problem:", e)
            time.sleep(10)
            continue
        multi = isinstance(df.columns, pd.MultiIndex)
        for t in chunk:
            try:
                s = (df[t]["Close"] if multi else df["Close"]).dropna()
                if len(s):
                    out[t] = round(float(s.iloc[-1]), 4)
            except Exception:
                pass
        time.sleep(3)
    return out


def update_stocks(yf, uni, out_dir):
    tickers = sorted(uni)
    prices = {}
    try:
        prices = batch_quotes(tickers)
        log(f"Quote service: {len(prices)} of {len(tickers)} prices")
    except Exception as e:
        log("Quote service not available, using the slower backup:", str(e)[:200])
    missing = [t for t in tickers if t not in prices]
    if missing:
        got = download_prices(yf, missing)
        log(f"Backup download: {len(got)} of {len(missing)} prices")
        prices.update(got)
    if len(prices) < 0.5 * len(tickers):
        log(f"Only {len(prices)} of {len(tickers)} prices came back; keeping the last good file.")
        return False
    write_json(os.path.join(out_dir, "stocks.json"), {"updated": now_iso(), "stocks": prices})
    log(f"Saved {len(prices)} stock prices")
    return True


# ---------------------------------------------------------------- option chains
def is_monthly(d):
    """Standard monthly expiration: the third Friday (or the Thursday before it if Friday is a holiday)."""
    return d.weekday() in (3, 4) and 15 <= d.day <= 21


def pick_expirations(exps, today):
    ds = []
    for e in exps or []:
        try:
            ds.append(date.fromisoformat(str(e)[:10]))
        except ValueError:
            pass
    ds.sort()
    # Near term: the last expiration of each week within 60 days (skips SPY/QQQ/IWM daily expirations)
    week_last = {}
    for d in ds:
        if 0 <= (d - today).days <= NEAR_DAYS:
            key = d.isocalendar()[:2]
            if key not in week_last or d > week_last[key]:
                week_last[key] = d
    near = sorted(week_last.values())
    # Further out, calls only (for PMCC long legs): monthlies up to 120 days, then January LEAPS
    far = []
    for d in ds:
        dd = (d - today).days
        if NEAR_DAYS < dd <= 120 and is_monthly(d):
            far.append(d)
        elif dd > 120 and d.month == 1 and is_monthly(d):
            far.append(d)
    return near, far[:5]


def chain_rows(kind, df, S, T, lo_hi):
    rows = []
    lo, hi = lo_hi
    for r in df.itertuples(index=False):
        K = num(getattr(r, "strike", 0))
        if K <= 0 or (S and not (lo * S <= K <= hi * S)):
            continue
        bid, ask = num(getattr(r, "bid", 0)), num(getattr(r, "ask", 0))
        last, yiv = num(getattr(r, "lastPrice", 0)), num(getattr(r, "impliedVolatility", 0))
        iv = None
        if S and T > 0:
            if bid > 0 and ask >= bid:
                iv = implied_vol(kind, (bid + ask) / 2, S, K, T, RATE)
            elif 0.01 < yiv < 5:
                iv = yiv
        rows.append([round(K, 2), round(bid, 2), round(ask, 2), round(last, 2), round(iv, 4) if iv else 0])
    return rows


def fetch_chain(yf, tk, S_hint, pacer, today):
    t = yf.Ticker(tk)
    exps = t.options
    pacer.wait()
    near, far = pick_expirations(exps, today)
    S = S_hint
    out = {"updated": None, "S": None, "exps": {}}
    for d in near + far:
        e = d.isoformat()
        ch = t.option_chain(e)
        pacer.wait()
        und = getattr(ch, "underlying", None)
        if isinstance(und, dict) and num(und.get("regularMarketPrice")) > 0:
            S = num(und.get("regularMarketPrice"))
        T = years_to(e)
        if d in near:
            out["exps"][e] = {"P": chain_rows("P", ch.puts, S, T, PUT_RANGE),
                              "C": chain_rows("C", ch.calls, S, T, PUT_RANGE)}
        else:
            out["exps"][e] = {"C": chain_rows("C", ch.calls, S, T, FAR_CALL_RANGE)}
    out["S"] = round(S, 4) if S else None
    out["updated"] = now_iso()
    return out


def update_chains(yf, uni, out_dir, minutes, delay=0.6):
    tickers = sorted(uni)
    meta_path = os.path.join(out_dir, "meta.json")
    meta = read_json(meta_path, {})
    n = len(tickers)
    start = int(meta.get("chains_cursor", 0)) % n if n else 0
    order = tickers[start:] + tickers[:start]
    stocks = read_json(os.path.join(out_dir, "stocks.json"), {}).get("stocks", {})
    pacer = Pacer(delay)
    today = chicago_today()
    t0 = time.time()
    processed, saved, failed = 0, 0, []
    stopped = False
    for tk in order:
        if time.time() - t0 > minutes * 60:
            log("Time limit reached; the rest go first next run.")
            stopped = True
            break
        try:
            res = fetch_chain(yf, tk, stocks.get(tk), pacer, today)
            if res["exps"]:
                write_json(os.path.join(out_dir, "chains", f"{tk}.json"), res)
                saved += 1
            pacer.ok()
        except Exception as e:
            failed.append(tk)
            if not pacer.failed(e):
                log("Too many problems in a row; stopping. The rest go first next run.")
                processed += 1
                stopped = True
                break
        processed += 1
        if processed % 50 == 0:
            log(f"  {processed}/{n} tickers, {saved} saved, {round((time.time() - t0) / 60, 1)} min")
    meta["chains_cursor"] = (start + processed) % n if stopped else 0
    meta["chains_last"] = {"finished": now_iso(), "saved": saved, "failed": failed[:50], "complete": not stopped}
    write_json(meta_path, meta)
    # Tidy up: drop chain files for tickers no longer on the list
    cdir = os.path.join(out_dir, "chains")
    if os.path.isdir(cdir):
        for fn in os.listdir(cdir):
            if fn.endswith(".json") and fn[:-5] not in uni:
                os.remove(os.path.join(cdir, fn))
    log(f"Option chains: {saved} saved, {len(failed)} failed")
    return saved > 0


# ---------------------------------------------------------------- earnings, ex-dividend, beta
def first_future(v, today):
    vals = v if isinstance(v, (list, tuple)) else [v]
    ds = sorted(x for x in (iso(x) for x in vals) if x)
    for d in ds:
        if d >= today.isoformat():
            return d
    return None


def calendar_dict(cal):
    if cal is None:
        return {}
    if isinstance(cal, dict):
        return cal
    try:  # older yfinance returned a table
        return {k: list(cal.loc[k].values) for k in cal.index}
    except Exception:
        return {}


def update_info(yf, uni, out_dir, delay=0.5):
    path = os.path.join(out_dir, "info.json")
    old = read_json(path, {})
    info = {k: v for k, v in (old.get("info") or {}).items() if k in uni}
    today = chicago_today()
    beta_updated = old.get("beta_updated")
    do_beta = True
    if beta_updated:
        try:
            do_beta = (datetime.now(timezone.utc) - datetime.fromisoformat(beta_updated.replace("Z", "+00:00"))).days >= 6
        except ValueError:
            pass
    pacer = Pacer(delay)
    count = 0
    for tk, sector in sorted(uni.items()):
        rec = dict(info.get(tk) or {})
        rec["sector"] = sector
        try:
            t = yf.Ticker(tk)
            cal = calendar_dict(t.calendar)
            pacer.wait()
            rec["earnings"] = first_future(cal.get("Earnings Date"), today)
            rec["exdiv"] = first_future(cal.get("Ex-Dividend Date"), today)
            if do_beta:
                inf = t.info or {}
                pacer.wait()
                b = inf.get("beta") or inf.get("beta3Year")
                if isinstance(b, (int, float)) and math.isfinite(b):
                    rec["beta"] = round(float(b), 2)
            pacer.ok()
            count += 1
        except Exception as e:
            if not pacer.failed(e):
                log("Too many problems in a row; stopping. Earlier dates are kept for the rest.")
                info[tk] = rec
                break
        info[tk] = rec
    for tk, sector in uni.items():  # sectors even for tickers we didn't reach
        info.setdefault(tk, {})["sector"] = sector
    write_json(path, {"updated": now_iso(),
                      "beta_updated": now_iso() if do_beta and count else beta_updated,
                      "info": info})
    log(f"Earnings / ex-dividend / beta: {count} tickers updated")
    return count > 0


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["stocks", "chains", "info", "all"], required=True)
    ap.add_argument("--out", required=True, help="the site's data folder")
    ap.add_argument("--chain-minutes", type=float, default=110, help="stop the option-chain pull after this long")
    ap.add_argument("--limit", type=int, default=None, help="only the first N tickers (for testing)")
    ap.add_argument("--delay", type=float, default=0.6, help="pause between requests, in seconds")
    a = ap.parse_args(argv)

    import yfinance as yf

    os.makedirs(a.out, exist_ok=True)
    uni = load_universe(a.out, refresh=a.mode in ("info", "all"), limit=a.limit)
    log(f"{len(uni)} tickers on the list")
    meta_path = os.path.join(a.out, "meta.json")
    results = {}
    if a.mode in ("stocks", "all"):
        results["stocks"] = update_stocks(yf, uni, a.out)
    if a.mode in ("info", "all"):
        results["info"] = update_info(yf, uni, a.out, delay=a.delay * 0.8)
    if a.mode in ("chains", "all"):
        results["chains"] = update_chains(yf, uni, a.out, a.chain_minutes, delay=a.delay)
    meta = read_json(meta_path, {})
    meta.setdefault("runs", {})
    for k, ok in results.items():
        meta["runs"][k] = {"at": now_iso(), "ok": bool(ok)}
    meta["tickers"] = len(uni)
    write_json(meta_path, meta)
    log("Done:", results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
