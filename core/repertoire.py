"""Known opening traps, found in the user's own collection of opening lines: data/openings.md plus any
data/openings/*.md (drop each new batch in as its own file).

Each file is markdown with sections — a `## Name` / `### Name` header followed by a JSON list of
{"name", "pgn"} objects (only the moves matter for traps; names are shown by browse()). A trap is labelled with the
opening name of the last named position before it (vendored ECO table), so a header like "e4/e5
masterfile" is only the fallback label. Every position in every
line gets an engine eval, and a line contains a *trap* where one side's move throws away at least
TRAP_SWING and leaves the other side at least TRAP_EDGE ahead. Candidates are re-checked at depth
VERIFY_DEPTH, because the quick pass is shallow and gambit lines are where shallow evals go wrong.

What comes out is two lookups keyed by position (EPD), so transpositions match too:
  - before the mistake: the victim is to move and the trap move is on the board ("don't play X"),
  - after the mistake: the setter is to move and the refutation is known ("punish it with Y").

The index (data/openings_index.json) is rebuilt in a background thread whenever a source file changes.
Evals are cached per position (data/openings_evals.json), so adding a batch only evaluates new
positions. Lookups return nothing until the first build finishes. Build by hand: python -m core.repertoire
"""

import hashlib
import json
import re
import sys
import threading
import time
from pathlib import Path

import chess

from core import eco
from core.engine import Engine

DATA = Path(__file__).resolve().parent.parent / "data"
SOURCES = [DATA / "openings.md", DATA / "openings"]   # a file, and a folder of *.md files
INDEX = DATA / "openings_index.json"
EVALS = DATA / "openings_evals.json"

QUICK_SECONDS = 0.15
VERIFY_DEPTH = 20
VERIFY_SECONDS = 3.0
TRAP_SWING = 150       # cp the mistake must throw away (mover's point of view)
TRAP_EDGE = 200        # cp the other side must be ahead afterwards
PUNISH_PLIES = 8       # how much of the line after the mistake is kept as the refutation

_lock = threading.Lock()
_index: dict | None = None
_building = False


def _source_files() -> list[Path]:
    files = []
    for p in SOURCES:
        files += sorted(p.glob("*.md")) if p.is_dir() else [p] if p.exists() else []
    return files


def _source_hash() -> str | None:
    files = _source_files()
    if not files:
        return None
    h = hashlib.sha256()
    for f in files:
        h.update(f.name.encode() + b"\0" + f.read_bytes())
    return h.hexdigest()


GENERIC_LABEL = "from your opening files"


def _label(moves: list[str], fallback: str) -> str:
    """Name of the last named opening position along these moves, else the file's section header —
    but only if that header starts with a real opening family; course titles like "Win EVERY Game as
    Black" or "Full Black Repertoire with 1...Nf6" cover many openings and would mislabel the trap."""
    b, name = chess.Board(), None
    for san in moves:
        b.push_san(san)
        hit = eco.lookup(b)
        if hit:
            name = hit["name"]
    if name:
        return name
    families = {n.split(":")[0].strip().lower() for n in eco.names()}
    return fallback if any(fallback.lower().startswith(f) for f in families) else GENERIC_LABEL


def parse(text: str, default_section: str = "") -> list[dict]:
    """[{section, name, moves (SAN list)}], exact duplicate lines dropped. A line with an illegal or
    unparseable move is cut at that move (the legal part is still useful). Lines before the first
    header (or in a file with none) get `default_section`. `name` is None for "Unnamed Line"."""
    parts = re.split(r"^#+\s*(.+?)\s*$", text, flags=re.M)
    parts = ["", default_section, parts[0]] + parts[1:]
    out, seen = [], set()
    for title, body in zip(parts[1::2], parts[2::2]):
        section = title.rstrip(":").strip()
        for obj in re.findall(r'\{[^{}]*"pgn"[^{}]*\}', body):
            pgn = re.search(r'"pgn"\s*:\s*"([^"]*)"', obj).group(1)
            name = re.search(r'"name"\s*:\s*"([^"]*)"', obj)
            name = name.group(1).strip() if name else ""
            board, moves = chess.Board(), []
            for tok in pgn.split():
                san = re.sub(r"^\d+\.+", "", tok)
                if not san or san in ("1-0", "0-1", "1/2-1/2", "*"):
                    continue
                try:
                    board.push_san(san)
                except ValueError:
                    break
                moves.append(san)
            if moves and tuple(moves) not in seen:
                seen.add(tuple(moves))
                out.append({"section": section, "name": None if name.lower() in ("", "unnamed line") else name,
                            "moves": moves})
    return out


_browse: tuple[str, dict | None, list[dict]] | None = None   # (source hash, trap index used, sections)


def _compact(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _clean_title(title: str) -> str:
    """'sicilian-defense-accelerated-dragon' -> 'Sicilian Defense Accelerated Dragon', 'E4 / E5 MASTERFILE' ->
    'E4 / E5 Masterfile' (only all-letter shouting words, so move names like E4 stay)."""
    if " " not in title and "-" in title:
        title = title.replace("-", " ").title()
    return " ".join(w.capitalize() if len(w) >= 4 and w.isalpha() and w.isupper() else w for w in title.split(" "))


GENERIC_WORDS = {"defense", "defence", "variation", "game", "opening", "system", "line", "the"}


def _short_name(eco_name: str, section: str) -> str:
    """The ECO name without the parts the header already says: under "Scotch Game", "Scotch Game: Classical
    Variation" is "Classical Variation"; under "Sicilian Kan", "Sicilian Defense: Kan Variation, Knight
    Variation" is "Knight Variation"; under "Traxler Counter Attack", "Italian Game: Two Knights Defense,
    Traxler Counterattack, Knight Sacrifice Line" is "Knight Sacrifice Line". A part counts as said when its
    words (minus Defense/Variation/…) are all header words, or it's the header run together. A name the
    header doesn't share stays whole."""
    parts = re.split(r": |, ", eco_name)

    def words_of(text: str) -> list[str]:  # plurals folded: "Practical Sicilians" says "Sicilian"
        return [w[:-1] if len(w) > 3 and w.endswith("s") else w for w in re.findall(r"[a-z0-9]+", text.lower().replace("'", ""))]
    sec, sec_words = _compact(section), set(words_of(section))

    def said(part: str) -> bool:
        words = [w for w in words_of(part) if w not in GENERIC_WORDS]
        return bool(words) and (all(w in sec_words for w in words) or _compact(part) in sec or sec in _compact(part))
    hit = max((i for i, part in enumerate(parts) if said(part)), default=None)
    if hit is None:
        return eco_name
    return ", ".join(parts[hit + 1:]) or parts[hit]


def _numbered(moves: list[str], start: int) -> str:
    """SAN moves from ply `start`, numbered: (4, [Ng5, d5]) -> '3.Ng5 d5'; (5, [d5]) -> '3...d5'."""
    out = []
    for i, san in enumerate(moves, start):
        if i % 2 == 0:
            out.append(f"{i // 2 + 1}.{san}")
        else:
            out.append(f"{i // 2 + 1}...{san}" if not out else san)
    return " ".join(out)


def browse() -> list[dict]:
    """Every line for viewing, grouped twice: by the header it sits under (same title in different files =
    one section; titles tidied), then by its name within that section (the line's own "name", else the
    ECO name shortened against the header):
      [{title, groups: [{label, lines: [{name, eco, moves, trap, div}]}]}]
    `div` tells a group's lines apart without the whole move list: a few moves from where the line leaves
    its closest sibling (None for a group of one). `trap` = {ply, move, punish, setter}, the first known
    trap move along the line (None while the trap index is still being built). A line that is only the
    start of another line in the same section, with no name of its own, is left out."""
    global _browse
    src = _source_hash()
    if src is None:
        return []
    idx = index()
    if _browse and _browse[0] == src and _browse[1] is idx:  # a rebuilt index is a new object
        return _browse[2]
    sections: dict[str, dict] = {}
    for f in _source_files():
        for ln in parse(f.read_text(), f.stem):
            b, eco_name, trap = chess.Board(), None, None
            for i, san in enumerate(ln["moves"]):
                mv = b.parse_san(san)
                if idx and trap is None:
                    hit = next((t for t in idx["by_before"].get(b.epd(), []) if t["uci"] == mv.uci()), None)
                    if hit:
                        trap = {"ply": i, "move": san, "punish": hit["punish"], "setter": hit["setter"]}
                b.push(mv)
                eco_name = (eco.lookup(b) or {}).get("name", eco_name)
            title = _clean_title(ln["section"])
            sec = sections.setdefault(_compact(title), {"title": title, "lines": []})
            sec["lines"].append({"name": ln["name"], "eco": eco_name, "moves": ln["moves"], "trap": trap})

    out = []
    for sec in sections.values():
        starts = {tuple(ln["moves"][:k]) for ln in sec["lines"] for k in range(1, len(ln["moves"]))}
        groups: dict[str, list[dict]] = {}
        for ln in sec["lines"]:
            if ln["name"] is None and tuple(ln["moves"]) in starts:
                continue
            label = ln["name"] or (_short_name(ln["eco"], sec["title"]) if ln["eco"] else _numbered(ln["moves"][:4], 0))
            groups.setdefault(label, []).append(ln)
        for lines in groups.values():
            # move order, so lines that share a start sit together and each label reads as a branch
            lines.sort(key=lambda ln: ln["moves"])
            for i, ln in enumerate(lines):
                if len(lines) == 1:
                    ln["div"] = None
                    continue
                shared = max(_common(ln["moves"], other["moves"]) for other in lines[max(0, i - 1):i + 2] if other is not ln)
                ln["div"] = (f"…{_numbered(ln['moves'][shared:shared + 3], shared)}" if shared < len(ln["moves"])
                             else f"stops at {_numbered(ln['moves'][-1:], len(ln['moves']) - 1)}")
                ln["_at"] = shared
            # shown by where each line branches off (earliest first), the labels are worked out in move order above
            lines.sort(key=lambda ln: (ln.pop("_at", 0), ln["moves"]))
        out.append({"title": sec["title"], "groups": [{"label": k, "lines": v} for k, v in groups.items()]})
    _browse = (src, idx, out)
    return out


def _common(a: list[str], b: list[str]) -> int:
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n


def _load_evals() -> dict[str, int]:
    try:
        return json.loads(EVALS.read_text())
    except (OSError, ValueError):
        return {}


def build(progress=print) -> dict:
    """Evaluate every position in openings.md, find the traps, write and return the index."""
    lines = [ln for f in _source_files() for ln in parse(f.read_text(), f.stem)]
    evals = _load_evals()
    engine = Engine(threads=2, hash_mb=128)  # its own process, so the app's engine stays responsive
    try:
        def cp(board: chess.Board, deep: bool = False) -> int:
            if board.is_game_over():
                return engine.evaluate(board)["cp_white"]
            if deep:
                return engine.lines(board, multipv=1, seconds=VERIFY_SECONDS, depth=VERIFY_DEPTH)[0]["cp_white"]
            key = board.epd()
            if key not in evals:
                evals[key] = engine.lines(board, multipv=1, seconds=QUICK_SECONDS)[0]["cp_white"]
            return evals[key]

        # quick pass: every position once
        todo = {chess.Board().epd()}
        for ln in lines:
            b = chess.Board()
            for san in ln["moves"]:
                b.push_san(san)
                todo.add(b.epd())
        fresh = [e for e in todo if e not in evals]
        progress(f"repertoire: {len(lines)} lines, {len(todo)} positions, {len(fresh)} to evaluate")
        started = time.monotonic()
        for i, ln in enumerate(lines):
            b = chess.Board()
            cp(b)
            for san in ln["moves"]:
                b.push_san(san)
                cp(b)
            if i % 50 == 49:
                progress(f"repertoire: {i + 1}/{len(lines)} lines ({time.monotonic() - started:.0f} s)")
                EVALS.write_text(json.dumps(evals))  # keep progress if the server stops mid-build

        # find the mistake in each line, then confirm it deeper
        traps: dict[str, dict] = {}   # "epd uci" of the mistake -> trap
        verified: dict[str, bool] = {}
        for ln in lines:
            b = chess.Board()
            best = None
            for i, san in enumerate(ln["moves"]):
                before = b.copy(stack=False)
                sign = 1 if b.turn == chess.WHITE else -1
                mv = b.push_san(san)
                lost = sign * (cp(before) - cp(b))
                edge = -sign * cp(b)
                if lost >= TRAP_SWING and edge >= TRAP_EDGE and (best is None or lost > best[0]):
                    best = (lost, i, before, mv)
            if not best:
                continue
            _, i, before, mv = best
            key = f"{before.epd()} {mv.uci()}"
            if key not in verified:
                after = before.copy(stack=False)
                after.push(mv)
                sign = 1 if before.turn == chess.WHITE else -1
                lost, edge = sign * (cp(before, True) - cp(after, True)), -sign * cp(after, True)
                verified[key] = lost >= TRAP_SWING and edge >= TRAP_EDGE
            if not verified[key]:
                continue
            punish = ln["moves"][i + 1:i + 1 + PUNISH_PLIES]
            old = traps.get(key)
            if old is None or len(punish) > len(old["punish"]):
                after = before.copy(stack=False)
                after.push(mv)
                traps[key] = {
                    "section": _label(ln["moves"][:i + 1], ln["section"]),
                    "setter": "black" if before.turn == chess.WHITE else "white",
                    "before": before.epd(), "after": after.epd(),
                    "move": ln["moves"][i], "uci": mv.uci(),
                    "punish": punish,
                    "cp_after_white": cp(after, True),
                    "moves_before": ln["moves"][:i],
                }
        EVALS.write_text(json.dumps(evals))
        index = {"source_hash": _source_hash(), "lines": len(lines), "positions": len(todo),
                 "traps": list(traps.values())}
        INDEX.write_text(json.dumps(index))
        progress(f"repertoire: done, {len(traps)} traps from {len(lines)} lines "
                 f"({time.monotonic() - started:.0f} s)")
        return index
    finally:
        engine.close()


def _start_build() -> None:
    global _building, _index

    def run():
        global _building, _index
        try:
            idx = build()
            with _lock:
                _index = _prepare(idx)
        except Exception as e:  # noqa: BLE001 - a failed build must not take the server down
            print(f"repertoire: build failed: {e}")
        finally:
            _building = False
    _building = True
    threading.Thread(target=run, daemon=True).start()


def _prepare(idx: dict) -> dict:
    by_before: dict[str, list[dict]] = {}
    by_after: dict[str, list[dict]] = {}
    for t in idx["traps"]:
        by_before.setdefault(t["before"], []).append(t)
        by_after.setdefault(t["after"], []).append(t)
    return {**idx, "by_before": by_before, "by_after": by_after}


def index() -> dict | None:
    """The trap index, or None while the first build runs (or with no source files). Changed
    sources keep serving the old index until the rebuild is done."""
    global _index
    with _lock:
        src = _source_hash()
        if src is None:
            return None
        if _index is None and INDEX.exists():
            try:
                _index = _prepare(json.loads(INDEX.read_text()))
            except (OSError, ValueError, KeyError):
                _index = None
        if (_index is None or _index.get("source_hash") != src) and not _building:
            _start_build()
        return _index


def _public(t: dict) -> dict:
    return {k: t[k] for k in ("section", "setter", "move", "uci", "punish", "cp_after_white")}


def before_mistake(board: chess.Board) -> list[dict]:
    """Traps where the side to move can walk into a known losing move right here."""
    idx = index()
    return [_public(t) for t in idx["by_before"].get(board.epd(), [])] if idx else []


def after_mistake(board: chess.Board) -> list[dict]:
    """Traps whose losing move was just played: the side to move has a known refutation."""
    idx = index()
    return [_public(t) for t in idx["by_after"].get(board.epd(), [])] if idx else []


def annotate_game(start_fen: str, moves: list[dict]) -> dict[int, dict]:
    """{ply: note} for a reviewed game. 'fell' marks a trap move that was played; the next ply
    gets 'punished' (the refutation's first move was played) or 'missed' (it wasn't)."""
    idx = index()
    if not idx:
        return {}
    notes: dict[int, dict] = {}
    board = chess.Board(start_fen)
    pending = None
    for m in moves:
        if pending:
            notes[m["ply"]] = {"kind": "punished" if m["uci"] == pending["punish_uci"] else "missed",
                               **_public(pending)}
            pending = None
        hit = next((t for t in idx["by_before"].get(board.epd(), []) if t["uci"] == m["uci"]), None)
        board.push(chess.Move.from_uci(m["uci"]))
        if hit:
            notes[m["ply"]] = {"kind": "fell", **_public(hit)}
            if hit["punish"]:
                pending = {**hit, "punish_uci": board.parse_san(hit["punish"][0]).uci()}
    return notes


if __name__ == "__main__":
    idx = build()
    if "-v" in sys.argv:
        for t in idx["traps"]:
            print(f"{t['section']}: {' '.join(t['moves_before'][-4:])} {t['move']}?? "
                  f"-> {' '.join(t['punish'][:4])} ({t['cp_after_white'] / 100:+.1f})")
