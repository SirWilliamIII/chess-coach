"""The card shown after each opponent move in a bot game: best move, main line, a sharper try,
and what the opponent now threatens. Pure engine work (no LLM call), built from the same
finders the coach's tools use, so it costs nothing and can't invent a tactic — the coach's
"why" is a button the player presses, not part of this."""

import re

import chess

from . import features, tricks
from .engine import Engine

MAIN_SECONDS = 1.5
MAIN_DEPTH = 20
LINE_PLIES = 8

# tricks.find() tags, in the order we'd rather show them as "the sharper try"
_SHARP = ["sound sacrifice", "trap: taking the bait loses", "speculative sacrifice (high risk, high reward)"]


def _san_moves(board: chess.Board, text: str) -> list[str]:
    """SAN moves out of a variation string like '1. Nf3 d5 2. d4' / '12...Nf6 13. e4', stopping
    at the first token that isn't legal (so a demo built from it can never contain a bad move)."""
    b = board.copy(stack=False)
    out = []
    for tok in text.split():
        san = re.sub(r"^\d+\.+", "", tok)
        if not san:
            continue
        try:
            mv = b.parse_san(san)
        except ValueError:
            break
        out.append(b.san(mv))
        b.push(mv)
    return out


def _pv_san(board: chess.Board, pv_uci: list[str]) -> list[str]:
    b = board.copy(stack=False)
    out = []
    for u in pv_uci[:LINE_PLIES]:
        mv = chess.Move.from_uci(u)
        out.append(b.san(mv))
        b.push(mv)
    return out


def build(engine: Engine, board: chess.Board) -> dict:
    """Card data for the side to move (the player, right after the opponent's move)."""
    lines = engine.lines(board, multipv=1, seconds=MAIN_SECONDS, depth=MAIN_DEPTH)
    if not lines:
        raise ValueError("engine returned no line for this position")
    top = lines[0]
    card = {
        "fen": board.fen(),
        "to_move": features.COLOR_NAME[board.turn],
        "eval_white": top["eval_white"],
        "cp_white": top["cp_white"],
        "best": {"move": top["move"], "uci": top["uci"], "eval_white": top["eval_white"],
                 "moves": _pv_san(board, top["pv"])},
        "aggressive": None,
        "threat": None,
        "loose": {"you": features.loose_pieces(board, board.turn),
                  "them": features.loose_pieces(board, not board.turn)},
    }

    found = tricks.find(engine, board)
    top_move = found["candidates"][0]["move"] if found["candidates"] else None
    sharp = None
    for tag in _SHARP:
        sharp = next((c for c in found["candidates"]
                      if c["move"] != top_move and any(t.startswith(tag) for t in c["tags"])), None)
        if sharp:
            break
    if sharp:
        tag = next(t for t in sharp["tags"] if not t.startswith("engine"))
        note = tag
        take = sharp.get("if_they_take")
        if take:
            note += f" — if they take {take['reply']} it goes {take['eval_after']}"
        elif sharp["material_offered"]:
            note += f" — offers about {sharp['material_offered']} pawn(s)"
        card["aggressive"] = {"move": sharp["move"], "eval_white": sharp["eval_vs_best_defence"],
                              "moves": _san_moves(board, sharp["line"]), "note": note}
    elif found["candidates"] and any(not t.startswith("engine") for t in found["candidates"][0]["tags"]):
        # the top move is itself the sharp one: say so instead of inventing a second try
        card["best"]["tags"] = [t for t in found["candidates"][0]["tags"] if not t.startswith("engine")]

    threat = None if top["eval_white"].startswith("#") else engine.threat(board)  # no threat talk when we mate
    if threat and threat["serious"]:
        card["threat"] = {"move": threat["threat_move"], "gain": round(threat["gain_cp_if_ignored"] / 100, 1)}
    return card


REPLY_SECONDS = 0.8
ANSWER_SECONDS = 0.5
REPLY_DEPTH = 16
MAX_REPLIES = 3
REPLY_WINDOW_CP = 150   # skip replies that are much worse for them than their best one


def replies(engine: Engine, board: chess.Board, best_uci: str) -> list[dict]:
    """'If they play A, I play B' for the card's best move: the opponent's top replies after it,
    each with the engine's answer. A second, slower request so the card itself appears first."""
    move = chess.Move.from_uci(best_uci)
    if move not in board.legal_moves:
        raise ValueError("that move isn't legal in this position")
    played = board.san(move)
    after = board.copy(stack=False)
    after.push(move)
    if after.is_game_over():
        return []
    opp = after.turn
    sign = 1 if opp == chess.WHITE else -1
    lines = engine.lines(after, multipv=MAX_REPLIES, seconds=REPLY_SECONDS, depth=REPLY_DEPTH)
    if not lines:
        return []
    top_cp = sign * lines[0]["cp_white"]
    out = []
    for line in lines:
        if top_cp - sign * line["cp_white"] > REPLY_WINDOW_CP:
            continue
        reply = after.parse_san(line["move"])
        b2 = after.copy(stack=False)
        b2.push(reply)
        item = {"reply": line["move"], "reply_eval_white": line["eval_white"],
                "answer": None, "answer_eval_white": None, "moves": [played, line["move"]]}
        if not b2.is_game_over():
            ans = engine.lines(b2, multipv=1, seconds=ANSWER_SECONDS, depth=REPLY_DEPTH)
            if ans:
                item["answer"] = ans[0]["move"]
                item["answer_eval_white"] = ans[0]["eval_white"]
                item["moves"] += _pv_san(b2, ans[0]["pv"][:4])
        out.append(item)
    return out
