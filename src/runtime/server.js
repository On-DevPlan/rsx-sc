// Web 服务器：node:http 零依赖。
// 职责只有两件事：发静态面板文件 + 把 /api/* 交给路由层（见 api.js）。
import http from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { handleApi, sendJson } from './api.js';
import { handleCaptureStream } from '../core/capture-stream.js';
import { DEFAULT_PORT } from '../core/paths.js';

// vite 的 outDir：src/web/public（构建产物，gitignore）
const PUBLIC_DIR = resolve(fileURLToPath(new URL('../web/public/', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = resolve(PUBLIC_DIR, rel);

  // 越界校验：解析成绝对路径后必须仍落在 PUBLIC_DIR 内。
  // 比对解析结果，而不是剥离 '..' 字面量——后者挡不住编码变形。
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

export function startServer({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      // SSE bypass：/api/capture/stream/* 是长连接 + 服务端推送，不走 action
      // dispatcher；必须先于 /api/* 分支拦截。
      if (url.pathname.startsWith('/api/capture/stream/')) {
        return handleCaptureStream(req, res, url);
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      await serveStatic(url.pathname, res);
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: String((err && err.message) || err),
        code: 'INTERNAL',
      });
    }
  });
  return new Promise((resolve_, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve_(server));
  });
}
