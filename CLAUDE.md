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
  `renderInfo()` targets everything by ID, so moving things needs no JS change — but the
  `#gp-details` dropdown (moves list, engine lines, explorer) is `position: absolute` and anchors to
  `.game-panel` (`position: relative` in `style.css`). If that wrapper moves again, the CSS rule has
  to move with it. The dropdown opens inside `.chat-panel`, which is `overflow: hidden`, so it must
  fit within it.
- **Per-move cards when stepping through a loaded game** (review and replay; `noteMove()` in `app.js`,
  called from `update()`). Same markup/CSS as the bot-game card (`.msg.card`, older ones collapse) but
  built from the saved review, no engine call: header = move + verdict (Best move / Fine / A little loose /
  inaccuracy…), Played + eval pill, Best + eval-before pill (hidden under 1% lost), ▶ Best/Main line demo
  from the saved `best_line` (added to `public_review()`), Why?, Back to my game. Once per move per game;
  jumping creates a card only where you land. Why? uses `.note-why`, not `.card-why`, because
  `syncCards()` disables `.card-why` outside bot games. Paid: a move with >= 10% win chance lost
  (`BIG_MOMENT_PCT`) also gets an automatic "⚠ Big moment" coach answer (`explainBigMoment()`), only
  after you stay on it 1.2 s, max 8 per game; it and Why? send the same fixed question per move
  (`moveQuestion()`), so they share the answer cache (not `ambient`, so saved to Lessons). `ask()` takes
  `opts.at` so the question stays pinned to that ply if you step on while it waits. The replay's paid
  opening one-liner skips a move that gets a big-moment answer. Tested with a stubbed `/api/chat`.
- **Opponent-move card (bot games only).** After each bot move `botMove()` calls `showOpponentCard()`
  (`app.js`), which POSTs the FEN to `/api/opponent_card` → `core/opponent_card.build()`: best move +
  eval (1.5 s / depth 20), main line, a "sharper try" (only when `tricks.find()` tags a non-top
  candidate as a sound sacrifice / trap / speculative sacrifice — often there isn't one, and if the
  top move is itself the sacrifice its tag is shown on "Best" instead), what the opponent threatens
  (`engine.threat()`, only if serious, suppressed when we have a mate), and loose pieces for both
  sides, plus "If they…" rows (a second request, `/api/opponent_card/replies` →
  `opponent_card.replies()`: their top 3 replies to the best move, within 150 cp of their best, each
  with the engine's answer and a demo button; fills in ~2 s after the card). **No Claude call**: the
  only paid part is the **Why?** button, which sends the exact "My plan?" chip prompt
  (`CHIPS.play[0]`) as a normal question — cached and saved to Lessons, and it shares the local
  answer cache with the chip for the same position. Evals on the card are White's point of view, like
  the rest of the app. **Play X** makes the best move via `onPlayMove`; the buttons
  disable themselves (`syncCards()`, called from `update()`) once the position moves on or it isn't
  your turn. Each card also has a **Back to my game** button (lower right, `closeDemo()`), enabled
  only while a demo is open. Older cards collapse to their header. Takes ~2.5-5.5 s per card here. **Replays still get
  the short coach one-liner** (`commentOnOpponentMove`, capped at 4), not a card, since there you
  play your own game move. Tested with Playwright including stubbed responses for the sharper-try /
  threat / loose rows; the "Why?" click and real threat/loose output in a live game were not run.
- **Opening reactions** ("Caro-Kann player, I see…") — free, no Claude call. `core/eco.py` indexes the
  vendored lichess-org/chess-openings TSVs (`core/eco_data/`, CC0, fetched 2026-09-28) by EPD, so
  transpositions into a listed position are recognised; **only exact positions in the table match**
  (an off-book move produces nothing until it lands on a named position). `core/opening_quips.py` maps
  names to hand-written lines by longest prefix (family or variation, ~65 entries; the rest get a
  generic "A {nickname} player, I see."). `POST /api/opening {fen}` returns the name + a quip;
  `openingQuip()` in `app.js` posts it as a `.msg.quip` bubble after an opponent move — bot games
  (`botMove`) and replays (`commentOnOpponentMove`, where it replaces the paid one-liner for that
  move). Guards: game started from the standard position, ply ≤ 16, max 3 per game, only for a new
  family or a variation that has its own line, and bland names ("King's Pawn Game") are skipped.
  Not built: tactic reactions ("nice fork") — only openings.
- **Known traps from the user's opening collection** (`core/repertoire.py`, 2026-09-30). Sources:
  `data/openings.md` plus any `data/openings/*.md` (gitignored; the first batch is course material, so it
  must not be committed), each with `##`/`###` section headers followed by a JSON list of `{"name", "pgn"}`
  — line names are ignored, only moves matter. A trap is labelled with the ECO name of the last named
  position before it (`_label()`); the section header is the fallback only if it starts with a real ECO
  family name, since course titles ("Win EVERY Game as Black", "Full Black Repertoire with 1...Nf6", "E4 / E5
  MASTERFILE") span many openings; otherwise the label is "from your opening files". A background thread
  (started from the server's `lifespan`, or by hand: `python -m core.repertoire -v`) evaluates every
  position (0.15 s, cached per EPD in `data/openings_evals.json`, so a new batch only pays for new
  positions) and marks a move in a line as a **trap** when it throws away ≥ `TRAP_SWING` 150 cp and
  leaves the other side ≥ `TRAP_EDGE` +2 — then re-checks that move at depth 20 (shallow evals misjudge
  gambits). Index: `data/openings_index.json`, rebuilt when the sources' combined hash changes; lookups return
  nothing until the first build is done. Keyed by EPD, so transpositions match. Shown on: the review's
  per-move cards (`public_review()` adds `trap`: `fell` on the trap move, then `punished`/`missed` on the
  reply) and the bot-game opponent card (`trap_punish`: the bot just fell in; `trap_warn`: you could fall
  in with the move you're about to play). Both are `trapRow()` in `app.js`, with a ▶ refutation demo.
  No Claude call. The source format also accepts files with no header (the file name is then the fallback
  section); a pgn with `{comments}`, `$n`/`!?` glyphs or `(variations)` is cut at the first such token.
  **State 2026-09-30:** `openings.md` (472 lines: Caro-Kann, Scotch, QGA, KID, Vienna, Vienna Gambit,
  Scandinavian, Traxler) + `openings/openings2.md` (1,401 lines, 23 sections) = 1,842 unique lines, 16,779
  positions, **403 traps** (196 set by White, 207 by Black; most in Italian/Traxler 72, Elephant 44, Vienna 34,
  Alekhine 32, Scotch 31). **2026-10-01:** added `openings/openings3.md` (406 pgns, 391 unique lines, 15
  sections, mostly gambit counters: Halloween, Alien, Elephant, Cochrane, Italian sidelines, Sicilians) →
  2,233 lines, 19,368 positions, **479 traps** (71 reachable only through the new file, 59 set by White;
  biggest: Two Knights 3.Bc4 Nf6 section 17, "Win Every Game As White" 10, Halloween 8, Elephant 7).
  Build took 30 min (cached evals reused). Cold build of the second batch: 58 min (≈380 new positions/min, then the depth-20
  recheck); the first batch alone took 15 min. The server keeps serving the old index while a rebuild runs.
  **Tested:** a review of a Scotch game with 5...Nf6?? 6.Nc3 (card rows "fell"/"missed", refutation demo, no
  page errors, Playwright with stubbed chat) and `/api/opponent_card` on both sides of that trap. **Not
  tested:** a live bot game reaching a trap (plain Stockfish rarely plays these lines, so the bot-card rows
  will be rare until the opening-book idea below). Some labels are odd where a line passes through a
  position the ECO table names unexpectedly (one Vienna-file trap is labelled "Benoni Defense: King's Pawn Line").
  Next idea, not built: use the same lines as an opening book for the bot (deeper and trap-seeking at higher
  levels, occasionally walking into traps at low levels) — check the setter's own moves for soundness first,
  since "Win every game"-style lines can rely on dubious gambits.
- **`Engine._call` is serialized with a lock** (`core/engine.py`). One Stockfish, several request
  threads (eval bar, GM check, coach tools, the card): overlapping `analyse` calls returned an empty
  line list and 500'd the card endpoint. `Bot` has its own process and lock.
- **Logo / favicon.** The user supplied a black crowned-piece JPEG (a Pinterest image; origin and
  license unknown, so check before making the repo public). It was converted (black→cream
  silhouette with alpha, cropped) into `static/logo-mark.png` (transparent, 256px tall; the `.brand`
  image on all three pages, 34px tall — on a badge it shrank to an unreadable blob at header size),
  and, centred on the accent-green badge with the buttons' darker lower edge, into `favicon-32.png`
  and `apple-touch-icon.png` (`/favicon.ico` in `server.py` serves the 32px one). The original JPEG
  is **not** in the repo and the conversion script wasn't kept: to redo it, map luminance to alpha
  (`(235 - lum) / 205`, clamped) and draw the cropped mark. Not checked in Safari/Firefox tabs,
  only that every link loads.
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
    close it).
  - Verified with Playwright pointer events; not tested with touch.
- **The name rows are capped to the board's width.** `--board-w` is defined on `.board-col` and used
  by both `.board-wrap` and `.player` (`max-width: 34px + --board-w`; 34px = 28px eval bar + 6px
  gap, same as the rows' `padding-left`). Without the cap the rows span the whole grid column,
  which is wider than the capped board, so right-aligned items hung off the board's edge (Takeback used to be one; the demo's "Back to my game" still is).
  The ≤760px override sets `--board-w` on `.board-col`.
- **`#summary` in a bot game shows no "Your move" / "Bot is thinking…" text** (removed on purpose).
  It still shows the game-over result, the "Viewing an earlier position" note, and Stop bot.
- **Opening explorer has no filter UI.** `explorerFilters()` in `app.js` is a constant: Lichess
  database, all rating bands, all six speeds. The speeds are listed explicitly on purpose —
  `explorer.explore()` turns a *missing* speeds list into blitz+rapid only, so "all" has to be
  sent. Masters is no longer selectable from the UI (the backend still supports `db="masters"`).
- **"Takeback Move" lives in the chat header** — a static `#pb-takeback` button in `.chat-head-right`
  (`index.html`), before the Moves & engine panel and New chat. `syncTakeback()` (called from
  `renderInfo()`) shows it only in a bot game and not in demo mode, and disables it until there's a
  move to take back; `updateEditor()` hides it. `dockGamePanel()` inserts the panel before
  `#btn-chat-reset`, so Takeback stays first. Nowrap on the right cluster; at ~1200px the title on the
  left may wrap instead.
- **One game load at a time.** `POST /api/load` returns 409 while `S.job` is `running` (one
  Stockfish, one global state); the message says to wait and retry. Loading a second game while
  the first is still being analysed is the usual way to see it. A load does *not* cancel the
  running one — see TODOs.
- **A loaded game is a replay; a different move branches off to the bot** (2026-09-29; the old
  "Play from position" button, its move dropdown and the `#dlg-from` dialog are gone). The review
  summary shows "Replay as [White][Black]" (plus "you were X"); picking a side calls `startReplay(color)`,
  which also sets the coach's player color (`setYou`) and starts **paused** at the current move, so
  nothing plays or costs anything until you move or press ▶. Exit replay drops to plain review (free
  exploration of both sides) and shows the picker again. In a replay the nav buttons / arrow keys step
  through the game (`replayView()`); stepping *pauses* it, so the opponent's move waits for ▶ instead of a
  timer (else stepping back past their move would bounce forward). Playing your game move resumes
  auto-play. A *different* move snaps back and sets `state.replay.deviation`: the summary offers
  "Play X vs bot" (`branchToBot()`) or "Take it back". The bot game starts from the game's own start
  position with the game's moves up to the branch preloaded (`play.prefix` = their count), then plays
  your move: ◀/⏮ step back through the original game, "Review this game" gets the whole game, and
  Takeback stops at the branch point (`takeback()`/`syncTakeback()` floor on `prefix`). The bot game keeps `play.back = {game_id, ply, color}` and shows "Back to the game"
  (`backToGame()`: `/api/saved/open`, no re-analysis, replay paused at that move). Branching resets
  the chat (one global state, a new coach), and so does coming back. The bot is picked automatically,
  no dialog; no clock. Replays and branched games keep the eval bar / engine lines per the saved
  `engineOn` setting (default on); the Play-a-game dialog's "Show engine eval" box defaults to checked.
  The branch's bot level (`botLevelFor(color)` in `app.js`) is announced in the chat note. Order: the
  rating of the player the bot replaces (the side you're *not* playing; the user's own rating is deliberately not the first choice, since they may be replaying a pro game they
  aren't in) → the rating of your own side → the level last used in "Play a game"
  (`localStorage` `botLevel`) → Intermediate ~1500 only for an analysis board or earlier bot games
  with no ratings. `levelForRating()` picks the closest bot level by parsing the `(~N)` in each level
  name from `/api/play/levels`. `BOT_LEVELS` in `core/engine.py` has Super-GM (~2700) and Elite GM
  (~2900) between Master and Full strength (Stockfish's `UCI_Elo` goes to 3190); Full strength is
  only picked from 3050 up. The rating-capped levels use a 0.5 s move limit while Stockfish
  calibrates `UCI_Elo` at much longer time controls, so they probably play weaker than labelled
  (inferred, not measured); the ratings are rough guides, and chess.com vs Lichess scales differ.
- **Opening lessons ("Learn openings", 2026-09-29).** `core/study.py` builds a lesson once per
  (opening, side) and saves it to `data/studies/<slug>.json` (gitignored like all of `data/`, so each
  clone rebuilds its own). Build = (1) the named line's move order from the vendored ECO table (the
  "trunk"), (2) a breadth-first walk of the **masters** explorer from there (`EXTRA_PLIES` 10,
  `MAX_NODES` 90, opponent width `OPP_WIDTH` 3/3/2/2/1, tries ≥ `MIN_SHARE` 8%, stop under `MIN_GAMES`
  30): on the student's turn one move — the masters' most popular, **unless** the engine's top move is
  also a master move (≥ 8%) and ≥ `PREFER_GAP` 20 cp better (then that one, `source: masters+engine`),
  or the popular move is > `ENGINE_SLACK` 60 cp worse (then the engine's move, `source: engine`);
  (3) an engine eval per node; (4) **one** structured-output call (`output_config.format`, schema
  `NOTES_SCHEMA`) that writes the overview + a note per node. Rating is deliberately *not* a factor (user's
  call: theory first). Lichess gives castling as king-takes-rook (`e8h8`); moves go through
  `board.parse_uci()` so stored UCI is `e8g8`.
  **What the colour changes:** the trunk is identical; the colour only decides which side is `mine` in
  `_build_tree()` — one move per position for you (masters + engine check), several master tries for the
  opponent (`OPP_WIDTH`, no engine filter, so a dubious but popular opponent try stays in). Plus the notes
  prompt's perspective, board orientation and which side Drill lets you move.
  **One side per opening (2026-10-01, user's call: no colour picker for now).** `study.side(name)` decides it
  and the server derives it (`StudyReq` has no colour; the dialog row says "you play White/Black"). Rule:
  whoever *chose* the named line, read from the most specific part of the name back — Defense /
  Countergambit / Counterattack / Accepted / Declined → Black, Attack → White ("System" deliberately not a
  keyword: Hedgehog, Zaitsev, Gurgenidze are Black's), a "with … Defense" part is skipped (the Vienna Gambit
  ECO name), a Gambit → the side that's material down at the end of its named line after the opponent's
  best capture (`_gambit_balance()`: handles Halloween Nxe5, Cochrane/Alien Nxf7, Hamppe-Muzio …gxf3), any
  other part with its own ECO entry → that entry's last mover. `SIDE_OVERRIDES` (also covers sub-variations)
  is the fix for misfires as they're found; so far Marshall Attack → Black and Ruy Lopez: Closed → White.
  Known judgement calls left to the rule: Black "Defense" variations inside a White family (Vienna: Max Lange
  Defense → Black), White's sidelines inside a Black opening (Scandinavian: Leonhardt Gambit → White).
  Lessons built earlier for the other colour (`queen-s-gambit-accepted-white`,
  `catalan-opening-open-defense-classical-line-white`) are still on disk but no longer reachable.
  Untested idea if the overrides grow: pick the side your own opening files (`data/openings*.md`) play.
  **Notes quality, what was learned:** Sonnet 5 with just the move list wrote chess-wrong notes ("…e5 hits
  the bishop on e3", "a protected passed pawn on d5"). Two fixes: each row carries **board facts** from
  `features.move_effects` (captures / attacks / pins / loose pieces / structure changes) plus the
  engine's top choices, and the prompt limits concrete claims to those; and the notes model is
  `STUDY_MODEL` (default `claude-opus-5-5`, one call per lesson, ~$0.25, ~90 s). Opus's notes checked out
  on a read-through; Sonnet's still had errors with the facts. Remaining guard: `_verified()` drops a note
  that names a move not in the tree and not legal anywhere along that node's own line (either side to
  move). Claims about plans aren't machine-checked — read new lessons with that in mind.
  A cold build is ~3 min (≈1-2 s per explorer lookup, patient on 429s) + ~1 min engine + the notes call
  (76-126 s measured on Opus 5.5), so 4-6 min in all; the dialog shows elapsed time;
  rebuilds reuse the explorer disk cache. `POST /api/study/build` runs it in a thread (`STUDY_JOB`, one at a
  time), `/api/study/start` opens it as a fresh analysis board whose coach gets `study.coach_note()` (the
  overview) as its session note; `board_context()` then calls the moves "on the board in the opening lesson".
  **Frontend** (`app.js`, "opening lessons" section): `state.study` on top of the analysis board
  (`state.extra` = moves from the start, `studyNodeHere()` maps them to a node). **Learn** (guided, 2026-10-01):
  one move at a time — `studyGuideShapes()` draws the next lesson move (green on your turn; on theirs the
  most common try solid blue, other tries pale) plus `studyThreatShapes()`: what the last move *newly*
  attacks (enemy pieces the mover hits now but didn't before, so discovered attacks count; pawns only if
  undefended; checks in the check colour). The square of the piece about to move is filled
  (`studyNextSquares()`, classes `sq-next` green / `sq-next-opp` blue per try) via chessground's
  `highlight.custom` in `paintSquares()`, which `update()` now calls on every position change (chat
  square hovers/pins go on top of it). You play only your side (`canMove` = your colour, as in Drill)
  and advance only by playing the arrowed move; anything else snaps back with one nudge per position. The
  opponent's reply is automatic (`studyLearnStep()`): their try arrows stay up for `LEARN_PAUSE_MS` 1 s, then
  a pick weighted by master share (`weightedPick()`; was "random within 0.3 pawns by eval" until the user
  asked for popularity — the stored evals are depth-16, so 0.3 was within noise), so ◀ back to your move and
  replaying can show another reply.
  **Curveballs (2026-10-01; user: "a random curveball keeps me engaged", they autopilot otherwise).**
  `add_curveballs()` in `core/study.py`: per opponent-to-move node, the Lichess DB's moves by 1000-1800
  players (blitz/rapid/classical, ≥ `CURVE_MIN_GAMES` 20, top `CURVE_CANDIDATES` 4 non-lesson moves) that lose
  ≥ `CURVE_MIN_LOSS` 120 cp at depth 18; stored as `node.curveballs` = `[{san, uci, games, loss, eval_white,
  line, pv, punish: [{san, uci, eval_white}]}]` (punish = engine best + any within `CURVE_ACCEPT` 50 cp). No
  Claude call. Runs in new builds; existing lessons: `python -m core.study curveballs [slug…]`. Najdorf: 7
  found, e.g. 7.f3/7.Be2/7.O-O?? leaving the d4 knight to …exd4 (1,500-2,500 club games each), 8.e5? in the
  Poisoned Pawn. Frontend (Learn and Drill): `studyCurveball()` fires with `CURVE_CHANCE` 0.3 at a node that
  has one, max one per run through a line (`st.curveUsed`, reset at the root / mode switch), never on the
  opponent's first move. `studyThrowCurve()` puts the move on the board (off the tree: `st.curve`, no guide
  arrows), you must play a `punish` move (`studyCurveAnswer()`; miss 1 circles the piece, miss 2 draws the
  arrow, via `curveShapes()` in `baseShapes()`), then a card with the engine line, ▶ Show the line (demo from
  the curveball position), Why? (paid, only on click) and Back to the lesson; ◀ during a curveball also
  resumes the lesson at that node (the opponent then plays a lesson move). Curveballs don't count for
  mastery. Tested with Playwright (forced and natural via `Math.random` stub, both modes, right/wrong
  answers, ◀). Only the Najdorf has curveballs so far. `startStudy()` calls it too (a lesson opens in
  Learn, so as Black White's first move plays itself; the start card has no "Learn" button, only Drill me); that first
  card doesn't fold the overview. ◀ in Learn, like Drill, lands on your own move. ▶/⏭ are disabled
  in a lesson (`update()`); ◀/⏮ still work. These arrows go through `baseShapes()`, which `renderBoard()`,
  `renderShapes()` (hover / right-click arrows) and `previewMove()` all include, so hovering doesn't wipe
  them. Cards name the moves as text (no buttons, so the card can't skip the board). A card per node
  (`studyCard`, once per session) with the note and "Your move" or "Their tries". **Cards no longer
  auto-fold** (user: they reread them afterwards); a header click still folds one. **Coach chips live on the
  cards in Learn** (`CHIPS.study`, on your-move cards and line ends): the bottom `#chips` row is hidden in
  Learn (`renderChips()`; `setStudyMode()` re-renders it, Drill keeps the bottom row since it posts no move
  cards), and `syncCards()` shows a card's chip row only while the board is on that card's position
  (`studyChipLive()`), so ◀ brings an older card's chips back. `studyGo()` bumps `studyToken` and clears
  `waiting`, so any jump cancels a pending automatic reply. Tested with Playwright via
  a temporary `window.__debug` hook (Catalan: wrong move, forward, main line, 3...Bb4+ check arrow).
  **Drill**: you play your side (`canMove`), the opponent answers after 650 ms, picking among the
  tries weighted by master share × unmastered lines under each; wrong move = circle on the piece first,
  the arrow + note on the second miss (one mistake counted per position). A line is **mastered** after
  2 clean runs in a row (`localStorage` `study-m:<slug>`); ◀ in a drill steps back to your own move.
  Chips: "Walk me through this" sends the lesson's next moves and the opponent's tries with the question
  (so the coach explains *this* line), plus My plan / Guess / Why / Main lines. **Lesson text rendering**
  (`lessonText()` / `lessonInline()`, overview + notes + wrong-move cards): its own tokenizer, not the chat's
  `markdown()`, because moves must resolve to *lesson nodes*: `studyFindMove()` matches "3...d5", "Qc2",
  "...b5" and long forms like "e2-e4" to a node (move number if given; prefers the note's own line, then
  the earliest), rendered as `.lm` buttons that open the demo board just before that move and play it,
  with the lesson's notes as per-move demo notes (`studyShowNode()`). A bare pawn push without a number
  or "..." ("d5") is treated as a square (`.sq`, gold dotted inside lesson cards, hover-highlights via
  `addMsg`), so "g3" in prose is a square, not a button. Unmatched moves are bold, not clickable. Lead
  phrase before ":" is bold; opening names (Catalan, Benoni, Open Catalan…) italic. Ideas noted but not built:
  standalone "find the key move" puzzles from a lesson (…h5, …b5, …Qa3), move symbols (!, !?) on cards.
  Built and read through: Najdorf and Dragon as Black. Tested with Playwright (stubbed chat): picker,
  Learn branches, back/forward, off-lesson moves, the walkthrough question, a drill with a wrong move.
  **Playing on after the theory (2026-10-01).** In Learn, reaching a leaf starts a bot game from that
  position after `PLAY_ON_DELAY_MS` 1.5 s (`studyPlayOn()`): level random among bot levels with ~Elo in
  `PLAY_ON_ELO` [1500, 2000] (Intermediate / Strong club / Expert), the lesson line preloaded as `play.prefix`
  (Takeback floors there), bot moves first if the line ended on your move. `/api/play/new` takes `lesson`
  (coach note says it's a play-out of that lesson). `setReview(..., {keepChat: true})` keeps the lesson
  cards in the chat. The game header has "Back to the lesson" (`play.backLesson` → `backToLesson()`:
  `/api/study/start`, restores the same `state.study` object at the leaf, `noPlayOn` stops it bouncing
  straight back into a game). Drill's line-complete card has a "Play it out vs a bot" button instead.
  **Family lessons (2026-10-01; user: "type scotch and you get overloaded… build the lesson to encapsulate
  more of these variations and explore them within the lesson").** `lesson_key(name)`: a name's picker
  row/lesson is its *family* (before ":") when the family has its own ECO entry and ≤ `FAMILY_MAX` 60 names
  (139 of 149 families), else its variation group (the 10 big ones: Sicilian, Ruy Lopez, French, Italian,
  KID, Caro-Kann, Nimzo, QGD, English, King's Gambit Accepted). "scotch": 4 rows (Scotch Game with 47
  variations + three other families' Scotch-named lines). Building a family name (`is_family_lesson()`)
  runs `_seed_family()` after the usual master walk (`walk()`, now a reusable closure in `_build_tree()`):
  every family line that passes through the lesson's own position is added — opponent moves however rare
  (`source: "named"`), your own moves only if within `ALT_SLACK` 45 cp of the engine's best (then `alt:
  true` when a main move exists; 70 let the Relfsson 4.Bb5 in) — then `SEED_EXTRA` 4 plies of master play
  with one opponent try. Cap `FAMILY_MAX_NODES` 220. Scotch dry run (tree only): 163 nodes, 38/48 names
  (missing: Benima — other move order — and lines behind a White move the engine rejects), 6 min, so a full
  family build is ~10-12 min and a bigger notes call (estimate $0.30-0.50, not measured). Transpositions
  from other families aren't merged. Frontend: your alternatives are pale-green arrows (+ squares), the
  card says "or explore: 4. c3 (Göring Gambit) · 4. Bc4 (Scotch Gambit)" (`studyVariationOf()` looks up to
  4 plies down for a name); opponent tries are `.study-try` buttons (work during the pause or right after
  their reply, swapping it); `studyLeaves()` follows only your main move, so Drill and mastery ignore
  alternatives. Tested in Playwright with a temporary notes-less Scotch lesson from the dry run (deleted).
  No family lesson has been built for real yet; lessons already built under a family name (Vienna Game,
  Catalan Opening, QGA, Scandinavian…) are the old single-path kind until rebuilt.
  **Grouped picker (2026-10-01; user: "search 'dragon' and you get every one-off variation").**
  `study.search()` returns one row per *variation group* = the ECO name before the first comma
  (`_group()`: "Sicilian Defense: Dragon Variation"), with its comma sub-variations in `subs` (3,174 names →
  1,427 groups; "dragon" 45 → 7 rows). A group is listed when its name matches (with all subs) or a sub
  matches (with just those); 69 groups have no ECO entry of their own (`no_entry`, not buildable, subs
  only). Every sub is still buildable as its own lesson. `in_lesson` marks a sub whose position (EPD) the
  group's built lesson already contains (Dragon: 11 of 31). The dialog folds subs under "▸ N variations ·
  K already in this lesson" (open by default when the match came from a sub). `study.load()` now fills
  `node.opening` from `eco.lookup()` on every load (no rebuild), and `studyOpeningName()` puts a new
  name on the card header ("Yugoslav Attack, Main Line"): only names inside the lesson's group, or a
  different opening after the trunk (a transposition); the trunk's general names are skipped. Side of a
  sub can differ from its group (Yugoslav Attack → White by `side()`); Dragon players get it inside the
  Dragon lesson as Black.
  **Overview → moments (2026-10-01; user: the overview was too dense all at once).** `tag_overview()` in
  `core/study.py` makes one extra call (`STUDY_MODEL`, structured output `MOMENTS_SCHEMA`) that gives each
  overview bullet a 3-6 word title and up to 4 lesson node ids where its situation has just arisen, saved as
  `study["moments"]` = `[{kind, index, title, nodes}]`; the overview text is unchanged (the coach's session
  note still uses it). Bullets the model skips get `nodes: []`. New builds run it after the notes call (a
  failure leaves the lesson without moments, not broken); older lessons: `python -m core.study tag [slug…]`
  (prints where each bullet landed). Najdorf: 22 s, $0.085, 21/21 bullets placed, placements read as right.
  Frontend: with moments, the start card is the summary + a folded "Ideas you'll meet on the board · n/N
  seen" checklist (seen titles open to the text); in Learn each move card gets that node's not-yet-seen
  bullets as callouts (`momentCallout()`, first one open, the rest folded titles); a line's last card adds
  "Your plan from here" (titles met along the line + untagged bullets). Lessons without moments show the
  overview whole as before. Moves inside lesson text (`studyShowNode()`) now play on the demo board from
  where your board and that line split, stepping forward every `LESSON_STEP_MS` 650 ms, instead of
  jumping from move 1; hovering a lesson move that's playable right now draws its arrow. Not built yet:
  Drill questions from moments ("What's White going for?", find the break, avoid the mistake). Only the
  Najdorf is tagged so far.
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
  A **"Results by opening as White"** section (added 2026-09-29) comes from the user's chess.com Insights
  screenshots (not the API; Insights needs their login): QG/Scotch/Vienna good, 1.d4 without c4 and the
  Philidor weak. Samples are 18-73 games, so it's framed as hints, raised only in that opening. The Black
  tab wasn't captured yet.
- **`.env` is gitignored** and must be recreated on every machine/clone
  (`ANTHROPIC_API_KEY`, `LICHESS_TOKEN`, optional `CHESS_USER`, optional `ANTHROPIC_ADMIN_KEY` +
  `MONTHLY_SPEND_LIMIT` for the `/usage` page's org-spend card). This machine has two local
  clones — `/Users/will/chess-coach` (primary) and `~/Projects/chess-coach` (secondary,
  kept in sync via `git pull`) — each needs its own `.env`.
- **Jump buttons / `jump_to_move` tool** (`core/coach.py`, `renderAnswer()`/`jumpToPly()` in `app.js`).
  The coach attaches "⏭ Jump ahead to move N" buttons (max 3, deduped by ply) to an answer. Args:
  `ply`, `move` (SAN, **validated against the game** — a wrong ply is rejected with "ply 25 is
  13. Nb5+, not Be6. Be6 was played at ply 18", which the coach then fixes; this exists because
  one live run put the button on the wrong move), optional `go_now`. **Ply convention trap:** the
  coach's `ply` is the position *before* that move (`_board_at`), while the frontend's `goTo(n)`
  means "n plies played" — the button calls `goTo(ply - 1)`. `go_now: true` (used when the coach
  *asks* "what would you play as White's 10th move?": White's move n = ply 2n-1, Black's = 2n)
  moves the board automatically as the answer appears, with no button. Auto-jump only fires for a
  fresh answer (`opts.live` from `ask()`, not one reopened from Lessons) and not mid-replay. In a
  replay `jumpToPly()` moves the replay itself (`goTo` ignores replays) and swaps the `state.replay`
  object so a pending opponent-move timer stands down; in bot games and the set-up board there is
  no game timeline, so the button is hidden. Stored in `library.jump` (JSON list, auto-migrated) so
  cached answers keep their buttons. Not in the "checks" bubble (filtered like `show_on_board`).
- **Chat chips** (`CHIPS` in `app.js`): entries are `[label, question, needs, action]`. `needs:
  'game'` hides a chip unless a game with moves is loaded (so `setReview()` calls `renderChips()`
  *after* setting `state.review`); an `action` runs locally instead of asking the coach. Hover text
  is the `CHIP_TIPS` table (custom `data-tip`, opens upward, flips right near the panel edge).
  - **Game-changing moment**: free and instant, no coach call. Picks the move with the largest
    `win_pct_lost` in the saved review, jumps to the position before it, posts a note with an
    "Explain why" button (only that click costs money). `public_review()` had been stripping
    `win_pct_lost` and `eval_before`; they're sent now. Under 10% it says no single move decided the game.
  - **Why this move?** (was "Quiz me": open-ended, about the last move) and **Guess the next move**
    (was "Show me": a `move_quiz` on the move to come). A quiz click only reveals the reward in the
    browser and never messages the coach, so the coach can't "wait" and continue: it's one quiz per
    press, and the UI adds "Play it on the board, then press “Guess the next move”…" after a correct
    pick (game review only). `move_quiz` reward cap is 300 chars (200 truncated mid-sentence). The coach
    sees the game's real continuation and leaked it ("9...Be6 was the real mistake") until the chip
    text said not to spoil; if the leak returns, that wording is the place to fix it.
- **`move_quiz` fairness is enforced by the engine** (`Coach._check_quiz_fairness`): the marked answer must
  be within 30 cp of the best move and every wrong option at least 80 cp worse, or the tool errors with
  the numbers and the coach must swap decoys or skip. Found 2026-09-29 by running "Guess the next move"
  on seven board states: one quiz marked a move "wrong" that was 23-65 cp behind the answer. The retry
  makes the model rewrite its lead-in, so `_final_answer()` drops an earlier part that a later part
  rewrites (difflib ratio > 0.6). Perspective: the coach is told "To move" and "The player is playing";
  the chip text makes it say whose move it is and, on the opponent's turn, "step into their shoes"
  (it used the opponent's username), with you/your only for the side to move. Start and final
  positions correctly produce no quiz. Still seen: a filler closer ("Give it a think…") and sloppy
  wording ("d5 forks the c6-knight"). Hypothetical lines quiz the board position fine.
- **Bot-game chips** share definitions with the review chips (`CHIP` in `app.js`; `CHIPS.review` / `CHIPS.play`):
  My plan?, Best move, Hint, Guess the next move, Why this move?, Show main lines. Left out on purpose:
  Game-changing moment (needs a finished game's per-move scores and a timeline) and "What should I have
  played?" (after the bot moves, "this move" is the bot's, so the coach assessed the bot's move instead of
  yours). "Test me" was replaced by Guess the next move. Checked live on a bot-game position: Guess works,
  perspective correct; other chips not run in a bot game.
- **Coach latency is mostly thinking tokens, and it is tunable.** `COACH_EFFORT=low|medium|high|xhigh|max`
  (sets `output_config.effort`) and `COACH_THINKING=off` (`_thinking_kwargs()` in `core/coach.py`, read on
  every call; defaults unchanged = adaptive thinking at Sonnet 5's default `high`) — put them in `.env`.
  **Measured 2026-09-29** on `claude-sonnet-5`, chip questions on a bot-game position plus two tactical
  positions of `cc184224792278`, one sample per cell so noisy: API time tracks output tokens at ~72
  tok/s; mean API seconds per question over 7 runs was **baseline 38 s, effort=low 19 s, thinking off 20 s**
  (medium, 3 runs: 40 s, inconsistent). Quality check: on the tactical positions every variant that gave
  a move gave the engine's best or a move within 1 cp of it (14 graded outputs, all fine); prose was not
  graded beyond a read-through. "Thinking off" once needed 8 API calls (retries), low was steadier.
  **Not adopted** (decision 2026-09-29: accuracy over speed, don't knowingly or suspectedly trade quality
  for it): thinking may matter more in sharp middlegames the tests didn't cover (see "Model choice" for the
  regression signals to watch). The knobs exist for a later, evidence-based change. Likewise the explorer
  `BUDGET` stays 20 (a smaller budget means fewer/shorter lines).
- **Explorer cold walks are slow and rate-limit-prone.** `opening_lines` → `openings.main_lines` costs about
  **1 s per Lichess request** (network latency, not the 0.35 s pacing), all serialized by design: budget
  8 = 16 s, 12 = 19 s, 20 (`BUDGET` now) = 27 s (28 requests) on a cold position. One unspaced run hit
  Lichess's 429 mid-walk and returned `partial=True` (shortened/unnamed lines) and then blocked the
  following requests for about a minute, so don't benchmark it in a tight loop. Disk cache
  (`data/explorer/`, a month) makes repeats instant; practice-game positions are usually cold.
  **Two accuracy/latency fixes (2026-09-29, no quality trade-off):**
  - `explorer.explore(..., patient=True)` waits out a 429 (Retry-After, else 61 s; up to 3 attempts)
    instead of failing, so a walk completes and isn't shortened/unnamed. A shared `_cooldown_until` makes
    other callers stand down; **the coach's tools are patient** (`functools.partial` in `make_coach`),
    the interactive explorer panel and `/api/lines` still fail fast. Worst case a walk is ~1 min slower.
  - `_warm_explorer()` in `server.py`: after each bot move in the opening (`fullmove_number <= 8`, hooked
    into `/api/opponent_card`) a background thread runs the coach's default walk (masters, depth 6) so
    "Show main lines" finds it on disk. One at a time, supersedes itself when the position moves on,
    never raises. Verified: a walk after warm-up took 0.00 s / 0 requests (small tree, so the full
    28-request case wasn't exercised). Costs extra Lichess traffic (up to ~28 requests per opening move).
- **Loaded games open at move 1** (`state.ply = 0` in `setReview()`); they used to open at the last
  move when your side was known. This also applies to a page reload and to opening a saved game.
- **Engine memo + timing.** `Engine.lines()` caches results in memory (`LINES_CACHE_SIZE` 1024) keyed
  on `(board.epd(), multipv, seconds, depth)`: not persisted (empty after a restart), ignores
  repetition history, and a different budget is a separate entry, so 0.3 s review evals are *not*
  reused by the coach's depth-22 searches. `Coach.ask()` prints one line per uncached question to the
  server terminal (`coach: 8.4s total | api … | tools … | engine N search(es), M cache hit(s)`) and
  stores the same in `usage.calls` (`api_seconds`, `tool_seconds`, `engine_searches`,
  `engine_cache_hits`). **Measured 2026-09-29** (5 chip-style questions on one game): 25-89 s each,
  **Claude API time dominated** (25-77 s over 3-6 calls); tool time was 21 s cold and 0-1 s once the
  cache was warm. So the engine cache helps follow-ups on a position but isn't the main cost;
  fewer tool round trips would be the next lever. Not persisted to SQLite on purpose.
- **Three different "caches":** the local *answer* cache (SQL, `data/library.sqlite`, exact match),
  the *engine* memo above (in-memory dict), and Anthropic's *prompt* cache (server-side, 5 min). The
  library stores tool *names and inputs* only, never the engine's output.
- **Testing without touching your running server:** start a second instance
  (`(set -a; . ./.env; set +a; .venv/bin/python -m frontends.web.server --port 8011 &)`), load a
  saved game into it with `POST /api/saved/open {"game_id": "...", "me": "sirwill3rd"}` (games are in
  `data/reviews/`), then drive the page with Playwright (in `.venv`, not system `python3`, which has
  no project deps). Stub `**/api/chat` to avoid API spend. To test the coach itself, build
  `Coach(review, Engine(), player=...)` in a script and call `ask()` (loads `.env` by hand; no `dotenv`).
  **The server does not hot-reload Python**: after editing `core/*.py` or `server.py`, restart it
  (prompts and `static/` are re-read live). Its output goes to the terminal that started it;
  `/tmp/chess-coach-server.log` is stale.

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

**Sonnet 5.5 (`claude-sonnet-5-5`) tried and not adopted (2026-09-29).** Same price as Sonnet 5 and
`core/usage.py` already prices it, but it is **not a drop-in swap for this app**: it returns text written
*between tool calls* as `thinking` blocks (empty by default) instead of `text`, and `Coach.ask()` only
collects `text`. The coach usually writes its explanation before a closing tool call (`show_on_board`,
`move_quiz`), so answers came back as a one-line closer ("Look to play Bxf4 next…"), empty, or starting
"One correction:…" about text the player never saw. Tried `thinking: {type: "adaptive", display:
"updates"}` (beta `thinking-display-updates-2026-08-18`) and reading non-empty thinking blocks as answer
text: that returns only *summaries* of those notes ("I've laid out a response plan…" without the plan), so
it doesn't fix it; reverted. What a switch would need: (1) a prompt rule to write the whole answer after
the last tool call (edits `prompts/coach.md`, so one answer-cache reset), or (2) a "send the player a
message" tool for anything shown mid-answer (Anthropic's recommendation for UIs that don't render
thinking); then rerun the comparison and check answers arrive whole. `COACH_THINKING=off` on 5.5 uses
`between_tools` (already handled in `_thinking_kwargs()`), whose notes are also summaries.
Measured (3 positions of `cc184224792278` × "Best move"/"My plan?", one sample each, moves graded against
Stockfish at depth 22): both models named the engine's top move 6/6; Sonnet 5.5 was faster ("My plan?"
37-48 s vs 43-91 s) but wrote fewer visible words, so part of that may vanish once answers are whole.
Decision: stay on Sonnet 5 (no accuracy gain shown; speed alone wasn't worth a new failure mode). Revisit
if Sonnet 5 gets a retirement date or latency becomes the priority. The throwaway comparison script
wasn't kept: it built `Coach(review, Engine(), player=...)` per question, asked with
`context=coach.board_context(ply - 1, [])`, took the first legal SAN in the answer, and needs `os._exit(0)`
at the end (the engine thread keeps the process alive otherwise).

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

### Next focus (2026-10-01): opening lessons

The user wants to spend the next session on "Learn openings" (`core/study.py` + the app.js "opening
lessons" section). Open items already noted elsewhere: read the English and Catalan notes, a live
"Walk me through this" run, key-move puzzles, move symbols, the bare-pawn-move-as-square quirk, and
any lesson that builds for the wrong side (add it to `SIDE_OVERRIDES`, see "One side per opening").

### Revisit next session (from 2026-09-29)

- **Finish `TESTING-2026-09-29.md`.** Only part of it was run. The user's two priorities: does each
  "⚠ Big moment" explanation match its card (section 3), and are the lesson notes chess-correct (section 5).
- **Branch chat note without a rating.** The user reported that "Play X vs bot" showed no Elo in chat;
  not reproduced (a 2026-09-29 repro with game `cc184578823450`, user kustomkings, printed "matched to
  VincentxPenzXX's 1019 rating"). Their message cut off before what they saw. Get a screenshot and the game,
  and check for a stale cached `app.js` first.
- **Read the English and Catalan lessons' notes** (built by the user, not read through yet; only the
  Najdorf and Dragon were). Same checks as before: claims about what a move attacks/pins must match.
- **Live coach runs** in the new features, all tested only with a stubbed `/api/chat` so far: "Walk me
  through this" in a lesson, "⚠ Big moment" answers, Why? on a move card.
- **"Review this game" after branching** off a replay (should analyse the whole game from move 1).
- **chess.com Insights, Black tab**: ask for the screenshot and extend `player.md`'s results section.
- **Lesson ideas not built:** "find the key move" puzzles pulled from a lesson (…h5, …b5, …Qa3), move
  symbols (!, !?) on cards. Known quirk: a bare pawn move in lesson text ("g3") renders as a square, not a
  move button, because only numbered/"..." pawn moves are unambiguous.


- **Duplicate board-link buttons.** Decide whether to drop the bottom "Show me: ..." row now
  that inline per-point buttons cover almost everything, keep both, or something else. User
  wanted to use the app for a while first before deciding — revisit when asked.
- **Local ECO opening-name dataset** — *partly done:* it's vendored and used for the opening reactions (see above), but the explorer panel and the coach's tools still use the live explorer's names. (Original note:) (e.g. vendor `lichess-org/chess-openings`, the same data
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
  "Play a game" dialog (`dlg-play` → `startGame()`). Branching off a replay
  doesn't have a clock option — that was out of scope for the original ask, not an oversight,
  but worth adding if wanted later.
- **Named/"trick" sidelines are prompt-driven, not systematic.** `prompts/coach.md` ("Tricks, not just
  the engine line") tells the coach not to bury famous sidelines (Traxler, Halloween/Alien Gambit,
  Englund, Danish…) just because the engine ranks them lower, and to state the facts and the risk. It
  still relies on the model recognizing the line. Not built: an explorer check for moves that are
  played often but engine-worse (one extra tool call per opening question, needs `LICHESS_TOKEN`).
  Discovered because answer 233 in the library said the Traxler's `...Nxe4+` "forks king and queen"
  after 5.Nxf7 Bxf2+ 6.Kxf2; a knight on e4 doesn't attack d1, so this looks wrong (**not verified
  with the engine**) — worth checking, and evidence that coach claims need tool verification.
- **`jump_to_move` / `go_now` live coverage is thin.** Tested: backend validation, the browser with a
  stubbed answer, and single-turn coach runs on one game (`cc184224792278`). Not tested: a real
  multi-turn walkthrough ("try again for White's 9th move" → board at ply 17), or many games. Coach
  quirks seen: a lead-in that calls the opponent's piece "your knight", a filler "Give it a click…"
  line, and answers that say "move 18" for a ply (prompt now says never show ply numbers).
- **Move chips drop the move number** in the Game-changing note ("Be6", not "9...Be6"); the Explain
  question has the full move. Cosmetic, from the chat move-chip renderer.
- **Not built:** persisting engine results across restarts (would need Stockfish-version/hash
  invalidation); a depth-tolerant engine cache (serve a deeper result to a shallower request); a
  "clock" for Play-from-here (older TODO, still open).

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

## Recent major work (2026-09-29 session)

Investigated the coach skipping the Traxler (4...Bc5): the bot is plain Stockfish with no book, so
the miss was the *coach* (Lessons entries 230/233 show it listed the Traxler briefly, then gave
engine numbers, +1.33 vs +0.20 for 4...d5, only when asked) · prompt rules: never bury a famous
named sideline or YouTube "trick" opening, state facts and risk; lead with a pointed question
(Test me / Hint / "what's the point") instead of the answer, with a where-to-look scaffold · the
`jump_to_move` tool and "Jump ahead to move N" buttons (SAN-validated, multi, saved with library
entries, `go_now` auto-jump for "what would you play here?") · loaded games open at move 1 · in-memory
`Engine.lines()` memo plus per-question timing logs and `usage` columns (finding: API time dominates)
· a free, local "Game-changing moment" chip with an Explain button · "Quiz me"/"Show me" became "Why
this move?" / "Guess the next move" (`move_quiz`, no spoilers, follow-up hint in the UI) · hover
tooltips on every chip. Commits: `cc87308`, `1a2242b`, `0eed228` (+ this notes commit).
