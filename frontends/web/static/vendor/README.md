Local copies of the browser libraries so the app works without internet.

- chessground 9.2.1 (board UI, GPL-3.0) - https://github.com/lichess-org/chessground
  `chessground-9.2.1.js` is jsDelivr's ESM bundle; the two CSS files are from its `assets/`.
- chess.js 1.4.0 (move rules, BSD-2-Clause) - https://github.com/jhlywa/chess.js
  `chess-1.4.0.js` is jsDelivr's ESM bundle.

To upgrade, download the new versions the same way and update the paths in index.html / app.js.
- gioco piece set (sadsnake1, CC BY-NC-SA 4.0) - https://github.com/lichess-org/lila/tree/master/public/piece/gioco
  `chessground.gioco.css` embeds its 12 SVGs (user's pick 2026-10-21, a free look-alike of chess.com's Neo, which is
  chess.com's own artwork). `chessground.cburnett.css` (the old set) is kept for switching back in index.html.
