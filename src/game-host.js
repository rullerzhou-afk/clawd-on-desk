'use strict';

// Game registry / dispatch loop. One game runs at a time; switching destroys
// the previous instance and starts a fresh one. Ported from vibe-arcade.

function createHost({ canvas, eventBus = null } = {}) {
  const registry = new Map();
  let game = null;

  function register(GameClass) {
    registry.set(GameClass.id, GameClass);
  }

  function switchTo(id) {
    if (!registry.has(id)) return;
    if (game) { try { game.destroy(); } catch { /* ignore */ } }
    const GameClass = registry.get(id);
    game = new GameClass(canvas, eventBus);
    game.start();
  }

  function cycleNext() {
    const ids = Array.from(registry.keys());
    if (ids.length === 0) return null;
    const cur = game ? game.constructor.id : null;
    const idx = cur ? ids.indexOf(cur) : -1;
    const next = ids[(idx + 1) % ids.length];
    switchTo(next);
    return next;
  }

  return {
    register,
    switchTo,
    cycleNext,
    pauseAll: () => { if (game) try { game.pause(); } catch {} },
    resumeAll: () => { if (game) try { game.resume(); } catch {} },
    forwardKey: (k, d) => { if (game) try { game.onKey(k, d); } catch {} },
    tick: (dt) => { if (game && !game.paused) try { game.tick(dt); game.render(); } catch {} },
    currentId: () => (game ? game.constructor.id : null),
    current: () => game,
    list: () => Array.from(registry.keys()),
  };
}

module.exports = { createHost };
