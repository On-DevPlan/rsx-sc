// capture service：调用 rust-binary / capture-session / llm-client。
import { resolveBinary, isSupported } from '../../core/rust-binary.js';
import {
  createSession,
  listSessions,
  stopSession,
} from '../../core/capture-session.js';
import {
  chatCompletionStream,
  buildVisionMessages,
} from '../../core/llm-client.js';
import { readSettings } from '../../core/settings-store.js';
import { runSelection } from '../../core/select-client.js';
import { badInput, external } from '../../core/errors/index.js';

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
export async function start({ region, minIntervalMs, maxFrames }) {
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
  const gap = Number(minIntervalMs ?? 0);
  if (!Number.isFinite(gap) || gap < 0) {
    throw badInput(`minIntervalMs 不能为负（收到: ${minIntervalMs}）`);
  }

  // 闸门用「间接引用」拿 llm：createSession 必须先于 attachLlm 返回，而 gate
  // 首次被调用时（第一帧到手之后）llm 已经赋值。
  let llm = null;
  const session = createSession({
    region: parsed,
    minIntervalMs: gap,
    maxFrames: maxFrames ?? null,
    binPath: r.path,
    gate: () => (llm ? llm.whenIdle() : Promise.resolve(true)),
    release: () => {
      if (llm) llm.release();
    },
  });
  // 接上 LLM 观察：流式回写，并作为采集节奏的闸门。
  llm = attachLlm(session);

  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    region: parsed,
    minIntervalMs: gap,
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
 * 把 LLM 观察接到会话上：订阅 frame，把这一帧发给多模态模型，流式增量写回
 * **同一个 emitter** —— 于是 SSE / 面板 / 未来任何消费者看到的是同一条流
 * （frame / llm_start / llm_delta / llm_end / llm_error）。
 *
 * 返回的 `whenIdle()` 供采集循环当闸门用：**等这一帧的回复落地，再截下一张**。
 * 这样每一帧都配一条回复，不会产出没人看的帧。
 *
 * 之前这函数叫 bridgeToLlm 但**从未被调用**，而且把事件发到一个没人监听的
 * 独立 emitter 上 —— 表现为「帧一直刷、LLM 一次都没被调用」。现在由 start()
 * 直接调用，事件走会话自身的 emitter。
 */
export function attachLlm(session) {
  const emitter = session.emitter;
  const history = [];
  let inFlight = null;
  let settings = null;
  let closed = false;
  let lastOk = true;
  let idleResolvers = [];

  const markIdle = () => {
    inFlight = null;
    const waiters = idleResolvers;
    idleResolvers = [];
    for (const r of waiters) r();
  };

  const onFrame = (frame) => {
    if (closed || inFlight) return;
    const ctrl = new AbortController();
    // 同步置位：调用方（采集循环）紧接着就会调 whenIdle()，必须已经看到「在飞」。
    inFlight = ctrl;
    (async () => {
      try {
        // 每个会话首次用帧时才读盘：一次读、全会话复用。
        if (!settings) settings = (await readSettings()).settings;
        const maxHistory = Math.max(1, settings.maxHistoryTurns || 10);
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

        emitter.emit('llm_start', { seq: frame.seq, capturedAtMs: frame.capturedAtMs });
        const out = await chatCompletionStream({
          apiBase: settings.apiBase,
          apiKey: settings.apiKey,
          model: settings.model,
          messages,
          signal: ctrl.signal,
          temperature: settings.temperature,
          onDelta: (text) => emitter.emit('llm_delta', { seq: frame.seq, text }),
        });

        history.push({ role: 'user', content: settings.promptTemplate });
        history.push({ role: 'assistant', content: out.content });
        if (history.length > maxHistory * 2) {
          history.splice(0, history.length - maxHistory * 2);
        }
        lastOk = true;
        emitter.emit('llm_end', { seq: frame.seq, content: out.content });
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 被取消，不算失败
        lastOk = false;
        emitter.emit('llm_error', {
          seq: frame.seq,
          error: String(e && (e.message || e)),
          code: e && e.code,
        });
      } finally {
        markIdle();
      }
    })();
  };

  emitter.on('frame', onFrame);
  emitter.on('end', (info) => {
    closed = true;
    // 正常跑完（达到 max_frames）**不算取消**：让在飞的调用跑完并把回复发出去。
    // 只有被 kill / 启动失败才掐断。
    const normal = info && info.reason === 'complete';
    if (inFlight && !normal) inFlight.abort();
  });

  return {
    /**
     * 等当前在飞的调用结束（没有在飞就立即返回）。
     * @returns {Promise<boolean>} 这一轮是否成功 —— 采集循环据此决定要不要退避。
     */
    async whenIdle() {
      if (inFlight) await new Promise((r) => idleResolvers.push(r));
      return lastOk;
    },
    /** 停止会话时用：掐断在飞的调用，让 whenIdle 立刻解开，不必等模型返回。 */
    release() {
      if (inFlight) inFlight.abort();
    },
  };
}