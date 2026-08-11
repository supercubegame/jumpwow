/* ===========================================================================
 * 排行榜 API
 * ===========================================================================
 *
 * 零依赖。存储就是一个 JSON 文件,这个量级不需要数据库，加了反而是负担。
 *
 * 核心设计：**不接受客户端上报的分数。** 提交的是「种子 + 输入日志」，
 * 服务端用同一份引擎重放，以重放结果为准。见 src/replay.js 的说明。
 *
 * 接口：
 *   GET  /api/scores?limit=20   取榜
 *   POST /api/scores            提交 { name, seed, log }
 *   GET  /api/health            存活检查
 * =========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { replay, MAX_LOG_CHARS } from '../src/replay.js';

const DATA_FILE = process.env.SCORES_FILE || path.resolve('data/scores.json');
const MAX_ENTRIES = 500;          // 落盘上限，超出丢弃末尾
const TOP_DEFAULT = 20;
const MAX_BODY = 64 * 1024;

/* --- 限流：每个 IP 每小时 30 次提交。内存态，重启即清,够用了 --- */
const RATE = new Map();
const RATE_WINDOW = 3600_000;
const RATE_MAX = 30;

function rateOk(ip){
  const now = Date.now();
  const hits = (RATE.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  if (hits.length >= RATE_MAX){ RATE.set(ip, hits); return false; }
  hits.push(now);
  RATE.set(ip, hits);
  return true;
}

/* --- 存储 --- */
function load(){
  try{
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  }catch{
    return [];
  }
}

function save(list){
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  // 先写临时文件再改名，避免进程被杀时留下半个文件
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/** 名字消毒：去控制字符、压空白、限长。空名字给个默认。 */
function cleanName(raw){
  let n = String(raw == null ? '' : raw)
    .replace(/[-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return n || '匿名跳跃者';
}

function json(res, code, body){
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(s);
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY){ reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function topScores(limit = TOP_DEFAULT){
  return load()
    .slice()
    .sort((a, b) => b.score - a.score || a.at - b.at)   // 同分先到先得
    .slice(0, Math.max(1, Math.min(100, limit)));
}

/**
 * 处理 /api/* 请求。
 * @returns {Promise<boolean>} true 表示已处理，调用方不用再管
 */
export async function handleApi(req, res){
  let url;
  try{ url = new URL(req.url, 'http://localhost'); }
  catch{ return false; }
  if (!url.pathname.startsWith('/api/')) return false;

  if (req.method === 'OPTIONS'){ json(res, 204, {}); return true; }

  if (url.pathname === '/api/health'){
    json(res, 200, { ok: true, entries: load().length });
    return true;
  }

  if (url.pathname === '/api/scores' && req.method === 'GET'){
    const limit = Number(url.searchParams.get('limit')) || TOP_DEFAULT;
    json(res, 200, { scores: topScores(limit) });
    return true;
  }

  if (url.pathname === '/api/scores' && req.method === 'POST'){
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
            || req.socket.remoteAddress || 'unknown';
    if (!rateOk(ip)){ json(res, 429, { error: '提交太频繁，歇一会儿' }); return true; }

    let body;
    try{ body = JSON.parse(await readBody(req)); }
    catch(e){ json(res, 400, { error: '请求体不是合法 JSON' }); return true; }

    const seed = Number(body && body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff){
      json(res, 400, { error: '种子非法' }); return true;
    }
    if (typeof body.log !== 'string' || body.log.length > MAX_LOG_CHARS){
      json(res, 400, { error: '输入日志缺失或过长' }); return true;
    }

    // 这里是整套设计的核心：以重放结果为准，客户端报的分数一律忽略。
    let result;
    try{ result = replay(seed, body.log); }
    catch(e){ json(res, 400, { error: '日志无法重放：' + e.message }); return true; }

    if (result.alive){
      json(res, 400, { error: '这局还没结束,重放到最后玩家还活着' }); return true;
    }
    if (result.score <= 0){
      json(res, 400, { error: '零分就别上榜了' }); return true;
    }

    const entry = {
      name: cleanName(body.name),
      score: result.score,          // 权威值来自重放
      seed: result.seed,
      ticks: result.ticks,
      jumps: result.jumps,
      seconds: result.seconds,
      at: Date.now(),
    };

    const list = load();
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.at - b.at);
    save(list.slice(0, MAX_ENTRIES));

    const rank = list.findIndex(e => e === entry) + 1;
    json(res, 201, { ok: true, entry, rank, verified: true });
    return true;
  }

  json(res, 404, { error: '没有这个接口' });
  return true;
}
