// capture-client：把 Rust 二进制当作 JSONL 子进程来驱动的薄壳。
//
// 生命周期：
//   1. spawn `rsx-sc-rust loop_capture`
//   2. 把 LoopCaptureInput 作为一帧 envelope 写到 stdin（之后不再写）
//   3. 从 stdout 按行读 JSONL 解析 Envelope；EventEmitter 上发出 'envelope'
//   4. 用户调用 requestStop → proc.kill()；Rust 侧 SIGTERM（Unix）/ 直接终止（Windows）
//   5. 进程退出；emit 'exit' 事件

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

/**
 * Spawn a capture loop subprocess.
 * @param {{binPath: string}} opts
 * @returns {{
 *   proc: import('node:child_process').ChildProcess,
 *   events: EventEmitter,           // emits 'envelope' (parsed) and 'exit' ({code, signal, errorFrame?})
 *   sendConfig: (input: object) => Promise<void>,
 *   requestStop: () => void,
 *   waitForExit: () => Promise<{code: number|null, signal: string|null}>,
 * }}
 */
export function spawnCapture({ binPath }) {
  const proc = spawn(binPath, ['loop_capture'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const events = new EventEmitter();
  let stdinClosed = false;

  proc.stderr.on('data', (chunk) => {
    // Mirror stderr to the host process stderr with a prefix so users can
    // see Rust lifecycle messages without parsing our JSONL stream.
    const prefix = '[rsx-sc-rust] ';
    process.stderr.write(prefix);
    process.stderr.write(chunk);
  });

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let env;
    try {
      env = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[capture-client] malformed JSONL line: ${trimmed}\n`);
      return;
    }
    events.emit('envelope', env);
  });

  proc.on('exit', (code, signal) => {
    if (!stdinClosed) {
      try {
        proc.stdin.end();
      } catch {}
      stdinClosed = true;
    }
    events.emit('exit', { code, signal });
  });

  proc.on('error', (err) => {
    events.emit('exit', { code: null, signal: null, error: err });
  });

  return {
    proc,
    events,
    sendConfig: async (input) => {
      const env = { type: 'frame', seq: 0, payload: input };
      const json = JSON.stringify(env) + '\n';
      // Use a Promise that resolves when the write completes; this lets the
      // caller know the binary has accepted the config.
      await new Promise((resolve, reject) => {
        proc.stdin.write(json, (err) => (err ? reject(err) : resolve()));
      });
    },
    requestStop: () => {
      // SIGTERM on Unix; on Windows, proc.kill() defaults to SIGTERM-equivalent
      // (terminates the process). Rust side does not get a signal handler on
      // Windows — the runtime just drops.
      try {
        proc.kill('SIGTERM');
      } catch {
        try {
          proc.kill();
        } catch {}
      }
    },
    waitForExit: () =>
      new Promise((resolve) => {
        const onExit = (info) => {
          events.off('exit', onExit);
          resolve({ code: info.code, signal: info.signal });
        };
        events.on('exit', onExit);
      }),
  };
}