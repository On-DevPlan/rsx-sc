// capture-stream：SSE handler，把 capture-session 的事件流转换成
// text/event-stream 响应。
//
// 与 action dispatcher 解耦：SSE 是长连接 + 服务端推送，与 run() 返回一个
// 可序列化值的契约不符。专门一条路径处理。

import { listSessions, subscribe } from './capture-session.js';

const HEARTBEAT_MS = 15000;

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
export function handleCaptureStream(req, res, url) {
  const m = url.pathname.match(/^\/api\/capture\/stream\/([^/]+)$/);
  if (!m) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'invalid stream path', code: 'NOT_FOUND' }));
    return;
  }
  const sessionId = decodeURIComponent(m[1]);

  // Session existence check BEFORE opening the stream — return a JSON 404 if
  // not found, so the client can `EventSource.onerror` tell apart "bad id"
  // from "transient disconnect".
  const exists = listSessions().some((s) => s.sessionId === sessionId);
  if (!exists) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: `session 不存在: ${sessionId}`, code: 'NOT_FOUND' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // Initial padding event so proxies flush headers immediately.
  res.write(': open\n\n');

  const unsubscribe = subscribe(sessionId, (msg) => {
    if (!msg) return;
    try {
      // error 的 payload 是字符串，单独包一层；其余都是对象，原样展开。
      if (msg.type === 'error') {
        res.write(`data: ${JSON.stringify({ type: 'error', message: String(msg.payload) })}\n\n`);
        return;
      }
      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      res.write(`data: ${JSON.stringify({ type: msg.type, ...payload })}\n\n`);
    } catch {
      // Connection closed mid-write — handled by req.close below.
    }
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {}
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {}
    }
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
}