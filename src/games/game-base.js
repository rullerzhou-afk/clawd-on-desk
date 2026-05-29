'use strict';

// Common interface for arcade mini-games shipped with Clawd.
// Ported from vibe-arcade (Snake / Plane Shooter) — kept as a CommonJS module
// so the BrowserWindow renderer can require() it without bundlers.

class GameBase {
  constructor(canvas, eventBus) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.eventBus = eventBus;
    this.score = 0;
    this.paused = false;
    this.gameOver = false;
  }
  static get id() { return 'base'; }
  static get name() { return 'BASE'; }
  static get controls() { return ''; }
  start() {}
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  destroy() {}
  tick(_dt) {}
  render() {}
  onKey(_key, _isDown) {}
  onAgentEvent(_event) {}
}

module.exports = { GameBase };
