"""Exact results for positions with up to 7 pieces, from Lichess' public tablebase API
(https://tablebase.lichess.ovh, no token). Used by the endgame trainer to pick positions with a known
result and to say, after each of your moves, whether it kept that result.

Cached in memory (positions repeat a lot while a drill is played); one request at a time, since the
service asks clients not to hammer it. Network errors return None: callers fall back to Stockfish.
"""

import json
import threading
import urllib.parse
import urllib.request
from collections import OrderedDict

import chess

URL = "https://tablebase.lichess.ovh/standard?fen="
MAX_PIECES = 7
TIMEOUT = 6

_lock = threading.Lock()
_cache: OrderedDict = OrderedDict()
CACHE_SIZE = 5000

# Lichess' categories, from the side to move's point of view. "cursed-win"/"blessed-loss" are wins/losses
# that the 50-move rule turns into draws, so for a human they're draws; "maybe-*" come from DTZ rounding.
OUTCOME = {"win": "win", "maybe-win": "win", "cursed-win": "draw", "draw": "draw",
           "blessed-loss": "draw", "maybe-loss": "loss", "loss": "loss"}
FLIP = {"win": "loss", "loss": "win", "draw": "draw"}


def covers(board: chess.Board) -> bool:
    return chess.popcount(board.occupied) <= MAX_PIECES and not board.castling_rights


def probe(board: chess.Board) -> dict | None:
    """{"outcome": win/draw/loss for the side to move, "dtm", "dtz", "moves": [{uci, san, outcome (for the
    side to move here, after playing it), dtm}] best first}; None when not covered or unreachable."""
    if not covers(board):
        return None
    key = board.epd()
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
        try:
            req = urllib.request.Request(URL + urllib.parse.quote(board.fen()),
                                         headers={"User-Agent": "chess-coach (personal trainer)"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                data = json.load(r)
        except Exception as e:  # offline, 429, timeout: the caller decides what to do without it
            print(f"tablebase: {e}")
            return None
        cat = OUTCOME.get(data.get("category"))
        if cat is None:
            return None  # "unknown" (e.g. a position the tables can't index)
        out = {"outcome": cat, "dtm": data.get("dtm"), "dtz": data.get("dtz"), "moves": [
            # each move's category is the opponent's after it; flip it back to the mover's
            {"uci": m["uci"], "san": m["san"], "outcome": FLIP.get(OUTCOME.get(m.get("category")), None),
             "dtm": m.get("dtm")}
            for m in data.get("moves", [])]}
        _cache[key] = out
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
        return out
