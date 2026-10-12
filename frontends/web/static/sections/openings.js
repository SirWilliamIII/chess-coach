// Opening lessons, their own page (/openings; user's call, 2026-10-11: each section separate). The board code calls
// in through `hooks` (moves, the nav buttons, the status row, the guide arrows and squares, card chips, Walk me
// through, Back to the lesson); nothing else loads this file. Arriving always opens the picker, even on a refresh.
// A lesson is a tree built once on the server (core/study.py: master games + engine + the coach's
// notes) and saved, so walking and drilling it is free. It runs on the analysis board: the board is
// the start position plus `state.extra`, and `state.study.node` is the tree node those moves reach
// (null when you've played off the lesson). Learn: one move at a time — the next lesson move is an
// arrow on the board (all the opponent's tries where they have a choice) plus arrows for what the last
// move newly attacks, and you advance only by playing your lesson move yourself (no forward button);
// the opponent's reply plays itself after a pause, picked among their tries of similar value; cards
// explain each step. Drill: you play your side, the app answers with the opponent's tries
// weighted by how often masters play them, and a wrong move is caught with the right one and its note.

import { Chess } from '../vendor/chess-1.4.0.js';
import {
  $, hooks, state, api, recall, esc, addMsg, ask, setReview, setEngineVisible, setFoot, update, renderChips,
  currentGame, botMove, levelForRating, getBotLevels, bumpPlayToken, markBoardTaken, sectionNav, setDemoTimer,
  CHIPS, CHIP_TIPS, START_FEN, baseShapes, cg, closeDemo, evalPill, knightShapes, openDemo, stopAutoplay, syncCards,
} from '../app.js';


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
  studyWatchBuild();
}

// A lesson build runs on the server (4-6 minutes) and goes on if you leave the page: coming back, the picker shows
// its progress and lists the lesson as built when it's done. A build started here is followed by
// startStudyFromDialog() instead.
let studyWatching = false;
async function studyWatchBuild() {
  if (studyWatching || studyBuilding) return;
  studyWatching = true;
  try {
    let j = await api('/api/study/job');
    while (j.status === 'running' && !studyBuilding) {
      if ($('dlg-study').open) $('study-status').textContent = `Building a lesson: ${j.message}`;
      await new Promise((r) => setTimeout(r, 2000));
      j = await api('/api/study/job');
      if (j.status !== 'running' && !studyBuilding && $('dlg-study').open) {
        $('study-status').textContent = j.status === 'error' ? `The lesson build failed: ${j.error}` : 'The lesson is built.';
        searchStudies($('study-q').value);
      }
    }
  } catch {} finally { studyWatching = false; }
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

let studyBuilding = false;  // startStudyFromDialog is following a build itself
async function startStudyFromDialog() {
  if (!studyPick) return;
  const req = { name: studyPick.name };
  $('study-go').disabled = true;
  studyBuilding = true;
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
    markBoardTaken();  // the server's board is the lesson's now: the board page reopens its own on the way back
    $('dlg-study').close();
    startStudy(study, review);
  } catch (e) {
    $('study-status').textContent = e.message;
  } finally {
    studyBuilding = false;
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
  setDemoTimer(setInterval(() => {
    if (state.demo !== d || d.step >= line.length) return stopAutoplay();
    d.step++;
    update();
  }, LESSON_STEP_MS));
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
const PLAY_ON_ELO = [1100, 1800];  // the bot is picked at random from the levels in this range (chess.com; Lichess ~1500-2000)

async function studyPlayOn(id) {
  const st = state.study;
  const line = studyLine(id);
  const color = st.data.color;
  const levels = await getBotLevels().catch(() => []);
  const pool = levels.map((l) => ({ ...l, elo: +(l.name.match(/~(\d+)/)?.[1]) }))
    .filter((l) => l.elo >= PLAY_ON_ELO[0] && l.elo <= PLAY_ON_ELO[1]);
  const level = pool.length ? pool[Math.floor(Math.random() * pool.length)] : await levelForRating(1100);
  if (state.study !== st) return;
  bumpPlayToken();
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
  bumpPlayToken();
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

// nav buttons: back/start move along the lesson (or undo off-lesson moves); forward does nothing (app.js)
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
        + (n.children.length > 1 && n.maia ? `<span class="card-sub">% = how often ~${st.data.human_rating} players play it</span>` : '') + '</div>');
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
  setFoot(`Lesson · ${st.data.name}`, st.data.name);  // your side is on your name row
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

// ---- the page around the lessons

document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/static/sections/openings.css">');
document.body.insertAdjacentHTML('beforeend', `<dialog id="dlg-study">
  <form method="dialog" class="dlg-head"><h2>Learn an opening</h2><button class="link">Close</button></form>
  <div class="row"><div class="search-box"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg><input id="study-q" aria-label="Search openings" autocomplete="off"></div></div>
  <div id="study-list" class="games-list study-picker"></div>
  <p class="hint" id="study-status"></p>
  <div class="row end"><button class="btn" id="study-go" disabled>Pick an opening</button></div>
</dialog>`);
$('study-go').onclick = startStudyFromDialog;
$('study-q').oninput = (e) => { studyPick = null; $('study-go').disabled = true; searchStudies(e.target.value); };

sectionNav('btn-study', () => openStudyDialog());

// the starting position until a lesson is picked (the server's board is still the board page's game)
const EMPTY = { game_id: null, white: '?', black: '?', white_elo: null, black_elo: null, result: '*', opening: null,
  start_fen: START_FEN, moves: [], player_color: 'white' };

Object.assign(hooks, {
  studyMove: onStudyMove,
  // you play your side, the app plays theirs (Learn and Drill alike)
  studyCanMove: (turn) => {
    const cv = state.study.curve;
    return !state.study.waiting && turn === state.study.data.color && (cv ? !cv.solved : studyNodeHere() !== null);
  },
  studyGoTo,
  studyInfo: renderStudyInfo,
  studyShapes: () => (state.study.curve ? curveShapes() : state.study.mode === 'learn' ? studyGuideShapes() : []),
  studyNextSquares,
  studyChipLive,
  studyWalkthrough,
  backToLesson,
  freshOnArrival: true,
  saveable: () => false,  // the picker every time (user's call, 2026-10-11)
  blank: (note) => setReview(EMPTY, note),
  // with no lesson running (none yet, or after Exit lesson) the row above the board opens the picker
  idleInfo: () => {
    $('summary').innerHTML = '<div class="play-buttons"><button class="btn small" id="st-pick">Learn openings</button></div>';
    $('st-pick').onclick = () => openStudyDialog();
  },
  ready: () => openStudyDialog(),
});
