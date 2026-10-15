# Changelog

## 0.3.1 — 2026-10-15

### 修复

- **面板「截屏」页直接崩掉**（`CliHints is not defined`）。0.3.0 里把
  `BinCard` 等展示组件拆到 `parts.jsx` 时，漏了把 `CliHints` 一起 import
  过去——JSX 里用了但没引入，构建期静默通过，只有点开页面才炸。
- **所有 `CliHints` 都没渲染**。该组件的契约是 `module` 属性（命令列表从
  bootstrap 的命令表派生），而五处调用（capture ×3、settings、home）
  传的都是 `command` / `note`——属性被忽略 → 命令列表为空 → 静默返回 null。
  这处是脚手架自带的既有问题，这次一并改正为 `module="<域>"`。
- **深链接被重定向回首页**。打开 `#/capture` 会落到 `#/home`：挂载时
  「回写 hash」的 effect 用 localStorage 里的旧视图覆盖了深链接，随后的
  `hashchange` 又把 state 改回去。现在该 effect 跳过首次渲染。
  这处同样是既有问题。

### 加固

- eslint 对 `.jsx` 打开 `no-undef` + `react/jsx-no-undef`。
  基础配置里关掉 `no-undef` 的理由是「浏览器/Node 全局混用」，但 `.jsx`
  只会被 vite 打进浏览器包，不存在该问题——可以安全打开。
  **两条都要**：实测 `no-undef` 不检查 JSX 元素名（`<Foo />` 里的 Foo
  未定义时它保持沉默），只有 `react/jsx-no-undef` 会报；反过来它又管不到
  普通表达式里的未定义引用。已做反向测试确认破坏后会变红。

## 0.3.0 — 2026-10-15

### 新增

- **原生全屏框选蒙版**（`rsx-sc-rust select`，`rust/rsx-sc-rust/src/overlay.rs`）。
  从 tauri2 的 `capture_window.rs` 移植：winit + softbuffer 直接绘制原生窗口，
  截光标所在显示器整屏 → 压暗 → 拖拽画框（框内还原原始像素、蓝色边框、
  四角绿色 L 形标记）→ 输出选中矩形 JSON。Esc / 右键取消，数位笔走
  `WM_POINTER` 同样可用。
  - 与 tauri2 的差异：删掉常驻后台线程 + `EventLoopProxy` 单例——新进程
    每次只跑一个 `select`，事件循环直接归主线程。
  - 先画好首帧再显示窗口，无白屏闪烁。
- CLI / API：`rsx-sc capture select`（`POST /api/capture/select`）。
- Web 面板「截屏」页新增「框选区域」按钮：调 `/api/capture/select`
  （长超时，等用户拖完），把结果写回 region 输入框并显示显示器下标。
- `capture.start` 新增 `--monitor <下标>`：把循环锁定到框选时那块显示器，
  避免框选后鼠标挪屏导致区域裁错屏。`loop_capture` 输入增加 `monitor` 字段。
- `MonitorInfo` 相关的按索引解析：`find_cursor_monitor_indexed` /
  `monitor_from_index`。

### 变更

- Rust 依赖新增 `winit 0.30` + `softbuffer 0.4`（与 tauri2 同版本）。
  二进制从 ~578 KB 增至 ~773 KB。
- `src/modules/capture/view.jsx` 拆出展示组件到 `parts.jsx`
  （eslint `max-lines` 300 行上限）。

### 已知限制

- `select` 需要图形界面；无显示的服务器里请用 `--region` 显式给坐标。

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