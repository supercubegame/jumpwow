#!/usr/bin/env node
/* ===========================================================================
 * 浏览器渲染器闸门
 * ===========================================================================
 *
 * 和 scripts/verify.mjs 分开，因为它需要 Playwright（装浏览器要一分钟），
 * 而绝大多数改动根本不碰渲染层。快闸门的价值在于快,别把它拖慢。
 *
 *   npm run verify        引擎闸门，零依赖，二十秒
 *   npm run verify:web    这个，验 canvas 渲染器
 *
 * 用法：
 *   npm run verify:web
 *   HEADFUL=1 npm run verify:web     想亲眼看它跑
 * =========================================================================== */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  server = await startServer(0);
  console.log('\n内嵌服务器 → ' + server.url + '\n');

  browser = await chromium.launch({
    headless: !HEADFUL,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });

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

  await page.screenshot({ path: path.join(ART, 'web-01-menu.png') });

  /* --- 04 开局 --- */
  await page.click('#btnStart', { timeout: 8000 });
  const playing = await until(page, () => window.__DIAG__.mode === 'play');
  const modeNow = await page.evaluate(() => window.__DIAG__.mode);
  check('04 点击开始进入游戏', playing, 'mode=' + modeNow);

  /* --- 05 帧在推进 --- */
  const f0 = await page.evaluate(() => window.__DIAG__.frames);
  await page.waitForTimeout(1500);
  const f1 = await page.evaluate(() => window.__DIAG__.frames);
  metrics.fps = Math.round((f1 - f0) / 1.5);
  check('05 主循环在跑', f1 - f0 > 10,
        (f1 - f0) + ' 帧 / 1.5s（约 ' + metrics.fps + ' fps）');

  /* --- 06 画面内容比菜单更丰富，说明平台真的渲染了 --- */
  const colors1 = await page.evaluate(() => window.__DIAG__.sampleColors());
  metrics.playColors = colors1;
  check('06 游戏画面渲染出平台与角色', colors1 > colors0,
        '菜单 ' + colors0 + ' 种 → 游戏 ' + colors1 + ' 种');

  /* --- 07 键盘输入真的驱动角色 --- */
  const p0 = await page.evaluate(() => window.__DIAG__.playerPos);
  await page.keyboard.down('KeyD');
  const moved = await until(page, (o) => {
    const p = window.__DIAG__.playerPos;
    if (!p || !o) return 0;
    const d = Math.abs(p.x - o.x);
    return (d > 1 && d < 20) ? d : 0;      // 排除环形接缝造成的跳变
  }, { timeout: 10000, arg: p0 });
  await page.keyboard.up('KeyD');
  check('07 按住方向键角色横移', !!moved,
        moved ? '位移 ' + Number(moved).toFixed(2) : '没反应');

  await page.screenshot({ path: path.join(ART, 'web-02-play.png') });

  /* --- 08 机器人在浏览器里也活得下来 --- */
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
  check('08 机器人在浏览器里存活', bot.alive,
        BOT_SEC + 's 后 高度 ' + bot.score + ' · 跳跃 ' + bot.jumps);

  await page.screenshot({ path: path.join(ART, 'web-03-bot.png') });

  /* --- 09-10 零错误 --- */
  check('09 无 console 报错', consoleErrors.length === 0,
        consoleErrors.slice(0, 3).join(' | ') || '干净');
  check('10 无未捕获异常', pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | ') || '干净');

} catch (err){
  console.error('\n验证过程本身出错：', (err && err.message) || err);
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server)  await server.close().catch(() => {});
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
