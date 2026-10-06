import { Chessground } from './vendor/chessground-9.2.1.js';
import { Chess } from './vendor/chess-1.4.0.js';

const $ = (id) => document.getElementById(id);
const FLAG = { inaccuracy: '?!', mistake: '?', blunder: '??' };

const state = {
  review: null,     // game (or empty analysis board) from the server
  ply: 0,           // board shows the position after this many game plies
  extra: [],        // SAN moves tried on the board on top of that
  orientation: 'white',
  engineOn: true,
  me: '',
  coachReady: false,
  explorerReady: false,
  replay: null,     // replaying a loaded game: {color, hint}; the opponent follows the PGN
  chatBusy: false,
  play: null,       // practice game vs the bot: {color, level, levelName, moves, view, over, thinking}
  editor: null,     // position set-up: {tool, turn, prev: {orientation}}
  study: null,      // an opening lesson: {data (the tree from /api/study/start), mode: 'learn'|'drill', node, waiting, mistakes, hint}
  demo: null,       // coach's "show me" line on a grey board: {title, ply, then_moves, start_fen, moves, notes, step}
};

// [label, question, needs, action]. 'game': only offered when a game with moves is loaded.
// A chip with an action runs locally (no coach call) instead of asking the question.
// Each chip is defined once and shared by the review and bot-game lists below.
const CHIP = {
  best: ['Best move', 'What is the best move here, and why? Keep it concise — concrete effect, my plan, opponent response if relevant.'],
  why: ['Why this move?', "Quiz me on why this move was played — ask me first what its point was, wait for my answer, then tell me if I've got it and fill in whatever I'm missing."],
  should: ['What should I have played?', 'What should have been played instead? Just the concrete difference — what it achieves or what my move allowed.'],
  guess: ['Guess the next move', "Quiz me on what to play from this position with move_quiz: a few real options, no hint "
    + "beyond the tension on the board, in one or two sentences. Open by saying whose move it is and whether "
    + "that's my side or my opponent's (if it's theirs, tell me to step into their shoes), and use 'you/your' "
    + "only for the side to move. Don't end with 'give it a click'. Don't say what happened in the actual "
    + "game or which option is wrong: that would spoil it. Keep the reward under 40 words: why the move "
    + "works and what to expect back. If there really isn't one correct move to find here, skip the quiz and say why."],
  lines: ['Show main lines', 'Show me the main lines from this position: how to play them properly, the ideas for both sides, and the key traps.'],
  // needs a finished game's per-move scores and a timeline to jump in, so not offered in bot games
  turning: ['Game-changing moment', null, 'game', () => gameChangingMoment()],
  plan: ['My plan?', "What plan should I be aiming for in this position? Start with a one-line opponent "
    + "check labeled 'Opponent:' — anything hanging or threatening right now, or that nothing is if "
    + "it's quiet. Then give me: the move to play and why; my opponent's realistic tries here, with a "
    + "counter for each; then spell it out as if-then — if they play X, I play Y; if they try Z, I "
    + "play W; anything else, I just play <default move>. Keep it short and concrete."],
  hint: ['Hint', "Give me a hint without telling me the move. If there's one genuinely correct move here, "
    + "use move_quiz so I can guess from a few options instead of just describing it."],
};
const CHIPS = {
  review: [CHIP.best, CHIP.why, CHIP.should, CHIP.guess, CHIP.lines, CHIP.turning],
  // no CHIP.should here: after the bot moves, "this move" is the bot's, so "what should I have played?" misfires
  play: [CHIP.plan, CHIP.best, CHIP.hint, CHIP.guess, CHIP.why, CHIP.lines],
  // an opening lesson: "Walk me through this" sends the lesson's own continuation with the question
  study: [['Walk me through this', null, null, () => studyWalkthrough()], CHIP.plan, CHIP.guess, CHIP.why, CHIP.lines],
};

// hover text for each chip, by label
const CHIP_TIPS = {
  'Best move': 'Asks the coach for the best move here: what it does, your plan, and their likely reply.',
  'Why this move?': 'The coach asks what the last move was for, waits for your answer, then tells you what you got and what you missed.',
  'What should I have played?': 'What should have been played instead, and what the move played allowed.',
  'Guess the next move': 'A multiple-choice quiz on what to play here. Play the right move, then press it again for the next one.',
  'Show main lines': 'The main lines from this position: how to play them, the ideas for both sides, and the key traps.',
  'Walk me through this': "The coach explains this position in the lesson: what you're aiming for, what they're trying, and the lesson's next moves.",
  'Game-changing moment': 'Free and instant: jumps to the move that cost the most win chance in this game. Its Explain button asks the coach why.',
  'My plan?': 'Their threats first, then your move, their realistic replies, and an if-then plan for each.',
  'Hint': 'A nudge without the move: pick from a few options.',
};

function store(key, value) {
  try { value === undefined ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {}
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

async function api(path, body, method) {
  const res = await fetch(path, body === undefined ? { method: method || 'GET' } : {
    method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- board

const cg = Chessground($('board'), {
  coordinates: true,
  animation: { duration: 180 },
  highlight: { lastMove: true, check: true },
  movable: { free: false, showDests: true, events: { after: onBoardMove } },
  premovable: { enabled: false },
  events: {
    select: (key) => onEditorSelect(key),
    change: () => { if (state.editor) updateEditor(); },  // e.g. a piece dragged off the board
  },
  drawable: {
    enabled: true,
    // a drawn arrow ends where you release it; snapping to the piece's legal squares made the end jump
    defaultSnapToValidMove: false,
    // .cg-shapes is opacity 1 in style.css (chessground's own CSS dims the whole layer to 0.6, which
    // washed out your drawings), so the other brushes carry that 0.6 in their own opacity instead
    brushes: {
      green:    { key: 'green',    color: '#15781B', opacity: 0.6,    lineWidth: 10 },
      red:      { key: 'red',      color: '#882020', opacity: 0.6,    lineWidth: 10 },
      blue:     { key: 'blue',     color: '#003088', opacity: 0.6,    lineWidth: 10 },
      yellow:   { key: 'yellow',   color: '#e68f00', opacity: 0.6,    lineWidth: 10 },
      paleBlue: { key: 'paleBlue', color: '#003088', opacity: 0.24,  lineWidth: 15 },
      paleGreen:{ key: 'paleGreen',color: '#15781B', opacity: 0.24,  lineWidth: 15 },
      paleRed:  { key: 'paleRed',  color: '#882020', opacity: 0.24,  lineWidth: 15 },
      paleGrey: { key: 'paleGrey', color: '#4a4a4a', opacity: 0.21, lineWidth: 15 },
      // arrows you draw with a right-drag, colour by modifier key (drawBrush): dark and opaque so they
      // stand out on the board; no green (it vanished on the dark squares). Filled squares use pastel
      // versions of the same colours (.sq-fill-* in style.css).
      drawNone: { key: 'drawNone', color: '#d35400', opacity: 1, lineWidth: 6 },
      drawCmd:  { key: 'drawCmd',  color: '#1f3f9e', opacity: 1, lineWidth: 6 },
      drawOpt:  { key: 'drawOpt',  color: '#0e7c7b', opacity: 1, lineWidth: 6 },
      drawCtrl: { key: 'drawCtrl', color: '#b01e1e', opacity: 1, lineWidth: 6 },
      drawFn:   { key: 'drawFn',   color: '#6b2fa0', opacity: 1, lineWidth: 6 },
      // scoreboard: a clicked move's arrow, red when it captures (with a ring on the captured piece)
      sbMove:    { key: 'sbMove',    color: '#2a6fdb', opacity: 0.85, lineWidth: 9 },
      sbCap:     { key: 'sbCap',     color: '#d32f2f', opacity: 0.85, lineWidth: 9 },
      sbMoveMid: { key: 'sbMoveMid', color: '#2a6fdb', opacity: 0.85, lineWidth: 9 },
      sbCapMid:  { key: 'sbCapMid',  color: '#d32f2f', opacity: 0.85, lineWidth: 9 },
      // first legs of L-shaped (knight) drawings: no arrowhead, see marker[id$="Mid"] in style.css
      greenMid:    { key: 'greenMid',    color: '#15781B', opacity: 0.6, lineWidth: 10 },
      drawNoneMid: { key: 'drawNoneMid', color: '#d35400', opacity: 1, lineWidth: 6 },
      drawCmdMid:  { key: 'drawCmdMid',  color: '#1f3f9e', opacity: 1, lineWidth: 6 },
      drawOptMid:  { key: 'drawOptMid',  color: '#0e7c7b', opacity: 1, lineWidth: 6 },
      drawCtrlMid: { key: 'drawCtrlMid', color: '#b01e1e', opacity: 1, lineWidth: 6 },
      drawFnMid:   { key: 'drawFnMid',   color: '#6b2fa0', opacity: 1, lineWidth: 6 },
      // piece-hover arrows: slim + opaque enough to read clearly
      hvMove:       { key: 'hvMove',      color: '#81b64c', opacity: 0.47, lineWidth: 7 },
      hvCapture:    { key: 'hvCapture',   color: '#e08030', opacity: 0.49, lineWidth: 7 },
      hvCheck:      { key: 'hvCheck',     color: '#f7c045', opacity: 0.53, lineWidth: 7 },
      // threat arrows (opponent's replies): darker, so they read as a warning, not a suggestion
      hvOpp:        { key: 'hvOpp',       color: '#2c5674', opacity: 0.43, lineWidth: 6 },
      hvOppCapture: { key: 'hvOppCapture',color: '#8f2422', opacity: 0.51, lineWidth: 6 },
      hvOppCheck:   { key: 'hvOppCheck',  color: '#b8262b', opacity: 0.55, lineWidth: 6 },
      // "Mid" variants: the first leg of a knight's L-shaped arrow, same color, no arrowhead
      // (the marker triangle is hidden in CSS — see marker[id$="Mid"] in style.css)
      hvMoveMid:       { key: 'hvMoveMid',       color: '#81b64c', opacity: 0.47, lineWidth: 7 },
      hvCaptureMid:    { key: 'hvCaptureMid',    color: '#e08030', opacity: 0.49, lineWidth: 7 },
      hvCheckMid:      { key: 'hvCheckMid',      color: '#f7c045', opacity: 0.53, lineWidth: 7 },
      hvOppMid:        { key: 'hvOppMid',        color: '#2c5674', opacity: 0.43, lineWidth: 6 },
      hvOppCaptureMid: { key: 'hvOppCaptureMid', color: '#8f2422', opacity: 0.51, lineWidth: 6 },
      hvOppCheckMid:   { key: 'hvOppCheckMid',   color: '#b8262b', opacity: 0.55, lineWidth: 6 },
    },
    // A right-click/drag ends up here as chessground's own shape. We empty its list after every change
    // (its native rendering can't do our colours or threat arrows), so each call carries only the new
    // shape: a drag is your arrow (userShape), a plain click on a piece holds its threat arrows.
    // Because the list is always empty, chessground's left-click erase never reports anything, so left
    // clicks are handled by the mousedown listener below instead.
    onChange: (shapes) => {
      if (!shapes.length) return;
      shapes.forEach(userShape);
      cg.setShapes([]);
    },
  },
});

// The modifier keys are read here, on the press, because chessground's own brush choice can't tell
// ⌘ from ⌥ (both map to its "blue") and ignores fn. Capture phase, so this runs before chessground's
// handler. A left click (no Shift: Shift+left-drag also draws in chessground) clears your drawings and
// held threat arrows, like chess.com.
let drawMods = null;
$('board').addEventListener('mousedown', (e) => {
  if (e.button === 2 || e.shiftKey) {
    drawMods = { fn: !!e.getModifierState?.('Fn'), shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey };
    // chessground previews the arrow being drawn in its own brush (it can't tell ⌘ from ⌥), which then
    // jumped to ours on release. Its handler stops propagation, so recolour on the next frame: by then
    // it has made the shape but not drawn it yet (its render is also queued on animation frames).
    requestAnimationFrame(() => {
      if (cg.state.drawable.current) cg.state.drawable.current.brush = drawBrush(drawMods) || 'drawNone';
    });
  } else if (e.button === 0) {
    clearUserShapes();
  }
}, true);


function baseFen() {
  const r = state.review;
  return state.ply === 0 ? r.start_fen : r.moves[state.ply - 1].fen_after;
}

function currentGame() {
  if (state.demo) {
    const d = state.demo;
    const c = new Chess(d.start_fen);
    for (const san of d.moves.slice(0, d.step)) c.move(san);
    return c;
  }
  const c = new Chess(baseFen());
  for (const san of state.extra) c.move(san);
  return c;
}

function dests(c) {
  const d = new Map();
  for (const m of c.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}

function lastMove(c) {
  const hist = c.history({ verbose: true });
  if (hist.length) return [hist.at(-1).from, hist.at(-1).to];
  if (state.demo) return undefined;
  if (state.ply > 0) {
    const u = state.review.moves[state.ply - 1].uci;
    return [u.slice(0, 2), u.slice(2, 4)];
  }
  return undefined;
}

function renderBoard() {
  if (state.editor) {
    cg.set({
      orientation: state.orientation, turnColor: state.editor.turn, lastMove: undefined, check: false,
      movable: { free: true, color: 'both', dests: undefined },
      draggable: { deleteOnDropOff: true },
    });
    cg.setAutoShapes([]);
    return null;
  }
  const c = currentGame();
  const turn = c.turn() === 'w' ? 'white' : 'black';
  cg.set({
    fen: c.fen(),
    orientation: state.orientation,
    turnColor: turn,
    lastMove: lastMove(c),
    check: c.inCheck() ? turn : false,
    movable: { free: false, color: canMove(c, turn) ? turn : undefined, dests: dests(c) },
    draggable: { deleteOnDropOff: false },
  });
  cg.setAutoShapes(baseShapes());
  return c;
}

function onBoardMove(orig, dest) {
  if (state.editor) return updateEditor();
  if (state.demo) return onDemoMove(orig, dest);
  if (state.play) return onPlayMove(orig, dest);
  if (state.study) return onStudyMove(orig, dest);
  if (state.replay) return onReplayMove(orig, dest);
  const c = currentGame();
  let mv;
  try {
    mv = c.move({ from: orig, to: dest, promotion: 'q' });
  } catch {
    update();
    return;
  }
  const next = state.review.moves[state.ply];
  if (!state.extra.length && next && next.uci.slice(0, 4) === orig + dest) state.ply++;
  else state.extra.push(mv.san);
  update();
}

function canMove(c, turn) {
  if (c.isGameOver()) return false;
  if (state.demo) return true;
  // a lesson: you play your side, the app plays theirs (Learn and Drill alike)
  if (state.study) {
    const cv = state.study.curve;
    return !state.study.waiting && turn === state.study.data.color && (cv ? !cv.solved : studyNodeHere() !== null);
  }
  if (state.replay) return turn === state.replay.color && state.ply < state.review.moves.length && !state.extra.length;
  const p = state.play;
  if (!p) return true;
  return !p.over && !p.thinking && p.view === p.moves.length && turn === p.color;
}

// the coach's "jump ahead" button. Coach ply = position *before* that move, so ply - 1 moves are played.
function jumpToPly(coachPly) {
  if (state.play || state.editor) return;  // a bot game / set-up board has no game timeline to jump in
  closeDemo(false);
  const target = Math.max(0, Math.min(coachPly - 1, state.review.moves.length));
  if (state.replay) {
    // goTo() ignores replays; move the replay itself, and swap the object so a pending
    // opponent-move timer from before the jump sees a different replay and stands down
    state.replay = { ...state.replay, hint: null, deviation: null, paused: false };
    state.ply = target;
    state.extra = [];
    update();
    replayStep();
    return;
  }
  goTo(target);
}

function goTo(ply) {
  if (state.editor) return;
  if (state.demo) return demoStep(ply);
  if (state.study) return studyGoTo(ply);
  if (state.replay) return replayView(ply);
  if (state.play) return playView(ply);
  state.ply = Math.max(0, Math.min(ply, state.review.moves.length));
  state.extra = [];
  update();
}

function back() {
  if (state.editor) return;
  if (state.demo) return demoStep(state.demo.step - 1);
  if (state.study) return studyGoTo(state.extra.length - 1);
  if (state.replay) return replayView(state.ply - 1);
  if (state.play) return playView(state.play.view - 1);
  if (state.extra.length) { state.extra.pop(); update(); }
  else goTo(state.ply - 1);
}

function forward() {
  if (state.editor) return;
  if (state.demo) return demoStep(state.demo.step + 1);
  if (state.study) return studyForward();
  if (state.replay) return replayView(state.ply + 1);
  if (state.play) return playView(state.play.view + 1);
  if (!state.extra.length) goTo(state.ply + 1);
}

// ---------------------------------------------------------------- panels

function clockText(seconds) {
  seconds = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// "Improving (~1200)" -> "(~1200)"; falls back to the whole name if it has no rating.
const botElo = (levelName) => levelName.match(/\(.*\)/)?.[0] ?? levelName;

function playerLine(color) {
  const p = state.play;
  if (p) {
    const label = color === p.color ? (state.me ? `${esc(state.me)} (you)` : 'You') : `Bot <span class="elo">${esc(botElo(p.levelName))}</span>`;
    if (!p.clock) return label;
    const running = !p.over && playChess(p).turn() === color[0];
    const low = p.clock[color] < 30 ? ' low' : '';
    return `${label}<span class="clock${running ? ' running' : ''}${low}">${clockText(p.clock[color])}</span>`;
  }
  const r = state.review;
  const bare = !r.moves.length;  // analysis board: no names, so label the rows by side
  const name = bare ? (color === 'white' ? 'White' : 'Black') : r[color], elo = bare ? null : r[`${color}_elo`];
  const isYou = r.player_color === color;
  const title = isYou ? 'This is you' : bare ? 'Click to tell the coach you are playing this side'
    : 'Click if this is you — the coach may have guessed wrong or not know at all';
  const nameHtml = `<span class="you-pick${isYou ? ' on' : ''}" data-color="${color}" title="${title}">`
    + `${esc(name)}${isYou ? ' (you)' : ''}</span>`;
  return `${nameHtml} <span class="elo">${elo ? `(${esc(elo)})` : ''}</span>`;
}

async function setYou(color) {
  if (state.play || state.demo || state.editor || state.review.player_color === color) return;
  const review = await api('/api/me-color', { color });
  state.review.player_color = review.player_color;
  state.orientation = review.player_color;
  update();
}

// ---- captured pieces + material balance (chess.com style)
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const ROLE = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };
let pieceImg = null;  // piece artwork borrowed from the board's own theme

function pieceImages() {
  if (pieceImg) return pieceImg;
  pieceImg = {};
  const probe = document.createElement('piece');
  probe.style.display = 'none';
  $('board').appendChild(probe);
  for (const color of ['white', 'black']) {
    for (const role of [...Object.values(ROLE), 'king']) {
      probe.className = `${role} ${color}`;
      pieceImg[`${color}-${role}`] = getComputedStyle(probe).backgroundImage;
    }
  }
  probe.remove();
  return pieceImg;
}

function material(c) {
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of c.board()) for (const sq of row) if (sq && sq.type !== 'k') count[sq.color][sq.type]++;
  const score = (side) => Object.entries(count[side]).reduce((t, [k, n]) => t + VALUE[k] * n, 0);
  return { count, diff: score('w') - score('b') };  // diff > 0: White is ahead
}

function capturedHtml(color, mat) {
  // pieces this side has taken = opponent's missing pieces (promotions can push a count below zero)
  const opp = color === 'white' ? 'b' : 'w';
  const oppColor = color === 'white' ? 'black' : 'white';
  const img = pieceImages();
  // missing relative to the game's own start: a set-up position or an endgame drill has fewer pieces
  const base = state.review?.start_fen ? material(new Chess(state.review.start_fen)).count[opp] : START;
  let html = '';
  for (const k of ['p', 'n', 'b', 'r', 'q']) {
    const n = Math.max(0, base[k] - mat.count[opp][k]);
    if (!n) continue;
    html += '<span class="capgroup">' +
      `<i style="background-image:${esc(img[`${oppColor}-${ROLE[k]}`])}"></i>`.repeat(n) + '</span>';
  }
  const lead = color === 'white' ? mat.diff : -mat.diff;
  if (lead > 0) html += `<span class="lead">+${lead}</span>`;
  return html ? `<span class="captured">${html}</span>` : '';
}

// ---- clock: update the two .clock spans in place every tick, without a full re-render
function renderClocks() {
  const p = state.play;
  if (!p?.clock) return;
  const turn = playChess(p).turn() === 'w' ? 'white' : 'black';
  const top = state.orientation === 'white' ? 'black' : 'white';
  for (const [color, el] of [[top, $('player-top')], [state.orientation, $('player-bottom')]]) {
    const span = el.querySelector('.clock');
    if (!span) continue;
    span.textContent = clockText(p.clock[color]);
    span.classList.toggle('running', !p.over && color === turn);
    span.classList.toggle('low', p.clock[color] < 30);
  }
}

setInterval(() => {
  const p = state.play;
  if (!p?.clock || p.over) return;
  const c = playChess(p);
  if (c.isGameOver()) return;
  const turn = c.turn() === 'w' ? 'white' : 'black';
  const now = Date.now();
  p.clock[turn] = Math.max(0, p.clock[turn] - (now - p.clock.lastTick) / 1000);
  p.clock.lastTick = now;
  renderClocks();
  if (p.clock[turn] <= 0) {
    const winner = turn === 'white' ? 'black' : 'white';
    endGame(winner === p.color ? 'win' : 'loss', `${turn === p.color ? 'You' : 'The bot'} ran out of time.`);
  }
}, 250);

function dockGamePanel() {
  // it lives above the board now (.board-head-right) in every mode; kept as a hook for the callers, and
  // to put it back if anything moved it
  const gp = document.querySelector('.game-panel');
  const home = document.querySelector('.board-head-right');
  if (gp.parentElement !== home) home.appendChild(gp);
}

// ---- favourite games + their titles (core/favorites.py). Only a loaded game has a game_id to key
// them on; a title can be typed by double-clicking the header gap, the line above the board or the
// game line in the chat header (the three spots the user picked), and giving one favourites the game.
function canTitle() {
  const r = state.review;
  return !!(r?.game_id && r.moves.length && !state.demo && !state.play && !state.study && !state.editor);
}

function syncGameTitle() {
  const on = canTitle();
  $('game-title').textContent = on ? (state.review.title || '') : '';
  for (const id of ['game-title', 'board-sub', 'game-info']) {
    if (on) $(id).title = 'Double-click to give this game a title';
    else $(id).removeAttribute('title');
  }
}

async function saveFavorite(body) {
  const r = state.review;
  try {
    Object.assign(r, await api(`/api/favorites/${encodeURIComponent(r.game_id)}`, body));
  } catch (e) {
    addMsg('error', `Couldn't update favourites: ${esc(e.message)}`);
  }
  if (state.review === r) renderInfo();
}

function toggleFavorite() {
  const r = state.review;
  if (r.favorite && r.title && !confirm(`Remove “${r.title}” from favourites? Its title is removed too.`)) return;
  saveFavorite({ favorite: !r.favorite });
}

function editTitle(el) {
  const input = document.createElement('input');
  input.className = 'title-input';
  input.value = state.review.title || '';
  input.placeholder = 'Name this game…';
  input.maxLength = 200;
  el.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  // chessground cancels mousedown, so a click on the board never blurs the input: watch clicks instead
  const outside = (e) => { if (e.target !== input) finish(true); };
  const finish = (save) => {
    if (done) return;
    done = true;
    document.removeEventListener('pointerdown', outside, true);
    if (save && input.value.trim() !== (state.review.title || '')) saveFavorite({ title: input.value });
    else renderInfo();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
  document.addEventListener('pointerdown', outside, true);
}

for (const id of ['game-title', 'board-sub', 'game-info']) {
  $(id).addEventListener('dblclick', (e) => {
    if (canTitle() && !e.target.closest('.game-panel, .fav-btn, input')) editTitle($(id));
  });
}

// "Takeback" sits beside the top name row (a static button in index.html), shown only in a bot game
function syncTakeback() {
  const p = state.play;
  $('pb-takeback').classList.toggle('hidden', !p || !!state.demo);
  $('pb-takeback').disabled = !p || p.moves.length <= (p.prefix || 0);
}

function renderInfo() {
  const r = state.review;
  dockGamePanel(!state.demo && !state.play && !state.study && !r.moves.length);
  syncGameTitle();
  const top = state.orientation === 'white' ? 'black' : 'white';
  const mat = material(currentGame());
  $('player-top').innerHTML = playerLine(top) + capturedHtml(top, mat);
  $('player-bottom').innerHTML = playerLine(state.orientation) + capturedHtml(state.orientation, mat);
  syncTakeback();
  document.querySelectorAll('.you-pick').forEach((el) => { el.onclick = () => setYou(el.dataset.color); });
  document.body.classList.toggle('demo-mode', !!state.demo);
  if (state.demo) return renderDemoInfo();

  if (state.play) return renderPlayInfo();
  if (state.study) return renderStudyInfo();
  if (!r.moves.length) {
    $('board-sub').textContent = '';
    // visible toggle: the dashed-underline name labels alone don't read as clickable
    $('summary').innerHTML = `<div class="me-pick"><span class="label">I'm playing</span><div class="seg">`
      + ['white', 'black'].map((c) => `<button data-me="${c}" class="${r.player_color === c ? 'on' : ''}">${c === 'white' ? 'White' : 'Black'}</button>`).join('')
      + '</div></div>';
    $('summary').querySelectorAll('[data-me]').forEach((b) => { b.onclick = () => setYou(b.dataset.me); });
    return;
  }
  $('game-info').innerHTML = `<button class="fav-btn${r.favorite ? ' on' : ''}" id="fav-btn"
    title="${r.favorite ? 'Remove from favourites' : 'Add to favourites'}">${r.favorite ? '★' : '☆'}</button>`
    + `${esc(r.white)} vs ${esc(r.black)} · ${esc(r.result)}`;
  $('fav-btn').onclick = toggleFavorite;
  $('board-sub').textContent = '';  // the opening title above (#opening-tag) names the opening now

  if (state.replay) return renderReplayInfo();
  // a loaded game is replayed: pick a side first, like "Play a game" (your side of the game is marked)
  const mine = r.player_color;
  $('summary').innerHTML = `<div class="me-pick"><span class="label">Replay as</span><div class="seg">`
    + ['white', 'black'].map((c) => `<button data-replay="${c}">${c === 'white' ? 'White' : 'Black'}</button>`).join('')
    + `</div>${mine ? `<span class="label">you were ${mine === 'white' ? 'White' : 'Black'}</span>` : ''}</div>`;
  $('summary').querySelectorAll('[data-replay]').forEach((b) => { b.onclick = () => startReplay(b.dataset.replay); });
}

function movesRows(moves, cellFn) {
  let html = '';
  for (let i = 0; i < moves.length;) {
    const w = moves[i].color === 'white' ? moves[i++] : null;  // a set-up game may start with Black
    const b = moves[i]?.color === 'black' ? moves[i++] : null;
    const num = parseInt((w || b).label, 10);
    html += `<div class="row"><span class="num">${num}.</span>${w ? cellFn(w) : '<span>…</span>'}${b ? cellFn(b) : '<span></span>'}</div>`;
  }
  return html;
}

// The list shows FOLD_ROWS rows (scrolled to the current move) until "Show all" is clicked; a whole
// game was too tall for the panel. Expanded stays expanded until "Show fewer".
const FOLD_ROWS = 5;
let movesExpanded = false;

function renderMoves() {
  const box = $('moves');
  renderMoveList(box);
  const rows = box.querySelectorAll('.row').length;
  const foldable = rows > FOLD_ROWS;
  box.classList.toggle('folded', foldable && !movesExpanded);
  box.style.setProperty('--fold-rows', FOLD_ROWS);
  const btn = $('moves-more');
  btn.classList.toggle('hidden', !foldable);
  btn.textContent = movesExpanded ? 'Show fewer ▴' : `Show all ${rows} moves ▾`;
  box.querySelector('.mv.active')?.scrollIntoView({ block: 'nearest' });
}

function renderMoveList(box) {
  const r = state.review;
  if (state.demo) return renderDemoMoves(box);
  if (state.play) return renderPlayMoves(box);
  if (!r.moves.length) {
    box.innerHTML = '<div class="empty">No game loaded. Use “Find game by username” or “Load game”, or just play moves on the board.</div>';
    return;
  }
  box.innerHTML = movesRows(r.moves, cell);
  box.querySelectorAll('.mv').forEach((el) => { el.onclick = () => goTo(+el.dataset.ply); });
  const active = box.querySelector('.mv.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function cell(m) {
  const active = m.ply === state.ply && !state.extra.length ? ' active' : '';
  const flag = m.class ? `<span class="flag ${m.class}" title="${m.class}">${FLAG[m.class]}</span>` : '';
  return `<span class="mv${active}" data-ply="${m.ply}">${esc(m.san)}${flag}</span>`;
}

function positionLabel() {
  if (state.demo) {
    const d = state.demo;
    if (!d.step) return `Demo “${d.title}”, start`;
    const labels = demoLabels(d);
    return `Demo “${d.title}”, after ${labels[d.step - 1]} ${d.moves[d.step - 1]}`;
  }
  const p = state.play;
  if (p) {
    if (!p.view) return 'Starting position';
    const labels = demoLabels({ start_fen: p.startFen, moves: p.moves.slice(0, p.view) });
    return `After ${labels.at(-1)} ${p.moves[p.view - 1]}` + (p.view < p.moves.length ? ' (earlier position)' : '');
  }
  const r = state.review;
  let label = state.ply === 0 ? 'Starting position' : `After ${r.moves[state.ply - 1].label} ${r.moves[state.ply - 1].san}`;
  if (!r.moves.length) {
    const fresh = r.start_fen === START_FEN;
    label = state.extra.length ? (fresh ? 'Analysis board' : 'Set-up position') : (fresh ? 'Starting position' : 'Set-up position');
  }
  if (state.extra.length) {
    const labels = demoLabels({ start_fen: state.ply ? r.moves[state.ply - 1].fen_after : r.start_fen, moves: state.extra });
    const last = `${labels.at(-1)} ${state.extra.at(-1)}`;
    if (!r.moves.length) return `${label} · after ${last}`;
    label += state.extra.length <= 2 ? ` + ${state.extra.join(' ')}` : ` + your line (${state.extra.length} moves, last ${last})`;
  }
  return label;
}

function renderVariation() {
  const show = state.extra.length && state.review.moves.length && !state.play && !state.demo;
  $('variation').classList.toggle('hidden', !show);
  if (show) $('variation-text').textContent = `Exploring: ${state.extra.join(' ')}`;
  $('chat-context').textContent = `Asking about: ${positionLabel()}`;
}

// ---------------------------------------------------------------- engine

let evalToken = 0;
let evalTimer = null;

function winPct(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

function requestEval(c) {
  clearTimeout(evalTimer);
  const token = ++evalToken;
  if (!state.engineOn) return;
  $('engine-lines').innerHTML = '<div class="eline" style="color:var(--muted)">Thinking…</div>';
  evalTimer = setTimeout(async () => {
    try {
      // with the moves that led here, like the scoreboard: otherwise a repetition draw is invisible to it
      // and the bar and the win strip disagree (the server ignores a line that doesn't reach this FEN)
      const line = currentLine();
      const data = await api('/api/eval', { fen: c.fen(), lines: 3, start_fen: line.startFen, moves: line.sans.slice(0, line.at) });
      if (token !== evalToken) return;
      lastEval = { fen: c.fen(), lines: data.lines };
      showEval(data);
      renderMaia();
      renderKeyCard();
    } catch (e) {
      if (token === evalToken) $('engine-lines').textContent = e.message;
    }
  }, 200);
}

function showEval(data) {
  const bar = $('evalbar');
  const pct = winPct(Math.max(-1500, Math.min(1500, data.cp)));
  $('evalfill').style.height = `${pct}%`;
  bar.classList.toggle('flipped', state.orientation === 'black');
  bar.classList.toggle('black-better', data.cp < 0);
  $('evaltext').textContent = data.eval.replace('+', '');
  if (!data.lines.length) {
    $('engine-lines').innerHTML = `<div class="eline">Game over</div>`;
    return;
  }
  // the next move and its eval up front; the full lines one click away (open state remembered)
  const ev = (l) => `<span class="ev ${l.cp_white >= 0 ? 'w' : 'b'}">${esc(l.eval_white)}</span>`;
  const full = recall('engineFull') === '1';
  $('engine-lines').innerHTML = data.lines.map((l) =>
    `<div class="eline"><span class="emove">${esc(l.move)}</span>${ev(l)}</div>`).join('')
    + `<button class="link elines-more">${full ? '▾' : '▸'} Full lines</button>`
    + (full ? data.lines.map((l) => `<div class="eline full">${ev(l)}<span class="pv">${esc(l.line)}</span></div>`).join('') : '');
  $('engine-lines').querySelector('.elines-more').onclick = () => {
    store('engineFull', full ? '0' : '1');
    showEval(data);
  };
}

// ---- Maia: what a human of the chosen rating plays here (its own lc0 process, runs alongside Stockfish)

let maiaToken = 0;
let maiaTimer = null;
let lastEval = null;  // Stockfish's lines for the shown position, to mark which human move is also best
let lastMaia = null;

function maiaOn() {
  return state.maiaReady && $('maia-toggle').checked;
}

function requestMaia(c) {
  clearTimeout(maiaTimer);
  const token = ++maiaToken;
  lastMaia = null;
  if (!maiaOn() || !c) return void ($('maia-lines').innerHTML = '');
  $('maia-lines').innerHTML = '<div class="eline" style="color:var(--muted)">Thinking…</div>';
  const fen = c.fen();
  const line = currentLine();
  // the side to move plays at its own rating, facing the other side's
  const [mover, opp] = c.turn() === 'w' ? ['maia-white', 'maia-black'] : ['maia-black', 'maia-white'];
  maiaTimer = setTimeout(async () => {
    try {
      // the moves that led here matter: Maia reads the last few positions, not just this one
      const data = await api('/api/maia', {
        fen, rating: +$(mover).value, opp_rating: +$(opp).value, start_fen: line.startFen, moves: line.sans.slice(0, line.at),
      });
      if (token !== maiaToken) return;
      lastMaia = { fen, ...data };
      renderMaia();
      renderKeyCard();
    } catch (e) {
      if (token === maiaToken) $('maia-lines').textContent = e.message;
    }
  }, 200);
}

// a click plays the move where you could have played it yourself; otherwise (the bot's turn, a lesson's
// opponent, a replay's other side) it only shows the arrow
function playMaiaMove(uci) {
  const c = currentGame();
  const turn = c.turn() === 'w' ? 'white' : 'black';
  if (!canMove(c, turn)) {
    cg.setAutoShapes([...baseShapes(), { orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'green' }]);
    return;
  }
  onBoardMove(uci.slice(0, 2), uci.slice(2, 4));  // promotions go to a queen, as on the board
}

function renderMaia() {
  if (!lastMaia) return;
  if (!lastMaia.moves.length) return void ($('maia-lines').innerHTML = '<div class="eline">Game over</div>');
  const sf = lastEval?.fen === lastMaia.fen ? lastEval.lines : [];
  $('maia-lines').innerHTML = lastMaia.moves.map((m) => {
    const hit = sf.find((l) => l.uci === m.uci);
    const best = sf[0]?.uci === m.uci;
    const [w, d, l] = m.wdl;
    const tip = `${Math.round(w)}% win / ${Math.round(d)}% draw / ${Math.round(l)}% loss for the mover after this, `
      + `in games between players of these ratings (Maia's guess, not an engine eval)`
      + (best ? ". Also Stockfish's top move." : '');
    // the Stockfish section's number when it has this move, so one move never shows two evals
    const ev = hit?.eval_white ?? m.eval_white;
    return `<div class="mline${best ? ' best' : ''}" title="${tip}" data-uci="${esc(m.uci)}">
      <span class="mmove">${esc(m.move)}</span>
      <span class="mbar"><span style="width:${Math.max(2, m.pct)}%"></span></span>
      <span class="mpct">${m.pct < 1 ? '<1' : Math.round(m.pct)}%</span>
      <span class="ev ${/^#?-/.test(ev ?? '') ? 'b' : 'w'}">${esc(ev ?? '')}</span></div>`;
  }).join('');
  $('maia-lines').querySelectorAll('.mline').forEach((el) => { el.onclick = () => playMaiaMove(el.dataset.uci); });
}

// ---- scoreboard: Stockfish's top 5 next to Maia's top 5 at the chosen rating, the odds the next move is
// good or a disaster, alerts for the moments worth flagging, and the last/big plays. Sits above the chat;
// not a .msg, so the code that folds every chat card leaves it alone. The quick numbers (lastEval/lastMaia)
// show at once; the deeper /api/scoreboard search (depth 18, a few seconds) replaces them and adds the rest.

const SB_BIG = 15;    // win % lost: a "big play" (core/scoreboard.py BIG)
const SB_GOOD = 5;    // within this of best: a good move
const sbCache = new Map();  // fen|ratings → scoreboard, so stepping back is instant and last play can read its parent
let sbToken = 0;
let sbTimer = null;
let sbError = null;
const sbShown = new Set();  // banners already drawn (per position), so a new one animates and a re-render doesn't

// The scoreboard's evals are from the side to move's point of view (the card says whose move it is):
// positive is good for them, negative means the move hurts them, whichever colour they play.
function moverEval(e, turn) {
  if (e == null) return e;
  const m = /^(#?)([+-]?)(.*)$/.exec(e);
  const neg = (m[2] === '-') !== (turn === 'b');
  return `${m[1]}${neg && !/^0(\.0+)?$/.test(m[3]) ? '-' : ''}${m[3]}`;
}

function evPill(e, t) {
  return `<span class="ev ${/^#?-/.test(e ?? '') ? 'b' : 'w'}${t ? ` t${t}` : ''}">${esc(e ?? '')}</span>`;
}

function sbRatings(fen) {
  // the side to move plays at its own rating, facing the other side's (as in requestMaia)
  const white = fen.split(' ')[1] === 'w';
  const r = (id) => +$(id).value || 1500;
  return white ? [r('maia-white'), r('maia-black')] : [r('maia-black'), r('maia-white')];
}

function sbGet(fen) {
  return sbCache.get(`${fen}|${sbRatings(fen).join('|')}`);
}

// Whose moves the scoreboard is about: yours in a bot game or a replay, the player's in a loaded game; null
// on the analysis board, where every move is yours.
function sbUser() {
  if (state.play) return state.play.color[0];
  if (state.replay) return state.replay.color[0];
  return state.review?.player_color?.[0] || null;
}

// The two positions on the card: `now` = the board (Best move), `k` = your last move (Previous move, 1-based;
// its position is fens[k-1]). In a bot game or a replay the opponent answers within a second, so its turn
// isn't searched (`now` null: the section waits, same size); in a loaded game or on the analysis board the
// opponent's options show too (user's call: the top section shouldn't vanish every other move).
function sbTargets(L) {
  const u = sbUser();
  const n = L.plays.length;
  const turnAt = (i) => L.fens[i].split(' ')[1];
  let k = n;
  while (u && k >= 1 && turnAt(k - 1) !== u) k--;
  const auto = (state.play || state.replay) && u && turnAt(n) !== u;
  return { now: auto ? null : n, k: k >= 1 ? k : null };
}

// The row for `uci` in a scoreboard, from either list or the extra moves scored on request.
function sbRow(sb, uci) {
  return sb && !sb.over ? [...sb.sf, ...(sb.humans || []), ...(sb.extra || [])].find((r) => r.uci === uci) : null;
}

function requestScoreboard(c) {
  clearTimeout(sbTimer);
  const token = ++sbToken;
  sbError = null;
  if (!c || !state.engineOn || state.editor) return;
  const line = currentLine();
  const L = sbLine();
  const { now, k } = sbTargets(L);
  const jobs = [];
  if (k) {
    // your move's position, with your move scored even if neither list has it (asked once per entry)
    const uci = L.plays[k - 1].uci;
    const old = sbGet(L.fens[k - 1]);
    if (!old || !(old.over || sbRow(old, uci) || old.included?.includes(uci))) jobs.push({ at: k - 1, include: [uci] });
  }
  if (now != null && !sbGet(L.fens[now])) jobs.push({ at: now, include: [] });
  if (!jobs.length) return;
  sbTimer = setTimeout(async () => {
    // one after the other: the server drops a search that a newer request overtakes
    for (const j of jobs) {
      if (token !== sbToken) return;
      const fen = L.fens[j.at];
      const [rating, opp] = sbRatings(fen);
      try {
        const data = await api('/api/scoreboard', {
          fen, rating, opp_rating: opp, start_fen: line.startFen, moves: line.sans.slice(0, j.at), include: j.include,
        });
        if (data.stale) return;  // a newer position's request superseded this one on the server
        data.included = j.include;
        sbCache.set(`${fen}|${rating}|${opp}`, data);
        if (sbCache.size > 500) sbCache.delete(sbCache.keys().next().value);
      } catch (e) {
        if (token === sbToken) sbError = e.message;
      }
      if (token === sbToken) renderKeyCard();
    }
  }, 250);
}

// The current line as positions: fens[k] is after k moves, plays[k-1] the move that led there.
function sbLine() {
  const line = currentLine();
  const c = new Chess(line.startFen);
  const fens = [c.fen()], plays = [];
  for (const san of line.sans.slice(0, line.at)) {
    const m = c.move(san);
    if (!m) break;
    plays.push({ uci: m.from + m.to + (m.promotion || ''), san: m.san, label: `${c.moveNumber() - (m.color === 'b' ? 1 : 0)}${m.color === 'w' ? '.' : '...'}${m.san}` });
    fens.push(c.fen());
  }
  return { fens, plays, kind: line.kind };
}

// Win % the k-th move (1-based) cost its player: the saved review for a loaded game's own moves, else the
// scoreboards of the positions before and after it (only those already visited); null when unknown.
function sbDrop(L, k) {
  if (L.kind === 'review' && k <= state.ply) {
    const v = state.review.moves[k - 1]?.win_pct_lost;
    if (typeof v === 'number') return v;
  }
  const before = sbGet(L.fens[k - 1]);
  const after = sbGet(L.fens[k]);
  if (!before || before.over) {
    // an opponent's move (their positions aren't searched): your move before it, and your position after
    const mine = k >= 2 ? sbRow(sbGet(L.fens[k - 2]), L.plays[k - 2].uci) : null;
    return mine && after && !after.over ? Math.max(0, after.sf[0].win - mine.win) : null;
  }
  const row = sbRow(before, L.plays[k - 1].uci);
  if (row) return row.drop;
  if (!after) return null;
  if (after.over) return 0;  // mate or a draw on the board: nothing left to lose
  return Math.max(0, before.sf[0].win - (100 - after.sf[0].win));
}

// Hovering a scoreboard row shows its move: an arrow, red for a capture (plus a ring on the piece it takes,
// which for en passant isn't on the arrow's square). A Next-play alert's click draws it the same way.
function sbShowMove(uci) {
  const c = currentGame();
  const mv = c.moves({ verbose: true }).find((m) => m.from + m.to + (m.promotion || '') === uci || m.from + m.to === uci);
  if (!mv) return;
  const cap = !!mv.captured;
  const brush = cap ? 'sbCap' : 'sbMove';
  const taken = mv.flags.includes('e') ? mv.to[0] + mv.from[1] : mv.to;
  cg.setAutoShapes([...baseShapes(), ...(mv.piece === 'n' ? knightShapes(mv.from, mv.to, brush) : [{ orig: mv.from, dest: mv.to, brush }]),
    ...(cap ? [{ orig: taken, brush: 'sbCap' }] : [])]);
}

let sbHovering = false;  // the arrow on the board came from hovering a row (not an alert's click)
let sbClicked = false;  // a row was clicked and the pointer hasn't moved since

function sbHideMove() {
  sbHovering = false;
  cg.setAutoShapes(baseShapes());
}

function sbVerdict(d) {
  return d >= 30 ? 'blunder' : d >= 20 ? 'mistake' : d >= 10 ? 'inaccuracy' : d >= SB_GOOD ? 'slip' : d < 2 ? 'best or close' : 'good';
}

const sbTier = (d) => (d >= 30 ? 3 : d >= SB_BIG ? 2 : d >= SB_GOOD ? 1 : 0);
const SB_ONLY = 20;  // #2 at least this far behind: #1 is the only move (core/scoreboard.py)
const sbMark = (drop, only) => (drop >= 30 ? 'bad' : only ? 'great' : '');

// Who's winning, once at the top of the chat so it stays in view when the scoreboard is folded: the
// quick eval at once, the scoreboard's deeper number when it lands.
function renderWinStrip(fen, sb) {
  const box = $('win-strip');
  const quick = lastEval?.fen === fen && lastEval.lines.length ? lastEval.lines[0].cp_white : null;
  const w = sb && !sb.over ? sb.white_win : quick != null ? winPct(Math.max(-1500, Math.min(1500, quick))) : null;
  if (w == null) return;  // keep the last position's bar until this one's number lands, so the chat doesn't jump
  box.classList.remove('hidden');
  box.innerHTML = `<div class="sb-win" title="Stockfish's win chance (Lichess' curve), the same measure as the eval bar; not a prediction for players of these ratings">
    <span class="sb-w">White ${Math.round(w)}%</span><span class="sb-bar"><span style="width:${w}%"></span></span>
    <span class="sb-b">${Math.round(100 - w)}% Black</span></div>`;
}

// Alerts and big plays go into the chat as their own cards, so the scoreboard above keeps the same shape on
// every move. Each alert is posted once per position (revisiting doesn't repeat it).
// Where `fen` sits in the current line (all of it, not just up to the shown move): -1 once the line no longer
// passes through it (a takeback, a new game).
function sbFenIndex(fen) {
  const line = currentLine();
  const c = new Chess(line.startFen);
  if (c.fen() === fen) return 0;
  for (let i = 0; i < line.sans.length; i++) {
    if (!c.move(line.sans[i])) break;
    if (c.fen() === fen) return i + 1;
  }
  return -1;
}

// `num` (e.g. "12..." ) sits in the card's corner; a click takes the board to that moment (user's call), and
// a Next-play alert also draws its move there. Each alert is posted once per position.
function sbPostAlert(fen, b, label, pre, num) {
  const key = `${fen}|${label}|${b.kind}`;
  if (sbShown.has(key)) return;
  if (sbShown.size > 2000) sbShown.clear();
  sbShown.add(key);
  const msg = addMsg('coach sb-msg', `<div class="sb-alert ${b.tier ? `t${b.tier}` : 'good'} fresh clickable" title="Go to this moment">`
    + `<span class="sb-num">${esc(num)}</span><span class="sb-al">${label}</span> ${pre}${esc(b.text)}</div>`);
  const al = msg.querySelector('.sb-alert');
  al.onclick = () => {
    const at = sbFenIndex(fen);
    if (at < 0) {
      al.classList.add('stale');
      al.title = 'This position is no longer in the game';
      return;
    }
    goToLine(at);
    if (b.uci && label === 'Next play') sbShowMove(b.uci);  // show, don't play: the flagged move may be the blunder
  };
}

let sbBigKey = '';  // the big plays last posted, so the card is re-posted only when the list changes

function sbPostBigPlays(big) {
  const key = big.map((b) => b.label).join(' ');
  if (!big.length || key === sbBigKey) return;
  sbBigKey = key;
  // one running card: the previous one goes, the updated list lands at the bottom
  document.querySelectorAll('#chat-log .sb-big').forEach((el) => el.remove());
  const msg = addMsg('coach sb-msg sb-big', `<div class="sb-bigcard"><span class="sb-al" title="Moves that cost 15% win chance or more (💥), and the replies that took advantage (⚡)">Big plays</span>`
    + `${big.slice(-6).map((b) => `<button class="link sb-jump" data-k="${b.k}">${b.html}</button>`).join('')}</div>`);
  msg.querySelectorAll('.sb-jump').forEach((el) => { el.onclick = () => goToLine(+el.dataset.k); });
}

// Two ranked lists side by side for one position, one move per row, so the gap between the top and the
// bottom shows as bar length. Stockfish's bar is the mover's win chance; Maia's is how often players pick
// it. `live`: the board is on this position (quick numbers until the deep search lands, hover/click rows,
// the rating picker); `played`: the move made here, marked, and added under Stockfish's list if it isn't in it.
function sbLists(fen, { live, played }) {
  const sfOn = state.engineOn;
  const humansOn = maiaOn();
  const turn = fen.split(' ')[1];
  const side = turn === 'w' ? 'White' : 'Black';
  const sb = sfOn ? sbGet(fen) : null;
  const deep = sb && !sb.over;
  // placeholder rows while the numbers load, so the section keeps its height
  const wait = '<div class="sb-row ghost"><b class="sb-mv">·</b><span class="sb-rbar"></span><span></span></div>'.repeat(5);
  const over = '<span class="card-sub">Game over</span>';
  const fmt = (p) => (p < 1 ? '<1' : Math.round(p));
  const quickSf = live && lastEval?.fen === fen ? lastEval.lines : null;
  const quickMaia = live && lastMaia?.fen === fen ? lastMaia.moves : null;
  // Plain white rows; colour only for the extremes: red for a move that throws the game (≥ 30% win chance),
  // green for the only move that holds (everything else ≥ 20% worse). User's call: no tier colours.
  const row = (uci, move, width, mark, tip, ev) =>
    `<button class="sb-row${mark ? ` ${mark}` : ''}${uci === played ? ' played' : ''}" data-uci="${esc(uci)}" title="${esc(tip)}"><b class="sb-mv">${esc(move)}</b>`
    + `<span class="sb-rbar"><span style="width:${Math.max(2, Math.min(100, width))}%"></span></span>${ev}</button>`;
  const moverWin = (cp) => { const w = winPct(Math.max(-1500, Math.min(1500, cp))); return turn === 'w' ? w : 100 - w; };
  const lists = [];

  if (sfOn) {
    const sf = deep ? sb.sf : quickSf;
    let html = !sf ? (sb?.over ? over : wait) : !sf.length ? over : sf.map((l, i) => {
      const w = deep ? l.win : moverWin(l.cp_white);
      const drop = deep ? l.drop : moverWin(sf[0].cp_white) - w;
      const second = sf[1] ? (deep ? sf[1].drop : moverWin(sf[0].cp_white) - moverWin(sf[1].cp_white)) : 0;
      const tip = `${Math.round(w)}% win chance for ${side}` + (i ? `; ${Math.round(drop)}% behind the best` : '')
        + (deep && l.human_pct != null ? `; ${fmt(l.human_pct)}% of players at this rating play it` : '') + (deep ? '' : ' (quick search; the deeper one is coming)');
      return row(l.uci, l.move, w, sbMark(drop, i === 0 && second >= SB_ONLY), tip, evPill(moverEval(l.eval_white, turn)));
    }).join('');
    const mine = played && deep && !sb.sf.some((l) => l.uci === played) ? sbRow(sb, played) : null;
    if (mine) {
      html += `<div class="sb-sep"></div>` + row(mine.uci, mine.move, mine.win, sbMark(mine.drop, false),
        `Played: ${Math.round(mine.win)}% win chance for ${side}; ${Math.round(mine.drop)}% behind the best`, evPill(moverEval(mine.eval_white, turn)));
    }
    lists.push(`<div class="sb-list sf"><div class="sb-lh" title="Stockfish: the best moves, best first. Bar: ${side}'s win chance after the move (exact % on hover)"><span class="sb-who">Stockfish</span></div>${html}</div>`);
  }

  if (humansOn) {
    const mm = deep ? sb.humans : quickMaia;
    // bars scale to the most popular move, so a 25% favourite fills the row and the rest compare to it
    const top = Math.max(1, ...(mm || []).map((m) => m.pct));
    const pick = `<span class="sb-rt">~${sbRatings(fen)[0]}</span>`;  // set in the header row (#sb-rating)
    lists.push(`<div class="sb-list maia"><div class="sb-lh" title="Maia: what players of this rating actually play here, most popular first. Bar: share of players who'd pick the move (exact % on hover); red: throws the game, green: the only good move"><span class="sb-who">Maia ${pick}</span></div>${
      !mm ? (sb?.over ? over : wait) : !mm.length ? over : mm.map((m) => {
        if (!deep) {
          const ev = (quickSf || []).find((l) => l.uci === m.uci)?.eval_white ?? m.eval_white;
          return row(m.uci, m.move, 100 * m.pct / top, '', `${fmt(m.pct)}% of players at this rating play it`, evPill(moverEval(ev, turn)));
        }
        const tip = `${fmt(m.pct)}% of players at this rating play it; `
          + (m.drop < SB_GOOD ? 'about as good as the best move' : `costs ${Math.round(m.drop)}% win chance (${sbVerdict(m.drop)})`)
          + (m.sf_rank ? `; Stockfish's #${m.sf_rank}` : '');
        const only = m.sf_rank === 1 && sb.sf[1] && sb.sf[1].drop >= SB_ONLY;
        return row(m.uci, m.move, 100 * m.pct / top, sbMark(m.drop, only), tip, evPill(moverEval(m.eval_white, turn)));
      }).join('')}</div>`);
  }
  // two competing lists, so they get separate panels
  return lists.length ? `<div class="sb-lists${lists.length > 1 ? ' two' : ''}">${lists.join('')}</div>` : '';
}

// The lists' evals are the side to move's view, and the two sections can have different sides to move, so
// each says whose view it is (otherwise 7.18 above and -7.32 below reads as a swing)
function sbPov(turn) {
  return state.engineOn ? `<span class="sb-pov" title="Evals are from this side's point of view: positive is good for them">${turn === 'w' ? 'White' : 'Black'}'s view</span>` : '';
}

function sbStatus(fen) {
  if (!state.engineOn) return '';
  const sb = sbGet(fen);
  if (sb?.over) return '';
  if (sb) return `<span class="sb-depth" title="Stockfish search depth">d${sb.depth}</span>`;
  return sbError ? `<span class="sb-depth" title="${esc(sbError)}">search failed</span>` : '<span class="sb-depth">analysing…</span>';
}

// A banner for the k-th move (1-based) when the moment calls for one: a big loss, Stockfish's top move that
// wasn't the popular one, punishing a blunder, or a lead change. Needs the position before it searched.
function sbPlayAlert(L, k) {
  const fmt = (p) => (p < 1 ? '<1' : Math.round(p));
  const d = sbDrop(L, k);
  const prev = k > 1 ? sbDrop(L, k - 1) : null;
  const p = L.plays[k - 1];
  const before = sbGet(L.fens[k - 1]);
  const after = sbGet(L.fens[k]);
  // White's win chance on each side of the move: the searched position, else the move's row before it
  const whiteAfter = after && !after.over ? after.white_win : (() => {
    const r = sbRow(before, p.uci);
    return r ? (L.fens[k - 1].split(' ')[1] === 'w' ? r.win : 100 - r.win) : null;
  })();
  const whiteBefore = before && !before.over ? before.white_win : null;
  let lead = '';
  // lead change: the bar crosses from one side's edge to the other's (55/45 leaves a dead zone)
  if (whiteBefore != null && whiteAfter != null) {
    const a = whiteBefore, b = whiteAfter;
    if ((a >= 55 && b <= 45) || (a <= 45 && b >= 55)) lead = `${b > 50 ? 'White' : 'Black'} takes the lead`;
  }
  if (d != null && d >= SB_BIG) {
    const extra = [prev != null && prev >= SB_BIG ? 'gave it straight back' : '', lead].filter(Boolean).join(' · ');
    return { tier: sbTier(d), kind: 'blunder',
      text: `💥 ${p.label} was ${/^[aeiou]/.test(sbVerdict(d)) ? 'an' : 'a'} ${sbVerdict(d)}: −${Math.round(d)}% win chance${extra ? ` · ${extra}` : ''}` };
  }
  const pop = before?.humans?.[0];
  const found = before && !before.over && before.sf[0].uci === p.uci && pop && pop.uci !== p.uci && pop.drop >= SB_GOOD;
  const punished = prev != null && prev >= SB_BIG && d != null && d < SB_GOOD;
  if (found) {
    const pct = before.sf[0].human_pct;
    const who = `~${sbRatings(L.fens[k - 1])[0]} players`;
    return { tier: 0, kind: 'found', text: `⭐ ${p.label}: Stockfish's top move, which ${pct != null ? `only ${fmt(pct)}% of ${who} find` : `${who} rarely find`}`
      + `; most play ${pop.move}${punished ? `. It punishes ${L.plays[k - 2].label}` : ''}` };
  }
  if (punished) return { tier: 0, kind: 'punished', text: `⚡ ${p.label} punishes ${L.plays[k - 2].label}${lead ? ` · ${lead}` : ''}` };
  if (lead) return { tier: 2, kind: 'lead', text: `⇅ ${p.label}: ${lead}` };
  return null;
}

function renderKeyCard() {
  const box = $('key-card');
  const sfOn = state.engineOn;
  const humansOn = maiaOn();
  if (state.editor || !state.review || !sfOn) $('win-strip').classList.add('hidden');
  // an endgame drill with the eval off: the lists would only be half there (and Maia's are no help)
  if (state.editor || !state.review || !(sfOn || humansOn) || (state.play?.endgame && !sfOn)) {
    $('sb-rating').classList.add('hidden');
    return void box.classList.add('hidden');
  }
  box.classList.remove('hidden');
  const fen = currentGame().fen();
  const sb = sfOn ? sbGet(fen) : null;
  if (sfOn) renderWinStrip(fen, sb);

  // Two sections, both about your decisions (user's call): the position where you made your last move, with
  // that move marked and what it cost; and the board now when it's your turn.
  const L = sbLine();
  const n = L.plays.length;
  const u = sbUser();
  const { now, k } = sbTargets(L);
  // Best move (the board now) on top, your previous move below (user's call), each under a big header
  const secs = [];
  if (now != null) {
    const [, turn, , , , num] = fen.split(' ');
    const side = turn === 'w' ? 'White' : 'Black';
    const who = !u ? `${side} to move` : turn === u ? 'your move' : `${side} (opponent) to move`;
    const reply = u && turn === u && n && n !== k ? `<span class="sb-after">after ${esc(L.plays[n - 1].label)}</span>` : '';  // their move between
    secs.push(`<div class="sb-sec live"><div class="sb-sec-h"><span class="sb-sec-t">Best move</span>${sbPov(turn)}${sbStatus(fen)}</div>`
      + `<div class="sb-sec-title"><b class="sb-sec-mv">${num}${turn === 'w' ? '.' : '...'} ${who}</b>${reply}</div>${sbLists(fen, { live: true })}</div>`);
  } else if (!currentGame().isGameOver()) {
    // the bot (or the replayed game) is about to answer: same-size placeholder instead of a gap
    const ghost = '<div class="sb-row ghost"><b class="sb-mv">·</b><span class="sb-rbar"></span><span></span></div>'.repeat(5);
    const lists = ['sf', maiaOn() ? 'maia' : null].filter(Boolean).map((c) => `<div class="sb-list ${c}"><div class="sb-lh"><span class="sb-who">${c === 'sf' ? 'Stockfish' : 'Maia'}</span></div>${ghost}</div>`);
    secs.push(`<div class="sb-sec"><div class="sb-sec-h"><span class="sb-sec-t">Best move</span></div>`
      + `<div class="sb-sec-title"><span class="sb-wait">${state.play ? 'Bot is thinking…' : 'Opponent to move…'}</span></div><div class="sb-lists${lists.length > 1 ? ' two' : ''}">${lists.join('')}</div></div>`);
  }
  if (k) {
    const p = L.plays[k - 1];
    const d = sbDrop(L, k);
    const before = sbGet(L.fens[k - 1]);
    const best = before?.sf?.[0]?.uci === p.uci;
    // where your move sat among Maia's picks at your rating (the useful fact from the mock-up's result block)
    const mr = maiaOn() && before?.humans ? before.humans.findIndex((m) => m.uci === p.uci) + 1 : 0;
    const cost = d == null ? '' : best ? '<span class="sb-cost great" title="Stockfish\'s top move">best</span>'
      : `<span class="sb-cost${d >= 30 ? ' bad' : ''}" title="Win chance this move cost">${d < 1 ? '<1' : `−${Math.round(d)}`}%</span>`;
    secs.push(`<div class="sb-sec"><div class="sb-sec-h"><span class="sb-sec-t" title="${u ? 'Your last move, in the position you played it' : 'The last move, in the position it was played'}">Previous move</span>`
      + `${sbPov(L.fens[k - 1].split(' ')[1])}${sbStatus(L.fens[k - 1])}</div>`
      + `<div class="sb-sec-title"><b class="sb-sec-mv">${esc(p.label)}</b>${cost}`
      + `${mr ? `<span class="sb-mrank" title="Maia's rank for this move at this rating">Maia #${mr}</span>` : ''}</div>`
      + `${sbLists(L.fens[k - 1], { live: false, played: p.uci })}</div>`);
  }

  // banners: your move, then the opponent's reply, then the next-move alert for your turn
  const posts = [];
  if (k) posts.push([k, u ? 'Your move' : 'Last play']);
  if (n && n !== k) posts.push([n, 'Their move']);
  for (const [i, label] of posts) {
    const a = sbPlayAlert(L, i);
    if (a) sbPostAlert(L.fens[i], a, label, '', L.plays[i - 1].label.match(/^\d+\.+/)[0]);
  }
  const big = [];
  for (let i = 1; i <= n; i++) {
    const di = sbDrop(L, i);
    if (di == null) continue;
    if (di >= SB_BIG) big.push({ k: i, label: L.plays[i - 1].label, html: `💥 ${esc(L.plays[i - 1].label)} <span class="t${sbTier(di)}">−${Math.round(di)}%</span>` });
    else if (di < SB_GOOD && i > 1 && (sbDrop(L, i - 1) ?? 0) >= SB_BIG) big.push({ k: i, label: `⚡${L.plays[i - 1].label}`, html: `⚡ ${esc(L.plays[i - 1].label)}` });
  }
  // the next move: the most important alert (the Maia-based ones need the Maia list on)
  const next = now != null && sb && !sb.over ? sb.alerts.find((a) => humansOn || !['disaster', 'danger', 'popular_wrong', 'no_overlap', 'hidden_best'].includes(a.kind)) : null;
  const icon = { disaster: '💥', danger: '⚠', mate: '♚', only_move: '❗', popular_wrong: '⚠', no_overlap: '⇄', hidden_best: '🔎' };
  if (next) {
    const [, turn, , , , num] = fen.split(' ');
    sbPostAlert(fen, next, 'Next play', icon[next.kind] ? `${icon[next.kind]} ` : '', `${num}${turn === 'w' ? '.' : '...'}`);
  }
  sbPostBigPlays(big);  // after the alerts: it's the running summary, so it sits at the bottom

  box.innerHTML = secs.join('');
  // Maia's rating sits in the header row (user's call): yours, or the side to move's on the analysis board
  const pick = $('sb-rating');
  pick.classList.toggle('hidden', !humansOn);
  if (humansOn) {
    const id = (u || fen.split(' ')[1]) === 'w' ? 'maia-white' : 'maia-black';
    const sel = $('kc-rating');
    if (sel.options.length !== $(id).options.length) sel.innerHTML = $(id).innerHTML;
    sel.value = $(id).value;
    pick.title = `Maia's rating for ${id === 'maia-white' ? 'White' : 'Black'}: what players of this rating play`;
    // drive the panel's dropdown, which stores the rating and refetches
    sel.onchange = () => { $(id).value = sel.value; $(id).dispatchEvent(new Event('change')); };
  }
  // live rows: hover shows the move's arrow and lights up the same move in the other list; click plays it
  // (where you could play it yourself; otherwise playMaiaMove only shows the arrow). Rows of your last move's
  // position only light up their twin: the board is no longer there.
  box.querySelectorAll('.sb-sec').forEach((sec) => {
    const live = sec.classList.contains('live');
    sec.querySelectorAll('.sb-row:not(.ghost)').forEach((el) => {
      const twins = () => sec.querySelectorAll(`.sb-row[data-uci="${el.dataset.uci}"]`);
      el.onmouseenter = () => { twins().forEach((t) => t.classList.add('hot')); if (live) { sbShowMove(el.dataset.uci); sbHovering = true; } };
      el.onmouseleave = () => { twins().forEach((t) => t.classList.remove('hot')); if (live) sbHideMove(); };
      if (live) el.onclick = () => { sbClicked = true; sbHideMove(); playMaiaMove(el.dataset.uci); };
    });
  });
  box.onpointermove = () => { sbClicked = false; };
  // a re-render under the pointer (the deep numbers landing) replaces the hovered row without a mouseleave;
  // not after a click, where the row now under the pointer is the next position's (read as the bot's move)
  const hovered = sbClicked ? null : box.querySelector('.sb-row:not(.ghost):hover');
  if (hovered) hovered.onmouseenter();
  if (!hovered?.closest('.live') && sbHovering) sbHideMove();
}

function setupMaia(cfg) {
  state.maiaReady = !!cfg.maia_ready;
  $('maia-pane').classList.toggle('hidden', !state.maiaReady);
  if (!state.maiaReady) return;
  const old = recall('maiaRating') || 1500;  // the single rating from before White/Black were split
  const refresh = () => {
    requestMaia(state.editor ? null : currentGame());
    requestScoreboard(state.editor ? null : currentGame());
  };
  for (const [id, key] of [['maia-white', 'maiaWhite'], ['maia-black', 'maiaBlack']]) {
    const saved = +(recall(key) || old);
    $(id).innerHTML = cfg.maia_ratings.map((r) =>
      `<option value="${r}"${r === saved ? ' selected' : ''}>~${r}</option>`).join('');
    $(id).onchange = (e) => { store(key, e.target.value); refresh(); };
  }
  const syncDisabled = () => {
    const on = $('maia-toggle').checked;
    $('maia-white').disabled = $('maia-black').disabled = !on;
  };
  $('maia-toggle').checked = recall('maiaOn') !== '0';
  syncDisabled();
  $('maia-toggle').onchange = (e) => {
    store('maiaOn', e.target.checked ? '1' : '0');
    syncDisabled();
    refresh();
    renderShapes();
    renderKeyCard();
  };
}

function setEngineVisible(on) {
  state.engineOn = on;
  $('engine-toggle').checked = on;
  $('evalbar').classList.toggle('off', !on);
  $('engine-lines').classList.toggle('hidden', !on);
  renderKeyCard();
}

function setEngine(on) {
  state.engineOn = on;
  if (!state.play) store('engineOn', on ? '1' : '0');
  $('evalbar').classList.toggle('off', !on);
  $('engine-lines').classList.toggle('hidden', !on);
  if (on) {
    requestEval(currentGame());
    requestScoreboard(currentGame());
  }
  renderKeyCard();
}

// ---------------------------------------------------------------- opening explorer

let xToken = 0;
let xTimer = null;

function fmtCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

// No filter UI: always the whole Lichess database. ratings=null means every rating band, but speeds
// must be listed explicitly — the server defaults a missing list to blitz+rapid only.
const EXPLORER_ALL = {
  db: 'lichess',
  ratings: null,
  speeds: ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'],
};
const explorerFilters = () => EXPLORER_ALL;

function requestExplorer(c) {
  clearTimeout(xTimer);
  if (linesFor && !state.demo && c && c.fen() !== linesFor) { $('x-lines-box').classList.add('hidden'); linesFor = null; }
  const token = ++xToken;
  if (!c) return;
  const f = explorerFilters();
  if (!state.explorerReady) {
    $('x-body').innerHTML = '<p class="hint">The explorer needs a Lichess token: add <code>LICHESS_TOKEN=lip_…</code> to <code>.env</code> and restart.</p>';
    return;
  }
  $('x-body').innerHTML = '<p class="hint">Loading…</p>';
  xTimer = setTimeout(async () => {
    try {
      const data = await api('/api/explorer', { fen: c.fen(), ...f });
      if (token === xToken) showExplorer(data);
    } catch (e) {
      if (token === xToken) $('x-body').innerHTML = `<p class="hint">${esc(e.message)}</p>`;
    }
  }, 350);
}

// ---- instant "most studied / most played lines" demos, straight from the explorer

let linesFor = null;  // FEN the lines box was built for

function linesOrigin() {
  // the board position in coach-tool terms (ply + extra moves), so demos can be discussed
  if (state.demo) {
    const d = state.demo;
    return { ply: d.ply, then_moves: [...d.then_moves, ...d.moves.slice(0, d.step)] };
  }
  if (state.play) return { ply: 1, then_moves: state.play.moves.slice(0, state.play.view) };
  return { ply: state.ply + 1, then_moves: [...state.extra] };
}

async function showLines() {
  const c = currentGame();
  const box = $('x-lines-box');
  const f = explorerFilters();
  const origin = linesOrigin();
  linesFor = c.fen();
  box.classList.remove('hidden');
  box.innerHTML = '<p class="hint">Mapping the lines… (the first time for a position can take ~20 s)</p>';
  let data;
  try {
    data = await api('/api/lines', { fen: c.fen(), db: f.db, ratings: f.ratings, speeds: f.speeds });
  } catch (e) {
    box.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
    return;
  }
  if (linesFor !== c.fen()) return;
  if (!data.main_lines.length) { box.innerHTML = '<p class="hint">No established lines from here.</p>'; return; }
  const src = data.source === 'masters' ? 'master games' : 'Lichess games';
  // lines sharing a name get the moves where they part ways ("English Attack · 8...h5 9. Nd5")
  const nameOf = (l) => (l.opening ? l.opening.replace(/^.*?: /, '') : l.moves.slice(0, 3).join(' '));
  const counts = {};
  data.main_lines.forEach((l) => { counts[nameOf(l)] = (counts[nameOf(l)] || 0) + 1; });
  const tail = (l) => {
    const same = data.main_lines.filter((o) => o !== l && nameOf(o) === nameOf(l));
    let split = 0;  // first ply where this line differs from every sibling
    for (const o of same) {
      let i = 0;
      while (i < l.moves.length && o.moves[i] === l.moves[i]) i++;
      split = Math.max(split, i);
    }
    const labels = demoLabels({ start_fen: c.fen(), moves: l.moves });
    return l.moves.slice(split, split + 2).map((m, j) => {
      const lab = labels[split + j];
      if (j > 0 && lab.endsWith('...')) return m;
      return lab.endsWith('...') ? `${lab}${m}` : `${lab} ${m}`;
    }).join(' ');
  };
  const demos = data.main_lines.map((l) => ({
    title: counts[nameOf(l)] > 1 ? `${nameOf(l)} · ${tail(l)}` : nameOf(l),
    ply: origin.ply, then_moves: origin.then_moves, start_fen: c.fen(),
    moves: l.moves,
    notes: l.steps.map((s) => `Played in ${s.share}% of ${src} here · White wins ${s.white}%, draws ${s.draws}%, Black wins ${s.black}%`),
  }));
  box.innerHTML = `<div class="x-lines-h"><span>${data.source === 'masters' ? 'Common' : 'Most played'} lines`
      + `${data.start_opening ? ` · ${esc(data.start_opening)}` : ''}</span><button class="link" id="x-lines-close">×</button></div>`
    + data.main_lines.map((l, i) => {
      const r = l.results_pct || {};
      return `<div class="x-line" data-i="${i}" title="${esc(l.line)}">
        <span class="x-line-name">▶ ${esc(demos[i].title)}</span>
        <span class="x-line-share">${l.share_of_games_pct}%</span>
        <span class="x-line-moves">${esc(l.line)}</span>
        ${r.white !== undefined ? `<span class="x-bar"><i class="w" style="width:${r.white}%"></i><i class="d" style="width:${r.draws}%"></i><i class="b" style="width:${r.black}%"></i></span>` : ''}
      </div>`;
    }).join('') + (data.partial ? '<p class="hint">Lichess was busy, so some lines are shorter.</p>' : '');
  $('x-lines-close').onclick = () => { box.classList.add('hidden'); linesFor = null; };
  box.querySelectorAll('.x-line').forEach((el) => { el.onclick = () => openDemo(demos[+el.dataset.i]); });
}

function showExplorer(data) {
  const head = data.opening
    ? `<div class="x-opening"><b>${esc(data.opening.eco)}</b> ${esc(data.opening.name)}</div>` : '';
  const cached = data.from_cache ? ' <span class="hint">(offline copy)</span>' : '';
  if (!data.moves.length) {
    $('x-body').innerHTML = `${head}<p class="hint">No games reached this position with these filters.${cached}</p>`;
    return;
  }
  const rows = data.moves.map((m) => `<div class="x-row" data-san="${esc(m.san)}" title="Average rating ${m.avg_rating ?? '?'}">
      <span class="x-move">${esc(m.san)}</span>
      <span class="x-n">${fmtCount(m.games)}</span>
      <span class="x-pct">${m.share}%</span>
      <span class="x-bar">
        <i class="w" style="width:${m.white}%">${m.white >= 12 ? Math.round(m.white) + '%' : ''}</i><i class="d" style="width:${m.draws}%">${m.draws >= 12 ? Math.round(m.draws) + '%' : ''}</i><i class="b" style="width:${m.black}%">${m.black >= 12 ? Math.round(m.black) + '%' : ''}</i>
      </span>
    </div>`).join('');
  const games = data.games.length ? `<div class="x-games-h">Example games</div>` + data.games.slice(0, 4).map((g) => {
    const res = g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½';
    const ref = data.db === 'masters' ? `masters:${g.id}` : g.url;
    return `<div class="x-game" data-ref="${esc(ref)}" title="Open and review this game">${esc(g.white)}${g.white_rating ? ` (${g.white_rating})` : ''} – ${esc(g.black)}${g.black_rating ? ` (${g.black_rating})` : ''} <span class="hint">${res} · ${esc(g.year ?? '')}</span></div>`;
  }).join('') : '';
  $('x-body').innerHTML = `${head}<div class="x-total">${fmtCount(data.total)} games${cached}</div>${rows}${games}`;
  $('x-body').querySelectorAll('.x-row').forEach((el) => { el.onclick = () => playSan(el.dataset.san); });
  $('x-body').querySelectorAll('.x-game').forEach((el) => { el.onclick = () => loadGame(el.dataset.ref); });
}

// ---------------------------------------------------------------- update

function update() {
  $('board-wrap').classList.toggle('game-over', !!state.play?.over);
  if (state.editor) return updateEditor();
  clearHeldThreats();  // right-clicked threat arrows are stale once the position moves on
  // a pinned/hovered square from chat text refers to the position it was clicked on — stale once
  // the board moves on, so it would otherwise sit there highlighted with no visible explanation
  pinnedSquares.clear();
  hoverSquare = null;
  const c = renderBoard();
  paintSquares();  // also repaints the lesson's next-move square for the new position
  try { history.replaceState(null, '', state.ply ? `#ply=${state.ply}` : location.pathname); } catch {}
  renderInfo();
  // a lesson is walked by playing its moves on the board, so there's no skipping ahead
  $('nav-next').disabled = $('nav-end').disabled = !!state.study && !state.demo;
  renderMoves();
  renderVariation();
  syncLineButtons();
  syncCards();
  requestEval(c);
  requestMaia(c);
  requestScoreboard(c);
  renderKeyCard();  // quick numbers or placeholders until the deep ones arrive
  requestOpening();
  requestExplorer(c);
  noteMove();
  saveBoard();
}

// ---- the board survives a page refresh: a snapshot in localStorage, restored by init() only when the
// server still has the same game loaded (it keeps one global review), so it never lands on the wrong game.
// Lessons, demos and replays aren't restored; a bot game is (its moves live only in the page).

const reviewKey = (r) => [r.game_id || '', r.start_fen, r.moves.length, r.white, r.black].join('|');

function saveBoard() {
  if (!state.review || state.study || state.demo) return;
  // backLesson holds a whole lesson tree and can't come back without it; thinking restarts on load
  const play = state.play ? { ...state.play, thinking: false, backLesson: undefined } : null;
  store('board', JSON.stringify({ key: reviewKey(state.review), ply: state.ply, extra: state.extra,
    orientation: state.orientation, play }));
}

// a saved line only counts if it still replays from its start position
function replays(startFen, sans) {
  try {
    const c = new Chess(startFen);
    return sans.every((san) => c.move(san));
  } catch { return false; }
}

function restoreBoard(review) {
  let snap = null;
  try { snap = JSON.parse(recall('board') || 'null'); } catch {}
  if (!snap || snap.key !== reviewKey(review)) return false;
  const play = snap.play && replays(snap.play.startFen, snap.play.moves) ? snap.play : null;
  if (play?.clock) play.clock.lastTick = Date.now();  // the time away isn't charged to anyone
  setReview(review, null, play);
  if (!play) {
    state.ply = Math.max(0, Math.min(snap.ply || 0, review.moves.length));
    const base = state.ply ? review.moves[state.ply - 1].fen_after : review.start_fen;
    state.extra = Array.isArray(snap.extra) && replays(base, snap.extra) ? snap.extra : [];
  }
  if (snap.orientation === 'white' || snap.orientation === 'black') state.orientation = snap.orientation;
  if (play) playView(play.view);  // a bot game draws its board from state.extra, which playView fills
  else update();
  // refreshed while the bot was to move: let it move now
  if (play && !play.over) {
    const c = new Chess(play.startFen);
    play.moves.forEach((san) => c.move(san));
    if (c.turn() !== play.color[0]) botMove();
  }
  return true;
}

// ---------------------------------------------------------------- chat

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// SAN with a piece letter, a capture, castling, or a move number in front (so "the e5 square" stays plain text)
const SAN_RE = /\b((?:\d+\.(?:\.\.)?\s?)?(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?)[+#]?|O-O(?:-O)?[+#]?|\d+\.(?:\.\.)?\s?[a-h][1-8](?:=[QRBN])?[+#]?)/g;

// ---- chat rendering: moves as chips, evals as badges, chess terms with definitions

const GLOSSARY = {
  'tempo': 'A move\'s worth of time. Gaining a tempo means forcing your opponent to spend a move reacting (e.g. moving an attacked queen) while you improve.',
  'pin': 'A piece can\'t move (or shouldn\'t) because a more valuable piece or the king stands behind it on the same line.',
  'fork': 'One piece attacks two or more targets at once, so only one can be saved.',
  'skewer': 'Like a pin in reverse: a valuable piece is attacked and has to move, exposing the piece behind it.',
  'x-ray': 'A piece exerting force through another piece along a line, so it takes effect as soon as that piece moves or is traded.',
  'discovered attack': 'Moving one piece uncovers an attack by another piece behind it. Deadly when the moved piece also attacks something.',
  'discovered check': 'A discovered attack where the uncovered piece gives check.',
  'back rank': 'The first/last rank. A king stuck there behind its own pawns can be mated by a rook or queen: the back-rank mate.',
  'deflection': 'Forcing a defending piece away from the square or piece it guards.',
  'decoy': 'Luring an enemy piece (often the king) onto a square where it gets hit by a tactic.',
  'removing the defender': 'Capturing or chasing away the piece that guards something, so it falls.',
  'overloaded': 'A piece with too many defensive jobs; make it do one and the other collapses.',
  'zwischenzug': 'An in-between move: instead of the expected recapture, a stronger forcing move first.',
  'zugzwang': 'Any move you make worsens your position, but you have to move.',
  'opposition': 'Kings facing each other with one square between; the side NOT to move has the opposition, key in king-and-pawn endings.',
  'outpost': 'A square in enemy territory that can\'t be attacked by enemy pawns, ideal for a knight.',
  'passed pawn': 'A pawn with no enemy pawns in front of it or on neighbouring files; it can run to promote.',
  'isolated pawn': 'A pawn with no friendly pawns on the neighbouring files; it can\'t be defended by pawns.',
  'fianchetto': 'Developing a bishop to g2/b2 (or g7/b7) after moving the knight\'s pawn one square.',
  'gambit': 'Offering material (usually a pawn) in the opening for development, tempo or attack.',
  'sacrifice': 'Giving up material on purpose for something bigger: an attack, a mate, or winning more back.',
  'en prise': 'Left where it can be captured for free.',
  'luft': 'An escape square made for the king (e.g. h3) so it can\'t be back-rank mated.',
  'battery': 'Two pieces lined up on the same line (queen and rook, queen and bishop), doubling their power.',
  'open file': 'A file with no pawns on it, a highway for rooks.',
  'the exchange': 'Winning "the exchange" means winning a rook for a bishop or knight.',
  'trap': 'A move that sets up a natural-looking reply which loses.',
  'mating net': 'The king is boxed in and a forced mate is coming.',
  'initiative': 'Being the one making threats, so the opponent keeps having to react.',
};
// "back rank" also matches "back-rank"; "x-ray" also matches "x ray"
const termKey = (w) => w.toLowerCase().replace(/[\s-]+/g, ' ');
const GLOSSARY_BY_KEY = Object.fromEntries(Object.entries(GLOSSARY).map(([k, v]) => [termKey(k), v]));
const GLOSSARY_RE = new RegExp(`\\b(${Object.keys(GLOSSARY).sort((a, b) => b.length - a.length)
  .map((k) => k.split(/[\s-]+/).join('[\\s-]')).join('|')})\\b`, 'gi');

function evalWords(v) {
  const a = Math.abs(v);
  if (a < 0.5) return 'roughly equal';
  const side = v > 0 ? 'White' : 'Black';
  if (a < 1.5) return `${side} is slightly better`;
  if (a < 3) return `${side} is clearly better`;
  return `${side} is winning`;
}

function moveChip(token) {
  const m = token.match(/^(\d+)\.(\.\.)?\s?(.*)$/);
  const san = m ? m[3] : token;
  const title = m ? `${m[2] ? 'Black' : 'White'}, move ${m[1]}: ${san}. Click to see it on the board.` : `${san}: click to play it on the board`;
  return `<span class="san" data-token="${esc(token)}" title="${esc(title)}">${esc(san)}</span>`;
}

// squares named in the chat: hover to highlight, click to keep highlighted (click again, or Esc, to clear)
const pinnedSquares = new Set();
let hoverSquare = null;

function paintSquares() {
  const marks = new Map([...studyNextSquares(), ...drawnSquares()]);
  pinnedSquares.forEach((sq) => marks.set(sq, 'sq-pin'));
  if (hoverSquare) marks.set(hoverSquare, 'sq-hover');
  cg.set({ highlight: { custom: marks } });
  document.querySelectorAll('.msg .sq').forEach((el) => el.classList.toggle('on', pinnedSquares.has(el.dataset.sq)));
}

function inline(text, seen = new Set()) {
  const slots = [];
  const hold = (html) => `\u0001${slots.push(html) - 1}\u0002`;
  let out = esc(text)
    .replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`))
    .replace(SAN_RE, (tok) => hold(moveChip(tok)))
    .replace(/(^|[\s(])([+\-−]\d+(?:\.\d+)?|#-?\d+)(?=[\s,.;:)!?]|$)/g, (all, pre, ev) => {
      const mate = ev.startsWith('#');
      const v = mate ? (ev.includes('-') ? -99 : 99) : parseFloat(ev.replace('−', '-'));
      const cls = mate ? 'm' : v > 0.5 ? 'w' : v < -0.5 ? 'b' : 'eq';
      const title = mate ? `Forced mate for ${v > 0 ? 'White' : 'Black'} in ${ev.replace(/[#-]/g, '')}`
        : `Engine evaluation (White's point of view): ${evalWords(v)}`;
      return pre + hold(`<span class="evalpill ${cls}" title="${esc(title)}">${ev}</span>`);
    });
  // bare pawn moves inside a sequence ("e4 c5") become chips too
  for (let prev = null; prev !== out;) {
    prev = out;
    out = out.replace(/(\u0002\s+)([a-h][1-8](?:=[QRBN])?[+#]?)(?=[\s,.;:)!?]|$)/g, (_, pre, pawn) => pre + hold(moveChip(pawn)));
  }
  // any other square name ("the c3 knight", "f7") highlights that square on the board
  out = out.replace(/(^|[^\w\u0001])([a-h][1-8])(?![\w\u0002])/g,
    (_, pre, sq) => pre + hold(`<span class="sq" data-sq="${sq}" title="Show ${sq} on the board">${sq}</span>`));
  out = out
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s,.;:)!?]|$)/g, '$1<em>$2</em>')
    .replace(GLOSSARY_RE, (w) => {
      const key = termKey(w);
      if (seen.has(key) || !GLOSSARY_BY_KEY[key]) return w;
      seen.add(key);
      return `<span class="term" tabindex="0" data-tip="${esc(GLOSSARY_BY_KEY[key])}">${w}</span>`;
    });
  return out.replace(/\u0001(\d+)\u0002/g, (_, i) => slots[+i]);
}

function markdown(text) {
  const seen = new Set();
  const blocks = text.trim().split(/\n{2,}/);
  const html = [];
  let points = [];
  const flush = () => {
    if (points.length) html.push(`<ol class="points">${points.map((p) => `<li>${p}</li>`).join('')}</ol>`);
    points = [];
  };
  const MOVE_START = /^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O(?:-O)?[+#]?)[!?]*\s+(?:\d+\.|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8]|O-O)/;
  const point = (text) => {
    // "Grand Prix Attack – 3. f4. He wants…" -> titled card
    const t = text.match(/^\**([^.:–—*]{3,48}?)\**\s*(?:[–—:]|\s-\s)\s*([\s\S]+)$/);
    return t ? `<span class="pt-title">${inline(t[1], seen)}</span>${inline(t[2], seen)}` : inline(text, seen);
  };
  for (const block of blocks) {
    const lines = block.split('\n');
    // "1. That f6 pawn is a crowbar…" style points: numbered from 1, real sentences (not move
    // sequences), either one per paragraph or several on consecutive lines
    const items = lines.map((l) => l.match(/^\s*(\d+)\.\s+(.{12,})$/));
    const sequential = items.every((m, i) => m && +m[1] === points.length + i + 1 && !MOVE_START.test(m[2]));
    if (sequential && (lines.length > 1 || items[0][2].length >= 30)) {
      items.forEach((m) => points.push(point(m[2])));
      continue;
    }
    flush();
    const heading = lines[0].match(/^\s*#{1,4}\s+(.+)$/);
    if (heading) {
      html.push(`<div class="mh">${inline(heading[1], seen)}</div>`);
      if (lines.length > 1) html.push(`<p>${lines.slice(1).map((l) => inline(l, seen)).join('<br>')}</p>`);
      continue;
    }
    if (lines.every((l) => /^\s*>/.test(l))) {  // quote = the coach flagging a special move
      html.push(`<div class="alert-red"><span class="alert-ico">⚡</span>${lines.map((l) => inline(l.replace(/^\s*>\s?/, ''), seen)).join('<br>')}</div>`);
    } else if (/^\s*\**pro tip:?\**:?/i.test(block)) {
      const body = block.replace(/^\s*\**pro tip:?\**:?\s*/i, '');
      html.push(`<div class="protip"><div class="protip-h">💡 Pro tip</div><p>${lines.length > 1 ? body.split('\n').map((l) => inline(l, seen)).join('<br>') : inline(body, seen)}</p></div>`);
    } else if (lines.every((l) => /^\s*[-*] /.test(l))) {
      html.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''), seen)}</li>`).join('')}</ul>`);
    } else {
      // "**What e5 actually does:** it opens…" -> a standout label line instead of a few bolded words
      const lbl = lines[0].match(/^\*\*([^*]{3,60}?)\*\*:\s*(.+)$/) || lines[0].match(/^\*\*([^*]{3,60}?):\*\*\s*(.+)$/);
      if (lbl) {
        const rest = [inline(lbl[2], seen), ...lines.slice(1).map((l) => inline(l, seen))].join('<br>');
        html.push(`<p><span class="lbl">${inline(lbl[1], seen)}</span>${rest}</p>`);
      } else {
        html.push(`<p>${lines.map((l) => inline(l, seen)).join('<br>')}</p>`);
      }
    }
  }
  flush();
  return html.join('');
}

// ---- moves referenced in chat: find them in the current line of play

function currentLine() {
  // the moves from the start position to what the board shows, and how far along we are
  if (state.demo) {
    const d = state.demo;
    return { startFen: d.start_fen, sans: d.moves, at: d.step, kind: 'demo' };
  }
  if (state.play) {
    const p = state.play;
    return { startFen: p.startFen, sans: p.moves, at: p.view, kind: 'play' };
  }
  const r = state.review;
  const game = r.moves.map((m) => m.san);
  const sans = state.extra.length ? [...game.slice(0, state.ply), ...state.extra] : game;
  return { startFen: r.start_fen, sans, at: state.ply + state.extra.length, kind: 'review' };
}

function lineIndex(startFen, number, black) {
  const c = new Chess(startFen);
  return (number - c.moveNumber()) * 2 + (black ? 1 : 0) - (c.turn() === 'w' ? 0 : 1);
}

function goToLine(k) {
  // show the position after k moves of the current line
  const line = currentLine();
  if (line.kind === 'demo') return demoStep(k);
  if (line.kind === 'play') return playView(k);
  const game = state.review.moves.map((m) => m.san);
  const matching = line.sans.slice(0, k).every((san, i) => san === game[i]);
  if (matching && k <= game.length) goTo(k);
  else { state.extra = line.sans.slice(state.ply, k); update(); }
}

function resolveToken(token) {
  // -> {k, san}: the move `san` played from the position after k moves of the current line
  const m = token.match(/^(\d+)\.(\.\.)?\s?(.*)$/);
  const line = currentLine();
  if (!m) return { k: line.at, san: token };
  const k = lineIndex(line.startFen, +m[1], !!m[2]);
  if (k < 0 || k > line.sans.length) return null;
  return { k, san: m[3] };
}

function legalAt(k, san) {
  const line = currentLine();
  const c = new Chess(line.startFen);
  try {
    for (const x of line.sans.slice(0, k)) c.move(x);
    return c.move(san);
  } catch {
    return null;
  }
}

// a threat mentioned before it's actually playable ("...Nxe4" while it's still your move) isn't
// legal at the current position — try it with the side to move flipped, same trick movesShapesFor
// uses to preview an opponent piece's options
function legalAtFlipped(k, san) {
  const line = currentLine();
  const c = new Chess(line.startFen);
  try {
    for (const x of line.sans.slice(0, k)) c.move(x);
  } catch {
    return null;
  }
  const parts = c.fen().split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  try {
    return new Chess(parts.join(' ')).move(san);
  } catch {
    return null;
  }
}

// ---- every point/callout that mentions a move gets its own "▶ Show on board" button,
// built from every move chip inside it (in order), whether or not they sit side by side

function addLineButtons(root) {
  root.querySelectorAll('p, li, .alert-red, .protip p').forEach((block) => {
    const chips = [...block.querySelectorAll('.san')];
    if (!chips.length) return;
    const tokens = chips.map((c) => c.dataset.token);
    const key = tokens.join('|');
    // a numbered option card is one visual unit: make the whole card clickable instead of
    // bolting a separate button onto it (inner chips still handle their own click first)
    if (block.tagName === 'LI' && block.parentElement.classList.contains('points')) {
      block.classList.add('card-play');
      block.dataset.key = key;
      block.title = `${tokens.join(' ')}\nClick to play this on the demo board, click again to return`;
      block.onclick = (e) => {
        if (e.target.closest('.san, .sq, .term')) return;
        if (!toggleLine(tokens, key)) block.classList.add('stale');
      };
      return;
    }
    // no separate button: the chips themselves are the demo trigger — hover any one to preview
    // just that move, click any one to show the whole line (every chip in this block, in order)
    // on the demo board. One click target per line instead of a chip *and* a button doing the
    // same thing right next to it.
    chips.forEach((c) => {
      c.dataset.lineKey = key;
      c.dataset.lineTokens = JSON.stringify(tokens);
      c.title = `${tokens.join(' ')}\nClick to show this on the demo board, click again to return`;
    });
  });
}

function syncLineButtons() {
  const activeKey = state.demo?.sourceKey;
  document.querySelectorAll('.san[data-line-key]').forEach((chip) => {
    chip.classList.toggle('active', !!activeKey && chip.dataset.lineKey === activeKey);
  });
  document.querySelectorAll('.card-play').forEach((card) => {
    card.classList.toggle('active', !!activeKey && card.dataset.key === activeKey);
  });
}

function toggleLine(tokens, key) {
  // clicking the button that's currently showing its line just closes the demo again
  if (state.demo && state.demo.sourceKey === key) { closeDemo(); return true; }
  return playLine(tokens, key);
}

function playLine(tokens, sourceKey) {
  const line = currentLine();

  // try to play `tokens` starting k moves into the current line; null if that start point is out
  // of range or the very first token isn't legal there
  const attempt = (k) => {
    if (k == null || k < 0 || k > line.sans.length) return null;
    const c = new Chess(line.startFen);
    try { for (const x of line.sans.slice(0, k)) c.move(x); } catch { return null; }
    const startFen = c.fen();
    const moves = [];
    for (const tok of tokens) {
      const san = tok.replace(/^\d+\.(\.\.)?\s?/, '');
      try { moves.push(c.move(san).san); } catch { break; }  // stop at the first move that doesn't fit
    }
    return moves.length ? { k, startFen, moves } : null;
  };

  // The line's own move number and the current view are usually the right place to start from —
  // but if that's drifted (navigated on, a takeback, a demo nested in a demo), the line itself is
  // probably still fine: search every position in the line, nearest to the current view first,
  // and keep whichever start plays out the fullest sequence (stop early on a full match). A line
  // worth showing is worth showing somewhere.
  const byDistance = Array.from({ length: line.sans.length + 1 }, (_, k) => k)
    .sort((a, b) => Math.abs(a - line.at) - Math.abs(b - line.at));
  const tried = new Set();
  let best = null;
  for (const k of [resolveToken(tokens[0])?.k, line.at, ...byDistance]) {
    if (k == null || tried.has(k)) continue;
    tried.add(k);
    const r = attempt(k);
    if (!r) continue;
    if (r.moves.length === tokens.length) { best = r; break; }
    if (!best || r.moves.length > best.moves.length) best = r;
  }
  if (!best) return false;
  const { k, startFen, moves } = best;

  // where this sits in coach-tool terms, so questions inside the demo still work
  let origin;
  if (line.kind === 'demo') {
    origin = { ply: state.demo.ply, then_moves: [...state.demo.then_moves, ...line.sans.slice(0, k)] };
  } else if (line.kind === 'play') {
    origin = { ply: 1, then_moves: line.sans.slice(0, k) };
  } else {
    const game = state.review.moves.map((m) => m.san);
    let p = 0;
    while (p < k && p < game.length && line.sans[p] === game[p]) p++;
    origin = { ply: p + 1, then_moves: line.sans.slice(p, k) };
  }
  const title = tokens.length > 1 ? `Move order: ${tokens[0]}` : `On the board: ${tokens[0]}`;
  openDemo({ title, start_fen: startFen, moves, notes: [], sourceKey: sourceKey ?? tokens.join('|'), ...origin });
  return true;
}

function moveDestination(token) {
  // the square a move lands on, straight from its notation ("7...Nxd4+" -> d4, "O-O" by colour)
  const m = token.match(/^(\d+)\.(\.\.)?\s?(.*)$/);
  const san = (m ? m[3] : token).replace(/[+#!?]+$/, '');
  if (/^O-O/.test(san)) {
    if (!m) return null;  // castling without a move number: side unknown
    const rank = m[2] ? '8' : '1';
    return (san === 'O-O-O' ? 'c' : 'g') + rank;
  }
  return san.match(/([a-h][1-8])(?:=[QRBN])?$/)?.[1] || null;
}

function clickMove(token) {
  const t = resolveToken(token);
  if (!t) return false;
  const line = currentLine();
  if (!legalAt(t.k, t.san)) return false;
  if (line.sans[t.k] === t.san) { goToLine(t.k + 1); return true; }  // a move that was played
  if (line.kind === 'play') {  // live game: just show the idea
    if (t.k !== line.at) return false;
    const mv = legalAt(t.k, t.san);
    cg.setAutoShapes([{ orig: mv.from, dest: mv.to, brush: 'green' }]);
    return true;
  }
  if (t.k !== line.at) goToLine(t.k);
  return playSan(t.san);
}

function squareFromEvent(e) {
  const rect = $('board').getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  const fi = Math.min(7, Math.floor(x * 8));
  const ri = Math.min(7, Math.floor(y * 8));
  return state.orientation === 'white'
    ? 'abcdefgh'[fi] + (8 - ri)
    : 'abcdefgh'[7 - fi] + (ri + 1);
}

function moveBrush(move, isOpponent) {
  const isCheck = move.san.includes('+') || move.san.includes('#');
  const isCapture = move.flags.includes('c') || move.flags.includes('e');
  if (isOpponent) return isCheck ? 'hvOppCheck' : isCapture ? 'hvOppCapture' : 'hvOpp';
  return isCheck ? 'hvCheck' : isCapture ? 'hvCapture' : 'hvMove';
}

// a knight's move drawn as a real L (two straight legs through a real square) instead of the
// diagonal-ish straight line chessground would draw between origin and destination
function knightShapes(from, to, brush) {
  const fileDelta = Math.abs(from.charCodeAt(0) - to.charCodeAt(0));
  const bend = fileDelta === 2 ? to[0] + from[1] : from[0] + to[1];
  return [{ orig: from, dest: bend, brush: `${brush}Mid` }, { orig: bend, dest: to, brush }];
}

// threat arrows for the piece on `sq`: one per enemy piece it attacks (captures only, not every
// move), [] if none apply right now (empty square, game over, editor/demo mode, or not the player's
// turn in a live bot game). attackers() works for either side regardless of whose turn it is and
// counts a pinned piece's attacks too, which legal moves would hide.
function movesShapesFor(sq) {
  if (!sq || state.editor || state.demo) return [];
  const c = currentGame();
  if (c.isGameOver()) return [];
  const turn = c.turn() === 'w' ? 'white' : 'black';
  // In a live bot game only show during the player's turn
  if (state.play) {
    const p = state.play;
    if (p.over || p.thinking || p.view !== p.moves.length) return [];
  }
  const piece = cg.state.pieces.get(sq);
  if (!piece) return [];
  const isOpponent = piece.color !== turn;
  const by = piece.color === 'white' ? 'w' : 'b';
  const shapes = [];
  for (const [target, p] of cg.state.pieces) {
    if (p.color === piece.color || !c.attackers(target, by).includes(sq)) continue;
    const brush = p.role === 'king' ? (isOpponent ? 'hvOppCheck' : 'hvCheck') : (isOpponent ? 'hvOppCapture' : 'hvCapture');
    shapes.push(...(piece.role === 'knight' ? knightShapes(sq, target, brush) : [{ orig: sq, dest: target, brush }]));
  }
  return shapes;
}

function renderShapes() {
  cg.setAutoShapes([...baseShapes(), ...heldThreats]);
}

// ---- your own arrows and circles (right-drag; modifier = colour). They belong to the position they
// were drawn on: drawnShapes() drops them once the board shows anything else.

let drawings = [];
let drawingsFen = null;

function drawBrush(m) {
  if (!m) return null;
  // fn first: browsers rarely report it (macOS keeps the key to itself), so Shift stands in for it
  if (m.fn || m.shift) return 'drawFn';
  if (m.ctrl) return 'drawCtrl';
  if (m.meta) return 'drawCmd';
  if (m.alt) return 'drawOpt';
  return null;
}

// Right-drag: an arrow. Right-click on an empty square (or on any square with a modifier): fill it.
// Plain right-click on a piece: its threat arrows. A second right-click on the same square undoes it.
function userShape(s) {
  const brush = drawBrush(drawMods);
  if (s.dest) toggleDrawing({ orig: s.orig, dest: s.dest, brush: brush || 'drawNone' });
  else if (brush || !cg.state.pieces.get(s.orig)) toggleDrawing({ orig: s.orig, brush: brush || 'drawNone' });
  else holdThreatSquare(s.orig);
}

// drawing the same arrow again removes it (as chessground does), a different colour recolours it;
// a filled square is cleared by any second right-click on it
function toggleDrawing(shape) {
  const fen = currentGame().fen();
  if (drawingsFen !== fen) { drawings = []; drawingsFen = fen; }
  const i = drawings.findIndex((d) => d.orig === shape.orig && d.dest === shape.dest);
  const keep = i < 0 || (shape.dest && drawings[i].brush !== shape.brush);
  if (i >= 0) drawings.splice(i, 1);
  if (keep) drawings.push(shape);
  renderShapes();
  paintSquares();
}

// filled squares, painted through chessground's square highlights (paintSquares), keyed by brush
function drawnSquares() {
  if (!drawings.length || drawingsFen !== currentGame().fen()) return [];
  return drawings.filter((d) => !d.dest).map((d) => [d.orig, `sq-fill-${d.brush}`]);
}

// a knight-shaped arrow (a8 to b6) is drawn as an L, like the hover arrows
function drawnShapes() {
  if (!drawings.length || drawingsFen !== currentGame().fen()) return [];
  return drawings.flatMap((d) => {
    if (!d.dest) return [];  // a filled square, see drawnSquares
    const df = Math.abs(d.orig.charCodeAt(0) - d.dest.charCodeAt(0)), dr = Math.abs(+d.orig[1] - +d.dest[1]);
    return df * dr === 2 ? knightShapes(d.orig, d.dest, d.brush) : [d];
  });
}

function clearUserShapes() {
  const had = drawings.length || heldSquares.size;
  drawings = [];
  heldSquares.clear();
  heldThreats = [];
  if (had) { renderShapes(); paintSquares(); }
}

// ---- right-click a piece to hold its threat arrows (accumulates across pieces);
// left click resets them all — see the drawable.onChange hook and the board's mousedown listener

let heldThreats = [];
let heldSquares = new Set();

function holdThreatSquare(sq) {
  if (heldSquares.has(sq)) {  // right-click the same piece again: drop its arrows
    heldSquares.delete(sq);
    heldThreats = [...heldSquares].flatMap(movesShapesFor);
    renderShapes();
    return;
  }
  const shapes = movesShapesFor(sq);
  if (!shapes.length) return;
  heldSquares.add(sq);
  heldThreats.push(...shapes);
  renderShapes();
}

function clearHeldThreats() {
  if (!heldSquares.size) return;
  heldSquares.clear();
  heldThreats = [];
  renderShapes();
}

function myColor() {
  return state.play ? state.play.color : state.review.player_color;
}

function previewMove(token, on) {
  if (!on) { cg.setAutoShapes(baseShapes()); return; }
  const t = resolveToken(token);
  if (!t || t.k !== currentLine().at) return;
  const mv = legalAt(t.k, t.san) || legalAtFlipped(t.k, t.san);
  if (!mv) return;
  const mine = myColor();
  const isOpponent = !!mine && mv.color !== mine[0];
  const brush = moveBrush(mv, isOpponent);
  cg.setAutoShapes(mv.piece === 'n' ? knightShapes(mv.from, mv.to, brush) : [{ orig: mv.from, dest: mv.to, brush }]);
}

function playSan(token) {
  const san = token.replace(/^\d+\.(\.\.)?\s?/, '');
  const c = currentGame();
  let mv;
  try {
    mv = c.move(san);
  } catch {
    return false;
  }
  if (state.demo) {
    demoPush(mv.san);
    return true;
  }
  if (state.play) {  // don't move pieces in a live game; just show the idea
    cg.setAutoShapes([{ orig: mv.from, dest: mv.to, brush: 'green' }]);
    return true;
  }
  const next = state.review.moves[state.ply];
  if (!state.extra.length && next && next.san === san) state.ply++;
  else state.extra.push(san);
  update();
  return true;
}

function addMsg(kind, html, where) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.innerHTML = (where ? `<span class="where">${esc(where)}</span>` : '') + html;
  addLineButtons(div);
  div.querySelectorAll('.san').forEach((el) => {
    const dest = moveDestination(el.dataset.token);
    el.onclick = () => {
      if (el.dataset.lineKey) {  // part of a mentioned line: show it on the demo board
        if (el.classList.contains('stale')) return;
        if (!toggleLine(JSON.parse(el.dataset.lineTokens), el.dataset.lineKey)) el.classList.add('stale');
        return;
      }
      const moved = clickMove(el.dataset.token);
      if (dest) {  // mark where the piece lands (the only effect if the move isn't reachable from here)
        pinnedSquares.clear();
        pinnedSquares.add(dest);
        paintSquares();
      }
      if (!moved) el.title = `Not reachable from the current line of play; highlighted ${dest || 'nothing'} instead`;
    };
    el.onmouseenter = () => { previewMove(el.dataset.token, true); if (dest) { hoverSquare = dest; paintSquares(); } };
    el.onmouseleave = () => { previewMove(el.dataset.token, false); hoverSquare = null; paintSquares(); };
  });
  div.querySelectorAll('.sq').forEach((el) => {
    const sq = el.dataset.sq;
    el.onmouseenter = () => { hoverSquare = sq; paintSquares(); };
    el.onmouseleave = () => { hoverSquare = null; paintSquares(); };
    el.onclick = () => {
      if (pinnedSquares.has(sq)) pinnedSquares.delete(sq); else pinnedSquares.add(sq);
      paintSquares();
    };
  });
  div.querySelectorAll('.term').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); el.classList.toggle('open'); };
    el.onblur = () => el.classList.remove('open');
  });
  if (kind.startsWith('coach')) div.querySelector(':scope > p')?.classList.add('lead');
  $('chat-log').appendChild(div);
  if (kind.startsWith('coach') && div.offsetHeight > $('chat-log').clientHeight * 0.8) {
    div.scrollIntoView({ block: 'start' });  // long answer: start reading at the top
  } else {
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  }
  return div;
}

function moveAt(plies, startFen = state.review.start_fen) {
  // "move 8, Black to move" for the position `plies` half-moves after the start
  const c = new Chess(startFen);
  const idx = plies + (c.turn() === 'w' ? 0 : 1);
  return { no: c.moveNumber() + Math.floor(idx / 2), side: idx % 2 ? 'Black' : 'White' };
}

function toolLabel(t) {
  const i = t.input || {};
  const plies = Math.max(0, (i.ply ?? 1) - 1) + (i.then_moves?.length || 0);
  const at = moveAt(plies);
  const where = `move ${at.no}, ${at.side} to move`;
  if (t.name === 'move_report') return `checked ${at.side}'s move ${at.no}`;
  if (t.name === 'compare_moves') return `compared ${(i.moves || []).join(', ')} · move ${at.no}`;
  if (t.name === 'analyze_position') return `analysed · ${where}`;
  if (t.name === 'find_tricks') return `looked for tricks · ${where}`;
  if (t.name === 'opening_explorer') return `checked real games · ${where}`;
  if (t.name === 'opening_lines') return `mapped the main lines · ${where}`;
  return t.name;
}

function toolTitle(t) {
  const i = t.input || {};
  return i.then_moves?.length ? `From ply ${i.ply}, after ${i.then_moves.join(' ')}` : `Ply ${i.ply ?? 0}`;
}

async function ask(question, opts = {}) {
  question = question.trim();
  if (!question) return;
  if (opts.silent) {  // automatic alerts wait their turn instead of being dropped
    while (state.chatBusy) await new Promise((r) => setTimeout(r, 300));
  } else if (state.chatBusy) {
    return;
  }
  if (state.editor) {  // the coach needs a real position: switch to analysis of the set-up first
    if (!(await analyseEditorPosition())) return;
  }
  if (!state.coachReady) {
    addMsg('error', 'The coach needs an Anthropic API key: set <code>ANTHROPIC_API_KEY</code> and restart the server.');
    return;
  }
  state.chatBusy = true;
  $('chat-send').disabled = true;
  if (!opts.silent) {
    if (!opts.hideQuestion) addMsg('user', esc(question), positionLabel());
    $('chat-text').value = '';
  }
  const pending = addMsg('coach', `<span class="thinking">${opts.silent ? 'Spotted something' : 'Analysing'}</span>`);
  try {
    const where = opts.at || (state.demo
      ? { ply: Math.max(0, state.demo.ply - 1), extra: [...state.demo.then_moves, ...state.demo.moves.slice(0, state.demo.step)] }
      : { ply: state.ply, extra: state.extra });
    let polling = true;
    (async () => {  // live progress: show the coach's tool steps while it works
      while (polling) {
        await new Promise((r) => setTimeout(r, 1200));
        if (!polling) break;
        try {
          const { steps } = await api('/api/chat/progress');
          const shown = steps.filter((t) => t.name !== 'show_on_board' && t.name !== 'move_quiz' && t.name !== 'jump_to_move');
          if (polling && shown.length) {
            pending.innerHTML = `<span class="thinking">${opts.silent ? 'Spotted something' : 'Analysing'}</span>`
              + `<div class="steps">${shown.map((t) => `<div>✓ ${esc(toolLabel(t))}</div>`).join('')}</div>`;
          }
        } catch { /* ignore */ }
      }
    })();
    let data;
    try {
      data = await api('/api/chat', {
        question, ...where,
        where: opts.where || positionLabel(), mode: currentMode(), label: opts.silent ? opts.label : null,
        ambient: !!opts.ambient,
      });
    } finally {
      polling = false;
    }
    pending.remove();
    if (opts.skipEmpty && /^\(nothing\)\.?$/i.test(data.answer.trim())) return;
    renderAnswer(data, { ...opts, live: true });
  } catch (e) {
    pending.remove();
    addMsg('error', esc(e.message));
  } finally {
    state.chatBusy = false;
    $('chat-send').disabled = false;
  }
}

function currentMode() {
  if (state.demo) return 'demo';
  if (state.play) return 'play';
  if (state.replay) return 'replay';
  return state.review.moves.length ? 'review' : 'analysis';
}

function renderQuiz(quiz) {
  if (!quiz) return '';
  const opts = quiz.options.map((o) => `<button class="quiz-opt" data-san="${esc(o)}">${esc(o)}</button>`).join('');
  return `<div class="quiz" data-correct="${esc(quiz.correct)}" data-reward="${esc(quiz.reward)}">${opts}<div class="quiz-reward hidden"></div></div>`;
}

function renderAnswer(data, opts = {}) {
  // a coach answer bubble: text, a move_quiz, Show me buttons, the checks bubble and a ☆ for the library
  const n = (data.tools || []).length;
  const tools = n
    ? `<details class="tools"><summary>🔍 ${n} check${n > 1 ? 's' : ''}</summary>${data.tools.map((t) => `<div title="${esc(toolTitle(t))}">✓ ${esc(toolLabel(t))}</div>`).join('')}</details>` : '';
  const demos = data.demos || [];
  const buttons = demos.length
    ? `<div class="demos">${demos.map((d, i) => `<button class="demo-btn" data-i="${i}">▶ Show me: ${esc(d.title)}</button>`).join('')}</div>` : '';
  // coach ply = the position *before* that move, so the board goes to ply - 1 moves played
  const jumps = state.review && !state.play
    ? (data.jumps || []).filter((j) => j.ply <= state.review.moves.length + 1) : [];
  // a go-now jump ("what would you play as White's 10th move?") moves the board as the answer appears,
  // only for a fresh answer (not one reopened from Lessons) and not mid-replay, where you're already on the move
  const auto = opts.live && !state.replay ? jumps.find((j) => j.now) : null;
  const jumpBtn = jumps.some((j) => !j.now)
    ? `<div class="demos">${jumps.map((j, i) => (j.now ? '' : `<button class="demo-btn jump-btn" data-j="${i}">⏭ Jump ahead to move ${Math.ceil(Math.max(1, j.ply) / 2)}</button>`)).join('')}</div>` : '';
  const label = opts.label ? `<div class="gm-label">${esc(opts.label)}</div>` : '';
  const star = data.entry_id
    ? `<button class="star${data.starred ? ' on' : ''}" title="Save to favourites in Lessons">${data.starred ? '★' : '☆'}</button>` : '';
  const msg = addMsg(opts.label ? 'coach gm' : 'coach',
    star + label + markdown(data.answer) + renderQuiz(data.quiz) + jumpBtn + buttons + tools, opts.where);
  msg.querySelectorAll('.demo-btn[data-i]').forEach((b) => { b.onclick = () => openDemo(demos[+b.dataset.i]); });
  msg.querySelectorAll('.jump-btn').forEach((b) => { b.onclick = () => jumpToPly(jumps[+b.dataset.j].ply); });
  if (auto) jumpToPly(auto.ply);
  msg.querySelectorAll('.quiz-opt').forEach((btn) => {
    const dest = moveDestination(btn.dataset.san);
    btn.onclick = () => {
      const box = btn.closest('.quiz');
      if (btn.dataset.san === box.dataset.correct) {
        btn.classList.add('correct');
        box.querySelectorAll('.quiz-opt').forEach((b) => { b.disabled = true; });
        const reward = box.querySelector('.quiz-reward');
        reward.textContent = box.dataset.reward;
        // a move quiz in a game review: point at how to keep going (the chip asks about the board as it is now)
        if (!state.play && !['True', 'False'].includes(box.dataset.correct)) {
          const next = document.createElement('div');
          next.className = 'quiz-next';
          next.textContent = 'Play it on the board, then press “Guess the next move” for the next one.';
          reward.appendChild(next);
        }
        reward.classList.remove('hidden');
      } else {
        btn.disabled = true;
        btn.classList.add('wrong');
      }
    };
    btn.onmouseenter = () => { previewMove(btn.dataset.san, true); if (dest) { hoverSquare = dest; paintSquares(); } };
    btn.onmouseleave = () => { previewMove(btn.dataset.san, false); hoverSquare = null; paintSquares(); };
  });
  const starBtn = msg.querySelector('.star');
  if (starBtn) {
    starBtn.onclick = async () => {
      const on = !starBtn.classList.contains('on');
      try {
        await api(`/api/library/${data.entry_id}/star`, { starred: on });
        starBtn.classList.toggle('on', on);
        starBtn.textContent = on ? '★' : '☆';
      } catch (e) { addMsg('error', esc(e.message)); }
    };
  }
  return msg;
}

// ---------------------------------------------------------------- the chat library

let libTag = null;

function openLibrary() {
  $('dlg-library').showModal();
  $('lib-q').focus();
  searchLibrary();
}

let libTimer = null;

async function searchLibrary() {
  const params = new URLSearchParams({ q: $('lib-q').value.trim() });
  if (libTag) params.set('tag', libTag);
  if ($('lib-starred').checked) params.set('starred', 'true');
  if ($('lib-habits').checked) params.set('habits', 'true');
  let res;
  try {
    res = await api(`/api/library?${params}`);
  } catch (e) {
    $('lib-list').innerHTML = `<p class="hint">${esc(e.message)}</p>`;
    return;
  }
  $('lib-tags').innerHTML = res.tags.map((t) =>
    `<button class="lib-tag${t.tag === libTag ? ' on' : ''}" data-tag="${esc(t.tag)}">${esc(t.tag)} <span>${t.count}</span></button>`).join('');
  $('lib-tags').querySelectorAll('.lib-tag').forEach((b) => {
    b.onclick = () => { libTag = libTag === b.dataset.tag ? null : b.dataset.tag; searchLibrary(); };
  });
  if (!res.entries.length) {
    $('lib-list').innerHTML = `<p class="hint">${res.tags.length ? 'Nothing matches.' : 'Nothing saved yet — every coach answer lands here automatically.'}</p>`;
    return;
  }
  $('lib-list').innerHTML = res.entries.map((e) => {
    const when = new Date(e.created_at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const where = [e.position_label, e.game_label].filter(Boolean).join(' · ');
    return `<div class="lib-entry" data-id="${e.id}">
      <div class="lib-top"><span class="lib-q">${e.starred ? '★ ' : ''}${esc(e.question)}</span>
        <button class="link lib-del" title="Delete from Lessons">🗑</button></div>
      <div class="lib-meta">${esc(where)}${where ? ' · ' : ''}${esc(when)}</div>
      ${e.habit ? `<div class="lib-habit">🧠 ${esc(e.habit)}</div>` : `<div class="lib-snippet">${esc(e.snippet)}</div>`}
      <div class="lib-etags">${e.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
    </div>`;
  }).join('');
  $('lib-list').querySelectorAll('.lib-entry').forEach((el) => {
    el.onclick = () => openEntry(+el.dataset.id);
    el.querySelector('.lib-del').onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('Delete this from Lessons?')) return;
      await api(`/api/library/${el.dataset.id}`, undefined, 'DELETE');
      searchLibrary();
    };
  });
}

async function openEntry(id) {
  const e = await api(`/api/library/${id}`);
  $('dlg-library').close();
  const when = new Date(e.created_at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  let review = null;
  if (e.game_id) {  // put the board back exactly where the answer was given
    try {
      review = await api('/api/saved/open', { game_id: e.game_id, me: state.me || null });
    } catch { /* game no longer saved: fall back to the position itself */ }
  }
  if (review) {
    setReview(review, `From Lessons (${when}).`);
    state.ply = Math.min(e.ply ?? 0, review.moves.length);
    state.extra = e.extra || [];
    update();
  } else {
    setReview(await api('/api/analysis', { fen: e.fen }), `From your library (${when}), on an analysis board of that position.`);
  }
  if (e.kind !== 'gm alert') addMsg('user', esc(e.question), e.position_label);
  renderAnswer({ answer: e.answer, tools: e.tools, demos: e.demos, jumps: e.jumps, entry_id: e.id, starred: e.starred },
    { label: e.kind === 'gm alert' ? e.question : null, where: e.kind === 'gm alert' ? e.position_label : null });
}

function renderChips() {
  // in a lesson's Learn mode the chips live on the move cards instead (studyCard)
  const chips = state.study?.mode === 'learn' ? [] : CHIPS[state.play ? 'play' : state.study ? 'study' : 'review']
    .filter(([, , needs]) => needs !== 'game' || (state.review && state.review.moves.length));
  $('chips').hidden = !chips.length;
  $('chips').innerHTML = chips.map(([label], i) =>
    `<button class="chip" data-i="${i}" data-tip="${esc(CHIP_TIPS[label] || '')}">${esc(label)}</button>`).join('');
  $('chips').querySelectorAll('.chip').forEach((el) => {
    const [, q, , action] = chips[+el.dataset.i];
    el.onclick = () => (action ? action() : ask(q, { hideQuestion: true }));
    // chips near the right edge would push the tooltip out of the (overflow: hidden) chat panel
    el.onmouseenter = () => el.classList.toggle('tip-right', el.getBoundingClientRect().left + 250 > $('chips').getBoundingClientRect().right);
  });
}

// "Game-changing moment": free and instant. The review already scored every move by how much win
// probability it cost, so jump to the biggest drop; the coach is only asked if you click Explain.
function gameChangingMoment() {
  const moves = state.review.moves.filter((m) => typeof m.win_pct_lost === 'number');
  if (!moves.length || state.play || state.editor) return;
  const m = moves.reduce((a, b) => (b.win_pct_lost > a.win_pct_lost ? b : a));
  const name = `${m.label}${m.label.endsWith('...') ? '' : ' '}${m.san}`;
  const side = m.color === state.review.player_color ? 'your' : m.color === 'white' ? "White's" : "Black's";
  const big = m.win_pct_lost >= 10;
  const text = big
    ? `Biggest swing: **${name}** (${side} move). It took the eval from ${m.eval_before} to ${m.eval_after}, `
      + `about ${Math.round(m.win_pct_lost)}% win chance lost in one move.`
    : `No single move decided this game. The biggest swing was **${name}** (${side} move), `
      + `${m.eval_before} to ${m.eval_after}, only about ${Math.round(m.win_pct_lost)}% win chance.`;
  jumpToPly(m.ply);
  const msg = addMsg('coach', `${markdown(text)}<div class="demos"><button class="demo-btn">Explain why</button></div>`);
  msg.querySelector('.demo-btn').onclick = () => ask(
    `Explain why ${name} was the biggest turning point of this game: what it did, and what should have been played instead. Keep it concise.`,
    { hideQuestion: true });
}

function resetChatUi(note) {
  $('chat-log').innerHTML = '';
  if (note) addMsg('system', esc(note));
}

// ---------------------------------------------------------------- loading games

function setReview(review, note, play = null, { keepChat = false } = {}) {
  closeDemo(false);
  state.replay = null;
  state.study = null;
  closeEditor(false);
  if (state.play && !play) setEngineVisible(recall('engineOn') !== '0');  // leaving a game
  state.play = play;
  opponentCommentCount = 0;
  openingNote = { family: null, key: null, count: 0 };
  openingBannerShown = false;
  $('opening-tag').classList.add('hidden');  // a new game names its own opening
  notedPlies.clear();
  bigMomentAsked.clear();
  state.review = review;
  renderChips();  // after state.review: some chips depend on whether a game is loaded
  state.ply = 0;  // every load starts from the beginning of the game
  state.extra = [];
  state.orientation = play ? play.color : (review.player_color || 'white');
  if (keepChat) { if (note) addMsg('system', esc(note)); } else resetChatUi(note);  // keepChat: lesson ↔ its play-out
  update();
}

async function loadGame(ref, me = state.me || null) {
  $('overlay').classList.remove('hidden');
  $('overlay-text').textContent = 'Fetching game…';
  try {
    await api('/api/load', { ref, me });
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      const job = await api('/api/job');
      if (job.status === 'running') {
        if (job.total) $('overlay-text').textContent = `Analysing position ${job.done} / ${job.total}`;
        continue;
      }
      if (job.status === 'error') throw new Error(job.error);
      const r = job.review;
      setReview(r, `Loaded ${r.white} vs ${r.black}. Click a move, or play your own on the board, then ask away.`);
      break;
    }
  } catch (e) {
    addMsg('error', `Couldn't load game: ${esc(e.message)}`);
  } finally {
    $('overlay').classList.add('hidden');
  }
}

function showGamesTab(tab) {
  $('games-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('tab-chesscom').classList.toggle('hidden', tab !== 'chesscom');
  $('tab-lichess').classList.toggle('hidden', tab !== 'lichess');
  $('tab-saved').classList.toggle('hidden', tab !== 'saved');
  $('tab-favorites').classList.toggle('hidden', tab !== 'favorites');
  if (tab === 'saved') showSaved();
  else if (tab === 'favorites') showFavorites();
  else if (tab === 'lichess') { if ($('games-user-lichess').value && !$('games-list-lichess').children.length) showGames('lichess'); }
  else if (state.me && !$('games-list').children.length) showGames();
}

async function showSaved() {
  const list = $('saved-list');
  list.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const games = await api('/api/saved');
    if (!games.length) {
      list.innerHTML = '<p class="hint">Nothing saved yet. Open a game (or use “Save my last 500 games”) while online.</p>';
      return;
    }
    const me = (state.me || '').toLowerCase();
    list.innerHTML = games.map((g) => {
      const meWhite = g.white.toLowerCase() === me, meBlack = g.black.toLowerCase() === me;
      const won = (g.result === '1-0' && meWhite) || (g.result === '0-1' && meBlack);
      const lost = (g.result === '1-0' && meBlack) || (g.result === '0-1' && meWhite);
      const res = !(meWhite || meBlack) ? esc(g.result) : won ? 'Won' : lost ? 'Lost' : g.result === '*' ? '–' : 'Draw';
      const when = new Date(g.saved_at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      return `<div class="game-row" data-id="${esc(g.game_id)}">
        <span class="who">${esc(g.white)}${g.white_elo ? ` (${esc(g.white_elo)})` : ''} – ${esc(g.black)}${g.black_elo ? ` (${esc(g.black_elo)})` : ''}</span>
        <span class="res ${won ? 'win' : lost ? 'loss' : ''}">${res}</span>
        <span class="meta">saved ${esc(when)} · ${esc(g.opening || '')}</span>
      </div>`;
    }).join('');
    list.querySelectorAll('.game-row').forEach((el) => {
      el.onclick = async () => {
        $('dlg-games').close();
        try {
          const r = await api('/api/saved/open', { game_id: el.dataset.id, me: state.me || null });
          setReview(r, `Opened ${r.white} vs ${r.black} from this Pi.`);
        } catch (e) {
          addMsg('error', esc(e.message));
        }
      };
    });
  } catch (e) {
    list.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
}

async function showFavorites() {
  const list = $('fav-list');
  list.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const favs = await api('/api/favorites');
    if (!favs.length) {
      list.innerHTML = '<p class="hint">No favourites yet. Open a game and click the ☆ next to the players’ names.</p>';
      return;
    }
    list.innerHTML = favs.map((g, i) => {
      const who = `${esc(g.white)}${g.white_elo ? ` (${esc(g.white_elo)})` : ''} – ${esc(g.black)}${g.black_elo ? ` (${esc(g.black_elo)})` : ''}`;
      const meta = [g.title ? who : null, g.date ? esc(g.date.replaceAll('.', '-')) : null, esc(g.opening || '')].filter(Boolean).join(' · ');
      return `<div class="game-row" data-i="${i}">
        <span class="who">★ ${g.title ? esc(g.title) : who}</span>
        <span class="res">${esc(g.result)}</span>
        <span class="meta">${meta}</span>
      </div>`;
    }).join('');
    list.querySelectorAll('.game-row').forEach((el) => {
      el.onclick = async () => {
        const g = favs[+el.dataset.i];
        $('dlg-games').close();
        try {
          const r = await api('/api/saved/open', { game_id: g.game_id, me: state.me || null });
          setReview(r, `Opened ${g.title || `${r.white} vs ${r.black}`} from your favourites.`);
        } catch {
          // the saved review is gone (data/reviews cleared): analyse it again from the stored PGN
          loadGame(g.pgn);
        }
      };
    });
  } catch (e) {
    list.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
}

let prefetchTimer = null;

function prefetchEls() {
  return {
    buttons: [$('games-prefetch'), $('games-prefetch-lichess')].filter(Boolean),
    statuses: [$('prefetch-status'), $('prefetch-status-lichess')].filter(Boolean),
  };
}

async function startPrefetch(site) {
  const userField = site === 'lichess' ? $('games-user-lichess') : $('games-user');
  const statusField = site === 'lichess' ? $('prefetch-status-lichess') : $('prefetch-status');
  const user = userField.value.trim() || (site === 'chesscom' ? state.me : '');
  if (!user) { statusField.textContent = `Enter your ${site === 'lichess' ? 'Lichess' : 'chess.com'} username first.`; return; }
  if (site === 'chesscom') { state.me = user; store('me', user); } else store('meLichess', user);
  try {
    await api('/api/prefetch', { user, n: 500, site });
  } catch (e) {
    statusField.textContent = e.message;
    return;
  }
  pollPrefetch();
}

async function pollPrefetch() {
  clearTimeout(prefetchTimer);
  let st;
  try { st = await api('/api/prefetch'); } catch { return; }
  const { buttons, statuses } = prefetchEls();
  buttons.forEach((b) => { b.disabled = st.status === 'running'; });
  let text = '';
  if (st.status === 'running') {
    text = st.total ? `Analysing game ${Math.min(st.done + 1, st.total)} of ${st.total}… (you can keep using the app)` : 'Fetching game list…';
    prefetchTimer = setTimeout(pollPrefetch, 1500);
  } else if (st.status === 'done') {
    text = `Done: ${st.total} games ready offline (${st.new} newly analysed).`;
  } else if (st.status === 'error') {
    text = st.error;
  }
  if (text) statuses.forEach((s) => { s.textContent = text; });
}

async function showGames(site = 'chesscom') {
  const lichess = site === 'lichess';
  const user = $(lichess ? 'games-user-lichess' : 'games-user').value.trim();
  if (!user) return;
  // state.me is the chess.com name (the app-wide "you"); the Lichess name is remembered on its own
  if (lichess) store('meLichess', user);
  else { state.me = user; store('me', user); }
  const list = $(lichess ? 'games-list-lichess' : 'games-list');
  list.innerHTML = '<p class="hint">Loading…</p>';
  const rating = (r) => (r ? ` (${r})` : '');  // Lichess AI / anonymous players have none
  try {
    const games = await api(`/api/games?site=${site}&user=${encodeURIComponent(user)}`);
    if (!games.length) { list.innerHTML = '<p class="hint">No recent games found.</p>'; return; }
    list.innerHTML = games.map((g) => {
      const meWhite = g.white.toLowerCase() === user.toLowerCase();
      const won = (g.result === '1-0' && meWhite) || (g.result === '0-1' && !meWhite);
      const lost = (g.result === '1-0' && !meWhite) || (g.result === '0-1' && meWhite);
      const when = g.end_time ? new Date(g.end_time * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      return `<div class="game-row" data-ref="${esc(g.ref)}">
        <span class="who">${esc(g.white)}${rating(g.white_rating)} – ${esc(g.black)}${rating(g.black_rating)}</span>
        <span class="res ${won ? 'win' : lost ? 'loss' : ''}">${won ? 'Won' : lost ? 'Lost' : 'Draw'} ${esc(g.result)}</span>
        <span class="meta">${esc(g.time_class || '')} · ${esc(when)} · ${esc(g.opening)}</span>
      </div>`;
    }).join('');
    list.querySelectorAll('.game-row').forEach((el) => {
      el.onclick = () => { $('dlg-games').close(); loadGame(el.dataset.ref, user); };
    });
  } catch (e) {
    list.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- "show me" demo board

let demoTimer = null;

function stopAutoplay() {
  clearInterval(demoTimer);
  demoTimer = null;
}

function openDemo(d) {
  stopAutoplay();
  state.demo = { ...d, moves: [...d.moves], notes: [...d.notes], step: 0, edited: false };
  update();
  // clicked from deep in the chat scroll, the board can be off-screen — bring it into view
  $('board').scrollIntoView({ behavior: 'smooth', block: 'center' });
  // play the line through once, one move every ~1.2s; any interaction stops it
  demoTimer = setInterval(() => {
    const cur = state.demo;
    if (!cur || cur.step >= cur.moves.length) return stopAutoplay();
    cur.step++;
    update();
  }, 1200);
}

function closeDemo(render = true) {
  stopAutoplay();
  if (!state.demo) return;
  state.demo = null;
  if (render) update();
}

function demoStep(step) {
  stopAutoplay();
  const d = state.demo;
  d.step = Math.max(0, Math.min(step, d.moves.length));
  update();
}

function demoPush(san) {
  stopAutoplay();
  const d = state.demo;
  if (d.moves[d.step] === san) {  // same as the coach's line: just step forward
    d.step++;
  } else {
    d.moves = [...d.moves.slice(0, d.step), san];
    d.notes = [...d.notes.slice(0, d.step), ''];
    d.step = d.moves.length;
    d.edited = true;
  }
  update();
}

function onDemoMove(orig, dest) {
  const c = currentGame();
  let mv;
  try {
    mv = c.move({ from: orig, to: dest, promotion: 'q' });
  } catch {
    update();
    return;
  }
  demoPush(mv.san);
}

function demoLabels(d) {
  const c = new Chess(d.start_fen);
  return d.moves.map((san) => {
    const label = c.turn() === 'w' ? `${c.moveNumber()}.` : `${c.moveNumber()}...`;
    c.move(san);
    return label;
  });
}

function renderDemoInfo() {
  const d = state.demo;
  $('player-top').innerHTML = `<span class="demo-tag">Demo board</span><span class="demo-sub">your game is paused</span>
    <button class="btn small" id="demo-exit-top">Back to my game</button>`;
  $('demo-exit-top').onclick = () => closeDemo();
  $('game-info').textContent = d.title;
  $('board-sub').textContent = d.edited ? 'Your own line from here: keep exploring, or ask the coach about it.' : 'The coach’s line. Step through it, or move pieces to try something else.';
  const note = d.step ? d.notes[d.step - 1] : '';
  $('summary').innerHTML = `<div class="play-buttons">
      <button class="btn ghost small" id="demo-replay">Replay</button>
    </div>${note ? `<div class="demo-note">${inline(note)}</div>` : ''}`;
  $('demo-replay').onclick = () => openDemo({ ...d, moves: d.moves, notes: d.notes });
}

function renderDemoMoves(box) {
  const d = state.demo;
  const labels = demoLabels(d);
  const rows = d.moves.map((san, i) => `<div class="demo-row${i + 1 === d.step ? ' active' : ''}" data-step="${i + 1}">
      <span class="num">${labels[i]}</span><span class="dm">${esc(san)}</span><span class="dn">${esc(d.notes[i] || '')}</span>
    </div>`).join('');
  box.innerHTML = `<div class="demo-row${d.step === 0 ? ' active' : ''}" data-step="0"><span class="num"></span><span class="dm">Start</span><span class="dn"></span></div>${rows}`;
  box.querySelectorAll('.demo-row').forEach((el) => { el.onclick = () => demoStep(+el.dataset.step); });
  box.querySelector('.demo-row.active')?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- position editor

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PRESETS = [
  ['Queen mate (K+Q vs K)', '8/8/8/4k3/8/8/8/1Q2K3 w - - 0 1'],
  ['Rook mate (K+R vs K)', '8/8/8/4k3/8/8/8/R3K3 w - - 0 1'],
  ['Two bishops mate', '8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1'],
  ['King + pawn vs king', '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'],
  ['King + pawn: key squares', '8/8/4k3/8/8/4K3/4P3/8 w - - 0 1'],
  ['Lucena (rook endgame, win)', '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1'],
  ['Philidor (rook endgame, draw)', '4k3/8/r7/4PK2/8/8/8/1R6 b - - 0 1'],
];
const PALETTE_ROLES = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];

function editorFen() {
  const pieces = cg.state.pieces;
  const letter = { king: 'k', queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: 'p' };
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = '', empty = 0;
    for (const file of 'abcdefgh') {
      const pc = pieces.get(file + rank);
      if (!pc) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += pc.color === 'white' ? letter[pc.role].toUpperCase() : letter[pc.role];
    }
    rows.push(row + (empty || ''));
  }
  // castling only where king and rook still stand on their home squares
  const is = (sq, role, color) => pieces.get(sq)?.role === role && pieces.get(sq)?.color === color;
  let castle = '';
  if (is('e1', 'king', 'white')) { if (is('h1', 'rook', 'white')) castle += 'K'; if (is('a1', 'rook', 'white')) castle += 'Q'; }
  if (is('e8', 'king', 'black')) { if (is('h8', 'rook', 'black')) castle += 'k'; if (is('a8', 'rook', 'black')) castle += 'q'; }
  return `${rows.join('/')} ${state.editor.turn[0]} ${castle || '-'} - 0 1`;
}

function editorProblem(fen) {
  const pieces = [...cg.state.pieces.values()];
  const kings = (color) => pieces.filter((pc) => pc.role === 'king' && pc.color === color).length;
  if (kings('white') !== 1 || kings('black') !== 1) return 'Each side needs exactly one king.';
  try { new Chess(fen); } catch (e) { return e.message.replace(/^Invalid FEN: /, ''); }
  return null;  // the server checks the rest (e.g. the side not to move in check)
}

function openEditor() {
  closeDemo(false);
  const c = state.review ? currentGame() : new Chess();
  state.editor = { tool: 'move', turn: c.turn() === 'w' ? 'white' : 'black' };
  cg.set({ fen: c.fen(), lastMove: undefined });
  buildEditorPanel();
  update();
  $('gp-toggle').click();  // the palette and presets live in the Moves & engine panel, closed by default
}

function closeEditor(render = true) {
  if (!state.editor) return;
  state.editor = null;
  document.body.classList.remove('editor-mode');
  cg.set({ selected: undefined });
  if (render) update();
}

function buildEditorPanel() {
  const img = pieceImages();
  const tools = ['white', 'black'].map((color) => `<div class="pal-row">${PALETTE_ROLES.map((role) =>
    `<button class="pal" data-tool="${color}-${role}" title="Place ${color} ${role}" style="background-image:${esc(img[`${color}-${role}`])}"></button>`).join('')}</div>`).join('');
  $('moves').innerHTML = `<div class="editor">
    <button class="btn ghost small" id="ed-preset-toggle">Endgame presets…</button>
    <label class="field hidden" id="ed-preset-field"><span class="label">Endgame presets</span>
      <select id="ed-preset"><option value="">Choose a position…</option>${PRESETS.map(([n, f]) => `<option value="${esc(f)}">${esc(n)}</option>`).join('')}</select></label>
    <div class="pal-tools">
      <button class="pal-mode" data-tool="move">✋ Move</button>
      <button class="pal-mode" data-tool="remove">🗑 Remove</button>
    </div>
    ${tools}
    <p class="hint">Pick a piece, then click squares to place it. Drag pieces to move them; drag one off the board to remove it.</p>
    <div class="field"><span class="label">Side to move</span>
      <div class="seg" id="ed-turn"><button data-turn="white">White</button><button data-turn="black">Black</button></div></div>
    <div class="play-buttons">
      <button class="btn ghost small" id="ed-clear">Clear</button>
      <button class="btn ghost small" id="ed-start">Starting position</button>
      <button class="btn ghost small" id="ed-kings">Kings only</button>
    </div>
    <label class="field"><span class="label">FEN</span><input id="ed-fen" spellcheck="false"></label>
  </div>`;
  $('moves').querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => { state.editor.tool = b.dataset.tool; cg.set({ selected: undefined }); updateEditor(); };
  });
  $('ed-turn').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.editor.turn = b.dataset.turn; updateEditor(); };
  });
  const load = (fen) => {
    const [placement, turn] = fen.split(' ');
    cg.set({ fen: placement });
    state.editor.turn = turn === 'b' ? 'black' : 'white';
    updateEditor();
  };
  $('ed-preset').onchange = (e) => { if (e.target.value) load(e.target.value); };
  $('ed-preset-toggle').onclick = () => {
    $('ed-preset-toggle').classList.add('hidden');
    $('ed-preset-field').classList.remove('hidden');
    $('ed-preset').focus();
  };
  $('ed-clear').onclick = () => load('8/8/8/8/8/8/8/8 w');
  $('ed-start').onclick = () => load(START_FEN);
  $('ed-kings').onclick = () => load('4k3/8/8/8/8/8/8/4K3 w');
  $('ed-fen').onkeydown = (e) => { if (e.key === 'Enter') load($('ed-fen').value.trim()); };
  // compare placement + side only: editorFen() fills in its own castling and counters, so a pasted FEN
  // never matches it whole, and reloading re-renders the buttons under the cursor (blur fires on
  // mousedown, so a click on Play/Analyse right after editing the FEN was lost)
  const core = (fen) => fen.split(/\s+/).slice(0, 2).join(' ');
  $('ed-fen').onblur = () => { const v = $('ed-fen').value.trim(); if (v && core(v) !== core(editorFen())) load(v); };
}

function onEditorSelect(key) {
  const ed = state.editor;
  if (!ed || ed.tool === 'move') return;
  if (ed.tool === 'remove') {
    cg.setPieces(new Map([[key, undefined]]));
  } else {
    const [color, role] = ed.tool.split('-');
    cg.setPieces(new Map([[key, { color, role }]]));
  }
  cg.set({ selected: undefined });
  updateEditor();
}

function updateEditor() {
  dockGamePanel(false);
  $('pb-takeback').classList.add('hidden');
  renderBoard();
  const ed = state.editor;
  const fen = editorFen();
  const problem = editorProblem(fen);
  $('moves').querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === ed.tool));
  $('ed-turn').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.turn === ed.turn));
  if (document.activeElement !== $('ed-fen')) $('ed-fen').value = fen;

  $('player-top').innerHTML = '<span class="demo-tag">Set-up board</span><span class="demo-sub">build any position, then play it or analyse it</span>';
  $('player-bottom').innerHTML = '';
  document.body.classList.remove('demo-mode');
  document.body.classList.add('editor-mode');
  syncGameTitle();
  $('game-info').textContent = '';  // the "Set-up board" tag above the board says it; a title here wrapped beside the buttons
  $('board-sub').textContent = 'Great for endgame practice: set it up, then play it out against the bot.';
  $('summary').innerHTML = `<div class="play-buttons">
      <button class="btn small" id="ed-play" ${problem ? 'disabled' : ''}>Play vs bot from here</button>
      <button class="btn ghost small" id="ed-analyse" ${problem ? 'disabled' : ''}>Analyse</button>
      <button class="btn ghost small" id="ed-save" ${problem ? 'disabled' : ''} title="Save this set-up to 📌 Positions">💾 Save</button>
      <button class="btn ghost small" id="ed-cancel">Cancel</button>
    </div><div class="ed-status ${problem ? 'bad' : ''}" id="ed-status">${esc(problem || 'Position OK')}</div>`;
  $('ed-play').onclick = () => { pendingFen = editorFen(); openPlayDialog(); };
  $('ed-analyse').onclick = analyseEditorPosition;
  $('ed-save').onclick = openSavePosition;
  $('ed-cancel').onclick = () => closeEditor();
  $('variation').classList.add('hidden');
  $('chat-context').textContent = 'Asking about: the set-up position (starts an analysis board)';

  requestMaia(null);  // no move history on a set-up position; the lines would be the old position's
  renderKeyCard();
  // live engine check: also catches positions the server refuses (e.g. side not to move in check)
  clearTimeout(evalTimer);
  const token = ++evalToken;
  if (problem) {
    $('engine-lines').innerHTML = '';
    return;
  }
  evalTimer = setTimeout(async () => {
    try {
      const data = await api('/api/eval', { fen, lines: 3 });
      if (token !== evalToken || !state.editor) return;
      if (state.engineOn) showEval(data);
    } catch (e) {
      if (token !== evalToken || !state.editor) return;
      $('ed-status').textContent = e.message;
      $('ed-status').classList.add('bad');
      $('ed-play').disabled = $('ed-analyse').disabled = $('ed-save').disabled = true;
      $('engine-lines').innerHTML = '';
    }
  }, 250);
}

async function analyseEditorPosition() {
  const fen = editorFen();
  try {
    const review = await api('/api/analysis', { fen });
    setReview(review, 'Analysis board from your set-up position. Move pieces and ask the coach anything.');
    return true;
  } catch (e) {
    $('ed-status').textContent = e.message;
    $('ed-status').classList.add('bad');
    return false;
  }
}

// ---------------------------------------------------------------- replay / branching off to the bot
// A loaded game is replayed from the side you pick: play your game moves (or step with the arrows),
// the opponent plays theirs. Play a different move and you're offered to play on from there against
// the bot ("best moves only"), which can bring you back to the game at the same move.

// The bot's levels are named like "Maia (~1400)"; pick the one closest to a rating. The one level
// without a rating ("Stockfish", or "Full strength" without Maia) is far stronger: only from 3000 up.
let botLevels = null;
async function levelForRating(elo) {
  botLevels ??= await api('/api/play/levels');
  const full = botLevels.find((l) => !/~\d+/.test(l.name));
  if (full && elo >= 3000) return full;
  const rated = botLevels.map((l) => ({ ...l, elo: +(l.name.match(/~(\d+)/)?.[1]) })).filter((l) => l.elo);
  return rated.reduce((a, b) => (Math.abs(b.elo - elo) < Math.abs(a.elo - elo) ? b : a));
}

// Which bot level takes over the opponent: the closest to the rating of the player it replaces. If
// that side is unrated, falls back to the rating of your side, then to the level last used in
// "Play a game", then ~1500 as a last resort.
async function botLevelFor(color) {
  const r = state.review;
  const oppColor = color === 'white' ? 'black' : 'white';
  for (const [side, whose] of [[oppColor, `${r[oppColor]}'s`], [color, `${r[color]}'s (your side)`]]) {
    const elo = parseInt(r[`${side}_elo`], 10);
    if (!(elo > 0)) continue;
    try { return { level: await levelForRating(elo), why: `matched to ${whose} ${elo} rating` }; } catch { /* try the next source */ }
  }
  botLevels ??= await api('/api/play/levels').catch(() => []);
  const last = botLevels.find((l) => String(l.id) === recall('botLevel'));
  if (last) return { level: last, why: "the level you last used, since the game has no ratings" };
  return { level: await levelForRating(1500), why: 'default, since the game has no ratings' };
}

// leave the replay for a live bot game from the current position, playing `first` (your move) at once.
// The game's moves so far are kept as the bot game's opening (`prefix`), so ◀ steps back through them
// and "Review this game" gets the whole game; takeback stops at the branch point.
async function branchToBot(first) {
  const r = state.review;
  const color = state.replay.color;
  const prefix = r.moves.slice(0, state.ply).map((m) => m.san);
  const origin = `${r.white} vs ${r.black}, ${positionLabel().replace(/^After/, 'after')}`;
  const back = { game_id: r.game_id, ply: state.ply, color };
  const { level, why } = await botLevelFor(color);
  playToken++;
  let review;
  try {
    review = await api('/api/play/new', { color, level: level.id, fen: r.start_fen, origin });
  } catch (e) {
    addMsg('error', esc(e.message));
    return;
  }
  const play = { color, level: level.id, levelName: level.name, startFen: review.start_fen,
    moves: prefix, prefix: prefix.length, view: prefix.length, over: null, thinking: false, back,
    myElo: parseInt(r[`${color}_elo`], 10) || undefined };  // the side you took over, if rated
  setEngineVisible(recall('engineOn') !== '0');
  setReview(review, `Playing on from ${origin} against a ${level.name} bot (${why}). You have ${color}.`, play);
  onPlayMove(first.orig, first.dest);
}

// the bot game's "Back to the game": reopen the saved review (no re-analysis) at the branch point
async function backToGame() {
  const back = state.play?.back;
  if (!back) return;
  playToken++;
  let review;
  try {
    review = await api('/api/saved/open', { game_id: back.game_id, me: state.me || null });
  } catch (e) {
    addMsg('error', esc(e.message));
    return;
  }
  setReview(review, `Back in ${review.white} vs ${review.black}.`);
  state.ply = back.ply;
  startReplay(back.color);
}

// starts paused: nothing plays (or costs anything) until you make a move or press ▶
async function startReplay(color) {
  if (state.review.player_color !== color) await setYou(color);  // the coach's "you" follows the side you replay
  closeDemo(false);
  state.replay = { color, hint: null, paused: true, deviation: null };
  state.orientation = color;
  opponentCommentCount = 0;
  openingNote = { family: null, key: null, count: 0 };
  addMsg('system', `Replaying as ${color === 'white' ? 'White' : 'Black'}: play your moves from the game (or step with ▶). `
    + "Play a different move to take the game your own way against the bot.");
  update();
}

function stopReplay() {
  state.replay = null;
  setEngineVisible(recall('engineOn') !== '0');
  update();
}

function replayNextMove() {
  return state.review.moves[state.ply];
}

function replayStep() {
  // play the opponent's recorded move, or wait for the player's
  const rp = state.replay;
  if (!rp) return;
  const next = replayNextMove();
  if (!next) { update(); return; }
  if (next.color !== rp.color) {
    // before the opponent's recorded move: did *they* have something special here?
    const started = Date.now();
    gmCheck(currentGame(), next, 'opponent').finally(() => {
      setTimeout(() => {
        if (state.replay !== rp) return;
        state.ply++;
        update();
        commentOnOpponentMove(currentGame(), next.san);
        replayStep();
      }, Math.max(300, 700 - (Date.now() - started)));
    });
  } else {
    gmCheck(currentGame(), next);
  }
}

// Stepping with the nav buttons / arrow keys pauses the replay: the opponent's move then waits for
// ▶ instead of a timer, otherwise stepping back past their move would bounce straight forward again.
// Swapping the object makes a pending opponent-move timer stand down. Playing your own move resumes.
function replayView(ply) {
  const target = Math.max(0, Math.min(ply, state.review.moves.length));
  if (target === state.ply) return;
  state.replay = { ...state.replay, hint: null, deviation: null, paused: true };
  state.ply = target;
  state.extra = [];
  cg.setAutoShapes([]);
  update();
}

function onReplayMove(orig, dest) {
  const rp = state.replay;
  const next = replayNextMove();
  if (next && next.uci.slice(0, 4) === orig + dest) {
    rp.hint = null;
    rp.deviation = null;
    rp.paused = false;
    state.ply++;
    update();
    replayStep();
    return;
  }
  rp.hint = next;
  if (next) {  // a different move: offer to play on against the bot from here
    const c = new Chess(currentGame().fen());
    try { rp.deviation = { orig, dest, san: c.move({ from: orig, to: dest, promotion: 'q' }).san }; } catch { rp.deviation = null; }
  }
  update();  // snaps the piece back
  if (next) cg.setAutoShapes([{ orig: next.uci.slice(0, 2), dest: next.uci.slice(2, 4), brush: 'blue' }]);
}

function renderReplayInfo() {
  const rp = state.replay;
  const next = replayNextMove();
  let status;
  if (!next) status = `End of the game (${state.review.result}).`;
  else if (rp.deviation) status = `In the game you played ${rp.hint.label} ${rp.hint.san} here (arrow). Play on with ${rp.deviation.san} against the bot instead?`;
  else if (rp.hint) status = `In the game you played ${rp.hint.label} ${rp.hint.san} here. Play it to continue (arrow on the board).`;
  else if (next.color === rp.color) status = 'Your move: play what you played in the game.';
  else if (rp.paused) status = "Paused: press ▶ (or →) to play your opponent's move.";
  else if (document.querySelector('.thinking')) status = 'Hold on, the coach spotted something before your opponent moves…';
  else status = 'Opponent is playing their game move…';
  const dev = rp.deviation;
  const buttons = dev
    ? `<button class="btn small" id="replay-branch">Play ${esc(dev.san)} vs bot</button>`
      + '<button class="btn ghost small" id="replay-undo">Take it back</button>'
    : '<button class="btn ghost small" id="replay-exit">Exit replay</button>';
  $('summary').innerHTML = `<div class="status">Replay · you play ${rp.color}</div>
    <div class="replay-status">${esc(status)}</div>
    <div class="play-buttons">${buttons}</div>`;
  $('replay-exit')?.addEventListener('click', stopReplay);
  $('replay-branch')?.addEventListener('click', () => branchToBot(dev));
  $('replay-undo')?.addEventListener('click', () => { rp.hint = rp.deviation = null; cg.setAutoShapes([]); update(); });
}

// ---------------------------------------------------------------- opening lessons
// A lesson is a tree built once on the server (core/study.py: master games + engine + the coach's
// notes) and saved, so walking and drilling it is free. It runs on the analysis board: the board is
// the start position plus `state.extra`, and `state.study.node` is the tree node those moves reach
// (null when you've played off the lesson). Learn: one move at a time — the next lesson move is an
// arrow on the board (all the opponent's tries where they have a choice) plus arrows for what the last
// move newly attacks, and you advance only by playing your lesson move yourself (no forward button);
// the opponent's reply plays itself after a pause, picked among their tries of similar value; cards
// explain each step. Drill: you play your side, the app answers with the opponent's tries
// weighted by how often masters play them, and a wrong move is caught with the right one and its note.

const studyShown = new Set();   // node ids whose card has been posted this session
const momentsSeen = new Set();  // "kind:index" of overview bullets already shown on the board this session

// overview bullets, each placed on the lesson positions where it applies (core/study.py tag_overview);
// lessons built before that have none, and show their overview whole as before
const MOMENT_KIND = {
  key_ideas: { cls: 'ideas', label: '💡 Idea' },
  pawn_breaks: { cls: 'breaks', label: '♟ Break' },
  wait_for: { cls: 'wait', label: '👀 Watch for' },
  common_mistakes: { cls: 'mistakes', label: '⚠ Avoid' },
};
const momentKey = (m) => `${m.kind}:${m.index}`;
const momentText = (m) => state.study.data.overview[m.kind][m.index];
const studyMoments = () => state.study.data.moments || [];

// the first idea on a move opens in full; any others are titles you click to open, so one move
// never turns into a wall of text
function momentCallout(m, contextId, open) {
  const k = MOMENT_KIND[m.kind];
  return `<details class="study-sec moment ${k.cls}"${open ? ' open' : ''}><summary class="study-sec-title">${k.label}: ${esc(m.title)}</summary>`
    + `<div class="moment-text">${lessonText(momentText(m), contextId)}</div></details>`;
}

// the start card's checklist: titles tick off as their moment comes up; seen ones open to the full text
function renderMomentChecklist() {
  const box = document.querySelector('.study-overview .moment-list');
  if (!box || !state.study) return;
  const ms = studyMoments();
  const wasOpen = box.querySelector('details.moment-all')?.open;
  box.innerHTML = `<details class="moment-all"${wasOpen ? ' open' : ''}><summary class="study-sec-title moment-count">Ideas you'll meet on the board · ${ms.filter((m) => momentsSeen.has(momentKey(m))).length}/${ms.length} seen</summary>`
    + ms.map((m) => {
      const seen = momentsSeen.has(momentKey(m));
      return `<details class="moment-item ${MOMENT_KIND[m.kind].cls}${seen ? ' seen' : ''}"${seen ? '' : ' data-locked'}>`
        + `<summary>${seen ? '✓' : '○'} ${esc(m.title)}</summary>${seen ? `<div class="moment-text">${lessonText(momentText(m), state.study.data.root)}</div>` : ''}</details>`;
    }).join('') + '</details>';
  box.querySelectorAll('details[data-locked]').forEach((d) => { d.querySelector('summary').onclick = (e) => e.preventDefault(); });
  wireLessonMoves(box);
}
let studyToken = 0;             // invalidates a pending drill reply

const studyNodes = () => state.study.data.nodes;
const studyMine = (fen) => fen.split(' ')[1] === state.study.data.color[0];

// arrows that belong to the position rather than to a hover: the Learn guide (empty elsewhere), plus
// the arrows you drew on it
function baseShapes() {
  return [...guideShapes(), ...drawnShapes()];
}

function guideShapes() {
  if (!state.study || state.demo) return [];
  if (state.study.curve) return curveShapes();
  return state.study.mode === 'learn' ? studyGuideShapes() : [];
}

// Learn: the square of the piece about to move (green for yours, blue for each of their tries)
function studyNextSquares() {
  if (!(state.study && state.study.mode === 'learn' && !state.demo)) return [];
  const id = studyNodeHere();
  if (id === null) return [];
  const n = studyNodes()[id];
  const mine = studyMine(n.fen);
  const kids = n.children;
  return kids.map((k) => [studyNodes()[k].uci.slice(0, 2), mine ? 'sq-next' : 'sq-next-opp']);
}

function studyGuideShapes() {
  const id = studyNodeHere();
  if (id === null) return [];
  const n = studyNodes()[id];
  const shapes = studyThreatShapes(n);
  const mineNext = studyMine(n.fen);
  // the lesson move solid; the opponent's other tries pale blue, your named alternatives pale green
  for (const k of n.children) {
    const u = studyNodes()[k].uci;
    shapes.push({ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: k === n.main ? (mineNext ? 'green' : 'blue') : (mineNext ? 'paleGreen' : 'paleBlue') });
  }
  return shapes;
}

// what the move into this node newly attacks: enemy pieces the mover hits now but didn't before
// (so discovered attacks count too), pawns only when undefended, checks included
function studyThreatShapes(n) {
  if (n.parent === null) return [];
  let before, after;
  try { before = new Chess(studyNodes()[n.parent].fen); after = new Chess(n.fen); } catch { return []; }
  const mover = before.turn();
  const enemy = after.turn();
  const opp = mover !== state.study.data.color[0];
  const shapes = [];
  for (const row of after.board()) {
    for (const p of row) {
      if (!p || p.color !== enemy) continue;
      if (p.type === 'p' && after.attackers(p.square, enemy).length) continue;
      const old = new Set(before.attackers(p.square, mover));
      for (const from of after.attackers(p.square, mover)) {
        if (old.has(from)) continue;
        const brush = p.type === 'k' ? (opp ? 'hvOppCheck' : 'hvCheck') : (opp ? 'hvOppCapture' : 'hvCapture');
        shapes.push(...(after.get(from).type === 'n' ? knightShapes(from, p.square, brush) : [{ orig: from, dest: p.square, brush }]));
      }
    }
  }
  return shapes;
}

function studyLine(id) {
  const out = [];
  for (let n = studyNodes()[id]; n.parent !== null; n = studyNodes()[n.parent]) out.push(n.san);
  return out.reverse();
}

// the tree node the board's moves reach, or null once they leave the lesson
function studyNodeHere() {
  let id = state.study.data.root;
  for (const san of state.extra) {
    id = studyNodes()[id].children.find((k) => studyNodes()[k].san === san);
    if (id === undefined) return null;
  }
  return id;
}

// the lines Drill can reach (and mastery counts): your main move only, all of the opponent's tries.
// A family lesson's alternatives for you (Scotch Gambit…) are explored in Learn, not drilled.
function studyLeaves(id = state.study.data.root) {
  const n = studyNodes()[id];
  if (!n.children.length) return [id];
  const kids = studyMine(n.fen) && n.main !== null ? [n.main] : n.children;
  return kids.flatMap((k) => studyLeaves(k));
}

// mastery per line (leaf id -> clean runs in a row), kept per device; 2 in a row = mastered
const MASTERED = 2;
function studyProgress() {
  try {
    const v = JSON.parse(localStorage.getItem(`study-m:${state.study.data.slug}`) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function studyRecord(leaf, clean) {
  const prog = studyProgress();
  prog[leaf] = clean ? (prog[leaf] || 0) + 1 : 0;
  try { localStorage.setItem(`study-m:${state.study.data.slug}`, JSON.stringify(prog)); } catch { /* per-device nicety */ }
  return prog[leaf];
}

const studyMasteredCount = () => {
  const prog = studyProgress();
  return studyLeaves().filter((l) => (prog[l] || 0) >= MASTERED).length;
};

function studyMoveName(id) {
  return plyName(studyLine(id).length, studyNodes()[id].san);  // plies from the start, so move numbers are plain
}
const plyName = (ply, san) => `${Math.ceil(ply / 2)}.${ply % 2 ? '' : '..'}${ply % 2 ? ' ' : ''}${san}`;

async function openStudyDialog() {
  $('study-status').textContent = '';
  $('study-q').value = '';
  $('dlg-study').showModal();
  await searchStudies('');
  $('study-q').focus();
}

let studyPick = null;
let studySearchToken = 0;
async function searchStudies(q) {
  const token = ++studySearchToken;
  let res;
  try { res = await api(`/api/study/openings?q=${encodeURIComponent(q)}`); } catch (e) { $('study-list').innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
  if (token !== studySearchToken) return;
  // one row per variation group; its sub-variations fold open under it (each still buildable on its own)
  const items = [];
  const row = (o, sub) => {
    const i = items.push(o) - 1;
    const tag = o.built ? '✓ built' : sub && o.in_lesson ? 'in this lesson' : '';
    return `<div class="game-row study-row${sub ? ' study-sub' : ''}${o.no_entry ? ' no-entry' : ''}" data-i="${i}">`
      + `<span class="who">${esc(sub ? o.short : o.name)}</span><span class="res">${tag}</span>`
      + `<span class="hint">${o.no_entry ? 'a group of variations, pick one below' : `${esc(o.eco)} · you play ${o.color === 'white' ? 'White' : 'Black'} · ${esc(numberedLine(o.moves))}`}</span></div>`;
  };
  $('study-list').innerHTML = res.openings.map((g) => {
    if (!g.subs.length) return row(g, false);
    const inLesson = g.subs.filter((x) => x.in_lesson).length;
    const open = g.no_entry || g.subs.length <= 2 || !!q.trim() && !g.name.toLowerCase().includes(q.trim().toLowerCase());
    return `<div class="study-group">${row(g, false)}`
      + `<button class="link study-subs-toggle">${open ? '▾' : '▸'} ${g.subs.length} variation${g.subs.length > 1 ? 's' : ''}${inLesson ? ` · ${inLesson} already in this lesson` : ''}</button>`
      + `<div class="study-subs"${open ? '' : ' hidden'}>${g.subs.map((x) => row(x, true)).join('')}</div></div>`;
  }).join('') || '<p class="hint">No opening by that name.</p>';
  $('study-list').querySelectorAll('.study-subs-toggle').forEach((b) => {
    b.onclick = () => {
      const box = b.nextElementSibling;
      box.hidden = !box.hidden;
      b.textContent = (box.hidden ? '▸' : '▾') + b.textContent.slice(1);
    };
  });
  $('study-list').querySelectorAll('.study-row').forEach((el) => {
    el.onclick = () => {
      const o = items[+el.dataset.i];
      if (o.no_entry) return;
      studyPick = o;
      $('study-list').querySelectorAll('.study-row').forEach((x) => x.classList.toggle('on', x === el));
      $('study-go').disabled = false;
      $('study-go').textContent = studyPick.built ? 'Start lesson' : 'Build lesson (a few minutes)';
    };
  });
}

function numberedLine(sans) {
  return sans.map((s, i) => (i % 2 ? s : `${i / 2 + 1}. ${s}`)).join(' ');
}

async function startStudyFromDialog() {
  if (!studyPick) return;
  const req = { name: studyPick.name };
  $('study-go').disabled = true;
  try {
    const job = await api('/api/study/build', req);
    const started = Date.now();
    while (job.status !== 'done') {
      await new Promise((r) => setTimeout(r, 1500));
      const j = await api('/api/study/job');
      if (j.status === 'error') throw new Error(j.error);
      const secs = Math.round((Date.now() - started) / 1000);
      $('study-status').textContent = `${j.message} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} so far (usually 4-6 minutes in all)`;
      if (j.status === 'done') break;
    }
    const { study, review } = await api('/api/study/start', req);
    $('dlg-study').close();
    startStudy(study, review);
  } catch (e) {
    $('study-status').textContent = e.message;
  } finally {
    $('study-go').disabled = false;
  }
}

// ---- lesson text: moves become buttons that play that spot of the lesson on the demo board,
// squares get the chat's hover highlight, opening names are italic, a lead phrase before ":" is bold

// a move token: "3...d5", "5.cxd5", "...b5", "Qc2", "O-O", or the long form "e2-e4" / "c4xd5".
// A bare pawn push ("d5") only counts as a move with a number or "..." in front; otherwise it's a square.
const LESSON_TOKEN_RE = new RegExp([
  String.raw`(\b[a-h][1-8][-x][a-h][1-8]\b)`,                                                   // 1 long form
  String.raw`((?:\b\d+\.(?:\.\.)?\s?|\.\.\.)(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?)`, // 2 numbered/dotted
  String.raw`(\bO-O(?:-O)?[+#]?|\b[KQRBN][a-h]?[1-8]?x?[a-h][1-8][+#]?|\b[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?)`, // 3 piece move / capture
  String.raw`(\b[a-h][1-8]\b)`,                                                                  // 4 square
  String.raw`(\b(?:(?:Open|Closed|Classical|Modern|Main|English|Yugoslav|Poisoned|Queen's|King's|Bogo|Nimzo|Old|Accelerated|Hyperaccelerated|Exchange|Advance)[ -])*(?:Catalan|Indian|Benoni|Gambit|Attack|Defen[cs]e|Variation|System|Sicilian|Dragon|Najdorf|Pawn|Opening|Structure)\b)`, // 5 name
].join('|'), 'g');

function studySanIndex() {
  const st = state.study;
  if (!st.bySan) {
    st.bySan = {};
    for (const n of Object.values(studyNodes())) {
      if (!n.san) continue;
      (st.bySan[n.san.replace(/[+#]$/, '')] ||= []).push(n.id);
    }
  }
  return st.bySan;
}

// the lesson node a mentioned move refers to: same move (and move number, if given), preferring the
// line the note belongs to, then the earliest occurrence
function studyFindMove(tok, contextId) {
  const nodes = studyNodes();
  let ids;
  let ply = null, blackOnly = false;
  const long = tok.match(/^([a-h][1-8])[-x]([a-h][1-8])$/);
  if (long) {
    ids = Object.values(nodes).filter((n) => n.uci && n.uci.slice(0, 4) === long[1] + long[2]).map((n) => n.id);
  } else {
    const m = tok.match(/^(?:(\d+)\.(\.\.)?\s?|(\.\.\.))?(.+?)[+#]?$/);
    if (m[1]) ply = m[2] ? 2 * +m[1] : 2 * +m[1] - 1;
    blackOnly = !!m[3];
    ids = studySanIndex()[m[4]] || [];
  }
  const depth = (id) => studyLine(id).length;
  ids = ids.filter((id) => (ply === null || depth(id) === ply) && (!blackOnly || depth(id) % 2 === 0));
  if (!ids.length) return null;
  const related = new Set();
  if (contextId !== null && contextId !== undefined) {
    for (let k = contextId; k !== null; k = nodes[k].parent) related.add(k);
    const todo = [...nodes[contextId].children];
    while (todo.length) { const k = todo.pop(); related.add(k); todo.push(...nodes[k].children); }
  }
  ids.sort((a, b) => (related.has(b) - related.has(a)) || (depth(a) - depth(b)));
  return ids[0];
}

function lessonInline(text, contextId) {
  let out = '', last = 0;
  for (const m of text.matchAll(LESSON_TOKEN_RE)) {
    out += esc(text.slice(last, m.index));
    last = m.index + m[0].length;
    const tok = m[0];
    if (m[1] || m[2] || m[3]) {
      const id = studyFindMove(tok.trim(), contextId);
      out += id !== null
        ? `<button class="lm" data-node="${id}" title="Show ${esc(studyMoveName(id))} on the demo board">${esc(tok)}</button>`
        : `<b class="lm-off">${esc(tok)}</b>`;
    } else if (m[4]) {
      out += `<span class="sq" data-sq="${tok}">${tok}</span>`;
    } else {
      out += `<em class="lm-name">${esc(tok)}</em>`;
    }
  }
  return out + esc(text.slice(last));
}

// a list item or note: the phrase before the first ": " is its headline
function lessonText(text, contextId) {
  const lead = text.match(/^([^:]{3,90}?):\s(.*)$/s);
  return lead ? `<b class="lm-lead">${lessonInline(lead[1], contextId)}:</b> ${lessonInline(lead[2], contextId)}` : lessonInline(text, contextId);
}

// play the lesson up to a node on the demo board, with the lesson's notes as the demo's per-move notes.
// It starts from the board you're looking at (or, on another branch, where the two lines split) and
// steps forward one move at a time, instead of jumping from the start
const LESSON_STEP_MS = 650;
function studyShowNode(id) {
  const line = studyLine(id);
  const ids = [];
  for (let k = id; studyNodes()[k].parent !== null; k = studyNodes()[k].parent) ids.unshift(k);
  const here = state.demo ? [] : state.extra;
  let from = 0;
  while (from < line.length && from < here.length && line[from] === here[from]) from++;
  from = Math.min(from, line.length - 1);  // at least the move itself is played
  openDemo({ title: `Lesson: ${studyMoveName(id)}`, start_fen: START_FEN, moves: line,
    notes: ids.map((k) => studyNodes()[k].note || ''), ply: 1, then_moves: [] });
  stopAutoplay();  // openDemo's own autoplay starts from move 1
  state.demo.step = from;
  update();
  const d = state.demo;
  demoTimer = setInterval(() => {
    if (state.demo !== d || d.step >= line.length) return stopAutoplay();
    d.step++;
    update();
  }, LESSON_STEP_MS);
}

function wireLessonMoves(root) {
  root.querySelectorAll('.lm[data-node]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); if (state.study) studyShowNode(b.dataset.node); };
    // the move that's playable on your board right now: hovering shows its arrow
    b.onmouseenter = () => {
      const n = state.study && !state.demo && studyNodes()[b.dataset.node];
      if (n && n.parent === studyNodeHere()) cg.setAutoShapes([...baseShapes(), { orig: n.uci.slice(0, 2), dest: n.uci.slice(2, 4), brush: 'yellow' }]);
    };
    b.onmouseleave = () => { if (state.study && !state.demo) cg.setAutoShapes(baseShapes()); };
  });
}

function startStudy(study, review) {
  setReview(review, null);
  state.study = { data: study, mode: 'learn', node: study.root, waiting: false, mistakes: 0 };
  state.orientation = study.color;
  studyShown.clear();
  renderChips();
  const o = study.overview;
  const list = (kind, title, items) => items.length
    ? `<div class="study-sec ${kind}"><div class="study-sec-title">${title}</div><ul>${items.map((x) => `<li>${lessonText(x, study.root)}</li>`).join('')}</ul></div>` : '';
  momentsSeen.clear();
  // with moments, the start card is just the summary + a checklist; each idea shows up on the board
  // when its position comes up. Older lessons (no moments) keep the whole overview here.
  const body = study.moments?.length
    ? '<div class="moment-list"></div>'
    : `${list('ideas', '💡 Key ideas', o.key_ideas)}${list('breaks', '♟ Pawn breaks', o.pawn_breaks)}`
      + `${list('wait', '👀 Wait for', o.wait_for)}${list('mistakes', '⚠ Mistakes', o.common_mistakes)}`
      + '<div class="card-hint">Click any move to see it on the demo board.</div>';
  const msg = addMsg('coach card study-card study-overview', `<div class="card-head"><b>${esc(study.name)}</b><span class="card-sub">you play ${esc(study.color)} · ${studyLeaves().length} lines</span><span class="card-caret">▾</span></div>`
    + `<div class="card-body"><div class="study-summary">${lessonInline(o.summary, study.root)}</div>${body}`
    + '<div class="card-row card-actions"><button class="btn ghost small" data-go="drill">Drill me</button></div></div>');
  msg.querySelector('.card-head').onclick = () => msg.classList.toggle('collapsed');
  wireLessonMoves(msg);
  renderMomentChecklist();
  msg.querySelector('[data-go=drill]').onclick = () => setStudyMode('drill');
  update();
  studyLearnStep();  // the lesson opens in Learn: as Black, White's first move plays itself
}

function setStudyMode(mode) {
  const st = state.study;
  if (!st) return;
  studyToken++;
  closeDemo(false);
  st.mode = mode;
  renderChips();
  st.waiting = false;
  st.curve = null;
  st.curveUsed = false;
  st.mistakes = 0;
  st.hint = null;
  st.missAt = null;
  if (mode === 'drill') {
    addMsg('system', `Drill: play the ${st.data.color} moves of the lesson. I'll answer with the replies masters play, picked by how often they play them.`);
    studyGo(st.data.root, { quiet: true });
  } else {
    studyGo(st.data.root);
  }
}

function studyGo(id, { quiet = false } = {}) {
  const st = state.study;
  studyToken++;  // a reply still pending for the position we're leaving must not land here
  st.waiting = false;
  st.curve = null;
  if (id === st.data.root) st.curveUsed = false;  // one curveball per run through a line
  st.node = id;
  st.hint = null;
  state.extra = studyLine(id);
  update();
  if (!quiet) studyCard(id);
  if (st.mode === 'drill') studyDrillStep(); else studyLearnStep();
  // Learn: when the theory runs out, the game carries on against a bot (after a moment to read the card)
  if (st.mode === 'learn' && !studyNodes()[id].children.length && st.noPlayOn !== id) {
    const token = studyToken;
    setTimeout(() => { if (token === studyToken && state.study === st && st.node === id && !state.demo) studyPlayOn(id); }, PLAY_ON_DELAY_MS);
  }
}

// ---- playing on after the theory: a bot game from the lesson position, chat kept, with a way back
const PLAY_ON_DELAY_MS = 1500;
const PLAY_ON_ELO = [1500, 2000];  // the bot is picked at random from the levels in this range

async function studyPlayOn(id) {
  const st = state.study;
  const line = studyLine(id);
  const color = st.data.color;
  botLevels ??= await api('/api/play/levels').catch(() => []);
  const pool = botLevels.map((l) => ({ ...l, elo: +(l.name.match(/~(\d+)/)?.[1]) }))
    .filter((l) => l.elo >= PLAY_ON_ELO[0] && l.elo <= PLAY_ON_ELO[1]);
  const level = pool.length ? pool[Math.floor(Math.random() * pool.length)] : await levelForRating(1500);
  if (state.study !== st) return;
  playToken++;
  let review;
  try {
    review = await api('/api/play/new', { color, level: level.id, lesson: st.data.name });
  } catch (e) {
    addMsg('error', esc(e.message));
    return;
  }
  const play = { color, level: level.id, levelName: level.name, startFen: review.start_fen,
    moves: line, prefix: line.length, view: line.length, over: null, thinking: false, backLesson: { study: st, at: id } };
  setEngineVisible(recall('engineOn') !== '0');
  setReview(review, `That's the end of the lesson's theory. Play it out against a ${level.name} bot; you have ${color}. "Back to the lesson" returns you here.`, play, { keepChat: true });
  if ((line.length % 2 ? 'black' : 'white') !== color) botMove();  // the line ended on your move: the bot replies
}

async function backToLesson() {
  const bl = state.play?.backLesson;
  if (!bl) return;
  playToken++;
  let res;
  try {
    res = await api('/api/study/start', { name: bl.study.data.name });
  } catch (e) {
    addMsg('error', esc(e.message));
    return;
  }
  setReview(res.review, 'Back in the lesson, where its theory ended. ◀ to explore other lines.', null, { keepChat: true });
  state.study = bl.study;
  state.study.noPlayOn = bl.at;  // don't bounce straight back into a game from the same spot
  state.orientation = bl.study.data.color;
  renderChips();
  studyGo(bl.at);
}

// Learn: on the opponent's turn, leave their arrows up for a moment, then play one of their tries,
// picked by how often masters play it (so replaying a line with ◀ can show another), or now and then
// a curveball (studyCurveball)
const LEARN_PAUSE_MS = 1000;

// How likely a player at your rating is to play this lesson move (node.maia on the parent, from
// core/study.py add_human), or null for a lesson without it. Human-branch moves carry their own pct.
function studyHumanPct(kidId) {
  const k = studyNodes()[kidId];
  const p = studyNodes()[k.parent];
  const g = p.maia?.find((m) => m.uci === k.uci);
  return g ? g.pct : k.pct ?? null;
}
// The opponent's reply is picked the way a human at your rating would choose it; lessons without Maia
// data fall back to master share. A lesson move outside Maia's top 5 still gets a small chance.
function studyReplyWeight(kidId) {
  const pct = studyHumanPct(kidId);
  if (pct != null) return Math.max(0.5, pct);
  return studyNodes()[studyNodes()[kidId].parent].maia ? 0.5 : Math.max(1, studyNodes()[kidId].share || 1);
}

function weightedPick(items, weights) {
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[0];
}
function studyLearnStep() {
  const st = state.study;
  const n = studyNodes()[st.node];
  if (!n.children.length || studyMine(n.fen)) return;
  const token = ++studyToken;
  st.waiting = true;
  update();
  setTimeout(() => {
    if (token !== studyToken || state.study !== st || st.mode !== 'learn') return;
    st.waiting = false;
    const cb = studyCurveball(n);
    if (cb) return studyThrowCurve(n, cb);
    studyGo(weightedPick(n.children, n.children.map(studyReplyWeight)));
  }, LEARN_PAUSE_MS);
}

// ---- curveballs: now and then the opponent leaves the lesson with a mistake club players really make
// (node.curveballs, from core/study.py add_curveballs) and you have to find the punishment, with no arrow.
// At most one per run through a line, never on their first move; ◀ or "Back to the lesson" resumes.
const CURVE_CHANCE = 0.3;  // per opponent move that has one (only a few positions do)

function studyCurveball(n) {
  const st = state.study;
  if (!n.curveballs?.length || st.curveUsed || studyLine(n.id).length < 2 || Math.random() >= CURVE_CHANCE) return null;
  return n.curveballs[Math.floor(Math.random() * n.curveballs.length)];
}

function studyThrowCurve(n, cb) {
  const st = state.study;
  const ply = studyLine(n.id).length + 1;
  st.curve = { at: n.id, cb, name: plyName(ply, cb.san), misses: 0, solved: false };
  st.curveUsed = true;
  state.extra = [...studyLine(n.id), cb.san];
  update();
  addMsg('coach card study-card curve-card', `<div class="card-head"><b>⚡ Curveball: ${esc(st.curve.name)}</b>`
    + `<span class="card-sub">not in the lesson · ${cb.games != null ? `played in ${cb.games.toLocaleString()} club games`
      : `played by ~${Math.round(cb.pct)}% of ~${state.study.data.human_rating} players`}</span></div>`
    + '<div class="card-body"><div class="card-row">They left the lesson with a mistake. Find the move that punishes it.</div></div>');
}

function curveShapes() {
  const cv = state.study.curve;
  if (cv.solved || !cv.misses) return [];
  const u = cv.cb.punish[0].uci;
  return cv.misses === 1 ? [{ orig: u.slice(0, 2), brush: 'yellow' }] : [{ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: 'blue' }];
}

function studyCurveAnswer(mv) {
  const st = state.study;
  const cv = st.curve;
  if (cv.solved) return update();
  const uci = mv.from + mv.to + (mv.promotion && mv.piece === 'p' && /[18]$/.test(mv.to) ? mv.promotion : '');
  const hit = cv.cb.punish.find((p) => p.uci === uci);
  if (!hit) {
    cv.misses++;
    update();  // snaps back; curveShapes now hints (the piece first, then the move)
    addMsg('system', cv.misses === 1
      ? `Not ${mv.san}: ${cv.cb.san} can be punished. Look at the circled piece.`
      : `Not ${mv.san}. The arrow shows it: ${cv.cb.punish[0].san}.`);
    return;
  }
  cv.solved = true;
  const before = [...state.extra];
  state.extra.push(mv.san);
  update();
  const replyName = plyName(before.length + 1, hit.san);
  const msg = addMsg('coach card study-card curve-card', `<div class="card-head"><b>${cv.misses ? '' : '✓ '}${esc(replyName)} punishes ${esc(cv.name)}</b>${evalPill(hit.eval_white)}</div>`
    + `<div class="card-body"><div class="card-row card-sub">${esc(cv.cb.line)}</div>`
    + '<div class="card-row card-actions"><button class="demo-btn" data-line>▶ Show the line</button>'
    + '<button class="demo-btn" data-why>Why?</button><button class="btn small" data-back>Back to the lesson</button></div></div>');
  msg.querySelector('[data-line]').onclick = () => {
    const g = new Chess();
    before.forEach((san) => g.move(san));
    const fen = g.fen();
    const moves = cv.cb.pv.map((u) => g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
    openDemo({ title: `Punishing ${cv.name}`, start_fen: fen, moves, notes: moves.map(() => ''), ply: 1, then_moves: [] });
  };
  msg.querySelector('[data-why]').onclick = () => ask(`In this lesson the opponent played ${cv.name}, which isn't a lesson move. Why is it a mistake, and how does ${replyName} punish it?`);
  msg.querySelector('[data-back]').onclick = () => { if (state.study === st && st.curve === cv) { closeDemo(false); studyGo(cv.at); } };
}

// nav buttons: back/start move along the lesson (or undo off-lesson moves); forward follows the main line
function studyGoTo(n) {
  const st = state.study;
  if (st.curve) return studyGo(st.curve.at);  // ◀ out of a curveball = back into the lesson where it left
  studyToken++;
  st.waiting = false;
  let target = Math.max(0, Math.min(n, state.extra.length));
  // step back to your own move: landing on theirs would just replay their answer
  if (target > 0 && (target % 2 === 0) !== (st.data.color === 'white')) target--;
  state.extra = state.extra.slice(0, target);
  const id = studyNodeHere();
  if (id !== null) { st.node = id; st.hint = null; update(); if (st.mode === 'drill') studyDrillStep(); else studyLearnStep(); } else update();
}

// no skipping ahead in a lesson: Learn advances by playing the arrowed move, Drill by finding it
function studyForward() {}
function studyEnd() {}

function onStudyMove(orig, dest) {
  const st = state.study;
  const c = currentGame();
  let mv;
  try { mv = c.move({ from: orig, to: dest, promotion: 'q' }); } catch { update(); return; }
  if (st.curve) return studyCurveAnswer(mv);
  const here = studyNodeHere();
  const child = here === null ? undefined : studyNodes()[here].children.find((k) => studyNodes()[k].san === mv.san);
  if (st.mode === 'learn') {
    if (child !== undefined) return studyGo(child);  // the arrowed move, or another of the opponent's tries
    update();  // anything else snaps back: the lesson is learned by playing its own moves
    if (here !== null && st.nudged !== here) {
      st.nudged = here;
      addMsg('system', `Not ${mv.san}: play the arrowed move. Ask the coach if you want to know about ${mv.san}.`);
    }
    return;
  }
  // drill: only your side's moves reach here (canMove)
  if (child !== undefined && studyNodes()[here].main === child) {
    st.hint = null;
    st.missAt = null;
    return studyGo(child);
  }
  const right = studyNodes()[here].main;
  const n = studyNodes()[right];
  if (st.missAt !== here) st.mistakes++;  // one mistake per position, however many tries
  const first = st.missAt !== here;
  st.missAt = here;
  st.hint = right;
  update();  // snaps the piece back
  if (first) {
    // first miss: only point at the piece that moves; the answer comes on the second miss
    cg.setAutoShapes([{ orig: n.uci.slice(0, 2), brush: 'yellow' }]);
    addMsg('system', `Not ${mv.san}. Try again: the circled piece moves.`);
    return;
  }
  cg.setAutoShapes([{ orig: n.uci.slice(0, 2), dest: n.uci.slice(2, 4), brush: 'blue' }]);
  const alt = (studyNodes()[here].alternatives || []).includes(mv.san)
    ? ` ${mv.san} is also played by masters, but this lesson plays ${n.san}.` : '';
  const miss = addMsg('coach card study-card', `<div class="card-head"><b>Not ${esc(mv.san)}: the lesson plays ${esc(studyMoveName(right))}</b></div>`
    + `<div class="card-body">${n.note ? `<div class="card-row study-note">${lessonText(n.note, right)}</div>` : ''}${alt ? `<div class="card-row card-sub">${esc(alt.trim())}</div>` : ''}</div>`);
  wireLessonMoves(miss);
}

function studyDrillStep() {
  const st = state.study;
  const id = st.node;
  const n = studyNodes()[id];
  if (!n.children.length) return studyLineDone(id);
  if (studyMine(n.fen)) return;  // your move
  const token = ++studyToken;
  st.waiting = true;
  update();
  setTimeout(() => {
    if (token !== studyToken || state.study !== st || st.mode !== 'drill') return;
    // the opponent's tries, weighted by how often players at your rating play them (studyReplyWeight)
    // ...and steered toward lines you haven't mastered yet
    const prog = studyProgress();
    const kids = n.children.map((k) => studyNodes()[k]);
    const weights = kids.map((k) => {
      const open = studyLeaves(k.id).filter((l) => (prog[l] || 0) < MASTERED).length;
      return studyReplyWeight(k.id) * (open ? 1 + open : 0.15);
    });
    st.waiting = false;
    const cb = studyCurveball(n);
    if (cb) return studyThrowCurve(n, cb);
    studyGo(weightedPick(kids, weights).id);
  }, 650);
}

function studyLineDone(leaf) {
  const st = state.study;
  const streak = studyRecord(leaf, !st.mistakes);
  const status = st.mistakes ? `${st.mistakes} mistake${st.mistakes > 1 ? 's' : ''}, so this line starts over`
    : streak >= MASTERED ? 'no mistakes · mastered' : `no mistakes · ${MASTERED - streak} more clean run to master it`;
  const msg = addMsg('coach card study-card', `<div class="card-head"><b>Line complete ✓</b><span class="card-sub">${status} · ${studyMasteredCount()}/${studyLeaves().length} lines mastered</span></div>`
    + '<div class="card-body"><div class="card-row card-actions"><button class="btn small" data-again>Drill again</button><button class="btn ghost small" data-learn>Learn this line</button><button class="btn ghost small" data-playon>Play it out vs a bot</button></div></div>');
  msg.querySelector('[data-playon]').onclick = () => { if (state.study === st && st.node === leaf) studyPlayOn(leaf); };
  msg.querySelector('[data-again]').onclick = () => setStudyMode('drill');
  msg.querySelector('[data-learn]').onclick = () => { st.mode = 'learn'; renderChips(); studyShown.clear(); studyGo(st.data.root); };
  st.mistakes = 0;
  update();
}

// the named variation a move leads into, for labels on choices: its own position's name, or the first
// name a few moves down its main line (named positions are often a move or two past the choice)
function studyVariationOf(id) {
  const lesson = state.study.data.name;
  let k = id;
  for (let i = 0; i < 4 && k !== null; i++, k = studyNodes()[k].main) {
    const o = studyNodes()[k].opening;
    if (o && o !== lesson) return o.startsWith(lesson + ', ') || o.startsWith(lesson + ': ') ? o.slice(lesson.length + 2) : o;
  }
  return '';
}

// the variation this move enters, when the opening table names this exact position and the name is
// new on this line (load() fills node.opening): "Yugoslav Attack, Main Line" inside the Dragon lesson
function studyOpeningName(id) {
  const n = studyNodes()[id];
  if (!n.opening) return '';
  for (let k = n.parent; k !== null; k = studyNodes()[k].parent) {
    if (studyNodes()[k].opening) { if (studyNodes()[k].opening === n.opening) return ''; break; }
  }
  const lesson = state.study.data.name;
  if (n.opening.startsWith(lesson + ', ') || n.opening.startsWith(lesson + ': ')) return n.opening.slice(lesson.length + 2);
  // before the lesson's own position the general names ("Sicilian Defense") are just noise; after it, a
  // name from outside the lesson means the line transposed into another opening
  return n.trunk || n.opening === lesson ? '' : n.opening;
}

// a card for the node you just reached: its note, then your move to find or the opponent's tries
function studyCard(id) {
  const st = state.study;
  const n = studyNodes()[id];
  if (studyShown.has(id) || n.parent === null) return;
  const mine = studyMine(n.fen);  // after this move, is it your turn?
  const rows = [];
  if (n.note) rows.push(`<div class="card-row study-note">${lessonText(n.note, id)}</div>`);
  if (st.mode === 'learn' && n.children.length) {
    // moves are named, not buttons: you play them on the board, following the arrow
    if (mine && n.main !== null) {
      const alts = n.children.filter((k) => k !== n.main);
      rows.push(`<div class="card-row"><span class="card-k">Your move</span><b>${esc(studyMoveName(n.main))}</b>`
        + (alts.length ? `<span class="card-sub">or explore: ${alts.map((k) => `${esc(studyMoveName(k))}${studyVariationOf(k) ? ` (${esc(studyVariationOf(k))})` : ''}`).join(' · ')}</span>`
          : n.alternatives?.length ? `<span class="card-sub">also played: ${esc(n.alternatives.join(', '))}</span>` : '') + '</div>');
    } else if (!mine) {
      // their tries are buttons: pick one to see that sideline (otherwise they choose by popularity)
      rows.push(`<div class="card-row"><span class="card-k">${n.children.length > 1 ? 'Their tries' : 'They play'}</span>`
        + n.children.map((k) => n.children.length > 1
          ? `<button class="demo-btn study-try" data-try="${k}">${esc(studyNodes()[k].san)}${studyTryLabel(k)}</button>`
          : `<b>${esc(studyNodes()[k].san)}</b>`).join(' ')
        + (n.children.length > 1 ? `<span class="card-sub">${n.maia ? `% = how often ~${st.data.human_rating} players play it · ` : ''}click one to see it, or let them choose</span>` : '') + '</div>');
    }
  }
  if (st.mode === 'learn') {
    // the overview bullets that belong to this position, each shown once per session
    const here = studyMoments().filter((m) => m.nodes.includes(id) && !momentsSeen.has(momentKey(m)));
    here.forEach((m, i) => { momentsSeen.add(momentKey(m)); rows.push(momentCallout(m, id, i === 0)); });
    if (here.length) renderMomentChecklist();
    if (!n.children.length && studyMoments().length) {
      // end of a line: the ideas this line went through, and any that belong to no single position
      const path = new Set();
      for (let k = id; k !== null; k = studyNodes()[k].parent) path.add(k);
      const along = studyMoments().filter((m) => m.nodes.some((k) => path.has(k)));
      const general = studyMoments().filter((m) => !m.nodes.length);
      if (along.length || general.length) {
        rows.push(`<div class="study-sec moment recap"><div class="study-sec-title">Your plan from here</div>`
          + (along.length ? `<ul>${along.map((m) => `<li>${MOMENT_KIND[m.kind].label.split(' ')[0]} ${esc(m.title)}</li>`).join('')}</ul>` : '')
          + general.map((m) => `<div class="moment-text">${lessonText(momentText(m), id)}</div>`).join('') + '</div>');
        general.forEach((m) => momentsSeen.add(momentKey(m)));
        renderMomentChecklist();
      }
    }
  }
  // the coach buttons sit on the card for the position you're asked about (your move, or a line's end),
  // shown only while the board is on that position (syncCards)
  if (st.mode === 'learn' && (mine || !n.children.length)) {
    rows.push(`<div class="card-row card-chips">${CHIPS.study.map(([label], i) =>
      `<button class="chip study-chip" data-i="${i}" data-node="${id}" data-tip="${esc(CHIP_TIPS[label] || '')}">${esc(label)}</button>`).join('')}</div>`);
  }
  if (!rows.length) return;
  studyShown.add(id);
  // earlier cards stay open (they're worth rereading); each still folds by clicking its header
  const pill = n.eval_white ? evalPill(n.eval_white) : '';
  const named = studyOpeningName(id);
  const msg = addMsg('coach card study-card', `<div class="card-head"><b>${esc(studyMoveName(id))}</b>${pill}${named ? `<span class="card-open">${esc(named)}</span>` : ''}<span class="card-sub">${studyCardSub(id)}</span><span class="card-caret">▾</span></div>`
    + `<div class="card-body">${rows.join('')}</div>`);
  msg.querySelector('.card-head').onclick = () => msg.classList.toggle('collapsed');
  wireLessonMoves(msg);
  msg.querySelectorAll('.study-try').forEach((b) => {
    // works during their pause, or right after their reply (swaps it for this one)
    b.onclick = () => {
      const here = state.study === st && !state.demo ? studyNodeHere() : null;
      if (here !== null && (here === id || studyNodes()[here].parent === id)) studyGo(b.dataset.try);
    };
  });
  msg.querySelectorAll('.study-chip').forEach((b) => {
    const [, q, , action] = CHIPS.study[+b.dataset.i];
    b.onclick = () => { if (studyChipLive(b)) (action ? action() : ask(q, { hideQuestion: true })); };
  });
  syncCards();
}

function studyTryLabel(k) {
  const pct = studyHumanPct(k);
  const n = studyNodes()[k];
  if (pct != null) return ` <span class="card-sub">${Math.round(pct)}%</span>`;
  if (n.share) return ` <span class="card-sub">${n.share}%</span>`;
  return studyVariationOf(k) ? ` <span class="card-sub">${esc(studyVariationOf(k))}</span>` : '';
}

function studyCardSub(id) {
  const n = studyNodes()[id];
  if (n.trunk) return '';
  const pct = studyMine(n.fen) ? studyHumanPct(id) : null;   // their move: how human is it?
  const bits = [];
  if (pct != null) bits.push(`${Math.round(pct)}% of ~${state.study.data.human_rating} players`);
  if (n.share) bits.push(`${n.share}% of master games`);
  else if (n.source === 'human' && pct != null) bits.push('not a master line');
  if (!bits.length && n.source === 'engine') bits.push("engine's choice");
  return bits.join(' · ');
}

const studyChipLive = (b) => !!state.study && !state.study.waiting && !state.demo && studyNodeHere() === b.dataset.node;

function renderStudyInfo() {
  const st = state.study;
  $('game-info').textContent = 'Opening lesson';
  $('board-sub').textContent = `${st.data.name} (${st.data.eco}) · you play ${st.data.color}`;
  const leaves = studyLeaves();
  const count = studyMasteredCount();
  let status = '';
  if (st.curve) status = st.curve.solved ? 'Curveball punished.' : 'Curveball: find the best reply.';
  else if (st.mode === 'drill') status = st.waiting ? 'Opponent is moving…' : st.hint ? 'Find the lesson move.' : studyNodeHere() !== null && !studyNodes()[studyNodeHere()].children.length ? '' : 'Your move.';
  else if (studyNodeHere() === null) status = 'Off the lesson: press ◀ to go back.';
  else if (st.waiting) status = 'Opponent is moving…';
  else status = studyNodes()[studyNodeHere()].children.length ? 'Play the arrowed move.' : 'End of this line: ◀ to go back and try another.';
  $('summary').innerHTML = `<div class="seg study-mode">${['learn', 'drill'].map((m) => `<button data-mode="${m}" class="${st.mode === m ? 'on' : ''}">${m === 'learn' ? 'Learn' : 'Drill'}</button>`).join('')}</div>`
    + `<span class="label" title="A line is mastered after ${MASTERED} clean drill runs in a row">${count}/${leaves.length} mastered</span>${status ? `<span class="label">${esc(status)}</span>` : ''}`
    + '<button class="btn ghost small" id="study-exit">Exit lesson</button>';
  $('summary').querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setStudyMode(b.dataset.mode); });
  $('study-exit').onclick = () => { state.study = null; studyToken++; renderChips(); addMsg('system', 'Left the lesson. The board stays as an analysis board.'); update(); };
}

// "Walk me through this": the lesson's own continuation goes with the question, so the coach
// explains the lesson's moves rather than a different line of its own
function studyWalkthrough() {
  const st = state.study;
  const id = studyNodeHere();
  if (id === null) return ask("Walk me through this position: what each side is aiming for and the key ideas. I've left the lesson's lines here.", { hideQuestion: true });
  const main = [];
  for (let k = studyNodes()[id].main; k !== null && main.length < 6; k = studyNodes()[k].main) main.push(studyNodes()[k].san);
  let branch = id;
  while (studyNodes()[branch].children.length === 1) branch = studyNodes()[branch].children[0];
  const tries = studyNodes()[branch].children.length > 1
    ? ` Where the opponent has a choice (after ${studyLine(branch).slice(-1)[0] || 'the start'}), the lesson covers: ${studyNodes()[branch].children.map((k) => `${studyNodes()[k].san} (${studyNodes()[k].share}%)`).join(', ')}.` : '';
  ask(`Walk me through this position in the ${st.data.name} lesson (I play ${st.data.color}): what I'm aiming for, `
    + `what my opponent is trying, and what to watch for. The lesson continues ${main.join(' ') || '(it ends here)'}.${tries} `
    + 'Explain the ideas behind those moves; keep it concise.', { hideQuestion: true });
}

// ---- opening name: a banner in the chat the first time a game reaches a named opening (offline ECO data,
// exact positions), then the deepest name reached so far stays above the win bar, growing as variations
// are recognised. Generic names ("King's Pawn Game") show in the tag but don't spend the banner.

const openingLines = new Map();  // start fen + moves → [{ply, eco, name, family}] from /api/opening_line
let openingBannerShown = false;  // reset per game in setReview()

async function requestOpening() {
  if (state.demo || state.editor || !state.review) return;  // a demo board keeps the game's tag
  const line = currentLine();
  const key = `${line.startFen}|${line.sans.join(' ')}`;
  if (!openingLines.has(key)) {
    try {
      openingLines.set(key, (await api('/api/opening_line', { start_fen: line.startFen, moves: line.sans })).names);
    } catch { return; }  // offline data, so only a server hiccup lands here; the tag just stays as it was
    if (openingLines.size > 200) openingLines.delete(openingLines.keys().next().value);
  }
  const now = currentLine();
  if (`${now.startFen}|${now.sans.join(' ')}` !== key) return;  // the line changed while we waited
  const hit = openingLines.get(key).filter((n) => n.ply <= now.at).pop();
  const tag = $('opening-tag');
  tag.classList.toggle('hidden', !hit);
  if (!hit) return;
  tag.innerHTML = `<span class="ot-eco">${esc(hit.eco)}</span><span class="ot-name">${esc(hit.name)}</span>`;
  tag.title = `${hit.eco} · ${hit.name}`;
  if (!openingBannerShown && !isBlandOpening(hit.family)) {
    openingBannerShown = true;
    addMsg('coach sb-msg', `<div class="sb-alert opening fresh"><span class="sb-al">Opening</span> 📖 ${esc(hit.name)}`
      + ` <span class="ot-eco">${esc(hit.eco)}</span></div>`);
  }
}

// ---- opening reactions ("Caro-Kann player, I see…"): free and instant, no Claude call. The name
// comes from the server's offline ECO table (/api/opening); this fires when an opponent move lands
// on a named opening, only in the first moves of a game that started from the standard position,
// at most a few times per game, and again only for a new family (or a variation with its own line).

let openingNote = { family: null, key: null, count: 0 };
const OPENING_QUIP_MAX_PLY = 16;
const OPENING_QUIP_MAX = 3;
// names too generic to react to ("King's Pawn Game" after 1.e4): skip them without using up a quip
const isBlandOpening = (family) => /^(King's|Queen's) Pawn (Game|Opening)?$|^Indian Defense$/.test(family);

async function openingQuip(c) {
  if (openingNote.count >= OPENING_QUIP_MAX) return false;
  const start = state.play ? state.play.startFen : state.review.start_fen;
  const ply = (c.moveNumber() - 1) * 2 + (c.turn() === 'b' ? 1 : 0);
  if (start !== START_FEN || ply > OPENING_QUIP_MAX_PLY) return false;
  let res;
  try { res = (await api('/api/opening', { fen: c.fen() })).opening; } catch { return false; }
  if (!res || isBlandOpening(res.family)) return false;
  const fresh = res.family !== openingNote.family || (res.flavored && res.key !== openingNote.key);
  if (!fresh || currentGame().fen() !== c.fen()) return false;  // repeat of what we said, or the board moved on
  openingNote = { family: res.family, key: res.key, count: openingNote.count + 1 };
  addMsg('coach quip', `<div class="quip-line">${esc(res.quip)}</div><div class="quip-sub">${esc(res.eco)} · ${esc(res.name)}</div>`);
  return true;
}

// ---- knowledgeable-player color commentary after (almost) every opponent move — a real coach
// call like any question, just triggered automatically and rendered plainly (no GM-alert styling,
// not saved to the Lessons library); the coach can say `(nothing)` to skip a forced/generic move

// Automatic coach calls (the three above/below) only with "Auto" on in the Coach header; off by default
// (user's call, 2026-10-04: no Claude spend you didn't ask for). The free opening quips don't depend on it.
const autoCoach = () => recall('autoCoach') === '1';

let opponentCommentCount = 0;
const OPPONENT_COMMENT_LIMIT = 4;  // just the opening phase — quiet again after that, for cost

async function commentOnOpponentMove(c, san) {
  if (c.isGameOver()) return;
  if (await openingQuip(c)) return;  // the free opening reaction stands in for the paid one-liner this move
  if (!state.coachReady || !autoCoach() || opponentCommentCount >= OPPONENT_COMMENT_LIMIT) return;
  if (state.review.moves[state.ply - 1]?.win_pct_lost >= BIG_MOMENT_PCT) return;  // noteMove() explains this one
  opponentCommentCount++;
  await ask(`[The opponent just played ${san}. Give your one-line reaction, or say (nothing) if there's really nothing worth saying.]`,
    { silent: true, skipEmpty: true, ambient: true, where: positionLabel() });
}

// ---- a note on each move as you step through a loaded game (review or replay). The note itself is
// free: it's read off the saved engine review. Only a big swing (>= BIG_MOMENT_PCT win chance lost)
// asks the coach, and only if you stay on that move for a moment, so scrubbing past doesn't pay.
// Each move is noted once per game; jumping (Home/End, a move list click) notes only where you land.

const notedPlies = new Set();
const bigMomentAsked = new Set();
const BIG_MOMENT_PCT = 10;       // same line as "inaccuracy" in the review and the Game-changing chip
const BIG_MOMENT_MAX = 8;        // paid explanations per game
const BIG_MOMENT_DWELL_MS = 1200;

const moveName = (label, san) => `${label}${label.endsWith('...') ? '' : ' '}${san}`;

// "+0.40" / "#3" / "#-2" -> a number for evalWords(); mates count as decisive
function evalValue(e) {
  if (e.startsWith('#')) return e.startsWith('#-') ? -99 : 99;
  return parseFloat(e);
}

function evalPill(e) {
  const v = evalValue(e);
  const cls = e.startsWith('#') ? 'm' : v > 0.5 ? 'w' : v < -0.5 ? 'b' : 'eq';
  return `<span class="evalpill ${cls}">${esc(e)}</span>`;
}

// what "Why?" asks, and what a big moment asks by itself: one fixed wording per move, so both share
// the local answer cache and a revisit doesn't pay again
function moveQuestion(m) {
  const name = moveName(m.label, m.san);
  const side = m.color === state.review.player_color ? 'the player' : "the player's opponent";
  if (m.played_best) {
    return `[Stepping through the game: ${name} by ${side} was the engine's top choice. In two or three sentences, `
      + 'say what it does and why it is best here. Verify with the tools.]';
  }
  const best = m.best ? moveName(m.label, m.best) : null;
  return `[Stepping through the game: ${name} by ${side} took the eval from ${m.eval_before} to ${m.eval_after} `
    + `(about ${Math.round(m.win_pct_lost)}% win chance lost)${best ? `; the engine preferred ${best}` : ''}. `
    + 'In two or three sentences, say what the move missed or allowed and what the better move does. Verify with the tools.]';
}

// ---- known traps from the user's own opening collection (data/openings.md, indexed on the server,
// no Claude call). A row on a card: `html` is the text, `demo` what the ▶ button shows.
function trapRow(kind, t, mine) {
  const ref = t.punish.length ? moveChip(t.punish[0]) : null;
  const line = esc(t.punish.slice(0, 6).join(' '));
  const src = `<span class="card-sub">known trap · ${esc(t.section)}</span>`;
  const btn = t.punish.length ? '<button class="demo-btn" data-demo="trap">▶ Refutation</button>' : '';
  if (kind === 'fell') {
    return mine
      ? `<div class="card-row warn">⚠ You walked into a known trap${ref ? `: ${ref} wins for them` : ''}. ${btn}${src}</div>`
      : `<div class="card-row good">🎯 They walked into a known trap${ref ? `: ${ref} wins` : ''}. ${btn}${src}</div>`;
  }
  if (kind === 'punished') return `<div class="card-row good">✓ That's the known refutation of the trap. ${src}</div>`;
  if (kind === 'missed') {
    return mine
      ? `<div class="card-row warn">⚠ Missed the refutation of a known trap: ${ref} (${line}). ${btn}${src}</div>`
      : `<div class="card-row good">Lucky: they missed the refutation ${ref}. ${btn}${src}</div>`;
  }
  // 'warn': the side to move (you) can walk into it right here
  return `<div class="card-row warn">⚠ Known trap: ${moveChip(t.move)} here loses to ${ref}. `
    + `<button class="demo-btn" data-demo="trap">▶ Show it</button>${src}</div>`;
}

// Same look as the bot-game card (showOpponentCard), but read off the saved review: no engine call.
function noteMove() {
  if (state.play || state.demo || state.editor || state.extra.length || !state.review) return;
  const ply = state.ply;
  const m = state.review.moves[ply - 1];
  if (!m || notedPlies.has(ply) || typeof m.win_pct_lost !== 'number') return;
  notedPlies.add(ply);
  const name = moveName(m.label, m.san);
  const best = m.best ? moveName(m.label, m.best) : null;
  const lost = Math.round(m.win_pct_lost);
  const mate = /^#-?0$/.test(m.eval_after);
  const verdict = m.played_best ? 'Best move' : m.class ? `${m.class[0].toUpperCase()}${m.class.slice(1)} · ${lost}% win chance`
    : lost >= 3 ? `A little loose · ${lost}% win chance` : 'Fine';
  const rows = [];
  rows.push(`<div class="card-row"><span class="card-k">Played</span>${moveChip(name)}${evalPill(m.eval_after)}`
    + `<span class="card-sub">${esc(mate ? 'checkmate' : evalWords(evalValue(m.eval_after)))}</span></div>`);
  // under 1% the engine's preference is a matter of taste, so don't suggest it
  if (!m.played_best && best && lost >= 1) {
    rows.push(`<div class="card-row"><span class="card-k">Best</span>${moveChip(best)}${evalPill(m.eval_before)}</div>`);
  }
  const line = (m.best_line || '').replace(/\d+\.+\s*/g, '').split(/\s+/).filter(Boolean);
  if (line.length > 1) {
    rows.push(`<div class="card-row"><button class="demo-btn" data-demo="best">▶ ${m.played_best ? 'Main' : 'Best'} line</button>`
      + `<span class="card-sub">${esc(m.best_line.split(/\s+/).slice(0, 6).join(' '))}…</span></div>`);
  }
  if (m.trap) {
    const kind = m.trap.kind;
    // 'fell' is about this move's mover; 'punished'/'missed' about the setter, who made this move
    rows.push(trapRow(kind, m.trap, m.color === state.review.player_color));
  }
  rows.push('<div class="card-row card-actions"><button class="btn ghost small note-why">Why?</button>'
    + '<button class="btn ghost small card-back" title="Close the demo board and return to the game">Back to my game</button></div>');

  document.querySelectorAll('.msg.card:not(.collapsed)').forEach((el) => el.classList.add('collapsed'));  // keep the chat short
  const msg = addMsg('coach card', `<div class="card-head"><b>${esc(name)}</b><span class="card-sub">${esc(verdict)}</span>`
    + `<span class="card-caret">▾</span></div><div class="card-body">${rows.join('')}</div>`);
  msg.querySelector('.card-head').onclick = () => msg.classList.toggle('collapsed');
  msg.querySelector('.card-back').onclick = () => closeDemo();
  const trapBtn = msg.querySelector('[data-demo="trap"]');
  if (trapBtn) {
    // 'fell': show the refutation from after this move; 'missed': from before it (the move that should have been played)
    const from = m.trap.kind === 'fell' ? m.fen_after : ply > 1 ? state.review.moves[ply - 2].fen_after : state.review.start_fen;
    trapBtn.onclick = () => openDemo({ title: `Refutation: ${m.trap.punish.join(' ')}`, start_fen: from,
      moves: m.trap.punish, notes: [], ply, then_moves: [] });
  }
  const demoBtn = msg.querySelector('[data-demo="best"]');
  if (demoBtn) {
    const startFen = ply > 1 ? state.review.moves[ply - 2].fen_after : state.review.start_fen;
    demoBtn.onclick = () => openDemo({ title: `${m.played_best ? 'Main' : 'Best'} line: ${best || name}`, start_fen: startFen,
      moves: line, notes: [], ply, then_moves: [] });
  }
  msg.querySelector('.note-why').onclick = () => ask(moveQuestion(m), { hideQuestion: true, at: { ply, extra: [] } });
  syncCards();
  if (m.win_pct_lost >= BIG_MOMENT_PCT) explainBigMoment(m, ply);
}

async function explainBigMoment(m, ply) {
  if (!state.coachReady || !autoCoach() || bigMomentAsked.size >= BIG_MOMENT_MAX || bigMomentAsked.has(ply)) return;
  const onIt = () => state.ply === ply && !state.demo && !state.extra.length && !state.play;
  await new Promise((r) => setTimeout(r, BIG_MOMENT_DWELL_MS));
  while (state.chatBusy && onIt()) await new Promise((r) => setTimeout(r, 300));
  if (!onIt() || bigMomentAsked.has(ply)) return;
  bigMomentAsked.add(ply);
  ask(moveQuestion(m), { silent: true, label: '⚠ Big moment', where: positionLabel(), at: { ply, extra: [] } });
}

// ---- the card after each bot move: best move, main line, a sharper try, what they threaten.
// Built by the engine on the server (/api/opponent_card) — no Claude call; "Why?" is the one
// button that asks the coach, so cost only happens when you press it. Replays still get the
// short coach one-liner above, since there you're meant to play your own game move.

let cardToken = 0;

// "12. Nf3 d5 13. Bb5" text for the first few plies of a line
function lineText(fen, moves, n = 4) {
  const labels = demoLabels({ start_fen: fen, moves });
  return moves.slice(0, n).map((m, i) => {
    const lab = labels[i];
    return lab.endsWith('...') ? (i === 0 ? `${lab}${m}` : m) : `${lab} ${m}`;
  }).join(' ');
}

// Speed: the instant part (quickCard: best move, eval, main line, loose pieces, from a depth-14 search)
// comes back with the bot's move, so the card appears with it. Then the "If they…" rows, then the full
// card (depth 20, sharper try, threat; ~3.5 s), which replaces the top rows. The full pass is skipped if
// the position has moved on by then, so it doesn't hold the engine while you play quickly.
async function showOpponentCard(c, quickCard = null) {
  const p = state.play;
  if (!p || c.isGameOver()) return;
  const fen = c.fen(), token = ++cardToken;
  const live = () => token === cardToken && state.play === p && currentGame().fen() === fen;
  let card = quickCard;
  if (!card) {
    try { card = await api('/api/opponent_card', { fen }); } catch { return; }  // a card is a bonus, never an error
  }
  if (!live() || state.demo) return;

  const origin = linesOrigin();
  const demoFor = (title, moves) => ({ title, start_fen: fen, moves, notes: [], ply: origin.ply, then_moves: origin.then_moves });
  document.querySelectorAll('.msg.card:not(.collapsed)').forEach((m) => m.classList.add('collapsed'));  // keep the chat short
  const msg = addMsg('coach card',
    `<div class="card-head"><b>Your move</b><span class="card-sub">${esc(positionLabel())}</span><span class="card-caret">▾</span></div>`
    + '<div class="card-body"><div class="card-main"></div>'
    + '<div class="card-row card-replies"><span class="card-k">If they…</span><span class="card-sub">checking their replies…</span></div>'
    + `<div class="card-row card-actions"><button class="btn small card-play-btn" data-fen="${esc(fen)}"></button>`
    + `<button class="btn ghost small card-why" data-fen="${esc(fen)}">Why?</button>`
    + '<button class="btn ghost small card-back" title="Close the demo board and return to your game">Back to my game</button></div></div>');
  const main = msg.querySelector('.card-main');
  const slot = msg.querySelector('.card-replies');

  function render() {
    const cp = card.cp_white / 100;
    const mate = card.eval_white.startsWith('#');
    const pillCls = mate ? 'm' : cp > 0.5 ? 'w' : cp < -0.5 ? 'b' : 'eq';
    const best = card.best;
    const rows = [];
    rows.push(`<div class="card-row"><span class="card-k">Best</span>${moveChip(best.move)}`
      + `<span class="evalpill ${pillCls}">${esc(best.eval_white)}</span>`
      + (best.tags ? `<span class="card-sub">${esc(best.tags.join(', '))}</span>` : '') + '</div>');
    if (best.moves.length > 1) {
      rows.push(`<div class="card-row"><button class="demo-btn" data-demo="main">▶ Main line</button>`
        + `<span class="card-sub">${esc(lineText(fen, best.moves))}…</span></div>`);
    }
    if (card.aggressive && card.aggressive.moves.length) {
      const a = card.aggressive;
      rows.push(`<div class="card-row"><button class="demo-btn sharp" data-demo="sharp">▶ Sharper try: ${esc(a.move)}</button>`
        + `<span class="card-sub">${esc(a.note)} · ${esc(a.eval_white)}</span></div>`);
    }
    // in a bot game "they" are the bot: trap_punish = it just walked into one, trap_warn = you might
    if (card.trap_punish) rows.push(trapRow('fell', card.trap_punish, false));
    if (card.trap_warn) rows.push(trapRow('warn', card.trap_warn, true));
    if (card.threat) {
      const gain = card.threat.gain >= 15 ? 'a decisive attack' : `about ${card.threat.gain} pawns`;
      rows.push(`<div class="card-row warn">⚠ They threaten ${moveChip(card.threat.move)} (${gain} if ignored)</div>`);
    }
    for (const [who, list] of [['Yours', card.loose.you], ['Theirs', card.loose.them]]) {
      if (list.length) rows.push(`<div class="card-row"><span class="card-k">${who} loose</span><span class="card-sub">${esc(list.join('; '))}</span></div>`);
    }
    if (card.quick) rows.push('<div class="card-row card-pending"><span class="card-sub">checking threats and sharper tries…</span></div>');
    main.innerHTML = rows.join('');
    msg.querySelector('.card-play-btn').textContent = `Play ${best.move}`;
    main.querySelectorAll('[data-demo]').forEach((b) => {
      const d = b.dataset.demo;
      const w = card.trap_warn, tp = card.trap_punish;
      // the warn row is the only trap row styled .warn on this card
      const demo = d === 'main' ? demoFor(`Main line: ${best.move}`, best.moves)
        : d === 'trap' && b.closest('.warn') ? demoFor(`Trap: ${w.move}?? ${w.punish.join(' ')}`, [w.move, ...w.punish])
        : d === 'trap' ? demoFor(`Refutation: ${tp.punish.join(' ')}`, tp.punish)
        : demoFor(`Sharper try: ${card.aggressive.move}`, card.aggressive.moves);
      b.onclick = () => openDemo(demo);
    });
    syncCards();
  }

  // "If they play A, I play B" for the card's current best move; a newer call wins
  let repliesFor = null;
  function loadReplies() {
    const uci = repliesFor = card.best.uci;
    slot.hidden = false;
    slot.innerHTML = '<span class="card-k">If they…</span><span class="card-sub">checking their replies…</span>';
    return api('/api/opponent_card/replies', { fen, uci }).then(({ replies }) => {
      if (repliesFor !== uci) return;
      if (!replies.length) { slot.hidden = true; return; }
      slot.innerHTML = '<span class="card-k">If they…</span><div class="card-replylist">'
        + replies.map((r, i) => `<div class="card-reply"><span>${esc(r.reply)}</span>`
          + (r.answer ? `<span class="card-arrow">→</span><b>${esc(r.answer)}</b><span class="card-sub">${esc(r.answer_eval_white)}</span>` : '')
          + `<button class="demo-btn" data-reply="${i}" title="Show it on the demo board">▶</button></div>`).join('')
        + '</div>';
      slot.querySelectorAll('[data-reply]').forEach((b) => {
        const r = replies[+b.dataset.reply];
        b.onclick = () => openDemo(demoFor(`If ${r.reply}: ${r.moves.join(' ')}`, r.moves));
      });
    }).catch(() => { if (repliesFor === uci) slot.hidden = true; });  // a bonus row: fail quietly
  }

  msg.querySelector('.card-head').onclick = () => msg.classList.toggle('collapsed');
  msg.querySelector('.card-back').onclick = () => closeDemo();
  msg.querySelector('.card-play-btn').onclick = () => {
    if (!cardIsCurrent(fen)) return;
    onPlayMove(card.best.uci.slice(0, 2), card.best.uci.slice(2, 4));
  };
  msg.querySelector('.card-why').onclick = () => {
    if (!cardIsCurrent(fen)) return;
    ask(CHIPS.play[0][1], { hideQuestion: true });  // the same "My plan?" question as the chip, so it shares that answer's cache
  };
  render();
  await loadReplies();
  if (!card.quick) return;
  if (!live()) { main.querySelector('.card-pending')?.remove(); return; }
  let full;
  try { full = await api('/api/opponent_card', { fen }); } catch { main.querySelector('.card-pending')?.remove(); return; }
  const moved = full.best.uci !== card.best.uci;
  card = full;
  render();
  if (moved) loadReplies();  // the deeper search changed its mind: the replies were for the old move
}

// a card's buttons only work while its position is still on the board and it's your move
function cardIsCurrent(fen) {
  const p = state.play;
  return !!p && !state.demo && !p.over && !p.thinking && p.view === p.moves.length && currentGame().fen() === fen;
}

function syncCards() {
  document.querySelectorAll('.card-play-btn, .card-why').forEach((b) => { b.disabled = !cardIsCurrent(b.dataset.fen); });
  document.querySelectorAll('.card-back').forEach((b) => { b.disabled = !state.demo; });  // only meaningful while a demo is open
  // the coach buttons show only on the card for the position on the board (◀ back to a card brings them back)
  document.querySelectorAll('.card-chips').forEach((row) => { row.hidden = !studyChipLive(row.querySelector('.study-chip')); });
}

// ---- "only a GM would see this": engine check each time it's the player's turn

let gmToken = 0;
const gmSeen = new Set();

async function gmCheck(c, gameMove = null, side = 'player') {
  if (!state.coachReady || !autoCoach() || c.isGameOver()) return;
  const fen = c.fen();
  if (gmSeen.has(fen)) return;
  const token = ++gmToken;
  let res;
  try {
    res = await api('/api/gm_check', { fen });
  } catch {
    return;
  }
  if (token !== gmToken || !res.moment || gmSeen.has(fen)) return;
  gmSeen.add(fen);
  const m = res.moment;
  const facts = [
    `The engine flagged a GM-level resource for ${side === 'player' ? 'the player' : "the player's opponent"} `
      + `(${c.turn() === 'w' ? 'White' : 'Black'} to move):`,
    `- Kind: ${m.kind}${m.mate_in ? ` (mate in ${m.mate_in})` : ''}${m.material_sacrificed ? `, sacrificing about ${m.material_sacrificed} pawns' worth` : ''}`,
    `- Best move: ${m.move} (eval ${m.eval_white}), line: ${m.line}`,
    `- Next best: ${m.second_best} (eval ${m.second_eval_white})`,
  ];
  if (side === 'opponent') {
    facts.push(gameMove?.san === m.move
      ? `- This is a replay of the player's real game, and the opponent found ${m.move} here.`
      : `- This is a replay of the player's real game; the opponent missed it and played ${gameMove?.san}.`);
    facts.push('Warn the player before the opponent moves: show the idea with show_on_board, explain it, and '
      + 'point out what in the previous moves allowed it. Keep it short.');
  } else {
    if (gameMove) {
      facts.push(gameMove.san === m.move
        ? `- This is a replay of their real game, and they actually found ${m.move} here. Give them credit, then show why it works.`
        : `- This is a replay of their real game: here they played ${gameMove.label} ${gameMove.san} instead.`);
    }
    facts.push('Point it out before they move: say there is something special on the board, show it with show_on_board, '
      + 'and explain why it works and why it is hard to see. Keep it short.');
  }
  const opts = { silent: true, label: side === 'player' ? '⚡ GM moment' : '⚠ Watch out', where: positionLabel() };
  const done = ask(facts.join('\n'), opts);
  if (state.replay) renderInfo();  // show "hold on" in the replay status
  if (side === 'opponent') await done;  // replays hold the opponent's move until the warning is shown
}

// ---------------------------------------------------------------- playing the bot

let playToken = 0;  // invalidates a pending bot reply after takeback / new game

function playView(view) {
  const p = state.play;
  p.view = Math.max(0, Math.min(view, p.moves.length));
  state.extra = p.moves.slice(0, p.view);
  update();
}

function onPlayMove(orig, dest) {
  const p = state.play;
  const c = currentGame();
  const fenBefore = c.fen();
  let mv;
  try {
    mv = c.move({ from: orig, to: dest, promotion: 'q' });
  } catch {
    update();
    return;
  }
  p.moves.push(mv.san);
  if (p.clock) { p.clock[p.color] += p.clock.increment; p.clock.lastTick = Date.now(); }
  if (p.endgame) egAfterMyMove(p, fenBefore, mv.from + mv.to + (mv.promotion || ''), `${fenBefore.split(' ')[5]}${mv.color === 'w' ? '.' : '...'}${mv.san}`);
  playView(p.moves.length);
  if (!checkGameOver()) botMove();
}

async function botMove() {
  const p = state.play;
  const token = ++playToken;
  p.thinking = true;
  update();
  const c = playChess(p);
  const started = Date.now();
  let quickCard = null;
  try {
    // the game so far (Maia reads the last few positions) and your rating if known (Maia plays against it)
    const res = await api('/api/play/move', {
      fen: c.fen(), level: p.level, start_fen: p.startFen, moves: p.moves, opp_elo: p.myElo, card: true,
    });
    quickCard = res.card || null;
    await new Promise((r) => setTimeout(r, Math.max(0, 450 - (Date.now() - started))));  // feel less instant
    if (token !== playToken || state.play !== p) return;
    p.moves.push(res.san);
    if (p.clock) {
      const botColor = p.color === 'white' ? 'black' : 'white';
      p.clock[botColor] += p.clock.increment;
      p.clock.lastTick = Date.now();
    }
  } catch (e) {
    addMsg('error', `Bot error: ${esc(e.message)}`);
  } finally {
    if (token === playToken && state.play === p) {
      p.thinking = false;
      playView(p.moves.length);
      if (!checkGameOver()) {
        if (p.endgame) egMyTurn(p, playChess(p).fen());
        openingQuip(playChess(p));
        showOpponentCard(playChess(p), quickCard);
        gmCheck(playChess(p));
      }
    }
  }
}

const CONFETTI_COLORS = ['--confetti-1', '--confetti-2', '--confetti-3', '--confetti-4', '--confetti-5', '--confetti-6'];

function fireConfetti(count = 140) {
  const overlay = document.createElement('div');
  overlay.className = 'confetti-overlay';
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece' + (Math.random() < 0.5 ? ' round' : '');
    el.style.left = `${Math.random() * 100}%`;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 220}px`);
    el.style.setProperty('--spin', `${360 + Math.random() * 720}deg`);
    el.style.animationDuration = `${2.2 + Math.random() * 1.4}s`;
    el.style.animationDelay = `${Math.random() * 0.4}s`;
    el.style.background = `var(${CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]})`;
    overlay.appendChild(el);
  }
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 4000);
}

function checkGameOver() {
  const p = state.play;
  const c = playChess(p);
  if (!c.isGameOver()) return false;
  if (c.isCheckmate()) {
    const winner = c.turn() === 'w' ? 'black' : 'white';
    if (winner === p.color) fireConfetti();
    endGame(winner === p.color ? 'win' : 'loss', winner === p.color ? 'Checkmate. You won!' : 'Checkmate. The bot wins.');
  } else {
    const why = c.isStalemate() ? 'stalemate' : c.isThreefoldRepetition() ? 'threefold repetition'
      : c.isInsufficientMaterial() ? 'insufficient material' : 'the 50-move rule';
    endGame('draw', `Draw by ${why}.`);
  }
  return true;
}

function endGame(outcome, text) {
  const p = state.play;
  p.over = { outcome, text };
  update();
  addMsg('system', `${esc(text)} Click “Review this game” to see where it was won or lost.`);
  if (p.endgame) egGameOver(p, outcome);
}

function takeback() {
  const p = state.play;
  const floor = p?.prefix || 0;  // a game branched off a replay: don't take back the original game's moves
  if (!p || p.moves.length <= floor) return;
  playToken++;  // drop any bot reply in flight
  p.thinking = false;
  p.over = null;
  const mine = p.color[0];
  do { p.moves.pop(); } while (p.moves.length > floor && playChess(p).turn() !== mine);
  if (p.clock) p.clock.lastTick = Date.now();  // don't charge takeback time to whoever's now to move
  playView(p.moves.length);
  if (p.endgame) egTakeback(p);
  if (playChess(p).turn() !== mine) botMove();  // back at a start position where the bot moves first
}

function stopBotThinking() {
  // for a misclick/typo: drop the bot's in-flight reply without undoing your own move, so you
  // get a moment to look before it lands (Takeback is still there if the move itself was wrong)
  const p = state.play;
  if (!p || !p.thinking) return;
  playToken++;
  p.thinking = false;
  playView(p.moves.length);
}

function reviewPlayedGame() {
  const p = state.play;
  const c = playChess(p);
  if (p.startFen !== START_FEN) {
    c.setHeader('SetUp', '1');
    c.setHeader('FEN', p.startFen);
  }
  const name = state.me || 'You';
  const bot = `Bot ${p.levelName}`;
  const result = p.over?.outcome === 'draw' ? '1/2-1/2'
    : (p.over?.outcome === 'win') === (p.color === 'white') ? '1-0' : '0-1';
  c.setHeader('Event', 'Practice game vs bot');
  c.setHeader('Date', new Date().toISOString().slice(0, 10).replaceAll('-', '.'));
  c.setHeader('White', p.color === 'white' ? name : bot);
  c.setHeader('Black', p.color === 'black' ? name : bot);
  c.setHeader('Result', p.over ? result : '*');
  loadGame(c.pgn(), name);
}

function renderPlayInfo() {
  const p = state.play;
  $('game-info').textContent = 'Practice game vs bot';
  $('board-sub').textContent = '';
  let status, cls = '';
  if (p.over) {
    status = p.over.text;
    cls = p.over.outcome === 'win' ? 'win' : p.over.outcome === 'loss' ? 'loss' : '';
  } else if (p.view < p.moves.length && !p.thinking) status = 'Viewing an earlier position; press → or ⏭ to return';
  const buttons = p.over
    ? `<button class="btn small" id="pb-review">Review this game</button>
       <button class="btn ghost small" id="pb-again">New game</button>`
    : (p.thinking ? '<button class="btn ghost small" id="pb-stop">Stop bot</button>' : '');
  const back = p.back ? '<button class="btn ghost small" id="pb-back">Back to the game</button>'
    : p.backLesson ? '<button class="btn ghost small" id="pb-lesson">Back to the lesson</button>' : '';
  $('summary').innerHTML = `${status ? `<div class="status ${cls}">${esc(status)}</div>` : ''}<div class="play-buttons">${buttons}${back}</div>`;
  $('pb-back')?.addEventListener('click', backToGame);
  $('pb-lesson')?.addEventListener('click', backToLesson);
  $('pb-review')?.addEventListener('click', reviewPlayedGame);
  $('pb-again')?.addEventListener('click', openPlayDialog);
  $('pb-stop')?.addEventListener('click', stopBotThinking);
}

function renderPlayMoves(box) {
  const p = state.play;
  if (!p.moves.length) {
    const myTurn = new Chess(p.startFen).turn() === p.color[0];
    box.innerHTML = `<div class="empty">${myTurn ? 'Your move. Drag a piece to start.' : 'The bot is thinking about its first move…'}</div>`;
    return;
  }
  // rows of full moves; a game from a set-up position may start with Black's move
  const c = new Chess(p.startFen);
  let html = '', row = null;
  p.moves.forEach((san, j) => {
    const white = c.turn() === 'w';
    const cell = `<span class="mv${j + 1 === p.view ? ' active' : ''}" data-view="${j + 1}">${esc(san)}</span>`;
    if (white || !row) {
      if (row) html += row.join('') + '</div>';
      row = [`<div class="row"><span class="num">${c.moveNumber()}.</span>`, white ? cell : '<span>…</span>', white ? '' : cell];
    } else {
      row[2] = cell;
    }
    c.move(san);
  });
  if (row) html += row.join('') + (row[2] ? '' : '<span></span>') + '</div>';
  box.innerHTML = html;
  box.querySelectorAll('.mv').forEach((el) => { el.onclick = () => playView(+el.dataset.view); });
  box.querySelector('.mv.active')?.scrollIntoView({ block: 'nearest' });
}

let playColor = 'white';

let pendingFen = null;  // set when starting a bot game from the position editor

function playChess(p) {
  const c = new Chess(p.startFen);
  for (const san of p.moves) c.move(san);
  return c;
}

async function openPlayDialog() {
  const sel = $('play-level');
  if (!sel.options.length) {
    const levels = await api('/api/play/levels');
    sel.innerHTML = levels.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    sel.value = recall('botLevel') || '';
    if (!sel.value) sel.value = String((await levelForRating(1500)).id);  // first time, or a retired level
  }
  $('play-engine').checked = recall('playEngine') !== '0';
  $('play-clock-on').checked = recall('clockOn') === '1';
  $('play-clock-minutes').value = recall('clockMinutes') || '10';
  $('play-clock-increment').value = recall('clockIncrement') || '0';
  $('play-clock-fields').classList.toggle('hidden', !$('play-clock-on').checked);
  $('dlg-play').querySelector('h2').textContent = pendingFen ? 'Play this position against the bot' : 'Play a game';
  $('play-continue-row').innerHTML = pendingFen ? ''
    : '<button class="btn ghost small" id="play-continue-btn">Or replay one of your own games and branch off it…</button>';
  const continueBtn = $('play-continue-btn');
  if (continueBtn) continueBtn.onclick = () => { $('dlg-play').close(); openGamesDialog(); };
  $('dlg-play').showModal();
}

async function startGame() {
  const level = +$('play-level').value;
  const levelName = $('play-level').selectedOptions[0].textContent;
  const color = playColor === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : playColor;
  store('botLevel', String(level));
  store('playEngine', $('play-engine').checked ? '1' : '0');
  const clockOn = $('play-clock-on').checked;
  const clockMinutes = Math.min(180, Math.max(1, +$('play-clock-minutes').value || 10));
  const clockIncrement = Math.min(60, Math.max(0, +$('play-clock-increment').value || 0));
  store('clockOn', clockOn ? '1' : '0');
  store('clockMinutes', String(clockMinutes));
  store('clockIncrement', String(clockIncrement));
  $('dlg-play').close();
  playToken++;
  const fen = pendingFen;
  pendingFen = null;
  let review;
  try {
    review = await api('/api/play/new', { color, level, fen });
  } catch (e) {
    addMsg('error', esc(e.message));
    return;
  }
  const clock = clockOn
    ? { white: clockMinutes * 60, black: clockMinutes * 60, increment: clockIncrement, lastTick: Date.now() }
    : null;
  const play = { color, level, levelName, startFen: review.start_fen, moves: [], view: 0, over: null, thinking: false, clock };
  setEngineVisible($('play-engine').checked);
  const from = fen ? ' from your set-up position' : '';
  setReview(review, `New game${from}: you have the ${color} pieces against the ${levelName} bot. Ask for ideas any time.`, play);
  if (new Chess(play.startFen).turn() !== color[0]) botMove();
}

// ---------------------------------------------------------------- endgame trainer
// Pick material and a goal; the server sets up a random position with that material and a known result
// (core/endgames.py: Lichess' tablebase up to 7 pieces, deep Stockfish above) and you play it out against
// full-strength Stockfish, eval hidden. With the tablebase, each of your moves is checked: a move that
// throws away the win (or the draw) gets a card naming the best move. "Material lies": you're down
// material but it's a draw or a win (user's idea: learn when the count misleads).

const EG_MODES = {
  win: ['Win it', 'You have a won position. Convert it against perfect defence.'],
  draw: ['Hold it', 'The position is a draw. Hold it against an engine trying to win.'],
  lies: ['Material lies', "You're down material, yet it's a draw or even a win. Find out which, then prove it."],
};
const EG_HOLD_MOVES = 30;  // a "hold the draw" drill counts as done after this many of your moves
const EG_RANK = { loss: 0, draw: 1, win: 2 };
const egProbes = new Map();  // fen → promise of the tablebase verdict (not in state.play: that's snapshotted)
let egPresets = null;
let egChoice = { mode: recall('egMode') || 'win', color: recall('egColor') || 'white' };

function egStats() {
  try { return JSON.parse(recall('egStats') || '{}'); } catch { return {}; }
}

function egRecord(key, field) {
  const s = egStats();
  s[key] = { tries: 0, done: 0, ...s[key] };
  s[key][field]++;
  store('egStats', JSON.stringify(s));
}

// "KRP" as glyphs in one colour
function egGlyphs(material, white) {
  const g = white ? { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' } : { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
  return [...material].map((c) => g[c] || '').join('');
}

function egSpecLabel(spec) {
  const m = /^(rand|pawns):(\d+)$/.exec(spec);
  if (m) return m[1] === 'rand' ? `${m[2]} random pieces` : `kings + ${m[2]} pawns`;
  return spec.split('-').map((s) => s.split('').join('+')).join(' vs ');
}

async function openEndgames() {
  if (!egPresets) {
    try { egPresets = await api('/api/endgame/presets'); } catch (e) { return void addMsg('error', esc(e.message)); }
  }
  renderEndgames();
  $('eg-status').textContent = '';
  $('dlg-endgame').showModal();
}

function renderEndgames() {
  const { mode, color } = egChoice;
  $('eg-modes').innerHTML = Object.entries(EG_MODES).map(([k, [label]]) => `<button data-mode="${k}" class="${k === mode ? 'on' : ''}">${label}</button>`).join('');
  $('eg-mode-hint').textContent = EG_MODES[mode][1];
  $('eg-color').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
  const white = color !== 'black';
  const stats = egStats();
  const groups = [...new Set(egPresets.map((p) => p.group))];
  $('eg-grid').innerHTML = groups.map((g) => `<div class="eg-group"><div class="eg-gh">${esc(g)}</div><div class="eg-tiles">${
    egPresets.filter((p) => p.group === g).map((p) => {
      const st = stats[`${p.spec}|${mode}`];
      const [mine, theirs] = p.spec.includes('-') ? p.spec.split('-') : [null, null];
      const art = mine ? `<span class="eg-art"><span class="${white ? 'w' : 'b'}">${egGlyphs(mine, white)}</span><span class="eg-vs">vs</span><span class="${white ? 'b' : 'w'}">${egGlyphs(theirs, !white)}</span></span>`
        : `<span class="eg-art"><span class="eg-n">${p.spec.split(':')[1]}</span><span class="eg-vs">${p.spec.startsWith('pawns') ? '♙ ♟' : 'pieces'}</span></span>`;
      return `<button class="eg-tile" data-spec="${esc(p.spec)}" title="${esc(egSpecLabel(p.spec))}">${art}<span class="eg-label">${esc(p.label)}</span>`
        + `${st ? `<span class="eg-st" title="Done / tried in this mode">${st.done}/${st.tries}</span>` : ''}</button>`;
    }).join('')}</div></div>`).join('');
  $('eg-modes').querySelectorAll('button').forEach((b) => { b.onclick = () => { egChoice.mode = b.dataset.mode; store('egMode', b.dataset.mode); renderEndgames(); }; });
  $('eg-grid').querySelectorAll('.eg-tile').forEach((b) => { b.onclick = () => startEndgame(b.dataset.spec); });
}

$('eg-color').querySelectorAll('button').forEach((b) => {
  b.onclick = () => { egChoice.color = b.dataset.color; store('egColor', b.dataset.color); renderEndgames(); };
});

// full-strength Stockfish: the strongest defence (the last level when Maia isn't installed)
async function egBotLevel() {
  botLevels ??= await api('/api/play/levels').catch(() => []);
  return botLevels.find((l) => /^stockfish/i.test(l.name)) || botLevels[botLevels.length - 1] || null;
}

async function startEndgame(spec, mode = egChoice.mode, pick = egChoice.color) {
  const color = pick === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : pick;
  const level = await egBotLevel();
  if (!level) return void addMsg('error', "Couldn't load the bot levels.");
  const open = $('dlg-endgame').open;
  if (open) {
    $('eg-status').textContent = 'Setting up a position…';
    $('eg-grid').classList.add('busy');
  }
  let pos, review;
  try {
    pos = await api('/api/endgame/new', { spec, mode, color });
    review = await api('/api/play/new', { color, level: level.id, fen: pos.fen });
  } catch (e) {
    if (open) { $('eg-status').textContent = e.message; $('eg-grid').classList.remove('busy'); }
    else addMsg('error', esc(e.message));
    return;
  }
  $('eg-grid').classList.remove('busy');
  if (open) $('dlg-endgame').close();
  playToken++;
  egRecord(`${spec}|${mode}`, 'tries');
  const play = { color, level: level.id, levelName: level.name, startFen: review.start_fen, moves: [], view: 0, over: null, thinking: false, clock: null,
    endgame: { spec, mode, pick, outcome: pos.outcome, expect: pos.outcome, source: pos.source, dtm: pos.dtm, mine: pos.mine, theirs: pos.theirs,
      points: pos.points, slips: 0, held: false, done: false } };
  setEngineVisible(false);  // the eval bar would give the answer away; the toggle still turns it on
  setReview(review, `Endgame drill: ${egSpecLabel(spec)}, you have ${color}.`, play);
  egGoalCard(play.endgame, color);
  egProbe(review.start_fen);
}

function egGoalCard(eg, color) {
  const goal = eg.outcome === 'win' ? 'Win it: checkmate the bot' : `Hold the draw: reach a drawn ending, or survive ${EG_HOLD_MOVES} moves`;
  const how = eg.source === 'tablebase' ? `Tablebase: ${eg.outcome}${eg.outcome === 'win' && eg.dtm ? `, mate in ${Math.ceil(Math.abs(eg.dtm) / 2)} with best play` : ''}`
    : 'Stockfish (too many pieces for the tablebase): ' + (eg.outcome === 'win' ? 'winning' : 'about 0.0');
  const diff = eg.points[0] - eg.points[1];
  const material = `Material: you ${eg.points[0]}, the bot ${eg.points[1]} (${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff)})`;
  const lies = eg.mode === 'lies' ? `<div class="eg-lie">The count says you're worse. ${eg.outcome === 'win' ? "It's a win for you anyway." : "It's a draw anyway."}</div>` : '';
  addMsg('coach sb-msg', `<div class="eg-card"><div class="eg-ch"><span class="sb-al">Endgame drill</span>`
    + `<span class="eg-art"><span class="${color === 'white' ? 'w' : 'b'}">${egGlyphs(eg.mine, color === 'white')}</span><span class="eg-vs">vs</span>`
    + `<span class="${color === 'white' ? 'b' : 'w'}">${egGlyphs(eg.theirs, color !== 'white')}</span></span></div>`
    + `<div class="eg-goal">${esc(goal)}</div>${lies}<div class="card-sub">${esc(material)} · ${esc(how)}</div></div>`);
}

function egProbe(fen) {
  if (!egProbes.has(fen)) {
    egProbes.set(fen, api('/api/endgame/probe', { fen }).catch(() => ({ covered: false })));
    if (egProbes.size > 300) egProbes.delete(egProbes.keys().next().value);
  }
  return egProbes.get(fen);
}

// After each of your moves: did it keep the result? (tablebase only; above 7 pieces there's no check)
async function egAfterMyMove(p, fenBefore, uci, label) {
  const eg = p.endgame;
  const tb = await egProbe(fenBefore);
  if (state.play !== p || !tb.covered) return;
  const mv = tb.moves.find((m) => m.uci === uci || m.uci.slice(0, 4) === uci.slice(0, 4));
  if (!mv?.outcome) return;
  if (EG_RANK[mv.outcome] < EG_RANK[eg.expect]) {
    eg.slips++;
    const lost = eg.expect === 'win' ? 'the win' : 'the draw';
    const best = tb.moves.filter((m) => m.outcome === eg.expect).slice(0, 3).map((m) => m.san);
    addMsg('coach sb-msg', `<div class="sb-alert t3 fresh"><span class="sb-al">Tablebase</span> 💥 ${esc(label)} throws away ${lost}: it's ${mv.outcome === 'loss' ? 'lost' : 'a draw'} now.`
      + ` ${best.length ? `Best was ${esc(best.join(', '))}.` : ''} Take it back and try again, or play on.</div>`);
    eg.expect = mv.outcome;
  }
}

// At the start of your turn: the bot's move can't make it better for it, but it can blunder (rare).
async function egMyTurn(p, fen) {
  const eg = p.endgame;
  const tb = await egProbe(fen);
  if (state.play !== p || !tb.covered || p.over) return;
  if (EG_RANK[tb.outcome] > EG_RANK[eg.expect]) {
    addMsg('coach sb-msg', `<div class="sb-alert good fresh"><span class="sb-al">Tablebase</span> The bot slipped: it's ${tb.outcome === 'win' ? 'a win' : 'a draw'} for you again.</div>`);
    eg.expect = tb.outcome;
  }
  // "hold the draw" is done after enough moves with the draw kept
  const mine = Math.ceil(p.moves.length / 2);
  if (eg.outcome === 'draw' && !eg.held && mine >= EG_HOLD_MOVES && eg.expect !== 'loss') {
    eg.held = true;
    egFinish(p, true, `You held the draw for ${EG_HOLD_MOVES} moves.`);
  }
}

// a takeback after a slip: the goal is whatever the tablebase says for the position you're back at, and a
// finished drill (a draw you ended, say) is open again
async function egTakeback(p) {
  const eg = p.endgame;
  if (!eg.ok) eg.done = false;
  const tb = await egProbe(playChess(p).fen());
  if (state.play === p && tb.covered) eg.expect = tb.outcome;
}

function egFinish(p, ok, text) {
  const eg = p.endgame;
  if (eg.done) return;
  eg.done = true;
  eg.ok = ok;
  if (ok) egRecord(`${eg.spec}|${eg.mode}`, 'done');
  const slips = eg.slips ? ` ${eg.slips} slip${eg.slips > 1 ? 's' : ''} on the way.` : eg.source === 'tablebase' ? ' No slips.' : '';
  const msg = addMsg('coach sb-msg', `<div class="eg-card ${ok ? 'ok' : 'fail'}"><div class="eg-goal">${ok ? '✓ Drill done' : '✗ Not this time'}</div>`
    + `<div class="card-sub">${esc(text)}${esc(slips)}</div><div class="eg-actions"><button class="btn small" data-a="again">Another one</button>`
    + `<button class="btn ghost small" data-a="pick">Pick other material</button></div></div>`);
  msg.querySelector('[data-a=again]').onclick = () => startEndgame(eg.spec, eg.mode, eg.pick);
  msg.querySelector('[data-a=pick]').onclick = openEndgames;
}

// called from endGame(): the drill's verdict on how the game ended
function egGameOver(p, outcome) {
  const eg = p.endgame;
  if (!eg || eg.done) return;
  if (outcome === 'win') egFinish(p, true, 'Checkmate.');
  else if (outcome === 'draw') egFinish(p, eg.outcome === 'draw', eg.outcome === 'draw' ? 'Drawn, as the position deserved.' : 'It ended in a draw; the position was a win.');
  else egFinish(p, false, 'The bot won.');
}

// ---------------------------------------------------------------- saved positions
// 💾 saves whatever the board shows (a loaded game, a pasted PGN, a set-up position, a bot game) as its
// line: start position + moves, so reopening it on the analysis board can still step back through it.
// Stored server-side (core/positions.py), so every device on the tailnet sees the same list.

const PIECE_GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

// a small static board for the list and the save dialog (no chessground: dozens of these at once)
function miniBoard(fen, orientation = 'white') {
  const rows = fen.split(' ')[0].split('/');
  const cells = [];
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < +ch; i++, f++) cells.push({ r, f, piece: '' });
      } else {
        cells.push({ r, f, piece: ch });
        f++;
      }
    }
  });
  if (orientation === 'black') cells.reverse();
  return cells.map(({ r, f, piece }) => `<span class="pm-sq ${(r + f) % 2 ? 'd' : 'l'}">${piece
    ? `<span class="pm-pc ${piece === piece.toUpperCase() ? 'w' : 'b'}">${PIECE_GLYPH[piece.toLowerCase()]}</span>` : ''}</span>`).join('');
}

// what's on the board now, as a line, plus a few words about where it came from
function boardToSave() {
  if (state.editor) {
    return { start_fen: editorFen(), moves: [], fen: editorFen(), source: 'Set-up position' };
  }
  const line = currentLine();
  const moves = line.sans.slice(0, line.at);
  const r = state.review;
  const source = state.play ? `Bot game vs ${state.play.levelName}`
    : state.study ? `Lesson: ${state.study.data?.name || 'opening'}`
    : r.moves.length ? `${r.white} vs ${r.black}`
    : line.startFen !== START_FEN ? 'Set-up position' : 'Analysis board';
  return { start_fen: line.startFen, moves, fen: currentGame().fen(), source };
}

function openSavePosition() {
  if (!state.review && !state.editor) return;
  const b = boardToSave();
  const [, turn, , , , num] = b.fen.split(' ');
  const where = `Move ${num}, ${turn === 'w' ? 'White' : 'Black'} to move`;
  const opening = $('opening-tag').classList.contains('hidden') ? '' : $('opening-tag').querySelector('.ot-name')?.textContent || '';
  $('pos-save-board').innerHTML = miniBoard(b.fen, state.orientation);
  $('pos-title').value = opening ? `${opening.split(',')[0]}, move ${num}` : where;
  $('pos-save-sub').textContent = `${where} · ${b.source}`;
  $('pos-save-go').onclick = async () => {
    const title = $('pos-title').value.trim();
    if (!title) return void $('pos-title').focus();
    try {
      await api('/api/positions', { title, start_fen: b.start_fen, moves: b.moves, orientation: state.orientation, source: b.source });
    } catch (e) {
      $('pos-save-sub').textContent = e.message;
      return;
    }
    $('dlg-save-pos').close();
    addMsg('system', `📌 Saved “${esc(title)}”. Find it under 📌 Positions.`);
  };
  $('dlg-save-pos').showModal();
  $('pos-title').select();
}

let savedPositions = [];

async function openPositions() {
  $('dlg-positions').showModal();
  $('pos-list').innerHTML = '<div class="card-sub">Loading…</div>';
  try { savedPositions = await api('/api/positions'); } catch (e) { return void ($('pos-list').textContent = e.message); }
  renderPositions();
}

function renderPositions() {
  const q = $('pos-q').value.trim().toLowerCase();
  const list = savedPositions.filter((p) => !q || [p.title, p.opening, p.source].join(' ').toLowerCase().includes(q));
  if (!list.length) {
    $('pos-list').innerHTML = `<div class="card-sub">${savedPositions.length ? 'Nothing matches.' : 'No saved positions yet: 💾 under the board saves the one on it.'}</div>`;
    return;
  }
  $('pos-list').innerHTML = list.map((p) => {
    const [, turn, , , , num] = p.fen.split(' ');
    const date = new Date(p.created_at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    return `<div class="pos-item" data-id="${p.id}">
      <button class="pos-mini" title="Open on the analysis board">${miniBoard(p.fen, p.orientation)}</button>
      <div class="pos-info">
        <div class="pos-title" title="Double-click to rename">${esc(p.title)}</div>
        <div class="card-sub">Move ${num}, ${turn === 'w' ? 'White' : 'Black'} to move${p.opening ? ` · ${esc(p.opening)}` : ''}</div>
        <div class="card-sub">${esc(p.source || '')}${p.source ? ' · ' : ''}${date}</div>
        <div class="pos-actions"><button class="btn small pos-open">Open</button>
          <button class="link pos-rename">Rename</button><button class="link pos-del">Delete</button></div>
      </div></div>`;
  }).join('');
  $('pos-list').querySelectorAll('.pos-item').forEach((el) => {
    const p = savedPositions.find((x) => x.id === +el.dataset.id);
    el.querySelector('.pos-mini').onclick = el.querySelector('.pos-open').onclick = () => openSavedPosition(p);
    const rename = async () => {
      const title = prompt('Rename this position', p.title)?.trim();
      if (!title || title === p.title) return;
      try { await api(`/api/positions/${p.id}`, { title }); } catch (e) { return void alert(e.message); }
      p.title = title;
      renderPositions();
    };
    el.querySelector('.pos-rename').onclick = rename;
    el.querySelector('.pos-title').ondblclick = rename;
    el.querySelector('.pos-del').onclick = async () => {
      if (!confirm(`Delete “${p.title}”?`)) return;
      try { await api(`/api/positions/${p.id}`, undefined, 'DELETE'); } catch (e) { return void alert(e.message); }
      savedPositions = savedPositions.filter((x) => x.id !== p.id);
      renderPositions();
    };
  });
}

// reopen on a fresh analysis board from its start position, with the moves on top, at the saved move
async function openSavedPosition(p) {
  let review;
  try { review = await api('/api/analysis', { fen: p.start_fen }); } catch (e) { return void alert(e.message); }
  $('dlg-positions').close();
  setReview(review, null);
  state.extra = p.moves.slice();
  state.orientation = p.orientation;
  update();
  addMsg('system', `📌 ${esc(p.title)}${p.source ? ` (${esc(p.source)})` : ''}`);
}

$('nav-save').onclick = openSavePosition;
$('btn-positions').onclick = openPositions;
$('pos-q').oninput = renderPositions;
$('pos-save-current').onclick = () => { $('dlg-positions').close(); openSavePosition(); };
$('pos-title').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('pos-save-go').click(); } };

// ---------------------------------------------------------------- wiring

$('pb-takeback').onclick = takeback;
$('btn-play').onclick = () => { pendingFen = null; openPlayDialog(); };
$('btn-library').onclick = openLibrary;
$('lib-q').oninput = () => { clearTimeout(libTimer); libTimer = setTimeout(searchLibrary, 250); };
$('lib-starred').onchange = searchLibrary;
$('lib-habits').onchange = searchLibrary;

$('dlg-play').addEventListener('close', () => { if (!state.editor) pendingFen = null; });
$('play-go').onclick = startGame;
$('play-clock-on').onchange = (e) => $('play-clock-fields').classList.toggle('hidden', !e.target.checked);
$('play-color').querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    playColor = b.dataset.color;
    $('play-color').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  };
});

function openGamesDialog() {
  $('games-user').value = state.me;
  if (!$('games-user-lichess').value) $('games-user-lichess').value = recall('meLichess') || '';
  $('dlg-games').showModal();
  showGamesTab(navigator.onLine === false ? 'saved' : 'chesscom');
  pollPrefetch();
}
$('btn-games').onclick = openGamesDialog;
$('games-tabs').querySelectorAll('button').forEach((b) => { b.onclick = () => showGamesTab(b.dataset.tab); });
$('games-prefetch').onclick = () => startPrefetch('chesscom');
$('games-prefetch-lichess').onclick = () => startPrefetch('lichess');
$('games-fetch').onclick = () => showGames();
$('games-user').onkeydown = (e) => { if (e.key === 'Enter') showGames(); };
$('games-fetch-lichess').onclick = () => showGames('lichess');
$('games-user-lichess').onkeydown = (e) => { if (e.key === 'Enter') showGames('lichess'); };

$('btn-load').onclick = () => $('dlg-load').showModal();
// ---- PGN files: pick or drop; files with several games get a list to choose from
function splitPgn(text) {
  // every game in a PGN file starts with an [Event "..."] header; a single game may have none
  const clean = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').trim();
  const games = /^\[Event /m.test(clean) ? clean.split(/\n(?=\[Event )/) : [clean];
  return games.map((g) => g.trim()).filter((g) => /\d+\.\s*\S/.test(g.replace(/^\[.*\]$/gm, '')));
}

function pgnHeader(pgn, key) {
  return pgn.match(new RegExp(`\\[${key} "([^"]*)"\\]`))?.[1] ?? '';
}

async function loadPgnText(text, fileName = '') {
  const games = splitPgn(text);
  $('load-file-name').textContent = fileName ? `${fileName}: ${games.length} game${games.length === 1 ? '' : 's'}` : '';
  if (!games.length) { $('load-file-name').textContent = "That file doesn't look like a PGN."; return; }
  if (games.length === 1) {
    $('dlg-load').close();
    loadGame(games[0]);
    return;
  }
  const box = $('pgn-games');
  box.classList.remove('hidden');
  box.innerHTML = games.map((g, i) => `<div class="game-row" data-i="${i}">
      <span class="who">${esc(pgnHeader(g, 'White') || '?')} – ${esc(pgnHeader(g, 'Black') || '?')}</span>
      <span class="res">${esc(pgnHeader(g, 'Result'))}</span>
      <span class="meta">${esc(pgnHeader(g, 'Date'))} · ${esc(pgnHeader(g, 'Event'))}</span>
    </div>`).join('');
  box.querySelectorAll('.game-row').forEach((el) => {
    el.onclick = () => { $('dlg-load').close(); loadGame(games[+el.dataset.i]); };
  });
}

$('load-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (file) await loadPgnText(await file.text(), file.name);
  e.target.value = '';
};
$('load-text').addEventListener('dragover', (e) => { e.preventDefault(); $('load-text').classList.add('drop'); });
$('load-text').addEventListener('dragleave', () => $('load-text').classList.remove('drop'));
$('load-text').addEventListener('drop', async (e) => {
  e.preventDefault();
  $('load-text').classList.remove('drop');
  const file = e.dataTransfer.files[0];
  if (file) await loadPgnText(await file.text(), file.name);
});
$('dlg-load').addEventListener('close', () => {
  $('pgn-games').classList.add('hidden');
  $('pgn-games').innerHTML = '';
  $('load-file-name').textContent = '';
});

$('load-go').onclick = () => {
  const ref = $('load-text').value.trim();
  if (!ref) return;
  $('dlg-load').close();
  $('load-text').value = '';
  loadGame(ref);
};

$('btn-study').onclick = openStudyDialog;
$('btn-endgames').onclick = openEndgames;
$('auto-coach').checked = autoCoach();
$('auto-coach').onchange = (e) => store('autoCoach', e.target.checked ? '1' : '0');

// Hide/show the scoreboard and the chat (user's call): a hidden panel becomes a thin tab, the board grows into
// the space (CSS: body.hide-score / body.hide-chat). Remembered per browser.
function setPanelHidden(which, hidden) {
  document.body.classList.toggle(`hide-${which}`, hidden);
  store(`hide-${which}`, hidden ? '1' : '0');
  // the board changed size: chessground recomputes its square geometry
  requestAnimationFrame(() => { document.body.dispatchEvent(new Event('chessground.resize')); cg.redrawAll(); });
}
document.querySelectorAll('[data-hide]').forEach((b) => { b.onclick = () => setPanelHidden(b.dataset.hide, true); });
document.querySelectorAll('[data-show]').forEach((b) => { b.onclick = () => setPanelHidden(b.dataset.show, false); });
for (const w of ['score', 'chat']) if (recall(`hide-${w}`) === '1') document.body.classList.add(`hide-${w}`);
// Side nav groups: open/closed remembered per browser. ≤ 1000 px the nav is a top bar where the groups can't
// be toggled, so they're all opened there (a closed <details> can't be shown by CSS alone).
const navNarrow = matchMedia('(max-width: 1000px)');
document.querySelectorAll('.nav-group').forEach((g) => {
  if (recall(`nav-${g.dataset.group}`) === '0' && !navNarrow.matches) g.open = false;
  g.addEventListener('toggle', () => { if (!navNarrow.matches) store(`nav-${g.dataset.group}`, g.open ? '1' : '0'); });
});
navNarrow.addEventListener('change', () => document.querySelectorAll('.nav-group').forEach((g) => {
  g.open = navNarrow.matches || recall(`nav-${g.dataset.group}`) !== '0';
}));
function setNavCollapsed(on) {
  document.body.classList.toggle('nav-collapsed', on);
  $('nav-collapse').textContent = on ? '›' : '‹';
  $('nav-collapse').title = on ? 'Show the menu' : 'Hide the menu';
  store('navCollapsed', on ? '1' : '0');
  requestAnimationFrame(() => { document.body.dispatchEvent(new Event('chessground.resize')); cg.redrawAll(); });
}
$('nav-collapse').onclick = () => setNavCollapsed(!document.body.classList.contains('nav-collapsed'));
if (recall('navCollapsed') === '1') setNavCollapsed(true);
// as a top bar the nav wraps to 1-3 rows; the board's height budget reads its real height (0 as a side nav)
new ResizeObserver(() => {
  const h = navNarrow.matches ? Math.ceil($('side-nav').getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--head-h', `${h}px`);
}).observe($('side-nav'));
// the rows above the board (game info, names, buttons) wrap too: the scoreboard lines up with the board's top
// edge (user's call), so it reads their real height (CSS --board-top)
const boardTop = () => document.documentElement.style.setProperty('--board-top',
  `${Math.round($('board-wrap').getBoundingClientRect().top - document.querySelector('.board-col').getBoundingClientRect().top)}px`);
const boardTopObs = new ResizeObserver(boardTop);
boardTopObs.observe(document.querySelector('.board-head'));
boardTopObs.observe(document.querySelector('.top-row'));
$('btn-setup').onclick = openEditor;  // starts from the position on the board; Cancel returns to it
$('study-go').onclick = startStudyFromDialog;
$('study-q').oninput = (e) => { studyPick = null; $('study-go').disabled = true; searchStudies(e.target.value); };

$('btn-analysis').onclick = async () => {
  const review = await api('/api/analysis', {});
  setReview(review, 'Fresh analysis board. Play moves and ask the coach anything.');
};


$('btn-back-to-game').onclick = () => { state.extra = []; update(); };
$('nav-start').onclick = () => goTo(0);
$('nav-prev').onclick = back;
$('nav-next').onclick = forward;
$('nav-end').onclick = () => (state.demo ? demoStep(state.demo.moves.length)
  : state.play ? playView(state.play.moves.length) : state.study ? studyEnd() : goTo(state.review.moves.length));
$('nav-flip').onclick = () => {
  state.orientation = state.orientation === 'white' ? 'black' : 'white';
  update();
};
// moves/engine/explorer live in a dropdown off the game panel, closed by default; board + chat
// stay the main event and never resize when it opens
function closeGpDropdown() {
  const d = $('gp-details');
  d.classList.add('hidden');
  d.style.cssText = '';  // forget where it was dragged to; it reopens anchored to the button
  $('gp-toggle').classList.add('collapsed');
}

// Drag the dropdown by its handle, or resize it from any side/corner. Either one turns it into
// position: fixed at its current spot first (absolute + the chat panel's overflow: hidden would
// clip it at the panel's edge), so it can go anywhere in the window. Pointer capture keeps the
// release on the handle, so the document click-outside handler below doesn't see it as a click off
// the dropdown. closeGpDropdown() clears all the inline styles set here.
(() => {
  const handle = $('gp-drag'), box = $('gp-details');
  const MIN_W = 260, MIN_H = 160;
  let grab = null;

  const detach = () => {
    const r = box.getBoundingClientRect();
    Object.assign(box.style, { position: 'fixed', margin: '0', right: 'auto', left: `${r.left}px`, top: `${r.top}px` });
    return r;
  };

  handle.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const r = detach();
    grab = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    box.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  handle.onpointermove = (e) => {
    if (!grab) return;
    // keep the handle inside the window so it can't be dragged out of reach
    box.style.left = `${Math.min(innerWidth - 60, Math.max(60 - box.offsetWidth, e.clientX - grab.dx))}px`;
    box.style.top = `${Math.min(innerHeight - 30, Math.max(0, e.clientY - grab.dy))}px`;
  };
  handle.onpointerup = handle.onpointercancel = () => { grab = null; box.classList.remove('dragging'); };

  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const el = document.createElement('div');
    el.className = 'gp-rs';
    el.dataset.dir = dir;
    let start = null;
    el.onpointerdown = (e) => {
      if (e.button !== 0) return;
      const r = detach();
      // an explicit size replaces the content-sized default and its max-height cap
      Object.assign(box.style, { width: `${r.width}px`, height: `${r.height}px`, maxHeight: 'none' });
      start = { x: e.clientX, y: e.clientY, r };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    el.onpointermove = (e) => {
      if (!start) return;
      const { r } = start;
      const px = Math.min(innerWidth, Math.max(0, e.clientX)), py = Math.min(innerHeight, Math.max(0, e.clientY));
      const dx = px - start.x, dy = py - start.y;
      let { left, top, right, bottom } = r;
      if (dir.includes('e')) right = Math.max(left + MIN_W, r.right + dx);
      if (dir.includes('w')) left = Math.min(right - MIN_W, r.left + dx);
      if (dir.includes('s')) bottom = Math.max(top + MIN_H, r.bottom + dy);
      if (dir.includes('n')) top = Math.min(bottom - MIN_H, r.top + dy);
      Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    };
    el.onpointerup = el.onpointercancel = () => { start = null; };
    box.appendChild(el);
  }
})();
$('gp-toggle').onclick = (e) => {
  e.stopPropagation();
  $('gp-details').classList.remove('hidden');
  $('gp-toggle').classList.remove('collapsed');
  // the folded list can't scroll to the current move while the panel is hidden, so do it on open
  $('moves').querySelector('.mv.active')?.scrollIntoView({ block: 'nearest' });
};
// Moves & engine closes only with its ✕ (user's call): outside clicks, Esc and the toggle leave it open.
$('gp-close').onclick = closeGpDropdown;
closeGpDropdown();

$('engine-toggle').onchange = (e) => setEngine(e.target.checked);
$('x-lines').onclick = showLines;
$('moves-more').onclick = (e) => {
  e.stopPropagation();
  movesExpanded = !movesExpanded;
  renderMoves();
};

$('chat-form').onsubmit = (e) => { e.preventDefault(); ask($('chat-text').value); };
$('chat-text').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('chat-text').value); }
};
$('btn-chat-reset').onclick = async () => {
  await api('/api/chat/reset', {});
  resetChatUi('New conversation started.');
};

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, dialog')) return;
  if (e.key === 'ArrowLeft') back();
  else if (e.key === 'ArrowRight') forward();
  else if (e.key === 'Home') goTo(0);
  else if (e.key === 'End') $('nav-end').click();
  else if (e.key === 'f') $('nav-flip').click();
  else if (e.key === 's' && !e.metaKey && !e.ctrlKey) openSavePosition();
  else if (e.key === 'Escape' && pinnedSquares.size) { pinnedSquares.clear(); paintSquares(); }
  else if (e.key === 'Escape' && state.demo) closeDemo();
  else if (e.key === 'Escape' && state.replay) stopReplay();
  else return;
  e.preventDefault();
});

(async function init() {
  const cfg = await api('/api/config');
  state.coachReady = cfg.coach_ready;
  state.explorerReady = cfg.explorer_ready;
  setupMaia(cfg);
  state.me = recall('me') || cfg.me || '';
  const engineOn = recall('engineOn') !== '0';
  $('engine-toggle').checked = engineOn;
  state.engineOn = engineOn;
  $('evalbar').classList.toggle('off', !engineOn);
  $('engine-lines').classList.toggle('hidden', !engineOn);
  const review = await api('/api/review');
  const linked = +(location.hash.match(/ply=(\d+)/)?.[1] || 0);
  if (restoreBoard(review)) {
    if (!cfg.coach_ready) addMsg('system', esc('Coach offline: set ANTHROPIC_API_KEY and restart the server to chat. Board and engine work without it.'));
    return;
  }
  // no intro text in the chat; only the warning when the coach can't answer
  setReview(review, cfg.coach_ready ? null
    : 'Coach offline: set ANTHROPIC_API_KEY and restart the server to chat. Board and engine work without it.');
  if (linked) goTo(linked);
})();
