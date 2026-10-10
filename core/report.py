"""Game report for a loaded game: the eval graph, accuracy and move grades per side, and the tactics this game
gave you to practise. Everything comes from the saved review (and data/my_puzzles.json): no engine, no Claude.

Accuracy is Lichess's formula (lila's AccuracyPercent, written from memory 2026-10-09, not checked line by line
against the source): per move 103.17 * exp(-0.0435 * win % lost) - 3.17, then per side the average of a
volatility-weighted mean and the harmonic mean. chess.com's accuracy is a different, unpublished formula, so the
numbers won't match theirs.
"""

import math
import statistics

import chess

from . import eco, my_puzzles
from .engine import MATE_CP, win_percent

# the scoreboard's grades (sbGrade() in app.js), so the report counts what the after-move pill says
GRADES = ["book", "best", "excellent", "good", "inaccuracy", "mistake", "blunder"]
EXCELLENT, GOOD, INACCURACY, MISTAKE = 2, 5, 15, 30


def cp_of(ev: str) -> int:
    """"+0.31" / "-1.20" / "#3" / "#-2" → centipawns from White's side (mates as ±MATE_CP)"""
    ev = ev.strip()
    if ev.startswith("#"):
        return -MATE_CP if ev[1:].startswith("-") else MATE_CP
    return round(float(ev) * 100)


def grade(m: dict, book: bool) -> str:
    if book:
        return "book"
    d = m["win_pct_lost"]
    if m["played_best"]:
        return "best"
    return ("excellent" if d < EXCELLENT else "good" if d < GOOD else "inaccuracy" if d < INACCURACY
            else "mistake" if d < MISTAKE else "blunder")


def _move_accuracy(lost: float) -> float:
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * lost) - 3.1669 + 1))  # +1: lila's analysis-noise bonus


def _accuracy(wins: list[float], moves: list[dict], color: str) -> float | None:
    """wins: White's win % at ply 0..N. Weighted by how volatile the game was around each move."""
    n = len(moves)
    if not n:
        return None
    size = max(2, min(8, len(wins) // 10))  # one window per move: (size - 2) copies of the first + the sliding ones
    windows = [wins[:size]] * (size - 2) + [wins[i:i + size] for i in range(len(wins) - size + 1)]
    weights = [max(0.5, min(12.0, statistics.pstdev(w))) for w in windows]
    acc, wts = [], []
    for i, m in enumerate(moves):
        if m["color"] == color:
            acc.append(_move_accuracy(m["win_pct_lost"]))
            wts.append(weights[i] if i < len(weights) else 0.5)
    if not acc:
        return None
    weighted = sum(a * w for a, w in zip(acc, wts)) / sum(wts)
    harmonic = len(acc) / sum(1 / max(a, 0.01) for a in acc)
    return round((weighted + harmonic) / 2, 1)


def build(review: dict) -> dict:
    moves = review["moves"]
    wins = [round(win_percent(max(-1500, min(1500, cp_of(moves[0]["eval_before"])))), 1)] if moves else []
    wins += [round(win_percent(max(-1500, min(1500, cp_of(m["eval_after"])))), 1) for m in moves]
    # book: the opening's named positions from the start, as long as every move so far stayed in them
    b = chess.Board(review["start_fen"])
    in_book = b.fen() == chess.STARTING_FEN
    sides = {c: {"counts": dict.fromkeys(GRADES, 0), "moves": 0} for c in ("white", "black")}
    marks = []
    for m in moves:
        b.push_uci(m["uci"])
        in_book = in_book and eco.lookup(b) is not None
        g = grade(m, in_book)
        s = sides[m["color"]]
        s["counts"][g] += 1
        s["moves"] += 1
        if g in ("inaccuracy", "mistake", "blunder"):
            marks.append({"ply": m["ply"], "color": m["color"], "grade": g, "san": m["san"], "label": m["label"]})
    for c, s in sides.items():
        s["accuracy"] = _accuracy(wins, moves, c)
    return {"game_id": review["game_id"], "wins": wins, "sides": sides, "marks": marks, "practice": _practice(review["game_id"])}


def _practice(game_id: str) -> dict:
    """This game's tactics from the "Your mistakes" miner, grouped like its picker ("Forks you missed")."""
    g = my_puzzles._load()["games"].get(game_id)
    if not g:
        return {"mined": False, "groups": []}
    groups: dict[str, dict] = {}
    for p in g["puzzles"]:
        key = f"{p['kind']}|{p['motif']}"
        row = groups.setdefault(key, {"key": key, "title": f"{my_puzzles.PLURAL.get(p['motif'], 'Other tactics')} you {p['kind']}",
                                      "n": 0, "plies": []})
        row["n"] += 1
        row["plies"].append(p["ply"])
    return {"mined": True, "groups": sorted(groups.values(), key=lambda r: -r["n"])}
