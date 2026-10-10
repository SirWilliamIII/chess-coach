# CLAUDE.md

Notes for whoever (human or agent) works in this repo next. `README.md` covers setup and user-facing
features; this file is architecture gotchas, current state and open TODOs. History lives in git; this
file says what is true now. Last full cleanup: 2026-10-03.

## Working conventions

- **Never `git push` without an explicit ask in that message.** Committing on request ("commit") is fine
  on its own; push only when the user says so directly ("push" / "commit and push"). One approval doesn't
  carry forward.
- `data/` is gitignored (reviews, lessons, library, opening files). `data/openings*.md` is partly course
  material and must never be committed.

## Current state (2026-10-08)

- **Opening lessons built** (`data/studies/`, per clone):

  | Lesson | Nodes | Curveballs | Moments | Human (Maia) | Family build |
  |---|---|---|---|---|---|
  | Najdorf (B) | 150 | ✓ | ✓ | ✓ | |
  | Vienna Game (W) | 134 | ✓ | ✓ | ✓ | |
  | Caro-Kann (B), Dutch (B) | 220 | ✓ | ✓ | | ✓ |
  | Scandinavian (B) | 150 | ✓ | ✓ | | ✓ |
  | Dragon, Accelerated Dragon, Nimzo, QGA, Italian Two Knights (B); Catalan, English, Alapin Sicilian, Caro-Kann Modern, Vienna Gambit/Max Lange (W) | 23-90 | ✓ | ✓ | | |
  | Catalan Open Defense Classical, English Anglo-Dutch (B); Dutch Leningrad Carlsbad (W) | 34-90 | | ✓ | | |

  Notes read through by the user: Najdorf and Dragon only.
- **Human moves in lessons** (first version, Najdorf + Vienna Game only; see the lessons section). Not done:
  a live Learn session by the user, the masters/players toggle on the start card, notes for human nodes, and
  running it in `build()` for new lessons.
- **Built 2026-10-04, not yet used live by the user:** the endgame trainer (see "Endgame trainer"), the scoreboard beside the board (Stockfish vs Maia lists,
  win strip, opening name, alert and big-play chat cards; see "Scoreboard"), refresh keeps the board, saved
  positions (📌; see "Games"), `./start` reading host/port from `.env`.
- **Favourite games with titles** (see "Games"). **Board drawing reworked** (colours, threat arrows; see
  "Board").
- **Built 2026-10-05:** the opening name as the page title above the names, the "Auto" switch for unrequested
  coach calls (off by default), and repetition-aware engine searches (eval bar history + cache key). See
  "Opening name", "Coach and cost", "Engine memo".
- **Built 2026-10-06, not yet used live by the user:** the scoreboard redesigned around "before your move / after
  it" (every legal move ranked, the rating track; see "Scoreboard"), one grid layout with the panels level with
  the board's top and the buttons' bottom, the side nav restyled with one icon set (icon rail ≤ 1360 px). The
  scoreboard's chat cards (move alerts, next-play alerts, big plays) and the opening banner were removed.
- **Built 2026-10-07, not yet used live by the user:** the tactics finder (see "Tactics finder"), Maia's lines
  ("Full lines", see "Scoreboard"), every rating on the chess.com rapid scale with one Maia rating for both sides
  (see "Maia"), scoreboard evals from White's side with the eval bar matching the #1 row, and the "I'm playing"
  toggle removed from the analysis board.
- **Built 2026-10-08, not yet used live by the user:** opening puzzles (see "Opening puzzles"): the Lichess puzzle
  database's opening-tagged part in `data/puzzles.sqlite`, a picker with each opening's recurring patterns, a puzzle
  mode with a hint ladder and a puzzle level ("Tactics in this opening ›" under the board removed 2026-10-10, user's call). Pattern names
  are templates; the one-off Claude naming pass (top ~10 per opening, user reviews) waits for the user's verdict on
  which patterns are worth it.
- **Built 2026-10-08, not yet used live:** puzzles from the user's own games ("Your mistakes" in Puzzles; see
  "Opening puzzles", last bullets). The nav item and dialog are now "Puzzles".
- **Direction (user, 2026-10-08):** most features now run without the Claude API (engine, Maia, ECO table, Lichess
  data, tablebase, both puzzle sources); Claude is the explainer you click for. Keep it that way: prefer a lookup or
  an engine fact over an LLM call. A coach hint button during puzzles was offered and declined for now.
- **Built 2026-10-09, not yet used live:** the panels fill the width the board leaves and a board-size handle
  (see "Layout"), and recording a game (⏺, see "Games").
- **Built 2026-10-10, not yet used live:** Explore lines (the user's opening files as a browsable, searchable list,
  its own mode; see "Known traps"), one context line under the board per mode (see "Layout"), the game report on one
  grid, the players' rating picker in the Top player moves heading, and a UI text sweep (user's call, saved as a
  memory: no explainer copy, subtext or example placeholders; tooltips if needed). Sweep fixes: the editor closes the
  Full Explorer it opened (`state.editor.openedGp`), a puzzle start closes it (it stayed open into lessons/puzzles
  showing stale Maia/explorer lists); an endgame drill hides the engine after `setReview()` (leaving a puzzle there
  turned the eval bar back on) and its empty scoreboard says why; all top-row buttons are one size (the board moved a
  few px between modes); Find games tabs read chess.com / Lichess / Saved / ★ Favorites; US spelling (Analyze).
- **Next focus:** the user trying Puzzles (both sources) and the tactics finder live; then "watch out" (the
  opponent's tactics: the "allowed" puzzles are the offline half of it). Opening lessons after that. See TODOs.

## Running and testing

- `./start` (venv on first run, then the web app on :8000; host/port from `CHESS_HOST`/`CHESS_PORT` in `.env`,
  default 127.0.0.1:8000, flags override; the primary clone's `.env` binds 127.0.0.1 behind `tailscale serve`, see below) or
  `.venv/bin/python -m frontends.web.server [--host H] [--port P]`. Default host `127.0.0.1`.
- **`.env` is gitignored** and must exist per clone: `ANTHROPIC_API_KEY`, `LICHESS_TOKEN`, optional
  `CHESS_USER`, `PLAYER_RATING` (chess.com rapid since 2026-10-07, default 800; the primary clone has 790), `ANTHROPIC_ADMIN_KEY` + `MONTHLY_SPEND_LIMIT`
  (org-spend card), `COACH_MODEL`, `STUDY_MODEL`, `COACH_EFFORT`, `COACH_THINKING`, `COACH_ENGINE_DEPTH`.
  One clone on this machine, `/Users/will/chess-coach` (the second, `~/Projects/chess-coach`, was deleted
  2026-10-10 at the user's request; its 3 saved answers are in `data/library-projects-clone-2026-09-26.sqlite`).
- **Other devices (tailnet):** the primary clone keeps localhost and runs `tailscale serve --bg --http=80
  localhost:8000` (2026-10-09), so other devices open `http://mbp.mastodon-snake.ts.net` (or `http://mbp`). The
  serve config persists in tailscaled; `tailscale serve status` / `tailscale serve reset`. There is no auth: every device shares the one global state (below),
  coach questions bill your API key, and `/usage` + `/lessons` expose org spend and saved answers.
- **The server does not hot-reload Python.** Restart after editing `core/*.py` or `server.py`; `prompts/` and
  `static/` are re-read live. Its output goes to the terminal that started it and, through `./start` (2026-10-09),
  is appended to `data/logs/server-<day it started>.log` (`tee`, `PYTHONUNBUFFERED`); a server started some other
  way logs nowhere (`/tmp/chess-coach-server.log` is stale). uvicorn runs at `log_level="warning"`, so there are no
  per-request lines: the log holds coach timing lines, job progress, warnings and tracebacks. The Claude calls
  themselves are in `data/usage.sqlite` (`calls`, the `/usage` page).
- **Testing without touching the running server:** start a second instance on another port
  (`(set -a; . ./.env; set +a; .venv/bin/python -m frontends.web.server --port 8011 &)`). To keep its writes
  out of the real `data/library.sqlite`, run it from a wrapper that sets `core.library.DB_PATH` to a copy
  before importing the server. Load a game with `POST /api/saved/open {"game_id": "...", "me": "O-O-O-F4ce"}`
  (games in `data/reviews/`), or a position with `POST /api/analysis {"fen": ...}`, then reload the page.
  Drive it with Playwright from `.venv` (system `python3` has no project deps); stub `**/api/chat` to avoid API
  spend. To test the coach itself, build `Coach(review, Engine(), player=...)` in a script and call `ask()`
  (load `.env` by hand; end with `os._exit(0)`, the engine thread keeps the process alive).
- **Playwright and chessground:** mouse events reach it. Right-drag = `mouse.down(button="right")`,
  `move(..., steps=4)`, `up()`; modifiers via `keyboard.down("Meta")` etc. A right-click without a move needs
  ~60 ms between down and up, and ~300 ms between clicks, or clicks after the first are lost. Read results
  from the DOM: `cg-container svg.cg-shapes > g > g` has `cgHash` (`size,size,orig,dest,brush…`) and lines
  carry the stroke colour. For internal functions, add a temporary `window.__debug` hook and remove it
  before finishing (none is in the code now).

## Architecture need-to-knows

### Server and state

- **Single-user, single global state.** `server.py` keeps one `S` (`S.review`, `S.coach`, `S.engine`,
  `S.card_engine`, `S.sb_engines`, `S.bot`, `S.maia`). Not built for concurrent users, by design.
- **One game load at a time.** `POST /api/load` returns 409 while `S.job` runs; a load doesn't cancel the
  running one.
- **Five Stockfish processes.** `S.engine` (4 threads; eval bar, GM check, coach tools), `S.card_engine` (2
  threads; the bot-game quick card and "If they…" replies, so they never queue behind the main engine),
  `S.full_card_engine` (2 threads; the full bot-game card, moved off `S.engine` 2026-10-06: the eval bar queued
  behind its ~5 s search, 0.6 → 1.9 s per bot move), and `S.sb_engines` (3 + 3 threads; the scoreboard's two
  parallel searches, see "Scoreboard"). Right after a bot move all of them run at once on 10 cores (4
  performance): `maia`'s 0.5 s scoring still queues behind `replies` on `S.card_engine` (0.5 → 1.1 s). `Engine._call` is serialized with a lock: overlapping `analyse` calls returned empty lines
  and 500'd. `Bot` has its own process and lock.
- **Engine search: time vs depth.** `Engine.lines()`/`evaluate()` take an optional `depth` (stop at that
  depth or after `seconds`, whichever first). The coach's tools use `TOOL_DEPTH` 22 / `TOOL_MAX_SECONDS` 4
  (measured: reaches depth 19-22). Game review (0.3 s/position), eval bar (0.6 s) and the GM/trick finders
  stay time-only on purpose, so borderline review classifications are noisy.
- **Engine memo:** `Engine.lines()` caches in memory (`LINES_CACHE_SIZE` 1024) on `(epd, _history_key(),
  multipv, seconds, depth, root_moves)`. `_history_key()` = the positions since the last capture/pawn move (the
  only ones that can repeat) + the halfmove clock once ≥ `RULE50_KEY_FROM` 60, so a repetition draw is a
  separate entry (2026-10-05; tested: queen-down side with a threefold available, +9.09 bare vs 0.00 with
  history). Not persisted; a different budget is a separate entry. Searches only see history when the caller
  passes a board with its moves: `/api/eval` (eval bar) and `/api/scoreboard` do (`with_history()`); review,
  coach tools and the GM/trick finders not checked.
- **Three different caches:** the local *answer* cache (`data/library.sqlite`, exact match on question +
  position + prompt hash + player colour), the *engine* memo above, and Anthropic's *prompt* cache (5 min,
  server-side). The library stores tool names and inputs only, never engine output.
- **Logo / favicon.** `static/logo-mark.png` (cream silhouette, 256 px), `favicon-32.png`,
  `apple-touch-icon.png` were converted from a user-supplied Pinterest JPEG of unknown licence: check before
  making the repo public. The original and the conversion script aren't kept (luminance → alpha
  `(235 - lum) / 205`, clamped).

### Coach and cost

- **Automatic coach calls are off by default** (user's call, 2026-10-04): the "Auto" checkbox in the Coach
  header (`autoCoach()`, localStorage `autoCoach`) gates the only two Claude calls nobody asked for:
  ⚠ Big moment (`explainBigMoment`) and ⚡ GM moment in bot games (`gmCheck`, which has no per-game cap; off also
  skips its engine check). The replay one-liner and ⚠ Watch out went with Replay mode (2026-10-09). Everything else that calls
  Claude is a click (question, chip, Why?, Walk me through, lesson build). Opening quips are free either way.

- **No cross-game memory.** `S.coach` is recreated (`make_coach()`) on loading a game, a fresh analysis
  board, a new bot game or "New chat". The conversation is server-side, so it survives page reloads
  (`init()` resumes via `/api/review`). The only cross-game context is `prompts/player.md` (hand-written
  profile, sent every question). The coach does **not** read the Lessons library.
- **`prompts/coach.md` and `prompts/player.md` are re-read every question.** Editing either changes
  `prompt_hash()`, so saved exact-match answers stop matching: batch prompt edits.
- **Prompt caching** is on (top-level `cache_control: {"type": "ephemeral"}` in `core/coach.py`): repeats
  within one conversation read the prefix at ~10%. 5-minute cache, nothing persists across sessions, and
  there is no way to "save the cache". Cross-session savings mean replacing a call with a local lookup.
- **Cost drivers** (measured 2026-09-28, `count_tokens`): `player.md` ≈ 360 tokens, `coach.md` ≈ 6,860,
  tool definitions ≈ 8,990; average cache read ~33K/call, so history and tool results dominate.
- **Latency is mostly the Claude API** (measured 2026-09-29: 25-89 s per chip question, API 25-77 s over 3-6
  calls; tools 21 s cold, 0-1 s warm). `COACH_EFFORT=low` or `COACH_THINKING=off` roughly halve it (38 s →
  19-20 s) with no accuracy loss in a small test, but are **not adopted** (user's call: accuracy over speed).
  `Coach.ask()` logs one timing line per uncached question and stores it in `usage.calls`.
- **`move_quiz` fairness is enforced by the engine** (`Coach._check_quiz_fairness`): the answer within 30 cp
  of best, every wrong option ≥ 80 cp worse, else the tool errors and the coach retries. `_final_answer()`
  drops an earlier part that a later part rewrites (difflib ratio > 0.6). The chip text tells the coach not
  to spoil the game's real continuation; if leaks return, fix that wording.
- **Jump buttons / `jump_to_move`:** max 3 per answer, `move` (SAN) validated against the game. **Ply trap:**
  the coach's `ply` is the position *before* the move; the frontend's `goTo(n)` means n plies played, so the
  button calls `goTo(ply - 1)`. `go_now: true` moves the board when the answer arrives (fresh answers only). Stored in `library.jump`.
- **`web_search`** is scoped to naming/verifying an opening the coach doesn't recognise, never evaluation.
  Searches are counted per question (`calls.web_searches`); real-world population of that field is
  unverified; per-search cost isn't in the estimate.
- **Named/"trick" sidelines are prompt-driven** (`coach.md`, "Tricks, not just the engine line"). Not built:
  an explorer check for popular-but-engine-worse moves. Library answer 233 claims the Traxler's `...Nxe4+`
  forks king and queen after 5.Nxf7 Bxf2+ 6.Kxf2; a knight on e4 doesn't attack d1 (not engine-verified).
- **Lessons review loop:** `scripts/lessons_digest.py` writes `data/digests/lessons-YYYY-MM-DD.md` (stats,
  draft recurring mistakes, habit lines, questions). Never auto-edits `player.md`; promote habits by hand
  and generalise them. Habit lines are the coach's advice on single positions, not measured stats.
  `QUESTIONS.md` is the user-facing "how to ask" guide.
- **`player.md`** has "Recurring mistakes" (from the first digest) and "Results by opening as White" (from
  chess.com Insights screenshots; the Black tab isn't captured yet). Both are framed as hints, raised only
  when the position or opening shows them.

### Data sources

- **Two unrelated Lichess integrations:** `frontends/lichess/client.py` (fetch a game or a user's list; no
  token for a single game) and `frontends/lichess/explorer.py` (opening statistics; needs `LICHESS_TOKEN`,
  else `explorer.available()` is false and it's silently off).
- **chess.com vs Lichess shape:** chess.com's monthly archive includes PGN inline; Lichess's game list
  doesn't, so each game needs `lichess.game_pgn(id)`. Matters for any multi-game Lichess work.
- **Offline prefetch** is capped at 500 games (`min(500, req.n)`), each a full Stockfish pass.
- **Explorer walks are slow and rate-limited:** ~1 s per request, serialized; `BUDGET` 20 (`core/openings.py`)
  ≈ 27 s cold. `explore(..., patient=True)` waits out 429s (the coach's tools are patient; the panel and
  `/api/lines` fail fast). `_warm_explorer()` pre-walks after each bot move in the opening (move ≤ 8). Disk
  cache `data/explorer/` (a month). The explorer panel fetches only while Moves & engine is open (`requestExplorer()`; opening it fetches),
  since fetching behind the closed dropdown was ~340 requests an hour and tripped Lichess's 429 (2026-10-06;
  after a 429 every non-patient call fails for 61 s, `RATE_LIMIT_WAIT`). The other big consumer is
  `_warm_explorer()` (~25 masters requests per bot move up to move 8). The explorer panel has no filter UI: `explorerFilters()` is a constant
  (Lichess DB, all ratings, all six speeds listed explicitly, since a missing speeds list means blitz+rapid).
- **ECO table** (`core/eco.py`, vendored lichess-org/chess-openings TSVs in `core/eco_data/`, CC0): indexed by
  EPD, exact positions only. Used for opening quips, lesson names and trap labels; the explorer panel and
  coach tools still use the live explorer's names.

### Games: loading, review, playing on, favourites

- **"Find game by username"** has chess.com, Lichess, Saved (offline) and ★ Favourites tabs.
  `/api/games?site=lichess` maps Lichess's list to the chess.com row shape (AI/anonymous players have no
  rating). The Lichess name is `localStorage` `meLichess`; `state.me` stays the chess.com name.
- **Loaded games open at move 1** (`state.ply = 0` in `setReview()`), including saved games.
- **Refresh keeps the board** (`saveBoard()` at the end of `update()`, `restoreBoard()` in `init()`): a
  localStorage snapshot (`board`: ply, extra moves, orientation, the bot game's `state.play` minus
  `backLesson`/`thinking`), used only when `reviewKey()` matches the review the server still holds, and only
  lines that still replay. Bot games restore via `playView()` and the bot moves if it was its turn; the clock
  doesn't run while away. Not restored: lessons, demos, the chat log (the coach's conversation
  is server-side and continues). Per browser, so each device on the tailnet has its own snapshot.
- **Favourites (2026-10-03).** `core/favorites.py`: a `favorites` table in `data/library.sqlite` (game_id,
  title, names, ratings, result, date, opening, full PGN from `pgn_of()`, so it outlives `data/reviews/`).
  `POST /api/favorites/{game_id}`: `{favorite}` toggles, `{title}` sets a title and favourites the game (""
  clears it); unstarring deletes the row, title included. ☆ sits before the names in `#game-info`;
  double-clicking `#game-title` (in `.board-foot` under the board, hidden when empty), `#board-sub` or `#game-info` edits the title in
  place (`editTitle()`: saves on Enter, blur or any outside pointerdown, because chessground cancels mousedown
  so a board click never blurs). Opening a favourite whose review is gone re-analyses the stored PGN. Loaded
  games only (`canTitle()`): bot games and the analysis board have no game_id. Reviews carry `date` only from
  2026-10-03 (`_date()` in `core/review.py`). Not tested: the re-analyse fallback, Safari/Firefox.
- **Recording a game (⏺, 2026-10-09; user: the move list gets messed up by takebacks, redo, refreshes, so make
  saving a game intentional).** ⏺ (`#nav-rec`, last board button) starts a recording from the line on the board
  (moves already played included): `rec` = `{startFen, moves}` in localStorage `recording`, separate from the
  board's state, so refreshes and mode changes can't touch it. `recTrack()` (end of `update()`): a position one
  move past the recording's end is appended, whoever made it (you, the bot; also ▶ along a loaded game
  from the end). A move made **by hand** (`recPlayed`, set in `onBoardMove`) from a position inside the recording
  that differs from the recorded one replaces the tail (takeback then a new move), with a chat note of what was
  dropped. Anything else (◀ ▶ inside it, other games) leaves it alone: the button greys and its tooltip says
  where the board is. The dialog: the move list, Undo last move, Cut here (board behind the end), Discard,
  title/White/Black/result, "Save to favourites" → `POST /api/recorded` → `favorites.save_recorded()`: a ★ row
  with the PGN and no review pass (game_id = what `/api/load` computes from that PGN, so opening it from ★
  Favourites analyses it and finds its title). Not tested: Safari/Firefox, moves made by scoreboard-row or chat
  chip clicks inside the recording (they don't set `recPlayed`, so they append at the end but don't replace).
- **Saved positions (📌, 2026-10-04).** `core/positions.py`: a `positions` table in `data/library.sqlite`
  (title, the line as start FEN + SAN moves, final FEN, orientation, source like "A vs B" / "Bot game vs …" /
  "Set-up position", deepest ECO name). 💾 under the board (key `s`) or "💾 Save" in the position editor →
  title dialog (suggested: opening + move number); "📌 Positions" in the side nav lists them with static mini
  boards (`miniBoard()`, Unicode glyphs, no chessground), filter, rename, delete. Opening one starts an
  analysis board from the start FEN with the moves as `state.extra`, so ◀ walks back through the line; the
  original game context (names, review) isn't reattached. Server-side, so shared by every device.
- **A loaded game is a review with your side at the bottom; "Play bot from here" plays on from any move.** Replay
  mode ("Replay as [White][Black]": the opponent's game moves auto-played, a deviation offered "Play X vs bot") was
  removed 2026-10-09 (user's call; with it `branchToBot`, `botLevelFor`, `commentOnOpponentMove`, the replay half
  of `gmCheck`). `playBotFromHere()` (the analysis board's button, also on loaded games): the bot game starts from
  the game's start position with its moves up to the shown one (+ any played on the board) as `play.prefix`
  (Takeback and ◀ floor there) and keeps `play.back` for "Back to the game" (`backToGame()`: reopens the saved
  review at that move, your side "you" again via `setYou()`). The level is the picker's, not matched to the
  game's ratings any more. Game ratings go through
  `white_elo_cc`/`black_elo_cc` (`public_review()`): a Lichess game's (`review.from_lichess()`) converted to
  chess.com, a chess.com game's as they are. The ratings shown on screen stay the site's own.
- **Per-move cards when stepping through a game** (`noteMove()`): verdict, played/best with eval pills, ▶
  best line, Why?, Back to my game; built from the saved review (`best_line` etc. in `public_review()`), no
  engine call. Paid: a move losing ≥ 10% win chance (`BIG_MOMENT_PCT`) gets an automatic "⚠ Big moment"
  answer after 1.2 s on it, max 8 per game; it and Why? share `moveQuestion()` so they share the answer cache.
  Why? uses `.note-why` because `syncCards()` disables `.card-why` outside bot games.
- **Chips** (`CHIPS`/`CHIP` in `app.js`, `[label, question, needs, action]`; hover text in `CHIP_TIPS`).
  "Game-changing moment" is free (largest `win_pct_lost`, only "Explain why" costs). "Guess the next move" is
  a `move_quiz`: one quiz per press, the coach never sees the click. Bot games leave out Game-changing moment
  and "What should I have played?".

### Bot games

- **Bot levels:** Maia (~400) … Maia (~2400) (chess.com rapid) every 100 (`maia.BOT_LEVELS`, `server.bot_levels()`), then
  "Stockfish" (full strength). Without Maia installed: the old Stockfish levels (`BOT_LEVELS` in
  `core/engine.py`, uncalibrated). `Maia.play()` samples Maia's top 10 by probability, never one under
  `MIN_PLAY_PCT` 2%. `/api/play/move` passes the game's moves and `opp_elo` (your rating: the side you took over
  in a loaded game, else `PLAYER_RATING`). **Strength per level is not measured.**
- **Opponent card** after each bot move (`showOpponentCard()` → `core/opponent_card`): best move + eval, main
  line, sharper try (only when `tricks.find()` tags a non-top sound sacrifice/trap), threats, loose pieces,
  known-trap rows, "If they…" replies. No Claude call; only **Why?** is paid (sends the "My plan?" chip prompt).
  Speed: `/api/play/move {card: true}` returns `opponent_card.quick()` (depth 14, ~25 ms) with the bot move, so
  the card shows at ~0.5 s; replies follow at ~1.5 s; the full card (depth 20) replaces the top rows at ~6 s
  unless the position moved on. Evals are White's point of view.
- **Opening reactions** ("Caro-Kann player, I see…"): free, `core/eco.py` + `core/opening_quips.py`
  (~65 hand-written lines by longest name prefix), `POST /api/opening`, max 3 per game, ply ≤ 16, standard
  start only. Tactic reactions aren't built.
- **Takeback** is `#pb-takeback` beside the top name row (`.head-row`), shown only in bot games (`syncTakeback()`).
  `#summary` in a bot game shows no "Your move"/"Bot is thinking…" text (removed on purpose).
- **Clock** exists only in fresh "Play a game" games, not in games played on from a position.

### Board (chessground)

- **Right-click/drag** (`drawable.onChange` in `app.js`): we call `cg.setShapes([])` after every change, so
  each call carries only the new shape. A right-drag is your arrow (`userShape()` → `drawings`, per position
  via `drawnShapes()`); a right-click on an empty square, or with a modifier on any square, **fills** it
  (`drawnSquares()` → `sq-fill-<brush>` via `paintSquares()`); a plain right-click on a piece holds its
  **threat arrows**: one per enemy piece it attacks (`movesShapesFor()`, chess.js `attackers()`, so pins and
  whose turn it is don't matter; knights as an L via `knightShapes()`). A second right-click undoes it. Since
  chessground's list is always empty, its left-click erase never fires, so our capture-phase `mousedown`
  listener clears drawings and held threats on a left click.
- **Drawing colours** (2026-10-03, user's call: dark, opaque, no green because it vanished on the dark squares):
  `drawBrush()` reads modifiers on mousedown: none #d35400 orange, ⌃ #b01e1e red, ⌥ #0e7c7b teal, ⌘ #1f3f9e
  blue, fn #6b2fa0 purple (Shift stands in for fn). lineWidth 6 like the threat arrows (chessground scales the
  arrowhead with it). Fills are pastel versions (`.sq-fill-*` in `style.css`). Knight legs use the `…Mid` twin
  brush (arrowhead hidden by `marker[id$="Mid"]`).
- **Two chessground overrides to know about:** (1) it previews a drag in its own brush (can't tell ⌘ from ⌥);
  our mousedown listener recolours `cg.state.drawable.current` on the next animation frame, because its
  draw-start handler stops propagation. (2) Its CSS dims the whole `.cg-shapes` layer to 0.6; `style.css` sets
  it to 1 and every non-draw brush carries the 0.6 in its own opacity.
- **Not verified: fn** (macOS rarely reports it; Playwright can't press it). ⌃ needs a real right-click
  (two-finger); ⌃+click arrives as a left click. `defaultSnapToValidMove: false` (snapping moved arrow ends).
- **No hover arrows on the board** (user's call): hovering pieces draws nothing. Board arrows come from
  right-clicks/drags, the lesson guide, the coach's demos, and hovering a scoreboard row (user's call,
  2026-10-04: rows are the exception).
- **Layout** (2026-10-06 rework; user's calls: board and scoreboard are the focus, chat a narrow feed, panels
  level with the board, "components vertically symmetrical"):
  - **One grid** (`main`): the board column is a **subgrid** of four rows (`.top-row`, `.board-row` = eval bar +
    board, `.bottom-row`, ◀ ▶ buttons; the `.board-head` row above the names was removed 2026-10-09, user's call: it
    was empty in most modes); `.side` (scoreboard + coach) spans rows 2-4, so the panels start at the eval bar's top
    edge and end at the buttons' bottom edge by construction (no JS measuring). `.side` has `contain: size`, so
    its content never stretches those rows: the board decides the height, the panels scroll inside. Any new
    direct child of `.board-col` needs a row (there are exactly four).
  - **The side column fills the leftover width** (2026-10-09; user: with the scoreboard hidden on a laptop the
    coach stayed narrow): `minmax(var(--side-w), var(--side-max, 1200px))`, so `--side-w` is only its minimum
    (the board formula subtracts it) and a height-bound board or a hidden panel widens the panels instead of
    centring margins. Both panels hidden: capped at `--side-w`. **Board size handle** (`#side-resize`, the gap
    left of `.side`, `setBoardMax()`): dragging sets `--board-user` (→ `--board-max`, min 320) on `main`,
    localStorage `boardMax`, double-click clears it. Hidden ≤ 760 px.
  - **Phones and touch** (2026-10-09, user: "way too many things to accidentally click when scrolling"): on a touch
    screen (`TOUCH`, `pointer: coarse`) moves are tap-only: a capture-phase `touchstart` listener on `#board` stops
    chessground seeing touches (it grabbed pieces on touchstart and, with one selected, moved on the next touch), so
    the page scrolls and a clean tap reaches it as the browser's click. The set-up board keeps touch (drag palette).
    Scoreboard rows only show their arrow on touch (`playMaiaMove()`). ≤ 760 px: three screens, Board, Moves (the
    scoreboard) and Coach, flipped by the fixed tab bar `#m-tabs` (`setPhonePage()`, `body.m-moves` / `m-coach`; a
    row tap flips to the board). **Nothing scrolls the page and no scrollbar shows** (user's call): `html, body`
    overflow hidden, `main` is `100svh` minus the top bar, each panel screen is one panel at full height that scrolls
    inside itself, scrollbars hidden everywhere, the top icon bar shrinks its items to fit. The board screen: `--board-w`
    also ≤ `100svh - --m-rest` (330 px, 372 ≤ 360 px wide where the rows wrap; measured iPhone 13 334 px board, SE 196,
    Pixel 7 380). Panel hide buttons, tabs and the split handle don't apply on phones. The game line (☆ names ·
    result) is hidden there. User checked on a real phone 2026-10-09: taps "pretty dang good", the board fits.
    Puzzles on phones (2026-10-10): the top row is name + buttons, then one fixed line (`.pz-status`) for the status
    or the hint (the hint replaces "Black to play"), opening pill hidden, so a hint or a miss never moves the board.
  - **Breakpoints:** ≥ 1680 px: board | scoreboard | coach. 761-1679 px: board | one column with the scoreboard
    over the coach and a drag handle between them (`#side-split`, `setSplit()`, share 0.25-0.85 in localStorage
    `sideSplit`, default 0.66, double-click resets). ≤ 1360 px the nav is an icon rail by itself. ≤ 760 px: one
    column, the nav a top bar of icons (`--head-h` = its height). At 1200×800 the side column is ~680 px tall,
    so the scoreboard scrolls or the coach is small: height is the limit there, the handle decides.
  - **Side nav:** `nav.side-nav`, `--nav-w` 216 px, section labels (`.nav-h`) and icon rows (`.nav-item`, inline
    SVG `.ico`, one 24 px line set shared with the board buttons and panel controls; no emoji). No collapsible
    groups any more (the 2026-10-05 `<details>` tree went). Collapse (`#nav-collapse`, `setNavCollapsed()`,
    localStorage `navCollapsed`) folds it to a 68 px rail with tooltips (`data-tip`); hidden where the rail is
    automatic. Button ids unchanged.
  - **Panels:** both have the same 48 px header (`.panel-head`: title, tools, a minus `[data-hide]` button).
    The players' rating picker is inline in the "Top player moves at ~N ▾" heading (`sbRatePick()`, `.sb-rate`;
    "What players at ~N play" with the eval off), a mirror of `#maia-rating` (2026-10-10, user's call: in the panel
    header it read as a random bot setting). `renderKeyCard()` skips while it has focus and catches up on blur.
    Hidden panel (`setPanelHidden()`, `body.hide-score` / `hide-chat`): a 44 px bar when stacked, a 40 px
    vertical tab when side by side (`.panel-tab`); the side column narrows and the board takes the room.
    In the side column the chat's chips are one scrolling line and "Asking about…" shows only while typing.
  - **Around the board:** `.bottom-row` = the bottom name (`#player-bottom`), then right-aligned `.board-foot` =
    `#game-title`
    (favourites, hidden when empty), `#game-info` (a loaded game's ☆ only), `#board-sub`, and `.board-foot-right` (Moves & engine only while the scoreboard is hidden; its dropdown opens upwards there). Above
    the board: then `.top-row` = the top name (`#player-top`), `.opening-slot`
    (the opening pill: `#opening-tag` only, 2026-10-09, user's call; the slot takes the
    leftover width with basis 0 so a long name shrinks instead of wrapping the row, the pill is centred in it and
    hidden with no opening; its own line ≤ 760 px), and `.head-row` (`#summary`: Play bot from here / game status and
    buttons / the editor's buttons, `#pb-takeback`).
  - **The line under the board** (`setFoot()` → `#board-sub`, 2026-10-10; user: "it can be really helpful or really
    confusing", after "Opening puzzle · Your game vs … · Caro-Kann Defense: Advance Variation" under a your-mistakes
    puzzle): one line saying what this board is, never what the rows above already say (names, opening pill,
    status). Loaded game "You won · Oct 4, 2026" (`resultWords()`, `gameDate()`; ☆ in `#game-info`); bot game "Bot
    game" / "Playing on from A vs B" (`play.from`) / "Played on from the X lesson" / "Endgame drill · Hold it · …";
    puzzle "From your game vs X" / "Lichess puzzle · rated ~N"; lesson "Lesson · <name>"; coach demo its title
    (+ "· your own moves"); Explore lines the file's name; editor and analysis board nothing.
  - **Sizes:** `--board-w` = min(`--board-max` 880, `100vh - --head-h - 244px`, the width left beside the nav and
    `--side-w`); `--strip` (rank labels only, 18 px; 0 on phones, where the labels sit inside the board so it's
    centred). 1440×900: 656 px (height-bound); 1920×1080: 820.
  - **Spacing** (2026-10-09, user: "this is to the max, add padding around pretty much everything"): page padding
    28 px / `--pad-x` 40, `--gap` 32 (board ↔ panels), row gap 12, 24 px between the panels, 20 px inside them.
    Cost: the board is ~55 px smaller on height-bound screens. The page must not scroll: recheck the 244 px when
    adding a row (it was short by 2 px once: the page scrolled at 1440×900).
  - **Eval bar** (2026-10-09, user's call after Chessiro; the vertical one left the board off-centre on a phone):
    horizontal, 20 px, above the board inside `.board-row`, White's share filling from the left whichever way the
    board faces, words instead of a number (`evalBarWords()`: banded by White's win %, < 5 Equal, < 15 slightly
    better, < 30 better, < 42 crushing, else dominating, mates as "White mates in N"; first guesses). The number is
    in its tooltip. Not the same as the older `evalWords()` (pawn bands, eval-pill tooltips and move cards).
  - **Colour tokens** (`:root`): `--inset`, `--hover`/`--hover-2`, `--faint`, `--maia`, and one severity scale
    `--t0..--t3` (+ `--t3-text`) for win chance lost (< 5, 5-15, 15-30, 30+), used by every scoreboard mark.
  - **Full Explorer** (was "Moves & engine", renamed 2026-10-09; `.game-panel`, dropdown `#gp-details`) sits in the scoreboard's header, first in
    `.panel-tools` (2026-10-09, user's call; `dockGamePanel()`, also on `setPanelHidden()`); while the scoreboard
    is hidden it goes under the board (`.board-foot-right`). The panel is a size container: under 400 px the
    "Players" label hides, under 340 px the button reads "Explorer". In the header the
    dropdown anchors to the panel (`.score-panel` is `overflow: visible`, the body keeps the rounded corners), right
    edge, under the header, so it never covers the board (the editor palette lives in it). Draggable/resizable (`position: fixed` on first drag), starts closed on
    every load (only "Set up position" opens it), closes only with ✕, folds the moves list to 5 rows
    (`FOLD_ROWS`).
  - **Static files aren't cache-busted:** no `Cache-Control`, so a browser can keep an old `style.css`/`app.js`
    after edits. Ask for a hard reload (⌘⇧R) before chasing a layout report that doesn't reproduce.
- **Analysis board: "Play bot from here"** (2026-10-09, user's calls: always there; the level picker only after
  it's clicked, then the button reads Start, ✕ cancels; `abPicking`, kept across re-renders and moves, reset by `setReview()` so a
  new board never opens with it showing). In
  `#summary` whenever the board has no game moves (FEN, 📌 position, editor's Analyse): `#ab-level` (the Play
  dialog's levels shown as "Bot 1500", shared localStorage `botLevel`) + `playBotFromHere()`: you take the side at
  the bottom, the line on the board becomes `play.prefix` (◀ walks it, Maia sees it), no clock; the bot moves first
  if it's its turn. Loaded games too (see "Games").
- **Position editor** ("Set up position", `openEditor()`): presets, side to move, FEN box; Play vs bot from
  here, Analyse, or Cancel. `editorFen()` infers castling from home squares and writes `- 0 1`. Not tested:
  opening it mid-lesson.

### Chat rendering

- `markdown()` → `inline()` in `app.js`, regex-driven (SAN chips, eval pills, glossary, `.lbl` lines, "Pro
  tip", numbered `ol.points` cards). A numbered card plays its `.san` chips in order on click
  (`addLineButtons()`); a card with no SAN can't be shown on the board. Elsewhere the chips themselves are the
  demo trigger (hover previews, click opens the demo board).
- **Known overlap:** the coach's `show_on_board` tool still adds "▶ Show me: …" buttons at the bottom of a
  message, which can duplicate what the inline chips already show. User wants to keep using it before
  deciding.
- **Accepted quirk:** a bare pawn move with no number/capture as a block's first token ("f4") renders as a
  square (`.sq`), not a move; `.msg.coach strong:has(.san, .sq)` keeps it readable. Same in lesson text.
- Move chips in the Game-changing note drop the move number ("Be6", not "9...Be6"). Cosmetic.

### Maia

- **Maia-3** (`core/maia.py`, CSSLab 2026): what a player of a given rating (400-2400) plays, with
  probabilities.
- **Every rating in the app is chess.com rapid** (user's call, 2026-10-07: they play 10+5, ~all rapid). Maia
  was trained on Lichess, so `Maia.moves()` converts with `core/ratings.py` (`to_lichess()`) right at the model,
  and nothing else sees a Lichess number. The table is Chessiro's rapid converter (survey, ~20k players,
  ±100 expected), interpolated, end slopes extended outside it (below chess.com 815 is a guess). Checked on one
  real pair: the user's 790 chess.com / 1246 Lichess (table: 1271). Old localStorage keys (`maiaWhite`,
  `maiaBlack`, `maiaRating`) held Lichess numbers and are ignored; the picker starts at `PLAYER_RATING`.
  Lessons built before then stored `human_rating` 1300 (Lichess); `study.load()` shows it converted (~830)
  unless `human_scale` is `chesscom`. Still on Lichess's scale: the explorer's rating bands (Lichess DB filters,
  e.g. `CURVE_RATINGS`, the coach's `db='lichess'` bands). Not converted: a chess.com blitz/bullet game's
  ratings (taken as rapid). Panel: "Human moves" under Stockfish's lines with **one rating for both sides** (`maiaRating()`, `#maia-rating`,
  localStorage `maiaElo`; the opponent at the same rating; user's call 2026-10-07: Stockfish's list is the
  absolute one, Maia's "the typical player"; the scoreboard's picker in the Top player moves heading mirrors it); a row click plays the move where `canMove` allows it. `pct` is "how likely a
  human plays it", never quality.
- Setup per clone: `pip install git+https://github.com/CSSLab/maia3.git` (not in `requirements.txt`, torch is
  ~600 MB); the checkpoint downloads from Hugging Face on first use. Missing package = section hidden
  (`maia.available()`). AGPL-3.0: fine for a personal tool, matters if distributed or hosted.
- Runs in-process on `mps` under its own lock, lazily loaded (~2.5 s first request, then 0.04-0.1 s). Uses the
  internal `Maia3UCIEngine` API (`cmd_position` + `score_moves()`) of a 0.1.0 package: recheck after upgrades.
  **Send the move history** (it reads the last 8 positions).
- Maia-1 (lc0 + band weights) was tried first and replaced: its answers jumped between neighbouring bands.
  lc0 and `data/maia/*.pb.gz` are still on this machine, unused. Maia-2 needs Python ≤ 3.12.

### Scoreboard (`core/scoreboard.py`, `renderKeyCard()` in `app.js`; redesigned 2026-10-06)

- **Built around the two moments a move's numbers matter** (user's call, 2026-10-06): before your move ("what
  does a ~600 / a GM play here, is it any good, what are the 5 best") and after it ("was it good or bad, how
  much": "You played b8, the 28th best move"). **Each row shows the eval after that move**, from
  White's side like the eval bar (`sbEvalAfter()`: "+1.50", "−0.31", "#3", "#−2"; so on Black's turn the best
  row has the lowest number), coloured by win % lost for the mover. White's view since 2026-10-07 (user's
  call): from the mover's side the sign flipped every card and "−0.59 then +0.65" didn't read as one eval. History: costs
  ("pawns behind the best") from 2026-10-06, because "is +1.00 per move cumulative?" was confusing; then a mixed
  column (best row an eval, the rest costs) misread as "the best move is the worst"; evals after the move since
  2026-10-07 (user's call). The number is the best move's eval minus `cost`, not the row's own `eval_white`:
  `ranking()` clamps costs so a depth-10 move past #5 never reads better than #5, and its raw eval can. **The eval
  bar takes the #1 row's number** once the scoreboard's deep search for that position is in (`setEvalBar()`,
  called by `showEval()` and when a scoreboard result lands), else its own 0.6 s search, so the two agree.
- **After your move** (`sbAfter()`, on top): eyebrow "You played 9. Nxe5" (the move at 24 px, weight 300) + grade pill (Best move / Excellent < 2 /
  Good < 5 / Inaccuracy < 15 / Mistake < 30 / Blunder, `sbGrade()`; loaded games use the review's
  `win_pct_lost`), a flat strip of every legal move with yours raised (`.sb-rankbar`), and one fact: "Best was
  X" (not for the best move). Tinted with the grade's colour. User's calls (2026-10-06): no move/cost line ("f3
  −1.20 pawns" removed), no rank text ("9th best of 39 legal moves"), no other facts ("Most ~N players play Y",
  "Most popular with ~N players").
- **Before your move** (`sbBefore()`): no headline, no label and no hover text (user's calls: "N of M moves are
  safe" and the every-move strip `sbSpectrum()` removed 2026-10-06; the "Black to move 6..." eyebrow and its
  hovered-move text "exf6 · #2 · 11% play it" removed 2026-10-07, the strip above says whose move it is; the
  searching dot sits in the first list's header), then **two lists
  on the same columns** (user's call: one absolute, one "the one you look at", adjustable on the fly):
  **Top bot moves** (Stockfish's top 5, the same at any rating) and **Top player moves** (Maia's top 5 at the chosen
  rating, by popularity; headers are only these names, no column labels, user's call 2026-10-06), each row with Stockfish's rank and the eval after the move; Top player moves also has a Maia-blue popularity
  bar (`sbCandidates()`; no % number on the row, user's call; the bar's tooltip says "N% of ~R players play it"). The bar
  was dropped from Top bot moves 2026-10-07 (user's call: it read as "the move the bot is likely to play"), and that
  header carries a "White/Black to move" cue (`.sb-turn`), since on Black's turn the best row has the lowest number. Then **Top pick by rating** (`sbTrack()`: Maia's favourite at 400 … 2400 as runs along
  one track coloured by cost, your rating marked, "Engine X" beside it). **The rating switches instantly**
  (measured 0.18 s, no request): the search carries Maia's top 10 at every picker rating (`ladder`),
  `sbPcts()` reads the chosen one, and `sbCache` is keyed by FEN only. Hovering any move (row, segment, the
  engine pill) draws its arrow; clicking a row plays it
  (`playMaiaMove()`). Quick numbers (`lastEval`/`lastMaia`, `sbQuick()`) fill the candidates at once; the track
  waits for the deep search (skeletons). Eval off (bot game without it): only "What ~N play" (Maia). The card fills the
  panel and spaces the lists and the track with `space-around` (`.sb-body`, user's call 2026-10-07).
- **Maia's lines** ("▸ Full lines" in the Top player moves header, localStorage `maiaLines`, 2026-10-07): under
  each player move, how ~N players typically go on: Maia's top move for both sides at the picker's rating, 8
  more moves (`scoreboard.maia_line()`, `POST /api/maia_line`, one line per request on `S.full_card_engine`),
  each with Stockfish's eval after it (depth 12 / 0.5 s, White's view) and coloured by the win % it cost its
  mover. The first move isn't repeated (it's the row, with the deeper number). Measured: 1.5 s for the first
  line (Maia cold), 0.25-0.4 s each after, 5 lines in ~3 s; `requestMaiaLines()` fetches one at a time, each
  render asks for the next (`mlCache` by FEN + rating + move). Top move every time plays a bit above the rating,
  so it's "the typical continuation", not a likely game. Depth 12 still swings a little at big evals (a +6.8 →
  +4.4 step can flag a move); not checked against deep searches. Not built: clicking a line to play it, the
  "practical move" ranking built on these lines.
- **Whose moves:** `sbTargets()`/`sbUser()`: the bot game's colour, else the review's `player_color` (the side at
  the bottom when the game opens); null on the analysis board ("Last move", "White to move"). In a bot game the
  opponent's turn isn't searched ("Bot is thinking" skeleton). `requestScoreboard()` runs the board's position
  first, then your last move's (with `include`), one after the other.
- **Server** (`scoreboard.build()`): two searches at once, the deep top 5 (`DEPTH` 16 / `MAX_SECONDS` 3) on one
  sb engine and **every legal move** at `FULL_DEPTH` 10 / `FULL_SECONDS` 1.5 on the other (it also scores Maia's
  moves and `include`), so the wait is the top 5. Until 2026-10-06 a depth-16 search of Maia's moves ran before
  the full one; dropped for speed (user's call): 40 positions of a saved game went from 2.7 s to 1.44 s average,
  the browser card from 2.8-6.8 s to 2.1-2.4 s per step. Costs past #5 (Top player moves rows outside the top 5)
  are depth 10. `ranking()` → `all`: the deep top 5 first, the rest by the shallow number, never better than #5,
  drops kept non-decreasing. `ladder`: `maia.moves()` at every `maia.RATINGS` value (400-2400 step 100, top 10
  each, opponent at the same rating), in a thread beside the searches (≈0 s warm). `sf`, `humans`, `extra`,
  `alerts`, `odds` are still returned; the frontend no longer shows `alerts`.
- **Latest wins:** `SB_LOCK` + `SB_LATEST` return `{"stale": true}` for a request a newer one overtook. Cached
  client-side (`sbCache`, by FEN) so stepping back is instant. The ladder's opponent is at the same rating,
  unlike the old `humans` list (`opp_rating`); the frontend no longer reads `humans`.
- **Opening name** (`requestOpening()`, `POST /api/opening_line`: every ECO-named position along the line):
  `#opening-tag`, in a pill in the top name row since 2026-10-09 (before: the page's title, first in the old `.board-head` row;
  2026-10-05; `#board-sub` no longer repeats the review's opening, so a game the ECO table can't name shows
  none) shows
  the deepest name at or before the shown move, growing with variations (Caro-Kann → … Advance Variation →
  …, Botvinnik-Carls Defense). Exact positions only, so transpositions into a named line are found but a
  move-order the table lacks isn't. In bot games the older opening quip can name the same opening again.
- **Removed 2026-10-06 (user: "a lot of it doesn't make sense or isn't needed"):** the win strip (same numbers
  as the eval bar), the White's/Black's view labels and depth pill, the Stockfish/Maia twin lists, and every
  scoreboard chat card (your/their move alerts, next-play alerts, big plays). `alerts()` on the server stays,
  unused; the endgame trainer still uses the `.sb-msg`/`.sb-alert` card styles.
- **Thresholds are first guesses** (tiers 5/15/30 win %, "holds" < 5), not tuned on games.
- **Do the row numbers mean "the score if played"?** (`python -m scripts.scoreboard_eval [--positions 30]`, ~9 min;
  user, 2026-10-09: "a good move near the game score turned out a blunder when clicked"). Each shown move is played
  and the next position searched as the app does. 30 positions from the user's games: mean gap shown vs real 1.2
  win % (deep top 5), 2.1 (depth-10 rest), 2.1 (the quick 0.5 s Maia scores before the deep search lands); "looked
  fine (< 5 lost) but lost ≥ 15" in 4 of 376 rows, all one lost endgame (−4 shown, mated in fact). Not reproduced.
  Suspected instead (not checked on a real case): grades are win % lost, steep near equality (+0.37 → +1.20 for
  Black reads "near" in pawns but is a Mistake). Waiting on a screenshot of a real case.

### Game report (`core/report.py`, `GET /api/report`, "game report" in `app.js`, 2026-10-09)

- User's pick from looking at Chessiro/Chessvia/Aimchess (none of them teach openings; their strength is the
  post-game report). For loaded games only: at move 0 the scoreboard panel shows the whole report instead of the
  cards; after it, a strip (graph + accuracies, "▸ Game report" opens it above the cards, localStorage `reportOpen`).
- From the saved review, no engine: White's win % graph (click anywhere or a dot to jump; dots = inaccuracy and
  worse), accuracy per side (Lichess's formula written from memory, not checked against lila's source; reviews are
  0.3 s/position, so it won't match Lichess's number for the same game either), counts per grade on the
  scoreboard's scale (`sbGrade()`: Best / Excellent < 2 / Good < 5 / Inaccuracy < 15 / Mistake < 30 / Blunder),
  plus Book = moves while every position so far is in the ECO table. "Practice from this game": the game's
  missed/allowed groups from `data/my_puzzles.json` (button = that group in Your mistakes, chips jump to the move);
  games the miner hasn't seen say so.
- **Layout** (2026-10-10 restyle; user: "almost super cool but looks a bit off"): one three-column grid (`.rp-table`:
  White | labels | Black) for the player tiles (colour chip, name, accuracy, "Your accuracy" + green border on yours)
  and the grade rows, so they line up; counts coloured by grade when non-zero, zeros faint; no now-line at move 0.
- Not built: grade icons on the board, a time graph (reviews keep no clock times; chess.com PGNs have `%clk`, not
  checked), a game rating estimate (declined: a guess on a guess).

### Tactics finder (`core/tactics.py`, "Tactics finder" in `app.js`, 2026-10-07)

- **Detector:** a tactic = one clearly best move: win % gap between Stockfish's #1 and #2 ≥ `MIN_GAP` 20 and
  the mover ≥ `MIN_WIN` 60 after it, or the only mating move whatever the gap (2026-10-09: from +5 a mate barely
  moves win %, so those were invisible; this also fires the live alert when you're already winning). Board geometry along the best line names it (`motifs()`: mate, fork,
  skewer, pin, discovered, hanging = a capture netting ≥ 2); headline = mate, else the motif on the earliest
  move. A plain trade-back recapture is skipped (needs the board's move history). `find()` searches itself
  (depth 16 / 2 s, multipv 2); `from_lines()` reuses lines, and `scoreboard.build()` returns `tactic` from its
  deep top 5, so the live check costs no extra search.
- **Validation** (`python -m scripts.tactics_eval [--per 40] [--games 200]`): Lichess puzzles from
  `data/puzzles/sample.csv` (first 60k lines of the CC0 puzzle DB, gitignored; stream it again with `curl -sL
  https://database.lichess.org/lichess_db_puzzle.csv.zst | zstd -dc | head -n 60001`), theme tags as ground
  truth, plus random positions from `data/reviews/`. Run 3 (2026-10-07, ratings 600-2000): right first move 100%
  whenever it fires; fires 92-100% per theme; headline right: mate 100, skewer 98, fork 95, hanging 87,
  discovered 74, pin 59; on untagged puzzles it still claims a motif 59% of the time (not checked by hand); 3%
  of game positions flagged (~2-3 per game), all six looked real by hand. ~9 min per run.
- **Free piece vs tactic** (2026-10-09; user: ~90% of alerts were hanging pieces, "that isn't a tactic", wanted
  "capture X forces Y, then Z is free"): `kind_of()` → `kind` `mate` / `tactic` / `free`. Free = the first move is a
  capture netting ≥ 2 by static exchange and the line (`_line_gain()`, mover's first 3 moves + replies, a cut
  exchange settled by SEE) wins at most `FREE_SLACK` 1 more. A `tactic` drops the "hanging" motif. New motif
  `defender` (removing the defender: a later capture wins on a square a piece of theirs defended at the start and
  no longer does, taken or forced away). Eval run 2026-10-09: Lichess `hangingPiece` puzzles 60% free, every other
  theme 0-5% (untagged 14%); `defender` (capturingDefender/deflection/overloading) named 60%, headlined right 10 of
  12 times it was the headline (small sample); 300 game positions: 11 flagged, 2 free.
- **UI:** a free piece is a one-line "Something's hanging" alert with Show (no ladder; lists blurred until Show),
  "Took the free piece" / "Missed a free piece: X" after the move. Otherwise, on your turn (any turn on the analysis board), a "Tactic available" box at the top of the live card
  with a hint ladder (`sbTactic()`, `tacLevel` by FEN, per page load): what to look for → the piece (ringed,
  `tacticShapes()` in `baseShapes()`) → the move (arrow, line, eval). Only mate/fork/skewer/hanging are named
  (`TAC_NAME`, plus removing the defender); pins and discovered attacks get "look for a forcing move". Until the move is shown the lists,
  the engine pill and the track are blurred (`.tac-hide`; Top bot moves' #1 is the answer). The after-move strip
  says "Found the fork" / "Missed a fork: Nxe2" in place of "Best was X" (`sbAfter()`).
- **Known gaps:** the quick numbers (before the deep search lands, ~2 s) show the lists unblurred, so the answer
  can flash first; the eval bar still hints. Not built: "watch out" (their tactic, needs a search as if it were
  their move), better pin/discovered rules, tactics from your games as puzzles.

### Opening puzzles (`core/puzzles.py`, `scripts/puzzles_import.py`, "opening puzzles" in `app.js`, 2026-10-08)

- **Data:** Lichess's puzzle database (CC0). Lichess tags a puzzle with its game's opening only before move 20
  (checked on the 2026-10 dump: 1.22M of 6.16M tagged, all moves 1-19), always two tags: family
  (`Sicilian_Defense`) and variation, the ECO name up to its first comma (`Sicilian_Defense_Najdorf_Variation`).
  The importer keeps only tagged rows (`data/puzzles.sqlite`, ~420 MB, ~1.5 min, streams the `.zst` through
  `zstd -dc`; writes a temp file and swaps it in, restart the server after to drop its caches). Per clone. Tag →
  proper name (`label()`) by normalising the vendored ECO names the way Lichess does (`tag_of()`); unmatched tags
  show with spaces for underscores. 1.d4 f5 2.Bf4 (London vs Dutch) has no ECO name: it's in
  `Dutch_Defense_Other_variations`, not separable by tag.
- **Patterns:** a puzzle's first move is the blunder (the "trigger"), the second the solver's answer. Pattern key
  = solver + answer piece + capture or not + destination square + main motif (`MOTIFS` priority order), e.g.
  `w:Pxe5|fork`. Listed when ≥ `MIN_PATTERN` 15 and ≥ 0.3% of the selection. **Lift** = share in this opening ÷
  share in all *other* tagged puzzles (both sides, so a side filter doesn't move it); ≥ `TYPICAL_LIFT` 2 =
  "Typical of this opening" (sorted by n × log2 lift), the rest "Common here, and everywhere". A trigger ≥
  `TRIGGER_SHARE` 40% of its pattern shows as "after …Nxe5 (96%)" (the "if they play X" cases: London …Nxe5 →
  dxe5 fork, Najdorf Nd5 → …Nxd5, Dutch …Nxh5 → Qxh5+); scattered triggers only in the row's tooltip. Most
  typical patterns are still mates on specific squares; no hand check of the patterns beyond those examples.
  Template titles ("…Bg5 pin", "Qxh7#"); the Claude naming pass is not built.
- **Picking:** `pick()` widens the rating band (±100/200/400/any) and drops the quality filter (popularity ≥ 60,
  plays ≥ 30) last. Within each band it prefers *spicy* (a `SPICY_THEMES` tag: sacrifice, quiet move, deflection,
  decoy, clearance…) over plain, and serves *lame* ones (`oneMove`, or motif hangingPiece/other: take the loose
  piece) only when nothing else is left (2026-10-09, user: "hanging a queen should never be a tactic or a puzzle").
  Lame motifs are also left out of the pattern lists. Tested: 30 Sicilian picks at 1000, all spicy, 0.11 s each.
  The result card's "Why" line lists the spicy themes and the length (`flavour`); skips the last 300 ids (localStorage `pzSeen`). `/api/puzzles/next` also starts a fresh
  analysis board at the puzzle's FEN (before the trigger) with a coach note that says not to give the answer.
- **Puzzle mode** (`state.puzzle`): trigger plays after 0.7 s, replies after 0.45 s; the solution's exact move
  or any mate is accepted. A wrong move = missed (circle, then arrow); Hint ladder: theme (free), piece, move
  (both count as missed); Skip counts as missed. While live: eval bar, scoreboard (a "hidden" note), Maia,
  explorer, chips and ◀ ▶ are off (`puzzleLive()`); after it's over the board is a normal analysis board with the
  engine back on. Not restored on refresh (like lessons). Level: Elo vs the puzzle's rating, K 40 for the first
  20 then 20, start 1000 (`pzRating`/`pzCount`); stats per topic and per topic × pattern in `pzStats`.
- **Not built:** the Claude naming pass, live "this pattern is coming" alerts during games (the "watch out"
  TODO), filtering London-vs-Dutch by structure.
- **Your mistakes** (`core/my_puzzles.py`, Chessiro's "Replay Mistakes" idea): every move of yours in
  `data/reviews/` that lost ≥ `MIN_LOST` 10 win % gets two checks with the tactics finder (depth 16 / 2 s, board
  with history): *missed* (on your turn one move clearly won and you played another; trigger = their previous move,
  you solve) and *allowed* (after your move they had one; trigger = your move, you solve from their side, board
  flipped). Mates are also checked when your move lost little (the review's eval says you had mate, or your move
  allowed one). The solution runs on while each next solver move is again the finder's one clear move, up to 3; a
  mate ≤ 5 is played out to mate (`_to_mate()`: Stockfish's PV often stops short).
  **What's kept (VERSION 2, 2026-10-09; user: "hanging a queen should never be a tactic or a puzzle", "the coolest
  tactics may not yield the biggest swing"):** free pieces (tactics `kind` "free") never; the rest by `spice()`:
  log10(100 / Maia's % for the first move at `PLAYER_RATING`) + sacrifice 1.0 + quiet first move 0.7 (only under
  40% find it) + 0.4 per extra solver move + 0.3 for a named idea; under `MIN_SPICE` 1.0 dropped; `pick()` serves
  the highest first (random among the top 3). Weights are first guesses from a 30-game dry run. Re-mine 2026-10-09:
  233 puzzles from 612 games (142 missed, 91 allowed; 56 missed mates; 25 sacrifices, 126 quiet first moves), 89 min
  at 8 threads; VERSION 1 had 283 from 379 (backup `data/my_puzzles.v1.json`). The result card's "Why" line shows
  the tags. Cards say "Your game vs X" and link the game on chess.com/Lichess at that move (`pzGameLink()`, start
  and result card; whether chess.com lands on the move isn't checked); the dialog's Lichess footer is hidden on
  this screen (it made the user think these were Lichess puzzles). Stored per game with `VERSION` (bump to re-mine) in `data/my_puzzles.json`, with
  the user's names and accounts. **The user's chess.com account was renamed `sirwill3rd` → `O-O-O-F4ce`** (found
  2026-10-08: chess.com's live-game endpoint names the same player differently; the old name 404s on the API). Older
  reviews say sirwill3rd, newer ones O-O-O-F4ce. **Accounts (user, 2026-10-08): chess.com `O-O-O-F4ce` and
  `PawnSoloOfficial`, Lichess `sirwill3`**; `accounts` is a list per site, `me` adds the old sirwill3rd, and a name a
  site 404s on goes to `gone` (`drop_account()`, one warning) so a browser's stale Find games name isn't re-added. CLI `python -m core.my_puzzles [--me …]`;
  **"Update from my games"** in the list (`/api/puzzles/mine/update`, `MINE_JOB`, own Stockfish, 2 threads): the last
  `UPDATE_GAMES` 30 games per site (Lichess skips already-reviewed ids before fetching PGNs), reviews the new ones,
  then mines every unmined game; one site failing becomes a warning, not a stop. ~20 s per game to mine with 4
  threads. Served unrated (the puzzle level doesn't move), grouped by kind × motif ("Forks you
  missed"); the result card says what you played in the game and has "Open the game here" (the saved review at
  the trigger). Yield is low by design: most of the user's ≥ 10% losses are positional, not one-clear-move tactics
  (e.g. a trapped knight at a 16-point gap, under `MIN_GAP` 20). First run (2026-10-08): 134 puzzles from 179
  games (51 missed, 83 allowed; most common: loose pieces you allowed, 36), 22 min; with the renamed account and the
  first "Update from my games", 282 from 379 games. Cross-check: Vito's Lichess
  Tactics Generator (vitogit/pgn-tactics-generator, depth 8) on 20 of the same games, `data/my-lichess-tactics*.md`:
  53 positions, 20 confirmed by our finder (all in our set), the other 33 small evals or several winning moves.

### Endgame trainer (`core/endgames.py`, `core/tablebase.py`, "endgame trainer" in `app.js`, 2026-10-04)

- 365chess-style (user's reference: set_endgames_training.php): "♔ Endgames" (side nav, Learn group) → a stepper (2026-10-09,
  user: all options at once was overload; `renderEndgames()`, `egStep`): 1 goal, 2 type (the preset group), 3 pieces,
  4 side, 5 opponent + Start drill, crumbs on top show the remembered picks (`egChoice`, localStorage incl. `egGroup`,
  `egSpec`) and jump back; "Pick other material" on a drill card opens step 2. The material tiles (`PRESETS`: mates, pawns, rooks, queens, minors, random 4-7 pieces, pawn structures of 6-10
  pawns); the server makes a fresh random position (`generate()`) and you play it against the opponent picked in
  the dialog (`egBotLevel()`): Human = Maia at a rating (`#eg-elo`, default `PLAYER_RATING`; user's call 2026-10-08:
  Stockfish almost never) or full-strength Stockfish; localStorage `egOpp`/`egElo`. Eval bar off (the scoreboard hides with it).
- **Pawn endings (2026-10-08):** `pawns:N` splits the pawns evenly (one apart when N is odd; was a random split, so "6 pawns" could be 5 vs 1). "Dead even" (`pawns:even`, user's idea) replaced "Any pawn ending": N vs N+2 pawns (`EVEN_FEWER` 1-3),
  your king in `CENTRE` (c3-f6), theirs on its back two ranks, pawns on their own half + 1 (`EVEN_PAWN_RANKS`), no promotion in the depth-8
  line (else 0.00 is often a queen race into perpetual), kept only if it's a draw (tablebase, or |eval| ≤
  0.30 at depth 22); always a Hold-it drill whatever mode is picked (`egModeFor()`). The goal card has "New position" / "Pick other material", so you can skip
  mid-drill (before, the next position came only from the result card).
- **Modes:** Win it (you're winning), Hold it (draw). Material lies (down material yet a draw or a win) was removed
  2026-10-08 (user's call: Dead even covers its best case); a stored `egMode` "lies" falls back to Win it.
- **Truth:** ≤ 7 pieces → Lichess tablebase API (`tablebase.probe()`, no token, in-memory cache, one request at
  a time; cursed wins / blessed losses count as draws). Bigger set-ups → Stockfish depth 22 / 2 s (|eval| ≤ 0.3
  = even, ≥ 2.5 = winning), labelled as engine. A depth-8 search filters candidates first; ~0.5 s per drill
  measured. Starts are clean: no checks, no captures available to either side, pawns ≥ 2 steps from
  promoting, bishop pairs on opposite colours, tablebase wins ≥ `MIN_DTM` 10 plies. Impossible asks (a draw
  with K+Q vs K) give up after `GIVE_UP_AFTER` 80 candidates with a 422 message.
- **During play** (tablebase only): each of your moves is looked up in the probe of the position before it
  (`egAfterMyMove()`); a move that drops win→draw or draw→loss gets a red card with the best moves. A takeback
  re-reads the goal from the tablebase (`egTakeback()`). Result card at the end (`egGameOver()`), Hold it also
  completes after `EG_HOLD_MOVES` 30 of your moves; "Another one" repeats the same set; the game-over
  row's "Try again" (`egRetry()`, 2026-10-10; was "New game", which opened the Play dialog) replays the same position. Stats per set + mode
  in localStorage `egStats` (done/tried on the tiles). Needs internet for the tablebase; offline, everything
  falls back to Stockfish.
- Not built: curated classic positions (Lucena, Philidor, Réti… still only the editor's 7 presets), DTM-based
  "you took N moves, best is M", the bot defending with tablebase moves instead of Stockfish, coach chips
  aware of the drill. Captured-piece rows now count from the game's start position.

### Opening lessons (`core/study.py` + the "opening lessons" section of `app.js`)

- **Build** (once per opening, saved to `data/studies/<slug>.json`): (1) trunk = the ECO line; (2) breadth-first
  walk of the **masters** explorer (`EXTRA_PLIES` 10, `MAX_NODES` 90, `OPP_WIDTH` 3/3/2/2/1, tries ≥
  `MIN_SHARE` 8%, stop under `MIN_GAMES` 30); your move = masters' most popular unless the engine's top master
  move is ≥ `PREFER_GAP` 20 cp better, or the popular one is > `ENGINE_SLACK` 60 cp worse; (3) engine eval per
  node; (4) one structured-output notes call (`STUDY_MODEL`, default `claude-opus-5-5`, ~$0.25, 76-126 s);
  (5) `tag_overview()` (moments) and curveballs. Rating is deliberately not a factor in the main tree. A cold
  build is 4-6 min; `POST /api/study/build` runs it in a thread (`STUDY_JOB`, one at a time). Lichess castling
  (`e8h8`) goes through `board.parse_uci()`.
- **Notes quality:** Sonnet with only the move list wrote chess-wrong notes. Fixes: each row carries board facts
  from `features.move_effects` plus engine choices, and Opus writes them. `_verified()` drops a note naming a
  move that isn't in the tree or legal along its line. Plan claims aren't machine-checked.
- **One side per opening** (`study.side(name)`, no colour picker, user's call): whoever chose the named line.
  Defense/Countergambit/Counterattack/Accepted/Declined → Black, Attack → White ("System" deliberately not a
  keyword), gambits by material after the opponent's best capture (`_gambit_balance()`), else the last mover of
  that part's ECO entry. Misfires go in `SIDE_OVERRIDES` (Marshall Attack → Black, Ruy Lopez: Closed → White).
- **Family lessons:** `lesson_key(name)` makes a picker row the family when it has its own ECO entry and ≤
  `FAMILY_MAX` 60 names, else its variation group. `_seed_family()` adds every family line passing through the
  lesson (opponent moves however rare, `source: "named"`; your moves only within `ALT_SLACK` 45 cp, `alt: true`)
  plus `SEED_EXTRA` 4 plies; cap `FAMILY_MAX_NODES` 220. Caro-Kann and Dutch are built this way (both at the
  cap). Lessons built earlier under a family name (Vienna Game, Catalan, QGA…) are the single-path kind until
  rebuilt. Transpositions from other families aren't merged.
- **Picker:** `study.search()` returns one row per variation group (name before the first comma) with subs;
  `in_lesson` marks subs the built lesson already contains. `study.load()` fills `node.opening` from
  `eco.lookup()` on every load.
- **Curveballs:** `add_curveballs()`: per opponent node, Lichess-DB moves by 1000-1800 players (≥
  `CURVE_MIN_GAMES` 20, top 4 non-lesson) that lose ≥ 120 cp at depth 18, with `punish` moves (within 50 cp of
  best). Frontend fires one with `CURVE_CHANCE` 0.3, max one per run through a line, never on the opponent's
  first move; you must find a punish move (circle, then arrow on misses). Don't count for mastery. Existing
  lessons: `python -m core.study curveballs [slug…]`.
- **Moments:** `tag_overview()` gives each overview bullet a title and up to 4 node ids (`study["moments"]`);
  cards show not-yet-seen bullets as callouts, the start card a checklist. Older lessons:
  `python -m core.study tag [slug…]`.
- **Human moves** (2026-10-03): `add_human()` (`python -m core.study human [--write] [--rating N] [slug…]`;
  prints only without `--write`): per opponent node past the trunk, Maia-3 at `PLAYER_RATING` gives `node.maia`;
  a non-lesson move ≥ `HUMAN_MIN_PCT` 15% losing < 120 cp becomes a branch (`source: "human"`, run on
  `HUMAN_EXTRA` 4 plies), one ≥ `HUMAN_CURVE_PCT` 8% losing ≥ 120 cp a curveball (`source: "maia"`); cap
  `HUMAN_MAX_NODES` 60, shallowest first. Auto-replies weight by Maia `pct` (`studyReplyWeight()`, master share
  without data); try buttons show "N% of ~1300 players". Najdorf/Vienna: median chance the opponent plays a
  lesson move 41% / 45%; 12 branches each (both capped, 13 more left out).
- **Learn mode** (default when a lesson opens): one move at a time; your next move is a green arrow (+ filled
  square), the opponent's tries blue (pale for less common), plus arrows for what the last move newly attacks
  (`studyThreatShapes()`). You advance only by playing the lesson move; the opponent replies after
  `LEARN_PAUSE_MS` 1 s, weighted. Your alternatives in family lessons are pale-green arrows; opponent tries are
  `.study-try` buttons. Cards don't auto-fold; coach chips live on the cards (`CHIPS.study`, shown only while
  the board is on that card's position). ▶/⏭ are disabled; ◀ lands on your own move. `studyGo()` bumps
  `studyToken` so any jump cancels a pending reply.
- **Drill:** you play your side, the opponent picks tries weighted by share × unmastered lines; wrong move =
  circle, then arrow + note. Mastered after 2 clean runs (`localStorage` `study-m:<slug>`). `studyLeaves()`
  follows only your main move.
- **Play on:** at a Learn leaf a bot game starts after `PLAY_ON_DELAY_MS` 1.5 s (`studyPlayOn()`, Maia
  1100-1800 chess.com, the line as `play.prefix`), with "Back to the lesson". Drill's line-complete card has a button.
- **Lesson text** (`lessonText()`/`lessonInline()`): its own tokenizer so moves resolve to lesson nodes
  (`studyFindMove()`), rendered as `.lm` buttons that play from where your board and that line split
  (`LESSON_STEP_MS` 650 ms).

### Known traps from the user's opening files (`core/repertoire.py`)

- Sources: `data/openings.md` + `data/openings/*.md` (`##`/`###` headers + JSON lists of `{"name","pgn"}`; only
  moves matter; a pgn is cut at the first comment/glyph/variation). A move is a **trap** when it throws away ≥
  `TRAP_SWING` 150 cp and leaves the other side ≥ `TRAP_EDGE` +2, rechecked at depth 20. Evals cached per EPD
  in `data/openings_evals.json`; index `data/openings_index.json`, rebuilt in a background thread when the
  sources' hash changes (the old index keeps serving meanwhile). Labels come from the last ECO-named position
  (`_label()`); course-titled sections fall back to "from your opening files".
- **State 2026-10-10:** `openings.md` + `openings2.md`, `openings3.md`, `openings5.md`, `markdown5.md` → 2,705
  lines, 21,624 positions, **524 traps**. Rebuilds reuse cached evals; a cold batch is ~380 new positions/min.
- **Viewing them** ("Explore lines" in the side nav, Learn; 2026-10-10): `repertoire.browse()` → `GET
  /api/repertoire`: sections (header, any `#` level, tidied by `_clean_title()`; the same title in two files is one
  section) → groups (the line's own `"name"`, else its deepest ECO name shortened by `_short_name()` against the
  header: "Sicilian Defense: Kan Variation, Knight Variation" under "Sicilian Kan" is "Knight Variation") → lines
  (`div`: a few moves from where the line leaves its closest sibling, so a group's lines tell apart without the
  whole move list; first known `trap`). A line that is only the start of another in its section, unnamed, is
  dropped (88). ~2,700 lines → ~1,100 groups. The list shows names only (user's call, 2026-10-10: no line counts or
  trap tags on the right; traps show on the board): header cards whose title pins while you scroll them, rows on one
  left edge (chevron or blank), names up to two lines, branches indented; search results are a card each. Cached by source hash + index object (~3-7 s cold, warmed in a thread
  at startup; the page fetches it 3 s after load). User's call: no full move strings on screen.
- **Search** (`repSearch()` in app.js, in the browser over `repIndex`, ~5 ms a keystroke): tokens that look like
  moves (`repMoveKey()`: case, move numbers, x + # ! ?, 0-0/O-O folded; "NF3", "1...c5", "cd4" work) must appear
  in order in the line: starts with them > all in a row > in order with gaps (tightest stretch wins), ties to the
  shorter line. Other tokens are words, ANDed, matched in the group name > ECO/line name > header, by word start,
  the field run together ("counterattack" vs "Counter Attack") or one typo for 5+ letters (`repNear()`, OSA, so
  "nadjorf"/"sicilain" match). Results are group rows (name, then header), best 80; ≤ 3 fold out; Enter
  opens the first; a line found by moves opens on the demo board stopped where the typed moves end. The user's
  expectation that "e4 nf3 a6" finds only the Najdorf can't hold: 136 lines have those moves in order (Kan,
  O'Kelly, Ruy Lopez …a6); the O'Kelly ranks first (tightest), and the files' only Najdorf is named "Nadjorf".
- **Its own mode** (user's call: it shouldn't take over the scoreboard whatever is open): clicking it leaves
  whatever is on the board for a fresh analysis board (`/api/analysis`) and shows the list in the scoreboard's
  place (`body.rep-mode`, `setRepMode()`/`repApply()`, localStorage `repMode`: `.score-body` hidden, `.rep-body`
  shown, the Full Explorer dropdown closed). Anything else that takes the board ends it: `setReview()` (game, bot
  game, puzzles, lesson, endgame, Analysis board, 📌 position) unless passed `keepMode` (refresh restore and first
  load pass it) and `openEditor()`. ‹ in the panel header ends it too, leaving the board; the nav item only enters (clicked again it just focuses the search). A
  line opens as a demo flagged `explore`: the top row reads "Line · <opening + branch> · <header> · Clear board"
  instead of "Demo board · Back to my game"; under the board, the line's `"name"` from the file when it has one
  (user's call: the file's own text belongs there; one line, full text in the tooltip; it's the only text the files
  carry per line), plus "off the line: your moves" once you leave it. A named line's top row shows only its branch. No "Play bot from here" in this mode (user's call: it's for looking). The nav item shows `.on`; on phones the middle tab reads "Lines". While it's on,
  `repMode()` stops `requestScoreboard`, `renderKeyCard` and `requestMaiaLines` (no engine work for a hidden
  panel; so no live tactic alert either); leaving calls `update()`. Read-only.
- Shown on review cards (`fell` / `punished` / `missed`) and the bot-game card (`trap_punish`, `trap_warn`),
  via `trapRow()` with a ▶ refutation demo. Not tested: a live bot game reaching a trap (rare with Maia/Stockfish
  until the bot uses an opening book). Some labels are odd where a line passes a position the ECO table names
  unexpectedly.

### Pages

- **`/usage`** (`static/usage.html`): this app's spend (`core/usage.py`, `GET /api/usage`) plus org-wide
  month-to-date spend by model (`core/org_spend.py`, Cost Admin API, needs `ANTHROPIC_ADMIN_KEY`; excludes
  Priority Tier; cached 60 s). Add new models to `PRICING` in `core/usage.py` or they show as `unpriced_calls`.
- **The 📚 Lessons dialog was removed from the app 2026-10-09** (user's call: "keep that stored in the backend for now"):
  no nav item, no dialog, no ☆ on coach answers. Every answer is still saved (`data/library.sqlite`, `/api/library*`),
  still serves as the exact-match answer cache, and `scripts/lessons_digest.py` still reads it.
- **`/lessons`** (`static/lessons.html`): an unlinked standalone page of the saved answers (the only UI left for them), same endpoints
  and DB. Can't restore the board; only formats bold.

## Model choice

- **Coach:** `MODEL` in `core/coach.py` defaults to `claude-sonnet-5` (`COACH_MODEL` overrides). Switched from
  Opus on 2026-09-28 for cost ($7-11/day on Opus) with no quality drop seen in manual testing.
- **Sonnet 5.5 was tried and not adopted (2026-09-29).** It returns text written between tool calls as
  `thinking` blocks, and `Coach.ask()` only collects `text`, so answers came back as a one-line closer or empty
  (`display: "updates"` only gives summaries). A switch needs either a prompt rule to write the whole answer
  after the last tool call, or a "send the player a message" tool, then a rerun of the comparison. Both models
  named the engine's top move 6/6 in the test. Revisit if Sonnet 5 gets a retirement date.
- **Signs a stronger model is needed:** claims that don't match the tools, tool-orchestration slips, `move_quiz`
  decoys turning into filler, answers no longer varying with phrasing ("main lines" vs "let's yolo" vs "I feel
  stuck"), treating web results as settled, muddled explanations of sharp middlegames.

## TODOs / open decisions

### Tactics finder

- Live feedback from the user, then: "watch out" for the opponent's tactics (one extra search as if it were
  their move), better pin/discovered rules (headline right 59% / 74%), hand-check the untagged puzzles it still
  names, and whether to hold the quick lists back until the deep search says there's no tactic.

### Scoreboard (after the 2026-10-06 redesign)

- Get the user's verdict from live use. Open: whether the candidates should cap lower when the stacked panel is short; ranking quality of the
  depth-10 tail (moves past #5) not checked against a deep search. Not built: points/material, momentum graph,
  king danger, Stockfish's WDL.

### Opening lessons (after the scoreboard)

- Have the user run a live Learn session on the human-move lessons; then decide on running `add_human()` for the
  other lessons and in `build()`, and on notes for human nodes.
- Read the English and Catalan notes (claims about attacks/pins must match the board).
- A live "Walk me through this" run (only tested with a stubbed chat).
- Not built: Drill questions from moments, "find the key move" puzzles (…h5, …b5, …Qa3), move symbols (!, !?)
  on cards, the masters/players toggle on the start card.
- Any lesson that builds for the wrong side → `SIDE_OVERRIDES`.

### Maia

- Calibrate the bot levels by playing them; `MIN_PLAY_PCT` (2%) is the first knob.
- The opponent row reads "Bot Stockfish" for the Stockfish level (`botElo()` falls back to the whole name).
- Not built: clock-aware Maia, a "practical move" ranking (Stockfish candidates played out with Maia),
  "how findable was the best move", Maia-based decoys/curveballs at your rating outside lessons.

### Scoreboard follow-ups

- Not built: restoring the chat log on refresh (the conversation itself is server-side and continues).

### Opening puzzles

- Live feedback; then the one-off Claude naming pass for the patterns the user finds real (title + one-line idea
  from 3 example puzzles, stored in a JSON beside the DB, user reviews them like lesson notes). Then decide on live
  alerts in games.
- `data/puzzles/all.csv` (1.1 GB) and the `.zst` (293 MB) are only needed to rebuild; kept on purpose (user's call:
  disk isn't a concern).

### Other open items

- **Look at later (user, 2026-10-08):** Chessiro, Chessvia.ai, Aimchess: what they do that this app doesn't, and
  what's worth borrowing. Chessiro is already the source of the rating table (`core/ratings.py`).

- **Finish `TESTING-2026-09-29.md`.** User's priorities: does each "⚠ Big moment" explanation match its card
  (section 3), and are lesson notes chess-correct (section 5).
- **Live coach runs not done yet:** "⚠ Big moment" answers, Why? on a move card, multi-turn `jump_to_move` /
  `go_now` walkthroughs.
- **"Review this game" after playing on** from a loaded game (should analyse the whole game from move 1): untested.
- **Branch chat note without a rating:** reported once, not reproduced. Get a screenshot and the game, and check
  for a stale cached `app.js`.
- **chess.com Insights, Black tab:** ask for the screenshot, extend `player.md`.
- **Duplicate "Show me" buttons** (see Chat rendering): decide when the user asks.
- **Bot opening book** from the user's opening files (trap-seeking at higher levels, walking into traps at low
  ones); check the setters' moves for soundness first.
- **Loading a game while another analyses:** currently 409; nicer would be cancel-and-replace (needs a way to
  abort `review_game`).
- **Favourites for bot games / analysis boards** (they have no game_id yet).
- **Engine history elsewhere:** only `/api/eval` and `/api/scoreboard` pass move history; check review, coach
  tools and the GM/trick finders (repetition draws are invisible from a bare FEN). The 50-move part of
  `_history_key()` isn't tested on a real high-clock position.
- Clock for branched games; local Lichess puzzle DB (offline tactics trainer); Syzygy tablebases via
  `chess.syzygy`; persisting engine results across restarts (needs Stockfish-version invalidation).

### Considered and declined

- A numeric "enter your ELO" field: `player.md` covers it as free text, and the coach already uses it.
- A local LLM instead of Claude for cost: the coach's core promise is "never invent a tactic"; the cheaper
  lever is skipping the LLM for lookup-shaped content (openings, puzzles, tablebases).
- Faster coach settings (`COACH_EFFORT=low`, thinking off): see "Coach and cost".
- Sonnet 5.5: see "Model choice".
