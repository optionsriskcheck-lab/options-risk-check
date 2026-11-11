"""Opens the page in a real browser, clicks through it and takes screenshots."""
import json, subprocess, sys, time, os, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
site = root / "tests" / "site"
shots = root / "tests" / "shots"
shutil.rmtree(site, ignore_errors=True)
site.mkdir(parents=True)
shots.mkdir(exist_ok=True)
shutil.copy(root / "index.html", site / "index.html")

port = 8765
server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "-d", str(site)],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
problems = []

def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        problems.append(name)

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "404" not in m.text and "Failed to load resource" not in m.text else None)
        page.goto(f"http://localhost:{port}/index.html")
        page.wait_for_timeout(500)
        check("empty page shows guide", page.locator("#guide[open]").count() == 1)
        check("privacy notice shown in full on first visit", page.locator("#pvFull").is_visible() and "private to this browser" in page.inner_text("#pvFull").lower())
        check("privacy notice warns about private windows", "incognito" in page.inner_text("#pvFull"))
        check("one-line version hidden while the full notice shows", not page.locator("#pvMini").is_visible())
        page.click("#pvOk"); page.wait_for_timeout(100)
        check("Got it collapses to one line", page.locator("#pvMini").is_visible() and not page.locator("#pvFull").is_visible())
        check("one-line reminder shows last backup: never", "never" in page.inner_text("#pvMini"))
        page.click("#pvMore"); page.wait_for_timeout(100)
        check("What does this mean? reopens it", page.locator("#pvFull").is_visible())
        page.click("#pvOk"); page.wait_for_timeout(100)
        page.screenshot(path=str(shots / "01-empty.png"), full_page=True)

        # Own trade first, then examples: own trade must survive
        page.fill("#accValue", "35000")
        page.click("#btnAdd"); page.select_option("#f-strategy", "csp")
        page.fill("#f-ticker", "MINE"); page.fill("#f-qty", "1"); page.fill("#f-stock", "50"); page.fill("#f-exp-a", "2026-12-18")
        page.fill("#f-strike-0", "45"); page.fill("#f-fill-0", "1"); page.click("#dlgSave"); page.wait_for_timeout(200)
        page.click("#moreMenu summary"); page.click("[data-act=examples]"); page.wait_for_timeout(300)
        check("examples banner offers Back to my trades", page.locator("#btnBackMine").is_visible() and page.inner_text("#btnBackMine") == "Back to my trades")
        check("own trade hidden while examples show", page.locator(".ptable", has_text="MINE").count() == 0)
        page.click("#btnBackMine"); page.wait_for_timeout(300)
        check("Back to my trades restores own trade", page.locator(".ptable", has_text="MINE").count() == 1 and page.input_value("#accValue") == "35000")
        check("banner gone after going back", not page.locator("#exampleBanner").is_visible())
        # Clear everything while examples show also brings own trades back
        page.click("#moreMenu summary"); page.click("[data-act=examples]"); page.wait_for_timeout(300)
        page.click("#moreMenu summary"); page.click("[data-act=clear]"); page.click("[data-act=clear]"); page.wait_for_timeout(300)
        check("Clear everything during examples returns own trades", page.locator(".ptable", has_text="MINE").count() == 1)
        # Now remove own trade and look at examples for the rest of the test
        page.locator(".ptable [data-del]").first.click(); page.locator(".ptable [data-del]").first.click(); page.wait_for_timeout(200)

        # Example trades
        page.click("#moreMenu summary")
        page.click("[data-act=examples]")
        page.wait_for_timeout(300)
        check("7 example trades", page.locator(".ptable > tbody > tr").count() == 7)
        check("whole-account box or trade alerts show", page.locator(".att").count() >= 3)
        check("needs action present", page.locator(".pill.act").count() >= 1)
        page.screenshot(path=str(shots / "02-examples-desktop.png"), full_page=True)

        # Details row
        page.locator("[data-detail]").first.click()
        page.wait_for_timeout(200)
        check("details row opens", page.locator(".detail-row").count() >= 1)
        check("account risk profile drawn", page.locator("#exposure .rplot path.sline").count() == 1)
        check("8 account tiles incl. theta, vega, gamma", page.locator("#exposure .tile").count() == 8)
        check("theta column in trade list", page.locator(".ptable thead th", has_text="Theta/day").count() == 1)
        check("details show Prob ITM", page.locator(".detail-row .legtable th", has_text="Prob ITM").count() == 1)
        check("details show theta, gamma, vega", all(page.locator(".detail-row .kv dt", has_text=t).count() >= 1 for t in ["Theta per day", "Gamma", "Vega", "Dividend yield"]))
        check("trade risk profile has today + expiration lines", page.locator(".detail-row .rplot path.sline").count() == 2)
        box = page.locator(".detail-row .rplot").first.bounding_box()
        page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.5)
        page.wait_for_timeout(150)
        tip = page.locator(".detail-row .rtip").first
        check("hovering shows both values", tip.is_visible() and tip.inner_text().count("$") >= 2)
        page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.5)
        page.locator(".detail-row .rplot").first.screenshot(path=str(shots / "09-trade-chart-hover.png"))
        page.locator("#exposure .rbox.acct").screenshot(path=str(shots / "10-account-chart.png"))
        page.screenshot(path=str(shots / "03-details.png"), full_page=True)

        # Add a trade with a mistake, then fix it
        page.click("#btnAdd")
        page.select_option("#f-strategy", "pcs")
        page.fill("#f-ticker", "test")
        page.fill("#f-qty", "2")
        page.fill("#f-stock", "50")
        page.fill("#f-exp-a", "2026-12-18")
        page.fill("#f-strike-0", "45")
        page.fill("#f-strike-1", "47")  # wrong: long above short
        page.fill("#f-fill-0", "1.00")
        page.fill("#f-fill-1", "0.40")
        page.click(".more summary")
        page.fill("#f-divy", "2.5")
        page.click("#dlgSave")
        page.wait_for_timeout(200)
        check("wrong strike order shows an error", page.locator("#formErrors:not([hidden]) li").count() >= 1)
        page.screenshot(path=str(shots / "04-form-error.png"))
        page.fill("#f-strike-1", "43")
        page.click("#dlgSave")
        page.wait_for_timeout(200)
        check("trade added", page.locator(".ptable > tbody > tr:not(.detail-row)").count() == 8)
        check("dividend yield saved with the trade", page.evaluate("JSON.parse(localStorage.getItem('options-risk-check.v1')).positions.some(p => p.divYield === '2.5')"))
        check("missing current price is flagged", page.get_by_text("Enter the current price of the 45 put").count() >= 1)

        # Edit it: add current prices
        page.locator(".att").filter(has_text="TEST").locator("[data-edit]").click()
        page.fill("#f-mark-0", "0.50")
        page.fill("#f-mark-1", "0.20")
        page.click("#dlgSave")
        page.wait_for_timeout(200)
        check("missing price flag gone after edit", page.get_by_text("Enter the current price of the 45 put").count() == 0)

        # Delete needs two clicks
        rows_before = page.locator(".ptable > tbody > tr:not(.detail-row)").count()
        btn = page.locator(".ptable [data-del]").last
        btn.click()
        check("first delete click asks to confirm", page.locator(".ptable [data-del]").last.inner_text() == "Confirm delete")
        page.locator(".ptable [data-del]").last.click()
        page.wait_for_timeout(200)
        check("second click deletes", page.locator(".ptable > tbody > tr:not(.detail-row)").count() == rows_before - 1)

        # Settings change re-renders
        page.click(".settings summary")
        page.fill("[data-cfg=profitTarget]", "40")
        page.wait_for_timeout(200)
        check("settings saved", page.evaluate("JSON.parse(localStorage.getItem('options-risk-check.v1')).cfg.profitTarget") == 40)

        # CSV and backup downloads
        page.click("#moreMenu summary")
        with page.expect_download() as d:
            page.click("[data-act=csv]")
        csv_path = shots / "export.csv"
        d.value.save_as(str(csv_path))
        text = csv_path.read_text(encoding="utf-8-sig")
        check("csv has header + rows", text.startswith("Ticker,Strategy") and text.count("DEMO-") >= 6)
        page.click("#moreMenu summary")
        with page.expect_download() as d2:
            page.click("[data-act=save-file]")
        bk = shots / "backup.json"
        d2.value.save_as(str(bk))
        data = json.loads(bk.read_text())
        check("backup has positions", len(data["positions"]) >= 7)
        check("last backup date shown after saving", "never" not in page.inner_text("#pvMini"))

        # Reload keeps trades
        page.reload(); page.wait_for_timeout(400)
        check("trades survive reload", page.locator(".ptable > tbody > tr:not(.detail-row)").count() >= 7)
        check("privacy stays collapsed after reload", page.locator("#pvMini").is_visible())

        # Clear needs two clicks, then load from backup
        page.click("#moreMenu summary")
        page.click("[data-act=clear]")
        check("clear asks first", page.locator(".ptable > tbody > tr").count() >= 7)
        page.click("[data-act=clear]")
        page.wait_for_timeout(200)
        check("cleared", page.locator(".ptable").count() == 0)
        page.set_input_files("#fileInput", str(bk))
        page.wait_for_timeout(300)
        check("loaded from backup", page.locator(".ptable > tbody > tr:not(.detail-row)").count() >= 7)

        # Automatic prices: the files the price job writes
        shutil.copytree(root / "tests" / "sample-data", site / "data")
        chain = json.loads((site / "data" / "chains" / "ABBV.json").read_text())
        exp = sorted(chain["exps"])[4]
        S = chain["S"]
        strike = min((r[0] for r in chain["exps"][exp]["P"]), key=lambda k: abs(k - 0.95 * S))
        page.click("#btnAdd")
        page.select_option("#f-strategy", "csp")
        page.fill("#f-ticker", "abbv")
        page.fill("#f-qty", "1")
        page.fill("#f-exp-a", exp)
        page.fill("#f-strike-0", str(strike))
        page.fill("#f-fill-0", "2.00")
        page.click("#dlgSave")
        page.wait_for_timeout(300)
        page.click("#btnRefresh")
        page.wait_for_timeout(800)
        check("price status shows automatic time", "Stock prices as of" in page.inner_text("#priceStatus"))
        abbv = page.locator(".ptable > tbody > tr").filter(has_text="ABBV")
        check("ABBV stock price filled in automatically", "auto" in abbv.inner_text())
        check("no 'type the price' message for ABBV", page.locator(".att").filter(has_text="ABBV").filter(has_text="Enter the current").count() == 0)
        abbv.locator("[data-detail]").click()
        page.wait_for_timeout(200)
        det = page.locator(".detail-row").filter(has_text="Short put").first.inner_text()
        check("option price and delta filled in from the chain", "auto" in det and "—" not in det.split("Short put")[1].split("\n")[0])
        check("sector from the S&P list", "Health Care" in page.locator(".detail-row").first.inner_text())
        # an expiration the list doesn't carry
        page.locator(".ptable > tbody > tr").filter(has_text="ABBV").locator("[data-edit]").click()
        page.fill("#f-exp-a", "2026-11-11" if exp != "2026-11-11" else "2026-11-12")
        page.click("#dlgSave"); page.wait_for_timeout(300)
        check("missing expiration explained", page.get_by_text("is not in the automatic option prices").count() >= 1)
        # a ticker that isn't on the list, with no typed price
        page.click("#btnAdd"); page.select_option("#f-strategy", "csp")
        page.fill("#f-ticker", "ZZZZ"); page.fill("#f-qty", "1"); page.fill("#f-exp-a", exp)
        page.fill("#f-strike-0", "10"); page.fill("#f-fill-0", "0.5")
        page.click("#dlgSave"); page.wait_for_timeout(300)
        check("not-on-list ticker explained", page.get_by_text("ZZZZ is not on the automatic price list").count() == 1)
        page.screenshot(path=str(shots / "05-auto-prices.png"), full_page=True)

        check("no page errors", not errors)
        if errors:
            print("\n".join(errors))

        # Phone size
        phone = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pp = phone.new_page()
        pp.goto(f"http://localhost:{port}/index.html")
        pp.evaluate("localStorage.clear()")
        pp.reload(); pp.wait_for_timeout(300)
        pp.click("#moreMenu summary"); pp.click("[data-act=examples]"); pp.wait_for_timeout(300)
        sw = pp.evaluate("document.documentElement.scrollWidth")
        check("phone: no sideways scrolling (width %s)" % sw, sw <= 392)
        check("phone: cards shown", pp.locator(".pcard").count() == 7)
        pp.locator(".pcard [data-detail]").nth(4).click(); pp.wait_for_timeout(200)
        sw2 = pp.evaluate("document.documentElement.scrollWidth")
        check("phone: details open, still no sideways scrolling (width %s)" % sw2, sw2 <= 392)
        check("phone: trade chart drawn in card", pp.locator(".pcard .rplot path.sline").count() >= 1)
        pp.locator(".pcard .detail-box").first.screenshot(path=str(shots / "11-phone-chart.png"))
        pp.screenshot(path=str(shots / "06-phone.png"), full_page=True)
        pp.click("#btnAdd"); pp.select_option("#f-strategy", "ic"); pp.wait_for_timeout(200)
        pp.screenshot(path=str(shots / "07-phone-form.png"))

        # Desktop sideways scroll check and dark mode
        dk = browser.new_context(viewport={"width": 1280, "height": 900}, color_scheme="dark")
        dp = dk.new_page()
        dp.goto(f"http://localhost:{port}/index.html")
        dp.click("#moreMenu summary"); dp.click("[data-act=examples]"); dp.wait_for_timeout(300)
        check("desktop: no sideways scrolling", dp.evaluate("document.documentElement.scrollWidth") <= 1280)
        dp.screenshot(path=str(shots / "08-dark.png"), full_page=True)
        lap = browser.new_context(viewport={"width": 1024, "height": 768})
        lp = lap.new_page(); lp.goto(f"http://localhost:{port}/index.html")
        lp.click("#moreMenu summary"); lp.click("[data-act=examples]"); lp.wait_for_timeout(300)
        check("small laptop: no sideways scrolling", lp.evaluate("document.documentElement.scrollWidth") <= 1024)
        browser.close()
finally:
    server.terminate()

print("\n%d problem(s)" % len(problems))
sys.exit(1 if problems else 0)
