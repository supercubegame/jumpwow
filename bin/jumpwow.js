#!/usr/bin/env node
/* JUMPWOW 入口。
 *
 *   jumpwow                  终端里自己玩
 *   jumpwow --seed 42        指定地图
 *   jumpwow --bot            看机器人玩
 *   jumpwow --bench 60       无头跑 60 秒并打印统计，然后按退出码结束
 */

import { createGame, step, STEP } from '../src/engine.js';
import { botInput } from '../src/bot.js';
import * as R from '../src/render.js';

function parseArgs(argv){
  const a = { seed: (Date.now() ^ (Math.random() * 1e9)) >>> 0, bot: false, bench: 0 };
  for (let i = 0; i < argv.length; i++){
    const k = argv[i];
    if (k === '--seed')  a.seed  = parseInt(argv[++i], 10) >>> 0;
    else if (k === '--bot')   a.bot = true;
    else if (k === '--bench') a.bench = Number(argv[++i]) || 30;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.help){
  console.log(`
JUMPWOW — 无限向上跳跃

  jumpwow                自己玩（方向键或 A/D 移动，Q 退出）
  jumpwow --seed 42      指定地图种子
  jumpwow --bot          看机器人玩
  jumpwow --bench 60     无头跑 60 秒，打印统计并退出
`);
  process.exit(0);
}

/* ----------------------------- 无头 bench ----------------------------- */
if (args.bench){
  const s = createGame(args.seed);
  const ticks = Math.round(args.bench / STEP);
  const t0 = performance.now();
  for (let i = 0; i < ticks && s.alive; i++) step(s, botInput(s));
  const ms = performance.now() - t0;

  console.log(JSON.stringify({
    seed: s.seed,
    survived: s.alive,
    simSeconds: Math.round(s.time * 10) / 10,
    score: s.score,
    jumps: s.stats.jumps,
    springs: s.stats.springs,
    broken: s.stats.broken,
    platformsLive: s.platforms.length,
    platformsGenerated: s.generated,
    wallMs: Math.round(ms),
  }, null, 2));

  process.exit(s.alive ? 0 : 1);
}

/* ----------------------------- 交互 ----------------------------- */
const s = createGame(args.seed);
const input = { left: false, right: false };
let timer = null;

function quit(code){
  if (timer) clearInterval(timer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  R.showCursor();
  R.gameOver(s);
  process.exit(code);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', k => {
  if (k === 'q' || k === '\u0003') quit(0);
  if (k === 'a' || k === '\u001b[D') { input.left = true;  input.right = false; }
  if (k === 'd' || k === '\u001b[C') { input.right = true; input.left  = false; }
  if (k === 's' || k === ' ')        { input.left = false; input.right = false; }
});

R.hideCursor();
R.clear();

// 键盘没有 keyup，所以按一下持续移动一小段再自动停，手感上更像「点按转向」
let decay = 0;
timer = setInterval(() => {
  if (input.left || input.right){
    decay++;
    if (decay > 10){ input.left = input.right = false; decay = 0; }
  }
  step(s, args.bot ? botInput(s) : input);
  R.draw(s);
  if (!s.alive) quit(0);
}, STEP * 1000);
