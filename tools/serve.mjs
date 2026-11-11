#!/usr/bin/env node
// serve.mjs — 개발·테스트용 작은 정적 서버 (외부 라이브러리 없음)
//
// 사용법
//   node tools/serve.mjs            → http://localhost:8080/DailyEnglish/
//   node tools/serve.mjs --port 9000
//
// GitHub Pages와 똑같이 /DailyEnglish/ 하위 경로로 제공해서, 상대 경로가 맞는지 함께 확인한다.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * 정적 서버를 띄운다.
 * @param {{port?: number, base?: string, root?: string, quiet?: boolean}} [opts]
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function startServer({ port = 8080, base = '/DailyEnglish/', root = ROOT, quiet = false } = {}) {
  const server = createServer(async (req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Cache-Control': 'no-cache', ...headers });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === base.slice(0, -1)) return send(301, '', { Location: base });
      if (!pathname.startsWith(base)) return send(404, 'Not found');
      let rel = pathname.slice(base.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const file = normalize(join(root, rel));
      if (file !== root && !file.startsWith(root + sep)) return send(403, 'Forbidden');
      if (rel.split('/').some((part) => part.startsWith('.'))) return send(404, 'Not found');
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) return send(404, 'Not found');
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    } catch (e) {
      send(500, 'Server error: ' + e.message);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      const url = `http://localhost:${actual}${base}`;
      if (!quiet) console.log(`Daily English Reader 개발 서버: ${url}  (Ctrl+C 로 종료)`);
      resolve({
        url,
        port: actual,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--port');
  const port = at !== -1 ? Number(process.argv[at + 1]) : 8080;
  startServer({ port }).catch((e) => {
    console.error('오류: ' + e.message);
    process.exit(1);
  });
}
