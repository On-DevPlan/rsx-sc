// capture-session：进程内的 capture 会话注册表。
//
// 每个 `createSession` 启动一个 Rust 子进程，把 stdout 上的 envelope 转成
// per-session EventEmitter 上的事件。SSE handler 与 capture service 都
// 通过本模块订阅事件流。

import { EventEmitter } from 'node:events';
import { spawnCapture } from './capture-client.js';
import { newSessionId } from './ids.js';
import { notFound } from './errors/index.js';

/**
 * @typedef {Object} SessionEntry
 * @property {string} sessionId
 * @property {number} startedAt              epoch ms
 * @property {{x:number,y:number,width:number,height:number}} region
 * @property {number} intervalMs
 * @property {number|null} maxFrames          null means ∞
 * @property {string} binPath
 * @property {ReturnType<typeof spawnCapture>} client
 * @property {EventEmitter} emitter
 * @property {{frames: number, dropped: number, lastError: string|null, ended: boolean}} stats
 */

/** @type {Map<string, SessionEntry>} */
const SESSIONS = new Map();

/**
 * Start a new capture session.
 * @param {{region: {x:number,y:number,width:number,height:number}, intervalMs: number, maxFrames?: number|null, binPath: string, monitor?: number|null}} opts
 * @returns {SessionEntry}
 */
export function createSession(opts) {
  const sessionId = newSessionId();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  const client = spawnCapture({ binPath: opts.binPath });

  /** @type {SessionEntry} */
  const entry = {
    sessionId,
    startedAt: Date.now(),
    region: opts.region,
    intervalMs: opts.intervalMs,
    maxFrames: opts.maxFrames ?? null,
    monitor: opts.monitor ?? null,
    binPath: opts.binPath,
    client,
    emitter,
    stats: { frames: 0, dropped: 0, lastError: null, ended: false },
  };

  // Forward each rust envelope to the per-session emitter after translating
  // it into the shape the UI / SSE consumer expects.
  client.events.on('envelope', (env) => {
    if (!env || typeof env !== 'object') return;
    if (env.type === 'frame' && env.payload) {
      entry.stats.frames = (env.payload.seq ?? 0) + 1;
      emitter.emit('frame', env.payload);
    } else if (env.type === 'event' && env.payload && env.payload.type === 'status') {
      entry.stats.frames = env.payload.frames_emitted ?? entry.stats.frames;
      entry.stats.dropped = env.payload.dropped_total ?? entry.stats.dropped;
      emitter.emit('status', env.payload);
    } else if (env.type === 'event' && env.payload && env.payload.type === 'loop_complete') {
      entry.stats.frames = env.payload.frames ?? entry.stats.frames;
      entry.stats.dropped = env.payload.dropped ?? entry.stats.dropped;
      emitter.emit('complete', env.payload);
    } else if (env.type === 'error') {
      entry.stats.lastError = String(env.payload ?? 'unknown');
      emitter.emit('error', entry.stats.lastError);
    }
  });

  client.events.on('exit', ({ code, signal, error }) => {
    entry.stats.ended = true;
    emitter.emit('end', { reason: error ? 'spawn_error' : code === 0 ? 'complete' : 'killed', code, signal });
    // 30s 宽限后清理（让晚到订阅者拿到 end 事件）
    setTimeout(() => {
      if (SESSIONS.get(sessionId) === entry) SESSIONS.delete(sessionId);
    }, 30000).unref?.();
  });

  // Fire-and-forget: send the config envelope. If this rejects we mark the
  // session as errored but keep it in the map so the caller can read the error.
  client
    .sendConfig({
      region: opts.region,
      intervalMs: opts.intervalMs,
      maxFrames: opts.maxFrames ?? undefined,
      monitor: opts.monitor ?? undefined,
    })
    .catch((err) => {
      entry.stats.lastError = String(err?.message || err);
      emitter.emit('error', entry.stats.lastError);
      try {
        client.requestStop();
      } catch {}
    });

  SESSIONS.set(sessionId, entry);
  return entry;
}

/** Snapshot of all sessions for the API. */
export function listSessions() {
  const out = [];
  for (const e of SESSIONS.values()) {
    out.push({
      sessionId: e.sessionId,
      startedAt: e.startedAt,
      region: e.region,
      intervalMs: e.intervalMs,
      maxFrames: e.maxFrames,
      monitor: e.monitor,
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
 * Stop a session by id. Throws notFound if the session is unknown.
 * @param {string} sessionId
 * @returns {{sessionId: string, frames: number, dropped: number, stoppedAt: number}}
 */
export function stopSession(sessionId) {
  const entry = SESSIONS.get(sessionId);
  if (!entry) {
    throw notFound(`session 不存在: ${sessionId}`);
  }
  const stoppedAt = Date.now();
  try {
    entry.client.requestStop();
  } catch {}
  return {
    sessionId,
    frames: entry.stats.frames,
    dropped: entry.stats.dropped,
    stoppedAt,
  };
}

/**
 * Subscribe to a session's event stream. Each callback gets one event.
 * Returns an unsubscribe function.
 * @param {string} sessionId
 * @param {(msg: {type: 'frame'|'status'|'end'|'error'|'complete', payload?: any}) => void} onMsg
 */
export function subscribe(sessionId, onMsg) {
  const entry = SESSIONS.get(sessionId);
  if (!entry) {
    throw notFound(`session 不存在: ${sessionId}`);
  }
  const wrap = (type) => (payload) => onMsg({ type, payload });
  const onFrame = wrap('frame');
  const onStatus = wrap('status');
  const onEnd = wrap('end');
  const onError = wrap('error');
  const onComplete = wrap('complete');
  entry.emitter.on('frame', onFrame);
  entry.emitter.on('status', onStatus);
  entry.emitter.on('end', onEnd);
  entry.emitter.on('error', onError);
  entry.emitter.on('complete', onComplete);
  return () => {
    entry.emitter.off('frame', onFrame);
    entry.emitter.off('status', onStatus);
    entry.emitter.off('end', onEnd);
    entry.emitter.off('error', onError);
    entry.emitter.off('complete', onComplete);
  };
}