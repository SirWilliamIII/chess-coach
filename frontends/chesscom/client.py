"""Chess.com published-data API client (public, no account or token needed)."""

import re

import requests

API = "https://api.chess.com/pub"
# chess.com rejects requests without a descriptive User-Agent
HEADERS = {"User-Agent": "chess-coach/0.1 (personal game review tool)"}


def _get(url: str) -> dict:
    try:
        r = requests.get(url, headers=HEADERS, timeout=30)
    except requests.ConnectionError:
        raise RuntimeError("Can't reach chess.com - are you offline? Games you've opened before still work.")
    if r.status_code == 404:
        raise RuntimeError(f"chess.com: not found ({url}) - check the username")
    if r.status_code == 429:
        raise RuntimeError("chess.com rate limit hit; wait a minute and try again.")
    r.raise_for_status()
    return r.json()


def opening_from_url(url: str) -> str:
    """'.../Nimzo-Indian-Defense-5...O-O-6.e3-c5' -> 'Nimzo Indian Defense 5...O-O 6.e3 c5'"""
    slug = url.rstrip("/").rsplit("/", 1)[-1]
    slug = slug.replace("O-O-O", "\0").replace("O-O", "\1")
    return slug.replace("-", " ").replace("\0", "O-O-O").replace("\1", "O-O")


def parse_game_id(ref: str) -> str | None:
    """Game id from a chess.com game URL: /game/live/<id>, /live/game/<id>, /analysis/game/live/<id>/review, daily..."""
    m = re.search(r"chess\.com/(?:[a-z]+/)*?(?:live|daily)/(?:game/)?(\d+)", ref)
    return m.group(1) if m else None


def recent_games(username: str, max_games: int = 10, max_months: int = 3) -> list[dict]:
    """Most recent standard-chess games first, walking back through monthly archives."""
    archives = _get(f"{API}/player/{username.lower()}/games/archives")["archives"]
    games: list[dict] = []
    for url in reversed(archives[-max_months:]):
        month = [g for g in _get(url)["games"] if g.get("rules") == "chess" and g.get("pgn")]
        games.extend(sorted(month, key=lambda g: g.get("end_time", 0), reverse=True))
        if len(games) >= max_games:
            break
    return games[:max_games]


def game_players(game_id: str) -> list[str]:
    """Usernames in a live game, via the (unofficial) endpoint chess.com's own site uses."""
    try:
        r = requests.get(f"https://www.chess.com/callback/live/game/{game_id}", headers=HEADERS, timeout=30)
        r.raise_for_status()
        h = r.json()["game"]["pgnHeaders"]
        return [h["White"], h["Black"]]
    except (requests.RequestException, KeyError, ValueError):
        return []


def find_game(game_id: str, username: str | None = None, max_months: int = 6) -> dict:
    """Full game (with PGN) from the public archives of one of its players."""
    candidates = [u for u in [username, *game_players(game_id)] if u]
    if not candidates:
        raise RuntimeError(f"couldn't identify the players of game {game_id}; add --me <your chess.com name>")
    for user in dict.fromkeys(c.lower() for c in candidates):
        try:
            games = recent_games(user, max_games=10_000, max_months=max_months)
        except RuntimeError:
            continue
        for g in games:
            if g["url"].rstrip("/").endswith(game_id):
                return g
    raise RuntimeError(f"game {game_id} not found in the last {max_months} months of {', '.join(candidates)}'s games")
