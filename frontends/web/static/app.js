import { Chessground } from './vendor/chessground-9.2.1.js';
import { Chess } from './vendor/chess-1.4.0.js';

const $ = (id) => document.getElementById(id);
const FLAG = { inaccuracy: '?!', mistake: '?', blunder: '??' };
const PLURAL = { inaccuracy: 'inaccuracies', mistake: 'mistakes', blunder: 'blunders' };

const state = {
  review: null,     // game (or empty analysis board) from the server
  ply: 0,           // board shows the position after this many game plies
  extra: [],        // SAN moves tried on the board on top of that
  orientation: 'white',
  engineOn: true,
  me: '',
  coachReady: false,
  explorerReady: false,
  etab: 'engine',   // bottom panel: 'engine' lines or opening 'explorer'
  audience: 'coach',
  replay: null,     // replaying a loaded game: {color, hint}; the opponent follows the PGN
  chatBusy: false,
  play: null,       // practice game vs the bot: {color, level, levelName, moves, view, over, thinking}
  editor: null,     // position set-up: {tool, turn, prev: {orientation}}
  demo: null,       // coach's "show me" line on a grey board: {title, ply, then_moves, start_fen, moves, notes, step}
};

const CHIPS = {
  review: [
    ['Best move', 'What is the best move here, and why? Keep it concise — concrete effect, my plan, opponent response if relevant.'],
    ['Show me tactics', 'Any tactics here? Tricks, traps or high-risk, high-reward ideas, beyond the safe engine move?'],
    ['Why this move?', 'Why was this move played? Lead with what it does right now. Only include opponent plan or my follow-up if they add real insight.'],
    ['What should I have played?', 'What should have been played instead? Just the concrete difference — what it achieves or what my move allowed.'],
    ['Show me', "Walk me through this position step by step. Ask me what I'd play before each move."],
    ['Show main lines', 'Show me the main lines from this position: how to play them properly, the ideas for both sides, and the key traps.'],
  ],
  play: [
    ['My plan?', 'What plan should I be aiming for in this position? Keep it short and concrete.'],
    ['Show me tactics', 'Any tactics for me here? Tricks, traps or high-risk, high-reward ideas?'],
    ['Their threats?', "What is my opponent threatening right now, and is anything of mine hanging?"],
    ['Hint', "Give me a one-line hint without telling me the move."],
  ],
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
    // right-click a piece to hold its threat arrows (instead of drawing a circle); left click
    // resets them all (chessground's own eraseOnClick already clears its shapes on a left click,
    // which is what fires this with an empty array)
    onChange: (shapes) => {
      if (!shapes.length) { clearHeldThreats(); return; }
      for (const s of shapes.slice(nativeShapesSeen)) holdThreatSquare(s.orig);
      nativeShapesSeen = shapes.length;
      cg.setShapes([]);  // don't let the native circle/arrow render — ours replaces it
    },
  },
});

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
  cg.setAutoShapes([]);
  return c;
}

function onBoardMove(orig, dest) {
  if (state.editor) return updateEditor();
  if (state.demo) return onDemoMove(orig, dest);
  if (state.play) return onPlayMove(orig, dest);
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
  if (state.replay) return turn === state.replay.color && state.ply < state.review.moves.length && !state.extra.length;
  const p = state.play;
  if (!p) return true;
  return !p.over && !p.thinking && p.view === p.moves.length && turn === p.color;
}

function goTo(ply) {
  if (state.editor || (state.replay && !state.demo)) return;
  if (state.demo) return demoStep(ply);
  if (state.play) return playView(ply);
  state.ply = Math.max(0, Math.min(ply, state.review.moves.length));
  state.extra = [];
  update();
}

function back() {
  if (state.editor || (state.replay && !state.demo)) return;
  if (state.demo) return demoStep(state.demo.step - 1);
  if (state.play) return playView(state.play.view - 1);
  if (state.extra.length) { state.extra.pop(); update(); }
  else goTo(state.ply - 1);
}

function forward() {
  if (state.editor || (state.replay && !state.demo)) return;
  if (state.demo) return demoStep(state.demo.step + 1);
  if (state.play) return playView(state.play.view + 1);
  if (!state.extra.length) goTo(state.ply + 1);
}

// ---------------------------------------------------------------- panels

function playerLine(color) {
  const p = state.play;
  if (p) return color === p.color ? (state.me ? `${esc(state.me)} (you)` : 'You') : `Bot <span class="elo">${esc(p.levelName)}</span>`;
  const r = state.review;
  if (!r.moves.length) return '';
  const name = r[color], elo = r[`${color}_elo`];
  const you = r.player_color === color ? ' (you)' : '';
  return `${esc(name)}${you} <span class="elo">${elo ? `(${esc(elo)})` : ''}</span>`;
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

function renderInfo() {
  const r = state.review;
  const top = state.orientation === 'white' ? 'black' : 'white';
  const mat = material(currentGame());
  $('player-top').innerHTML = playerLine(top) + capturedHtml(top, mat);
  $('player-bottom').innerHTML = playerLine(state.orientation) + capturedHtml(state.orientation, mat);
  document.body.classList.toggle('demo-mode', !!state.demo);
  if (state.demo) return renderDemoInfo();

  if (state.play) return renderPlayInfo();
  if (!r.moves.length) {
    $('game-info').innerHTML = 'Analysis board<div class="sub">Move pieces freely and ask the coach about any position.</div>';
    $('summary').innerHTML = '<div class="play-buttons"><button class="btn ghost small" id="btn-setup-inline">Set up position</button></div>';
    $('btn-setup-inline').onclick = openEditor;
    return;
  }
  $('game-info').innerHTML = `${esc(r.white)} vs ${esc(r.black)} · ${esc(r.result)}
    <div class="sub">${esc(r.opening || '')}</div>`;

  const whose = r.player_color;
  const counts = {};
  for (const m of r.moves) if (m.class && (!whose || m.color === whose)) (counts[m.class] ||= []).push(m.ply);
  const parts = ['blunder', 'mistake', 'inaccuracy']
    .filter((k) => counts[k])
    .map((k) => `<span class="tag ${k}" data-cls="${k}" title="Jump to next ${k}">${counts[k].length} ${counts[k].length > 1 ? PLURAL[k] : k}</span>`);
  if (state.replay) return renderReplayInfo();
  $('summary').innerHTML = (parts.length
    ? `<span style="color:var(--muted)">${whose ? 'Your' : 'Flagged'} moves:</span> ${parts.join('')}`
    : `<span style="color:var(--muted)">No inaccuracies, mistakes or blunders${whose ? ' by you' : ''}.</span>`)
    + `<div class="play-buttons"><button class="btn small" id="btn-from-here">▶ Play from here</button>`
    + `<button class="btn ghost small" id="btn-setup-from-here">Set up position</button></div>`;
  $('btn-from-here').onclick = openFromDialog;
  $('btn-setup-from-here').onclick = openEditor;
  $('summary').querySelectorAll('.tag').forEach((el) => {
    el.onclick = () => {
      const plies = counts[el.dataset.cls];
      const next = plies.find((p) => p > state.ply) ?? plies[0];
      goTo(next);
    };
  });
}

function renderMoves() {
  const r = state.review;
  const box = $('moves');
  if (state.demo) return renderDemoMoves(box);
  if (state.play) return renderPlayMoves(box);
  if (!r.moves.length) {
    box.innerHTML = '<div class="empty">No game loaded. Use “Find game by username” or “Load game”, or just play moves on the board.</div>';
    return;
  }
  let html = '';
  for (let i = 0; i < r.moves.length;) {
    const w = r.moves[i].color === 'white' ? r.moves[i++] : null;  // a set-up game may start with Black
    const b = r.moves[i]?.color === 'black' ? r.moves[i++] : null;
    const num = parseInt((w || b).label, 10);
    html += `<div class="row"><span class="num">${num}.</span>${w ? cell(w) : '<span>…</span>'}${b ? cell(b) : '<span></span>'}</div>`;
  }
  box.innerHTML = html;
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
      showEval(data);
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

function explorerFilters() {
  const band = $('x-band').value;
  return {
    db: $('x-db').value,
    ratings: band ? band.split(',').map(Number) : null,
    speeds: $('x-speed').value.split(','),
  };
}

function setEtab(tab) {
  state.etab = tab;
  store('etab', tab);
  $('etabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.etab === tab));
  $('engine-pane').classList.toggle('hidden', tab !== 'engine');
  $('explorer-pane').classList.toggle('hidden', tab !== 'explorer');
  document.body.classList.toggle('etab-explorer', tab === 'explorer');
  if (tab === 'explorer' && !state.editor) requestExplorer(currentGame());
}

function requestExplorer(c) {
  clearTimeout(xTimer);
  if (linesFor && !state.demo && c && c.fen() !== linesFor) { $('x-lines-box').classList.add('hidden'); linesFor = null; }
  const token = ++xToken;
  if (state.etab !== 'explorer' || !c) return;
  const f = explorerFilters();
  $('x-band').disabled = $('x-speed').disabled = f.db === 'masters';
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

function updateLinesButton() {
  const masters = $('x-db').value === 'masters';
  $('x-lines').textContent = masters ? '▶ Common lines' : '▶ Most played lines at this level';
  $('x-lines').title = masters ? 'The lines masters play most from this position, as demos'
    : 'The lines Lichess players in this rating band play most, as demos';
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
  if (state.editor) return updateEditor();
  hoverPieceSq = null;  // position changed; next mousemove will re-draw
  clearHeldThreats();  // right-clicked threat arrows are stale once the position moves on
  // a pinned/hovered square from chat text refers to the position it was clicked on — stale once
  // the board moves on, so it would otherwise sit there highlighted with no visible explanation
  if (pinnedSquares.size || hoverSquare) {
    pinnedSquares.clear();
    hoverSquare = null;
    paintSquares();
  }
  const c = renderBoard();
  try { history.replaceState(null, '', state.ply ? `#ply=${state.ply}` : location.pathname); } catch {}
  renderInfo();
  renderMoves();
  renderVariation();
  requestEval(c);
  requestExplorer(c);
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
  const marks = new Map();
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
    } else if (/^\s*\**habit to build:?\**:?/i.test(block)) {
      const body = block.replace(/^\s*\**habit to build:?\**:?\s*/i, '');
      html.push(`<div class="habit"><div class="habit-h">🧠 Habit to build</div><p>${lines.length > 1 ? body.split('\n').map((l) => inline(l, seen)).join('<br>') : inline(body, seen)}</p></div>`);
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

// ---- every point/callout that mentions a move gets its own "▶ Show on board" button,
// built from every move chip inside it (in order), whether or not they sit side by side

function addLineButtons(root) {
  root.querySelectorAll('p, li, .alert-red, .habit p, .protip p').forEach((block) => {
    const chips = [...block.querySelectorAll('.san')];
    if (!chips.length) return;
    const tokens = chips.map((c) => c.dataset.token);
    // a numbered option card is one visual unit: make the whole card clickable instead of
    // bolting a separate button onto it (inner chips still handle their own click first)
    if (block.tagName === 'LI' && block.parentElement.classList.contains('points')) {
      block.classList.add('card-play');
      block.title = `${tokens.join(' ')}\nClick to play this on the demo board`;
      block.onclick = (e) => {
        if (e.target.closest('.san, .sq, .term')) return;
        if (!playLine(tokens)) block.classList.add('stale');
      };
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'line-btn';
    btn.title = `${tokens.join(' ')}\nClick to play this on the demo board`;
    const last = tokens.at(-1).replace(/^\d+\.(\.\.)?\s?/, '');
    const preview = tokens.length > 1 ? `${tokens[0]} … ${last} · ${tokens.length} moves` : tokens[0];
    btn.innerHTML = `<span class="line-play">▶ Show on board</span><span class="line-preview">${esc(preview)}</span>`;
    btn.onclick = () => { if (!playLine(tokens)) btn.classList.add('stale'); };
    block.appendChild(btn);
  });
}

function playLine(tokens) {
  // start from the position before the line's first move (found via its move number), play it as a demo
  const line = currentLine();
  const first = resolveToken(tokens[0]);
  if (!first) return false;
  const c = new Chess(line.startFen);
  try { for (const x of line.sans.slice(0, first.k)) c.move(x); } catch { return false; }
  const startFen = c.fen();
  const moves = [];
  for (const tok of tokens) {
    const san = tok.replace(/^\d+\.(\.\.)?\s?/, '');
    try { moves.push(c.move(san).san); } catch { break; }  // stop at the first move that doesn't fit
  }
  if (!moves.length) return false;
  // where this sits in coach-tool terms, so questions inside the demo still work
  let origin;
  if (line.kind === 'demo') {
    origin = { ply: state.demo.ply, then_moves: [...state.demo.then_moves, ...line.sans.slice(0, first.k)] };
  } else if (line.kind === 'play') {
    origin = { ply: 1, then_moves: line.sans.slice(0, first.k) };
  } else {
    const game = state.review.moves.map((m) => m.san);
    let p = 0;
    while (p < first.k && p < game.length && line.sans[p] === game[p]) p++;
    origin = { ply: p + 1, then_moves: line.sans.slice(p, first.k) };
  }
  const title = tokens.length > 1 ? `Move order: ${tokens[0]}` : `On the board: ${tokens[0]}`;
  openDemo({ title, start_fen: startFen, moves, notes: [], ...origin });
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
  cg.setAutoShapes([...heldThreats, ...(hoverPieceSq ? movesShapesFor(hoverPieceSq) : [])]);
}

function showPieceHover(sq) {
  if (sq === hoverPieceSq) return;
  hoverPieceSq = sq;
  renderShapes();
}

// ---- right-click a piece to hold its threat arrows (accumulates across pieces);
// left click resets them all — see the drawable.onChange hook above

let heldThreats = [];
let heldSquares = new Set();
let nativeShapesSeen = 0;

function holdThreatSquare(sq) {
  if (heldSquares.has(sq)) return;
  const shapes = movesShapesFor(sq);
  if (!shapes.length) return;
  heldSquares.add(sq);
  heldThreats.push(...shapes);
  renderShapes();
}

function clearHeldThreats() {
  nativeShapesSeen = 0;
  if (!heldSquares.size) return;
  heldSquares.clear();
  heldThreats = [];
  renderShapes();
}

function previewMove(token, on) {
  if (!on) { cg.setAutoShapes([]); return; }
  const t = resolveToken(token);
  if (!t || t.k !== currentLine().at) return;
  const mv = legalAt(t.k, t.san);
  if (mv) cg.setAutoShapes([{ orig: mv.from, dest: mv.to, brush: 'paleBlue' }]);
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
  // special-move alerts stay in context; if one is further down, flag it at the top
  const alert = div.querySelector('.alert-red');
  const blocks = [...div.children].filter((el) => !el.matches('.where, .gm-label'));
  if (alert && blocks.indexOf(alert) > 1) {
    const tag = document.createElement('button');
    tag.className = 'special-tag';
    tag.textContent = '⚡ Special move inside ↓';
    tag.onclick = () => alert.scrollIntoView({ block: 'center', behavior: 'smooth' });
    div.insertBefore(tag, blocks[0]);
  }
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
    addMsg('user', esc(question), positionLabel());
    $('chat-text').value = '';
  }
  const pending = addMsg('coach', `<span class="thinking">${opts.silent ? 'Spotted something' : 'Analysing'}</span>`);
  try {
    const where = state.demo
      ? { ply: Math.max(0, state.demo.ply - 1), extra: [...state.demo.then_moves, ...state.demo.moves.slice(0, state.demo.step)] }
      : { ply: state.ply, extra: state.extra };
    let polling = true;
    (async () => {  // live progress: show the coach's tool steps while it works
      while (polling) {
        await new Promise((r) => setTimeout(r, 1200));
        if (!polling) break;
        try {
          const { steps } = await api('/api/chat/progress');
          const shown = steps.filter((t) => t.name !== 'show_on_board');
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
        question, ...where, audience: state.audience,
        where: opts.where || positionLabel(), mode: currentMode(), label: opts.silent ? opts.label : null,
      });
    } finally {
      polling = false;
    }
    pending.remove();
    renderAnswer(data, opts);
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

function renderAnswer(data, opts = {}) {
  // a coach answer bubble: text, Show me buttons, the checks bubble and a ☆ for the library
  const n = (data.tools || []).length;
  const tools = n
    ? `<details class="tools"><summary>🔍 ${n} check${n > 1 ? 's' : ''}</summary>${data.tools.map((t) => `<div title="${esc(toolTitle(t))}">✓ ${esc(toolLabel(t))}</div>`).join('')}</details>` : '';
  const demos = data.demos || [];
  const buttons = demos.length
    ? `<div class="demos">${demos.map((d, i) => `<button class="demo-btn" data-i="${i}">▶ Show me: ${esc(d.title)}</button>`).join('')}</div>` : '';
  const label = opts.label ? `<div class="gm-label">${esc(opts.label)}</div>` : '';
  const star = data.entry_id
    ? `<button class="star${data.starred ? ' on' : ''}" title="Save to favourites in Lessons">${data.starred ? '★' : '☆'}</button>` : '';
  const msg = addMsg(opts.label ? 'coach gm' : 'coach', star + label + markdown(data.answer) + buttons + tools, opts.where);
  msg.querySelectorAll('.demo-btn').forEach((b) => { b.onclick = () => openDemo(demos[+b.dataset.i]); });
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
  renderAnswer({ answer: e.answer, tools: e.tools, demos: e.demos, entry_id: e.id, starred: e.starred },
    { label: e.kind === 'gm alert' ? e.question : null, where: e.kind === 'gm alert' ? e.position_label : null });
}

function renderChips() {
  const chips = CHIPS[state.play ? 'play' : 'review'];
  $('chips').innerHTML = chips.map(([label, q]) => `<button class="chip" data-q="${esc(q)}">${esc(label)}</button>`).join('');
  $('chips').querySelectorAll('.chip').forEach((el) => { el.onclick = () => ask(el.dataset.q); });
}

function resetChatUi(note) {
  $('chat-log').innerHTML = '';
  if (note) addMsg('system', esc(note));
}

// ---------------------------------------------------------------- loading games

function setReview(review, note, play = null) {
  closeDemo(false);
  state.replay = null;
  closeEditor(false);
  if (state.play && !play) setEngineVisible(recall('engineOn') !== '0');  // leaving a game
  state.play = play;
  lastOpeningEco = null;
  renderChips();
  state.review = review;
  state.ply = (!play && review.player_color && review.moves.length) ? review.moves.length : 0;
  state.extra = [];
  state.orientation = play ? play.color : (review.player_color || 'white');
  resetChatUi(note);
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
  $('tab-saved').classList.toggle('hidden', tab !== 'saved');
  if (tab === 'saved') showSaved();
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
  if (site === 'chesscom') { state.me = user; store('me', user); }
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

async function showGames() {
  const user = $('games-user').value.trim();
  if (!user) return;
  state.me = user;
  store('me', user);
  const list = $('games-list');
  list.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const games = await api(`/api/games?user=${encodeURIComponent(user)}`);
    if (!games.length) { list.innerHTML = '<p class="hint">No recent games found.</p>'; return; }
    list.innerHTML = games.map((g) => {
      const meWhite = g.white.toLowerCase() === user.toLowerCase();
      const won = (g.result === '1-0' && meWhite) || (g.result === '0-1' && !meWhite);
      const lost = (g.result === '1-0' && !meWhite) || (g.result === '0-1' && meWhite);
      const when = g.end_time ? new Date(g.end_time * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      return `<div class="game-row" data-ref="${esc(g.ref)}">
        <span class="who">${esc(g.white)} (${g.white_rating}) – ${esc(g.black)} (${g.black_rating})</span>
        <span class="res ${won ? 'win' : lost ? 'loss' : ''}">${won ? 'Won' : lost ? 'Lost' : 'Draw'} ${esc(g.result)}</span>
        <span class="meta">${esc(g.time_class || '')} · ${esc(when)} · ${esc(g.opening)}</span>
      </div>`;
    }).join('');
    list.querySelectorAll('.game-row').forEach((el) => {
      el.onclick = () => { $('dlg-games').close(); loadGame(el.dataset.ref); };
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
  $('game-info').innerHTML = `${esc(d.title)}<div class="sub">${d.edited ? 'Your own line from here: keep exploring, or ask the coach about it.' : 'The coach’s line. Step through it, or move pieces to try something else.'}</div>`;
  const note = d.step ? d.notes[d.step - 1] : '';
  $('summary').innerHTML = `<div class="play-buttons">
      <button class="btn small" id="demo-exit">Back to my game</button>
      <button class="btn ghost small" id="demo-replay">Replay</button>
    </div>${note ? `<div class="demo-note">${inline(note)}</div>` : ''}`;
  $('demo-exit').onclick = () => closeDemo();
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
  $('ed-fen').onblur = () => { const v = $('ed-fen').value.trim(); if (v && v !== editorFen()) load(v); };
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
  $('game-info').innerHTML = 'Set up a position<div class="sub">Great for endgame practice: set it up, then play it out against the bot.</div>';
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

// ---------------------------------------------------------------- play from here / replay

let fromColor = 'white';

function openFromDialog() {
  const r = state.review;
  const c = currentGame();
  const where = positionLabel();
  $('from-where').textContent = `${r.white} vs ${r.black}: ${where}, ${c.turn() === 'w' ? 'White' : 'Black'} to move.`;
  const canReplay = !state.extra.length && state.ply < r.moves.length;
  $('from-replay').disabled = !canReplay;
  $('from-replay').title = canReplay ? '' : 'Replay needs a position from the game itself (not your own variation) before the last move.';
  fromColor = r.player_color || (c.turn() === 'w' ? 'white' : 'black');
  $('from-color').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.color === fromColor));
  $('dlg-from').showModal();
}

async function startFromBest() {
  $('dlg-from').close();
  const r = state.review;
  const c = currentGame();
  const origin = `${r.white} vs ${r.black}, ${positionLabel().replace(/^After/, 'after')}`;
  playToken++;
  let review;
  try {
    review = await api('/api/play/new', { color: fromColor, level: 9, fen: c.fen(), origin });
  } catch (e) {
    addMsg('error', esc(e.message));
    return;
  }
  const play = { color: fromColor, level: 9, levelName: 'Full strength', startFen: review.start_fen,
    moves: [], view: 0, over: null, thinking: false };
  setEngineVisible(false);
  setReview(review, `Playing on from ${origin} against a full-strength bot. You have ${fromColor}.`, play);
  if (c.turn() !== fromColor[0]) botMove();
  else gmCheck(c);
}

function startReplay() {
  $('dlg-from').close();
  const r = state.review;
  const color = r.player_color || (currentGame().turn() === 'w' ? 'white' : 'black');
  closeDemo(false);
  state.replay = { color, hint: null };
  setEngineVisible(false);
  addMsg('system', `Replay from ${positionLabel().toLowerCase()}: play your ${color} moves from the game; your opponent plays theirs. I'll step in if there was something special on the board.`);
  update();
  replayStep();
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
        replayStep();
      }, Math.max(300, 700 - (Date.now() - started)));
    });
  } else {
    gmCheck(currentGame(), next);
  }
}

function onReplayMove(orig, dest) {
  const rp = state.replay;
  const next = replayNextMove();
  if (next && next.uci.slice(0, 4) === orig + dest) {
    rp.hint = null;
    state.ply++;
    update();
    replayStep();
    return;
  }
  rp.hint = next;
  update();  // snaps the piece back
  if (next) cg.setAutoShapes([{ orig: next.uci.slice(0, 2), dest: next.uci.slice(2, 4), brush: 'blue' }]);
}

function renderReplayInfo() {
  const rp = state.replay;
  const next = replayNextMove();
  let status;
  if (!next) status = `End of the game (${state.review.result}).`;
  else if (rp.hint) status = `In the game you played ${rp.hint.label} ${rp.hint.san} here. Play it to continue (arrow on the board).`;
  else if (next.color === rp.color) status = 'Your move: play what you played in the game.';
  else if (document.querySelector('.thinking')) status = 'Hold on, the coach spotted something before your opponent moves…';
  else status = 'Opponent is playing their game move…';
  $('summary').innerHTML = `<div class="status">Replay · you play ${rp.color}</div>
    <div class="replay-status">${esc(status)}</div>
    <div class="play-buttons"><button class="btn ghost small" id="replay-exit">Exit replay</button></div>`;
  $('replay-exit').onclick = stopReplay;
}

// ---- instant "I see you're playing X" quip whenever a new named opening is reached —
// a database lookup, not a coach call: free, instant, and quiet again once you're out of book

const OPENING_QUIPS = [
  (nick) => `${/^[aeiou]/i.test(nick) ? 'An' : 'A'} ${nick} player, I see...`,
  (nick) => `Ah, the ${nick}. Nice.`,
  (nick) => `${nick}? Bold choice.`,
  (nick) => `Going for the ${nick}, are we?`,
];

function openingNickname(name) {
  // "Sicilian Defense: Najdorf Variation" -> "Najdorf"; "English Opening" -> "English"
  const part = name.includes(':') ? name.split(':')[1].trim() : name;
  return part.replace(/\s+(Defense|Defence|Opening|Variation|System)$/i, '').trim() || name;
}

let lastOpeningEco = null;
let quipToken = 0;

async function openingQuip(c) {
  if (!state.explorerReady || c.isGameOver()) return;
  const token = ++quipToken;
  let res;
  try {
    res = await api('/api/explorer', { fen: c.fen(), db: 'masters' });
  } catch {
    return;
  }
  if (token !== quipToken) return;  // the game moved on before this lookup came back
  const opening = res.opening;
  if (!opening || opening.eco === lastOpeningEco) return;
  lastOpeningEco = opening.eco;
  const nick = openingNickname(opening.name);
  const phrase = OPENING_QUIPS[Math.floor(Math.random() * OPENING_QUIPS.length)](nick);
  addMsg('coach', markdown(phrase), positionLabel());
}

// ---- "only a GM would see this": engine check each time it's the player's turn

let gmToken = 0;
const gmSeen = new Set();

async function gmCheck(c, gameMove = null, side = 'player') {
  openingQuip(c);
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
  try {
    const res = await api('/api/play/move', { fen: c.fen(), level: p.level });
    await new Promise((r) => setTimeout(r, Math.max(0, 450 - (Date.now() - started))));  // feel less instant
    if (token !== playToken || state.play !== p) return;
    p.moves.push(res.san);
  } catch (e) {
    addMsg('error', `Bot error: ${esc(e.message)}`);
  } finally {
    if (token === playToken && state.play === p) {
      p.thinking = false;
      playView(p.moves.length);
      if (!checkGameOver()) gmCheck(playChess(p));
    }
  }
}

function checkGameOver() {
  const p = state.play;
  const c = playChess(p);
  if (!c.isGameOver()) return false;
  if (c.isCheckmate()) {
    const winner = c.turn() === 'w' ? 'black' : 'white';
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
  if (!p || !p.moves.length) return;
  playToken++;  // drop any bot reply in flight
  p.thinking = false;
  p.over = null;
  const mine = p.color[0];
  do { p.moves.pop(); } while (p.moves.length && playChess(p).turn() !== mine);
  playView(p.moves.length);
  if (playChess(p).turn() !== mine) botMove();  // back at a start position where the bot moves first
}

function resign() {
  const p = state.play;
  if (!p || p.over) return;
  playToken++;
  p.thinking = false;
  endGame('loss', 'You resigned.');
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
  $('game-info').innerHTML = `Practice game vs bot<div class="sub">${esc(p.levelName)} · you play ${p.color}</div>`;
  let status, cls = '';
  if (p.over) {
    status = p.over.text;
    cls = p.over.outcome === 'win' ? 'win' : p.over.outcome === 'loss' ? 'loss' : '';
  } else if (p.thinking) status = 'Bot is thinking…';
  else if (p.view < p.moves.length) status = 'Viewing an earlier position; press → or ⏭ to return';
  else status = 'Your move';
  const buttons = p.over
    ? `<button class="btn small" id="pb-review">Review this game</button>
       <button class="btn ghost small" id="pb-again">New game</button>`
    : `<button class="btn ghost small" id="pb-takeback" ${p.moves.length ? '' : 'disabled'}>Takeback</button>
       <button class="btn ghost small" id="pb-resign" ${p.moves.length ? '' : 'disabled'}>Resign</button>`;
  $('summary').innerHTML = `<div class="status ${cls}">${esc(status)}</div><div class="play-buttons">${buttons}</div>`;
  $('pb-review')?.addEventListener('click', reviewPlayedGame);
  $('pb-again')?.addEventListener('click', openPlayDialog);
  $('pb-takeback')?.addEventListener('click', takeback);
  $('pb-resign')?.addEventListener('click', resign);
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
    sel.value = recall('botLevel') || '3';
  }
  $('play-engine').checked = recall('playEngine') === '1';
  $('dlg-play').querySelector('h2').textContent = pendingFen ? 'Play this position against the bot' : 'Play a game';
  const r = state.review;
  $('play-continue-row').innerHTML = (!pendingFen && r?.moves?.length)
    ? `<button class="btn ghost small" id="play-continue-btn">▶ Continue ${esc(r.white)} vs ${esc(r.black)} from here instead</button>`
    : (!pendingFen ? '<button class="btn ghost small" id="play-continue-btn">Or continue one of your own games from a chosen move…</button>' : '');
  const continueBtn = $('play-continue-btn');
  if (continueBtn) {
    continueBtn.onclick = () => {
      $('dlg-play').close();
      if (!pendingFen && r?.moves?.length) openFromDialog();
      else openGamesDialog();
    };
  }
  $('dlg-play').showModal();
}

async function startGame() {
  const level = +$('play-level').value;
  const levelName = $('play-level').selectedOptions[0].textContent;
  const color = playColor === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : playColor;
  store('botLevel', String(level));
  store('playEngine', $('play-engine').checked ? '1' : '0');
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
  const play = { color, level, levelName, startFen: review.start_fen, moves: [], view: 0, over: null, thinking: false };
  setEngineVisible($('play-engine').checked);
  const from = fen ? ' from your set-up position' : '';
  setReview(review, `New game${from}: you have the ${color} pieces against the ${levelName} bot. Ask for ideas any time.`, play);
  if (new Chess(play.startFen).turn() !== color[0]) botMove();
}

// ---------------------------------------------------------------- wiring

$('btn-play').onclick = () => { pendingFen = null; openPlayDialog(); };
$('btn-library').onclick = openLibrary;
$('lib-q').oninput = () => { clearTimeout(libTimer); libTimer = setTimeout(searchLibrary, 250); };
$('lib-starred').onchange = searchLibrary;
$('lib-habits').onchange = searchLibrary;
$('from-best').onclick = startFromBest;
$('from-replay').onclick = startReplay;
$('from-color').querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    fromColor = b.dataset.color;
    $('from-color').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  };
});

function renderAudience(list) {
  $('audience').classList.toggle('hidden', list.length < 2);  // one voice: no switch needed
  $('audience').innerHTML = list.map((a) => `<button data-a="${esc(a)}">${esc(a[0].toUpperCase() + a.slice(1))}</button>`).join('');
  $('audience').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.a === state.audience);
    b.onclick = () => {
      state.audience = b.dataset.a;
      store('audience', state.audience);
      $('audience').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
}
$('dlg-play').addEventListener('close', () => { if (!state.editor) pendingFen = null; });
$('play-go').onclick = startGame;
$('play-color').querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    playColor = b.dataset.color;
    $('play-color').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  };
});

function openGamesDialog() {
  $('games-user').value = state.me;
  $('dlg-games').showModal();
  showGamesTab(navigator.onLine === false ? 'saved' : 'chesscom');
  pollPrefetch();
}
$('btn-games').onclick = openGamesDialog;
$('games-tabs').querySelectorAll('button').forEach((b) => { b.onclick = () => showGamesTab(b.dataset.tab); });
$('games-prefetch').onclick = () => startPrefetch('chesscom');
$('games-prefetch-lichess').onclick = () => startPrefetch('lichess');
$('games-fetch').onclick = showGames;
$('games-user').onkeydown = (e) => { if (e.key === 'Enter') showGames(); };

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
  : state.play ? playView(state.play.moves.length) : goTo(state.review.moves.length));
$('nav-flip').onclick = () => {
  state.orientation = state.orientation === 'white' ? 'black' : 'white';
  update();
};
$('engine-toggle').onchange = (e) => setEngine(e.target.checked);
$('etabs').querySelectorAll('button').forEach((b) => { b.onclick = () => setEtab(b.dataset.etab); });
$('x-lines').onclick = showLines;
for (const id of ['x-db', 'x-band', 'x-speed']) {
  $(id).onchange = () => {
    store(id, $(id).value);
    updateLinesButton();
    $('x-lines-box').classList.add('hidden');
    linesFor = null;
    if (!state.editor) requestExplorer(currentGame());
  };
}

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
  const aud = cfg.audiences || ['coach'];
  state.audience = aud.includes(recall('audience')) ? recall('audience') : (aud.includes('coach') ? 'coach' : aud[0]);
  renderAudience(aud);
  // default to master-level games unless the player has picked their own explorer filters before
  $('x-db').value = recall('x-db') || 'masters';
  for (const id of ['x-band', 'x-speed']) { const v = recall(id); if (v !== null) $(id).value = v; }
  updateLinesButton();
  setEtab(recall('etab') === 'explorer' ? 'explorer' : 'engine');
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
