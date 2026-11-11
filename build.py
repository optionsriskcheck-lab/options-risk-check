"""Puts the page together into one file: dist/index.html."""
from pathlib import Path

here = Path(__file__).parent
src = here / "src"
html = (src / "template.html").read_text()
html = html.replace("/*__CSS__*/", (src / "style.css").read_text())
html = html.replace("//__CORE__", (src / "core.js").read_text())
html = html.replace("//__APP__", (src / "app.js").read_text())
for out in (here / "index.html", here / "dist" / "index.html"):
    out.parent.mkdir(exist_ok=True)
    out.write_text(html)
print(f"Built index.html ({len(html):,} characters)")
