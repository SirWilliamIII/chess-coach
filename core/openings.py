"""Main lines from a position, built from real-game statistics (the Lichess opening explorer).

A breadth-first walk of the explorer tree that keeps only moves players actually choose often,
so "all the lines" stays within reason. `explore(fen, db, ratings, speeds)` is injected so this
module doesn't care where the statistics come from (and caching happens there).
"""

import chess

MIN_SHARE = 15.0   # a move must be played in at least this % of games to be followed
WIDTH = 3          # at most this many replies per position
MIN_PROB = 0.02    # drop lines that fewer than 2% of games follow
BUDGET = 20        # explorer lookups per call (each ~0.5 s the first time, then cached)


def numbered(board: chess.Board, sans: list[str]) -> str:
    """'e4 e5 Nf3' from `board` -> '1. e4 e5 2. Nf3' (numbering taken from the position)."""
    b = board.copy(stack=False)
    return board.variation_san([b.push_san(san) for san in sans])


def main_lines(explore, board: chess.Board, depth: int = 6, db: str = "masters",
               ratings: list[int] | None = None, speeds: list[str] | None = None,
               max_lines: int = 10) -> dict:
    depth = max(2, min(10, depth))
    partial: list[str] = []

    def look(b: chess.Board, source: str, required: bool = False) -> dict | None:
        try:
            return explore(b.fen(), source, ratings if source == "lichess" else None,
                           speeds if source == "lichess" else None)
        except RuntimeError as e:
            if required:
                raise ValueError(str(e))
            partial.append(str(e))  # e.g. rate limited mid-walk: keep what we have
            return None

    source = db
    root = look(board, source, required=True)
    if source == "masters" and root["total"] < 50:  # little master theory here: use what people play
        source = "lichess"
        root = look(board, source, required=True)

    used = 1
    finished = []  # (steps, explorer data at the end or None, probability, opening name so far)
    frontier = [([], board, root, 1.0, root.get("opening"))]
    while frontier:
        steps, b, data, prob, named = frontier.pop(0)
        picks = [m for m in data["moves"] if m["share"] >= MIN_SHARE][:WIDTH] or data["moves"][:1]
        if len(steps) >= depth or not picks:
            finished.append((steps, data, prob, named))
            continue
        for m in picks:
            step = {k: m[k] for k in ("san", "uci", "share", "white", "draws", "black", "games")}
            p = prob * m["share"] / 100
            if used >= BUDGET or p < MIN_PROB or len(steps) + 1 >= depth:
                finished.append((steps + [step], None, p, named))
                continue
            nb = b.copy(stack=False)
            nb.push_uci(m["uci"])
            used += 1
            child = None if partial else look(nb, source)
            if child is None:
                finished.append((steps + [step], None, p, named))
            else:
                frontier.append((steps + [step], nb, child, p, child.get("opening") or named))

    lines = []
    for steps, data, prob, named in sorted(finished, key=lambda x: -x[2])[:max_lines]:
        if not steps:
            continue
        end = data or {}
        if not end and not partial and used < BUDGET + 8:  # name and results where the line ends
            b = board.copy(stack=False)
            for s in steps:
                b.push_uci(s["uci"])
            end = look(b, source) or {}
            used += 1
        name = end.get("opening") or named or {}
        sans = [s["san"] for s in steps]
        lines.append({
            "line": numbered(board, sans),
            "moves": sans,
            "steps": steps,
            "opening": name.get("name"), "eco": name.get("eco"),
            "share_of_games_pct": round(prob * 100, 1),
            "games": end.get("total"),
            "results_pct": end.get("results"),
        })
    start = root.get("opening") or {}
    return {
        "start_opening": start.get("name"), "start_eco": start.get("eco"),
        "source": source, "games_at_start": root["total"],
        "main_lines": lines,
        "partial": bool(partial),
    }
