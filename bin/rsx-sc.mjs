#!/usr/bin/env node
// rsx-sc 唯一入口。
//
// 设计约定：Web 面板上每个按钮，都对应这里的一条 CLI 命令——二者由同一份 action
// 声明派生（见 src/modules/*/index.js），不是靠人维护两份清单。
import { runCli } from '../src/runtime/cli.js';

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
