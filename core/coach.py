"""LLM coach: Claude answers questions about a reviewed game, grounded by engine tools."""

import json
import os
import re
from pathlib import Path

import anthropic
import chess

from . import features, openings, tricks
from .engine import Engine

MODEL = os.environ.get("COACH_MODEL", "claude-opus-5")

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"


def audiences() -> list[str]:
    return sorted(f.stem for f in (PROMPTS / "audiences").glob("*.md"))


def system_prompt(audience: str = "coach") -> str:
    """prompts/coach.md + prompts/audiences/<audience>.md, re-read every call so edits apply live."""
    if audience not in audiences():
        audience = "coach"
    files = [PROMPTS / "coach.md", PROMPTS / "player.md", PROMPTS / "audiences" / f"{audience}.md"]
    parts = [f.read_text() for f in files if f.exists()]
    text = "\n\n".join(re.sub(r"<!--.*?-->", "", part, flags=re.S).strip() for part in parts)
    return text

TOOLS = [
    {
        "name": "move_report",
        "description": (
            "Full report on the move played at a given ply: evaluation before/after, how much "
            "it cost, the engine's top 3 alternatives, the engine continuation after the played "
            "move (the likely 'plan'), concrete effects of the move (attacks, pins, structure), "
            "and what the mover threatens next. Use this first for any question about a specific move."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"ply": {"type": "integer", "description": "Ply of the move (1 = White's first move)"}},
            "required": ["ply"],
        },
    },
    {
        "name": "compare_moves",
        "description": (
            "Compare candidate moves in the position before a given ply (e.g. the move played vs "
            "the engine's choice vs a move the player asks about). For each move returns the "
            "evaluation, engine continuation, concrete effects and threats. Moves in SAN."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "ply": {"type": "integer", "description": "Ply whose starting position to use"},
                "moves": {"type": "array", "items": {"type": "string"}, "description": "Candidate moves in SAN"},
                "then_moves": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Optional SAN moves to play from that position before comparing",
                },
            },
            "required": ["ply", "moves"],
        },
    },
    {
        "name": "analyze_position",
        "description": (
            "Engine lines plus structural facts (material, pawn structure, king safety, loose "
            "pieces, outposts, open files) for the position before a given ply, optionally after "
            "playing extra hypothetical moves from there. Use for 'what's going on here' and "
            "'what if' questions that go beyond one move."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "ply": {"type": "integer", "description": "Ply whose starting position to use (0 = initial position)"},
                "then_moves": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Optional SAN moves to play from that position first",
                },
                "multipv": {"type": "integer", "description": "Number of engine lines, 1-5 (default 3)"},
            },
            "required": ["ply"],
        },
    },
    {
        "name": "find_tricks",
        "description": (
            "Look past the engine's top line: scans the candidate moves in a position for sacrifices, "
            "traps (the natural greedy reply loses) and high-risk/high-reward tries. For each it gives "
            "the eval against the best defence, the material offered, and what happens if the opponent "
            "takes the bait. Use it whenever you discuss what to play, not just when asked for tricks."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "ply": {"type": "integer", "description": "Ply whose starting position to use (as for analyze_position)"},
                "then_moves": {"type": "array", "items": {"type": "string"},
                               "description": "Optional SAN moves to play from that position first"},
            },
            "required": ["ply"],
        },
    },
    {
        "name": "show_on_board",
        "description": (
            "Attach an interactive demonstration to your answer. The player gets a 'Show me' button "
            "that plays these moves on a separate practice board, with your note shown for each move. "
            "Moves are checked for legality; fix and retry if you get an error. The position is given "
            "the same way as for analyze_position (ply, plus optional then_moves to reach it)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short label for the button, e.g. 'The Rb4+ trade'"},
                "ply": {"type": "integer", "description": "Ply whose starting position the demo begins from"},
                "then_moves": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Optional SAN moves to reach the demo's starting position from that ply",
                },
                "moves": {
                    "type": "array", "items": {"type": "string"},
                    "description": "The demonstrated line in SAN, 1-12 moves",
                },
                "notes": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Optional one-line comment per move (same length as moves; use '' to skip one)",
                },
            },
            "required": ["title", "ply", "moves"],
        },
    },
]


EXPLORER_TOOL = {
    "name": "opening_explorer",
    "description": (
        "Real-game statistics for a position from the Lichess opening explorer: which moves players "
        "actually chose, how often, and how they scored (white/draw/black %), plus the opening name. "
        "db='lichess' covers online games filterable by rating band; db='masters' covers over-the-board "
        "games of strong players. Lichess ratings run roughly 300-400 points above chess.com ratings "
        "at club level, so a ~850 chess.com player compares best with the 1200-1400 bands."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "ply": {"type": "integer", "description": "Ply whose starting position to use (as for analyze_position)"},
            "then_moves": {"type": "array", "items": {"type": "string"},
                           "description": "Optional SAN moves to play from that position first"},
            "db": {"type": "string", "enum": ["lichess", "masters"], "description": "Default lichess"},
            "ratings": {
                "type": "array", "items": {"type": "integer", "enum": [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500]},
                "description": "Lichess rating bands (lower bounds) to include; default all",
            },
            "speeds": {
                "type": "array", "items": {"type": "string", "enum": ["bullet", "blitz", "rapid", "classical"]},
                "description": "Time controls to include; default blitz and rapid",
            },
        },
        "required": ["ply"],
    },
}


OPENING_LINES_TOOL = {
    "name": "opening_lines",
    "description": (
        "Map the opening tree from a position using real games: at each turn it follows the replies "
        "players actually choose (at least ~15% of games, up to 3 per position, a few moves deep) and "
        "returns the resulting main lines with their opening names, popularity and results. Use it for "
        "'show me the main lines', 'how do I play the X properly', or learning an opening. To study a "
        "named opening from another position, pass the moves that reach it in then_moves (from ply 0 "
        "for the initial position); the returned start_opening name confirms you reached the right one."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "ply": {"type": "integer", "description": "Ply whose starting position to use (0 = initial position)"},
            "then_moves": {"type": "array", "items": {"type": "string"},
                           "description": "Optional SAN moves to reach the opening's position first"},
            "depth": {"type": "integer", "description": "Plies to follow, 2-10 (default 6)"},
            "db": {"type": "string", "enum": ["masters", "lichess"],
                   "description": "masters = established theory (default); lichess = what players at a rating play"},
            "ratings": {"type": "array", "items": {"type": "integer"},
                        "description": "Lichess rating bands when db=lichess"},
        },
        "required": ["ply"],
    },
}


def _final_answer(parts: list[str]) -> str:
    """The coach's text across tool calls. A full final message stands alone (earlier bits are
    usually 'let me check…' narration); a short one is a wrap-up after demos, so the substantial
    text written before the tools is kept with it."""
    if not parts:
        return ""
    if len(parts[-1]) >= 400:
        return parts[-1]
    return "\n\n".join([p for p in parts[:-1] if len(p) >= 200] + [parts[-1]])


class Coach:
    def __init__(self, review: dict, engine: Engine, player: str | None = None, explorer=None):
        """`explorer(fen, db, ratings, speeds) -> dict` enables the opening_explorer tool."""
        self.explorer = explorer
        self.tools = TOOLS + ([EXPLORER_TOOL, OPENING_LINES_TOOL] if explorer else [])
        self.review = review
        self.engine = engine
        self._client = None
        self.messages: list[dict] = []
        self.last_demos: list[dict] = []  # show_on_board demos created during the latest ask()
        self.progress: list[dict] = []    # tools called so far in the current ask(), for live progress
        self.player_color = None
        if player:
            p = player.lower()
            if review["white"].lower() == p:
                self.player_color = "white"
            elif review["black"].lower() == p:
                self.player_color = "black"
        self._intro = self._game_context()

    # ---------- context ----------

    def _game_context(self) -> str:
        r = self.review
        if not r["moves"] and r.get("note"):
            return f"# Session\n{r['note']}"
        if not r["moves"]:
            return ("# Session\nNo game is loaded: the player is using a free analysis board, starting from "
                    f"FEN `{r['start_fen']}`. Moves they try on the board are given with each question.")
        you = {"white": " (the player)", "black": ""} if self.player_color == "white" else \
              {"white": "", "black": " (the player)"} if self.player_color == "black" else {"white": "", "black": ""}
        lines = [
            "# Game being discussed",
            f"- **White:** {r['white']} ({r['white_elo'] or '?'}){you['white']}",
            f"- **Black:** {r['black']} ({r['black_elo'] or '?'}){you['black']}",
            f"- **Result:** {r['result']}   **Opening:** {r['opening'] or 'unknown'}   "
            f"**Time control:** {r['time_control'] or '?'}",
        ]
        if r.get("note"):
            lines += ["", r["note"]]
        lines += ["", "## Moves (engine review)", "",
                  "| Ply | Move | Eval after (White POV) | Engine best | Verdict |",
                  "|---|---|---|---|---|"]
        for m in r["moves"]:
            verdict = m["class"] or ("best" if m["played_best"] else "")
            lines.append(f"| {m['ply']} | {m['label']} {m['san']} | {m['eval_after']} | {m['best'] or '-'} | {verdict} |")
        return "\n".join(lines)

    # ---------- tools ----------

    def _board_at(self, ply: int) -> chess.Board:
        """Position before the move at `ply`; ply 0 is the start, len+1 the final position."""
        moves = self.review["moves"]
        if ply == 0:
            return chess.Board(self.review["start_fen"])
        if not 1 <= ply <= len(moves) + 1:
            raise ValueError(f"ply must be between 0 and {len(moves) + 1}")
        if ply == len(moves) + 1:
            return chess.Board(moves[-1]["fen_after"] if moves else self.review["start_fen"])
        return chess.Board(moves[ply - 1]["fen_before"])

    def _candidate(self, board: chess.Board, move: chess.Move) -> dict:
        after = board.copy(stack=False)
        after.push(move)
        cont = self.engine.lines(after, multipv=1, seconds=1.0)
        res = {"effects": features.move_effects(board, move)}
        if cont:
            res["eval_after_white_pov"] = cont[0]["eval_white"]
            res["engine_continuation"] = cont[0]["line"]
        elif after.is_checkmate():
            res["eval_after_white_pov"] = "checkmate"
        else:
            res["eval_after_white_pov"] = "game over (draw)"
        threat = self.engine.threat(after)
        if threat:
            # A "threat" the mover could already have played wasn't created by this move.
            try:
                threat["already_possible_before_move"] = board.is_legal(board.parse_san(threat["threat_move"]))
            except ValueError:
                threat["already_possible_before_move"] = False
        res["next_move_threat"] = threat
        return res

    def move_report(self, ply: int) -> dict:
        moves = self.review["moves"]
        if not 1 <= ply <= len(moves):
            raise ValueError(f"ply must be between 1 and {len(moves)}")
        m = moves[ply - 1]
        board = chess.Board(m["fen_before"])
        move = chess.Move.from_uci(m["uci"])
        report = {
            "move": f"{m['label']} {m['san']}",
            "played_by": m["color"],
            "eval_before_white_pov": m["eval_before"],
            "verdict": m["class"] or ("engine's top choice" if m["played_best"] else "fine"),
            "win_pct_lost_by_mover": m["win_pct_lost"],
            "engine_top_moves_before": self.engine.lines(board, multipv=3, seconds=1.5),
            "played_move": self._candidate(board, move),
        }
        if not m["played_best"] and m["best"]:
            best = board.parse_san(m["best"])
            report["engine_best_move"] = {"move": m["best"], **self._candidate(board, best)}
        return report

    def _position(self, ply: int, then_moves: list[str] | None) -> tuple[chess.Board, list[str]]:
        board = self._board_at(ply)
        played = []
        for san in then_moves or []:
            try:
                mv = board.parse_san(san)
            except ValueError:
                raise ValueError(f"{san!r} is illegal after {' '.join(played) or 'that position'}")
            played.append(board.san(mv))
            board.push(mv)
        return board, played

    def compare_moves(self, ply: int, moves: list[str], then_moves: list[str] | None = None) -> dict:
        board, played = self._position(ply, then_moves)
        out = {"position": f"ply {ply}" + (f" then {' '.join(played)}" if played else "")
                           + f", {features.COLOR_NAME[board.turn]} to move", "candidates": []}
        for san in moves[:5]:
            try:
                mv = board.parse_san(san)
            except ValueError:
                out["candidates"].append({"move": san, "error": "illegal or ambiguous in this position"})
                continue
            out["candidates"].append({"move": board.san(mv), **self._candidate(board, mv)})
        return out

    def analyze_position(self, ply: int, then_moves: list[str] | None = None, multipv: int = 3) -> dict:
        board, played = self._position(ply, then_moves)
        return {
            "moves_played_from_ply": played,
            "engine_lines": self.engine.lines(board, multipv=max(1, min(5, multipv)), seconds=1.5),
            "facts": features.describe(board),
        }

    def show_on_board(self, title: str, ply: int, moves: list[str], then_moves: list[str] | None = None,
                      notes: list[str] | None = None) -> dict:
        board, setup = self._position(ply, then_moves)
        start_fen = board.fen()
        line = []
        for san in moves[:12]:
            try:
                mv = board.parse_san(san)
            except ValueError:
                raise ValueError(f"{san!r} is illegal after {' '.join(setup + line) or 'the starting position'}")
            line.append(board.san(mv))
            board.push(mv)
        if not line:
            raise ValueError("a demo needs at least one move")
        notes = [str(n) for n in (notes or [])][:len(line)]
        notes += [""] * (len(line) - len(notes))
        self.last_demos.append({"title": title[:80], "ply": ply, "then_moves": setup,
                                "start_fen": start_fen, "moves": line, "notes": notes})
        return {"ok": True, "demo": len(self.last_demos), "moves": line}

    def opening_explorer(self, ply: int, then_moves: list[str] | None = None, db: str = "lichess",
                         ratings: list[int] | None = None, speeds: list[str] | None = None) -> dict:
        board, played = self._position(ply, then_moves)
        try:
            data = self.explorer(board.fen(), db, ratings, speeds)
        except RuntimeError as e:
            raise ValueError(str(e))
        to_move = features.COLOR_NAME[board.turn]
        return {
            "position": f"ply {ply}" + (f" then {' '.join(played)}" if played else "") + f", {to_move} to move",
            "opening": data.get("opening"),
            "total_games": data["total"],
            "moves": [
                {"move": m["san"], "games": m["games"], "played_pct": m["share"],
                 "white_win_pct": m["white"], "draw_pct": m["draws"], "black_win_pct": m["black"],
                 "avg_rating": m["avg_rating"]}
                for m in data["moves"][:8]
            ],
            "filters": data.get("filters"),
            "from_offline_cache": data.get("from_cache", False),
        }

    def opening_lines(self, ply: int, then_moves: list[str] | None = None, depth: int = 6,
                      db: str = "masters", ratings: list[int] | None = None) -> dict:
        board, played = self._position(ply, then_moves)
        data = openings.main_lines(self.explorer, board, depth, db, ratings)
        for line in data["main_lines"]:
            line.pop("steps")  # per-move stats are for the page's demos; the coach has enough
        return {
            "position": f"ply {ply}" + (f" then {' '.join(played)}" if played else ""),
            **data,
            "note": "share_of_games_pct: how often games from this position follow the whole line."
                    + (" The explorer was busy, so some lines are shorter or unnamed." if data["partial"] else ""),
        }

    def _run_tool(self, name: str, args: dict) -> str:
        if name == "move_report":
            result = self.move_report(int(args["ply"]))
        elif name == "compare_moves":
            result = self.compare_moves(int(args["ply"]), list(args["moves"]), args.get("then_moves"))
        elif name == "find_tricks":
            board, played = self._position(int(args["ply"]), args.get("then_moves"))
            result = {"position": f"ply {args['ply']}" + (f" then {' '.join(played)}" if played else ""),
                      **tricks.find(self.engine, board)}
        elif name == "show_on_board":
            result = self.show_on_board(str(args["title"]), int(args["ply"]), list(args["moves"]),
                                        args.get("then_moves"), args.get("notes"))
        elif name == "opening_lines" and self.explorer:
            result = self.opening_lines(int(args["ply"]), args.get("then_moves"), int(args.get("depth", 6)),
                                        args.get("db", "masters"), args.get("ratings"))
        elif name == "opening_explorer" and self.explorer:
            result = self.opening_explorer(int(args["ply"]), args.get("then_moves"), args.get("db", "lichess"),
                                           args.get("ratings"), args.get("speeds"))
        elif name == "analyze_position":
            result = self.analyze_position(int(args["ply"]), args.get("then_moves"), int(args.get("multipv", 3)))
        else:
            raise ValueError(f"unknown tool {name}")
        return json.dumps(result)

    # ---------- chat ----------

    def board_context(self, after_ply: int, extra_moves: list[str]) -> str:
        """Describe what the web board shows: the game after `after_ply`, plus moves tried on top."""
        moves = self.review["moves"]
        board, played = self._position(after_ply + 1, extra_moves)
        to_move = features.COLOR_NAME[board.turn]
        if after_ply == 0:
            where = "the starting position"
        else:
            m = moves[after_ply - 1]
            where = f"the game position after {m['label']} {m['san']} (ply {after_ply})"
        if played:
            how = "these moves were played in the practice game" if self.review.get("note") else \
                "the player tried these moves on the board"
            where += f", then {how}: {' '.join(played)}"
            last = f"the last move tried ({played[-1]})"
        elif after_ply:
            last = f"{moves[after_ply - 1]['label']} {moves[after_ply - 1]['san']} (move_report ply {after_ply})"
        else:
            last = "none"
        args = f"ply={after_ply + 1}" + (f", then_moves={json.dumps(played)}" if played else "")
        return ("## Board now\n"
                f"- **Position:** {where}\n"
                f"- **To move:** {to_move}\n"
                f"- **\"This move\" means:** {last}\n"
                f"- **FEN:** `{board.fen()}`\n"
                f"- **For tools:** {args}\n")

    def ask(self, question: str, focus_ply: int | None = None, on_tool=None, context: str | None = None,
            audience: str = "coach") -> str:
        text = question
        if context:
            text = f"{context}\n## Question\n{question}"
        elif focus_ply:
            m = self.review["moves"][focus_ply - 1]
            text = f"[Player is looking at ply {focus_ply}: {m['label']} {m['san']}]\n{question}"
        if not self.messages:
            text = f"{self._intro}\n\n{text}"
        self.messages.append({"role": "user", "content": text})
        self.last_demos = []
        self.progress = []

        parts: list[str] = []  # text written between tool calls counts as part of the answer
        while True:
            if self._client is None:
                self._client = anthropic.Anthropic()
            response = self._client.beta.messages.create(
                model=MODEL,
                max_tokens=16000,
                system=system_prompt(audience),
                tools=self.tools,
                messages=self.messages,
                thinking={"type": "adaptive"},
                cache_control={"type": "ephemeral"},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
            self.messages.append({"role": "assistant", "content": response.content})
            text_now = "".join(b.text for b in response.content if b.type == "text").strip()
            if text_now:
                parts.append(text_now)

            if response.stop_reason == "refusal":
                return "(The model declined to answer that.)"
            if response.stop_reason != "tool_use":
                return _final_answer(parts)

            results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                self.progress.append({"name": block.name, "input": block.input})
                if on_tool:
                    on_tool(block.name, block.input)
                try:
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": self._run_tool(block.name, block.input)})
                except (ValueError, KeyError, TypeError) as e:
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": f"Error: {e}", "is_error": True})
            self.messages.append({"role": "user", "content": results})
