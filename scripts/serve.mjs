// 静态服务器 + 排行榜 API。verify 脚本内嵌调用，也可以独立跑起来预览。
//
//   node scripts/serve.mjs            默认 8000
//   PORT=3000 node scripts/serve.mjs

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleApi } from '../server/api.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

/**
 * 把任意前缀下的 /api/* 都归一到 /api/*。
 *
 * 页面本身在 /web/index.html，而它必须用**相对路径**请求 API,
 * 因为 GitHub Pages 会把站点挂在 /jumpwow/ 这种子路径下，写死的绝对路径
 * 会打到域名根上去。相对路径解析出来是 /web/api/scores，所以服务器这边
 * 得认这个形状。
 *
 * 与其让客户端去猜自己挂在第几层，不如让服务器宽容一点。
 *
 *   /api/scores          → /api/scores
 *   /web/api/scores      → /api/scores
 *   /jumpwow/web/api/... → /api/...
 */
function normalizeApiPath(req){
  let u;
  try{ u = new URL(req.url, 'http://localhost'); }
  catch{ return false; }

  const i = u.pathname.indexOf('/api/');
  if (i < 0) return false;

  req.url = u.pathname.slice(i) + u.search;
  return true;
}

export function startServer(port = 0, root = process.cwd()){
  const ROOT = path.resolve(root);

  const server = http.createServer(async (req, res) => {
    try{
      if (normalizeApiPath(req) && await handleApi(req, res)) return;
    }catch(e){
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
      return;
    }

    let rel;
    try{
      rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    }catch{
      res.writeHead(400).end('bad request'); return;
    }
    if (rel === '/') rel = '/web/index.html';
    if (rel.endsWith('/')) rel += 'index.html';

    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT)){ res.writeHead(403).end('forbidden'); return; }

    try{
      const body = await fs.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    }catch{
      res.writeHead(404).end('not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        server, port: p, url: 'http://127.0.0.1:' + p,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  const s = await startServer(Number(process.env.PORT || 8000));
  console.log('serving ' + process.cwd() + '\n  → ' + s.url + '/web/index.html');
}
