/* 终端渲染。只在交互模式下用，引擎和闸门都不依赖它。 */

import { W, VIEW_H, PLAT_W, PLAT } from './engine.js';

const ESC   = '\u001b[';
const RESET = ESC + '0m';
const c = (n, t) => ESC + n + 'm' + t + RESET;

const SKIN = {
  [PLAT.NORMAL]:  { ch: '=', color: '38;5;114' },
  [PLAT.MOVING]:  { ch: '~', color: '38;5;117' },
  [PLAT.FRAGILE]: { ch: '-', color: '38;5;180' },
  [PLAT.SPRING]:  { ch: '^', color: '38;5;213' },
};

export function hideCursor(){ process.stdout.write(ESC + '?25l'); }
export function showCursor(){ process.stdout.write(ESC + '?25h'); }
export function clear(){ process.stdout.write(ESC + '2J' + ESC + 'H'); }

export function draw(s){
  const grid = Array.from({ length: VIEW_H }, () => new Array(W).fill(' '));
  const rowOf = y => VIEW_H - 1 - Math.round(y - s.cam);

  for (const pl of s.platforms){
    if (pl.broken) continue;
    const r = rowOf(pl.y);
    if (r < 0 || r >= VIEW_H) continue;
    const skin = SKIN[pl.type];
    const left = Math.round(pl.x - PLAT_W / 2);
    for (let i = 0; i < PLAT_W; i++){
      grid[r][((left + i) % W + W) % W] = c(skin.color, skin.ch);
    }
  }

  const pr = rowOf(s.player.y);
  const pc = Math.round(s.player.x) % W;
  if (pr >= 0 && pr < VIEW_H){
    grid[pr][pc] = c('1;38;5;226', s.player.vy > 0 ? 'A' : 'W');
  }

  const bar  = '+' + '-'.repeat(W) + '+';
  const body = grid.map(row => '|' + row.join('') + '|').join('\n');
  const hud  = ` 高度 ${String(s.score).padStart(5)}   跳跃 ${String(s.stats.jumps).padStart(4)}` +
               `   弹簧 ${s.stats.springs}   踩碎 ${s.stats.broken}`;

  process.stdout.write(ESC + 'H' + bar + '\n' + body + '\n' + bar + '\n' + c('2', hud) + '\n');
}

export function gameOver(s){
  const box = [
    '',
    c('1;38;5;203', '  掉下去了。'),
    `  最终高度 ${c('1;38;5;226', s.score)}   跳了 ${s.stats.jumps} 次   种子 ${s.seed}`,
    c('2', '  同一个种子会得到同一张图：jumpwow --seed ' + s.seed),
    '',
  ].join('\n');
  process.stdout.write(box + '\n');
}
