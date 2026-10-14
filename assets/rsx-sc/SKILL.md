---
name: rsx-sc
description: 本机工具：CLI 与 Web 面板同源。当用户要求操作本项目（启动服务/面板、查看路由与健康状态、安装本 skill、了解可用命令）时使用。触发词：rsx-sc、启动面板、skill install、查看路由、健康检查。
---
# rsx-sc skill

本项目是「CLI 与 Web 面板同源」的本机工具：一条 action 声明同时派生出
CLI 命令与 HTTP 路由，Web 上能做的，CLI 都能做。

- 项目根（安装时注入，固定值）：`{{PROJECT_ROOT}}`

## 常用命令

在项目根目录执行：

```bash
# 启动 Web 面板（默认端口 7881）
node bin/rsx-sc.mjs serve            # 开发期：pnpm dev

# 查看全部命令与 HTTP 路由对照
node bin/rsx-sc.mjs routes

# 健康检查
node bin/rsx-sc.mjs health

# skill：列出 / 导出 / 安装
node bin/rsx-sc.mjs skill list
node bin/rsx-sc.mjs skill get rsx-sc
node bin/rsx-sc.mjs skill install rsx-sc
```

加 `--json` 可获取机器可读输出（错误时同样输出 JSON）。

## 典型会话

1. 用户要求启动面板 → `serve`，确认端口可访问
2. 用户问「有哪些接口/命令」→ `routes`
3. 用户要把本 skill 装给 agent → `skill install rsx-sc`
   （安装钩子会校验当前目录是本项目根，并注入项目根路径）

## 约束

- 操作本项目一律在项目根目录内调用本地 CLI
- 本 skill 只能在 rsx-sc 项目根目录安装：非该目录会被安装钩子拒绝
- 命令、参数与 flag 的权威清单看 `routes --json`，不要凭记忆杜撰
