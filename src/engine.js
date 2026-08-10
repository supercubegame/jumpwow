/* ===========================================================================
 * JUMPWOW 引擎
 * ===========================================================================
 *
 * 设计约束，改之前先读：
 *
 * 1. 这个文件是纯的。不读文件、不碰终端、不用 Date.now、不用 Math.random。
 *    所有随机来自种子。给同一个种子和同一串输入，必然得到同一个结果。
 *    可测试性完全建立在这条上面,一旦引入外部状态，闸门就失去意义。
 *
 * 2. 固定 60Hz 步进。逻辑永远按 STEP 推进，渲染帧率与它无关。
 *
 * 3. 世界是环形的：走出右边从左边出来。所以任何横向距离计算都必须走
 *    wrapDelta，不能直接相减。
 * =========================================================================== */

export const W        = 40;      // 世界宽度（环形）
export const VIEW_H   = 22;      // 视口高度，相机与死亡判定都基于它
export const STEP     = 1 / 60;

export const G        = 60;      // 重力
export const JUMP_V   = 26;      // 落地自动起跳的初速度
export const MOVE_V   = 19;      // 横向速度
export const SPRING_M = 1.62;    // 弹簧倍率

export const PLAT_W   = 6;
export const PLAYER_W = 1;

/** 最大跳跃高度。生成器的间距上限必须显著小于它，否则会造出死图。 */
export const MAX_JUMP_H = (JUMP_V * JUMP_V) / (2 * G);   // ≈ 5.63

export const PLAT = { NORMAL: 0, MOVING: 1, FRAGILE: 2, SPRING: 3 };

/* ----------------------------- 工具 ----------------------------- */

export function mulberry32(a){
  let t = a >>> 0;
  return function(){
    t = (t + 0x6D2B79F5) | 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp  = (a, b, t) => a + (b - a) * t;
export const wrap  = x => ((x % W) + W) % W;

/** 环形世界里从 a 到 b 的带符号最短横向位移，落在 [-W/2, W/2]。 */
export function wrapDelta(a, b){
  let d = b - a;
  if (d >  W / 2) d -= W;
  if (d < -W / 2) d += W;
  return d;
}

/** 难度随最高高度线性爬升，400 单位后打满。 */
export const difficultyAt = maxY => clamp(maxY / 400, 0, 1);

/**
 * 移动平台在任意时刻的横坐标。
 * 机器人靠它预判落点,瞄当前位置是不够的，等落下去平台早荡走了。
 */
export function platformXAt(pl, time){
  if (pl.type !== PLAT.MOVING) return pl.x;
  return wrap(pl.baseX + Math.sin(time * pl.speed + pl.phase) * pl.amp);
}

/* ----------------------------- 平台生成 ----------------------------- */

let _pid = 0;

function makePlatform(x, y, type, rnd){
  return {
    id: ++_pid,
    x, y, type,
    broken: false,
    // 移动平台绕生成点左右摆动
    baseX: x,
    amp:   type === PLAT.MOVING ? 3 + rnd() * 4 : 0,
    speed: type === PLAT.MOVING ? 1.1 + rnd() * 1.3 : 0,
    phase: type === PLAT.MOVING ? rnd() * Math.PI * 2 : 0,
  };
}

/**
 * 在最高平台之上再生成一块。
 *
 * 两个上限决定了这游戏能不能玩，别随便调大：
 *   垂直间距 ≤ 4.4，必须低于 MAX_JUMP_H(5.63)，否则跳不上去
 *   横向偏移 ≤ 9，玩家从起跳到落回该高度约有 0.6-0.7 秒，
 *                 按 MOVE_V 只能横移 11 出头，留了余量
 */
function growOne(s){
  // 兜底锚点：极端情况下平台可能被全部裁掉，这时从相机高度重新长起来。
  const last = s.platforms.length
    ? s.platforms[s.platforms.length - 1]
    : { x: W / 2, y: s.cam };

  const d   = difficultyAt(s.maxY);
  const rnd = s.rnd;

  const gap = lerp(2.6, 3.4, d) + rnd() * lerp(0.7, 1.0, d);
  const y   = last.y + gap;

  const spread = lerp(6, 9, d);
  const x = wrap(last.x + (rnd() * 2 - 1) * spread);

  let type = PLAT.NORMAL;
  if (s.generated >= 6) {                      // 开局前几块一律安全
    const r = rnd();
    const pFragile = lerp(0, 0.18, d);
    const pMoving  = lerp(0, 0.22, d);
    if (r < 0.07)                                   type = PLAT.SPRING;
    else if (r < 0.07 + pFragile && !s.lastFragile) type = PLAT.FRAGILE;
    else if (r < 0.07 + pFragile + pMoving)         type = PLAT.MOVING;
  }
  s.lastFragile = type === PLAT.FRAGILE;       // 不连着出易碎，太劝退

  s.platforms.push(makePlatform(x, y, type, rnd));
  s.generated++;
}

/** 保证相机上方始终有余量，并裁掉已经落在视野下方的平台。 */
function maintain(s){
  const top = s.cam + VIEW_H + 12;
  let guard = 0;
  while ((!s.platforms.length || s.platforms[s.platforms.length - 1].y < top) && guard++ < 4096){
    growOne(s);
  }

  const floor = s.cam - 6;
  let cut = 0;
  while (cut < s.platforms.length && s.platforms[cut].y < floor) cut++;
  if (cut > 0) s.platforms.splice(0, cut);
}

/* ----------------------------- 生命周期 ----------------------------- */

export function createGame(seed = 1){
  const s = {
    seed: seed >>> 0,
    rnd: mulberry32(seed >>> 0),
    platforms: [],
    generated: 0,
    lastFragile: false,
    player: { x: W / 2, y: 0, vx: 0, vy: JUMP_V },
    cam: -4,
    maxY: 0,
    score: 0,
    alive: true,
    ticks: 0,
    time: 0,
    stats: { jumps: 0, springs: 0, broken: 0, wraps: 0 },
  };

  // 起始平台固定在正中，保证任何种子都有落脚点
  s.platforms.push(makePlatform(W / 2, 0, PLAT.NORMAL, s.rnd));
  s.generated = 1;
  maintain(s);
  return s;
}

/**
 * 推进一个固定步。
 * @param {object} s     游戏状态，原地修改
 * @param {object} input { left:boolean, right:boolean }
 */
export function step(s, input){
  if (!s.alive) return s;

  const p  = s.player;
  const dt = STEP;

  s.ticks++;
  s.time += dt;

  /* --- 横向 --- */
  const dir = (input && input.right ? 1 : 0) - (input && input.left ? 1 : 0);
  p.vx = dir * MOVE_V;
  const nx = p.x + p.vx * dt;
  if (nx < 0 || nx >= W) s.stats.wraps++;
  p.x = wrap(nx);

  /* --- 移动平台。必须在碰撞之前更新，否则玩家会落在上一帧的位置 --- */
  for (const pl of s.platforms){
    if (pl.type !== PLAT.MOVING || pl.broken) continue;
    pl.x = platformXAt(pl, s.time);
  }

  /* --- 纵向。用「跨越检测」而不是「重叠检测」，高速下落不会穿板 --- */
  const prevY = p.y;
  p.vy -= G * dt;
  p.y  += p.vy * dt;

  if (p.vy < 0){
    let hit = null;
    for (const pl of s.platforms){
      if (pl.broken) continue;
      if (!(prevY >= pl.y && p.y <= pl.y)) continue;                 // 本步跨过了这个高度
      if (Math.abs(wrapDelta(p.x, pl.x)) > (PLAT_W + PLAYER_W) / 2) continue;
      // 同一步可能跨过多块，取最高的那块（最先接触）
      if (!hit || pl.y > hit.y) hit = pl;
    }
    if (hit){
      p.y  = hit.y;
      p.vy = JUMP_V * (hit.type === PLAT.SPRING ? SPRING_M : 1);
      s.stats.jumps++;
      if (hit.type === PLAT.SPRING) s.stats.springs++;
      if (hit.type === PLAT.FRAGILE){                                 // 先弹一下再碎，比直接掉下去公平
        hit.broken = true;
        s.stats.broken++;
      }
    }
  }

  /* --- 相机只升不降 --- */
  if (p.y > s.maxY) s.maxY = p.y;
  s.score = Math.floor(s.maxY);
  const want = p.y - VIEW_H * 0.55;
  if (want > s.cam) s.cam = want;

  if (p.y < s.cam) s.alive = false;

  maintain(s);
  return s;
}

/** 跑 n 步，input 可以是对象或 (state)=>input 的函数。 */
export function run(s, ticks, input){
  const f = typeof input === 'function' ? input : () => input || {};
  for (let i = 0; i < ticks && s.alive; i++) step(s, f(s));
  return s;
}

/** 用于确定性断言的状态指纹。只取会影响玩法的量。 */
export function fingerprint(s){
  const r = v => Math.round(v * 1000) / 1000;
  return [
    s.ticks, s.alive ? 1 : 0, s.score,
    r(s.player.x), r(s.player.y), r(s.player.vy), r(s.cam),
    s.platforms.length, s.generated,
    s.stats.jumps, s.stats.springs, s.stats.broken,
    s.platforms.map(p => `${p.type}:${r(p.x)}:${r(p.y)}:${p.broken ? 1 : 0}`).join(','),
  ].join('|');
}
