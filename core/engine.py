"""Thin wrapper around Stockfish (UCI) via python-chess."""

import math
import os
import shutil

import chess
import chess.engine

MATE_CP = 10_000


def find_stockfish() -> str:
    path = os.environ.get("STOCKFISH_PATH") or shutil.which("stockfish") or "/usr/games/stockfish"
    if not os.path.exists(path):
        raise FileNotFoundError("Stockfish not found; install it or set STOCKFISH_PATH")
    return path


def score_to_cp(score: chess.engine.PovScore, color: chess.Color) -> int:
    """Centipawns from `color`'s point of view, mates clamped to +/-MATE_CP."""
    return score.pov(color).score(mate_score=MATE_CP)


def fmt_score(score: chess.engine.PovScore, color: chess.Color = chess.WHITE) -> str:
    s = score.pov(color)
    if s.is_mate():
        m = s.mate()
        return f"#{m}" if m > 0 else f"#-{-m}"
    return f"{s.score() / 100:+.2f}"


def win_percent(cp: int) -> float:
    """Lichess' eval -> expected score curve, 0..100."""
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def classify(win_drop: float) -> str | None:
    """Lichess-style thresholds on win% lost by the mover."""
    if win_drop >= 30:
        return "blunder"
    if win_drop >= 20:
        return "mistake"
    if win_drop >= 10:
        return "inaccuracy"
    return None


def pv_to_san(board: chess.Board, pv: list[chess.Move], max_len: int = 10) -> str:
    return board.variation_san(pv[:max_len]) if pv else ""


def check_position(board: chess.Board) -> None:
    """Stockfish can crash on impossible positions (e.g. the side not to move in check); refuse them."""
    status = board.status()
    problems = [(chess.STATUS_NO_WHITE_KING, "White has no king"), (chess.STATUS_NO_BLACK_KING, "Black has no king"),
                (chess.STATUS_TOO_MANY_KINGS, "only one king per side"),
                (chess.STATUS_PAWNS_ON_BACKRANK, "pawns can't stand on the first or last rank"),
                (chess.STATUS_OPPOSITE_CHECK, "the side not to move is in check"),
                (chess.STATUS_TOO_MANY_WHITE_PIECES, "White has too many pieces"),
                (chess.STATUS_TOO_MANY_BLACK_PIECES, "Black has too many pieces"),
                (chess.STATUS_TOO_MANY_CHECKERS, "impossible check (too many checkers)"),
                (chess.STATUS_IMPOSSIBLE_CHECK, "impossible check")]
    for flag, msg in problems:
        if status & flag:
            raise ValueError(f"Illegal position: {msg}")


class Engine:
    def __init__(self, path: str | None = None, threads: int | None = None, hash_mb: int = 256):
        self._path = path or find_stockfish()
        self._options = {"Threads": threads or min(4, os.cpu_count() or 1), "Hash": hash_mb}
        self._start()

    def _start(self):
        self._engine = chess.engine.SimpleEngine.popen_uci(self._path)
        self._engine.configure(self._options)

    def _call(self, fn):
        """Run fn(engine); if Stockfish died, restart it once and retry."""
        try:
            return fn(self._engine)
        except chess.engine.EngineTerminatedError:
            try:
                self._engine.close()
            except Exception:
                pass
            self._start()
            return fn(self._engine)

    def close(self):
        try:
            self._engine.quit()
        except chess.engine.EngineTerminatedError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def lines(self, board: chess.Board, multipv: int = 3, seconds: float = 1.0) -> list[dict]:
        """Top engine lines for the side to move."""
        check_position(board)
        if board.is_game_over():
            return []
        infos = self._call(lambda e: e.analyse(board, chess.engine.Limit(time=seconds), multipv=multipv))
        out = []
        for info in infos:
            pv = info.get("pv", [])
            if not pv:
                continue
            out.append({
                "move": board.san(pv[0]),
                "uci": pv[0].uci(),
                "eval_white": fmt_score(info["score"], chess.WHITE),
                "cp_white": score_to_cp(info["score"], chess.WHITE),
                "line": pv_to_san(board, pv),
                "pv": [m.uci() for m in pv[:10]],
                "depth": info.get("depth"),
            })
        return out

    def evaluate(self, board: chess.Board, seconds: float = 0.3) -> dict:
        """Single best line; handles finished games."""
        if board.is_checkmate():
            cp = -MATE_CP if board.turn == chess.WHITE else MATE_CP
            return {"cp_white": cp, "eval_white": "#0", "best": None, "best_uci": None, "line": ""}
        if board.is_game_over():
            return {"cp_white": 0, "eval_white": "0.00", "best": None, "best_uci": None, "line": ""}
        top = self.lines(board, multipv=1, seconds=seconds)[0]
        return {"cp_white": top["cp_white"], "eval_white": top["eval_white"],
                "best": top["move"], "best_uci": top["uci"], "line": top["line"]}

    def threat(self, board: chess.Board, seconds: float = 0.5) -> dict | None:
        """What the side that just moved threatens: let them move again (null move)."""
        if board.is_check() or board.is_game_over():
            return None
        mover = not board.turn
        before = self.evaluate(board, seconds)
        nb = board.copy(stack=False)
        nb.push(chess.Move.null())
        nb = chess.Board(nb.fen())  # drop the null move from history; UCI can't transmit it
        if nb.is_game_over():
            return None
        after = self.evaluate(nb, seconds)
        if after["best"] is None:
            return None
        sign = 1 if mover == chess.WHITE else -1
        gain = sign * (after["cp_white"] - before["cp_white"])
        return {
            "threat_move": after["best"],
            "threat_line": after["line"],
            "gain_cp_if_ignored": gain,
            "serious": gain >= 150,
        }


# Bot strength levels. Stockfish's UCI_Elo bottoms out at 1320, so the lower levels use
# Skill Level plus a shallow depth instead. Ratings are rough guides, not calibrated.
BOT_LEVELS = [
    {"id": 1, "name": "Beginner (~600)", "skill": 0, "depth": 1},
    {"id": 2, "name": "Novice (~800)", "skill": 1, "depth": 2},
    {"id": 3, "name": "Casual (~1000)", "skill": 3, "depth": 4},
    {"id": 4, "name": "Improving (~1200)", "skill": 6, "depth": 6},
    {"id": 5, "name": "Club (~1400)", "elo": 1400},
    {"id": 6, "name": "Strong club (~1700)", "elo": 1700},
    {"id": 7, "name": "Expert (~2000)", "elo": 2000},
    {"id": 8, "name": "Master (~2400)", "elo": 2400},
    {"id": 9, "name": "Full strength", "full": True},
]


class Bot(Engine):
    """A separate Stockfish process for playing, so strength limits never touch analysis."""

    def __init__(self):
        super().__init__(threads=1, hash_mb=64)

    def play(self, board: chess.Board, level_id: int) -> chess.Move:
        level = next((lv for lv in BOT_LEVELS if lv["id"] == level_id), BOT_LEVELS[2])
        if "elo" in level:
            opts = {"Skill Level": 20, "UCI_LimitStrength": True, "UCI_Elo": level["elo"]}
            limit = chess.engine.Limit(time=0.5)
        elif level.get("full"):
            opts = {"Skill Level": 20, "UCI_LimitStrength": False}
            limit = chess.engine.Limit(time=1.5)
        else:
            opts = {"Skill Level": level["skill"], "UCI_LimitStrength": False}
            limit = chess.engine.Limit(depth=level["depth"], time=0.3)
        self._call(lambda e: e.configure(opts))
        check_position(board)
        return self._call(lambda e: e.play(board, limit).move)
