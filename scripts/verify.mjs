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
const WORKFLOW    = '.github/workflows/verify.yml';
// AGENTS.md 说自己限 200 行,写长了，它写给的那个模型会开始跳着读。
// 这个数字必须有断言守着：文件只会单向变长，而一句写在文件里的自我要求
// 不阻止任何人。姊妹项目那份实测五轮之后涨到了 220 行，没人发现。
const MAX_RULES_LINES = 200;
// 报告 job 的每一步。supercubegame/image-grabber 有同一个 job，同样的 id、
// 同样的名字,两个仓库各写各的，就是它们开始分叉的方式。
//
// 闸门按 **id** 定位步骤。显示名是标签，把断言挂在标签上等于「改个名字」
// 就是「弄坏闸门」,而那正是当初把两边名字冻成一中一英的原因。名字另行
// 断言成精确值，所以改名是主动变红，不是悄悄分叉。
const REPORT_STEPS = [
  { id: 'download', name: '下载闸门报告' },
  { id: 'seed',     name: '种下兜底评论' },
  { id: 'fetch',    name: '取 composer' },
  { id: 'compose',  name: '合成报告' },
  { id: 'post',     name: '回写报告' },
  { id: 'verdict',  name: '闸门失败或报告降级则失败' },
];

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

/**
 * 把一个 job 的文本切成步骤。一步从「六个空格 + `- `」开始，它的 id 和 name
 * 在里面。按 id 定位是重点,理由见 REPORT_STEPS 的注释。
 */
function parseSteps(block){
  const steps = [];
  let cur = null;
  for (const line of block.split('\n')){
    if (/^ {6}- \S/.test(line)){
      cur = { name: null, id: null, lines: [] };
      steps.push(cur);
    }
    if (!cur) continue;
    cur.lines.push(line);
    const named = /^ {6}- name:\s*(.+?)\s*$/.exec(line);
    if (named) cur.name = named[1];
    const identified = /^ {8}id:\s*(\S+)\s*$/.exec(line);
    if (identified) cur.id = identified[1];
  }
  return steps.map((s, i) => ({ ...s, index: i, text: s.lines.join('\n') }));
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

/* --- 18 报告 job 的形状 ---
 *
 * 送不出结论的闸门，等于没跑。image-grabber 的 run #51 就是这样：两条闸门
 * 全绿，报告 job 的 actions/checkout 死在 git 证书校验（exit 128），那次
 * 提交上一条评论都没有,从仓库外面看完全像是「跑过了」。
 *
 * 这条守的四件事在坏掉的时候全都是静默的，所以它们必须是断言而不是文档：
 * 那个 job 不 clone、在任何会失败的步骤之前就种下兜底评论、取脚本和回写
 * 都带重试、降级的报告自己说明自己是降级的。
 *
 * 步骤按 id 找，名字单独对。理由见 REPORT_STEPS 的注释。
 */
{
  let problems = [];
  let detail = '';
  let found = [];
  try{
    const wf = fs.readFileSync(path.resolve(WORKFLOW), 'utf8');
    const jobs = {};
    let current = null, inJobs = false;
    for (const line of wf.split('\n')){
      if (/^jobs:\s*$/.test(line)){ inJobs = true; continue; }
      if (!inJobs) continue;
      const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (m){ current = m[1]; jobs[current] = []; continue; }
      if (current) jobs[current].push(line);
    }
    const report = jobs.report ? jobs.report.join('\n') : null;

    if (!report){
      problems.push('workflow 里没有 report job,改名了，还是这段解析坏了？找到的 job：' +
                    (Object.keys(jobs).join('、') || '一个都没有'));
    } else {
      // 负向孪生。解析出空块的话，下面每条「不包含」都会免费通过，所以先
      // 证明这段解析是有效的：两条闸门 job 确实 checkout 了，而且必须 checkout。
      for (const name of ['gate', 'web']){
        const block = jobs[name] ? jobs[name].join('\n') : '';
        if (!block.includes('actions/checkout')){
          problems.push(name + ' job 的块里没有 actions/checkout，说明 workflow 解析是错的，' +
                        '下面那些断言什么都证明不了');
        }
      }
      if (!problems.length){
        const steps = parseSteps(report);
        const byId = new Map(steps.filter(s => s.id).map(s => [s.id, s]));
        found = steps.map(s => (s.id || '(无 id)') + ' — ' + (s.name === null ? '(无名字)' : s.name));

        if (report.includes('actions/checkout')){
          problems.push('报告 job 又去 clone 整个仓库了：那正是 image-grabber run #51 里 exit 128 ' +
                        '的那一步，它把整条报告一起带走了。这个 job 要的是一个脚本文件，不是工作树');
        }

        // 先按 id 对结构，再对名字。
        for (const want of REPORT_STEPS){
          const s = byId.get(want.id);
          if (!s){
            problems.push('报告 job 里没有 id 为 `' + want.id + '` 的步骤,闸门按 id 找步骤，' +
                          '少一个说明结构变了，不只是标签变了');
            continue;
          }
          if (s.name !== want.name){
            problems.push('id 为 `' + want.id + '` 的步骤叫「' + s.name + '」，应该是「' + want.name +
                          '」,image-grabber 的报告 job 用的就是这几个名字，单边改名就是两边开始分叉的方式');
          }
        }

        const seed = byId.get('seed');
        const fetchStep = byId.get('fetch');
        const post = byId.get('post');

        if (seed && !seed.text.includes('> comment.md')){
          problems.push('`seed` 那一步没有写 comment.md，composer 一旦加载失败，这个 job 就没东西可发');
        }
        if (seed && post && seed.index > post.index){
          problems.push('兜底 comment.md 写在了回写步骤**之后**，等于没写');
        }
        if (fetchStep && !/--retry\b/.test(fetchStep.text)){
          problems.push('`fetch` 那一步没带 --retry，一次偶发抖动就能像上次那样把报告静音');
        }
        if (!report.includes('report-degraded.flag')){
          problems.push('没有任何东西标记降级：只带 job 结果的评论绝不能读起来像一份完整的');
        }
        if (post){
          if (/continue-on-error:\s*true/.test(post.text)) problems.push('回写步骤是 continue-on-error：一个允许自己静默失败的监控，比没有监控更危险');
          if (!/for \(let attempt/.test(post.text)) problems.push('回写步骤不重试,发评论和别的网络调用没有区别');
          if (!/readback/.test(post.text)) problems.push('回写步骤不读回,接口收下了不等于有人读得到这条评论');
        }
        // 顺带把重复跑那条一起守住
        if (/^on:[\s\S]*?\n {2}pull_request:/m.test(wf)){
          problems.push('workflow 同时挂在 push 和 pull_request 上，PR 里每次推送都会跑两遍闸门、抢同一条评论');
        }
      }
    }
    detail = problems.length
      ? problems.join(' ｜ ')
      : REPORT_STEPS.length + ' 个步骤按 id 找齐且名字一致；不 clone、回写前已种兜底评论、' +
        '取脚本与回写都带重试并读回、降级标红、只挂 push';
  } catch (e) {
    problems.push('读不到 ' + WORKFLOW + '：' + e.message);
    detail = problems.join(' ｜ ');
  }
  if (problems.length){
    extra.reportJob = problems;
    if (found.length) extra.reportJobSteps = found;
  }
  check('18 报告 job 不会被 clone、抖动或缺失的 composer 弄哑', problems.length === 0, detail);
}

/* --- 19 规矩文件保持简短，两份副本保持一致 ---
 *
 * 这份文件是交给下一个 agent 的交接材料，它有两个只会悄悄变坏的性质：
 * 越写越长，以及两份副本各自漂。两个都便宜到不值得不检查,而在有人检查
 * 之前，姊妹项目那份已经涨到 220 行了。
 *
 * 行数报进 metrics，评论里直接读得到,别等它撞线那天才知道它一直在长。
 */
{
  let problems = [];
  let detail = '';
  try{
    const agents = fs.readFileSync(path.resolve('AGENTS.md'), 'utf8');
    const claude = fs.readFileSync(path.resolve('CLAUDE.md'), 'utf8');
    const lines = agents.trimEnd().split('\n').length;
    metrics.rulesLines = lines;

    if (lines > MAX_RULES_LINES){
      problems.push('AGENTS.md ' + lines + ' 行，超过它自己写的 ' + MAX_RULES_LINES +
                    ' 行上限,砍别处或者拆文件，别放宽上限');
      extra.rulesTail = agents.trimEnd().split('\n')
        .map((l, i) => (i + 1) + ': ' + l).slice(-12).join('\n');
    }
    if (agents !== claude){
      const a = agents.split('\n'), c = claude.split('\n');
      const at = a.findIndex((l, i) => l !== c[i]);
      problems.push('CLAUDE.md 不是 AGENTS.md 的副本，第 ' + (at + 1) + ' 行开始分叉 ｜ ' +
                    'AGENTS：' + String(a[at] || '').slice(0, 60) + ' ｜ ' +
                    'CLAUDE：' + (c[at] === undefined ? '(文件到此结束)' : String(c[at]).slice(0, 60)));
    }
    detail = problems.length ? problems.join(' ｜ ')
                             : lines + ' 行（上限 ' + MAX_RULES_LINES + '），CLAUDE.md 逐字节一致';
  } catch (e) {
    problems.push('读不到规矩文件：' + e.message);
    detail = problems.join(' ｜ ');
  }
  check('19 规矩文件不超行数上限，且两份副本逐字节一致', problems.length === 0, detail);
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
