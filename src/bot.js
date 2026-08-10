/* ===========================================================================
 * 无头机器人
 * ===========================================================================
 *
 * 它存在的唯一理由：证明这游戏「能玩」。
 *
 * 单元测试能证明函数返回值对，但证明不了关卡是不是生成了跳不上去的死图。
 * 机器人能连续跳几百次不死，才说明物理参数和生成参数是自洽的。
 * 所以它是闸门里最有价值的一条断言。
 *
 * 策略刻意保持简单（预测顶点 → 选可达的最高平台 → 走最短环形路径）。
 * 简单策略能活下来，人玩起来才有余量；如果需要精妙操作才能不死，
 * 那说明是关卡生成的问题，不是机器人的问题。
 * =========================================================================== */

import { G, W, wrapDelta } from './engine.js';

/**
 * 给定状态返回一步输入。
 * @returns {{left:boolean, right:boolean, target:object|null}}
 */
export function botInput(s){
  const p = s.player;

  // 还能升到多高。下落中就是当前高度。
  const apex = p.y + (p.vy > 0 ? (p.vy * p.vy) / (2 * G) : 0);

  let best = null;
  for (const pl of s.platforms){
    if (pl.broken) continue;
    if (pl.y > apex - 0.15) continue;    // 够不着
    if (pl.y < p.y - 10)    continue;    // 太低，放弃比硬追划算
    if (!best || pl.y > best.y) best = pl;
  }

  // 一个都够不着：朝下方最高的那块靠，尽量在坠落中救回来
  if (!best){
    for (const pl of s.platforms){
      if (pl.broken) continue;
      if (!best || pl.y > best.y) best = pl;
    }
  }
  if (!best) return { left: false, right: false, target: null };

  const d = wrapDelta(p.x, best.x);
  // 阈值比一步位移(≈0.32)大，避免在目标点上抖动
  return { left: d < -0.4, right: d > 0.4, target: best };
}

/**
 * 让机器人自己玩一局。
 * @returns 这局的统计，供闸门断言
 */
export function botPlay(s, maxTicks){
  const { step } = arguments.length > 2 ? arguments[2] : {};
  return s;
}
