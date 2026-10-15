// capture-client：把 Rust 的 `capture` 节点当一次性子进程驱动。
//
// `capture` 是「读一行配置 → 输出一帧 → EOF 退出」的节点，所以写完后关掉
// stdin 让它收尾。
//
// 为什么是一次性进程而不是常驻的 `loop_capture`：面板的流程是**顺序驱动**的
// ——截一张 → 交给模型 → 等回复 → 再截下一张。常驻循环按固定间隔产帧，模型
// 还在思考时那些帧没人看，纯属浪费（也让人误以为在「无限循环」）。
// 每次起一个进程约几十毫秒，换来的节奏正确性完全值得。

import { spawn } from 'node:child_process';

/**
 * 截一帧。
 * @param {{binPath: string, region?: {x:number,y:number,width:number,height:number}, timeoutMs?: number}} opts
 * @returns {Promise<{pngB64: string, width: number, height: number, x: number, y: number}>}
 */
export function captureOnce({ binPath, region, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, ['capture'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let out = '';
    let err = '';
    let settled = false;

    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve(value);
      else reject(value);
    };

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      finish(false, new Error(`截帧超时（${timeoutMs}ms）`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      out += d;
    });
    proc.stderr.on('data', (d) => {
      err += d;
    });
    proc.on('error', (e) => finish(false, new Error(String(e.message || e))));
    proc.on('exit', (code) => {
      const line = out.split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
      if (!line) {
        const last = err.trim().split(/\r?\n/).filter(Boolean).pop();
        finish(false, new Error(last || `capture 异常退出（码 ${code ?? 'null'}）且无输出`));
        return;
      }
      let env;
      try {
        env = JSON.parse(line);
      } catch {
        finish(false, new Error('capture 输出不是合法 JSON'));
        return;
      }
      if (env.type === 'error') {
        finish(false, new Error(String(env.payload)));
        return;
      }
      if (env.type !== 'frame' || !env.payload) {
        finish(false, new Error(`capture 未返回帧（type=${env.type}）`));
        return;
      }
      finish(true, env.payload);
    });

    const payload = region ? { region } : {};
    proc.stdin.end(JSON.stringify({ type: 'frame', seq: 0, payload }) + '\n');
  });
}