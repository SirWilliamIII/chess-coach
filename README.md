# chess-coach

Post-game review: Stockfish finds the mistakes, Claude explains them — grounded in engine
output and hard position facts, never its own guesswork.

## Setup

```sh
sudo apt install stockfish
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env   # optionally add CHESS_USER=yourname
./start
```

`./start` creates the Python environment on first run (and whenever `requirements.txt`
changes), loads `.env`, and starts the web app on http://localhost:8000.
`./start --host 0.0.0.0` makes it reachable from other devices; `./start cli ...` runs the
terminal version.

## Web app (board + coach chat)

```sh
./start        # then open http://localhost:8000
```

- **Search games** lists your recent chess.com games; pick one and it's reviewed (about 40 s on a Pi, cached after).
- Click moves, use the arrow keys, or drag pieces to try your own lines; the engine eval follows the board.
- Ask the coach anything about the position on the board ("best move?", "what was the plan here?").
  Moves in its answers are clickable and play on the board.
- **Play bot**: practice games against Stockfish at 9 strength levels (~600 to full strength).
  Ask the coach for ideas mid-game ("what idea should I aim for?"); it teaches the plan rather
  than giving away the move unless you ask. Takeback/resign, then **Review this game**.
- **Play from here** (in a reviewed game): **Best moves only** takes over the position against a
  full-strength bot; **Replay exactly as it went** has you replay your own moves while the opponent
  plays theirs, and the coach steps in at GM moments (and warns you before the opponent's).
- **⚡ GM alerts**: Stockfish checks each position where it's your turn in bot games and replays for
  a sacrifice or forced mate that beats everything else; only then does the coach speak up.
- **Show me**: when the coach explains a line it attaches a demo; the button plays it on a
  grey demo board (with a note per move) where you can also try your own moves.
  **Back to my game** returns you exactly where you were.
- **Set up position**: place pieces freely or pick an endgame preset (Lucena, Philidor, basic
  mates, king + pawn), then **Play vs bot from here** or **Analyse**.
- **▶ Most studied lines** (in the Explorer tab): instant demos of the main lines from the board
  position, straight from real games: Masters = most studied, Lichess + rating band = most played
  at that level. Each step shows how often it's played and how it scores. No coach call needed.
- **Explorer** tab (next to the engine lines): what real Lichess players at a chosen rating band
  and time control play in the current position, with results, plus a Masters database and
  example games you can open. Needs a free Lichess account token (`LICHESS_TOKEN` in `.env`, no
  scopes). The coach uses it too ("what do people at my level play here?").
- **📚 Library**: every coach answer is saved automatically (with its position, game, Habit line
  and auto-tags like back-rank, fork, sicilian) in `data/library.sqlite`. Search it, filter by tag,
  favourites (☆ on any answer) or habits, and click an entry to put the board back where it was.
  Works offline.
- **Analysis board** gives an empty board to set up and discuss any line.
- Add `--host 0.0.0.0` to open it from another device on your network (anyone on the network
  could then use your API key through it).

## Prompts

The coach's instructions live in `prompts/` as Markdown: `coach.md` (ground rules, how to
explain, answer format including the "Habit to build" line) plus one file per voice in
`prompts/audiences/`, and `player.md` (your level, goals and style, which the coach pitches to).
They're re-read on every question, so edits apply without a restart;
the coach's voice is `prompts/audiences/coach.md`; add another file there and a voice switch appears in the chat.

## Offline use

Everything except the coach chat (Claude API) and fetching new games from chess.com works
without internet: board, Stockfish, bot games, set-up board, and any game already analysed.
Before a trip, open **Search games → Save my last 20 games for offline**; saved games are under
**Search games → Saved on this Pi**. The browser libraries live in `frontends/web/static/vendor/`.

## Terminal

```sh
./start cli games <chess.com-user>        # numbered list of recent games
./start cli review 1 --me <user>          # review game #1 from that list
./start cli review <chess.com or lichess game URL> --me <user>
./start cli review game.pgn --me <user>   # a downloaded PGN
./start cli review - --me <user>          # paste a PGN, then Ctrl-D
```

Chess.com works without an account or token. For Lichess, single game URLs work
anonymously; `games --site lichess` needs a `LICHESS_TOKEN`.

In the review prompt: `/go 16b` jumps to 16...; then ask things like
"what was the plan with this move?" or "what should I have played and why?".
`/mistakes`, `/board`, `/next`, `/prev`, `/help`.

## Layout

```
core/engine.py     Stockfish wrapper: lines, evals, null-move threats, win% classification
core/features.py   verifiable facts: structure, king safety, loose pieces, outposts, move effects
core/review.py     one engine pass over a game, cached in data/reviews/
core/gm_moments.py sacrifice / forced-mate detector (static exchange evaluation)
core/tricks.py     traps and high-risk/high-reward candidates (what if they take the bait?)
core/openings.py   main lines from real-game statistics (explorer tree walk)
core/library.py    saved coach answers: SQLite + full-text search, auto-tags
core/coach.py      Claude + tools (move_report, compare_moves, analyze_position, find_tricks,
                   show_on_board, opening_explorer)
frontends/         chess.com + Lichess clients (incl. opening explorer), shared game loader
frontends/web/     FastAPI server + board/chat page (chessground, chess.js)
cli.py             terminal front end
```

