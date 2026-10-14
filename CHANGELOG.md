# Changelog

## 0.2.0 — 2026-10-14

### 新增

- 抽出 Rust 截屏引擎 `rsx-sc-rust`（crate 在 `rust/rsx-sc-rust/`）。
  - `capture` / `crop` 节点从 tauri2 移植。
  - 新增 `loop_capture` 节点：按区域 + 间隔持续截屏，输出 JSONL 帧流，
    内部用 `tokio::time::sleep` + `spawn_blocking` + `mpsc(2)` 抗背压。
  - macOS 留 stub（v1 不支持）。
  - 体积优化：opt-level=z / lto / strip，~580 KB。
- JS 层接入：
  - `src/core/rust-binary.js`：多级解析（env → 额外目录 → 随包 → cargo 产物）。
  - `src/core/capture-client.js`：spawn + JSONL 行循环。
  - `src/core/capture-session.js`：进程内会话注册表 + EventEmitter。
  - `src/core/capture-stream.js`：SSE handler 给 `/api/capture/stream/<id>`。
- 新模块：
  - `capture`：`capture.bin / capture.start / capture.stop / capture.list`。
  - `settings`：`settings.get / settings.set / settings.test`。
- Web 面板新增「设置」与「截屏」两个 tab。
- LLM 客户端：`src/core/llm-client.js`（OpenAI 兼容 chat/completions，多模态）。
- GH Actions：
  - `build-rsx-sc-rust.yml`：矩阵编译 + Xvfb 协议 round-trip 测试；push 到 main
    时把二进制提交回 `binaries/<key>/`，tag 触发时另建 Release。
  - `npm-publish.yml`：自动打 tag + `npm publish --provenance`。
- `binaries/.gitkeep`：保留目录骨架，CI 把真实二进制提交到该目录。
- 单元测试 `tests/unit/registry.test.mjs`：校验 MODULES ↔ VIEWS 对齐、
  action 必有 `cli+http`、action 必有 `run`。

### 变更

- `src/runtime/server.js`：`/api/capture/stream/*` 在 `/api/*` 分支前单独
  拦截（SSE 不能复用 action dispatcher）。
- `src/runtime/registry.js`：新增 `capture` 与 `settings` 模块。
- `src/web/frontend/registry.js`：新增对应 view。
- `src/index.js`：暴露新模块的 service 入口。
- `package.json`：bump 到 0.2.0；`files` 含 `binaries`（单包内嵌，二进制随主包发）。
- `.gitignore`：忽略 `rust/rsx-sc-rust/target/`、`dist/`、`binaries/*`
  （保留 `.gitkeep`）。

### 移除

- 移除了「依赖 Tauri / winit / softbuffer」的所有设想。本项目不再走
  desktop app 分发。

### 已知限制

- macOS 暂不支持。
- 仅 x64；arm64 / darwin 不在 CI matrix。
- LLM 调用串行（一次 in-flight），高 interval 时 LLM 响应慢会成为瓶颈。
- 对话记录不持久化（刷新页面即空）。