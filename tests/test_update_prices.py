"""Runs the price job against a stand-in for Yahoo, so every part can be checked without the internet."""
import collections
import math
import json
import os
import shutil
import sys
import tempfile
import types
from datetime import date, timedelta

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))

problems = []


def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        problems.append(name)


# ------------------------------------------------------------ stand-in for yfinance
TODAY = date.today()
Options = collections.namedtuple("Options", "calls puts underlying")
CALLS = collections.Counter()
BROKEN = set()          # tickers that always fail
THROTTLE = {"on": False}
QUOTES_WORK = {"on": False}


def price_of(tk):
    return 50.0 + (sum(map(ord, tk)) % 200)


def fake_chain_df(S, kind, T):
    import math
    import update_prices as up
    rows = []
    for K in [round(S * f, 1) for f in (0.5, 0.7, 0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.3, 1.6)]:
        p = up.bs_price(kind, S, K, T, up.RATE, 0.30, 2.5 / S)
        rows.append({"contractSymbol": "X", "strike": K, "lastPrice": round(p, 2), "bid": round(max(p - 0.05, 0), 2),
                     "ask": round(p + 0.05, 2), "impliedVolatility": 0.31, "volume": 10, "openInterest": 100})
    return pd.DataFrame(rows)


class FakeTicker:
    def __init__(self, tk):
        self.tk = tk

    def _guard(self):
        CALLS[self.tk] += 1
        if THROTTLE["on"]:
            raise Exception("Too Many Requests. Rate limited. Try after a while.")
        if self.tk in BROKEN:
            raise ValueError("no data")

    @property
    def options(self):
        self._guard()
        days = list(range(0, 75)) if self.tk in ("SPY", "QQQ", "IWM") else [3, 10, 17, 24, 31, 38, 45, 59, 66, 94, 129, 220, 430, 800]
        out = []
        for d in days:
            dd = TODAY + timedelta(days=d)
            if self.tk in ("SPY", "QQQ", "IWM") and dd.weekday() < 5:
                out.append(dd.isoformat())
            elif self.tk not in ("SPY", "QQQ", "IWM"):
                # move to the Friday of that week
                dd = dd + timedelta(days=(4 - dd.weekday()) % 7)
                out.append(dd.isoformat())
        # add real January LEAPS (third Fridays)
        for y in (TODAY.year + 1, TODAY.year + 2):
            d = date(y, 1, 15)
            while d.weekday() != 4:
                d += timedelta(days=1)
            out.append(d.isoformat())
        return tuple(sorted(set(out)))

    def option_chain(self, e):
        self._guard()
        S = price_of(self.tk)
        T = up.years_to(e)
        return Options(fake_chain_df(S, "C", T), fake_chain_df(S, "P", T), {"regularMarketPrice": S})

    @property
    def calendar(self):
        self._guard()
        return {"Earnings Date": [TODAY - timedelta(days=80), TODAY + timedelta(days=20)],
                "Ex-Dividend Date": TODAY + timedelta(days=5)}

    @property
    def info(self):
        self._guard()
        return {"beta": 1.234, "dividendRate": 2.5}


def fake_download(chunk, **kw):
    CALLS["download"] += 1
    idx = pd.date_range("2026-11-10 09:30", periods=3, freq="15min")
    cols = pd.MultiIndex.from_product([chunk, ["Open", "High", "Low", "Close", "Adj Close", "Volume"]])
    df = pd.DataFrame(index=idx, columns=cols, dtype=float)
    for t in chunk:
        if t in BROKEN:
            continue
        df[(t, "Close")] = [price_of(t)] * 3
    return df


class FakeYfData:
    def get_raw_json(self, url, params=None, timeout=30):
        if not QUOTES_WORK["on"]:
            raise Exception("Unauthorized")
        CALLS["quote"] += 1
        syms = params["symbols"].split(",")
        return {"quoteResponse": {"result": [{"symbol": s, "regularMarketPrice": price_of(s) + 0.5} for s in syms if s not in BROKEN]}}


yf = types.ModuleType("yfinance")
yf.Ticker = FakeTicker
yf.download = fake_download
yf.__version__ = "fake"
yfdata = types.ModuleType("yfinance.data")
yfdata.YfData = FakeYfData
sys.modules["yfinance"] = yf
sys.modules["yfinance.data"] = yfdata

import update_prices as up  # noqa: E402

up.time.sleep = lambda s: None          # no waiting in tests
up.urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(OSError("offline in test"))

# ------------------------------------------------------------ the math matches the page
check("put price matches page", abs(up.bs_price("P", 100, 100, 1, 0.05, 0.2) - 5.5735) < 1e-3)
check("call price matches page", abs(up.bs_price("C", 100, 100, 1, 0.05, 0.2) - 10.4506) < 1e-3)
check("implied vol round trip", abs(up.implied_vol("P", up.bs_price("P", 50, 45, 0.1, 0.04, 0.37), 50, 45, 0.1, 0.04) - 0.37) < 1e-4)
check("implied vol round trip with dividend", abs(up.implied_vol("P", up.bs_price("P", 50, 45, 0.1, 0.04, 0.37, 0.03), 50, 45, 0.1, 0.04, 0.03) - 0.37) < 1e-4)
check("parity with dividend", abs(up.bs_price("C", 100, 95, 0.5, 0.04, 0.3, 0.03) - up.bs_price("P", 100, 95, 0.5, 0.04, 0.3, 0.03) - (100 * math.exp(-0.015) - 95 * math.exp(-0.02))) < 1e-9)

# ------------------------------------------------------------ choosing expirations
spy = FakeTicker("SPY").options
near, far = up.pick_expirations(spy, TODAY)
check("SPY dailies trimmed to one per week (%d kept)" % len(near), 8 <= len(near) <= 10)
check("near-term all within 60 days", all(0 <= (d - TODAY).days <= 60 for d in near))
check("far list has January LEAPS", any(d.month == 1 and (d - TODAY).days > 120 for d in far))
check("far list is short", len(far) <= 5)

out = tempfile.mkdtemp()
try:
    # ------------------------------------------------------------ stocks: quote service down -> backup download
    rc = up.main(["--mode", "stocks", "--out", out, "--limit", "40"])
    check("good run reports success (green check)", rc == 0)
    st = json.load(open(os.path.join(out, "stocks.json")))
    check("stocks saved via backup download", len(st["stocks"]) == 40 and CALLS["download"] >= 1)
    check("prices are numbers", all(isinstance(v, float) for v in st["stocks"].values()))
    # quote service works -> used instead
    QUOTES_WORK["on"] = True
    CALLS.clear()
    up.main(["--mode", "stocks", "--out", out, "--limit", "40"])
    st = json.load(open(os.path.join(out, "stocks.json")))
    check("quote service used when it works", CALLS["quote"] >= 1 and CALLS["download"] == 0)
    check("quote prices saved", abs(st["stocks"]["A"] - (price_of("A") + 0.5)) < 1e-9)

    # Universe includes the extra tickers
    full = up.load_universe(out)
    check("list has S&P 500 + 4 extras (%d)" % len(full), len(full) == 503 + 4)
    check("EWZ on the list as Brazil ETF", full.get("EWZ") == "Brazil ETF")
    check("BRK.B written the Yahoo way", "BRK-B" in full and "BRK.B" not in full)

    # ------------------------------------------------------------ info
    up.main(["--mode", "info", "--out", out, "--limit", "40"])
    info = json.load(open(os.path.join(out, "info.json")))["info"]
    rec = info["A"]
    check("earnings is the next future date", rec["earnings"] == (TODAY + timedelta(days=20)).isoformat())
    check("ex-dividend saved", rec["exdiv"] == (TODAY + timedelta(days=5)).isoformat())
    check("beta saved", rec["beta"] == 1.23)
    check("yearly dividend saved", rec["divRate"] == 2.5)
    check("sector from S&P list", rec["sector"] == "Health Care")

    # ------------------------------------------------------------ chains
    BROKEN.add("AAPL")
    up.main(["--mode", "chains", "--out", out, "--limit", "40"])
    files = os.listdir(os.path.join(out, "chains"))
    check("one chain file per ticker (minus the broken one): %d" % len(files), len(files) == 39 and "AAPL.json" not in files)
    c = json.load(open(os.path.join(out, "chains", "A.json")))
    e0 = sorted(c["exps"])[0]
    row = c["exps"][e0]["P"][0]
    check("chain row is [strike, bid, ask, last, iv]", len(row) == 5)
    check("strikes outside 60-140% of price dropped", all(0.6 * c["S"] <= r[0] <= 1.4 * c["S"] for r in c["exps"][e0]["P"]))
    far_exps = [e for e in c["exps"] if (date.fromisoformat(e) - TODAY).days > 60]
    check("far expirations carry calls only", far_exps and all(list(c["exps"][e].keys()) == ["C"] for e in far_exps))
    e1 = sorted(c["exps"])[3]
    ivs = [r[4] for r in c["exps"][e1]["P"] if r[1] > 0.10 and 0.88 * c["S"] <= r[0] <= 1.12 * c["S"]]
    check("implied vols come back at 30%% (%s)" % ivs[:4], ivs and all(abs(v - 0.30) < 0.02 for v in ivs))
    meta = json.load(open(os.path.join(out, "meta.json")))
    check("chain run marked complete", meta["chains_last"]["complete"] and meta["chains_last"]["failed"] == ["AAPL"])

    # Throttled -> stops early, remembers where it got to, keeps old files
    THROTTLE["on"] = True
    before = json.load(open(os.path.join(out, "chains", "A.json")))["updated"]
    up.main(["--mode", "chains", "--out", out, "--limit", "40"])
    meta = json.load(open(os.path.join(out, "meta.json")))
    check("throttled run stops and is marked incomplete", meta["chains_last"]["complete"] is False)
    check("old chain files kept when throttled", json.load(open(os.path.join(out, "chains", "A.json")))["updated"] == before)
    check("cursor saved for next run", meta["chains_cursor"] > 0)
    # stock prices refuse to overwrite with a mostly-empty result
    QUOTES_WORK["on"] = False
    for t in list(full)[:40]:
        BROKEN.add(t)
    good_before = json.load(open(os.path.join(out, "stocks.json")))["updated"]
    rc_bad = up.main(["--mode", "stocks", "--out", out, "--limit", "40"])
    check("run that updates nothing reports failure (red X)", rc_bad == 1)
    check("bad stock run keeps the last good file", json.load(open(os.path.join(out, "stocks.json")))["updated"] == good_before)
    THROTTLE["on"] = False
    BROKEN.clear()

    # Keep a sample for the page test
    sample = os.path.join(HERE, "sample-data")
    shutil.rmtree(sample, ignore_errors=True)
    shutil.copytree(out, sample)
finally:
    shutil.rmtree(out, ignore_errors=True)

print("\n%d problem(s)" % len(problems))
sys.exit(1 if problems else 0)
