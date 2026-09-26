"""Minimal Lichess API client: fetch a user's recent games or a single game as PGN."""

import json
import os
import re

import requests

API = "https://lichess.org"


def _get(url: str, **kwargs) -> requests.Response:
    try:
        return requests.get(url, **kwargs)
    except requests.ConnectionError:
        raise RuntimeError("Can't reach lichess.org - are you offline?")


def _headers(accept: str) -> dict:
    h = {"Accept": accept}
    token = os.environ.get("LICHESS_TOKEN")  # optional; only needed for private games / higher rate limits
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def parse_game_id(ref: str) -> str | None:
    """Accept a bare id or a lichess URL (with or without /white, /black, #ply)."""
    m = re.search(r"lichess\.org/([A-Za-z0-9]{8})", ref)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9]{8}([A-Za-z0-9]{4})?", ref):
        return ref[:8]
    return None


def recent_games(username: str, max_games: int = 10) -> list[dict]:
    r = _get(
        f"{API}/api/games/user/{username}",
        params={"max": max_games, "opening": "true", "moves": "false"},
        headers=_headers("application/x-ndjson"),
        timeout=30,
    )
    if r.status_code in (401, 404) and "Authorization" not in r.request.headers:
        raise RuntimeError(
            "Lichess refused an anonymous game list request. Create a personal API token "
            "(no scopes needed) at https://lichess.org/account/oauth/token and export it as "
            "LICHESS_TOKEN. Reviewing a single game by URL works without one."
        )
    if r.status_code == 429:
        raise RuntimeError("Lichess rate limit hit; wait a minute and try again.")
    r.raise_for_status()
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


def game_pgn(game_id: str) -> str:
    r = _get(
        f"{API}/game/export/{game_id}",
        params={"opening": "true", "clocks": "false", "evals": "false"},
        headers=_headers("application/x-chess-pgn"),
        timeout=30,
    )
    r.raise_for_status()
    return r.text
