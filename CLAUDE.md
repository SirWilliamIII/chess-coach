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

## Current state (2026-10-05)

- **Opening lessons built** (`data/studies/`, per clone):

  | Lesson | Nodes | Curveballs | Moments | Human (Maia) | Family build |
  |---|---|---|---|---|---|
  | Najdorf (B) | 150 | ✓ | ✓ | ✓ | |
  | Vienna Game (W) | 134 | ✓ | ✓ | ✓ | |
  | Caro-Kann (B) | 220 | ✓ | ✓ | | ✓ |
  | Dutch (B) | 220 | ✓ | ✓ | | ✓ |
  | Dragon, Accelerated Dragon, Nimzo, QGA (B); Catalan, English, Caro-Kann Modern, Vienna Gambit/Max Lange (W) | 23-90 | ✓ | ✓ | | |
  | Catalan Open Defense Classical (B) | 64 | | ✓ | | |

  Still on disk but unreachable (built for the other colour before one-side-per-opening):
  `queen-s-gambit-accepted-white`, `catalan-opening-open-defense-classical-line-white`. Notes read through by
  the user: Najdorf and Dragon only.
- **Human moves in lessons** (first version, Najdorf + Vienna Game only; see the lessons section). Not done:
  a live Learn session by the user, the masters/players toggle on the start card, notes for human nodes, and
  running it in `build()` for new lessons.
- **Built 2026-10-04, not yet used live by the user:** the endgame trainer (see "Endgame trainer"), the scoreboard beside the board (Stockfish vs Maia lists,
  win strip, opening name, alert and big-play chat cards; see "Scoreboard"), refresh keeps the board, saved
  positions (📌; see "Games"), `./start` reading host/port from `.env`.
- **Favourite games with titles** (see "Games"). **Board drawing reworked** (colours, threat arrows; see
  "Board").
- **Built 2026-10-05:** a chess.com-style side nav replacing the header (collapsible), the opening name as the
  page title above the names, the scoreboard split into a head (⇥, win strip) beside the rows above the board
  and a panel level with the board's top edge, the "Auto" switch for unrequested coach calls (off by default),
  and repetition-aware engine searches (eval bar history + cache key). See "Layout", "Coach and cost", "Engine
  memo".
- **Next focus: the scoreboard redesign** (user's call, 2026-10-05); opening lessons after that. See TODOs.

## Running and testing

- `./start` (venv on first run, then the web app on :8000; host/port from `CHESS_HOST`/`CHESS_PORT` in `.env`,
  default 127.0.0.1:8000, flags override; the primary clone's `.env` binds the Tailscale IP) or
  `.venv/bin/python -m frontends.web.server [--host H] [--port P]`. Default host `127.0.0.1`.
- **`.env` is gitignored** and must exist per clone: `ANTHROPIC_API_KEY`, `LICHESS_TOKEN`, optional
  `CHESS_USER`, `PLAYER_RATING` (Lichess scale, default 1300), `ANTHROPIC_ADMIN_KEY` + `MONTHLY_SPEND_LIMIT`
  (org-spend card), `COACH_MODEL`, `STUDY_MODEL`, `COACH_EFFORT`, `COACH_THINKING`, `COACH_ENGINE_DEPTH`.
  Two clones on this machine: `/Users/will/chess-coach` (primary) and `~/Projects/chess-coach` (kept in sync
  with `git pull`), each with its own `.env`.
- **Other devices (e.g. a tailnet):** bind to the Tailscale IP (`--host $(tailscale ip -4)`), or keep
  localhost and use `tailscale serve`. There is no auth: every device shares the one global state (below),
  coach questions bill your API key, and `/usage` + `/lessons` expose org spend and saved answers.
- **The server does not hot-reload Python.** Restart after editing `core/*.py` or `server.py`; `prompts/` and
  `static/` are re-read live. Its output goes to the terminal that started it (`/tmp/chess-coach-server.log`
  is stale).
- **Testing without touching the running server:** start a second instance on another port
  (`(set -a; . ./.env; set +a; .venv/bin/python -m frontends.web.server --port 8011 &)`). To keep its writes
  out of the real `data/library.sqlite`, run it from a wrapper that sets `core.library.DB_PATH` to a copy
  before importing the server. Load a game with `POST /api/saved/open {"game_id": "...", "me": "sirwill3rd"}`
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
- **Four Stockfish processes.** `S.engine` (4 threads; eval bar, GM check, coach tools, full card),
  `S.card_engine` (2 threads; the bot-game quick card and "If they…" replies, so they never queue behind the
  main engine), and `S.sb_engines` (3 + 3 threads; the scoreboard's two parallel searches, see
  "Scoreboard"). `Engine._call` is serialized with a lock: overlapping `analyse` calls returned empty lines
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
  header (`autoCoach()`, localStorage `autoCoach`) gates the only three Claude calls nobody asked for:
  ⚠ Big moment (`explainBigMoment`), the replay one-liner (`commentOnOpponentMove`) and ⚡ GM moment / ⚠ Watch
  out (`gmCheck`, which has no per-game cap; off also skips its engine check). Everything else that calls
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
  button calls `goTo(ply - 1)`. `go_now: true` moves the board when the answer arrives (fresh answers only,
  not mid-replay). Stored in `library.jump`.
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
  cache `data/explorer/` (a month). The explorer panel has no filter UI: `explorerFilters()` is a constant
  (Lichess DB, all ratings, all six speeds listed explicitly, since a missing speeds list means blitz+rapid).
- **ECO table** (`core/eco.py`, vendored lichess-org/chess-openings TSVs in `core/eco_data/`, CC0): indexed by
  EPD, exact positions only. Used for opening quips, lesson names and trap labels; the explorer panel and
  coach tools still use the live explorer's names.

### Games: loading, review, replay, favourites

- **"Find game by username"** has chess.com, Lichess, Saved (offline) and ★ Favourites tabs.
  `/api/games?site=lichess` maps Lichess's list to the chess.com row shape (AI/anonymous players have no
  rating). The Lichess name is `localStorage` `meLichess`; `state.me` stays the chess.com name.
- **Loaded games open at move 1** (`state.ply = 0` in `setReview()`), including saved games.
- **Refresh keeps the board** (`saveBoard()` at the end of `update()`, `restoreBoard()` in `init()`): a
  localStorage snapshot (`board`: ply, extra moves, orientation, the bot game's `state.play` minus
  `backLesson`/`thinking`), used only when `reviewKey()` matches the review the server still holds, and only
  lines that still replay. Bot games restore via `playView()` and the bot moves if it was its turn; the clock
  doesn't run while away. Not restored: lessons, demos, replay mode, the chat log (the coach's conversation
  is server-side and continues). Per browser, so each device on the tailnet has its own snapshot.
- **Favourites (2026-10-03).** `core/favorites.py`: a `favorites` table in `data/library.sqlite` (game_id,
  title, names, ratings, result, date, opening, full PGN from `pgn_of()`, so it outlives `data/reviews/`).
  `POST /api/favorites/{game_id}`: `{favorite}` toggles, `{title}` sets a title and favourites the game (""
  clears it); unstarring deletes the row, title included. ☆ sits before the names in `#game-info`;
  double-clicking `#game-title` (first in `.board-head`, hidden when empty), `#board-sub` or `#game-info` edits the title in
  place (`editTitle()`: saves on Enter, blur or any outside pointerdown, because chessground cancels mousedown
  so a board click never blurs). Opening a favourite whose review is gone re-analyses the stored PGN. Loaded
  games only (`canTitle()`): bot games and the analysis board have no game_id. Reviews carry `date` only from
  2026-10-03 (`_date()` in `core/review.py`). Not tested: the re-analyse fallback, Safari/Firefox.
- **Saved positions (📌, 2026-10-04).** `core/positions.py`: a `positions` table in `data/library.sqlite`
  (title, the line as start FEN + SAN moves, final FEN, orientation, source like "A vs B" / "Bot game vs …" /
  "Set-up position", deepest ECO name). 💾 under the board (key `s`) or "💾 Save" in the position editor →
  title dialog (suggested: opening + move number); "📌 Positions" in the side nav lists them with static mini
  boards (`miniBoard()`, Unicode glyphs, no chessground), filter, rename, delete. Opening one starts an
  analysis board from the start FEN with the moves as `state.extra`, so ◀ walks back through the line; the
  original game context (names, review) isn't reattached. Server-side, so shared by every device.
- **A loaded game is a replay; a different move branches off to the bot.** "Replay as [White][Black]" →
  `startReplay(color)`, paused at the current move. Stepping pauses it; playing your game move resumes. A
  different move sets `state.replay.deviation`: "Play X vs bot" (`branchToBot()`) or "Take it back". The bot
  game starts from the game's start position with its moves up to the branch as `play.prefix` (Takeback and
  ◀ floor there) and keeps `play.back` for "Back to the game". Branching and coming back reset the chat.
  Bot level for a branch: `botLevelFor(color)` (rating of the side the bot replaces → your side's → last
  used level → ~1500), `levelForRating()` picks the closest `(~N)` level.
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

- **Bot levels:** Maia (~600) … Maia (~2500) every 100 (`maia.BOT_LEVELS`, `server.bot_levels()`), then
  "Stockfish" (full strength). Without Maia installed: the old Stockfish levels (`BOT_LEVELS` in
  `core/engine.py`, uncalibrated). `Maia.play()` samples Maia's top 10 by probability, never one under
  `MIN_PLAY_PCT` 2%. `/api/play/move` passes the game's moves and `opp_elo` (your rating: a branched replay's
  side, else `PLAYER_RATING`). **Strength per level is not measured.**
- **Opponent card** after each bot move (`showOpponentCard()` → `core/opponent_card`): best move + eval, main
  line, sharper try (only when `tricks.find()` tags a non-top sound sacrifice/trap), threats, loose pieces,
  known-trap rows, "If they…" replies. No Claude call; only **Why?** is paid (sends the "My plan?" chip prompt).
  Speed: `/api/play/move {card: true}` returns `opponent_card.quick()` (depth 14, ~25 ms) with the bot move, so
  the card shows at ~0.5 s; replies follow at ~1.5 s; the full card (depth 20) replaces the top rows at ~6 s
  unless the position moved on. Evals are White's point of view.
- **Replays get a short coach one-liner** for opponent moves (`commentOnOpponentMove`, max 4), not a card.
- **Opening reactions** ("Caro-Kann player, I see…"): free, `core/eco.py` + `core/opening_quips.py`
  (~65 hand-written lines by longest name prefix), `POST /api/opening`, max 3 per game, ply ≤ 16, standard
  start only. Tactic reactions aren't built.
- **Takeback** is `#pb-takeback` beside the top name row (`.head-row`), shown only in bot games (`syncTakeback()`).
  `#summary` in a bot game shows no "Your move"/"Bot is thinking…" text (removed on purpose).
- **Clock** exists only in fresh "Play a game" games, not in branched replays.

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
- **Layout** (user's calls, 2026-10-04/05: board and scoreboard are the focus, chat a narrow feed, scoreboard
  not too wide or tall):
  - **Side nav** (replaced the header row, chess.com-style): `nav.side-nav`, fixed left, `--nav-w` 190 px
    (body `padding-left`). Three `<details class="nav-group">` trees: Play (Play game, Analysis board, Set up
    position), Games (Find game by username, Load game, 📌 Positions), Learn (Learn openings, ♔ Endgames,
    📚 Lessons); button ids unchanged. Open/closed per group in localStorage `nav-<group>`. ‹ (`#nav-collapse`,
    `setNavCollapsed()`, localStorage `navCollapsed`) folds it to a 24 px strip with › to reopen; the board
    takes the width (1440×900, all panels: 504 px open, 672 collapsed). ≤ 1000 px it's a top bar (`--nav-w` 0,
    groups side by side, forced open, `--head-h` = its height).
  - **Columns** (`main`, centred): board | `.score-col` (320-380 px) | `.chat-panel` (300-360 px; `.feed-head`
    "Coach" + Auto + New chat + ⇥, the log, chips, input; cards and chips in smaller type than answers).
    ≤ 1380 px (1200 + the nav): board | scoreboard, chat full width below; ≤ 760 px: one column. Above
    1380 px with the chat hidden: 40 px more gap, scoreboard up to 560 px, board cap 960.
  - **Above the board:** `.board-head` = `#opening-tag` (the page title, see "Opening name"), `#game-title`
    (favourites, hidden when empty), `#game-info` (☆ names · result, shrinks first), `#board-sub`, and Moves &
    engine in `.board-head-right`; then `.top-row` = the top name (`#player-top`) with `.head-row` (`#summary`:
    I'm playing / Replay as / game status and buttons / the editor's buttons, the Maia rating `#sb-rating`,
    `#pb-takeback`).
  - **Vertical alignment:** the side panels start level with the board's top edge, not the rows above it:
    `--board-top` (offset of `#board-wrap` in `.board-col`, ResizeObserver on `.board-head` + `.top-row`) is the
    chat's `margin-top` and the height of `.score-head`, whose two rows mirror `.board-head` (⇥) and `.top-row`
    (win strip). Panel heights shrink by the same amount so the bottoms stay level.
  - **Sizes:** `--board-w` = min(`--board-max` 720, `100vh - --head-h - 196px`, `100vw - --nav-w - --reserve`);
    `--strip` (eval bar + rank labels, 46 px). Panels are as tall as the board column (`--board-w + 160px`).
    Coordinates sit outside the board (ranks in the strip, files below). The nav row (◀ ▶) lines up with the
    board (`margin-left: --strip`, width `--board-w`).
  - **Hiding panels:** ⇥ (`[data-hide]`, `setPanelHidden()`) → `body.hide-score` / `body.hide-chat`; the panel
    becomes a 30 px tab (`.panel-tab`; a bar across the page where the chat sits below), the other widens and
    `--reserve`/`--board-max` loosen. The board usually doesn't grow: it's height-bound. Remembered in
    localStorage.
  - **Moves & engine** (`.game-panel`, dropdown `#gp-details`) sits at the board's top right in every mode
    (`dockGamePanel()`); the dropdown opens to its right, over the scoreboard column (the editor palette lives
    in it; ≤ 760 px it drops down). Draggable/resizable (`position: fixed` on first drag), starts closed on
    every load (only "Set up position" opens it), closes only with ✕, folds the moves list to 5 rows
    (`FOLD_ROWS`).
  - **Static files aren't cache-busted:** no `Cache-Control`, so a browser can keep an old `style.css`/`app.js`
    after edits. Ask for a hard reload (⌘⇧R) before chasing a layout report that doesn't reproduce.
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

- **Maia-3** (`core/maia.py`, CSSLab 2026): what a player of a given rating (600-2600) plays, with
  probabilities. Panel: "Human moves" under Stockfish's lines with separate W/B ratings (side to move =
  `rating`, other = `opp_rating`); a row click plays the move where `canMove` allows it. `pct` is "how likely a
  human plays it", never quality.
- Setup per clone: `pip install git+https://github.com/CSSLab/maia3.git` (not in `requirements.txt`, torch is
  ~600 MB); the checkpoint downloads from Hugging Face on first use. Missing package = section hidden
  (`maia.available()`). AGPL-3.0: fine for a personal tool, matters if distributed or hosted.
- Runs in-process on `mps` under its own lock, lazily loaded (~2.5 s first request, then 0.04-0.1 s). Uses the
  internal `Maia3UCIEngine` API (`cmd_position` + `score_moves()`) of a 0.1.0 package: recheck after upgrades.
  **Send the move history** (it reads the last 8 positions).
- Maia-1 (lc0 + band weights) was tried first and replaced: its answers jumped between neighbouring bands.
  lc0 and `data/maia/*.pb.gz` are still on this machine, unused. Maia-2 needs Python ≤ 3.12.

### Scoreboard (`core/scoreboard.py`, `renderKeyCard()` in `app.js`, 2026-10-04; layout 2026-10-05)

- Who's winning: `#win-strip` (`renderWinStrip()`) in `.score-head`, level with the top name row: Stockfish's
  win % for White, Lichess curve `50 + 50·(2/(1+e^(−0.00368208·cp)) − 1)` on the eval clamped to ±15 (same as
  the eval bar; quick number, then the deep one; keeps the old bar while loading). An expected-score curve, not
  Stockfish's own WDL (where +1.00 ≈ 50% win) and not a prediction for these ratings. Maia's "at these ratings" line was removed (user's call); the server still sends
  `human_white_win`.
- **Best move / Previous move (user's calls, 2026-10-04: the card was one move off in bot games, then the top
  section vanished every other move):** `#key-card` has two sections under big headers (`sbTargets()`).
  **Best move** = the board now, whoever is to move ("after 2...exd4" names their reply on your turn). In a bot
  game or a replay the opponent's turn isn't searched (it answers within a second): the section keeps its size
  with "Bot is thinking…" and placeholder rows (`.sb-row.ghost`, also used while numbers load). **Previous
  move** = the position where you made your last move, your move marked (`.played`; added under Stockfish's
  list when it isn't in it, scored via the request's `include` → `extra` rows) and its cost. "You" =
  `sbUser()`: the bot game's or replay's colour, else the review's `player_color`; null on the analysis board
  until "I'm playing" is set, where Previous move is simply the last move. `requestScoreboard()` runs the two
  searches one after the other (the server's latest-wins would drop the first). An opponent's move's cost
  comes from your move's row before it and your position after (`sbDrop()`).
- Each section: two competing ranked lists (`sbLists()`; Stockfish white accent, Maia blue), **stacked** Stockfish over
  Maia with full-width rows and a 32 px gap between the sections (user's call: side by side read as four
  scoreboards); 20 px under each section title, 13 px between the two lists. The panel is capped at the board
  column's height and scrolls inside. Text is weight 400/500 with antialiased smoothing, `.score-head` included
  (user's call: heavier weights read thick and round). Stockfish's top 5:
  bar = mover's win chance. Maia's top 5 at your rating: bar = play % scaled to the favourite (exact % on hover).
  **Plain white text, one bar colour** (user's call): red only for a move losing ≥ 30 % (`.bad`), green only
  for the only move (#2 ≥ `SB_ONLY` 20 worse, `.great`). The rankings differ on purpose: a Stockfish slot
  carries a value, a Maia slot only popularity. Hovering a **Best move** row draws its move (`sbShowMove()`: blue
  arrow, red + ring for a capture) and lights the same move in the other list; clicking plays it
  (`playMaiaMove()`). Previous-move rows only light their twin (the board isn't there). Quick numbers
  (`lastEval`/`lastMaia`) fill Best move at once. Maia's rating picker is `#sb-rating` in the top name row next to
  "I'm playing"/"Replay as" (your colour's rating; the side to move's on the analysis board).
- **Opening name** (`requestOpening()`, `POST /api/opening_line`: every ECO-named position along the line):
  a gold "📖 Opening" chat banner the first time a game reaches a non-generic name (`isBlandOpening()` skips
  "King's Pawn Game" etc.; once per game, reset in `setReview()`), then `#opening-tag`, the page's title (first in `.board-head`, just above the name row; user's call,
  2026-10-05; `#board-sub` no longer repeats the review's opening, so a game the ECO table can't name shows
  none) shows
  the deepest name at or before the shown move, growing with variations (Caro-Kann → … Advance Variation →
  …, Botvinnik-Carls Defense). Exact positions only, so transpositions into a named line are found but a
  move-order the table lacks isn't. In bot games the older opening quip can name the same opening again.
- **Alerts are chat cards** (`sbPostAlert()`, `.sb-msg`), posted once per position (`sbShown`), only when called
  for. Each carries its move number in the corner (`.sb-num`) and a click takes the board to that moment
  (`sbFenIndex()` finds the position in the whole current line; Next play also draws its move). On the analysis
  board ◀ deletes moves, so a card for a deleted position greys out (`.stale`). Labels "Your move" / "Their move" (`sbPlayAlert()`). A move: lost ≥ 15 % (red/orange, + "gave it straight back", lead change), or it was
  Stockfish's #1 but not Maia's #1 and the popular move was ≥ 5 % worse (green "⭐ found"), or it punished a
  ≥ 15 % loss (green ⚡), or a lead change alone. Next play: the server's top alert (click draws the move while
  the board is still on that position). **Big plays** (`sbPostBigPlays()`): one running card, re-posted at
  the bottom when the list changes. On a loaded game a lost-move alert repeats what `noteMove()`'s card says.
- **Search:** depth 16 or 3 s (`DEPTH`/`MAX_SECONDS`): top 5 on one sb engine and the Maia moves
  (`root_moves`, up to 8) on the other, in parallel. Measured 2026-10-04 (38 saved-game positions, multipv 5, vs
  depth 22): depth 12 within 5 win % on 95%, depth 15 and 18 on 100%; time 1.5 s median / 5.2 s p90 at depth 15,
  3.7 s / 7.3 s at 18. Same #1 move only 74-76% (near-equal moves swap), which is why rows show evals.
  **Latest wins:** `SB_LOCK` + `SB_LATEST` return `{"stale": true}` for a request a newer one overtook. Cached client-side (`sbCache`,
  fen + ratings) so stepping back is instant and last play can read the parent position.
- **Evals are the side to move's view** in the lists and banner text (`moverEval()` / `mover_eval()`, user's
  call): no "+", negative = bad for whoever is to move, whatever colour. The eval bar and win strip stay White's.
- **Units:** every threshold is win % lost by the mover (Lichess curve), never raw eval: −3.0 from +9 means
  nothing, from +1 it decides the game. Tiers 5/15/30 (`tier()`) drive all styling (amber/orange/red, t2/t3 and green
  banners pulse once; `prefers-reduced-motion` respected).
- **Next-play alerts** (`alerts()`, first one shown): mate, disaster (a Maia top-4 move ≥ 5 % likely loses
  ≥ 30), danger zone (Maia % on moves losing ≥ 30 reaches `DANGER_PCT` 20), only move (#2 ≥ 20 worse),
  popular move wrong (Maia #1 ≥ 15 or flips the lead), no overlap (no Maia top-4 move in Stockfish's top 4; this is symmetric, so "vice versa" is the same
  check), hidden best (Stockfish #1 not in Maia's top 4). Clicking an alert draws its move, never plays it.
- **Thresholds are first guesses**, not tuned on games. Not built: points/material, momentum graph, king
  danger. Last play for a loaded game's own moves uses the review's `win_pct_lost`; elsewhere it needs both
  positions' scoreboards (visited), else no last-play banner.

### Endgame trainer (`core/endgames.py`, `core/tablebase.py`, "endgame trainer" in `app.js`, 2026-10-04)

- 365chess-style (user's reference: set_endgames_training.php): "♔ Endgames" (side nav, Learn group) → pick a mode, a side and a
  material tile (`PRESETS`: mates, pawns, rooks, queens, minors, random 4-7 pieces, pawn structures of 6-10
  pawns); the server makes a fresh random position (`generate()`) and you play it against full-strength
  Stockfish (`egBotLevel()`), eval bar off (the scoreboard hides with it).
- **Modes:** Win it (you're winning), Hold it (draw), **Material lies** (user's idea: you're down material yet
  it's a draw or a win; presets with equal material refuse it, presets with you ahead swap sides).
- **Truth:** ≤ 7 pieces → Lichess tablebase API (`tablebase.probe()`, no token, in-memory cache, one request at
  a time; cursed wins / blessed losses count as draws). Bigger set-ups → Stockfish depth 22 / 2 s (|eval| ≤ 0.3
  = even, ≥ 2.5 = winning), labelled as engine. A depth-8 search filters candidates first; ~0.5 s per drill
  measured. Starts are clean: no checks, no captures available to either side, pawns ≥ 2 steps from
  promoting, bishop pairs on opposite colours, tablebase wins ≥ `MIN_DTM` 10 plies. Impossible asks (a draw
  with K+Q vs K) give up after `GIVE_UP_AFTER` 80 candidates with a 422 message.
- **During play** (tablebase only): each of your moves is looked up in the probe of the position before it
  (`egAfterMyMove()`); a move that drops win→draw or draw→loss gets a red card with the best moves. A takeback
  re-reads the goal from the tablebase (`egTakeback()`). Result card at the end (`egGameOver()`), Hold it also
  completes after `EG_HOLD_MOVES` 30 of your moves; "Another one" repeats the same set. Stats per set + mode
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
  1500-2000, the line as `play.prefix`), with "Back to the lesson". Drill's line-complete card has a button.
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
- **State 2026-10-03:** `openings.md` + `openings2.md`, `openings3.md`, `openings5.md` → 2,506 lines, 20,316
  positions, **502 traps**. Rebuilds reuse cached evals; a cold batch is ~380 new positions/min.
- Shown on review cards (`fell` / `punished` / `missed`) and the bot-game card (`trap_punish`, `trap_warn`),
  via `trapRow()` with a ▶ refutation demo. Not tested: a live bot game reaching a trap (rare with Maia/Stockfish
  until the bot uses an opening book). Some labels are odd where a line passes a position the ECO table names
  unexpectedly.

### Pages

- **`/usage`** (`static/usage.html`): this app's spend (`core/usage.py`, `GET /api/usage`) plus org-wide
  month-to-date spend by model (`core/org_spend.py`, Cost Admin API, needs `ANTHROPIC_ADMIN_KEY`; excludes
  Priority Tier; cached 60 s). Add new models to `PRICING` in `core/usage.py` or they show as `unpriced_calls`.
- **`/lessons`** (`static/lessons.html`): an unlinked standalone copy of the 📚 Lessons dialog, same endpoints
  and DB, separate rendering code (display changes go in both). Can't restore the board; only formats bold.

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

### Scoreboard redesign (next focus, user's call 2026-10-05)

- Scope not set yet: start by asking what the redesign should change. Open items that belong to it: the alert
  thresholds (all first guesses; `POPULAR_PCT` 5 is the first knob, alerts fired on 6 of 14 positions in one
  test), the "Last play" alert repeating `noteMove()`'s card on loaded games, the opening quip repeating the
  opening banner in bot games, and whether the win strip should show Stockfish's WDL instead of the Lichess
  curve. Not built: points/material, momentum graph, king danger.

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

### Other open items

- **Finish `TESTING-2026-09-29.md`.** User's priorities: does each "⚠ Big moment" explanation match its card
  (section 3), and are lesson notes chess-correct (section 5).
- **Live coach runs not done yet:** "⚠ Big moment" answers, Why? on a move card, multi-turn `jump_to_move` /
  `go_now` walkthroughs.
- **"Review this game" after branching** off a replay (should analyse the whole game from move 1): untested.
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
