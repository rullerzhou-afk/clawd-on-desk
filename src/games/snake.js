'use strict';
// Snake — ported from vibe-arcade (~/Downloads/vibe-arcade/src/games/snake.js).
// Same gameplay: arrow keys / WASD; red dots = +1; orange beans = +2 (5s
// timer); blue rival snakes spawn after 10s and chase food; biting walls /
// other snakes / yourself ends the game.
const { GameBase } = require('./game-base.js');

const GRID_W = 30;
const GRID_H = 18;
const TICK_MS = 150;
const TOOL_BEAN_TTL_MS = 5000;

function inBody(snake, x, y, skipHead = false) {
  for (let i = skipHead ? 1 : 0; i < snake.length; i++) {
    if (snake[i].x === x && snake[i].y === y) return true;
  }
  return false;
}

function randEmptyCell(state) {
  const taken = new Set();
  for (const s of state.snake) taken.add(`${s.x},${s.y}`);
  for (const f of state.foods) taken.add(`${f.x},${f.y}`);
  for (const b of state.toolBeans) taken.add(`${b.x},${b.y}`);
  for (let i = 0; i < 200; i++) {
    const x = Math.floor(Math.random() * state.grid.w);
    const y = Math.floor(Math.random() * state.grid.h);
    if (!taken.has(`${x},${y}`)) return { x, y };
  }
  for (let y = 0; y < state.grid.h; y++) {
    for (let x = 0; x < state.grid.w; x++) {
      if (!taken.has(`${x},${y}`)) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

function _spawnFood(state) {
  state.foods.push(randEmptyCell(state));
}

function _step(state, _now) {
  if (state.gameOver) return;
  const head = state.snake[0];
  const next = { x: head.x + state.dir.x, y: head.y + state.dir.y };
  if (next.x < 0 || next.y < 0 || next.x >= state.grid.w || next.y >= state.grid.h) {
    state.gameOver = true; return;
  }
  if (inBody(state.snake, next.x, next.y, false)) {
    state.gameOver = true; return;
  }
  state.snake.unshift(next);
  // Tool beans take priority over normal food when overlapping.
  const ti = state.toolBeans.findIndex(b => b.x === next.x && b.y === next.y);
  if (ti >= 0) {
    state.score += 2;
    state.toolBeans.splice(ti, 1);
    return;
  }
  const fi = state.foods.findIndex(f => f.x === next.x && f.y === next.y);
  if (fi >= 0) {
    state.score += 1;
    state.foods.splice(fi, 1);
    _spawnFood(state);
    return;
  }
  state.snake.pop();
}

function pruneExpiredBeans(state, now) {
  state.toolBeans = state.toolBeans.filter(b => b.expiresAt > now);
}

const BOT_SPAWN_INTERVAL_MS = 12000;
const BOT_SPAWN_GRACE_MS = 10000;
const BOT_MAX_ALIVE = 2;
const BOT_INITIAL_LENGTH = 3;
const DIRS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function _isBlocked(state, x, y) {
  if (x < 0 || y < 0 || x >= state.grid.w || y >= state.grid.h) return true;
  for (const s of state.snake) if (s.x === x && s.y === y) return true;
  for (const bot of state.bots) {
    if (!bot.alive) continue;
    for (const seg of bot.body) if (seg.x === x && seg.y === y) return true;
  }
  return false;
}

function _chooseBotDir(bot, state) {
  const head = bot.body[0];
  let nearest = null;
  let bestDist = Infinity;
  for (const f of state.foods) {
    const d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
    if (d < bestDist) { bestDist = d; nearest = f; }
  }
  const candidates = [];
  for (const d of DIRS) {
    if (d.x === -bot.dir.x && d.y === -bot.dir.y) continue;
    const nx = head.x + d.x;
    const ny = head.y + d.y;
    if (_isBlocked(state, nx, ny)) continue;
    const dist = nearest ? Math.abs(nearest.x - nx) + Math.abs(nearest.y - ny) : 0;
    candidates.push({ dir: d, dist });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  const minDist = candidates[0].dist;
  const ties = candidates.filter(c => c.dist === minDist);
  const rand = state._rand || Math.random;
  return ties[Math.floor(rand() * ties.length)].dir;
}

function _spawnBot(state) {
  const aliveCount = state.bots.filter(b => b.alive).length;
  if (aliveCount >= BOT_MAX_ALIVE) return false;
  const rand = state._rand || Math.random;
  const taken = new Set();
  for (const s of state.snake) taken.add(`${s.x},${s.y}`);
  for (const f of state.foods) taken.add(`${f.x},${f.y}`);
  for (const tb of state.toolBeans) taken.add(`${tb.x},${tb.y}`);
  for (const bot of state.bots) {
    if (!bot.alive) continue;
    for (const seg of bot.body) taken.add(`${seg.x},${seg.y}`);
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const horiz = rand() < 0.5;
    const forward = rand() < 0.5;
    const dir = horiz
      ? { x: forward ? 1 : -1, y: 0 }
      : { x: 0, y: forward ? 1 : -1 };
    const minX = horiz ? (forward ? 0 : BOT_INITIAL_LENGTH - 1) : 0;
    const maxX = horiz ? (forward ? state.grid.w - BOT_INITIAL_LENGTH : state.grid.w - 1) : state.grid.w - 1;
    const minY = horiz ? 0 : (forward ? 0 : BOT_INITIAL_LENGTH - 1);
    const maxY = horiz ? state.grid.h - 1 : (forward ? state.grid.h - BOT_INITIAL_LENGTH : state.grid.h - 1);
    if (maxX < minX || maxY < minY) continue;
    const hx = minX + Math.floor(rand() * (maxX - minX + 1));
    const hy = minY + Math.floor(rand() * (maxY - minY + 1));
    const body = [];
    let ok = true;
    for (let i = 0; i < BOT_INITIAL_LENGTH; i++) {
      const x = hx - dir.x * i;
      const y = hy - dir.y * i;
      if (x < 0 || y < 0 || x >= state.grid.w || y >= state.grid.h || taken.has(`${x},${y}`)) {
        ok = false; break;
      }
      body.push({ x, y });
    }
    if (!ok) continue;
    state.bots.push({ body, dir, alive: true });
    return true;
  }
  return false;
}

function _dropBotFood(state, bot) {
  const wanted = Math.floor(bot.body.length / 2);
  const taken = new Set();
  for (const s of state.snake) taken.add(`${s.x},${s.y}`);
  for (const f of state.foods) taken.add(`${f.x},${f.y}`);
  for (const tb of state.toolBeans) taken.add(`${tb.x},${tb.y}`);
  for (const other of state.bots) {
    if (other === bot || !other.alive) continue;
    for (const seg of other.body) taken.add(`${seg.x},${seg.y}`);
  }
  let dropped = 0;
  for (const seg of bot.body) {
    if (dropped >= wanted) break;
    const key = `${seg.x},${seg.y}`;
    if (taken.has(key)) continue;
    state.foods.push({ x: seg.x, y: seg.y });
    taken.add(key);
    dropped++;
  }
}

function _stepBots(state) {
  for (const bot of state.bots) {
    if (!bot.alive) continue;
    const dir = _chooseBotDir(bot, state);
    if (!dir) { bot.alive = false; continue; }
    const head = bot.body[0];
    const next = { x: head.x + dir.x, y: head.y + dir.y };
    bot.dir = dir;
    bot.body.unshift(next);
    const fi = state.foods.findIndex(f => f.x === next.x && f.y === next.y);
    if (fi >= 0) {
      state.foods.splice(fi, 1);
      _spawnFood(state);
      continue;
    }
    const ti = state.toolBeans.findIndex(b => b.x === next.x && b.y === next.y);
    if (ti >= 0) {
      state.toolBeans.splice(ti, 1);
      continue;
    }
    bot.body.pop();
  }
}

class Snake extends GameBase {
  static get id() { return 'snake'; }
  static get name() { return 'SNAKE'; }
  static get controls() { return 'arrow keys or WASD to move'; }

  constructor(canvas, eventBus) {
    super(canvas, eventBus);
    this.lastStepAt = 0;
    this.state = null;
  }

  start() {
    this.paused = false;
    this.gameOver = false;
    this.score = 0;
    this.lastStepAt = 0;
    this.state = {
      grid: { w: GRID_W, h: GRID_H },
      snake: [{ x: 8, y: 9 }, { x: 7, y: 9 }, { x: 6, y: 9 }],
      dir: { x: 1, y: 0 },
      pendingDir: null,
      foods: [],
      toolBeans: [],
      bots: [],
      gameStartedAt: null,
      lastBotSpawnAt: 0,
      score: 0,
      gameOver: false,
    };
    _spawnFood(this.state);
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  destroy() { this.state = null; }

  onKey(key, isDown) {
    if (!isDown) return;
    if (key === ' ' && (this.state?.gameOver || this.gameOver)) { this.start(); return; }
    const map = {
      ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 }, S: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 }, D: { x: 1, y: 0 },
    };
    const nd = map[key];
    if (!nd || !this.state) return;
    if (nd.x === -this.state.dir.x && nd.y === -this.state.dir.y) return;
    this.state.dir = nd;
  }

  tick(dt, nowOverride) {
    const now = nowOverride ?? Date.now();
    if (!this.state) return;
    pruneExpiredBeans(this.state, now);
    if (this.paused || this.state.gameOver) {
      this.gameOver = this.state.gameOver;
      this.score = this.state.score;
      return;
    }
    if (this.state.gameStartedAt == null) {
      this.state.gameStartedAt = now;
      this.state.lastBotSpawnAt = now;
    }
    if (now - this.state.gameStartedAt >= BOT_SPAWN_GRACE_MS &&
        now - this.state.lastBotSpawnAt >= BOT_SPAWN_INTERVAL_MS) {
      _spawnBot(this.state);
      this.state.lastBotSpawnAt = now;
    }
    this.lastStepAt += dt;
    while (this.lastStepAt >= TICK_MS) {
      _step(this.state, now);
      this.lastStepAt -= TICK_MS;
      if (this.state.gameOver) break;
      _stepBots(this.state);
      const head = this.state.snake[0];
      for (const bot of this.state.bots) {
        if (!bot.alive) continue;
        if (bot.body.some(s => s.x === head.x && s.y === head.y)) {
          this.state.gameOver = true;
          break;
        }
      }
      if (this.state.gameOver) break;
      for (const bot of this.state.bots) {
        if (!bot.alive) _dropBotFood(this.state, bot);
      }
      this.state.bots = this.state.bots.filter(b => b.alive);
    }
    this.gameOver = this.state.gameOver;
    this.score = this.state.score;
  }

  render() {
    if (!this.ctx || !this.state) return;
    const ctx = this.ctx;
    const cellW = this.canvas.width / this.state.grid.w;
    const cellH = this.canvas.height / this.state.grid.h;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.strokeStyle = '#003322';
    ctx.lineWidth = 1;
    for (let x = 0; x <= this.state.grid.w; x++) {
      ctx.beginPath(); ctx.moveTo(x * cellW, 0); ctx.lineTo(x * cellW, this.canvas.height); ctx.stroke();
    }
    for (let y = 0; y <= this.state.grid.h; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * cellH); ctx.lineTo(this.canvas.width, y * cellH); ctx.stroke();
    }
    ctx.fillStyle = '#FF4444';
    for (const f of this.state.foods) ctx.fillRect(f.x * cellW + 2, f.y * cellH + 2, cellW - 4, cellH - 4);
    ctx.fillStyle = '#FFA500';
    for (const b of this.state.toolBeans) ctx.fillRect(b.x * cellW + 2, b.y * cellH + 2, cellW - 4, cellH - 4);
    ctx.fillStyle = '#3FA9F5';
    for (const bot of this.state.bots) {
      for (const s of bot.body) ctx.fillRect(s.x * cellW + 1, s.y * cellH + 1, cellW - 2, cellH - 2);
    }
    ctx.fillStyle = '#00FF7F';
    for (const s of this.state.snake) ctx.fillRect(s.x * cellW + 1, s.y * cellH + 1, cellW - 2, cellH - 2);
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

module.exports = { Snake };
