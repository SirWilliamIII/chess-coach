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
    brushes: {
      green:    { key: 'green',    color: '#15781B', opacity: 1,    lineWidth: 10 },
      red:      { key: 'red',      color: '#882020', opacity: 1,    lineWidth: 10 },
      blue:     { key: 'blue',     color: '#003088', opacity: 1,    lineWidth: 10 },
      yellow:   { key: 'yellow',   color: '#e68f00', opacity: 1,    lineWidth: 10 },
      paleBlue: { key: 'paleBlue', color: '#003088', opacity: 0.4,  lineWidth: 15 },
      paleGreen:{ key: 'paleGreen',color: '#15781B', opacity: 0.4,  lineWidth: 15 },
      paleRed:  { key: 'paleRed',  color: '#882020', opacity: 0.4,  lineWidth: 15 },
      paleGrey: { key: 'paleGrey', color: '#4a4a4a', opacity: 0.35, lineWidth: 15 },
      // Maia's likely human moves, width by probability (>= 40%, >= 15%, >= 5%)
      maiaHi:   { key: 'maiaHi',   color: '#8a4fc0', opacity: 0.85, lineWidth: 13 },
      maiaMed:  { key: 'maiaMed',  color: '#8a4fc0', opacity: 0.65, lineWidth: 9 },
      maiaLo:   { key: 'maiaLo',   color: '#8a4fc0', opacity: 0.45, lineWidth: 6 },
      // arrows/circles you draw with a right-drag, colour by modifier key (drawBrush)
      drawCmd:  { key: 'drawCmd',  color: '#BF5700', opacity: 0.9,  lineWidth: 10 },
      drawOpt:  { key: 'drawOpt',  color: '#7BAFD4', opacity: 0.9,  lineWidth: 10 },
      drawCtrl: { key: 'drawCtrl', color: '#f9a01b', opacity: 0.9,  lineWidth: 10 },
      drawFn:   { key: 'drawFn',   color: '#ff2800', opacity: 0.9,  lineWidth: 10 },
      // piece-hover arrows: slim + opaque enough to read clearly
      hvMove:       { key: 'hvMove',      color: '#81b64c', opacity: 0.78, lineWidth: 7 },
      hvCapture:    { key: 'hvCapture',   color: '#e08030', opacity: 0.82, lineWidth: 7 },
      hvCheck:      { key: 'hvCheck',     color: '#f7c045', opacity: 0.88, lineWidth: 7 },
      // threat arrows (opponent's replies): darker, so they read as a warning, not a suggestion
      hvOpp:        { key: 'hvOpp',       color: '#2c5674', opacity: 0.72, lineWidth: 6 },
      hvOppCapture: { key: 'hvOppCapture',color: '#8f2422', opacity: 0.85, lineWidth: 6 },
      hvOppCheck:   { key: 'hvOppCheck',  color: '#b8262b', opacity: 0.92, lineWidth: 6 },
      // "Mid" variants: the first leg of a knight's L-shaped arrow, same color, no arrowhead
      // (the marker triangle is hidden in CSS — see marker[id$="Mid"] in style.css)
      hvMoveMid:       { key: 'hvMoveMid',       color: '#81b64c', opacity: 0.78, lineWidth: 7 },
      hvCaptureMid:    { key: 'hvCaptureMid',    color: '#e08030', opacity: 0.82, lineWidth: 7 },
      hvCheckMid:      { key: 'hvCheckMid',      color: '#f7c045', opacity: 0.88, lineWidth: 7 },
      hvOppMid:        { key: 'hvOppMid',        color: '#2c5674', opacity: 0.72, lineWidth: 6 },
      hvOppCaptureMid: { key: 'hvOppCaptureMid', color: '#8f2422', opacity: 0.85, lineWidth: 6 },
      hvOppCheckMid:   { key: 'hvOppCheckMid',   color: '#b8262b', opacity: 0.92, lineWidth: 6 },
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
  let html = '';
  for (const k of ['p', 'n', 'b', 'r', 'q']) {
    const n = Math.max(0, START[k] - mat.count[opp][k]);
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

// On the empty analysis board the "Moves & engine" panel takes the spot the "Analysis board" title
// used to have (left of the chat header); everywhere else it lives in .chat-head-right. It has to
// be moved back before anything overwrites #game-info, or that assignment would delete it.
function dockGamePanel(inTitle) {
  const gp = document.querySelector('.game-panel');
  gp.classList.toggle('in-title', inTitle);
  const home = inTitle ? $('game-info') : document.querySelector('.chat-head-right');
  if (gp.parentElement === home) return;
  if (inTitle) { $('game-info').textContent = ''; home.appendChild(gp); }
  else home.insertBefore(gp, $('btn-chat-reset'));  // keeps Takeback Move first, New chat last
}

// "Takeback Move" lives in the chat header (a static button in index.html), shown only in a bot game
function syncTakeback() {
  const p = state.play;
  $('pb-takeback').classList.toggle('hidden', !p || !!state.demo);
  $('pb-takeback').disabled = !p || p.moves.length <= (p.prefix || 0);
}

function renderInfo() {
  const r = state.review;
  dockGamePanel(!state.demo && !state.play && !state.study && !r.moves.length);
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
    $('board-sub').textContent = 'Move pieces freely and ask the coach about any position.';
    // visible toggle: the dashed-underline name labels alone don't read as clickable
    $('summary').innerHTML = `<div class="me-pick"><span class="label">I'm playing</span><div class="seg">`
      + ['white', 'black'].map((c) => `<button data-me="${c}" class="${r.player_color === c ? 'on' : ''}">${c === 'white' ? 'White' : 'Black'}</button>`).join('')
      + '</div></div>';
    $('summary').querySelectorAll('[data-me]').forEach((b) => { b.onclick = () => setYou(b.dataset.me); });
    return;
  }
  $('game-info').innerHTML = `${esc(r.white)} vs ${esc(r.black)} · ${esc(r.result)}`;
  $('board-sub').textContent = r.opening || '';

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
      const data = await api('/api/eval', { fen: c.fen(), lines: 3 });
      if (token !== evalToken) return;
      lastEval = { fen: c.fen(), lines: data.lines };
      showEval(data);
      renderMaia();
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
  $('engine-lines').innerHTML = data.lines.map((l) =>
    `<div class="eline"><span class="ev ${l.cp_white >= 0 ? 'w' : 'b'}">${esc(l.eval_white)}</span><span class="pv">${esc(l.line)}</span></div>`
  ).join('');
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
      renderShapes();  // the arrows (if on) arrive after the board was drawn
    } catch (e) {
      if (token === maiaToken) $('maia-lines').textContent = e.message;
    }
  }, 200);
}

// Maia's likely moves as arrows, thicker for likelier ones. Off in lessons (they draw their own guide)
// and in bot games, where on your turn they'd be a standing move hint (the bot replies too fast for
// arrows on its turn to matter); the panel's list still shows the moves there.
function maiaShapes() {
  if (!lastMaia || !maiaOn() || !$('maia-arrows').checked || state.study || state.editor || state.play) return [];
  if (currentGame().fen() !== lastMaia.fen) return [];
  return lastMaia.moves.filter((m) => m.pct >= 5).slice(0, 4).map((m) => ({
    orig: m.uci.slice(0, 2), dest: m.uci.slice(2, 4), brush: m.pct >= 40 ? 'maiaHi' : m.pct >= 15 ? 'maiaMed' : 'maiaLo',
  }));
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
    return `<div class="mline${best ? ' best' : ''}" title="${tip}" data-uci="${esc(m.uci)}">
      <span class="mmove">${esc(m.move)}</span>
      <span class="mbar"><span style="width:${Math.max(2, m.pct)}%"></span></span>
      <span class="mpct">${m.pct < 1 ? '<1' : Math.round(m.pct)}%</span>
      <span class="mev">${hit ? esc(hit.eval_white) : ''}${best ? ' ★' : ''}</span></div>`;
  }).join('');
  $('maia-lines').querySelectorAll('.mline').forEach((el) => { el.onclick = () => playMaiaMove(el.dataset.uci); });
}

function setupMaia(cfg) {
  state.maiaReady = !!cfg.maia_ready;
  $('maia-pane').classList.toggle('hidden', !state.maiaReady);
  if (!state.maiaReady) return;
  const old = recall('maiaRating') || 1500;  // the single rating from before White/Black were split
  const refresh = () => requestMaia(state.editor ? null : currentGame());
  for (const [id, key] of [['maia-white', 'maiaWhite'], ['maia-black', 'maiaBlack']]) {
    const saved = +(recall(key) || old);
    $(id).innerHTML = cfg.maia_ratings.map((r) =>
      `<option value="${r}"${r === saved ? ' selected' : ''}>~${r}</option>`).join('');
    $(id).onchange = (e) => { store(key, e.target.value); refresh(); };
  }
  const syncDisabled = () => {
    const on = $('maia-toggle').checked;
    $('maia-white').disabled = $('maia-black').disabled = $('maia-arrows').disabled = !on;
  };
  $('maia-toggle').checked = recall('maiaOn') !== '0';
  $('maia-arrows').checked = recall('maiaArrows') === '1';
  syncDisabled();
  $('maia-toggle').onchange = (e) => {
    store('maiaOn', e.target.checked ? '1' : '0');
    syncDisabled();
    refresh();
    renderShapes();
  };
  $('maia-arrows').onchange = (e) => { store('maiaArrows', e.target.checked ? '1' : '0'); renderShapes(); };
}

function setEngineVisible(on) {
  state.engineOn = on;
  $('engine-toggle').checked = on;
  $('evalbar').classList.toggle('off', !on);
  $('engine-lines').classList.toggle('hidden', !on);
}

function setEngine(on) {
  state.engineOn = on;
  if (!state.play) store('engineOn', on ? '1' : '0');
  $('evalbar').classList.toggle('off', !on);
  $('engine-lines').classList.toggle('hidden', !on);
  if (on) requestEval(currentGame());
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
  hoverPieceSq = null;  // position changed; next mousemove will re-draw
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
  requestExplorer(c);
  noteMove();
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
  const marks = new Map(studyNextSquares());
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

// ---- piece hover: show legal-move arrows for the side to move

let hoverPieceSq = null;

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

// legal-move arrows for the piece on `sq` — [] if none apply right now (empty square, game
// over, editor/demo mode, or not the player's turn in a live bot game)
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
  let moves;
  if (isOpponent) {
    // Flip the turn in the FEN so chess.js returns this piece's legal moves
    const parts = c.fen().split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    try { moves = new Chess(parts.join(' ')).moves({ verbose: true, square: sq }); }
    catch { return []; }
  } else {
    moves = c.moves({ verbose: true, square: sq });
  }
  return moves.flatMap((m) => {
    const brush = moveBrush(m, isOpponent);
    return m.piece === 'n' ? knightShapes(m.from, m.to, brush) : [{ orig: m.from, dest: m.to, brush }];
  });
}

function renderShapes() {
  cg.setAutoShapes([...baseShapes(), ...heldThreats, ...(hoverPieceSq ? movesShapesFor(hoverPieceSq) : [])]);
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

function userShape(s) {
  const brush = drawBrush(drawMods);
  if (s.dest) toggleDrawing({ orig: s.orig, dest: s.dest, brush: brush || 'green' });
  else if (brush) toggleDrawing({ orig: s.orig, brush });  // a modifier on one square: circle it
  else holdThreatSquare(s.orig);
}

// drawing the same arrow again removes it (as chessground does); a different colour recolours it
function toggleDrawing(shape) {
  const fen = currentGame().fen();
  if (drawingsFen !== fen) { drawings = []; drawingsFen = fen; }
  const i = drawings.findIndex((d) => d.orig === shape.orig && d.dest === shape.dest);
  const same = i >= 0 && drawings[i].brush === shape.brush;
  if (i >= 0) drawings.splice(i, 1);
  if (!same) drawings.push(shape);
  renderShapes();
}

function drawnShapes() {
  return drawings.length && drawingsFen === currentGame().fen() ? drawings : [];
}

function clearUserShapes() {
  const had = drawings.length || heldSquares.size;
  drawings = [];
  heldSquares.clear();
  heldThreats = [];
  if (had) renderShapes();
}

function showPieceHover(sq) {
  if (sq === hoverPieceSq) return;
  hoverPieceSq = sq;
  renderShapes();
}

// ---- right-click a piece to hold its threat arrows (accumulates across pieces);
// left click resets them all — see the drawable.onChange hook and the board's mousedown listener

let heldThreats = [];
let heldSquares = new Set();

function holdThreatSquare(sq) {
  if (heldSquares.has(sq)) return;
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
  if (tab === 'saved') showSaved();
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
  $('game-info').textContent = '';  // the "Set-up board" tag above the board says it; a title here wrapped beside the buttons
  $('board-sub').textContent = 'Great for endgame practice: set it up, then play it out against the bot.';
  $('summary').innerHTML = `<div class="play-buttons">
      <button class="btn small" id="ed-play" ${problem ? 'disabled' : ''}>Play vs bot from here</button>
      <button class="btn ghost small" id="ed-analyse" ${problem ? 'disabled' : ''}>Analyse</button>
      <button class="btn ghost small" id="ed-cancel">Cancel</button>
    </div><div class="ed-status ${problem ? 'bad' : ''}" id="ed-status">${esc(problem || 'Position OK')}</div>`;
  $('ed-play').onclick = () => { pendingFen = editorFen(); openPlayDialog(); };
  $('ed-analyse').onclick = analyseEditorPosition;
  $('ed-cancel').onclick = () => closeEditor();
  $('variation').classList.add('hidden');
  $('chat-context').textContent = 'Asking about: the set-up position (starts an analysis board)';

  requestMaia(null);  // no move history on a set-up position; the lines would be the old position's
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
      $('ed-play').disabled = $('ed-analyse').disabled = true;
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
  if (!state.study || state.demo) return state.demo ? [] : maiaShapes();
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

let opponentCommentCount = 0;
const OPPONENT_COMMENT_LIMIT = 4;  // just the opening phase — quiet again after that, for cost

async function commentOnOpponentMove(c, san) {
  if (c.isGameOver()) return;
  if (await openingQuip(c)) return;  // the free opening reaction stands in for the paid one-liner this move
  if (!state.coachReady || opponentCommentCount >= OPPONENT_COMMENT_LIMIT) return;
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
  if (!state.coachReady || bigMomentAsked.size >= BIG_MOMENT_MAX || bigMomentAsked.has(ply)) return;
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
  if (!state.coachReady || c.isGameOver()) return;
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
  let mv;
  try {
    mv = c.move({ from: orig, to: dest, promotion: 'q' });
  } catch {
    update();
    return;
  }
  p.moves.push(mv.san);
  if (p.clock) { p.clock[p.color] += p.clock.increment; p.clock.lastTick = Date.now(); }
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
$('btn-setup').onclick = openEditor;  // starts from the position on the board; Cancel returns to it
$('study-go').onclick = startStudyFromDialog;
$('study-q').oninput = (e) => { studyPick = null; $('study-go').disabled = true; searchStudies(e.target.value); };

$('btn-analysis').onclick = async () => {
  const review = await api('/api/analysis', {});
  setReview(review, 'Fresh analysis board. Play moves and ask the coach anything.');
};

$('board').addEventListener('mousemove', (e) => showPieceHover(squareFromEvent(e)));
$('board').addEventListener('mouseleave', () => { hoverPieceSq = null; renderShapes(); });
$('board').addEventListener('mousedown', () => { hoverPieceSq = null; renderShapes(); });

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
  setReview(review, cfg.coach_ready
    ? 'Load one of your games, or play moves on the board and ask the coach about them.'
    : 'Coach offline: set ANTHROPIC_API_KEY and restart the server to chat. Board and engine work without it.');
  if (linked) goTo(linked);
})();
