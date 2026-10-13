"""Saved board positions: a title plus the line that reached it (start position + SAN moves), in the
library's SQLite file. Whatever produced the board (a loaded game, a pasted PGN, a set-up position, a bot
game) is stored the same way, so reopening it can still step back through how it got there.
"""

import json
import re
import time

import chess

from . import eco, library

SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at REAL NOT NULL,
    title TEXT NOT NULL,
    fen TEXT NOT NULL,
    start_fen TEXT NOT NULL,
    moves TEXT NOT NULL,           -- SAN, space-separated
    orientation TEXT NOT NULL,
    source TEXT,                   -- e.g. "DrKlapika vs kobeesprit" or "Bot game"
    opening TEXT,                  -- deepest ECO name along the line, if any
    marks TEXT                     -- JSON [{orig, dest?, brush}]: arrows and filled squares drawn on it
);
"""

BRUSHES = {"drawNone", "drawCtrl", "drawCmd", "drawOpt", "drawFn"}
SQUARE = re.compile(r"^[a-h][1-8]$")
MAX_MARKS = 64

_ready = False


def _db():
    global _ready
    if not _ready:
        db = library.db()
        db.executescript(SCHEMA)
        # tables made before marks (2026-10-13) get the column
        if "marks" not in {r[1] for r in db.execute("PRAGMA table_info(positions)")}:
            db.execute("ALTER TABLE positions ADD COLUMN marks TEXT")
            db.commit()
        _ready = True
    return library.db()


def _row(r) -> dict:
    d = dict(r)
    d["moves"] = d["moves"].split() if d["moves"] else []
    d["marks"] = json.loads(d["marks"]) if d.get("marks") else []
    return d


def clean_marks(marks: list) -> list[dict]:
    """Keep well-formed marks only: a square (filled) or an arrow, in one of the drawing brushes."""
    out = []
    for m in marks[:MAX_MARKS]:
        if not isinstance(m, dict) or not SQUARE.match(str(m.get("orig", ""))) or m.get("brush") not in BRUSHES:
            continue
        d = {"orig": m["orig"], "brush": m["brush"]}
        if m.get("dest"):
            if not SQUARE.match(str(m["dest"])) or m["dest"] == m["orig"]:
                continue
            d["dest"] = m["dest"]
        out.append(d)
    return out


def all_() -> list[dict]:
    with library._lock:
        rows = _db().execute("SELECT * FROM positions ORDER BY created_at DESC").fetchall()
    return [_row(r) for r in rows]


def save(title: str, start_fen: str, moves: list[str], orientation: str, source: str | None,
         marks: list | None = None) -> dict:
    """Store a position; raises ValueError if the line doesn't replay from `start_fen`."""
    board = chess.Board(start_fen)
    opening = None
    for san in moves:
        board.push_san(san)  # ValueError on an illegal move: the caller reports it
        hit = eco.lookup(board)
        if hit:
            opening = f"{hit['eco']} · {hit['name']}"
    with library._lock:
        cur = _db().execute(
            "INSERT INTO positions (created_at, title, fen, start_fen, moves, orientation, source, opening, marks)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (time.time(), title, board.fen(), start_fen, " ".join(moves),
             orientation if orientation in ("white", "black") else "white", source, opening,
             json.dumps(clean_marks(marks or [])) if marks else None))
        _db().commit()
        r = _db().execute("SELECT * FROM positions WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _row(r)


def rename(pos_id: int, title: str) -> bool:
    with library._lock:
        n = _db().execute("UPDATE positions SET title = ? WHERE id = ?", (title, pos_id)).rowcount
        _db().commit()
    return n > 0


def remove(pos_id: int) -> bool:
    with library._lock:
        n = _db().execute("DELETE FROM positions WHERE id = ?", (pos_id,)).rowcount
        _db().commit()
    return n > 0
