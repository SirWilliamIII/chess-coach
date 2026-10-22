"""Download a chess.com piece set for this machine's board.

  .venv/bin/python scripts/fetch_pieces.py [set]     # default: neo

chess.com's pieces are their artwork, and this repo is public, so they live only in data/pieces/ (gitignored):
data/pieces/<set>/*.png and data/pieces/pieces.css, which the page loads after the vendored free set (gioco). The
server serves data/pieces/ at /pieces/; without these files that stylesheet 404s and the board keeps gioco. Rerun
with another set name to switch (neo_wood, neon, …: chess.com's theme names, not checked here).
"""

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "pieces"
URL = "https://images.chesscomfiles.com/chess-themes/pieces/{set}/300/{code}.png"  # 300 px: sharp on Retina
# chess.com's image server answers 403 to urllib/curl's own user agent
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
           "Referer": "https://www.chess.com/"}
ROLES = {"p": "pawn", "n": "knight", "b": "bishop", "r": "rook", "q": "queen", "k": "king"}


def main(name: str = "neo") -> None:
    folder = OUT / name
    folder.mkdir(parents=True, exist_ok=True)
    css = [f"/* chess.com's {name} pieces, local copy from scripts/fetch_pieces.py (not in git) */"]
    for c, color in (("w", "white"), ("b", "black")):
        for k, role in ROLES.items():
            code = c + k
            req = urllib.request.Request(URL.format(set=name, code=code), headers=HEADERS)
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = r.read()
            except Exception as e:
                sys.exit(f"{code}: {e} (is '{name}' a chess.com piece set?)")
            (folder / f"{code}.png").write_bytes(data)
            css.append(f".cg-wrap piece.{role}.{color} {{ background-image: url('/pieces/{name}/{code}.png'); }}")
    (OUT / "pieces.css").write_text("\n".join(css) + "\n")
    print(f"{name}: 12 pieces in {folder}; hard-reload the page (⌘⇧R)")


if __name__ == "__main__":
    main(*sys.argv[1:2])
