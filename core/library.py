"""The chat library: every coach answer, saved with its position and auto-tags, searchable offline.

One SQLite file (data/library.sqlite) with a full-text index over questions, answers, habits,
tags and game names.
"""

import json
import re
import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "library.sqlite"

# Chess patterns worth tagging when an answer mentions them (lower case; matched as whole words).
PATTERNS = [
    "back rank", "pin", "fork", "skewer", "x-ray", "discovered attack", "discovered check",
    "deflection", "decoy", "removing the defender", "overloaded", "zwischenzug", "zugzwang",
    "opposition", "outpost", "passed pawn", "isolated pawn", "fianchetto", "gambit", "sacrifice",
    "trap", "mating net", "back-rank mate", "smothered mate", "stalemate", "promotion",
    "king safety", "open file", "battery", "tempo", "luft", "endgame", "opening", "castling",
]

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    created_at REAL NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    kind TEXT,                -- 'question' or 'gm alert'
    mode TEXT,                -- review / replay / play / analysis / demo
    fen TEXT,                 -- the position the answer is about
    game_id TEXT,             -- saved review it belongs to, if any
    game_label TEXT,          -- "sirwill3rd vs X"
    position_label TEXT,      -- "After 35. Nf5"
    ply INTEGER,              -- game position: after this many game plies ...
    extra TEXT,               -- ... plus these moves (JSON list)
    opening TEXT,
    habit TEXT,               -- the "Habit to build" line, if any
    special TEXT,             -- the red "Special" alert, if any
    tags TEXT,                -- space-separated, e.g. "back-rank sacrifice habit"
    demos TEXT,               -- JSON: the Show me demos
    tools TEXT,               -- JSON: what the coach checked
    starred INTEGER NOT NULL DEFAULT 0,
    audience TEXT,            -- legacy: coach voice this was answered under, back when voices were
                              -- separate selectable personas; unused now the coach reads the
                              -- question itself instead, kept only so old rows stay readable
    prompt_hash TEXT,         -- hash of the prompt files in effect when answered (cache invalidation)
    player_color TEXT,       -- white/black/NULL as the coach understood it when answered (cache key:
                              -- the phrasing throughout leans on "your plan" vs "their threat", so a
                              -- wrong or unknown color at answer time makes it a genuinely different answer
    quiz TEXT,                -- JSON: the move_quiz options/correct/reward, if any
    jump TEXT                 -- JSON: list of jump_to_move {ply}, if any
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    question, answer, habit, tags, opening, game_label,
    content='entries', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, question, answer, habit, tags, opening, game_label)
    VALUES (new.id, new.question, new.answer, new.habit, new.tags, new.opening, new.game_label);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, question, answer, habit, tags, opening, game_label)
    VALUES ('delete', old.id, old.question, old.answer, old.habit, old.tags, old.opening, old.game_label);
END;
"""


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(entries)")}
    for col in ("audience", "prompt_hash", "player_color", "quiz", "jump"):
        if col not in cols:
            conn.execute(f"ALTER TABLE entries ADD COLUMN {col} TEXT")
    conn.commit()
    return conn


_conn: sqlite3.Connection | None = None


def db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = _connect()
    return _conn


def extract_habit(answer: str) -> str | None:
    m = re.search(r"^\s*\**habit to build:?\**:?\s*(.+?)(?:\n\s*\n|\Z)", answer, re.I | re.M | re.S)
    return " ".join(m.group(1).split()) if m else None


def extract_special(answer: str) -> str | None:
    quote = [ln.lstrip("> ").strip() for ln in answer.splitlines() if ln.lstrip().startswith(">")]
    return " ".join(quote).replace("**", "") or None


def auto_tags(question: str, answer: str, tools: list[dict], kind: str, opening: str | None) -> list[str]:
    text = f"{question}\n{answer}".lower()
    tags = {p.replace(" ", "-") for p in PATTERNS if re.search(rf"\b{re.escape(p)}\b", text)}
    if "back-rank-mate" in tags:
        tags.add("back-rank")
    if re.search(r"#\d|mate in \d|checkmate", text):
        tags.add("mate")
    names = {t.get("name") for t in tools}
    if "find_tricks" in names:
        tags.add("tactics")
    if names & {"opening_lines", "opening_explorer"}:
        tags.add("opening")
    if extract_habit(answer):
        tags.add("habit")
    if extract_special(answer):
        tags.add("special")
    if kind == "gm alert":
        tags.add("gm-moment")
    if opening:  # "Sicilian Defense: Najdorf Variation" -> "sicilian"
        tags.add(opening.split(":")[0].split()[0].lower())
    return sorted(tags)


def add(*, question: str, answer: str, kind: str = "question", mode: str | None = None,
        fen: str | None = None, game_id: str | None = None, game_label: str | None = None,
        position_label: str | None = None, ply: int | None = None, extra: list[str] | None = None,
        opening: str | None = None, demos: list | None = None, tools: list | None = None,
        prompt_hash: str | None = None, player_color: str | None = None, quiz: dict | None = None,
        jumps: list | None = None) -> int:
    tools = tools or []
    habit, special = extract_habit(answer), extract_special(answer)
    tags = auto_tags(question, answer, tools, kind, opening)
    with _lock:
        cur = db().execute(
            """INSERT INTO entries (created_at, question, answer, kind, mode, fen, game_id, game_label,
                   position_label, ply, extra, opening, habit, special, tags, demos, tools,
                   prompt_hash, player_color, quiz, jump)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (time.time(), question, answer, kind, mode, fen, game_id, game_label, position_label, ply,
             json.dumps(extra or []), opening, habit, special, " ".join(tags),
             json.dumps(demos or []), json.dumps(tools), prompt_hash, player_color,
             json.dumps(quiz) if quiz else None, json.dumps(jumps) if jumps else None))
        db().commit()
        return cur.lastrowid


def find_cached(question: str, fen: str, prompt_hash: str, player_color: str | None) -> dict | None:
    """An exact-match reuse of a past answer: same question text, same position, the prompt files
    haven't changed since, and the coach understood the player's color the same way — the coach's
    phrasing leans on "your plan" vs "their threat" throughout, so a wrong or unknown color at
    answer time makes it a genuinely different answer, not just a stale one."""
    with _lock:
        r = db().execute(
            """SELECT * FROM entries WHERE question = ? AND fen = ? AND prompt_hash = ?
               AND player_color IS ? ORDER BY created_at DESC LIMIT 1""",
            (question, fen, prompt_hash, player_color)).fetchone()
    if not r:
        return None
    return {"id": r["id"], "answer": r["answer"],
            "tools": json.loads(r["tools"] or "[]"), "demos": json.loads(r["demos"] or "[]"),
            "quiz": json.loads(r["quiz"]) if r["quiz"] else None,
            "jumps": json.loads(r["jump"]) if r["jump"] else []}


def _fts_query(q: str) -> str:
    # user text -> safe FTS5 query: each word as a prefix term, all required
    words = re.findall(r"[\w-]+", q.lower())
    return " ".join(f'"{w}"*' for w in words)


def search(q: str = "", tag: str | None = None, starred: bool = False, habits: bool = False,
           limit: int = 50) -> list[dict]:
    where, args = [], []
    if q.strip():
        where.append("e.id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)")
        args.append(_fts_query(q))
    if tag:
        where.append("(' ' || e.tags || ' ') LIKE ?")
        args.append(f"% {tag} %")
    if starred:
        where.append("e.starred = 1")
    if habits:
        where.append("e.habit IS NOT NULL")
    sql = "SELECT * FROM entries e" + (" WHERE " + " AND ".join(where) if where else "") \
          + " ORDER BY e.starred DESC, e.created_at DESC LIMIT ?"
    with _lock:
        rows = db().execute(sql, (*args, limit)).fetchall()
    return [_summary(r) for r in rows]


def _summary(r: sqlite3.Row) -> dict:
    answer = r["answer"]
    snippet = re.sub(r"[>*#`]", "", answer.split("\n\n")[0])[:220]
    return {"id": r["id"], "created_at": r["created_at"], "question": r["question"], "snippet": snippet,
            "kind": r["kind"], "mode": r["mode"], "game_label": r["game_label"],
            "position_label": r["position_label"], "habit": r["habit"], "special": r["special"],
            "tags": (r["tags"] or "").split(), "starred": bool(r["starred"])}


def get(entry_id: int) -> dict | None:
    with _lock:
        r = db().execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if not r:
        return None
    out = dict(r)
    out["extra"] = json.loads(r["extra"] or "[]")
    out["demos"] = json.loads(r["demos"] or "[]")
    out["tools"] = json.loads(r["tools"] or "[]")
    out["jumps"] = json.loads(r["jump"]) if r["jump"] else []
    out["tags"] = (r["tags"] or "").split()
    out["starred"] = bool(r["starred"])
    return out


def set_star(entry_id: int, starred: bool) -> None:
    with _lock:
        db().execute("UPDATE entries SET starred = ? WHERE id = ?", (int(starred), entry_id))
        db().commit()


def delete(entry_id: int) -> None:
    with _lock:
        db().execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        db().commit()


def tag_counts(limit: int = 30) -> list[dict]:
    with _lock:
        rows = db().execute("SELECT tags FROM entries").fetchall()
    counts: dict[str, int] = {}
    for r in rows:
        for t in (r["tags"] or "").split():
            counts[t] = counts.get(t, 0) + 1
    return [{"tag": t, "count": n} for t, n in sorted(counts.items(), key=lambda x: -x[1])[:limit]]
