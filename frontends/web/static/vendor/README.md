Local copies of the browser libraries so the app works without internet.

- chessground 9.2.1 (board UI, GPL-3.0) - https://github.com/lichess-org/chessground
  `chessground-9.2.1.js` is jsDelivr's ESM bundle; the two CSS files are from its `assets/`.
- chess.js 1.4.0 (move rules, BSD-2-Clause) - https://github.com/jhlywa/chess.js
  `chess-1.4.0.js` is jsDelivr's ESM bundle.

To upgrade, download the new versions the same way and update the paths in index.html / app.js.
