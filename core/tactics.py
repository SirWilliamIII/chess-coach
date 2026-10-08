"""Tactics finder: does the side to move have a tactic here, which move starts it, and what kind is it.

Two steps. (1) The engine decides whether there is one: a tactic is a position where one move is clearly better
than every other (win % gap between Stockfish's #1 and #2) and leaves the mover better off. That's roughly how
Lichess picks puzzles from games. (2) Board geometry names it, walking the mover's moves in the best line:
mate, fork, pin, skewer, discovered attack, hanging piece. Geometry is microseconds; the cost is the search.

Validated against Lichess's puzzle database (theme tags as ground truth): scripts/tactics_eval.py.
"""

import chess

from .engine import MATE_CP, Engine, win_percent
from .features import VALUES
from .gm_moments import _see

SEARCH_DEPTH = 16
SEARCH_SECONDS = 2.0
MIN_GAP = 20        # win % the best move has over the second best (mover's view): "one clearly winning move"
MIN_WIN = 60        # win % after the best move: the tactic leaves the mover better off, not just surviving
MOVER_PLIES = 3     # how many of the mover's moves in the best line are checked for a motif
KING_VALUE = 100    # a king outranks everything when deciding forks, pins and skewers
WIN_MATERIAL = 2    # "hanging": the first move's capture nets at least this much (static exchange)

# The order a motif is reported in when a line has several (the first one is the headline)
ORDER = ["mate", "fork", "discovered", "skewer", "pin", "hanging"]


def _value(piece: chess.Piece) -> int:
    return KING_VALUE if piece.piece_type == chess.KING else VALUES[piece.piece_type]


def _win(cp_white: int, mover: chess.Color) -> float:
    w = win_percent(max(-1500, min(1500, cp_white)))
    return w if mover == chess.WHITE else 100 - w


def _fork(b: chess.Board, sq: chess.Square, mover: chess.Color) -> bool:
    """The piece on `sq` attacks two or more enemy pieces worth a minor piece or more (or the king) that it
    profits from hitting: the king, a more valuable piece, or an undefended one. Pawns don't count: counting
    them called quiet moves forks (2026-10-07 run: 13 of 40 untagged puzzles)."""
    piece = b.piece_at(sq)
    hits = 0
    for t in b.attacks(sq):
        target = b.piece_at(t)
        if not target or target.color == mover or (target.piece_type != chess.KING and _value(target) < 3):
            continue
        if target.piece_type == chess.KING or _value(target) > _value(piece) or not b.is_attacked_by(not mover, t):
            hits += 1
    return hits >= 2


def _hits_pinned(b: chess.Board, sq: chess.Square, mover: chess.Color) -> bool:
    """The piece on `sq` attacks an enemy piece that's pinned to its king (exploiting a pin, not making one)."""
    return any((p := b.piece_at(t)) and p.color != mover and p.piece_type != chess.KING and b.is_pinned(not mover, t)
               for t in b.attacks(sq))


def _ray_motifs(b: chess.Board, sq: chess.Square, mover: chess.Color) -> set[str]:
    """Pins and skewers by a line piece on `sq`: along each ray, the first enemy piece and the one behind it.
    Front less valuable than back (or back is the king) = pin; front more valuable (or the king) = skewer."""
    piece = b.piece_at(sq)
    dirs = {chess.BISHOP: [(1, 1), (1, -1), (-1, 1), (-1, -1)], chess.ROOK: [(1, 0), (-1, 0), (0, 1), (0, -1)]}
    rays = dirs.get(piece.piece_type, []) or (dirs[chess.BISHOP] + dirs[chess.ROOK] if piece.piece_type == chess.QUEEN else [])
    out = set()
    for df, dr in rays:
        f, r = chess.square_file(sq), chess.square_rank(sq)
        seen = []
        while len(seen) < 2:
            f, r = f + df, r + dr
            if not (0 <= f < 8 and 0 <= r < 8):
                break
            p = b.piece_at(chess.square(f, r))
            if p is None:
                continue
            if p.color == mover:
                break
            seen.append(p)
        if len(seen) < 2:
            continue
        front, back = seen
        if back.piece_type == chess.KING or _value(back) > _value(front):
            out.add("pin")
        elif front.piece_type == chess.KING or _value(front) > _value(back):
            out.add("skewer")
    return out


def _discovered(before: chess.Board, after: chess.Board, move: chess.Move, mover: chess.Color) -> bool:
    """Moving the piece opened a line: another of the mover's pieces now attacks an enemy king, or an enemy
    piece worth 3+, that it didn't attack before."""
    for sq in after.pieces(chess.BISHOP, mover) | after.pieces(chess.ROOK, mover) | after.pieces(chess.QUEEN, mover):
        # another piece's attacks can only grow because the moving piece left its square: that's the discovery
        if sq == move.to_square:
            continue
        new = after.attacks(sq) & ~before.attacks(sq)
        for t in new:
            target = after.piece_at(t)
            if target and target.color != mover and (target.piece_type == chess.KING or _value(target) >= 3):
                return True
    return False


def motifs(board: chess.Board, pv: list[chess.Move], mate: bool) -> list[str]:
    """Motifs along the mover's first MOVER_PLIES moves of `pv`. Mate first (it's the outcome); the rest by the
    move they happen on, earliest first (the headline is what the first move does), then by ORDER."""
    mover = board.turn
    first_at: dict[str, int] = {}
    b = board.copy()
    first = pv[0] if pv else None
    if first and b.is_capture(first) and not b.is_en_passant(first):
        target = b.piece_at(first.to_square)
        # wins material: an undefended piece, or an exchange on that square that nets WIN_MATERIAL or more
        if target and (not b.is_attacked_by(not mover, first.to_square) or _see(b, first.to_square) >= WIN_MATERIAL):
            first_at["hanging"] = 0
    for i, mv in enumerate(pv[:2 * MOVER_PLIES]):
        if mv not in b.legal_moves:
            break
        before = b.copy(stack=False)
        b.push(mv)
        if i % 2:  # the opponent's reply: only walk through it
            continue
        here = set(_ray_motifs(b, mv.to_square, mover))
        if _fork(b, mv.to_square, mover):
            here.add("fork")
        if _hits_pinned(b, mv.to_square, mover):
            here.add("pin")
        if _discovered(before, b, mv, mover):
            here.add("discovered")
        for m in here:
            first_at.setdefault(m, i)
    rest = sorted(first_at, key=lambda m: (first_at[m], ORDER.index(m)))
    return (["mate"] if mate else []) + rest


def find(engine: Engine, board: chess.Board, depth: int = SEARCH_DEPTH, seconds: float = SEARCH_SECONDS) -> dict | None:
    """The tactic for the side to move, or None. Keys: move/uci/line (the best line), gap (win % over the second
    best), win (win % after it), eval_white, motifs (may be empty: the engine sees one winning move, but none of
    the geometry checks names it)."""
    if board.is_game_over():
        return None
    lines = engine.lines(board, multipv=2, seconds=seconds, depth=depth)
    # a plain trade back after a capture is the "only good move" but not a tactic (the biggest false alarm on the
    # user's games, 2026-10-07). Taking back MORE than they took (they grabbed a pawn with a bishop) still counts:
    # skipping every recapture lost 20% of Lichess's hanging-piece puzzles. Needs the move history.
    if lines and board.move_stack:
        last = board.peek()
        prev = board.copy()
        prev.pop()
        best_mv = chess.Move.from_uci(lines[0]["uci"])
        if prev.is_capture(last) and not prev.is_en_passant(last) and best_mv.to_square == last.to_square:
            took = VALUES[prev.piece_at(last.to_square).piece_type]
            if _see(board, last.to_square) <= took:
                return None
    if not lines:
        return None
    mover = board.turn
    best = lines[0]
    w1 = _win(best["cp_white"], mover)
    w2 = _win(lines[1]["cp_white"], mover) if len(lines) > 1 else 0.0  # only one legal move: not a tactic
    if len(lines) < 2 or w1 - w2 < MIN_GAP or w1 < MIN_WIN:
        return None
    mate = abs(best["cp_white"]) >= MATE_CP - 1000 and (best["cp_white"] > 0) == (mover == chess.WHITE)
    pv = [chess.Move.from_uci(u) for u in best["pv"]]
    return {"move": best["move"], "uci": best["uci"], "line": best["line"], "eval_white": best["eval_white"],
            "gap": round(w1 - w2, 1), "win": round(w1, 1), "motifs": motifs(board, pv, mate)}
