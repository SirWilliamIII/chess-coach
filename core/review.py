"""Whole-game review: one engine pass over every position, cached to disk."""

import hashlib
import io
import json
from pathlib import Path
from typing import Callable

import chess
import chess.pgn

from .engine import Engine, classify, win_percent

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "reviews"


def load_pgn(pgn_text: str) -> chess.pgn.Game:
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None or not list(game.mainline_moves()):
        raise ValueError("could not parse a game with moves from the PGN")
    return game


def game_id(game: chess.pgn.Game) -> str:
    site = game.headers.get("Site", "")
    if "lichess.org/" in site:
        return site.rstrip("/").rsplit("/", 1)[-1][:8]
    link = game.headers.get("Link", "")
    if "chess.com/" in link:
        return "cc" + link.rstrip("/").rsplit("/", 1)[-1]
    return hashlib.sha1(str(game).encode()).hexdigest()[:10]


def from_lichess(gid: str) -> bool:
    """Whether a game_id (from game_id() above) is a Lichess game, whose ratings are on Lichess's scale."""
    return len(gid) == 8 and not gid.startswith("cc")


def ply_label(ply: int) -> str:
    """ply 1 -> '1.', ply 2 -> '1...'"""
    n = (ply + 1) // 2
    return f"{n}." if ply % 2 == 1 else f"{n}..."


def opening_name(h: chess.pgn.Headers) -> str | None:
    if h.get("Opening"):
        return h["Opening"]
    if "chess.com/openings/" in h.get("ECOUrl", ""):
        from frontends.chesscom.client import opening_from_url
        return opening_from_url(h["ECOUrl"])
    return h.get("ECO")


def _date(h: chess.pgn.Headers) -> str | None:
    """The game's date as PGN writes it (2026.10.03); None for the "????.??.??" placeholder."""
    d = h.get("UTCDate") or h.get("Date") or ""
    return d if d and "?" not in d else None


def review_game(
    game: chess.pgn.Game,
    engine: Engine,
    seconds: float = 0.3,
    progress: Callable[[int, int], None] | None = None,
    use_cache: bool = True,
) -> dict:
    gid = game_id(game)
    cache = CACHE_DIR / f"{gid}.json"
    if use_cache and cache.exists():
        return json.loads(cache.read_text())

    h = game.headers
    board = game.board()
    moves = list(game.mainline_moves())

    # Evaluate every position once; eval after ply N == eval before ply N+1.
    positions = [board.copy(stack=False)]
    for m in moves:
        board.push(m)
        positions.append(board.copy(stack=False))
    evals = []
    for i, pos in enumerate(positions):
        evals.append(engine.evaluate(pos, seconds))
        if progress:
            progress(i + 1, len(positions))

    records = []
    for i, move in enumerate(moves):
        before, after = positions[i], positions[i + 1]
        mover = before.turn
        sign = 1 if mover == chess.WHITE else -1
        wb = win_percent(sign * evals[i]["cp_white"])
        wa = win_percent(sign * evals[i + 1]["cp_white"])
        drop = max(0.0, wb - wa)
        played_best = evals[i]["best_uci"] == move.uci()
        records.append({
            "ply": i + 1,
            # numbering from the position itself: set-up games may start at any move, with either side
            "label": f"{before.fullmove_number}." if mover == chess.WHITE else f"{before.fullmove_number}...",
            "color": "white" if mover == chess.WHITE else "black",
            "san": before.san(move),
            "uci": move.uci(),
            "fen_before": before.fen(),
            "fen_after": after.fen(),
            "eval_before": evals[i]["eval_white"],
            "eval_after": evals[i + 1]["eval_white"],
            "best": evals[i]["best"],
            "best_line": evals[i]["line"],
            "played_best": played_best,
            "win_pct_lost": round(drop, 1),
            "class": None if played_best else classify(drop),
        })

    review = {
        "game_id": gid,
        "white": h.get("White", "?"),
        "black": h.get("Black", "?"),
        "white_elo": h.get("WhiteElo"),
        "black_elo": h.get("BlackElo"),
        "result": h.get("Result", "*"),
        "opening": opening_name(h),
        "time_control": h.get("TimeControl"),
        "date": _date(h),
        "start_fen": game.board().fen(),
        "moves": records,
    }
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(review, indent=1))
    return review


def pgn_text(review: dict) -> str:
    board = chess.Board(review["start_fen"])
    return board.variation_san([chess.Move.from_uci(m["uci"]) for m in review["moves"]])
