// capture-session：进程内的采集会话注册表 + **顺序驱动**的采集循环。
//
// 每一轮的顺序是：截一张 → 发 frame 事件 → 等闸门（gate，即 LLM 回复落地）
// → 再截下一张。
//
// 为什么不是「按间隔产帧」：那个模型下，模型还在思考时到达的帧没人消费，既浪费
// 又让界面看起来像在无限刷屏。顺序驱动让节奏由模型决定，每一帧都必然配一条回复。
// `minIntervalMs` 只作为**两轮之间的最小间隔**兜底；模型报错时会退避更久，
// 避免配置错误时打成紧密循环。

import { EventEmitter } from 'node:events';
import { captureOnce } from './capture-client.js';
import { newSessionId } from './ids.js';
import { notFound } from './errors/index.js';

// 上一轮 LLM 失败后的最小退避：模型配错（key 无效等）时不要以截帧速度空转。
const LLM_ERROR_BACKOFF_MS = 2000;
// 会话结束后仍留一段，让晚到的 SSE 订阅者/收尾事件能被读到。
const RETAIN_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {Object} SessionEntry
 * @property {string} sessionId
 * @property {number} startedAt
 * @property {{x:number,y:number,width:number,height:number}} region  虚拟桌面绝对坐标
 * @property {number} minIntervalMs
 * @property {number|null} maxFrames
 * @property {string} binPath
 * @property {EventEmitter} emitter
 * @property {boolean} stopped
 * @property {{frames:number, dropped:number, lastError:string|null, ended:boolean}} stats
 */

/** @type {Map<string, SessionEntry>} */
const SESSIONS = new Map();

/**
 * 起一个顺序采集会话。
 * @param {{
 *   region: {x:number,y:number,width:number,height:number},
 *   minIntervalMs?: number,
 *   maxFrames?: number|null,
 *   binPath: string,
 *   gate?: () => Promise<boolean|void>,
 *   release?: () => void,
 * }} opts
 * @returns {SessionEntry}
 */
export function createSession(opts) {
  const sessionId = newSessionId();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  /** @type {SessionEntry} */
  const entry = {
    sessionId,
    startedAt: Date.now(),
    region: opts.region,
    minIntervalMs: Math.max(0, opts.minIntervalMs ?? 0),
    maxFrames: opts.maxFrames ?? null,
    binPath: opts.binPath,
    emitter,
    gate: typeof opts.gate === 'function' ? opts.gate : null,
    release: typeof opts.release === 'function' ? opts.release : null,
    stopped: false,
    stats: { frames: 0, dropped: 0, lastError: null, ended: false },
  };

  SESSIONS.set(sessionId, entry);
  void runRounds(entry);
  return entry;
}

/** 顺序采集主循环。 */
async function runRounds(entry) {
  const max = entry.maxFrames ?? Infinity;
  let seq = 0;
  try {
    while (!entry.stopped && seq < max) {
      const roundStart = Date.now();

      const frame = await captureOnce({ binPath: entry.binPath, region: entry.region });
      if (entry.stopped) break;

      entry.stats.frames = seq + 1;
      entry.emitter.emit('frame', {
        seq,
        capturedAtMs: Date.now(),
        width: frame.width,
        height: frame.height,
        pngB64: frame.pngB64,
      });
      seq += 1;

      // 闸门：等这一帧的 LLM 回复落地（含流式结束）再截下一张。
      // gate 返回 false 表示这一轮失败 → 走退避。
      let ok = true;
      if (entry.gate) {
        ok = (await entry.gate()) !== false;
      }
      if (entry.stopped) break;

      const floor = ok ? entry.minIntervalMs : Math.max(entry.minIntervalMs, LLM_ERROR_BACKOFF_MS);
      const wait = floor - (Date.now() - roundStart);
      if (wait > 0) await sleep(wait);
    }
  } catch (e) {
    entry.stats.lastError = String((e && e.message) || e);
    entry.emitter.emit('error', entry.stats.lastError);
  } finally {
    finish(entry, entry.stopped ? 'killed' : 'complete');
  }
}

function finish(entry, reason) {
  if (entry.stats.ended) return;
  entry.stats.ended = true;
  const payload = { frames: entry.stats.frames, dropped: entry.stats.dropped };
  entry.emitter.emit('complete', payload);
  entry.emitter.emit('end', { reason, ...payload });
  setTimeout(() => {
    if (SESSIONS.get(entry.sessionId) === entry) SESSIONS.delete(entry.sessionId);
  }, RETAIN_MS).unref?.();
}

/** Snapshot of all sessions for the API. */
export function listSessions() {
  const out = [];
  for (const e of SESSIONS.values()) {
    out.push({
      sessionId: e.sessionId,
      startedAt: e.startedAt,
      region: e.region,
      minIntervalMs: e.minIntervalMs,
      maxFrames: e.maxFrames,
      binPath: e.binPath,
      status: e.stats.ended ? 'ended' : 'running',
      frames: e.stats.frames,
      dropped: e.stats.dropped,
      lastError: e.stats.lastError,
    });
  }
  return out;
}

/**
 * 停止会话。会解开闸门 —— 否则卡在「等模型回复」时，停止要等模型返回才生效。
 * @param {string} sessionId
 */
export function stopSession(sessionId) {
  const entry = SESSIONS.get(sessionId);
  if (!entry) {
    throw notFound(`session 不存在: ${sessionId}`);
  }
  entry.stopped = true;
  if (entry.release) {
    try {
      entry.release();
    } catch {}
  }
  return {
    sessionId,
    frames: entry.stats.frames,
    dropped: entry.stats.dropped,
    stoppedAt: Date.now(),
  };
}

// 对订阅者透传的事件类型。集中一份：新增类型只改这里，不散落在 on/off 两处。
const FORWARDED = [
  'frame',
  'status',
  'complete',
  'end',
  'error',
  'llm_start',
  'llm_delta',
  'llm_end',
  'llm_error',
];

/**
 * Subscribe to a session's event stream. Each callback gets one event.
 * Returns an unsubscribe function.
 * @param {string} sessionId
 * @param {(msg: {type: string, payload?: any}) => void} onMsg
 */
export function subscribe(sessionId, onMsg) {
  const entry = SESSIONS.get(sessionId);
  if (!entry) {
    throw notFound(`session 不存在: ${sessionId}`);
  }
  const bound = FORWARDED.map((type) => {
    const handler = (payload) => onMsg({ type, payload });
    entry.emitter.on(type, handler);
    return [type, handler];
  });
  return () => {
    for (const [type, handler] of bound) {
      entry.emitter.off(type, handler);
    }
  };
}