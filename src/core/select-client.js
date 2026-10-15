// select-client：驱动 Rust 的 `select` 子命令（原生全屏框选蒙版）。
//
// 与 capture-client 不同，这是一次性交互进程：spawn 后等用户在全屏蒙版上
// 拖拽（或 Esc/右键取消），进程退出时 stdout 上有一行 JSON：
//   选中   {"ok":true,"x":..,"y":..,"width":..,"height":..,"monitorIndex":N}
//   取消   {"ok":true,"cancelled":true}
//
// 错误（无显示器、创建窗口失败等）走 stderr + 非零退出码。

import { spawn } from 'node:child_process';

/**
 * @param {{binPath: string, timeoutMs?: number}} opts
 * @returns {Promise<
 *   | {status: 'ok', region: {x:number,y:number,width:number,height:number}}
 *   | {status: 'cancelled'}
 *   | {status: 'timeout'}
 *   | {status: 'error', message: string}
 * >}
 */
export function runSelection({ binPath, timeoutMs = 5 * 60_000 }) {
  return new Promise((resolve) => {
    const proc = spawn(binPath, ['select'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let out = '';
    let err = '';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    // 用户走开了 → 超时杀掉蒙版进程，别让全屏遮罩永远挂着。
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      finish({ status: 'timeout' });
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      out += d;
    });
    proc.stderr.on('data', (d) => {
      err += d;
    });
    proc.on('error', (e) => finish({ status: 'error', message: String(e.message || e) }));
    proc.on('exit', (code) => {
      const lines = out.split(/\r?\n/).filter((l) => l.startsWith('{'));
      const last = lines[lines.length - 1];
      if (!last) {
        const errLine = err.trim().split(/\r?\n/).filter(Boolean).pop();
        finish({
          status: 'error',
          message: errLine || `select 异常退出（码 ${code ?? 'null'}）且无输出`,
        });
        return;
      }
      let j;
      try {
        j = JSON.parse(last);
      } catch {
        finish({ status: 'error', message: `select 输出不是合法 JSON: ${last.slice(0, 120)}` });
        return;
      }
      if (j.cancelled) {
        finish({ status: 'cancelled' });
        return;
      }
      if (j.ok && [j.x, j.y, j.width, j.height].every((n) => typeof n === 'number')) {
        // x/y 是虚拟桌面绝对坐标（副屏在主屏左侧时为负），可跨屏。
        finish({
          status: 'ok',
          region: { x: j.x, y: j.y, width: j.width, height: j.height },
        });
        return;
      }
      finish({ status: 'error', message: `select 输出异常: ${last.slice(0, 200)}` });
    });
  });
}