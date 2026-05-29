'use strict';
// Plane Shooter — ported from vibe-arcade
// (~/Downloads/vibe-arcade/src/games/plane.js). WASD/arrows to move, space
// to fire. Red enemies fall from the top; purple specials always drop a
// fire-rate or shot-pattern power-up.
const { GameBase } = require('./game-base.js');

const WORLD = { w: 640, h: 320 };
// Bumped from upstream's 4 — the smaller arcade window scales the canvas
// down by CSS, which can make movement feel sluggish if the underlying
// world speed is the upstream default. 8 keeps dodging snappy without
// feeling like the player teleports.
const PLAYER = { w: 24, h: 24, speed: 8 };
const BULLET = { w: 4, h: 10, vy: -6, cooldownMs: 140 };
const ENEMY = {
  w: 22,
  h: 22,
  vy: 1.5,
  spawnIntervalMs: 900,
  capNormal: 14,
  specialSpawnIntervalMs: 8000,
};
const BOX = { w: 18, h: 18, vy: 1.0 };
const FIRE_LV_MAX = 4;
const SHOT_LV_MAX = 4;
const NORMAL_DROP_CHANCE = 0.10;

function _bulletCooldownMs(fireLv) {
  return Math.round(BULLET.cooldownMs * Math.pow(0.8, fireLv));
}

function _makeBullets(player, shotLv) {
  const cx = player.x + player.w / 2 - BULLET.w / 2;
  const y = player.y;
  const vy = BULLET.vy;
  const angled = (angleRad, xOffset = 0) => ({
    x: cx + xOffset,
    y,
    vx: -vy * Math.sin(angleRad),
    vy: -Math.abs(vy) * Math.cos(angleRad),
  });
  switch (shotLv) {
    case 0:
      return [{ x: cx, y, vy }];
    case 1:
      return [{ x: cx - 6, y, vy }, { x: cx + 6, y, vy }];
    case 2:
      return [
        { x: cx, y, vy },
        angled(-0.20),
        angled(0.20),
      ];
    case 3: {
      const fast = { x: cx, y, vy: vy * 1.4 };
      return [fast, angled(-0.20), angled(0.20)];
    }
    case 4:
      return [
        { x: cx, y, vy },
        angled(-0.15),
        angled(0.15),
        angled(-0.30),
        angled(0.30),
      ];
    default:
      return [{ x: cx, y, vy }];
  }
}

function _stepBullets(state) {
  for (const b of state.bullets) {
    b.y += b.vy;
    if (b.vx) b.x += b.vx;
  }
  state.bullets = state.bullets.filter(b =>
    b.y > 0 && b.y < state.world.h && b.x >= 0 && b.x <= state.world.w
  );
}

function _stepEnemies(state) {
  for (const e of state.enemies) e.y += ENEMY.vy;
  state.enemies = state.enemies.filter(e => e.y < state.world.h + 30);
}

function _stepBoxes(state) {
  for (const b of state.boxes) b.y += b.vy;
  state.boxes = state.boxes.filter(b => b.y < state.world.h);
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function _pickupBoxes(state) {
  const p = state.player;
  for (let i = state.boxes.length - 1; i >= 0; i--) {
    const b = state.boxes[i];
    if (rectsOverlap(p, b)) {
      if (b.kind === 'fire') state.fireLv = Math.min(FIRE_LV_MAX, state.fireLv + 1);
      else if (b.kind === 'shot') state.shotLv = Math.min(SHOT_LV_MAX, state.shotLv + 1);
      state.score += 5;
      state.boxes.splice(i, 1);
    }
  }
}

function _spawnEnemy(state, kind) {
  const x = Math.floor(Math.random() * (state.world.w - ENEMY.w));
  state.enemies.push({ x, y: -ENEMY.h, w: ENEMY.w, h: ENEMY.h, kind });
}

function _detectCollisions(state) {
  const rand = state._rand || Math.random;
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    const br = { x: b.x, y: b.y, w: BULLET.w, h: BULLET.h };
    for (let j = state.enemies.length - 1; j >= 0; j--) {
      const e = state.enemies[j];
      if (rectsOverlap(br, { x: e.x, y: e.y, w: e.w, h: e.h })) {
        state.score += e.kind === 'special' ? 25 : 10;
        const guaranteed = e.kind === 'special';
        const shouldDrop = guaranteed || rand() < NORMAL_DROP_CHANCE;
        if (shouldDrop && state.boxes) {
          const kind = rand() < 0.5 ? 'fire' : 'shot';
          state.boxes.push({
            x: e.x + e.w / 2 - BOX.w / 2,
            y: e.y,
            w: BOX.w,
            h: BOX.h,
            vy: BOX.vy,
            kind,
          });
        }
        state.enemies.splice(j, 1);
        state.bullets.splice(i, 1);
        break;
      }
    }
  }
  for (const e of state.enemies) {
    if (rectsOverlap(state.player, { x: e.x, y: e.y, w: e.w, h: e.h })) {
      state.gameOver = true;
      return;
    }
  }
}

class Plane extends GameBase {
  static get id() { return 'plane'; }
  static get name() { return 'PLANE'; }
  static get controls() { return 'WASD/arrows move · space to fire'; }

  constructor(canvas, eventBus) {
    super(canvas, eventBus);
    this.state = null;
    this.input = { left: false, right: false, up: false, down: false, fire: false };
    this.lastFireAt = 0;
    this.lastSpawnAt = 0;
    this.lastSpecialSpawnAt = 0;
    this.fireLv = 0;
    this.shotLv = 0;
  }

  start() {
    this.paused = false;
    this.gameOver = false;
    this.score = 0;
    this.lastFireAt = 0;
    this.lastSpawnAt = 0;
    this.lastSpecialSpawnAt = 0;
    this.fireLv = 0;
    this.shotLv = 0;
    this.input = { left: false, right: false, up: false, down: false, fire: false };
    this.state = {
      world: { w: WORLD.w, h: WORLD.h },
      player: {
        x: WORLD.w / 2 - PLAYER.w / 2,
        y: WORLD.h - PLAYER.h - 12,
        w: PLAYER.w,
        h: PLAYER.h,
      },
      bullets: [],
      enemies: [],
      boxes: [],
      fireLv: 0,
      shotLv: 0,
      score: 0,
      gameOver: false,
    };
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  destroy() { this.state = null; }

  onKey(key, isDown) {
    if (!this.state) return;
    if (key === ' ' && isDown && (this.state.gameOver || this.gameOver)) { this.start(); return; }
    const map = {
      ArrowLeft: 'left', a: 'left', A: 'left',
      ArrowRight: 'right', d: 'right', D: 'right',
      ArrowUp: 'up', w: 'up', W: 'up',
      ArrowDown: 'down', s: 'down', S: 'down',
      ' ': 'fire',
    };
    const slot = map[key];
    if (!slot) return;
    this.input[slot] = !!isDown;
  }

  tick(dt, nowOverride) {
    const now = nowOverride ?? Date.now();
    if (!this.state) return;
    if (this.paused || this.state.gameOver) {
      this.gameOver = this.state.gameOver;
      this.score = this.state.score;
      return;
    }
    const p = this.state.player;
    if (this.input.left)  p.x = Math.max(0, p.x - PLAYER.speed);
    if (this.input.right) p.x = Math.min(this.state.world.w - p.w, p.x + PLAYER.speed);
    if (this.input.up)    p.y = Math.max(0, p.y - PLAYER.speed);
    if (this.input.down)  p.y = Math.min(this.state.world.h - p.h, p.y + PLAYER.speed);
    const cooldown = _bulletCooldownMs(this.state.fireLv);
    if (this.input.fire && now - this.lastFireAt >= cooldown) {
      const bullets = _makeBullets(p, this.state.shotLv);
      for (const b of bullets) this.state.bullets.push(b);
      this.lastFireAt = now;
    }
    if (now - this.lastSpawnAt >= ENEMY.spawnIntervalMs && this.state.enemies.length < ENEMY.capNormal) {
      _spawnEnemy(this.state, 'normal');
      this.lastSpawnAt = now;
    }
    if (now - this.lastSpecialSpawnAt >= ENEMY.specialSpawnIntervalMs && this.state.enemies.length < ENEMY.capNormal) {
      _spawnEnemy(this.state, 'special');
      this.lastSpecialSpawnAt = now;
    }
    _stepBullets(this.state);
    _stepEnemies(this.state);
    _stepBoxes(this.state);
    _detectCollisions(this.state);
    _pickupBoxes(this.state);
    this.gameOver = this.state.gameOver;
    this.score = this.state.score;
    this.fireLv = this.state.fireLv;
    this.shotLv = this.state.shotLv;
  }

  render() {
    if (!this.ctx || !this.state) return;
    const ctx = this.ctx;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.strokeStyle = '#003322';
    ctx.lineWidth = 1;
    const step = 20;
    for (let x = 0; x < this.canvas.width; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.canvas.height); ctx.stroke();
    }
    for (let y = 0; y < this.canvas.height; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.canvas.width, y); ctx.stroke();
    }
    ctx.fillStyle = '#00FF7F';
    const p = this.state.player;
    ctx.beginPath();
    ctx.moveTo(p.x + p.w / 2, p.y);
    ctx.lineTo(p.x, p.y + p.h);
    ctx.lineTo(p.x + p.w, p.y + p.h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#FFFF66';
    for (const b of this.state.bullets) ctx.fillRect(b.x, b.y, 4, 10);
    for (const e of this.state.enemies) {
      ctx.fillStyle = e.kind === 'special' ? '#B266FF' : '#FF4444';
      ctx.fillRect(e.x, e.y, e.w, e.h);
    }
    for (const box of this.state.boxes) {
      ctx.fillStyle = box.kind === 'fire' ? '#FFD23F' : '#3FD9FF';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(box.x + 4, box.y + 4, box.w - 8, box.h - 8);
      ctx.fillStyle = box.kind === 'fire' ? '#FFD23F' : '#3FD9FF';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(box.kind === 'fire' ? 'F' : 'S', box.x + 6, box.y + 13);
    }
    ctx.fillStyle = '#00FF7F';
    ctx.font = '14px monospace';
    ctx.fillText(`Score: ${this.state.score}`, 10, 18);
    if (this.state.gameOver) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = '#FF4444';
      ctx.font = 'bold 28px monospace';
      ctx.fillText('GAME OVER', this.canvas.width / 2 - 90, this.canvas.height / 2);
      ctx.fillStyle = '#00FF7F';
      ctx.font = '14px monospace';
      ctx.fillText('Press SPACE to restart', this.canvas.width / 2 - 100, this.canvas.height / 2 + 24);
    }
  }
}

module.exports = { Plane };
