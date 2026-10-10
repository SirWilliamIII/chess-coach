"""Opening puzzles: Lichess's puzzle database (CC0, database.lichess.org), the part tagged with an opening.

Lichess tags a puzzle with its game's opening only when the puzzle starts before move 20 (checked on the
2026-10 dump: 1.22M of 6.16M puzzles, all from moves 1-19), so the tagged set is the opening and early
middlegame. Every puzzle has exactly two tags: the family ("Sicilian_Defense") and the variation, the ECO name
up to its first comma ("Sicilian_Defense_Najdorf_Variation").

A puzzle's first move is the side that blunders (the "trigger"); the rest is the punishment, starting with the
solver's answer. Puzzles that share a signature (who punishes, with which piece, capturing or not, on which
square, and the main motif) form a pattern: "after ...Nxe5, dxe5 forks" in the London. A pattern is typical of an
opening when it shows up there much more often than across all tagged puzzles (lift); the rest are common
everywhere (queen mates on h7) and are listed apart.

Built once by `python -m scripts.puzzles_import` into data/puzzles.sqlite; read-only here.
"""

import math
import re
import sqlite3
import threading
from pathlib import Path

import chess

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "puzzles.sqlite"

# The theme a pattern is named by, in priority order: mates first, then the tactical motif, then what it wins.
MOTIFS = ["mate", "fork", "pin", "skewer", "discoveredAttack", "doubleCheck", "trappedPiece", "hangingPiece",
          "attraction", "deflection", "interference", "clearance", "xRayAttack", "capturingDefender",
          "intermezzo", "quietMove", "exposedKing", "promotion", "advancedPawn", "kingsideAttack", "sacrifice"]
MOTIF_LABEL = {
    "mate": "mate", "fork": "fork", "pin": "pin", "skewer": "skewer", "discoveredAttack": "discovered attack",
    "doubleCheck": "double check", "trappedPiece": "trapped piece", "hangingPiece": "loose piece",
    "attraction": "decoy", "deflection": "deflection", "interference": "interference", "clearance": "clearance",
    "xRayAttack": "x-ray", "capturingDefender": "remove the defender", "intermezzo": "in-between move",
    "quietMove": "quiet move", "exposedKing": "king hunt", "promotion": "promotion", "advancedPawn": "pawn push",
    "kingsideAttack": "kingside attack", "sacrifice": "sacrifice", "other": "wins material",
}

# What a pattern needs to be listed
MIN_PATTERN = 15        # puzzles, at least ...
MIN_PATTERN_SHARE = 0.003  # ... and this share of the opening's puzzles (a big family needs more)
TYPICAL_LIFT = 2.0      # this many times more common here than across all openings = "typical of this opening"
TRIGGER_SHARE = 0.4     # one trigger move this often = "after X" (else the top few are listed)
MAX_TYPICAL = 12
MAX_COMMON = 8

# Puzzles worth serving: Lichess's popularity is (up - down) / votes x 100 (90% of tagged ones are >= 73), and a
# puzzle with few plays has an unsettled rating
MIN_POPULARITY = 60
MIN_PLAYS = 30
RATING_STEPS = (100, 200, 400, 4000)   # the band around your level, widened until something is left

# Which puzzles are worth serving (user, 2026-10-09: "hanging a queen should never be a tactic or a puzzle"; "the
# best and coolest tactics may not yield the biggest swing"). Lame: one move, or nothing to it but taking a loose
# piece (Lichess's motif hangingPiece, or no motif at all). Spicy: a theme where the move is hard to see. A pick
# prefers spicy, then plain, near your rating; lame ones only when nothing else is left, or their own pattern.
LAME_MOTIFS = ("hangingPiece", "other")
SPICY_THEMES = {"sacrifice": "sacrifice", "quietMove": "quiet move", "deflection": "deflection",
                "attraction": "decoy", "clearance": "clearance", "interference": "interference",
                "intermezzo": "in-between move", "xRayAttack": "x-ray", "capturingDefender": "remove the defender",
                "doubleCheck": "double check", "trappedPiece": "trapped piece", "zugzwang": "zugzwang",
                "defensiveMove": "defensive move", "underPromotion": "underpromotion"}


def _has(theme: str) -> str:
    return f"(' ' || themes || ' ') LIKE '% {theme} %'"


_LAME = "(" + " OR ".join([_has("oneMove")] + [f"pattern LIKE '%|{m}'" for m in LAME_MOTIFS]) + ")"
_SPICY = "(" + " OR ".join(_has(t) for t in SPICY_THEMES) + ")"

_lock = threading.Lock()
_cache: dict = {}


def available() -> bool:
    return DB_PATH.exists()


def _db() -> sqlite3.Connection:
    # read-only, one connection per call: FastAPI runs sync endpoints on a thread pool
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


# ---------------------------------------------------------------- tags and names

def tag_of(name: str) -> str:
    """An ECO name as Lichess tags it: "Queen's Pawn Game: London System" -> "Queens_Pawn_Game_London_System"."""
    return re.sub(r"[^A-Za-z0-9\- ]", "", name).strip().replace(" ", "_")


def _labels() -> dict[str, str]:
    """tag -> its proper ECO name (apostrophes and the colon back), from the vendored ECO table"""
    if "labels" not in _cache:
        from . import eco
        out = {}
        for name in eco.names():
            for part in (name.split(":")[0], name.split(",")[0]):
                out.setdefault(tag_of(part), part.strip())
        _cache["labels"] = out
    return _cache["labels"]


def label(tag: str) -> str:
    return _labels().get(tag) or tag.replace("_", " ")


# ---------------------------------------------------------------- signatures (used by the importer)

def motif_of(themes: list[str]) -> str:
    return next((m for m in MOTIFS if m in themes), "other")


def analyse(fen: str, moves: list[str], themes: list[str]) -> dict:
    """What the importer stores per puzzle: the solver's colour, the trigger and the answer in SAN, and the
    pattern key ("w:Qxh7|mate")."""
    b = chess.Board(fen)
    trigger = chess.Move.from_uci(moves[0])
    trigger_san = b.san(trigger)
    b.push(trigger)
    answer = chess.Move.from_uci(moves[1])
    piece = b.piece_at(answer.from_square)
    capture = b.is_capture(answer)
    answer_san = b.san(answer)
    solver = "w" if b.turn == chess.WHITE else "b"
    sig = f"{solver}:{piece.symbol().upper()}{'x' if capture else '-'}{chess.square_name(answer.to_square)}"
    return {"solver": solver, "trigger": trigger_san.rstrip("+#"), "answer": answer_san,
            "pattern": f"{sig}|{motif_of(themes)}"}


# ---------------------------------------------------------------- openings

def _tags() -> dict[str, dict]:
    """tag -> {tag, kind, family, n}"""
    if "tags" not in _cache:
        with _db() as con:
            _cache["tags"] = {r["tag"]: dict(r) for r in con.execute("SELECT tag, kind, family, n FROM tags")}
    return _cache["tags"]


def tag_counts() -> dict[str, dict]:
    """tag -> {n, label, kind}"""
    return {t: {"n": v["n"], "label": label(t), "kind": v["kind"]} for t, v in _tags().items()}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower().replace("'", "")).strip()


def search(q: str, limit: int = 20) -> list[dict]:
    """Families with their variations whose names match every word of q (all families, biggest first, when
    q is empty): [{tag, label, n, variations: [{tag, label, n}]}]"""
    words = _norm(q).split()
    hit = lambda t: all(w in _norm(label(t)) for w in words)
    fams: dict[str, dict] = {}
    for t in _tags().values():
        if t["kind"] == "family":
            fams.setdefault(t["tag"], {"tag": t["tag"], "label": label(t["tag"]), "n": t["n"], "variations": [], "hit": hit(t["tag"])})
    for t in _tags().values():
        if t["kind"] == "variation" and t["family"] in fams:
            f = fams[t["family"]]
            if not words or f["hit"] or hit(t["tag"]):
                f["variations"].append({"tag": t["tag"], "label": label(t["tag"]), "n": t["n"]})
    rows = [f for f in fams.values() if not words or f["hit"] or f["variations"]]
    for f in rows:
        f["variations"].sort(key=lambda v: -v["n"])
        del f["hit"]
    rows.sort(key=lambda f: -f["n"])
    return rows[:limit]


def lesson_topics() -> list[dict]:
    """The user's built opening lessons as puzzle topics: {name, color, tags, n}"""
    from . import study
    out = []
    for path in sorted(study.STUDY_DIR.glob("*.json")):
        m = re.match(r"(.+)-(white|black)$", path.stem)
        if not m:
            continue
        lesson = next((o for o in study.openings() if study.slug(o["name"], m.group(2)) == path.stem), None)
        # lessons built for the other colour before one-side-per-opening are unreachable in the app: skip them
        if not lesson or study.side(lesson["name"]) != m.group(2):
            continue
        name = lesson["name"]
        tag = tag_of(name.split(",")[0])
        if tag not in _tags():
            tag = tag_of(name.split(":")[0])
        if tag in _tags():
            out.append({"name": name, "color": m.group(2), "tags": [tag], "n": _tags()[tag]["n"], "label": label(tag)})
    return out


def _where(tags: list[str], side: str | None) -> tuple[str, list]:
    fams = [t for t in tags if _tags().get(t, {}).get("kind") == "family"]
    vars_ = [t for t in tags if _tags().get(t, {}).get("kind") == "variation"]
    parts, args = [], []
    if fams:
        parts.append(f"family IN ({','.join('?' * len(fams))})")
        args += fams
    if vars_:
        parts.append(f"variation IN ({','.join('?' * len(vars_))})")
        args += vars_
    if not parts:
        raise ValueError("no known opening tag in the selection")
    sql = "(" + " OR ".join(parts) + ")"
    if side in ("w", "b"):
        sql += " AND solver = ?"
        args.append(side)
    return sql, args


# ---------------------------------------------------------------- patterns

def _base() -> tuple[dict[str, int], int]:
    if "base" not in _cache:
        with _db() as con:
            base = {r["pattern"]: r["n"] for r in con.execute("SELECT pattern, n FROM pattern_base")}
        _cache["base"] = (base, sum(base.values()))
    return _cache["base"]


def _move_name(san: str, solver: str) -> str:
    return san if solver == "w" else "…" + san


def patterns(tags: list[str], side: str | None = None) -> dict:
    """The recurring tactics in these openings: {total, typical: [...], common: [...]}, each pattern
    {key, title, after, n, share, lift, rating, solver, motif}."""
    key = (tuple(sorted(tags)), side)
    with _lock:
        if key in _cache.setdefault("patterns", {}):
            return _cache["patterns"][key]
    where, args = _where(tags, side)
    with _db() as con:
        by_pattern: dict[str, list] = {}
        for r in con.execute(f"SELECT pattern, trigger, answer, rating FROM puzzles WHERE {where}", args):
            by_pattern.setdefault(r["pattern"], []).append(r)
        # lift compares shares of all the opening's puzzles (both sides): the pattern key already carries the
        # solver, so a side filter must not change a pattern's lift
        both = con.execute(f"SELECT COUNT(*) FROM puzzles WHERE {_where(tags, None)[0]}", _where(tags, None)[1]).fetchone()[0]
    total = sum(len(v) for v in by_pattern.values())
    need = max(MIN_PATTERN, math.ceil(total * MIN_PATTERN_SHARE))
    base, base_total = _base()
    rows = []
    for p, detail in by_pattern.items():
        n = len(detail)
        if n < need or p.split("|")[1] in LAME_MOTIFS:  # "take the loose piece" isn't a pattern worth learning
            continue
        # lift against every *other* puzzle: a huge family like the Sicilian is a big part of the whole
        # baseline, so comparing it with a baseline that includes itself would flatten every lift toward 1
        rest_n, rest_total = max(base.get(p, n) - n, 0), base_total - both
        lift = (n / both) / max(rest_n / rest_total, 0.5 / rest_total) if rest_total > 0 else 1.0
        rows.append(_describe(p, n, total, lift, detail))
    typical = sorted((r for r in rows if r["lift"] >= TYPICAL_LIFT), key=lambda r: -r["n"] * math.log2(r["lift"]))[:MAX_TYPICAL]
    common = sorted((r for r in rows if r["lift"] < TYPICAL_LIFT), key=lambda r: -r["n"])[:MAX_COMMON]
    out = {"total": total, "typical": typical, "common": common}
    with _lock:
        _cache["patterns"][key] = out
    return out


def _describe(pattern: str, n: int, total: int, lift: float, detail: list) -> dict:
    sig, motif = pattern.split("|")
    solver = sig[0]
    triggers: dict[str, int] = {}
    answers: dict[str, int] = {}
    for d in detail:
        triggers[d["trigger"]] = triggers.get(d["trigger"], 0) + 1
        answers[d["answer"]] = answers.get(d["answer"], 0) + 1
    answer = max(answers, key=answers.get)
    top = sorted(triggers.items(), key=lambda kv: -kv[1])
    other = "b" if solver == "w" else "w"
    # one trigger most of the time is the "if they play X" pattern; scattered triggers are just listed in a tooltip
    dominant = top[0][1] / n >= TRIGGER_SHARE
    ratings = sorted(d["rating"] for d in detail)
    name = _move_name(answer, solver)
    return {"key": pattern, "solver": "white" if solver == "w" else "black", "motif": motif,
            "title": name if motif == "mate" and answer.endswith("#") else f"{name} {MOTIF_LABEL.get(motif, motif)}",
            "trigger": _move_name(top[0][0], other) if dominant else None,
            "trigger_pct": round(100 * top[0][1] / n) if dominant else None,
            "triggers": [[_move_name(t, other), round(100 * k / n)] for t, k in top[:4]],
            "n": n, "share": round(100 * n / total, 1), "lift": round(lift, 1),
            "rating": ratings[len(ratings) // 2]}


# ---------------------------------------------------------------- picking a puzzle

def pick(tags: list[str], side: str | None, rating: int, pattern: str | None = None,
         exclude: list[str] = ()) -> dict | None:
    """A puzzle from these openings near `rating` (Lichess puzzle rating), widening the band until one is
    left; the popularity filter goes last. None if the selection has no puzzle at all."""
    where, args = _where(tags, side)
    if pattern:
        where += " AND pattern = ?"
        args.append(pattern)
    exclude = list(exclude)[-300:]
    if exclude:
        where += f" AND id NOT IN ({','.join('?' * len(exclude))})"
        args += exclude
    # nearness to your rating first, then spicy over plain; lame and unpopular ones only when nothing else is left
    good = f" AND popularity >= {MIN_POPULARITY} AND plays >= {MIN_PLAYS}"
    tries = [(step, f"{good} AND NOT {_LAME} AND {s}") for step in RATING_STEPS for s in (_SPICY, f"NOT {_SPICY}")]
    tries += [(step, good) for step in RATING_STEPS] + [(step, "") for step in RATING_STEPS]
    with _db() as con:
        for step, q in tries:
            row = con.execute(f"SELECT * FROM puzzles WHERE {where}{q} AND rating BETWEEN ? AND ? ORDER BY RANDOM() LIMIT 1",
                              [*args, rating - step, rating + step]).fetchone()
            if row:
                return _public(dict(row))
    return None


def get(puzzle_id: str) -> dict | None:
    with _db() as con:
        row = con.execute("SELECT * FROM puzzles WHERE id = ?", [puzzle_id]).fetchone()
    return _public(dict(row)) if row else None


def _public(row: dict) -> dict:
    moves = row["moves"].split()
    b = chess.Board(row["fen"])
    sans = []
    for u in moves:
        mv = chess.Move.from_uci(u)
        sans.append(b.san(mv))
        b.push(mv)
    themes = row["themes"].split()
    sig, motif = row["pattern"].split("|")
    return {"id": row["id"], "fen": row["fen"], "moves": moves, "sans": sans, "rating": row["rating"],
            "themes": themes, "motif": motif, "motif_label": MOTIF_LABEL.get(motif, motif),
            "mate_in": next((int(t[6:]) for t in themes if re.fullmatch(r"mateIn\d", t)), None),
            "solver": "white" if row["solver"] == "w" else "black", "pattern": row["pattern"],
            "family": label(row["family"]), "variation": label(row["variation"]), "game_url": row["game_url"],
            "plays": row["plays"], "popularity": row["popularity"], "flavour": _flavour(themes, len(moves) // 2)}


def _flavour(themes: list[str], solver_moves: int) -> list[str]:
    """What makes it worth solving, for the result card (same shape as my_puzzles' tags)"""
    return [SPICY_THEMES[t] for t in themes if t in SPICY_THEMES] + ([f"{solver_moves} moves deep"] if solver_moves > 1 else [])
