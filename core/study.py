"""Opening studies: a lesson tree for one named opening, built once and saved, then walked and drilled
for free in the app.

The tree starts at move 1 and follows the opening's own move order (from the vendored ECO table) to the
named position, then branches: on the studying side's turn it keeps one move (the masters' choice,
unless the engine says it's clearly worse), on the opponent's turn it keeps their main tries from master
games. Theory decides the lines, not the player's rating. Claude then writes an overview and a short note
per key position in one structured call; any note that mentions a move the tree and the position don't
contain is dropped, so the notes can't smuggle in an unverified line.

Saved as data/studies/<slug>.json. Building needs LICHESS_TOKEN (masters explorer) and the API key.
"""

import csv
import json
import os
import re
import time
from pathlib import Path

import anthropic
import chess

from core import features, usage
from core.eco import DATA as ECO_DATA
from core.engine import Engine

# Notes are written once per opening and read many times, so this one call can afford the strongest
# model (the per-question coach stays on core.coach.MODEL). Override with STUDY_MODEL.
STUDY_MODEL = os.environ.get("STUDY_MODEL", "claude-opus-5-5")

STUDY_DIR = Path(__file__).resolve().parent.parent / "data" / "studies"

EXTRA_PLIES = 10       # how far past the named position the tree goes
OPP_WIDTH = [3, 3, 2, 2, 1]   # opponent tries kept at their 1st, 2nd, ... branch point (then 1)
MIN_SHARE = 8.0        # an opponent try must be this % of master games to get its own branch
MIN_GAMES = 30         # below this many master games there's no theory left to follow
MAX_NODES = 90
ENGINE_SLACK = 60      # cp: a masters move this much worse than the engine's best is replaced
PREFER_GAP = 20        # cp: ...and when the engine's best is itself a master move, a smaller gap is enough
# Family lessons ("Scotch Game"): one lesson takes in the family's named lines (opponent sidelines, and your
# own alternatives when sound) instead of a picker row per variation. Families bigger than FAMILY_MAX
# (Sicilian, Ruy Lopez, French…) are really several openings and stay split by variation.
FAMILY_MAX = 60          # names in a family
FAMILY_MAX_NODES = 220
SEED_EXTRA = 4           # plies of master play kept past each named position
ALT_SLACK = 45           # cp: your named alternative must be this close to the engine's best to be taught

# quick picks for the dialog (the names chess.com's opening course uses, mapped to the ECO table's)
POPULAR = [
    "Sicilian Defense: Najdorf Variation", "Sicilian Defense: Dragon Variation",
    "Sicilian Defense: Sveshnikov Variation", "Sicilian Defense: Alapin Variation",
    "Sicilian Defense: Closed", "Italian Game", "Italian Game: Two Knights Defense",
    "Italian Game: Evans Gambit", "Ruy Lopez: Berlin Defense", "Ruy Lopez: Marshall Attack",
    "Ruy Lopez: Closed", "French Defense", "Caro-Kann Defense", "Scandinavian Defense",
    "Queen's Gambit Declined", "Queen's Gambit Accepted", "Slav Defense", "Nimzo-Indian Defense",
    "King's Indian Defense", "Catalan Opening", "English Opening", "Vienna Game", "Scotch Game",
    "London System",
]

_openings: list[dict] | None = None


def openings() -> list[dict]:
    """Every named line in the ECO table: {name, eco, moves (SAN list)}. The shortest line per name
    is the one kept, i.e. where the name first applies."""
    global _openings
    if _openings is None:
        best: dict[str, dict] = {}
        for path in sorted(ECO_DATA.glob("*.tsv")):
            with path.open(newline="") as f:
                for row in csv.DictReader(f, delimiter="\t"):
                    moves = [t for t in row["pgn"].split() if not t[0].isdigit()]
                    if row["name"] not in best or len(moves) < len(best[row["name"]]["moves"]):
                        best[row["name"]] = {"name": row["name"], "eco": row["eco"], "moves": moves}
        _openings = sorted(best.values(), key=lambda o: o["name"])
    return _openings


# Names the rule below gets wrong, as found; {ECO name: "white" | "black"}. Also applies to the name's
# sub-variations unless a more specific part of their name decides.
SIDE_OVERRIDES = {
    "Ruy Lopez: Marshall Attack": "black",  # Black's gambit (8...d5), despite "Attack"
    "Ruy Lopez: Marshall Attack, Original Marshall Attack": "black",
    "Ruy Lopez: Closed": "white",           # the table names it at Black's 5...Be7; it's White's main line
}

_BLACK_WORDS = re.compile(r"\b(Defen[cs]e|Countergambit|Counterattack|Accepted|Declined)\b")
# not "System": as many are Black's (Hedgehog, Zaitsev, Gurgenidze) as White's, so those go by their line
_WHITE_WORDS = re.compile(r"\bAttack\b")
_VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}


def _last_mover(moves: list[str]) -> str:
    return "white" if len(moves) % 2 else "black"


def _gambit_balance(moves: list[str]) -> int:
    """Material (White minus Black) at the end of a gambit's named line, counting the side to move's
    best capture: the offer is often a move that hasn't been taken yet (Vienna Gambit f4, Halloween
    Nxe5 with ...Nxe5 coming), or one that's taken (Hamppe-Muzio ...gxf3). A capture onto a defended
    square counts as losing the capturing piece, so a defended pawn isn't 'won' by a queen."""
    b = chess.Board()
    for san in moves:
        b.push_san(san)
    bal = sum(v * (len(b.pieces(p, chess.WHITE)) - len(b.pieces(p, chess.BLACK))) for p, v in _VALUES.items())
    gain = 0
    for mv in b.legal_moves:
        victim = b.piece_at(mv.to_square)
        if not victim or victim.piece_type == chess.KING:
            continue
        net = _VALUES[victim.piece_type]
        if b.is_attacked_by(not b.turn, mv.to_square):
            net -= _VALUES.get(b.piece_type_at(mv.from_square), 0)
        gain = max(gain, net)
    return bal + (gain if b.turn == chess.WHITE else -gain)


_by_name_cache: dict[str, dict] | None = None


def _by_name() -> dict[str, dict]:
    global _by_name_cache
    if _by_name_cache is None:
        _by_name_cache = {o["name"]: o for o in openings()}
    return _by_name_cache


def side(name: str) -> str:
    """The one side a lesson is built for: whoever chose this named line. Read from the most specific
    part of the name back ("Sicilian Defense: Najdorf Variation, English Attack" → English Attack →
    White): Defense/Countergambit/Accepted/Declined → Black, Attack → White; a Gambit belongs to
    the side that's material down at the end of its named line (the table often names a gambit only
    once it's been taken, e.g. Hamppe-Muzio ends on ...gxf3), else whoever moved last; any other part
    with its own table entry ("Najdorf Variation", "Closed") → whoever made that entry's last move."""
    by_name = _by_name()
    cuts = [m.end() for m in re.finditer(r"[^:,]+", name)]
    for end in reversed(cuts):
        prefix = name[:end].strip()
        if prefix in SIDE_OVERRIDES:
            return SIDE_OVERRIDES[prefix]
        part = re.split(r"[:,]", prefix)[-1].strip()
        if part.startswith("with "):  # "Vienna Gambit, with Max Lange Defense": the defense isn't the subject
            continue
        if _BLACK_WORDS.search(part):
            return "black"
        if _WHITE_WORDS.search(part):
            return "white"
        entry = by_name.get(prefix)
        if not entry:
            continue
        if "Gambit" in part:
            bal = _gambit_balance(entry["moves"])
            if bal:
                return "black" if bal > 0 else "white"
        return _last_mover(entry["moves"])
    return _last_mover(by_name[name]["moves"]) if name in by_name else "white"


def slug(name: str, color: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") + "-" + color


def _group(name: str) -> str:
    """ECO names run "Family: Variation, Sub-variation, …"; a lesson-sized group is the part before the
    first comma ("Sicilian Defense: Dragon Variation"), and everything after it is a sub-variation."""
    return name.split(",")[0].strip()


def family(name: str) -> str:
    return name.split(":")[0].strip()


def family_members(name: str) -> list[dict]:
    return [o for o in openings() if family(o["name"]) == name]


def lesson_key(name: str) -> str:
    """The picker row (and lesson) a name belongs to: its family when the family is lesson-sized and has
    its own ECO entry ("Scotch Game: Schmidt Variation" → "Scotch Game"), else its variation group."""
    f = family(name)
    if f in _by_name() and len(_family_sizes().get(f, ())) <= FAMILY_MAX:
        return f
    return _group(name)


_family_cache: dict[str, list[str]] | None = None


def _family_sizes() -> dict[str, list[str]]:
    global _family_cache
    if _family_cache is None:
        _family_cache = {}
        for o in openings():
            _family_cache.setdefault(family(o["name"]), []).append(o["name"])
    return _family_cache


def is_family_lesson(name: str) -> bool:
    return lesson_key(name) == name and family(name) == name and len(_family_sizes().get(name, ())) > 1


def _entry(o: dict) -> dict:
    color = side(o["name"])
    return {**o, "color": color, "built": (STUDY_DIR / f"{slug(o['name'], color)}.json").exists()}


def search(q: str, limit: int = 30) -> list[dict]:
    """Openings grouped for the picker: one row per variation group, with its sub-variations under it.
    A group is listed when its own name matches (then with all its sub-variations) or when some of its
    sub-variations do (then with just those). `in_lesson` marks a sub-variation whose position the
    group's built lesson already plays through."""
    words = q.lower().split()
    match = lambda name: all(w in name.lower() for w in words)
    by_group: dict[str, list[dict]] = {}
    for o in openings():
        by_group.setdefault(lesson_key(o["name"]), []).append(o)
    rows = []
    for g, members in by_group.items():
        g_hit = match(g) if words else g in POPULAR
        subs = [o for o in members if o["name"] != g and (g_hit or (words and match(o["name"])))]
        if not g_hit and not subs:
            continue
        base = _by_name().get(g)
        rows.append((not g_hit, g not in POPULAR, len((base or min(members, key=lambda o: len(o["moves"])))["moves"]), g, base, subs))
    rows.sort(key=lambda r: r[:4])
    out = []
    for _, _, _, g, base, subs in rows[:limit]:
        head = _entry(base) if base else {"name": g, "eco": subs[0]["eco"], "moves": min(subs, key=lambda o: len(o["moves"]))["moves"],
                                          "color": None, "built": False, "no_entry": True}
        epds = set()
        if head["built"]:
            lesson = load(g, head["color"])
            epds = {chess.Board(n["fen"]).epd() for n in lesson["nodes"].values()}
        sub_rows = []
        for o in sorted(subs, key=lambda o: (len(o["moves"]), o["name"])):
            b = chess.Board()
            for san in o["moves"]:
                b.push_san(san)
            sub_rows.append({**_entry(o), "short": o["name"][len(g):].lstrip(":, "), "in_lesson": b.epd() in epds})
        out.append({**head, "subs": sub_rows})
    return out


def load(name: str, color: str) -> dict | None:
    """A saved lesson, with each node's opening name (where the ECO table names that exact position)
    filled in, so the app can say "Yugoslav Attack" when the lesson reaches it."""
    f = STUDY_DIR / f"{slug(name, color)}.json"
    if not f.exists():
        return None
    study = json.loads(f.read_text())
    from core import eco
    for n in study["nodes"].values():
        hit = eco.lookup(chess.Board(n["fen"]))
        if hit:
            n["opening"] = hit["name"]
    # lessons built before 2026-10-07 stored a Lichess rating; the app shows chess.com rapid ("% of ~830 players")
    if study.get("human_rating") and study.get("human_scale") != "chesscom":
        from core.ratings import to_chesscom
        study["human_rating"] = round(to_chesscom(study["human_rating"]), -1)
    return study


# ---------------------------------------------------------------- the tree

def _build_tree(opening: dict, color: str, engine: Engine, explore, progress) -> dict:
    mine = chess.WHITE if color == "white" else chess.BLACK
    nodes: dict[str, dict] = {}

    def add(board: chess.Board, parent: str | None, move: chess.Move | None, **extra) -> str:
        nid = str(len(nodes))
        san = None
        if move is not None:
            san = board.san(move)
            board = board.copy(stack=False)
            board.push(move)
        nodes[nid] = {"id": nid, "parent": parent, "san": san, "uci": move.uci() if move else None,
                      "fen": board.fen(), "children": [], "main": None, **extra}
        if parent is not None:
            nodes[parent]["children"].append(nid)
        return nid

    # the trunk: the named line's own move order, one move per ply
    board = chess.Board()
    cur = add(board, None, None, trunk=True)
    for san in opening["moves"]:
        mv = board.parse_san(san)
        child = add(board, cur, mv, trunk=True)
        nodes[cur]["main"] = child
        board.push(mv)
        cur = child
    trunk_end = cur

    looked = 0

    def walk(frontier: list, max_depth: int, cap: int) -> None:
        """Breadth-first through master games: frontier items are (node id, plies so far, opponent
        branch points so far)."""
        nonlocal looked
        while frontier and len(nodes) < cap:
            nid, depth, opp_branches = frontier.pop(0)
            if depth >= max_depth or nodes[nid]["children"]:
                continue
            b = chess.Board(nodes[nid]["fen"])
            if b.is_game_over():
                continue
            try:
                data = explore(b.fen(), "masters")
            except RuntimeError:
                data = None
            looked += 1
            progress(f"Reading master games… ({looked} positions)")
            if not data or data["total"] < MIN_GAMES:
                continue
            nodes[nid]["games"] = data["total"]
            if b.turn == mine:
                # one move to learn: the masters' choice, unless the engine says it's clearly worse
                top = engine.lines(b, multipv=2, seconds=3, depth=20)
                pick = data["moves"][0]
                source = "masters"
                if top:
                    nodes[nid]["engine_top"] = [f"{t['move']} ({t['eval_white']})" for t in top]
                    best_cp = top[0]["cp_white"] * (1 if mine == chess.WHITE else -1)
                    ours = next((t for t in top if t["uci"] == pick["uci"]), None)
                    if ours is None:
                        nb = b.copy(stack=False)
                        nb.push_uci(pick["uci"])
                        ours_cp = engine.evaluate(nb, seconds=2, depth=18)["cp_white"] * (1 if mine == chess.WHITE else -1)
                    else:
                        ours_cp = ours["cp_white"] * (1 if mine == chess.WHITE else -1)
                    # theory stays master-based: among the moves masters really play, teach the soundest
                    played = next((m for m in data["moves"] if b.parse_uci(m["uci"]) == b.parse_uci(top[0]["uci"])
                                   and m["share"] >= MIN_SHARE), None)
                    if played and played is not pick and best_cp - ours_cp >= PREFER_GAP:
                        pick, source = played, "masters+engine"
                    elif best_cp - ours_cp > ENGINE_SLACK:
                        pick = {"uci": top[0]["uci"], "share": None, "games": None}
                        source = "engine"
                child = add(b, nid, b.parse_uci(pick["uci"]), share=pick.get("share"),
                            games_move=pick.get("games"), source=source)
                nodes[nid]["main"] = child
                nodes[nid]["alternatives"] = [m["san"] for m in data["moves"][:3]
                                              if m["share"] >= MIN_SHARE and m["uci"] != pick["uci"]][:2]
                frontier.append((child, depth + 1, opp_branches))
            else:
                width = OPP_WIDTH[opp_branches] if opp_branches < len(OPP_WIDTH) else 1
                tries = [m for m in data["moves"] if m["share"] >= MIN_SHARE][:width] or data["moves"][:1]
                for m in tries:
                    child = add(b, nid, b.parse_uci(m["uci"]), share=m["share"], games_move=m["games"],
                                results=[m["white"], m["draws"], m["black"]])
                    frontier.append((child, depth + 1, opp_branches + (len(tries) > 1)))
                nodes[nid]["main"] = nodes[nid]["children"][0]

    # the branches: breadth-first from the named position
    walk([(trunk_end, 0, 0)], EXTRA_PLIES, MAX_NODES)
    if is_family_lesson(opening["name"]):
        _seed_family(opening, nodes, add, walk, mine, engine, progress)

    # evals for the pills, and ply numbers
    progress("Checking every position with the engine…")
    for n in nodes.values():
        b = chess.Board(n["fen"])
        n["ply"] = _ply_of(nodes, n)
        n["eval_white"] = engine.evaluate(b, seconds=0.5, depth=16)["eval_white"] if not b.is_game_over() else None
    return {"root": "0", "trunk_end": trunk_end, "nodes": nodes}


def _seed_family(opening: dict, nodes: dict, add, walk, mine: bool, engine: Engine, progress) -> None:
    """Family lesson: add every named line of the family that passes through the lesson's own position.
    The opponent's named moves go in however rare (they're the sidelines you explore); your own named
    alternatives only when the engine rates them within ALT_SLACK of its best (Scotch Gambit yes, Relfsson
    no), marked `alt` so Drill keeps to the main line. Each named line then runs SEED_EXTRA plies on."""
    trunk = opening["moves"]
    seeds = sorted((o for o in family_members(opening["name"])
                    if o["name"] != opening["name"] and o["moves"][:len(trunk)] == trunk),
                   key=lambda o: (len(o["moves"]), o["name"]))
    sign = 1 if mine == chess.WHITE else -1
    ends = []
    for i, o in enumerate(seeds):
        progress(f"Adding the named variations… ({i + 1}/{len(seeds)})")
        b, nid = chess.Board(), "0"
        for san in o["moves"]:
            mv = b.parse_san(san)
            kid = next((k for k in nodes[nid]["children"] if nodes[k]["uci"] == mv.uci()), None)
            if kid is None:
                if len(nodes) >= FAMILY_MAX_NODES:
                    break
                extra = {"source": "named"}
                if b.turn == mine:
                    best = engine.lines(b, multipv=1, seconds=1.5, depth=18)
                    nb = b.copy(stack=False)
                    nb.push(mv)
                    ours = engine.evaluate(nb, seconds=1.5, depth=18)
                    if not best or sign * (best[0]["cp_white"] - ours["cp_white"]) > ALT_SLACK:
                        break   # an unsound move of yours isn't taught; the rest of this line goes with it
                    if nodes[nid]["main"] is not None:
                        extra["alt"] = True
                kid = add(b, nid, mv, **extra)
                if nodes[nid]["main"] is None:
                    nodes[nid]["main"] = kid
            b.push(mv)
            nid = kid
        else:
            ends.append((nid, 0, 99))   # 99 branch points: one opponent try per position from here
    walk(ends, SEED_EXTRA, FAMILY_MAX_NODES)


def _ply_of(nodes: dict, n: dict) -> int:
    k = 0
    while n["parent"] is not None:
        k += 1
        n = nodes[n["parent"]]
    return k


def _line(nodes: dict, nid: str) -> list[str]:
    out = []
    n = nodes[nid]
    while n["parent"] is not None:
        out.append(n["san"])
        n = nodes[n["parent"]]
    return out[::-1]


def numbered(sans: list[str]) -> str:
    if not sans:
        return "(start)"
    walk = chess.Board()
    return chess.Board().variation_san([walk.push_san(s) for s in sans])


# ---------------------------------------------------------------- the notes

NOTES_SCHEMA = {
    "type": "object",
    "properties": {
        "overview": {
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "key_ideas": {"type": "array", "items": {"type": "string"}},
                "pawn_breaks": {"type": "array", "items": {"type": "string"}},
                "wait_for": {"type": "array", "items": {"type": "string"}},
                "common_mistakes": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["summary", "key_ideas", "pawn_breaks", "wait_for", "common_mistakes"],
            "additionalProperties": False,
        },
        "notes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "note": {"type": "string"}},
                "required": ["id", "note"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["overview", "notes"],
    "additionalProperties": False,
}

SAN_TOKEN = re.compile(r"\b(?:\d+\.(?:\.\.)?\s?)?(O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?|[a-h][1-8](?:=[QRBN])?[+#]?)")


def _facts(board: chess.Board, move: chess.Move) -> list[str]:
    """What the move concretely does, computed from the board (features.move_effects), so the notes
    don't have to guess which piece a pawn push hits or whether a pawn is passed."""
    e = features.move_effects(board, move)
    out = []
    if e["capture"]:
        out.append(f"captures the {e['capture']}")
    if e["check"]:
        out.append("gives check")
    if e["castling"]:
        out.append("castles")
    if e["moved_piece_now_attacks"]:
        out.append("the moved piece attacks " + ", ".join(e["moved_piece_now_attacks"]))
    if e["discovered_attacks_on"]:
        out.append("uncovers an attack on " + ", ".join(e["discovered_attacks_on"]))
    if e["pins_created"]:
        out.append("pins " + ", ".join(e["pins_created"]))
    if e["own_pieces_left_loose"]:
        out.append("leaves undefended: " + ", ".join(e["own_pieces_left_loose"]))
    for k, squares in e["structure_changes"].items():
        out.append(k.replace("_", " ") + ": " + ", ".join(squares))
    return out


def _notes_prompt(opening: dict, color: str, tree: dict) -> str:
    nodes = tree["nodes"]
    rows = []
    for n in nodes.values():
        if n["parent"] is None:
            continue
        b = chess.Board(nodes[n["parent"]]["fen"])
        who = "White" if b.turn == chess.WHITE else "Black"
        mine = (who.lower() == color)
        line = _line(nodes, n["id"])
        label = f"{(len(line) + 1) // 2}{'.' if len(line) % 2 else '...'}{n['san']}"
        bits = [f"id {n['id']}", f"move {label}", f"line {numbered(line)}", f"({who}{', the student' if mine else ''})"]
        if n.get("share") is not None:
            bits.append(f"{n['share']}% of master games")
        if n.get("alt"):
            bits.append("a named alternative the student may choose instead of the lesson's main move")
        elif n.get("source") == "named" and not mine:
            bits.append("a named sideline (rare in master games)")
        if n.get("source") == "engine":
            bits.append("engine's choice over the masters' most popular move")
        elif n.get("source") == "masters+engine":
            bits.append("a master move chosen because the engine rates it above the most popular one")
        if n.get("eval_white"):
            bits.append(f"eval after {n['eval_white']}")
        if mine and nodes[n["parent"]].get("engine_top"):
            bits.append("engine's top choices in this position: " + ", ".join(nodes[n["parent"]]["engine_top"]))
        if mine and nodes[n["parent"]].get("alternatives"):
            bits.append("other moves masters play here: " + ", ".join(nodes[n["parent"]]["alternatives"]))
        facts = _facts(b, chess.Move.from_uci(n["uci"]))
        if facts:
            bits.append("board facts: " + "; ".join(facts))
        rows.append(" · ".join(bits))
    return f"""You are writing a study guide for the {opening['name']} ({opening['eco']}), for a student who plays {color}.

Below is the lesson tree: every line the student will drill, built from master games and checked by Stockfish. Each row is one move: the node id, the move with its correct move number (use exactly that number when you name it), the full line up to and including it, who played it, how often masters play it, the engine's evaluation after it (White's point of view), and board facts.

Write:
1. "overview": what this opening is about for {color}. summary (3-4 sentences); key_ideas (the plans and piece placements that must be played, 4-6 items); pawn_breaks (which breaks, when, and what they aim at); wait_for (what to watch for from the opponent and the right reaction: their typical attacking setups, the signal that says it's time for a break, the moment a standard sacrifice works); common_mistakes (mistakes students make in this opening, 3-5 items).
2. "notes": a note for each important node, keyed by its id: every move the student has to find (explain *why* this move, what it prepares or prevents), and every opponent move that starts a new branch (name the setup if it has a name, e.g. "English Attack", say what the opponent is going for and how the student meets it). Skip nodes where nothing needs saying. 1-3 sentences each, under 60 words.

Rules: never call it "the tree" or "the tree's move"; say "this lesson". The student's move in each row is what the lesson teaches: explain why it works. If the engine lists a different top choice, you may mention it as an alternative in one short clause, and only call the lesson's move worse when the engine's numbers differ by more than 0.5. Each row's "board facts" are computed from the position (what the move captures, attacks, pins, leaves undefended, and pawn-structure changes such as new passed or isolated pawns). Any concrete claim about what a move attacks, defends, wins, or does to the pawn structure must match those facts; if they don't list it, don't claim it (plans, typical ideas and names of setups are fine). Only mention moves that appear in the tree or are legal in that exact position; don't invent variations beyond the tree; say "the engine" for evaluations and don't quote numbers unless they're in the row; only say what the engine prefers when the row lists its top choices. Plain, concrete language, no hype. Use standard move notation (e.g. 6...e5, Be3, the ...d5 break).

Lesson tree:
""" + "\n".join(rows)


def _related_boards(nid: str, nodes: dict) -> list[chess.Board]:
    """Positions along this node's own line (ancestors and descendants), each with either side to move:
    a note may name a move from earlier in the line or a plan move a few moves ahead."""
    ids, k = [], nid
    while k is not None:
        ids.append(k)
        k = nodes[k]["parent"]
    todo = list(nodes[nid]["children"])
    while todo:
        k = todo.pop()
        ids.append(k)
        todo += nodes[k]["children"]
    boards = []
    for k in ids:
        for turn in (chess.WHITE, chess.BLACK):
            b = chess.Board(nodes[k]["fen"])
            b.turn = turn
            b.ep_square = None
            boards.append(b)
    return boards


def _verified(note: str, nid: str, nodes: dict, tree_sans: set[str]) -> bool:
    """A note may only mention moves that are in the tree or legal somewhere along its own line."""
    boards = None
    for tok in SAN_TOKEN.findall(note):
        san = tok.rstrip("+#")
        if san in tree_sans or tok in tree_sans:
            continue
        boards = boards or _related_boards(nid, nodes)
        ok = False
        for b in boards:
            try:
                b.parse_san(tok)
                ok = True
                break
            except ValueError:
                pass
        if not ok and re.fullmatch(r"[a-h][1-8]", tok):
            ok = True   # a bare square ("the d5 square") is not a move claim
        if not ok:
            return False
    return True


def _write_notes(opening: dict, color: str, tree: dict, model: str = STUDY_MODEL) -> tuple[dict, int]:
    client = anthropic.Anthropic()
    t0 = time.monotonic()
    with client.beta.messages.stream(
        model=model,
        max_tokens=64000,
        thinking={"type": "adaptive"},
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": NOTES_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",   # a safety-classifier decline is rerouted instead of failing the build
        messages=[{"role": "user", "content": _notes_prompt(opening, color, tree)}],
    ) as stream:
        response = stream.get_final_message()
    try:
        u = response.usage
        usage.record(model=model, input_tokens=u.input_tokens, output_tokens=u.output_tokens,
                     cache_creation_input_tokens=u.cache_creation_input_tokens or 0,
                     cache_read_input_tokens=u.cache_read_input_tokens or 0,
                     question=f"[study build] {opening['name']} ({color})", api_seconds=time.monotonic() - t0)
    except Exception:  # noqa: BLE001 — telemetry never blocks the build
        pass
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to write notes for this opening.")
    text = next(b.text for b in response.content if b.type == "text")
    data = json.loads(text)
    nodes = tree["nodes"]
    tree_sans = {n["san"] for n in nodes.values() if n["san"]}
    dropped = 0
    for item in data["notes"]:
        if item["id"] in nodes and nodes[item["id"]]["parent"] is not None:
            if _verified(item["note"], item["id"], nodes, tree_sans):
                nodes[item["id"]]["note"] = item["note"]
            else:
                dropped += 1
    return data["overview"], dropped


def build(name: str, color: str, engine: Engine, explore, progress=lambda msg: None) -> dict:
    opening = next((o for o in openings() if o["name"] == name), None)
    if opening is None:
        raise ValueError(f"unknown opening: {name}")
    if color not in ("white", "black"):
        raise ValueError("color must be white or black")
    tree = _build_tree(opening, color, engine, explore, progress)
    progress("The coach is writing the notes… (1-2 minutes)")
    overview, dropped = _write_notes(opening, color, tree)
    study = {"name": name, "eco": opening["eco"], "color": color, "slug": slug(name, color),
             "built": time.strftime("%Y-%m-%d"), "model": STUDY_MODEL, "overview": overview,
             "dropped_notes": dropped, **tree}
    try:
        add_curveballs(study, engine, explore, progress)
    except Exception:  # noqa: BLE001 — curveballs are extra; the lesson works without them
        pass
    progress("Placing the overview's ideas on the board…")
    try:
        tag_overview(study)
    except Exception:  # noqa: BLE001 — the lesson still works without moments (overview shown whole)
        pass
    save(study)
    return study


def coach_note(study: dict) -> str:
    """What the coach is told when a study starts (so its answers match the lesson)."""
    o = study["overview"]
    return (f"The player is studying the {study['name']} as {study['color']} in the app's opening "
            f"trainer. The lesson's overview (written from master games and checked by the engine): "
            f"{o['summary']} Key ideas: {'; '.join(o['key_ideas'])}. Pawn breaks: {'; '.join(o['pawn_breaks'])}. "
            f"What to wait for: {'; '.join(o['wait_for'])}. Keep answers consistent with this lesson and "
            f"teach: explain the why, the plans, and what the opponent is trying, not just the moves.")


# ---------------------------------------------------------------- curveballs
# Mistakes club players really make in the lesson's positions, so the app can throw one in now and then
# and make you find the punishment instead of following arrows. Per position where the opponent moves:
# the Lichess database's moves by 1000-1800 players (blitz/rapid/classical) that aren't lesson moves,
# kept when the engine says they throw away at least CURVE_MIN_LOSS; stored with the replies that punish
# them (the engine's best, plus any within CURVE_ACCEPT of it). Engine + Lichess only, no Claude call.

CURVE_RATINGS = [1000, 1200, 1400, 1600]
CURVE_SPEEDS = ["blitz", "rapid", "classical"]
CURVE_MIN_GAMES = 20     # a move this rare isn't a mistake people actually make
CURVE_CANDIDATES = 4     # most-played non-lesson moves checked per position
CURVE_MIN_LOSS = 120     # cp the mistake must throw away (with best play after it)
CURVE_ACCEPT = 50        # cp: a reply this close to the engine's best also counts as punishing it
CURVE_KEEP = 3


def _best_cp(b: chess.Board, engine: Engine) -> int | None:
    """The engine's best for the side to move, in centipawns from that side's point of view."""
    top = engine.lines(b, multipv=1, seconds=1.0, depth=18)
    return (1 if b.turn == chess.WHITE else -1) * top[0]["cp_white"] if top else None


def _judge(b: chess.Board, mv: chess.Move, engine: Engine, best: int) -> dict | None:
    """How much `mv` throws away against `best` (the mover's view), with the replies that punish it."""
    sign = 1 if b.turn == chess.WHITE else -1
    nb = b.copy(stack=False)
    nb.push(mv)
    if nb.is_game_over():
        return None
    replies = engine.lines(nb, multipv=3, seconds=1.0, depth=18)
    if not replies:
        return None
    ok = [r for r in replies if sign * (r["cp_white"] - replies[0]["cp_white"]) <= CURVE_ACCEPT]
    return {"loss": best - sign * replies[0]["cp_white"], "eval_white": replies[0]["eval_white"],
            "line": replies[0]["line"], "pv": replies[0]["pv"],
            "punish": [{"san": r["move"], "uci": r["uci"], "eval_white": r["eval_white"]} for r in ok]}


def add_curveballs(study: dict, engine: Engine, explore, progress=lambda msg: None) -> int:
    """Set node["curveballs"] on the lesson's opponent-to-move positions; returns how many were found."""
    nodes = study["nodes"]
    mine = chess.WHITE if study["color"] == "white" else chess.BLACK
    todo = [n for n in nodes.values() if n["children"] and chess.Board(n["fen"]).turn != mine]
    found = 0
    for i, n in enumerate(todo):
        progress(f"Finding club players' mistakes… ({i + 1}/{len(todo)} positions)")
        b = chess.Board(n["fen"])
        try:
            data = explore(b.fen(), "lichess", ratings=CURVE_RATINGS, speeds=CURVE_SPEEDS)
        except RuntimeError:
            continue
        lesson = {nodes[k]["uci"] for k in n["children"]}
        cands = [m for m in data["moves"] if m["games"] >= CURVE_MIN_GAMES
                 and b.parse_uci(m["uci"]).uci() not in lesson][:CURVE_CANDIDATES]
        if not cands:
            continue
        best = _best_cp(b, engine)
        if best is None:
            continue
        balls = []
        for m in cands:
            mv = b.parse_uci(m["uci"])
            j = _judge(b, mv, engine, best)
            if j is None or j["loss"] < CURVE_MIN_LOSS:
                continue
            balls.append({"san": b.san(mv), "uci": mv.uci(), "games": m["games"], **j})
        if balls:
            n["curveballs"] = sorted(balls, key=lambda x: -x["games"])[:CURVE_KEEP]
            found += len(n["curveballs"])
        else:
            n.pop("curveballs", None)
    study["curveballs_built"] = time.strftime("%Y-%m-%d")
    return found


# ---------------------------------------------------------------- human moves
# The lesson's own moves stay theory; this makes the opponent's side human. Per opponent-to-move position
# past the trunk, Maia-3 says what a player of your rating (PLAYER_RATING) plays there. Its moves of at
# least HUMAN_MIN_PCT that aren't lesson moves are judged by the engine: a sound one (loses < CURVE_MIN_LOSS)
# becomes a new branch (source "human"), continued HUMAN_EXTRA plies with your reply from master games when
# masters reached it (and the engine agrees), else the engine's, and Maia's top move for them; a losing one
# becomes a curveball like the Lichess-database ones. Every opponent node also keeps Maia's top moves in
# node["maia"], so the app can pick their reply the way a human would. Engine + Maia, no Claude call.
# The trunk is skipped: leaving the named move order means a different opening (another lesson).

HUMAN_MIN_PCT = 15.0     # how likely at your rating a sound move must be to get its own branch
HUMAN_CURVE_PCT = 8.0    # ...and a losing one to become a curveball (blunders are rarely anyone's top choice)
HUMAN_EXTRA = 4          # plies a human branch runs on
HUMAN_MAX_NODES = 60     # new nodes per lesson, so human branches can't swamp the theory


def _board_at(nodes: dict, nid: str) -> chess.Board:
    """The node's position with its move history (Maia reads the last 8 positions)."""
    b = chess.Board()
    for san in _line(nodes, nid):
        b.push_san(san)
    return b


def add_human(study: dict, engine: Engine, maia, explore, rating: int, progress=lambda msg: None) -> dict:
    """Add Maia's maia/branch/curveball data to the lesson in place; returns what was added, for review."""
    nodes = study["nodes"]
    mine = chess.WHITE if study["color"] == "white" else chess.BLACK
    next_id = max(int(k) for k in nodes) + 1
    report = {"branches": [], "curveballs": [], "covered": [], "dropped": 0}

    def add(b: chess.Board, parent: str, mv: chess.Move, **extra) -> str:
        nonlocal next_id
        nid, next_id = str(next_id), next_id + 1
        san = b.san(mv)
        nb = b.copy()
        nb.push(mv)
        nodes[nid] = {"id": nid, "parent": parent, "san": san, "uci": mv.uci(), "fen": nb.fen(),
                      "children": [], "main": None, "ply": len(nb.move_stack),
                      "eval_white": engine.evaluate(nb, seconds=0.5, depth=16)["eval_white"]
                      if not nb.is_game_over() else None, **extra}
        nodes[parent]["children"].append(nid)
        if nodes[parent]["main"] is None:
            nodes[parent]["main"] = nid
        return nid

    def extend(nid: str, plies: int) -> None:
        b = _board_at(nodes, nid)
        for _ in range(plies):
            if b.is_game_over() or len(nodes) - n0 >= HUMAN_MAX_NODES:
                return
            if b.turn == mine:
                # your reply: theory if masters got here and it's sound, else the engine's move
                best = engine.lines(b, multipv=1, seconds=1.5, depth=18)
                if not best:
                    return
                mv, extra = b.parse_uci(best[0]["uci"]), {"source": "engine"}
                try:
                    data = explore(b.fen(), "masters")
                except RuntimeError:
                    data = None
                if data and data["total"] >= MIN_GAMES:
                    m = data["moves"][0]
                    cand = b.parse_uci(m["uci"])
                    j = _judge(b, cand, engine, _best_cp(b, engine) or 0) if cand != mv else {"loss": 0}
                    if j is not None and j["loss"] <= ENGINE_SLACK:
                        mv, extra = cand, {"source": "masters", "share": m["share"], "games_move": m["games"]}
            else:
                top = maia.moves(b, rating, rating, top=1)
                if not top:
                    return
                mv, extra = b.parse_uci(top[0]["uci"]), {"source": "human", "pct": top[0]["pct"]}
            nid = add(b, nid, mv, **extra)
            b.push(mv)

    n0 = len(nodes)
    todo = sorted((n for n in nodes.values() if n["children"] and not n.get("trunk")
                   and chess.Board(n["fen"]).turn != mine), key=lambda n: n["ply"])
    for i, n in enumerate(todo):
        progress(f"Checking what players at {rating} play… ({i + 1}/{len(todo)} positions)")
        b = _board_at(nodes, n["id"])
        guesses = maia.moves(b, rating, rating, top=10)
        n["maia"] = [{"san": g["move"], "uci": g["uci"], "pct": g["pct"]} for g in guesses[:5]]
        lesson = {nodes[k]["uci"] for k in n["children"]}
        report["covered"].append((n["id"], sum(g["pct"] for g in guesses if g["uci"] in lesson)))
        cands = [g for g in guesses if g["pct"] >= HUMAN_CURVE_PCT and g["uci"] not in lesson]
        if not cands:
            continue
        best = _best_cp(b, engine)
        if best is None:
            continue
        for g in cands:
            mv = b.parse_uci(g["uci"])
            j = _judge(b, mv, engine, best)
            if j is None:
                continue
            if j["loss"] >= CURVE_MIN_LOSS:
                balls = n.setdefault("curveballs", [])
                old = next((c for c in balls if c["uci"] == g["uci"]), None)
                if old:
                    old["pct"] = g["pct"]   # the Lichess database already has it; keep its game count
                else:
                    balls.append({"san": g["move"], "uci": g["uci"], "games": None, "pct": g["pct"],
                                  "source": "maia", **j})
                report["curveballs"].append((n["id"], g["move"], g["pct"], j["loss"], bool(old)))
            elif g["pct"] < HUMAN_MIN_PCT:
                continue
            elif len(nodes) - n0 < HUMAN_MAX_NODES:
                kid = add(b, n["id"], mv, source="human", pct=g["pct"])
                extend(kid, HUMAN_EXTRA)
                report["branches"].append((n["id"], kid, g["pct"], j["loss"]))
            else:
                report["dropped"] += 1
    study["human_rating"] = rating
    study["human_scale"] = "chesscom"  # see load()
    study["human_built"] = time.strftime("%Y-%m-%d")
    return report


# ---------------------------------------------------------------- overview → moments
# The overview is written all at once; in the app each bullet should appear when its situation is on the
# board. One small call tags every bullet with a short title and the lesson positions it belongs to,
# saved as study["moments"] (the overview text itself is unchanged). Run for new builds and, by hand,
# for lessons built before this existed: python -m core.study tag [slug ...]

OVERVIEW_KINDS = ["key_ideas", "pawn_breaks", "wait_for", "common_mistakes"]
MAX_MOMENT_NODES = 4

MOMENTS_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": OVERVIEW_KINDS},
                    "index": {"type": "integer"},
                    "title": {"type": "string"},
                    "nodes": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["kind", "index", "title", "nodes"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["items"],
    "additionalProperties": False,
}


def _moments_prompt(study: dict) -> str:
    nodes = study["nodes"]
    rows = []
    for n in nodes.values():
        if n["parent"] is None:
            continue
        line = _line(nodes, n["id"])
        who = "White" if len(line) % 2 else "Black"
        rows.append(f"id {n['id']} · {numbered(line)} · last move by {who}"
                    f"{' (the student)' if who.lower() == study['color'] else ''}"
                    f"{' · end of a line' if not n['children'] else ''}")
    bullets = []
    for kind in OVERVIEW_KINDS:
        for i, text in enumerate(study["overview"][kind]):
            bullets.append(f"{kind} #{i}: {text}")
    return f"""This is an opening lesson on the {study['name']} for a student who plays {study['color']}. The student walks through it one move at a time, and each overview bullet below should be shown at the moment its situation is on the board instead of all at once at the start.

For every bullet, return:
- kind and index exactly as given;
- title: 3-6 words naming the idea, in the student's terms (e.g. "Meet the English Attack with ...h5", "Don't grab b2 twice");
- nodes: the ids of the positions where this bullet should appear: the position right after that id's move, when the situation the bullet talks about has just arisen (the setup appears, the break becomes possible, the mistake is tempting on the student's next move). Prefer the first position in each line where it applies; at most {MAX_MOMENT_NODES} ids. A bullet about the whole opening that no single position triggers gets an empty list (it's shown when a line ends, as the plan from there).

Bullets:
""" + "\n".join(bullets) + "\n\nLesson positions (id · moves from the start · who just moved):\n" + "\n".join(rows)


def tag_overview(study: dict, model: str = STUDY_MODEL) -> dict:
    """Add study["moments"] = [{kind, index, title, nodes}] and return the study (not saved)."""
    client = anthropic.Anthropic()
    t0 = time.monotonic()
    with client.beta.messages.stream(
        model=model,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": MOMENTS_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=[{"role": "user", "content": _moments_prompt(study)}],
    ) as stream:
        response = stream.get_final_message()
    try:
        u = response.usage
        usage.record(model=model, input_tokens=u.input_tokens, output_tokens=u.output_tokens,
                     cache_creation_input_tokens=u.cache_creation_input_tokens or 0,
                     cache_read_input_tokens=u.cache_read_input_tokens or 0,
                     question=f"[study tag] {study['name']} ({study['color']})", api_seconds=time.monotonic() - t0)
    except Exception:  # noqa: BLE001 — telemetry never blocks the build
        pass
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to tag this lesson's overview.")
    items = json.loads(next(b.text for b in response.content if b.type == "text"))["items"]
    nodes = study["nodes"]
    moments, seen = [], set()
    for it in items:
        key = (it["kind"], it["index"])
        if it["kind"] not in study["overview"] or not 0 <= it["index"] < len(study["overview"][it["kind"]]) or key in seen:
            continue  # an id the model invented, or a duplicate
        seen.add(key)
        ids = [k for k in it["nodes"] if k in nodes and nodes[k]["parent"] is not None][:MAX_MOMENT_NODES]
        moments.append({"kind": it["kind"], "index": it["index"], "title": it["title"].strip(), "nodes": ids})
    # a bullet the model skipped still gets shown, as an end-of-line plan
    for kind in OVERVIEW_KINDS:
        for i, text in enumerate(study["overview"][kind]):
            if (kind, i) not in seen:
                moments.append({"kind": kind, "index": i, "title": text.split(":")[0][:60], "nodes": []})
    study["moments"] = moments
    return study


def save(study: dict) -> None:
    STUDY_DIR.mkdir(parents=True, exist_ok=True)
    (STUDY_DIR / f"{study['slug']}.json").write_text(json.dumps(study, indent=1))


if __name__ == "__main__":
    import functools
    import sys
    if sys.argv[1:2] == ["curveballs"]:
        from frontends.lichess import explorer
        slugs = sys.argv[2:] or [f.stem for f in sorted(STUDY_DIR.glob("*.json"))]
        engine = Engine(threads=2, hash_mb=128)
        try:
            for s in slugs:
                study = json.loads((STUDY_DIR / f"{s}.json").read_text())
                t0 = time.monotonic()
                found = add_curveballs(study, engine, functools.partial(explorer.explore, patient=True))
                save(study)
                print(f"{s}: {found} curveballs ({time.monotonic() - t0:.0f} s)")
                for n in study["nodes"].values():
                    for c in n.get("curveballs", []):
                        print(f"  after {' '.join(_line(study['nodes'], n['id'])[-2:])}: {c['san']}?? "
                              f"({c['games']} club games, -{c['loss'] / 100:.1f}) → {', '.join(p['san'] for p in c['punish'])}")
        finally:
            engine.close()
        sys.stdout.flush()
        os._exit(0)  # the engine thread keeps the process alive otherwise
    if sys.argv[1:2] == ["human"]:
        # python -m core.study human [--write] [--rating N] [slug ...]: prints what it would add; saves only with --write
        from core import maia as maia_mod
        from frontends.lichess import explorer
        args = sys.argv[2:]
        write = "--write" in args
        rating = maia_mod.player_rating()
        if "--rating" in args:
            rating = int(args[args.index("--rating") + 1])
            del args[args.index("--rating"):args.index("--rating") + 2]
        slugs = [a for a in args if not a.startswith("--")] or [f.stem for f in sorted(STUDY_DIR.glob("*.json"))]
        engine, m = Engine(threads=2, hash_mb=128), maia_mod.Maia()
        try:
            for s in slugs:
                study = json.loads((STUDY_DIR / f"{s}.json").read_text())
                if study.get("human_built"):
                    print(f"{s}: already has human moves ({study['human_rating']}), skipped")
                    continue
                t0, before = time.monotonic(), len(study["nodes"])
                r = add_human(study, engine, m, functools.partial(explorer.explore, patient=True), rating)
                nodes = study["nodes"]
                cov = [c for _, c in r["covered"]]
                print(f"\n{s} at {rating}: {len(r['branches'])} branches ({len(nodes) - before} new nodes, "
                      f"{r['dropped']} more over the cap), {len(r['curveballs'])} curveballs, {time.monotonic() - t0:.0f} s")
                print(f"  Maia's chance the opponent plays a lesson move: median {sorted(cov)[len(cov) // 2]:.0f}%, "
                      f"min {min(cov):.0f}% over {len(cov)} positions")
                for pid, kid, pct, loss in r["branches"]:
                    line, k, last = [], kid, kid
                    while k is not None:
                        src = nodes[k].get("source")
                        line.append(nodes[k]["san"] + (f"[{src}]" if src != "human" else f"[{nodes[k]['pct']:.0f}%]"))
                        last, k = k, nodes[k]["main"]
                    print(f"  branch after {numbered(_line(nodes, pid))}: {pct:.0f}% play {' '.join(line)}"
                          f"  (costs them {loss / 100:.2f}; line ends {nodes[last]['eval_white']})")
                for pid, san, pct, loss, dup in r["curveballs"]:
                    print(f"  curveball after {numbered(_line(nodes, pid))}: {san}?? {pct:.0f}% "
                          f"(-{loss / 100:.1f}){' — already a Lichess curveball' if dup else ''}")
                if write:
                    save(study)
                    print("  saved")
        finally:
            engine.close()
        sys.stdout.flush()
        os._exit(0)
    if sys.argv[1:2] == ["tag"]:
        slugs = sys.argv[2:] or [f.stem for f in sorted(STUDY_DIR.glob("*.json"))]
        for s in slugs:
            study = json.loads((STUDY_DIR / f"{s}.json").read_text())
            tag_overview(study)
            save(study)
            placed = sum(1 for m in study["moments"] if m["nodes"])
            print(f"{s}: {len(study['moments'])} bullets, {placed} placed on positions")
            for m in study["moments"]:
                where = ", ".join(" ".join(_line(study["nodes"], k)[-2:]) + f" (id {k})" for k in m["nodes"]) or "end of line"
                print(f"  [{m['kind']} #{m['index']}] {m['title']} → {where}")
