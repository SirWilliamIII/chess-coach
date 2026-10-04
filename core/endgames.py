"""Endgame trainer: random positions with the material you pick and a known result (365chess-style, plus a
"material lies" mode: you're down material, yet it's a draw or a win).

Positions with up to 7 pieces are labelled by Lichess' tablebase (exact); bigger pawn set-ups by a deep
Stockfish search (|eval| ≤ 0.3 counts as even, ≥ 2.5 as winning), and say so. A cheap shallow search
filters candidates first, so the tablebase sees only a few per drill.

Random placement keeps starts clean: kings apart, pawns on ranks 2-7, a side's two bishops on opposite
colours, nobody in check, and no capture available to either side (no hanging pieces to grab).
"""

import random
import time

import chess

from . import tablebase

VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
LETTER = {"K": chess.KING, "Q": chess.QUEEN, "R": chess.ROOK, "B": chess.BISHOP, "N": chess.KNIGHT, "P": chess.PAWN}

# The picker: (group, spec, label). Spec = your pieces "-" theirs; "rand:N" = N random pieces in all,
# "pawns:N" = kings plus N pawns.
PRESETS = [
    ("Mates", "KQ-K", "Queen mate"),
    ("Mates", "KR-K", "Rook mate"),
    ("Mates", "KBB-K", "Two bishops"),
    ("Mates", "KBN-K", "Bishop + knight"),
    ("Pawns", "KP-K", "King + pawn"),
    ("Pawns", "KP-KP", "Pawn each"),
    ("Pawns", "KPP-KP", "Two vs one"),
    ("Pawns", "KPP-KPP", "Two each"),
    ("Pawns", "KPPP-KPP", "Three vs two"),
    ("Rooks", "KRP-KR", "Rook + pawn vs rook"),
    ("Rooks", "KRPP-KRP", "Rook + 2 pawns vs rook + pawn"),
    ("Rooks", "KR-KP", "Rook vs pawn"),
    ("Rooks", "KRP-KRP", "Rook + pawn each"),
    ("Queens", "KQ-KR", "Queen vs rook"),
    ("Queens", "KQ-KP", "Queen vs pawn"),
    ("Queens", "KQP-KQ", "Queen + pawn vs queen"),
    ("Minor pieces", "KBP-KB", "Bishop + pawn vs bishop"),
    ("Minor pieces", "KNP-KN", "Knight + pawn vs knight"),
    ("Minor pieces", "KBP-KN", "Bishop + pawn vs knight"),
    ("Minor pieces", "KB-KP", "Bishop vs pawn"),
    ("Minor pieces", "KN-KP", "Knight vs pawn"),
    ("Random", "rand:4", "4 pieces"),
    ("Random", "rand:5", "5 pieces"),
    ("Random", "rand:6", "6 pieces"),
    ("Random", "rand:7", "7 pieces"),
    ("Pawn structures", "pawns:6", "6 pawns"),
    ("Pawn structures", "pawns:8", "8 pawns"),
    ("Pawn structures", "pawns:10", "10 pawns"),
]

MODES = ("win", "draw", "lies")
TIME_BUDGET = 14.0      # seconds per drill before giving up
TB_BUDGET = 20          # tablebase requests per drill
MIN_DTM = 10            # plies: a tablebase win shorter than this is too quick to be a drill
GIVE_UP_AFTER = 80      # candidates with none passing the shallow filter: that result doesn't happen here
ENGINE_EVEN = 30        # cp: "0.0" for positions too big for the tablebase
ENGINE_WIN = 250


class NoPosition(Exception):
    """The material can't (or rarely does) give that result, e.g. a draw with K+Q vs K."""


def points(pieces: list[int]) -> int:
    return sum(VALUES[p] for p in pieces)


def _parse(spec: str) -> tuple[list[int], list[int]]:
    mine, theirs = spec.upper().split("-")
    return [LETTER[c] for c in mine if c != "K"], [LETTER[c] for c in theirs if c != "K"]


def _random_material(n: int, rng: random.Random, pawns_only: bool) -> tuple[list[int], list[int]]:
    """n non-king pieces split between the sides, weighted towards pawns; at most one queen a side."""
    kinds = [chess.PAWN] * 10 + [chess.KNIGHT] * 2 + [chess.BISHOP] * 2 + [chess.ROOK] * 3 + [chess.QUEEN]
    sides: tuple[list[int], list[int]] = ([], [])
    for _ in range(n):
        side = sides[rng.randrange(2)]
        while True:
            k = chess.PAWN if pawns_only else rng.choice(kinds)
            if k == chess.QUEEN and chess.QUEEN in side:
                continue
            if k != chess.PAWN and side.count(k) >= 2:
                continue
            side.append(k)
            break
    return sides


def _place(mine: list[int], theirs: list[int], me: chess.Color, rng: random.Random) -> chess.Board | None:
    board = chess.Board(None)
    board.turn = me
    free = set(chess.SQUARES)

    def put(piece_type, color, squares):
        sq = rng.choice(sorted(squares & free))
        board.set_piece_at(sq, chess.Piece(piece_type, color))
        free.discard(sq)
        return sq

    k1 = put(chess.KING, me, set(chess.SQUARES))
    put(chess.KING, not me, {s for s in chess.SQUARES if chess.square_distance(s, k1) > 1})
    for color, pieces in ((me, mine), (not me, theirs)):
        # pawns at least two steps from promoting: one on the 7th makes the drill a one-mover
        pawn_squares = {s for s in chess.SQUARES if (1 <= chess.square_rank(s) <= 5 if color == chess.WHITE
                                                     else 2 <= chess.square_rank(s) <= 6)}
        bishop_colours = []
        for p in pieces:
            squares = pawn_squares if p == chess.PAWN else set(chess.SQUARES)
            if p == chess.BISHOP and bishop_colours:  # a pair on opposite colours
                squares = {s for s in squares if (chess.square_file(s) + chess.square_rank(s)) % 2 != bishop_colours[0]}
            if not squares & free:
                return None
            sq = put(p, color, squares)
            if p == chess.BISHOP:
                bishop_colours.append((chess.square_file(sq) + chess.square_rank(sq)) % 2)
    if not board.is_valid() or board.is_check() or board.is_game_over():
        return None
    # no captures for either side: a random start shouldn't open with a free piece
    if any(board.is_capture(m) for m in board.legal_moves):
        return None
    flipped = board.copy(stack=False)
    flipped.turn = not me
    if flipped.is_check() or any(flipped.is_capture(m) for m in flipped.legal_moves):
        return None
    return board


def _mover_cp(engine, board: chess.Board, depth: int, seconds: float) -> int:
    lines = engine.lines(board, multipv=1, seconds=seconds, depth=depth)
    cp = lines[0]["cp_white"] if lines else 0
    return cp if board.turn == chess.WHITE else -cp


def _want(mode: str, outcome: str, lies: bool) -> bool:
    if mode == "win":
        return outcome == "win"
    if mode == "draw":
        return outcome == "draw"
    return lies and outcome in ("draw", "win")


def generate(engine, spec: str, mode: str, me: chess.Color, seed: int | None = None) -> dict:
    """A position for `spec` (see PRESETS) where the side `me` (to move) has the result `mode` asks for.
    Raises NoPosition when none turns up within the budget, ValueError on a bad spec/mode."""
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    rng = random.Random(seed)
    fixed = None
    if spec.startswith(("rand:", "pawns:")):
        n = int(spec.split(":")[1])
        n = n - 2 if spec.startswith("rand:") else n  # rand:N counts the kings
        if not 1 <= n <= 14:
            raise ValueError("piece count out of range")
    else:
        fixed = _parse(spec)
        if mode == "lies":
            # you take the side with less material; equal material can't "lie"
            a, b = fixed
            if points(a) == points(b):
                raise NoPosition("Both sides have the same material here, so it can't look lopsided. Pick another set or mode.")
            if points(a) > points(b):
                fixed = (b, a)

    started = time.monotonic()
    tb_calls = 0
    tried = passed = 0
    while time.monotonic() - started < TIME_BUDGET:
        if fixed:
            mine, theirs = fixed
        else:
            mine, theirs = _random_material(n, rng, spec.startswith("pawns:"))
            if mode == "lies" and points(mine) >= points(theirs):
                mine, theirs = theirs, mine
                if points(mine) == points(theirs):
                    continue
        board = _place(mine, theirs, me, rng)
        if board is None:
            continue
        tried += 1
        if tried >= GIVE_UP_AFTER and not passed:
            break
        lies = points(mine) < points(theirs)
        # shallow filter: skip the obvious misses before asking the tablebase or searching deep
        cp = _mover_cp(engine, board, depth=8, seconds=0.2)
        if mode == "win" and cp < 150:
            continue
        if mode == "draw" and abs(cp) > 150:
            continue
        if mode == "lies" and cp < -150:
            continue
        passed += 1
        source, outcome, dtm, ev = None, None, None, None
        if tablebase.covers(board) and tb_calls < TB_BUDGET:
            tb_calls += 1
            tb = tablebase.probe(board)
            if tb:
                source, outcome, dtm = "tablebase", tb["outcome"], tb["dtm"]
                if outcome == "win" and dtm is not None and abs(dtm) < MIN_DTM:
                    continue
        if source is None:
            ev = _mover_cp(engine, board, depth=22, seconds=2.0)
            outcome = "win" if ev >= ENGINE_WIN else "loss" if ev <= -ENGINE_WIN else "draw" if abs(ev) <= ENGINE_EVEN else None
            source = "engine"
        if outcome and _want(mode, outcome, lies):
            return {"fen": board.fen(), "outcome": outcome, "source": source, "dtm": dtm, "eval": ev,
                    "mine": "K" + "".join(chess.piece_symbol(p).upper() for p in sorted(mine, reverse=True)),
                    "theirs": "K" + "".join(chess.piece_symbol(p).upper() for p in sorted(theirs, reverse=True)),
                    "points": [points(mine), points(theirs)], "tried": tried}
    raise NoPosition({"win": "No winning position turned up for this material.",
                      "draw": "No drawn position turned up for this material (some sets, like K+Q vs K, always win).",
                      "lies": "No position where the side down material holds turned up."}[mode]
                     + " Try again or pick another set.")
