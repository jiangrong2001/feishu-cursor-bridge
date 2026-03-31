# Feishu → Cursor 桥接（线路 3）

## 架构说明（默认：长连接，无需公网域名）

与 [OpenClaw 飞书插件（openclaw-feishu）](https://www.npmjs.com/package/openclaw-feishu) 同类思路：**本机用 `appId` + `appSecret` 与飞书建立 WebSocket 长连接**，事件由飞书推送到这条出站连接上，**不需要**你提供公网 IP、域名或 ngrok。

```
手机飞书 ──发消息──► 飞书云 ──► WebSocket ──► 桥接 (Node)
                                              │
                                              ├─ 写 inbox/（日志）
                                              ├─ 【推荐】spawn Cursor Agent CLI（headless）
                                              │      ├─ stream-json 解析 → 摘要推回飞书（可见工具/进度）
                                              │      └─ Agent 内可跑终端、改代码；收尾用 lark-cli 发最终总结
                                              ├─ 【备选】直连 OpenAI/Anthropic API（无 Cursor Agent）
                                              └─ 【手动】只写 inbox，你在 Cursor IDE 里对话 + lark-cli
```

飞书长连接文档：[使用长连接接收事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode)。

**Cursor Agent CLI（官方）**：[Headless / print 模式](https://cursor.com/docs/cli/headless)、[参数说明](https://cursor.com/docs/cli/reference/parameters)（`agent -p --force --sandbox disabled --output-format stream-json`）。

**说明**：IDE 里的聊天窗不会自动弹出，但 **与 IDE 同源能力的 Agent** 由本机 `agent` 子进程执行，并可把 **工具调用与生成过程** 摘要到飞书；适合你要的「远程下命令 + 看到智能体怎么干」。

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
# 编辑 .env：BRIDGE_MODE=ws，LARK_APP_ID / LARK_APP_SECRET
# 推荐：CURSOR_AGENT_AUTO=1（见 2.1）

npm install
npm start
```

启动后应看到类似：`mode=ws 长连接已启动（本机主动连飞书，无需公网 URL）`。

---

## 2.1 飞书 ↔ 真 Cursor Agent（全自动 + 过程可见）

1. 安装 CLI：`curl https://cursor.com/install -fsS | bash`，确保 `agent -h` 可用。  
2. `agent login` 或设置 **`CURSOR_API_KEY`**。  
3. 配置 **`lark-cli`**（与机器人同应用），便于 Agent 收尾执行 `lark-cli im +messages-send`。  
4. `.env`（**勿**与 `AUTO_REPLY_ENABLED` 同开）：

```env
CURSOR_AGENT_AUTO=1
CURSOR_AGENT_SANDBOX=disabled
# CURSOR_AGENT_WORKSPACE=/你的/工作区
# 需要过程可见时再开：CURSOR_AGENT_STREAM_TO_FEISHU=1
# CURSOR_AGENT_FEISHU_MIN_INTERVAL_MS=5000
```

5. `npm start`，飞书发消息 → **默认「安静模式」**：桥接不把工具/流式正文刷到飞书，由 Agent 执行 **lark-cli** 发简洁答复。若流式输出里**未识别到** `lark-cli` 调用，桥接会用 **API 补发**模型正文，减少「只有自动回复、没有答案」的概率（`CURSOR_AGENT_QUIET_BRIDGE_FALLBACK=0` 可关）。若要看 🔧📝 过程，设 `CURSOR_AGENT_STREAM_TO_FEISHU=1`。连续多条消息**顺序执行**；可选 `CURSOR_AGENT_TIMEOUT_MS` 防止单条卡死占满队列。

说明：若飞书里出现「已收到，正在本机 Cursor 中处理，请稍候」等句，**本仓库不会发该文案**（多为飞书后台自动回复或其它集成）。若你**同时**发现此后没有 Cursor 真回复：此前版本曾在「空包先占位 message_id」时把后续正文包误判重复；当前已改为**仅在有非空正文时才锁 message_id**，避免该问题。仍建议在飞书里关掉与桥接重复的自动回复，减少干扰。

官方文档：[Headless CLI](https://cursor.com/docs/cli/headless)、[Parameters](https://cursor.com/docs/cli/reference/parameters)。

---

## 2.2 备选：直连大模型（非 Cursor Agent）

与 `CURSOR_AGENT_AUTO` **二选一**。

```env
AUTO_REPLY_ENABLED=1
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

开启后会发「正在生成回复…」再发模型正文。适合只要简单问答、不要本机工具链的场景。

---

## 健康检查

```bash
curl -s http://127.0.0.1:8787/health
```

可设 `BRIDGE_HEALTH_DISABLED=1` 关闭 HTTP 探测。

---

## 3. 与 Cursor IDE 配合（半自动 / 开发）

1. 用手机飞书给机器人发**单聊**，或在群里 **@机器人**（视权限而定）。  
2. 用 **Cursor 打开本仓库根目录**，加载 `.cursor/rules/feishu-bridge.mdc`；Agent 关注 `inbox/LATEST.md`。  
3. `CURSOR_OPEN_ON_MESSAGE=1`（macOS）可在新消息时尝试用 `open -a Cursor` 打开 `LATEST.md`。  
4. 在 Cursor 里处理队列，并用 `lark-cli` 按 `LATEST.json` 里的 `chat_id` 回复飞书。

### 可选：自动「已收到」

`.env` 中已有 `LARK_APP_ID` / `LARK_APP_SECRET` 时，设 `LARK_AUTO_ACK=1` 即可（需发消息权限）。**仅当未开** `CURSOR_AGENT_AUTO` / `AUTO_REPLY_ENABLED` 时才会发这条「半自动」说明；全自动时请关 `LARK_AUTO_ACK` 或保持开启均可（全自动下不会发该条）。启动后请看控制台一行 **`[bridge] 自动化状态:`**，确认是否为 `Cursor Agent CLI=开`。

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
