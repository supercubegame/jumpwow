/* ===========================================================================
 * 输入日志与重放
 * ===========================================================================
 *
 * 排行榜的反作弊完全建立在一件事上：引擎是纯函数且种子化确定性。
 *
 * 所以客户端不需要（也不允许）上报分数,它上报「种子 + 每一帧按了什么」，
 * 服务端拿同一份引擎重放一遍，以重放结果为准。改日志里任何一个字节，
 * 重放出来的分数就对不上，伪造成本等于「真的把游戏玩到那个分数」。
 *
 * 这个文件必须和 engine.js 一样保持纯净：不读文件、不碰网络、不用系统时间。
 * =========================================================================== */

import { createGame, step } from './engine.js';

/** 输入状态。左右同时按等于没按（方向相消），所以只需要三态。 */
export const IN = { NONE: 0, LEFT: 1, RIGHT: 2 };

/** 单条日志允许的最大帧数。60Hz 下约 27 分钟,防止有人上传一个巨大的日志。 */
export const MAX_TICKS = 100000;

/** 编码后字符串的长度上限。 */
export const MAX_LOG_CHARS = 20000;

export function stateOf(input){
  const l = !!(input && input.left), r = !!(input && input.right);
  if (l === r) return IN.NONE;
  return l ? IN.LEFT : IN.RIGHT;
}

export function inputOf(state){
  return { left: state === IN.LEFT, right: state === IN.RIGHT };
}

/**
 * 把逐帧状态数组压成字符串。
 * 游程编码：每段写成「状态 + 长度的 36 进制」，段之间用点分隔。
 * 实测一局 60 秒的日志通常只有几百字节。
 *
 *   [0,0,0,2,2] → "03.22"
 */
export function encodeLog(states){
  if (!states.length) return '';
  const out = [];
  let cur = states[0], n = 1;
  for (let i = 1; i < states.length; i++){
    if (states[i] === cur){ n++; continue; }
    out.push(String(cur) + n.toString(36));
    cur = states[i]; n = 1;
  }
  out.push(String(cur) + n.toString(36));
  return out.join('.');
}

/**
 * 解码。任何格式问题都抛错,服务端靠这个挡掉畸形输入。
 * @returns {number[]} 逐帧状态
 */
export function decodeLog(str){
  if (typeof str !== 'string') throw new Error('日志不是字符串');
  if (str.length > MAX_LOG_CHARS) throw new Error('日志过长');
  if (!str) return [];

  const out = [];
  for (const seg of str.split('.')){
    if (seg.length < 2) throw new Error('日志段格式错误: ' + seg);
    const s = seg.charCodeAt(0) - 48;
    if (s !== IN.NONE && s !== IN.LEFT && s !== IN.RIGHT) throw new Error('未知输入状态: ' + s);
    const n = parseInt(seg.slice(1), 36);
    if (!Number.isFinite(n) || n <= 0) throw new Error('日志段长度非法: ' + seg);
    if (out.length + n > MAX_TICKS) throw new Error('日志超过最大帧数');
    for (let i = 0; i < n; i++) out.push(s);
  }
  return out;
}

/** 边玩边记。把它挂在游戏循环里，每调用一次 step 就记一帧。 */
export function createRecorder(){
  const states = [];
  return {
    push(input){ states.push(stateOf(input)); },
    get ticks(){ return states.length; },
    encode(){ return encodeLog(states); },
    reset(){ states.length = 0; },
  };
}

/**
 * 重放一局，返回权威结果。
 *
 * 服务端只信这个函数的输出,客户端说自己得了多少分完全不作数。
 *
 * @param {number} seed
 * @param {string|number[]} log 编码后的字符串，或已解码的状态数组
 */
export function replay(seed, log){
  const states = typeof log === 'string' ? decodeLog(log) : log;
  if (states.length > MAX_TICKS) throw new Error('日志超过最大帧数');

  const s = createGame(seed);
  for (let i = 0; i < states.length && s.alive; i++){
    step(s, inputOf(states[i]));
  }

  return {
    seed: s.seed,
    score: s.score,
    ticks: s.ticks,
    jumps: s.stats.jumps,
    springs: s.stats.springs,
    broken: s.stats.broken,
    alive: s.alive,
    seconds: Math.round(s.time * 10) / 10,
  };
}
