'use strict';
// Renderer for a single Clawd Arcade game window. The game id is passed
// through the URL hash (`arcade.html#snake` or `arcade.html#plane`) by
// arcade.js. There is no Tab key cycling — each window owns one game.

const { Snake } = require('./games/snake.js');
const { Plane } = require('./games/plane.js');
const { createHost } = require('./game-host.js');

const ICONS = { snake: '🐍', plane: '✈' };
const GAMES = { snake: Snake, plane: Plane };

function resolveGameId() {
  const raw = (window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
  if (GAMES[raw]) return raw;
  return 'snake';
}

const gameId = resolveGameId();
const Game = GAMES[gameId];

const canvas = document.getElementById('stage');
const host = createHost({ canvas });
host.register(Game);
host.switchTo(gameId);

function setText(id, text) {
  const el = document.getElementById(id);
  if (el && text != null) el.textContent = text;
}

function refreshHud() {
  const game = host.current();
  const score = game ? (game.score || 0) : 0;
  let status;
  if (game && game.gameOver) {
    status = 'GAME OVER — press SPACE';
  } else if (gameId === 'plane' && game) {
    status = `Score: ${score} · F:Lv${game.fireLv ?? 0} S:Lv${game.shotLv ?? 0}`;
  } else {
    status = `Score: ${score}`;
  }
  setText('title', Game.name);
  setText('game-icon', ICONS[gameId] || '▣');
  setText('status', status);
  setText('hint', Game.controls);
}

document.title = `Clawd Arcade — ${Game.name}`;
refreshHud();

let last = performance.now();
function loop(now) {
  const dt = now - last; last = now;
  host.tick(dt);
  refreshHud();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.addEventListener('keydown', (e) => {
  // Space and the arrow keys would otherwise scroll the document.
  if (e.key === ' ' || (typeof e.key === 'string' && e.key.startsWith('Arrow'))) {
    e.preventDefault();
  }
  if (e.key === 'Escape') {
    window.close();
    return;
  }
  host.forwardKey(e.key, true);
});
window.addEventListener('keyup', (e) => host.forwardKey(e.key, false));

const closeBtn = document.getElementById('close');
if (closeBtn) {
  closeBtn.addEventListener('click', () => window.close());
}

// Make sure the window receives keystrokes immediately after open / refocus.
window.addEventListener('load', () => window.focus());
canvas.addEventListener('click', () => window.focus());

// Pause the running game when the window loses focus or is hidden, resume
// when it comes back. This stops timers from running while the user is in
// another window.
window.addEventListener('blur', () => host.pauseAll());
window.addEventListener('focus', () => host.resumeAll());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) host.pauseAll();
  else host.resumeAll();
});
