# CLAUDE.md

Project-level notes for working in this repo. `README.md` covers setup and user-facing
features — this file is architecture gotchas, "need to knows," and open TODOs for whoever
(human or agent) touches this code next.

## Architecture need-to-knows

- **Single-user, single global state.** `frontends/web/server.py` keeps one `S` object
  (`S.review`, `S.coach`, `S.engine`, `S.bot`). Not designed for concurrent users — it's a
  personal tool, by design (see the module docstring).
- **The coach has no cross-game memory.** `S.coach` is recreated from scratch
  (`make_coach()`) every time you load a different game, start a fresh analysis board, or
  start a new bot game — empty `messages` each time. The conversation is server-side state
  (not browser state), so it survives as long as `S.review` isn't replaced — but a browser
  page load always calls `/api/analysis` first (see `init()` in `app.js`), so a page reload
  now always lands back on a fresh analysis board, not whatever was last loaded. There's no
  "Analysis board" nav button any more for the same reason — reloading the page *is* that
  action.
- **Prompt caching is already wired up** (`core/coach.py`, the `messages.create()` call) via
  top-level `cache_control: {"type": "ephemeral"}`. This auto-caches the whole prefix
  (tools → system → messages) up to the last block, so repeat questions *within one active
  conversation* get the "history so far" portion at ~10% of input price. It's a 5-minute
  ephemeral cache with no `ttl` override — nothing persists overnight or across a fresh
  session, and there's no way to make it persist (it's a snapshot of the model's own KV-cache
  on Anthropic's servers, not data you hold). Don't try to build a "save the cache" feature —
  it isn't a thing. A real cross-session cost win instead means replacing a call with a local
  lookup (see TODOs).
- **`prompts/coach.md`, `prompts/audiences/coach.md`, `prompts/player.md` are re-read on every
  question** — no server restart needed to iterate on prompt wording.
- **Two unrelated "Lichess" integrations** — don't conflate them:
  - `frontends/lichess/client.py`: fetch a specific game or a user's game list. No token
    needed for a single game by URL/id.
  - `frontends/lichess/explorer.py`: aggregate opening statistics (popularity, win rates,
    opening names). Needs `LICHESS_TOKEN` in `.env`, otherwise silently unavailable
    (`explorer.available()` gates it everywhere).
- **chess.com vs. Lichess data shape asymmetry**: chess.com's monthly archive endpoint
  includes full PGN inline. Lichess's game-list endpoint does **not** — it needs a separate
  `lichess.game_pgn(id)` request per game. This bit the offline-prefetch feature once already
  (see git history — progress reporting had to move to right after the game-list call, not
  after fetching every PGN). Keep this in mind for any future multi-game Lichess work.
- **Offline prefetch is capped at 500 games** (`frontends/web/server.py`, `min(500, req.n)`).
  Each game gets a full Stockfish pass, so this is a real background job, not a quick fetch —
  raising the cap further has real wall-clock-time implications.
- **Chessground quirks:**
  - `drawable.onChange(shapes)` fires whenever the user-drawn shapes array changes, *including*
    going to `[]` when chessground's own `eraseOnClick` fires on a left click. The right-click
    "hold threat arrows" feature hooks this: it reads the newly-added shape's `orig` square,
    then immediately calls `cg.setShapes([])` to suppress the native circle/arrow rendering.
  - **Playwright's synthetic mouse events don't reliably reach chessground's internal
    drag/right-click detection** in this environment — confirmed even a plain left-click-drag
    move doesn't register via `page.mouse.down/move/up`. If you need to test board mouse
    interaction, don't fight this: expose the internal function (e.g. `holdThreatSquare`,
    `onPlayMove`) via a temporary `window.__debug` hook and call it directly, or call
    `cg.state.drawable.onChange([...])` directly to simulate what chessground would have
    produced. Always remove the debug hook before finishing.
  - A bare pawn move with no capture/piece-letter/move-number (e.g. `"f4"` as the very first
    token in a chat block) gets classified by the move-chip regex as a **square reference**
    (`.sq`, gold) rather than a **move** (`.san`, green). This is a known, *accepted*
    limitation — not worth fixing at the regex level — but `style.css`'s
    `.msg.coach strong:has(.san, .sq)` rule makes sure it doesn't visually break (no more
    gold-on-yellow-background invisible text when bolded).
- **Chat rendering pipeline**: `markdown()` → `inline()` in `app.js`, regex-driven (SAN_RE,
  eval pills, glossary terms, `.lbl` label lines, "Pro tip"/"Habit to build" callout blocks,
  `ol.points` numbered cards). A numbered `ol.points li` card is a single clickable unit — the
  whole card plays its move sequence on click (`addLineButtons()`), built from whatever `.san`
  chips exist in that block, not from parsing English prose. A card with no SAN in it literally
  can't be shown on the board (the prompt tells the coach this).
- **`.env` is gitignored** and must be recreated on every machine/clone
  (`ANTHROPIC_API_KEY`, `LICHESS_TOKEN`, optional `CHESS_USER`). This machine has two local
  clones — `/Users/will/chess-coach` (primary) and `~/Projects/chess-coach` (secondary,
  kept in sync via `git pull`) — each needs its own `.env`.

## Known, deliberately-accepted overlap

The coach's own `show_on_board` tool calls still produce explicit **"▶ Show me: ..."** demo
buttons at the bottom of a message (a separate, older mechanism). The newer inline per-point
**"▶ Show on board"** buttons can point at the same line, so a message occasionally has both.
Not yet resolved — see TODOs.

## TODOs / open decisions

- **Duplicate board-link buttons.** Decide whether to drop the bottom "Show me: ..." row now
  that inline per-point buttons cover almost everything, keep both, or something else. User
  wanted to use the app for a while first before deciding — revisit when asked.
- **Local ECO opening-name dataset** (e.g. vendor `lichess-org/chess-openings`, the same data
  Lichess's own explorer uses). Would make opening *naming* (not stats) work fully offline, no
  `LICHESS_TOKEN` needed, and fill gaps where the live explorer returns `opening: null` for
  real book positions (observed during testing). The *statistics* side (popularity %, win
  rates) still has to stay live — no static file has that.
- **Local Lichess puzzle database** (CC0, ~6M tagged tactical puzzles) for an offline
  tactics-trainer feature that needs zero LLM/API calls to select or verify a puzzle.
- **Syzygy tablebases** via `python-chess`'s built-in `chess.syzygy` — already a dependency,
  zero new packages needed. Would give provably-perfect (not just engine-strong) verdicts for
  ≤6-7 piece endings, tying into the existing endgame-preset content (Lucena, Philidor).
- **Considered and explicitly declined:**
  - A manual "enter your ELO" input — `prompts/player.md` already covers this as free text,
    and it already drives real behavior (verified: the coach naturally referenced the
    player's rating band unprompted in testing). A numeric field would mostly duplicate it.
  - Running a local LLM instead of Claude for cost reasons — real quality/tool-calling risk
    for a chess coach whose core trust property is "never invent a tactic, only report what a
    tool verified." The cheaper, lower-risk lever is skipping the LLM call entirely for
    lookup-shaped content (openings/puzzles/tablebases — see above), not swapping the model
    that does the actual reasoning.
- **Clock is scoped to fresh bot games only.** The "Use a clock" option lives in the
  "Play a game" dialog (`dlg-play` → `startGame()`). "Play from here" / Replay (`dlg-from`)
  don't have a clock option — that was out of scope for the original ask, not an oversight,
  but worth adding if wanted later.

## Recent major work (this session, roughly chronological)

Chat rendering overhaul (plain underlined move/square chips instead of boxed pills with
figurine icons; universal per-point "Show on board" buttons instead of only 3+-move runs;
numbered option cards are single clickable entities; tighter spacing; standout label lines;
"Pro tip" callout; a bounded "best/popular/practical" framework for candidate-move answers;
target-line-first structure) · GM alerts always on, toggle removed, replaced opening-recognition
with an instant free local-lookup quip instead of an LLM call · "Set up position" folded into
Analysis board / game review instead of a separate nav destination · "Play bot" merged into a
context-aware "Play game" (continue from a chosen position in one of your own games, or start
fresh) · endgame presets collapsed behind a button · offline archive raised to 500 games and
extended to Lichess (not just chess.com) · move-navigation row relocated under the board with
hover tooltips · right-click now holds a piece's threat arrows (accumulates; left click
resets) instead of drawing chessground's native circle · Explorer defaults to Masters games
unless you've picked your own filters · optional chess clock (time + increment) in the
"Play game" dialog.
