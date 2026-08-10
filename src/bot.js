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
 * 策略只有一条原则：**先算来不来得及，再谈跳多高。**
 *
 * 第一版是纯贪心,永远挑够得到的最高平台，完全不管横向距离。
 * 结果 24 局摔死 1 局：目标偏得太远时，它在半空中干等着摔下去。
 * 现在会解出降落到目标高度所需的时间，比对这段时间能横移多远。
 *
 * 策略仍然刻意保持简单。它能活下来，人玩才有余量；
 * 如果需要精妙操作才能不死，那是关卡生成的问题，不是机器人的问题。
 * =========================================================================== */

import { G, MOVE_V, wrapDelta, platformXAt } from './engine.js';

/** 留 8% 余量：落点判定有半个平台宽的容差，但别指望它 */
const SAFETY = 0.92;

/**
 * 给定状态返回这一步该按什么。
 * @returns {{left:boolean, right:boolean, target:object|null, feasible:boolean}}
 */
export function botInput(s){
  const p = s.player;

  let best = null, bestScore = -Infinity, bestX = p.x;

  for (const pl of s.platforms){
    if (pl.broken) continue;
    if (pl.y < p.y - 12) continue;               // 太低，追不如放弃

    // 从当前状态下落到该高度所需时间。判别式为负说明顶点都够不到。
    const disc = p.vy * p.vy + 2 * G * (p.y - pl.y);
    if (disc < 0) continue;
    const t = (p.vy + Math.sqrt(disc)) / G;
    if (t <= 0.02) continue;                     // 已经在脚下或刚刚错过

    const landX = platformXAt(pl, s.time + t);   // 移动平台要按落地时刻反解
    const need  = Math.abs(wrapDelta(p.x, landX));
    const slack = MOVE_V * t * SAFETY - need;

    // 够得着的一律优先，并且越高越好；都够不着时，选差得最少的那个
    const score = slack >= 0 ? 1e6 + pl.y : slack;
    if (score > bestScore){ bestScore = score; best = pl; bestX = landX; }
  }

  if (!best) return { left: false, right: false, target: null, feasible: false };

  const d = wrapDelta(p.x, bestX);
  // 阈值要大于一步的位移（≈0.32），否则会在目标点上左右抖
  return {
    left:  d < -0.4,
    right: d >  0.4,
    target: best,
    feasible: bestScore >= 1e6,
  };
}
