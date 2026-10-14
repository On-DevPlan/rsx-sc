// HTTP 路由表：由 action.http 编译而来，与 CLI 同源。
//
// 这里没有手写路由 —— 每条路由都来自某个模块的 action 声明，
// 所以「面板上有按钮、CLI 里没命令」在结构上不可能发生。
import { ACTIONS } from './registry.js';
import { compileRoute, applySpec } from './spec.js';
import { toErrorPayload, httpStatusOf, CODES } from '../core/errors/index.js';

// 逐段比较两条模式，决定谁该先匹配：**字面量段优先于参数段**，段数多的优先。
//
// 为什么要排序而不是按声明顺序：`GET /api/repos/status` 与 `GET /api/repos/:id`
// 都能匹配 `/api/repos/status`，谁先声明谁赢。一旦有人调整 actions 顺序，
// 前者就会被后者抢走——这种 bug 只在运行时、且只在特定路径上出现，极难排查。
//
// 排序后，声明顺序不再影响匹配结果。
//
// 历史上的坑：只按"同位置字面量优先"判定，会让 `/api/env/status` 与
// `/api/env/:name` **平局**（都在第 3 段，a 是字面量 b 是参数，按本应字面量胜出，
// 但当数组长度正好相同时，sort 把后面声明的放前面——而 `:name` 这条通常声明在
// status 之后，于是 `/api/env/list` 落到 `:name` 上，把 `list` 当变量名去查了）。
//
// 正确比较：算"前 N 段里**字面量段**的总个数"，多者优先；同字数时
// 按"从左到右遇到的第一处分歧段"——字面量胜出。
function routeSpecificity([, pattern]) {
  return pattern.split('/').filter(Boolean);
}

function compareRoutes(a, b) {
  const pa = routeSpecificity(a.action.http);
  const pb = routeSpecificity(b.action.http);
  const litA = pa.filter((s) => !s.startsWith(':')).length;
  const litB = pb.filter((s) => !s.startsWith(':')).length;
  if (litA !== litB) return litB - litA; // 字面量段越多越具体
  if (pa.length !== pb.length) return pb.length - pa.length;
  for (let i = 0; i < pa.length; i++) {
    const litA2 = !pa[i].startsWith(':');
    const litB2 = !pb[i].startsWith(':');
    if (litA2 !== litB2) return litA2 ? -1 : 1;
  }
  return 0;
}

const ROUTES = ACTIONS.filter((a) => a.http)
  .map((action) => ({ action, route: compileRoute(action) }))
  .sort(compareRoutes);

export function sendJson(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// 跨站防护。服务虽然只绑 127.0.0.1，但用户浏览器里的任意页面都能向它发起请求——
// 少了这道校验，一个恶意网页就能 POST /api/repos/scan 或 DELETE /api/repos/:id。
// 浏览器发跨域请求必带 Origin，非浏览器客户端（curl / agent / 测试）不带，故放行。
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

export async function handleApi(req, res, url) {
  const method = (req.method || 'GET').toUpperCase();

  for (const { action, route } of ROUTES) {
    if (route.method !== method) continue;
    const m = route.regex.exec(url.pathname);
    if (!m) continue;

    if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req)) {
      sendJson(res, 403, {
        ok: false,
        error: '跨站请求被拒绝（面板仅接受本机来源）',
        code: CODES.BLOCKED,
      });
      return;
    }

    try {
      const raw = {};
      route.keys.forEach((k, i) => {
        raw[k] = decodeURIComponent(m[i + 1]);
      });
      if (method === 'GET' || method === 'HEAD') {
        for (const [k, v] of url.searchParams) raw[k] = v;
      } else {
        Object.assign(raw, await readBody(req).catch(() => ({})));
      }
      const data = await action.run(applySpec(action, raw), { transport: 'http' });
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      // 错误码 → HTTP 状态只在这一处映射（core/errors/index.js 提供表）
      const p = toErrorPayload(err);
      const payload = { ok: false, error: p.message, code: p.code };
      if (p.details !== undefined) payload.details = p.details;
      sendJson(res, httpStatusOf(p.code), payload);
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: '接口不存在: ' + method + ' ' + url.pathname });
}
