"""The scoreboard: Stockfish's top moves next to what humans at a rating actually play here, the odds
of the next move being good or a disaster, and alerts for the moments worth flagging.

`build()` makes the engine and Maia calls; everything after that is plain arithmetic on win chances
(Lichess' curve, the mover's point of view), so it can be tested without either.
"""

from concurrent.futures import ThreadPoolExecutor

import chess

from core.engine import MATE_CP, win_percent

SF_LINES = 5        # Stockfish moves shown
HUMAN_SHOWN = 5     # Maia moves shown
HUMAN_SCORED = 8    # Maia moves Stockfish scores, for the odds; more makes the second search slower
MIN_SCORED_PCT = 1  # below this a Maia move is ignored for the odds (noise, and search time)

# Search budget: stop at DEPTH or after MAX_SECONDS, whichever comes first (see Engine.lines). Measured
# 2026-10-04, 38 positions from saved games vs depth 22: depth 15 was within 5 win % on all of them (depth 12:
# 95%), and depth 18 took 2.4x as long for no visible gain. 16 is the margin.
DEPTH = 16
MAX_SECONDS = 3.0

# Win-chance swings in percentage points, the mover's view. HUGE is the review's "blunder" line.
NOTABLE, BIG, HUGE = 5, 15, 30
GOOD = 5          # within this of the best move counts as a good move
ONLY_GAP = 20     # Stockfish's #2 this much worse than #1: "only move"
POPULAR_PCT = 5   # a Maia move at least this likely is worth an alert
TOP_N = 4         # "top 4" in the overlap checks
DANGER_PCT = 20   # Maia % on moves losing >= HUGE that makes a "danger zone"


def tier(drop: float) -> int:
    """0 calm, 1 notable, 2 big, 3 huge: drives the styling."""
    return 3 if drop >= HUGE else 2 if drop >= BIG else 1 if drop >= NOTABLE else 0


def _win(cp_white: int, mover: chess.Color) -> float:
    cp = max(-1500, min(1500, cp_white))  # past ±15 the curve is flat anyway; keeps mates finite
    w = win_percent(cp)
    return w if mover == chess.WHITE else 100 - w


def mover_eval(eval_white: str, mover: chess.Color) -> str:
    """An eval string from the mover's point of view: positive good for them, no "+" (the card says whose move)."""
    mate, sign, num = eval_white.startswith("#"), eval_white.lstrip("#")[:1], eval_white.lstrip("#+-")
    neg = (sign == "-") != (mover == chess.BLACK)
    return f"{'#' if mate else ''}{'-' if neg and num.strip('0.') else ''}{num}"


def _mate_for_mover(line: dict, mover: chess.Color) -> int | None:
    """N when the mover mates in N on this line, else None."""
    e = line["eval_white"]
    if not e.startswith("#"):
        return None
    n = int(e[1:])
    if n == 0:
        return None
    return abs(n) if (n > 0) == (mover == chess.WHITE) else None


def build(sf_engine, human_engine, maia, board: chess.Board, rating: int, opp_rating: int) -> dict:
    """The scoreboard for `board` (with its move history, which Maia reads). `maia` may be None."""
    if board.is_game_over():
        return {"over": True}
    humans = maia.moves(board, rating, opp_rating, top=max(HUMAN_SCORED, HUMAN_SHOWN)) if maia else []
    pick = [m for i, m in enumerate(humans) if i < HUMAN_SHOWN or m["pct"] >= MIN_SCORED_PCT][:HUMAN_SCORED]
    roots = [chess.Move.from_uci(m["uci"]) for m in pick]
    # The two searches run at once on the two Stockfish processes, so the wait is the slower one, not the
    # sum (depth 18 with 5 lines alone measured 3.7 s median, 7.3 s p90 on this machine, 2026-10-04).
    with ThreadPoolExecutor(1) as pool:
        job = pool.submit(human_engine.lines, board, multipv=len(roots), seconds=MAX_SECONDS, depth=DEPTH,
                          root_moves=roots) if roots else None
        sf = sf_engine.lines(board, multipv=SF_LINES, seconds=MAX_SECONDS, depth=DEPTH)
        scored = job.result() if job else []
    if not sf:
        raise RuntimeError("Stockfish returned no lines")
    return summarize(board.turn, sf, humans, scored, rating)


def summarize(mover: chess.Color, sf: list[dict], humans: list[dict], scored: list[dict], rating: int) -> dict:
    """Rows, odds and alerts from the two searches. `scored` is Stockfish limited to the human moves."""
    side = "White" if mover == chess.WHITE else "Black"
    best = _win(sf[0]["cp_white"], mover)
    pct = {m["uci"]: m["pct"] for m in humans}
    sf_rows = []
    for i, l in enumerate(sf):
        w = _win(l["cp_white"], mover)
        sf_rows.append({"move": l["move"], "uci": l["uci"], "eval_white": l["eval_white"], "win": round(w, 1),
                        "drop": round(best - w, 1), "tier": tier(best - w) if i else 0, "human_pct": pct.get(l["uci"])})
    sf_rank = {r["uci"]: i + 1 for i, r in enumerate(sf_rows)}

    # A human move in Stockfish's top 5 keeps that search's number, so one move never shows two evals.
    # The rest come from the limited search and are measured against Stockfish's best; a move outside the
    # top 5 is at least as bad as #5, which also absorbs the two searches disagreeing by a few points.
    by_uci = {l["uci"]: l for l in scored}
    floor = sf_rows[-1]["drop"] if len(sf_rows) == SF_LINES else 0.0
    human_rows = []
    for m in humans:
        if m["uci"] in sf_rank:
            r = sf_rows[sf_rank[m["uci"]] - 1]
            ev, w, drop = r["eval_white"], r["win"], r["drop"]
        elif m["uci"] in by_uci:
            l = by_uci[m["uci"]]
            ev, w = l["eval_white"], _win(l["cp_white"], mover)
            drop = max(floor, best - w)
        else:
            continue  # not scored (too unlikely): left out of the odds rather than guessed
        human_rows.append({"move": m["move"], "uci": m["uci"], "pct": m["pct"], "eval_white": ev,
                           "win": round(w, 1), "drop": round(drop, 1), "tier": tier(drop),
                           "sf_rank": sf_rank.get(m["uci"]), "wdl": m.get("wdl")})

    out = {"turn": side.lower(), "depth": sf[0].get("depth"), "white_win": round(_win(sf[0]["cp_white"], chess.WHITE), 1),
           "sf": sf_rows, "humans": human_rows[:HUMAN_SHOWN], "odds": None, "human_white_win": None}
    if human_rows:
        covered = sum(h["pct"] for h in human_rows)
        out["odds"] = {
            "good": round(sum(h["pct"] for h in human_rows if h["drop"] < GOOD), 1),
            "disaster": round(sum(h["pct"] for h in human_rows if h["drop"] >= HUGE), 1),
            "covered": round(covered, 1),  # the odds only know about these moves
        }
        # Maia's own guess at the result between these players: expected score after each move, weighted
        wdl = [h for h in human_rows if h["wdl"]]
        if wdl:
            s = sum(h["pct"] * (h["wdl"][0] + h["wdl"][1] / 2) for h in wdl) / sum(h["pct"] for h in wdl)
            out["human_white_win"] = round(s if mover == chess.WHITE else 100 - s, 1)
    out["alerts"] = alerts(side, sf_rows, human_rows, rating, out["odds"])
    return out


def alerts(side: str, sf: list[dict], humans: list[dict], rating: int, odds: dict | None = None) -> list[dict]:
    """What's worth flagging about the next move, most important first. Each: kind, tier, text, uci."""
    out = []
    who = f"~{rating} players"
    top = humans[:TOP_N]
    sf_top = {r["uci"] for r in sf[:TOP_N]}
    fmt = lambda p: "<1" if p < 1 else f"{round(p)}"

    me = chess.WHITE if side == "White" else chess.BLACK
    mate = _mate_for_mover({"eval_white": sf[0]["eval_white"]}, me)
    if mate:
        found = next((h["pct"] for h in humans if h["uci"] == sf[0]["uci"]), None)
        tail = f"; {fmt(found)}% of {who} play it" if found is not None else ""
        out.append({"kind": "mate", "tier": 3, "uci": sf[0]["uci"],
                    "text": f"{side} has mate in {mate}, starting {sf[0]['move']}{tail}"})

    # the worst likely move: a banana peel the side to move may well step on
    peel = max((h for h in top if h["pct"] >= POPULAR_PCT and h["drop"] >= HUGE), key=lambda h: h["pct"], default=None)
    if peel:
        # "loses" only when it leaves the mover losing; from +6 to +0.9 it throws a win away instead
        what = ("loses on the spot" if peel["win"] < 30 else
                f"throws away {side}'s win" if peel["win"] < 60 else f"costs {round(peel['drop'])}% win chance")
        risk = odds["disaster"] if odds else 0
        tail = f"; in all, {fmt(risk)}% of their likely moves here lose big" if risk >= DANGER_PCT and risk > peel["pct"] + 1 else ""
        out.append({"kind": "disaster", "tier": 3, "uci": peel["uci"],
                    "text": f"{fmt(peel['pct'])}% of {who} play {peel['move']} here, and it {what} ({mover_eval(peel['eval_white'], me)}){tail}"})
    elif odds and odds["disaster"] >= DANGER_PCT:
        # no single likely blunder, but many small ones add up
        out.append({"kind": "danger", "tier": 3, "uci": sf[0]["uci"],
                    "text": f"Danger zone: {fmt(odds['disaster'])}% of {who} blunder here. The move to find is {sf[0]['move']}"})

    if humans and humans[0] is not peel:
        h = humans[0]
        flips = h["win"] < 45 <= h["win"] + h["drop"] and h["win"] + h["drop"] >= 55
        if h["drop"] >= BIG or flips:
            what = f"throws away {side}'s edge" if flips else f"costs {round(h['drop'])}% win chance"
            out.append({"kind": "popular_wrong", "tier": max(2, tier(h["drop"])), "uci": h["uci"],
                        "text": f"The most popular move, {h['move']} ({fmt(h['pct'])}%), {what}"})

    if len(top) >= TOP_N and not ({h["uci"] for h in top} & sf_top):
        cost = min(h["drop"] for h in top)
        if cost >= NOTABLE:
            out.append({"kind": "no_overlap", "tier": tier(cost), "uci": sf[0]["uci"],
                        "text": f"Humans and engine disagree: none of the {TOP_N} most popular moves is in "
                                f"Stockfish's top {TOP_N}. Best is {sf[0]['move']}"})
    elif sf[0]["uci"] not in {h["uci"] for h in top} and top:
        cost = min(h["drop"] for h in top)
        if cost >= NOTABLE:
            p = sf[0]["human_pct"]
            seen = f"only {fmt(p)}% of {who} play it" if p is not None else f"{who} rarely play it"
            out.append({"kind": "hidden_best", "tier": tier(cost), "uci": sf[0]["uci"],
                        "text": f"Hard to find: {sf[0]['move']} is best, but {seen}"})

    if len(sf) > 1 and sf[1]["drop"] >= ONLY_GAP and not mate:
        out.append({"kind": "only_move", "tier": 3 if sf[1]["drop"] >= HUGE else 2, "uci": sf[0]["uci"],
                    "text": f"Only move: {sf[0]['move']}. Anything else costs at least {round(sf[1]['drop'])}%"})

    rank = {"mate": 0, "disaster": 1, "danger": 1, "only_move": 2, "popular_wrong": 3, "no_overlap": 4, "hidden_best": 5}
    out.sort(key=lambda a: (-a["tier"], rank[a["kind"]]))
    return out
