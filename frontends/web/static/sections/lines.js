// Explore lines, its own page (/lines; user's call, 2026-10-12: each section separate): the lines in data/openings.md
// and data/openings/*.md, grouped by the header they sit under (same header in two files = one group), as a list in
// the scoreboard's place (takePanel(); the phone's middle tab reads "Lines"). The
// scoreboard doesn't search or render under it (app.js ownPanel() gates requestScoreboard / renderKeyCard /
// requestMaiaLines), so stepping through a line costs the engines nothing.
// Read-only: a line opens on the demo board (◀ ▶ step through it, Clear board empties it). The list is fetched when
// the page loads (the server keeps it warm), and groups fill in only when opened, since there are thousands of lines.
// Arriving always starts from a fresh analysis board and the whole list, like the other exercise-style sections.

import {
  $, hooks, api, esc, markdown, openDemo, demoStep, setReview, setPhonePage, takePanel,
  markBoardTaken, sectionNav, PHONE, TOUCH, START_FEN,
} from '../app.js';

// the list's markup first: the list code below wires listeners on it as it loads
document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/static/sections/lines.css">');
takePanel('Explore lines', 'Lines').innerHTML = `
  <div class="search-box rep-search">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>
    <input id="rep-q" aria-label="Search lines" autocomplete="off" spellcheck="false">
    <button class="rep-clear hidden" id="rep-clear" title="Clear the search"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button>
  </div>
  <div id="rep-list" class="rep-list"></div>`;

let repSections = null, repOpenKey = null;
let repFetch = null;

function repLoad() {
  repFetch ??= api('/api/repertoire').then((r) => { repSections = r.sections; repBuildIndex(); }).catch((e) => { repFetch = null; throw e; });
  return repFetch;
}

// "Nxd4+" → "nd4", "0-0" / "O-O" → "oo", "1...c5" → "c5": the same key for the line's SAN and whatever was typed
const repMoveKey = (t) => t.toLowerCase().replace(/^\d+\.+/, '').replace(/[x+#!?=]/g, '').replace(/0/g, 'o').replace(/-/g, '');
const REP_MOVE = /^([kqrbn]?[a-h]?[1-8]?[a-h][1-8][qrbn]?|oo|ooo)$/;
// "Maróczy" → "maroczy", "King's" → "kings", hyphens and punctuation split words
const repWords = (t) => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '')
  .split(/[^a-z0-9]+/).filter(Boolean);

let repIndex = [];  // one entry per line: where it is, its move keys, its words by field

function repBuildIndex() {
  repIndex = [];
  repSections.forEach((sec, si) => sec.groups.forEach((g, gi) => g.lines.forEach((ln, li) => {
    repIndex.push({ si, gi, li, moves: ln.moves.map(repMoveKey),
      label: repWords(g.label), eco: repWords(`${ln.eco || ''} ${ln.name || ''}`), sec: repWords(sec.title) });
  })));
}

// optimal string alignment distance, capped: is `a` within one edit (incl. a swapped pair: "nadjorf") of `b`?
function repNear(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] <= 1;
}

// a typed word against one field's words: a word's start ("sicil"), the field run together ("counterattack" vs
// "Counter Attack"), or one typo away for words of 5+ letters
function repWordIn(w, words) {
  if (words.some((x) => x.startsWith(w)) || words.join('').includes(w)) return true;
  return w.length >= 5 && words.some((x) => repNear(w, x) || (x.length > w.length && repNear(w, x.slice(0, w.length))));
}

// the typed moves in order inside the line: 3 = the line starts with them, 2 = all in a row somewhere, 1 = in
// order with other moves between (the tightest such stretch counts). → {tier, span, end} or null
function repMoveMatch(q, moves) {
  if (q.every((m, i) => moves[i] === m)) return { tier: 3, span: q.length, end: q.length - 1 };
  let best = null;
  for (let s = 0; s < moves.length; s++) {
    if (moves[s] !== q[0]) continue;
    let k = 1, i = s + 1;
    for (; i < moves.length && k < q.length; i++) if (moves[i] === q[k]) k++;
    if (k < q.length) break;  // later starts can't finish either
    const span = i - s, tier = span === q.length ? 2 : 1;
    if (!best || tier > best.tier || (tier === best.tier && span < best.span)) best = { tier, span, end: i - 1 };
  }
  return best;
}

function repSearch(query) {
  const toks = query.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const q = [], words = [];
  for (const t of toks) {
    const m = repMoveKey(t);
    if (!m) continue;  // a bare move number ("1.", "2...")
    if (REP_MOVE.test(m)) q.push(m); else words.push(...repWords(t));
  }
  if (!q.length && !words.length) return null;
  const groups = new Map();
  for (const e of repIndex) {
    let score = 0, end = null;
    if (q.length) {
      const m = repMoveMatch(q, e.moves);
      if (!m) continue;
      score += m.tier * 1000 - m.span * 5 - e.moves.length * 0.1;  // ties: the shorter line is closer to what was typed
      end = m.end;
    }
    let ok = true;
    for (const w of words) {
      if (repWordIn(w, e.label)) score += 30;
      else if (repWordIn(w, e.eco)) score += 20;
      else if (repWordIn(w, e.sec)) score += 10;
      else { ok = false; break; }
    }
    if (!ok) continue;
    const key = `${e.si}:${e.gi}`;
    const g = groups.get(key) || { si: e.si, gi: e.gi, score: -Infinity, lines: [] };
    g.score = Math.max(g.score, score);
    g.lines.push({ li: e.li, score, end });
    groups.set(key, g);
  }
  const out = [...groups.values()];
  out.forEach((g) => g.lines.sort((a, b) => b.score - a.score || a.li - b.li));
  return out.sort((a, b) => b.score - a.score || a.si - b.si || a.gi - b.gi);
}

// ---- the list

const REP_MAX_RESULTS = 80;
const repOpenSecs = new Set(), repOpenGroups = new Set();
let repLastQuery = '';

const REP_CHEV = '<svg class="rep-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6.5L15 12l-5.5 5.5"/></svg>';

// one opening row; a group of one line opens it, a bigger group folds its lines out. `only` = the lines to list
// (search results), each {li, end}. No counts or trap tags on the rows (user's call): names only; traps show on
// the board when the line reaches them.
function repGroupHtml(si, gi, only, withSection) {
  const sec = repSections[si], g = sec.groups[gi];
  const items = only || g.lines.map((_, li) => ({ li, end: null }));
  const key = `${si}:${gi}`;
  const single = items.length === 1;
  const open = !single && repOpenGroups.has(key);
  const on = single && repOpenKey === `${key}:${items[0].li}`;
  const act = single ? `line:${items[0].li}:${items[0].end ?? ''}` : 'fold';
  const lead = single ? '<span class="rep-lead"></span>' : REP_CHEV;
  // search results come from every header, so each says which one (and, for one line of a bigger group, its branch)
  const branch = single && g.lines.length > 1 ? g.lines[items[0].li].div : null;
  const under = withSection ? `<span class="rep-under">${esc(sec.title)}${branch ? ` · ${esc(branch)}` : ''}</span>` : '';
  return `<div class="rep-group${open ? ' open' : ''}" data-key="${key}">
    <button class="rep-row${on ? ' on' : ''}" data-act="${act}">${lead}<span class="rep-text"><span class="rep-name">${esc(g.label)}</span>${under}</span></button>
    ${open ? repSubsHtml(si, gi, items) : ''}</div>`;
}

function repSubsHtml(si, gi, items) {
  const g = repSections[si].groups[gi];
  return `<div class="rep-subs">${items.map(({ li, end }) => `<button class="rep-row sub${repOpenKey === `${si}:${gi}:${li}` ? ' on' : ''}" data-act="line:${li}:${end ?? ''}">${esc(g.lines[li].div || 'Line')}</button>`).join('')}</div>`;
}

function renderRepertoire() {
  if (!repSections) return;
  const box = $('rep-list');
  if (!repSections.length) return void (box.innerHTML = '<div class="card-sub">No lines yet: put markdown files in data/openings/.</div>');
  const query = $('rep-q').value.trim();
  if (query !== repLastQuery) { repOpenGroups.clear(); repLastQuery = query; }
  const results = query ? repSearch(query) : null;
  if (results) {
    if (!results.length) return void (box.innerHTML = '<div class="rep-empty">Nothing matches. Try fewer words, or moves in the order they’re played.</div>');
    const nLines = results.reduce((n, g) => n + g.lines.length, 0);
    const shown = results.slice(0, REP_MAX_RESULTS);
    // a short list: fold the openings out, so the lines are one click away
    if (results.length <= 3) shown.forEach((g) => { if (g.lines.length > 1) repOpenGroups.add(`${g.si}:${g.gi}`); });
    box.innerHTML = `<div class="rep-note">${nLines} line${nLines === 1 ? '' : 's'} in ${results.length} opening${results.length === 1 ? '' : 's'}${results.length > shown.length ? `, best ${shown.length} shown: add a move or a word to narrow it` : ''}</div>`
      + shown.map((g) => repGroupHtml(g.si, g.gi, g.lines, true)).join('');
    repResults = new Map(shown.map((g) => [`${g.si}:${g.gi}`, g.lines]));
  } else {
    repResults = null;
    box.innerHTML = repSections.map((sec, si) => {
      return `<details class="rep-sec" data-si="${si}"${repOpenSecs.has(si) ? ' open' : ''}><summary>${REP_CHEV}<span class="rep-title">${esc(sec.title)}</span></summary>
        <div class="rep-groups">${repOpenSecs.has(si) ? sec.groups.map((_, gi) => repGroupHtml(si, gi, null, false)).join('') : ''}</div></details>`;
    }).join('');
    box.querySelectorAll('.rep-sec').forEach((el) => el.addEventListener('toggle', () => {
      const si = +el.dataset.si;
      if (el.open) {
        repOpenSecs.add(si);
        const inner = el.querySelector('.rep-groups');
        if (!inner.childElementCount) inner.innerHTML = repSections[si].groups.map((_, gi) => repGroupHtml(si, gi, null, false)).join('');
      } else repOpenSecs.delete(si);
    }));
  }
}

let repResults = null;  // search results on screen: "si:gi" → the matching lines

// one listener for the whole list (rows are re-rendered often)
$('rep-list').addEventListener('click', (e) => {
  const row = e.target.closest('.rep-row');
  if (!row) return;
  const groupEl = row.closest('.rep-group');
  const [si, gi] = groupEl.dataset.key.split(':').map(Number);
  const act = row.dataset.act;
  if (act === 'fold') {
    const key = groupEl.dataset.key;
    const open = !repOpenGroups.has(key);
    if (open) repOpenGroups.add(key); else repOpenGroups.delete(key);
    groupEl.classList.toggle('open', open);
    groupEl.querySelector('.rep-subs')?.remove();
    if (open) {
      const items = repResults?.get(key) || repSections[si].groups[gi].lines.map((_, li) => ({ li, end: null }));
      groupEl.insertAdjacentHTML('beforeend', repSubsHtml(si, gi, items));
    }
    return;
  }
  const [, li, end] = act.split(':');
  $('rep-list').querySelectorAll('.rep-row.on').forEach((x) => x.classList.remove('on'));
  row.classList.add('on');
  repOpenKey = `${si}:${gi}:${li}`;
  openRepLine(si, gi, +li, end === '' ? null : +end);
});

// Enter opens the best result (or folds it out when it's several lines)
$('rep-q').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('rep-q').value) { e.stopPropagation(); $('rep-clear').click(); }
  if (e.key === 'Enter') $('rep-list').querySelector('.rep-group .rep-row')?.click();
});

// on the demo board from the start; a move search stops there (where the typed moves end) instead of playing on
function openRepLine(si, gi, li, end) {
  const sec = repSections[si], g = sec.groups[gi], ln = g.lines[li];
  const notes = ln.moves.map(() => '');
  if (ln.trap) {
    const t = ln.trap;
    notes[t.ply] = `Trap: this move loses${t.punish.length ? `, ${t.punish[0]} punishes it` : ''}.`;
  }
  if (PHONE.matches) setPhonePage('board');
  const name = ln.name || ln.eco || g.label;
  const branch = g.lines.length > 1 && ln.div ? ` ${ln.div}` : '';
  // a named line's name goes under the board, so the top row only adds which branch it is
  openDemo({ title: `${name}${branch}`, short: ln.name ? branch.trim() : `${g.label}${branch}`, fileName: ln.name,
    start_fen: START_FEN, moves: ln.moves, notes, explore: true, section: sec.title });
  if (end != null) demoStep(end + 1);
}

// ---- the page around the list


$('rep-q').oninput = () => { $('rep-clear').classList.toggle('hidden', !$('rep-q').value); renderRepertoire(); };
$('rep-clear').onclick = () => { $('rep-q').value = ''; $('rep-clear').classList.add('hidden'); renderRepertoire(); $('rep-q').focus(); };

// already here, the nav item brings the list forward (the phone's tab, the search box)
sectionNav('btn-repertoire', () => {
  if (PHONE.matches) setPhonePage('moves');
  if (!TOUCH) $('rep-q').focus({ preventScroll: true });
});

async function showList() {
  $('rep-list').innerHTML = '<div class="card-sub">Loading…</div>';
  try { await repLoad(); } catch (e) { return void ($('rep-list').textContent = e.message); }
  renderRepertoire();
  if (PHONE.matches) setPhonePage('moves');
  if (!TOUCH) $('rep-q').focus({ preventScroll: true });
}

Object.assign(hooks, {
  freshOnArrival: true,
  saveable: () => false,
  // a fresh analysis board, so the coach talks about what the lines put on it, not the board page's game
  blank: async (note) => {
    let review;
    try { review = await api('/api/analysis', {}); } catch (e) { return void ($('rep-list').textContent = e.message); }
    markBoardTaken();
    setReview(review, note);
  },
  idleInfo: () => { $('summary').innerHTML = ''; },  // for looking, not playing (user's call): no Play bot from here
  ready: () => showList(),
});
