#!/usr/bin/env node
/* ===========================================================================
 * 浏览器闸门
 * ===========================================================================
 *
 * 和 scripts/verify.mjs 分开，因为它需要 Playwright（装浏览器要一分钟），
 * 而绝大多数改动根本不碰渲染层。快闸门的价值在于快,别把它拖慢。
 *
 *   npm run verify        引擎闸门，零依赖，二十秒
 *   npm run verify:web    这个，验 canvas 渲染器与排行榜前端
 *
 * 用法：
 *   npm run verify:web
 *   HEADFUL=1 npm run verify:web     想亲眼看它跑
 * =========================================================================== */

process.env.SCORES_FILE = process.env.SCORES_FILE ||
                          new URL('../artifacts/web-scores.json', import.meta.url).pathname;

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { createGame, step } from '../src/engine.js';
import { botInput } from '../src/bot.js';
import { createRecorder } from '../src/replay.js';
import { startServer } from './serve.mjs';

const HEADFUL = !!process.env.HEADFUL;
const BOT_SEC = Number(process.env.BOT_SEC || 18);
const ART     = path.resolve('artifacts');

const checks = [];
function check(name, ok, detail = ''){
  checks.push({ name, ok: !!ok, detail: String(detail) });
  console.log('[' + (ok ? '  ok  ' : ' FAIL ') + '] ' + name + (detail ? '  —  ' + detail : ''));
}

/** 轮询到条件成立或超时。慢机器上不能靠 sleep 固定时长。 */
async function until(page, fn, opt){
  opt = opt || {};
  const timeout  = opt.timeout  || 15000;
  const interval = opt.interval || 200;
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end){
    try { last = await page.evaluate(fn, opt.arg); } catch (e) { last = undefined; }
    if (last) return last;
    await page.waitForTimeout(interval);
  }
  return last || null;
}

const IGNORE = [/favicon\.ico/i, /SwiftShader/i, /GroupMarkerNotSet/i, /Fontconfig/i];
const noisy = t => IGNORE.some(re => re.test(t));

let server = null, browser = null, code = 0;
const metrics = {};

try{
  await fs.mkdir(ART, { recursive: true });
  try { fss.rmSync(process.env.SCORES_FILE, { force: true }); } catch (e) {}

  server = await startServer(0);
  console.log('\n内嵌服务器 → ' + server.url + '\n');

  /* 先往榜里塞两条真实成绩，这样排行榜断言有东西可看。
     用真的重放日志,服务端不接受别的。 */
  for (const [name, seed] of [['闸门甲', 1234], ['闸门乙', 5678]]){
    const g = createGame(seed);
    const rec = createRecorder();
    for (let i = 0; i < 20000 && g.alive; i++){
      const inp = i < 1200 ? botInput(g) : { left: false, right: false };  // 后半段放手，让它摔下去
      rec.push(inp);
      step(g, inp);
    }
    await fetch(server.url + '/api/scores', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, seed, log: rec.encode() }),
    });
  }

  browser = await chromium.launch({
    headless: !HEADFUL,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });

  const consoleErrors = [], pageErrors = [];
  page.on('console', m => {
    if (m.type() === 'error' && !noisy(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', e => {
    const t = e.message || String(e);
    if (!noisy(t)) pageErrors.push(t);
  });

  /* --- 01-02 页面与模块 --- */
  const resp = await page.goto(server.url + '/web/index.html',
                               { waitUntil: 'domcontentloaded', timeout: 30000 });
  check('01 页面返回 200', resp && resp.status() === 200,
        'HTTP ' + (resp ? resp.status() : '无响应'));

  const ready = await until(page, () => !!(window.__DIAG__ && window.__DIAG__.ready),
                            { timeout: 20000 });
  check('02 ES 模块加载成功（引擎直接跑在浏览器里）', ready,
        ready ? '' : '模块解析失败,多半是 import 路径不对');
  if (!ready) throw new Error('模块没起来，后面的断言没有意义');

  /* --- 03 canvas 真的画出了东西 --- */
  const colors0 = await page.evaluate(() => window.__DIAG__.sampleColors());
  metrics.menuColors = colors0;
  check('03 菜单画面非空白', colors0 >= 4, '采样到 ' + colors0 + ' 种颜色');

  /* --- 04 排行榜拉到数据并渲染 --- */
  const rows = await until(page, () => window.__DIAG__.boardRows || 0, { timeout: 15000 });
  metrics.boardRows = rows || 0;
  const apiUp = await page.evaluate(() => window.__DIAG__.apiUp);
  check('04 排行榜从 API 拉到数据并渲染', apiUp === true && rows >= 2,
        'apiUp=' + apiUp + ' · 渲染 ' + rows + ' 行');

  await page.screenshot({ path: path.join(ART, 'web-01-menu.png') });

  /* --- 05 开局 --- */
  await page.evaluate(() => window.__DIAG__.setName('闸门玩家'));
  await page.click('#btnStart', { timeout: 8000 });
  const playing = await until(page, () => window.__DIAG__.mode === 'play');
  const modeNow = await page.evaluate(() => window.__DIAG__.mode);
  check('05 点击开始进入游戏', playing, 'mode=' + modeNow);

  /* --- 06 帧在推进 --- */
  const f0 = await page.evaluate(() => window.__DIAG__.frames);
  await page.waitForTimeout(1500);
  const f1 = await page.evaluate(() => window.__DIAG__.frames);
  metrics.fps = Math.round((f1 - f0) / 1.5);
  check('06 主循环在跑', f1 - f0 > 10,
        (f1 - f0) + ' 帧 / 1.5s（约 ' + metrics.fps + ' fps）');

  /* --- 07 画面内容比菜单更丰富，说明平台真的渲染了 --- */
  const colors1 = await page.evaluate(() => window.__DIAG__.sampleColors());
  metrics.playColors = colors1;
  check('07 游戏画面渲染出平台与角色', colors1 > colors0,
        '菜单 ' + colors0 + ' 种 → 游戏 ' + colors1 + ' 种');

  /* --- 08 输入被记进日志（提交靠的就是它） --- */
  const p0 = await page.evaluate(() => window.__DIAG__.playerPos);
  await page.keyboard.down('KeyD');
  const moved = await until(page, (o) => {
    const p = window.__DIAG__.playerPos;
    if (!p || !o) return 0;
    const d = Math.abs(p.x - o.x);
    return (d > 1 && d < 20) ? d : 0;      // 排除环形接缝造成的跳变
  }, { timeout: 10000, arg: p0 });
  await page.keyboard.up('KeyD');
  const log = await page.evaluate(() => ({
    ticks: window.__DIAG__.logTicks, size: window.__DIAG__.logSize,
  }));
  metrics.logTicks = log.ticks;
  metrics.logSize = log.size;
  check('08 按键生效且被记入操作日志', !!moved && log.ticks > 30 && log.size > 0,
        (moved ? '位移 ' + Number(moved).toFixed(2) : '没反应') +
        ' · 日志 ' + log.ticks + ' 帧 / ' + log.size + ' 字符');

  await page.screenshot({ path: path.join(ART, 'web-02-play.png') });

  /* --- 09 分享卡片真的画出了像素 --- */
  const card = await page.evaluate(() => {
    window.__DIAG__.makeCard();
    return window.__DIAG__.cardDrawn;
  });
  check('09 分享卡片画出真实内容', card === true,
        card ? '中心点有非透明像素' : '卡片是空的');

  await page.screenshot({ path: path.join(ART, 'web-03-card.png') });

  /* --- 10 机器人在浏览器里也活得下来 --- */
  await page.goto(server.url + '/web/index.html?bot=1&seed=20260811',
                  { waitUntil: 'domcontentloaded' });
  await until(page, () => !!(window.__DIAG__ && window.__DIAG__.mode === 'play'),
              { timeout: 20000 });
  await page.waitForTimeout(BOT_SEC * 1000);
  const bot = await page.evaluate(() => ({
    alive: window.__DIAG__.alive,
    score: window.__DIAG__.score,
    jumps: window.__DIAG__.jumps,
  }));
  metrics.botScore = bot.score;
  metrics.botJumps = bot.jumps;
  check('10 机器人在浏览器里存活', bot.alive,
        BOT_SEC + 's 后 高度 ' + bot.score + ' · 跳跃 ' + bot.jumps);

  /* --- 11 零错误（放在离线测试之前，那一步会故意制造网络失败） --- */
  check('11 无 console 报错', consoleErrors.length === 0,
        consoleErrors.slice(0, 3).join(' | ') || '干净');
  check('12 无未捕获异常', pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | ') || '干净');

  /* --- 13 API 挂掉时优雅降级 ---
     联机功能不可用，不该拖垮单机体验。 */
  {
    const before = pageErrors.length;
    await page.goto('about:blank');
    await server.close();
    server = null;

    // 换一个不带 API 的纯静态服务，模拟「只有前端被部署出去」的情况
    const staticSrv = await startStatic();
    try{
      const p2 = await browser.newPage({ viewport: { width: 900, height: 620 } });
      const errs = [];
      p2.on('pageerror', e => { if (!noisy(e.message || '')) errs.push(e.message); });

      await p2.goto(staticSrv.url + '/web/index.html', { waitUntil: 'domcontentloaded' });
      await until(p2, () => !!(window.__DIAG__ && window.__DIAG__.ready), { timeout: 20000 });
      await until(p2, () => window.__DIAG__.apiUp === false, { timeout: 15000 });
      await p2.click('#btnStart', { timeout: 8000 });
      const ok = await until(p2, () => window.__DIAG__.mode === 'play', { timeout: 10000 });
      const offlineApi = await p2.evaluate(() => window.__DIAG__.apiUp);

      check('13 排行榜不可用时游戏照常能玩', ok === true && offlineApi === false && errs.length === 0,
            'apiUp=' + offlineApi + ' · 开局' + (ok ? '成功' : '失败') +
            (errs.length ? ' · 抛异常 ' + errs[0] : ' · 无异常'));
      await p2.screenshot({ path: path.join(ART, 'web-04-offline.png') });
    } finally {
      await staticSrv.close();
    }
  }

} catch (err){
  console.error('\n验证过程本身出错：', (err && err.message) || err);
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server)  await server.close().catch(() => {});
  try { fss.rmSync(process.env.SCORES_FILE, { force: true }); } catch (e) {}
}

/** 不挂 API 的纯静态服务，用来验降级路径。 */
async function startStatic(){
  const http = await import('node:http');
  const ROOT = path.resolve('.');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const srv = http.createServer(async (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (rel.startsWith('/api/')){ res.writeHead(503).end('no api'); return; }
    if (rel === '/') rel = '/web/index.html';
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT)){ res.writeHead(403).end(); return; }
    try{
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    }catch{ res.writeHead(404).end('not found'); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + srv.address().port,
    close: () => new Promise(r => srv.close(() => r())),
  };
}

const failed = checks.filter(c => !c.ok);
const report = {
  ranAt: new Date().toISOString(),
  passed: checks.length - failed.length,
  total: checks.length,
  metrics,
  failures: failed.map(f => f.name + ': ' + f.detail),
};
await fs.mkdir(ART, { recursive: true });
await fs.writeFile(path.join(ART, 'verify-web-report.json'), JSON.stringify(report, null, 2));

console.log('\n' + '-'.repeat(60));
console.log('  ' + report.passed + ' / ' + report.total + ' 项通过   ·   约 ' +
            (metrics.fps || '?') + ' fps');
console.log('-'.repeat(60));

if (failed.length || code){
  if (failed.length){
    console.log('\n失败项：');
    for (const f of failed) console.log('  x ' + f.name + '  ' + f.detail);
  }
  process.exit(1);
}
console.log('\n浏览器闸门通过。');
process.exit(0);
