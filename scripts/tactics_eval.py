"""Validate core/tactics.py against Lichess's puzzle database and the user's own games.

Puzzles (data/puzzles/sample.csv, the first 60k lines of https://database.lichess.org/lichess_db_puzzle.csv.zst,
CC0): every one is a real position with a known solution and theme tags from Lichess's own tagger, so per theme
we measure how often the detector fires (recall), finds the solution's first move, and names the theme.
Games (data/reviews/*.json): random positions, to see how often it fires on ordinary play, with examples printed
for a by-hand check (false alarms).

    .venv/bin/python -m scripts.tactics_eval [--per 40] [--games 200] [--min 600] [--max 2000]
"""

import argparse
import csv
import glob
import json
import os
import random
import sys
import time
from collections import Counter, defaultdict

import chess

from core import tactics
from core.engine import Engine

# our motif -> the Lichess theme tags that mean it
TAGS = {"fork": {"fork"}, "pin": {"pin"}, "skewer": {"skewer"}, "hanging": {"hangingPiece"},
        "discovered": {"discoveredAttack", "discoveredCheck", "doubleCheck"},
        "mate": {"mate", "mateIn1", "mateIn2", "mateIn3", "mateIn4", "mateIn5", "backRankMate", "smotheredMate"}}
BUCKETS = list(TAGS) + ["other"]


def bucket_of(themes: set[str]) -> str:
    for ours, theirs in TAGS.items():
        if themes & theirs:
            return ours
    return "other"


def puzzles(per: int, lo: int, hi: int, rng: random.Random) -> list[dict]:
    rows = defaultdict(list)
    with open("data/puzzles/sample.csv") as f:
        for r in csv.DictReader(f):
            if lo <= int(r["Rating"]) <= hi:
                themes = set(r["Themes"].split())
                rows[bucket_of(themes)].append({**r, "themes": themes})
    return [p for b in BUCKETS for p in rng.sample(rows[b], min(per, len(rows[b])))]


def game_positions(n: int, rng: random.Random) -> list[dict]:
    out = []
    for f in sorted(glob.glob("data/reviews/*.json")):
        r = json.load(open(f))
        fens = [r["start_fen"]] + [m["fen_after"] for m in r["moves"]]
        ucis = [m["uci"] for m in r["moves"]]
        for i, m in enumerate(r["moves"]):
            if i >= 8:  # past the opening book moves
                out.append({"game": r["game_id"], "fen": fens[i], "start": r["start_fen"], "history": ucis[:i],
                            "played": m["san"], "label": m["label"]})
    return rng.sample(out, min(n, len(out)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per", type=int, default=40)
    ap.add_argument("--games", type=int, default=200)
    ap.add_argument("--min", type=int, default=600)
    ap.add_argument("--max", type=int, default=2000)
    a = ap.parse_args()
    rng = random.Random(7)
    engine = Engine(threads=6, hash_mb=256)
    t0 = time.monotonic()

    stats = defaultdict(Counter)
    said = defaultdict(Counter)
    for p in puzzles(a.per, a.min, a.max, rng):
        b = bucket_of(p["themes"])
        board = chess.Board(p["FEN"])
        moves = p["Moves"].split()
        board.push_uci(moves[0])  # the puzzle starts after the opponent's move
        r = tactics.find(engine, board)
        stats[b]["n"] += 1
        if not r:
            said[b]["(no tactic)"] += 1
            continue
        stats[b]["fired"] += 1
        stats[b]["move"] += r["uci"] == moves[1]
        named = set(r["motifs"])
        stats[b]["named"] += b != "other" and b in named
        stats[b]["any_tag"] += any(p["themes"] & TAGS[m] for m in named)
        stats[b]["head_ok"] += bool(r["motifs"]) and bool(p["themes"] & TAGS[r["motifs"][0]])
        stats[b]["claimed"] += bool(r["motifs"])
        said[b][r["motifs"][0] if r["motifs"] else "(unnamed)"] += 1

    print(f"\nPuzzles rated {a.min}-{a.max} ({time.monotonic() - t0:.0f} s)")
    print(f"{'theme':<11}{'n':>4}{'fired':>8}{'move ok':>9}{'named':>8}{'headline':>10}{'claimed':>9}   headline we gave")
    for b in BUCKETS:
        s = stats[b]
        n, fired = s["n"], s["fired"] or 1
        pct = lambda x, d: f"{100 * x / d:.0f}%" if d else "-"
        named = pct(s["named"], fired) if b != "other" else "-"
        print(f"{b:<11}{n:>4}{pct(s['fired'], n):>8}{pct(s['move'], fired):>9}{named:>8}{pct(s['head_ok'], fired):>10}{pct(s['claimed'], fired):>9}   "
              + ", ".join(f"{k} {v}" for k, v in said[b].most_common(5)))

    t1 = time.monotonic()
    pos = game_positions(a.games, rng)
    hits = []
    for p in pos:
        board = chess.Board(p["start"])
        for u in p["history"]:  # with its moves, so the recapture filter can see the last one
            board.push_uci(u)
        r = tactics.find(engine, board)
        if r:
            hits.append((p, r))
    found = sum(1 for p, r in hits if p["played"] == r["move"])
    print(f"\nYour games: {len(hits)} of {len(pos)} positions flagged ({100 * len(hits) / max(1, len(pos)):.0f}%), "
          f"found over the board {found} of {len(hits)} ({time.monotonic() - t1:.0f} s)")
    for p, r in hits[:20]:
        print(f"  {p['label']:<6} {r['move']:<7} {','.join(r['motifs']) or '(unnamed)':<22} gap {r['gap']:>4}  "
              f"played {p['played']:<7} {p['fen']}")
    sys.stdout.flush()  # os._exit skips it, and redirected output is buffered
    os._exit(0)  # the engine's thread keeps the process alive otherwise


if __name__ == "__main__":
    main()
