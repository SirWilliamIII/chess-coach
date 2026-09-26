"""Beyond the engine's top line: sacrifices, traps and high-risk/high-reward tries.

For each candidate move we look at two outcomes: the eval against the best defence (is it
sound?) and the eval if the opponent grabs the bait (does the natural reply lose?). A move that
is roughly as good as the best one against perfect play but punishes the greedy reply is exactly
the kind of practical trick that wins games at club level.
"""

import chess

from .engine import MATE_CP, Engine
from .features import VALUES
from .gm_moments import _see

CANDIDATES = 6
SEARCH_SECONDS = 2.0
REPLY_SECONDS = 0.4
TRAP_GAIN = 200        # centipawns the greedy reply loses compared with the best defence
SPECULATIVE_MARGIN = 150  # how much worse than the best move a speculative try may be


def _hanging(board: chess.Board) -> dict[chess.Square, int]:
    """For each piece of the side NOT to move: what the side to move wins by capturing it
    (exchange evaluation, defenders included). Only entries worth something are kept."""
    out = {}
    for sq, piece in board.piece_map().items():
        if piece.color != board.turn and piece.piece_type != chess.KING:
            gain = _see(board, sq)
            if gain > 0:
                out[sq] = gain
    return out


def _offered(board: chess.Board, move: chess.Move) -> tuple[int, chess.Square | None]:
    """Material the move newly leaves en prise (anywhere, e.g. a queen left behind), net of what
    it captured. Pieces that were already hanging before the move don't count."""
    captured = board.piece_at(move.to_square)
    took = VALUES[captured.piece_type] if captured else (1 if board.is_en_passant(move) else 0)
    before = {}
    if not board.is_check():
        passed = board.copy(stack=False)
        passed.push(chess.Move.null())
        before = _hanging(chess.Board(passed.fen()))
    after = board.copy(stack=False)
    after.push(move)
    best_sq, best = None, 0
    for sq, gain in _hanging(after).items():
        new = gain if sq == move.to_square else gain - before.get(sq, 0)
        if new > best:
            best_sq, best = sq, new
    return max(0, best - took), best_sq


def _greedy_reply(board_after: chess.Board, square: chess.Square) -> chess.Move | None:
    """The 'natural' reply: grab the offered material with the cheapest piece that can."""
    caps = [m for m in board_after.legal_moves if m.to_square == square]
    if not caps:
        return None
    return min(caps, key=lambda m: VALUES[board_after.piece_at(m.from_square).piece_type] or 100)


def find(engine: Engine, board: chess.Board) -> dict:
    mover = board.turn
    lines = engine.lines(board, multipv=CANDIDATES, seconds=SEARCH_SECONDS)
    if not lines:
        return {"candidates": []}
    sign = 1 if mover == chess.WHITE else -1
    best_cp = sign * lines[0]["cp_white"]
    out = []
    for rank, line in enumerate(lines):
        move = board.parse_san(line["move"])
        cp = sign * line["cp_white"]
        after = board.copy(stack=False)
        after.push(move)
        offered, bait_sq = _offered(board, move)
        tags = []
        cand = {
            "move": line["move"],
            "engine_rank": rank + 1,
            "eval_vs_best_defence": line["eval_white"],
            "line": line["line"],
            "gives_check": after.is_check(),
            "material_offered": offered,
        }
        if offered >= 1 and bait_sq is not None:
            greedy = _greedy_reply(after, bait_sq)
            if greedy:
                grabbed = after.copy(stack=False)
                greedy_san = after.san(greedy)
                grabbed.push(greedy)
                if grabbed.is_checkmate():  # the capture itself mates us: bait that backfires
                    greedy_cp, greedy_eval, punish = -MATE_CP, "mate against us", ""
                else:
                    info = engine.lines(grabbed, multipv=1, seconds=REPLY_SECONDS)
                    greedy_cp = sign * info[0]["cp_white"] if info else 0
                    greedy_eval = info[0]["eval_white"] if info else "?"
                    punish = info[0]["line"] if info else ""
                cand["if_they_take"] = {"reply": greedy_san, "eval_after": greedy_eval, "punishment": punish}
                if greedy_cp - cp >= TRAP_GAIN:
                    tags.append("trap: taking the bait loses")
        if offered >= 2:
            if cp >= best_cp - 50:
                tags.append("sound sacrifice")
            elif cp >= best_cp - SPECULATIVE_MARGIN and cp > -100:
                tags.append("speculative sacrifice (high risk, high reward)")
        if rank == 0:
            tags.append("engine's top move")
        cand["tags"] = tags
        # keep the top move plus anything with a trick in it
        if rank == 0 or any(not t.startswith("engine") for t in tags):
            out.append(cand)
    return {
        "side_to_move": "white" if mover == chess.WHITE else "black",
        "best_eval": lines[0]["eval_white"],
        "candidates": out,
        "note": "Evals are White's point of view. 'if_they_take' shows the natural greedy reply.",
    }
