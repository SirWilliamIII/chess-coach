"""Local web app: board + move list + engine eval + coach chat.

  .venv/bin/python -m frontends.web.server [--host 127.0.0.1] [--port 8000]

Single-user by design: one loaded game and one coach conversation at a time.
"""

import argparse
import functools
import json
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import anthropic
import chess
import requests
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core import eco, endgames, favorites, gm_moments, library, maia, openings, opening_quips, opponent_card, positions, ratings, repertoire, scoreboard, study, tablebase, usage
from core import org_spend as org_spend_mod
from core.coach import Coach, prompt_hash
from core.engine import BOT_LEVELS, Bot, Engine, check_position
from core import review as review_mod
from core.review import CACHE_DIR, load_pgn, review_game
from frontends.chesscom import client as chesscom
from frontends.lichess import client as lichess
from frontends.lichess import explorer
from frontends.loader import fetch_game_text

STATIC = Path(__file__).parent / "static"


class State:
    engine: Engine | None = None
    # the bot-game card's instant parts (quick card, "If they…" replies): their own process, so they never
    # queue behind the eval bar / GM check / coach on S.engine, which held them up 3+ s per move
    card_engine: Engine | None = None
    # the full bot-game card (depth 20 + trick and threat checks, ~5 s): its own process too. On S.engine the
    # eval bar queued behind it (0.6 s -> 1.9 s per bot move, measured 2026-10-06); on S.card_engine the next
    # bot move's quick card would queue behind it instead
    full_card_engine: Engine | None = None
    # the scoreboard's two parallel searches (top 5, the human moves): a few seconds each, so they get
    # their own processes rather than holding up the eval bar, the coach or the bot-game card
    sb_engines: tuple[Engine, Engine] | None = None
    bot: Bot | None = None
    maia: maia.Maia | None = None
    review: dict | None = None
    coach: Coach | None = None
    me: str | None = None
    job = {"status": "idle", "done": 0, "total": 0, "error": None}
    lock = threading.Lock()


S = State()


@asynccontextmanager
async def lifespan(app):
    S.engine = Engine()
    S.card_engine = Engine(threads=2, hash_mb=64)  # 2 of the 4 performance cores; S.engine uses 4
    S.full_card_engine = Engine(threads=2, hash_mb=64)  # took 4 threads on S.engine before, so no more CPU per bot move
    S.sb_engines = (Engine(threads=3, hash_mb=128), Engine(threads=3, hash_mb=64))  # with the above: 12 threads on 10 cores, rarely all busy
    S.bot = Bot()
    S.maia = maia.Maia()  # the model itself loads on the first request
    new_analysis(chess.STARTING_FEN)
    repertoire.index()  # loads the trap index, or starts building it if data/openings.md changed
    yield
    S.engine.close()
    S.card_engine.close()
    S.full_card_engine.close()
    for e in S.sb_engines:
        e.close()
    S.bot.close()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def parse_fen(fen: str) -> chess.Board:
    try:
        board = chess.Board(fen)
        check_position(board)
    except ValueError as e:
        raise HTTPException(400, str(e) if str(e).startswith("Illegal") else "invalid FEN")
    return board


def make_coach(review: dict, player: str | None = None, player_color: str | None = None) -> Coach:
    return Coach(review, S.engine, player=player, player_color=player_color,
                 explorer=functools.partial(explorer.explore, patient=True) if explorer.available() else None)


def new_analysis(fen: str, note: str | None = None, player_color: str | None = None):
    S.review = {"game_id": None, "white": "?", "black": "?", "white_elo": None, "black_elo": None,
                "result": "*", "opening": None, "time_control": None, "start_fen": fen, "moves": [],
                "note": note}
    S.coach = make_coach(S.review, player_color=player_color)


def _elo_cc(r: dict, color: str) -> int | None:
    """A player's rating on the app's scale (chess.com rapid, core/ratings.py), for matching the bot and Maia.
    The game's own numbers stay as they are on screen: they're that site's ratings."""
    try:
        elo = int(r[f"{color}_elo"])
    except (TypeError, ValueError, KeyError):
        return None
    return ratings.to_chesscom(elo) if review_mod.from_lichess(r["game_id"]) else elo


def public_review() -> dict:
    r = S.review
    traps = repertoire.annotate_game(r["start_fen"], r["moves"])
    fav = favorites.get(r["game_id"])
    return {
        "favorite": bool(fav), "title": fav["title"] if fav else None, "date": r.get("date"),
        "game_id": r["game_id"], "white": r["white"], "black": r["black"],
        "white_elo": r["white_elo"], "black_elo": r["black_elo"], "result": r["result"],
        "white_elo_cc": _elo_cc(r, "white"), "black_elo_cc": _elo_cc(r, "black"),
        "opening": r["opening"], "start_fen": r["start_fen"],
        "player_color": S.coach.player_color if S.coach else None,
        "moves": [{k: m[k] for k in ("ply", "label", "color", "san", "uci", "fen_after",
                                     "eval_before", "eval_after", "best", "best_line", "class", "played_best",
                                     "win_pct_lost")} | {"trap": traps.get(m["ply"])} for m in r["moves"]],
    }


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    """Browsers ask for /favicon.ico regardless of the <link> tags; answer with the PNG."""
    return FileResponse(STATIC / "favicon-32.png", media_type="image/png")


@app.get("/api/config")
def config():
    return {"me": os.environ.get("CHESS_USER", ""),
            "coach_ready": bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")),
            "explorer_ready": explorer.available(), "maia_ready": maia.available(), "maia_ratings": maia.RATINGS,
            "player_rating": maia.player_rating()}


def _lichess_player(p: dict) -> tuple[str, int | None]:
    if "user" in p:
        return p["user"]["name"], p.get("rating")
    return (f"Stockfish level {p['aiLevel']}", None) if "aiLevel" in p else ("Anonymous", None)


def _lichess_games(user: str, n: int) -> list[dict]:
    out = []
    for i, g in enumerate(lichess.recent_games(user, n), 1):
        (w, wr), (b, br) = _lichess_player(g["players"]["white"]), _lichess_player(g["players"]["black"])
        res = {"white": "1-0", "black": "0-1"}.get(g.get("winner"), "½-½")  # no winner: draw (or aborted)
        out.append({"ref": f"https://lichess.org/{g['id']}", "index": i, "time_class": g.get("speed"),
                    "white": w, "white_rating": wr, "black": b, "black_rating": br, "result": res,
                    "opening": (g.get("opening") or {}).get("name", ""),
                    "end_time": (g.get("lastMoveAt") or g.get("createdAt") or 0) // 1000 or None})
    return out


@app.get("/api/games")
def games(user: str, n: int = 15, site: str = "chesscom"):
    try:
        if site == "lichess":
            return _lichess_games(user, n)
        out = []
        for i, g in enumerate(chesscom.recent_games(user, n), 1):
            w, b = g["white"], g["black"]
            res = "1-0" if w["result"] == "win" else "0-1" if b["result"] == "win" else "½-½"
            out.append({"ref": g["url"], "index": i, "time_class": g.get("time_class"),
                        "white": w["username"], "white_rating": w["rating"],
                        "black": b["username"], "black_rating": b["rating"], "result": res,
                        "opening": chesscom.opening_from_url(g.get("eco", "")), "end_time": g.get("end_time")})
        return out
    except (RuntimeError, ValueError, requests.HTTPError) as e:
        raise HTTPException(400, str(e))


# ---------- saved reviews (work offline) ----------

def saved_reviews() -> list[dict]:
    out = []
    for f in CACHE_DIR.glob("*.json"):
        try:
            r = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if not r.get("moves"):
            continue
        out.append({"game_id": r["game_id"], "white": r["white"], "black": r["black"],
                    "white_elo": r.get("white_elo"), "black_elo": r.get("black_elo"),
                    "result": r["result"], "opening": r.get("opening"), "saved_at": f.stat().st_mtime})
    return sorted(out, key=lambda g: g["saved_at"], reverse=True)


@app.get("/api/saved")
def saved():
    return saved_reviews()


class OpenSavedReq(BaseModel):
    game_id: str
    me: str | None = None


@app.post("/api/saved/open")
def open_saved(req: OpenSavedReq):
    f = CACHE_DIR / f"{req.game_id}.json"
    if not req.game_id.isalnum() or not f.exists():
        raise HTTPException(404, "saved game not found")
    review = json.loads(f.read_text())
    with S.lock:
        S.review, S.me = review, req.me
        S.coach = make_coach(review, req.me)
    return public_review()


# ---------- favourite games (core/favorites.py) ----------

def _review_for(game_id: str) -> dict:
    if S.review and S.review["game_id"] == game_id:
        return S.review
    f = CACHE_DIR / f"{game_id}.json"
    if not game_id.isalnum() or not f.exists():
        raise HTTPException(404, "game not found")
    return json.loads(f.read_text())


@app.get("/api/favorites")
def favorites_list():
    return favorites.all_()


class FavoriteReq(BaseModel):
    favorite: bool = True
    title: str | None = None  # sent only by the title editor; "" clears it


@app.post("/api/favorites/{game_id}")
def favorite_set(game_id: str, req: FavoriteReq):
    if not req.favorite:
        favorites.remove(game_id)
        return {"favorite": False, "title": None}
    title = None if req.title is None else (req.title.strip()[:200] or None)
    fav = favorites.save(_review_for(game_id), title)
    if req.title is not None and title is None:  # an emptied title clears it, the favourite stays
        favorites.set_title(game_id, None)
        fav["title"] = None
    return {"favorite": True, "title": fav["title"]}


# ---------- saved board positions (core/positions.py) ----------

@app.get("/api/positions")
def positions_list():
    return positions.all_()


class PositionReq(BaseModel):
    title: str
    start_fen: str
    moves: list[str] = []  # SAN, from start_fen to the saved position
    orientation: str = "white"
    source: str | None = None


@app.post("/api/positions")
def position_save(req: PositionReq):
    title = req.title.strip()[:200]
    if not title:
        raise HTTPException(400, "give the position a title")
    parse_fen(req.start_fen)  # 400 on a bad start position
    try:
        return positions.save(title, req.start_fen, req.moves, req.orientation, (req.source or "")[:200] or None)
    except ValueError:
        raise HTTPException(400, "those moves don't replay from the start position")


class PositionTitleReq(BaseModel):
    title: str


@app.post("/api/positions/{pos_id}")
def position_rename(pos_id: int, req: PositionTitleReq):
    title = req.title.strip()[:200]
    if not title:
        raise HTTPException(400, "the title can't be empty")
    if not positions.rename(pos_id, title):
        raise HTTPException(404, "no such position")
    return {"id": pos_id, "title": title}


@app.delete("/api/positions/{pos_id}")
def position_delete(pos_id: int):
    if not positions.remove(pos_id):
        raise HTTPException(404, "no such position")
    return {"deleted": pos_id}


PREFETCH = {"status": "idle", "done": 0, "total": 0, "new": 0, "error": None}


class PrefetchReq(BaseModel):
    user: str
    n: int = 20
    site: str = "chesscom"


def _prefetch_job(site: str, user: str, n: int):
    try:
        if site == "lichess":
            items = lichess.recent_games(user, n)
            fetch_pgn = lambda g: lichess.game_pgn(g["id"])  # a separate request per game
        else:
            items = chesscom.recent_games(user, n, max_months=1000)  # walk the full archive if needed
            fetch_pgn = lambda g: g["pgn"]  # already included in the archive
        PREFETCH.update(total=len(items))
        for i, g in enumerate(items, 1):
            game = load_pgn(fetch_pgn(g))
            before = len(list(CACHE_DIR.glob("*.json")))
            review_game(game, S.engine)  # returns straight away if it's already saved
            PREFETCH["new"] += len(list(CACHE_DIR.glob("*.json"))) - before
            PREFETCH.update(done=i)
        PREFETCH.update(status="done")
    except Exception as e:
        PREFETCH.update(status="error", error=str(e))


@app.post("/api/prefetch")
def prefetch(req: PrefetchReq):
    if req.site not in ("chesscom", "lichess"):
        raise HTTPException(400, "site must be 'chesscom' or 'lichess'")
    if PREFETCH["status"] == "running":
        raise HTTPException(409, "already saving games")
    PREFETCH.update(status="running", done=0, total=0, new=0, error=None)
    threading.Thread(target=_prefetch_job, args=(req.site, req.user, max(1, min(500, req.n))), daemon=True).start()
    return {"ok": True}


@app.get("/api/prefetch")
def prefetch_status():
    return PREFETCH


class LoadReq(BaseModel):
    ref: str
    me: str | None = None


def _load_job(ref: str, me: str | None):
    try:
        game = load_pgn(fetch_game_text(ref, me))

        def progress(i, n):
            S.job.update(done=i, total=n)

        review = review_game(game, S.engine, progress=progress)
        with S.lock:
            S.review, S.me = review, me
            S.coach = make_coach(review, me)
        S.job.update(status="done")
    except Exception as e:  # surfaced to the UI
        S.job.update(status="error", error=str(e))


@app.post("/api/load")
def load(req: LoadReq):
    if S.job["status"] == "running":
        raise HTTPException(409, "still analysing the previous game — try again in a moment")
    S.job = {"status": "running", "done": 0, "total": 0, "error": None}
    threading.Thread(target=_load_job, args=(req.ref, req.me), daemon=True).start()
    return {"ok": True}


@app.get("/api/job")
def job():
    out = dict(S.job)
    if out["status"] == "done":
        out["review"] = public_review()
    return out


class AnalysisReq(BaseModel):
    fen: str | None = None


@app.post("/api/analysis")
def analysis(req: AnalysisReq):
    fen = parse_fen(req.fen or chess.STARTING_FEN).fen()
    with S.lock:
        new_analysis(fen)
    return public_review()


# ---------- opening studies (core/study.py): build once, then walk and drill for free ----------

STUDY_JOB = {"status": "idle", "message": "", "error": None, "slug": None}


@app.get("/api/study/openings")
def study_openings(q: str = ""):
    return {"openings": study.search(q)}


class StudyReq(BaseModel):
    name: str  # the side isn't chosen: study.side() decides it from the name


def _study_job(name: str, color: str):
    try:
        def progress(msg):
            STUDY_JOB["message"] = msg
        s = study.build(name, color, S.engine, functools.partial(explorer.explore, patient=True), progress)
        STUDY_JOB.update(status="done", slug=s["slug"])
    except Exception as e:  # surfaced to the UI
        STUDY_JOB.update(status="error", error=str(e))


@app.post("/api/study/build")
def study_build(req: StudyReq):
    color = study.side(req.name)
    if study.load(req.name, color):
        return {"status": "done"}
    if not explorer.available():
        raise HTTPException(400, "Building a lesson needs LICHESS_TOKEN in .env (it reads the masters database).")
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise HTTPException(400, "Building a lesson needs ANTHROPIC_API_KEY (the coach writes the notes).")
    if STUDY_JOB["status"] == "running":
        raise HTTPException(409, "Another lesson is still being built; try again when it's done.")
    STUDY_JOB.update(status="running", message="Starting…", error=None, slug=None)
    threading.Thread(target=_study_job, args=(req.name, color), daemon=True).start()
    return {"status": "running"}


@app.get("/api/study/job")
def study_job():
    return STUDY_JOB


@app.post("/api/study/start")
def study_start(req: StudyReq):
    """Open a built study: a fresh analysis board from the start position with a coach that knows
    the lesson. Returns the study and the review, like the other mode switches."""
    color = study.side(req.name)
    s = study.load(req.name, color)
    if not s:
        raise HTTPException(404, "that lesson hasn't been built yet")
    with S.lock:
        new_analysis(chess.STARTING_FEN, study.coach_note(s), player_color=color)
    return {"study": s, "review": public_review()}


# ---------- playing against the bot ----------

PRACTICE_NOTE = (
    "The player is playing a practice game against a bot ({level}) and has the {color} pieces. "
    "Moves played so far are given with each question. This is training, so coach like a teacher: "
    "when they ask for an idea or a plan, explain the key features of the position (pawn structure, "
    "weaknesses, piece activity, king safety) and the plan to aim for, grounded in the tools. Don't "
    "just hand over the engine's best move unless they explicitly ask for the move."
)


def bot_levels() -> list[dict]:
    # Maia plays 600-2500 when installed; a clone without it keeps the old Stockfish levels.
    return maia.BOT_LEVELS if maia.available() else BOT_LEVELS


@app.get("/api/play/levels")
def play_levels():
    return [{"id": lv["id"], "name": lv["name"]} for lv in bot_levels()]


class PlayNewReq(BaseModel):
    color: str
    level: int
    fen: str | None = None
    origin: str | None = None  # e.g. "sirwill3rd vs X, after 23. Nf5", when playing on from a game
    lesson: str | None = None  # an opening lesson's name, when playing on after its theory ends


@app.post("/api/play/new")
def play_new(req: PlayNewReq):
    level = next((lv for lv in bot_levels() if lv["id"] == req.level), None)
    if level is None or req.color not in ("white", "black"):
        raise HTTPException(400, "bad color or level")
    board = parse_fen(req.fen or chess.STARTING_FEN)
    if board.is_game_over():
        raise HTTPException(400, "that position is already game over")
    note = PRACTICE_NOTE.format(level=level["name"], color=req.color)
    if req.lesson:
        note += (f" The player has just played through the {req.lesson} lesson's theory in the app's opening "
                 "trainer and is now playing the position out; the game's first moves are that lesson line.")
    elif req.origin:
        note += f" The player is playing on from a real game ({req.origin}) to see how it could have gone."
    elif req.fen:
        note += f" The game started from a set-up position (FEN {board.fen()}), e.g. to practise an endgame."
    with S.lock:
        new_analysis(board.fen(), note, player_color=req.color)
    return public_review()


class PlayMoveReq(BaseModel):
    fen: str
    level: int
    start_fen: str | None = None  # with `moves`: the game so far, which Maia reads (last 8 positions)
    moves: list[str] = []         # SAN
    opp_elo: int | None = None    # the human's rating, when known (else PLAYER_RATING); Maia plays against that
    card: bool = False            # also return the quick opponent card for the position after the move


@app.post("/api/play/move")
def play_move(req: PlayMoveReq):
    board = with_history(parse_fen(req.fen), req.start_fen, req.moves)
    if board.is_game_over():
        raise HTTPException(400, "game is over")
    level = next((lv for lv in bot_levels() if lv["id"] == req.level), None)
    if level and "maia" in level:
        # a fresh game has no rating for you, so PLAYER_RATING stands in (else Maia assumes an equal opponent)
        move = S.maia.play(board, level["maia"], req.opp_elo or maia.player_rating())
    else:
        move = S.bot.play(board, req.level)
    out = {"uci": move.uci(), "san": board.san(move)}
    if req.card:
        # the card's instant part rides along with the move, so it appears with it (~25 ms, inside the
        # frontend's 450 ms pause) instead of after a separate ~4 s request; the full card follows
        after = board.copy()
        after.push(move)
        if not after.is_game_over():
            try:
                out["card"] = _with_traps(opponent_card.quick(S.card_engine, after), after)
            except ValueError:
                pass  # no card is fine; the full request still runs
    return out


class ExplorerReq(BaseModel):
    fen: str
    db: str = "lichess"
    ratings: list[int] | None = None
    speeds: list[str] | None = None


@app.post("/api/explorer")
def explore(req: ExplorerReq):
    parse_fen(req.fen)
    try:
        return explorer.explore(req.fen, req.db, req.ratings, req.speeds)
    except (RuntimeError, ValueError) as e:
        raise HTTPException(400, str(e))


class GmReq(BaseModel):
    fen: str


@app.post("/api/gm_check")
def gm_check(req: GmReq):
    """Is there a GM-level resource (sacrifice / forced mate) for the side to move?"""
    return {"moment": gm_moments.find(S.engine, parse_fen(req.fen))}


_warm_lock = threading.Lock()
_warm_token = 0  # bumped per request so a stale warm-up stands down when the position moves on


def _warm_explorer(fen: str) -> None:
    """Fetch the coach's default main-lines tree for this position in the background, so a later
    'Show main lines' finds it on disk instead of walking Lichess at ~1 s per request. Same parameters
    the coach tool uses (masters, depth 6), so the cache keys match. Never blocks a request: one warm-up
    at a time, and it stops early if the position changes."""
    global _warm_token
    if not explorer.available():
        return
    _warm_token += 1
    mine = _warm_token

    def walk():
        if not _warm_lock.acquire(timeout=15):  # an older walk is still winding down
            return
        try:
            if _warm_token != mine:
                return
            def explore(*a, **k):
                if _warm_token != mine:
                    raise RuntimeError("superseded")  # main_lines stops the walk and keeps what it has
                return explorer.explore(*a, patient=True, **k)
            openings.main_lines(explore, chess.Board(fen), 6, "masters", None)
        except Exception:  # noqa: BLE001 - a best-effort warm-up must never surface an error
            pass
        finally:
            _warm_lock.release()
    threading.Thread(target=walk, daemon=True).start()


@app.post("/api/opponent_card")
def opponent_card_endpoint(req: GmReq):
    """Best move / main line / sharper try / threat for the side to move — engine only, no Claude call."""
    board = parse_fen(req.fen)
    if board.is_game_over():
        raise HTTPException(400, "game is over")
    if board.fullmove_number <= 8:  # still in the opening: have "Show main lines" ready before it's asked
        _warm_explorer(req.fen)
    try:
        card = opponent_card.build(S.full_card_engine, board)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _with_traps(card, board)


def _with_traps(card: dict, board: chess.Board) -> dict:
    # known traps from data/openings.md: the one just played against you, or one you could walk into
    card["trap_punish"] = next(iter(repertoire.after_mistake(board)), None)
    card["trap_warn"] = next(iter(repertoire.before_mistake(board)), None)
    return card


@app.post("/api/opening")
def opening_for_position(req: GmReq):
    """Named opening for this exact position (offline ECO data) plus a one-line reaction to it.
    `opening` is null when the position isn't a named one."""
    hit = eco.lookup(parse_fen(req.fen))
    return {"opening": {**hit, **opening_quips.pick(hit["name"])} if hit else None}


class OpeningLineReq(BaseModel):
    start_fen: str
    moves: list[str] = []  # SAN


@app.post("/api/opening_line")
def opening_line(req: OpeningLineReq):
    """Every named opening position along a line (offline ECO data, exact positions): [{ply, eco, name,
    family}], ply = moves played. The scoreboard keeps the deepest one at or before the shown move."""
    board = parse_fen(req.start_fen)
    out = []
    for i, san in enumerate(req.moves):
        try:
            board.push_san(san)
        except ValueError:
            break  # a line that doesn't replay: keep what matched so far
        hit = eco.lookup(board)
        if hit:
            out.append({"ply": i + 1, **hit})
    return {"names": out}


class CardRepliesReq(BaseModel):
    fen: str
    uci: str


@app.post("/api/opponent_card/replies")
def opponent_card_replies(req: CardRepliesReq):
    """'If they play A, I play B' rows for the card's best move (engine only, no Claude call)."""
    board = parse_fen(req.fen)
    try:
        return {"replies": opponent_card.replies(S.card_engine, board, req.uci)}
    except ValueError as e:
        raise HTTPException(400, str(e))


class LinesReq(BaseModel):
    fen: str
    db: str = "masters"
    ratings: list[int] | None = None
    speeds: list[str] | None = None
    depth: int = 8


@app.post("/api/lines")
def lines(req: LinesReq):
    """Main lines from a position, straight from the explorer (no coach involved)."""
    board = parse_fen(req.fen)
    if not explorer.available():
        raise HTTPException(400, "The explorer needs a Lichess token: add LICHESS_TOKEN to .env.")
    try:
        return openings.main_lines(explorer.explore, board, req.depth, req.db, req.ratings, req.speeds, max_lines=8)
    except (RuntimeError, ValueError) as e:
        raise HTTPException(400, str(e))


# ---------- the chat library ----------

@app.get("/lessons")
def lessons_page():
    return FileResponse(STATIC / "lessons.html")


@app.get("/api/library")
def library_search(q: str = "", tag: str | None = None, starred: bool = False, habits: bool = False):
    return {"entries": library.search(q, tag, starred, habits), "tags": library.tag_counts()}


@app.get("/api/library/{entry_id}")
def library_get(entry_id: int):
    entry = library.get(entry_id)
    if not entry:
        raise HTTPException(404, "not found")
    return entry


class StarReq(BaseModel):
    starred: bool


@app.post("/api/library/{entry_id}/star")
def library_star(entry_id: int, req: StarReq):
    library.set_star(entry_id, req.starred)
    return {"ok": True}


@app.delete("/api/library/{entry_id}")
def library_delete(entry_id: int):
    library.delete(entry_id)
    return {"ok": True}


@app.get("/api/review")
def current_review():
    return public_review()


@app.get("/api/org-spend")
def org_spend():
    """Whole-organization month-to-date spend (Cost Admin API), vs. MONTHLY_SPEND_LIMIT if set."""
    return org_spend_mod.month_to_date()


@app.get("/usage")
def usage_page():
    return FileResponse(STATIC / "usage.html")


@app.get("/api/usage")
def usage_summary(days: int = 30):
    """This app's own Claude usage — not a substitute for the Anthropic Console's Usage/Cost
    pages (the authoritative, account-wide source), just what this app itself has sent."""
    return usage.summary(days)


class MeColorReq(BaseModel):
    color: str  # "white" or "black"


@app.post("/api/me-color")
def set_me_color(req: MeColorReq):
    """Explicit override for which side the player is on — the automatic username match (no
    username set, a pasted PGN, a typo) can silently miss, leaving the coach with no idea."""
    if req.color not in ("white", "black"):
        raise HTTPException(400, "color must be 'white' or 'black'")
    if not S.coach:
        raise HTTPException(400, "no game loaded")
    S.coach.set_player_color(req.color)
    name = S.review.get(req.color)
    S.me = name if name and name != "?" else S.me
    return public_review()


class EvalReq(BaseModel):
    fen: str
    lines: int = 1
    start_fen: str | None = None  # with `moves`: the line that led here, so repetition draws are seen
    moves: list[str] = []         # SAN


@app.post("/api/eval")
def evaluate(req: EvalReq):
    board = with_history(parse_fen(req.fen), req.start_fen, req.moves)
    if board.is_checkmate():
        return {"eval": "#0", "cp": -10_000 if board.turn else 10_000, "lines": []}
    if board.is_game_over():
        return {"eval": "0.00", "cp": 0, "lines": []}
    lines = S.engine.lines(board, multipv=max(1, min(3, req.lines)), seconds=0.6)
    return {"eval": lines[0]["eval_white"], "cp": lines[0]["cp_white"], "lines": lines}


def with_history(board: chess.Board, start_fen: str | None, moves: list[str]) -> chess.Board:
    """`board` with the moves that led to it, when they replay to the same position (Maia reads them)."""
    if start_fen and moves:
        try:
            line = chess.Board(start_fen)
            for san in moves:
                line.push_san(san)
            if line.fen() == board.fen():
                return line
        except ValueError:
            pass  # a line that doesn't replay: use the bare FEN, slightly less accurate
    return board


class MaiaReq(BaseModel):
    fen: str
    rating: int = 1500
    opp_rating: int | None = None  # defaults to `rating`
    start_fen: str | None = None  # with `moves`: the line that led here, which Maia uses as input too
    moves: list[str] = []         # SAN
    include: list[str] = []       # scoreboard only: UCI moves to score even outside both lists


@app.post("/api/maia")
def maia_moves(req: MaiaReq):
    if not maia.available():
        raise HTTPException(503, "Maia isn't installed (pip install git+https://github.com/CSSLab/maia3.git)")
    board = with_history(parse_fen(req.fen), req.start_fen, req.moves)
    clamp = lambda r: max(0, min(5000, r))
    rating = clamp(req.rating)
    opp = clamp(req.opp_rating or req.rating)
    moves = S.maia.moves(board, rating, opp)
    if moves:
        # Stockfish's eval of each human move, searching only those; the card engine so it never
        # waits behind the eval bar's search on S.engine
        roots = [chess.Move.from_uci(m["uci"]) for m in moves]
        evals = {l["uci"]: l["eval_white"]
                 for l in S.card_engine.lines(board, multipv=len(roots), seconds=0.5, root_moves=roots)}
        for m in moves:
            m["eval_white"] = evals.get(m["uci"])
    return {"rating": rating, "opp_rating": opp, "moves": moves}


SB_LOCK = threading.Lock()  # one scoreboard search at a time...
SB_LATEST = [0]             # ...and only for the newest request: stepping through a game shouldn't queue them


@app.post("/api/scoreboard")
def scoreboard_view(req: MaiaReq):
    board = with_history(parse_fen(req.fen), req.start_fen, req.moves)
    clamp = lambda r: max(0, min(5000, r))
    rating = clamp(req.rating)
    SB_LATEST[0] += 1  # FastAPI runs sync handlers on a thread pool; a lost race only means one extra search
    me = SB_LATEST[0]
    with SB_LOCK:
        if me != SB_LATEST[0]:
            return {"stale": True}  # the board has already moved on
        return scoreboard.build(*S.sb_engines, S.maia if maia.available() else None,
                                board, rating, clamp(req.opp_rating or rating), req.include[:4])


# ---------------------------------------------------------------- endgame trainer

@app.get("/api/endgame/presets")
def endgame_presets():
    return [{"group": g, "spec": spec, "label": label} for g, spec, label in endgames.PRESETS]


class EndgameReq(BaseModel):
    spec: str            # "KRP-KR" (yours - theirs), "rand:N" or "pawns:N"
    mode: str            # win / draw / lies
    color: str = "white"


@app.post("/api/endgame/new")
def endgame_new(req: EndgameReq):
    if req.color not in ("white", "black"):
        raise HTTPException(400, "bad color")
    try:
        # the scoreboard's first engine: idle while a drill is being set up
        return endgames.generate(S.sb_engines[0], req.spec, req.mode, req.color == "white")
    except endgames.NoPosition as e:
        raise HTTPException(422, str(e))
    except (ValueError, KeyError) as e:
        raise HTTPException(400, f"bad request: {e}")


class FenReq(BaseModel):
    fen: str


@app.post("/api/endgame/probe")
def endgame_probe(req: FenReq):
    """The tablebase verdict for the side to move and for each of its moves; {"covered": false} when the
    position has more than 7 pieces or the service can't be reached."""
    tb = tablebase.probe(parse_fen(req.fen))
    return {"covered": True, **tb} if tb else {"covered": False}


class ChatReq(BaseModel):
    question: str
    ply: int = 0
    extra: list[str] = []
    where: str | None = None   # the page's label for the position ("After 35. Nf5")
    mode: str | None = None    # review / replay / play / analysis / demo
    label: str | None = None   # set for automatic GM alerts ("⚡ GM moment")
    ambient: bool = False      # opponent-move commentary: real answer, but not a library-worthy Q&A


@app.post("/api/chat")
def chat(req: ChatReq):
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise HTTPException(400, "Set ANTHROPIC_API_KEY before starting the server to use the coach.")
    coach = S.coach
    question_key = req.label or req.question
    tools = []
    cached = None
    fen = None
    try:
        context = coach.board_context(req.ply, req.extra)
        if not req.ambient:  # ambient commentary is never saved, so there's nothing to match either
            board, _ = coach._position(req.ply + 1, req.extra)
            fen = board.fen()
            cached = library.find_cached(question_key, fen, prompt_hash(), coach.player_color)
        if cached:
            # exact same question, position, prompt files, and understood player color as when
            # this was last answered — genuinely what the coach would say again, so skip the API
            # call. Doesn't touch the real conversation history (see Coach.record_cached).
            coach.record_cached(req.question)
            answer = cached["answer"]
        else:
            answer = coach.ask(req.question, context=context,
                               on_tool=lambda name, inp: tools.append({"name": name, "input": inp}))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except anthropic.APIConnectionError:
        coach.messages.clear()
        raise HTTPException(503, "The coach needs internet (it runs on the Claude API) and it looks like you're "
                                 "offline. The board, engine, bot and set-up board all still work.")
    except anthropic.AnthropicError as e:
        coach.messages.clear()
        raise HTTPException(502, f"Claude API error: {e}")
    if cached:
        return {"answer": answer, "tools": cached["tools"], "demos": cached["demos"],
                "quiz": cached["quiz"], "jumps": cached["jumps"], "entry_id": cached["id"]}
    tools = [t for t in tools if t["name"] not in ("show_on_board", "move_quiz", "jump_to_move")]  # shown as their own UI
    entry_id = None
    if not req.ambient:  # opponent-move color commentary isn't a Q&A worth surfacing in Lessons
        try:  # save to the library (a failure here must never cost the player their answer)
            r = coach.review
            entry_id = library.add(
                question=question_key, answer=answer,
                kind="gm alert" if req.label else "question", mode=req.mode, fen=fen,
                game_id=r.get("game_id") if r["moves"] else None,
                game_label=f"{r['white']} vs {r['black']}" if r["moves"] else None,
                position_label=req.where, ply=req.ply, extra=req.extra, opening=r.get("opening"),
                demos=coach.last_demos, tools=tools, prompt_hash=prompt_hash(),
                player_color=coach.player_color, quiz=coach.last_quiz, jumps=coach.last_jumps)
        except Exception as e:  # noqa: BLE001
            print(f"library: could not save answer: {e}")
    return {"answer": answer, "tools": tools, "demos": coach.last_demos, "quiz": coach.last_quiz, "jumps": coach.last_jumps, "entry_id": entry_id}


@app.get("/api/chat/progress")
def chat_progress():
    return {"steps": S.coach.progress if S.coach else []}


@app.post("/api/chat/reset")
def chat_reset():
    S.coach.messages.clear()
    return {"ok": True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to open it from other devices on your network")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    print(f"Chess coach running at http://{'localhost' if args.host == '127.0.0.1' else args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
