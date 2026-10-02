"""Maia-3: a model trained to predict the move a human of a given rating plays (CSSLab, 2026).

Stockfish answers "what's best"; Maia answers "what would a ~1500 actually play here". One model
takes both players' ratings as inputs (Maia-1, tried first, was nine separately trained rating bands
whose answers jumped around from one band to the next). Runs in-process on the GPU (torch's Metal
backend, "mps") under its own lock, so it doesn't compete with Stockfish for the CPU.

Setup: `pip install git+https://github.com/CSSLab/maia3.git` (pulls in torch, ~600 MB). The 5M
checkpoint downloads from Hugging Face on first use into ~/.cache/huggingface. Without the package,
`available()` is False and nothing else changes.
"""

import importlib.util
import random
import threading
from collections import OrderedDict

import chess

MODEL = "maia3-5m"
RATINGS = list(range(600, 2700, 100))  # the model accepts 0-5000; the ends of this range are a guess
CACHE_SIZE = 2048
# Playing: sample by Maia's probabilities (always taking its top move plays above the rating, since the
# most common move is usually sound), but never a move under MIN_PLAY_PCT, so a freak 0.5% move never
# comes up. Not their top_p filter: it also drops the move that crosses the threshold, which cut a
# 22% move at 2400 in testing.
MIN_PLAY_PCT = 2.0
TOP_MOVES = 10  # candidates kept per position: the panel shows 5, play samples from these

# Bot levels when Maia is installed: Maia every 100 points, then full Stockfish (id 9, as in
# engine.BOT_LEVELS, so `Bot.play` handles it). Names keep the "(~N)" the frontend parses.
BOT_LEVELS = [{"id": r, "name": f"Maia (~{r})", "maia": r} for r in range(600, 2600, 100)] + [
    {"id": 9, "name": "Stockfish", "full": True}]


def available() -> bool:
    return importlib.util.find_spec("maia3") is not None


class Maia:
    def __init__(self):
        self._engine = None
        self._lock = threading.Lock()
        self._cache: OrderedDict = OrderedDict()

    def _ensure(self):
        # Loaded lazily: importing torch and warming up the GPU takes ~3 s, and a session may never ask.
        if self._engine is None:
            import torch
            from maia3.uci import Maia3UCIEngine, parse_args
            device = "mps" if torch.backends.mps.is_available() else "cpu"
            # Their UCI engine class, used directly: its UCI output has no move probabilities.
            # --use-uci-history: the model reads the last 8 positions, which changes its answer.
            cfg = parse_args(["--model", MODEL, "--use-uci-history", "--device", device,
                              "--multipv", str(TOP_MOVES), "--temperature", "0"])
            engine = Maia3UCIEngine(cfg)
            engine.ensure_model_loaded()
            self._engine = engine

    def moves(self, board: chess.Board, rating: int = 1500, opp_rating: int | None = None,
              top: int = 5) -> list[dict]:
        """The `top` (max TOP_MOVES) moves a player of ~`rating` (facing ~`opp_rating`) most likely plays here.

        `pct` is the chance a human picks it (0-100), not a quality score. `wdl` is Maia's guess of
        how the game ends for the mover after that move, between humans of these ratings (win/draw/
        loss, 0-100), not an engine eval.
        """
        if board.is_game_over():
            return []
        opp_rating = opp_rating or rating
        history = [m.uci() for m in board.move_stack]
        key = (board.fen(), tuple(history[-8:]), rating, opp_rating)  # history changes the answer
        with self._lock:  # one model; the cache is shared by request threads too
            hit = self._cache.get(key)
            if hit is not None:
                self._cache.move_to_end(key)
                return hit[:top]
            self._ensure()
            e = self._engine
            e.cmd_position(f"position fen {board.root().fen()}" + (f" moves {' '.join(history)}" if history else ""))
            e.self_elo, e.oppo_elo = rating, opp_rating
            _, scored = e.score_moves()
            out = [{"move": board.san(t["move"]), "uci": t["move"].uci(), "pct": round(100 * t["policy"], 2),
                    "wdl": [x / 10 for x in t["wdl"]]} for t in scored]
            self._cache[key] = out
            while len(self._cache) > CACHE_SIZE:
                self._cache.popitem(last=False)
            return out[:top]

    def play(self, board: chess.Board, rating: int, opp_rating: int | None = None) -> chess.Move:
        """A move as a ~`rating` player would choose it: random, weighted by Maia's probabilities."""
        cands = self.moves(board, rating, opp_rating, top=TOP_MOVES)
        pool = [c for c in cands if c["pct"] >= MIN_PLAY_PCT] or cands[:1]
        pick = random.choices(pool, weights=[c["pct"] for c in pool])[0]
        return chess.Move.from_uci(pick["uci"])
