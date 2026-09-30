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


def slug(name: str, color: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") + "-" + color


def search(q: str, limit: int = 40) -> list[dict]:
    words = q.lower().split()
    hits = [o for o in openings() if all(w in o["name"].lower() for w in words)] if words \
        else [o for o in openings() if o["name"] in POPULAR]
    hits.sort(key=lambda o: (o["name"] not in POPULAR, len(o["moves"]), o["name"]))
    return [{**o, "default_color": "white" if len(o["moves"]) % 2 else "black",
             "built": [c for c in ("white", "black") if (STUDY_DIR / f"{slug(o['name'], c)}.json").exists()]}
            for o in hits[:limit]]


def load(name: str, color: str) -> dict | None:
    f = STUDY_DIR / f"{slug(name, color)}.json"
    return json.loads(f.read_text()) if f.exists() else None


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

    # the branches: breadth-first from the named position
    frontier = [(trunk_end, 0, 0)]   # node id, plies past the name, opponent branch points so far
    looked = 0
    while frontier and len(nodes) < MAX_NODES:
        nid, depth, opp_branches = frontier.pop(0)
        if depth >= EXTRA_PLIES:
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

    # evals for the pills, and ply numbers
    progress("Checking every position with the engine…")
    for n in nodes.values():
        b = chess.Board(n["fen"])
        n["ply"] = _ply_of(nodes, n)
        n["eval_white"] = engine.evaluate(b, seconds=0.5, depth=16)["eval_white"] if not b.is_game_over() else None
    return {"root": "0", "trunk_end": trunk_end, "nodes": nodes}


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
    STUDY_DIR.mkdir(parents=True, exist_ok=True)
    (STUDY_DIR / f"{study['slug']}.json").write_text(json.dumps(study, indent=1))
    return study


def coach_note(study: dict) -> str:
    """What the coach is told when a study starts (so its answers match the lesson)."""
    o = study["overview"]
    return (f"The player is studying the {study['name']} as {study['color']} in the app's opening "
            f"trainer. The lesson's overview (written from master games and checked by the engine): "
            f"{o['summary']} Key ideas: {'; '.join(o['key_ideas'])}. Pawn breaks: {'; '.join(o['pawn_breaks'])}. "
            f"What to wait for: {'; '.join(o['wait_for'])}. Keep answers consistent with this lesson and "
            f"teach: explain the why, the plans, and what the opponent is trying, not just the moves.")
