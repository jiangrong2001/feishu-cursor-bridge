# Feishu → Cursor 桥接（线路 3）

## 架构说明（默认：长连接，无需公网域名）

与 [OpenClaw 飞书插件（openclaw-feishu）](https://www.npmjs.com/package/openclaw-feishu) 同类思路：**本机用 `appId` + `appSecret` 与飞书建立 WebSocket 长连接**，事件由飞书推送到这条出站连接上，**不需要**你提供公网 IP、域名或 ngrok。

```
手机飞书 ──发消息──► 飞书云 ──► WebSocket 长连接 ──► 本机桥接服务 (Node)
                                                    │
                                                    ├─ 写入 inbox/LATEST.md + LATEST.json
                                                    └─ 可选：通知 + 打开 Cursor

你在 Cursor 里让 Agent 读 LATEST.md、执行任务，并用 lark-cli 把结果发回飞书
```

飞书官方说明：[使用长连接接收事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode)。

字节内网文档（若可访问）可作对照：[OpenClaw 飞书对接说明](https://bytedance.larkoffice.com/docx/MFK7dDFLFoVlOGxWCv5cTXKmnMh)。

**限制（诚实说明）**

- Cursor 没有公开的「远程自动跑 Agent」API；本方案仍是 **把命令落到本地文件**，由你在电脑上打开 Cursor 后处理（可配合 `CURSOR_OPEN_ON_MESSAGE=1`）。
- 桥接进程需 **长期运行**；机器需能 **访问公网**（用于连飞书 WSS，与「对外提供公网入口」不是一回事）。

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

npm install
npm start
```

启动后应看到类似：`mode=ws 长连接已启动（本机主动连飞书，无需公网 URL）`。

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

- **长连接连不上 / 无日志**：检查本机网络、防火墙是否拦截出站 WSS；`appId`/`appSecret` 是否正确；应用是否已发布。  
- **收不到消息**：确认事件订阅为 **长连接** 且已勾选 `im.message.receive_v1`；机器人在会话内；群场景是否需 @。  
- **与 OpenClaw 同时跑同一应用**：飞书对同一应用多客户端会 **随机选一个** 收事件，避免重复挂载。  
- **Cursor 未弹出**：确认应用名为 `Cursor`；或手动打开 `inbox/LATEST.md`。
