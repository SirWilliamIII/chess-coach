"""Lichess opening explorer: what real players play in a position, by rating band and speed.

Needs a (scope-less) personal token in LICHESS_TOKEN. Every answer is cached on disk, so
positions you've looked at before still work offline.
"""

import hashlib
import json
import os
import threading
from pathlib import Path

import requests

API = "https://explorer.lichess.ovh"
CACHE_DIR = Path(__file__).resolve().parents[2] / "data" / "explorer"
RATING_BANDS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500]  # lower bounds, as Lichess defines them
SPEEDS = ["ultraBullet", "bullet", "blitz", "rapid", "classical", "correspondence"]

_lock = threading.Lock()  # Lichess asks for one request at a time
_memory: dict[str, dict] = {}


def available() -> bool:
    return bool(os.environ.get("LICHESS_TOKEN"))


def _pct(n: int, total: int) -> float:
    return round(100 * n / total, 1) if total else 0.0


def _summarise(raw: dict, db: str) -> dict:
    total = raw.get("white", 0) + raw.get("draws", 0) + raw.get("black", 0)
    moves = []
    for m in raw.get("moves", []):
        n = m["white"] + m["draws"] + m["black"]
        moves.append({
            "san": m["san"], "uci": m["uci"], "games": n,
            "share": _pct(n, total),
            "white": _pct(m["white"], n), "draws": _pct(m["draws"], n), "black": _pct(m["black"], n),
            "avg_rating": m.get("averageRating"),
        })
    games = []
    for g in (raw.get("topGames") or []) + (raw.get("recentGames") or []):
        games.append({
            "id": g["id"], "white": g["white"]["name"], "white_rating": g["white"].get("rating"),
            "black": g["black"]["name"], "black_rating": g["black"].get("rating"),
            "winner": g.get("winner"), "year": g.get("year"), "move": g.get("uci"),
            "url": f"https://lichess.org/{g['id']}",
        })
    return {"db": db, "opening": raw.get("opening"), "total": total, "moves": moves, "games": games[:8]}


def masters_pgn(game_id: str) -> str:
    """PGN of a game from the masters database (these ids aren't regular lichess.org games)."""
    token = os.environ.get("LICHESS_TOKEN")
    try:
        r = requests.get(f"{API}/masters/pgn/{game_id}", timeout=20,
                         headers={"Authorization": f"Bearer {token}"} if token else {})
    except requests.ConnectionError:
        raise RuntimeError("Can't reach the Lichess opening explorer - are you offline?")
    r.raise_for_status()
    return r.text


def explore(fen: str, db: str = "lichess", ratings: list[int] | None = None,
            speeds: list[str] | None = None) -> dict:
    """Move statistics for `fen`. db is 'lichess' (filterable) or 'masters' (OTB games of 2200+ players)."""
    if db not in ("lichess", "masters"):
        raise ValueError("db must be 'lichess' or 'masters'")
    params = {"fen": fen, "moves": 12, "topGames": 4 if db == "masters" else 0}
    if db == "lichess":
        params.update(variant="standard", recentGames=4,
                      ratings=",".join(str(r) for r in sorted(set(ratings or RATING_BANDS)) if r in RATING_BANDS),
                      speeds=",".join(s for s in (speeds or ["blitz", "rapid"]) if s in SPEEDS))
    key = hashlib.sha1(json.dumps([db, params], sort_keys=True).encode()).hexdigest()[:16]
    if key in _memory:
        return _memory[key]
    cached = CACHE_DIR / f"{key}.json"

    token = os.environ.get("LICHESS_TOKEN")
    try:
        if not token:
            raise RuntimeError("The opening explorer needs a Lichess token: add LICHESS_TOKEN to .env.")
        with _lock:
            r = requests.get(f"{API}/{db}", params=params, timeout=20,
                             headers={"Authorization": f"Bearer {token}"})
        if r.status_code == 401:
            raise RuntimeError("Lichess rejected the token in LICHESS_TOKEN; create a new one.")
        if r.status_code == 429:
            raise RuntimeError("The opening explorer is rate limiting us; try again in a minute.")
        r.raise_for_status()
    except (requests.ConnectionError, requests.Timeout, RuntimeError) as e:
        if cached.exists():  # offline (or a hiccup): use what we saw last time
            result = json.loads(cached.read_text())
            result["from_cache"] = True
            return result
        if isinstance(e, RuntimeError):
            raise
        raise RuntimeError("Can't reach the Lichess opening explorer - are you offline? "
                           "Positions you've explored before still work.")

    result = _summarise(r.json(), db)
    result["filters"] = {"ratings": params.get("ratings"), "speeds": params.get("speeds")}
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(result))
    _memory[key] = result
    return result
