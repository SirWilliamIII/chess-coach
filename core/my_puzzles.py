"""Puzzles from the user's own games (Chessiro's "Replay Mistakes" idea): positions in data/reviews/ where a move of
yours lost ≥ MIN_LOST win % and the tactics finder (core/tactics.py) sees one clearly winning move:

- missed: on your turn there was a tactic and you played something else. The puzzle starts at the opponent's move
  before it (the trigger), and you find the tactic.
- allowed: your move handed the opponent one. The puzzle starts at your move, and you find *their* tactic (the
  board turns to their side): the "watch out" habit.

Mined offline, incrementally per game (`python -m core.my_puzzles`), into data/my_puzzles.json; served by the same
puzzle mode as the Lichess ones (core/puzzles.py), with no rating. The solution runs on while each of the solver's
moves is again the one clearly winning move (find() at the same depth), up to MAX_SOLVER_MOVES; a mate runs to the
end of the engine's line.
"""

import json
import os
import random
import re
import sys
import time
from pathlib import Path

import chess

from . import eco, tactics
from .engine import Engine
from .puzzles import MOTIF_LABEL

ROOT = Path(__file__).resolve().parent.parent
REVIEWS = ROOT / "data" / "reviews"
OUT = ROOT / "data" / "my_puzzles.json"

VERSION = 1             # bump to re-mine every game after a change here
MIN_LOST = 10           # win % your move lost: smaller slips are rarely a missed tactic
MAX_SOLVER_MOVES = 3
MATE_PLIES = 9          # a mate in up to 5 is played out to the end
# tactics.py motif → the Lichess theme name the puzzle mode labels with (MOTIF_LABEL)
THEME = {"mate": "mate", "fork": "fork", "pin": "pin", "skewer": "skewer", "discovered": "discoveredAttack",
         "hanging": "hangingPiece"}
KIND_LABEL = {"missed": "Tactics you missed", "allowed": "Tactics you allowed"}
PLURAL = {"mate": "Mates", "fork": "Forks", "pin": "Pins", "skewer": "Skewers", "discoveredAttack": "Discovered attacks",
          "hangingPiece": "Loose pieces", "other": "Other tactics"}


SITES = ("chesscom", "lichess")


def _load() -> dict:
    try:
        data = {"accounts": {}, "gone": [], **json.loads(OUT.read_text())}
    except (FileNotFoundError, json.JSONDecodeError):
        data = {"me": [], "accounts": {}, "gone": [], "games": {}}
    # accounts were one name per site before 2026-10-08 (the user has two chess.com accounts)
    data["accounts"] = {k: [v] if isinstance(v, str) else v for k, v in data["accounts"].items()}
    return data


def _save(data: dict) -> None:
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    os.replace(tmp, OUT)


def accounts() -> dict:
    """{"chesscom": [names], "lichess": [names]}: the accounts "Update from my games" fetches"""
    return _load()["accounts"]


def set_accounts(new: dict) -> dict:
    """Add account names ({site: [names]}) to the remembered ones; they also count as "me" when mining. A name
    the site said doesn't exist (renamed, `drop_account`) isn't added back, e.g. from a browser's stale field."""
    data = _load()
    gone = {(s, n.lower()) for s, n in data["gone"]}
    for site in SITES:
        have = data["accounts"].setdefault(site, [])
        for name in new.get(site) or []:
            name = name.strip()
            if name and (site, name.lower()) not in gone and name.lower() not in {h.lower() for h in have}:
                have.append(name)
    data["accounts"] = {s: v for s, v in data["accounts"].items() if v}
    data["me"] = sorted(set(data["me"]) | {n.lower() for v in data["accounts"].values() for n in v})
    _save(data)
    return data["accounts"]


def drop_account(site: str, name: str) -> None:
    """The site has no such user (a renamed account): stop fetching it. Its old games stay "me"."""
    data = _load()
    data["accounts"][site] = [n for n in data["accounts"].get(site, []) if n.lower() != name.lower()]
    data["gone"].append([site, name.lower()])
    _save(data)


def available() -> bool:
    return OUT.exists()


def _all() -> list[dict]:
    data = _load()
    return [p for g in data["games"].values() for p in g["puzzles"]]


def _url(game_id: str, ply: int) -> str | None:
    if game_id.startswith("cc"):
        return f"https://www.chess.com/game/live/{game_id[2:]}?move={ply}"
    if len(game_id) == 8:
        return f"https://lichess.org/{game_id}#{ply}"
    return None


# ---------------------------------------------------------------- mining

def _board_at(review: dict, ply: int) -> chess.Board:
    """The game after `ply` moves, with the move history (the finder skips plain recaptures, which needs it)."""
    b = chess.Board(review["start_fen"])
    for m in review["moves"][:ply]:
        b.push_uci(m["uci"])
    return b


def _tactic(engine: Engine, board: chess.Board) -> tuple[dict, list[str]] | None:
    if board.is_game_over():
        return None
    lines = engine.lines(board, multipv=2, seconds=tactics.SEARCH_SECONDS, depth=tactics.SEARCH_DEPTH)
    t = tactics.from_lines(board, lines)
    return (t, lines[0]["pv"]) if t else None


def _solution(engine: Engine, board: chess.Board, first: dict, pv: list[str]) -> list[str]:
    """The solver's line: the first move, then the reply and the next move while that one is again the only
    clearly winning move. A mate is played out."""
    m = re.match(r"#(\d+)", first["eval_white"].lstrip("+-").replace("#-", "#"))
    if "mate" in first["motifs"] and m and 2 * int(m.group(1)) - 1 <= MATE_PLIES:
        return pv[:2 * int(m.group(1)) - 1]
    out = [pv[0]]
    b = board.copy()
    b.push_uci(pv[0])
    while len(out) < 2 * MAX_SOLVER_MOVES - 1 and len(pv) > len(out):
        reply = pv[len(out)]
        b.push_uci(reply)
        nxt = _tactic(engine, b)
        if not nxt:
            break
        out += [reply, nxt[0]["uci"]]
        b.push_uci(nxt[0]["uci"])
        pv = out + nxt[1][1:]
    return out


def _opening(review: dict, ply: int) -> str | None:
    b = chess.Board(review["start_fen"])
    name = None
    for m in review["moves"][:ply]:
        b.push_uci(m["uci"])
        hit = eco.lookup(b)
        if hit:
            name = hit["name"]
    return name or review.get("opening")


def _puzzle(review: dict, kind: str, trigger_ply: int, t: dict, solution: list[str], mine: dict) -> dict:
    """trigger_ply: the game's ply of the trigger move (1-based); the puzzle's FEN is the position before it"""
    gid = review["game_id"]
    trig = review["moves"][trigger_ply - 1]
    me = mine["side"]
    opp = "black" if me == "white" else "white"
    nxt = review["moves"][trigger_ply] if trigger_ply < len(review["moves"]) else None
    motif = t["motifs"][0] if t["motifs"] else "other"
    m = re.search(r"#-?(\d+)", t["eval_white"])
    return {"id": f"{gid}-{trigger_ply}-{kind}", "kind": kind, "game_id": gid, "ply": trigger_ply,
            "fen": trig["fen_before"], "moves": [trig["uci"], *solution],
            "motif": THEME.get(motif, "other"), "mate_in": int(m.group(1)) if m and motif == "mate" else None,
            "solver": me if kind == "missed" else opp, "eval": t["eval_white"],
            # what happened in the game at the puzzle's position
            "game_move": nxt["san"] if nxt else None, "found": bool(nxt and nxt["uci"] == solution[0]),
            "lost": mine["lost"], "your_move": mine["san"],
            "opponent": review[opp], "date": review.get("date"), "opening": _opening(review, trigger_ply),
            "url": _url(gid, trigger_ply + 1)}


def mine_game(engine: Engine, review: dict, me: set[str]) -> list[dict]:
    side = "white" if review["white"].lower() in me else "black" if review["black"].lower() in me else None
    if not side:
        return []
    out = []
    for i, m in enumerate(review["moves"]):
        if m["color"] != side or not isinstance(m.get("win_pct_lost"), (int, float)) or m["win_pct_lost"] < MIN_LOST:
            continue
        ply = i + 1          # this move is the game's ply-th
        mine = {"side": side, "lost": round(m["win_pct_lost"]), "san": m["san"]}
        # missed: your turn (after the opponent's move, ply - 1), a tactic you didn't play
        if ply > 1:
            b = _board_at(review, ply - 1)
            hit = _tactic(engine, b)
            if hit and hit[0]["uci"] != m["uci"]:
                out.append(_puzzle(review, "missed", ply - 1, hit[0], _solution(engine, b, *hit), mine))
        # allowed: after your move, their tactic
        b = _board_at(review, ply)
        hit = _tactic(engine, b)
        if hit:
            out.append(_puzzle(review, "allowed", ply, hit[0], _solution(engine, b, *hit), mine))
    return out


def _todo(data: dict) -> list[dict]:
    names = set(data["me"])
    out = []
    for f in sorted(REVIEWS.glob("*.json")):
        r = json.loads(f.read_text())
        if r["white"].lower() not in names and r["black"].lower() not in names:
            continue
        done = data["games"].get(r["game_id"])
        if not done or done.get("version") != VERSION:
            out.append(r)
    return out


def pending() -> int:
    """Your reviewed games not mined yet (0 before the first run: it needs your names)"""
    data = _load()
    return len(_todo(data)) if data["me"] else 0


def mine_all(me: list[str], progress=lambda i, n, msg: print(msg, flush=True), threads: int = 4,
             engine: Engine | None = None) -> dict:
    data = _load()
    if me:
        data["me"] = sorted({n.lower() for n in me})
    if not data["me"]:
        raise SystemExit("Who are you? Pass --me name1,name2 (your chess.com and Lichess names) the first time.")
    names = set(data["me"])
    todo = _todo(data)
    own = engine is None
    engine = engine or Engine(threads=threads, hash_mb=256)
    t0 = time.monotonic()
    try:
        for i, r in enumerate(todo, 1):
            found = mine_game(engine, r, names)
            data["games"][r["game_id"]] = {"version": VERSION, "puzzles": found}
            _save(data)  # after every game, so a stopped run keeps what it has
            progress(i, len(todo), f"[{i}/{len(todo)}] {r['white']} vs {r['black']}: {len(found)} puzzle(s) ({time.monotonic() - t0:.0f} s)")
    finally:
        if own:
            engine.close()
    return data


# ---------------------------------------------------------------- serving

def summary() -> dict:
    """{n, groups: [{key, title, n, kind, motif}]} for the picker: by kind, then by motif"""
    ps = _all()
    groups: dict[str, dict] = {}
    for p in ps:
        for key, title in ((p["kind"], KIND_LABEL[p["kind"]]),
                           (f"{p['kind']}|{p['motif']}", f"{PLURAL.get(p['motif'], 'Other tactics')} you {p['kind']}")):
            g = groups.setdefault(key, {"key": key, "title": title, "n": 0, "kind": p["kind"], "motif": None if "|" not in key else p["motif"]})
            g["n"] += 1
    rows = sorted(groups.values(), key=lambda g: (g["kind"], g["motif"] is not None, -g["n"]))
    return {"n": len(ps), "games": len(_load()["games"]), "groups": rows, "pending": pending(), "accounts": accounts(),
            "gone": _load()["gone"]}


def pick(group: str | None, exclude: list[str]) -> dict | None:
    ps = [p for p in _all() if not group or p["kind"] == group or f"{p['kind']}|{p['motif']}" == group]
    fresh = [p for p in ps if p["id"] not in set(exclude)]
    pool = fresh or ps          # everything seen: start over
    return _public(random.choice(pool)) if pool else None


def _public(p: dict) -> dict:
    b = chess.Board(p["fen"])
    sans = []
    for u in p["moves"]:
        mv = chess.Move.from_uci(u)
        sans.append(b.san(mv))
        b.push(mv)
    return {**p, "sans": sans, "rating": None, "themes": [p["motif"]], "motif_label": MOTIF_LABEL.get(p["motif"], p["motif"]),
            "pattern": f"{p['kind']}|{p['motif']}", "variation": p["opening"] or "your game", "family": None,
            "game_url": p["url"], "mine": True}


if __name__ == "__main__":
    # python -m core.my_puzzles [--me name1,name2]   (the names are remembered in data/my_puzzles.json)
    args = sys.argv[1:]
    names = args[args.index("--me") + 1].split(",") if "--me" in args else []
    data = mine_all(names)
    ps = [p for g in data["games"].values() for p in g["puzzles"]]
    print(f"{len(ps)} puzzles from {len(data['games'])} games: "
          f"{sum(p['kind'] == 'missed' for p in ps)} missed, {sum(p['kind'] == 'allowed' for p in ps)} allowed")
    sys.stdout.flush()
    os._exit(0)  # the engine thread keeps the process alive otherwise
