# Options Risk Check

A free web page that shows which options trades need attention and whether an account is stretched too thin. It covers cash-secured puts, covered calls, shares, put and call credit spreads, iron condors and poor man's covered calls (PMCCs).

- **Needs attention:** days to expiration, strikes being tested, delta alerts, profit targets, earnings and ex-dividend dates before expiration, PMCC strike checks, pin risk.
- **Account exposure:** cash needed if assigned, delta dollars, beta-weighted SPY move, concentration by ticker and sector, a stress test.
- **Risk profiles:** profit or loss across stock prices for each trade (today and at expiration), and for the whole account against SPY moves.

Members' trades are saved only in their own web browser. Nothing they type is ever sent anywhere.

## How prices work

A scheduled job runs on GitHub's computers and saves price files next to the page. Prices come from Yahoo Finance through the free `yfinance` tool. Covered: the S&P 500 plus SPY, QQQ, IWM and EWZ.

| What | When (Chicago time, winter / summer) |
|---|---|
| Stock prices | about every 30 minutes, 7 AM to 3:35 PM / 8 AM to 4:35 PM, weekdays |
| Option chains | once a day, starting 12:10 PM / 1:10 PM (takes about 1 to 1.5 hours) |
| Earnings, ex-dividend dates, beta, S&P 500 list | early morning, weekdays |

Between option-chain pulls, the page estimates option prices from the newest stock price. If a run fails, the last good prices are kept and the page warns when prices are old. For tickers or expiration dates not on the list, members type the prices in.

Yahoo data is meant for personal use, and Yahoo can slow down or block heavy use. This is a free tool with no guarantee.

## What's in this project

| File | What it is |
|---|---|
| `index.html` | The page itself (built from the `src` folder) |
| `.github/workflows/update-prices.yml` | The schedule that runs the price job and publishes the site |
| `scripts/update_prices.py` | The price job |
| `tickers/sp500.csv`, `tickers/extra.csv` | The ticker list (S&P 500 is refreshed automatically; add extra tickers to `extra.csv`) |
| `requirements.txt` | Tells GitHub to install yfinance |
| `src/`, `build.py` | The page's source; `python build.py` rebuilds `index.html` |
| `tests/` | Checks for the math, the price job and the page |
| `keepalive.txt` | Updated monthly so GitHub keeps the schedule switched on |

## Disclaimer

For education and personal record-keeping only. Not financial advice and not a recommendation to open, close or adjust any trade. Numbers are estimates from a standard option-pricing model and can differ from a broker's.
