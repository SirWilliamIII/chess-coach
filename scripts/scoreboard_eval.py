"""Does a scoreboard row's number match the score you get by playing that move?

For random positions from data/reviews/, build the scoreboard the way the server does, then for every move the
card shows (Top bot moves and Top player moves at one rating) play it and run the search the app runs on the next
position (the scoreboard's deep top 5). The row promised a score; the new position's #1 line is what you get.
Reports how far apart they are (win % from the mover's side), split by where the row's number came from: the deep
top-5 search or the shallow all-moves one.

    .venv/bin/python -m scripts.scoreboard_eval [--positions 30] [--rating 800]
"""

import argparse
import glob
import json
import os
import random
import sys
import time
from collections import defaultdict

import chess

from core import maia as maia_mod
from core import scoreboard
from core.engine import MATE_CP, Engine, win_percent

FOOLED_SHOWN = 5    # the row looked fine: within this many win % of the best
FOOLED_REAL = 15    # ...but playing it lost at least this many


def positions(n: int, rng: random.Random) -> list[chess.Board]:
    out = []
    for f in sorted(glob.glob("data/reviews/*.json")):
        r = json.load(open(f))
        for i in range(8, len(r["moves"])):
            out.append((r["start_fen"], [m["uci"] for m in r["moves"][:i]]))
    boards = []
    for start, ucis in rng.sample(out, min(n, len(out))):
        b = chess.Board(start)
        for u in ucis:
            b.push_uci(u)
        if not b.is_game_over():
            boards.append(b)
    return boards


def win(cp_white: int, mover: chess.Color) -> float:
    w = win_percent(max(-1500, min(1500, cp_white)))
    return w if mover == chess.WHITE else 100 - w


def shown_cp(row: dict, best_cp: int, mover: chess.Color) -> int:
    """The number the card prints (sbEvalAfter() in app.js): the best move's eval minus the row's cost"""
    if row["rank"] == 1 or row["cost"] is None or abs(best_cp) >= MATE_CP - 1000:
        return row["cp_white"]
    return best_cp - round(row["cost"] * 100) * (1 if mover == chess.WHITE else -1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--positions", type=int, default=30)
    ap.add_argument("--rating", type=int, default=800)
    a = ap.parse_args()
    rng = random.Random(11)
    sf_e, full_e = Engine(threads=3, hash_mb=128), Engine(threads=3, hash_mb=64)  # as the server's S.sb_engines
    card_e = Engine(threads=2, hash_mb=64)  # as S.card_engine (the quick Maia scores)
    maia = maia_mod.Maia() if maia_mod.available() else None
    t0 = time.monotonic()
    stats = defaultdict(lambda: {"n": 0, "err": 0.0, "fooled": 0, "depths": []})
    worst = []
    for b in positions(a.positions, rng):
        mover = b.turn
        out = scoreboard.build(sf_e, full_e, maia, b, a.rating, a.rating)
        rows = out["all"]
        full = {l["uci"]: l for l in full_e.lines(b, multipv=b.legal_moves.count(), seconds=scoreboard.FULL_SECONDS,
                                                    depth=scoreboard.FULL_DEPTH)}  # cached: the same search build() ran
        cp_of = {l["uci"]: l["cp_white"] for l in full.values()}
        for l in sf_e.lines(b, multipv=scoreboard.SF_LINES, seconds=scoreboard.MAX_SECONDS, depth=scoreboard.DEPTH):
            cp_of[l["uci"]] = l["cp_white"]
        best_cp = cp_of[rows[0]["uci"]]
        lad = next((x for x in out.get("ladder", []) if x["rating"] == a.rating), None)
        players = [m["uci"] for m in lad["moves"][:5]] if lad else []
        shown = {r["uci"]: r for r in rows[:5]} | {r["uci"]: r for r in rows if r["uci"] in players}
        # the quick numbers shown before the deep search lands: Maia's moves scored together in 0.5 s (/api/maia)
        quick = {}
        if maia:
            mm = maia.moves(b, a.rating, a.rating, top=8)
            roots = [chess.Move.from_uci(m["uci"]) for m in mm]
            quick = {l["uci"]: l["cp_white"] for l in card_e.lines(b, multipv=len(roots), seconds=0.5, root_moves=roots)}
        for uci, r in shown.items():
            r = {**r, "cp_white": cp_of.get(uci, best_cp)}
            child = b.copy()
            child.push_uci(uci)
            if child.is_checkmate():
                real = MATE_CP if mover == chess.WHITE else -MATE_CP
            elif child.is_game_over():
                real = 0
            else:
                real = sf_e.lines(child, multipv=scoreboard.SF_LINES, seconds=scoreboard.MAX_SECONDS, depth=scoreboard.DEPTH)[0]["cp_white"]
            s = shown_cp(r, best_cp, mover)
            src = "deep top 5" if r["rank"] <= scoreboard.SF_LINES else "shallow rest"
            err = abs(win(s, mover) - win(real, mover))
            lost_shown = win(best_cp, mover) - win(s, mover)
            lost_real = win(best_cp, mover) - win(real, mover)
            st = stats[src]
            st["n"] += 1
            st["err"] += err
            st["fooled"] += lost_shown < FOOLED_SHOWN and lost_real >= FOOLED_REAL
            if src == "shallow rest" and uci in full:
                st["depths"].append(full[uci].get("depth") or 0)
            worst.append((err, src, b.san(chess.Move.from_uci(uci)), s, real, b.fen()))
            if uci in quick:
                q = quick[uci]
                qerr = abs(win(q, mover) - win(real, mover))
                st = stats["quick (first ~2 s)"]
                st["n"] += 1
                st["err"] += qerr
                st["fooled"] += win(best_cp, mover) - win(q, mover) < FOOLED_SHOWN and lost_real >= FOOLED_REAL
                worst.append((qerr, "quick", b.san(chess.Move.from_uci(uci)), q, real, b.fen()))
    print(f"\n{sum(s['n'] for s in stats.values())} rows from {a.positions} positions ({time.monotonic() - t0:.0f} s)")
    for src, s in stats.items():
        d = s["depths"]
        print(f"  {src:<13} rows {s['n']:>4}  mean gap {s['err'] / max(1, s['n']):5.1f} win %   "
              f"looked fine but lost ≥{FOOLED_REAL}: {s['fooled']}"
              + (f"   depth reached: median {sorted(d)[len(d) // 2]}, min {min(d)}" if d else ""))
    print("\nBiggest gaps (win %, source, move, shown, real, position):")
    for err, src, san, s, real, fen in sorted(worst, reverse=True)[:12]:
        print(f"  {err:5.1f}  {src:<13} {san:<7} shown {s / 100:+6.2f}  real {real / 100:+6.2f}  {fen}")
    sys.stdout.flush()
    os._exit(0)  # the engine threads keep the process alive otherwise


if __name__ == "__main__":
    main()
