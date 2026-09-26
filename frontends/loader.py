"""Resolve a game reference (number, URL, file, raw PGN) to PGN text. Shared by CLI and web."""

import re
from pathlib import Path

from .chesscom import client as chesscom
from .lichess import client as lichess
from .lichess import explorer


def fetch_game_text(ref: str, me: str | None = None) -> str:
    ref = ref.strip()
    ref = ref.lstrip("\ufeff")
    if ref.startswith(("[", "{", "%")) or re.match(r"\d+\.", ref):
        return ref  # raw PGN text
    if len(ref) < 256 and Path(ref).is_file():
        return Path(ref).read_text()
    if ref.startswith("masters:"):  # example game from the explorer's masters database
        return explorer.masters_pgn(ref.split(":", 1)[1])
    if cc_id := chesscom.parse_game_id(ref):
        return chesscom.find_game(cc_id, me)["pgn"]
    if ref.isdigit() and len(ref) <= 3:
        if not me:
            raise ValueError("game numbers refer to your recent chess.com games: set your username")
        games = chesscom.recent_games(me, int(ref))
        if len(games) < int(ref):
            raise ValueError(f"only found {len(games)} recent games for {me}")
        return games[int(ref) - 1]["pgn"]
    if gid := lichess.parse_game_id(ref):
        return lichess.game_pgn(gid)
    raise ValueError(f"'{ref[:60]}' is not a game number, PGN, chess.com URL or Lichess game id/URL")
