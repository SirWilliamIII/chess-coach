"""Terminal front end.

  python cli.py games <user> [-n 10] [--site chesscom|lichess]
  python cli.py review <N | game-url | file.pgn | -> --me <user>

  N      the Nth game from `games` (chess.com, needs --me)
  -      paste a PGN on stdin (finish with Ctrl-D)
"""

import argparse
import os
import re
import sys

import anthropic
import chess

from core.engine import Engine
from core.review import load_pgn, review_game
from frontends.chesscom import client as chesscom
from frontends.lichess import client as lichess
from frontends.loader import fetch_game_text

FLAG = {"blunder": "??", "mistake": "?", "inaccuracy": "?!"}

HELP = """Commands:
  <question>        ask the coach about the game (uses the move you're on, if any)
  /go 14 | /go 14b  jump to a move (b = Black's move); /go 0 clears focus
  /next, /prev      step through moves
  /mistakes         list flagged moves (yours only if --me was given)
  /board            show the board before the current move
  /moves            print the move list again
  /help, /quit"""


def chesscom_result(g: dict) -> str:
    if g["white"]["result"] == "win":
        return "1-0"
    if g["black"]["result"] == "win":
        return "0-1"
    return "½-½"


def cmd_games(args):
    if args.site == "chesscom":
        for i, g in enumerate(chesscom.recent_games(args.user, args.n), 1):
            w, b = g["white"], g["black"]
            opening = chesscom.opening_from_url(g.get("eco", ""))
            print(f"{i:>3}  {g.get('time_class', ''):<7} {w['username']} ({w['rating']}) - "
                  f"{b['username']} ({b['rating']})  {chesscom_result(g):<4} {opening}")
        print(f"\nReview one with: ./start cli review <number> --me {args.user}")
        return
    for g in lichess.recent_games(args.user, args.n):
        w, b = g["players"]["white"], g["players"]["black"]
        wn = w.get("user", {}).get("name", "AI" if "aiLevel" in w else "?")
        bn = b.get("user", {}).get("name", "AI" if "aiLevel" in b else "?")
        res = {"white": "1-0", "black": "0-1"}.get(g.get("winner"), "½-½" if g.get("status") in ("draw", "stalemate") else g.get("status"))
        opening = g.get("opening", {}).get("name", "")
        print(f"{g['id']}  {g.get('speed', ''):<14} {wn} ({w.get('rating', '?')}) - {bn} ({b.get('rating', '?')})  {res:<7} {opening}")


def parse_ply(arg: str, n_moves: int) -> int | None:
    m = re.fullmatch(r"(\d+)\s*(\.\.\.|b|B)?", arg.strip())
    if not m:
        return None
    num = int(m.group(1))
    if num == 0:
        return 0
    ply = (num - 1) * 2 + (2 if m.group(2) else 1)
    return ply if 1 <= ply <= n_moves else None


def print_moves(review: dict, only_color: str | None = None):
    row = []
    for m in review["moves"]:
        tag = FLAG.get(m["class"], "")
        cell = f"{m['san']}{tag}"
        if m["color"] == "white":
            row = [f"{m['label']:>4} {cell:<9}"]
        elif not row:  # game from a set-up position starting with Black
            row = [f"{m['label'][:-3] + '.':>4} {'...':<9}", f"{cell:<9}"]
        else:
            row.append(f"{cell:<9}")
        if m["color"] == "black" or m["ply"] == len(review["moves"]):
            print(" ".join(row))


def print_mistakes(review: dict, color: str | None):
    found = False
    for m in review["moves"]:
        if m["class"] and (color is None or m["color"] == color):
            found = True
            print(f"  {m['label']} {m['san']}{FLAG[m['class']]:<3} {m['class']:<10} "
                  f"eval {m['eval_before']} -> {m['eval_after']}   best was {m['best']}")
    if not found:
        print("  no inaccuracies, mistakes or blunders flagged")


def load_game_text(ref: str, me: str | None) -> str:
    if ref == "-":
        if sys.stdin.isatty():
            print("Paste the PGN, then press Ctrl-D on an empty line:")
        text = sys.stdin.read()
        try:
            sys.stdin = open("/dev/tty")  # stdin is used up; chat reads from the terminal
        except OSError:
            pass
        return text
    try:
        return fetch_game_text(ref, me)
    except ValueError as e:
        sys.exit(str(e))


def cmd_review(args):
    try:
        game = load_pgn(load_game_text(args.game, args.me))
    except ValueError as e:
        sys.exit(str(e))
    with Engine() as engine:
        def progress(i, n):
            if sys.stdout.isatty():
                print(f"\rAnalysing positions {i}/{n}", end="", flush=True)

        review = review_game(game, engine, seconds=args.time, progress=progress, use_cache=not args.fresh)
        print("\r" + " " * 40 + "\r", end="")

        from core.coach import Coach  # imported late so `games` works without the anthropic key
        coach = Coach(review, engine, player=args.me)
        me = coach.player_color

        print(f"{review['white']} ({review['white_elo']}) vs {review['black']} ({review['black_elo']})  "
              f"{review['result']}  {review['opening'] or ''}\n")
        print_moves(review)
        print(f"\nFlagged moves{' for ' + me if me else ''}:")
        print_mistakes(review, me)
        print("\n" + HELP + "\n")

        n = len(review["moves"])
        focus = None
        while True:
            where = f"{review['moves'][focus - 1]['label']} {review['moves'][focus - 1]['san']}" if focus else "game"
            try:
                line = input(f"[{where}] > ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if not line:
                continue
            if line in ("/quit", "/q", "/exit"):
                break
            if line == "/help":
                print(HELP)
            elif line.startswith("/go"):
                p = parse_ply(line[3:], n)
                if p is None:
                    print("usage: /go 14 or /go 14b")
                else:
                    focus = p or None
            elif line in ("/next", "/n"):
                focus = min(n, (focus or 0) + 1)
            elif line in ("/prev", "/p"):
                focus = max(1, (focus or 2) - 1)
            elif line == "/mistakes":
                print_mistakes(review, me)
            elif line == "/moves":
                print_moves(review)
            elif line == "/board":
                fen = review["moves"][focus - 1]["fen_before"] if focus else review["start_fen"]
                b = chess.Board(fen)
                print(b.unicode(invert_color=True, borders=True, orientation=(me != "black")))
            elif line.startswith("/"):
                print("unknown command; /help")
            elif not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
                print("Set ANTHROPIC_API_KEY to chat with the coach (the /commands work without it).")
            else:
                try:
                    answer = coach.ask(line, focus, on_tool=lambda name, inp: print(f"  · {name} {inp}", flush=True))
                except anthropic.APIConnectionError:
                    coach.messages.clear()
                    print("Can't reach the Claude API - are you offline? The /commands still work.")
                    continue
                except anthropic.AnthropicError as e:
                    coach.messages.clear()
                    print(f"Claude API error: {e}\n(Set ANTHROPIC_API_KEY to use the coach.)")
                    continue
                print("\n" + answer + "\n")
                for d in coach.last_demos:
                    print(f"  ▶ {d['title']}: {' '.join(d['moves'])}")
                if coach.last_demos:
                    print()


def main():
    ap = argparse.ArgumentParser(description="Chess game review coach (Stockfish + Claude)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("games", help="list a user's recent games")
    g.add_argument("user")
    g.add_argument("-n", type=int, default=10)
    g.add_argument("--site", choices=["chesscom", "lichess"], default=os.environ.get("CHESS_SITE", "chesscom"))
    g.set_defaults(func=cmd_games)

    r = sub.add_parser("review", help="review a game and chat about it")
    r.add_argument("game", help="game number from `games`, chess.com/Lichess URL, PGN file, or - to paste")
    r.add_argument("--me", default=os.environ.get("CHESS_USER") or os.environ.get("LICHESS_USER"),
                   help="your username (whose moves to focus on)")
    r.add_argument("--time", type=float, default=0.3, help="engine seconds per position for the review pass")
    r.add_argument("--fresh", action="store_true", help="ignore cached review")
    r.set_defaults(func=cmd_review)

    args = ap.parse_args()
    try:
        args.func(args)
    except RuntimeError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
