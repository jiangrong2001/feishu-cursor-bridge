---
name: feishu-cursor-bridge
description: >-
  Installs and runs feishu-cursor-bridge: Feishu WebSocket long-connection to a
  local Node bridge that spawns Cursor Agent CLI and sends replies via lark-cli.
  Use when the user wants Feishu/Lark messaging with Cursor on their machine,
  remote commands from Feishu, or to set up this repository from scratch.
---

# Feishu ↔ Cursor 桥接（智能体速查）

## 先读主文档

**完整安装、飞书后台配置、截图示例、故障排查以仓库根目录为准：**

- 中文：**[README.zh.md](../../../README.zh.md)**（推荐）
- English: **[README.md](../../../README.md)**

本 SKILL 只提供**可执行检查清单**，避免遗漏；细节、链接、权限名称以 README 为准。

---

## 智能体帮用户落地时的步骤

### 1. 获取代码与依赖

```bash
cd /path/to/parent
git clone <仓库 URL> feishu-cursor-bridge   # 若用户已有仓库则跳过 clone
cd feishu-cursor-bridge
cp .env.example .env
npm install
```

### 2. 用户侧必须已具备（无法由本仓库代替）

| 项 | 说明 |
|----|------|
| 飞书自建应用 | 长连接 + `im.message.receive_v1`；App ID / Secret |
| Cursor CLI | `curl https://cursor.com/install \| bash`，`agent login` |
| lark-cli | 与机器人同一应用，能 `lark-cli im +messages-send --as bot ...` |

若缺任一项，按 README **§一、飞书** 与 **§二、本机 CLI** 指导用户完成后再启动桥接。

### 3. `.env` 最小必填

```env
LARK_APP_ID=cli_xxxx
LARK_APP_SECRET=xxxx
CURSOR_AGENT_AUTO=1
CURSOR_AGENT_SANDBOX=disabled
```

可选：`CURSOR_AGENT_WORKSPACE`（绝对路径，默认可为仓库根）、`ALLOWED_SENDER_OPEN_IDS`、`CURSOR_AGENT_STREAM_TO_FEISHU`、`CURSOR_AGENT_TIMEOUT_MS`、`CURSOR_AGENT_MAX_QUEUE` 等见 [reference.md](reference.md)。

**生产或共享本机时**：必读 README **§七（安全加固与限制项）**——`REQUIRE_SENDER_ALLOWLIST`、`VALIDATE_SENDER_OPEN_ID_FORMAT`、队列/超时启动校验、`BRIDGE_HEALTH_HOST`、`BRIDGE_STRICT_CONFIG` 等。

**勿**把真实 Secret 写进对话或提交进 Git；只写入用户本机 `.env`。

### 4. 启动与验收

```bash
npm start
```

终端应出现：`mode=ws 长连接已启动`、`Cursor Agent CLI 自动模式已开启`（或同类日志）。  
让用户在飞书给机器人发一句纯文字；终端应有 `[bridge] queued message`、`[cursor-agent] job start`。

失败时按 README **§八、故障排查**；可先看 `[cursor-agent] failed` 与 `agent login` / `lark-cli`。**答复路径**（lark-cli 成功判定 vs 桥接 API 补发、发图/附件约定）见 README **§三「答复如何回到飞书」**。复盘 Agent 可设 **`BRIDGE_DEBUG_LOG=1`**，见 **§六点五**；`JOB_SUMMARY` 含 `larkCliFeishuOk` / `feishuReplyDelivered`。

---

## 智能体不要做的事

- 不要在日志或回复中复述用户的 **App Secret**、token。  
- 不要假设飞书已配置好：权限与事件订阅必须由用户在开放平台完成。  
- 不要同时运行**两个**进程用同一飞书应用抢长连接（README 已说明）。

---

## 更多

- 环境变量表：[reference.md](reference.md)  
- 开发本仓库时的 IDE 规则：`.cursor/rules/feishu-bridge.mdc`（与最终用户跑 `npm start` 无冲突）
