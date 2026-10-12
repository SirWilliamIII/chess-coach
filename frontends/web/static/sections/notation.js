// Moves as numbered notation, for the section panels that show a line (a lesson's Drill run, Explore lines' open
// line): "1. e4 c5 2. Nf3", a Black move numbered only where the line starts ("6... e5").

import { Chess } from '../vendor/chess-1.4.0.js';
import { esc } from '../app.js';

document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/static/sections/notation.css">');

// "6." before every White move, "6..." before a Black one only when `force` (a line's first move, after a branch)
export function moveNum(fen, force) {
  const [, turn, , , , n] = fen.split(' ');
  return turn === 'w' ? `<span class="ln-num">${n}.</span>` : force ? `<span class="ln-num">${n}...</span>` : '';
}

// `sans` from `startFen` as buttons (data-i = the move's index); `on` = the index to highlight, moves from `offFrom`
// on are marked as off the line
export function lineHtml(sans, startFen, { on = -1, offFrom = Infinity } = {}) {
  const c = new Chess(startFen);
  return sans.map((san, i) => {
    const num = moveNum(c.fen(), i === 0);
    try { c.move(san); } catch { return ''; }
    return `${num}<button class="ln-mv reach${i === on ? ' on' : ''}${i >= offFrom ? ' off' : ''}" data-i="${i}">${esc(san)}</button> `;
  }).join('');
}
