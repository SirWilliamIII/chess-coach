"""LLM coach: Claude answers questions about a reviewed game, grounded by engine tools."""

import json
import os

import anthropic
import chess

from . import features
from .engine import Engine

MODEL = os.environ.get("COACH_MODEL", "claude-opus-5")

SYSTEM = """You are a chess coach reviewing a finished game with the player who played it.

Ground rules - these matter more than anything else:
- You are not a chess engine and your own calculation is unreliable. Every concrete claim \
(a variation, a tactic, "this wins a pawn", "this was a mistake", an evaluation) must come \
from a tool result in this conversation. If you haven't checked it, call a tool first.
- Never invent moves or lines. Quote engine lines as the tools give them.
- If the tools don't support an explanation, say what the engine shows and admit the \
"why" is uncertain rather than making one up.

How to explain:
- "What was the plan with this move?" -> use move_report. The plan is visible in \
what the move changes (effects: new attacks, pins, outposts, structure) and in the engine \
continuation after it. Describe it in human terms: "this prepares ...", "the idea is ...".
- "What should I have played?" -> compare the played move with the best move (compare_moves) \
and explain the concrete difference: what the better move achieves that the played one didn't, \
or what the played move allowed (see the opponent's threats and engine lines).
- "What if I had played X?" -> compare_moves or analyze_position with those moves.
- Translate evals into words ("roughly equal", "White is clearly better", "winning") and \
only mention numbers when useful. Evals are from White's point of view unless stated.
- Prefer ideas and plans over long move lists: at most one or two short lines per answer.
- Refer to moves with move numbers (14...Nf6). Keep answers short and conversational; \
the player can ask follow-ups.
- For opening questions ("what do people play here?", "is this move common at my level?", \
learning an opening), use opening_explorer when it's available: it gives real game statistics \
by rating band. Combine it with the engine: popular isn't the same as good, and a move can \
score well at club level because it sets a trap. If the tool isn't available, don't guess statistics.
- Whenever you describe a concrete line or plan with moves (the better alternative, the \
threat, a typical manoeuvre), also call show_on_board so the player can step through it on \
a demo board. One demo per idea; don't create a demo for a single obvious move. The \
"Show me" buttons appear below your answer.

Plies: ply 1 is White's first move, ply 2 is Black's first move, and so on. Tools that take \
a ply look at the position *before* that move was played; ply 0 means the starting position."""

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


class Coach:
    def __init__(self, review: dict, engine: Engine, player: str | None = None, explorer=None):
        """`explorer(fen, db, ratings, speeds) -> dict` enables the opening_explorer tool."""
        self.explorer = explorer
        self.tools = TOOLS + ([EXPLORER_TOOL] if explorer else [])
        self.review = review
        self.engine = engine
        self._client = None
        self.messages: list[dict] = []
        self.last_demos: list[dict] = []  # show_on_board demos created during the latest ask()
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
            return r["note"]
        if not r["moves"]:
            return ("No game is loaded: the player is using a free analysis board, starting from "
                    f"FEN {r['start_fen']}. Moves they try on the board are given with each question.")
        lines = [
            f"Game: {r['white']} ({r['white_elo'] or '?'}) vs {r['black']} ({r['black_elo'] or '?'}), "
            f"result {r['result']}, opening: {r['opening'] or 'unknown'}, time control {r['time_control'] or '?'}.",
        ]
        if self.player_color:
            lines.append(f"The player you are coaching played {self.player_color}.")
        lines.append("\nMoves (ply | move | eval after, White POV | engine best | verdict):")
        for m in r["moves"]:
            verdict = m["class"] or ("best" if m["played_best"] else "")
            lines.append(f"{m['ply']} | {m['label']} {m['san']} | {m['eval_after']} | {m['best'] or '-'} | {verdict}")
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

    def _run_tool(self, name: str, args: dict) -> str:
        if name == "move_report":
            result = self.move_report(int(args["ply"]))
        elif name == "compare_moves":
            result = self.compare_moves(int(args["ply"]), list(args["moves"]), args.get("then_moves"))
        elif name == "show_on_board":
            result = self.show_on_board(str(args["title"]), int(args["ply"]), list(args["moves"]),
                                        args.get("then_moves"), args.get("notes"))
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
        return (f"[Board shows {where}. {to_move.capitalize()} to move. FEN {board.fen()}. "
                f"For tools, this position is {args}. 'This move' means {last}.]")

    def ask(self, question: str, focus_ply: int | None = None, on_tool=None, context: str | None = None) -> str:
        text = question
        if context:
            text = f"{context}\n{question}"
        elif focus_ply:
            m = self.review["moves"][focus_ply - 1]
            text = f"[Player is looking at ply {focus_ply}: {m['label']} {m['san']}]\n{question}"
        if not self.messages:
            text = f"{self._intro}\n\n{text}"
        self.messages.append({"role": "user", "content": text})
        self.last_demos = []

        parts: list[str] = []  # text written between tool calls counts as part of the answer
        while True:
            if self._client is None:
                self._client = anthropic.Anthropic()
            response = self._client.beta.messages.create(
                model=MODEL,
                max_tokens=16000,
                system=SYSTEM,
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
                return "\n\n".join(parts)

            results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                if on_tool:
                    on_tool(block.name, block.input)
                try:
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": self._run_tool(block.name, block.input)})
                except (ValueError, KeyError, TypeError) as e:
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": f"Error: {e}", "is_error": True})
            self.messages.append({"role": "user", "content": results})
