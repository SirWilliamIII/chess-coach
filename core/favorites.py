"""Favourite games: the PGN, names, date and an optional title, in the library's SQLite file.

The PGN is stored whole so a favourite survives the review cache (data/reviews/) being cleared.
"""

import time

import chess
import chess.pgn

from . import library

SCHEMA = """
CREATE TABLE IF NOT EXISTS favorites (
    game_id TEXT PRIMARY KEY,
    created_at REAL NOT NULL,
    title TEXT,
    white TEXT, black TEXT, white_elo TEXT, black_elo TEXT,
    result TEXT, date TEXT, opening TEXT,
    pgn TEXT NOT NULL
);
"""

_ready = False


def _db():
    global _ready
    if not _ready:
        library.db().executescript(SCHEMA)
        _ready = True
    return library.db()


def pgn_of(review: dict) -> str:
    game = chess.pgn.Game()
    h = game.headers
    h["White"], h["Black"], h["Result"] = review["white"], review["black"], review["result"]
    if review.get("date"):
        h["Date"] = review["date"]
    for key, tag in (("white_elo", "WhiteElo"), ("black_elo", "BlackElo"), ("opening", "Opening"),
                     ("time_control", "TimeControl")):
        if review.get(key):
            h[tag] = str(review[key])
    board = chess.Board(review["start_fen"])
    if review["start_fen"] != chess.STARTING_FEN:
        game.setup(board)
    node = game
    for m in review["moves"]:
        node = node.add_variation(chess.Move.from_uci(m["uci"]))
    return str(game)


def get(game_id: str | None) -> dict | None:
    if not game_id:
        return None
    with library._lock:
        r = _db().execute("SELECT * FROM favorites WHERE game_id = ?", (game_id,)).fetchone()
    return dict(r) if r else None


def save(review: dict, title: str | None = None) -> dict:
    """Add (or refresh) a favourite; `title` None keeps the one it already has."""
    with library._lock:
        _db().execute(
            """INSERT INTO favorites (game_id, created_at, title, white, black, white_elo, black_elo,
                   result, date, opening, pgn) VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(game_id) DO UPDATE SET title = COALESCE(excluded.title, favorites.title)""",
            (review["game_id"], time.time(), title, review["white"], review["black"],
             review.get("white_elo"), review.get("black_elo"), review["result"], review.get("date"),
             review.get("opening"), pgn_of(review)))
        _db().commit()
    return get(review["game_id"])


def set_title(game_id: str, title: str | None) -> None:
    with library._lock:
        _db().execute("UPDATE favorites SET title = ? WHERE game_id = ?", (title, game_id))
        _db().commit()


def remove(game_id: str) -> None:
    with library._lock:
        _db().execute("DELETE FROM favorites WHERE game_id = ?", (game_id,))
        _db().commit()


def all_() -> list[dict]:
    with library._lock:
        rows = _db().execute("SELECT * FROM favorites ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]
