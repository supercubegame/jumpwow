#!/usr/bin/env node
/* ===========================================================================
 * JUMPWOW 引擎闸门
 * ===========================================================================
 *
 * 一条命令回答一个问题：这份代码现在还能不能玩？
 *
 *   通过 → exit 0
 *   失败 → exit 1，逐项列出失败原因，并写出 artifacts/verify-report.json
 *
 * 报告要自带足够的线索。读报告的人（或 agent）通常拿不到 CI 的原始日志,
 * 所以失败原因必须写进报告，而不是只留一个「失败 1 项」。
 *
 * 用法：
 *   npm run verify
 *   SEEDS=40 SURVIVE_SEC=90 npm run verify     加严
 * =========================================================================== */

// 必须在 import serve.mjs 之前设好，api.mjs 在模块加载时就读这个变量
process.env.SCORES_FILE = process.env.SCORES_FILE ||
                          new URL('../artifacts/test-scores.json', import.meta.url).pathname;

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  createGame, step, run, fingerprint, difficultyAt,
  MAX_JUMP_H, W, STEP,
} from '../src/engine.js';
import { botInput } from '../src/bot.js';
import { createRecorder, replay, encodeLog, decodeLog } from '../src/replay.js';

const SEEDS       = Number(process.env.SEEDS || 24);
const SURVIVE_SEC = Number(process.env.SURVIVE_SEC || 60);
const MIN_SCORE   = Number(process.env.MIN_SCORE || 120);
const PERF_BUDGET = Number(process.env.PERF_BUDGET_MS || 2500);
const ART         = path.resolve('artifacts');
const TEST_DIR    = path.resolve('test');

const checks = [];
function check(name, ok, detail = ''){
  checks.push({ name, ok: !!ok, detail: String(detail) });
  console.log('[' + (ok ? '  ok  ' : ' FAIL ') + '] ' + name + (detail ? '  —  ' + detail : ''));
}

const metrics = {};
const extra = {};

fs.mkdirSync(ART, { recursive: true });

/**
 * 玩到死，返回可提交的样本局。
 *
 * 排行榜只收「已经结束」的局，所以测试必须真的把玩家玩死。
 * 光让机器人跑是死不掉的,它会一直往上爬；而完全不按键也死不掉,
 * 玩家会在同一块平台上原地弹跳到天荒地老。
 *
 * 办法是先让机器人爬一段拿到分数，再一直按同一个方向：玩家会横向漂离
 * 平台，而相机只升不降，掉出视野下沿就判死。
 */
function playToDeath(seed, climbTicks = 1200, capTicks = 20000){
  const g = createGame(seed);
  const rec = createRecorder();
  for (let i = 0; i < capTicks && g.alive; i++){
    const input = i < climbTicks ? botInput(g) : { left: false, right: true };
    rec.push(input);
    step(g, input);
  }
  return { seed: g.seed, log: rec.encode(), score: g.score,
           ticks: g.ticks, jumps: g.stats.jumps, alive: g.alive };
}

/* --- 01 单元测试 ---
 *
 * 自己枚举文件显式传给 node。不要写 `--test test/`,新版 Node 会把它
 * 当模块去 resolve 然后 MODULE_NOT_FOUND，测试一条都不会跑，而闸门
 * 只会告诉你「失败 1 项」，非常难查。也不要依赖 shell 展开 glob，
 * spawnSync 默认没有 shell。
 */
{
  const files = fs.existsSync(TEST_DIR)
    ? fs.readdirSync(TEST_DIR).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f))
    : [];

  if (!files.length){
    check('01 单元测试全绿', false, '在 test/ 下没找到任何 *.test.js,测试文件被挪走了？');
    metrics.unitFiles = 0;
  } else {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files],
                        { encoding: 'utf8' });
    const out = ((r.stdout || '') + (r.stderr || '')).replace(/\r/g, '');

    const num = re => { const m = out.match(re); return m ? Number(m[1]) : null; };
    const pass = num(/^# pass (\d+)/m);
    const fail = num(/^# fail (\d+)/m);

    const failing = [...out.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)]
      .map(m => m[1].trim())
      .filter(n => !/\.(m|c)?js$/.test(n));

    const errLines = [...out.matchAll(/^\s*(?:error|expected|actual):\s*(.+)$/gm)]
      .map(m => m[1].trim()).filter(v => v && v !== "'test failed'").slice(0, 4);

    const ok = r.status === 0;
    metrics.unitFiles = files.length;
    metrics.unitPass = pass;
    metrics.unitFail = fail;

    if (!ok){
      extra.unitFailing = failing;
      extra.unitErrors = errLines;
      extra.unitTail = out.split('\n').slice(-70).join('\n');
    }

    check('01 单元测试全绿', ok,
          ok ? files.length + ' 个文件 · ' + pass + ' 条通过'
             : (failing.length ? '挂了 ' + failing.length + ' 条：' + failing.slice(0, 3).join(' / ')
                               : '退出码 ' + r.status + '，未能解析出测试名，见报告里的 unitTail') +
               (errLines.length ? ' ｜ ' + errLines[0] : ''));

    if (!ok) console.log('\n--- 单元测试输出（末尾 70 行）---\n' + extra.unitTail + '\n');
  }
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
    seen.add(s.platforms.slice(0, 8).map(p => Math.round(p.x) + ':' + Math.round(p.y * 10)).join(','));
  }
  check('03 不同种子生成不同地图', seen.size === 12, '12 个种子产生 ' + seen.size + ' 张不同的图');
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
        '60 个种子最大间距 ' + metrics.worstGap + ' / 上限 ' + MAX_JUMP_H.toFixed(2) +
        '（seed ' + worstSeed + '）');
}

/* --- 05 数值健康 --- */
{
  const s = createGame(4242);
  let bad = null;
  for (let i = 0; i < 8000 && s.alive && !bad; i++){
    step(s, botInput(s));
    const p = s.player;
    if (![p.x, p.y, p.vx, p.vy, s.cam, s.maxY].every(Number.isFinite)) bad = '第 ' + i + ' 步出现非有限值';
    if (p.x < 0 || p.x >= W) bad = '第 ' + i + ' 步 x=' + p.x + ' 越出环形世界';
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
        '活跃 ' + early + ' → ' + late + '，累计生成 ' + s.generated);
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

  const died   = runs.filter(r => !r.alive);
  const scores = runs.map(r => r.score).sort((a, b) => a - b);
  const median = scores[scores.length >> 1];
  metrics.medianScore = median;
  metrics.minScore = scores[0];
  metrics.maxScore = scores[scores.length - 1];
  metrics.totalJumps = runs.reduce((a, r) => a + r.jumps, 0);
  metrics.seeds = SEEDS;
  metrics.surviveSec = SURVIVE_SEC;
  if (died.length) extra.deaths = died;

  check('07 机器人在所有种子上都活满全程', died.length === 0,
        died.length
          ? died.length + '/' + SEEDS + ' 局摔死：' +
            died.slice(0, 3).map(d => 'seed ' + d.seed + ' 撑 ' + d.sec + 's 得分 ' + d.score).join(' / ')
          : SEEDS + ' 局 × ' + SURVIVE_SEC + 's 全部存活');

  check('08 高度中位数达标', median >= MIN_SCORE,
        '中位 ' + median + ' / 门槛 ' + MIN_SCORE + '，区间 ' + scores[0] + '-' + scores[scores.length - 1]);

  check('09 特殊平台确实被用到', runs.some(r => r.springs > 0) && runs.some(r => r.broken > 0),
        '累计 ' + metrics.totalJumps + ' 次跳跃，弹簧 ' + runs.reduce((a, r) => a + r.springs, 0) +
        ' 次，踩碎 ' + runs.reduce((a, r) => a + r.broken, 0) + ' 块');
}

/* --- 10 难度确实在爬升 --- */
{
  const lo = difficultyAt(0), mid = difficultyAt(200), hi = difficultyAt(500);
  check('10 难度随高度单调上升并封顶', lo === 0 && mid > 0 && mid < 1 && hi === 1,
        'd(0)=' + lo + ' d(200)=' + mid + ' d(500)=' + hi);
}

/* --- 11 性能预算 --- */
{
  const t0 = performance.now();
  const s = createGame(2024);
  for (let i = 0; i < 60 * 60 * 5 && s.alive; i++) step(s, botInput(s));
  const ms = performance.now() - t0;
  metrics.perfMs = Math.round(ms);
  check('11 5 分钟模拟在预算内', ms < PERF_BUDGET,
        Math.round(ms) + 'ms / 预算 ' + PERF_BUDGET + 'ms（' + s.ticks + ' 步）');
}

/* --- 12 CLI 能跑起来并返回正确退出码 --- */
{
  const r = spawnSync(process.execPath, ['bin/jumpwow.js', '--bench', '20', '--seed', '99'],
                      { encoding: 'utf8', timeout: 30000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (e) {}
  check('12 CLI 无头模式正常退出', r.status === 0 && parsed && parsed.survived === true,
        parsed ? '退出码 ' + r.status + ' · 得分 ' + parsed.score + ' · ' + parsed.wallMs + 'ms'
               : '退出码 ' + r.status + ' · 输出无法解析：' + (r.stderr || r.stdout || '').slice(0, 200));
}

/* =========================================================================
 * 13-17 重放验证与排行榜服务端
 *
 * 排行榜的反作弊完全建立在「引擎确定性」上。这几条就是那个前提的
 * 直接检验,一旦有人往引擎里塞了 Date.now() 或 Math.random()，
 * 第 14 条会立刻红，而不是等到线上被人刷榜才发现。
 * ========================================================================= */

/* --- 13 日志编解码往返 --- */
{
  const cases = [[], [0], [0,0,0,2,2], Array.from({ length: 777 }, (_, i) => i % 3)];
  let bad = null;
  for (const c of cases){
    const back = decodeLog(encodeLog(c));
    if (back.length !== c.length || back.some((v, i) => v !== c[i])){
      bad = c.length + ' 帧的用例往返后不一致';
      break;
    }
  }
  const big = encodeLog(new Array(5000).fill(2));
  metrics.rleSample = big.length;
  check('13 输入日志编解码往返无损', !bad && big.length < 12,
        bad || ('5000 帧同键压到 ' + big.length + ' 字符'));
}

/* --- 14 重放与实跑逐字段一致 --- */
const honest = playToDeath(20260811);
{
  const r = replay(honest.seed, honest.log);
  const same = r.score === honest.score && r.ticks === honest.ticks &&
               r.jumps === honest.jumps && r.alive === honest.alive;
  metrics.replayScore = r.score;
  metrics.replayLogChars = honest.log.length;
  metrics.replayTicks = r.ticks;

  check('14 重放结果与实跑逐字段一致', same,
        same ? ('分数 ' + r.score + ' · ' + r.ticks + ' 帧 · 日志 ' + honest.log.length + ' 字符')
             : ('实跑 ' + honest.score + '/' + honest.ticks + '，重放 ' + r.score + '/' + r.ticks +
                ',引擎里混进了外部状态'));
}

/* --- 15 篡改会被发现 ---
 *
 * 注意别把这条写得太弱。第一版只翻转日志的第一个字符,那等于开局第一帧
 * 从「没按」变成「按左」，位移 0.32 个单位，而落地判定有半个平台宽的容差，
 * 结果自然一模一样，断言就永远红。真正要保证的不是「任何一个 bit 变化都
 * 改变结果」，而是「靠改日志拿不到更高的分」。
 */
{
  const states = decodeLog(honest.log);
  const wrongSeed = replay(honest.seed + 1, honest.log).score;

  // 翻转中段一整块，这是有实质影响的篡改
  const mid = states.slice();
  const from = Math.floor(mid.length * 0.3);
  for (let i = from; i < Math.min(mid.length, from + 400); i++){
    mid[i] = mid[i] === 1 ? 2 : 1;
  }
  const flipped = replay(honest.seed, encodeLog(mid)).score;

  // 截断：少玩几帧不可能得更高分
  const cut = replay(honest.seed, encodeLog(states.slice(0, Math.floor(states.length * 0.6)))).score;

  const ok = wrongSeed !== honest.score &&
             flipped   !== honest.score &&
             cut       <=  honest.score;
  metrics.tamper = { honest: honest.score, wrongSeed, flipped, cut };

  check('15 篡改日志或换种子都拿不到这个分数', ok,
        '诚实 ' + honest.score + ' · 换种子 ' + wrongSeed +
        ' · 翻转中段 ' + flipped + ' · 截断 ' + cut);
}

/* --- 16-17 排行榜服务端 --- */
{
  const store = process.env.SCORES_FILE;
  try { fs.rmSync(store, { force: true }); } catch (e) {}

  const { startServer } = await import('../scripts/serve.mjs');
  const srv = await startServer(0);
  const api = srv.url + '/api/scores';

  const post = async body => {
    const r = await fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  try{
    // 16：提交一局真实成绩。故意带上一个夸张的 score 字段,
    // 落库的必须是重放算出来的真值，不是这个。
    const sent = await post({
      name: '  闸门<script>  ', seed: honest.seed, log: honest.log,
      score: 999999,
    });

    const list = await (await fetch(api + '?limit=5')).json();
    const top = list.scores && list.scores[0];

    const ok16 = sent.status === 201 &&
                 sent.body.entry.score === honest.score &&
                 sent.body.verified === true &&
                 top && top.score === honest.score &&
                 top.name === '闸门<script>';

    metrics.serverRank = sent.body && sent.body.rank;
    check('16 服务端以重放值判分，忽略客户端上报的分数', ok16,
          ok16 ? ('落库 ' + sent.body.entry.score + ' 分（客户端声称 999999），第 ' +
                  sent.body.rank + ' 名，名字已消毒')
               : ('HTTP ' + sent.status + ' ' + JSON.stringify(sent.body).slice(0, 220)));

    // 17：几种伪造与畸形输入，全都必须被挡
    const bad = [
      ['空日志（这局还没结束）', { name: 'x', seed: 1, log: '' }],
      ['未结束的局',            { name: 'x', seed: 3, log: '0a' }],
      ['畸形日志',              { name: 'x', seed: 1, log: '9zzz' }],
      ['非法种子',              { name: 'x', seed: -5, log: honest.log }],
      ['缺日志只报分数',        { name: 'x', seed: 1, score: 99999 }],
      ['日志超长',              { name: 'x', seed: 1, log: '1'.repeat(30000) }],
    ];
    const notes = [];
    for (const [label, body] of bad){
      const r = await post(body);
      notes.push(r.status >= 400 ? label : '!!未挡住: ' + label);
    }
    const ok17 = notes.every(x => !x.startsWith('!!'));
    check('17 服务端拒绝伪造与畸形提交', ok17,
          ok17 ? ('挡住 ' + notes.length + ' 类：' + notes.join('、'))
               : notes.filter(x => x.startsWith('!!')).join(' / '));

  } finally {
    await srv.close();
    try { fs.rmSync(store, { force: true }); } catch (e) {}
  }
}

/* ----------------------------- 汇总 ----------------------------- */
const failed = checks.filter(c => !c.ok);
const report = {
  ranAt: new Date().toISOString(),
  node: process.version,
  passed: checks.length - failed.length,
  total: checks.length,
  metrics,
  failures: failed.map(f => f.name + ': ' + f.detail),
  ...extra,
};

fs.writeFileSync(path.join(ART, 'verify-report.json'), JSON.stringify(report, null, 2));

console.log('\n' + '-'.repeat(66));
console.log('  ' + report.passed + ' / ' + report.total + ' 项通过' +
            '   ·   单测 ' + (metrics.unitPass == null ? '?' : metrics.unitPass) + ' 条' +
            '   ·   中位高度 ' + metrics.medianScore +
            '   ·   5min 模拟 ' + metrics.perfMs + 'ms');
console.log('-'.repeat(66));

if (failed.length){
  console.log('\n失败项：');
  for (const f of failed) console.log('  x ' + f.name + '  ' + f.detail);
  process.exit(1);
}
console.log('\n闸门通过。');
process.exit(0);
