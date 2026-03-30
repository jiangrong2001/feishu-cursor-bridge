# Feishu → Cursor 桥接（线路 3）

## 架构说明（默认：长连接，无需公网域名）

与 [OpenClaw 飞书插件（openclaw-feishu）](https://www.npmjs.com/package/openclaw-feishu) 同类思路：**本机用 `appId` + `appSecret` 与飞书建立 WebSocket 长连接**，事件由飞书推送到这条出站连接上，**不需要**你提供公网 IP、域名或 ngrok。

```
手机飞书 ──发消息──► 飞书云 ──► WebSocket 长连接 ──► 本机桥接服务 (Node)
                                                    │
                                                    ├─ 写入 inbox/（日志）
                                                    ├─ 可选：全自动 → 调大模型 API → 再经飞书 API 发回第二条消息
                                                    └─ 半自动：用 Cursor 打开仓库，让 Agent 读 LATEST.md + lark-cli 回复
```

飞书官方说明：[使用长连接接收事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode)。

社区参考（长连接思路）：[openclaw-feishu](https://www.npmjs.com/package/openclaw-feishu)。

**关于「只用 Cursor、又要全自动」**（重要）

- **Cursor IDE 没有公开的无人值守 Agent API**，无法做到「飞书一来就由 Cursor 进程里那个 Chat 自动思考」而不经过任何其它运行时。
- **可行且推荐的组合**：用 **Cursor 开发与维护本仓库**；**运行时**由桥接进程在后台调用 **与你所选厂商一致的大模型 HTTP API**（OpenAI 兼容或 Anthropic），自动把回复发回飞书——**不必打开 Cursor 对话**，也**不需要 OpenClaw**。
- 若用户问题依赖 **本机执行命令**（如「查 CPU」），纯大模型只能文字说明步骤或拒绝编造结果；要自动跑本机命令属于 **高危能力**，本仓库默认不开启（避免飞书消息触发任意命令执行）。

桥接进程需 **长期运行**；机器需能 **访问公网**（连飞书 + 调模型 API）。

---

## 1. 飞书开放平台配置（长连接模式）

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → 创建**企业自建应用**。
2. 启用 **机器人** 能力；**版本管理** 中创建版本并发布，使应用在企业内可用。
3. **权限（示例，按实际需要勾选）**  
   - 接收用户发给机器人的单聊消息，或  
   - 群聊中 @ 机器人的消息 等（与 OpenClaw 文档中的 `im:message` / 群 @ 类权限一致即可）。
4. **事件订阅**（关键步骤）  
   - 添加事件：**接收消息** `im.message.receive_v1`（控制台若显示 v2.0 以界面为准）。  
   - **订阅方式** 请选择：**使用长连接接收事件**（不要填「请求地址 URL」的 Webhook 模式，除非你用下文「HTTP 备选」）。  
5. 在应用凭证页复制 **App ID**（`cli_xxx`）和 **App Secret**，写入本仓库 `.env`。

长连接模式下 **不需要** Encrypt Key / Verification Token（那是 Webhook 加密推送用的）。

---

## 2. 本机安装与启动

```bash
cd feishu-cursor-bridge
cp .env.example .env
# 编辑 .env：BRIDGE_MODE=ws，填写 LARK_APP_ID、LARK_APP_SECRET
# 若要全自动回飞书，再配 AUTO_REPLY 与大模型密钥（见下一节）

npm install
npm start
```

启动后应看到类似：`mode=ws 长连接已启动（本机主动连飞书，无需公网 URL）`。

---

## 2.1 全自动回复（推荐：飞书一发即回，无需开 Cursor）

在 `.env` 中增加（示例为 OpenAI 兼容接口；国内可用自建代理或兼容网关，改 `OPENAI_BASE_URL` 即可）：

```env
AUTO_REPLY_ENABLED=1
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# OPENAI_BASE_URL=https://api.openai.com/v1
```

或使用 **Anthropic**：

```env
AUTO_REPLY_ENABLED=1
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-haiku-20241022
```

可选：`AUTO_REPLY_SYSTEM_PROMPT`、`AUTO_REPLY_MAX_TOKENS`、`AUTO_REPLY_TEMPERATURE`。

开启全自动后，会 **跳过** `LARK_AUTO_ACK`（避免与「正在生成回复…」重复）。飞书侧会先后收到：**「正在生成回复…」** → **模型正文**（失败则发错误说明）。

**依赖**：与本机 `LARK_APP_ID` / `LARK_APP_SECRET` 相同，应用需具备 **机器人发消息** 权限（如 `im:message:send_as_bot`）。

健康检查（默认仍监听 `PORT`，仅提供 `/health`）：

```bash
curl -s http://127.0.0.1:8787/health
# 应输出 ok
```

若不需要 HTTP 探测，可在 `.env` 设置 `BRIDGE_HEALTH_DISABLED=1`。

---

## 3. 与 Cursor 配合

1. 用手机飞书给机器人发**单聊**，或在群里 **@机器人**（视权限而定）。  
2. 用 **Cursor 打开本仓库根目录**，加载 `.cursor/rules/feishu-bridge.mdc`；Agent 关注 `inbox/LATEST.md`。  
3. `CURSOR_OPEN_ON_MESSAGE=1`（macOS）可在新消息时尝试用 `open -a Cursor` 打开 `LATEST.md`。  
4. 在 Cursor 里处理队列，并用 `lark-cli` 按 `LATEST.json` 里的 `chat_id` 回复飞书。

### 可选：自动「已收到」

`.env` 中已有 `LARK_APP_ID` / `LARK_APP_SECRET` 时，设 `LARK_AUTO_ACK=1` 即可（需发消息权限）。

### 可选：仅允许指定用户

```
ALLOWED_SENDER_OPEN_IDS=ou_xxx,ou_yyy
```

---

## 4. 国际版 Lark

```
LARK_USE_LARK_INTERNATIONAL=1
```

---

## 5. 备选：HTTP Webhook（需要公网 HTTPS）

仅当你必须用 Webhook 时：

1. `.env` 设置 `BRIDGE_MODE=http`，并配置 `LARK_ENCRYPT_KEY`、`LARK_VERIFICATION_TOKEN`。  
2. 飞书事件订阅改为 **请求地址** 模式，使用 ngrok 等：`https://<公网>/webhook/feishu`。  
3. `npm start` 后按原 Webhook 流程验证 URL。

---

## 6. 安全建议

- 勿将 `.env` 提交到 Git。  
- `ALLOWED_SENDER_OPEN_IDS` 可减小陌生人刷队列。  
- 机器人勿拉入不可信大群。

---

## 故障排查

### 飞书只有「已收到」、没有后续结果？

- 若 **未开** `AUTO_REPLY_ENABLED=1`：须按半自动流程在 Cursor 里处理 `inbox` 并用 `lark-cli` 回复（见上文「与 Cursor 配合」）。
- 若 **已开** `AUTO_REPLY_ENABLED=1` 仍无第二条消息：检查 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`、网络能否访问模型 API、桥接日志里的 `[auto-reply]` 报错；并确认飞书应用有发消息权限。

自测发飞书（本机终端，`chat_id` 见 `inbox/LATEST.json`）：

```bash
lark-cli im +messages-send --as bot --chat-id "oc_你的chat_id" --text "测试" --dry-run
```

- **`EADDRINUSE` 端口 8787**：多为上次 `npm start` 未退出。可 `lsof -i :8787` 查看后结束进程，或改 `.env` 的 `PORT`；**长连接模式**下即使跳过 `/health`，收飞书消息仍正常。
- **长连接连不上 / 无日志**：检查本机网络、防火墙是否拦截出站 WSS；`appId`/`appSecret` 是否正确；应用是否已发布。  
- **收不到消息**：确认事件订阅为 **长连接** 且已勾选 `im.message.receive_v1`；机器人在会话内；群场景是否需 @。  
- **与 OpenClaw 同时跑同一应用**：飞书对同一应用多客户端会 **随机选一个** 收事件，避免重复挂载。  
- **Cursor 未弹出**：确认应用名为 `Cursor`；或手动打开 `inbox/LATEST.md`。
