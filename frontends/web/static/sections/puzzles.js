// Opening puzzles, their own page (/puzzles; user's call, 2026-10-11: each section separate). The board code calls
// in through `hooks` (a live puzzle's moves, status row, hint shapes, the Explain chip); nothing else sees this file.
// Tactics from real games in an opening you pick (core/puzzles.py: the Lichess puzzle database, the part it tags
// with an opening, i.e. puzzles from moves 1-19). The board starts one move early: the opponent's move that allows
// the tactic (the "trigger") plays itself, then you find the answer and the replies play themselves. The eval bar
// and the scoreboard stay off until it's over: they'd give the answer away.
// Patterns: puzzles sharing who punishes, with which piece, on which square and the motif ("after …Nxe5, dxe5
// forks" in the London), listed per opening in the picker, typical-of-this-opening ones apart from the ones that
// come up everywhere. Your puzzle level is an Elo-style number on Lichess's puzzle scale (localStorage).

import { Chess } from '../vendor/chess-1.4.0.js';
import {
  $, hooks, state, api, store, recall, esc, addMsg, setReview, setEngineVisible, setFoot, update, renderChips,
  currentGame, ask, goSection, markBoardTaken, sectionNav, takePanel, setOwnPanel,
} from '../app.js';


const PZ_TRIGGER_MS = 700;   // the opponent's move that sets the puzzle, after a moment to look at the board
const PZ_REPLY_MS = 450;
const PZ_SEEN_MAX = 300;     // recent puzzle ids the server skips
const PZ_START_RATING = 1000;
let pzTags = null;           // tag → {n, label, kind} (/api/puzzles/tags); {} when there's no database
let pzTopic = pzJson('pzTopic', null);   // {label, tags, color?}
let pzSide = recall('pzSide') || '';     // '' both, 'w', 'b': whose tactics
let pzToken = 0;
let pzSearchTimer = null;

function pzJson(key, fallback) {
  try { return JSON.parse(recall(key) || 'null') ?? fallback; } catch { return fallback; }
}
const pzRating = () => +(recall('pzRating') || PZ_START_RATING);
const pzTopicKey = (t) => t.tags.join(',');
// puzzles from your own reviewed games (core/my_puzzles.py): missed tactics and the ones your move allowed
const PZ_MINE = { label: 'Your mistakes', tags: ['mine'], mine: true };

// Elo against the puzzle's own rating; a bigger step for the first 20, so the level finds you quickly
function pzRate(puzzleRating, won) {
  const r = pzRating();
  const n = +(recall('pzCount') || 0);
  const expected = 1 / (1 + 10 ** ((puzzleRating - r) / 400));
  const next = Math.round(Math.max(400, Math.min(3000, r + (n < 20 ? 40 : 20) * ((won ? 1 : 0) - expected))));
  store('pzRating', String(next));
  store('pzCount', String(n + 1));
  return next - r;
}

function pzRecord(pz, ok) {
  pzSession.push(ok);
  const s = pzJson('pzStats', {});
  const keys = [`t:${pzTopicKey(pz.topic)}`, `p:${pzTopicKey(pz.topic)}|${pz.p.pattern}`];
  keys.forEach((k) => { s[k] = { tries: 0, solved: 0, ...s[k] }; s[k].tries++; if (ok) s[k].solved++; });
  store('pzStats', JSON.stringify(s));
}

async function pzLoadTags() {
  if (pzTags) return pzTags;
  try {
    const r = await api('/api/puzzles/tags');
    pzTags = r.available ? r.tags : {};
  } catch { return {}; }
  return pzTags;
}

// ---- the picker

function pzSetTopic(t) {
  pzTopic = t;
  store('pzTopic', JSON.stringify(t));
}

async function openPuzzles(topic) {
  await pzLoadTags();
  if (topic) pzSetTopic(topic);
  $('pz-q').value = '';
  pzRenderSide();
  pzRenderLevel();
  if (!$('dlg-puzzles').open) $('dlg-puzzles').showModal();
  if (pzTopic) pzShowTopic(); else pzSearch('');
}

function pzRenderSide() {
  $('pz-side').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.side === pzSide));
}

function pzRenderLevel() {
  const n = +(recall('pzCount') || 0);
  $('pz-level').innerHTML = n ? `Your puzzle level: <b>${pzRating()}</b> after ${n} puzzle${n > 1 ? 's' : ''} (Lichess puzzle scale; <button class="link pz-reset">reset</button>).`
    : `Your puzzle level: <b>${PZ_START_RATING}</b> (Lichess puzzle scale)`;
  const reset = $('pz-level').querySelector('.pz-reset');
  if (reset) reset.onclick = () => { store('pzRating'); store('pzCount'); pzRenderLevel(); };
}

const pzCount = (n) => `${n.toLocaleString()} puzzle${n === 1 ? '' : 's'}`;

async function pzSearch(q) {
  const body = $('pz-body');
  $('pz-side').classList.remove('hidden');
  document.querySelector('#dlg-puzzles .pz-foot').classList.remove('hidden');
  let res;
  try {
    res = await api(`/api/puzzles/openings?q=${encodeURIComponent(q)}`);
  } catch (e) {
    body.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
    return;
  }
  if ($('pz-q').value.trim() !== q) return;  // typed on since
  const rows = [];
  if (res.mine) {
    rows.push(`<div class="pz-gh">From your games</div><div class="pz-chips"><button class="pz-chip mine" data-mine>`
      + `Your mistakes <span class="pz-n">${res.mine.n ? `${pzCount(res.mine.n)} from ${res.mine.games} games` : 'find them in your games'}</span></button></div>`);
  }
  if (pzTopic && !q && !pzTopic.mine) {
    rows.push(`<div class="pz-gh">Last time</div><div class="pz-chips"><button class="pz-chip on" data-pick="last">${esc(pzTopic.label)}</button></div>`);
  }
  if (res.lessons.length) {
    rows.push(`<div class="pz-gh">Your opening lessons</div><div class="pz-chips">${res.lessons.map((l, i) =>
      `<button class="pz-chip" data-lesson="${i}" title="You play ${l.color} in this lesson">${esc(l.label)} <span class="pz-n">${l.n.toLocaleString()}</span></button>`).join('')}</div>`);
  }
  // a search that hits several openings ("london": the London System under Queen's Pawn Game, Indian Defense…)
  // gets one row for all of them
  const matched = [];
  res.openings.forEach((f) => {
    const fHit = q && q.toLowerCase().split(/\s+/).every((w) => f.label.toLowerCase().replace(/'/g, '').includes(w.replace(/'/g, '')));
    if (fHit) matched.push({ tag: f.tag, n: f.n });
    else f.variations.forEach((v) => matched.push({ tag: v.tag, n: v.n }));
  });
  if (q && matched.length > 1) {
    const n = matched.reduce((a, m) => a + m.n, 0);
    rows.push(`<div class="pz-chips"><button class="pz-chip all" data-all>Everything matching “${esc(q)}” <span class="pz-n">${n.toLocaleString()}</span></button></div>`);
  }
  if (res.openings.length) {
    rows.push(`<div class="pz-gh">${q ? 'Openings' : 'Openings with the most puzzles'}</div>`);
    rows.push(res.openings.map((f, i) => `<div class="pz-fam"><button class="pz-fam-name" data-fam="${i}">${esc(f.label)} <span class="pz-n">${pzCount(f.n)}</span></button>`
      + `<div class="pz-vars">${f.variations.slice(0, q ? 12 : 6).map((v, j) =>
        `<button class="pz-var" data-fam="${i}" data-var="${j}">${esc(v.label.startsWith(f.label + ': ') ? v.label.slice(f.label.length + 2) : v.label)} <span class="pz-n">${v.n.toLocaleString()}</span></button>`).join('')}</div></div>`).join(''));
  } else if (q) {
    rows.push(`<p class="hint">No opening in the puzzle database matches “${esc(q)}”.</p>`);
  }
  body.innerHTML = rows.join('');
  const pick = (t) => { pzSetTopic(t); pzShowTopic(); };
  body.querySelector('[data-pick=last]')?.addEventListener('click', () => pzShowTopic());
  body.querySelector('[data-mine]')?.addEventListener('click', () => pick(PZ_MINE));
  body.querySelectorAll('[data-lesson]').forEach((b) => {
    const l = res.lessons[+b.dataset.lesson];
    b.onclick = () => pick({ label: l.label, tags: l.tags, color: l.color });
  });
  body.querySelector('[data-all]')?.addEventListener('click', () => pick({ label: `“${q}” openings`, tags: matched.map((m) => m.tag).slice(0, 20) }));
  body.querySelectorAll('.pz-fam-name').forEach((b) => {
    const f = res.openings[+b.dataset.fam];
    b.onclick = () => pick({ label: f.label, tags: [f.tag] });
  });
  body.querySelectorAll('.pz-var').forEach((b) => {
    const v = res.openings[+b.dataset.fam].variations[+b.dataset.var];
    b.onclick = () => pick({ label: v.label, tags: [v.tag] });
  });
}

async function pzShowTopic() {
  const t = pzTopic;
  if (t.mine) return pzShowMine();
  $('pz-side').classList.remove('hidden');
  const body = $('pz-body');
  const side = pzSide ? (pzSide === 'w' ? 'White' : 'Black') : null;
  body.innerHTML = `<div class="pz-topic-head"><button class="link" id="pz-back">‹ All openings</button>`
    + `<h3>${esc(t.label)}</h3>${t.color ? `<span class="pz-n">you play ${esc(t.color)}</span>` : ''}</div><p class="hint">Finding the patterns…</p>`;
  $('pz-back').onclick = () => pzSearch($('pz-q').value.trim());
  let res;
  try {
    res = await api('/api/puzzles/patterns', { tags: t.tags, side: pzSide || null });
  } catch (e) {
    body.querySelector('.hint').textContent = e.message;
    return;
  }
  if (pzTopic !== t || !$('dlg-puzzles').open) return;
  const stats = pzJson('pzStats', {});
  const mine = stats[`t:${pzTopicKey(t)}`];
  const row = (p) => {
    const st = stats[`p:${pzTopicKey(t)}|${p.key}`];
    // "after X" only when one move sets it up most of the time: those are the "if they play X" patterns
    const after = p.trigger ? `<span class="pz-pa">after <b>${esc(p.trigger)}</b> (${p.trigger_pct}%)</span>` : '';
    const tip = `Most often after: ${p.triggers.map(([m, pct]) => `${m} ${pct}%`).join(', ')}`;
    return `<button class="pz-pat" data-key="${esc(p.key)}" title="${esc(tip)}"><span class="pz-dot ${p.solver}" title="${p.solver === 'white' ? 'White' : 'Black'} finds it"></span>`
      + `<span class="pz-pt">${esc(p.title)}</span>${after}`
      + `<span class="pz-pm">${pzCount(p.n)} · ~${p.rating}${p.lift >= 2 ? ` · <span class="pz-lift">${p.lift >= 10 ? Math.round(p.lift) : p.lift}× other openings</span>` : ''}</span>`
      + `${st ? `<span class="pz-st" title="Solved / tried">${st.solved}/${st.tries}</span>` : ''}</button>`;
  };
  const section = (title, sub, list) => (list.length
    ? `<div class="pz-gh" title="${esc(sub)}">${title}</div><div class="pz-pats">${list.map(row).join('')}</div>` : '');  // explainer as a tooltip
  body.innerHTML = `<div class="pz-topic-head"><button class="link" id="pz-back">‹ All openings</button><h3>${esc(t.label)}</h3>`
    + `<span class="pz-n">${pzCount(res.total)}${side ? ` where ${side} finds the tactic` : ''}${t.color ? ` · you play ${esc(t.color)}` : ''}</span>`
    + `${mine ? `<span class="pz-st">${mine.solved}/${mine.tries} solved</span>` : ''}</div>`
    + `<div class="pz-go"><button class="btn" id="pz-mixed">Start: mixed puzzles</button></div>`
    + section('Typical of this opening', 'comes up here at least twice as often as in other openings', res.typical)
    + section('Common here, and everywhere', 'the mates and forks every opening has', res.common)
    + (!res.typical.length && !res.common.length ? '<p class="hint">Too few puzzles here for patterns; mixed puzzles still work.</p>' : '');
  $('pz-back').onclick = () => pzSearch($('pz-q').value.trim());
  $('pz-mixed').onclick = () => startPuzzle();
  const all = [...res.typical, ...res.common];
  body.querySelectorAll('.pz-pat').forEach((b) => {
    const p = all.find((x) => x.key === b.dataset.key);
    b.onclick = () => startPuzzle({ key: p.key, title: p.title });
  });
}

// Your games: the groups by kind and motif. No rating here: these come from your games, not Lichess's ladder.
async function pzShowMine() {
  const body = $('pz-body');
  let res;
  try { res = (await api('/api/puzzles/openings')).mine; } catch (e) { body.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
  if (!res || !pzTopic?.mine || !$('dlg-puzzles').open) return;
  const stats = pzJson('pzStats', {});
  const row = (g) => {
    const st = stats[`p:mine|${g.key}`];
    return `<button class="pz-pat${g.motif ? '' : ' head'}" data-key="${esc(g.key)}"><span class="pz-dot ${g.kind === 'missed' ? 'mine' : 'theirs'}"></span>`
      + `<span class="pz-pt">${esc(g.title)}</span><span class="pz-pm">${pzCount(g.n)}</span>`
      + `${st ? `<span class="pz-st" title="Solved / tried">${st.solved}/${st.tries}</span>` : ''}</button>`;
  };
  const kind = (k, sub) => {
    const gs = res.groups.filter((g) => g.kind === k);
    return gs.length ? `<div class="pz-gh" title="${esc(sub)}">${esc(gs[0].title)}</div><div class="pz-pats">${gs.map(row).join('')}</div>` : '';
  };
  $('pz-side').classList.add('hidden');  // no sides here: missed = yours, allowed = theirs
  // the footer is about the Lichess puzzles (and the puzzle level, which these don't move)
  document.querySelector('#dlg-puzzles .pz-foot').classList.add('hidden');
  const job = pzMineJob;
  const names = pzAccounts(res.accounts, res.gone);
  const who = [names.chesscom.length && `${names.chesscom.join(', ')} (chess.com)`, names.lichess.length && `${names.lichess.join(', ')} (Lichess)`]
    .filter(Boolean).join(' and ');
  const checkLine = job?.status === 'running'
    ? `<p class="hint pz-job">${esc(job.phase)}…${job.total ? ` ${job.done}/${job.total}` : ''}</p>`
    // no explainer beside the button (user's call, 2026-10-10): what it does is its tooltip; only state shows here
    : `<div class="pz-update"><button class="btn ghost small pz-mine-run"${who ? '' : ' disabled'} title="${who
        ? esc(`Fetches the last ${PZ_UPDATE_GAMES} games of ${who}, reviews the new ones and looks for tactics (~30 s per new game)`) : ''}">Update from my games</button>`
      + `<span class="hint">${who ? '' : 'Enter your chess.com or Lichess name in Your games first.'}`
      + `${job?.status === 'done' ? `Last update: ${job.new_games} new game${job.new_games === 1 ? '' : 's'}, ${job.new_puzzles} new puzzle${job.new_puzzles === 1 ? '' : 's'}. ` : ''}`
      + `${res.pending && job?.status !== 'running' ? `${res.pending} reviewed game${res.pending > 1 ? 's' : ''} not checked yet.` : ''}</span></div>`
      + (job?.status === 'error' ? `<p class="hint pz-err">Update failed: ${esc(job.error)}</p>` : '')
      + (job?.warnings?.length && job.status !== 'running' ? job.warnings.map((w) => `<p class="hint pz-err">${esc(w)}</p>`).join('') : '');
  body.innerHTML = `<div class="pz-topic-head"><button class="link" id="pz-back">‹ All openings</button><h3>Your mistakes</h3>`
    + `<span class="pz-n">${pzCount(res.n)} from ${res.games} of your reviewed games</span></div>${checkLine}`
    + `<div class="pz-go"><button class="btn" id="pz-mixed">Start: mixed</button></div>`
    + kind('missed', 'your turn: one move won, you played another')
    + kind('allowed', "your move handed them a tactic: find it from their side")
    + (!res.n ? '<p class="hint">No missed tactics found in your reviewed games yet.</p>' : '');
  $('pz-back').onclick = () => pzSearch($('pz-q').value.trim());
  $('pz-mixed').onclick = () => startPuzzle();
  body.querySelector('.pz-mine-run')?.addEventListener('click', pzMineRun);
  body.querySelectorAll('.pz-pat').forEach((b) => {
    const g = res.groups.find((x) => x.key === b.dataset.key);
    b.onclick = () => startPuzzle({ key: g.key, title: g.title });
  });
}

// "Update from my games" runs on the server: fetch your latest games, review the new ones, mine them
// (/api/puzzles/mine/update). Polled while it runs; the list redraws if it's open, else a note in the chat at the end.
const PZ_UPDATE_GAMES = 30;  // per site, as UPDATE_GAMES in server.py
let pzMineJob = null;

// the accounts the server remembers plus this browser's names from Find games (case-insensitive, no repeats)
// (minus names the site said no longer exist: a browser can still have a renamed account in Find games)
function pzAccounts(saved = {}, gone = []) {
  const dead = (site, n) => gone.some(([s, g]) => s === site && g === n.toLowerCase());
  const merge = (site, list, extra) => [...(list || []), extra]
    .filter((n, i, all) => n && !dead(site, n) && all.findIndex((m) => m?.toLowerCase() === n.toLowerCase()) === i);
  return { chesscom: merge('chesscom', saved.chesscom, state.me), lichess: merge('lichess', saved.lichess, recall('meLichess')) };
}

async function pzMineRun() {
  let mine = {};
  try { mine = (await api('/api/puzzles/openings')).mine || {}; } catch {}
  try { pzMineJob = await api('/api/puzzles/mine/update', pzAccounts(mine.accounts, mine.gone)); } catch (e) { return void addMsg('error', esc(e.message)); }
  pzShowMine();
  while (pzMineJob?.status === 'running') {
    await new Promise((r) => setTimeout(r, 2000));
    try { pzMineJob = await api('/api/puzzles/mine/status'); } catch { break; }
    if ($('dlg-puzzles').open && pzTopic?.mine) pzShowMine();
  }
  if ($('dlg-puzzles').open && pzTopic?.mine) pzShowMine();  // the result or the error, in the list
  if (pzMineJob?.status === 'error' && !$('dlg-puzzles').open) addMsg('error', `Updating from your games failed: ${esc(pzMineJob.error)}`);
  else if (pzMineJob?.status === 'done' && !$('dlg-puzzles').open) {
    addMsg('system', `Your games are updated: ${pzMineJob.new_games} new game(s) reviewed, ${pzMineJob.new_puzzles} new puzzle(s) in Puzzles → Your mistakes.`);
  }
}

// ---- a puzzle on the board

async function startPuzzle(pattern = null) {
  const topic = pzTopic;
  if (!topic) return openPuzzles();
  const token = ++pzToken;
  let res;
  try {
    res = await api('/api/puzzles/next', { tags: topic.tags, side: pzSide || null, rating: pzRating(),
      pattern: pattern?.key || null, exclude: pzJson('pzSeen', []), mine: !!topic.mine });
  } catch (e) {
    if ($('dlg-puzzles').open) $('pz-body').insertAdjacentHTML('afterbegin', `<p class="hint pz-err">${esc(e.message)}</p>`);
    else addMsg('error', esc(e.message));
    return;
  }
  if (token !== pzToken) return;
  markBoardTaken();  // the server's board is the puzzle's now: the board page reopens its own on the way back
  if ($('dlg-puzzles').open) $('dlg-puzzles').close();
  const first = !state.puzzle;
  setReview(res.review, first ? `Opening puzzles: ${topic.label}. Their move plays first; then find the tactic.` : null, null, { keepChat: !first });
  pzBegin(res.puzzle, topic, pattern);
}

function pzBegin(p, topic, pattern) {
  store('pzSeen', JSON.stringify([...pzJson('pzSeen', []), p.id].slice(-PZ_SEEN_MAX)));
  state.puzzle = { p, topic, pattern, step: 0, waiting: true, misses: 0, hint: 0, failed: false, done: false, rated: false };
  state.orientation = p.solver;
  setEngineVisible(false);
  renderChips();
  update();
  const side = p.solver === 'white' ? 'White' : 'Black';
  const goal = p.kind === 'missed' ? `Your game: ${side} to play after their move. There was a tactic here; find it`
    : p.kind === 'allowed' ? `Your game: after your move, you're ${side}. Find the tactic your move allowed`
    : `${side} to play after their move: find the tactic`;
  addMsg('coach sb-msg', `<div class="eg-card pz-card"><div class="eg-ch"><span class="sb-al">Puzzle</span><span class="pz-n">${pzWhere(p)}</span></div>`
    + `<div class="eg-goal">${esc(goal)}</div>`
    + `<div class="card-sub">${esc(p.variation)}${pattern ? ` · drilling ${esc(pattern.title)}` : ''}${p.mine ? pzGameLink(p, ' · ') : ''}</div></div>`);
  pzReply(PZ_TRIGGER_MS);
}

// the opponent's next move: the trigger at the start, a reply after each of yours
function pzReply(delay) {
  const pz = state.puzzle;
  const token = ++pzToken;
  pz.waiting = true;
  setTimeout(() => {
    if (token !== pzToken || state.puzzle !== pz) return;
    state.extra.push(pz.p.sans[pz.step]);
    pz.step++;
    pz.waiting = false;
    update();
  }, delay);
}

function onPuzzleMove(orig, dest) {
  const pz = state.puzzle;
  const want = pz.p.moves[pz.step];
  const c = currentGame();
  let mv;
  try {
    // the solution may under-promote; any other promotion is a queen
    mv = c.move({ from: orig, to: dest, promotion: want.slice(0, 4) === orig + dest && want[4] ? want[4] : 'q' });
  } catch { update(); return; }
  const uci = mv.from + mv.to + (mv.promotion || '');
  // any mate counts (Lichess accepts an alternative mate on the last move)
  if (uci === want || c.isCheckmate()) {
    state.extra.push(mv.san);
    pz.step++;
    pz.hint = 0;
    if (pz.step >= pz.p.moves.length || c.isCheckmate()) return pzFinish();
    update();
    pzReply(PZ_REPLY_MS);
    return;
  }
  pz.misses++;
  pz.failed = true;
  pz.hint = Math.max(pz.hint, Math.min(3, pz.misses + 1));
  update();  // snaps the piece back; pzShapes circles the piece, then shows the move
  addMsg('system', pz.misses === 1 ? `Not ${esc(mv.san)}: this one counts as missed, but find it anyway. The circled piece moves.`
    : `Not ${esc(mv.san)}. The arrow shows the move.`);
}

// where a puzzle comes from: its Lichess rating, or the game of yours it's from
const pzWhere = (p) => (p.mine ? `Your game vs ${esc(p.opponent)}${p.date ? ` · ${esc(p.date.replaceAll('.', '-'))}` : ''}` : `~${p.rating}`);

function pzHintText(p) {
  if (p.motif === 'mate') return p.mate_in ? `There's mate in ${p.mate_in}` : 'Look for checkmate';
  if (p.motif === 'other') return 'Something can be won: look at every check, capture and threat';
  return `Theme: ${p.motif_label}`;
}

// Hint ladder: the theme (free), then the piece, then the move (both count as a miss)
function pzHint() {
  const pz = state.puzzle;
  if (!pz || pz.done || pz.waiting) return;
  pz.hint = Math.min(3, pz.hint + 1);
  if (pz.hint >= 2) pz.failed = true;
  update();
}

function pzShapes() {
  const pz = state.puzzle;
  if (!pz || pz.done || pz.waiting || pz.hint < 2) return [];
  const u = pz.p.moves[pz.step];
  return pz.hint >= 3 ? [{ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: 'blue' }] : [{ orig: u.slice(0, 2), brush: 'yellow' }];
}

// "19. Rxe8+", "19... Qxe8 20. Nf4 Qe3+": numbered from the position's own move number
function pzNumbered(fen, sans) {
  let [, turn, , , , num] = fen.split(' ');
  let n = +num;
  return sans.map((san, i) => {
    const s = turn === 'w' ? `${n}. ${san}` : i === 0 ? `${n}... ${san}` : san;
    if (turn === 'b') n++;
    turn = turn === 'w' ? 'b' : 'w';
    return s;
  }).join(' ');
}

function pzFinish() {
  const pz = state.puzzle;
  const { p } = pz;
  pz.done = true;
  pz.waiting = false;
  const ok = !pz.failed;
  let delta = null;
  if (!pz.rated) {  // a retry doesn't count again
    pz.rated = true;
    if (p.rating != null) delta = pzRate(p.rating, ok);  // your own games' puzzles have no rating
    pzRecord(pz, ok);
  }
  setEngineVisible(recall('engineOn') !== '0');  // the eval and the scoreboard are back for a look around
  renderChips();
  update();
  const g = new Chess(p.fen);
  g.move(p.sans[0]);
  const deltaHtml = delta === null ? '' : ` <span class="pz-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : '−'}${Math.abs(delta)}</span>`;
  const msg = addMsg('coach sb-msg', `<div class="eg-card pz-result ${ok ? 'ok' : 'fail'}">`
    + `<div class="eg-goal">${ok ? '✓ Solved' : pz.misses ? '✗ Missed' : '✗ Solved with help'}${deltaHtml}</div>`
    + `<div class="pz-line"><span class="pz-k">They played</span>${esc(pzNumbered(p.fen, [p.sans[0]]))}</div>`
    + `<div class="pz-line"><span class="pz-k">Tactic</span><b>${esc(pzNumbered(g.fen(), p.sans.slice(1)))}</b></div>`
    + (p.mine ? `<div class="pz-line"><span class="pz-k">In the game</span>${esc(pzGameText(p))}</div>` : '')
    + (p.flavour?.length ? `<div class="pz-line"><span class="pz-k">Why</span>${esc(p.flavour.join(' · '))}</div>` : '')
    + `<div class="card-sub">${esc(p.motif_label)} · ${esc(p.variation)} · ${p.mine ? pzWhere(p) : `puzzle ~${p.rating} · your level ${pzRating()}`}</div>`
    + '<div class="eg-actions"><button class="btn small" data-a="next">Next puzzle</button><button class="btn ghost small" data-a="retry">Try again</button>'
    + `<button class="btn ghost small" data-a="why" title="Asks the coach (paid)">Explain it</button>`
    + (p.mine ? `<button class="btn ghost small" data-a="game">Open the game here</button>${pzGameLink(p, '', 'btn ghost small')}`
      : p.game_url ? `<a class="btn ghost small" href="${esc(p.game_url)}" target="_blank" rel="noopener">The game on Lichess</a>` : '')
    + '<button class="btn ghost small" data-a="patterns">Patterns</button></div></div>');
  msg.querySelector('[data-a=next]').onclick = () => startPuzzle(pz.pattern);
  msg.querySelector('[data-a=retry]').onclick = () => pzRetry(pz);
  msg.querySelector('[data-a=why]').onclick = () => pzExplain(pz);
  msg.querySelector('[data-a=patterns]').onclick = () => openPuzzles();
  msg.querySelector('[data-a=game]')?.addEventListener('click', () => pzOpenGame(p));
}

// your game on chess.com / Lichess, at the puzzle's move (opens in a new tab)
function pzGameLink(p, before, cls = '') {
  if (!p.game_url) return '';
  const site = p.game_url.includes('lichess') ? 'Lichess' : 'chess.com';
  return `${before}<a${cls ? ` class="${cls}"` : ''} href="${esc(p.game_url)}" target="_blank" rel="noopener">The game on ${site} ↗</a>`;
}

function pzGameText(p) {
  const lost = p.lost ? ` (−${p.lost}% win chance)` : '';
  if (p.kind === 'missed') return `you played ${p.your_move}${lost}`;
  return `you played ${p.your_move}${lost}; they ${p.found ? `found it: ${p.game_move}` : `missed it and played ${p.game_move || 'nothing more'}`}`;
}

// the saved review of that game, on the puzzle's position (the trigger played: the moment you had to see it)
// (games live on the board page)
function pzOpenGame(p) {
  goSection('board', { game: { id: p.game_id, ply: p.ply, note: `Your game vs ${p.opponent}, at the puzzle's position.` } });
}

function pzRetry(pz) {
  if (state.puzzle !== pz) return;
  Object.assign(pz, { step: 0, misses: 0, hint: 0, failed: false, done: false });
  state.extra = [];
  setEngineVisible(false);
  renderChips();
  update();
  pzReply(PZ_TRIGGER_MS);
}

function pzExplain(pz) {
  const { p } = pz;
  const g = new Chess(p.fen);
  g.move(p.sans[0]);
  ask(`Explain this puzzle from the ${p.variation}. After ${pzNumbered(p.fen, [p.sans[0]])}, the tactic is ${pzNumbered(g.fen(), p.sans.slice(1))} `
    + `(Lichess tags it: ${p.themes.join(', ')}). Why was ${p.sans[0]} a mistake, how does the tactic work, and is it a pattern worth remembering `
    + 'in this opening? Keep it short.', { hideQuestion: true });
}

function pzExit() {
  pzExited = true;
  state.puzzle = null;
  pzToken++;
  setEngineVisible(recall('engineOn') !== '0');
  renderChips();
  addMsg('system', 'Left the puzzles. The board stays as an analysis board.');
  update();
}

function renderPuzzleInfo() {
  const pz = state.puzzle;
  const { p } = pz;
  // the opening is in the pill above the board; here, where the puzzle comes from
  setFoot(p.mine ? `From your game vs ${p.opponent}` : `Lichess puzzle · rated ~${p.rating}`);
  const side = p.solver === 'white' ? 'White' : 'Black';
  const status = pz.done ? (pz.failed ? 'Over: look around, or the next one.' : 'Solved ✓') : pz.waiting ? 'Their move…' : `${side} to play`;
  const hint = !pz.done && pz.hint ? ['', pzHintText(p), 'The circled piece moves', 'The arrow shows the move'][pz.hint] : '';
  const ladder = !pz.done ? `<button class="btn ghost small" id="pz-hint"${pz.waiting || pz.hint >= 3 ? ' disabled' : ''}>${['Hint', 'Which piece?', 'Show move', 'Show move'][pz.hint]}</button>` : '';
  $('summary').innerHTML = `<span class="pz-status" title="${esc(hint || status)}"><span class="label">${esc(status)}</span>`
    + `${hint ? `<span class="label pz-hint">${esc(hint)}</span>` : ''}</span>${ladder}`
    + `<button class="btn ghost small" id="pz-next">${pz.done ? 'Next' : 'Skip'}</button><button class="btn ghost small" id="pz-exit">Exit</button>`;
  $('pz-hint')?.addEventListener('click', pzHint);
  // skipping an unsolved puzzle counts as a miss, like giving up on Lichess
  $('pz-next').onclick = () => {
    if (!pz.done && !pz.rated) { pz.rated = true; if (p.rating != null) pzRate(p.rating, false); pzRecord(pz, false); }
    startPuzzle(pz.pattern);
  };
  $('pz-exit').onclick = pzExit;
}

// ---- the page around the puzzles

document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/static/sections/puzzles.css">');
document.body.insertAdjacentHTML('beforeend', `<dialog id="dlg-puzzles" class="wide">
  <form method="dialog" class="dlg-head"><h2>Puzzles</h2><button class="link">Close</button></form>
  <div class="pz-opts">
    <div class="search-box"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg><input id="pz-q" type="search" aria-label="Search openings" autocomplete="off"></div>
    <div class="seg" id="pz-side" title="Whose tactics: puzzles where this side finds the tactic">
      <button data-side="">Both sides</button><button data-side="w">White</button><button data-side="b">Black</button>
    </div>
  </div>
  <div id="pz-body" class="pz-body"></div>
  <p class="hint pz-foot"><span id="pz-level"></span></p>
</dialog>`);

$('pz-q').oninput = () => {
  clearTimeout(pzSearchTimer);
  pzSearchTimer = setTimeout(() => pzSearch($('pz-q').value.trim()), 200);
};
$('pz-side').querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    pzSide = b.dataset.side;
    store('pzSide', pzSide);
    pzRenderSide();
    if (!$('pz-q').value.trim() && pzTopic && $('pz-body').querySelector('.pz-topic-head')) pzShowTopic();
  };
});

sectionNav('btn-puzzles', () => openPuzzles());

// the starting position until a puzzle is picked (the server's board is still the board page's game)
const EMPTY = { game_id: null, white: '?', black: '?', white_elo: null, black_elo: null, result: '*', opening: null,
  start_fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: [], player_color: 'white' };

// ---- the puzzle in the scoreboard's place while you solve it (user's call, 2026-10-12: the scoreboard would give it
// away): where it's from, the opening, your level, this visit's results. Once it's over (or after Exit) the
// scoreboard comes back for a look around; before the first puzzle the panel opens the picker.

const pzSession = [];  // this visit's results, true = solved clean (pzRecord)
const pzPanel = takePanel('Puzzle');

function renderPzPanel() {
  const pz = state.puzzle;
  const own = !pz ? !pzSession.length && !pzExited : !pz.done;
  if (own !== document.body.classList.contains('own-panel')) {
    setOwnPanel(own);
    if (!own) return void update();  // the scoreboard searches this position now
  }
  if (!own) return;
  if (!pz) {
    if (pzPanel.dataset.key === 'none') return;
    pzPanel.dataset.key = 'none';
    pzPanel.innerHTML = '<div class="ln-empty"><button class="btn small" id="pz-pick-panel">Puzzles</button></div>';
    $('pz-pick-panel').onclick = () => openPuzzles();
    return;
  }
  const { p } = pz;
  const key = `${p.id}|${pzSession.length}`;
  if (pzPanel.dataset.key === key) return;
  pzPanel.dataset.key = key;
  const solved = pzSession.filter(Boolean).length;
  pzPanel.innerHTML = `<div class="pz-p-head"><span class="pz-p-src">${p.mine ? 'Your game' : 'Lichess puzzle'}</span>`
    + `<span class="pz-n">${pzWhere(p)}</span></div>`
    + `<div class="pz-p-row">${esc(p.variation)}</div>`
    + (pz.pattern ? `<div class="pz-p-row"><span class="pz-k">Drilling</span>${esc(pz.pattern.title)}</div>` : '')
    + (p.mine ? '' : `<div class="pz-p-row"><span class="pz-k">Your level</span><b>${pzRating()}</b></div>`)
    + (pzSession.length ? `<div class="pz-p-row"><span class="pz-k">This visit</span><b>${solved}/${pzSession.length}</b>`
      + `<span class="pz-p-dots">${pzSession.slice(-20).map((ok) => `<i class="${ok ? 'ok' : 'miss'}"></i>`).join('')}</span></div>` : '');
}
let pzExited = false;  // after Exit the board is an analysis board: the scoreboard's

Object.assign(hooks, {
  afterUpdate: renderPzPanel,
  puzzleMove: onPuzzleMove,
  puzzleInfo: renderPuzzleInfo,
  puzzleShapes: pzShapes,
  explainPuzzle: pzExplain,
  // a puzzle is never restored, not even on a refresh (it never was): the picker opens instead
  freshOnArrival: true,
  saveable: () => false,
  blank: (note) => setReview(EMPTY, note),
  // with no puzzle running (none yet, or after Exit) the row above the board opens the picker
  idleInfo: () => {
    $('summary').innerHTML = '<div class="play-buttons"><button class="btn small" id="pz-pick">Puzzles</button></div>';
    $('pz-pick').onclick = () => openPuzzles();
  },
  ready: (restored, intent) => {
    // the game report's "Practice from this game": that game's group in Your mistakes
    if (intent?.practice) { pzSetTopic(PZ_MINE); startPuzzle({ key: intent.practice }); }
    else openPuzzles();
  },
});
