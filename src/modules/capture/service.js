// capture service：调用 rust-binary / capture-session / llm-client。
import { resolveBinary, isSupported } from '../../core/rust-binary.js';
import {
  createSession,
  listSessions,
  stopSession,
  subscribe,
} from '../../core/capture-session.js';
import {
  chatCompletion,
  buildVisionMessages,
} from '../../core/llm-client.js';
import { readSettings } from '../../core/settings-store.js';
import { runSelection } from '../../core/select-client.js';
import { badInput, external } from '../../core/errors/index.js';

const MIN_INTERVAL_MS = 50;

/**
 * Resolve the rust binary path. Returns a structured object even on failure
 * so the UI can render a clear message instead of a thrown NxError.
 */
export async function bin() {
  const r = resolveBinary();
  const platform = process.platform;
  const arch = process.arch;
  const supported = isSupported(platform, arch);
  if (!supported) {
    return {
      supported: false,
      reason: `v1 不支持 ${platform}/${arch}`,
      platform,
      arch,
    };
  }
  if (!r) {
    return {
      supported: true,
      found: false,
      reason: `未找到 ${platform}/${arch} 的 rsx-sc-rust 二进制。请先 cargo build --release 并复制到 binaries/<key>/`,
      platform,
      arch,
    };
  }
  return {
    supported: true,
    found: true,
    path: r.path,
    source: r.source,
    platform: r.platform,
    arch: r.arch,
    key: r.key,
  };
}

/**
 * Start a session. Validates inputs, resolves the binary, creates the
 * session, returns its id.
 *
 * @param {{region: string, intervalMs: number, maxFrames?: number|null}} opts
 * @returns {Promise<{sessionId: string, startedAt: number, region: object, intervalMs: number, maxFrames: number|null}>}
 */
export async function start({ region, intervalMs, maxFrames }) {
  const r = resolveBinary();
  if (!r) {
    if (!isSupported(process.platform, process.arch)) {
      throw external(`v1 不支持 ${process.platform}/${process.arch}（仅 Windows x64 与 Linux x64）`);
    }
    throw external('未找到 rsx-sc-rust 二进制。请先 cargo build --release');
  }

  const parsed = parseRegion(region);
  if (!parsed) {
    throw badInput(
      `region 格式应为 "x,y,w,h"（整数；x/y 可为负，w/h 必须为正），收到: ${region}`
    );
  }
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MS) {
    throw badInput(`intervalMs 必须 ≥ ${MIN_INTERVAL_MS}（收到: ${intervalMs}）`);
  }

  const session = createSession({
    region: parsed,
    intervalMs: interval,
    maxFrames: maxFrames ?? null,
    binPath: r.path,
  });

  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    region: parsed,
    intervalMs: interval,
    maxFrames: maxFrames ?? null,
  };
}

/**
 * 弹出原生全屏框选蒙版，阻塞到用户完成或取消。
 * 交互时长不可预知：HTTP 调用方（面板）要传足够大的 timeoutMs；CLI 无超时。
 * 服务端 5 分钟兜底：超时杀掉蒙版进程，不让全屏遮罩永远挂着。
 *
 * 返回的 region 是**虚拟桌面绝对坐标**，可跨屏，可直接喂给 start()。
 */
export async function select() {
  const r = resolveBinary();
  if (!r) {
    if (!isSupported(process.platform, process.arch)) {
      throw external(`v1 不支持 ${process.platform}/${process.arch}（仅 Windows x64 与 Linux x64）`);
    }
    throw external('未找到 rsx-sc-rust 二进制。请先 cargo build --release');
  }
  const out = await runSelection({ binPath: r.path, timeoutMs: 5 * 60_000 });
  switch (out.status) {
    case 'cancelled':
      return { status: 'cancelled' };
    case 'timeout':
      throw external('框选超时（5 分钟未操作，蒙版已自动关闭）');
    case 'error':
      throw external(`框选失败: ${out.message}`);
    default: {
      const { region } = out;
      if (region.width === 0 || region.height === 0) {
        throw badInput(`框选区域宽高为零: ${JSON.stringify(region)}`);
      }
      return { status: 'ok', region };
    }
  }
}

export async function stop({ sessionId }) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw badInput('sessionId 必填');
  }
  return stopSession(sessionId);
}

export async function list() {
  const sessions = listSessions();
  return { count: sessions.length, sessions };
}

function parseRegion(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 4 || !parts.every((n) => Number.isInteger(n))) return null;
  const [x, y, width, height] = parts;
  // x/y 是虚拟桌面绝对坐标，副屏在主屏左边/上边时为负——不能像以前那样
  // 卡非负，否则多显示器下左侧那块屏的选区直接被拒。
  // 宽高必须为正，否则是无意义选区。
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Run a single frame through the LLM with the current settings + history.
 * Returns the assistant content (string). Errors propagate as NxError.
 *
 * @param {{sessionId: string, frame: {seq:number, capturedAtMs:number, pngB64:string, width:number, height:number}, history: Array<{role:'user'|'assistant', content:string}>}} opts
 */
export async function describeFrame({ frame, history }) {
  const settings = (await readSettings()).settings;
  const messages = buildVisionMessages({
    promptTemplate: settings.promptTemplate,
    history,
    framePngB64: frame.pngB64,
    frameMeta: {
      seq: frame.seq,
      capturedAtMs: frame.capturedAtMs,
      width: frame.width,
      height: frame.height,
    },
    isFirstRound: history.length === 0,
  });
  const out = await chatCompletion({
    apiBase: settings.apiBase,
    apiKey: settings.apiKey,
    model: settings.model,
    messages,
    temperature: settings.temperature,
  });
  return out.content;
}

/**
 * Subscribe to a session's frame stream; for each frame, dispatch an LLM
 * call (one-in-flight) and emit both frame + llm events into a single
 * emitter the SSE / view consumer can use.
 *
 * One-in-flight: while a call is pending, incoming frames drop the LLM
 * trigger (they still stream to the UI). Calls use AbortController so on
 * session stop the in-flight call is cancelled.
 *
 * @param {string} sessionId
 * @param {EventEmitter} outEmitter
 * @returns {Promise<{unsubscribe: () => void}>}
 */
export async function bridgeToLlm(sessionId, outEmitter) {
  const settings = (await readSettings()).settings;
  let inFlight = null;
  const history = [];
  const maxHistory = Math.max(1, settings.maxHistoryTurns || 10);

  const unsub = subscribe(sessionId, async (msg) => {
    if (msg.type === 'frame') {
      const frame = msg.payload;
      outEmitter.emit('frame', frame);
      if (inFlight) {
        outEmitter.emit('skip', { seq: frame.seq });
        return;
      }
      const ctrl = new AbortController();
      inFlight = ctrl;
      (async () => {
        try {
          const messages = buildVisionMessages({
            promptTemplate: settings.promptTemplate,
            history: history.slice(-maxHistory * 2),
            framePngB64: frame.pngB64,
            frameMeta: {
              seq: frame.seq,
              capturedAtMs: frame.capturedAtMs,
              width: frame.width,
              height: frame.height,
            },
            isFirstRound: history.length === 0,
          });
          const out = await chatCompletion({
            apiBase: settings.apiBase,
            apiKey: settings.apiKey,
            model: settings.model,
            messages,
            signal: ctrl.signal,
            temperature: settings.temperature,
          });
          const assistantText = out.content;
          history.push({ role: 'user', content: settings.promptTemplate });
          history.push({ role: 'assistant', content: assistantText });
          if (history.length > maxHistory * 2) {
            history.splice(0, history.length - maxHistory * 2);
          }
          outEmitter.emit('llm', {
            seq: frame.seq,
            content: assistantText,
            capturedAtMs: frame.capturedAtMs,
          });
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          outEmitter.emit('llm_error', { seq: frame.seq, error: String(e?.message || e), code: e?.code });
        } finally {
          inFlight = null;
        }
      })();
    } else if (msg.type === 'status') {
      outEmitter.emit('status', msg.payload);
    } else if (msg.type === 'complete') {
      outEmitter.emit('complete', msg.payload);
    } else if (msg.type === 'end') {
      outEmitter.emit('end', msg.payload);
      if (inFlight) inFlight.abort();
    } else if (msg.type === 'error') {
      outEmitter.emit('error', msg.payload);
    }
  });

  return {
    unsubscribe: () => {
      unsub();
      if (inFlight) inFlight.abort();
    },
  };
}