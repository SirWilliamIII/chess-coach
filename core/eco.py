"""Opening names from the vendored lichess-org/chess-openings dataset (core/eco_data/*.tsv, CC0):
free, offline and instant, so it works without a Lichess token and fills the gaps where the live
explorer returns no name for a real book position. Matching is by position (EPD), so a
transposition into a named opening is recognised too."""

import csv
import threading
from pathlib import Path

import chess

DATA = Path(__file__).resolve().parent / "eco_data"

_lock = threading.Lock()
_index: dict[str, tuple[str, str]] | None = None   # epd -> (eco, name)


def _load() -> dict[str, tuple[str, str]]:
    index: dict[str, tuple[str, str]] = {}
    for path in sorted(DATA.glob("*.tsv")):
        with path.open(newline="") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                board = chess.Board()
                try:
                    for tok in row["pgn"].split():
                        if tok[0].isdigit():
                            continue          # "1." / "12." move numbers
                        board.push_san(tok)
                except ValueError:
                    continue                  # a malformed line must not take the whole table down
                index.setdefault(board.epd(), (row["eco"], row["name"]))
    return index


def lookup(board: chess.Board) -> dict | None:
    """{eco, name, family} if this exact position is a named opening, else None."""
    global _index
    with _lock:
        if _index is None:
            _index = _load()
    hit = _index.get(board.epd())
    if not hit:
        return None
    eco, name = hit
    return {"eco": eco, "name": name, "family": name.split(":")[0].strip()}


def names() -> set[str]:
    lookup(chess.Board())   # make sure the index is built
    return {name for _, name in _index.values()}
