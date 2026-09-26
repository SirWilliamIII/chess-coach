"""Spot "only a GM would see this" moments: a forced mate or a sacrifice that clearly beats
everything else. Pure engine work (no LLM), so it's cheap to run on every move."""

import chess

from .engine import Engine, win_percent
from .features import VALUES

MIN_WIN_GAP = 20       # win% by which the best move must beat the second best
MIN_SAC = 2            # material (pawns) the mover must be down at some point in the line
SEARCH_SECONDS = 1.5


def _see(board: chess.Board, square: chess.Square) -> int:
    """Static exchange evaluation: what the side to move wins by capturing on `square` and
    trading off optimally (always recapturing with the cheapest legal piece). Uses real legal
    moves, so pins and checks are respected."""
    captures = [m for m in board.legal_moves if m.to_square == square and board.piece_at(square)]
    if not captures:
        return 0
    m = min(captures, key=lambda mv: VALUES[board.piece_at(mv.from_square).piece_type] or 100)
    gained = VALUES[board.piece_at(square).piece_type]
    b = board.copy(stack=False)
    b.push(m)
    return max(0, gained - _see(b, square))


def _sacrifice_depth(board: chess.Board, pv: list[chess.Move], mover: chess.Color) -> int:
    """Largest material the mover puts en prise with one of their first three moves in the line:
    what the opponent can win on the destination square (defenders and recaptures included),
    minus what the move itself captured. Plain exchanges net out to zero."""
    b = board.copy(stack=False)
    worst = 0
    for i, mv in enumerate(pv[:6]):
        if i % 2 == 0:  # the mover's move
            captured = b.piece_at(mv.to_square)
            took = VALUES[captured.piece_type] if captured else (1 if b.is_en_passant(mv) else 0)
            after = b.copy(stack=False)
            after.push(mv)
            worst = max(worst, _see(after, mv.to_square) - took)
        b.push(mv)
    return worst


def find(engine: Engine, board: chess.Board) -> dict | None:
    """Return a description of the GM-level resource for the side to move, or None."""
    if board.is_game_over():
        return None
    lines = engine.lines(board, multipv=2, seconds=SEARCH_SECONDS)
    if not lines:
        return None
    mover = board.turn
    sign = 1 if mover == chess.WHITE else -1
    best = lines[0]
    best_cp = sign * best["cp_white"]
    second_cp = sign * lines[1]["cp_white"] if len(lines) > 1 else -10_000
    gap = win_percent(best_cp) - win_percent(second_cp)

    pv = [chess.Move.from_uci(u) for u in best["pv"]]
    mate = best["eval_white"].startswith("#") and best_cp > 0
    mate_in = int(best["eval_white"].lstrip("#-")) if mate else None
    sac = _sacrifice_depth(board, pv, mover) if pv else 0

    kind = None
    second_is_mate = len(lines) > 1 and lines[1]["eval_white"].startswith("#") and sign * lines[1]["cp_white"] > 0
    if mate and mate_in >= 2 and (gap >= MIN_WIN_GAP or (sac >= MIN_SAC and not second_is_mate)):
        # a mating attack that starts with a sacrifice counts even if boring moves also win
        kind = "sacrificial mating attack" if sac >= MIN_SAC else "forced mate"
    elif sac >= MIN_SAC and gap >= MIN_WIN_GAP and best_cp >= 150:
        kind = "sacrifice"
    if not kind:
        return None
    return {
        "kind": kind,
        "move": best["move"],
        "line": best["line"],
        "eval_white": best["eval_white"],
        "mate_in": mate_in,
        "material_sacrificed": sac,
        "second_best": lines[1]["move"] if len(lines) > 1 else None,
        "second_eval_white": lines[1]["eval_white"] if len(lines) > 1 else None,
        "win_pct_gap": round(gap, 1),
    }

