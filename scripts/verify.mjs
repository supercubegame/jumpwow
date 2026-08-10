#!/usr/bin/env node
/* ===========================================================================
 * JUMPWOW 验证闸门
 * ===========================================================================
 *
 * 一条命令回答一个问题：这份代码现在还能不能玩？
 *
 *   通过 → exit 0
 *   失败 → exit 1，逐项列出失败原因，并写出 artifacts/verify-report.json
 *
 * 用法：
 *   npm run verify
 *   SEEDS=40 SURVIVE_SEC=90 npm run verify     加严
 * =========================================================================== */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  createGame, step, run, fingerprint, difficultyAt,
  MAX_JUMP_H, VIEW_H, W, STEP, PLAT,
} from '../src/engine.js';
import { botInput } from '../src/bot.js';

const SEEDS        = Number(process.env.SEEDS || 24);
const SURVIVE_SEC  = Number(process.env.SURVIVE_SEC || 60);
const MIN_SCORE    = Number(process.env.MIN_SCORE || 120);
const PERF_BUDGET  = Number(process.env.PERF_BUDGET_MS || 2500);
const ART          = path.resolve('artifacts');

const checks = [];
function check(name, ok, detail = ''){
  checks.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}${detail ? '  —  ' + detail : ''}`);
}

const metrics = {};

/* --- 01 单元测试 --- */
{
  const r = spawnSync(process.execPath, ['--test', 'test/'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = (out.match(/^# pass (\d+)/m) || [])[1] || '?';
  const fail = (out.match(/^# fail (\d+)/m) || [])[1] || '?';
  check('01 单元测试全绿', r.status === 0, `pass ${pass} · fail ${fail}`);
  if (r.status !== 0){
    console.log('\n--- 单元测试输出 ---\n' + out.split('\n').slice(-45).join('\n'));
  }
  metrics.unitPass = Number(pass) || 0;
}

/* --- 02 确定性 --- */
{
  const a = fingerprint(run(createGame(20260811), 3600, botInput));
  const b = fingerprint(run(createGame(20260811), 3600, botInput));
  check('02 同种子结果完全一致', a === b,
        a === b ? '3600 步后指纹相同' : '指纹分叉,引擎里混进了外部状态');
}

/* --- 03 种子差异性 --- */
{
  const seen = new Set();
  for (let i = 0; i < 12; i++){
    const s = createGame(1000 + i);
    seen.add(s.platforms.slice(0, 8).map(p => `${Math.round(p.x)}:${Math.round(p.y * 10)}`).join(','));
  }
  check('03 不同种子生成不同地图', seen.size === 12, `12 个种子产生 ${seen.size} 张不同的图`);
}

/* --- 04 可达性不变量 --- */
{
  let worst = 0, worstSeed = 0, bad = 0;
  for (let i = 0; i < 60; i++){
    const s = createGame(7000 + i * 13);
    run(s, 4000, botInput);
    for (let k = 1; k < s.platforms.length; k++){
      const gap = s.platforms[k].y - s.platforms[k - 1].y;
      if (gap > worst){ worst = gap; worstSeed = s.seed; }
      if (gap >= MAX_JUMP_H) bad++;
    }
  }
  metrics.worstGap = Math.round(worst * 100) / 100;
  check('04 无跳不上去的死图', bad === 0,
        `60 个种子最大间距 ${metrics.worstGap} / 上限 ${MAX_JUMP_H.toFixed(2)}（seed ${worstSeed}）`);
}

/* --- 05 数值健康 --- */
{
  const s = createGame(4242);
  let bad = null;
  for (let i = 0; i < 8000 && s.alive && !bad; i++){
    step(s, botInput(s));
    const p = s.player;
    if (![p.x, p.y, p.vx, p.vy, s.cam, s.maxY].every(Number.isFinite)) bad = `第 ${i} 步出现非有限值`;
    if (p.x < 0 || p.x >= W) bad = `第 ${i} 步 x=${p.x} 越出环形world`;
  }
  check('05 无 NaN / 无坐标越界', !bad, bad || '8000 步内数值健康');
}

/* --- 06 平台数组有界 --- */
{
  const s = createGame(31337);
  run(s, 900, botInput);
  const early = s.platforms.length;
  run(s, 20000, botInput);
  const late = s.platforms.length;
  metrics.platformsLive = late;
  metrics.platformsGenerated = s.generated;
  check('06 平台数组有界（无泄漏）', late <= early + 4,
        `活跃 ${early} → ${late}，累计生成 ${s.generated}`);
}

/* --- 07-09 机器人多种子试玩：这游戏到底能不能玩 --- */
{
  const ticks = Math.round(SURVIVE_SEC / STEP);
  const runs = [];
  const t0 = performance.now();
  for (let i = 0; i < SEEDS; i++){
    const s = createGame(90000 + i * 7919);
    for (let k = 0; k < ticks && s.alive; k++) step(s, botInput(s));
    runs.push({
      seed: s.seed, alive: s.alive, score: s.score,
      jumps: s.stats.jumps, springs: s.stats.springs,
      broken: s.stats.broken, sec: Math.round(s.time * 10) / 10,
    });
  }
  metrics.botWallMs = Math.round(performance.now() - t0);

  const died  = runs.filter(r => !r.alive);
  const scores = runs.map(r => r.score).sort((a, b) => a - b);
  const median = scores[scores.length >> 1];
  const totalJumps = runs.reduce((a, r) => a + r.jumps, 0);
  metrics.medianScore = median;
  metrics.totalJumps = totalJumps;
  metrics.seeds = SEEDS;
  metrics.surviveSec = SURVIVE_SEC;

  check('07 机器人在所有种子上都活满全程', died.length === 0,
        died.length
          ? `${died.length}/${SEEDS} 局摔死，例如 seed ${died[0].seed} 撑了 ${died[0].sec}s 得分 ${died[0].score}`
          : `${SEEDS} 局 × ${SURVIVE_SEC}s 全部存活`);

  check('08 高度中位数达标', median >= MIN_SCORE,
        `中位 ${median} / 门槛 ${MIN_SCORE}，最低 ${scores[0]}，最高 ${scores[scores.length - 1]}`);

  check('09 特殊平台确实被用到', runs.some(r => r.springs > 0) && runs.some(r => r.broken > 0),
        `累计 ${totalJumps} 次跳跃，弹簧 ${runs.reduce((a, r) => a + r.springs, 0)} 次，` +
        `踩碎 ${runs.reduce((a, r) => a + r.broken, 0)} 块`);
}

/* --- 10 难度确实在爬升 --- */
{
  const lo = difficultyAt(0), mid = difficultyAt(200), hi = difficultyAt(500);
  check('10 难度随高度单调上升并封顶', lo === 0 && mid > 0 && mid < 1 && hi === 1,
        `d(0)=${lo} d(200)=${mid} d(500)=${hi}`);
}

/* --- 11 性能预算 --- */
{
  const t0 = performance.now();
  const s = createGame(2024);
  const ticks = 60 * 60 * 5;                      // 模拟 5 分钟
  for (let i = 0; i < ticks && s.alive; i++) step(s, botInput(s));
  const ms = performance.now() - t0;
  metrics.perfMs = Math.round(ms);
  metrics.perfTicks = s.ticks;
  check('11 5 分钟模拟在预算内', ms < PERF_BUDGET,
        `${Math.round(ms)}ms / 预算 ${PERF_BUDGET}ms（${s.ticks} 步）`);
}

/* --- 12 CLI 能跑起来并返回正确退出码 --- */
{
  const r = spawnSync(process.execPath, ['bin/jumpwow.js', '--bench', '20', '--seed', '99'],
                      { encoding: 'utf8', timeout: 30000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  check('12 CLI 无头模式正常退出', r.status === 0 && parsed && parsed.survived === true,
        parsed ? `退出码 ${r.status} · 得分 ${parsed.score} · ${parsed.wallMs}ms`
               : `退出码 ${r.status} · 输出无法解析：${(r.stderr || r.stdout || '').slice(0, 160)}`);
}

/* ----------------------------- 汇总 ----------------------------- */
const failed = checks.filter(c => !c.ok);
const report = {
  ranAt: new Date().toISOString(),
  node: process.version,
  passed: checks.length - failed.length,
  total: checks.length,
  metrics,
  failures: failed.map(f => `${f.name}: ${f.detail}`),
};

fs.mkdirSync(ART, { recursive: true });
fs.writeFileSync(path.join(ART, 'verify-report.json'), JSON.stringify(report, null, 2));

console.log('\n' + '-'.repeat(66));
console.log(`  ${report.passed} / ${report.total} 项通过` +
            `   ·   中位高度 ${metrics.medianScore}` +
            `   ·   ${metrics.totalJumps} 次跳跃` +
            `   ·   5min 模拟 ${metrics.perfMs}ms`);
console.log('-'.repeat(66));

if (failed.length){
  console.log('\n失败项：');
  for (const f of failed) console.log(`  x ${f.name}  ${f.detail}`);
  process.exit(1);
}
console.log('\n闸门通过。');
process.exit(0);
