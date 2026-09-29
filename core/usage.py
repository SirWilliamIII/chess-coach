"""Local usage/cost tracking for the coach's own Claude API calls.

Separate from the answer library (core/library.py) on purpose: the library is about searchable
saved answers, only written for non-ambient questions. This is raw telemetry — every real API
call, including ambient opponent commentary and multi-round tool-use exchanges, plus zero-cost
cache hits (recorded as such, so the cache's savings are visible too).

One SQLite file (data/usage.sqlite). Not a substitute for the Anthropic Console's Usage/Cost
pages (the authoritative, account-wide source) — this only ever sees what this app itself sends.
"""

import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "usage.sqlite"

# $ per 1M tokens (input, output), current as of the models this app actually uses. Cache writes
# and reads aren't listed per-model everywhere, so they're approximated off the input rate at the
# standard ~1.25x (write) / ~0.1x (read) ratios — good enough for a local cost estimate, not a bill.
PRICING = {
    "claude-opus-5": (5.00, 25.00),
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-fable-5": (10.00, 50.00),
    "claude-fable-5-1": (10.00, 50.00),
}

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY,
    created_at REAL NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    api_calls INTEGER NOT NULL DEFAULT 1,
    cached INTEGER NOT NULL DEFAULT 0,
    question TEXT
);
"""

_conn: sqlite3.Connection | None = None


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = _connect()
    return _conn


def _cost(model: str, input_tokens: int, output_tokens: int,
          cache_creation_input_tokens: int, cache_read_input_tokens: int) -> float | None:
    rates = PRICING.get(model)
    if not rates:
        return None
    in_rate, out_rate = rates
    return (input_tokens * in_rate + output_tokens * out_rate
            + cache_creation_input_tokens * in_rate * 1.25
            + cache_read_input_tokens * in_rate * 0.1) / 1_000_000


def record(*, model: str, input_tokens: int = 0, output_tokens: int = 0,
           cache_creation_input_tokens: int = 0, cache_read_input_tokens: int = 0,
           api_calls: int = 1, cached: bool = False, question: str = "") -> None:
    """A failure here must never cost the player their answer — callers should swallow errors."""
    with _lock:
        db().execute(
            """INSERT INTO calls (created_at, model, input_tokens, output_tokens,
                   cache_creation_input_tokens, cache_read_input_tokens, api_calls, cached, question)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (time.time(), model, input_tokens, output_tokens, cache_creation_input_tokens,
             cache_read_input_tokens, api_calls, int(cached), (question or "")[:200]))
        db().commit()


def summary(days: int = 30) -> dict:
    """Totals and a per-day breakdown for the last `days` days, plus an estimated cost."""
    since = time.time() - days * 86400
    with _lock:
        rows = db().execute(
            "SELECT * FROM calls WHERE created_at >= ? ORDER BY created_at", (since,)).fetchall()

    totals = {"questions": len(rows), "cached_questions": 0, "api_calls": 0,
              "input_tokens": 0, "output_tokens": 0,
              "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
              "estimated_cost": 0.0, "unpriced_calls": 0}
    by_day: dict[str, dict] = {}
    for r in rows:
        day = time.strftime("%Y-%m-%d", time.localtime(r["created_at"]))
        slot = by_day.setdefault(day, {"questions": 0, "cached_questions": 0, "api_calls": 0,
                                        "input_tokens": 0, "output_tokens": 0, "estimated_cost": 0.0})
        cost = _cost(r["model"], r["input_tokens"], r["output_tokens"],
                     r["cache_creation_input_tokens"], r["cache_read_input_tokens"])
        totals["cached_questions"] += r["cached"]
        totals["api_calls"] += r["api_calls"]
        totals["input_tokens"] += r["input_tokens"]
        totals["output_tokens"] += r["output_tokens"]
        totals["cache_creation_input_tokens"] += r["cache_creation_input_tokens"]
        totals["cache_read_input_tokens"] += r["cache_read_input_tokens"]
        slot["questions"] += 1
        slot["cached_questions"] += r["cached"]
        slot["api_calls"] += r["api_calls"]
        slot["input_tokens"] += r["input_tokens"]
        slot["output_tokens"] += r["output_tokens"]
        if cost is None:
            totals["unpriced_calls"] += 1
        else:
            totals["estimated_cost"] += cost
            slot["estimated_cost"] += cost
    totals["estimated_cost"] = round(totals["estimated_cost"], 4)
    for slot in by_day.values():
        slot["estimated_cost"] = round(slot["estimated_cost"], 4)
    return {"days": days, "totals": totals,
            "by_day": [{"date": d, **v} for d, v in sorted(by_day.items())]}
