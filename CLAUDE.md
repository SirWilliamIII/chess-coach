# CLAUDE.md

Project-level notes for working in this repo. `README.md` covers setup and user-facing
features — this file is architecture gotchas, "need to knows," and open TODOs for whoever
(human or agent) touches this code next.

## Working conventions

- **Never `git push` without an explicit ask in that message.** Committing on request ("commit")
  is fine on its own; push only when the user says so directly (e.g. "push" / "commit and push").
  This holds regardless of what was pushed last time — one approval doesn't carry forward.

## Architecture need-to-knows

- **Single-user, single global state.** `frontends/web/server.py` keeps one `S` object
  (`S.review`, `S.coach`, `S.engine`, `S.bot`). Not designed for concurrent users — it's a
  personal tool, by design (see the module docstring).
- **The coach has no cross-game memory.** `S.coach` is recreated from scratch
  (`make_coach()`) every time you load a different game, start a fresh analysis board, or
  start a new bot game — empty `messages` each time. The conversation is server-side state
  (not browser state), so it survives across browser page reloads (`init()` in `app.js`
  resumes via `/api/review`, the current server state — a reload does not reset anything)
  until you switch to something else, e.g. by clicking the header's "Analysis board" button
  (`/api/analysis`), which is a deliberate, explicit reset.
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
  eval pills, glossary terms, `.lbl` label lines, a "Pro tip" callout block, `ol.points` numbered
  cards). A numbered `ol.points li` card is a single clickable unit — the whole card plays its
  move sequence on click (`addLineButtons()`), built from whatever `.san` chips exist in that
  block, not from parsing English prose. A card with no SAN in it literally can't be shown on the
  board (the prompt tells the coach this). Outside numbered cards, a block's `.san` chips *are*
  the demo trigger directly (hover previews the move, click opens it on the demo board) — there's
  no separate "Show on board" button anymore, see `addLineButtons()`'s non-card-play branch.
- **The whole header cluster lives in `.chat-head`; there is no right-hand column anymore.**
  `#game-info`, `#summary`, and the "Moves & engine" panel (`.game-panel`, now a plain `<div>`
  inside `.chat-head-right` next to "New chat", no longer a `.panel` grid item) are all there, and
  `main` is a two-column grid (board + chat; one column ≤1150px with chat below the board).
  `renderInfo()` targets everything by ID, so moving things needs no JS change — but two dropdowns
  are `position: absolute` and anchor to their nearest positioned ancestor: `#from-moves` (the
  "Play from position" picker) to `.summary`, and `#gp-details` (moves list, engine lines,
  explorer) to `.game-panel`, both `position: relative` in `style.css`. If either wrapper moves
  again, that CSS rule has to move with it or the dropdown anchors to the wrong element. The
  dropdowns open inside `.chat-panel`, which is `overflow: hidden`, so they must fit within it.
- **Header buttons have a deliberate hierarchy** (`.actions` in `index.html`): Play game + Find game by
  username are `.btn.primary` (green, larger), Analysis board is a grey `.btn.ghost`, and Lessons +
  Load game are quiet `.link` text buttons after an `.actions-sep` divider (hidden ≤760px, where the
  row wraps). Button ids are unchanged, so the JS wiring didn't move.
- **"Moves & engine" panel (`.game-panel` / `#gp-details`) is docked, draggable and resizable.**
  - *Docking:* `dockGamePanel()` in `app.js` (called first in `renderInfo()` and `updateEditor()`)
    moves the whole `.game-panel` into `#game-info` on the empty analysis board, where the old
    "Analysis board" title text was, and back into `.chat-head-right` in every other mode. It must
    move back *before* anything assigns `#game-info`'s text/innerHTML, or that assignment deletes the
    panel from the DOM. When docked, `.game-panel.in-title` makes the dropdown open rightward.
  - *Drag/resize:* a header bar (`.gp-bar`: drag handle `#gp-drag` + ✕ `#gp-close`) and eight
    `.gp-rs` edge/corner handles (created in JS). The first drag or resize switches `#gp-details` to
    `position: fixed` at its current rect (absolute would be clipped by `.chat-panel`'s
    `overflow: hidden`). Scrolling lives on the inner `.gp-body`, not `#gp-details`, so the handles
    don't scroll away. The ✕ is a sibling of the drag handle because the handle captures the pointer
    and would swallow its click. Min size 260x160. `closeGpDropdown()` clears all inline styles, so
    position/size are **not** remembered between openings (deliberate, easy to add via localStorage).
  - *Closing:* stays open while you play moves. Closes via ✕, the toggle, Esc, or a click anywhere
    that isn't `.game-panel` or `#board-wrap` (so eval bar, name rows, nav buttons and chat all
    close it). The "Play from position" `#from-moves` dropdown still closes on any click off it.
  - Verified with Playwright pointer events; not tested with touch.
- **The name rows are capped to the board's width.** `--board-w` is defined on `.board-col` and used
  by both `.board-wrap` and `.player` (`max-width: 34px + --board-w`; 34px = 28px eval bar + 6px
  gap, same as the rows' `padding-left`). Without the cap the rows span the whole grid column,
  which is wider than the capped board, so right-aligned items (Takeback) hung off the board's edge.
  The ≤760px override sets `--board-w` on `.board-col`.
- **`#summary` in a bot game shows no "Your move" / "Bot is thinking…" text** (removed on purpose).
  It still shows the game-over result, the "Viewing an earlier position" note, and Stop bot.
- **Opening explorer has no filter UI.** `explorerFilters()` in `app.js` is a constant: Lichess
  database, all rating bands, all six speeds. The speeds are listed explicitly on purpose —
  `explorer.explore()` turns a *missing* speeds list into blitz+rapid only, so "all" has to be
  sent. Masters is no longer selectable from the UI (the backend still supports `db="masters"`).
- **Takeback lives at the right end of the `#player-top` row** (`takebackHtml()`, rendered in `renderInfo()`
  after the name/clock/captured pieces; `#player-top .btn.small` has `margin-left: auto` in `style.css`
  to push it right). That's the opponent's row in a normal game (your side is at the bottom). It's
  hidden in demo mode.
- **One game load at a time.** `POST /api/load` returns 409 while `S.job` is `running` (one
  Stockfish, one global state); the message says to wait and retry. Loading a second game while
  the first is still being analysed is the usual way to see it. A load does *not* cancel the
  running one — see TODOs.
- **"Play from position" dialog (`#dlg-from`).** "You play" (White/Black) sits *above* the two
  options because clicking an option starts immediately and reads `fromColor`. It applies to both:
  Replay plays `fromColor`'s moves from the game (default: your side) and flips the board to it.
  **Best moves only** picks its bot in `botLevelFor(color)` in `app.js`, and the dialog previews the
  choice ("Bot: Improving (~1200), matched to X's 1298 rating") and refreshes it when you toggle the
  color. Order: the rating of the side you're *not* playing (whoever had it in the game; the user's
  own rating is deliberately not the first choice, since they may be replaying a pro game they
  aren't in) → the rating of your own side → the level last used in "Play a game"
  (`localStorage` `botLevel`) → Intermediate ~1500 only for an analysis board or earlier bot games
  with no ratings. `levelForRating()` picks the closest bot level by parsing the `(~N)` in each level
  name from `/api/play/levels`. `BOT_LEVELS` in `core/engine.py` has Super-GM (~2700) and Elite GM
  (~2900) between Master and Full strength (Stockfish's `UCI_Elo` goes to 3190); Full strength is
  only picked from 3050 up. The rating-capped levels use a 0.5 s move limit while Stockfish
  calibrates `UCI_Elo` at much longer time controls, so they probably play weaker than labelled
  (inferred, not measured); the ratings are rough guides, and chess.com vs Lichess scales differ.
- **Engine search: time vs depth.** `Engine.lines()`/`evaluate()` take an optional `depth`; with it,
  the search stops at that depth *or* after `seconds`, whichever is first (seconds = ceiling,
  depth = target). Without it, behaviour is time-only as before. The coach's own tool calls
  (`_candidate`, `move_report`'s top moves, `analyze_position`) use `TOOL_DEPTH` (default 22,
  override `COACH_ENGINE_DEPTH`) with `TOOL_MAX_SECONDS` = 4 in `core/coach.py`. Measured
  2026-09-28 with 3 lines on this machine: the old flat 1.5 s reached depth 15-20; depth 22/4 s
  reaches 19-22; depth 24/6 s reaches 21-24 but costs up to 6 s per call and a question can make
  several. In the three test positions the best move didn't change at any setting, so the benefit
  is expected in sharp tactical positions but was not demonstrated. Left time-only on purpose:
  game review (0.3 s/position — depth ~15-20, so classifications of borderline mistakes are
  noisy), eval bar (0.6 s), and the GM-moment/trick finders, because they run on every move and
  deeper would multiply review time. Saved exact-match answers are not invalidated by a depth
  change (the cache key doesn't include it).
- **`/usage` page** (`static/usage.html`, standalone, reuses `style.css` tokens): this app's own
  spend from `core/usage.py` (`GET /api/usage`, everything the app sent, estimated cost only) plus
  **organization-wide** month-to-date spend, by model, from `core/org_spend.py`
  (`GET /api/org-spend`, Anthropic's Cost Admin API `/v1/organizations/cost_report`). The org part
  needs `ANTHROPIC_ADMIN_KEY` (an `sk-ant-admin…` key — separate from `ANTHROPIC_API_KEY`, which
  admin keys can't replace; it can manage org members/keys, so it's only used for that one
  read-only call) and optionally `MONTHLY_SPEND_LIMIT` (dollars — the API exposes no spend-limit
  field, so it's typed once in `.env`). The cost report excludes Priority Tier costs, so it can
  read slightly under the Console billing page; results are cached 60 s. Add new models to
  `PRICING` in `core/usage.py` or their calls show as `unpriced_calls`.
  **Web searches** are counted per question from `response.usage.server_tool_use.web_search_requests`
  (summed over the tool loop in `Coach.ask()`, stored in `calls.web_searches`; older rows are 0, and an
  existing DB gets the column via `ALTER TABLE` on connect). Shown as a tile and a By-day column. The
  count was tested against a DB copy but the field's real-world population is unverified — if the tile
  stays 0 after the coach searches, check that path. Per-search cost is *not* in the estimate (rate
  unknown here); the org card lists "Web Search Usage" as its own line.
- **`/lessons` page** (`static/lessons.html`, route in `server.py`): a standalone, deliberately
  *unlinked* copy of the in-app 📚 Lessons dialog — search, ★/🧠 filters, tag chips, expand an
  entry to read the full answer, star, delete. Same `/api/library*` endpoints and same
  `data/library.sqlite` as the dialog, so the two always agree; but it's separate rendering code
  (the dialog's lives in `app.js`), so display changes must be made in both. It can't restore the
  board (that needs app state) and only formats **bold** (the chat's markdown renderer isn't
  reused). Like `/usage`, no auth — fine on the default `127.0.0.1`, exposes saved answers and org
  spend if the server is ever bound to `0.0.0.0`.
- **What the coach actually "remembers".** Nothing across games except `prompts/player.md`
  (hand-written profile, sent with every question, re-read live) — the coach does **not** read the
  Lessons library. Within one game it keeps the running conversation server-side (cleared by
  loading another game, a new bot game, or "New chat"). So a line like "since it's the Vienna
  you're working on" comes from `player.md`, not from memory.
- **Persona/profile cost is negligible; history is the real cost driver.** Measured with
  `messages.count_tokens` (2026-09-28, `claude-sonnet-5`): `player.md` ≈ 360 tokens, `coach.md` ≈
  6,860, tool definitions ≈ 8,990 — ~16.2K fixed prefix, of which the profile is ~2%. Average
  cache read was ~33K tokens/call, so roughly half is game context + tool results + chat history
  (inferred). Growing the profile 10× would still be pennies. Editing `player.md`/`coach.md`
  changes `prompt_hash()`, so saved exact-match answers stop matching and the next question pays
  one fresh cache write — batch prompt edits.
- **Lessons review loop (habit → persona).** `scripts/lessons_digest.py` (read-only against
  `library.sqlite`) writes a dated snapshot to `data/digests/lessons-YYYY-MM-DD.md` (gitignored):
  stats, a keyword-grouped DRAFT "Recurring mistakes" block, all habit lines, all questions, and a
  list of very short questions. Its tag grouping is heuristic (21/54 habits had no informative
  tag on the first run) — the first real grouping was done by reading the habit lines by hand.
  Never auto-edits `player.md`; promote habits manually and generalize them (strip the "here e5
  hangs…" specifics or the coach over-applies them). The habit lines are the *coach's advice on
  single positions*, not measured stats about the player's play — treat recurring themes as
  hypotheses. To review: rerun the script, diff against the previous snapshot (which habits faded,
  which are new, whether questions got more specific), and update the `player.md` section.
  Question-asking tips that make the library useful: one concept per question with the move named;
  ask while the relevant position is on the board (it's saved with it); reuse exact wording or the
  app's chips so repeats hit the local answer cache; use the tag vocabulary (`PATTERNS` in
  `core/library.py`: back rank, fork, pin, skewer, discovered attack, deflection, zwischenzug,
  outpost, opposition…) so answers get tagged and searches match; search is AND over word
  prefixes, so keep queries short. Avoid vague/bundled questions ("is this good?", "explain the
  opening, my mistakes and the endgame") and "just give me the move" when the goal is to learn.
- **`player.md` has a "Recurring mistakes" section** (added 2026-09-28 from the first digest): loose
  pieces, forcing-moves-first / "can they win it back with tempo?", Vienna/f4-gambit `...Qh4+`
  (h4-e1 diagonal), reading the opponent's castling side and last pawn move, cramped c8-bishop
  before `...e6`, converting a pawn up by trading, and listing all answers when in check. It says
  to name one only when the position shows the flag. If the coach starts raising these in
  positions that don't show them, tighten that sentence.
- **`.env` is gitignored** and must be recreated on every machine/clone
  (`ANTHROPIC_API_KEY`, `LICHESS_TOKEN`, optional `CHESS_USER`, optional `ANTHROPIC_ADMIN_KEY` +
  `MONTHLY_SPEND_LIMIT` for the `/usage` page's org-spend card). This machine has two local
  clones — `/Users/will/chess-coach` (primary) and `~/Projects/chess-coach` (secondary,
  kept in sync via `git pull`) — each needs its own `.env`.

## Known, deliberately-accepted overlap

The coach's own `show_on_board` tool calls still produce explicit **"▶ Show me: ..."** demo
buttons at the bottom of a message (a separate, older mechanism). The newer inline per-point
**"▶ Show on board"** buttons can point at the same line, so a message occasionally has both.
Not yet resolved — see TODOs.

## Model choice

`core/coach.py`'s `MODEL` defaults to `claude-sonnet-5` (was `claude-opus-5` until 2026-09-28).
Switched after a same-day cost comparison in the Anthropic Console showed Opus-only usage running
$7-11/day vs. a fraction of that on Sonnet for comparable volume, plus a session's worth of manual
testing — multi-tool orchestration, the "Read the question" voice-switching, `move_quiz` decoy
quality, `web_search` trust-tier framing, real-vs-hypothetical divergence tracking — showing no
quality drop. Override via the `COACH_MODEL` env var if needed, but the code default is what
actually ships to a fresh clone or a wiped `.env`.

Indicators it's time to reconsider a more powerful model (watch for these in normal use, not an
audit):
- A claim that doesn't match what the tools would actually show (an invented-feeling eval, a
  "trap" that isn't real) — the ground rules require every concrete claim to be tool-verified, so
  this is the most catchable regression.
- Tool-orchestration mistakes: skipping a verification step it should have taken, or misreading a
  tool's actual output.
- `move_quiz` decoys turning into obviously-bad filler instead of moves a real player at that
  level would plausibly consider.
- The "Read the question, not a fixed mode" section flattening out — main-lines questions should
  lean theory, "let's yolo this" should lean sharp-but-verified, "I feel stuck" should lean
  patient; if answers stop varying with phrasing, that judgment call is degrading.
- `web_search` trust-tier blurring — treating something found online as settled instead of
  re-verifying the actual moves through the engine.
- Muddled explanations on genuinely sharp, multi-candidate middlegames — the engine gives the raw
  eval regardless of model, but turning a complicated forcing sequence into clear, correct prose is
  still real language-model work.

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
- **Loading a game while another is analysing.** Currently rejected with a 409 (see "One game
  load at a time"). Nicer option not built: let a new load cancel/replace the running one, which
  needs a way to abort the in-flight `review_game` engine pass.
- **Clock is scoped to fresh bot games only.** The "Use a clock" option lives in the
  "Play a game" dialog (`dlg-play` → `startGame()`). "Play from here" / Replay (`dlg-from`)
  don't have a clock option — that was out of scope for the original ask, not an oversight,
  but worth adding if wanted later.

## Recent major work (an earlier session, roughly chronological)

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

## Recent major work (2026-09-28 session, roughly chronological)

Replaced the Coach/Encyclopedia/Magnus/Solid persona switcher with one coach that reads the
question's phrasing and adapts emphasis itself (main-lines → theory, "let's yolo this" →
verified sharp tries, "I feel stuck" → patient plan-finding), never asking the player to pick a
mode · added exact-match local answer caching (question + position + prompt-file hash + player
color all have to match) so a genuine repeat skips the API call entirely, with a hash-based
invalidation so editing the prompt never serves stale-styled cached answers · added `move_quiz`:
a clickable multiple-choice guess (2-4 options, or `['True','False']` for a claim to verify)
instead of describing a hint/puzzle in prose, wired into "Hint" and a new "Test me" chip ·
"Their threats?" folded into "My plan?" as a leading "Opponent:" blurb · move mentions in chat
are now the demo trigger directly (hover previews with the board's own capture/check colors,
click opens the full line on the demo board) instead of a separate "Show on board" button ·
opponent-move mentions preview in the board's darker "warning" colors, including threats one ply
before they're actually playable (`legalAtFlipped()`) · player color is now explicit and
correctable (click either name in the game header) instead of silently inferred from a username
match that can fail with no visible sign · added `web_search`, scoped narrowly to naming/
verifying an opening the coach doesn't recognize (never for evaluation, which stays the engine's
job), with explicit "this is a different trust tier" framing in the coach's own voice · added
local usage/cost tracking (`core/usage.py`, `GET /api/usage`) for this app's own Claude spend ·
default model switched from Opus to Sonnet (see "Model choice" above) · layout: game panel moved
to the rightmost column with its dropdowns opening leftward over chat, board/chat widened to a
roughly 5-5-2 split, `#game-info` and the "Play from position" button moved into `.chat-head`
(left/center) · fixed a `_final_answer()` bug that silently dropped substantial answer text
whenever the model wrote more than one substantial part (a multi-step web-search answer's
explanation, verification, and follow-up note, for example) · fixed a CSS Grid bug where mixing
explicitly-placed and auto-placed panels dropped chat into an unintended second row.

## Recent major work (2026-09-28, later in the same day)

Added the `/usage` page (local usage tiles, daily chart, token mix, per-day table) and an
org-wide month-to-date spend card with a by-model breakdown and a progress bar against
`MONTHLY_SPEND_LIMIT` (`core/org_spend.py`, `GET /api/org-spend`) · bot games show the opponent as
`Bot (~1200)` and drop the subtitle above the board · Takeback moved onto the player's own name
row · **supersedes the earlier layout bullet above:** the game panel moved *out of* the right
column into `.chat-head`, the grid went from three columns to two · the explorer lost its
db/rating/speed dropdowns and now always queries all of Lichess (Masters is no longer the UI
default — it isn't selectable) · clearer 409 message when a load is already running · the
"Or continue one of your own games…" button moved to the bottom of the Play-a-game dialog, just
above "Start game" · added the unlinked `/lessons` page · added `scripts/lessons_digest.py`, ran
the first Lessons digest (204 saved answers, 54 habit lines), and turned it into the "Recurring
mistakes" section of `prompts/player.md` (see the review-loop and persona-cost bullets above) ·
"Best moves only" now scales the bot to the opponent's rating, with two new top bot levels ·
the coach's engine calls target a search depth instead of a flat time limit (see the two
bullets above).

## Recent major work (2026-09-28, frontend polish session)

Takeback moved to the right end of the `#player-top` row and the name rows capped to the board's
width so it lines up with the board's right edge · removed "Your move" / "Bot is thinking…" from
`#summary` · the Moves & engine panel takes the old "Analysis board" title slot on the empty
analysis board and became draggable, resizable and stay-open (closes on ✕ / toggle / Esc / a click
outside board and panel) · "Play from position" dialog reordered (color first), previews the bot it
will use, Replay honours the chosen color, and Best-moves-only falls back to your own side's rating
before ~1500 (see the bullets above) · header buttons re-ranked: Play game / Find game primary, Analysis
board secondary, Lessons / Load game demoted to text links.
