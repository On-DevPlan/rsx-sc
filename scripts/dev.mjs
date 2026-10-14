// dev 启动器：一条命令起 vite + 后端 serve，一个 ctrl-c 一起退。
//
// 为什么需要它：`pnpm dev` 若只起 vite，后端得另开终端跑 dev:serve——
// 两边端口、生命周期、日志各自为政，关的时候还容易漏一个。
//
// 关键决策（照 A08-framework-runtime 的规范，别即兴发挥）：
//   1. vite ready 之后再起 serve —— 反过来 vite 的 ready 行会被 serve 早期噪音吞掉
//   2. 直接 spawn node 二进制，不走 `npm run` —— Windows 上调 npm.cmd 时参数会被
//      cmd.exe 重排/截断（`npm.cmd dev:serve` 会被理解成 npm 自己的 --silent 子命令）
//   3. vite 必须 --host 127.0.0.1 —— Node 18+ 默认监听 [::1]，curl 127.0.0.1 会 ECONNREFUSED
//   4. 一个 ctrl-c 关两个：任意信号都转发 SIGTERM 给子进程再自己退
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, '');
const NODE = process.execPath;

const BACKEND_PORT = Number(process.env.NX_RSX_SC_PORT) || 7881;
const VITE_PORT = Number(process.env.NX_RSX_SC_VITE_PORT) || 7882;

const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(VITE_BIN)) {
  console.error(`未找到 vite：${VITE_BIN}\n先跑 pnpm install。`);
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function start(name, args, env) {
  const child = spawn(NODE, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    // Windows 上 node 可直接 spawn，不需要 shell —— 加了 shell 反而会重新引入参数重排
    shell: false,
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${name} 退出（code=${code}${signal ? ', signal=' + signal : ''}），一并关闭另一个。`);
    shutdown(code ?? 1);
  });
  children.push({ name, child });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

// 等端口就绪：轮询直到不再 ECONNREFUSED。
// 通用实现（等任意端口）而非只等 vite——后端也可能需要等。
async function waitForPort(port, { tries = 60, gapMs = 250 } = {}) {
  const net = await import('node:net');
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        resolve(false);
      });
      setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 400);
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

start('vite', [VITE_BIN, '--host', '127.0.0.1', '--strictPort', '--port', String(VITE_PORT)]);
const ready = await waitForPort(VITE_PORT);

if (!ready) {
  console.error('[dev] vite 没起来（--strictPort：端口被占会直接失败），仍然启动后端；请检查上面的报错。');
} else {
  console.log(
    `\n[dev] vite 就绪 http://127.0.0.1:${VITE_PORT}  →  后端 http://127.0.0.1:${BACKEND_PORT}\n`
  );
}

start('serve', [join(ROOT, 'bin', 'rsx-sc.mjs'), 'serve', '--no-open'], {
  NX_RSX_SC_PORT: String(BACKEND_PORT),
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(0));
}
process.stdin.on('close', () => shutdown(0));
