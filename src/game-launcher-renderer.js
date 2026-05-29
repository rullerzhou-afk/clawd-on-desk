'use strict';
// Renderer wiring for the game launcher panel. Loaded as an external script
// because the HTML's CSP (`script-src 'self'`) blocks inline <script> blocks
// — keeping it external lets us tighten CSP without losing the wiring.

const api = window.clawdLauncher;
if (api) {
  // Tell main when the cursor is actually over the launcher window so it
  // doesn't snap shut while the user is moving from pet → launcher.
  const root = document.getElementById('launcher');
  if (root) {
    root.addEventListener('mouseenter', () => api.setHover(true));
    root.addEventListener('mouseleave', () => api.setHover(false));
  }
  // Native window blur is also a "no longer hovered" signal — without it
  // a fast drag-out can leave hover stuck true and pin the launcher open.
  window.addEventListener('blur', () => api.setHover(false));

  for (const btn of document.querySelectorAll('button[data-game]')) {
    btn.addEventListener('click', () => {
      const game = btn.getAttribute('data-game');
      if (game) api.launch(game);
    });
  }

  api.onLang((payload) => {
    if (!payload || !payload.translations) return;
    const tr = payload.translations;
    const labelPlane = document.getElementById('label-plane');
    const labelSnake = document.getElementById('label-snake');
    if (labelPlane && tr.gameLauncherPlane) labelPlane.textContent = tr.gameLauncherPlane;
    if (labelSnake && tr.gameLauncherSnake) labelSnake.textContent = tr.gameLauncherSnake;
  });
}
