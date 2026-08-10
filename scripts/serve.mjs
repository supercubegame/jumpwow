// 极简静态服务器。verify-web 内嵌调用，也可以独立跑起来预览。
//
//   node scripts/serve.mjs            默认 8000
//   PORT=3000 node scripts/serve.mjs

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

export function startServer(port = 0, root = process.cwd()){
  const ROOT = path.resolve(root);

  const server = http.createServer(async (req, res) => {
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
