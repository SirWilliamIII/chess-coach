// The endgame trainer, its own page (/endgames; user's call, 2026-10-11: each section separate, so changing one
// can't affect another). It plays on the board page's shared bot-game loop and plugs into it through `hooks`;
// the rest of the app never sees this file.
// Pick material and a goal; the server sets up a random position with that material and a known result
// (core/endgames.py: Lichess' tablebase up to 7 pieces, deep Stockfish above) and you play it out against
// the opponent you pick (Maia at a rating, or full-strength Stockfish), eval hidden. With the tablebase, each of your
// moves is checked: a move that throws away the win (or the draw) gets a card naming the best move.

import {
  $, hooks, state, api, store, recall, esc, addMsg, setReview, setEngineVisible, playView, playChess, botMove,
  levelForRating, getBotLevels, bumpPlayToken, markBoardTaken, sectionNav, takePanel,
} from '../app.js';
import { lineHtml } from './notation.js';


const EG_MODES = {
  win: ['Win it', 'You have a won position. Convert it.'],
  draw: ['Hold it', 'The position is a draw. Hold it, and win it if they slip.'],
};
const EG_HOLD_MOVES = 30;  // a "hold the draw" drill counts as done after this many of your moves
const EG_RANK = { loss: 0, draw: 1, win: 2 };
const egProbes = new Map();  // fen → promise of the tablebase verdict (not in state.play: that's snapshotted)
let egPresets = null;
let levels = [];  // the bot levels (/api/play/levels)
// opponent: Maia by default (user's call, 2026-10-08: full-strength Stockfish only when asked for)
let egChoice = { mode: EG_MODES[recall('egMode')] ? recall('egMode') : 'win',  // "lies" was removed 2026-10-08
  color: recall('egColor') || 'white', opp: recall('egOpp') || 'human', elo: +recall('egElo') || null,
  spec: recall('egSpec') || null, group: recall('egGroup') || null };

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
  if (spec === 'pawns:even') return 'two pawns down with the active king, and it\'s even: hold the draw (any mode)';
  const m = /^(rand|pawns):(\d+)$/.exec(spec);
  if (m) return m[1] === 'rand' ? `${m[2]} random pieces` : `kings + ${m[2]} pawns`;
  return spec.split('-').map((s) => s.split('').join('+')).join(' vs ');
}

async function openEndgames(step = 1) {
  if (!egPresets) {
    try {
      egPresets = await api('/api/endgame/presets');
      levels = await getBotLevels();
    } catch (e) { return void addMsg('error', esc(e.message)); }
  }
  egStep = step;
  renderEndgames();
  $('eg-status').textContent = '';
  $('dlg-endgame').showModal();
}

// The dialog is a stepper (user's calls, 2026-10-09: every option at once was overload; then material split in
// two): 1 goal, 2 type (the preset group), 3 pieces, 4 side, 5 opponent + Start. Each step shows the remembered
// choice selected; picking one moves on.
let egStep = 1;
const EG_STEPS = ['Goal', 'Type', 'Pieces', 'Your side', 'Opponent'];
const EG_COLORS = { white: 'White', random: 'Random', black: 'Black' };

// the Maia levels ("Maia (~1400)"); none when Maia isn't installed, and then it's Stockfish only
function egHumanLevels() {
  return levels.map((l) => ({ ...l, elo: +(l.name.match(/~(\d+)/)?.[1]) })).filter((l) => l.elo);
}

function egOppLabel() {
  const human = egChoice.opp === 'human' && egHumanLevels().length > 0;
  return human ? `Human ~${egChoice.elo || state.playerRating || 800}` : 'Stockfish';
}

function egTileArt(spec, white) {
  const [mine, theirs] = spec.includes('-') ? spec.split('-') : [null, null];
  return mine ? `<span class="eg-art"><span class="${white ? 'w' : 'b'}">${egGlyphs(mine, white)}</span><span class="eg-vs">vs</span><span class="${white ? 'b' : 'w'}">${egGlyphs(theirs, !white)}</span></span>`
    : `<span class="eg-art"><span class="eg-n">${spec === 'pawns:even' ? '+0.0' : spec.split(':')[1]}</span><span class="eg-vs">${spec.startsWith('pawns') ? '♙ ♟' : 'pieces'}</span></span>`;
}

function renderEndgames() {
  const { mode, color } = egChoice;
  const groups = [...new Set(egPresets.map((p) => p.group))];
  const group = groups.includes(egChoice.group) ? egChoice.group : null;
  // the pieces only count while they belong to the type picked
  const preset = egPresets.find((p) => p.spec === egChoice.spec && p.group === group);
  const spec = preset?.spec || null;
  const done = [EG_MODES[egModeFor(spec, mode)][0], group, preset?.label, EG_COLORS[color], egOppLabel()];
  // every step but the current one shows its (remembered) pick; past the type / the pieces only once picked
  const reachable = (n) => n <= 2 || (n === 3 ? !!group : !!spec);
  $('eg-crumbs').innerHTML = EG_STEPS.map((name, i) => {
    const n = i + 1;
    const val = n === egStep || !done[i] || !reachable(n) ? null : done[i];
    return `<button class="eg-crumb${n === egStep ? ' on' : ''}" data-step="${n}"${reachable(n) ? '' : ' disabled'}>`
      + `<span class="eg-cn">${n}</span><span>${val ? esc(val) : name}</span></button>`;
  }).join('<span class="eg-sep">›</span>');
  $('eg-crumbs').querySelectorAll('.eg-crumb').forEach((b) => { b.onclick = () => { egStep = +b.dataset.step; renderEndgames(); }; });

  const body = $('eg-body');
  const choice = (items, on, attr) => `<div class="eg-choices">${items.map(([k, label, sub]) =>
    `<button class="eg-choice${k === on ? ' on' : ''}" data-${attr}="${k}"><b>${esc(label)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</button>`).join('')}</div>`;
  if (egStep === 1) {
    body.innerHTML = '<h3 class="eg-q">What do you want to practice?</h3>'
      + choice(Object.entries(EG_MODES).map(([k, [label, sub]]) => [k, label, sub]), mode, 'mode');
    body.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => { egChoice.mode = b.dataset.mode; store('egMode', b.dataset.mode); egStep = 2; renderEndgames(); };
    });
  } else if (egStep === 2) {
    const white = color !== 'black';
    body.innerHTML = '<h3 class="eg-q">What kind of ending?</h3><div class="eg-tiles eg-types">' + groups.map((g) => {
      const ps = egPresets.filter((p) => p.group === g);
      return `<button class="eg-tile${g === group ? ' on' : ''}" data-group="${esc(g)}">${egTileArt(ps[0].spec, white)}`
        + `<span class="eg-label">${esc(g)}</span><span class="eg-sub">${ps.map((p) => esc(p.label)).join(' · ')}</span></button>`;
    }).join('') + '</div>';
    body.querySelectorAll('[data-group]').forEach((b) => {
      b.onclick = () => { egChoice.group = b.dataset.group; store('egGroup', b.dataset.group); egStep = 3; renderEndgames(); };
    });
  } else if (egStep === 3) {
    const white = color !== 'black';
    const stats = egStats();
    body.innerHTML = `<h3 class="eg-q">${esc(group)}: which pieces?</h3><div class="eg-tiles">` + egPresets.filter((p) => p.group === group).map((p) => {
      const st = stats[`${p.spec}|${egModeFor(p.spec, mode)}`];
      return `<button class="eg-tile${p.spec === spec ? ' on' : ''}" data-spec="${esc(p.spec)}" title="${esc(egSpecLabel(p.spec))}">${egTileArt(p.spec, white)}<span class="eg-label">${esc(p.label)}</span>`
        + `${st ? `<span class="eg-st" title="Done / tried in this mode">${st.done}/${st.tries}</span>` : ''}</button>`;
    }).join('') + '</div>';
    body.querySelectorAll('.eg-tile').forEach((b) => {
      b.onclick = () => { egChoice.spec = b.dataset.spec; store('egSpec', b.dataset.spec); egStep = 4; renderEndgames(); };
    });
  } else if (egStep === 4) {
    body.innerHTML = '<h3 class="eg-q">Which side do you play?</h3>'
      + choice(Object.entries(EG_COLORS).map(([k, label]) => [k, label, k === 'random' ? 'A coin flip each drill' : '']), color, 'color');
    body.querySelectorAll('[data-color]').forEach((b) => {
      b.onclick = () => { egChoice.color = b.dataset.color; store('egColor', b.dataset.color); egStep = 5; renderEndgames(); };
    });
  } else {
    const humans = egHumanLevels();
    const human = egChoice.opp === 'human' && humans.length > 0;
    const elo = egChoice.elo || state.playerRating || 800;
    const pick = humans.length ? humans.reduce((a, b) => (Math.abs(b.elo - elo) < Math.abs(a.elo - elo) ? b : a)) : null;
    body.innerHTML = '<h3 class="eg-q">Who do you play against?</h3>'
      + (humans.length ? choice([['human', 'Human', 'Maia: plays like a person at the rating you pick'], ['stockfish', 'Stockfish', 'Full strength: never slips']], human ? 'human' : 'stockfish', 'opp')
        : '<p class="hint">Stockfish at full strength (Maia isn\'t installed).</p>')
      + (human ? `<label class="eg-elo-row">Rating <select id="eg-elo" title="The human opponent's rating (chess.com rapid)">${
        humans.map((l) => `<option value="${l.elo}"${l === pick ? ' selected' : ''}>~${l.elo}</option>`).join('')}</select></label>` : '')
      + `<div class="eg-start"><button class="btn" id="eg-go"${spec ? '' : ' disabled'}>Start drill</button></div>`;
    body.querySelectorAll('[data-opp]').forEach((b) => {
      b.onclick = () => { egChoice.opp = b.dataset.opp; store('egOpp', b.dataset.opp); renderEndgames(); };
    });
    if ($('eg-elo')) $('eg-elo').onchange = (e) => { egChoice.elo = +e.target.value; store('egElo', e.target.value); renderEndgames(); };
    $('eg-go').onclick = () => startEndgame(spec);
  }
}

// Maia at the picked rating, or full-strength Stockfish (the last level when Maia isn't installed)
async function egBotLevel() {
  levels = await getBotLevels().catch(() => []);
  if (egChoice.opp === 'human' && egHumanLevels().length) return levelForRating(egChoice.elo || state.playerRating || 800);
  return levels.find((l) => /^stockfish/i.test(l.name)) || levels[levels.length - 1] || null;
}

// "Dead even" is always a draw drill, whatever mode is picked
function egModeFor(spec, mode) {
  return spec === 'pawns:even' ? 'draw' : mode;
}

async function startEndgame(spec, mode = egChoice.mode, pick = egChoice.color) {
  mode = egModeFor(spec, mode);
  const color = pick === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : pick;
  const level = await egBotLevel();
  if (!level) return void addMsg('error', "Couldn't load the bot levels.");
  const open = $('dlg-endgame').open;
  if (open) {
    $('eg-status').textContent = 'Setting up a position…';
    $('eg-body').classList.add('busy');
  }
  let pos, review;
  try {
    pos = await api('/api/endgame/new', { spec, mode, color });
    review = await api('/api/play/new', { color, level: level.id, fen: pos.fen });
  } catch (e) {
    if (open) { $('eg-status').textContent = e.message; $('eg-body').classList.remove('busy'); }
    else addMsg('error', esc(e.message));
    return;
  }
  markBoardTaken();  // the server's board is the drill now: the board page reopens its own on the way back
  $('eg-body').classList.remove('busy');
  if (open) $('dlg-endgame').close();
  bumpPlayToken();
  egRecord(`${spec}|${mode}`, 'tries');
  const play = { color, level: level.id, levelName: level.name, startFen: review.start_fen, moves: [], view: 0, over: null, thinking: false, clock: null,
    endgame: { spec, mode, pick, outcome: pos.outcome, expect: pos.outcome, source: pos.source, dtm: pos.dtm, mine: pos.mine, theirs: pos.theirs,
      points: pos.points, slips: 0, held: false, done: false } };
  setReview(review, `Endgame drill: ${egSpecLabel(spec)}, you have ${color}.`, play);
  // after setReview: leaving a puzzle there turns the engine back on, which showed the eval bar in the drill
  setEngineVisible(false);  // the eval bar would give the answer away; the toggle still turns it on
  egGoalCard(play, color);
  egProbe(review.start_fen);
}

// "New position" here too, not only on the result card: a Hold-it drill takes 30 moves to finish
function egGoalCard(p, color) {
  const eg = p.endgame;
  const goal = eg.outcome === 'win' ? `Win it: checkmate ${p.levelName}` : `Hold the draw against ${p.levelName}: reach a drawn ending, or survive ${EG_HOLD_MOVES} moves`;
  const how = eg.source === 'tablebase' ? `Tablebase: ${eg.outcome}${eg.outcome === 'win' && eg.dtm ? `, mate in ${Math.ceil(Math.abs(eg.dtm) / 2)} with best play` : ''}`
    : 'Stockfish (too many pieces for the tablebase): ' + (eg.outcome === 'win' ? 'winning' : 'about 0.0');
  const diff = eg.points[0] - eg.points[1];
  const material = `Material: you ${eg.points[0]}, the bot ${eg.points[1]} (${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff)})`;
  const lies = eg.spec === 'pawns:even' ? `<div class="eg-lie">You're two pawns down, but your king is the better piece: it's dead even.</div>` : '';
  const msg = addMsg('coach sb-msg', `<div class="eg-card"><div class="eg-ch"><span class="sb-al">Endgame drill</span>`
    + `<span class="eg-art"><span class="${color === 'white' ? 'w' : 'b'}">${egGlyphs(eg.mine, color === 'white')}</span><span class="eg-vs">vs</span>`
    + `<span class="${color === 'white' ? 'b' : 'w'}">${egGlyphs(eg.theirs, color !== 'white')}</span></span></div>`
    + `<div class="eg-goal">${esc(goal)}</div>${lies}<div class="card-sub">${esc(material)} · ${esc(how)}</div>`
    + `<div class="eg-actions"><button class="btn ghost small" data-a="again">New position</button>`
    + `<button class="btn ghost small" data-a="pick">Pick other material</button></div></div>`);
  msg.querySelector('[data-a=again]').onclick = () => startEndgame(eg.spec, eg.mode, eg.pick);
  msg.querySelector('[data-a=pick]').onclick = () => openEndgames(2);  // straight to the type step
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
    renderDrill();
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
    renderDrill();
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
  renderDrill();
}

function egFinish(p, ok, text) {
  const eg = p.endgame;
  if (eg.done) return;
  eg.done = true;
  eg.ok = ok;
  if (ok) egRecord(`${eg.spec}|${eg.mode}`, 'done');
  renderDrill();
  const slips = eg.slips ? ` ${eg.slips} slip${eg.slips > 1 ? 's' : ''} on the way.` : eg.source === 'tablebase' ? ' No slips.' : '';
  const msg = addMsg('coach sb-msg', `<div class="eg-card ${ok ? 'ok' : 'fail'}"><div class="eg-goal">${ok ? '✓ Drill done' : '✗ Not this time'}</div>`
    + `<div class="card-sub">${esc(text)}${esc(slips)}</div><div class="eg-actions"><button class="btn small" data-a="again">Another one</button>`
    + `<button class="btn ghost small" data-a="pick">Pick other material</button></div></div>`);
  msg.querySelector('[data-a=again]').onclick = () => startEndgame(eg.spec, eg.mode, eg.pick);
  msg.querySelector('[data-a=pick]').onclick = () => openEndgames(2);  // straight to the type step
}

// the same position from the start (the result card's "Another one" is a new position of the same material)
function egRetry(p) {
  const eg = p.endgame;
  bumpPlayToken();
  Object.assign(p, { moves: [], view: 0, over: null, thinking: false });
  Object.assign(eg, { expect: eg.outcome, slips: 0, held: false, done: false, ok: undefined });
  egRecord(`${eg.spec}|${eg.mode}`, 'tries');
  playView(0);
  egGoalCard(p, p.color);
  if (playChess(p).turn() !== p.color[0]) botMove();
}

// called from endGame(): the drill's verdict on how the game ended
function egGameOver(p, outcome) {
  const eg = p.endgame;
  if (!eg || eg.done) return;
  if (outcome === 'win') egFinish(p, true, 'Checkmate.');
  else if (outcome === 'draw') egFinish(p, eg.outcome === 'draw', eg.outcome === 'draw' ? 'Drawn, as the position deserved.' : 'It ended in a draw; the position was a win.');
  else egFinish(p, false, 'The bot won.');
}

// ---- the page around the trainer

document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/static/sections/endgames.css">');
document.body.insertAdjacentHTML('beforeend', `<dialog id="dlg-endgame" class="wide">
  <form method="dialog" class="dlg-head"><h2>♔ Endgame trainer</h2><button class="link">Close</button></form>
  <div class="eg-crumbs" id="eg-crumbs"></div>
  <div class="eg-body" id="eg-body"></div>
  <p class="hint" id="eg-status"></p>
</dialog>`);

sectionNav('btn-endgames', () => openEndgames());

// a bare board until a drill starts (the server's board is still the board page's game)
const EMPTY = { game_id: null, white: '?', black: '?', white_elo: null, black_elo: null, result: '*', opening: null,
  start_fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', moves: [], player_color: 'white' };

// ---- the drill in the scoreboard's place (user's call, 2026-10-12: nothing to score while the eval is hidden): the
// goal, the material, how it's going (slips, a Hold-it drill's moves so far), the moves played (a click steps there)

const drillPanel = takePanel('Drill');
drillPanel.onclick = (e) => {
  const b = e.target.closest('.ln-mv');
  if (b && state.play?.endgame) playView(+b.dataset.i + 1);
};

function renderDrill() {
  const p = state.play;
  const eg = p?.endgame;
  if (!eg) {
    if (drillPanel.dataset.key === 'none') return;
    drillPanel.dataset.key = 'none';
    drillPanel.innerHTML = '<div class="ln-empty"><button class="btn small" id="eg-pick-panel">Pick an ending</button></div>';
    $('eg-pick-panel').onclick = () => openEndgames();
    return;
  }
  const mine = Math.ceil(p.moves.length / 2);
  const key = [p.moves.join(' '), p.view, eg.slips, eg.expect, eg.done, eg.ok].join('|');
  if (drillPanel.dataset.key === key) return;
  drillPanel.dataset.key = key;
  const white = p.color === 'white';
  const goal = eg.outcome === 'win' ? 'Win it' : 'Hold it';
  const diff = eg.points[0] - eg.points[1];
  const facts = [
    `<span>Material <b>${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff)}</b></span>`,
    eg.source === 'tablebase' ? `<span>Slips <b>${eg.slips}</b></span>` : '',
    eg.outcome === 'draw' ? `<span>Moves <b>${Math.min(mine, EG_HOLD_MOVES)}/${EG_HOLD_MOVES}</b></span>` : '',
  ].filter(Boolean).join('');
  const result = eg.done ? `<div class="eg-p-result ${eg.ok ? 'ok' : 'fail'}">${eg.ok ? '✓ Done' : '✗ Not this time'}</div>` : '';
  drillPanel.innerHTML = `<div class="eg-p-head"><span class="eg-art"><span class="${white ? 'w' : 'b'}">${egGlyphs(eg.mine, white)}</span>`
    + `<span class="eg-vs">vs</span><span class="${white ? 'b' : 'w'}">${egGlyphs(eg.theirs, !white)}</span></span>`
    + `<span class="eg-p-goal">${goal}</span></div><div class="eg-p-facts">${facts}</div>${result}`
    + `<div class="ln-tree eg-p-moves">${lineHtml(p.moves, p.startFen, { on: p.view - 1 })}</div>`;
  drillPanel.querySelector('.ln-mv.on')?.scrollIntoView({ block: 'nearest' });
}

Object.assign(hooks, {
  afterUpdate: renderDrill,
  afterMyMove: egAfterMyMove,
  myTurn: egMyTurn,
  gameOver: egGameOver,
  takeback: egTakeback,
  retry: egRetry,
  foot: (p) => `Endgame drill · ${EG_MODES[egModeFor(p.endgame.spec, p.endgame.mode)][0]} · ${p.endgame.spec === 'pawns:even' ? 'Dead even' : egSpecLabel(p.endgame.spec)}`,
  saveable: () => !!state.play?.endgame,  // only a drill is worth coming back to
  idleInfo: () => {
    $('summary').innerHTML = '<div class="play-buttons"><button class="btn small" id="eg-pick">Pick an ending</button></div>';
    $('eg-pick').onclick = () => openEndgames();
  },
  blank: (note) => { setReview(EMPTY, note); setEngineVisible(false); },
  freshOnArrival: true,
  ready: (restored) => {
    if (restored) setEngineVisible(false);
    // a fresh drill of the kind you last picked is one click: the Start step, every choice remembered
    else openEndgames(egChoice.spec && egChoice.group ? 5 : 1);
  },
});
