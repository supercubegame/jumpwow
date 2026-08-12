#!/usr/bin/env node
/* ===========================================================================
 * 把两条闸门的报告合成那一条回写出去的评论。
 * ===========================================================================
 *
 * 从内联的 github-script 里搬出来的，理由有两个：一是这样能本地跑
 * （`node scripts/compose-report.mjs reports`），二是回写那个 job 因此
 * 只需要这一个文件，不需要 clone 整个仓库,而那次 clone 正是 image-grabber
 * run #51 里把整条报告干掉的东西。
 *
 * 两条规矩：
 *
 * 1. 报告缺失算失败。job 在写出报告之前就崩了，绝不能看起来像通过,
 *    一个会静默坏掉的监控比没有监控更危险。
 * 2. 报告缺失也必须带证据。「没有产出报告」只告诉你监控坏了，不告诉你
 *    为什么，而 CI 日志从评论里是点不到的。两条闸门都把 stdout tee 成
 *    artifacts/stdout-<slug>.log 就是为了这一刻。
 *
 * 用法：
 *   node scripts/compose-report.mjs <目录>            写出 comment.md
 *   node scripts/compose-report.mjs <目录> --check    只判定退出码
 * =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--')) || 'reports';
const checkOnly = args.includes('--check');

const GATES = [
  { slug: 'eng', label: '引擎闸门', file: 'verify-report.json' },
  { slug: 'web', label: '浏览器闸门', file: 'verify-web-report.json' },
];

const LOG_TAIL_LINES = 80;

function findFile(name){
  const hits = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries){
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === name) hits.push(p);
    }
  };
  walk(dir);
  return hits[0] || null;
}

function readJson(file){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function tail(text, lines = LOG_TAIL_LINES){
  return String(text || '').replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
}

function fold(summary, text){
  return '<details><summary>' + summary + '</summary>\n\n```\n' + text + '\n```\n\n</details>';
}

const num = v => (v == null ? '?' : v);
const pct = (v, digits) => (v == null ? '?' : (v * 100).toFixed(digits) + '%');

/* 报告缺失。这一段是整个文件里最重要的部分,它出现的时候，正是你最没有
 * 别的线索可查的时候。 */
function missingSection(gate){
  const logFile = findFile('stdout-' + gate.slug + '.log');
  const log = logFile ? tail(fs.readFileSync(logFile, 'utf8')) : '';
  const evidence = log
    ? fold('闸门自己输出的末尾 ' + log.split('\n').length + ' 行', log.slice(-8000))
    : '连 stdout 日志也没有，说明这次在闸门跑起来之前就断了 - 去看 workflow，不是看闸门。';
  return [
    '### ❌ ' + gate.label + ' — 没有产出报告',
    '',
    '闸门在写出报告之前就崩了，或者 artifact 根本没上传。**这算失败**,',
    '一份送不出结论的报告，和没跑过是一回事。',
    '',
    evidence,
    '',
  ].join('\n');
}

function engSection(data){
  const m = data.metrics || {};
  const lines = [
    '### ' + (data.failures && data.failures.length ? '❌' : '✅') +
      ' 引擎闸门 — ' + data.passed + '/' + data.total + ' 项通过',
    '',
    '- 单元测试 ' + num(m.unitPass) + ' 条' +
      (m.unitFiles == null ? '' : '（' + m.unitFiles + ' 个文件）'),
    '- 机器人 ' + m.seeds + ' 局 × ' + m.surviveSec + 's，高度中位 ' + m.medianScore +
      '（' + m.minScore + '-' + m.maxScore + '）',
    '- 最大平台间距 ' + m.worstGap + '，活跃平台 ' + m.platformsLive,
    '- 5min 模拟 ' + m.perfMs + ' ms',
    '- 规矩文件 ' + num(m.rulesLines) + ' 行（上限 200）',
  ];
  if (m.tamper){
    lines.push('- 反作弊：诚实 ' + m.tamper.honest + ' · 换种子 ' + m.tamper.wrongSeed +
               ' · 翻转 ' + m.tamper.flipped + ' · 截断 ' + m.tamper.cut);
  }
  return lines.join('\n') + '\n';
}

function webSection(data){
  const m = data.metrics || {};
  return [
    '### ' + (data.failures && data.failures.length ? '❌' : '✅') +
      ' 浏览器闸门 — ' + data.passed + '/' + data.total + ' 项通过',
    '',
    '- 约 ' + m.fps + ' fps，画布 ' + num(m.canvas),
    // 阈值要按实测值收紧，所以这两个数必须能从评论里直接读到
    '- 画面内容色像素 ' + num(m.playInk) + '（占 ' + pct(m.playInkRatio, 3) +
      '，菜单 ' + num(m.menuInk) + ' 个）',
    '- 分享图内容像素 ' + num(m.cardInkPixels) + '（占 ' + pct(m.cardInkRatio, 2) + '）',
    '- 机器人在浏览器里 高度 ' + m.botScore + ' · 跳跃 ' + m.botJumps,
    '- 采样颜色数 ' + num(m.menuColors) + ' → ' + num(m.playColors) + '（仅参考，不承重）',
  ].join('\n') + '\n';
}

let failed = false;
let passedCount = 0;
let totalCount = 0;
const sections = [];
const allFailures = [];
let unitTail = null;

for (const gate of GATES){
  const file = findFile(gate.file);
  const data = file ? readJson(file) : null;
  if (!data){
    failed = true;
    sections.push(missingSection(gate));
    continue;
  }
  const fails = (data.failures || []).filter(Boolean);
  if (fails.length) failed = true;
  passedCount += data.passed;
  totalCount += data.total;
  if (data.passed !== data.total) failed = true;
  sections.push(gate.slug === 'eng' ? engSection(data) : webSection(data));
  for (const f of fails) allFailures.push(gate.label + ' · ' + f);
  if (data.unitTail) unitTail = data.unitTail;
}

if (allFailures.length){
  sections.push(['### 失败项', '', ...allFailures.map(f => '- ' + f), ''].join('\n'));
}
// 子进程挂了就得把它的输出摘要带上。只写「失败 1 项」的报告等于没有报告。
if (unitTail){
  sections.push(fold('单元测试输出末尾', tail(unitTail).slice(-3000)) + '\n');
}

const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
const repo = process.env.GITHUB_REPOSITORY || '';
const runId = process.env.GITHUB_RUN_ID || '';
const sha = (process.env.GITHUB_SHA || 'local').slice(0, 7);
const runLink = runId ? ' · [完整日志](' + server + '/' + repo + '/actions/runs/' + runId + ')' : '';
const header = (failed ? '## 验证闸门有失败' : '## 验证闸门全部通过') +
               '\n\n' + passedCount + '/' + totalCount + ' 项通过 · 提交 `' + sha + '`' + runLink;
const body = [header, '', ...sections].join('\n');

if (checkOnly){
  process.stdout.write((failed ? 'FAILED' : 'PASSED') + ': ' + passedCount + '/' + totalCount + ' 项\n');
  process.exit(failed ? 1 : 0);
}

fs.writeFileSync('comment.md', body.slice(0, 60000));
process.stdout.write(body + '\n');
