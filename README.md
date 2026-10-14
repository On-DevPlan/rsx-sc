# rsx-sc — 持续截屏 + 多模态 LLM 观察

> 本机工具：CLI 与 Web 面板同源。Web 页面按用户选定的区域**持续截屏**，
> 每帧送进 OpenAI 兼容的多模态 LLM，按用户自定义的提示词模板生成对话；
> 截图、LLM 回复、用户注解汇成一条「对话记录」流，可被 `npx rsx-sc serve`
> 起的本地 Web 面板实时查看。

## 用法

```bash
# 启动 Web 面板（默认 127.0.0.1:7881）
npx rsx-sc serve

# 查看二进制解析（v1 仅 Windows x64 与 Linux x64）
npx rsx-sc capture bin

# 起一个截屏会话（CLI 与 HTTP 同源）
npx rsx-sc capture start --region "0,0,800,600" --intervalMs 500

# 列出/停止会话
npx rsx-sc capture list --json
npx rsx-sc capture stop --sessionId <id>

# LLM 配置 + 提示词模板：默认走 ~/.rsx-sc/settings.json
npx rsx-sc settings get
npx rsx-sc settings set --apiBase "https://api.openai.com/v1" --model gpt-4o-mini --apiKey sk-xxx
npx rsx-sc settings test
```

二进制**随主包一起分发**（`binaries/<platform>-<arch>/`，`files` 白名单已包含），
装完即可用，没有平台子包、没有二次下载。

## 架构

```
                       ┌───────────────────────┐
   Web面板 (React+Vite) │ /api/capture/start    │ bin/rsx-sc.mjs (Node)
   http://127.0.0.1    │ /api/capture/stream/* │  + src/core
       ┌───────────────│ /api/capture/list     │
       │               │ /api/capture/stop     │
       │  EventSource  │ /api/settings         │
       │   (SSE)       │ /api/settings-test    │
       │               └─────────┬─────────────┘
       │                         │ spawn
       │                         ▼
       │                ┌───────────────────────┐
       └──── frames ───│ rsx-sc-rust (JSONL)     │
                        │   loop_capture node   │
                        └───────────────────────┘
```

### Rust 二进制 `rsx-sc-rust`

`rust/rsx-sc-rust/` 是一个**纯 stdio JSONL 服务**，没有 GUI / 网络依赖：

| 子命令         | 行为                                 |
| -------------- | ------------------------------------ |
| `capture`      | 单次 BitBlt 截屏（诊断用）           |
| `crop`         | 在 PNG 上裁一个矩形                  |
| `loop_capture` | 按固定间隔连续截屏一个区域，输出帧流 |

`loop_capture` 是新写的节点：`tokio::time::sleep` 提供稳定时基，
`spawn_blocking` 跑阻塞的 `screenshots::Screen::capture()`，
`mpsc::channel(2)` 抗背压，丢帧时通过 `{type:"status"}` 事件上报。
SIGTERM (Unix) / 进程终止 (Windows) 干净退出，并发一个 `{type:"loop_complete"}`
收尾事件。

`ai_qa/`（translate / ocr / qa）**没有**移植到 Rust——多模态 LLM 调用挪到
Node 层 (`src/core/llm-client.js`)，理由：

- 不同 LLM 提供商的切换不需要重新编译 Rust；
- 会话历史（消息累积）是 JS 里很容易表达的 mutable state；
- 让 Rust 保持单一职责、瘦二进制（~580 KB）。

### JS 框架层

- `src/runtime/registry.js`：所有 action 在此汇合。CLI 命令 + HTTP 路由 +
  help 文本全部由 action 声明派生。「Web 上每个操作都有等价 CLI 命令」
  是结构性保证。
- `src/runtime/server.js`：零依赖 `node:http`。`/api/capture/stream/*` 在
  `/api/*` 分支前单独拦截（SSE 是长连接 + 服务端推送，不适合 action
  dispatcher 的 request/response 模型）。
- `src/core/capture-session.js`：进程内的会话注册表，每个 session 一个
  EventEmitter。
- `src/core/rust-binary.js`：多级解析（环境变量 `RSX_SC_BINARY` → 额外目录 →
  随包 `binaries/<key>/` → 仓库内 `rust/rsx-sc-rust/target/release/`）。

## 平台支持

| 平台        | 状态     |
| ----------- | -------- |
| Windows x64 | ✅ |
| Linux x64   | ✅ |
| macOS       | ⏸ v1 不支持（与 tauri2 同源保留 stub，1.32 节） |
| Linux arm64 | ⏸ v1 不发布 |

## 构建与发布

### 本地构建

```bash
cd rust/rsx-sc-rust
cargo build --release
mkdir -p ../binaries/win32-x64      # 或当前平台对应的 key
cp target/release/rsx-sc-rust[.exe] ../binaries/win32-x64/
```

`binaries/` 在 npm 包的 `files` 中，随主包发布。

### CI（`.github/workflows/`）

- `ci.yml`：每次 push / PR 跑 lint + 单元测试 + 前端构建 + 冒烟。
- `build-rsx-sc-rust.yml`：矩阵编译（windows-latest + ubuntu-22.04），
  smoke test 走 Xvfb + JSONL 协议 round-trip；push 到 main 时把新二进制
  **提交回仓库** `binaries/<key>/`（单包内嵌的前提），tag 触发时另建
  GitHub Release（资产带平台前缀避免扁平命名冲突）。
- `npm-publish.yml`：push 到 main → 自动打 tag + `npm publish --provenance`。

> **版本纪律**：`package.json` 的 `version` 与 `rust/rsx-sc-rust/Cargo.toml`
> 手工保持一致。由于二进制要先进仓库、`npm publish` 才拿得到，**改 Rust 与
> bump 版本不要放在同一次 push**——先 push Rust 改动等 build 把二进制提交回来，
> 再 bump 版本触发发布。

## 局限（v1）

- macOS 不支持（Rust 端返回 "v1 仅支持 Windows / Linux" 错误 envelope）。
- 仅随包分发 x64（win32-x64 / linux-x64）。
- 仅 OpenAI 兼容的 chat/completions；流式响应未启用。
- LLM 调用是「单串行」（一次只发一个 in-flight 请求），并发截屏高 interval
  时 LLM 会成为瓶颈——这是有意的保守起点，后续可加并行 + per-call debounce。
- 对话记录**不持久化**：刷新页面就清空。配置等 LLM 设置落在
  `~/.rsx-sc/settings.json`。

## 协议 wire shape

```
# 配置帧（Node → Rust，写入 stdin 一次）
{"type":"frame","seq":0,"payload":{"region":{"x":0,"y":0,"width":400,"height":300},
                                 "intervalMs":500,"maxFrames":10}}

# 帧事件（Rust → Node / stdout）
{"type":"frame","seq":0,"payload":{"seq":0,"capturedAtMs":1700000000000,
                                   "width":400,"height":300,"pngB64":"..."}}

# 状态事件（Rust → Node / stdout，丢帧后约每 5 帧报一次）
{"type":"event","seq":1,"payload":{"type":"status","frames_emitted":6,
                                   "dropped_total":2,"monitor":{...},"region":{...}}}

# 终止事件
{"type":"event","seq":N,"payload":{"type":"loop_complete","frames":6,"dropped":2}}
```

## License

MIT